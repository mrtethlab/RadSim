"""Small radiographs for the films' image chapters, projected from the shipped voxel models.

    python -m app.build_anim_images            # -> apps/web/public/anim/<name>_pa.png,
                                               #    cap_ap.png and cap_ap_art.png (the fluoro film)
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
  ct_ax_head.png   axial, the head through the brain (head & neck model, cropped to the head;
                   its voxels 1.5 mm)
  ct_ax_metal.png  the app's metal test phantom, axial across its middle (1 mm voxels)
  ct_cor.png       coronal through the aorta;  ct_sag.png  sagittal through the spine
  ct_stack.png     24 axial slices, head to feet, at half resolution, in a 6 x 4 sheet
  ct_scout.png     the AP topogram: attenuation summed front to back, as hand_pa.png
  ct_ax_pelvis.png axial through the femoral heads;  ct_ax_shoulder.png  through the shoulders
  ct_slab.png      the lower chest's consecutive axial slices (every 2 mm voxel, z CT_SLAB, head
                   first), in a 7 x 7 sheet: the film averages them into thick slices, interpolates
                   between them along z (helical windmill) and samples them along tilted rays
                   (cone beam)
Volume axes: x toward the patient's right, y anterior, z toward the head."""
CT_CUTS = {'abd': 166, 'chest': 236, 'pelvis': 24, 'shoulder': 340}
CT_SLAB = (252, 204)                  # z from, z to (inclusive, head first): 49 slices
# the CAP grew 15 cm of thigh at its foot (build_cap_thighs.ADD_SLICES): the films were laid out on
# the volume above it, and every z here counts from where it began (anim/films/capFrame.js)
CAP_FOOT = 75


def _cap(h):
    """the CAP's materials (z, y, x) from where the films' volume began"""
    nx, ny, nz = h['dims']
    mat = np.fromfile(MODELS / 'chestabdopelvis' / 'chestabdopelvis.mat.bin', dtype=np.uint8).reshape(nz, ny, nx)
    return mat[CAP_FOOT:]


def _save_ids(a, path):
    from PIL import Image
    Image.fromarray(np.ascontiguousarray(a).astype(np.uint8), mode='L').save(path, optimize=True)


def build_ct():
    from PIL import Image
    name = 'chestabdopelvis'
    h = json.loads((MODELS / name / f'{name}.model.json').read_text(encoding='utf-8'))
    mat = _cap(h)
    nz, ny, nx = mat.shape
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
    # the slab: every slice from CT_SLAB[0] down to CT_SLAB[1], full resolution, 7 to a row
    zs = range(CT_SLAB[0], CT_SLAB[1] - 1, -1)
    tiles = [ax(z) for z in zs]
    th, tw = tiles[0].shape
    sheet = np.zeros((th * 7, tw * 7), np.uint8)
    for i, t in enumerate(tiles):
        sheet[(i // 7) * th:(i // 7 + 1) * th, (i % 7) * tw:(i % 7 + 1) * tw] = t
    _save_ids(sheet, OUT / 'ct_slab.png')
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
    # the app's metal test phantom (acrylic box, water, three lead rods; 1 mm voxels) across its middle
    name = 'metalphantom'
    h = json.loads((MODELS / name / f'{name}.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    m3 = np.fromfile(MODELS / name / f'{name}.mat.bin', dtype=np.uint8).reshape(nz, ny, nx)
    _save_ids(m3[nz // 2][::-1, ::-1], OUT / 'ct_ax_metal.png')
    print('ct images:', ', '.join(sorted(p.name for p in OUT.glob('ct_*.png'))), f'(coronal y {yc}, sagittal x {xc})')


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
    s = float(h['spacing'][0]) / 10.0
    mat = _cap(h)
    nz, ny, nx = mat.shape
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
    import sys
    if sys.argv[1:] == ['ct']:
        build_ct()
    else:
        for n, (w, ax) in JOBS.items():
            build(n, w, ax)
        build_cap()
