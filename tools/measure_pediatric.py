"""Measure the pediatric model's landmarks, centring points and palpation points.

    services/compute/.venv/Scripts/python.exe tools/measure_pediatric.py
        # writes the 'pediatric' entries of apps/web/src/data/landmarks.json, centring.json and
        # palpation.json; every other model's entries are left as they are

The model is a composite (services/compute/app/build_pediatric.py): the child's own trunk, a grafted
head and neck, girdles and arms, and legs. Its builder writes, beside the model, the labels every part
brought with it, on the model's own grid (services/compute/data/pediatric/pediatric_labels.npz): the
child's TotalSegmentator labels (vertebrae T1-S1, ribs, sternum, hip bones, femurs, organs), the head
donor's ground truth (skull, C1-C7) and the girdles' (scapulae, clavicles, humeri). So every point here
is read off a named bone, not a bone profile:

- landmarks (the model's VOLUME frame: cm from the volume centre, x toward the patient's left, y
  posterior, z superior; the app flips them as it flips the phantom): the vertebral bodies of T7 and
  L3, the iliac crests (the AP abdomen), the pelvis (midway between the ASIS and the symphysis), the
  cranium and C4;
- centring (the x-ray REST frame: x toward the patient's right, y anterior): T7 for the chest (the
  centre of the lung fields), on the midcoronal plane for the lateral, on the column for the spine
  laterals; the iliac crest likewise; C4, C1-C2, C7-T1;
- palpation (rest frame, with the direction they are felt from): jugular notch, sternal angle,
  xiphoid, iliac crests, ASIS, greater trochanters, symphysis, mastoids, gonions, inion, C7.

The femoral heads are left out on purpose: the app's leg turn (core/limbPose.js) floods a femur up
from the bottom of the volume, which in a whole-body model is the foot.
"""
import json, pathlib
import numpy as np
from scipy import ndimage as ndi

ROOT = pathlib.Path(__file__).resolve().parents[1]
NAME = 'pediatric'
MODEL = ROOT / 'apps' / 'web' / 'public' / 'models' / NAME
DATA = ROOT / 'apps' / 'web' / 'src' / 'data'
LABELS = ROOT / 'services' / 'compute' / 'data' / 'pediatric' / f'{NAME}_labels.npz'
SRC = 'the pediatric model\'s own labels (build_pediatric.py)'


def class_ids():
    from totalsegmentator.map_to_binary import class_map
    return {v: k for k, v in class_map['total'].items()}


class P:
    """the model and its labels; points in cm from the volume centre (volume frame)"""
    def __init__(self):
        h = json.loads((MODEL / f'{NAME}.model.json').read_text(encoding='utf-8'))
        self.nx, self.ny, self.nz = h['dims']
        self.sp = float(h['spacing'][0]) / 10.0
        self.mat = np.fromfile(MODEL / f'{NAME}.mat.bin', np.uint8).reshape(self.nz, self.ny, self.nx)
        self.lab = np.load(LABELS)['lab']
        assert self.lab.shape == self.mat.shape, (self.lab.shape, self.mat.shape)
        self.ids = class_ids()
        self.bone = np.isin(self.mat, [16, 17, 18])
        self.body = self.mat > 0

    def cm(self, k, j, i):
        return np.stack([(np.asarray(i) - (self.nx - 1) / 2) * self.sp, (np.asarray(j) - (self.ny - 1) / 2) * self.sp,
                         (np.asarray(k) - (self.nz - 1) / 2) * self.sp], -1)

    def k(self, zcm):
        return int(round(zcm / self.sp + (self.nz - 1) / 2))

    def pts(self, *names):
        m = np.isin(self.lab, [self.ids[n] for n in names])
        k, j, i = np.nonzero(m)
        return self.cm(k, j, i)

    def body_of(self, name):
        """a vertebra's body: its anterior 40 % (anterior is -y in this volume)"""
        v = self.pts(name)
        y0, y1 = v[:, 1].min(), v[:, 1].max()
        return v[v[:, 1] <= y0 + 0.4 * (y1 - y0)]


def rest(p):
    """volume frame -> x-ray rest frame (x right, y anterior)"""
    return np.array([-p[0], -p[1], p[2]])


def r2(x):
    return round(float(x), 2)


def vol_pt(p, how, sure='high', **kw):
    return {'x': r2(p[0]), 'y': r2(p[1]), 'z': r2(p[2]), 'frame': 'volume', 'how': how, 'confidence': sure, **kw}


def rest_pt(p, how, guide, sure='high'):
    q = rest(p)
    return {'x': r2(q[0]), 'y': r2(q[1]), 'z': r2(q[2]), 'how': how, 'guide': guide, 'confidence': sure}


def palp(p, d, label, how, sure='medium'):
    q = rest(p)
    d = np.array([-d[0], -d[1], d[2]], float); d /= np.linalg.norm(d)
    return {'label': label, 'x': r2(q[0]), 'y': r2(q[1]), 'z': r2(q[2]), 'dir': [round(float(c), 3) for c in d],
            'how': how, 'confidence': sure}


def midcoronal_y(V, zcm, x0, half=2.0):
    """halfway between the front and back of the body at the midline, at level z (volume y, cm)"""
    k = V.k(zcm)
    i0 = int(round((x0 - half) / V.sp + (V.nx - 1) / 2)); i1 = int(round((x0 + half) / V.sp + (V.nx - 1) / 2))
    jj = np.nonzero(V.body[k, :, i0:i1 + 1].any(axis=1))[0]
    return float(((jj.min() + jj.max()) / 2 - (V.ny - 1) / 2) * V.sp)


def column_span(V, names):
    """the column's depth over a run of vertebrae: (front of the bodies, tips of the spinous processes),
    volume y (front = smaller y)"""
    v = V.pts(*names)
    return float(np.percentile(v[:, 1], 0.5)), float(np.percentile(v[:, 1], 99.5))


def measure():
    V = P()
    mid_x = float(np.median(V.pts(*[f'vertebrae_T{k}' for k in range(1, 13)])[:, 0]))
    land, cent, pal = {}, {}, {}
    # ---------------------------------------------------------------- spine and trunk
    t7 = V.body_of('vertebrae_T7').mean(0)
    l3 = V.body_of('vertebrae_L3').mean(0)
    hipR, hipL = V.pts('hip_right'), V.pts('hip_left')
    crestR, crestL = hipR[np.argmax(hipR[:, 2])], hipL[np.argmax(hipL[:, 2])]
    zc = (crestR[2] + crestL[2]) / 2
    l4 = V.body_of('vertebrae_L4').mean(0)
    # symphysis: the lowest of the most anterior hip bone at the midline (the pubes meet there)
    hips = np.concatenate([hipR, hipL])
    low = hips[(np.abs(hips[:, 0] - mid_x) < 3.0) & (hips[:, 2] < zc - 6)]
    front = low[low[:, 1] < low[:, 1].min() + 2.0] if len(low) else low
    sym = front[np.argmin(front[:, 2])] if len(front) else None
    asis = []
    for H, sgn in ((hipR, -1), (hipL, 1)):
        # ASIS: the most anterior point of the ilium below its crest, 4-12 cm off the midline
        c = H[(sgn * (H[:, 0] - mid_x) > 4) & (sgn * (H[:, 0] - mid_x) < 12) & (H[:, 2] > zc - 9)]
        asis.append(c[np.argmin(c[:, 1])])
    land['thoracic'] = vol_pt([mid_x, t7[1], t7[2]], f'T7: the vertebral body (anterior 40 % of its label), from {SRC}')
    land['lumbar'] = vol_pt([mid_x, l3[1], l3[2]], f'L3: the vertebral body, from {SRC}')
    land['kub'] = vol_pt([mid_x, l4[1], zc], f'the level of the iliac crests (the tops of the hip-bone labels, '
                         f'{crestR[2]:.1f} / {crestL[2]:.1f}), = L4-L5, on the midline at the depth of L4')
    land['abdomenErect'] = vol_pt([mid_x, l4[1], zc + 5 * 0.85], '4 cm above the crest (a child\'s 5): the diaphragm in the field', 'medium')
    if sym is not None:
        zp = ((asis[0][2] + asis[1][2]) / 2 + sym[2]) / 2
        land['pelvis'] = vol_pt([mid_x, l4[1], zp], f'midway between the ASIS ({asis[0][2]:.1f} / {asis[1][2]:.1f}) and the '
                                f'pubic symphysis ({sym[2]:.1f})')
    # ---------------------------------------------------------------- head and neck
    sk = V.pts('skull')
    top = sk[:, 2].max()
    cran = sk[sk[:, 2] > top - 0.5 * (top - sk[:, 2].min())]
    land['skull'] = vol_pt(cran.mean(0), 'bone-weighted centre of the upper half of the skull label (the cranium)', 'medium')
    c4 = V.body_of('vertebrae_C4').mean(0)
    land['cspine'] = vol_pt(c4, f'C4: the vertebral body, from {SRC} (the head donor\'s ground truth)')
    # ---------------------------------------------------------------- centring
    lungs = np.isin(V.lab, [V.ids[n] for n in V.ids if n.startswith('lung_')])
    kz = np.nonzero(lungs.any((1, 2)))[0]
    zl = (kz - (V.nz - 1) / 2) * V.sp
    z7 = float((zl.min() + zl.max()) / 2)
    st = V.pts('sternum')
    jn = st[np.argmax(st[:, 2])]
    cent['T7'] = rest_pt([mid_x, t7[1], z7], f'T7: the centre of the lung fields (lung labels z {zl.min():.1f} to {zl.max():.1f}), '
                         f'on the midsagittal plane at the depth of the vertebral bodies; the jugular notch is {jn[2] - z7:.1f} cm above it',
                         'PA/AP chest: CR to the midsagittal plane at T7, the centre of the lung fields; on a child the field is collimated '
                         'to the lungs (Bontrager; Radiopaedia)')
    cent['T7mc'] = rest_pt([mid_x, midcoronal_y(V, z7, mid_x), z7], 'T7 (as above) on the midcoronal plane: halfway between the front '
                           'and back of the body at the midline', 'Lateral chest: CR to the midcoronal plane at T7 (Bontrager; Radiopaedia)')
    cent['crest'] = rest_pt([mid_x, l4[1], zc], 'the level of the iliac crests, midsagittal, at the depth of the vertebral bodies',
                            'AP abdomen / lumbar spine: CR to the level of the iliac crest, L4-L5 (Bontrager; Radiopaedia)')
    cent['crestMc'] = rest_pt([mid_x, midcoronal_y(V, zc, mid_x), zc], 'the level of the iliac crests on the midcoronal plane',
                              'Lateral lumbar spine: CR to the level of the iliac crest (L4-L5), centred to the midcoronal plane (Bontrager)')
    f_, b_ = column_span(V, [f'vertebrae_L{k}' for k in range(1, 6)] + ['vertebrae_S1'])
    cent['crestCol'] = rest_pt([mid_x, (f_ + b_) / 2, zc], f'the level of the iliac crests on the middle of the lumbar column\'s depth '
                               f'(front of the bodies y {f_:.1f}, spinous tips {b_:.1f}, volume frame)',
                               'Lateral lumbar spine: CR to the level of the iliac crest (L4-L5), centred on the vertebral column (Bontrager; Radiopaedia)')
    f_, b_ = column_span(V, [f'vertebrae_T{k}' for k in range(3, 13)])
    cent['T7col'] = rest_pt([mid_x, (f_ + b_) / 2, z7], f'T7 on the middle of the thoracic column\'s depth (T3-T12)',
                            'Lateral thoracic spine: CR to T7, centred on the vertebral column (Bontrager; Radiopaedia)')
    body_ = lambda n: V.body_of(n).mean(0)
    cent['C4'] = rest_pt(c4, 'the body of C4 (the head donor\'s labels, on the model)',
                         'AP axial cervical: CR 15-20 degrees cephalad to C4; lateral cervical: CR to C4 (Bontrager; Radiopaedia)')
    cent['C1C2'] = rest_pt((body_('vertebrae_C1') + body_('vertebrae_C2')) / 2, 'midway between the bodies of C1 and C2',
                           'AP open mouth (C1-C2): CR through the centre of the open mouth, to C1-C2 (Bontrager; Radiopaedia)')
    cent['C7T1'] = rest_pt((body_('vertebrae_C7') + body_('vertebrae_T1')) / 2, 'midway between the bodies of C7 and T1 (the seam of '
                           'the graft: the head donor\'s C7 on the child\'s T1)', 'Swimmers lateral: CR to C7-T1 (Bontrager; Radiopaedia)')
    # (the whole skull, mandible included: the cranium's centre left the face and the mandible off a 24 cm field)
    lo_, hi_ = sk.min(0), sk.max(0)
    cent['skull'] = rest_pt([land['skull']['x'], (lo_[1] + hi_[1]) / 2, (lo_[2] + hi_[2]) / 2],
                            f'the middle of the skull label: halfway between the vertex ({hi_[2]:.1f}) and the mandible ({lo_[2]:.1f}), '
                            'and between its front and back, on the cranium\'s midline',
                            'AP / lateral skull: CR to the middle of the head, so the whole skull, vertex to mandible, is on the film '
                            '(Bontrager; Radiopaedia)', 'medium')
    if 'pelvis' in land:
        cent['pelvis'] = rest_pt(np.array([land['pelvis'][a] for a in 'xyz']), land['pelvis']['how'],
                                 'AP pelvis: CR midway between the ASIS and the symphysis (Bontrager; Radiopaedia)')
    # ---------------------------------------------------------------- palpation
    pal['jugularNotch'] = palp(jn, [0, -1, 0.3], 'Jugular notch', 'the top of the manubrium (the child\'s sternum label)', 'high')
    xi = st[np.argmin(st[:, 2])]
    pal['xiphoid'] = palp(xi, [0, -1, 0], 'Xiphoid process', 'the lowest point of the sternum label', 'medium')
    sa = st[np.abs(st[:, 2] - (jn[2] - 0.3 * (jn[2] - xi[2]))) < 0.3]
    if len(sa):
        pal['sternalAngle'] = palp(sa[np.argmin(sa[:, 1])], [0, -1, 0], 'Sternal angle (T4-T5)',
                                   'the front of the sternum 30 % of the way from the notch to the xiphoid (the manubriosternal joint)', 'low')
    for side, H, sgn, A in (('R', hipR, -1, asis[0]), ('L', hipL, 1, asis[1])):
        c = H[np.argmax(H[:, 2])]
        pal[f'iliacCrest{side}'] = palp(c, [sgn * 0.857, 0, 0.514], f'Iliac crest ({side})', 'the top of the hip-bone label on this side')
        pal[f'asis{side}'] = palp(A, [0, -1, 0], f'ASIS ({side})', 'the most anterior ilium 4-12 cm off the midline, below the crest')
        F = V.pts('femur_right' if side == 'R' else 'femur_left')
        gt = F[np.argmax(sgn * (F[:, 0] - mid_x))]
        pal[f'trochanter{side}'] = palp(gt, [sgn, 0, 0], f'Greater trochanter ({side})', 'the most lateral point of the child\'s femur label')
    if sym is not None:
        pal['symphysis'] = palp(sym, [0, -1, 0], 'Pubic symphysis', 'the lowest midline anterior point of the hip bones')
    c1 = V.pts('vertebrae_C1'); yc1 = c1[:, 1].mean()
    for side, sgn in (('R', -1), ('L', 1)):
        m = sk[(sgn * (sk[:, 0] - mid_x) > 3.5) & (sk[:, 1] > yc1)]
        if len(m):
            pal[f'mastoid{side}'] = palp(m[np.argmin(m[:, 2])], [sgn, 0.3, -0.3], f'Mastoid tip ({side})',
                                         'the lowest skull behind the atlas, 3.5 cm or more from the midline', 'high')
        j = sk[(sgn * (sk[:, 0] - mid_x) > 2.5) & (sk[:, 1] < yc1 - 1)]
        if len(j):
            low = j[j[:, 2] < j[:, 2].min() + 1.3]
            pal[f'gonion{side}'] = palp(low[np.argmax(low[:, 1])], [sgn, 0, -0.5], f'Angle of the mandible ({side})',
                                        'the most posterior point of the lowest 1.3 cm of the jaw on this side')
    md = sk[np.abs(sk[:, 0] - mid_x) < 1.0]
    pal['inion'] = palp(md[np.argmax(md[:, 1])], [0, 1, 0], 'External occipital protuberance', 'the most posterior midline point of the skull')
    c7 = V.pts('vertebrae_C7')
    pal['vertebraProminens'] = palp(c7[np.argmax(c7[:, 1])], [0, 1, 0], 'Vertebra prominens (C7)', 'the most posterior point of the C7 label', 'high')
    # ---------------------------------------------------------------- the grafted limbs' joints
    # carried from their donors by the builder (build_pediatric.compose writes them, volume frame)
    jp = json.loads((LABELS.parent / f'{NAME}_points.json').read_text(encoding='utf-8'))
    how = {'knee': "the knee joint space, the lower extremity's measured landmark carried through the leg's graft",
           'ankle': "the tibiotalar joint, the lower extremity's measured landmark carried through the leg's graft",
           'elbow': "the centre of the arm's bone at the elbow joint (z053, build_limbs.ARMS), carried through the arm's graft",
           'wrist': "the centre of the carpus (z053, 1.2 cm below the radiocarpal joint), carried through the arm's graft"}
    for k, v in jp.items():
        land[k] = vol_pt(v, how[k[:-1]], 'medium')
    return land, cent, pal


def main():
    land, cent, pal = measure()
    # each file as its own tool writes it (measure_landmarks: indent 2; centring and palpation: indent 1)
    for fn, part, kw in (('landmarks.json', land, dict(indent=2)), ('centring.json', cent, dict(indent=1, ensure_ascii=False)),
                         ('palpation.json', pal, dict(indent=1, ensure_ascii=False))):
        p = DATA / fn
        d = json.loads(p.read_text(encoding='utf-8'))
        d[NAME] = part
        p.write_text(json.dumps(d, **kw) + '\n', encoding='utf-8')
        for k, v in part.items():
            print(f'{fn[:-5]:10s} {k:16s} x {v["x"]:+7.2f}  y {v["y"]:+7.2f}  z {v["z"]:+7.2f}  [{v.get("confidence")}]')


if __name__ == '__main__':
    main()
