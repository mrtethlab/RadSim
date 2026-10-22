"""Clean limb and head/neck models from the head-to-toe CT (VSD z045): one patient, one part.

    python -m app.build_limbs cache z045 z053        # resample + materialise the source CTs once
    python -m app.build_limbs lowerextremity upperextremity headneck

Why. The extremity models were cut from z045 with plain boxes (build_model --box), and a box
takes whatever lies in it:
- the lower extremity's box ran past the midline, so the left leg came with the right where the
  thighs, knees and feet touch, and it stopped short of the right foot, which this patient turns
  outward: the foot lost its lateral rays and soft tissue to the box edge, not to the scanner;
- the upper extremity's arm lies against the flank from the axilla to the hand, so the box
  carried a slab of chest, abdomen and pelvis fused to it, and every lateral of the elbow or
  forearm went through the trunk;
- the head and neck came from a different CT (TotalSegmentator s1397) scanned with the arms
  raised beside the head, which no cervical spine or skull radiograph is taken with.

Each part is now separated from its neighbours the way a radiographer would see it. The bones
are split into the part's own and everyone else's (by where the bone pieces lie), and a marker
watershed floods the body from both sets over the inverted distance map, so the cut runs along
the narrow skin contact between them (the crease where an arm lies on the flank, the inner
thighs), not across a limb. Thin things attached to the skin — the body bag, tubes, a sheet —
are pared off with an opening; a new skin shell is laid on the cut surface. The materials come
from the HU exactly as build_model.materialize makes them, so every other model from z045
(whole body, CAP) matches these voxel for voxel where they overlap.

Volume axes as stored (house convention, like the previous builds): x = patient LEFT...RIGHT as
the CT has it, y = posterior, z = superior after the z flip below.
"""
from __future__ import annotations

import pathlib
import sys
import time

import numpy as np
from scipy import ndimage as ndi

from app.build_model import (AIR, LUNG, FAT, MUSCLE, SKIN, TRABECULAR, CORTICAL, materialize, resample_iso,
                             write_model)

VSD = pathlib.Path(__file__).resolve().parents[1] / 'data' / 'vsd'
ROOT = pathlib.Path(__file__).resolve().parents[3]
MODELS = ROOT / 'apps' / 'web' / 'public' / 'models'
SP = 1.5
# z045 (45 M, extended, arms at the sides) gives the leg; z053 (57 F) the arm (ARMS, below): z045's
# arms lie outside its 512 mm field from shoulder to wrist (the lateral epicondyle and radial head
# are simply not in the scan); z033 (87 M) was reconstructed over 650 mm with the arms clear of the
# trunk, hands and all
SUBJECTS = {
    'z045': dict(ct=VSD / 'z045' / 'ct.nii.gz',
                 source='VSD Full Body postmortem CT (z045, 45M) · HU materials · CC BY-NC-SA'),
    'z033': dict(ct=next((VSD / 'z033' / 'z033').glob('*/*.nii'), None),
                 source='VSD Full Body postmortem CT (z033, 87M) · HU materials · CC BY-NC 3.0'),
    'z053': dict(ct=next((VSD / 'z053' / 'z053').glob('*/*.nii'), None),
                 source='VSD Full Body postmortem CT (z053, 57F) · HU materials · CC BY-NC 3.0'),
}


def cache_path(subj):
    return VSD / subj / f'{subj}_{SP:g}mm.npz'


def cache(subj):
    import SimpleITK as sitk
    t = time.time()
    ct = resample_iso(sitk.ReadImage(str(SUBJECTS[subj]['ct'])), SP, is_label=False)
    hu = sitk.GetArrayFromImage(ct).astype(np.int16)
    lab = np.zeros(hu.shape, np.int32)                  # HU materials: no organ labels needed
    mat, body = materialize(hu, lab, SP)
    np.savez_compressed(cache_path(subj), hu=hu, mat=mat, body=body)
    print(f'{subj}: cached {hu.shape} in {time.time() - t:.0f} s')


def load(subj='z045'):
    d = np.load(cache_path(subj))
    return d['hu'], d['mat'], d['body']


def split_slices(body, keep_bone, drop_bone, z0, z1, reach=4):
    """Per axial slice z0..z1, the part of the body that belongs to the keep markers: a marker
    watershed on the inverted distance map, so where two parts touch the cut runs along the
    narrow contact between them. Markers are the bone of each part within +-reach slices (a
    joint space or the gap between two carpals must not leave a slice without its marker)."""
    from skimage.segmentation import watershed
    out = np.zeros_like(body)
    for z in range(z0, z1):
        b = body[z]
        if not b.any():
            continue
        lo, hi = max(0, z - reach), min(body.shape[0], z + reach + 1)
        mk = np.zeros(b.shape, np.int32)
        mk[drop_bone[lo:hi].any(0) & b] = 2
        mk[keep_bone[lo:hi].any(0) & b] = 1          # the part's own bone wins a tie
        if not (mk == 1).any():
            continue
        if not (mk == 2).any():
            out[z] = b & (ndi.label(b)[0] == ndi.label(b)[0][mk == 1][0])
            continue
        lab = watershed(-ndi.distance_transform_edt(b), mk, mask=b)
        out[z] = lab == 1
    return out


def split_3d(body, markers, f=2):
    """The same watershed in 3D, at 1/f resolution: per slice, where the thighs press together
    over a broad face, the cut wandered from one slice to the next and left the inner thigh in
    shreds. In 3D the cut is one surface. The coarse labels are carried to every fine voxel by
    the nearest labelled coarse voxel, so no skin-deep layer is lost at the edge."""
    from skimage.segmentation import watershed
    b2 = body[::f, ::f, ::f]
    m2 = markers[::f, ::f, ::f] * b2
    ws = watershed(-ndi.distance_transform_edt(b2), m2, mask=b2)
    idx = ndi.distance_transform_edt(ws == 0, return_distances=False, return_indices=True)
    ws = ws[tuple(idx)]
    up = ws.repeat(f, 0).repeat(f, 1).repeat(f, 2)[:body.shape[0], :body.shape[1], :body.shape[2]]
    return up


def nearest_bone(body, keep_bone, drop_bone):
    """Each voxel to whichever part's bone is nearer. For two legs pressed together the plane
    halfway between the femurs is where they meet; a distance-map watershed failed there: the
    femur lies lateral of the obese thigh's deepest line, and the other leg's flood ran down that
    line, the whole thigh's length, before the femur's own reached it."""
    d1 = ndi.distance_transform_edt(~keep_bone)
    d2 = ndi.distance_transform_edt(~drop_bone)
    return body & (d1 < d2)


def pare(mask, r):
    """Thin things on the skin (a body bag's fold, a tube, a sheet): opened away, then the part
    is grown back by r inside the original, so only what is thinner than about 2r and sticks out
    further than r goes. The largest piece is kept."""
    if r > 0:
        ball = ndi.generate_binary_structure(3, 1)
        op = ndi.binary_opening(mask, structure=ball, iterations=r)
        lab, n = ndi.label(op)
        if n > 1:
            op = lab == (int(np.argmax(ndi.sum(op, lab, range(1, n + 1)))) + 1)
        mask = mask & ndi.binary_dilation(op, structure=ball, iterations=r + 1)
    lab, n = ndi.label(mask)
    if n > 1:
        mask = lab == (int(np.argmax(ndi.sum(mask, lab, range(1, n + 1)))) + 1)
    return ndi.binary_fill_holes(mask)


def smooth(keep, fine_z, bone, sigma=6.0, fine_sigma=1.5, ramp=20, ball=5, level=0.5):
    """Smooth, gently curved skin: the part's mask blurred and cut again at one half. The cuts that
    parted it from its neighbours wander a voxel or two from slice to slice, and what the bag and
    sheet left on the side it lay on hangs off in drips and fins up to 1.5 cm across; a blur of 6
    voxels (9 mm), after a 7.5 mm ball opening, rounds the one into curves and takes the other
    away. The hand or the foot
    (fine_z: a boolean per slice) takes 1.5 voxels, which keeps a finger or a toe, easing between
    the two over `ramp` slices. Mass is kept: what the blur takes off a bump it gives to a hollow.
    It never takes the skeleton (`bone`: the big pieces, not the dense tubes in the bag, which read
    as bone by HU and would keep their nub) nor the 3 mm of tissue over it (a malleolus, the patella,
    the olecranon, a knuckle lie just under the skin); what it fills in is fat (finish)."""
    zs, ys, xs = np.nonzero(keep)
    pad = int(3 * sigma) + 2
    lo = [max(0, zs.min() - pad), max(0, ys.min() - pad), max(0, xs.min() - pad)]
    hi = [min(keep.shape[0], zs.max() + pad + 1), min(keep.shape[1], ys.max() + pad + 1), min(keep.shape[2], xs.max() + pad + 1)]
    sub = keep[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]]
    # first a ball opening (radius `ball`, 7.5 mm): a blur alone left the tail where two calves met
    # and the corners of the faces cut against the trunk or the other thigh, 1-2 cm across
    g = np.arange(-ball, ball + 1)
    sph = (g[:, None, None] ** 2 + g[None, :, None] ** 2 + g[None, None, :] ** 2) <= ball * ball
    opened = ndi.binary_opening(sub, structure=sph)
    coarse = ndi.gaussian_filter(opened.astype(np.float32), sigma) >= level
    sub = sub.astype(np.float32)
    fine = ndi.gaussian_filter(sub, fine_sigma) >= 0.5
    w = ndi.uniform_filter1d(fine_z[lo[0]:hi[0]].astype(np.float32), ramp)       # 1 in the hand or foot
    pick = np.random.default_rng(0).random(sub.shape, dtype=np.float32) < w[:, None, None]
    out = np.zeros_like(keep)
    out[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]] = np.where(pick, fine, coarse)
    out |= keep & ndi.binary_dilation(bone & keep, iterations=2)
    return pare(out, r=0)


def finish(mat, keep, pad=4, limb=False):
    """The part alone: everything outside it is air, a one-voxel skin shell on its new surface
    (materialize lays the same shell, 1.5 mm, on the whole body), and the tight box around it.
    Where smoothing filled in a hollow, the new tissue is fat, as under any skin."""
    out = np.where(keep, mat, AIR).astype(np.uint8)
    out[keep & (out == AIR)] = FAT
    if limb:                       # no limb holds gas: a pocket of it (post mortem) printed as a line
        out[keep & (out == LUNG)] = FAT
        # the scan's own skin, under the smoothing's new fat, drew a second outline inside the first
        out[keep & (out == SKIN)] = FAT
    shell = keep & ~ndi.binary_erosion(keep)
    out[shell & (out != AIR)] = SKIN
    zs, ys, xs = np.nonzero(keep)
    sl = (slice(max(0, zs.min() - pad), zs.max() + pad + 1), slice(max(0, ys.min() - pad), ys.max() + pad + 1),
          slice(max(0, xs.min() - pad), xs.max() + pad + 1))
    return out[sl], sl


def big_bone(mat, min_vox=20000):
    """Bone that belongs to the skeleton: the pieces of at least min_vox voxels. A dense tube or
    the bag's clips read as bone by HU and must not mark a part as their own."""
    bone = np.isin(mat, [TRABECULAR, CORTICAL])
    lab, n = ndi.label(bone)
    sizes = ndi.sum(bone, lab, range(1, n + 1))
    return np.isin(lab, np.nonzero(sizes >= min_vox)[0] + 1)


# z045 at 1.5 mm, as cached (z = 0 at the neck, x low = the patient's RIGHT): measured on the
# coronal projection and the bone itself
MIDLINE_X = 166          # median x of the lumbar spine
CROTCH_Z = 440           # just below the pubic symphysis: under it the two legs are apart in bone
KNEE_Z = 650             # the knee joints
ANKLE_Z = 930            # the ankles


def lower_extremity(hu, mat, body):
    """The patient's right leg, iliac crest to toes, alone. Above the crotch the pelvis is halved
    at the midline as before (a hip film wants the hemipelvis); below it the leg is parted from
    the left one along the skin where they touch, and the box no longer stops short of the foot,
    which turns outward to x = 45."""
    z0, x1 = 330, 300
    b = body[z0:, :, :x1]
    bone = big_bone(mat[z0:, :, :x1])
    zs = np.arange(b.shape[0])[:, None, None] + z0
    xs = np.arange(x1)[None, None, :]
    # the right hand and forearm lie beside the hip (x < 55 down to z 500): the arm's, not the leg's
    arm = bone & (xs < 55) & (zs < 500)
    right = bone & (xs < MIDLINE_X) & ~arm
    keep = np.zeros(body.shape, bool)
    c, k = CROTCH_Z - z0, KNEE_Z - z0
    # Above the crotch: the hand parted from everything else in 3D (left against right there had
    # the two halves of the spine contest the abdomen's core, differently in every slice), then the
    # pelvis halved at the midline, as a hip film has it.
    mk = np.where(arm[:c], 2, np.where(bone[:c], 1, 0)).astype(np.int32)
    keep[z0:CROTCH_Z, :, :x1] = (split_3d(b[:c], mk) == 1) & b[:c] & (xs[0, 0] < MIDLINE_X)
    # The thighs press together over a broad flat face: halfway between the femurs is the contact.
    # (A distance-map watershed failed here: the femur lies lateral of the obese thigh's deepest
    # line, and in 3D the other leg's flood ran down that line ahead of it.)
    keep[CROTCH_Z:KNEE_Z, :, :x1] = nearest_bone(b[c:k], right[c:k], (bone & ~right)[c:k])
    # The calves only touch, but the tibia is at the front of the calf: halfway between the tibias
    # gave this leg a fin of the other calf's muscle. Slice by slice, a watershed finds the narrow
    # contact, and each calf's own core lies behind its own tibia.
    keep[KNEE_Z:, :, :x1] = split_slices(b[k:], right[k:], (bone & ~right)[k:], 0, b.shape[0] - k)
    # slice-by-slice cuts wander a voxel or two: a five-slice majority along the leg, down to the
    # ankle (below it the foot runs along z, and a majority would nibble the toes)
    a = ANKLE_Z
    keep[KNEE_Z:a] = ndi.median_filter(keep[KNEE_Z:a].astype(np.uint8), size=(5, 1, 1)).astype(bool) & body[KNEE_Z:a]
    keep[z0:] = pare(keep[z0:], r=2)
    foot = np.zeros(keep.shape[0], bool); foot[ANKLE_Z:] = True
    keep = smooth(keep, foot, big_bone(mat))
    # the thigh, knee and calf (not the hemipelvis above, nor the foot below the ankle)
    return convex_limb(keep, CROTCH_Z, ANKLE_Z, mat, big_bone(mat) & keep, joints=(KNEE_Z,))


# The arm's frame, per source CT at 1.5 mm (z = 0 at the shoulders, x low = the patient's RIGHT,
# as in z045: the liver lies at low x, the stomach's gas at high x):
#   axilla: the axillary fold (above it the shoulder keeps its girdle, out to x1)
#   edge:   the arm's bone cluster ends short of this x; the trunk's starts beyond it
#   free:   where the arm stands clear of the trunk (its outline is evened from there on)
#   elbow, wrist, end: the elbow joint, the wrist and the fingertips
ARMS = {
    # 87 M: osteoporotic, its spongy bone at muscle HU; the elbow printed without its condyles
    'z033': dict(axilla=100, x1=135, edge=120, wrist=400, end=470, elbow=219),
    # 57 F: the right arm straight at the side, clear of the trunk below the axilla, its bone
    # healthy (cortex ~1200 HU, spongy bone well above muscle). Its fingers reach the scan's edge
    # at x = 2 and lose a few millimetres of the hand's radial side; the hand and wrist films use
    # the hand CT, so here the hand only ends a forearm film.
    'z053': dict(axilla=75, x1=140, edge=100, wrist=372, end=475, clear=118, free=140, elbow=215),
}
ARM = 'z053'


def arm_bone(bone, z0, z1, gap=10, edge=120, clear=None, body=None):
    """The arm's bone, slice by slice: the lateral-most cluster of bone across x, when a gap of at
    least `gap` voxels parts it from the next. From the surgical neck down the arm's bone is always
    that cluster (measured: it ends by x 62, the trunk's bone starts at x 65 or beyond); above it
    the humeral head meets the glenoid and there is no gap."""
    out = np.zeros_like(bone)
    for z in range(z0, z1):
        # where the arm's own tissue stands clear of the trunk's across x, its bone is all the bone
        # in it (a hand's bones lie further apart than the gap test allows; z053's do at the wrist)
        if body is not None:
            bc = np.nonzero(body[z].any(0))[0]
            parts = np.nonzero(np.diff(bc) > 1)[0] if len(bc) else []
            if len(parts) and bc[parts[0]] <= edge:
                out[z, :, :bc[parts[0]] + 1] = bone[z, :, :bc[parts[0]] + 1]
                continue
        cols = np.nonzero(bone[z].any(0))[0]
        if len(cols) < 2:
            continue
        g = np.nonzero(np.diff(cols) >= gap)[0]
        if not len(g) or cols[g[0]] > edge:
            continue
        out[z, :, :cols[g[0]] + 1] = bone[z, :, :cols[g[0]] + 1]
    # Where the humerus lies against the chest wall (z053, down to 18 cm below the shoulder) its
    # shaft and the ribs overlap across x and the gap test finds the wrong cluster or none: above
    # `clear`, the shaft is followed up slice by slice instead, by the bone pieces that touch the
    # arm's bone below and lie on its side (a rib touching it lies further in).
    if clear is not None:
        out[z0:clear] = False
        for z in range(clear - 1, z0 - 1, -1):
            if not out[z + 1].any():
                break
            lab, n = ndi.label(bone[z])
            near = ndi.binary_dilation(out[z + 1], iterations=2)
            xmax = np.nonzero(out[z + 1].any(0))[0].max() + 8
            ids = [i for i in np.unique(lab[near & (lab > 0)]) if ndi.center_of_mass(lab == i)[1] <= xmax]
            out[z] = np.isin(lab, ids)
    return out


def upper_extremity(hu, mat, body, subj=ARM):
    """The patient's right arm, shoulder to fingertips, alone. Above the axillary fold the shoulder
    keeps its girdle and the upper chest wall, as a shoulder or humerus film shows them; below it
    the arm is parted from the trunk slice by slice where they touch, and from the clutter in the
    bag beside the hand. (z045's arm lies outside its scan field along its whole length.)"""
    a_ = ARMS[subj]
    z1, w, ax = a_['end'], a_['wrist'], a_['axilla']
    bone = big_bone(mat[:z1], 2000)
    a = arm_bone(bone, ax - 40, z1, edge=a_['edge'], clear=a_.get('clear'), body=body if a_.get('clear') else None)
    keep = np.zeros(body.shape, bool)
    xs = np.arange(body.shape[2])[None, None, :]
    keep[:ax] = body[:ax] & (xs < a_['x1'])
    keep[ax:z1] = split_slices(body[:z1], a, bone & ~a, ax, z1)[ax:]
    # where the upper arm lies pressed against the chest over a broad face (z053, axilla to `clear`)
    # the watershed gave the arm only its lateral half, a waist under the shoulder: halfway between
    # the humerus and the ribs is where they meet
    if a_.get('clear'):
        c = a_['clear'] + 15
        keep[ax:c] = nearest_bone(body[ax:c], a[ax:c], (bone & ~a)[ax:c])
    keep[ax:z1] &= within_reach(keep[ax:z1], a[ax:z1])
    # slice-by-slice cuts wander: a five-slice majority along the arm, down to the wrist
    keep[ax:w] = ndi.median_filter(keep[ax:w].astype(np.uint8), size=(5, 1, 1)).astype(bool) & body[ax:w]
    keep[:z1] = pare(keep[:z1], r=2)
    hand = np.zeros(keep.shape[0], bool); hand[w:] = True       # the wrist and hand
    # The surface is grown about 5 mm (cut at 0.3, not 0.5), filled with fat: z033's skin lay thin
    # over the epicondyles and the olecranon, and the bone guard kept those bumps.
    keep = smooth(keep, hand, big_bone(mat, 2000), level=0.3)
    # above where the arm stands clear of the trunk its inner side is the cut against the chest, and
    # the hull drew a cone from it to the elbow: there the outline is held to no wider than at `free`
    return convex_limb(keep, ax, w, mat, big_bone(mat, 2000) & keep, joints=(a_['elbow'],), free=a_.get('free'))


def convex_limb(keep, z0, z1, mat, bone, joints=(), free=None, bins=96, cover_mm=20, cover_end_mm=10, ease_mm=40):
    """A healthy limb's outline is flat or convex, along it and around it, and its bones lie well
    inside it. This one dipped in a waist above the humeral condyles, under the bulge of the biceps,
    its skin waved (wasting, and the sag of a body lying dead), and the medial epicondyle, the
    olecranon, the patella and the shin came through it.
    - Cover: no bone within cover_mm of the skin, easing to cover_end_mm over the distal third (z
      grows distally), where a wrist or an ankle is thin.
    - Outline: per slice, the skin's distance from the limb's centre line in `bins` directions.
      Along each segment between `joints` (z), each direction's distance is replaced by its least
      concave majorant, the upper hull of the profile: flat or convex all along the upper arm, the
      forearm, the thigh and the leg (a closing only bridged dips, and a calf's taper to the ankle
      is no dip). A joint between two segments may still be narrower than either. Around the limb
      the profile is closed over 45 degrees (a hollow in the section is filled).
    - The change eases in and out over ease_mm at both ends of z0..z1, so the hip above and the hand
      or foot below meet it without a step.
    Only ever adds, and what it adds is fat, whatever lay there (toward the chest it would take in
    ribs that are not the arm's): `mat` is cleared there, and finish fills it with fat."""
    n = z1 - z0
    sub = keep[z0:z1].copy()
    t = np.clip((np.arange(n) - 2 * n / 3) / (n / 3), 0, 1)
    cover = cover_mm * (1 - t) + cover_end_mm * t
    zs, ys, xs = np.nonzero(sub)
    m = int(np.ceil(cover_mm / SP)) + 2
    y0, y1 = max(0, ys.min() - m), min(sub.shape[1], ys.max() + m + 1)
    x0, x1 = max(0, xs.min() - m), min(sub.shape[2], xs.max() + m + 1)
    d = ndi.distance_transform_edt(~bone[z0:z1, y0:y1, x0:x1]) * SP
    sub[:, y0:y1, x0:x1] |= d <= cover[:, None, None]
    c = np.array([ndi.center_of_mass(s_) if s_.any() else (np.nan, np.nan) for s_ in sub])
    ok = ~np.isnan(c[:, 0])
    for a in range(2):                                   # the centre line, filled in and smoothed
        c[:, a] = np.interp(np.arange(n), np.nonzero(ok)[0], c[ok, a])
        c[:, a] = ndi.gaussian_filter1d(c[:, a], 8, mode='nearest')
    ny, nx = sub.shape[1:]
    yy, xx = np.mgrid[:ny, :nx]
    def profile(vol):
        R = np.zeros((n, bins), np.float32)
        for i in range(n):
            dy, dx = yy - c[i, 0], xx - c[i, 1]
            th = ((np.arctan2(dy, dx) + np.pi) / (2 * np.pi) * bins).astype(int) % bins
            msk = vol[i]
            np.maximum.at(R[i], th[msk], np.hypot(dy, dx)[msk])
        return R
    R0 = profile(keep[z0:z1])                            # the limb as it was
    R = profile(sub)                                     # with its cover
    R = ndi.grey_closing(R, size=(1, bins // 8 | 1), mode='wrap')
    if free is not None and z0 < free < z1:              # (above `free`: no wider than at it)
        f = free - z0
        R[:f] = np.minimum(R[:f], R[f])
        R0[:f] = np.minimum(R0[:f], R[f])
    cuts = [0] + sorted(int(j) - z0 for j in joints if z0 < j < z1) + [n]
    for a, b in zip(cuts[:-1], cuts[1:]):
        for j in range(bins):
            R[a:b, j] = majorant(R[a:b, j])
    R = ndi.gaussian_filter(R, (2, 1), mode=('nearest', 'wrap'))
    e = max(1, int(round(ease_mm / SP)))
    k = np.arange(n)
    w = np.clip(np.minimum(k + 1, n - k) / e, 0, 1)[:, None]
    w = w * w * (3 - 2 * w)                              # smoothstep
    R = R0 + w * np.maximum(R - R0, 0)
    out = keep.copy()
    for i in range(n):
        dy, dx = yy - c[i, 0], xx - c[i, 1]
        tt = (np.arctan2(dy, dx) + np.pi) / (2 * np.pi) * bins - 0.5
        lo = np.floor(tt).astype(int) % bins; f = tt - np.floor(tt)
        rr = R[i, lo] * (1 - f) + R[i, (lo + 1) % bins] * f
        add = (np.hypot(dy, dx) <= rr) & (w[i, 0] > 0)
        out[z0 + i] |= add
        mat[z0 + i][add & ~keep[z0 + i]] = AIR
    return out


def healthy_arm(hu, mat, keep, fat_mm=7.5, fat_hu=-100):
    """A healthy arm's soft tissue on this 87-year-old's frame. Its muscle is wasted and fatty:
    under the subcutaneous fat the forearm's deep compartment reads -60 to -110 HU, below the
    -30 HU muscle cut, so the forearm printed as a bag of fat whose muscle came and went slice by
    slice (a level across the forearm where the HU crossed the cut), and the bones floated in it.
    Deeper than fat_mm under the skin, tissue is muscle unless it is plainly fat (below fat_hu, on
    HU smoothed over a voxel so it does not speckle): intermuscular fat and the elbow's fat pads
    stay. (Closing the osteoporotic cortex was tried too: a ball that mends the shafts' breaks also
    bridges the radius to the ulna where they lie close, and wherever the closing stopped, short of
    the joints, the film showed the edge as a line across the bones.)"""
    out = mat.copy()
    zs = np.nonzero(keep.any((1, 2)))[0]
    z0, z1 = zs.min(), zs.max() + 1
    k = keep[z0:z1]
    sub = out[z0:z1]
    soft = k & ~np.isin(sub, [TRABECULAR, CORTICAL])
    depth = ndi.distance_transform_edt(k) * SP
    h = ndi.gaussian_filter(hu[z0:z1].astype(np.float32), 1.0)
    sub[soft & (depth > fat_mm) & (h > fat_hu)] = MUSCLE
    return out


def majorant(y):
    """The least concave function over y (indexed 0..n-1): the upper convex hull, interpolated."""
    hull = []
    for i, v in enumerate(y):
        while len(hull) >= 2:
            (i1, v1), (i2, v2) = hull[-2], hull[-1]
            if (v2 - v1) * (i - i1) <= (v - v1) * (i2 - i1):    # the middle point lies under the chord
                hull.pop()
            else:
                break
        hull.append((i, float(v)))
    hi, hv = zip(*hull)
    return np.interp(np.arange(len(y)), hi, hv)


def within_reach(part, bone, margin=2, smooth=9):
    """Only what lies as close to the part's own bone as its free side does. A fluid bag in the body
    bag lies on this arm from the elbow up and against the trunk too, broad and as thick as the arm,
    so no opening parts them; but every bit of an arm is within a few centimetres of one of its
    bones, and its lateral side touches nothing. Per slice the reach is the 95th percentile of the
    distance to bone over the lateral half, plus a margin, smoothed along the arm; distance to the
    nearest bone (not to a centre) keeps the spread hand, every part of which is near a bone."""
    out = np.zeros_like(part)
    reach = np.zeros(part.shape[0])
    dists = []
    for z in range(part.shape[0]):
        if not bone[z].any() or not part[z].any():
            dists.append(None)
            continue
        d = ndi.distance_transform_edt(~bone[z])
        cx = np.nonzero(bone[z])[1].mean()
        lat = part[z].copy(); lat[:, int(cx):] = False
        reach[z] = np.percentile(d[lat], 95) if lat.any() else 0
        dists.append(d)
    reach = ndi.median_filter(reach, size=smooth) + margin
    for z, d in enumerate(dists):
        out[z] = part[z] if d is None else (d <= reach[z])
    return out


# ---------------------------------------------------------------- head and neck
TS = VSD.parent / 'totalseg'


def head_neck():
    """Head and neck from TotalSegmentator s1082 (69 M, polytrauma CT): the whole skull, and the
    arms down at the sides with the humeral heads 17 cm below C1, so a lateral reaches C7. (The
    previous model, s1397, was scanned with both arms raised beside the head; none of the VSD
    whole-body scans include a head.) The volume comes from build_model's box crop, 1.5 cm below
    T3 to the top of the scan, with the CT's own labels; then the scanner table goes. It lay behind
    the head, joined to it through the head holder, so the largest-piece rule kept it; an opening
    would have taken the ears too (a pinna is about 5 mm). Per slice, anything more than 4.5 mm
    behind the back of the body (its deep tissue) is not the patient."""
    from app.build_model import build
    case = TS / 's1082'
    build(str(case / 'ct.nii.gz'), str(case / 'seg_ml.nii.gz'), str(MODELS / 'headneck'), 'headneck',
          'Head & neck', 'wholebody', SP, mesh=False,
          source='TotalSegmentator dataset (s1082, 69M, arms down) · ground-truth segmentation · CC BY 4.0',
          box=(0.55, 1.0, 0, 1, 0, 1))
    hdr = MODELS / 'headneck' / 'headneck.model.json'
    import json
    h = json.loads(hdr.read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    mat = np.fromfile(MODELS / 'headneck' / 'headneck.mat.bin', np.uint8).reshape(nz, ny, nx)
    body = mat > 0
    deep = ndi.distance_transform_edt(body) >= 3
    keep = body.copy()
    for z in range(nz):                                  # y index 0 is POSTERIOR in this volume
        ys = np.nonzero(deep[z].any(1))[0]
        if len(ys):
            keep[z, :max(0, ys.min() - 3)] = False
    keep = pare(keep, r=0)
    return mat, keep, h


def write(name, title, subj, mat, hu, keep):
    if subj == 'z033':
        mat = healthy_arm(hu, mat, keep)
    part, sl = finish(mat, keep, limb=True)
    # house convention, as build_model --flip 1 0 0 gave the earlier z045 crops: index 0 inferior
    part, h = np.ascontiguousarray(part[::-1]), np.ascontiguousarray(hu[sl][::-1])
    write_model(str(MODELS / name), name, title, part, h, SP, mesh=True, source=SUBJECTS[subj]['source'])
    skin(name)


def skin(name):
    # write_model writes a fresh header, which drops its skinMesh: the room fell back to the blocky
    # display mesh until the smooth skin was rebuilt by hand
    from app.build_skin import build
    build(name)


PARTS = {
    'lowerextremity': ('Lower extremity', 'z045', lambda hu, mat, body: lower_extremity(hu, mat, body)),
    'upperextremity': ('Upper extremity', ARM, lambda hu, mat, body: upper_extremity(hu, mat, body)),
}


def write_headneck():
    mat, keep, h = head_neck()
    part, sl = finish(mat, keep)
    hu = np.zeros(part.shape, np.int16) + np.int16(h['huReference'][0])
    hu.flat[0] = h['huReference'][1]                      # keeps the header's HU range
    write_model(str(MODELS / 'headneck'), 'headneck', 'Head & neck', part, hu, SP, mesh=True, source=h['source'])
    skin('headneck')


if __name__ == '__main__':
    if sys.argv[1:] == ['headneck']:
        write_headneck()
    elif sys.argv[1] == 'cache':
        for subj in sys.argv[2:] or ['z045']:
            cache(subj)
    else:
        for name in sys.argv[1:]:
            t = time.time()
            title, subj, fn = PARTS[name]
            hu, mat, body = load(subj)
            write(name, title, subj, mat, hu, fn(hu, mat, body))
            print(f'{name}: {time.time() - t:.0f} s')
