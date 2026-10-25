// The pulse worker itself (src/fluoro-worker.js), run in node: what it is sent is what it images.
// A wire it is given must darken exactly the pixels it crosses and leave every other pixel's
// transmission untouched, and a fracture fragment must change the frame when moved and give the
// scanned frame back, exactly, when the case ends. Noise-free pulses (photons 0) so frames compare.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findFibula, fractureFragment, fragmentMove, WEBER_B } from '../src/core/fracture.js';
import { WIRE_R_CM } from '../src/core/guidewire.js';

const frames = [];
globalThis.onmessage = null;
globalThis.postMessage = (m) => frames.push(m);
await import('../src/fluoro-worker.js');
const send = (m) => globalThis.onmessage({ data: m });
let id = 0;
// the OEC at 0/0: tube 60 cm under the isocentre, the II 39 cm over it, 9" field
const G = { src: [0, -60, 0], detC: [0, 39, 0], detU: [1, 0, 0], detV: [0, 0, 1], half: 11.5 };
const pulse = (extra) => {
  send({ type: 'pulse', id: ++id, kv: 70, photons: 0, ...G, n: 96, rot: null, center: null, anim: { off: true }, ...extra });
  return frames[frames.length - 1].img;
};

test('a wire sent with the pulse darkens its own pixels and nothing else', (t) => {
  // a 12.8 cm cube of water at the isocentre, 2 mm voxels
  const N = 64, data = new Uint8Array(N * N * N).fill(3);
  send({ type: 'init', dims: [N, N, N], vs: [0.2, 0.2, 0.2], vsMM: [2, 2, 2], data, center: [0, 0, 0], flip: [false, false, false] });
  const a = pulse({ n: 192 });
  // the wire along the volume's i axis through its middle, on a pixel row's centre at the detector
  const pix = 2 * G.half / 192, zc = ((96 + 0.5) * pix - G.half) * 60 / 99;
  const kIdx = (zc + N * 0.2 / 2) / 0.2 - 0.5;                           // voxel index of that height
  const wire = new Float32Array(3 * 21);
  for (let q = 0; q <= 20; q++) wire.set([12 + q * 2, 31.5, kIdx], 3 * q);
  const b = pulse({ n: 192, wire, wireR: WIRE_R_CM });
  let lo = 1, changed = 0, rows = new Set();
  for (let k = 0; k < 192 * 192; k++) {
    if (a[k] < 0) continue;
    const r = b[k] / a[k];
    if (r < 0.999999) { changed++; rows.add((k / 192) | 0); lo = Math.min(lo, r); }
    assert.ok(r <= 1 + 1e-6, 'a wire never brightens');
  }
  t.diagnostic(`wire: ${changed} pixels on rows ${[...rows]}, darkest at ${lo.toFixed(3)} of the water's transmission`);
  // a pixel is 0.73 mm at the isocentre and the wire 0.89 mm: the one it is centred on is mostly
  // wire, and steel at 70 kV, through a beam hardened by 12.8 cm of water, still stops most of it
  assert.ok(lo < 0.5, `transmission through the wire falls to ${lo.toFixed(2)} of the water's (steel at 70 kV)`);
  assert.ok(rows.size <= 3 && rows.has(96), `the wire draws on rows ${[...rows]}`);
  // 8 cm of wire, magnified 1.65, on 1.2 mm pixels: ~110 columns, one to three rows deep
  assert.ok(changed > 100 && changed < 400, `${changed} pixels darkened`);
  // and the same pulse without it is the water again, exactly
  const c = pulse({ n: 192 });
  for (let k = 0; k < c.length; k++) assert.equal(c[k], a[k]);
});

test('the wire lies where the volume does, through the flips and a turned patient', () => {
  // a bone rod off-centre on every axis (in water: i 4..29, j 14, k 33), and the wire given the same voxel
  // indices: whatever the flips and the patient's turn, the wire must image inside the rod's shadow
  const N = 48, data = new Uint8Array(N * N * N).fill(3), J = 14, K = 33;
  for (let i = 4; i < 30; i++) for (let dj = -2; dj <= 2; dj++) for (let dk = -2; dk <= 2; dk++) data[((K + dk) * N + J + dj) * N + i] = 18;
  const wire = new Float32Array(3 * 21);
  for (let q = 0; q <= 20; q++) wire.set([8 + q, J, K], 3 * q);         // i 8..28, inside the rod
  const c = Math.cos(0.4), s = Math.sin(0.4);
  for (const [flip, rot] of [[[false, false, false], null], [[true, true, false], null], [[true, true, false], [c, 0, s, 0, 1, 0, -s, 0, c]]]) {
    send({ type: 'init', dims: [N, N, N], vs: [0.2, 0.2, 0.2], vsMM: [2, 2, 2], data: data.slice(), center: [0, 0, 0], flip, rot });
    const a = pulse({ n: 192, rot }), b = pulse({ n: 192, rot, wire, wireR: WIRE_R_CM });
    let inRod = 0, out = 0;
    for (let k = 0; k < a.length; k++) {
      if (a[k] < 0 || b[k] / a[k] > 0.97) continue;
      // the rod's shadow: transmission well under the water beside it
      if (a[k] < 0.9 * Math.max(a[k - 192 * 8] || 0, a[k + 192 * 8] || 0)) inRod++; else out++;
    }
    assert.ok(inRod > 50 && out <= 0.05 * inRod, `flip ${flip} rot ${!!rot}: ${inRod} wire pixels in the rod's shadow, ${out} outside it`);
  }
});

test('the fracture fragment, sent once, moves with the pulses and goes home when the case ends', (t) => {
  const hdr = JSON.parse(readFileSync(new URL('../public/models/foot/foot.model.json', import.meta.url), 'utf8'));
  const data = new Uint8Array(readFileSync(new URL('../public/models/foot/foot.mat.bin', import.meta.url)));
  const dims = hdr.dims, vs = hdr.spacing.map((s) => s / 10), flip = [true, true, false];
  const fib = findFibula(data, dims, vs, 0), frag = fractureFragment(data, dims, vs, fib, fib.latSign);
  // place the volume so the fracture sits at the isocentre
  const local = frag.p0.map((p, a) => { const d = p / vs[a] - (dims[a] - 1) / 2; return (flip[a] ? -d : d) * vs[a]; });
  send({ type: 'init', dims, vs, vsMM: hdr.spacing, data: data.slice(), center: local.map((v) => -v), flip });
  send({ type: 'frag', frag: { idx: frag.idx, mat: frag.mat, box: frag.box } });
  const a = pulse({ fragMove: null });
  const b = pulse({ fragMove: { ...fragmentMove(frag, WEBER_B), v: 1 } });
  let moved = 0;
  for (let k = 0; k < a.length; k++) if (a[k] >= 0 && Math.abs(Math.log(b[k] / a[k])) > 0.05) moved++;
  t.diagnostic(`displacement changed ${moved} of ${a.filter((v) => v >= 0).length} field pixels by > 5 % transmission`);
  // ~1 cm^2 of fibula at ~2.4 mm pixels shifted 4 mm and turned: dozens of pixels, not the frame
  assert.ok(moved > 20 && moved < 0.2 * 96 * 96, `${moved} pixels changed by the displacement`);
  const same = pulse({ fragMove: { ...fragmentMove(frag, WEBER_B), v: 1 } });
  for (let k = 0; k < b.length; k++) assert.equal(same[k], b[k], 'an unchanged pose is not re-stamped differently');
  const c = pulse({ fragMove: null });
  for (let k = 0; k < a.length; k++) assert.equal(c[k], a[k], 'the case ended: the scanned ankle, exactly');
  const d = pulse({ fragMove: { ...fragmentMove(frag, { lat: 0, ant: 0, prox: 0, rot: 0 }), v: 2 } });
  for (let k = 0; k < a.length; k++) assert.equal(d[k], a[k], 'reduced to anatomic: the scanned ankle, exactly');
});
