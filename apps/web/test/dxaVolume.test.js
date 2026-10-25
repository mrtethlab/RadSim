// DXA on the real volumes: the forearm's one-third radius on the upper extremity, and the hip's
// landmarks on the chest/abdomen/pelvis — the full tracer, the 2x2 solve and the analysis, with
// the patient moved the way repositioning moves them. Numbers in the comments were measured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VoxelPhantom, eulerMatrix } from '../src/core/voxelPhantom.js';
import { segmentFemur, poseFemurs } from '../src/core/limbPose.js';
import { measureForearm, forearmWorld, forearmAlignment, scanPhantom, decompose, analyse, measure, scores,
  findLandmarks } from '../src/dxa.js';

const load = (name) => {
  const hdr = JSON.parse(readFileSync(new URL(`../public/models/${name}/${name}.model.json`, import.meta.url), 'utf8'));
  const data = new Uint8Array(readFileSync(new URL(`../public/models/${name}/${name}.mat.bin`, import.meta.url)));
  return { dims: hdr.dims, vs: hdr.spacing.map((s) => s / 10), data };
};
const d2r = Math.PI / 180;
const rot = (x, y) => eulerMatrix(x * d2r, y * d2r, 0);

// ---------------------------------------------------------------- the forearm
const ARM = load('upperextremity');
// DXA's flips for the arm: x flipped (as every projection room), and flipped back for the LEFT
// forearm, which is the shipped right arm mirrored
const armPh = (left, r = null, centre = [0, 10, 0], data = ARM.data) =>
  new VoxelPhantom({ ...ARM, data }, centre, [!left, true, false], r);
/* A forearm laid as the console's preset lays it: straight and flat, the laser an inch distal of
   the styloid on the forearm's middle (plus any miss), and scanned. */
function forearmScan({ left = false, ez = 0, ex = 0, dyaw = 0, len = null, loss = 0, centre } = {}) {
  const al = forearmAlignment(armPh(left, null, centre));
  const ph = armPh(left, rot(al.x, al.y + dyaw), centre);
  const fa = forearmWorld(ph);
  const sc = scanPhantom(ph, { region: left ? 'forearmL' : 'forearmR', loss,
    headZ: fa.styl[2] - fa.up * 2.54 + ez, crossX: fa.site[0] + ex, forearmLen: len });
  const { bmd } = decompose(sc);
  const an = analyse(sc, bmd);
  return { fa, sc, bmd, an, roi: measure(sc, bmd, an.rois)[0] };
}

test('the forearm is measured off its bones: the ulna, olecranon to styloid', () => {
  const m = measureForearm(armPh(false));
  // 26.65 cm on this arm: an adult ulna, styloid to olecranon
  assert.ok(m.len > 25 && m.len < 28.5, `forearm length ${m.len.toFixed(2)} cm`);
  // the ulna is the medial bone, on the torso's side of the volume (+x, where the ribs are)
  assert.equal(m.medX, 1);
  // the styloid is at the wrist (the radiocarpal joint is near voxel 117), not out in the carpus
  // or back up the shaft; the olecranon sits above the radial head, which ends near 365
  assert.ok(m.styl[2] > 100 && m.styl[2] < 125, `styloid at z ${m.styl[2]}`);
  assert.ok(m.olec[2] > 365, `olecranon at z ${m.olec[2].toFixed(1)}`);
});

test('the preset lays the forearm straight along the table and flat on it, either arm', () => {
  for (const left of [false, true]) {
    const al = forearmAlignment(armPh(left));
    const fa = forearmWorld(armPh(left, rot(al.x, al.y)));
    assert.ok(Math.abs(fa.yaw) < 1 && Math.abs(fa.pitch) < 1, `${left ? 'L' : 'R'}: yaw ${fa.yaw.toFixed(2)}, pitch ${fa.pitch.toFixed(2)}`);
  }
  // and the mirror is a mirror: the turn swaps sign, the tilt does not, medial changes sides
  const r = forearmAlignment(armPh(false)), l = forearmAlignment(armPh(true));
  assert.equal(l.y, -r.y); assert.equal(l.x, r.x);
  assert.equal(forearmWorld(armPh(true)).med, -forearmWorld(armPh(false)).med);
});

test('the scan finds the ulnar styloid where the bone is, and puts the region on the RADIUS a third up', () => {
  for (const left of [false, true]) {
    const { fa, sc, bmd, an } = forearmScan({ left });
    const px = sc.px, want = (fa.styl[2] - sc.z0) / px - 0.5;
    // found in the image within 3 mm of the volume's own styloid
    assert.ok(Math.abs(an.axes.styloidRow - want) * px <= 0.3, `styloid row ${an.axes.styloidRow} vs ${want.toFixed(1)}`);
    near(an.axes.siteRow - an.axes.styloidRow, fa.len / 3 / px, 1e-9, 'a third of the length up');
    assert.equal(an.axes.overlap, false);
    // the region is the lateral bone: its columns lie away from the medial side
    const mask = an.rois[0].mask, r = Math.round(an.axes.siteRow);
    let c = 0, n = 0; for (let i = 0; i < sc.nx; i++) if (mask[r * sc.nx + i]) { c += i; n++; }
    let b = 0, bn = 0; for (let i = 0; i < sc.nx; i++) if (bmd[r * sc.nx + i] > 0.12) { b += i; bn++; }
    assert.ok(n > 0 && sc.forearm.med * (c / n - b / bn) < 0, `${left ? 'L' : 'R'}: region at col ${(c / n).toFixed(1)}, bone centre ${(b / bn).toFixed(1)}`);
    // a radius at a third is 1.2-1.6 cm across; 2 cm of it is about 3 cm2
    const roi = measure(sc, bmd, an.rois)[0];
    assert.ok(roi.area > 2.4 && roi.area < 3.6, `area ${roi.area.toFixed(2)}`);
  }
});
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test('full mineral reads as the healthy young adult it is, and loss scales it', () => {
  // raw 0.920 right, 0.907 left, against a 0.694 +- 0.060 young-adult population: T +0.55 / +0.38
  for (const left of [false, true]) {
    const { roi } = forearmScan({ left });
    const T = scores(roi.bmd, 'radius33', 'f', 30).T;
    assert.ok(T > 0 && T < 1, `${left ? 'L' : 'R'}: BMD ${roi.bmd.toFixed(3)}, T ${T.toFixed(2)}`);
  }
  const a = forearmScan({}).roi.bmd, b = forearmScan({ loss: 0.2 }).roi.bmd;
  near(b / a, 0.8, 0.02, 'a fifth of the mineral removed');
});

test('a wrong forearm length moves the region by a third of the error', () => {
  const base = forearmScan({}), long = forearmScan({ len: base.fa.len + 3 });
  near((long.an.axes.siteRow - base.an.axes.siteRow) * base.sc.px, 1, 1e-9, 'cm the region moved');
});

test('the styloid has to be in the picture: anywhere inside the 2 cm mark tolerance it is, an inch further it is not', () => {
  for (const ez of [-2, 2]) for (const left of [false, true]) {
    const { an } = forearmScan({ ez, ex: ez / 2, left });
    assert.ok(an.rois.length === 1 && !an.axes.why, `laser ${ez} cm: ${an.axes.why}`);
  }
  const off = forearmScan({ ez: 4.5 });
  assert.equal(off.an.rois.length, 0);
  assert.match(off.an.axes.why, /styloid is not in the field/);
});

test('repositioned within tolerance, the one-third radius reproduces to within 2 %', () => {
  // measured: 0.894-0.922 raw over the corners of the tolerance (laser 2 cm, turn 2 degrees)
  const ref = forearmScan({}).roi.bmdRaw;
  for (const o of [{ ez: 0.5 }, { ez: -0.5 }, { ex: 0.5 }, { ex: -2 }, { dyaw: 2 }, { dyaw: -2 }, { left: true }]) {
    const v = forearmScan(o).roi.bmdRaw;
    assert.ok(Math.abs(v / ref - 1) < 0.02, `${JSON.stringify(o)}: ${v.toFixed(4)} vs ${ref.toFixed(4)}`);
  }
});

// ---------------------------------------------------------------- the hip's landmarks
const CAP = load('chestabdopelvis');
const capLm = JSON.parse(readFileSync(new URL('../src/data/landmarks.json', import.meta.url), 'utf8')).chestabdopelvis;
const femurs = [capLm.femoralHeadL, capLm.femoralHeadR].map((h) => segmentFemur(CAP, h));
const posed = {};
const legs = (deg) => (posed[deg] ||= poseFemurs(CAP, femurs, deg, capLm.femoralHeadL.anteriorY || 1));
// the torso in the DXA room: rolled-180 volume, so no flips at all
const capPh = (deg, centre = [0, 0, 0], r = null) => new VoxelPhantom({ ...CAP, data: legs(deg) }, centre, [false, false, false], r);
/* A left-hip scan with the laser where the console's mark is (2 in below the trochanter on the
   femoral shaft, as landmarkTargets() places it), for a patient lying at `dx` across the table. */
function hipScan(deg, dx = 0, yaw = 0) {
  const ph = capPh(deg, [dx, 0, 0], yaw ? rot(0, yaw) : null);
  const lm = findLandmarks(ph), t = lm.troch.L;
  const sc = scanPhantom(ph, { region: 'hipL', loss: 0,
    headZ: t.zCm - lm.dirSup * 2.54 * 3.5, crossX: dx - (t.x + 2.54) });
  const { bmd } = decompose(sc);
  const R = Object.fromEntries(measure(sc, bmd, analyse(sc, bmd).rois).map((r) => [r.label, r.bmd]));
  return { sc, neck: R.Neck, total: R.Total };
}

test('hip: the landmarks lie where the patient lies, so a centimetre off the line changes nothing', () => {
  // they are distances from the patient's midline, and were used as room x: lying 1 cm off the
  // line (inside "centred") built every region 1 cm off the femur and moved the neck 9-19 %
  const a = hipScan(20, 0), b = hipScan(20, 1);
  near(b.sc.trochX - a.sc.trochX, 1, 1e-9, 'trochanter follows the patient');
  near(b.neck, a.neck, 1e-6, 'neck BMD'); near(b.total, a.total, 1e-6, 'total hip BMD');
});

test('hip: turned 2 degrees on the table, the neck moves less than 2 %', () => {
  // the landmarks are turned with the patient; unturned they moved the neck 8-13 %
  const a = hipScan(20, 0, 0);
  for (const yaw of [2, -2]) {
    const b = hipScan(20, 0, yaw);
    assert.ok(Math.abs(b.neck / a.neck - 1) < 0.02, `yaw ${yaw}: neck ${b.neck.toFixed(4)} vs ${a.neck.toFixed(4)}`);
  }
});

test('hip: a degree more or less in the foot holder does not jump the femoral head', () => {
  // the coarse search stepped two voxels: at 19 and 21 degrees the head centre landed 0.8 cm
  // apart and the neck read 10 % apart. Refined, 0.1 cm and 2 %.
  const a = hipScan(19), b = hipScan(21);
  assert.ok(Math.abs(a.sc.headX - b.sc.headX) < 0.3, `head x ${a.sc.headX.toFixed(2)} vs ${b.sc.headX.toFixed(2)}`);
  assert.ok(Math.abs(a.neck / b.neck - 1) < 0.04, `neck ${a.neck.toFixed(4)} vs ${b.neck.toFixed(4)}`);
});
