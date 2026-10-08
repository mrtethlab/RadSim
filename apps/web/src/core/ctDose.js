/* ============================================================================
   CT DOSE — the numbers on the scanner's dose screen, and the one quantity that
   ties them to image noise.

   EFFECTIVE mAs = mA x rotation time / pitch is the single definition both sides use.
   It is what sets the photons per reconstructed slice (and so the noise: sigma goes as
   1/sqrt of it), and it is what CTDIvol is proportional to. Keeping one function for it is
   the point: a dose readout that moves with pitch over an image whose noise does not would
   teach the trade-off backwards.

   CTDIvol  — CTDIw for the standard acrylic phantom, per 100 mAs at 120 kV, scaled by
              mAs and kV, divided by pitch. The phantom is the scanner's choice, not the
              patient's: the 16 cm HEAD phantom for head SFOVs, the 32 cm BODY phantom
              otherwise. That is why a head scan reports about twice the CTDIvol of a body
              scan at the same technique, and why CTDIvol is not the patient's dose.
   DLP      — CTDIvol x the IRRADIATED length, which is longer than the planned range: a
              helical scan has to overrun each end to interpolate the first and last slice,
              about one rotation's table feed in all.
   E        — DLP x a body-region k-factor (mSv per mGy·cm, adult). A population estimate for
              comparing protocols, never a patient's dose.

   Reference values are TYPICAL 64-slice figures, not any one vendor's; ratios between
   techniques are what the exercise is about, and those do not depend on the reference.
   ============================================================================ */

// CTDIw per 100 mAs at 120 kV, mGy
export const CTDIW_REF = { head: 16.0, body: 7.0 };
// CTDI rises a little faster than fluence (~kV^2): harder beams deposit more per photon
export const KV_EXPONENT = 2.5;
// Adult effective-dose conversion, mSv per mGy·cm (AAPM Report 96 / ICRP 103 values)
export const K_FACTOR = {
  head: 0.0021, headNeck: 0.0031, neck: 0.0059, chest: 0.014,
  abdomenPelvis: 0.015, chestAbdomenPelvis: 0.015, trunk: 0.015, extremity: 0.0008,
};
// which body region each subject is, for the k-factor; phantoms have no effective dose
export const SUBJECT_REGION = {
  hand: 'extremity', hand_hires: 'extremity', upperextremity: 'extremity', lowerextremity: 'extremity',
  hires_shoulder: 'extremity', headneck: 'headNeck', chest: 'chest',
  chestabdopelvis: 'chestAbdomenPelvis', totalhipreplacement: 'abdomenPelvis', wholebody: 'trunk',
};
const REGION_LABEL = {
  head: 'head', headNeck: 'head & neck', neck: 'neck', chest: 'chest', abdomenPelvis: 'abdomen/pelvis',
  chestAbdomenPelvis: 'chest/abdomen/pelvis', trunk: 'trunk', extremity: 'extremity',
};

export function effectiveMAs(ma, rotS, pitch) {
  return ma * rotS / Math.max(pitch, 1e-6);
}
export function phantomFor(sfovMM) {
  return sfovMM <= 250 ? 'head' : 'body';
}
export function ctdiVol({ kv, ma, rotS, pitch, phantom }) {
  return CTDIW_REF[phantom] * (effectiveMAs(ma, rotS, pitch) / 100) * Math.pow(kv / 120, KV_EXPONENT);
}
export function irradiatedLengthMM(scanLenMM, feedMMPerRot) {
  return scanLenMM + feedMMPerRot;
}
export function dlp(ctdi, scanLenMM, feedMMPerRot) {
  return ctdi * irradiatedLengthMM(scanLenMM, feedMMPerRot) / 10;
}
export function effectiveDose(dlpVal, subject) {
  const region = SUBJECT_REGION[subject];
  if (!region) return null;
  return { mSv: dlpVal * K_FACTOR[region], k: K_FACTOR[region], region: REGION_LABEL[region] };
}
// everything the console shows for one scan group
export function groupDose(g, { scanLenMM, feedMMPerRot, subject }) {
  const phantom = phantomFor(g.sfovMM);
  const ctdi = ctdiVol({ kv: g.kv, ma: g.ma, rotS: g.rotSpeed, pitch: g.pitch, phantom });
  const d = dlp(ctdi, scanLenMM, feedMMPerRot);
  return { phantom, ctdiVol: ctdi, dlp: d, effMAs: effectiveMAs(g.ma, g.rotSpeed, g.pitch),
           effective: effectiveDose(d, subject) };
}
