/* ============================================================================
   DOPPLER AUDIO — docs/ultrasound.md §4.6
   The shifts a Doppler machine measures are AUDIBLE: 2 f0 v cos(theta) / c is a few hundred
   hertz to a few kilohertz for blood, which is why every machine has a speaker and why a
   sonographer listens before looking — the sharp systolic whip of an artery, the steady
   wind of a vein, the hiss of nothing in the gate.

   Nothing new is invented for the sound: it is the SAME spectrum the trace draws, played.
   Each spectral column (the periodogram, after the wall filter, with its grain) drives a bank
   of oscillators, one per bin, at that bin's shift — toward the probe in one channel, away in
   the other, as machines separate forward and reverse flow. So the sound aliases exactly as
   the trace does: a shift past the top of the window comes back in at the bottom, in the
   OTHER ear. Turning the baseline or the wall filter changes what is heard for the same
   reason it changes what is seen.

   Pure: a spectrum in, audio samples out. The player (ultrasound.js) only queues them.
   ============================================================================ */
import { shiftOfBin } from './doppler.js';

/* Oscillator state for nb bins: continuous phase from one column to the next (no clicks), and
   the amplitude each bin ended the last column on (ramped to the new one across the column,
   so the sound has no zipper at the column rate). */
export function audioState(nb, seed = 12345) {
  // random starting phases: 128 oscillators all starting at zero phase would sum to a click
  const st = { c: new Float64Array(nb), s: new Float64Array(nb), a: new Float64Array(nb) };
  let x = seed >>> 0;
  for (let i = 0; i < nb; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const p = 2 * Math.PI * x / 4294967296;
    st.c[i] = Math.cos(p); st.s[i] = Math.sin(p);
  }
  return st;
}
export const AUDIO_FMIN = 20;    // Hz: below this a bin is DC to a speaker — and the wall filter's anyway

/* One column of audio. P: power per bin (the spectral column), in the units of `ref`;
   amplitude per bin is sqrt(P / ref) x gain. Writes n samples at rate fs into outT (toward the
   probe) and outA (away). Returns the peak absolute sample written, for a limiter. */
export function synthColumn(P, prf, b, fs, n, gain, ref, st, outT, outA, off = 0) {
  const nb = P.length;
  for (let k = 0; k < n; k++) { outT[off + k] = 0; outA[off + k] = 0; }
  let peak = 0;
  for (let i = 0; i < nb; i++) {
    const f = shiftOfBin(i, prf, b, nb);
    const a1 = Math.sqrt(Math.max(0, P[i]) / ref) * gain, a0 = st.a[i];
    st.a[i] = a1;
    if ((a0 === 0 && a1 === 0) || Math.abs(f) < AUDIO_FMIN) continue;
    const w = 2 * Math.PI * Math.abs(f) / fs, cw = Math.cos(w), sw = Math.sin(w);
    let c = st.c[i], s = st.s[i];
    const out = f >= 0 ? outT : outA, da = (a1 - a0) / n;
    let a = a0;
    for (let k = 0; k < n; k++) {
      out[off + k] += a * s;
      const c2 = c * cw - s * sw; s = s * cw + c * sw; c = c2;
      a += da;
    }
    // renormalise the rotating phasor so rounding cannot grow or shrink it over minutes
    const m = 1 / Math.hypot(c, s);
    st.c[i] = c * m; st.s[i] = s * m;
  }
  for (let k = 0; k < n; k++) peak = Math.max(peak, Math.abs(outT[off + k]), Math.abs(outA[off + k]));
  return peak;
}
