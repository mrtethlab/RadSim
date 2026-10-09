/* ============================================================================
   MODULE 5 — DETECTOR
   Dose map -> photon statistics (quantum mottle) -> stored raw signal, plus
   IEC 62494 exposure index over the collimated field.
   ============================================================================ */
/* EI calibration, shared so the AEC cannot drift from the EI it is trying to hit.
   K: detector-dose calibration (EI 100 = 1 uGy, IEC 62494-1).
   DIRECT_CUT: fraction of the direct-beam level above which a pixel is treated as raw beam
   rather than anatomy. 0.82 was too permissive — a hand's finger margins transmit 70-80 % and
   were counted as anatomy, which is why EI moved 2.4x on collimation alone. 0.60 excludes
   those while still keeping genuinely penetrated tissue: lung transmits ~30-50 % of direct
   and stays well inside the VOI. Going below ~0.5 starts eating real lung and makes the
   abdomen read progressively low, so it is not a free parameter. */
export const EI_K = 900;
/* AEC chamber calibration: chamber dose per unit receptor dose ON A UNIFORM PHANTOM, which is
   how a real AEC is set up — so 1. With it, the right chambers expose correctly and the wrong
   ones do not, which is the lesson the AEC is there to teach.

   It was 6.1, fitted so a PA chest metered on the CENTRE chamber read DI 0: the centre chamber
   sits on the mediastinum while the EI reads the lungs, and the constant made up the difference.
   But the centre chamber is the wrong one for a PA chest (the two lateral chambers, over the lungs,
   are right), and the fit broke everything else — measured with the exam VOI: lateral chambers on
   a chest -6.6 DI, centre chamber on a KUB -5.6, AP lumbar -6.0, pelvis -8.0, skull -6.4, knee
   -6.9, hand -7.4. At 1: chest on the lateral chambers +1.2, KUB +2.2, lumbar +1.8, pelvis -0.2,
   skull +1.4, knee +1.0, hand 0.0 — and a chest on the centre chamber burns the lungs out at +6.3,
   as it does on a real room. */
export const AEC_CHAMBER_CAL = 1;
export const DIRECT_CUT = 0.60;
/* ADDITIVE ELECTRONIC NOISE, in quanta-equivalent RMS per pixel.

   Quantum noise has variance N, so it grows with the square root of the dose and its
   RELATIVE size falls as 1/sqrt(N) — halve the dose and the image gets modestly grainier.
   That is a gentle penalty, and on its own it makes underexposure look merely soft. Real
   flat panels also carry a FIXED noise from the readout electronics: an amplifier and an
   ADC contribute the same electrons whether or not any x-rays arrived. Its variance does
   not shrink with dose, so as the exposure falls it stops being a rounding error and
   starts being the whole signal. That is the cliff a real underexposed radiograph falls
   off, and why "just turn the mAs down" is punished rather than tolerated.

   A typical indirect (CsI/aSi) panel reads about 1500 e- RMS, and its conversion gain runs
   near 100 e- per absorbed x-ray quantum, which puts the electronic noise at ~15 quanta
   equivalent. Deliberately a per-PIXEL constant and NOT scaled by pixel area, unlike the
   quantum budget: readout noise belongs to the amplifier chain, one per detector element,
   however large that element is. So a finer matrix collects fewer quanta per pixel while
   paying the same electronics — which is exactly why high-resolution modes need more dose.

   Total variance is then N + ELECTRONIC^2, the two being independent. At a correct
   exposure this is invisible; measured in the darkest clinically relevant region of a
   gridded chest it lifts the noise 1.96 % -> 2.04 %. Ten times under, it bites. */
export const ELECTRONIC_NOISE = 15;

export const Detector = (()=>{
  function gauss(){ let u=0,v=0; while(!u)u=Math.random(); while(!v)v=Math.random();
    return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }
  // dose(Float32) -> {signal:Float32, ei, region-mask handled by caller}
  // direct: optional open-beam level per pixel (what the receptor reads with nothing in the
  // beam). With it, raw beam is recognised by TRANSMISSION, which works whether or not the
  // field contains any; without it the brightest 2 % of the field is assumed to be raw beam.
  // voiP: the anatomy percentile the exam is judged on (core/technique.js voiPercentile) —
  // the lung fields for a chest, the median for everything else. Defaults to the lung VOI.
  function capture(dose, nx, ny, photonScale, mask, direct=null, voiP=null){
    const signal=new Float32Array(nx*ny);
    const inField=[], anatomy=[];
    const _t0=(typeof globalThis!=='undefined'&&globalThis.__tune)||{};
    const cutT=_t0.C??DIRECT_CUT;
    const eVar = ELECTRONIC_NOISE*ELECTRONIC_NOISE;   // dose-independent, so it rules at low N
    for(let k=0;k<dose.length;k++){
      const N = dose[k]*photonScale;               // expected quanta
      // quantum (variance N) and readout (variance eVar) noise are independent, so the
      // variances add. The clamp is the detector's own floor: a real panel cannot report
      // less than nothing either, and near the floor that rectification is part of why an
      // underexposed image goes flat and mushy rather than merely noisy.
      const noisy = mask[k] ? Math.max(0, N + gauss()*Math.sqrt(N+1+eVar)) : 0;
      const s = noisy/photonScale;
      signal[k]=s;
      if(mask[k]){
        inField.push(s);
        // classified on the noiseless dose, so the VOI does not flicker with the mottle
        if(direct && dose[k] < cutT*direct[k]) anatomy.push(s);
      }
    }
    // EI proportional to detector air kerma over the values-of-interest (IEC 62494).
    // Two segmentation steps mirror what a real DR EI algorithm does:
    //  1) EXCLUDE the directly-exposed raw beam (unattenuated background outside/around
    //     the body). Otherwise, when the field is larger than the body part (e.g. a hand
    //     on a big receptor), the EI reads the raw beam and is wildly over-stated.
    //  2) take an upper percentile of the remaining ANATOMY, so the EI reflects the
    //     well-penetrated diagnostic region (lung fields on a chest) — not the darkest
    //     tissue (mediastinum/spine).
    inField.sort((a,b)=>a-b);
    const _t=_t0;
    const n=inField.length;
    let EI=0;
    const P=_t.P??voiP??0.90;                                       // percentile of the anatomy
    if(direct && n){
      // nothing attenuated at all (an empty table): the field itself is the VOI
      const a = anatomy.length>16 ? anatomy.sort((x,y)=>x-y) : inField;
      EI=Math.round(a[Math.min(a.length-1, Math.floor(a.length*P))]*(_t.K??EI_K));
    } else if(n){
      const directLvl=inField[Math.floor(n*0.98)]||inField[n-1];   // ~unattenuated (direct) level
      // Anything brighter than this fraction of the direct level is treated as raw beam.
      // It is the knob that decides how much near-direct anatomy edge (thin finger margins
      // transmit 70-80 %) leaks into the VOI, which is why EI moved 2.4x with collimation
      // alone on a hand. Tunable so it can be calibrated against the APR chart.
      const cut=directLvl*(_t.C??DIRECT_CUT);                       // anything brighter is direct exposure
      let hi=n; while(hi>0 && inField[hi-1]>=cut) hi--;             // hi = count of attenuated (anatomy) pixels
      const anat=hi>16? hi : n;                                     // fall back to the whole field if all direct
      const voi=inField[Math.min(anat-1, Math.floor(anat*P))];
      EI=Math.round(voi*(_t.K??EI_K));                              // detector-dose calibration (EI 100 = 1 µGy, IEC 62494-1)
    }
    return {signal, EI};
  }
  return {capture};
})();

