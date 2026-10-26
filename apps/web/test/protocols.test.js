// X-ray protocol poses and the landmarks they centre on. The landmarks were checked by tracing
// the posed phantom (single-bone joints land within 0.15 cm of the central ray); these tests keep
// the data honest so a model rebuild or a typo cannot silently send a protocol to the wrong place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyCrops } from '../src/core/crops.js';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const protocols = load('../src/data/protocols.json');
const landmarks = load('../src/data/landmarks.json');
const centring = load('../src/data/centring.json');   // the textbook points, looked up first
const palpation = load('../src/data/palpation.json');
// the crops (the foot) take their points from their source, as app.js does at load
applyCrops(load('../src/data/crops.json'), { joints: load('../src/data/joints.json'), landmarks, centring, palpation });
const all = protocols.groups.flatMap((g) => g.regions.flatMap((r) => r.projections.map((p) => ({ ...p, part: g.part }))));
const BROWSER_SUBJECTS = new Set(['hand', 'chest', 'skull', 'headneck', 'chestabdopelvis', 'upperextremity', 'lowerextremity', 'foot',
  'wholebody', 'pediatric', 'metalphantom', 'linepair', 'breast', 'breastdense', 'acrphantom']);

test('every projection names a subject the browser can actually load', () => {
  assert.equal(all.length, 64);           // (47, the 3 pasting studies, the 8 skull views, the 6 child views)
  for (const p of all) assert.ok(BROWSER_SUBJECTS.has(p.subject), `${p.proj}: subject ${p.subject}`);
});

test('every projection carries a pose, and every centring landmark exists for its subject', () => {
  for (const p of all) {
    assert.ok(p.pose && Number.isFinite(p.pose.roll) && Number.isFinite(p.pose.cc), `${p.proj}: pose`);
    if (p.pose.centre) assert.ok(centring[p.subject]?.[p.pose.centre] || landmarks[p.subject]?.[p.pose.centre],
      `${p.proj}: no landmark ${p.subject}.${p.pose.centre}`);
  }
});

test('views named lateral are rolled a quarter turn; AP and PA are not', () => {
  // the arm (z053) rests 4 degrees off the anatomical position: its views are rolled by what the epicondyles
  // measure (data/palpation.json), AP laying them parallel to the receptor and the lateral standing
  // them up, lateral epicondyle on top (+ roll turns +x toward +y, the tube)
  const pa = palpation.upperextremity;
  const ax = [pa.lateralEpicondyle.x - pa.medialEpicondyle.x, pa.lateralEpicondyle.y - pa.medialEpicondyle.y];
  const turned = (roll) => { const r = roll * Math.PI / 180; return [ax[0] * Math.cos(r) - ax[1] * Math.sin(r), ax[0] * Math.sin(r) + ax[1] * Math.cos(r)]; };
  const deg = (v) => Math.atan2(v[1], v[0]) * 180 / Math.PI;
  for (const p of all) {
    const r = Math.abs(p.pose.roll % 360);
    // (the shoulder views keep the patient supine: they are about the girdle, not the elbow)
    if (p.subject === 'upperextremity' && !/shoulder/.test(p.proj)) {
      if (/^AP /.test(p.proj)) assert.ok(Math.abs(deg(turned(p.pose.roll))) < 3, `${p.proj}: epicondyles ${deg(turned(p.pose.roll)).toFixed(1)} deg off parallel`);
      if (/^Lateral/.test(p.proj)) assert.ok(Math.abs(deg(turned(p.pose.roll)) - 90) < 3, `${p.proj}: lateral epicondyle not on top`);
      continue;
    }
    // (the leg rests turned in: its knee and femur views are rolled by the bone, checked below)
    if (p.subject === 'lowerextremity' && /knee|femur/.test(p.proj)) continue;
    if (/^Lateral/.test(p.proj) || /^Swimmers/.test(p.proj)) assert.equal(r, 90, p.proj);
    if (/^AP /.test(p.proj)) assert.equal(r, 0, p.proj);
    if (/^PA /.test(p.proj) && p.subject !== 'hand') assert.equal(r, 180, `${p.proj}: body subjects rest AP, so PA is a half turn`);
  }
});

test('the knee: the AP turns the patella midline, the lateral a quarter turn from it', () => {
  // the leg (z035) rests turned in; the AP knee's roll lays the patella over the femoral notch, and the
  // lateral's superimposes the condyles: about a quarter turn on (measured on the bone, protocols.json)
  const roll = (proj) => all.find((p) => p.proj === proj).pose.roll;
  assert.ok(roll('AP knee') < -15 && roll('AP knee') > -30, `AP knee ${roll('AP knee')}`);
  assert.equal(roll('AP femur'), roll('AP knee'));
  const q = roll('Lateral knee') - roll('AP knee');
  assert.ok(q <= -85 && q >= -100, `lateral knee ${q} deg from the AP`);
  assert.equal(roll('Lateral femur'), roll('Lateral knee'));
});

test('an approximate view always says why', () => {
  const approx = all.filter((p) => p.pose.fidelity === 'approx');
  assert.ok(approx.length > 0);
  for (const p of approx) assert.ok(p.pose.note && p.pose.note.length > 30, `${p.proj}: note`);
});

test('the mortise is an internal rotation of the right leg, not the left', () => {
  // the leg model is a RIGHT leg (the other leg's crop lies toward the patient's left), and
  // internal rotation turns the anterior surface toward the midline, which is +roll
  const m = all.find((p) => p.proj === 'Mortise ankle');
  assert.ok(m.pose.roll > 10 && m.pose.roll < 25, `mortise roll ${m.pose.roll}`);
});

test('landmarks sit where the traced phantom confirmed them (cm from the volume centre)', () => {
  // values validated on the posed phantom; a model rebuild that moves them should be looked at
  // (the leg and arm were rebuilt by services/compute/app/build_limbs.py: the leg re-cut from the
  // same CT, the arm from another (z033, then z053 for its healthy bone), so their numbers moved
  // and were checked on bone projections; then both were baked to the anatomical position,
  // app/bake_pose.py, and checked again; the leg is z035's now (a young adult's healthy bone; its feet lay pointed and
  // were baked to 90 degrees), checked on a bone projection: knee and ankle on their joint lines;
  // the bake left its hindfoot pointed until the foot was carried whole, bone and tissue, and the
  // volume came out 3.5 cm shorter: the knee kept its place from the hip, the ankle came up onto
  // the talus from under the smeared hindfoot; then the foot was trimmed 11 degrees out of external
  // turn and 8 of inversion (bake_pose --trim). The ankle was then measured where it is: the
  // malleolar bulge it was read from took in the hindfoot of a foot at 90 degrees and sat 4 cm
  // low, on the calcaneus (-43.4); it is now the tibiotalar joint, the first joint sheet down the
  // tibia's axis (z -39.25 on the sheet profile; the subtalar is the next, at -41.9), checked on
  // sagittal and coronal slices of the materials and on bone projections)
  const pinned = {
    'lowerextremity.knee': -5.4, 'lowerextremity.ankle': -39.15, 'upperextremity.elbow': 1.88,
    'upperextremity.forearm': -9.07, 'hand.wrist': -3.25, 'hand.hand': 3.55, 'chestabdopelvis.pelvis': -23.65,
    'chestabdopelvis.kub': -12.7,
  };
  for (const [k, z] of Object.entries(pinned)) {
    const [m, n] = k.split('.');
    assert.ok(Math.abs(landmarks[m][n].z - z) < 0.6, `${k}: z ${landmarks[m][n].z}, validated at ${z}`);
  }
});

test('the joints come in anatomical order along each limb', () => {
  const L = landmarks.lowerextremity, U = landmarks.upperextremity, H = landmarks.hand;
  assert.ok(L.foot.z < L.ankle.z && L.ankle.z < L.knee.z && L.knee.z < L.femur.z && L.femur.z < L.hip.z, 'leg: foot < ankle < knee < femur < hip');
  assert.ok(U.wrist.z < U.forearm.z && U.forearm.z < U.elbow.z && U.elbow.z < U.humerus.z && U.humerus.z < U.shoulder.z, 'arm: wrist < forearm < elbow < humerus < shoulder');
  assert.ok(H.wrist.z < H.hand.z && H.hand.z < H.fingers.z, 'hand: carpals < MCP < PIP');
  const C = landmarks.chestabdopelvis;
  assert.ok(C.pelvis.z < C.kub.z && C.kub.z < C.lumbar.z && C.lumbar.z < C.thoracic.z, 'trunk: pelvis < crest < L3 < T7');
});

test('the pediatric child: its points lie in anatomical order, skull to feet, each limb on its own side', () => {
  // a composite (services/compute/app/build_pediatric.py): a grafted part placed upside down or on
  // the wrong side would show here first. Volume frame: +z superior, +x the patient's LEFT
  const P = landmarks.pediatric;
  const up = ['ankleR', 'kneeR', 'pelvis', 'kub', 'lumbar', 'thoracic', 'cspine', 'skull'];
  for (let i = 1; i < up.length; i++) assert.ok(P[up[i - 1]].z < P[up[i]].z, `${up[i - 1]} below ${up[i]}`);
  assert.ok(P.wristR.z < P.elbowR.z && P.elbowR.z < P.thoracic.z, 'the hand below the elbow, the elbow below T7');
  for (const j of ['knee', 'ankle', 'elbow', 'wrist']) assert.ok(P[j + 'R'].x < -5 && P[j + 'L'].x > 5, `${j}: right at -x, left at +x`);
  // the child's pediatric protocols centre on its own points, and no adult protocol loads it
  for (const p of all.filter((x) => x.subject === 'pediatric')) assert.match(p.proj, /\(child\)$/, p.proj);
});

test('every landmark records how it was found and how sure that is', () => {
  for (const [m, set] of Object.entries(landmarks)) {
    if (m.startsWith('_')) continue;
    for (const [n, lm] of Object.entries(set)) {
      if (n.startsWith('_')) continue;
      assert.ok(lm.how && ['high', 'medium', 'low'].includes(lm.confidence), `${m}.${n}`);
    }
  }
});

test('every gridded exam names its AEC chambers, and a PA chest meters the lungs', () => {
  // a chest on the centre chamber sits on the mediastinum and burns the lungs out (+6.3 DI
  // measured); the lateral pair is the right choice, and the one a protocol must preset
  for (const p of all.filter((x) => x.grid)) {
    assert.match(p.aec ?? '', /^[lcr]{1,3}$/, `${p.proj}: aec ${p.aec}`);
  }
  for (const p of all.filter((x) => !x.grid)) assert.equal(p.aec, undefined, `${p.proj}: table-top exams do not use AEC`);
  assert.equal(all.find((p) => p.proj === 'PA chest').aec, 'lr');
  assert.equal(all.find((p) => p.proj === 'AP lumbar').aec, 'c');
});

test('the cervical spine is centred on C4, measured from the vertebra labels of the CT', () => {
  // the profile method put it on C1 in the first head CT (the neck narrowed at the atlas with the
  // arms raised) and both cervical views were centred 4.8 cm high, the AP through the mandible
  const cs = landmarks.headneck.cspine, c = centring.headneck;
  assert.match(cs.how, /C4/);
  assert.equal(cs.confidence, 'high');
  // between C1-C2 and C7-T1, nearer the middle than either end
  const span = c.C1C2.z - c.C7T1.z, at = (c.C1C2.z - cs.z) / span;
  assert.ok(at > 0.3 && at < 0.6, `C4 z ${cs.z}: ${(100 * at).toFixed(0)} % of the way down from C1-C2 (${c.C1C2.z}) to C7-T1 (${c.C7T1.z})`);
  assert.ok(Math.abs(c.C4.z - cs.z) < 0.01, 'the landmark and the centring point are the same body');
});

test('the routine views centre where the textbooks say', () => {
  // Bontrager/Lampignano, McQuillen Martensen, Radiopaedia: the 3rd MCP joint for a PA hand, the
  // 2nd for the lateral, the midcarpal area for the wrist, midway between the malleoli for the AP
  // ankle and the medial malleolus for the lateral, T7 for chest and thoracic spine, the iliac
  // crest (L4-L5) for the lumbar spine on a 35 x 43 receptor; the spine laterals on the column
  const want = { 'PA hand': 'mcp3Joint', 'Oblique hand': 'mcp3Joint', 'Lateral hand': 'mcp2Joint',
    'PA wrist': 'midcarpal', 'Oblique wrist': 'midcarpal', 'Lateral wrist': 'midcarpal',
    'AP ankle': 'intermalleolar', 'Mortise ankle': 'intermalleolar', 'Lateral ankle': 'medialMalleolus',
    'PA chest': 'T7', 'Lateral chest': 'T7mc', 'AP thoracic': 'T7', 'Lateral thoracic': 'T7col',
    'AP lumbar': 'crest', 'Lateral lumbar': 'crestCol' };
  for (const [proj, c] of Object.entries(want)) {
    const p = all.find((x) => x.proj === proj);
    assert.equal(p.pose.centre, c, proj);
    const pt = centring[p.subject][c];
    assert.ok(pt && /Bontrager|Radiopaedia/.test(pt.guide), `${proj}: a sourced guideline`);
  }
  // the 3rd MCP joint lies distal of the midcarpal point by about the metacarpal length (6-7 cm)
  const h = centring.hand;
  assert.ok(h.mcp3Joint.z - h.midcarpal.z > 5 && h.mcp3Joint.z - h.midcarpal.z < 8);
  // T7 lies 8-10 cm below the jugular notch, and the crest below it
  const c = centring.chestabdopelvis;
  assert.ok(c.T7.z > c.crest.z + 20);
  // the column points sit on the spine, behind the skin's midpoint (this abdomen is deep) and in
  // front of the back; a lateral centred on them is narrow
  assert.equal(c.crestCol.z, c.crest.z); assert.equal(c.T7col.z, c.T7.z);
  assert.ok(c.crestCol.y < c.crestMc.y - 4 && c.crestCol.y > -12, `crestCol y ${c.crestCol.y}`);
  assert.ok(c.T7col.y < c.T7mc.y - 4 && c.T7col.y > -12, `T7col y ${c.T7col.y}`);
});

test('the hand films show their soft tissue: the hand LUT, no detail processing, the whole tissue range kept', () => {
  const luts = load('../src/data/luts.json').luts;
  const hand = all.filter((p) => p.subject === 'hand');
  assert.ok(hand.length >= 8, `${hand.length} hand protocols`);
  for (const p of hand) assert.equal(p.lut, 'hand', `${p.proj} uses ${p.lut}`);
  // DR detail processing smeared the cortex and flattened the soft tissue into the background;
  // the dark end keeps all but 1 % of the anatomy, so the finger envelope stays in the window
  assert.equal(luts.hand.detail, false);
  assert.ok(luts.hand.clipLo <= 0.02 && luts.hand.width >= 0.9, JSON.stringify(luts.hand));
});

test('the skull, sinus and facial views load the Skull, angled to the OML and centred where the textbooks say', () => {
  // the Skull lies with its OML square to the long axis (services/compute/app/build_skull.py), so each
  // view's angle to the OML is its own: Caldwell 15 degrees caudad, Towne 30 caudad (+cc is caudal),
  // Waters with the head extended until the OML is 37 degrees to the receptor (53 from square), the
  // laterals 7 degrees up to lay the IOML across the receptor
  const head = all.filter((p) => p.part === 'Head' && p.subject !== 'pediatric');      // (the child's own head views are on the child)
  assert.ok(head.length >= 10, `${head.length} head views`);
  for (const p of head) {
    assert.equal(p.subject, 'skull', p.proj);
    const pt = centring.skull[p.pose.centre];
    assert.ok(pt && /Bontrager|Radiopaedia/.test(pt.guide), `${p.proj}: centre ${p.pose.centre} has a sourced guideline`);
  }
  const pose = (proj) => all.find((p) => p.proj === proj).pose;
  assert.equal(pose('PA axial skull (Caldwell)').cc, 15);
  assert.equal(pose('AP axial skull (Towne)').cc, 30);
  assert.equal(pose('Parietoacanthial sinuses (Waters)').tilt, 53);
  for (const p of head.filter((x) => /^Lateral/.test(x.proj))) assert.equal(p.pose.tilt, 7, p.proj);
  // the points in anatomical order: the acanthion below the nasion, the ear canals behind both, the
  // lateral skull's point 5 cm above them
  const c = centring.skull;
  assert.ok(c.acanthion.z < c.nasion.z - 3, `acanthion ${c.acanthion.z} vs nasion ${c.nasion.z}`);
  assert.ok(c.eam.y < c.nasion.y - 7 && c.eam.y < c.zygoma.y && c.zygoma.y < c.nasion.y, 'front to back: nasion, zygoma, ear canals');
  assert.ok(Math.abs(c.latSkull.z - c.eam.z - 5) < 0.01);
  // the cervical spine stays on the head and neck model
  for (const p of all.filter((x) => /cervical|open mouth|Swimmers/i.test(x.proj))) assert.equal(p.subject, 'headneck', p.proj);
});
