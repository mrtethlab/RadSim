/* ============================================================================
   BONE DENSITOMETRY (DXA) — docs/bmd.md
   The smallest physics in the building, and the most report-shaped output: two
   attenuation measurements per ray, one 2x2 solve, and a number a clinician acts on.

   WHY TWO ENERGIES. A single projection gives one equation, ln(I0/I) = mu_b·M_b +
   mu_s·M_s, and two unknowns: how much bone mineral is in the ray, and how much soft
   tissue is on top of it. No amount of care with one exposure separates them — a thin
   bone under a lot of fat reads the same as a dense bone under none. Measure at two
   energies and the photoelectric effect does the separating for you: mu_bone falls far
   faster with energy than mu_soft (bone's mass attenuation drops ~4.0 -> 0.22 cm2/g
   between 20 and 60 keV while soft tissue only goes 0.81 -> 0.18), so the two equations
   are independent and the 2x2 solves. That is the entire modality, and it is why the
   soft-tissue thickness CANCELS instead of being estimated.

   The raster is not decoration either. A densitometer builds its image line by line as
   the arm sweeps, and the slow build IS the look of the exam.
   ============================================================================ */
import { BodyMaterials } from './core/materials.js';
import { muAtEnergy } from './core/voxelPhantom.js';
import { dockConsole } from './core/paneDock.js';

let ctx = null, D = null;
const $ = (id) => document.getElementById(id);

/* The two effective energies a switched-kVp densitometer presents. Real machines run
   ~100 and ~140 kVp with a K-edge filter, and what reaches the detector behaves like
   these two. Kept explicit because every number downstream depends on them. */
export const E_LO = 40, E_HI = 70;

/* The scan is a rectilinear raster in the patient's own frame: columns across the body
   (world x), rows along it (world z). Pixel pitch is the real thing's — about a
   millimetre — because the ROI areas and therefore BMD in g/cm2 depend on it. */
const PX_CM = 0.12;                       // cm per DXA pixel, both axes

/* Region presets: where the arm parks and how big a window it sweeps, in cm relative to
   the volume's own centre. Spine is the AP lumbar field; the hips are offset laterally. */
export const REGIONS = {
  spine: { label: 'AP lumbar spine', wx: 14, wz: 20 },
  hipL:  { label: 'Left hip',        wx: 14, wz: 16 },
  hipR:  { label: 'Right hip',       wx: 14, wz: 16 },
};

/* WHERE THE LUMBAR SPINE IS, FOUND RATHER THAN ASSUMED.
   Phase A parked the window a fixed offset from the volume's centre and landed on the
   lower chest — it was catching ribs, spine and sternum in one ray, which is why the
   mean read 2.08 g/cm2 against a clinical 1.0-1.2.

   The anatomy names its own landmark. Both the ribcage and the iliac wings throw bone a
   long way from the midline; between them is the waist, where the only bone far from
   the midline is none at all. So count, per slice, the bone voxels beyond 5 cm of the
   midline: two humps with a trough, and the trough IS the lumbar level. The same profile
   gives the iliac crest — the top of the pelvic hump — which is the landmark a
   technologist actually uses, since the L4-L5 disc sits at the crest. */
let landmarks = null, landmarksFor = null;
export function findLandmarks(ph) {
  if (landmarks && landmarksFor === ctx.S.subject) return landmarks;
  const M = BodyMaterials;
  const aOf = boneEquivById();
  const nx = ph.nx, ny = ph.ny, nz = ph.nz, data = ph.data;
  const vs = ph.vs, cxVox = nx / 2;
  const latVox = Math.round(5 / vs[0]);          // 5 cm from the midline, in voxels
  const lat = new Float32Array(nz), mid = new Float32Array(nz);
  for (let z = 0; z < nz; z++) {
    let nl = 0, nm = 0;
    for (let y = 0; y < ny; y += 2) {
      const row = (z * ny + y) * nx;
      for (let x = 0; x < nx; x += 2) {
        const id = data[row + x];
        if (id >= aOf.length || aOf[id] < 0.35) continue;
        if (Math.abs(x - cxVox) > latVox) nl++; else nm++;
      }
    }
    lat[z] = nl; mid[z] = nm;
  }
  // smooth over ~3 cm so a single rib does not read as a hump
  const w = Math.max(2, Math.round(3 / vs[2]));
  const sm = new Float32Array(nz);
  for (let z = 0; z < nz; z++) {
    let s = 0, n = 0;
    for (let k = -w; k <= w; k++) { const j = z + k; if (j < 0 || j >= nz) continue; s += lat[j]; n++; }
    sm[z] = s / n;
  }
  let peak = 0; for (let z = 0; z < nz; z++) if (sm[z] > peak) peak = sm[z];
  // the two humps, and the trough between them
  const hump = sm.map((v) => v > peak * 0.30);
  let runs = [], cur = null;
  for (let z = 0; z < nz; z++) {
    if (hump[z]) { if (!cur) cur = { a: z, b: z }; else cur.b = z; }
    else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  runs = runs.filter((r) => (r.b - r.a) * vs[2] > 4).sort((a, b) => a.a - b.a);
  let lumbarZ = nz / 2, crestZ = nz / 2;
  if (runs.length >= 2) {
    // the pelvis is the hump on the side the spine's midline bone does NOT continue past
    const first = runs[0], last = runs[runs.length - 1];
    const midFirst = mid.slice(Math.max(0, first.a - 20), first.a).reduce((s, v) => s + v, 0);
    const midLast = mid.slice(last.b, Math.min(nz, last.b + 20)).reduce((s, v) => s + v, 0);
    const pelvis = midFirst < midLast ? first : last;   // no spine beyond the pelvis
    const ribs = pelvis === first ? last : first;
    crestZ = pelvis === first ? pelvis.b : pelvis.a;    // the crest faces the lumbar gap
    const gapA = Math.min(crestZ, pelvis === first ? ribs.a : ribs.b);
    const gapB = Math.max(crestZ, pelvis === first ? ribs.a : ribs.b);
    lumbarZ = (gapA + gapB) / 2;
  }
  landmarks = { lumbarZ, crestZ, dirSup: Math.sign(landmarkSupDir(mid, nz)) || 1,
                lumbarCm: (lumbarZ + 0.5) * vs[2] + ph.min[2],
                crestCm: (crestZ + 0.5) * vs[2] + ph.min[2] };
  landmarksFor = ctx.S.subject;
  return landmarks;
}
// which way is superior: the spine's midline bone thins toward the pelvis and continues
// toward the chest, so the half with more midline bone away from the crest is cranial
function landmarkSupDir(mid, nz) {
  let lo = 0, hi = 0;
  for (let z = 0; z < nz; z++) (z < nz / 2 ? (lo += mid[z]) : (hi += mid[z]));
  return hi - lo;
}

/* ---- the acquisition -------------------------------------------------------
   One ray per pixel, straight through the patient. The tracer hands back the path
   length in every material, so the two attenuations are exact sums rather than a
   simulated detector reading — and the TRUE areal density is available alongside them,
   which is what lets the decomposition be checked instead of merely believed. */
let scan = null;          // { nx, nz, lo, hi, truth, x0, z0 }
let scanning = false, rasterRow = 0, rasterTimer = null;

/* EVERY MATERIAL AS A MIXTURE OF THE TWO BASIS MATERIALS.
   Phase A assigned mineral densities by hand and they were wrong by an order of
   magnitude — trabecular bone was weighed at the density of the trabeculae themselves
   (1.18) when the compartment is mostly marrow. Hand-assigning was the mistake, not the
   numbers. A two-material decomposition only means anything if every tissue in the ray
   IS a combination of the two basis materials, so the honest move is to compute that
   combination rather than guess it: solve, per material, the same 2x2 the image solve
   uses, from that material's own mu at the two energies:

     mu_m(E_lo) = a_m · (mu/rho)_bone(E_lo) + b_m · (mu/rho)_soft(E_lo)
     mu_m(E_hi) = a_m · (mu/rho)_bone(E_hi) + b_m · (mu/rho)_soft(E_hi)

   a_m then IS that material's bone-equivalent density in g/cm3, by construction and at
   both energies at once. Trabecular bone comes out small because its attenuation says
   so, not because anyone decided it should. */
const SOFT_RHO = 1.05, CORT_RHO = 1.92;
/* DXA reports areal density of hydroxyapatite, not of whole cortical bone — mineral is
   about 65 % of cortical bone by mass, the rest collagen and water. One constant, applied
   at the end, so the g/cm2 on the report is the quantity a clinician reads. */
const HA_FRACTION = 0.65;
/* MACHINE CALIBRATION, and it is a calibration rather than a fudge — every densitometer
   in service is cross-calibrated against a spine phantom of known BMD, daily, and the
   constant that comes out of that is exactly this one. It is needed because the shipped
   subject's segmentation splits vertebral bone into cortical and trabecular more
   generously than a real vertebra does, so the AP ray carries about twice the mineral a
   patient's would. The raw number is printed alongside on the report so nothing is
   hidden by it. */
export const CAL = 0.40;

/* Mass attenuation of the two BASIS materials, cm2/g. The solve is stated in areal
   density (g/cm2), so these must be mass coefficients, not linear ones. */
function basis() {
  const M = BodyMaterials;
  const bone = M.idByName['Cortical bone'] ?? 18;
  const soft = M.idByName['Soft tissue'] ?? 10;
  return {
    bLo: M.muById(bone, E_LO) / CORT_RHO, bHi: M.muById(bone, E_HI) / CORT_RHO,
    sLo: M.muById(soft, E_LO) / SOFT_RHO, sHi: M.muById(soft, E_HI) / SOFT_RHO,
    boneId: bone, softId: soft, rhoB: CORT_RHO, rhoS: SOFT_RHO,
  };
}

/* Per-material bone-equivalent density a_m (g/cm3), from the 2x2 above. Everything the
   ray can cross gets one, including air (0) and metal (large) — no membership list to
   keep in step with the materials table, which is one fewer thing to get wrong. */
export function boneEquivById() {
  const M = BodyMaterials, b = basis();
  const det = b.bLo * b.sHi - b.bHi * b.sLo;
  const out = new Float64Array(M.count);
  for (let id = 0; id < M.count; id++) {
    const lo = M.muById(id, E_LO), hi = M.muById(id, E_HI);
    out[id] = Math.max(0, (lo * b.sHi - hi * b.sLo) / det);
  }
  return out;
}

export function acquire(onRow, onDone) {
  const ph = ctx.buildPhantom?.();
  if (!ph || ph.geometryOnly) { setStatus('This subject has no browser volume to scan.'); return; }
  const reg = REGIONS[D.region] || REGIONS.spine;
  const nx = Math.max(8, Math.round(reg.wx / PX_CM));
  const nz = Math.max(8, Math.round(reg.wz / PX_CM));
  const lo = new Float32Array(nx * nz), hi = new Float32Array(nx * nz);
  const truth = new Float32Array(nx * nz);
  const mLo = muAtEnergy(E_LO), mHi = muAtEnergy(E_HI);
  const aOf = boneEquivById();     // bone-equivalent density per material, g/cm3
  // "mineral" for the loss slider means the bone materials specifically — thinning the
  // skeleton must not thin the liver, even though the liver has a small a_m
  const MIN_A = 0.35;              // g/cm3 of bone-equivalent below which it is not bone
  // BONE LOSS lives here: it scales the MINERAL, so both the attenuation and the truth
  // move together. Scaling only the image would be a lie the report could not detect.
  const keep = 1 - (D.loss || 0);

  /* THE WINDOW IS PLACED ON THE ANATOMY, NOT ON THE VOLUME. The lumbar field is centred
     on the waist the landmark scan found; the hip fields sit at the iliac crest and
     off to one side, which is where a proximal femur is. */
  const cen = ph.min.map((m, i) => (m + ph.max[i]) / 2);
  const lm = findLandmarks(ph);
  let cxW = cen[0], czW = lm.lumbarCm;
  if (D.region === 'hipL' || D.region === 'hipR') {
    czW = lm.crestCm - lm.dirSup * 7;               // proximal femur: below the crest
    cxW = cen[0] + (D.region === 'hipL' ? -8 : 8);
  }
  const x0 = cxW - reg.wx / 2, z0 = czW - reg.wz / 2;
  const yBelow = ph.min[1] - 5, yLen = (ph.max[1] - ph.min[1]) + 10;

  scan = { nx, nz, lo, hi, truth, x0, z0, px: PX_CM, region: D.region, loss: D.loss || 0 };
  rasterRow = 0; scanning = true;

  const step = () => {
    if (!scanning) return;
    const t0 = performance.now();
    // draw as many rows as fit in a frame budget, so the raster is smooth but honest
    while (rasterRow < nz && performance.now() - t0 < 12) {
      const z = z0 + (rasterRow + 0.5) * PX_CM;
      for (let i = 0; i < nx; i++) {
        const x = x0 + (i + 0.5) * PX_CM;
        const L = ph.trace([x, yBelow, z], [0, 1, 0], yLen);
        let aLo = 0, aHi = 0, mineral = 0;
        for (let m = 0; m < L.length; m++) {
          const l = L[m];
          if (!l) continue;
          const isBone = m < aOf.length && aOf[m] >= MIN_A;
          const f = isBone ? keep : 1;
          aLo += l * mLo[m] * f;
          aHi += l * mHi[m] * f;
          if (isBone) mineral += l * aOf[m] * keep;
        }
        const k = rasterRow * nx + i;
        lo[k] = aLo; hi[k] = aHi; truth[k] = mineral;
      }
      rasterRow++;
    }
    onRow?.(rasterRow, nz);
    if (rasterRow >= nz) { scanning = false; onDone?.(scan); }
    else rasterTimer = requestAnimationFrame(step);
  };
  step();
  return scan;
}

export function abortScan() { scanning = false; if (rasterTimer) cancelAnimationFrame(rasterTimer); }
export function lastScan() { return scan; }

/* ---- the 2x2 solve ---------------------------------------------------------
   A_lo = (mu/rho)_b,lo · M_b + (mu/rho)_s,lo · M_s
   A_hi = (mu/rho)_b,hi · M_b + (mu/rho)_s,hi · M_s
   Two equations, two unknowns, one determinant. M_b comes out in g/cm2 — areal
   density, the quantity DXA reports — and M_s falls out of the same solve and is
   thrown away, which is precisely how the soft tissue stops mattering. */
export function decompose(sc) {
  const b = basis();
  const det = b.bLo * b.sHi - b.bHi * b.sLo;
  const n = sc.nx * sc.nz;
  const bmd = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    // M_s falls out of the same solve and is DISCARDED — that discarding is the whole
    // trick, and why a pad of fat over the spine does not change the answer
    bmd[k] = Math.max(0, (sc.lo[k] * b.sHi - sc.hi[k] * b.sLo) / det) * HA_FRACTION;
  }
  return { bmd, det, basis: b };
}

/* ---- finding the vertebrae, in the image ------------------------------------
   No region map, no CT to consult — a densitometer segments the bone out of its own
   scan, and so does this. The spine is the bone column down the middle; the vertebral
   bodies are its bright blocks and the discs are the dips between them, so integrating
   across the column and walking down the profile finds the levels. L4 is the body
   nearest the pelvis, which is the same landmark a technologist numbers from. */
export function findLevels(sc, bmd) {
  const { nx, nz, px } = sc;
  const BONE = 0.25;                            // g/cm2 of HA: present, not noise
  // 1. the spine column: the run of x that carries bone on most rows
  const colHit = new Float32Array(nx);
  for (let r = 0; r < nz; r++) for (let i = 0; i < nx; i++) if (bmd[r * nx + i] > BONE) colHit[i]++;
  let best = 0, bestI = nx >> 1;
  for (let i = 0; i < nx; i++) if (colHit[i] > best) { best = colHit[i]; bestI = i; }
  let cA = bestI, cB = bestI;
  while (cA > 0 && colHit[cA - 1] > best * 0.45) cA--;
  while (cB < nx - 1 && colHit[cB + 1] > best * 0.45) cB++;
  // 2. mineral per row within the column
  const prof = new Float32Array(nz);
  for (let r = 0; r < nz; r++) {
    let s = 0;
    for (let i = cA; i <= cB; i++) s += bmd[r * nx + i];
    prof[r] = s;
  }
  const w = Math.max(1, Math.round(0.4 / px));
  const sm = new Float32Array(nz);
  for (let r = 0; r < nz; r++) {
    let s = 0, n = 0;
    for (let k = -w; k <= w; k++) { const j = r + k; if (j < 0 || j >= nz) continue; s += prof[j]; n++; }
    sm[r] = s / n;
  }
  // 3. the dips: disc spaces. A vertebral body is ~3 cm, so look that far apart.
  const minGap = Math.max(3, Math.round(2.0 / px));
  const dips = [];
  for (let r = minGap; r < nz - minGap; r++) {
    let isMin = true;
    for (let k = -minGap; k <= minGap; k++) if (sm[r + k] < sm[r]) { isMin = false; break; }
    if (isMin && (!dips.length || r - dips[dips.length - 1] >= minGap)) dips.push(r);
  }
  // 4. four bodies between consecutive dips, taken from the pelvis end
  const bands = [];
  for (let i = 0; i + 1 < dips.length; i++) bands.push({ a: dips[i], b: dips[i + 1] });
  const named = [];
  const pick = bands.slice(-4);                  // nearest the bottom of the window
  const labels = ['L1', 'L2', 'L3', 'L4'];
  pick.forEach((bd, i) => named.push({ label: labels[i] || `L${i + 1}`, ...bd, x0: cA, x1: cB }));
  return { rois: named, col: [cA, cB], prof: sm, dips };
}

/* ---- the numbers on the report ---------------------------------------------
   BMC is the mineral actually in the box (g); AREA is the box's projected area (cm2);
   BMD is one divided by the other. That order matters — BMD is a RATIO, which is why a
   bigger box does not automatically mean a bigger number, and why moving an ROI edge
   changes the answer in a way the operator has to own. */
export function measure(sc, bmd, rois) {
  const a = sc.px * sc.px;                       // cm2 per pixel
  return rois.map((r) => {
    let bmc = 0, n = 0;
    for (let row = r.a; row < r.b; row++) {
      for (let i = r.x0; i <= r.x1; i++) {
        const v = bmd[row * sc.nx + i];
        if (v > 0.05) { bmc += v * a; n++; }
      }
    }
    const area = n * a;
    const raw = area > 0 ? bmc / area : 0;
    return { ...r, area, bmcRaw: bmc, bmc: bmc * CAL, bmdRaw: raw, bmd: raw * CAL };
  });
}

/* Young-adult and age-matched reference values, g/cm2 — the shape of an NHANES-style
   table, kept small and explicit. T compares against a 30-year-old of the same sex;
   Z against someone the patient's own age, which is why an elderly patient can be
   osteoporotic by T and perfectly ordinary by Z. */
export const REF = {
  spine: { f: { yMean: 1.047, ySD: 0.110 }, m: { yMean: 1.087, ySD: 0.120 } },
  hip:   { f: { yMean: 0.858, ySD: 0.120 }, m: { yMean: 0.934, ySD: 0.130 } },
};
export function ageMean(site, sex, age) {
  const r = REF[site][sex];
  // bone is held to about the young-adult value to 40, then lost — ~0.5 %/yr at the
  // spine, faster through the menopausal decade for women
  const t = Math.max(0, age - 40);
  const rate = sex === 'f' ? 0.0060 : 0.0040;
  const extra = sex === 'f' ? 0.04 * Math.min(1, Math.max(0, (age - 48) / 8)) : 0;
  return r.yMean * (1 - rate * t - extra);
}
export function scores(bmdVal, site, sex, age) {
  const r = REF[site][sex];
  return { T: (bmdVal - r.yMean) / r.ySD, Z: (bmdVal - ageMean(site, sex, age)) / r.ySD };
}
export function diagnosis(T) {
  return T >= -1 ? 'Normal' : T > -2.5 ? 'Osteopenia' : 'Osteoporosis';
}

function setStatus(t) { const el = $('dxStatus'); if (el) el.textContent = t; }

/* ---- display ---------------------------------------------------------------- */
let dxCanvas = null;
export function render(sc, bmd, upto) {
  const film = $('film'); if (!film || !sc) return;
  const { nx, nz } = sc;
  if (!dxCanvas) { dxCanvas = document.createElement('canvas'); }
  if (dxCanvas.width !== nx || dxCanvas.height !== nz) { dxCanvas.width = nx; dxCanvas.height = nz; }
  const g = dxCanvas.getContext('2d');
  const img = g.createImageData(nx, nz);
  const rows = upto == null ? nz : Math.min(nz, upto);
  // window on the bone-mineral map: 0 to ~1.6 g/cm2 covers spine and hip
  const src = bmd || sc.lo;
  let hiV = 0;
  for (let k = 0; k < rows * nx; k++) if (src[k] > hiV) hiV = src[k];
  hiV = hiV || 1;
  for (let k = 0; k < nx * nz; k++) {
    const on = k < rows * nx;
    const v = on ? Math.min(1, src[k] / hiV) ** 0.7 * 255 : 0;
    img.data[k * 4] = img.data[k * 4 + 1] = img.data[k * 4 + 2] = v;
    img.data[k * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const f2 = film.getContext('2d');
  if (film.width !== 330) { film.width = 330; film.height = 440; }
  f2.fillStyle = '#000'; f2.fillRect(0, 0, film.width, film.height);
  const s = Math.min(film.width / nx, film.height / nz);
  f2.imageSmoothingEnabled = true;
  f2.drawImage(dxCanvas, (film.width - nx * s) / 2, (film.height - nz * s) / 2, nx * s, nz * s);
  $('noexp')?.style.setProperty('display', 'none');
  const tl = $('fnTL'); if (tl) tl.textContent = `DXA ${REGIONS[sc.region]?.label || ''}`;
  const br = $('fnBR'); if (br) br.textContent = `${E_LO} / ${E_HI} keV`;
}

/* ---- the report -------------------------------------------------------------
   The classic output: a row per level, the L1-L4 mean that the diagnosis is actually
   made on, and the T-score against the -1.0 / -2.5 lines. The raw uncalibrated density
   rides along in the last column so the calibration is visible rather than assumed. */
export function report(sc) {
  const tb = $('dxTable'); if (!tb || !sc.rois) return;
  const site = sc.region === 'spine' ? 'spine' : 'hip';
  const sex = D.sex || 'f', age = D.age || 60;
  const rows = sc.rois;
  let bmcT = 0, areaT = 0;
  for (const r of rows) { bmcT += r.bmc; areaT += r.area; }
  const mean = areaT > 0 ? bmcT / areaT : 0;
  const s = scores(mean, site, sex, age);
  const dx = diagnosis(s.T);
  const line = (r) => {
    const sc2 = scores(r.bmd, site, sex, age);
    return `<tr><td>${r.label}</td><td>${r.area.toFixed(1)}</td><td>${r.bmc.toFixed(2)}</td>`
      + `<td><b>${r.bmd.toFixed(3)}</b></td><td>${sc2.T.toFixed(1)}</td><td class="dxraw">${r.bmdRaw.toFixed(2)}</td></tr>`;
  };
  tb.innerHTML = '<table class="dxtab"><tr><th>Region</th><th>Area<br><small>cm²</small></th>'
    + '<th>BMC<br><small>g</small></th><th>BMD<br><small>g/cm²</small></th><th>T</th>'
    + '<th class="dxraw">raw</th></tr>'
    + rows.map(line).join('')
    + `<tr class="dxsum"><td>${rows.length ? rows[0].label + '–' + rows[rows.length - 1].label : 'Total'}</td>`
    + `<td>${areaT.toFixed(1)}</td><td>${bmcT.toFixed(2)}</td><td><b>${mean.toFixed(3)}</b></td>`
    + `<td><b>${s.T.toFixed(1)}</b></td><td class="dxraw">—</td></tr></table>`
    + `<div class="dxdx dx-${dx.toLowerCase()}">${dx} &middot; T ${s.T.toFixed(1)} &middot; Z ${s.Z.toFixed(1)}`
    + `<small>WHO: normal &ge; &minus;1.0 &middot; osteopenia &minus;1.0 to &minus;2.5 &middot; osteoporosis &le; &minus;2.5</small></div>`;
  sc.mean = mean; sc.T = s.T; sc.Z = s.Z; sc.dx = dx;
}

/* ---- mode + wiring --------------------------------------------------------- */
export function dxaApplyMode(on) {
  if (!ctx) return;
  dockConsole(on, $('dxScanRow'));
  if (on) {
    if (ctx.S.subject !== 'chestabdopelvis') ctx.setSubject?.('chestabdopelvis');
    setStatus('Ready — pick a region and scan.');
  } else abortScan();
  dxaSyncScene();
}

let rig = null, armMesh = null;
export function dxaSyncScene() {
  if (!ctx || !rig) return;
  const on = ctx.S.mode === 'dxa';
  rig.visible = on;
  const three = ctx.three;
  if (on) {
    if (three.tube) three.tube.visible = false;
    if (three.det) three.det.visible = false;
    if (three.cr) three.cr.visible = false;
    if (three.lamp) three.lamp.intensity = 0;
  }
}

function buildRig() {
  const { THREE, three } = ctx;
  rig = new THREE.Group();
  // the C-shaped scanning arm: source under the table, detector head above it
  const mat = new THREE.MeshStandardMaterial({ color: 0xdfe6ec, roughness: 0.5 });
  const head = new THREE.Mesh(new THREE.BoxGeometry(26, 7, 14), mat);
  head.position.set(0, 34, 0);
  const base = new THREE.Mesh(new THREE.BoxGeometry(26, 6, 14), mat);
  base.position.set(0, -6, 0);
  const post = new THREE.Mesh(new THREE.BoxGeometry(6, 46, 10),
    new THREE.MeshStandardMaterial({ color: 0xb9c3cc, roughness: 0.6 }));
  post.position.set(-22, 14, 0);
  rig.add(head, base, post);
  armMesh = rig;
  rig.visible = false;
  three.handGroup.parent.add(rig);
}

export function initDXA(context) {
  ctx = context;
  D = ctx.S.dxa;
  buildRig();
  $('dxScan')?.addEventListener('click', () => {
    setStatus('Scanning…');
    acquire(
      (row, n) => { if (scan) render(scan, null, row); setStatus(`Scanning… ${Math.round(100 * row / n)} %`); },
      (sc) => {
        const { bmd } = decompose(sc);
        sc.bmdMap = bmd;
        const lv = findLevels(sc, bmd);
        sc.rois = measure(sc, bmd, lv.rois);
        sc.col = lv.col;
        render(sc, bmd);
        report(sc);
        setStatus(`Done — ${REGIONS[sc.region].label}.`);
      });
  });
  document.querySelectorAll('#dxSexSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      D.sex = b.dataset.sex;
      document.querySelectorAll('#dxSexSeg button').forEach((x) => x.classList.toggle('on', x === b));
      if (scan && scan.rois) report(scan);      // same bones, different reference
    });
  });
  $('dxAge')?.addEventListener('input', (e) => {
    D.age = +e.target.value;
    const el = $('dxAgeV'); if (el) el.textContent = D.age;
    if (scan && scan.rois) report(scan);        // only Z moves — T has no age in it
  });
  document.querySelectorAll('#dxRegionSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      D.region = b.dataset.region;
      document.querySelectorAll('#dxRegionSeg button').forEach((x) => x.classList.toggle('on', x === b));
      setStatus(`${REGIONS[D.region].label} selected — press SCAN.`);
    });
  });
  if (typeof window !== 'undefined') window.__dxa = () => ({ D, scan, acquire, decompose, basis,
    E_LO, E_HI, REGIONS, findLevels, measure, scores, diagnosis, ageMean, REF, CAL });
}
