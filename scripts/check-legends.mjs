/* Assert that the two material legends agree.
 *
 * apps/web/src/core/materials.js LIST and services/compute/app/build_model.py LEGEND are
 * hand-duplicated: the browser owns mu(E) and sends it to the backend, the builder owns
 * what gets written into a model's header. They must agree in id, order, count and name.
 *
 * When they drifted before — the legend gained Lead and Acrylic while older models kept a
 * 28-entry header — CT scout raised "mat1 and mat2 shapes cannot be multiplied (460x28 and
 * 29x36)" for seven models, and only at render time. This turns that into a build-time
 * failure with a readable message.
 *
 *   node scripts/check-legends.mjs
 */
import { readFileSync } from 'node:fs';

const JS_PATH = 'apps/web/src/core/materials.js';
const PY_PATH = 'services/compute/app/build_model.py';

function jsLegend() {
  const src = readFileSync(JS_PATH, 'utf8');
  const start = src.indexOf('const LIST = [');
  if (start < 0) throw new Error(`no "const LIST = [" in ${JS_PATH}`);
  const body = src.slice(start, src.indexOf('\n  ];', start));
  const out = [];
  for (const m of body.matchAll(/\{\s*id:\s*(\d+)\s*,\s*name:\s*'([^']*)'/g)) {
    out.push({ id: +m[1], name: m[2] });
  }
  return out;
}

function pyLegend() {
  // LEGEND entries are (CONST, "Name", hu, colour); the vessels are appended by a
  // comprehension over VESSELS, which is (CONST, "Name").
  const src = readFileSync(PY_PATH, 'utf8');
  const consts = {};
  for (const m of src.matchAll(/^([A-Z][A-Za-z_]*(?:,\s*[A-Z][A-Za-z_]*)*)\s*=\s*range\((\d+)(?:,\s*(\d+))?\)/gm)) {
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
    const from = m[3] === undefined ? 0 : +m[2];
    names.forEach((n, i) => { consts[n] = from + i; });
  }
  // a lone `NAME = 53` constant (ids past the range blocks are declared this way)
  for (const m of src.matchAll(/^([A-Z][A-Za-z_]*)\s*=\s*(\d+)\s*(?:#.*)?$/gm)) {
    consts[m[1]] = +m[2];
  }
  // multi-line `A, B, \` continuations
  for (const m of src.matchAll(/^((?:[A-Z][A-Za-z_]*,\s*(?:\\\s*\n\s*)?)+[A-Z][A-Za-z_]*)\s*=\s*range\((\d+)(?:,\s*(\d+))?\)/gm)) {
    const names = m[1].replace(/\\\s*\n\s*/g, ' ').split(',').map(s => s.trim()).filter(Boolean);
    const from = m[3] === undefined ? 0 : +m[2];
    names.forEach((n, i) => { consts[n] = from + i; });
  }
  // Anchored to line start: a bare indexOf('LEGEND = [') also matches inside
  // 'GI_LEGEND = [', and as that one is declared first it silently grabbed the wrong list
  // and reported every entry as mismatched.
  const grab = (marker) => {
    const i = src.indexOf('\n' + marker);
    if (i < 0) throw new Error(`no "${marker}" at line start in ${PY_PATH}`);
    return src.slice(i + 1, src.indexOf('\n]', i));
  };
  const out = [];
  for (const m of grab('LEGEND = [').matchAll(/\(\s*([A-Z][A-Za-z_]*)\s*,\s*"([^"]*)"/g)) {
    out.push({ id: consts[m[1]], name: m[2], sym: m[1] });
  }
  for (const m of grab('VESSELS = [').matchAll(/\(\s*([A-Z][A-Za-z_]*)\s*,\s*"([^"]*)"/g)) {
    out.push({ id: consts[m[1]], name: m[2], sym: m[1] });
  }
  // The GI tail is a third named list, appended after the vessels (ids 47+).
  for (const m of grab('GI_LEGEND = [').matchAll(/\(\s*([A-Z][A-Za-z_]*)\s*,\s*"([^"]*)"/g)) {
    out.push({ id: consts[m[1]], name: m[2], sym: m[1] });
  }
  // ...and the mammography tail after that (id 53+), in the same concat order.
  for (const m of grab('MAMMO_LEGEND = [').matchAll(/\(\s*([A-Z][A-Za-z_]*)\s*,\s*"([^"]*)"/g)) {
    out.push({ id: consts[m[1]], name: m[2], sym: m[1] });
  }
  return out;
}

const js = jsLegend(), py = pyLegend();
const problems = [];

if (js.length !== py.length) {
  problems.push(`length: materials.js has ${js.length}, build_model.py has ${py.length}`);
}
for (let i = 0; i < Math.max(js.length, py.length); i++) {
  const a = js[i], b = py[i];
  if (!a) { problems.push(`id ${b.id} "${b.name}" is only in build_model.py`); continue; }
  if (!b) { problems.push(`id ${a.id} "${a.name}" is only in materials.js`); continue; }
  if (a.id !== b.id) problems.push(`slot ${i}: id ${a.id} (js) vs ${b.id} (py, ${b.sym})`);
  if (a.name !== b.name) problems.push(`id ${a.id}: name "${a.name}" (js) vs "${b.name}" (py)`);
  if (a.id !== i) problems.push(`id ${a.id} is at slot ${i} — ids must equal their index`);
}

if (problems.length) {
  console.error(`material legends disagree (${problems.length}):`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`material legends agree: ${js.length} entries, ids 0..${js.length - 1}`);
