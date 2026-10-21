// Joint posing: bending a rigid CT at a joint, for the volume, the mesh and the landmarks alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blendWeight, rotate, axisToward, forwardChain, preimagesChain, poseVolume } from '../src/core/jointPose.js';

const near = (a, b, t = 1e-9) => Math.abs(a - b) <= t;
// a wrist at the origin, the hand along +z; ulnar deviation turns the hand toward -x
const wrist = { c: [0, 0, 0], distal: [0, 0, 1], blend: 1,
  motions: [{ key: 'dev', axis: axisToward([0, 0, 1], [-1, 0, 0]) }, { key: 'flex', axis: axisToward([0, 0, 1], [0, -1, 0]) }] };

test('the share of the turn rises smoothly across the crease', () => {
  assert.equal(blendWeight(-2, 1), 0);
  assert.equal(blendWeight(2, 1), 1);
  assert.ok(near(blendWeight(0, 1), 0.5));
});

test('a positive angle turns the distal part toward the named direction', () => {
  const tip = forwardChain([0, 0, 8], [wrist], { dev: 90 });
  assert.ok(near(tip[0], -8, 1e-9) && near(tip[2], 0, 1e-9), `ulnar 90 deg: ${tip}`);
  const f = forwardChain([0, 0, 8], [wrist], { flex: 30 });
  assert.ok(f[1] < -3.9 && f[1] > -4.1, 'flexion takes the fingers palmar (-y)');
  // the forearm does not move
  assert.deepEqual(forwardChain([1, 2, -5], [wrist], { dev: 40, flex: 20 }), [1, 2, -5]);
  // and distances from the joint are kept beyond the crease (a rigid turn)
  const p = forwardChain([2, 1, 6], [wrist], { dev: 25, flex: 40 });
  assert.ok(near(Math.hypot(...p), Math.hypot(2, 1, 6), 1e-9));
});

test('every posed point has its rest point among the pre-images', () => {
  const angles = { dev: 30, flex: -20 };
  for (const p of [[0, 0, 6], [1, -1, 0.4], [0.5, 0.5, -0.3], [-2, 1, 3], [0, 0, -6]]) {
    const q = forwardChain(p, [wrist], angles);
    const back = preimagesChain(q, [wrist], angles);
    assert.ok(back.some((b) => Math.hypot(b[0] - p[0], b[1] - p[1], b[2] - p[2]) < 1e-3), `rest point of ${p}`);
  }
});

test('a chain carries the distal joint along with the proximal one', () => {
  const elbow = { c: [0, 0, 0], distal: [0, 0, -1], blend: 1, motions: [{ key: 'elbow', axis: axisToward([0, 0, -1], [0, 1, 0]) }] };
  const wr = { c: [0, 0, -25], distal: [0, 0, -1], blend: 1, motions: [{ key: 'dev', axis: axisToward([0, 0, -1], [1, 0, 0]) }] };
  const finger = [0, 0, -33];
  const q = forwardChain(finger, [elbow, wr], { elbow: 90, dev: 0 });
  assert.ok(near(q[1], 33, 1e-9) && near(q[2], 0, 1e-9), `elbow flexed 90: the hand points forward ${q}`);
  const q2 = forwardChain(finger, [elbow, wr], { elbow: 90, dev: 90 });
  assert.ok(near(q2[0], 8, 1e-9) && near(q2[1], 25, 1e-9), `then deviated: ${q2}`);
});

test('the volume is resampled into the pose, padded where the limb now reaches', () => {
  // a rod of tissue along z through a wrist at the centre, 1 cm voxels: 3 x 3 x 21
  const nx = 3, ny = 3, nz = 21, data = new Uint8Array(nx * ny * nz).fill(10);
  const vm = { dims: [nx, ny, nz], spacingMM: [10, 10, 10], data };
  const posed = poseVolume(vm, [false, false, false], [wrist], { dev: 90 });
  // the distal half now lies along -x: the volume grows in x to hold it
  assert.ok(posed.dims[0] > nx, `padded in x: ${posed.dims}`);
  const [Nx, Ny, Nz] = posed.dims;
  const at = (x, y, z) => posed.data[((Math.round(z + (Nz - 1) / 2)) * Ny + Math.round(y + (Ny - 1) / 2)) * Nx + Math.round(x + (Nx - 1) / 2)];
  assert.equal(at(-7, 0, 0), 10, 'tissue where the hand turned to');
  assert.equal(at(0, 0, 7), 0, 'air where it was');
  assert.equal(at(0, 0, -7), 10, 'the forearm stays');
});

test('only the limb moves: tissue beside it, outside its cylinder, stays (the flank by an arm)', () => {
  // a forearm rod along -z from an elbow at the origin, and a block of "flank" 10 cm to the side
  const nx = 25, ny = 5, nz = 21, data = new Uint8Array(nx * ny * nz);
  const idx = (x, y, z) => ((z + 10) * ny + (y + 2)) * nx + (x + 12);
  for (let z = -10; z <= 10; z++) for (let y = -1; y <= 1; y++) {
    for (let x = -1; x <= 1; x++) data[idx(x, y, z)] = 10;           // the arm
    for (let x = 9; x <= 11; x++) data[idx(x, y, z)] = 10;           // the flank
  }
  const elbow = { c: [0, 0, 0], distal: [0, 0, -1], blend: 1, radius: 4,
    motions: [{ key: 'flex', axis: axisToward([0, 0, -1], [0, 1, 0]) }] };
  const vm = { dims: [nx, ny, nz], spacingMM: [10, 10, 10], data };
  const r = poseVolume(vm, [false, false, false], [elbow], { flex: 90 });
  const [Nx, Ny, Nz] = r.dims;
  const at = (x, y, z) => r.data[((Math.round(z + (Nz - 1) / 2)) * Ny + Math.round(y + (Ny - 1) / 2)) * Nx + Math.round(x + (Nx - 1) / 2)];
  assert.equal(at(10, 0, -8), 10, 'the flank below the elbow is still there');
  assert.equal(at(0, 0, -8), 0, 'the forearm has left');
  assert.equal(at(0, 7, 0), 10, 'and is in front of the elbow');
  // and a landmark on the flank does not move
  assert.deepEqual(forwardChain([10, 0, -8], [elbow], { flex: 90 }), [10, 0, -8]);
});

test('angles are anatomical: unset means the model as scanned, and the turn is from its rest', () => {
  const j = { ...wrist, motions: [{ key: 'dev', axis: wrist.motions[0].axis, rest: 26 }] };
  assert.deepEqual(forwardChain([0, 0, 8], [j], {}), [0, 0, 8], 'unset: as scanned');
  assert.deepEqual(forwardChain([0, 0, 8], [j], { dev: 26 }), [0, 0, 8], 'set to its own rest: unmoved');
  const t = forwardChain([0, 0, 8], [j], { dev: 0 });          // straightened: turned 26 deg radially
  assert.ok(Math.abs(Math.atan2(t[0], t[2]) * 180 / Math.PI - 26) < 1e-6, `straightened ${t}`);
});
