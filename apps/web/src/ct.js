// CT mode — Phase 1: mode toggle, CT bed + isocentre laser in the 3D bay, the CT
// acquisition settings, and the start/abort/table console with its symbol icons.
//
// Later phases add: scout acquisition (AP + Lateral), the interactive scan box,
// timed table motion, scan execution + sounds, and transverse reconstruction.
//
// The module is given the app-glue handles it needs via initCT({...}); it keeps
// its own 3D objects (bed, laser) and overrides scene visibility in ctSyncScene(),
// which app.js calls at the end of syncScene().

import { AttenuationEngine } from './core/engine.js';
import { Spectrum } from './core/spectrum.js';

let ctx = null;
let bed = null, laser = null;   // CT-only 3D objects (created once, shown by mode)

const SLICE_MM = [0.625, 1.25, 2.5, 5, 10];   // slice-thickness stations
const SFOV_R = 9;                             // scan field-of-view radius (cm)

// Button glyphs, drawn exactly to spec.
const SYM = {
  // START: an equilateral diamond with a centre vertical line touching top & bottom vertices
  start: '<svg viewBox="0 0 24 24" aria-hidden="true">' +
         '<path class="stroke" d="M12 2.5 L21.5 12 L12 21.5 L2.5 12 Z"/>' +
         '<path class="stroke" d="M12 2.5 L12 21.5"/></svg>',
  // ABORT: a circle with an inscribed equilateral triangle (each vertex on the circle)
  abort: '<svg viewBox="0 0 24 24" aria-hidden="true">' +
         '<circle class="stroke" cx="12" cy="12" r="9"/>' +
         '<path class="stroke" d="M12 3 L19.79 16.5 L4.21 16.5 Z"/></svg>',
  // TABLE: a 4-way direction arrow
  table: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="stroke" d="' +
         'M12 2.5 L12 21.5 M2.5 12 L21.5 12 ' +
         'M12 2.5 L9.2 5.3 M12 2.5 L14.8 5.3 M12 21.5 L9.2 18.7 M12 21.5 L14.8 18.7 ' +
         'M2.5 12 L5.3 9.2 M2.5 12 L5.3 14.8 M21.5 12 L18.7 9.2 M21.5 12 L18.7 14.8"/></svg>',
  // ISOCENTRE: the gantry as a donut cross-section (top + bottom sections) with a
  // side-view patient head facing up between them and the alignment lightbulb on
  // the top section (dark glyph on the ivory console button).
  iso: '<svg viewBox="0 0 24 24" aria-hidden="true">' +
       // top + bottom donut sections (concave edges form the bore opening)
       '<path d="M3 2.5 H21 V5.6 Q12 7.7 3 5.6 Z" fill="currentColor"/>' +
       '<path d="M3 21.5 H21 V18.4 Q12 16.3 3 18.4 Z" fill="currentColor"/>' +
       // alignment lightbulb on the top section, shining down
       '<rect x="11.35" y="6" width="1.3" height="1.3" fill="currentColor"/>' +
       '<circle cx="12" cy="8.4" r="1.4" fill="currentColor"/>' +
       // patient head, side view facing up: skull + nose pointing up
       '<circle cx="12" cy="13.7" r="2.7" fill="currentColor"/>' +
       '<path d="M11.2 11.1 L12 9.7 L12.8 11.1 Z" fill="currentColor"/>' +
       '</svg>',
};

export function initCT(context) {
  ctx = context;
  buildCTScene();
  injectSymbols();
  wireModeToggle();
  wireCTSettings();
  wireCTConsole();
  applyMode(ctx.S.mode);        // establish initial (x-ray) state + body class
}

// Build the couch + gantry bore and the isocentre laser (hidden until CT mode).
function buildCTScene() {
  const { THREE, three } = ctx;

  bed = new THREE.Group();
  const padMat = new THREE.MeshStandardMaterial({ color: 0x232a31, metalness: 0.2, roughness: 0.75 });
  const pad = new THREE.Mesh(new THREE.BoxGeometry(15, 1.2, 66), padMat);
  pad.position.set(0, -0.6, 8); pad.receiveShadow = true; bed.add(pad);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(15.6, 0.5, 66), new THREE.MeshStandardMaterial({ color: 0x2f3a44, metalness: 0.4, roughness: 0.5 }));
  rail.position.set(0, -1.15, 8); bed.add(rail);
  // gantry bore: the patient travels through it along +z/-z
  const ring = new THREE.Mesh(new THREE.TorusGeometry(15, 3.4, 18, 44),
    new THREE.MeshStandardMaterial({ color: 0x2b333c, metalness: 0.55, roughness: 0.4 }));
  ring.position.set(0, 6, -16); bed.add(ring);
  const ringIn = new THREE.Mesh(new THREE.TorusGeometry(12, 0.7, 12, 44),
    new THREE.MeshStandardMaterial({ color: 0x11161b, metalness: 0.3, roughness: 0.8 }));
  ringIn.position.set(0, 6, -14.6); bed.add(ringIn);
  bed.visible = false; three.scene.add(bed);

  // alignment lasers: a thin axial line projected across the patient at the scan
  // plane, plus two vertical lasers at +/- SFOV_R marking the scan field width.
  const lmat = () => new THREE.MeshBasicMaterial({ color: 0xff1e1e, depthTest: false });
  laser = new THREE.Group();
  const axial = new THREE.Mesh(new THREE.BoxGeometry(SFOV_R * 2, 0.05, 0.05), lmat());
  axial.position.set(0, 3.1, 0);            // sits on the patient top at z = 0 (isocentre)
  axial.renderOrder = 12; laser.add(axial);
  for (const sx of [-SFOV_R, SFOV_R]) {
    const v = new THREE.Mesh(new THREE.BoxGeometry(0.05, 9.5, 0.05), lmat());
    v.position.set(sx, 4, 0); v.renderOrder = 12; laser.add(v);
  }
  laser.visible = false; three.scene.add(laser);
}

function injectSymbols() {
  const set = (id, svg) => { const el = ctx.$(id); if (el) el.innerHTML = svg; };
  set('ctStart', SYM.start);
  set('ctAbort', SYM.abort);
  set('ctTable', SYM.table);
  set('ctIsocentre', SYM.iso);
}

// Called by app.js at the end of syncScene(): show the CT rig or the x-ray rig.
export function ctSyncScene() {
  if (!ctx || !bed) return;
  const { three, S } = ctx;
  const isCT = S.mode === 'ct';
  bed.visible = isCT;
  laser.visible = isCT;
  if (three.det) three.det.visible = !isCT;          // hide the flat-panel detector in CT
  if (three.detMarks) three.detMarks.visible = !isCT; // and its corner brackets
  // patient/couch offset (from the direction pad) — only in CT
  three.handGroup.position.x = isCT ? S.ct.patient.x : 0;
  three.handGroup.position.z = isCT ? S.ct.patient.z : 0;
  if (isCT) {
    // no collimator light field in CT — only the laser
    three.lamp.intensity = 0; three.lamp.castShadow = false;
    three.cr.visible = false;
    three.amb.intensity = 0.9; three.key.intensity = 0.9;
    laser.position.set(0, 0, 0);               // lasers fixed at the gantry isocentre
  }
}

function wireModeToggle() {
  const bar = ctx.$('modeBar');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) applyMode(b.dataset.mode);
  });
}

function applyMode(mode) {
  ctx.S.mode = mode;
  document.body.classList.toggle('mode-ct', mode === 'ct');
  document.body.classList.toggle('mode-xray', mode !== 'ct');
  const bar = ctx.$('modeBar');
  if (bar) [...bar.querySelectorAll('button')].forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  const tag = document.querySelector('.baytag .s');
  if (tag) tag.textContent = mode === 'ct' ? 'CT · transverse acquisition' : 'Digit · Hand phantom';
  if (mode !== 'ct') showScouts(false);   // scouts are a CT-only overlay
  ctx.syncScene();
  updateCTReadouts();
}

function wireCTSettings() {
  const { S, $ } = ctx;
  // slice thickness = station selector; images/rotation = counter (both steppers)
  $('ctSettings')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ctstep]'); if (!b) return;
    const key = b.dataset.ctstep, d = parseInt(b.dataset.d, 10);
    if (key === 'sliceThk') {
      let i = SLICE_MM.indexOf(S.ct.sliceThk); if (i < 0) i = 3;
      S.ct.sliceThk = SLICE_MM[Math.max(0, Math.min(SLICE_MM.length - 1, i + d))];
    } else if (key === 'imgPerRotation') {
      S.ct.imgPerRotation = Math.max(1, Math.min(16, S.ct.imgPerRotation + d));
    }
    updateCTReadouts();
  });
  // pitch + scan length (ranges)
  $('ctPitch')?.addEventListener('input', (e) => { S.ct.pitch = parseFloat(e.target.value); updateCTReadouts(); });
  $('ctScanLen')?.addEventListener('input', (e) => { S.ct.scanLen = parseFloat(e.target.value); updateCTReadouts(); });
  // isocentre confirm — zero the table position reading (patient stays put)
  $('ctIsocentre')?.addEventListener('click', () => {
    S.ct.tablePos = 0; S.ct.isocentred = true;
    setHint('Isocentre set. Acquire scouts to begin planning.');
    updateCTReadouts();
  });
  // direction pad — nudge the patient/couch; longitudinal travel shows as table position
  const STEP = 1;   // cm per press
  $('ctDpad')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-dir]'); if (!b) return;
    const p = S.ct.patient;
    switch (b.dataset.dir) {
      case 'up':    p.z -= STEP; S.ct.tablePos -= STEP; break;   // table into the gantry
      case 'down':  p.z += STEP; S.ct.tablePos += STEP; break;   // table out
      case 'left':  p.x -= STEP; break;
      case 'right': p.x += STEP; break;
    }
    S.ct.isocentred = false;
    ctx.syncScene();          // ctSyncScene re-applies the patient offset
    updateCTReadouts();
  });
}

function updateCTReadouts() {
  const { S, $ } = ctx;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('ctSliceThkV', S.ct.sliceThk + ' mm');
  set('ctImgV', S.ct.imgPerRotation);
  set('ctPitchV', S.ct.pitch.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
  set('ctScanLenV', S.ct.scanLen + ' cm');
  set('ctTablePosV', (S.ct.tablePos >= 0 ? '+' : '') + S.ct.tablePos.toFixed(1) + ' cm');
}

function setHint(t) { const el = ctx.$('ctHint'); if (el) el.textContent = t; }

// Console + acquisition state machine. Phase 2 implements idle -> scout ->
// planning; scan-box confirm, table motion, scan + reconstruction come next.
function wireCTConsole() {
  const { $, S } = ctx;
  $('ctStart')?.addEventListener('click', () => {
    if (S.ct.phase === 'idle') acquireScouts();
    else if (S.ct.phase === 'planning') setHint('Scan-box confirmation + scan execution arrive in later phases.');
  });
  $('ctAbort')?.addEventListener('click', abortCT);
  $('ctTable')?.addEventListener('click', () => setHint('Table motion arrives with scan planning.'));
  setPhase('idle');
}

function setPhase(p) {
  const { S, $ } = ctx;
  S.ct.phase = p;
  const start = $('ctStart');
  if (start) start.classList.toggle('flash', p === 'planning');
  const labels = { idle: 'CT · STANDBY', scout: 'CT · SCOUT', planning: 'CT · PLAN SCAN',
                   moving: 'CT · TABLE MOVE', scanning: 'CT · SCANNING', done: 'CT · COMPLETE' };
  const wt = $('ctWarnT'); if (wt) wt.textContent = labels[p] || 'CT';
}

function setConsoleEnabled(on) {
  ['ctStart', 'ctAbort', 'ctTable'].forEach(id => { const b = ctx.$(id); if (b) b.disabled = !on; });
}

function showScouts(on) { ctx.$('ctScouts')?.classList.toggle('show', on); }

function abortCT() {
  showScouts(false);
  setPhase('idle');
  setHint('Set the isocentre, then acquire scouts to plan the scan.');
}

// ---- Phase 2: scout acquisition (AP + Lateral topograms over the scan length) ----
async function acquireScouts() {
  const { $ } = ctx;
  setPhase('scout');
  setConsoleEnabled(false);
  setHint('Acquiring scout images…');
  try {
    drawScout($('scoutAP'),  await scoutProjection('AP'));
    drawScout($('scoutLAT'), await scoutProjection('LAT'));
    showScouts(true);
    setPhase('planning');
    setHint('Scouts acquired — scan-box planning is next. (Press START to continue in a later phase.)');
  } catch (err) {
    console.error('scout acquisition failed', err);
    setHint('Scout acquisition failed: ' + err.message);
    setPhase('idle');
  } finally {
    setConsoleEnabled(true);
  }
}

// One scout (topogram): a single AP or Lateral projection over the scan length.
// Both share the z (scan-length) axis so a scan box can span them consistently.
async function scoutProjection(view) {
  const { S } = ctx;
  const phantom = ctx.buildPhantom();               // CT patient (offset baked in CT mode)
  const spectrum = Spectrum.make(S.kv);
  const I0 = S.mas * Math.pow(S.kv / 70, 2);
  const scanLen = S.ct.scanLen;                     // cm, shared vertical (z) axis
  const nz = 320, nw = 128;                         // rows (length) x cols (width/thickness)
  const pxV = scanLen / nz;
  let source, detCenter, detU, detV, pxU;
  if (view === 'AP') {
    const W = 26; pxU = W / nw;
    source = [0, 100, 0];
    detCenter = [0, 0, 0]; detU = [1, 0, 0]; detV = [0, 0, 1];   // x width vs z length
  } else {
    const T = 14, yc = 3; pxU = T / nw;
    source = [100, yc, 0];
    detCenter = [-8, yc, 0]; detU = [0, 1, 0]; detV = [0, 0, 1];  // y thickness vs z length
  }
  const refDist = Math.hypot(source[0] - detCenter[0], source[1] - detCenter[1], source[2] - detCenter[2]);
  const dose = await AttenuationEngine.project({
    phantom, source, detCenter, detU, detV, nx: nw, ny: nz, pxU, pxV, spectrum, I0, refDist,
  });
  return { dose, nw, nz };
}

// Grayscale topogram: attenuated (bone) -> bright, open field -> dark. Flipped so
// the distal end (+z) reads at the top of the image.
function drawScout(cv, { dose, nw, nz }) {
  cv.width = nw; cv.height = nz;
  const g = cv.getContext('2d');
  const img = g.createImageData(nw, nz);
  let mn = Infinity, mx = -Infinity;
  for (let k = 0; k < dose.length; k++) { const d = dose[k]; if (d < mn) mn = d; if (d > mx) mx = d; }
  const rng = (mx - mn) || 1;
  for (let k = 0; k < dose.length; k++) {
    const t = (dose[k] - mn) / rng;                 // 0 = most attenuated, 1 = open field
    const v = Math.round(255 * Math.pow(1 - t, 0.7));
    const j = (k / nw) | 0, i = k % nw;
    const o = ((nz - 1 - j) * nw + i) * 4;          // flip vertically
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}
