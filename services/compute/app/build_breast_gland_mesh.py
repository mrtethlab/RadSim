"""The breast phantoms' fibroglandular tissue (and the baked pectoral slab) as display meshes, for
the mammography film's 3D scenes.

    python -m app.build_breast_gland_mesh        # breast, breastdense -> <name>_gland.glb

One node per part ('gland': label 53, 'muscle': label 7), cut from the shipped material volume in
the frame breast.glb uses (vertices in mm about the volume's centre), so the film lays them inside
the skin with the same transform. Display only: the physics is the volume's.
"""
from __future__ import annotations

import json

import numpy as np
from scipy import ndimage as ndi

from app.build_limbs import MODELS
from app.build_bone_mesh import surface

PARTS = [('gland', 53), ('muscle', 7)]


def build(name):
    import trimesh
    h = json.loads((MODELS / name / f'{name}.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    s = float(h['spacing'][0])
    mat = np.fromfile(MODELS / name / f'{name}.mat.bin', dtype=np.uint8).reshape(nz, ny, nx)
    centre = np.array([nx, ny, nz]) * s / 2.0
    scene = trimesh.Scene()
    for part, mid in PARTS:
        mask = mat == mid
        if mask.sum() < 50:
            continue
        lab, n = ndi.label(mask)
        if n > 1:                                     # the part's own pieces, not single-voxel crumbs
            sz = ndi.sum(mask, lab, range(1, n + 1))
            keep = np.zeros(n + 1, bool); keep[1:] = sz * s ** 3 >= 4.0
            mask = keep[lab]
        m = surface(mask, s, step=3, sigma_vox=1.0, taubin=6)
        m.vertices -= centre
        scene.add_geometry(m, node_name=part, geom_name=part)
        print(f'{name} {part:7s} {len(m.faces):7d} faces')
    out = MODELS / name / f'{name}_gland.glb'
    scene.export(str(out))
    print(out.name, f'{out.stat().st_size / 1e6:.2f} MB')


if __name__ == '__main__':
    for n in ('breast', 'breastdense'):
        build(n)
