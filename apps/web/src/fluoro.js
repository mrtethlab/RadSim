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
import { ownsSpace } from './core/keys.js';
import { irisShutterArea } from './core/fieldArea.js';
import { NR_K, recursiveStep, displayMap, edgeEnhance } from './core/fluoroDisplay.js';
import { rightOnScreen } from './core/orientation.js';
import { staffPulse, staffEffective, skinEntranceMGy } from './core/staffDose.js';

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
function beamDirC() {
  const th = F.orbital * Math.PI / 180, ti = F.tilt * Math.PI / 180;
  return [Math.sin(th) * Math.cos(ti), Math.cos(th) * Math.cos(ti), Math.sin(ti)];
}
/* TUBE OVER THE TABLE: the C turned half a turn about the horizontal axis through its holder
   (the flip-flop axis, across the table). The image still works — upside down and mirrored,
   which the orientation pad and the side marker show — but the backscatter that went at the
   floor now comes up at the operator's eyes and thyroid (core/staffDose.js). */
function beamDir0() {
  const d = beamDirC();
  return F.over ? [d[0], -d[1], -d[2]] : d;
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
  /* SUPERIOR GOES AT THE TOP. The worker fills row j = 0 at v = -half, so the top of the
     image is the -detV direction; with v = cross(u, dir) that came out as world -z, and
     world +z is the patient's head in every non-CT mode (voxelFlips leaves z alone). The
     result was a chest rendered feet-up. Taking the cross the other way flips only the
     detector's vertical sense — the same rays, re-ordered — so left and right are
     untouched and the display controls stay at neutral, which is what "reset orientation"
     should hand you. */
  const v = norm(cross(dir, u));
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
          drawFrame(m.img, Math.sqrt(m.img.length) | 0, !!m.film);
          if (m.film) saveToDirectory('film');
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
function photonsPerPulse(film = false) {
  // Reference 1300 photons/pixel at 70 kV / 2 mA: set so that RAIL technique (110 kV,
  // 10 mA) detects ~60/pixel through an adult abdomen (T ~ 0.4 %) — the thickest thing
  // the ABC must be able to serve. 400, the first guess, left the loop railed with the
  // detector still starving through any torso.
  return 1300 * QPIX * (F.ma / 2) * Math.pow(F.kv / 70, 2) * (film ? FILM_BOOST : 1);
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
/* QUANTA PER PIXEL, scaled for the pixel. 45 detected photons was chosen to make mottle visible,
   but a pixel here is ~1.2 mm across at the 9" field — a real flat panel at a typical ~30 nGy per
   frame collects on the order of 10^4 photons over that area. At 45 the noise buried a pedicle
   even through a slim patient. QPIX scales the budget AND the target together, so the ABC picks
   exactly the technique it did and the dose readouts do not move — only the quantum mottle falls,
   by sqrt(QPIX). It is still visibly fluoroscopic, and LOW DOSE still halves it. */
const QPIX = 8;
const ABC_TARGET = 45 * QPIX;               // detected photons/pixel the loop defends
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
function akPerPulseMGy(film = false) {
  const mag = Math.pow(OEC.FIELD / fieldCm(), 2);
  return (12 / (60 * 15)) * (F.ma / 2) * Math.pow(F.kv / 70, 2.5) * mag
    * (dsaOn ? DSA_BOOST : 1) * (film ? FILM_BOOST : 1);
}
function dosePulse(film = false) {
  const ak = akPerPulseMGy(film);
  F.akMGy += ak;
  // field area at the patient entrance (~0.6 of the detector plane), in m^2: the iris circle
  // as the shutters cut it (core/fieldArea.js) — the shutters cut DAP as they cut the image
  const k = 0.6 / 100;
  const dap = ak * 1000 * irisShutterArea(irisCm() * k, shutCm() * k);
  F.dapUGym2 += dap;
  // the patient's skin at the real entrance, and the scatter that reaches the operator from it
  const e = entranceNow();
  F.skinMGy += skinEntranceMGy(ak, OEC.SRC_ISO - IRP_CM, e.fsd, e.dir[1] > 0.3);
  const acc = staffPulse({ dapUGym2: dap, entry: e.point, beamDir: e.dir, op: operatorAt(),
    floorY: FLOOR_Y, tableTopY: TABLE_TOP_Y, prot: F.prot });
  for (const kk of Object.keys(F.staff)) F.staff[kk] += acc[kk] || 0;
}
/* The interventional reference point sits 15 cm from the isocentre toward the tube (IEC
   60601-2-43): the console's air kerma is quoted there, whoever is on the table. */
const IRP_CM = 15;
const SSD_MIN_CM = 30;                         // minimum source-skin distance, mobile C-arm
const FLOOR_Y = -90, TABLE_TOP_Y = 0;          // the stretcher top is the x-ray receptor plane
/* Where the central ray enters the patient, traced on the same phantom the worker images.
   Re-traced only when the geometry changes: at 30 pps the beam is usually standing still. */
let entryKey = '', entryVal = null;
function entranceNow() {
  const g = beamFrame(), S = ctx.S, dir = beamDir();
  const key = [g.src.map((v) => v.toFixed(1)), dir.map((v) => v.toFixed(3)), S.objOff.x, S.objOff.y, S.objOff.z,
    S.objRot.x, S.objRot.y, S.objRot.z, S.subject].join('|');
  if (key !== entryKey) {
    entryKey = key;
    const fsd = ctx.skinEntry ? ctx.skinEntry(g.src, dir, OEC.SID) : null;
    entryVal = { fsd, dir, point: fsd ? [g.src[0] + dir[0] * fsd, g.src[1] + dir[1] * fsd, g.src[2] + dir[2] * fsd] : null };
  }
  return entryVal;
}
/* Where the operator stands: beside the beam, on the side of the table chosen, at the chosen
   distance from the beam's axis. "Patient's right" follows the patient's actual right. */
function operatorAt() {
  const iso = isoPoint(), R = ctx.phantomPose().rot;
  const rightSign = Math.sign(R[0]) || 1;
  return { x: iso[0] + F.opSide * rightSign * F.opDist, z: iso[2] };
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

/* film: this ONE pulse is an acquisition at FILM_BOOST. It is a property of the pulse, not of
   the machine: as a machine-wide flag it was cleared only when the film frame came back, so a
   FILM press that found every worker busy (or whose workers were replaced mid-flight) left it
   set, and every pulse after it was dosed — and filed — at twelve times. Returns whether the
   pulse went out. (Takes an options object: setInterval may pass a lateness number.) */
function firePulse(opts) {
  const film = !!(opts && opts.film);
  if (readyCount !== workers.length || !workers.length) { ensureWorker(); return false; }
  const slot = busy.indexOf(false);
  if (slot < 0) { F.dropped++; tierTick(true); renderReadouts(); return false; }
  tierTick(false);
  busy[slot] = true;
  F.pulses++;
  dosePulse(film);
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
    photons: photonsPerPulse(film) * (dsaOn ? DSA_BOOST : 1),
    src: g.src, detC: g.detC, detU: g.detU, detV: g.detV, half: fieldCm() / 2, iris: irisCm(), shut: shutCm(), shutRot: F.shutRot * Math.PI / 180,
    n: dsaOn ? dsaN : nPx(), rot: pose.rot, center: pose.center, anim: animTick(),
    ba: bp ? bp.ba : null, gas: bp ? bp.gas : null, giNS: bp ? bp.ns : 0,
    iod: cp ? cp.iod : null, svNS: cp ? cp.ns : 0,
    film,
    seed: F.fixedSeed || (Math.random() * 1e9) | 0 });
  return true;
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

/* Image processing (core/fluoroDisplay.js): a recursive temporal filter, a flat-panel display map
   and a mild edge enhancement. FILM frames are single high-dose acquisitions and skip the
   temporal filter; a new run starts it afresh. */
let recAcc = null, recFresh = true;
const dispScratch = {};
let edgeTmp = null;
function recursiveFilter(img, n, film) {
  const k = film || recFresh ? 0 : (NR_K[F.nr ?? 2] || 0);
  recAcc = recursiveStep(recAcc, img, k);
  recFresh = false;
  return recAcc;
}
const EDGE_AMOUNT = 0.45;
function drawFrame(img, n, isFilm = false) {
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
    img = recursiveFilter(img, n, isFilm);
    displayMap(img, n, lum, { scratch: dispScratch });
    const road = roadOn && roadmap ? roadmap : null;
    const rs = road ? roadN / n : 0;
    for (let k = 0; k < n * n; k++) {
      const t = img[k];
      let g = -1;
      if (t >= 0) {
        g = lum[k];
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
    if (!edgeTmp || edgeTmp.length !== n * n) edgeTmp = new Float32Array(n * n);
    edgeEnhance(lum, n, F.edge === false ? 0 : EDGE_AMOUNT, edgeTmp);
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
  drawSideMarker(g2, cx, cy, s);
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


/* THE ELECTRONIC SIDE MARKER. A fluoro image is oriented on the display, so its R is worked out
   from the geometry (core/orientation.js) and follows every flip and turn of the pad: an image
   flipped left-for-right that kept its R on the old side would be the wrong-side error in
   electronic form. Drawn upright, outside the orientation transform, at the edge the patient's
   right lies toward. A lateral has no right side on the screen, so it says LAT instead. */
function drawSideMarker(g2, cx, cy, s) {
  const R = ctx.phantomPose().rot;
  const { detU, detV } = beamFrame();
  const d = rightOnScreen([R[0], R[3], R[6]], detU, detV, F.flipH, F.flipV, F.dispRot);
  const fs = Math.max(12, Math.round(s * 0.06));
  g2.save();
  g2.font = `bold ${fs}px Arial`; g2.textAlign = 'center'; g2.textBaseline = 'middle';
  g2.fillStyle = 'rgba(255,207,74,0.95)';
  if (!d) { g2.fillText('LAT', cx + s / 2 - fs * 1.2, cy - s / 2 + fs); g2.restore(); return; }
  // on the edge it points to, set back into the corner the round field leaves dark
  const r = s / 2 - fs * 0.8;
  const horiz = Math.abs(d[0]) >= Math.abs(d[1]);
  const x = horiz ? cx + Math.sign(d[0]) * r : cx + d[0] * r + (Math.abs(d[0]) < 0.3 ? s * 0.36 : 0);
  const y = horiz ? cy + d[1] * r - (Math.abs(d[1]) < 0.3 ? s * 0.36 : 0) : cy + Math.sign(d[1]) * r;
  g2.fillText('R', x, y);
  g2.restore();
}
/* QC: where the R is drawn, as a screen direction (null on a lateral) */
function fluoroRightOnScreen() {
  if (!ctx) return null;
  const R = ctx.phantomPose().rot, { detU, detV } = beamFrame();
  return rightOnScreen([R[0], R[3], R[6]], detU, detV, F.flipH, F.flipV, F.dispRot);
}
if (typeof window !== 'undefined') window.radsimFluoroSide = fluoroRightOnScreen;

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
let refImg = null, refImgEl = null;

function filmShot() {
  if (ctx.S.mode !== 'fluoro') return;
  if (readyCount !== workers.length || !workers.length) { ensureWorker(); setStatus('Warming up the workers…'); return; }
  // one pulse, boosted, outside the pedal's clock — or none, said plainly, if the pool is busy
  if (!firePulse({ film: true })) setStatus('Every worker is busy with a pulse — FILM not taken; press it again.');
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
  syncMonitor(haveLive);
}

/* ---- the floating monitors -------------------------------------------------
   Live and reference side by side over the room. They used to live only in the scrolling
   console column, so reaching for a positioning control scrolled the images away mid-run. The
   live screen is also where the hands are: drag it and the TABLETOP floats under the beam (the
   anatomy follows the cursor, as on a real floating-top table), the wheel swings the C-arm. */
function fitCanvas(cv) {
  const r = cv.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
}
function syncMonitor(haveLive) {
  const mon = $('flMon');
  if (!mon || mon.classList.contains('off') || ctx.S.mode !== 'fluoro') return;
  const live = $('flMonLive'), ref = $('flMonRef');
  if (live) {
    fitCanvas(live);
    if (haveLive) renderTo(live); else live.getContext('2d').clearRect(0, 0, live.width, live.height);
  }
  if (ref) { fitCanvas(ref); $('flMonRefEmpty')?.classList.toggle('hide', drawRefInto(ref)); }
  mon.classList.toggle('beam', !!F.pedal);
  mon.classList.toggle('locked', !!F.lock);
  const r = mon.getBoundingClientRect();
  mon.classList.toggle('tall', r.height > r.width * 1.1);
}
/* Screen motion on the live monitor -> patient motion in the room. Undo the display's own
   rotation and flips, scale display pixels to detector centimetres (the frame is drawn s px
   across for the field), shrink by the magnification at the isocentre, and lay the result along
   the detector's own axes — so the drag is right at any C-arm angle or display orientation. */
function screenToPatient(dxPx, dyPx, cv) {
  const th = -F.dispRot * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
  let x = dxPx * c - dyPx * s, y = dxPx * s + dyPx * c;
  if (F.flipH) x = -x;
  if (F.flipV) y = -y;
  const d = Math.min(2, window.devicePixelRatio || 1);
  const sPx = (Math.min(cv.width, cv.height) - 10) / d;          // the frame's size on screen
  const cmPerPx = fieldCm() / sPx / (OEC.SID / OEC.SRC_ISO);
  const { detU, detV } = beamFrame();
  // image columns run along +u, rows along +v (row 0 is -v, at the top)
  return [(x * detU[0] + y * detV[0]) * cmPerPx, (x * detU[2] + y * detV[2]) * cmPerPx,
    (x * detU[1] + y * detV[1]) * cmPerPx];
}
/* Apply a patient displacement: across and along the table by floating the top; up and down
   (which a lateral view needs, and a tabletop cannot do) by the column lift — raising the C is
   lowering the patient in its field. */
function floatPatient(dx, dz, dy) {
  ctx.movePatient?.(dx, dz);
  if (Math.abs(dy) > 1e-6) {
    F.lift = Math.max(0, Math.min(30, F.lift - dy));
    const el = $('flLift'); if (el) el.value = Math.round(F.lift);
    fluoroSyncScene(); renderReadouts();
  }
}
function nudgeCarm(key, d, id, lo, hi) {
  F[key] = Math.max(lo, Math.min(hi, (F[key] || 0) + d));
  const el = $(id); if (el) el.value = F[key];
  fluoroSyncScene(); renderReadouts();
}
const MON_KEY = 'radsim.flmon';
function wireMonitor() {
  const mon = $('flMon'), bar = $('flMonBar'), live = $('flMonLive');
  if (!mon) return;
  try {
    const st = JSON.parse(localStorage.getItem(MON_KEY) || 'null');
    if (st) {
      if (st.off) mon.classList.add('off');
      if (st.w) { mon.style.width = st.w; mon.style.height = st.h; }
      if (st.l) { mon.style.left = st.l; mon.style.top = st.t; mon.style.right = 'auto'; mon.style.bottom = 'auto'; }
    }
  } catch (_) { /* per-viewer convenience only */ }
  const save = () => {
    try {
      localStorage.setItem(MON_KEY, JSON.stringify({ off: mon.classList.contains('off'),
        w: mon.style.width, h: mon.style.height, l: mon.style.left || null, t: mon.style.top || null }));
    } catch (_) { /* fine without it */ }
  };
  const show = (on) => { mon.classList.toggle('off', !on); $('flMonShow')?.classList.toggle('on', on); save(); syncScreens(); };
  $('flMonHide')?.addEventListener('click', () => show(false));
  $('flMonShow')?.addEventListener('click', () => show(mon.classList.contains('off')));
  $('flMonShow')?.classList.toggle('on', !mon.classList.contains('off'));
  // move by the title bar, kept inside the bay
  bar?.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const bay = mon.parentElement.getBoundingClientRect(), r = mon.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    try { bar.setPointerCapture(e.pointerId); } catch (_) { /* capture is a nicety */ }
    const mv = (ev) => {
      const l = Math.max(0, Math.min(bay.width - r.width, ev.clientX - bay.left - ox));
      const t = Math.max(0, Math.min(bay.height - 24, ev.clientY - bay.top - oy));
      Object.assign(mon.style, { left: l + 'px', top: t + 'px', right: 'auto', bottom: 'auto' });
    };
    const up = () => { bar.removeEventListener('pointermove', mv); save(); };
    bar.addEventListener('pointermove', mv);
    bar.addEventListener('pointerup', up, { once: true });
    bar.addEventListener('pointercancel', up, { once: true });
  });
  if (window.ResizeObserver) new ResizeObserver(() => { syncScreens(); save(); }).observe(mon);
  if (!live) return;
  // drag the live image: float the tabletop
  live.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { live.setPointerCapture(e.pointerId); } catch (_) { /* capture is a nicety */ }
    live.classList.add('dragging');
    let lx = e.clientX, ly = e.clientY;
    const mv = (ev) => {
      const [dx, dz, dy] = screenToPatient(ev.clientX - lx, ev.clientY - ly, live);
      lx = ev.clientX; ly = ev.clientY;
      floatPatient(dx, dz, dy);
    };
    const up = () => { live.removeEventListener('pointermove', mv); live.classList.remove('dragging'); };
    live.addEventListener('pointermove', mv);
    live.addEventListener('pointerup', up, { once: true });
    live.addEventListener('pointercancel', up, { once: true });
  });
  // the wheel swings the C: orbital, or tilt with shift
  live.addEventListener('wheel', (e) => {
    e.preventDefault();
    const d = (e.deltaY > 0 ? 1 : -1) * 2;
    if (e.shiftKey) nudgeCarm('tilt', d, 'flTilt', -45, 45);
    else nudgeCarm('orbital', d, 'flOrb', -115, 115);
  }, { passive: false });
}
/* Arrow keys while in fluoro: the table (as the drag), or with Shift the C-arm. One step is
   1 cm of table or 2 degrees of C. They work with the pedal down, which is the point. */
function arrowKeys(e) {
  if (ctx.S.mode !== 'fluoro' || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
  const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.code];
  if (!dir) return;
  e.preventDefault();
  if (e.shiftKey) {
    if (dir[0]) nudgeCarm('orbital', 2 * dir[0], 'flOrb', -115, 115);
    else nudgeCarm('tilt', -2 * dir[1], 'flTilt', -45, 45);
    return;
  }
  const mon = $('flMon');
  const live = mon && !mon.classList.contains('off') ? $('flMonLive') : $('film');
  if (!live) return;
  const d = Math.min(2, window.devicePixelRatio || 1);
  const sPx = (Math.min(live.width, live.height) - 10) / d;
  const px = sPx / fieldCm() * (OEC.SID / OEC.SRC_ISO);          // display px per cm of table
  const [dx, dz, dy] = screenToPatient(dir[0] * px, dir[1] * px, live);
  floatPatient(dx, dz, dy);
}

/* LIVE LOCK. A real fluoroscope's pedal is a dead-man switch and nothing holds it down — that
   is the point of it. In a simulator, though, leaving the beam on while both hands drive the
   table and the C is too useful (and too much fun) not to have. Pedal-up, Space-up and losing
   focus are all ignored while it is on; only the button (or leaving the room) ends it. */
function setLiveLock(on) {
  F.lock = !!on;
  const b = $('flLiveLock');
  if (b) { b.classList.toggle('on', F.lock); b.setAttribute('aria-pressed', String(F.lock)); }
  if (F.lock) { pedalDown(); setStatus('LIVE LOCK — screening until you press it again. (No real machine does this.)'); }
  else { pedalUp(true); setStatus('Live lock off.'); }
  syncScreens();
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
  recFresh = true;                             // a new run starts its average afresh
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

function pedalUp(force) {
  if (!F.pedal) return;
  if (F.lock && force !== true) return;          // LIVE LOCK holds the beam (setLiveLock)
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
  set('flLiftV', (Math.round(F.lift * 10) / 10) + ' cm');
  set('flExtV', (F.ext > 0 ? '+' : '') + F.ext + ' cm');
  set('flWigV', F.wig + '°');
  set('flAkV', (F.akMGy < 10 ? F.akMGy.toFixed(2) : F.akMGy.toFixed(1)) + ' mGy');
  set('flAkRateV', (akPerPulseMGy() * F.pps * 60).toFixed(1) + ' mGy/min');
  set('flDapV', F.dapUGym2.toFixed(1) + ' uGy·m²');
  const uSv = (v) => (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0)) + ' µSv';
  set('flStEyesV', uSv(F.staff.eyes));
  set('flStThyV', uSv(F.staff.thyroid));
  set('flStTrunkV', uSv(F.staff.trunk));
  set('flStLegsV', uSv(F.staff.legs));
  set('flStEV', uSv(staffEffective(F.staff, F.prot.apron)));
  set('flSkinV', (F.skinMGy < 10 ? F.skinMGy.toFixed(2) : F.skinMGy.toFixed(1)) + ' mGy');
  set('flOpDistV', F.opDist + ' cm');
  // source-to-skin: below 30 cm a mobile C-arm's spacer cone would be against the patient
  if (ctx.S.mode === 'fluoro') {
    const e = entranceNow(), ssd = $('flSsdV');
    if (ssd) {
      ssd.textContent = e.fsd ? Math.round(e.fsd) + ' cm' + (e.fsd < SSD_MIN_CM ? ' ⚠' : '') : '—';
      ssd.classList.toggle('warn', !!e.fsd && e.fsd < SSD_MIN_CM);
    }
  }
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
  // the scanned machine itself is fetched on first entry to the room: see loadOecRig()
  // the stretcher the subject lies on (the x-ray placement already lies flat at y≈0)
  stretcher = new THREE.Mesh(new THREE.BoxGeometry(55, 2.4, 210),
    new THREE.MeshStandardMaterial({ color: 0x3c4650, roughness: 0.85 }));
  stretcher.position.set(0, -1.6, 0);
  stretcher.visible = false;
  rig.parent.add(stretcher);
  // the operator: a plain figure where the staff dose is worked out, so "step back" and
  // "the other side of the table" can be seen as well as read. Grey-blue body = apron on.
  operator = new THREE.Group();
  const opMat = new THREE.MeshStandardMaterial({ color: 0x4f7fa0, roughness: 0.8, transparent: true, opacity: 0.55 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(15, 13, 140, 20), opMat);
  body.position.y = FLOOR_Y + 70; body.name = 'body';
  const head = new THREE.Mesh(new THREE.SphereGeometry(11, 18, 14), opMat.clone());
  head.position.y = FLOOR_Y + 160;
  operator.add(body, head);
  operator.visible = false;
  rig.parent.add(operator);
}
let operator = null;
function syncOperator(on) {
  if (!operator) return;
  operator.visible = on;
  if (!on) return;
  const p = operatorAt();
  operator.position.set(p.x, 0, p.z);
  const body = operator.getObjectByName('body');
  if (body) body.material.color.setHex(F.prot.apron ? 0x4f7fa0 : 0x7fa86a);
}

/* 0.54 MB of photogrammetry that only the fluoroscopy room ever shows. It used to be
   fetched while the page booted, for every visitor, whether or not they opened this mode.
   Now it is fetched the first time the room is entered; until it lands the beam line and
   the stretcher stand in, exactly as they already did when the fetch failed. */
let oecRequested = false;
function loadOecRig() {
  if (oecRequested) return;
  oecRequested = true;
  const { THREE, three } = ctx;
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
}

export function fluoroSyncScene() {
  if (!ctx || !rig) return;
  const { THREE, S, three } = ctx;
  const on = S.mode === 'fluoro';
  rig.visible = on; stretcher.visible = on;
  syncOperator(on);
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
      new THREE.Vector3(...beamDirC()));
    // over the table: the half turn about the flip-flop axis comes between the yaw and the C
    const qf = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), F.over ? Math.PI : 0);
    const q = qw.clone().multiply(qf).multiply(q0);
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
    loadOecRig();
    ensureWorker();
    renderReadouts();
    setStatus(readyCount === workers.length && workers.length
      ? 'Ready — hold the pedal (or Space) to screen.'
      : 'Loading the subject into the pulse workers…');
  } else {
    if (F.lock) setLiveLock(false);
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
    ped.addEventListener('pointerup', () => pedalUp());
    ped.addEventListener('pointercancel', () => pedalUp());
  }
  $('flLiveLock')?.addEventListener('click', () => setLiveLock(!F.lock));
  document.querySelectorAll('#flNrSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      F.nr = +b.dataset.nr;
      document.querySelectorAll('#flNrSeg button').forEach((x) => x.classList.toggle('on', x === b));
      recFresh = true;
    });
  });
  $('flEdge')?.addEventListener('change', (e) => { F.edge = e.target.checked; });
  addEventListener('keydown', arrowKeys);
  wireMonitor();
  addEventListener('keydown', (e) => {
    if (e.code === 'Space' && ctx.S.mode === 'fluoro' && !e.repeat && !ownsSpace(document.activeElement)) {
      e.preventDefault(); pedalDown();
    }
  });
  addEventListener('keyup', (e) => { if (e.code === 'Space') pedalUp(); });
  addEventListener('resize', () => syncScreens());
  // a Space released after focus left the window never reaches keyup, and the beam stayed on:
  // losing the window takes the foot off the pedal, as a dead-man switch should
  addEventListener('blur', () => { if (F.pedal) pedalUp(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && F.pedal) pedalUp(); });
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
    // acknowledging silences the flashing timer too (it kept flashing until a full dose reset);
    // the next alarm is still due at the next five-minute mark, which is alarmAt's job
    F.alarm = false;
    $('flBeamV')?.classList.remove('alarm');
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
    F.skinMGy = 0; for (const k of Object.keys(F.staff)) F.staff[k] = 0;
    F.alarm = false;                              // a new patient: nothing left to acknowledge
    $('flBeamV')?.classList.remove('alarm');
    panelSync();
    renderReadouts();
  });
  // ---- staff & skin (core/staffDose.js) ----
  document.querySelectorAll('#flTubeSeg button').forEach((b) => b.addEventListener('click', () => {
    F.over = b.dataset.over === '1';
    document.querySelectorAll('#flTubeSeg button').forEach((x) => x.classList.toggle('on', x === b));
    entryKey = '';
    fluoroSyncScene(); renderReadouts();
    setStatus(F.over
      ? 'Tube over the table: the backscatter now comes up at your eyes and thyroid. Watch them.'
      : 'Tube under the table: the backscatter goes at the floor, where a table skirt can stop it.');
  }));
  document.querySelectorAll('#flOpSideSeg button').forEach((b) => b.addEventListener('click', () => {
    F.opSide = +b.dataset.side;
    document.querySelectorAll('#flOpSideSeg button').forEach((x) => x.classList.toggle('on', x === b));
    fluoroSyncScene();
  }));
  $('flOpDist')?.addEventListener('input', (e) => { F.opDist = +e.target.value; fluoroSyncScene(); renderReadouts(); });
  for (const [id, k] of [['flPApron', 'apron'], ['flPCollar', 'collar'], ['flPGlasses', 'glasses'],
    ['flPCeiling', 'ceiling'], ['flPSkirt', 'skirt']]) {
    $(id)?.addEventListener('change', (e) => { F.prot[k] = e.target.checked; fluoroSyncScene(); renderReadouts(); });
  }
  // ABC starts ON: the sliders are the override, not the default
  const kvEl = $('flKv'), maEl = $('flMa');
  if (kvEl) kvEl.disabled = true;
  if (maEl) maEl.disabled = true;
  abcApply();
  // A subject change invalidates the workers' copy of the volume. Rebuild once the new
  // volume has actually LOADED (the change event fires before the fetch finishes) so the
  // motion scan runs and the status tells the truth without waiting for a pedal press.
  // Rebuild the pool whenever a subject finishes loading. This used to listen for the
  // dropdown's change event and poll until the volume landed — which never fires for a subject
  // that arrives on its own, so entering fluoro straight from the menu (the hand now loads on
  // entry, not at boot) left the status on "Loading the subject into the pulse workers…" for
  // good. setSubject announces completion; that covers every way a subject can arrive.
  window.addEventListener('radsim:subject', () => {
    workerSub = null; F.motions = [];
    if (ctx.S.mode === 'fluoro') ensureWorker();
  });
  renderReadouts();
}
