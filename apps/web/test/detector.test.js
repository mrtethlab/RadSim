// The detector's noise model, pinned to the numbers that were measured by hand when it was
// built: quantum noise with variance N plus a dose-independent readout floor, both in quanta.
// Statistical tests use enough pixels that the tolerance is tight but never flaky (the
// relative error of a variance estimate over n samples is ~sqrt(2/n): 0.2 % at 400k).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Detector, ELECTRONIC_NOISE, EI_K } from '../src/core/detector.js';

const PS = 6000;                       // quanta per unit dose, as the app uses at std resolution
const flat = (n, dose) => ({ dose: new Float32Array(n).fill(dose), mask: new Uint8Array(n).fill(1) });
const stats = (a) => {
  let s = 0; for (const v of a) s += v; const m = s / a.length;
  let q = 0; for (const v of a) q += (v - m) ** 2;
  return { mean: m, variance: q / (a.length - 1) };
};

test('a flat exposure reads back its own dose', () => {
  const n = 400_000, dose = 0.5;
  const { dose: d, mask } = flat(n, dose);
  const { signal } = Detector.capture(d, n, 1, PS, mask);
  assert.ok(Math.abs(stats(signal).mean / dose - 1) < 0.002, 'mean signal within 0.2 % of dose');
});

test('variance is quantum plus readout: (N + 1 + sigma_e^2) / photonScale^2', () => {
  const n = 400_000;
  for (const dose of [0.05, 0.5, 2.0]) {
    const { dose: d, mask } = flat(n, dose);
    const { signal } = Detector.capture(d, n, 1, PS, mask);
    const N = dose * PS;
    const want = (N + 1 + ELECTRONIC_NOISE ** 2) / PS ** 2;
    const got = stats(signal).variance;
    assert.ok(Math.abs(got / want - 1) < 0.02, `dose ${dose}: variance ${got.toExponential(3)} vs ${want.toExponential(3)}`);
  }
});

test('electronic noise is what makes underexposure ugly: it dominates at low dose', () => {
  // at N = 30 quanta the readout variance (225) is ~7x the quantum variance — the
  // regime the feature was added for. Relative noise must be far above pure Poisson.
  const n = 200_000, dose = 30 / PS;
  const { dose: d, mask } = flat(n, dose);
  const { signal } = Detector.capture(d, n, 1, PS, mask);
  const relNoise = Math.sqrt(stats(signal).variance) / dose;
  assert.ok(relNoise > 2.5 * (1 / Math.sqrt(30)), `relative noise ${relNoise.toFixed(3)} should dwarf Poisson ${(1 / Math.sqrt(30)).toFixed(3)}`);
});

test('pixels outside the collimated field read exactly zero', () => {
  const n = 10_000, d = new Float32Array(n).fill(1), mask = new Uint8Array(n);
  for (let i = 0; i < n / 2; i++) mask[i] = 1;
  const { signal } = Detector.capture(d, n, 1, PS, mask);
  for (let i = n / 2; i < n; i++) assert.equal(signal[i], 0);
});

test('EI reads the anatomy, not the raw beam around it', () => {
  // a hand on a big receptor: half the field is direct exposure. EI must follow the
  // attenuated half, or it is "wildly over-stated" exactly as the detector comment warns.
  const n = 200_000, d = new Float32Array(n), mask = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) d[i] = i < n / 2 ? 1.0 : 0.1 + 0.1 * (i % 100) / 100;   // anatomy 0.10-0.20
  const { EI } = Detector.capture(d, n, 1, PS, mask);
  assert.ok(EI > 0.1 * EI_K && EI < 0.25 * EI_K, `EI ${EI} should sit in the anatomy band, not near the direct ${EI_K}`);
});

test('EI is proportional to dose', () => {
  const n = 200_000;
  const eiAt = (k) => {
    const d = new Float32Array(n), m = new Uint8Array(n).fill(1);
    for (let i = 0; i < n; i++) d[i] = k * (0.2 + 0.3 * (i % 997) / 997);
    return Detector.capture(d, n, 1, PS, m).EI;
  };
  const e1 = eiAt(1), e2 = eiAt(2);
  assert.ok(Math.abs(e2 / e1 - 2) < 0.05, `doubling dose: EI ${e1} -> ${e2}`);
});
