// Palpation: from the bone, outward, to the last tissue before air — the skin a finger finds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skinPoint } from '../src/core/palpation.js';
import palp from '../src/data/palpation.json' with { type: 'json' };

// a 20 x 20 x 20 cm block of tissue in 1 cm voxels, with air above y = +5 (the skin)
function block() {
  const n = 20, data = new Uint8Array(n * n * n);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const y = j - (n - 1) / 2;
    data[(k * n + j) * n + i] = y <= 5 ? 10 : 0;
  }
  return { dims: [n, n, n], spacingMM: [10, 10, 10], data };
}

test('the skin point is the last tissue along the direction from the bone', () => {
  const p = skinPoint(block(), [false, false, false], [0, -2, 0], [0, 1, 0]);
  assert.ok(Math.abs(p[1] - 5) <= 0.5, `skin at y ${p[1]}`);
  assert.ok(Math.abs(p[0]) < 1e-9 && Math.abs(p[2]) < 1e-9);
});

test('the walk respects the volume flips (the frame the app images in)', () => {
  // flipped in y: the same voxels, so the skin is at y = -5 in the flipped frame
  const p = skinPoint(block(), [false, true, false], [0, 2, 0], [0, -1, 0]);
  assert.ok(Math.abs(p[1] + 5) <= 0.5, `skin at y ${p[1]}`);
});

test('a short gap inside the body does not stop the walk; a centimetre of air does', () => {
  const vm = block();
  const n = 20;
  // a 0.5 cm cleft (half a voxel rounds away) is not modelled at 1 cm; carve a 1-voxel gap at y=0
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) vm.data[(k * n + 10) * n + i] = 0;   // y = +0.5
  const p = skinPoint(vm, [false, false, false], [0, -3, 0], [0, 1, 0]);
  assert.ok(p[1] > 4, `walked past the cleft to y ${p[1]}`);
});

test('every measured landmark is complete, with a unit direction', () => {
  for (const [subject, set] of Object.entries(palp)) {
    if (subject.startsWith('_')) continue;
    assert.ok(Object.keys(set).length >= 3, `${subject}: landmarks`);
    for (const [k, v] of Object.entries(set)) {
      assert.ok(v.label && v.how, `${subject}.${k}: label and how`);
      for (const c of ['x', 'y', 'z']) assert.ok(Number.isFinite(v[c]), `${subject}.${k}.${c}`);
      assert.ok(Math.abs(Math.hypot(...v.dir) - 1) < 0.01, `${subject}.${k}: unit direction`);
    }
  }
  // left and right ASIS at the same height, either side of the midline (they were 5 cm apart in
  // height before the search was confined to the pelvis above the hips)
  const c = palp.chestabdopelvis;
  assert.ok(Math.abs(c.asisR.z - c.asisL.z) < 2 && c.asisR.x > 8 && c.asisL.x < -8);
});
