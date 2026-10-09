/* STAFF DOSE IN FLUOROSCOPY: the scatter the operator stands in.

   The patient is the source. Almost all of the scatter that reaches staff comes from where the
   beam ENTERS the patient, and it is strongest back toward the tube; what goes forward has to
   cross the patient to get out. Those two facts are the whole of the C-arm protection lesson:
   - keep the tube UNDER the table, so the strong backscatter goes at the floor and the legs
     (where a table skirt stops it), not at the eyes and thyroid;
   - on a lateral, stand on the DETECTOR side;
   - step back (inverse square), and wear the lead that covers what is left.

   Model, per pulse:
     K(P) = SCATTER_K x DAP x (1 m / |P - E|)^2 x f(theta) x shielding(P)
   E is the entrance point on the central ray, theta the angle between the beam direction and
   the direction from E to the body point P. SCATTER_K is the scatter air kerma at 1 m and 90°
   per unit DAP for an adult trunk: published C-arm measurements give 1-5 µGy per Gy·cm²; this
   takes 2. f(theta) is 1 at 90°, rising to 1.5 straight back toward the tube, falling to 0.2
   straight forward (through the patient). Real isodose maps are lumpier; the asymmetries they
   teach (tube side several times the detector side, eyes vs legs swapping with the tube
   position) are what this keeps.

   Units: positions in cm (world), DAP in µGy·m² (the console's unit; 1 µGy·m² = 0.01 Gy·cm²),
   doses in µGy (≈ µSv for these photons). */

export const SCATTER_K = 2;                 // µGy at 1 m, 90°, per Gy·cm²

// heights of the body points above the floor, cm (an adult standing at the table)
export const BODY_H = { eyes: 165, thyroid: 150, trunk: 120, gonads: 90, legs: 45 };

// transmission of each protective item for scattered radiation (~60-80 keV after scatter)
export const SHIELD_T = {
  apron: 0.05,       // 0.35 mm Pb equivalent: trunk and gonads
  collar: 0.05,      // thyroid collar
  glasses: 0.3,      // leaded glasses: what gets round the sides limits them to ~3x
  ceiling: 0.1,      // ceiling-suspended screen between the patient and the head
  skirt: 0.1,        // table-mounted drape: everything below the table top
};

export function scatterAngleFactor(cosTheta) {
  return cosTheta <= 0 ? 1 + 0.5 * -cosTheta : Math.max(0.2, 1 - 0.8 * cosTheta);
}

/* One pulse. op = { x, z } where the operator stands (floor position, world cm); floorY and
   tableTopY in world cm; prot = { apron, collar, glasses, ceiling, skirt } booleans.
   Returns { eyes, thyroid, trunk, gonads, legs, neckBare } in µGy; neckBare is the dose at the
   collar BEFORE the collar, which is what a dosimeter worn over the apron reads. */
export function staffPulse({ dapUGym2, entry, beamDir, op, floorY, tableTopY, prot = {} }) {
  const out = { eyes: 0, thyroid: 0, trunk: 0, gonads: 0, legs: 0, neckBare: 0 };
  if (!entry || !(dapUGym2 > 0)) return out;
  const gycm2 = dapUGym2 * 0.01;
  for (const k of Object.keys(BODY_H)) {
    const P = [op.x, floorY + BODY_H[k], op.z];
    const d = [P[0] - entry[0], P[1] - entry[1], P[2] - entry[2]];
    const r = Math.hypot(d[0], d[1], d[2]);
    const cos = (d[0] * beamDir[0] + d[1] * beamDir[1] + d[2] * beamDir[2]) / (r || 1);
    let K = SCATTER_K * gycm2 * Math.pow(100 / Math.max(r, 20), 2) * scatterAngleFactor(cos);
    if (k === 'thyroid') out.neckBare += K;
    if (prot.skirt && P[1] < tableTopY) K *= SHIELD_T.skirt;
    if (prot.ceiling && (k === 'eyes' || k === 'thyroid')) K *= SHIELD_T.ceiling;
    if (prot.apron && (k === 'trunk' || k === 'gonads')) K *= SHIELD_T.apron;
    if (prot.collar && k === 'thyroid') K *= SHIELD_T.collar;
    if (prot.glasses && k === 'eyes') K *= SHIELD_T.glasses;
    out[k] += K;
  }
  return out;
}

/* Effective dose for the operator. Under an apron, the two-dosimeter estimate (Niklason et al.,
   1993): E = 0.5 H_waist(under) + 0.025 H_neck(over, bare). Without one, the trunk dose stands
   for the whole body. µSv. */
export function staffEffective(acc, apron) {
  return apron ? 0.5 * acc.trunk + 0.025 * acc.neckBare : acc.trunk;
}

/* The patient's skin where the beam enters. The console's air kerma is at the interventional
   reference point, 15 cm from the isocentre toward the tube; the skin may be nearer the focus
   than that (patient lifted toward the tube, a big patient) or further. Inverse square to the
   real entrance, backscatter, and the tabletop's attenuation when the beam crosses it first. */
export function skinEntranceMGy(akRefMGy, refDistCm, fsdCm, crossesTable) {
  if (!(fsdCm > 0)) return 0;
  return akRefMGy * Math.pow(refDistCm / fsdCm, 2) * 1.35 * (crossesTable ? 0.8 : 1);
}
