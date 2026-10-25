/* ============================================================================
   DOPPLER — docs/ultrasound.md phase G
   The relations every sonographer is examined on, written once and used by both
   displays (the colour box and the spectral trace), so the two can never disagree:

     f_d      = 2 f0 v cos(theta) / c        the shift, c = 1540 m/s
     f_nyq    = PRF / 2                      the fastest shift a pulsed system can sample
     v_nyq    = c PRF / (4 f0 cos theta)     the same limit, in velocity
     PRF_max  = c / (2 d)                    a pulse cannot leave before the last echo
                                             from depth d is home, so depth caps the scale

   Nothing here knows about the anatomy or the screen: shifts, wraps, filters, waveforms and
   estimators, in SI units unless a name says otherwise (velocities in cm/s where the
   name ends Cm). Pure functions, so the unit tests can hold the physics to its numbers.
   ============================================================================ */

export const C_MS = 1540;                       // speed of sound in soft tissue, m/s

/* The Doppler equation, and its inverse. theta is the angle between the flow and the
   beam; a positive shift is flow TOWARD the probe. f0 in Hz, v in m/s, result in Hz. */
export const dopplerShift = (f0, v, theta, c = C_MS) => 2 * f0 * v * Math.cos(theta) / c;
export const velocityFromShift = (fd, f0, theta, c = C_MS) => fd * c / (2 * f0 * Math.cos(theta));

/* A pulsed system samples the shift once per pulse, so by Nyquist it can only tell
   frequencies apart over a window PRF wide: +-PRF/2 about the baseline. */
export const nyquistShift = (prf) => prf / 2;
export const nyquistVelocity = (prf, f0, theta = 0, c = C_MS) => c * prf / (4 * f0 * Math.cos(theta));

/* THE DEPTH LIMIT. The next pulse cannot be sent until the echo from the sample depth has
   come back (2d/c later), or the machine could not tell which pulse an echo belongs to. So
   PRF <= c/2d, and a deep vessel has a low ceiling on its scale: the reason a deep fast jet
   aliases however hard the scale knob is turned. depth in m, result in Hz. */
export const prfMax = (depth, c = C_MS) => c / (2 * depth);

/* WRAP-AROUND, NOT CLIPPING. A pulsed measurement is a PHASE per pulse, and a phase is only
   known modulo 2 pi — so a shift beyond the window does not stop at the edge, it reappears
   from the other side. The baseline does not widen the window, it only slides it: b in
   (-1, 1) moves the zero line, giving the window [-half (1 - b), half (1 + b)). b > 0 buys
   room for positive flow at the cost of negative, which is what the baseline knob is for. */
export function wrapToWindow(x, half, b = 0) {
  const lo = -half * (1 - b), w = 2 * half;
  return lo + (((x - lo) % w) + w) % w;
}

/* ANGLE CORRECTION. The machine divides the measured shift by cos(theta_set); if the true
   angle is theta, what it reports is v cos(theta)/cos(theta_set). The fractional error from
   a misjudged cursor is therefore cos(theta)/cos(theta_set) - 1 — about tan(theta) per radian
   of misjudgement, so the same 5 degrees costs 5 % at 30 degrees, 18 % at 60 and 32 % at 70.
   That is the whole reason for the 60-degree rule. */
export const angleCorrectionError = (thetaTrue, thetaSet) => Math.cos(thetaTrue) / Math.cos(thetaSet) - 1;

/* THE WALL FILTER is a high-pass on the slow-time samples, and slow time is sampled at the PRF —
   so its response is PERIODIC in the PRF, and it acts on the ALIASED shift. A flow whose true
   shift is exactly one PRF looks stationary to the filter and is removed like a wall. Power
   response of an order-n Butterworth high-pass with cutoff fc. */
export function wallFilterGain(f, fc, prf, n = 4) {
  if (!(fc > 0)) return 1;
  const fa = Math.abs(wrapToWindow(f, prf / 2, 0));
  const r = Math.pow(fa / fc, 2 * n);
  return r / (1 + r);
}

/* ---- flow waveforms --------------------------------------------------------
   Velocity as a fraction of the vessel's peak, against time in the cardiac cycle (seconds
   from ventricular ejection, period T). Shapes in SECONDS, not in fractions of a cycle,
   because systole barely shortens as the rate rises: diastole is what gets cut, which is
   why a fast heart lifts the end-diastolic velocity of a low-resistance bed and erases the
   third phase of a high-resistance one. Each beat is summed with its neighbours so the
   previous beat's tail and the next beat's atrial kick are where they belong. */
const ag = (t, mu, sl, sr) => { const s = t < mu ? sl : sr, q = (t - mu) / s; return Math.exp(-0.5 * q * q); };
const BEAT = {
  // high resistance (the aorta and iliacs, the resting subclavians): a sharp systolic peak,
  // an early-diastolic REVERSAL as the wave reflects off a constricted bed, a small second
  // forward wave, then nothing — the classic triphasic signal, EDV 0
  triphasic: (t) => ag(t, 0.11, 0.035, 0.055) - 0.28 * ag(t, 0.30, 0.04, 0.05) + 0.10 * ag(t, 0.46, 0.05, 0.06),
  // the aorta ABOVE the renal arteries: the kidneys and the gut are low-resistance beds and take
  // flow all through diastole, so the reversal is lost and a little forward flow persists to the
  // end of the cycle — biphasic, EDV ~15 % of PSV. Below the renals the legs win: triphasic
  biphasic: (t) => ag(t, 0.11, 0.035, 0.06) - 0.05 * ag(t, 0.28, 0.03, 0.03) + 0.22 * ag(t, 0.36, 0.06, 0.55),
  // low resistance (carotid, brachiocephalic): a brain does not stop drawing in diastole, so
  // forward flow persists to the end of the cycle — EDV about a quarter of PSV, RI ~0.75
  lowres: (t) => ag(t, 0.11, 0.035, 0.06) - 0.06 * ag(t, 0.27, 0.02, 0.02) + 0.40 * ag(t, 0.33, 0.05, 0.5),
  // pulmonary artery: ejection into a low-pressure bed, a rounded systolic hump and no
  // diastolic flow at all
  pulmonary: (t) => ag(t, 0.13, 0.05, 0.07),
  // central veins: forward (toward the heart) all cycle, with an S wave as the atria relax,
  // a D wave as the tricuspid/mitral valve opens, and a small REVERSAL — the a wave — as the
  // atrium contracts just before the next beat (mu < 0: it belongs to the beat that follows)
  venous: (t) => 0.25 + 0.75 * ag(t, 0.22, 0.07, 0.08) + 0.45 * ag(t, 0.52, 0.06, 0.08) - 0.45 * ag(t, -0.08, 0.04, 0.04),
  // peripheral and portal veins: essentially steady, a whisper of cardiac ripple
  steady: (t) => 1 + 0.05 * ag(t, 0.25, 0.08, 0.08),
};
export const WAVE_KINDS = Object.keys(BEAT);
/* NORMALISED TO A PEAK OF ONE, because the vessel's peak is what the table quotes. Summing in
   the neighbouring beats lifts it — the last beat's diastolic tail is still running at the next
   systole, more so the faster the heart — so the peak is found per waveform and rate, once. */
const PEAK = new Map();
export function flowWave(kind, t, T) {
  const key = kind + ':' + T.toFixed(4);
  let pk = PEAK.get(key);
  if (pk === undefined) {
    pk = 0;
    for (let i = 0; i < 400; i++) pk = Math.max(pk, rawWave(kind, i * T / 400, T));
    PEAK.set(key, pk || 1);
  }
  return rawWave(kind, t, T) / pk;
}
function rawWave(kind, t, T) {
  const g = BEAT[kind] || BEAT.steady;
  const u = ((t % T) + T) % T;
  // venous and steady curves carry a constant term — sum only the beat-shaped part over
  // the neighbours, or the baseline would be counted five times
  const c = kind === 'venous' ? 0.25 : kind === 'steady' ? 1 : 0;
  // this beat, the three before it (a slow diastolic tail reaches that far) and the next one
  let s = c;
  for (let m = -1; m <= 3; m++) s += g(u + m * T) - c;
  return s;
}

/* Respiratory phasicity of the veins, insp in 0..1 (0 = end expiration). Inspiration drops the
   diaphragm and raises the pressure in the ABDOMEN, so the iliac veins slow and can stop; the
   same breath lowers the pressure in the CHEST, so the thoracic veins speed up. That opposite
   sign is the classic test for an obstruction between the two: a vein that has lost its
   phasicity has something in the way. The portal vein swings gently. Arteries do not care. */
export function respFactor(region, insp) {
  if (region === 'abdo') return 1 - 0.7 * insp;
  if (region === 'thorax') return 0.8 + 0.4 * insp;
  if (region === 'portal') return 1 - 0.25 * insp;
  return 1;
}

/* LAMINAR FLOW IS NOT PLUG FLOW. Viscosity holds the blood at the wall still and the centre
   fastest: the parabolic (Poiseuille) profile, v = vmax (1 - (r/R)^2), rho = r/R. It is what
   fills the spectral window when the gate is as wide as the lumen — a parabola puts EQUAL
   areas at every speed from zero to vmax, so the spectrum is a flat band — and what leaves the
   window clear when a small gate sits on the axis. */
export const laminar = (rho) => (rho >= 1 ? 0 : 1 - rho * rho);

/* ---- the estimators --------------------------------------------------------
   Components are scatterer groups, flat [a, f, phi, ...] (amplitude, shift Hz, phase rad).

   COLOUR: the Kasai autocorrelator. N pulses down the same line give N complex samples per
   depth; the phase step between neighbours is 2 pi f_d / PRF, so the argument of the lag-one
   autocorrelation is the MEAN shift, and it lives in (-pi, pi] — the wrap is built into the
   arithmetic, nobody codes it. Power is R(0). `gauss` supplies receiver noise. */
export function kasai(comps, nc, n, prf, noise, gauss) {
  let r1re = 0, r1im = 0, r0 = 0, pre = 0, pim = 0;
  for (let k = 0; k < n; k++) {
    let xr = 0, xi = 0;
    for (let j = 0; j < nc; j++) {
      const a = comps[3 * j], ph = comps[3 * j + 2] + 2 * Math.PI * comps[3 * j + 1] * k / prf;
      xr += a * Math.cos(ph); xi += a * Math.sin(ph);
    }
    if (noise) { xr += noise * gauss(); xi += noise * gauss(); }
    r0 += xr * xr + xi * xi;
    if (k) { r1re += xr * pre + xi * pim; r1im += xi * pre - xr * pim; }
    pre = xr; pim = xi;
  }
  // r1 is returned too (per pulse pair), so a display can average it over neighbouring gates
  // before taking the phase — the spatial smoothing every colour processor does
  return { f: prf * Math.atan2(r1im, r1re) / (2 * Math.PI), p: r0 / n, r1re: r1re / (n - 1), r1im: r1im / (n - 1) };
}

/* SPECTRAL: one column of the trace — the power at every shift in the window. Each component
   lands at its ALIASED shift (wrapped into the baseline's window, so a shift past the top
   comes back in from the bottom), smeared over the analysis window's resolution, after the
   wall filter. Then the two things that make a real spectrum look like one: every bin of a
   periodogram is exponentially distributed about its mean (the grain in the trace is the
   speckle of the Doppler signal), and the receiver adds its own floor. `rnd` is uniform 0..1. */
export function spectrumColumn(out, comps, nc, prf, b, fc, noiseP, rnd, sig = 0.9) {
  const nb = out.length, lo = -(prf / 2) * (1 - b);
  out.fill(0);
  for (let j = 0; j < nc; j++) {
    const a = comps[3 * j], f = comps[3 * j + 1];
    const p = a * a * wallFilterGain(f, fc, prf);
    if (p <= 0) continue;
    const fa = wrapToWindow(f, prf / 2, b);
    const x = (fa - lo) / prf * nb - 0.5;
    const i0 = Math.floor(x);
    let ws = 0;
    for (let d = -2; d <= 3; d++) { const q = (i0 + d - x) / sig; ws += Math.exp(-0.5 * q * q); }
    for (let d = -2; d <= 3; d++) {
      const q = (i0 + d - x) / sig, i = (((i0 + d) % nb) + nb) % nb;   // the window is periodic
      out[i] += p * Math.exp(-0.5 * q * q) / ws;
    }
  }
  // the noise goes through the same high-pass: the dark strip either side of the baseline
  for (let i = 0; i < nb; i++) {
    const nw = Math.max(0.02, wallFilterGain(lo + (i + 0.5) * prf / nb, fc, prf));
    out[i] = out[i] * -Math.log(1 - rnd() * 0.999999) + noiseP * nw * -Math.log(1 - rnd() * 0.999999);
  }
  return out;
}
/* The bin index of a shift, and the shift at a bin's centre, for the same window. */
export const binOfShift = (f, prf, b, nb) => Math.floor((wrapToWindow(f, prf / 2, b) + (prf / 2) * (1 - b)) / prf * nb);
export const shiftOfBin = (i, prf, b, nb) => -(prf / 2) * (1 - b) + (i + 0.5) * prf / nb;

/* THE MAXIMUM-VELOCITY ENVELOPE — what the auto-trace follows and what PSV is read off.
   Threshold crossing from the edge of the window inward, on a three-bin smooth (a single
   speckle grain must not set the peak): the highest positive and the lowest negative shift
   whose power stands `thrDb` above the noise floor. 0 where nothing does. */
export function maxEnvelope(P, prf, b, noiseP, thrDb = 9) {
  const nb = P.length, thr = noiseP * Math.pow(10, thrDb / 10);
  const z = binOfShift(0, prf, b, nb);
  const sm = (i) => (P[Math.max(0, i - 1)] + P[i] + P[Math.min(nb - 1, i + 1)]) / 3;
  let pos = 0, neg = 0;
  for (let i = nb - 1; i > z; i--) if (sm(i) > thr) { pos = shiftOfBin(i, prf, b, nb); break; }
  for (let i = 0; i < z; i++) if (sm(i) > thr) { neg = shiftOfBin(i, prf, b, nb); break; }
  return { pos, neg };
}

/* PEAK SYSTOLIC AND END-DIASTOLIC VELOCITY over the last COMPLETE cardiac cycle, from the
   envelope history: rows of { pos, neg: the envelope either side of the baseline, wrap: true
   on the first column of a beat } — the ECG trigger every machine has. The flow's side is the
   one carrying more of the cycle; PSV is the envelope's peak on it, EDV is where it stands at
   the end of the cycle, just before the next upstroke (a reversal at end diastole reads as a
   negative EDV, as it should). RI is Pourcelot's (PSV - EDV) / PSV. Null until a whole beat
   has been swept. Units are whatever the rows carry. */
export function peakMeasures(rows) {
  let e = -1, s = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!rows[i].wrap) continue;
    if (e < 0) e = i; else { s = i; break; }
  }
  if (s < 0 || e - s < 4) return null;
  let sp = 0, sn = 0;
  for (let i = s; i < e; i++) { sp += rows[i].pos; sn -= rows[i].neg; }
  const sg = sp >= sn ? 1 : -1;
  const side = (r) => (sg > 0 ? (r.pos || r.neg) : (-r.neg || -r.pos));
  let psv = 0, tam = 0;
  for (let i = s; i < e; i++) { const v = side(rows[i]); if (v > psv) psv = v; tam += v; }
  const edv = (side(rows[e - 1]) + side(rows[e - 2])) / 2;
  return { psv, edv, ri: psv > 0 ? (psv - edv) / psv : 0, tamax: tam / (e - s), dir: sg };
}
