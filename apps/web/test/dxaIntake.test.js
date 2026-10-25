import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeIntake, intakeVerdict, TABLE_LIMIT_KG } from '../src/dxaIntake.js';

test('an intake form is the same patient for the same seed, and asks every question', () => {
  const a = makeIntake(1234), b = makeIntake(1234);
  assert.deepEqual(a, b);
  const keys = a.fields.map((f) => f.key);
  for (const k of ['age', 'height', 'weight', 'previous', 'imaging', 'meds', 'fracture', 'smoking', 'vitamins', 'calcium', 'cancer', 'menses'])
    assert.ok(keys.includes(k), `asks about ${k}`);
});

test('each reason to delay is read off the answers, and no other answer delays the scan', () => {
  for (const kind of ['pregnant', 'barium', 'contrast', 'nuclear', 'calcium', 'weight']) {
    for (let seed = 1; seed <= 40; seed++) {
      const P = makeIntake(seed, { delay: kind, ...(kind === 'pregnant' ? { sex: 'f', age: 34 } : {}) });
      assert.ok(P.verdict.delay, `${kind} (seed ${seed}) should delay: ${JSON.stringify(P.fields.map((f) => f.a))}`);
    }
  }
  for (let seed = 1; seed <= 200; seed++) {
    const P = makeIntake(seed, { delay: null });
    assert.ok(!P.verdict.delay, `seed ${seed} has no reason to wait: ${P.verdict.reasons.join(' | ')}`);
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
