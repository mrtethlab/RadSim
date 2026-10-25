"""Measure the JOINTS the positioning panel can bend, on each limb model.

    python tools/measure_palpation.py && python tools/measure_centring.py   # first
    python tools/measure_joints.py           # writes apps/web/src/data/joints.json

A joint here is a centre of rotation, the limb direction that points distally (the side that
moves), the half-width of the skin crease, and its motions. Each motion names the direction its
positive angle turns the distal part TOWARD (ulnar, palmar, anterior, ...); the app makes the
rotation axis from that (core/jointPose.js). Rest frame, cm (x = patient's right, y = anterior,
z = superior; on the hand y = dorsal, z = toward the fingertips).

Centres of rotation, from the anatomy rather than the bone surface:
- wrist: the head of the capitate (the wrist's instant centre for both flexion and deviation),
  about 1.2 cm distal of the radiocarpal joint on the line of the 3rd metacarpal;
- elbow: the trochlea/capitulum axis, 1.5 cm distal of the widest span of the epicondyles;
- knee: the measured joint space between the condyles and the plateau;
- ankle: midway between the malleoli (the talocrural axis passes just below their tips).

ROLLS (roll: true) turn the distal part about the limb's own axis (core/jointPose.js): the
forearm's pronation and supination, spread along it (`spread`, cm past the elbow: the radius
turns round the ulna over the forearm's length); the hand's roll at the wrist; the leg's rotation
at the knee; the foot's at the ankle. Positive turns `from` toward `toward`. The forearm's roll
is anatomical: 0 is supination (palm up, the radius beside the ulna laterally), -90 the thumb up,
-180 the palm down; its `rest` is measured from where the radius lies round the ulna.

THE NECK is a FIELD joint (core/jointPose.js): no plane through the neck parts the head from the
trunk (the jaw hangs in front of C1-C3), so each point turns by its own share of the one rotation,
a weight read from a grid written beside the model (headneck.neckw.bin). The skull and mandible
take all of it, each cervical vertebra less (cervical motion is shared down the segments), C7 and
everything below none; the soft tissue between takes the weights of the bones nearest it, blended
(a soft minimum of the distances) and smoothed. Its rotation is about C4, 1 cm behind the body
(the facets), with the neck's own axis from C7-T1 to C1-C2. Needs the head CT's labels and nibabel
(the compute venv: services/compute/.venv).
"""
import json, pathlib, sys
import numpy as np
from scipy import ndimage as ndi

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from measure_palpation import Vol, lm, ROOT

OUT = ROOT / 'apps' / 'web' / 'src' / 'data' / 'joints.json'
DATA = ROOT / 'apps' / 'web' / 'src' / 'data'
PALP = json.loads((DATA / 'palpation.json').read_text(encoding='utf-8'))
CENT = json.loads((DATA / 'centring.json').read_text(encoding='utf-8'))


def v3(d):
    return [round(float(d['x']), 2), round(float(d['y']), 2), round(float(d['z']), 2)]


def radial_dir(V, z):
    """The direction from the ulna to the radius at level z, in the rest frame's x-y: the radius
    is the bigger of the two bones toward the wrist. A vector, not a sign: the arm may rest turned
    (z033's lies about 90 degrees round, radius in front of the ulna)."""
    k = V.idx(2, z)
    lab, n = ndi.label(V.bone[k])
    if n < 2:
        return None
    sizes = ndi.sum(V.bone[k], lab, range(1, n + 1))
    order = np.argsort(sizes)[::-1][:2]
    cs = [np.array(ndi.center_of_mass(V.bone[k], lab, int(o) + 1)) for o in order]
    d = np.array([(cs[0][1] - cs[1][1]) * V.sp[0], (cs[0][0] - cs[1][0]) * V.sp[1], 0.0])
    return d / np.linalg.norm(d)


def perp(v, axis):
    v = np.asarray(v, float) - (np.asarray(v, float) @ axis) * axis
    return v / np.linalg.norm(v)


def perp_none(v):
    v = np.asarray(v, float)
    return (v / np.linalg.norm(v)).round(3).tolist()


def angle_about(a, b, axis):
    """The angle (degrees) turning a to b about axis."""
    return float(np.degrees(np.arctan2(np.cross(a, b) @ axis, a @ b)))


def foot_axis(ank, leg):
    """The foot's long axis, heel to toes: the principal axis of all the bone more than 2 cm past
    the ankle along the leg. Parallel to the sole, near enough, so 90 degrees to the leg is the
    neutral ankle. (The line from the ankle's centre to the base of the 3rd metatarsal, used before,
    starts up between the malleoli and points down even at neutral: a foot baked square to the leg
    by it read 17 degrees plantarflexed.)"""
    V = Vol('lowerextremity')
    P = np.stack(V.coords(V.bone), 1)[::3]
    rel = P - ank
    f = P[rel @ leg > 2.0]
    c = f.mean(0)
    w, vec = np.linalg.eigh(np.cov((f - c).T))
    ax = vec[:, int(np.argmax(w))]
    # toward the toes: the far end (by its bone, the dense calcaneus behind outweighed the slim toes,
    # and a foot square to the leg was read backwards)
    t = (f - ank) @ ax
    return ax if t.max() > -t.min() else -ax


def foot_inversion(ank, leg, fa):
    """How far the foot is rolled about its own long axis (inversion +: the dorsum turned toward
    the lateral side, the sole toward the midline): the metatarsals' width axis, the middle principal
    axis of the bone 35-70 % of the way along the foot, measured from the lateral about the foot's
    axis. z053's right foot lay inverted some 60 degrees under the crossed left leg, and its
    lateral film showed the five metatarsals fanned out as on a dorsoplantar."""
    V = Vol('lowerextremity')
    P = np.stack(V.coords(V.bone), 1)
    f = P[(P - ank) @ leg > 1.0]
    t = (f - ank) @ fa
    g = f[(t > 0.35 * t.max()) & (t < 0.70 * t.max())]
    # the width in the plane square to the foot (in 3-D the middle axis took in the metatarsals'
    # divergence along the foot, and read an upright foot as 44 degrees inverted)
    e1 = perp([1, 0, 0], fa); e2 = np.cross(fa, e1)
    q = np.stack([(g - g.mean(0)) @ e1, (g - g.mean(0)) @ e2], 1)
    w, vec = np.linalg.eigh(np.cov(q.T))
    wid = vec[0, 1] * e1 + vec[1, 1] * e2
    a = angle_about(e1, wid, fa)
    return ((a + 90) % 180) - 90                              # a width axis is a line: within +-90


# the share of the neck's rotation each bone takes (cumulative from below: what lies above the
# segment). Flexion-extension and lateral flexion spread over the column; axial rotation is half
# at C1-C2, which a single field cannot also carry — C1 and C2 stand apart a little for it.
NECK_W = {'skull': 1.0, 'vertebrae_C1': 0.95, 'vertebrae_C2': 0.8, 'vertebrae_C3': 0.62, 'vertebrae_C4': 0.45,
          'vertebrae_C5': 0.28, 'vertebrae_C6': 0.12}
NECK_STILL = ['vertebrae_C7'] + [f'vertebrae_T{k}' for k in range(1, 13)] + [f'rib_{s}_{k}' for s in ('left', 'right') for k in range(1, 13)]     + [f'{b}_{s}' for b in ('clavicula', 'scapula', 'humerus') for s in ('left', 'right')] + ['sternum', 'costal_cartilages']
FIELD_SP = 0.4          # cm, the weight grid
FIELD_LAMBDA = 1.2      # cm, how far a bone's weight reaches into the tissue beside it
FIELD_SIGMA = 0.8       # cm, the smoothing after


def neck_field(name='headneck'):
    """The neck's weight grid (uint8, 255 = the whole turn) over the model, in its rest frame; and
    its header for joints.json. None without the labels."""
    import measure_landmarks as ML
    h, vol, bone, sp = ML.load(name)
    nz, ny, nx = bone.shape
    o = -(np.array([nx, ny, nz]) - 1) / 2 * sp                     # the model's corner, cm
    dims = (np.ceil((np.array([nx, ny, nz]) - 1) * sp / FIELD_SP) + 1).astype(int)
    groups = [(k, w) for k, w in NECK_W.items()] + [(k, 0.0) for k in NECK_STILL]
    num = np.zeros(dims[::-1], np.float64); den = np.zeros(dims[::-1], np.float64)
    still = np.zeros(dims[::-1], bool)
    for k, w in groups:
        P = ML.label_points(k, bone, sp)
        if P is None or not len(P):
            if k in NECK_W:
                return None
            continue
        g = np.round((P - o) / FIELD_SP).astype(int)
        g = g[(g >= 0).all(1) & (g < dims).all(1)]
        m = np.zeros(dims[::-1], bool)
        m[g[:, 2], g[:, 1], g[:, 0]] = True
        if w == 0:
            still |= m
            continue
        e = np.exp(-ndi.distance_transform_edt(~m, sampling=FIELD_SP) / FIELD_LAMBDA)
        num += w * e; den += e
    e = np.exp(-ndi.distance_transform_edt(~still, sampling=FIELD_SP) / FIELD_LAMBDA)
    den += e
    W = ndi.gaussian_filter(num / np.maximum(den, 1e-300), FIELD_SIGMA / FIELD_SP)
    W = np.where(W < 0.02, 0, np.where(W > 0.98, 1, W))
    q = np.round(W * 255).astype(np.uint8)
    (ROOT / 'apps' / 'web' / 'public' / 'models' / name / f'{name}.neckw.bin').write_bytes(q.tobytes())
    return {'file': f'{name}.neckw.bin', 'dims': dims.tolist(), 'sp': FIELD_SP, 'origin': o.round(4).tolist()}


# THE JAW, a second field joint on the head: the mandible hinged at its condyles, so the open-mouth
# view (C1-C2) can open the mouth and take the lower teeth off the dens. The head CT labels the skull
# and mandible as one ('skull'), and with the teeth together no shape rule parts them (a watershed on
# the distance map cut inside the thin body of the mandible), so it is parted by this head's own
# measure, cm on the rest frame: below the bite (the dense crowns of both arches meet at z 0.0, read
# on the profile of cortical bone in the face), and above it the rami: lateral of the upper teeth
# (|x| over 4.0), in front of the mastoids (y 1-6), to the condyles under the skull base (z 3.4).
JAW = dict(bite=0.1, ramus_top=3.4, ramus_x=4.0, ramus_y=(1.0, 6.0))
JAW_REACH = (2.0, 6.0)  # cm from the mandible: its share whole inside, none past (the throat stretches over it)
JAW_AIRWAY = 1.5        # cm: air this far from the mandible is the airway's, held still (nearer, the mouth's)
JAW_GLIDE = [0, 1.2, -0.4]   # cm at full opening: the condyles forward and down the articular eminences
JAW_SIGMA = 1.2         # cm: the jaw's weights smoothed wider than the neck's (a shorter blend sheared the throat)


def jaw_field(name='headneck'):
    """The jaw's weight grid (255 = the whole turn) and its centre, distal direction and grid header;
    None without the labels."""
    import measure_landmarks as ML
    h, vol, bone, sp = ML.load(name)
    S = ML.label_points('skull', bone, sp)
    if S is None or not len(S):
        return None
    x, y, z = S[:, 0], S[:, 1], S[:, 2]
    mand = (z < JAW['bite']) | ((z < JAW['ramus_top']) & (np.abs(x) > JAW['ramus_x'])
                                 & (y > JAW['ramus_y'][0]) & (y < JAW['ramus_y'][1]))
    nz, ny, nx = bone.shape
    o = -(np.array([nx, ny, nz]) - 1) / 2 * sp
    dims = (np.ceil((np.array([nx, ny, nz]) - 1) * sp / FIELD_SP) + 1).astype(int)
    def mask(P):
        g = np.round((P - o) / FIELD_SP).astype(int)
        g = g[(g >= 0).all(1) & (g < dims).all(1)]
        m = np.zeros(dims[::-1], bool); m[g[:, 2], g[:, 1], g[:, 0]] = True
        return m
    # everything else stays: with only C1-C3 held, the front of the neck and the chest lay nearer
    # the mandible than any still bone and opened with the mouth (the skin tore at the shoulders);
    # the airway and the thyroid hold the front of the neck
    still = mask(S[~mand])
    for k in [k for k in NECK_W if k != 'skull'] + NECK_STILL + ['trachea', 'thyroid_gland', 'esophagus']:
        P = ML.label_points(k, bone, sp)
        if P is not None and len(P):
            still |= mask(P)
    dm = ndi.distance_transform_edt(~mask(S[mand]), sampling=FIELD_SP)
    # and the airway: the labels stop at the trachea, and the larynx and pharynx above it took a
    # share of the turn and closed (the air inside the neck, slice by slice, below the bite and
    # clear of the mouth inside the mandible's arch; its HU made most of it 'lung')
    body = np.zeros(vol.shape, bool)
    for k in range(vol.shape[0]):
        body[k] = ndi.binary_fill_holes(vol[k] != 0)
    A = np.argwhere(body & np.isin(vol, [0, 1]))[:, ::-1]
    A = (A - (np.array([nx, ny, nz]) - 1) / 2) * sp
    A = A[A[:, 2] < JAW['bite'] - 1.0]
    air = mask(A) & (dm > JAW_AIRWAY)
    still |= air
    e1 = np.exp(-dm / FIELD_LAMBDA)
    e0 = np.exp(-ndi.distance_transform_edt(~still, sampling=FIELD_SP) / FIELD_LAMBDA)
    W = ndi.gaussian_filter(e1 / np.maximum(e1 + e0, 1e-300), JAW_SIGMA / FIELD_SP)
    # the airway takes none of it, nor the centimetre round it (a share there sheared tissue into
    # the lumen and the larynx closed on the film)
    W *= np.clip(ndi.distance_transform_edt(~air, sampling=FIELD_SP) / 1.0, 0, 1)
    # and nothing past the jaw's own soft tissue moves: the share fades out 2.5-4 cm from the bone
    W *= np.clip((JAW_REACH[1] - ndi.gaussian_filter(dm, 1)) / (JAW_REACH[1] - JAW_REACH[0]), 0, 1)
    W = np.where(W < 0.02, 0, np.where(W > 0.98, 1, W))
    (ROOT / 'apps' / 'web' / 'public' / 'models' / name / f'{name}.jaww.bin').write_bytes(np.round(W * 255).astype(np.uint8).tobytes())
    M = S[mand]
    # the hinge: the tops of the two condyles (the highest mandible each side), half a centimetre down
    cond = [M[np.sign(M[:, 0]) == sg] for sg in (1, -1)]
    cond = [c[c[:, 2] > c[:, 2].max() - 0.4].mean(0) for c in cond]
    c = (cond[0] + cond[1]) / 2 - np.array([0, 0, 0.5])
    menton = M[np.argmin(M[:, 2] - 0.3 * M[:, 1])]
    d = (menton - c) / np.linalg.norm(menton - c)
    print(f'  jaw: {int(mand.sum())} label points of mandible; condyles {np.round(cond, 2).tolist()}; menton {np.round(menton, 2).tolist()}')
    return c, d, {'file': f'{name}.jaww.bin', 'dims': dims.tolist(), 'sp': FIELD_SP, 'origin': o.round(4).tolist()}


# THE PATELLA rides the knee: the patellar tendon draws it down the trochlear groove as the knee
# flexes, turning it some 0.7 of the knee's angle, until in deep flexion its apex lies at the
# intercondylar notch. How far it turns is set by the patellar tendon, which does not stretch: as far
# as keeps its apex the tendon's rest length from the tibial tuberosity (the share is the fallback
# where there is no tuberosity to measure). On the model it is its own piece of bone (the patellofemoral joint space
# parts it from the femur), turned about the centre of the femoral condyle it glides round: a
# circle fitted to the femur's whole outline below the patella, in the patella's own sagittal
# plane. (A sphere fitted to the groove alone put the centre 1.7 cm behind the patella, a saddle's
# centre, and it turned in place; a circle fitted to the front and lower quarter only sat near the
# front of the joint line, and the patella swung off the femur; the knee's own centre is on the
# joint line, and turned about that the patella swung out in front of the tibia.)
# Its weight grid (core/jointPose.js, a joint's rider) is whole inside the patella and fades out
# over RIDE_FADE cm round it, so a palpation mark on the skin over it goes with it too.
PATELLA_SHARE, RIDE_SLAB, RIDE_FADE = 0.7, 0.6, 1.2


def patella_rider(knee_c, name='lowerextremity'):
    V = Vol(name)
    pp = PALP[name]['patella']
    p = np.array([pp['x'], pp['y'], pp['z']])
    # a box round the palpated patella reaching back past the femoral condyles (they lie behind it;
    # a box 6 cm round it cut them in half, and the circle fitted to half a condyle sat on the joint
    # line), at the volume's own spacing
    lo, hi = p - np.array([6, 12, 9]), p + np.array([6, 4, 6])
    i0 = [max(0, V.idx(a, lo[a])) for a in range(3)]
    i1 = [min(V.n[a], V.idx(a, hi[a]) + 1) for a in range(3)]
    sub = V.v[i0[2]:i1[2], i0[1]:i1[1], i0[0]:i1[0]]
    bone = np.isin(sub, [17, 18] + list(range(54, 62)))           # bone alone: no joint cartilage
    lab, n = ndi.label(bone)
    if not n:
        return None
    sp = V.sp
    org = np.array([(i0[a] - (V.n[a] - 1) / 2) * sp[a] for a in range(3)])
    cvox = float(np.prod(sp))
    best, bd = None, 1e9
    for k in range(1, n + 1):
        m = lab == k
        vol = m.sum() * cvox
        if not 5 < vol < 60:                                         # cm3: a patella, not the femur
            continue
        kk, jj, ii = np.nonzero(m)
        pts = np.c_[ii, jj, kk] * sp + org
        d = np.linalg.norm(pts - p, axis=1).min()
        if d < bd:
            best, bd = k, d
    if best is None or bd > 3:
        return None
    pat = lab == best
    # the femur: the piece that runs out of the box's top; its outline in the patella's slab
    top = lab[-1][lab[-1] > 0]
    fem = lab == np.bincount(top).argmax()
    kp, jp, ipx = np.nonzero(pat)
    pc = np.array([ipx.mean(), jp.mean(), kp.mean()]) * sp + org         # the patella's centre
    ix, w = int(round(ipx.mean())), int(round(RIDE_SLAB / sp[0]))
    prof = ndi.binary_fill_holes(fem[:, :, max(0, ix - w):ix + w + 1].any(2))   # (z, y); its outline only
    # (the femur's piece can run on into the tibia where the joint space did not close the gap: the
    # profile is cut at the joint line, its thinnest row within 2 cm of the knee's centre)
    zr = np.arange(prof.shape[0]) * sp[2] + org[2]
    band = np.nonzero(np.abs(zr - knee_c[2]) < 2)[0]
    gap = band[np.argmin(prof[band].sum(1))]
    prof[:gap + 1] = False
    kk, jj = np.nonzero(prof & ~ndi.binary_erosion(prof))
    Y, Z = jj * sp[1] + org[1], kk * sp[2] + org[2]
    q = Z < pc[2] + 1                                                    # the condyle: below it, all round
    A = np.c_[2 * Y[q], 2 * Z[q], np.ones(q.sum())]
    sol = np.linalg.lstsq(A, Y[q] ** 2 + Z[q] ** 2, rcond=None)[0]
    centre = np.array([pc[0], sol[0], sol[1]])
    # the grid: the patella's box and its fade
    g0 = [max(0, int(np.nonzero(pat.any(axis=tuple(b for b in range(3) if b != ax)))[0].min()) - int(np.ceil(RIDE_FADE / sp[2 - ax])) - 1) for ax in range(3)]
    g1 = [min(pat.shape[ax], int(np.nonzero(pat.any(axis=tuple(b for b in range(3) if b != ax)))[0].max()) + int(np.ceil(RIDE_FADE / sp[2 - ax])) + 2) for ax in range(3)]
    box = pat[g0[0]:g1[0], g0[1]:g1[1], g0[2]:g1[2]]
    W = np.clip(1 - ndi.distance_transform_edt(~box, sampling=sp[::-1]) / RIDE_FADE, 0, 1)
    W[box] = 1
    (ROOT / 'apps' / 'web' / 'public' / 'models' / name / f'{name}.patella.bin').write_bytes(np.round(W * 255).astype(np.uint8).tobytes())
    origin = org + np.array([g0[2], g0[1], g0[0]]) * sp
    # the patellar tendon: from the patella's apex (its distal pole: the mean of its lowest 3 mm)
    # to the tibial tuberosity; it does not stretch, so the patella turns as far as keeps its length
    pts = np.c_[ipx, jp, kp] * sp + org
    apex = pts[pts[:, 2] < pts[:, 2].min() + 0.3].mean(0)
    tt = PALP[name].get('tibialTuberosity')
    tend = {}
    if tt:
        tub = np.array([tt['x'], tt['y'], tt['z']])
        tend = {'apex': apex.round(2).tolist(), 'tub': tub.round(2).tolist(), 'len': round(float(np.linalg.norm(apex - tub)), 2)}
    print(f'  patella: {int(pat.sum() * cvox)} cm3, {bd:.1f} cm from the palpated point; it turns about '
          f'{np.round(centre, 2).tolist()}; its tendon {tend.get("len")} cm')
    return {'file': f'{name}.patella.bin', 'dims': [int(box.shape[2]), int(box.shape[1]), int(box.shape[0])],
            'sp': round(float(sp[0]), 4), 'origin': origin.round(4).tolist(), 'c': centre.round(2).tolist(),
            'share': PATELLA_SHARE, **tend}


def main():
    out = {'_about': __doc__.strip().splitlines()[0]}
    # ---- the hand: the wrist
    rs, m3 = PALP['hand']['radialStyloid'], CENT['hand']['mcp3Joint']
    radial = 1 if rs['x'] > m3['x'] else -1
    wrist_z = lm('hand', 'wrist')[2]
    c = [m3['x'], CENT['hand']['midcarpal']['y'], round(wrist_z - 2.2 + 1.2, 2)]
    # the hand as scanned is not straight on its forearm: the deviation it already has is the angle
    # from the distal radius's axis to the 3rd metacarpal's, toward the ulna (measured: 26 degrees)
    h = CENT['hand']
    a_mc = np.degrees(np.arctan2(radial * (h['mcp3Joint']['x'] - h['mc3Base']['x']), h['mcp3Joint']['z'] - h['mc3Base']['z']))
    a_ra = np.degrees(np.arctan2(radial * (h['radiusDistal']['x'] - h['radiusProx']['x']), h['radiusDistal']['z'] - h['radiusProx']['z']))
    rest_dev = round(float(a_ra - a_mc), 1)
    out['hand'] = {'wrist': {
        'label': 'Wrist', 'c': c, 'distal': [0, 0, 1], 'blend': 1.0,
        'how': 'the head of the capitate: 1.2 cm distal of the radiocarpal joint, on the line of the 3rd metacarpal',
        'motions': [
            {'key': 'wrist.dev', 'label': 'Deviation', 'neg': 'radial', 'pos': 'ulnar', 'toward': [-radial, 0, 0], 'range': [-20, 35],
             'rest': rest_dev},
            {'key': 'wrist.flex', 'label': 'Flexion', 'neg': 'extension', 'pos': 'flexion', 'toward': [0, -1, 0], 'range': [-70, 75]},
        ]}}
    # ---- the arm: elbow, and the wrist's deviation (forearm positioning)
    V = Vol('upperextremity').main_bone()
    el, wr = lm('upperextremity', 'elbow'), lm('upperextremity', 'wrist')
    pa = PALP['upperextremity']
    me, le = (np.array([pa[k]['x'], pa[k]['y'], pa[k]['z']]) for k in ('medialEpicondyle', 'lateralEpicondyle'))
    mid = (me + le) / 2
    ec = np.array([mid[0], mid[1], el[2] - 1.5])                 # the trochlea / capitulum axis
    fore = np.array(wr) - ec                                      # the forearm's axis, elbow to wrist
    fore = (fore / np.linalg.norm(fore)).round(3).tolist()
    # flexion carries the forearm forward: away from the olecranon, whichever way this arm is turned
    ant = (-np.array(pa['olecranon']['dir'])).round(3).tolist()
    # No limb cylinder ('radius') on any joint: the old arm lay against the flank and the old leg
    # touched the other one, so a joint could move only what lay near its own axis; the rebuilt
    # models (build_limbs.py) carry one limb alone, and a broad hand outside the 6 cm cylinder
    # stayed behind while its neighbours moved: the skin stretched into a rod.
    # pronation and supination: about the forearm, anterior toward lateral is supination (the radius
    # comes round to lie beside the ulna); its rest is where the radius lies now, 3 cm above the wrist
    fa = np.array(fore)
    lat = perp(le - me, fa)
    antp = perp(ant, fa)
    rad = radial_dir(V, wr[2] + 3.0)
    sup = round(angle_about(lat, perp(rad, fa), np.cross(antp, lat) / np.linalg.norm(np.cross(antp, lat))), 1) if rad is not None else 0.0
    # the forearm is fully turned 4 cm above the wrist, where the radius is found (3 cm above it)
    spread = round(float(np.linalg.norm(np.array(wr) - ec)) - 4.0, 1)
    roll = lambda key, label, rng, rest=None: dict({'key': key, 'label': label, 'neg': 'pronation', 'pos': 'supination', 'roll': True,
                                                 'from': antp.round(3).tolist(), 'toward': lat.round(3).tolist(), 'range': rng},
                                                **({'rest': rest} if rest else {}))
    arm = {'elbow': {
        'label': 'Elbow', 'c': [round(float(c), 2) for c in ec],
        'distal': fore, 'blend': 1.5, 'spread': spread,
        'how': f'the trochlea/capitulum axis: 1.5 cm distal of the midpoint of the measured epicondyles; flexion away from the olecranon; the forearm pronates over its {spread} cm',
        'motions': [{'key': 'elbow.flex', 'label': 'Flexion', 'neg': 'extension', 'pos': 'flexion', 'toward': ant, 'range': [0, 140]},
                    roll('elbow.roll', 'Forearm rotation', [-180, 10], sup)]}}
    if rad is not None:
        arm['wrist'] = {
            'label': 'Wrist', 'c': [round(float(wr[0]), 2), round(float(wr[1]), 2), round(float(wr[2] + 0.5), 2)],
            'distal': [0, 0, -1], 'blend': 1.0,
            'how': 'the carpus, 0.5 cm proximal of the carpal landmark; ulnar deviation toward the ulna, measured from the radius 3 cm above',
            'motions': [{'key': 'wrist.dev', 'label': 'Deviation', 'neg': 'radial', 'pos': 'ulnar', 'toward': (-rad).round(3).tolist(), 'range': [-20, 35]},
                        roll('wrist.roll', 'Hand roll', [-30, 30])]}
    out['upperextremity'] = arm
    # ---- the leg: knee and ankle
    kn = lm('lowerextremity', 'knee')
    im = CENT['lowerextremity']['intermalleolar']
    leg = np.array(v3(im)) - np.array(kn)                        # the leg's axis, knee to ankle
    leg = (leg / np.linalg.norm(leg)).round(3).tolist()
    # the foot's axis: the ankle to the base of the 3rd metatarsal (measure_centring); the angle it
    # makes with the leg says how far the foot rests from neutral (90 degrees to the leg). This foot
    # lies post mortem almost in line with the leg: about 73 degrees of plantarflexion. The ankle's
    # angle is anatomical, 0 at neutral, so an ankle view (Bontrager: foot dorsiflexed to 90
    # degrees) asks for dorsiflexion and a foot view can leave it plantarflexed.
    toes = foot_axis(np.array(v3(im)), np.array(leg))
    rest = -round(float(90 - np.degrees(np.arccos(np.clip(toes @ np.array(leg), -1, 1)))), 1)
    # and how far the foot is turned about the leg: internal (toward the midline, -x) positive
    lg = np.array(leg)
    antl, medl = perp([0, 1, 0], lg), perp([-1, 0, 0], lg)
    turn = round(angle_about(antl, perp(toes, lg), np.cross(antl, medl) / np.linalg.norm(np.cross(antl, medl))), 1)
    inv = round(foot_inversion(np.array(v3(im)), lg, toes), 1)
    up, latf = perp([0, 0, 1], toes), perp([1, 0, 0], toes)
    toes = toes.round(3).tolist()
    rider = patella_rider(kn)
    out['lowerextremity'] = {
        'knee': {'label': 'Knee', 'c': [round(float(kn[0]), 2), round(float(kn[1]), 2), round(float(kn[2]), 2)],
                 'distal': leg, 'blend': 2.0,
                 'how': 'the measured joint space between the femoral condyles and the tibial plateau; the patella rides it',
                 'motions': [{'key': 'knee.flex', 'label': 'Flexion', 'neg': 'extension', 'pos': 'flexion', 'toward': [0, -1, 0], 'range': [0, 120]},
                             # internal rotation turns the front of the leg toward the midline (-x: a right leg)
                             {'key': 'knee.roll', 'label': 'Rotation', 'neg': 'external', 'pos': 'internal', 'roll': True,
                              'from': [0, 1, 0], 'toward': [-1, 0, 0], 'range': [-40, 40]}],
                 **({'rider': rider} if rider else {})},
        # the foot is the part past a plane through the ankle tilted toward it (down the leg, and 0.4
        # of the way along the foot): a plane square to the leg did for a foot hanging down it, but a
        # foot at 90 degrees reaches forward at the ankle's own height, half of it inside the crease,
        # and a bend fanned it out by height
        'ankle': {'label': 'Ankle', 'c': v3(im), 'distal': perp_none(lg + 0.4 * np.array(toes)), 'blend': 1.5,
                  'how': f'midway between the malleoli; dorsiflexion turns the foot (its long axis, {toes}) toward the shin; at rest it is {-rest:.0f} degrees plantarflexed, turned {turn:.0f} degrees (internal +) and inverted {inv:.0f} degrees',
                  'motions': [{'key': 'ankle.flex', 'label': 'Dorsiflexion', 'neg': 'plantarflexion', 'pos': 'dorsiflexion',
                               'from': toes, 'toward': [0, 0, 1], 'range': [-80, 20], 'rest': rest},
                              dict({'key': 'ankle.roll', 'label': 'Rotation', 'neg': 'external', 'pos': 'internal', 'roll': True,
                                    'from': [0, 1, 0], 'toward': [-1, 0, 0], 'range': [-40, 40]}, **({'rest': turn} if abs(turn) > 0.5 else {})),
                              # about the foot's own axis: inversion turns the dorsum toward the lateral
                              dict({'key': 'ankle.invert', 'label': 'Inversion', 'neg': 'eversion', 'pos': 'inversion',
                                    'from': up.round(3).tolist(), 'toward': latf.round(3).tolist(), 'range': [-20, 35]},
                                   **({'rest': inv} if abs(inv) > 0.5 else {}))]},
    }
    # ---- the head and neck: one field joint
    field = neck_field()
    if field:
        hc = CENT['headneck']
        c4, top, bot = (np.array(v3(hc[k])) for k in ('C4', 'C1C2', 'C7T1'))
        ax = (top - bot) / np.linalg.norm(top - bot)
        c = c4 + np.array([0, -1.0, 0])                          # behind the body: the facets
        out['headneck'] = {'neck': {
            'label': 'Neck', 'c': c.round(2).tolist(), 'distal': ax.round(3).tolist(), 'blend': 0, 'field': field,
            'how': 'the cervical spine, a field joint: the head turns whole, C1 to C6 by their share, C7 and below stay; about C4, 1 cm behind its body',
            'motions': [{'key': 'neck.flex', 'label': 'Flexion', 'neg': 'extension', 'pos': 'flexion', 'toward': [0, 1, 0], 'range': [-60, 50]},
                        {'key': 'neck.tilt', 'label': 'Lateral flexion', 'neg': 'left lateral flexion', 'pos': 'right lateral flexion', 'toward': [1, 0, 0], 'range': [-40, 40]},
                        {'key': 'neck.rot', 'label': 'Rotation', 'neg': 'left rotation', 'pos': 'right rotation', 'roll': True,
                         'from': perp([0, 1, 0], ax).round(3).tolist(), 'toward': perp([1, 0, 0], ax).round(3).tolist(), 'range': [-70, 70]}]}}
        jaw = jaw_field()
        if jaw:
            jc, jd, jf = jaw
            out['headneck']['jaw'] = {
                'label': 'Jaw', 'c': jc.round(2).tolist(), 'distal': jd.round(3).tolist(), 'blend': 0, 'field': jf,
                'how': 'the mandible, a field joint hinged through its condyles that glide forward as it opens: the mouth opens for the C1-C2 view',
                'motions': [{'key': 'jaw.open', 'label': 'Mandible', 'neg': 'elevation', 'pos': 'depression', 'toward': [0, -1, 0], 'range': [0, 35],
                             'glide': JAW_GLIDE}]}
    else:
        print('  no head CT labels (or nibabel): the neck keeps its old joints.json entry')
        old = json.loads(OUT.read_text(encoding='utf-8')) if OUT.exists() else {}
        if 'headneck' in old:
            out['headneck'] = old['headneck']
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    for s, js in out.items():
        if s.startswith('_'): continue
        for k, j in js.items():
            print(f'{s:16s} {k:6s} c {j["c"]}  motions {[m["key"] for m in j["motions"]]}')
    print('wrote', OUT)


if __name__ == '__main__':
    main()
