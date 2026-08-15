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
import { makePatient, drawAgeChart, reportHTML } from './dxaReport.js';

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
  /* The lumbar field has to show the whole of L5-S1 at the bottom and T11-T12 at the top,
     because those two junctions are what the level count is checked against — without them
     you cannot prove which body you called L4. That is five bodies plus both joints, so
     24 cm rather than the 20 it was, which was cutting the top joint off. */
  spine: { label: 'AP lumbar spine', wx: 14, wz: 24 },
  /* The femur field runs UP from its mark exactly as the spine does. Treating the mark as
     the centre of the window put 13 cm of shaft in the picture and pushed the femoral head
     hard against the top edge — the one part of the study that carries the diagnosis. Two
     inches below the trochanter is where the sweep STARTS: 5 cm of shaft below the
     trochanter, then the trochanter, neck, head and a little acetabulum above it. */
  hipL:  { label: 'Left hip',        wx: 12, wz: 12 },
  hipR:  { label: 'Right hip',       wx: 12, wz: 12 },
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
  const dirSup = Math.sign(landmarkSupDir(mid, nz)) || 1;
  const troch = findTrochanters(ph, aOf, crestZ, dirSup);
  landmarks = { lumbarZ, crestZ, dirSup,
                lumbarCm: (lumbarZ + 0.5) * vs[2] + ph.min[2],
                crestCm: (crestZ + 0.5) * vs[2] + ph.min[2],
                troch };
  landmarksFor = ctx.S.subject;
  return landmarks;
}

/* THE GREATER TROCHANTER, MEASURED. It used to be assumed at "crest minus ~7 cm", which is
   about where the ASIS is — on this subject the real thing is 9 cm down, so the hip field
   opened two centimetres high and took in more ilium than femur. There is no need to guess:
   the trochanter announces itself. Walk down from the crest and the pelvis is ONE bone mass
   spanning both innominates, 25-30 cm across; the first slice below it where a small
   free-standing island appears out to the side is the tip of the greater trochanter, because
   that island is the femur and nothing else is out there. Same idea as the crest above —
   find the shape the anatomy makes rather than pace out a number from another landmark. */
function findTrochanters(ph, aOf, crestZ, dirSup) {
  const nx = ph.nx, ny = ph.ny, nz = ph.nz, data = ph.data, vs = ph.vs;
  const isBone = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return false;
    const id = data[(z * ny + y) * nx + x];
    return id < aOf.length && aOf[id] >= 0.35;
  };
  const cxVox = nx / 2;
  /* Counting islands down from the crest does not work. The ilium separates from the sacrum
     well ABOVE the hip joint, so the first free-standing lateral mass is the acetabular roof
     and calling it the trochanter puts the whole field four centimetres high — which is
     exactly what it did, with the acetabulum landing at the bottom of the picture instead of
     the top.

     The femoral HEAD is unambiguous instead: it is the roundest thing in the pelvis, so it
     is the centre of the largest sphere that fits inside bone anywhere out to the side. And
     the tip of the greater trochanter lies level with the centre of the femoral head — the
     relationship every AP pelvis is read by — so finding the one gives the other. */
  const found = {};
  for (const side of ['L', 'R']) {
    const sgn = side === 'L' ? -1 : +1;          // world -x is the patient's left
    const xa = Math.round(cxVox + sgn * 16 / vs[0]), xb = Math.round(cxVox + sgn * 3 / vs[0]);
    const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb);
    const z0 = Math.round(crestZ - dirSup * 20 / vs[2]), z1 = Math.round(crestZ - dirSup * 5 / vs[2]);
    let best = { r: 0 };
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z += 2) {
      for (let y = 2; y < ny - 2; y += 2) {
        for (let x = x0; x <= x1; x += 2) {
          if (!isBone(x, y, z)) continue;
          let r = 1;
          for (; r < 16; r++) {
            if (!isBone(x + r, y, z) || !isBone(x - r, y, z) || !isBone(x, y + r, z)
              || !isBone(x, y - r, z) || !isBone(x, y, z + r) || !isBone(x, y, z - r)) break;
          }
          if (r > best.r) best = { r, x, y, z };
        }
      }
    }
    if (!best.r) continue;
    const headZ = (best.z + 0.5) * vs[2] + ph.min[2];
    // the shaft, six centimetres below the head, is what the laser lines up with
    const zs = Math.round(best.z - dirSup * 6 / vs[2]);
    // Only bone near the head counts. This subject's arms lie along the thighs, and a
    // centroid taken across the whole lateral band picks up the forearm and drags the shaft
    // four centimetres out — which then aims the neck search off into the pubis.
    const nearA = Math.round(best.x - 4 / vs[0]), nearB = Math.round(best.x + 4 / vs[0]);
    let sx = 0, sn = 0;
    for (let y = 0; y < ny; y++) for (let x = Math.max(x0, nearA); x <= Math.min(x1, nearB); x++) if (isBone(x, y, zs)) { sx += x; sn++; }
    const shaftX = sn ? Math.abs(((sx / sn) - cxVox) * vs[0]) : Math.abs((best.x - cxVox) * vs[0]);
    found[side] = { zCm: headZ, x: shaftX, headX: Math.abs((best.x - cxVox) * vs[0]),
      headR: best.r * vs[0] };
  }
  const fallback = { zCm: (crestZ + 0.5) * vs[2] + ph.min[2] - dirSup * 13, x: 8 };
  return { L: found.L || found.R || fallback, R: found.R || found.L || fallback };
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
     edge of the sweep at both sites, because both scans run up the patient — the lumbar
     from the ASIS to T11, the femur from two inches below the trochanter to the acetabulum.
     Drive the arm to the wrong place and the wrong bones land in the window — which is the
     lesson. positionError() tells the console how far off it is. */
  const cen = ph.min.map((m, i) => (m + ph.max[i]) / 2);
  const lm = findLandmarks(ph);
  const spine = D.region === 'spine';
  const cxW = cen[0] + D.crossX;
  const czW = D.headZ + lm.dirSup * reg.wz / 2;   // the cross is the INFERIOR edge, both sites
  const x0 = cxW - reg.wx / 2, z0 = czW - reg.wz / 2;
  const yBelow = ph.min[1] - 5, yLen = (ph.max[1] - ph.min[1]) + 10;

  // Carry the crest with the scan: it is the only thing in the image that says WHICH
  // vertebra is which, and the analysis needs it after the raster is long finished.
  const tro = lm.troch?.[D.region === 'hipR' ? 'R' : 'L'];
  scan = { nx, nz, lo, hi, truth, x0, z0, px: PX_CM, region: D.region, loss: D.loss || 0,
    crestCm: lm.crestCm, dirSup: lm.dirSup,
    trochZ: tro ? tro.zCm : null, trochX: tro ? (D.region === 'hipL' ? -tro.x : tro.x) : null,
    headX: tro && tro.headX != null ? (D.region === 'hipL' ? -tro.headX : tro.headX) : null,
    headR: tro && tro.headR != null ? tro.headR : null };
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
  const boxcar = (src, rad) => {                // moving average over rows
    const out = new Float32Array(nz);
    for (let r = 0; r < nz; r++) {
      let s = 0, n = 0;
      for (let k = -rad; k <= rad; k++) { const j = r + k; if (j < 0 || j >= nz) continue; s += src[j]; n++; }
      out[r] = s / n;
    }
    return out;
  };

  /* 1. THE SPINE COLUMN. Count the rows carrying bone at each x and take the run around
     the peak. The threshold has to be measured from the field's own FLOOR, not from zero:
     ribs, transverse processes and the iliac wings put bone in every column of an abdominal
     window, so the floor here sits near 30% of the peak and a flat "45% of peak" cut clears
     it by a hair. Park the arm off the landmark and the floor rises past the cut entirely,
     at which point the column grows to both edges of the field and the "spine" is the whole
     abdomen. Subtracting the floor makes the threshold a contrast, which cannot blow out. */
  const colHit = new Float32Array(nx);
  for (let r = 0; r < nz; r++) for (let i = 0; i < nx; i++) if (bmd[r * nx + i] > BONE) colHit[i]++;
  let best = 0, bestI = nx >> 1, floor = Infinity;
  for (let i = 0; i < nx; i++) { if (colHit[i] > best) { best = colHit[i]; bestI = i; } if (colHit[i] < floor) floor = colHit[i]; }
  const colCut = floor + (best - floor) * 0.45;
  let cA = bestI, cB = bestI;
  while (cA > 0 && colHit[cA - 1] > colCut) cA--;
  while (cB < nx - 1 && colHit[cB + 1] > colCut) cB++;

  /* 2. THE PROFILE, TAKEN OVER THE BODIES ONLY. At a disc space the facet joints and
     laminae are continuous bone — only the vertebral BODY is lucent there. Integrate across
     the full column and the posterior elements fill the very dips being looked for, and
     they fill them unevenly: the lower lumbar facets are bulkier, so L3/L4 and L4/L5 washed
     out while L1 and L2 came through clean. That is exactly the failure that put the L3/L4
     cut a third of a body too high. Keep the wide column for the measured box — that is the
     box a real machine draws — but hunt the cuts down the middle. */
  const mid = (cA + cB) / 2, halfBody = Math.max(1, (cB - cA) / 2 * 0.55);
  const bA = Math.max(0, Math.round(mid - halfBody)), bB = Math.min(nx - 1, Math.round(mid + halfBody));
  const prof = new Float32Array(nz);
  for (let r = 0; r < nz; r++) {
    let s = 0;
    for (let i = bA; i <= bB; i++) s += bmd[r * nx + i];
    prof[r] = s;
  }
  const sm = boxcar(prof, Math.max(1, Math.round(0.4 / px)));

  /* 3. DETREND. Mineral per row falls away steadily from the pelvis toward the ribs, and
     that slope is bigger than the disc modulation riding on it — absolute minima all end up
     bunched at the superior end. Dividing by a long average leaves the rhythm and throws
     away the taper, which is a soft-tissue and thickness gradient rather than anatomy. */
  const trend = boxcar(prof, Math.max(2, Math.round(3.0 / px)));
  const det = new Float32Array(nz);
  for (let r = 0; r < nz; r++) det[r] = trend[r] > 1e-6 ? sm[r] / trend[r] : 1;

  /* 4. THE RHYTHM, THEN THE BODIES. Each disc found on its own is a coin toss — a shallow
     one gets missed, a mottled body invents an extra. But the lumbar spine is regular, so
     find the PERIOD once by autocorrelation (every disc voting together), pick the phase
     that sits lowest, and only then let each cut slide to its own local minimum. The rhythm
     supplies the robustness and the snap supplies the anatomy: bodies are not identical. */
  const pLo = Math.max(2, Math.round(2.2 / px)), pHi = Math.max(pLo + 1, Math.round(4.6 / px));
  let period = pLo, bestCorr = -Infinity;
  for (let L = pLo; L <= pHi && L < nz; L++) {
    let s = 0, n = 0;
    for (let r = 0; r + L < nz; r++) { s += (det[r] - 1) * (det[r + L] - 1); n++; }
    if (n && s / n > bestCorr) { bestCorr = s / n; period = L; }
  }
  let phase = 0, bestMean = Infinity;
  for (let o = 0; o < period; o++) {
    let s = 0, n = 0;
    for (let r = o; r < nz; r += period) { s += det[r]; n++; }
    if (n && s / n < bestMean) { bestMean = s / n; phase = o; }
  }
  const snap = Math.max(1, Math.round(period / 4));
  const edge = Math.round(period * 0.6);         // no room for a body: the window ending
  const dips = [];
  for (let r = phase; r < nz; r += period) {
    let bi = -1, bv = Infinity;
    for (let k = -snap; k <= snap; k++) {
      const j = r + k;
      if (j < edge || j > nz - 1 - edge) continue;
      if (det[j] < bv) { bv = det[j]; bi = j; }
    }
    if (bi >= 0 && (!dips.length || bi > dips[dips.length - 1])) dips.push(bi);
  }
  const bands = [];
  for (let i = 0; i + 1 < dips.length; i++) bands.push({ a: dips[i], b: dips[i + 1] });

  /* 5. WHICH ONE IS L4. Counting the bodies is not the same as naming them, and the window
     deliberately opens at L5-S1, so the lowest body in it is L5 — take the first four from
     the inferior end and every label is off by one. What settles it is the same landmark a
     technologist reads off a plain film: THE SUMMIT OF THE ILIAC CREST LIES AT THE L4-L5
     INTERSPACE. The crest is already measured on the phantom for positioning, so the cut
     nearest it is the L4-L5 disc and L4 is the body immediately superior to that.
     Two independent routes to the same row — the crest predicts 36.7 on this subject and
     the profile finds a disc at 36 — which is the check that this is anatomy and not a
     coincidence of one scan. Rows run with world z, so which way is up depends on dirSup. */
  const labels = ['L4', 'L3', 'L2', 'L1'];       // in order, walking superiorly
  const supUp = (sc.dirSup ?? 1) >= 0;           // does the row index increase toward the head?
  let start = supUp ? 0 : bands.length - 1;      // fall back to the end nearest the sacrum
  // The crest names LUMBAR vertebrae and nothing else; a hip window sits below it entirely,
  // so anchoring there would be reading a landmark that is not in the picture.
  if (sc.region === 'spine' && sc.crestCm != null && dips.length) {
    const crestRow = (sc.crestCm - sc.z0) / px - 0.5;
    let k = 0;
    for (let i = 1; i < dips.length; i++) if (Math.abs(dips[i] - crestRow) < Math.abs(dips[k] - crestRow)) k = i;
    // the band on the superior side of that cut, in whichever direction superior runs
    const cand = supUp ? k : k - 1;
    if (cand >= 0 && cand < bands.length) start = cand;
  }
  const named = [];
  for (let i = 0; i < 4; i++) {
    const bd = bands[supUp ? start + i : start - i];
    if (!bd) break;
    named.push({ label: labels[i], ...bd, x0: cA, x1: cB });
  }
  return { rois: named, col: [cA, cB], prof: sm, dips, period };
}

/* One entry point for both sites, so every caller — the scan, the reset button, the tests —
   analyses a study the same way and neither has to know which bone it is holding. */
export function analyse(sc, bmd) {
  if (sc.region === 'spine') {
    const lv = findLevels(sc, bmd);
    return { rois: lv.rois, col: lv.col, axes: null };
  }
  const f = findFemur(sc, bmd);
  return { rois: f ? f.rois : [], col: null, axes: f ? f.axes : null };
}

/* ---- the proximal femur ------------------------------------------------------
   The spine could be segmented straight out of its own image because the discs cut the
   column into pieces. The femur cannot, and it is worth being clear about why rather than
   tuning a threshold until it looks right: an AP ray through the hip passes through ilium,
   acetabulum, femur and ischium stacked on top of one another, so seven tenths of this
   window is "bone" at any threshold that keeps the femoral neck. Nor does 3-D connectivity
   help — at the hip joint the head touches the acetabulum, and a flood fill from the
   trochanter swallows the whole skeleton.

   Real hip densitometry has the same problem and solves it the same way: it fits a MODEL of
   the proximal femur to the image rather than segmenting the femur out of it. So the axes
   are measured — the shaft from the image, the neck by searching for it, the trochanter from
   the phantom during positioning — and the regions are then constructed on those axes the
   way a console constructs them. Everything that determines a number is a measurement; only
   the shape of the regions is prior knowledge, which is exactly the split a real analysis
   makes.

   Coordinates here are (col, row) in scan order: +row is superior, +col is +x in the world.
   Two frames sit on top of that — s/t along and across the SHAFT, a/b along and across the
   NECK — and every region is a pair of inequalities in them. */
const NECK_H = 1.5;         // cm along the neck axis: the GE Lunar neck ROI height
const NECK_PROX = 1.2;      // cm the neck reaches back past the head's estimated rim
const TROCH_RUN = 4.5;      // cm past the neck: the trochanteric mass, then diaphysis
const B_LIMIT = 5.0;        // cm either side of the NECK: keeps the ischium out

function fitShaft(sc, bmd, tc, tr) {
  const { nx, nz, px } = sc;
  const BONE = 0.5;
  /* FOLLOW THE FEMUR DOWN, DO NOT AVERAGE ACROSS IT. A mineral-weighted centroid over a band
     around the trochanter assumes the only bone in that band is the femur. On a supine CT
     the arms lie along the thighs, so a few centimetres below the trochanter the band holds
     the femoral shaft AND the forearm, and the centroid settles between them — dragging the
     fitted axis several centimetres lateral and tilting it. Every region hangs off this
     vector, so that one bad average was the last thing holding the neck out of place.

     The forearm is a SEPARATE island, which is the whole answer: take contiguous runs of
     bone per row and keep the one that continues the femur, starting from the trochanter and
     tracking downward. An island that does not touch the run above it is a different bone,
     however close it lies. */
  const runsAt = (r) => {
    const out = [];
    let a = -1;
    for (let i = 0; i <= nx; i++) {
      const on = i < nx && bmd[r * nx + i] > BONE;
      if (on && a < 0) a = i;
      else if (!on && a >= 0) { out.push({ a, b: i - 1, c: (a + i - 1) / 2, w: i - a }); a = -1; }
    }
    return out;
  };
  const MAX_JUMP = 1.5 / px;                      // a shaft does not move this fast per row
  const pts = [];
  let cur = tc;
  for (let r = Math.round(tr); r >= 0; r--) {
    const runs = runsAt(r).filter((q) => q.w * px > 0.8);   // ignore speckle
    if (!runs.length) continue;
    let best = null, bestD = Infinity;
    for (const q of runs) {
      const d = q.a - 1 <= cur && cur <= q.b + 1 ? 0 : Math.min(Math.abs(q.a - cur), Math.abs(q.b - cur));
      if (d < bestD) { bestD = d; best = q; }
    }
    if (!best || bestD > MAX_JUMP) continue;      // the femur left the picture: stop guessing
    cur = best.c;
    // only the part clear of the trochanteric flare is diaphysis worth fitting
    if (r < tr - 2.5 / px) pts.push({ r, c: best.c });
  }
  if (pts.length < 5) return { p: [tc, tr], u: [0, 1] };
  // least squares c = m*r + k, then the axis direction is (m, 1) normalised, superior-going
  let sr = 0, sc2 = 0, srr = 0, src = 0;
  for (const q of pts) { sr += q.r; sc2 += q.c; srr += q.r * q.r; src += q.r * q.c; }
  const n = pts.length, den = n * srr - sr * sr;
  const m = Math.abs(den) < 1e-6 ? 0 : (n * src - sr * sc2) / den;
  const k = (sc2 - m * sr) / n;
  const L = Math.hypot(m, 1);
  return { p: [m * tr + k, tr], u: [m / L, 1 / L] };
}

export function findFemur(sc, bmd) {
  const { nx, nz, px } = sc;
  if (sc.trochX == null || sc.headX == null) return null;
  const tc = (sc.trochX - sc.x0) / px - 0.5;      // trochanter, in scan coordinates
  const tr = (sc.trochZ - sc.z0) / px - 0.5;
  if (!(tc > 0 && tc < nx && tr > 0 && tr < nz)) return null;

  const { p, u } = fitShaft(sc, bmd, tc, tr);
  const uT = [-u[1], u[0]];                       // across the shaft

  /* THE NECK, BY LOOKING FOR IT. Swing a ray out of the trochanteric mass across the
     plausible neck-shaft angles and integrate the mineral along it: the neck is a dense
     ridge running superomedially and it wins clearly. Then walk out along the winner and
     watch the width — the narrowest cross-section IS the neck, which is where a console
     puts the box and where a fracture starts. */
  /* THE REGIONS, LAID OUT FROM THE HEAD OUTWARD.
     Everything is anchored on two measured points and one unambiguous direction: the head
     centre with its radius (the largest sphere that fits inside bone), the shaft axis fitted
     down the diaphysis, and MEDIAL — which needs no fitting at all, because world +x is the
     midline side for a left hip and -x for a right one. The previous version derived the
     lateral direction from the sign of the head's offset across the fitted shaft axis, and
     when the two nearly coincide that sign is noise: it put the greater trochanter on the
     medial side of the picture, opposite the anatomy.

     Walking out from the head along the neck: head (never scored), then neck, then the
     trochanteric mass, which divides laterally into the greater trochanter and medially and
     below into the intertrochanteric region, and stops at the distal cut. */
  const medSign = sc.region === 'hipL' ? +1 : -1;       // columns rise with world x
  /* The inscribed sphere finds the joint, not the head. Where the head meets the acetabulum
     there is no gap to stop it, so the biggest sphere straddles both and its centre settles
     up in the acetabular roof — measured against the femur on the film it sits about 1.6 cm
     superior and 0.9 cm medial of the head's own centre. Correct it HERE rather than in the
     landmark: the landmark drives where the laser goes and that is already right. */
  const headC = [(sc.headX - sc.x0) / px - 0.5 - medSign * 0.9 / px, tr - 1.6 / px];
  /* The inscribed sphere stops growing at the search cap, and in a pelvis where the head
     touches the acetabulum it reaches that cap — 3.2 cm, which is half again a femoral head
     and would swallow the neck. Believe the measurement only while it is anatomically
     possible; an adult femoral head runs about 2.0-2.6 cm in radius. */
  const headR = Math.min(2.6, Math.max(1.7, sc.headR || 2.2)) / px;

  /* THE NECK RUNS OUT OF THE HEAD AT THE NECK-SHAFT ANGLE. Taking its direction as
     head-to-shaft sounds exact and collapses in the one case that matters: with the leg in
     neutral rotation the neck is foreshortened until the head sits half a centimetre from
     the shaft axis, the two points nearly coincide, and the "neck" ends up pointing straight
     down the diaphysis. Every region hangs off that axis, so all of them came out about
     three centimetres medial of where they belong.
     The neck-shaft angle does not foreshorten. An adult femur carries about 127 degrees
     between neck and shaft, which puts the neck 53 degrees off the shaft: from the head it
     runs down and LATERALLY at that angle, which is the diagonal a hip film shows. Lateral
     needs no fitting — columns rise with world x, so the midline side is known outright. */
  const NECK_SHAFT = 127 * Math.PI / 180;
  const dn = [-u[0], -u[1]];                            // down the shaft, toward the knee
  // the perpendicular to the shaft that points AWAY from the midline
  let lat = [-dn[1], dn[0]];
  if (Math.sign(lat[0]) === Math.sign(medSign)) lat = [dn[1], -dn[0]];
  const th = Math.PI - NECK_SHAFT;
  let nAx = [dn[0] * Math.cos(th) + lat[0] * Math.sin(th),
             dn[1] * Math.cos(th) + lat[1] * Math.sin(th)];
  const nL = Math.hypot(nAx[0], nAx[1]) || 1;
  nAx = [nAx[0] / nL, nAx[1] / nL];                     // points AWAY from the head
  const nT = [-nAx[1], nAx[0]];
  const pivot = [headC[0] + nAx[0] * (4.5 / px), headC[1] + nAx[1] * (4.5 / px)];

  /* The neck starts at the edge of the head and runs to the trochanteric flare. Its width is
     measured rather than assumed: walk out and take the narrowest cross-section, which is the
     neck proper and where a fracture starts. */
  const BONE = 0.5;
  /* WHERE THE NECK BEGINS. Its proximal edge and the head's exclusion boundary are the same
     line — the head-neck junction — so the two move together and neither can be set alone.
     Placing that line at the head's own radius cut the neck short of the junction, because
     the radius is a clamped estimate: the inscribed sphere cannot find the head's edge where
     it meets the acetabulum, so it reads large and the boundary lands out in the neck. Carry
     it back toward the head, which lengthens the neck proximally by the same centimetre. */
  const nStart = Math.max(headR * 0.45, headR - NECK_PROX / px);
  const nEnd = headR + NECK_H / px;
  let halfW = 1.4 / px;
  for (let t = Math.round(nStart); t <= Math.round(nEnd); t++) {
    const c0 = headC[0] + nAx[0] * t, r0 = headC[1] + nAx[1] * t;
    let w = 0;
    for (let k = -Math.round(3 / px); k <= Math.round(3 / px); k++) {
      const c = Math.round(c0 + nT[0] * k), r = Math.round(r0 + nT[1] * k);
      if (c < 0 || r < 0 || c >= nx || r >= nz) continue;
      if (bmd[r * nx + c] > BONE) w++;
    }
    if (w > 0 && w / 2 < halfW) halfW = w / 2;
  }
  const halfWpx = Math.max(halfW, 1.2 / px);
  const H = [headC[0] + nAx[0] * (nStart + nEnd) / 2, headC[1] + nAx[1] * (nStart + nEnd) / 2];

  const sOf = (c, r) => (c - p[0]) * u[0] + (r - p[1]) * u[1];
  const tOf = (c, r) => (c - p[0]) * uT[0] + (r - p[1]) * uT[1];
  const aOf2 = (c, r) => (c - headC[0]) * nAx[0] + (r - headC[1]) * nAx[1];
  const bOf = (c, r) => (c - headC[0]) * nT[0] + (r - headC[1]) * nT[1];
  const sNeck = sOf(H[0], H[1]);
  const aMax = nEnd + TROCH_RUN / px;                   // past this, along the neck, is diaphysis

  /* WHICH SIDE OF THE NECK IS THE TROCHANTER. Splitting on the SHAFT coordinate — lateral of
     the shaft axis, above the neck's level — produced the two things that cannot be true of
     a femur: a trochanter lying on the mid-shaft, and a trochanter sandwiched between the
     neck and the intertrochanteric region. Both follow from measuring across the wrong axis.
     The neck runs diagonally, and the trochanteric mass divides ACROSS IT: the greater
     trochanter is the bone superolateral of the neck axis, the intertrochanteric region the
     wedge inferomedial of it running down to the lesser trochanter. So the sign of b decides
     it, and b is measured off the neck. nT is nAx turned a quarter; work out which way that
     points by asking where it puts a step toward the head's own superior side. */
  const supSign = nT[1] > 0 ? +1 : -1;            // rows rise toward the head, so +row is superior

  const mk = () => new Uint8Array(nx * nz);
  const neck = mk(), troch = mk(), inter = mk(), total = mk();
  for (let r = 0; r < nz; r++) for (let c = 0; c < nx; c++) {
    const k = r * nx + c;
    if (bmd[k] <= BONE) continue;
    const a = aOf2(c, r), b = bOf(c, r);
    /* Bound the field in the NECK's frame, not the shaft's. The guard used to cut anything
       more than five centimetres either side of the fitted shaft axis, and the greater
       trochanter sits five and a half out — so the one region this was meant to find was the
       one it threw away, every time. The shaft fit is the least trustworthy thing here
       anyway: below the trochanter this subject's forearm lies alongside the femur. The neck
       frame needs no fit, and the ischium is far enough off it to be excluded just as well. */
    if (Math.abs(b) > B_LIMIT / px) continue;
    if (a < nStart) continue;                     // the femoral head: never part of total hip
    if (a > aMax) continue;                       // out along the diaphysis
    if (a <= nEnd && Math.abs(b) <= halfWpx) { neck[k] = 1; total[k] = 1; continue; }
    /* Only the NECK reaches back to the head-neck junction. The bone proximal of the head's
       rim but off the neck's axis is the head's own upper and lower margin, not trochanter
       and not intertrochanteric — and letting the shared boundary move dragged both of those
       regions with it. They keep their own edge at the rim. */
    if (a < headR) continue;
    if (b * supSign > 0) { troch[k] = 1; total[k] = 1; }
    else { inter[k] = 1; total[k] = 1; }
  }

  /* WARD'S. Not a landmark but a SEARCH: the square centimetre of lowest density in the
     neck, where the compressive and tensile trabeculae leave a gap. It is reported because
     it is the first thing to thin, and it must never be used for diagnosis — too small and
     too variable — which is why the report carries it flagged rather than in the total. */
  const side = Math.max(2, Math.round(1 / px));
  let wardBest = Infinity, wardAt = null;
  for (let t = Math.round(nStart); t <= Math.round(nEnd); t++) {
    for (let k = -Math.round(1.5 / px); k <= Math.round(1.5 / px); k++) {
      const c0 = Math.round(headC[0] + nAx[0] * t + nT[0] * k);
      const r0 = Math.round(headC[1] + nAx[1] * t + nT[1] * k);
      let s = 0, n = 0;
      for (let dr = 0; dr < side; dr++) for (let dc = 0; dc < side; dc++) {
        const c = c0 + dc - (side >> 1), r = r0 + dr - (side >> 1);
        if (c < 0 || r < 0 || c >= nx || r >= nz) { n = 0; dr = side; break; }
        s += bmd[r * nx + c]; n++;
      }
      if (n === side * side && s / n > 0.2 && s / n < wardBest) { wardBest = s / n; wardAt = [c0, r0]; }
    }
  }
  const wards = mk();
  if (wardAt) {
    for (let dr = 0; dr < side; dr++) for (let dc = 0; dc < side; dc++) {
      const c = wardAt[0] + dc - (side >> 1), r = wardAt[1] + dr - (side >> 1);
      if (c >= 0 && r >= 0 && c < nx && r < nz) wards[r * nx + c] = 1;
    }
  }

  const count = (m) => { let n = 0; for (let i = 0; i < m.length; i++) n += m[i]; return n; };
  const rois = [
    { label: 'Neck', mask: neck, site: 'neck' },
    { label: 'Wards', mask: wards, site: 'wards', noTotal: true },
    { label: 'Troch', mask: troch, site: 'troch' },
    { label: 'Inter', mask: inter, site: 'inter' },
    { label: 'Total', mask: total, site: 'total' },
  ].filter((r) => count(r.mask) > 4);
  return { rois, axes: { p, u, H, nAx, headC, headR, nStart, nEnd, aMax, halfW: halfWpx, sNeck } };
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
    if (r.mask) {
      // femoral regions are masks, not bands: their edges follow the bone, not the raster
      for (let k = 0; k < r.mask.length; k++) {
        if (!r.mask[k]) continue;
        const v = bmd[k];
        if (v > 0.05) { bmc += v * a; n++; }
      }
    } else {
      for (let row = r.a; row < r.b; row++) {
        for (let i = r.x0; i <= r.x1; i++) {
          const v = bmd[row * sc.nx + i];
          if (v > 0.05) { bmc += v * a; n++; }
        }
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
  /* The femur is not one site. Its regions differ by a factor of two — the intertrochanteric
     is the densest thing in the proximal femur and Ward's the least — so scoring them all
     against one mean would make a normal trochanter look osteoporotic and a normal
     intertrochanter look enviable. NHANES III publishes them separately, so use them
     separately. `hip` is kept as the total-hip alias for anything still asking for it. */
  neck:  { f: { yMean: 0.858, ySD: 0.120 }, m: { yMean: 0.934, ySD: 0.130 } },
  troch: { f: { yMean: 0.697, ySD: 0.100 }, m: { yMean: 0.769, ySD: 0.110 } },
  inter: { f: { yMean: 1.092, ySD: 0.155 }, m: { yMean: 1.194, ySD: 0.166 } },
  total: { f: { yMean: 0.942, ySD: 0.122 }, m: { yMean: 1.031, ySD: 0.134 } },
  wards: { f: { yMean: 0.727, ySD: 0.128 }, m: { yMean: 0.766, ySD: 0.140 } },
  hip:   { f: { yMean: 0.942, ySD: 0.122 }, m: { yMean: 1.031, ySD: 0.134 } },
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
  /* WINDOW ON A PERCENTILE, NOT THE PEAK. Scaling to the brightest pixel works at the spine,
     where the brightest thing IS the anatomy. At the hip a single ray can catch ilium,
     acetabulum, femur and ischium end-on and come back at 7 g/cm2 — five times the femur —
     and everything the study is about gets squeezed into the bottom fifth of the greyscale.
     Clipping at the 99th percentile throws away that one hot ray and gives the femur the
     range instead. It is a display window and nothing more: no measurement reads this. */
  const src = bmd || sc.lo;
  const n = rows * nx;
  let hiV = 0;
  if (n > 0) {
    const sample = new Float32Array(n);
    sample.set(src.subarray(0, n));
    sample.sort();
    hiV = sample[Math.min(n - 1, Math.floor(n * 0.99))];
  }
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
  drawRois(f2, sc, s, (film.width - nx * s) / 2, (film.height - nz * s) / 2);
  $('noexp')?.style.setProperty('display', 'none');
  const tl = $('fnTL'); if (tl) tl.textContent = `DXA ${REGIONS[sc.region]?.label || ''}`;
  const br = $('fnBR'); if (br) br.textContent = `${E_LO} / ${E_HI} keV`;
}

/* WHAT IS ACTUALLY BEING COUNTED, drawn on the picture. A DXA number is an average over a
   box, and until you can see the box you are taking the machine's word for which bones it
   averaged — which is exactly the mistake a mis-analysed spine makes. Green is the
   convention on every densitometer console, so green it is.
   Everything here works in DISPLAY pixels: the image is hung superior-up and read as if
   facing the patient, so a scan row maps to nz-1-row and a column to nx-1-col. roiView
   keeps that mapping so the pointer can be turned back into scan coordinates. */
let roiView = null;
function roiRect(sc, r, s, ox, oy) {
  const dyA = (sc.nz - r.b) * s + oy, dyB = (sc.nz - r.a) * s + oy;
  const dxA = (sc.nx - 1 - r.x1) * s + ox, dxB = (sc.nx - r.x0) * s + ox;
  return { x: dxA, y: dyA, w: dxB - dxA, h: dyB - dyA };
}
/* The femoral regions are masks whose edges follow the bone, not the raster, so they are
   painted at scan resolution and scaled up with the same double flip as the image. Drawing
   them as outlines would be a lie about what was counted; on a real console the femur
   regions hug the cortex in exactly this way. */
let maskCanvas = null;
const MASK_RGB = { Neck: [64, 220, 120], Troch: [96, 190, 255], Inter: [255, 190, 90],
  Wards: [255, 120, 160], Total: null };
function drawMasks(g, sc, s, ox, oy) {
  const { nx, nz } = sc;
  if (!maskCanvas) maskCanvas = document.createElement('canvas');
  if (maskCanvas.width !== nx || maskCanvas.height !== nz) { maskCanvas.width = nx; maskCanvas.height = nz; }
  const m2 = maskCanvas.getContext('2d');
  const img = m2.createImageData(nx, nz);
  for (const r of sc.rois) {
    const rgb = MASK_RGB[r.label];
    if (!rgb || !r.mask) continue;               // Total is the union of the others: not drawn twice
    for (let dy = 0; dy < nz; dy++) {
      const sy = nz - 1 - dy;
      for (let dx = 0; dx < nx; dx++) {
        const sx = nx - 1 - dx;
        if (!r.mask[sy * nx + sx]) continue;
        const k = (dy * nx + dx) * 4;
        img.data[k] = rgb[0]; img.data[k + 1] = rgb[1]; img.data[k + 2] = rgb[2]; img.data[k + 3] = 92;
      }
    }
  }
  m2.putImageData(img, 0, 0);
  g.drawImage(maskCanvas, ox, oy, nx * s, nz * s);
  // a label on each region, at its own centre of mass
  g.font = '11px ui-monospace, monospace';
  for (const r of sc.rois) {
    const rgb = MASK_RGB[r.label];
    if (!rgb || !r.mask) continue;
    let sx = 0, sy = 0, n = 0;
    for (let row = 0; row < nz; row++) for (let c = 0; c < nx; c++) if (r.mask[row * nx + c]) { sx += c; sy += row; n++; }
    if (!n) continue;
    const dx = (nx - 1 - sx / n) * s + ox, dy = (nz - 1 - sy / n) * s + oy;
    g.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    g.fillText(r.label, dx - 12, dy + 4);
  }
}

function drawRois(g, sc, s, ox, oy) {
  roiView = null;
  if (!sc.rois || !sc.rois.length || !D.showRois) return;
  roiView = { s, ox, oy, nx: sc.nx, nz: sc.nz };
  if (sc.rois.some((r) => r.mask)) { drawMasks(g, sc, s, ox, oy); return; }
  g.save();
  g.lineWidth = 1.5;
  const boxes = sc.rois.map((r) => roiRect(sc, r, s, ox, oy));
  boxes.forEach((b, i) => {
    g.fillStyle = 'rgba(64,220,120,.16)';
    g.fillRect(b.x, b.y, b.w, b.h);
    g.strokeStyle = 'rgba(90,240,145,.95)';
    g.strokeRect(b.x + .5, b.y + .5, b.w - 1, b.h - 1);
    g.fillStyle = '#8dffc0';
    g.font = '11px ui-monospace, monospace';
    g.fillText(sc.rois[i].label, b.x + 4, b.y + 13);
  });
  if (D.editRois) {
    g.fillStyle = '#bfffda';
    const cx = boxes[0].x + boxes[0].w / 2;
    cutYs(sc, s, oy).forEach((y) => hdl(g, cx, y));
    const yMid = (Math.min(...boxes.map((b) => b.y)) + Math.max(...boxes.map((b) => b.y + b.h))) / 2;
    hdl(g, boxes[0].x, yMid);
    hdl(g, boxes[0].x + boxes[0].w, yMid);
  }
  g.restore();
}
function hdl(g, x, y) { g.fillRect(x - 4, y - 3, 8, 6); }

/* EDITING THE REGIONS. On a real console the analysis is adjustable and the technologist
   owns the result: you drag the inter-vertebral cuts onto the disc spaces and pull the
   lateral edges clear of the transverse processes. Same three gestures here.
   BMD is BMC over AREA, a ratio, so growing a box does not simply grow the number — it
   depends on what falls inside. That is the thing to feel, so every drag re-runs measure()
   and the report rather than scaling anything. */
/* THE CUTS ARE SHARED. rois are consecutive bands, roi[i].b == roi[i+1].a, so a cut is one
   boundary owned by two bodies and moving it has to write both. Treating it as "the top of
   box i" and then adjusting box i-1 pairs it with the wrong neighbour: the boxes run bottom
   to top on screen, because the image is hung superior-up while the rows count from the
   inferior end. Getting that backwards inverted a body — a > b — and zeroed its BMD.
   So the model is a list of n+1 boundary rows, and each drag writes the one boundary. */
let drag = null;
function cutRows(sc) {
  const r = sc.rois;
  return [r[0].a, ...r.map((q) => q.b)];
}
function cutYs(sc, s, oy) { return cutRows(sc).map((row) => (sc.nz - row) * s + oy); }
function hitTest(px, py) {
  if (!scan || !scan.rois || !scan.rois.length || !roiView || !D.editRois) return null;
  // The three spine gestures — drag a cut, pull an edge — have no meaning on a femur, whose
  // regions are built on the neck and shaft axes rather than stacked in rows.
  if (scan.rois.some((r) => r.mask)) return null;
  const { s, ox, oy } = roiView;
  const boxes = scan.rois.map((r) => roiRect(scan, r, s, ox, oy));
  const top = Math.min(...boxes.map((b) => b.y));
  const bot = Math.max(...boxes.map((b) => b.y + b.h));
  const left = boxes[0].x, right = boxes[0].x + boxes[0].w;
  if (py > top - 8 && py < bot + 8) {
    if (Math.abs(px - left) < 7) return { kind: 'edgeL' };
    if (Math.abs(px - right) < 7) return { kind: 'edgeR' };
  }
  const ys = cutYs(scan, s, oy);
  for (let k = 0; k < ys.length; k++) if (Math.abs(py - ys[k]) < 7) return { kind: 'cut', k };
  return null;
}
export function dxaPointer(e, phase, canvas) {
  if (!ctx || ctx.S.mode !== 'dxa' || !scan || !scan.rois) return false;
  const r = canvas.getBoundingClientRect();
  const px = (e.clientX - r.left) * (canvas.width / r.width);
  const py = (e.clientY - r.top) * (canvas.height / r.height);
  if (phase === 'down') { drag = hitTest(px, py); return !!drag; }
  if (phase === 'up') { const was = !!drag; drag = null; if (was) reportNow(); return was; }
  if (!drag || !roiView) return false;
  const { s, ox, oy } = roiView;
  const rois = scan.rois;
  if (drag.kind === 'edgeL' || drag.kind === 'edgeR') {
    // display x runs opposite to scan x, so the LEFT edge on screen is the HIGH column
    const col = Math.round(scan.nx - 1 - (px - ox) / s);
    const v = Math.max(0, Math.min(scan.nx - 1, col));
    rois.forEach((q) => { if (drag.kind === 'edgeL') q.x1 = Math.max(q.x0 + 2, v);
                          else q.x0 = Math.min(q.x1 - 2, v); });
  } else {
    const row = Math.round(scan.nz - (py - oy) / s);
    const cuts = cutRows(scan), k = drag.k;
    // keep it between its neighbours so a body can never be turned inside out
    const lo = k > 0 ? cuts[k - 1] + 3 : 0;
    const hi = k < cuts.length - 1 ? cuts[k + 1] - 3 : scan.nz;
    const v = Math.max(lo, Math.min(hi, row));
    if (k > 0) rois[k - 1].b = v;                 // the body below this cut ends here
    if (k < rois.length) rois[k].a = v;           // and the one above it starts here
  }
  redrawRois();
  return true;
}
function redrawRois() { render(scan, scan.bmdMap, null); }
function reportNow() {
  if (!scan || !scan.rois || !scan.bmdMap) return;
  scan.rois = measure(scan, scan.bmdMap, scan.rois);
  report(scan);
}

/* ---- the report -------------------------------------------------------------
   The classic output: a row per level, the L1-L4 mean that the diagnosis is actually
   made on, and the T-score against the -1.0 / -2.5 lines. The raw uncalibrated density
   rides along in the last column so the calibration is visible rather than assumed. */
const FEMUR_ORDER = ['Neck', 'Wards', 'Troch', 'Inter', 'Total'];
export function report(sc) {
  const tb = $('dxTable'); if (!tb || !sc.rois) return;
  const spine = sc.region === 'spine';
  const sex = D.sex || 'f', age = D.age || 60;
  // rois are stored inferior-first, because the cut editor needs them contiguous in row
  // order; a report reads down from L1, so take a copy in label order for display only
  const rows = sc.rois.slice().sort(spine
    ? (p, q) => p.label.localeCompare(q.label)
    : (p, q) => FEMUR_ORDER.indexOf(p.label) - FEMUR_ORDER.indexOf(q.label));
  const siteOf = (r) => (spine ? 'spine' : (r.site || 'total'));

  /* WHAT THE DIAGNOSIS IS MADE ON. At the spine it is the L1-L4 mean, so the areas add.
     At the femur they must NOT: the regions overlap the total, adding them would count the
     same bone twice, and Ward's is not a diagnostic site at all — too small and too
     variable, which is why the ISCD names only the femoral neck and the total hip. So the
     femur reports its measured Total region and scores that, rather than summing a column. */
  let head, mean, s;
  if (spine) {
    let bmcT = 0, areaT = 0;
    for (const r of rows) { bmcT += r.bmc; areaT += r.area; }
    mean = areaT > 0 ? bmcT / areaT : 0;
    s = scores(mean, 'spine', sex, age);
    head = rows.length ? rows[0].label + '–' + rows[rows.length - 1].label : 'Total';
    sc.areaT = areaT; sc.bmcT = bmcT;
  } else {
    const tot = rows.find((r) => r.label === 'Total') || rows[0];
    mean = tot ? tot.bmd : 0;
    s = tot ? scores(mean, 'total', sex, age) : { T: 0, Z: 0 };
    head = 'Total hip';
    sc.areaT = tot ? tot.area : 0; sc.bmcT = tot ? tot.bmc : 0;
  }
  const dx = diagnosis(s.T);
  const line = (r) => {
    const sc2 = scores(r.bmd, siteOf(r), sex, age);
    const flag = r.label === 'Wards' ? ' title="Reported, never used for diagnosis"' : '';
    return `<tr${r.label === 'Total' ? ' class="dxsum"' : ''}${flag}><td>${r.label}${r.label === 'Wards' ? '*' : ''}</td>`
      + `<td>${r.area.toFixed(1)}</td><td>${r.bmc.toFixed(2)}</td>`
      + `<td><b>${r.bmd.toFixed(3)}</b></td><td>${sc2.T.toFixed(1)}</td><td class="dxraw">${r.bmdRaw.toFixed(2)}</td></tr>`;
  };
  tb.innerHTML = '<table class="dxtab"><tr><th>Region</th><th>Area<br><small>cm²</small></th>'
    + '<th>BMC<br><small>g</small></th><th>BMD<br><small>g/cm²</small></th><th>T</th>'
    + '<th class="dxraw">raw</th></tr>'
    + rows.filter((r) => spine || r.label !== 'Total').map(line).join('')
    + (spine
      ? `<tr class="dxsum"><td>${head}</td><td>${sc.areaT.toFixed(1)}</td><td>${sc.bmcT.toFixed(2)}</td>`
        + `<td><b>${mean.toFixed(3)}</b></td><td><b>${s.T.toFixed(1)}</b></td><td class="dxraw">—</td></tr>`
      : rows.filter((r) => r.label === 'Total').map(line).join(''))
    + '</table>'
    + (spine ? '' : '<div class="dxnote">* Ward\'s area is reported by convention and never used for '
      + 'diagnosis. The WHO thresholds apply at the femoral neck and the total hip.</div>')
    + `<div class="dxdx dx-${dx.toLowerCase()}">${dx} &middot; T ${s.T.toFixed(1)} &middot; Z ${s.Z.toFixed(1)}`
    + `<small>WHO: normal &ge; &minus;1.0 &middot; osteopenia &minus;1.0 to &minus;2.5 &middot; osteoporosis &le; &minus;2.5</small></div>`;
  sc.mean = mean; sc.T = s.T; sc.Z = s.Z; sc.dx = dx;
  renderSerial();
}

/* ---- the archive ------------------------------------------------------------
   Every completed scan is filed with its picture, its numbers and the patient it
   belongs to, because that is what makes the trend real: a follow-up study is only
   meaningful next to the one before it. The patient identity is invented ONCE and
   then held for the session — a series that renamed the patient between studies
   would teach the opposite of what a trend report is for.
   Ten deep, newest first, matching the x-ray archive. */
export const HISTORY_MAX = 10;
function patientOf() {
  if (!D.patient || D.patient.sex !== D.sex) {
    D.patient = makePatient(D.sex, D.age, (D.patientSeed ||= (Math.random() * 4294967296) >>> 0));
    D.patient.sex = D.sex;
  }
  return D.patient;
}
function fileStudy(sc) {
  if (!sc || !sc.rois || !sc.rois.length) return;
  const film = $('film');
  // report() has already worked out what the study's headline area and mass are: the L1-L4
  // sum at the spine, the measured Total region at the femur. Re-summing the rows here would
  // count the femur twice over, since Neck, Troch and Inter are all inside Total.
  const areaT = sc.areaT ?? sc.rois.reduce((s, r) => s + r.area, 0);
  const bmcT = sc.bmcT ?? sc.rois.reduce((s, r) => s + r.bmc, 0);
  D.history = D.history || [];
  D.history.unshift({
    region: sc.region, regionLabel: REGIONS[sc.region]?.label || sc.region,
    rois: sc.rois.map((r) => ({ label: r.label, area: r.area, bmc: r.bmc, bmd: r.bmd, site: r.site })),
    mean: sc.mean, T: sc.T, Z: sc.Z, dx: sc.dx, loss: sc.loss || 0,
    area: areaT, bmc: bmcT,
    age: D.age, weight: D.weight, sex: D.sex,
    when: new Date(), patient: patientOf(),
    img: film ? film.toDataURL('image/png') : null,
  });
  if (D.history.length > HISTORY_MAX) D.history.length = HISTORY_MAX;
  D.histIdx = 0;
  renderArchive();
}
/* The trend chart: the same age plot, zoomed onto the span the series actually
   covers, which is how the printout draws it — a follow-up six months later gets
   a decimal-year axis, not twenty years of empty chart. */
function trendChart(cv, entry, hist) {
  const site = entry.region === 'spine' ? 'spine' : 'hip';
  const ages = hist.map((h) => h.age);
  const lo = Math.min(...ages), hi = Math.max(...ages);
  const pad = Math.max(0.6, (hi - lo) * 0.15);
  drawAgeChart(cv, { site, sex: entry.sex,
    points: hist.slice().reverse().map((h) => ({ age: h.age, bmd: h.mean })),
    xMin: +(lo - pad).toFixed(1), xMax: +(hi + pad).toFixed(1) });
}

/* THE TWO BAY VIEWS. Image is the archive of scans; Report is the archive of pages.
   Both are the same ten studies seen two ways, and both are scrollable back, because
   the whole point of a densitometry service is that the last one is still on file. */
export function dxaImageToBay() {
  const list = D.history || [];
  if (!list.length) return false;
  const e = list[Math.min(D.histIdx || 0, list.length - 1)];
  const big = $('bigFilm'); if (!big || !e.img) return false;
  const im = new Image();
  im.onload = () => {
    const g = big.getContext('2d');
    big.width = 560; big.height = 700;
    g.fillStyle = '#000'; g.fillRect(0, 0, big.width, big.height);
    const s = Math.min(big.width / im.width, big.height / im.height);
    g.imageSmoothingEnabled = true;
    g.drawImage(im, (big.width - im.width * s) / 2, (big.height - im.height * s) / 2,
      im.width * s, im.height * s);
  };
  im.src = e.img;
  renderArchive();
  return true;
}
export function dxaReportToBay() {
  const host = $('dxReportPane'); if (!host) return false;
  const list = D.history || [];
  if (!list.length) { host.innerHTML = '<div class="dxrep-empty">No studies yet. '
    + 'Run a scan and the report is written here.</div>'; return true; }
  const e = list[Math.min(D.histIdx || 0, list.length - 1)];
  const hist = list.filter((h) => h.region === e.region);
  // the two charts are rendered offscreen and baked into the page as images, so the
  // report is one self-contained block that can be scrolled, printed or saved
  const c1 = document.createElement('canvas'); c1.width = 560; c1.height = 300;
  drawAgeChart(c1, { site: e.region === 'spine' ? 'spine' : 'hip', sex: e.sex,
    points: [{ age: e.age, bmd: e.mean }] });
  const c2 = document.createElement('canvas'); c2.width = 700; c2.height = 260;
  if (hist.length > 1) trendChart(c2, e, hist);
  host.innerHTML = reportHTML(e, hist, { age: c1.toDataURL(), trend: c2.toDataURL() });
  renderArchive();
  return true;
}
/* The strip of stored studies, shared by both views. */
function renderArchive() {
  const el = $('dxStrip'); if (!el) return;
  const list = D.history || [];
  el.innerHTML = list.map((h, i) => `<button class="dxthumb${i === (D.histIdx || 0) ? ' on' : ''}" `
    + `data-i="${i}" title="${h.regionLabel} · BMD ${h.mean.toFixed(3)} · T ${h.T.toFixed(1)}">`
    + (h.img ? `<img src="${h.img}" alt="">` : '')
    + `<span>${h.mean.toFixed(3)}</span></button>`).join('');
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
    D.region = D.region || 'spine';
    setTimeout(() => parkWhenReady(), 60);   // as soon as the subject's volume is in place
  } else abortScan();
  dxaSyncScene();
}

/* THE ROOM'S MACHINES. Two photogrammetry scans of a densitometer, each split offline into
   'bed' and 'head' nodes by tools/split_dxa_rig.js. Both put the whole arm above y = 0 in
   their own frame, so one split plane serves both — but they were scanned lying different
   ways and everything downstream has to know which. Measured per model, not assumed:

     v2  long axis is already z, so no turn, and travel runs with local +z. Table surface
         at y = -0.09: the only large upward-facing plane between the pedestal and the arm
         (the bigger one at -0.58 is the base plate). Arm sits mid-table on the -x side.
     v1  long axis x, so the room turns it a quarter turn, which maps its local +x onto
         world -z — hence the negative travel. Surface at y = -0.03, arm parked at one END.

   TABLE_LEN_CM is the real machine's, and it sets the scale of everything else: get it
   wrong and the patient is the wrong size relative to the couch they are lying on. */
const TABLE_LEN_CM = 287;
const RIGS = {
  v2: { label: 'Mk II', url: 'models/rigs/dxa_rig_v2.glb',
        rotY: 0,           surfaceY: -0.09, travelAxis: 'z', travelSign: +1 },
  v1: { label: 'Mk I',  url: 'models/rigs/dxa_rig.glb',
        rotY: Math.PI / 2, surfaceY: -0.03, travelAxis: 'x', travelSign: -1 },
};
const RIG_DEFAULT = 'v2';
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
let rigCfg = RIGS[RIG_DEFAULT];       // which machine is standing in the room
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
  headNode.position[rigCfg.travelAxis] +=
    rigCfg.travelSign * (D.headZ - headCentreHomeZ) / rigScale;
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
    /* The landmark scan finds the ILIAC CREST, whose summit sits about the L4-L5 interspace.
       The ASIS is a good 7 cm inferior to it — not the 2 cm this used to assume, which put
       the whole field two levels too high and had it analysing T12. From the ASIS the laser
       goes 1 inch up, and that marks the INFERIOR edge of the sweep, so the window opens at
       L5-S1 and runs superiorly to T11-T12. */
    const asis = lm.crestCm - lm.dirSup * 7;
    return { z: asis + lm.dirSup * INCH, x: 0, label: '1 in above the ASIS midline' };
  }
  /* The trochanter is measured off the phantom, not paced out from the crest — but the
     measurement is of the femoral HEAD, used as a stand-in for the trochanter tip on the
     rule that the two lie level. Checked against the rendered study the stand-in runs high
     and inboard: the field wanted another inch and a half down and an inch out to sit over
     the neck. Both corrections belong to the landmark rather than to the field, so that the
     console's "2 in below the greater trochanter" keeps describing where the laser is. */
  const GT_DROP = 1.5 * INCH, GT_LAT = 1.0 * INCH;
  const t = lm.troch?.[D.region === 'hipL' ? 'L' : 'R'];
  const gt = (t ? t.zCm : lm.crestCm - lm.dirSup * 9) - lm.dirSup * GT_DROP;
  const lat = (t ? t.x : 8) + GT_LAT;
  return { z: gt - lm.dirSup * 2 * INCH, x: D.region === 'hipL' ? -lat : lat,
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
  if (!t) return false;
  D.headZ = t.z; D.crossX = t.x;
  syncHead(); syncPad();
  return true;
}
/* Parking has to wait for the volume. setSubject is async, so a fixed 60 ms delay was a bet
   on the load finishing in time; when it did not, landmarkTargets() had no phantom to read
   and the arm simply stayed where it was — parked over the middle of the chest instead of
   the lumbar spine, which is the first thing you see on entering the mode. Keep asking until
   the anatomy can answer. */
function parkWhenReady(tries = 30, lastZ = null, stable = 0) {
  const t = landmarkTargets();
  // Parking on the FIRST answer is not enough either: while the new volume is still coming
  // in, buildPhantom() hands back whatever is loaded, findLandmarks measures that, and the
  // arm is confidently parked on the wrong patient. Keep parking until the landmark stops
  // moving — two identical answers mean the anatomy underneath has settled.
  if (t) {
    D.headZ = t.z; D.crossX = t.x;
    syncHead(); syncPad();
    stable = (lastZ != null && Math.abs(t.z - lastZ) < 0.01) ? stable + 1 : 0;
    if (stable >= 1) return;
    lastZ = t.z;
  }
  if (tries > 0) setTimeout(() => parkWhenReady(tries - 1, lastZ, stable), 120);
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

/* Load the selected machine and stand it in the room: turned so its long axis lies along
   the couch, scaled so the table is TABLE_LEN_CM end to end, and dropped so the patient
   surface sits at y = 0 — the plane every mode already lies its subject on. */
/* Swap machines. The old one is taken out of the scene and its GPU buffers released — a
   scanned rig is 3.5 MB of texture and geometry, and leaving both resident to toggle
   between them would cost more than re-fetching the rare times anyone switches. */
export function setRig(key) {
  if (!RIGS[key] || rigCfg === RIGS[key]) return;
  rigCfg = RIGS[key];
  if (ctx?.S?.dxa) ctx.S.dxa.rig = key;
  if (scannedRig) {
    scannedRig.parent?.remove(scannedRig);
    scannedRig.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => { m?.map?.dispose(); m?.dispose(); });
    });
    scannedRig = null; bedNode = null; headNode = null; headHome = null;
  }
  loadScannedRig();
  document.querySelectorAll('#dxRigSeg button')
    .forEach((b) => b.classList.toggle('on', b.dataset.rig === key));
}

function loadScannedRig() {
  const { THREE, three } = ctx;
  if (!ctx.loadModelUrl) return;
  const want = rigCfg;
  ctx.loadModelUrl(ctx.baseUrl + want.url).then((g) => {
    if (rigCfg !== want) return;                   // switched again while this was in flight
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
    g.rotation.y = want.rotY;                      // lay the long axis along the couch
    /* Seat the PATIENT SURFACE at y = 0, which is the plane every mode lies its subject on.
       NOT the bed's bounding-box top — on v1 that is the rail the arm rides, and dropping
       by it leaves the body floating 20 cm clear. Each model's surface was measured as the
       largest upward-facing plane in its bed and is recorded in RIGS. */
    bedTopY = want.surfaceY * rigScale;
    g.position.y -= bedTopY;
    scannedRig.visible = false;
    three.handGroup.parent.add(scannedRig);
    bedNode = bed; headNode = hd; scannedRig.userData.rigKey = want.key;
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
        /* A analysis that throws used to take the whole completion callback with it: no
           regions, no report, no error — just a film with nothing drawn on it and a status
           line still reading Done. That is the worst way for this to fail, because it looks
           like an answer. Say so instead, and still show the picture that was acquired. */
        let an;
        try { an = analyse(sc, bmd); } catch (err) {
          console.error('DXA analysis failed', err);
          sc.rois = []; sc.col = null; sc.axes = null;
          render(sc, bmd);
          setStatus(`Scan complete — region analysis failed (${err.message}).`);
          return;
        }
        sc.rois = measure(sc, bmd, an.rois);
        sc.col = an.col; sc.axes = an.axes;
        render(sc, bmd);
        report(sc);
        fileStudy(sc);
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
  // clicking a stored study reviews it, in whichever of the two views is showing
  $('dxStrip')?.addEventListener('click', (e) => {
    const b = e.target.closest('.dxthumb'); if (!b) return;
    D.histIdx = +b.dataset.i;
    if (ctx.S.bayContent === 'report') dxaReportToBay(); else dxaImageToBay();
  });
  document.querySelectorAll('#dxRigSeg button').forEach((b) => {
    b.addEventListener('click', () => { setRig(b.dataset.rig); parkAtLandmark(); });
  });
  if (D.rig && RIGS[D.rig]) rigCfg = RIGS[D.rig];
  // The regions are dragged on the film itself, so the handlers live on that canvas rather
  // than going through the 3D pointer router — nothing else competes for it in this mode.
  const film = $('film');
  if (film) {
    film.addEventListener('pointerdown', (e) => {
      if (dxaPointer(e, 'down', film)) { film.setPointerCapture(e.pointerId); e.preventDefault(); }
    });
    film.addEventListener('pointermove', (e) => {
      if (ctx.S.mode !== 'dxa') return;
      if (dxaPointer(e, 'move', film)) return;
      film.style.cursor = (D.editRois && hitTest(
        (e.clientX - film.getBoundingClientRect().left) * (film.width / film.getBoundingClientRect().width),
        (e.clientY - film.getBoundingClientRect().top) * (film.height / film.getBoundingClientRect().height)
      )) ? 'move' : '';
    });
    film.addEventListener('pointerup', (e) => dxaPointer(e, 'up', film));
    film.addEventListener('pointercancel', (e) => dxaPointer(e, 'up', film));
  }
  $('dxShowRois')?.addEventListener('change', (e) => {
    D.showRois = e.target.checked; if (scan) redrawRois();
  });
  $('dxEditRois')?.addEventListener('change', (e) => {
    D.editRois = e.target.checked;
    if (D.editRois && !D.showRois) { D.showRois = true; const c = $('dxShowRois'); if (c) c.checked = true; }
    if (scan) redrawRois();
  });
  $('dxRoiReset')?.addEventListener('click', () => {
    if (!scan || !scan.bmdMap) return;
    const an = analyse(scan, scan.bmdMap);             // back to what the machine found
    scan.rois = measure(scan, scan.bmdMap, an.rois);
    scan.col = an.col; scan.axes = an.axes;
    render(scan, scan.bmdMap); report(scan);
  });
  syncPad();
  if (typeof window !== 'undefined') window.__dxa = () => ({ D, scan, acquire, decompose, basis,
    E_LO, E_HI, REGIONS, findLevels, findFemur, analyse, measure, scores, diagnosis, ageMean, REF, CAL,
    THREE: ctx.THREE,
    rig: { scannedRig, bedNode, headNode, laser, rigScale, bedTopY, bedLenCm },
    landmarkTargets, positionError, parkAtLandmark, nudge });
}
