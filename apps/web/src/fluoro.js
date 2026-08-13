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
let rig = null, stretcher = null, oecBody = null, oecCarm = null;

// GE OEC geometry, datasheet-rounded (cm): fixed SID, source under the patient at 0°.
const OEC = { SID: 99, SRC_ISO: 60, FIELD: 23 };
// Circular-field sampling, adaptive: measured on the hand, one worker does 192 px in
// ~54 ms (≈18 pps) and the pool of two sustains 15 pps clean but only ~23 of 30. The
// last third comes from sampling: 160 px is 0.69x the rays, and both sizes upscale into
// the same monitor, so 30 pps trades a little sharpness it was going to lose to per-pulse
// mottle anyway. 3/7.5/15 keep the full 192.
// Sampling adapts to the SUBJECT, not just the rate: a hand pulse costs ~54 ms at
// 192 px, an animated chest ~140 — no single constant serves both. A tier controller
// watches the drop rate: misses step the resolution down a notch, sustained headroom
// steps it back up. Fluoro's per-pulse mottle hides what the tiers give up.
const N_TIERS = [192, 160, 136, 112];
let nTier = 0, tierPulses = 0, tierDrops = 0;
const nPx = () => N_TIERS[nTier];
function tierTick(dropped) {
  tierPulses++; if (dropped) tierDrops++;
  if (tierPulses < 24) return;
  const r = tierDrops / tierPulses;
  if (r > 0.12 && nTier < N_TIERS.length - 1) nTier++;
  else if (r === 0 && nTier > 0 && F.msAvg * F.pps / 1000 < poolSize() * 0.55) nTier--;
  tierPulses = 0; tierDrops = 0;
}

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
/* The C-arm's isocentre is a point in the ROOM, not on the patient: it sits over the
   stretcher's centre at the subject's nominal mid-plane, and the offset sliders slide the
   PATIENT through the field. The first version tracked objOff here, which aimed the beam
   at the subject's centre wherever it went — panning changed nothing, which is exactly
   the bug the ABC exit test caught (lung and liver read identical technique). */
function isoPoint() {
  const vm = ctx.S.voxelModel;
  const ey = vm ? (vm.extentMM[1] / 2) / 10 : 5;
  return [0, ey, 0];
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
function poolSize() { return document.body.classList.contains('mobile') ? 1 : 3; }
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
        if (m.anim) F.motions = m.anim;      // what this subject can DO: br, heart, oeso, sto
        if (readyCount === workers.length) {
          const mo = (F.motions || []).length
            ? ' Motion: ' + F.motions.join(', ') + '.' : ' This subject holds still.';
          setStatus('Ready — hold the pedal (or Space) to screen.' + mo);
        }
        return;
      }
      if (m.type === 'frame') {
        busy[slot] = false;
        F.msAvg = F.msAvg ? 0.85 * F.msAvg + 0.15 * m.ms : m.ms;
        abcStep(m.roi, m.photons);           // the next pulse fires at the adjusted technique
        if (m.id > lastDrawn) {              // a slower older pulse never overdraws a newer one
          lastDrawn = m.id;
          drawFrame(m.img, Math.sqrt(m.img.length) | 0);
        }
        renderReadouts();
      }
    };
    // the volume is CLONED into each worker (no SharedArrayBuffer without COOP/COEP,
    // which GitHub Pages cannot set) — per subject, then pulses carry only geometry
    w.postMessage({ type: 'init', dims: vm.dims, vs: vm.vs, vsMM: vm.spacingMM,
      data: vm.data, center: pose.center, flip: pose.flip, rot: pose.rot });
    workers.push(w); busy.push(false);
  }
  setStatus('Loading the subject into the pulse workers…');
  return false;
}

/* Per-pulse photon budget: fluoro runs ~5-10 ms pulses at a few mA — three orders of
   magnitude under a radiograph, which is where the mottle comes from. Reference: 400
   photons/pixel at 70 kV / 2 mA / 8 ms; kV² tracks tube output. */
function photonsPerPulse() {
  // Reference 1300 photons/pixel at 70 kV / 2 mA: set so that RAIL technique (110 kV,
  // 10 mA) detects ~60/pixel through an adult abdomen (T ~ 0.4 %) — the thickest thing
  // the ABC must be able to serve. 400, the first guess, left the loop railed with the
  // detector still starving through any torso.
  return 1300 * (F.ma / 2) * Math.pow(F.kv / 70, 2);
}

/* ---- ABC: the fluoroscopic sibling of the AEC ----------------------------------------
   A per-pulse closed loop on the detector's central ROI, driving technique along the
   machine's FLUORO CURVE — one parameter q from (50 kV, 0.5 mA) to (110 kV, 10 mA),
   kV-weighted first the way GE tunes it. Pan from lung to abdomen and q climbs until the
   detector sees its target again; park over the spine and watch the kV take the contrast
   with it. That trade IS the lesson, and it is why the console shows kV/mA moving on
   their own. */
// Calibrated against what the beam model can actually deliver: mid-curve technique over a
// torso detects ~40-60 photons/pixel (emitted x transmission), a hand floors the curve.
// 340 — the first guess — was unreachable through 20 cm of tissue, so the loop railed at
// 110 kV / 10 mA everywhere and the pan test showed no difference between lung and liver.
const ABC_TARGET = 45;                      // detected photons/pixel the loop defends
function abcApply() {
  const q = F.q;
  F.kv = Math.round(52 + 58 * q);
  F.ma = Math.round((0.5 + 9.5 * q * q) * 10) / 10;
}
function abcStep(roi, photons) {
  if (!F.abc || !F.pedal) return;
  const meas = photons * roi;               // what the detector actually collected
  if (meas <= 0) return;
  // log-domain proportional step: the full curve spans ~e^6 of detected signal, and a
  // gain of 0.3 settles chest->abdomen in four or five pulses without hunting
  F.q = Math.max(0, Math.min(1, F.q + 0.3 * Math.log(ABC_TARGET / meas) / 6));
  abcApply();
}

/* ---- dose ----------------------------------------------------------------------------
   Reference-point air kerma modelled on a mid-size C-arm: ~12 mGy/min at 70 kV / 2 mA /
   15 pps, scaling with tube output (kV^2.5 x mA), pulse count, and the mag factor (a
   smaller II field needs more input dose for the same brightness). DAP adds the field
   area at the patient, which is what the iris exists to shrink. */
function fieldCm() { return [23, 15, 11][F.mag] || 23; }
function irisCm() { return (fieldCm() / 2) * F.iris; }
function akPerPulseMGy() {
  const mag = Math.pow(OEC.FIELD / fieldCm(), 2);
  return (12 / (60 * 15)) * (F.ma / 2) * Math.pow(F.kv / 70, 2.5) * mag;
}
function dosePulse() {
  const ak = akPerPulseMGy();
  F.akMGy += ak;
  // field area at the patient entrance (~0.6 of the detector-plane iris), in m^2
  const r = irisCm() * 0.6 / 100;
  F.dapUGym2 += ak * 1000 * Math.PI * r * r;
}

/* The 5-minute alarm every real machine mandates: three beeps and a flashing timer at
   each multiple, acknowledged by the dose-reset button (between-patient reset). */
let alarmAt = 300;
function doseAlarm(beamS) {
  if (beamS < alarmAt) return;
  alarmAt += 300;
  ctx.$('flBeamV')?.classList.add('alarm');
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < 3; i++) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(0.12, ac.currentTime + i * 0.35);
      g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + i * 0.35 + 0.22);
      o.start(ac.currentTime + i * 0.35); o.stop(ac.currentTime + i * 0.35 + 0.25);
    }
  } catch (err) { /* no audio context — the flash still shows */ }
}

/* Motion phases live HERE and the worker stays stateless — which is the whole trick of
   breath-hold: the breathing clock simply stops advancing while every other rhythm keeps
   its own time. Quiet breathing at 14/min; the heart at whatever HR says; a swallow is an
   event with a timestamp, not a rhythm. */
let lastPulseAt = 0;
function animTick() {
  const now = performance.now() / 1000;
  const dt = Math.min(lastPulseAt ? now - lastPulseAt : 0, 0.5);
  lastPulseAt = now;
  if (!F.hold) F.brPhase = (F.brPhase + dt / 4.3) % 1;
  F.cardPhase = (F.cardPhase + dt * F.hr / 60) % 1;
  F.periT += dt;
  const sw = F.swallowAt ? now - F.swallowAt : -1;
  if (sw > 2) F.swallowAt = 0;
  return { br: F.brPhase, card: F.cardPhase, peri: F.periT, sw };
}

function firePulse() {
  if (readyCount !== workers.length || !workers.length) { ensureWorker(); return; }
  const slot = busy.indexOf(false);
  if (slot < 0) { F.dropped++; tierTick(true); renderReadouts(); return; }
  tierTick(false);
  busy[slot] = true;
  F.pulses++;
  dosePulse();
  const g = beamFrame(), pose = ctx.phantomPose();
  workers[slot].postMessage({ type: 'pulse', id: ++pulseId, kv: F.kv, photons: photonsPerPulse(),
    src: g.src, detC: g.detC, detU: g.detU, detV: g.detV, half: fieldCm() / 2, iris: irisCm(),
    n: nPx(), rot: pose.rot, center: pose.center, anim: animTick(),
    seed: F.fixedSeed || (Math.random() * 1e9) | 0 });
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

// dev probe: where is the rig?
if (typeof window !== 'undefined') window.__flRigObj = () => ({ rig, oecBody, stretcher });
if (typeof window !== 'undefined') window.__flRig = () => ({
  rig: rig && rig.visible,
  body: oecBody && { v: oecBody.visible, s: +oecBody.scale.x.toFixed(3),
    p: oecBody.position.toArray().map((x) => +x.toFixed(1)),
    box: new ctx.THREE.Box3().setFromObject(oecBody).getSize(new ctx.THREE.Vector3()).toArray().map((x) => +x.toFixed(1)) },
});
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
  set('flAkV', (F.akMGy < 10 ? F.akMGy.toFixed(2) : F.akMGy.toFixed(1)) + ' mGy');
  set('flAkRateV', (akPerPulseMGy() * F.pps * 60).toFixed(1) + ' mGy/min');
  set('flDapV', F.dapUGym2.toFixed(1) + ' uGy·m²');
  set('flIrisV', Math.round(F.iris * 100) + ' %');
  set('flMagV', ['9"', '6"', '4.5"'][F.mag]);
  const kvS = $('flKv'), maS = $('flMa');
  if (F.abc) { if (kvS) kvS.value = F.kv; if (maS) maS.value = F.ma; }
  doseAlarm(beam);
}
function setStatus(msg) { const el = $('flStatus'); if (el) el.textContent = msg; }

/* ---- the rig ------------------------------------------------------------- */
function buildRig() {
  const { THREE, three } = ctx;
  rig = new THREE.Group();
  // With the OEC's own C now articulating (below), the indicator shrinks to the one thing
  // the mesh cannot show: the invisible beam itself — a faint cyan line from tube to II.
  const glow = new THREE.MeshBasicMaterial({ color: 0x35c6d6, transparent: true, opacity: 0.16,
    depthWrite: false });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.4, OEC.SID, 14), glow);
  beam.position.set(0, (OEC.SID - 2 * OEC.SRC_ISO) / 2, 0);   // source below iso, II above
  rig.add(beam);
  rig.visible = false;
  three.handGroup.parent.add(rig);
  // The real machine: ML's photogrammetry OEC, segmented in two (public/models/rigs/
  // oec_rig.glb). The scan's 821 fused fragments were classified geometrically — the II
  // and tube anchor the beam axis, the C's shell plates fall on an annulus about the
  // throat centre (r 0.30–0.78 m), and the workstation box and cart column fail those
  // fences — so the 'carm' node (13k faces: C + tube + II, pivot pre-shifted to the
  // throat centre) rotates with the orbital/tilt sliders while the 'body' node (37k
  // faces: cart, column, workstation) stands still. Loaded async; the beam line alone
  // is the fallback if the fetch fails.
  ctx.loadModelUrl?.(ctx.baseUrl + 'models/rigs/oec_rig.glb').then((g) => {
    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    let carmNode = null;
    g.traverse((o) => { if (!carmNode && o.name && o.name.toLowerCase().includes('carm')) carmNode = o; });
    // scale from the BODY alone — the carm's pivot shift would skew a combined box
    if (carmNode) carmNode.removeFromParent();
    const size = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3());
    const sc = 180 / Math.max(size.x, size.y, size.z);   // tallest dimension -> ~1.8 m
    g.scale.setScalar(sc);
    g.visible = false;
    three.handGroup.parent.add(g);
    oecBody = g;
    if (carmNode) {
      oecCarm = new THREE.Group();
      carmNode.scale.setScalar(sc);
      oecCarm.add(carmNode);
      oecCarm.visible = false;
      three.handGroup.parent.add(oecCarm);
    }
    fluoroSyncScene();
  }).catch(() => { /* the beam line remains */ });
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
  if (oecBody) {
    oecBody.visible = on;
    // Stand the machine so its own C wraps the isocentre. From orthographic projections
    // of the mesh: the beam axis is VERTICAL at local x ~ 0.72 — tube housing centred at
    // y ~ -0.45, II at y ~ +0.6, i.e. ~96 cm apart at this scale, which is the OEC's real
    // SID to within 3 cm. The throat midpoint (0.72, 0.07, 0) goes to the isocentre; no
    // rotation needed, the scanned machine already holds its beam upright.
    const iso = isoPoint(), sc = oecBody.scale.x;
    oecBody.position.set(iso[0] - 0.72 * sc, iso[1] - 0.07 * sc, iso[2]);
  }
  if (oecCarm) oecCarm.visible = on;
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
    // The segmented C rotates about the same isocentre with the same quaternion — its
    // local origin was pre-shifted to the throat centre at export, so position + rotate
    // is the whole articulation. (The real OEC slides its C through the holder; rigid
    // rotation about the iso is the same motion for the C itself, at the cost of the
    // C visually leaving its holder at large angles.)
    if (oecCarm) { oecCarm.position.set(iso[0], iso[1], iso[2]); oecCarm.quaternion.copy(q); }
  }
}

/* ---- mode + wiring ------------------------------------------------------- */
export function fluoroApplyMode(on) {
  if (!ctx) return;
  if (on) {
    ensureWorker();
    renderReadouts();
    setStatus(readyCount === workers.length && workers.length
      ? 'Ready — hold the pedal (or Space) to screen.'
      : 'Loading the subject into the pulse workers…');
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
      renderReadouts();          // the dose RATE depends on pps even while the beam is off
    });
  });
  const slide = (id, key) => {
    $(id)?.addEventListener('input', (e) => {
      F[key] = parseFloat(e.target.value);
      renderReadouts();
      if (key === 'orbital' || key === 'tilt') fluoroSyncScene();
    });
  };
  slide('flKv', 'kv'); slide('flMa', 'ma'); slide('flOrb', 'orbital'); slide('flTilt', 'tilt');
  slide('flIris', 'iris');
  document.querySelectorAll('#flAbcSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      F.abc = b.dataset.abc === '1';
      document.querySelectorAll('#flAbcSeg button').forEach((x) => x.classList.toggle('on', x === b));
      const kvEl = $('flKv'), maEl = $('flMa');
      if (kvEl) kvEl.disabled = F.abc;
      if (maEl) maEl.disabled = F.abc;
      if (!F.abc) { F.kv = +kvEl.value; F.ma = +maEl.value; }
      renderReadouts();
    });
  });
  document.querySelectorAll('#flMagSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      F.mag = +b.dataset.mag;
      document.querySelectorAll('#flMagSeg button').forEach((x) => x.classList.toggle('on', x === b));
      renderReadouts();
    });
  });
  $('flHold')?.addEventListener('click', () => {
    F.hold = !F.hold;
    $('flHold').classList.toggle('on', F.hold);
  });
  $('flSwallow')?.addEventListener('click', () => { F.swallowAt = performance.now() / 1000; });
  $('flHr')?.addEventListener('input', (e) => {
    F.hr = +e.target.value;
    const el = $('flHrV'); if (el) el.textContent = F.hr + ' bpm';
  });
  $('flDoseReset')?.addEventListener('click', () => {
    F.akMGy = 0; F.dapUGym2 = 0; F.beamS = 0; alarmAt = 300;
    $('flBeamV')?.classList.remove('alarm');
    renderReadouts();
  });
  // ABC starts ON: the sliders are the override, not the default
  const kvEl = $('flKv'), maEl = $('flMa');
  if (kvEl) kvEl.disabled = true;
  if (maEl) maEl.disabled = true;
  abcApply();
  // A subject change invalidates the workers' copy of the volume. Rebuild once the new
  // volume has actually LOADED (the change event fires before the fetch finishes) so the
  // motion scan runs and the status tells the truth without waiting for a pedal press.
  const sel = $('subjectSel');
  sel?.addEventListener('change', () => {
    workerSub = null;
    const want = sel.value;
    const poll = setInterval(() => {
      if (ctx.S.mode !== 'fluoro') { clearInterval(poll); return; }
      if (ctx.S.subject === want && ctx.S.voxelModel && !ctx.S.subjectLoading) {
        clearInterval(poll); F.motions = []; ensureWorker();
      }
    }, 300);
    setTimeout(() => clearInterval(poll), 30000);
  });
  renderReadouts();
}
