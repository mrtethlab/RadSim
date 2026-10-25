"""Small radiographs for the films' image chapters, projected from the shipped voxel models.

    python -m app.build_anim_images            # -> apps/web/public/anim/<name>_pa.png,
                                               #    cap_ap.png and cap_ap_art.png (the fluoro film)

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


# the fluoroscopy film's live image: the chest/abdomen/pelvis AP, with its gut and arteries apart so
# the film can fill them (barium, iodine) as it plays. Fixed scales (the film reads them back):
CAP_SCALE = {'base': 10.0, 'oesophagus': 2.5, 'stomach': 16.0, 'arteries': 8.0}   # mu x cm, then cm
ARTERIES = [29, 35, 36, 37, 38, 39, 43, 44]


def build_cap(width=240):
    """cap_ap.png: R the whole body's attenuation path (mu x cm, /10) with the gut's lumens at their
    unopacified value; G the oesophagus lumen's path length (cm, /2.5); B the stomach's and duodenum's
    (cm, /16). cap_ap_art.png: the arteries' path length (cm, /8). Rows head to feet, the patient's
    right on the image's left (as a radiograph is viewed); the beam along the model's AP axis (y)."""
    from PIL import Image
    name = 'chestabdopelvis'
    h = json.loads((MODELS / name / f'{name}.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    s = float(h['spacing'][0]) / 10.0
    mat = np.fromfile(MODELS / name / f'{name}.mat.bin', dtype=np.uint8).reshape(nz, ny, nx)
    lut = np.full(256, 0.22, np.float32)
    for k, v in MU.items():
        lut[k] = v
    base = lut[mat].sum(axis=1) * s                                   # (z, x)
    oes = (mat == 48).sum(axis=1) * s
    sto = np.isin(mat, [49, 50]).sum(axis=1) * s
    art = np.isin(mat, ARTERIES).sum(axis=1) * s
    hgt = int(round(width * nz / nx))

    def down(a):
        # z runs feet to head and x toward the patient's right (the liver's side): flip both
        a = np.ascontiguousarray(a[::-1, ::-1]).astype(np.float32)
        return np.asarray(Image.fromarray(a, mode='F').resize((width, hgt), Image.BOX))

    def q(a, k):
        return (np.clip(down(a) / CAP_SCALE[k], 0, 1) * 255).round().astype(np.uint8)

    rgb = np.dstack([q(base, 'base'), q(oes, 'oesophagus'), q(sto, 'stomach')])
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb, mode='RGB').save(OUT / 'cap_ap.png', optimize=True)
    Image.fromarray(q(art, 'arteries'), mode='L').save(OUT / 'cap_ap_art.png', optimize=True)
    print(f'cap_ap.png {width}x{hgt}, base max {base.max():.1f}, oesophagus {oes.max():.1f} cm, '
          f'stomach {sto.max():.1f} cm, arteries {art.max():.1f} cm')


if __name__ == '__main__':
    for n, (w, ax) in JOBS.items():
        build(n, w, ax)
    build_cap()
