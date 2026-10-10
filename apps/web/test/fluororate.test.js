// The fluoroscopic dose-rate ceiling: the generator must keep screening under 88 mGy/min at the
// reference point, whatever the patient asks of the ABC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { akPerPulse, akRate, maCeiling, RATE_LIMIT } from '../src/core/fluoroRate.js';

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

test('the reference technique reads ~12 mGy/min, and the rate follows mA, kV and pulse rate', () => {
  assert.ok(near(akRate(70, 2, 15), 12));
  assert.ok(near(akRate(70, 4, 15), 24));
  assert.ok(near(akRate(70, 2, 30), 24));
  assert.ok(near(akPerPulse(70, 2, 4) / akPerPulse(70, 2, 1), 4), 'mag mode');
});

test('at the mA ceiling the rate is exactly the limit, at any kV, pulse rate and field', () => {
  for (const [kv, pps, mag] of [[70, 15, 1], [110, 15, 1], [110, 30, 1], [90, 7.5, 2.35]]) {
    assert.ok(near(akRate(kv, maCeiling(kv, pps, mag), pps, mag), RATE_LIMIT), `${kv} kV ${pps} pps`);
  }
});

test('the old railed technique was illegal; the ceiling forbids it', () => {
  // 110 kV / 10 mA at 15 pps: what the ABC used to reach on a 31 cm lumbar subject
  assert.ok(akRate(110, 10, 15) > 150);
  assert.ok(maCeiling(110, 15) < 10);
  // the legal figure itself, not just whatever the constant says: 88 mGy/min in normal mode
  assert.equal(RATE_LIMIT, 88);
  assert.ok(akRate(110, maCeiling(110, 15), 15) <= 88 + 1e-9);
  // halving the pulse rate doubles the mA each pulse may have
  assert.ok(near(maCeiling(110, 7.5) / maCeiling(110, 15), 2));
});
