/* DXA FILM: the physics the 8-bit scenes run on. The source's spectrum and the cerium K-edge
   filter that splits it; the attenuation of soft tissue and bone at the two energies (the app's
   own mass attenuation, dxa.js basis(), baked into dxa.json); the 2x2 solve. Every function of
   time here works for any t, however long a step is held. */
import { tungstenSpectrum } from '../../kit/micro.js';

export const CE_EDGE = 40.44;        // keV: cerium's K-shell binding energy
export const CE_KA = 34.7;           // keV: cerium's K-alpha line (an L electron filling the K hole)
export const KV = 76;                // kV: the source's constant potential (GE Lunar)
export const CE_RHOT = 0.2;          // g/cm2 of cerium in the beam (about 0.3 mm)
export const THRESH = 53;            // keV: where the detector splits its counts, between the peaks

// cerium's mass attenuation (cm2/g): photoelectric, falling as about E^-2.75, jumping six-fold at
// the K edge where the K shell's two electrons become available; a little scatter on top
export const ceMu = (E) => (E < CE_EDGE ? 3.4 : 19.4) * Math.pow(CE_EDGE / E, 2.75) + 0.15;
// the source's spectrum (tungsten, 76 kV, the tube's own aluminium) and what leaves the filter
export const src76 = tungstenSpectrum(KV, 0.25);
export const ceT = (E, k = 1) => Math.exp(-ceMu(E) * CE_RHOT * k);
// what leaves the filter, on the source's own scale (k: how much of the filter is in, 0..1)
export const filtered = (E, k = 1) => src76(E) * ceT(E, k);
const peak = (() => { let m = 0; for (let E = 10; E <= KV; E += 0.5) m = Math.max(m, filtered(E)); return m; })();
// the same, scaled so its taller peak reaches 0.95 (for sampling and for a plot of its own)
export const dual = (E) => filtered(E) / peak * 0.95;

// draw an energy from a spectrum (rejection sampling, seeded)
export function sampleE(r, spec, lo = 15, hi = KV) {
  for (let k = 0; k < 200; k++) { const E = lo + r() * (hi - lo); if (r() < spec(E)) return E; }
  return (lo + hi) / 2;
}

/* The attenuation of the two basis materials (cm2/g at the two energies) and the R values, from
   the bake (the app's own numbers); fall-backs if it is missing. */
export function physOf(J) {
  const P = J?.phys || { E_LO: 40, E_HI: 70, soft: { lo: 0.2657, hi: 0.1918 }, bone: { lo: 0.4118, hi: 0.2078 } };
  const Rs = P.soft.lo / P.soft.hi, Rb = P.bone.lo / P.bone.hi;
  return {
    ...P, Rs, Rb, rhoS: 1.05, rhoB: 1.92,
    // the solve, written the way DXA writes it: soft tissue's R takes the soft tissue out
    Mb: (Alo, Ahi) => (Alo - Rs * Ahi) / (P.bone.lo - Rs * P.bone.hi),
    Ms: (Alo, Ahi) => (P.bone.lo * Ahi - P.bone.hi * Alo) / (P.bone.lo * P.soft.hi - P.bone.hi * P.soft.lo),
    // the share of interactions that are photoelectric (the rest: Compton), by material and energy
    fPE: (m, E) => 1 / (1 + (E / (m === 'bone' ? 36 : 25)) ** 3),
  };
}

/* A stream that never runs dry: items born every `every` seconds from 0, their positions a function
   of age. Visits the items alive at t (age 0..life), however large t is. */
export function stream(t, every, life, fn) {
  const i1 = Math.floor(t / every), i0 = Math.max(0, Math.floor((t - life) / every));
  for (let i = i0; i <= i1; i++) { const age = t - i * every; if (age >= 0 && age <= life) fn(i, age); }
}
