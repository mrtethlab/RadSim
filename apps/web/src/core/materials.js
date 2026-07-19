/* ============================================================================
   MODULE 1 — MATERIALS
   Energy-dependent linear attenuation coefficient mu(E) = (mu/rho)(E) * rho.
   (mu/rho) tables in cm^2/g (NIST-style, total w/ coherent). Interpolated
   log-log in energy. Shared by radiography and (future) CT.
   ============================================================================ */
export const Materials = (()=>{
  const E = [20,30,40,50,60,80,100,120,150];            // keV
  const tables = {
    soft:   { rho:1.05, mr:[0.8096,0.3756,0.2683,0.2269,0.2059,0.1837,0.1707,0.1614,0.1505] },
    bone:   { rho:1.92, mr:[4.001, 1.331, 0.6655,0.4242,0.3148,0.2229,0.1855,0.1650,0.1480] },
    // medullary cavity: fatty marrow + sparse trabeculae — only mildly denser than
    // soft tissue, so cortical shafts read as bright rails around a lucent canal.
    marrow: { rho:1.05, mr:[0.9310,0.4319,0.3085,0.2609,0.2368,0.2113,0.1963,0.1856,0.1731] },
    Al:     { rho:2.70, mr:[3.441, 1.128, 0.5685,0.3681,0.2778,0.2018,0.1704,0.1533,0.1385] },
  };
  const lnE = E.map(Math.log);
  function interpMR(mat, keV){
    const t = tables[mat], x = Math.log(keV);
    if(x<=lnE[0]) return t.mr[0];
    if(x>=lnE[lnE.length-1]) return t.mr[t.mr.length-1];
    let i=0; while(x>lnE[i+1]) i++;
    const f=(x-lnE[i])/(lnE[i+1]-lnE[i]);
    return Math.exp(Math.log(t.mr[i])*(1-f)+Math.log(t.mr[i+1])*f);
  }
  return {
    materials:['soft','bone'],
    rho:(m)=>tables[m].rho,
    // linear attenuation coefficient, cm^-1
    mu:(m,keV)=> interpMR(m,keV)*tables[m].rho,
    muAl:(keV)=> interpMR('Al',keV)*tables['Al'].rho,
  };
})();

