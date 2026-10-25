import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latitudeImage } from '../src/core/equalise.js';

// A film like an AP ankle's: raw beam at the edge, thin leg, and the foot standing end-on beside it
// (much thicker), with a small bony detail inside the thick part: finer than the blur's reach
// (r 0.12 of the matrix), as trabeculae and a cortex are; a whole talus is coarser and is, as
// equalisation means it to be, partly evened out with the rest.
const nx = 120, ny = 120, mx = 1;
function film() {
  const sig = new Float32Array(nx * ny), mask = new Uint8Array(nx * ny).fill(1);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let A = x < 10 ? 0 : x < 60 ? 1.0 : 3.0;                 // log attenuation
    if (x >= 86 && x < 92 && y >= 56 && y < 62) A += 0.2;    // the detail in the thick part
    sig[y * nx + x] = mx * Math.exp(-A);
  }
  return { sig, mask };
}
const plain = (sig) => Array.from(sig, (s) => 1 - Math.log(1 + 40 * s / mx) / Math.log(41));
const mean = (a, x0, x1, y0, y1) => { let s = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += a[y * nx + x]; n++; } return s / n; };

test('latitude takes out part of the large-area difference and keeps the local detail', () => {
  const { sig, mask } = film(), p = plain(sig), q = latitudeImage(sig, nx, ny, mask, mx, { r: 0.12, k: 0.6 });
  // well inside each region (away from the blur's reach of the boundary)
  const big = (a) => mean(a, 65, 78, 5, 30) - mean(a, 15, 45, 5, 30);
  const step = (a) => mean(a, 87, 91, 57, 61) - mean(a, 104, 116, 50, 70);
  assert.ok(big(q) < 0.6 * big(p), `thick - thin: ${big(q).toFixed(3)} of ${big(p).toFixed(3)}`);
  assert.ok(step(q) > 0.8 * step(p), `the detail's step: ${step(q).toFixed(3)} of ${step(p).toFixed(3)}`);
  // the raw beam is not anatomy: left as it was, so the skin edge takes no halo from it
  for (let y = 0; y < ny; y += 7) assert.equal(q[y * nx + 3], p[y * nx + 3]);
});
