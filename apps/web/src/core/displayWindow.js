/* ---- automatic rescaling (digital-radiography auto-ranging) ----
   Real DR analyses the image histogram, finds the anatomy's values-of-interest (VOI)
   and rescales those to a standard display range, so the image looks optimally exposed
   regardless of over/under-exposure (the exposure index still reports the true dose).
   Here: the anatomy's tones (raw beam excluded) are windowed onto the display LUT. Pure, so it
   can be tested off the page; app.js passes the exam's LUT and the __tune overrides. */
export function computeRescale(sig, mask, lut = null, _t = {}) {
  let mx=0; for(let k=0;k<sig.length;k++) if(mask[k]&&sig[k]>mx) mx=sig[k]; mx=mx||1;
  // EXCLUDE the directly-exposed raw beam from the VOI window. The unattenuated beam sits
  // at the dark end of the tone scale; if it is left in, its pixels pin the window's low
  // end and the whole anatomy is crammed into a bright, flat band (washed-out chest). By
  // dropping pixels brighter than `cut`, the window locks onto the anatomy so the well-
  // penetrated lung fields stretch to dark and the mediastinum/spine to bright.
  // The cut must sit JUST below the unattenuated level, which by definition is the image
  // maximum — nothing attenuates less than nothing. A loose fraction (this was 0.72) also
  // discards genuinely thin anatomy: at 55 kVp a few mm of soft tissue still transmits
  // ~80-90 % of the raw beam, so a hand's whole finger envelope was being treated as
  // direct exposure and clipped to white, leaving the phalanges looking like bare bone.
  const cut=mx*(_t.rcut??0.95);
  const a=40, denom=Math.log(1+a), NB=1024, hist=new Uint32Array(NB); let total=0;
  for(let k=0;k<sig.length;k++){ if(!mask[k]||sig[k]>=cut) continue;   // skip direct exposure
    let t=Math.log(1+a*sig[k]/mx)/denom, b=Math.round((1-t)*(NB-1));
    hist[b<0?0:b>NB-1?NB-1:b]++; total++; }
  if(!total) return null;
  const pl=_t.rlo??0.05, ph=_t.rhi??0.01;   // clip darkest pl and brightest ph of the anatomy
  const at=(f)=>{ let acc=0; for(let b=0;b<NB;b++){ acc+=hist[b]; if(acc>=total*f) return b; } return NB-1; };
  let lo=at(pl), hi=NB-1, acc=0;
  for(let b=NB-1;b>=0;b--){ acc+=hist[b]; if(acc>=total*ph){ hi=b; break; } }
  /* CENTRE THE ANATOMY ON THE LUT. The low end used to be the 5th percentile of the anatomy, and
     on a thick part with raw beam beside it — an AP pelvis, a cervical spine, a skull — that is
     the thin tissue at the edge: the window then reached far down for it and the body of the
     image was squeezed into the top fifth of the grey scale (median output 0.86-0.93, washed
     out). The low end is now raised, only as far as needed, for the MEDIAN anatomy to land on the
     LUT's centre — and never past the 12th percentile, so no more than about an eighth of the
     anatomy (skin edges, the thigh beside a pelvis) is allowed to burn out. Exams whose median
     already sits at or below the centre (hands, feet, a chest's lungs) are unchanged.
     Measured over the 40 protocols: the tonal spread of the anatomy (p90-p10 of the output) went
     0.62 -> 0.91 on an AP pelvis, 0.64 -> 0.81 AP cervical, 0.39 -> 0.84 lateral skull, and fell
     nowhere; burned-out anatomy stays <= 18 % outside the hand and foot, which do not move. */
  const c=lut&&lut.sigmoid ? lut.center : 0.5;
  const med=at(0.5), want=(med-c*hi)/(1-c);
  lo=Math.max(lo, Math.min(want, at(0.12), med-0.02*(NB-1)));
  return { lo: lo/(NB-1), hi: Math.max((lo+1)/(NB-1), hi/(NB-1)) };
}
