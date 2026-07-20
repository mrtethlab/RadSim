/* ============================================================================
   MODULE 5 — DETECTOR
   Dose map -> photon statistics (quantum mottle) -> stored raw signal, plus
   IEC 62494 exposure index over the collimated field.
   ============================================================================ */
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
      const cut=directLvl*0.82;                                     // anything brighter is direct exposure
      let hi=n; while(hi>0 && inField[hi-1]>=cut) hi--;             // hi = count of attenuated (anatomy) pixels
      const anat=hi>16? hi : n;                                     // fall back to the whole field if all direct
      const P=_t.P??0.90;                                           // upper percentile of the anatomy
      const voi=inField[Math.min(anat-1, Math.floor(anat*P))];
      EI=Math.round(voi*(_t.K??900));                              // detector-dose calibration (EI 100 = 1 µGy, IEC 62494-1)
    }
    return {signal, EI};
  }
  return {capture};
})();

