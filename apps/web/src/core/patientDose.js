/* PATIENT DOSE FOR ONE RADIOGRAPH: what the console's dose readout shows, so that the choices a
   radiographer makes (collimation, distance, kV against mAs, AEC chamber, a repeat) show up in
   the patient's dose and not only in the picture.

   Two quantities, both standard on a DR console and in a dose audit:
   - ENTRANCE SURFACE DOSE (ESD): the air kerma at the skin where the central ray enters,
     including the radiation the patient scatters back (backscatter factor). This is what the
     diagnostic reference levels for single radiographs are quoted in.
   - DOSE-AREA PRODUCT (DAP): air kerma times beam area. It does not change with distance from
     the focus (the kerma falls as 1/d², the area grows as d²), so it is the one number that
     counts both how much and how wide, and collimation moves it directly.

   ABSOLUTE OUTPUT. The x-ray chain's own dose units are set by the detector calibration (EI 100
   = 1 µGy at the receptor) and are not a tube output; this uses a typical one instead: a
   tungsten tube with about 2.5-3 mm Al total filtration gives roughly 50 µGy/mAs at 1 m at
   80 kV, rising about as kV² (typical of QC measurements and manufacturer data). Real tubes differ by ±30 %,
   which is why departments measure theirs; the RATIOS here (half the mAs, double the area, a
   step back on the SID) are exact whatever the constant is. */

export const OUTPUT_80KV = 50;                 // µGy per mAs at 1 m from the focus, at 80 kV

// incident air kerma per mAs at 1 m (µGy/mAs)
export function tubeOutput(kv) {
  return OUTPUT_80KV * Math.pow(kv / 80, 2);
}

// incident air kerma (no backscatter) at distance dCm from the focus, µGy
export function incidentKerma(kv, mas, dCm) {
  return tubeOutput(kv) * mas * Math.pow(100 / dCm, 2);
}

/* Backscatter factor for a water-like patient, after the IAEA TRS-457 tables: about 1.3 for a
   10 x 10 cm field at 60-70 kV, about 1.35-1.4 for 20 x 20 cm at 80-120 kV, saturating for large
   fields (1.35 is the value usually assumed for a chest). The excess over 1 grows with beam
   quality and, more slowly, with field size. */
export function backscatter(kv, areaCm2) {
  const k = Math.max(0, Math.min(1, (kv - 60) / 60));
  const excess20 = 0.32 + 0.07 * k;                         // 20 x 20 cm field
  const side = Math.sqrt(Math.max(1, areaCm2));
  return 1 + excess20 * Math.min(1.08, Math.pow(side / 20, 0.3));
}

/* Where the central ray enters the patient: the shortest distance along the ray at which any
   tissue has been crossed. tissueTo(s) is the tissue path length between the focus and a point
   s cm along the ray. Bisection between the focus and maxCm, to 1 mm. Returns null when the
   ray never meets the patient (then there is no entrance surface to quote). */
export function entryDistance(tissueTo, maxCm) {
  if (!(tissueTo(maxCm) > 0)) return null;
  let lo = 0, hi = maxCm;
  while (hi - lo > 0.1) {
    const mid = (lo + hi) / 2;
    if (tissueTo(mid) > 0) hi = mid; else lo = mid;
  }
  return hi;
}

/* Everything the readout shows for one exposure.
   kv, mas (the mAs actually delivered — the AEC's, when it terminated), sidCm, fsdCm (focus to
   skin on the central ray, or null), fieldCm2 (the collimated field at the SID). */
export function radiographDose({ kv, mas, sidCm, fsdCm, fieldCm2 }) {
  const kSid = incidentKerma(kv, mas, sidCm);               // µGy at the receptor plane
  const dapUGym2 = kSid * fieldCm2 / 1e4;                   // µGy·m², the same at any plane
  if (!(fsdCm > 0)) return { dapUGym2, esdMGy: null, iakMGy: null, bsf: null, fsdCm: null };
  const skinArea = fieldCm2 * Math.pow(fsdCm / sidCm, 2);
  const bsf = backscatter(kv, skinArea);
  const iak = incidentKerma(kv, mas, fsdCm);
  return { dapUGym2, iakMGy: iak / 1000, esdMGy: iak * bsf / 1000, bsf, fsdCm };
}
