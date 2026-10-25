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
import { Sound } from './audio/sound.js';

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
  /* THE FOREARM runs the same way, from its mark up the limb: the cross an inch distal of the
     ulnar styloid, the sweep toward the elbow. The styloid has to be IN the picture — it is what
     the region is measured from — and with the mark a centimetre out a laser 1.4 cm proximal
     cut it off, well inside the 2 cm the console calls on the mark. An inch keeps it in. Above it
     the one-third site sits a third of the forearm up (8-9 cm on an adult) under a 2 cm region,
     so 16 cm holds it with the laser 2 cm distal. 10 cm across takes both bones and the soft
     tissue either side of them. */
  forearmL: { label: 'Left forearm',  wx: 10, wz: 16 },
  forearmR: { label: 'Right forearm', wx: 10, wz: 16 },
};
export const isForearm = (region) => region === 'forearmL' || region === 'forearmR';
/* Which subject a site is scanned on. The spine and both hips are the chest-abdomen-pelvis volume;
   the forearm is the upper extremity, which carries the radius and ulna whole — the torso volume
   stops at the forearms' middle, with no wrist and no elbow to measure between. */
export const subjectFor = (region) => (isForearm(region) ? 'upperextremity' : 'chestabdopelvis');
/* The reference curve a study is drawn against: the spine's, the total hip's, or the radius's. */
export const chartSite = (region) => (isForearm(region) ? 'radius33' : region === 'spine' ? 'spine' : 'hip');
/* THE LEFT FOREARM IS THE RIGHT ONE MIRRORED. The shipped upper extremity is a RIGHT arm — with
   its shoulder superior (+z) and its olecranon posterior (+y), the bone away from the torso lies
   at -x, which is superior x posterior: a right arm, whatever the build called it. ISCD scans the
   NON-dominant forearm, which for most patients is the left, so the left is made the only way one
   arm can become the other: a mirror across the sagittal plane. To a projection through a forearm
   that is exact — a left forearm IS a right one reflected, to within the patient's own asymmetry.
   app.js's voxelFlips() asks this, so the traced volume and the mesh on the table agree. */
export function dxaMirror() {
  return !!D && D.region === 'forearmL' && ctx?.S.subject === 'upperextremity';
}

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
let landmarks = null, landmarksFor = null, landmarksData = null;
/* Cached per subject and leg rotation (turning the leg moves the greater trochanter), measured
   on the volume and carried to wherever the patient now lies on the table: the long-axis
   landmarks move with the patient's offset (the operator slides the patient between the
   lines), the lateral ones are from the patient's own midline. */
export function findLandmarks(ph) {
  // (the volume itself is part of the key: a posed volume is a new array, and the tests pose
  // the legs with no console to say which angle they are at)
  const key = `${ctx?.S.subject}|${D?.legRot || 0}`;
  if (!(landmarks && landmarksFor === key && landmarksData === ph.data)) {
    landmarks = measureLandmarks(ph); landmarksFor = key; landmarksData = ph.data;
  }
  const dz = ph.min[2] - landmarks.min2;
  if (!dz) return landmarks;
  const sh = (t) => (t ? { ...t, zCm: t.zCm + dz } : t);
  return { ...landmarks, lumbarCm: landmarks.lumbarCm + dz, crestCm: landmarks.crestCm + dz,
    troch: landmarks.troch && { L: sh(landmarks.troch.L), R: sh(landmarks.troch.R) } };
}
function measureLandmarks(ph) {
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
  return { lumbarZ, crestZ, dirSup, min2: ph.min[2],
           lumbarCm: (lumbarZ + 0.5) * vs[2] + ph.min[2],
           crestCm: (crestZ + 0.5) * vs[2] + ph.min[2],
           troch };
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
    /* THEN AT FULL RESOLUTION. The coarse search steps two voxels, so the head's centre could
       only land on every other voxel — and keeping the first sphere of the largest radius it met
       made it jump between neighbours as the leg turned a degree. The neck region is anchored on
       that centre: a 4 mm jump moved femoral-neck BMD 10 % between 19 and 21 degrees of turn-in,
       which the precision assessment read as a 4.6 % neck precision no technologist could fix.
       A ball is not a point anyway: every centre that fits the largest sphere is equally the head's
       centre, so search the neighbourhood voxel by voxel and take the middle of all of them. */
    const ballR = (x, y, z) => {
      if (!isBone(x, y, z)) return 0;
      let r = 1;
      for (; r < 16; r++) {
        if (!isBone(x + r, y, z) || !isBone(x - r, y, z) || !isBone(x, y + r, z)
          || !isBone(x, y - r, z) || !isBone(x, y, z + r) || !isBone(x, y, z - r)) break;
      }
      return r;
    };
    let top = 0, cx = 0, cy = 0, cz = 0, cn = 0;
    for (let z = best.z - 3; z <= best.z + 3; z++) for (let y = best.y - 3; y <= best.y + 3; y++) {
      for (let x = best.x - 3; x <= best.x + 3; x++) {
        const r = ballR(x, y, z);
        if (r > top) { top = r; cx = cy = cz = cn = 0; }
        if (r === top) { cx += x; cy += y; cz += z; cn++; }
      }
    }
    if (cn) best = { r: top, x: cx / cn, y: cy / cn, z: cz / cn };
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
/* THE FOREARM'S OWN. The constant above corrects the torso volume's segmentation, not the
   machine, so it cannot carry over to a different volume, and applied to the arm it read the
   one-third radius at 0.37 g/cm2 — T -5.4 on a skeleton with nothing wrong with it. The arm is
   1 mm CT over a cortex about 2.5 mm thick, and the blur thickens it: the raw one-third radius
   is 0.92 g/cm2 against a population that peaks at 0.694. The cross-calibration is done the
   same way as the spine's — set so the full-mineral forearm reads like the healthy young adult
   it is (T +0.4, beside the spine's +0.54) — and the raw value rides on the report as well. */
export const CAL_FOREARM = 0.79;
export const calFor = (region) => (isForearm(region) ? CAL_FOREARM : CAL);

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

/* THE SCAN AS THE MACHINE RUNS IT (GE Lunar Prodigy, its spec sheet): a narrow fan beam of
   4.5 degrees, lying along the patient's long axis, with AP spine and femur each taking about
   30 s in the standard mode. At the patient, some 35 cm from the focus, the fan is 2.75 cm
   long; the passes overlap by about an eighth, so the arm STEPS 2.4 cm along the table between
   passes, and during each pass the fan sweeps across the field, the source under the table and
   the detector in the head moving together. The femur's field is half the spine's length and
   is run in the same 30 s: half as many passes, each swept at half the speed.
   The picture builds the same way: one band of rows per pass, filled across as the fan sweeps. */
export const SCAN = { STEP_CM: 2.4, SITE_S: { spine: 30, hipL: 30, hipR: 30, forearmL: 30, forearmR: 30 }, MOVE_S: 0.78 };   // (the step sound's length)
export function scanPlan(region) {
  const reg = REGIONS[region] || REGIONS.spine;
  const passes = Math.max(1, Math.round(reg.wz / SCAN.STEP_CM));
  return { passes, stepCm: reg.wz / passes, passS: (SCAN.SITE_S[region] || 30) / passes };
}
let scanClock = null;            // the running scan's timing (null when idle)

/* THE FIELD AND ITS RAYS, set up once and then traced a row at a time. acquire() spreads the rows
   over animation frames behind the moving arm; scanNow() traces them all at once, for the
   precision exercise's repeat scans. One tracer for both, so the repeats measure exactly what a
   scan the operator watches would have measured. */
function setupScan(ph, st) {
  const reg = REGIONS[st.region] || REGIONS.spine;
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
  // (a forearm can have lost more than the rest: hyperparathyroidism takes cortex first)
  const keep = 1 - Math.min(0.6, (st.loss || 0) + (isForearm(st.region) ? st.faLoss || 0 : 0));

  /* THE WINDOW IS WHERE THE OPERATOR PUT THE LASER. It used to be placed on the anatomy
     automatically, which meant the study could not be mispositioned and the pad would have
     been decoration. Now the field is built around the laser: the cross marks the INFERIOR
     edge of the sweep at both sites, because both scans run up the patient — the lumbar
     from the ASIS to T11, the femur from two inches below the trochanter to the acetabulum.
     Drive the arm to the wrong place and the wrong bones land in the window — which is the
     lesson. positionError() tells the console how far off it is. */
  const fa = isForearm(st.region) ? forearmWorld(ph) : null;
  const lm = fa ? null : findLandmarks(ph);
  /* The forearm's field runs from its mark toward the ELBOW, whichever way along the table that
     is: the limb's own long axis says which, as the crest and the spine's taper say it for the
     torso. */
  const dirSup = fa ? fa.up : lm.dirSup;
  const cxW = st.crossX;                            // the laser, across the table (room cm)
  const czW = st.headZ + dirSup * reg.wz / 2;      // the cross is the INFERIOR edge, every site
  const x0 = cxW - reg.wx / 2, z0 = czW - reg.wz / 2;
  // (generous above and below: a rotated limb's far end rises past the volume's unrotated box,
  // and a ray outside the volume adds nothing, so the margin costs nothing either)
  const yBelow = ph.min[1] - 20, yLen = (ph.max[1] - ph.min[1]) + 40;

  // Carry the crest with the scan: it is the only thing in the image that says WHICH
  // vertebra is which, and the analysis needs it after the raster is long finished.
  const tro = lm?.troch?.[st.region === 'hipR' ? 'R' : 'L'];
  /* THE HIP'S LANDMARKS GO WHERE THE PATIENT LIES. They are measured once on the volume as it lies
     unturned, the lateral ones as distances from the patient's own midline — and they used to be
     handed to the analysis as if they were room x. On a patient centred to the millimetre that is
     the same thing; on one lying a centimetre off the line, inside what the console calls centred,
     every femoral region was built a centimetre off the femur, and the neck read 9-19 % different.
     The precision assessment found it: the same hip, repositioned, swung 0.61 to 1.03 g/cm2 at the
     neck. So add the midline, and turn the points with the patient (about the volume's centre, as
     the tracer turns the volume). */
  const ctr = [0, 1, 2].map((k) => (ph.min[k] + ph.max[k]) / 2);
  const placed = (lat, zCm) => {
    const g = [lat, 0, zCm - ctr[2]], R = ph.rotated ? ph.rot : null;
    return R ? [ctr[0] + R[0] * g[0] + R[2] * g[2], ctr[2] + R[6] * g[0] + R[8] * g[2]] : [ctr[0] + g[0], zCm];
  };
  const sgn = st.region === 'hipL' ? -1 : 1;           // world -x is the patient's left
  const trP = tro ? placed(sgn * tro.x, tro.zCm) : null;
  const hdP = tro && tro.headX != null ? placed(sgn * tro.headX, tro.zCm) : null;
  const sc = { nx, nz, lo, hi, truth, x0, z0, px: PX_CM, region: st.region, loss: st.loss || 0,
    crestCm: lm?.crestCm ?? null, dirSup,
    trochZ: trP ? trP[1] : null, trochX: trP ? trP[0] : null,
    headX: hdP ? hdP[0] : null,
    headR: tro && tro.headR != null ? tro.headR : null,
    /* The forearm carries what its analysis needs and cannot see: which side of the picture is
       medial (the console knows which arm is on the table), and the forearm's length, which the
       technologist measured with a tape and keyed in. The length is the operator's, not the
       anatomy's — key in the wrong one and the region lands in the wrong place, as it does on
       the machine. Free scanning with nothing keyed in uses the measured length. */
    forearm: fa ? { up: fa.up, med: fa.med, len: st.forearmLen || fa.len, trueLen: fa.len } : null };
  const pb = basis(), pdet = pb.bLo * pb.sHi - pb.bHi * pb.sLo;
  const prev = sc.preview = new Float32Array(nx * nz);
  const traceRow = (row) => {
    const z = z0 + (row + 0.5) * PX_CM;
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
      const k = row * nx + i;
      lo[k] = aLo; hi[k] = aHi; truth[k] = mineral;
      // the preview is the bone map the study will show, solved as each ray comes in (the low
      // energy alone is mostly soft tissue, and drew the building image washed out white)
      prev[k] = Math.max(0, (aLo * pb.sHi - aHi * pb.sLo) / pdet) * HA_FRACTION;
    }
  };
  return { sc, traceRow };
}

/* A whole scan, traced at once and returned without touching the study on the film. The state
   is explicit — region, loss, the arm (headZ) and laser (crossX), the keyed-in forearm length —
   so the tests can run the real tracer on a real volume. */
export function scanPhantom(ph, st) {
  const job = setupScan(ph, st);
  for (let r = 0; r < job.sc.nz; r++) job.traceRow(r);
  return job.sc;
}
export function scanNow() {
  const ph = ctx.buildPhantom?.();
  if (!ph || ph.geometryOnly || !ph.data) return null;
  if (isForearm(D.region) && !forearmWorld(ph)) return null;
  return scanPhantom(ph, D);
}

export function acquire(onRow, onDone, onPass) {
  const ph = ctx.buildPhantom?.();
  if (!ph || ph.geometryOnly) { setStatus('This subject has no browser volume to scan.'); return; }
  if (isForearm(D.region) && !forearmWorld(ph)) { setStatus('The forearm is not on the table yet.'); return; }
  const job = setupScan(ph, D);
  scan = job.sc;
  const { nx, nz, x0, z0 } = scan;
  rasterRow = 0; scanning = true;
  const plan = scanPlan(D.region);
  const rowsPer = nz / plan.passes;
  scanClock = { t: 0, last: performance.now(), pass: -1, plan, rowsPer, z0, x0, nx, nz, done: false };

  const step = () => {
    if (!scanning) return;
    const t0 = performance.now();
    // trace as many rows as fit in a frame budget (well ahead of the fan, which needs them only
    // when its pass reaches them)
    // (longer when the fan is about to reach rows not traced yet: a slow frame rate must not
    // stall the scan's clock)
    const need = scanClock ? Math.min(nz, Math.ceil((Math.floor(scanClock.t / scanClock.plan.passS) + 2) * scanClock.rowsPer)) : nz;
    const budget = rasterRow < need ? 40 : 10;
    while (rasterRow < nz && performance.now() - t0 < budget) job.traceRow(rasterRow++);
    // the scan's clock: it runs at the operator's chosen speed, and waits for the traced rows
    // if the fan would reach rows not traced yet
    const C = scanClock, now = performance.now();
    const dt = Math.min(0.5, (now - C.last) / 1000) * (D.scanSpeed || 1);
    C.last = now;
    const total = C.plan.passes * C.plan.passS;
    const tNext = Math.min(total, C.t + dt);
    const passAt = (t) => Math.min(C.plan.passes - 1, Math.floor(t / C.plan.passS));
    const rowsNeeded = Math.min(nz, Math.ceil((passAt(tNext) + 1) * C.rowsPer));
    if (rasterRow >= rowsNeeded) C.t = tNext;
    const p = passAt(C.t), tin = C.t - p * C.plan.passS;
    if (p !== C.pass) { C.pass = p; onPass?.(p, C.plan); }
    // the arm steps to this pass (the first MOVE_S of it), then the fan sweeps across, the
    // sweep reversing each pass
    const move = Math.min(1, tin / Math.min(SCAN.MOVE_S, C.plan.passS * 0.3));
    const sweep = Math.max(0, Math.min(1, (tin - Math.min(SCAN.MOVE_S, C.plan.passS * 0.3)) / (C.plan.passS * 0.7)));
    const r0 = Math.round(p * C.rowsPer), r1 = Math.min(nz, Math.round((p + 1) * C.rowsPer));
    const fwd = p % 2 === 0;
    const cols = Math.round(sweep * nx);
    // (the arm eases from the last pass's centre to this one's)
    C.state = { pass: p, passes: C.plan.passes, move, sweep, r0, r1, traced: rasterRow, c0: fwd ? 0 : nx - cols, c1: fwd ? cols : nx,
      armZ: z0 + (Math.max(0, p - 1 + move) + 0.5) * PX_CM * C.rowsPer,
      sweepX: x0 + (fwd ? sweep : 1 - sweep) * nx * PX_CM, frac: C.t / total };
    onRow?.(C.state);
    if (C.t >= total && rasterRow >= nz) { scanning = false; scanClock = null; onDone?.(scan); }
    else rasterTimer = requestAnimationFrame(step);
  };
  step();
  return scan;
}

export function abortScan() {
  scanning = false; scanClock = null;
  if (rasterTimer) cancelAnimationFrame(rasterTimer);
  if (D) { D.scanArmZ = null; syncHead(); }
}
export function isScanning() { return scanning; }
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
  if (isForearm(sc.region)) {
    const f = findForearm(sc, bmd);
    return { rois: f ? f.rois : [], col: null, axes: f ? f.axes : null };
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

/* ---- the forearm ---------------------------------------------------------------
   ISCD's forearm site is the 33 % (one-third) radius of the NON-dominant forearm: a region of the
   radius centred a third of the forearm's length above the ulnar styloid. Nearly all cortical
   bone, which is why it is the site hyperparathyroidism shows first and why it is what is left
   when the spine and hips cannot be measured or the patient is over the table's limit — they sit
   beside the table and lay the forearm on it.

   Two measurements place the region and neither is the machine's alone. The LENGTH is the
   technologist's: ulnar styloid to olecranon with a tape, keyed in. The STYLOID is found in the
   scan, as the console finds it — the tip of the ulna, the reference the region is measured up
   from. This module measures the true versions of both on the volume as well, because the room
   needs them to say where the laser belongs and the tape needs them to have something to read. */
export const FA_SITE = 1 / 3;        // the one-third site, as a fraction of the forearm's length
export const FA_ROI_CM = 2.0;        // the region's height along the shaft

/* THE ULNA, MEASURED ON THE VOLUME (data-index frame, before flips: the anatomy is the same
   whichever way the room lays it). Found by the shapes the forearm makes, not by numbers carried
   from somewhere else:
     - the SHAFT is the longest run of slices cut through exactly two bones: the radius and the
       ulna. The hand has five, the humerus one;
     - the forearm bones are then one 3-D island, flood-filled from the shaft. The elbow joint is
       open in this segmentation, so the island stops at the humerus — while the wrist joint is
       not, so it takes in the carpus and hand too, which costs nothing here;
     - its most proximal point is the OLECRANON, which stands above the radial head;
     - which of the two is the ulna: three centimetres below the olecranon the ulna is the big
       trochlear notch and the radius only its neck. The ulna is the medial bone, which names
       medial without trusting a convention;
     - the STYLOID is the end of the medial border. Walk distally down the ulna's medial edge:
       through the head it moves smoothly, and past the tip of the styloid the most medial bone
       is suddenly something else — the radius or a carpal, centimetres away. */
const faMeasured = new WeakMap();
export function measureForearm(ph) {
  if (!ph?.data) return null;
  if (!faMeasured.has(ph.data)) faMeasured.set(ph.data, measureForearmRaw(ph));
  return faMeasured.get(ph.data);
}
function measureForearmRaw(ph) {
  const aOf = boneEquivById();
  const { nx, ny, nz, data, vs } = ph;
  const sl = nx * ny;
  const isB = (k) => { const id = data[k]; return id < aOf.length && aOf[id] >= 0.35; };
  const lab = new Int32Array(sl), stack = new Int32Array(sl);
  // 2-D islands of bone in slice z (4-connected), optionally only where `keep` says
  const blobs = (z, keep) => {
    lab.fill(0);
    const out = [];
    for (let i = 0; i < sl; i++) {
      const k = z * sl + i;
      if (lab[i] || !(keep ? keep(z, i) : isB(k))) continue;
      const b = { n: 0, sx: 0, sy: 0, xa: nx, xb: -1, i };
      let sp = 0; stack[sp++] = i; lab[i] = out.length + 1;
      while (sp) {
        const j = stack[--sp], x = j % nx, y = (j / nx) | 0;
        b.n++; b.sx += x; b.sy += y; if (x < b.xa) b.xa = x; if (x > b.xb) b.xb = x;
        for (const q of [x > 0 ? j - 1 : -1, x < nx - 1 ? j + 1 : -1, y > 0 ? j - nx : -1, y < ny - 1 ? j + nx : -1]) {
          if (q < 0 || lab[q] || !(keep ? keep(z, q) : isB(z * sl + q))) continue;
          lab[q] = out.length + 1; stack[sp++] = q;
        }
      }
      b.cx = b.sx / b.n; b.cy = b.sy / b.n;
      out.push(b);
    }
    return out;
  };
  const cm2 = vs[0] * vs[1];
  // 1. the shaft: the longest run of slices through exactly two bones of real size
  let run = null, cur = null;
  for (let z = 0; z < nz; z += 2) {
    const two = blobs(z).filter((b) => b.n * cm2 > 0.4).length === 2;
    if (two) { if (!cur) cur = { a: z, b: z }; else cur.b = z; }
    else if (cur) { if (!run || cur.b - cur.a > run.b - run.a) run = cur; cur = null; }
  }
  if (cur && (!run || cur.b - cur.a > run.b - run.a)) run = cur;
  if (!run || (run.b - run.a) * vs[2] < 8) return null;          // no forearm in this volume
  const zm = Math.round((run.a + run.b) / 2);
  // 2. the forearm bones as one island, in a box from below the wrist to above the elbow
  const zA = Math.max(0, run.a - Math.round(14 / vs[2])), zB = Math.min(nz - 1, run.b + Math.round(8 / vs[2]));
  const mask = new Uint8Array(sl * (zB - zA + 1));
  const inM = (z, i) => z >= zA && z <= zB && mask[(z - zA) * sl + i] === 1;
  const fill = new Int32Array(Math.min(mask.length, 4e6));
  let fp = 0;
  for (const b of blobs(zm).filter((q) => q.n * cm2 > 0.4)) {
    const k = (zm - zA) * sl + b.i;
    if (!mask[k]) { mask[k] = 1; fill[fp++] = k; }
  }
  while (fp) {
    const k = fill[--fp], i = k % sl, z = (k / sl | 0) + zA, x = i % nx, y = (i / nx) | 0;
    const nb = [x > 0 ? k - 1 : -1, x < nx - 1 ? k + 1 : -1, y > 0 ? k - nx : -1, y < ny - 1 ? k + nx : -1,
      z > zA ? k - sl : -1, z < zB ? k + sl : -1];
    for (const q of nb) {
      if (q < 0 || mask[q] || !isB(q + zA * sl)) continue;
      if (fp >= fill.length) continue;                            // (a runaway island: stop growing)
      mask[q] = 1; fill[fp++] = q;
    }
  }
  // 3. the olecranon: the island's most proximal 2 mm. +z is superior in the house frame.
  let zTop = -1;
  for (let z = zB; z >= zA && zTop < 0; z--) for (let i = 0; i < sl; i++) if (mask[(z - zA) * sl + i]) { zTop = z; break; }
  const centroid = (za, zb, pick) => {
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let z = za; z <= zb; z++) for (let i = 0; i < sl; i++) {
      if (!inM(z, i) || (pick && !pick(z, i))) continue;
      sx += i % nx; sy += (i / nx) | 0; sz += z; n++;
    }
    return n ? [sx / n, sy / n, sz / n] : null;
  };
  const olec = centroid(zTop - Math.max(1, Math.round(0.2 / vs[2])), zTop);
  // 4. which bone is the ulna, and so which way is medial
  const zu = Math.min(run.b, zTop - Math.round(3 / vs[2]));
  const pair = blobs(zu, inM).filter((b) => b.n * cm2 > 0.1).sort((p, q) => q.n - p.n);
  const medX = pair.length >= 2 ? Math.sign(pair[0].cx - pair[1].cx) || 1 : 1;
  // 5. the styloid: down the ulna's medial border until it breaks
  const edgeAt = (z) => {
    let e = -Infinity;
    for (let i = 0; i < sl; i++) if (inM(z, i)) { const v = medX * (i % nx); if (v > e) e = v; }
    return e;
  };
  const JUMP = 0.4 / vs[0];
  let prev = edgeAt(zm), tip = zm;
  for (let z = zm - 1; z >= zA; z--) {
    const e = edgeAt(z);
    if (!Number.isFinite(e) || Math.abs(e - prev) > JUMP) break;
    prev = e; tip = z;
  }
  // the tip itself: the island the medial-most bone belongs to, in the last slice of the ulna
  const tb = blobs(tip, inM).sort((p, q) => medX * (q.xa + q.xb) - medX * (p.xa + p.xb))[0];
  const styl = tb ? [tb.cx, tb.cy, tip] : [0, 0, tip];
  // 6. the length, and the one-third site: the bones' centroid in a 2 cm slab there
  const d = [0, 1, 2].map((k) => (olec[k] - styl[k]) * vs[k]);
  const len = Math.hypot(d[0], d[1], d[2]);
  const u = d.map((v) => v / len);
  const tOf = (z, i) => ((i % nx) - styl[0]) * vs[0] * u[0] + (((i / nx) | 0) - styl[1]) * vs[1] * u[1] + (z - styl[2]) * vs[2] * u[2];
  const c33 = centroid(zA, zB, (z, i) => Math.abs(tOf(z, i) - len * FA_SITE) <= FA_ROI_CM / 2);
  return { styl, olec, c33, len, medX };
}

/* A data-index point into the room, through the phantom's own flips, rotation and placement —
   the inverse of the map trace() applies to its rays. `rotate: false` gives the rest frame, before
   the operator has turned anything. */
function volToWorld(ph, p, rotate = true) {
  const n = [ph.nx, ph.ny, ph.nz];
  const g = [0, 1, 2].map((k) => ((ph.flip[k] ? n[k] - 1 - p[k] : p[k]) + 0.5) * ph.vs[k] - ph.extent[k] / 2);
  const c = [0, 1, 2].map((k) => (ph.min[k] + ph.max[k]) / 2);
  const R = rotate && ph.rotated ? ph.rot : null;
  if (!R) return [c[0] + g[0], c[1] + g[1], c[2] + g[2]];
  return [c[0] + R[0] * g[0] + R[1] * g[1] + R[2] * g[2], c[1] + R[3] * g[0] + R[4] * g[1] + R[5] * g[2],
    c[2] + R[6] * g[0] + R[7] * g[1] + R[8] * g[2]];
}
/* The forearm as it lies on the table now: styloid, olecranon and the one-third site in room
   cm; which way along the table the elbow is (up) and which way across it is medial (med, in
   room x — columns of the scan rise with it); and how far the forearm is from lying straight
   along the table (yaw) and flat on it (pitch), in degrees. */
export function forearmWorld(ph, rotate = true) {
  if (ctx && ctx.S.subject !== 'upperextremity') return null;
  const m = measureForearm(ph);
  if (!m) return null;
  const W = (p) => volToWorld(ph, p, rotate);
  const styl = W(m.styl), olec = W(m.olec), site = W(m.c33);
  const ulnaSite = W(m.styl.map((v, k) => v + (m.olec[k] - v) * FA_SITE));
  const up = Math.sign(olec[2] - styl[2]) || 1;
  const a = [0, 1, 2].map((k) => (olec[k] - styl[k]) * up);
  const deg = 180 / Math.PI;
  return { styl, olec, site, len: m.len, up, med: Math.sign(ulnaSite[0] - site[0]) || 1,
    axis: a, yaw: Math.atan2(a[0], a[2]) * deg, pitch: Math.atan2(a[1], Math.hypot(a[0], a[2])) * deg };
}
/* The rotate and tilt that lay this forearm straight along the table and flat on it — what the
   free-scanning preset does for the operator, as it parks the arm at the spine's mark. The
   object turns as Rz·Ry·Rx: tilt about x first brings the forearm's rise to zero, then the turn
   about the vertical swings it parallel to the table. */
export function forearmAlignment(ph) {
  const fa = forearmWorld(ph, false);
  if (!fa) return null;
  const [ax, ay, az] = fa.axis;
  const rx = Math.atan(ay / az);
  const z1 = Math.sin(rx) * ay + Math.cos(rx) * az;
  const ry = Math.atan(-ax / z1);
  return { x: Math.round(rx * 180 / Math.PI), y: Math.round(ry * 180 / Math.PI) };
}

/* ---- the one-third region, found in the scan ----------------------------------------
   Rows are along the forearm (+row toward the elbow when sc.forearm.up is +1) and columns across
   it, medial toward higher columns when sc.forearm.med is +1. The analysis:
     1. starts on the shaft, at the proximal end of the field, where every row crosses two bones;
     2. walks DISTALLY down the medial border — the ulna's — until it breaks: the styloid's tip;
     3. goes back up the forearm by a third of the keyed-in length, and there
     4. takes the RADIUS — the lateral of the two bones — over a 2 cm band. Its edges follow the
        bone, as the femoral regions do, so what is averaged is mineral and not the gap between
        the bones.
   If the two bones overlap in the band — the forearm rolled toward pronation, the radius crossed
   over the ulna — there is one run where there should be two, and the region says so rather than
   averaging both bones as one. */
export function findForearm(sc, bmd) {
  const { nx, nz, px } = sc, fa = sc.forearm;
  if (!fa) return null;
  const BONE = 0.12;                                 // g/cm2 of HA: bone, not the soft tissue's floor
  const up = fa.up >= 0 ? 1 : -1, med = fa.med >= 0 ? 1 : -1;
  const runsAt = (r) => {
    const out = [];
    let a = -1;
    for (let i = 0; i <= nx; i++) {
      const on = i < nx && bmd[r * nx + i] > BONE;
      if (on && a < 0) a = i;
      else if (!on && a >= 0) { if ((i - a) * px >= 0.25) out.push({ a, b: i - 1 }); a = -1; }
    }
    return out;
  };
  const edge = (runs) => (med > 0 ? Math.max(...runs.map((q) => q.b)) : -Math.min(...runs.map((q) => q.a)));
  // 1. the most proximal row that crosses both bones
  let r0 = -1;
  for (let k = 0; k < nz && r0 < 0; k++) { const r = up > 0 ? nz - 1 - k : k; if (runsAt(r).length >= 2) r0 = r; }
  if (r0 < 0) return { rois: [], axes: { why: 'no forearm in the field' } };
  // 2. down the medial border to the styloid's tip
  const JUMP = 0.4 / px;
  let prev = edge(runsAt(r0)), sR = r0, broke = false;
  for (let r = r0 - up; r >= 0 && r < nz; r -= up) {
    const runs = runsAt(r);
    if (!runs.length) { broke = true; break; }
    const e = edge(runs);
    if (Math.abs(e - prev) > JUMP) { broke = true; break; }
    prev = e; sR = r;
  }
  // 3. a third of the forearm up from the tip
  const siteRow = sR + up * (fa.len * FA_SITE) / px;
  const h = FA_ROI_CM / 2 / px;
  const ra = Math.round(siteRow - h), rb = Math.round(siteRow + h);
  const axes = { styloidRow: sR, siteRow, ra, rb, len: fa.len };
  // a border that runs off the distal edge of the field never found its tip: the laser is too
  // far up the forearm, and a region measured from the edge of the picture is measured from nothing
  if (!broke || sR === r0) return { rois: [], axes: { ...axes, why: 'the ulnar styloid is not in the field' } };
  if (ra < 0 || rb > nz) return { rois: [], axes: { ...axes, why: 'the one-third site is outside the field' } };
  // 4. the radius over the band
  const mask = new Uint8Array(nx * nz);
  let overlap = 0;
  for (let r = ra; r < rb; r++) {
    const runs = runsAt(r);
    if (!runs.length) continue;
    if (runs.length < 2) overlap++;
    const q = runs.reduce((p, s) => (med * (p.a + p.b) <= med * (s.a + s.b) ? p : s));   // the lateral run
    for (let c = q.a; c <= q.b; c++) mask[r * nx + c] = 1;
  }
  axes.overlap = overlap > (rb - ra) / 4;
  return { rois: [{ label: 'Radius 33%', mask, site: 'radius33' }], axes };
}

/* ---- the numbers on the report ---------------------------------------------
   BMC is the mineral actually in the box (g); AREA is the box's projected area (cm2);
   BMD is one divided by the other. That order matters — BMD is a RATIO, which is why a
   bigger box does not automatically mean a bigger number, and why moving an ROI edge
   changes the answer in a way the operator has to own. */
export function measure(sc, bmd, rois) {
  const a = sc.px * sc.px;                       // cm2 per pixel
  const CAL = calFor(sc.region);
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
  /* THE ONE-THIRD RADIUS, on the same scale as the rows above (these are Hologic/NHANES III
     numbers: the spine's 1.047 +- 0.110 and the total hip's 0.942 +- 0.122 are exactly theirs).
     Peak BMD 0.694 g/cm2, population SD 0.060 — the ISCD DXA Atlas case "Improper Forearm
     Acquisition", which quotes the one-third radius against the ultradistal (0.694 vs 0.443,
     SDs 0.060 vs 0.058) to show what a region placed too far distally does to a T-score. The
     SD is a twelfth of the mean where the spine's is a tenth: the site is nearly all cortex,
     which varies less between people than trabecular bone does.
     No male table comes with it, so men are scored against the same one. That is also what
     ISCD (2019) recommends for men at every site — a uniform white female reference — so it is
     the defensible choice, not only the available one; the report says so. */
  radius33: { f: { yMean: 0.694, ySD: 0.060 }, m: { yMean: 0.694, ySD: 0.060 } },
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
/* WHICH SCORE CLASSIFIES. The WHO categories are defined on T, and ISCD applies them only to
   postmenopausal women and men of 50 and over. Below 50 (premenopausal women, younger men) the
   report classifies on Z: at or below -2.0 is "below the expected range for age", above it is
   "within", and osteoporosis is not diagnosed on BMD alone. The simulation has no menopausal
   status, so 50 stands in for it, as it does on most consoles. `by` says which score decided;
   `cls` is the CSS suffix for the banner. */
export const ISCD_Z_AGE = 50;
export function classify(T, Z, age) {
  if (age < ISCD_Z_AGE) {
    const below = Z <= -2.0;
    return { label: below ? 'Below expected range for age' : 'Within expected range for age',
             by: 'Z', cls: below ? 'below' : 'within' };
  }
  const label = diagnosis(T);
  return { label, by: 'T', cls: label.toLowerCase() };
}

function setStatus(t) { const el = $('dxStatus'); if (el) el.textContent = t; }

/* ---- display ---------------------------------------------------------------- */
let dxCanvas = null;
export function render(sc, bmd, upto, part = null) {
  const film = $('film'); if (!film || !sc) return;
  const { nx, nz } = sc;
  if (!dxCanvas) { dxCanvas = document.createElement('canvas'); }
  if (dxCanvas.width !== nx || dxCanvas.height !== nz) { dxCanvas.width = nx; dxCanvas.height = nz; }
  const g = dxCanvas.getContext('2d');
  const img = g.createImageData(nx, nz);
  const rows = part ? part.r1 : upto == null ? nz : Math.min(nz, upto);
  // window on the bone-mineral map: 0 to ~1.6 g/cm2 covers spine and hip
  /* WINDOW ON A PERCENTILE, NOT THE PEAK. Scaling to the brightest pixel works at the spine,
     where the brightest thing IS the anatomy. At the hip a single ray can catch ilium,
     acetabulum, femur and ischium end-on and come back at 7 g/cm2 — five times the femur —
     and everything the study is about gets squeezed into the bottom fifth of the greyscale.
     Clipping at the 99th percentile throws away that one hot ray and gives the femur the
     range instead. It is a display window and nothing more: no measurement reads this. */
  const src = bmd || sc.lo;
  // (the window over every row traced, not just the ones shown: it holds still as the image builds)
  const n = (part ? Math.max(rows, part.traced || 0) : rows) * nx;
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
    const inPass = part && sy >= part.r0;         // (the pass under way: only what the fan has crossed)
    for (let dx = 0; dx < nx; dx++) {
      const sx = nx - 1 - dx;                     // patient's right to the viewer's left
      const v = scanned && (!inPass || (sx >= part.c0 && sx < part.c1)) ? Math.min(1, src[sy * nx + sx] / hiV) ** 0.7 * 255 : 0;
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
  Wards: [255, 120, 160], Total: null, 'Radius 33%': [64, 220, 120] };
/* The forearm's two reference lines, which are what the region hangs from: the styloid's tip,
   found in the image, and the one-third level a keyed-in length above it. */
function drawForearmLines(g, sc, s, ox, oy) {
  const a = sc.axes;
  if (!a || a.styloidRow == null) return;
  const yOf = (row) => (sc.nz - 1 - row + 0.5) * s + oy;
  g.save();
  g.setLineDash([5, 4]); g.lineWidth = 1; g.font = '10px ui-monospace, monospace';
  for (const [row, txt, col] of [[a.styloidRow, 'ulnar styloid', '#ffcf3a'], [a.siteRow, '1/3', '#8dffc0']]) {
    if (row < 0 || row > sc.nz) continue;
    g.strokeStyle = col; g.fillStyle = col;
    g.beginPath(); g.moveTo(ox, yOf(row)); g.lineTo(ox + sc.nx * s, yOf(row)); g.stroke();
    g.fillText(txt, ox + 4, yOf(row) - 3);
  }
  g.restore();
}
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
  if (!D.showRois) return;
  if (isForearm(sc.region)) drawForearmLines(g, sc, s, ox, oy);
  if (!sc.rois || !sc.rois.length) return;
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
/* THE DIAGNOSIS IS THE LOWER OF TWO SITES. WHO/ISCD apply the thresholds at the femoral neck
   AND the total hip and classify on whichever is worse; scoring the total alone let a neck at
   T -2.6 sit under a "Normal" banner because the trochanter held the total up. The headline
   area and mass stay on the total hip — that is the site a follow-up is tracked on — but the
   T and Z that drive the banner come from the deciding site, and say which it was.
   Pure, so the rule can be tested without a scan. */
export function hipDiagnosis(rois, sex, age) {
  const tot = rois.find((r) => r.label === 'Total') || rois[0];
  if (!tot) return { mean: 0, T: 0, Z: 0, totT: 0, totZ: 0, area: 0, bmc: 0, site: 'total hip', dx: classify(0, 0, age).label };
  const sT = scores(tot.bmd, 'total', sex, age);
  const neck = rois.find((r) => r.label === 'Neck');
  const sN = neck ? scores(neck.bmd, 'neck', sex, age) : null;
  // the lower site on whichever score classifies: Z below 50, T from 50 (classify)
  const k = age < ISCD_Z_AGE ? 'Z' : 'T';
  const useNeck = !!(sN && sN[k] < sT[k]);
  const s = useNeck ? sN : sT;
  return { mean: tot.bmd, T: s.T, Z: s.Z, totT: sT.T, totZ: sT.Z, area: tot.area, bmc: tot.bmc,
           site: useNeck ? 'femoral neck' : 'total hip', dx: classify(s.T, s.Z, age).label };
}
const FEMUR_ORDER = ['Neck', 'Wards', 'Troch', 'Inter', 'Total'];
export function report(sc) {
  const tb = $('dxTable'); if (!tb || !sc.rois) return;
  if (isForearm(sc.region)) { reportForearm(sc, tb); return; }
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
    const h = hipDiagnosis(rows, sex, age);
    mean = h.mean; s = { T: h.T, Z: h.Z };
    head = 'Total hip';
    sc.areaT = h.area; sc.bmcT = h.bmc;
    sc.totT = h.totT; sc.totZ = h.totZ; sc.dxSite = h.site;
  }
  const cl = classify(s.T, s.Z, age), dx = cl.label;
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
    + `<div class="dxdx dx-${cl.cls}">${dx} &middot; T ${s.T.toFixed(1)} &middot; Z ${s.Z.toFixed(1)}`
    + (spine ? '' : ` <span class="dxsite">(${sc.dxSite})</span>`)
    + (cl.by === 'Z'
      ? `<small>Under ${ISCD_Z_AGE} (ISCD): classified by Z &middot; below the expected range for age at Z &le; &minus;2.0 &middot; the WHO T-score categories do not apply</small></div>`
      : `<small>WHO: normal &ge; &minus;1.0 &middot; osteopenia &minus;1.0 to &minus;2.5 &middot; osteoporosis &le; &minus;2.5</small></div>`);
  sc.mean = mean; sc.T = s.T; sc.Z = s.Z; sc.dx = dx;
  renderSerial();
}
/* THE FOREARM'S PAGE is one region and one row: ISCD diagnoses on the 33 % radius and recommends
   no other forearm region, so the ultradistal and the ulna, which a console would also print,
   are not offered as things to read. The note says where the region came from — a third of the
   keyed-in length above the styloid — because that length is the operator's and is the first
   thing to check when a forearm result surprises. */
function reportForearm(sc, tb) {
  const sex = D.sex || 'f', age = D.age || 60;
  const r = sc.rois[0];
  const why = sc.axes?.why;
  if (!r) {
    tb.innerHTML = `<div class="dxdx dx-below">No region &middot; ${why || 'the radius was not found'}`
      + '<small>Re-centre the laser an inch distal of the ulnar styloid and scan again.</small></div>';
    sc.mean = 0; sc.T = sc.Z = 0; sc.dx = 'No region'; sc.areaT = sc.bmcT = 0;
    return;
  }
  const s = scores(r.bmd, 'radius33', sex, age), cl = classify(s.T, s.Z, age);
  sc.areaT = r.area; sc.bmcT = r.bmc; sc.dxSite = '33% radius';
  tb.innerHTML = '<table class="dxtab"><tr><th>Region</th><th>Area<br><small>cm²</small></th>'
    + '<th>BMC<br><small>g</small></th><th>BMD<br><small>g/cm²</small></th><th>T</th><th>Z</th>'
    + '<th class="dxraw">raw</th></tr>'
    + `<tr class="dxsum"><td>${r.label}</td><td>${r.area.toFixed(1)}</td><td>${r.bmc.toFixed(2)}</td>`
    + `<td><b>${r.bmd.toFixed(3)}</b></td><td><b>${s.T.toFixed(1)}</b></td><td>${s.Z.toFixed(1)}</td>`
    + `<td class="dxraw">${r.bmdRaw.toFixed(2)}</td></tr></table>`
    + `<div class="dxnote">Centred ${(sc.forearm.len * FA_SITE).toFixed(1)} cm above the ulnar styloid: a third of the `
    + `${sc.forearm.len.toFixed(1)} cm forearm length keyed in (styloid to olecranon).`
    + (sc.axes?.overlap ? ' <b>The radius and ulna overlap in the region</b> &mdash; the forearm is rolled; lay it flat and rescan.' : '')
    + '</div>'
    + `<div class="dxdx dx-${cl.cls}">${cl.label} &middot; T ${s.T.toFixed(1)} &middot; Z ${s.Z.toFixed(1)} <span class="dxsite">(33% radius)</span>`
    + (cl.by === 'Z'
      ? `<small>Under ${ISCD_Z_AGE} (ISCD): classified by Z &middot; below the expected range for age at Z &le; &minus;2.0</small></div>`
      : '<small>WHO: normal &ge; &minus;1.0 &middot; osteopenia &minus;1.0 to &minus;2.5 &middot; osteoporosis &le; &minus;2.5</small></div>');
  sc.mean = r.bmd; sc.T = s.T; sc.Z = s.Z; sc.dx = cl.label;
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
  if (D.intake && D.patient?.fromIntake === D.intake.seed) return D.patient;
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
    mean: sc.mean, T: sc.T, Z: sc.Z, dx: sc.dx, dxSite: sc.dxSite, totT: sc.totT, totZ: sc.totZ, loss: sc.loss || 0, faLen: sc.forearm?.len ?? null,
    area: areaT, bmc: bmcT,
    age: D.age, weight: D.weight, sex: D.sex,
    when: new Date(), patient: patientOf(),
    intake: D.intake ? { indication: D.intake.indication, risks: D.intake.risks.slice(),
      answers: D.intake.fields.map((f) => [f.q, f.a]) } : null,
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
  const site = chartSite(entry.region);
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
  drawAgeChart(c1, { site: chartSite(e.region), sex: e.sex,
    points: [{ age: e.age, bmd: e.mean }] });
  const c2 = document.createElement('canvas'); c2.width = 700; c2.height = 260;
  if (hist.length > 1) trendChart(c2, e, hist);
  host.innerHTML = reportHTML(e, hist, { age: c1.toDataURL(), trend: c2.toDataURL() }, D.precision);
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

/* ---- precision, and the LSC it earns ----------------------------------------------------
   The 1.5 % above is a placeholder, and ISCD says what replaces it: every technologist does a
   PRECISION ASSESSMENT — the same patients scanned repeatedly, getting off the table and back on
   between scans (15 patients x 3, or 30 x 2: 30 degrees of freedom either way) — and the scatter
   of those repeats is what a follow-up change has to clear.
     precision = the root-mean-square SD of the repeats: pool the per-patient variances weighted
       by their degrees of freedom and take the root. Not the mean SD — SDs do not average, the
       variances do (Gluer et al., Osteoporos Int 1995) — and with every patient scanned the same
       number of times it is exactly sqrt(mean of SD^2).
     %CV   = the same pooling over each patient's SD / mean, which is what the ISCD minimums are
       stated in, since it compares a dense skeleton with a thin one.
     LSC   = 2.77 x precision, at 95 % confidence: a change is the difference of TWO measurements,
       each with that error, so its SD is precision x sqrt(2), and 1.96 x sqrt(2) = 2.77.
   ISCD prefers the LSC in g/cm2 (it does not drift with the patient's own BMD), so a follow-up is
   judged on that, with the % alongside. */
export const LSC_Z = 2.77;
/* The poorest precision ISCD accepts from one technologist, %CV, and the LSC that follows (2019
   official positions). Worse than this, retrain and repeat the assessment. */
export const ISCD_MIN_PRECISION = {
  spine: { cv: 1.9, lsc: 5.3, label: 'Lumbar spine' },
  total: { cv: 1.8, lsc: 5.0, label: 'Total hip' },
  neck:  { cv: 2.5, lsc: 6.9, label: 'Femoral neck' },
};
export const ISCD_MIN_DF = 30;
/* groups: one array of BMD values per patient (g/cm2). A patient scanned once tells nothing about
   precision and contributes no degrees of freedom, so is left out rather than counted as zero. */
export function precisionStats(groups) {
  let df = 0, ss = 0, cc = 0, sum = 0, n = 0;
  const per = [];
  for (const g of groups) {
    const k = g.length;
    if (k < 2) continue;
    const m = g.reduce((s, v) => s + v, 0) / k;
    const v = g.reduce((s, x) => s + (x - m) ** 2, 0) / (k - 1);      // the patient's own variance
    per.push({ n: k, mean: m, sd: Math.sqrt(v), cv: 100 * Math.sqrt(v) / m });
    df += k - 1; ss += (k - 1) * v; cc += (k - 1) * (v / (m * m));
    sum += m * k; n += k;
  }
  if (!df) return { df: 0, m: 0, per, rmsSd: 0, cvPct: 0, lscAbs: 0, lscPct: 0, mean: 0 };
  const rmsSd = Math.sqrt(ss / df), cvPct = 100 * Math.sqrt(cc / df);
  return { df, m: per.length, per, mean: sum / n, rmsSd, cvPct, lscAbs: LSC_Z * rmsSd, lscPct: LSC_Z * cvPct };
}
/* Whether an assessment meets ISCD: enough degrees of freedom to be one at all, and a %CV no worse
   than the minimum for the site. */
export function precisionVerdict(site, st) {
  const min = ISCD_MIN_PRECISION[site];
  return { enough: st.df >= ISCD_MIN_DF, ok: !!min && st.df > 0 && st.cvPct <= min.cv, min };
}
/* The LSC a follow-up of this region is judged on: the technologist's own, when an assessment of
   that site is on file, else the placeholder — and it says which, because a significance bar
   nobody measured should never be read as one somebody did. The hip's trend is the total hip. */
export const precisionSite = (region) => (region === 'spine' ? 'spine' : region === 'hipL' || region === 'hipR' ? 'total' : null);
export function lscFor(region, prec) {
  const p = prec?.[precisionSite(region)];
  return p ? { abs: p.lscAbs, pct: p.lscPct, measured: true, when: p.when, df: p.df }
    : { abs: null, pct: LSC_PCT, measured: false };
}
/* Change from the prior study, and whether it clears the LSC: in g/cm2 when the LSC was measured,
   in % against the placeholder otherwise. */
export function changeVs(prev, cur, lsc) {
  const d = cur - prev, pc = 100 * (cur / prev - 1);
  const sig = lsc.abs != null ? Math.abs(d) >= lsc.abs : Math.abs(pc) >= lsc.pct;
  return { d, pc, sig };
}
export function keepScan(sc) {
  if (!sc || !sc.rois) return;
  D.scans.unshift({ region: sc.region, mean: sc.mean, T: sc.T, Z: sc.Z, dx: sc.dx,
                    loss: sc.loss, when: D.scans.length });
  if (D.scans.length > 6) D.scans.length = 6;
  renderSerial();
}
/* The scan a change is measured against: the next older one of the SAME site. Comparing with
   whatever was filed just before meant a spine, a femur, then a spine again showed no change on
   the second spine, and the serial table went blank as soon as sites were interleaved. Newest
   first, as D.scans is kept. */
export function priorScan(list, i) {
  for (let j = i + 1; j < list.length; j++) if (list[j].region === list[i].region) return list[j];
  return null;
}
export function renderSerial() {
  const el = $('dxSerial'); if (!el) return;
  const list = D.scans || [];
  if (!list.length) { el.innerHTML = '<div class="note">No stored scans. KEEP files the current one.</div>'; return; }
  const rows = list.map((s, i) => {
    const prev = priorScan(list, i);
    let chg = '—', cls = '';
    if (prev) {
      const c = changeVs(prev.mean, s.mean, lscFor(s.region, D.precision));
      chg = `${c.pc > 0 ? '+' : ''}${c.pc.toFixed(1)} %`;
      cls = c.sig ? (c.pc < 0 ? 'dxdown' : 'dxup') : 'dxflat';
      if (!c.sig) chg += ' *';
    }
    return `<tr><td>${REGIONS[s.region]?.label.split(' ').pop() || s.region}</td>`
      + `<td>${(100 * s.loss).toFixed(0)} %</td><td><b>${s.mean.toFixed(3)}</b></td>`
      + `<td>${s.T.toFixed(1)}</td><td class="${cls}">${chg}</td></tr>`;
  }).join('');
  // the bar each site is judged against, and where it came from
  const bars = [...new Set(list.map((s) => s.region))].map((r) => {
    const l = lscFor(r, D.precision), name = REGIONS[r]?.label.split(' ').pop() || r;
    return l.measured ? `${name} ${l.abs.toFixed(3)} g/cm² (${l.pct.toFixed(1)} %, your precision assessment)`
      : `${name} ${l.pct} % (placeholder: no precision assessment on file)`;
  });
  el.innerHTML = '<table class="dxtab"><tr><th>Site</th><th>Loss</th><th>BMD</th><th>T</th>'
    + '<th>Change</th></tr>' + rows + '</table>'
    + `<div class="note" style="margin-top:6px">* below the least significant change &mdash; that is `
    + `the machine and the operator, not the patient. LSC: ${bars.join('; ')}.</div>`;
}

/* ---- mode + wiring --------------------------------------------------------- */
export function dxaApplyMode(on) {
  if (!ctx) return;
  dockConsole(on, $('dxScanRow'));
  if (on) {
    if (ctx.S.subject !== subjectFor(D.region)) ctx.setSubject?.(subjectFor(D.region));
    Sound.need('dxa');
    setStatus('Ready — pick a region and scan.');
    D.region = D.region || 'spine';
    setTimeout(() => parkWhenReady(), 60);   // as soon as the subject's volume is in place
  } else abortScan();
  dxaSyncScene();
}

/* THE ROOM'S MACHINE (dxaRoom.js): the table stands still; the arm (pillar, head, and the source
   carriage under the table) travels along it. */
// (the room's model is loaded when the room is built: it needs three.js, and the analysis in this
// module is tested in node without it)
let R3 = null, room = null, laser = null, block = null, holder = null, legs = null, legsKey = '';
const TABLE_LEN_CM = 263;            // the table's length (dxaRoom.js LUNAR.LEN)
const HOLDER_AT = 82;                 // cm from the thighs' stumps to the foot holder: the heels
export function dxaSyncScene() {
  if (!ctx || !room) return;
  const on = ctx.S.mode === 'dxa';
  room.table.visible = room.arm.visible = on;
  const three = ctx.three;
  if (!on) { dxaHideExtras(); return; }
  syncHead();
  syncProps();
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
export function dxaHideExtras() {
  if (laser) laser.visible = false;
  for (const o of [block, holder, legs]) if (o) o.visible = false;
}

/* Drive the arm and its laser to wherever the pad has put them. The arm travels along the
   couch only; the laser's cross slides across the table independently, which is what the
   left/right keys on a real console do: they re-centre the measuring field, not the arm.
   During a scan the arm follows the passes (D.scanArmZ) and the laser is off. */
function syncHead() {
  if (!room) return;
  const z = D.scanArmZ ?? D.headZ;
  room.arm.position.set(0, 0, z);
  if (laser) {
    laser.visible = ctx.S.mode === 'dxa' && D.scanArmZ == null;
    laser.position.set(D.crossX, LASER_Y, D.headZ);
  }
}

/* THE KNEE BLOCK, THE FOOT HOLDER AND THE LEGS. D.props is what the operator has placed:
   'block' (spine), 'holder' (hip) or null. The legs are drawn from the volume's thigh stumps,
   carried with the patient, in the pose the prop gives them; with no prop they lie straight. */
let stumpsFor = null, stumpsRest = null;
function thighStumps(vm) {
  // the volume's INFERIOR end (the landmarks know which way is up), a couple of centimetres in:
  // the tissue lateral of the midline on each side is a thigh, its centroid and radius the
  // stump the phantom leg is drawn from (rest frame, cm). The pelvis volume ends below the
  // buttocks with the thighs still joined across the perineum, so they are split at the midline.
  if (stumpsFor === vm && stumpsRest) return stumpsRest;
  stumpsFor = vm; stumpsRest = null;
  if (!vm?.data) return null;
  let up = 1;
  try { const ph = ctx.buildPhantom?.(); if (ph?.data) up = findLandmarks(ph).dirSup || 1; } catch { /* keep +z */ }
  const [nx, ny, nz] = vm.dims, sp = vm.spacingMM.map((v) => v / 10), d = vm.data;
  const end = up > 0 ? 0 : nz - 1, dir = up > 0 ? 1 : -1;
  let k = end;
  const count = (kk) => { let n = 0; for (let j = 0; j < ny; j += 2) for (let i = 0; i < nx; i += 2) if (d[(kk * ny + j) * nx + i]) n++; return n; };
  while (k >= 0 && k < nz && count(k) < 400) k += dir;
  k += dir * Math.round(2 / sp[2]);
  if (k < 0 || k >= nz) return null;
  const st = [{ n: 0, x: 0, y: 0 }, { n: 0, x: 0, y: 0 }];
  for (let j = 0; j < ny; j += 2) for (let i = 0; i < nx; i += 2) {
    if (!d[(k * ny + j) * nx + i]) continue;
    const x = (i - (nx - 1) / 2) * sp[0], y = (j - (ny - 1) / 2) * sp[1];
    if (Math.abs(x) < 2) continue;
    const s2 = st[x < 0 ? 0 : 1]; s2.n++; s2.x += x; s2.y += y;
  }
  if (st.some((q) => q.n < 20)) return null;
  stumpsRest = st.map((q) => ({ p: [q.x / q.n, q.y / q.n, (k - (nz - 1) / 2) * sp[2]],
    r: Math.min(9, Math.max(5.5, Math.sqrt(q.n * 4 * sp[0] * sp[1] / Math.PI) * 0.8)), down: -up }));
  return stumpsRest;
}
function syncProps() {
  if (!R3) return;
  const { buildBlock, buildHolder, buildLegs, BLOCK } = R3;
  if (!block) { block = buildBlock(); ctx.three.handGroup.parent.add(block); }
  if (!holder) { holder = buildHolder(); ctx.three.handGroup.parent.add(holder); }
  // The forearm patient sits beside the table with only the arm on it: no block, no holder, and
  // no legs to draw — the arm volume's lower end is a hand, not a pair of thighs.
  if (ctx.S.subject !== 'chestabdopelvis') {
    block.visible = holder.visible = false; if (legs) legs.visible = false;
    return;
  }
  const pose = ctx.phantomPose?.();
  const st = thighStumps(ctx.S.voxelModel);
  const prop = D.props || null;
  block.visible = prop === 'block'; holder.visible = prop === 'holder';
  if (!pose || !st) { if (legs) legs.visible = false; return; }
  const R = pose.rot, c = pose.center;
  const toRoom = (q) => [c[0] + R[0] * q[0] + R[1] * q[1] + R[2] * q[2], c[1] + R[3] * q[0] + R[4] * q[1] + R[5] * q[2],
    c[2] + R[6] * q[0] + R[7] * q[1] + R[8] * q[2]];
  const stumps = st.map((s) => ({ p: toRoom(s.p), r: s.r }));
  const along = toRoom([0, 0, st[0].down]).map((v, i) => v - c[i]);       // toward the feet, in the room
  const mid = [(stumps[0].p[0] + stumps[1].p[0]) / 2, 0, (stumps[0].p[2] + stumps[1].p[2]) / 2];
  // the block's near face a hand's breadth past the buttocks; the holder between the heels
  const n = Math.hypot(along[0], along[2]) || 1, ax = along[0] / n, az = along[2] / n;
  block.position.set(mid[0] + ax * (12 + BLOCK.D / 2), 0, mid[2] + az * (12 + BLOCK.D / 2));
  block.rotation.y = Math.atan2(ax, az);
  holder.position.set(mid[0] + ax * HOLDER_AT, 0, mid[2] + az * HOLDER_AT);
  holder.rotation.y = Math.atan2(ax, az);
  const key = JSON.stringify([prop, stumps.map((s) => s.p.map((v) => v.toFixed(1))), D.legRot]);
  if (key !== legsKey) {
    legsKey = key;
    if (legs) { legs.parent?.remove(legs); legs.traverse((o) => { if (o.isMesh) o.geometry.dispose(); }); }
    legs = buildLegs(stumps, prop === 'block' ? 'block' : 'holder', along,
      { holderAt: prop === 'holder' ? [holder.position.x, 0, holder.position.z] : null });
    ctx.three.handGroup.parent.add(legs);
  }
  legs.visible = true;
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
  /* The forearm: the cross an inch distal of the ulnar styloid, across the table on the
     forearm's middle at the one-third site, so the field holds both bones where it matters. */
  if (isForearm(D.region)) {
    const fa = forearmWorld(ph);
    if (!fa) return null;
    return { z: fa.styl[2] - fa.up * INCH, x: fa.site[0], label: '1 in distal of the ulnar styloid, on the forearm' };
  }
  if (ctx.S.subject !== 'chestabdopelvis') return null;      // (the arm, before the torso is back)
  let lm = null;
  try { lm = findLandmarks(ph); } catch { return null; }
  if (!lm) return null;
  const cx = (ph.min[0] + ph.max[0]) / 2;        // the patient's midline on the table
  if (D.region === 'spine') {
    /* The landmark scan finds the ILIAC CREST, whose summit sits about the L4-L5 interspace.
       The ASIS is a good 7 cm inferior to it — not the 2 cm this used to assume, which put
       the whole field two levels too high and had it analysing T12. From the ASIS the laser
       goes 1 inch up, and that marks the INFERIOR edge of the sweep, so the window opens at
       L5-S1 and runs superiorly to T11-T12. */
    const asis = lm.crestCm - lm.dirSup * 7;
    return { z: asis + lm.dirSup * INCH, x: cx, label: '1 in above the ASIS midline' };
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
  return { z: gt - lm.dirSup * 2 * INCH, x: cx + (D.region === 'hipL' ? -lat : lat),
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
/* The patient controls are the room's sliders; moving them as the operator would keeps the
   sliders, the scene and the traced phantom in step. */
function setSlider(id, v) {
  const el = $(id); if (!el) return;
  el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
}
/* CHANGING SITE CAN CHANGE PATIENT. The spine and hips are scanned on the torso volume and the
   forearm on the arm, so selecting a region loads its subject, and the pose carried over from the
   last one is cleared: a torso squared on the table has no business keeping the rotation that
   laid an arm straight. Left and right forearm are the same volume, the left mirrored, so
   swapping between them re-syncs the scene without a load. With `park` (free scanning) the
   preset lays the forearm straight and flat and drives the arm to the mark, as it parks at the
   spine's; in an exam that is the operator's job. */
export async function useRegion(region, { park = true } = {}) {
  D.region = region;
  document.querySelectorAll('#dxRegionSeg button').forEach((x) => x.classList.toggle('on', x.dataset.region === region));
  const want = subjectFor(region);
  if (ctx.S.subject !== want) {
    setStatus(`Bringing in the ${want === 'upperextremity' ? 'arm' : 'patient'}…`);
    await ctx.setSubject?.(want);
    if (D.region !== region) return;               // (another region was picked while it loaded)
    for (const id of ['objRotX', 'objRotY', 'objRotZ', 'objOffX', 'objOffZ']) setSlider(id, 0);
    if (want !== 'chestabdopelvis') D.props = null;
  }
  ctx.syncScene?.();                               // the left forearm is the right one mirrored
  if (park && isForearm(region)) {
    const al = forearmAlignment(ctx.buildPhantom?.());
    if (al) { setSlider('objRotX', al.x); setSlider('objRotY', al.y); }
  }
  syncProps();
  if (park) parkWhenReady();
  else syncPad();
  setStatus(`${REGIONS[region].label} selected — press SCAN.`);
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
  D.headZ = Math.max(-TABLE_LEN_CM / 2 + 40, Math.min(TABLE_LEN_CM / 2 - 40, D.headZ));
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
    `${Math.abs(e.dx).toFixed(0)} cm ${e.dx > 0 ? 'left' : 'right'} of ${isForearm(D.region) ? "the forearm's middle" : 'the midline'}`;
  note.innerHTML = `<b style="color:#e8b552">Off the mark</b> &mdash; `
    + [zs, xs].filter(Boolean).join(', ') + `. Correct is the ${e.target.label}.`;
}

function buildRig() {
  const { three } = ctx;
  buildLaser();
  import('./dxaRoom.js').then((m) => {
    R3 = m;
    room = m.buildLunar();
    room.table.visible = room.arm.visible = false;
    three.handGroup.parent.add(room.table, room.arm);
    dxaSyncScene();
  });
}

/* The centring laser: a thin cross projected on the patient, which is the only thing the
   operator actually aims with. Drawn slightly above the couch so it reads ON the body
   rather than through it, and left depth-testing off so it stays visible over the skin. */
const LASER_Y = 33;                   // on the front of a supine torso
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

/* The guided exam (dxaExam.js) hangs its checks on the scan here. */
let exam = null;
export function registerExam(hooks) { exam = hooks; }
export const dxa = {
  get D() { return D; }, get ctx() { return ctx; }, REGIONS, scanPlan, positionError, landmarkTargets,
  parkAtLandmark, syncHead: () => { syncHead(); syncPad(); }, syncProps: () => syncProps(), setStatus,
  isScanning: () => scanning, abortScan, findLandmarks, lastScan: () => scan, useRegion, setSlider,
  forearm: () => { const ph = ctx.buildPhantom?.(); return ph?.data ? forearmWorld(ph) : null; },
  forearmAlignment: () => forearmAlignment(ctx.buildPhantom?.()),
  scanNow, decompose, analyse, measure, renderSerial,
};

export function initDXA(context) {
  ctx = context;
  D = ctx.S.dxa;
  buildRig();
  $('dxScan')?.addEventListener('click', () => {
    if (scanning) return;
    const why = exam?.canScan?.();
    if (why) { setStatus(why); return; }
    Sound.resume?.();
    setStatus('Scanning…');
    acquire(
      (st) => {
        if (scan) render(scan, scan.preview, null, st);
        D.scanArmZ = st.armZ; syncHead();
        if (room) { room.sweep.position.x = st.sweepX; room.sweep.material.opacity = st.sweep > 0 && st.sweep < 1 ? 0.85 : 0; }
        setStatus(`Scanning… pass ${st.pass + 1} of ${st.passes} · ${Math.round(100 * st.frac)} %`);
      },
      (sc) => {
        D.scanArmZ = null; syncHead();
        if (room) room.sweep.material.opacity = 0;
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
        exam?.onScanDone?.(sc);
      },
      // each pass: the arm steps, and steps audibly
      () => Sound.play('dxaStep'));
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
  $('dxLeg')?.addEventListener('input', (e) => {
    D.legRot = +e.target.value;
    const d = D.legRot, el = $('dxLegV');
    if (el) el.textContent = d === 0 ? '0°' : d > 0 ? `${d}° in` : `${-d}° out`;
    setStatus(d >= 15 && d <= 25 ? 'Leg in the brace — rescan to see it.'
      : 'Leg out of the brace position — rescan and watch the femoral neck.');
  });
  $('dxWt')?.addEventListener('input', (e) => {
    D.weight = +e.target.value;
    const el = $('dxWtV'); if (el) el.textContent = `${D.weight} kg`;
  });
  document.querySelectorAll('#dxRegionSeg button').forEach((b) => {
    // (in an exam the operator positions and drives the arm to the mark: the preset does not)
    b.addEventListener('click', () => { if (!scanning) useRegion(b.dataset.region, { park: !exam?.active?.() }); });
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
  $('dxSpeed')?.addEventListener('change', (e) => { D.scanSpeed = e.target.checked ? 5 : 1; });
  // clicking a stored study reviews it, in whichever of the two views is showing
  $('dxStrip')?.addEventListener('click', (e) => {
    const b = e.target.closest('.dxthumb'); if (!b) return;
    D.histIdx = +b.dataset.i;
    if (ctx.S.bayContent === 'report') dxaReportToBay(); else dxaImageToBay();
  });
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
    room, laser, scanPlan, thighStumps: () => thighStumps(ctx.S.voxelModel),
    landmarkTargets, positionError, parkAtLandmark, nudge,
    scanNow, findForearm, forearm: dxa.forearm, precisionStats, lscFor, useRegion });
}
