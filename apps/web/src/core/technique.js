/* TECHNIQUE: what the chart is written for, and what this patient needs.

   A technique chart is written for an average adult. The patients here are not average: the
   chest/abdomen/pelvis subject measures 31 cm front to back at L3 against the 22 cm an AP
   lumbar chart assumes, and at 80 kV those 9 cm cost a factor of seven in exposure. A
   radiographer measures the part with calipers and reads the chart by thickness; this does
   the same along the central ray, and scales mAs at fixed kV (the method DR technique charts
   use — kV sets the contrast, mAs the exposure).

   The scale is not a rule of thumb ("double per 4 cm"). The patient's own central ray is
   traced, and the average adult is taken to be this patient's ray shrunk to the chart's
   thickness, so fat, lung and bone stay in proportion. The factor is the ratio of the two
   polyenergetic transmissions through the same spectrum the image is made with. */

/* Caliper thickness: everything along the ray that is not air (material 0). Lung counts —
   calipers measure the body, not its density. */
export function caliperOf(L) {
  let t = 0;
  for (let m = 1; m < L.length; m++) t += L[m] || 0;
  return t;
}

/* mAs factor taking the chart (written for tRef cm) to this patient (path lengths L by
   material along the central ray). mu[m][b] is the attenuation of material m in spectrum bin
   b; bins carry the normalised weights w. Returns null when the ray misses the patient. */
export function sizeCorrection(L, tRef, mu, bins) {
  const t = caliperOf(L);
  if (!(t > 1) || !(tRef > 0)) return null;
  const T = (s) => {
    let sum = 0;
    for (let b = 0; b < bins.length; b++) {
      let e = 0;
      for (let m = 1; m < L.length; m++) if (L[m]) e += mu[m][b] * L[m] * s;
      sum += bins[b].w * Math.exp(-e);
    }
    return sum;
  };
  return { t, factor: T(tRef / t) / T(1) };
}

/* The exposure index is read over a region of interest that depends on the examination, as
   it does on every DR system (IEC 62494-1 leaves the VOI to the exam's own algorithm). A chest
   is judged on its lung fields — the well-penetrated upper part of the anatomy histogram. Every
   other exam is judged on the anatomy as a whole: its median. A single upper percentile for
   everything let the thinnest tissue at the field edge — thigh on a pelvis, scalp on a skull —
   set the EI, and the same patient at the same technique read 10 DI apart. */
export function voiPercentile(part, subject) {
  if (part) return part === 'Chest' ? 0.90 : 0.50;
  return subject === 'chest' ? 0.90 : 0.50;
}

/* Snap an exposure to the console's mAs stations, within its range. */
export function nearestStation(mas, steps) {
  let best = steps[0];
  for (const s of steps) if (Math.abs(Math.log(s / mas)) < Math.abs(Math.log(best / mas))) best = s;
  return best;
}
