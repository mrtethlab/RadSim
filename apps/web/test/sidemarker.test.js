// Side markers: the verdict has to name the classic errors, and must not cry wolf on a correct one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markerVerdict, expectedLateral } from '../src/core/sideMarker.js';

// the patient's right in the room: AP (right at +x), PA (rolled 180, right at -x),
// and the two laterals (right side up = left lateral, right side down = right lateral)
const AP = [1, 0, 0], PA = [-1, 0, 0], LEFT_LAT = [0, 1, 0], RIGHT_LAT = [0, -1, 0];
const base = { inFrac: 1, overTissue: false, bilateral: true };

test('AP and PA: the letter must lie on the side it names', () => {
  assert.equal(markerVerdict({ ...base, side: 'R', rightVec: AP, dx: 12 }).level, 'ok');
  assert.equal(markerVerdict({ ...base, side: 'R', rightVec: AP, dx: -12 }).level, 'bad');
  // rolled over, the patient's right is at -x: the same spot is now their left
  assert.equal(markerVerdict({ ...base, side: 'R', rightVec: PA, dx: 12 }).level, 'bad');
  assert.equal(markerVerdict({ ...base, side: 'R', rightVec: PA, dx: -12 }).level, 'ok');
  assert.equal(markerVerdict({ ...base, side: 'L', rightVec: PA, dx: 12 }).level, 'ok');
  assert.match(markerVerdict({ ...base, side: 'L', rightVec: AP, dx: 12 }).text, /patient's RIGHT/);
});

test('a lateral is named for the side against the receptor, wherever the letter lies', () => {
  assert.equal(expectedLateral(LEFT_LAT), 'L');
  assert.equal(expectedLateral(RIGHT_LAT), 'R');
  for (const dx of [-10, 0, 10]) {
    assert.equal(markerVerdict({ ...base, side: 'L', rightVec: LEFT_LAT, dx }).level, 'ok');
    assert.equal(markerVerdict({ ...base, side: 'R', rightVec: LEFT_LAT, dx }).level, 'bad');
  }
});

test('collimated off is an error; cut by the collimation and over the anatomy are warnings', () => {
  assert.equal(markerVerdict({ ...base, side: 'R', rightVec: AP, dx: 12, inFrac: 0 }).level, 'bad');
  assert.match(markerVerdict({ ...base, side: 'R', rightVec: AP, dx: 12, inFrac: 0 }).text, /not on the image/);
  assert.equal(markerVerdict({ ...base, side: 'R', rightVec: AP, dx: 12, inFrac: 0.5 }).level, 'warn');
  assert.equal(markerVerdict({ ...base, side: 'R', rightVec: AP, dx: 12, overTissue: true }).level, 'warn');
  // and a wrong side still outranks a warning
  assert.equal(markerVerdict({ ...base, side: 'R', rightVec: AP, dx: -12, overTissue: true }).level, 'bad');
});

test('no marker, and a marker on the midline, are flagged', () => {
  assert.equal(markerVerdict({ ...base, side: null, rightVec: AP, dx: 0 }).level, 'warn');
  assert.equal(markerVerdict({ ...base, side: 'R', rightVec: AP, dx: 1 }).level, 'warn');
});

test('a single limb is judged on placement only', () => {
  const v = markerVerdict({ ...base, bilateral: false, side: 'L', rightVec: AP, dx: 12 });
  assert.equal(v.level, 'ok');
  assert.match(v.text, /not checked/);
  assert.equal(markerVerdict({ ...base, bilateral: false, side: 'L', rightVec: AP, dx: 12, inFrac: 0 }).level, 'bad');
});
