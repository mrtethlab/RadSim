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

  /* THE WINDOW IS WHERE THE OPERATOR PUT THE LASER. It used to be placed on the anatomy
     automatically, which meant the study could not be mispositioned and the pad would have
     been decoration. Now the field is built around the laser: the cross marks the INFERIOR
     edge of a spine sweep, because the lumbar scan starts at the ASIS and runs superiorly
     to T11, and marks the CENTRE of a hip field, which is how the femur window is set.
     Drive the arm to the wrong place and the wrong bones land in the window — which is the
     lesson. positionError() tells the console how far off it is. */
  const cen = ph.min.map((m, i) => (m + ph.max[i]) / 2);
  const lm = findLandmarks(ph);
  const spine = D.region === 'spine';
  const cxW = cen[0] + D.crossX;
  const czW = spine ? D.headZ + lm.dirSup * reg.wz / 2 : D.headZ;
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
  // HANGING. The raster walks world +z, which is the patient's head, so scan row 0 is the
  // most INFERIOR line and would land at the top of the canvas — the film upside down.
  // Column 0 is the most negative world x, which voxelFlips() leaves as the patient's LEFT,
  // and a DXA study is read like any AP film: the patient's right on the viewer's left.
  // So both axes are reversed on the way to the pixels. The scan arrays are untouched —
  // every measurement downstream still indexes them in acquisition order.
  for (let dy = 0; dy < nz; dy++) {
    const sy = nz - 1 - dy;                       // superior at the top
    const scanned = sy < rows;                    // so the raster now fills upward
    for (let dx = 0; dx < nx; dx++) {
      const sx = nx - 1 - dx;                     // patient's right to the viewer's left
      const v = scanned ? Math.min(1, src[sy * nx + sx] / hiV) ** 0.7 * 255 : 0;
      const k = dy * nx + dx;
      img.data[k * 4] = img.data[k * 4 + 1] = img.data[k * 4 + 2] = v;
      img.data[k * 4 + 3] = 255;
    }
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
  renderSerial();
}

/* ---- serial scans -----------------------------------------------------------
   The follow-up question is never "what is the density" but "has it changed", and the
   honest answer has to clear the machine's own reproducibility before it means anything.
   A real service quotes ~1 % least-significant-change at the spine; a change smaller
   than that is the machine, not the patient. So the table prints the % change AND says
   whether it clears that bar. */
export const LSC_PCT = 1.5;             // least significant change, % — the bar to clear
export function keepScan(sc) {
  if (!sc || !sc.rois) return;
  D.scans.unshift({ region: sc.region, mean: sc.mean, T: sc.T, Z: sc.Z, dx: sc.dx,
                    loss: sc.loss, when: D.scans.length });
  if (D.scans.length > 6) D.scans.length = 6;
  renderSerial();
}
export function renderSerial() {
  const el = $('dxSerial'); if (!el) return;
  const list = D.scans || [];
  if (!list.length) { el.innerHTML = '<div class="note">No stored scans. KEEP files the current one.</div>'; return; }
  const rows = list.map((s, i) => {
    const prev = list[i + 1];
    let chg = '—', cls = '';
    if (prev && prev.region === s.region) {
      const pc = 100 * (s.mean / prev.mean - 1);
      const sig = Math.abs(pc) >= LSC_PCT;
      chg = `${pc > 0 ? '+' : ''}${pc.toFixed(1)} %`;
      cls = sig ? (pc < 0 ? 'dxdown' : 'dxup') : 'dxflat';
      if (!sig) chg += ' *';
    }
    return `<tr><td>${REGIONS[s.region]?.label.split(' ').pop() || s.region}</td>`
      + `<td>${(100 * s.loss).toFixed(0)} %</td><td><b>${s.mean.toFixed(3)}</b></td>`
      + `<td>${s.T.toFixed(1)}</td><td class="${cls}">${chg}</td></tr>`;
  }).join('');
  el.innerHTML = '<table class="dxtab"><tr><th>Site</th><th>Loss</th><th>BMD</th><th>T</th>'
    + '<th>Change</th></tr>' + rows + '</table>'
    + `<div class="note" style="margin-top:6px">* below the ${LSC_PCT} % least significant `
    + 'change &mdash; that is the machine, not the patient.</div>';
}

/* ---- mode + wiring --------------------------------------------------------- */
export function dxaApplyMode(on) {
  if (!ctx) return;
  dockConsole(on, $('dxScanRow'));
  if (on) {
    if (ctx.S.subject !== 'chestabdopelvis') ctx.setSubject?.('chestabdopelvis');
    setStatus('Ready — pick a region and scan.');
    setTimeout(parkAtLandmark, 60);      // after the subject's volume is in place
  } else abortScan();
  dxaSyncScene();
}

const TABLE_LEN_CM = 200;             // the scanned table is a shade over 2 m end to end
let rig = null, armMesh = null, scannedRig = null, headHome = null, laser = null;
export function dxaSyncScene() {
  if (!ctx || !rig) return;
  const on = ctx.S.mode === 'dxa';
  // the scanned machine wins once it arrives; the boxes are only the fallback
  rig.visible = on && !scannedRig;
  if (scannedRig) scannedRig.visible = on;
  const three = ctx.three;
  if (!on) { dxaHideExtras(); return; }
  syncHead();
  // A densitometer carries its own source and detector inside the scanning arm, so none of
  // the radiographic room belongs in this scene. syncScene() re-shows that hardware every
  // frame, which is why this runs from there rather than only on the mode switch.
  if (three.tube) three.tube.visible = false;
  if (three.det) three.det.visible = false;
  if (three.detMarks) three.detMarks.visible = false;
  if (three.detArrow) three.detArrow.visible = false;
  if (three.aecGroup) three.aecGroup.visible = false;
  if (three.cr) three.cr.visible = false;
  if (three.lamp) three.lamp.intensity = 0;
}

/* Leaving the mode has to take the laser with it — it is parented to the room, not to the
   rig group, so that it can sit above the patient rather than inside the machine. */
export function dxaHideExtras() { if (laser) laser.visible = false; }

/* THE ROOM. A densitometer is a table with a scanning arm riding over it, and the arm is
   the only part that moves. The scanned machine (public/models/rigs/dxa_rig.glb) came off
   photogrammetry as one fused mesh of 50k triangles, so it was split offline the same way
   the OEC was: everything above y = 0.15 in the scan's own frame lies in x [-0.94, -0.58]
   — a narrow band at one end of the 2.0-long table — and spans the full width, which is a
   scanning arm and nothing else. That became the 'head' node (7 857 faces); the remaining
   42 143 are 'bed'. Both share one vertex buffer and one texture, so the split cost two
   index views.
   The box rig below it is the fallback if the fetch fails — the mode still has to work. */
const RIG_SPLIT_Y = 0.15;             // recorded so the offline split can be reproduced
const BED_TOP_LOCAL = -0.03;          // the patient surface, in the scan's own units
let bedNode = null, headNode = null, rigScale = 1, bedTopY = 0, bedLenCm = 0, headCentreHomeZ = 0;
/* Drive the arm and its laser to wherever the pad has put them. The head travels along the
   couch only; the laser's cross slides across the table independently, which is what the
   left/right keys on a real console do — they re-centre the measuring field, not the arm. */
function syncHead() {
  if (!headNode || !headHome) return;
  const { THREE } = ctx;
  /* headZ is where the LASER is, in cm along the couch, and the arm has to straddle it: the
     laser is projected from the head, so the two cannot drift apart. The scan's arm does not
     sit at the origin of its own frame — it is parked at one end of the table — so the head's
     home centre is measured once after load and subtracted here. Without that, headZ = 0 put
     the cross at the table's middle and the arm 65 cm away at the end of its rails.
     The node lives in the scan's frame, before the quarter turn that stands the table up,
     and that turn maps local +x onto world −z, so travel toward +z is NEGATIVE in x. */
  headNode.position.copy(headHome);
  headNode.position.x -= (D.headZ - headCentreHomeZ) / rigScale;
  if (laser) {
    laser.visible = true;
    laser.position.set(D.crossX, LASER_Y, D.headZ);
  }
}

/* WHERE THE ARM IS SUPPOSED TO BE. These are the landmarks a technologist actually uses,
   and the whole point of the pad is that getting them wrong costs you the study:
     AP lumbar spine — the laser sits 1 inch ABOVE the ASIS midline, and the arm sweeps
       from there superiorly to T11, so the field must contain L1-L4 with a slice of T12
       above and the iliac crest below to prove the level count.
     Proximal femur — 2 inches BELOW the greater trochanter, the laser on the midline of
       the femoral shaft, so the neck and trochanteric region both fall in the window.
   Both are expressed against landmarks found in the volume, not against table coordinates,
   so they follow the subject rather than assuming one. */
const INCH = 2.54;
function landmarkTargets() {
  // At boot there is no subject yet and buildPhantom() hands back an EMPTY phantom, which
  // is truthy — findLandmarks would then walk undefined dimensions and take the rest of
  // initDXA down with it. Check for real data, not just for an object.
  const ph = ctx.buildPhantom?.();
  if (!ph || !ph.data || !ph.nz) return null;
  let lm = null;
  try { lm = findLandmarks(ph); } catch { return null; }
  if (!lm) return null;
  if (D.region === 'spine') {
    // the crest scan gives the iliac crest; ASIS sits ~2 cm below it on this subject
    const asis = lm.crestCm - lm.dirSup * 2;
    return { z: asis + lm.dirSup * INCH, x: 0, label: '1 in above the ASIS midline' };
  }
  // greater trochanter is level with the crest minus ~7 cm on an adult femur
  const gt = lm.crestCm - lm.dirSup * 7;
  return { z: gt - lm.dirSup * 2 * INCH, x: D.region === 'hipL' ? -8 : 8,
    label: '2 in below the greater trochanter' };
}
/* How far the operator is from that mark, in cm — what the console reports back and what
   the scan field is built around. */
function positionError() {
  const t = landmarkTargets();
  if (!t) return null;
  return { dz: D.headZ - t.z, dx: D.crossX - t.x, target: t };
}
/* Selecting a region parks the arm on that region's landmark, the way pressing a preset on
   a real console drives it there. So the default study is correctly positioned, and driving
   OFF the mark — which the note calls out immediately — is the thing you do on purpose. */
function parkAtLandmark() {
  const t = landmarkTargets();
  if (!t) return;
  D.headZ = t.z; D.crossX = t.x;
  syncHead(); syncPad();
}
function nudge(dir) {
  const STEP = 1;                                  // cm per press, then repeat on hold
  if (dir === 'sup') D.headZ += STEP;
  else if (dir === 'inf') D.headZ -= STEP;
  else if (dir === 'left') D.crossX -= STEP;       // toward the patient's right
  else if (dir === 'right') D.crossX += STEP;
  D.headZ = Math.max(-TABLE_LEN_CM / 2, Math.min(TABLE_LEN_CM / 2, D.headZ));
  D.crossX = Math.max(-25, Math.min(25, D.crossX));
  syncHead(); syncPad();
}
/* The readouts, and the coaching line. It names the landmark rather than the number,
   because "5 cm inferior of the mark" is what a supervisor would actually say. */
function syncPad() {
  const hv = $('dxHeadV'); if (hv) hv.textContent = `${D.headZ.toFixed(0)} cm`;
  const cv = $('dxCrossV'); if (cv) cv.textContent = `${D.crossX.toFixed(0)} cm`;
  const note = $('dxPosNote'); if (!note) return;
  const e = positionError();
  if (!e) { note.textContent = 'Drive the arm over the region of interest.'; return; }
  const near = Math.abs(e.dz) <= 2 && Math.abs(e.dx) <= 2;
  if (near) {
    note.innerHTML = `<b style="color:#3fd07a">On the mark</b> &mdash; laser is at the `
      + `${e.target.label}. Scan will demonstrate the required anatomy.`;
    return;
  }
  const zs = Math.abs(e.dz) <= 2 ? '' :
    `${Math.abs(e.dz).toFixed(0)} cm ${e.dz > 0 ? 'superior' : 'inferior'} of the mark`;
  const xs = Math.abs(e.dx) <= 2 ? '' :
    `${Math.abs(e.dx).toFixed(0)} cm ${e.dx > 0 ? 'left' : 'right'} of the midline`;
  note.innerHTML = `<b style="color:#e8b552">Off the mark</b> &mdash; `
    + [zs, xs].filter(Boolean).join(', ') + `. Correct is the ${e.target.label}.`;
}

function buildRig() {
  const { THREE, three } = ctx;
  rig = new THREE.Group();
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
  buildLaser();
  loadScannedRig();
}

/* The centring laser: a thin cross projected on the patient, which is the only thing the
   operator actually aims with. Drawn slightly above the couch so it reads ON the body
   rather than through it, and left depth-testing off so it stays visible over the skin. */
const LASER_Y = 22;                   // just above a supine torso
const LASER_IN = 2;                   // the cross is 2 in across, as on the machine
function buildLaser() {
  const { THREE, three } = ctx;
  const m = new THREE.LineBasicMaterial({ color: 0xff2d2d, transparent: true,
    opacity: 0.95, depthTest: false });
  const g = new THREE.BufferGeometry();
  const A = (LASER_IN * INCH) / 2;    // half-length, cm — a small centring mark, not a grid
  g.setAttribute('position', new THREE.Float32BufferAttribute(
    [-A, 0, 0, A, 0, 0, 0, 0, -A, 0, 0, A], 3));
  laser = new THREE.LineSegments(g, m);
  laser.renderOrder = 999;
  laser.visible = false;
  three.handGroup.parent.add(laser);
}

/* Load the scanned bed + head and stand them in the room. The scan's long axis is x and
   the room's couch axis is z, so it turns a quarter turn; the table top is driven to y = 0
   because that is the plane every mode already lies its subject on. */
function loadScannedRig() {
  const { THREE, three } = ctx;
  if (!ctx.loadModelUrl) return;
  ctx.loadModelUrl(ctx.baseUrl + 'models/rigs/dxa_rig.glb').then((g) => {
    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    let bed = null, hd = null;
    g.traverse((o) => {
      const n = (o.name || '').toLowerCase();
      if (!bed && n === 'bed') bed = o;
      else if (!hd && n === 'head') hd = o;
    });
    if (!bed || !hd) return;                       // keep the boxes
    // Scale from the BED alone. Each part carries its own vertex buffer precisely so this
    // measures the table and not the whole machine — see the note on the splitter.
    const bedBox = new THREE.Box3().setFromObject(bed);
    const size = bedBox.getSize(new THREE.Vector3());
    rigScale = TABLE_LEN_CM / Math.max(size.x, size.y, size.z);
    bedLenCm = TABLE_LEN_CM;
    scannedRig = new THREE.Group();
    scannedRig.add(g);
    g.scale.setScalar(rigScale);
    g.rotation.y = Math.PI / 2;                    // scan's long x -> the room's couch z
    /* Seat the PATIENT SURFACE at y = 0, which is the plane every mode lies its subject on.
       Not the bed's bounding-box top: that is 0.18 in the scan's units and belongs to the
       rail the arm rides, so dropping by it would leave the body floating 20 cm clear.
       The surface is the largest upward-facing plane in the bed — measured over the mesh,
       it carries 1.111 of area against 0.376 for the next candidate, and sits at -0.03. */
    bedTopY = BED_TOP_LOCAL * rigScale;
    g.position.y -= bedTopY;
    scannedRig.visible = false;
    three.handGroup.parent.add(scannedRig);
    bedNode = bed; headNode = hd;
    headHome = hd.position.clone();
    // where the arm sits before anyone drives it, in room cm — syncHead subtracts this so
    // the head straddles the laser rather than trailing it by the length of the table
    scannedRig.updateMatrixWorld(true);
    const hb = new THREE.Box3().setFromObject(hd);
    headCentreHomeZ = (hb.min.z + hb.max.z) / 2;
    dxaSyncScene();
  }).catch(() => { /* the box rig remains */ });
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
  $('dxLoss')?.addEventListener('input', (e) => {
    D.loss = (+e.target.value) / 100;
    const el = $('dxLossV'); if (el) el.textContent = `${Math.round(D.loss * 100)} %`;
    setStatus(D.loss ? `Skeleton at ${(100 * (1 - D.loss)).toFixed(0)} % mineral — rescan to see it.`
                     : 'Skeleton at full mineral.');
  });
  $('dxKeep')?.addEventListener('click', () => { keepScan(scan); setStatus('Scan filed to the series.'); });
  $('dxClear')?.addEventListener('click', () => { D.scans.length = 0; renderSerial(); });
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
  $('dxWt')?.addEventListener('input', (e) => {
    D.weight = +e.target.value;
    const el = $('dxWtV'); if (el) el.textContent = `${D.weight} kg`;
  });
  document.querySelectorAll('#dxRegionSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      D.region = b.dataset.region;
      document.querySelectorAll('#dxRegionSeg button').forEach((x) => x.classList.toggle('on', x === b));
      setStatus(`${REGIONS[D.region].label} selected — press SCAN.`);
      parkAtLandmark();
    });
  });
  // ---- the arm pad. Held keys repeat, because nudging 20 cm one press at a time is not
  // how anyone drives a real console.
  document.querySelectorAll('#dxPad .dxpad-b').forEach((b) => {
    let t = null, rep = null;
    const go = () => nudge(b.dataset.nudge);
    const start = (e) => { e.preventDefault(); go();
      t = setTimeout(() => { rep = setInterval(go, 70); }, 380); };
    const stop = () => { clearTimeout(t); clearInterval(rep); t = rep = null; };
    b.addEventListener('pointerdown', start);
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointerleave', stop);
    b.addEventListener('pointercancel', stop);
  });
  $('dxLaserHome')?.addEventListener('click', () => { D.crossX = 0; syncHead(); syncPad(); });
  syncPad();
  if (typeof window !== 'undefined') window.__dxa = () => ({ D, scan, acquire, decompose, basis,
    E_LO, E_HI, REGIONS, findLevels, measure, scores, diagnosis, ageMean, REF, CAL,
    THREE: ctx.THREE,
    rig: { scannedRig, bedNode, headNode, laser, rigScale, bedTopY, bedLenCm },
    landmarkTargets, positionError, parkAtLandmark, nudge });
}
