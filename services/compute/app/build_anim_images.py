"""Small radiographs for the films' image chapters, projected from the shipped voxel models.

    python -m app.build_anim_images            # -> apps/web/public/anim/<name>_pa.png
    python -m app.build_anim_images ct         # -> apps/web/public/anim/ct_*.png (see build_ct)

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


"""The CT film's images (python -m app.build_anim_images ct). Material ids, not greys: the film
turns them into Hounsfield units itself (the app's own legend, core/materials.js), so it can
enhance the vessels phase by phase, add the noise, window them, and project them into a
sinogram. All are in display orientation: axial seen from the feet (the patient's right on the
left, anterior up), coronal from the front, sagittal from the patient's left (anterior left),
head up.
  ct_ax_abd.png    axial, upper abdomen (liver, spleen, stomach, pancreas, kidneys, aorta, portal vein)
  ct_ax_chest.png  axial, the heart and lungs
  ct_ax_head.png   axial, the head through the brain (head & neck model, cropped to the head)
  ct_cor.png       coronal through the aorta;  ct_sag.png  sagittal through the spine
  ct_stack.png     24 axial slices, head to feet, at half resolution, in a 6 x 4 sheet
  ct_scout.png     the AP topogram: attenuation summed front to back, as hand_pa.png
Volume axes: x toward the patient's right, y anterior, z toward the head."""
CT_CUTS = {'abd': 166, 'chest': 236}


def _save_ids(a, path):
    from PIL import Image
    Image.fromarray(np.ascontiguousarray(a).astype(np.uint8), mode='L').save(path, optimize=True)


def build_ct():
    from PIL import Image
    name = 'chestabdopelvis'
    h = json.loads((MODELS / name / f'{name}.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    mat = np.fromfile(MODELS / name / f'{name}.mat.bin', dtype=np.uint8).reshape(nz, ny, nx)
    OUT.mkdir(parents=True, exist_ok=True)
    ax = lambda z: mat[z][::-1, ::-1]                       # rows anterior first, columns right first
    for k, z in CT_CUTS.items():
        _save_ids(ax(z), OUT / f'ct_ax_{k}.png')
    # coronal through the aorta's mean depth; sagittal through the vertebral bodies' midline
    zz, yy, xx = np.nonzero(mat == 29)
    yc = int(round(yy.mean()))
    _save_ids(mat[:, yc, :][::-1, ::-1], OUT / 'ct_cor.png')
    zz, yy, xx = np.nonzero(mat == 18)
    xc = int(round(np.median(xx)))
    _save_ids(mat[:, :, xc][::-1, ::-1], OUT / 'ct_sag.png')
    # the stack: 24 slices, head first, every ~15 mm, nearest-neighbour halved
    zs = np.linspace(nz - 8, 6, 24).round().astype(int)
    tiles = [ax(z)[::2, ::2] for z in zs]
    th, tw = tiles[0].shape
    sheet = np.zeros((th * 4, tw * 6), np.uint8)
    for i, t in enumerate(tiles):
        sheet[(i // 6) * th:(i // 6 + 1) * th, (i % 6) * tw:(i % 6 + 1) * tw] = t
    _save_ids(sheet, OUT / 'ct_stack.png')
    # the topogram
    lut = np.full(256, 0.22, np.float32)
    for k, v in MU.items():
        lut[k] = v
    path = lut[mat].sum(axis=1) * (float(h['spacing'][0]) / 10.0)   # (z, x)
    img = path[::-1, ::-1]
    q = np.clip(img / float(np.percentile(img, 99.8)), 0, 1)
    Image.fromarray((q * 255).round().astype(np.uint8), mode='L').save(OUT / 'ct_scout.png', optimize=True)
    # the head: the head & neck model through the brain, cropped round the skull
    name = 'headneck'
    h = json.loads((MODELS / name / f'{name}.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    m2 = np.fromfile(MODELS / name / f'{name}.mat.bin', dtype=np.uint8).reshape(nz, ny, nx)
    s = m2[190]
    ys, xs = np.nonzero(s != 0)
    s = s[max(0, ys.min() - 6):ys.max() + 7, max(0, xs.min() - 6):xs.max() + 7]
    _save_ids(s[::-1, ::-1], OUT / 'ct_ax_head.png')
    print('ct images:', ', '.join(sorted(p.name for p in OUT.glob('ct_*.png'))), f'(coronal y {yc}, sagittal x {xc})')


if __name__ == '__main__':
    import sys
    if sys.argv[1:] == ['ct']:
        build_ct()
    else:
        for n, (w, ax) in JOBS.items():
            build(n, w, ax)
