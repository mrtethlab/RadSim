"""The Skull: the head at 0.6 mm, from VSD 037's head CT (SMIR.Head.062Y.F.CT.62918, 62 F, postmortem).

    python -m app.build_skull                    # everything (each stage is cached under data/vsd/037/skull)
    python -m app.build_skull --data D:/radsim-data   # the source CTs somewhere else

The source is not an ordinary CT series. It is a secondary capture written by Amira ("head masked"):
8-bit, 0.498 x 0.498 x 0.6 mm, and
- WINDOWED: a value v is about HU = v - 10 (calibrated on the same patient's thorax series, which
  overlaps it from C4 down and is real 16-bit HU: brain at v 45, cancellous bone of the vertebral
  bodies v 64-143 against 58-121 HU). Everything below about -10 HU is 0 (fat and air alike) and
  everything above about 245 HU is 255: the cortex, the diploe, the petrous bone and the teeth are
  one value;
- MASKED: only the bone (with a millimetre or two of what lies against it) and the inside of the
  cranium were kept. The scalp, the face, the eyes, the tongue and the neck are 0, like the air;
- with the brain left out of some twenty slices in four bands (the mask failed there), and the dental
  fillings' streaks across the occlusal plane.
What it gives at full resolution is the skeleton's shape (the skull, the mandible, the sinus walls,
the mastoid cells, the cervical vertebrae) and the brain. The rest is made:
- the soft tissue (scalp, face, orbits, tongue, neck, airway) is TotalSegmentator s1082's (the head
  and neck model's CT, real HU at 1.5 mm), registered onto this skeleton (affine, then a B-spline on
  the two skeletons) and resampled here; where it has bone and this skull does not, soft tissue;
- the bone's density from its depth (the source has none above 245 HU): the outer 1.2 mm of
  saturated bone is cortex (Bone 1500 HU: the tables, the facial plates, the vertebral shells), the
  next 1.8 mm diploe (Bone 700 HU), deeper than 3 mm the dense cores (petrous, Bone 1150 HU); bone
  below saturation keeps its own HU (Bone 200 HU, or the marrow's soft-tissue HU);
- across the fillings' streak band the jaws and teeth are TotalSegmentator's outline of them (it read
  the arch and the rami through the streaks), and the crowns in the dental arch enamel over dentin;
- the air: the sinuses and mastoid cells where the source's zeros are walled by bone in 24 of 26
  directions, the nasal cavity, mouth and pharynx where the registered s1082 has air;
- the brain's holes filled from the slices either side.
House convention, as the source has it (DICOM LPS with identity direction): x = patient LEFT,
y = POSTERIOR, z = SUPERIOR, index 0 inferior; no flip. The head is then turned square
(straighten): the ear canals level across, the OML square to the long axis.
"""
from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys
import time

import numpy as np
import SimpleITK as sitk
from scipy import ndimage as ndi

from app.build_model import (AIR, FAT, MUSCLE, SOFT, CSF, SKIN, ENAMEL, write_model, ts_class_map)

ROOT = pathlib.Path(__file__).resolve().parents[3]
MODELS = ROOT / 'apps' / 'web' / 'public' / 'models'
NAME, TITLE = 'skull', 'Skull'
SP = 0.6                                   # mm: the source's slice spacing (0.5 in plane)
SOURCE = ('VSD 037 head CT (SMIR.Head.062Y.F.CT.62918, 62F, postmortem; 8-bit masked) · bone from the CT at 0.6 mm, '
          'soft tissue registered from TotalSegmentator s1082 · CC BY-NC 3.0')
BONE_GRADE = {'b200': 54, 'b700': 58, 'b1150': 60, 'b1500': 61}     # build_model.BONE_GRADES ids
V_BONE = 135                               # v at or above: bone (about 125 HU, materialize's trabecular cut)
V_SAT = 250                                # saturated (above about 245 HU), after resampling
CORTEX_MM, DIPLOE_MM = 1.2, 3.0            # depth into saturated bone: cortex, then diploe, then dense core
SCALP_MM = 5.0                             # the least soft tissue over bone, where the atlas has less


def paths(data, work=None):
    d = pathlib.Path(data)
    work = pathlib.Path(work) if work else d / 'vsd' / '037' / 'skull'
    work.mkdir(parents=True, exist_ok=True)
    return dict(src=d / 'vsd' / '037' / '037' / 'SMIR.Head.062Y.F.CT.62918',
                atlas=d / 'totalseg' / 's1082', work=work)


def read_source(src):
    r = sitk.ImageSeriesReader()
    r.SetFileNames(r.GetGDCMSeriesFileNames(str(src), r.GetGDCMSeriesIDs(str(src))[0]))
    img = r.Execute()
    assert img.GetPixelID() == sitk.sitkUInt8, 'expected the 8-bit secondary capture'
    assert np.allclose(img.GetDirection(), np.eye(3).ravel()), 'expected axial LPS'
    return img


def bands(v, brain):
    """Slices where the mask dropped the brain: within the brain's area (its label over the slices
    about), far fewer brain-valued voxels (v 20-120) than the slices about it have."""
    area = ndi.maximum_filter1d(brain, 17, axis=0)
    n = np.array([((v[z] >= 20) & (v[z] <= 120) & area[z]).sum() for z in range(v.shape[0])], float)
    ref = ndi.median_filter(n, 17)
    return np.nonzero((ref > 5000) & (n < 0.6 * ref))[0]


def inpaint(v, bad, inside):
    """The bad slices' brain (inside) from the nearest good slices above and below, linearly."""
    good = np.setdiff1d(np.arange(v.shape[0]), bad)
    out = v.copy()
    for z in bad:
        lo, hi = good[good < z].max(), good[good > z].min()
        t = (z - lo) / (hi - lo)
        m = inside[z] & (v[z] < V_BONE)
        out[z][m] = np.round((1 - t) * v[lo][m] + t * v[hi][m]).astype(v.dtype)
    return out


def pseudo_hu(v):
    """For TotalSegmentator: v - 10 HU, 0 as air, saturated bone at 700 HU."""
    hu = np.where(v == 0, -1000, v.astype(np.int16) - 10).astype(np.int16)
    hu[v == 255] = 700
    return hu


def segment(P, img):
    """TotalSegmentator `total` on the pseudo-HU (cached): the skull, C1-C7 and the brain come out
    whole although the soft tissue is missing; only they are used."""
    seg = P['work'] / 'seg.nii.gz'
    if not seg.exists():
        ct = P['work'] / 'pseudo_hu.nii.gz'
        o = sitk.GetImageFromArray(pseudo_hu(sitk.GetArrayFromImage(img))); o.CopyInformation(img)
        sitk.WriteImage(o, str(ct))
        subprocess.run([sys.executable, '-m', 'totalsegmentator.bin.TotalSegmentator', '-i', str(ct), '-o', str(seg), '--ml'],
                       check=True)
    return sitk.ReadImage(str(seg))


def label_ids(*names):
    cm = {v: k for k, v in ts_class_map().items()}
    return [cm[n] for n in names]


SKELETON = ('skull', 'vertebrae_C1', 'vertebrae_C2', 'vertebrae_C3', 'vertebrae_C4', 'vertebrae_C5')


def bone_image(hu, lab, thr):
    """A registration image: the skull and upper cervical vertebrae (labels, 2 voxels' grace) at or
    above thr, smoothed."""
    a = sitk.GetArrayFromImage(hu)
    m = ndi.binary_dilation(np.isin(sitk.GetArrayFromImage(lab), label_ids(*SKELETON)), iterations=2) & (a >= thr)
    o = sitk.GetImageFromArray(m.astype(np.float32)); o.CopyInformation(hu)
    return sitk.SmoothingRecursiveGaussian(o, 2.0)


def register(P, img, seg, z0):
    """s1082 onto this skull: moments, affine, then a B-spline on 6 x 6 x 6 control points, all on
    the smoothed skeletons at 1.5 mm (cached as a transform file)."""
    tfm = P['work'] / 'atlas_to_skull.h5'
    if tfm.exists():
        return sitk.ReadTransform(str(tfm))
    t0 = time.time()
    hu = sitk.Cast(img, sitk.sitkFloat32) - 10
    sz = img.GetSize(); spc = img.GetSpacing()
    ref = sitk.Image([int(sz[0] * spc[0] / 1.5), int(sz[1] * spc[1] / 1.5), int((sz[2] - z0) * spc[2] / 1.5)], sitk.sitkFloat32)
    ref.SetSpacing((1.5, 1.5, 1.5)); ref.SetOrigin(img.TransformIndexToPhysicalPoint((0, 0, int(z0)))); ref.SetDirection(img.GetDirection())
    fixed = sitk.Resample(bone_image(hu, seg, 120), ref, sitk.Transform(), sitk.sitkLinear, 0)
    act = sitk.ReadImage(str(P['atlas'] / 'ct.nii.gz'), sitk.sitkFloat32)
    alab = sitk.ReadImage(str(P['atlas'] / 'seg_ml.nii.gz'))
    moving = bone_image(act, alab, 200)
    init = sitk.CenteredTransformInitializer(fixed, moving, sitk.AffineTransform(3), sitk.CenteredTransformInitializerFilter.MOMENTS)
    R = sitk.ImageRegistrationMethod()
    R.SetMetricAsMeanSquares(); R.SetInterpolator(sitk.sitkLinear)
    R.SetMetricSamplingStrategy(R.RANDOM); R.SetMetricSamplingPercentage(0.2, seed=1)
    R.SetOptimizerAsRegularStepGradientDescent(learningRate=1.0, minStep=1e-4, numberOfIterations=300)
    R.SetOptimizerScalesFromPhysicalShift()
    R.SetShrinkFactorsPerLevel([4, 2, 1]); R.SetSmoothingSigmasPerLevel([2, 1, 0])
    R.SetInitialTransform(init, inPlace=False)
    aff = R.Execute(fixed, moving)
    if aff.GetName() == 'CompositeTransform':                  # (the optimised copy comes back wrapped)
        aff = sitk.CompositeTransform(aff).GetNthTransform(0)
    aff = sitk.AffineTransform(aff)
    print(f'  affine: {R.GetMetricValue():.4f} ({time.time() - t0:.0f} s)')
    bs = sitk.BSplineTransformInitializer(fixed, [6, 6, 6], order=3)
    R2 = sitk.ImageRegistrationMethod()
    R2.SetMetricAsMeanSquares(); R2.SetInterpolator(sitk.sitkLinear)
    R2.SetMetricSamplingStrategy(R2.RANDOM); R2.SetMetricSamplingPercentage(0.1, seed=1)
    R2.SetOptimizerAsLBFGSB(gradientConvergenceTolerance=1e-5, numberOfIterations=60, maximumNumberOfCorrections=7)
    R2.SetShrinkFactorsPerLevel([2, 1]); R2.SetSmoothingSigmasPerLevel([1, 0])
    R2.SetMovingInitialTransform(aff)
    R2.SetInitialTransform(bs, inPlace=True)
    R2.Execute(fixed, moving)
    comp = sitk.CompositeTransform([aff, bs])              # (the last is applied first: the B-spline, then the affine)
    w = sitk.GetArrayFromImage(sitk.Resample(moving, fixed, comp, sitk.sitkLinear, 0)) > 0.3
    f = sitk.GetArrayFromImage(fixed) > 0.3
    print(f'  b-spline: {R2.GetMetricValue():.4f}; skeleton Dice {2 * (w & f).sum() / (w.sum() + f.sum()):.3f} ({time.time() - t0:.0f} s)')
    sitk.WriteTransform(comp, str(tfm))
    return comp


def atlas_body(act):
    """s1082's body, without the scanner table: it lies behind the head, joined to it through the
    head holder (build_limbs.head_neck takes it off the same way): per slice, anything more than
    4.5 mm behind the back of the body's deep tissue is not the patient."""
    a = sitk.GetArrayFromImage(act)
    b = ndi.binary_closing(a > -320, iterations=2)
    deep = ndi.distance_transform_edt(b) >= 3                    # 4.5 mm in at 1.5 mm
    for z in range(b.shape[0]):                                  # (y index 0 is posterior: direction -y)
        ys = np.nonzero(deep[z].any(1))[0]
        if len(ys):
            b[z, :max(0, ys.min() - 3)] = False
    b = ndi.binary_fill_holes(largest(b))
    o = sitk.GetImageFromArray(b.astype(np.uint8)); o.CopyInformation(act)
    return o


def grid(img, lo_mm, hi_mm, sp=SP):
    """The model's grid: sp mm over a physical box (LPS mm), axes as the source."""
    n = [int(np.ceil((h - l) / sp)) for l, h in zip(lo_mm, hi_mm)]
    ref = sitk.Image(n, sitk.sitkUInt8)
    ref.SetSpacing((sp, sp, sp)); ref.SetOrigin(tuple(float(x) for x in lo_mm)); ref.SetDirection(img.GetDirection())
    return ref


def on(ref, image, interp, default=0, tx=None):
    return sitk.GetArrayFromImage(sitk.Resample(image, ref, tx or sitk.Transform(), interp, default))


def phys_box(img, mask, pad_mm):
    """A mask's bounding box in LPS mm (z, y, x array mask on img's grid), padded."""
    idx = np.argwhere(mask)
    lo = img.TransformIndexToPhysicalPoint([int(v) for v in idx.min(0)[::-1]])
    hi = img.TransformIndexToPhysicalPoint([int(v) for v in idx.max(0)[::-1]])
    return np.array(lo) - pad_mm, np.array(hi) + pad_mm


def ball(r):
    g = np.arange(-r, r + 1)
    return (g[:, None, None] ** 2 + g[None, :, None] ** 2 + g[None, None, :] ** 2) <= r * r


def largest(mask):
    lab, n = ndi.label(mask)
    if n <= 1:
        return mask
    return lab == (int(np.argmax(ndi.sum(mask, lab, range(1, n + 1)))) + 1)


def occlusal_band(v, lab):
    """The slices the fillings' streaks cross: in front of C2, per slice, the bone-valued voxels a
    2-D opening takes off (thin rays) peak at the occlusal plane; the band is the run about the peak
    over 30 % of it."""
    b = v >= V_BONE
    c2 = np.argwhere(np.isin(lab, label_ids('vertebrae_C2')))
    c1 = np.argwhere(np.isin(lab, label_ids('vertebrae_C1')))
    front, top = c2[:, 1].min(), min(v.shape[0], c1[:, 0].max() + int(round(15 / SP)))    # (the teeth lie below the palate)
    sq = np.ones((3, 3), bool)
    thin = np.array([(b[z, :front] & ~ndi.binary_opening(b[z, :front], structure=sq)).sum() for z in range(v.shape[0])], float)
    thin = ndi.uniform_filter1d(thin, 3)
    zmax = int(np.argmax(thin[:top]))
    over = thin > 0.3 * thin[zmax]
    over = ndi.binary_closing(over, iterations=3)             # (a dip of a few slices between the upper and lower fillings)
    lo = hi = zmax
    while lo > 0 and over[lo - 1]:
        lo -= 1
    while hi < top - 1 and over[hi + 1]:
        hi += 1
    lo, hi = max(0, lo - 2), min(v.shape[0] - 1, hi + 2)
    band = np.zeros(v.shape[0], bool)
    band[lo:hi + 1] = True
    print(f'  occlusal band z {lo}..{hi} ({(hi - lo + 1) * SP:.0f} mm; streak peak at {zmax})')
    return band



def skeleton(v, lab, band, skin):
    """The bone: v >= V_BONE within 4 mm of the skull and vertebra labels or inside their outline
    (not the headrest, which the occiput rests against, the ring and the rod beside the head, nor speckle). Across the
    occlusal band the fillings' streaks fill the face with rays as bright as bone and as dark as
    air, and the label is the better outline of the jaws and teeth there (TotalSegmentator read
    the arch and the rami through them): the label, smoothed, where the data, smoothed over a
    voxel, is at least 100 (about 90 HU)."""
    from skimage.morphology import convex_hull_image
    # each label's largest piece: TotalSegmentator called bits of the headrest skull
    labs = np.zeros(lab.shape, bool)
    for i in label_ids(*SKELETON):
        if (lab == i).any():
            labs |= largest(lab == i)
    # near the labels, or inside their outline slice by slice (the turbinates, the septum and the
    # ethmoid's plates lie in the nose, more than 4 mm from the label's edge)
    near = ndi.distance_transform_edt(~labs) * SP <= 4.0
    hull = np.zeros_like(labs)
    for z in range(lab.shape[0]):
        if labs[z].sum() > 50:
            hull[z] = convex_hull_image(labs[z])
    hull = ndi.binary_dilation(hull, structure=ball(int(round(2.0 / SP))))
    b = (v >= V_BONE) & (hull | near)
    # outside the outline only what is thicker than a voxel or two: the headrest's shell is thinner
    b[~hull] = ndi.binary_opening(b & ~hull, structure=ball(1))[~hull]
    b &= ndi.binary_dilation(skin, structure=ball(int(round(3.0 / SP))))     # (and inside the registered skin, the headrest outside it)
    # behind the cranium's middle and above its floor the registered scalp fits the calvarium closely
    # (the registration was made on it), and the headrest's shell lay against it there, a millimetre
    # or two outside: no bone beyond it
    brain = np.argwhere(np.isin(lab, label_ids('brain')))
    if len(brain):
        yb, zb = brain[:, 1].mean(), brain[:, 0].min()
        out = ndi.distance_transform_edt(~skin) * SP > 1.0
        back = (np.arange(lab.shape[1])[None, :, None] > yb) & (np.arange(lab.shape[0])[:, None, None] > zb)
        b &= ~(out & back)
    if band.any():
        z = np.nonzero(band)[0]
        sl = slice(z.min(), z.max() + 1)
        lab_s = ndi.gaussian_filter(labs[sl].astype(np.float32), 1.0 / SP) >= 0.5
        b[sl] = lab_s & (ndi.gaussian_filter(v[sl], 1.0) >= 100)
    pieces, n = ndi.label(b)
    hit = np.unique(pieces[labs & b])
    keep = np.isin(pieces, hit[hit > 0])
    sizes = ndi.sum(keep, pieces, range(1, n + 1)) * SP ** 3
    keep &= np.isin(pieces, np.nonzero(sizes >= 20.0)[0] + 1)          # 20 mm^3: no crumbs
    return keep


def cranial_cavity(bone, brain, v):
    """Inside the skull: the brain label grown through what is not bone, up to the inner table
    (6 mm); and with it the source's own soft tissue (v 3 and up, not bone) within 8 mm of that
    that is one piece with it (the label leaves out slices about the mask's bands); closed."""
    cav = brain & ~bone
    free = ~bone
    for _ in range(int(round(6.0 / SP))):
        cav = ndi.binary_dilation(cav) & free
    near = ndi.distance_transform_edt(~cav) * SP <= 8.0
    soft = free & (v >= 3) & near
    thick = ndi.binary_opening(soft, structure=ball(1))          # (not through a gap in a thin bone)
    lab, n = ndi.label(thick)
    hit = np.unique(lab[thick & cav])
    cav |= ndi.binary_dilation(np.isin(lab, hit[hit > 0])) & soft
    cav |= ndi.binary_closing(cav, structure=np.ones((15, 1, 1), bool)) & free     # (across a band, up and down)
    cav = ndi.binary_closing(cav, structure=ball(2)) & ~bone
    return ndi.binary_fill_holes(cav) & ~bone


def fill_brain(v, cav):
    """The brain where the source has none (the mask's dropped bands, and slices it cut short): no
    brain is below -10 HU, so a 0 in the cranium is a hole; each takes the nearest real voxel,
    looking up and down the slices first (distances across weighted 8 times)."""
    hole = cav & (v < 3)
    real = cav & ~hole
    if not hole.any():
        return v
    idx = ndi.distance_transform_edt(~real, sampling=(1, 8, 8), return_distances=False, return_indices=True)
    out = v.copy()
    out[hole] = v[tuple(i[hole] for i in idx)]
    print(f'  brain filled in {hole.sum() * SP ** 3 / 1e3:.0f} cm3')
    return out


def enclosure(bone, reach_mm=30.0, f=2):
    """For every voxel, of the 26 directions how many meet bone within reach_mm (at 1/f resolution):
    a sinus or a mastoid cell is walled all round, the orbit and the nose are open in front, the
    face's soft tissue to the outside."""
    n = [s_ // f * f for s_ in bone.shape]
    b = bone[:n[0], :n[1], :n[2]].reshape(n[0] // f, f, n[1] // f, f, n[2] // f, f).any((1, 3, 5))
    steps = reach_mm / (SP * f)
    count = np.zeros(b.shape, np.uint8)
    for d in [(i, j, k) for i in (-1, 0, 1) for j in (-1, 0, 1) for k in (-1, 0, 1) if (i, j, k) != (0, 0, 0)]:
        hit = np.zeros(b.shape, bool)
        for s_ in range(1, int(steps / np.linalg.norm(d)) + 1):
            sh = [s_ * c for c in d]
            src = tuple(slice(max(0, c), b.shape[a] + min(0, c)) for a, c in enumerate(sh))
            dst = tuple(slice(max(0, -c), b.shape[a] + min(0, -c)) for a, c in enumerate(sh))
            hit[dst] |= b[src]
        count += hit
    out = np.zeros(bone.shape, np.uint8)
    out[:n[0], :n[1], :n[2]] = count.repeat(f, 0).repeat(f, 1).repeat(f, 2)
    return out


def sinuses(bone, v, cav, band, walled=24):
    """The sinuses and mastoid cells: the source's zeros (air, there) walled by bone in at least
    `walled` of 26 directions within 3 cm, outside the cranium. Across the occlusal band, where
    rays cross the maxillary sinuses, dark on the average over a millimetre."""
    enc = enclosure(bone)
    dark = v < 3
    z = np.nonzero(band)[0]
    if len(z):
        sl = slice(z.min(), z.max() + 1)
        dark[sl] = ndi.gaussian_filter(v[sl], 1.0 / SP) < 25
    air = dark & ~bone & ~cav & (enc >= walled)
    return ndi.binary_opening(air)                 # (no single voxels between trabeculae)


def teeth(bone, band, lab):
    """The crowns: the bone of the occlusal band in the dental arch, in front of the mandible's
    rami (more than 15 mm in front of C2 and within 32 mm of the midline across)."""
    out = np.zeros_like(bone)
    c2 = np.argwhere(np.isin(lab, label_ids('vertebrae_C2')))
    if not band.any() or not len(c2):
        return out
    front, xc = c2[:, 1].min(), c2[:, 2].mean()
    ny, nx = bone.shape[1:]
    yy, xx = np.mgrid[:ny, :nx]
    arch = (yy < front - int(round(15 / SP))) & (np.abs(xx - xc) * SP < 32)
    for z in np.nonzero(band)[0]:
        out[z] = bone[z] & arch
    return out


# ---------------------------------------------------------------- the head set straight
# The patient lay with the head turned and tipped on the headrest: the two ear canals 16 mm apart in
# height and 10 mm front to back. A skull film is taken with the midsagittal plane square to the
# receptor and the orbitomeatal line (OML) square to it too, so the model is turned into that
# position once, here: the line between the ear canals across (x), and the OML front to back (y), so
# that a supine AP or prone PA with the beam straight down has the OML along the beam, and every
# angle the textbooks give against the OML is the protocol's own angle.
OML_DEG = 45.0             # the OML's rise toward the face, in the scan, once the ear canals' line is
                           # level. Set on the films: at 25 (the eye's estimate on the scan) the PA's
                           # petrous ridges lay below the orbits, as a 20 degree caudal angle puts them;
                           # at 45 they lie about the upper orbits, a Caldwell's in the lower third,
                           # and the orbits' openings (tools/skull_points.py) are level with the ear
                           # canals (within 1-6 degrees), as the canthi are on a square OML.


def _reach(b, d, steps):
    hit = np.zeros(b.shape, bool)
    for s_ in range(1, int(steps / np.linalg.norm(d)) + 1):
        sh = [s_ * c for c in d]
        src = tuple(slice(max(0, c), b.shape[a] + min(0, c)) for a, c in enumerate(sh))
        dst = tuple(slice(max(0, -c), b.shape[a] + min(0, -c)) for a, c in enumerate(sh))
        hit[dst] |= b[src]
    return hit


def ear_canals(mat, f=2):
    """The external acoustic meatus of each side, (z, y, x) voxels: non-bone, outside the cranium,
    walled by bone across (7 of the 8 directions in the y-z plane meet bone within 9 mm) and open to
    the side (one of five outward directions meets no bone in 3 cm), more than 2 cm from the
    midline; the largest such piece on each side. (A mastoid cell is walled all round; the internal
    meatus opens into the cranium.) Returns {'R': ..., 'L': ...}; x low is the patient's right."""
    b = mat[::f, ::f, ::f] >= 54
    cav = np.isin(mat[::f, ::f, ::f], [SOFT, CSF])
    steps = 9.0 / (SP * f)
    across = np.zeros(b.shape, np.uint8)
    for d in [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (1, 1, 0), (1, -1, 0), (-1, 1, 0), (-1, -1, 0)]:
        across += _reach(b, d, steps)
    across = across >= 7
    xs = np.arange(b.shape[2]); xc = b.shape[2] / 2; off = 20 / (SP * f)
    out = {}
    for side, sx, lat in (('R', -1, xs < xc - off), ('L', 1, xs > xc + off)):
        open_ = np.zeros(b.shape, bool)
        for d in [(0, 0, sx), (0, 1, sx), (0, -1, sx), (1, 0, sx), (-1, 0, sx)]:
            open_ |= ~_reach(b, d, 30 / (SP * f))
        cand = across & open_ & ~b & ~cav & lat[None, None, :]
        lab, n = ndi.label(cand)
        if not n:
            raise SystemExit(f'no ear canal found on the {side} side')
        k = int(np.argmax(ndi.sum(cand, lab, range(1, n + 1)))) + 1
        out[side] = np.array(ndi.center_of_mass(lab == k)) * f
    return out


def frame_rotation(src_axes, shape):
    """affine_transform's matrix and offset that lay the given axes (rows: the unit vectors, in input
    (z, y, x) index space, that are to become the output's z, y and x) along the output's, about the
    volume's centre, into a box big enough for any turn of it."""
    M = np.asarray(src_axes, float).T                   # columns: input-space directions of out z, y, x
    c_in = (np.array(shape) - 1) / 2
    out_shape = (int(shape[0] * 1.15), int(shape[1] * 1.15), int(shape[2] * 1.15))
    c_out = (np.array(out_shape) - 1) / 2
    return M, c_in - M @ c_out, out_shape


def straighten(mat):
    """Turn the head square (see above): the ear canals' line to x, the OML to y."""
    from scipy.ndimage import affine_transform
    ears = ear_canals(mat)
    R, L = ears['R'], ears['L']
    ex = (L - R) / np.linalg.norm(L - R)                 # (z, y, x) index space throughout
    up = np.array([1.0, 0, 0])
    ez = up - up.dot(ex) * ex; ez /= np.linalg.norm(ez)
    ey = np.cross(ez, ex)
    if np.linalg.det(np.stack([ez, ey, ex])) < 0:        # a turn, never a mirror (det +1)
        ey = -ey
    first = np.stack([ez, ey, ex])
    oml_deg = OML_DEG
    print(f'  ear canals R {np.round(R * SP, 1)} L {np.round(L * SP, 1)} mm: across them {np.degrees(np.arcsin(abs(ex[0]))):.1f} deg '
          f'tipped, {np.degrees(np.arcsin(abs(ex[1]))):.1f} deg turned; the OML raised {oml_deg:.1f} deg')
    # the second turn, about x: the OML to -y (front), so it lies square to z
    a = np.radians(oml_deg)
    c, s_ = np.cos(a), np.sin(a)
    # in the first frame's (z, y, x): the OML is (sin a, -cos a, 0); make it the new -y
    ey2 = np.array([-s_, c, 0.0]); ez2 = np.array([c, s_, 0.0])
    second = np.stack([ez2, ey2, [0, 0, 1.0]])
    full = second @ first                                # rows: the new axes in the source's index space
    M, off, shp = frame_rotation(full, mat.shape)
    out = affine_transform(mat, M, off, output_shape=shp, order=0, mode='constant', cval=AIR)
    # Nearest-neighbour turns of a voxel surface leave it terraced (the bone-only view showed the
    # calvarium in steps). The bone's outline is turned as a field instead, linearly, and cut at one
    # half; voxels it gains take the nearest bone's material, voxels it loses the nearest other.
    is_bone = (mat >= BONE_GRADE['b200']) | (mat == ENAMEL)
    smooth = affine_transform(is_bone.astype(np.float32), M, off, output_shape=shp, order=1, mode='constant', cval=0) >= 0.5
    was = (out >= BONE_GRADE['b200']) | (out == ENAMEL)
    for want, have in ((smooth & ~was, was & smooth), (~smooth & was, ~was & ~smooth)):
        if want.any():
            idx = ndi.distance_transform_edt(~have, return_distances=False, return_indices=True)
            out[want] = out[tuple(i[want] for i in idx)]
    # (the neck's cut end turns with the head: it is left as it falls)
    pts = {k: np.linalg.solve(M, np.asarray(v, float) - off) for k, v in
           (('earR', R), ('earL', L))}
    return out, pts


def build(data, work=None):
    P = paths(data, work)
    t = time.time()
    V, L, A, AB = prepare(P)
    materials_and_write(V, L, A, AB)
    print(f'done in {time.time() - t:.0f} s')


def prepare(P):
    """Stages 1-3, cached: the source on the model's grid (V, its 8-bit values, inpainted), its
    labels (L), the registered atlas's HU (A) and body (AB)."""
    cache = P['work'] / f'grid_{SP:g}mm.npz'
    if cache.exists():
        d = np.load(cache)
        return d['V'].astype(np.float32), d['L'], d['A'].astype(np.float32), d['AB']
    print('[1/6] source …')
    img = read_source(P['src'])
    seg = segment(P, img)
    v = sitk.GetArrayFromImage(img)
    lab = sitk.GetArrayFromImage(seg)
    brain0 = np.isin(lab, label_ids('brain'))
    bad = bands(v, brain0)
    bad = np.union1d(bad, np.clip(np.concatenate([bad - 1, bad + 1]), 0, v.shape[0] - 1)) if len(bad) else bad
    print(f'  brain missing from {len(bad)} slices: {bad.tolist()}')
    v = inpaint(v, bad, ndi.binary_dilation(brain0, iterations=6))
    img2 = sitk.GetImageFromArray(v); img2.CopyInformation(img)
    # the box: the head down to the middle of C4 (a lateral skull's field reaches C3), across and
    # front to back the atlas's head, the skeleton's and their soft tissue
    c4 = np.argwhere(np.isin(lab, label_ids('vertebrae_C4')))
    z0 = int(round(c4[:, 0].mean()))
    print('[2/6] the atlas onto the skeleton …')
    tx = register(P, img2, seg, max(0, z0 - 20))
    act = sitk.ReadImage(str(P['atlas'] / 'ct.nii.gz'), sitk.sitkFloat32)
    # the atlas body on the source grid (coarse, to find the box)
    abody = atlas_body(act)
    coarse = grid(img, img.TransformIndexToPhysicalPoint((0, 0, z0)),
                  np.array(img.TransformIndexToPhysicalPoint([s - 1 for s in img.GetSize()])) + 40, sp=2.0)
    cb = on(coarse, sitk.Cast(abody, sitk.sitkUInt8), sitk.sitkNearestNeighbor, 0, tx) > 0
    cb = largest(cb)
    lo, hi = phys_box(coarse, cb, 10.0)
    sk = np.isin(lab, label_ids(*SKELETON)) & (np.arange(v.shape[0])[:, None, None] >= z0)
    slo, shi = phys_box(img, sk, 12.0)
    lo = np.minimum(lo, slo); hi = np.maximum(hi, shi)
    lo[2] = img.TransformIndexToPhysicalPoint((0, 0, z0))[2]
    ref = grid(img, lo, hi)
    print(f'  grid {ref.GetSize()} at {SP} mm = {np.prod(ref.GetSize()) / 1e6:.1f} M voxels')
    print('[3/6] resample …')
    V = on(ref, sitk.Cast(img2, sitk.sitkFloat32), sitk.sitkLinear, 0).astype(np.float32)
    L = on(ref, seg, sitk.sitkNearestNeighbor, 0)
    A = on(ref, act, sitk.sitkLinear, -1000, tx).astype(np.float32)          # the atlas's HU here
    AB = on(ref, sitk.Cast(abody, sitk.sitkFloat32), sitk.sitkLinear, 0, tx) >= 0.5
    np.savez_compressed(cache, V=np.clip(np.round(V), 0, 255).astype(np.uint8), L=L.astype(np.uint8),
                        A=np.clip(A, -1024, 3071).astype(np.int16), AB=AB)
    return V, L, A, AB


def materials_and_write(V, L, A, AB):
    mat = materials(V, L, A, AB)[0]
    mat, _ = straighten(mat)
    write(mat)


def materials(V, L, A, AB):
    print('[4/6] materials …')
    band = occlusal_band(V, L)
    bone = skeleton(V, L, band, AB)
    cav = cranial_cavity(bone, np.isin(L, label_ids('brain')), V)
    V = fill_brain(V, cav)
    sat = bone & (V >= V_SAT)
    sat[band] = bone[band]                          # (the band's bone is the label's: its depth gives its density)
    air = sinuses(bone, V, cav, band)
    # the body: the atlas's, with at least SCALP_MM over this skeleton and cranium; smoothed, one piece
    body = AB | ndi.binary_dilation(bone | cav, structure=ball(int(round(SCALP_MM / SP))))
    body = ndi.gaussian_filter(body.astype(np.float32), 1.5 / SP) >= 0.5
    body = ndi.binary_fill_holes(largest(body))
    mat = np.full(V.shape, AIR, np.uint8)
    # the atlas's tissue by its HU (materialize's cuts); its bone, where this skull has none: soft tissue
    m = np.full(V.shape, SOFT, np.uint8)
    m[A < -190] = AIR
    m[(A >= -190) & (A < -30)] = FAT
    m[(A >= -30) & (A < 120)] = MUSCLE
    m[~AB] = FAT                         # what the body gained over the atlas's (scalp over this skull, smoothing)
    mat[body] = m[body]
    # the source's own soft tissue where it has any (the millimetres the mask kept about the bone):
    # -10 to 125 HU, muscle by materialize's cuts
    real = body & (V >= 3) & (V < V_BONE)
    real[band] = False                              # (in the band, rays)
    mat[real] = MUSCLE
    # the cranium: brain, with the CSF of the ventricles and sulci by its own (smoothed) HU
    vs = ndi.gaussian_filter(V, 1.0)
    mat[cav] = SOFT
    mat[cav & (vs < 22)] = CSF
    mat[air] = AIR
    # bone: below saturation its own HU (Bone 200 HU), saturated by depth
    depth = ndi.distance_transform_edt(sat) * SP
    mat[bone & ~sat] = BONE_GRADE['b200']
    mat[sat & (depth <= CORTEX_MM)] = BONE_GRADE['b1500']
    mat[sat & (depth > CORTEX_MM) & (depth <= DIPLOE_MM)] = BONE_GRADE['b700']
    mat[sat & (depth > DIPLOE_MM)] = BONE_GRADE['b1150']
    # the crowns: enamel over their outer 1.2 mm, dentin (Bone 1500 HU) within
    tooth = teeth(bone, band, L)
    mat[tooth] = BONE_GRADE['b1500']
    mat[tooth & (ndi.distance_transform_edt(tooth) * SP <= CORTEX_MM)] = ENAMEL
    # the skin: the body's outer 1.5 mm
    shell = body & ~ndi.binary_erosion(body, iterations=max(1, int(round(1.5 / SP))))
    mat[shell & (mat != AIR) & ~bone] = SKIN
    mat[~body] = AIR
    print(f'  bone {bone.sum() * SP ** 3 / 1e3:.0f} cm3 (saturated {sat.sum() / max(1, bone.sum()):.0%}), cranium {cav.sum() * SP ** 3 / 1e3:.0f} cm3, '
          f'sinus air {air.sum() * SP ** 3 / 1e3:.1f} cm3, teeth {tooth.sum() * SP ** 3 / 1e3:.1f} cm3, body {body.sum() * SP ** 3 / 1e3:.0f} cm3')
    return mat, dict(bone=bone, band=band, cav=cav, air=air, body=body, tooth=tooth)


def write(mat):
    print('[5/6] crop and write …')
    zs, ys, xs = np.nonzero(mat)
    pad = 4
    sl = tuple(slice(max(0, a.min() - pad), a.max() + pad + 1) for a in (zs, ys, xs))
    mat = np.ascontiguousarray(mat[sl])
    hu_ref = np.array([[-1000, 2500]], np.int16)                       # the header's HU range (air .. enamel)
    write_model(str(MODELS / NAME), NAME, TITLE, mat, hu_ref, SP, mesh=True, source=SOURCE, mesh_step_mul=2)
    print('[6/6] skin and bone meshes …')
    from app.build_skin import build as skin
    skin(NAME)
    from app.build_bone_mesh import build as bone_mesh
    bone_mesh(NAME)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default=str(pathlib.Path(__file__).resolve().parents[1] / 'data'))
    ap.add_argument('--work', default=None, help='where the stages are cached (default: <data>/vsd/037/skull)')
    a = ap.parse_args()
    build(a.data, a.work)
