// Turning the femur about its head (core/limbPose.js), on the real chest/abdomen/pelvis volume.
// The anatomy is the test: the femur must come out of the pelvis whole and alone, the joint must
// stay seated, and internal rotation must do what it does on a film — tuck the lesser trochanter
// in behind the shaft — while external rotation throws it out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { segmentFemur, poseFemurs, raiseLeg } from '../src/core/limbPose.js';

const lm = JSON.parse(readFileSync(new URL('../src/data/landmarks.json', import.meta.url), 'utf8')).chestabdopelvis;
const hdr = JSON.parse(readFileSync(new URL('../public/models/chestabdopelvis/chestabdopelvis.model.json', import.meta.url), 'utf8'));
const data = new Uint8Array(readFileSync(new URL('../public/models/chestabdopelvis/chestabdopelvis.mat.bin', import.meta.url)));
const [nx, ny, nz] = hdr.dims, vs = hdr.spacing.map((s) => s / 10);
const M = { dims: [nx, ny, nz], vs, data };
const X = (i) => (i - (nx - 1) / 2) * vs[0], Y = (j) => (j - (ny - 1) / 2) * vs[1], Z = (k) => (k - (nz - 1) / 2) * vs[2];
const isBone = (m) => m === 17 || m === 18;
const HL = lm.femoralHeadL, HR = lm.femoralHeadR;
const FL = segmentFemur(M, HL), FR = segmentFemur(M, HR);

// every femur voxel as world-ish cm, from the box-local mask
function femurPoints(f) {
  const { i0, bx, by, bz } = f.box, pts = [];
  for (let k = 0; k < bz; k++) for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) {
    if (f.mask[(k * by + j) * bx + i]) pts.push([X(i0 + i), Y(j), Z(k)]);
  }
  return pts;
}

test('each femur comes out whole and alone — no pelvis attached', () => {
  for (const [f, h] of [[FL, HL], [FR, HR]]) {
    assert.ok(f, 'femur found');
    const cm3 = f.count * vs[0] * vs[1] * vs[2];
    // the proximal third: the head to 23 cm below it (the thighs grafted at the CAP's foot,
    // services/compute/app/build_cap_thighs.py; before them, to the lesser trochanter, 233 / 225)
    assert.ok(cm3 > 300 && cm3 < 400, `proximal femur ${cm3.toFixed(0)} cm3`);   // measured 348 / 345
    // the axis it turns about runs down the shaft: forward of vertical (the hips a little flexed)
    // and less than 20 degrees off it
    assert.ok(f.axis[2] > Math.cos(20 * Math.PI / 180), `axis ${f.axis.map((v) => v.toFixed(2))}`);
    const s = Math.sign(h.x);
    for (const [x, , z] of femurPoints(f)) {
      // the pelvis is above and medial: nothing of the femur may reach past the 3 cm cut there
      assert.ok(z < h.z + 3.01, `femur voxel ${(z - h.z).toFixed(1)} cm above the head centre`);
      assert.ok(s * (x - h.x) > -3.01, `femur voxel ${(s * (h.x - x)).toFixed(1)} cm medial of the head centre`);
    }
  }
});

test('the head turns in its socket: the joint stays seated and nothing else moves', () => {
  const P = poseFemurs(M, [FL, FR], 25, 1);
  let changedOutside = 0, headBefore = 0, headAfter = 0, boneBefore = 0, boneAfter = 0;
  const reach = Math.max(FL.rmax, FR.rmax) + 0.5;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = (k * ny + j) * nx + i, a = data[p], b = P[p];
    if (isBone(a)) boneBefore++; if (isBone(b)) boneAfter++;
    for (const h of [HL, HR]) {
      const dx = X(i) - h.x, dy = Y(j) - h.y, dz = Z(k) - h.z;
      if (dx * dx + dy * dy + dz * dz < 2.0 * 2.0) { if (isBone(a)) headBefore++; if (isBone(b)) headAfter++; }
    }
    if (a !== b) {
      // within the femur's reach of the axis it turns about, and below the cut over its head
      const near = [[HL, FL], [HR, FR]].some(([h, f]) => {
        const d = [X(i) - h.x, Y(j) - h.y, Z(k) - h.z], t = d[0] * f.axis[0] + d[1] * f.axis[1] + d[2] * f.axis[2];
        return Math.sqrt(Math.max(0, d[0] ** 2 + d[1] ** 2 + d[2] ** 2 - t * t)) < reach && Z(k) < h.z + 3.01;
      });
      if (!near) changedOutside++;
    }
  }
  assert.equal(changedOutside, 0, 'voxels changed away from the femurs');
  assert.ok(Math.abs(headAfter - headBefore) / headBefore < 0.03, `head bone ${headBefore} -> ${headAfter}`);
  assert.ok(Math.abs(boneAfter - boneBefore) / boneBefore < 0.005, `skeleton bone ${boneBefore} -> ${boneAfter}`);
  assert.deepEqual(poseFemurs(M, [FL, FR], 0, 1), data, 'zero rotation is the volume as scanned');
});

/* The textbook sign on an AP film. Project the posed femur alone (so the ischium cannot stand in
   for it) and measure how far the lesser trochanter stands proud of the medial shaft. */
function lesserTrochanter(f, h, deg) {
  const only = new Uint8Array(data.length);
  for (const [x, y, z] of femurPoints(f)) {
    const i = Math.round(x / vs[0] + (nx - 1) / 2), j = Math.round(y / vs[1] + (ny - 1) / 2), k = Math.round(z / vs[2] + (nz - 1) / 2);
    only[(k * ny + j) * nx + i] = 18;
  }
  const P = poseFemurs({ dims: M.dims, vs, data: only }, [f], deg, 1);
  const s = Math.sign(h.x);
  const medialEdge = (k) => {      // most medial column with > 3 mm of femur along the beam
    let best = -Infinity;
    for (let i = 0; i < nx; i++) {
      let n = 0; for (let j = 0; j < ny; j++) if (P[(k * ny + j) * nx + i] === 18) n++;   // (not the muscle it left)
      if (n * vs[1] > 0.3) best = Math.max(best, -s * X(i));
    }
    return best;
  };
  const zi = (z) => Math.round(z / vs[2] + (nz - 1) / 2);
  let lt = -Infinity;
  for (let k = zi(h.z - 8); k < zi(h.z - 4); k++) lt = Math.max(lt, medialEdge(k));
  return lt - medialEdge(zi(h.z - 12));      // against the shaft well below it
}

test('internal rotation tucks the lesser trochanter in; external rotation throws it out', () => {
  const lt = Object.fromEntries([-30, 0, 15, 25].map((d) => [d, lesserTrochanter(FL, HL, d)]));
  // measured: 2.4 / 1.6 / 1.0 / 0.8 cm (30 out / neutral / 15 in / 25 in); the steps are whole
  // voxels (2 mm), so each comparison asks for at least half of one
  assert.ok(lt[-30] > lt[0] + 0.4, `30 out ${lt[-30].toFixed(2)} vs neutral ${lt[0].toFixed(2)}`);
  assert.ok(lt[0] > lt[15] + 0.1, `neutral ${lt[0].toFixed(2)} vs 15 in ${lt[15].toFixed(2)}`);
  assert.ok(lt[15] > lt[25] + 0.1, `15 in ${lt[15].toFixed(2)} vs 25 in ${lt[25].toFixed(2)}`);
});

test('internal rotation brings each greater trochanter forward, on both sides', () => {
  // the trochanter lies behind the head as scanned (neck anteverted ~20 deg); internal rotation
  // swings it forward toward the head's coronal plane. Checks the sense of the turn per side.
  for (const [f, h] of [[FL, HL], [FR, HR]]) {
    const gtY = (vol) => {
      const s = Math.sign(h.x); let sy = 0, n = 0;
      for (let k = Math.round((h.z - 2) / vs[2] + (nz - 1) / 2); k <= Math.round((h.z + 0.5) / vs[2] + (nz - 1) / 2); k++)
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          if (s * (X(i) - h.x) < 3.5 || s * (X(i) - h.x) > 9) continue;   // lateral of the neck
          if (isBone(vol[(k * ny + j) * nx + i])) { sy += Y(j); n++; }
        }
      return sy / n;
    };
    const y0 = gtY(data), yIn = gtY(poseFemurs(M, [f], 20, 1)), yOut = gtY(poseFemurs(M, [f], -20, 1));
    assert.ok(y0 < h.y, `${h.x < 0 ? 'left' : 'right'} trochanter starts behind the head`);
    assert.ok(yIn > y0 + 0.5 && yOut < y0 - 0.5, `${h.x < 0 ? 'left' : 'right'}: out ${yOut.toFixed(2)} / neutral ${y0.toFixed(2)} / in ${yIn.toFixed(2)}`);
  }
});

test('the AP pelvis protocol turns the legs in 15 degrees', () => {
  const protocols = JSON.parse(readFileSync(new URL('../src/data/protocols.json', import.meta.url), 'utf8'));
  const ap = protocols.groups.flatMap((g) => g.regions.flatMap((r) => r.projections)).find((p) => p.proj === 'AP pelvis');
  assert.equal(ap.pose.legs, 15);
  assert.ok(lm.femoralHeadL.x < 0 && lm.femoralHeadR.x > 0, 'patient right is +x in this volume (the liver is)');
});

test('a cross-table lateral hip raises the other leg: its thigh leaves the beam, nothing else does', () => {
  const protocols = JSON.parse(readFileSync(new URL('../src/data/protocols.json', import.meta.url), 'utf8'));
  const xt = protocols.groups.flatMap((g) => g.regions.flatMap((r) => r.projections)).find((p) => p.proj === 'Cross-table lateral hip');
  assert.equal(xt.pose.lift, 'L', 'the right hip is filmed, the left leg raised');
  const out = raiseLeg(M, new Uint8Array(data), [HL, HR], 'L');
  let gone = 0, goneRight = 0, goneHigh = 0, leftThigh = 0;
  const mid = (HL.x + HR.x) / 2;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = (k * ny + j) * nx + i;
    if (Z(k) < HL.z - 12 && X(i) < mid - 3 && data[p]) leftThigh++;
    if (data[p] === out[p]) continue;
    gone++;
    if (X(i) > mid) goneRight++;
    if (Z(k) > HL.z - 8.9) goneHigh++;
  }
  assert.ok(leftThigh > 0, 'this volume has a left thigh to raise');
  assert.ok(gone > 0.9 * leftThigh, `${gone} voxels out of the beam (the thigh below 12 cm: ${leftThigh})`);
  assert.equal(goneRight, 0, 'the right leg stays');
  assert.equal(goneHigh, 0, 'the buttock and pelvis stay');
});

/* THE GRAFT'S SEAM (services/compute/app/build_cap_thighs.py). The CAP's CT stops below the lesser
   trochanters and the thighs under it are grafted; at the seam the femur is morphed from the CAP's
   into the donor's. A radiographer read the first graft as an impacted fracture: the canal's
   content (the CAP's all trabecular, the donor's half marrow) changed in a band a few millimetres
   tall, and the cortex jogged. Down each femur slice by slice from 12 mm above the seam: the one
   bone piece runs on, its outline and its cortex change by no more than they do a slice apart
   elsewhere, and the canal's mean density changes gradually (measured: at most 50 HU in 8 mm; the
   first graft's 165 HU). */
const SEAM_K = 78;                                   // the graft's rows: 75 new slices and the CAP's 3 bad ones
const HU = new Float32Array(256);
for (const m of hdr.materials) HU[m.id] = m.hu ?? 0;
function femurSections(h) {
  const out = [];
  let ci = Math.round(h.x / vs[0] + (nx - 1) / 2), cj = Math.round(h.y / vs[1] + (ny - 1) / 2);
  for (let k = SEAM_K + 6; k > SEAM_K - 40; k--) {
    // the largest bone piece (4-connected, in this slice) within 8 voxels of the last section's centre
    const at = (i, j) => data[(k * ny + j) * nx + i];
    const lab = new Uint8Array(nx * ny);
    let best = Infinity, top = 0;
    const flood = (seed, L) => {
      const q = [seed], s = { L, si: 0, sj: 0, n: 0, cort: 0, i0: nx, i1: 0, j0: ny, j1: 0 };
      lab[seed] = L;
      while (q.length) {
        const p = q.pop(), i = p % nx, j = (p / nx) | 0;
        s.si += i; s.sj += j; s.n++; if (at(i, j) === 18) s.cort++;
        s.i0 = Math.min(s.i0, i); s.i1 = Math.max(s.i1, i); s.j0 = Math.min(s.j0, j); s.j1 = Math.max(s.j1, j);
        for (const [a, b] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
          if (a < 0 || b < 0 || a >= nx || b >= ny || lab[b * nx + a] || !isBone(at(a, b))) continue;
          lab[b * nx + a] = L; q.push(b * nx + a);
        }
      }
      return s;
    };
    let P = null, L = 0;
    for (let j = Math.max(0, cj - 8); j <= Math.min(ny - 1, cj + 8); j++) for (let i = Math.max(0, ci - 8); i <= Math.min(nx - 1, ci + 8); i++) {
      if (!isBone(at(i, j))) continue;
      best = Math.min(best, (i - ci) ** 2 + (j - cj) ** 2);
      if (lab[j * nx + i] || L === 255) continue;
      const s = flood(j * nx + i, ++L);
      if (s.n > top) { top = s.n; P = s; }
    }
    if (!P) { out.push({ k, gap: Infinity }); continue; }
    const { si, sj, n, cort, i0, i1, j0, j1 } = P;
    ci = Math.round(si / n); cj = Math.round(sj / n);
    // what a wall closes in: the voxels of the box no flood from its edge reaches through the rest
    // (the outline: the piece's; the canal: its cortex's, the non-cortical voxels it closes in)
    const bw = i1 - i0 + 3, bh = j1 - j0 + 3;
    const inside = (wall) => {
      const seen = new Uint8Array(bw * bh), f = [0];
      seen[0] = 1;
      while (f.length) {
        const p = f.pop(), a = p % bw, b = (p / bw) | 0;
        for (const [u, v] of [[a - 1, b], [a + 1, b], [a, b - 1], [a, b + 1]]) {
          if (u < 0 || v < 0 || u >= bw || v >= bh || seen[v * bw + u] || wall(u + i0 - 1, v + j0 - 1)) continue;
          seen[v * bw + u] = 1; f.push(v * bw + u);
        }
      }
      return seen;
    };
    const ok = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny;
    const mine = (i, j) => ok(i, j) && lab[j * nx + i] === P.L;
    const outl = inside(mine), can = inside((i, j) => mine(i, j) && at(i, j) === 18);
    let hu = 0, cn = 0, area = 0;
    for (let b = 1; b < bh - 1; b++) for (let a = 1; a < bw - 1; a++) {
      const v = at(a + i0 - 1, b + j0 - 1);
      if (!outl[b * bw + a]) area++;
      if (!can[b * bw + a] && v !== 18) { hu += HU[v]; cn++; }
    }
    // (a canal the cortex does not close, at 2 mm, is not measured)
    out.push({ k, n, cort, area, canal: cn ? hu / cn : NaN, gap: Math.sqrt(best) });
  }
  return out;
}

test('the grafted femur runs on through the seam: no step in its outline or cortex, no band in its canal', () => {
  for (const h of [HL, HR]) {
    const S = femurSections(h), side = h.x < 0 ? 'left' : 'right';
    for (let s = 1; s < S.length; s++) {
      const a = S[s - 1], b = S[s];
      assert.ok(b.gap < 3, `${side} slice ${b.k}: the femur runs on (its nearest bone ${b.gap.toFixed(1)} voxels off)`);
      assert.ok(Math.abs(b.area - a.area) / a.area < 0.08, `${side} slice ${b.k}: outline ${a.area} -> ${b.area} voxels`);
      assert.ok(Math.abs(b.cort - a.cort) / a.cort < 0.1, `${side} slice ${b.k}: cortex ${a.cort} -> ${b.cort} voxels`);
    }
    let worst = 0;
    for (let s = 4; s < 30; s++) {
      if (Number.isNaN(S[s].canal) || Number.isNaN(S[s - 4].canal)) continue;
      worst = Math.max(worst, Math.abs(S[s].canal - S[s - 4].canal));
    }
    assert.ok(worst < 80, `${side}: the canal's density changes ${worst.toFixed(0)} HU in 8 mm across the seam`);
  }
});
