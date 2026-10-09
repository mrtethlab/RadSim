// The fluoro side annotation is worked out from the geometry, so it must follow the beam and
// every display flip and turn — or it marks the wrong side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rightOnScreen } from '../src/core/orientation.js';

const near = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
// tube under the table, beam up: columns along +x, rows along +z... with row 0 at the top
// (superior), so +v is world -z (fluoro.js beamFrame)
const U = [1, 0, 0], V = [0, 0, -1];
const RIGHT = [1, 0, 0];                       // supine, the patient's right at world +x

test('the R sits on the side the patient\'s right projects to', () => {
  assert.ok(near(rightOnScreen(RIGHT, U, V, false, false, 0), [1, 0]));
  // rolled over (prone), the right is at -x
  assert.ok(near(rightOnScreen([-1, 0, 0], U, V, false, false, 0), [-1, 0]));
});

test('a horizontal flip moves the R; a vertical flip does not', () => {
  assert.ok(near(rightOnScreen(RIGHT, U, V, true, false, 0), [-1, 0]));
  assert.ok(near(rightOnScreen(RIGHT, U, V, false, true, 0), [1, 0]));
});

test('the R turns with the display, after the flips', () => {
  // a quarter turn clockwise on screen (y down): right -> down
  const r = rightOnScreen(RIGHT, U, V, false, false, 90);
  assert.ok(Math.abs(r[0]) < 1e-9 && Math.abs(r[1] - 1) < 1e-9);
  // flip then turn: right -> left -> up
  const f = rightOnScreen(RIGHT, U, V, true, false, 90);
  assert.ok(Math.abs(f[0]) < 1e-9 && Math.abs(f[1] + 1) < 1e-9);
});

test('a lateral has no right side on the screen; an oblique still does', () => {
  // beam along x: the detector's u lies along the beam's perpendicular, here world y
  assert.equal(rightOnScreen(RIGHT, [0, 1, 0], V, false, false, 0), null);
  const th = 30 * Math.PI / 180;
  const ob = rightOnScreen(RIGHT, [Math.cos(th), -Math.sin(th), 0], V, false, false, 0);
  assert.ok(ob && ob[0] > 0.99);
});
