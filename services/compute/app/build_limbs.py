"""Clean limb and head/neck models from the head-to-toe CT (VSD z045): one patient, one part.

    python -m app.build_limbs cache                  # resample + materialise z045 once (~2 min)
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

from app.build_model import (AIR, SKIN, TRABECULAR, CORTICAL, materialize, resample_iso,
                             write_model)

VSD = pathlib.Path(__file__).resolve().parents[1] / 'data' / 'vsd'
ROOT = pathlib.Path(__file__).resolve().parents[3]
MODELS = ROOT / 'apps' / 'web' / 'public' / 'models'
SP = 1.5
# z045 (45 M, extended, arms at the sides) gives the leg; z033 (87 M) the arm: z045's arms lie
# outside its 512 mm field from shoulder to wrist (the lateral epicondyle and radial head are
# simply not in the scan), while z033 was reconstructed over 650 mm with the arms clear of the
# trunk, hands and all
SUBJECTS = {
    'z045': dict(ct=VSD / 'z045' / 'ct.nii.gz',
                 source='VSD Full Body postmortem CT (z045, 45M) · HU materials · CC BY-NC-SA'),
    'z033': dict(ct=next((VSD / 'z033' / 'z033').glob('*/*.nii'), None),
                 source='VSD Full Body postmortem CT (z033, 87M) · HU materials · CC BY-NC 3.0'),
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


def finish(mat, keep, pad=4):
    """The part alone: everything outside it is air, a one-voxel skin shell on its new surface
    (materialize lays the same shell, 1.5 mm, on the whole body), and the tight box around it."""
    out = np.where(keep, mat, AIR).astype(np.uint8)
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
    return keep


# z033 at 1.5 mm (z = 0 at the shoulders, x low = the patient's RIGHT, as in z045: the liver
# lies at low x in both)
AXILLA_Z = 100           # the axillary fold, about 7 cm below the top of the humeral head
ARM_X1 = 135             # how far toward the midline the shoulder keeps its girdle (spine at 221)


def arm_bone(bone, z0, z1, gap=10, edge=120):
    """The arm's bone, slice by slice: the lateral-most cluster of bone across x, when a gap of at
    least `gap` voxels parts it from the next. From the surgical neck down the arm's bone is always
    that cluster (measured: it ends by x 62, the trunk's bone starts at x 65 or beyond); above it
    the humeral head meets the glenoid and there is no gap."""
    out = np.zeros_like(bone)
    for z in range(z0, z1):
        cols = np.nonzero(bone[z].any(0))[0]
        if len(cols) < 2:
            continue
        g = np.nonzero(np.diff(cols) >= gap)[0]
        if not len(g) or cols[g[0]] > edge:
            continue
        out[z, :, :cols[g[0]] + 1] = bone[z, :, :cols[g[0]] + 1]
    return out


def upper_extremity(hu, mat, body):
    """The patient's right arm, shoulder to fingertips, alone (from z033: z045's arm lies outside
    its scan field along its whole length). Above the axillary fold the shoulder keeps its girdle
    and the upper chest wall, as a shoulder or humerus film shows them; below it the arm is parted
    from the trunk slice by slice where they touch, and from the clutter in the bag beside the
    hand."""
    z1 = 470
    bone = big_bone(mat[:z1], 2000)
    a = arm_bone(bone, AXILLA_Z - 40, z1)
    keep = np.zeros(body.shape, bool)
    xs = np.arange(body.shape[2])[None, None, :]
    keep[:AXILLA_Z] = body[:AXILLA_Z] & (xs < ARM_X1)
    keep[AXILLA_Z:z1] = split_slices(body[:z1], a, bone & ~a, AXILLA_Z, z1)[AXILLA_Z:]
    keep[AXILLA_Z:z1] &= within_reach(keep[AXILLA_Z:z1], a[AXILLA_Z:z1])
    # slice-by-slice cuts wander: a five-slice majority along the arm, down to the wrist (z 400)
    w = 400
    keep[AXILLA_Z:w] = ndi.median_filter(keep[AXILLA_Z:w].astype(np.uint8), size=(5, 1, 1)).astype(bool) & body[AXILLA_Z:w]
    keep[:z1] = pare(keep[:z1], r=2)
    return keep


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
    part, sl = finish(mat, keep)
    # house convention, as build_model --flip 1 0 0 gave the earlier z045 crops: index 0 inferior
    part, h = np.ascontiguousarray(part[::-1]), np.ascontiguousarray(hu[sl][::-1])
    write_model(str(MODELS / name), name, title, part, h, SP, mesh=True, source=SUBJECTS[subj]['source'])


PARTS = {
    'lowerextremity': ('Lower extremity', 'z045', lambda hu, mat, body: lower_extremity(hu, mat, body)),
    'upperextremity': ('Upper extremity', 'z033', lambda hu, mat, body: upper_extremity(hu, mat, body)),
}


def write_headneck():
    mat, keep, h = head_neck()
    part, sl = finish(mat, keep)
    hu = np.zeros(part.shape, np.int16) + np.int16(h['huReference'][0])
    hu.flat[0] = h['huReference'][1]                      # keeps the header's HU range
    write_model(str(MODELS / 'headneck'), 'headneck', 'Head & neck', part, hu, SP, mesh=True, source=h['source'])


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
