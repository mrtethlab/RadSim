// Ultrasound exam presets: each must be something the console can actually show — a preset
// outside a slider's range would be clamped silently and the readout would lie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRESETS } from '../src/ultrasound.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const range = (id) => {
  const m = new RegExp(`id="${id}"[^>]*min="([-0-9.]+)"[^>]*max="([-0-9.]+)"[^>]*step="([0-9.]+)"`).exec(html);
  assert.ok(m, `slider ${id}`);
  return { min: +m[1], max: +m[2], step: +m[3] };
};

test('every preset sits on the sliders it sets, with the focus inside the image', () => {
  const R = { freq: range('usFreq'), depth: range('usDepth'), focus: range('usFocus'), gain: range('usGain'), range: range('usRange') };
  for (const [key, p] of Object.entries(PRESETS)) {
    for (const [k, r] of Object.entries(R)) {
      const v = p[k];
      assert.ok(v >= r.min && v <= r.max, `${key}.${k} = ${v} outside ${r.min}..${r.max}`);
      assert.ok(Math.abs((v - r.min) / r.step - Math.round((v - r.min) / r.step)) < 1e-9, `${key}.${k} = ${v} is between steps`);
    }
    assert.ok(p.focus < p.depth, `${key}: focus ${p.focus} beyond depth ${p.depth}`);
    assert.ok(html.includes(`data-preset="${key}"`), `${key} has a button`);
  }
});

test('presets pair the probe with its frequency band', () => {
  for (const [key, p] of Object.entries(PRESETS)) {
    if (p.probe === 'linear') assert.ok(p.freq >= 7, `${key}: a linear probe runs high`);
    else assert.ok(p.freq <= 5 && p.depth >= 12, `${key}: a curvilinear probe runs low and deep`);
  }
});
