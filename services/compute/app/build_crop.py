"""Models cut from another model: the foot from the lower extremity.

    python -m app.build_crop foot          # after app.bake_pose lowerextremity

A crop is the shipped (baked, joint-cut) source volume cut by a box: the same voxels, the same
patient, so nothing is measured again. Its joints, landmarks, palpation and centring points are
the source's, shifted into the crop's frame and kept where the box holds them; the app derives
them at load from apps/web/src/data/crops.json (core/crops.js), so a re-measured source carries
its crops with it.

The frames (tools/measure_palpation.py Vol, app.js landmarkLocal): a point is cm from the volume
centre, voxel centres at (i - (n-1)/2) * spacing. The REST frame (joints, palpation, centring)
mirrors x and y of the stored volume (the x-ray voxelFlips); the VOLUME frame (landmarks.json)
does not. Cutting [lo, lo+m) from n voxels moves a stored point by -(lo + (m-n)/2) * spacing, and
a mirrored axis's point by the same amount, the other way.
"""
from __future__ import annotations

import json
import sys

import numpy as np

from app.build_model import AIR, write_model
from app.build_limbs import MODELS, ROOT, skin

DATA = ROOT / 'apps' / 'web' / 'src' / 'data'
# ROLLED_180 (app.js, measure_palpation.py) turns these the other way; a crop of one would too
ROLLED_180 = {'chestabdopelvis', 'headneck'}


def foot_top(joints):
    """the foot and the distal third of the tibia and fibula: a third of the way from the ankle
    joint to the knee's (rest-frame z, cm)"""
    a, k = joints['ankle']['c'][2], joints['knee']['c'][2]
    return a + (k - a) / 3.0


CROPS = {
    'foot': dict(of='lowerextremity', title='Foot', top=foot_top),
}


def build(name, pad=4):
    cfg = CROPS[name]
    src = cfg['of']
    d = MODELS / src
    h = json.loads((d / f'{src}.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    sp = float(h['spacing'][0])                                   # mm
    mat = np.fromfile(d / f'{src}.mat.bin', np.uint8).reshape(nz, ny, nx)
    joints = json.loads((DATA / 'joints.json').read_text(encoding='utf-8'))[src]
    z_top = cfg['top'](joints)                                    # cm, rest frame (z is not mirrored)
    k_top = int(round(z_top * 10 / sp + (nz - 1) / 2))
    keep = mat[:k_top + 1] != AIR
    zs, ys, xs = np.nonzero(keep)
    lo = np.array([max(0, xs.min() - pad), max(0, ys.min() - pad), max(0, zs.min() - pad)])
    hi = np.array([min(nx, xs.max() + pad + 1), min(ny, ys.max() + pad + 1), k_top + 1])
    part = np.ascontiguousarray(mat[lo[2]:hi[2], lo[1]:hi[1], lo[0]:hi[0]])
    m, n = hi - lo, np.array([nx, ny, nz])
    move = -(lo + (m - n) / 2.0) * sp / 10.0                       # cm, volume frame (x, y, z)
    mirror = [False, False, False] if src in ROLLED_180 else [True, True, False]
    rest = [-v if f else v for v, f in zip(move, mirror)]
    hu = np.array(h['huReference'], np.int16)
    write_model(str(MODELS / name), name, cfg['title'], part, hu, sp, mesh=True,
                source=h['source'] + f' · cut from the {h["name"].lower()}')
    skin(name)
    p = DATA / 'crops.json'
    crops = json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}
    crops[name] = dict(of=src, rest=[round(float(v), 3) for v in rest],
                       volume=[round(float(v), 3) for v in move],
                       # what the box holds, in the source's rest frame (cm): a point outside it
                       # (the knee, the hip) is not the crop's
                       z=[round(float((lo[2] - (nz - 1) / 2) * sp / 10), 2), round(float((hi[2] - 1 - (nz - 1) / 2) * sp / 10), 2)],
                       how=f'{cfg["title"]}: slices {lo[2]}..{hi[2] - 1} of {nz} (z up to {z_top:.1f} cm), '
                           f'y {lo[1]}..{hi[1] - 1}, x {lo[0]}..{hi[0] - 1}')
    p.write_text(json.dumps(crops, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'{name}: {m[0]}x{m[1]}x{m[2]} from {src}; rest shift {crops[name]["rest"]} cm')


if __name__ == '__main__':
    for n in sys.argv[1:] or list(CROPS):
        build(n)
