// The CT acquisition clock. Each group of a multiphase scan fires at its own moment in the
// bolus; for months every group was built at the instant START was pressed, so an arterial
// and a portal-venous phase came out as the same image.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupFireTime, afterGroupTime, acquisitionTime } from '../src/core/contrast.js';

const BH = 2.7, BO = 1.8;                         // breath-hold and breathe-out, s

test('two groups 20 s apart fire at different moments, separated by at least the delay', () => {
  let t = 4.3;                                    // injector time when START is pressed
  const g1 = groupFireTime(t, { moveS: 1.6, delayS: 0, breathHoldS: BH });
  t = afterGroupTime(g1, { expS: 5, breathOutS: BO });
  const g2 = groupFireTime(t, { moveS: 0, delayS: 20, breathHoldS: BH });
  assert.ok(Math.abs(g1 - 8.6) < 1e-9, `group 1 at ${g1}`);
  assert.ok(g2 - g1 >= 20, `group 2 ${g2.toFixed(1)} s, only ${(g2 - g1).toFixed(1)} s after group 1`);
  assert.ok(Math.abs(g2 - (8.6 + 5 + BO + 20 + BH)) < 1e-9);
});

test('a longer delay always means a later phase', () => {
  const at = (d) => groupFireTime(10, { delayS: d, breathHoldS: BH });
  assert.ok(at(35) > at(25) && at(25) > at(0));
});

test('no injection running means no acquisition time, all the way through', () => {
  assert.equal(groupFireTime(null, { delayS: 20 }), null);
  assert.equal(afterGroupTime(null, { expS: 5 }), null);
});

test('a negative delay cannot fire a group before its predecessor', () => {
  assert.equal(groupFireTime(10, { delayS: -5 }), 10);
});

test('slice times count on from the group start at the couch speed', () => {
  assert.equal(acquisitionTime(100, 0, 8.6, 50), 10.6);
  assert.equal(acquisitionTime(100, 0, 8.6, 0), 8.6);
});
