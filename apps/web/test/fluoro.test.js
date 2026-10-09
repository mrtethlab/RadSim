// Fluoroscopy image processing and the lumbopelvic model it is meant to show a spine with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NR_K, recursiveStep, displayMap, edgeEnhance } from '../src/core/fluoroDisplay.js';
import { BodyMaterials } from '../src/core/materials.js';

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

test('the lumbopelvic model is 1 mm with graded bone, and every material in it is in the legend', () => {
  const dir = new URL('../public/models/lumbopelvis/', import.meta.url);
  const h = JSON.parse(readFileSync(new URL('lumbopelvis.model.json', dir), 'utf8'));
  assert.deepEqual(h.spacing, [1, 1, 1]);
  assert.ok(!h.backendOnly, 'fluoro is browser-only, so the volume must load in the browser');
  const [nx, ny, nz] = h.dims;
  const data = readFileSync(new URL('lumbopelvis.mat.bin', dir));
  assert.equal(data.length, nx * ny * nz);
  const seen = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 7) seen[data[i]]++;
  const graded = [54, 55, 56, 57, 58, 59, 60, 61].filter((id) => seen[id] > 0);
  assert.ok(graded.length >= 7, `graded bone ids present: ${graded}`);
  assert.equal(seen[17] + seen[18] < (graded.reduce((s, id) => s + seen[id], 0)) / 10, true,
    'labelled bone is graded, not the two old classes');
  for (let id = 0; id < 256; id++) if (seen[id]) assert.ok(id < BodyMaterials.count, `material ${id} has no legend entry`);
  // denser grades attenuate more
  const mu = (id) => BodyMaterials.muById(id, 60);
  for (let id = 54; id < 61; id++) assert.ok(mu(id + 1) > mu(id), `Bone grade ${id + 1} denser than ${id}`);
});
