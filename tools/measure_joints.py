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


def radial_side(V, z):
    """+1 or -1: which way (x) the radius lies from the ulna, from the two forearm bones at level z
    (the radius is the wider bone toward the wrist)"""
    k = V.idx(2, z)
    lab, n = ndi.label(V.bone[k])
    if n < 2:
        return None
    sizes = ndi.sum(V.bone[k], lab, range(1, n + 1))
    order = np.argsort(sizes)[::-1][:2]
    cs = [ndi.center_of_mass(V.bone[k], lab, int(o) + 1) for o in order]
    return 1 if cs[0][1] > cs[1][1] else -1


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
    rad = radial_side(V, wr[2] + 3.0)
    ec = np.array([el[0], el[1], el[2] - 1.5])
    fore = np.array(wr) - ec                                    # the forearm's axis, elbow to wrist
    fore = (fore / np.linalg.norm(fore)).round(3).tolist()
    arm = {'elbow': {
        'label': 'Elbow', 'c': [round(float(c), 2) for c in ec],
        # only the forearm moves: the arm lies against the flank in this CT, and the crop carries it
        'distal': fore, 'blend': 1.5, 'radius': 6.0,
        'how': 'the trochlea/capitulum axis, 1.5 cm distal of the widest span of the epicondyles',
        'motions': [{'key': 'elbow.flex', 'label': 'Flexion', 'neg': 'extension', 'pos': 'flexion', 'toward': [0, 1, 0], 'range': [0, 140]}]}}
    if rad is not None:
        arm['wrist'] = {
            'label': 'Wrist', 'c': [round(float(wr[0]), 2), round(float(wr[1]), 2), round(float(wr[2] + 0.5), 2)],
            'distal': [0, 0, -1], 'blend': 1.0, 'radius': 6.0,
            'how': 'the carpus, 0.5 cm proximal of the carpal landmark; the radius side from the wider of the two forearm bones 3 cm above',
            'motions': [{'key': 'wrist.dev', 'label': 'Deviation', 'neg': 'radial', 'pos': 'ulnar', 'toward': [-rad, 0, 0], 'range': [-20, 35]}]}
    out['upperextremity'] = arm
    # ---- the leg: knee and ankle
    kn = lm('lowerextremity', 'knee')
    im = CENT['lowerextremity']['intermalleolar']
    leg = np.array(v3(im)) - np.array(kn)                        # the leg's axis, knee to ankle
    leg = (leg / np.linalg.norm(leg)).round(3).tolist()
    foot = lm('lowerextremity', 'foot')
    toes = np.array(foot) - np.array(v3(im))
    toes = (toes / np.linalg.norm(toes)).round(3).tolist()
    out['lowerextremity'] = {
        'knee': {'label': 'Knee', 'c': [round(float(kn[0]), 2), round(float(kn[1]), 2), round(float(kn[2]), 2)],
                 'distal': leg, 'blend': 2.0, 'radius': 9.0,
                 'how': 'the measured joint space between the femoral condyles and the tibial plateau',
                 'motions': [{'key': 'knee.flex', 'label': 'Flexion', 'neg': 'extension', 'pos': 'flexion', 'toward': [0, -1, 0], 'range': [0, 120]}]},
        'ankle': {'label': 'Ankle', 'c': v3(im), 'distal': [0, 0, -1], 'blend': 1.5, 'radius': 14.0,
                  'how': 'midway between the malleoli; dorsiflexion turns the foot (pointing ' + str(toes) + ' from the ankle) toward the shin',
                  'motions': [{'key': 'ankle.flex', 'label': 'Dorsiflexion', 'neg': 'plantarflexion', 'pos': 'dorsiflexion',
                               'from': toes, 'toward': [0, 0, 1], 'range': [-45, 30]}]},
    }
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    for s, js in out.items():
        if s.startswith('_'): continue
        for k, j in js.items():
            print(f'{s:16s} {k:6s} c {j["c"]}  motions {[m["key"] for m in j["motions"]]}')
    print('wrote', OUT)


if __name__ == '__main__':
    main()
