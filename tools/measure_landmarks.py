"""Measure the anatomical landmarks the x-ray protocols centre on, from the voxel models.

    python tools/measure_landmarks.py        # writes apps/web/src/data/landmarks.json

Each landmark is MEASURED from the model's own bone, not paced out from a guess, and carries
how it was found and how sure that is. Positions are in the model's VOLUME frame, in cm from
the volume centre (x, y, z with z along the body/limb, +z superior); the app maps them into the
world through the same flips and rotation it applies to the phantom.

Why profiles and not bones: at 1.5 mm the segmentation fills joint spaces with bone, so each
limb is ONE connected component end to end — connected components cannot separate femur from
tibia. What survives is the cross-section: along a limb the bone area bulges at each pair of
epiphyses and dips at the joint space between them. Only the main limb component is profiled,
so the ribs and ilium that come with the arm crop, and the edge of the other leg that comes with
the leg crop, cannot pull a landmark sideways.
"""
import json, pathlib
import numpy as np
from scipy import ndimage as ndi
from scipy.signal import find_peaks

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODELS = ROOT / 'apps' / 'web' / 'public' / 'models'
OUT = ROOT / 'apps' / 'web' / 'src' / 'data' / 'landmarks.json'


def load(name):
    h = json.loads((MODELS / name / f'{name}.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    sp = np.array(h['spacing'], float) / 10.0                          # cm per voxel
    vol = np.fromfile(MODELS / name / f'{name}.mat.bin', dtype=np.uint8).reshape(nz, ny, nx)
    from measure_palpation import skeleton_ids                       # (with its joint cartilage)
    bone = np.isin(vol, skeleton_ids(name, h))
    return h, vol, bone, sp


def main_component(bone, bridge=4):
    """The main skeleton: with its joint spaces open (services/compute/app/joint_space.py) a part is
    many separate bones, so pieces are joined across a joint's width (`bridge` voxels) first."""
    lab, n = ndi.label(ndi.binary_dilation(bone, iterations=bridge))
    sizes = ndi.sum(bone, lab, range(1, n + 1))
    return bone & (lab == (int(np.argmax(sizes)) + 1))


def at(mask, z, sp, prefer='largest'):
    """Landmark at slice z: centroid of the LARGEST bone island in that slice, as cm from the
    volume centre. The whole-slice centroid was the first version, and it put the elbow 2-3 cm
    to one side on the rendered film: at that level the arm's slice also cuts torso fragments
    fused into the same 3-D component, and they dragged the centre toward the body."""
    nz, ny, nx = mask.shape
    lab, k = ndi.label(mask[z])
    if k > 1:
        sizes = np.asarray(ndi.sum(mask[z], lab, range(1, k + 1)))
        if prefer == 'midline':
            # the spine: of the islands big enough to be a vertebra, the one nearest the midline —
            # "largest" picked a clavicle at the neck and put the cervical spine 17 cm off-centre
            cx = np.asarray(ndi.center_of_mass(mask[z], lab, range(1, k + 1)))[:, 1]
            ok = sizes >= 0.25 * sizes.max()
            pick = int(np.argmin(np.where(ok, np.abs(cx - nx / 2), np.inf)))
            ys, xs = np.nonzero(lab == pick + 1)
        else:
            # a forearm is TWO islands, radius and ulna ~2.3 cm apart, so take every island within
            # 3 cm of the largest. The largest alone centred the forearm on the radius; 5 cm
            # reached the fibula at the knee and pulled the joint 1.8 cm lateral (checked by tracing
            # the posed phantom: the knee itself sat where the 1-island landmark put it). Clinical
            # centring is on the joint, fibula head excluded. The arm model's torso is 10 cm away.
            com = np.asarray(ndi.center_of_mass(mask[z], lab, range(1, k + 1)))
            big = int(np.argmax(sizes))
            near = [i for i in range(k) if np.hypot(*((com[i] - com[big]) * sp[[1, 0]])) <= 3.0]
            sel = np.isin(lab, [i + 1 for i in near])
            ys, xs = np.nonzero(sel)
    else:
        ys, xs = np.nonzero(mask[z])
    if not len(xs):                                                   # empty slice: volume centre
        return {'x': 0.0, 'y': 0.0, 'z': round((z - nz / 2) * sp[2], 2)}
    # Mediolaterally, a joint is centred MIDWAY BETWEEN ITS OUTER BONE MARGINS — what a
    # radiographer palpates — not at its centre of mass, which leans toward wherever the bone is
    # thickest (the medial condyle, the radius beside a slim ulna).
    return {'x': round(((xs.min() + xs.max()) / 2 - nx / 2) * sp[0], 2), 'y': round((ys.mean() - ny / 2) * sp[1], 2),
            'z': round((z - nz / 2) * sp[2], 2)}


def profile(mask, sp):
    return ndi.uniform_filter1d(mask.sum(axis=(1, 2)).astype(float) * sp[0] * sp[1], 3)


def valley(prof, sp, a, b):
    """The most prominent dip between two bulges in [a, b] cm — a joint space."""
    za, zb = int(a / sp[2]), int(b / sp[2])
    idx, props = find_peaks(-prof[za:zb], prominence=0.5)
    if not len(idx):
        return None, 0.0
    k = int(np.argmax(props['prominences']))
    return za + int(idx[k]), float(props['prominences'][k])


def bulge(prof, sp, a, b):
    za, zb = int(a / sp[2]), int(b / sp[2])
    return za + int(np.argmax(prof[za:zb]))


def mark(mask, z, sp, how, sure, prefer='largest'):
    return {**at(mask, z, sp, prefer), 'how': how, 'confidence': sure}


def lower_extremity():
    h, vol, bone, sp = load('lowerextremity')
    m = main_component(bone); p = profile(m, sp)
    # windows from the TOP (the hip): the foot, baked to 90 degrees (services/compute/app/bake_pose.py),
    # no longer reaches down along the leg, and the volume's lower end moved up 6.5 cm with it
    top = m.shape[0] * sp[2]
    knee, prom = valley(p, sp, top - 57, top - 44)
    ankle = bulge(p, sp, top - 98, top - 86)
    # the femoral head 33-47 cm above the knee (a femur's length; from the top, the iliac wing's
    # bulge stood in for it on a shorter patient)
    kz = knee * sp[2]
    hip = bulge(p, sp, kz + 33, min(kz + 47, top - 1))
    femur = (knee + hip) // 2
    foot = int(3.0 / sp[2])
    return {
        'knee': mark(m, knee, sp, f'joint-space valley between the condyles and the plateau (prominence {prom:.1f} cm2)', 'high'),
        'ankle': mark(m, ankle, sp, 'peak of the malleolar bulge — the clinical centring point, midway between the malleoli; '
                                     'tibia and talus are fused in the segmentation, so there is no joint-space dip to find', 'medium'),
        'hip': mark(m, hip, sp, 'peak of the proximal bulge: femoral head and trochanters', 'medium'),
        'femur': mark(m, femur, sp, 'midway between the knee and hip landmarks', 'medium'),
        'foot': mark(m, foot, sp, 'tarsals, 3 cm above the inferior end (the sole of the foot at 90 degrees)', 'low'),
    }


def bones_per_slice(mask, sp, min_cm2=0.15):
    """How many separate bones each slice cuts (2-D islands above a speck threshold)."""
    out = []
    for z in range(mask.shape[0]):
        lab, k = ndi.label(mask[z])
        if not k:
            out.append(0); continue
        areas = np.asarray(ndi.sum(mask[z], lab, range(1, k + 1))) * sp[0] * sp[1]
        out.append(int((areas > min_cm2).sum()))
    return np.array(out)


def upper_extremity():
    """The arm (z033 since the rebuild: services/compute/app/build_limbs.py), measured by its
    anatomy rather than by where along the crop things fell in the previous model:
    - the humeral shaft is the longest run of slices that cut ONE bone of shaft size;
    - the elbow is the widest the bone gets in the 8 cm below it: the epicondyles. Widest in either
      direction: this arm rests rotated, its epicondyles front to back;
    - the radiocarpal joint is the thinnest bone between 18 and 28 cm below the elbow (the forearm is
      22-25 cm), and the wrist landmark sits 1.5 cm past it, on the carpals;
    - the humeral head is the biggest bone section in the 12 cm above the shaft.
    The two-bone count used before cannot find this forearm: it is pronated, and where the radius
    crosses the ulna the two read as one; and the fingers are not joined to the rest at 1.5 mm."""
    h, vol, bone, sp = load('upperextremity')
    n = bone.shape[0]
    area = bone.sum(axis=(1, 2)) * sp[0] * sp[1]
    def pieces(z):
        lab, k = ndi.label(bone[z])
        return (np.asarray(ndi.sum(bone[z], lab, range(1, k + 1))) * sp[0] * sp[1]) if k else np.zeros(0)
    one = np.array([(lambda p: (p > 0.5).sum() == 1 and 1.5 < p.max() < 5.5)(pieces(z)) for z in range(n)])
    one = ndi.median_filter(one.astype(np.uint8), size=5).astype(bool)
    runs, cur = [], None
    for z, v in enumerate(list(one) + [False]):
        if v and cur is None: cur = z
        elif not v and cur is not None: runs.append((cur, z - 1)); cur = None
    h0, h1 = max((r for r in runs if r[0] > 0.25 * n), key=lambda r: r[1] - r[0])
    def span(z):
        ys, xs = np.nonzero(bone[z])
        return max(xs.max() - xs.min(), ys.max() - ys.min()) if len(xs) else 0
    elbow = max(range(max(0, h0 - int(8 / sp[2])), h0 + int(1 / sp[2])), key=span)
    lo, hi = max(0, elbow - int(28 / sp[2])), max(1, elbow - int(18 / sp[2]))
    rc = lo + int(np.argmin(ndi.uniform_filter1d(area, 3)[lo:hi]))
    wrist = max(0, rc - int(1.5 / sp[2]))
    top = min(n, h1 + int(12 / sp[2]))
    shoulder = h1 + int(np.argmax(area[h1:top]))
    return {
        'elbow': mark(bone, elbow, sp, f'widest bone in the 8 cm below the humeral shaft (which ends at {h0 * sp[2]:.1f} cm): the epicondyles', 'high'),
        'forearm': mark(bone, (rc + elbow) // 2, sp, 'midway between the radiocarpal joint and the epicondyles', 'high'),
        'wrist': mark(bone, wrist, sp, f'1.5 cm past the radiocarpal joint (the thinnest bone 18-28 cm below the elbow, at {rc * sp[2]:.1f} cm): the carpals', 'medium'),
        'shoulder': mark(bone, shoulder, sp, 'biggest bone section in the 12 cm above the humeral shaft: the humeral head', 'medium'),
        'humerus': mark(bone, (elbow + shoulder) // 2, sp, 'midway between the elbow and shoulder landmarks', 'medium'),
    }


def hand():
    """The hand is counted, not profiled. Each slice across the hand cuts a number of separate
    bones: one or two through the distal forearm and carpals, FIVE through the metacarpals, then
    four and three as the shorter fingers end. That count is a far stronger anatomical signal
    than the bone area — an earlier reading of the area alone had the hand upside down."""
    h, vol, bone, sp = load('hand')
    nz = bone.shape[0]
    def rays(z):
        col = bone[z].any(axis=0)
        return int((col[1:] & ~col[:-1]).sum() + col[0])
    counts = [rays(z) for z in range(nz)]
    five = [z for z, c in enumerate(counts) if c >= 5]
    mc0, mc1 = five[0], five[-1]                                  # the metacarpal zone
    tip = max(z for z, c in enumerate(counts) if c > 0)          # most distal fingertip
    wrist = max(0, mc0 - int(2.0 / sp[2]))
    pip = (mc1 + tip) // 2
    return {
        'wrist': mark(bone, wrist, sp, '2 cm proximal of the first slice that cuts all five metacarpals: the carpals', 'high'),
        'hand': mark(bone, mc1, sp, 'distal end of the five-metacarpal zone: the MCP joints, the PA hand centring point', 'high'),
        'fingers': mark(bone, pip, sp, 'midway from the MCP joints to the fingertips: PIP level', 'medium'),
    }


HEADNECK_LABELS = ROOT / 'services' / 'compute' / 'data' / 'totalseg' / 's1082' / 'segmentations'
HEADNECK_CT = 's1082'


def vertebrae_from_labels(bone, sp, levels=('C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'T1')):
    """Vertebral bodies from the CT's own vertebra labels, registered to the model: {level: point}.

    The head & neck model is built from that CT (services/compute/app/build_limbs.py headneck) at
    its native 1.5 mm, so the labels and the model differ only by the builder's crop: the offset is
    found by sliding the union of the masks over the model's bone (FFT cross-correlation) and is
    accepted only if the masks then sit on bone. The body is the anterior 40 % of each vertebra
    (anterior is +y in this volume); the centroid of the whole bone sits back in the posterior arch.

    Why labels: the profile method took 'the narrowest bone section between the skull and the
    shoulders', which in the first head CT (s1397, arms raised) was C1, not C4, and both cervical
    views were centred 4.8 cm high. Returns None when the labels or nibabel are missing."""
    try:
        import nibabel as nib
        from scipy.signal import fftconvolve
    except ImportError:
        return None
    files = {k: HEADNECK_LABELS / f'vertebrae_{k}.nii.gz' for k in levels}
    if not all(f.exists() for f in files.values()):
        return None
    labs = {k: np.asarray(nib.load(str(f)).dataobj) > 0 for k, f in files.items()}   # [i, j, k] = [x, y, z]
    union = np.zeros_like(labs[levels[0]])
    for a in labs.values():
        union |= a
    idx = np.argwhere(union)
    lo, hi = idx.min(0), idx.max(0) + 1
    tmpl = union[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]].astype(np.float32)
    bxyz = bone.transpose(2, 1, 0).astype(np.float32)                  # model as [x, y, z]
    corr = fftconvolve(bxyz, tmpl[::-1, ::-1, ::-1], mode='valid')
    at = np.array(np.unravel_index(int(np.argmax(corr)), corr.shape))
    on_bone = float(corr[tuple(at)] / tmpl.sum())
    if on_bone < 0.95:
        print(f'  vertebra labels did not register (only {on_bone:.1%} on bone) — using the profile')
        return None
    off = at - lo
    nx, ny, nz = bxyz.shape
    cm = lambda i, n, s: round(float((i - (n - 1) / 2) * s), 2)
    out = {}
    for k in levels:
        v = np.argwhere(labs[k]) + off
        ys = v[:, 1]
        body = v[ys >= ys.max() - 0.4 * (ys.max() - ys.min())]
        cx, cy, cz = body.mean(0)
        out[k] = {'x': cm(cx, nx, sp[0]), 'y': cm(cy, ny, sp[1]), 'z': cm(cz, nz, sp[2]),
                  'zTop': cm(v[:, 2].max(), nz, sp[2]), 'zBottom': cm(v[:, 2].min(), nz, sp[2]),
                  'how': f'{k} vertebral body, from the vertebra labels of the CT ({HEADNECK_CT}), registered to the model '
                         f'({on_bone:.1%} of label voxels on bone)', 'confidence': 'high'}
    return out


_REG = {}


def label_offset(bone):
    """The offset from the head CT's label grid to the model's (the builder's crop), registered on
    the cervical vertebrae as vertebrae_from_labels does; cached. None when it cannot be found."""
    if 'off' in _REG:
        return _REG['off']
    try:
        import nibabel as nib
        from scipy.signal import fftconvolve
    except ImportError:
        _REG['off'] = None
        return None
    files = [HEADNECK_LABELS / f'vertebrae_C{k}.nii.gz' for k in range(1, 8)]
    if not all(f.exists() for f in files):
        _REG['off'] = None
        return None
    union = None
    for f in files:
        a = np.asarray(nib.load(str(f)).dataobj) > 0
        union = a if union is None else (union | a)
    idx = np.argwhere(union)
    lo, hi = idx.min(0), idx.max(0) + 1
    tmpl = union[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]].astype(np.float32)
    corr = fftconvolve(bone.transpose(2, 1, 0).astype(np.float32), tmpl[::-1, ::-1, ::-1], mode='valid')
    at = np.array(np.unravel_index(int(np.argmax(corr)), corr.shape))
    _REG['off'] = (at - lo) if corr[tuple(at)] / tmpl.sum() >= 0.95 else None
    return _REG['off']


def label_points(name, bone, sp):
    """A label of the head CT as model-frame points in cm from the volume centre ([N, 3] x y z), or
    None."""
    import nibabel as nib
    off = label_offset(bone)
    f = HEADNECK_LABELS / f'{name}.nii.gz'
    if off is None or not f.exists():
        return None
    v = np.argwhere(np.asarray(nib.load(str(f)).dataobj) > 0) + off
    n = np.array(bone.shape[::-1])
    return (v - (n - 1) / 2) * np.asarray(sp)


def cervical_from_labels(bone, sp, level=4):
    v = vertebrae_from_labels(bone, sp)
    if not v:
        return None
    c = dict(v[f'C{level}'])
    c.pop('zTop'); c.pop('zBottom')
    return c


def head_neck():
    h, vol, bone, sp = load('headneck')
    p = profile(bone, sp)
    nz = bone.shape[0]
    # the skull is the big bone mass at the top; the neck below it is vertebrae alone. The
    # narrowest bone section between the skull and the shoulders is the mid-cervical spine.
    skull = bulge(p, sp, nz * sp[2] * 0.55, nz * sp[2] * 0.98)
    zs = np.arange(nz); upper = zs > int(0.5 * nz)
    zc = int((p[upper] * zs[upper]).sum() / p[upper].sum())     # bone-weighted centre of the skull
    neck = int(np.argmin(p[int(0.15 * nz): int(0.5 * nz)])) + int(0.15 * nz)
    cs = cervical_from_labels(bone, sp) or mark(
        bone, neck, sp, 'narrowest bone section between the skull and the shoulders (lands on C1 in this CT; '
        'fetch the vertebra labels for C4); the island nearest the midline', 'low', prefer='midline')
    return {
        'skull': mark(bone, zc, sp, 'bone-weighted centre of the upper half (the cranium)', 'medium'),
        'cspine': cs,
        '_skullPeak': {'z': round((skull - nz / 2) * sp[2], 2)},
    }


# The trunk landmarks were measured by the DXA landmark finder (apps/web/src/dxa.js,
# findLandmarks + findTrochanters) on the same chest/abdomen/pelvis model, in the world frame the
# x-ray mode uses — crest, femoral heads, and a lumbar period of 3.6 cm from the level finder.
# They are carried here rather than re-derived so the two modes cannot disagree.
CAP_FROM_DXA = {
    'crest': -12.7, 'femoralHeads': -25.7, 'lumbarPeriod': 3.6,
}


def vertebral_body_y(bone, sp, z_cm):
    """AP depth (cm from the volume centre) of the vertebral body at z_cm. The trunk laterals need
    it: rolled a quarter turn, a landmark's AP coordinate becomes the cross-table offset, and with
    none the lateral lumbar was centred 4 cm in front of the spine (its central ray crossed liver
    and kidney and no bone at all). Body = the bone between the front of the spinal canal and the
    front of the vertebra on the midline; the canal is the largest hole enclosed by the spine's
    island. Averaged over the slices within 1 cm where the canal is closed."""
    nz, ny, nx = bone.shape
    mid, out = nx // 2, []
    k0 = int(round(z_cm / sp[2] + (nz - 1) / 2))
    for k in range(k0 - 5, k0 + 6):
        lab, n = ndi.label(bone[k])
        cand = [(int(np.sum(lab == i)), i) for i in set(np.unique(lab[:ny // 2, mid - 2:mid + 3])) - {0}]
        if not cand:
            continue
        isl = lab == max(cand)[1]
        holes = ndi.binary_fill_holes(isl) & ~isl
        hl, hn = ndi.label(holes)
        if not hn:
            continue
        sizes = ndi.sum(holes, hl, range(1, hn + 1))
        if sizes.max() * sp[0] * sp[1] < 1.0:          # no closed canal in this slice
            continue
        canal = hl == (int(np.argmax(sizes)) + 1)
        ya = (np.nonzero(isl[:, mid - 2:mid + 3].any(1))[0].max() - (ny - 1) / 2) * sp[1]
        yc = (np.nonzero(canal.any(1))[0].max() - (ny - 1) / 2) * sp[1]
        out.append((ya + yc) / 2)
    return round(float(np.median(out)), 2)


def chest_abdo_pelvis():
    """Trunk centring. The crest comes from the DXA landmark finder (so the modes cannot
    disagree); the pelvis is measured here, because the first version derived it from the
    femoral-head height the DXA work took from an inscribed sphere — which that work itself
    found sits in the acetabular roof — and the rendered AP pelvis came out ~3-5 cm high.

    AP pelvis is centred midway between the ASIS and the pubic symphysis:
      symphysis — the only bone that is both at the midline AND anterior, low in the pelvis
                  (the sacrum is midline but posterior); the most inferior run of it, specks of
                  under three slices ignored.
      ASIS      — per side, the most anterior bone point 6-14 cm from the midline, searched only
                  BELOW the crest (above it, the lower ribs are anterior too)."""
    h, vol, bone, sp = load('chestabdopelvis')
    nz, ny, nx = bone.shape
    zcm = lambda z: (z - nz / 2) * sp[2]
    zi = lambda cm: int(cm / sp[2] + nz / 2)
    c, per = CAP_FROM_DXA['crest'], CAP_FROM_DXA['lumbarPeriod']
    # which way is anterior: the lumbar spine is midline and posterior
    sl = slice(int(nz * 0.55), int(nz * 0.75))
    my = np.nonzero(bone[sl, :, nx // 2 - 5:nx // 2 + 5])[1].mean()
    by = np.nonzero(vol[sl] > 0)[1].mean()
    ant = slice(ny // 2, ny) if my < by else slice(0, ny // 2)
    half = int(1.5 / sp[0]); xc = nx // 2
    zs = [z for z in range(0, zi(c)) if bone[z, ant, xc - half:xc + half].sum() > 3]
    runs, cur = [], [zs[0]]
    for z in zs[1:]:
        if z - cur[-1] <= 2: cur.append(z)
        else: runs.append(cur); cur = [z]
    runs.append(cur)
    sym = next(r for r in runs if len(r) >= 3)                 # the most inferior real run
    sym_z = zcm((sym[0] + sym[-1]) / 2)
    asis = []
    for x0, x1 in ((xc - int(14 / sp[0]), xc - int(6 / sp[0])), (xc + int(6 / sp[0]), xc + int(14 / sp[0]))):
        best = (-1, None)
        for z in range(zi(c - 12), zi(c)):
            yy = np.nonzero(bone[z, :, x0:x1].any(axis=1))[0]
            if len(yy):
                fwd = yy.max() if my < by else -yy.min()        # "most anterior" in either storage order
                if fwd > best[0]: best = (fwd, z)
        asis.append(zcm(best[1]))
    asis_z = sum(asis) / 2
    l3 = c + 1.5 * per
    t7 = (c + 3.5 * per) + 6 * 2.6
    world = {'x': 0.0, 'y': 0.0, 'frame': 'world'}
    return {
        'kub': {**world, 'z': round(c, 2), 'how': 'iliac crest (= L4/L5), from the DXA landmark finder', 'confidence': 'high'},
        'abdomenErect': {**world, 'z': round(c + 5, 2), 'how': '5 cm above the crest, to include the diaphragm', 'confidence': 'medium'},
        'pelvis': {**world, 'z': round((asis_z + sym_z) / 2, 2),
                   'how': f'midway between the ASIS ({asis[0]:.1f} / {asis[1]:.1f}, mean {asis_z:.1f}) and the pubic symphysis ({sym_z:.1f})',
                   'confidence': 'high'},
        'lumbar': {**world, 'y': vertebral_body_y(bone, sp, l3), 'z': round(l3, 2),
                   'how': 'L3: crest (L4/L5) + 1.5 x the measured 3.6 cm lumbar period; AP depth = centre of the vertebral body', 'confidence': 'high'},
        'thoracic': {**world, 'y': vertebral_body_y(bone, sp, t7), 'z': round(t7, 2),
                     'how': 'T7: L1 + six thoracic bodies at ~2.6 cm (estimated, not measured); AP depth = centre of the vertebral body', 'confidence': 'low'},
    }


def femoral_heads(vol, sp):
    """Centre of each femoral head, for turning the leg about it (src/core/limbPose.js).

    NOT the inscribed sphere the DXA work used: filled, the head and the acetabulum fuse, and
    the largest ball fits in the acetabular roof ~2.5 cm too high. The head's surface is a
    cortical shell, and the acetabulum's is a shell CONCENTRIC with it, so the centre is where a
    2.2 cm sphere passes through the most cortical bone. Checked by eye on coronal, axial and
    sagittal slices: the circle sits on the head's cortex in all three.

    Coordinates are voxel CENTRES, (i - (n - 1) / 2) * spacing, which is how VoxelPhantom places
    a voxel. anteriorY tells the posing code which way the leg turns for "internal"."""
    cort = vol == 18
    k, j, i = np.nonzero(cort)
    nz, ny, nx = vol.shape
    P = np.stack([(i - (nx - 1) / 2) * sp[0], (j - (ny - 1) / 2) * sp[1], (k - (nz - 1) / 2) * sp[2]], 1)
    R = 2.2

    def vote(lo, hi, step):
        near = P[np.all((P > lo - R - 0.5) & (P < hi + R + 0.5), axis=1)]
        best = (-1, None)
        for x in np.arange(lo[0], hi[0] + 1e-6, step):
            for y in np.arange(lo[1], hi[1] + 1e-6, step):
                for z in np.arange(lo[2], hi[2] + 1e-6, step):
                    n = int(np.sum(np.abs(np.linalg.norm(near - (x, y, z), axis=1) - R) < 0.12))
                    if n > best[0]:
                        best = (n, np.array([x, y, z]))
        return best[1]

    out = {}
    z0 = CAP_FROM_DXA['femoralHeads']
    for name, sx in (('femoralHeadL', -1), ('femoralHeadR', +1)):   # patient right is +x in this volume
        # z0 is the DXA's inscribed sphere, which sits in the acetabular roof: the head centre is
        # at or below it. Searched above it too, the roof's own shells win on one side.
        lo, hi = np.array([6.0 if sx > 0 else -12.0, -6.0, z0 - 3]), np.array([12.0 if sx > 0 else -6.0, 3.0, z0])
        c = vote(lo, hi, 0.4)
        c = vote(c - 0.4, c + 0.4, 0.1)
        out[name] = {'x': round(float(c[0]), 2), 'y': round(float(c[1]), 2), 'z': round(float(c[2]), 2),
                     'frame': 'volume', 'r': R, 'anteriorY': 1,
                     'how': 'centre of the 2.2 cm sphere through the most cortical bone (head and acetabular shells)',
                     'confidence': 'high'}
    return out


MEASURE = {
    'lowerextremity': lambda: lower_extremity(),
    'upperextremity': lambda: upper_extremity(),
    'hand': lambda: hand(),
    'headneck': lambda: head_neck(),
    'chestabdopelvis': lambda: {**chest_abdo_pelvis(), **femoral_heads(*load('chestabdopelvis')[1::2])},
}


def main(only=None):
    """Every model, or only those named; the others keep what the file already has (the head and
    neck's C4 comes from the CT's own vertebra labels, which are not always on the machine)."""
    old = json.loads(OUT.read_text(encoding='utf-8')) if OUT.exists() else {}
    out = {'_about': ('Anatomical centring landmarks for the x-ray protocols, measured by tools/measure_landmarks.py. '
                      'Volume-frame entries are cm from the volume centre (x, y, z; +z superior) and are mapped to the '
                      'world through the same flips and rotation as the phantom. Entries marked frame:"world" are '
                      'already in the x-ray world frame. Re-run the tool after rebuilding a model.')}
    for name, fn in MEASURE.items():
        out[name] = fn() if (not only or name in only) else old[name]
    OUT.write_text(json.dumps(out, indent=2) + '\n', encoding='utf-8')
    for model, lm in out.items():
        if model.startswith('_') or (only and model not in only):
            continue
        for k, v in lm.items():
            if not k.startswith('_'):
                print(f'{model:16} {k:13} z {v["z"]:+7.2f}  x {v.get("x", 0):+6.2f}  y {v.get("y", 0):+6.2f}  [{v.get("confidence", "-")}]')
    print('wrote', OUT.relative_to(ROOT))


if __name__ == '__main__':
    import sys
    main(sys.argv[1:] or None)
