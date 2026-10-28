// The radiograph's automatic display window (core/displayWindow.js). A thick part with raw beam
// beside it — AP pelvis, cervical spine, skull — used to come out washed white: the window's low
// end reached down for the thin tissue at the edge and the anatomy filled only the top of the
// grey scale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeRescale } from '../src/core/displayWindow.js';
import { latitudeImage, equalisedSignal } from '../src/core/equalise.js';

const luts = JSON.parse(readFileSync(new URL('../src/data/luts.json', import.meta.url), 'utf8')).luts;

const LUT = { sigmoid: true, center: 0.53, width: 0.8 };
const a = 40, den = Math.log(1 + a);
const tone = (s, mx) => 1 - Math.log(1 + a * s / mx) / den;     // the same base tone the app windows

// signal image: a fraction of raw beam (1.0), a thin-tissue rim, and thick anatomy
function image({ raw = 0.15, rim = 0.08, rimT = 0.2, thickT = [0.004, 0.012] }) {
  const n = 40000, sig = new Float32Array(n), mask = new Uint8Array(n).fill(1);
  let seed = 3; const r = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    const u = i / n;
    sig[i] = u < raw ? 1 : u < raw + rim ? rimT * (0.5 + r()) : thickT[0] + (thickT[1] - thickT[0]) * r();
  }
  return { sig, mask };
}
const outOf = (t, w) => { let x = (t - w.lo) / (w.hi - w.lo); x = x < 0 ? 0 : x > 1 ? 1 : x; return 1 / (1 + Math.exp(-4 * (x - LUT.center) / LUT.width)); };

test('a thick part beside raw beam is centred on the LUT, not washed out', () => {
  const { sig, mask } = image({});
  const w = computeRescale(sig, mask, LUT);
  const anat = Array.from(sig).filter((s) => s < 0.95).map((s) => tone(s, 1)).sort((x, y) => x - y);
  const med = anat[anat.length >> 1];
  assert.ok(Math.abs(outOf(med, w) - 0.5) < 0.06, `median anatomy displays at ${outOf(med, w).toFixed(2)}`);
  // and no more than ~12 % of the anatomy falls below the window (burns out)
  const below = anat.filter((t) => t < w.lo).length / anat.length;
  assert.ok(below <= 0.13, `${(below * 100).toFixed(1)} % of the anatomy below the window`);
});

test('anatomy whose median already sits low keeps the plain percentile window', () => {
  // a hand: mostly thin tissue, a little bone — its median is already below the LUT centre
  const { sig, mask } = image({ raw: 0.3, rim: 0.6, rimT: 0.5, thickT: [0.05, 0.2] });
  const w = computeRescale(sig, mask, LUT);
  const anat = Array.from(sig).filter((s) => s < 0.95).map((s) => tone(s, 1)).sort((x, y) => x - y);
  const p5 = anat[Math.floor(anat.length * 0.05)];
  assert.ok(Math.abs(w.lo - p5) < 0.01, `lo ${w.lo.toFixed(3)} vs the 5th percentile ${p5.toFixed(3)}`);
});

test('raw beam never sets the window, and an empty field gives none', () => {
  const { sig, mask } = image({});
  const w = computeRescale(sig, mask, LUT);
  assert.ok(w.hi < 1 && w.lo > tone(0.9, 1), 'the window lies inside the anatomy');
  assert.equal(computeRescale(new Float32Array(10).fill(1), new Uint8Array(10).fill(1), LUT), null);
});

test('a lateral spine takes its values of interest from the middle of the field', () => {
  // 200 x 200: the back edge (the first 15 % of columns) is thin tissue running from nearly raw
  // beam to the body; the rest is a thick body with the column across the middle
  const nx = 200, ny = 200, sig = new Float32Array(nx * ny), mask = new Uint8Array(nx * ny).fill(1);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const k = y * nx + x;
    sig[k] = x < 30 ? 0.9 * Math.pow(0.02, x / 30)                 // the thin strip at the back
      : (x > 70 && x < 130 ? 0.003 + 0.002 * ((y >> 3) & 1) : 0.012);  // column (bodies and discs), abdomen
  }
  const mx = 0.9;
  const out = (w, s) => Math.min(1, Math.max(0, (tone(s, mx) - w.lo) / (w.hi - w.lo)));
  const all = computeRescale(sig, mask, LUT, {}, nx);
  const core = computeRescale(sig, mask, { ...LUT, voiCore: 0.6 }, {}, nx);
  const bodies = 0.003, discs = 0.005;
  // the whole field: the column is pushed to the white end with little between bodies and discs
  assert.ok(out(all, bodies) > 0.85, `whole field: bodies at ${out(all, bodies).toFixed(2)}`);
  // the middle of the field: the column spreads over the grey scale
  assert.ok(out(core, bodies) - out(core, discs) > 2 * (out(all, bodies) - out(all, discs)),
    `contrast bodies/discs ${(out(core, bodies) - out(core, discs)).toFixed(2)} vs ${(out(all, bodies) - out(all, discs)).toFixed(2)}`);
  // without the image width it cannot locate the middle, and behaves as before
  assert.deepEqual(computeRescale(sig, mask, { ...LUT, voiCore: 0.6 }), all);
});

test('a limb LUT keeps its bone off the white end and its thin margins off the window', () => {
  // an elbow: a thin margin (a fifth), muscle, and 3 % bone a little denser than the muscle
  const n = 40000, sig = new Float32Array(n), mask = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    sig[i] = u < 0.2 ? 0.3 * (1 - u / 0.2) + 0.05 : u < 0.97 ? 0.03 + 0.01 * ((i * 7919) % 100) / 100 : 0.012 + 0.004 * ((i * 104729) % 100) / 100;
  }
  const mx = Math.max(...sig);                    // the window's tones are relative to the image's maximum
  const anat = Array.from(sig).filter((s) => s < 0.95 * mx).map((s) => tone(s, mx)).sort((x, y) => x - y);
  const bone = Array.from(sig.slice(Math.floor(0.97 * n))).map((s) => tone(s, mx));
  const plain = computeRescale(sig, mask, LUT);
  const limb = computeRescale(sig, mask, { ...LUT, clipHi: 0.002, clipLo: 0.2 });
  const burned = (w) => bone.filter((t) => t > w.hi).length / bone.length;
  assert.ok(burned(limb) < burned(plain) / 2, `bone above the window: ${burned(limb).toFixed(2)} vs ${burned(plain).toFixed(2)}`);
  assert.ok(limb.lo > plain.lo, `the dark end rises past the margin: ${limb.lo.toFixed(3)} vs ${plain.lo.toFixed(3)}`);
  assert.ok(anat.filter((t) => t < limb.lo).length / anat.length < 0.22, 'about a fifth of the anatomy (the margin) is given up');
});

test('a LUT with headroom sets white above the densest anatomy', () => {
  const { sig, mask } = image({});
  const plain = computeRescale(sig, mask, LUT);
  const pad = computeRescale(sig, mask, { ...LUT, hiPad: 0.3 });
  const mx = Math.max(...sig), top = Math.max(...Array.from(sig).filter((s) => s < 0.95 * mx).map((s) => tone(s, mx)));
  assert.ok(plain.hi < top, 'without it the densest 1 % burns white');
  assert.ok(pad.hi > top, `with it white lies past the densest: ${pad.hi.toFixed(3)} vs ${top.toFixed(3)}`);
  assert.equal(pad.lo, plain.lo);
});

test('a skull is equalised and windowed on its own pixels, not the raw beam beside it', () => {
  const lat = luts.skull.latitude;
  assert.equal(lat.voi, true, 'the skull LUT equalises on the patient\'s own pixels');
  // 120 x 150: raw beam falling from 1.0 at the middle to 0.45 at the sides (an angled Towne), round a
  // head whose vault is thick and whose face below it is thin; a fine texture on both
  const nx = 120, ny = 150, sig = new Float32Array(nx * ny), field = new Uint8Array(nx * ny).fill(1), voi = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const k = y * nx + x, r = Math.hypot((x - 60) / 45, (y - 75) / 60), fine = 1 + 0.15 * ((x + y) % 2);
    if (r > 1) { sig[k] = 1 - 0.55 * Math.abs(x - 60) / 60; continue; }
    voi[k] = 1;
    sig[k] = (y > 100 ? 0.08 : r > 0.85 ? 0.004 : 0.012) * fine;          // face, vault rim, brain under the vault
  }
  const mx = 1, own = latitudeImage(sig, nx, ny, field, mx, lat, voi), cut = latitudeImage(sig, nx, ny, field, mx, lat);
  const air = [...Array(nx * ny).keys()].filter((k) => !voi[k]);
  assert.ok(air.every((k) => Math.abs(own[k] - tone(sig[k], mx)) < 1e-6), 'the raw beam keeps its plain tone');
  assert.ok(air.some((k) => Math.abs(cut[k] - tone(sig[k], mx)) > 0.01), 'by the 0.95 cut, the falling raw beam is taken for anatomy');
  // windowed on the equalised tones, the window closes round the anatomy the film shows
  const raw = computeRescale(sig, voi, luts.skull, {}, nx, mx);
  const eq = computeRescale(equalisedSignal(sig, nx, ny, field, voi, lat), voi, luts.skull, {}, nx, mx);
  assert.ok(eq.hi - eq.lo < 0.8 * (raw.hi - raw.lo), `window ${(eq.hi - eq.lo).toFixed(3)} vs ${(raw.hi - raw.lo).toFixed(3)}`);
});
