/* Image processing on the log base tone, pure so it can be tested off the page (app.js renders
   with it): the masked box blur the multiscale detail processing is built from, and the latitude
   (equalisation) a LUT can ask for. */

export function boxBlurMasked(src,mask,nx,ny,r){
  if(r<1) return src.slice();
  const tmp=new Float32Array(nx*ny), out=new Float32Array(nx*ny);
  for(let y=0;y<ny;y++){ const row=y*nx; let sum=0,cnt=0;
    for(let x=0;x<r&&x<nx;x++){ if(mask[row+x]){sum+=src[row+x];cnt++;} }
    for(let x=0;x<nx;x++){ const add=x+r; if(add<nx&&mask[row+add]){sum+=src[row+add];cnt++;}
      const rem=x-r-1; if(rem>=0&&mask[row+rem]){sum-=src[row+rem];cnt--;}
      tmp[row+x]= cnt? sum/cnt : src[row+x]; } }
  for(let x=0;x<nx;x++){ let sum=0,cnt=0;
    for(let y=0;y<r&&y<ny;y++){ const k=y*nx+x; if(mask[k]){sum+=tmp[k];cnt++;} }
    for(let y=0;y<ny;y++){ const add=y+r; if(add<ny&&mask[add*nx+x]){sum+=tmp[add*nx+x];cnt++;}
      const rem=y-r-1; if(rem>=0&&mask[rem*nx+x]){sum-=tmp[rem*nx+x];cnt--;}
      out[y*nx+x]= cnt? sum/cnt : tmp[y*nx+x]; } }
  return out;
}

/* LATITUDE (equalisation), for a LUT that asks for it (latitude: {r, k}). An AP ankle has the foot
   standing end-on over the talus and calcaneus: 15-20 cm of tissue beside 7 cm of leg. The
   window that holds both left the foot region a flat white in the sigmoid's tail, and widening
   the window greyed the whole film without bringing the talus back. DR processing (the coarse
   band of a multiscale decomposition, a "latitude" or equalisation setting) takes part of the
   large-area density difference out instead: here the base tone less k of its blur over r of
   the matrix (about 3.5 cm on a 30 cm receptor), the blur over the ANATOMY only, so the raw beam
   beside the skin is not averaged in and leaves no halo; the anatomy's mean tone is kept, so the
   window found on the raw signal still sits on it. No band is boosted: the limb films' plain
   tones (no rim, no sheen) stay plain.
   voi: the patient's own pixels (the display window's values of interest, judged from the primary
   against the open beam), for a LUT whose latitude asks for them (voi: true). The anatomy is
   otherwise whatever is short of 0.95 of the brightest pixel, and the raw beam beside an AP skull
   lies at 0.80-0.99 of it, beside an angled Towne at 0.45-0.95: taken for anatomy, the air went
   into the blur and the mean, and the Towne came out black inside the rim of its vault. */
export function latitudeImage(sig,nx,ny,mask,mx,{r=0.12,k=0.5}={},voi=null){
  const a=40, denom=Math.log(1+a), base=new Float32Array(nx*ny), anat=new Uint8Array(nx*ny), cut=mx*0.95;
  let sum=0, n=0;
  for(let i=0;i<sig.length;i++){ if(!mask[i]) continue; base[i]=1-Math.log(1+a*sig[i]/mx)/denom;
    if(voi ? voi[i] : sig[i]<cut){ anat[i]=1; sum+=base[i]; n++; } }
  if(!n) return base;
  const R=Math.max(1,Math.round(r*Math.max(nx,ny)/2));            // two passes of a box: near a gaussian
  const B=boxBlurMasked(boxBlurMasked(base,anat,nx,ny,R),anat,nx,ny,R), m=sum/n;
  for(let i=0;i<base.length;i++) if(anat[i]) base[i]-=k*(B[i]-m);
  return base;
}

/* The signal the equalised film shows: latitudeImage's tones taken back through the log, so the
   display window (core/displayWindow.js) can be found on them, as DR finds its values of interest
   after its frequency processing. A skull windowed on its raw tones kept the window the vault and
   the face span together, and the equalised anatomy sat in a light, flat band (its median at 0.7-0.8
   of the grey scale on the skull views). */
export function equalisedSignal(sig,nx,ny,mask,voi,lat){
  let mx=0; for(let i=0;i<sig.length;i++) if(mask[i]&&sig[i]>mx) mx=sig[i];
  if(!mx) return sig;
  const a=40, denom=Math.log(1+a), base=latitudeImage(sig,nx,ny,mask,mx,lat,voi), out=new Float32Array(sig.length);
  for(let i=0;i<sig.length;i++) if(mask[i]) out[i]=mx*(Math.exp((1-base[i])*denom)-1)/a;
  return out;
}
