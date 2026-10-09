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
    bone = np.isin(vol, [m['id'] for m in h['materials'] if 'bone' in m['name'].lower()])
    return h, vol, bone, sp


def main_component(bone):
    lab, n = ndi.label(bone)
    sizes = ndi.sum(bone, lab, range(1, n + 1))
    return lab == (int(np.argmax(sizes)) + 1)


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
    knee, prom = valley(p, sp, 50, 63)
    ankle = bulge(p, sp, 9, 21)
    hip = bulge(p, sp, 92, 103)
    femur = (knee + hip) // 2
    foot = int(5.0 / sp[2])
    return {
        'knee': mark(m, knee, sp, f'joint-space valley between the condyles and the plateau (prominence {prom:.1f} cm2)', 'high'),
        'ankle': mark(m, ankle, sp, 'peak of the malleolar bulge — the clinical centring point, midway between the malleoli; '
                                     'tibia and talus are fused in the segmentation, so there is no joint-space dip to find', 'medium'),
        'hip': mark(m, hip, sp, 'peak of the proximal bulge: femoral head and trochanters', 'medium'),
        'femur': mark(m, femur, sp, 'midway between the knee and hip landmarks', 'medium'),
        'foot': mark(m, foot, sp, 'tarsals, 5 cm above the inferior end — the foot points anteriorly in this supine leg', 'low'),
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
    """The arm is counted too. The forearm is the one stretch where every slice cuts exactly TWO
    bones — radius and ulna — and it is bounded by one-bone zones: the carpals distally and the
    condyles and olecranon proximally. The area profile alone put the elbow 8.5 cm too high, on
    the distal humeral shaft; the count puts it where the two forearm bones end."""
    h, vol, bone, sp = load('upperextremity')
    m = main_component(bone); p = profile(m, sp)
    counts = ndi.median_filter(bones_per_slice(m, sp), size=5)       # ignore single-slice glitches
    best, cur = (0, 0), None
    for z, c in enumerate(list(counts) + [0]):
        if c == 2 and cur is None:
            cur = z
        elif c != 2 and cur is not None:
            if z - cur > best[1] - best[0]:
                best = (cur, z - 1)
            cur = None
    f0, f1 = best                                                    # the forearm (two-bone) zone
    # The elbow is centred at the EPICONDYLES, the widest the distal humerus gets — not where the
    # forearm bones end, which is the radial head and measured ~3 cm low on the rendered film.
    # Search the 8 cm above the forearm for the slice with the widest mediolateral bone span.
    def span(z):
        xs = np.nonzero(m[z].any(axis=0))[0]
        return (xs.max() - xs.min()) if len(xs) else 0
    zr = range(f1, min(m.shape[0], f1 + int(8.0 / sp[2])))
    elbow = max(zr, key=span)
    wrist = max(0, f0 - int(1.5 / sp[2]))
    shoulder = bulge(p, sp, 58, 67)
    return {
        'elbow': mark(m, elbow, sp, f'widest mediolateral span of the distal humerus within 8 cm above the forearm (which ends at {f1 * sp[2]:.1f} cm): the epicondyles', 'high'),
        'forearm': mark(m, (f0 + f1) // 2, sp, 'middle of the two-bone (radius + ulna) zone', 'high'),
        'wrist': mark(m, wrist, sp, '1.5 cm distal of where the two forearm bones begin: the carpals', 'medium'),
        'shoulder': mark(m, shoulder, sp, 'peak of the proximal bulge: humeral head', 'medium'),
        'humerus': mark(m, (elbow + shoulder) // 2, sp, 'midway between the elbow and shoulder landmarks', 'medium'),
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
    return {
        'skull': mark(bone, zc, sp, 'bone-weighted centre of the upper half (the cranium)', 'medium'),
        'cspine': mark(bone, neck, sp, 'narrowest bone section between the skull and the shoulders: mid-cervical; the island nearest the midline', 'medium', prefer='midline'),
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


def main():
    out = {
        '_about': ('Anatomical centring landmarks for the x-ray protocols, measured by tools/measure_landmarks.py. '
                   'Volume-frame entries are cm from the volume centre (x, y, z; +z superior) and are mapped to the '
                   'world through the same flips and rotation as the phantom. Entries marked frame:"world" are '
                   'already in the x-ray world frame. Re-run the tool after rebuilding a model.'),
        'lowerextremity': lower_extremity(),
        'upperextremity': upper_extremity(),
        'hand': hand(),
        'headneck': head_neck(),
        'chestabdopelvis': {**chest_abdo_pelvis(), **femoral_heads(*load('chestabdopelvis')[1::2])},
    }
    OUT.write_text(json.dumps(out, indent=2) + '\n', encoding='utf-8')
    for model, lm in out.items():
        if model.startswith('_'):
            continue
        for k, v in lm.items():
            if not k.startswith('_'):
                print(f'{model:16} {k:13} z {v["z"]:+7.2f}  x {v.get("x", 0):+6.2f}  [{v.get("confidence", "-")}]')
    print('wrote', OUT.relative_to(ROOT))


if __name__ == '__main__':
    main()
