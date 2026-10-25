// The tutorials point at real controls by selector (tutorial-content.js). A control renamed or
// removed leaves its step lighting nothing ("not on screen yet") with no error anywhere, so every
// id a step names must be in the page: in index.html, or made at run time by a module (listed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from '../src/tutorial-content.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
// ids that modules create, not the page (each checked where it is made)
const RUNTIME = new Set(['tutGoal']);
const TUTS = { XRAY_STEPS: 'x-ray', CT_STEPS: 'CT', CONTRAST_STEPS: 'contrast', EDITOR_STEPS: 'editor', BARIUM_STEPS: 'barium',
  FLUORO_STEPS: 'fluoroscopy', MAMMO_STEPS: 'mammography', US_STEPS: 'ultrasound', DXA_STEPS: 'DXA' };

test('every tutorial step names controls the page has', () => {
  let n = 0;
  for (const [k, name] of Object.entries(TUTS)) {
    for (const s of T[k]) {
      assert.ok(s.title && s.text, `${name}: a step without a title or text`);
      for (const sel of [].concat(s.sel || [])) {
        for (const [, id] of sel.matchAll(/#([A-Za-z][\w-]*)/g)) {
          n++;
          assert.ok(RUNTIME.has(id) || html.includes(`id="${id}"`), `${name} · ${s.title}: #${id} is not in the page`);
        }
      }
      if (s.goal) assert.equal(typeof s.goal.done, 'function', `${name} · ${s.title}: a goal without done()`);
    }
  }
  assert.ok(n > 100, `${n} ids checked`);
});

test('the new features each have their step', () => {
  const titles = (k) => T[k].map((s) => s.title).join(' | ');
  assert.match(titles('XRAY_STEPS'), /Bend the joints/);
  assert.match(titles('XRAY_STEPS'), /pasting/i);
  assert.match(titles('FLUORO_STEPS'), /guidewire/i);
  assert.match(titles('FLUORO_STEPS'), /ankle reduction/i);
  assert.match(titles('DXA_STEPS'), /forearm/i);
  assert.match(titles('DXA_STEPS'), /The exam/);
  assert.match(titles('MAMMO_STEPS'), /Position/);
  assert.match(titles('US_STEPS'), /Spectral Doppler/);
});
