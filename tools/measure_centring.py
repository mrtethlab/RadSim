"""Measure the CENTRING points the textbooks name, on each model, for the Trainer.

    python tools/measure_palpation.py        # first: the bony landmarks this builds on
    python tools/measure_centring.py         # writes apps/web/src/data/centring.json

The Trainer marks centring against the point Bontrager/Lampignano (Textbook of Radiographic
Positioning), McQuillen Martensen (Radiographic Image Analysis) and Radiopaedia give for each
view — the 3rd MCP JOINT for a PA hand, not "the hand"; midway between the malleoli for an AP
ankle; T7 for a chest. Each point is measured on the model's own bone (or skin, for planes) in
the x-ray rest frame (x = patient's right, y = anterior, z = superior; on the hand y = dorsal,
z = toward the fingertips), as cm from the volume centre, and carries how it was found and the
guideline it stands for.
"""
import json, pathlib, sys
import numpy as np
from scipy import ndimage as ndi

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from measure_palpation import Vol, lm, extreme, zband, xband, foot_axis, ROOT

OUT = ROOT / 'apps' / 'web' / 'src' / 'data' / 'centring.json'
PALP = json.loads((ROOT / 'apps' / 'web' / 'src' / 'data' / 'palpation.json').read_text(encoding='utf-8'))


def pt(p, how, guide, sure='medium'):
    return {'x': round(float(p[0]), 2), 'y': round(float(p[1]), 2), 'z': round(float(p[2]), 2),
            'how': how, 'guide': guide, 'confidence': sure}


def P(subject, key):
    v = PALP[subject][key]
    return np.array([v['x'], v['y'], v['z']], float)


def bone_profile(V, x0, x1, z0, z1):
    """bone voxels per slice in an x window, for z from z0 to z1: (z_cm array, count array)"""
    k0, k1 = sorted((V.idx(2, z0), V.idx(2, z1)))
    i0, i1 = sorted((V.idx(0, x0), V.idx(0, x1)))
    ks = np.arange(max(0, k0), min(V.n[2], k1 + 1))
    counts = np.array([V.bone[k, :, max(0, i0):i1 + 1].sum() for k in ks])
    zs = (ks - (V.n[2] - 1) / 2) * V.sp[2]
    return zs, counts


def bone_centre_y(V, x, z, half=0.5):
    """mid-depth of the bone at (x, z): the centre of the bone's dorsopalmar (or AP) extent"""
    k = V.idx(2, z)
    i0, i1 = sorted((V.idx(0, x - half), V.idx(0, x + half)))
    jj = np.nonzero(V.bone[k, :, max(0, i0):i1 + 1].any(axis=1))[0]
    if not len(jj):
        return 0.0
    return float(((jj.min() + jj.max()) / 2 - (V.n[1] - 1) / 2) * V.sp[1])


def midcoronal_y(V, z, half=2.0):
    """the midcoronal plane at a level: halfway between the front and back of the body at the midline"""
    k = V.idx(2, z)
    i0, i1 = sorted((V.idx(0, -half), V.idx(0, half)))
    jj = np.nonzero((V.v[k, :, max(0, i0):i1 + 1] > 0).any(axis=1))[0]
    return float(((jj.min() + jj.max()) / 2 - (V.n[1] - 1) / 2) * V.sp[1])


# ---------------------------------------------------------------- hand and wrist
def hand():
    V = Vol('hand').main_bone()
    out = {}
    for key, name, ray in (('mcp3Joint', '3rd MCP joint', 'mcp3'), ('mcp2Joint', '2nd MCP joint', 'mcp2')):
        head = P('hand', ray)
        # along the ray: the metacarpal head (bone peak), the joint space (the dip), the base of the
        # proximal phalanx (the next rise). The palpation point sits at the joint already (measured
        # profile on the 3rd ray: peak 2.3, dip 2.6-3.1, rise at 3.2 cm), so the deepest dip within
        # 1 cm either side of it. (Searching 2.5 cm DISTAL found the next joint along.)
        zs, c = bone_profile(V, head[0] - 0.45, head[0] + 0.45, head[2] - 1.0, head[2] + 1.0)
        zj = float(zs[int(np.argmin(c))])
        out[key] = pt([head[0], bone_centre_y(V, head[0], zj), zj],
            f'the joint space along the {name[:3]} ray: the deepest dip in bone between the metacarpal head and the proximal phalanx',
            f'{"PA and PA oblique hand" if key == "mcp3Joint" else "Lateral hand"}: CR perpendicular to the {name} (Bontrager; Radiopaedia)')
    # the midcarpal area: the middle of the carpus (radiocarpal joint to the carpometacarpal joints),
    # on the line of the 3rd metacarpal, which the capitate continues
    wrist = lm('hand', 'wrist')
    m3 = P('hand', 'mcp3')
    zc = wrist[2]
    out['midcarpal'] = pt([m3[0], bone_centre_y(V, m3[0], zc), zc],
        'the middle of the carpus (the midcarpal landmark: 2 cm proximal of the carpometacarpal level), on the line of the 3rd metacarpal (the capitate)',
        'PA, PA oblique and lateral wrist: CR perpendicular to the midcarpal area (Bontrager; Radiopaedia)')
    # THE ALIGNMENT AXES. A PA hand or wrist is judged on the long axis of the 3rd metacarpal lying
    # in line with the forearm (the distal radius): McQuillen Martensen; Bontrager's evaluation
    # criteria. The 3rd metacarpal runs from its base (the bone on its ray at the carpometacarpal
    # level, 2 cm distal of the midcarpal landmark) to the MCP joint; the radius from the centroid
    # of its shaft 5 cm proximal of the radiocarpal joint to 2 cm proximal of it (the radius is the
    # larger of the two forearm bones there).
    zb = wrist[2] + 2.0
    kb = V.idx(2, zb)
    jj, ii = np.nonzero(V.bone[kb])
    if len(ii):
        x = (ii - (V.n[0] - 1) / 2) * V.sp[0]
        y = (jj - (V.n[1] - 1) / 2) * V.sp[1]
        sel = np.abs(x - m3[0]) <= 0.7
        if sel.any():
            out['mc3Base'] = pt([float(x[sel].mean()), float(y[sel].mean()), zb],
                'the 3rd metacarpal at the carpometacarpal level: bone within 0.7 cm of the 3rd ray',
                '3rd metacarpal axis (base to MCP joint), for the hand/wrist alignment criterion')
    jr = wrist[2] - 2.2
    for key, dz in (('radiusDistal', -2.0), ('radiusProx', -5.0)):
        k = V.idx(2, jr + dz)
        lab, n = ndi.label(V.bone[k])
        if n:
            sz = ndi.sum(V.bone[k], lab, range(1, n + 1))
            c = ndi.center_of_mass(V.bone[k], lab, int(np.argmax(sz)) + 1)
            out[key] = pt([(c[1] - (V.n[0] - 1) / 2) * V.sp[0], (c[0] - (V.n[1] - 1) / 2) * V.sp[1], jr + dz],
                f'the centroid of the radius (the larger forearm bone) {-dz:.0f} cm proximal of the radiocarpal joint',
                'distal radius axis, for the hand/wrist alignment criterion')
    # the scaphoid: the radial-most bone of the proximal carpal row, about 1 cm distal to the
    # radiocarpal joint (2.2 cm proximal of the midcarpal landmark on this hand)
    joint = wrist[2] - 2.2
    zs = joint + 1.0
    rs = P('hand', 'radialStyloid')
    radial = 1 if rs[0] > m3[0] else -1
    # the carpus is one island at this level in the segmentation, so the scaphoid is taken as the
    # radial-most 1.5 cm of carpal bone in the proximal row
    k = V.idx(2, zs)
    jj, ii = np.nonzero(V.bone[k])
    if len(ii):
        x = (ii - (V.n[0] - 1) / 2) * V.sp[0]
        y = (jj - (V.n[1] - 1) / 2) * V.sp[1]
        edge = x.max() if radial > 0 else x.min()
        sel = (radial * (edge - x)) <= 1.5
        out['scaphoid'] = pt([float(x[sel].mean()), float(y[sel].mean()), zs],
            'the radial-most 1.5 cm of carpal bone 1 cm distal to the radiocarpal joint: the scaphoid',
            'PA axial scaphoid: CR 10-15 degrees proximally, toward the elbow, to the scaphoid, hand in ulnar deviation (Bontrager; Radiopaedia)')
    return out


# ---------------------------------------------------------------- ankle
def lower_extremity():
    mm, lmal = P('lowerextremity', 'medialMalleolus'), P('lowerextremity', 'lateralMalleolus')
    mid = (mm + lmal) / 2
    out = {
        'intermalleolar': pt(mid, 'midway between the measured medial and lateral malleoli',
            'AP, AP mortise and AP oblique ankle: CR perpendicular to a point midway between the malleoli (Bontrager; Radiopaedia)'),
        'medialMalleolus': pt(mm, 'the medial malleolus (palpation landmark)',
            'Lateral (mediolateral) ankle: CR perpendicular to the medial malleolus (Bontrager)'),
    }
    # the base of the 3rd metatarsal, along the foot's own axis (ankle to the tip of the toes): the
    # metatarsal bases lie a little under half way, the 3rd in the middle of the foot's width there
    V = Vol('lowerextremity').main_bone()
    lateral = 1 if lmal[0] > mm[0] else -1
    fa = foot_axis(V, lm('lowerextremity', 'ankle'), lateral)
    if fa is not None:
        t, L, u, x, y, z = fa
        band = (t > 0.43 * L) & (t < 0.51 * L)
        xb = x[band]
        lo, hi = np.percentile(xb, 33), np.percentile(xb, 67)
        sel = band.copy(); sel[band] = (xb >= lo) & (xb <= hi)
        out['mt3Base'] = pt([x[sel].mean(), y[sel].mean(), z[sel].mean()],
            f'the middle third of the foot bone 43-51 % of the way from the ankle to the tip of the toes ({L:.1f} cm): the base of the 3rd metatarsal',
            'AP foot: CR 10 degrees toward the heel to the base of the 3rd metatarsal; AP medial oblique foot: CR perpendicular to the base of the 3rd metatarsal (Bontrager; Radiopaedia)')
        # the medial cuneiform lies proximal of the metatarsal bases, about 2 cm back along the foot.
        # Centred on the 3rd metatarsal a third of the way forward, a lateral foot's 30 cm field fell
        # short of the heel; on the cuneiform it holds heel to toes
        c = np.array([x[sel].mean(), y[sel].mean(), z[sel].mean()]) - 2.0 * u
        out['medialCuneiform'] = pt(c, 'the base of the 3rd metatarsal less 2 cm along the foot (toward the heel): the cuneiforms',
            'Lateral (mediolateral) foot: CR perpendicular to the medial cuneiform, at the level of the base of the 3rd metatarsal (Bontrager)')
        # the 3rd metatarsophalangeal joint: along the 3rd ray (the middle fifth of the foot's width
        # at each step down its axis) the bone thins to a gap between the metatarsal head and the
        # proximal phalanx, 65-85 % of the way to the tip of the toes (the phalanges beyond it are
        # 3-4 cm, a 3rd toe's length)
        step = 0.25
        edges = np.arange(0.65 * L, 0.85 * L, step)
        def ray(a):
            band = (t >= a) & (t < a + step); xb = x[band]
            if len(xb) < 5:
                return None, 0
            sel = band.copy(); sel[band] = (xb >= np.percentile(xb, 40)) & (xb <= np.percentile(xb, 60))
            return sel, int(sel.sum())
        counts = [ray(a)[1] for a in edges]
        a = edges[int(np.argmin(ndi.uniform_filter1d(np.array(counts, float), 3)))]
        sel = ray(a)[0]
        if sel is not None:
            out['mtp3Joint'] = pt([x[sel].mean(), y[sel].mean(), z[sel].mean()],
                f'the gap along the 3rd ray between the metatarsal head and the proximal phalanx, {a / L * 100:.0f} % of the way to the tip of the toes',
                'AP toes: CR 10-15 degrees toward the heel to the 3rd MTP joint (all toes); AP oblique toes: CR perpendicular to it (Bontrager; Radiopaedia)')
    # the calcaneus: the textbook's point 2.5 cm below the medial malleolus is the surface rule for
    # its body; measured, straight down from this malleolus is soft tissue (the heel lies behind).
    # The body itself: the bone behind the ankle (posterior of the point midway between the
    # malleoli) and 2-8 cm below the medial malleolus, its centroid
    k, j, i = np.nonzero(V.bone)
    X, Y, Z = (i - (V.n[0] - 1) / 2) * V.sp[0], (j - (V.n[1] - 1) / 2) * V.sp[1], (k - (V.n[2] - 1) / 2) * V.sp[2]
    # (from 2 cm under the malleolus, below the subtalar joint: just under it, the talus's posterior
    # process lies behind the ankle too and lifted the centroid to the calcaneus's top)
    heel = (Y < mid[1] - 0.5) & (Z < mm[2] - 2.0) & (Z > mm[2] - 8)
    if heel.any():
        out['calcaneus'] = pt([X[heel].mean(), Y[heel].mean(), Z[heel].mean()],
            'the bone behind the ankle and below the medial malleolus, its centroid: the body of the calcaneus',
            'Lateral calcaneus: CR perpendicular to a point 2.5 cm inferior to the medial malleolus (the calcaneal body); axial (plantodorsal) calcaneus: CR 40 degrees cephalad to the long axis of the foot (Bontrager)')
    return out


# ---------------------------------------------------------------- elbow
def upper_extremity():
    me, le = P('upperextremity', 'medialEpicondyle'), P('upperextremity', 'lateralEpicondyle')
    mid = (me + le) / 2
    return {
        'elbowJoint': pt([mid[0], mid[1], mid[2] - 1.5], 'the elbow joint: 1.5 cm distal of the midpoint of the measured epicondyles',
            'AP, AP obliques and lateral elbow: CR perpendicular to the mid elbow joint (Bontrager; Radiopaedia)'),
    }


# ---------------------------------------------------------------- cervical spine
def head_neck():
    """The cervical centring points on the vertebral bodies, from the head CT's own labels
    (measure_landmarks.vertebrae_from_labels; the head & neck volume is already in the rest frame)."""
    import measure_landmarks as ML
    h, vol, bone, sp = ML.load('headneck')
    v = ML.vertebrae_from_labels(bone, sp)
    if not v:
        return {}
    at = lambda k: np.array([v[k]['x'], v[k]['y'], v[k]['z']])
    c12 = (at('C1') + at('C2')) / 2
    c7t1 = (at('C7') + at('T1')) / 2
    return {
        'C4': pt(at('C4'), 'the body of C4, from the vertebra labels of the CT (s1082)',
            'AP axial cervical: CR 15-20 degrees cephalad to C4, the lower margin of the thyroid cartilage; lateral cervical: CR to C4; '
            'AP (posterior) obliques: CR 15-20 degrees cephalad to C4 (Bontrager; Radiopaedia)', 'high'),
        'C1C2': pt(c12, 'midway between the bodies of C1 and C2: the dens and the atlas',
            'AP open mouth (C1-C2): CR perpendicular through the centre of the open mouth, to C1-C2 (Bontrager; Radiopaedia)', 'high'),
        'C7T1': pt(c7t1, 'midway between the bodies of C7 and T1: the cervicothoracic junction',
            'Swimmers lateral (cervicothoracic): CR to C7-T1, about 2.5 cm above the jugular notch (Bontrager; Radiopaedia)', 'high'),
    }


# ---------------------------------------------------------------- the skull
def skull():
    """The skull views' points (tools/skull_points.py), in the rest frame. The model lies with the OML
    square to its long axis (services/compute/app/build_skull.py), so a view's angle to the OML is
    its central ray's angle."""
    import skull_points as K
    p, _ = K.points()
    eam = p['earMid']
    lat = eam + np.array([0, 0, 5.0])
    return {
        'nasion': pt(p['nasion'], 'the nasion: on the midline front profile 12 mm above the orbits\' openings',
            'PA skull: CR perpendicular to the IR, OML perpendicular, exiting the nasion; PA axial (Caldwell): CR 15 degrees caudad '
            'to the OML, exiting the nasion; AP skull: CR perpendicular, entering the nasion (Bontrager; Radiopaedia)'),
        'acanthion': pt(p['acanthion'], 'the acanthion: the midline\'s most anterior bone 3.5-6.5 cm below the nasion',
            'Parietoacanthial (Waters): OML 37 degrees to the IR (the mentomeatal line perpendicular), CR perpendicular, exiting the '
            'acanthion (Bontrager; Radiopaedia)'),
        'eam': pt(eam, 'midway between the ear canals (tools/skull_points.py)',
            'AP axial (Towne): CR 30 degrees caudad to the OML, through the level of the EAMs and the foramen magnum, entering about '
            '6 cm above the glabella (Bontrager; Radiopaedia)', 'high'),
        'latSkull': pt(lat, '5 cm superior to the midpoint of the ear canals',
            'Lateral skull: CR perpendicular to a point 5 cm (2 in) superior to the EAM, IOML parallel to the transverse axis of the IR '
            '(Bontrager; Radiopaedia)', 'high'),
        'zygoma': pt(p['zygoma'], 'midway between the orbits\' openings (the outer canthi) and the ear canals',
            'Lateral facial bones and sinuses: CR perpendicular to the zygoma, midway between the outer canthus and the EAM '
            '(Bontrager; Radiopaedia)'),
    }


# ---------------------------------------------------------------- chest and spine
def column_y(V, z):
    """the vertebral column's depth at level z: (front of the body, tip of the spinous process),
    from the largest piece of bone within 4 cm of the midline in a 6 cm slab, which is a whole
    vertebra (body, pedicles and arch) rather than a stray rib, calcified vessel or the sternum"""
    k0, k1 = V.idx(2, z - 3), V.idx(2, z + 3) + 1
    xs = (np.arange(V.n[0]) - (V.n[0] - 1) / 2) * V.sp[0]
    slab = V.bone[k0:k1] & (np.abs(xs) <= 4)[None, None, :]
    lab, n = ndi.label(slab)
    sizes = ndi.sum(slab, lab, range(1, n + 1))
    _, jj, _ = np.nonzero(lab == int(np.argmax(sizes)) + 1)
    ys = (jj - (V.n[1] - 1) / 2) * V.sp[1]
    return float(np.percentile(ys, 99.5)), float(np.percentile(ys, 0.5))


def trunk(name):
    V = Vol(name)
    out = {}
    # T7 is the centre of the lung fields (Bontrager), which is what the PA chest centres on and
    # what 8-10 cm below the jugular notch finds on a typical adult. The lungs are the two largest
    # pieces of lung-density tissue (the label also covers bowel gas, which runs the trunk's length).
    lab, n = ndi.label(V.v == 1)
    sizes = ndi.sum(V.v == 1, lab, range(1, n + 1)) if n else []
    lungs = np.isin(lab, (np.argsort(sizes)[::-1][:2] + 1)) if n else (V.v == 1)
    ks = np.nonzero(lungs.any(axis=(1, 2)))[0]
    zl = (ks - (V.n[2] - 1) / 2) * V.sp[2]
    z7 = float((zl.min() + zl.max()) / 2)
    jn = P(name, 'jugularNotch')
    print(f'  {name}: lungs z {zl.min():.1f}..{zl.max():.1f} -> T7 {z7:.1f}; jugular notch - 9 cm = {jn[2] - 9:.1f}')
    out['T7'] = pt([0, midcoronal_y(V, z7) if name == 'chest' else lm(name, 'thoracic')[1], z7],
        f'T7: the centre of the lung fields (z {zl.min():.1f} to {zl.max():.1f}), on the midsagittal plane'
        + (', at the midcoronal plane' if name == 'chest' else ', at the depth of the vertebral bodies')
        + f'; 9 cm below the jugular notch gives {jn[2] - 9:.1f}',
        'PA chest: CR to the midsagittal plane at T7, the centre of the lung fields; AP thoracic spine: CR to T7, 8-10 cm below the jugular notch (Bontrager; Radiopaedia)')
    out['T7mc'] = pt([0, midcoronal_y(V, z7), z7], 'T7 (as above) on the midcoronal plane: halfway between the front and back of the body at the midline',
        'Lateral chest: CR to the midcoronal plane at T7 (Bontrager; Radiopaedia)')
    if name == 'chestabdopelvis':
        zc = (P(name, 'iliacCrestR')[2] + P(name, 'iliacCrestL')[2]) / 2
        out['crest'] = pt([0, lm(name, 'lumbar')[1], zc],
            'the level of the iliac crests (mean of the two measured crests), midsagittal, at the depth of the vertebral bodies',
            'AP lumbar spine (35 x 43 cm): CR to the level of the iliac crest, L4-L5 (Bontrager; Radiopaedia)')
        out['crestMc'] = pt([0, midcoronal_y(V, zc), zc], 'the level of the iliac crests on the midcoronal plane',
            'Lateral lumbar spine (35 x 43 cm): CR to the level of the iliac crest (L4-L5), centred to the midcoronal plane (Bontrager)')
        # The spine laterals centre on the column itself. On an average adult the midcoronal plane
        # runs through the vertebral bodies; this patient's abdomen is deep enough that the skin's
        # midpoint lies in front of them, and a field centred there must open twice as wide. The
        # column curves (lordosis, kyphosis), so the depth is the middle of its span over the
        # section the film shows: L1 to S1 (the crest is L4-L5; about 4 cm a level), and T3 to T12
        # (T1-T3 hide behind the shoulders on a lateral: that is the swimmer's view).
        for key, zz, z0, z1, lvl, guide in (
                ('crestCol', zc, zc - 4.5, zc + 13, 'the level of the iliac crests (L4-L5)',
                 'Lateral lumbar spine: CR to the level of the iliac crest (L4-L5), centred on the vertebral column (the midcoronal plane on an average adult); collimate to about 20 cm wide, 1" beyond the bodies and spinous processes (Bontrager; Radiopaedia)'),
                ('T7col', z7, z7 - 13, z7 + 9.5, 'T7 (the centre of the lung fields)',
                 'Lateral thoracic spine: CR to T7, centred on the vertebral column; collimate long and narrow to the column (Bontrager; Radiopaedia)')):
            spans = [column_y(V, z) for z in np.arange(z0, z1 + 0.01, 1.0)]
            front, back = max(f for f, _ in spans), min(b for _, b in spans)
            print(f'  {name}: column {key} z {z0:.1f}..{z1:.1f}: front of the bodies y {front:.1f}, spinous tips y {back:.1f}')
            out[key] = pt([0, round((front + back) / 2, 2), zz],
                f'{lvl}, midsagittal, at the middle of the depth of the vertebral column from z {z0:.1f} to {z1:.1f}: '
                f'front of the bodies y {front:.1f}, spinous tips y {back:.1f} (largest vertebra in a 6 cm slab, every 1 cm)', guide)
    return out


# ---------------------------------------------------------------- the hospital protocol views
# The views the Protocol Trainer's hospital table adds (apps/web/src/trainer/hospitalProtocols.js):
# the leg, the clavicle, the soft-tissue neck, the sacrum and coccyx, the ribs. Measured on their
# own and merged into each model's set (`python tools/measure_centring.py added`), so a model whose
# own points need inputs a checkout may lack (the head CT's vertebra labels) keeps them.
def leg_points():
    V = Vol('lowerextremity').main_bone()
    knee, ankle = lm('lowerextremity', 'knee'), lm('lowerextremity', 'ankle')
    z = (knee[2] + ankle[2]) / 2
    x, y, _ = V.coords(V.bone & zband(V, z - 0.25, z + 0.25))
    return {'legMid': pt([x.mean(), y.mean(), z],
        f'midway between the knee joint and the tibiotalar joint ({knee[2]:.1f} / {ankle[2]:.1f}), the centre of the tibia and fibula\'s section there',
        'AP, AP obliques and lateral tibia/fibula: CR perpendicular to the mid-point of the leg, both joints on the receptor (Bontrager; Radiopaedia)')}


def neck_points():
    """The right clavicle and the ear canals on the head and neck model (no vertebra labels needed)."""
    V = Vol('headneck')
    out = {}
    # THE CLAVICLE. Laterally it is the topmost bone in front of the vertebral bodies' plane (the first
    # rib arches below it, the acromion and the scapula's border lie behind). At 9.5 cm right of the
    # midline, half way out from the sternoclavicular joint (2 cm off the midline) to the
    # acromioclavicular (17 cm): the centroid of the bone in its top 1.6 cm there
    c4 = C_OLD['headneck']['C4']
    x, y, z = V.coords(V.bone & xband(V, 9.0, 10.0) & zband(V, -18, -8))
    front = y > c4['y'] + 1.0
    top = z[front].max()
    sel = front & (z >= top - 1.6)
    out['clavicleR'] = pt([9.5, y[sel].mean(), z[sel].mean()],
        f'the right clavicle half way along it (9.5 cm right of the midline): the centroid of the topmost bone in front of the vertebral bodies (top at z {top:.1f})',
        'AP and AP axial clavicle: CR to the mid-clavicle (Bontrager; Radiopaedia)')
    # THE EAR CANALS: air enclosed by tissue above, below, in front and behind (within 1.2 cm), beside
    # each mastoid process and level with or above its tip; the largest such piece each side
    air = V.v == 0
    r = int(round(1.2 / V.sp[0]))
    enclosed = air.copy()
    for ax in (0, 1):
        for s in (1, -1):
            hit = np.zeros_like(air)
            for d in range(1, r + 1):
                hit |= np.roll(~air, s * d, axis=ax)
            enclosed &= hit
    ears = []
    for side in ('mastoidR', 'mastoidL'):
        m = P('headneck', side)
        cx, cy, cz = V.coords(enclosed)
        sel = (np.abs(cz - m[2] - 1.5) < 2.5) & (np.abs(cy - m[1] - 0.5) < 2.5) & (np.sign(cx) == np.sign(m[0])) & (np.abs(cx) > 3) & (np.abs(cx) < 9)
        mask = np.zeros(V.v.shape, bool)
        k, j, i = np.nonzero(enclosed)
        mask[k[sel], j[sel], i[sel]] = True
        lab, n = ndi.label(mask)
        big = int(np.argmax(ndi.sum(mask, lab, range(1, n + 1)))) + 1
        ex, ey, ez = V.coords(lab == big)
        ears.append(np.array([ex.mean(), ey.mean(), ez.mean()]))
        print(f'  headneck: ear canal beside {side}: ({ex.mean():.2f} {ey.mean():.2f} {ez.mean():.2f})')
    out['eam'] = pt((ears[0] + ears[1]) / 2,
        'midway between the ear canals: the air each side enclosed by tissue within 1.2 cm, beside and above the mastoid tip',
        'Lateral soft-tissue neck (adenoids): CR to the EAM, the nasopharynx in the field (Radiopaedia)', 'high')
    return out


def pelvis_points():
    """The sacrum and coccyx on the trunk: the midline bone behind the pelvis, S1 to the tip."""
    V = Vol('chestabdopelvis')
    zc = (P('chestabdopelvis', 'iliacCrestR')[2] + P('chestabdopelvis', 'iliacCrestL')[2]) / 2
    x, y, z = V.coords(V.bone)
    # the tip: the lowest midline bone behind the pelvis (the symphysis is in front, y > 0)
    back = (np.abs(x) < 1.5) & (y < -5)
    tip = z[back & (z < zc - 10)].min()
    s1 = zc - 5.0                               # the crest is L4-L5; L5 a vertebra (about 4 cm) and a disc below
    sac = (np.abs(x) < 4) & (z <= s1) & (z >= tip + 3.5) & (y < 4)
    coc = back & (z <= tip + 3.5)
    print(f'  chestabdopelvis: S1 top ~{s1:.1f}, coccyx tip {tip:.1f}')
    return {
        'sacrum': pt([0, y[sac].mean(), z[sac].mean()],
            f'the sacrum: the centroid of the bone within 4 cm of the midline from S1 (z {s1:.1f}, 5 cm below the crests) to the coccyx (3.5 cm above its tip)',
            'AP axial sacrum: CR 15 degrees cephalad, entering 5 cm superior to the symphysis pubis; lateral sacrum: CR to the sacrum, 8-10 cm posterior to the ASIS (Bontrager; Radiopaedia)'),
        'coccyx': pt([0, y[coc].mean(), z[coc].mean()],
            f'the coccyx: the centroid of the midline bone behind the pelvis in the 3.5 cm above its tip (z {tip:.1f})',
            'AP axial coccyx: CR 10 degrees caudad, entering 5 cm superior to the symphysis pubis (Bontrager; Radiopaedia)'),
    }


def rib_points():
    V = Vol('chest')
    z7 = C_OLD['chest']['T7']['z']
    x, _, _ = V.coords(V.bone & zband(V, z7 - 0.5, z7 + 0.5))
    edge = float(x.max())
    return {'ribsR': pt([edge / 2, midcoronal_y(V, z7), z7],
        f'midway between the midsagittal plane and the right lateral margin of the ribs ({edge:.1f} cm) at T7, on the midcoronal plane',
        'Ribs above the diaphragm, PA and AP obliques: CR midway between the midsagittal plane and the lateral margin of the affected side, at T7 (Bontrager)')}


C_OLD = json.loads(OUT.read_text(encoding='utf-8')) if OUT.exists() else {}
ADDED = {'lowerextremity': leg_points, 'headneck': neck_points, 'chestabdopelvis': pelvis_points, 'chest': rib_points}


def main(only=None):
    """Every model, or only those named; the others keep what the file already has. 'added': only the
    hospital protocol points, merged into what each model has."""
    old = json.loads(OUT.read_text(encoding='utf-8')) if OUT.exists() else {}
    out = {'_about': __doc__.strip().splitlines()[0] + ' Rest-frame cm from the volume centre.'}
    added = bool(only and 'added' in only)
    for name, fn in (('hand', hand), ('lowerextremity', lower_extremity), ('upperextremity', upper_extremity), ('headneck', head_neck),
                     ('skull', skull), ('chest', lambda: trunk('chest')), ('chestabdopelvis', lambda: trunk('chestabdopelvis'))):
        if added or (only and name not in only):
            out[name] = dict(old.get(name, {}))
            if added and name in ADDED:
                out[name].update(ADDED[name]())
            continue
        out[name] = {**fn(), **(ADDED[name]() if name in ADDED else {})}
        for k, v in out[name].items():
            print(f'{name:16s} {k:16s} ({v["x"]:7.2f} {v["y"]:7.2f} {v["z"]:7.2f})  {v["how"][:80]}')
    for name, pts in old.items():                # (the child's points: tools/measure_pediatric.py writes them)
        if name not in out:
            out[name] = pts
    if added:
        for name in ADDED:
            for k in ('legMid', 'clavicleR', 'eam', 'sacrum', 'coccyx', 'ribsR'):
                if k in out[name]:
                    v = out[name][k]
                    print(f'{name:16s} {k:16s} ({v["x"]:7.2f} {v["y"]:7.2f} {v["z"]:7.2f})  {v["how"][:80]}')
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    print('wrote', OUT)


if __name__ == '__main__':
    main(sys.argv[1:] or None)
