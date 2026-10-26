"""A whole-body PEDIATRIC phantom: an 11-year-old boy, skull to feet.

    python -m app.build_pediatric prep           # the child's CT and z053's upper body as NIfTI, segmented
    python -m app.build_pediatric child [sp]     # the child's own trunk: CT, labels and materials on an sp grid
    python -m app.build_pediatric donors         # the girdles' (z053) and the head's (s1082) donors, cleaned
    python -m app.build_pediatric fit            # register every donor part onto the child (work/fit.json)
    python -m app.build_pediatric compose [sp]   # stitch them on the child's grid
    python -m app.build_pediatric write [sp]     # apps/web/public/models/pediatric + skin and bone meshes
    python -m app.build_pediatric all [sp]
  then: services/compute/.venv/Scripts/python.exe tools/measure_pediatric.py

WHAT IS REAL AND WHAT IS GRAFTED. No open whole-body CT of a child could be found: the 109 subjects of
the VSD Full Body collection are 17 to 95 years old (read from the folder names inside each zip), the
youngest of the 1228 in the TotalSegmentator dataset is 15. The child is TCIA Pediatric-CT-SEG
2197048C (11 M, 140.1 cm, 48.5 kg; CC BY 4.0), a portal-phase chest-abdomen-pelvis CT, 0.625 mm, from
C7 to just below the lesser trochanters, with the arms raised over the head as children's body CTs are.
The child's own: thorax, lungs, heart, abdomen, pelvis, the spine T1-S5 with its ring apophyses, the
ribs and sternum, the proximal femurs with their open capital and trochanteric physes and the open
triradiate cartilage, the chest wall and back. Grafted, each scaled to the child:
- the head and neck down to the C7/T1 disc: TotalSegmentator s1082 (69 M, CC BY 4.0). The neck takes
  the child's own vertebral scale (its T1-T4 fitted to the donor's, x0.77), lengthened 15 % at mid-neck;
  the cranium takes a child's head circumference (53.5 cm against the donor's 60.4 measured on the skin:
  x0.885); the scale and the column's pitch ease from one to the other up the neck (HeadPull);
- both shoulder girdles and arms (scapula, clavicle, humerus, forearm, hand): z053's right (VSD, 57 F,
  CC BY-NC 3.0), mirrored for the left. Each girdle is placed by its upper ribs on the child's (ribs
  2-7 at their back and side, T1-T7, the sternum, the sternoclavicular joint), let down about the
  sternoclavicular joint until the humeral head is level with the jugular notch (the donor's shoulders
  were shrugged), and the arm turned at the shoulder to hang 9 degrees out from the side, at the
  child's arm length (ArmPull). At the side of the chest the donor's shoulder and axilla replace the
  child's raised-arm ones; in front and behind the child keeps its own chest wall and skin, its own
  scapulae and clavicles (where the raised arms took them) become muscle and the donor's are set into
  it as bone (child_zone, compose);
- both legs below the lesser trochanter: the shipped lower extremity (z035, 30 F, CC BY-NC 3.0; baked
  to the anatomical position), mirrored for the left. The child's scan holds no femoral shaft to follow,
  so each leg hangs from the child's own femoral head, its mechanical axis along the body, 3 degrees
  out, the heel on the table, the foot 10 degrees out, at the child's leg length (fit_legs); the thigh's
  outline is drawn out to the child's at the seam and the two femurs blended across it (LegPull,
  compose);
- the growth plates of the grafted long bones (an adult's are closed) are cut back in as cartilage
  discs: proximal humerus, distal radius and ulna, distal femur, proximal and distal tibia, proximal
  fibula. Not the distal fibula (in the donor it lies against the tibia at its plate's level, and the
  pick finds no piece of its own), nor the hands' and feet's small bones, nor the elbow's centres.
Seams lie in soft tissue or at a joint (the C7/T1 disc, the sternoclavicular joints, the scapulae on
the chest wall), except the femur, where the child's subtrochanteric section is blended into the
donor's shaft over 3.5 cm. The skin across them is blended (occupancies weighted by blurred ownership;
over the shoulders signed distances, which slope from one surface to the other), the thighs' soft
tissue dithered across their seam, and a new skin laid on the whole.

Frames: everything is LPS millimetres (app.pediatric_src). The model is written in the house
convention, which is LPS as an array: x toward the patient's left, y posterior, z superior, index 0
inferior. Postmortem artefacts of the donors (the body bag, tubes, gas) are pared off as build_limbs
does; the head donor's glasses and table, and the child's ECG leads, likewise.
"""
from __future__ import annotations

import json
import pathlib
import sys
import time

import numpy as np
from scipy import ndimage as ndi

from app.build_model import (AIR, LUNG, FAT, MUSCLE, BLOOD, SOFT, CARTILAGE, TRABECULAR, CORTICAL, SKIN,
                             materialize, ts_class_map, name_to_material, write_model)
from app.pediatric_src import PED, CHILD, Src

WORK = PED / 'work'
SP = 1.5


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


# ------------------------------------------------------------------------------------------ prep
def prep():
    """The two CTs this needs segmented, as NIfTI: the child's (from the TCIA series zip, see
    requirements-models.txt) and z053's upper body (its build_limbs cache, z 0..480 flipped to LPS: the
    girdle is placed rib by rib, so its ribs need labels); then TotalSegmentator on each, if not done."""
    import subprocess
    import zipfile
    import SimpleITK as sitk
    d = PED / CHILD
    if not (d / 'ct.nii.gz').exists():
        if not (d / 'dicom').is_dir():
            zipfile.ZipFile(d / 'ct_dicom.zip').extractall(d / 'dicom')
        files = [f for f in (d / 'dicom').rglob('*.dcm')]
        r = sitk.ImageSeriesReader()
        r.SetFileNames(r.GetGDCMSeriesFileNames(str(files[0].parent)))
        sitk.WriteImage(sitk.Cast(sitk.DICOMOrient(r.Execute(), 'LPS'), sitk.sitkInt16), str(d / 'ct.nii.gz'))
    z = PED / 'z053_upper'
    if not (z / 'ct.nii.gz').exists():
        from app.pediatric_src import vsd_cache
        hu, _, _, org = vsd_cache('z053')
        k0 = hu.shape[0] - 1 - 480
        img = sitk.GetImageFromArray(np.ascontiguousarray(hu[k0:]).astype(np.int16))
        img.SetSpacing((1.5, 1.5, 1.5)); img.SetOrigin(tuple(org + np.array([0, 0, k0 * 1.5])))
        z.mkdir(parents=True, exist_ok=True)
        sitk.WriteImage(img, str(z / 'ct.nii.gz'))
    ts = pathlib.Path(sys.executable).parent / 'TotalSegmentator.exe'
    for dd in (d, z):
        if not (dd / 'seg.nii').exists():
            subprocess.run([str(ts), '-i', str(dd / 'ct.nii.gz'), '-o', str(dd / 'seg.nii'), '--ml'], check=True)
    log('prep: CTs and labels ready')


# ------------------------------------------------------------------------------------------ child
def child(sp=SP):
    """The child's CT and labels on an isotropic sp grid (antialiased), and its materials.

    Materials as build_model.materialize makes them, with two changes for a child and a contrast CT:
    - labelled bone is NOT forced to bone: materialize turns every voxel of a bone label into
      trabecular or cortical bone, which closes a growth plate (cartilage, ~100 HU) and fills the
      marrow; here bone is what the HU says it is, so the physes, the triradiate cartilage and the
      ring apophyses stay open;
    - this is a contrast CT (IV, portal phase): enhanced blood reads 150-250 HU, which the HU cuts call
      trabecular bone. The great vessels and the solid organs have labels and take their own
      materials; any other bone-dense voxel more than 3 mm from a labelled bone is a vessel: blood."""
    import SimpleITK as sitk
    d = PED / CHILD
    img = sitk.DICOMOrient(sitk.ReadImage(str(d / 'ct.nii.gz')), 'LPS')
    seg = sitk.DICOMOrient(sitk.ReadImage(str(d / 'seg.nii')), 'LPS')
    img = sitk.SmoothingRecursiveGaussian(sitk.Cast(img, sitk.sitkFloat32), 0.4 * sp)
    sz = [int(round(a * b / sp)) for a, b in zip(img.GetSize(), img.GetSpacing())]
    rs = lambda im, interp, dflt: sitk.Resample(im, sz, sitk.Transform(), interp, img.GetOrigin(), (sp,) * 3,
                                                img.GetDirection(), dflt)
    hu = np.round(sitk.GetArrayFromImage(rs(img, sitk.sitkLinear, -1024))).astype(np.int16)
    lab = sitk.GetArrayFromImage(rs(seg, sitk.sitkNearestNeighbor, 0)).astype(np.int16)
    cmap = ts_class_map()
    bone_ids = [i for i, n in cmap.items() if name_to_material(n) == -1]
    nob = np.where(np.isin(lab, bone_ids), 0, lab).astype(np.int32)
    mat, body = materialize(hu, nob, sp)
    bone = np.isin(lab, bone_ids)
    near = ndi.binary_dilation(bone, iterations=max(1, int(round(3.0 / sp))))
    dense = np.isin(mat, [TRABECULAR, CORTICAL])
    mat[dense & ~near] = BLOOD
    log(f'child: {hu.shape} at {sp} mm; {int((dense & ~near).sum())} bone-dense voxels off the bones -> blood')
    org = np.array(img.GetOrigin(), float)
    return dict(hu=hu, lab=lab, mat=mat, body=body, origin=org, sp=sp)


# ------------------------------------------------------------------------------------------ donors
def arm_donor():
    """z053's right arm with its girdle, cleaned as build_limbs makes the upper extremity (the arm
    parted from the trunk along the skin, the bag and tubes pared off, its outline evened), in LPS;
    with its TotalSegmentator labels (thorax crop) on the same grid."""
    import SimpleITK as sitk
    from app.build_limbs import load as cache_load, upper_extremity
    hu, mat, body = cache_load('z053')
    keep = upper_extremity(hu, mat, body, 'z053')          # (clears mat to AIR where it adds outline)
    nz = hu.shape[0]
    hu, mat, keep = hu[::-1].copy(), mat[::-1].copy(), keep[::-1].copy()
    org = np.array([0.0, 0.0, -(nz - 1) * 1.5])
    seg = sitk.ReadImage(str(PED / 'z053_upper' / 'seg.nii'))
    s = sitk.GetArrayFromImage(seg).astype(np.int16)
    k0 = int(round((seg.GetOrigin()[2] - org[2]) / 1.5))
    lab = np.zeros(hu.shape, np.int16)
    lab[k0:k0 + s.shape[0]] = s
    return dict(hu=hu, mat=mat, keep=keep, lab=lab, origin=org, sp=1.5)


def head_donor():
    """s1082 (TotalSegmentator dataset, ground-truth labels) in LPS at 1.5 mm: its CT, labels and
    materials as build_model makes them for the head and neck model; the scanner table and head
    holder behind the head taken off as build_limbs.head_neck does."""
    import SimpleITK as sitk
    from app.pediatric_src import DATA
    d = DATA / 'totalseg' / 's1082'
    img = sitk.DICOMOrient(sitk.ReadImage(str(d / 'ct.nii.gz')), 'LPS')
    seg = sitk.DICOMOrient(sitk.ReadImage(str(d / 'seg_ml.nii.gz')), 'LPS')
    seg = sitk.Resample(seg, img, sitk.Transform(), sitk.sitkNearestNeighbor, 0, seg.GetPixelID())
    hu = sitk.GetArrayFromImage(img).astype(np.int16)
    lab = sitk.GetArrayFromImage(seg).astype(np.int16)
    mat, body = materialize(hu, lab.astype(np.int32), 1.5)
    # the table: per slice, anything more than 4.5 mm behind the back of the deep body (y grows
    # posteriorly in LPS)
    deep = ndi.distance_transform_edt(body) >= 3
    keep = body.copy()
    for z in range(body.shape[0]):
        ys = np.nonzero(deep[z].any(1))[0]
        if len(ys):
            keep[z, ys.max() + 4:] = False
    from app.build_limbs import pare
    keep = pare(keep, r=0)
    mat[~keep] = AIR
    return dict(hu=hu, mat=mat, keep=keep, lab=lab, origin=np.array(img.GetOrigin(), float), sp=1.5)


def leg_donor():
    """The shipped lower extremity (z035's right leg, cleaned and baked to the anatomical position,
    joint spaces cut) as it is: materials at 1 mm, x left, y posterior, z superior. Origin 0."""
    from app.build_limbs import MODELS
    h = json.loads((MODELS / 'lowerextremity' / 'lowerextremity.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    mat = np.fromfile(MODELS / 'lowerextremity' / 'lowerextremity.mat.bin', np.uint8).reshape(nz, ny, nx)
    return dict(mat=mat, keep=mat > 0, origin=np.zeros(3), sp=float(h['spacing'][0]))


# ------------------------------------------------------------------------------------------ fit
# a boy of 11 years at the 50th centile and this one: 140 cm (the DICOM header's PatientSize, 140.1)
STATURE = 1401.0
HEAD_CIRC = 535.0          # mm, an 11-year-old boy's head circumference (CDC/WHO median, 53-54 cm)
# the share of stature from the glenohumeral centre to the fingertips of the hanging arm (adult and
# school-age proportions agree within a centimetre: shoulder 0.80 H, fingertip 0.377 H)
ARM_SHARE = 0.80 - 0.377
# hip joint centre to sole, as a share of stature (Drillis & Contini: greater trochanter 0.53 H)
LEG_SHARE = 0.505


def sim_dict(s, R, t, **kw):
    return dict(s=float(s), R=np.asarray(R).tolist(), t=np.asarray(t).tolist(), **kw)


def fit():
    """Register every donor part onto the child (child points -> donor points). Writes work/fit.json."""
    from app import pediatric_reg as R
    from scipy.spatial import cKDTree
    C = R.label_volume(PED / CHILD / 'seg.nii')
    A = R.label_volume(PED / 'z053_upper' / 'seg.nii')
    out = {}
    # ---- shoulders: the girdle rides the child's upper ribs (their back and side, where the scapula
    # lies; the front of a child's ribs slopes less than an adult's), T1-T7, the sternum and the
    # sternoclavicular joint
    mid = float(np.concatenate([R.label_pts(A, f'vertebrae_T{k}') for k in range(1, 8)])[:, 0].mean())
    for side, mirror in (('right', None), ('left', mid)):
        P, Q, W = R.correspondences(C, A, side, 'right', range(2, 8), [f'T{k}' for k in range(1, 8)],
                                    donor_mirror=mirror, ang_range=(-35, 95), clavicle=True)
        s, Rm, t = R.umeyama(P, Q, W)
        res = np.linalg.norm(s * P @ Rm.T + t - Q, axis=1)
        out[f'girdle_{side}'] = sim_dict(s, Rm, t, mirror=mirror, res=float(res.mean()))
        log(f'girdle {side}: scale {s:.3f}, residual {res.mean():.1f} mm (max {res.max():.1f})')
    # where the girdles hang from on the child: its sternoclavicular joints (the clavicles' medial ends,
    # which raising the arm does not move) and its jugular notch
    st = R.label_pts(C, 'sternum')
    out['child_notch'] = st[st[:, 2] >= st[:, 2].max() - 4].mean(0).tolist()
    for side in ('right', 'left'):
        cl = R.label_pts(C, f'clavicula_{side}')
        out[f'girdle_{side}']['sc'] = cl[np.argsort(np.abs(cl[:, 0] - st[:, 0].mean()))[:80]].mean(0).tolist()
    # the donor arm: glenohumeral centre (sphere through the top of the humeral head) and fingertip
    arm = load('arm')
    src = Src(None, arm['origin'], float(arm['sp']))
    hum = R.label_pts(A, 'humerus_right')
    top = hum[hum[:, 2] >= hum[:, 2].max() - 30]
    gh, r = R.sphere_fit(top)
    kp = src.points(arm['keep'] & (np.arange(arm['keep'].shape[0])[:, None, None] < (gh[2] - arm['origin'][2]) / 1.5 - 20))
    tip = kp[np.argmax(np.linalg.norm(kp - gh, axis=1))]
    hd = hum[hum[:, 2] < gh[2] - 40]
    u = np.linalg.svd(hd - hd.mean(0))[2][0]
    u = u if u[2] < 0 else -u
    out['arm'] = dict(gh=gh.tolist(), r=r, tip=tip.tolist(), length=float(np.linalg.norm(tip - gh)), humerus_axis=u.tolist(),
                      mid=mid)
    log(f'arm donor: GH r {r:.1f} mm, GH-to-fingertip {np.linalg.norm(tip - gh):.0f} mm (target '
        f'{ARM_SHARE * STATURE:.0f} at the child\'s scale)')
    # ---- the neck: the child's T1-T3 (and the part of C7 in its scan) on s1082's, vertebra by vertebra
    H = R.label_volume(R_path_s1082())
    pairs, P0, Q0 = [], [], []
    for v in ('T1', 'T2', 'T3', 'T4', 'C7'):
        a = R.label_pts(C, f'vertebrae_{v}'); b = R.label_pts(H, f'vertebrae_{v}')
        a = a[::max(1, len(a) // 4000)]
        pairs.append((a, b))
        if v != 'C7':
            P0.append(a.mean(0)); Q0.append(b.mean(0))
    s, Rm, t = R.umeyama(np.array(P0), np.array(Q0))
    s, Rm, t, res = R.labelwise_icp(pairs, s, Rm, t)
    # Both lie straight on their tables, so only the column's pitch is the fit's to set: four nearly
    # round vertebrae leave a turn about the column itself free, and the free fit took 17 degrees of yaw
    # and 12 of roll, which turned the whole head. The pitch is the angle between the two columns
    # (T3 -> T1) in the sagittal plane; scale and shift then by least squares on the vertebrae.
    def col(src_):
        a_, b_ = R.label_pts(src_, 'vertebrae_T3').mean(0), R.label_pts(src_, 'vertebrae_T1').mean(0)
        return b_ - a_
    vc, vd = col(C), col(H)
    pitch = np.arctan2(vd[1], vd[2]) - np.arctan2(vc[1], vc[2])
    Rm = R.axis_angle([1.0, 0, 0], -pitch)
    Pm, Qm = np.array(P0), np.array(Q0)
    pc, qc = Pm - Pm.mean(0), Qm - Qm.mean(0)
    s = float((qc * (pc @ Rm.T)).sum() / (pc ** 2).sum())
    t = Qm.mean(0) - s * Rm @ Pm.mean(0)
    from scipy.spatial import cKDTree
    # scale and shift refined on the vertebrae's whole shapes (each matched to its own), the turn held:
    # their centroids' spacing alone (an adult's discs are thicker) gave the neck 0.72 of the donor
    trees = [cKDTree(Q_) for _, Q_ in pairs]
    for _ in range(40):
        A_, B_ = [], []
        for (P_, Q_), tr in zip(pairs, trees):
            d_, i_ = tr.query(s * P_ @ Rm.T + t)
            k_ = d_ <= np.quantile(d_, 0.85)
            A_.append(P_[k_] @ Rm.T); B_.append(Q_[i_[k_]])
        A_, B_ = np.concatenate(A_), np.concatenate(B_)
        ac, bc = A_ - A_.mean(0), B_ - B_.mean(0)
        s = float((ac * bc).sum() / (ac ** 2).sum())
        t = B_.mean(0) - s * A_.mean(0)
    res = [float(np.median(cKDTree(Q_).query(s * P_ @ Rm.T + t)[0])) for P_, Q_ in pairs]
    log(f'neck: pitch {np.degrees(pitch):.1f} deg, scale {s:.3f} (child = {1 / s:.2f} x donor), per-vertebra '
        f'median residual {np.round(res, 1)} mm')
    # where the seam lies: the disc between the child's C7 and T1 (midway between C7's lowest and T1's
    # highest body point, along the column)
    c7, t1 = R.label_pts(C, 'vertebrae_C7'), R.label_pts(C, 'vertebrae_T1')
    # the head's size: the donor's largest skin outline round the cranium
    head = load('head')
    hsrc = Src(None, head['origin'], 1.5)
    sk = R.label_pts(H, 'skull')
    zt = sk[:, 2].max()
    best = 0.0
    for z in np.arange(zt - 80, zt - 30, 1.5):           # above the ears, below the vertex
        k = int(round((z - head['origin'][2]) / 1.5))
        m = head['keep'][k]
        if m.any():
            from skimage.measure import perimeter
            best = max(best, perimeter(R.largest(m)) * 1.5)
    # the column in both: the child's from T3 to T1 (its neck is not in the scan), the donor's T1 to C2
    t3 = R.label_pts(C, 'vertebrae_T3')
    ax_c = t1.mean(0) - t3.mean(0); ax_c /= np.linalg.norm(ax_c)
    # the seam: the child's C7/T1 disc, the point on the column midway between C7's lowest and T1's
    # highest voxel near the column's line (the bodies, not the spinous processes)
    def near_line(p, c):
        d = p - c; return p[np.linalg.norm(d - np.outer(d @ ax_c, ax_c), axis=1) < 9]
    lo7 = near_line(c7, t1.mean(0)); hi1 = near_line(t1, t1.mean(0))
    disc = (lo7[np.argmin(lo7 @ ax_c)] + hi1[np.argmax(hi1 @ ax_c)]) / 2
    ha, hb = R.label_pts(H, 'vertebrae_T1').mean(0), R.label_pts(H, 'vertebrae_C2').mean(0)
    hc1 = R.label_pts(H, 'vertebrae_C1')
    out['neck'] = sim_dict(s, Rm, t, res=res, head_circ_donor=best, k_head=best / HEAD_CIRC,
                           disc=disc.tolist(), axis_child=ax_c.tolist(), donor_t1=ha.tolist(), donor_c2=hb.tolist(),
                           donor_c1_top=float(hc1[:, 2].max()))
    log(f'head: donor circumference {best:.0f} mm -> child at {HEAD_CIRC / best:.3f} of it')
    # ---- legs: hung from the child's femoral heads (fit_legs)
    leg = load_leg()
    cb = load(f'child_{SP:g}')
    yb = cb['origin'][1] + np.nonzero(cb['body'][:int(round(60 / SP))].any((0, 2)))[0].max() * SP   # the buttocks' back
    out.update(fit_legs(C, leg, yb))
    (WORK / 'fit.json').write_text(json.dumps(out, indent=1), encoding='utf-8')
    return out


def R_path_s1082():
    from app.pediatric_src import DATA
    return DATA / 'totalseg' / 's1082' / 'seg_ml.nii.gz'


def load_leg():
    leg = leg_donor()
    bone = np.isin(leg['mat'], [TRABECULAR, CORTICAL])
    lab, n = ndi.label(bone)
    # the femur: the bone piece crossing mid-thigh (the landmarks put the hip 34.9 cm and the knee
    # -5.3 cm from the volume centre; z is index * 1 mm from the bottom)
    nz = leg['mat'].shape[0]
    zm = int(round(nz / 2 + 10 * (34.9 - 5.3) / 2))
    ids = np.unique(lab[zm][lab[zm] > 0])
    sizes = ndi.sum(bone, lab, ids)
    fem = lab == ids[int(np.argmax(sizes))]
    # the femur joins the pelvis through the acetabulum (one piece of bone): find the head's centre as
    # the centre of the sphere through the most bone surface (the head's cortex and the acetabulum's
    # are concentric), near the measured hip landmark; then part them at the joint
    src = Src(None, leg['origin'], leg['sp'])
    from app import pediatric_reg as R
    from scipy.spatial import cKDTree
    surf = src.points(fem & ~ndi.binary_erosion(fem))
    hl = json.loads((pathlib.Path(__file__).resolve().parents[3] / 'apps' / 'web' / 'src' / 'data' / 'landmarks.json')
                    .read_text(encoding='utf-8'))['lowerextremity']['hip']
    n = np.array(leg['mat'].shape[::-1])
    hip = (np.array([hl['x'], hl['y'], hl['z']]) * 10 + (n - 1) / 2 * leg['sp']) + leg['origin']
    tree = cKDTree(surf)
    best = (-1, None, None)
    for rad in (20.0, 22.0, 24.0, 26.0):
        for dx in np.arange(-30, 31, 3.0):
            for dy in np.arange(-30, 31, 3.0):
                for dz in np.arange(-30, 31, 3.0):
                    c = hip + (dx, dy, dz)
                    k = len(tree.query_ball_point(c, rad + 0.75)) - len(tree.query_ball_point(c, rad - 0.75))
                    if k > best[0]:
                        best = (k, c, rad)
    c, rad = best[1], best[2]
    for step in (1.0, 0.33):
        b2 = best
        for dx in np.arange(-3, 3.01, step):
            for dy in np.arange(-3, 3.01, step):
                for dz in np.arange(-3, 3.01, step):
                    cc = c + (dx, dy, dz)
                    for rr in (rad - 1, rad - 0.5, rad, rad + 0.5, rad + 1):
                        k = len(tree.query_ball_point(cc, rr + 0.5)) - len(tree.query_ball_point(cc, rr - 0.5))
                        if k > b2[0]:
                            b2 = (k, cc, rr)
        best = b2; c, rad = best[1], best[2]
    # the head's own radius: the first peak of the surface's radial histogram (the acetabulum's shell
    # lies a joint space further out)
    ds = np.linalg.norm(surf - c, axis=1)
    hist, edges = np.histogram(ds, bins=np.arange(14, 34, 0.5))
    hs = ndi.uniform_filter1d(hist.astype(float), 3)
    pk = [i for i in range(1, len(hs) - 1) if hs[i] >= hs[i - 1] and hs[i] >= hs[i + 1] and hs[i] > 0.4 * hs.max()]
    rad = float(edges[pk[0]] + 0.25) if pk else rad
    log('  radial histogram of the hip surface:', ' '.join(f'{e:.0f}:{h}' for e, h in zip(edges[::2], hist[::2])))
    kk, jj, ii = np.nonzero(fem)
    P = src.origin + np.stack([ii, jj, kk], 1) * src.sp
    d = np.linalg.norm(P - c, axis=1)
    cut = fem.copy()
    cut[kk[(d > rad + 0.5) & (d < rad + 8)], jj[(d > rad + 0.5) & (d < rad + 8)], ii[(d > rad + 0.5) & (d < rad + 8)]] = False
    lab2, _ = ndi.label(cut)
    femur = lab2 == lab2[zm][fem[zm]].max()
    # (the head itself: every bone voxel inside its sphere)
    inside = d <= rad + 0.5
    femur[kk[inside], jj[inside], ii[inside]] = True
    leg['femur'] = femur
    sole = src.points(leg['mat'] > 0)[:, 2].min()
    leg['head'], leg['head_r'], leg['length'] = c, rad, float(c[2] - sole)
    log(f'leg donor: femoral head r {rad:.1f} mm ({best[0]} surface voxels on it), hip centre to sole {c[2] - sole:.0f} mm')
    return leg


def line_fit(P):
    """centroid and unit direction of the best line through points"""
    c = P.mean(0)
    u = np.linalg.svd(P - c)[2][0]
    return c, u


def shaft_centres(F, z0, z1, step=1.0):
    """centroids of a bone's cross-sections between heights z0 and z1 (mm)"""
    out = []
    for z in np.arange(z0, z1, step):
        sl = F[np.abs(F[:, 2] - z) <= step / 2 + 1e-6]
        if len(sl) > 20:
            out.append(sl.mean(0))
    return np.array(out)


def femur_frame(F, head, z_shaft):
    """(shaft point at z_shaft, shaft direction distally, neck direction across the shaft) of a femur's
    points F with its head centre"""
    lo, hi = z_shaft
    S = shaft_centres(F, lo, hi)
    c, u = line_fit(S)
    u = u if u[2] < 0 else -u
    foot = c + ((head - c) @ u) * u                     # the head's foot on the shaft's line
    n = head - foot; n = n - (n @ u) * u; n /= np.linalg.norm(n)
    return c, u, n


def fit_legs(C, leg, child_body=None):
    """Each grafted leg hangs from the child's own hip. The child's scan stops at its lesser
    trochanters: of its femur only the head, neck and trochanters are there, no shaft to follow. So
    the leg is posed as a child lies on a table with the legs straight: the donor's femoral head on
    the child's (centre on centre), its mechanical axis (hip to ankle centre) along the body, a few
    degrees out, tilted so the heel rests on the table where the buttocks do, the foot turned 10
    degrees out; at the child's scale (hip centre to sole, LEG_SHARE of stature). The child keeps its
    proximal femur; below the seam, a few cm under the trochanters, the femur is the donor's, eased
    onto the child's cross-section at the seam (fit `ease`, applied in LegPull). (A free ICP of the
    proximal femur turned the leg 90 degrees out: a child's neck-shaft angle and anteversion are not
    an adult's.) The left leg is the right one mirrored."""
    from app import pediatric_reg as R
    src = Src(None, leg['origin'], leg['sp'])
    ll = json.loads((pathlib.Path(__file__).resolve().parents[3] / 'apps' / 'web' / 'src' / 'data' / 'landmarks.json')
                    .read_text(encoding='utf-8'))['lowerextremity']
    nn = np.array(leg['mat'].shape[::-1])
    lmk = lambda d_: (np.array([d_['x'], d_['y'], d_['z']]) * 10 + (nn - 1) / 2 * leg['sp']) + leg['origin']
    hd = np.array(leg['head']); an = lmk(ll['ankle'])
    body = leg['mat'] > 0
    bp = src.points(body[:int(an[2] - leg['origin'][2])])          # the foot: below the ankle
    toe = bp[np.argmin(bp[:, 1])]                                   # its most anterior point (-y)
    heel = bp[np.argmax(bp[:, 1])]
    Fem = src.points(leg['femur'])
    s0 = leg['length'] / (LEG_SHARE * STATURE)
    yT = None
    if child_body is not None:
        yT = child_body                                             # the table's plane: the child's back
    out = {}
    for side in ('right', 'left'):
        F = R.label_pts(C, f'femur_{side}')
        m = np.zeros(C.arr.shape, bool)
        k, j, i = np.round(C.index(F)).astype(int).T
        m[k, j, i] = True
        surf = C.points(m & ~ndi.binary_erosion(m))
        hc, rc = R.sphere_fit(surf[surf[:, 2] >= surf[:, 2].max() - 15])
        sx = -1.0 if side == 'right' else 1.0
        h2, a2, t2, he2 = hd.copy(), an.copy(), toe.copy(), heel.copy()
        Fm = Fem.copy()
        mirror = None
        if side == 'left':
            mirror = 0.0
            for v_ in (h2, a2, t2, he2):
                v_[0] = -v_[0]
            Fm[:, 0] = -Fm[:, 0]
        md = a2 - h2; md /= np.linalg.norm(md)
        fd = t2 - a2; fd -= (fd @ md) * md; fd /= np.linalg.norm(fd)
        tilt = 0.0
        for it in range(3):
            mc = np.array([sx * np.sin(np.radians(3.0)), np.sin(tilt), -1.0]); mc /= np.linalg.norm(mc)
            out_ang = np.radians(10.0)
            fc = np.array([sx * np.sin(out_ang), -np.cos(out_ang), 0.0]); fc -= (fc @ mc) * mc; fc /= np.linalg.norm(fc)
            Rm = np.column_stack([md, fd, np.cross(md, fd)]) @ np.column_stack([mc, fc, np.cross(mc, fc)]).T
            t = h2 - s0 * Rm @ hc
            S_ = Sim(sim_dict(s0, Rm, t, mirror=mirror))
            hp = S_.push(he2 if mirror is None else np.array([-he2[0], he2[1], he2[2]]))
            if yT is None:
                break
            L = np.linalg.norm(S_.push(a2 if mirror is None else np.array([-a2[0], a2[1], a2[2]])) - hc)
            tilt += np.arcsin(np.clip((yT - hp[1]) / L, -0.3, 0.3))
        # the seam: the child's femur cross-section just above it against the donor's just below
        zc = F[:, 2].min() + LEG_CUT_ABOVE
        cs = F[np.abs(F[:, 2] - (zc + 2)) <= 1.0]
        Fp = S_.push(Fm[::7] if mirror is None else Fm[::7] * np.array([-1, 1, 1]))
        ds = Fp[np.abs(Fp[:, 2] - (zc - 2)) <= 1.5]
        ease = (cs.mean(0) - ds.mean(0)) if len(cs) and len(ds) else np.zeros(3)
        ease[2] = 0.0
        out[f'leg_{side}'] = sim_dict(s0, Rm, t, mirror=mirror, child_head=hc.tolist(), child_head_r=rc,
                                      ease=ease.tolist(), z_cut=float(zc))
        kn, ank, toe_c = S_.push(lmk(ll['knee'])),             S_.push(a2 if mirror is None else a2 * [-1, 1, 1]), S_.push(t2 if mirror is None else t2 * [-1, 1, 1])
        log(f'leg {side}: child head r {rc:.1f} mm at {hc.round(0)}; knee {kn.round(0)}, ankle {ank.round(0)}, toe '
            f'{toe_c.round(0)}; tilt {np.degrees(tilt):.1f} deg; femur eased {np.linalg.norm(ease):.1f} mm at the seam')
    return out


# ------------------------------------------------------------------------------------------ transforms
class Sim:
    """child LPS -> donor LPS: q = s R p + t, then (for a part made from the other side) reflected
    through the plane x = mirror"""
    def __init__(self, d):
        self.s, self.R, self.t = float(d['s']), np.array(d['R']), np.array(d['t'])
        self.mirror = d.get('mirror')

    def pull(self, p):
        q = self.s * p @ self.R.T + self.t
        if self.mirror is not None:
            q[..., 0] = 2 * self.mirror - q[..., 0]
        return q

    def push(self, q):
        q = np.array(q, float, copy=True)
        if self.mirror is not None:
            q[..., 0] = 2 * self.mirror - q[..., 0]
        return (q - self.t) @ self.R / self.s


class LegPull(Sim):
    """The leg's similarity, with two easings over the thigh so that it carries on from the child's
    hip without a step:
    - morph: the donor thigh's outline is drawn out to the child's at the seam, direction by
      direction round the thigh (`k`, the ratio of the two outlines' radii), easing back toward the
      donor's own shape down the leg (MORPH_L), keeping MORPH_KEEP of the widening all the way (this
      child is heavier than the slim donor);
    - ease: the femur's cross-section shifted onto the child's at the seam, fading over EASE below."""
    EASE, MORPH_L, MORPH_KEEP = 70.0, 260.0, 0.3

    def __init__(self, d):
        super().__init__(d)
        self.ease = np.array(d.get('ease', [0, 0, 0]), float)
        self.zc = float(d.get('z_cut', 0.0))
        self.k = None

    def set_morph(self, cs, cd, k, axis):
        self.cs, self.cd, self.k = np.asarray(cs, float), np.asarray(cd, float), np.asarray(k, float)
        self.ax = np.asarray(axis, float) / np.linalg.norm(axis)

    def w(self, z):
        return smoothstep((z - (self.zc - self.EASE)) / self.EASE)

    def morph(self, p):
        if self.k is None:
            return p
        z = p[..., 2]
        w = smoothstep((z - (self.zc - self.MORPH_L)) / self.MORPH_L)
        f = self.MORPH_KEEP + (1 - self.MORPH_KEEP) * w
        line = self.cd[:2] + self.ax[:2] * ((z - self.zc) / self.ax[2])[..., None]
        o = line + w[..., None] * (self.cs[:2] - self.cd[:2])
        v = p[..., :2] - o
        th = np.arctan2(v[..., 1], v[..., 0])
        nb = len(self.k)
        b = (th + np.pi) / (2 * np.pi) * nb - 0.5
        i0 = np.floor(b).astype(int) % nb; fr = b - np.floor(b)
        kk = self.k[i0] * (1 - fr) + self.k[(i0 + 1) % nb] * fr
        g = 1 + (kk - 1) * f
        out = np.array(p, float, copy=True)
        out[..., :2] = line + v / g[..., None]
        return out

    def shift(self, p):
        """the femur's ease: only near the femur (the thigh's outline is the morph's to match)"""
        w = self.w(p[..., 2])
        if getattr(self, 'fs', None) is not None:
            line = self.fs[:2] + self.ax[:2] * ((p[..., 2] - self.zc) / self.ax[2])[..., None]
            rho = np.linalg.norm(p[..., :2] - line, axis=-1)
            w = w * smoothstep((45.0 - rho) / 20.0)
        return w[..., None] * self.ease

    def pull(self, p):
        return super().pull(self.morph(p - self.shift(p)))

    def push(self, q):
        p = super().push(q)
        return p + self.w(p[..., 2])[..., None] * self.ease


def R_largest2d(m):
    lab, n = ndi.label(m)
    if n <= 1:
        return m
    return lab == (int(np.argmax(ndi.sum(m, lab, range(1, n + 1)))) + 1)


def outline(mask, cx, cy, nb=72):
    """radius of a 2-D mask's outline in nb directions round (cx, cy) (index units)"""
    yy, xx = np.nonzero(mask)
    th = np.arctan2(yy - cy, xx - cx)
    r = np.hypot(yy - cy, xx - cx)
    b = ((th + np.pi) / (2 * np.pi) * nb).astype(int) % nb
    R = np.zeros(nb)
    np.maximum.at(R, b, r)
    # empty directions: from their neighbours
    ok = R > 0
    if ok.sum() >= 3:
        idx = np.arange(nb)
        R = np.interp(idx, np.concatenate([idx[ok] - nb, idx[ok], idx[ok] + nb]), np.tile(R[ok], 3))
    return R


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


class ArmPull:
    """The girdle's similarity; the whole girdle then let down about the sternoclavicular joint until
    the glenohumeral centre is level with the jugular notch (GH_BELOW_NOTCH below it), as a child's
    shoulder hangs at rest (the donor's, in its body bag, was shrugged: its humeral head 4 cm above its
    notch); and below the shoulder the arm turned about the glenohumeral centre to hang along the
    child's side (a skinning weight eases the turn in over the joint: nothing above it moves, nor the
    scapula behind it) and scaled about that centre to the child's arm length."""
    ABDUCT, BACK = np.radians(9.0), np.radians(5.0)    # the arm a little out from the side, and down
                                                        # toward the table (the shoulder lies on the scapula)
    GH_BELOW_NOTCH = 2.0

    def __init__(self, girdle, arm, side, notch=None):
        from app import pediatric_reg as R
        self.G = Sim(girdle)
        gh, tip = np.array(arm['gh']), np.array(arm['tip'])
        c0 = self.G.push(gh)
        self.sc = np.array(girdle.get('sc', c0))
        sx = -1.0 if side == 'right' else 1.0           # the patient's right is -x
        self.D = np.eye(3)
        if notch is not None:
            v = c0 - self.sc
            target = notch[2] - self.GH_BELOW_NOTCH
            # turn about the AP axis through the SC joint: z' = sc_z + v_z cos a - (v_x) sin a (x toward
            # the side). Solve for a by bisection
            def zof(a):
                Ra = R.axis_angle([0, 1.0, 0], a)
                return (self.sc + Ra @ v)[2]
            lo_, hi_ = -0.6, 0.6
            if (zof(lo_) - target) * (zof(hi_) - target) < 0:
                for _ in range(60):
                    mid_ = (lo_ + hi_) / 2
                    if (zof(lo_) - target) * (zof(mid_) - target) <= 0:
                        hi_ = mid_
                    else:
                        lo_ = mid_
                self.D = R.axis_angle([0, 1.0, 0], (lo_ + hi_) / 2)
                log(f'  arm {side}: girdle let down {np.degrees((lo_ + hi_) / 2):+.1f} deg about the SC joint '
                    f'(GH z {c0[2]:.0f} -> {target:.0f})')
        self.c = self.sc + self.D @ (c0 - self.sc)
        d0 = self.D @ (self.G.push(tip) - c0)
        L = np.linalg.norm(d0); d0 /= L
        d1 = np.array([sx * np.sin(self.ABDUCT), np.sin(self.BACK), -np.cos(self.ABDUCT)])
        self.d1 = d1 / np.linalg.norm(d1)
        Rm = R.rot_between(d0, self.d1)
        ang = np.arccos(np.clip((np.trace(Rm) - 1) / 2, -1, 1))
        ax = np.array([Rm[2, 1] - Rm[1, 2], Rm[0, 2] - Rm[2, 0], Rm[1, 0] - Rm[0, 1]])
        self.axis = ax / max(1e-9, np.linalg.norm(ax)); self.ang = ang
        self.lam = ARM_SHARE * STATURE / L                # the arm's length correction
        log(f'  arm {side}: turned {np.degrees(ang):.1f} deg to hang, length x {self.lam:.3f}')

    def weight(self, p):
        v = p - self.c
        t = v @ self.d1
        rho = np.linalg.norm(v - t[..., None] * self.d1, axis=-1)
        # near the shoulder only the arm's own column turns (not the scapula behind it); further down
        # everything does, however far the hand lies from the line (z053's curls in toward the thigh)
        near = np.maximum(smoothstep((75.0 - rho) / 25.0), smoothstep((t - 90.0) / 40.0))
        return smoothstep((t + 5.0) / 40.0) * near

    def pull(self, p):
        w = self.weight(p)
        v = p - self.c
        # rotate by -ang*w about the axis (Rodrigues, per point) and undo the length scale
        a = -self.ang * w
        k = self.axis
        cos, sin = np.cos(a)[..., None], np.sin(a)[..., None]
        v = v * cos + np.cross(k, v) * sin + (v @ k)[..., None] * k * (1 - cos)
        v = v / (1 + (self.lam - 1) * w)[..., None]
        p1 = self.c + v
        p2 = self.sc + (p1 - self.sc) @ self.D          # (D^T applied to row vectors)
        return self.G.pull(p2)

    def push(self, q):
        """approximate inverse (for the grid's bounds): the girdle's, then the turn at full weight"""
        from app import pediatric_reg as R
        p = self.sc + (self.G.push(q) - self.sc) @ self.D.T
        v = p - self.c
        w = self.weight(p)
        Rm = R.axis_angle(self.axis, self.ang)
        vr = v @ Rm.T * self.lam
        return self.c + v + (vr - v) * w[..., None]


class HeadPull:
    """The neck's similarity (the child's T1-T4 on the donor's) at the C7/T1 seam, easing up the neck
    to the head's own scale: the child's cranium is a larger share of the child than the donor's of
    the donor. In the donor frame, height h runs up the donor's column from its T1 (toward C2); a
    point's height is remapped by the integral of the local scale ratio r(h) (1 at the seam, r_head
    from C2 up) and its offset from the column's line scaled by r: a similarity in the neck below and
    in the head above, smooth between."""
    def __init__(self, neck):
        self.N = Sim(neck)
        self.a = np.array(neck['donor_t1']); e = np.array(neck['donor_c2']) - self.a
        self.e = e / np.linalg.norm(e)
        # the child's head: k_head (donor/child) instead of the neck's s
        self.r_head = float(neck['k_head']) / self.N.s
        hs = (self.N.pull(np.array(neck['disc'])) - self.a) @ self.e        # the seam's height
        self.h0, self.h1 = hs, (np.array(neck['donor_c2']) - self.a) @ self.e  # ease from seam to C2
        hh = np.linspace(-400, 600, 4001)
        r = 1 + (self.r_head - 1) * smoothstep((hh - self.h0) / (self.h1 - self.h0))
        # a child's neck is long for its width: lengthened by NECK_STRETCH between the seam and C2 (a
        # bump that is 1 at both ends, so the spine and the skull keep their own proportions)
        u_ = np.clip((hh - self.h0) / (self.h1 - self.h0), 0, 1)
        ax_ = 1 + (NECK_STRETCH - 1) * np.sin(np.pi * u_) ** 2
        r = r                                             # (lateral scale)
        ra = r / ax_                                      # donor mm per child-frame mm along the column
        Phi = np.concatenate([[0], np.cumsum((ra[1:] + ra[:-1]) / 2 * np.diff(hh))])
        Phi -= np.interp(0.0, hh, Phi)
        self.hh, self.r, self.Phi = hh, r, Phi
        # the head itself lies as the donor's did on its table (straight, face up): the neck's pitch
        # is undone up the neck, about the seam
        from app import pediatric_reg as R
        Rn = self.N.R
        D = Rn.T                       # donor-frame turn taking the neck-fitted head back to the donor's own
        ang = np.arccos(np.clip((np.trace(D) - 1) / 2, -1, 1))
        ax = np.array([D[2, 1] - D[1, 2], D[0, 2] - D[2, 0], D[1, 0] - D[0, 1]])
        self.rax = ax / max(1e-9, np.linalg.norm(ax)); self.rang = ang
        self.pivot = self.N.pull(np.array(neck['disc']))
        log(f'  head: neck x {1 / self.N.s:.3f}, head x {1 / float(neck["k_head"]):.3f} of the donor; '
            f'eased from h {self.h0:.0f} to {self.h1:.0f} mm')

    def turn(self, q0, sign=1.0):
        h = (q0 - self.a) @ self.e
        w = smoothstep((h - self.h0) / (self.h1 - self.h0))
        a = sign * self.rang * w
        k = self.rax
        v = q0 - self.pivot
        cos, sin = np.cos(a)[..., None], np.sin(a)[..., None]
        v = v * cos + np.cross(k, v) * sin + (v @ k)[..., None] * k * (1 - cos)
        return self.pivot + v

    def pull(self, p):
        q0 = self.turn(self.N.pull(p))
        v = q0 - self.a
        h = v @ self.e
        perp = v - h[..., None] * self.e
        H = np.interp(h, self.hh, self.Phi)
        r = np.interp(H, self.Phi, self.r)
        return self.a + H[..., None] * self.e + perp * r[..., None]

    def push(self, q):
        v = q - self.a
        H = v @ self.e
        perp = v - H[..., None] * self.e
        r = np.interp(H, self.Phi, self.r)
        h = np.interp(H, self.Phi, self.hh)
        q0 = self.a + h[..., None] * self.e + perp / r[..., None]
        return self.N.push(self.turn(q0, -1.0))


# ------------------------------------------------------------------------------------------ compose
# the child's shoulder zone, which the grafted girdle replaces: outside the rib cage (+ a margin of
# chest wall) and above a level that is low behind and at the side (below the scapula's inferior
# angle) and high in front (only the clavicle's region: the pectoral wall below it stays the child's)
CAGE_MARGIN = 6.0          # mm of the child's chest wall kept outside its ribs
LAT_WALL = 22.0            # mm of the child's chest wall kept at the side below the axilla
SDF_BLEND = 22.0           # mm, the ownership blur of the shoulders' signed-distance blend
SHOULDER_CLOSE = 12.0      # mm, the ball that rounds the grafted shoulders into the child's chest and back
BLEND = 14.0               # mm, the ownership blur that eases the skin across a seam
LEG_CUT_ABOVE = 16.0       # mm above the bottom of the child's scan: the femoral seam
NECK_R0, NECK_R1, NECK_FULL = 32.0, 60.0, 40.0   # mm: the head donor's neck column over the girdles'
NECK_STRETCH = 1.15        # the neck's length over the vertebral fit's, at its middle
SEAM_DITHER = 25.0         # mm either side of the femoral seam over which the thighs' soft tissue is dithered
FEMUR_BAND = (13.0, 22.0)  # mm below and above the femoral seam over which the two femurs' shapes blend


def classify(hu, lab=None):
    """HU -> materials as build_model.materialize, without its body and skin (laid on the whole
    later) and without forcing labelled bone; organ labels as there."""
    m = np.full(hu.shape, SOFT, np.uint8)
    m[hu < -190] = LUNG
    m[(hu >= -190) & (hu < -30)] = FAT
    m[(hu >= -30) & (hu < 120)] = MUSCLE
    m[(hu >= 120) & (hu < 300)] = TRABECULAR
    m[hu >= 300] = CORTICAL
    m[hu < -900] = AIR
    if lab is not None:
        cmap = ts_class_map()
        for lid in np.unique(lab):
            if lid == 0:
                continue
            mm = name_to_material(cmap[int(lid)])
            if mm != -1:
                m[lab == lid] = mm
    return m


def child_zone(c, fitd, gh_z):
    """The child's shoulder zone (bool, child grid): what the grafted girdles' tissue replaces. With
    the arms raised the child's shoulders, axillae and the folds running up to the arms (pectoralis,
    latissimus) are no shape for an arm at the side, so at the SIDE of the chest everything outside the
    rib cage is the donor's: CAGE_MARGIN of chest wall kept down to the axilla (45 mm below the
    glenohumeral centre), LAT_WALL below it, down to below the scapulae; the side's extent eased over 30
    degrees round the chest (40-70 and 110-140 degrees from straight ahead), so the cut is a smooth
    surface. Above the cage, all but a column round the neck. In front and all down the back the child
    keeps its own chest wall, skin and fat: the donor's back and chest, laid there, stood proud of the
    child's (a heavier child than the donor) or short of it. Its own scapulae and clavicles lie where
    the raised arms took them: they become muscle, and the donor's (placed by the same fit) are set
    into its back and front as bone (compose). Returns (zone, cage hull + margin, the child's girdle
    bones, the zone's lowest level)."""
    from skimage.morphology import convex_hull_image
    cmap = ts_class_map(); ids = {v: k for k, v in cmap.items()}
    lab, body, sp, org = c['lab'], c['body'], float(c['sp']), c['origin']
    nz, ny, nx = lab.shape
    cage_names = [n for n in ids if n.startswith('rib_') or n.startswith('vertebrae_T') or n in ('sternum', 'costal_cartilages')]
    cage = np.isin(lab, [ids[n] for n in cage_names])
    girdle = np.isin(lab, [ids[n] for n in ('scapula_left', 'scapula_right', 'clavicula_left', 'clavicula_right',
                                             'humerus_left', 'humerus_right')])
    zc = org[2] + np.arange(nz) * sp
    sc = np.isin(lab, [ids['scapula_left'], ids['scapula_right']])
    z_back = zc[np.nonzero(sc.any((1, 2)))[0].min()] - 20.0
    z_lat = gh_z - 45.0
    zone = np.zeros_like(body)
    hull = np.zeros_like(body)
    mg = max(1, int(round(CAGE_MARGIN / sp)))
    yy, xx = np.mgrid[:ny, :nx]
    neck = np.array(fitd['neck']['disc'])
    sstep = lambda x: np.clip(x, 0, 1) ** 2 * (3 - 2 * np.clip(x, 0, 1))
    for k in range(nz):
        if cage[k].sum() > 30:
            hull[k] = convex_hull_image(cage[k])
        if zc[k] < z_back:
            continue
        hk = hull[k]
        if hk.any():
            cy, cx = np.nonzero(hk); cy, cx = cy.mean(), cx.mean()
            th = np.degrees(np.arctan2(np.abs(xx - cx), -(yy - cy)))     # 0 ahead, 90 at the side
            dh = ndi.distance_transform_edt(~hk) * sp                     # mm outside the cage
            # how much chest wall the child keeps, by direction: at the side CAGE_MARGIN high up, the
            # full chest wall (LAT_WALL) from the axilla down, everything in front and behind; the
            # change eased over 30 degrees so the cut runs smoothly round the chest
            m_lat = CAGE_MARGIN + (LAT_WALL - CAGE_MARGIN) * sstep((z_lat - zc[k]) / 30.0)
            ws = sstep((th - 40) / 30) * sstep((140 - th) / 30)
            margin = m_lat / np.maximum(ws, 1e-3)
            # (in front the child keeps all of its chest wall up to the neck, the clavicles' region too:
            # the donor's in-front tissue below its clavicle is not grafted (a woman's breast), and
            # where its clavicle came to lie lower than the child's raised one the two left a gap)
            zone[k] = body[k] & (dh > margin)
        else:
            # above the cage, the child's neck is a column round the spine: its own (r 40 mm) out to
            # the seam; anything further out is the raised arms' and goes
            cx, cy = (neck[0] - org[0]) / sp, (neck[1] - org[1]) / sp
            zone[k] = body[k] & (np.hypot((xx - cx) * sp, (yy - cy - 18 / sp) * sp) > 40.0)
    hull = ndi.binary_dilation(hull, iterations=mg)
    zone |= ndi.binary_dilation(girdle, iterations=max(1, int(round(4 / sp)))) \
        & body & ~hull & ndi.binary_dilation(zone, iterations=max(1, int(round(25 / sp))))
    log(f'child shoulder zone: {zone.sum() * sp ** 3 / 1000:.0f} cm3 (the side down to z {z_back:.0f}, the axilla at {z_lat:.0f})')
    return zone, hull, girdle, z_back


def pull_box(arr, src_org, src_sp, pull, P, mask, sp, n=2):
    """the mean of arr over each child voxel's footprint (n x n x n points across it, each pulled
    and interpolated linearly) where mask, -1024 elsewhere: an anti-aliased resample. A single point
    per voxel, pulled at a scale of 0.75-0.9, beat against the donor's grid: the vault of a lateral
    skull printed in bands as its thin tables were sampled at their peak in one row and between voxels
    the next."""
    out = np.full(mask.shape, -1024.0, np.float32)
    if not mask.any():
        return out
    pts = P[mask]
    acc = np.zeros(len(pts), np.float32)
    offs = (np.arange(n) + 0.5) / n - 0.5
    for dx in offs:
        for dy in offs:
            for dz in offs:
                q = pull(pts + np.array([dx, dy, dz]) * sp)
                acc += pull_sample(arr, src_org, src_sp, q, 1)
    out[mask] = acc / n ** 3
    return out


def pull_sample(arr, src_org, src_sp, q, order):
    """values of arr [z,y,x] (frame src_org, src_sp) at LPS points q [...,3]; outside -> 0/-1024"""
    idx = ((q - src_org) / src_sp)[..., ::-1]
    coords = np.moveaxis(idx, -1, 0).reshape(3, -1)
    cval = -1024 if arr.dtype == np.int16 and order > 0 else 0
    v = ndi.map_coordinates(arr, coords, order=order, mode='constant', cval=cval, prefilter=False)
    return v.reshape(q.shape[:-1])


# ------------------------------------------------------------------------------------------ physes
# An 11-year-old's long bones still grow from cartilage plates near their ends; an adult's are closed
# (a faint scar at most). On a child's film the plate is a lucent line across the bone between the
# metaphysis and the epiphysis. They are cut into the grafted bones, in the donor's frame, as discs of
# cartilage across the bone's cross-section (the bone's own piece in that slice: not the patella beside
# the femur, not the fibula beside the tibia unless it is the fibula's plate), PHYSIS_MM thick, at the
# distance from the joint an 11-year-old's plate lies, scaled to the donor (mm in the donor's frame):
#   leg (z035, joints from the lower extremity's landmarks): distal femur 22 above the knee's joint
#   space, proximal tibia 24 below it, proximal fibula 32 below it; distal tibia 18 above the ankle's
#   joint, distal fibula 10 above it;
#   arm (z053): proximal humerus 25 below the head's top; distal radius 15 and ulna 12 above the
#   radiocarpal joint (z -558 in z053's frame).
# A flat disc where the real plate undulates (the distal femur's is a shallow W): the lucent line is
# what a film shows, and it shows there.
PHYSIS_MM = 3.0


def cut_plate(mat, k_lo, k_hi, pick, bone=(TRABECULAR, CORTICAL)):
    """cartilage across one bone between slices k_lo..k_hi: in each slice, the 2-D bone piece chosen
    by pick(labels, sizes, centroids) -> label (or None); returns the voxels cut"""
    n = 0
    for k in range(k_lo, k_hi + 1):
        b = np.isin(mat[k], bone)
        lab, nb = ndi.label(b)
        if nb == 0:
            continue
        sizes = np.asarray(ndi.sum(b, lab, range(1, nb + 1)))
        cents = np.asarray(ndi.center_of_mass(b, lab, range(1, nb + 1)))
        i = pick(lab, sizes, cents)
        if i is None:
            continue
        sel = ndi.binary_fill_holes(lab == i)         # the marrow inside too: the plate spans the bone
        mat[k][sel] = CARTILAGE
        n += int(sel.sum())
    return n


def leg_physes(l_mat, leg):
    ll = json.loads((pathlib.Path(__file__).resolve().parents[3] / 'apps' / 'web' / 'src' / 'data' / 'landmarks.json')
                    .read_text(encoding='utf-8'))['lowerextremity']
    sp = leg['sp']; nz = l_mat.shape[0]
    zk = int(round(ll['knee']['z'] * 10 / sp + (nz - 1) / 2))
    za = int(round(ll['ankle']['z'] * 10 / sp + (nz - 1) / 2))
    h = max(1, int(round(PHYSIS_MM / sp)))
    largest = lambda lab, sz, c: int(np.argmax(sz)) + 1
    def second_lateral(lab, sz, c):
        # the fibula: the second piece, lateral of the tibia (x low = the patient's right: lateral of a
        # right leg's tibia is lower x)
        if len(sz) < 2:
            return None
        o = np.argsort(sz)[::-1]
        t, f = o[0], o[1]
        return int(f) + 1 if c[f][1] < c[t][1] and sz[f] > 8 else None
    out = {}
    for nm, k, pick in (('distal femur', zk + 22, largest), ('proximal tibia', zk - 24, largest),
                        ('proximal fibula', zk - 32, second_lateral), ('distal tibia', za + 18, largest),
                        ('distal fibula', za + 10, second_lateral)):
        kk = int(round(k / sp)) if sp != 1.0 else k
        out[nm] = cut_plate(l_mat, kk, kk + h - 1, pick)
    log('  leg physes: ' + ', '.join(f'{k} {v}' for k, v in out.items()))


def arm_physes(a_mat, arm, fitd):
    from app import pediatric_reg as R
    org = arm['origin']; sp = float(arm['sp'])
    zi = lambda z: int(round((z - org[2]) / sp))
    h = max(1, int(round(PHYSIS_MM / sp)))
    hum_top = float(fitd['arm']['gh'][2]) + float(fitd['arm']['r'])
    ids = {v: k for k, v in ts_class_map().items()}
    hum = arm['lab'] == ids['humerus_right']
    out = {}
    # the humerus: the piece overlapping its label
    k0 = zi(hum_top - 25)
    n = 0
    for k in range(k0 - h + 1, k0 + 1):
        b = np.isin(a_mat[k], [TRABECULAR, CORTICAL])
        lab, nb = ndi.label(b)
        if nb == 0:
            continue
        ov = ndi.sum(hum[k], lab, range(1, nb + 1))
        if np.max(ov) <= 0:
            continue
        sel = ndi.binary_fill_holes(lab == int(np.argmax(ov)) + 1)
        a_mat[k][sel] = CARTILAGE; n += int(sel.sum())
    out['proximal humerus'] = n
    # the forearm: radius (the larger piece) and ulna at the wrist, in the arm's own region
    keep = arm['keep']
    def piece(rank):
        def f(lab, sz, c):
            o = np.argsort(sz)[::-1]
            return int(o[rank]) + 1 if len(sz) > rank and sz[o[rank]] > 10 else None
        return f
    m2 = np.where(keep, a_mat, AIR)
    for nm, z, rank in (('distal radius', -558 + 15, 0), ('distal ulna', -558 + 12, 1)):
        k = zi(z)
        before = (m2 == CARTILAGE).copy()
        out[nm] = cut_plate(m2, k, k + h - 1, piece(rank))
        a_mat[(m2 == CARTILAGE) & ~before] = CARTILAGE
    log('  arm physes: ' + ', '.join(f'{k} {v}' for k, v in out.items()))


def compose(sp=SP, out_name='pediatric'):
    fitd = json.loads((WORK / 'fit.json').read_text(encoding='utf-8'))
    c = load(f'child_{sp:g}')
    arm = load('arm'); head = load('head'); leg = load_leg()
    log('transforms')
    T = {'armR': ArmPull(fitd['girdle_right'], fitd['arm'], 'right', np.array(fitd['child_notch'])),
         'armL': ArmPull(fitd['girdle_left'], fitd['arm'], 'left', np.array(fitd['child_notch'])),
         'head': HeadPull(fitd['neck']),
         'legR': LegPull(fitd['leg_right']), 'legL': LegPull(fitd['leg_left'])}
    corg, csp = c['origin'], float(c['sp'])
    cbody = c['body']
    cz = corg[2] + np.arange(cbody.shape[0]) * csp
    z_cut = float(fitd['leg_right']['z_cut'])
    disc = np.array(fitd['neck']['disc']); axc = np.array(fitd['neck']['axis_child'])
    x_mid = float(np.array(fitd['neck']['disc'])[0])
    zone, hull, c_girdle, c_zone_low = child_zone(c, fitd, float(T['armR'].c[2]))
    cids = {v: k for k, v in ts_class_map().items()}
    lsrc = Src(None, leg['origin'], leg['sp'])
    # the leg donor's bone below the seam is its femur and what lies below it; its hemipelvis (the
    # ischium reaches below the child's seam) is not grafted
    l_mat = leg['mat'].copy()
    # (the femur piece found at the hip still carries some of the pelvis below the seam: the ischium
    # and pubis lie 4-6 cm medial of the femoral shaft, so below the head's centre only bone within
    # 30 mm of the shaft's axis is the femur's, down to mid-thigh)
    Fd_ = lsrc.points(leg['femur'])
    hd_ = np.array(leg['head'])
    sd_, ud_, _ = femur_frame(Fd_[::5], hd_, (hd_[2] - 250, hd_[2] - 90))
    lz = leg['origin'][2] + np.arange(l_mat.shape[0]) * leg['sp']
    lyy, lxx = np.meshgrid(leg['origin'][1] + np.arange(l_mat.shape[1]) * leg['sp'],
                           leg['origin'][0] + np.arange(l_mat.shape[2]) * leg['sp'], indexing='ij')
    lbone = np.isin(l_mat, [TRABECULAR, CORTICAL])
    for k in range(l_mat.shape[0]):
        if not (hd_[2] - 260 < lz[k] < hd_[2] + 40) or not lbone[k].any():
            continue
        a_ = sd_ + ((lz[k] - sd_[2]) / ud_[2]) * ud_
        far = np.hypot(lxx - a_[0], lyy - a_[1]) > 30.0
        if lz[k] < hd_[2] - 30:
            l_mat[k][lbone[k] & far] = MUSCLE
    l_mat[lbone & ~leg['femur']] = MUSCLE
    leg_physes(l_mat, leg)
    l_phi = ndi.gaussian_filter(leg['keep'].astype(np.float32), 0.6)
    lf = leg['femur']
    # the thigh's outline at the seam: the child's (just above) against the donor's (just below), and
    # the two femurs' cross-sections
    ks = int(round((z_cut + 1.5 - corg[2]) / csp))
    for nm, side, sgn in (('legR', 'right', -1), ('legL', 'left', 1)):
        L_ = T[nm]
        L_.ease = np.zeros(3)
        xs_ = corg[0] + np.arange(cbody.shape[2]) * csp
        half = cbody[ks] & ((xs_ - x_mid) * sgn > 0)[None, :]
        half = R_largest2d(half)
        cy_, cx_ = [a.mean() for a in np.nonzero(half)]
        cs_ = corg + np.array([cx_, cy_, ks]) * csp
        Yc, Xc = np.meshgrid(corg[1] + np.arange(cbody.shape[1]) * csp, xs_, indexing='ij')
        Pz = np.stack([Xc, Yc, np.full_like(Xc, z_cut - 1.5)], -1)
        dm = (pull_sample(l_phi, leg['origin'], leg['sp'], L_.pull(Pz), 1) > 0.5) & ((Xc - x_mid) * sgn > 0)
        dm = R_largest2d(dm)
        dy_, dx_ = [a.mean() for a in np.nonzero(dm)]
        cd_ = corg + np.array([dx_, dy_, 0]) * csp; cd_[2] = z_cut
        Rc, Rd = outline(half, cx_, cy_), outline(dm, dx_, dy_)
        k_ = ndi.uniform_filter1d(np.clip(Rc / np.maximum(Rd, 1), 0.85, 1.8), 5, mode='wrap')
        hip_, ank_ = L_.push(np.array(leg['head'])), L_.push(np.array(leg['head']) - np.array([0, 0, 600.0]))
        L_.set_morph(cs_, cd_, k_, ank_ - hip_)
        # the femur: the child's cross-section centroid just above the seam against the donor's just
        # below it, after the morph
        cf = (c['lab'][ks + 1] == cids[f'femur_{side}'])
        Pz[..., 2] = z_cut - 2.0
        df = pull_sample(lf.astype(np.uint8), leg['origin'], leg['sp'], L_.pull(Pz), 0) > 0
        df &= (Xc - x_mid) * sgn > 0
        if cf.any() and df.any():
            a_ = np.array([np.nonzero(cf)[1].mean(), np.nonzero(cf)[0].mean()]) * csp
            b_ = np.array([np.nonzero(df)[1].mean(), np.nonzero(df)[0].mean()]) * csp
            L_.ease = np.array([*(a_ - b_), 0.0])
            L_.fs = corg + np.array([a_[0], a_[1], 0.0]); L_.fs[2] = z_cut
            area = cf.sum() / max(1, df.sum())
        else:
            area = float('nan')
        log(f'  {nm}: thigh outline x {np.round([k_.min(), k_.mean(), k_.max()], 2)} at the seam; femur eased '
            f'{np.linalg.norm(L_.ease):.1f} mm, child/donor femur section {area:.2f}')

    # ---- donor regions (in their own frames) -----------------------------------------------------
    # the arm donor: the whole body on the right of its midline down to below its scapula, and the arm
    # as build_limbs parts it from the trunk below the axilla
    from app.build_limbs import pare
    amid = float(fitd['arm']['mid'])
    asrc = Src(None, arm['origin'], 1.5)
    ids = {v: k for k, v in ts_class_map().items()}
    sc = arm['lab'] == ids['scapula_right']
    sc = Src(None, arm['origin'], 1.5).points(sc)
    z_scap_d = np.percentile(sc[:, 2], 1)
    anz = arm['hu'].shape[0]
    azc = arm['origin'][2] + np.arange(anz) * 1.5
    axs = arm['origin'][0] + np.arange(arm['hu'].shape[2]) * 1.5
    abody = arm['hu'] > -400
    abody[-6:] = False                    # the scan's first slices (its top): a sheet lay over the neck
    abody = pare(abody & (azc[:, None, None] > z_scap_d - 40), r=2)
    # of the donor's trunk only the shoulder: behind and at the side down to below the scapula, in
    # front only the clavicle's level (its chest wall and breast in front stay out: the child's own
    # pectoral wall is kept, and a 57-year-old woman's breast does not belong on it)
    ayc = arm['origin'][1] + np.arange(arm['hu'].shape[1]) * 1.5
    cage_d = np.isin(arm['lab'], [ids[n] for n in ids if n.startswith('rib_') or n.startswith('vertebrae_T')
                                  or n in ('sternum', 'costal_cartilages')])
    clv = asrc.points(arm['lab'] == ids['clavicula_right'])
    z_front_d = np.percentile(clv[:, 2], 2) - 15.0
    cz_ = np.nonzero(cage_d.any((1, 2)))[0]
    cen = np.full((anz, 2), np.nan)
    for k in cz_:
        yy_, xx_ = np.nonzero(cage_d[k]); cen[k] = (xx_.mean(), yy_.mean())
    for a_ in (0, 1):
        ok_ = ~np.isnan(cen[:, a_])
        cen[:, a_] = np.interp(np.arange(anz), np.nonzero(ok_)[0], cen[ok_, a_])
    front = np.zeros_like(abody)
    XX, YY = np.meshgrid(np.arange(arm['hu'].shape[2]), np.arange(arm['hu'].shape[1]))
    for k in range(anz):
        if azc[k] > z_front_d or not abody[k].any():
            continue
        th = np.degrees(np.arctan2(np.abs(XX - cen[k, 0]), -(YY - cen[k, 1])))
        front[k] = th < 55
    # below the axilla the donor's side (the chest wall under the arm) is not taken either: there the
    # arm is the arm as build_limbs parts it, smooth, and the back keeps the scapula's lower half
    z_ax_d = -75 * 1.5                                    # z053's axillary fold (build_limbs.ARMS)
    lateral = np.zeros_like(abody)
    for k in range(anz):
        if azc[k] >= z_ax_d or not abody[k].any():
            continue
        th = np.degrees(np.arctan2(np.abs(XX - cen[k, 0]), -(YY - cen[k, 1])))
        # (and of the back only the scapula's width from the spine: further out is the arm's own back)
        lateral[k] = (th < 115) | (np.abs(axs[None, :] - amid) > 110.0)
    a_reg = (abody & (axs[None, None, :] < amid) & ~front & ~lateral) | arm['keep']
    # the donor's own trunk (ribs, spine, sternum, lungs, heart, great vessels) is never grafted: where
    # its outline reaches past the child's cage it becomes muscle
    trunk_names = [n for n in ids if n.startswith(('rib_', 'vertebrae_', 'lung_', 'heart', 'aorta', 'sternum',
                                                   'costal', 'trachea', 'esophagus', 'pulmonary', 'superior_vena',
                                                   'brachiocephalic', 'subclavian', 'common_carotid', 'atrial'))]
    a_trunk = np.isin(arm['lab'], [ids[n] for n in trunk_names])
    # the head donor's region: its head and neck above the seam, and of the neck no more than a column
    # round it (its shoulders and arms are not taken)
    H = T['head']
    hsrc = Src(None, head['origin'], 1.5)
    h_lab = head['lab']
    c4 = hsrc.points(h_lab == ids['vertebrae_C4']).mean(0)
    ant = np.array([0.0, -1.0, 0.0]); ant = ant - (ant @ H.e) * H.e; ant /= np.linalg.norm(ant)
    ncen = c4 + 22.0 * ant
    c3_h = (hsrc.points(h_lab == ids['vertebrae_C3']).mean(0) - ncen) @ H.e
    h_reg = np.zeros_like(head['keep'])
    hy_, hx_ = np.meshgrid(head['origin'][1] + np.arange(head['mat'].shape[1]) * 1.5,
                           head['origin'][0] + np.arange(head['mat'].shape[2]) * 1.5, indexing='ij')
    for k in range(head['mat'].shape[0]):
        v = np.stack([hx_, hy_, np.full_like(hx_, head['origin'][2] + k * 1.5)], -1) - ncen
        hgt = v @ H.e
        rho = np.linalg.norm(v - hgt[..., None] * H.e, axis=-1)
        h_reg[k] = head['keep'][k] & ((rho < 68.0) | (hgt > c3_h))
    log('donor regions ready')

    # ---- the grid's bounds: the child's body and every part pushed into the child's frame ---------
    pts = [corg + np.stack(np.nonzero(cbody[::4, ::4, ::4])[::-1], 1) * csp * 4]
    def pushed(name, mask, src, step=3, keep_fn=None):
        p = src.points(mask[::step, ::step, ::step]) if step == 1 else \
            (src.origin + np.stack(np.nonzero(mask[::step, ::step, ::step])[::-1], 1) * src.sp * step)
        q = T[name].push(p)
        return q if keep_fn is None else q[keep_fn(q)]
    above = lambda q: (q - disc) @ axc > -20
    below = lambda q: q[:, 2] < z_cut + 20
    pts.append(pushed('head', h_reg, hsrc, keep_fn=above))
    for nm in ('armR', 'armL'):
        pts.append(pushed(nm, a_reg, asrc))
    for nm in ('legR', 'legL'):
        pts.append(pushed(nm, leg['keep'], lsrc, keep_fn=below))
    allp = np.concatenate(pts)
    lo = allp.min(0) - 30; hi = allp.max(0) + 30
    lo = np.minimum(lo, corg); hi = np.maximum(hi, corg + (np.array(cbody.shape[::-1]) - 1) * csp)
    lo = corg + np.floor((lo - corg) / sp) * sp
    n = np.ceil((hi - lo) / sp).astype(int) + 1
    log(f'grid: {n} at {sp} mm ({np.prod(n) / 1e6:.1f} M voxels), lo {lo.round(1)}')
    nx, ny, nz = n
    off = np.round((corg - lo) / sp).astype(int)          # child grid index offset (x, y, z)

    # ---- per part: pulled HU/materials, occupancy (phi) and candidacy, slab by slab ---------------
    parts = ['child', 'head', 'armR', 'armL', 'legR', 'legL']
    phi = {p: np.zeros((nz, ny, nx), np.float16) for p in parts}
    cand = {p: np.zeros((nz, ny, nx), bool) for p in parts}
    mats = {p: np.zeros((nz, ny, nx), np.uint8) for p in parts}
    labs = {p: np.zeros((nz, ny, nx), np.int16) for p in ('child', 'head', 'armR', 'armL')}
    # the child, by index
    cs = (slice(off[2], off[2] + cbody.shape[0]), slice(off[1], off[1] + cbody.shape[1]), slice(off[0], off[0] + cbody.shape[2]))
    cphi = ndi.gaussian_filter(cbody.astype(np.float32), 0.6)
    # (the child's shape is only what it keeps: the zone's outline, raised arms and all, is not its)
    phi['child'][cs] = ndi.gaussian_filter((cbody & ~zone).astype(np.float32), 0.6)
    cm_ = c['mat'].copy()
    cm_[c_girdle & ~zone & np.isin(cm_, [TRABECULAR, CORTICAL, CARTILAGE])] = MUSCLE
    mats['child'][cs] = cm_
    labs['child'][cs] = c['lab']
    # of the arm donor's labels only its girdle's and arm's bones (its trunk is not grafted); the left
    # arm's labels are the right's mirrored, so they are renamed
    keep_a = [ids[n] for n in ('humerus_right', 'scapula_right', 'clavicula_right')]
    a_lab = np.where(np.isin(arm['lab'], keep_a), arm['lab'], 0).astype(np.int16)
    to_left = {ids['humerus_right']: ids['humerus_left'], ids['scapula_right']: ids['scapula_left'],
               ids['clavicula_right']: ids['clavicula_left']}
    gz = lo[2] + np.arange(nz) * sp
    gy = lo[1] + np.arange(ny) * sp
    gx = lo[0] + np.arange(nx) * sp
    # child candidacy: its body (blur margin) outside the shoulder zone, below the neck seam, above the
    # leg seam
    cc = np.zeros((nz, ny, nx), bool)
    cc[cs] = (cphi > 0.01) & ~zone
    cand['child'] = cc
    del cc
    a_phi = ndi.gaussian_filter(a_reg.astype(np.float32), 1.2)
    h_phi = ndi.gaussian_filter(h_reg.astype(np.float32), 0.6)
    a_mat = classify(arm['hu'])
    a_mat[a_trunk] = MUSCLE
    a_mat[a_mat == LUNG] = FAT                    # gas outside the cage (post mortem) or the donor's lung edge
    a_mat[~a_reg] = AIR
    arm_physes(a_mat, arm, fitd)
    h_lab_nb = np.where(np.isin(h_lab, [i for i, nm in ts_class_map().items() if name_to_material(nm) == -1]), 0, h_lab)
    h_mat = classify(head['hu'], h_lab_nb)
    hb = np.isin(h_lab, [i for i, nm in ts_class_map().items() if name_to_material(nm) == -1])
    hnear = ndi.binary_dilation(hb, iterations=2)
    # bone-dense but off the bones: within 8 mm of the skin it is something on the patient (s1082 wore
    # glasses), deeper it is contrast in a vessel
    hdense = np.isin(h_mat, [TRABECULAR, CORTICAL]) & ~hnear
    skin8 = ndi.distance_transform_edt(head['keep']) * 1.5 <= 8.0
    h_reg = pare(h_reg & ~(hdense & skin8), r=1)
    h_phi = ndi.gaussian_filter(h_reg.astype(np.float32), 1.2)
    h_mat[hdense] = BLOOD
    h_mat[~h_reg] = AIR
    # Materials are not pulled as materials: a nearest-voxel pull at a scale of 0.75-0.9 drops or
    # doubles a donor slice every few, and a lateral skull printed the skipped and doubled layers of
    # its cortex as stripes. The donors' HU is pulled (linear) and classified on the child's grid, as
    # the child's own; the labels that decide organs, the regions and the cut plates are pulled as
    # they are. The leg, shipped as materials only, is turned into HU first (each material's own) and
    # blurred by half a voxel.
    h_nb = h_lab_nb.astype(np.int16)
    h_near = hnear.astype(np.uint8)
    h_regu = h_reg.astype(np.uint8)
    a_regu = a_reg.astype(np.uint8)
    a_trk = a_trunk.astype(np.uint8)
    HU_OF = np.full(256, 40.0, np.float32)
    for (mid_, _nm, hu_, _c) in __import__('app.build_model', fromlist=['LEGEND']).LEGEND:
        if hu_ is not None:
            HU_OF[mid_] = hu_
    HU_OF[AIR] = -1000.0
    l_hu = ndi.gaussian_filter(HU_OF[l_mat], 0.6)
    # (and the HU of all three blurred a little before the pull: linear interpolation of a 1.5 mm grid
    # at another scale weighs each donor voxel differently from one row to the next, and the HU cuts
    # turned that beat into stripes across a lateral skull)
    h_hu = ndi.gaussian_filter(head['hu'].astype(np.float32), 0.7)
    a_hu = ndi.gaussian_filter(arm['hu'].astype(np.float32), 0.7)
    for k0 in range(0, nz, 24):
        k1 = min(nz, k0 + 24)
        Z, Y, X = np.meshgrid(gz[k0:k1], gy, gx, indexing='ij')
        P = np.stack([X, Y, Z], -1)
        up = (P - disc) @ axc
        side_r = X < x_mid
        # head
        q = H.pull(P)
        ph = pull_sample(h_phi, head['origin'], 1.5, q, 1)
        if ph.max() > 0:
            phi['head'][k0:k1] = ph
            hm = classify(pull_box(h_hu, head['origin'], 1.5, H.pull, P, ph > 0.01, sp), pull_sample(h_nb, head['origin'], 1.5, q, 0))
            hm[np.isin(hm, [TRABECULAR, CORTICAL]) & (pull_sample(h_near, head['origin'], 1.5, q, 0) == 0)] = BLOOD
            hm[pull_sample(h_regu, head['origin'], 1.5, q, 0) == 0] = AIR
            mats['head'][k0:k1] = hm
            labs['head'][k0:k1] = pull_sample(h_lab, head['origin'], 1.5, q, 0)
            cand['head'][k0:k1] = (ph > 0.01) & (up > 0)
        # arms (each its own side of the midline)
        for nm, sd in (('armR', side_r), ('armL', ~side_r)):
            q = T[nm].pull(P)
            pa = pull_sample(a_phi, arm['origin'], 1.5, q, 1) * sd
            if pa.max() > 0:
                phi[nm][k0:k1] = pa
                am = classify(pull_box(a_hu, arm['origin'], 1.5, T[nm].pull, P, pa > 0.01, sp))
                am[pull_sample(a_trk, arm['origin'], 1.5, q, 0) > 0] = MUSCLE
                am[am == LUNG] = FAT
                am[pull_sample(a_mat, arm['origin'], 1.5, q, 0) == CARTILAGE] = CARTILAGE    # the cut plates
                am[pull_sample(a_regu, arm['origin'], 1.5, q, 0) == 0] = AIR
                mats[nm][k0:k1] = am
                la = pull_sample(a_lab, arm['origin'], 1.5, q, 0)
                if nm == 'armL':
                    for a_, b_ in to_left.items():
                        la[la == a_] = b_
                labs[nm][k0:k1] = la
                cand[nm][k0:k1] = pa > 0.01
        # legs below the femoral seam
        for nm, sd in (('legR', side_r), ('legL', ~side_r)):
            if gz[k0] > z_cut + 40:
                continue
            q = T[nm].pull(P)
            pl = pull_sample(l_phi, leg['origin'], leg['sp'], q, 1) * sd
            if pl.max() > 0:
                phi[nm][k0:k1] = pl
                lhu_ = pull_box(l_hu, leg['origin'], leg['sp'], T[nm].pull, P, pl > 0.01, sp)
                lm_ = classify(lhu_)
                ln_ = pull_sample(l_mat, leg['origin'], leg['sp'], q, 0)
                lm_[ln_ == CARTILAGE] = CARTILAGE                                          # joints and plates
                lm_[np.isin(lm_, [TRABECULAR, CORTICAL]) & ~np.isin(ln_, [TRABECULAR, CORTICAL, CARTILAGE])
                    & (lhu_ < 400)] = MUSCLE   # (blur's halo)
                mats[nm][k0:k1] = lm_
                cand[nm][k0:k1] = (pl > 0.01) & (Z < z_cut)
    log('parts sampled')
    # ---- ownership: legs below the seam, the head above its seam, the arms in the shoulder zone and
    # beside the trunk, the child everywhere else it has body
    above_seam = np.zeros((nz, ny, nx), bool)
    for k in range(nz):
        Y, X = np.meshgrid(gy, gx, indexing='ij')
        above_seam[k] = (np.stack([X, Y, np.full_like(X, gz[k])], -1) - disc) @ axc > 0
    below_cut = (gz < z_cut)[:, None, None]
    owner = np.zeros((nz, ny, nx), np.uint8)              # 0 none, 1.. parts
    code = {p: i + 1 for i, p in enumerate(parts)}
    child_ok = cand['child'] & ~above_seam & ~below_cut & (phi['child'] > 0.5)
    owner[child_ok] = code['child']
    for nm in ('legR', 'legL'):
        owner[(owner == 0) & cand[nm] & (phi[nm] > 0.5)] = code[nm]
    zone_g = np.zeros((nz, ny, nx), bool)
    zone_g[cs] = zone
    in_child = np.zeros((nz, ny, nx), bool)
    in_child[cs] = cbody
    # Outside the child the girdles' donor may add only at the side: beyond the child's own trunk
    # (its body less the shoulder zone, slice by slice, less 15 mm) or above the base of the neck. Its
    # back and chest, where they lie proud of the child's, would stand out as plates on the child's skin.
    own_c = in_child & ~zone_g
    lateral_ok = np.zeros((nz, ny, nx), bool)
    for k in range(nz):
        xs_ = np.nonzero(own_c[k].any(0))[0]
        if len(xs_) == 0 or gz[k] > float(disc[2]) - 8.0:
            lateral_ok[k] = True
            continue
        x0_, x1_ = xs_.min() + 15.0 / sp, xs_.max() - 15.0 / sp
        cols = (np.arange(nx) < x0_) | (np.arange(nx) > x1_)
        lateral_ok[k] = cols[None, :]
    for nm in ('armR', 'armL'):
        sel = (owner == 0) & cand[nm] & (phi[nm] > 0.5) & (zone_g | (~in_child & lateral_ok))
        owner[sel] = code[nm]
    # Above the seam the head and neck are the head donor's, except at the base of the neck: there the
    # girdles' donor carries the shoulders up to the neck (its trapezius), and the head donor gives only
    # a column round the cervical spine (the child's own neck's width), widening up the neck until it
    # takes everything 4 cm up. (The head donor's own neck at its base carries its shoulders' slopes,
    # which stood out as a ledge over the grafted ones.)
    nax = disc + np.array([0.0, -15.0, 0.0])
    sel = cand['head'] & (phi['head'] > 0.5) & above_seam
    for k in range(nz):
        if not sel[k].any():
            continue
        Y, X = np.meshgrid(gy, gx, indexing='ij')
        v = np.stack([X, Y, np.full_like(X, gz[k])], -1) - nax
        u = v @ axc
        rho = np.linalg.norm(v - u[..., None] * axc, axis=-1)
        rr = np.where(u > NECK_FULL, 1e9, NECK_R0 + (NECK_R1 - NECK_R0) * np.clip(u / NECK_FULL, 0, 1))
        arm_here = (owner[k] == code['armR']) | (owner[k] == code['armL'])
        take = sel[k] & ((owner[k] == 0) | (arm_here & (rho < rr)))
        owner[k][take] = code['head']
    # the donor's scapulae and clavicles, where they lie in the child's own back and front (outside its
    # cage): as bone, in the child's tissue
    hull_g = np.zeros((nz, ny, nx), bool)
    hull_g[cs] = hull
    gird_ids = [ids[n] for n in ('scapula_right', 'scapula_left', 'clavicula_right', 'clavicula_left')]
    stamp = np.zeros((nz, ny, nx), bool)
    for nm in ('armR', 'armL'):
        st_ = (owner == code['child']) & np.isin(labs[nm], gird_ids) & np.isin(mats[nm], [TRABECULAR, CORTICAL]) & ~hull_g
        st_ = ndi.binary_closing(st_, iterations=1) & (owner == code['child']) & ~hull_g
        mats['child'][st_] = np.where(np.isin(mats[nm][st_], [TRABECULAR, CORTICAL]), mats[nm][st_], TRABECULAR)
        stamp |= st_
    log(f'girdle bone set into the child: {stamp.sum() * sp ** 3 / 1000:.1f} cm3')
    log('owners: ' + ', '.join(f'{p} {int((owner == code[p]).sum() * sp ** 3 / 1000)} cm3' for p in parts))
    # ---- the skin: the parts' occupancies weighted by their blurred ownership --------------------
    num = np.zeros((nz, ny, nx), np.float32); den = np.zeros((nz, ny, nx), np.float32)
    for p in parts:
        w = ndi.gaussian_filter((owner == code[p]).astype(np.float32), BLEND / sp)
        num += w * phi[p].astype(np.float32); den += w
    f = np.where(den > 1e-3, num / np.maximum(den, 1e-6), 0)
    body = f >= 0.5
    # strands and sheets left on the skin (an ECG lead's wire, a fold of a body bag) pared off
    body = pare(body, r=1)
    # Round the shoulders: where the child's own chest and back meet the grafted shoulder the two
    # outlines leave a groove or a notch (the child is heavier than the donor); a closing with a ball of
    # SHOULDER_CLOSE mm over the shoulder band (from below the scapulae to the root of the neck) fills
    # them with fat, as the soft tissue of a real shoulder runs smoothly into the chest. (Not lower: it
    # would join the hanging arm to the flank.)
    zlo_, zhi_ = float(c_zone_low), float(disc[2]) + 45.0
    # ... and first, over the shoulders, the skin is blended as SIGNED DISTANCES: an occupancy blend
    # leaves a cliff where two outlines lie further apart than its blur (the child's chest stands 1-2 cm
    # in front of the grafted shoulder); a blend of the parts' signed distance fields, weighted by their
    # blurred ownership, slopes from one surface to the other across the whole width of the blur
    kb_ = np.nonzero((gz >= float(T['armR'].c[2]) - 130.0) & (gz <= float(disc[2]) + 90.0))[0]
    if len(kb_):
        sl_ = slice(kb_[0], kb_[-1] + 1)
        sstep_ = lambda x: np.clip(x, 0, 1) ** 2 * (3 - 2 * np.clip(x, 0, 1))
        def sdf_(m):
            return np.clip((ndi.distance_transform_edt(~m) - ndi.distance_transform_edt(m)) * sp, -40, 40).astype(np.float32)
        # (the child's whole outline, not only what it keeps: the cut through its chest wall at the zone
        # is no surface, and as one it stood as a wall; the raised arms' outline beyond it counts only
        # as far as the child's ownership reaches, which is not far)
        own_c_ = np.zeros((nz, ny, nx), bool); own_c_[cs] = cbody
        groups = {'child': own_c_[sl_],
                  'arms': (phi['armR'][sl_] > 0.5) | (phi['armL'][sl_] > 0.5),
                  'head': phi['head'][sl_] > 0.5}
        codes = {'child': [code['child']], 'arms': [code['armR'], code['armL']], 'head': [code['head']]}
        num_ = np.zeros(groups['child'].shape, np.float32); den_ = np.zeros_like(num_)
        for g_nm, m_ in groups.items():
            w_ = ndi.gaussian_filter(np.isin(owner[sl_], codes[g_nm]).astype(np.float32), SDF_BLEND / sp)
            num_ += w_ * sdf_(m_); den_ += w_
        fb = np.where(den_ > 0.05, num_ / np.maximum(den_, 1e-6), 40.0)
        # (and the arms keep their own outline where they hang free: the blend is for the joins)
        fb = np.where(np.isin(owner[sl_], codes['arms']) & body[sl_], np.minimum(fb, -0.5), fb)
        # eased into the outline above and below over 40 mm, so the band's ends leave no ring
        lam = sstep_(np.minimum(gz[sl_] - gz[sl_][0], gz[sl_][-1] - gz[sl_]) / 40.0)[:, None, None]
        fo = sdf_(body[sl_])
        body[sl_] = (lam * fb + (1 - lam) * fo) < 0
        body = pare(body, r=1)
    ks_ = np.nonzero((gz >= zlo_ - 10) & (gz <= zhi_ + 10))[0]
    if len(ks_):
        rb = int(round(SHOULDER_CLOSE / sp))
        g_ = np.arange(-rb, rb + 1)
        ball_ = (g_[:, None, None] ** 2 + g_[None, :, None] ** 2 + g_[None, None, :] ** 2) <= rb * rb
        sub_ = body[ks_[0]:ks_[-1] + 1]
        closed = ndi.binary_closing(np.pad(sub_, rb + 1), structure=ball_)[rb + 1:-rb - 1, rb + 1:-rb - 1, rb + 1:-rb - 1]
        band = ((gz[ks_] >= zlo_) & (gz[ks_] <= zhi_))[:, None, None]
        body[ks_[0]:ks_[-1] + 1] |= closed & band
    # ---- materials: the owner's, inside the body; where the body has no owner (the blend filled
    # it in) the nearest owner's... as fat, as under any skin
    mat = np.zeros((nz, ny, nx), np.uint8)
    for p in parts:
        sel = owner == code[p]
        mat[sel] = mats[p][sel]
    # Across the femoral seam the two thighs' soft tissue is dithered, not cut: the slim donor's thigh
    # is more muscle and less fat than this child's, and a cut drew a line across both thighs on an AP
    # pelvis. Over SEAM_DITHER mm either side, each voxel where both have tissue (not bone: the femur
    # has its own blend) takes the donor's material with the probability that rises across the band.
    rng = np.random.default_rng(11)
    for k in np.nonzero(np.abs(gz - z_cut) <= SEAM_DITHER)[0]:
        beta = smoothstep((z_cut + SEAM_DITHER - gz[k]) / (2 * SEAM_DITHER))
        for nm in ('legR', 'legL'):
            both = (phi[nm][k] > 0.5) & (phi['child'][k] > 0.5) & np.isin(owner[k], [code['child'], code[nm]])
            soft = both & ~np.isin(mats[nm][k], [TRABECULAR, CORTICAL, CARTILAGE, AIR]) \
                & ~np.isin(mats['child'][k], [TRABECULAR, CORTICAL, CARTILAGE, AIR])
            pick = rng.random(soft.shape) < beta
            mat[k][soft & pick] = mats[nm][k][soft & pick]
            mat[k][soft & ~pick] = mats['child'][k][soft & ~pick]
    mat[~body] = AIR
    # where the blended skin takes in what no part has (or the owner's own outline is further in):
    # fat, as under any skin. (Not the owner's own air inside it: the trachea is labelled air.)
    own_phi = np.zeros((nz, ny, nx), np.float32)
    for p in parts:
        sel = owner == code[p]
        own_phi[sel] = phi[p][sel]
    # (a limb has no air inside it: post mortem, the gaps between the skin and the bag the limb
    # donors lay in read as air inside their smoothed outline, and printed as pits on the skin)
    limb = np.isin(owner, [code['armR'], code['armL'], code['legR'], code['legL']])
    hole = body & ((owner == 0) | ((mat == AIR) & ((own_phi < 0.5) | limb)))
    mat[hole] = FAT
    mat[mat == SKIN] = FAT
    # ---- the femur across its seam: the child's subtrochanteric section blended into the donor's shaft
    # (each slice's bone outline a mix of the two outlines' signed distances), then cortex and marrow
    # laid in it again
    bands = (gz >= z_cut - FEMUR_BAND[0]) & (gz <= z_cut + FEMUR_BAND[1])
    cfem = np.zeros((nz, ny, nx), bool)
    cfem[cs] = np.isin(c['lab'], [cids['femur_right'], cids['femur_left']])
    cfem = ndi.binary_dilation(cfem, iterations=1)
    bone_ids = [TRABECULAR, CORTICAL]
    for k in np.nonzero(bands)[0]:
        beta = smoothstep((z_cut + FEMUR_BAND[1] - gz[k]) / sum(FEMUR_BAND))
        for nm, sgn in (('legR', -1), ('legL', 1)):
            sidek = ((gx - x_mid) * sgn > 0)[None, :]
            bc = np.isin(mats['child'][k], bone_ids) & cfem[k] & sidek
            bd = np.isin(mats[nm][k], bone_ids) & sidek & (phi[nm][k] > 0.5)
            # only the donor's femur: the bone piece nearest the child's femur
            if bd.any() and bc.any():
                lb, nb_ = ndi.label(bd)
                if nb_ > 1:
                    # (the piece overlapping the child's femur most; a stray voxel's centroid can lie
                    # nearer the child's than the shaft's does)
                    near_c = ndi.binary_dilation(bc, iterations=4)
                    ov = ndi.sum(near_c, lb, range(1, nb_ + 1))
                    bd = lb == (int(np.argmax(ov)) + 1)
            if not (bc.any() or bd.any()):
                continue
            sdf = lambda m: (ndi.distance_transform_edt(~m) - ndi.distance_transform_edt(m)) * sp
            big = 1e3
            fc = sdf(bc) if bc.any() else np.full(bc.shape, big)
            fd = sdf(bd) if bd.any() else np.full(bd.shape, big)
            ph_ = fd if not bc.any() else fc if not bd.any() else (1 - beta) * fc + beta * fd
            region = ndi.binary_dilation(bc | bd, iterations=6) & sidek & body[k]
            old_bone = np.isin(mat[k], bone_ids) & region
            new_bone = (ph_ < 0) & region
            mat[k][old_bone & ~new_bone] = MUSCLE
            mat[k][new_bone & (ph_ > -2.0)] = CORTICAL
            mat[k][new_bone & (ph_ <= -2.0)] = TRABECULAR
            if nm == 'legR' and k % 3 == 0:
                log(f'    femur band z {gz[k]:.1f} beta {beta:.2f}: child {int(bc.sum())}, donor {int(bd.sum())}, '
                    f'blend {int(new_bone.sum())}')
    shell = body & ~ndi.binary_erosion(body, iterations=max(1, int(round(1.5 / sp))))
    mat[shell] = SKIN
    log(f'body {body.sum() * sp ** 3 / 1e6:.1f} L; filled {int(hole.sum())} voxels')
    zb = np.nonzero(body.any((1, 2)))[0]
    top, sole = gz[zb.max()], gz[zb.min()]
    tipR = T['armR'].push(np.array(fitd['arm']['tip']))
    log(f'stature {top - sole:.0f} mm (top {top:.0f}, sole {sole:.0f}); GH centres z {T["armR"].c[2]:.0f} / '
        f'{T["armL"].c[2]:.0f} ({(T["armR"].c[2] - sole) / (top - sole):.3f} H); fingertip z {tipR[2]:.0f} '
        f'({(tipR[2] - sole) / (top - sole):.3f} H, textbook 0.377)')
    lab_all = np.zeros((nz, ny, nx), np.int16)
    for p in labs:
        sel = owner == code[p]
        lab_all[sel] = labs[p][sel]
    lab_all[~body] = 0
    zz_, yy_, xx_ = [np.nonzero(body.any(axis=a))[0] for a in ((1, 2), (0, 2), (0, 1))]
    pad = 4
    bx = tuple(slice(max(0, v.min() - pad), v.max() + pad + 1) for v in (zz_, yy_, xx_))
    mat, owner = np.ascontiguousarray(mat[bx]), np.ascontiguousarray(owner[bx])
    lo = lo + np.array([bx[2].start, bx[1].start, bx[0].start]) * sp
    log(f'model grid {mat.shape[::-1]} = {mat.size / 1e6:.1f} MB')
    save(f'compose_{sp:g}', mat=mat, owner=owner, origin=lo, sp=sp, lab=np.ascontiguousarray(lab_all[bx]),
         child_origin=corg, z_cut=z_cut, disc=disc)
    # The grafted limbs' joints, carried from their donors (for tools/measure_pediatric.py): the knee
    # and ankle from the lower extremity's measured landmarks, the elbow and wrist at z053's measured
    # levels (build_limbs.ARMS), each the centre of the arm's bone there; in the model's volume frame
    ll = json.loads((pathlib.Path(__file__).resolve().parents[3] / 'apps' / 'web' / 'src' / 'data' / 'landmarks.json')
                    .read_text(encoding='utf-8'))['lowerextremity']
    nn = np.array(leg['mat'].shape[::-1])
    lmk = lambda d_: (np.array([d_['x'], d_['y'], d_['z']]) * 10 + (nn - 1) / 2 * leg['sp']) + leg['origin']
    abone = arm['keep'] & np.isin(arm['mat'], [TRABECULAR, CORTICAL])
    def arm_pt(k_cache):
        k = arm['hu'].shape[0] - 1 - k_cache                  # the cache's z (head end 0) in LPS
        yy_, xx_ = np.nonzero(abone[k])
        return arm['origin'] + np.array([xx_.mean(), yy_.mean(), k]) * 1.5
    dims = np.array(mat.shape[::-1])
    vol = lambda p: ((np.asarray(p) - lo) / sp - (dims - 1) / 2) * sp / 10.0
    pts = {}
    for side, s_ in (('R', 'legR'), ('L', 'legL')):
        pts[f'knee{side}'] = vol(T[s_].push(lmk(ll['knee']))).tolist()
        pts[f'ankle{side}'] = vol(T[s_].push(lmk(ll['ankle']))).tolist()
    for side, s_ in (('R', 'armR'), ('L', 'armL')):
        # (the donor's own points: the left arm's transform mirrors them itself)
        pts[f'elbow{side}'] = vol(T[s_].push(arm_pt(215))).tolist()
        pts[f'wrist{side}'] = vol(T[s_].push(arm_pt(372 + 8))).tolist()
    (PED / 'pediatric_points.json').write_text(json.dumps(pts, indent=1), encoding='utf-8')
    log('limb joints (cm, volume frame): ' + ', '.join(f'{k} {np.round(v, 1).tolist()}' for k, v in pts.items()))
    return mat, owner, lo


# ------------------------------------------------------------------------------------------ write
NAME, TITLE = 'pediatric', 'Pediatric (child, 11 y)'
SOURCE = ('Composite pediatric phantom (11 M, 140 cm): trunk = TCIA Pediatric-CT-SEG 2197048C, CT neck to '
          'proximal femurs, CC BY 4.0 (Jordan et al. 2021, doi:10.7937/TCIA.X0H0-1706); head & neck = '
          'TotalSegmentator dataset s1082, CC BY 4.0 (Wasserthal et al. 2023, doi:10.5281/zenodo.10047292); '
          'shoulders & arms = VSD z053 (mirrored for the left), legs = VSD z035 lower extremity, CC BY-NC 3.0 '
          '(VSD Full Body, doi:10.5281/zenodo.8270364) \u00b7 grafts scaled to the child, growth plates cut '
          'into the grafted long bones \u00b7 HU materials')


def write(sp=SP):
    from app.build_limbs import MODELS, skin
    d = load(f'compose_{sp:g}')
    mat = d['mat']
    hu_ref = np.array([-1024, 3071], np.int16)                # (the header's HU range, as the CT's)
    write_model(str(MODELS / NAME), NAME, TITLE, mat, hu_ref, sp, mesh=True, source=SOURCE, mesh_step_mul=2)
    hdr = MODELS / NAME / f'{NAME}.model.json'
    h = json.loads(hdr.read_text(encoding='utf-8'))
    h['composition'] = {
        'child': 'TCIA Pediatric-CT-SEG 2197048C: 11-year-old boy, 140.1 cm, 48.5 kg; contrast CT (IV, portal phase), '
                 '0.625 mm, from C7 to below the lesser trochanters, arms raised. Kept: thorax, abdomen, pelvis, spine '
                 'T1-S5, ribs, sternum, proximal femurs with their open physes; enhanced blood re-assigned to blood.',
        'head': 'TotalSegmentator s1082 (69 M), C7/T1 disc up; neck at the child\'s vertebral scale (x0.77), '
                'lengthened 15 % at mid-neck, cranium x0.885 (head circumference 53.5 cm).',
        'arms': 'VSD z053 (57 F) right shoulder girdle and arm, mirrored for the left; placed on the child\'s ribs 2-7, '
                'T1-T7 and sternoclavicular joints, let down to hang at rest, x0.88.',
        'legs': 'VSD z035 (30 F) right lower extremity (baked anatomical position), mirrored for the left; hung from the '
                'child\'s femoral heads, joined to the child\'s femur below the trochanters, x0.83, thighs widened to the '
                'child\'s outline.',
        'physes': 'cut into the grafted bones: proximal humerus, distal radius and ulna, distal femur, proximal and '
                  'distal tibia, proximal fibula. Not cut: the distal fibula (it lies against the tibia there in the '
                  'donor), the small bones of the hands and feet, the centres of the elbow.',
    }
    hdr.write_text(json.dumps(h, indent=2), encoding='utf-8')
    np.savez_compressed(PED / f'{NAME}_labels.npz', lab=d['lab'])
    skin(NAME)
    log('written')


def save(name, **arrays):
    WORK.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(WORK / f'{name}.npz', **arrays)


def load(name):
    d = np.load(WORK / f'{name}.npz', allow_pickle=True)
    return {k: d[k] for k in d.files}


if __name__ == '__main__':
    what = sys.argv[1] if len(sys.argv) > 1 else 'all'
    sp = float(sys.argv[2]) if len(sys.argv) > 2 else SP
    if what in ('prep', 'all'):
        prep()
    if what in ('child', 'all'):
        c = child(sp)
        save(f'child_{sp:g}', **c)
    if what in ('donors', 'all'):
        save('arm', **arm_donor()); log('arm donor')
        save('head', **head_donor()); log('head donor')
    if what in ('fit', 'all'):
        fit()
    if what in ('compose', 'all'):
        compose(sp)
    if what in ('write', 'all'):
        write(sp)
