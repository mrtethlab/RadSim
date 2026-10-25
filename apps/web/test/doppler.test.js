// Doppler physics (core/doppler.js): the relations a sonographer is examined on, held to their
// numbers. Each test was proved by re-introducing the bug it guards and watching it fail
// (docs/ultrasound.md §4.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C_MS, dopplerShift, velocityFromShift, nyquistVelocity, prfMax, wrapToWindow,
  angleCorrectionError, wallFilterGain, flowWave, respFactor, laminar, kasai, spectrumColumn,
  binOfShift, maxEnvelope, peakMeasures } from '../src/core/doppler.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const deg = (d) => d * Math.PI / 180;
// a seeded uniform generator, so the statistical tests are reproducible
const seeded = (s) => () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

test('the Doppler equation: f_d = 2 f0 v cos(theta) / c, with c = 1540 m/s', () => {
  assert.equal(C_MS, 1540);
  near(dopplerShift(3e6, 1, 0), 3896.1, 0.1, '3 MHz, 1 m/s head-on');
  near(dopplerShift(5e6, 0.5, deg(60)), 1623.4, 0.1, '5 MHz, 50 cm/s at 60 degrees');
  near(dopplerShift(3e6, 1, deg(90)), 0, 1e-9, 'a vessel crossed at 90 degrees shows nothing');
  near(dopplerShift(3e6, -0.4, 0), -dopplerShift(3e6, 0.4, 0), 1e-9, 'flow away is a negative shift');
  near(velocityFromShift(dopplerShift(4e6, 0.73, deg(48)), 4e6, deg(48)), 0.73, 1e-12, 'the inverse');
});

test('the Nyquist limit is PRF/2 in shift, c PRF / (4 f0 cos theta) in velocity', () => {
  const prf = 4000, f0 = 3e6;
  near(dopplerShift(f0, nyquistVelocity(prf, f0), 0), prf / 2, 1e-9, 'v_nyq maps to PRF/2');
  near(nyquistVelocity(prf, f0) * 100, 51.33, 0.01, 'cm/s at 4 kHz, 3 MHz');
  near(nyquistVelocity(prf, f0, deg(60)), 2 * nyquistVelocity(prf, f0), 1e-12, 'angle-corrected scale doubles at 60');
});

test('depth caps the PRF: PRF_max = c / 2d, and the range-velocity product is fixed', () => {
  near(prfMax(0.10), 7700, 1e-9, '10 cm');
  near(prfMax(0.20), 3850, 1e-9, '20 cm');
  // the pulse must make the round trip before the next leaves
  near(1 / prfMax(0.15), 2 * 0.15 / 1540, 1e-15, 'one PRF period is one round trip');
  // v_max x d = c^2 / (8 f0): deeper means a lower ceiling on velocity, at any frequency
  for (const d of [0.05, 0.1, 0.18]) for (const f0 of [2.5e6, 5e6]) {
    near(nyquistVelocity(prfMax(d), f0) * d, C_MS * C_MS / (8 * f0), 1e-9, `range-velocity at ${d} m, ${f0} Hz`);
  }
});

test('ALIASING WRAPS AROUND, it does not clip — and the baseline slides the window', () => {
  const h = 50;
  near(wrapToWindow(30, h), 30, 1e-12, 'inside the window: unchanged');
  near(wrapToWindow(65, h), -35, 1e-12, '1.3 x Nyquist comes back from the bottom');
  near(wrapToWindow(-70, h), 30, 1e-12, 'and the other way');
  near(wrapToWindow(65 + 4 * h, h), -35, 1e-9, 'periodic in 2 x Nyquist');
  // baseline down by half: the window becomes [-25, 75)
  near(wrapToWindow(65, h, 0.5), 65, 1e-12, 'room bought for positive flow');
  near(wrapToWindow(80, h, 0.5), -20, 1e-12, 'and past the new top it still wraps');
  near(wrapToWindow(-30, h, 0.5), 70, 1e-12, 'at the cost of negative flow');
});

test('the autocorrelator returns the shift, wrapped — a tone past PRF/2 reads backwards', () => {
  const prf = 5000, none = () => 0;
  for (const f of [-2100, -400, 0, 300, 1750, 2400]) {
    near(kasai([1, f, 0.7], 1, 8, prf, 0, none).f, f, 1e-6, `tone at ${f} Hz`);
  }
  near(kasai([1, 3500, 0.2], 1, 8, prf, 0, none).f, -1500, 1e-6, '0.7 PRF aliases to -0.3 PRF');
  near(kasai([1, 5000 + 600, 0], 1, 8, prf, 0, none).f, 600, 1e-6, 'one whole PRF is invisible');
  // receiver noise alone: complex, sigma in each of I and Q, so its power is 2 sigma^2
  const r = seeded(7), g = () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
  let p = 0; const N = 4000;
  for (let i = 0; i < N; i++) p += kasai([], 0, 8, prf, 0.1, g).p;
  near(p / N, 2 * 0.01, 0.001, 'noise power');
});

test('angle correction: the same misjudgement costs more the steeper the angle — the 60 degree rule', () => {
  near(angleCorrectionError(deg(30), deg(35)) * 100, 5.7, 0.1, '5 degrees off at 30');
  near(angleCorrectionError(deg(60), deg(65)) * 100, 18.3, 0.1, '5 degrees off at 60');
  near(angleCorrectionError(deg(70), deg(75)) * 100, 32.1, 0.1, '5 degrees off at 70');
  let prev = 0;
  for (let a = 0; a <= 80; a += 5) {
    const e = angleCorrectionError(deg(a), deg(a + 5));
    assert.ok(e > prev, `error grows: ${a} degrees`);
    prev = e;
    // and below 60 a 5-degree slip stays under 15 %, beyond it it does not
    assert.equal(e < 0.15, a < 60, `${a} degrees: ${(e * 100).toFixed(1)} %`);
  }
  near(angleCorrectionError(deg(55), deg(55)), 0, 1e-12, 'a correct cursor is exact');
});

test('the wall filter acts on the ALIASED shift: periodic in the PRF', () => {
  const prf = 4000, fc = 150;
  assert.ok(wallFilterGain(0, fc, prf) < 1e-9, 'a still wall is removed');
  assert.ok(wallFilterGain(3 * fc, fc, prf) > 0.99, 'flow well above the cutoff passes');
  near(wallFilterGain(fc, fc, prf), 0.5, 1e-9, 'half power at the cutoff');
  near(wallFilterGain(1800, fc, prf), wallFilterGain(1800 + prf, fc, prf), 1e-12, 'periodic');
  assert.ok(wallFilterGain(prf + 40, fc, prf) < 1e-3, 'a flow at one PRF looks like a wall, and goes');
  assert.equal(wallFilterGain(5, 0, prf), 1, 'filter off');
});

test('waveforms have the shapes their beds give them', () => {
  const T = 60 / 72, N = 400;
  const scan = (kind) => { let mx = -9, mn = 9; for (let i = 0; i < N; i++) { const v = flowWave(kind, i * T / N, T); mx = Math.max(mx, v); mn = Math.min(mn, v); } return { mx, mn, edv: flowWave(kind, T - 0.01, T) }; };
  const tri = scan('triphasic'), lo = scan('lowres'), bi = scan('biphasic'), ven = scan('venous');
  near(tri.mx, 1, 0.03, 'triphasic peak');
  assert.ok(tri.mn < -0.2, `triphasic reverses in early diastole (${tri.mn})`);
  near(tri.edv, 0, 0.03, 'triphasic EDV is zero');
  assert.ok(lo.mn > 0, 'low resistance never reverses');
  const ri = (lo.mx - lo.edv) / lo.mx;
  assert.ok(ri > 0.65 && ri < 0.82, `low-resistance RI ${ri}`);
  assert.ok(bi.mn > -0.02, `biphasic: no reversal (${bi.mn})`);
  assert.ok(bi.edv / bi.mx > 0.1 && bi.edv / bi.mx < 0.22, `biphasic EDV/PSV ${bi.edv / bi.mx}`);
  assert.ok(ven.mn < 0, 'central veins: the a wave reverses');
  // a beat is continuous across its own boundary: the neighbours are summed in
  for (const k of ['triphasic', 'lowres', 'biphasic', 'venous', 'pulmonary', 'steady']) {
    near(flowWave(k, 0, T), flowWave(k, T - 1e-6, T), 1e-4, `${k} wraps smoothly`);
  }
  // a faster heart cuts diastole, not systole: the low-resistance EDV rises
  assert.ok(flowWave('lowres', 60 / 120 - 0.01, 60 / 120) > lo.edv, 'EDV rises with heart rate');
  // inspiration slows the abdominal veins and speeds the thoracic ones
  assert.ok(respFactor('abdo', 1) < respFactor('abdo', 0) && respFactor('thorax', 1) > respFactor('thorax', 0));
  assert.equal(respFactor(undefined, 1), 1, 'arteries do not breathe');
});

test('laminar flow: a parabola puts equal lumen area at every speed (a full gate fills the window)', () => {
  // uniform points over a disc, binned by v/vmax: every decile holds a tenth of the area
  const r = seeded(3), bins = new Array(10).fill(0), N = 200000;
  for (let i = 0; i < N; i++) {
    const rho = Math.sqrt(r());                 // uniform in area
    bins[Math.min(9, Math.floor(laminar(rho) * 10))]++;
  }
  for (let b = 0; b < 10; b++) near(bins[b] / N, 0.1, 0.004, `decile ${b}`);
  assert.equal(laminar(0), 1); assert.equal(laminar(1), 0); near(laminar(0.5), 0.75, 1e-12, 'half radius');
});

test('the spectral column puts a tone where it belongs — and an aliased one where the wrap does', () => {
  const prf = 4000, nb = 128, P = new Float64Array(nb), r = seeded(11);
  const peakBin = (a) => { let k = 0; for (let i = 1; i < nb; i++) if (a[i] > a[k]) k = i; return k; };
  // no noise, no filter, no grain (rnd = 0 gives an exponential factor of 0? use a fixed 1/e draw)
  const one = () => 1 - Math.exp(-1);            // -ln(1 - u) = 1: the grain set to its mean
  spectrumColumn(P, [1, 900, 0], 1, prf, 0, 0, 0, one);
  assert.equal(peakBin(P), binOfShift(900, prf, 0, nb), 'in-window tone');
  spectrumColumn(P, [1, 2600, 0], 1, prf, 0, 0, 0, one);
  assert.equal(peakBin(P), binOfShift(-1400, prf, 0, nb), '2.6 kHz at 4 kHz PRF appears at -1.4 kHz');
  spectrumColumn(P, [1, 2600, 0], 1, prf, 0.5, 0, 0, one);
  assert.equal(peakBin(P), binOfShift(2600, prf, 0.5, nb), 'baseline lowered: it fits, unwrapped');
  // power is conserved by the analysis smear
  spectrumColumn(P, [2, 1000, 0], 1, prf, 0, 0, 0, one);
  near(P.reduce((a, b) => a + b, 0), 4, 1e-4, 'total power a^2');
  // the envelope finds the top of a band, on its own side of the baseline
  const band = []; for (let f = 200; f <= 1500; f += 25) band.push(1, f, 0);
  spectrumColumn(P, band, band.length / 3, prf, 0, 0, 1e-2, r);
  const env = maxEnvelope(P, prf, 0, 1e-2);
  near(env.pos, 1500, 2 * prf / nb, 'envelope at the band top');
  assert.equal(env.neg, 0, 'nothing on the negative side');
});

test('PSV, EDV and RI are read off the last complete beat', () => {
  // a synthetic envelope: three beats of a low-resistance waveform at 100 columns a beat
  const T = 1, rows = [];
  for (let i = 0; i < 330; i++) {
    const t = (i % 100) / 100;
    rows.push({ pos: 80 * flowWave('lowres', t * 0.8, 0.8), neg: 0, wrap: i % 100 === 0 && i > 0 });
  }
  const m = peakMeasures(rows);
  near(m.psv, 80, 2, 'PSV');
  near(m.edv, 80 * flowWave('lowres', 0.99 * 0.8, 0.8), 2, 'EDV at end diastole');
  near(m.ri, (m.psv - m.edv) / m.psv, 1e-12, 'RI');
  assert.equal(m.dir, 1);
  // flow away from the probe: the same numbers, read below the baseline
  const away = rows.map((r) => ({ pos: 0, neg: -r.pos, wrap: r.wrap }));
  const m2 = peakMeasures(away);
  near(m2.psv, m.psv, 1e-9, 'PSV of flow away'); assert.equal(m2.dir, -1);
  assert.equal(peakMeasures(rows.slice(0, 150)), null, 'no whole beat yet');
  // triphasic: EDV is where the trace ENDS, zero — not the early-diastolic reversal, which is
  // the lowest point of the beat and a different measurement
  const tri = [];
  for (let i = 0; i < 330; i++) {
    const v = 100 * flowWave('triphasic', ((i % 100) / 100) * 0.8, 0.8);
    tri.push({ pos: Math.max(0, v), neg: Math.min(0, v), wrap: i % 100 === 0 && i > 0 });
  }
  const m3 = peakMeasures(tri);
  near(m3.psv, 100, 2, 'triphasic PSV');
  near(m3.edv, 0, 2, 'triphasic EDV');
  near(m3.ri, 1, 0.02, 'high resistance: RI 1');
  void T;
});
