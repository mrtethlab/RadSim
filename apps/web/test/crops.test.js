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
