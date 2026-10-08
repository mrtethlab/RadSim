// Turning the femur about its head (core/limbPose.js), on the real chest/abdomen/pelvis volume.
// The anatomy is the test: the femur must come out of the pelvis whole and alone, the joint must
// stay seated, and internal rotation must do what it does on a film — tuck the lesser trochanter
// in behind the shaft — while external rotation throws it out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { segmentFemur, poseFemurs } from '../src/core/limbPose.js';

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
    assert.ok(cm3 > 190 && cm3 < 270, `proximal femur ${cm3.toFixed(0)} cm3`);   // measured 233 / 225
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
      const near = [HL, HR].some((h) => Math.hypot(X(i) - h.x, Y(j) - h.y) < reach && Z(k) < h.z + 3.01);
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
      let n = 0; for (let j = 0; j < ny; j++) if (P[(k * ny + j) * nx + i]) n++;
      if (n * vs[1] > 0.3) best = Math.max(best, -s * X(i));
    }
    return best;
  };
  const zi = (z) => Math.round(z / vs[2] + (nz - 1) / 2);
  let lt = -Infinity;
  for (let k = zi(h.z - 8); k < zi(h.z - 4); k++) lt = Math.max(lt, medialEdge(k));
  return lt - medialEdge(zi(-34.5));
}

test('internal rotation tucks the lesser trochanter in; external rotation throws it out', () => {
  const lt = Object.fromEntries([-30, 0, 15, 25].map((d) => [d, lesserTrochanter(FL, HL, d)]));
  // measured: 2.0 / 1.2 / 1.0 / 0.8 cm (30 out / neutral / 15 in / 25 in); the steps are whole
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
