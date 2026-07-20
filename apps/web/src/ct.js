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
import { Materials, BodyMaterials } from './core/materials.js';
import { muOverBins, muAtEnergy } from './core/voxelPhantom.js';
import { Sound } from './audio/sound.js';

let ctx = null;
let couch = null, gantry = null, gantrySpin = null;  // couch (moves) + gantry ring (static) + rotating tube/detector (scan only)
let scanMarkers = null;               // usability aid: coloured lines at scan start/end + a direction arrow
let laserTop = null, laserSide = null; // projected alignment lasers (SpotLights) + their cookies
let laserTopTex = null, laserSideTex = null;

const SLICE_MM = [0.625, 1.25, 2.5, 5, 10];   // slice-thickness stations
const MM_PER_UNIT = 10;                        // 1 world unit = 10 mm
const ISO_Y = 6;                               // gantry vertical isocentre (bore centre, world units)
const BORE_R = 35;                             // bore hole radius (world units) → 700 mm bore, real-CT scale
// scout field of view (mm across the image). Equal for AP and LAT so the two
// scouts share the SAME aspect ratio and the scan box is a circular FOV (cylinder).
const SCOUT_FOV_MM = 180;                       // default (hand); the chest widens it (see S.ct.scoutFovMM)
const scoutFov = () => (ctx && ctx.S.ct.scoutFovMM) || SCOUT_FOV_MM;   // scan/scout FOV width (mm), subject-adaptive
// CT patient vertical position (world units) for the current table height. Default
// table height (0) centres the patient at the gantry isocentre.
function ctPatientY() { return ISO_Y + ctx.S.ct.tableY / MM_PER_UNIT; }

const scanLenU = () => ctx.S.ct.scanLen / MM_PER_UNIT;             // scan length in world units
// Head-first is the only orientation: the couch always feeds the patient INTO the
// gantry (world -z), advancing the table position in the inferior (+I) direction.
// table position -> "I###.0" (inferior), "S###.0" (superior), or "0.0" (mm, rounded
// to the nearest mm so only a .0 decimal is ever shown)
function fmtTablePos(mm) { const r = Math.round(mm); return r > 0 ? 'I' + r.toFixed(1) : r < 0 ? 'S' + (-r).toFixed(1) : '0.0'; }

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
  // TABLE UP / DOWN: an up/down arrow over a reclining patient on the couch.
  tableUp: '<svg viewBox="0 0 24 24" aria-hidden="true">' +
           '<path class="stroke" d="M7 8 L12 3.5 L17 8"/><path class="stroke" d="M12 3.7 L12 10"/>' +
           '<circle cx="7.3" cy="14.6" r="1.5" fill="currentColor"/>' +
           '<path class="stroke" d="M9.2 16 Q13 14 16.8 16"/>' +
           '<path class="stroke" d="M4.5 17.7 H19.5 M6.6 17.9 V20.8 M17.4 17.9 V20.8"/></svg>',
  tableDown: '<svg viewBox="0 0 24 24" aria-hidden="true">' +
             '<path class="stroke" d="M7 6 L12 10.5 L17 6"/><path class="stroke" d="M12 4 L12 10.3"/>' +
             '<circle cx="7.3" cy="14.6" r="1.5" fill="currentColor"/>' +
             '<path class="stroke" d="M9.2 16 Q13 14 16.8 16"/>' +
             '<path class="stroke" d="M4.5 17.7 H19.5 M6.6 17.9 V20.8 M17.4 17.9 V20.8"/></svg>',
};

export function initCT(context) {
  ctx = context;
  buildCTScene();
  injectSymbols();
  wireModeToggle();
  wireCTSettings();
  wireCTConsole();
  initScanBoxes();
  wireStorage();
  wireSliceViewer();
  wireRecons();
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

  // ---- couch (moving) ---- real-CT scale: a long, wide pallet the patient lies on
  couch = new THREE.Group();
  const padMat = new THREE.MeshStandardMaterial({ color: 0x232a31, metalness: 0.2, roughness: 0.75 });
  const pad = new THREE.Mesh(new THREE.BoxGeometry(46, 3, 220), padMat);
  pad.position.set(0, -1.5, 8); pad.receiveShadow = true; couch.add(pad);    // pad top at local y=0
  const rail = new THREE.Mesh(new THREE.BoxGeometry(50, 2, 220), new THREE.MeshStandardMaterial({ color: 0x2f3a44, metalness: 0.4, roughness: 0.5 }));
  rail.position.set(0, -4, 8); couch.add(rail);
  couch.visible = false; three.scene.add(couch);

  // ---- gantry (static) ---- ~700 mm bore so a real torso passes through cleanly
  gantry = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(BORE_R + 9, 9, 24, 72),
    new THREE.MeshStandardMaterial({ color: 0x3c4753, metalness: 0.55, roughness: 0.4, emissive: 0x141a20, emissiveIntensity: 1 }));
  ring.position.set(0, ISO_Y, 0); gantry.add(ring);                          // bore centred at the isocentre
  const ringIn = new THREE.Mesh(new THREE.TorusGeometry(BORE_R, 1.6, 12, 72),
    new THREE.MeshStandardMaterial({ color: 0x11161b, metalness: 0.3, roughness: 0.8 }));
  ringIn.position.set(0, ISO_Y, 3.5); gantry.add(ringIn);
  // rotating tube/detector assembly inside the bore — spins about the bore axis (z)
  // during a scan so the acquisition is visible. Static (parked) otherwise.
  gantrySpin = new THREE.Group(); gantrySpin.position.set(0, ISO_Y, 3);
  const tubeBlk = new THREE.Mesh(new THREE.BoxGeometry(8, 5, 3.5),
    new THREE.MeshStandardMaterial({ color: 0xffd27a, emissive: 0xffb733, emissiveIntensity: 0.9, metalness: 0.3, roughness: 0.4 }));
  tubeBlk.position.set(0, BORE_R + 3, 0); gantrySpin.add(tubeBlk);           // focal spot at top of the ring
  const detArc = new THREE.Mesh(new THREE.TorusGeometry(BORE_R, 2.5, 8, 40, Math.PI * 0.9),
    new THREE.MeshStandardMaterial({ color: 0x1a2833, emissive: 0x0a2230, emissiveIntensity: 0.6, metalness: 0.4, roughness: 0.5 }));
  detArc.rotation.z = -Math.PI / 2 - Math.PI * 0.45; detArc.position.set(0, 0, 0); gantrySpin.add(detArc);   // opposing detector arc
  gantrySpin.visible = false; gantry.add(gantrySpin);
  gantry.visible = false; three.scene.add(gantry);

  // ---- scan-range markers (usability aid, not physical) ----
  // green line = scan START (at the isocentre), red line = scan END, orange arrow = the
  // direction the couch feeds during the scan. Positioned/sized in ctSyncScene.
  scanMarkers = new THREE.Group();
  const barGeo = new THREE.BoxGeometry(1, 0.25, 0.25);
  const mkBar = (color) => new THREE.Mesh(barGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
  const startBar = mkBar(0x39ff8a), endBar = mkBar(0xff5a5a);
  startBar.name = 'start'; endBar.name = 'end';
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(1.4, 4, 16), new THREE.MeshBasicMaterial({ color: 0xffb23e }));
  arrow.name = 'arrow'; arrow.rotation.x = Math.PI / 2;   // point along +z by default
  scanMarkers.add(startBar, endBar, arrow);
  scanMarkers.visible = false; three.scene.add(scanMarkers);

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
  set('ctTableUp', SYM.tableUp);
  set('ctTableDown', SYM.tableDown);
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
  if (three.detArrow) three.detArrow.visible = !isCT; // and the hang-direction arrow
  three.handGroup.rotation.y = 0;      // head-first only — no patient flip
  if (isCT) {
    const py = ctPatientY();
    S.ct.patientY = py;                                 // buildPhantom bakes this y
    // patient rides the couch: table height in y, direction-pad offset in x/z. The
    // scan animation later drives couch.position.z + handGroup.position.z directly.
    three.handGroup.position.x = S.ct.patient.x;
    three.handGroup.position.y = py;
    three.handGroup.position.z = S.ct.patient.z;
    // pad sits at the patient's posterior surface: just under the hand, or at the back
    // of the chest (its lower AP extent) so the isocentre still runs through mid-body.
    const backDrop = (S.subject === 'chest' && S.voxelModel) ? (S.voxelModel.extentMM[1] / 2) / MM_PER_UNIT : 0.4;
    couch.position.y = py - backDrop;
    couch.position.z = 0;                               // base; animateTableTravel drives it
    // gantry + lasers stay fixed at the isocentre (only the couch + patient move)
    gantry.position.set(0, 0, 0);
    laserTop.position.set(0, ISO_Y + BORE_R + 8, 0); laserTop.target.position.set(0, ISO_Y, 0);
    laserTop.target.updateMatrixWorld();
    laserSide.position.set(BORE_R + 8, ISO_Y, 0); laserSide.target.position.set(0, ISO_Y, 0);
    laserSide.target.updateMatrixWorld();
    // no collimator light field in CT — only the lasers
    three.lamp.intensity = 0; three.lamp.castShadow = false;
    three.cr.visible = false;
    three.amb.intensity = 1.55; three.key.intensity = 1.35;   // brighter — the big rig read too dark
  } else {
    three.handGroup.position.x = 0;
    three.handGroup.position.z = 0;
  }
  updateScanMarkers();
}

// Position the scan-range markers: green line at the scan start, red at the end, an
// orange arrow between them in the couch-feed direction. The scan images world z 0→
// lenU when the patient sits at isoZ, so at the current rest position the range is
// offset by (patient.z − isoZ). Purely a usability aid (not physical).
function updateScanMarkers() {
  if (!scanMarkers) return;
  const S = ctx.S, show = S.mode === 'ct';
  scanMarkers.visible = show;
  if (!show) return;
  const lenU = S.ct.scanLen / MM_PER_UNIT, off = S.ct.patient.z - S.ct.isoZ;
  const startZ = off, endZ = lenU + off, w = (scoutFov() / MM_PER_UNIT) * 1.1;
  const start = scanMarkers.getObjectByName('start'), end = scanMarkers.getObjectByName('end'), arrow = scanMarkers.getObjectByName('arrow');
  start.scale.set(w, 1, 1); start.position.set(0, ISO_Y, startZ);
  end.scale.set(w, 1, 1); end.position.set(0, ISO_Y, endZ);
  arrow.position.set(w / 2 + 3, ISO_Y, (startZ + endZ) / 2);
  arrow.rotation.x = endZ >= startZ ? Math.PI / 2 : -Math.PI / 2;   // point toward the scan end
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
  cancelScan();                   // stop any in-flight scan execution
  stopGantrySpin(); setBusy(false); Sound.stopBuzz();
  stopTableMove(); showScanBoxes(false); resetScanBox();
  ctx.ctLiveView(false);          // stop the tube-POV mirror if a build was running
  c.scoutsReady = false;
  c.liveView = false;
  c.isocentred = false;
  c.isoZ = 0;
  c.tablePos = 0;
  c.tableY = 0;                    // default table height is the centred position
  c.patient.x = 0; c.patient.z = 0;
  ctx.setCTPov('ap');              // back to the AP perspective
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
  const imgBtn = ctx.$('contentImageBtn');   // the Image view is the Scout window in CT
  if (imgBtn) imgBtn.textContent = mode === 'ct' ? 'Scout' : 'Image';
  // A mode switch is a clean slate: tear down the CT scout workflow and any carried
  // view state so nothing from the other mode lingers (stale image, scout overlay,
  // tube-POV camera, Image view). Acquisition params + technique are user setup and
  // deliberately persist.
  resetCTSession();
  // the chest arrives pre-isocentred at its superior end so START sweeps the whole
  // chest (the reset above wiped the defaults setSubject applied in the other mode);
  // the hand still requires setting the isocentre manually.
  if (mode === 'ct' && ctx.S.subject === 'chest' && ctx.S.voxelModel) {
    ctx.S.ct.isoZ = (ctx.S.voxelModel.extentMM[2] / 2) / 10;
    ctx.S.ct.isocentred = true;
  }
  if (mode === 'ct') ctx.setCTPov('ap');   // CT starts on the AP perspective
  else ctx.setCameraView('orbit');         // x-ray returns to free orbit
  ctx.setContent('3d');           // always land in the positioning view, never a stale image
  ctx.setBay3DEnabled(true);
  ctx.refreshFilmViewer();        // isolate the two modes' images (clear x-ray in CT)
  greyHelical(mode === 'ct');     // helical params don't apply to a scout
  if (mode === 'ct') renderStorage();   // reflect any scans still held from before
  setHint(mode === 'ct' ? 'Set the isocentre, then acquire scouts to plan the scan.' : '');
  ctx.syncScene();
  updateCTReadouts();
}

function wireCTSettings() {
  const { S, $ } = ctx;
  // scout technique steppers (kV / mA). The scout beam width is fixed at 1.0 mm.
  $('ctSettings')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ctstep]'); if (!b) return;
    const key = b.dataset.ctstep, d = parseInt(b.dataset.d, 10);
    if (key === 'scoutKv') S.ct.scoutKv = Math.max(70, Math.min(140, S.ct.scoutKv + d));
    else if (key === 'scoutMa') S.ct.scoutMa = Math.max(5, Math.min(200, S.ct.scoutMa + d));
    updateCTReadouts();
  });
  // scan length (range). Changing it does NOT live-update a scout: like a real CT,
  // re-scouting means ABORT then START (rescan) — table zero / isocentre persist.
  $('ctScanLen')?.addEventListener('input', (e) => { S.ct.scanLen = parseFloat(e.target.value); updateCTReadouts(); updateScanMarkers(); });
  // table height — raise / lower by 1 mm per press; hold to auto-repeat
  wireHoldRepeat($('ctTablePad'), 'button[data-th]', (b) => {
    S.ct.tableY = Math.max(-80, Math.min(80, S.ct.tableY + (b.dataset.th === 'up' ? 1 : -1)));
    ctx.syncScene(); updateCTReadouts();
  });
  // isocentre confirm — zero the table position reading (patient stays put)
  $('ctIsocentre')?.addEventListener('click', () => {
    S.ct.tablePos = 0; S.ct.isoZ = S.ct.patient.z; S.ct.isocentred = true;
    setHint('Isocentre set. Acquire scouts to begin planning.');
    updateCTReadouts();
  });
  // direction pad — nudge the patient/couch (10 mm/press); hold to auto-repeat
  const STEP = 1;                       // world unit per press (= 10 mm)
  wireHoldRepeat($('ctDpad'), 'button[data-dir]', (b) => {
    const p = S.ct.patient, dmm = STEP * MM_PER_UNIT;
    switch (b.dataset.dir) {
      case 'up':    p.z -= STEP; S.ct.tablePos += dmm; break;   // table into the gantry (+I)
      case 'down':  p.z += STEP; S.ct.tablePos -= dmm; break;   // table out (-S)
      case 'left':  p.x -= STEP; break;
      case 'right': p.x += STEP; break;
    }
    S.ct.isocentred = false;
    ctx.syncScene(); updateCTReadouts();
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
  set('ctScoutStartV', fmtTablePos(0) + ' mm');            // scout runs from the isocentre
  set('ctScoutEndV', fmtTablePos(S.ct.scanLen) + ' mm');
  set('ctScoutKvV', S.ct.scoutKv);
  set('ctScoutMaV', S.ct.scoutMa);
  set('ctScanLenV', S.ct.scanLen + ' mm');
  const et = scoutScanTime();
  set('ctExpTimeV', (et < 10 ? et.toFixed(1) : Math.round(et)) + ' s');
  set('ctTablePosV', fmtTablePos(S.ct.tablePos));
  // Scan extent readouts. Before planning the scan runs isocentre (0.0) -> I(scan
  // length); during planning updatePlan() drives these from the scan-box edges.
  if (S.ct.phase !== 'planning') {
    set('ctScanStartV', fmtTablePos(0) + ' mm');
    set('ctScanEndV', fmtTablePos(S.ct.scanLen) + ' mm');
  }
  const th = Math.round(S.ct.tableY);   // nearest mm, no decimals
  set('ctTableHV', (th > 0 ? '+' : '') + th + ' mm' + (th === 0 ? ' · centred' : ''));
}

function setHint(t) { const el = ctx.$('ctHint'); if (el) el.textContent = t; }

// Press-and-hold auto-repeat for a group of buttons: one step on press, then after
// a short delay it repeats at a steady rate while held (so large adjustments don't
// need repeated clicking).
function wireHoldRepeat(container, selector, step) {
  if (!container) return;
  container.addEventListener('pointerdown', (e) => {
    const b = e.target.closest(selector); if (!b || b.disabled) return;
    e.preventDefault();
    step(b);
    try { b.setPointerCapture(e.pointerId); } catch (_) {}
    let iv = null;
    const to = setTimeout(() => { iv = setInterval(() => step(b), 55); }, 340);   // delay -> repeat rate
    const stop = () => {
      clearTimeout(to); if (iv) clearInterval(iv);
      b.removeEventListener('pointerup', stop); b.removeEventListener('pointercancel', stop); b.removeEventListener('lostpointercapture', stop);
    };
    b.addEventListener('pointerup', stop); b.addEventListener('pointercancel', stop); b.addEventListener('lostpointercapture', stop);
  });
}

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
    // a subject swap is still streaming its voxel model in — starting a scout now
    // would acquire with half-swapped geometry (wrong FOV/isocentre)
    if (S.subjectLoading) { setHint('Subject model still loading — try again in a moment.'); return; }
    if (S.ct.phase === 'idle') acquireScouts();
    else if (S.ct.phase === 'planning') {
      if (ctx.$('ctStart').classList.contains('flash')) runScan();
      else setHint('Reposition the table first (hold the orange TABLE button).');
    }
  });
  $('ctAbort')?.addEventListener('click', abortCT);
  // TABLE is a press-and-HOLD: it drives the couch to the planned position while held.
  const tbl = $('ctTable');
  if (tbl) {
    tbl.addEventListener('pointerdown', (e) => { e.preventDefault(); try { tbl.setPointerCapture(e.pointerId); } catch (_) {} startTableMove(); });
    tbl.addEventListener('pointerup', stopTableMove);
    tbl.addEventListener('pointercancel', stopTableMove);
    tbl.addEventListener('lostpointercapture', stopTableMove);
  }
  setPhase('idle');
}

function setPhase(p) {
  const { S, $ } = ctx;
  S.ct.phase = p;
  // planning decides the flashing button from the plan; other phases flash nothing
  if (p === 'planning') { updatePlanReady(); }
  else { $('ctStart')?.classList.remove('flash'); $('ctTable')?.classList.remove('flash'); S.ct.moveBlit = null; showTableReminder(false); }
  const labels = { idle: 'CT · STANDBY', scout: 'CT · SCOUT', planning: 'CT · PLAN SCAN',
                   moving: 'CT · TABLE MOVE', scanning: 'CT · SCANNING', done: 'CT · COMPLETE' };
  const wt = $('ctWarnT'); if (wt) wt.textContent = labels[p] || 'CT';
  // 3D <-> Image can be swapped freely through the whole scout/plan workflow
  ctx.setBay3DEnabled(true);
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
  cancelScan();                // stop any in-flight scan execution
  stopGantrySpin(); setBusy(false); Sound.stopBuzz(); Sound.stopTableSound();
  stopTableMove(); showScanBoxes(false);
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
  resetScanBox(); renderScanBoxes(); showScanBoxes(true);
  setPhase('planning');
  updatePlan();                       // start/end readouts + flashing button
  setHint('Position the scan box on the scouts; adjust the table if prompted, then START.');
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
  ctx.setCTPov(view === 'AP' ? 'ap' : 'lat');   // watch each pass from its own perspective
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
  const bins = Spectrum.make(S.ct.scoutKv).bins, nb = bins.length;   // scout uses its own technique
  const voxel = !!phantom.voxel;                    // chest (voxel) vs hand (analytic) attenuation
  const muMat = voxel ? muOverBins(bins) : null, nmat = voxel ? muMat.length : 0;
  const hitId = voxel ? new Int32Array(nmat) : null, hitLen = voxel ? new Float64Array(nmat) : null;
  const muSoft = voxel ? null : bins.map(b => Materials.mu('soft', b.E));
  const muBone = voxel ? null : bins.map(b => Materials.mu('bone', b.E));
  const muMarr = voxel ? null : bins.map(b => Materials.mu('marrow', b.E));
  const I0 = S.ct.scoutMa * Math.pow(S.ct.scoutKv / 70, 2);
  // CT detector element (DEL) pitch ~1 mm — the scout's square pixel. Independent of
  // the x-ray DR detector resolution (~100 µm), which never applies to CT.
  const PXMM = 1.0;
  const lenU = scanLenU();                           // scan length in world units (z axis)
  const widthMM = scoutFov();              // width (AP) / thickness (LAT) field
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
      let T = 0;
      if (voxel) {
        const L = phantom.trace(src, [dx, dy, dz], dist);
        let nh = 0; for (let m = 1; m < nmat; m++) { const lm = L[m]; if (lm) { hitId[nh] = m; hitLen[nh] = lm; nh++; } }
        for (let b = 0; b < nb; b++) { let e = 0; for (let k = 0; k < nh; k++) e += muMat[hitId[k]][b] * hitLen[k]; T += bins[b].w * Math.exp(-e); }
      } else {
        const { bone, soft, marrow } = phantom.trace(src, [dx, dy, dz], dist);
        for (let b = 0; b < nb; b++) T += bins[b].w * Math.exp(-(muSoft[b] * soft + muBone[b] * bone + muMarr[b] * marrow));
      }
      const d = I0 * (refDist2 / (dist * dist)) * T;
      dose[j * nw + i] = d;
      if (d < mn) mn = d; if (d > mx) mx = d;
    }
  }
  // Display window for the log (line-integral) mapping: p = ln(open/dose). Normalise
  // to a high PERCENTILE of p, not the absolute densest ray, so a handful of extreme
  // paths (e.g. laterally through both shoulders) saturate to white instead of
  // compressing the whole gray scale. Computed once here so stitching stays stable.
  const floor = Math.max(mn, mx * 1e-12) || 1e-12;
  const ps = new Float32Array(nw * nz);
  for (let k = 0; k < ps.length; k++) ps[k] = Math.log(mx / Math.max(dose[k], floor));
  const sorted = Float32Array.from(ps).sort();
  const pmax = Math.max(sorted[Math.min(ps.length - 1, Math.floor(ps.length * 0.997))], 1e-3);
  return { dose, nw, nz, mn, mx, pmax };             // fixed window for stable stitching
}

// Paint the topogram: attenuated (bone) -> bright, open field -> dark. Row 0 of the
// dose is the isocentre and sits at the TOP of the image (= scan start); rows fill
// downward as the couch advances. rowLimit (default = all) draws only the rows the
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
  // Log (line-integral) display, like a real scout/DR system: gray ∝ ln(open/dose).
  // A body spans many DECADES of transmission (lungs ~e^-1, shoulders ~e^-12); a
  // linear dose window crushes everything but the densest ray to white — the classic
  // "underexposed" all-white scout. The log spreads those decades across the gray
  // scale: air black, lungs dark gray, mediastinum/spine mid-gray with detail, the
  // densest path white. Window fixed from the scan's mn/mx so stitching is stable.
  const floor = Math.max(mn, mx * 1e-12) || 1e-12;
  const pmax = data.pmax || Math.log(mx / floor) || 1;   // percentile window from scoutProjection
  const GAMMA = 1.4;                                  // film-like response: lungs dark, soft tissue mid-gray
  for (let j = 0; j < lim; j++) {
    const imgRow = j;                                // isocentre (row 0) at the top (= start)
    for (let i = 0; i < nw; i++) {
      const p = Math.min(1, Math.log(mx / Math.max(dose[j * nw + i], floor)) / pmax);   // 0 open … 1 dense (clip white)
      const v = Math.round(255 * Math.pow(p, GAMMA));
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
  const row = box && box.querySelector('.scoutrow');
  const ap = ctx.$('scoutAP'), lat = ctx.$('scoutLAT');
  if (!box || !row || !ap || !lat) return;
  const len = ctx.S.ct.scanLen;                        // mm along the scan axis (both)
  const wAP = scoutFov(), wLAT = scoutFov();
  const cs = getComputedStyle(row);
  const colGap = parseFloat(cs.columnGap || cs.gap) || 16;
  const hdr = box.querySelector('.scouthdr');
  const hdrH = (hdr ? hdr.offsetHeight : 18) + 6;      // header + column inner gap
  const availW = Math.max(40, row.clientWidth - colGap);
  const availH = Math.max(40, row.clientHeight - hdrH); // the scoutrow's own height (table sits below)
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

// ==================== Phase 4: scan groups (up to 4 planned scans) ====================
// Each scan group has its own coloured box on both scouts (per-group AP↔LAT cylinder
// lock) and its own parameters, shown as a colour-coded row in the scan-group table.
const BOX_MIN = 0.05;                 // smallest box extent (normalized)
const MOVE_THRESH = 0.5;              // mm: below this, no table move is needed
const TABLE_SPEED = 45;              // mm/s couch reposition speed (NOT the acquisition table speed)
const N_GROUPS = 4;
// ---- acquisition geometry stations (reference GE "Image Thickness" dialog) ----
const DET_ROW_OPTS = [8, 16, 32, 64, 128];        // detector rows (MDCT generations)
const ELEMENTS = [0.625, 1.25];                   // detector element sizes → beam collimation = rows × element
const ACQ_THK = [0.625, 1.25, 2.5, 3.75, 5, 7.5, 10];  // reconstructed helical-thickness stations
const PITCH_ACQ = [0.562, 0.938, 1.375, 1.75];    // pitch stations
const ROT_STATIONS = [0.25, 0.4, 0.5, 0.75, 1.0, 1.5, 2.0];   // s / rotation
// Derived acquisition values. Canonical stored fields: detRows, beamColl, pitch,
// sliceThk (= reconstructed helical thickness). Beam collimation = rows × detector
// element, so element (min recon thickness) = beamColl / rows; table speed (mm/rot)
// = pitch × beam collimation (⇒ pitch = table speed / beam collimation).
const acqThkOf = (g) => g.beamColl / g.detRows;             // detector element = min recon thickness (mm)
const tableSpeedOf = (g) => g.pitch * g.beamColl;           // table travel per rotation (mm/rot)
const validColls = (rows) => ELEMENTS.map((e) => rows * e); // beam-collimation stations for a row count
const detConfig = (g) => g.detRows + ' × ' + fmtNum(acqThkOf(g));
const nearestIn = (list, v) => list.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a, list[0]);

const grp = (i) => ctx.S.ct.groups[i];
const activeGrp = () => grp(ctx.S.ct.activeGroup);
const clampV = (v, a, b) => Math.max(a, Math.min(b, v));
function fmtNum(x) { return (Math.round(x * 1000) / 1000).toString(); }
function sanitizeNum(s, fallback) { const n = parseFloat(String(s).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : fallback; }

// calculated fields
function groupScanLenMM(g) { return Math.abs(g.box.bot - g.box.top) * ctx.S.ct.scanLen; }
function groupImages(g) { return Math.max(1, Math.round(groupScanLenMM(g) / Math.max(g.interval, 0.1))); }
// scan time = scan length / (table feed per second); feed/s = tableSpeed(mm/rot) / rotSpeed(s/rot)
function groupExpTime(g) { const feed = Math.max(tableSpeedOf(g), 1e-3); return (groupScanLenMM(g) / feed) * g.rotSpeed; }

function defaultGroups() {
  // detRows 16 × element 0.625 = 10 mm beam collimation; pitch 0.938 → 9.38 mm/rot.
  const base = { detRows: 16, beamColl: 10, pitch: 0.938, rotSpeed: 0.5 };
  return [
    { on: true,  vis: true, box: { top: 0.10, bot: 0.90, apL: 0.28, apR: 0.72, latL: 0.28, latR: 0.72 }, kv: 120, ma: 295, sliceThk: 5,    ...base, interval: 5,    tilt: 0, delay: 0 },
    { on: false, vis: true, box: { top: 0.14, bot: 0.50, apL: 0.36, apR: 0.64, latL: 0.36, latR: 0.64 }, kv: 120, ma: 295, sliceThk: 2.5,  ...base, interval: 2.5,  tilt: 0, delay: 0 },
    { on: false, vis: true, box: { top: 0.55, bot: 0.86, apL: 0.36, apR: 0.64, latL: 0.36, latR: 0.64 }, kv: 120, ma: 295, sliceThk: 1.25, ...base, interval: 1.25, tilt: 0, delay: 0 },
    { on: false, vis: true, box: { top: 0.30, bot: 0.70, apL: 0.40, apR: 0.60, latL: 0.40, latR: 0.60 }, kv: 120, ma: 295, sliceThk: 5,    ...base, interval: 5,    tilt: 0, delay: 0 },
  ];
}

function initScanBoxes() {
  buildGroupBoxes('wrapAP', 'ap');
  buildGroupBoxes('wrapLAT', 'lat');
  wireScanGroupTable();
}
// one DOM box per group per scout (shown/positioned per group in renderScanBoxes)
function buildGroupBoxes(wrapId, view) {
  const wrap = ctx.$(wrapId); if (!wrap) return;
  for (let gi = 0; gi < N_GROUPS; gi++) {
    const box = document.createElement('div');
    box.className = 'scanbox gc' + gi; box.dataset.group = gi; box.dataset.view = view;
    box.innerHTML = '<div class="slices"></div><div class="glbl"></div>' +
      '<div class="xh xh-h"></div><div class="xh xh-v"></div>' +
      '<div class="eh eh-t" data-edge="t"></div><div class="eh eh-b" data-edge="b"></div>' +
      '<div class="eh eh-l" data-edge="l"></div><div class="eh eh-r" data-edge="r"></div>';
    wrap.appendChild(box);
    wireScanBox(box, gi, view);
  }
}
// The boxes + table only show in the planning phase.
function showScanBoxes(on) { ctx.$('ctScouts')?.classList.toggle('planning', on); }
// Reset all groups to defaults + clear the committed table move.
function resetScanBox() {
  const c = ctx.S.ct;
  c.groups = defaultGroups(); c.activeGroup = 0;
  c.plan.targetX = c.plan.targetY = c.plan.committedX = c.plan.committedY = 0;
}
// Position + style every group box on both scouts, with per-slice dotted lines.
function renderScanBoxes() {
  const c = ctx.S.ct;
  document.querySelectorAll('#ctScouts .scanbox').forEach((el) => {
    const gi = +el.dataset.group, view = el.dataset.view, g = grp(gi);
    const shown = g.on && g.vis;
    el.classList.toggle('shown', shown);
    el.classList.toggle('active', gi === c.activeGroup);
    if (!shown) return;
    const L = view === 'ap' ? g.box.apL : g.box.latL, R = view === 'ap' ? g.box.apR : g.box.latR;
    el.style.left = (L * 100) + '%'; el.style.top = (g.box.top * 100) + '%';
    el.style.width = ((R - L) * 100) + '%'; el.style.height = ((g.box.bot - g.box.top) * 100) + '%';
    // per-slice dotted lines (spacing = interval), thickness in the label
    const sl = el.querySelector('.slices'), lenMM = groupScanLenMM(g);
    const period = lenMM > 0 ? (g.interval / lenMM) * 100 : 100;
    if (period >= 0.7 && g.interval > 0) {
      sl.style.backgroundImage = 'repeating-linear-gradient(to bottom, var(--gc) 0, var(--gc) 1px, transparent 1px, transparent ' + period.toFixed(3) + '%)';
      sl.style.opacity = '0.55';
    } else { sl.style.backgroundImage = 'none'; }
    el.querySelector('.glbl').textContent = 'G' + (gi + 1) + ' · ' + fmtNum(g.sliceThk) + ' mm';
  });
}

// Drag a group's box (move) or an edge handle (resize); selecting it makes the group
// active (drives the reposition plan). Per-group top/bot are AP↔LAT locked (cylinder);
// boxes stay axis-aligned rectangles.
function wireScanBox(box, gi, view) {
  box.addEventListener('pointerdown', (e) => {
    if (ctx.S.ct.phase !== 'planning' || !grp(gi).on || !grp(gi).vis) return;
    ctx.S.ct.activeGroup = gi;
    const rect = box.parentElement.getBoundingClientRect();
    const edge = e.target.classList.contains('eh') ? e.target.dataset.edge : null;
    const s = { x: e.clientX, y: e.clientY, box: { ...grp(gi).box } };
    try { box.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault(); e.stopPropagation();
    renderScanBoxes(); updatePlan();
    const onMove = (ev) => {
      applyBoxDrag(gi, view, edge, s.box, (ev.clientX - s.x) / rect.width, (ev.clientY - s.y) / rect.height);
      renderScanBoxes(); updatePlan();
    };
    const onUp = () => {
      try { box.releasePointerCapture(e.pointerId); } catch (_) {}
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerup', onUp); box.removeEventListener('pointercancel', onUp);
    };
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp); box.addEventListener('pointercancel', onUp);
  });
}
function applyBoxDrag(gi, view, edge, s0, du, dv) {
  const b = grp(gi).box, L = view === 'ap' ? 'apL' : 'latL', R = view === 'ap' ? 'apR' : 'latR';
  if (!edge) {
    const w = s0[R] - s0[L], nl = clampV(s0[L] + du, 0, 1 - w); b[L] = nl; b[R] = nl + w;
    const h = s0.bot - s0.top, nt = clampV(s0.top + dv, 0, 1 - h); b.top = nt; b.bot = nt + h;
  } else if (edge === 't') b.top = clampV(s0.top + dv, 0, s0.bot - BOX_MIN);
  else if (edge === 'b') b.bot = clampV(s0.bot + dv, s0.top + BOX_MIN, 1);
  else if (edge === 'l') b[L] = clampV(s0[L] + du, 0, s0[R] - BOX_MIN);
  else if (edge === 'r') b[R] = clampV(s0[R] + du, s0[L] + BOX_MIN, 1);
}

// Scans run sequentially, so the reposition before START is for the NEXT (first)
// scan = group 1. Moving a later group's box does NOT require a table move.
function updatePlan() {
  const c = ctx.S.ct, g = grp(0), len = c.scanLen;
  const set = (id, v) => { const el = ctx.$(id); if (el) el.textContent = v; };
  set('ctScanStartV', fmtTablePos(g.box.top * len) + ' mm');
  set('ctScanEndV', fmtTablePos(g.box.bot * len) + ' mm');
  c.plan.targetX = ((g.box.apL + g.box.apR) / 2 - 0.5) * scoutFov();   // mediolateral offset (mm)
  c.plan.targetY = ((g.box.latL + g.box.latR) / 2 - 0.5) * scoutFov(); // anteroposterior offset (mm)
  updatePlanReady();
  renderScanGroups();
}

// ---- scan-group table ---- (single click to edit / pick / toggle / delete)
function wireScanGroupTable() {
  const cont = ctx.$('ctScanGroups'); if (!cont) return;
  cont.addEventListener('click', (e) => {
    if (e.target.closest('.sg-add')) { addGroup(); return; }
    const del = e.target.closest('.sg-num.del');
    if (del) { const gi = +del.closest('tr').dataset.group; if (gi > 0) { grp(gi).on = false; if (ctx.S.ct.activeGroup === gi) ctx.S.ct.activeGroup = 0; renderScanBoxes(); updatePlan(); } return; }
    const eye = e.target.closest('.sg-eye');
    if (eye) { const gi = +eye.closest('tr').dataset.group; grp(gi).vis = !grp(gi).vis; renderScanBoxes(); renderScanGroups(); return; }
    const el = e.target.closest('[data-act]');
    if (el) { openFieldEditor(+el.closest('tr').dataset.group, el.dataset.act); return; }
    const row = e.target.closest('tr[data-group]');
    if (row) { ctx.S.ct.activeGroup = +row.dataset.group; renderScanBoxes(); updatePlan(); }
  });
}
function openFieldEditor(gi, act) {
  const g = grp(gi), len = ctx.S.ct.scanLen;
  ctx.S.ct.activeGroup = gi; renderScanBoxes();
  const done = () => { renderScanBoxes(); updatePlan(); };
  const type = (label, cur, apply) => openTypedPopup(label, cur, (v) => { apply(sanitizeNum(v, cur)); done(); });
  const station = (label, list, cur, fmt, apply) => openStationPopup(label, list, cur, fmt, (v) => { apply(v); done(); });
  if (act === 'start') type('Start location (mm inferior)', Math.round(g.box.top * len), (v) => { g.box.top = clampV(v / len, 0, g.box.bot - BOX_MIN); });
  else if (act === 'end') type('End location (mm inferior)', Math.round(g.box.bot * len), (v) => { g.box.bot = clampV(v / len, g.box.top + BOX_MIN, 1); });
  else if (act === 'interval') type('Slice interval (mm)', fmtNum(g.interval), (v) => { g.interval = clampV(v, 0.1, 50); });
  else if (act === 'tilt') type('Gantry tilt (degrees)', g.tilt, (v) => { g.tilt = clampV(Math.round(v), -30, 30); });
  else if (act === 'kv') type('Tube voltage (kV)', g.kv, (v) => { g.kv = clampV(Math.round(v), 70, 140); });
  else if (act === 'ma') type('Tube current (mA)', g.ma, (v) => { g.ma = clampV(Math.round(v), 10, 800); });
  else if (act === 'delay') type('Scan delay (seconds)', g.delay, (v) => { g.delay = clampV(Math.round(v), 0, 600); });
  else if (act === 'acq') openAcqPopup(gi);   // reference-style image-thickness dialog
  else if (act === 'rot') station('Rotation time (s / rot)', ROT_STATIONS, g.rotSpeed, (x) => x.toFixed(2) + ' s', (v) => { g.rotSpeed = v; });
  else { done(); }
}
function addGroup() {
  const gs = ctx.S.ct.groups;
  for (let i = 1; i < N_GROUPS; i++) if (!gs[i].on) { gs[i].on = true; ctx.S.ct.activeGroup = i; break; }
  renderScanBoxes(); updatePlan();
}
const EYE_OPEN = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="1.7" d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/></svg>';
const EYE_CLOSED = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M3 10c2.2 2.9 5.6 4.6 9 4.6S18.8 12.9 21 10"/><path stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M6 13.3l-1.6 2M12 15.1v2.4M18 13.3l1.6 2"/></svg>';
const TRASH = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="#fff" d="M9 3l-1 1H4v2h16V4h-4l-1-1H9zM6 8l1.2 12.2c.1.9.9 1.8 1.9 1.8h5.8c1 0 1.8-.9 1.9-1.8L18 8H6zm4 2h1v9h-1v-9zm3 0h1v9h-1v-9z"/></svg>';
const SG_HEADERS = ['Group', 'Show', 'Start Location', 'End Location', 'Total Images', 'Detector Config',
  'Helical Thickness', 'Beam Collimation', 'Pitch', 'Table Speed', 'Rotation Time', 'Slice Interval',
  'Gantry Tilt', 'Tube Voltage', 'Tube Current', 'Exposure Time', 'Scan Delay'];

function renderScanGroups() {
  const cont = ctx.$('ctScanGroups'); if (!cont) return;
  const c = ctx.S.ct;
  const cell = (cls, act, txt) => '<td><span class="' + cls + '"' + (act ? ' data-act="' + act + '"' : '') + '>' + txt + '</span></td>';
  let rows = '';
  for (let gi = 0; gi < N_GROUPS; gi++) {
    const g = grp(gi); if (!g.on) continue;
    const num = gi > 0
      ? '<span class="sg-num del" title="Delete scan group"><span class="lbl">' + (gi + 1) + '</span><span class="trash">' + TRASH + '</span></span>'
      : '<span class="sg-num">' + (gi + 1) + '</span>';
    rows += '<tr class="sg-row gc' + gi + (gi === c.activeGroup ? ' active' : '') + '" data-group="' + gi + '">'
      + '<td>' + num + '</td>'
      + '<td><span class="sg-eye' + (g.vis ? '' : ' off') + '" title="Toggle box on scout">' + (g.vis ? EYE_OPEN : EYE_CLOSED) + '</span></td>'
      + cell('sg-edit', 'start', fmtTablePos(g.box.top * c.scanLen))
      + cell('sg-edit', 'end', fmtTablePos(g.box.bot * c.scanLen))
      + cell('sg-calc', '', groupImages(g))
      + cell('sg-station', 'acq', detConfig(g))
      + cell('sg-station', 'acq', fmtNum(g.sliceThk) + ' mm')
      + cell('sg-station', 'acq', fmtNum(g.beamColl) + ' mm')
      + cell('sg-station', 'acq', fmtNum(g.pitch) + ':1')
      + cell('sg-station', 'acq', fmtNum(tableSpeedOf(g)) + ' mm/rot')
      + cell('sg-station', 'rot', g.rotSpeed.toFixed(2) + ' s')
      + cell('sg-edit', 'interval', fmtNum(g.interval) + ' mm')
      + cell('sg-edit', 'tilt', g.tilt + '°')
      + cell('sg-edit', 'kv', g.kv + ' kV')
      + cell('sg-edit', 'ma', g.ma + ' mA')
      + cell('sg-calc', '', groupExpTime(g).toFixed(1) + ' s')
      + cell('sg-edit', 'delay', g.delay + ' s')
      + '</tr>';
  }
  const anyOff = c.groups.some((g) => !g.on);
  cont.innerHTML = '<table class="sg-table"><thead><tr>' + SG_HEADERS.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>'
    + rows + '</tbody></table>' + (anyOff ? '<button class="sg-add">+ Add scan group</button>' : '');
}

// Modal field-edit popup: blurs the screen; must be confirmed (Enter) or cancelled
// (Esc) — clicking outside does nothing.
function openTypedPopup(label, val, onOk) {
  const pop = ctx.$('ctPop'), inner = ctx.$('ctPopInner'); if (!pop) return;
  inner.innerHTML = '<div class="plt">' + label + '</div><div class="pl">Enter a value:</div>'
    + '<input type="text" autocomplete="off" spellcheck="false">'
    + '<div class="phint"><b>[ENTER]</b> to confirm&nbsp;&nbsp;·&nbsp;&nbsp;<b>[ESC]</b> to cancel</div>';
  const inp = inner.querySelector('input');
  inp.placeholder = String(val);
  const close = () => { pop.classList.remove('show'); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Enter') { onOk(inp.value === '' ? val : inp.value); close(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  pop.classList.add('show');
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => inp.focus(), 0);
}
// Modal station picker: pick a preset (or Esc to cancel). Outside click does nothing.
function openStationPopup(label, list, cur, fmt, onSel) {
  const pop = ctx.$('ctPop'), inner = ctx.$('ctPopInner'); if (!pop) return;
  inner.innerHTML = '<div class="plt">' + label + '</div><div class="pl">Select a station:</div>'
    + '<div class="ctpop-stations">' + list.map((s) => '<button data-v="' + s + '"' + (s === cur ? ' class="on"' : '') + '>' + fmt(s) + '</button>').join('') + '</div>'
    + '<div class="phint"><b>[ESC]</b> to cancel</div>';
  const close = () => { pop.classList.remove('show'); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  pop.classList.add('show');
  inner.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { onSel(parseFloat(b.dataset.v)); close(); }));
  document.addEventListener('keydown', onKey, true);
}
// Reference-style acquisition ("Select the desired Image Thickness") dialog. Edits a
// working copy of the group's acquisition geometry and applies it on OK. Relationships:
//   beam collimation = detector rows × detector element   (element = min recon thickness)
//   table speed (mm/rot) = pitch × beam collimation  ⇒  pitch = table speed / collimation
// Selecting a Speed keeps the current pitch and changes the collimation when that speed
// maps to another valid collimation (shown darker blue); otherwise it keeps the
// collimation and changes the pitch (lighter). Helical (reconstructed) thickness is
// independent but can't be thinner than the detector element.
function openAcqPopup(gi) {
  const pop = ctx.$('ctPop'), inner = ctx.$('ctPopInner'); if (!pop) return;
  const g = grp(gi);
  const w = { detRows: g.detRows, beamColl: g.beamColl, pitch: g.pitch, sliceThk: g.sliceThk };
  const speedGrid = () => {
    const colls = validColls(w.detRows), set = new Set();
    PITCH_ACQ.forEach(p => colls.forEach(c => set.add(+(p * c).toFixed(2))));
    return [...set].sort((a, b) => a - b);
  };
  const classifySpeed = (s) => {
    const cur = +(w.pitch * w.beamColl).toFixed(2);
    if (Math.abs(s - cur) < 0.01) return 'on';
    if (validColls(w.detRows).some(c => Math.abs(c - s / w.pitch) < 0.01)) return 'alt';  // changes collimation only
    return '';                                                                            // changes pitch
  };
  const close = () => { pop.classList.remove('show'); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  function render() {
    const el = w.beamColl / w.detRows;
    const btns = (list, val, fmt, k, disBelowEl) => list.map(v =>
      '<button data-k="' + k + '" data-v="' + v + '" class="' +
      (Math.abs(v - val) < 1e-6 ? 'on' : (disBelowEl && v < el - 1e-6 ? 'dis' : '')) + '">' + fmt(v) + '</button>').join('');
    inner.innerHTML =
      '<div class="acq-pop"><div class="acq-title">Select the desired Image Thickness</div><div class="acq-grid"><div class="acq-left">'
      + '<div class="acq-sec"><div class="acq-lab">Detector Rows</div><div class="acq-btns">' + btns(DET_ROW_OPTS, w.detRows, x => x, 'rows', false) + '</div></div>'
      + '<div class="acq-sec"><div class="acq-lab">Helical Thickness (mm)</div><div class="acq-btns">' + btns(ACQ_THK, w.sliceThk, fmtNum, 'thk', true) + '</div></div>'
      + '<div class="acq-sec"><div class="acq-lab">Pitch</div><div class="acq-btns">' + btns(PITCH_ACQ, w.pitch, x => fmtNum(x) + ':1', 'pitch', false) + '</div></div>'
      + '<div class="acq-sec"><div class="acq-lab">Speed (mm/rot)</div><div class="acq-btns">' + speedGrid().map(s => '<button data-k="speed" data-v="' + s + '" class="' + classifySpeed(s) + '">' + s.toFixed(2) + '</button>').join('') + '</div></div>'
      + '</div><div class="acq-right">'
      + '<div class="acq-info"><div class="acq-ilab">Detector Configuration:</div><div class="acq-ival">' + w.detRows + ' × ' + fmtNum(el) + '</div></div>'
      + '<div class="acq-info"><div class="acq-ilab">Beam Collimation:</div><div class="acq-ival">' + fmtNum(w.beamColl) + ' mm</div></div>'
      + '<div class="acq-info"><div class="acq-ilab">Table Speed:</div><div class="acq-ival">' + fmtNum(w.pitch * w.beamColl) + ' mm/rot</div></div>'
      + '</div></div><div class="acq-actions"><button class="acq-ok">OK</button><button class="acq-cancel">Cancel</button></div></div>';
    inner.querySelectorAll('.acq-btns button').forEach(b => b.addEventListener('click', () => {
      if (b.classList.contains('dis')) return;
      const k = b.dataset.k, v = parseFloat(b.dataset.v);
      if (k === 'rows') { w.detRows = v; if (!validColls(v).some(c => Math.abs(c - w.beamColl) < 0.01)) w.beamColl = nearestIn(validColls(v), w.beamColl); }
      else if (k === 'thk') w.sliceThk = v;
      else if (k === 'pitch') w.pitch = v;
      else if (k === 'speed') {
        const collForPitch = v / w.pitch;
        if (validColls(w.detRows).some(c => Math.abs(c - collForPitch) < 0.01)) w.beamColl = +collForPitch.toFixed(3);   // keep pitch
        else w.pitch = nearestIn(PITCH_ACQ, v / w.beamColl);                                                             // keep collimation
      }
      const el2 = w.beamColl / w.detRows;                       // recon thickness can't be thinner than the element
      if (w.sliceThk < el2 - 1e-6) { const ge = ACQ_THK.filter(t => t >= el2 - 1e-6); w.sliceThk = ge.length ? ge[0] : el2; }
      render();
    }));
    inner.querySelector('.acq-ok').addEventListener('click', () => {
      g.detRows = w.detRows; g.beamColl = w.beamColl; g.pitch = w.pitch; g.sliceThk = w.sliceThk;
      close(); renderScanBoxes(); updatePlan();
    });
    inner.querySelector('.acq-cancel').addEventListener('click', close);
  }
  pop.classList.add('show');
  document.addEventListener('keydown', onKey, true);
  render();
}

// Flash TABLE (orange) while the couch still needs to move; else flash START (green).
// While a move is pending the DR monitor mirrors the axis' PoV — AP-PoV for the
// mediolateral move, Lat-PoV for the anteroposterior (height) move.
function updatePlanReady() {
  const c = ctx.S.ct;
  const needX = Math.abs(c.plan.targetX - c.plan.committedX) > MOVE_THRESH;
  const needY = Math.abs(c.plan.targetY - c.plan.committedY) > MOVE_THRESH;
  const needMove = needX || needY;
  ctx.$('ctStart')?.classList.toggle('flash', !needMove);
  ctx.$('ctTable')?.classList.toggle('flash', needMove);
  c.moveBlit = needMove ? (needX ? 'ap' : 'lat') : null;   // which PoV to mirror into the monitor
  const noexp = ctx.$('noexp');
  if (needMove && noexp) noexp.style.display = 'none';         // the PoV blit fills the monitor
  // when no move is pending, LEAVE the last PoV frame frozen in the monitor (don't
  // revert to NO IMAGE) — it persists until abort/reset/mode-switch clears it.
  showTableReminder(needMove, tableV > 0.05);                  // "moving" only while the motor is actually turning
}
function showTableReminder(on, moving) {
  const el = ctx.$('ctReminder'); if (!el) return;
  el.style.display = on ? 'flex' : 'none';
  el.classList.toggle('moving', !!(on && moving));
  if (on) el.textContent = moving
    ? '⚠  TABLE IS MOVING  ⚠'
    : 'TABLE REPOSITION REQUIRED — press and HOLD the orange TABLE button to move the couch into position before scanning.';
}

// ---- TABLE hold-to-move ----
// One axis per press: mediolateral first, then (after RELEASING and pressing again)
// table height. Each move has a 0.5 s accel/decel ramp (motor momentum) and a motor
// sound, pitch-shifted per axis. Releasing mid-move decelerates to a pause; the next
// axis never starts automatically while held.
const RAMP = 1.0;                       // s to reach full speed (motor momentum)
const ACCEL = TABLE_SPEED / RAMP;       // mm/s^2
let tableHeld = false, tableRAF = null, tableLastT = 0;
let tableV = 0, moveAxis = null, awaitRelease = false;

function nextMoveAxis() {
  const c = ctx.S.ct;
  if (Math.abs(c.plan.targetX - c.plan.committedX) > MOVE_THRESH) return 'x';   // mediolateral first
  if (Math.abs(c.plan.targetY - c.plan.committedY) > MOVE_THRESH) return 'y';   // then height
  return null;
}
function startTableMove() {
  const c = ctx.S.ct;
  if (c.phase !== 'planning' || awaitRelease) return;   // must release before the next segment
  tableHeld = true;
  if (!moveAxis) { moveAxis = nextMoveAxis(); if (!moveAxis) { tableHeld = false; return; } tableV = 0; }
  Sound.resume();
  Sound.startTableSound(moveAxis === 'x' ? 1.0 : 0.72);   // pitch differs per motor (x vs y)
  if (!tableRAF) { tableLastT = performance.now(); tableRAF = requestAnimationFrame(tableStep); }
  updatePlanReady();
}
function stopTableMove() {
  tableHeld = false;
  if (awaitRelease) { awaitRelease = false; moveAxis = null; }   // segment done -> ready for the next
  // if mid-move, the loop keeps decelerating and stops the sound when it halts
  if (ctx.S.ct.phase === 'planning') updatePlanReady();
}
function tableStep() {
  const now = performance.now(), dt = Math.min(0.05, (now - tableLastT) / 1000); tableLastT = now;
  advanceTable(dt);
  if (tableV > 0.05 || (tableHeld && moveAxis && !awaitRelease)) {
    tableRAF = requestAnimationFrame(tableStep);
  } else { tableRAF = null; Sound.stopTableSound(); }
}
function advanceTable(dt) {
  const c = ctx.S.ct;
  if (!moveAxis) { tableV = 0; return; }
  const key = moveAxis === 'x' ? 'committedX' : 'committedY';
  const target = moveAxis === 'x' ? c.plan.targetX : c.plan.targetY;
  const remaining = target - c.plan[key], dist = Math.abs(remaining);
  if (dist <= MOVE_THRESH) {                          // segment complete
    c.plan[key] = target; tableV = 0; awaitRelease = true;
    Sound.stopTableSound();
    applyTableCommit(); updatePlanReady();
    setHint('Axis in position — release, then hold TABLE again for the next axis.');
    return;
  }
  const decelDist = (tableV * tableV) / (2 * ACCEL);  // distance needed to brake from current speed
  if (tableHeld && !awaitRelease && dist > decelDist) tableV = Math.min(TABLE_SPEED, tableV + ACCEL * dt);   // ramp up / cruise
  else tableV = Math.max(0, tableV - ACCEL * dt);                                                            // ramp down (near target or released)
  c.plan[key] += Math.sign(remaining) * Math.min(tableV * dt, dist);
  setHint(moveAxis === 'x' ? 'Table moving — mediolateral…' : 'Table moving — height (anteroposterior)…');
  applyTableCommit(); updatePlanReady();
}
// Apply the committed lateral/height offset to the 3D couch + patient.
function applyTableCommit() {
  const c = ctx.S.ct;
  c.patient.x = -c.plan.committedX / MM_PER_UNIT;     // lateral: move patient opposite the box offset to centre it
  c.tableY = -c.plan.committedY;                      // height: table compensates the AP offset
  ctx.syncScene();
  updateCTReadouts();
}

// ==================== Phase 5/6: scan execution + reconstruction + storage ====================
// Pressing START (solid, plan confirmed) executes the enabled scan groups in order.
// Each group: auto table reposition -> scan delay -> breathe-in / helical exposure
// (gantry spin + couch travel) / breathe-normal -> filtered-back-projection of the
// transverse slices -> store the reconstructed volume. The slices are then shown in
// the cross-sectional viewer; old scans auto-delete past a cap so memory stays bounded.

// ---- in-plane detector designs ----
// quick: the original preview detector — 128 channels spanning the display FOV
//   (channel pitch scales with DFOV), 128 views, 128² grid. Fast in the browser.
// realistic: a fixed-geometry MDCT detector — 0.625 mm channel pitch at the
//   isocentre across a 500 mm scan FOV (800 channels), 720 views/rotation, 512²
//   recon matrix. The display FOV only selects the back-projected region, like a
//   real scanner (no projection truncation). Heavy — meant for the Python GPU
//   engine; the browser fallback works but crawls.
const DET_MODES = {
  quick:     { nDet: 128, nAngles: 128, gridN: 128, fixedPitch: false },
  // photonBase: detected photons per channel per view at the reference technique —
  // clinical scale (~10^6-10^7), so the 512² image lands at a clinical ~10-15 HU noise;
  // the quick preview keeps the old (much lower) base tuned for its coarse grid.
  realistic: { nDet: 800, nAngles: 720, gridN: 512, fixedPitch: true, chanMM: 0.625, sfovMM: 500, photonBase: 8e6 },
};
const detMode = () => DET_MODES[ctx && ctx.S.ct.detMode] || DET_MODES.quick;
const MAX_SLICES = 1024;          // safety cap only (the slice count follows the planned image count)
const PHOTON_BASE = 1.1e5;        // reference detected photons per ray (mA/slice/rot noise model)

// Reconstruction display field of view for a group = the scan box diameter (the box
// represents a cylinder). The mediolateral width on the AP scout is the cylinder
// diameter — the direction in which neighbouring fingers are separated — so a box
// drawn around a single finger reconstructs a small FOV that excludes the others.
function groupDFOV(g) { return Math.max(2, (g.box.apR - g.box.apL) * scoutFov()); }
// Per-reconstruction geometry: display-FOV radius R (the back-projected region),
// channel spacing ds, ray half-length rayR (how far the integration must reach —
// the full scan FOV for the fixed-pitch detector), and the detector mode m.
function reconGeo(fovMM, cx, cy) {
  const m = detMode(), R = (fovMM / MM_PER_UNIT) / 2;
  if (m.fixedPitch) return { fovMM, R, rayR: (m.sfovMM / MM_PER_UNIT) / 2, ds: m.chanMM / MM_PER_UNIT, cx, cy, m };
  return { fovMM, R, rayR: R, ds: (R * 2) / m.nDet, cx, cy, m };
}

let scanToken = 0;                // invalidates an in-flight scan on abort / mode switch
function cancelScan() { scanToken++; }
let spinRAF = null;               // gantry-spin animation handle

// ---- scan sequence ----
async function runScan() {
  const S = ctx.S, tok = ++scanToken, alive = () => tok === scanToken;
  const groups = S.ct.groups.map((g, i) => ({ g, i })).filter(x => x.g.on);
  if (!groups.length) { setHint('No scan groups enabled.'); return; }
  setBusy(true);
  setPhase('scanning');
  setConsoleEnabled(false);
  const abortBtn = ctx.$('ctAbort'); if (abortBtn) abortBtn.disabled = false;   // ABORT stays live during the scan
  ctx.setContent('3d'); ctx.setCTPov('orbit');   // watch the gantry rotate while it scans
  Sound.resume();
  let lastEntry = null;
  try {
    for (const { g, i } of groups) {
      if (!alive()) return;
      await repositionForGroup(i, alive);                  // 1) move the couch for this group
      if (!alive()) return;
      if (g.delay > 0) { await scanDelay(g.delay, alive); if (!alive()) return; }   // 2) scan delay
      lastEntry = await scanGroupExposure(g, i, alive);    // 3) expose + reconstruct + store
      if (!alive()) return;
    }
  } catch (err) {
    console.error('scan failed', err); setHint('Scan failed: ' + err.message);
  } finally {
    stopGantrySpin(); Sound.stopBuzz(); Sound.stopTableSound();
  }
  if (!alive()) return;
  setBusy(false);
  setPhase('done');
  resetToIsocentre();
  if (lastEntry) { S.ct.viewer.scanId = lastEntry.id; S.ct.viewer.slice = 0; ctx.setContent('slices'); }
  setHint('Scan complete — ' + S.ct.storage.length + ' scan(s) stored. Scroll the slices; ABORT to plan a new scan.');
}

// Auto-drive the couch to centre THIS group's box on the isocentre (mediolateral, then height).
async function repositionForGroup(i, alive) {
  const c = ctx.S.ct, g = grp(i);
  c.plan.targetX = ((g.box.apL + g.box.apR) / 2 - 0.5) * scoutFov();    // mediolateral offset (mm)
  c.plan.targetY = ((g.box.latL + g.box.latR) / 2 - 0.5) * scoutFov();  // anteroposterior offset (mm)
  await animateCommit('committedX', c.plan.targetX, 1.0, alive);
  if (!alive()) return;
  await animateCommit('committedY', c.plan.targetY, 0.72, alive);
}

// Ramp one couch axis to its target (motor momentum + sound), applying the offset live.
function animateCommit(key, target, pitch, alive) {
  return new Promise(res => {
    const c = ctx.S.ct;
    if (Math.abs(c.plan[key] - target) <= MOVE_THRESH) { c.plan[key] = target; applyTableCommit(); res(); return; }
    Sound.startTableSound(pitch);
    let v = 0, last = performance.now(), done = false;
    const fin = () => { if (done) return; done = true; Sound.stopTableSound(); res(); };
    (function step() {
      if (done) return;
      if (!alive()) { fin(); return; }
      const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
      const remaining = target - c.plan[key], dist = Math.abs(remaining);
      if (dist <= MOVE_THRESH) { c.plan[key] = target; applyTableCommit(); fin(); return; }
      const decelDist = (v * v) / (2 * ACCEL);
      if (dist > decelDist) v = Math.min(TABLE_SPEED, v + ACCEL * dt); else v = Math.max(0, v - ACCEL * dt);
      c.plan[key] += Math.sign(remaining) * Math.min(v * dt, dist);
      applyTableCommit();
      requestAnimationFrame(step);
    })();
    setTimeout(() => { if (!done) { c.plan[key] = target; applyTableCommit(); fin(); } }, 9000);
  });
}

async function scanDelay(sec, alive) {
  for (let t = Math.round(sec); t > 0; t--) {
    if (!alive()) return;
    setHint('Scan delay — starting in ' + t + ' s…');
    await sleep(1000);
  }
}

// One group's exposure: breathe-in, then the helical acquisition — the transverse
// slices are reconstructed one by one and shown coming up live in the DR image viewer
// as the couch advances to each slice position (gantry spinning), then store +
// breathe-normal. The reconstruction itself paces the acquisition.
async function scanGroupExposure(g, i, alive) {
  const S = ctx.S;
  resetToIsocentre();
  setHint('G' + (i + 1) + ' · breathe in and hold…');
  Sound.play('breathIn');
  await sleep((Sound.duration('breathIn') || 2) * 1000); if (!alive()) return null;
  await sleep(700); if (!alive()) return null;
  setHint('G' + (i + 1) + ' · acquiring…');
  startGantrySpin(g.rotSpeed);
  Sound.startBuzz();
  const recon = await reconstructSlices(g, alive,
    (f) => setHint('G' + (i + 1) + ' · acquiring… ' + Math.round(f * 100) + '%'),
    (si, nz, d, img, meta) => { moveCouchTo(d); drawScanPreview(img, meta, si, nz); });
  Sound.stopBuzz(); stopGantrySpin();
  if (!alive() || !recon) return null;
  resetToIsocentre();
  setHint('G' + (i + 1) + ' · breathe normally.');
  Sound.play('breathNormal');
  const entry = storeScan(g, i, recon);
  await sleep(Math.min(1800, (Sound.duration('breathNormal') || 1.6) * 1000));
  return entry;
}

// Step the couch (bed + patient) to a table position (mm inferior) as its slice is acquired.
function moveCouchTo(d) {
  const three = ctx.three, S = ctx.S, isoZ = S.ct.isoZ, dz = -(d / MM_PER_UNIT);
  S.ct.tablePos = d;
  three.handGroup.position.z = isoZ + dz; couch.position.z = dz;
  updateCTReadouts();
}

// Paint the just-reconstructed transverse slice into the DR image viewer (#film), so
// the operator watches the images build during the scan (like the scout stitch). Uses
// the axial viewer's window; the render loop leaves #film alone while scanning.
function drawScanPreview(mu, meta, si, count) {
  const f = ctx.$('film'); if (!f) return;
  const N = meta.gridN, muW = meta.muWater, v = ctx.S.ct.viewer, c = N / 2, R2 = c * c;
  if (f.width !== N || f.height !== N) { f.width = N; f.height = N; }
  const g = f.getContext('2d'), im = g.createImageData(N, N), d8 = im.data;
  for (let iy = 0; iy < N; iy++) { const sy = N - 1 - iy;
    for (let ix = 0; ix < N; ix++) {
      const o = (iy * N + ix) * 4, dx = ix - c + 0.5, dy = sy - c + 0.5;
      let val; if (dx * dx + dy * dy > R2) val = 0; else { const hu = 1000 * (mu[sy * N + ix] - muW) / muW; val = Math.round(255 * huToGray(hu, v.wl, v.ww)); }
      d8[o] = d8[o + 1] = d8[o + 2] = val; d8[o + 3] = 255;
    } }
  g.putImageData(im, 0, 0);
  const noexp = ctx.$('noexp'); if (noexp) noexp.style.display = 'none';
  const prog = ctx.$('prog'); if (prog) prog.style.width = Math.round((si + 1) / count * 100) + '%';
}

function startGantrySpin(rotSpeed) {
  if (!gantrySpin) return;
  gantrySpin.visible = true;
  const spd = (2 * Math.PI) / Math.max(0.2, rotSpeed);   // rad/s (visual)
  let last = performance.now();
  const step = () => {
    const now = performance.now(), dt = (now - last) / 1000; last = now;
    gantrySpin.rotation.z -= spd * dt;
    spinRAF = requestAnimationFrame(step);
  };
  spinRAF = requestAnimationFrame(step);
}
function stopGantrySpin() {
  if (spinRAF) { cancelAnimationFrame(spinRAF); spinRAF = null; }
  if (gantrySpin) gantrySpin.visible = false;
}

// ---- filtered back-projection ----
// For each transverse slice we compute a parallel-beam sinogram of line integrals
// ∫μ ds (bone + soft + marrow at the beam's effective energy, with quantum noise
// scaled by mA/slice/rotation), Ram-Lak filter each view, and back-project into a
// circular FOV grid. The result approximates μ(x,y); stored as-is and converted to
// Hounsfield units at display time.

// Box–Muller normal deviate (fine for a browser sim; not used in workflow scripts).
function gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Discrete reconstruction kernel, indexed n = -(N-1)..(N-1) at channel spacing ds.
// Ram-Lak (pure ramp) for the quick preview detector; Shepp-Logan (apodized ramp,
// the clinical "standard" algorithm) for the realistic detector, where a pure ramp
// at 0.625 mm pitch would amplify quantum noise into salt-and-pepper.
function buildKernel(ds, N, shepp) {
  const h = new Float32Array(2 * N - 1);
  for (let n = -(N - 1); n <= N - 1; n++) {
    let v;
    if (shepp) v = -2 / (Math.PI * Math.PI * ds * ds * (4 * n * n - 1));
    else if (n === 0) v = 1 / (4 * ds * ds);
    else if (n % 2 === 0) v = 0;
    else v = -1 / (Math.PI * Math.PI * n * n * ds * ds);
    h[n + (N - 1)] = v;
  }
  return h;
}

// Forward-project one slice at world plane z = z0 → sinogram [angle][detector].
function projectSlice(phantom, z0, mu, photons0, geo) {
  const cx = geo.cx, cy = geo.cy, RR = geo.rayR, ds = geo.ds, nDet = geo.m.nDet, nAng = geo.m.nAngles;
  const halfDet = (nDet - 1) / 2;
  const sino = new Float32Array(nAng * nDet);
  for (let a = 0; a < nAng; a++) {
    const th = a * Math.PI / nAng, ct = Math.cos(th), st = Math.sin(th);
    const base = a * nDet;
    for (let k = 0; k < nDet; k++) {
      const r = (k - halfDet) * ds;
      // ray: origin at t = -rayR along the integration axis e_t = (-sin, cos); offset r along e_r = (cos, sin)
      const o = [cx + r * ct + RR * st, cy + r * st - RR * ct, z0];
      const d = [-st, ct, 0];
      let p;
      if (mu.voxel) { const L = phantom.trace(o, d, 2 * RR), arr = mu.arr; p = 0; for (let m = 1; m < arr.length; m++) { const lm = L[m]; if (lm) p += arr[m] * lm; } }
      else { const { bone, soft, marrow } = phantom.trace(o, d, 2 * RR); p = mu.soft * soft + mu.bone * bone + mu.marrow * marrow; }
      if (photons0 > 0) {                       // quantum noise from finite detected photons
        const Nd = Math.max(1, photons0 * Math.exp(-p));
        p += gaussian() / Math.sqrt(Nd);
        if (p < 0) p = 0;
      }
      sino[base + k] = p;
    }
  }
  return sino;
}

// Convolve each projection view with the ramp filter.
function filterSino(sino, h, ds, m) {
  const N = m.nDet, out = new Float32Array(m.nAngles * N);
  for (let a = 0; a < m.nAngles; a++) {
    const base = a * N;
    for (let k = 0; k < N; k++) {
      let acc = 0;
      for (let kp = 0; kp < N; kp++) acc += sino[base + kp] * h[(k - kp) + (N - 1)];
      out[base + k] = acc * ds;
    }
  }
  return out;
}

// Back-project the filtered sinogram into the reconstruction grid (μ map, cm^-1).
function backproject(q, geo) {
  const N = geo.m.gridN, R = geo.R, ds = geo.ds, nDet = geo.m.nDet, nAng = geo.m.nAngles;
  const halfDet = (nDet - 1) / 2;
  const img = new Float32Array(N * N);
  const px2world = (i) => (-R + (i + 0.5) * (2 * R / N));   // pixel centre → world offset from FOV centre
  const R2 = R * R;
  for (let a = 0; a < nAng; a++) {
    const th = a * Math.PI / nAng, ct = Math.cos(th), st = Math.sin(th), base = a * nDet;
    for (let iy = 0; iy < N; iy++) {
      const wy = px2world(iy), rowo = iy * N;
      for (let ix = 0; ix < N; ix++) {
        const wx = px2world(ix);
        if (wx * wx + wy * wy > R2) continue;
        const kf = (wx * ct + wy * st) / ds + halfDet;
        const k0 = Math.floor(kf);
        if (k0 < 0 || k0 >= nDet - 1) continue;
        const f = kf - k0;
        img[rowo + ix] += q[base + k0] * (1 - f) + q[base + k0 + 1] * f;
      }
    }
  }
  const scale = Math.PI / nAng;
  for (let i = 0; i < img.length; i++) img[i] *= scale;
  return img;
}

async function reconstructSlices(g, alive, onProgress, onSlice) {
  const spec = Spectrum.make(g.kv), effE = spec.meanE;
  const phantom = ctx.buildPhantom();            // built at the committed table position (patient.z = isoZ)
  const voxel = !!phantom.voxel;                 // chest (voxel/BodyMaterials) vs hand (analytic)
  const mu = voxel ? { voxel: true, arr: muAtEnergy(effE) }
                   : { soft: Materials.mu('soft', effE), bone: Materials.mu('bone', effE), marrow: Materials.mu('marrow', effE) };
  const muW = voxel ? BodyMaterials.muWater(effE) : mu.soft;   // HU reference (water for voxel, soft for hand)
  const fovMM = groupDFOV(g);                     // DFOV = scan box diameter (box centre reposed to isocentre)
  const geo = reconGeo(fovMM, 0, ISO_Y);
  const startMM = g.box.top * ctx.S.ct.scanLen, endMM = g.box.bot * ctx.S.ct.scanLen, span = endMM - startMM;
  const count = Math.max(1, Math.min(MAX_SLICES, groupImages(g)));   // one slice per planned image
  const positions = [];
  for (let i = 0; i < count; i++) positions.push(count > 1 ? startMM + span * i / (count - 1) : startMM + span / 2);
  // Detected photons per sinogram sample. The quick detector is the noise reference;
  // more views split the same tube output into smaller buckets (total output per
  // rotation is set by the technique, not the view count). The realistic detector's
  // finer channels pair with its apodized (Shepp-Logan) kernel — like a clinical
  // "standard" algorithm — so its noise stays comparable at the same technique.
  const photons0 = (geo.m.photonBase || PHOTON_BASE) * (g.ma / 300) * (g.rotSpeed / 0.5) * (g.sliceThk / 5)
    * (DET_MODES.quick.nAngles / geo.m.nAngles);
  // Reconstruct the full transverse stack into one contiguous volume so it can be
  // resampled in any plane (axial / coronal / sagittal) for multiplanar recons. Each
  // slice is emitted via onSlice as it completes so the scan shows the images coming
  // up live (the couch advances to that slice's position as it appears).
  const N = geo.m.gridN, nz = positions.length, vol = new Float32Array(nz * N * N);
  const meta = { gridN: N, fovMM, muWater: muW };
  // ---- Python GPU engine (voxel subjects): reconstruct in slice batches ----
  let done = false;
  if (voxel && ctx.S.ct.backend === 'python' && ctx.S.computeInfo && ctx.compute) {
    try {
      const center = [(phantom.min[0] + phantom.max[0]) / 2, (phantom.min[1] + phantom.max[1]) / 2,
                      (phantom.min[2] + phantom.max[2]) / 2];
      const base = { model: ctx.S.subject, flips: Array.from(phantom.flip, Boolean), center,
                     cx: geo.cx, cy: geo.cy, nDet: geo.m.nDet, nAngles: geo.m.nAngles, gridN: N,
                     ds: geo.ds, rayR: geo.rayR, dfovR: geo.R,
                     kernel: geo.m.fixedPitch ? 'shepp' : 'ramlak',
                     muArr: Array.from(mu.arr), photons0 };
      const BATCH = 4;
      for (let s0 = 0; s0 < nz; s0 += BATCH) {
        if (!alive()) return null;
        const zs = positions.slice(s0, s0 + BATCH).map(d => d / MM_PER_UNIT);
        const batch = await ctx.compute.ctSlices({ ...base, z0List: zs });
        for (let b = 0; b < zs.length; b++) {
          const si = s0 + b;
          vol.set(batch.subarray(b * N * N, (b + 1) * N * N), si * N * N);
          if (onSlice) onSlice(si, nz, positions[si], vol.subarray(si * N * N, (si + 1) * N * N), meta);
          if (onProgress) onProgress((si + 1) / nz);
          await sleep(0);
        }
      }
      done = true;
    } catch (err) {
      console.warn('GPU backend reconstruction failed — falling back to the browser engine', err);
      setHint('Python backend unavailable — reconstructing in the browser…');
    }
  }
  if (!done) {
    const h = buildKernel(geo.ds, geo.m.nDet, geo.m.fixedPitch);
    for (let si = 0; si < nz; si++) {
      if (!alive()) return null;
      const zw = positions[si] / MM_PER_UNIT;    // world plane for this slice (see scoutProjection geometry)
      const sino = projectSlice(phantom, zw, mu, photons0, geo);
      const q = filterSino(sino, h, geo.ds, geo.m);
      const img = backproject(q, geo);
      vol.set(img, si * N * N);
      if (onSlice) onSlice(si, nz, positions[si], img, meta);
      if (onProgress) onProgress((si + 1) / nz);
      await sleep(0);                            // yield so the couch + preview repaint between slices
    }
  }
  const slices = positions.map((d, i) => ({ d, mu: vol.subarray(i * N * N, (i + 1) * N * N) }));
  const dz = nz > 1 ? (positions[nz - 1] - positions[0]) / (nz - 1) : Math.max(g.interval, 0.1);
  return { slices, vol, nz, gridN: N, fovMM, z0: positions[0], dz, centerY: ISO_Y, muWater: muW, effE };
}

// ---- image storage ----
function tstamp() { try { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (_) { return ''; } }

function storeScan(g, i, recon) {
  const S = ctx.S, id = S.ct.nextScanId++;
  const el = acqThkOf(g);                          // detector element = minimum recon thickness
  const entry = {
    id, label: 'Scan ' + id + ' · G' + (i + 1), ts: tstamp(),
    params: { kv: g.kv, ma: g.ma, sliceThk: g.sliceThk, pitch: g.pitch, interval: g.interval, rotSpeed: g.rotSpeed, acqThk: el, detRows: g.detRows, beamColl: g.beamColl },
    gridN: recon.gridN, fovMM: recon.fovMM, muWater: recon.muWater, effE: recon.effE, slices: recon.slices,
    // full volume + geometry for multiplanar resampling
    vol: recon.vol, nz: recon.nz, z0: recon.z0, dz: recon.dz, centerY: recon.centerY,
    // planned reconstructions (Phase 3/4). One default transverse recon at the box DFOV.
    nextReconId: 2,
    recons: [{ id: 1, name: 'Axial', plane: 'axial', dfov: recon.fovMM, offRL: 0, offAP: 0,
               thk: Math.max(g.sliceThk, el), interval: g.interval, algo: 'standard', mar: false, minThk: el }],
  };
  S.ct.storage.push(entry);
  enforceStorageLimit();
  renderStorage();
  return entry;
}
// Drop the oldest scans once the count exceeds the cap, so stored slice data can't
// grow without bound. Only active when auto-delete is enabled.
function enforceStorageLimit() {
  const S = ctx.S;
  if (!S.ct.autoDelete) return;
  while (S.ct.storage.length > S.ct.storeCap) {
    const dropped = S.ct.storage.shift();
    if (S.ct.viewer.scanId === dropped.id) S.ct.viewer.scanId = null;
  }
}

function renderStorage() {
  const el = ctx.$('ctStorageList'); if (!el) return;
  const S = ctx.S;
  const cap = ctx.$('ctCapV'); if (cap) cap.textContent = S.ct.storeCap;
  const chk = ctx.$('ctAutoDel'); if (chk) chk.checked = S.ct.autoDelete;
  if (!S.ct.storage.length) { el.innerHTML = '<div class="ctstore-empty">No scans stored yet.</div>'; return; }
  el.innerHTML = S.ct.storage.map(s => {
    const active = s.id === S.ct.viewer.scanId ? ' active' : '';
    return '<div class="ctstore-row' + active + '" data-id="' + s.id + '">'
      + '<span class="cs-open" data-id="' + s.id + '"><b>' + s.label + '</b><small>' + s.ts + ' · ' + s.slices.length + ' slices · ' + s.params.kv + ' kV ' + s.params.ma + ' mA</small></span>'
      + '<button class="cs-del" data-id="' + s.id + '" title="Delete this scan">✕</button></div>';
  }).join('');
}

// ---- cross-sectional viewer ----
function huToGray(hu, wl, ww) { let t = (hu - (wl - ww / 2)) / ww; return t < 0 ? 0 : t > 1 ? 1 : t; }

// Paint a slice into the viewer canvas: HU-windowed grey, top = +y (dorsal/anterior),
// circular FOV mask (outside the reconstruction circle is black).
function drawSliceToCanvas(cv, scan, sl, wl, ww) {
  const N = scan.gridN, muW = scan.muWater;
  if (cv.width !== N || cv.height !== N) { cv.width = N; cv.height = N; }
  const g = cv.getContext('2d'), im = g.createImageData(N, N), d = im.data;
  const c = N / 2, R2 = c * c;
  for (let iy = 0; iy < N; iy++) {
    const srcY = N - 1 - iy;                     // flip so +world-y is at the top of the image
    for (let ix = 0; ix < N; ix++) {
      const o = (iy * N + ix) * 4;
      const dx = ix - c + 0.5, dy = srcY - c + 0.5;
      let val;
      if (dx * dx + dy * dy > R2) val = 0;
      else { const mu = sl.mu[srcY * N + ix]; const hu = 1000 * (mu - muW) / muW; val = Math.round(255 * huToGray(hu, wl, ww)); }
      d[o] = d[o + 1] = d[o + 2] = val; d[o + 3] = 255;
    }
  }
  g.putImageData(im, 0, 0);
}

function currentScan() {
  const S = ctx.S;
  return S.ct.storage.find(s => s.id === S.ct.viewer.scanId) || S.ct.storage[S.ct.storage.length - 1] || null;
}

function populateScanSelect() {
  const sel = ctx.$('ctScanSel'); if (!sel) return;
  const S = ctx.S, cur = currentScan();
  sel.innerHTML = S.ct.storage.map(s => '<option value="' + s.id + '"' + (cur && s.id === cur.id ? ' selected' : '') + '>' + s.label + '</option>').join('');
  sel.disabled = !S.ct.storage.length;
}

function updateViewerInfo(scan, sl) {
  const el = ctx.$('ctSliceInfo'); if (!el) return;
  const v = ctx.S.ct.viewer;
  if (!scan || !sl) { el.textContent = ''; return; }
  el.innerHTML =
    '<span>SLICE ' + (v.slice + 1) + ' / ' + scan.slices.length + '</span>' +
    '<span>' + fmtTablePos(sl.d) + ' mm</span>' +
    '<span>DFOV ' + Math.round(scan.fovMM) + ' mm · ' + scan.params.sliceThk + ' mm · ' + scan.params.kv + ' kV</span>' +
    '<span>WL ' + Math.round(v.wl) + ' / WW ' + Math.round(v.ww) + ' HU</span>';
}

// Exported: (re)draw the whole viewer for the current scan/slice/window. Called by
// app.js setContent('slices') and by the viewer's own controls.
export function ctRenderViewer() {
  if (!ctx) return;
  const S = ctx.S, v = S.ct.viewer, cv = ctx.$('ctSliceCanvas'); if (!cv) return;
  populateScanSelect();
  const scan = currentScan();
  const slider = ctx.$('ctSliceSlider');
  if (!scan || !scan.slices.length) {
    cv.width = 128; cv.height = 128;   // placeholder tile ("NO RECONSTRUCTION")
    const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#3a4653'; g.font = '11px "Share Tech Mono",monospace'; g.textAlign = 'center';
    g.fillText('NO RECONSTRUCTION', cv.width / 2, cv.height / 2);
    if (slider) { slider.max = 0; slider.value = 0; slider.disabled = true; }
    updateViewerInfo(null, null);
    return;
  }
  S.ct.viewer.scanId = scan.id;
  v.slice = Math.max(0, Math.min(scan.slices.length - 1, v.slice));
  const sl = scan.slices[v.slice];
  drawSliceToCanvas(cv, scan, sl, v.wl, v.ww);
  if (slider) { slider.max = scan.slices.length - 1; slider.value = v.slice; slider.disabled = scan.slices.length < 2; }
  updateViewerInfo(scan, sl);
}
// Light redraw (slice/window changed but not the scan list) — same as full render here.
function refreshViewer() { ctRenderViewer(); }

// ==================== Phase 3/4: multiplanar reconstruction ====================
// Each stored scan keeps its full transverse VOLUME (scan.vol, nz × N × N). A recon
// resamples that volume in a chosen plane (axial / coronal / sagittal), cropped to a
// DFOV around an R/L + A/P offset, at a slice thickness (slab) and interval, with a
// processing algorithm (standard / edge / blur / MIP / MinIP) and optional metal-
// artifact reduction. The Recons tab lists a scan's recons, edits them via a popup,
// and shows the selected recon with a scroll slider + a localizer (a line at the
// current slice on an orthogonal reference, angled to the plane, with a slice-order arrow).
const RECON_ALGOS = [['standard', 'Standard'], ['edge', 'Edge'], ['blur', 'Blur'], ['mip', 'MIP'], ['minip', 'MinIP']];

// Trilinear sample of the volume at world (x mm, y mm relative to ISO_Y, inferior d mm).
// Returns NaN outside the acquired volume.
function sampleVol(scan, xmm, yrel, dmm) {
  const N = scan.gridN, nz = scan.nz, p = scan.fovMM / N;
  const fx = xmm / p + (N - 1) / 2, fy = yrel / p + (N - 1) / 2, fz = (dmm - scan.z0) / scan.dz;
  if (fx < -0.5 || fx > N - 0.5 || fy < -0.5 || fy > N - 0.5 || fz < -0.5 || fz > nz - 0.5) return NaN;
  const cx = clampV(fx, 0, N - 1.0001), cy = clampV(fy, 0, N - 1.0001), cz = clampV(fz, 0, nz - 1.0001);
  const x0 = Math.floor(cx), y0 = Math.floor(cy), z0 = Math.floor(cz), tx = cx - x0, ty = cy - y0, tz = cz - z0;
  const v = scan.vol, NN = N * N;
  const at = (z, y, x) => v[z * NN + y * N + x];
  const c00 = at(z0, y0, x0) * (1 - tx) + at(z0, y0, x0 + 1) * tx;
  const c01 = at(z0, y0 + 1, x0) * (1 - tx) + at(z0, y0 + 1, x0 + 1) * tx;
  const c10 = at(z0 + 1, y0, x0) * (1 - tx) + at(z0 + 1, y0, x0 + 1) * tx;
  const c11 = at(z0 + 1, y0 + 1, x0) * (1 - tx) + at(z0 + 1, y0 + 1, x0 + 1) * tx;
  const c0 = c00 * (1 - ty) + c01 * ty, c1 = c10 * (1 - ty) + c11 * ty;
  return c0 * (1 - tz) + c1 * tz;
}
// Combine a slab of ns samples stepping along one axis through a point, per algorithm.
function slab(scan, axis, x, yrel, d, ns, step, algo) {
  let acc = algo === 'mip' ? -Infinity : algo === 'minip' ? Infinity : 0, cnt = 0;
  for (let j = 0; j < ns; j++) {
    const o = (j - (ns - 1) / 2) * step;
    const v = axis === 'z' ? sampleVol(scan, x, yrel, d + o) : axis === 'y' ? sampleVol(scan, x, yrel + o, d) : sampleVol(scan, x + o, yrel, d);
    if (isNaN(v)) continue;
    if (algo === 'mip') acc = Math.max(acc, v); else if (algo === 'minip') acc = Math.min(acc, v); else { acc += v; cnt++; }
  }
  if (algo === 'mip') return acc === -Infinity ? 0 : acc;
  if (algo === 'minip') return acc === Infinity ? 0 : acc;
  return cnt ? acc / cnt : 0;
}
// Shared volume geometry for the linked MPR grid: in-plane pixel size, the z-extent,
// and the isotropic vertical pixel count for the coronal/sagittal (x/y-z) reformats.
function mprGeom(scan) {
  const N = scan.gridN, p = scan.fovMM / N, zExt = Math.max(scan.dz, (scan.nz - 1) * scan.dz);
  const zh = clampV(Math.round(N * zExt / scan.fovMM), 16, 512), psz = zExt / zh;
  return { N, p, zExt, zh, psz, fov: scan.fovMM, z0: scan.z0 };
}
// Reformat one linked-MPR pane at the current cross-reference position → {data,w,h}.
// axial = x-y at z; coronal = x-z at y; sagittal = y-z at x (anterior left); oblique =
// a true arbitrary plane sampled from its {u,v,n} basis (see obliquePlane). Slab-combined.
function paneImage(scan, pane, cur, prm) {
  const g = mprGeom(scan), N = g.N, p = g.p;
  const nsZ = Math.max(1, Math.round(prm.thk / scan.dz)), nsP = Math.max(1, Math.round(prm.thk / p));
  let w, h, data;
  if (pane === 'axial') {
    w = N; h = N; data = new Float32Array(N * N);
    for (let oy = 0; oy < N; oy++) for (let ox = 0; ox < N; ox++) {
      const x = (ox - (N - 1) / 2) * p, yrel = ((N - 1) / 2 - oy) * p;      // top = +y (dorsal)
      data[oy * N + ox] = slab(scan, 'z', x, yrel, cur.z, nsZ, scan.dz, prm.algo);
    }
  } else if (pane === 'coronal') {
    w = N; h = g.zh; data = new Float32Array(w * h);
    for (let oz = 0; oz < h; oz++) for (let ox = 0; ox < w; ox++) {
      const x = (ox - (N - 1) / 2) * p, d = g.z0 + oz * g.psz;              // top = scan start (superior)
      data[oz * w + ox] = slab(scan, 'y', x, cur.y, d, nsP, p, prm.algo);
    }
  } else if (pane === 'sagittal') {
    w = N; h = g.zh; data = new Float32Array(w * h);
    for (let oz = 0; oz < h; oz++) for (let ox = 0; ox < w; ox++) {
      const y = ((N - 1) / 2 - ox) * p, d = g.z0 + oz * g.psz;              // left = +y (anterior)
      data[oz * w + ox] = slab(scan, 'x', cur.x, y, d, nsP, p, prm.algo);
    }
  } else {                                                                   // true oblique plane
    const ob = ctx.S.ct.mpr.ob, pl = obliquePlane(), zc = g.z0 + g.zExt / 2;
    const vExt = ob.view === 'axial' ? g.zExt : g.fov, fov = ob.fov;         // v spans the perpendicular-to-anchor axis
    w = N; const pu = fov / N; h = clampV(Math.round(N * vExt / fov), 16, 512); const pv = vExt / h;
    const ns = Math.max(1, Math.round(prm.thk / pu));
    data = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const su = (i - (N - 1) / 2) * pu, sv = ((h - 1) / 2 - j) * pv;        // top = +v
      let acc = prm.algo === 'mip' ? -Infinity : prm.algo === 'minip' ? Infinity : 0, cnt = 0;
      for (let k = 0; k < ns; k++) {
        const so = (k - (ns - 1) / 2) * pu;                                  // slab along the plane normal
        const Px = pl.C[0] + su * pl.u[0] + sv * pl.v[0] + so * pl.n[0];
        const Py = pl.C[1] + su * pl.u[1] + sv * pl.v[1] + so * pl.n[1];
        const Pd = pl.C[2] + su * pl.u[2] + sv * pl.v[2] + so * pl.n[2];
        const val = sampleVol(scan, Px, Py, zc + Pd);
        if (isNaN(val)) continue;
        if (prm.algo === 'mip') acc = Math.max(acc, val); else if (prm.algo === 'minip') acc = Math.min(acc, val); else { acc += val; cnt++; }
      }
      data[j * w + i] = prm.algo === 'mip' ? (acc === -Infinity ? 0 : acc) : prm.algo === 'minip' ? (acc === Infinity ? 0 : acc) : (cnt ? acc / cnt : 0);
    }
  }
  if (prm.algo === 'blur') data = filter2D(data, w, h, 'blur');
  else if (prm.algo === 'edge') data = filter2D(data, w, h, 'edge');
  if (prm.mar) applyMAR(data, w, h, scan.muWater);
  return { data, w, h };
}
// 3×3 box blur, or unsharp edge-enhancement (mu-domain).
function filter2D(src, w, h, kind) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue; s += src[yy * w + xx]; n++;
    }
    const blur = s / n, v = src[y * w + x];
    out[y * w + x] = kind === 'blur' ? blur : v + 0.9 * (v - blur);   // edge = unsharp mask
  }
  return out;
}
// Light metal-artifact reduction: cap extreme (metal) μ and blend with the local mean
// so the bright blooming + streaks around dense objects are softened.
function applyMAR(data, w, h, muW) {
  const cap = muW * 2.6;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (data[i] <= cap) continue;
    let s = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue; s += Math.min(data[yy * w + xx], cap); n++;
    }
    data[i] = 0.5 * cap + 0.5 * (s / n);
  }
}
function drawReconData(cv, res, muW, wl, ww) {
  const { data, w, h } = res;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d'), im = g.createImageData(w, h), d8 = im.data;
  for (let i = 0; i < data.length; i++) {
    const hu = 1000 * (data[i] - muW) / muW, v = Math.round(255 * huToGray(hu, wl, ww)), o = i * 4;
    d8[o] = d8[o + 1] = d8[o + 2] = v; d8[o + 3] = 255;
  }
  g.putImageData(im, 0, 0);
}
function line(g, x0, y0, x1, y1) { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); }
function arrow(g, x, y, dx, dy, W) {                 // small arrowhead at (x,y) pointing (dx,dy)
  const s = Math.max(5, W * 0.05), px = -dy, py = dx;
  g.beginPath(); g.moveTo(x + dx * s, y + dy * s);
  g.lineTo(x + px * s * 0.6, y + py * s * 0.6); g.lineTo(x - px * s * 0.6, y - py * s * 0.6); g.closePath(); g.fill();
}

// ---- linked 2×2 MPR workstation ----
// Panes (fixed): coronal (TL), sagittal (TR), axial (BL), oblique axial (BR). A single
// cross-reference position (S.ct.mpr.cur, physical mm) drives all four; each pane draws
// the other planes' positions as coloured lines that line up across panes. Click a pane
// to select + move the crosshair; the wheel scrolls the pane under the cursor. The BR
// oblique plane is defined by a draggable + rotatable box on the axial pane.
function mprScan() { const S = ctx.S; return S.ct.storage.find(s => s.id === S.ct.mpr.scanId) || S.ct.storage[S.ct.storage.length - 1] || null; }
const PLANE_LABEL = { axial: 'AXIAL', coronal: 'CORONAL', sagittal: 'SAGITTAL', oblique: 'OBLIQUE' };
const PLANE_COLOR = { x: '#3b82f6', y: '#22c55e', z: '#f5a623' };   // sagittal(x)=blue, coronal(y)=green, axial(z)=orange
const PANES = ['coronal', 'sagittal', 'axial', 'oblique'];
const algoLabel = (a) => (RECON_ALGOS.find(x => x[0] === a) || RECON_ALGOS[0])[1];
const scanMinThk = (scan) => (scan.recons && scan.recons[0] ? scan.recons[0].minThk : scan.params.acqThk) || 0.625;

function initMprForScan(scan) {
  const m = ctx.S.ct.mpr, g = mprGeom(scan);
  m.scanId = scan.id;
  m.cur = { x: 0, y: 0, z: scan.z0 + (scan.nz - 1) * scan.dz / 2 };
  m.thk = scan.recons && scan.recons[0] ? scan.recons[0].thk : scan.params.sliceThk;
  m.interval = scan.params.interval; m.algo = 'standard'; m.mar = false; m.sel = 'axial';
  m.ob = { view: 'axial', ang: 0, cu: 0, cv: 0, fov: Math.max(20, g.fov * 0.85) };
}
// ---- true-oblique plane geometry ----
const v3add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const v3scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
// The oblique plane in centred physical coords (X=R/L, Y=A/P, D'=inferior−zCentre).
// Anchored to ob.view: the in-view axes a1,a2 hold the localizer line; the plane extends
// along a3 (perpendicular to that view), so it is genuinely oblique to all three ortho
// planes unless ang aligns. u = line dir (image horizontal), v = a3 (image vertical),
// n = in-view normal (the scroll axis).
function obliquePlane() {
  const ob = ctx.S.ct.mpr.ob, c = Math.cos(ob.ang), s = Math.sin(ob.ang);
  let a1, a2, a3;
  if (ob.view === 'axial') { a1 = [1, 0, 0]; a2 = [0, 1, 0]; a3 = [0, 0, 1]; }
  else if (ob.view === 'coronal') { a1 = [1, 0, 0]; a2 = [0, 0, 1]; a3 = [0, 1, 0]; }
  else { a1 = [0, 1, 0]; a2 = [0, 0, 1]; a3 = [1, 0, 0]; }
  return { u: v3add(v3scl(a1, c), v3scl(a2, s)), v: a3, n: v3add(v3scl(a1, -s), v3scl(a2, c)),
    C: v3add(v3scl(a1, ob.cu), v3scl(a2, ob.cv)) };
}
// clamp the localizer centre to the volume (a1 = ±fov/2; a2 = ±fov/2 for axial, ±zExt/2 else)
function clampOb(scan) {
  const g = mprGeom(scan), ob = ctx.S.ct.mpr.ob, f = g.fov / 2, z = g.zExt / 2;
  ob.cu = clampV(ob.cu, -f, f); ob.cv = clampV(ob.cv, ob.view === 'axial' ? -f : -z, ob.view === 'axial' ? f : z);
}
// Physical value at each edge of a pane's image (horizontal L/R, vertical T/B).
function paneAxes(scan, pane) {
  const g = mprGeom(scan), f = g.fov / 2, zT = g.z0, zB = g.z0 + g.zExt;
  if (pane === 'coronal') return { hL: -f, hR: f, vT: zT, vB: zB };
  if (pane === 'sagittal') return { hL: f, hR: -f, vT: zT, vB: zB };   // anterior (+y) on the left
  return { hL: -f, hR: f, vT: f, vB: -f };                             // axial / oblique (top = +y)
}
function paneMapping(scan, pane, cv) {
  const g = mprGeom(scan), iw = g.N, ih = (pane === 'coronal' || pane === 'sagittal') ? g.zh : g.N;
  const W = cv.width, H = cv.height, scale = Math.min(W / iw, H / ih), dw = iw * scale, dh = ih * scale, dx = (W - dw) / 2, dy = (H - dh) / 2;
  const ax = paneAxes(scan, pane);
  return { dx, dy, dw, dh, ax, iw, ih,
    dX: (v) => dx + (v - ax.hL) / (ax.hR - ax.hL) * dw, dY: (v) => dy + (v - ax.vT) / (ax.vB - ax.vT) * dh,
    invH: (px) => ax.hL + (px - dx) / dw * (ax.hR - ax.hL), invV: (py) => ax.vT + (py - dy) / dh * (ax.vB - ax.vT) };
}

export function ctRenderRecons() {
  if (!ctx) return;
  const S = ctx.S, grid = ctx.$('ctMprGrid'), sel = ctx.$('ctReconScanSel'); if (!grid) return;
  const scan = mprScan();
  if (sel) { sel.innerHTML = S.ct.storage.map(s => '<option value="' + s.id + '"' + (scan && s.id === scan.id ? ' selected' : '') + '>' + s.label + '</option>').join(''); sel.disabled = !S.ct.storage.length; }
  const empty = ctx.$('ctMprEmpty');
  if (!scan) { if (empty) empty.style.display = 'flex'; PANES.forEach(p => { const c = ctx.$('mprCanvas_' + p); if (c) { c.width = c.height = 2; c.getContext('2d').clearRect(0, 0, 2, 2); } }); return; }
  if (empty) empty.style.display = 'none';
  if (S.ct.mpr.scanId !== scan.id || !S.ct.mpr.cur) initMprForScan(scan);
  S.ct.mpr.scanId = scan.id;
  updateMprBar(scan);
  PANES.forEach(p => drawPane(scan, p));
}
function updateMprBar(scan) {
  const m = ctx.S.ct.mpr;
  const al = ctx.$('ctMprAlgo'); if (al && al.value !== m.algo) al.value = m.algo;
  const tk = ctx.$('ctMprThk'); if (tk && document.activeElement !== tk) tk.value = fmtNum(m.thk);
  const mar = ctx.$('ctMprMar'); if (mar) { mar.classList.toggle('on', m.mar); mar.textContent = m.mar ? 'MAR ON' : 'MAR OFF'; }
  const wl = ctx.$('ctReconWL'), ww = ctx.$('ctReconWW'); if (wl) wl.value = m.wl; if (ww) ww.value = m.ww;
}
function paneLabelPos(scan, pane) {
  const c = ctx.S.ct.mpr.cur;
  if (pane === 'coronal') return 'A/P ' + (c.y >= 0 ? '+' : '') + Math.round(c.y) + ' mm';
  if (pane === 'sagittal') return 'R/L ' + (c.x >= 0 ? '+' : '') + Math.round(c.x) + ' mm';
  if (pane === 'oblique') { const ob = ctx.S.ct.mpr.ob; return PLANE_LABEL[ob.view] + ' ∠' + Math.round(ob.ang * 180 / Math.PI) + '° · DFOV ' + Math.round(ob.fov) + ' mm'; }
  return fmtTablePos(c.z) + ' mm';
}
let _off = null;
function drawPane(scan, pane) {
  const paneEl = ctx.$('mprPane_' + pane), cv = ctx.$('mprCanvas_' + pane); if (!cv || !paneEl) return;
  const m = ctx.S.ct.mpr, prm = { thk: m.thk, interval: m.interval, algo: m.algo, mar: m.mar, ob: m.ob };
  const rect = cv.getBoundingClientRect(), W = Math.max(2, Math.round(rect.width)), H = Math.max(2, Math.round(rect.height));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const img = paneImage(scan, pane, m.cur, prm);
  if (!_off) _off = document.createElement('canvas');
  if (_off.width !== img.w || _off.height !== img.h) { _off.width = img.w; _off.height = img.h; }
  const octx = _off.getContext('2d'), oi = octx.createImageData(img.w, img.h), d8 = oi.data, muW = scan.muWater;
  for (let i = 0; i < img.data.length; i++) { const hu = 1000 * (img.data[i] - muW) / muW, val = Math.round(255 * huToGray(hu, m.wl, m.ww)), o = i * 4; d8[o] = d8[o + 1] = d8[o + 2] = val; d8[o + 3] = 255; }
  octx.putImageData(oi, 0, 0);
  const map = paneMapping(scan, pane, cv);
  g.imageSmoothingEnabled = true; g.drawImage(_off, map.dx, map.dy, map.dw, map.dh);
  const cur = m.cur;
  if (pane === 'coronal') { refLine(g, 'v', map.dX(cur.x), map.dy, map.dh, PLANE_COLOR.x); refLine(g, 'h', map.dY(cur.z), map.dx, map.dw, PLANE_COLOR.z); }
  else if (pane === 'sagittal') { refLine(g, 'v', map.dX(cur.y), map.dy, map.dh, PLANE_COLOR.y); refLine(g, 'h', map.dY(cur.z), map.dx, map.dw, PLANE_COLOR.z); }
  else if (pane === 'axial') { refLine(g, 'v', map.dX(cur.x), map.dy, map.dh, PLANE_COLOR.x); refLine(g, 'h', map.dY(cur.y), map.dx, map.dw, PLANE_COLOR.y); }
  else if (pane === 'oblique') { g.save(); g.strokeStyle = '#eef4fb'; g.globalAlpha = .45; refLine(g, 'v', map.dx + map.dw / 2, map.dy, map.dh, '#eef4fb'); refLine(g, 'h', map.dy + map.dh / 2, map.dx, map.dw, '#eef4fb'); g.restore(); }
  if (pane === m.ob.view && pane !== 'oblique') drawObliqueLine(g, scan, pane, map);   // localizer on its anchor view
  paneEl.classList.toggle('sel', m.sel === pane);
  const lbl = paneEl.querySelector('.mpr-lbl');
  if (lbl) lbl.textContent = PLANE_LABEL[pane] + '  ·  ' + paneLabelPos(scan, pane) + '  ·  ' + fmtNum(m.thk) + 'mm  ·  ' + algoLabel(m.algo) + (m.mar ? ' · MAR' : '') + '  ·  W/L ' + Math.round(m.ww) + '/' + Math.round(m.wl);
}
// Cross-reference line across the image with a slice-order arrow in the margin.
function refLine(g, dir, pos, off0, len, color) {
  g.save(); g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 1.4; g.globalAlpha = 0.92;
  if (dir === 'v') { line(g, pos, off0, pos, off0 + len); g.beginPath(); g.moveTo(pos, off0 - 1); g.lineTo(pos - 4, off0 - 8); g.lineTo(pos + 4, off0 - 8); g.closePath(); g.fill(); }
  else { line(g, off0, pos, off0 + len, pos); g.beginPath(); g.moveTo(off0 - 1, pos); g.lineTo(off0 - 8, pos - 4); g.lineTo(off0 - 8, pos + 4); g.closePath(); g.fill(); }
  g.restore();
}
// Convert an in-view (a1,a2) coord of the oblique anchor to display px on that pane.
function obDisp(scan, pane, map, cu, cv) {
  const g = mprGeom(scan), zc = g.z0 + g.zExt / 2;
  return [map.dX(cu), map.dY(pane === 'axial' ? cv : (zc + cv))];   // vertical is A/P (axial) or inferior (coronal/sagittal)
}
// Inverse: a click on the anchor pane → its (a1,a2) in-view coord.
function obClickAB(scan, pane, map, px, py) {
  const g = mprGeom(scan), zc = g.z0 + g.zExt / 2, hv = map.invH(px), vv = map.invV(py);
  return { cu: hv, cv: pane === 'axial' ? vv : (vv - zc) };
}
// The oblique localizer: the plane is edge-on to its anchor view, so it appears as a
// LINE. Drawn with end handles (grab to rotate + scale) and a short normal tick (the
// direction the oblique slices advance). Scrolling the BR pane moves it along the normal.
function drawObliqueLine(g, scan, pane, map) {
  const ob = ctx.S.ct.mpr.ob, c = Math.cos(ob.ang), s = Math.sin(ob.ang), hl = ob.fov / 2;
  const e1 = obDisp(scan, pane, map, ob.cu + c * hl, ob.cv + s * hl);
  const e2 = obDisp(scan, pane, map, ob.cu - c * hl, ob.cv - s * hl);
  const c0 = obDisp(scan, pane, map, ob.cu, ob.cv);
  const nt = obDisp(scan, pane, map, ob.cu - s * ob.fov * 0.16, ob.cv + c * ob.fov * 0.16);   // normal tick
  g.save(); g.strokeStyle = '#f2d06b'; g.fillStyle = '#f2d06b'; g.lineWidth = 1.7;
  line(g, e1[0], e1[1], e2[0], e2[1]);
  line(g, c0[0], c0[1], nt[0], nt[1]);
  [e1, e2].forEach(pt => { g.beginPath(); g.arc(pt[0], pt[1], 4.5, 0, Math.PI * 2); g.fill(); });
  g.restore();
}

// ---- interaction ----
let _mprRAF = null;
function renderMprThrottled() { if (_mprRAF) return; _mprRAF = requestAnimationFrame(() => { _mprRAF = null; const s = mprScan(); if (s) PANES.forEach(p => drawPane(s, p)); }); }
function clampAxis(v, scan) { return clampV(v, -scan.fovMM / 2, scan.fovMM / 2); }
function clampZ(v, scan) { const g = mprGeom(scan); return clampV(v, g.z0, g.z0 + g.zExt); }

function onPaneWheel(e, pane) {
  e.preventDefault(); const scan = mprScan(); if (!scan) return;
  const m = ctx.S.ct.mpr, dir = e.deltaY > 0 ? 1 : -1, step = Math.max(m.interval, 0.5);
  m.sel = pane;
  if (pane === 'coronal') m.cur.y = clampAxis(m.cur.y + dir * step, scan);
  else if (pane === 'sagittal') m.cur.x = clampAxis(m.cur.x + dir * step, scan);
  else if (pane === 'axial') m.cur.z = clampZ(m.cur.z + dir * step, scan);
  else { const th = m.ob.ang; m.ob.cu += dir * step * -Math.sin(th); m.ob.cv += dir * step * Math.cos(th); clampOb(scan); }   // oblique: move along the plane normal
  renderMprThrottled();
}
function evtToCanvas(e, cv) { const r = cv.getBoundingClientRect(); return { px: (e.clientX - r.left) * (cv.width / r.width), py: (e.clientY - r.top) * (cv.height / r.height) }; }

function onPaneDown(e, pane, cv) {
  const scan = mprScan(); if (!scan) return;
  const m = ctx.S.ct.mpr; m.sel = pane; e.preventDefault();
  try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  const map = paneMapping(scan, pane, cv);
  const setCross = (ev) => {
    const { px, py } = evtToCanvas(ev, cv), hv = map.invH(px), vv = map.invV(py);
    if (pane === 'coronal') { m.cur.x = clampAxis(hv, scan); m.cur.z = clampZ(vv, scan); }
    else if (pane === 'sagittal') { m.cur.y = clampAxis(hv, scan); m.cur.z = clampZ(vv, scan); }
    else if (pane === 'axial') { m.cur.x = clampAxis(hv, scan); m.cur.y = clampAxis(vv, scan); }
    renderMprThrottled();
  };
  if (pane === 'oblique') { renderMprThrottled(); return; }   // BR: select only (scroll/wheel drives it)
  // If this pane is the oblique's anchor, its localizer line takes clicks near it:
  // an end handle grab rotates + scales the plane; a drag on the body moves it; a plain
  // click elsewhere sets the cross-reference. So the line coexists with the crosshair.
  let mode = null, grab = null, endSign = 1;
  if (pane === m.ob.view) {
    const { px, py } = evtToCanvas(e, cv), ob = m.ob, ab = obClickAB(scan, pane, map, px, py);
    const c = Math.cos(ob.ang), s = Math.sin(ob.ang), du = ab.cu - ob.cu, dv = ab.cv - ob.cv;
    const along = du * c + dv * s, perp = -du * s + dv * c, hl = ob.fov / 2, tol = Math.max(4, ob.fov * 0.14);
    if (Math.abs(perp) < tol && Math.abs(along) <= hl + tol) {
      if (Math.abs(along) > hl - tol) { mode = 'end'; endSign = Math.sign(along) || 1; }
      else { mode = 'move'; grab = { ou: ab.cu - ob.cu, ov: ab.cv - ob.cv }; }
    }
  }
  if (!mode) setCross(e);
  const start = { x: e.clientX, y: e.clientY };
  const move = (ev) => {
    const { px, py } = evtToCanvas(ev, cv), ob = m.ob;
    if (mode === 'end') {                                  // grabbed end follows the cursor → rotate + scale about centre
      const ab = obClickAB(scan, pane, map, px, py), vu = (ab.cu - ob.cu) * endSign, vv = (ab.cv - ob.cv) * endSign, d = Math.hypot(vu, vv);
      if (d > 1) { ob.ang = Math.atan2(vv, vu); ob.fov = clampV(2 * d, 12, scan.fovMM * 1.6); }
      renderMprThrottled(); return;
    }
    if (mode === 'move') { const ab = obClickAB(scan, pane, map, px, py); ob.cu = ab.cu - grab.ou; ob.cv = ab.cv - grab.ov; clampOb(scan); renderMprThrottled(); return; }
    if (!mode) setCross(ev);
  };
  const up = () => { cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', up); };
  cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
}

function wireRecons() {
  PANES.forEach(pane => {
    const cv = ctx.$('mprCanvas_' + pane); if (!cv) return;
    cv.addEventListener('pointerdown', (e) => onPaneDown(e, pane, cv));
    cv.addEventListener('wheel', (e) => onPaneWheel(e, pane), { passive: false });
    if (pane !== 'oblique') cv.addEventListener('dblclick', (e) => {   // re-anchor the oblique plane onto this view
      const scan = mprScan(); if (!scan) return; const map = paneMapping(scan, pane, cv), { px, py } = evtToCanvas(e, cv);
      const ab = obClickAB(scan, pane, map, px, py), m = ctx.S.ct.mpr;
      m.ob.view = pane; m.ob.cu = ab.cu; m.ob.cv = ab.cv; m.ob.ang = 0; clampOb(scan); m.sel = 'oblique'; ctRenderRecons();
    });
  });
  ctx.$('ctReconScanSel')?.addEventListener('change', (e) => { ctx.S.ct.mpr.scanId = +e.target.value; ctx.S.ct.mpr.cur = null; ctRenderRecons(); });
  ctx.$('ctMprAlgo')?.addEventListener('change', (e) => { ctx.S.ct.mpr.algo = e.target.value; ctRenderRecons(); });
  ctx.$('ctMprThk')?.addEventListener('change', (e) => { const s = mprScan(); const mn = s ? scanMinThk(s) : 0.625; ctx.S.ct.mpr.thk = Math.max(mn, sanitizeNum(e.target.value, ctx.S.ct.mpr.thk)); ctRenderRecons(); });
  ctx.$('ctMprMar')?.addEventListener('click', () => { ctx.S.ct.mpr.mar = !ctx.S.ct.mpr.mar; ctRenderRecons(); });
  const wl = ctx.$('ctReconWL'), ww = ctx.$('ctReconWW');
  wl?.addEventListener('input', () => { ctx.S.ct.mpr.wl = parseInt(wl.value, 10); renderMprThrottled(); });
  ww?.addEventListener('input', () => { ctx.S.ct.mpr.ww = parseInt(ww.value, 10); renderMprThrottled(); });
  ctx.$('ctReconWLPresets')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-wl]'); if (!b) return;
    const m = ctx.S.ct.mpr; m.wl = +b.dataset.wl; m.ww = +b.dataset.ww; if (wl) wl.value = m.wl; if (ww) ww.value = m.ww; ctRenderRecons();
  });
  window.addEventListener('resize', () => { if (ctx.$('ctRecons')?.classList.contains('show')) renderMprThrottled(); });
}

// ---- busy state (grey controls during a scan) ----
function setBusy(on) {
  ctx.S.ct.busy = on;
  document.body.classList.toggle('ct-busy', on);
  const st = ctx.$('ctStart'), tb = ctx.$('ctTable');
  if (st) st.disabled = on; if (tb) tb.disabled = on;
}

// ---- wiring (called from initCT) ----
function wireStorage() {
  const chk = ctx.$('ctAutoDel');
  if (chk) chk.addEventListener('change', () => {
    ctx.S.ct.autoDelete = chk.checked;
    enforceStorageLimit(); renderStorage();
    if (ctx.S.bayContent === 'slices') ctRenderViewer();
  });
  ctx.$('ctStorageClear')?.addEventListener('click', () => {
    ctx.S.ct.storage.length = 0; ctx.S.ct.viewer.scanId = null;
    renderStorage(); if (ctx.S.bayContent === 'slices') ctRenderViewer();
  });
  ctx.$('ctStorageList')?.addEventListener('click', (e) => {
    const del = e.target.closest('.cs-del');
    if (del) {
      const id = +del.dataset.id, S = ctx.S;
      const idx = S.ct.storage.findIndex(s => s.id === id);
      if (idx >= 0) { S.ct.storage.splice(idx, 1); if (S.ct.viewer.scanId === id) S.ct.viewer.scanId = null; }
      renderStorage(); if (S.bayContent === 'slices') ctRenderViewer();
      return;
    }
    const open = e.target.closest('.cs-open');
    if (open) { ctx.S.ct.viewer.scanId = +open.dataset.id; ctx.S.ct.viewer.slice = 0; renderStorage(); ctx.setContent('slices'); }
  });
  renderStorage();
}

function wireSliceViewer() {
  const slider = ctx.$('ctSliceSlider');
  slider?.addEventListener('input', () => { ctx.S.ct.viewer.slice = parseInt(slider.value, 10) || 0; refreshViewer(); });
  const scrollSlices = (dir) => {
    const scan = currentScan(); if (!scan) return;
    ctx.S.ct.viewer.slice = Math.max(0, Math.min(scan.slices.length - 1, ctx.S.ct.viewer.slice + dir));
    refreshViewer();
  };
  ctx.$('ctSlices')?.addEventListener('wheel', (e) => {
    if (!ctx.$('ctSlices').classList.contains('show')) return;
    e.preventDefault(); scrollSlices(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  const wl = ctx.$('ctWL'), ww = ctx.$('ctWW');
  wl?.addEventListener('input', () => { ctx.S.ct.viewer.wl = parseInt(wl.value, 10); refreshViewer(); });
  ww?.addEventListener('input', () => { ctx.S.ct.viewer.ww = parseInt(ww.value, 10); refreshViewer(); });
  ctx.$('ctWLPresets')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-wl]'); if (!b) return;
    const v = ctx.S.ct.viewer; v.wl = +b.dataset.wl; v.ww = +b.dataset.ww;
    if (wl) wl.value = v.wl; if (ww) ww.value = v.ww;
    refreshViewer();
  });
  ctx.$('ctScanSel')?.addEventListener('change', (e) => {
    ctx.S.ct.viewer.scanId = +e.target.value; ctx.S.ct.viewer.slice = 0; renderStorage(); refreshViewer();
  });
  ctx.$('ctReconScanSel')?.addEventListener('change', (e) => {
    ctx.S.ct.viewer.scanId = +e.target.value; ctRenderRecons();
  });
}
