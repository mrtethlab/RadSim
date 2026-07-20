import { Materials } from './materials.js';
import { muOverBins } from './voxelPhantom.js';

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
    const bins = spectrum.bins, nb = bins.length;
    // A voxel phantom (imported chest, etc.) carries many materials; an analytic
    // phantom carries soft/bone/marrow. Precompute mu per bin for whichever applies.
    const voxel = !!phantom.voxel;
    const muMat = voxel ? muOverBins(bins) : null, nmat = voxel ? muMat.length : 0;
    const hitId = voxel ? new Int32Array(nmat) : null, hitLen = voxel ? new Float64Array(nmat) : null;
    const muSoft = voxel ? null : bins.map(b=>Materials.mu('soft',b.E));
    const muBone = voxel ? null : bins.map(b=>Materials.mu('bone',b.E));
    const muMarrow = voxel ? null : bins.map(b=>Materials.mu('marrow',b.E));
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
        // polyenergetic transmission Σ_bin w · exp(−Σ_material μ·pathlength)
        let T=0;
        if(voxel){
          const L=phantom.trace(source,[dx,dy,dz], dist);
          let nh=0; for(let m=1;m<nmat;m++){ const lm=L[m]; if(lm){ hitId[nh]=m; hitLen[nh]=lm; nh++; } }
          for(let b=0;b<nb;b++){ let e=0; for(let k=0;k<nh;k++) e += muMat[hitId[k]][b]*hitLen[k]; T += bins[b].w * Math.exp(-e); }
        } else {
          const {bone,soft,marrow}=phantom.trace(source,[dx,dy,dz], dist);
          for(let b=0;b<nb;b++){ T += bins[b].w * Math.exp(-(muSoft[b]*soft + muBone[b]*bone + muMarrow[b]*marrow)); }
        }
        // inverse-square (normalized to source-image distance)
        const invSq = (cfg.refDist*cfg.refDist)/(dist*dist);
        dose[j*nx+i] = I0 * invSq * T;
      }
      if(onRow && (j&31)===0){ onRow(j/ny); await new Promise(r=>setTimeout(r,0)); }
    }
    return dose;
  }
  return {project};
})();

