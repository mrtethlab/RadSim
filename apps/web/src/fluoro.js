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
import { buildCarm, buildTower, setReceptor, CARM } from './carm.js';
import { carmBeam } from './core/carmPose.js';
import { ownsSpace } from './core/keys.js';
import { fieldArea } from './core/fieldArea.js';
import { NR_K, recursiveStep, displayMap, edgeEnhance, roadmapSubtract, wsSwap } from './core/fluoroDisplay.js';
import { rightOnScreen } from './core/orientation.js';
import { staffPulse, staffEffective, skinEntranceMGy } from './core/staffDose.js';
import { akPerPulse, maCeiling } from './core/fluoroRate.js';
import { findFibula, fractureFragment, fragmentMove, judgeReduction, mortiseAngle, WEBER_B, LIMITS } from './core/fracture.js';
import { vesselCentrelines, vesselJunctions, wireStart, wireMove, wirePolyline, wireTip, WIRE_R_CM } from './core/guidewire.js';
import { buildSVolume } from './core/contrast.js';
import { BodyMaterials } from './core/materials.js';

let ctx = null;          // { THREE, S, $, three, phantomPose, syncScene }
let F = null;            // ctx.S.fluoro
// A POOL of pulse workers, round-robin: one worker sustains ~18 pps at the Phase A
// budget (measured 54 ms/pulse at 192 px on the hand), so 30 pps needs two in flight.
// Frames can then land out of order — each carries its pulse id and stale ones are
// discarded, never drawn over a newer frame. Mobile keeps a pool of one: the second
// volume copy costs more memory than 7.5 pps is worth.
let workers = [], busy = [], readyCount = 0, workerSub = null;
let workerPose = '';     // the patient's pose the pool holds ('' = as scanned): syncPose
let workerOff = null;    // where the pool's (cropped) volume's centre lies from the full grid's, cm, volume frame
let giVolSent = false;   // whether this pool has the barium arclength map
let sVolSent = false;    // whether this pool has the vessel arclength map
let fragSent = false;    // whether this pool has the ankle case's fracture fragment
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
let roadBase = null;                   // the roadmap's own mask (log T before the iodine): the subtraction's zero
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
let rig = null, stretcher = null, carm = null, tower = null;
let pendShown = false;   // the orientation pad's triangle: pending rotation being dialled in
let shutTouched = 0;     // when collimation was last moved — the leaf wires linger after

// GE OEC geometry, datasheet-rounded (cm): fixed SID, source under the patient at 0°. The
// column's axis to the beam's (wig-wag's arc radius) is the C-arm model's (carm.js CARM.LARM).
const OEC = { SID: 99, SRC_ISO: 60, FIELD: 23 };
// the orbital travel: the C slides through its holder until the holder's shoe nears the C's end
// (carm.js: a 220-degree C in a 28-degree shoe keeps hold to 96); both laterals are inside it
const ORB_MAX = 95;
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
/* The beam from the C-arm's joints (core/carmPose.js): the C slides through its holder
   (orbital), the holder turns on the cross-arm (tilt; flip-flop, half a turn, puts the tube OVER
   THE TABLE: the image still works, upside down and mirrored, which the orientation pad and the
   side marker show, but the backscatter that went at the floor comes up at the operator's eyes
   and thyroid, core/staffDose.js), and wig-wag yaws the cross-arm about the column. Tilt sits
   outside orbital, as on the machine (the first version composed them the other way round; the
   two agree whenever either angle is zero). */
function beamDir() { return carmBeam(F); }
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
  const b = isoBase(), w = F.wig * Math.PI / 180, r = CARM.LARM + F.ext;
  return [b[0] - CARM.LARM + Math.cos(w) * r, b[1] + F.lift, b[2] - Math.sin(w) * r];
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
  fragSent = false;                          // nor a fracture
  workerPose = ''; workerOff = null;         // and holds the patient as scanned
  filmBusy = false;                          // a spot film in the old pool never comes back
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
        if (m.film) { filmBusy = false; syncLeds(); }   // the FILM lamp: lit while its frame is out
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

/* THE PATIENT'S POSE. The pool holds one volume; when the joints are bent (app.js posedVolume)
   and the posing worker has made that pose, every worker takes it in place of the one it holds
   (same centre: a pose pads its grid symmetrically) before its next pulse; messages run in
   order, so no pulse sees half of it. Until the pose is made the workers image the last one.
   The arclength maps of a barium or vessel study belong to the scanned grid: with the patient
   bent they are not sent (a contrast study on a bent limb has none to show). */
function syncPose() {
  const p = ctx.posedVolume?.() || { key: '' };
  if (p.key === workerPose || (p.key && !p.vol) || !workers.length) return;
  const vm = ctx.S.voxelModel;
  const v = p.vol ? cropPose(p.vol, vm) : { data: vm.data, dims: vm.dims, off: null };
  workerOff = v.off;
  const pose = poolPose();
  readyCount = 0;
  // one copy per worker (no shared memory on GitHub Pages); the last is handed over, not copied
  workers.forEach((w, i) => {
    const last = i === workers.length - 1 && v.data !== vm.data;
    w.postMessage({ type: 'init', dims: v.dims, vs: vm.vs, vsMM: vm.spacingMM,
      data: v.data, center: pose.center, flip: pose.flip, rot: pose.rot }, last ? [v.data.buffer] : []);
  });
  giVolSent = sVolSent = !!p.key;
  fragSent = false;                          // a fracture is cut from the scanned grid: re-sent unbent
  workerPose = p.key;
  entryKey = '';                             // the skin the beam enters has moved too
}
/* A pose's volume cut to the patient's box (jointPose posePlan box): its grid is padded
   symmetrically about the centre, and most of a bent leg's grid is air (a knee at 60 degrees, 181 MB
   of grid round 91 MB of box); the workers take a third of the copying. The box's centre lies off
   the grid's by `off` (cm, the volume's own frame, flips applied: the phantom's local frame). */
function cropPose(P, vm) {
  if (!P.box) return { data: P.data, dims: P.dims, off: null };
  const [N0, N1] = P.dims, [[i0, i1], [j0, j1], [k0, k1]] = P.box;
  const n0 = i1 - i0 + 1, n1 = j1 - j0 + 1, n2 = k1 - k0 + 1;
  const out = new Uint8Array(n0 * n1 * n2);
  for (let k = 0; k < n2; k++) for (let j = 0; j < n1; j++) {
    const s = ((k + k0) * N1 + j + j0) * N0 + i0;
    out.set(P.data.subarray(s, s + n0), (k * n1 + j) * n0);
  }
  const f = ctx.phantomPose().flip, sp = vm.vs;
  const off = [0, 1, 2].map((a) => {
    const d = ([i0, j0, k0][a] + [i1, j1, k1][a]) / 2 - (P.dims[a] - 1) / 2;
    return (f[a] ? -d : d) * sp[a];
  });
  return { data: out, dims: [n0, n1, n2], off };
}
/* The pool's phantom pose: the patient's, its centre moved by the crop's offset, turned with the
   patient (the phantom's local frame maps to the room as p = centre + rot local). */
function poolPose() {
  const pose = ctx.phantomPose();
  if (!workerOff) return pose;
  const R = pose.rot, o = workerOff, c = pose.center;
  const r = R ? [R[0] * o[0] + R[1] * o[1] + R[2] * o[2], R[3] * o[0] + R[4] * o[1] + R[5] * o[2], R[6] * o[0] + R[7] * o[1] + R[8] * o[2]] : o;
  return { ...pose, center: [c[0] + r[0], c[1] + r[1], c[2] + r[2]] };
}

// dev server only: which pose the pulse workers hold, and whether they are ready (timing checks)
if (import.meta.env?.DEV) window.__flWorkers = () => ({ pose: workerPose, ready: !!workers.length && readyCount === workers.length });

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
  F.ma = limitMa(Math.round((0.5 + 9.5 * q * q) * 10) / 10);
}
/* THE DOSE-RATE CEILING (core/fluoroRate.js). The generator clips the mA wherever this kV,
   pulse rate and field would pass 88 mGy/min at the reference point; the ABC then climbs on in
   kV alone, and a big patient gets a darker, noisier image instead of an illegal rate. Fewer
   pulses per second buy more mA per pulse under the same ceiling. Recorded modes (spot film,
   DSA) are exempt and never pass through here. */
const magFactor = () => Math.pow(OEC.FIELD / fieldCm(), 2);
function limitMa(want) {
  const ceil = Math.floor(maCeiling(F.kv, F.pps, magFactor()) * 10) / 10;
  F.rateLimited = want > ceil;
  return Math.max(0.1, Math.min(want, ceil));
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
/* The FLAT PANEL keeps the intensifier's field sizes — its side is the II's diameter, and the
   mag modes zoom it by the same steps — so the ABC, the rate ceiling and the dose-rate scaling
   are the machine's either way. What changes is the SHAPE: the whole square is detector, the
   iris closes as a square, and the DAP takes the square's area (fieldArea). Its fields are
   named in centimetres, as panels are, not in inches. */
const magLabel = () => (F.fpd ? `${fieldCm()} cm` : ['9"', '6"', '4.5"'][F.mag]);
// DSA acquisition runs at far higher detector dose per frame than screening fluoro —
// that is what makes subtraction quiet enough to read (sd(lnT) drops from ~0.21 between
// two fluoro frames to ~0.05), and it is why a DSA run costs what it costs on the meter.
const DSA_BOOST = 60;
// LOW DOSE is a real button with a real bargain: half the detector dose per pulse, so
// half the kerma AND half the quanta. The noise it buys is not a side effect to hide.
function doseFactor() { return F.lowDose ? 0.5 : 1; }
function akPerPulseMGy(film = false) {
  return akPerPulse(F.kv, F.ma, magFactor()) * (dsaOn ? DSA_BOOST : 1) * (film ? FILM_BOOST : 1);
}
function dosePulse(film = false) {
  const ak = akPerPulseMGy(film);
  F.akMGy += ak;
  // field area at the patient entrance (~0.6 of the detector plane), in m^2: the iris (a circle,
  // or the flat panel's square) as the shutters cut it (core/fieldArea.js) — the shutters cut DAP
  // as they cut the image, and the panel's square field is 4/pi the intensifier's circle
  const k = 0.6 / 100;
  const dap = ak * 1000 * fieldArea(!!F.fpd, irisCm() * k, shutCm() * k, F.shutRot * Math.PI / 180);
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
    S.objRot.x, S.objRot.y, S.objRot.z, S.subject, workerPose].join('|');
  if (key !== entryKey) {
    entryKey = key;
    const fsd = ctx.skinEntry ? ctx.skinEntry(g.src, dir, OEC.SID) : null;
    entryVal = { fsd, dir, point: fsd ? [g.src[0] + dir[0] * fsd, g.src[1] + dir[1] * fsd, g.src[2] + dir[2] * fsd] : null };
  }
  return entryVal;
}
/* Where the operator stands: beside the beam, on the side of the table chosen, at the chosen
   distance from the beam's axis. "Patient's right" follows the patient's actual right. */
/* At the C-ARM'S CONTROLS (opSide 0, the default): the technologist driving the C stands beside the
   cart at its control head (on the column, carm.js), on the side toward the patient's feet and the
   monitor cart: OP_AT_CONTROLS = [behind the column's axis, out from it across the cart], cm. The
   column stays where the cart was parked (lift raises it; extend and wig-wag move only the cross-arm
   above it), so this is about 1.6 m from the beam. Or beside the table (+-1: the patient's right
   or left) at the chosen distance from the beam: where a second person, or the one injecting,
   stands. */
const OP_AT_CONTROLS = [20, 54];
function operatorAt() {
  const iso = isoPoint();
  if (!F.opSide) {
    const b = isoBase();
    return { x: b[0] - CARM.LARM - OP_AT_CONTROLS[0], z: b[2] - OP_AT_CONTROLS[1] };
  }
  const R = ctx.phantomPose().rot;
  const rightSign = Math.sign(R[0]) || 1;
  return { x: iso[0] + F.opSide * rightSign * F.opDist, z: iso[2] };
}
// the operator's distance from the beam's axis at the table, cm (the readout)
function operatorDist() {
  const p = operatorAt(), iso = isoPoint();
  return Math.round(Math.hypot(p.x - iso[0], p.z - iso[2]));
}

/* The 5-minute alarm every real machine mandates: three beeps and a flashing timer at
   each multiple, acknowledged by the dose-reset button (between-patient reset). */
let alarmAt = 300;
// the alarm as the console shows it: both beam-on clocks flash, ALARM RESET blinks with its lamp lit
function alarmShow() {
  for (const id of ['flBeamV', 'flLcdClock']) $(id)?.classList.toggle('alarm', !!F.alarm);
  $('flAlarmReset')?.classList.toggle('armed', !!F.alarm);
  syncLeds();
}
function doseAlarm(beamS) {
  if (beamS < alarmAt) return;
  alarmAt += 300;
  F.alarm = true;
  alarmShow();
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
  syncPose();                                // a newly made pose goes to the pool first
  if (readyCount !== workers.length || !workers.length) { ensureWorker(); return false; }
  const slot = busy.indexOf(false);
  if (slot < 0) { F.dropped++; tierTick(true); renderReadouts(); return false; }
  tierTick(false);
  busy[slot] = true;
  F.pulses++;
  // screening is held under the rate ceiling whatever set the mA (the ABC, the slider, a
  // change of pulse rate or field since); a spot film or DSA run is an acquisition, exempt
  // (under the ABC the flag is the curve's — it asked for more than it got — so a re-check of
  // the already-clipped mA must not clear it)
  // By hand, the clip works from what the operator ASKED for (F.maWant), so the flag holds
  // and a lower pulse rate gives the mA back.
  if (!film && !dsaOn) {
    const keep = F.abc && F.rateLimited;
    const ma = limitMa(F.abc ? F.ma : (F.maWant ?? F.ma));
    if (keep) F.rateLimited = true;
    if (ma !== F.ma) { F.ma = ma; const el = $('flMa'); if (el) el.value = ma; }
  }
  dosePulse(film);
  const g = beamFrame(), pose = poolPose();
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
  // the ankle case's fracture: the fragment once per pool, where the learner has it every pulse
  // (on the scanned grid only: a bent ankle's volume is another grid)
  const fx = !!ankle && !workerPose;
  if (fx && !fragSent) {
    const f = ankle.frag;
    workers.forEach((w) => w.postMessage({ type: 'frag', frag: { idx: f.idx, mat: f.mat, box: f.box } }));
    fragSent = true;
  }
  workers[slot].postMessage({ type: 'pulse', id: ++pulseId, kv: F.kv,
    photons: photonsPerPulse(film) * (dsaOn ? DSA_BOOST : 1),
    src: g.src, detC: g.detC, detU: g.detU, detV: g.detV, half: fieldCm() / 2, iris: irisCm(), shut: shutCm(), shutRot: F.shutRot * Math.PI / 180,
    fpd: !!F.fpd,
    n: dsaOn ? dsaN : nPx(), rot: pose.rot, center: pose.center, anim: animTick(),
    ba: bp ? bp.ba : null, gas: bp ? bp.gas : null, giNS: bp ? bp.ns : 0,
    iod: cp ? cp.iod : null, svNS: cp ? cp.ns : 0,
    fragMove: fx ? { ...fragmentMove(ankle.frag, ankle.pose), v: ankle.v } : null,
    wire: wireMsg(), wireR: WIRE_R_CM,
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
let roadScratch = null;
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
    // CONTRAST AUTO fits the window to every frame; off, the window it last fitted is HELD
    displayMap(img, n, lum, { scratch: dispScratch, win: F.winAuto ? null : (F.win || dispScratch.win || null) });
    if (!F.winAuto && !F.win) F.win = dispScratch.win;
    // the roadmap: live fluoro subtracted against the DSA run's map (core/fluoroDisplay.js) —
    // the vessels white, the wire black. The first version laid the map over the live image as
    // a darkening, which drew the vessels black: exactly the colour of the wire inside them.
    if (roadOn && roadmap && roadBase) {
      if (!roadScratch || roadScratch.length !== n * n) roadScratch = new Float32Array(n * n);
      roadmapSubtract(img, n, lum, roadmap, roadBase, roadN, { scratch: roadScratch });
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
  const br = $('fnBR'); if (br) br.textContent = `${F.kv} kV · ${F.ma.toFixed(1)} mA · ${magLabel()}`;
  $('noexp')?.style.setProperty('display', 'none');
  // the bay's Image view mirrors the fluoro monitor live (instead of the last x-ray)
  if (ctx.S.bayContent === 'image' && ctx.S.mode === 'fluoro') fluoroImageToBay();
}
/* Render the current frame (with orientation) into any canvas — the monitor and the
   bay's big Image view share this one pipeline. */
/* How big the frame is drawn on a screen w x h: the intensifier's circle sits in a black margin,
   the flat panel's square runs edge to edge — the whole screen's height (or width), no margin. */
const frameSide = (w, h) => Math.min(w, h) - (F.fpd ? 0 : 10);
function renderTo(cv) {
  const g2 = cv.getContext('2d');
  g2.fillStyle = '#000'; g2.fillRect(0, 0, cv.width, cv.height);
  const s = frameSide(cv.width, cv.height);
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
let refImg = null;
let filmBusy = false;                  // a spot film is out (the FILM lamp)

function filmShot() {
  if (ctx.S.mode !== 'fluoro') return;
  if (readyCount !== workers.length || !workers.length) { ensureWorker(); setStatus('Warming up the workers…'); return; }
  // one pulse, boosted, outside the pedal's clock — or none, said plainly, if the pool is busy
  if (!firePulse({ film: true })) setStatus('Every worker is busy with a pulse — FILM not taken; press it again.');
  else { filmBusy = true; syncLeds(); }
}
function saveToDirectory(kind) {
  if (!frameCanvas || !frameCanvas.width) { setStatus('Nothing on the monitor to save.'); return; }
  const k = kind || 'save';
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  renderTo(c);
  F.saved.unshift({ url: c.toDataURL('image/jpeg', 0.72), kind: k,
    meta: `${F.kv.toFixed(0)}kV ${F.ma.toFixed(1)}mA ${magLabel()}`,
    t: Math.round(F.beamS) });
  if (F.saved.length > DIR_MAX) F.saved.length = DIR_MAX;
  if (!refImg) refImg = F.saved[0].url;   // the first save fills the empty reference screen
  renderDirectory();
  syncScreens();
  flashLed('flSave');
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
      refImg = it.url;
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
   One live, one to study. WORKSTATION is the OEC's image swap (core/fluoroDisplay.js wsSwap):
   the image on the live monitor goes to the reference monitor and the reference comes over to
   the live one, held there until the pedal goes down — live screening always takes the live
   monitor back. Press it again and they change back. */
let swap = { held: undefined, ref: null, from: null };   // held: what the live monitor shows instead
const imgCache = new Map();                              // decoded stills, by url
function stillImg(url) {
  let im = imgCache.get(url);
  if (!im) {
    im = new Image();
    im.onload = () => syncScreens();             // repaint once it has decoded
    im.src = url;
    imgCache.set(url, im);
    if (imgCache.size > DIR_MAX + 4) imgCache.delete(imgCache.keys().next().value);
  }
  return im;
}
// a still (the reference, by default) into a screen; whether there was one to draw
function drawRefInto(cv, url = refImg) {
  const g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
  if (!url) return false;
  const im = stillImg(url);
  if (im.complete && im.naturalWidth) {
    const s = Math.min(cv.width, cv.height);
    g.drawImage(im, (cv.width - s) / 2, (cv.height - s) / 2, s, s);
  }
  return true;
}
const swapped = () => swap.held !== undefined;
// the live monitor: the live image, or the still WORKSTATION brought over (black if there was none)
function drawLiveInto(cv, haveLive) {
  if (swapped()) { drawRefInto(cv, swap.held); return true; }
  if (haveLive) renderTo(cv);
  return haveLive;
}
function workstation() {
  const haveLive = !!(frameCanvas && frameCanvas.width);
  if (!swapped() && !haveLive) { setStatus('Nothing on the live monitor to swap.'); return; }
  swap = wsSwap({ ...swap, ref: refImg }, () => {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    renderTo(c);
    return c.toDataURL('image/jpeg', 0.85);
  });
  refImg = swap.ref;
  renderDirectory(); syncScreens(); syncLeds();
  setStatus(swapped() ? 'Swapped: the live image is on the reference monitor.' : 'Swapped back.');
}
function syncScreens() {
  const film = $('film'), c2 = $('film2');
  if (!film) return;
  const haveLive = !!(frameCanvas && frameCanvas.width);
  drawLiveInto(film, haveLive);
  if (c2) $('flScr2Empty')?.classList.toggle('hide', drawRefInto(c2));
  film.parentElement?.classList.toggle('refonmain', swapped());
  syncMonitor(haveLive);
  syncTower(haveLive);
}
/* The monitor cart's two screens in the room: the live monitor and the reference, as the console's
   two screens show them. A status bar under each, as on the cart: what the screen holds, the
   technique, the beam. */
function syncTower(haveLive) {
  if (!tower || !ctx || ctx.S.mode !== 'fluoro') return;
  const paint = (scr, draw, live, label) => {
    const cv = scr.canvas, g = cv.getContext('2d'), W = cv.width, H = cv.height, bar = 34;
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const tmp = paint.tmp || (paint.tmp = document.createElement('canvas'));
    tmp.width = W; tmp.height = H - bar;
    if (draw(tmp)) g.drawImage(tmp, 0, 0);
    g.fillStyle = '#0d1a26'; g.fillRect(0, H - bar, W, bar);
    g.font = 'bold 20px monospace'; g.textBaseline = 'middle';
    g.fillStyle = live && F.pedal ? '#ffcf3a' : '#7fd1ff';
    g.fillText(label, 12, H - bar / 2);
    g.fillStyle = '#cfe3f3'; g.textAlign = 'right';
    g.fillText(`${Math.round(F.kv)} kV  ${(+F.ma).toFixed(1)} mA`, W - 12, H - bar / 2);
    g.textAlign = 'left';
    if (live && F.pedal) { g.fillStyle = '#ffcf3a'; g.beginPath(); g.arc(W - 22, 22, 9, 0, 2 * Math.PI); g.fill(); }
    scr.texture.needsUpdate = true;
  };
  paint(tower.live, (cv) => drawLiveInto(cv, haveLive), true, swapped() ? 'LIVE · SWAP' : 'LIVE');
  paint(tower.ref, (cv) => drawRefInto(cv), false, 'REFERENCE');
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
    if (!drawLiveInto(live, haveLive)) live.getContext('2d').clearRect(0, 0, live.width, live.height);
  }
  const lab = $('flMonLiveLab'); if (lab) lab.textContent = swapped() ? 'LIVE · SWAP' : 'LIVE';
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
  const sPx = frameSide(cv.width, cv.height) / d;                // the frame's size on screen
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
/* MONITORS ON, ONE COPY. With the floating monitors up, the viewer docked over the pedal was a
   second live screen and a second reference showing the same two images, so it stands down
   (styles.css, body.flmon-on) and what lived over its screen comes with the images: the LIH and
   REC badges and loop playback onto the live monitor, the image directory over both. Monitors
   off, they go back, and the docked viewer is the screen again. A phone keeps its own layout
   (its Image page is the viewer). */
const OVER_LIVE = ['lihBadge', 'recBadge', 'flCineView', 'flCineClose'];
function placeOverlays(active = ctx.S.mode === 'fluoro') {
  const mon = $('flMon');
  const on = !!mon && !mon.classList.contains('off') && active && !document.body.classList.contains('mobile');
  document.body.classList.toggle('flmon-on', on);
  const home = $('film')?.parentElement, live = $('flMonLive')?.parentElement, both = mon?.querySelector('.flmon-body');
  if (!home || !live || !both) return;
  for (const id of OVER_LIVE) { const el = $(id), to = on ? live : home; if (el && el.parentElement !== to) to.appendChild(el); }
  const dir = $('flImgDirPane'), to = on ? both : home;
  if (dir && dir.parentElement !== to) to.appendChild(dir);
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
  const show = (on) => { mon.classList.toggle('off', !on); $('flMonShow')?.classList.toggle('on', on); save(); placeOverlays(); syncScreens(); };
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
    else nudgeCarm('orbital', d, 'flOrb', -ORB_MAX, ORB_MAX);
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
    if (dir[0]) nudgeCarm('orbital', 2 * dir[0], 'flOrb', -ORB_MAX, ORB_MAX);
    else nudgeCarm('tilt', -2 * dir[1], 'flTilt', -45, 45);
    return;
  }
  const mon = $('flMon');
  const live = mon && !mon.classList.contains('off') ? $('flMonLive') : $('film');
  if (!live) return;
  const d = Math.min(2, window.devicePixelRatio || 1);
  const sPx = frameSide(live.width, live.height) / d;
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
  // live screening takes the live monitor back from a WORKSTATION swap (the reference keeps its still)
  if (swapped()) { swap = { held: undefined, ref: refImg, from: null }; syncLeds(); }
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
      roadBase = dsaMask ? dsaMask.slice() : null;
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
  // the control panel's LCD: kVp, the mode over its fluoro clock, and mA
  set('flLcdKv', String(F.kv));
  set('flLcdMa', F.ma.toFixed(1));
  set('flLcdClock', $('flBeamV')?.textContent || '');
  set('flLcdMode', dsaOn ? 'DSA' : roadOn ? 'ROADMAP' : 'FLUORO');
  set('flPerfV', F.msAvg ? `${F.msAvg.toFixed(0)} ms · ${F.dropped} dropped` : '—');
  set('flOrbV', F.orbital + '°');
  set('flTiltV', F.tilt + '°');
  set('flLiftV', (Math.round(F.lift * 10) / 10) + ' cm');
  set('flExtV', (F.ext > 0 ? '+' : '') + F.ext + ' cm');
  set('flWigV', F.wig + '°');
  set('flAkV', (F.akMGy < 10 ? F.akMGy.toFixed(2) : F.akMGy.toFixed(1)) + ' mGy');
  set('flAkRateV', (akPerPulseMGy() * F.pps * 60).toFixed(1) + ' mGy/min' + (F.rateLimited ? ' · LIMIT' : ''));
  $('flAkRateV')?.classList.toggle('warn', !!F.rateLimited);
  set('flDapV', F.dapUGym2.toFixed(1) + ' uGy·m²');
  const uSv = (v) => (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0)) + ' µSv';
  set('flStEyesV', uSv(F.staff.eyes));
  set('flStThyV', uSv(F.staff.thyroid));
  set('flStTrunkV', uSv(F.staff.trunk));
  set('flStLegsV', uSv(F.staff.legs));
  set('flStEV', uSv(staffEffective(F.staff, F.prot.apron)));
  set('flSkinV', (F.skinMGy < 10 ? F.skinMGy.toFixed(2) : F.skinMGy.toFixed(1)) + ' mGy');
  set('flOpDistV', operatorDist() + ' cm');
  const od = $('flOpDist'); if (od) od.disabled = !F.opSide;     // (at the controls: where the column is)
  // source-to-skin: below 30 cm a mobile C-arm's spacer cone would be against the patient
  if (ctx.S.mode === 'fluoro') {
    const e = entranceNow(), ssd = $('flSsdV');
    if (ssd) {
      ssd.textContent = e.fsd ? Math.round(e.fsd) + ' cm' + (e.fsd < SSD_MIN_CM ? ' ⚠' : '') : '—';
      ssd.classList.toggle('warn', !!e.fsd && e.fsd < SSD_MIN_CM);
    }
  }
  set('flIrisV', Math.round(F.iris * 100) + ' %');
  set('flShutV2', Math.round(F.shut * 100) + ' %');
  set('flShutRotV', F.shutRot + '°');
  set('flMagV', magLabel());
  const kvS = $('flKv'), maS = $('flMa');
  if (F.abc) { if (kvS) kvS.value = F.kv; if (maS) maS.value = F.ma; }
  doseAlarm(beam);
}
function setStatus(msg) { const el = $('flStatus'); if (el) el.textContent = msg; }
/* The control panel's lamps: an LED beside every key that has a state (the mag selector's three
   are its own, on the NORM / MAG 1 / MAG 2 labels). */
function led(id, on) {
  const b = $(id); if (!b) return;
  b.classList.toggle('on', !!on);
  b.closest('.ledw')?.querySelector('.led')?.classList.toggle('lit', !!on);
}
function syncLeds() {
  if (!ctx) return;
  led('flFlipH', F.flipH); led('flFlipV', F.flipV);
  led('flWinAuto', F.winAuto); led('flAutoBtn', F.abc);
  led('flPulseBtn', F.pps < 30); led('flFilm', filmBusy); led('flLowDose', F.lowDose);
  led('flAlarmReset', F.alarm); led('flWorkstation', swapped()); led('flModeBtn', dsaOn || roadOn);
  document.querySelectorAll('.oeclamp').forEach((l) => l.classList.toggle('on', +l.dataset.mag === F.mag));
}
// a lamp that only acknowledges (SAVE): lit for a moment
function flashLed(id) {
  const l = $(id)?.closest('.ledw')?.querySelector('.led'); if (!l) return;
  l.classList.add('lit'); setTimeout(() => l.classList.remove('lit'), 500);
}

/* ---- the rig ------------------------------------------------------------- */
function buildStretcher(THREE) {
  const g = new THREE.Group();
  const top = new THREE.MeshStandardMaterial({ color: 0x23272c, roughness: 0.55, metalness: 0.2 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe9ecee, roughness: 0.45, emissive: 0x3a3e43 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.5, metalness: 0.2 });
  const box = (w, h, d, m, x, y, z) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); g.add(o); return o; };
  box(55, 2.4, 210, top, 0, -1.6, 0);                                   // the radiolucent top
  for (const s of [-1, 1]) box(2.2, 3.4, 210, white, s * 28.6, -1.9, 0); // its side rails
  box(55, 3.4, 4, white, 0, -1.9, 104);                                  // the head end
  // the pedestal at the foot: a column on a broad base, a frame under the top's last half metre
  box(48, 6, 60, white, 0, -6.4, -78);
  box(26, 70, 22, white, 0, FLOOR_Y + 41, -80);
  box(40, 3, 50, grey, 0, FLOOR_Y + 6, -80);
  box(60, 3, 64, white, 0, FLOOR_Y + 1.5, -80);
  return g;
}

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
  // The machine (carm.js): base, column, cross-arm, holder and C, each posed below
  carm = buildCarm(OEC.SID, OEC.SRC_ISO);
  for (const g of Object.values(carm)) { g.visible = false; rig.parent.add(g); }
  // the table the subject lies on: a carbon-fibre top on a white frame, cantilevered from a
  // pedestal at the foot so the C can reach under it (the x-ray placement lies flat at y≈0)
  stretcher = buildStretcher(THREE);
  stretcher.visible = false;
  rig.parent.add(stretcher);
  // the monitor cart past the foot of the table, turned up the table toward the room's usual
  // view (the camera orbits on the patient's right, toward the head), its two screens the
  // console's two (syncScreens)
  tower = buildTower();
  tower.group.name = 'fluoroTower'; carm.base.name = 'carmBase';
  tower.group.visible = false;
  tower.group.position.set(55, FLOOR_Y, -165);
  tower.group.rotation.y = -Math.PI / 2 + 0.4;
  rig.parent.add(tower.group);
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

export function fluoroSyncScene() {
  if (!ctx || !rig) return;
  const { THREE, S, three } = ctx;
  const on = S.mode === 'fluoro';
  rig.visible = on; stretcher.visible = on;
  syncOperator(on);
  for (const g of Object.values(carm)) g.visible = on;
  tower.group.visible = on;
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
    // The machine's chain, as built (carm.js): wig-wag yaws the cross-arm about the column; the
    // holder turns on the arm's end by flip-flop and tilt, both about the arm's own axis (x);
    // the C slides through the holder by the orbital angle, about the holder's z. Its product
    // takes up to the beam exactly as beamDir() does.
    const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
    const w = F.wig * Math.PI / 180;
    const qw = new THREE.Quaternion().setFromAxisAngle(Y, w);
    const qh = qw.clone()
      .multiply(new THREE.Quaternion().setFromAxisAngle(X, F.over ? Math.PI : 0))
      .multiply(new THREE.Quaternion().setFromAxisAngle(X, F.tilt * Math.PI / 180));
    const qc = qh.clone().multiply(new THREE.Quaternion().setFromAxisAngle(Z, -F.orbital * Math.PI / 180));
    rig.quaternion.copy(qc);
    carm.c.position.set(iso[0], iso[1], iso[2]); carm.c.quaternion.copy(qc);
    carm.holder.position.set(iso[0], iso[1], iso[2]); carm.holder.quaternion.copy(qh);
    // the cross-arm: its origin on the column's axis (slid out by extend), at the isocentre's
    // height (lift raises it); the column rises with it out of the cart's sleeve
    const colX = b[0] - CARM.LARM, colZ = b[2];
    carm.boom.position.set(colX + Math.cos(w) * F.ext, b[1] + F.lift, colZ - Math.sin(w) * F.ext);
    carm.boom.quaternion.copy(qw);
    carm.column.position.set(colX, b[1] + F.lift, colZ);
    carm.base.position.set(colX, FLOOR_Y, colZ);
  }
}

/* A point in cm on the scanned volume's own axes (index x spacing, core/fracture.js and
   core/guidewire.js work there) -> the room, placed as the pool's phantom is: flips, centre, turn. */
function volToWorld(p) {
  const vm = ctx.S.voxelModel, pose = ctx.phantomPose(), f = pose.flip, R = pose.rot, c = pose.center;
  const l = [0, 1, 2].map((a) => { const d = p[a] / vm.vs[a] - (vm.dims[a] - 1) / 2; return (f[a] ? -d : d) * vm.vs[a]; });
  const r = R ? [R[0] * l[0] + R[1] * l[1] + R[2] * l[2], R[3] * l[0] + R[4] * l[1] + R[5] * l[2], R[6] * l[0] + R[7] * l[1] + R[8] * l[2]] : l;
  return [c[0] + r[0], c[1] + r[1], c[2] + r[2]];
}
const beamNow = () => F.beamS + (F.pedal ? (performance.now() - pedalDownAt) / 1000 : 0);
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
// tap for one step, hold to run: the feel of every positioning control on this console
function holdRepeat(btn, fn, every = 90) {
  if (!btn) return;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fn();
    try { btn.setPointerCapture(e.pointerId); } catch (_) { /* a nicety, not the control */ }
    let iv = null;
    const to = setTimeout(() => { iv = setInterval(fn, every); }, 340);
    const stop = () => { clearTimeout(to); if (iv) clearInterval(iv); };
    btn.addEventListener('pointerup', stop, { once: true });
    btn.addEventListener('pointercancel', stop, { once: true });
  });
}

/* ---- ANKLE ORIF (core/fracture.js) --------------------------------------------------------
   The ortho C-arm's commonest job: a displaced Weber B fibula on the Foot, reduced under the
   beam. The fracture is cut from the volume itself and the distal fragment moved in the workers'
   own copies, so what the learner reduces is the IMAGE — the residual is never shown until they
   ask for the check, which is the point: the mortise and the lateral are how a surgeon knows.
   The check is scored the way a list would be: residual within 2 mm and 5 degrees, length
   first, and the screening it took — time, air kerma, DAP — since the case began. */
let ankle = null, ankleWant = false;
const FRAG_STEP = { lat: 0.05, ant: 0.05, prox: 0.05, rot: 1 };     // cm or degrees a tap: 0.5 mm, 1 degree
const FRAG_MAX = { lat: 1.2, ant: 1.2, prox: 1.2, rot: 25 };        // the forceps' reach from anatomic
function ankleStart() {
  const S = ctx.S, vm = S.voxelModel;
  if (S.subject !== 'foot' || !vm?.data) {
    ankleWant = true;                                  // started on arrival (radsim:subject)
    setStatus('Loading the Foot…');
    if (S.subject !== 'foot') ctx.setSubject?.('foot');
    return;
  }
  ankleWant = false;
  if (ctx.posedVolume?.().key) { setStatus('Straighten the ankle first (POSITION · joints): the fracture is cut from the leg as it was scanned.'); return; }
  // the leg says which side is lateral: the fibula is the slender bone (fracture.js findFibula)
  const fib = findFibula(vm.data, vm.dims, vm.vs, 0);
  const frag = fib && fractureFragment(vm.data, vm.dims, vm.vs, fib, fib.latSign);
  if (!frag) { setStatus('No fibula found in this volume.'); return; }
  const m = mortiseAngle(vm.data, vm.dims, vm.vs, fib, fib.latSign);
  const a = volToWorld(frag.pivot), b = volToWorld(frag.pivot.map((v, i) => v + frag.lat[i]));
  ankle = { frag, pose: { ...WEBER_B }, v: 1, latX: Math.sign(b[0] - a[0]) || 1,
    // the textbook 15-20 degrees, as this ankle's own malleoli measure it
    mortise: Math.round(Math.max(10, Math.min(25, m ?? 15))),
    t0: { beam: beamNow(), ak: F.akMGy, dap: F.dapUGym2, pulses: F.pulses }, checks: 0 };
  fragSent = false;
  ankleCentre();
  ankleView('ap');
  $('flAnkleCheck')?.removeAttribute('disabled');
  const r = $('flAnkleResult');
  // (the result line; what the case is and how to work it is the tutorial's to say)
  if (r) r.innerHTML = `Case on &middot; mortise ${ankle.mortise}&deg; toward lateral.`;
  setStatus('Ankle ORIF — screen to see the fracture.');
}
/* The ankle at the isocentre: the table floated under it, and the leg raised on a radiolucent
   bump (the height offset) so a horizontal beam meets it — the C cannot drop its isocentre below
   its own column, which is why every ankle list keeps a bump on the trolley. */
function ankleCentre() {
  const S = ctx.S;
  F.ext = 0; F.wig = 0;
  let w = volToWorld(ankle.frag.p0);
  const iso = isoPoint();
  ctx.movePatient?.(iso[0] - w[0], iso[2] - w[2]);
  const y0 = S.objOff.y || 0, want = y0 + (isoBase()[1] - w[1]), y = Math.max(0, Math.min(20, Math.round(want * 2) / 2));
  const el = $('objOffY');
  if (el) { el.value = y; el.dispatchEvent(new Event('input')); } else S.objOff.y = y;
  w = volToWorld(ankle.frag.p0);
  F.lift = Math.max(0, Math.min(30, Math.round(w[1] - isoBase()[1])));
  for (const [id, k] of [['flLift', 'lift'], ['flExt', 'ext'], ['flWig', 'wig']]) { const e = $(id); if (e) e.value = F[k]; }
  entryKey = '';
}
/* The three views, by the C alone (the leg stays on its bump, as it does under the drapes):
   AP square to the table; MORTISE turned toward the lateral side until the beam is square to the
   line through both malleoli; LATERAL horizontal, medial to lateral. */
function ankleView(kind) {
  if (!ankle) return;
  F.orbital = kind === 'mortise' ? ankle.latX * ankle.mortise : kind === 'lat' ? ankle.latX * 90 : 0;
  F.tilt = 0;
  for (const [id, k] of [['flOrb', 'orbital'], ['flTilt', 'tilt']]) { const e = $(id); if (e) e.value = F[k]; }
  document.querySelectorAll('#flAnkleViewSeg button').forEach((x) => x.classList.toggle('on', x.dataset.view === kind));
  entryKey = '';
  fluoroSyncScene(); renderReadouts();
}
function fragNudge(key, sg) {
  if (!ankle) { setStatus('Start the ankle case first.'); return; }
  const v = ankle.pose[key] + sg * FRAG_STEP[key];
  ankle.pose[key] = Math.max(-FRAG_MAX[key], Math.min(FRAG_MAX[key], Math.round(v * 1000) / 1000));
  ankle.v++;                         // the next pulse carries the new position (nothing until then)
}
function ankleCheck() {
  if (!ankle) return;
  const r = judgeReduction(ankle.pose), el = $('flAnkleResult');
  ankle.checks++;
  const t = beamNow() - ankle.t0.beam, ak = F.akMGy - ankle.t0.ak, dap = F.dapUGym2 - ankle.t0.dap;
  const pulses = F.pulses - ankle.t0.pulses;
  const ok = (b) => (b ? '<span style="color:var(--green)">&#10003;</span>' : '<span style="color:var(--amber)">&#10007;</span>');
  const len = r.lengthMM > 0 ? `${r.lengthMM} mm short` : r.lengthMM < 0 ? `${-r.lengthMM} mm long` : 'restored';
  const tr = [r.latMM ? `${Math.abs(r.latMM)} mm ${r.latMM > 0 ? 'lateral' : 'medial'}` : '',
    r.antMM ? `${Math.abs(r.antMM)} mm ${r.antMM > 0 ? 'anterior' : 'posterior'}` : ''].filter(Boolean).join(', ') || 'none';
  const rot = r.rotDeg ? `${Math.abs(r.rotDeg)}&deg; ${r.rotDeg > 0 ? 'external' : 'internal'}` : 'none';
  const tips = [];
  if (!r.lengthOK) tips.push('length: on the mortise the fibula\'s tip and the talus\'s lateral process make an unbroken curve (the "dime" sign) only when it is out to length');
  if (!r.rotOK) tips.push('rotation: a turned fibula changes its own profile and the lateral clear space on the mortise');
  if (!r.transOK) tips.push(Math.abs(r.antMM) > Math.abs(r.latMM) ? 'front-to-back shows only on the LATERAL' : 'side-to-side shows on the AP and mortise');
  if (el) el.innerHTML = `<b style="color:${r.ok ? 'var(--green)' : 'var(--amber)'}">${r.ok ? 'REDUCED' : 'NOT YET REDUCED'}</b>`
    + ` (check ${ankle.checks}; limits ${LIMITS.mm} mm, ${LIMITS.deg}&deg;)<br>`
    + `${ok(r.lengthOK)} Length: ${len}<br>${ok(r.transOK)} Translation: ${tr}<br>${ok(r.rotOK)} Rotation: ${rot}<br>`
    + `Screening for this case: ${t < 60 ? t.toFixed(1) + " s" : mmss(t)} &middot; ${pulses} pulses &middot; ${ak.toFixed(2)} mGy &middot; ${dap.toFixed(1)} uGy&middot;m&sup2;`
    + (tips.length ? '<br>' + tips.join('; ') + '.' : '');
  setStatus(r.ok ? 'Reduction accepted.' : 'Not yet — see the check.');
}
function ankleEnd() {
  if (!ankle) return;
  ankle = null;
  // off the bump: the next patient lies on the table
  const el = $('objOffY');
  if (el && +el.value) { el.value = 0; el.dispatchEvent(new Event('input')); }
  $('flAnkleCheck')?.setAttribute('disabled', '');
  document.querySelectorAll('#flAnkleViewSeg button').forEach((x) => x.classList.remove('on'));
}
// dev server only: the case's true fragment pose and its judgement (the in-app checks)
if (import.meta.env?.DEV) window.__flAnkle = () => ankle && { pose: { ...ankle.pose }, v: ankle.v, mortise: ankle.mortise, latX: ankle.latX,
  judge: judgeReduction(ankle.pose), n: ankle.frag.idx.length, set: (p) => { Object.assign(ankle.pose, p); ankle.v++; } };

/* ---- GUIDEWIRE (core/guidewire.js) -------------------------------------------------------
   A 0.035" wire through a femoral sheath, on the vessel tree the contrast solver runs on. The
   tree (centrelines and junctions) is read once per subject from the arclength map, which the
   CONTRAST panel shares (the ultrasound colour box does the same). The wire goes to the workers
   as a polyline each pulse and is imaged there as steel — so it shows on plain fluoro over the
   spine, cancels in a DSA mask it was already in, and reads black on a subtracted roadmap. */
let gw = null, gwGeom = null, gwAcc = 43, gwPts = null, gwBusy = false;
async function wireGeometry() {
  const S = ctx.S, vm = S.voxelModel;
  if (gwGeom && gwGeom.for === S.subject) return gwGeom;
  if (!vm?.data || !vm.loadArclen || !vm.hasVessels) return null;
  const C = S.contrast;
  let sVol = C && C.sVol && C.sVolFor === S.subject ? C.sVol : null;
  if (!sVol) {
    const arclen = await vm.loadArclen();
    if (!arclen) return null;
    sVol = buildSVolume(vm.data, arclen);
    if (C) { C.sVol = sVol; C.sVolFor = S.subject; }   // share it back
  }
  const lines = vesselCentrelines(vm.data, sVol, vm.dims, vm.vs);
  return (gwGeom = { for: S.subject, lines, juncs: vesselJunctions(vm.data, vm.dims, vm.vs, lines) });
}
// the patient's anterior (the ceiling, supine) on the volume's own axes: where torque 0 points the tip
function upOnVolume() {
  const pose = ctx.phantomPose(), R = pose.rot, f = pose.flip;
  const l = R ? [R[3], R[4], R[5]] : [0, 1, 0];
  return l.map((v, a) => (f[a] ? -v : v));
}
async function wireInsert() {
  if (gwBusy) return;
  if (gw) { gw = null; gwPts = null; syncWireUI(); setStatus('Wire out.'); return; }
  gwBusy = true;
  setStatus('Reading the vessel tree…');
  try {
    const g = await wireGeometry();
    if (!g || !Object.keys(g.lines).length) { setStatus('This subject has no vessel tree — the wire needs the chest or the chest/abdo/pelvis.'); return; }
    // a femoral puncture where the subject has the iliacs; the chest alone has only the descending aorta's cut end
    const acc = g.lines[gwAcc] ? gwAcc : g.lines[43] ? 43 : 29;
    gw = wireStart(g.lines, g.juncs, acc, upOnVolume());
    // the tip starts pointing at the table: no branch leaves the aorta that way on the climb
    // to the arch (none is modelled behind it), so a wire simply pushed goes to the aortic root,
    // as a J-wire does — every side branch is a choice the learner makes with the torque
    gw.torque = 180;
    wireMove(gw, 3);
    gwPts = null;
    setStatus('Wire in the sheath — advance it under screening.');
  } finally { gwBusy = false; syncWireUI(); }
}
function wireNudge(dl, dTorque) {
  if (!gw) { setStatus('Insert the wire first.'); return; }
  const was = gw.blocked;
  if (dl) wireMove(gw, dl);
  if (dTorque) { gw.torque = (gw.torque + dTorque + 360) % 360; wireMove(gw, 0); }
  if (gw.blocked && !was) setStatus('The wire goes no further — the end of the vessel, or a turn its tip is not facing. Withdraw a little, torque, advance.');
  gwPts = null;
  syncWireUI();
}
function syncWireUI() {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  $('flWireIn')?.classList.toggle('on', !!gw);
  if ($('flWireIn')) $('flWireIn').textContent = gw ? 'Remove' : 'Insert';
  if (!gw) { set('flWireLenV', '—'); set('flWireTipV', '—'); return; }
  const t = wireTip(gw);
  set('flWireLenV', Math.round(t.len) + ' cm');
  set('flWireTipV', (BodyMaterials.LIST[t.v]?.name || '—') + (gw.blocked ? ' · goes no further' : ''));
}
// the wire for this pulse, as voxel indices of the scanned grid (none on a bent patient's grid)
function wireMsg() {
  if (!gw || workerPose) return null;
  if (!gwPts) {
    const vs = ctx.S.voxelModel.vs, P = wirePolyline(gw);
    gwPts = new Float32Array(P.length * 3);
    P.forEach((p, i) => { gwPts[3 * i] = p[0] / vs[0]; gwPts[3 * i + 1] = p[1] / vs[1]; gwPts[3 * i + 2] = p[2] / vs[2]; });
  }
  return gwPts;
}
// dev server only: the wire's state (the in-app checks)
if (import.meta.env?.DEV) window.__flWire = () => gw && { len: gw.len, torque: gw.torque, blocked: gw.blocked,
  path: gw.route.reduce((a, r) => (a[a.length - 1] === r.v ? a : [...a, r.v]), []), pts: wireMsg()?.length / 3,
  tip: volToWorld(gw.lines[gw.route[gw.route.length - 1].v].pts[gw.route[gw.route.length - 1].i]), iso: isoPoint(),
  move: (dl, dt) => wireNudge(dl, dt) };

/* ---- mode + wiring ------------------------------------------------------- */
export function fluoroApplyMode(on) {
  if (!ctx) return;
  // Desktop layout: the monitor moves one pane left and the pedal follows it — see
  // core/paneDock.js, which ultrasound shares.
  dockConsole(on, $('flPedalRow'));
  placeOverlays(on);
  if (on) {
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
  // the panel's own state: the receptor (the 9" intensifier unless the flat panel is ticked), and
  // CONTRAST — AUTO windowing, which of brightness / contrast the arrows set, the held window
  F.fpd = !!F.fpd; F.winAuto = F.winAuto ?? true; F.winSel = F.winSel || 'bright'; F.win = null;
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
      syncLeds();                // (PULSE's lamp: lit below the continuous 30)
    });
  });
  const slide = (id, key) => {
    $(id)?.addEventListener('input', (e) => {
      F[key] = parseFloat(e.target.value);
      if (key === 'ma') F.maWant = F.ma;          // the operator's request, clipped per pulse
      renderReadouts();
      if (['orbital', 'tilt', 'lift', 'ext', 'wig'].includes(key)) fluoroSyncScene();
    });
  };
  slide('flKv', 'kv'); slide('flMa', 'ma'); slide('flOrb', 'orbital'); slide('flTilt', 'tilt');
  slide('flLift', 'lift'); slide('flExt', 'ext'); slide('flWig', 'wig');
  // ================= THE CONTROL PANEL =================
  // The OEC 9800's own membrane panel, key for key. The rule it is arranged around: ORIENTATION
  // and CONTRAST are electronic — the display turns and brightens and the beam does nothing —
  // while the mag selector, COLLIMATION and the GENERATOR are in the beam, and change the dose.
  const panelSync = () => {
    syncLeds();
    const kvEl = $('flKv'), maEl = $('flMa');
    if (kvEl) kvEl.disabled = F.abc;
    if (maEl) maEl.disabled = F.abc;
    renderReadouts();
  };
  // ---- the receptor: the 9" intensifier, or a flat panel in its place ----
  $('flFpd')?.addEventListener('change', (e) => {
    F.fpd = e.target.checked;
    setReceptor(carm, F.fpd);
    recFresh = true;                              // a new detector starts its average afresh
    panelSync();
    setStatus(F.fpd ? 'Flat panel: a square field, edge to edge on the monitor.' : 'Image intensifier: the round 9" field.');
  });
  // the grey scale, inverted (with the display processing, beside noise reduction): redrawLast,
  // not blitFilm — the invert lives in the grey mapping, so the frame is re-mapped from the
  // stored luminance, not merely blitted again
  $('flInvert')?.addEventListener('change', (e) => { F.invert = e.target.checked; redrawLast(); });
  // ---- the mag selector: NORM / MAG 1 / MAG 2, the lamps say which; the key steps it ----
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
  // ---- CONTRAST: display windowing; the patient is not exposed again. One pill: the middle
  // key (the half-lit sun) chooses what the arrows set, brightness or contrast. AUTO fits the
  // window to every frame (its lamp lit); touching the arrows takes the display off AUTO and
  // HOLDS the window where it was (core/fluoroDisplay.js displayMap win), so a pan onto thicker
  // anatomy then goes darker until AUTO is pressed again. ----
  const win = (fn) => () => { fn(); panelSync(); redrawLast(); };
  const winStep = (sg) => win(() => {
    if (F.winAuto) { F.winAuto = false; F.win = dispScratch.win || null; }   // hold the last fitted window
    if (F.winSel === 'cont') F.cont = clamp(sg > 0 ? F.cont * 1.12 : F.cont / 1.12, 0.4, 3.0);
    else F.bright = clamp(F.bright + sg * 0.06, -0.6, 0.6);
  });
  $('flWinUp')?.addEventListener('click', winStep(1));
  $('flWinDn')?.addEventListener('click', winStep(-1));
  $('flWinSel')?.addEventListener('click', () => {
    F.winSel = F.winSel === 'cont' ? 'bright' : 'cont';
    $('flWinSel')?.querySelector('use')?.setAttribute('href', F.winSel === 'cont' ? '#oiCont' : '#oiSun');
    setStatus(F.winSel === 'cont' ? 'The arrows set CONTRAST.' : 'The arrows set BRIGHTNESS.');
  });
  $('flWinAuto')?.addEventListener('click', win(() => { F.winAuto = true; F.win = null; F.bright = 0; F.cont = 1; }));
  // ---- GENERATOR ----
  const stepKv = (d) => { if (F.abc) return; F.kv = clamp(F.kv + d, 50, 120); const e = $('flKv'); if (e) e.value = F.kv; panelSync(); };
  const stepMa = (d) => { if (F.abc) return; F.ma = clamp(+(F.ma + d).toFixed(1), 0.5, 10); F.maWant = F.ma; const e = $('flMa'); if (e) e.value = F.ma; panelSync(); };
  $('flKvUp')?.addEventListener('click', () => stepKv(2));
  $('flKvDn')?.addEventListener('click', () => stepKv(-2));
  $('flMaUp')?.addEventListener('click', () => stepMa(0.5));
  $('flMaDn')?.addEventListener('click', () => stepMa(-0.5));
  $('flAutoBtn')?.addEventListener('click', () => {
    F.abc = !F.abc;
    if (!F.abc) { F.kv = +$('flKv').value; F.ma = F.maWant = +$('flMa').value; }
    panelSync();
    setStatus(F.abc ? 'ABC armed — the machine sets kV and mA.' : 'Manual technique.');
  });
  // PULSE steps the four authentic rates and keeps the rate segment in step; its lamp is lit
  // while the beam is PULSED — 30 pps is the machine's continuous rate
  $('flPulseBtn')?.addEventListener('click', () => {
    const rates = [3, 7.5, 15, 30];
    F.pps = rates[(rates.indexOf(F.pps) + 1) % rates.length];
    document.querySelectorAll('#flPpsSeg button').forEach((x) => x.classList.toggle('on', +x.dataset.pps === F.pps));
    if (F.pedal) { clearInterval(timer); timer = setInterval(firePulse, 1000 / F.pps); }
    panelSync();
    setStatus(F.pps < 30 ? `Pulsed: ${F.pps} pulses per second.` : 'Continuous: 30 frames per second.');
  });
  // LOW DOSE halves the dose rate. It is not free, and the noise says so.
  $('flLowDose')?.addEventListener('click', () => {
    F.lowDose = !F.lowDose;
    // with the loop off there is no target to move, so the button takes the mA itself —
    // the same bargain, made by hand
    if (!F.abc) {
      F.ma = clamp(+(F.lowDose ? F.ma / 2 : F.ma * 2).toFixed(1), 0.5, 10);
      F.maWant = F.ma;
      const e = $('flMa'); if (e) e.value = F.ma;
    }
    panelSync();
    setStatus(F.lowDose ? 'Low dose — half the rate, and it will look like it.' : 'Normal dose rate.');
  });
  // FILM: the digital spot image. One frame at ~12x the per-pulse dose, straight to the
  // directory — the acquisition that is actually worth keeping, and worth its dose.
  $('flFilm')?.addEventListener('click', () => filmShot());
  // ---- ALARM RESET: five minutes of beam-on, as the regulation requires ----
  $('flAlarmReset')?.addEventListener('click', () => {
    // acknowledging silences the flashing timer too (it kept flashing until a full dose reset);
    // the next alarm is still due at the next five-minute mark, which is alarmAt's job
    F.alarm = false;
    alarmShow();
    panelSync();
    setStatus('Alarm reset — five more minutes.');
  });
  // ---- SAVE / WORKSTATION / MODE ----
  $('flSave')?.addEventListener('click', () => saveToDirectory());
  $('flWorkstation')?.addEventListener('click', () => workstation());
  $('flImgDir')?.addEventListener('click', () => openDirectory(!F.dirOpen));
  $('flDirClose')?.addEventListener('click', () => openDirectory(false));
  // ---- ORIENTATION: tap = 2° nudge, hold = continuous large adjustment (the CT table-button
  // behaviour). Rotation is PENDING until the next run; the flips and the reset are live. ----
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
  // ROTATION RESET: the image upright again, and any rotation being dialled in dropped with it
  $('flRotReset')?.addEventListener('click', () => {
    F.dispRot = 0; F.pendRot = 0; pendShown = false;
    blitFilm();
    setStatus('Rotation reset.');
  });
  $('flFlipH')?.addEventListener('click', () => { F.flipH = !F.flipH; syncLeds(); blitFilm(); });
  $('flFlipV')?.addEventListener('click', () => { F.flipV = !F.flipV; syncLeds(); blitFilm(); });
  // ---- DSA / roadmap ----
  // One lit button tells the truth about the display chain: Off, DSA or Roadmap — and the
  // panel's MODE lamp and the LCD say the same.
  const syncDsaSeg = () => {
    $('flDsaOff')?.classList.toggle('on', !dsaOn && !roadOn);
    $('flDsa')?.classList.toggle('on', dsaOn);
    $('flRoad')?.classList.toggle('on', roadOn);
    syncLeds(); renderReadouts();
  };
  const dsaAllOff = () => {
    dsaOn = false; roadOn = false; dsaMask = null; dsaAcc = null;
    syncDsaSeg();
    if (lastRaw) drawFrame(lastRaw, lastN);  // back to plain fluoro on the held image
  };
  const dsaArm = () => {
    dsaOn = true;
    dsaN = nPx();                            // freeze the sampling tier for the whole run
    dsaMask = null; dsaAcc = null; roadOn = false;
    syncDsaSeg();
    setStatus('DSA armed — the start of the next run takes the mask.');
  };
  const roadOnNow = () => {
    roadOn = true; dsaOn = false; dsaMask = null; dsaAcc = null;
    syncDsaSeg();
    if (lastRaw) drawFrame(lastRaw, lastN);
    setStatus('Roadmap — live fluoro subtracted against the DSA run.');
  };
  $('flDsaOff')?.addEventListener('click', dsaAllOff);
  $('flDsa')?.addEventListener('click', () => { if (dsaOn) dsaAllOff(); else dsaArm(); });
  $('flRemask')?.addEventListener('click', () => {
    if (!dsaOn) return;
    remaskNext = true;
    setStatus('Remask — the next frame becomes the new mask.');
  });
  $('flRoad')?.addEventListener('click', () => {
    if (!roadmap) return;
    if (roadOn) dsaAllOff(); else roadOnNow();
  });
  // MODE steps the imaging mode the way the panel's key does: fluoro -> DSA -> roadmap (once a
  // DSA run has made one) -> fluoro. The mode changes the display chain; it fires nothing.
  $('flModeBtn')?.addEventListener('click', () => {
    if (F.pedal) { setStatus('Release the pedal to change mode.'); return; }
    if (dsaOn) { if (roadmap) roadOnNow(); else { dsaAllOff(); setStatus('Fluoro.'); } }
    else if (roadOn) { dsaAllOff(); setStatus('Fluoro.'); }
    else dsaArm();
  });
  panelSync();
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
    alarmShow();
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
    fluoroSyncScene(); renderReadouts();
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
    // the wire and the fracture belong to the patient they were made on
    gw = null; gwGeom = null; gwPts = null; syncWireUI();
    if (ctx.S.subject !== 'foot') ankleEnd();
    else if (ankleWant && ctx.S.mode === 'fluoro') ankleStart();
  });
  // ---- guidewire ----
  document.querySelectorAll('#flWireSeg button[data-acc]').forEach((b) => b.addEventListener('click', () => {
    gwAcc = +b.dataset.acc;
    document.querySelectorAll('#flWireSeg button[data-acc]').forEach((x) => x.classList.toggle('on', x === b));
    if (gw) setStatus('The access changes with the next insertion — remove the wire first.');
  }));
  $('flWireIn')?.addEventListener('click', () => wireInsert());
  // advance and withdraw: half a centimetre a tap, ~4 cm/s held; torque 15 degrees a tap
  holdRepeat($('flWireFwd'), () => wireNudge(0.5, 0));
  holdRepeat($('flWireBack'), () => wireNudge(-0.5, 0));
  holdRepeat($('flWireCW'), () => wireNudge(0, 15), 120);
  holdRepeat($('flWireCCW'), () => wireNudge(0, -15), 120);
  // ---- ankle ORIF ----
  $('flAnkleStart')?.addEventListener('click', () => ankleStart());
  $('flAnkleCheck')?.addEventListener('click', () => ankleCheck());
  document.querySelectorAll('#flAnkleViewSeg button').forEach((b) => b.addEventListener('click', () => {
    if (!ankle) { setStatus('Start the ankle case first.'); return; }
    ankleView(b.dataset.view);
  }));
  document.querySelectorAll('#flFragPad button[data-frag]').forEach((b) => {
    const [key, sg] = b.dataset.frag.split(',');
    holdRepeat(b, () => fragNudge(key, +sg), 110);
  });
  renderReadouts();
}
