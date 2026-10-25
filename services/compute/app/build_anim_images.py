"""Small radiographs for the films' image chapters, projected from the shipped voxel models.

    python -m app.build_anim_images            # -> apps/web/public/anim/<name>_pa.png

Each is the model's attenuation summed front to back (mu at about 50 keV per material, the
model's own voxels), stored as the log of the transmission in 8 bits: what a detector's raw
values are proportional to, before any processing. The films place, histogram and window them.
"""
from __future__ import annotations

import json

import numpy as np

from app.build_limbs import MODELS

OUT = MODELS.parent / 'anim'
# linear attenuation (cm^-1) near 50 keV by material id; anything not listed is soft tissue
MU = {0: 0.0, 1: 0.06, 2: 0.19, 7: 0.22, 10: 0.22, 16: 0.24, 17: 0.40, 18: 0.65, 23: 0.22, 47: 0.0}
JOBS = {'hand': (96, 'y')}           # model: (output width in pixels, the beam's axis)


def build(name, width, axis):
    from PIL import Image
    h = json.loads((MODELS / name / f'{name}.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    s = float(h['spacing'][0]) / 10.0                     # cm per voxel
    mat = np.fromfile(MODELS / name / f'{name}.mat.bin', dtype=np.uint8).reshape(nz, ny, nx)
    lut = np.full(256, 0.22, np.float32)
    for k, v in MU.items():
        lut[k] = v
    mu = lut[mat]
    path = mu.sum(axis={'z': 0, 'y': 1, 'x': 2}[axis]) * s  # (z, x) for a y beam: rows along the limb
    img = path[::-1]                                       # fingers at the top
    hgt = int(round(width * img.shape[0] / img.shape[1]))
    # area-average down to the film's size
    im = Image.fromarray(img.astype(np.float32), mode='F').resize((width, hgt), Image.BOX)
    a = np.asarray(im)
    lo, hi = 0.0, float(np.percentile(a, 99.8))
    q = np.clip((a - lo) / (hi - lo), 0, 1)
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray((q * 255).round().astype(np.uint8), mode='L').save(OUT / f'{name}_pa.png', optimize=True)
    print(f'{name}_pa.png {width}x{hgt}, path {lo:.2f}-{hi:.2f} cm^-1 x cm')


if __name__ == '__main__':
    for n, (w, ax) in JOBS.items():
        build(n, w, ax)
