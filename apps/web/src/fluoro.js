/* ============================================================================
   FLUOROSCOPY MODE — Phase A: the pulse loop (docs/fluoroscopy.md)
   A GE OEC portable C-arm around the subject, a foot pedal, four authentic pulse rates,
   and a worker raycaster. The simulation frame rate IS the pulse rate: 3 pps genuinely
   updates three times a second and feels exactly that jerky, and a pulse that arrives
   while the previous one is still rendering is DROPPED and counted, never queued —
   latency is the enemy of a live image, and the dropped counter is the honest budget
   readout Phase A exists to measure.
   ============================================================================ */

let ctx = null;          // { THREE, S, $, three, phantomPose, syncScene }
let F = null;            // ctx.S.fluoro
// A POOL of pulse workers, round-robin: one worker sustains ~18 pps at the Phase A
// budget (measured 54 ms/pulse at 192 px on the hand), so 30 pps needs two in flight.
// Frames can then land out of order — each carries its pulse id and stale ones are
// discarded, never drawn over a newer frame. Mobile keeps a pool of one: the second
// volume copy costs more memory than 7.5 pps is worth.
let workers = [], busy = [], readyCount = 0, workerSub = null;
let timer = null, pulseId = 0, pedalDownAt = 0, lastDrawn = 0;
let rig = null, stretcher = null;

// GE OEC geometry, datasheet-rounded (cm): fixed SID, source under the patient at 0°.
const OEC = { SID: 99, SRC_ISO: 60, FIELD: 23 };
// Circular-field sampling, adaptive: measured on the hand, one worker does 192 px in
// ~54 ms (≈18 pps) and the pool of two sustains 15 pps clean but only ~23 of 30. The
// last third comes from sampling: 160 px is 0.69x the rays, and both sizes upscale into
// the same monitor, so 30 pps trades a little sharpness it was going to lose to per-pulse
// mottle anyway. 3/7.5/15 keep the full 192.
const nPx = () => (F.pps >= 30 ? 160 : 192);

const $ = (id) => ctx.$(id);

/* ---- geometry ------------------------------------------------------------ */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/* Source→detector direction from the C-arm joints: orbital swings about the patient's
   long axis (z), tilt angulates craniocaudally. At 0/0 the beam points straight up —
   tube UNDER the patient, the standard C-arm setup (scatter goes at the floor, not the
   operator's eyes). */
function beamDir() {
  const th = F.orbital * Math.PI / 180, ti = F.tilt * Math.PI / 180;
  return [Math.sin(th) * Math.cos(ti), Math.cos(th) * Math.cos(ti), Math.sin(ti)];
}
function isoPoint() {
  const S = ctx.S, vm = S.voxelModel;
  const ey = vm ? (vm.extentMM[1] / 2) / 10 : 5;
  return [S.objOff.x, ey + S.objOff.y, S.objOff.z];
}
function beamFrame() {
  const dir = beamDir(), iso = isoPoint();
  const src = [iso[0] - dir[0] * OEC.SRC_ISO, iso[1] - dir[1] * OEC.SRC_ISO, iso[2] - dir[2] * OEC.SRC_ISO];
  const dc = OEC.SID - OEC.SRC_ISO;
  const detC = [iso[0] + dir[0] * dc, iso[1] + dir[1] * dc, iso[2] + dir[2] * dc];
  let u = cross(dir, [0, 0, 1]);
  if (Math.hypot(u[0], u[1], u[2]) < 1e-6) u = [1, 0, 0];
  u = norm(u);
  const v = norm(cross(u, dir));
  return { src, detC, detU: u, detV: v, half: OEC.FIELD / 2 };
}

/* ---- the worker ---------------------------------------------------------- */
function poolSize() { return document.body.classList.contains('mobile') ? 1 : 2; }
function ensureWorker() {
  const S = ctx.S, vm = S.voxelModel;
  if (!vm || !vm.data) { setStatus('This subject renders on the GPU backend only — pick a browser subject.'); return false; }
  if (workers.length && workerSub === S.subject) return readyCount === workers.length;
  workers.forEach((w) => w.terminate());
  workers = []; busy = []; readyCount = 0; workerSub = S.subject; lastDrawn = 0;
  const pose = ctx.phantomPose();
  for (let i = 0; i < poolSize(); i++) {
    const w = new Worker(new URL('./fluoro-worker.js', import.meta.url), { type: 'module' });
    const slot = i;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') {
        readyCount++;
        if (readyCount === workers.length) setStatus('Ready — hold the pedal (or Space) to screen.');
        return;
      }
      if (m.type === 'frame') {
        busy[slot] = false;
        F.msAvg = F.msAvg ? 0.85 * F.msAvg + 0.15 * m.ms : m.ms;
        if (m.id > lastDrawn) {              // a slower older pulse never overdraws a newer one
          lastDrawn = m.id;
          drawFrame(m.img, Math.sqrt(m.img.length) | 0);
        }
        renderReadouts();
      }
    };
    // the volume is CLONED into each worker (no SharedArrayBuffer without COOP/COEP,
    // which GitHub Pages cannot set) — per subject, then pulses carry only geometry
    w.postMessage({ type: 'init', dims: vm.dims, vs: vm.vs, data: vm.data,
      center: pose.center, flip: pose.flip, rot: pose.rot });
    workers.push(w); busy.push(false);
  }
  setStatus('Loading the subject into the pulse workers…');
  return false;
}

/* Per-pulse photon budget: fluoro runs ~5-10 ms pulses at a few mA — three orders of
   magnitude under a radiograph, which is where the mottle comes from. Reference: 400
   photons/pixel at 70 kV / 2 mA / 8 ms; kV² tracks tube output. Phase B calibrates
   against the main spectrum; Phase A needs the noise CHARACTER, not absolute dose. */
function photonsPerPulse() {
  return 400 * (F.ma / 2) * Math.pow(F.kv / 70, 2);
}

function firePulse() {
  if (readyCount !== workers.length || !workers.length) { ensureWorker(); return; }
  const slot = busy.indexOf(false);
  if (slot < 0) { F.dropped++; renderReadouts(); return; }
  busy[slot] = true;
  F.pulses++;
  const g = beamFrame(), pose = ctx.phantomPose();
  workers[slot].postMessage({ type: 'pulse', id: ++pulseId, kv: F.kv, photons: photonsPerPulse(),
    src: g.src, detC: g.detC, detU: g.detU, detV: g.detV, half: g.half, n: nPx(),
    rot: pose.rot, center: pose.center, seed: (Math.random() * 1e9) | 0 });
}

/* ---- display ------------------------------------------------------------- */
let frameCanvas = null;
function drawFrame(img, n) {
  const film = $('film'); if (!film) return;
  if (!frameCanvas) frameCanvas = document.createElement('canvas');
  if (frameCanvas.width !== n) { frameCanvas.width = n; frameCanvas.height = n; }
  // primitive display ABC (the technique loop is Phase B): gain the central-disc mean to
  // mid-grey so panning stays watchable, then a gamma lift for the II look
  let sum = 0, cnt = 0;
  const c0 = n * 0.35 | 0, c1 = n * 0.65 | 0;
  for (let j = c0; j < c1; j++) for (let i = c0; i < c1; i++) {
    const t = img[j * n + i]; if (t >= 0) { sum += t; cnt++; }
  }
  const gain = cnt && sum > 0 ? 0.45 / (sum / cnt) : 1;
  const id = frameCanvas.getContext('2d').createImageData(n, n);
  for (let k = 0; k < n * n; k++) {
    const t = img[k];
    let g = 0;
    if (t >= 0) g = Math.min(1, Math.sqrt(Math.min(1.6, t * gain))) * 255;
    id.data[k * 4] = id.data[k * 4 + 1] = id.data[k * 4 + 2] = g;
    id.data[k * 4 + 3] = 255;
  }
  frameCanvas.getContext('2d').putImageData(id, 0, 0);
  const g2 = film.getContext('2d');
  if (film.width !== 330) { film.width = 330; film.height = 440; }
  g2.fillStyle = '#000'; g2.fillRect(0, 0, film.width, film.height);
  const s = Math.min(film.width, film.height) - 10;
  g2.imageSmoothingEnabled = true;
  g2.drawImage(frameCanvas, (film.width - s) / 2, (film.height - s) / 2, s, s);
  $('noexp')?.style.setProperty('display', 'none');
}

/* ---- pedal + pulse clock ------------------------------------------------- */
function pedalDown() {
  if (F.pedal || ctx.S.mode !== 'fluoro') return;
  if (!ensureWorker()) { /* first press warms the worker; screening starts when ready */ }
  F.pedal = true; F.lih = false; pedalDownAt = performance.now();
  $('flPedal')?.classList.add('on');
  $('lihBadge')?.classList.remove('show');
  clearInterval(timer);
  timer = setInterval(firePulse, 1000 / F.pps);
  firePulse();
  renderReadouts();
}
function pedalUp() {
  if (!F.pedal) return;
  F.pedal = false;
  F.beamS += (performance.now() - pedalDownAt) / 1000;
  clearInterval(timer); timer = null;
  $('flPedal')?.classList.remove('on');
  F.lih = true;
  $('lihBadge')?.classList.add('show');   // the frame persists on the monitor: Last Image Hold
  renderReadouts();
}

function renderReadouts() {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  const beam = F.beamS + (F.pedal ? (performance.now() - pedalDownAt) / 1000 : 0);
  set('flKvV', F.kv + ' kV');
  set('flMaV', F.ma.toFixed(1) + ' mA');
  set('flBeamV', `${String(Math.floor(beam / 60)).padStart(2, '0')}:${String(Math.floor(beam % 60)).padStart(2, '0')}`);
  set('flPerfV', F.msAvg ? `${F.msAvg.toFixed(0)} ms · ${F.dropped} dropped` : '—');
  set('flOrbV', F.orbital + '°');
  set('flTiltV', F.tilt + '°');
}
function setStatus(msg) { const el = $('flStatus'); if (el) el.textContent = msg; }

/* ---- the rig ------------------------------------------------------------- */
function buildRig() {
  const { THREE, three } = ctx;
  rig = new THREE.Group();
  const grey = new THREE.MeshStandardMaterial({ color: 0xd8dade, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2e34, roughness: 0.7 });
  // the C: a torus arc in the orbital plane, beam along +y when unrotated
  const c = new THREE.Mesh(new THREE.TorusGeometry(46, 3.4, 12, 48, Math.PI * 1.45), grey);
  c.rotation.z = Math.PI * (0.5 - 0.725);           // centre the arc gap on -x (the throat)
  rig.add(c);
  // tube housing at the bottom of the C, image intensifier tower at the top
  const tube = new THREE.Mesh(new THREE.BoxGeometry(16, 12, 16), dark);
  tube.position.set(0, -46, 0); rig.add(tube);
  const ii = new THREE.Mesh(new THREE.CylinderGeometry(13, 11, 22, 24), grey);
  ii.position.set(0, 46, 0); rig.add(ii);
  const face = new THREE.Mesh(new THREE.CylinderGeometry(11.5, 11.5, 1.2, 24),
    new THREE.MeshStandardMaterial({ color: 0x10161c, roughness: 0.3 }));
  face.position.set(0, 34.6, 0); rig.add(face);
  rig.visible = false;
  three.handGroup.parent.add(rig);
  // the stretcher the subject lies on (the x-ray placement already lies flat at y≈0)
  stretcher = new THREE.Mesh(new THREE.BoxGeometry(55, 2.4, 210),
    new THREE.MeshStandardMaterial({ color: 0x3c4650, roughness: 0.85 }));
  stretcher.position.set(0, -1.6, 0);
  stretcher.visible = false;
  rig.parent.add(stretcher);
}

export function fluoroSyncScene() {
  if (!ctx || !rig) return;
  const { THREE, S, three } = ctx;
  const on = S.mode === 'fluoro';
  rig.visible = on; stretcher.visible = on;
  // The x-ray rig belongs to the other room. Hiding is enough: ctSyncScene restores the
  // tube on every sync once the mode is no longer fluoro, so there is nothing to undo.
  if (on) {
    if (three.tube) three.tube.visible = false;
    if (three.lamp) three.lamp.intensity = 0;
    if (three.cr) three.cr.visible = false;
    const iso = isoPoint();
    rig.position.set(iso[0], iso[1], iso[2]);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(...beamDir()));
    rig.quaternion.copy(q);
  }
}

/* ---- mode + wiring ------------------------------------------------------- */
export function fluoroApplyMode(on) {
  if (!ctx) return;
  if (on) {
    ensureWorker();
    renderReadouts();
    setStatus(workerReady ? 'Ready — hold the pedal (or Space) to screen.'
                          : 'Loading the subject into the pulse worker…');
  } else {
    pedalUp();
    $('lihBadge')?.classList.remove('show');
  }
  fluoroSyncScene();
}

export function initFluoro(context) {
  ctx = context;
  F = ctx.S.fluoro;
  buildRig();
  const ped = $('flPedal');
  if (ped) {
    ped.addEventListener('pointerdown', (e) => { e.preventDefault(); ped.setPointerCapture(e.pointerId); pedalDown(); });
    ped.addEventListener('pointerup', pedalUp);
    ped.addEventListener('pointercancel', pedalUp);
  }
  addEventListener('keydown', (e) => {
    if (e.code === 'Space' && ctx.S.mode === 'fluoro' && !e.repeat
        && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) {
      e.preventDefault(); pedalDown();
    }
  });
  addEventListener('keyup', (e) => { if (e.code === 'Space') pedalUp(); });
  document.querySelectorAll('#flPpsSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      F.pps = parseFloat(b.dataset.pps);
      document.querySelectorAll('#flPpsSeg button').forEach((x) => x.classList.toggle('on', x === b));
      if (F.pedal) { clearInterval(timer); timer = setInterval(firePulse, 1000 / F.pps); }
    });
  });
  const slide = (id, key, chip, fmt) => {
    $(id)?.addEventListener('input', (e) => {
      F[key] = parseFloat(e.target.value);
      renderReadouts();
      if (key === 'orbital' || key === 'tilt') fluoroSyncScene();
    });
  };
  slide('flKv', 'kv'); slide('flMa', 'ma'); slide('flOrb', 'orbital'); slide('flTilt', 'tilt');
  // a subject change invalidates the worker's copy of the volume
  const sel = $('subjectSel');
  sel?.addEventListener('change', () => { workerSub = null; });
  renderReadouts();
}
