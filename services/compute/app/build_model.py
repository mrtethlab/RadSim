"""Build a RadSim voxel phantom from a real CT + TotalSegmentator segmentation.

Generalised from build_chest.py: one whole-body CT + multilabel segmentation can be
turned into a full-body model OR cropped to a body region (head/neck, chest, CAP,
upper/lower extremity) — the crop is expressed in physical mm along the cranio-caudal
(z) axis, optionally anchored to a segmented landmark so it tracks the patient.

Pipeline (per model):
  1. Resample the CT (linear) + multilabel seg (nearest) to isotropic `spacing` mm.
  2. Assign a body-material id to every voxel (Air / HU-threshold background /
     segmented organ / bone split cortical-trabecular by HU / thin Skin shell).
     Ids match apps/web/src/core/materials.js BodyMaterials.LIST.
  3. Optionally crop to a cranio-caudal region, then to the body bounding box.
  4. Write <out>/<name>.mat.bin (uint8, x-fastest), <name>.model.json, <name>.glb.

CLI:
  ./.venv/Scripts/python.exe -m app.build_model \
      --ct data/x/ct.nii.gz --seg data/x/seg.nii \
      --out ../../apps/web/public/models/headneck --name headneck \
      --title "Head & neck" --region headneck --spacing 1.0
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

BONE_PREFIX = ("vertebrae", "rib", "sternum", "scapula", "clavicula", "humerus",
               "femur", "hip", "sacrum", "skull", "costal", "radius", "ulna",
               "carpal", "metacarpal", "phalanges", "tibia", "fibula", "patella",
               "tarsal", "metatarsal", "calcaneus", "talus")


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
    if n in ("trachea",) or "airway" in n:
        return AIR  # airway lumen
    if n in ("gallbladder",):
        return BILE
    if n in ("urinary_bladder",):
        return SIMPLE_FLUID
    if (n.startswith("autochthon") or n.startswith("iliopsoas") or n.startswith("gluteus")
            or "muscle" in n or n.startswith("sartorius") or n.startswith("quadriceps")):
        return MUSCLE
    if n == "brain":
        return SOFT
    # great vessels + venous/arterial structures -> blood
    if any(k in n for k in ("aorta", "vena_cava", "pulmonary_vein", "pulmonary_artery",
                            "brachiocephalic", "subclavian", "carotid", "iliac", "portal",
                            "atrial_appendage", "artery", "vein")):
        return BLOOD
    return SOFT  # default for any other soft-tissue organ


def ts_class_map() -> dict[int, str]:
    from totalsegmentator.map_to_binary import class_map
    return class_map["total"]


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


# ---- region crops: cranio-caudal (z) window in mm, optionally landmark-anchored.
# The z axis in the resampled array is index 0 (SimpleITK gives (z,y,x)); +z is
# toward the patient SUPERIOR after we orient the CT (see build). A region is
# (anchor_structure_substrings, above_mm, below_mm): the window spans from
# above_mm superior to the anchor's top down to below_mm inferior to its bottom.
# anchor None + fractions falls back to a fraction of the whole scan height.
REGIONS = {
    "headneck":  dict(anchor=("skull", "vertebrae_c"), above=40, below=20, note="skull → lower cervical"),
    "chestabdopelvis": dict(anchor=("vertebrae_t", "vertebrae_l", "hip", "sacrum"), above=30, below=20,
                            note="lung apices → pelvic floor"),
    "upperextremity": dict(anchor=("humerus", "scapula", "clavicula"), above=20, below=20,
                           note="shoulder girdle → hand"),
    "lowerextremity": dict(anchor=("femur", "tibia", "fibula", "patella"), above=20, below=20,
                           note="hip → foot"),
    "wholebody": None,       # no crop
    "chest": dict(anchor=("rib", "sternum"), above=25, below=15, note="thoracic cage"),
}


def _region_zrange(region, lab, cmap, zsize, spacing):
    """Return (z0, z1) index bounds for a region, or (0, zsize) for whole-body."""
    if region is None or REGIONS.get(region) is None:
        return 0, zsize
    cfg = REGIONS[region]
    anchor_ids = [lid for lid, nm in cmap.items()
                  if any(a in nm.lower() for a in cfg["anchor"])]
    present = np.isin(lab, anchor_ids)
    zs = np.where(present.any(axis=(1, 2)))[0]
    if zs.size == 0:
        print(f"      ! region '{region}' anchor not found — using whole scan")
        return 0, zsize
    ztop, zbot = int(zs.min()), int(zs.max())
    # +z index is superior? our build orients so index increases inferiorly by
    # default from SimpleITK; handle both by padding symmetrically in index space.
    pad_top = int(round(cfg["above"] / spacing))
    pad_bot = int(round(cfg["below"] / spacing))
    z0 = max(0, ztop - pad_top)
    z1 = min(zsize, zbot + pad_bot + 1)
    return z0, z1


def build(ct_path, seg_path, out_dir, name, title, region, spacing, mesh, source):
    os.makedirs(out_dir, exist_ok=True)
    print(f"[1/5] loading + resampling to {spacing} mm iso …")
    ct = resample_iso(sitk.ReadImage(ct_path), spacing, is_label=False)
    seg = sitk.ReadImage(seg_path)
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
        # keep components within 25% of the largest (both legs, both arms)
        big = sizes.max()
        keep = {i + 1 for i, s in enumerate(sizes) if s >= 0.25 * big}
        body = np.isin(lbl, list(keep))
    body = ndi.binary_fill_holes(body)

    mat = np.full(hu.shape, AIR, dtype=np.uint8)
    m = np.full(hu.shape, SOFT, dtype=np.uint8)
    m[hu < -190] = LUNG
    m[(hu >= -190) & (hu < -30)] = FAT
    m[(hu >= -30) & (hu < 120)] = MUSCLE
    m[(hu >= 120) & (hu < 300)] = TRABECULAR
    m[hu >= 300] = CORTICAL
    mat[body] = m[body]

    shell = body & ~ndi.binary_erosion(body, iterations=max(1, int(round(1.5 / spacing))))
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

    # ---- region crop (cranio-caudal), then tight body bbox ----
    z0r, z1r = _region_zrange(region, lab, cmap, hu.shape[0], spacing)
    if (z0r, z1r) != (0, hu.shape[0]):
        print(f"      region '{region}': z[{z0r}:{z1r}] ({(z1r-z0r)*spacing:.0f} mm)")
    body = body[z0r:z1r]; mat = mat[z0r:z1r]; hu = hu[z0r:z1r]

    print("[4/5] cropping to body + writing volume …")
    zs, ys, xs = np.where(body)
    if zs.size == 0:
        raise SystemExit("empty body mask after region crop — check the region/anchor")
    pad = 4
    z0, z1 = max(0, zs.min() - pad), min(mat.shape[0], zs.max() + pad + 1)
    y0, y1 = max(0, ys.min() - pad), min(mat.shape[1], ys.max() + pad + 1)
    x0, x1 = max(0, xs.min() - pad), min(mat.shape[2], xs.max() + pad + 1)
    mat = np.ascontiguousarray(mat[z0:z1, y0:y1, x0:x1])
    hu_c = hu[z0:z1, y0:y1, x0:x1]
    nz, ny, nx = mat.shape
    mat.tofile(os.path.join(out_dir, f"{name}.mat.bin"))

    present = sorted(int(v) for v in np.unique(mat))
    legend = [dict(id=i, name=nm, hu=hu_, color=f"#{c:06x}") for (i, nm, hu_, c) in LEGEND]
    header = dict(
        name=title, source=source,
        dims=[nx, ny, nz], spacing=[spacing, spacing, spacing],
        order="x-fastest: i = x + nx*(y + ny*z)",
        volume=f"{name}.mat.bin", dtype="uint8", mesh=f"{name}.glb" if mesh else None,
        materials=legend, materialsPresent=present,
        huReference=[int(hu_c.min()), int(hu_c.max())],
    )
    with open(os.path.join(out_dir, f"{name}.model.json"), "w") as f:
        json.dump(header, f, indent=2)
    print(f"      {nx}x{ny}x{nz} = {mat.size/1e6:.1f} MB uint8; materials present: {present}")

    if mesh:
        print("[5/5] building display mesh …")
        _build_mesh(mat, spacing, os.path.join(out_dir, f"{name}.glb"))
    else:
        print("[5/5] mesh skipped")
    print("done ->", out_dir)


def _build_mesh(mat: np.ndarray, spacing: float, path: str):
    import trimesh
    from skimage import measure

    nz, ny, nx = mat.shape
    centre = np.array([nx, ny, nz]) * spacing / 2.0
    scene = trimesh.Scene()
    groups = [
        (np.isin(mat, [SKIN, FAT, MUSCLE, SOFT]),          (0xd8, 0xa0, 0x7a, 70),  3),
        (np.isin(mat, [CORTICAL, TRABECULAR, CARTILAGE]),  (0xf5, 0xef, 0xd8, 255), 2),
        (mat == LUNG,                                      (0x6a, 0x8f, 0xbf, 120), 3),
        (mat == HEART,                                     (0xc0, 0x3a, 0x3a, 230), 2),
        (np.isin(mat, [BLOOD, IODINE]),                    (0xd0, 0x40, 0x40, 240), 2),
        (mat == LIVER,                                     (0x8a, 0x4b, 0x32, 230), 2),
    ]
    for mask, rgba, step in groups:
        if mask.sum() < 200:
            continue
        vol = ndi.binary_closing(mask, iterations=1).astype(np.float32)
        try:
            verts, faces, _, _ = measure.marching_cubes(vol, level=0.5, step_size=step)
        except (RuntimeError, ValueError):
            continue
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
    ap.add_argument("--name", required=True, help="file basename + id, e.g. 'headneck'")
    ap.add_argument("--title", default=None, help="display name, e.g. 'Head & neck'")
    ap.add_argument("--region", default="wholebody", choices=list(REGIONS.keys()))
    ap.add_argument("--spacing", type=float, default=1.0)
    ap.add_argument("--source", default="TotalSegmentator dataset · segmented with TotalSegmentator")
    ap.add_argument("--no-mesh", action="store_true")
    a = ap.parse_args()
    build(a.ct, a.seg, a.out, a.name, a.title or a.name, a.region, a.spacing,
          mesh=not a.no_mesh, source=a.source)
