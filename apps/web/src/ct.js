// CT mode — Phase 1: mode toggle, CT bed + isocentre laser in the 3D bay, the CT
// acquisition settings, and the start/abort/table console with its symbol icons.
//
// Later phases add: scout acquisition (AP + Lateral), the interactive scan box,
// timed table motion, scan execution + sounds, and transverse reconstruction.
//
// The module is given the app-glue handles it needs via initCT({...}); it keeps
// its own 3D objects (bed, laser) and overrides scene visibility in ctSyncScene(),
// which app.js calls at the end of syncScene().

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
  // ISOCENTRE: a patient/figure alignment glyph (blue on the tan console button)
  iso: '<svg viewBox="0 0 24 24" aria-hidden="true">' +
       '<circle cx="12" cy="5.6" r="3.3" fill="currentColor"/>' +
       '<path d="M6.4 21 C6.4 13.6 9 12 12 12 C15 12 17.6 13.6 17.6 21 Z" fill="currentColor"/>' +
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

// Phase-1 placeholder console wiring; the full acquisition state machine (scouts,
// scan box, table motion, scan + reconstruction) is built in later phases.
function wireCTConsole() {
  const { $ } = ctx;
  $('ctStart')?.addEventListener('click', () => setHint('Scout acquisition arrives in the next phase.'));
  $('ctAbort')?.addEventListener('click', () => setHint('Idle — nothing to abort.'));
  $('ctTable')?.addEventListener('click', () => setHint('Table motion arrives with scan planning.'));
}
