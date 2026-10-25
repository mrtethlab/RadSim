// The precision assessment's arithmetic (ISCD): root-mean-square SD of repeat scans, the %CV the
// minimums are stated in, and the least significant change a follow-up has to clear. Worked by
// hand below, so each number is checked against arithmetic rather than against the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precisionStats, precisionVerdict, lscFor, changeVs, LSC_Z, LSC_PCT, ISCD_MIN_PRECISION, ISCD_MIN_DF } from '../src/dxa.js';

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test('precision is the ROOT-MEAN-SQUARE SD, not the mean SD', () => {
  // A: 1.00 1.03 0.97 -> mean 1.00, variance (0 + .0009 + .0009) / 2 = .0009, SD .03, CV 3 %
  // B: 0.80 0.80 0.80 -> SD 0
  // RMS-SD = sqrt((2 x .0009 + 2 x 0) / 4) = sqrt(.00045) = .0212132; the mean SD would be .015
  const s = precisionStats([[1.00, 1.03, 0.97], [0.80, 0.80, 0.80]]);
  near(s.rmsSd, Math.sqrt(0.00045), 1e-9, 'RMS-SD');
  assert.ok(Math.abs(s.rmsSd - 0.015) > 0.005, 'not the mean of the SDs');
  near(s.cvPct, Math.sqrt((2 * 9 + 2 * 0) / 4), 1e-9, 'RMS %CV');     // sqrt(4.5) = 2.1213 %
  assert.equal(s.df, 4);
  assert.equal(s.m, 2);
  near(s.per[0].sd, 0.03, 1e-12, 'patient A SD');
  near(s.per[0].cv, 3, 1e-9, 'patient A CV');
});

test('unequal repeats pool by degrees of freedom', () => {
  // A (n 3) variance .0009 on 2 df; C (n 2) 0.90, 0.92 -> variance .0002 on 1 df
  // pooled = (2 x .0009 + 1 x .0002) / 3; a plain mean of the variances would give .00055
  const s = precisionStats([[1.00, 1.03, 0.97], [0.90, 0.92]]);
  near(s.rmsSd, Math.sqrt(0.002 / 3), 1e-9, 'pooled RMS-SD');
  assert.equal(s.df, 3);
  // a patient scanned once has no scatter to give, and must not count as a zero
  const t = precisionStats([[1.00, 1.03, 0.97], [0.85]]);
  near(t.rmsSd, 0.03, 1e-9, 'single scan left out');
  assert.equal(t.df, 2);
  assert.equal(precisionStats([]).df, 0);
});

test('15 patients x 3 and 30 x 2 are both the 30 degrees of freedom ISCD asks for', () => {
  const rows = (m, k) => Array.from({ length: m }, (_, j) => Array.from({ length: k }, (_, i) => 1 + 0.01 * j + 0.001 * i));
  assert.equal(precisionStats(rows(15, 3)).df, ISCD_MIN_DF);
  assert.equal(precisionStats(rows(30, 2)).df, ISCD_MIN_DF);
  assert.equal(precisionStats(rows(14, 3)).df, 28);
});

test('LSC = 2.77 x precision, which is 1.96 x sqrt(2): two measurements, 95 %', () => {
  near(LSC_Z, 1.96 * Math.SQRT2, 0.003, 'the multiplier');
  const s = precisionStats([[1.00, 1.03, 0.97], [0.80, 0.80, 0.80]]);
  near(s.lscAbs, 2.77 * Math.sqrt(0.00045), 1e-9, 'LSC g/cm2');       // 0.05876
  near(s.lscPct, 2.77 * Math.sqrt(4.5), 1e-9, 'LSC %');                // 5.876 %
});

test('ISCD minimums: spine 1.9 % / 5.3, total hip 1.8 % / 5.0, femoral neck 2.5 % / 6.9', () => {
  assert.deepEqual([ISCD_MIN_PRECISION.spine.cv, ISCD_MIN_PRECISION.spine.lsc], [1.9, 5.3]);
  assert.deepEqual([ISCD_MIN_PRECISION.total.cv, ISCD_MIN_PRECISION.total.lsc], [1.8, 5.0]);
  assert.deepEqual([ISCD_MIN_PRECISION.neck.cv, ISCD_MIN_PRECISION.neck.lsc], [2.5, 6.9]);
  // and the LSCs ARE 2.77 x the precisions, to ISCD's rounding
  for (const k of ['spine', 'total', 'neck']) near(ISCD_MIN_PRECISION[k].cv * LSC_Z, ISCD_MIN_PRECISION[k].lsc, 0.05, k);
  assert.equal(precisionVerdict('spine', { df: 30, cvPct: 1.9 }).ok, true);
  assert.equal(precisionVerdict('spine', { df: 30, cvPct: 1.91 }).ok, false);
  assert.equal(precisionVerdict('total', { df: 30, cvPct: 1.85 }).ok, false);
  assert.equal(precisionVerdict('neck', { df: 30, cvPct: 2.4 }).ok, true);
  assert.equal(precisionVerdict('neck', { df: 29, cvPct: 1 }).enough, false);
});

test('a follow-up is judged on the measured LSC in g/cm2, and the placeholder says it is one', () => {
  const prec = { spine: { lscAbs: 0.030, lscPct: 3.0, df: 30, when: 0 }, total: { lscAbs: 0.020, lscPct: 2.4, df: 30, when: 0 } };
  const sp = lscFor('spine', prec);
  assert.equal(sp.measured, true);
  assert.equal(changeVs(1.000, 0.968, sp).sig, true, '-0.032 clears 0.030');
  assert.equal(changeVs(1.000, 0.975, sp).sig, false, '-0.025 does not');
  // the hip's trend is the total hip, either side
  assert.equal(lscFor('hipL', prec).abs, 0.020);
  assert.equal(lscFor('hipR', prec).abs, 0.020);
  // g/cm2 rules when it was measured: -3 % on a thin hip is only -0.015 g/cm2
  const c = changeVs(0.500, 0.485, lscFor('hipL', { total: { lscAbs: 0.017, lscPct: 1.6, df: 30, when: 0 } }));
  assert.ok(c.pc < -2.9 && !c.sig, 'judged in g/cm2, not %');
  // nothing on file, and the forearm (no ISCD minimum, no exercise): the placeholder
  for (const [r, p] of [['spine', null], ['forearmL', prec]]) {
    const l = lscFor(r, p);
    assert.equal(l.measured, false);
    assert.equal(l.pct, LSC_PCT);
  }
  assert.equal(changeVs(1.000, 0.984, lscFor('spine', null)).sig, true, '-1.6 % clears the 1.5 % placeholder');
  assert.equal(changeVs(1.000, 0.990, lscFor('spine', null)).sig, false);
});
