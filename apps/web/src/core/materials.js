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

/* ============================================================================
   BODY MATERIALS — the expanded material legend for voxel phantoms (chest, etc.)
   Every voxel of an imported model carries a material id = index into LIST. Each
   material yields a linear attenuation coefficient mu(E) [cm^-1]:
     - "tissue" materials (soft tissue / fluids / fat / lung / cartilage / bone…)
       use a water+cortical-bone basis decomposition calibrated so their Hounsfield
       value at the reference energy matches the clinical HU. Tissues below the
       bone threshold are water-scaled (correct water-like beam hardening); calcified
       tissues add a cortical-bone component (correct bone-like hardening).
     - "element" materials (air, contrast, and metals Al/Ti/steel/Pb) carry an
       explicit NIST-style mass-attenuation curve × density, so their strong
       photoelectric energy dependence (and Pb's K-edge) is modelled — this is what
       makes titanium / steel / lead prosthetics read as very bright with streaking.
   HU shown in the legend is computed from mu at the reference energy, so it is
   self-consistent with the physics. Metal mass-attenuation values are approximate
   NIST (XCOM) figures — accurate to the qualitative metal >> bone >> soft ordering.
   ============================================================================ */
export const BodyMaterials = (()=>{
  const E   = [20,30,40,50,60,80,100,120,150];         // keV grid (matches Materials)
  const lnE = E.map(Math.log);
  const EREF = 60;                                     // HU calibration energy (≈ diagnostic effective keV)
  const waterMR = [0.8096,0.3756,0.2683,0.2269,0.2059,0.1837,0.1707,0.1614,0.1505]; // water (mu/rho)
  const boneMR  = [4.001, 1.331, 0.6655,0.4242,0.3148,0.2229,0.1855,0.1650,0.1480]; // cortical bone (mu/rho)
  // explicit mass-attenuation (cm^2/g) + density (g/cm^3) for non-tissue materials
  const ELEM = {
    air:      { rho:0.001205, mr:[0.7779,0.3538,0.2485,0.2080,0.1875,0.1662,0.1541,0.1456,0.1357] },
    aluminum: { rho:2.699, mr:[3.441,1.128,0.5685,0.3681,0.2778,0.2018,0.1704,0.1533,0.1385] },
    titanium: { rho:4.506, mr:[5.890,1.940,0.8983,0.5100,0.3339,0.1834,0.1314,0.1076,0.08765] },
    steel:    { rho:7.90,  mr:[25.70,8.176,3.629,1.958,1.205,0.5952,0.3717,0.2790,0.1964] },   // ~stainless (Fe)
    lead:     { rho:11.35, mr:[86.36,30.32,14.36,8.041,5.021,2.419,5.549,3.301,1.910] },        // K-edge ~88 keV
  };
  function interp(mr, keV){
    const x = Math.log(keV);
    if(x<=lnE[0]) return mr[0];
    if(x>=lnE[lnE.length-1]) return mr[mr.length-1];
    let i=0; while(x>lnE[i+1]) i++;
    const f=(x-lnE[i])/(lnE[i+1]-lnE[i]);
    return Math.exp(Math.log(mr[i])*(1-f)+Math.log(mr[i+1])*f);
  }
  const muWaterAt = (keV)=> interp(waterMR,keV);       // rho water = 1
  // water+bone basis densities that reproduce a target HU at EREF
  function basis(hu){
    const muw = muWaterAt(EREF);
    if(hu <= 120) return { dw: 1 + hu/1000, db: 0 };   // soft/fluid/fat/lung/muscle → water-scaled
    return { dw: 1.0, db: ((hu/1000)*muw) / interp(boneMR,EREF) };   // calcified → add cortical bone
  }
  function muTissue(hu, keV){ const b=basis(hu); return b.dw*interp(waterMR,keV) + b.db*interp(boneMR,keV); }
  function muElem(key, keV){ const m=ELEM[key]; return interp(m.mr,keV)*m.rho; }

  // ---- material legend (index = voxel id). hu is the nominal/clinical value; the
  // physics uses the derived mu(E). Colours drive the 3D organ rendering. ----
  const LIST = [
    { id:0,  name:'Air',              hu:-1000, kind:'elem',   key:'air',  color:0x000000 },
    { id:1,  name:'Lung',             hu:-700,  kind:'tissue',             color:0x3a4a63 },
    { id:2,  name:'Fat',              hu:-90,   kind:'tissue',             color:0xf2e2b0 },
    { id:3,  name:'Water',            hu:0,     kind:'tissue',             color:0x2f6fb0 },
    { id:4,  name:'Cerebrospinal fluid', hu:12, kind:'tissue',            color:0x4a90c0 },
    { id:5,  name:'Simple fluid',     hu:10,    kind:'tissue',             color:0x3f80b8 },
    { id:6,  name:'Bile',             hu:20,    kind:'tissue',             color:0x6b8e23 },
    { id:7,  name:'Muscle',           hu:45,    kind:'tissue',             color:0x9e4b4b },
    { id:8,  name:'Blood',            hu:45,    kind:'tissue',             color:0xb23a3a },
    { id:9,  name:'Clotted blood',    hu:75,    kind:'tissue',             color:0x7a2222 },
    { id:10, name:'Soft tissue',      hu:40,    kind:'tissue',             color:0xc07a6a },
    { id:11, name:'Liver',            hu:60,    kind:'tissue',             color:0x8a4b32 },
    { id:12, name:'Spleen',           hu:50,    kind:'tissue',             color:0x6d3b52 },
    { id:13, name:'Kidney',           hu:40,    kind:'tissue',             color:0x9c5a3c },
    { id:14, name:'Pancreas',         hu:40,    kind:'tissue',             color:0xc9a15a },
    { id:15, name:'Heart / myocardium', hu:45,  kind:'tissue',            color:0xa83232 },
    { id:16, name:'Cartilage',        hu:110,   kind:'tissue',             color:0xcfd8e0 },
    { id:17, name:'Trabecular bone',  hu:300,   kind:'tissue',             color:0xe8dfc0 },
    { id:18, name:'Cortical bone',    hu:1200,  kind:'tissue',             color:0xfaf3dc },
    { id:19, name:'Tooth enamel',     hu:2500,  kind:'tissue',             color:0xffffff },
    { id:20, name:'Iodine contrast',  hu:350,   kind:'tissue',             color:0xffd24d },
    { id:21, name:'Calcification',    hu:600,   kind:'tissue',             color:0xf0ead2 },
    { id:22, name:'Kidney stone',     hu:800,   kind:'tissue',             color:0xd8cba0 },
    { id:23, name:'Skin',             hu:30,    kind:'tissue',             color:0xd8a07a },
    { id:24, name:'Aluminum',         hu:null,  kind:'elem',   key:'aluminum', color:0x9fb4c0 },
    { id:25, name:'Titanium',         hu:null,  kind:'elem',   key:'titanium', color:0xb8c2cc },
    { id:26, name:'Stainless steel',  hu:null,  kind:'elem',   key:'steel',    color:0xd0d4d8 },
    { id:27, name:'Lead',             hu:null,  kind:'elem',   key:'lead',     color:0x6a6f77 },
  ];
  const idByName = {}; LIST.forEach(m=> idByName[m.name]=m.id);

  function muById(id, keV){ const m = LIST[id] || LIST[0]; return m.kind==='elem' ? muElem(m.key,keV) : muTissue(m.hu,keV); }
  function muByName(name, keV){ return muById(idByName[name] ?? 0, keV); }
  // HU of a material at the reference energy (metals come out very large by design)
  function huOf(id){ const muw = muWaterAt(EREF); return Math.round(1000*(muById(id,EREF)-muw)/muw); }

  return {
    E, LIST, idByName, EREF,
    muById, muByName, huOf,
    muWater: (keV)=> muWaterAt(keV),                    // cm^-1 (rho water = 1) — HU reference for recon
    count: LIST.length,
  };
})();

