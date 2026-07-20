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
    // Use an upper percentile rather than the whole-field median so the EI reflects the
    // well-penetrated diagnostic region (e.g. the lung fields on a chest) instead of
    // being dragged down by the darkest anatomy (mediastinum/spine).
    inField.sort((a,b)=>a-b);
    const _t=(typeof globalThis!=='undefined'&&globalThis.__tune)||{};
    const P=_t.P??0.62;                            // values-of-interest percentile (well-penetrated region)
    const voi = inField.length? inField[Math.min(inField.length-1, Math.floor(inField.length*P))] : 0;
    const EI = Math.round(voi * (_t.K??200));       // calibration -> ~260 at hand 55/2.0/100
    return {signal, EI};
  }
  return {capture};
})();

