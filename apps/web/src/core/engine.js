import { Materials } from './materials.js';

/* ============================================================================
   MODULE 4 — ATTENUATION ENGINE
   One projection: cast a ray from source through each detector cell, get
   per-material path lengths, integrate the polyenergetic Beer-Lambert law,
   apply inverse-square dose. Returns a dose map (relative detector air kerma).
   Runs chunked (async) so the UI stays alive.
   // [CT] A CT scan calls project() for N gantry angles with source/detector
   //      rotated about the isocentre, then reconstructs (filtered backproj).
   ============================================================================ */
export const AttenuationEngine = (()=>{
  async function project(cfg, onProgress){
    const {phantom, source, detCenter, detU, detV, nx, ny, pxU, pxV,
           spectrum, I0, onRow} = cfg;
    const dose = new Float32Array(nx*ny);
    const bins = spectrum.bins;
    // precompute mu per material per bin
    const muSoft = bins.map(b=>Materials.mu('soft',b.E));
    const muBone = bins.map(b=>Materials.mu('bone',b.E));
    const muMarrow = bins.map(b=>Materials.mu('marrow',b.E));
    const halfU=(nx-1)/2, halfV=(ny-1)/2;
    for(let j=0;j<ny;j++){
      const cv=(j-halfV)*pxV;
      for(let i=0;i<nx;i++){
        const cu=(i-halfU)*pxU;
        // detector cell world position
        const px=detCenter[0]+detU[0]*cu+detV[0]*cv;
        const py=detCenter[1]+detU[1]*cu+detV[1]*cv;
        const pz=detCenter[2]+detU[2]*cu+detV[2]*cv;
        let dx=px-source[0], dy=py-source[1], dz=pz-source[2];
        const dist=Math.hypot(dx,dy,dz); dx/=dist;dy/=dist;dz/=dist;
        const {bone,soft,marrow}=phantom.trace(source,[dx,dy,dz], dist);
        // polyenergetic transmission
        let T=0;
        for(let b=0;b<bins.length;b++){
          T += bins[b].w * Math.exp(-(muSoft[b]*soft + muBone[b]*bone + muMarrow[b]*marrow));
        }
        // inverse-square (normalized to source-image distance)
        const invSq = (cfg.refDist*cfg.refDist)/(dist*dist);
        dose[j*nx+i] = I0 * invSq * T;
      }
      if(onRow && (j&7)===0){ onRow(j/ny); await new Promise(r=>setTimeout(r,0)); }
    }
    return dose;
  }
  return {project};
})();

