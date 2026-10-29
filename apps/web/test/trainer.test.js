// Trainer marking: each criterion against a geometry whose answer is known by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locToWorld, fieldCoord, analyseCoverage, crOffset, judge, angleDiff, neededHalf, filmSide,
  fieldToReceptor, idealHalf, BORDER_CM } from '../src/core/trainerEval.js';
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

test('a field half an inch beyond the anatomy passes; wider fails; narrower cuts', () => {
  // anatomy 15 x 25 cm: the ideal field is 15+5.08 by 25+5.08
  const pts = slab(7.5, 12.5);
  const ok = judge(view, base(frame(15 + 2 * BORDER_CM, 25 + 2 * BORDER_CM), pts));
  assert.equal(level(ok, 'anatomy'), 'pass');
  assert.equal(level(ok, 'collimation'), 'pass');
  const open = judge(view, base(frame(40, 50), pts));
  assert.equal(level(open, 'collimation'), 'fail');
  assert.match(open.find((c) => c.id === 'collimation').detail, /too wide.*a repeat/);
  const cut = judge(view, base(frame(12, 25 + 2 * BORDER_CM), pts));
  assert.equal(level(cut, 'anatomy'), 'fail');
  assert.equal(level(cut, 'collimation'), 'fail');
  assert.match(cut.find((c) => c.id === 'anatomy').detail, /cut off at the (left|right)/);
  // flush to the skin: everything on, a thin border noted but not marked down
  const tight = judge(view, base(frame(15.4, 25.4), pts));
  assert.equal(level(tight, 'anatomy'), 'pass');
  assert.equal(level(tight, 'collimation'), 'pass');
  assert.match(tight.find((c) => c.id === 'collimation').detail, /Under ¼"/);
});

test('collimation grades: within the half inch passes, open by under half the ideal is marked, beyond is a repeat', () => {
  // anatomy 17.46 cm long: the ideal field is 20 cm. 22 passes, 29.9 is marked, 31 is a repeat
  // (30 itself sits on the line, and the anatomy's float32 points put it a hair over)
  const pts = slab(5, (20 - 2 * BORDER_CM) / 2);
  const ideal = 10 + 2 * BORDER_CM;
  const at = (len) => level(judge(view, base(frame(ideal, len), pts)), 'collimation');
  assert.equal(at(20), 'pass');
  assert.equal(at(22), 'pass');
  assert.equal(at(23), 'warn');
  assert.equal(at(29.9), 'warn');
  assert.equal(at(31), 'fail');
  // a repeat on either axis is a repeat
  assert.equal(level(judge(view, base(frame(ideal * 1.6, 22), pts)), 'collimation'), 'fail');
});

test('the half-inch border is asked for only as far as the receptor allows', () => {
  // a broad chest: 34 cm of lung needs 39 cm with its border, the receptor is 35 cm wide
  const pts = slab(17, 12);
  const F = frame(35, 24 + 2 * BORDER_CM);
  const m = base(F, pts, { recHalf: { w: 17.5, l: 21.5 } });
  assert.equal(level(judge(view, m), 'collimation'), 'pass', 'full width used: right, though the border is thin');
  assert.equal(level(judge(view, base(F, pts)), 'collimation'), 'pass', 'a thin border is noted, not marked down');
  // but a field that cuts the lungs still fails
  assert.equal(level(judge(view, base(frame(30, 30), pts, { recHalf: { w: 17.5, l: 21.5 } })), 'anatomy'), 'fail');
});

test('a textbook field size is the least the ideal asks for: collimating to it is never open', () => {
  // a slender column: 10 cm of anatomy wants 12.54 cm; the lateral lumbar's textbook field is 20 wide
  const pts = slab(5, 12);
  const v = { ...view, field: { w: 20 } };
  const F = frame(20, 24 + 2 * BORDER_CM);
  assert.ok(Math.abs(2 * idealHalf(v, analyseCoverage(pts, F)).w - 20) < 1e-9);
  assert.equal(level(judge(v, base(F, pts)), 'collimation'), 'pass', 'the textbook 20 cm');
  assert.equal(level(judge(view, base(F, pts)), 'collimation'), 'fail', 'without it, 20 is 7.5 cm open: a repeat');
  assert.equal(level(judge(v, base(frame(10 + 2 * BORDER_CM, 24 + 2 * BORDER_CM), pts)), 'collimation'), 'pass', 'the half inch alone');
  // and the receptor still caps it
  assert.equal(idealHalf({ field: { w: 50 } }, analyseCoverage(pts, F), { w: 17.5, l: 21.5 }).w, 17.5);
});

test('the symmetric collimator: the further side decides the field', () => {
  // anatomy from z = -5 to +15 about the central ray: needs 15 + 1.27 each way along l
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

test('position: 2 degrees in any axis, measured the short way round', () => {
  assert.equal(angleDiff(179, -179), -2);
  const F = frame(), pts = slab(5, 5);
  const pos = (v, rot) => level(judge(v, base(F, pts, { rot })), 'position');
  const v = { ...view, pose: { roll: 180 } };              // the default leniency
  assert.equal(pos(v, { x: 0, y: 0, z: -178 }), 'pass');
  assert.equal(pos(v, { x: 0, y: 0, z: 177 }), 'fail');
  for (const ax of ['x', 'y']) {
    assert.equal(pos(v, { x: 0, y: 0, z: 180, [ax]: 2 }), 'pass', `${ax} 2 degrees`);
    assert.equal(pos(v, { x: 0, y: 0, z: 180, [ax]: -3 }), 'fail', `${ax} 3 degrees`);
  }
  // a textbook range (the mortise's 15-20) with the leniency either side
  const m = { ...view, pose: { roll: 15, range: [15, 20], tol: 2 } };
  for (const z of [13, 15, 18, 20, 22]) assert.equal(pos(m, { x: 0, y: 0, z }), 'pass', `mortise ${z}`);
  for (const z of [12, 23]) assert.equal(pos(m, { x: 0, y: 0, z }), 'fail', `mortise ${z}`);
  assert.match(judge(m, base(F, pts, { rot: { x: 0, y: 0, z: 25 } })).find((c) => c.id === 'position').detail, /want 15-20° \(\+5°\)/);
  // a hand or wrist: the turn that counts is the forearm against the film, not the slider's zero
  const arm = (rotY, limbTurn) => judge(view, base(F, pts, { rot: { x: 0, y: rotY, z: 0 }, limbTurn }));
  assert.equal(level(arm(-25, 0.4), 'position'), 'pass', 'turned 25 degrees to line the forearm up');
  assert.equal(level(arm(0, 24), 'position'), 'fail');
  assert.match(arm(0, 24).find((c) => c.id === 'position').detail, /forearm 24° across the film/);
  // a foot judged on its sole may tilt the leg to lay it flat; the sole is what is judged
  const sv = { ...view, pose: { roll: 0 }, sole: { tol: 5 } };
  assert.equal(level(judge(sv, base(F, pts, { rot: { x: -19, y: 0, z: 0 }, sole: 1.5 })), 'position'), 'pass');
  assert.equal(level(judge(sv, base(F, pts, { rot: { x: 0, y: 0, z: 0 }, sole: 17 })), 'position'), 'fail');
  assert.match(judge(sv, base(F, pts, { rot: { x: 0, y: 0, z: 0 }, sole: 17 })).find((c) => c.id === 'position').detail, /sole is 17° off the receptor \(toes up\)/);
  // every series view takes the 2 degrees
  for (const s of SERIES) for (const vw of s.views) assert.equal(vw.pose.tol, 2, `${s.id} ${vw.label}`);
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
