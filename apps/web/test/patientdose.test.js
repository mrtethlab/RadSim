// X-ray patient dose: the readout exists to show that the radiographer's choices cost or save
// dose, so the tests pin the relations a student is meant to see, and keep the absolute numbers
// near published reference levels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tubeOutput, incidentKerma, backscatter, entryDistance, radiographDose } from '../src/core/patientDose.js';

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

test('kerma follows mAs, the inverse square and about kV squared', () => {
  assert.ok(near(incidentKerma(80, 20, 100), 2 * incidentKerma(80, 10, 100)), 'double the mAs');
  assert.ok(near(incidentKerma(80, 10, 200), incidentKerma(80, 10, 100) / 4), 'double the distance');
  assert.ok(near(tubeOutput(120) / tubeOutput(60), 4), 'kV squared');
  assert.ok(tubeOutput(80) > 30 && tubeOutput(80) < 80, 'a typical tube at 80 kV');
});

test('DAP does not change with distance, and collimation moves it directly', () => {
  const base = { kv: 80, mas: 20, fsdCm: 80, fieldCm2: 35 * 43 };
  const a = radiographDose({ ...base, sidCm: 100 });
  // the same beam measured at 150 cm covers 2.25x the area at 1/2.25 the kerma
  const b = radiographDose({ ...base, sidCm: 150, fieldCm2: 35 * 43 * 2.25 });
  assert.ok(near(a.dapUGym2, b.dapUGym2), 'the same beam, measured further out');
  const half = radiographDose({ ...base, sidCm: 100, fieldCm2: 35 * 43 / 2 });
  assert.ok(near(half.dapUGym2, a.dapUGym2 / 2), 'half the field, half the DAP');
  assert.ok(Math.abs(half.esdMGy / a.esdMGy - 1) < 0.05, 'collimation barely moves the ESD (backscatter only)');
});

test('the skin dose falls when the tube is moved back at the same receptor dose', () => {
  // keep the receptor kerma: mAs scales with SID², the skin is further from the focus too
  const at = (sid) => radiographDose({ kv: 120, mas: 2.5 * (sid / 180) ** 2, sidCm: sid, fsdCm: sid - 30, fieldCm2: 35 * 43 });
  assert.ok(at(180).esdMGy < at(100).esdMGy, 'a longer SID spares the skin');
});

test('backscatter grows with field size and beam quality, within published values', () => {
  assert.ok(backscatter(80, 400) > backscatter(80, 100));
  assert.ok(backscatter(120, 400) > backscatter(60, 400));
  for (const [kv, a] of [[60, 100], [80, 400], [120, 1500]]) {
    const b = backscatter(kv, a);
    assert.ok(b > 1.2 && b < 1.5, `BSF ${b.toFixed(2)} at ${kv} kV, ${a} cm²`);
  }
});

test('the entrance surface is found to the millimetre, and a miss reports none', () => {
  // a patient whose skin is 72.3 cm from the focus, 25 cm thick
  const tissueTo = (s) => Math.max(0, Math.min(s, 97.3) - 72.3);
  assert.ok(Math.abs(entryDistance(tissueTo, 140) - 72.3) <= 0.1);
  assert.equal(entryDistance(() => 0, 140), null);
});

test('reference examinations land near their diagnostic reference levels', () => {
  // PA chest, 120 kV 2.5 mAs at 180 cm, a 25 cm chest: ESD ~0.1-0.2 mGy, DAP ~0.1 Gy·cm²
  const chest = radiographDose({ kv: 120, mas: 2.5, sidCm: 180, fsdCm: 150, fieldCm2: 35 * 43 });
  assert.ok(chest.esdMGy > 0.08 && chest.esdMGy < 0.3, `PA chest ESD ${chest.esdMGy.toFixed(3)} mGy`);
  assert.ok(chest.dapUGym2 > 5 && chest.dapUGym2 < 25, `PA chest DAP ${chest.dapUGym2.toFixed(1)} µGy·m²`);
  // AP pelvis, 80 kV 25 mAs at 115 cm, 22 cm patient on a 5 cm table gap: ESD ~2-4 mGy
  const pelvis = radiographDose({ kv: 80, mas: 25, sidCm: 115, fsdCm: 88, fieldCm2: 43 * 35 });
  assert.ok(pelvis.esdMGy > 1.5 && pelvis.esdMGy < 4.5, `AP pelvis ESD ${pelvis.esdMGy.toFixed(2)} mGy`);
});

test('a ray that misses the patient still has a DAP but no entrance dose', () => {
  const d = radiographDose({ kv: 70, mas: 5, sidCm: 100, fsdCm: null, fieldCm2: 24 * 30 });
  assert.ok(d.dapUGym2 > 0);
  assert.equal(d.esdMGy, null);
});
