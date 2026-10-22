// Joint posing: bending a rigid CT at a joint, for the volume, the mesh and the landmarks alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blendWeight, rotate, axisToward, forwardChain, preimagesChain, poseVolume, compileChain, forwardCompiled, forwardSkin } from '../src/core/jointPose.js';

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

test('the crook folds on the bisector: neither piece pushes into the other', () => {
  // a thick limb, 9 x 3 x 41 at 1 cm, the upper arm (1) above an elbow at the origin and the
  // forearm (2) below; flexed 90 degrees the forearm swings to +x, and its front corner used to
  // rise beside the upper arm's front (a straight-edged block of doubled tissue on the film)
  const nx = 9, ny = 3, nz = 41, data = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[(k * ny + j) * nx + i] = k >= 20 ? 1 : 2;
  const elbow = { c: [0, 0, 0], distal: [0, 0, -1], blend: 1, motions: [{ key: 'flex', axis: axisToward([0, 0, -1], [1, 0, 0]) }] };
  const r = poseVolume({ dims: [nx, ny, nz], spacingMM: [10, 10, 10], data }, [false, false, false], [elbow], { flex: 90 });
  const [Nx, Ny, Nz] = r.dims;
  const at = (x, y, z) => r.data[((Math.round(z + (Nz - 1) / 2)) * Ny + Math.round(y + (Ny - 1) / 2)) * Nx + Math.round(x + (Nx - 1) / 2)];
  // the crook: x and z both in (0, 4]; above the diagonal is the upper arm's, below the forearm's
  for (let x = 1; x <= 4; x++) for (let z = 1; z <= 4; z++) {
    if (x === z) continue;
    const v = at(x, 0, z);
    assert.ok(v === 0 || v === (z > x ? 1 : 2), `at x ${x}, z ${z}: ${v}`);
  }
  assert.equal(at(1, 0, 3), 1, 'the upper arm keeps its front above the fold');
  assert.equal(at(3, 0, 1), 2, 'the forearm fills below it');
  assert.equal(at(0, 0, 10), 1, 'the upper arm is untouched away from the joint');
  assert.equal(at(10, 0, 0), 2, 'and the forearm lies along +x');
});

test('angles are anatomical: unset means the model as scanned, and the turn is from its rest', () => {
  const j = { ...wrist, motions: [{ key: 'dev', axis: wrist.motions[0].axis, rest: 26 }] };
  assert.deepEqual(forwardChain([0, 0, 8], [j], {}), [0, 0, 8], 'unset: as scanned');
  assert.deepEqual(forwardChain([0, 0, 8], [j], { dev: 26 }), [0, 0, 8], 'set to its own rest: unmoved');
  const t = forwardChain([0, 0, 8], [j], { dev: 0 });          // straightened: turned 26 deg radially
  assert.ok(Math.abs(Math.atan2(t[0], t[2]) * 180 / Math.PI - 26) < 1e-6, `straightened ${t}`);
});

// a forearm along -z from an elbow at the origin: flexion toward +y, and a roll about the forearm
// (+ turns +y toward +x: supination, on this right arm)
const rollElbow = (spread) => ({ c: [0, 0, 0], distal: [0, 0, -1], blend: 1, spread,
  motions: [{ key: 'flex', axis: axisToward([0, 0, -1], [0, 1, 0]) },
            { key: 'roll', roll: true, axis: axisToward([0, 1, 0], [1, 0, 0]) }] });

test('a roll turns the distal part about its own axis, and keeps its distance along the limb', () => {
  const J = rollElbow(0);
  const p = forwardChain([0, 1, -6], [J], { roll: 90 });
  assert.ok(near(p[0], 1, 1e-9) && near(p[1], 0, 1e-9) && near(p[2], -6, 1e-9), `rolled: ${p}`);
  assert.deepEqual(forwardChain([0, 1, 3], [J], { roll: 90 }), [0, 1, 3], 'above the joint nothing rolls');
  // spread over the forearm: half way along, half the roll
  const q = forwardChain([0, 1, -5.5], [rollElbow(10)], { roll: 90 });   // (1 cm to 10 cm: half way at 5.5)
  assert.deepEqual(forwardChain([0, 1, -0.5], [rollElbow(10)], { roll: 90 }), [0, 1, -0.5], 'the joint itself does not turn');
  assert.ok(near(Math.atan2(q[0], q[1]) * 180 / Math.PI, 45, 1e-6), `half rolled: ${q}`);
});

test('a roll and a bend together invert exactly', () => {
  const J = rollElbow(10), angles = { flex: 60, roll: -70 };
  for (const p of [[0.5, 1, -6], [-1, 0.3, -12], [1, -1, -0.5], [0.2, 0.4, 4]]) {
    const q = forwardChain(p, [J], angles);
    const back = preimagesChain(q, [J], angles);
    assert.ok(back.some((b) => Math.hypot(b[0] - p[0], b[1] - p[1], b[2] - p[2]) < 1e-3), `rest point of ${p}`);
  }
});

test('a rolled volume carries its tissue round the limb', () => {
  // a forearm rod with a "radius" stripe on its +y side
  const nx = 9, ny = 9, nz = 31, data = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 2; j <= 6; j++) for (let i = 2; i <= 6; i++) data[(k * ny + j) * nx + i] = j === 6 ? 18 : 7;
  const J = { c: [0, 0, 0], distal: [0, 0, -1], blend: 1,
    motions: [{ key: 'roll', roll: true, axis: axisToward([0, 1, 0], [1, 0, 0]) }] };
  const r = poseVolume({ dims: [nx, ny, nz], spacingMM: [10, 10, 10], data }, [false, false, false], [J], { roll: 90 });
  const [Nx, Ny, Nz] = r.dims;
  const at = (x, y, z) => r.data[((Math.round(z + (Nz - 1) / 2)) * Ny + Math.round(y + (Ny - 1) / 2)) * Nx + Math.round(x + (Nx - 1) / 2)];
  assert.equal(at(2, 0, -8), 18, 'the stripe has gone round to +x below the joint');
  assert.equal(at(0, 2, -8), 7, 'and left +y');
  assert.equal(at(0, 2, 8), 18, 'above the joint it is where it was');
});

test('the skin goes taut over a bend and folds inside it', () => {
  // a leg along -z from an ankle at the origin, the foot plantarflexed 80 degrees (toward +y)
  const J = { c: [0, 0, 0], distal: [0, 0, -1], blend: 1.5,
    motions: [{ key: 'flex', axis: axisToward([0, 0, -1], [0, 1, 0]) }] };
  const cc = compileChain([J], { flex: 80 });
  // outside the bend (-y at rest), in the crease, 5 cm from the axis: drawn in toward it
  const p = [0, -5, -0.2];
  const arc = forwardCompiled(p, cc), skin = forwardSkin(p, cc);
  assert.ok(Math.hypot(skin[1], skin[2]) < Math.hypot(arc[1], arc[2]) - 0.5, `taut: ${skin} vs ${arc}`);
  // the bone near the axis keeps its arc
  const b = [0, -0.8, -0.2];
  assert.deepEqual(forwardSkin(b, cc).map((v) => +v.toFixed(9)), forwardCompiled(b, cc).map((v) => +v.toFixed(9)));
  // inside the bend nothing crosses the bisector: the turned part stays on its own side
  const m = cc[0].bis.map((v) => v / cc[0].bisL);
  for (const q of [[0, 3, -4], [0, 4, -2], [0, 2, -6]]) {
    const r = forwardSkin(q, cc);
    if (r[0] * cc[0].ins[0] + r[1] * cc[0].ins[1] + r[2] * cc[0].ins[2] > 0) assert.ok(r[0] * m[0] + r[1] * m[1] + r[2] * m[2] <= 1e-9, `${q} -> ${r}`);
  }
});

// a neck: a field joint about the origin, the head (z > 4) taking the whole turn, the trunk
// (z < -4) none, the weight rising linearly between; flexion toward +y
const neckField = (() => {
  const dims = [21, 21, 41], sp = 1, origin = [-10, -10, -20], data = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let k = 0; k < dims[2]; k++) {
    const z = origin[2] + k, w = Math.max(0, Math.min(1, (z + 4) / 8));
    data.fill(Math.round(w * 255), k * dims[0] * dims[1], (k + 1) * dims[0] * dims[1]);
  }
  return { dims, sp, origin, data };
})();
const neck = { c: [0, 0, 0], distal: [0, 0, 1], blend: 0, field: neckField,
  motions: [{ key: 'flex', axis: axisToward([0, 0, 1], [0, 1, 0]) }, { key: 'rot', roll: true, axis: axisToward([0, 1, 0], [1, 0, 0]) }] };

test('a field joint turns each point by its own share: the head whole, the trunk not at all', () => {
  const head = forwardChain([0, 0, 8], [neck], { flex: 90 });
  assert.ok(near(head[1], 8, 1e-6) && near(head[2], 0, 1e-6), `the head flexed 90: ${head}`);
  assert.deepEqual(forwardChain([0, 0, -8], [neck], { flex: 90 }), [0, 0, -8]);
  const mid = forwardChain([0, 0, 2], [neck], { flex: 90 });                 // weight 0.75
  assert.ok(near(Math.atan2(mid[1], mid[2]), 0.75 * Math.PI / 2, 0.005), `mid-neck turns 3/4: ${mid}`);
  // its roll is a plain turn about the neck: the face goes to +x
  const face = forwardChain([0, 5, 8], [neck], { rot: 90 });
  assert.ok(near(face[0], 5, 1e-6) && near(face[1], 0, 1e-6), `rotated 90: ${face}`);
});

test('a field joint finds the rest point of every posed point, through the blend too', () => {
  const angles = { flex: 50, rot: -30 };
  for (const p of [[0, 0, 8], [3, -6, 7], [0, 6, 1], [-4, 2, -1], [2, -7, 3], [0, 0, -8]]) {
    const q = forwardChain(p, [neck], angles);
    const back = preimagesChain(q, [neck], angles);
    assert.ok(back.some((b) => Math.hypot(b[0] - p[0], b[1] - p[1], b[2] - p[2]) < 0.02), `rest point of ${p}: ${JSON.stringify(back)}`);
  }
});

test('a field-posed volume has the head turned and the trunk where it was', () => {
  const nx = 9, ny = 9, nz = 25, data = new Uint8Array(nx * ny * nz);
  // a column of tissue along z, its front (+y) face bone
  for (let k = 0; k < nz; k++) for (let j = 2; j <= 6; j++) for (let i = 2; i <= 6; i++) data[(k * ny + j) * nx + i] = j === 6 ? 18 : 7;
  const r = poseVolume({ dims: [nx, ny, nz], spacingMM: [10, 10, 10], data }, [false, false, false], [neck], { rot: 90 });
  const [Nx, Ny, Nz] = r.dims;
  const at = (x, y, z) => r.data[((Math.round(z + (Nz - 1) / 2)) * Ny + Math.round(y + (Ny - 1) / 2)) * Nx + Math.round(x + (Nx - 1) / 2)];
  assert.equal(at(2, 0, 9), 18, 'the front has turned to +x in the head');
  assert.equal(at(0, 2, 9), 7, 'and left +y');
  assert.equal(at(0, 2, -9), 18, 'the trunk is as it was');
  assert.equal(at(2, 0, -9), 7);
});

test('a roll keeps the tissue at its crease, which is vacated but does not move', () => {
  // the forearm turns from the far edge of the crease (spread): the crease itself stays where it
  // is, and the row-wise copy that zeroes everything distal of the crease must put it back
  const nx = 9, ny = 9, nz = 31, data = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 2; j <= 6; j++) for (let i = 2; i <= 6; i++) data[(k * ny + j) * nx + i] = 7;
  // a broad crease (5 cm a side) on 1 cm voxels, so it reaches well past the moved part's margin
  const J = { ...rollElbow(12), blend: 5 };
  const r = poseVolume({ dims: [nx, ny, nz], spacingMM: [10, 10, 10], data }, [false, false, false], [J], { roll: 90 });
  const [Nx, Ny, Nz] = r.dims;
  const at = (x, y, z) => r.data[((Math.round(z + (Nz - 1) / 2)) * Ny + Math.round(y + (Ny - 1) / 2)) * Nx + Math.round(x + (Nx - 1) / 2)];
  for (const z of [4, 2, 0]) assert.equal(at(0, 0, z), 7, `tissue at the crease, z ${z}`);
  assert.equal(at(0, 0, -10), 7, 'and the forearm, rolled');
});

test('a point the joint does not move comes back bit for bit (or the whole limb counts as moved)', () => {
  // a joint off the origin: (p - c) + c is not p in floating point
  const J = { ...wrist, c: [0.6, -3.97, 0.38] };
  const cc = compileChain([J], { dev: 30 });
  for (const p of [[0.1, 1.95, -5.35], [3.3, 1.55, -9.1], [-2.9, 0.7, -20.3]]) assert.deepEqual(forwardCompiled(p, cc), p);
});
