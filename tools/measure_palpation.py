"""Measure the PALPATION landmarks the Trainer can show on the skin, from the voxel models.

    python tools/measure_palpation.py        # writes apps/web/src/data/palpation.json

A radiographer centres by feeling bone through the skin: the jugular notch, the iliac crest, the
ASIS, a malleolus, a styloid. Each landmark here is the BONY point, measured from the model's own
bone, plus the direction it is felt from. The app walks from the bone along that direction until
it leaves the body and marks that skin point in red (src/trainer/palpate.js).

Frame: the x-ray REST frame (what landmarkLocal() calls frame "world"): x = patient's right,
y = anterior, z = superior (on the hand: dorsum up, z toward the fingertips). The model volumes
are stored mirrored for most subjects, so each is flipped into this frame first — the same flips
the app's voxelFlips() makes in x-ray mode. Checked: the chest's heart lands at -x (patient's
left) and its spine at -y (posterior) after the flip.

Every landmark carries how it was found. Heuristics on bone masks, kept simple and readable; a
landmark that cannot be found is left out rather than guessed.
"""
import json, pathlib
import numpy as np
from scipy import ndimage as ndi

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODELS = ROOT / 'apps' / 'web' / 'public' / 'models'
OUT = ROOT / 'apps' / 'web' / 'src' / 'data' / 'palpation.json'
LANDMARKS = json.loads((ROOT / 'apps' / 'web' / 'src' / 'data' / 'landmarks.json').read_text(encoding='utf-8'))
ROLLED_180 = {'chestabdopelvis', 'headneck'}


# The models whose joint spaces are cut (services/compute/app/joint_space.py, build_hand.py): their
# landmarks are measured on the skeleton with its joint cartilage, as before the cut (the gaps put dips
# in every bone profile; a hand's wrist landmark moved 4 cm). Not the chest's: its costal cartilage is
# no landmark's bone.
JOINTED = {'hand', 'upperextremity', 'lowerextremity', 'headneck'}


def skeleton_ids(name, h):
    return [m['id'] for m in h['materials']
            if 'bone' in m['name'].lower() or (name in JOINTED and m['name'].lower() == 'cartilage')]


class Vol:
    """A model in the rest frame: bone mask, tissue mask, and index <-> cm (voxel centres at
    (i - (n-1)/2) * spacing, as the app places them)."""
    def __init__(self, name):
        h = json.loads((MODELS / name / f'{name}.model.json').read_text(encoding='utf-8'))
        nx, ny, nz = h['dims']
        self.sp = np.array(h['spacing'], float) / 10.0
        v = np.fromfile(MODELS / name / f'{name}.mat.bin', dtype=np.uint8).reshape(nz, ny, nx)
        if name not in ROLLED_180:                    # x-ray voxelFlips: mirror x and y
            v = v[:, ::-1, ::-1]
        self.v = v
        self.bone = np.isin(v, skeleton_ids(name, h))
        self.n = np.array([nx, ny, nz])

    def main_bone(self):
        """only the largest connected bone: a limb CT can carry a sliver of the other limb at the
        edge of the crop, and an 'extreme' point would land on it (the malleoli first came out at
        exactly the volume's edge)"""
        # (the skeleton, not one bone: with its joint spaces open (services/compute/app/joint_space.py)
        # a limb is many separate bones, so pieces are joined across a joint's width before choosing)
        r = max(2, int(np.ceil(0.5 / float(self.sp.min()))))          # 5 mm, in voxels: over any joint gap
        lab, n = ndi.label(ndi.binary_dilation(self.bone, iterations=r))
        if n > 1:
            sizes = ndi.sum(self.bone, lab, range(1, n + 1))
            self.bone &= lab == (int(np.argmax(sizes)) + 1)
        return self

    def cm(self, i, j, k):
        return [round(float((i - (self.n[0] - 1) / 2) * self.sp[0]), 2),
                round(float((j - (self.n[1] - 1) / 2) * self.sp[1]), 2),
                round(float((k - (self.n[2] - 1) / 2) * self.sp[2]), 2)]

    def idx(self, axis, cm):
        return int(round(cm / self.sp[axis] + (self.n[axis] - 1) / 2))

    def coords(self, mask):
        """(x, y, z) cm arrays of the voxels in a mask"""
        k, j, i = np.nonzero(mask)
        return ((i - (self.n[0] - 1) / 2) * self.sp[0], (j - (self.n[1] - 1) / 2) * self.sp[1],
                (k - (self.n[2] - 1) / 2) * self.sp[2])


def lm(subject, name):
    """a centring landmark from landmarks.json, in the rest frame"""
    p = LANDMARKS[subject][name]
    if p.get('frame') == 'world':
        return np.array([p.get('x') or 0, p.get('y') or 0, p['z']], float)
    f = -1 if subject not in ROLLED_180 else 1
    return np.array([f * (p.get('x') or 0), f * (p.get('y') or 0), p['z']], float)


def entry(point, direction, label, how, sure='medium'):
    d = np.asarray(direction, float); d = d / np.linalg.norm(d)
    return {'label': label, 'x': round(float(point[0]), 2), 'y': round(float(point[1]), 2), 'z': round(float(point[2]), 2),
            'dir': [round(float(c), 3) for c in d], 'how': how, 'confidence': sure}


def extreme(V, mask, axis, sign):
    """the voxel of a mask furthest along +/- an axis (0 x, 1 y, 2 z), as cm"""
    x, y, z = V.coords(mask)
    a = (x, y, z)[axis]
    if not len(a):
        return None
    i = int(np.argmax(a) if sign > 0 else np.argmin(a))
    return np.array([x[i], y[i], z[i]])


def zband(V, z0, z1):
    """a mask selecting z in [z0, z1] cm"""
    m = np.zeros(V.v.shape, bool)
    k0, k1 = sorted((V.idx(2, z0), V.idx(2, z1)))
    m[max(0, k0):min(V.n[2], k1 + 1)] = True
    return m


def xband(V, x0, x1):
    m = np.zeros(V.v.shape, bool)
    i0, i1 = sorted((V.idx(0, x0), V.idx(0, x1)))
    m[:, :, max(0, i0):min(V.n[0], i1 + 1)] = True
    return m


# ---------------------------------------------------------------- the hand and wrist
def hand():
    V, out = Vol('hand').main_bone(), {}
    wrist, mcp = lm('hand', 'wrist'), lm('hand', 'hand')
    # the two forearm bones, 2.5 cm proximal of the carpals; the radius is the wider at its distal end
    k = V.idx(2, wrist[2] - 2.5)
    lab, n = ndi.label(V.bone[k])
    sizes = ndi.sum(V.bone[k], lab, range(1, n + 1)) if n else []
    if n >= 2:
        order = np.argsort(sizes)[::-1][:2]
        cents = [ndi.center_of_mass(V.bone[k], lab, int(o) + 1) for o in order]   # (j, i)
        rad_i, uln_i = cents[0][1], cents[1][1]
        radial = 1 if rad_i > uln_i else -1          # +x or -x is the thumb side
        # the styloids, at the RADIOCARPAL joint. On this hand the joint lies 2.2 cm proximal of the
        # midcarpal 'wrist' landmark (read off a coronal bone projection: radius and ulna end at
        # z -5.5, the carpus runs to the metacarpal bases at -2.0). The radial styloid is the most
        # radial bone from 1 cm below the joint to 0.6 cm above it (it projects distally beside the
        # scaphoid); the ulnar styloid the most ulnar bone within 0.5 cm of the joint (any wider and the
        # ulna's shaft, which bows further ulnar, wins). Two
        # earlier rules failed and are why this one is anchored on the joint: "the most radial bone
        # near the wrist" took the scaphoid, and following each forearm bone as a connected piece
        # ran through the joint into the carpus.
        joint = wrist[2] - 2.2
        rs = extreme(V, zband(V, joint - 1.0, joint + 0.6) & V.bone, 0, radial)
        us = extreme(V, zband(V, joint - 0.5, joint + 0.5) & V.bone, 0, -radial)   # (wider took the bowed shaft)
        if rs is not None:
            out['radialStyloid'] = entry(rs, [radial, 0, 0], 'Radial styloid',
                'the most radial bone within a centimetre of the radiocarpal joint (2.2 cm proximal of the midcarpal landmark)')
            # the anatomical snuffbox: just distal to the radial styloid, over the scaphoid
            out['scaphoid'] = entry(rs + np.array([-radial * 0.4, 0, 1.0]), [radial, 0.4, 0], 'Scaphoid (snuffbox)',
                '1 cm distal to the radial styloid, felt in the anatomical snuffbox')
        if us is not None:
            out['ulnarStyloid'] = entry(us, [-radial, 0, 0], 'Ulnar styloid',
                'the most ulnar bone within a centimetre of the radiocarpal joint')
        # the MCP joints: the metacarpal heads half a centimetre proximal of the MCP level, found as
        # runs of bone across the hand (islands split where the cortex is thin), felt on the dorsum
        km = V.idx(2, mcp[2] - 0.5)
        cols = V.bone[km].any(axis=0)                       # any bone in each x column
        runs, i = [], 0
        while i < len(cols):
            if cols[i]:
                j = i
                while j + 1 < len(cols) and cols[j + 1]: j += 1
                if (j - i + 1) * V.sp[0] >= 0.6: runs.append((i, j))
                i = j + 1
            else: i += 1
        runs.sort(key=lambda r: -radial * (r[0] + r[1]))     # from the radial side
        # five runs: the thumb is the first; four: it has left this level
        off = 1 if len(runs) >= 5 else 0
        for t, (key, label) in enumerate([('mcp2', '2nd MCP joint'), ('mcp3', '3rd MCP joint')]):
            if t + off < len(runs):
                a, b = runs[t + off]
                ic = (a + b) / 2
                jj = np.nonzero(V.bone[km, :, int(round(ic))])[0]
                p = np.array(V.cm(ic, jj.max() if len(jj) else (V.n[1] - 1) / 2, km))
                out[key] = entry(p, [0, 1, 0], label,
                    f'metacarpal head {t + 2} counted from the radial side, 0.5 cm proximal of the MCP level; felt as the knuckle on the dorsum')
    return out


# ---------------------------------------------------------------- the ankle and foot
def foot_axis(V, ank, lateral):
    """The foot's bone beyond the ankle, as distances t along the foot's axis (the ankle to the
    furthest bone below it: the tip of the toes), with that length L, the axis u and the bone's
    coordinates. None if there is no foot."""
    x, y, z = V.coords(V.bone & zband(V, ank[2] - 40, ank[2] - 1))
    if not len(x):
        return None
    p = np.stack([x, y, z], 1) - np.asarray(ank, float)
    far = p[int(np.argmax((p ** 2).sum(1)))]
    u = far / np.linalg.norm(far)
    t = p @ u
    keep = t > 0
    return t[keep], float(t.max()), u, x[keep], y[keep], z[keep]


def lower_extremity():
    V, out = Vol('lowerextremity').main_bone(), {}
    ank = lm('lowerextremity', 'ankle')
    # tibia (bigger) and fibula (smaller) 6 cm above the ankle: which side is lateral
    k = V.idx(2, ank[2] + 6)
    lab, n = ndi.label(V.bone[k])
    if n >= 2:
        sizes = ndi.sum(V.bone[k], lab, range(1, n + 1))
        order = np.argsort(sizes)[::-1][:2]
        cents = [ndi.center_of_mass(V.bone[k], lab, int(o) + 1) for o in order]
        lateral = 1 if cents[1][1] > cents[0][1] else -1       # the fibula's side
        # Each malleolus is sought only under its own bone: the tibia's and the fibula's footprints
        # 4 cm above the ankle, grown by 1.5 cm. With the whole foot in the model (it was cut off
        # at the box edge before), "the most medial bone near the ankle" found the heel: this leg
        # turns outward and the calcaneus projects further medially than the tibia's tip.
        def under(o):
            k4 = V.idx(2, ank[2] + 4)
            lab4, n4 = ndi.label(V.bone[k4])
            s4 = ndi.sum(V.bone[k4], lab4, range(1, n4 + 1))
            fp = lab4 == int(np.argsort(s4)[::-1][o]) + 1
            fp = ndi.binary_dilation(fp, iterations=int(round(1.5 / V.sp[0])))
            return np.broadcast_to(fp, V.bone.shape)
        # the tips lie about 1.5 cm (medial) and 2.5 cm (lateral) below the joint: deeper than that,
        # under a foot at 90 degrees, the talus's head and the navicular reach further medially
        near_t = zband(V, ank[2] - 1.5, ank[2] + 2) & V.bone & under(0)
        near_f = zband(V, ank[2] - 3, ank[2] + 1) & V.bone & under(1)
        mm = extreme(V, near_t, 0, -lateral)
        lmal = extreme(V, near_f, 0, lateral)
        if mm is not None:
            out['medialMalleolus'] = entry(mm, [-lateral, 0, 0], 'Medial malleolus',
                'the most medial bone within 1.5 cm below the ankle joint, under the tibia (the fibula is lateral 6 cm above)')
        if lmal is not None:
            out['lateralMalleolus'] = entry(lmal, [lateral, 0, 0], 'Lateral malleolus',
                'the most lateral bone within 3 cm below the ankle joint, under the fibula')
        # The foot is measured along its own axis, ankle to the tip of the toes: this one is
        # plantarflexed (post mortem), so "below the ankle" in z is not along the foot at all.
        fa = foot_axis(V, ank, lateral)
        if fa is not None:
            t, L, u, xb, yb, zb = fa
            band = (t > 0.30 * L) & (t < 0.50 * L)
            if band.any():
                i = int(np.argmax(lateral * xb[band]))
                b5 = np.array([xb[band][i], yb[band][i], zb[band][i]])
                out['base5th'] = entry(b5, [lateral, 0, 0], 'Base of the 5th metatarsal',
                    f'the most lateral bone 30-50 % of the way from the ankle to the tip of the toes ({L:.1f} cm): the 5th metatarsal tuberosity', 'medium')
        # knee: the patella (anterior-most bone at the joint) and the tibial tuberosity below it
        if 'knee' in LANDMARKS['lowerextremity']:
            kn = lm('lowerextremity', 'knee')
            pat = extreme(V, zband(V, kn[2] - 1, kn[2] + 5) & V.bone, 1, 1)
            if pat is not None:
                out['patella'] = entry(pat, [0, 1, 0], 'Patella', 'the most anterior bone within 5 cm above the knee joint')
            tt = extreme(V, zband(V, kn[2] - 6, kn[2] - 2) & V.bone, 1, 1)
            if tt is not None:
                out['tibialTuberosity'] = entry(tt, [0, 1, 0], 'Tibial tuberosity', 'the most anterior bone 2-6 cm below the knee joint')
    return out


# ---------------------------------------------------------------- the arm (elbow)
def upper_extremity():
    """The epicondyles and the olecranon, from the bone itself: no axis can be assumed (z033's arm
    rested turned about 90 degrees; z053's, now the model, about 9).
    - the epicondyles are the two points of the condylar region (3 cm about the elbow landmark,
      the widest the distal humerus gets) furthest apart, seen along the arm;
    - behind the joint is the side the bone reaches furthest past the epicondylar line 1-2 cm
      distal: the olecranon (3.5 cm behind, against 1 cm in front);
    - lateral then follows from handedness: it is a RIGHT arm (the liver lies on its side of the
      scan), and for a right arm lateral x posterior points distally, whatever its rotation.
    Two first attempts failed and say why this is done so: "behind is away from the radius" (the
    radial head lies almost on the epicondylar line, so the sign came out at random) and "medial is
    nearer the bigger forearm bone" (5-8 cm down the bigger section is not reliably the ulna)."""
    V, out = Vol('upperextremity').main_bone(), {}
    el = lm('upperextremity', 'elbow')
    def sec(zcm):
        jj, ii = np.nonzero(V.bone[V.idx(2, zcm)])
        return np.stack([(ii - (V.n[0] - 1) / 2) * V.sp[0], (jj - (V.n[1] - 1) / 2) * V.sp[1]], 1)
    # The epicondyles are the two points of the condylar region furthest apart, seen along the arm:
    # over 3 cm about the widest section, not that section alone. The section twists through the
    # condyles, and its long axis (the measure before) turned 16 degrees when the widest slice moved
    # 3 mm between two builds of the same bone.
    from scipy.spatial import ConvexHull
    xy = np.unique(np.concatenate([sec(el[2] + dz) for dz in np.arange(-1.5, 1.51, V.sp[2])]), axis=0)
    hv = xy[ConvexHull(xy).vertices]
    d = np.linalg.norm(hv[:, None] - hv[None], axis=2)
    i, j = np.unravel_index(int(np.argmax(d)), d.shape)
    e1, e2 = hv[i], hv[j]
    ax = (e2 - e1) / np.linalg.norm(e2 - e1)                      # the epicondylar axis
    mid = (e1 + e2) / 2
    post = np.array([-ax[1], ax[0]])
    reach = lambda d: max(((sec(el[2] - dd) - mid) @ d).max() for dd in (1.0, 1.5, 2.0))
    if reach(-post) > reach(post):
        post = -post
    # right arm: lateral x posterior = -z (distal)
    cross = lambda u, v: u[0] * v[1] - u[1] * v[0]
    lat, med = (e1, e2) if cross(e1 - mid, post) < 0 else (e2, e1)
    out['medialEpicondyle'] = entry([med[0], med[1], el[2]], np.r_[med - lat, 0], 'Medial epicondyle',
        'the medial end of the distal humerus section at the elbow landmark', 'high')
    out['lateralEpicondyle'] = entry([lat[0], lat[1], el[2]], np.r_[lat - med, 0], 'Lateral epicondyle',
        'the lateral end of the distal humerus section at the elbow landmark', 'high')
    best = None
    for d in (1.0, 1.5, 2.0):
        pts = sec(el[2] - d)
        i = int(np.argmax((pts - mid) @ post))
        if best is None or (pts[i] - mid) @ post > best[0]:
            best = ((pts[i] - mid) @ post, pts[i], d)
    ol = best[1]
    out['olecranon'] = entry([ol[0], ol[1], el[2] - best[2]], np.r_[post, 0], 'Olecranon',
        'the bone reaching furthest behind the epicondylar line 1-2 cm distal of it', 'high')
    return out


# ---------------------------------------------------------------- the head and neck
def head_neck():
    """From the head CT's own labels (s1082), registered to the model (measure_landmarks.label_points).
    The head & neck volume is already in the rest frame (x right, y anterior)."""
    import measure_landmarks as ML
    h, vol, bone, sp = ML.load('headneck')
    P = lambda n: ML.label_points(n, bone, sp)
    out = {}
    c1, c7, skull, sternum = P('vertebrae_C1'), P('vertebrae_C7'), P('skull'), P('sternum')
    if c1 is None or skull is None:
        return out
    yc1 = c1[:, 1].mean()
    for side, sgn in (('R', 1), ('L', -1)):
        # the mastoid tip: the lowest skull behind the atlas, 4 cm or more to the side
        m = skull[(sgn * skull[:, 0] > 4) & (skull[:, 1] < yc1)]
        if len(m):
            out[f'mastoid{side}'] = entry(m[int(np.argmin(m[:, 2]))], [sgn, -0.3, -0.3], f'Mastoid tip ({side})',
                'the lowest skull behind the atlas, 4 cm or more from the midline', 'high')
        # the angle of the mandible: of the lowest 1.5 cm of jaw on this side, the most posterior point
        j = skull[(sgn * skull[:, 0] > 3) & (skull[:, 1] > yc1 + 1)]
        if len(j):
            low = j[j[:, 2] < j[:, 2].min() + 1.5]
            out[f'gonion{side}'] = entry(low[int(np.argmin(low[:, 1]))], [sgn, 0, -0.5], f'Angle of the mandible ({side})',
                'the most posterior point of the lowest 1.5 cm of the jaw on this side (level with C3)', 'medium')
    mid = skull[np.abs(skull[:, 0]) < 1.0]
    if len(mid):
        out['inion'] = entry(mid[int(np.argmin(mid[:, 1]))], [0, -1, 0], 'External occipital protuberance',
            'the most posterior midline point of the skull', 'medium')
    if c7 is not None:
        out['vertebraProminens'] = entry(c7[int(np.argmin(c7[:, 1]))], [0, -1, 0], 'Vertebra prominens (C7)',
            'the tip of the C7 spinous process: the most posterior point of the C7 label', 'high')
    if sternum is not None:
        out['jugularNotch'] = entry(sternum[int(np.argmax(sternum[:, 2]))], [0, 1, 0.3], 'Jugular notch',
            'the top of the manubrium (the sternum label), level with T2-T3', 'high')
    return out


# ---------------------------------------------------------------- the trunk
def sternum(V, x_half=1.5):
    """the sternum as a column: per slice, the most anterior midline bone, kept where it stands
    well forward of the spine. Returns (z_cm, y_cm) arrays of the slices where it exists."""
    mid = xband(V, -x_half, x_half) & V.bone
    zs, ys = [], []
    for k in range(V.n[2]):
        jj = np.nonzero(mid[k].any(axis=1))[0]
        if len(jj) < 2:
            continue
        front = (jj.max() - (V.n[1] - 1) / 2) * V.sp[1]
        back = (jj.min() - (V.n[1] - 1) / 2) * V.sp[1]
        if front - back > 9:                              # separate from the vertebra by a chest
            zs.append((k - (V.n[2] - 1) / 2) * V.sp[2]); ys.append(front)
    return np.array(zs), np.array(ys)


def trunk(name):
    V, out = Vol(name), {}
    zs, ys = sternum(V)
    if len(zs) > 10:
        # the sternum stands near its full height forward of the spine along its whole length; other
        # midline bone (the neck, the pelvis) also stands forward, but less. Take the longest
        # unbroken run of slices within 25 % of the furthest-forward one.
        ok = ys >= 0.75 * ys.max()
        order = np.argsort(zs); zs, ys, ok = zs[order], ys[order], ok[order]
        best, cur = (0, -1), None
        for q in range(len(zs)):
            if ok[q] and (cur is not None and q > 0 and ok[q - 1] and zs[q] - zs[q - 1] <= 2 * V.sp[2] + 1e-6):
                cur = (cur[0], q)
            elif ok[q]:
                cur = (q, q)
            else:
                cur = None
            if cur and cur[1] - cur[0] > best[1] - best[0]: best = cur
        # the manubrium stands less far forward than the body of the sternum: carry the run upward
        # while the midline bone stays at least half as far forward and the slices stay contiguous
        hi = best[1]
        while hi + 1 < len(zs) and ys[hi + 1] >= 0.5 * ys.max() and zs[hi + 1] - zs[hi] <= 2 * V.sp[2] + 1e-6:
            hi += 1
        zs, ys = zs[best[0]:hi + 1], ys[best[0]:hi + 1]
        top, bot = zs.max(), zs.min()
        it, ib = int(np.argmax(zs)), int(np.argmin(zs))
        out['jugularNotch'] = entry([0, ys[it], top], [0, 0.6, 0.8], 'Jugular notch',
            'the superior end of the sternum (the most anterior midline bone standing forward of the spine)')
        out['xiphoid'] = entry([0, ys[ib], bot], [0, 1, 0], 'Xiphoid process',
            'the inferior end of the sternum')
        if top - bot > 12:
            # the sternal angle: about a third of the way down the sternum (manubrium ~5 of ~17 cm)
            zs_a = top - 0.3 * (top - bot)
            k = int(np.argmin(np.abs(zs - zs_a)))
            out['sternalAngle'] = entry([0, ys[k], zs[k]], [0, 1, 0], 'Sternal angle (T4-T5)',
                'the manubriosternal joint, taken 30 % of the way down the sternum', 'low')
    if name == 'chestabdopelvis':
        crest_z = lm(name, 'kub')[2]
        # the PELVIS on its own: the largest bone piece between the hips and just above the crest.
        # Searching all bone let the lowest ribs (which reach the crest's level at the side) win
        # the crest, and the pubic rami win the ASIS.
        band = zband(V, crest_z - 20, crest_z + 1.5) & V.bone
        lab, nl = ndi.label(band)
        pelvis = lab == (int(np.argmax(ndi.sum(band, lab, range(1, nl + 1)))) + 1) if nl else band
        for side, s in (('R', 1), ('L', -1)):
            fh = lm(name, 'femoralHead' + side)
            # the crest is nearly flat from 8 to 11 cm out and falls away laterally (measured: z -11.1
            # to -11.3, then -14.3 at 15 cm); it is felt at the SIDE, so take its summit 11-14 cm out
            top = extreme(V, pelvis & xband(V, s * 11, s * 14), 2, 1)
            if top is not None:
                out['iliacCrest' + side] = entry(top, [s, 0, 0.6], f'Iliac crest ({side})',
                    'the highest point of the iliac crest 11-14 cm from the midline, where it is felt at the side (L4-L5)')
            # the ASIS: the most anterior point of the iliac wing ABOVE the hip joint and lateral to it
            a = extreme(V, pelvis & zband(V, fh[2] + 3, crest_z) & xband(V, s * 8, s * 16), 1, 1)
            if a is not None:
                out['asis' + side] = entry(a, [0, 1, 0], f'ASIS ({side})',
                    'the most anterior point of the pelvis 3 cm or more above the femoral head and 8-16 cm from the midline')
            gt = extreme(V, zband(V, fh[2] - 4, fh[2] + 1) & V.bone & xband(V, s * 6, s * 30), 0, s)
            if gt is not None:
                out['trochanter' + side] = entry(gt, [s, 0, 0], f'Greater trochanter ({side})',
                    'the most lateral bone within 4 cm below the femoral head')
        sym = extreme(V, zband(V, crest_z - 22, crest_z - 12) & V.bone & xband(V, -1.5, 1.5), 1, 1)
        if sym is not None:
            out['symphysis'] = entry(sym, [0, 1, 0], 'Pubic symphysis', 'the most anterior midline bone of the pelvis')
        # the inferior costal margin: the lowest rib bone at the side, above the crest
        for side, s in (('R', 1),):
            ribs = zband(V, crest_z + 3, crest_z + 20) & V.bone & xband(V, s * 9, s * 18)
            low = extreme(V, ribs, 2, -1)
            if low is not None:
                out['costalMargin' + side] = entry(low, [s, 0.5, 0], f'Inferior costal margin ({side})',
                    'the lowest rib 9-18 cm from the midline, above the iliac crest (about L2-L3)', 'low')
    return out


def main():
    out = {'_about': __doc__.strip().splitlines()[0] + ' Rest-frame (x right, y anterior, z superior) cm from the '
           'volume centre, with the direction the landmark is felt from. Re-run after rebuilding a model.'}
    for name, fn in (('hand', hand), ('lowerextremity', lower_extremity), ('upperextremity', upper_extremity), ('headneck', head_neck),
                     ('chest', lambda: trunk('chest')), ('chestabdopelvis', lambda: trunk('chestabdopelvis'))):
        out[name] = fn()
        for k, v in out[name].items():
            print(f'{name:16s} {k:18s} ({v["x"]:7.2f} {v["y"]:7.2f} {v["z"]:7.2f})  {v["how"][:70]}')
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    print('wrote', OUT)


if __name__ == '__main__':
    main()
