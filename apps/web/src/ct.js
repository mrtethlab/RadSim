// CT mode — Phase 1: mode toggle, CT bed + isocentre laser in the 3D bay, the CT
// acquisition settings, and the start/abort/table console with its symbol icons.
//
// Later phases add: scout acquisition (AP + Lateral), the interactive scan box,
// timed table motion, scan execution + sounds, and transverse reconstruction.
//
// The module is given the app-glue handles it needs via initCT({...}); it keeps
// its own 3D objects (bed, laser) and overrides scene visibility in ctSyncScene(),
// which app.js calls at the end of syncScene().

import { Spectrum } from './core/spectrum.js';
import { Materials } from './core/materials.js';
import { Sound } from './audio/sound.js';

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
  bed.position.z = 0;            // base position (the scan animation drives it directly)
  laser.visible = isCT;
  if (three.det) three.det.visible = !isCT;          // hide the flat-panel detector in CT
  if (three.detMarks) three.detMarks.visible = !isCT; // and its corner brackets
  // patient/couch offset (from the direction pad) — only in CT
  three.handGroup.position.x = isCT ? S.ct.patient.x : 0;
  three.handGroup.position.z = isCT ? S.ct.patient.z : 0;
  // feet-first turns the patient 180° so the other end enters the gantry bore
  three.handGroup.rotation.y = (isCT && S.ct.orientation === 'feet') ? Math.PI : 0;
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
  // pitch + scan length (ranges). Changing scan length does NOT live-update a
  // scout: like a real CT, re-scouting means ABORT then START (rescan) — but it
  // does not require re-setting the isocentre (table zero persists).
  $('ctPitch')?.addEventListener('input', (e) => { S.ct.pitch = parseFloat(e.target.value); updateCTReadouts(); });
  $('ctRotSpeed')?.addEventListener('input', (e) => { S.ct.rotSpeed = parseFloat(e.target.value); updateCTReadouts(); });
  $('ctScanLen')?.addEventListener('input', (e) => { S.ct.scanLen = parseFloat(e.target.value); updateCTReadouts(); });
  // scan orientation (head-first / feet-first) — flips where the isocentre sits
  $('ctOrientSeg')?.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.ct.orientation = b.dataset.orient;
    [...b.parentNode.children].forEach(x => x.classList.toggle('on', x === b));
    updateCTReadouts();
    ctx.syncScene();                                 // flip the 3D model to head/feet-first
    if (S.ct.phase === 'planning') redrawScouts();   // and the scout display
  });
  // isocentre confirm — zero the table position reading (patient stays put)
  $('ctIsocentre')?.addEventListener('click', () => {
    S.ct.tablePos = 0; S.ct.isoZ = S.ct.patient.z; S.ct.isocentred = true;
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

// Exposure (scan) time from the acquisition parameters:
//   beam width       = images/rotation x slice thickness
//   table feed/rot   = pitch x beam width
//   rotations        = scan length / table feed per rotation
//   exposure time    = rotations x rotation time (s)
function ctExposureTime() {
  const c = ctx.S.ct;
  const beamWidth = c.imgPerRotation * (c.sliceThk / 10);     // cm
  const feedPerRot = Math.max(c.pitch * beamWidth, 1e-3);     // cm / rotation
  return (c.scanLen / feedPerRot) * c.rotSpeed;               // seconds
}

function updateCTReadouts() {
  const { S, $ } = ctx;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('ctSliceThkV', S.ct.sliceThk + ' mm');
  set('ctImgV', S.ct.imgPerRotation);
  set('ctPitchV', S.ct.pitch.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
  set('ctRotSpeedV', S.ct.rotSpeed.toFixed(2) + ' s');
  set('ctScanLenV', S.ct.scanLen + ' cm');
  const et = ctExposureTime();
  set('ctExpTimeV', (et < 10 ? et.toFixed(1) : Math.round(et)) + ' s');
  set('ctTablePosV', (S.ct.tablePos >= 0 ? '+' : '') + S.ct.tablePos.toFixed(1) + ' cm');
  set('ctOrientV', S.ct.orientation === 'feet' ? 'FEET FIRST' : 'HEAD FIRST');
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
  ctx.syncScene();   // restore the model/bed after any scan animation
  setHint('Set the isocentre, then acquire scouts to plan the scan.');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Phase 2: scout acquisition with a simulated patient scan ----
// START (idle) runs two acquisitions (AP then Lateral), each with breathe-in ->
// exposure (buzz + table travel through the gantry) -> breathe-normally. The
// scouts are computed up front but only revealed after the 2nd breathe-normally.
async function acquireScouts() {
  const { $ } = ctx;
  setPhase('scout');
  setConsoleEnabled(false);
  showScouts(false);
  try {
    lastAP = scoutProjection('AP');
    lastLAT = scoutProjection('LAT');
  } catch (err) {
    console.error('scout compute failed', err);
    setHint('Scout acquisition failed: ' + err.message);
    setPhase('idle'); setConsoleEnabled(true); return;
  }
  await runScoutExposure('AP');
  await runScoutExposure('LAT');
  // reveal the planning images once the 2nd breathe-normally has played
  redrawScouts();
  showScouts(true);
  setPhase('planning');
  setHint('Scouts acquired — position the scan box (next phase). START confirms the plan.');
  setConsoleEnabled(true);
}

// Put the patient/couch back at the isocentre (table 0) before an acquisition.
function resetToIsocentre() {
  const { S } = ctx;
  S.ct.patient.z = S.ct.isoZ;   // model back to where it was when the isocentre was set
  S.ct.tablePos = 0;
  ctx.syncScene();               // applies patient.z + orientation, resets the bed
  updateCTReadouts();
}

// One animated acquisition: breathe-in, 1s hold, exposure (buzz + table travel),
// breathe-out. The exposure sound + table travel run for the calculated exposure time.
async function runScoutExposure(view) {
  Sound.resume();
  resetToIsocentre();
  setHint(view + ' scout · breathe in and hold…');
  Sound.play('breathIn');
  await sleep((Sound.duration('breathIn') || 2) * 1000);   // let the breathe-in finish
  await sleep(1000);                                        // 1 s hold before the exposure
  setHint(view + ' scout · scanning…');
  Sound.startBuzz();
  await animateTableTravel(ctExposureTime() * 1000);
  Sound.stopBuzz();
  setHint(view + ' scout · breathe normally.');
  Sound.play('breathNormal');
  await sleep(Math.min(2200, (Sound.duration('breathNormal') || 1.8) * 1000));
}

// Move the couch (bed + patient) the scan length into the gantry over the exposure
// time, updating the table position readout in real time. Ends at table pos =
// +scanLen (feet-first) or -scanLen (head-first).
function animateTableTravel(dur) {
  return new Promise(res => {
    const three = ctx.three, S = ctx.S;
    const scanLen = S.ct.scanLen;
    const startHandZ = three.handGroup.position.z, startBedZ = bed.position.z;
    const tpSign = S.ct.orientation === 'feet' ? 1 : -1;
    const t0 = performance.now();
    let done = false;
    const apply = (t) => {
      const dz = -scanLen * t;                         // travel into the bore (-z)
      three.handGroup.position.z = startHandZ + dz;
      bed.position.z = startBedZ + dz;
      S.ct.tablePos = tpSign * scanLen * t;            // live table position
      updateCTReadouts();
    };
    const finish = () => { if (done) return; done = true; apply(1); res(); };
    (function step() {
      if (done) return;
      const t = Math.min(1, (performance.now() - t0) / dur);
      apply(t);
      if (t < 1) requestAnimationFrame(step); else finish();
    })();
    setTimeout(finish, dur + 500);                     // completes even if rAF is paused (hidden tab)
  });
}

// One scout: a distortion-free topogram. The tube stays at a fixed gantry
// position and the table translates, i.e. each row (z) is imaged with the source
// directly over that row -> parallel along the scan axis (no z divergence), fan
// only across the width. Computed synchronously (fast) so it's ready pre-animation.
function scoutProjection(view) {
  const { S } = ctx;
  const phantom = ctx.buildPhantom();               // CT patient (offset baked in CT mode)
  const bins = Spectrum.make(S.kv).bins;
  const muSoft = bins.map(b => Materials.mu('soft', b.E));
  const muBone = bins.map(b => Materials.mu('bone', b.E));
  const muMarr = bins.map(b => Materials.mu('marrow', b.E));
  const I0 = S.mas * Math.pow(S.kv / 70, 2);
  const scanLen = S.ct.scanLen;                     // cm, shared vertical (z) axis
  const nz = 320, nw = 128;
  const pxV = scanLen / nz;
  let sx, sy, dcx, dcy, ux, uy, pxU;
  if (view === 'AP') { const W = 26; pxU = W / nw; sx = 0; sy = 100; dcx = 0; dcy = 0; ux = 1; uy = 0; }
  else { const T = 14, yc = 3; pxU = T / nw; sx = 100; sy = yc; dcx = -8; dcy = yc; ux = 0; uy = 1; }
  const refDist2 = (sx - dcx) * (sx - dcx) + (sy - dcy) * (sy - dcy);
  const halfU = (nw - 1) / 2;
  const dose = new Float32Array(nw * nz);
  for (let j = 0; j < nz; j++) {
    // the scan runs FROM the isocentre (gantry z=0) for the scan length; row 0 is
    // the isocentre, row nz-1 is scanLen away. Orientation only flips the display.
    const z = -(j / (nz - 1)) * scanLen;
    const src = [sx, sy, z];
    for (let i = 0; i < nw; i++) {
      const u = (i - halfU) * pxU;
      let dx = dcx + ux * u - sx, dy = dcy + uy * u - sy, dz = 0;   // cell z == src z -> dz 0
      const dist = Math.hypot(dx, dy, dz); dx /= dist; dy /= dist; dz /= dist;
      const { bone, soft, marrow } = phantom.trace(src, [dx, dy, dz], dist);
      let T = 0;
      for (let b = 0; b < bins.length; b++) T += bins[b].w * Math.exp(-(muSoft[b] * soft + muBone[b] * bone + muMarr[b] * marrow));
      dose[j * nw + i] = I0 * (refDist2 / (dist * dist)) * T;
    }
  }
  return { dose, nw, nz };
}

// Grayscale topogram: attenuated (bone) -> bright, open field -> dark. Row 0 of the
// dose is the isocentre; orientation places it at the top (feet-first) or bottom
// (head-first) of the displayed image.
function drawScout(cv, data) {
  const { dose, nw, nz } = data;
  cv.width = nw; cv.height = nz;
  const g = cv.getContext('2d');
  const img = g.createImageData(nw, nz);
  const feet = ctx.S.ct.orientation === 'feet';    // isocentre at top when feet-first
  let mn = Infinity, mx = -Infinity;
  for (let k = 0; k < dose.length; k++) { const d = dose[k]; if (d < mn) mn = d; if (d > mx) mx = d; }
  const rng = (mx - mn) || 1;
  for (let k = 0; k < dose.length; k++) {
    const t = (dose[k] - mn) / rng;                 // 0 = most attenuated, 1 = open field
    const v = Math.round(255 * Math.pow(1 - t, 0.7));
    const j = (k / nw) | 0, i = k % nw;
    const imgRow = feet ? j : (nz - 1 - j);         // isocentre (row 0) top or bottom
    const o = (imgRow * nw + i) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

// keep the last scout data so orientation flips can redraw without re-scanning
let lastAP = null, lastLAT = null;
function redrawScouts() {
  if (lastAP) drawScout(ctx.$('scoutAP'), lastAP);
  if (lastLAT) drawScout(ctx.$('scoutLAT'), lastLAT);
}
