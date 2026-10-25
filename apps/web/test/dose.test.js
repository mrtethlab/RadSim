// Dose readouts that ignored the controls meant to lower them: the fluoro DAP did not see the
// shutters, and the mammography AGD did not see the target/filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { irisShutterArea, squareShutterArea, fieldArea, inField } from '../src/core/fieldArea.js';
import { agdMGy, gFactor, hvlMmAl, relativeOutput } from '../src/core/mammoDose.js';

test('closing the shutters shrinks the DAP field the way it shrinks the image', () => {
  const R = 10;
  assert.ok(Math.abs(irisShutterArea(R, R) - Math.PI * R * R) < 1e-9, 'shutters open: the iris circle');
  assert.ok(Math.abs(irisShutterArea(R, 20) - Math.PI * R * R) < 1e-9, 'shutters outside the iris cut nothing');
  assert.equal(irisShutterArea(R, 0), 0);
  // half-closed: band half-width R/2 -> 2[(R/2)·R·√3/2 + R²·π/6] = R²(√3/2 + π/3) = 1.913 R²
  assert.ok(Math.abs(irisShutterArea(R, R / 2) / (R * R) - (Math.sqrt(3) / 2 + Math.PI / 3)) < 1e-9);
  // a narrow slot is ~ its rectangle 2s × 2R
  assert.ok(Math.abs(irisShutterArea(R, 0.1) / (4 * 0.1 * R) - 1) < 0.001);
  // monotonic as they close
  let last = Infinity;
  for (let s = R; s >= 0; s -= 0.5) { const a = irisShutterArea(R, s); assert.ok(a <= last); last = a; }
});

test('the flat panel field is square: its DAP area, shutters and their angle included', () => {
  const R = 10, D = Math.PI / 180, near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(squareShutterArea(R, R * 2), 4 * R * R), 'open: the whole square, 4/pi the circle');
  assert.ok(near(fieldArea(true, R, R * 2) / fieldArea(false, R, R * 2), 4 / Math.PI));
  assert.equal(squareShutterArea(R, 0), 0);
  // leaves square to the panel: a band 2s across a side, 2R long
  assert.ok(near(squareShutterArea(R, 4), 2 * R * 2 * 4));
  // at 45 degrees a narrow band runs corner to corner, sqrt 2 longer
  assert.ok(Math.abs(squareShutterArea(R, 0.05, 45 * D) / (2 * 0.05 * 2 * R * Math.SQRT2) - 1) < 0.01);
  // half-closed at 45: the square less two corner triangles, legs (sqrt2 - 1/2) R sqrt2
  const leg = (Math.SQRT2 - 0.5) * R * Math.SQRT2;
  assert.ok(near(squareShutterArea(R, R / 2, 45 * D), 4 * R * R - leg * leg));
  // the leaves are a pair: a half turn is the same field
  assert.ok(near(squareShutterArea(R, 3, 20 * D), squareShutterArea(R, 3, 200 * D)));
});

test('the DAP field is the field the worker images, on either receptor', () => {
  // count the detector pixels inField lets through (the worker's own test) against the area
  const n = 400, half = 11.5;
  for (const [flat, cut, sh, rot] of [[false, 11.5, 1e9, 0], [false, 8, 4, 0.6], [true, 11.5, 1e9, 0],
    [true, 9, 5, 0.6], [true, 11.5, 3, Math.PI / 4]]) {
    const c = Math.cos(rot), s = Math.sin(rot), px = (2 * half / n) ** 2;
    let k = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      if (inField(((i + 0.5) / n - 0.5) * 2 * half, ((j + 0.5) / n - 0.5) * 2 * half, flat, cut, sh, c, s)) k++;
    }
    const want = fieldArea(flat, cut, Math.min(sh, 1e3), rot);
    assert.ok(Math.abs(k * px / want - 1) < 0.01, `${flat ? 'panel' : 'II'} iris ${cut} shutters ${sh}: ${(k * px).toFixed(1)} vs ${want.toFixed(1)} cm²`);
  }
});

test('mammography AGD keeps its calibration point and now follows the target/filter', () => {
  const ref = agdMGy({ tf: 'momo', kv: 28, mas: 60, tCm: 4.5 });
  assert.ok(Math.abs(ref.agd - 1.5) < 1e-9, `Mo/Mo 28 kV 60 mAs 45 mm: ${ref.agd}`);
  // the target/filter sets the beam quality
  assert.ok(hvlMmAl('momo', 28) < hvlMmAl('morh', 28) && hvlMmAl('morh', 28) < hvlMmAl('wrh', 28));
  assert.ok(Math.abs(hvlMmAl('momo', 28) - 0.31) < 0.005, 'Mo/Mo 28 kV HVL ~0.31 mm Al');
  // ...and the three no longer report the same dose at the same settings
  const at = (tf) => agdMGy({ tf, kv: 28, mas: 60, tCm: 4.5 });
  assert.notEqual(at('momo').agd.toFixed(3), at('wrh').agd.toFixed(3));
  assert.ok(at('wrh').K < at('momo').K, 'a W/Rh tube makes less kerma per mAs');
  assert.ok(at('wrh').g > at('momo').g, 'but a harder beam deposits more of it in the gland');
});

test('the conversion factor g falls with thickness and rises with HVL', () => {
  assert.ok(gFactor(3, 0.35) > gFactor(4.5, 0.35) && gFactor(4.5, 0.35) > gFactor(7, 0.35));
  assert.ok(gFactor(4.5, 0.30) < gFactor(4.5, 0.40) && gFactor(4.5, 0.40) < gFactor(4.5, 0.55));
});

test('the image and the dose share one tube output', () => {
  // what the AEC sees per mAs and what the AGD charges per mAs must move together
  assert.equal(relativeOutput('momo', 28), 1);
  for (const tf of ['momo', 'morh', 'wrh']) for (const kv of [25, 28, 32]) {
    const a = agdMGy({ tf, kv, mas: 10, tCm: 5 }).K, b = agdMGy({ tf: 'momo', kv: 28, mas: 10, tCm: 5 }).K;
    assert.ok(Math.abs(a / b - relativeOutput(tf, kv)) < 1e-9, `${tf} ${kv} kV`);
  }
});
