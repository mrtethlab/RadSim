// The radiograph's automatic display window (core/displayWindow.js). A thick part with raw beam
// beside it — AP pelvis, cervical spine, skull — used to come out washed white: the window's low
// end reached down for the thin tissue at the edge and the anatomy filled only the top of the
// grey scale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRescale } from '../src/core/displayWindow.js';

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
