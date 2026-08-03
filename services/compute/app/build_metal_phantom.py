"""Build the "Metal Test Phantom" voxel model — a synthetic QA phantom for demonstrating
metal artifacts (beam hardening + photon-starvation streaks) in CT and x-ray.

Geometry: a hollow acrylic (plastic) cube filled with water, with three lead pillars
running the long (z / scan) axis, arranged in an equilateral triangle about the centre.
In a transverse slice the three lead dots throw the classic dark/bright streaks across the
uniform water background.

Uses the SAME label-volume format + material ids as the anatomical models
(apps/web/src/core/materials.js BodyMaterials.LIST), so the browser + GPU engines and the
HU mapping all apply unchanged. Run from services/compute:

    python -m app.build_metal_phantom --out ../../apps/web/public/models/metalphantom
"""
from __future__ import annotations

import argparse
import os

import numpy as np

from .build_model import AIR, WATER, LEAD, PLASTIC, LEGEND, write_model


def _build_phantom_mesh(mat, spacing, path, step=2):
    """Display mesh for the bay 3D view: translucent acrylic shell + water, solid lead
    pillars. (build_model._build_mesh only knows anatomical materials, so the phantom
    ships its own.)"""
    import trimesh
    from skimage import measure
    from scipy import ndimage as ndi

    nz, ny, nx = mat.shape
    centre = np.array([nx, ny, nz]) * spacing / 2.0
    scene = trimesh.Scene()
    # node names carry the material so the frontend can make acrylic + water translucent
    groups = [
        ("acrylic", mat == PLASTIC, (0x9f, 0xb6, 0xa8, 90)),    # acrylic shell — translucent
        ("water",   mat == WATER,   (0x2f, 0x6f, 0xb0, 70)),    # water fill — translucent blue
        ("lead",    mat == LEAD,    (0x53, 0x57, 0x5e, 255)),   # lead pillars — solid dark
    ]
    for nm, mask, rgba in groups:
        if mask.sum() < 200:
            continue
        vol = ndi.binary_closing(mask, iterations=1).astype(np.float32)
        try:
            verts, faces, _, _ = measure.marching_cubes(vol, level=0.5, step_size=step)
        except (RuntimeError, ValueError):
            continue
        v = np.column_stack([verts[:, 2], verts[:, 1], verts[:, 0]]) * spacing - centre
        m = trimesh.Trimesh(vertices=v, faces=faces, process=False)
        m.visual.vertex_colors = np.tile(np.array(rgba, np.uint8), (len(v), 1))
        scene.add_geometry(m, node_name=nm, geom_name=nm)
    scene.export(path)
    print(f"      wrote {path}")


def build(out_dir, name="metalphantom", title="Metal Test Phantom", spacing=1.0, mesh=True):
    # Cube with a small air margin; the long axis is z (the CT scan direction).
    nx = ny = 200
    nz = 180
    mat = np.full((nz, ny, nx), AIR, np.uint8)

    margin = 12   # air gap around the cube (mm)
    wall = 12     # acrylic wall thickness (mm)
    zcap = 14     # acrylic end-cap thickness (mm)
    x0, x1 = margin, nx - margin
    y0, y1 = margin, ny - margin
    z0, z1 = margin, nz - margin

    zz, yy, xx = np.ogrid[0:nz, 0:ny, 0:nx]
    cube = (xx >= x0) & (xx < x1) & (yy >= y0) & (yy < y1) & (zz >= z0) & (zz < z1)
    inner = ((xx >= x0 + wall) & (xx < x1 - wall) & (yy >= y0 + wall) & (yy < y1 - wall)
             & (zz >= z0 + zcap) & (zz < z1 - zcap))
    mat[cube] = PLASTIC     # solid acrylic block …
    mat[inner] = WATER      # … hollowed out and filled with water

    # three lead pillars, equilateral triangle about the centre, spanning the water column
    cx, cy = nx / 2.0, ny / 2.0
    tri_R = 52.0    # triangle circumradius (mm)
    pil_r = 7.0     # pillar radius (mm)
    for k in range(3):
        ang = np.deg2rad(90.0 + k * 120.0)
        px, py = cx + tri_R * np.cos(ang), cy + tri_R * np.sin(ang)
        pillar = ((xx - px) ** 2 + (yy - py) ** 2 <= pil_r * pil_r) & inner
        mat[pillar] = LEAD

    # HU reference for display windowing (lead reads off-scale-high by design; clamp the
    # stored range to the usual soft-tissue/bone window like the anatomical models)
    hu_c = np.array([-1000, 3071], np.int16)

    print(f"[1/2] phantom grid {nx}x{ny}x{nz}  ({mat.size/1e6:.1f} M voxels)")
    print(f"      lead voxels: {(mat == LEAD).sum()}  water: {(mat == WATER).sum()}  acrylic: {(mat == PLASTIC).sum()}")
    print("[2/2] writing model …")
    # write_model builds the .glb via build_model._build_mesh (anatomy only) when mesh=True;
    # we want the phantom mesh instead, so write the volume/json without a mesh, then add ours.
    write_model(out_dir, name, title, mat, hu_c, spacing, mesh=False,
                source="Synthetic QA phantom (acrylic + water + lead) for metal-artifact testing")
    if mesh:
        print("      building display mesh …")
        _build_phantom_mesh(mat, spacing, os.path.join(out_dir, f"{name}.glb"))
        # write_model wrote mesh=None into the json; patch it to point at the .glb
        import json
        jpath = os.path.join(out_dir, f"{name}.model.json")
        with open(jpath) as f:
            hdr = json.load(f)
        hdr["mesh"] = f"{name}.glb"
        with open(jpath, "w") as f:
            json.dump(hdr, f, indent=2)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="output model dir, e.g. apps/web/public/models/metalphantom")
    ap.add_argument("--name", default="metalphantom")
    ap.add_argument("--title", default="Metal Test Phantom")
    ap.add_argument("--spacing", type=float, default=1.0)
    ap.add_argument("--no-mesh", action="store_true")
    a = ap.parse_args()
    build(a.out, name=a.name, title=a.title, spacing=a.spacing, mesh=not a.no_mesh)
