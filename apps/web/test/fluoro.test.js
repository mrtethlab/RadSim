// Fluoroscopy image processing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NR_K, recursiveStep, displayMap, edgeEnhance, roadmapSubtract } from '../src/core/fluoroDisplay.js';

let seed = 7;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const randn = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const sd = (a) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };

test('the recursive filter cuts still-anatomy noise by sqrt((1+k)/(1-k))', () => {
  const N = 20000, k = NR_K[2];                                  // medium
  let acc = null;
  const frame = () => Float32Array.from({ length: N }, () => 0.5 + 0.05 * randn());
  for (let f = 0; f < 60; f++) acc = recursiveStep(acc, frame(), k);
  const ratio = 0.05 / sd(Array.from(acc));
  const want = Math.sqrt((1 + k) / (1 - k));
  assert.ok(Math.abs(ratio / want - 1) < 0.08, `noise down ${ratio.toFixed(2)}x, theory ${want.toFixed(2)}x`);
  // off is a pass-through, and outside the field stays outside
  const out = recursiveStep(acc, Float32Array.from([0.2, -1, 0.3]), 0);
  assert.deepEqual(Array.from(out), [Math.fround(0.2), -1, Math.fround(0.3)]);
});

test('the display map is log, windowed to 0..1, with dense tissue dark and the field edge kept', () => {
  const n = 64, img = new Float32Array(n * n), out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const r = Math.hypot(i - n / 2, j - n / 2);
    img[j * n + i] = r > n / 2 - 1 ? -1 : (i > 28 && i < 36 ? 0.002 : 0.02);   // a dense column in soft tissue
  }
  displayMap(img, n, out);
  for (let k = 0; k < n * n; k++) {
    if (img[k] < 0) assert.equal(out[k], -1);
    else assert.ok(out[k] >= 0 && out[k] <= 1);
  }
  const at = (i, j) => out[j * n + i];
  assert.ok(at(32, 32) < at(20, 32) - 0.3, 'the dense column reads dark against soft tissue');
  // a 10x thicker patient (everything / 10) gives the same picture: the window follows the anatomy
  const out2 = new Float32Array(n * n);
  displayMap(img.map((t) => (t < 0 ? t : t / 10)), n, out2);
  assert.ok(Math.abs(out2[32 * n + 32] - at(32, 32)) < 0.02 && Math.abs(out2[32 * n + 20] - at(20, 32)) < 0.02);
});

test('edge enhancement leaves flat regions alone and steepens a step', () => {
  const n = 16, lum = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) lum[k] = (k % n) < 8 ? 0.3 : 0.7;
  const before = Float32Array.from(lum);
  edgeEnhance(lum, n, 0.45);
  assert.ok(Math.abs(lum[5 * n + 3] - before[5 * n + 3]) < 1e-6, 'flat stays flat');
  assert.ok(lum[5 * n + 7] < before[5 * n + 7] && lum[5 * n + 8] > before[5 * n + 8], 'the step overshoots both ways');
});

test('the subtracted roadmap draws the vessel white and a wire inside it black, at any beam level', (t) => {
  // anatomy: a log-transmission gradient with a "spine"; a vessel column the DSA run filled
  // (peak opacity 0.9 at the map's own resolution, half the live frame's); a wire down its middle
  const n = 64, rn = 32, base = new Float32Array(rn * rn), road = new Float32Array(rn * rn);
  for (let j = 0; j < rn; j++) for (let i = 0; i < rn; i++) {
    base[j * rn + i] = -2 - 0.05 * i - (i > 4 && i < 9 ? 1 : 0);
    if (i >= 14 && i <= 18) road[j * rn + i] = 0.9;
  }
  const mid = (i) => i >= 30 && i <= 33;                                    // the vessel at 2x
  for (const shift of [0, 0.3]) {                                           // live a few kV off the mask
    const img = new Float32Array(n * n), lum = new Float32Array(n * n).fill(0.5);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const b = base[((j / 2) | 0) * rn + ((i / 2) | 0)];
      img[j * n + i] = Math.exp(b + shift - (i === 32 ? 1.2 : 0));          // the wire: optical depth 1.2
    }
    roadmapSubtract(img, n, lum, road, base, rn);
    const at = (i) => lum[20 * n + i];
    t.diagnostic(`shift ${shift}: background ${at(4).toFixed(2)}, spine ${at(14).toFixed(2)}, vessel ${at(30).toFixed(2)}, wire ${at(32).toFixed(2)}`);
    assert.ok(Math.abs(at(4) - 0.5) < 0.12 && Math.abs(at(14) - 0.5) < 0.12, 'the anatomy cancels to grey, spine and all');
    assert.ok(at(30) > 0.9 && mid(30), 'the vessel stands white');
    assert.ok(at(32) < at(30) - 0.6 && at(32) < 0.35, 'the wire draws dark inside it');
  }
  // outside the field stays outside
  const img = new Float32Array(n * n).fill(-1), lum = new Float32Array(n * n);
  roadmapSubtract(img, n, lum, road, base, rn);
  assert.ok(lum.every((v) => v === -1));
});
