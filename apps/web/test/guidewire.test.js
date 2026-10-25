// The guidewire (core/guidewire.js) on the real chest/abdomen/pelvis vessel tree, and its image.
// The tree must be the contrast solver's own (centrelines inside their vessels, junctions where
// the vessels meet and nowhere else), the wire must go where a wire goes — up the aorta when
// pushed, into a branch only when its tip is turned to it — and its image must carry exactly a
// 0.89 mm steel cylinder's worth of attenuation, continuous, not a dashed line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSVolume } from '../src/core/contrast.js';
import { vesselCentrelines, vesselJunctions, wireStart, wireMove, wirePolyline, chord, wireFactors,
  WIRE_R_CM, ARTERIES, VEINS } from '../src/core/guidewire.js';

const M = 'chestabdopelvis';
const hdr = JSON.parse(readFileSync(new URL(`../public/models/${M}/${M}.model.json`, import.meta.url), 'utf8'));
const mat = new Uint8Array(readFileSync(new URL(`../public/models/${M}/${M}.mat.bin`, import.meta.url)));
const ab = readFileSync(new URL(`../public/models/${M}/${M}.arclen.bin`, import.meta.url));
const sVol = buildSVolume(mat, new Uint16Array(ab.buffer, ab.byteOffset, ab.length / 2));
const dims = hdr.dims, sp = hdr.spacing.map((s) => s / 10), [nx, ny, nz] = dims;
const lines = vesselCentrelines(mat, sVol, dims, sp);
const juncs = vesselJunctions(mat, dims, sp, lines);
const UP = [0, 1, 0];                      // this model is stored rolled: +j is anterior, the ceiling
const has = (a, b) => juncs.some((J) => (J.a === a && J.b === b) || (J.a === b && J.b === a));
const pathOf = (w) => w.route.reduce((p, r) => (p[p.length - 1] === r.v ? p : [...p, r.v]), []);

test('every centreline runs inside its own vessel', () => {
  for (const [id, L] of Object.entries(lines)) {
    let inside = 0;
    for (const p of L.pts) {
      const c = p.map((v, a) => Math.round(v / sp[a]));
      let hit = false;
      for (let dk = -1; dk <= 1 && !hit; dk++) for (let dj = -1; dj <= 1 && !hit; dj++) for (let di = -1; di <= 1 && !hit; di++) {
        const i = c[0] + di, j = c[1] + dj, k = c[2] + dk;
        if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && mat[(k * ny + j) * nx + i] === +id) hit = true;
      }
      if (hit) inside++;
    }
    assert.ok(inside / L.pts.length > 0.95, `vessel ${id}: ${inside} of ${L.pts.length} centreline points in its lumen`);
  }
});

test('the junctions are the real ones: the aortic bifurcation and the arch, arteries with arteries', () => {
  for (const [a, b] of [[29, 43], [29, 44], [29, 35], [29, 39], [29, 37], [35, 36], [35, 38]]) assert.ok(has(a, b), `${a}-${b}`);
  const A = new Set(ARTERIES), V = new Set(VEINS);
  for (const J of juncs) assert.ok((A.has(J.a) && A.has(J.b)) || (V.has(J.a) && V.has(J.b)), `${J.a}-${J.b} crosses a vessel wall`);
  assert.ok(!has(43, 45) && !has(44, 46), 'an iliac artery is never joined to the vein it lies on');
});

test('pushed from the right groin, the wire climbs the iliac and the aorta to the aortic valve', () => {
  const w = wireStart(lines, juncs, 43, UP);
  w.torque = 180;                            // pointing at the table, as the console starts it
  wireMove(w, 200);
  assert.deepEqual(pathOf(w), [43, 29]);
  assert.ok(w.blocked, 'it stops at the end of the map: the aortic root');
  const len = (lines[43].pts.length + lines[29].pts.length) * 0.2;
  assert.ok(Math.abs(w.len - len) < 2, `${w.len.toFixed(1)} cm in, of ${len.toFixed(1)}`);
  assert.equal(w.route[0].i, lines[43].pts.length - 1, 'the access is the groin end, the end that joins nothing');
});

test('at a branch the wire goes where the tip points, and withdrawing past it undoes the choice', () => {
  const reach = new Map();
  for (let t = 0; t < 360; t += 15) {
    const w = wireStart(lines, juncs, 43, UP);
    w.torque = t; wireMove(w, 200);
    const p = pathOf(w);
    reach.set(p[2] ?? 'root', [...(reach.get(p[2] ?? 'root') || []), t]);
  }
  // the arch vessels and the contralateral iliac are each reachable by turning the tip — and
  // the aortic root by not turning it toward any of them
  for (const v of [35, 37, 44, 'root']) assert.ok(reach.has(v), `${v} reachable: ${JSON.stringify([...reach])}`);
  // a branch is a choice, not a trap: in the brachiocephalic, pull back into the arch, turn away
  const t35 = reach.get(35)[0];
  const w = wireStart(lines, juncs, 43, UP);
  w.torque = t35; wireMove(w, 200);
  assert.equal(pathOf(w)[2], 35);
  const jAt = juncs.find((J) => (J.a === 29 && J.b === 35) || (J.a === 35 && J.b === 29));
  const into = w.route.findIndex((r) => r.v === 35);
  wireMove(w, -(w.route.length - into + 3) * 0.2);
  assert.deepEqual(pathOf(w), [43, 29], 'withdrawn to the arch');
  w.torque = reach.get('root')[0]; wireMove(w, 200);
  assert.deepEqual(pathOf(w), [43, 29], `on to the root past the junction at aorta ${jAt.a === 29 ? jAt.ia : jAt.ib}`);
});

test('a chord through the wire is a cylinder chord', () => {
  const r = 0.5;
  assert.equal(chord([0, 0, -5], [0, 0, 1], [-1, 0, 0], [1, 0, 0], r), 1);                       // through the axis
  assert.ok(Math.abs(chord([0, 0.3, -5], [0, 0, 1], [-1, 0, 0], [1, 0, 0], r) - 0.8) < 1e-12);   // 2 sqrt(r^2 - d^2)
  const s = Math.SQRT1_2;                                                                        // 45 degrees: 1 / sin
  assert.ok(Math.abs(chord([-5 * s, 0, -5 * s], [s, 0, s], [-3, 0, 0], [3, 0, 0], r) - 1 / s) < 1e-9);
  assert.equal(chord([2, 0, -5], [0, 0, 1], [-1, 0, 0], [1, 0, 0], r), 0, 'past the end');
  assert.equal(chord([-5, 0, 0], [1, 0, 0], [-1, 0, 0], [1, 0, 0], r), 2, 'end-on: its length');
});

test('the wire images as its own volume of steel, continuous across the detector', (t) => {
  // a 6 cm wire across the field at the isocentre, square to the beam; the C-arm's geometry
  const src = [0, -60, 0], detC = [0, 39, 0], detU = [1, 0, 0], detV = [0, 0, 1], half = 11.5, n = 192;
  const pts = []; for (let x = -3; x <= 3.0001; x += 0.2) pts.push([x, 0, 0.37]);
  // weak attenuation, where -ln(mean exp(-mu L)) = mu mean(L): the image's integral of chord
  // over the pixels, at the wire's plane, must be the wire's volume
  const mu = 1e-3, g = wireFactors(pts, WIRE_R_CM, [mu, mu, mu], src, detC, detU, detV, half, n);
  const pixIso = (2 * half / n) * 60 / 99;
  let sum = 0;
  for (let k = 0; k < n * n; k++) if (g[0][k] < 1) sum += -Math.log(g[0][k]) / mu * pixIso * pixIso;
  const vol = Math.PI * WIRE_R_CM ** 2 * 6;
  assert.ok(Math.abs(sum / vol - 1) < 0.03, `imaged ${sum.toExponential(3)} cm^3 of wire, it is ${vol.toExponential(3)}`);
  // and no gaps. At the coarsest sampling tier (112 px: 1.24 mm a pixel at the isocentre) a
  // 0.89 mm wire is narrower than the ray spacing, so rays through pixel centres alone would miss
  // it wherever it runs between them — a dashed wire. Laid at a slant across rows, every column
  // it crosses must see it, and by about the same amount (a pixel integrates over its face).
  const n2 = 112, p2 = 2 * half / n2;
  const slant = []; for (let x = -3; x <= 3.0001; x += 0.2) slant.push([x, 0, 0.1 + 0.12 * x]);
  const g2 = wireFactors(slant, WIRE_R_CM, [mu, mu, mu], src, detC, detU, detV, half, n2);
  const u0 = Math.ceil((-3 * 99 / 60 + half) / p2) + 1, u1 = Math.floor((3 * 99 / 60 + half) / p2) - 1;
  const cols = [];
  for (let i = u0; i <= u1; i++) {
    let s = 0;
    for (let j = 0; j < n2; j++) s += -Math.log(g2[0][j * n2 + i]) / mu;
    assert.ok(s > 0, `column ${i} misses the wire`);
    cols.push(s);
  }
  const mean = cols.reduce((a, b) => a + b, 0) / cols.length, sd = Math.sqrt(cols.reduce((a, b) => a + (b - mean) ** 2, 0) / cols.length);
  t.diagnostic(`wire volume imaged ${(sum / vol).toFixed(4)} of true; 112-px columns ${cols.length}, chord-sum spread ${(100 * sd / mean).toFixed(1)} %`);
  assert.ok(sd / mean < 0.25, `the wire's density varies ${(100 * sd / mean).toFixed(0)} % column to column`);
  // steel at a fluoro beam's energies is near-opaque across its middle: a real 0.035" wire reads black
  // (centred on a pixel row here: off-centre it shares itself between two, as a real one does)
  const zc = ((100 + 0.5) * (2 * half / n) - half) * 60 / 99;
  const steel = wireFactors(pts.map((p) => [p[0], p[1], zc]), WIRE_R_CM, [25, 9, 3.5], src, detC, detU, detV, half, n);
  let lo = 1; for (let k = 0; k < n * n; k++) lo = Math.min(lo, steel[0][k]);
  assert.ok(lo < 0.2, `the lowest bin's transmission through the wire's pixel ${lo.toFixed(2)}`);
});

test('the wire polyline leaves the body through the access and ends in its angled tip', () => {
  const w = wireStart(lines, juncs, 43, UP);
  w.torque = 180; wireMove(w, 30);
  const P = wirePolyline(w), groin = lines[43].pts[lines[43].pts.length - 1];
  const out = P[0];
  assert.ok(Math.hypot(out[0] - groin[0], out[1] - groin[1], out[2] - groin[2]) > 14, 'fifteen centimetres of it outside');
  // the tip bends off the body's line, by no more than the vessel holds
  const n = P.length, a = P[n - 6], b = P[n - 5], c = P[n - 2], d = P[n - 1];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
  const ang = Math.acos((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / Math.hypot(...u) / Math.hypot(...v)) * 180 / Math.PI;
  assert.ok(ang > 10 && ang <= 46, `the tip turns ${ang.toFixed(0)} degrees`);
});
