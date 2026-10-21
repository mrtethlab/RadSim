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
/* A MONITORING SERIES (bolus tracking, test bolus) is one axial slice, exposed again every ~1.5 s
   at the same place: no table feed, so pitch does not enter, and each exposure irradiates one beam
   width. CTDIvol is per exposure, as the console reports it; the DLP is every exposure's, added.
   It had been left out of the study total altogether, which on a tracked CTA hides 15-20 exposures.
   widthMM is the irradiated width: the beam collimation, except on a single-row scanner, where
   the beam is collimated to the slice (the caller knows which). */
export function monitorDose(g, scans, subject, widthMM = g.beamColl) {
  const phantom = phantomFor(g.sfovMM);
  const ctdi = ctdiVol({ kv: g.kv, ma: g.ma, rotS: g.rotSpeed, pitch: 1, phantom });
  const perScan = ctdi * widthMM / 10;
  const d = perScan * scans;
  return { phantom, ctdiVol: ctdi, perScanDLP: perScan, scans, dlp: d,
           effMAs: effectiveMAs(g.ma, g.rotSpeed, 1), effective: effectiveDose(d, subject) };
}
// everything the console shows for one scan group
export function groupDose(g, { scanLenMM, feedMMPerRot, subject }) {
  const phantom = phantomFor(g.sfovMM);
  const ctdi = ctdiVol({ kv: g.kv, ma: g.ma, rotS: g.rotSpeed, pitch: g.pitch, phantom });
  const d = dlp(ctdi, scanLenMM, feedMMPerRot);
  return { phantom, ctdiVol: ctdi, dlp: d, effMAs: effectiveMAs(g.ma, g.rotSpeed, g.pitch),
           effective: effectiveDose(d, subject) };
}

/* SIZE-SPECIFIC DOSE ESTIMATE (AAPM Reports 204 and 220). CTDIvol is the dose to an acrylic
   phantom, 16 or 32 cm, whoever is on the table; a small patient absorbs more of the same beam
   than the phantom does, a large one less. SSDE corrects it by the patient's WATER-EQUIVALENT
   DIAMETER, Dw = 2 sqrt(Aw / pi), where Aw is the slice's area weighted by attenuation relative
   to water (so lung counts for little and bone for more). The conversion factor is Report 204's
   exponential fit, per reference phantom:
       f = a exp(-b Dw),   32 cm: a 3.704369, b 0.03671937;   16 cm: a 1.874799, b 0.03871313
   (Report 293 refines the head; the 16 cm fit is kept here as the simpler, published one.) */
const SSDE_FIT = { body: [3.704369, 0.03671937], head: [1.874799, 0.03871313] };
export function ssdeFactor(dwCm, phantom) {
  const [a, b] = SSDE_FIT[phantom] || SSDE_FIT.body;
  return a * Math.exp(-b * dwCm);
}
export function waterEqDiameterCm(areaCm2) {
  return 2 * Math.sqrt(Math.max(0, areaCm2) / Math.PI);
}

/* DOSE CHECK (NEMA XR 25, with the AAPM's recommended values). Before a scan the console
   compares each series' CTDIvol with a NOTIFICATION value (adult head 80 mGy, adult body 50 mGy)
   and the CTDIvol that would accumulate at any one location over the examination with an ALERT
   value (1000 mGy). Either stops the scan until the operator confirms. The accumulation is what
   catches a monitoring series fired twenty times at one level, or overlapping repeat scans.
   series: [{ name, ctdiVol, phantom, z0, z1 (mm), exposures }] (exposures > 1 at one place). */
export const DOSE_CHECK = { notify: { head: 80, body: 50 }, alert: 1000 };
export function doseCheck(series) {
  const notices = [];
  for (const s of series) {
    const nv = DOSE_CHECK.notify[s.phantom] ?? DOSE_CHECK.notify.body;
    if (s.ctdiVol > nv) notices.push({ name: s.name, ctdiVol: s.ctdiVol, limit: nv });
  }
  // the worst location: accumulation can only change at a series' ends, so test those
  let peak = 0, at = null;
  const zs = [];
  for (const s of series) zs.push(Math.min(s.z0, s.z1), Math.max(s.z0, s.z1));
  for (const z of zs) {
    let sum = 0;
    for (const s of series) if (z >= Math.min(s.z0, s.z1) - 1e-6 && z <= Math.max(s.z0, s.z1) + 1e-6) sum += s.ctdiVol * (s.exposures || 1);
    if (sum > peak) { peak = sum; at = z; }
  }
  const alert = peak > DOSE_CHECK.alert ? { accumulated: peak, at, limit: DOSE_CHECK.alert } : null;
  return { notices, alert, peak };
}
