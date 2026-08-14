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
  spine: { label: 'AP lumbar spine', wx: 14, wz: 22, cx: 0, cz: 2 },
  hipL:  { label: 'Left hip',        wx: 14, wz: 16, cx: -9, cz: -14 },
  hipR:  { label: 'Right hip',       wx: 14, wz: 16, cx: 9,  cz: -14 },
};

/* ---- the acquisition -------------------------------------------------------
   One ray per pixel, straight through the patient. The tracer hands back the path
   length in every material, so the two attenuations are exact sums rather than a
   simulated detector reading — and the TRUE areal density is available alongside them,
   which is what lets the decomposition be checked instead of merely believed. */
let scan = null;          // { nx, nz, lo, hi, truth, x0, z0 }
let scanning = false, rasterRow = 0, rasterTimer = null;

/* WHICH MATERIALS ARE MINERAL, AND AT WHAT DENSITY. Stated here rather than read from
   the materials table because it is a DXA modelling choice, not a property of the
   volume: a densitometer's two-material basis calls everything either "bone mineral" or
   "soft tissue", and these are the densities that turn a traced path length into the
   areal density the report is written in. Cortical and trabecular bone differ by nearly
   a factor of two, which is most of why a vertebral body and its cortex read so
   differently. */
const BONE_RHO = { 'Cortical bone': 1.92, 'Trabecular bone': 1.18, 'Tooth enamel': 2.10 };
const SOFT_RHO = 1.05;

/* Mass attenuation of the two BASIS materials, cm2/g. The solve is stated in areal
   density (g/cm2), so these must be mass coefficients, not linear ones. */
function basis() {
  const M = BodyMaterials;
  const bone = M.idByName['Cortical bone'] ?? 18;
  const soft = M.idByName['Soft tissue'] ?? 10;
  const rhoB = BONE_RHO['Cortical bone'], rhoS = SOFT_RHO;
  return {
    bLo: M.muById(bone, E_LO) / rhoB, bHi: M.muById(bone, E_HI) / rhoB,
    sLo: M.muById(soft, E_LO) / rhoS, sHi: M.muById(soft, E_HI) / rhoS,
    boneId: bone, softId: soft, rhoB, rhoS,
  };
}

/* id -> mineral density, for every material that carries mineral. */
function boneRhoById() {
  const M = BodyMaterials, out = {};
  for (const [nm, rho] of Object.entries(BONE_RHO)) {
    const id = M.idByName[nm];
    if (id != null) out[id] = rho;
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
  const rhoOf = boneRhoById();     // mineral density per bone material, g/cm3
  // BONE LOSS lives here: it scales the MINERAL, so both the attenuation and the truth
  // move together. Scaling only the image would be a lie the report could not detect.
  const keep = 1 - (D.loss || 0);

  // the scan window in world coordinates: centred on the volume, offset by the preset
  const cen = ph.min.map((m, i) => (m + ph.max[i]) / 2);
  const x0 = cen[0] + reg.cx - reg.wx / 2, z0 = cen[2] + reg.cz - reg.wz / 2;
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
          const isBone = rhoOf[m] !== undefined;
          const f = isBone ? keep : 1;
          aLo += l * mLo[m] * f;
          aHi += l * mHi[m] * f;
          if (isBone) mineral += l * rhoOf[m] * keep;
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
    bmd[k] = Math.max(0, (sc.lo[k] * b.sHi - sc.hi[k] * b.sLo) / det);
  }
  return { bmd, det, basis: b };
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
        render(sc, bmd);
        setStatus(`Done — ${REGIONS[sc.region].label}.`);
      });
  });
  document.querySelectorAll('#dxRegionSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      D.region = b.dataset.region;
      document.querySelectorAll('#dxRegionSeg button').forEach((x) => x.classList.toggle('on', x === b));
      setStatus(`${REGIONS[D.region].label} selected — press SCAN.`);
    });
  });
  if (typeof window !== 'undefined') window.__dxa = () => ({ D, scan, acquire, decompose, basis, E_LO, E_HI, REGIONS });
}
