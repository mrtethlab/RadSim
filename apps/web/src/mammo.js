/* ============================================================================
   MAMMOGRAPHY MODE — docs/mammography.md
   The machine: an upright unit with the tube head 65 cm above the receptor, a
   compression paddle between, and the breast phantom clamped in it.

   Two design decisions carry the whole mode:

   COMPRESSION IS GEOMETRY, NOT A WARP. Uniaxial compression is modelled as an
   affine scale along the machine's compression axis (volume-conserving: c along
   the axis, 1/sqrt(c) laterally). The SAME transform drives the 3D mesh (the
   animation ML asked for) and the raycast (rays are pulled through the inverse
   affine, path lengths corrected by one factor per ray) — one mechanism, two
   consumers, exactly like the fluoro isocentre. MLO composes a pose rotation
   into the same affine, which is the physical truth of the view: the anatomy
   turns, the machine still compresses along its own axis.

   THE PROJECTOR OWNS ITS mu TABLE. The house HU-based mu model clamps below
   20 keV and gives fat/glandular a constant ratio at every energy — which would
   erase the one lesson mammography exists to teach. So the mammographic tissues
   carry their own low-energy table (ICRU-44-flavoured, log-interpolated), and
   the gland/fat ratio falls from ~1.5 at 17 keV to ~1.2 at 40 as it must.
   The shared muOverBins stays pristine for every other mode.
   ============================================================================ */

import { VoxelPhantom } from './core/voxelPhantom.js';

let ctx = null, M = null;
const $ = (id) => document.getElementById(id);

const SID = 65;          // source to receptor, cm
const H0 = 7.2;          // the phantom's uncompressed height, cm (model z extent)
const PLATE_Y = 0;       // receptor top in the rig's local frame

/* ---- low-energy attenuation, cm^-1 (ICRU-44-flavoured anchors) ------------
   Rows are log-interpolated in energy. Calcification is a hydroxyapatite-rich
   speck, not solid bone — dense enough that a 0.4 mm speck marks the film. */
const MU_E = [15, 17.5, 20, 25, 30, 40];
const MU_LOW = {
  2:  [1.05, 0.72, 0.53, 0.36, 0.28, 0.22],     // Fat
  53: [1.62, 1.09, 0.79, 0.50, 0.37, 0.27],     // Glandular
  23: [1.72, 1.16, 0.84, 0.54, 0.39, 0.28],     // Skin
  7:  [1.68, 1.13, 0.82, 0.53, 0.38, 0.27],     // Muscle
  10: [1.66, 1.12, 0.81, 0.52, 0.38, 0.27],     // Soft tissue (the masses)
  21: [30.0, 20.0, 13.7, 7.3, 4.4, 2.0],        // Calcification
};
function muAt(id, keV) {
  const row = MU_LOW[id];
  if (!row) return 0;
  const e = Math.min(Math.max(keV, MU_E[0]), MU_E[MU_E.length - 1]);
  let i = 0;
  while (i + 2 < MU_E.length && MU_E[i + 1] < e) i++;
  const f = (Math.log(e) - Math.log(MU_E[i])) / (Math.log(MU_E[i + 1]) - Math.log(MU_E[i]));
  return Math.exp(Math.log(row[i]) + f * (Math.log(row[i + 1]) - Math.log(row[i])));
}

/* ---- the beam: 3 spectral bins per target/filter --------------------------
   Mo targets put most of the useful beam in the 17.5 / 19.6 keV characteristic
   lines once the kV can excite them; the Rh filter hardens the pack; a W/Rh
   beam is bremsstrahlung shaped by the Rh K-edge — hardest of the three. */
function beamBins(tf, kv) {
  if (tf === 'wrh') {
    return { E: [0.52 * kv, 0.68 * kv, 0.84 * kv], w: [0.28, 0.46, 0.26] };
  }
  const line1 = kv > 19 ? 17.5 : 0.66 * kv;
  const line2 = kv > 21 ? 19.6 : 0.80 * kv;
  if (tf === 'morh') return { E: [0.58 * kv, line1, line2 + 0.6], w: [0.20, 0.42, 0.38] };
  return { E: [0.58 * kv, line1, line2], w: [0.32, 0.45, 0.23] };        // mo/mo
}

/* ---- rig ------------------------------------------------------------------ */
let rig = null, gantry = null, paddle = null, breastMesh = null, tubeHead = null;
let compCur = 1.0;            // animated compression factor (drive lerps toward M.comp)
let breastBase = null;        // the mesh's uncompressed local pose

function buildRig() {
  const { THREE, three } = ctx;
  rig = new THREE.Group();
  const grey = (c, r = 0.8) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
  // floor column
  const col = new THREE.Mesh(new THREE.BoxGeometry(16, 190, 24), grey(0x8f99a2));
  col.position.set(0, 95 - 110, -16);
  rig.add(col);
  // the gantry: everything that turns for the view angle, pivoted at the breast centre
  gantry = new THREE.Group();
  rig.add(gantry);
  // tube head, SID above the receptor
  tubeHead = new THREE.Mesh(new THREE.BoxGeometry(24, 14, 20), grey(0xb7bfc7));
  tubeHead.position.set(0, SID - H0 / 2, 2);
  gantry.add(tubeHead);
  const snout = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 6.5, 7, 18), grey(0x6d7780));
  snout.position.set(0, SID - H0 / 2 - 10, 2);
  gantry.add(snout);
  // support platform: receptor housing the breast rests on
  const plate = new THREE.Mesh(new THREE.BoxGeometry(30, 4, 28), grey(0x9aa4ad, 0.6));
  plate.position.set(0, -H0 / 2 - 2, 6);
  gantry.add(plate);
  // compression paddle: clear acrylic, the moving part
  paddle = new THREE.Mesh(new THREE.BoxGeometry(26, 0.8, 24),
    new THREE.MeshStandardMaterial({ color: 0xbfe4ee, transparent: true, opacity: 0.32,
      roughness: 0.15, side: THREE.DoubleSide }));
  paddle.position.set(0, H0 / 2 + 0.4, 7);
  gantry.add(paddle);
  const lip = new THREE.Mesh(new THREE.BoxGeometry(26, 3.4, 0.8),
    paddle.material);
  lip.position.set(0, H0 / 2 + 2.0, -4.6);
  gantry.add(lip);
  // the room's exam lamp is off in this mode; the unit carries its own soft light so
  // the machine and the clamped breast read as more than ambient silhouettes
  const lamp = new THREE.PointLight(0xfff1e0, 2800, 400, 1.8);
  lamp.position.set(26, 46, 50);
  rig.add(lamp);
  const fill = new THREE.DirectionalLight(0xcfdbe4, 0.55);
  fill.position.set(-30, 20, 30);
  rig.add(fill);
  rig.visible = false;
  three.handGroup.parent.add(rig);
}

/* The rig owns a PRIVATE copy of the breast mesh (the OEC pattern): the x-ray room
   re-poses its shared subject meshes on every sync, and adopting one meant fighting a
   per-frame placement (which was applying a scale of -0.1 — a point inversion — over
   anything set here). A 2.4 MB GLB loaded once is far cheaper than that fight. */
let meshLoading = false;
function ensureBreastMesh() {
  if (breastMesh || meshLoading || !ctx.loadModelUrl) return;
  meshLoading = true;
  ctx.loadModelUrl(ctx.baseUrl + 'models/breast/breast.glb').then((g) => {
    g.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = false; o.receiveShadow = false;
        if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) if (m) {
          m.color.setHex(0xd8a07a); m.metalness = 0; m.roughness = 0.75; m.needsUpdate = true;
        }
      }
    });
    // model axes: x lateral, y chest-wall->nipple, z inferior->superior (GLB vertices in
    // mm about the volume centre). Stand z up, spin the nipple toward the viewer, chest
    // wall to the column; mm -> cm is the base scale compression multiplies.
    g.rotation.set(-Math.PI / 2, 0, Math.PI);
    breastBase = { s: 0.1, z: 2 };
    g.position.set(0, 0, breastBase.z);
    breastMesh = g;
    gantry.add(g);
    applyCompression();
  }).catch(() => { meshLoading = false; });
}

/* Compression drive: the paddle and the breast animate toward the target. TIME-based
   (exponential toward the target with a fixed time constant), not per-tick — a
   background tab throttles setInterval to ~1 Hz, and a drive that crawls when the tab
   loses focus would leave an exposure firing mid-descent. */
let driveTimer = null, driveAt = 0;
const DRIVE_TAU = 0.28;                 // seconds to ~63 % of the remaining travel
function driveTick() {
  const now = performance.now() / 1000;
  const dt = Math.min(now - driveAt, 2);
  driveAt = now;
  const target = M.comp;
  if (Math.abs(target - compCur) < 0.003) { compCur = target; clearInterval(driveTimer); driveTimer = null; }
  else compCur = target + (compCur - target) * Math.exp(-dt / DRIVE_TAU);
  applyCompression();
  renderReadouts();
}
function startDrive() {
  if (!driveTimer) { driveAt = performance.now() / 1000; driveTimer = setInterval(driveTick, 40); }
}
function applyCompression() {
  const c = compCur, lat = 1 / Math.sqrt(c);
  if (paddle) paddle.position.y = -H0 / 2 + H0 * c + 0.4;
  if (breastMesh && breastBase) {
    // scale in LOCAL axes (model z is the compression axis), on top of the pipeline's
    // mm->cm factor; the mesh pivots at its own centre, so re-seat the bottom on the plate
    const s = breastBase.s;
    breastMesh.scale.set(s * lat, s * lat, s * c);
    breastMesh.position.y = -(H0 / 2) + (H0 * c) / 2;
  }
}
/* The paddle force: soft tissue stiffens as it flattens. Calibrated so a typical
   compression (c ~ 0.62, ~4.5 cm) reads ~110 N — the number a tech actually uses. */
function forceN() { const s = 1 - compCur; return Math.round(420 * s * s + 90 * s); }
function thicknessMM() { return Math.round(H0 * compCur * 10); }

/* ---- the exposure --------------------------------------------------------- */
function expose() {
  const S = ctx.S, vm = S.voxelModel;
  if (!vm || S.subject !== 'breast' || !vm.data) { setStatus('Loading the breast…'); return; }
  const t0 = performance.now();
  const { E, w } = beamBins(M.tf, M.kv);
  // per-bin mu for every material in the phantom: the low-energy table where it
  // matters, zero for air; nothing else appears in this volume
  const ids = [0, 2, 7, 10, 21, 23, 53];
  const mu = {};
  for (const id of ids) mu[id] = E.map((e) => muAt(id, e));

  // MACHINE frame: x lateral, y AP (chest wall at y=0, nipple +y), z vertical (the
  // beam and compression axis; receptor at z=0). Anatomy -> machine is the affine
  //   p_m = S · R · (p_a − C_a) + C_m
  // with S = diag(1/√c, 1/√c, c) (volume-conserving compression), R the view pose
  // (MLO turns the anatomy about its AP axis), C_a the volume centre and C_m
  // placing the compressed breast on the receptor. Rays are cast in machine space
  // and pulled back through the inverse; ONE chord-ratio per ray converts the
  // traced anatomy path lengths into real centimetres of compressed tissue.
  const c = compCur, lat = 1 / Math.sqrt(c);
  const rot = M.view === 'mlo' ? Math.PI / 4 : 0;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  const ex = vm.extentMM[0] / 10, ey = vm.extentMM[1] / 10, ez = vm.extentMM[2] / 10;
  const Ca = [ex / 2, ey / 2, ez / 2];
  const Cm = [0, (ey / 2) * lat, (ez * c) / 2];

  // centre at Ca puts the volume's min corner at the anatomy origin, which is the
  // frame toAnat() produces
  const ph = new VoxelPhantom({ dims: vm.dims, vs: vm.vs, data: vm.data }, Ca);

  // machine point -> anatomy point: subtract Cm, unscale, unrotate, add Ca
  const toAnat = (pm) => {
    let x = (pm[0] - Cm[0]) / lat, y = (pm[1] - Cm[1]) / lat, z = (pm[2] - Cm[2]) / c;
    if (rot) { const x2 = cosR * x + sinR * z, z2 = -sinR * x + cosR * z; x = x2; z = z2; }
    return [x + Ca[0], y + Ca[1], z + Ca[2]];
  };

  // detector grid: chest wall along the top row, nipple toward the bottom. The field is
  // the RECEPTOR's, fixed — compression visibly spreads the breast across it, which is
  // half of what the image has to show
  const NX = 470, NY = 300;
  const fovX = 23.0, fovY = 14.6;
  const img = new Float32Array(NX * NY);
  const src = [0, 0.5, SID];                            // over the chest-wall edge, as built
  let seed = (M.fixedSeed || (Math.random() * 1e9)) | 0;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const photons0 = 90 * M.mas;                          // detected/px behind no tissue
  let aecSum = 0, aecCnt = 0;
  const a0 = toAnat(src);
  for (let j = 0; j < NY; j++) {
    const py = (j + 0.5) / NY * fovY - fovY * 0.02;
    for (let i = 0; i < NX; i++) {
      const px = ((i + 0.5) / NX - 0.5) * fovX;
      const pix = [px, py, 0];
      const a1 = toAnat(pix);
      let dx = a1[0] - a0[0], dy = a1[1] - a0[1], dz = a1[2] - a0[2];
      const alen = Math.hypot(dx, dy, dz);
      dx /= alen; dy /= alen; dz /= alen;
      const mlen = Math.hypot(pix[0] - src[0], pix[1] - src[1], pix[2] - src[2]);
      const scaleL = mlen / alen;                       // machine cm per anatomy cm, this ray
      const L = ph.trace(a0, [dx, dy, dz]);
      let T = 0;
      for (let b = 0; b < 3; b++) {
        let A = 0;
        for (const id of ids) { const l = L[id]; if (l > 0) A += l * scaleL * mu[id][b]; }
        T += w[b] * Math.exp(-A);
      }
      const lam = photons0 * T;
      const det = lam > 30 ? Math.max(0, lam + Math.sqrt(lam) * (Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(6.283 * rand())))
                           : lam;
      img[j * NX + i] = det;
      // AEC cell: a band over the fibroglandular disc, forward of the chest wall
      if (j > NY * 0.25 && j < NY * 0.55 && i > NX * 0.35 && i < NX * 0.65 && T < 0.55) {
        aecSum += T; aecCnt++;
      }
    }
  }
  // AEC: one-shot re-scale of mAs so the metered cell lands on target — the real AEC
  // integrates during the exposure; the arithmetic is the same
  if (M.aec && aecCnt > 50) {
    const tMean = aecSum / aecCnt;
    const want = 400;   // target detected photons/px behind the gland — SNR ~20, and the
                        // mAs it implies lands the AGD where a screening view really sits
    const newMas = Math.min(400, Math.max(4, want / (90 * tMean)));
    const f = newMas / M.mas;
    for (let k = 0; k < img.length; k++) img[k] *= f;
    M.mas = Math.round(newMas * 10) / 10;
  }
  drawMammo(img, NX, NY);
  dose();
  renderReadouts();
  setStatus(`Exposed — ${(performance.now() - t0).toFixed(0)} ms · ${M.view.toUpperCase()} · `
    + `${{ momo: 'Mo/Mo', morh: 'Mo/Rh', wrh: 'W/Rh' }[M.tf]} ${M.kv} kV · ${M.mas} mAs`);
}

/* Average glandular dose, parameterized: rises with mAs and beam output (kV^3-ish at
   the anode), falls as compression thins the breast. Calibrated to ~1.5 mGy at
   28 kV / 60 mAs / 45 mm — the ballpark a screening view actually delivers. */
function dose() {
  const thkCm = H0 * compCur;
  const agd = M.mas * Math.pow(M.kv / 28, 3.1) * (4.5 / thkCm) * (1.5 / 60);
  M.agdMGy = agd;
}

function drawMammo(img, nx, ny) {
  const film = $('film'); if (!film) return;
  if (film.width !== 330) { film.width = 330; film.height = 440; }
  // log-attenuation display, dense = white (the radiograph convention): robust
  // percentile window over the tissue, gamma for the film look
  const a = new Float32Array(img.length);
  let mx = 0;
  for (let k = 0; k < img.length; k++) { a[k] = Math.log(1 + Math.max(0, img[k])); if (a[k] > mx) mx = a[k]; }
  const cv = document.createElement('canvas'); cv.width = nx; cv.height = ny;
  const id = cv.getContext('2d').createImageData(nx, ny);
  for (let k = 0; k < img.length; k++) {
    const v = 1 - a[k] / (mx || 1);                     // attenuation up = white
    const g = Math.pow(Math.min(1, Math.max(0, (v - 0.02) / 0.9)), 1.35) * 255;
    id.data[k * 4] = id.data[k * 4 + 1] = id.data[k * 4 + 2] = g;
    id.data[k * 4 + 3] = 255;
  }
  cv.getContext('2d').putImageData(id, 0, 0);
  const g2 = film.getContext('2d');
  g2.fillStyle = '#000'; g2.fillRect(0, 0, film.width, film.height);
  const s = Math.min(film.width / nx, film.height / ny);
  g2.imageSmoothingEnabled = true;
  g2.drawImage(cv, (film.width - nx * s) / 2, (film.height - ny * s) / 2, nx * s, ny * s);
  $('noexp')?.style.setProperty('display', 'none');
  const tl = $('fnTL'); if (tl) tl.textContent = `MAMMO ${M.view.toUpperCase()}`;
  const br = $('fnBR'); if (br) br.textContent = `${M.kv} kV · ${M.mas} mAs · AGD ${M.agdMGy.toFixed(2)} mGy`;
}

/* ---- readouts + status ---------------------------------------------------- */
function renderReadouts() {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('mmKvV', M.kv + ' kV');
  set('mmMasV', M.mas + ' mAs');
  set('mmThkV', thicknessMM() + ' mm');
  set('mmForceV', forceN() + ' N');
  set('mmAgdV', (M.agdMGy || 0).toFixed(2) + ' mGy');
  const kvS = $('mmKv'), masS = $('mmMas');
  if (kvS && +kvS.value !== M.kv) kvS.value = M.kv;
  if (masS && M.aec) masS.value = M.mas;
}
function setStatus(t) { const el = $('mmStatus'); if (el) el.textContent = t; }

/* ---- scene + mode --------------------------------------------------------- */
export function mammoSyncScene() {
  if (!ctx || !rig) return;
  const { S, three } = ctx;
  const on = S.mode === 'mammo';
  rig.visible = on;
  if (on) {
    if (three.tube) three.tube.visible = false;
    if (three.lamp) three.lamp.intensity = 0;
    if (three.cr) three.cr.visible = false;
    if (three.det) three.det.visible = false;
    if (three.detMarks) three.detMarks.visible = false;
    if (three.detArrow) three.detArrow.visible = false;
    if (three.aecGroup) three.aecGroup.visible = false;
    rig.position.set(0, 30, 0);
    ensureBreastMesh();
    // the x-ray room's shared subject mesh stays out of this room entirely
    const shared = three.voxelMeshes && three.voxelMeshes.breast;
    if (shared) shared.visible = false;
    if (three.chestGroup) three.chestGroup.visible = false;
    gantry.rotation.z = M.view === 'mlo' ? -Math.PI / 4 : 0;
    applyCompression();
  }
}

export function mammoApplyMode(on) {
  if (!ctx) return;
  if (on) {
    if (ctx.S.subject !== 'breast') ctx.setSubject?.('breast');
    renderReadouts();
    setStatus('Drive the compression, then EXPOSE.');
  } else {
    // hand the shared subject mesh back to the other rooms
    const shared = ctx.three.voxelMeshes && ctx.three.voxelMeshes.breast;
    if (shared && ctx.S.subject === 'breast') shared.visible = true;
  }
  mammoSyncScene();
}

export function initMammo(context) {
  ctx = context;
  M = ctx.S.mammo;
  buildRig();
  if (typeof window !== 'undefined') window.__mammoProbe = () => ({ mesh: breastMesh, compCur });
  document.querySelectorAll('#mmTfSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      M.tf = b.dataset.tf;
      document.querySelectorAll('#mmTfSeg button').forEach((x) => x.classList.toggle('on', x === b));
    });
  });
  $('mmKv')?.addEventListener('input', (e) => { M.kv = +e.target.value; renderReadouts(); });
  $('mmMas')?.addEventListener('input', (e) => { M.mas = +e.target.value; renderReadouts(); });
  document.querySelectorAll('#mmAecSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      M.aec = b.dataset.aec === '1';
      document.querySelectorAll('#mmAecSeg button').forEach((x) => x.classList.toggle('on', x === b));
      const masEl = $('mmMas'); if (masEl) masEl.disabled = M.aec;
    });
  });
  $('mmComp')?.addEventListener('input', (e) => {
    M.comp = +e.target.value / 100;
    startDrive();
  });
  $('mmRelease')?.addEventListener('click', () => {
    M.comp = 1.0;
    const s = $('mmComp'); if (s) s.value = 100;
    startDrive();
  });
  document.querySelectorAll('#mmViewSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      M.view = b.dataset.view;
      document.querySelectorAll('#mmViewSeg button').forEach((x) => x.classList.toggle('on', x === b));
      mammoSyncScene();
    });
  });
  $('mmExpose')?.addEventListener('click', expose);
  const masEl = $('mmMas'); if (masEl) masEl.disabled = M.aec;
  renderReadouts();
}
