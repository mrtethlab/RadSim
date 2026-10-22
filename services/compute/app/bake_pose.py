"""Bake a limb model into the anatomical position.

    python -m app.bake_pose lowerextremity upperextremity      # after app.build_limbs

The CTs were taken as the patients lay: z045's foot 75 degrees plantarflexed (post mortem), z053's
forearm turned thumb forward, a little past neutral. A limb is taught, and its films are named,
from the anatomical position: the foot at 90 degrees to the leg, the palm up. So the volume itself
is posed once, with the app's own joint code (tools/pose_volume.mjs on core/jointPose.js) and
the joints as measured on the scan; every room (x-ray, CT, fluoroscopy) then shows the same
patient, and the joint sliders start from the anatomical zero.

Steps, per model: measure its landmarks, palpation points, centring points and joints (the bake
turns about those joints); pose; lay a fresh skin shell (the crease and the fold moved it); crop,
write, rebuild the smooth skin; measure everything again on the baked model.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile

import numpy as np
from scipy import ndimage as ndi

from app.build_model import AIR, FAT, SKIN, write_model
from app.build_limbs import MODELS, ROOT, SP, skin

# the anatomical angles each model is baked to (the motions' rest is the scan's own), in stages,
# re-measured between: the foot is first brought square to the leg, then turned toes up (the turn
# is about the leg's axis, which only then is the foot's vertical)
BAKE = {
    'lowerextremity': [{'ankle.flex': 0}, {'ankle.roll': 0}],
    'upperextremity': [{'elbow.roll': 0}],
}
TOOLS = ROOT / 'tools'


def measure(only=None):
    py = sys.executable
    subprocess.run([py, str(TOOLS / 'measure_landmarks.py')] + ([only] if only else []), check=True, cwd=ROOT, stdout=subprocess.DEVNULL)
    for t in ('measure_palpation.py', 'measure_centring.py', 'measure_joints.py'):
        subprocess.run([py, str(TOOLS / t)], check=True, cwd=ROOT, stdout=subprocess.DEVNULL)


def bake(name):
    for stage in BAKE[name]:
        pose(name, stage)
    measure(name)
    print(f'{name}: baked {BAKE[name]}')


def pose(name, angles):
    measure(name)
    d = MODELS / name
    h = json.loads((d / f'{name}.model.json').read_text(encoding='utf-8'))
    with tempfile.TemporaryDirectory() as tmp:
        out = pathlib.Path(tmp) / 'posed.bin'
        subprocess.run(['node', str(TOOLS / 'pose_volume.mjs'), name, json.dumps(angles), str(out)], check=True, cwd=ROOT)
        nx, ny, nz = json.loads(out.with_suffix('.bin.json').read_text())['dims']
        v = np.fromfile(out, np.uint8).reshape(nz, ny, nx)
    # a fresh skin: the crease turned some of the old shell inward, and the fold left cut faces bare
    keep = v != AIR
    v[(v == SKIN) & ndi.binary_erosion(keep)] = FAT
    v[keep & ~ndi.binary_erosion(keep)] = SKIN
    zs, ys, xs = np.nonzero(keep)
    pad = 4
    v = v[max(0, zs.min() - pad):zs.max() + pad + 1, max(0, ys.min() - pad):ys.max() + pad + 1,
          max(0, xs.min() - pad):xs.max() + pad + 1]
    write_model(str(d), name, h['name'], v, np.array(h['huReference'], np.int16), SP, mesh=True, source=h['source'])
    skin(name)


if __name__ == '__main__':
    for n in sys.argv[1:] or list(BAKE):
        bake(n)
