// Trainer marking: each criterion against a geometry whose answer is known by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locToWorld, fieldCoord, analyseCoverage, crOffset, judge, angleDiff, neededHalf, filmSide,
  fieldToReceptor, BORDER_CM } from '../src/core/trainerEval.js';
import { sampleRegion, cloudCentre } from '../src/trainer/regions.js';
import { SERIES } from '../src/trainer/series.js';

// a vertical beam from 100 cm above the receptor, field 20 x 30 cm at the receptor
const frame = (collX = 20, collZ = 30, sid = 100) => ({ src: [0, sid, 0], fd: [0, -1, 0], wAxis: [1, 0, 0], lAxis: [0, 0, 1],
  sid, tw: collX / 2 / sid, tl: collZ / 2 / sid });
// a slab of points on the receptor (no magnification): x in [-a, a], z in [-b, b]
function slab(a, b, z0 = 0, x0 = 0) {
  const out = [];
  for (let x = -a; x <= a + 1e-9; x += 0.5) for (let z = -b; z <= b + 1e-9; z += 0.5) out.push(x + x0, 0, z + z0);
  return new Float32Array(out);
}
const view = { pose: { roll: 0, tol: 5 }, centre: { name: 'MCP', tol: 1 } };
const base = (F, pts, over = {}) => ({ rot: { x: 0, y: 0, z: 0 }, angCC: 0, angLM: 0,
  cr: crOffset([0, 0, 0], F), cov: analyseCoverage(pts, F), rightAtPlusX: true, marker: null, di: 0, ...over });
const level = (crit, id) => crit.find((c) => c.id === id).level;

test('geometry: field coordinates and the receptor round trip', () => {
  const F = frame();
  const c = fieldCoord([5, 50, 10], F);      // halfway down: tangents are twice the offsets / 100
  assert.ok(Math.abs(c[0] - 0.1) < 1e-12 && Math.abs(c[1] - 0.2) < 1e-12);
  const r = fieldToReceptor(0.1, 0.2, F);
  assert.ok(Math.abs(r[0] - 10) < 1e-9 && Math.abs(r[1] - 20) < 1e-9);
  const R = [0, -1, 0, 1, 0, 0, 0, 0, 1];      // 90° about z
  assert.deepEqual(locToWorld([1, 0, 0], R, [10, 0, 0]), [10, 1, 0]);
});

test('a field an inch beyond the anatomy passes; wider fails; narrower cuts', () => {
  // anatomy 15 x 25 cm: the ideal field is 15+5.08 by 25+5.08
  const pts = slab(7.5, 12.5);
  const ok = judge(view, base(frame(15 + 2 * BORDER_CM, 25 + 2 * BORDER_CM), pts));
  assert.equal(level(ok, 'anatomy'), 'pass');
  assert.equal(level(ok, 'collimation'), 'pass');
  const open = judge(view, base(frame(30, 40), pts));
  assert.equal(level(open, 'collimation'), 'fail');
  assert.match(open.find((c) => c.id === 'collimation').detail, /too wide/);
  const cut = judge(view, base(frame(12, 25 + 2 * BORDER_CM), pts));
  assert.equal(level(cut, 'anatomy'), 'fail');
  assert.match(cut.find((c) => c.id === 'anatomy').detail, /cut off at the (left|right)/);
  // flush to the skin: everything on, but no border left
  const tight = judge(view, base(frame(15.4, 25.4), pts));
  assert.equal(level(tight, 'anatomy'), 'pass');
  assert.equal(level(tight, 'collimation'), 'warn');
});

test('the inch border is asked for only as far as the receptor allows', () => {
  // a broad chest: 34 cm of lung needs 39 cm with its border, the receptor is 35 cm wide
  const pts = slab(17, 12);
  const F = frame(35, 24 + 2 * BORDER_CM);
  const m = base(F, pts, { recHalf: { w: 17.5, l: 21.5 } });
  assert.equal(level(judge(view, m), 'collimation'), 'pass', 'full width used: right, though the border is thin');
  assert.equal(level(judge(view, base(F, pts)), 'collimation'), 'warn', 'without the receptor known, a thin border warns');
  // but a field that cuts the lungs still fails
  assert.equal(level(judge(view, base(frame(30, 30), pts, { recHalf: { w: 17.5, l: 21.5 } })), 'anatomy'), 'fail');
});

test('the symmetric collimator: the further side decides the field', () => {
  // anatomy from z = -5 to +15 about the central ray: needs 15 + 2.54 each way along l
  const pts = slab(5, 10, 5);
  const need = neededHalf(analyseCoverage(pts, frame()));
  assert.ok(Math.abs(need.l - (15 + BORDER_CM)) < 1e-6);
  assert.ok(Math.abs(need.w - (5 + BORDER_CM)) < 1e-6);
});

test('centring: distance from the ray to the landmark, said in film directions', () => {
  const F = frame();
  const c = crOffset([0, 10, 2], F);           // landmark 2 cm along +l (superior), 10 cm up
  assert.ok(Math.abs(c.dist - 2) < 1e-9 && Math.abs(c.dl - 2) < 1e-9);
  const crit = judge(view, { ...base(F, slab(5, 5)), cr: c });
  assert.equal(level(crit, 'centring'), 'fail');
  // the ray is BELOW the landmark (toward the bottom of the film as hung)
  assert.match(crit.find((x) => x.id === 'centring').detail, /2\.0 cm toward the bottom/);
  assert.equal(level(judge(view, { ...base(F, slab(5, 5)), cr: crOffset([0.6, 4, 0.5], F) }), 'centring'), 'pass');
});

test('centring is measured perpendicular to the central ray, so an angled beam is judged right', () => {
  // a ray angled 15°: a landmark ON the ray, 40 cm above the receptor, is perfectly centred even
  // though it sits well away from the ray's receptor point
  const a = 15 * Math.PI / 180, fd = [0, -Math.cos(a), Math.sin(a)];
  const F = { src: [0, 100, -100 * Math.tan(a)], fd, wAxis: [1, 0, 0], lAxis: [0, Math.sin(a), Math.cos(a)], sid: 100, tw: 0.1, tl: 0.1 };
  const on = [F.src[0] + 60 * fd[0], F.src[1] + 60 * fd[1], F.src[2] + 60 * fd[2]];
  assert.ok(crOffset(on, F).dist < 1e-9);
  assert.ok(Math.abs(crOffset([on[0] + 1.5, on[1], on[2]], F).dist - 1.5) < 1e-9);
});

test('position: rotation within tolerance, measured the short way round', () => {
  assert.equal(angleDiff(179, -179), -2);
  const F = frame(), pts = slab(5, 5);
  const v = { ...view, pose: { roll: 180, tol: 4 } };
  assert.equal(level(judge(v, base(F, pts, { rot: { x: 0, y: 0, z: -178 } })), 'position'), 'pass');
  assert.equal(level(judge(v, base(F, pts, { rot: { x: 0, y: 0, z: 170 } })), 'position'), 'fail');
  assert.equal(level(judge(view, base(F, pts, { rot: { x: 8, y: 0, z: 0 } })), 'position'), 'fail');
});

test('the film-side words follow the display mirror', () => {
  assert.equal(filmSide('l', 1, true), 'top');
  assert.equal(filmSide('w', 1, true), 'left');      // patient's right at +x hangs on the viewer's left
  assert.equal(filmSide('w', 1, false), 'right');
});

test('required anatomy is sampled from the volume inside its window', () => {
  // a 10 x 10 x 20 voxel block of soft tissue (id 10), 1 cm voxels, with bone (18) in the top half
  const nx = 10, ny = 10, nz = 20, data = new Uint8Array(nx * ny * nz).fill(10);
  for (let k = 10; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[(k * ny + j) * nx + i] = 18;
  const vm = { dims: [nx, ny, nz], spacingMM: [10, 10, 10], data };
  const lm = (name) => (name === 'mid' ? [0, 0, 0.5] : null);
  const all = sampleRegion(vm, [false, false, false], lm, [{ mat: 'tissue' }], 1);
  assert.equal(all.length / 3, nx * ny * nz);
  const bone = sampleRegion(vm, [false, false, false], lm, [{ mat: 'bone' }], 1);
  assert.equal(bone.length / 3, nx * ny * 10);
  // a window hung off a landmark: z from the landmark up
  const top = sampleRegion(vm, [false, false, false], lm, [{ mat: 'tissue', z: [{ lm: 'mid' }, null] }], 1);
  assert.equal(top.length / 3, nx * ny * 10);
  const c = cloudCentre(top);
  assert.ok(Math.abs(c[2] - 5) < 1e-6);
});

test('every series view is complete and points at a real protocol shape', () => {
  for (const s of SERIES) for (const v of s.views) {
    assert.ok(v.proto && v.proto.length === 2, `${s.id} ${v.label}: protocol`);
    assert.ok(v.pose && typeof v.pose.roll === 'number', `${s.id} ${v.label}: pose`);
    assert.ok(v.centre && (v.centre.lm || v.centre.fromRequired) && v.centre.tol > 0, `${s.id} ${v.label}: centre`);
    assert.ok(v.require && v.require.parts.length && v.require.text, `${s.id} ${v.label}: required anatomy`);
  }
});

test('a hand is judged on the 3rd metacarpal lying in line with the radius', () => {
  const F = frame(), pts = slab(5, 5);
  const v = { ...view, align: { tol: 6 } };
  const at = (a) => judge(v, base(F, pts, { align: a })).find((c) => c.id === 'position');
  assert.equal(at(2).level, 'pass');
  const off = at(26);
  assert.equal(off.level, 'fail');
  assert.match(off.detail, /26° ulnar to the distal radius: radially deviate/);
  // the scaphoid view wants it deviated instead
  const sc = { ...view, align: { range: [15, 35] } };
  assert.equal(judge(sc, base(F, pts, { align: 0 })).find((c) => c.id === 'position').level, 'fail');
  assert.equal(judge(sc, base(F, pts, { align: 25 })).find((c) => c.id === 'position').level, 'pass');
});
