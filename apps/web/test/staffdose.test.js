// Staff dose in fluoroscopy: the protection rules a C-arm operator is taught, as numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staffPulse, staffEffective, scatterAngleFactor, skinEntranceMGy } from '../src/core/staffDose.js';

// a supine patient on a table whose top is at y = 0, floor 90 cm below; operator 60 cm from the
// beam on the patient's right (+x)
const FLOOR = -90, TABLE = 0;
const UP = [0, 1, 0], DOWN = [0, -1, 0];
const under = { beamDir: UP, entry: [0, 0, 0] };          // beam enters the back, at the table
const over = { beamDir: DOWN, entry: [0, 24, 0] };        // beam enters the front, 24 cm up
const base = { dapUGym2: 100, op: { x: 60, z: 0 }, floorY: FLOOR, tableTopY: TABLE };

test('backscatter outweighs side scatter, which outweighs forward scatter', () => {
  assert.ok(scatterAngleFactor(-1) > scatterAngleFactor(0));
  assert.ok(scatterAngleFactor(0) > scatterAngleFactor(1));
  assert.equal(scatterAngleFactor(0), 1);
});

test('tube under the table: the legs take it, not the eyes; over the table: the reverse', () => {
  const u = staffPulse({ ...base, ...under });
  const o = staffPulse({ ...base, ...over });
  assert.ok(u.eyes < u.legs / 3, `under: eyes ${u.eyes.toFixed(2)} vs legs ${u.legs.toFixed(2)}`);
  assert.ok(o.eyes > o.legs * 2, `over: eyes ${o.eyes.toFixed(2)} vs legs ${o.legs.toFixed(2)}`);
  assert.ok(o.eyes > 4 * u.eyes, 'turning the tube over the table multiplies the eye dose');
});

test('on a lateral, the tube side is several times the detector side', () => {
  // beam travels -x (tube on the +x side): the operator at +x stands on the tube side
  const lat = { beamDir: [-1, 0, 0], entry: [15, 12, 0] };
  const tubeSide = staffPulse({ ...base, ...lat, op: { x: 75, z: 0 } });
  const detSide = staffPulse({ ...base, ...lat, entry: [15, 12, 0], op: { x: -45, z: 0 } });
  assert.ok(tubeSide.thyroid > 3 * detSide.thyroid,
    `thyroid tube side ${tubeSide.thyroid.toFixed(2)} vs detector side ${detSide.thyroid.toFixed(2)}`);
});

test('a step back follows the inverse square, and dose follows the DAP', () => {
  const near = staffPulse({ ...base, ...under, op: { x: 60, z: 0 } });
  const twice = staffPulse({ ...base, ...under, dapUGym2: 200 });
  assert.ok(Math.abs(twice.legs / near.legs - 2) < 1e-9);
  const far = staffPulse({ ...base, ...under, op: { x: 180, z: 0 } });
  assert.ok(far.trunk < near.trunk / 3);
});

test('each item of lead protects what it covers, and only that', () => {
  const bare = staffPulse({ ...base, ...under });
  const apron = staffPulse({ ...base, ...under, prot: { apron: true } });
  assert.ok(Math.abs(apron.trunk / bare.trunk - 0.05) < 1e-9);
  assert.equal(apron.eyes, bare.eyes);
  const skirt = staffPulse({ ...base, ...under, prot: { skirt: true } });
  assert.ok(skirt.legs < bare.legs / 5 && skirt.eyes === bare.eyes);
  const glasses = staffPulse({ ...base, ...over, prot: { glasses: true } });
  assert.ok(glasses.eyes < staffPulse({ ...base, ...over }).eyes / 2);
  // the collar dosimeter reads the bare neck either way
  const collar = staffPulse({ ...base, ...under, prot: { collar: true } });
  assert.equal(collar.neckBare, bare.neckBare);
  assert.ok(collar.thyroid < bare.thyroid / 10);
});

test('effective dose: Niklason under an apron, the trunk without', () => {
  const acc = { trunk: 10, neckBare: 200 };
  assert.equal(staffEffective(acc, true), 0.5 * 10 + 0.025 * 200);
  assert.equal(staffEffective(acc, false), 10);
});

test('the skin pays the inverse square when the patient is brought toward the tube', () => {
  const ref = skinEntranceMGy(10, 45, 45, false);
  assert.ok(Math.abs(ref - 13.5) < 1e-9, 'at the reference point: kerma x backscatter');
  assert.ok(skinEntranceMGy(10, 45, 35, false) > 1.6 * ref, '10 cm closer');
  assert.ok(skinEntranceMGy(10, 45, 45, true) < ref, 'the tabletop takes its share first');
  assert.equal(skinEntranceMGy(10, 45, null, false), 0);
});
