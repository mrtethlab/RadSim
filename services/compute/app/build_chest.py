"""Build a RadSim voxel phantom from a real CT + TotalSegmentator segmentation.

Pipeline:
  1. Resample the CT (linear) and the multilabel segmentation (nearest) to an
     isotropic voxel size (default 1.0 mm) on a shared grid.
  2. Assign a body-material id to every voxel:
       - outside the body  -> Air
       - inside, unlabelled -> by HU threshold (lung / fat / muscle / soft / bone)
       - segmented organ    -> that organ's material
       - bone labels        -> Cortical vs Trabecular by local HU
       - a thin outer shell  -> Skin
     Material ids match apps/web/src/core/materials.js `BodyMaterials.LIST`.
  3. Crop to the body bounding box, write:
       <out>/chest.mat.bin    raw uint8 material ids, x-fastest (i = x + nx*(y+ny*z))
       <out>/chest.model.json header (dims, spacing, material legend, mesh ref)
       <out>/chest.glb        coloured display surfaces (skin/bone/lungs/heart/…)

Run (from services/compute):
  ./.venv/Scripts/python.exe -m app.build_chest \
      --ct data/chest/ct.nii.gz --seg data/chest/seg.nii \
      --out ../../apps/web/public/models/chest --spacing 1.0
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import SimpleITK as sitk
from scipy import ndimage as ndi

# ---- material ids (MUST match BodyMaterials.LIST order in materials.js) ----
AIR, LUNG, FAT, WATER, CSF, SIMPLE_FLUID, BILE, MUSCLE, BLOOD, CLOT, SOFT, \
    LIVER, SPLEEN, KIDNEY, PANCREAS, HEART, CARTILAGE, TRABECULAR, CORTICAL, \
    ENAMEL, IODINE, CALCIF, STONE, SKIN, ALUMINUM, TITANIUM, STEEL, LEAD = range(28)

LEGEND = [
    (AIR, "Air", -1000, 0x000000), (LUNG, "Lung", -700, 0x3a4a63),
    (FAT, "Fat", -90, 0xf2e2b0), (WATER, "Water", 0, 0x2f6fb0),
    (CSF, "Cerebrospinal fluid", 12, 0x4a90c0), (SIMPLE_FLUID, "Simple fluid", 10, 0x3f80b8),
    (BILE, "Bile", 20, 0x6b8e23), (MUSCLE, "Muscle", 45, 0x9e4b4b),
    (BLOOD, "Blood", 45, 0xb23a3a), (CLOT, "Clotted blood", 75, 0x7a2222),
    (SOFT, "Soft tissue", 40, 0xc07a6a), (LIVER, "Liver", 60, 0x8a4b32),
    (SPLEEN, "Spleen", 50, 0x6d3b52), (KIDNEY, "Kidney", 40, 0x9c5a3c),
    (PANCREAS, "Pancreas", 40, 0xc9a15a), (HEART, "Heart / myocardium", 45, 0xa83232),
    (CARTILAGE, "Cartilage", 110, 0xcfd8e0), (TRABECULAR, "Trabecular bone", 300, 0xe8dfc0),
    (CORTICAL, "Cortical bone", 1200, 0xfaf3dc), (ENAMEL, "Tooth enamel", 2500, 0xffffff),
    (IODINE, "Iodine contrast", 350, 0xffd24d), (CALCIF, "Calcification", 600, 0xf0ead2),
    (STONE, "Kidney stone", 800, 0xd8cba0), (SKIN, "Skin", 30, 0xd8a07a),
    (ALUMINUM, "Aluminum", None, 0x9fb4c0), (TITANIUM, "Titanium", None, 0xb8c2cc),
    (STEEL, "Stainless steel", None, 0xd0d4d8), (LEAD, "Lead", None, 0x6a6f77),
]


def ts_class_map() -> dict[int, str]:
    """label id -> TotalSegmentator structure name (the 'total' task)."""
    from totalsegmentator.map_to_binary import class_map
    return class_map["total"]


BONE_PREFIX = ("vertebrae", "rib", "sternum", "scapula", "clavicula", "humerus",
               "femur", "hip", "sacrum", "skull", "costal")  # 'costal_cartilages' handled below


def name_to_material(name: str) -> int:
    """Map a TotalSegmentator structure name to a body-material id.
    Bone structures return -1 (caller splits cortical/trabecular by HU)."""
    n = name.lower()
    if n == "costal_cartilages":
        return CARTILAGE
    if any(n.startswith(p) for p in BONE_PREFIX):
        return -1  # bone: split by HU
    if n.startswith("lung"):
        return LUNG
    if n in ("liver",):
        return LIVER
    if n in ("spleen",):
        return SPLEEN
    if n.startswith("kidney"):
        return KIDNEY
    if n in ("pancreas",):
        return PANCREAS
    if n.startswith("heart"):
        return HEART
    if n == "trachea":
        return AIR  # airway lumen
    if n in ("gallbladder",):
        return BILE
    if n in ("urinary_bladder",):
        return SIMPLE_FLUID
    if n.startswith("autochthon") or n.startswith("iliopsoas") or n.startswith("gluteus"):
        return MUSCLE
    # great vessels + venous/arterial structures -> blood
    if any(k in n for k in ("aorta", "vena_cava", "pulmonary_vein", "pulmonary_artery",
                            "brachiocephalic", "subclavian", "carotid", "iliac", "portal",
                            "atrial_appendage")):
        return BLOOD
    if n in ("spinal_cord", "esophagus", "stomach", "duodenum", "small_bowel", "colon",
             "adrenal_gland_left", "adrenal_gland_right", "thyroid_gland", "prostate",
             "brain"):
        return SOFT
    return SOFT  # default for any other soft-tissue organ


def resample_iso(img: sitk.Image, spacing: float, is_label: bool) -> sitk.Image:
    old_sp, old_sz = img.GetSpacing(), img.GetSize()
    new_sp = (spacing, spacing, spacing)
    new_sz = [int(round(old_sz[i] * old_sp[i] / spacing)) for i in range(3)]
    rs = sitk.ResampleImageFilter()
    rs.SetOutputSpacing(new_sp)
    rs.SetSize(new_sz)
    rs.SetOutputOrigin(img.GetOrigin())
    rs.SetOutputDirection(img.GetDirection())
    rs.SetInterpolator(sitk.sitkNearestNeighbor if is_label else sitk.sitkLinear)
    rs.SetDefaultPixelValue(0 if is_label else -1024)
    return rs.Execute(img)


def build(ct_path: str, seg_path: str, out_dir: str, spacing: float, mesh: bool):
    os.makedirs(out_dir, exist_ok=True)
    print(f"[1/5] loading + resampling to {spacing} mm iso …")
    ct = resample_iso(sitk.ReadImage(ct_path), spacing, is_label=False)
    seg = sitk.ReadImage(seg_path)
    # put segmentation on the CT grid
    seg = sitk.Resample(seg, ct, sitk.Transform(), sitk.sitkNearestNeighbor, 0, seg.GetPixelID())
    hu = sitk.GetArrayFromImage(ct).astype(np.int16)      # (z, y, x)
    lab = sitk.GetArrayFromImage(seg).astype(np.int32)
    print(f"      grid {hu.shape[::-1]}  ({hu.size/1e6:.1f} M voxels)")

    print("[2/5] body mask + HU-based background materials …")
    body = hu > -320
    body = ndi.binary_closing(body, iterations=2)
    body = ndi.binary_fill_holes(body)
    lbl, n = ndi.label(body)
    if n > 1:
        sizes = ndi.sum(np.ones_like(lbl), lbl, index=range(1, n + 1))
        body = lbl == (int(np.argmax(sizes)) + 1)
    body = ndi.binary_fill_holes(body)  # includes lungs

    mat = np.full(hu.shape, AIR, dtype=np.uint8)
    inside = body
    m = np.full(hu.shape, SOFT, dtype=np.uint8)
    m[hu < -190] = LUNG
    m[(hu >= -190) & (hu < -30)] = FAT
    m[(hu >= -30) & (hu < 120)] = MUSCLE
    m[(hu >= 120) & (hu < 300)] = TRABECULAR
    m[hu >= 300] = CORTICAL
    mat[inside] = m[inside]

    # skin: outer shell of the body
    shell = inside & ~ndi.binary_erosion(inside, iterations=max(1, int(round(1.5 / spacing))))
    mat[shell] = SKIN

    print("[3/5] mapping segmented organs …")
    cmap = ts_class_map()
    bone_ids, mat_of = [], {}
    for lid, nm in cmap.items():
        mm = name_to_material(nm)
        if mm == -1:
            bone_ids.append(lid)
        else:
            mat_of[lid] = mm
    for lid, mm in mat_of.items():
        mat[lab == lid] = mm
    if bone_ids:
        bone_mask = np.isin(lab, bone_ids)
        mat[bone_mask & (hu >= 350)] = CORTICAL
        mat[bone_mask & (hu < 350)] = TRABECULAR

    print("[4/5] cropping to body + writing volume …")
    zs, ys, xs = np.where(body)
    pad = 4
    z0, z1 = max(0, zs.min() - pad), min(hu.shape[0], zs.max() + pad + 1)
    y0, y1 = max(0, ys.min() - pad), min(hu.shape[1], ys.max() + pad + 1)
    x0, x1 = max(0, xs.min() - pad), min(hu.shape[2], xs.max() + pad + 1)
    mat = np.ascontiguousarray(mat[z0:z1, y0:y1, x0:x1])
    hu_c = hu[z0:z1, y0:y1, x0:x1]
    nz, ny, nx = mat.shape
    mat.tofile(os.path.join(out_dir, "chest.mat.bin"))  # x-fastest (C-order of z,y,x)

    present = sorted(int(v) for v in np.unique(mat))
    legend = [dict(id=i, name=nm, hu=hu_, color=f"#{c:06x}") for (i, nm, hu_, c) in LEGEND]
    header = dict(
        name="Human chest",
        source="3D Slicer CTChest sample · segmented with TotalSegmentator",
        dims=[nx, ny, nz], spacing=[spacing, spacing, spacing],
        order="x-fastest: i = x + nx*(y + ny*z)",
        volume="chest.mat.bin", dtype="uint8", mesh="chest.glb" if mesh else None,
        materials=legend, materialsPresent=present,
        huReference=[int(hu_c.min()), int(hu_c.max())],
    )
    with open(os.path.join(out_dir, "chest.model.json"), "w") as f:
        json.dump(header, f, indent=2)
    print(f"      {nx}x{ny}x{nz} = {mat.size/1e6:.1f} MB uint8; materials present: {present}")

    if mesh:
        print("[5/5] building display mesh (chest.glb) …")
        _build_mesh(mat, spacing, os.path.join(out_dir, "chest.glb"))
    else:
        print("[5/5] mesh skipped")
    print("done ->", out_dir)


def _build_mesh(mat: np.ndarray, spacing: float, path: str):
    import trimesh
    from skimage import measure

    nz, ny, nx = mat.shape
    centre = np.array([nx, ny, nz]) * spacing / 2.0
    scene = trimesh.Scene()

    # (mask, rgba, marching-cubes step) — coarse steps keep the mesh light
    groups = [
        (np.isin(mat, [SKIN, FAT, MUSCLE, SOFT]),                (0xd8, 0xa0, 0x7a, 70),  3),
        (np.isin(mat, [CORTICAL, TRABECULAR, CARTILAGE]),        (0xf5, 0xef, 0xd8, 255), 2),
        (mat == LUNG,                                            (0x6a, 0x8f, 0xbf, 120), 3),
        (mat == HEART,                                           (0xc0, 0x3a, 0x3a, 230), 2),
        (np.isin(mat, [BLOOD, IODINE]),                          (0xd0, 0x40, 0x40, 240), 2),
        (mat == LIVER,                                           (0x8a, 0x4b, 0x32, 230), 2),
    ]
    for mask, rgba, step in groups:
        if mask.sum() < 200:
            continue
        vol = ndi.binary_closing(mask, iterations=1).astype(np.float32)
        try:
            verts, faces, _, _ = measure.marching_cubes(vol, level=0.5, step_size=step)
        except (RuntimeError, ValueError):
            continue
        # verts are (z,y,x) index -> (x,y,z) mm, centred
        v = np.column_stack([verts[:, 2], verts[:, 1], verts[:, 0]]) * spacing - centre
        mesh = trimesh.Trimesh(vertices=v, faces=faces, process=False)
        mesh.visual.vertex_colors = np.tile(np.array(rgba, np.uint8), (len(v), 1))
        scene.add_geometry(mesh)
    scene.export(path)
    print(f"      wrote {path}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--ct", required=True)
    ap.add_argument("--seg", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--spacing", type=float, default=1.0)
    ap.add_argument("--no-mesh", action="store_true")
    a = ap.parse_args()
    build(a.ct, a.seg, a.out, a.spacing, mesh=not a.no_mesh)
