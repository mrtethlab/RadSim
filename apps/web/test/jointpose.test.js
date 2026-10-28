// Joint posing: bending a rigid CT at a joint, for the volume, the mesh and the landmarks alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blendWeight, rotate, axisToward, forwardChain, preimagesChain, poseVolume, posePlan, poseChunk, compileChain, forwardCompiled, forwardSkin, forwardBone, fieldWeight, planSample, mergeSample, planOcc, growOcc, foldSpan, foldRange, motionAngle } from '../src/core/jointPose.js';

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

// a jaw: the same field, its motion gliding 2 cm toward +y at the end of a 40 degree range
const jaw = { ...neck, motions: [{ key: 'open', axis: axisToward([0, 0, 1], [0, -1, 0]), range: [0, 40], glide: [0, 2, 0] }] };

test('a field joint glides with its turn: by its share, as the square of the opening', () => {
  const p = [0, 0, 8];                                                        // weight 1
  const r = forwardChain(p, [jaw], { open: 40 });
  const turned = forwardChain(p, [{ ...jaw, motions: [{ ...jaw.motions[0], glide: undefined }] }], { open: 40 });
  assert.ok(near(r[1] - turned[1], 2, 1e-6) && near(r[2], turned[2], 1e-6), `full glide: ${r} vs ${turned}`);
  const half = forwardChain(p, [jaw], { open: 20 });
  const halfTurned = forwardChain(p, [{ ...jaw, motions: [{ ...jaw.motions[0], glide: undefined }] }], { open: 20 });
  assert.ok(near(half[1] - halfTurned[1], 0.5, 1e-6), `a quarter of it half way: ${half}`);
  assert.deepEqual(forwardChain([0, 0, -8], [jaw], { open: 40 }), [0, 0, -8], 'weight 0: no glide');
  for (const q0 of [[0, 0, 8], [2, 3, 2], [0, -4, 0], [1, 5, -2]]) {
    const q = forwardChain(q0, [jaw], { open: 30 });
    const back = preimagesChain(q, [jaw], { open: 30 });
    assert.ok(back.some((b) => Math.hypot(b[0] - q0[0], b[1] - q0[1], b[2] - q0[2]) < 0.02), `rest point of ${q0}: ${JSON.stringify(back)}`);
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

test('a pose made in chunks, as the worker pool makes it, is the pose made whole', () => {
  // an elbow bent and rolled in a forearm rod: crease, crook fold and roll all in play
  const nx = 11, ny = 11, nz = 41, data = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 2; j <= 8; j++) for (let i = 2; i <= 8; i++) data[(k * ny + j) * nx + i] = j === 8 ? 18 : 7;
  const vm = { dims: [nx, ny, nz], spacingMM: [5, 5, 5], data }, angles = { flex: 70, roll: 40 };
  const whole = poseVolume(vm, [true, true, false], [rollElbow(6)], angles);
  for (const m of [2, 5, 9]) {
    const plan = posePlan(vm, [true, true, false], [rollElbow(6)], angles);
    const [N0, N1, N2] = plan.dims, out = new Uint8Array(N0 * N1 * N2);
    for (let c = m - 1; c >= 0; c--) {                       // in any order
      const [k0, k1] = poseChunk(N2, c, m), part = new Uint8Array(N0 * N1 * (k1 - k0));
      plan.rows(k0, k1, part);
      out.set(part, k0 * N0 * N1);
    }
    plan.fold(out);
    assert.deepEqual(plan.dims, whole.dims);
    assert.ok(out.every((v, i) => v === whole.data[i]), `${m} chunks`);
  }
});

// a knee with a rider: a patella in front of the joint, its tendon to a tuberosity on the leg
const patGrid = (() => {
  const dims = [5, 5, 5], data = new Uint8Array(125).fill(255);       // 2 cm cube at x -1..1, y 3..5, z 1..3
  return { dims, sp: 0.5, origin: [-1, 3, 1], data };
})();
const kneeRider = { c: [0, 0, 0], distal: [0, 0, -1], blend: 1,
  rider: { ...patGrid, c: [0, 0, 2], share: 0.7, apex: [0, 4, 1], tub: [0, 3, -4], len: Math.hypot(1, 5) },
  motions: [{ key: 'flex', axis: axisToward([0, 0, -1], [0, -1, 0]), range: [0, 120] }] };

test('a rider turns as far as keeps its tendon at length, and not at all when straight', () => {
  assert.deepEqual(forwardChain([0, 4, 2], [kneeRider], { flex: 0 }), [0, 4, 2]);
  for (const a of [30, 60, 90]) {
    const cc = compileChain([kneeRider], { flex: a });
    const apex = forwardCompiled([0, 4, 1], cc), tub = forwardCompiled([0, 3, -4], cc);
    assert.ok(near(Math.hypot(apex[0] - tub[0], apex[1] - tub[1], apex[2] - tub[2]), Math.hypot(1, 5), 1e-3), `tendon at ${a}`);
    assert.ok(cc[0].ra > 0 && cc[0].ra < cc[0].T, `the patella turns less than the knee at ${a}: ${cc[0].ra} of ${cc[0].T}`);
  }
});

test("a pose's box holds all of the posed patient (the rooms that copy it take only the box)", () => {
  const nx = 9, ny = 9, nz = 41, data = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 2; j <= 6; j++) for (let i = 2; i <= 6; i++) data[(k * ny + j) * nx + i] = k % 7 ? 7 : 18;
  const knee = { c: [0, 0, 0], distal: [0, 0, -1], blend: 1,
    motions: [{ key: 'flex', axis: axisToward([0, 0, -1], [0, -1, 0]), range: [0, 120] }] };
  for (const a of [30, 90]) {
    const r = poseVolume({ dims: [nx, ny, nz], spacingMM: [10, 10, 10], data }, [true, true, false], [knee], { flex: a });
    const [N0, N1, N2] = r.dims, [[i0, i1], [j0, j1], [k0, k1]] = r.box;
    let outside = 0, inside = 0;
    for (let k = 0; k < N2; k++) for (let j = 0; j < N1; j++) for (let i = 0; i < N0; i++) {
      if (!r.data[(k * N1 + j) * N0 + i]) continue;
      if (i < i0 || i > i1 || j < j0 || j > j1 || k < k0 || k > k1) outside++; else inside++;
    }
    assert.equal(outside, 0, `flexed ${a}: ${outside} voxels outside the box`);
    assert.ok(inside > 0 && (i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1) <= N0 * N1 * N2);
  }
});

/* the pool's way (app.js posePooled): the plan's pass shared out by input range, the rows by chunk,
   the fold by slab with its halo, the riders after; it must be the volume posed whole */
function posePooledHere(vm, flips, chain, angles, n) {
  const nz = vm.dims[2], ranges = [...Array(n)].map((_, i) => [Math.floor(i * nz / n), Math.floor((i + 1) * nz / n)]);
  const S = mergeSample(ranges.map(([a, b]) => planSample(vm, flips, chain, angles, a, b)));
  const pre = { ...S, occ: growOcc(vm, S, ranges.map(([a, b]) => planOcc(vm, flips, chain, angles, S, a, b))) };
  const P = posePlan(vm, flips, chain, angles, pre);
  const [N0, N1, N2] = P.dims, sl = N0 * N1, out = new Uint8Array(sl * N2);
  for (let c = 0; c < 3 * n; c++) {
    const [k0, k1] = poseChunk(N2, c, 3 * n), part = new Uint8Array(sl * (k1 - k0));
    posePlan(vm, flips, chain, angles, pre).rows(k0, k1, part);
    out.set(part, k0 * sl);
  }
  const sp = vm.spacingMM.map((v) => v / 10), span = foldSpan(P.dims, flips, sp, chain, angles);
  if (span) {
    const k0s = [...Array(n)].map((_, i) => span[0] + Math.floor(i * (span[1] + 1 - span[0]) / n));
    const slabs = k0s.map((k0, i) => {
      const k1 = i + 1 < n ? k0s[i + 1] : span[1] + 1, rr = k1 > k0 ? foldRange(P.dims, flips, sp, chain, angles, k0, k1) : null;
      if (!rr) return null;
      const data = out.slice(rr[0] * sl, rr[1] * sl);
      posePlan(vm, flips, chain, angles, pre).foldSlab(data, k0, k1, rr[0]);
      return { data, k0, k1, base: rr[0] };
    });
    for (const d of slabs) if (d) out.set(d.data.subarray((d.k0 - d.base) * sl, (d.k1 - d.base) * sl), d.k0 * sl);
  }
  P.ride(out);
  return { data: out, dims: P.dims };
}

test('the pose pool, in stages, makes the very volume one worker poses whole', () => {
  const nx = 13, ny = 13, nz = 61, data = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 3; j <= 9; j++) for (let i = 3; i <= 9; i++) data[(k * ny + j) * nx + i] = (i === 6 && j === 6) || k % 9 === 0 ? 18 : 7;
  const vm = { dims: [nx, ny, nz], spacingMM: [5, 5, 5], data };
  const knee = { c: [0, 0, 0.5], distal: [0, 0, -1], blend: 1, motions: [{ key: 'flex', axis: axisToward([0, 0, -1], [0, -1, 0]), range: [0, 120] }] };
  const ankle = { c: [0, 0, -9], distal: [0, 0, -1], blend: 1, motions: [{ key: 'df', axis: axisToward([0, 0, -1], [0, 1, 0]), range: [-40, 40] }] };
  for (const [chain, angles] of [[[knee], { flex: 60 }], [[knee, ankle], { flex: 90, df: -30 }]]) {
    const whole = poseVolume(vm, [true, true, false], chain, angles);
    for (const n of [2, 5]) {
      const pooled = posePooledHere(vm, [true, true, false], chain, angles, n);
      assert.deepEqual(pooled.dims, whole.dims);
      let diff = 0;
      for (let i = 0; i < whole.data.length; i++) if (pooled.data[i] !== whole.data[i]) diff++;
      assert.equal(diff, 0, `${JSON.stringify(angles)} in ${n}: ${diff} voxels differ`);
    }
  }
});

test('the bone-only mesh moves as the volume moves bone: rigid on each side of the joint', async () => {
  const { forwardBone, boneSide } = await import('../src/core/jointPose.js');
  // a joint at 2 mm: bone rods 3 cm across (a knee's condyles) above and below a gap at the origin,
  // soft tissue (7) round them, a crease 3 cm wide so a good length of each bone lies inside it.
  // Each 2 mm slab of bone is its own graded-bone material (54-61 in turn), so a voxel carries its
  // identity through the pose: a bone point is where the volume put it when it lands on its own slab
  const sp = 2, n = [31, 31, 81], [nx, ny, nz] = n, data = new Uint8Array(nx * ny * nz);
  const P = (i, j, k) => [(i - (nx - 1) / 2) * sp / 10, (j - (ny - 1) / 2) * sp / 10, (k - (nz - 1) / 2) * sp / 10];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const [x, y, z] = P(i, j, k), r = Math.hypot(x, y);
    data[(k * ny + j) * nx + i] = r < 1.5 && Math.abs(z) > 0.2 ? 54 + (k % 8) : r < 2.6 ? 7 : 0;
  }
  const knee = { c: [0, 0, 0], distal: [0, 0, -1], blend: 1.5, motions: [{ key: 'flex', axis: axisToward([0, 0, -1], [0, 1, 0]) }] };
  for (const flex of [30, 45]) {
    const angles = { flex };
    const r = poseVolume({ dims: n, spacingMM: [sp, sp, sp], data }, [false, false, false], [knee], angles);
    const [Nx, Ny, Nz] = r.dims;
    const at = (q) => r.data[(Math.round(q[2] * 10 / sp + (Nz - 1) / 2) * Ny + Math.round(q[1] * 10 / sp + (Ny - 1) / 2)) * Nx + Math.round(q[0] * 10 / sp + (Nx - 1) / 2)];
    const cc = compileChain([knee], angles);
    let all = 0, own = 0, crease = 0, rigid = 0, blended = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const m = data[(k * ny + j) * nx + i]; if (m < 54) continue;
      const p = P(i, j, k); all++;
      const hit = at(forwardBone(p, cc)) === m; if (hit) own++;
      if (Math.abs(p[2]) < 1.5) { crease++; if (hit) rigid++; if (at(forwardChain(p, [knee], angles)) === m) blended++; }
    }
    // (the misses are a voxel's rounding through the turn)
    assert.ok(own / all > 0.93, `${flex} deg: ${own} of ${all} bone points on their own slab of the posed volume`);
    assert.ok(rigid / crease > 0.9, `${flex} deg: in the crease ${rigid} of ${crease}`);
    // the soft tissue's blended map bends the bone across the crease (why bone has its own map)
    assert.ok(rigid - blended > 0.1 * crease, `${flex} deg: blended, only ${blended} of ${crease}`);
  }
  // and the two rods are two pieces: no triangle may join them across the bent joint
  const cc = compileChain([knee], { flex: 30 });
  assert.notEqual(boneSide([0, 0, 1], cc), boneSide([0, 0, -1], cc));
  assert.equal(boneSide([0, 0, 3], cc), boneSide([0.3, 0.2, 0.5], cc));
});

/* ---- the digits: field joints read at the rest point, nested, one territory a digit ----
   two fingers along +z on 2.5 mm voxels, digit 1 at x = -1 and digit 2 at x = +1, a voxel of air
   between them; each an MCP at z = 0 and a PIP at z = 4, flexing toward -y; a bone core in pieces:
   the metacarpal (z <= -0.5), the proximal phalanx (0.5..3.5), the middle one (4.5..8) */
const FSP = 0.25, flex = axisToward([0, 0, 1], [0, -1, 0]);
const inCore = (x, y, x0) => Math.abs(x - x0) <= 0.26 && Math.abs(y) <= 0.26;
const pieceOf = (z) => (z <= -0.49 ? 0 : z >= 0.49 && z <= 3.51 ? 1 : z >= 4.49 ? 2 : -1);
// a digit's grid as measure_joints writes it: 85 a joint (band), its bones whole or none, its soft
// tissue a crease across each joint, over its own side only
function digitGrid(x0, edit = () => null) {
  const origin = [x0 < 0 ? -2.5 : 0.25, -2.5, -3], dims = [10, 21, 49], data = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let k = 0; k < dims[2]; k++) for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) {
    const x = origin[0] + i * FSP, y = origin[1] + j * FSP, z = origin[2] + k * FSP, pc = pieceOf(z);
    const bone = inCore(x, y, x0) && pc >= 0;
    const w0 = bone ? +(pc >= 1) : blendWeight(z, 0.5), w1 = bone ? +(pc >= 2) : blendWeight(z - 4, 0.5);
    data[(k * dims[1] + j) * dims[0] + i] = edit(x, y, z) ?? Math.round(85 * (w0 + w1));
  }
  return { dims, sp: FSP, origin, data };
}
const fingerOf = (dg, x0, grid) => ['MCP', 'PIP'].map((label, b) => ({ label, c: [x0, 0, 4 * b], distal: [0, 0, 1], blend: 0, digit: dg,
  field: { ...grid, band: b }, motions: [{ key: 'd' + dg, axis: flex, range: [-20, 100], curl: [90, 1, b ? 5 : 20] }] }));
const hand2 = (g1 = digitGrid(-1)) => [...fingerOf(1, -1, g1), ...fingerOf(2, 1, digitGrid(1))];
function fingersVolume() {
  const nx = 21, ny = 17, nz = 49, data = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = (i - 10) * FSP, y = (j - 8) * FSP, z = (k - 24) * FSP;
    const x0 = x < 0 ? -1 : 1;
    if (Math.abs(x - x0) > 0.76 || Math.abs(y) > 0.76 || z > 8) continue;
    data[(k * ny + j) * nx + i] = inCore(x, y, x0) && pieceOf(z) >= 0 ? 18 : 10;
  }
  return { dims: [nx, ny, nz], spacingMM: [2.5, 2.5, 2.5], data };
}
const posedAt = (r) => (x, y, z) => {
  const [Nx, Ny, Nz] = r.dims, i = Math.round(x / FSP + (Nx - 1) / 2), j = Math.round(y / FSP + (Ny - 1) / 2), k = Math.round(z / FSP + (Nz - 1) / 2);
  return i < 0 || j < 0 || k < 0 || i >= Nx || j >= Ny || k >= Nz ? 0 : r.data[(k * Ny + j) * Nx + i];
};

test("a digit's curl sets its joints each its own way, and extends them below 0", () => {
  const m = { key: 'd', curl: [105, 0.85, 5], range: [-20, 100] };
  assert.equal(motionAngle({}, m), 0, 'unset: the hand as scanned');
  assert.equal(motionAngle({ d: 0 }, m), 0);
  assert.equal(motionAngle({ d: 100 }, m), 105);
  assert.ok(motionAngle({ d: 50 }, m) > 105 / 2, 'the PIP leads (power under 1)');
  assert.equal(motionAngle({ d: -20 }, m), -5, 'full extension');
  assert.equal(motionAngle({ d: -10 }, m), -2.5, 'in proportion');
  assert.equal(motionAngle({ d: -40 }, m), -5, 'and no further');
});

test("a digit's joints read their shares where the point was at rest: the fingertip follows the MCP", () => {
  const ch = hand2(), tip = [-1, 0, 7];
  // the PIP turns it 90 degrees to (-1, -3, 4), under the finger, outside every grid; the MCP then
  // turns it, by the share it had at rest, 90 more
  const q = forwardChain(tip, ch, { d1: 100 });
  assert.ok(Math.hypot(q[0] + 1, q[1] + 4, q[2] + 3) < 1e-9, `curled: ${q}`);
  // extended: the MCP 20 degrees and the PIP 5 back toward the dorsum (+y)
  const e = forwardChain(tip, ch, { d1: -20 });
  const r1 = rotate([0, 0, 3], flex, -5 * Math.PI / 180), r = rotate([r1[0], r1[1], 4 + r1[2]], flex, -20 * Math.PI / 180);
  assert.ok(Math.hypot(e[0] + 1 - r[0], e[1] - r[1], e[2] - r[2]) < 1e-9 && e[1] > 1, `extended: ${e}`);
  assert.deepEqual(forwardChain(tip, ch, { d1: 0, d2: 0 }), tip, '0 is the hand as scanned');
});

test('a curled digit does not drag the one beside it', () => {
  const ch = hand2();
  for (const p of [[1, 0, 7], [0.25, -0.75, 2], [1, 0.5, -1]]) assert.deepEqual(forwardChain(p, ch, { d1: 100 }), p, `${p}`);
  // and each moves by its own: both curled, the second's tip is where it would be alone
  assert.deepEqual(forwardChain([1, 0, 7], ch, { d1: 100, d2: 60 }), forwardChain([1, 0, 7], ch, { d2: 60 }));
});

test("every posed point of a digit has its rest point among the pre-images", () => {
  const ch = hand2(), angles = { d1: 70, d2: -15 };
  for (const p of [[-1, 0, 7], [-1, 0.5, 0.1], [-1.5, -0.6, 3.9], [-1, 0, 2], [-0.5, 0.7, -2], [1, 0, 7], [1.5, -0.5, 4.2], [0.5, 0, 1]]) {
    const q = forwardChain(p, ch, angles);
    const back = preimagesChain(q, ch, angles);
    assert.ok(back.some((b) => Math.hypot(b[0] - p[0], b[1] - p[1], b[2] - p[2]) < 0.02), `rest point of ${p}: ${JSON.stringify(back)}`);
  }
});

test('the posed volume carries a curled finger whole, and leaves its neighbour and its own place', () => {
  const vm = fingersVolume(), ch = hand2();
  const r = poseVolume(vm, [false, false, false], ch, { d1: 100 }), at = posedAt(r);
  // the middle phalanx's bone, turned by the PIP then the MCP: (-1, 0, 6) -> (-1, -2, 4) -> (-1, -4, -2)
  assert.equal(at(-1, -4, -2), 18, 'the middle phalanx is under the palm');
  assert.equal(at(-1, -3, 0), 18, 'the proximal phalanx points palmar');
  assert.equal(at(-1, 0, 6), 0, 'and the finger has left its place');
  assert.equal(at(-1, 0, -2), 18, 'the metacarpal stays');
  for (const z of [-2, 1, 3, 5, 5.75]) { assert.equal(at(1, 0, z), 18, `the neighbour's bone at z ${z}`); assert.equal(at(1.5, 0.5, z), 10); }
  const count = (d, v) => d.reduce((n, x) => n + (x === v), 0);
  const b0 = count(vm.data, 18), b1 = count(r.data, 18);
  assert.ok(Math.abs(b1 - b0) <= 0.05 * b0, `bone kept: ${b0} -> ${b1}`);
  assert.deepEqual(poseVolume(vm, [false, false, false], ch, { d1: 0, d2: 0 }).data, vm.data, '0 is the hand as scanned');
});

test("the bone-only mesh follows a digit's bones where the volume puts them", async () => {
  const { forwardBone, boneSide } = await import('../src/core/jointPose.js');
  const vm = fingersVolume(), ch = hand2(), angles = { d1: 100, d2: -20 };
  const r = poseVolume(vm, [false, false, false], ch, angles), at = posedAt(r), cc = compileChain(ch, angles);
  // every bone voxel of the rest hand, carried by the bone map, lands on bone in the posed volume
  const [nx, ny, nz] = vm.dims;
  let n = 0, hit = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (vm.data[(k * ny + j) * nx + i] !== 18) continue;
    const q = forwardBone([(i - 10) * FSP, (j - 8) * FSP, (k - 24) * FSP], cc);
    n++; hit += at(q[0], q[1], q[2]) === 18;
  }
  assert.ok(hit / n > 0.97, `bone on bone: ${hit} of ${n}`);
  // the curled fingertip: turned by the PIP, then by the MCP by the share it had AT REST (where the
  // PIP has put it, under the finger, it is outside every grid), as the volume has it
  const q = forwardBone([-1, 0, 7.5], cc);
  assert.ok(Math.hypot(q[0] + 1, q[1] + 4, q[2] + 3.5) < 1e-9, `curled: ${q}`);
  // each phalanx its own rigid piece: no triangle joins two across a bent digit joint
  const sides = [-2, 2, 6].map((z) => boneSide([-1, 0, z], cc));
  assert.equal(new Set(sides).size, 3, `pieces ${sides}`);
  assert.equal(boneSide([-1, 0.2, 1.5], cc), boneSide([-1, -0.2, 3], cc));
});

test('a bone turns whole or not at all, though its grid blends it with the soft tissue beside it', () => {
  // a row across the middle phalanx given 0.6 of the PIP's share (as a cell beside a joint space is)
  const g = digitGrid(-1, (x, y, z) => (inCore(x, y, -1) && Math.abs(z - 5.5) < 0.01 ? Math.round(85 * 1.6) : null));
  const r = poseVolume(fingersVolume(), [false, false, false], hand2(g), { d1: 100 }), at = posedAt(r);
  // with the rest of the phalanx: (-1, 0, 5.5) -> (-1, -1.5, 4) -> (-1, -4, -1.5); not 0.9 cm off at
  // (-1, -4.88, -1.21), where 0.6 of the PIP's turn would take it
  for (const x of [-1.25, -1, -0.75]) assert.equal(at(x, -4, -1.5), 18, `the row, x ${x}`);
});

test('the pose pool makes the very volume of curled and extended digits one worker poses whole', () => {
  const vm = fingersVolume(), ch = hand2(), angles = { d1: 80, d2: -20 };
  const whole = poseVolume(vm, [false, false, false], ch, angles);
  for (const n of [2, 5]) {
    const pooled = posePooledHere(vm, [false, false, false], ch, angles, n);
    assert.deepEqual(pooled.dims, whole.dims);
    let diff = 0;
    for (let i = 0; i < whole.data.length; i++) if (pooled.data[i] !== whole.data[i]) diff++;
    assert.equal(diff, 0, `${n} workers: ${diff} voxels differ`);
  }
});

/* ---- a field with a plane past its grid (field.beyond): the elbow's ----
   a forearm rod along -z from an elbow at the origin, flexing toward +y; the grid holds only the
   elbow (|z| <= 3), its weight rising from 0 above to 1 below; past it, what lies below the plane
   z = 0 (d = -z) turns whole */
const elbowGrid = (() => {
  const dims = [9, 9, 7], sp = 1, origin = [-4, -4, -3], data = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let k = 0; k < dims[2]; k++) data.fill(Math.round(Math.max(0, Math.min(1, (2 - (origin[2] + k)) / 4)) * 255), k * 81, (k + 1) * 81);
  return { dims, sp, origin, data, beyond: { c: [0, 0, 0], d: [0, 0, -1] } };
})();
const fieldElbow = { c: [0, 0, 0], distal: [0, 0, -1], blend: 0, field: elbowGrid,
  motions: [{ key: 'flex', axis: axisToward([0, 0, -1], [0, 1, 0]) }] };

test('past its grid a field turns what lies past its plane whole, and nothing short of it', () => {
  assert.deepEqual(forwardChain([0, 0, 10], [fieldElbow], { flex: 90 }), [0, 0, 10], 'the arm above stays');
  const hand = forwardChain([0.5, 0, -20], [fieldElbow], { flex: 90 });
  assert.ok(near(hand[0], 0.5, 1e-9) && near(hand[1], 20, 1e-9) && near(hand[2], 0, 1e-9), `the hand, far past the grid, turned whole: ${hand}`);
  for (const p of [[0, 0, -20], [1, 1, -2.5], [0, 0, 0.5], [0, -1, 8]]) {
    const q = forwardChain(p, [fieldElbow], { flex: 70 });
    const back = preimagesChain(q, [fieldElbow], { flex: 70 });
    assert.ok(back.some((b) => Math.hypot(b[0] - p[0], b[1] - p[1], b[2] - p[2]) < 0.02), `rest point of ${p}: ${JSON.stringify(back)}`);
  }
});

test('a volume posed by a field with a plane past its grid carries the whole forearm, made whole or in parts', () => {
  const nx = 5, ny = 5, nz = 41, data = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 1; j <= 3; j++) for (let i = 1; i <= 3; i++) data[(k * ny + j) * nx + i] = 7;
  const vm = { dims: [nx, ny, nz], spacingMM: [10, 10, 10], data };
  const r = poseVolume(vm, [false, false, false], [fieldElbow], { flex: 90 });
  const [Nx, Ny, Nz] = r.dims;
  const at = (x, y, z) => r.data[((Math.round(z + (Nz - 1) / 2)) * Ny + Math.round(y + (Ny - 1) / 2)) * Nx + Math.round(x + (Nx - 1) / 2)];
  assert.equal(at(0, 15, 0), 7, 'the forearm, past the grid, in front of the elbow');
  assert.equal(at(0, 0, -15), 0, 'and gone from where it was');
  assert.equal(at(0, 0, 15), 7, 'the arm above where it was');
  const pooled = posePooledHere(vm, [false, false, false], [fieldElbow], { flex: 90 }, 3);
  let diff = 0;
  for (let i = 0; i < r.data.length; i++) if (pooled.data[i] !== r.data[i]) diff++;
  assert.equal(diff, 0, `${diff} voxels differ`);
});

/* ---- the arm model's elbow (data/joints.json, tools/measure_joints.py elbow_field) ----
   flexion a field joint about the line through the trochlea and capitulum: the radius and ulna turn
   whole about it, the humerus not at all; the forearm's roll a plain joint below it */
const ARM = (() => {
  const dir = new URL('../public/models/upperextremity/', import.meta.url);
  const js = JSON.parse(readFileSync(new URL('../src/data/joints.json', import.meta.url), 'utf8')).upperextremity;
  const chain = Object.values(js).map((j) => ({ ...j,
    ...(j.field ? { field: { ...j.field, data: new Uint8Array(readFileSync(new URL(j.field.file, dir))) } } : {}),
    motions: j.motions.map((m) => ({ ...m, axis: axisToward(m.from || j.distal, m.toward) })) }));
  const hdr = JSON.parse(readFileSync(new URL('upperextremity.model.json', dir), 'utf8'));
  const vol = new Uint8Array(readFileSync(new URL('upperextremity.mat.bin', dir)));
  // the bone voxels within 4 cm of the elbow's centre (the rest frame: the volume's x and y
  // flipped), each side's by the grid's own share, which must be whole or none on bone (every bone
  // pinned to its piece's share)
  const [nx, ny, nz] = hdr.dims, sp = hdr.spacing[0] / 10;
  const E = chain.find((j) => j.motions.some((m) => m.key === 'elbow.flex')), roll = chain.find((j) => j.motions.some((m) => m.key === 'elbow.roll'));
  const fore = [], hum = [], mixed = [];
  for (let k = 0; k < nz; k++) {
    const z = (k - (nz - 1) / 2) * sp;
    if (Math.abs(z - E.c[2]) > 4) continue;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const v = vol[(k * ny + j) * nx + i];
      if (v !== 17 && v !== 18) continue;
      const p = [-(i - (nx - 1) / 2) * sp, -(j - (ny - 1) / 2) * sp, z];
      if (Math.hypot(p[0] - E.c[0], p[1] - E.c[1], p[2] - E.c[2]) > 4) continue;
      const w = fieldWeight(E.field, p);
      (w === 1 ? fore : w === 0 ? hum : mixed).push(p);
    }
  }
  return { chain, E, roll, fore, hum, mixed, flex: E.motions[0] };
})();
// p turned about the line through c along unit n by a (radians), and moved by g
const turnAbout = (p, c, n, a, g = [0, 0, 0]) => { const r = rotate([p[0] - c[0], p[1] - c[1], p[2] - c[2]], n, a); return [c[0] + r[0] + g[0], c[1] + r[1] + g[1], c[2] + r[2] + g[2]]; };
// the elbow's glide as it straightens past where the arm rests (m.glide0, as the square of the way)
const glideAt = (m, deg) => { const f = deg < m.rest ? ((m.rest - deg) / (m.rest - m.range[0])) ** 2 : 0; return (m.glide0 || [0, 0, 0]).map((v) => v * f); };

test("the elbow's grid gives the radius and ulna the whole turn and the humerus none, bone by bone", () => {
  const { fore, hum, mixed, E } = ARM;
  assert.ok(fore.length > 10000 && hum.length > 10000, `forearm ${fore.length}, humerus ${hum.length} bone voxels by the joint`);
  assert.equal(mixed.length, 0, `bone with a part of the turn: ${JSON.stringify(mixed.slice(0, 3))}`);
  // each on its own side: along the forearm, no forearm bone far up the humerus, no humerus bone down the forearm
  const s = (p) => (p[0] - E.c[0]) * E.distal[0] + (p[1] - E.c[1]) * E.distal[1] + (p[2] - E.c[2]) * E.distal[2];
  assert.ok(fore.every((p) => s(p) > -2), 'forearm bone above the joint');
  assert.ok(hum.every((p) => s(p) < 1.5), 'humerus bone below it');
});

test('the coronoid and radial head turn round the trochlea and capitulum, whole, from straight to 140 degrees', () => {
  const { chain, E, roll, fore, hum, flex } = ARM, c = E.c, n = flex.axis;
  // the forearm's joint surfaces: the coronoid (in front of the axis, on the ulna's side), the radial
  // head (lateral, below it), and every forearm bone voxel within 2.5 cm of the centre with them
  const lat = Math.sign(roll.motions[0].toward[0]);
  const near25 = fore.filter((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) < 2.5);
  const coronoid = near25.filter((p) => p[1] > c[1] + 0.3 && lat * (p[0] - c[0]) < 0);
  const radialHead = near25.filter((p) => lat * (p[0] - c[0]) > 1.2);
  assert.ok(coronoid.length > 50 && radialHead.length > 50, `coronoid ${coronoid.length}, radial head ${radialHead.length}`);
  for (let deg = 0; deg <= 140; deg += 10) {
    const T = (deg - flex.rest) * Math.PI / 180, cc = compileChain(chain, { 'elbow.flex': deg }), g = glideAt(flex, deg);
    // (the centre glides with the forearm the last stretch to straight)
    const o = [c[0] + g[0], c[1] + g[1], c[2] + g[2]];
    for (const p of [...coronoid, ...radialHead, ...near25.filter((_, i) => i % 7 === 0)]) {
      const q = forwardCompiled(p, cc), b = forwardBone(p, cc), want = turnAbout(p, c, n, T, g);
      const d0 = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]), d1 = Math.hypot(q[0] - o[0], q[1] - o[1], q[2] - o[2]);
      assert.ok(Math.abs(d1 - d0) < 1e-9, `${deg} deg: ${p} kept ${d0} from the centre, not ${d1}`);
      assert.ok(Math.hypot(q[0] - want[0], q[1] - want[1], q[2] - want[2]) < 1e-9, `${deg} deg: ${p} turned by the full angle`);
      assert.ok(Math.hypot(b[0] - want[0], b[1] - want[1], b[2] - want[2]) < 1e-9, `${deg} deg: the bone mesh's ${p} too`);
    }
    for (const p of hum.filter((_, i) => i % 11 === 0)) assert.deepEqual(forwardCompiled(p, cc), p, `${deg} deg: the humerus stays`);
  }
});

test('every forearm bone point turns by the full angle, the hand past the grid too, after the forearm\'s roll', () => {
  const { chain, E, roll, fore, flex } = ARM, c = E.c;
  // down the forearm to the wrist, along its axis (past the elbow's grid: its plane decides)
  const far = [6, 12, 20, 28].map((s) => [c[0] + s * E.distal[0], c[1] + s * E.distal[1], c[2] + s * E.distal[2]]);
  for (const angles of [{ 'elbow.flex': 90 }, { 'elbow.flex': 140, 'elbow.roll': -180 }, { 'elbow.flex': 0, 'elbow.roll': -90 }]) {
    const T = (angles['elbow.flex'] - flex.rest) * Math.PI / 180;
    const cc = compileChain(chain, angles), rolled = compileChain([roll], angles);
    for (const p of [...fore.filter((_, i) => i % 13 === 0), ...far]) {
      const r = rolled.length ? forwardCompiled(p, rolled) : p;                   // the roll, then the bend
      const want = turnAbout(r, c, flex.axis, T, glideAt(flex, angles['elbow.flex'])), q = forwardCompiled(p, cc);
      assert.ok(Math.hypot(q[0] - want[0], q[1] - want[1], q[2] - want[2]) < 1e-9, `${JSON.stringify(angles)}: ${p}`);
    }
  }
});

test("the joint space stays open as the elbow bends: the forearm's joint surfaces keep off the humerus", () => {
  const { chain, E, fore, hum } = ARM, c = E.c;
  // the humerus's bone as 1 mm cells; whether a point has humerus bone within r cm
  const cell = (v) => Math.round(v * 10) + 2000, key = (i, j, k) => (i * 4096 + j) * 4096 + k;
  const H = new Set(hum.map((p) => key(cell(p[0]), cell(p[1]), cell(p[2]))));
  const within = (q, r) => {
    const [i, j, k] = q.map(cell), R = Math.ceil(r * 10);
    for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) for (let d = -R; d <= R; d++)
      if (a * a + b * b + d * d <= r * r * 100 && H.has(key(i + a, j + b, k + d))) return true;
    return false;
  };
  // the forearm's joint surfaces: its bone within 8 mm of the humerus's as scanned (the trochlear
  // notch, the radial head's fovea, the tips of the olecranon and coronoid)
  const surf = fore.filter((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) < 3 && within(p, 0.8));
  assert.ok(surf.length > 500, `${surf.length} points on the forearm's joint surfaces`);
  assert.ok(!surf.some((p) => within(p, 0.3)), 'as scanned, 3 mm apart or more');
  for (const deg of [0, 15, 30, 60, 90, 120]) {
    const cc = compileChain(chain, { 'elbow.flex': deg });
    const close = surf.filter((p) => within(forwardCompiled(p, cc), 0.15)).length;
    // (deep in flexion the coronoid's tip comes into its fossa: a few points of it)
    assert.ok(close / surf.length < (deg > 90 ? 0.03 : 0.01), `${deg} deg: ${close} of ${surf.length} within 1.5 mm of the humerus`);
  }
});
