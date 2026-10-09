// DXA analysis. Every rule here was got wrong at least once and corrected against a reading
// from a technologist: these tests are those corrections, written down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scores, diagnosis, classify, priorScan, ageMean, REF, hipDiagnosis, findLevels, findFemur, measure } from '../src/dxa.js';

// ---------------------------------------------------------------- scoring
test('T compares against a young adult, so it does not depend on age', () => {
  for (const site of ['spine', 'neck', 'total']) {
    const a = scores(0.9, site, 'f', 35).T, b = scores(0.9, site, 'f', 80).T;
    assert.equal(a, b, `${site}: T at 35 vs 80`);
  }
});

test('Z equals T until bone loss begins, then sits above it', () => {
  assert.equal(scores(0.9, 'spine', 'f', 35).Z, scores(0.9, 'spine', 'f', 35).T);
  const old = scores(0.8, 'spine', 'f', 75);
  assert.ok(old.Z > old.T, `at 75 the age-matched mean is lower, so Z ${old.Z.toFixed(2)} > T ${old.T.toFixed(2)}`);
  assert.ok(ageMean('spine', 'f', 75) < REF.spine.f.yMean);
});

test('WHO bands: normal >= -1.0, osteopenia -1.0..-2.5, osteoporosis <= -2.5', () => {
  assert.equal(diagnosis(-1.0), 'Normal');
  assert.equal(diagnosis(-1.01), 'Osteopenia');
  assert.equal(diagnosis(-2.49), 'Osteopenia');
  assert.equal(diagnosis(-2.5), 'Osteoporosis');
});

test('each femoral region is scored against its own reference', () => {
  // one mean for all five made a normal trochanter look osteoporotic
  const means = ['neck', 'troch', 'inter', 'total', 'wards'].map((k) => REF[k].f.yMean);
  assert.equal(new Set(means).size, 5);
  assert.ok(REF.inter.f.yMean > REF.total.f.yMean && REF.total.f.yMean > REF.neck.f.yMean && REF.neck.f.yMean > REF.troch.f.yMean);
});

// ---------------------------------------------------------------- hip diagnosis
const bmdForT = (site, T, sex = 'f') => REF[site][sex].yMean + T * REF[site][sex].ySD;
const hipRois = (neckT, totalT) => [
  { label: 'Neck', bmd: bmdForT('neck', neckT), area: 5, bmc: 4 },
  { label: 'Total', bmd: bmdForT('total', totalT), area: 38, bmc: 33 },
];

test('hip: a low neck decides, even when the total hip is normal', () => {
  // the exact case measured on a real scan at 4 % mineral loss — the old code said Normal
  const h = hipDiagnosis(hipRois(-1.10, -0.93), 'f', 62);
  assert.equal(h.site, 'femoral neck');
  assert.equal(h.dx, 'Osteopenia');
  assert.ok(Math.abs(h.T + 1.10) < 1e-9);
  assert.ok(Math.abs(h.totT + 0.93) < 1e-9, 'the total row keeps its own T');
});

test('hip: when the total hip is lower, it decides', () => {
  const h = hipDiagnosis(hipRois(-0.5, -2.7), 'f', 62);
  assert.equal(h.site, 'total hip');
  assert.equal(h.dx, 'Osteoporosis');
});

test('hip: the headline area and BMD stay on the total hip, whichever site decides', () => {
  const h = hipDiagnosis(hipRois(-2.0, -0.5), 'f', 62);
  assert.equal(h.area, 38);
  assert.ok(Math.abs(h.mean - bmdForT('total', -0.5)) < 1e-12);
});

test('under 50 the report classifies on Z, per ISCD; from 50 on T', () => {
  // a 40-year-old with T -2.7 was being called osteoporotic on T alone
  const young = classify(-2.7, -1.5, 40);
  assert.equal(young.by, 'Z');
  assert.equal(young.label, 'Within expected range for age');
  assert.equal(classify(-2.7, -2.0, 40).label, 'Below expected range for age');
  assert.equal(classify(-2.7, -1.99, 49).label, 'Within expected range for age');
  const old = classify(-2.7, -1.5, 50);
  assert.equal(old.by, 'T');
  assert.equal(old.label, 'Osteoporosis');
});

test('hip under 50: the deciding site is the lower Z, and the banner is Z-based', () => {
  const h = hipDiagnosis(hipRois(-0.5, -2.7), 'f', 35);
  assert.equal(h.site, 'total hip');
  assert.ok(/expected range for age/.test(h.dx), h.dx);
});

// ---------------------------------------------------------------- serial scans
test('serial change compares with the previous scan of the same site', () => {
  // newest first: spine, femur, spine. The newest spine was showing no change at all because
  // the scan filed just before it was a femur.
  const list = [{ region: 'spine', mean: 0.95 }, { region: 'femur', mean: 0.80 }, { region: 'spine', mean: 1.00 }];
  assert.equal(priorScan(list, 0), list[2]);
  assert.equal(priorScan(list, 1), null);
  assert.equal(priorScan(list, 2), null);
});

// ---------------------------------------------------------------- L1-L4 on a synthetic spine
/* A lumbar window built to contain each trap the old finder fell into:
   - bodies 3.6 cm apart with lucent discs, but POSTERIOR ELEMENTS either side that are
     continuous through the disc level (they filled the dips when integrated across);
   - a head-to-foot taper bigger than the disc modulation;
   - a bone floor across the whole field (ribs/iliac wings) that blew out a 45 %-of-peak column;
   - L5 inside the window below L4, so counting four up from the bottom mislabels everything.
   The crest is placed at the L4/L5 disc, as anatomy places it. */
function syntheticSpine() {
  const px = 0.12, nx = 117, nz = 200, z0 = -17.16;
  const mid = 58, period = 30, discs = [10, 40, 70, 100, 130, 160, 190];
  const bmd = new Float32Array(nx * nz);
  for (let r = 0; r < nz; r++) {
    const taper = 1.3 - 0.5 * r / nz;
    const inDisc = discs.some((d) => Math.abs(r - d) <= 2);
    for (let c = 0; c < nx; c++) {
      const dx = Math.abs(c - mid);
      // the lateral floor: iliac wings low in the window, ribs high, nothing at the waist —
      // which is the real shape (and how the crest is found). Present on ~55 % of rows — the
      // off-landmark case where the floor rose past a flat 45 %-of-peak cut and the "spine
      // column" grew to the whole field.
      const lateralBone = r < 60 || r > 150;
      let v = lateralBone ? 0.35 : 0.05;
      if (dx < 15) v = inDisc ? 0.30 : 1.25;                // vertebral body, lucent disc
      else if (dx < 27) v = 0.85;                           // posterior elements: NO disc dip
      bmd[r * nx + c] = v * taper;
    }
  }
  const crestRow = 40;
  const sc = { nx, nz, px, z0, x0: -7, region: 'spine', dirSup: 1, crestCm: z0 + (crestRow + 0.5) * px };
  return { sc, bmd, discs, period };
}

test('L1-L4: cuts land on the disc spaces and L4 sits above the crest', () => {
  const { sc, bmd } = syntheticSpine();
  const lv = findLevels(sc, bmd);
  const byLabel = Object.fromEntries(lv.rois.map((r) => [r.label, r]));
  const expect = { L4: [40, 70], L3: [70, 100], L2: [100, 130], L1: [130, 160] };
  for (const [lab, [a, b]] of Object.entries(expect)) {
    assert.ok(byLabel[lab], `${lab} found`);
    assert.ok(Math.abs(byLabel[lab].a - a) <= 2 && Math.abs(byLabel[lab].b - b) <= 2,
      `${lab} ${byLabel[lab].a}->${byLabel[lab].b}, expected ${a}->${b}`);
  }
});

test('L1-L4: the spine column does not blow out to the whole field', () => {
  const { sc, bmd } = syntheticSpine();
  const [a, b] = findLevels(sc, bmd).col;
  const widthCm = (b - a + 1) * sc.px;
  assert.ok(widthCm < 8, `column ${widthCm.toFixed(2)} cm wide — the field is 14`);
});

test('L1-L4: the period is found once, from all the discs together', () => {
  const { sc, bmd } = syntheticSpine();
  assert.ok(Math.abs(findLevels(sc, bmd).period * sc.px - 3.6) < 0.15);
});

// ---------------------------------------------------------------- the proximal femur
/* A left-hip window: shaft up the middle, a broad proximal mass holding head, neck and
   trochanters, and a FOREARM island lying lateral to the shaft — which a band centroid pulled
   the shaft axis toward. Geometry follows the scan conventions: +row superior, +col = +x, and
   for a left hip the midline is toward +col. */
function syntheticHip() {
  const nx = 100, nz = 100, px = 0.12, x0 = -16.9, z0 = -34.0;
  const bmd = new Float32Array(nx * nz);
  const set = (c, r, v) => { if (c >= 0 && r >= 0 && c < nx && r < nz) bmd[r * nx + c] = Math.max(bmd[r * nx + c], v); };
  for (let r = 0; r < 62; r++) for (let c = 62; c <= 78; c++) set(c, r, 1.6);          // shaft
  for (let r = 55; r < 92; r++) for (let c = 28; c <= 92; c++) set(c, r, 1.1);          // proximal mass
  // forearm: a SEPARATE island lateral of the shaft but inside the +-4 cm band the old
  // centroid averaged over, so it is exactly the bone that used to drag the axis
  for (let r = 0; r < 50; r++) for (let c = 44; c <= 52; c++) set(c, r, 1.4);
  const sc = { nx, nz, px, x0, z0, region: 'hipL', dirSup: 1,
    trochX: -8.4, trochZ: -25.1, headX: -7.9, headR: 2.3 };
  return { sc, bmd };
}
const centroid = (mask, nx) => { let sx = 0, sy = 0, n = 0;
  for (let k = 0; k < mask.length; k++) if (mask[k]) { sx += k % nx; sy += (k / nx) | 0; n++; }
  return n ? { col: sx / n, row: sy / n, n } : null; };

test('femur: all five regions are found', () => {
  const { sc, bmd } = syntheticHip();
  const f = findFemur(sc, bmd);
  assert.ok(f, 'findFemur returned a result');
  assert.deepEqual(f.rois.map((r) => r.label).sort(), ['Inter', 'Neck', 'Total', 'Troch', 'Wards']);
});

test('femur: the forearm does not drag the shaft axis', () => {
  // the synthetic shaft is exactly vertical at col 70, so the fit must be too: a centroid
  // over a band that holds the forearm tilts it and pulls it toward col ~63
  const { sc, bmd } = syntheticHip();
  const { u, p } = findFemur(sc, bmd).axes;
  assert.ok(Math.abs(u[0]) < 0.05, `shaft axis ${u.map((v) => v.toFixed(3))} should be vertical`);
  assert.ok(Math.abs(p[0] - 70) < 1.5, `shaft fitted through col ${p[0].toFixed(1)}, the shaft is at 70`);
});

test('femur: trochanter lateral of the neck, intertrochanteric below both', () => {
  // the two impossibilities a technologist caught: a trochanter on the mid-shaft, and a
  // trochanter sandwiched between the neck and the intertrochanteric region
  const { sc, bmd } = syntheticHip();
  const R = Object.fromEntries(findFemur(sc, bmd).rois.map((r) => [r.label, centroid(r.mask, sc.nx)]));
  // left hip: lateral is AWAY from the midline, i.e. toward lower col
  assert.ok(R.Troch.col < R.Neck.col, `troch col ${R.Troch.col.toFixed(1)} should be lateral of neck ${R.Neck.col.toFixed(1)}`);
  assert.ok(R.Inter.row < R.Troch.row, `inter row ${R.Inter.row.toFixed(1)} should be inferior to troch ${R.Troch.row.toFixed(1)}`);
  assert.ok(R.Inter.row < R.Neck.row, 'inter inferior to the neck');
});

test('femur: Total is the union of neck, trochanter and intertrochanteric — nothing counted twice', () => {
  const { sc, bmd } = syntheticHip();
  const R = Object.fromEntries(findFemur(sc, bmd).rois.map((r) => [r.label, r.mask]));
  for (let k = 0; k < R.Total.length; k++) {
    const parts = R.Neck[k] + R.Troch[k] + R.Inter[k];
    assert.ok(parts <= 1, `pixel ${k} in ${parts} regions`);
    assert.equal(R.Total[k], parts, `pixel ${k}: total ${R.Total[k]} vs parts ${parts}`);
  }
});

test('femur: the head itself is never scored', () => {
  const { sc, bmd } = syntheticHip();
  const f = findFemur(sc, bmd), { headC, headR } = f.axes;
  const total = f.rois.find((r) => r.label === 'Total').mask;
  for (let k = 0; k < total.length; k++) {
    if (!total[k]) continue;
    const c = k % sc.nx, r = (k / sc.nx) | 0;
    assert.ok(Math.hypot(c - headC[0], r - headC[1]) >= headR * 0.44, `pixel (${c},${r}) inside the head`);
  }
});

test('femur: regions measure as area x mean density, and Total area is the sum', () => {
  const { sc, bmd } = syntheticHip();
  const m = measure(sc, bmd, findFemur(sc, bmd).rois);
  const A = Object.fromEntries(m.map((r) => [r.label, r.area]));
  assert.ok(Math.abs(A.Total - (A.Neck + A.Troch + A.Inter)) < 1e-9);
  for (const r of m) assert.ok(Math.abs(r.bmcRaw / r.area - r.bmdRaw) < 1e-9, `${r.label} BMD = BMC / area`);
});
