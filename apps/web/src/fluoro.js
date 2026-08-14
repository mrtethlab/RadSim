/* ============================================================================
   FLUOROSCOPY MODE — Phase A: the pulse loop (docs/fluoroscopy.md)
   A GE OEC portable C-arm around the subject, a foot pedal, four authentic pulse rates,
   and a worker raycaster. The simulation frame rate IS the pulse rate: 3 pps genuinely
   updates three times a second and feels exactly that jerky, and a pulse that arrives
   while the previous one is still rendering is DROPPED and counted, never queued —
   latency is the enemy of a live image, and the dropped counter is the honest budget
   readout Phase A exists to measure.
   ============================================================================ */
import { dockConsole } from './core/paneDock.js';

let ctx = null;          // { THREE, S, $, three, phantomPose, syncScene }
let F = null;            // ctx.S.fluoro
// A POOL of pulse workers, round-robin: one worker sustains ~18 pps at the Phase A
// budget (measured 54 ms/pulse at 192 px on the hand), so 30 pps needs two in flight.
// Frames can then land out of order — each carries its pulse id and stale ones are
// discarded, never drawn over a newer frame. Mobile keeps a pool of one: the second
// volume copy costs more memory than 7.5 pps is worth.
let workers = [], busy = [], readyCount = 0, workerSub = null;
let giVolSent = false;   // whether this pool has the barium arclength map
let sVolSent = false;    // whether this pool has the vessel arclength map
/* ---- DSA state (docs/fluoroscopy.md Phase E) ------------------------------
   The mask lives at the native pulse resolution, in log-transmission. While DSA is on the
   sampling tier and the technique are FROZEN — subtraction only means anything against a
   mask taken with identical geometry and beam. */
let dsaOn = false, dsaMask = null, dsaN = 0, remaskNext = false;
let dsaAcc = null, dsaAccCnt = 0;      // the mask is an AVERAGE of the first frames
const MASK_FRAMES = 4;
let dsaSX = 0, dsaSY = 0;              // pixel shift applied to the mask lookup
let lastRaw = null, lastN = 0;         // last raw frame, for re-render on shift changes
let roadAcc = null, roadmap = null, roadN = 0, roadOn = false;
/* ---- cine (Phase G): MediaRecorder on the monitor canvas -----------------
   Armed, every pedal run is captured; DSA runs record themselves, as the real suite
   does. Clips live as blob URLs, capped, oldest evicted. */
let recArm = false, recorder = null, recChunks = [], recT0 = 0, recMeta = null;
let clips = [];                        // {url, durS, label, id}
let clipSeq = 0;
const CLIP_MAX = 6;
function recStart() {
  const film = $('film');
  if (!film || recorder || typeof MediaRecorder === 'undefined') return;
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported?.(m));
  if (!mime) return;
  try {
    recorder = new MediaRecorder(film.captureStream(30), { mimeType: mime });
  } catch (_) { recorder = null; return; }
  recChunks = [];
  recT0 = performance.now();
  recMeta = `${F.pps} pps · ${F.kv} kV` + (dsaOn ? ' · DSA' : '');
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => {
    const durS = (performance.now() - recT0) / 1000;
    if (recChunks.length && durS > 0.4) {
      const url = URL.createObjectURL(new Blob(recChunks, { type: recorder.mimeType }));
      const clip = { url, durS, label: recMeta, id: ++clipSeq };
      clips.unshift(clip);
      while (clips.length > CLIP_MAX) URL.revokeObjectURL(clips.pop().url);
      renderCine();
      // A RUN belongs in the directory too, alongside the stills: a poster frame to find
      // it by, and the clip itself behind it. That is what "save the run" means.
      if (frameCanvas && frameCanvas.width) {
        const c = document.createElement('canvas');
        c.width = 256; c.height = 256;
        renderTo(c);
        F.saved.unshift({ url: c.toDataURL('image/jpeg', 0.72), kind: 'loop', clip,
          meta: `${durS.toFixed(1)} s · ${recMeta}`, t: Math.round(F.beamS) });
        if (F.saved.length > DIR_MAX) F.saved.length = DIR_MAX;
        renderDirectory();
      }
    }
    recorder = null; recChunks = [];
  };
  recorder.start(120);
  $('recBadge')?.classList.add('show');
}
function recStop() {
  $('recBadge')?.classList.remove('show');
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  else recorder = null;
}
function renderCine() {
  const list = $('flCineList'); if (!list) return;
  list.innerHTML = '';
  for (const c of clips) {
    const row = document.createElement('div');
    row.className = 'cinerow';
    row.innerHTML = `<span class="t">Loop ${c.id} · ${c.durS.toFixed(1)} s · ${c.label}</span>`
      + `<button data-act="play">&#9654;</button><button data-act="dl">&#8595; webm</button>`;
    row.querySelector('[data-act="play"]').addEventListener('click', () => cinePlay(c, row));
    row.querySelector('[data-act="dl"]').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = c.url; a.download = `fluoro-loop-${c.id}.webm`; a.click();
    });
    list.appendChild(row);
  }
}
function cinePlay(c, row) {
  const v = $('flCineView'); if (!v) return;
  document.querySelectorAll('.cinerow.playing').forEach((r) => r.classList.remove('playing'));
  row?.classList.add('playing');
  v.src = c.url; v.classList.add('show');
  $('flCineClose')?.classList.add('show');
  v.play?.();
}
function cineStop() {
  const v = $('flCineView');
  if (v) { v.pause?.(); v.classList.remove('show'); v.removeAttribute('src'); }
  $('flCineClose')?.classList.remove('show');
  document.querySelectorAll('.cinerow.playing').forEach((r) => r.classList.remove('playing'));
}
let timer = null, pulseId = 0, pedalDownAt = 0, lastDrawn = 0;
let rig = null, stretcher = null, oecBody = null, oecCarm = null, oecBoom = null, oecCol = null;
let pendShown = false;   // the orientation pad's triangle: pending rotation being dialled in
let shutTouched = 0;     // when collimation was last moved — the leaf wires linger after

// GE OEC geometry, datasheet-rounded (cm): fixed SID, source under the patient at 0°.
// LARM: boom pivot (the column axis) to the beam axis, cm — wig-wag's arc radius.
const OEC = { SID: 99, SRC_ISO: 60, FIELD: 23, LARM: 94 };
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
// Beam direction before wig-wag: orbital about z, tilt about x, 0° = up.
function beamDir0() {
  const th = F.orbital * Math.PI / 180, ti = F.tilt * Math.PI / 180;
  return [Math.sin(th) * Math.cos(ti), Math.cos(th) * Math.cos(ti), Math.sin(ti)];
}
// Wig-wag yaws the whole boom+C about the column's vertical axis.
function beamDir() {
  const d = beamDir0(), w = F.wig * Math.PI / 180, c = Math.cos(w), s = Math.sin(w);
  return [d[0] * c + d[2] * s, d[1], -d[0] * s + d[2] * c];
}
/* The C-arm's isocentre is a point in the ROOM, not on the patient: it sits over the
   stretcher's centre at the subject's nominal mid-plane, and the offset sliders slide the
   PATIENT through the field. The first version tracked objOff here, which aimed the beam
   at the subject's centre wherever it went — panning changed nothing, which is exactly
   the bug the ABC exit test caught (lung and liver read identical technique). */
function isoBase() {
  const vm = ctx.S.voxelModel;
  const ey = vm ? (vm.extentMM[1] / 2) / 10 : 5;
  return [0, ey, 0];
}
/* The column motions move the ISOCENTRE itself: lift raises the whole C (the patient
   drops toward the source — magnification), extend slides the beam across the table,
   wig-wag arcs it about the column axis LARM behind the beam. All three feed straight
   into beamFrame(), so the image pans and magnifies for real, and ABC re-meters. */
function isoPoint() {
  const b = isoBase(), w = F.wig * Math.PI / 180, r = OEC.LARM + F.ext;
  return [b[0] - OEC.LARM + Math.cos(w) * r, b[1] + F.lift, b[2] - Math.sin(w) * r];
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
  giVolSent = false; sVolSent = false;       // the fresh pool has no arclength maps yet
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
          if (m.film) { filmPending = false; saveToDirectory('film'); }
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
  return 1300 * (F.ma / 2) * Math.pow(F.kv / 70, 2) * (filmPending ? FILM_BOOST : 1);
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
// LOW DOSE moves THIS, not the beam: the loop is told to defend half the detector dose,
// settles at a lower technique on its own, and the kerma falls because the technique did.
// Multiplying the photons instead — the first attempt — just made the loop put the mA
// straight back, which is exactly what a closed loop is for and why the button read as a
// no-op on the image while the meter claimed a saving it was not making.
const ABC_TARGET = 45;                      // detected photons/pixel the loop defends
const abcTarget = () => ABC_TARGET * doseFactor();
function abcApply() {
  const q = F.q;
  F.kv = Math.round(52 + 58 * q);
  F.ma = Math.round((0.5 + 9.5 * q * q) * 10) / 10;
}
function abcStep(roi, photons) {
  if (dsaOn) return;              // DSA locks the technique from arming: subtraction against
                                  // a mask taken at a different beam would be pure artefact
  if (!F.abc || !F.pedal) return;
  const meas = photons * roi;               // what the detector actually collected
  if (meas <= 0) return;
  // log-domain proportional step: the full curve spans ~e^6 of detected signal, and a
  // gain of 0.3 settles chest->abdomen in four or five pulses without hunting
  F.q = Math.max(0, Math.min(1, F.q + 0.3 * Math.log(abcTarget() / meas) / 6));
  abcApply();
}

/* ---- dose ----------------------------------------------------------------------------
   Reference-point air kerma modelled on a mid-size C-arm: ~12 mGy/min at 70 kV / 2 mA /
   15 pps, scaling with tube output (kV^2.5 x mA), pulse count, and the mag factor (a
   smaller II field needs more input dose for the same brightness). DAP adds the field
   area at the patient, which is what the iris exists to shrink. */
function fieldCm() { return [23, 15, 11][F.mag] || 23; }
function irisCm() { return (fieldCm() / 2) * F.iris; }
// the shutter pair's half-separation, in the same detector-plane centimetres as the iris
function shutCm() { return (fieldCm() / 2) * F.shut; }
// DSA acquisition runs at far higher detector dose per frame than screening fluoro —
// that is what makes subtraction quiet enough to read (sd(lnT) drops from ~0.21 between
// two fluoro frames to ~0.05), and it is why a DSA run costs what it costs on the meter.
const DSA_BOOST = 60;
// LOW DOSE is a real button with a real bargain: half the detector dose per pulse, so
// half the kerma AND half the quanta. The noise it buys is not a side effect to hide.
function doseFactor() { return F.lowDose ? 0.5 : 1; }
function akPerPulseMGy() {
  const mag = Math.pow(OEC.FIELD / fieldCm(), 2);
  return (12 / (60 * 15)) * (F.ma / 2) * Math.pow(F.kv / 70, 2.5) * mag
    * (dsaOn ? DSA_BOOST : 1) * (filmPending ? FILM_BOOST : 1);
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
  F.alarm = true;
  ctx.$('flAlarmReset')?.classList.add('armed');
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
  // MOTION OFF: a verification pose, not a physiology — every clock stands still and the
  // worker drops every warp, so a DSA subtraction can be judged against pure noise
  if (F.still) return { off: true };
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
  // A LIVE barium study rides along: the LUT snapshot travels with every pulse (tens of
  // kB), the per-voxel arclength map once per pool (it is per-subject and megabytes).
  const bp = ctx.bariumPulse?.();
  if (bp && !giVolSent) {
    workers.forEach((w) => w.postMessage({ type: 'givol', giVol: bp.giVol, ns: bp.ns }));
    giVolSent = true;
  }
  const cp = ctx.contrastPulse?.();
  if (cp && !sVolSent) {
    workers.forEach((w) => w.postMessage({ type: 'svol', sVol: cp.sVol, ns: cp.ns }));
    sVolSent = true;
  }
  workers[slot].postMessage({ type: 'pulse', id: ++pulseId, kv: F.kv,
    photons: photonsPerPulse() * (dsaOn ? DSA_BOOST : 1),
    src: g.src, detC: g.detC, detU: g.detU, detV: g.detV, half: fieldCm() / 2, iris: irisCm(), shut: shutCm(), shutRot: F.shutRot * Math.PI / 180,
    n: dsaOn ? dsaN : nPx(), rot: pose.rot, center: pose.center, anim: animTick(),
    ba: bp ? bp.ba : null, gas: bp ? bp.gas : null, giNS: bp ? bp.ns : 0,
    iod: cp ? cp.iod : null, svNS: cp ? cp.ns : 0,
    film: filmPending,
    seed: F.fixedSeed || (Math.random() * 1e9) | 0 });
}

/* ---- display ------------------------------------------------------------- */
let frameCanvas = null;
/* The pre-window luminance of the last frame, 0..1, with -1 for "outside the field".
   Keeping it lets the CONTRAST buttons re-window a held image without another pulse —
   which is the whole claim those buttons make: the display changes, the patient is not
   exposed again. */
let lastLum = null;
function paintFrame(n) {
  if (!frameCanvas || !lastLum) return;
  const g2 = frameCanvas.getContext('2d');
  const id = g2.createImageData(n, n);
  const b = F.bright, c = F.cont, inv = F.invert;
  for (let k = 0; k < n * n; k++) {
    const l = lastLum[k];
    let v = 0;
    if (l >= 0) {
      v = (l - 0.5) * c + 0.5 + b;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      if (inv) v = 1 - v;
    }
    // outside the field stays black whatever the window does: there is no detector there,
    // and inverting nothing must not make it white
    const g = v * 255;
    id.data[k * 4] = id.data[k * 4 + 1] = id.data[k * 4 + 2] = g;
    id.data[k * 4 + 3] = 255;
  }
  g2.putImageData(id, 0, 0);
  blitFilm();
}
function redrawLast() { if (lastLum && lastN) paintFrame(lastN); }
function drawFrame(img, n) {
  const film = $('film'); if (!film) return;
  lastRaw = img; lastN = n;
  if (!frameCanvas) frameCanvas = document.createElement('canvas');
  if (frameCanvas.width !== n) { frameCanvas.width = n; frameCanvas.height = n; }
  if (!lastLum || lastLum.length !== n * n) lastLum = new Float32Array(n * n);
  const lum = lastLum;
  if (dsaOn) {
    // ---- digital subtraction: everything that has not changed since the mask vanishes.
    // The mask is the AVERAGE log-transmission of the first frames of the run (mask noise
    // divides away); iodine arriving makes the diff negative and draws dark on the flat
    // grey. Motion draws too — which is the lesson, and what the breath-hold button is for.
    if (remaskNext || dsaN !== n || (!dsaMask && !dsaAcc)) {
      dsaAcc = new Float32Array(n * n); dsaAccCnt = 0; dsaMask = null;
      dsaN = n; remaskNext = false; dsaSX = 0; dsaSY = 0;
      roadAcc = new Float32Array(n * n);
    }
    if (!dsaMask) {
      for (let k = 0; k < n * n; k++) {
        if (img[k] >= 0) { if (dsaAcc[k] < 1e8) dsaAcc[k] += Math.log(Math.max(img[k], 1e-6)); }
        else dsaAcc[k] = 1e9;
      }
      if (++dsaAccCnt >= MASK_FRAMES) {
        dsaMask = dsaAcc; dsaAcc = null;
        for (let k = 0; k < dsaMask.length; k++) if (dsaMask[k] < 1e8) dsaMask[k] /= MASK_FRAMES;
      }
      for (let k = 0; k < n * n; k++) lum[k] = img[k] >= 0 ? 0.55 : -1;   // masking: flat grey
    } else {
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const k = j * n + i, t = img[k];
        let g = -1;
        if (t >= 0) {
          const mi = Math.min(n - 1, Math.max(0, i + dsaSX));
          const mj = Math.min(n - 1, Math.max(0, j + dsaSY));
          const mv = dsaMask[mj * n + mi];
          if (mv < 1e8) {
            const diff = Math.log(Math.max(t, 1e-6)) - mv;
            g = Math.min(1, Math.max(0, 0.55 + 2.0 * diff));
            // peak-opacification accumulator, gated above what the boosted quantum
            // mottle can reach — a max over frames would otherwise collect speckle
            if (F.pedal && roadAcc) { const io = -diff; if (io > 0.3 && io > roadAcc[k]) roadAcc[k] = io; }
          } else g = 0.55;
        }
        lum[k] = g;
      }
    }
  } else {
    // primitive display ABC (the technique loop is Phase B): gain the central-disc mean to
    // mid-grey so panning stays watchable, then a gamma lift for the II look
    let sum = 0, cnt = 0;
    const c0 = n * 0.35 | 0, c1 = n * 0.65 | 0;
    for (let j = c0; j < c1; j++) for (let i = c0; i < c1; i++) {
      const t = img[j * n + i]; if (t >= 0) { sum += t; cnt++; }
    }
    const gain = cnt && sum > 0 ? 0.45 / (sum / cnt) : 1;
    const road = roadOn && roadmap ? roadmap : null;
    const rs = road ? roadN / n : 0;
    for (let k = 0; k < n * n; k++) {
      const t = img[k];
      let g = -1;
      if (t >= 0) {
        g = Math.min(1, Math.sqrt(Math.min(1.6, t * gain)));
        if (road) {
          // the stored peak-opacification map rides under live fluoro — the navigation mode.
          // Only strong columns draw; the slope saturates a well-opacified vessel to black.
          const i = k % n, j = (k / n) | 0;
          const rd = road[((j * rs) | 0) * roadN + ((i * rs) | 0)];
          if (rd > 0.35) g *= Math.max(0, 1 - (rd - 0.35) * 2.2);
        }
      }
      lum[k] = g;
    }
  }
  paintFrame(n);
}

/* Electronic image orientation: the display turns, the beam does not — exactly the pad on
   the real machine. Rotation dialled on the pad is PENDING: a triangle on the last image
   marks where the top of the next run will be; pedal-down folds it into the display. */
function blitFilm() {
  const film = $('film'); if (!film || !frameCanvas) return;
  if (film.width !== 330) { film.width = 330; film.height = 440; }
  syncScreens();                     // which monitor is live is the WORKSTATION button's
  // the monitor's own corner stamps — otherwise the last mode's are still sitting there
  const tl = $('fnTL'); if (tl) tl.textContent = `FLUORO ${F.pps} pps` + (F.lowDose ? ' · LOW' : '');
  const br = $('fnBR'); if (br) br.textContent = `${F.kv} kV · ${F.ma.toFixed(1)} mA · ${['9"', '6"', '4.5"'][F.mag]}`;
  $('noexp')?.style.setProperty('display', 'none');
  // the bay's Image view mirrors the fluoro monitor live (instead of the last x-ray)
  if (ctx.S.bayContent === 'image' && ctx.S.mode === 'fluoro') fluoroImageToBay();
}
/* Render the current frame (with orientation) into any canvas — the monitor and the
   bay's big Image view share this one pipeline. */
function renderTo(cv) {
  const g2 = cv.getContext('2d');
  g2.fillStyle = '#000'; g2.fillRect(0, 0, cv.width, cv.height);
  const s = Math.min(cv.width, cv.height) - 10;
  const cx = cv.width / 2, cy = cv.height / 2;
  g2.imageSmoothingEnabled = true;
  g2.save();
  g2.translate(cx, cy);
  g2.rotate(F.dispRot * Math.PI / 180);
  g2.scale(F.flipH ? -1 : 1, F.flipV ? -1 : 1);
  g2.drawImage(frameCanvas, -s / 2, -s / 2, s, s);
  g2.restore();
  /* THE SHUTTER LEAVES, DRAWN AS WIRES. Two parallel edges brought in from the sides and
     rotated as a pair — the graphic a real machine paints over the last image so you can
     collimate onto the anatomy WITHOUT screening to do it. They sit inside the orientation
     transform because the leaves are in the BEAM: turn the image and they turn with the
     anatomy they are cutting, which is the whole reason to draw them at all. */
  if (F.shut < 0.999 || performance.now() - shutTouched < 2600) {
    const hp = F.shut * (s / 2);                    // half-separation, display px
    const th = F.shutRot * Math.PI / 180;
    const ux = Math.cos(th), uy = Math.sin(th);     // along the leaf
    const ax = -uy, ay = ux;                        // across it
    g2.save();
    g2.translate(cx, cy);
    g2.rotate(F.dispRot * Math.PI / 180);
    g2.scale(F.flipH ? -1 : 1, F.flipV ? -1 : 1);
    g2.lineWidth = 1.5;
    g2.strokeStyle = 'rgba(150,235,170,0.9)';
    g2.setLineDash([7, 5]);
    for (const sg of [1, -1]) {
      const ox = ax * hp * sg, oy = ay * hp * sg;
      g2.beginPath();
      g2.moveTo(ox - ux * s, oy - uy * s);
      g2.lineTo(ox + ux * s, oy + uy * s);
      g2.stroke();
    }
    g2.setLineDash([]);
    g2.restore();
  }
  if (pendShown) {
    // the content that will land at 12 o'clock after a CW rotation by pendRot currently
    // sits pendRot COUNTER-clockwise of top — mark it inside the exposure circle
    const b = -F.pendRot * Math.PI / 180, r = s / 2 - 9;
    const px = cx + Math.sin(b) * r, py = cy - Math.cos(b) * r;
    g2.save();
    g2.translate(px, py);
    g2.rotate(b);                          // point the triangle inward, toward the centre
    g2.fillStyle = '#7fe3a4';
    g2.beginPath(); g2.moveTo(0, 7); g2.lineTo(-6, -4); g2.lineTo(6, -4); g2.closePath();
    g2.fill();
    g2.restore();
  }
}


/* ---- FILM, SAVE, and the Image Directory -----------------------------------
   Three things a real console keeps apart, and so does this one.

   FILM is an ACQUISITION: one frame at ~12x the screening dose, which is why a spot
   image is quiet enough to read, and why it costs what the meter then says it costs.
   It files itself, because an image worth that dose is worth keeping.

   SAVE is not an acquisition. It puts what is ALREADY on the monitor into the
   directory and exposes nobody. That distinction is the entire reason the machine has
   two buttons instead of one.

   The directory holds both, newest first, and clicking one puts it on the reference
   screen — which is what the second monitor is for. */
const FILM_BOOST = 12;
const DIR_MAX = 24;
let filmPending = false;
let refImg = null, refImgEl = null;

function filmShot() {
  if (ctx.S.mode !== 'fluoro') return;
  if (readyCount !== workers.length || !workers.length) { ensureWorker(); setStatus('Warming up the workers…'); return; }
  filmPending = true;                  // read by akPerPulseMGy and photonsPerPulse
  firePulse();                         // one pulse, boosted, outside the pedal's clock
}
function saveToDirectory(kind) {
  if (!frameCanvas || !frameCanvas.width) { setStatus('Nothing on the monitor to save.'); return; }
  const k = kind || 'save';
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  renderTo(c);
  F.saved.unshift({ url: c.toDataURL('image/jpeg', 0.72), kind: k,
    meta: `${F.kv.toFixed(0)}kV ${F.ma.toFixed(1)}mA ${['9"', '6"', '4.5"'][F.mag]}`,
    t: Math.round(F.beamS) });
  if (F.saved.length > DIR_MAX) F.saved.length = DIR_MAX;
  if (!refImg) refImg = F.saved[0].url;   // the first save fills the empty reference screen
  renderDirectory();
  syncScreens();
  setStatus(k === 'film' ? `Spot image filed (${F.saved.length} in the directory).`
                         : `Saved (${F.saved.length} in the directory).`);
}
function renderDirectory() {
  const grid = $('flDirGrid'), note = $('flDirNote');
  if (!grid) return;
  grid.innerHTML = '';
  F.saved.forEach((it) => {
    const d = document.createElement('div');
    d.className = 'imgdirit' + (it.url === refImg ? ' sel' : '');
    const tag = it.kind === 'film' ? 'FILM' : it.kind === 'loop' ? 'LOOP' : '';
    d.innerHTML = `<img src="${it.url}" alt=""><div class="kind">${tag}</div>`
      + `<div class="cap">${it.meta}</div>`;
    d.addEventListener('click', () => {
      if (it.clip) { openDirectory(false); cinePlay(it.clip, null); return; }   // a run plays
      refImg = it.url; F.ws2 = 'ref';
      renderDirectory(); syncScreens();
      setStatus('On the reference screen.');
    });
    grid.appendChild(d);
  });
  if (note) note.style.display = F.saved.length ? 'none' : '';
}
function openDirectory(on) {
  F.dirOpen = !!on;
  $('flImgDirPane')?.classList.toggle('show', F.dirOpen);
  $('flImgDir')?.classList.toggle('on', F.dirOpen);
  if (F.dirOpen) renderDirectory();
}

/* ---- the two screens --------------------------------------------------------
   One live, one to study. WORKSTATION swaps which is which, exactly as it does on the
   cart: the image you want to look at takes the big monitor and the live one steps
   down, without anything stopping. MODE chooses what the second screen holds — the
   saved reference, or a second copy of the live image. */
function drawRefInto(cv) {
  const g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
  if (!refImg) return false;
  if (!refImgEl || refImgEl.dataset_src !== refImg) {
    refImgEl = new Image();
    refImgEl.dataset_src = refImg;
    refImgEl.onload = () => syncScreens();      // repaint once it has decoded
    refImgEl.src = refImg;
  }
  if (refImgEl.complete && refImgEl.naturalWidth) {
    const s = Math.min(cv.width, cv.height);
    g.drawImage(refImgEl, (cv.width - s) / 2, (cv.height - s) / 2, s, s);
  }
  return true;
}
function syncScreens() {
  const film = $('film'), c2 = $('film2');
  if (!film) return;
  const liveOnMain = !F.ws;
  const haveLive = !!(frameCanvas && frameCanvas.width);
  if (liveOnMain) { if (haveLive) renderTo(film); } else drawRefInto(film);
  if (!c2) return;
  let has;
  if (!liveOnMain) { has = haveLive; if (has) renderTo(c2); else drawRefInto(c2); }
  else if (F.ws2 === 'live') { has = haveLive; if (has) renderTo(c2); }
  else has = drawRefInto(c2);
  $('flScr2Empty')?.classList.toggle('hide', !!has);
  const lab = $('flScr2Lab');
  if (lab) lab.textContent = liveOnMain ? (F.ws2 === 'live' ? 'LIVE (COPY)' : 'REFERENCE') : 'LIVE';
  film.parentElement?.classList.toggle('refonmain', !liveOnMain);
}

/* The bay's Image view (View Options) shows the FLUORO frame while in fluoro mode.
   Returns whether a frame exists — app.js uses that to pick bigFilm vs the no-image note. */
export function fluoroImageToBay() {
  const bf = $('bigFilm');
  if (!bf || !frameCanvas || !frameCanvas.width) return false;
  const w = bf.clientWidth || bf.parentElement?.clientWidth || 640;
  const h = bf.clientHeight || 480;
  if (bf.width !== w || bf.height !== h) { bf.width = w; bf.height = h; }
  renderTo(bf);
  return true;
}

/* ---- pedal + pulse clock ------------------------------------------------- */
function pedalDown() {
  if (F.pedal || ctx.S.mode !== 'fluoro') return;
  if (!ensureWorker()) { /* first press warms the worker; screening starts when ready */ }
  F.pedal = true; F.lih = false; pedalDownAt = performance.now();
  // fold the pending orientation into the display: the marked direction becomes top,
  // and the first frame of this run erases the triangle
  if (pendShown) { F.dispRot = (F.dispRot + F.pendRot) % 360; F.pendRot = 0; pendShown = false; }
  $('flPedal')?.classList.add('on');
  $('lihBadge')?.classList.remove('show');
  cineStop();                                  // live screening takes the monitor back
  if (recArm || dsaOn) recStart();
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
  recStop();
  // end of a DSA run: its peak-opacification map becomes the roadmap
  if (dsaOn && roadAcc) {
    let peak = 0;
    for (let k = 0; k < roadAcc.length; k++) if (roadAcc[k] > peak) peak = roadAcc[k];
    if (peak > 0.5) {
      // RAW peak opacification, not normalised — the overlay draws only where the iodine
      // column was strong, so organ blush and mild motion stay off the map
      roadmap = roadAcc.slice();
      roadN = dsaN;
      const rb = $('flRoad'); if (rb) rb.disabled = false;
    }
  }
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
  set('flLiftV', F.lift + ' cm');
  set('flExtV', (F.ext > 0 ? '+' : '') + F.ext + ' cm');
  set('flWigV', F.wig + '°');
  set('flAkV', (F.akMGy < 10 ? F.akMGy.toFixed(2) : F.akMGy.toFixed(1)) + ' mGy');
  set('flAkRateV', (akPerPulseMGy() * F.pps * 60).toFixed(1) + ' mGy/min');
  set('flDapV', F.dapUGym2.toFixed(1) + ' uGy·m²');
  set('flIrisV', Math.round(F.iris * 100) + ' %');
  set('flIrisV2', Math.round(F.iris * 100) + '%');
  set('flShutV', Math.round(F.shut * 100) + '%');
  set('flShutV2', Math.round(F.shut * 100) + ' %');
  set('flShutRotV', F.shutRot + '°');
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
    let carmNode = null, boomNode = null, colNode = null;
    g.traverse((o) => {
      const n = (o.name || '').toLowerCase();
      if (!carmNode && n.includes('carm')) carmNode = o;
      else if (!boomNode && n.includes('boom')) boomNode = o;
      else if (!colNode && n.includes('column')) colNode = o;
    });
    // scale from the BODY alone — the movable nodes' pivot shifts would skew a combined box
    if (carmNode) carmNode.removeFromParent();
    if (boomNode) boomNode.removeFromParent();
    if (colNode) colNode.removeFromParent();
    const size = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3());
    const sc = 180 / Math.max(size.x, size.y, size.z);   // tallest dimension -> ~1.8 m
    g.scale.setScalar(sc);
    g.visible = false;
    three.handGroup.parent.add(g);
    oecBody = g;
    const wrap = (node) => {
      const grp = new THREE.Group();
      node.scale.setScalar(sc);
      grp.add(node);
      grp.visible = false;
      three.handGroup.parent.add(grp);
      return grp;
    };
    if (carmNode) oecCarm = wrap(carmNode);
    if (boomNode) oecBoom = wrap(boomNode);
    if (colNode) oecCol = wrap(colNode);
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
    const b = isoBase(), sc = oecBody.scale.x;
    oecBody.position.set(b[0] - 0.72 * sc, b[1] - 0.07 * sc, b[2]);
  }
  if (oecCarm) oecCarm.visible = on;
  if (oecBoom) oecBoom.visible = on;
  if (oecCol) oecCol.visible = on;
  // The x-ray rig belongs to the other room. Hiding is enough: ctSyncScene restores the
  // tube on every sync once the mode is no longer fluoro, so there is nothing to undo.
  if (on) {
    if (three.tube) three.tube.visible = false;
    if (three.lamp) three.lamp.intensity = 0;
    if (three.cr) three.cr.visible = false;
    // the x-ray receptor belongs to the other room too: ctSyncScene re-shows it on every
    // sync for any non-CT mode, so fluoro overrides it here (this runs after ctSyncScene)
    if (three.det) three.det.visible = false;
    if (three.detMarks) three.detMarks.visible = false;
    if (three.detArrow) three.detArrow.visible = false;
    if (three.aecGroup) three.aecGroup.visible = false;
    const iso = isoPoint(), b = isoBase();
    rig.position.set(iso[0], iso[1], iso[2]);
    // Compose the joint chain explicitly so the C keeps its roll: wig-wag yaw about the
    // room's vertical axis, times the orbital/tilt rotation. (setFromUnitVectors on the
    // final beam direction would pick an arbitrary twist once yaw is involved.)
    const w = F.wig * Math.PI / 180;
    const qw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), w);
    const q0 = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(...beamDir0()));
    const q = qw.clone().multiply(q0);
    rig.quaternion.copy(q);
    // The segmented C rotates about the (moving) isocentre — its local origin was
    // pre-shifted to the throat centre at export, so position + rotate is the whole
    // articulation. (The real OEC slides its C through the holder; rigid rotation
    // about the iso is the same motion for the C itself, at the cost of the C
    // visually leaving its holder at large orbital angles.)
    if (oecCarm) { oecCarm.position.set(iso[0], iso[1], iso[2]); oecCarm.quaternion.copy(q); }
    // The boom pivots at the column axis (its local origin, LARM behind the beam):
    // wig-wag yaws it, lift raises it, extend slides it along its own yawed axis. It
    // does NOT tilt: the flip-flop pivot at its far end lets the C roll while the arm
    // holds still — the tilt axis (the horizontal line through hub and arc centre) is
    // exactly the line the C already rotates about.
    if (oecBoom) {
      oecBoom.position.set(b[0] - OEC.LARM + Math.cos(w) * F.ext, b[1] + F.lift,
        b[2] - Math.sin(w) * F.ext);
      oecBoom.quaternion.copy(qw);
    }
    // The column telescopes out of its base collar: it rises with lift and nothing else —
    // extend and wig-wag happen above it, at the boom.
    if (oecCol && oecBody) {
      const sc = oecBody.scale.x;
      oecCol.position.set(b[0] - 0.72 * sc, b[1] - 0.07 * sc + F.lift, b[2]);
    }
  }
}

/* ---- mode + wiring ------------------------------------------------------- */
export function fluoroApplyMode(on) {
  if (!ctx) return;
  // Desktop layout: the monitor moves one pane left and the pedal follows it — see
  // core/paneDock.js, which ultrasound shares.
  dockConsole(on, $('flPedalRow'));
  if (on) {
    ensureWorker();
    renderReadouts();
    setStatus(readyCount === workers.length && workers.length
      ? 'Ready — hold the pedal (or Space) to screen.'
      : 'Loading the subject into the pulse workers…');
  } else {
    pedalUp();
    cineStop();
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
    ped.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { ped.setPointerCapture(e.pointerId); } catch (_) { /* capture is a nicety, the pedal is not */ }
      pedalDown();
    });
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
      if (['orbital', 'tilt', 'lift', 'ext', 'wig'].includes(key)) fluoroSyncScene();
    });
  };
  slide('flKv', 'kv'); slide('flMa', 'ma'); slide('flOrb', 'orbital'); slide('flTilt', 'tilt');
  slide('flLift', 'lift'); slide('flExt', 'ext'); slide('flWig', 'wig');
  // ================= THE CONTROL PANEL =================
  // Everything on the machine's own console. The rule the panel is arranged around, and
  // the one the note under it states: ORIENTATION and CONTRAST are electronic — the
  // display turns and brightens and the beam does nothing — while FIELD and COLLIMATION
  // are in the beam, and both of them change the patient's dose.
  const panelSync = () => {
    document.querySelectorAll('.oeclamp').forEach((l) => l.classList.toggle('on', +l.dataset.mag === F.mag));
    $('flInvert')?.classList.toggle('on', F.invert);
    $('flLowDose')?.classList.toggle('on', F.lowDose);
    $('flAutoBtn')?.classList.toggle('on', F.abc);
    $('flWorkstation')?.classList.toggle('on', F.ws);
    $('flAlarmReset')?.classList.toggle('armed', F.alarm);
    const kvEl = $('flKv'), maEl = $('flMa');
    if (kvEl) kvEl.disabled = F.abc;
    if (maEl) maEl.disabled = F.abc;
    renderReadouts();
  };
  // ---- ORIENTATION: invert joins rotate and the flips (all display-side) ----
  // redrawLast, not blitFilm: the invert lives in the grey mapping, so the frame has to be
  // re-mapped from the stored luminance, not merely blitted again
  $('flInvert')?.addEventListener('click', () => { F.invert = !F.invert; panelSync(); redrawLast(); });
  // ---- FIELD: 9" / 6" / 4.5", and the lamps say which ----
  $('flMagCycle')?.addEventListener('click', () => { F.mag = (F.mag + 1) % 3; panelSync(); });
  document.querySelectorAll('.oeclamp').forEach((l) => {
    l.addEventListener('click', () => { F.mag = +l.dataset.mag; panelSync(); });
  });
  // ---- COLLIMATION: an iris and a rotatable pair of shutters, both in the beam ----
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // Tap for a nudge, hold to run — the orientation pad's behaviour, because collimating is
  // the same kind of job: you sweep a leaf in until it touches the anatomy and stop there.
  const wireHold = (id, tap, rep) => {
    const btn = $(id); if (!btn) return;
    const fire = (f) => { f(); shutTouched = performance.now(); panelSync(); redrawLast(); };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      fire(tap);
      try { btn.setPointerCapture(e.pointerId); } catch (_) { /* a nicety, not the control */ }
      let iv = null;
      const to = setTimeout(() => { iv = setInterval(() => fire(rep), 55); }, 340);
      const stop = () => { clearTimeout(to); if (iv) clearInterval(iv); };
      btn.addEventListener('pointerup', stop, { once: true });
      btn.addEventListener('pointercancel', stop, { once: true });
    });
  };
  const iris = (d) => () => { F.iris = clamp(F.iris + d, 0.3, 1); };
  const shut = (d) => () => { F.shut = clamp(F.shut + d, 0.10, 1); };
  const srot = (d) => () => { F.shutRot = (F.shutRot + d + 180) % 180; };
  // the repeat step is larger than it looks it should be because each one repaints the
  // frame to move the wires, which throttles the interval to ~10 Hz — measured, not guessed
  wireHold('flIrisOpen', iris(0.03), iris(0.035));
  wireHold('flIrisClose', iris(-0.03), iris(-0.035));
  wireHold('flShutOpen', shut(0.03), shut(0.035));
  wireHold('flShutClose', shut(-0.03), shut(-0.035));
  wireHold('flShutCW', srot(2), srot(3));
  wireHold('flShutCCW', srot(-2), srot(-3));
  // ---- CONTRAST: display windowing. The echo underneath never moves. ----
  const win = (fn) => () => { fn(); panelSync(); redrawLast(); };
  $('flBrightUp')?.addEventListener('click', win(() => { F.bright = clamp(F.bright + 0.06, -0.6, 0.6); }));
  $('flBrightDn')?.addEventListener('click', win(() => { F.bright = clamp(F.bright - 0.06, -0.6, 0.6); }));
  $('flContUp')?.addEventListener('click', win(() => { F.cont = clamp(F.cont * 1.12, 0.4, 3.0); }));
  $('flContDn')?.addEventListener('click', win(() => { F.cont = clamp(F.cont / 1.12, 0.4, 3.0); }));
  $('flWinAuto')?.addEventListener('click', win(() => { F.bright = 0; F.cont = 1; }));
  // ---- GENERATOR ----
  const stepKv = (d) => { if (F.abc) return; F.kv = clamp(F.kv + d, 50, 120); const e = $('flKv'); if (e) e.value = F.kv; panelSync(); };
  const stepMa = (d) => { if (F.abc) return; F.ma = clamp(+(F.ma + d).toFixed(1), 0.5, 10); const e = $('flMa'); if (e) e.value = F.ma; panelSync(); };
  $('flKvUp')?.addEventListener('click', () => stepKv(2));
  $('flKvDn')?.addEventListener('click', () => stepKv(-2));
  $('flMaUp')?.addEventListener('click', () => stepMa(0.5));
  $('flMaDn')?.addEventListener('click', () => stepMa(-0.5));
  $('flAutoBtn')?.addEventListener('click', () => {
    F.abc = !F.abc;
    if (!F.abc) { F.kv = +$('flKv').value; F.ma = +$('flMa').value; }
    panelSync();
    setStatus(F.abc ? 'ABC armed — the machine sets kV and mA.' : 'Manual technique.');
  });
  // PULSE cycles the four authentic rates, and keeps the rate segment in step
  $('flPulseBtn')?.addEventListener('click', () => {
    const rates = [3, 7.5, 15, 30];
    F.pps = rates[(rates.indexOf(F.pps) + 1) % rates.length];
    document.querySelectorAll('#flPpsSeg button').forEach((x) => x.classList.toggle('on', +x.dataset.pps === F.pps));
    if (F.pedal) { clearInterval(timer); timer = setInterval(firePulse, 1000 / F.pps); }
    panelSync();
    setStatus(`${F.pps} pulses per second.`);
  });
  // LOW DOSE halves the dose rate. It is not free, and the noise says so.
  $('flLowDose')?.addEventListener('click', () => {
    F.lowDose = !F.lowDose;
    // with the loop off there is no target to move, so the button takes the mA itself —
    // the same bargain, made by hand
    if (!F.abc) {
      F.ma = clamp(+(F.lowDose ? F.ma / 2 : F.ma * 2).toFixed(1), 0.5, 10);
      const e = $('flMa'); if (e) e.value = F.ma;
    }
    panelSync();
    setStatus(F.lowDose ? 'Low dose — half the rate, and it will look like it.' : 'Normal dose rate.');
  });
  // FILM: the digital spot image. One frame at ~10x the per-pulse dose, straight to the
  // directory — the acquisition that is actually worth keeping, and worth its dose.
  $('flFilm')?.addEventListener('click', () => filmShot());
  // ---- ALARM: five minutes of beam-on, as the regulation requires ----
  $('flAlarmReset')?.addEventListener('click', () => {
    F.alarm = false; F.alarmS = F.beamS + 300;
    panelSync();
    setStatus('Alarm reset — five more minutes.');
  });
  // ---- WORKSTATION row ----
  $('flSave')?.addEventListener('click', () => saveToDirectory());
  $('flWorkstation')?.addEventListener('click', () => { F.ws = !F.ws; panelSync(); syncScreens(); });
  $('flModeBtn')?.addEventListener('click', () => {
    F.ws2 = F.ws2 === 'ref' ? 'live' : 'ref';
    setStatus(F.ws2 === 'ref' ? 'Reference screen holds the saved image.' : 'Reference screen follows the live image.');
    syncScreens();
  });
  $('flImgDir')?.addEventListener('click', () => openDirectory(!F.dirOpen));
  $('flDirClose')?.addEventListener('click', () => openDirectory(false));
  panelSync();
  // ---- the orientation pad: tap = 2° nudge, hold = continuous large adjustment (the
  // CT table-button behaviour). Rotation is PENDING until the next run; flips are live.
  const rotStep = (d) => {
    F.pendRot = (F.pendRot + d) % 360;
    pendShown = true;
    blitFilm();                            // triangle over the last image (if there is one)
  };
  const wireRot = (id, sign) => {
    const btn = $(id); if (!btn) return;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      rotStep(sign * 2);
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
      let iv = null;
      const to = setTimeout(() => { iv = setInterval(() => rotStep(sign * 3), 55); }, 340);
      const stop = () => { clearTimeout(to); if (iv) clearInterval(iv); };
      btn.addEventListener('pointerup', stop, { once: true });
      btn.addEventListener('pointercancel', stop, { once: true });
    });
  };
  wireRot('flRotCW', 1); wireRot('flRotCCW', -1);
  $('flFlipH')?.addEventListener('click', () => {
    F.flipH = !F.flipH; $('flFlipH').classList.toggle('on', F.flipH); blitFilm();
  });
  $('flFlipV')?.addEventListener('click', () => {
    F.flipV = !F.flipV; $('flFlipV').classList.toggle('on', F.flipV); blitFilm();
  });
  // ---- DSA / roadmap ----
  // One lit button tells the truth about the display chain: Off, DSA or Roadmap.
  const syncDsaSeg = () => {
    $('flDsaOff')?.classList.toggle('on', !dsaOn && !roadOn);
    $('flDsa')?.classList.toggle('on', dsaOn);
    $('flRoad')?.classList.toggle('on', roadOn);
  };
  const dsaAllOff = () => {
    dsaOn = false; roadOn = false; dsaMask = null; dsaAcc = null;
    syncDsaSeg();
    if (lastRaw) drawFrame(lastRaw, lastN);  // back to plain fluoro on the held image
  };
  $('flDsaOff')?.addEventListener('click', dsaAllOff);
  $('flDsa')?.addEventListener('click', () => {
    if (dsaOn) { dsaAllOff(); return; }
    dsaOn = true;
    dsaN = nPx();                            // freeze the sampling tier for the whole run
    dsaMask = null; dsaAcc = null; roadOn = false;
    syncDsaSeg();
    setStatus('DSA armed — the start of the next run takes the mask.');
  });
  $('flRemask')?.addEventListener('click', () => {
    if (!dsaOn) return;
    remaskNext = true;
    setStatus('Remask — the next frame becomes the new mask.');
  });
  $('flRoad')?.addEventListener('click', () => {
    if (!roadmap) return;
    if (roadOn) { dsaAllOff(); return; }
    roadOn = true; dsaOn = false; dsaMask = null; dsaAcc = null;
    syncDsaSeg();
    if (lastRaw) drawFrame(lastRaw, lastN);
  });
  // pixel shift: nudge the mask under the live frame (the real button for a patient who
  // moved a little). Hold repeats, like every other positioning control here.
  document.querySelectorAll('#flPxPad button').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const [dx, dy] = b.dataset.px.split(',').map(Number);
      const step = () => {
        if (!dsaOn || !dsaMask) return;
        dsaSX += dx; dsaSY += dy;
        if (lastRaw) drawFrame(lastRaw, lastN);
      };
      step();
      let iv = null;
      const to = setTimeout(() => { iv = setInterval(step, 90); }, 340);
      const stop = () => { clearTimeout(to); if (iv) clearInterval(iv); };
      b.addEventListener('pointerup', stop, { once: true });
      b.addEventListener('pointercancel', stop, { once: true });
    });
  });
  $('flHold')?.addEventListener('click', () => {
    F.hold = !F.hold;
    $('flHold').classList.toggle('on', F.hold);
  });
  $('flStill')?.addEventListener('click', () => {
    F.still = !F.still;
    $('flStill').classList.toggle('on', F.still);
  });
  $('flRec')?.addEventListener('click', () => {
    recArm = !recArm;
    $('flRec').classList.toggle('on', recArm);
  });
  $('flCineClose')?.addEventListener('click', cineStop);
  $('flSwallow')?.addEventListener('click', () => {
    F.swallowAt = performance.now() / 1000;      // the wall wave
    ctx.bariumSwallow?.();                       // and, when a study is on, the bolus in it
  });
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
