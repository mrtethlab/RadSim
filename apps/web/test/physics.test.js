// Beam and material physics. The K-edges are what contrast imaging is built on, so their
// jumps are pinned; the spectrum is pinned as a CHARACTERISATION (see the note on it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Spectrum } from '../src/core/spectrum.js';
import { BodyMaterials } from '../src/core/materials.js';

test('spectrum weights are a distribution and the beam hardens with kVp', () => {
  let last = 0;
  for (const kv of [50, 60, 70, 80, 100, 120]) {
    const sp = Spectrum.make(kv);
    const sum = sp.bins.reduce((s, b) => s + b.w, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${kv} kVp weights sum to ${sum}`);
    assert.ok(sp.bins.every((b) => b.w >= 0 && b.E <= kv), `${kv} kVp bins in range`);
    assert.ok(sp.meanE > last, `mean energy rises with kVp (${kv}: ${sp.meanE.toFixed(2)} keV)`);
    last = sp.meanE;
  }
});

// CHARACTERISATION, not a statement of correctness. The weights are (kVp - E), Kramers'
// ENERGY-fluence form; if the engine reads them as photon counts the beam is too hard (the
// audit of Oct 2026 raised this). Every calibration in the app — EI_K, the AEC chamber, the
// APR chart — was tuned on top of these exact numbers, so any change to the spectrum must be
// deliberate, re-calibrated, and update this table. That is the point of pinning it.
test('mean beam energy is pinned (change only with a re-calibration)', () => {
  const pinned = { 60: 35.906, 70: 40.087, 80: 44.046, 100: 51.655, 120: 58.996 };
  for (const [kv, keV] of Object.entries(pinned)) {
    const got = Spectrum.make(+kv).meanE;
    assert.ok(Math.abs(got - keV) < 0.01, `${kv} kVp mean ${got.toFixed(3)} keV, pinned ${keV}`);
  }
});

test('iodine K-edge at 33.17 keV: a jump of ~4x, not a smoothed ramp', () => {
  const below = BodyMaterials.muIodinePerConc(33.16), above = BodyMaterials.muIodinePerConc(33.18);
  assert.ok(above / below > 3.5, `iodine jump ${(above / below).toFixed(2)}`);
});

test('barium K-edge at 37.44 keV: jump 5.42, as measured when it was built', () => {
  const below = BodyMaterials.muBariumPerConc(37.43), above = BodyMaterials.muBariumPerConc(37.45);
  assert.ok(Math.abs(above / below - 5.42) < 0.05, `barium jump ${(above / below).toFixed(2)}`);
});

test('HU is anchored on water: water reads 0 and air reads -1000', () => {
  // huOf is evaluated at the reference energy EREF, which is what the CT scale is defined at
  assert.equal(BodyMaterials.huOf(BodyMaterials.idByName.Water), 0);
  assert.ok(Math.abs(BodyMaterials.huOf(BodyMaterials.idByName.Air) + 1000) <= 1);
});

test('lead K-edge at 88 keV is visible', () => {
  // just below the edge lead keeps falling; just above it jumps ~4x (NIST: 1.910 -> 7.683)
  const id = BodyMaterials.idByName.Lead ?? BodyMaterials.idByName['Lead (Pb)'];
  assert.ok(id != null, 'lead is in the legend');
  const mu = (e) => BodyMaterials.muById(id, e);
  assert.ok(mu(87.9) < mu(80), 'below the edge, attenuation still falls with energy');
  const jump = mu(88.02) / mu(87.99);
  assert.ok(jump > 3.8 && jump < 4.2, `lead K-edge jump ${jump.toFixed(2)} (NIST 4.02)`);
  assert.ok(Math.abs(mu(150) / 11.35 - 2.014) < 0.01, 'the 150 keV point is NIST, not the pre-edge value');
});
