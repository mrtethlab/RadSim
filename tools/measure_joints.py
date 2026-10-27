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

THE SHOULDER is a FIELD joint too (shoulder_field): the arm model carries the shoulder girdle and
a slab of the chest wall beside the arm, and no plane through the shoulder parts the humerus from
them (the scapula's body hangs below the glenoid, the flank lies against the arm). The humerus and
every bone below it take the whole turn, the scapula, clavicle and ribs none, the soft tissue the
blend of the bones nearest it. Its centre is the humeral head's, a sphere fitted to the head where
it faces the glenoid; its motions are rotation about the humerus's own axis (internal +) and
abduction, in that order (the humerus turned about its axis, then raised).

    python tools/measure_joints.py shoulder  # the shoulder alone, put first in the arm's chain

THE DIGITS of the hand curl, one slider a digit (hand_digits): each digit's three joints are field
joints whose shares are read at the rest point, from one weight grid a digit beside the model
(hand.digit1.bin ... hand.digit5.bin). Their bones are found as pieces of the volume (the joint
spaces are cut), their centres and axes measured on them, the thumb's CMC turn and the fingers' MCP
turns solved so that a full curl is a fist.

    python tools/measure_joints.py hand      # the hand alone; every other model's entry as it is
"""
import json, pathlib, sys
import numpy as np
from scipy import ndimage as ndi
from scipy.spatial import cKDTree

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
    axis of the bone 50-72 % of the way along the foot, measured from the lateral about the foot's
    axis. z053's right foot lay inverted some 60 degrees under the crossed left leg, and its
    lateral film showed the five metatarsals fanned out as on a dorsoplantar."""
    V = Vol('lowerextremity')
    P = np.stack(V.coords(V.bone), 1)
    f = P[(P - ank) @ leg > 1.0]
    t = (f - ank) @ fa
    # the metatarsal shafts: from the ankle's true centre (the tibiotalar joint, measure_landmarks)
    # 35 % reached back into the tarsals, whose arch is steepest, and read 14.6 degrees where the
    # shafts' own row, cut square across, tilts 6
    g = f[(t > 0.50 * t.max()) & (t < 0.72 * t.max())]
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


# THE SHOULDER (see the module's notes). Its grid reaches well past the model, so a forearm the
# elbow has swung forward is still read as the arm's (outside a field nothing turns).
SHOULDER_SP = 0.6                         # cm, the weight grid
SHOULDER_BOX = ((-22.0, 40.0), (-26.0, 40.0), (-36.0, 36.0))   # x, y, z (cm, rest frame)
SHOULDER_POW = 3                          # the inverse-distance blend's power


def shoulder_field(name='upperextremity'):
    """The shoulder joint for joints.json, its weight grid written beside the model."""
    V = Vol(name)
    # the bone itself, not the skeleton mask (which takes the cartilage in, and joins the humerus to
    # the glenoid across it)
    V.bone = np.isin(V.v, [17, 18] + list(range(54, 62)))
    lab, n = ndi.label(V.bone)
    sizes = ndi.sum(V.bone, lab, range(1, n + 1))
    order = np.argsort(sizes)[::-1] + 1
    cz = ndi.center_of_mass(V.bone, lab, list(order))
    zc = lambda i: (cz[i][0] - (V.n[2] - 1) / 2) * V.sp[2]          # a piece's mean height, cm
    hum = int(order[1])                                               # the humerus: the second piece
    hk = np.nonzero(lab == hum)
    hz_top = (hk[0].max() - (V.n[2] - 1) / 2) * V.sp[2]
    # the arm: the humerus and every piece whose middle is below the humerus's upper third (the
    # forearm, the hand, any loose carpal); the girdle and the chest wall: the rest
    arm_ids = {hum} | {int(order[i]) for i in range(n) if zc(i) < hz_top - 12.0 and sizes[order[i] - 1] >= 20}
    arm = np.isin(lab, list(arm_ids))
    trunk = V.bone & ~arm
    # the head: the humerus's surface within 1.5 cm of the girdle (where it faces the glenoid),
    # a sphere fitted to it
    H = np.stack(V.coords(lab == hum), 1)
    T = np.stack(V.coords(trunk), 1)
    from scipy.spatial import cKDTree
    near = cKDTree(T).query(H, distance_upper_bound=1.5)[0] < 1.5
    S = H[near & (H[:, 2] > hz_top - 6.0)]
    A = np.c_[2 * S, np.ones(len(S))]
    sol = np.linalg.lstsq(A, (S ** 2).sum(1), rcond=None)[0]
    c = sol[:3]; r = float(np.sqrt(sol[3] + c @ c))
    # the humerus's axis, from the head to the elbow
    el = np.array(v3(CENT[name]['elbowJoint']))
    d = el - c; d /= np.linalg.norm(d)
    # the grid
    o = np.array([b[0] for b in SHOULDER_BOX])
    dims = np.array([int(round((b[1] - b[0]) / SHOULDER_SP)) + 1 for b in SHOULDER_BOX])
    def mask_on_grid(P):
        g = np.round((P - o) / SHOULDER_SP).astype(int)
        g = g[(g >= 0).all(1) & (g < dims).all(1)]
        m = np.zeros(dims[::-1], bool); m[g[:, 2], g[:, 1], g[:, 0]] = True
        return m
    A_ = mask_on_grid(np.stack(V.coords(arm), 1))
    T_ = mask_on_grid(T)
    da = ndi.distance_transform_edt(~A_, sampling=SHOULDER_SP) + 1e-3
    dt = ndi.distance_transform_edt(~T_, sampling=SHOULDER_SP) + 1e-3
    W = dt ** SHOULDER_POW / (dt ** SHOULDER_POW + da ** SHOULDER_POW)
    W = ndi.gaussian_filter(W, 0.8 / SHOULDER_SP)
    W = np.where(W < 0.02, 0, np.where(W > 0.98, 1, W))
    q = np.round(W * 255).astype(np.uint8)
    (ROOT / 'apps' / 'web' / 'public' / 'models' / name / f'{name}.shoulderw.bin').write_bytes(q.tobytes())
    ant = perp([0, 1, 0], d); med = perp([-1, 0, 0], d); lat = perp([1, 0, 0], d)
    print(f'shoulder: head centre {c.round(2)}, radius {r:.2f} cm from {len(S)} surface voxels; '
          f'arm pieces {len(arm_ids)}; grid {dims.tolist()}')
    return {'label': 'Shoulder', 'c': [round(float(x), 2) for x in c], 'distal': d.round(3).tolist(), 'blend': 0,
            'field': {'file': f'{name}.shoulderw.bin', 'dims': dims.tolist(), 'sp': SHOULDER_SP, 'origin': o.round(4).tolist()},
            'how': f'the glenohumeral joint, a field joint: the centre of the humeral head (a {r:.1f} cm sphere fitted where it '
                   'faces the glenoid); the humerus and the arm below it turn, the scapula, clavicle and chest wall stay',
            'motions': [
                {'key': 'shoulder.rot', 'label': 'Rotation', 'neg': 'external', 'pos': 'internal', 'roll': True,
                 'from': ant.round(3).tolist(), 'toward': med.round(3).tolist(), 'range': [-60, 90]},
                {'key': 'shoulder.abd', 'label': 'Abduction', 'neg': 'adduction', 'pos': 'abduction',
                 'toward': lat.round(3).tolist(), 'range': [0, 120]},
            ]}


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


# THE DIGITS curl, each on its own slider (thumb 1 ... little finger 5): 0 % the hand as scanned,
# 100 % a fist. A finger's MCP, PIP and DIP bend together, each by its own share of the slider's
# fraction f: its degrees at full curl times f to a power, so the PIP leads a little (a fist closes
# from the PIP, the DIP following it by the oblique retinacular ligament) and the MCP comes last.
# Full curl is a fist's: MCP 90, PIP 105, DIP 75 (the thumb: MCP 55, IP 75, and its CMC solved below).
# The slider runs on to -20 %, EXTENSION, the curl's reverse in proportion: a hand pressed flat,
# hyperextended mostly at the MCP (passively 20-30 degrees), a little at the DIP, the PIP barely
# (its volar plate stops it near straight).
DIGIT_EXT = -20         # %, the slider's extended end
FINGER_CURL = [('MCP', 90, 1.15, 0.5, 20), ('PIP', 105, 0.85, 0.4, 5), ('DIP', 75, 1.1, 0.35, 10)]   # degrees, power, crease (cm), extension (degrees)
THUMB_CURL = [('CMC', None, 1.0, None, 10), ('MCP', 55, 1.0, 0.45, 10), ('IP', 75, 1.1, 0.35, 15)]


def curl_angle(deg, power, ext, f):
    """a digit joint's angle at the slider's fraction f (1 a full curl; DIGIT_EXT / 100 full extension), as jointPose's motionAngle"""
    return deg * f ** power if f >= 0 else -ext * min(1.0, f / (DIGIT_EXT / 100))
DIGIT_NAMES = ['Thumb', 'Index finger', 'Middle finger', 'Ring finger', 'Little finger']
DIGIT_SP = 0.1          # cm, the digits' weight grids
DIGIT_GAP = 0.35        # cm: bone this close to the next piece is its joint surface
BONE_RAMP = 0.6         # cm: soft tissue next to a bone turns with it (periosteum, capsule, its half of the
                        # joint), handing over to the crease across this much of it. (Held whole within 0.2 cm
                        # and let go at once, the skin over the knuckles, thin there, tore into fins.)
BONE_SHARP = 0.08       # cm: across a joint space, how sharply soft tissue goes from one bone's share to the other's
DIGIT_SKIN = 0.4        # cm: how far past the tissue the grids reach (the room's skin mesh lies on its surface)
THUMB_LAMBDA = 0.6      # cm: how far a bone's claim on the thenar eminence and the first web reaches
THUMB_FRONT = 1.4       # cm: the thumb's bone in front of the curled middle phalanges' bone, in a fist (two pads between)


def smoothstep(s, b):
    t = np.clip((s + b) / (2 * b), 0, 1)
    return t * t * (3 - 2 * t)


def unit(a):
    a = np.asarray(a, float)
    return a / np.linalg.norm(a)


def turn(p, c, n, ang):
    """points p turned about the line through c along n by ang (radians: one, or one a point)"""
    from scipy.spatial.transform import Rotation
    ang = np.broadcast_to(np.asarray(ang, float), (len(p),))
    return Rotation.from_rotvec(ang[:, None] * n[None, :]).apply(p - c) + c


def digit_pieces(V, radial):
    """The hand's bones in pieces, from the volume. The joint spaces are cut (services/compute/app/
    joint_space.py), so each phalanx is a piece of cortical bone of its own; the metacarpals stay
    joined to the carpus (their CMC joints are not cut), and with them the thumb's, which is cut
    free here at its CMC. A digit is a chain of pieces touching across their joint spaces, from the
    metacarpals out; the thumb's has two phalanges and lies furthest radially. Each piece is filled
    (its marrow, fat inside the cortex, goes with it). Returns the piece of every voxel (0 none, 1 the
    still skeleton, 2 + 4 k + j the j-th moving piece of digit k: the thumb's M1, P1, P2, a finger's
    P1, P2, P3) and each digit's pieces as points."""
    bone = V.v == 18
    lab, n = ndi.label(bone)
    sz = ndi.sum(bone, lab, range(1, n + 1))
    big = int(np.argmax(sz)) + 1
    comps = [int(k) + 1 for k in np.argsort(sz)[::-1] if sz[k] > 1000 and k + 1 != big]
    pts = lambda m: np.stack(V.coords(m), 1)
    P = {c: pts(lab == c) for c in comps}
    T = {c: cKDTree(P[c]) for c in comps}
    B = pts(lab == big)
    tb = cKDTree(B)
    touch = lambda A, t: bool((t.query(A[::3], distance_upper_bound=DIGIT_GAP)[0] < DIGIT_GAP).any())
    chains, used = [], set()
    for c in comps:
        if c in used or not touch(P[c], tb):
            continue
        ch = [c]; used.add(c)
        while True:
            nxt = [o for o in comps if o not in used and touch(P[o], T[ch[-1]])]
            if not nxt:
                break
            ch.append(nxt[0]); used.add(nxt[0])
        chains.append(ch)
    thumb = [ch for ch in chains if len(ch) == 2]
    fingers = sorted([ch for ch in chains if len(ch) == 3], key=lambda ch: -radial * P[ch[0]].mean(0)[0])
    assert len(thumb) == 1 and len(fingers) == 4, f'the digits: {chains}'
    return lab, big, B, P, [thumb[0]] + fingers


def digit_joint(A, B, palmar):
    """A joint between a proximal piece A and a distal piece B (points, cm): its centre, the distal
    direction (B's long axis) and its palmar direction (B's thin axis: a phalanx is flattened
    dorsopalmarly), square to it. The centre of rotation is the centre of the proximal bone's head:
    half the head's depth back from the joint space, midway between its dorsal and palmar surfaces
    (a circle fitted to the joint space itself, a cut sheet nearly flat across its middle, put the
    centre anywhere from inside the space to 2 cm away)."""
    tA, tB = cKDTree(A), cKDTree(B)
    ga = A[tB.query(A, distance_upper_bound=DIGIT_GAP)[0] < DIGIT_GAP]
    gb = B[tA.query(B, distance_upper_bound=DIGIT_GAP)[0] < DIGIT_GAP]
    g = (ga.mean(0) + gb.mean(0)) / 2
    m = B.mean(0)
    w, vec = np.linalg.eigh(np.cov((B - m).T))
    d = vec[:, 2] if vec[:, 2] @ (m - g) > 0 else -vec[:, 2]
    pal = vec[:, 0] - (vec[:, 0] @ d) * d
    pal = unit(pal if pal @ palmar > 0 else -pal)
    side = np.cross(d, pal)
    r = A - g
    u, v, e = r @ d, r @ pal, r @ side
    head = (u > -0.9) & (u < -0.1) & (np.abs(e) < 0.4)
    v0, v1 = np.percentile(v[head], [2, 98])
    c = g - (v1 - v0) / 2 * d + (v0 + v1) / 2 * pal
    return {'c': c, 'g': g, 'd': d, 'pal': pal, 'n': unit(side), 'depth': v1 - v0}


def thumb_metacarpal(V, lab, big, g, d0):
    """The thumb's metacarpal, cut from the carpus at its CMC. Its axis: a line through the centres
    of its shaft's cross-sections, from the MCP's joint space toward the carpus; the CMC: where the
    cartilage of the trapeziometacarpal joint space starts along it (the cut sheet covers only part
    of the saddle, which is why the bones stayed joined). The metacarpal is the bone short of that,
    within its shaft's reach of the axis, and the piece of it joined to the head."""
    X = np.stack(V.coords(lab == big), 1)
    for _ in range(3):
        r = X - g; s = r @ d0; rad = np.linalg.norm(r - np.outer(s, d0), axis=1)
        cs = np.array([X[(s >= t) & (s < t + 0.2) & (rad < 0.9)].mean(0) for t in np.arange(0.5, 3.0, 0.2)])
        m = cs.mean(0); w, vec = np.linalg.eigh(np.cov((cs - m).T))
        d0 = vec[:, 2] if vec[:, 2] @ d0 > 0 else -vec[:, 2]
        g = g + ((m - g) - ((m - g) @ d0) * d0)                         # the axis through the centres
    C = np.stack(V.coords(V.v == 16), 1)
    rc = C - g; sc = rc @ d0; radc = np.linalg.norm(rc - np.outer(sc, d0), axis=1)
    cut = next(t for t in np.arange(2.5, 6.0, 0.1) if ((sc >= t) & (sc < t + 0.1) & (radc < 1.2)).sum() > 40)
    r = X - g; s = r @ d0; rad = np.linalg.norm(r - np.outer(s, d0), axis=1)
    keep = (s > -0.8) & (s < cut + 0.05) & (rad < np.where(s > 3.0, 1.0, 1.3))
    m = np.zeros(V.v.shape, bool)
    i, j, k = (np.round(X[keep] / V.sp + (V.n - 1) / 2).astype(int)).T
    m[k, j, i] = True
    pl, pn = ndi.label(m)
    sizes = ndi.sum(m, pl, range(1, pn + 1))
    m1 = pl == int(np.argmax(sizes)) + 1
    base = X[keep & (s > cut - 0.4)].mean(0)
    return m1, base + 0.3 * d0, -d0, cut


def digit_forward(p, W, joints, angles):
    """a digit's points posed (rest-frame weights W[j] a point, per joint), the distal joint first"""
    q = p
    for j in range(len(joints) - 1, -1, -1):
        q = turn(q, joints[j]['c'], joints[j]['n'], W[j] * np.radians(angles[j]))
    return q


def hand_digits(radial, wrist_c):
    """The digits' joints for joints.json, and their weight grids beside the hand model.

    Each digit joint is a field joint (core/jointPose.js) whose share is read at the point's REST
    position: the digit's three joints are a chain, and a point of the fingertip is turned by the
    DIP, then the PIP, then the MCP, by its own weights for each. (Read where the joints below had
    already carried it, a curled fingertip lies in air beneath the finger, which no grid of the hand
    can say belongs to it.) The shares, for each joint:
    - its bone: whole on the pieces distal to it, none on any other (the bones stay rigid: the
      resampler snaps a bone's share at a half, jointPose digitLeaves), and the soft tissue next to
      a bone goes with it, handing over to the crease across BONE_RAMP;
    - the rest of the digit's soft tissue: a crease across the joint, the smoothstep of the distance
      past it along the distal bone (as the limbs' joints blend), within the digit's own territory.
      A territory is the tissue nearest the digit's ray (its joints' centres, out to the fingertip and
      back along the metacarpal): fingers that touch at rest part there, and do not drag each other;
    - the thumb's CMC: the thenar eminence and the first web between the thumb and the index are one
      sheet of tissue, which a hard edge would tear as the thumb swings across the palm, so it is
      shared as the neck's is, by distances to the thumb's bones (whole) and to the still ones.
    A digit's three joints share one grid (uint8, 255 = all three turned whole): 85 per joint, so
    joint j's share is 3 w - j, clamped (field.band). The shares are nested (a point the PIP turns,
    the MCP turns whole), and no point is two digits'."""
    V = Vol('hand')
    lab, big, B, P, digits = digit_pieces(V, radial)
    pts = lambda m: np.stack(V.coords(m), 1)
    # ---- the joints, measured on the pieces
    J, pieces = [], []
    tb = cKDTree(B)
    for k, ch in enumerate(digits):
        palmar = np.array([0, -1.0, 0]) if k else unit([-radial, -1, 0])   # the thumb's pad faces the palm
        near = B[np.linalg.norm(B - P[ch[0]].mean(0), axis=1) < 4]
        A = [near] + [P[c] for c in ch]
        J.append([digit_joint(A[j], A[j + 1], palmar) for j in range(len(ch))])
    # the thumb's metacarpal and its CMC
    m1, c_cmc, m1dir, cut = thumb_metacarpal(V, lab, big, J[0][0]['g'], -J[0][0]['d'])
    print(f'  thumb CMC: the metacarpal cut at {cut:.1f} cm from its MCP; centre {np.round(c_cmc, 2).tolist()}')
    # ---- the pieces, filled
    piece = np.zeros(V.v.shape, np.uint8)
    piece[ndi.binary_fill_holes(lab == big) & ~ndi.binary_fill_holes(m1)] = 1
    piece[ndi.binary_fill_holes(m1)] = 2
    for k, ch in enumerate(digits):
        for j, c in enumerate(ch):
            sl = ndi.find_objects((lab == c).astype(np.uint8))[0]
            piece[sl][ndi.binary_fill_holes(lab[sl] == c)] = 2 + 4 * k + (j + 1 if k == 0 else j)
    # the thumb's sesamoids (small pieces in the flexor tendons at its MCP) go with its proximal phalanx
    sz = ndi.sum(lab > 0, lab, range(1, lab.max() + 1))
    small = np.nonzero((sz > 20) & (sz <= 1000))[0] + 1
    cm = (np.array(ndi.center_of_mass(lab > 0, lab, small))[:, ::-1] - (V.n - 1) / 2) * V.sp
    ses = small[np.linalg.norm(cm - J[0][0]['c'], axis=1) < 1.5]
    piece[np.isin(lab, ses)] = 3
    print(f'  thumb: {len(ses)} sesamoids at its MCP')
    pieces = [[2 + 4 * k + j for j in range(3)] for k in range(5)]
    curls = [THUMB_CURL] + [FINGER_CURL] * 4
    # ---- the fingers' MCPs, solved so that in a fist the fingers lie side by side
    hand_ax = unit(J[2][0]['c'] - wrist_c)
    for k in range(1, 5):
        rv = solve_finger(V, piece, J[k], pieces[k], curls[k], hand_ax)
        J[k][0].update({'own': J[k][0]['n'], 'n': unit(rv), 'deg': round(float(np.degrees(np.linalg.norm(rv))), 1)})
    # ---- the thumb's CMC: solved, so that at full curl the thumb lies across the front of the fist
    J[0].insert(0, {'c': c_cmc, 'd': m1dir})
    rv = solve_thumb(V, piece, J, pieces, curls)
    J[0][0].update({'n': unit(rv), 'deg': round(float(np.degrees(np.linalg.norm(rv))), 1)})
    deg = [[J[k][j].get('deg', curls[k][j][1]) for j in range(3)] for k in range(5)]
    # ---- the weight grids, first over the whole hand at DIGIT_SP
    o = -(V.n - 1) / 2 * V.sp
    dims = (np.floor((V.n - 1) * V.sp / DIGIT_SP) + 1).astype(int)
    ax = [np.arange(dims[a]) * DIGIT_SP + o[a] for a in range(3)]
    vi = [np.clip(np.round((ax[a] - o[a]) / V.sp[a]).astype(int), 0, V.n[a] - 1) for a in range(3)]
    pc = piece[np.ix_(vi[2], vi[1], vi[0])]                           # (z, y, x): the piece at each cell
    tis = V.v[np.ix_(vi[2], vi[1], vi[0])] > 0
    bone = pc > 0
    edt = lambda m: ndi.distance_transform_edt(~m, sampling=DIGIT_SP)
    # how far into the soft tissue a bone's share holds before the crease's takes over
    ramp = smoothstep(edt(bone).ravel() - BONE_RAMP / 2, BONE_RAMP / 2)
    reach = (ndi.distance_transform_edt(~tis, sampling=DIGIT_SP) < DIGIT_SKIN).ravel()
    Zg, Yg, Xg = np.meshgrid(ax[2], ax[1], ax[0], indexing='ij')
    X = np.stack([Xg.ravel(), Yg.ravel(), Zg.ravel()], 1)
    del Zg, Yg, Xg
    # the territories: the nearest ray, each from back along its metacarpal through its joints' centres to its tip
    def seg(a, b):
        ab = b - a; t = np.clip(((X - a) @ ab) / (ab @ ab), 0, 1)
        return np.linalg.norm(X - a - t[:, None] * ab, axis=1)
    rays = []
    for k in range(5):
        cs = [jt['c'] for jt in J[k]]
        Q = np.stack(V.coords(piece == pieces[k][2]), 1)
        tip = Q[np.argmax((Q - cs[-1]) @ J[k][-1]['d'])]
        back = cs[0] - (1.0 * m1dir if k == 0 else 3.0 * unit(cs[0] - wrist_c))
        line = [back] + cs + [tip]
        rays.append(np.min([seg(line[i], line[i + 1]) for i in range(len(line) - 1)], 0))
    terr = np.argmin(rays, 0)
    del rays
    W = np.zeros((5, 3, len(X)), np.float32)
    for k in range(5):
        for j in range(3):
            moving = np.isin(pc, pieces[k][j:])
            # (against the bones it does not move: the still skeleton and the digit's own above the
            # joint; the thumb's CMC against every other bone. Another finger's are its territory's
            # business: counted here, the side of a finger touching its neighbour moved by half)
            d1, d0 = edt(moving), edt(bone & ~moving if k == 0 and j == 0 else (pc == 1) | np.isin(pc, pieces[k][:j]))
            # by the bones near it (the nearer one's share, the two blended over BONE_SHARP across a
            # joint space), handing over further out to the crease, within the digit's territory
            # (sharp at the bones, softer away from them: the skin over a knuckle, a few mm out, lies
            # across the line where the metacarpal head's share meets the proximal phalanx's, and
            # crumpled on it)
            near = 1 / (1 + np.exp(np.clip((d1 - d0) / np.maximum(BONE_SHARP, np.minimum(d1, d0)), -50, 50))).ravel()
            if k == 0 and j == 0:
                # the CMC's crease: the thenar eminence and the web, shared by the distances to the
                # thumb's bones (whole) and the still ones
                e1, e0 = np.exp(-d1 / THUMB_LAMBDA), np.exp(-d0 / THUMB_LAMBDA)
                w = ndi.gaussian_filter(e1 / np.maximum(e1 + e0, 1e-300), 0.3 / DIGIT_SP).ravel()
                cr = np.where(w < 0.02, 0, np.where(w > 0.98, 1, w))
                soft = near * (1 - ramp) + cr * ramp
            else:
                cr = smoothstep((X - J[k][j]['c']) @ J[k][j]['d'], curls[k][j][3])
                soft = (near * (1 - ramp) + cr * ramp) * (terr == k)
            W[k, j] = np.where(bone.ravel(), moving.ravel(), soft) * reach
    # the fingers have the tissue they move: the thumb's CMC share fades out short of it
    W[0] *= ~(W[1:, 0] > 0).any(0)
    for k in range(5):                                    # nested: what a joint turns, the joints above turn whole
        W[k, 1] = np.maximum(W[k, 1], W[k, 2]); W[k, 0] = np.maximum(W[k, 0], W[k, 1])
    # as the grid will hold them (85 steps a joint: the sigmoids' tails, 1e-20 across the hand, are 0)
    W = np.round(W * 85) / 85
    both = ((W[:, 0] > 0).sum(0) > 1).sum()
    assert both == 0, f'{both} cells in two digits'
    # ---- each digit's grid, cropped to where it moves anything; its joints for joints.json
    out = {}
    names = [['CMC', 'MCP', 'IP']] + [['MCP', 'PIP', 'DIP']] * 4
    for k in range(5):
        t = np.round(85 * W[k].sum(0)).astype(np.uint8).reshape(dims[::-1])
        nzk = np.argwhere(t > 0)
        lo = np.maximum(nzk.min(0) - 2, 0); hi = np.minimum(nzk.max(0) + 3, dims[::-1])
        sub = t[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]]
        fn = f'hand.digit{k + 1}.bin'
        (ROOT / 'apps' / 'web' / 'public' / 'models' / 'hand' / fn).write_bytes(sub.tobytes())
        field = {'file': fn, 'dims': [int(sub.shape[2]), int(sub.shape[1]), int(sub.shape[0])], 'sp': DIGIT_SP,
                 'origin': (o + lo[::-1] * DIGIT_SP).round(4).tolist()}
        # each joint's SLAB and REACH: where, along its axis and from its centre, the points it turns
        # can be once the joints beyond it have turned them (over the slider's range); a point
        # outside them is none of this joint's, and the volume's resampler is spared its search
        live = np.nonzero(W[k, 0] > 0)[0]
        live = live[::max(1, len(live) // 40000)]
        Wl = W[k][:, live]
        for j in range(3):
            jt = J[k][j]
            sel = Wl[j] > 0
            a, r = [], []
            for f in np.linspace(DIGIT_EXT / 100, 1, 13):
                ang = [curl_angle(deg[k][i], curls[k][i][2], curls[k][i][4], f) if i > j else 0 for i in range(3)]
                q = digit_forward(X[live][sel], Wl[:, sel], J[k], ang)
                a.append((q - jt['c']) @ jt['n']); r.append(np.linalg.norm(q - jt['c'], axis=1))
            a, r = np.concatenate(a), np.concatenate(r)
            # and its CREASE: how far from its centre its share is a part of the whole turn (only
            # there can a point have been turned by part of it, and the arc be searched for one)
            part = (W[k, j] > 0.02) & (W[k, j] < 0.98)
            crease = float(np.linalg.norm(X[part] - jt['c'], axis=1).max()) + 0.3 if part.any() else 0.0
            mo = {'key': f'digit.{k + 1}', 'label': 'Curl', 'neg': 'extension', 'pos': 'flexion', 'range': [DIGIT_EXT, 100],
                  'curl': [deg[k][j], curls[k][j][2], curls[k][j][4]]}
            if 'deg' in jt:
                # a solved turn about its own axis: from and toward, square to it, name it
                fr = unit(jt['d'] - (jt['d'] @ jt['n']) * jt['n'])
                mo.update({'from': fr.round(4).tolist(), 'toward': np.cross(jt['n'], fr).round(4).tolist()})
            else:
                mo['toward'] = jt['pal'].round(4).tolist()
            if k == 0 and j == 0:
                how = (f'the thumb\'s CMC: {jt["deg"]} degrees at full curl about an axis solved so the curled thumb lies across '
                       f'the middle phalanges of the curled index and middle fingers, as in a fist; its centre 0.3 cm into the trapezium '
                       f'from the base of the metacarpal; the thenar eminence and first web share it by distance from the thumb\'s bones')
            else:
                how = (f'the centre of the {"metacarpal" if j == 0 or (k == 0 and j == 1) else "phalangeal"} head: half its depth '
                       f'({jt["depth"]:.2f} cm) back from the joint space; flexion toward the palmar side of the distal bone')
                if 'own' in jt:
                    how += (f', {jt["deg"]} degrees at full curl about an axis tilted '
                            f'{np.degrees(np.arccos(np.clip(jt["n"] @ jt["own"], -1, 1))):.0f} degrees from square to the finger, '
                            f'solved so the curled finger lies under its knuckle, its middle phalanx along the hand (the spread of the scan closes as the collateral ligaments tighten in flexion)')
            how += f'; {curls[k][j][4]} degrees of hyperextension at {DIGIT_EXT} %'
            out[f'{names[k][j].lower()}{k + 1}'] = {
                'label': f'{DIGIT_NAMES[k]} {names[k][j]}', 'c': jt['c'].round(3).tolist(), 'distal': unit(jt['d']).round(4).tolist(),
                'blend': 0, 'digit': k + 1, 'field': {**field, 'band': j},
                'slab': [round(float(a.min()) - 0.2, 2), round(float(a.max()) + 0.2, 2)], 'reach': round(float(r.max()) + 0.2, 2),
                'crease': round(crease, 2),
                'how': how, 'motions': [mo]}
        print(f'  {DIGIT_NAMES[k]:13s} grid {field["dims"]} ({sub.size / 1e3:.0f} k cells); centres '
              + ', '.join(f'{names[k][j]} {np.round(J[k][j]["c"], 2).tolist()}' for j in range(3)))
    return out


def solve_finger(V, piece, J, pieces, curl, hand_ax):
    """A finger's MCP turn at full curl (a rotation vector, radians). Square to the finger, its
    MCP's own axis would curl the scanned hand's spread fingers into each other (the little finger,
    35 degrees out, crossed under the ring finger: their bones touched). In a fist the fingers lie
    side by side, each under its own knuckle, their middle phalanges along the hand: the one turn,
    90 degrees of flexion of the proximal phalanx, that with the PIP and DIP curled puts the middle
    phalanx's centre under the knuckle (across the hand) and its axis along the hand (seen PA)."""
    from scipy.optimize import minimize
    from scipy.spatial.transform import Rotation
    up = np.array([0, 1.0, 0])
    side = unit(np.cross(up, hand_ax))
    pts = [np.stack(V.coords(piece == c), 1)[::4] for c in pieces]
    def curled(rv):
        out = []
        for i, p in enumerate(pts):
            for j in range(i, 0, -1):
                p = turn(p, J[j]['c'], J[j]['n'], np.radians(curl[j][1]))
            out.append(Rotation.from_rotvec(rv).apply(p - J[0]['c']) + J[0]['c'])
        return out
    def cost(rv):
        o = curled(rv)
        m = o[1].mean(0)
        w, vec = np.linalg.eigh(np.cov((o[1] - m).T))
        ax = vec[:, 2]
        ax = ax - (ax @ up) * up                                     # seen PA
        d = Rotation.from_rotvec(rv).apply(J[0]['d'])
        flex = np.degrees(np.arccos(np.clip(d @ J[0]['d'], -1, 1)))
        return ((flex - curl[0][1]) / 5) ** 2 + 100 * (ax @ side / np.linalg.norm(ax)) ** 2 + 4 * ((m - J[0]['c']) @ side) ** 2
    r = minimize(cost, np.radians(curl[0][1]) * J[0]['n'], method='Nelder-Mead', options={'maxiter': 4000, 'xatol': 1e-5, 'fatol': 1e-8})
    return r.x


def solve_thumb(V, piece, J, pieces, curls):
    """The thumb's CMC turn at full curl (a rotation vector, radians): the one turn about its centre
    that, with its MCP and IP flexed, lays its IP over the curled index finger's middle phalanx and
    its tip over the middle finger's, THUMB_FRONT in front of them, and keeps its bones clear of the
    fist's (the opposition of a fist: the metacarpal swung palmar and across, pronating)."""
    from scipy.optimize import minimize
    from scipy.spatial.transform import Rotation
    pts = lambda c: np.stack(V.coords(piece == c), 1)[::4]
    full = lambda k: [J[k][j].get('deg', curls[k][j][1]) for j in range(3)]
    fist, mids = [], []
    for k in range(1, 5):
        for i in range(3):
            q = pts(pieces[k][i])
            for j in range(i, -1, -1):
                q = turn(q, J[k][j]['c'], J[k][j]['n'], np.radians(full(k)[j]))
            fist.append(q)
            if i == 1 and k <= 2:
                mids.append(q.mean(0))
    front = np.array([0, -THUMB_FRONT, 0])
    t_ip, t_tip = mids[0] + front, mids[1] + front
    still = np.stack(V.coords(piece == 1), 1)[::6]
    still = still[np.linalg.norm(still - J[0][0]['c'], axis=1) < 7]
    tf, tfist = cKDTree(np.concatenate(fist + [still])), cKDTree(np.concatenate(fist))
    cmc, mcp, ip = J[0]
    th = [pts(c) for c in pieces[0]]
    Q = np.stack(V.coords(piece == pieces[0][2]), 1)
    tip = Q[np.argmax((Q - ip['c']) @ ip['d'])]
    def pose(rv):
        # the IP turns the distal phalanx and the tip, the MCP those and the proximal phalanx, the CMC all
        parts = [th[0], th[1], th[2], tip[None], ip['c'][None]]
        lvl = [0, 1, 2, 2, 1]
        outp = []
        for p, l in zip(parts, lvl):
            if l >= 2: p = turn(p, ip['c'], ip['n'], np.radians(curls[0][2][1]))
            if l >= 1: p = turn(p, mcp['c'], mcp['n'], np.radians(curls[0][1][1]))
            outp.append(Rotation.from_rotvec(rv).apply(p - cmc['c']) + cmc['c'])
        return outp
    def cost(rv):
        o = pose(rv)
        e = np.sum((o[3][0] - t_tip) ** 2) + np.sum((o[4][0] - t_ip) ** 2)
        # (the phalanges clear of the fist and the palm's bones; the metacarpal, which sits on the
        # carpus, clear of the fist)
        d = tf.query(np.concatenate(o[1:3]))[0]
        dm = tfist.query(o[0])[0]
        return e + 10 * np.sum(np.clip(0.7 - d, 0, None) ** 2) + 10 * np.sum(np.clip(0.5 - dm, 0, None) ** 2)
    best = None
    for s in [[0, 0, 0], [0.5, 0, 0], [0, 0.5, 0], [0, 0, 0.5], [-0.5, 0, 0], [0, -0.5, 0], [0, 0, -0.5], [0.5, 0.5, -0.5]]:
        r = minimize(cost, s, method='Nelder-Mead', options={'maxiter': 4000, 'xatol': 1e-4, 'fatol': 1e-7})
        if best is None or r.fun < best.fun:
            best = r
    o = pose(best.x)
    print(f'  thumb in a fist: CMC {np.degrees(np.linalg.norm(best.x)):.1f} deg about {np.round(unit(best.x), 3).tolist()}; '
          f'tip {np.linalg.norm(o[3][0] - t_tip):.2f} cm and IP {np.linalg.norm(o[4][0] - t_ip):.2f} cm from where a fist has them; '
          f'its phalanges {tf.query(np.concatenate(o[1:3]))[0].min():.2f} cm clear of the fingers\' bones')
    return best.x


def main():
    out = {'_about': __doc__.strip().splitlines()[0]}
    if sys.argv[1:] == ['shoulder']:
        # the shoulder alone, first in the arm's chain (a chain lists its joints proximal first)
        old = json.loads(OUT.read_text(encoding='utf-8'))
        arm = {k: v for k, v in old['upperextremity'].items() if k != 'shoulder'}
        old['upperextremity'] = {'shoulder': shoulder_field(), **arm}
        OUT.write_text(json.dumps(old, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
        print('wrote the shoulder to', OUT)
        return
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
    # ---- and its digits, distal of the wrist (a chain lists its joints proximal first)
    out['hand'].update(hand_digits(radial, np.array(c)))
    if sys.argv[1:] == ['hand']:
        # the hand alone: every other model's joints as joints.json has them (their measures read
        # other models' labels, and rewrite those models' grids)
        old = json.loads(OUT.read_text(encoding='utf-8'))
        old['hand'] = out['hand']
        OUT.write_text(json.dumps(old, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
        print('wrote the hand to', OUT)
        return
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
    arm = {'shoulder': shoulder_field(), 'elbow': {
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
