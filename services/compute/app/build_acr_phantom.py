"""Build the "Mammo QC Phantom" voxel model — an ACR-style accreditation phantom for the
mammography mode (docs/mammography.md Phase D).

A 10 x 10 x 4.2 cm acrylic slab carrying twelve wax-insert test objects in three rows,
each row descending in difficulty exactly as the real phantom does:

  - FIBRES:  four nylon fibres, 1.4 / 1.1 / 0.8 / 0.5 mm diameter, 9 mm long, at 45 deg
  - SPECKS:  four microcalcification groups (6 specks each in an 8 mm circle),
             speck diameter 0.9 / 0.7 / 0.5 / 0.4 mm — the last at the voxel limit
  - MASSES:  four lens-shaped masses, 4.5 mm radius, thickness 2.0 / 1.5 / 1.0 / 0.5 mm

Scoring an image of it — how many of each row are visible — is a real technologist QC
task and the mammography mode's reading exercise. The slab is rigid: the compression
paddle parks against it and the drive does nothing, as with the real phantom.

Run from services/compute:

    python -m app.build_acr_phantom --out ../../apps/web/public/models/acrphantom
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np

from .build_model import AIR, WATER, SOFT, CALCIF, PLASTIC, GLAND, write_model

def build(out_dir, name="acrphantom", title="Mammo QC Phantom", spacing=0.4, mesh=True):
    # slab: x 100 mm, y 100 mm, z 42 mm (+ small air margins)
    nx, ny, nz = 260, 260, 110
    mat = np.full((nz, ny, nx), AIR, np.uint8)
    zz, yy, xx = np.mgrid[0:nz, 0:ny, 0:nx].astype(np.float32)
    xmm, ymm, zmm = xx * spacing, yy * spacing, zz * spacing

    m0 = 2.0                                    # air margin, mm
    slab = ((xmm >= m0) & (xmm <= 102) & (ymm >= m0) & (ymm <= 102)
            & (zmm >= m0) & (zmm <= 42))
    mat[slab] = PLASTIC

    zin = 22.0                                  # insert plane, mid-slab
    rows_y = [78.0, 52.0, 26.0]                 # fibres / specks / masses
    cols_x = [20.0, 42.0, 64.0, 86.0]

    # fibres: cylinders at 45 deg in the insert plane
    for i, dia in enumerate([1.4, 1.1, 0.8, 0.5]):
        cx, cy = cols_x[i], rows_y[0]
        t = np.linspace(-4.5, 4.5, 40)
        for tt in t:
            px, py = cx + tt * 0.707, cy + tt * 0.707
            r = dia / 2
            f = (((xmm - px) ** 2 + (ymm - py) ** 2) <= r * r) & (np.abs(zmm - zin) <= r + 0.2)
            mat[f & slab] = SOFT
    # speck groups: 6 specks on a small circle + one centred
    rng = np.random.default_rng(3)
    for i, dia in enumerate([0.9, 0.7, 0.5, 0.4]):
        cx, cy = cols_x[i], rows_y[1]
        pts = [(cx, cy)] + [(cx + 4.0 * np.cos(a), cy + 4.0 * np.sin(a))
                            for a in rng.uniform(0, 2 * np.pi, 5)]
        r = max(dia / 2, spacing / 2)
        for px, py in pts:
            s = (((xmm - px) ** 2 + (ymm - py) ** 2 + (zmm - zin) ** 2) <= r * r)
            ix, iy, iz = int(px / spacing), int(py / spacing), int(zin / spacing)
            if s.sum() == 0 and 0 <= iz < nz and 0 <= iy < ny and 0 <= ix < nx:
                mat[iz, iy, ix] = CALCIF        # sub-voxel speck: one voxel, honestly
            else:
                mat[s & slab] = CALCIF
    # masses: flattened lenses (oblate spheroids)
    for i, thk in enumerate([2.0, 1.5, 1.0, 0.5]):
        cx, cy = cols_x[i], rows_y[2]
        mss = ((((xmm - cx) / 4.5) ** 2 + ((ymm - cy) / 4.5) ** 2
                + ((zmm - zin) / (thk / 2)) ** 2) <= 1.0)
        mat[mss & slab] = GLAND

    hu_c = np.array([-1000, 3071], np.int16)
    print(f"[1/2] QC phantom {nx}x{ny}x{nz} @ {spacing} mm  ({mat.size/1e6:.1f} M voxels)")
    print("[2/2] writing model …")
    write_model(out_dir, name, title, mat, hu_c, spacing, mesh=False,
                source="Synthetic ACR-style mammography accreditation phantom "
                       "(acrylic slab + fibre/speck/mass inserts) — docs/mammography.md")
    jpath = os.path.join(out_dir, f"{name}.model.json")
    with open(jpath) as f:
        hdr = json.load(f)
    if mesh:
        _build_mesh(mat, spacing, os.path.join(out_dir, f"{name}.glb"))
        hdr["mesh"] = f"{name}.glb"
    with open(jpath, "w") as f:
        json.dump(hdr, f, indent=2)


def _build_mesh(mat, spacing, path, step=2):
    import trimesh
    from skimage import measure
    from scipy import ndimage as ndi

    nz, ny, nx = mat.shape
    centre = np.array([nx, ny, nz]) * spacing / 2.0
    vol = ndi.binary_closing(mat != AIR, iterations=1).astype(np.float32)
    verts, faces, _, _ = measure.marching_cubes(vol, level=0.5, step_size=step)
    v = np.column_stack([verts[:, 2], verts[:, 1], verts[:, 0]]) * spacing - centre
    m = trimesh.Trimesh(vertices=v, faces=faces, process=False)
    m.visual.vertex_colors = np.tile(np.array([0x9f, 0xb6, 0xa8, 140], np.uint8), (len(v), 1))
    scene = trimesh.Scene()
    scene.add_geometry(m, node_name="acrylic", geom_name="acrylic")
    scene.export(path)
    print(f"      wrote {path}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--spacing", type=float, default=0.4)
    a = ap.parse_args()
    build(a.out, spacing=a.spacing)
