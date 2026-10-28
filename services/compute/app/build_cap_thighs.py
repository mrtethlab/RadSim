"""The chest/abdomen/pelvis's proximal thighs: 15 cm of thigh grafted below the CAP.

    python -m app.build_cap_thighs fit          # register the leg donor's femur on each of the CAP's
    python -m app.build_cap_thighs compose      # graft, write the volume and its display mesh
    python -m app.build_cap_thighs all

WHY. The CAP's CT (TotalSegmentator s1379) stops 1.5 cm below the lesser trochanters, the ischial
tuberosities 3 cm above its last slice: there is no more of it to crop (the scan's own last slice is
its slice 0). A pelvis or hip film collimated as the books have it (the proximal third of the femur
on an AP hip, the field's lower edge 5 cm below the symphysis on an AP pelvis) then had free air in
its lower quarter, where the thighs should be, and the exposure read by the AEC and the DI came out
of that air.

WHAT. Both thighs below the CAP's last good slice (its three bottom slices are the resampling's
partial slice and the body's skin floor), 15 cm of them, from the shipped lower extremity (z035's
right leg, 30 F, VSD; CC BY-NC 3.0), mirrored for the left, as build_pediatric grafts legs:
- each donor femur is fitted to the CAP's own (its labels from TotalSegmentator, bone_labels): head,
  neck, trochanters and the 3 cm of shaft the scan has, by a trimmed ICP from a start that sets the
  heads on each other and the leg along the body; the scale comes out of the fit;
- at the seam the donor's femur is eased onto the CAP's last cross-section, the offset fading over
  EASE_MM down the shaft, so the cortex runs on without a step and no bone is doubled (the CAP's femur
  stops at the seam, the donor's starts under it);
- the skin: the CAP's last outline (one blob: the thighs joined by the buttocks and the perineum)
  turns into the donor's two thighs over BAND_MM, through a blend of their signed distances; the soft
  tissue inside is dithered from the CAP's last slice to the donor's over the same band; a new skin
  is laid on the graft.
Everything above the seam is the CAP's as it was, voxel for voxel: the vessels', the gut's and the
joints' voxels keep their raster order, so the arclength files are unchanged. The volume grows
ADD_SLICES slices at its foot (z index 0 is inferior), which moves every point of the old volume
ADD_SLICES * 2 mm / 2 up from the new centre: the landmarks, centring and palpation points are
measured again, the meshes cut again (requirements-models.txt).

The CAP as build_model and the vessel and gut passes left it is kept once in data/cap (the graft
reads it from there on every run, so running this again re-makes the same volume).
"""
from __future__ import annotations

import json
import shutil
import sys

import numpy as np
from scipy import ndimage as ndi

from app.build_model import AIR, FAT, MUSCLE, SOFT, SKIN, CARTILAGE, TRABECULAR, CORTICAL, _build_mesh
from app.build_limbs import MODELS
from app.pediatric_src import DATA

NAME = 'chestabdopelvis'
SP = 2.0
ADD_SLICES = 75            # 15 cm at 2 mm
SEAM = 3                   # the CAP's lowest whole slice (seam_slice): the graft replaces the ones under it
BAND_MM = 40.0             # the CAP's last outline into the donor's two thighs
EASE_MM = 60.0             # the donor femur's offset onto the CAP's at the seam, fading down the shaft
WORK = DATA / 'cap'
PRE = WORK / f'{NAME}.pregraft.mat.bin'
PRE_DIMS = (209, 165, 356)


def log(*a):
    print(*a, flush=True)


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def pregraft():
    """The CAP before the graft, (z, y, x). Kept the first time this runs, from the shipped model."""
    WORK.mkdir(parents=True, exist_ok=True)
    nx, ny, nz = PRE_DIMS
    if not PRE.exists():
        h = json.loads((MODELS / NAME / f'{NAME}.model.json').read_text(encoding='utf-8'))
        if tuple(h['dims']) != PRE_DIMS:
            raise SystemExit(f'{PRE} missing and the shipped CAP is already grafted ({h["dims"]})')
        shutil.copyfile(MODELS / NAME / f'{NAME}.mat.bin', PRE)
    return np.fromfile(PRE, np.uint8).reshape(nz, ny, nx)


def seam_slice(mat):
    """The CAP's lowest whole slice: under it, the resampling's partial slice and the skin floor
    (every body voxel of it skin)."""
    body = mat > 0
    for k in range(10):
        b = body[k].sum()
        if b > 0.8 * body[k + 5].sum() and (mat[k] == SKIN).sum() < 0.3 * b:
            return k
    raise SystemExit('no whole slice at the foot of the CAP')


def cap_femurs(mat):
    """The CAP's femur voxels per side, from the segmentation's own labels on the shipped grid."""
    from app import bone_labels
    from app.build_model import ts_class_map
    got = bone_labels.label_grid(NAME, mat.shape, graft=False)
    if got is None:
        raise SystemExit('the CAP label grid could not be made again (data/totalseg/s1379)')
    _, lab = got
    ids = {v: k for k, v in ts_class_map().items()}
    bone = np.isin(mat, [TRABECULAR, CORTICAL])
    out = {}
    for side in ('right', 'left'):
        m = lab == ids[f'femur_{side}']
        hip = ndi.binary_dilation(lab == ids[f'hip_{side}'], iterations=1)
        # the labels come from a coarser grid: the bone-dense voxels within a voxel of the label, but
        # not of the acetabulum's
        out[side] = bone & ndi.binary_dilation(m, iterations=1) & (m | ~hip)
    return out


def filled(mask):
    """a bone's outside: its marrow and the holes in its cortex filled, slice by slice and
    whole (a point fit to its surfaces otherwise matches one bone's cortex to the other's marrow)"""
    out = np.zeros_like(mask)
    for k in np.nonzero(mask.any((1, 2)))[0]:
        out[k] = ndi.binary_fill_holes(ndi.binary_closing(mask[k], iterations=2) | mask[k])
    return ndi.binary_fill_holes(out | mask)


def pts(mask, sp, k0=0):
    """(x, y, z) mm of a mask's voxels, z from the pre-graft volume's slice 0 (k0 = slices added)"""
    k, j, i = np.nonzero(mask)
    return np.stack([i, j, k - k0], 1) * sp


def sdf(mask, sp):
    """signed distance to a mask's surface, mm: negative inside"""
    return (ndi.distance_transform_edt(~mask) - ndi.distance_transform_edt(mask)) * sp


def landmarks():
    return json.loads((MODELS.parent.parent / 'src' / 'data' / 'landmarks.json').read_text(encoding='utf-8'))[NAME]


def fit():
    """The donor leg onto each CAP hip: { side: { s, R, t, mirror, ease } } for q = s R (M p + ease) + t,
    p the CAP's mm (x patient right, y anterior, z up, z = 0 its slice 0) and q the donor's (the shipped
    lower extremity: x patient left, y posterior, z up), M the mirror x -> -x for the left (the donor
    is a right leg). Started from the measured femoral heads (landmarks.json)."""
    from app import pediatric_reg as R
    from app.build_pediatric import load_leg
    mat = pregraft()
    k_seam = seam_slice(mat)
    assert k_seam == SEAM, k_seam
    fem = cap_femurs(mat)
    leg = load_leg()
    D = np.array(leg['head'])
    LM = landmarks()
    dims = json.loads((MODELS / NAME / f'{NAME}.model.json').read_text(encoding='utf-8'))['dims']
    Qall = pts(R.surface(filled(leg['femur'])), leg['sp'])
    R0 = np.diag([-1.0, -1.0, 1.0])                         # the CAP's frame to the donor's: x and y turned
    fits = {}
    for side in ('right', 'left'):
        M = np.diag([-1.0, 1.0, 1.0]) if side == 'left' else np.eye(3)
        P = pts(R.surface(filled(fem[side])), SP)
        P = P[P[:, 2] >= (k_seam + 1) * SP] @ M.T           # (the cut at the seam is no surface)
        h = LM[f'femoralHead{side[0].upper()}']
        # (cm from the shipped volume's centre, grafted or not: the old slices are the top ones)
        hc = (np.array([h['x'], h['y'], h['z']]) * 10 + (np.array(dims) - 1) / 2 * SP
              - [0, 0, (dims[2] - mat.shape[0]) * SP]) @ M.T
        # the donor femur the CAP has: from the head down as far as the CAP goes, and a margin
        Q = Qall[Qall[:, 2] >= D[2] - (hc[2] - P[:, 2].min()) - 20]
        best = None
        for yaw in np.radians([-20, -10, 0, 10, 20]):        # rigid, the heads on each other, a few turns
            Ry = R.axis_angle([0, 0, 1], yaw) @ R0
            got = R.icp_similarity(P, Q, 1.0, Ry, D - Ry @ hc, iters=60, trim=0.85, scale=False)
            if best is None or got[3] < best[3]:
                best = got
        s, Rm, t, med = R.icp_similarity(P, Q, *best[:3], iters=60, trim=0.85)   # then the scale
        fits[side] = dict(P=P, Q=Q, M=M, s=s, R=Rm, t=t, med=med, rigid=best[3], hc=hc)
    # one scale for both legs (the outsides of the bones: the marrow filled, or a fit shrinks the
    # one's cortex onto the other's marrow)
    s = float(np.mean([f['s'] for f in fits.values()]))
    out = {'seam': int(k_seam), 'scale': s}
    for side, f in fits.items():
        _, Rm, t, med = R.icp_similarity(s * f['P'], f['Q'], 1.0, f['R'], f['t'], iters=40, trim=0.85, scale=False)
        # the ease: the CAP's last cross-section of its femur against the donor's there
        Fv = pts(filled(fem[side]), SP) @ f['M'].T
        Dp = ((pts(filled(leg['femur']), leg['sp']) - t) @ Rm) / s
        zs = k_seam * SP
        cs, ds = Fv[np.abs(Fv[:, 2] - zs) <= SP / 2], Dp[np.abs(Dp[:, 2] - zs) <= SP / 2]
        ease = ds.mean(0) - cs.mean(0); ease[2] = 0.0
        a_c, a_d = len(cs) * SP * SP, len(ds) * (leg['sp'] / s) ** 3 / SP
        log(f'{side}: scale {f["s"]:.3f} alone, {s:.3f} both; ICP median {f["rigid"]:.2f} mm rigid, {med:.2f} scaled; '
            f'at the seam the femur {a_c:.0f} mm2 (donor {a_d:.0f}), eased {np.linalg.norm(ease):.1f} mm')
        out[side] = dict(s=s, R=Rm.tolist(), t=t.tolist(), mirror=side == 'left', ease=ease.tolist())
    (WORK / 'fit.json').write_text(json.dumps(out, indent=1), encoding='utf-8')
    return out


SOFT_OK = [FAT, MUSCLE, SOFT]
FEMUR_MM = 16.0            # the CAP's last femur section into the donor's femur


def soft(m):
    """a material as the thigh's soft tissue: the skin inside the new skin is fat; bone, cartilage and
    anything with an identity (the vessels', the gut's: the CAP's arclength files count them) muscle;
    air and lung nothing"""
    out = np.where(np.isin(m, SOFT_OK), m, MUSCLE).astype(np.uint8)
    out[m == SKIN] = FAT
    out[(m == AIR) | (m == 1)] = AIR
    return out


def marrow(m):
    """a material inside a femur's outline: bone, or its marrow (fat, or soft tissue at 2 mm)"""
    out = np.where(np.isin(m, [TRABECULAR, CORTICAL] + SOFT_OK), m, TRABECULAR).astype(np.uint8)
    out[m == AIR] = AIR
    return out


def compose():
    from app.build_pediatric import load_leg
    from scipy.ndimage import map_coordinates
    fitd = json.loads((WORK / 'fit.json').read_text(encoding='utf-8'))
    mat = pregraft()
    seam = fitd['seam']
    nz, ny, nx = mat.shape
    G = ADD_SLICES + seam                                     # graft rows: the new slices and the CAP's bad ones
    leg = load_leg()
    dmat, dfem = leg['mat'], filled(leg['femur'])
    # the graft's grid in the CAP's mm (z = 0 its old slice 0)
    kk = np.arange(G) - ADD_SLICES
    Z, Y, X = np.meshgrid(kk * SP, np.arange(ny) * SP, np.arange(nx) * SP, indexing='ij')
    P = np.stack([X, Y, Z], -1)
    zs = seam * SP
    w_b = smoothstep((zs - Z) / BAND_MM)                      # 0 at the seam: the CAP's outline; 1: the donor's
    w_f = smoothstep((zs - Z) / FEMUR_MM)
    w_e = smoothstep((Z - (zs - EASE_MM)) / EASE_MM)          # 1 at the seam: the donor femur on the CAP's
    # the CAP's last slice, carried down
    c2 = mat[seam]
    cfem = cap_femurs(mat)
    cf2 = filled(cfem['right'])[seam] | filled(cfem['left'])[seam]
    sdf_c = np.broadcast_to(sdf(ndi.binary_fill_holes(c2 > 0), SP), Z.shape)
    sdf_cf = np.broadcast_to(sdf(cf2, SP), Z.shape)
    # its soft tissue across the band: the CAP's own slices above the seam, reflected in it (the last
    # slice carried down draws its fat and muscle out into streaks)
    refl = np.clip(2 * seam - kk, seam, nz - 1)
    m_c = np.where(mat[refl] > 0, mat[refl], c2[None])
    # the donor, cropped to what the graft reaches, its distances in the CAP's mm
    best = np.full(Z.shape, 1e9, np.float32)
    sd_f = np.full(Z.shape, 1e9, np.float32)
    m_d = np.zeros(Z.shape, np.uint8)
    for side in ('right', 'left'):
        f = fitd[side]
        s, Rm, t, e = f['s'], np.array(f['R']), np.array(f['t']), np.array(f['ease'])
        M = np.diag([-1.0, 1.0, 1.0]) if f['mirror'] else np.eye(3)
        q = s * ((P @ M.T) + w_e[..., None] * e) @ Rm.T + t
        kq = q[..., 2] / leg['sp']
        k0, k1 = max(0, int(kq.min()) - 4), min(dmat.shape[0], int(kq.max()) + 5)
        sb = sdf(ndi.binary_fill_holes(dmat[k0:k1] > 0), leg['sp']) / s
        sf = sdf(dfem[k0:k1], leg['sp']) / s
        idx = np.stack([kq - k0, q[..., 1] / leg['sp'], q[..., 0] / leg['sp']])
        d_b = map_coordinates(sb, idx, order=1, cval=50.0).astype(np.float32)
        d_f = map_coordinates(sf, idx, order=1, cval=50.0).astype(np.float32)
        ni = np.round(idx).astype(int)
        ok = np.all([(ni[a] >= 0) & (ni[a] < sb.shape[a]) for a in range(3)], 0)
        md = np.zeros(Z.shape, np.uint8)
        md[ok] = dmat[k0:k1][ni[0][ok], ni[1][ok], ni[2][ok]]
        mine = d_b < best
        best[mine] = d_b[mine]
        m_d[mine] = md[mine]
        sd_f = np.minimum(sd_f, d_f)
        log(f'{side}: donor slices {k0}-{k1} for the graft')
    env = (1 - w_b) * sdf_c + w_b * best < 0
    fem = ((1 - w_f) * sdf_cf + w_f * sd_f < 0) & env
    u = np.random.default_rng(7).random(Z.shape)
    # inside the femur: the CAP's last section or the donor's, dithered across FEMUR_MM; elsewhere the
    # CAP's soft tissue or the donor's, dithered across BAND_MM
    fc, fd = marrow(m_c), marrow(m_d)
    in_cf, in_df = sdf_cf < 0, sd_f < 0
    take_d = np.where(in_cf & in_df, u < w_f, in_df)
    bone = np.where(take_d, fd, np.where(in_cf, fc, TRABECULAR))
    sc, sd = soft(m_c), soft(m_d)
    take_d = np.where((sc > 0) & (sd > 0), u < w_b, sd > 0)
    tissue = np.where(take_d, sd, sc)
    tissue[tissue == AIR] = FAT
    g = np.where(fem, bone, np.where(env, tissue, AIR)).astype(np.uint8)
    g[fem & (g == AIR)] = FAT
    # no bone outside the femurs (the donor's other bone, the CAP's carried down): muscle
    g[~fem & np.isin(g, [TRABECULAR, CORTICAL, CARTILAGE])] = MUSCLE
    # a new skin: the graft's body against the air, the CAP's above going on as it is; the thighs'
    # cut end left open (its last slice is thigh, not a floor of skin: the femur's shaft is found
    # there, core/limbPose.js)
    full = np.concatenate([g, mat[seam:seam + 3]]) > 0
    full = np.concatenate([full[:1].repeat(2, 0), full, full[-1:].repeat(2, 0)])
    shell = (full & ~ndi.binary_erosion(full, iterations=1, border_value=0))[2:]
    g[shell[:G] & (g > 0)] = SKIN
    new = np.concatenate([g, mat[seam:]])
    log(f'graft {G} slices ({ADD_SLICES} new); volume {nx} x {ny} x {new.shape[0]}')
    return new, G


def check(new, G):
    """no air inside the body across the seam, one femur a side running on through it"""
    body = new > 0
    holes = sum(int((ndi.binary_fill_holes(body[k]) & ~body[k]).sum()) for k in range(G + 4))
    bone = np.isin(new[:G + 20], [TRABECULAR, CORTICAL])
    lab, n = ndi.label(bone)
    sizes = sorted(ndi.sum(bone, lab, range(1, n + 1)))
    log(f'check: {holes} air voxels enclosed in the body over the graft; {n} bone pieces from the foot to 4 cm '
        f'over the seam, the two largest {[int(v) for v in sizes[-2:]]} voxels, the rest {int(sum(sizes[:-2]))}')
    for k in (G - 8, G - 4, G - 2, G - 1, G, G + 2):
        a = body[k].sum() * SP * SP / 100
        b = np.isin(new[k], [TRABECULAR, CORTICAL]).sum() * SP * SP / 100
        log(f'   slice {k}: body {a:.0f} cm2, bone {b:.1f} cm2')


def write(new):
    h = json.loads((MODELS / NAME / f'{NAME}.model.json').read_text(encoding='utf-8'))
    nz, ny, nx = new.shape
    np.ascontiguousarray(new).tofile(MODELS / NAME / f'{NAME}.mat.bin')
    h['dims'] = [nx, ny, nz]
    h['materialsPresent'] = sorted(int(v) for v in np.unique(new))
    (MODELS / NAME / f'{NAME}.model.json').write_text(json.dumps(h, indent=1), encoding='utf-8')
    _build_mesh(new, SP, str(MODELS / NAME / f'{NAME}.glb'))
    log(f'wrote {NAME}: {nx} x {ny} x {nz}')


def main(what='all'):
    if what in ('fit', 'all'):
        fit()
    if what in ('compose', 'all'):
        new, G = compose()
        check(new, G)
        if what == 'all' or '--write' in sys.argv:
            write(new)
        np.save(WORK / 'grafted.npy', new)


