import { Materials } from './materials.js';

/* ============================================================================
   MODULE 2 — SPECTRUM
   Polyenergetic tube output from kVp. Bremsstrahlung (Kramers ~ (kVp-E))
   hardened by inherent+added Al filtration. Returns normalized {E,w} bins.
   Higher kVp => harder beam => less subject contrast (emergent beam hardening).
   ============================================================================ */
export const Spectrum = (()=>{
  const filt_cm = 0.25; // 2.5 mm Al equivalent total filtration
  function make(kVp){
    const bins=[]; let sum=0;
    for(let e=15; e<=kVp; e+=3){
      let w = Math.max(0,(kVp-e));                 // bremsstrahlung shape
      w *= Math.exp(-Materials.muAl(e)*filt_cm);   // filtration hardens beam
      bins.push({E:e,w}); sum+=w;
    }
    if(sum<=0){bins.push({E:kVp,w:1}); sum=1;}
    bins.forEach(b=>b.w/=sum);
    // relative fluence rises with kVp (~kVp^2 in dose); folded into engine I0
    let meanE=0; bins.forEach(b=>meanE+=b.E*b.w);
    return {bins, meanE, kVp};
  }
  return {make};
})();

