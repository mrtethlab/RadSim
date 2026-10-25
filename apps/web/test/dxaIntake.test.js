import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeIntake, intakeVerdict, TABLE_LIMIT_KG, HPT_FOREARM_LOSS } from '../src/dxaIntake.js';

test('an intake form is the same patient for the same seed, and asks every question', () => {
  const a = makeIntake(1234), b = makeIntake(1234);
  assert.deepEqual(a, b);
  const keys = a.fields.map((f) => f.key);
  for (const k of ['age', 'height', 'weight', 'hand', 'previous', 'imaging', 'meds', 'fracture', 'surgery', 'smoking', 'vitamins', 'calcium', 'cancer', 'conditions', 'menses'])
    assert.ok(keys.includes(k), `asks about ${k}`);
});

test('each reason to delay is read off the answers, and no other answer delays the scan', () => {
  for (const kind of ['pregnant', 'barium', 'contrast', 'nuclear', 'calcium']) {
    for (let seed = 1; seed <= 40; seed++) {
      const P = makeIntake(seed, { delay: kind, ...(kind === 'pregnant' ? { sex: 'f', age: 34 } : {}) });
      assert.ok(P.verdict.delay, `${kind} (seed ${seed}) should delay: ${JSON.stringify(P.fields.map((f) => f.a))}`);
    }
  }
  for (let seed = 1; seed <= 200; seed++) {
    const P = makeIntake(seed, { delay: null, forearm: null });
    assert.ok(!P.verdict.delay, `seed ${seed} has no reason to wait: ${P.verdict.reasons.join(' | ')}`);
    assert.deepEqual(P.verdict.plan, ['spine', 'hip'], `seed ${seed}: nothing on the form asks for the forearm`);
    assert.ok(P.weight <= TABLE_LIMIT_KG);
  }
});

test('the reasons are the answers, not the generator: an old barium study or yesterday evening calcium does not delay', () => {
  const P = makeIntake(7, { delay: null });
  const set = (k, a) => { P.fields.find((f) => f.key === k).a = a; };
  set('imaging', 'Barium enema last year'); set('calcium', 'Not today (I take it in the evening)');
  assert.equal(intakeVerdict(P).delay, false);
  set('imaging', 'Barium swallow 9 days ago');
  assert.equal(intakeVerdict(P).delay, true);
  set('imaging', 'CT abdomen with IV contrast 12 days ago');
  assert.equal(intakeVerdict(P).delay, false, 'contrast 12 days ago has cleared');
});

test('the form drives the skeleton: risk factors cost mineral, a young woman keeps hers', () => {
  let young = 0, old = 0, n = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const P = makeIntake(seed, { delay: null });
    assert.ok(P.loss >= 0 && P.loss <= 0.4);
    if (P.sex === 'f' && P.age < 48 && !P.risks.length) young = Math.max(young, P.loss);
    if (P.sex === 'f' && P.age > 75) { old += P.loss; n++; }
  }
  assert.ok(young < 0.06, `a young woman with no risks keeps her bone: ${young}`);
  assert.ok(n && old / n > 0.15, `older women have lost bone: ${old / n}`);
});

// ---------------------------------------------------------------- the forearm (ISCD indications)
test('over the table limit is a forearm-only study, not a patient sent away', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const P = makeIntake(seed, { delay: null, forearm: 'weight' });
    assert.ok(P.weight > TABLE_LIMIT_KG, `seed ${seed}: ${P.weight} kg`);
    assert.equal(P.verdict.delay, false, `seed ${seed}: ${P.verdict.reasons.join(' | ')}`);
    assert.deepEqual(P.verdict.plan, ['forearm']);
  }
});

test('the forearm is added for hyperparathyroidism, and stands in for a hip or spine that cannot be measured', () => {
  const plan = (k) => makeIntake(11, { delay: null, forearm: k }).verdict.plan;
  assert.deepEqual(plan('hpt'), ['spine', 'hip', 'forearm']);
  assert.deepEqual(plan('hips'), ['spine', 'forearm']);
  assert.deepEqual(plan('fusion'), ['hip', 'forearm']);
  // read off the answers, so both at once leaves the forearm alone
  const P = makeIntake(11, { delay: null, forearm: 'hips' });
  P.fields.find((f) => f.key === 'surgery').a = 'Both hips replaced (2015 and 2020); spinal fusion, L2 to L5, with rods and screws';
  assert.deepEqual(intakeVerdict(P).plan, ['forearm']);
  // a knee replacement is not the spine or the hip
  P.fields.find((f) => f.key === 'surgery').a = 'Knee replacement (right)';
  assert.deepEqual(intakeVerdict(P).plan, ['spine', 'hip']);
});

test('the forearm measured is the non-dominant one, unless that wrist was broken', () => {
  const side = (o) => makeIntake(5, { delay: null, forearm: 'hpt', ...o }).verdict.forearmSide;
  assert.equal(side({ hand: 'R' }), 'L');
  assert.equal(side({ hand: 'L' }), 'R');
  assert.equal(side({ hand: 'R', wrist: 'L' }), 'R', 'right-handed, left wrist broken: the right forearm');
  assert.equal(side({ hand: 'R', wrist: 'R' }), 'L', 'the dominant wrist broken changes nothing');
  assert.match(makeIntake(5, { forearm: 'hpt', hand: 'R', wrist: 'L' }).fields.find((f) => f.key === 'fracture').a, /^Left wrist/);
});

test('hyperparathyroidism costs the one-third radius more than the rest of the skeleton', () => {
  const P = makeIntake(21, { delay: null, forearm: 'hpt' }), Q = makeIntake(21, { delay: null, forearm: null });
  assert.equal(P.faLoss, HPT_FOREARM_LOSS);
  assert.equal(Q.faLoss, 0);
  assert.ok(P.risks.includes('Primary hyperparathyroidism'));
});

test('the forearm questions do not change who a seed is', () => {
  // they are drawn after everything else, so a seed is the patient it was before they existed —
  // these are the answers the generator gave for these seeds before the forearm was added
  const before = {
    7: ['Bergeron, Aiko', '983586', 0.318, '82', '165 kg (364 lb)', 'Ultrasound of the thyroid 3 weeks ago', 'Former, quit 11 years ago', 'Menopause at 47'],
    1234: ['Kowalski, Carmen', '264705', 0.216, '53', '65 kg (143 lb)', 'CT chest with contrast about 3 months ago', 'Never', 'Menopause at 42'],
    99: ['Marchetti, Miriam', '385239', 0.042, '55', '63 kg (139 lb)', 'None', 'Former, quit 20 years ago', 'Menopause at 49'],
  };
  for (const [seed, [name, id, loss, ...ans]] of Object.entries(before)) {
    const P = makeIntake(+seed), a = (k) => P.fields.find((f) => f.key === k).a;
    assert.deepEqual([P.name, P.id, P.loss], [name, id, loss], `seed ${seed}`);
    assert.deepEqual(['age', 'weight', 'imaging', 'smoking', 'menses'].map(a), ans, `seed ${seed}`);
  }
  // seed 7 was sent away for her weight; she is now the forearm-only study
  assert.deepEqual(makeIntake(7).verdict.plan, ['forearm']);
  assert.equal(makeIntake(7).verdict.delay, false);
});
