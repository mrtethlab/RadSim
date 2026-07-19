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
let couch = null, gantry = null;      // couch (moves) + gantry ring (static) — separate groups
let laserTop = null, laserSide = null; // projected alignment lasers (SpotLights) + their cookies
let laserTopTex = null, laserSideTex = null;

const SLICE_MM = [0.625, 1.25, 2.5, 5, 10];   // slice-thickness stations
const MM_PER_UNIT = 10;                        // 1 world unit = 10 mm
const ISO_Y = 6;                               // gantry vertical isocentre (bore centre, world units)
// scout field of view (mm across the image). Equal for AP and LAT so the two
// scouts share the SAME aspect ratio and the scan box is a circular FOV (cylinder).
const SCOUT_FOV_MM = 180;
const SCOUT_WIDTH_MM = { AP: SCOUT_FOV_MM, LAT: SCOUT_FOV_MM };
// CT patient vertical position (world units) for the current table height. Default
// table height (0) centres the patient at the gantry isocentre.
function ctPatientY() { return ISO_Y + ctx.S.ct.tableY / MM_PER_UNIT; }

const scanLenU = () => ctx.S.ct.scanLen / MM_PER_UNIT;             // scan length in world units
// Head-first is the only orientation: the couch always feeds the patient INTO the
// gantry (world -z), advancing the table position in the inferior (+I) direction.
// table position -> "I###.#" (inferior), "S###.#" (superior), or "0.0" (all mm)
function fmtTablePos(mm) { return mm > 0.05 ? 'I' + mm.toFixed(1) : mm < -0.05 ? 'S' + (-mm).toFixed(1) : '0.0'; }

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
  // keep the scout panels row-locked at the shared scale when the window resizes
  window.addEventListener('resize', () => {
    if (ctx.$('ctScouts')?.classList.contains('show')) layoutScouts();
  });
}

// Build the CT rig. Two separate groups so the machine behaves like a real CT:
//   couch  = pad + rail  -> MOVES (table travel in z, table height in y)
//   gantry = bore ring   -> STATIC (never moves; the patient travels through it)
// Plus two projected alignment lasers (SpotLights, like the x-ray light field).
function buildCTScene() {
  const { THREE, three } = ctx;

  // ---- couch (moving) ----
  couch = new THREE.Group();
  const padMat = new THREE.MeshStandardMaterial({ color: 0x232a31, metalness: 0.2, roughness: 0.75 });
  const pad = new THREE.Mesh(new THREE.BoxGeometry(15, 1.2, 66), padMat);
  pad.position.set(0, -0.6, 8); pad.receiveShadow = true; couch.add(pad);   // pad top at local y=0
  const rail = new THREE.Mesh(new THREE.BoxGeometry(15.6, 0.5, 66), new THREE.MeshStandardMaterial({ color: 0x2f3a44, metalness: 0.4, roughness: 0.5 }));
  rail.position.set(0, -1.15, 8); couch.add(rail);
  couch.visible = false; three.scene.add(couch);

  // ---- gantry (static) ----
  gantry = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(15, 3.4, 18, 44),
    new THREE.MeshStandardMaterial({ color: 0x3c4753, metalness: 0.55, roughness: 0.4, emissive: 0x141a20, emissiveIntensity: 1 }));
  ring.position.set(0, ISO_Y, 0); gantry.add(ring);                          // bore centred at the isocentre
  const ringIn = new THREE.Mesh(new THREE.TorusGeometry(12, 0.7, 12, 44),
    new THREE.MeshStandardMaterial({ color: 0x11161b, metalness: 0.3, roughness: 0.8 }));
  ringIn.position.set(0, ISO_Y, 1.4); gantry.add(ringIn);
  gantry.visible = false; three.scene.add(gantry);

  // ---- projected alignment lasers ----
  // Red SpotLights whose cookie (map) is a laser pattern: the map is white only on
  // the laser lines, so the red light lands only there, projected onto whatever
  // surface it hits (patient + couch) — exactly like the collimator light field.
  const mkLaser = (drawCookie) => {
    const SZ = 256;
    const cv = document.createElement('canvas'); cv.width = cv.height = SZ;
    drawCookie(cv);
    const tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
    const sl = new THREE.SpotLight(0xff2222, 0, 200, 0.62, 0.02, 0.0);       // red, no distance decay
    sl.map = tex; sl.castShadow = false;
    sl.visible = false; three.scene.add(sl); three.scene.add(sl.target);
    return { sl, tex };
  };
  // TOP laser: axial line (scan plane, across x) + a short centre-cross tick.
  const top = mkLaser(drawTopLaserCookie);
  laserTop = top.sl; laserTopTex = top.tex;
  laserTop.shadow.camera.up.set(0, 0, -1);            // world z -> cookie vertical
  // SIDE laser: a single horizontal line marking the gantry-centre height (y = ISO_Y).
  const side = mkLaser(drawSideLaserCookie);
  laserSide = side.sl; laserSideTex = side.tex;
  laserSide.shadow.camera.up.set(0, 1, 0);            // world y -> cookie vertical
}

// TOP laser cookie: a full-width axial line (the scan plane) plus a short vertical
// centre tick, forming a cross at the exact centre.
function drawTopLaserCookie(cv) {
  const S = cv.width, g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  g.strokeStyle = '#fff'; g.lineCap = 'round';
  g.lineWidth = Math.max(1.2, S * 0.008);                                    // thin laser line
  g.beginPath(); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke();          // axial line (across x)
  g.beginPath(); g.moveTo(S / 2, S * 0.34); g.lineTo(S / 2, S * 0.66); g.stroke(); // centre cross tick
}
// SIDE laser cookie: one horizontal line at centre -> marks y = gantry isocentre.
function drawSideLaserCookie(cv) {
  const S = cv.width, g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  g.strokeStyle = '#fff'; g.lineCap = 'round';
  g.lineWidth = Math.max(1.2, S * 0.008);                                    // thin laser line
  g.beginPath(); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke();
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
  if (!ctx || !couch) return;
  const { three, S } = ctx;
  const isCT = S.mode === 'ct';
  const showLaser = isCT && (laserTop != null);
  couch.visible = isCT;
  gantry.visible = isCT;               // gantry is STATIC — position never changes
  laserTop.visible = laserSide.visible = showLaser;
  laserTop.intensity = laserSide.intensity = showLaser ? 7 : 0;
  if (three.det) three.det.visible = !isCT;           // hide the flat-panel detector in CT
  if (three.detMarks) three.detMarks.visible = !isCT; // and its corner brackets
  three.handGroup.rotation.y = 0;      // head-first only — no patient flip
  if (isCT) {
    const py = ctPatientY();
    S.ct.patientY = py;                                 // buildPhantom bakes this y
    // patient rides the couch: table height in y, direction-pad offset in x/z. The
    // scan animation later drives couch.position.z + handGroup.position.z directly.
    three.handGroup.position.x = S.ct.patient.x;
    three.handGroup.position.y = py;
    three.handGroup.position.z = S.ct.patient.z;
    couch.position.y = py - 0.4;                         // pad top just under the patient
    couch.position.z = 0;                               // base; animateTableTravel drives it
    // gantry + lasers stay fixed at the isocentre (only the couch + patient move)
    gantry.position.set(0, 0, 0);
    laserTop.position.set(0, ISO_Y + 20, 0); laserTop.target.position.set(0, ISO_Y, 0);
    laserTop.target.updateMatrixWorld();
    laserSide.position.set(22, ISO_Y, 0); laserSide.target.position.set(0, ISO_Y, 0);
    laserSide.target.updateMatrixWorld();
    // no collimator light field in CT — only the lasers
    three.lamp.intensity = 0; three.lamp.castShadow = false;
    three.cr.visible = false;
    three.amb.intensity = 0.9; three.key.intensity = 0.9;
  } else {
    three.handGroup.position.x = 0;
    three.handGroup.position.z = 0;
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

// Tear down the CT scout session to a clean slate: no scouts, no live-view mirror,
// idle console, patient/couch/isocentre zeroed. Called on every mode switch so the
// two modes never share leftover state.
function resetCTSession() {
  const c = ctx.S.ct;
  cancelScout();                  // stop any in-flight scout acquisition
  ctx.ctLiveView(false);          // stop the tube-POV mirror if a build was running
  c.scoutsReady = false;
  c.liveView = false;
  c.isocentred = false;
  c.isoZ = 0;
  c.tablePos = 0;
  c.tableY = 0;                    // default table height is the centred position
  c.patient.x = 0; c.patient.z = 0;
  const th = ctx.$('ctTableH'); if (th) th.value = 0;
  lastAP = lastLAT = null;
  ctx.$('ctScouts')?.classList.remove('show');
  setPhase('idle');               // resets the console label, flash + 3D-enable
  setConsoleEnabled(true);
}

function applyMode(mode) {
  ctx.S.mode = mode;
  document.body.classList.toggle('mode-ct', mode === 'ct');
  document.body.classList.toggle('mode-xray', mode !== 'ct');
  const bar = ctx.$('modeBar');
  if (bar) [...bar.querySelectorAll('button')].forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  const tag = document.querySelector('.baytag .s');
  if (tag) tag.textContent = mode === 'ct' ? 'CT · transverse acquisition' : 'Digit · Hand phantom';
  // A mode switch is a clean slate: tear down the CT scout workflow and any carried
  // view state so nothing from the other mode lingers (stale image, scout overlay,
  // tube-POV camera, Image view). Acquisition params + technique are user setup and
  // deliberately persist.
  resetCTSession();
  ctx.setCameraView('orbit');     // drop the CT tube-POV camera
  ctx.setContent('3d');           // always land in the positioning view, never a stale image
  ctx.setBay3DEnabled(true);
  ctx.refreshFilmViewer();        // isolate the two modes' images (clear x-ray in CT)
  greyHelical(mode === 'ct');     // helical params don't apply to a scout
  setHint(mode === 'ct' ? 'Set the isocentre, then acquire scouts to plan the scan.' : '');
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
  // table height — raises/lowers the patient relative to the gantry isocentre
  $('ctTableH')?.addEventListener('input', (e) => {
    S.ct.tableY = parseFloat(e.target.value);
    ctx.syncScene();            // reposition the patient + couch in y
    updateCTReadouts();
  });
  // isocentre confirm — zero the table position reading (patient stays put)
  $('ctIsocentre')?.addEventListener('click', () => {
    S.ct.tablePos = 0; S.ct.isoZ = S.ct.patient.z; S.ct.isocentred = true;
    setHint('Isocentre set. Acquire scouts to begin planning.');
    updateCTReadouts();
  });
  // direction pad — nudge the patient/couch; longitudinal travel shows as table position
  const STEP = 1;                       // world unit per press (= 10 mm)
  $('ctDpad')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-dir]'); if (!b) return;
    const p = S.ct.patient, dmm = STEP * MM_PER_UNIT;
    switch (b.dataset.dir) {
      case 'up':    p.z -= STEP; S.ct.tablePos += dmm; break;   // table into the gantry (+I)
      case 'down':  p.z += STEP; S.ct.tablePos -= dmm; break;   // table out (-S)
      case 'left':  p.x -= STEP; break;
      case 'right': p.x += STEP; break;
    }
    S.ct.isocentred = false;
    ctx.syncScene();          // ctSyncScene re-applies the patient offset
    updateCTReadouts();
  });
}

// A scout has NO gantry rotation — the tube is parked and the couch simply
// translates the patient through the beam at a constant speed. So the scout scan
// time is just scan length / table speed (independent of pitch / rotation speed /
// images-per-rotation, which only govern the later helical diagnostic scan).
const SCOUT_SPEED_MMPS = 80;                                 // scout couch speed (mm/s)
function scoutScanTime() { return ctx.S.ct.scanLen / SCOUT_SPEED_MMPS; }   // seconds

function updateCTReadouts() {
  const { S, $ } = ctx;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('ctSliceThkV', S.ct.sliceThk + ' mm');
  set('ctImgV', S.ct.imgPerRotation);
  set('ctPitchV', S.ct.pitch.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
  set('ctRotSpeedV', S.ct.rotSpeed.toFixed(2) + ' s');
  set('ctScanLenV', S.ct.scanLen + ' mm');
  const et = scoutScanTime();
  set('ctExpTimeV', (et < 10 ? et.toFixed(1) : Math.round(et)) + ' s');
  set('ctTablePosV', fmtTablePos(S.ct.tablePos));
  // Scan extent readouts. For a scout the scan always runs from the isocentre
  // (0.0) to I(scan length). Phase 3's draggable scan box will drive these from
  // the box edges instead (start = box near edge, end = box far edge).
  set('ctScanStartV', fmtTablePos(0) + ' mm');
  set('ctScanEndV', fmtTablePos(S.ct.scanLen) + ' mm');
  set('ctTableHV', (S.ct.tableY > 0 ? '+' : '') + S.ct.tableY + ' mm' + (S.ct.tableY === 0 ? ' · centred' : ''));
}

function setHint(t) { const el = ctx.$('ctHint'); if (el) el.textContent = t; }

// Grey out the helical-only params (images/rotation, pitch, rotation speed): a
// scout has no gantry rotation, so they don't apply. Re-enabled when the helical
// diagnostic-scan phase is built.
function greyHelical(on) {
  document.querySelectorAll('.ctHelical').forEach(el => el.classList.toggle('off', on));
}

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
  // while the scout window owns the bay for planning, the 3D view is greyed out
  ctx.setBay3DEnabled(!(p === 'scout' || p === 'planning'));
}

function setConsoleEnabled(on) {
  ['ctStart', 'ctAbort', 'ctTable'].forEach(id => { const b = ctx.$(id); if (b) b.disabled = !on; });
}

// Scouts live in the bay's Image view. Turning them on marks them ready and
// switches the bay to Image (which reveals the scout window); off just refreshes
// the current view so they drop away.
function showScouts(on) {
  ctx.S.ct.scoutsReady = on;
  ctx.setContent(on ? 'image' : ctx.S.bayContent);
}

function abortCT() {
  cancelScout();               // stop any in-flight scout acquisition
  ctx.ctLiveView(false);       // drop the tube-POV mirror if a build was in progress
  ctx.S.ct.scoutsReady = false;
  setPhase('idle');            // re-enables the 3D view
  ctx.setContent('3d');        // back to the positioning view
  ctx.syncScene();             // restore the model/bed after any scan animation
  setHint('Set the isocentre, then acquire scouts to plan the scan.');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Phase 2: scout acquisition with a simulated patient scan ----
// START (idle) runs two acquisitions (AP then Lateral). Each: breathe-in -> 1s
// hold -> exposure (buzz + table travel through the gantry) -> breathe-normally.
// The topogram is a stack of fixed-gantry fan views (one per table position); it
// STITCHES IN row-by-row as the table advances, so the image on screen always
// matches exactly the anatomy the couch has swept under the imaging plane.
async function acquireScouts() {
  const tok = ++scoutToken;                 // this run's token; a reset/abort bumps it
  const alive = () => tok === scoutToken;
  setPhase('scout');                  // greys out the 3D view; scout window owns the bay
  setConsoleEnabled(false);
  resetToIsocentre();                 // compute the scouts from the isocentre position
  let ap, lat;
  try {
    ap = scoutProjection('AP');
    lat = scoutProjection('LAT');
  } catch (err) {
    console.error('scout compute failed', err);
    setHint('Scout acquisition failed: ' + err.message);
    setPhase('idle'); ctx.setContent('3d'); setConsoleEnabled(true); return;
  }
  lastAP = ap; lastLAT = lat;
  showScouts(true);                   // switch the bay to the Image (scout) view
  // reveal the (blank) panels so each topogram is visibly stitched during its pass
  drawScout(ctx.$('scoutAP'), ap, 0);
  drawScout(ctx.$('scoutLAT'), lat, 0);
  layoutScouts();                     // shared scale + row alignment across AP/LAT
  ctx.ctLiveView(true);               // watch the scan in the small monitor (tube POV)
  try {
    await runScoutExposure('AP', ap, alive);
    if (!alive()) return;
    await runScoutExposure('LAT', lat, alive);
    if (!alive()) return;
  } finally {
    if (alive()) ctx.ctLiveView(false);
  }
  resetToIsocentre();                 // settle the patient back at the isocentre
  setPhase('planning');
  setHint('Scouts acquired — position the scan box (next phase). START confirms the plan.');
  setConsoleEnabled(true);
}

// Put the patient/couch back at the isocentre (table 0) before an acquisition.
function resetToIsocentre() {
  const { S } = ctx;
  S.ct.patient.z = S.ct.isoZ;   // model back to where it was when the isocentre was set
  S.ct.tablePos = 0;
  ctx.syncScene();               // applies patient.z, resets the bed
  updateCTReadouts();
}

// One animated acquisition: breathe-in, 1s hold, exposure (buzz + table travel
// while the topogram stitches in), breathe-out. The exposure sound + table travel
// + row-by-row stitching all run for the calculated exposure time.
async function runScoutExposure(view, data, alive = () => true) {
  const cv = ctx.$(view === 'AP' ? 'scoutAP' : 'scoutLAT');
  Sound.resume();
  resetToIsocentre();
  drawScout(cv, data, 0);                                   // start from a blank field
  setHint(view + ' scout · breathe in and hold…');
  Sound.play('breathIn');
  await sleep((Sound.duration('breathIn') || 2) * 1000);   // let the breathe-in finish
  if (!alive()) return;
  await sleep(1000);                                        // 1 s hold before the exposure
  if (!alive()) return;
  setHint(view + ' scout · scanning…');
  Sound.startBuzz();
  // stitch rows 0..t as the couch advances -> image builds in lockstep with travel
  await animateTableTravel(scoutScanTime() * 1000, (t) => drawScout(cv, data, t * data.nz), alive);
  Sound.stopBuzz();
  if (!alive()) return;
  drawScout(cv, data);                                      // guarantee the final full frame
  setHint(view + ' scout · breathe normally.');
  Sound.play('breathNormal');
  await sleep(Math.min(2200, (Sound.duration('breathNormal') || 1.8) * 1000));
}

// Move the couch (bed + patient) the scan length into the gantry over the exposure
// time, updating the table-position readout and calling onFrame(t) each step
// (t: 0->1). Head-first: the table always feeds into the bore (-z), ending at
// table position +scanLen (inferior).
function animateTableTravel(dur, onFrame, alive = () => true) {
  return new Promise(res => {
    const three = ctx.three, S = ctx.S;
    const travelU = scanLenU();                        // world units to travel
    const startHandZ = three.handGroup.position.z, startCouchZ = couch.position.z;
    const tpEnd = S.ct.scanLen;                        // mm, inferior (+I)
    const t0 = performance.now();
    let done = false;
    const apply = (t) => {
      const dz = -travelU * t;                         // travel into the bore (-z)
      three.handGroup.position.z = startHandZ + dz;
      couch.position.z = startCouchZ + dz;             // couch moves; gantry stays fixed
      S.ct.tablePos = tpEnd * t;                       // live table position (mm)
      updateCTReadouts();
      if (onFrame) onFrame(t);
    };
    const finish = () => { if (done) return; done = true; res(); };
    (function step() {
      if (done) return;
      if (!alive()) { finish(); return; }              // session torn down -> stop moving the couch
      const t = Math.min(1, (performance.now() - t0) / dur);
      apply(t);
      if (t < 1) requestAnimationFrame(step); else { apply(1); finish(); }
    })();
    setTimeout(() => { if (!done) { if (alive()) apply(1); finish(); } }, dur + 500);
  });
}

// One scout: a distortion-free topogram acquired exactly as a real scan is — a
// stack of very thin fan views from a FIXED gantry, one per table position, as the
// couch translates the patient through the z=0 imaging plane. Fixing the source at
// z=0 while the patient shifts by dz is identical to holding the patient still and
// placing the source at z=dz with an in-plane (dz=0) fan, so we evaluate it that
// way per row: no z-divergence -> zero distortion, fan only across the width.
//
// Row j is table step j: the couch has advanced the patient j/(nz-1) * scanLen INTO
// the bore, so the imaging plane sits over patient +z = +(j/(nz-1))*lenU. This is
// the SAME +z region the table-travel animation sweeps, so the stitched image and
// the on-screen motion always show the same anatomy.
function scoutProjection(view) {
  const { S } = ctx;
  const phantom = ctx.buildPhantom();               // CT patient (offset baked in CT mode)
  const bins = Spectrum.make(S.kv).bins;
  const muSoft = bins.map(b => Materials.mu('soft', b.E));
  const muBone = bins.map(b => Materials.mu('bone', b.E));
  const muMarr = bins.map(b => Materials.mu('marrow', b.E));
  const I0 = S.mas * Math.pow(S.kv / 70, 2);
  const PXMM = 1.5;                                  // mm per (square) pixel — undistorted
  const lenU = scanLenU();                           // scan length in world units (z axis)
  const widthMM = SCOUT_WIDTH_MM[view];              // width (AP) / thickness (LAT) field
  const nz = Math.max(2, Math.round(S.ct.scanLen / PXMM));
  const nw = Math.max(2, Math.round(widthMM / PXMM));
  const pxU = (widthMM / MM_PER_UNIT) / nw;          // == lenU/nz == PXMM/10 -> square pixels
  let sx, sy, dcx, dcy, ux, uy;
  // LAT is taken from the GANTRY CENTRE (y = ISO_Y): the vertical window is centred
  // on the isocentre, NOT the patient, so a wrong table height leaves the body part
  // off-centre in the lateral image. AP images across x (table height doesn't shift it).
  if (view === 'AP') { sx = 0; sy = 100; dcx = 0; dcy = 0; ux = 1; uy = 0; }
  else { sx = 100; sy = ISO_Y; dcx = -8; dcy = ISO_Y; ux = 0; uy = 1; }
  const refDist2 = (sx - dcx) * (sx - dcx) + (sy - dcy) * (sy - dcy);
  const halfU = (nw - 1) / 2;
  const dose = new Float32Array(nw * nz);
  let mn = Infinity, mx = -Infinity;
  for (let j = 0; j < nz; j++) {
    // couch step j: imaging plane over patient +z (the region the table sweeps)
    const z = (j / (nz - 1)) * lenU;
    const src = [sx, sy, z];
    for (let i = 0; i < nw; i++) {
      const u = (i - halfU) * pxU;
      let dx = dcx + ux * u - sx, dy = dcy + uy * u - sy, dz = 0;   // cell z == src z -> dz 0
      const dist = Math.hypot(dx, dy, dz); dx /= dist; dy /= dist; dz /= dist;
      const { bone, soft, marrow } = phantom.trace(src, [dx, dy, dz], dist);
      let T = 0;
      for (let b = 0; b < bins.length; b++) T += bins[b].w * Math.exp(-(muSoft[b] * soft + muBone[b] * bone + muMarr[b] * marrow));
      const d = I0 * (refDist2 / (dist * dist)) * T;
      dose[j * nw + i] = d;
      if (d < mn) mn = d; if (d > mx) mx = d;
    }
  }
  return { dose, nw, nz, mn, mx };                   // mn/mx: fixed window for stable stitching
}

// Paint the topogram: attenuated (bone) -> bright, open field -> dark. Row 0 of the
// dose is the isocentre and sits at the BOTTOM of the image (head-first); rows fill
// upward as the couch advances. rowLimit (default = all) draws only the rows the
// table has reached so far, so the image stitches in during the travel. The gray
// window is the scan's fixed mn/mx so a strip's brightness doesn't shift as more
// rows arrive.
function drawScout(cv, data, rowLimit) {
  if (!cv) return;
  const { dose, nw, nz, mn, mx } = data;
  const lim = rowLimit == null ? nz : Math.max(0, Math.min(nz, Math.round(rowLimit)));
  if (cv.width !== nw || cv.height !== nz) { cv.width = nw; cv.height = nz; }
  const g = cv.getContext('2d');
  const img = g.createImageData(nw, nz);
  const d8 = img.data;
  for (let k = 0; k < d8.length; k += 4) { d8[k] = d8[k + 1] = d8[k + 2] = 0; d8[k + 3] = 255; } // unscanned = black
  const rng = (mx - mn) || 1;
  for (let j = 0; j < lim; j++) {
    const imgRow = nz - 1 - j;                       // isocentre (row 0) at the bottom
    for (let i = 0; i < nw; i++) {
      const t = (dose[j * nw + i] - mn) / rng;        // 0 = most attenuated, 1 = open field
      const v = Math.round(255 * Math.pow(1 - t, 0.7));
      const o = (imgRow * nw + i) * 4;
      d8[o] = d8[o + 1] = d8[o + 2] = v;
    }
  }
  g.putImageData(img, 0, 0);
}

// Lay the two scouts out at ONE shared mm->px scale, top-aligned, so a horizontal
// line crosses both panels at the SAME table position (they differ only as
// orthogonal views). AP ends up twice as wide as LAT (180 vs 90 mm); both share the
// same height (scan length), which is what lets a scan box lock the two views into a
// single 3D cylinder. The panel aspect follows scan length: short scans read square,
// long scans read portrait.
function layoutScouts() {
  const box = ctx.$('ctScouts');
  const ap = ctx.$('scoutAP'), lat = ctx.$('scoutLAT');
  if (!box || !ap || !lat) return;
  const len = ctx.S.ct.scanLen;                        // mm along the scan axis (both)
  const wAP = SCOUT_WIDTH_MM.AP, wLAT = SCOUT_WIDTH_MM.LAT;
  const cs = getComputedStyle(box);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const colGap = parseFloat(cs.columnGap || cs.gap) || 16;
  const hdr = box.querySelector('.scouthdr');
  const hdrH = (hdr ? hdr.offsetHeight : 18) + 6;      // header + column inner gap
  const availW = Math.max(40, box.clientWidth - padX - colGap);
  const availH = Math.max(40, box.clientHeight - padY - hdrH);
  const scale = Math.min(availW / (wAP + wLAT), availH / len);   // shared px per mm
  const set = (cv, wmm) => { cv.style.width = (wmm * scale) + 'px'; cv.style.height = (len * scale) + 'px'; };
  set(ap, wAP); set(lat, wLAT);
}

// keep the last scout data for later phases (scan box) to reuse the geometry/dims
let lastAP = null, lastLAT = null;
// token that invalidates an in-flight scout when the session is torn down (mode
// switch / abort), so a running acquisition stops moving the couch in the background.
let scoutToken = 0;
function cancelScout() { scoutToken++; }
