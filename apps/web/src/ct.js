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
let couch = null, gantry = null, gantrySpin = null;  // couch pallet (moves) + gantry ring (static) + rotating tube/detector (scan only)
let couchBase = null, gantryShell = null;            // vendor exterior: static pedestal + housing cover — shown in the Orbit PoV only
let boreFrameRing = null;                            // bare bore-framing ring for the AP / Lat planning views (hidden in Orbit)
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

// CT protocols. Each sets a predetermined scout range and an anatomical isocentring
// landmark (GE convention). `start` is the table position (landmark-relative, mm) of
// the scout's superior edge — negative = superior of the landmark; `len` is the scout
// length. The landmark 2-char shorthand (SN/IC/XY/OM) is where the tech sets table 0,
// so the scout start is usually NOT 0 (e.g. a CAP is set at the sternal notch, but the
// coverage begins ~120 mm above it at the lung apices). `len:0` = use the full model.
const LANDMARKS = { SN: 'Sternal notch', IC: 'Iliac crest', XY: 'Xiphoid', OM: 'Orbital margin' };
const CT_PROTOCOLS = [
  { id: 'whole',     name: 'Whole scout',              land: '',   start: 0,    len: 0 },
  { id: 'cap',       name: 'Chest / Abdomen / Pelvis', land: 'SN', start: -120, len: 640 },
  { id: 'chest',     name: 'Chest',                    land: 'SN', start: -60,  len: 340 },
  { id: 'abdomen',   name: 'Abdomen',                  land: 'XY', start: -20,  len: 300 },
  { id: 'abdpelvis', name: 'Abdomen / Pelvis',         land: 'XY', start: -20,  len: 440 },
  { id: 'lspine',    name: 'Lumbar Spine',             land: 'IC', start: -180, len: 300 },
  { id: 'head',      name: 'Head',                     land: 'OM', start: -20,  len: 180 },
  { id: 'neck',      name: 'Neck',                     land: 'SN', start: -230, len: 260 },
];
const ctProtocol = (id) => CT_PROTOCOLS.find((p) => p.id === (id || ctx.S.ct.protocol)) || CT_PROTOCOLS[0];
// scout's superior-edge table position (landmark-relative). Every displayed table
// position is this offset + the physical scout coordinate; the recon geometry stays in
// scout coordinates (0..scanLen), so this is purely a readout re-labelling.
const scanStartMM = () => ctx.S.ct.scanStart || 0;

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
  // MOVE TO SCAN: a reclining patient on the couch feeding right into the gantry (arrow)
  moveScan: '<svg viewBox="0 0 24 24" aria-hidden="true">' +
            '<circle cx="5.4" cy="10" r="1.6" fill="currentColor"/>' +
            '<path class="stroke" d="M7.4 11.5 Q10.6 9.7 13.4 11.5"/>' +
            '<path class="stroke" d="M2.8 13.4 H14.4 M4.4 13.6 V16.2 M12.8 13.6 V16.2"/>' +
            '<path class="stroke" d="M16.4 8.4 H21.4 M19.2 6.2 L21.6 8.4 L19.2 10.6"/></svg>',
};

export function initCT(context) {
  ctx = context;
  buildCTScene();
  injectSymbols();
  wireModeToggle();
  wireCTSettings();
  wireScoutTable();
  wireCTConsole();
  initScanBoxes();
  wireStorage();
  wireSliceViewer();
  wireRecons();
  wireScoutZoom();
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

  // ---- CT machine: couch pallet (moves), couch base/pedestal (static), gantry housing (static) ----
  // The vendor-accurate cover, control panels and pedestal are built in rebuildCTModel() so the
  // whole rig can be re-skinned when the vendor toggle flips (GE Optima ↔ Canon/Toshiba Aquilion).
  couch = new THREE.Group(); couch.visible = false; three.scene.add(couch);        // sliding pallet (patient lies here; top at local y=0)
  couchBase = new THREE.Group(); couchBase.visible = false; three.scene.add(couchBase);   // pedestal + foot (static, Orbit PoV only)
  gantry = new THREE.Group(); gantry.visible = false; three.scene.add(gantry);      // bore ring + housing cover (static)
  rebuildCTModel();

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

// ============================================================================
// Vendor-accurate CT machine model (gantry housing + control panels + couch).
// The exterior cover / panels / pedestal are only shown in the Orbit PoV (the
// AP / Lat planning views sit inside the bore, so they keep the bare framing ring).
// Re-skinned on the vendor toggle: GE Optima (blue-grey two-tone, dark base,
// angular table) vs Canon / Toshiba Aquilion (warm white, bellows table column).
// ============================================================================
const GANT_DEPTH = 50, FRONT_Z = 12, FLOOR_Y = ISO_Y - 100;   // real-Optima proportions: bore centre ≈1 m above floor
// Patient-table specifications per vendor, from the official datasheets:
//  · GE Optima CT660 / GT1700V ("EMEA Product Description", 2010): Horizontal Range 1745 mm;
//    scannable 1730 axial / 1580 helical / 1600 scout; Vertical Range 430–991 mm; cradle speed
//    125–150 mm/s; 227 kg; envelope 660 × 4456 mm → ≈2.2 m cradle. NO lateral couch movement.
//  · Canon / Toshiba Aquilion ONE (TSX-301/306 product data): horizontal stroke 2190 mm (2390 on
//    the long couch); scan range 1800–2000 mm; vertical stroke ≈600 mm from a 330 mm minimum
//    couch-top height → ≈330–935 mm; Lateral Slide ±85 mm; 300 kg → ≈2.4 m cradle.
const TABLE_SPECS = {
  ge:    { travelMM: 1745, topMinMM: 430, topMaxMM: 991, moveSpeedMMPS: 150, cradleU: 220, cradleWU: 46, latMM: 0 },
  canon: { travelMM: 2190, topMinMM: 330, topMaxMM: 935, moveSpeedMMPS: 150, cradleU: 240, cradleWU: 47, latMM: 85 },
};
const tableSpec = () => TABLE_SPECS[(ctx && ctx.S.ct.vendor) === 'canon' ? 'canon' : 'ge'];
const travelHalfU = () => tableSpec().travelMM / 2 / MM_PER_UNIT;   // half-travel about the isocentre, world units
const clampPatientZ = (z) => clampV(z, -travelHalfU(), travelHalfU());
// Landmark-relative table-position (mm) reachable within the physical travel (the zero point moves
// with c.isoZ, so the limits are converted from the ABSOLUTE cradle position, which is patient.z).
function clampTablePosMM(tp) {
  const c = ctx.S.ct, h = travelHalfU();
  return clampV(tp, (c.isoZ - h) * MM_PER_UNIT, (c.isoZ + h) * MM_PER_UNIT);
}
// Table-height (tableY, mm) limits: the cradle top may never exceed the vendor's spec ceiling; the
// ±80 mm fine-adjust window applies otherwise (the full patient-loading drop isn't simulated,
// matching e.g. GE's "vertical scannable range 791–991 mm" — you scan near the top of the range).
function tableYLimits() {
  const s = tableSpec(), topAtZero = (ISO_Y - backDropU() - FLOOR_Y) * MM_PER_UNIT;   // cradle-top height (mm) at tableY = 0
  // hi never drops below 0 so the default "centred" position stays reachable for thin subjects
  return { lo: Math.max(-80, s.topMinMM - topAtZero), hi: Math.max(0, Math.min(80, s.topMaxMM - topAtZero)) };
}

function vendorLook() {
  const v = (ctx && ctx.S.ct.vendor) || 'ge';
  if (v === 'ge') return {
    v: 'ge', cover: 0xf4f6f8, shoulder: 0xb9c4d2, boreRim: 0x8ea3b5, boreRim2: 0xccd6df,
    recess: 0x93a5bf, recessDark: 0x5e7488, panelFloor: 0xccd4dd, boreLiner: 0xeef2f5, trim: 0x9aabc0,
    baseTop: 0x59626e, baseBot: 0x3a424c, plinth: 33,
    panelFace: '#e7ebef', panelEdge: '#c2ccd6', led: '#08160e', ledText: '#57e089',
    btnFace: '#eef2f6', btn: '#3f7cae', screen1: '#0b2c48', screen2: '#124a72',
    brand: 'GE', model: 'Optima', couchTop: 0xeceff2,
    pedStyle: 'ge', pedLight: 0xdfe4e9, pedBase: 0x46525d, pedFoot: 0x232a31, redDot: 0xff4a3d,
  };
  return {
    v: 'canon', cover: 0xf3f1ea, shoulder: 0xe6e3db, boreRim: 0xbcd2e0, boreRim2: 0xe1eaf0,
    recess: 0xcbc7bd, recessDark: 0xb0aca2, panelFloor: 0xe8e4db, boreLiner: 0xf1efe8, trim: 0xe0ddd3,
    baseTop: 0xe0dcd3, baseBot: 0xcbc7bd, plinth: 0,
    panelFace: '#edebe4', panelEdge: '#d6d3c9', led: '#07130d', ledText: '#7fe0a0',
    btnFace: '#f2f0ea', btn: '#8fa9bd', screen1: '#0b2c48', screen2: '#134a74',
    brand: 'Canon', model: 'Aquilion ONE', couchTop: 0xf1efe8,
    pedStyle: 'bellows', pedLight: 0xe6e2d9, pedBase: 0xdedad1, pedFoot: 0xbfbcb2, redDot: 0xff4a3d,
  };
}
function disposeGroup(g) {
  if (!g) return;
  for (let i = g.children.length - 1; i >= 0; i--) {
    const c = g.children[i]; g.remove(c);
    c.traverse && c.traverse(o => {
      o.geometry && o.geometry.dispose && o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.map && m.map.dispose && m.map.dispose(); m.dispose && m.dispose(); });
    });
  }
}
// (Re)build the whole rig for the current vendor. Preserves the couch / couchBase / gantry groups
// (referenced by ctSyncScene + the scan animation) and re-creates gantrySpin + gantryShell inside.
function rebuildCTModel() {
  if (!ctx || !gantry) return;
  const { THREE } = ctx, look = vendorLook();
  disposeGroup(gantry); disposeGroup(couch); disposeGroup(couchBase);
  gantrySpin = null; gantryShell = null; boreFrameRing = null;
  liveScr = { top: null, timer: null, panel: null };   // screens are rebuilt with the shell
  buildGantry(THREE, look); buildCouch(THREE, look);
  updateGantryDisplays();                              // initial draw — panel readouts must never sit black
}
const stdMat = (THREE, c, m, r) => new THREE.MeshStandardMaterial({ color: c, metalness: m == null ? 0.1 : m, roughness: r == null ? 0.55 : r });
function canvasTex(THREE, cv) { const t = new THREE.CanvasTexture(cv); t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 4; return t; }
function cvRoundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function roundedRectShape(s, w, h, r) { const x = -w / 2, y = -h / 2; s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h); s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r); s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y); }

// ---- live gantry displays ----
// The gantry screens are CanvasTextures redrawn from live state: the top console screen (green =
// table height mm · orange = table position · white = gantry tilt, NYI 0.0° · bottom = the OM/XY/IC
// pads, replaced by protocol name + anatomic-zero shorthand once a protocol is selected), the GE
// side-panel countdown timer (delay / scan durations), and the Canon 4-line panel readout.
// updateGantryDisplays() runs from updateCTReadouts; the timer runs its own rAF loop while counting.
let liveScr = { top: null, timer: null, panel: null };
let timerEndMs = 0, timerRAF = 0;
function mkScreen(THREE, w, h) { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; return { cv, tex: canvasTex(THREE, cv) }; }
function timerRemaining() { return timerEndMs ? Math.max(0, (timerEndMs - performance.now()) / 1000) : 0; }
function startPanelTimer(sec) { timerEndMs = performance.now() + sec * 1000; drawTimerScreens(); if (!timerRAF) tickPanelTimer(); }
function stopPanelTimer() { timerEndMs = 0; drawTimerScreens(); }
function tickPanelTimer() {
  timerRAF = requestAnimationFrame(() => {
    drawTimerScreens();
    if (timerRemaining() > 0) tickPanelTimer(); else { timerRAF = 0; timerEndMs = 0; }
  });
}
function drawTimerScreens() { drawTimerScreen(); drawPanelLED(); }
function updateGantryDisplays() { drawTopScreen(); drawTimerScreens(); }
function drawTopScreen() {
  if (!liveScr.top || !ctx) return;
  const S = ctx.S, look = vendorLook(), cv = liveScr.top.cv, g = cv.getContext('2d'), W = cv.width, H = cv.height;
  const th = Math.round(S.ct.tableY);
  if (look.v === 'ge') {
    g.fillStyle = '#24313e'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#31414f'; g.fillRect(0, 0, W, 24);
    g.fillStyle = '#9fb6c8'; g.font = '13px Arial'; g.textAlign = 'left'; g.fillText('GT1700V', 10, 17);
    // green = table height (mm) · orange = table position · white = gantry tilt (NYI)
    g.font = 'bold 30px Arial';
    g.fillStyle = '#63e08c'; g.fillText((th > 0 ? '+' : '') + th + '.0', 14, 62);
    g.fillStyle = '#ffb347'; g.fillText(fmtTablePos(S.ct.tablePos), 14, 100);
    g.fillStyle = '#ffffff'; g.font = 'bold 22px Arial'; g.textAlign = 'right'; g.fillText('0.0°', W - 12, 62);
    g.fillStyle = '#7e93a5'; g.font = '12px Arial'; g.fillText('mm', W - 12, 100);
    g.textAlign = 'center'; g.font = '16px Arial'; g.fillStyle = '#cfe0ee'; g.fillText('John Smith', W / 2, 128);
    // bottom: the OM/XY/IC anatomic-zero pads — replaced by "protocol name + shorthand box" once
    // a protocol is selected
    const proto = CT_PROTOCOLS.find(p => p.id === S.ct.protocol);
    if (proto && proto.id !== 'whole') {
      g.textAlign = 'left'; g.font = 'bold 17px Arial'; g.fillStyle = '#cfe0ee';
      g.fillText(proto.name.length > 20 ? proto.name.slice(0, 19) + '…' : proto.name, 12, 170);
      g.fillStyle = '#8fa3b8'; cvRoundRect(g, W - 62, 146, 50, 34, 6); g.fill();
      g.fillStyle = '#1d2731'; g.font = 'bold 20px Arial'; g.textAlign = 'center'; g.fillText(proto.land || '—', W - 37, 170);
    } else {
      ['OM', 'XY', 'IC'].forEach((t, i) => {
        g.fillStyle = '#8fa3b8'; cvRoundRect(g, 30 + i * 70, 146, 56, 34, 6); g.fill();
        g.fillStyle = '#1d2731'; g.font = 'bold 20px Arial'; g.textAlign = 'center'; g.fillText(t, 58 + i * 70, 170);
      });
    }
  } else {
    // Canon (ref): light-blue screen, dark band + white rule at the top, "ONE Aquilion" mid,
    // and a small live height / position line at the bottom
    const grd = g.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, '#3572a8'); grd.addColorStop(1, '#8fc0e2');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    g.fillStyle = '#22588c'; g.fillRect(0, 0, W, 34);
    g.fillStyle = '#ffffff'; g.fillRect(26, 20, W - 52, 5);
    g.textAlign = 'center'; g.fillStyle = '#ffffff';
    g.font = 'bold 24px Arial'; g.fillText('ONE', W / 2 + 26, 78);
    g.font = 'italic bold 26px Arial'; g.fillText('Aquilion', W / 2, 108);
    g.font = 'bold 18px "Courier New", monospace';
    g.fillStyle = '#d7f5e2'; g.textAlign = 'left'; g.fillText((th > 0 ? '+' : '') + th + 'mm', 18, 168);
    g.fillStyle = '#ffe0b0'; g.textAlign = 'right'; g.fillText(fmtTablePos(S.ct.tablePos), W - 18, 168);
  }
  liveScr.top.tex.needsUpdate = true;
}
// GE side-panel countdown: delay / scan durations tick down here, 0.0 when idle.
function drawTimerScreen() {
  if (!liveScr.timer) return;
  const cv = liveScr.timer.cv, g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.fillStyle = '#0c1810'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#5fe08a'; g.font = 'bold 34px "Courier New", monospace'; g.textAlign = 'right';
  g.fillText(timerRemaining().toFixed(1), W - 12, H / 2 + 12);
  g.font = '12px "Courier New", monospace'; g.textAlign = 'left'; g.fillText('sec', 8, H / 2 + 12);
  liveScr.timer.tex.needsUpdate = true;
}
// Canon 4-line panel readout: gantry tilt (NYI) / table height / table position / timer.
function drawPanelLED() {
  if (!liveScr.panel || !ctx) return;
  const S = ctx.S, cv = liveScr.panel.cv, g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.fillStyle = '#07130d'; g.fillRect(0, 0, W, H);
  const th = Math.round(S.ct.tableY);
  const rows = [['+0.0', 'deg'], [(th > 0 ? '+' : '') + th, 'mm'], [fmtTablePos(S.ct.tablePos), 'mm'], [timerRemaining().toFixed(1), 'sec']];
  rows.forEach((r, i) => {
    g.fillStyle = '#7fe0a0'; g.font = 'bold 20px "Courier New", monospace'; g.textAlign = 'right'; g.fillText(r[0], W - 36, 24 + i * 25);
    g.font = '11px "Courier New", monospace'; g.textAlign = 'left'; g.fillText(r[1], W - 32, 24 + i * 25);
  });
  liveScr.panel.tex.needsUpdate = true;
}
// Canvas glyph for the panel START key — the console start symbol (diamond + centre line), green.
function makeStartGlyphTex(THREE) {
  const Wc = 64, cv = document.createElement('canvas'); cv.width = cv.height = Wc; const g = cv.getContext('2d');
  g.clearRect(0, 0, Wc, Wc); g.strokeStyle = '#2f9e57'; g.lineWidth = 5; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(32, 8); g.lineTo(56, 32); g.lineTo(32, 56); g.lineTo(8, 32); g.closePath(); g.stroke();
  g.beginPath(); g.moveTo(32, 8); g.lineTo(32, 56); g.stroke();
  return canvasTex(THREE, cv);
}

function buildGantry(THREE, look) {
  const std = (c, m, r) => stdMat(THREE, c, m, r);
  // bore-framing ring — AP / Lat planning views only (the Orbit PoV shows the real housing instead)
  boreFrameRing = new THREE.Mesh(new THREE.TorusGeometry(BORE_R + 2, 2, 16, 80), std(look.boreRim, 0.4, 0.5));
  boreFrameRing.position.set(0, ISO_Y, FRONT_Z - 2); gantry.add(boreFrameRing);
  // rotating tube + detector assembly (spins during a scan) — sized to stay inside the bore throat
  gantrySpin = new THREE.Group(); gantrySpin.position.set(0, ISO_Y, FRONT_Z - 9);
  const tubeBlk = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 6), std(0xdfe3e7, 0.4, 0.4));
  tubeBlk.position.set(0, BORE_R - 7, 0); gantrySpin.add(tubeBlk);
  const foc = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 3.4), new THREE.MeshStandardMaterial({ color: 0xffd27a, emissive: 0xffb733, emissiveIntensity: 0.8 }));
  foc.position.set(0, BORE_R - 10.5, 0); gantrySpin.add(foc);
  const detArc = new THREE.Mesh(new THREE.TorusGeometry(BORE_R - 7, 2.4, 8, 44, Math.PI * 0.85), std(0x2b3742, 0.4, 0.5));
  detArc.rotation.z = -Math.PI / 2 - Math.PI * 0.425; gantrySpin.add(detArc);
  gantrySpin.visible = false; gantry.add(gantrySpin);

  // ---- exterior housing (Orbit PoV only) — proportioned to the GE Optima reference photo:
  // machine ≈240 wide × 206 tall for the 70-unit bore; white cover with a blue-grey frame border ----
  gantryShell = new THREE.Group(); gantry.add(gantryShell);
  const BEV = 3, FACE_Z = FRONT_Z + BEV;                       // extrude front bevel → the TRUE front-face z
  const halfW = 114, topY = ISO_Y + 100, shoulderY = ISO_Y + 30, holeR = BORE_R + 3;
  const topR = look.v === 'canon' ? 92 : 62;                   // Aquilion crown is much rounder than the Optima
  const flare = look.v === 'canon' ? 16 : 6, botY = FLOOR_Y + (look.plinth || 0);
  const silhouette = (grow) => {                                // rounded-arch outline, offset outward by `grow`
    if (look.v === 'canon') {
      // Aquilion Prime SP, measured from the reference: ONE BIG CIRCLE whose centre sits BELOW
      // the bore centre (≈260 mm), so the bore rides high in the disc, the crown is lower
      // (≈ISO_Y+75) and the floor chord is wide (≈±69) — the photo's stance.
      const R = 101 + grow, cy0 = ISO_Y - 26, b = botY - grow;
      const dyB = b - cy0, xB = Math.sqrt(Math.max(1, R * R - dyB * dyB));
      const a = Math.atan2(dyB, xB);
      const c = new THREE.Shape();
      c.absarc(0, cy0, R, a, Math.PI - a, false);               // CCW over the crown, floor to floor
      c.lineTo(xB, b);                                          // close along the floor
      return c;
    }
    const s = new THREE.Shape();
    const hw = halfW + grow, hf = halfW + flare + grow, t = topY + grow, b = botY - grow, tr = topR;
    s.moveTo(-hf + 12, b);
    s.quadraticCurveTo(-hf, b, -hf, b + 14);
    s.lineTo(-hw, shoulderY);
    s.quadraticCurveTo(-hw, t, -hw + tr, t);
    s.lineTo(hw - tr, t);
    s.quadraticCurveTo(hw, t, hw, shoulderY);
    s.lineTo(hf, b + 14);
    s.quadraticCurveTo(hf, b, hf - 12, b);
    s.lineTo(-hf + 12, b);
    return s;
  };
  const mkBoreHole = (sh) => { const h = new THREE.Path(); h.absarc(0, ISO_Y, holeR, 0, Math.PI * 2, true); sh.holes.push(h); };
  // blue-grey FRAME shell — sits behind the white cover and peeks out around the whole outline (ref)
  const frameShape = silhouette(4); mkBoreHole(frameShape);
  const frameGeo = new THREE.ExtrudeGeometry(frameShape, { depth: GANT_DEPTH, bevelEnabled: true, bevelThickness: BEV, bevelSize: 2.4, bevelSegments: 7, curveSegments: 240 });
  frameGeo.computeVertexNormals();
  const frameShell = new THREE.Mesh(frameGeo, std(look.trim, 0.08, 0.5));
  frameShell.position.z = FRONT_Z - GANT_DEPTH - 5; gantryShell.add(frameShell);
  // white front cover
  const shape = silhouette(0); mkBoreHole(shape);
  const coverGeo = new THREE.ExtrudeGeometry(shape, { depth: GANT_DEPTH, bevelEnabled: true, bevelThickness: BEV, bevelSize: 2.4, bevelSegments: 9, curveSegments: 240 });
  coverGeo.computeVertexNormals();
  const cover = new THREE.Mesh(coverGeo, std(look.cover, 0.04, 0.45));
  cover.position.z = FRONT_Z - GANT_DEPTH; gantryShell.add(cover);
  // the big WHITE DONUT moulding around the bore — ONE smooth lathe: outer seam → forward bulge →
  // bore throat → back flare that seals the cover hole from behind. The bore itself stays OPEN
  // (you see the couch through it): no grey collar, no cap, and no see-through gaps at any angle.
  // GE: broad moulding. Canon Prime SP: a smaller donut leaving a wide FLAT face annulus between
  // it and the blue ring (where the flush pads sit). The profile is parametric in the annulus
  // thickness A so both proportions come out right; the bulge flattens for thin annuli.
  const DON_R = look.v === 'canon' ? 60 : 76;                  // ref: donut outer ≈ 0.47 of body width
  const A = DON_R - BORE_R, D = Math.min(1, A / 30) * (look.v === 'canon' ? 0.25 : 1);   // canon: a SUBTLE swell (~1.4 u) so the pads sit flush on it
  const prof = new THREE.SplineCurve([
    new THREE.Vector2(DON_R + 2, 1.5), new THREE.Vector2(DON_R - Math.min(6, A * 0.15), -3.2 * D),
    new THREE.Vector2(BORE_R + A * 0.56, -6.8 * D), new THREE.Vector2(BORE_R + A * 0.27, -5.4 * D),
    new THREE.Vector2(BORE_R + A * 0.11, -1.2 * D), new THREE.Vector2(BORE_R + 0.6, 5),
    new THREE.Vector2(BORE_R, 14), new THREE.Vector2(BORE_R, GANT_DEPTH - 10), new THREE.Vector2(holeR + 1.5, GANT_DEPTH - 5),
  ]).getPoints(72);
  const donGeo = new THREE.LatheGeometry(prof, 240); donGeo.computeVertexNormals();
  const donMat = std(look.cover, 0.04, 0.5); donMat.side = THREE.DoubleSide;
  const donut = new THREE.Mesh(donGeo, donMat);
  donut.rotation.x = -Math.PI / 2;                              // profile +y (deeper) → world −z
  donut.position.set(0, ISO_Y, FACE_Z - 1); gantryShell.add(donut);
  // small grey tab at the top of the bore (ref)
  const tab = new THREE.Mesh(roundedBoxGeo(THREE, 16, 4, 3, 2), std(look.trim, 0.12, 0.45));
  tab.position.set(0, ISO_Y + BORE_R + 6, FACE_Z + 1.6); gantryShell.add(tab);
  // Canon / Toshiba Aquilion signature details, laid out to the reference photo: the thin blue
  // ring hugs the donut seam, the tilted control pads ride the donut's upper flanks INSIDE the
  // ring, red stops sit above the pads, and the oval grips sit tangentially on the lower flanks.
  if (look.v === 'canon') {
    const cy0 = ISO_Y - 26;                                    // the BODY circle's centre (below the bore)
    // signature blue ring — concentric with the BODY circle (not the bore), close to the disc's
    // outer edge (R 101), plus the faint tilt-section seam line just inside it
    const accent = new THREE.Mesh(new THREE.TorusGeometry(96, 1.6, 20, 280), std(0xa9c3d9, 0.2, 0.45));
    accent.position.set(0, cy0, FACE_Z + 0.8); gantryShell.add(accent);
    const seam = new THREE.Mesh(new THREE.TorusGeometry(93, 0.35, 8, 280), std(0xc9c6bb, 0.1, 0.6));
    seam.position.set(0, cy0, FACE_Z + 0.35); gantryShell.add(seam);
    // PIVOT PILLARS: narrow stationary towers tucked BEHIND the disc — only a ~15-unit sliver shows
    // beyond the body edge (ref). Front face 3 behind the cover face → a visible shadow seam (the
    // air gap) traces the circle where disc and pillar meet; the disc tilts between them (NYI).
    [-1, 1].forEach(s => {
      // outer edge ≈ the disc's max radius (100 ≤ R 101): in the photo NO pillar shows at the
      // machine's widest point — slivers appear only where the disc curves away (top-sides + floor)
      const pil = new THREE.Mesh(roundedBoxGeo(THREE, 36, 138, GANT_DEPTH + 2, 14), std(0xdedacf, 0.06, 0.5));
      pil.position.set(s * 82, ISO_Y + 38 - 69, FACE_Z - 3 - (GANT_DEPTH + 2) / 2);   // top at ISO_Y+38, foot at the floor
      gantryShell.add(pil);
    });
    const domeG = (r) => { const gg = new THREE.SphereGeometry(r, 28, 18); gg.scale(1, 1, 0.5); return gg; };
    // ONE red emergency-stop dome per side — MEDIAL, flanking the crown module (the screens sit
    // laterally, further out from the bore's midline)
    [-1, 1].forEach(s => {
      const stop = new THREE.Mesh(domeG(1.5), new THREE.MeshStandardMaterial({ color: 0xd23c30, roughness: 0.35 }));
      stop.position.set(s * 18, ISO_Y + 54, FACE_Z + 1.4); gantryShell.add(stop);
    });
    // oval grip mouldings just outside the bore on the mound's inner slope (ref)
    [-1, 1].forEach(s => {
      const dim = new THREE.Mesh(roundedBoxGeo(THREE, 8, 4, 1.4, 1.9), std(look.shoulder, 0.08, 0.55));
      dim.position.set(s * 40, ISO_Y + 4, FACE_Z + 1.4); dim.rotation.z = -s * 0.1; gantryShell.add(dim);
    });
    // dark sensor slit on the bore-top tab (the ref's element below the module)
    const slit = new THREE.Mesh(roundedBoxGeo(THREE, 1.4, 2.6, 1.0, 0.6), std(0x2b2f33, 0.2, 0.6));
    slit.position.set(0, ISO_Y + BORE_R + 6, FACE_Z + 3.2); gantryShell.add(slit);
  }
  // top-centre console module — proud of the cover, flush with the top edge. GE: blue-grey housing
  // with the big UI screen + mini readout. Canon: the reference's narrow WHITE housing with the
  // blue screen on top, the red Canon wordmark beneath it, and a small speaker slot.
  liveScr.top = mkScreen(THREE, 256, 200); drawTopScreen();          // LIVE console screen (both vendors)
  const scrMat = () => new THREE.MeshStandardMaterial({ map: liveScr.top.tex, emissive: 0xffffff, emissiveMap: liveScr.top.tex, emissiveIntensity: 0.9, roughness: 0.3 });
  if (look.v === 'canon') {
    // Small module nested at the crown of the LOW-centred circle (ref: crown ≈ ISO_Y+75), with a
    // wedge fairing behind it so it reads as moulded into the body rather than floating.
    const canonTop = ISO_Y + 75, modW = 22, modH = 26, modY = canonTop - modH / 2 + 1;
    const wedge = new THREE.Mesh(roundedBoxGeo(THREE, 26, 18, 3, 7), std(look.cover, 0.05, 0.45));
    wedge.position.set(0, canonTop - 7, FACE_Z + 0.2); gantryShell.add(wedge);
    const mod = new THREE.Mesh(roundedBoxGeo(THREE, modW, modH, 8, 4.5), std(look.cover, 0.05, 0.45));
    mod.position.set(0, modY, FACE_Z + 0.5); gantryShell.add(mod);
    const scrBez = new THREE.Mesh(roundedBoxGeo(THREE, 18.6, 14.6, 2, 1.4), std(0x27435f, 0.2, 0.4));
    scrBez.position.set(0, modY + 3.5, FACE_Z + 4.4); gantryShell.add(scrBez);
    const scrMesh = new THREE.Mesh(new THREE.PlaneGeometry(17, 13), scrMat());
    scrMesh.position.set(0, modY + 3.5, FACE_Z + 5.5); gantryShell.add(scrMesh);
    const cb = new THREE.Mesh(new THREE.PlaneGeometry(9.5, 3.4), new THREE.MeshBasicMaterial({ map: makeTextTex(THREE, 'Canon', '#cc0f2f'), transparent: true }));
    cb.position.set(0, modY - 7.5, FACE_Z + 4.9); gantryShell.add(cb);
    const slot = new THREE.Mesh(roundedBoxGeo(THREE, 6, 0.9, 0.8, 0.4), std(0x8b949c, 0.2, 0.5));
    slot.position.set(0, modY - 11, FACE_Z + 4.8); gantryShell.add(slot);
    // green power LED right of the screen + two small grey icons left of it (ref)
    const domeM = (r) => { const gg = new THREE.SphereGeometry(r, 28, 18); gg.scale(1, 1, 0.5); return gg; };
    const pwr = new THREE.Mesh(domeM(0.9), new THREE.MeshStandardMaterial({ color: 0x69d47a, emissive: 0x3fae52, emissiveIntensity: 0.8 }));
    pwr.position.set(11.5, modY + 4, FACE_Z + 2.2); gantryShell.add(pwr);          // on the wedge, right of the screen
    [2, 6.5].forEach(dy => {
      const ic = new THREE.Mesh(domeM(0.7), std(0x9aa4ad, 0.15, 0.5));
      ic.position.set(-11.5, modY + dy, FACE_Z + 2.1); gantryShell.add(ic);        // small icons left of the screen
    });
  } else {
    const modW = 42, modH = 52, modY = topY - modH / 2 - 1;
    const mod = new THREE.Mesh(roundedBoxGeo(THREE, modW, modH, 12, 6), std(look.recess, 0.1, 0.5));
    mod.position.set(0, modY, FACE_Z + 0.5); gantryShell.add(mod);
    const scrBez = new THREE.Mesh(roundedBoxGeo(THREE, 30, 24, 2.4, 2), std(0x2c353f, 0.2, 0.4));
    scrBez.position.set(0, modY + 8, FACE_Z + 6.2); gantryShell.add(scrBez);
    const scrMesh = new THREE.Mesh(new THREE.PlaneGeometry(27, 21), scrMat());
    scrMesh.position.set(0, modY + 8, FACE_Z + 7.5); gantryShell.add(scrMesh);
    const miniTex = makeMiniLedTex(THREE);
    const mini = new THREE.Mesh(new THREE.PlaneGeometry(12, 3.2), new THREE.MeshStandardMaterial({ map: miniTex, emissive: 0xffffff, emissiveMap: miniTex, emissiveIntensity: 0.9, roughness: 0.3 }));
    mini.position.set(0, modY - 10, FACE_Z + 6.8); gantryShell.add(mini);
    const slot = new THREE.Mesh(roundedBoxGeo(THREE, 14, 1.2, 1, 0.5), std(0x5a6672, 0.2, 0.5));
    slot.position.set(0, modY - 15, FACE_Z + 6.6); gantryShell.add(slot);
  }
  // side control panels + patient-indicator pills — mounted ON the true front face (never buried)
  [-1, 1].forEach(s => {
    const panel = buildPanel(THREE, look, s);
    // Aquilion: NO group rotation — the screen and key rows stay level with the floor; the layout
    // inside buildPanel cascades diagonally around the bore (group origin = bore centre)
    if (look.v === 'canon') { panel.position.set(0, ISO_Y, FACE_Z + 0.4); }
    else { panel.position.set(s * 91, ISO_Y + 38, FACE_Z + 0.2); panel.rotation.z = -s * 0.10; }
    gantryShell.add(panel);
    if (look.v === 'ge') {                                      // GE-only patient-indicator pills
      const pill = new THREE.Mesh(roundedBoxGeo(THREE, 8, 4.5, 2, 2), std(0xffffff, 0.03, 0.5));
      pill.position.set(s * 70, ISO_Y + 58, FACE_Z + 0.8); gantryShell.add(pill);
      const picon = new THREE.Mesh(new THREE.CircleGeometry(1.2, 20), new THREE.MeshStandardMaterial({ color: 0xd9838f, emissive: 0xd9838f, emissiveIntensity: 0.4, roughness: 0.4 }));
      picon.position.set(s * 70, ISO_Y + 58, FACE_Z + 2); gantryShell.add(picon);
    }
  });
  // badging: "Optima" wordmark (left) + GE roundel (right); Canon shows its wordmarks instead
  const badge = (tex, w, h, x, y) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    m.position.set(x, y, FACE_Z + 0.3); gantryShell.add(m);
  };
  if (look.v === 'ge') {
    badge(makeTextTex(THREE, look.model), 28, 10, -72, ISO_Y + 72);
    badge(makeGELogoTex(THREE), 10, 10, 70, ISO_Y + 72);
  } else {
    // two-line "ONE / Aquilion" wordmark on the FLAT face annulus (it previously intersected the
    // donut bulge, which sliced the text — that was the "clipping")
    const wm = new THREE.Mesh(new THREE.PlaneGeometry(20, 10), new THREE.MeshBasicMaterial({ map: makeAquilionTex(THREE), transparent: true }));
    wm.position.set(-31, ISO_Y + 52, FACE_Z + 2.5); gantryShell.add(wm);   // upper-left, fully INSIDE the edge ring (no clipping)
  }
  // dark slate base plinth (full width, slightly stepped — ref)
  if (look.plinth) {
    const p1 = new THREE.Mesh(roundedBoxGeo(THREE, (halfW + flare) * 2 + 18, 18, GANT_DEPTH + 12, 4), std(look.baseBot, 0.2, 0.55));
    p1.position.set(0, FLOOR_Y + 8, FRONT_Z - GANT_DEPTH / 2); gantryShell.add(p1);
    const p2 = new THREE.Mesh(roundedBoxGeo(THREE, (halfW + flare) * 2 + 10, 18, GANT_DEPTH + 6, 4), std(look.baseTop, 0.18, 0.6));
    p2.position.set(0, FLOOR_Y + 24, FRONT_Z - GANT_DEPTH / 2); gantryShell.add(p2);
  }
}

// A rounded box (no sharp corners) via an extruded rounded-rect with a matching front/back bevel,
// centred on the origin with total depth d.
function roundedBoxGeo(THREE, w, h, d, r) {
  const rr = Math.max(0.5, Math.min(r, w / 2 - 0.5, h / 2 - 0.5));
  const s = new THREE.Shape(); roundedRectShape(s, w, h, rr);
  const bt = Math.max(0.2, Math.min(rr * 0.85, d * 0.45));
  const g = new THREE.ExtrudeGeometry(s, { depth: d - bt * 2, bevelEnabled: true, bevelThickness: bt, bevelSize: bt, bevelSegments: 10, curveSegments: 56 });
  g.translate(0, 0, bt - d / 2); g.computeVertexNormals();
  return g;
}
// Push a rounded-rect HOLE into a shape (reversed winding), for the recessed panels / display.
function pushRRHole(THREE, shape, cx, cy, w, h, r) {
  const s = new THREE.Shape(); roundedRectShape(s, w, h, Math.min(r, w / 2 - 0.5, h / 2 - 0.5));
  const pts = s.getPoints(20).map(p => new THREE.Vector2(p.x + cx, p.y + cy)).reverse();
  shape.holes.push(new THREE.Path(pts));
}
// One control panel — matches the reference: a white rounded tray on a grey outline plate, two
// small green readouts along the top, and a ring of small flat BLUE keys below (GE); Canon keeps
// a green readout + key rows. Surface-mounted on the true front face — nothing buried or cut out.
function buildPanel(THREE, look, side) {
  side = side || 1;                                              // −1 = left pad, +1 = right (canon mirrors its layout)
  const S = (c, m, r) => stdMat(THREE, c, m, r);
  const gp = new THREE.Group();
  // smooth DOMED keys (squashed spheres half-sunk in the face — no sharp cylinder edges); lit
  // keys (canon's cyan motion buttons) get a soft emissive glow
  const dome = (r) => { const gg = new THREE.SphereGeometry(r, 28, 18); gg.scale(1, 1, 0.5); return gg; };
  const key = (x, y, r, color, glow) => {
    const m = new THREE.Mesh(dome(r), new THREE.MeshStandardMaterial({ color: color || look.btn, metalness: 0.08, roughness: 0.32, emissive: glow || 0x000000, emissiveIntensity: glow ? 0.5 : 0 }));
    m.position.set(x, y, 1.7); gp.add(m);
  };
  if (look.v === 'ge') {
    const back = new THREE.Mesh(roundedBoxGeo(THREE, 25, 29, 2, 7), S(look.shoulder, 0.08, 0.5));
    gp.add(back);                                                 // grey outline plate
    const face = new THREE.Mesh(roundedBoxGeo(THREE, 23, 27, 2.2, 6), S(look.cover, 0.04, 0.5));
    face.position.z = 0.6; gp.add(face);                          // white panel face, front ≈ +1.7
    // LEFT: a physical START key carrying the console start symbol (not a screen)
    const sb = new THREE.Mesh(roundedBoxGeo(THREE, 6.6, 5.6, 1.8, 1.4), S(0xf2f5f7, 0.05, 0.4));
    sb.position.set(-5.6, 8.4, 2.1); gp.add(sb);
    const glyph = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 4.2), new THREE.MeshBasicMaterial({ map: makeStartGlyphTex(THREE), transparent: true }));
    glyph.position.set(-5.6, 8.4, 3.1); gp.add(glyph);
    // RIGHT: the LIVE scan / delay countdown timer display
    if (!liveScr.timer) liveScr.timer = mkScreen(THREE, 128, 64);
    const bez = new THREE.Mesh(roundedBoxGeo(THREE, 10.8, 5.8, 1.4, 1), S(0x252b31, 0.2, 0.45));
    bez.position.set(3.8, 8.4, 1.9); gp.add(bez);
    const tt = liveScr.timer.tex;
    const scrn = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 4.6), new THREE.MeshStandardMaterial({ map: tt, emissive: 0xffffff, emissiveMap: tt, emissiveIntensity: 0.9, roughness: 0.3 }));
    scrn.position.set(3.8, 8.4, 2.7); gp.add(scrn);
    const R = 6.4; for (let i = 0; i < 9; i++) { const a = i / 9 * Math.PI * 2 - Math.PI / 2; key(Math.cos(a) * R, -4.5 + Math.sin(a) * R, 1.15); }
    key(0, -4.5, 1.7);                                            // blue key ring + centre key (ref keypad)
    key(9.2, -1.5, 0.8); key(9.2, -7.5, 0.8);                     // two small side keys
  } else {
    // Canon Aquilion pad — NO plate at all: the screen and keys mount DIRECTLY on the gantry face
    // (perfectly flush, nothing to clip). The screen and every key row stay HORIZONTAL (parallel
    // to the floor); only the CLUSTER cascades diagonally down around the bore rim, hugging its
    // upper corner like the reference. Group origin = bore centre; `side` mirrors the layout.
    const sx = side;
    // each key gets a low collar disc so it reads as mounted on the face (which is gently domed here)
    const kkey = (x, y, r, color, glow) => {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.35, r + 0.55, 1.3, 36), S(0xe8ebee, 0.06, 0.5));
      base.rotation.x = Math.PI / 2; base.position.set(x, y, 0.65); gp.add(base);
      key(x, y, r, color, glow);
    };
    // LIVE 4-line readout — level, LATERAL of the bore's upper corner (the red stops sit medially,
    // flanking the crown module; the bore axis is the midline)
    if (!liveScr.panel) liveScr.panel = mkScreen(THREE, 168, 108);
    const bez = new THREE.Mesh(roundedBoxGeo(THREE, 15, 9.6, 2, 1), S(0x1c2126, 0.2, 0.45));
    bez.position.set(sx * 44, 40, 0.6); gp.add(bez);
    const tt = liveScr.panel.tex;
    const scrn = new THREE.Mesh(new THREE.PlaneGeometry(13.8, 8.6), new THREE.MeshStandardMaterial({ map: tt, emissive: 0xffffff, emissiveMap: tt, emissiveIntensity: 0.9, roughness: 0.3 }));
    scrn.position.set(sx * 44, 40, 1.75); gp.add(scrn);
    const GREY = 0x9aa4ad, WHITE = 0xf0f2f4, BLUE = 0x5aa7dc, GLOW = 0x2f7fc0;
    const K = [
      // grey utility rows BELOW the readout (clear of its bezel), stepping outward down the cascade
      [36.8, 32.5, 1.1, GREY], [40, 32.5, 1.1, GREY], [43.2, 32.5, 1.1, WHITE],
      [40.3, 28.7, 1.1, GREY], [43.5, 28.7, 1.15, BLUE, GLOW], [46.7, 28.7, 1.1, GREY],
      // table-motion cross at the bore's upper corner
      [49, 20.5, 1.35, BLUE, GLOW],
      [45.8, 16.5, 1.1, GREY], [49, 16.5, 1.2, WHITE], [52.2, 16.5, 1.1, GREY],
      [49, 12.5, 1.35, BLUE, GLOW],
      // lit-blue pairs finishing the cascade down the bore's side
      [48.3, 5, 1.25, BLUE, GLOW], [51.7, 5, 1.25, BLUE, GLOW],
      [47.3, 0, 1.25, BLUE, GLOW], [50.7, 0, 1.25, BLUE, GLOW],
    ];
    K.forEach(([x, y, r, c, gl]) => kkey(sx * x, y, r, c, gl));
  }
  return gp;
}
// Badge text (Optima / GE / Canon wordmarks) on a transparent plane.
function makeTextTex(THREE, txt, color) {
  const W = 256, H = 96, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H); g.fillStyle = color || '#6b7788'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'italic bold 60px Arial'; g.fillText(txt, W / 2, H / 2 + 3);
  return canvasTex(THREE, cv);
}
// GE-style console UI for the top module screen (numbers row / patient line / soft keys — ref).
function makeGEUITex(THREE) {
  const W = 256, H = 200, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
  g.fillStyle = '#24313e'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#31414f'; g.fillRect(0, 0, W, 26);
  g.font = 'bold 30px Arial'; g.textAlign = 'left';
  g.fillStyle = '#63e08c'; g.fillText('+', 14, 64); g.fillText('50.0', 40, 64);
  g.fillStyle = '#ffb347'; g.fillText('240.0', 40, 100);
  g.fillStyle = '#ffffff'; g.font = 'bold 24px Arial'; g.textAlign = 'right'; g.fillText('0.0°', W - 14, 64);
  g.textAlign = 'center'; g.font = '18px Arial'; g.fillStyle = '#cfe0ee'; g.fillText('John Smith', W / 2, 132);
  ['OM', 'XY', 'IC'].forEach((t, i) => {
    g.fillStyle = '#8fa3b8'; cvRoundRect(g, 30 + i * 70, 150, 56, 34, 6); g.fill();
    g.fillStyle = '#1d2731'; g.font = 'bold 20px Arial'; g.fillText(t, 58 + i * 70, 173);
  });
  return canvasTex(THREE, cv);
}
// Tiny green LED strip (panel mini-readouts + the module's secondary readout).
function makeMiniLedTex(THREE) {
  const W = 96, H = 40, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
  g.fillStyle = '#0c1810'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#5fe08a'; g.font = 'bold 24px "Courier New", monospace'; g.textAlign = 'right'; g.fillText('0.0', W - 10, 29);
  g.fillRect(8, 12, 10, 16); g.fillStyle = '#0c1810'; g.fillRect(11, 16, 4, 8);   // tiny icon block
  return canvasTex(THREE, cv);
}
// Canon's two-line "ONE / Aquilion" wordmark on a transparent plane (sized to fit — never clips).
function makeAquilionTex(THREE) {
  const W = 256, H = 128, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H); g.fillStyle = '#6f88ad'; g.textAlign = 'center';
  g.font = 'bold 36px Arial'; g.fillText('ONE', W / 2 + 34, 46);
  g.font = 'italic bold 44px Arial'; g.fillText('Aquilion', W / 2, 96);
  return canvasTex(THREE, cv);
}
// GE roundel badge (circle + monogram) on a transparent plane.
function makeGELogoTex(THREE) {
  const Wc = 128, cv = document.createElement('canvas'); cv.width = cv.height = Wc; const g = cv.getContext('2d');
  g.clearRect(0, 0, Wc, Wc); g.strokeStyle = '#5b7ca6'; g.fillStyle = '#5b7ca6';
  g.lineWidth = 7; g.beginPath(); g.arc(Wc / 2, Wc / 2, 52, 0, Math.PI * 2); g.stroke();
  g.font = 'italic bold 52px Georgia'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('GE', Wc / 2, Wc / 2 + 4);
  return canvasTex(THREE, cv);
}
// A recessed emissive screen (real content) inside a rounded 3D bezel.
function buildScreen(THREE, w, h, tex, bezMat, emiss) {
  const gp = new THREE.Group();
  gp.add(new THREE.Mesh(roundedBoxGeo(THREE, w + 4, h + 4, 2.6, 2), bezMat));
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: emiss == null ? 0.8 : emiss, roughness: 0.28, metalness: 0 }));
  scr.position.z = 1.45; gp.add(scr);
  return gp;
}
// LED numeric readout content (tilt / height / time), green-on-dark.
function makeLEDTex(THREE, look) {
  const W = 200, H = 108, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
  g.fillStyle = look.led; g.fillRect(0, 0, W, H);
  g.fillStyle = look.ledText; g.textAlign = 'right'; g.font = 'bold 26px "Courier New", monospace';
  ['+0.0', '+50.0', '0.0'].forEach((t, i) => g.fillText(t, W - 30, 32 + i * 30));
  g.textAlign = 'left'; g.font = '13px "Courier New", monospace';
  ['deg', 'mm', 'sec'].forEach((t, i) => g.fillText(t, 12, 32 + i * 30));
  return canvasTex(THREE, cv);
}
// Top-centre console screen content: vendor logo + model line on a blue UI.
function makeTopTex(THREE, look) {
  const W = 256, H = 180, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, look.screen1); grd.addColorStop(1, look.screen2);
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  g.textAlign = 'center'; g.fillStyle = '#ffffff'; g.font = 'bold 34px Arial'; g.fillText(look.brand, W / 2, 70);
  g.fillStyle = '#cfe6ff'; g.font = 'italic 22px Arial'; g.fillText(look.model, W / 2, 104);
  g.fillStyle = 'rgba(255,255,255,0.22)'; cvRoundRect(g, 44, 128, W - 88, 12, 6); g.fill();
  return canvasTex(THREE, cv);
}

function buildCouch(THREE, look) {
  const std = (c, m, r) => stdMat(THREE, c, m, r);
  // ---- pallet (moves): white plate, top surface at LOCAL y=0 (patient posterior rests here) ----
  const spec = tableSpec(), palLen = spec.cradleU, palW = spec.cradleWU;   // vendor cradle dimensions
  const ps = new THREE.Shape(); roundedRectShape(ps, palW, 3.4, 1.6);
  const palGeo = new THREE.ExtrudeGeometry(ps, { depth: palLen - 3, bevelEnabled: true, bevelThickness: 1.4, bevelSize: 1.4, bevelSegments: 9, curveSegments: 40 }); palGeo.computeVertexNormals();
  const pallet = new THREE.Mesh(palGeo, std(look.couchTop, 0.1, 0.45));
  pallet.position.set(0, -1.7, -50); couch.add(pallet);                 // rounded ends + edges; cantilevers into the bore
  const chan = new THREE.Mesh(roundedBoxGeo(THREE, palW - 14, 0.9, palLen - 12, 2), std(0xe3e7ea, 0.06, 0.6));
  chan.position.set(0, -0.35, (palLen - 103) / 2); couch.add(chan);   // centred on the pallet
  couch.visible = false;

  // ---- static base (Orbit PoV only, positioned in ctSyncScene): the reference's foot-end head
  // module (white wing the pallet slides through + grey handle plate + chrome arch + GE roundel),
  // on a pedestal column and a dark floor base ----
  const foot = FLOOR_Y;
  // Layout derived from the vendor spec: the base slab covers the cradle-foot travel band, and
  // the head module (white wing + grey handle plate + chrome arch + roundel) sits at the FOOT end
  // so at full extension the cradle foot parks exactly inside the module — the cradle can never
  // float unsupported past its holder. (couchBase sits at world z = 82; positions are local.)
  const thU = travelHalfU(), footLocal = palLen - 53;            // pallet local foot z (head fixed at −50)
  const wingZ = footLocal + thU - 90;                            // module centre: foot parks at its far edge
  const zLo = footLocal - thU - 100, zHi = footLocal + thU - 82; // slab span under the foot travel
  const slabLen = zHi - zLo, slabZ = (zLo + zHi) / 2, baseZ = wingZ - 44;
  const wingCol = look.v === 'canon' ? 0xc9c6bf : look.couchTop;   // Aquilion's head module is grey
  const plateCol = look.v === 'canon' ? 0xb2afa8 : look.trim;
  const slab = new THREE.Mesh(roundedBoxGeo(THREE, 50, 8, slabLen, 3), std(look.couchTop, 0.06, 0.55));
  slab.position.set(0, -10, slabZ); couchBase.add(slab);
  const wing = new THREE.Mesh(roundedBoxGeo(THREE, 62, 18, 16, 6), std(wingCol, 0.05, 0.5));
  wing.position.set(0, 1, wingZ); couchBase.add(wing);
  const plate = new THREE.Mesh(roundedBoxGeo(THREE, 44, 11, 13, 4), std(plateCol, 0.12, 0.45));
  plate.position.set(0, 12, wingZ - 1); couchBase.add(plate);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(14, 1.8, 24, 72, Math.PI), std(0xcdd4da, 0.55, 0.28));
  handle.position.set(0, 16, wingZ - 1); couchBase.add(handle);
  if (look.v === 'ge') {
    const lg = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshBasicMaterial({ map: makeGELogoTex(THREE), transparent: true }));
    lg.position.set(0, 12, wingZ + 6.5); couchBase.add(lg);
  }
  if (look.pedStyle === 'bellows') {
    // Canon / Toshiba: accordion bellows column + round foot
    const colTop = -8, colBot = foot + 14, colH = colTop - colBot, n = 10;
    const core = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, colH, 48), std(look.pedLight, 0.12, 0.55));
    core.position.set(0, (colTop + colBot) / 2, baseZ); couchBase.add(core);
    for (let i = 0; i < n; i++) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(10.6, 2.6, 32, 72), std(look.pedLight, 0.1, 0.6));
      rib.rotation.x = Math.PI / 2; rib.position.set(0, colBot + (i + 0.5) * colH / n, baseZ); couchBase.add(rib);
    }
    const base = new THREE.Mesh(new THREE.CylinderGeometry(17, 20, 8, 56), std(look.pedFoot, 0.18, 0.55));
    base.position.set(0, foot + 6, baseZ); couchBase.add(base);
    // floor rails either side of the base (Aquilion reference)
    [-1, 1].forEach(s => {
      const rail = new THREE.Mesh(roundedBoxGeo(THREE, 6, 4, 70, 2), std(look.pedFoot, 0.15, 0.55));
      rail.position.set(s * 26, foot + 2, baseZ); couchBase.add(rail);
    });
  } else {
    // GE: white pedestal box on a dark slate base with a light front cap (ref)
    const col = new THREE.Mesh(roundedBoxGeo(THREE, 34, 70, 60, 6), std(look.pedLight, 0.08, 0.5));
    col.position.set(0, -42, baseZ); couchBase.add(col);
    const base = new THREE.Mesh(roundedBoxGeo(THREE, 50, 18, 84, 6), std(look.pedFoot, 0.2, 0.5));
    base.position.set(0, foot + 9, baseZ); couchBase.add(base);
    const cap = new THREE.Mesh(roundedBoxGeo(THREE, 26, 13, 5, 4), std(0x9aa4ad, 0.15, 0.5));
    cap.position.set(0, foot + 10, wingZ); couchBase.add(cap);
  }
  couchBase.visible = false;
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
  const msi = ctx.$('ctMoveScanIcon'); if (msi) msi.innerHTML = SYM.moveScan;
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
  if (three.tube) three.tube.visible = !isCT;         // hide the x-ray tube head (CT has its own gantry tube)
  three.handGroup.rotation.y = 0;      // head-first only — no patient flip
  if (isCT) {
    const py = ctPatientY();
    S.ct.patientY = py;                                 // buildPhantom bakes this y
    // patient rides the couch: table height in y, direction-pad offset in x/z. The
    // scan animation later drives couch.position.z + handGroup.position.z directly.
    three.handGroup.position.x = S.ct.patient.x;
    three.handGroup.position.y = py;
    three.handGroup.position.z = S.ct.patient.z;
    // pad sits at the patient's posterior surface so the whole model rests ON the table
    // (little/no clipping) while the isocentre still runs through mid-body: for a voxel
    // model that's its lower AP extent (half its AP depth); the analytic hand uses ~0.4.
    const backDrop = S.voxelModel ? (S.voxelModel.extentMM[1] / 2) / MM_PER_UNIT : 0.4;
    couch.position.y = py - backDrop;
    // the patient LIES ON the couch — they are one rigid body: the couch tracks the
    // patient in x (lateral) and z (in/out) so they always move together.
    couch.position.x = S.ct.patient.x;
    couch.position.z = S.ct.patient.z;
    // gantry + lasers stay fixed at the isocentre (only the couch + patient move)
    gantry.position.set(0, 0, 0);
    // vendor exterior (cover / panels / pedestal) is heavy detail worth showing only in the free
    // Orbit PoV — the AP / Lat planning views sit inside the bore and keep the bare framing ring.
    const orbit = S.ct.pov === 'orbit';
    if (gantryShell) gantryShell.visible = orbit;
    if (boreFrameRing) boreFrameRing.visible = !orbit;   // bare ring only where the housing is hidden
    if (couchBase) { couchBase.visible = orbit; couchBase.position.set(S.ct.patient.x, 0, 82); }
    laserTop.position.set(0, ISO_Y + BORE_R + 8, 0); laserTop.target.position.set(0, ISO_Y, 0);
    laserTop.target.updateMatrixWorld();
    laserSide.position.set(BORE_R + 8, ISO_Y, 0); laserSide.target.position.set(0, ISO_Y, 0);
    laserSide.target.updateMatrixWorld();
    // no collimator light field in CT — only the lasers
    three.lamp.intensity = 0; three.lamp.castShadow = false;
    three.cr.visible = false;
    three.amb.intensity = 1.55; three.key.intensity = 1.35;   // brighter — the big rig read too dark
  } else {
    // x-ray mode: honour the object offset sliders (syncScene runs first; don't zero them)
    three.handGroup.position.x = S.objOff ? S.objOff.x : 0;
    three.handGroup.position.z = S.objOff ? S.objOff.z : 0;
    if (couchBase) couchBase.visible = false;
  }
  updateScanMarkers();
}

// Position the scan-range markers: green line at the scan start, red at the end, an
// orange arrow between them in the couch-feed direction. The scan images world z 0→
// lenU when the patient sits at isoZ, so at the current rest position the range is
// offset by (patient.z − isoZ). Purely a usability aid (not physical).
function updateScanMarkers() {
  // scan start/end lines + direction arrow removed from the 3D view (kept as a no-op so
  // the existing call sites don't need to change).
  if (scanMarkers) scanMarkers.visible = false;
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
  stopGantrySpin(); setBusy(false); Sound.stopScan();
  stopTableMove(); showScanBoxes(false); resetScanBox(); showPreviewBadge(false);
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
  ctApplyColorTheme();                            // x-ray drops any vendor theme; CT re-applies it
  const bar = ctx.$('modeBar');
  if (bar) [...bar.querySelectorAll('button')].forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  const tag = document.querySelector('.baytag .s');
  if (tag) tag.textContent = mode === 'ct' ? 'CT · transverse acquisition' : 'Digit · Hand phantom';
  const imgBtn = ctx.$('contentImageBtn');   // the Image view is the Planning window in CT
  if (imgBtn) imgBtn.textContent = mode === 'ct' ? 'Planning' : 'Image';
  const consoleLbl = ctx.$('consoleLbl');    // x-ray generator vs CT console
  if (consoleLbl) consoleLbl.textContent = mode === 'ct' ? 'CONSOLE' : 'GENERATOR';
  // A mode switch is a clean slate: tear down the CT scout workflow and any carried
  // view state so nothing from the other mode lingers (stale image, scout overlay,
  // tube-POV camera, Image view). Acquisition params + technique are user setup and
  // deliberately persist.
  resetCTSession();
  // every subject must be zeroed (isocentre button) before scanning — start un-zeroed
  ctx.S.ct.isocentred = false;
  if (mode === 'ct' && ctx.S.voxelModel) ctx.S.ct.isoZ = (ctx.S.voxelModel.extentMM[2] / 2) / 10;
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
  // protocol picker — sets predetermined scout start/end + isocentre landmark
  $('ctProtocolBtn')?.addEventListener('click', () => openProtocolPopup());
  $('ctScanHelp')?.addEventListener('click', () => openScanHelp());
  // table height — raise / lower by 1 mm per press; hold to auto-repeat
  wireHoldRepeat($('ctTablePad'), 'button[data-th]', (b) => {
    const hl = tableYLimits();                        // spec ceiling: cradle top ≤ 991 mm above floor
    S.ct.tableY = Math.max(hl.lo, Math.min(hl.hi, S.ct.tableY + (b.dataset.th === 'up' ? 1 : -1)));
    ctx.syncScene(); updateCTReadouts();
  });
  // isocentre confirm — zero the table position reading (patient stays put)
  $('ctIsocentre')?.addEventListener('click', () => {
    if (S.ct.phase !== 'idle') return;   // zeroing only makes sense during scouting
    S.ct.tablePos = 0; S.ct.isoZ = S.ct.patient.z; S.ct.isocentred = true;
    setHint('Table zeroed at the anatomic landmark — press MOVE TO SCAN to travel to the scout start.');
    updateCTReadouts(); updateConsoleFlash();
  });
  // Move to Scan — glide the couch (momentum + motor sound, mirrored into the monitor)
  // to the scan-start location so the table position equals the scan start. REQUIRED
  // before START in BOTH phases: the scout start while scouting (idle), the scan-box
  // start while planning. It flashes once zeroed and hands the flash to START on arrival.
  $('ctMoveScan')?.addEventListener('click', () => {
    const c = S.ct;
    if (c.phase !== 'idle' && c.phase !== 'planning') { setHint('Zero the table, then move to the scan start.'); return; }
    if (!c.isocentred) { flashIso(); setHint('Zero the table first — press the Zero Table button.'); return; }
    setHint('Moving the table to the scan start…');
    moveTableTo(moveScanTarget()).then(() => {
      updateConsoleFlash();
      setHint(atMoveTarget()
        ? (c.phase === 'idle' ? 'Table at scout start — press START to acquire scouts.' : 'Table at scan start — ready to scan.')
        : 'Table moving…');
    });
  });
  // direction pad — nudge the patient/couch (10 mm/press); hold to auto-repeat
  const STEP = 1;                       // world unit per press (= 10 mm)
  wireHoldRepeat($('ctDpad'), 'button[data-dir]', (b) => {
    // lateral limit = the tighter of bore clearance and the vendor spec (GE: no lateral
    // movement at all; Canon/Toshiba Lateral Slide: ±85 mm)
    const p = S.ct.patient, dmm = STEP * MM_PER_UNIT, xLim = Math.min(maxPatientX(), tableSpec().latMM / MM_PER_UNIT);
    switch (b.dataset.dir) {
      // in/out clamps to the physical cradle travel (vendor spec); the readout is derived from
      // the clamped position (tablePos ≡ (isoZ − z)·10) so it stays drift-free
      case 'up':   { const nz = clampPatientZ(p.z - STEP);
                     if (nz === p.z) setHint('Table at its physical travel limit (' + tableSpec().travelMM + ' mm).');
                     p.z = nz; S.ct.tablePos = (S.ct.isoZ - nz) * MM_PER_UNIT; break; }   // into the gantry (+I)
      case 'down': { const nz = clampPatientZ(p.z + STEP);
                     if (nz === p.z) setHint('Table at its physical travel limit (' + tableSpec().travelMM + ' mm).');
                     p.z = nz; S.ct.tablePos = (S.ct.isoZ - nz) * MM_PER_UNIT; break; }   // out (-S)
      case 'left':  p.x = Math.max(-xLim, p.x - STEP); break;   // clamp so the couch clears the bore
      case 'right': p.x = Math.min(xLim, p.x + STEP); break;
    }
    S.ct.isocentred = false;
    ctx.syncScene(); updateCTReadouts(); updateConsoleFlash();
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
  renderProtocol();
  renderScoutTable();
  const et = scoutScanTime();
  set('ctExpTimeV', (et < 10 ? et.toFixed(1) : Math.round(et)) + ' s');
  set('ctTablePosV', fmtTablePos(S.ct.tablePos));
  // Scan extent readouts. Before planning the scan spans the scout range (scanStart ->
  // scanStart+length, both landmark-relative); during planning updatePlan() drives
  // these from the scan-box edges.
  if (S.ct.phase !== 'planning') {
    set('ctScanStartV', fmtTablePos(scanStartMM()) + ' mm');
    set('ctScanEndV', fmtTablePos(scanStartMM() + S.ct.scanLen) + ' mm');
  }
  const th = Math.round(S.ct.tableY);   // nearest mm, no decimals
  set('ctTableHV', (th > 0 ? '+' : '') + th + ' mm' + (th === 0 ? ' · centred' : ''));
  // scan start/end read RED until the table is zeroed (isocentre set)
  ['ctScanStartV', 'ctScanEndV'].forEach((id) => { const el = $(id); if (el) el.classList.toggle('unzeroed', !S.ct.isocentred); });
  // the Zero Table button asks to be pressed only while scouting (idle) and un-zeroed
  $('ctIsocentre')?.classList.toggle('needzero', !S.ct.isocentred && S.ct.phase === 'idle');
  updateGantryDisplays();                       // mirror the readouts onto the 3D gantry screens
}
// one-shot emphasis on the isocentre button when a scan is attempted un-zeroed
function flashIso() {
  const b = ctx.$('ctIsocentre'); if (!b) return;
  b.classList.remove('flashiso'); void b.offsetWidth; b.classList.add('flashiso');
  setTimeout(() => b.classList.remove('flashiso'), 1400);
}

function setHint(t) { const el = ctx.$('ctHint'); if (el) el.textContent = t; }
// Reconstruction progress bar under the console hint. frac in [0,1]; null hides it.
function setProgress(frac) {
  const box = ctx.$('ctProg'), bar = ctx.$('ctProgBar'); if (!box || !bar) return;
  if (frac == null) { box.style.display = 'none'; bar.style.width = '0%'; return; }
  box.style.display = ''; bar.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
}

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
    if (S.ct.phase === 'idle') {
      // scout workflow: dpad → Zero Table → Move to Scan → START
      if (!S.ct.isocentred) { flashIso(); setHint('Zero the table first — press the Zero Table button.'); return; }
      if (!atMoveTarget()) { setHint('Move the table to the scout start first — press the flashing MOVE TO SCAN button.'); return; }
      acquireScouts();
    } else if (S.ct.phase === 'planning') {
      if (ctx.$('ctStart').classList.contains('flash')) runScan();
      else if (ctx.$('ctTable').classList.contains('flash')) setHint('Reposition the table first (hold the orange TABLE button).');
      else setHint('Move the table to the scan start first — press the flashing MOVE TO SCAN button.');
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
  // idle + planning drive the Move-to-Scan / START flash from the table position;
  // transient phases (scout/moving/scanning/done) flash nothing
  if (p !== 'planning') { S.ct.moveBlit = null; showTableReminder(false); }
  updateConsoleFlash();
  // zeroing the table only makes sense while scouting — once scouts are being/have been
  // acquired the Zero Table button is disabled (and can no longer flash)
  const iso = $('ctIsocentre');
  if (iso) { iso.disabled = (p !== 'idle'); if (iso.disabled) iso.classList.remove('needzero', 'flashiso'); }
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
  stopGantrySpin(); setBusy(false); Sound.stopScan(); Sound.stopTableSound();
  stopTableMove(); showScanBoxes(false); showPreviewBadge(false);
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
  resetToScanStart();                 // compute the scouts from the SCOUT START (not the isocentre)
  let ap, lat;
  try {
    ap = await scoutProjection('AP');
    lat = await scoutProjection('LAT');
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

// Table-position ↔ patient-z mapping (after zeroing, tablePos = (isoZ − patient.z)·MM).
function tablePosToPatientZ(tp) { return ctx.S.ct.isoZ - tp / MM_PER_UNIT; }
// Put the patient/couch back at the isocentre (table 0) before an acquisition.
function resetToIsocentre() {
  const { S } = ctx;
  S.ct.patient.z = S.ct.isoZ;   // model back to where it was when the isocentre was set
  S.ct.tablePos = 0;
  ctx.syncScene();               // applies patient.z, resets the bed
  updateCTReadouts();
}
// Position the patient/couch at the SCOUT start (the topogram's superior edge) so the
// scout physically begins there (e.g. S120 above a sternal-notch zero), not at the
// isocentre. This is why Move to Scan must run before the scout is acquired.
function resetToScanStart() {
  const { S } = ctx;
  S.ct.patient.z = clampPatientZ(tablePosToPatientZ(scanStartMM()));   // physical travel limit
  S.ct.tablePos = (S.ct.isoZ - S.ct.patient.z) * MM_PER_UNIT;          // readout follows the couch
  ctx.syncScene();
  updateCTReadouts();
}
// Largest lateral (x) offset that keeps the couch clear of the bore wall: the bore is a
// cylinder of radius BORE_R about the isocentre; at the couch's height the horizontal
// clearance is √(BORE_R² − Δy²), and the couch half-width + a margin must fit inside it.
function backDropU() { return ctx.S.voxelModel ? (ctx.S.voxelModel.extentMM[1] / 2) / MM_PER_UNIT : 0.4; }
function maxPatientX() {
  const COUCH_HALF = 25, MARGIN = 1.5;                 // couch rail half-width (world units)
  const yc = ctPatientY() - backDropU();               // couch surface height
  const clr = Math.sqrt(Math.max(0, BORE_R * BORE_R - (ISO_Y - yc) * (ISO_Y - yc)));
  return Math.max(0, clr - COUCH_HALF - MARGIN);
}

// One animated acquisition: breathe-in, 1s hold, exposure (buzz + table travel
// while the topogram stitches in), breathe-out. The exposure sound + table travel
// + row-by-row stitching all run for the calculated exposure time.
async function runScoutExposure(view, data, alive = () => true) {
  const cv = ctx.$(view === 'AP' ? 'scoutAP' : 'scoutLAT');
  ctx.setCTPov(view === 'AP' ? 'ap' : 'lat');   // watch each pass from its own perspective
  Sound.resume();
  resetToScanStart();                                      // each pass begins at the scout start
  drawScout(cv, data, 0);                                   // start from a blank field
  setHint(view + ' scout · breathe in and hold…');
  startPanelTimer((Sound.duration('breathIn') || 2) + 1);   // panel timer counts the pre-exposure delay
  Sound.play('breathIn');
  await sleep((Sound.duration('breathIn') || 2) * 1000);   // let the breathe-in finish
  if (!alive()) return;
  await sleep(1000);                                        // 1 s hold before the exposure
  if (!alive()) return;
  setHint(view + ' scout · scanning…');
  startPanelTimer(scoutScanTime());                          // panel timer counts down the scout duration
  Sound.startScan(ctx.S.ct.scanSound);
  // stitch rows 0..t as the couch advances -> image builds in lockstep with travel
  await animateTableTravel(scoutScanTime() * 1000, (t) => drawScout(cv, data, t * data.nz), alive);
  Sound.stopScan();
  if (!alive()) return;
  stopPanelTimer();
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
    const startPatZ = S.ct.patient.z;                  // begins at the scout start (Move to Scan put it there)
    const tpEnd = S.ct.scanLen;                        // mm, inferior (+I)
    const t0 = performance.now();
    let done = false;
    const apply = (t) => {
      const dz = -travelU * t;                         // travel into the bore (-z)
      S.ct.patient.z = clampPatientZ(startPatZ + dz);  // patient + couch feed as one rigid body (travel-limited)
      three.handGroup.position.z = S.ct.patient.z;
      couch.position.z = S.ct.patient.z;               // gantry stays fixed
      S.ct.tablePos = scanStartMM() + tpEnd * t;       // live table position (landmark-relative)
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

// Glide the patient+couch to a specific table position (mm) with the motor sound — used
// by "Move to Scan". Drives patient.z (the single source of truth), so the physical
// position actually changes (the scout/scan then begins there); the couch tracks it.
let movingToScan = false;
function moveTableTo(targetMM, dur = null) {
  const three = ctx.three, S = ctx.S;
  if (movingToScan || S.ct.phase === 'scanning' || S.ct.phase === 'scouting') return Promise.resolve();
  return new Promise(res => {
    // clamp to the physical cradle travel, and glide at the spec Move-to-Scan speed (150 mm/s)
    const startPatZ = S.ct.patient.z, endPatZ = clampPatientZ(tablePosToPatientZ(targetMM));
    const distMM = Math.abs(endPatZ - startPatZ) * MM_PER_UNIT;
    if (dur == null) dur = Math.max(700, distMM / tableSpec().moveSpeedMMPS * 1000);
    if (Math.abs(endPatZ - startPatZ) < 1e-3) { res(); return; }
    movingToScan = true;
    // mirror the couch glide into the DR monitor (lateral PoV) so the model is visibly
    // moving even from the scan-planning (Image) view — same mechanism as TABLE reposition
    S.ct.moveBlit = 'lat';
    const noexp = ctx.$('noexp'); if (noexp) noexp.style.display = 'none';
    ctx.Sound && ctx.Sound.startTableSound && ctx.Sound.startTableSound(1.0);
    const t0 = performance.now(); let done = false;
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const finish = () => { if (done) return; done = true; ctx.Sound && ctx.Sound.stopTableSound && ctx.Sound.stopTableSound(); movingToScan = false; S.ct.moveBlit = null; res(); };
    const snap = (e) => {
      S.ct.patient.z = startPatZ + (endPatZ - startPatZ) * e;
      three.handGroup.position.z = S.ct.patient.z; couch.position.z = S.ct.patient.z;   // patient + couch move as one
      S.ct.tablePos = (S.ct.isoZ - S.ct.patient.z) * MM_PER_UNIT; updateCTReadouts();
    };
    (function step() {
      if (done) return;
      const t = Math.min(1, (performance.now() - t0) / dur);
      snap(ease(t));
      if (t < 1) requestAnimationFrame(step); else finish();
    })();
    // fallback if rAF is throttled (background tab): snap to the target, then finish
    setTimeout(() => { if (!done) { snap(1); finish(); } }, dur + 600);
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
async function scoutProjection(view) {
  const { S } = ctx;
  const phantom = ctx.buildPhantom();               // CT patient (offset baked in CT mode)
  const tech = S.ct.scoutTech[view === 'AP' ? 0 : 1];   // per-plane technique (AP 0° / Lat 90°)
  const bins = Spectrum.make(tech.kv).bins, nb = bins.length;
  const voxel = !!phantom.voxel;                    // chest (voxel) vs hand (analytic) attenuation
  const muMat = voxel ? muOverBins(bins) : null, nmat = voxel ? muMat.length : 0;
  const hitId = voxel ? new Int32Array(nmat) : null, hitLen = voxel ? new Float64Array(nmat) : null;
  const muSoft = voxel ? null : bins.map(b => Materials.mu('soft', b.E));
  const muBone = voxel ? null : bins.map(b => Materials.mu('bone', b.E));
  const muMarr = voxel ? null : bins.map(b => Materials.mu('marrow', b.E));
  const I0 = tech.ma * Math.pow(tech.kv / 70, 2);
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
  // ---- Python GPU scout (voxel subjects) ----
  if (voxel && S.ct.backend === 'python' && S.computeInfo && ctx.compute) {
    try {
      const center = [(phantom.min[0] + phantom.max[0]) / 2, (phantom.min[1] + phantom.max[1]) / 2,
                      (phantom.min[2] + phantom.max[2]) / 2];
      const out = await ctx.compute.ctScout({
        model: S.subject, flips: Array.from(phantom.flip, Boolean), center,
        nw, nz, pxU, lenU, sx, sy, dcx, dcy, ux, uy,
        binsW: bins.map(b => b.w), muMat: muMat.map(r => Array.from(r)), I0,
        rot: phantom.rot ? Array.from(phantom.rot) : null,
      });
      dose.set(out);
      for (let k = 0; k < dose.length; k++) { const d = dose[k]; if (d < mn) mn = d; if (d > mx) mx = d; }
      const floor = Math.max(mn, mx * 1e-12) || 1e-12;
      const ps = new Float32Array(dose.length);
      for (let k = 0; k < ps.length; k++) ps[k] = Math.log(mx / Math.max(dose[k], floor));
      const sorted = Float32Array.from(ps).sort();
      const pmax = Math.max(sorted[Math.min(ps.length - 1, Math.floor(ps.length * 0.997))], 1e-3);
      return { dose, nw, nz, mn, mx, pmax };
    } catch (err) {
      if (phantom.geometryOnly) throw new Error('Scout needs the Python GPU backend: ' + err.message);
      console.warn('GPU scout failed — falling back to the browser engine', err);
      mn = Infinity; mx = -Infinity;   // reset; the local loop recomputes below
    }
  }
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
  // The LATERAL scout is rotated 90° so the patient LONG axis (scan length, z) runs
  // HORIZONTALLY (start/superior at the left, table feed = left→right) and the
  // anterior-posterior depth runs vertically. The AP scout stays portrait (long axis
  // vertical). This lets the reposition buttons read naturally: AP left/right = medio-
  // lateral, LAT up/down = anterior/posterior, with the table-feed axis handled by the
  // box drag in each view.
  const rotated = cv.id === 'scoutLAT';
  const lim = rowLimit == null ? nz : Math.max(0, Math.min(nz, Math.round(rowLimit)));
  const outW = rotated ? nz : nw, outH = rotated ? nw : nz;
  if (cv.width !== outW || cv.height !== outH) { cv.width = outW; cv.height = outH; }
  const g = cv.getContext('2d');
  const img = g.createImageData(outW, outH);
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
  for (let j = 0; j < lim; j++) {                    // j = scan-length index (0 = start/superior)
    for (let i = 0; i < nw; i++) {                   // i = cross index (mediolateral AP / depth LAT)
      const p = Math.min(1, Math.log(mx / Math.max(dose[j * nw + i], floor)) / pmax);   // 0 open … 1 dense (clip white)
      const v = Math.round(255 * Math.pow(p, GAMMA));
      const ox = rotated ? j : i;                    // LAT: scan length → x (left = start)
      // LAT depth → y, flipped so the ANTERIOR side is at the top (posterior at the bottom
      // for a supine patient); AP: scan length → y (top = start).
      const oy = rotated ? (nw - 1 - i) : j;
      const o = (oy * outW + ox) * 4;
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
  const cs = getComputedStyle(row);
  const colGap = parseFloat(cs.columnGap || cs.gap) || 16;
  const hdr = box.querySelector('.scouthdr');
  const hdrH = (hdr ? hdr.offsetHeight : 18) + 6;      // header + column inner gap
  const availW = Math.max(40, row.clientWidth - colGap);
  const availH = Math.max(40, row.clientHeight - hdrH); // the scoutrow's own height (table sits below)
  // Both scout windows are the SAME square (capped by the available height so they never
  // clip into the scan-group table below). Each image (AP landscape, rotated LATERAL
  // portrait) is letterboxed inside its square via .scoutfit, which the scan boxes are
  // positioned within; the blank padding hosts the overlaid reposition buttons.
  const S = Math.max(40, Math.floor(Math.min(availH, availW / 2)));
  const place = (cv) => {
    const wrap = cv.closest('.scoutwrap'), fit = cv.parentElement;
    if (!wrap || !fit) return;
    wrap.style.width = S + 'px'; wrap.style.height = S + 'px';
    const ar = (cv.width || 1) / (cv.height || 1);   // native image aspect (already rotated for LAT)
    let w = S, h = S / ar; if (h > S) { h = S; w = S * ar; }
    fit.style.width = Math.round(w) + 'px'; fit.style.height = Math.round(h) + 'px';
  };
  place(ap); place(lat);
  applyScoutXform('ap'); applyScoutXform('lat');   // keep any active zoom/pan across relayout
}
// ---- scout zoom + pan ----
// The transform is applied to the .scoutfit (which holds the image AND the scan/recon boxes), so
// they zoom/pan together; the reposition buttons live on the .scoutwrap and stay put. overflow:
// hidden on the wrap clips the zoomed image.
const scoutZoom = { ap: { z: 1, px: 0, py: 0 }, lat: { z: 1, px: 0, py: 0 } };
function applyScoutXform(view) {
  const fit = ctx.$(view === 'ap' ? 'fitAP' : 'fitLAT'); if (!fit) return;
  const s = scoutZoom[view];
  fit.style.transformOrigin = '0 0';
  fit.style.transform = s.z === 1 ? '' : ('translate(' + s.px + 'px,' + s.py + 'px) scale(' + s.z + ')');
}
function wireScoutZoom() {
  ['ap', 'lat'].forEach(view => {
    const wrap = ctx.$(view === 'ap' ? 'wrapAP' : 'wrapLAT'), fit = ctx.$(view === 'ap' ? 'fitAP' : 'fitLAT');
    if (!wrap || !fit) return;
    wrap.addEventListener('wheel', (e) => {              // wheel = zoom, anchored at the cursor
      e.preventDefault(); const s = scoutZoom[view], r = fit.getBoundingClientRect();
      const lx = (e.clientX - r.left) / s.z, ly = (e.clientY - r.top) / s.z;   // fit-local point under cursor
      const nz = clampV(s.z * (e.deltaY < 0 ? 1.18 : 1 / 1.18), 1, 6);
      const fitLeft0 = r.left - s.px, fitTop0 = r.top - s.py;                    // untransformed top-left
      s.px = e.clientX - fitLeft0 - lx * nz; s.py = e.clientY - fitTop0 - ly * nz; s.z = nz;
      if (nz === 1) { s.px = 0; s.py = 0; }
      applyScoutXform(view);
    }, { passive: false });
    wrap.addEventListener('pointerdown', (e) => {         // drag empty image area = pan (only when zoomed)
      if (e.target.closest('.scanbox, .reconbox, .reposcluster, .eh')) return;   // boxes/handles/buttons keep their drag
      const s = scoutZoom[view]; if (s.z <= 1) return;
      e.preventDefault(); try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
      const start = { x: e.clientX, y: e.clientY, px: s.px, py: s.py };
      const move = (ev) => { s.px = start.px + (ev.clientX - start.x); s.py = start.py + (ev.clientY - start.y); applyScoutXform(view); };
      const up = () => { wrap.removeEventListener('pointermove', move); wrap.removeEventListener('pointerup', up); wrap.removeEventListener('pointercancel', up); };
      wrap.addEventListener('pointermove', move); wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', up);
    });
    wrap.addEventListener('dblclick', () => { scoutZoom[view] = { z: 1, px: 0, py: 0 }; applyScoutXform(view); });   // reset
  });
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
const DEL_MM = 0.625;                             // detector element (DEL) size — FIXED (a physical property)
const ELEMENTS = [DEL_MM];                        // beam collimation = rows × DEL (one collimation per row count)
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
// Slice thickness + interval live on the RECONSTRUCTIONS (the recon table), not the acquisition.
// The base transverse volume is reconstructed at the FINEST recon it must serve, and thicker
// recons are reformatted from it. The detector element is the physical thickness floor.
function groupBaseThk(g) { const el = acqThkOf(g); return Math.max(el, Math.min(...groupRecons(g).map((r) => Math.max(r.thk || el, el)))); }
function groupBaseInterval(g) { return Math.max(0.1, Math.min(...groupRecons(g).map((r) => r.interval || 5))); }
function groupImages(g) { return Math.max(1, Math.round(groupScanLenMM(g) / groupBaseInterval(g))); }
// scan time = scan length / (table feed per second); feed/s = tableSpeed(mm/rot) / rotSpeed(s/rot)
function groupExpTime(g) { const feed = Math.max(tableSpeedOf(g), 1e-3); return (groupScanLenMM(g) / feed) * g.rotSpeed; }

function defaultGroups() {
  // Default acquisition is SSCT (single detector row) → beam collimation = 1 × 0.625 mm DEL.
  // Switching to MSCT restores a multi-row default (see ctApplyAcqMode).
  const sf = defaultSfov();
  const base = { detRows: 1, beamColl: DEL_MM, pitch: 0.938, rotSpeed: 0.5, sfovMM: sf.mm, sfovName: sf.name };
  return [
    { on: true,  vis: true, box: { top: 0.10, bot: 0.90, apL: 0.28, apR: 0.72, latL: 0.28, latR: 0.72 }, kv: 120, ma: 295, sliceThk: 5,    ...base, interval: 5,    tilt: 0, delay: 0 },
    { on: false, vis: true, box: { top: 0.14, bot: 0.50, apL: 0.36, apR: 0.64, latL: 0.36, latR: 0.64 }, kv: 120, ma: 295, sliceThk: 2.5,  ...base, interval: 2.5,  tilt: 0, delay: 0 },
    { on: false, vis: true, box: { top: 0.55, bot: 0.86, apL: 0.36, apR: 0.64, latL: 0.36, latR: 0.64 }, kv: 120, ma: 295, sliceThk: 1.25, ...base, interval: 1.25, tilt: 0, delay: 0 },
    { on: false, vis: true, box: { top: 0.30, bot: 0.70, apL: 0.40, apR: 0.60, latL: 0.40, latR: 0.60 }, kv: 120, ma: 295, sliceThk: 5,    ...base, interval: 5,    tilt: 0, delay: 0 },
  ];
}

function initScanBoxes() {
  buildGroupBoxes('fitAP', 'ap');
  buildGroupBoxes('fitLAT', 'lat');
  document.querySelectorAll('#ctScouts .reconbox').forEach((el) => wireReconBox(el, el.dataset.view));
  wireScanGroupTable();
  wireReconPlan();
  wireReposButtons();
}
// one DOM box per group per scout (shown/positioned per group in renderScanBoxes)
function buildGroupBoxes(wrapId, view) {
  const wrap = ctx.$(wrapId); if (!wrap) return;
  for (let gi = 0; gi < N_GROUPS; gi++) {
    const box = document.createElement('div');
    box.className = 'scanbox gc' + gi; box.dataset.group = gi; box.dataset.view = view;
    box.innerHTML = '<div class="slices"></div>' +
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
  const reconSel = (c.activeRecon != null && c.activeRecon >= 0);
  document.querySelectorAll('#ctScouts .scanbox').forEach((el) => {
    const gi = +el.dataset.group, view = el.dataset.view, g = grp(gi);
    const shown = g.on && gi === c.activeGroup;   // only the SELECTED scan group's box shows
    el.classList.toggle('shown', shown);
    el.classList.toggle('active', shown);
    if (!shown) return;
    // AP: scan length (top/bot) → vertical, cross axis (apL/apR) → horizontal.
    // LAT (rotated): scan length (top/bot) → horizontal, depth (latL/latR) → vertical.
    if (view === 'ap') {
      el.style.left = (g.box.apL * 100) + '%'; el.style.width = ((g.box.apR - g.box.apL) * 100) + '%';
      el.style.top = (g.box.top * 100) + '%'; el.style.height = ((g.box.bot - g.box.top) * 100) + '%';
    } else {
      el.style.left = (g.box.top * 100) + '%'; el.style.width = ((g.box.bot - g.box.top) * 100) + '%';
      el.style.top = (g.box.latL * 100) + '%'; el.style.height = ((g.box.latR - g.box.latL) * 100) + '%';
    }
    // per-slice dotted scan lines — toggled by the group's Show button; hidden while a
    // recon is selected (reduce clutter)
    const sl = el.querySelector('.slices'), lenMM = groupScanLenMM(g), gInterval = groupBaseInterval(g);
    const period = lenMM > 0 ? (gInterval / lenMM) * 100 : 100;
    if (g.vis && !reconSel && period >= 0.7 && gInterval > 0) {
      const dir = view === 'ap' ? 'to bottom' : 'to right';
      sl.style.backgroundImage = 'repeating-linear-gradient(' + dir + ', var(--gc) 0, var(--gc) 1px, transparent 1px, transparent ' + period.toFixed(3) + '%)';
      sl.style.opacity = '0.55';
    } else { sl.style.backgroundImage = 'none'; }
  });
  renderReconBoxes();
  renderSfovLines();
}
// The active recon's sub-area box within the active scan group — draggable (move + resize
// along the scan axis) like the scan box, with a plane indicator (↔ / ⊗) in the middle.
function renderReconBoxes() {
  const c = ctx.S.ct, g = grp(c.activeGroup || 0);
  const recons = (g && g.on && c.phase === 'planning') ? groupRecons(g) : null;
  const r = (recons && c.activeRecon != null && c.activeRecon >= 0) ? recons[c.activeRecon] : null;
  document.querySelectorAll('#ctScouts .reconbox').forEach((el) => {
    el.classList.toggle('shown', !!r);
    if (!r) return;
    const view = el.dataset.view;
    const gT = g.box.top, gB = g.box.bot, t0 = gT + r.subTop * (gB - gT), t1 = gT + r.subBot * (gB - gT);
    if (view === 'ap') {
      el.style.left = (g.box.apL * 100) + '%'; el.style.width = ((g.box.apR - g.box.apL) * 100) + '%';
      el.style.top = (t0 * 100) + '%'; el.style.height = ((t1 - t0) * 100) + '%';
    } else {
      el.style.left = (t0 * 100) + '%'; el.style.width = ((t1 - t0) * 100) + '%';
      el.style.top = (g.box.latL * 100) + '%'; el.style.height = ((g.box.latR - g.box.latL) * 100) + '%';
    }
    el.querySelector('.rb-ind').innerHTML = reconIndicator(r.plane, view);
  });
}
// Plane indicators. The double-arrow points along the direction the recon's slices ADVANCE
// (its through-plane axis) as seen in that scout; when that axis is perpendicular to the scout
// it reads as a circled-X. Advance axis: transverse → I/S (z), coronal → A/P (y), sagittal → L/R (x).
// Scout axes: AP scout → horizontal = L/R (x), vertical = I/S (z); LATERAL → horizontal = I/S (z),
// vertical = A/P (y). So e.g. a coronal recon shows a VERTICAL (A/P) arrow on the lateral scout and
// a circled-X on the AP scout; a transverse recon shows an I/S arrow on both (vertical on AP,
// horizontal on lateral).
const RB_ARROW = '<svg viewBox="0 0 40 16" width="34" height="14"><path fill="none" stroke="#ffcf7a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M8 8H32M8 8l4-4M8 8l4 4M32 8l-4-4M32 8l-4 4"/></svg>';
const RB_XCIRC = '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="9" fill="none" stroke="#ffcf7a" stroke-width="2"/><path stroke="#ffcf7a" stroke-width="2" stroke-linecap="round" d="M8 8l8 8M16 8l-8 8"/></svg>';
const rbArrow = (vert) => RB_ARROW.replace('<svg ', '<svg style="transform:rotate(' + (vert ? 90 : 0) + 'deg)" ');
function reconIndicator(plane, view) {
  const adv = plane === 'coronal' ? 'y' : plane === 'sagittal' ? 'x' : 'z';   // slice-advance axis
  const H = view === 'ap' ? 'x' : 'z';   // this scout's horizontal axis
  const V = view === 'ap' ? 'z' : 'y';   // this scout's vertical axis
  if (adv === H) return rbArrow(false);  // arrow along the scout's horizontal
  if (adv === V) return rbArrow(true);   // arrow along the scout's vertical
  return RB_XCIRC;                        // advance axis is perpendicular to this scout
}
function wireReconBox(box, view) {
  box.addEventListener('pointerdown', (e) => {
    const c = ctx.S.ct, g = grp(c.activeGroup || 0);
    if (c.phase !== 'planning' || !g || !g.on || c.activeRecon == null || c.activeRecon < 0) return;
    const r = groupRecons(g)[c.activeRecon]; if (!r) return;
    const rect = box.parentElement.getBoundingClientRect();
    const edge = e.target.classList.contains('eh') ? e.target.dataset.edge : null;
    const gspan = Math.max(1e-3, g.box.bot - g.box.top);
    const s = { x: e.clientX, y: e.clientY, subTop: r.subTop, subBot: r.subBot };
    try { box.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault(); e.stopPropagation();
    const scanLo = view === 'ap' ? 't' : 'l', scanHi = view === 'ap' ? 'b' : 'r';
    const onMove = (ev) => {
      const du = (ev.clientX - s.x) / rect.width, dv = (ev.clientY - s.y) / rect.height;
      const d = ((view === 'ap' ? dv : du)) / gspan;   // delta in group-fraction units
      const MIN = 0.03;
      if (!edge) { const h = s.subBot - s.subTop, nt = clampV(s.subTop + d, 0, 1 - h); r.subTop = nt; r.subBot = nt + h; }
      else if (edge === scanLo) r.subTop = clampV(s.subTop + d, 0, r.subBot - MIN);
      else if (edge === scanHi) r.subBot = clampV(s.subBot + d, r.subTop + MIN, 1);
      renderReconBoxes(); renderReconPlan();
    };
    const onUp = () => { try { box.releasePointerCapture(e.pointerId); } catch (_) {} box.removeEventListener('pointermove', onMove); box.removeEventListener('pointerup', onUp); box.removeEventListener('pointercancel', onUp); };
    box.addEventListener('pointermove', onMove); box.addEventListener('pointerup', onUp); box.addEventListener('pointercancel', onUp);
  });
}
// Dark-purple dashed lines marking the SFOV lateral edges on both scouts (the SFOV has
// infinite length along the scan axis). AP: vertical lines at the mediolateral edges;
// LAT (rotated, z horizontal): horizontal lines at the AP-depth edges. Shown for the
// active group while planning.
function renderSfovLines() {
  const c = ctx.S.ct, g = grp(c.activeGroup || 0);
  const show = !!(g && g.sfovMM);                 // the SFOV edges are always marked on the scouts
  const half = (g && g.sfovMM ? g.sfovMM / scoutFov() : 1) / 2;
  document.querySelectorAll('#ctScouts .sfovline').forEach((el) => {
    el.style.display = show ? 'block' : 'none';
    if (!show) return;
    const pos = ((el.classList.contains('l') ? 0.5 - half : 0.5 + half) * 100) + '%';
    if (el.dataset.view === 'ap') el.style.left = pos; else el.style.top = pos;
  });
}

// Drag a group's box (move) or an edge handle (resize); selecting it makes the group
// active (drives the reposition plan). Per-group top/bot are AP↔LAT locked (cylinder);
// boxes stay axis-aligned rectangles.
function wireScanBox(box, gi, view) {
  box.addEventListener('pointerdown', (e) => {
    if (ctx.S.ct.phase !== 'planning' || !grp(gi).on || gi !== ctx.S.ct.activeGroup) return;
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
// The box is LOCKED at the centre of the scout on the cross axis (mediolateral on AP,
// depth on LAT) — cross repositioning is done by the reposition buttons, which move the
// table. The box only MOVES along the table long axis (scan length), and RESIZES
// symmetrically about its centre on either axis. Screen deltas map per view: on the
// portrait AP the scan-length axis is vertical (dv); on the rotated-landscape LAT it is
// horizontal (du).
function applyBoxDrag(gi, view, edge, s0, du, dv) {
  const b = grp(gi).box;
  const CL = view === 'ap' ? 'apL' : 'latL', CR = view === 'ap' ? 'apR' : 'latR';   // this scout's cross axis
  const OL = view === 'ap' ? 'latL' : 'apL', OR = view === 'ap' ? 'latR' : 'apR';   // the OTHER scout's cross axis
  const scanD = view === 'ap' ? dv : du;    // delta along the scan-length axis (top/bot)
  const crossD = view === 'ap' ? du : dv;   // delta along the cross axis (apL/apR | latL/latR)
  const scanLo = view === 'ap' ? 't' : 'l', scanHi = view === 'ap' ? 'b' : 'r';
  // the scan box may be moved / lengthened BEYOND the scout image (into the blank margin): the
  // scan start/end then extend past the scouted region.
  const SCAN_LO = -0.6, SCAN_HI = 1.6, ge = isGE();
  if (!edge) {
    // MOVE along the table long axis. On GE the box is also free on the cross axis (off-centre
    // DFOV placement); on Canon/Toshiba the cross axis stays LOCKED at the scout centre.
    const h = s0.bot - s0.top, nt = clampV(s0.top + scanD, SCAN_LO, SCAN_HI - h);
    b.top = nt; b.bot = nt + h;
    if (ge) { const w = s0[CR] - s0[CL], nl = clampV(s0[CL] + crossD, -0.15, 1.15 - w); b[CL] = nl; b[CR] = nl + w; }
  } else if (edge === scanLo) {
    // scan-length edges move INDEPENDENTLY: extend the superior border without touching
    // the inferior one (the cross-axis width, below, stays symmetric).
    b.top = clampV(s0.top + scanD, SCAN_LO, s0.bot - BOX_MIN);
  } else if (edge === scanHi) {
    b.bot = clampV(s0.bot + scanD, s0.top + BOX_MIN, SCAN_HI);
  } else {
    // Cross-axis RESIZE, symmetric about the box centre. AP (mediolateral) and LAT (AP) extents
    // are LINKED to one half-width (the scan volume is a circular cylinder, never an ellipse).
    // Canon locks that centre at 0.5; GE keeps whatever off-centre position the box was dragged to.
    const cAxis = ge ? (s0[CL] + s0[CR]) / 2 : 0.5, oAxis = ge ? (s0[OL] + s0[OR]) / 2 : 0.5;
    const raw = (edge === 'l' || edge === 't') ? cAxis - (s0[CL] + crossD) : (s0[CR] + crossD) - cAxis;
    const half = clampV(raw, BOX_MIN / 2, 0.5);
    b[CL] = cAxis - half; b[CR] = cAxis + half;
    b[OL] = oAxis - half; b[OR] = oAxis + half;
  }
  if (ge) renderScanGroups();   // refresh the DFOV-centre readout from the new box position
}

// ---- scout reposition buttons ----------------------------------------------
// The box is locked at the scout centre, so imaging an off-centre region means moving
// the PATIENT: the buttons pan the scout image under the fixed box and set the scan-
// centre offset (mm), which requires a table reposition to commit. AP buttons shift the
// mediolateral centre (left/right); LATERAL buttons shift the anteroposterior centre
// (up/down). The table-feed axis in each view is handled by dragging the box instead.
const REPOS_STEP = { small: 5, large: 25 };   // mm per press (single vs double chevron)
function nudgeRepos(axis, dir, big) {
  const c = ctx.S.ct;
  if (c.phase !== 'planning') return;
  const step = (big ? REPOS_STEP.large : REPOS_STEP.small) * dir;
  const lim = scoutFov() / 2;                 // keep the scan centre inside the scout FOV
  // mediolateral is additionally bound by the couch's Lateral Slide spec (Aquilion ONE: ±85 mm)
  const xlim = Math.min(lim, tableSpec().latMM || lim);
  if (axis === 'x') c.plan.targetX = clampV(c.plan.targetX + step, -xlim, xlim);
  else c.plan.targetY = clampV(c.plan.targetY + step, -lim, lim);
  updatePlan();
}
// Pan each scout so the (centred) box sits over the button-selected scan centre. AP pans
// mediolaterally (horizontal); the rotated LATERAL pans anteroposteriorly (vertical).
function applyScoutPan() {
  const c = ctx.S.ct, fov = scoutFov() || 1;
  // Pan so the centred box (the dashed cross-line) always sits over the anatomy that the
  // isocentre will image at the current scan-centre offset — i.e. the target, not the delta
  // still to travel. After Move-to-Scan the couch has physically brought that anatomy to the
  // iso, so the scout's centre line then matches the 3D lateral crosshair.
  const ax = -(c.plan.targetX / fov) * 100;
  const ay = -(c.plan.targetY / fov) * 100;
  const ap = ctx.$('scoutAP'), lat = ctx.$('scoutLAT');
  if (ap) ap.style.transform = 'translate(' + ax.toFixed(2) + '%, 0)';
  if (lat) lat.style.transform = 'translate(0, ' + ay.toFixed(2) + '%)';
}
function wireReposButtons() {
  const handler = (e) => {
    const b = e.target.closest('button[data-repo]'); if (!b) return;
    nudgeRepos(b.dataset.repo, +b.dataset.dir, b.dataset.big === '1');
  };
  ctx.$('reposAP')?.addEventListener('click', handler);
  ctx.$('reposLAT')?.addEventListener('click', handler);
}

// Scans run sequentially, so the reposition before START is for the NEXT (first)
// scan = group 1. Moving a later group's box does NOT require a table move.
function updatePlan() {
  const c = ctx.S.ct, g = grp(0), len = c.scanLen, off = scanStartMM();
  const set = (id, v) => { const el = ctx.$(id); if (el) el.textContent = v; };
  set('ctScanStartV', fmtTablePos(off + g.box.top * len) + ' mm');
  set('ctScanEndV', fmtTablePos(off + g.box.bot * len) + ' mm');
  // The scan box is locked at the scout centre on the cross axes; the mediolateral (X)
  // and anteroposterior (Y) scan-centre offsets come from the reposition buttons
  // (c.plan.targetX / targetY), which is what requires a table move.
  applyScoutPan();
  updatePlanReady();
  renderScanGroups();
  renderReconPlan();
  renderSfovLines();
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
    if (row) { ctx.S.ct.activeGroup = +row.dataset.group; ctx.S.ct.activeRecon = -1; renderScanBoxes(); updatePlan(); }
  });
}
function openFieldEditor(gi, act) {
  const g = grp(gi), len = ctx.S.ct.scanLen;
  ctx.S.ct.activeGroup = gi; renderScanBoxes();
  const done = () => { renderScanBoxes(); updatePlan(); };
  const type = (label, cur, apply) => openTypedPopup(label, cur, (v) => { apply(sanitizeNum(v, cur)); done(); });
  const station = (label, list, cur, fmt, apply) => openStationPopup(label, list, cur, fmt, (v) => { apply(v); done(); });
  const off = scanStartMM();
  if (act === 'start') type('Start location (table position, mm)', Math.round(off + g.box.top * len), (v) => { g.box.top = clampV((v - off) / len, -0.6, g.box.bot - BOX_MIN); });
  else if (act === 'end') type('End location (table position, mm)', Math.round(off + g.box.bot * len), (v) => { g.box.bot = clampV((v - off) / len, g.box.top + BOX_MIN, 1.6); });
  else if (act === 'interval') type('Slice interval (mm)', fmtNum(g.interval), (v) => { g.interval = clampV(v, 0.1, 50); });
  else if (act === 'tilt') type('Gantry tilt (degrees)', g.tilt, (v) => { g.tilt = clampV(Math.round(v), -30, 30); });
  else if (act === 'kv') type('Tube voltage (kV)', g.kv, (v) => { g.kv = clampV(Math.round(v), 70, 140); });
  else if (act === 'ma') type('Tube current (mA)', g.ma, (v) => { g.ma = clampV(Math.round(v), 10, 800); });
  else if (act === 'delay') type('Scan delay (seconds)', g.delay, (v) => { g.delay = clampV(Math.round(v), 0, 600); });
  else if (act === 'sfov') {
    const cur = Math.max(0, SFOV_OPTIONS.findIndex((o) => o.name === (g.sfovName || 'Large Body')));
    station('Scan field of view (SFOV)', SFOV_OPTIONS.map((o, i) => i), cur,
      (i) => SFOV_OPTIONS[i].name + '  ·  ' + (SFOV_OPTIONS[i].mm / 10) + ' cm',
      (i) => { const o = SFOV_OPTIONS[i]; g.sfovName = o.name; g.sfovMM = o.mm; });   // DFOV may now exceed the SFOV → warned, not auto-shrunk
  }
  else if (act === 'dfov') type('Display FOV (cm)', (groupDFOV(g) / 10).toFixed(1), (v) => {
    // A DFOV larger than the SFOV is allowed (it just reconstructs black beyond the measured field,
    // and the table flags it) — cap only at the scout width.
    const dfov = clampV(v * 10, 20, scoutFov()), w = clampV(dfov / scoutFov(), 0.04, 1.6);   // cm → mm
    const cx = (g.box.apL + g.box.apR) / 2, cy = (g.box.latL + g.box.latR) / 2;
    g.box.apL = cx - w / 2; g.box.apR = cx + w / 2; g.box.latL = cy - w / 2; g.box.latR = cy + w / 2;
  });
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
const SG_HEADERS = ['Group', 'Show', 'Start Location', 'End Location', 'SFOV', 'DFOV', 'Total Images', 'Detector Config',
  'Beam Collimation', 'Pitch', 'Table Speed', 'Rotation Time',
  'Gantry Tilt', 'Tube Voltage', 'Tube Current', 'Exposure Time', 'Scan Delay'];
// DFOV-centre offset from the SFOV centre (isocentre): anteroposterior + mediolateral (mm).
// DFOV centre offset (mm) relative to the isocentre: +ml = patient-right, +ap = posterior.
// GE reads it off the box position (off-centred by dragging); Canon reads the un-committed
// reposition offset (the couch move carries the rest to the isocentre).
function dfovOffsetMM(g) {
  const c = ctx.S.ct;
  if (c.vendor === 'ge') {
    const sf = scoutFov();
    return { ml: ((g.box.apL + g.box.apR) / 2 - 0.5) * sf, ap: ((g.box.latL + g.box.latR) / 2 - 0.5) * sf };
  }
  return { ml: (c.plan.targetX || 0) - (c.plan.committedX || 0), ap: (c.plan.targetY || 0) - (c.plan.committedY || 0) };
}
function dfovCenterStr(g) {
  const c = ctx.S.ct;
  // Readout is the PLANNED scan-centre offset. GE reads the box position; Canon shows the
  // dialed target (the couch move carries the patient there, so the residual would read 0).
  const o = c.vendor === 'ge' ? dfovOffsetMM(g) : { ml: c.plan.targetX || 0, ap: c.plan.targetY || 0 };
  const f = (v, pos, neg) => (v >= 0 ? pos : neg) + Math.abs(v).toFixed(1);
  // Patient perspective: a posterior scan centre reads P, anterior reads A; right R, left L.
  return f(o.ap, 'P', 'A') + ' ' + f(o.ml, 'R', 'L');
}
// True when the DFOV disc is not fully contained by the SFOV (measured) circle → the recon will
// have un-scanned black beyond the SFOV. GE: the off-centre box can poke past the isocentre SFOV.
// Canon: the couch carries the offset, so only an oversized DFOV (diameter > SFOV) matters.
function dfovOutOfSfov(g) {
  const sfovR = (g.sfovMM || 500) / 2, dfovR = groupDFOV(g) / 2;
  if (ctx.S.ct.vendor === 'ge') { const o = dfovOffsetMM(g); return Math.hypot(o.ml, o.ap) + dfovR > sfovR + 0.5; }
  return dfovR > sfovR + 0.5;
}

// Scout planning table: AP (scan plane 0°) + Lateral (90°) as two scout groups.
// Simpler than the scan-group table (no slice/pitch) — start/end are shared (the
// scout always runs from the isocentre for the scan length); kV/mA edit per plane.
const SCOUT_PLANES = [{ label: 'AP', ang: 0 }, { label: 'Lateral', ang: 90 }];
function renderScoutTable() {
  const cont = ctx.$('ctScoutTable'); if (!cont) return;
  const c = ctx.S.ct;
  // scout start/end are landmark-relative table positions; RED until the table is
  // zeroed (the tech sets table 0 before the scout is meaningful). Click to edit.
  const zc = c.isocentred ? '' : ' unzeroed';
  const start = fmtTablePos(scanStartMM()) + ' mm', end = fmtTablePos(scanStartMM() + c.scanLen) + ' mm';
  const rows = SCOUT_PLANES.map((p, i) => {
    const t = c.scoutTech[i];
    return '<tr class="sg-row" data-plane="' + i + '">'
      + '<td><span class="sc-plane">' + p.ang + '°<small>' + p.label + '</small></span></td>'
      + '<td><span class="sg-edit' + zc + '" data-act="start">' + start + '</span></td>'
      + '<td><span class="sg-edit' + zc + '" data-act="end">' + end + '</span></td>'
      + '<td><span class="sg-edit" data-act="kv">' + t.kv + ' kV</span></td>'
      + '<td><span class="sg-edit" data-act="ma">' + t.ma + ' mA</span></td></tr>';
  }).join('');
  cont.innerHTML = '<table class="sg-table"><thead><tr>'
    + ['Scan plane', 'Start', 'End', 'kV', 'mA'].map((h) => '<th>' + h + '</th>').join('')
    + '</tr></thead><tbody>' + rows + '</tbody></table>';
}
function wireScoutTable() {
  const cont = ctx.$('ctScoutTable'); if (!cont) return;
  cont.addEventListener('click', (e) => {
    const span = e.target.closest('.sg-edit'); if (!span) return;
    const row = span.closest('.sg-row'); const i = +row.dataset.plane, act = span.dataset.act;
    const c = ctx.S.ct, t = c.scoutTech[i];
    if (act === 'start') openTypedPopup('Scout start (table position, mm)', Math.round(scanStartMM()), (v) => {
      const nv = sanitizeNum(v, scanStartMM()), end = c.scanStart + c.scanLen;
      c.scanStart = Math.min(nv, end - 50); c.scanLen = Math.round(end - c.scanStart); c.protocol = 'whole';
      renderScanBoxes(); updateScanMarkers(); if (c.phase === 'planning') updatePlan(); updateCTReadouts();
    });
    else if (act === 'end') openTypedPopup('Scout end (table position, mm)', Math.round(scanStartMM() + c.scanLen), (v) => {
      const nv = sanitizeNum(v, scanStartMM() + c.scanLen);
      c.scanLen = Math.max(50, Math.round(nv - c.scanStart)); c.protocol = 'whole';
      renderScanBoxes(); updateScanMarkers(); if (c.phase === 'planning') updatePlan(); updateCTReadouts();
    });
    else if (act === 'kv') openTypedPopup('Scout kV — ' + SCOUT_PLANES[i].label, t.kv, (v) => { t.kv = Math.max(70, Math.min(140, Math.round(v))); updateCTReadouts(); });
    else if (act === 'ma') openTypedPopup('Scout mA — ' + SCOUT_PLANES[i].label, t.ma, (v) => { t.ma = Math.max(5, Math.min(500, Math.round(v))); updateCTReadouts(); });
  });
}

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
      + '<td><span class="sg-eye' + (g.vis ? '' : ' off') + '" title="Toggle scan lines on the scout">' + (g.vis ? EYE_OPEN : EYE_CLOSED) + '</span></td>'
      + cell('sg-edit', 'start', fmtTablePos(scanStartMM() + g.box.top * c.scanLen))
      + cell('sg-edit', 'end', fmtTablePos(scanStartMM() + g.box.bot * c.scanLen))
      + '<td><span class="sg-station' + (dfovOutOfSfov(g) ? ' sfov-warn' : '') + '" data-act="sfov">'
        + (g.sfovName || sfovName(g.sfovMM))
        + (dfovOutOfSfov(g) ? ' <span class="sfov-ico" title="DFOV extends beyond the SFOV — anatomy outside the measured field is not scanned">⚠</span>' : '')
        + '</span></td>'
      + '<td><span class="sg-edit" data-act="dfov">' + (groupDFOV(g) / 10).toFixed(1) + ' cm</span><span class="sg-sub">' + dfovCenterStr(g) + '</span></td>'
      + cell('sg-calc', '', groupImages(g))
      + cell('sg-station', 'acq', detConfig(g))
      + cell('sg-station', 'acq', fmtNum(g.beamColl) + ' mm')
      + cell('sg-station', 'acq', fmtNum(g.pitch) + ':1')
      + cell('sg-station', 'acq', fmtNum(tableSpeedOf(g)) + ' mm/rot')
      + cell('sg-station', 'rot', g.rotSpeed.toFixed(2) + ' s')
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

// ---- recon planning table (per scan group; up to N_RECONS reconstructions) ----
const N_RECONS = 10;
const RP_PLANES = [{ v: 'transverse', l: 'Transverse' }, { v: 'sagittal', l: 'Sagittal' }, { v: 'coronal', l: 'Coronal' }];
const RP_PLANE_PANE = { transverse: 'axial', sagittal: 'sagittal', coronal: 'coronal' };  // recon plane → MPR pane
const RP_ALGOS = [{ v: 'standard', l: 'Average' }, { v: 'mip', l: 'MiP' }, { v: 'minip', l: 'MiniP' }, { v: 'edge', l: 'Edge Enh' }, { v: 'blur', l: 'Blur' }];
const RP_HEADERS = ['Recon', 'Plane', 'Thickness', 'Interval', 'WW', 'WL', 'Algorithm', 'MAR', 'Sub Start', 'Sub End'];
const rpPlaneLabel = (p) => (RP_PLANES.find((x) => x.v === p) || { l: p }).l;
const rpAlgoLabel = (a) => (RP_ALGOS.find((x) => x.v === a) || { l: a }).l;
function defaultRecon() { return { plane: 'transverse', thk: 5, interval: 5, ww: 400, wl: 40, algo: 'standard', mar: false, subTop: 0, subBot: 1 }; }
function groupRecons(g) { if (!g.recons || !g.recons.length) g.recons = [defaultRecon()]; return g.recons; }

function renderReconPlan() {
  const cont = ctx.$('ctReconPlan'); if (!cont) return;
  const c = ctx.S.ct, gi = c.activeGroup || 0, g = grp(gi);
  // Tag the recon table with the active scan group's colour class (gc0/gc1/…) so its number
  // badges, row accents and title take that group's colour — a visual cue for which group's
  // reconstructions are shown.
  cont.className = 'scangroups reconplan gc' + gi;
  if (!g || !g.on) { cont.innerHTML = ''; return; }
  const recons = groupRecons(g), len = c.scanLen, off = scanStartMM();
  const gTop = off + g.box.top * len, gBot = off + g.box.bot * len, span = gBot - gTop;
  const cell = (cls, act, txt) => '<td><span class="' + cls + '" data-act="' + act + '">' + txt + '</span></td>';
  const ari = (c.activeRecon == null ? -1 : c.activeRecon);   // -1 = none selected
  let rows = '';
  recons.forEach((r, ri) => {
    const num = ri > 0
      ? '<span class="sg-num del" title="Delete recon"><span class="lbl">' + (ri + 1) + '</span><span class="trash">' + TRASH + '</span></span>'
      : '<span class="sg-num">' + (ri + 1) + '</span>';
    rows += '<tr class="sg-row rp-row' + (ri === ari ? ' active' : '') + '" data-recon="' + ri + '">'
      + '<td>' + num + '</td>'
      + cell('sg-station', 'rp-plane', rpPlaneLabel(r.plane))
      + cell('sg-edit', 'rp-thk', fmtNum(r.thk) + ' mm')
      + cell('sg-edit', 'rp-interval', fmtNum(r.interval) + ' mm')
      + cell('sg-edit', 'rp-ww', Math.round(r.ww))
      + cell('sg-edit', 'rp-wl', Math.round(r.wl))
      + cell('sg-station', 'rp-algo', rpAlgoLabel(r.algo))
      + cell('sg-station' + (r.mar ? ' rp-on' : ''), 'rp-mar', r.mar ? 'ON' : 'OFF')
      + cell('sg-edit', 'rp-substart', fmtTablePos(gTop + r.subTop * span))
      + cell('sg-edit', 'rp-subend', fmtTablePos(gTop + r.subBot * span))
      + '</tr>';
  });
  const canAdd = recons.length < N_RECONS;
  cont.innerHTML = '<div class="rp-title">Recon planning — scan group ' + (gi + 1) + '  ·  ' + recons.length + '/' + N_RECONS + '</div>'
    + '<table class="sg-table"><thead><tr>' + RP_HEADERS.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>'
    + rows + '</tbody></table>' + (canAdd ? '<button class="sg-add rp-add">+ Add recon</button>' : '');
  renderReconBoxes();
}
function wireReconPlan() {
  const cont = ctx.$('ctReconPlan'); if (!cont) return;
  cont.addEventListener('click', (e) => {
    const c = ctx.S.ct, g = grp(c.activeGroup || 0); if (!g || !g.on) return;
    const recons = groupRecons(g), refresh = () => { renderReconPlan(); renderScanBoxes(); };
    if (e.target.closest('.rp-add')) { if (recons.length < N_RECONS) { recons.push(defaultRecon()); c.activeRecon = recons.length - 1; refresh(); } return; }
    const del = e.target.closest('.sg-num.del');
    if (del) { const ri = +del.closest('tr').dataset.recon; if (ri > 0) { recons.splice(ri, 1); c.activeRecon = -1; refresh(); } return; }
    const ed = e.target.closest('[data-act]'), row = e.target.closest('tr[data-recon]');
    if (row) c.activeRecon = +row.dataset.recon;   // selecting a recon hides the scan lines
    if (ed) editRecon(+ed.closest('tr').dataset.recon, ed.dataset.act); else refresh();
  });
}
function editRecon(ri, act) {
  const c = ctx.S.ct, g = grp(c.activeGroup || 0), r = groupRecons(g)[ri]; if (!r) return;
  c.activeRecon = ri;
  const len = c.scanLen, off = scanStartMM(), gTop = off + g.box.top * len, span = (off + g.box.bot * len) - gTop;
  const done = () => { renderReconPlan(); renderScanBoxes(); };
  const type = (label, cur, apply) => openTypedPopup(label, cur, (v) => { apply(sanitizeNum(v, cur)); done(); });
  const station = (label, list, cur, fmt, apply) => openStationPopup(label, list, cur, fmt, (v) => { apply(v); done(); });
  if (act === 'rp-plane') station('Recon plane', RP_PLANES.map((p, i) => i), RP_PLANES.findIndex((p) => p.v === r.plane), (i) => RP_PLANES[i].l, (i) => { r.plane = RP_PLANES[i].v; });
  else if (act === 'rp-algo') station('Processing algorithm', RP_ALGOS.map((a, i) => i), Math.max(0, RP_ALGOS.findIndex((a) => a.v === r.algo)), (i) => RP_ALGOS[i].l, (i) => { r.algo = RP_ALGOS[i].v; });
  else if (act === 'rp-mar') { r.mar = !r.mar; done(); }
  else if (act === 'rp-thk') type('Slice thickness (mm)', fmtNum(r.thk), (v) => { r.thk = clampV(v, 0.5, 50); });
  else if (act === 'rp-interval') type('Slice interval (mm)', fmtNum(r.interval), (v) => { r.interval = clampV(v, 0.1, 50); });
  else if (act === 'rp-ww') type('Window width (WW)', Math.round(r.ww), (v) => { r.ww = clampV(Math.round(v), 1, 4000); });
  else if (act === 'rp-wl') type('Window level (WL)', Math.round(r.wl), (v) => { r.wl = clampV(Math.round(v), -1000, 3000); });
  else if (act === 'rp-substart') type('Recon sub-area start (table position, mm)', Math.round(gTop + r.subTop * span), (v) => { r.subTop = clampV((v - gTop) / span, 0, r.subBot - 0.02); });
  else if (act === 'rp-subend') type('Recon sub-area end (table position, mm)', Math.round(gTop + r.subBot * span), (v) => { r.subBot = clampV((v - gTop) / span, r.subTop + 0.02, 1); });
  else done();
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
// Protocol picker: choose a CT protocol (sets scout range + isocentre landmark).
function openProtocolPopup() {
  const pop = ctx.$('ctPop'), inner = ctx.$('ctPopInner'); if (!pop) return;
  const cur = ctProtocol().id;
  inner.innerHTML = '<div class="plt">CT protocol</div><div class="pl">Select a protocol:</div>'
    + '<div class="ctpop-stations proto">' + CT_PROTOCOLS.map((p) =>
        '<button data-v="' + p.id + '"' + (p.id === cur ? ' class="on"' : '') + '>'
        + p.name + (p.land ? '<span class="protoland">' + p.land + '</span>' : '') + '</button>').join('')
    + '</div><div class="phint"><b>[ESC]</b> to cancel</div>';
  const close = () => { pop.classList.remove('show'); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  pop.classList.add('show');
  inner.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { applyProtocol(b.dataset.v); close(); }));
  document.addEventListener('keydown', onKey, true);
}
// Apply a protocol: set the scout range (landmark-relative start + length) and the
// isocentre landmark, then reset the scan box and refresh. `len:0` = whole model.
function applyProtocol(id) {
  const c = ctx.S.ct, p = ctProtocol(id);
  c.protocol = p.id;
  if (p.id !== 'whole') { c.scanStart = p.start; c.scanLen = p.len; }
  else { const L = ctx.S.voxelModel ? Math.round(ctx.S.voxelModel.extentMM[2]) : 300; c.scanStart = -Math.round(L / 2); c.scanLen = L; }
  resetScanBox();
  renderScanBoxes(); updateScanMarkers();
  if (c.phase === 'planning') updatePlan();
  updateCTReadouts(); updateConsoleFlash();
}
// Reflect the current protocol name + isocentre-landmark shorthand under the picker.
function renderProtocol() {
  const p = ctProtocol();
  const btn = ctx.$('ctProtocolBtn'), name = ctx.$('ctProtocolName'), land = ctx.$('ctProtocolLand');
  if (btn) btn.innerHTML = p.name + ' <span class="cv">&#9662;</span>';
  // caption reads "Anatomic Zero: <landmark shorthand>" (the table-0 landmark)
  if (name) name.textContent = 'Anatomic Zero:';
  if (land) { land.textContent = p.land || '—'; land.title = p.land ? LANDMARKS[p.land] : 'No preset landmark — zero anywhere'; land.style.display = ''; }
}
// Reference-style acquisition ("Select the desired Image Thickness") dialog. Edits a
// working copy of the group's acquisition geometry and applies it on OK. Relationships:
//   beam collimation = detector rows × detector element   (element = min recon thickness)
//   table speed (mm/rot) = pitch × beam collimation  ⇒  pitch = table speed / collimation
// Selecting a Speed keeps the current pitch and changes the collimation when that speed
// maps to another valid collimation (shown darker blue); otherwise it keeps the
// collimation and changes the pitch (lighter). Helical (reconstructed) thickness is
// Help popup: explains beam collimation vs detector element vs slice thickness vs interval,
// with a labelled z-axis diagram, so the terms in the scan/recon plan are unambiguous.
function openScanHelp() {
  const pop = ctx.$('ctPop'), inner = ctx.$('ctPopInner'); if (!pop) return;
  const close = () => { pop.classList.remove('show'); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  // ---- z-axis diagram ----
  const rows = 16, bx = 70, bw = 300, cw = bw / rows, by = 58, bh = 30;
  let cells = '';
  for (let i = 0; i < rows; i++) {
    cells += '<rect x="' + (bx + i * cw) + '" y="' + by + '" width="' + cw + '" height="' + bh +
      '" fill="' + (i === 8 ? '#2aa7c2' : '#1d3a45') + '" stroke="#0c1418" stroke-width="0.6"/>';
  }
  // reconstructed slices: boxes of "thickness", spaced by "interval"
  const sy = 176, sh = 34, thkW = 46, gap = 12, sx = 70;
  let slabs = '';
  for (let i = 0; i < 4; i++) {
    const x = sx + i * (thkW + gap);
    slabs += '<rect x="' + x + '" y="' + sy + '" width="' + thkW + '" height="' + sh +
      '" rx="2" fill="#26506e" stroke="#4a90c0" stroke-width="1.2"/>';
  }
  const svg =
    '<svg class="help-svg" viewBox="0 0 420 264" xmlns="http://www.w3.org/2000/svg">' +
    '<style>.hl{fill:#cfe8f2;font:11px system-ui}.hs{fill:#8fa3b0;font:9.5px system-ui}.hn{fill:#ffcf7a;font:9.5px system-ui}</style>' +
    // Section 1 — beam collimation
    '<text x="20" y="40" class="hl">① Beam collimation — the X-ray beam width along z, per rotation</text>' +
    cells +
    '<rect x="' + (bx + 8 * cw) + '" y="' + by + '" width="' + cw + '" height="' + bh + '" fill="none" stroke="#ffcf7a" stroke-width="1.6"/>' +
    '<line x1="' + bx + '" y1="' + (by + bh + 7) + '" x2="' + (bx + bw) + '" y2="' + (by + bh + 7) + '" stroke="#8fa3b0" stroke-width="1"/>' +
    '<text x="' + (bx + bw / 2) + '" y="' + (by + bh + 20) + '" class="hs" text-anchor="middle">16 detector rows × 0.625 mm element = 10 mm collimation</text>' +
    '<text x="' + (bx + 8 * cw + cw / 2) + '" y="' + (by - 6) + '" class="hn" text-anchor="middle">1 element = thinnest slice</text>' +
    // Section 2 — reconstructed slices
    '<text x="20" y="158" class="hl">② Reconstructed slices — the images you scroll through</text>' +
    slabs +
    '<line x1="' + sx + '" y1="' + (sy + sh + 8) + '" x2="' + (sx + thkW) + '" y2="' + (sy + sh + 8) + '" stroke="#4a90c0" stroke-width="1.2"/>' +
    '<text x="' + (sx + thkW / 2) + '" y="' + (sy + sh + 20) + '" class="hs" text-anchor="middle">thickness</text>' +
    '<line x1="' + (sx + thkW / 2) + '" y1="' + (sy - 8) + '" x2="' + (sx + thkW + gap + thkW / 2) + '" y2="' + (sy - 8) + '" stroke="#ffcf7a" stroke-width="1.2" marker-start="url(#a)" marker-end="url(#a)"/>' +
    '<text x="' + (sx + thkW + gap / 2) + '" y="' + (sy - 12) + '" class="hn" text-anchor="middle">interval</text>' +
    '<defs><marker id="a" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0 3 L6 1 L6 5 Z" fill="#ffcf7a"/></marker></defs>' +
    // z axis
    '<line x1="20" y1="252" x2="400" y2="252" stroke="#5a6a75" stroke-width="1"/><path d="M400 252 l-7 -3 l0 6 Z" fill="#5a6a75"/>' +
    '<text x="20" y="246" class="hs">patient long axis (z):  Superior → Inferior</text>' +
    '</svg>';
  const def = (t, d) => '<div class="help-def"><b>' + t + '</b>' + d + '</div>';
  inner.innerHTML = '<div class="help-pop"><div class="help-title">CT scan parameters</div>' + svg +
    '<div class="help-defs">' +
    def('Beam collimation', ' — the total z-width of the X-ray beam per rotation = <i>detector rows × element</i> (e.g. 16 × 0.625 = 10 mm). Wider covers faster but widens the cone (more cross-slice artifact).') +
    def('Detector element / acquisition thickness', ' — collimation ÷ rows. This is the <i>thinnest</i> slice you can reconstruct.') +
    def('Slice thickness ( = helical thickness)', ' — the z-thickness of each reconstructed image; can be anything from the detector element upward. Thicker = less noise but more partial-volume averaging (blur in z); thinner = more detail, more noise. "Helical thickness" is just the reconstructed slice thickness for a helical scan.') +
    def('Slice interval', ' — the z-distance between reconstructed slice centres. Interval = thickness → contiguous; interval &lt; thickness → overlapping; interval &gt; thickness → gaps between slices.') +
    def('Pitch', ' — table travel per rotation ÷ collimation. Pitch &gt; 1 stretches the helix (faster, less dose); &lt; 1 overlaps it (more dose, less helical artifact).') +
    '</div><div class="acq-actions"><button class="acq-ok">Got it</button></div></div>';
  inner.querySelector('.acq-ok').addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  pop.classList.add('show');
}

// Acquisition popup: rows / pitch / rotation time. The detector element (DEL) is a fixed
// physical property, so beam collimation = rows × DEL is DERIVED (never chosen directly), and
// slice thickness / interval are reconstruction settings (the recon table), not acquisition.
function openAcqPopup(gi) {
  const pop = ctx.$('ctPop'), inner = ctx.$('ctPopInner'); if (!pop) return;
  const g = grp(gi);
  // Single-slice CT (SSCT) acquires ONE detector row per rotation — multi-row is meaningless,
  // so the row selector is locked to 1. MSCT exposes the full multi-row detector.
  const msct = !!(ctx.S.ct.features && ctx.S.ct.features.coneBeam);
  const rowOpts = msct ? DET_ROW_OPTS : [1];
  const w = { detRows: msct ? g.detRows : 1, pitch: g.pitch, rotSpeed: g.rotSpeed };
  const close = () => { pop.classList.remove('show'); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  function render() {
    const coll = w.detRows * DEL_MM;                          // beam collimation = rows × DEL (fixed 0.625 mm)
    const feedRot = w.pitch * coll;                          // table travel per rotation (mm/rot)
    const feedSec = feedRot / Math.max(w.rotSpeed, 1e-3);    // table feed speed (mm/s)
    // one clean selection highlight per section; nothing to grey out (all combos are valid)
    const btns = (list, val, fmt, k) => list.map(v =>
      '<button data-k="' + k + '" data-v="' + v + '" class="' + (Math.abs(v - val) < 1e-6 ? 'on' : '') + '">' + fmt(v) + '</button>').join('');
    inner.innerHTML =
      '<div class="acq-pop"><div class="acq-title">Detector configuration &amp; acquisition</div><div class="acq-grid"><div class="acq-left">'
      + '<div class="acq-sec"><div class="acq-lab">Detector Rows <small>× ' + fmtNum(DEL_MM) + ' mm DEL' + (msct ? '' : ' · SSCT: single row') + '</small></div><div class="acq-btns">' + btns(rowOpts, w.detRows, x => x, 'rows') + '</div></div>'
      + '<div class="acq-sec"><div class="acq-lab">Pitch</div><div class="acq-btns">' + btns(PITCH_ACQ, w.pitch, x => fmtNum(x) + ':1', 'pitch') + '</div></div>'
      + '<div class="acq-sec"><div class="acq-lab">Rotation Time (s)</div><div class="acq-btns">' + btns(ROT_STATIONS, w.rotSpeed, x => x.toFixed(2), 'rot') + '</div></div>'
      + '</div><div class="acq-right">'
      + '<div class="acq-info"><div class="acq-ilab">Detector configuration:</div><div class="acq-ival">' + w.detRows + ' × ' + fmtNum(DEL_MM) + ' mm</div></div>'
      + '<div class="acq-info"><div class="acq-ilab">Beam collimation:</div><div class="acq-ival">' + fmtNum(coll) + ' mm</div></div>'
      + '<div class="acq-info"><div class="acq-ilab">Table travel:</div><div class="acq-ival">' + fmtNum(feedRot) + ' mm/rot</div></div>'
      + '<div class="acq-info"><div class="acq-ilab">Table feed speed:</div><div class="acq-ival">' + fmtNum(feedSec) + ' mm/s</div></div>'
      + '</div></div><div class="acq-actions"><button class="acq-ok">OK</button><button class="acq-cancel">Cancel</button></div></div>';
    inner.querySelectorAll('.acq-btns button').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.k, v = parseFloat(b.dataset.v);
      if (k === 'rows') w.detRows = v;
      else if (k === 'pitch') w.pitch = v;
      else if (k === 'rot') w.rotSpeed = v;
      render();
    }));
    inner.querySelector('.acq-ok').addEventListener('click', () => {
      g.detRows = w.detRows; g.beamColl = w.detRows * DEL_MM; g.pitch = w.pitch; g.rotSpeed = w.rotSpeed;
      close(); renderScanBoxes(); updatePlan();
    });
    inner.querySelector('.acq-cancel').addEventListener('click', close);
  }
  pop.classList.add('show');
  document.addEventListener('keydown', onKey, true);
  render();
}

// Reconcile the scan groups with the current acquisition mode. SSCT (cone beam off) acquires
// a single detector row per rotation — multi-row is meaningless — so force every group to
// detRows = 1 / beamColl = one DEL. MSCT leaves the groups' chosen row counts untouched.
// Called by app.js whenever the SSCT/MSCT toggle (or the Quick/Realistic mode) changes.
export function ctApplyAcqMode() {
  if (!ctx || !ctx.S.ct.groups) return;
  const msct = !!(ctx.S.ct.features && ctx.S.ct.features.coneBeam);
  for (const g of ctx.S.ct.groups) {
    if (!msct) { g.detRows = 1; g.beamColl = DEL_MM; }                        // SSCT → single row
    else if (g.detRows < DET_ROW_OPTS[0]) { g.detRows = 16; g.beamColl = g.detRows * DEL_MM; }  // MSCT → restore a multi-row default
  }
  renderScanBoxes(); renderScanGroups(); updatePlan();
}

const isGE = () => (ctx && ctx.S.ct.vendor) === 'ge';
// Apply the colour scheme to the whole app. In CT mode with the vendor scheme, the interface adopts
// the selected vendor's console palette (GE light-blue / Canon dark-grey); otherwise (generic scheme
// OR x-ray mode) the default palette is used — x-ray is never re-themed.
export function ctApplyColorTheme() {
  if (!ctx) return;
  const c = ctx.S.ct, ct = ctx.S.mode === 'ct', vendorScheme = (c.colorSchema || 'vendor') !== 'generic';
  const theme = (ct && vendorScheme) ? ('theme-' + (c.vendor === 'ge' ? 'ge' : 'canon')) : null;
  const b = document.body.classList;
  b.remove('theme-ge', 'theme-canon');
  if (theme) b.add(theme);
}
// Apply the vendor workflow to the UI: GE hides the reposition chevrons and the TABLE
// (mediolateral/AP couch-move) button — the operator off-centres the DFOV by dragging the box
// instead. Canon/Toshiba shows them (locked box + physical couch reposition). Switching vendors
// clears any pending reposition so the two paradigms never mix.
export function ctApplyVendor() {
  if (!ctx) return;
  const ge = isGE();
  ['reposAP', 'reposLAT'].forEach(id => { const el = ctx.$(id); if (el) el.style.display = ge ? 'none' : ''; });
  const tbl = ctx.$('ctTable'); if (tbl) tbl.style.display = ge ? 'none' : '';
  // Console layout. Canon: TABLE (couch reposition) on the top button row, Move-to-Scan on the
  // row below. GE: no couch reposition, so Move-to-Scan (pill-shaped) takes the TABLE slot on the
  // top row and the second row is dropped.
  const con = ctx.$('ctConsole');
  if (con) {
    con.classList.toggle('ge', ge);
    const row1 = con.querySelector('.ctbtns'), moveRow = con.querySelector('.ctmove-row');
    const moveLab = con.querySelector('.ctmove-lab'), moveBtn = ctx.$('ctMoveScan');
    const lab3 = con.querySelectorAll('.ctbtns-lab > span')[2];
    if (ge) {
      if (moveBtn && row1 && moveBtn.parentElement !== row1) row1.appendChild(moveBtn);   // move into the TABLE slot
      moveBtn && moveBtn.classList.add('pill');
      if (moveRow) moveRow.style.display = 'none';
      if (moveLab) moveLab.style.display = 'none';
      if (lab3) lab3.textContent = 'Move to Scan';
    } else {
      if (moveBtn && moveRow && moveBtn.parentElement !== moveRow) moveRow.appendChild(moveBtn);
      moveBtn && moveBtn.classList.remove('pill');
      if (moveRow) moveRow.style.display = '';
      if (moveLab) moveLab.style.display = '';
      if (lab3) lab3.textContent = 'Table';
    }
  }
  const c = ctx.S.ct;
  // GE never moves the couch cross-axis: drop any pending/committed reposition offset so it can't
  // leak into the recon centring (which, in GE, comes purely from the box position).
  if (ge) { c.plan.targetX = c.plan.targetY = c.plan.committedX = c.plan.committedY = 0; c.patient.x = 0; c.tableY = 0; }
  else { for (const g of c.groups) { g.box.apL = 0.5 - (g.box.apR - g.box.apL) / 2; g.box.apR = 1 - g.box.apL;   // re-centre the box for the locked-box workflow
                                     const hw = (g.box.latR - g.box.latL) / 2; g.box.latL = 0.5 - hw; g.box.latR = 0.5 + hw; } }
  // the new vendor's physical travel may be tighter — pull the couch back inside it
  c.patient.z = clampPatientZ(c.patient.z); c.tablePos = (c.isoZ - c.patient.z) * MM_PER_UNIT;
  updateCTReadouts();
  if (ctx.syncScene) { /* keep scene consistent if patient moved */ }
  renderScanBoxes(); updatePlan();
  rebuildCTModel();                               // re-skin the 3D machine (GE Optima ↔ Canon/Toshiba Aquilion)
  ctSyncScene();                                  // re-apply shell/couch visibility + positions for the current PoV
  ctApplyColorTheme();                            // GE ↔ Canon may switch the vendor palette
  ctx.refreshReadouts && ctx.refreshReadouts();
}

// Flash TABLE (orange) while the couch still needs to move; else flash START (green).
// While a move is pending the DR monitor mirrors the axis' PoV — AP-PoV for the
// mediolateral move, Lat-PoV for the anteroposterior (height) move.
// Where "Move to Scan" drives the couch, per phase:
//  · scouting (idle): the SCOUT start (scanStart, the topogram's superior edge)
//  · planning:        the first scan group's superior edge (scanStart + box.top·len)
// The next button (START) only unlocks once the table is parked at that position.
function scanStartTablePos() { return scanStartMM() + grp(0).box.top * ctx.S.ct.scanLen; }
// Clamped to the physical travel so a plan just beyond the limit parks the couch AT the limit and
// still unlocks START (the recon works in scout coordinates; the couch glide is the physical part).
function moveScanTarget() { return clampTablePosMM(ctx.S.ct.phase === 'planning' ? scanStartTablePos() : scanStartMM()); }
function atMoveTarget() { return Math.abs(ctx.S.ct.tablePos - moveScanTarget()) <= 1.0; }
// Drive the flashing console key for the current phase. Sequence:
//  · idle:     Zero Table (needzero) → MOVE TO SCAN → START (acquire scouts)
//  · planning: TABLE reposition → MOVE TO SCAN → START (run scan)
function updateConsoleFlash() {
  const c = ctx.S.ct;
  if (c.phase === 'planning') { updatePlanReady(); return; }
  const move = ctx.$('ctMoveScan'), start = ctx.$('ctStart'), table = ctx.$('ctTable');
  table?.classList.remove('flash');
  if (c.phase === 'idle') {
    const atStart = atMoveTarget();
    move?.classList.toggle('flash', c.isocentred && !atStart);   // flash only once zeroed
    start?.classList.toggle('flash', c.isocentred && atStart);
  } else {
    move?.classList.remove('flash'); start?.classList.remove('flash');
  }
}
function updatePlanReady() {
  const c = ctx.S.ct;
  // Canon/Toshiba: the couch physically carries the SFOV, so an un-committed mediolateral/AP
  // reposition MUST be moved before scanning (sequence: reposition → Move to Scan → START).
  // GE: the couch never moves cross-axis after the scout (the DFOV is off-centred in software),
  // so there is no reposition step — START is gated only on the longitudinal Move-to-Scan.
  const ge = c.vendor === 'ge';
  const needX = !ge && Math.abs(c.plan.targetX - c.plan.committedX) > MOVE_THRESH;
  const needY = !ge && Math.abs(c.plan.targetY - c.plan.committedY) > MOVE_THRESH;
  const needMove = needX || needY;
  const needScanMove = !needMove && !atMoveTarget();
  ctx.$('ctTable')?.classList.toggle('flash', needMove);
  ctx.$('ctMoveScan')?.classList.toggle('flash', c.isocentred && needScanMove);
  ctx.$('ctStart')?.classList.toggle('flash', c.isocentred && !needMove && !needScanMove);
  c.moveBlit = needMove ? (needX ? 'ap' : 'lat') : null;      // which PoV to mirror into the monitor
  const noexp = ctx.$('noexp');
  if (needMove && noexp) noexp.style.display = 'none';
  showTableReminder(needMove, tableV > 0.05);
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
  // Height: a POSTERIOR scan centre (targetY > 0) means the region of interest is toward the
  // patient's back, which sits BELOW the isocentre — so the couch must rise to bring it up to
  // the iso (table height = +offset). Negating this moved the patient the wrong way (posterior
  // box → table down → anterior imaged).
  const hl = tableYLimits();                                   // spec vertical range (cradle-top ceiling)
  c.tableY = clampV(c.plan.committedY, hl.lo, hl.hi);
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
  // zSub: z sub-planes across the slice sensitivity profile (finite slab thickness). >1 makes
  // this a MULTI-slice recon — partial-volume in z + cross-slice artifact bleed. quick keeps it
  // light (fast preview); realistic integrates the full SSP.
  quick:     { nDet: 384, nAngles: 288, gridN: 128, fixedPitch: false, zSub: 3 },
  // photonBase: detected photons per channel per view at the reference technique —
  // clinical scale (~10^6-10^7), so the 512² image lands at a clinical ~10-15 HU noise;
  // the quick preview keeps the old (much lower) base tuned for its coarse grid.
  realistic: { nDet: 888, nAngles: 1440, gridN: 512, fixedPitch: true, chanMM: 0.625, sfovMM: 555, photonBase: 8e6, zSub: 7 },
};
// Selectable scan field of view (the bore reconstruction circle); the rays integrate over
// it, so the body must sit inside it or the projections truncate (→ cupping). GE-style set.
const SFOV_OPTIONS = [
  { name: 'Pediatric Head', mm: 250 }, { name: 'Head', mm: 250 }, { name: 'Small Body', mm: 320 },
  { name: 'Large Body', mm: 500 }, { name: 'Extra Large Body', mm: 650 },
];
const sfovName = (mm) => (SFOV_OPTIONS.find((s) => s.mm === mm) || { name: mm + ' mm' }).name;
// Smallest (non-pediatric) SFOV that comfortably contains the model — so it's visible on
// the scout rather than dwarfing a small subject.
function defaultSfov() {
  const ext = ctx && ctx.S.voxelModel ? ctx.S.voxelModel.extentMM : [200, 200, 200];
  const need = Math.max(ext[0], ext[1]) + 20;
  const opts = SFOV_OPTIONS.slice(1);   // skip Pediatric Head (a bowtie variant of Head)
  return opts.find((s) => s.mm >= need) || opts[opts.length - 1];
}
const detMode = () => DET_MODES[ctx && ctx.S.ct.detMode] || DET_MODES.quick;
const MAX_SLICES = 1024;          // safety cap only (the slice count follows the planned image count)
const PHOTON_BASE = 1.1e5;        // reference detected photons per ray (mA/slice/rot noise model)
// Detector saturation: the largest line integral the readout can measure. Behind dense metal
// almost no photons arrive; a real detector floors at its electronic-noise level rather than
// reporting an ever-larger (uncapped) integral, so the projection SATURATES at this value.
// Clipping here — instead of adding unbounded noise to p — keeps photon-starvation streaks
// bounded and localised (strongest between metals, fading outward) like a clinical scan.
const SAT_P = 11.5;               // ≈ e^-11.5 transmission floor

// Reconstruction display field of view for a group = the scan box diameter (the box
// represents a cylinder). The mediolateral width on the AP scout is the cylinder
// diameter — the direction in which neighbouring fingers are separated — so a box
// drawn around a single finger reconstructs a small FOV that excludes the others.
function groupDFOV(g) { return Math.max(2, (g.box.apR - g.box.apL) * scoutFov()); }
// The DFOV (scan box diameter) must fit inside the SFOV — shrink the box about its centre if it exceeds it.
function clampDfovToSfov(g) {
  const maxW = g.sfovMM / scoutFov();
  if (g.box.apR - g.box.apL > maxW) { const cx = (g.box.apL + g.box.apR) / 2; g.box.apL = cx - maxW / 2; g.box.apR = cx + maxW / 2; }
  if (g.box.latR - g.box.latL > maxW) { const cy = (g.box.latL + g.box.latR) / 2; g.box.latL = cy - maxW / 2; g.box.latR = cy + maxW / 2; }
}
// Per-reconstruction geometry: display-FOV radius R (the back-projected region),
// channel spacing ds, ray half-length rayR (how far the integration must reach —
// the full scan FOV for the fixed-pitch detector), and the detector mode m.
// Recon geometry. The RAYS integrate over the SFOV (not the DFOV) so anything inside the
// SFOV is fully captured — the DFOV only sets the reconstructed/back-projected circle.
// If rays stopped at the DFOV, a body wider than a small DFOV would be truncated → cupping.
function reconGeoM(fovMM, cx, cy, m, sfovMM) {
  const R = (fovMM / MM_PER_UNIT) / 2;                              // DFOV radius (backprojected region)
  const detSpan = m.fixedPitch ? m.nDet * m.chanMM : sfovMM;       // physical detector width (mm)
  const rayR = (Math.min(sfovMM, detSpan) / MM_PER_UNIT) / 2;      // ray half-length = SFOV/2 (capped by the detector)
  const ds = m.fixedPitch ? m.chanMM / MM_PER_UNIT : (rayR * 2) / m.nDet;   // channel spacing spans the SFOV
  // The SFOV (measured circle) is ALWAYS centred on the isocentre — the gantry rotates about it.
  // The DFOV (cx, cy) can be off-centre (GE targeted recon). ocx/ocy = DFOV-centre offset from the
  // isocentre, so back-projection can clip the recon to BOTH the DFOV disc and the isocentre SFOV.
  const sx = 0, sy = ISO_Y;
  return { fovMM, R, rayR, ds, cx, cy, sx, sy, ocx: cx - sx, ocy: cy - sy, m };
}
function reconGeo(fovMM, cx, cy, sfovMM) { return reconGeoM(fovMM, cx, cy, detMode(), sfovMM || 500); }
// Low-res detector used for the live scan PREVIEW (deliberately coarse so previews are
// cheap and visibly degraded; the full recon replaces them afterwards).
const PREVIEW_DET = { nDet: 64, nAngles: 44, gridN: 72, fixedPitch: false };
// Real-time reconstruction detector (fullRecon OFF): coarse projection so every slice
// reconstructs in a few ms even for a dense voxel phantom, but a full-size 128² image so
// the stored/scrolled slices don't look blocky. Streakier than a full quick recon (few
// angles), but it keeps the scan feeling instant — the whole point of the Quick preset.
const QUICK_RT = { nDet: 128, nAngles: 96, gridN: 128, fixedPitch: false, zSub: 1 };

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
    stopGantrySpin(); Sound.stopScan(); Sound.stopTableSound(); setProgress(null);
  }
  if (!alive()) return;
  setBusy(false);
  setPhase('done');
  resetToIsocentre();
  if (lastEntry) { S.ct.viewer.scanId = lastEntry.id; S.ct.viewer.slice = 0; ctx.setContent('slices'); }
  setHint('Scan complete — ' + S.ct.storage.length + ' scan(s) stored. Scroll the slices; ABORT to plan a new scan.');
}

// Auto-drive the couch to the reposition-button target (mediolateral, then height). The
// scan box is centred; the button-driven c.plan.targetX/targetY are the scan-centre offset.
async function repositionForGroup(i, alive) {
  const c = ctx.S.ct;
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

// Physical acquisition time for a group (seconds), clamped to a watchable range. Set by
// the scan geometry only — table feed = pitch × collimation (detector rows × element) per
// rotation, over the scan length — NOT by how long reconstruction takes.
function scanAnimSeconds(g) { return Math.max(2.5, Math.min(18, groupExpTime(g))); }

// One slice of a fast, low-resolution preview reconstruction (browser engine).
function previewReconSlice(setup, si, geo, h, mu) {
  const zw = setup.positions[si] / MM_PER_UNIT;
  // The live preview must be CHEAP: monochromatic mu (mu passed in with muMat stripped), a single
  // untilted ray, no aperture blur and no photon noise — regardless of the physics toggles. The
  // full reconstruction that follows applies the real physics.
  const sino = projectSlice(setup.phantom, zw, mu, 0, geo);
  const q = filterSino(sino, h, geo.ds, geo.m);
  return backproject(q, geo);
}

// Time-paced helical acquisition: advance the couch through the slice positions over the
// physical scan time (gantry spinning), painting a cheap DEGRADED preview of each slice as
// it is reached (marked PREVIEW). Independent of the full reconstruction, which runs in the
// background and resolves the images afterwards.
function animateHelicalScan(g, setup, alive) {
  const nz = setup.count, T = scanAnimSeconds(g) * 1000;
  const canPreview = !setup.phantom.geometryOnly;   // backend-only models have no browser volume to preview
  const pgeo = canPreview ? reconGeoM(setup.fovMM, setup.cx || 0, (setup.cy != null ? setup.cy : ISO_Y), PREVIEW_DET, setup.sfovMM) : null;
  const ph = canPreview ? buildKernel(pgeo.ds, pgeo.m.nDet, pgeo.m.fixedPitch) : null;
  const pmu = canPreview ? { ...setup.mu, muMat: null, bhc: null } : null;   // monochromatic (cheap preview)
  const pmeta = { gridN: PREVIEW_DET.gridN, fovMM: setup.fovMM, muWater: setup.muW };
  return new Promise(res => {
    const t0 = performance.now(); let lastSi = -1, lastPrev = 0, done = false, raf = 0, tmo = 0;
    const finish = () => { if (done) return; done = true; cancelAnimationFrame(raf); clearTimeout(tmo); res(); };
    // Drive the loop with BOTH rAF (smooth 60 fps when the pane is visible) and a setTimeout
    // fallback (keeps advancing when the pane is backgrounded and rAF is paused/throttled).
    // Whichever fires first runs step(), which cancels the other and reschedules. The frame is
    // time-paced by `now - t0`, so the scan always finishes at t0 + T regardless of tick rate.
    const kick = () => { if (done) return; cancelAnimationFrame(raf); clearTimeout(tmo); raf = requestAnimationFrame(step); tmo = setTimeout(step, 200); };
    function step() {
      if (done) return;
      cancelAnimationFrame(raf); clearTimeout(tmo);
      if (!alive()) { finish(); return; }
      const now = performance.now(), t = Math.min(1, (now - t0) / T);
      const si = Math.min(nz - 1, Math.floor(t * nz + 1e-6));
      if (si !== lastSi) {
        lastSi = si;
        moveCouchTo(setup.positions[si]);
        // Throttle the (still non-trivial) preview so its cost can NEVER stall the time-paced
        // animation: compute at most ~every 120 ms, and always for the final slice.
        if (canPreview && (now - lastPrev > 120 || si === nz - 1)) {
          lastPrev = now;
          try { drawScanPreview(previewReconSlice(setup, si, pgeo, ph, pmu), pmeta, si, nz, true); } catch (_) {}
        }
      }
      if (t < 1) kick(); else finish();
    }
    kick();
  });
}

// One group's exposure: breathe-in, then a time-paced helical acquisition showing degraded
// live previews (gantry spinning), while the full reconstruction runs in the background.
// After the acquisition, wait for the reconstruction to resolve (PREVIEW stays up), then
// reveal the fully computed slices, store, and breathe-normal.
async function scanGroupExposure(g, i, alive) {
  resetToIsocentre();
  setHint('G' + (i + 1) + ' · breathe in and hold…');
  Sound.play('breathIn');
  await sleep((Sound.duration('breathIn') || 2) * 1000); if (!alive()) return null;
  await sleep(700); if (!alive()) return null;
  setHint('G' + (i + 1) + ' · acquiring…');
  startGantrySpin(g.rotSpeed);
  Sound.startScan(ctx.S.ct.scanSound);
  const setup = scanSetup(g);
  // 1) time-paced acquisition: advance the couch + show cheap degraded previews (PREVIEW
  //    badge up), timed by the physical scan speed — NOT by reconstruction cost. Runs FIRST
  //    and alone so the previews stay smooth even when the full recon is heavy (a heavy
  //    browser recon would otherwise starve the animation thread).
  startPanelTimer(scanAnimSeconds(g));               // gantry panel timer counts down the acquisition
  await animateHelicalScan(g, setup, alive);
  stopPanelTimer();
  Sound.stopScan(); stopGantrySpin();          // acquisition finished; the gantry stops
  if (!alive()) { showPreviewBadge(false); return null; }
  // The scan MOTION is done — the patient can breathe normally now, while the computer
  // reconstructs in the background (the slices view is withheld until processing completes).
  resetToIsocentre();
  Sound.play('breathNormal');
  // 2) THEN the full-quality reconstruction resolves the images — the PREVIEW badge stays up
  //    (viewer is still showing the degraded preview) until the resolved slices are ready. A
  //    progress bar under the console tracks the reconstruction.
  setHint('G' + (i + 1) + ' · reconstructing…'); setProgress(0);
  const recon = await reconstructSlices(g, alive,
    (f) => { setHint('G' + (i + 1) + ' · reconstructing… ' + Math.round(f * 100) + '%'); setProgress(f); }, null, setup);
  setProgress(null);
  if (!alive() || !recon) { showPreviewBadge(false); return null; }
  // reveal the fully resolved final slice (clears the PREVIEW badge)
  drawScanPreview(recon.slices[recon.nz - 1].mu,
    { gridN: recon.gridN, fovMM: recon.fovMM, muWater: recon.muWater }, recon.nz - 1, recon.nz, false);
  const entry = storeScan(g, i, recon);
  return entry;
}

// Step the couch (bed + patient) to a table position (mm inferior) as its slice is acquired.
function moveCouchTo(d) {
  const three = ctx.three, S = ctx.S;
  S.ct.patient.z = tablePosToPatientZ(d);              // patient + couch step together
  S.ct.tablePos = d;
  three.handGroup.position.z = S.ct.patient.z; couch.position.z = S.ct.patient.z;
  updateCTReadouts();
}

// Paint the just-reconstructed transverse slice into the DR image viewer (#film), so
// the operator watches the images build during the scan (like the scout stitch). Uses
// the axial viewer's window; the render loop leaves #film alone while scanning.
function drawScanPreview(mu, meta, si, count, preview) {
  const f = ctx.$('film'); if (!f) return;
  const N = meta.gridN, muW = meta.muWater, v = ctx.S.ct.viewer;
  if (f.width !== N || f.height !== N) { f.width = N; f.height = N; }
  const g = f.getContext('2d'), im = g.createImageData(N, N), d8 = im.data;
  for (let iy = 0; iy < N; iy++) { const sy = N - 1 - iy;
    for (let ix = 0; ix < N; ix++) {
      const o = (iy * N + ix) * 4, m = mu[sy * N + ix];       // NaN = outside the reconstructed disc → black
      const val = Number.isNaN(m) ? 0 : Math.round(255 * huToGray(1000 * (m - muW) / muW, v.wl, v.ww));
      d8[o] = d8[o + 1] = d8[o + 2] = val; d8[o + 3] = 255;
    } }
  g.putImageData(im, 0, 0);
  const noexp = ctx.$('noexp'); if (noexp) noexp.style.display = 'none';
  const prog = ctx.$('prog'); if (prog) prog.style.width = Math.round((si + 1) / count * 100) + '%';
  showPreviewBadge(!!preview);   // yellow PREVIEW badge while the image is a degraded preview
}
// Toggle the yellow "PREVIEW" badge in the IMAGE/VIEWER monitor.
function showPreviewBadge(on) { const b = ctx.$('previewBadge'); if (b) b.classList.toggle('show', on); }

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

// Cone-beam z-divergence. The X-ray source is a point and the detector has multiple rows, so the
// rays fan out in z (the "cone"). A ray belonging to reconstructed slice z0 is therefore TILTED in
// z: it passes through z0 near isocentre but sweeps to z0 ± tanγ·(distance from iso) across the
// field. A dense object OFF the z0 plane is thus crossed by the tilted rays and streaks into slice
// z0 — strongest at the periphery (larger lever arm) and growing with the cone angle γ, where
// tanγ = (beam collimation / 2) / SAD. This is the physical cause of cross-slice metal artifacts.
// Returns cone rays as {k = z-slope, w = weight}; a single untilted ray (nSub=1 or no collimation)
// collapses to the old single-slice (SSCT) geometry. A z-uniform object leaves every ray's
// transmission unchanged, so HU and uniform regions are unaffected.
const ONE_RAY = [{ k: 0, dz: 0, w: 1 }];
const CT_SAD = 57.0;                 // source–axis distance, world units (570 mm)
// Each detector row contributes both a z-OFFSET (across the reconstructed slice thickness →
// partial-volume z-averaging) and a z-TILT (the cone divergence → cross-slice bleed). thkU sets
// the slice thickness; collimU (beam collimation) sets the cone angle. Returns rays {k, dz, w}.
function coneProfile(collimU, thkU, nSub) {
  const halfThk = thkU > 0 ? thkU / 2 : 0;                 // reconstructed slice half-thickness
  const tanG = collimU > 0 ? (collimU / 2) / CT_SAD : 0;   // cone half-angle tangent
  if (!(nSub > 1) || (halfThk === 0 && tanG === 0)) return ONE_RAY;
  const prof = []; let sum = 0;
  for (let i = 0; i < nSub; i++) {
    const zrow = -1 + 2 * i / (nSub - 1);                  // normalised detector row ∈ [-1, 1]
    const k = zrow * tanG;                                 // z-slope (cone tilt → cross-slice bleed)
    const dz = zrow * halfThk;                             // z-offset (slice thickness → partial volume)
    const w = Math.exp(-(zrow * 1.5) * (zrow * 1.5) / 2);  // beam profile across the collimation
    prof.push({ k, dz, w }); sum += w;
  }
  for (const s of prof) s.w /= sum;
  return prof;
}

// Forward-project one slice at world plane z = z0 → sinogram [angle][detector].
// cone (z-divergent rays) integrates the cone beam; omit for a single untilted ray.
function projectSlice(phantom, z0, mu, photons0, geo, cone) {
  // Rays fan out from the SFOV centre (the isocentre), NOT the DFOV centre — the measured field is
  // always centred on the rotation axis. An off-centre DFOV is handled purely in back-projection.
  const cx = (geo.sx != null ? geo.sx : geo.cx), cy = (geo.sy != null ? geo.sy : geo.cy);
  const RR = geo.rayR, ds = geo.ds, nDet = geo.m.nDet, nAng = geo.m.nAngles;
  const halfDet = (nDet - 1) / 2;
  const sino = new Float32Array(nAng * nDet);
  const poly = mu.voxel && mu.muMat;             // polyenergetic (beam-hardening) path for voxel models
  const muMat = poly ? mu.muMat : null, binW = poly ? mu.bins : null;
  const nb = poly ? binW.length : 0, nmat = poly ? muMat.length : 0, bhc = poly ? mu.bhc : null;
  const hid = poly ? new Int32Array(nmat) : null, hln = poly ? new Float64Array(nmat) : null;
  const cn = (cone && cone.length) ? cone : ONE_RAY;        // cone rays (z-divergent) integrated per detector sample
  const ncn = cn.length;
  for (let a = 0; a < nAng; a++) {
    const th = a * Math.PI / nAng, ct = Math.cos(th), st = Math.sin(th);
    const base = a * nDet;
    for (let k = 0; k < nDet; k++) {
      const r = (k - halfDet) * ds;
      // ray: origin at t = -rayR along the integration axis e_t = (-sin, cos); offset r along e_r = (cos, sin)
      const ox = cx + r * ct + RR * st, oy = cy + r * st - RR * ct;   // origin (x,y)
      // Integrate TRANSMISSION over the cone's rays: the detector sums photons over its z-rows, so
      // Tr = Σ w·exp(−∫μ) across the tilted rays (average T, not p). Each ray tilts in z by slope k,
      // centred on z0 at isocentre (t = RR), so it sweeps off-plane material near the periphery.
      // Averaging pre-log is what makes a sliver of metal on a tilted ray darken it → genuine
      // cross-slice streak bleed that grows with radius and cone angle.
      let Tr = 0;
      for (let ci = 0; ci < ncn; ci++) {
        const kz = cn[ci].k;
        const o = [ox, oy, z0 + cn[ci].dz - kz * RR];   // slice-thickness offset + cone tilt centred on z0 at iso
        const d = [-st, ct, kz];                        // z-divergent ray direction
        let Ts;
        if (poly) {
          // beam-hardened transmission: integrate over the spectrum (non-linear in path × μ)
          const L = phantom.trace(o, d, 2 * RR);
          let nh = 0; for (let m = 1; m < nmat; m++) { const lm = L[m]; if (lm) { hid[nh] = m; hln[nh] = lm; nh++; } }
          let T = 0;
          for (let b = 0; b < nb; b++) { let e = 0; for (let j = 0; j < nh; j++) e += muMat[hid[j]][b] * hln[j]; T += binW[b] * Math.exp(-e); }
          Ts = T;
        } else if (mu.voxel) {
          const L = phantom.trace(o, d, 2 * RR), arr = mu.arr; let pp = 0; for (let m = 1; m < arr.length; m++) { const lm = L[m]; if (lm) pp += arr[m] * lm; }
          Ts = Math.exp(-pp);
        } else {
          const { bone, soft, marrow } = phantom.trace(o, d, 2 * RR); Ts = Math.exp(-(mu.soft * soft + mu.bone * bone + mu.marrow * marrow));
        }
        Tr += cn[ci].w * Ts;
      }
      let p = -Math.log(Math.max(Tr, 1e-300));
      if (photons0 > 0) {                       // detector-domain quantum + electronic noise, with saturation clipping
        const Nfloor = photons0 * Math.exp(-SAT_P);   // detected photons at the saturation limit
        const Nexp = photons0 * Tr;                   // expected detected photons for this ray
        // Poisson (≈Normal for large N) quantum noise plus an electronic-noise term (Nfloor);
        // the electronic term only matters once the ray is photon-starved.
        let Nd = Nexp + Math.sqrt(Nexp + Nfloor * Nfloor) * gaussian();
        if (Nd < Nfloor) Nd = Nfloor;                 // clip: can't read below the noise floor -> line integral saturates
        p = -Math.log(Nd / photons0);                 // measured (noisy, saturated) line integral
        if (p < 0) p = 0;
      }
      if (bhc) p = bhc(p);                       // water beam-hardening correction (soft tissue linearised)
      sino[base + k] = p;
    }
  }
  return sino;
}

// Sinogram band-limiting from the finite X-ray source + detector aperture. Our recon rays are
// infinitely thin ideal samples, so metal edges are razor-sharp and the ramp filter amplifies
// them to the sampling Nyquist, backprojecting into a rigid streak crosshatch that real scanners
// never show. Two physical apertures band-limit a real acquisition; we restore both:
//
//   • RADIAL (channel axis) — the detector element integrates over a finite channel width and
//     the focal spot has finite size in-plane. Softens each streak's width. (APERTURE_SIGMA)
//   • AZIMUTHAL (view axis) — the tube fires continuously while the gantry rotates, so each
//     "view" integrates over a small rotation increment, and the focal spot has azimuthal
//     extent. This smears each streak across a RANGE of angles, so a sharp backprojected line
//     becomes a soft fan — turning the discrete crosshatch into the feathery, pointed "sun-ray"
//     streaks characteristic of real metal artifacts. (AZIMUTH_SIGMA)
//
// The blurs are low-frequency-preserving, so the broad inter-metal dark bands stay intact and
// there is no meaningful resolution loss (σ ≈ detector element size at iso).
const APERTURE_SIGMA = 1.0;                  // radial aperture, in channels
const AZIMUTH_SIGMA  = 1.6;                  // azimuthal aperture, in views (feathers streaks)

function gaussWeights(sigma) {
  const rad = Math.max(1, Math.ceil(3 * sigma));
  const w = new Float64Array(2 * rad + 1); let sum = 0;
  for (let n = -rad; n <= rad; n++) { const v = Math.exp(-(n * n) / (2 * sigma * sigma)); w[n + rad] = v; sum += v; }
  for (let i = 0; i < w.length; i++) w[i] /= sum;
  return { w, rad };
}
// Blur the sinogram along the channel axis (radial detector/focal-spot aperture).
function apertureBlur(sino, m) {
  if (APERTURE_SIGMA <= 0) return sino;
  const { w, rad } = gaussWeights(APERTURE_SIGMA);
  const N = m.nDet, out = new Float32Array(sino.length);
  for (let a = 0; a < m.nAngles; a++) {
    const base = a * N;
    for (let k = 0; k < N; k++) {
      let acc = 0;
      for (let n = -rad; n <= rad; n++) { let kk = k + n; if (kk < 0) kk = 0; else if (kk >= N) kk = N - 1; acc += sino[base + kk] * w[n + rad]; }
      out[base + k] = acc;
    }
  }
  return out;
}
// Blur the sinogram along the view axis (azimuthal source/rotation aperture) → feathery fans.
function azimuthalBlur(sino, m) {
  if (AZIMUTH_SIGMA <= 0) return sino;
  const { w, rad } = gaussWeights(AZIMUTH_SIGMA);
  const N = m.nDet, A = m.nAngles, out = new Float32Array(sino.length);
  for (let a = 0; a < A; a++) {
    for (let k = 0; k < N; k++) {
      let acc = 0;
      for (let n = -rad; n <= rad; n++) { let aa = a + n; if (aa < 0) aa = 0; else if (aa >= A) aa = A - 1; acc += sino[aa * N + k] * w[n + rad]; }
      out[a * N + k] = acc;
    }
  }
  return out;
}
// Both apertures, applied before the ramp filter.
function sinoBlur(sino, m) { return azimuthalBlur(apertureBlur(sino, m), m); }

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
  const px2world = (i) => (-R + (i + 0.5) * (2 * R / N));   // pixel centre → offset from the DFOV centre
  // The reconstructed image is a CIRCLE, not a masked square. A pixel is reconstructed only where it
  // sits inside BOTH: the DFOV disc (radius R, centred on the DFOV centre) AND the SFOV (radius rayR,
  // centred on the ISOCENTRE — the measured field). ocx/ocy = the DFOV-centre offset from the
  // isocentre, so an off-centre (GE) DFOV that pokes past the SFOV shows black there — that anatomy
  // was never scanned, so the recon literally has no data for it. Pixels outside are marked NaN and
  // every consumer renders no-data as black. (Rays still integrate the full SFOV → no cupping.)
  const dfovR2 = R * R, sfovR2 = geo.rayR * geo.rayR, ocx = geo.ocx || 0, ocy = geo.ocy || 0;
  for (let a = 0; a < nAng; a++) {
    const th = a * Math.PI / nAng, ct = Math.cos(th), st = Math.sin(th), base = a * nDet;
    for (let iy = 0; iy < N; iy++) {
      const gy = px2world(iy), rowo = iy * N, wyi = gy + ocy;
      for (let ix = 0; ix < N; ix++) {
        const gx = px2world(ix);
        if (gx * gx + gy * gy > dfovR2) continue;              // outside the DFOV disc
        const wxi = gx + ocx;
        if (wxi * wxi + wyi * wyi > sfovR2) continue;          // outside the measured SFOV (isocentre-centred)
        const kf = (wxi * ct + wyi * st) / ds + halfDet;       // detector coord is relative to the isocentre
        const k0 = Math.floor(kf);
        if (k0 < 0 || k0 >= nDet - 1) continue;
        const f = kf - k0;
        img[rowo + ix] += q[base + k0] * (1 - f) + q[base + k0 + 1] * f;
      }
    }
  }
  const scale = Math.PI / nAng;
  for (let iy = 0; iy < N; iy++) {
    const gy = px2world(iy), rowo = iy * N, wyi = gy + ocy;
    for (let ix = 0; ix < N; ix++) {
      const gx = px2world(ix), wxi = gx + ocx;
      const inFov = (gx * gx + gy * gy <= dfovR2) && (wxi * wxi + wyi * wyi <= sfovR2);
      img[rowo + ix] = inFov ? img[rowo + ix] * scale : NaN;   // outside DFOV∩SFOV = not reconstructed
    }
  }
  return img;
}

// Shared geometry/material/position setup for a group's reconstruction — computed once
// and reused by both the live preview and the full-quality recon so they sweep the same
// anatomy. slice table positions are landmark-relative (scanStart + box fraction · length)
// so the recon reconstructs exactly the anatomy the box selects on the scout.
// Water beam-hardening correction: build C(p_poly) → p_mono so a pure-water path is
// linearised (removes cupping for soft tissue). Bone and especially METAL have a very
// different spectral response, so C mis-corrects them → the projections are inconsistent
// and FBP throws the characteristic dark bands + streaks between dense objects. This is
// the same "water correction" a real scanner applies, and why real CT shows metal
// artifacts but not soft-tissue cupping.
function buildWaterBHC(binW, muWbins, muWeff) {
  const n = 320, Lmax = 60;                      // up to 60 cm of water (a large body)
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const L = Lmax * i / (n - 1);
    let T = 0; for (let b = 0; b < binW.length; b++) T += binW[b] * Math.exp(-muWbins[b] * L);
    xs[i] = -Math.log(Math.max(T, 1e-300));      // measured (hardened) integral for water path L
    ys[i] = muWeff * L;                          // ideal monochromatic integral
  }
  const slope = (ys[n - 1] - ys[n - 2]) / Math.max(xs[n - 1] - xs[n - 2], 1e-9);
  return (p) => {
    if (p <= xs[0]) return Math.max(0, p);
    if (p >= xs[n - 1]) return ys[n - 1] + slope * (p - xs[n - 1]);   // extrapolate (bone/metal)
    let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= p) lo = m; else hi = m; }
    const t = (p - xs[lo]) / (xs[hi] - xs[lo]); return ys[lo] + t * (ys[hi] - ys[lo]);
  };
}

function scanSetup(g) {
  const spec = Spectrum.make(g.kv), bins = spec.bins, effE = spec.meanE;
  const phantom = ctx.buildPhantom();            // built at the committed table position (patient.z = isoZ)
  const voxel = !!phantom.voxel;                 // chest (voxel/BodyMaterials) vs hand (analytic)
  const muWeff = BodyMaterials.muWater(effE);
  // Voxel subjects use a POLYENERGETIC forward projection (integrate transmission over the
  // spectrum) + the water beam-hardening correction, so beam hardening emerges. The
  // analytic hand stays monochromatic (no metal, keep its old calibration). `arr` is the
  // monochromatic table still sent to the GPU backend.
  const binW = bins.map(b => b.w);
  const muWbins = voxel ? bins.map(b => BodyMaterials.muWater(b.E)) : null;
  const mu = voxel
    ? { voxel: true, arr: muAtEnergy(effE), bins: binW, muMat: muOverBins(bins), muWbins, muWeff,
        bhc: buildWaterBHC(binW, muWbins, muWeff) }
    : { soft: Materials.mu('soft', effE), bone: Materials.mu('bone', effE), marrow: Materials.mu('marrow', effE) };
  const muW = voxel ? muWeff : mu.soft;          // HU reference (water for voxel, soft for hand)
  const fovMM = groupDFOV(g);                     // DFOV = scan box diameter
  // Off-centre DFOV targeting — the reconstruction disc centres on the planned scan centre, which
  // each vendor expresses differently:
  //   GE    → the box is dragged off-centre; its position IS the DFOV offset (couch never moves).
  //   Canon → the box is locked; the reposition offset that hasn't been realised by a table move
  //           (target − committed) is applied as the recon-FOV offset.
  // (+x = patient-right, +y = anterior; a posterior/right centre reads P/R.)
  const doff = dfovOffsetMM(g);
  const cx = doff.ml / MM_PER_UNIT;
  const cy = ISO_Y - doff.ap / MM_PER_UNIT;
  const off = scanStartMM();
  const startMM = off + g.box.top * ctx.S.ct.scanLen, endMM = off + g.box.bot * ctx.S.ct.scanLen, span = endMM - startMM;
  const count = Math.max(1, Math.min(MAX_SLICES, groupImages(g)));   // one slice per planned image
  const positions = [];
  for (let i = 0; i < count; i++) positions.push(count > 1 ? startMM + span * i / (count - 1) : startMM + span / 2);
  return { effE, phantom, voxel, mu, muW, fovMM, cx, cy, sfovMM: g.sfovMM || 500, positions, count };
}
// Detected photons per sinogram sample for a given geometry. The quick detector is the
// noise reference; more views split the same tube output into smaller buckets. The
// realistic detector's finer channels pair with its apodized (Shepp-Logan) kernel.
// Tube fluence rises ~kVp² at fixed mAs, so higher kVp delivers more photons → fewer
// photon-starved (metal) rays. Together with the harder spectrum (less beam hardening +
// better metal penetration, handled in scanSetup), this reproduces the clinical result
// that raising kVp reduces metal artifacts.
function photonsFor(g, geo) {
  return (geo.m.photonBase || PHOTON_BASE) * (g.ma / 300) * (g.rotSpeed / 0.5) * (groupBaseThk(g) / 5)
    * Math.pow(g.kv / 120, 2)                              // fluence ∝ kVp² (120 kVp = reference)
    * (DET_MODES.quick.nAngles / geo.m.nAngles);
}

async function reconstructSlices(g, alive, onProgress, onSlice, setup) {
  setup = setup || scanSetup(g);
  const { phantom, voxel, muW, fovMM, sfovMM, positions, count, effE } = setup;
  // Physics features are individually toggleable (Detector window). Each adds recon cost:
  //   beamHardening → polyenergetic projection (× spectral bins); off = monochromatic.
  //   coneBeam      → z-divergent cone rays (× zSub); off = a single untilted ray (SSCT).
  //   focalBlur     → aperture + azimuthal sinogram blur (feathery streaks); off = skipped.
  //   quantumNoise  → photon statistics + saturation clipping; off = noiseless (photons0 = 0).
  const feat = ctx.S.ct.features || {};
  const bh = !!feat.beamHardening, blurOn = !!feat.focalBlur;
  const mu = bh ? setup.mu : { ...setup.mu, muMat: null, bhc: null };   // strip poly data when beam hardening is off
  // fullRecon off → reconstruct at the coarse PREVIEW detector (real-time, low quality) instead
  // of the selected detector; keeps the scan feeling instant when only a quick look is needed.
  const recMode = feat.fullRecon === false ? QUICK_RT : detMode();
  const geo = reconGeoM(fovMM, setup.cx || 0, (setup.cy != null ? setup.cy : ISO_Y), recMode, sfovMM);
  const photons0 = feat.quantumNoise ? photonsFor(g, geo) : 0;
  const cone = feat.coneBeam ? coneProfile(g.beamColl / MM_PER_UNIT, groupBaseThk(g) / MM_PER_UNIT, geo.m.zSub || 1) : ONE_RAY;
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
                     cx: geo.cx, cy: geo.cy, ocx: geo.ocx, ocy: geo.ocy, nDet: geo.m.nDet, nAngles: geo.m.nAngles, gridN: N,
                     ds: geo.ds, rayR: geo.rayR, dfovR: geo.R,
                     kernel: geo.m.fixedPitch ? 'shepp' : 'ramlak',
                     rot: phantom.rot ? Array.from(phantom.rot) : null,
                     muArr: Array.from(mu.arr), photons0,
                     // cone rays: [k = z-slope (cone tilt), dz = z-offset (slice thickness), weight]
                     coneRays: cone.map(s => [s.k, s.dz, s.w]),
                     focalBlur: blurOn };
      // polyenergetic beam-hardening data (only when the feature is on → GPU takes the poly path)
      if (bh) { base.binsW = mu.bins; base.muMat = mu.muMat.map(r => Array.from(r));
                base.muWbins = Array.from(mu.muWbins); base.muWeff = mu.muWeff; }
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
      if (phantom.geometryOnly) {   // no browser volume — cannot reconstruct locally
        setBusy(false); stopGantrySpin(); Sound.stopScan();
        setHint('⚠ This model needs the Python GPU backend, which is not reachable.');
        return null;
      }
      console.warn('GPU backend reconstruction failed — falling back to the browser engine', err);
      setHint('Python backend unavailable — reconstructing in the browser…');
    }
  }
  if (!done && !phantom.geometryOnly) {
    const h = buildKernel(geo.ds, geo.m.nDet, geo.m.fixedPitch);
    for (let si = 0; si < nz; si++) {
      if (!alive()) return null;
      const zw = positions[si] / MM_PER_UNIT;    // world plane for this slice (see scoutProjection geometry)
      const sino = projectSlice(phantom, zw, mu, photons0, geo, cone);
      const q = filterSino(blurOn ? sinoBlur(sino, geo.m) : sino, h, geo.ds, geo.m);
      const img = backproject(q, geo);
      vol.set(img, si * N * N);
      if (onSlice) onSlice(si, nz, positions[si], img, meta);
      if (onProgress) onProgress((si + 1) / nz);
      await sleep(0);                            // yield so the couch + preview repaint between slices
    }
  }
  const slices = positions.map((d, i) => ({ d, mu: vol.subarray(i * N * N, (i + 1) * N * N) }));
  const dz = nz > 1 ? (positions[nz - 1] - positions[0]) / (nz - 1) : groupBaseInterval(g);
  return { slices, vol, nz, gridN: N, fovMM, z0: positions[0], dz, centerY: geo.cy, muWater: muW, effE };
}

// ---- image storage ----
function tstamp() { try { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (_) { return ''; } }

function storeScan(g, i, recon) {
  const S = ctx.S, id = S.ct.nextScanId++;
  const el = acqThkOf(g);                          // detector element = minimum recon thickness
  const entry = {
    id, label: 'Scan ' + id + ' · G' + (i + 1), ts: tstamp(),
    params: { kv: g.kv, ma: g.ma, sliceThk: groupBaseThk(g), pitch: g.pitch, interval: groupBaseInterval(g), rotSpeed: g.rotSpeed, acqThk: el, detRows: g.detRows, beamColl: g.beamColl },
    gridN: recon.gridN, fovMM: recon.fovMM, muWater: recon.muWater, effE: recon.effE, slices: recon.slices,
    // full volume + geometry for multiplanar resampling
    vol: recon.vol, nz: recon.nz, z0: recon.z0, dz: recon.dz, centerY: recon.centerY,
    // Store EVERY planned reconstruction from the group's recon table (plane / thickness /
    // interval / algorithm / MAR / window / sub-range), so each is available to view later.
    // They reformat the one stored transverse volume (like a real MPR workstation).
    recons: groupRecons(g).map((r, k) => ({
      id: k + 1,
      name: rpPlaneLabel(r.plane) + ' · ' + fmtNum(Math.max(r.thk, el)) + ' mm · ' + rpAlgoLabel(r.algo) + (r.mar ? ' · MAR' : ''),
      plane: r.plane, pane: RP_PLANE_PANE[r.plane] || 'axial',
      dfov: recon.fovMM, offRL: 0, offAP: 0,
      thk: Math.max(r.thk, el), interval: r.interval, algo: r.algo, mar: !!r.mar,
      ww: r.ww, wl: r.wl, subTop: r.subTop, subBot: r.subBot, minThk: el,
      // only recon 1 is "computed" up front (it's what the slice viewer shows); the recon page
      // offers to compute + cache the rest, or discard them (see maybeReconComputePrompt).
      computed: k === 0,
    })),
    nextReconId: groupRecons(g).length + 1,
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
  for (let iy = 0; iy < N; iy++) {
    const srcY = N - 1 - iy;                     // flip so +world-y is at the top of the image
    for (let ix = 0; ix < N; ix++) {
      const o = (iy * N + ix) * 4;
      const mu = sl.mu[srcY * N + ix];
      // NaN = outside the reconstructed disc (never back-projected) → black. The circular field
      // of view is the shape of the reconstructed data itself, not a mask drawn over a square.
      const val = Number.isNaN(mu) ? 0 : Math.round(255 * huToGray(1000 * (mu - muW) / muW, wl, ww));
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
    '<span>DFOV ' + (scan.fovMM / 10).toFixed(1) + ' cm · ' + scan.params.sliceThk + ' mm · ' + scan.params.kv + ' kV</span>' +
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
  updateCtHistogram(scan, sl, v.wl, v.ww);
  if (slider) { slider.max = scan.slices.length - 1; slider.value = v.slice; slider.disabled = scan.slices.length < 2; }
  updateViewerInfo(scan, sl);
}

// Slice HU histogram (fixed −1000…2000 axis, matching the sliders) with the current
// window/level ramp overlaid, so the operator sees where the window sits on the data.
function updateCtHistogram(scan, sl, wl, ww) {
  const cv = ctx.$('ctHist'); if (!cv || !ctx.drawHistogram) return;
  if (!ctx.S.showHist || !scan || !sl) { cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); return; }
  const N = scan.gridN, muW = scan.muWater;
  const HLO = -1000, HHI = 2000, span = HHI - HLO, hist = new Uint32Array(256);
  for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
    const mu = sl.mu[iy * N + ix]; if (Number.isNaN(mu)) continue;   // outside the reconstructed disc
    const hu = 1000 * (mu - muW) / muW;
    let b = Math.round((hu - HLO) / span * 255); hist[b < 0 ? 0 : b > 255 ? 255 : b]++;
  }
  const lo = wl - ww / 2;
  ctx.drawHistogram(cv, hist, t => { const hu = HLO + t * span; return (hu - lo) / ww; }, ['-1000', '500 HU', '2000']);
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
  if (algo === 'mip') return acc === -Infinity ? NaN : acc;
  if (algo === 'minip') return acc === Infinity ? NaN : acc;
  return cnt ? acc / cnt : NaN;                     // no reconstructed samples in the slab → no data
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
      data[j * w + i] = prm.algo === 'mip' ? (acc === -Infinity ? NaN : acc) : prm.algo === 'minip' ? (acc === Infinity ? NaN : acc) : (cnt ? acc / cnt : NaN);
    }
  }
  if (prm.algo === 'blur') data = filter2D(data, w, h, 'blur');
  else if (prm.algo === 'edge') data = filter2D(data, w, h, 'edge');
  if (prm.mar) applyMAR(data, w, h, scan.muWater);
  return { data, w, h };
}
// Reformat one slice of a WINDOW-bound reconstruction at scroll position `pos`. Dispatches on the
// recon's pane: an orthogonal recon reformats its plane at `pos`; an oblique recon (carrying a
// stored plane basis `recon.ob`) samples that arbitrary plane offset `pos` along its normal.
function reconSliceImage(scan, recon, pos, prm) {
  if (recon.pane === 'oblique' && recon.ob) return obliqueImageBasis(scan, recon.ob, pos, prm);
  return paneImage(scan, recon.pane || 'axial', winCur(scan, recon, pos), prm);
}
// Sample an arbitrary oblique plane defined by basis `ob` = { u, v, n, C(centred coords), fov, vExt },
// shifted `pos` mm along its normal. Mirrors paneImage's oblique branch but reads a per-recon basis.
function obliqueImageBasis(scan, ob, pos, prm) {
  const g = mprGeom(scan), N = g.N, zc = g.z0 + g.zExt / 2;
  const fov = ob.fov, vExt = ob.vExt, pu = fov / N;
  const w = N, h = clampV(Math.round(N * vExt / fov), 16, 512), pv = vExt / h;
  const ns = Math.max(1, Math.round(prm.thk / pu));
  const Cx = ob.C[0] + pos * ob.n[0], Cy = ob.C[1] + pos * ob.n[1], Cd = ob.C[2] + pos * ob.n[2];
  let data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const su = (i - (N - 1) / 2) * pu, sv = ((h - 1) / 2 - j) * pv;
    let acc = prm.algo === 'mip' ? -Infinity : prm.algo === 'minip' ? Infinity : 0, cnt = 0;
    for (let k = 0; k < ns; k++) {
      const so = (k - (ns - 1) / 2) * pu;
      const Px = Cx + su * ob.u[0] + sv * ob.v[0] + so * ob.n[0];
      const Py = Cy + su * ob.u[1] + sv * ob.v[1] + so * ob.n[1];
      const Pd = Cd + su * ob.u[2] + sv * ob.v[2] + so * ob.n[2];
      const val = sampleVol(scan, Px, Py, zc + Pd);
      if (isNaN(val)) continue;
      if (prm.algo === 'mip') acc = Math.max(acc, val); else if (prm.algo === 'minip') acc = Math.min(acc, val); else { acc += val; cnt++; }
    }
    data[j * w + i] = prm.algo === 'mip' ? (acc === -Infinity ? NaN : acc) : prm.algo === 'minip' ? (acc === Infinity ? NaN : acc) : (cnt ? acc / cnt : NaN);
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
    const v = src[y * w + x];
    if (Number.isNaN(v)) { out[y * w + x] = NaN; continue; }          // keep no-data holes
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
      const u = src[yy * w + xx]; if (Number.isNaN(u)) continue; s += u; n++;
    }
    const blur = n ? s / n : v;
    out[y * w + x] = kind === 'blur' ? blur : v + 0.9 * (v - blur);   // edge = unsharp mask
  }
  return out;
}
// Light metal-artifact reduction: cap extreme (metal) μ and blend with the local mean
// so the bright blooming + streaks around dense objects are softened.
function applyMAR(data, w, h, muW) {
  const cap = muW * 2.6;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (Number.isNaN(data[i]) || data[i] <= cap) continue;
    let s = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
      const u = data[yy * w + xx]; if (Number.isNaN(u)) continue; s += Math.min(u, cap); n++;
    }
    if (n) data[i] = 0.5 * cap + 0.5 * (s / n);
  }
}
function drawReconData(cv, res, muW, wl, ww) {
  const { data, w, h } = res;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d'), im = g.createImageData(w, h), d8 = im.data;
  for (let i = 0; i < data.length; i++) {
    const m = data[i], o = i * 4;                 // NaN = outside the reconstructed disc → black
    const v = Number.isNaN(m) ? 0 : Math.round(255 * huToGray(1000 * (m - muW) / muW, wl, ww));
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
const WINS = [0, 1, 2, 3];                                    // four independent recon windows
const algoLabel = (a) => (RECON_ALGOS.find(x => x[0] === a) || RECON_ALGOS[0])[1];
const scanMinThk = (scan) => (scan.recons && scan.recons[0] ? scan.recons[0].minThk : scan.params.acqThk) || 0.625;

// The recon object currently shown in window wi (saved or newly-created), or null (empty window).
function winRecon(wi) { const w = ctx.S.ct.mpr.wins[wi]; return (w && w.recon) || null; }
// Scroll axis + range (mm) for a recon's plane: which cross-reference coord its slices step along.
function winAxis(scan, recon) {
  const g = mprGeom(scan);
  if (recon.pane === 'oblique') { const r = (recon.ob && recon.ob.range) || g.fov; return { axis: 'n', lo: -r / 2, hi: r / 2, step: Math.max(recon.interval || scan.dz, 0.5) }; }   // scroll along the plane normal, bounded by the box width
  if (recon.pane === 'coronal') return { axis: 'y', lo: -scan.fovMM / 2, hi: scan.fovMM / 2, step: Math.max(recon.interval || scan.dz, 0.5) };
  if (recon.pane === 'sagittal') return { axis: 'x', lo: -scan.fovMM / 2, hi: scan.fovMM / 2, step: Math.max(recon.interval || scan.dz, 0.5) };
  return { axis: 'z', lo: g.z0, hi: g.z0 + g.zExt, step: Math.max(recon.interval || scan.dz, scan.dz) };   // axial
}
const winMid = (scan, recon) => { const a = winAxis(scan, recon); return (a.lo + a.hi) / 2; };
// Build a cross-reference point for a window's current scroll position (the other axes centred).
function winCur(scan, recon, pos) {
  const g = mprGeom(scan), cur = { x: 0, y: 0, z: g.z0 + (scan.nz - 1) * scan.dz / 2 };
  cur[winAxis(scan, recon).axis] = pos; return cur;
}
function winPosLabel(recon, pos) {
  if (recon.pane === 'oblique') return (pos >= 0 ? '+' : '') + Math.round(pos) + ' mm';
  if (recon.pane === 'coronal') return 'A/P ' + (pos >= 0 ? '+' : '') + Math.round(pos) + ' mm';
  if (recon.pane === 'sagittal') return 'R/L ' + (pos >= 0 ? '+' : '') + Math.round(pos) + ' mm';
  return fmtTablePos(pos) + ' mm';
}
// Populate the four windows for a freshly-viewed scan: window 0 = the first reconstruction (recon 1,
// the only one computed by default). A planned coronal / sagittal recon is shown in window 1 / 2
// ONLY once it has been computed (via the compute prompt) — an un-computed recon is never rendered
// (it would otherwise reformat-on-open and show before the user chose to compute it). Independent
// windows — each is a static view, scroll re-renders only itself.
function initMprForScan(scan) {
  const m = ctx.S.ct.mpr, recons = scan.recons || [];
  m.scanId = scan.id;
  if (m.plan) { m.plan = null; const live = ctx.$('ctReconPlanLive'); if (live) { live.classList.remove('show'); live.innerHTML = ''; } }
  const bind = (r) => r ? { recon: r, pos: winMid(scan, r), saved: true } : null;
  const first = recons[0] || null;
  const coronal = recons.find(r => r.pane === 'coronal' && r !== first && r.computed) || null;
  const sagittal = recons.find(r => r.pane === 'sagittal' && r !== first && r.computed) || null;
  m.wins = [bind(first), bind(coronal), bind(sagittal), null];
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
  if (!scan) {
    if (empty) empty.style.display = 'flex';
    WINS.forEach(wi => { const c = ctx.$('mprCanvas_' + wi); if (c) { c.width = c.height = 2; c.getContext('2d').clearRect(0, 0, 2, 2); } const p = ctx.$('mprWin_' + wi); if (p) p.classList.remove('filled'); });
    return;
  }
  if (empty) empty.style.display = 'none';
  if (S.ct.mpr.scanId !== scan.id || !Array.isArray(S.ct.mpr.wins)) initMprForScan(scan);
  S.ct.mpr.scanId = scan.id;
  WINS.forEach(wi => drawReconWindow(scan, wi));
  maybeReconComputePrompt(scan);
}
// Pre-compute a recon's full slice series by reformatting the stored volume once per slice, and
// cache it so scrolling just indexes stored slices (no live reformat). Cheap — samples scan.vol.
function precomputeRecon(scan, recon) {
  if (recon.cache) return;
  const a = winAxis(scan, recon), pane = recon.pane || 'axial';
  const prm = { thk: Math.max(recon.minThk || 0.625, recon.thk || 5), interval: recon.interval, algo: recon.algo || 'standard', mar: !!recon.mar };
  const positions = []; for (let p = a.lo; p <= a.hi + 1e-6; p += a.step) positions.push(p);
  const slices = positions.map(p => { const img = reconSliceImage(scan, recon, p, prm); return { data: img.data, w: img.w, h: img.h }; });
  recon.cache = { positions, slices }; recon.computed = true;
}
// On opening the recon page, offer to compute the extra planned recons (Yes → compute + store) or
// discard them down to the default (No → second confirmation → remove). Asked once per scan.
function maybeReconComputePrompt(scan) {
  const m = ctx.S.ct.mpr;
  const uncomputed = (scan.recons || []).filter(r => r.computed === false);
  if (!uncomputed.length || m.promptedScan === scan.id) return;
  m.promptedScan = scan.id;
  reconPopup(uncomputed.length + ' more reconstruction(s) were planned but not yet computed. Compute them now?',
    [{ label: 'Yes — compute & store them', v: 'yes' }, { label: 'No — remove the extras', v: 'no' }], (opt) => {
      if (opt.v === 'yes') {
        setHint('Computing reconstructions…'); uncomputed.forEach(r => precomputeRecon(scan, r));
        // extras are now computed — re-populate the windows so a coronal / sagittal recon fills
        // window 1 / 2 (initMprForScan only binds computed recons).
        m.wins = null; ctRenderRecons(); setHint(uncomputed.length + ' reconstruction(s) computed and stored.');
      } else {
        reconPopup('This removes all planned reconstructions except the default (recon 1). Continue?',
          [{ label: 'Yes — remove them', v: 'yes' }, { label: 'Cancel', v: 'no' }], (o2) => {
            if (o2.v !== 'yes') return;
            scan.recons = (scan.recons || []).slice(0, 1); ctx.S.ct.mpr.wins = null; ctRenderRecons();
            setHint('Extra planned reconstructions removed.');
          });
      }
    });
}
// Render one recon window: its bound recon reformatted ONCE at the window's scroll position — a
// static view, nothing else re-renders. Empty windows show their New / Select overlay (via CSS).
let _off = null;
function drawReconWindow(scan, wi) {
  const paneEl = ctx.$('mprWin_' + wi), cv = ctx.$('mprCanvas_' + wi); if (!cv || !paneEl) return;
  const recon = winRecon(wi), w = ctx.S.ct.mpr.wins[wi];
  const rect = cv.getBoundingClientRect(), W = Math.max(2, Math.round(rect.width)), H = Math.max(2, Math.round(rect.height));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  paneEl.classList.toggle('filled', !!recon);
  const lbl = paneEl.querySelector('.mpr-lbl');
  if (!recon) { if (lbl) lbl.textContent = ''; return; }
  if (w.pos == null) w.pos = winMid(scan, recon);
  const pane = recon.pane || 'axial';
  const prm = { thk: Math.max(recon.minThk || 0.625, recon.thk || 5), interval: recon.interval, algo: recon.algo || 'standard', mar: !!recon.mar };
  // A pre-computed recon presents its stored slices directly (index by scroll position); otherwise
  // it reformats the base volume on the fly (still fast — the base volume is already in memory).
  let img;
  if (recon.cache && recon.cache.slices.length) {
    const c = recon.cache, dp = (c.positions[1] - c.positions[0]) || 1;
    img = c.slices[clampV(Math.round((w.pos - c.positions[0]) / dp), 0, c.slices.length - 1)];
  } else { img = reconSliceImage(scan, recon, w.pos, prm); }
  if (!_off) _off = document.createElement('canvas');
  if (_off.width !== img.w || _off.height !== img.h) { _off.width = img.w; _off.height = img.h; }
  const octx = _off.getContext('2d'), oi = octx.createImageData(img.w, img.h), d8 = oi.data, muW = scan.muWater;
  const wl = recon.wl != null ? recon.wl : 60, ww = recon.ww != null ? recon.ww : 800;
  for (let i = 0; i < img.data.length; i++) { const v = img.data[i]; const val = Number.isNaN(v) ? 0 : Math.round(255 * huToGray(1000 * (v - muW) / muW, wl, ww)); const o = i * 4; d8[o] = d8[o + 1] = d8[o + 2] = val; d8[o + 3] = 255; }
  octx.putImageData(oi, 0, 0);
  // Oblique images have their own aspect (spanned by the plane basis), so letterbox the image
  // directly; orthogonal panes use the shared physical mapping (needed by the planner overlay).
  let map;
  if (pane === 'oblique') {
    const sc = Math.min(W / img.w, H / img.h), dw = img.w * sc, dh = img.h * sc;
    map = { dx: (W - dw) / 2, dy: (H - dh) / 2, dw, dh };
  } else map = paneMapping(scan, pane, cv);
  g.imageSmoothingEnabled = true; g.drawImage(_off, map.dx, map.dy, map.dw, map.dh);
  const plabel = pane === 'oblique' ? (recon.obliqueLabel || 'OBLIQUE') : PLANE_LABEL[pane];
  if (lbl) lbl.textContent = plabel + '  ·  ' + winPosLabel(recon, w.pos) + '  ·  ' + fmtNum(prm.thk) + 'mm  ·  ' + algoLabel(prm.algo) + (prm.mar ? ' · MAR' : '') + (w.saved === false ? '  ·  UNSAVED' : '') + '  ·  W/L ' + Math.round(ww) + '/' + Math.round(wl);
  // Draw the New-recon planner localizer on its source window (orthogonal pane only).
  const m = ctx.S.ct.mpr;
  if (m.plan && m.plan.src === wi && pane !== 'oblique') drawPlannerOverlay(g, scan, map);
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
  const m = ctx.S.ct.mpr, ob = m.ob, c = Math.cos(ob.ang), s = Math.sin(ob.ang), hl = ob.fov / 2;
  const halfW = Math.max(4, m.thk / 2);                    // slab half-width (mm) shown as the box depth
  // corners of the oblique SLAB box (length = FOV along the plane, width = slab thickness)
  const corner = (u, v) => obDisp(scan, pane, map, ob.cu + c * u - s * v, ob.cv + s * u + c * v);
  const p1 = corner(hl, halfW), p2 = corner(hl, -halfW), p3 = corner(-hl, -halfW), p4 = corner(-hl, halfW);
  const e1 = obDisp(scan, pane, map, ob.cu + c * hl, ob.cv + s * hl);   // current-slice line ends
  const e2 = obDisp(scan, pane, map, ob.cu - c * hl, ob.cv - s * hl);
  const nt = obDisp(scan, pane, map, ob.cu - s * ob.fov * 0.16, ob.cv + c * ob.fov * 0.16);   // normal tick
  g.save();
  // teal box (like the scan-planning box)
  g.strokeStyle = '#35c6d6'; g.fillStyle = 'rgba(53,198,214,0.12)'; g.lineWidth = 1.6;
  g.beginPath(); g.moveTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.lineTo(p3[0], p3[1]); g.lineTo(p4[0], p4[1]); g.closePath(); g.fill(); g.stroke();
  line(g, corner(0, 0)[0], corner(0, 0)[1], nt[0], nt[1]);   // normal tick (slice-advance direction)
  // red line marking the currently displayed oblique slice
  g.strokeStyle = '#ff4d4d'; g.lineWidth = 1.6; line(g, e1[0], e1[1], e2[0], e2[1]);
  // end handles (grab to rotate + scale)
  g.fillStyle = '#35c6d6'; [e1, e2].forEach(pt => { g.beginPath(); g.arc(pt[0], pt[1], 4.5, 0, Math.PI * 2); g.fill(); });
  g.restore();
}

// ---- interaction ----
// Scroll the SELECTED window(s) through their slices — only those windows re-render. If nothing is
// selected, scroll the window under the cursor. (Select windows by clicking; shift/ctrl multi-select.)
function onWinWheel(e, wi) {
  e.preventDefault(); const scan = mprScan(); if (!scan) return;
  const m = ctx.S.ct.mpr, sel = (m.selw && m.selw.length) ? m.selw : [wi], dir = e.deltaY > 0 ? 1 : -1;
  sel.forEach(i => {
    const recon = winRecon(i); if (!recon) return;
    const w = m.wins[i], a = winAxis(scan, recon);
    w.pos = clampV((w.pos == null ? winMid(scan, recon) : w.pos) + dir * a.step, a.lo, a.hi);
    drawReconWindow(scan, i);
  });
}
function updateWinSel() { const sel = ctx.S.ct.mpr.selw || []; WINS.forEach(wi => { const p = ctx.$('mprWin_' + wi); if (p) p.classList.toggle('selw', sel.includes(wi)); }); }
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
  WINS.forEach(wi => {
    const cv = ctx.$('mprCanvas_' + wi); if (!cv) return;
    cv.addEventListener('wheel', (e) => onWinWheel(e, wi), { passive: false });
    cv.addEventListener('pointerdown', (e) => {            // click a filled window to select it for scrolling
      const m = ctx.S.ct.mpr;
      if (m.plan && m.plan.src === wi) { plannerPointerDown(e, cv, wi); return; }   // planning → drag the localizer
      if (!winRecon(wi)) return;                            // empty window → its overlay buttons handle it
      m.selw = m.selw || [];
      if (e.shiftKey || e.ctrlKey || e.metaKey) { const k = m.selw.indexOf(wi); if (k >= 0) m.selw.splice(k, 1); else m.selw.push(wi); }
      else m.selw = [wi];
      updateWinSel();
    });
  });
  ctx.$('ctMprGrid')?.addEventListener('click', (e) => {
    const nb = e.target.closest('.rw-new'), sb = e.target.closest('.rw-sel');
    if (nb) newReconForWindow(+nb.dataset.win);
    else if (sb) selectReconForWindow(+sb.dataset.win);
  });
  ctx.$('ctReconScanSel')?.addEventListener('change', (e) => { cancelReconPlan(); ctx.S.ct.mpr.scanId = +e.target.value; ctx.S.ct.mpr.wins = null; ctx.S.ct.mpr.selw = []; ctRenderRecons(); });
  wireReconPlanLive();
  ctx.$('ctReconSave')?.addEventListener('click', saveReconStart);
  ctx.$('ctReconClear')?.addEventListener('click', () => {
    const scan = mprScan(); if (!scan) return;
    const m = ctx.S.ct.mpr, sel = (m.selw || []).slice();
    if (!sel.length) { setHint('Click a window to select it, then Clear window.'); return; }
    if (m.plan && (sel.includes(m.plan.src) || sel.includes(m.plan.target))) cancelReconPlan();
    sel.forEach(wi => { m.wins[wi] = null; }); m.selw = []; updateWinSel();
    sel.forEach(wi => drawReconWindow(scan, wi));
  });
  window.addEventListener('resize', () => { if (ctx.$('ctRecons')?.classList.contains('show')) { const s = mprScan(); if (s) WINS.forEach(wi => drawReconWindow(s, wi)); } });
}
// Small modal list picker (reuses the field-edit popup shell).
function reconPopup(title, items, onPick) {
  const pop = ctx.$('ctPop'), inner = ctx.$('ctPopInner'); if (!pop) return;
  const close = () => { pop.classList.remove('show'); document.removeEventListener('keydown', onKey, true); };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  inner.innerHTML = '<div class="plt">' + title + '</div><div class="ctpop-stations">'
    + items.map((it, i) => '<button data-i="' + i + '">' + it.label + '</button>').join('')
    + '</div><div class="phint"><b>[ESC]</b> to cancel</div>';
  inner.querySelectorAll('.ctpop-stations button').forEach(b => b.addEventListener('click', () => { const it = items[+b.dataset.i]; close(); onPick(it); }));
  pop.classList.add('show'); document.addEventListener('keydown', onKey, true);
}
// Bind an already-planned reconstruction of this scan group to a window.
function selectReconForWindow(wi) {
  const scan = mprScan(); if (!scan) return;
  const recons = scan.recons || [];
  if (!recons.length) { setHint('No reconstructions in this scan group yet — use “New recon”.'); return; }
  reconPopup('Select reconstruction', recons.map(r => ({ label: r.name, r })), (it) => {
    ctx.S.ct.mpr.wins[wi] = { recon: it.r, pos: winMid(scan, it.r), saved: true };
    drawReconWindow(scan, wi);
  });
}
// ========================================================================================
// Phase-2 New-recon interactive planner. "New recon" plans a reconstruction ON a currently
// displayed recon (the SOURCE): a localizer box is drawn on the source image (like the old
// oblique localizer). An orthogonal plane appears edge-on as a LINE with a double-arrow (its
// advance direction); rotating it off-axis makes it OBLIQUE; a parallel plane is a crop
// rectangle with a circle-X (crop A/P & R/L, keep scan length). A live recon-planner table
// below the scan-group selector edits the params and picks the plane (auto-orienting the box).
// ========================================================================================
const PLANE_NORMAL = { transverse: 'z', axial: 'z', coronal: 'y', sagittal: 'x' };   // recon plane → advance axis
const NAX_PLANE = { z: 'transverse', y: 'coronal', x: 'sagittal' };                   // advance axis → recon plane
// The horizontal / vertical / out-of-plane physical axes of a source pane's in-view frame.
function srcAxes(P) { return P === 'axial' ? { h: 'x', v: 'y', n: 'z' } : P === 'coronal' ? { h: 'x', v: 'z', n: 'y' } : { h: 'y', v: 'z', n: 'x' }; }
// In-view (cu,cv) on a source pane at scroll pos → centred physical coords {x, y, d} (d = z − zCentre).
function inviewToPhysical(scan, P, spos, cu, cv) {
  const g = mprGeom(scan), zc = g.z0 + g.zExt / 2;
  if (P === 'axial') return { x: cu, y: cv, z: spos };
  if (P === 'coronal') return { x: cu, y: spos, z: zc + cv };
  return { x: spos, y: cu, z: zc + cv };                                              // sagittal
}
// Which recon plane a localizer line at angle `ang` (on source pane P) defines. A near-axis line
// is a clean orthogonal plane; otherwise it is oblique. Returns {plane, nax, aligned}.
function orthoPlaneFromAng(P, ang) {
  const ax = srcAxes(P), TOL = 0.18;                     // ~10°
  const a = ((ang % Math.PI) + Math.PI) % Math.PI;       // 0..π
  if (a < TOL || Math.PI - a < TOL) return { plane: NAX_PLANE[ax.v], nax: ax.v, aligned: true };   // horizontal line → advance along v
  if (Math.abs(a - Math.PI / 2) < TOL) return { plane: NAX_PLANE[ax.h], nax: ax.h, aligned: true }; // vertical line → advance along h
  return { plane: 'oblique', nax: null, aligned: false };
}
// The oblique plane basis (centred coords) for a localizer line on source pane P — the recon plane
// is spanned by the line direction u and the source's out-of-plane axis a3; it scrolls along n. The
// plane is anchored at the SOURCE slice's out-of-plane position (srcPos) along a3, so the recon
// passes through the anatomy the user was looking at (not the volume centre).
function localizerBasis(scan, P, ang, cu, cv, srcPos) {
  const g = mprGeom(scan), zc = g.z0 + g.zExt / 2, c = Math.cos(ang), s = Math.sin(ang);
  let a1, a2, a3;
  if (P === 'axial') { a1 = [1, 0, 0]; a2 = [0, 1, 0]; a3 = [0, 0, 1]; }
  else if (P === 'coronal') { a1 = [1, 0, 0]; a2 = [0, 0, 1]; a3 = [0, 1, 0]; }
  else { a1 = [0, 1, 0]; a2 = [0, 0, 1]; a3 = [1, 0, 0]; }                            // sagittal
  const s3 = P === 'axial' ? ((srcPos || 0) - zc) : (srcPos || 0);                    // a3 offset in centred coords (z is centred)
  return { u: v3add(v3scl(a1, c), v3scl(a2, s)), v: a3, n: v3add(v3scl(a1, -s), v3scl(a2, c)),
    C: v3add(v3add(v3scl(a1, cu), v3scl(a2, cv)), v3scl(a3, s3)), fov: g.fov, vExt: P === 'axial' ? g.zExt : g.fov, view: P };
}
// Set the planned plane from the live table (auto-orients the box). 'parallel' → crop rectangle.
function setPlanPlane(scan, planeV) {
  const pl = ctx.S.ct.mpr.plan, ax = srcAxes(pl.srcPlane);
  if (planeV === 'parallel' || PLANE_NORMAL[planeV] === ax.n) {                       // same normal as source → crop
    pl.mode = 'parallel'; pl.plane = 'parallel';
    if (!pl.crop) pl.crop = { cu: 0, cv: 0, hw: scan.fovMM / 4, hh: (pl.srcPlane === 'axial' ? scan.fovMM : mprGeom(scan).zExt) / 4 };
    return;
  }
  const nax = PLANE_NORMAL[planeV];
  pl.mode = 'ortho'; pl.ang = nax === ax.v ? 0 : Math.PI / 2; pl.plane = planeV;
}
function recomputePlanPlane(scan) { const pl = ctx.S.ct.mpr.plan; if (pl && pl.mode === 'ortho') pl.plane = orthoPlaneFromAng(pl.srcPlane, pl.ang).plane; }

// Start planning a new recon for window `wi`: pick a displayed (orthogonal) recon to plan on.
function newReconForWindow(wi) {
  const scan = mprScan(); if (!scan) return;
  const srcs = WINS.filter(s => { const r = winRecon(s); return r && r.pane !== 'oblique'; })
    .map(s => ({ label: 'Window ' + (s + 1) + ' — ' + PLANE_LABEL[winRecon(s).pane], s }));
  if (!srcs.length) { setHint('Display an axial / coronal / sagittal recon first, then plan on it.'); return; }
  if (srcs.length === 1) startReconPlan(wi, srcs[0].s);
  else reconPopup('Plan the new recon on which displayed image?', srcs, (it) => startReconPlan(wi, it.s));
}
// Enter planning mode: init m.plan, default to an orthogonal plane ≠ the source, draw the box + table.
function startReconPlan(target, src) {
  const scan = mprScan(); if (!scan) return;
  const srcRec = winRecon(src); if (!srcRec || srcRec.pane === 'oblique') { setHint('Pick an axial / coronal / sagittal recon to plan on.'); return; }
  const el = scanMinThk(scan), m = ctx.S.ct.mpr, sp = srcRec.pane;
  const perpFull = sp === 'axial' ? scan.fovMM : mprGeom(scan).zExt;   // the box-width (recon depth) default for oblique
  m.plan = { target, src, srcPlane: sp, srcPos: (m.wins[src].pos == null ? winMid(scan, srcRec) : m.wins[src].pos),
    mode: 'ortho', cu: 0, cv: 0, ang: 0, len: scan.fovMM * 0.8, wid: clampV(perpFull * 0.55, 20, perpFull), crop: null, plane: null,
    params: { thk: Math.max(el, 5), interval: 5, algo: 'standard', mar: false, ww: srcRec.ww || 800, wl: srcRec.wl != null ? srcRec.wl : 60 } };
  setPlanPlane(scan, sp === 'axial' ? 'coronal' : 'transverse');
  m.selw = []; updateWinSel();
  ctx.$('ctReconPlanLive')?.classList.add('show');
  renderReconPlanLive(); drawReconWindow(scan, src);
}
function cancelReconPlan() {
  const m = ctx.S.ct.mpr, scan = mprScan(), src = m.plan && m.plan.src; m.plan = null;
  ctx.$('ctReconPlanLive')?.classList.remove('show');
  const live = ctx.$('ctReconPlanLive'); if (live) live.innerHTML = '';
  if (scan && src != null) drawReconWindow(scan, src);
}
// Commit the planned recon: build the recon object, precompute it, bind it to the target window.
function commitReconPlan() {
  const scan = mprScan(), m = ctx.S.ct.mpr, pl = m.plan; if (!scan || !pl) return;
  const el = scanMinThk(scan), p = pl.params, thk = Math.max(el, p.thk);
  const rid = scan.nextReconId || ((scan.recons || []).length + 1); scan.nextReconId = rid + 1;
  const base = { id: rid, thk, interval: Math.max(0.1, p.interval), algo: p.algo, mar: p.mar, ww: p.ww, wl: p.wl,
    dfov: scan.fovMM, offRL: 0, offAP: 0, subTop: 0, subBot: 1, minThk: el, computed: false };
  const g = mprGeom(scan), zc = g.z0 + g.zExt / 2;
  let rec, pos;
  if (pl.mode === 'parallel') {                                   // crop the source plane (A/P & R/L), keep scan length
    const cr = pl.crop, ctr = inviewToPhysical(scan, pl.srcPlane, pl.srcPos, cr.cu, cr.cv);
    rec = Object.assign(base, { plane: paneToPlaneName(pl.srcPlane), pane: pl.srcPlane,
      dfov: clampV(2 * Math.max(cr.hw, cr.hh), 40, scan.fovMM), offRL: Math.round(ctr.x), offAP: Math.round(ctr.y) });
    pos = pl.srcPos;
  } else {                                                        // line mode (orthogonal OR oblique) — one path
    // The box LENGTH → each slice's in-plane extent (fov, along the line); the box WIDTH → the scroll
    // range (how far the red line sweeps along the plane normal). vExt (out-of-view depth) stays full.
    const info = orthoPlaneFromAng(pl.srcPlane, pl.ang);
    const ob = localizerBasis(scan, pl.srcPlane, pl.ang, pl.cu, pl.cv, pl.srcPos);
    ob.fov = clampV(pl.len, 40, scan.fovMM * 1.6);
    ob.range = clampV(pl.wid, 10, (pl.srcPlane === 'axial' ? scan.fovMM : g.zExt) * 1.2);
    const aligned = info.aligned, pane = aligned ? RP_PLANE_PANE[info.plane] : 'oblique';
    rec = Object.assign(base, { plane: aligned ? info.plane : 'oblique', pane: 'oblique', ob, obliqueLabel: aligned ? PLANE_LABEL[pane] : 'OBLIQUE' });
    pos = 0;
  }
  rec.name = (rec.plane === 'oblique' ? 'Oblique' : rpPlaneLabel(rec.plane)) + ' · ' + fmtNum(thk) + ' mm · ' + rpAlgoLabel(rec.algo) + (rec.mar ? ' · MAR' : '');
  precomputeRecon(scan, rec);
  const a = winAxis(scan, rec);
  m.wins[pl.target] = { recon: rec, pos: clampV(pos, a.lo, a.hi), saved: false };
  m.plan = null; ctx.$('ctReconPlanLive')?.classList.remove('show');
  const live = ctx.$('ctReconPlanLive'); if (live) live.innerHTML = '';
  drawReconWindow(scan, pl.target); if (pl.src !== pl.target) drawReconWindow(scan, pl.src);
  m.selw = [pl.target]; updateWinSel();
  setHint('New reconstruction created in window ' + (pl.target + 1) + '. Use “Save recon” to keep it in the scan group.');
}
const paneToPlaneName = (pane) => pane === 'axial' ? 'transverse' : pane;

// ---- planner overlay (drawn on the source window) ----
function drawPlannerOverlay(g, scan, map) {
  const pl = ctx.S.ct.mpr.plan; if (!pl) return;
  const P = pl.srcPlane, disp = (u, v) => obDisp(scan, P, map, u, v);
  g.save();
  if (pl.mode === 'parallel') {
    const cr = pl.crop;
    const c1 = disp(cr.cu - cr.hw, cr.cv - cr.hh), c2 = disp(cr.cu + cr.hw, cr.cv - cr.hh), c3 = disp(cr.cu + cr.hw, cr.cv + cr.hh), c4 = disp(cr.cu - cr.hw, cr.cv + cr.hh);
    g.strokeStyle = '#35c6d6'; g.fillStyle = 'rgba(53,198,214,0.12)'; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(c1[0], c1[1]); g.lineTo(c2[0], c2[1]); g.lineTo(c3[0], c3[1]); g.lineTo(c4[0], c4[1]); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#35c6d6'; [c1, c2, c3, c4].forEach(pt => { g.beginPath(); g.arc(pt[0], pt[1], 4.5, 0, Math.PI * 2); g.fill(); });
    const cc = disp(cr.cu, cr.cv); symCircleX(g, cc[0], cc[1]);
  } else {
    // Always a teal, fully-resizable rectangle: LENGTH (along the red slice line) sets the recon's
    // in-plane extent; WIDTH (perpendicular) sets the scroll range — scrolling sweeps the red line
    // across the box in the double-arrow direction. End handles = length, side handles = width.
    const c = Math.cos(pl.ang), s = Math.sin(pl.ang), hl = pl.len / 2, hw = Math.max(8, pl.wid / 2);
    const corner = (a, b) => disp(pl.cu + c * a - s * b, pl.cv + s * a + c * b);
    const p1 = corner(hl, hw), p2 = corner(hl, -hw), p3 = corner(-hl, -hw), p4 = corner(-hl, hw);
    const e1 = disp(pl.cu + c * hl, pl.cv + s * hl), e2 = disp(pl.cu - c * hl, pl.cv - s * hl);
    g.strokeStyle = '#35c6d6'; g.fillStyle = 'rgba(53,198,214,0.14)'; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.lineTo(p3[0], p3[1]); g.lineTo(p4[0], p4[1]); g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = '#ff4d4d'; line(g, e1[0], e1[1], e2[0], e2[1]);                     // current-slice (red) line
    g.fillStyle = '#35c6d6';
    [e1, e2].forEach(pt => { g.beginPath(); g.arc(pt[0], pt[1], 4.5, 0, Math.PI * 2); g.fill(); });   // length handles
    const s1 = disp(pl.cu - s * hw, pl.cv + c * hw), s2 = disp(pl.cu + s * hw, pl.cv - c * hw);
    [s1, s2].forEach(pt => { g.beginPath(); g.arc(pt[0], pt[1], 4.5, 0, Math.PI * 2); g.fill(); });    // width handles
    const mid = disp(pl.cu, pl.cv), ldx = e2[0] - e1[0], ldy = e2[1] - e1[1];          // arrow ⟂ the DISPLAYED line
    symDoubleArrow(g, mid[0], mid[1], Math.atan2(ldx, -ldy));                           // scroll (advance) direction
  }
  g.restore();
}
function symDoubleArrow(g, x, y, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), L = 16, hd = 5;
  g.save(); g.strokeStyle = '#ffcf7a'; g.fillStyle = '#ffcf7a'; g.lineWidth = 2.2; g.lineCap = 'round';
  line(g, x - c * L, y - s * L, x + c * L, y + s * L);
  [[1, x + c * L, y + s * L], [-1, x - c * L, y - s * L]].forEach(([d, hx, hy]) => {
    const bx = hx - d * c * hd, by = hy - d * s * hd, px = -s * hd, py = c * hd;
    g.beginPath(); g.moveTo(hx, hy); g.lineTo(bx + px, by + py); g.lineTo(bx - px, by - py); g.closePath(); g.fill();
  });
  g.restore();
}
function symCircleX(g, x, y) {
  const r = 9; g.save(); g.strokeStyle = '#ffcf7a'; g.lineWidth = 2.2; g.lineCap = 'round';
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  line(g, x - r * 0.6, y - r * 0.6, x + r * 0.6, y + r * 0.6); line(g, x + r * 0.6, y - r * 0.6, x - r * 0.6, y + r * 0.6);
  g.restore();
}
// Drag / rotate / resize the localizer on the source window.
function plannerPointerDown(e, cv, wi) {
  const scan = mprScan(), m = ctx.S.ct.mpr, pl = m.plan; if (!scan || !pl) return;
  const P = pl.srcPlane, map = paneMapping(scan, P, cv);
  e.preventDefault(); try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  const at = (ev) => { const { px, py } = evtToCanvas(ev, cv); return obClickAB(scan, P, map, px, py); };
  const a0 = at(e); let mode = null, grab = null, endSign = 1;
  if (pl.mode === 'parallel') {
    const cr = pl.crop, dx = a0.cu - cr.cu, dy = a0.cv - cr.cv, tol = Math.max(5, Math.min(cr.hw, cr.hh) * 0.35);
    if (Math.abs(Math.abs(dx) - cr.hw) < tol && Math.abs(Math.abs(dy) - cr.hh) < tol) mode = 'corner';
    else if (Math.abs(dx) < cr.hw && Math.abs(dy) < cr.hh) { mode = 'move'; grab = { ou: dx, ov: dy }; }
  } else {
    const c = Math.cos(pl.ang), s = Math.sin(pl.ang), du = a0.cu - pl.cu, dv = a0.cv - pl.cv;
    const along = du * c + dv * s, perp = -du * s + dv * c, hl = pl.len / 2, hw = pl.wid / 2;
    const tol = Math.max(5, pl.len * 0.14), ptol = Math.max(6, hw * 0.3);
    if (Math.abs(along) <= hl + tol && Math.abs(perp) <= hw + ptol) {
      if (Math.abs(along) > hl - tol) { mode = 'end'; endSign = Math.sign(along) || 1; }        // grab an end → length + rotate
      else if (Math.abs(perp) > hw - ptol) mode = 'side';                                       // grab a long edge → width
      else { mode = 'move'; grab = { ou: du, ov: dv }; }
    } else mode = 'slide';                                         // click off the box → slide the plane along its normal
  }
  const move = (ev) => {
    const ab = at(ev);
    if (pl.mode === 'parallel') {
      if (mode === 'corner') { pl.crop.hw = Math.max(20, Math.abs(ab.cu - pl.crop.cu)); pl.crop.hh = Math.max(20, Math.abs(ab.cv - pl.crop.cv)); }
      else if (mode === 'move') { pl.crop.cu = ab.cu - grab.ou; pl.crop.cv = ab.cv - grab.ov; }
    } else if (mode === 'end') {
      const vu = (ab.cu - pl.cu) * endSign, vv = (ab.cv - pl.cv) * endSign, d = Math.hypot(vu, vv);
      if (d > 1) { pl.ang = Math.atan2(vv, vu); pl.len = clampV(2 * d, 20, scan.fovMM * 1.6); } recomputePlanPlane(scan);
    } else if (mode === 'side') {                                  // resize the oblique box width (recon depth extent)
      const s2 = Math.sin(pl.ang), c2 = Math.cos(pl.ang), perp = -(ab.cu - pl.cu) * s2 + (ab.cv - pl.cv) * c2;
      const g2 = mprGeom(scan), maxW = (pl.srcPlane === 'axial' ? scan.fovMM : g2.zExt) * 1.2;
      pl.wid = clampV(2 * Math.abs(perp), 20, maxW);
    } else if (mode === 'move') { pl.cu = ab.cu - grab.ou; pl.cv = ab.cv - grab.ov; }
    else if (mode === 'slide') { const c = Math.cos(pl.ang), s = Math.sin(pl.ang), perp = -(ab.cu - pl.cu) * s + (ab.cv - pl.cv) * c; pl.cu += -s * perp; pl.cv += c * perp; }
    drawReconWindow(scan, wi); renderReconPlanLive();
  };
  const up = () => { cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', up); };
  cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
}
// ---- live recon-planner table (below the scan-group selector; recon-page only) ----
function planSymbolHTML() {
  const pl = ctx.S.ct.mpr.plan; if (!pl) return '';
  if (pl.mode === 'parallel') return RB_XCIRC + '<span class="rpl-sym-lbl">' + rpPlaneLabel(paneToPlaneName(pl.srcPlane)) + ' — crop</span>';
  if (pl.plane === 'oblique') return rbArrow(false) + '<span class="rpl-obl">Oblique</span>';
  return rbArrow(false) + '<span class="rpl-sym-lbl">' + rpPlaneLabel(pl.plane) + '</span>';
}
function renderReconPlanLive() {
  const box = ctx.$('ctReconPlanLive'), pl = ctx.S.ct.mpr.plan; if (!box) return;
  if (!pl) { box.classList.remove('show'); box.innerHTML = ''; return; }
  box.classList.add('show');
  const p = pl.params;
  // Selecting the plane the source image is already in = crop mode (no separate Parallel button).
  const planeChoices = [{ v: 'transverse', l: 'Transverse' }, { v: 'sagittal', l: 'Sagittal' }, { v: 'coronal', l: 'Coronal' }];
  const cur = pl.mode === 'parallel' ? paneToPlaneName(pl.srcPlane) : pl.plane;
  const seg = planeChoices.map(pc => '<button class="rpl-seg' + (pc.v === cur ? ' on' : '') + '" data-plane="' + pc.v + '">' + pc.l + '</button>').join('');
  const chip = (act, txt) => '<button class="rpl-chip" data-p="' + act + '">' + txt + '</button>';
  box.innerHTML = '<div class="rpl-head"><span class="rpl-title">New reconstruction</span>'
    + '<span class="rpl-src">on Window ' + (pl.src + 1) + ' · ' + PLANE_LABEL[pl.srcPlane] + '</span>'
    + '<span class="rpl-sym">' + planSymbolHTML() + '</span></div>'
    + '<div class="rpl-planes">' + seg + '</div>'
    + '<div class="rpl-fields">'
    + chip('thk', fmtNum(p.thk) + ' mm') + chip('interval', fmtNum(p.interval) + ' mm')
    + chip('algo', rpAlgoLabel(p.algo)) + '<button class="rpl-chip' + (p.mar ? ' on' : '') + '" data-p="mar">MAR ' + (p.mar ? 'ON' : 'OFF') + '</button>'
    + chip('ww', 'WW ' + Math.round(p.ww)) + chip('wl', 'WL ' + Math.round(p.wl)) + '</div>'
    + '<div class="rpl-actions"><button class="rpl-create" data-p="create">Create recon</button>'
    + '<button class="rpl-cancel" data-p="cancel">Cancel</button></div>';
}
function wireReconPlanLive() {
  const box = ctx.$('ctReconPlanLive'); if (!box) return;
  box.addEventListener('click', (e) => {
    const scan = mprScan(), pl = ctx.S.ct.mpr.plan; if (!scan || !pl) return;
    const seg = e.target.closest('.rpl-seg');
    if (seg) { setPlanPlane(scan, seg.dataset.plane); renderReconPlanLive(); drawReconWindow(scan, pl.src); return; }
    const b = e.target.closest('[data-p]'); if (!b) return;
    const act = b.dataset.p, p = pl.params, done = () => { renderReconPlanLive(); };
    const type = (label, curv, apply) => openTypedPopup(label, curv, (v) => { apply(sanitizeNum(v, curv)); done(); });
    if (act === 'create') commitReconPlan();
    else if (act === 'cancel') cancelReconPlan();
    else if (act === 'mar') { p.mar = !p.mar; done(); }
    else if (act === 'algo') openStationPopup('Processing algorithm', RP_ALGOS.map((a, i) => i), Math.max(0, RP_ALGOS.findIndex(a => a.v === p.algo)), (i) => RP_ALGOS[i].l, (i) => { p.algo = RP_ALGOS[i].v; done(); });
    else if (act === 'thk') type('Slice thickness (mm)', fmtNum(p.thk), (v) => { p.thk = clampV(v, 0.5, 50); });
    else if (act === 'interval') type('Slice interval (mm)', fmtNum(p.interval), (v) => { p.interval = clampV(v, 0.1, 50); });
    else if (act === 'ww') type('Window width (WW)', Math.round(p.ww), (v) => { p.ww = clampV(Math.round(v), 1, 4000); });
    else if (act === 'wl') type('Window level (WL)', Math.round(p.wl), (v) => { p.wl = clampV(Math.round(v), -1000, 3000); });
  });
}
// Save a window's (unsaved) reconstruction into the scan group's recon list.
function saveReconStart() {
  const scan = mprScan(); if (!scan) return;
  const opts = WINS.filter(wi => { const w = ctx.S.ct.mpr.wins[wi]; return w && w.recon && w.saved === false; })
    .map(wi => ({ label: 'Window ' + (wi + 1) + ' — ' + winRecon(wi).name, wi }));
  if (!opts.length) { setHint('No unsaved reconstruction in any window.'); return; }
  reconPopup('Save which window’s recon to this scan group?', opts, (it) => {
    const w = ctx.S.ct.mpr.wins[it.wi]; if (!w || !w.recon) return;
    scan.recons = scan.recons || []; if (!scan.recons.includes(w.recon)) scan.recons.push(w.recon);
    w.saved = true; drawReconWindow(scan, it.wi); setHint('Reconstruction saved to the scan group.');
  });
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
