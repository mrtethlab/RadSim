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
/* Chamber-to-VOI ratio for the reference projection (PA chest, centre cell).

   An AEC meters its ION CHAMBERS, but EI is reported over the image VOI, and those are not
   the same dose: the centre chamber sits on the mediastinum while the VOI lands on lung.
   Targeting `eiTarget/EI_K` as a CHAMBER dose therefore keeps the tube running until the
   mediastinum reaches a lung-level dose — measured at 7.78 mAs against the chart's 2.5, a
   2.8x over-exposure that the EI then correctly reported as DI +4.4.

   A real system is calibrated so the correct chamber yields DI 0, so this is a fixed constant
   rather than a per-exposure fit: choosing the WRONG chamber must still mis-expose, which is
   the entire point of the exercise.

   It is simply the VOI-to-chamber ratio: solving the AEC termination shows EI_K cancels out
   of the resulting DI, so this constant alone sets where a correct AEC lands. Re-measured at
   6.1 after the scatter fix — scatter had been the great equaliser, lifting the mediastinum
   toward the lung, so removing it widened the true ratio from 2.8. */
export const AEC_CHAMBER_CAL = 6.1;
export const DIRECT_CUT = 0.60;

export const Detector = (()=>{
  function gauss(){ let u=0,v=0; while(!u)u=Math.random(); while(!v)v=Math.random();
    return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }
  // dose(Float32) -> {signal:Float32, ei, region-mask handled by caller}
  function capture(dose, nx, ny, photonScale, mask){
    const signal=new Float32Array(nx*ny);
    const inField=[];
    for(let k=0;k<dose.length;k++){
      const N = dose[k]*photonScale;               // expected quanta
      const noisy = mask[k] ? Math.max(0, N + gauss()*Math.sqrt(N+1)) : 0;
      const s = noisy/photonScale;
      signal[k]=s;
      if(mask[k]) inField.push(s);
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
    const _t=(typeof globalThis!=='undefined'&&globalThis.__tune)||{};
    const n=inField.length;
    let EI=0;
    if(n){
      const directLvl=inField[Math.floor(n*0.98)]||inField[n-1];   // ~unattenuated (direct) level
      // Anything brighter than this fraction of the direct level is treated as raw beam.
      // It is the knob that decides how much near-direct anatomy edge (thin finger margins
      // transmit 70-80 %) leaks into the VOI, which is why EI moved 2.4x with collimation
      // alone on a hand. Tunable so it can be calibrated against the APR chart.
      const cut=directLvl*(_t.C??DIRECT_CUT);                       // anything brighter is direct exposure
      let hi=n; while(hi>0 && inField[hi-1]>=cut) hi--;             // hi = count of attenuated (anatomy) pixels
      const anat=hi>16? hi : n;                                     // fall back to the whole field if all direct
      const P=_t.P??0.90;                                           // upper percentile of the anatomy
      const voi=inField[Math.min(anat-1, Math.floor(anat*P))];
      EI=Math.round(voi*(_t.K??EI_K));                              // detector-dose calibration (EI 100 = 1 µGy, IEC 62494-1)
    }
    return {signal, EI};
  }
  return {capture};
})();

