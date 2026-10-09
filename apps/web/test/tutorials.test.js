// Every tutorial step points at a control. When a control is renamed and the step is not, the
// learner meets "this control does not exist yet" and is told they skipped a step they did not —
// which is what two fluoroscopy steps did (#flAbcSeg, #flIris). Every id a step names must exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from '../src/tutorial-content.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

test('every tutorial step targets a control that exists on the page', () => {
  const lists = Object.entries(T).filter(([k, v]) => k.endsWith('_STEPS') && Array.isArray(v));
  assert.ok(lists.length >= 8, `${lists.length} tutorials`);
  const missing = [];
  for (const [name, steps] of lists) {
    steps.forEach((st, i) => {
      for (const m of String(st.sel || '').matchAll(/#([A-Za-z][\w-]*)/g)) {
        if (!ids.has(m[1])) missing.push(`${name}[${i}] "${st.title}": #${m[1]}`);
      }
    });
  }
  assert.deepEqual(missing, []);
});
