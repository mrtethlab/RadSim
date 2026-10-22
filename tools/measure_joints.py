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
    toes = toes.round(3).tolist()
    out['lowerextremity'] = {
        'knee': {'label': 'Knee', 'c': [round(float(kn[0]), 2), round(float(kn[1]), 2), round(float(kn[2]), 2)],
                 'distal': leg, 'blend': 2.0,
                 'how': 'the measured joint space between the femoral condyles and the tibial plateau',
                 'motions': [{'key': 'knee.flex', 'label': 'Flexion', 'neg': 'extension', 'pos': 'flexion', 'toward': [0, -1, 0], 'range': [0, 120]},
                             # internal rotation turns the front of the leg toward the midline (-x: a right leg)
                             {'key': 'knee.roll', 'label': 'Rotation', 'neg': 'external', 'pos': 'internal', 'roll': True,
                              'from': [0, 1, 0], 'toward': [-1, 0, 0], 'range': [-40, 40]}]},
        # the foot is the part past a plane through the ankle tilted toward it (down the leg, and 0.4
        # of the way along the foot): a plane square to the leg did for a foot hanging down it, but a
        # foot at 90 degrees reaches forward at the ankle's own height, half of it inside the crease,
        # and a bend fanned it out by height
        'ankle': {'label': 'Ankle', 'c': v3(im), 'distal': perp_none(lg + 0.4 * np.array(toes)), 'blend': 1.5,
                  'how': f'midway between the malleoli; dorsiflexion turns the foot (its long axis, {toes}) toward the shin; at rest it is {-rest:.0f} degrees plantarflexed and turned {turn:.0f} degrees (internal +)',
                  'motions': [{'key': 'ankle.flex', 'label': 'Dorsiflexion', 'neg': 'plantarflexion', 'pos': 'dorsiflexion',
                               'from': toes, 'toward': [0, 0, 1], 'range': [-80, 20], 'rest': rest},
                              dict({'key': 'ankle.roll', 'label': 'Rotation', 'neg': 'external', 'pos': 'internal', 'roll': True,
                                    'from': [0, 1, 0], 'toward': [-1, 0, 0], 'range': [-40, 40]}, **({'rest': turn} if abs(turn) > 0.5 else {}))]},
    }
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    for s, js in out.items():
        if s.startswith('_'): continue
        for k, j in js.items():
            print(f'{s:16s} {k:6s} c {j["c"]}  motions {[m["key"] for m in j["motions"]]}')
    print('wrote', OUT)


if __name__ == '__main__':
    main()
