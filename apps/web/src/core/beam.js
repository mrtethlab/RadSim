/* ============================================================================
   THE BEAM HAS WIDTH — docs/ultrasound.md §4.5
   A scanline is not a ray. It is a beam with a lateral and an elevational width that
   change with depth: wide at the face (the aperture), narrow at the focus, diverging
   past it. Everything soft about a real B-mode image comes from that width:

     - a SHADOW has soft edges, because a stone or a rib blocks only part of the beam
       when the line runs past its edge — a penumbra, not a knife;
     - a shadow behind something narrower than the beam is only partial, and is
       deepest when the obstacle sits in the focal zone (the reason for "put the focus
       on the stone");
     - ENHANCEMENT behind a cyst fades in and out laterally for the same reason;
     - a small cyst FILLS IN with echoes from the tissue either side of the slice
       (elevational partial volume), and boundaries that the beam crosses obliquely
       smear instead of stair-stepping.

   Two widths per depth (FWHM, cm):
     transmit  focused once, at the focus knob, through an aperture D = F / F#, capped by
               the face: geometric convergence (D |1 - r/F|, apodised) in quadrature with
               diffraction (KA lambda r / D), which is KA lambda F / D AT the focus;
     receive   focused DYNAMICALLY at every depth with a constant F# until the aperture
               runs out — which is why a modern image stays sharp far from the transmit
               focus while its shadows (a transmit-path effect) still soften.
   Elevation has a fixed lens: its own aperture and focus, which the knob does not move.

   The beam is carried through the scan as a handful of SUB-RAYS at fixed fractions of the
   local width — Gauss-Hermite nodes of the beam profile. Each pays its own losses along
   its own path, and the beam's transmission is their weighted sum. Pure functions, so the
   tests can hold the geometry to its numbers.
   ============================================================================ */

export const KG = 0.4;           // apodisation: the geometric cone's FWHM as a fraction of its edge-to-edge width
/* ...and apodisation's other price: the tapered aperture that keeps side lobes down broadens the
   main lobe, ~1.5x for a Hann-like taper — which is what puts a 3.5 MHz abdominal probe's
   lateral resolution at the 1.5-2 mm a phantom measures, not the 1 mm lambda F# promises. */
export const KA = 1.5;

/* FWHM of a beam focused at F through aperture D, at depth r (all cm). */
export function beamWidth(r, F, D, lam, kg = KG) {
  const g = kg * D * (1 - r / Math.max(F, 1e-3));
  const d = KA * lam * r / D;
  return Math.max(Math.hypot(g, d), lam);
}
/* Transmit aperture: the F-number the system keeps, until the face runs out. */
export const txAperture = (F, fnum, dmax) => Math.min(Math.max(F, 0.5) / fnum, dmax);
/* Dynamic receive focusing: constant F# (width lambda F#) until the aperture is full. */
export const rxWidth = (r, lam, fnum, dmax) => KA * lam * Math.max(fnum, r / dmax);
/* Two-way (pulse-echo) width: the product of two Gaussian profiles. */
export const twoWay = (wT, wR) => 1 / Math.sqrt(1 / (wT * wT) + 1 / (wR * wR));
export const FWHM_SIGMA = 2 * Math.sqrt(2 * Math.LN2);           // 2.3548

/* The probes. Lateral: transmit and receive F-numbers and the largest active aperture.
   Elevation: the lens — a fixed aperture height and focus (curvilinear abdominal: 1.3 cm,
   focused at 7 cm; linear small-parts: 0.5 cm at 2 cm). */
export const PROBE_BEAM = {
  curvi:  { fTx: 3, fRx: 3.5, dMax: 3.5, elevH: 1.3, elevF: 7.0 },
  linear: { fTx: 3, fRx: 3.5, dMax: 2.0, elevH: 0.5, elevF: 2.0 },
};

/* The beam's widths at depth r for a probe, frequency (lambda, cm) and transmit focus. */
export function beamAt(r, probe, lam, focus, out = {}) {
  const B = PROBE_BEAM[probe] || PROBE_BEAM.curvi;
  const D = txAperture(focus, B.fTx, B.dMax);
  out.tx = beamWidth(r, focus, D, lam);
  out.rx = rxWidth(Math.max(r, 1e-3), lam, B.fRx, B.dMax);
  out.lat = twoWay(out.tx, out.rx);
  out.elev = beamWidth(r, B.elevF, B.elevH, lam);
  return out;
}

/* Sub-ray nodes across a Gaussian profile of unit sigma: n uniform nodes over +-span sigma,
   weighted by the profile and normalised. Uniform rather than Gauss-Hermite because a shadow
   edge is a STEP, and a step wants evenly spaced samples to come out as a smooth ramp. */
export function profileNodes(n, span = 2.25) {
  const s = new Float64Array(n), w = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    s[i] = n === 1 ? 0 : -span + 2 * span * i / (n - 1);
    w[i] = Math.exp(-0.5 * s[i] * s[i]); sum += w[i];
  }
  for (let i = 0; i < n; i++) w[i] /= sum;
  return { s, w };
}
/* Three elevation rays: the 3-point Gauss-Hermite rule for the TWO-WAY profile (sigma/sqrt 2
   of the one-way), nodes in units of the one-way sigma. Exact for its first five moments. */
export const ELEV_NODES = { s: [-Math.sqrt(1.5), 0, Math.sqrt(1.5)], w: [1 / 6, 2 / 3, 1 / 6] };

/* THE BEAM'S TRANSMISSION, line by line.
   M[k*nl + l] (depth-major, so a sub-ray's neighbours are adjacent in memory) is the one-way
   amplitude factor a centre ray pays over step k of line l
   (reflection loss at the interface there, times attenuation over the step). A sub-ray of
   line l sits at lateral offset s*sigma(k) at depth k — sigma in LINE units, from the
   transmit width and the line spacing at that depth — so it crosses the neighbouring lines as
   the beam converges and diverges, and pays THEIR losses as it goes. The beam's amplitude
   reaching depth k (before step k's own loss, as the centre ray's echo is) is the profile-
   weighted sum of its sub-rays. A beam half-blocked by a stone carries on at half amplitude:
   the penumbra. Out: T[l*ns + k] (line-major, as the echo is). */
export function beamTransmission(M, nl, ns, sigLines, nodes, T) {
  const { s, w } = nodes, n = s.length;
  const amp = new Float64Array(nl * n).fill(1);
  const o0 = new Int32Array(n), fr = new Float64Array(n);
  for (let k = 0; k < ns; k++) {
    // the sub-rays' offsets at this depth are the same for every line: split them once
    const sg = sigLines[k];
    for (let i = 0; i < n; i++) { const off = s[i] * sg, f = Math.floor(off); o0[i] = f; fr[i] = off - f; }
    const row = k * nl;
    for (let l = 0; l < nl; l++) {
      const a = l * n;
      let t = 0;
      for (let i = 0; i < n; i++) t += w[i] * amp[a + i];
      T[l * ns + k] = t;
      if (t < 1e-12) continue;
      for (let i = 0; i < n; i++) {
        let l0 = l + o0[i], l1 = l0 + 1;
        if (l0 < 0) { l0 = 0; l1 = 0; } else if (l1 > nl - 1) { l1 = nl - 1; if (l0 > nl - 1) l0 = nl - 1; }
        const f = fr[i];
        amp[a + i] *= M[row + l0] * (1 - f) + M[row + l1] * f;
      }
    }
  }
  return T;
}

/* REVERBERATION. A strong echo does not stop at the face: the face reflects a fraction RF of it
   back in, and it makes the whole trip again. So every specular reflector a — at sample ka, with
   returned amplitude ea and a COHERENCE ka (how much of the reflected wave comes back as a wave:
   1 for a broad flat mirror like a gas surface or the pleura, small for a curved rough rib or a
   stone, which scatter it away) — re-launches the line's own echo train, delayed by its own
   round trip: rev(k + ka) += RF ka ea E(k). The copy of the reflector itself lands at 2 ka (an
   A-line), the copy of the tissue above it fills the space beneath — the DIRTY shadow — and the
   process repeats for higher orders. Behind a clean absorber nothing is re-launched: a CLEAN
   shadow. `phase(k)` decorrelates the copies (a real gas surface is not a perfect mirror), as a
   unit phasor [cos, sin]. Complex echo in (I, Q); adds in place. Returns the reflectors used. */
export function addReverb(I, Q, base, ns, refl, nr, RF, orders, phase) {
  if (!nr) return;
  const srcI = new Float32Array(ns), srcQ = new Float32Array(ns);
  for (let k = 0; k < ns; k++) { srcI[k] = I[base + k]; srcQ[k] = Q[base + k]; }
  const nxtI = new Float32Array(ns), nxtQ = new Float32Array(ns);
  const ph = [0, 0];
  for (let o = 0; o < orders; o++) {
    nxtI.fill(0); nxtQ.fill(0);
    let any = false;
    // a copy weaker than gMin (-54 dB of what it copies) is under the noise of any display;
    // each further order is another factor g down, so it only matters behind a near-mirror
    const gMin = o === 0 ? 2e-3 : 2e-2;
    for (let a = 0; a < nr; a++) {
      const ka = refl[3 * a] | 0, g = RF * refl[3 * a + 1] * refl[3 * a + 2];
      if (!(Math.abs(g) > gMin) || ka < 1) continue;
      for (let k = 0; k + ka < ns; k++) {
        const sr = srcI[k], si = srcQ[k];
        if (sr === 0 && si === 0) continue;
        phase(k + ka, o, ph);
        nxtI[k + ka] += g * (sr * ph[0] - si * ph[1]);
        nxtQ[k + ka] += g * (sr * ph[1] + si * ph[0]);
        any = true;
      }
    }
    if (!any) break;
    for (let k = 0; k < ns; k++) { I[base + k] += nxtI[k]; Q[base + k] += nxtQ[k]; srcI[k] = nxtI[k]; srcQ[k] = nxtQ[k]; }
  }
}

/* AN OBLIQUE BOUNDARY (Fresnel and Snell, for pressure waves in fluids). cosI is the cosine of the
   angle between the beam and the surface normal. Returns into `out`:
     t  the AMPLITUDE (sqrt intensity) the beam carries on with: sqrt(4 Z1 Z2 cosI cosT /
        (Z2 cosI + Z1 cosT)^2) — 1 - rc^2 under the root at normal incidence, falling to zero as the
        beam grazes the surface, and ZERO past the critical angle when the far side is faster
        (sin T = c2/c1 sin I > 1): total internal reflection. Leaving a gallbladder (bile 1520 m/s
        into liver 1570) that angle is 75.5 degrees, and the band of lines that graze the wall
        beyond it is the EDGE SHADOW, which the beam's width then softens;
     r  the echo that comes back to the probe: the oblique reflection coefficient, times how
        much of a mirror-reflected wave the aperture catches when it leaves at 2 I off the beam —
        a SPECULAR surface is bright only where the beam meets it square, a rough one keeps a
        diffuse floor. Which is why a diaphragm or a vessel wall brightens and fades along its
        curve, and why a voxel staircase seen obliquely does not glitter at every step. */
export const SPEC_FLOOR = 0.35, SPEC_LOBE = 0.25;   // diffuse floor; specular lobe half-width (rad)
export function obliqueInterface(z1, z2, c1, c2, cosI, out) {
  const ci = Math.min(1, Math.abs(cosI)), si = Math.sqrt(Math.max(0, 1 - ci * ci));
  const st = si * c2 / c1;
  const th = Math.acos(ci), dir = SPEC_FLOOR + (1 - SPEC_FLOOR) * Math.exp(-((th / SPEC_LOBE) ** 2));
  if (st >= 1) { out.t = 0; out.r = dir; return out; }
  const ct = Math.sqrt(1 - st * st);
  const den = z2 * ci + z1 * ct;
  out.t = den > 0 ? Math.sqrt(Math.max(0, 4 * z1 * z2 * ci * ct) ) / den : 0;
  out.r = (den > 0 ? (z2 * ci - z1 * ct) / den : 0) * dir;
  return out;
}
