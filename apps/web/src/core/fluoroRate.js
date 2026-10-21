/* FLUOROSCOPIC AIR-KERMA RATE, AND ITS LEGAL CEILING.

   Reference-point air kerma per pulse, modelled on a mid-size C-arm: ~12 mGy/min at 70 kV /
   2 mA / 15 pps, scaling with tube output (kV^2.5 x mA) and with the magnification mode (a
   smaller field needs more input dose per area for the same brightness).

   A fluoroscope may not exceed 88 mGy/min at the reference point in normal mode (US 21 CFR
   1020.32(d); 10 R/min), and the generator enforces it: the curve the automatic brightness
   control climbs is clipped in mA, so a big patient gets more kV and a noisier, darker image
   instead of more dose. Recorded modes (spot film, DSA, cine) are not fluoroscopy and are
   exempt. Without the ceiling the ABC railed at 110 kV / 10 mA on a 31 cm lumbar subject and
   the meter read ~170 mGy/min, a rate no machine would deliver. */

export const RATE_LIMIT = 88;                         // mGy/min, normal mode
const REF = { rate: 12, kv: 70, ma: 2, pps: 15 };

// mGy per pulse at the reference point; magFactor = (full field / this field)^2
export function akPerPulse(kv, ma, magFactor = 1) {
  return (REF.rate / (60 * REF.pps)) * (ma / REF.ma) * Math.pow(kv / REF.kv, 2.5) * magFactor;
}

export function akRate(kv, ma, pps, magFactor = 1) {
  return akPerPulse(kv, ma, magFactor) * pps * 60;
}

// the highest mA this kV, pulse rate and field can run at without passing the limit
export function maCeiling(kv, pps, magFactor = 1, limit = RATE_LIMIT) {
  return limit / akRate(kv, 1, pps, magFactor);
}
