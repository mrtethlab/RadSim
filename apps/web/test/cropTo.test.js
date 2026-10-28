// A phantom cropped to a beam traces every ray of that beam exactly as the whole volume does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoxelPhantom, eulerMatrix } from '../src/core/voxelPhantom.js';

function blob(nx, ny, nz, seed = 3) {
  let s = seed; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const data = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < data.length; k++) data[k] = r() < 0.6 ? 1 + Math.floor(r() * 18) : 0;
  return { dims: [nx, ny, nz], vs: [0.1, 0.1, 0.1], data };
}

test('cropped to a beam, every ray traces the same path lengths', () => {
  for (const [flip, rot] of [[[false, false, false], null], [[true, false, true], eulerMatrix(1.2, 0, 0.4)], [[true, true, false], eulerMatrix(-1.5708, 0.3, -0.2)]]) {
    const ph = new VoxelPhantom(blob(120, 90, 110), [0.5, 7, -0.3], flip, rot);
    const src = [0.3, 100, 0.8];
    const corners = [[-1, 0, -1.5], [1.2, 0, -1.5], [-1, 0, 1], [1.2, 0, 1]];
    const crop = ph.cropTo(src, [-1, 1.2, -1.5, 1]);
    assert.notEqual(crop, ph, 'the beam takes a small part of the volume');
    assert.ok(crop.nx * crop.ny * crop.nz < 0.6 * ph.nx * ph.ny * ph.nz);
    for (let a = 0; a <= 1; a += 0.25) for (let b = 0; b <= 1; b += 0.25) {
      const p = [corners[0][0] + a * (corners[1][0] - corners[0][0]), 0, corners[0][2] + b * (corners[2][2] - corners[0][2])];
      const d = [p[0] - src[0], p[1] - src[1], p[2] - src[2]], L = Math.hypot(...d);
      const u = d.map((v) => v / L);
      const A = ph.trace(src, u, L), B = crop.trace(src, u, L);
      for (let m = 0; m < A.length; m++) assert.ok(Math.abs(A[m] - B[m]) < 1e-4, `material ${m}: ${A[m]} vs ${B[m]}`);
    }
  }
});

test('a beam that takes most of the volume, or a contrast field, keeps the whole volume', () => {
  const ph = new VoxelPhantom(blob(20, 20, 20), [0, 3, 0]);
  assert.equal(ph.cropTo([0, 100, 0], [-50, 50, -50, 50]), ph);
  ph.setContrast(new Float32Array(10), new Uint8Array(8000), 1);
  assert.equal(ph.cropTo([0, 100, 0], [-0.1, 0.1, -0.1, 0.1]), ph);
});
