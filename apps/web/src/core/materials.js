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
  function interp(mr, keV, grid){
    const g = grid || lnE;
    const x = Math.log(keV);
    if(x<=g[0]) return mr[0];
    if(x>=g[g.length-1]) return mr[mr.length-1];
    let i=0; while(x>g[i+1]) i++;
    const f=(x-g[i])/(g[i+1]-g[i]);
    return Math.exp(Math.log(mr[i])*(1-f)+Math.log(mr[i+1])*f);
  }
  const muWaterAt = (keV)=> interp(waterMR,keV);       // rho water = 1

  /* ---- iodine: its own energy grid, because of the K-edge -------------------
     Iodine's K absorption edge sits at 33.17 keV, where mu/rho jumps ~4x (8.86 ->
     35.7 cm^2/g). That discontinuity is the whole reason iodine works as a contrast
     agent and the reason low kVp boosts it: drop the tube from 120 to 80 kVp and the
     spectrum shifts toward the edge, roughly doubling HU per mgI/mL. The shared 9-point
     grid straddles the edge between 30 and 40 keV, so log-log interpolation across it
     would draw a smooth ramp and erase the effect. Iodine therefore carries its own
     grid with the edge bracketed by two points 0.01 keV apart.
     Values are NIST XCOM (total with coherent), cm^2/g. */
  const IODINE_E  = [20, 25, 30, 33.16, 33.18, 40, 50, 60, 80, 100, 120, 150];
  const IODINE_MR = [34.4, 18.8, 11.6, 8.86, 35.7, 22.4, 12.3, 7.60, 3.55, 2.05, 1.39, 0.848];
  const lnIodineE = IODINE_E.map(Math.log);
  // Linear attenuation (cm^-1) contributed by ONE mgI/mL of iodine in solution.
  // 1 mgI/mL = 1 mg/cm^3 = 1e-3 g/cm^3, so mu = (mu/rho) * 1e-3.
  // Sanity: at 70 keV (the effective energy of a 120 kVp beam) this gives 26.7 HU per
  // mgI/mL against water, which is the textbook ~25-26.
  function muIodinePerConc(keV){ return interp(IODINE_MR, keV, lnIodineE) * 1e-3; }

  /* ---- barium: the same story one shell up ---------------------------------
     Barium (Z=56) K-edge is at 37.44 keV, and the jump is if anything sharper than
     iodine's — which is why a barium study works at all at diagnostic kVp, and why
     barium is opaque where iodine is merely bright.

     The agent is barium SULPHATE, BaSO4, given as a suspension quoted in % w/v: a
     "100 % w/v" barium is 1 g of BaSO4 per mL. BaSO4 is 58.84 % barium by mass
     (137.33 / 233.39), so the concentration carried here is mg of ELEMENTAL Ba per mL,
     with the sulphate's own contribution folded in via the compound curve below.

     Grid straddles the edge with two points 0.02 keV apart, exactly as iodine's does —
     interpolating across a K-edge on the shared 9-point grid would draw a smooth ramp
     through the discontinuity and erase the effect that makes the agent work.

     CAVEAT, and it matters before anyone quotes an absolute barium HU: unlike the iodine
     row above, this grid has NOT been checked point by point against NIST XCOM. It is a
     literature reconstruction, and the 40 keV point is an E^-3 extrapolation from the
     measured post-edge value rather than a tabulated one. What IS sound is the part the
     teaching rests on — the edge sits at 37.44 keV and the jump ratio comes out at 5.42
     against a literature Ba value of ~5.3-5.5. Verify the row before trusting the numbers. */
  const BARIUM_E  = [20, 25, 30, 35, 37.43, 37.45, 40, 50, 60, 80, 100, 120, 150];
  const BARIUM_MR = [24.9, 13.9, 8.60, 5.71, 4.87, 26.4, 21.7, 12.6, 7.90, 3.83, 2.20, 1.48, 0.900];
  const lnBariumE = BARIUM_E.map(Math.log);
  // Linear attenuation (cm^-1) per ONE mg of elemental Ba per mL.
  function muBariumPerConc(keV){ return interp(BARIUM_MR, keV, lnBariumE) * 1e-3; }
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
    { id:28, name:'Acrylic',          hu:120,   kind:'tissue',                 color:0x9fb6a8 },
    // ---- named vessels (29+) ------------------------------------------------
    // One id per great vessel, because the contrast simulation has to know WHICH vessel a
    // voxel belongs to — the aorta and the SVC opacify ~15 s apart and a single 'Blood' id
    // cannot express that. All carry blood's 45 HU, so an unenhanced scan is unchanged;
    // only the contrast layer distinguishes them. MUST stay in lockstep with
    // build_model.py VESSELS (id, order and name) — see scripts/check-legends.mjs.
    { id:29, name:'Aorta',                 hu:45, kind:'tissue', color:0xb23a3a },
    { id:30, name:'Pulmonary artery',      hu:45, kind:'tissue', color:0xb23a3a },
    { id:31, name:'Pulmonary vein',        hu:45, kind:'tissue', color:0xb23a3a },
    { id:32, name:'Superior vena cava',    hu:45, kind:'tissue', color:0xb23a3a },
    { id:33, name:'Inferior vena cava',    hu:45, kind:'tissue', color:0xb23a3a },
    { id:34, name:'Portal / splenic vein', hu:45, kind:'tissue', color:0xb23a3a },
    { id:35, name:'Brachiocephalic trunk', hu:45, kind:'tissue', color:0xb23a3a },
    { id:36, name:'Subclavian artery R',   hu:45, kind:'tissue', color:0xb23a3a },
    { id:37, name:'Subclavian artery L',   hu:45, kind:'tissue', color:0xb23a3a },
    { id:38, name:'Common carotid R',      hu:45, kind:'tissue', color:0xb23a3a },
    { id:39, name:'Common carotid L',      hu:45, kind:'tissue', color:0xb23a3a },
    { id:40, name:'Brachiocephalic vein R',hu:45, kind:'tissue', color:0xb23a3a },
    { id:41, name:'Brachiocephalic vein L',hu:45, kind:'tissue', color:0xb23a3a },
    { id:42, name:'Left atrial appendage', hu:45, kind:'tissue', color:0xb23a3a },
    { id:43, name:'Iliac artery R',        hu:45, kind:'tissue', color:0xb23a3a },
    { id:44, name:'Iliac artery L',        hu:45, kind:'tissue', color:0xb23a3a },
    { id:45, name:'Iliac vein R',          hu:45, kind:'tissue', color:0xb23a3a },
    { id:46, name:'Iliac vein L',          hu:45, kind:'tissue', color:0xb23a3a },
    // ---- GI tract (47+) -----------------------------------------------------
    // Same argument as the vessels: a barium study has to know WHICH part of the gut a
    // voxel is in, because the whole examination is watching the agent move from one part
    // to the next. A single 'Soft tissue' id cannot express a swallow.
    //
    // The lumen ids are stamped ONLY where the segmentation says gut AND the HU says
    // fluid/soft. Where the lumen holds gas it gets id 47 instead, which matters more than
    // it sounds: the gastric bubble, the colonic gas and the fluid levels are real
    // findings, and stamping one fixed HU across a whole labelled stomach would erase
    // them. It is also more honest than what happened before, where bowel gas fell through
    // the HU thresholds and was classified as LUNG.
    //
    // Id 47 is what CO2 insufflation fills in a double-contrast study.
    // MUST stay in lockstep with build_model.py LEGEND — see scripts/check-legends.mjs.
    { id:47, name:'Bowel gas',        hu:-1000, kind:'elem', key:'air', color:0x1b2129 },
    { id:48, name:'Oesophagus lumen', hu:15,    kind:'tissue',          color:0xc98f6a },
    { id:49, name:'Stomach lumen',    hu:15,    kind:'tissue',          color:0xb97f4e },
    { id:50, name:'Duodenum lumen',   hu:15,    kind:'tissue',          color:0xc59a5e },
    { id:51, name:'Small bowel lumen',hu:15,    kind:'tissue',          color:0xd0a86a },
    { id:52, name:'Colon lumen',      hu:15,    kind:'tissue',          color:0xa8804e },
    // Mammography (docs/mammography.md): fibroglandular tissue. Its HU barely differs
    // from other soft tissue — the whole point of the mammographic beam is that at
    // 26-32 kV the photoelectric term still separates it from fat.
    { id:53, name:'Glandular',        hu:40,    kind:'tissue',          color:0xe4c9b0 },
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
    // ---- iodine as a virtual material column --------------------------------
    // Contrast is not a material a voxel can BE — it is a concentration a voxel can
    // CARRY, varying continuously in space and time. So it rides as one extra column
    // past the end of the legend: the tracer accumulates concentration-weighted path
    // length (cm x mgI/mL) into it, and this row of mu (cm^-1 per mgI/mL) turns that
    // into optical depth. Both engines already compute L @ mu, so neither integration
    // loop changes — and an unenhanced scan puts zero in the column and is untouched.
    IODINE_COL: LIST.length,
    muIodinePerConc,
    // HU per mgI/mL at a given energy — the energy dependence a fixed constant cannot show
    huPerMgIml: (keV)=> 1000 * muIodinePerConc(keV) / muWaterAt(keV),
    // Barium rides in a second virtual column, for the same reason and by the same
    // mechanism. Two columns rather than one shared "contrast" column because the agents
    // have different K-edges (33.17 vs 37.44 keV) and a GI study can have both present at
    // once — an enteric barium with IV iodine is an ordinary abdominal CT.
    BARIUM_COL: LIST.length + 1,
    muBariumPerConc,
    huPerMgBaMl: (keV)=> 1000 * muBariumPerConc(keV) / muWaterAt(keV),
    // Length of a path-length vector: the legend plus one column per agent. Everything that
    // allocates or indexes one uses this rather than counting, so adding a third agent later
    // is one line here instead of a hunt through the tracer and both mu tables.
    TRACE_LEN: LIST.length + 2,
  };
})();

