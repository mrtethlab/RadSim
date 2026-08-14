"""Build the "Breast" voxel model — a high-resolution procedural phantom for the
mammography mode (docs/mammography.md).

Anatomy, in model axes (x lateral, y posterior->anterior, z inferior->superior):
a half-ellipsoid mound against a chest-wall plane at y=0, with

  - a 1.6 mm skin shell (and a nipple bump at the anterior apex),
  - fat background with a textured FIBROGLANDULAR core — three octaves of smoothed
    noise thresholded against a centrally-weighted probability field, tuned to a
    heterogeneously-dense (BI-RADS c) mix,
  - ductal strands converging on the nipple,
  - and a pectoralis slab behind the chest wall margin (MLO adequacy).

Findings are NOT baked in — the mode injects them analytically from a case seed
(see the note at the seeding site below), so cases can be blinded, normal cases
exist, and sub-voxel specks do not alias.

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

from .build_model import AIR, FAT, MUSCLE, SKIN, write_model

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

    # NO FINDINGS ARE BAKED IN. They are injected analytically at read time by the
    # mammography mode (apps/web/src/mammo.js caseFindings) from a case seed, which
    # buys three things a baked finding cannot: blinded cases the learner has not
    # seen, NORMAL cases with nothing planted, and specks smaller than a voxel —
    # a 0.4 mm speck baked into a 0.4 mm grid aliases, while an analytic chord does
    # not. The parenchyma is the phantom's job; the pathology is the case's.

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
