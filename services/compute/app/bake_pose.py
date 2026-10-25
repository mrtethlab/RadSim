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

from app.build_model import AIR, FAT, SKIN, SOFT, write_model
from app.build_limbs import MODELS, ROOT, skin

# the anatomical angles each model is baked to (the motions' rest is the scan's own), in stages,
# re-measured between: the foot is first rolled upright about its own axis (z053's lay inverted),
# then brought square to the leg, then turned toes up (the turn is about the leg's axis, which only
# then is the foot's vertical)
BAKE = {
    # (inversion twice: read on a foot lying 60 degrees over, the metatarsals' row is a poorer
    # measure than on one near upright, and the first pass left it 18 degrees short or over)
    'lowerextremity': [{'ankle.invert': 0}, {'ankle.flex': 0}, {'ankle.roll': 0}, {'ankle.invert': 0}],
    'upperextremity': [{'elbow.roll': 0}],
}
# What a bake leaves to take out afterwards, on the shipped model (python -m app.bake_pose --trim):
# the leg's last pass left its foot turned 11 degrees out and inverted 10 (each stage turns by the
# angle measured before it, and the carry and reskin moved the bones the next measure reads), so the
# sliders opened at -11 and +10 where the anatomical position is 0.
TRIM = {
    # (2026-10-25: -10.7 / +9.9 -> +0.7 / +4.0 after the first two, +0.8 / +1.9 after the third: the inversion again as the bake
    # does it twice: read on a foot near upright, the second pass lands closer)
    'lowerextremity': [{'ankle.roll': 0}, {'ankle.invert': 0}, {'ankle.invert': 0}],
}
TOOLS = ROOT / 'tools'

# After the bake, the surface of what was bent is laid again (reskin). z035's foot lay pointed and
# came up some 75 degrees: the crease left thin fins across the front of the ankle, a squared ledge
# behind the heel where the posed heel met the unposed calf, loose islands of tissue and a rough
# skin over the foot. cm: the zone (above the sole) that is relaid, easing back to the scan's own
# surface over the band above it; the heel and ankle (within `toes[0]` of the leg's axis) are
# rounded broadly, the forefoot and toes (past `toes[1]`) finely.
RESKIN = {
    'lowerextremity': dict(zone=(10.0, 16.0), toes=(8.0, 12.0)),
}

# The bake bends soft tissue as the app does, through a crease 1.5 cm wide about the joint's plane:
# right for the tens of degrees a slider moves, but z035's foot lay pointed some 70 degrees and
# turned in, its heel up behind the ankle, above the plane through the malleoli. Bent back to the
# anatomical position, the heel's upper tissue stayed with the leg (a collar round the ankle) or was
# smeared through the crease (lumps on the heel and over the malleoli). So the soft tissue of the
# lower `CARRY` mm is carried instead with the bone it lies nearest: the leg's unmoved, the foot's
# by the foot's own rigid turn. That turn is read off the bake itself: small cubes of marker ids are
# set inside the bones before it, travel with them (bone is posed rigidly), and are found after.
CARRY = {'lowerextremity': 320}
MARK0, NMARK = 100, 140                 # marker ids MARK0..MARK0+NMARK-1 (no material uses them)
BONE_IDS = [16, 17, 18] + list(range(54, 62))


def marks_path(name):
    from app.joint_space import sheet_path
    return sheet_path(name).parent / f'{name}.marks.bin'


def place_marks(v, low_mm, sp, spacing_mm=10.0):
    """NMARK 3-voxel cubes inside the bone of the lowest `low_mm` (z up), at least `spacing_mm` apart."""
    bone = np.isin(v, BONE_IDS)
    z0 = int(np.nonzero((v != AIR).any((1, 2)))[0].min())
    z1 = z0 + int(low_mm / sp)
    core = np.zeros_like(bone)
    core[z0:z1] = ndi.binary_erosion(bone[z0:z1], structure=np.ones((3, 3, 3)))
    cand = np.argwhere(core)
    cand = cand[np.random.default_rng(0).permutation(len(cand))]
    chosen = []
    for p in cand:
        if all(np.sum((p - q) ** 2) * sp * sp >= spacing_mm ** 2 for q in chosen):
            chosen.append(p)
            if len(chosen) == NMARK:
                break
    m = np.zeros(v.shape, np.uint8)
    for k, (z, y, x) in enumerate(chosen):
        m[z - 1:z + 2, y - 1:y + 2, x - 1:x + 2] = MARK0 + k
    return m


def centres(m):
    ids = np.arange(MARK0, MARK0 + NMARK)
    n = ndi.sum(m > 0, m, ids)
    c = np.array(ndi.center_of_mass(m > 0, m, ids))
    return {int(i): c[k] for k, i in enumerate(ids) if n[k] >= 15}


def kabsch(a, b):
    ca, cb = a.mean(0), b.mean(0)
    U, _, Vt = np.linalg.svd((a - ca).T @ (b - cb))
    D = np.diag([1, 1, np.sign(np.linalg.det(Vt.T @ U.T))])
    R = Vt.T @ D @ U.T
    return R, cb - R @ ca


def carry(raw, raw_marks, raw_sheet, v, marks, sheet, low_mm, sp=1.0, pad=4):
    """The baked volume `v` (and its joint sheet) with its lowest `low_mm` laid again from the scan
    `raw`: the leg's bone and tissue by the leg's shift, the foot's (every bone below the ankle
    joint, and the tissue nearer it than the leg's) by the foot's one rigid turn (CARRY)."""
    cr, cb = centres(raw_marks), centres(marks)
    ids = [i for i in cr if i in cb]
    P = np.array([cr[i] for i in ids]); Q = np.array([cb[i] for i in ids])
    D = Q - P
    # the leg's: the largest set of markers moved alike (a shift: the leg does not turn)
    leg = np.linalg.norm(D[:, None] - D[None], axis=2) < 1.0
    leg = leg[np.argmax(leg.sum(1))]
    t_leg = D[leg].mean(0)
    # the foot's: of the rest, the one rigid turn the most markers follow to within a voxel (the
    # forefoot's: the hindfoot lay above the joint's plane and the bake left it where it lay)
    rng = np.random.default_rng(0)
    fp, fq = P[~leg], Q[~leg]
    best = None
    for _ in range(2000):
        k = rng.choice(len(fp), 3, replace=False)
        R, t = kabsch(fp[k], fq[k])
        inl = np.linalg.norm(fp @ R.T + t - fq, axis=1) < 1.0
        if best is None or inl.sum() > best.sum():
            best = inl
    R, t = kabsch(fp[best], fq[best])
    res = np.linalg.norm(fp[best] @ R.T + t - fq[best], axis=1).mean()
    ang = np.degrees(np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1)))
    print(f'  carry: leg {int(leg.sum())} markers (shift {np.round(t_leg, 1).tolist()}); foot {int(best.sum())} of '
          f'{len(fp)} (turn {ang:.1f} deg, residual {res:.2f} voxel)')
    # the scan's lower part, each voxel the leg's or the foot's
    zr0 = int(np.nonzero((raw != AIR).any((1, 2)))[0].min())
    zr1 = zr0 + int(low_mm / sp)
    sub, sh = raw[zr0:zr1], raw_sheet[zr0:zr1] == 1
    rb = np.isin(sub, BONE_IDS)
    # the bone parted between the leg's shafts (where they run up out of the part) and the forefoot
    # (round the markers that took the foot's turn): grown through the bone, the two meet at its
    # narrowest, and a joint's sheet is a wall (the sheets alone do not close: bone touches bone)
    from skimage.segmentation import watershed
    seeds = np.zeros(sub.shape, np.int32)
    seeds[-1][rb[-1]] = 1
    for p in np.round(fp[best] - [zr0, 0, 0]).astype(int):
        seeds[p[0] - 2:p[0] + 3, p[1] - 2:p[1] + 3, p[2] - 2:p[2] + 3][rb[p[0] - 2:p[0] + 3, p[1] - 2:p[1] + 3, p[2] - 2:p[2] + 3]] = 2
    ws = watershed(-ndi.distance_transform_edt(rb) + 50 * sh, seeds, mask=rb | sh)
    bone_leg, bone_foot = (ws == 1) & rb, (ws == 2) & rb
    # The forefoot's turn is the foot's, but not about the ankle: each stage turned it about the
    # joint as measured on a foot already broken at the midfoot. The foot turns about the centre of
    # the talar dome (a sphere fitted to the foot's bone that meets the leg's), and stays seated.
    dl, idx = ndi.distance_transform_edt(~bone_leg, return_indices=True)
    a = np.argwhere(bone_foot & (dl <= 3)).astype(float)
    A = np.c_[2 * a, np.ones(len(a))]
    cen = np.linalg.lstsq(A, (a ** 2).sum(1), rcond=None)[0][:3]
    t = cen + t_leg - R @ cen + [zr0, 0, 0] - R @ [zr0, 0, 0]
    print(f'  carry: the foot turns about the talar dome, {len(a)} voxels of contact')
    # The stages left the foot everted (and a little off square): its sole is set perpendicular to
    # the leg. The sole is the plane of its three points of stance (the lowest of the heel, and of
    # the metatarsal heads each side, 62-80 % of the way from the heel to the toes), the leg the
    # long axis of the tibia and fibula above the ankle; the foot turns about the talar dome.
    C = cen + [zr0, 0, 0] + t_leg                                   # the dome's centre, baked
    up = np.argwhere(bone_leg[int(cen[0]) + 30:int(cen[0]) + 200]).astype(float)
    u = np.linalg.eigh(np.cov((up - up.mean(0)).T))[1][:, -1]
    u = u if u[0] > 0 else -u                                       # (z grows upward)
    q = (np.argwhere(bone_foot) + [zr0, 0, 0]).astype(float) @ R.T + t - C
    w = q - np.outer(q @ u, u)
    f = np.linalg.eigh(np.cov(w.T))[1][:, -1]
    pf = q @ f
    if pf.max() < -pf.min():                                        # toward the toes: the far end
        f, pf = -f, -pf
    lat = np.cross(f, u)
    L0, L1 = pf.min(), pf.max()
    pu = q @ u
    heel = q[pf < L0 + 0.15 * (L1 - L0)]
    H = heel[np.argmin(heel @ u)]
    band = (pf > L0 + 0.62 * (L1 - L0)) & (pf < L0 + 0.80 * (L1 - L0))
    side = q @ lat
    mid = np.median(side[band])
    M1 = q[band & (side < mid)][np.argmin(pu[band & (side < mid)])]
    M5 = q[band & (side >= mid)][np.argmin(pu[band & (side >= mid)])]
    n = np.cross(M1 - H, M5 - H); n /= np.linalg.norm(n)
    n = n if n @ u > 0 else -n
    ax = np.cross(n, u); s_ = np.linalg.norm(ax)
    if s_ > 1e-6:
        ax /= s_
        th = np.arctan2(s_, n @ u)
        K = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
        Rc = np.eye(3) + np.sin(th) * K + (1 - np.cos(th)) * K @ K
        print(f'  carry: the sole squared to the leg: {np.degrees(np.arctan2(n @ lat, n @ u)):.1f} deg about the '
              f'foot\'s axis, {np.degrees(np.arctan2(n @ f, n @ u)):.1f} deg about the ankle\'s')
        R, t = Rc @ R, Rc @ (t - C) + C
    # the soft tissue with the nearer bone; a joint's sheet with the side the parting gave it
    dl = ndi.distance_transform_edt(~bone_leg)
    df = ndi.distance_transform_edt(~bone_foot)
    foot = np.where(sub == AIR, False, df < dl)
    # The pointed foot's heel lay up against the back of the calf, and the calf's tissue there lay
    # nearer the calcaneus than the tibia: turned with the foot it stood out behind the heel as a
    # tongue. Above the ankle joint the foot's is its own cover only (no deeper than a heel pad);
    # below it, everything but the malleoli's cover.
    zz = np.arange(sub.shape[0])[:, None, None]
    foot &= (zz < cen[0]) | (df * sp <= 15)
    foot |= (sub != AIR) & (zz < cen[0]) & (dl * sp > 10)
    foot[sh] = ws[sh] == 2
    print(f'  carry: bone {int(bone_leg.sum())} leg, {int(bone_foot.sum())} foot')
    # forward, each voxel as 8 points (a turned grid leaves no holes): the leg's, then the foot's over it
    sub8 = np.array([[a, b, c] for a in (-.25, .25) for b in (-.25, .25) for c in (-.25, .25)], np.float32)
    parts = []
    for own, Rm, tv, offs in ((False, np.eye(3), t_leg, sub8[:1] * 0), (True, R, t, sub8)):
        pts = np.argwhere((sub != AIR) & (foot == own))
        mat, shp = sub[tuple(pts.T)], sh[tuple(pts.T)]
        pts = (pts + [zr0, 0, 0]).astype(np.float32)
        qs = [np.round((pts + o) @ Rm.T + tv).astype(np.int32) for o in offs]
        parts.append((qs, mat, shp))
    lo = np.minimum.reduce([q.min(0) for qs, _, _ in parts for q in qs] + [np.zeros(3, int)])
    hi = np.maximum.reduce([q.max(0) + 1 for qs, _, _ in parts for q in qs] + [np.array(v.shape)])
    off = -lo
    out = np.zeros(tuple(hi - lo), np.uint8)
    osh = np.zeros(out.shape, bool)
    # above the carried part, the bake's own (its grid shifted by the padding)
    zc = int(np.floor(zr1 + t_leg[0]))
    out[off[0] + zc:off[0] + v.shape[0], off[1]:off[1] + v.shape[1], off[2]:off[2] + v.shape[2]] = v[zc:]
    osh[off[0] + zc:off[0] + v.shape[0], off[1]:off[1] + v.shape[1], off[2]:off[2] + v.shape[2]] = sheet[zc:]
    for qs, mat, shp in parts:
        for q in qs:
            q = q + off
            out[tuple(q.T)] = mat
            osh[tuple(q[shp].T)] = True
    keep = out != AIR
    out[(out == SKIN) & ndi.binary_erosion(keep)] = FAT
    zs, ys, xs = np.nonzero(keep)
    crop = (slice(max(0, zs.min() - pad), zs.max() + pad + 1), slice(max(0, ys.min() - pad), ys.max() + pad + 1),
            slice(max(0, xs.min() - pad), xs.max() + pad + 1))
    return np.ascontiguousarray(out[crop]), np.ascontiguousarray(osh[crop])


def reskin(name, v=None, **kw):
    d = MODELS / name
    h = json.loads((d / f'{name}.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    sp = float(h['spacing'][0])
    if v is None:
        v = np.fromfile(d / f'{name}.mat.bin', np.uint8).reshape(nz, ny, nx)
    out = relay(v, sp, **kw)
    print(f'{name}: reskinned the foot, {int(((out != AIR) & (v == AIR)).sum())} voxels added, {int(((out == AIR) & (v != AIR)).sum())} taken')
    write_model(str(d), name, h['name'], out, np.array(h['huReference'], np.int16), sp, mesh=True, source=h['source'])
    skin(name)


def relay(v, sp, zone, toes, coarse_mm=6.0, fine_mm=2.5, open_mm=4.0, close_mm=10.0, cover_mm=4.0, depth_mm=22.0, round_mm=3.0):
    """The volume `v` (z up, `sp` mm) with its foot's surface laid again (RESKIN)."""
    nz, ny, nx = v.shape
    keep = v != AIR
    zb = int(np.nonzero(keep.any((1, 2)))[0].min())                   # the sole (z grows upward)
    z1 = min(nz, zb + int(np.ceil(zone[1] * 10 / sp)) + 1)
    sub = was = keep[:z1]
    bone = np.isin(v[:z1], BONE_IDS)
    # the leg's axis: the centre of its bone in the band just above the zone
    band = np.isin(v[z1 - int(30 / sp):z1], BONE_IDS)
    cy, cx = np.array(np.nonzero(band)[1:]).mean(1)
    yy, xx = np.mgrid[:ny, :nx]
    r = np.hypot(yy - cy, xx - cx) * sp / 10                          # cm from the leg's axis
    wf = np.clip((r - toes[0]) / (toes[1] - toes[0]), 0, 1)[None]
    zc = (np.arange(z1) - zb) * sp / 10
    wa = np.clip((zone[1] - zc) / (zone[1] - zone[0]), 0, 1)[:, None, None]
    # no soft tissue of a foot lies deeper than the heel pad (some 2 cm) from its bone
    sub = sub & (ndi.distance_transform_edt(~bone) * sp <= depth_mm + (1 - wa) * 1e3)
    lab, n = ndi.label(sub)
    if n > 1:
        sub = lab == (int(np.argmax(ndi.sum(sub, lab, range(1, n + 1)))) + 1)
    # The back of the ankle, from the heel up to the calf, is the Achilles tendon's line: straight or
    # gently curved, never the hollow the pointed foot left between the calf and the heel. In every
    # sagittal column the posterior outline is filled out to its upper hull over the zone (the foot
    # points forward of the leg's axis: posterior is the other way along the nearer grid axis).
    sole = np.array(np.nonzero(sub[:int(30 / sp)])[1:]).mean(1) - [cy, cx]
    apx = 1 if abs(sole[0]) >= abs(sole[1]) else 2
    back = np.moveaxis(sub, apx, 1).copy()                          # [z, anterior-posterior, across]
    if sole[apx - 1] > 0:                                           # (posterior to the high end)
        back = back[:, ::-1]
    zl = int(20 / sp)
    has = back.any(1)
    post = back.shape[1] - 1 - np.argmax(back[:, ::-1], axis=1)     # the posterior-most voxel
    # full on the tendon's line (within 15 mm of the leg's axis across), none 30 mm out: the ankle
    # narrows to the tendon, a shallow hollow each side of it
    mid = cx if apx == 1 else cy
    filled = np.zeros_like(back)
    for c in range(back.shape[2]):
        zs = np.nonzero(has[zl:, c])[0] + zl
        k = np.clip((30 - abs(c - mid) * sp) / 15, 0, 1)
        if len(zs) < 3 or k == 0:
            continue
        hull = post[zs, c] + k * (majorant_pts(zs, post[zs, c]) - post[zs, c])
        for z, h in zip(zs, hull):
            if h > post[z, c]:
                filled[z, post[z, c] + 1:int(h) + 1, c] = True
    if sole[apx - 1] > 0:
        filled = filled[:, ::-1]
    filled = np.moveaxis(filled, 1, apx)
    sub = sub | filled
    # opened (fins, flaps) and closed (the notch between the calf and the heel, which the Achilles
    # tendon spans), both by distance maps: a ball's own erosion is slow at these radii
    edt = lambda m: ndi.distance_transform_edt(m) * sp
    opened = edt(~(edt(sub) > open_mm)) <= open_mm
    closed = edt(edt(~opened) <= close_mm) > close_mm
    f = sub.astype(np.float32)
    Fc = ndi.gaussian_filter(closed.astype(np.float32), coarse_mm / sp)
    Ff = ndi.gaussian_filter(f, fine_mm / sp)
    F = (1 - wa) * f + wa * ((1 - wf) * Fc + wf * Ff)
    # bone keeps its cover, the cover's surface smoothed (a voxel-wise dilation printed the bone's
    # own grain on the back of the heel), and the whole rounded once more: no small bumps or edges
    cover = ndi.gaussian_filter((edt(~bone) <= cover_mm).astype(np.float32), 2.5 / sp) >= 0.5
    new = (F >= 0.5) | cover
    Fn = ndi.gaussian_filter(new.astype(np.float32), round_mm / sp)
    new = (wa * Fn + (1 - wa) * new >= 0.5) | bone
    lab, n = ndi.label(new)
    if n > 1:
        new = lab == (int(np.argmax(ndi.sum(new, lab, range(1, n + 1)))) + 1)
    new = ndi.binary_fill_holes(new)
    out = v.copy()
    part = out[:z1]
    part[~new] = AIR
    part[new & ~was] = FAT
    # what filled the back of the ankle: under its skin the tendon, soft tissue; deeper, the fat
    part[new & ~was & filled & (edt(new) <= 6)] = SOFT
    part[(part == SKIN) & new] = FAT
    k2 = out != AIR
    out[(out == SKIN) & ndi.binary_erosion(k2)] = FAT
    out[k2 & ~ndi.binary_erosion(k2)] = SKIN
    return out


def majorant_pts(x, y):
    """The least concave majorant (upper hull) of the points (x, y), x increasing, at each x."""
    hull = []
    for p in zip(x.tolist(), y.tolist()):
        while len(hull) >= 2 and (hull[-1][0] - hull[-2][0]) * (p[1] - hull[-2][1]) - (hull[-1][1] - hull[-2][1]) * (p[0] - hull[-2][0]) >= 0:
            hull.pop()
        hull.append(p)
    hx, hy = zip(*hull)
    return np.interp(x, hx, hy)


def measure(only=None):
    py = sys.executable
    subprocess.run([py, str(TOOLS / 'measure_landmarks.py')] + ([only] if only else []), check=True, cwd=ROOT, stdout=subprocess.DEVNULL)
    for t in ('measure_palpation.py', 'measure_centring.py', 'measure_joints.py'):
        subprocess.run([py, str(TOOLS / t)], check=True, cwd=ROOT, stdout=subprocess.DEVNULL)


def carry_path(name):
    return marks_path(name).with_suffix('.npz')


def carried(name, *vols):
    """carry, and its joint sheet written for open_model: the volume to finish with."""
    from app.joint_space import sheet_path
    h = json.loads((MODELS / name / f'{name}.model.json').read_text(encoding='utf-8'))
    v, sh = carry(*vols, CARRY[name], float(h['spacing'][0]))
    sh.astype(np.uint8).tofile(sheet_path(name))
    return v


def bake(name):
    if name in CARRY:
        from app.joint_space import sheet_path
        d = MODELS / name
        h = json.loads((d / f'{name}.model.json').read_text(encoding='utf-8'))
        nx, ny, nz = h['dims']
        raw = np.fromfile(d / f'{name}.mat.bin', np.uint8).reshape(nz, ny, nx)
        raw_sheet = np.fromfile(sheet_path(name), np.uint8).reshape(nz, ny, nx)
        raw_marks = place_marks(raw, CARRY[name], float(h['spacing'][0]))
        raw_marks.tofile(marks_path(name))
    for stage in BAKE[name]:
        pose(name, stage)
    v = None
    if name in CARRY:
        d = MODELS / name
        h = json.loads((d / f'{name}.model.json').read_text(encoding='utf-8'))
        nx, ny, nz = h['dims']
        v = np.fromfile(d / f'{name}.mat.bin', np.uint8).reshape(nz, ny, nx)
        mb = np.fromfile(marks_path(name), np.uint8).reshape(nz, ny, nx)
        sheet = np.fromfile(sheet_path(name), np.uint8).reshape(nz, ny, nx)
        marks_path(name).unlink()
        # (kept, to carry again without baking: python -m app.bake_pose --carry <name>)
        np.savez_compressed(carry_path(name), raw=raw, raw_marks=raw_marks, raw_sheet=raw_sheet, baked=v, marks=mb, sheet=sheet)
        v = carried(name, raw, raw_marks, raw_sheet, v, mb, sheet)
    finish(name, v)
    print(f'{name}: baked {BAKE[name]}')


def pose(name, angles):
    measure(name)
    d = MODELS / name
    h = json.loads((d / f'{name}.model.json').read_text(encoding='utf-8'))
    # the joint sheets ride along (app.joint_space): marked inside the materials with a spare id and
    # posed in the same pass, so they land on the same grid (the pose sizes its output by what moves)
    from app.joint_space import sheet_path, SHEET_ID
    from app.build_model import CARTILAGE
    sheet = sheet_path(name).exists()
    marks = marks_path(name).exists()          # (and the markers of CARRY, the same way)
    with tempfile.TemporaryDirectory() as tmp:
        out = pathlib.Path(tmp) / 'posed.bin'
        cmd = ['node', str(TOOLS / 'pose_volume.mjs'), name, json.dumps(angles), str(out)]
        if sheet or marks:
            nx0, ny0, nz0 = h['dims']
            m0 = np.fromfile(d / f'{name}.mat.bin', np.uint8).reshape(nz0, ny0, nx0)
            if sheet:
                m0[np.fromfile(sheet_path(name), np.uint8).reshape(nz0, ny0, nx0) == 1] = SHEET_ID
            if marks:
                mk0 = np.fromfile(marks_path(name), np.uint8).reshape(nz0, ny0, nx0)
                m0[mk0 > 0] = mk0[mk0 > 0]
            inp = pathlib.Path(tmp) / 'in.bin'
            m0.tofile(inp)
            cmd.append(str(inp))
        subprocess.run(cmd, check=True, cwd=ROOT)
        nx, ny, nz = json.loads(out.with_suffix('.bin.json').read_text())['dims']
        v = np.fromfile(out, np.uint8).reshape(nz, ny, nx)
    sh = mk = None
    if sheet:
        sh = v == SHEET_ID
        v[sh] = CARTILAGE                    # a joint's mid-surface is cartilage (the gap is cut last)
    if marks:                                # the markers out, their place the bone round them
        mk = np.where((v >= MARK0) & (v < MARK0 + NMARK), v, 0).astype(np.uint8)
        v = v[tuple(ndi.distance_transform_edt(mk > 0, return_distances=False, return_indices=True))]
    # a fresh skin: the crease turned some of the old shell inward, and the fold left cut faces bare
    keep = v != AIR
    v[(v == SKIN) & ndi.binary_erosion(keep)] = FAT
    v[keep & ~ndi.binary_erosion(keep)] = SKIN
    zs, ys, xs = np.nonzero(keep)
    pad = 4
    crop = (slice(max(0, zs.min() - pad), zs.max() + pad + 1), slice(max(0, ys.min() - pad), ys.max() + pad + 1),
            slice(max(0, xs.min() - pad), xs.max() + pad + 1))
    v = v[crop]
    if sh is not None:
        np.ascontiguousarray(sh[crop]).astype(np.uint8).tofile(sheet_path(name))
    if mk is not None:
        np.ascontiguousarray(mk[crop]).tofile(marks_path(name))
    write_model(str(d), name, h['name'], v, np.array(h['huReference'], np.int16), float(h['spacing'][0]), mesh=True, source=h['source'])
    skin(name)


def finish(name, v=None):
    if name in RESKIN:
        reskin(name, v=v, **RESKIN[name])
    # the joint spaces last, on the baked grid (their sheets were posed with every stage)
    from app.joint_space import open_model, sheet_path
    if sheet_path(name).exists():
        open_model(name)
    measure(name)


if __name__ == '__main__':
    if sys.argv[1:2] == ['--trim']:               # the angles a bake left, taken out (TRIM)
        for n in sys.argv[2:] or list(TRIM):
            for stage in TRIM[n]:
                pose(n, stage)
            finish(n)
            print(f'{n}: trimmed {TRIM[n]}')
    elif sys.argv[1:2] == ['--carry']:              # the bake's last steps again, from its saved volumes
        for n in sys.argv[2:]:
            c = np.load(carry_path(n))
            finish(n, carried(n, c['raw'], c['raw_marks'], c['raw_sheet'], c['baked'], c['marks'], c['sheet']))
    else:
        for n in sys.argv[1:] or list(BAKE):
            bake(n)
