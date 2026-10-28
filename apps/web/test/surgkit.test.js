import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beamAxes, project, frameWeights, nearestFrame, tissueAt, tissuesAlong, sectionAxes, skinEntry, v3 } from '../src/anim/films/surg/geom.js';
import { carmBeam } from '../src/core/carmPose.js';

const D = Math.PI / 180;
const near = (a, b, tol = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < tol);
// the C's own frame turned as the suite turns it: Rx(tilt) Rz(-orbital)
const Rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const Rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
const mul = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const turn = (o, t, v) => mul(Rx(t * D), mul(Rz(-o * D), v));
const man = JSON.parse(readFileSync(new URL('../public/anim/surg.json', import.meta.url), 'utf8'));

test('the surgical images: the beam is the C-arm\'s, the image\'s axes the C\'s own -x and z', () => {
  for (const o of [-20, 0, 30, 45, 90]) for (const t of [-15, 0, 10, 30]) {
    const { d, U, V } = beamAxes(o, t);
    assert.ok(near(d, carmBeam({ orbital: o, tilt: t })), `beam ${o}/${t}`);
    assert.ok(near(U, turn(o, t, [-1, 0, 0])), `right ${o}/${t}`);
    assert.ok(near(V, turn(o, t, [0, 0, 1])), `up ${o}/${t}`);
    assert.ok(Math.abs(v3.dot(d, U)) < 1e-12 && Math.abs(v3.dot(d, V)) < 1e-12 && Math.abs(v3.dot(U, V)) < 1e-12);
  }
});

test('the surgical images: head up; the prone child\'s right on the right, the supine adult\'s on the left', () => {
  const R = { centre: [0, 0, 0], n: 128, span: 16 };
  assert.deepEqual(project(R, 0, 0, [0, 0, 0]), [64, 64]);
  assert.ok(project(R, 0, 0, [0, 0, 4])[1] < 64, 'toward the head: up the image');
  // the child prone: its right is -x; the adult supine: its right is +x
  assert.ok(project(R, 0, 0, [-3, 0, 0])[0] > 64, 'the child\'s right on the right (seen from behind)');
  assert.ok(project(R, 0, 0, [3, 0, 0])[0] < 64, 'the adult\'s right on the left (as a radiograph is viewed)');
  // a point along the beam lands where the beam's other points do: a needle down the beam is a dot
  const { d } = beamAxes(30, 10);
  assert.ok(near(project(R, 30, 10, v3.mul(d, 7)), project(R, 30, 10, [0, 0, 0]), 1e-9));
  // a lateral (+90): the receptor on +x, the back (child +y) on the image's right
  assert.ok(project(R, 90, 0, [0, 3, 0])[0] > 64);
});

test('the surgical images: the manifest\'s frames are its grids, each frame a window', () => {
  for (const [name, R] of Object.entries(man.regions)) {
    const want = R.grids.reduce((s, [os, ts]) => s + os.length * ts.length, 0);
    assert.equal(R.frames.length, want, name);
    for (const f of R.frames) assert.ok(f.length === 4 && f[3] > f[2], `${name} ${f}`);
    assert.ok(man.crops, 'tissue crops');
  }
  for (const k of ['lumbar', 'cervical', 'sacrum', 'hip']) assert.ok(man.regions[k], k);
});

test('the surgical images: a pose between the grid\'s angles blends its neighbours; past the grid, the nearest', () => {
  const R = man.regions.lumbar;
  const on = frameWeights(R, 30, 10);
  assert.equal(on.length, 1);
  assert.deepEqual(R.frames[on[0][0]].slice(0, 2), [30, 10]);
  const mid = frameWeights(R, 31.5, 12.5);
  assert.equal(mid.length, 4);
  assert.ok(Math.abs(mid.reduce((s, [, w]) => s + w, 0) - 1) < 1e-9);
  // the lateral sweep has one tilt: between its orbits at tilt 0, two frames
  assert.equal(frameWeights(R, 61.5, 0).length, 2);
  // off every grid: one frame, the nearest
  const off = frameWeights(R, 70, 20);
  assert.equal(off.length, 1);
  assert.equal(off[0][0], nearestFrame(R, 70, 20));
});

test('the cross-section: tissue read along a needle, the panel\'s up back toward the skin', () => {
  // a 1 x 1 x 6 crop: skin, fat, fat, muscle, cortex, marrow, up the y axis (voxel 1 cm)
  const crop = { origin: [0, 0, 0], voxel: 1, dims: [1, 6, 1], data: Uint8Array.from([6, 5, 3, 2, 2, 1].reverse()) };
  assert.equal(tissueAt(crop, [0, 0, 0]), 1);
  assert.equal(tissueAt(crop, [0, 9, 0]), -1);
  const path = tissuesAlong(crop, [0, 5, 0], [0, 0, 0], 0.5).map((s) => s.code);
  assert.deepEqual(path, [6, 5, 3, 2, 1]);
  const { A, B } = sectionAxes([0, -1, 0]);
  assert.ok(near(B, [0, 1, 0]) && Math.abs(v3.dot(A, B)) < 1e-12);
  // the skin over a target: the first point back along the needle above the body's top
  const top = (x, z) => (Math.abs(x) < 10 ? 8 : null);
  const e = skinEntry(top, [0, 1, 0], [0, -1, 0]);
  assert.ok(Math.abs(e[1] - 8) < 0.06);
});
