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


"""The surgical films' images (python -m app.build_anim_images surg): what the C-arm's monitor
shows as the C turns, for the four procedure films (anim/films/surg/kit.js reads them back).

Each REGION is a set of projections round one isocentre, on a grid of the fluoroscopy suite's own
C-arm angles (anim/films/fluoro/suite.js setPose): `orbital` turns the beam about the patient's
long axis (0 straight up through the table, 90 a lateral), `tilt` about the table's cross axis
(+ the receptor toward the head). The patient lies as the films lay the meshes, in the films'
frame (cm, the room's axes: x across the table, y up, z toward the head): the child (pediatric,
11 y) prone, its mesh as it is (the volume is LPS: +x the patient's left, +y posterior), the adult
(chest/abdomen/pelvis, now with its thighs) supine (+x the patient's right, +y anterior; its mesh
moved CAP_FOOT slices down, capFrame.js). For a pose the beam runs along
d = (sin o, cos o cos t, cos o sin t), the image's right is -x of the C and its up +z of the C:
   U = (-cos o, sin o cos t, sin o sin t),   V = (0, -sin t, cos t)
so a prone child's AP shows its right on the right (seen from behind, as the operator sees it), a
supine adult's its right on the left (as a radiograph is viewed). Projections are parallel: the
film draws its needles onto them by the same U and V. Each pixel is the attenuation summed along
d (mu near 50 keV, MU), stored in 8 bits of the region's `scale`; with each frame its window [lo,
hi] (the 3rd and 99.7th percentiles of the body inside the central disc: the console's brightness
control, which meters the patient, not the air beside a neck).
The child's arms, which hang at its sides, are left out (the trunk only) so a lateral is the
spine's, not the forearms'.

  surg_<region>.png    the frames in a sheet, `cols` to a row, in the manifest's order
  surg_x_<crop>.png    a tissue crop for the cross-section panel: tissue codes (SURG_TISSUE) per
                       voxel, its z slices (head first) in a sheet `cols` to a row, each slice
                       as the volume stores it (row the y index, column the x index)
  surg.json            the manifest: regions (model, centre, span, n, scale, cols, frames
                       [[orbital, tilt, lo, hi], ...], grid) and crops (origin cm of voxel 0's
                       centre, voxel cm, dims [nx, ny, nz], cols)

The tissue crops add what the CT's materials do not separate, from where they lie: the soft tissue
in the spinal canal is the thecal sac (its rim the dura, inside it CSF, its core the cord above
the conus and nerve roots of the cauda equina below it); a 3 mm rim round the sac that is not
bone is the epidural space, and the next 3 mm behind it, between the laminae, the ligamentum
flavum; round the hip, the non-bone within 4 mm of the femoral head and the acetabulum is the
joint (synovial fluid) and the next 4 mm the capsule."""
SURG_TISSUE = ['air', 'skin', 'fat', 'muscle', 'soft', 'cortex', 'marrow', 'disc', 'flavum', 'epidural',
               'dura', 'csf', 'nerve', 'capsule', 'joint', 'vessel', 'lung']
SURG_REGIONS = {
    # L3-L5 round L4: AP to 45 degrees oblique at -10..25 tilt (the Scottie dog, endplates
    # flattened: L3 at 0, L4 at about 8, L5 at about 23 in this child), and on to the lateral
    'lumbar': dict(model='pediatric', centre=(0.0, 0.0, 14.25), span=15.0,
                   grids=[(list(range(0, 46, 3)), list(range(-10, 26, 5))), (list(range(48, 91, 3)), [0])]),
    # C3-C6 round C4-C5 (a magnified field): oblique to 48 degrees at -15..30 tilt, and on to the
    # lateral. The neck's soft tissue counts for little (soft): the child's neck is grafted from an
    # adult's, its vertebrae fainter than the trunk's, and its boxy outline and the shoulders would
    # otherwise outshine them
    'cervical': dict(model='pediatric', centre=(0.1, 1.0, 50.5), span=8.0, soft=0.08,
                     grids=[(list(range(0, 49, 4)), list(range(-15, 31, 5))), (list(range(52, 91, 4)), [0])]),
    # S1-S3 and L5 above them: near AP, -15..39 tilt (the foramina in line, the ala clear of L5)
    'sacrum': dict(model='pediatric', centre=(0.0, 3.0, 8.0), span=13.0,
                   grids=[(list(range(-8, 9, 4)), list(range(-15, 40, 3))), ([90], [0])]),
    # the adult's right hip round the femoral head (landmarks.json femoralHeadR), near AP
    'hip': dict(model='cap', centre=(8.9, -2.8, -27.2), span=16.0,
                grids=[(list(range(-20, 21, 5)), list(range(-10, 11, 5)))]),
}
SURG_N = 128                          # pixels across a frame
SURG_CROPS = {
    # the child's lumbar spine and sacrum (S4 to T12), the cervical spine (C2 to T1), the adult's right hip:
    # centre (cm, the films' frame), half sizes (cm)
    'lspine': dict(model='pediatric', centre=(0.0, 1.5, 12.0), half=(8.0, 8.5, 12.0)),
    'cspine': dict(model='pediatric', centre=(0.1, 1.5, 50.5), half=(6.5, 7.5, 6.5)),
    'hip': dict(model='cap', centre=(8.9, 2.0, -27.2), half=(6.0, 9.5, 6.0)),
}


def _surg_model(model):
    """(materials (z, y, x), voxel cm, a function cm (films' frame) -> voxel index (x, y, z))"""
    name = 'pediatric' if model == 'pediatric' else 'chestabdopelvis'
    h = json.loads((MODELS / name / f'{name}.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    sp = float(h['spacing'][0])
    mat = np.fromfile(MODELS / name / f'{name}.mat.bin', dtype=np.uint8).reshape(nz, ny, nx)
    # the mesh's vertex at voxel i is i * sp - n * sp / 2 (mm, build_skin); the CAP's is then moved
    # down CAP_FOOT slices' half (capFrame.js CAP_SHIFT_MM)
    dz = CAP_FOOT * 2 / 2 if model == 'cap' else 0.0
    half = np.array([nx, ny, nz], float) * sp / 2

    def index(p):
        """cm (3,) or (3, N) -> voxel x, y, z (fractional)"""
        p = np.asarray(p, float)
        off = (half + [0.0, 0.0, dz]).reshape((3,) + (1,) * (p.ndim - 1))
        return (p * 10.0 + off) / sp
    return mat, sp / 10.0, index, half, dz


def _trunk_only(mat, zs, x0, x1):
    """the child's arms out of slices zs: they hang beside the trunk, touching it along the flank
    (no cut by shape parts them everywhere), and lie wholly outside x0..x1 (voxels: the trunk's
    widest, the iliac crests, is inside it); outside is set to air, then any piece of a slice
    not joined to the trunk (the piece on the midline)"""
    from scipy import ndimage as ndi
    xm = (x0 + x1) // 2
    for z in zs:
        mat[z][:, :x0] = 0
        mat[z][:, x1 + 1:] = 0
        lab, n = ndi.label(mat[z] != 0)
        if n < 2:
            continue
        mid = [i for i in np.unique(lab[:, xm]) if i]
        keep = np.zeros(n + 1, bool)
        keep[mid] = True
        mat[z][~keep[lab]] = 0


def _surg_drr(mu, sp, index, centre, span, o, t, n=SURG_N, L=24.0, ds=0.1):
    from scipy import ndimage as ndi
    o, t = np.radians(o), np.radians(t)
    d = np.array([np.sin(o), np.cos(o) * np.cos(t), np.cos(o) * np.sin(t)])
    U = np.array([-np.cos(o), np.sin(o) * np.cos(t), np.sin(o) * np.sin(t)])
    V = np.array([0.0, -np.sin(t), np.cos(t)])
    k = (np.arange(n) + 0.5) / n * span - span / 2
    s = np.arange(-L, L + 1e-6, ds)
    out = np.zeros((n, n), np.float32)
    c = np.asarray(centre, float)
    for r0 in range(0, n, 16):
        rows = k[::-1][r0:r0 + 16]                                   # image row 0 at the top (+V)
        P = (c[None, None, None, :] + rows[:, None, None, None] * V + k[None, :, None, None] * U
             + s[None, None, :, None] * d)                           # (rows, cols, samples, 3) cm
        I = index(P.reshape(-1, 3).T)                                # (3, N) voxel x, y, z
        v = ndi.map_coordinates(mu, [I[2], I[1], I[0]], order=1, mode='constant', cval=0.0)
        out[r0:r0 + len(rows)] = v.reshape(len(rows), n, len(s)).sum(axis=2) * ds
    return out


def _surg_tissue(model, mat, sp, index, crop):
    """the crop's tissue codes (z, y, x) and the index of its first voxel"""
    from scipy import ndimage as ndi
    c, hf = np.asarray(crop['centre'], float), np.asarray(crop['half'], float)
    lo = np.floor(index(c - hf)).astype(int)
    hi = np.ceil(index(c + hf)).astype(int)
    nz, ny, nx = mat.shape
    lo = np.maximum(lo, 0); hi = np.minimum(hi, [nx - 1, ny - 1, nz - 1])
    m = mat[lo[2]:hi[2] + 1, lo[1]:hi[1] + 1, lo[0]:hi[0] + 1]
    T = {k: i for i, k in enumerate(SURG_TISSUE)}
    lut = np.full(256, T['soft'], np.uint8)
    for ids, k in (([0, 47], 'air'), ([23], 'skin'), ([2], 'fat'), ([7], 'muscle'), ([18], 'cortex'),
                   ([17] + list(range(54, 62)), 'marrow'), ([16], 'disc'), ([1], 'lung'),
                   ([8] + list(range(29, 47)), 'vessel')):
        lut[ids] = T[k]
    out = lut[m]
    bone = np.isin(m, [17, 18] + list(range(54, 62)))
    ball = lambda r: (lambda g: (g ** 2).sum(0) <= r * r)(np.mgrid[-r:r + 1, -r:r + 1, -r:r + 1])
    if model == 'pediatric':
        # the thecal sac: the canal's soft tissue, the pieces of it on the midline behind the bodies
        soft = m == 10
        lab, n = ndi.label(soft)
        xm = int(round(index(np.array([0.0, 0, 0]))[0])) - lo[0]
        sizes = ndi.sum(np.ones_like(lab), lab, range(1, n + 1))
        mid = np.unique(lab[:, :, max(0, xm - 2):xm + 3])
        keep = [i for i in mid if i and sizes[i - 1] > 400]
        sac = np.isin(lab, keep)
        r2, r4 = ndi.binary_dilation(sac, ball(2)), ndi.binary_dilation(sac, ball(4))
        epi = r2 & ~sac & ~bone
        # behind the sac (+y is posterior in the child's volume), within the interlaminar window
        yc = np.array([np.nonzero(sac[z].any(1))[0].mean() if sac[z].any() else 0 for z in range(sac.shape[0])])
        post = np.arange(sac.shape[1])[None, :, None] > yc[:, None, None]
        xx = np.abs(np.arange(sac.shape[2]) - xm)[None, None, :] <= 7
        flav = r4 & ~r2 & ~bone & post & xx & (out != T['air']) & (out != T['skin'])
        out[epi & (out != T['air'])] = T['epidural']
        out[flav] = T['flavum']
        dist = ndi.distance_transform_edt(sac)
        out[sac] = T['csf']
        out[sac & (dist <= 1.0)] = T['dura']
        # the cord above the conus (L1-L2: the child's z 10 cm up from L4, here z idx 605), roots below
        zi = np.arange(sac.shape[0])[:, None, None] + lo[2]
        g = np.indices(sac.shape)
        roots = ((g[2] * 7 + g[1] * 3 + g[0] // 3 * 5) % 9 == 0)
        out[sac & (dist >= 2.0) & ((zi >= 605) | roots)] = T['nerve']
    else:
        # the hip: round the femoral head (the crop's centre in x and z, the region's in y)
        hc = index(np.array(SURG_REGIONS['hip']['centre'])) - lo
        g = np.indices(out.shape).astype(float)
        R = np.sqrt((g[2] - hc[0]) ** 2 + (g[1] - hc[1]) ** 2 + (g[0] - hc[2]) ** 2) * sp
        near = bone & (R < 3.6)
        j = ndi.binary_dilation(near, ball(2)) & ~bone & (R < 4.0)
        cap = ndi.binary_dilation(near, ball(4)) & ~bone & ~j & (R < 4.6)
        out[cap & (out != T['air'])] = T['capsule']
        out[j & (out != T['air'])] = T['joint']
    return out, lo


def build_surg():
    from PIL import Image
    OUT.mkdir(parents=True, exist_ok=True)
    lut = np.full(256, 0.22, np.float32)
    for k, v in MU.items():
        lut[k] = v
    for k in range(54, 62):
        lut[k] = 0.40
    # bowel gas as soft tissue: its bright pockets over the sacrum and the lumbar spine read like
    # foramina; the films show the bones as a prepared bowel would let them be seen
    lut[47] = 0.20
    man = {'tissue': SURG_TISSUE, 'n': SURG_N, 'regions': {}, 'crops': {}}
    cache = {}
    for model in ('pediatric', 'cap'):
        mat, sp, index, half, dz = _surg_model(model)
        if model == 'pediatric':
            # the trunk only, from the thighs to the lower ribs (the arms hang beside it), within
            # 15.5 cm of the midline
            lo_, hi_ = index(np.array([-15.5, 0, -12.0])), index(np.array([15.5, 0, 26.0]))
            _trunk_only(mat, range(int(lo_[2]), int(hi_[2])), int(np.ceil(lo_[0])), int(hi_[0]))
        mu = lut[mat]
        for name, R in SURG_REGIONS.items():
            if R['model'] != model:
                continue
            mu_r = mu
            if R.get('soft'):
                # everything but bone and cartilage at most `soft` per cm
                l2 = lut.copy()
                keep = [0, 16, 17, 18] + list(range(54, 62))
                for k in range(256):
                    if k not in keep:
                        l2[k] = min(l2[k], R['soft'])
                mu_r = l2[mat]
            frames, imgs = [], []
            for os_, ts in R['grids']:
                for o in os_:
                    for t in ts:
                        a = _surg_drr(mu_r, sp, index, R['centre'], R['span'], o, t)
                        imgs.append(a); frames.append([o, t])
            n = SURG_N
            yy, xx = np.mgrid[:n, :n]
            disc = (xx + 0.5 - n / 2) ** 2 + (yy + 0.5 - n / 2) ** 2 <= (0.8 * n / 2) ** 2
            scale = float(max(np.percentile(a, 99.95) for a in imgs)) * 1.02
            cols = 16
            rows = (len(imgs) + cols - 1) // cols
            sheet = np.zeros((rows * n, cols * n), np.uint8)
            for i, a in enumerate(imgs):
                q = np.clip(a / scale, 0, 1)
                sheet[(i // cols) * n:(i // cols + 1) * n, (i % cols) * n:(i % cols + 1) * n] = (q * 255).round()
                # the window: the body's own range (the air past a narrow neck left to go white)
                body = a[disc & (a > 0.25 * float(a.max()))]
                lo_, hi_ = np.percentile(body if body.size > 50 else a[disc], [3, 99.7])
                frames[i] += [round(float(lo_), 3), round(float(hi_), 3)]
            Image.fromarray(sheet, mode='L').save(OUT / f'surg_{name}.png', optimize=True)
            man['regions'][name] = dict(model=model, centre=list(R['centre']), span=R['span'], n=n, scale=round(scale, 4),
                                        cols=cols, file=f'surg_{name}.png', frames=frames,
                                        grids=[[g[0], g[1]] for g in R['grids']])
            print(f'surg_{name}.png {len(imgs)} frames, scale {scale:.2f}, '
                  f'{(OUT / f"surg_{name}.png").stat().st_size // 1024} kB')
            del mu_r
        for name, C in SURG_CROPS.items():
            if C['model'] != model:
                continue
            tis, lo = _surg_tissue(model, mat, sp, index, C)
            nz_, ny_, nx_ = tis.shape
            cols = 12
            rows = (nz_ + cols - 1) // cols
            sheet = np.zeros((rows * ny_, cols * nx_), np.uint8)
            for i in range(nz_):
                z = nz_ - 1 - i                                    # head first
                sheet[(i // cols) * ny_:(i // cols + 1) * ny_, (i % cols) * nx_:(i % cols + 1) * nx_] = tis[z]
            Image.fromarray(sheet, mode='L').save(OUT / f'surg_x_{name}.png', optimize=True)
            # voxel 0's centre in the films' frame (cm): the mesh's vertex at index i is i * sp - half
            origin = (lo * sp * 10 - half - np.array([0, 0, dz])) / 10
            man['crops'][name] = dict(model=model, file=f'surg_x_{name}.png', origin=[round(float(v), 4) for v in origin],
                                      voxel=round(sp, 4), dims=[nx_, ny_, nz_], cols=cols)
            print(f'surg_x_{name}.png {nx_}x{ny_}x{nz_}, {(OUT / f"surg_x_{name}.png").stat().st_size // 1024} kB')
        del mu, mat
    (OUT / 'surg.json').write_text(json.dumps(man, separators=(',', ':')), encoding='utf-8')
    print('surg.json', (OUT / 'surg.json').stat().st_size // 1024, 'kB')


if __name__ == '__main__':
    import sys
    if sys.argv[1:] == ['ct']:
        build_ct()
    elif sys.argv[1:2] == ['surg']:
        build_surg()
    else:
        for n, (w, ax) in JOBS.items():
            build(n, w, ax)
        build_cap()
