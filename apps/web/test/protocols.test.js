// X-ray protocol poses and the landmarks they centre on. The landmarks were checked by tracing
// the posed phantom (single-bone joints land within 0.15 cm of the central ray); these tests keep
// the data honest so a model rebuild or a typo cannot silently send a protocol to the wrong place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const protocols = load('../src/data/protocols.json');
const landmarks = load('../src/data/landmarks.json');
const all = protocols.groups.flatMap((g) => g.regions.flatMap((r) => r.projections.map((p) => ({ ...p, part: g.part }))));
const BROWSER_SUBJECTS = new Set(['hand', 'chest', 'headneck', 'chestabdopelvis', 'upperextremity', 'lowerextremity',
  'totalhipreplacement', 'wholebody', 'metalphantom', 'linepair', 'breast', 'breastdense', 'acrphantom']);

test('every projection names a subject the browser can actually load', () => {
  assert.equal(all.length, 40);
  for (const p of all) assert.ok(BROWSER_SUBJECTS.has(p.subject), `${p.proj}: subject ${p.subject}`);
});

test('every projection carries a pose, and every centring landmark exists for its subject', () => {
  for (const p of all) {
    assert.ok(p.pose && Number.isFinite(p.pose.roll) && Number.isFinite(p.pose.cc), `${p.proj}: pose`);
    if (p.pose.centre) assert.ok(landmarks[p.subject]?.[p.pose.centre], `${p.proj}: no landmark ${p.subject}.${p.pose.centre}`);
  }
});

test('views named lateral are rolled a quarter turn; AP and PA are not', () => {
  for (const p of all) {
    const r = Math.abs(p.pose.roll % 360);
    if (/^Lateral/.test(p.proj)) assert.equal(r, 90, p.proj);
    if (/^AP /.test(p.proj)) assert.equal(r, 0, p.proj);
    if (/^PA /.test(p.proj) && p.subject !== 'hand') assert.equal(r, 180, `${p.proj}: body subjects rest AP, so PA is a half turn`);
  }
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
  const pinned = {
    'lowerextremity.knee': 3.68, 'lowerextremity.ankle': -35.48, 'upperextremity.elbow': 2.02,
    'upperextremity.forearm': -11.62, 'hand.wrist': -3.25, 'hand.hand': 3.55, 'chestabdopelvis.pelvis': -23.65,
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

test('every landmark records how it was found and how sure that is', () => {
  for (const [m, set] of Object.entries(landmarks)) {
    if (m.startsWith('_')) continue;
    for (const [n, lm] of Object.entries(set)) {
      if (n.startsWith('_')) continue;
      assert.ok(lm.how && ['high', 'medium', 'low'].includes(lm.confidence), `${m}.${n}`);
    }
  }
});
