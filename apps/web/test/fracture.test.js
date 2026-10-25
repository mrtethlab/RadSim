// The ankle exercise's fracture (core/fracture.js), on the real Foot volume. The anatomy is the
// test, not voxel counts (the foot is re-cut from the leg from time to time): the fibula must be
// found whole and alone down to its tip, the fracture must be a Weber B — at the syndesmosis,
// oblique from anteroinferior to posterosuperior — and the fragment must move by exactly what the
// pose says and come back to the scanned volume byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findFibula, fractureFragment, fragmentMove, boxSave, stampFragment, judgeReduction, mortiseAngle,
  BONE, WEBER_B, LIMITS } from '../src/core/fracture.js';

const hdr = JSON.parse(readFileSync(new URL('../public/models/foot/foot.model.json', import.meta.url), 'utf8'));
const data = new Uint8Array(readFileSync(new URL('../public/models/foot/foot.mat.bin', import.meta.url)));
const dims = hdr.dims, sp = hdr.spacing.map((s) => s / 10);
const [nx, ny] = dims;
const fib = findFibula(data, dims, sp, 0);
const frag = fractureFragment(data, dims, sp, fib, fib.latSign);
const cm2 = (n) => n * sp[0] * sp[1];
const vox = (o) => [o % nx, ((o / nx) | 0) % ny, Math.floor(o / (nx * ny))];

test('the fibula is found whole and alone, from the top of the volume to the malleolar tip', (t) => {
  assert.ok(fib, 'a two-bone leg');
  // from the top, below the cut end's dome (2.5 cm, data/crops.json's source: build_crop.py)
  assert.ok(fib.slices[0].k >= dims[2] - 1 - Math.round(2.5 / sp[2]), `it starts at the top: slice ${fib.slices[0].k} of ${dims[2]}`);
  const len = (fib.slices[0].k - fib.tipK) * sp[2];
  assert.ok(len > 8 && len < 13, `${len.toFixed(1)} cm of fibula in an 18.6 cm foot-and-ankle volume`);
  // a fibula is ~1-3 cm^2 in section; the tibia beside it is 5+. A slice that took in the tibia
  // or the talus through a fused contact would jump past 4.
  const big = Math.max(...fib.slices.map((s) => cm2(s.px.length)));
  t.diagnostic(`fibula ${len.toFixed(1)} cm long, tip at slice ${fib.tipK}, largest section ${big.toFixed(2)} cm^2`);
  assert.ok(big < 4, `largest fibula section ${big.toFixed(2)} cm^2`);
  // ...and it never collapses to a sliver above the tip (a hollow cortex once lost it there)
  const tipZone = Math.round(1.0 / sp[2]);
  for (let n = 1; n < fib.slices.length; n++) {
    const s = fib.slices[n], above = fib.slices[n - 1];
    if (s.k - fib.tipK < tipZone) break;
    assert.ok(s.px.length >= 0.5 * above.px.length, `slice ${s.k}: ${s.px.length} voxels under ${above.px.length}`);
  }
});

test('the fibula is the lateral bone: the tibia lies on the other side at every level it is found', () => {
  const top = fib.slices[0];
  let fi = 0;
  for (const q of top.px) fi += q % nx;
  fi /= top.px.length;
  // the rest of the top slice's bone is the tibia
  let ti = 0, tn = 0;
  const own = new Set(top.px);
  for (let q = 0; q < nx * ny; q++) if (BONE.has(data[top.k * nx * ny + q]) && !own.has(q)) { ti += q % nx; tn++; }
  const fb = top.px.filter((q) => BONE.has(data[top.k * nx * ny + q])).length;
  assert.ok(tn > 2 * fb, `the tibia is the bigger bone (${tn} voxels of bone against ${fb})`);
  assert.equal(Math.sign(fi - ti / tn), fib.latSign);
});

test('the fracture is a Weber B: at the syndesmosis, oblique from anteroinferior to posterosuperior', (t) => {
  assert.ok(frag && frag.idx.length > 1000, 'a distal fragment');
  const tipZ = fib.tipK * sp[2];
  const zs = Array.from(frag.idx, (o) => vox(o)[2] * sp[2]);
  const top = Math.max(...zs) - tipZ, bottom = Math.min(...zs) - tipZ;
  assert.ok(bottom < 0.3, 'the fragment holds the tip of the lateral malleolus');
  assert.ok(top > 3 && top < 5.5, `the fracture reaches ${top.toFixed(1)} cm above the tip: the syndesmosis, not the shaft (C) or below the joint (A)`);
  // oblique: the fragment's top edge — the fracture line on a lateral — climbs from front to back
  // (anterior is -j, the house convention) at the plane's 55 degrees: a slope of ~1.4 cm a cm
  const edge = new Map();
  for (const o of frag.idx) { const [, j, k] = vox(o); edge.set(j, Math.max(edge.get(j) ?? -1, k)); }
  // the middle of the bone front to back: at its rounded front and back the edge falls away
  const jr = [...edge.keys()].sort((a, b) => a - b), j0 = jr[Math.floor(jr.length * 0.2)], j1 = jr[Math.floor(jr.length * 0.8)];
  const pts = [...edge].filter(([j]) => j >= j0 && j <= j1).map(([j, k]) => [j * sp[1], k * sp[2]]);
  const mj = pts.reduce((s, p) => s + p[0], 0) / pts.length, mk = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const slope = pts.reduce((s, p) => s + (p[0] - mj) * (p[1] - mk), 0) / pts.reduce((s, p) => s + (p[0] - mj) ** 2, 0);
  assert.ok(slope > 0.9 && slope < 2.2, `the fracture line climbs ${slope.toFixed(2)} cm per cm toward the back`);
  const vol = frag.idx.length * sp[0] * sp[1] * sp[2];
  assert.ok(vol > 2 && vol < 15, `${vol.toFixed(1)} cm^3 of distal fibula`);
  // a piece of bone is a cortex round its marrow, and both move: the fragment carries its own
  // (the marrow is filled in by sliceMask; without it a moved fragment would arrive hollow)
  const marrow = Array.from(frag.mat).filter((m) => !BONE.has(m)).length / frag.idx.length;
  t.diagnostic(`fragment ${vol.toFixed(1)} cm^3 (${(100 * marrow).toFixed(0)} % marrow), from the tip to ${top.toFixed(1)} cm above it, edge climbing ${slope.toFixed(2)} cm/cm`);
  assert.ok(marrow > 0.03, `the fragment carries its marrow: ${(100 * marrow).toFixed(1)} % of it`);
});

test('the fragment moves by what the pose says: 4 mm lateral, 3 mm proximal, turned externally', (tc) => {
  const mv = fragmentMove(frag, WEBER_B), { M, t } = mv;
  const to = (v) => [0, 1, 2].map((r) => M[r * 3] * v[0] + M[r * 3 + 1] * v[1] + M[r * 3 + 2] * v[2] + t[r]);
  // the fragment's mean displacement, in its own anatomical axes: the turn is about its centroid,
  // so the mean is the translation alone — lateral, anterior, proximal exactly as the pose says
  const d = [0, 0, 0];
  for (const o of frag.idx) { const v = vox(o), w = to(v); for (let q = 0; q < 3; q++) d[q] += (w[q] - v[q]) * sp[q] / frag.idx.length; }
  const along = (u) => d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
  assert.ok(Math.abs(along(frag.lat) - WEBER_B.lat) < 1e-4, `lateral ${(along(frag.lat) * 10).toFixed(3)} mm, wanted 4`);
  assert.ok(Math.abs(along(frag.sup) - WEBER_B.prox) < 1e-4, `proximal ${(along(frag.sup) * 10).toFixed(3)} mm, wanted 3`);
  assert.ok(Math.abs(along(frag.ant)) < 1e-4, 'no front-to-back shift asked, none made');
  // and the volume carries it: the fragment's bone is found where the move puts it, and the tip
  // of the malleolus it left is soft tissue now
  const vol = data.slice(), saved = boxSave(vol, dims, frag.box);
  stampFragment(vol, dims, frag, saved, mv);
  let fb = 0, there = 0;
  const at = (i, j, k) => vol[(k * ny + j) * nx + i];
  for (const o of frag.idx) {
    if (!BONE.has(data[o])) continue;
    fb++;
    const w = to(vox(o)).map(Math.round);
    if (BONE.has(at(w[0], w[1], w[2]))) there++;
  }
  assert.ok(there / fb > 0.99, `${there} of ${fb} fragment bone voxels found where the move puts them`);
  tc.diagnostic(`${there} of ${fb} fragment bone voxels found where the move puts them`);
  const tip = frag.idx.filter((o) => BONE.has(data[o]) && vox(o)[2] === fib.tipK + 1);
  const left = tip.filter((o) => !BONE.has(vol[o])).length;
  assert.ok(tip.length && left / tip.length > 0.5, `${left} of ${tip.length} voxels at the old tip are bone no longer`);
  // rotation, from the move itself: the fragment's front turns toward lateral by 10 degrees
  const R10 = fragmentMove(frag, { rot: 10 }).M;
  const ant = frag.ant.map((v, q) => v / sp[q]);
  const turned = [0, 1, 2].map((r) => R10[r * 3] * ant[0] + R10[r * 3 + 1] * ant[1] + R10[r * 3 + 2] * ant[2]);
  const lt = turned.reduce((s, v, q) => s + v * sp[q] * frag.lat[q], 0), an = turned.reduce((s, v, q) => s + v * sp[q] * frag.ant[q], 0);
  assert.ok(Math.abs(Math.atan2(lt, an) * 180 / Math.PI - 10) < 0.01, 'external rotation turns the front laterally');
});

test('a reduction to zero gives back the scanned volume byte for byte, after any number of moves', () => {
  const vol = data.slice(), saved = boxSave(vol, dims, frag.box);
  stampFragment(vol, dims, frag, saved, fragmentMove(frag, WEBER_B));
  stampFragment(vol, dims, frag, saved, fragmentMove(frag, { lat: -0.3, ant: 0.2, prox: -0.5, rot: -20 }));
  stampFragment(vol, dims, frag, saved, fragmentMove(frag, { lat: 0, ant: 0, prox: 0, rot: 0 }));
  let diff = 0;
  for (let o = 0; o < vol.length; o++) if (vol[o] !== data[o]) diff++;
  assert.equal(diff, 0);
  stampFragment(vol, dims, frag, saved, null);                     // the case ended: as scanned
  for (let o = 0; o < vol.length; o++) if (vol[o] !== data[o]) diff++;
  assert.equal(diff, 0);
});

test('the reduction is judged at 2 mm and 5 degrees, with length on its own', () => {
  assert.equal(judgeReduction(WEBER_B).ok, false);
  assert.equal(judgeReduction({ lat: 0, ant: 0, prox: 0, rot: 0 }).ok, true);
  const r = judgeReduction({ lat: 0.12, ant: 0.16, prox: 0.2, rot: 5 });
  assert.equal(r.lengthMM, 2); assert.equal(r.lengthOK, true);
  assert.equal(r.transOK, true, '1.2 and 1.6 mm make 2.0 mm');
  assert.equal(r.rotOK, true);
  assert.equal(judgeReduction({ prox: 0.21 }).lengthOK, false, '2.1 mm short');
  assert.equal(judgeReduction({ prox: -0.21 }).lengthOK, false, 'over-lengthened is not restored either');
  assert.equal(judgeReduction({ lat: 0.15, ant: 0.15 }).transOK, false, '2.1 mm obliquely');
  assert.equal(judgeReduction({ rot: -5.1 }).rotOK, false);
  assert.deepEqual(LIMITS, { mm: 2, deg: 5 });
});

test('the mortise view is measured from this ankle: the lateral malleolus behind the medial', (t) => {
  const m = mortiseAngle(data, dims, sp, fib, fib.latSign);
  t.diagnostic(`mortise ${m.toFixed(1)} degrees`);
  assert.ok(m > 12 && m < 28, `mortise ${m.toFixed(1)} degrees (textbook 15-20)`);
});
