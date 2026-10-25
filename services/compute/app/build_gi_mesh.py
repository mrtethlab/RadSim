"""The chest/abdomen/pelvis model's gut as display meshes, for the films' barium scenes.

    python -m app.build_gi_mesh                  # chestabdopelvis -> chestabdopelvis_gi.glb

One node per part (oesophagus, stomach, duodenum, small_bowel, colon), cut from the shipped
material volume's lumen labels in the frame every other mesh of the model uses (as build_bone_mesh),
the bowel gas in each lumen given to the nearest part, so a part's surface is its whole lumen.
Display only: the films fill a part with barium by colour, the physics is the volume's.
"""
from __future__ import annotations

import json

import numpy as np
from scipy import ndimage as ndi

from app.build_model import OESOPHAGUS, STOMACH, DUODENUM, SMALL_BOWEL, COLON, GAS
from app.build_limbs import MODELS
from app.build_bone_mesh import surface

PARTS = [('oesophagus', OESOPHAGUS), ('stomach', STOMACH), ('duodenum', DUODENUM),
         ('small_bowel', SMALL_BOWEL), ('colon', COLON)]


def build(name='chestabdopelvis'):
    import trimesh
    h = json.loads((MODELS / name / f'{name}.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    s = float(h['spacing'][0])
    mat = np.fromfile(MODELS / name / f'{name}.mat.bin', dtype=np.uint8).reshape(nz, ny, nx)
    ids = np.array([p[1] for p in PARTS])
    lumen = np.isin(mat, ids)
    # each gas voxel joins the part whose lumen is nearest (within 2 cm), so a gas-filled stretch of
    # colon is still colon
    _, (iz, iy, ix) = ndi.distance_transform_edt(~lumen, return_indices=True)
    near = mat[iz, iy, ix]
    dist = ndi.distance_transform_edt(~lumen) * s
    owner = np.where(lumen, mat, np.where((mat == GAS) & (dist < 20), near, 0))
    centre = np.array([nx, ny, nz]) * s / 2.0
    scene = trimesh.Scene()
    for part, mid in PARTS:
        mask = owner == mid
        if mask.sum() < 50:
            continue
        mask = ndi.binary_closing(mask, iterations=1)
        lab, n = ndi.label(mask)
        if n > 1:                                     # specks of mislabel: the part's own pieces only
            sz = ndi.sum(mask, lab, range(1, n + 1))
            keep = np.zeros(n + 1, bool); keep[1:] = sz * s ** 3 >= 500.0
            mask = keep[lab]
        m = surface(mask, s, step=2, sigma_vox=0.8, taubin=8)          # 4 mm triangles: a prop, not a measurement
        m.vertices -= centre
        scene.add_geometry(m, node_name=part, geom_name=part)
        print(f'{part:12s} {len(m.faces):7d} faces')
    out = MODELS / name / f'{name}_gi.glb'
    scene.export(str(out))
    print(out.name, f'{out.stat().st_size / 1e6:.1f} MB')


if __name__ == '__main__':
    build()
