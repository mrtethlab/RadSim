import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carmBeam, beamInHolder } from '../src/core/carmPose.js';

const D = Math.PI / 180;
const near = (a, b, tol = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < tol);
// rotation matrices, applied right to left as the machine's joints are (fluoro.js poses the
// model with the same chain of quaternions: carm.js, fluoroSyncScene)
const Rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const Ry = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const Rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
const mul = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);

test('the C-arm beam is its joint chain: wig-wag, flip-flop, tilt outside orbital', () => {
  for (const orbital of [-95, -60, 0, 25, 90]) for (const tilt of [-45, 0, 30]) for (const over of [false, true]) for (const wig of [-10, 0, 7]) {
    const chain = mul(Ry(wig * D), mul(Rx(over ? Math.PI : 0), mul(Rx(tilt * D), mul(Rz(-orbital * D), [0, 1, 0]))));
    assert.ok(near(carmBeam({ orbital, tilt, over, wig }), chain), `${orbital}/${tilt}/${over}/${wig}`);
  }
});

test('the C-arm beam: up at rest, horizontal for a lateral, tilt only toward the head', () => {
  assert.ok(near(carmBeam({}), [0, 1, 0]));
  assert.ok(near(carmBeam({ orbital: 90 }), [1, 0, 0]), 'orbital 90: across the table');
  const t = carmBeam({ tilt: 30 });
  assert.ok(near(t, [0, Math.cos(30 * D), Math.sin(30 * D)]), 'tilt: in the long axis only');
  assert.ok(near(carmBeam({ over: true }), [0, -1, 0]), 'flip-flop: the tube over the table');
  // a lateral stays a lateral whatever the tilt: the holder turns about the arm, and at 90 the
  // beam lies along it
  assert.ok(near(beamInHolder(90, 40), [1, 0, 0]));
});
