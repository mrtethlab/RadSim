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
    ENAMEL, IODINE, CALCIF, STONE, SKIN, ALUMINUM, TITANIUM, STEEL, LEAD, PLASTIC = range(29)

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
    (PLASTIC, "Acrylic", 120, 0x9fb6a8),
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


# ---- region crops.
# 'z' regions: a cranio-caudal window anchored to segmented landmarks (crop only the
#   z index range → keeps the full axial cross-section). Good for head/neck, CAP,
#   thighs (below the pelvis a z-slab already contains only the legs).
# 'bbox3d' regions: crop to the 3D bounding box of an anchor structure, picking the
#   lateral side with the most voxels — needed for the upper limb, whose humerus lies
#   ALONGSIDE the thorax so a z-slab would still include the chest. Isolates one arm.
# margin is in mm. anchor entries are matched as name substrings.
REGIONS = {
    "headneck":  dict(mode="z", anchor=("skull", "vertebrae_c"), margin=20, note="skull → lower cervical"),
    "chestabdopelvis": dict(mode="z", anchor=("vertebrae_t", "vertebrae_l", "hip", "sacrum", "rib"),
                            margin=15, note="lung apices → pelvic floor"),
    "upperextremity": dict(mode="bbox3d", anchor=("humerus",), margin=25, lateral=True,
                           note="shoulder → upper arm (one side)"),
    "lowerextremity": dict(mode="bbox3d", anchor=("femur",), margin=25, lateral=False,
                           note="hip → thigh"),
    "wholebody": None,       # no crop
    "chest": dict(mode="z", anchor=("rib", "sternum"), margin=15, note="thoracic cage"),
}


def _side_mask(mask):
    """Keep only the largest lateral (x) half's worth of a structure: split at the
    x-centroid, keep whichever side has more voxels. Isolates one arm/leg."""
    xs = np.where(mask.any(axis=(0, 1)))[0]
    if xs.size == 0:
        return mask
    xmid = int(round(mask.sum(axis=(0, 1)) @ np.arange(mask.shape[2]) / max(1, mask.sum())))
    left = mask.copy(); left[:, :, xmid:] = False
    right = mask.copy(); right[:, :, :xmid] = False
    return right if right.sum() >= left.sum() else left


def _region_bounds(region, lab, cmap, shape, spacing):
    """Return (z0,z1,y0,y1,x0,x1) crop bounds; full volume for whole-body."""
    zN, yN, xN = shape
    full = (0, zN, 0, yN, 0, xN)
    if region is None or REGIONS.get(region) is None:
        return full
    cfg = REGIONS[region]
    anchor_ids = [lid for lid, nm in cmap.items()
                  if any(a in nm.lower() for a in cfg["anchor"])]
    present = np.isin(lab, anchor_ids)
    if not present.any():
        print(f"      ! region '{region}' anchor not found — using whole scan")
        return full
    mg = int(round(cfg.get("margin", 20) / spacing))
    if cfg["mode"] == "bbox3d":
        if cfg.get("lateral"):
            present = _side_mask(present)
        zs, ys, xs = np.where(present)
        return (max(0, zs.min() - mg), min(zN, zs.max() + mg + 1),
                max(0, ys.min() - mg), min(yN, ys.max() + mg + 1),
                max(0, xs.min() - mg), min(xN, xs.max() + mg + 1))
    # z-only
    zs = np.where(present.any(axis=(1, 2)))[0]
    return (max(0, zs.min() - mg), min(zN, zs.max() + mg + 1), 0, yN, 0, xN)


def materialize(hu, lab, spacing, body_restrict=None):
    """Assign a body-material id to every voxel of an (already-resampled) HU + label
    volume. Returns (mat uint8, body mask). Reused by build() and build_highres.
    body_restrict: optional bool mask (e.g. TotalSegmentator's `body` task) to clip the
    body to the patient envelope, removing the scanner table + external tubes/leads."""
    body = hu > -320
    body = ndi.binary_closing(body, iterations=2)
    body = ndi.binary_fill_holes(body)
    if body_restrict is not None:
        body &= body_restrict
    lbl, n = ndi.label(body)
    if n > 1:
        sizes = ndi.sum(np.ones_like(lbl), lbl, index=range(1, n + 1))
        # keep ONLY the largest connected component — drops the scanner table/cradle and
        # any disconnected external kit (tubes, leads, positioning aids) that the
        # HU>-320 body mask would otherwise include (postmortem forensic CT is full of it).
        body = lbl == (int(np.argmax(sizes)) + 1)
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
    return mat, body


def write_model(out_dir, name, title, mat, hu_c, spacing, mesh, source,
                backend_only=False, mesh_step_mul=1):
    """Tight-crop to the body bbox, write <name>.mat.bin + .model.json (+ .glb).
    mesh_step_mul coarsens the display mesh (use >1 for sub-mm grids so the .glb
    stays small — the mesh is only for the positioning view, not the physics)."""
    os.makedirs(out_dir, exist_ok=True)
    present = sorted(int(v) for v in np.unique(mat))
    nz, ny, nx = mat.shape
    mat = np.ascontiguousarray(mat)
    mat.tofile(os.path.join(out_dir, f"{name}.mat.bin"))
    legend = [dict(id=i, name=nm, hu=hu_, color=f"#{c:06x}") for (i, nm, hu_, c) in LEGEND]
    header = dict(
        name=title, source=source,
        dims=[nx, ny, nz], spacing=[spacing, spacing, spacing],
        order="x-fastest: i = x + nx*(y + ny*z)",
        volume=f"{name}.mat.bin", dtype="uint8", mesh=f"{name}.glb" if mesh else None,
        materials=legend, materialsPresent=present,
        huReference=[int(hu_c.min()), int(hu_c.max())],
        backendOnly=bool(backend_only),   # frontend: skip fetching the .mat.bin, force the GPU backend
    )
    with open(os.path.join(out_dir, f"{name}.model.json"), "w") as f:
        json.dump(header, f, indent=2)
    print(f"      {nx}x{ny}x{nz} = {mat.size/1e6:.1f} MB uint8; materials present: {present}")
    if mesh:
        print("      building display mesh …")
        _build_mesh(mat, spacing, os.path.join(out_dir, f"{name}.glb"), mesh_step_mul)


def add_hip_prosthesis(mat, lab, cmap, spacing):
    """Emulate a bilateral TOTAL HIP REPLACEMENT: replace each native hip joint with a
    titanium implant — a femoral head/neck ball, an intramedullary femoral stem, and an
    acetabular cup. Uses the TotalSegmentator femur_* / hip_* masks to locate each joint,
    so the implant sits exactly where the real articulation was. mat/lab are the final
    (cropped, flipped) volumes and must be aligned."""
    femur_ids = [i for i, n in cmap.items() if n.lower().startswith("femur")]
    hip_ids = [i for i, n in cmap.items() if n.lower().startswith("hip")]
    if not femur_ids or not hip_ids:
        print("      ! no femur/hip labels found — THR skipped")
        return mat
    hip_mask = np.isin(lab, hip_ids)
    hip_dist_mm = ndi.distance_transform_edt(~hip_mask) * spacing        # mm to nearest acetabulum voxel
    nz, ny, nx = mat.shape
    zz, yy, xx = np.mgrid[0:nz, 0:ny, 0:nx].astype(np.float32)
    n_impl = 0
    for fid in femur_ids:                                                # femur_left / femur_right → one implant each
        fem = lab == fid
        if fem.sum() < 500:
            continue
        near = fem & (hip_dist_mm < 10.0)                                # femur voxels hugging the acetabulum = head
        if near.sum() < 30:
            near = fem & (hip_dist_mm <= np.percentile(hip_dist_mm[fem], 3.0))
        hc = np.array([zz[near].mean(), yy[near].mean(), xx[near].mean()])   # femoral-head centre (vox)
        fc = np.array([zz[fem].mean(), yy[fem].mean(), xx[fem].mean()])      # femur centroid (vox)
        axis = fc - hc
        nrm = np.linalg.norm(axis)
        if nrm < 1e-3:
            continue
        axis /= nrm                                                      # head → shaft direction (stem axis)
        rz, ry, rx = (zz - hc[0]) * spacing, (yy - hc[1]) * spacing, (xx - hc[2]) * spacing
        d_head = np.sqrt(rz * rz + ry * ry + rx * rx)                    # mm from the head centre
        t = rz * axis[0] + ry * axis[1] + rx * axis[2]                   # mm along the stem axis (+ toward shaft)
        rad = np.sqrt(np.clip(d_head * d_head - t * t, 0.0, None))       # mm perpendicular to the stem axis
        solid = mat > AIR
        ball = (d_head <= 18.0) & solid                                 # Ø36 mm prosthetic head + neck
        stem = (t >= 0.0) & (t <= 120.0) & (rad <= 7.0) & solid         # intramedullary femoral stem
        cup = (d_head <= 27.0) & hip_mask                               # acetabular cup shell (in the pelvis)
        mat[ball | stem | cup] = TITANIUM
        n_impl += 1
        print(f"      THR femur#{fid}: head@vox {hc.round(1)}  titanium voxels {int((ball | stem | cup).sum())}")
    print(f"      inserted {n_impl} titanium hip implant(s)")
    return mat


def build(ct_path, seg_path, out_dir, name, title, region, spacing, mesh, source, box=None, body_path=None, flip=(0, 0, 0), hip_titanium=False):
    print(f"[1/4] loading + resampling to {spacing} mm iso …")
    ct = resample_iso(sitk.ReadImage(ct_path), spacing, is_label=False)
    seg = sitk.ReadImage(seg_path)
    seg = sitk.Resample(seg, ct, sitk.Transform(), sitk.sitkNearestNeighbor, 0, seg.GetPixelID())
    hu = sitk.GetArrayFromImage(ct).astype(np.int16)      # (z, y, x)
    lab = sitk.GetArrayFromImage(seg).astype(np.int32)
    print(f"      grid {hu.shape[::-1]}  ({hu.size/1e6:.1f} M voxels)")

    body_restrict = None
    if body_path:
        bimg = sitk.ReadImage(body_path)
        bimg = sitk.Resample(bimg, ct, sitk.Transform(), sitk.sitkNearestNeighbor, 0, bimg.GetPixelID())
        body_restrict = sitk.GetArrayFromImage(bimg) > 0
        # the --fast body task under-covers the limbs; dilate + fill so the envelope
        # comfortably contains the anatomy (no holes) while the table/leads — a larger
        # air gap away — stay excluded.
        r = max(1, int(round(4.0 / spacing)))
        body_restrict = ndi.binary_dilation(body_restrict, iterations=r)
        body_restrict = ndi.binary_fill_holes(body_restrict)
        print(f"      body-envelope restrict (+{r}vox): {body_restrict.sum()/1e6:.0f} M voxels")

    print("[2/4] materials …")
    mat, body = materialize(hu, lab, spacing, body_restrict=body_restrict)

    print("[3/4] region crop + tight body bbox …")
    if box is not None:
        # explicit normalised crop (zlo,zhi,ylo,yhi,xlo,xhi in [0,1]) — used when the
        # segmentation is too noisy for anchor-based crops (e.g. postmortem full-body
        # scans, where a stray femur/humerus voxel wrecks a 3D bbox). z=0 is slice 0.
        nz0, ny0, nx0 = hu.shape
        b = (int(box[0]*nz0), int(box[1]*nz0), int(box[2]*ny0), int(box[3]*ny0),
             int(box[4]*nx0), int(box[5]*nx0))
        print(f"      box crop z[{b[0]}:{b[1]}] y[{b[2]}:{b[3]}] x[{b[4]}:{b[5]}]")
    else:
        b = _region_bounds(region, lab, ts_class_map(), hu.shape, spacing)
    if b != (0, hu.shape[0], 0, hu.shape[1], 0, hu.shape[2]):
        print(f"      region '{region}': z[{b[0]}:{b[1]}] y[{b[2]}:{b[3]}] x[{b[4]}:{b[5]}]")
    sl = (slice(b[0], b[1]), slice(b[2], b[3]), slice(b[4], b[5]))
    body = body[sl]; mat = mat[sl]; hu = hu[sl]; lab = lab[sl]
    zs, ys, xs = np.where(body)
    if zs.size == 0:
        raise SystemExit("empty body mask after region crop — check the region/anchor")
    pad = 4
    z0, z1 = max(0, zs.min() - pad), min(mat.shape[0], zs.max() + pad + 1)
    y0, y1 = max(0, ys.min() - pad), min(mat.shape[1], ys.max() + pad + 1)
    x0, x1 = max(0, xs.min() - pad), min(mat.shape[2], xs.max() + pad + 1)
    mat = mat[z0:z1, y0:y1, x0:x1]; hu_c = hu[z0:z1, y0:y1, x0:x1]; lab_c = lab[z0:z1, y0:y1, x0:x1]

    if flip and any(flip):
        # bake anatomical axis flips into the stored volume + derived mesh so every model
        # shares the app's display convention (index-0 = inferior / anterior / patient-R).
        # VSD forensic scans store head-first, so they need a z flip to match the chest model.
        if flip[2]: mat = mat[:, :, ::-1]; hu_c = hu_c[:, :, ::-1]; lab_c = lab_c[:, :, ::-1]   # x (lateral)
        if flip[1]: mat = mat[:, ::-1, :]; hu_c = hu_c[:, ::-1, :]; lab_c = lab_c[:, ::-1, :]   # y (AP)
        if flip[0]: mat = mat[::-1, :, :]; hu_c = hu_c[::-1, :, :]; lab_c = lab_c[::-1, :, :]   # z (long/superior)
        mat = np.ascontiguousarray(mat); hu_c = np.ascontiguousarray(hu_c); lab_c = np.ascontiguousarray(lab_c)
        print(f"      axis flip (z,y,x)={tuple(int(f) for f in flip)}")

    if hip_titanium:
        print("      inserting titanium total hip replacement …")
        mat = add_hip_prosthesis(mat, lab_c, ts_class_map(), spacing)

    print("[4/4] writing volume …")
    write_model(out_dir, name, title, mat, hu_c, spacing, mesh, source)
    print("done ->", out_dir)


def _build_mesh(mat: np.ndarray, spacing: float, path: str, step_mul: int = 1):
    import trimesh
    from skimage import measure

    nz, ny, nx = mat.shape
    centre = np.array([nx, ny, nz]) * spacing / 2.0
    scene = trimesh.Scene()
    groups = [
        (np.isin(mat, [SKIN, FAT, MUSCLE, SOFT]),          (0xd8, 0xa0, 0x7a, 70),  3),
        (np.isin(mat, [CORTICAL, TRABECULAR, CARTILAGE]),  (0xf5, 0xef, 0xd8, 255), 2),
        (np.isin(mat, [TITANIUM, STEEL, ALUMINUM, LEAD]),  (0x9a, 0xa5, 0xb0, 255), 1),  # metal implants — solid

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
            verts, faces, _, _ = measure.marching_cubes(vol, level=0.5, step_size=step * step_mul)
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
    ap.add_argument("--box", type=float, nargs=6, default=None,
                    metavar=("ZLO", "ZHI", "YLO", "YHI", "XLO", "XHI"),
                    help="explicit normalised crop [0,1], overrides --region (for noisy seg)")
    ap.add_argument("--body", default=None,
                    help="TotalSegmentator `body` task mask to clip to the patient envelope "
                         "(removes the scanner table + external tubes/leads)")
    ap.add_argument("--flip", type=int, nargs=3, default=(0, 0, 0), metavar=("Z", "Y", "X"),
                    help="bake anatomical axis flips (z y x) into the volume+mesh, e.g. "
                         "--flip 1 0 0 for VSD head-first scans")
    ap.add_argument("--hip-titanium", action="store_true",
                    help="replace both native hip joints with a titanium total hip replacement "
                         "(femoral ball + stem + acetabular cup) — for metal-artifact demos")
    a = ap.parse_args()
    build(a.ct, a.seg, a.out, a.name, a.title or a.name, a.region, a.spacing,
          mesh=not a.no_mesh, source=a.source, box=a.box, body_path=a.body, flip=a.flip,
          hip_titanium=a.hip_titanium)
