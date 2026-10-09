/* What the scatter fog is measured against.

   Scatter is made in the patient, so the fog is scaled to the primary that came THROUGH the
   patient — and to its typical value, the median, not its mean. A mean of transmissions belongs
   to the thinnest tissue in the field: an AP pelvis, whose field runs off the end of the patient
   onto a few cm of thigh, laid a fog over the abdomen of 2.5x the abdomen's own primary, behind a
   grid, while a KUB of the same patient carried 0.3. "Through the patient" is judged against the
   open beam at each pixel: anything transmitting more than 90 % of it missed.

   Returns the median primary and the predicate, or null when nothing in the field is patient. */
export const MISSED = 0.9;
export function patientPrimary(dose, direct, mask) {
  const inPatient = (k) => mask[k] && dose[k] < MISSED * direct[k];
  const prim = [];
  for (let k = 0; k < dose.length; k++) if (inPatient(k)) prim.push(dose[k]);
  if (!prim.length) return null;
  prim.sort((a, b) => a - b);
  return { median: prim[prim.length >> 1], n: prim.length, inPatient };
}
