"""Build the "Breast" voxel model — a high-resolution procedural phantom for the
mammography mode (docs/mammography.md).

Anatomy, in model axes (x lateral, y posterior->anterior, z inferior->superior):
a half-ellipsoid mound against a chest-wall plane at y=0, with

  - a 1.6 mm skin shell (and a nipple bump at the anterior apex),
  - fat background with a textured FIBROGLANDULAR core — three octaves of smoothed
    noise thresholded against a centrally-weighted probability field, tuned to a
    heterogeneously-dense (BI-RADS c) mix,
  - ductal strands converging on the nipple,
  - a pectoralis slab behind the chest wall margin (MLO adequacy, later),
  - and three SEEDED findings for the reading exercises: a microcalcification
    cluster (single-voxel 0.4 mm specks — deliberately at the sampling limit), a
    circumscribed homogeneous mass, and a spiculated mass with radiating strands.

Compression is NOT baked here: the mammography mode compresses this uncompressed
volume geometrically (anisotropic spacing — see mammo.js), so one phantom serves
every compression thickness.

Run from services/compute:

    python -m app.build_breast --out ../../apps/web/public/models/breast
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
from scipy import ndimage as ndi

from .build_model import AIR, FAT, MUSCLE, SOFT, CALCIF, SKIN, write_model

GLAND = 53  # Glandular — new id, mirrored in apps/web/src/core/materials.js


# BI-RADS density -> glandular-mix threshold (calibrated against the printed glandular
# fraction: b ~ 18 %, c ~ 30 %, d ~ 50 % of the breast interior)
DENSITY_THR = {"b": 1.45, "c": 0.88, "d": 0.30}


def build(out_dir, name="breast", title="Breast · 0.4 mm", spacing=0.4, seed=7, mesh=True,
          density="c"):
    rng = np.random.default_rng(seed)

    # grid: x 150 mm lateral, y 90 mm chest-wall->nipple, z 72 mm inferior->superior
    nx, ny, nz = 376, 226, 180
    mat = np.full((nz, ny, nx), AIR, np.uint8)

    cx_mm, cz_mm = nx * spacing / 2.0, nz * spacing / 2.0
    ax, ay, az = 64.0, 82.0, 33.0          # semi-axes (mm): a generous B/C-cup mound
    zz, yy, xx = np.mgrid[0:nz, 0:ny, 0:nx].astype(np.float32)
    xmm, ymm, zmm = xx * spacing, yy * spacing, zz * spacing

    r2 = (((xmm - cx_mm) / ax) ** 2 + (ymm / ay) ** 2 + ((zmm - cz_mm) / az) ** 2)
    mound = (r2 <= 1.0) & (ymm >= 0)

    # nipple: a 4 mm bump proud of the anterior apex
    nip_y = ay
    nip = (((xmm - cx_mm) ** 2 + ((ymm - nip_y) / 1.4) ** 2 + (zmm - cz_mm) ** 2) <= 4.0 ** 2)
    body = mound | nip

    # skin shell: body minus a 1.6 mm erosion
    er = ndi.binary_erosion(body, iterations=max(1, int(round(1.6 / spacing))))
    mat[body] = SKIN
    mat[er] = FAT

    # ---- fibroglandular core -------------------------------------------------
    # probability field: strongest in the central cone toward the nipple, fading
    # peripherally — the classic fibroglandular disc
    cone = 1.0 - np.sqrt(((xmm - cx_mm) / (0.55 * ax)) ** 2 + ((zmm - cz_mm) / (0.55 * az)) ** 2)
    depth = 1.0 - np.abs(ymm - 0.42 * ay) / (0.62 * ay)
    prob = np.clip(cone, 0, 1) * np.clip(depth, 0, 1)

    # three octaves of smoothed noise = the texture the radiologist actually reads
    tex = np.zeros_like(prob)
    for sig, amp in ((12, 1.0), (6, 0.55), (3, 0.30)):
        n = rng.standard_normal((-(-nz // 4), -(-ny // 4), -(-nx // 4))).astype(np.float32)
        n = ndi.gaussian_filter(n, sig / 4)
        n = np.repeat(np.repeat(np.repeat(n, 4, 0), 4, 1), 4, 2)[:nz, :ny, :nx]
        tex += amp * n / (n.std() + 1e-9)
    gland = er & (tex + 2.2 * prob > DENSITY_THR.get(density, 0.88))

    # ductal strands: straight runs from mid-gland to the nipple
    for k in range(9):
        ang = rng.uniform(0, 2 * np.pi)
        rad = rng.uniform(6, 0.4 * ax)
        x0, z0 = cx_mm + rad * np.cos(ang), cz_mm + 0.5 * rad * np.sin(ang)
        y0 = rng.uniform(0.30, 0.55) * ay
        t = np.clip((ymm - y0) / (nip_y - y0), 0, 1)
        lx = x0 + (cx_mm - x0) * t
        lz = z0 + (cz_mm - z0) * t
        duct = (((xmm - lx) ** 2 + (zmm - lz) ** 2) <= 0.55 ** 2) & (ymm >= y0) & er
        gland |= duct
    mat[gland] = GLAND

    # pectoralis margin: an angled slab hugging the chest wall
    pec = er & (ymm < 9.0 - 0.06 * (zmm - cz_mm))
    mat[pec] = MUSCLE

    # ---- seeded findings -----------------------------------------------------
    # 1. microcalcification cluster: 14 single-voxel specks in an 8 mm ball,
    #    upper-outer quadrant — each speck is 0.4 mm, AT the sampling limit
    ccx, ccy, ccz = cx_mm + 20, 0.52 * ay, cz_mm + 8
    for _ in range(14):
        v = rng.standard_normal(3)
        v = v / np.linalg.norm(v) * rng.uniform(0, 4.0)
        ix = int(round((ccx + v[0]) / spacing))
        iy = int(round((ccy + v[1]) / spacing))
        iz = int(round((ccz + v[2]) / spacing))
        if 0 <= iz < nz and 0 <= iy < ny and 0 <= ix < nx and er[iz, iy, ix]:
            mat[iz, iy, ix] = CALCIF

    # 2. circumscribed mass: a 9 mm homogeneous ball — reads as a smooth density
    #    against the textured background (cyst / fibroadenoma morphology)
    mcx, mcy, mcz = cx_mm - 24, 0.45 * ay, cz_mm - 6
    massA = (((xmm - mcx) ** 2 + (ymm - mcy) ** 2 + (zmm - mcz) ** 2) <= 4.5 ** 2) & er
    mat[massA] = SOFT

    # 3. spiculated mass: an irregular 11 mm core with radiating strands — the
    #    morphology that matters, drawn with the geometry that makes it
    scx, scy, scz = cx_mm + 8, 0.62 * ay, cz_mm - 9
    core_r = 5.5 * (1.0 + 0.25 * np.sin(4 * np.arctan2(zmm - scz, xmm - scx)))
    massB = (((xmm - scx) ** 2 + (ymm - scy) ** 2 + (zmm - scz) ** 2) <= core_r ** 2) & er
    mat[massB] = SOFT
    for _ in range(14):
        v = rng.standard_normal(3)
        v /= np.linalg.norm(v)
        ln = rng.uniform(6, 15)
        t = np.linspace(0, 1, 60)[:, None]
        pts = (np.array([scx, scy, scz]) + v * (5.0 + ln * t))
        for px, py, pz in pts:
            ix, iy, iz = int(px / spacing), int(py / spacing), int(pz / spacing)
            if 0 <= iz < nz and 0 <= iy < ny and 0 <= ix < nx and er[iz, iy, ix]:
                mat[iz, iy, ix] = SOFT

    hu_c = np.array([-1000, 3071], np.int16)
    gl_pct = 100.0 * (mat == GLAND).sum() / max(1, (er & (mat != MUSCLE)).sum())
    print(f"[1/2] breast grid {nx}x{ny}x{nz} @ {spacing} mm  ({mat.size/1e6:.1f} M voxels)")
    print(f"      glandular fraction of the breast interior: {gl_pct:.0f} %")
    print("[2/2] writing model …")
    write_model(out_dir, name, title, mat, hu_c, spacing, mesh=False,
                source="Procedural breast phantom (skin/fat/glandular + seeded findings) "
                       "for the mammography mode — docs/mammography.md")
    # write_model's legend stops at the base materials; this model carries id 53
    jpath = os.path.join(out_dir, f"{name}.model.json")
    with open(jpath) as f:
        hdr = json.load(f)
    hdr["materials"].append(dict(id=GLAND, name="Glandular", hu=40, color="#e4c9b0"))
    if mesh:
        print("      building display mesh …")
        _build_mesh(mat, body, spacing, os.path.join(out_dir, f"{name}.glb"))
        hdr["mesh"] = f"{name}.glb"
    with open(jpath, "w") as f:
        json.dump(hdr, f, indent=2)


def _build_mesh(mat, body, spacing, path, step=2):
    """Display mesh: the skin surface, skin-toned — what compresses on screen. Taubin
    smoothing takes the marching-cube contour rings off without shrinking the mound."""
    import trimesh
    from skimage import measure

    nz, ny, nx = mat.shape
    centre = np.array([nx, ny, nz]) * spacing / 2.0
    vol = ndi.binary_closing(body, iterations=1).astype(np.float32)
    vol = ndi.gaussian_filter(vol, 1.2)
    verts, faces, _, _ = measure.marching_cubes(vol, level=0.5, step_size=step)
    v = np.column_stack([verts[:, 2], verts[:, 1], verts[:, 0]]) * spacing - centre
    m = trimesh.Trimesh(vertices=v, faces=faces, process=True)
    trimesh.smoothing.filter_taubin(m, lamb=0.5, nu=-0.53, iterations=12)
    m.visual.vertex_colors = np.tile(np.array([0xd8, 0xa0, 0x7a, 255], np.uint8), (len(v), 1))
    scene = trimesh.Scene()
    scene.add_geometry(m, node_name="skin", geom_name="skin")
    scene.export(path)
    print(f"      wrote {path}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--name", default="breast")
    ap.add_argument("--spacing", type=float, default=0.4)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--density", choices=["b", "c", "d"], default="c")
    ap.add_argument("--title", default=None)
    ap.add_argument("--no-mesh", action="store_true")
    a = ap.parse_args()
    build(a.out, name=a.name, spacing=a.spacing, seed=a.seed, mesh=not a.no_mesh,
          density=a.density, title=a.title or f"Breast · 0.4 mm ({a.density})")
