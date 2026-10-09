// The technique chart and the exposure index it is judged by. Three things went wrong together
// and each read like a miscalibrated chart: the EI found raw beam only if the field had some, it
// read the thinnest anatomy rather than the exam's own region, and the scatter fog was set by the
// thinnest tissue at the field edge. Then the patients are larger than the adult a chart assumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Detector, EI_K, AEC_CHAMBER_CAL } from '../src/core/detector.js';
import { caliperOf, sizeCorrection, voiPercentile, nearestStation } from '../src/core/technique.js';
import { patientPrimary } from '../src/core/scatter.js';
import { Spectrum } from '../src/core/spectrum.js';
import { muOverBins } from '../src/core/voxelPhantom.js';

const PS = 1e9;   // photons per unit dose: noise negligible, so the EI is the dose itself
const WATER = 3, AIR = 0, LUNG = 1, BONE = 18;
const path = (entries) => { const L = new Float64Array(64); for (const [m, l] of entries) L[m] = l; return L; };
const correction = (L, tRef, kv) => { const bins = Spectrum.make(kv).bins; return sizeCorrection(L, tRef, muOverBins(bins), bins); };

test('the EI finds raw beam by transmission, so a field with none keeps all its anatomy', () => {
  // an AP lumbar collimated inside the body: every pixel transmits 0.2-1 %, none is raw beam.
  // The old rule called the brightest 2 % "direct" and threw away everything above 60 % of it.
  // (open beam 100 units, so the EI is a whole number well clear of rounding)
  const n = 100_000, d = new Float32Array(n), direct = new Float32Array(n).fill(100), mask = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) d[i] = 0.2 + 0.8 * (i % 1000) / 1000;
  const { EI } = Detector.capture(d, n, 1, PS, mask, direct, 0.5);
  assert.ok(Math.abs(EI / (0.6 * EI_K) - 1) < 0.02, `EI ${EI}: the median anatomy reads ${0.6 * EI_K}`);
  const old = Detector.capture(d, n, 1, PS, mask, null, 0.5).EI;   // the brightest-2 %-is-raw-beam rule
  assert.ok(old < 0.85 * EI, `the old rule should have read low here: ${old} vs ${EI}`);
  // and where there IS raw beam, it is still set aside
  for (let i = 0; i < n / 2; i++) d[i] = 95;
  const half = Detector.capture(d, n, 1, PS, mask, direct, 0.5).EI;
  assert.ok(half < 1.2 * EI_K, `raw beam leaked into the VOI: EI ${half}`);
});

test('a chest is judged on its lung fields, every other exam on the median of its anatomy', () => {
  assert.equal(voiPercentile('Chest', 'chest'), 0.90);
  for (const part of ['Upper extremity', 'Lower extremity', 'Abdomen / Pelvis', 'Spine', 'Head']) assert.equal(voiPercentile(part, 'x'), 0.50);
  assert.equal(voiPercentile(null, 'chest'), 0.90);
  assert.equal(voiPercentile(null, 'hand'), 0.50);
});

test('the scatter fog follows the typical primary, not the thinnest tissue at the field edge', () => {
  // an abdomen at 0.2 % transmission; then the same field with an eighth of it on thin thigh at 30 %
  const n = 80_000, direct = new Float32Array(n).fill(1), mask = new Uint8Array(n).fill(1);
  const abdomen = new Float32Array(n).fill(0.002);
  const withThigh = Float32Array.from(abdomen, (v, i) => (i < n / 8 ? 0.30 : v));
  const a = patientPrimary(abdomen, direct, mask).median, b = patientPrimary(withThigh, direct, mask).median;
  assert.equal(b, a, 'a strip of thin tissue at the edge must not change the fog over the abdomen');
  // (the mean it replaced would have gone up nineteen-fold)
  const mean = withThigh.reduce((s, v) => s + v, 0) / n;
  assert.ok(mean / a > 15);
  // raw beam is not patient at all
  const raw = Float32Array.from(abdomen, (v, i) => (i < n / 2 ? 0.95 : v));
  assert.equal(patientPrimary(raw, direct, mask).n, n / 2);
});

test('calipers measure the body, lung included, and not the air around it', () => {
  assert.equal(caliperOf(path([[AIR, 40], [WATER, 20], [LUNG, 8], [BONE, 2]])), 30);
});

test('a patient thicker than the chart needs more mAs, by the transmission of the extra tissue', () => {
  const abdo = path([[WATER, 31]]);
  const r = correction(abdo, 22, 80);
  assert.equal(r.t, 31);
  // 9 cm of water at 80 kV with a hardened beam: e^(0.2 x 9) ~ 6, less as the beam hardens
  assert.ok(r.factor > 4 && r.factor < 9, `factor ${r.factor.toFixed(2)}`);
  assert.ok(Math.abs(correction(abdo, 31, 80).factor - 1) < 1e-9, 'the chart patient needs the chart mAs');
  assert.ok(correction(abdo, 40, 80).factor < 1, 'a thinner patient needs less');
  // higher kV penetrates better, so the same 9 cm costs less
  assert.ok(correction(abdo, 22, 110).factor < r.factor);
  // lung counts toward the caliper but barely attenuates: a chest of the same caliper needs about
  // half the correction (3.6x against 7.0x)
  const chest = path([[WATER, 15], [LUNG, 16]]);
  assert.ok(correction(chest, 22, 80).factor < 0.6 * r.factor);
  assert.equal(correction(path([[AIR, 50]]), 22, 80), null, 'a ray that misses the patient corrects nothing');
});

test('mAs snaps to the console stations', () => {
  const steps = [0.5, 1.0, 1.25, 1.6, 250, 320];
  assert.equal(nearestStation(1.1, steps), 1.0);
  assert.equal(nearestStation(1.5, steps), 1.6);
  assert.equal(nearestStation(274, steps), 250);
  assert.equal(nearestStation(5000, steps), 320);
});

test('the chart: stations only, thicknesses where the console measures, and the excluded views say why', () => {
  const protocols = JSON.parse(readFileSync(new URL('../src/data/protocols.json', import.meta.url), 'utf8'));
  const all = protocols.groups.flatMap((g) => g.regions.flatMap((r) => r.projections.map((p) => ({ ...p, part: g.part }))));
  const STATIONS = new Set([0.5, 0.63, 0.8, 1.0, 1.25, 1.6, 2.0, 2.5, 3.2, 4.0, 5.0, 6.4, 8.0, 10, 12.5, 16, 20, 25, 32, 40, 50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 600]);
  for (const p of all) assert.ok(STATIONS.has(p.mas), `${p.proj}: ${p.mas} mAs is not a console station`);
  const measured = all.filter((p) => p.cm);
  assert.equal(measured.length, 13);
  for (const p of measured) {
    assert.ok(['Chest', 'Abdomen / Pelvis', 'Spine', 'Head'].includes(p.part), `${p.proj}: calipers are for trunk and skull`);
    assert.ok(p.cm >= 12 && p.cm <= 35, `${p.proj}: ${p.cm} cm`);
  }
  for (const n of ['Lateral cervical', 'Lateral forearm']) {
    const p = all.find((x) => x.proj === n);
    assert.equal(p.pose.fidelity, 'approx', `${n} cannot be a true view on this subject`);
  }
});

test('the AEC is calibrated the way a real one is: on a uniform phantom', () => {
  // chamber dose = receptor dose, so the operator's choice of chamber decides the exposure. The
  // fitted 6.1 it replaces made a chest on the correct (lateral) chambers read DI -6.6.
  assert.equal(AEC_CHAMBER_CAL, 1);
});
