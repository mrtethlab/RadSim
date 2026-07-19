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
    // EI proportional to median detector air kerma in the field (IEC 62494)
    inField.sort((a,b)=>a-b);
    const med = inField.length? inField[inField.length>>1] : 0;
    const EI = Math.round(med * 234);              // calibration -> ~250 at 55/2.0/100
    return {signal, EI};
  }
  return {capture};
})();

