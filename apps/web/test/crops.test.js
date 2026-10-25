import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyCrops } from '../src/core/crops.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../src/data/${f}.json`, import.meta.url), 'utf8'));
const crops = read('crops');
const fresh = () => ({ joints: read('joints'), landmarks: read('landmarks'), centring: read('centring'), palpation: read('palpation') });
const near = (a, b, tol = 0.011) => a.every((v, i) => Math.abs(v - b[i]) < tol);

test('the foot takes the ankle and the foot points of the lower extremity, shifted into its frame', () => {
  const d = fresh(), c = crops.foot, src = read('joints').lowerextremity;
  applyCrops(crops, d);
  // the ankle is the foot's; the knee (its patella grid is the leg's) is out of the box
  assert.deepEqual(Object.keys(d.joints.foot), ['ankle']);
  assert.ok(near(d.joints.foot.ankle.c, src.ankle.c.map((v, i) => v + c.rest[i]), 0.001));
  assert.deepEqual(d.joints.foot.ankle.motions, src.ankle.motions);   // directions do not move
  // rest-frame points move by crop.rest, volume-frame landmarks by crop.volume
  const pm = read('palpation').lowerextremity.medialMalleolus, fm = d.palpation.foot.medialMalleolus;
  assert.ok(near([fm.x, fm.y, fm.z], [pm.x + c.rest[0], pm.y + c.rest[1], pm.z + c.rest[2]]));
  const la = read('landmarks').lowerextremity.ankle, fa = d.landmarks.foot.ankle;
  assert.ok(near([fa.x, fa.y, fa.z], [la.x + c.volume[0], la.y + c.volume[1], la.z + c.volume[2]]));
  // what lies above the box stays the leg's
  for (const k of ['patella', 'tibialTuberosity']) assert.equal(d.palpation.foot[k], undefined);
  for (const k of ['knee', 'hip', 'femur']) assert.equal(d.landmarks.foot[k], undefined);
  assert.deepEqual(Object.keys(d.centring.foot).sort(), Object.keys(read('centring').lowerextremity).sort());
  // the source is left as it was
  assert.deepEqual(d.joints.lowerextremity, read('joints').lowerextremity);
});

test('a crop whose box holds none of a joint gets no joints', () => {
  const d = fresh();
  applyCrops({ toe: { of: 'lowerextremity', rest: [0, 0, 0], volume: [0, 0, 0], z: [-60, -59] } }, d);
  assert.equal(d.joints.toe, undefined);
  assert.deepEqual(d.palpation.toe, {});
});

test('the AP and oblique foot and toes lay the sole flat: the leg raised as a flexed knee does, on the Foot', async () => {
  const JP = await import('../src/core/jointPose.js'), { eulerMatrix } = await import('../src/core/voxelPhantom.js');
  const d = fresh(); applyCrops(crops, d);
  const protocols = read('protocols'), all = protocols.groups.flatMap((g) => g.regions.flatMap((r) => r.projections));
  const chain = Object.values(d.joints.foot).map((j) => ({ ...j, motions: j.motions.map((m) => ({ ...m, axis: JP.axisToward(m.from || j.distal, m.toward) })) }));
  for (const proj of ['AP foot', 'Oblique foot', 'AP toes', 'Oblique toes']) {
    const p = all.find((x) => x.proj === proj), D = Math.PI / 180;
    assert.equal(p.subject, 'foot', proj);
    // the foot's long axis (the one the ankle's flexion is measured from: parallel to the sole, the
    // Trainer's soleAngle) through the bent ankle and the tilt and roll, against the receptor
    const ank = d.joints.foot.ankle, toes = ank.motions.find((m) => m.key === 'ankle.flex').from;
    const a = JP.forwardChain(ank.c, chain, p.pose.joints), b = JP.forwardChain(ank.c.map((x, i) => x + 5 * toes[i]), chain, p.pose.joints);
    const R = eulerMatrix((p.pose.tilt || 0) * D, 0, (p.pose.roll || 0) * D), v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const up = R[3] * v[0] + R[4] * v[1] + R[5] * v[2];
    const sole = Math.asin(up / Math.hypot(...v)) / D;
    assert.ok(Math.abs(sole) < 2, `${proj}: the sole ${sole.toFixed(1)} degrees off the receptor`);
  }
});
