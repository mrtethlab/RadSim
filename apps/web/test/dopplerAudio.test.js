// Doppler audio (core/dopplerAudio.js): the spectrum, played — at the right pitch, in the right
// ear, aliasing into the other one, and without clicks between columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioState, synthColumn } from '../src/core/dopplerAudio.js';
import { spectrumColumn, binOfShift, shiftOfBin } from '../src/core/doppler.js';

const NB = 128, FS = 48000, PRF = 4000;
const crossings = (x) => { let c = 0; for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) c++; return c; };
const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

function tone(fShift, b = 0) {
  const P = new Float64Array(NB);
  P[binOfShift(fShift, PRF, b, NB)] = 1;
  return P;
}
function play(P, b = 0, n = 4800, cols = 2) {
  const st = audioState(NB), T = new Float32Array(n * cols), A = new Float32Array(n * cols);
  for (let c = 0; c < cols; c++) synthColumn(P, PRF, b, FS, n, 1, 1, st, T, A, c * n);
  // the first column ramps up from silence: judge the second
  return { T: T.slice(n), A: A.slice(n), Tall: T, Aall: A };
}

test('a shift toward the probe sounds at its own pitch, in the toward channel only', () => {
  const P = tone(1000), f = shiftOfBin(binOfShift(1000, PRF, 0, NB), PRF, 0, NB);
  const { T, A } = play(P);
  const fHeard = crossings(T) / 2 / (T.length / FS);
  assert.ok(Math.abs(fHeard - f) < 15, `heard ${fHeard} Hz for a ${f} Hz bin`);
  assert.equal(rms(A), 0, 'the away channel is silent');
  assert.ok(Math.abs(rms(T) - Math.SQRT1_2) < 0.02, `unit amplitude (rms ${rms(T)})`);
});

test('flow away is heard in the other ear, and a louder bin is louder by its power', () => {
  const P = tone(-600);
  const { T, A } = play(P);
  assert.equal(rms(T), 0, 'toward channel silent');
  assert.ok(rms(A) > 0.6, 'away channel sounding');
  const P4 = tone(-600); P4[binOfShift(-600, PRF, 0, NB)] = 4;
  assert.ok(Math.abs(rms(play(P4).A) / rms(A) - 2) < 0.01, 'amplitude is the square root of power');
});

test('an aliased shift is heard wrapped — in the wrong ear, at the wrong pitch — as it is drawn', () => {
  // 2600 Hz toward at PRF 4 kHz: past the +2 kHz edge, so it lands at -1400 Hz
  const P = new Float64Array(NB);
  spectrumColumn(P, [1, 2600, 0], 1, PRF, 0, 0, 0, () => 1 - Math.exp(-1));
  const { T, A } = play(P);
  assert.ok(rms(A) > 10 * rms(T), 'heard as flow away');
  const fHeard = crossings(A) / 2 / (A.length / FS);
  assert.ok(Math.abs(fHeard - 1400) < 60, `heard at ${fHeard} Hz`);
  // the baseline moved down buys the room: the same shift is heard toward, at its own pitch
  const Pb = new Float64Array(NB);
  spectrumColumn(Pb, [1, 2600, 0], 1, PRF, 0.5, 0, 0, () => 1 - Math.exp(-1));
  const hb = play(Pb, 0.5);
  assert.ok(rms(hb.T) > 10 * rms(hb.A), 'with the baseline down it is toward again');
});

test('no clicks: phase runs on and amplitude ramps between columns', () => {
  const st = audioState(NB), n = 480, T = new Float32Array(3 * n), A = new Float32Array(3 * n);
  const P1 = tone(800), P2 = tone(800); P2[binOfShift(800, PRF, 0, NB)] = 2;
  synthColumn(P1, PRF, 0, FS, n, 1, 1, st, T, A, 0);
  synthColumn(P1, PRF, 0, FS, n, 1, 1, st, T, A, n);
  synthColumn(P2, PRF, 0, FS, n, 1, 1, st, T, A, 2 * n);
  let maxJump = 0;
  for (let i = n + 1; i < 3 * n; i++) maxJump = Math.max(maxJump, Math.abs(T[i] - T[i - 1]));
  const w = 2 * Math.PI * 812.5 / FS;           // the steepest a sinusoid of amplitude ~1.4 can step
  assert.ok(maxJump < 1.45 * w * 1.05, `largest sample step ${maxJump}`);
});
