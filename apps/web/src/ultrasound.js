/* ============================================================================
   ULTRASOUND MODE — docs/ultrasound.md
   No ionising radiation, no tube, no pedal: a probe held against the skin, and an
   image made entirely of interfaces and scattering.

   THE ARTIFACTS ARE NOT DRAWN — THEY ARE CONSEQUENCES. There is no shadow code
   and no enhancement code. One pulse-echo march per scanline carries an amplitude
   that is spent on reflection at every impedance mismatch and on attenuation
   through every centimetre, and:

     - bone and gas reflect ~all of it at the first interface, so nothing returns
       from beyond: a SHADOW;
     - a cyst attenuates almost nothing, while the TGC (like every real machine's)
       assumes a uniform 0.5 dB/cm/MHz of tissue above, so the returns beneath are
       OVER-compensated: post-cystic ENHANCEMENT;
     - tissue backscatter is summed with random sub-resolution phase and then
       convolved with the beam's own point-spread function, so what emerges is
       interference: SPECKLE, the texture that makes liver look like liver.

   The point-spread function is where the knobs get their teeth: axial width is the
   pulse length (2 lambda, so it shrinks with frequency), lateral width is the beam
   width (which grows away from the focus). Frequency therefore buys resolution and
   costs penetration, on the same image, from the same number.
   ============================================================================ */
import { acousticTables } from './core/acoustics.js';
import { deriveMotion, motionState, warpPoint, breathAmp } from './core/anatomyMotion.js';
import { dockConsole } from './core/paneDock.js';
import { buildSVolume } from './core/contrast.js';
import { dopplerShift, velocityFromShift, nyquistVelocity, prfMax, wrapToWindow, wallFilterGain,
  kasai, spectrumColumn, maxEnvelope, peakMeasures, flowWave, respFactor, laminar, WAVE_KINDS } from './core/doppler.js';

let ctx = null, U = null;
const $ = (id) => document.getElementById(id);

const NLINE = 192;            // scanlines per frame
const NSAMP = 512;            // samples along each line
const C_SND = 0.154;          // cm per microsecond — 1540 m/s, fixed (see the plan)
const TGC_ASSUME = 0.5;       // dB/cm/MHz the TGC assumes: the lie that makes enhancement
// A receiver's depth gain has a ceiling. Uncapped, the ramp at 12 MHz and 16 cm is 192 dB,
// which lifts the noise floor to saturated white — the far field went BLANK WHITE past
// penetration instead of dark. 66 dB leaves noise as dim grey snow, and only bites at depths
// that are already past where the echo falls under it.
const TGC_MAX = 66;
// Diffuse backscatter, scaled so tissue speckle sits ~40 dB under a specular bone echo —
// which is what puts liver at mid-grey and leaves room for an interface to be bright.
const SCAT = 0.09;
// Receiver amplification. A real machine's "0 dB" is not zero amplification — it is the
// system's reference, chosen so ordinary tissue lands mid-grey. Calibrated here so liver
// at working depth reads ~45 % of full scale with the gain knob centred.
// Raised 2 -> 9 when the echo started paying attenuation both ways: the old value had been set
// against an image that was getting 0.5·f·d dB of free gain. +7 dB returns the shallow field
// (2-5 cm, where that free gain was smallest) to the brightness it was calibrated at.
const SYS_DB = 9;
// ELECTRONIC NOISE FLOOR. Without one, the TGC — which scales with frequency, as real
// TGC does — would perfectly cancel attenuation at ANY frequency, and 12 MHz would see
// as deep as 2 MHz. It cannot, because past the depth where the echo falls under the
// receiver's own noise the gain amplifies noise instead of signal, and the far field
// turns to grey mush. That floor is what makes penetration cost something.
// Re-set after the echo was made to pay attenuation BOTH ways: at the old 2.2e-7 the speckle
// stood ~90 dB clear of it, too much headroom. +10 dB puts the noise crossing of the speckle
// at 5.5 / 8.9 / 13 / 19 cm for 12 / 7.5 / 5 / 3.5 MHz, the textbook penetration figures.
const NOISE = 7.0e-7;

// A window onto the heart, surveyed rather than guessed (docs/ultrasound.md §4.2): seven
// candidate seats were scored on how much of the image the systolic warp actually moves,
// and this one — epigastric, sagittal, angled up under the costal margin — won at 50.6
// grey levels RMS against 0.00 for the RUQ view, which has no heart in its plane at all.
const CARDIAC_SEAT = { px: 0.50, pz: 0.52, rot: 90, tilt: 25, depth: 22, focus: 12 };
/* A window onto the aorta, surveyed the same way (docs/ultrasound.md §4.4): 3024 sagittal seats and
   lines (across 0.43-0.53, along 0.38-0.50, rocked -25..25 degrees, twelve lines each), the gate
   put in the middle of the lumen, scored on the two-way amplitude reaching it with the beam-flow
   angle held at 60 degrees or less. Two findings shaped the choice. The subject's aorta is
   ANEURYSMAL below the kidneys (a ~6 cm sac, z 22-30 cm), so the seat is on the normal-calibre
   segment just above it. And most epigastric lines to that segment cross costal cartilage or bowel
   gas, losing 65-100 dB or shadowed outright. A second pass then centred the plane on the
   vessel: a sagittal plane that cuts the aorta off its axis puts a "mid-lumen" gate near the
   wall in elevation, at 40 % of the centre-line speed. The seat loses 44 dB to the aorta at
   16.3 cm, its gate sits within 0.35 R of the axis, and the flow comes toward the probe at
   ~57 degrees. Slide caudally from here to find the sac, where continuity slows everything. */
const AORTA_SEAT = { probe: 'curvi', freq: 3, px: 0.51, pz: 0.39, rot: 90, tilt: 10, depth: 20, focus: 16,
  disp: 'pw', pwLine: 0.46, pwGate: 3, dop: true, dopW: 0.3, dopH: 0.2 };
/* Put the gate in the middle of the lumen on the gate's line and lay the angle cursor along the
   vessel IN THE IMAGE PLANE — what a careful operator does, and all a machine can know: an
   out-of-plane vessel still fools it, which the truth readout then shows. */
function aimGate(want = 29) {
  const P = probeFrame(), steer = steerOf(P), o = lineGeom(P, U.pwLine, steer, {});
  const save = WST; WST = null;                        // the resting anatomy
  try {
    let r0 = -1, r1 = -1;
    for (let r = 0; r < U.depth; r += 0.05) {
      if (idAt(o.sx + o.dx * r, o.sy + o.dy * r, o.sz + o.dz * r) === want) { if (r0 < 0) r0 = r; r1 = r; }
      else if (r0 >= 0) break;
    }
    if (r0 < 0) return false;
    const rc = (r0 + r1) / 2;
    U.pwDepth = Math.round(rc * 10) / 10;
    idAt(o.sx + o.dx * rc, o.sy + o.dy * rc, o.sz + o.dz * rc);
    if (!sVol || !flowDir((MP[0] / vsx) | 0, (MP[1] / vsy) | 0, (MP[2] / vsz) | 0, want)) return true;
    // the flow direction back into the room (the inverse of dirToVol is the transpose of RM)
    let gx = GD[0], gy = GD[1], gz = GD[2];
    if (RM) { gx = RM[0] * GD[0] + RM[3] * GD[1] + RM[6] * GD[2]; gy = RM[1] * GD[0] + RM[4] * GD[1] + RM[7] * GD[2]; gz = RM[2] * GD[0] + RM[5] * GD[1] + RM[8] * GD[2]; }
    // image angles are measured from straight down toward +u, in the probe's own (rocked) frame
    const phG = Math.atan2(gx * P.ux + gz * P.uz, -gy) - P.tilt;
    const phB = P.apert ? steer : P.sector * (U.pwLine - 0.5);
    let a = (phB - phG) * 180 / Math.PI;
    a = ((a % 180) + 180) % 180; if (a > 90) a -= 180;   // a cursor is a line, not an arrow
    U.pwAngle = Math.round(a);
    return true;
  } finally { WST = save; }
}
const syncSliders = (list) => list.forEach((p) => { const [id, k] = p.split(':'); const el = $(id); if (el) el.value = U[k]; });
let aimPending = false;              // the vessel tree loads asynchronously; aim once it is in
function aimAndShow() {
  aimGate(29);
  U.dopX = U.pwLine; U.dopY = Math.min(0.85, U.pwDepth / U.depth);
  syncSliders(['usDopX:dopX', 'usDopY:dopY', 'usDopW:dopW', 'usDopH:dopH', 'usPwDepth:pwDepth', 'usPwAngle:pwAngle']);
  renderReadouts();
}
function seatAorta() {
  Object.assign(U, AORTA_SEAT);
  // "breathe out and hold": the breathing warp carries the upper abdomen, aorta included, a
  // centimetre or more, and a 3 mm gate falls out of the lumen mid-breath. The seat was surveyed
  // on the resting anatomy, so the breath is held where the anatomy rests — end expiration.
  brPhase = 0.9; U.hold = true;
  bindVolume(); syncPose();
  ensureSVol();
  if (sVol) aimAndShow(); else aimPending = true;
  document.querySelectorAll('#usProbeSeg button').forEach((x) => x.classList.toggle('on', x.dataset.probe === U.probe));
  document.querySelectorAll('#usDispSeg button').forEach((x) => x.classList.toggle('on', x.dataset.disp === U.disp));
  syncSliders(['usFreq:freq', 'usPx:px', 'usPz:pz', 'usRot:rot', 'usTilt:tilt', 'usDepth:depth', 'usFocus:focus',
    'usPwLine:pwLine', 'usPwDepth:pwDepth', 'usPwGate:pwGate', 'usPwAngle:pwAngle']);
  renderReadouts(); mReset(); sReset(); usSyncScene();
  if (U.live) sweep(); else setLive(true);
  setStatus('Sagittal over the aorta, breath held out — the gate is in the lumen, the angle cursor along the vessel.');
}

let TBL = null;               // flat acoustic tables

/* ---- the volume sampler ---------------------------------------------------
   Anatomy space: cm, origin at the volume's min corner, x lateral, y anterior,
   z superior — the same frame the mammography projector uses. */
let vol = null, vnx = 0, vny = 0, vnz = 0, vsx = 1, vsy = 1, vsz = 1, vex = 0, vey = 0, vez = 0;
function bindVolume() {
  const vm = ctx.S.voxelModel;
  if (!vm || !vm.data) { vol = null; return false; }
  vol = vm.data;
  [vnx, vny, vnz] = vm.dims;
  [vsx, vsy, vsz] = vm.vs;
  vex = vnx * vsx; vey = vny * vsy; vez = vnz * vsz;
  if (boundData !== vol) { anim = deriveMotion(vol, vm.dims, vm.vs.map((v) => v * 10)); cpKey = ''; }
  boundData = vol;
  return true;
}
/* ---- the anatomy moves (docs/ultrasound.md phase D) -------------------------
   Shared with fluoro, region for region — same diaphragm, same heart, same gut, from
   the same segmentation. Where the two differ is what they do with it: an x-ray warps
   what it integrates THROUGH, ultrasound warps what it echoes OFF, and an interface
   that moves toward the probe is the whole of what M-mode measures. */
let anim = null, boundData = null, WST = null;
const WP = new Float64Array(3);
/* Material-space position of the last sample, in cm. With motion off this is just
   where you looked; with motion on it is WHICH BIT OF TISSUE you looked at — and that
   is the coordinate speckle must be hashed on, or the texture would sit still in
   space while the anatomy slid through it. Speckle belongs to the tissue. */
const MP = new Float64Array(3);
/* THE PATIENT CAN BE ROLLED, AND THE BEAM HAS TO KNOW. Ultrasound sampled the volume in
   its own frame and ignored the object's rotation entirely, so rolling someone from
   supine to prone changed the body in the room and nothing on the monitor. The probe is
   held by an operator ABOVE the patient, so the honest model is the one the other engines
   already use: leave the hand where it is and turn the anatomy underneath it, by mapping
   each world sample back through the inverse rotation (the transpose) about the volume's
   centre. Roll someone prone and the probe is on their back, which is exactly right. */
let RM = null, rcx = 0, rcy = 0, rcz = 0, poseKey = '';
function syncPose() {
  const r = ctx.S.objRot;
  const key = `${r.x},${r.y},${r.z}`;
  if (key === poseKey) return;                     // unchanged: keep the contact cache warm
  poseKey = key;
  const R = ctx.phantomPose?.().rot;
  const idn = !R || (!r.x && !r.y && !r.z);
  RM = idn ? null : [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];  // transpose
  rcx = vex / 2; rcy = vey / 2; rcz = vez / 2;
  cpKey = '';                       // the surface moved, so the seat has to be found again
  dirCache = new Map(); dirCacheFor = null;        // flow directions are in the old frame
}
/* Rotate a DIRECTION into the volume's frame — no centre, no translation. Doppler needs
   it because the flow direction comes out of the volume while the beam is in the room. */
function dirToVol(d, out) {
  if (!RM) { out[0] = d[0]; out[1] = d[1]; out[2] = d[2]; return out; }
  out[0] = RM[0] * d[0] + RM[1] * d[1] + RM[2] * d[2];
  out[1] = RM[3] * d[0] + RM[4] * d[1] + RM[5] * d[2];
  out[2] = RM[6] * d[0] + RM[7] * d[1] + RM[8] * d[2];
  return out;
}
function idAt(x, y, z) {
  if (RM) {
    const ax = x - rcx, ay = y - rcy, az = z - rcz;
    x = rcx + RM[0] * ax + RM[1] * ay + RM[2] * az;
    y = rcy + RM[3] * ax + RM[4] * ay + RM[5] * az;
    z = rcz + RM[6] * ax + RM[7] * ay + RM[8] * az;
  }
  let fx = x / vsx, fy = y / vsy, fz = z / vsz;
  if (WST && WST.on && fz >= WST.lo && fz <= WST.hi) {
    warpPoint(WST, fx, fy, fz, WP);
    fx = WP[0]; fy = WP[1]; fz = WP[2];
  }
  MP[0] = fx * vsx; MP[1] = fy * vsy; MP[2] = fz * vsz;
  const ix = fx | 0, iy = fy | 0, iz = fz | 0;
  if (ix < 0 || iy < 0 || iz < 0 || ix >= vnx || iy >= vny || iz >= vnz) return 0;
  return vol[ix + vnx * (iy + vny * iz)];
}
/* Speckle is stationary in TISSUE, not in time: scatterers sit where they sit, so
   the hash is of position. A still probe gives a still image; move it and the
   speckle moves with the anatomy, which is how a sonographer tells the two apart. */
function hash3(a, b, c) {
  let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* Find the skin: march in from outside along the probe's axis until something that
   is not air. The probe then sits ON the patient, wherever the patient's surface
   happens to be — which is all "riding the surface" has ever meant. */
/* Gel. A real probe never touches skin: there is a millimetre or so of coupling gel
   under it, and for superficial work a standoff pad of a centimetre. Without any, the
   face sits exactly ON the skin and the skin line lands at depth zero, where the fan's
   apex clips it — the one layer you can always see on a real machine is the one this
   was throwing away. The pad also gives the near field somewhere to be. */
const GEL_PAD = 0.6;                   // cm of coupling between the face and the skin

/* One surface column: coarse at the voxel pitch (finer buys nothing — the data has no
   more), then refined so the answer is continuous rather than quantised to the grid. */
function surfaceAt(px, pz) {
  for (let y = vey - 0.01; y > 0; y -= vsy) {
    if (idAt(px, y, pz) !== 0) {
      for (let t = y + vsy; t > y - 1e-9; t -= 0.01) if (idAt(px, t, pz) !== 0) return t;
      return y;
    }
  }
  return -1;
}
/* THE FACE IS 5 cm WIDE AND THE PATIENT IS NOT FLAT. Seating the probe on a single
   voxel column made a drag step a whole voxel at a time — 2 mm hops of the entire
   image, which reads as a shaking hand. A real face rests on the AVERAGE contour
   beneath it, so that is what this returns: the mean surface over the footprint,
   which is both smoother and more nearly true.

   Deliberately UNWARPED: the hand holds a position and the anatomy moves under it.
   Seating on the breathing surface would slide the whole image every frame, which is a
   moving hand, not a moving patient. Cached, because for a fixed seat it is a constant. */
let cpKey = '', cpVal = 0;
function contactPoint(px, pz) {
  const key = px.toFixed(3) + ',' + pz.toFixed(3) + ',' + U.rot;
  if (key === cpKey) return cpVal;
  const save = WST; WST = null;
  try {
    const rot = U.rot * Math.PI / 180, ux = Math.cos(rot), uz = Math.sin(rot);
    let s = 0, n = 0;
    for (let i = -2; i <= 2; i++) {
      for (let j = -1; j <= 1; j++) {
        const f = i * 0.9, g = j * 0.6;            // cm along the face, cm across elevation
        const y = surfaceAt(px + ux * f - uz * g, pz + uz * f + ux * g);
        if (y > 0) { s += y; n++; }
      }
    }
    cpVal = (n ? s / n : vey * 0.5) + GEL_PAD;
    cpKey = key;
    return cpVal;
  } finally { WST = save; }
}

/* ---- the clocks ------------------------------------------------------------
   Held on this side, exactly as fluoro holds its own — which is what makes breath-hold
   a one-line trick: stop advancing one phase and every other rhythm keeps its time.
   Quiet breathing at 14/min, the heart at whatever the slider says. */
let brPhase = 0, cardPhase = 0, periT = 0, lastTick = 0;
function animTick() {
  const now = performance.now() / 1000;
  const dt = Math.min(lastTick ? now - lastTick : 0, 0.5);
  lastTick = now;
  // every clock pinned to one instant: a still frame AT a phase, which is not the same
  // thing as motion off (the heart is held contracted, not put back at rest)
  if (U.lockCard != null) return U.motion ? { br: brPhase, card: U.lockCard, peri: periT, sw: -1 } : { off: true };
  /* THE CIRCULATION DOES NOT STOP WITH THE ANATOMY. "Motion off" stills the warps — a patient
     held still, to measure against — but the clocks keep running, because the Doppler signal
     is the blood and a still patient still has a pulse. (Before Doppler had a waveform this
     returned before advancing anything, which was harmless; now it would flatten the trace.) */
  if (!U.hold) brPhase = (brPhase + dt / 4.3) % 1;
  cardPhase = (cardPhase + dt * U.hr / 60) % 1;
  periT += dt;
  if (!U.motion) return { off: true };
  return { br: brPhase, card: cardPhase, peri: periT, sw: -1 };
}

/* ---- DOPPLER (docs/ultrasound.md phases E and G) ------------------------------
   The one thing Doppler actually measures is the component of velocity ALONG THE BEAM:
   f_d = 2 f0 v cos(theta) / c. Everything a sonographer knows about angle follows from that,
   including the fact that a vessel crossed at 90 degrees shows NOTHING however fast the
   blood is moving — which is why the box is steered and the probe is heeled.

   The flow DIRECTION is not authored. The contrast solver already ships an arclength field s
   over the vessel tree, built by following the circulation, so grad-s points downstream —
   up the veins to the heart and out along the arteries — and an artery and its companion
   vein come out in opposite colours because the anatomy opposes them.

   The flow SPEED is not a constant either (phase G). At any point in a lumen it is
       v = vpk x wave(t) x (R_ref / R)^2 x (1 - (r/R)^2)
   a textbook peak for the vessel, a pulsatile or phasic waveform in time, CONTINUITY (the
   same flow through a wider section must go slower), and the laminar parabola across the
   lumen. R and r are measured at the sample, from the segmentation itself (chordProfile).

   Two displays are made from it, and both are signal processing rather than decoration:
     - colour: an ENSEMBLE of pulses per line, wall-filtered, and the Kasai autocorrelator's
       phase — so aliasing is a phase wrap nobody codes, and colour gain is a power threshold
       against real receiver noise;
     - spectral (PW): a gate full of scatterers, each at its own speed and angle, through the
       same wall filter into a periodogram — so the spectral broadening IS the velocity
       distribution in the gate.

   And it COSTS: the colour box fires ENS pulses per line at the colour PRF, and the PRF is
   capped by depth (PRF_max = c/2d), so a deep box is a slow box. */
const ENS = 8;                   // pulses per line in the colour box: a real ensemble
const CSTEP = 2;                 // colour line density: one colour line per two B lines, as machines do
/* Every named vessel: centre-line PEAK speed (cm/s) at its textbook calibre (radius r, cm),
   the waveform its bed gives it, and — for veins — which side of the diaphragm sets its
   respiratory swing. A CHOICE, documented in docs/ultrasound.md §4.4: the aorta, iliacs and
   subclavians feed high-resistance beds at rest (triphasic), the carotids and brachiocephalic
   trunk feed the brain (low resistance), the pulmonary artery ejects into a low-pressure bed
   (systolic only); central veins carry the right heart's S/D/a pattern, peripheral and portal
   veins are steady and breathe. */
const VESSEL = {
  29: { vpk: 100, r: 1.25, wave: 'triphasic', above: 'biphasic' },   // aorta: see renalLevel
  30: { vpk: 80, r: 1.25, wave: 'pulmonary' },                 // pulmonary artery
  31: { vpk: 50, r: 0.6, wave: 'venous', resp: 'thorax' },     // pulmonary veins
  32: { vpk: 45, r: 0.9, wave: 'venous', resp: 'thorax' },     // SVC
  33: { vpk: 35, r: 1.0, wave: 'venous', resp: 'thorax' },     // IVC: the right heart's pattern reaches it
  34: { vpk: 22, r: 0.6, wave: 'steady', resp: 'portal' },     // portal / splenic: hepatopetal, gentle
  35: { vpk: 90, r: 0.6, wave: 'lowres' },                     // brachiocephalic trunk
  36: { vpk: 90, r: 0.45, wave: 'triphasic' }, 37: { vpk: 90, r: 0.45, wave: 'triphasic' },   // subclavians
  38: { vpk: 90, r: 0.35, wave: 'lowres' }, 39: { vpk: 90, r: 0.35, wave: 'lowres' },         // common carotids
  40: { vpk: 35, r: 0.6, wave: 'venous', resp: 'thorax' }, 41: { vpk: 35, r: 0.6, wave: 'venous', resp: 'thorax' },
  42: { vpk: 30, r: 1.0, wave: 'venous' },                     // left atrial appendage
  43: { vpk: 110, r: 0.5, wave: 'triphasic' }, 44: { vpk: 110, r: 0.5, wave: 'triphasic' },  // iliac arteries
  45: { vpk: 20, r: 0.6, wave: 'steady', resp: 'abdo' }, 46: { vpk: 20, r: 0.6, wave: 'steady', resp: 'abdo' },
};
const isVesselId = (id) => id >= 29 && id <= 46;
const SUPRA = 63;                // a spare id slot: the aorta above the renal arteries
/* WHERE THE AORTA CHANGES ITS WAVEFORM is not authored either. The renal arteries are not in
   the segmentation, but the kidneys are, and the renal arteries leave the aorta at the level of
   the hila — so the kidneys' centroid height divides the aorta into the biphasic segment above
   (feeding the kidneys and the gut) and the triphasic one below (feeding the legs). */
let renalZ = 1e9, renalFor = null;
function renalLevel() {
  if (renalFor === boundData) return renalZ;
  renalFor = boundData;
  let n = 0, s = 0;
  for (let i = 0; i < vol.length; i++) if (vol[i] === 13) { n++; s += (i / (vnx * vny)) | 0; }
  renalZ = n ? (s / n + 0.5) * vsz : 1e9;
  return renalZ;
}
const waveId = (id, mz) => (id === 29 && mz > renalLevel() ? SUPRA : id);
// Doppler signal levels, relative to the receiver noise (calibrated in docs/ultrasound.md §4.4)
const BLOOD_A = 1;               // blood's Doppler echo with nothing in the way: the unit
const CLUT_DB = 45;              // tissue backscatter stands this far above blood's: the CLUTTER
const CLUT_A = Math.pow(10, CLUT_DB / 20) / 0.45;      // per unit of the B table's backscatter
const NOISE_D = 3.0e-5;          // receiver noise per slow-time sample, in BLOOD_A units
const CTH0 = 5;                  // colour power threshold above the noise at colour gain 0, dB
const DT_V = 0.01;               // s: the step a tissue velocity is differenced over

let sVol = null, sVolFor = null, sVolLoading = false;
function ensureSVol() {
  if (sVol || sVolLoading) return;
  const vm = ctx.S.voxelModel;
  if (!vm || !vm.loadArclen) return;
  // reuse whatever the contrast panel already built for this subject
  const C = ctx.S.contrast;
  if (C && C.sVol && C.sVolFor === ctx.S.subject) { sVol = C.sVol; sVolFor = ctx.S.subject; return; }
  sVolLoading = true;
  vm.loadArclen().then((arclen) => {
    sVol = buildSVolume(vm.data, arclen);
    sVolFor = ctx.S.subject;
    if (C) { C.sVol = sVol; C.sVolFor = ctx.S.subject; }   // share it back
    sVolLoading = false;
    setStatus('Colour box armed — flow directions from the vessel tree.');
    if (aimPending) { aimPending = false; aimAndShow(); }
  }).catch(() => {
    sVolLoading = false;
    setStatus('This subject ships no vessel tree — colour Doppler needs one.');
  });
}

/* THE FLOW DIRECTION IS grad-s, AND IT HAS TO BE FITTED, NOT DIFFERENCED.
   The first version took central differences along each axis. It failed on exactly the
   vessels that matter: an aorta is a couple of voxels across in one direction and long
   in another, so on the thin axes both neighbours are missing, the one-sided fallback
   measures variation ACROSS the lumen instead of along it, and a probe aimed at the
   aorta came back with a flow direction of (1,1,1)/sqrt(3) — a diagonal, from a vessel
   that runs straight down the body.

   So: a least-squares plane fit of s over every same-vessel voxel within a small ball.
   Voxels the vessel does not occupy simply do not enter the fit, thin axes contribute
   what little they legitimately can, and the answer is the direction s climbs fastest —
   which is downstream. Cached per voxel, because for a parked probe it is a constant and
   the ensemble below is where the frame time should honestly go. */
const GD = new Float64Array(3);
const BW = new Float64Array(3), BV = new Float64Array(3);   // beam dir: world, then volume
let dirCache = new Map(), dirCacheFor = null;
function flowDir(ix, iy, iz, id) {
  if (dirCacheFor !== boundData) { dirCache = new Map(); dirCacheFor = boundData; }
  const key = (ix + vnx * (iy + vny * iz)) * 1;
  const hit = dirCache.get(key);
  if (hit !== undefined) {
    if (hit === null) return 0;
    GD[0] = hit[0]; GD[1] = hit[1]; GD[2] = hit[2];
    return 1;
  }
  const R = 4;
  let sxx = 0, syy = 0, szz = 0, sxy = 0, sxz = 0, syz = 0;
  let bx = 0, by = 0, bz = 0, n = 0, sMean = 0;
  const pts = [];
  for (let dz = -R; dz <= R; dz++) {
    const z = iz + dz; if (z < 0 || z >= vnz) continue;
    for (let dy = -R; dy <= R; dy++) {
      const y = iy + dy; if (y < 0 || y >= vny) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = ix + dx; if (x < 0 || x >= vnx) continue;
        const k = x + vnx * (y + vny * z);
        if (vol[k] !== id) continue;
        pts.push(dx * vsx, dy * vsy, dz * vsz, sVol[k]);
        sMean += sVol[k]; n++;
      }
    }
  }
  if (n < 6) { dirCache.set(key, null); return 0; }
  sMean /= n;
  // centred normal equations for s ~ a.dx + b.dy + c.dz
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < pts.length; i += 4) { mx += pts[i]; my += pts[i + 1]; mz += pts[i + 2]; }
  mx /= n; my /= n; mz /= n;
  for (let i = 0; i < pts.length; i += 4) {
    const X = pts[i] - mx, Y = pts[i + 1] - my, Z = pts[i + 2] - mz, S = pts[i + 3] - sMean;
    sxx += X * X; syy += Y * Y; szz += Z * Z; sxy += X * Y; sxz += X * Z; syz += Y * Z;
    bx += X * S; by += Y * S; bz += Z * S;
  }
  // 3x3 symmetric solve, with a small ridge so a flat vessel cannot make it singular
  const r = 1e-4 * (sxx + syy + szz + 1);
  const a11 = sxx + r, a22 = syy + r, a33 = szz + r;
  const det = a11 * (a22 * a33 - syz * syz) - sxy * (sxy * a33 - syz * sxz) + sxz * (sxy * syz - a22 * sxz);
  if (!det || !isFinite(det)) { dirCache.set(key, null); return 0; }
  const gx = (bx * (a22 * a33 - syz * syz) - sxy * (by * a33 - syz * bz) + sxz * (by * syz - a22 * bz)) / det;
  const gy = (a11 * (by * a33 - bz * syz) - bx * (sxy * a33 - syz * sxz) + sxz * (sxy * bz - by * sxz)) / det;
  const gz = (a11 * (a22 * bz - by * syz) - sxy * (sxy * bz - by * sxz) + bx * (sxy * syz - a22 * sxz)) / det;
  const L = Math.hypot(gx, gy, gz);
  if (!(L > 1e-6)) { dirCache.set(key, null); return 0; }
  const d = [gx / L, gy / L, gz / L];
  dirCache.set(key, d);
  GD[0] = d[0]; GD[1] = d[1]; GD[2] = d[2];
  return 1;
}

/* ---- where in the lumen is this sample? ------------------------------------
   Continuity and the parabola both need it: R, the local radius, and rho = r/R, how far out
   from the axis the sample sits. Neither is in the segmentation as a number — but the lumen
   is, so measure it. Two rays across the vessel, perpendicular to the flow and to each
   other, each walked out both ways to the wall. For a circular section the midpoint of any
   chord is the foot of the perpendicular from the centre, so the half-difference of a chord's
   two arms is the sample's offset along it, and the half-sum and the OTHER chord's offset give
   R by Pythagoras. Two chords, four walks, no centre-line extraction and no lookup table —
   and it measures the aneurysm in this subject's aorta as readily as a normal iliac. */
const CH = new Float64Array(2);          // [rho, R cm] of the last chordProfile
const CC = new Float64Array(3);          // ...and the lumen's centre in the sample's cross-section
function rayLen(x, y, z, ux, uy, uz, id) {
  for (let t = 0.04; t < 5; t += 0.04) {
    const ix = ((x + ux * t) / vsx) | 0, iy = ((y + uy * t) / vsy) | 0, iz = ((z + uz * t) / vsz) | 0;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= vnx || iy >= vny || iz >= vnz
      || vol[ix + vnx * (iy + vny * iz)] !== id) return t - 0.02;
  }
  return 5;
}
function chordProfile(x, y, z, id, g) {
  // a helper axis well away from g, then u1 = g x a and u2 = g x u1
  const ax = Math.abs(g[0]) < 0.6 ? 1 : 0, ay = ax ? 0 : 1;
  let u1x = -g[2] * ay, u1y = g[2] * ax, u1z = g[0] * ay - g[1] * ax;
  const n1 = Math.hypot(u1x, u1y, u1z) || 1; u1x /= n1; u1y /= n1; u1z /= n1;
  const u2x = g[1] * u1z - g[2] * u1y, u2y = g[2] * u1x - g[0] * u1z, u2z = g[0] * u1y - g[1] * u1x;
  const a1 = rayLen(x, y, z, u1x, u1y, u1z, id), b1 = rayLen(x, y, z, -u1x, -u1y, -u1z, id);
  const a2 = rayLen(x, y, z, u2x, u2y, u2z, id), b2 = rayLen(x, y, z, -u2x, -u2y, -u2z, id);
  const m1 = (b1 - a1) / 2, h1 = (a1 + b1) / 2, m2 = (b2 - a2) / 2, h2 = (a2 + b2) / 2;
  const R2 = 0.5 * (h1 * h1 + m2 * m2 + h2 * h2 + m1 * m1);
  CH[1] = Math.sqrt(R2);
  CH[0] = Math.min(1, Math.sqrt((m1 * m1 + m2 * m2) / R2));
  CC[0] = x - m1 * u1x - m2 * u2x; CC[1] = y - m1 * u1y - m2 * u2y; CC[2] = z - m1 * u1z - m2 * u2z;
  return CH;
}
/* Speed factor at a point, given GD already set for it: continuity times the parabola.
   CONTINUITY IS MEASURED AGAINST THE TEXTBOOK CALIBRE (VESSEL.r), because that is the calibre
   the textbook peak belongs to. The first version measured it against the vessel's own median
   radius, and the median was the wrong yardstick twice over: the aorta's is dominated by the
   arch (where a perpendicular chord runs along the curve) and by the aneurysm, so it came out
   at 2.2 cm and made the normal-calibre segment run at 1.9x its textbook speed. Measured this
   way the subject's ectatic vessels are honestly slower than a textbook's — the suprarenal aorta
   is 3.3 cm across here, the iliacs ~1.9 cm, the sac 6.3 cm.
   The ratio is clamped: slowing is allowed down to 0.15 (that is the aneurysm, and it is real),
   speeding up only to 1.5x — there are no stenoses in this anatomy, and a small vessel only two
   voxels across under-measures its radius, which must not turn into a jet. */
function continuity(id, R) {
  const k = VESSEL[id].r / Math.max(R, 0.05);
  return Math.max(0.15, Math.min(1.5, k * k));
}
function lumenFactor(x, y, z, id) {
  chordProfile(x, y, z, id, GD);
  return continuity(id, CH[1]) * laminar(CH[0]);
}
// per-voxel cache for the colour box, where a voxel-centre answer is as fine as the box can show
let lumCache = new Map(), lumFor = null;
function lumenAtVoxel(ix, iy, iz, id) {
  if (lumFor !== boundData) { lumCache = new Map(); lumFor = boundData; }
  const key = ix + vnx * (iy + vny * iz);
  let v = lumCache.get(key);
  if (v === undefined) { v = lumenFactor((ix + 0.5) * vsx, (iy + 0.5) * vsy, (iz + 0.5) * vsz, id); lumCache.set(key, v); }
  return v;
}

/* ---- the tissue moves too: CLUTTER ------------------------------------------------
   Tissue echoes stand ~45 dB above blood's, and moving tissue makes a Doppler shift of its own.
   Its velocity is not invented: the same warp that moves the anatomy is evaluated a few
   milliseconds later, and the material coordinate under a fixed point in space slides by
   -v dt. So the breathing liver and the beating heart shift like anything else, the wall
   filter is what stands between them and the screen, and setting it too low FLASHES colour
   across the moving tissue exactly as a real machine does. */
let WST2 = null;
function tissueToward(x, y, z) {
  if (!(WST && WST.on) && !(WST2 && WST2.on)) return 0;
  idAt(x, y, z);
  const a0 = MP[0], a1 = MP[1], a2 = MP[2];
  const save = WST; WST = WST2;
  idAt(x, y, z);
  WST = save;
  // toward the probe = against the beam: v = -(m2 - m1)/dt, toward = -v . b
  return ((MP[0] - a0) * BV[0] + (MP[1] - a1) * BV[1] + (MP[2] - a2) * BV[2]) / DT_V;
}

/* A seeded generator for the Doppler side: ensemble phases, receiver noise, periodogram grain. */
let rs = 1;
function rnd() {
  rs = (rs + 0x6D2B79F5) | 0;
  let t = Math.imul(rs ^ (rs >>> 15), 1 | rs);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());

/* ---- the probe and its lines, shared by B, colour and PW ----------------------------
   One geometry for all three, so the colour box and the gate are on the lines they claim. */
function probeFrame() {
  const lin = U.probe === 'linear';
  const px = vex * U.px, pz = vez * U.pz;
  const rot = U.rot * Math.PI / 180;
  return { lin, R0: lin ? 0 : 6.0, sector: lin ? 0 : 1.05, apert: lin ? 4.0 : 0,
    px, py: contactPoint(px, pz), pz, ux: Math.cos(rot), uz: Math.sin(rot), tilt: U.tilt * Math.PI / 180 };
}
/* Line at fraction f across the face. curvilinear lines diverge from a virtual apex R0
   behind the face; linear lines are parallel, offset across the aperture — and a linear
   array can STEER them electronically, which is the one thing a curved face cannot. */
const LG = { sx: 0, sy: 0, sz: 0, dx: 0, dy: 0, dz: 0 };
function lineGeom(P, f, steer, o = LG) {
  const q = f - 0.5;
  if (P.apert) {
    const th = P.tilt + steer;
    o.dx = P.ux * Math.sin(th); o.dy = -Math.cos(th); o.dz = P.uz * Math.sin(th);
    o.sx = P.px + P.ux * P.apert * q; o.sy = P.py; o.sz = P.pz + P.uz * P.apert * q;
  } else {
    const th = P.sector * q + P.tilt;
    o.dx = P.ux * Math.sin(th); o.dy = -Math.cos(th); o.dz = P.uz * Math.sin(th);
    o.sx = P.px + o.dx * P.R0; o.sy = (P.py + P.R0) + o.dy * P.R0; o.sz = P.pz + o.dz * P.R0;
  }
  return o;
}
/* The waveform table for one instant: cm/s per vessel id, before geometry. */
const WV = new Float64Array(64);
function waveTable(card, insp) {
  const T = 60 / U.hr, t = card * T;
  for (let id = 29; id <= 46; id++) {
    const V = VESSEL[id];
    WV[id] = V.vpk * flowWave(V.wave, t, T) * respFactor(V.resp, insp);
  }
  WV[SUPRA] = VESSEL[29].vpk * flowWave(VESSEL[29].above, t, T);
  return WV;
}
const steerOf = (P) => (P.apert ? (U.steer || 0) * Math.PI / 180 : 0);
/* One step of the pulse-echo march, shared so the Doppler lines lose amplitude exactly as the
   B lines do: reflection at every mismatch, attenuation through every step. */
function stepAmp(st, id, freq, ds) {
  if (!st.coupled) { if (id === 0) id = 3; else st.coupled = true; }
  if (st.prev >= 0 && id !== st.prev) {
    const zp = TBL.z[st.prev], zz = TBL.z[id], rc = (zz - zp) / (zz + zp);
    st.amp *= Math.sqrt(Math.max(0, 1 - rc * rc));
  }
  st.prev = id;
  const a = st.amp;
  st.amp *= Math.exp(-TBL.att[id] * freq * ds / 8.686);
  return a;
}

/* ---- COLOUR: the ensemble, the wall filter, the autocorrelator --------------------
   Per colour line: march down it paying the same losses as B, and inside the box take four
   sub-samples across the sample volume (axially the pulse, laterally and in elevation the
   beam). Each is blood — at its own speed, from the waveform, the continuity and the
   parabola, along its own flow direction — or tissue, at the clutter level and its own
   motion. Their echoes go through the wall filter and ENS pulses of slow time, with receiver
   noise, into Kasai. What comes out is a mean shift, a power, and nothing else: the colour
   gain only decides how much power counts as flow. */
function colourFrame(P, ds, freq, lamCm, card, insp) {
  const l0 = Math.max(0, Math.round((U.dopX - U.dopW / 2) * (NLINE - 1)));
  const l1 = Math.min(NLINE - 1, Math.round((U.dopX + U.dopW / 2) * (NLINE - 1)));
  const k0 = Math.max(0, Math.round((U.dopY - U.dopH / 2) * (NSAMP - 1)));
  const k1 = Math.min(NSAMP - 1, Math.round((U.dopY + U.dopH / 2) * (NSAMP - 1)));
  const steer = steerOf(P);
  // the depth limit: the box's deepest echo must be home before the next pulse leaves
  const prfLim = prfMax((k1 + 1) * ds / 100);
  const prf = Math.min(U.prf, prfLim), f0 = freq * 1e6;
  const vNyq = nyquistVelocity(prf, f0) * 100;          // cm/s, along the beam
  const fc = U.cWall;
  // the high-pass also removes the noise in its stop band
  const sig = NOISE_D * Math.sqrt(Math.max(0.1, 1 - 2 * fc / prf));
  // complex noise: sig in I and in Q, so its power is 2 sig^2
  const thr = 2 * sig * sig * Math.pow(10, (CTH0 - U.cGain) / 10);
  const nC = Math.floor((l1 - l0) / CSTEP) + 1;
  const v = new Float32Array(nC * NSAMP), on = new Uint8Array(nC * NSAMP), vid = new Uint8Array(nC * NSAMP);
  // vid: which vessel a coloured sample came from, so a measurement can ask what the AORTA did
  // instead of averaging every vessel in the box (how Phase E's first angle test said nothing)
  const ves = new Uint8Array(nC * NSAMP);          // which samples sit in a lumen, coloured or not
  waveTable(card, insp);
  const M = 4, comps = new Float64Array(3 * M), am = 1 / Math.sqrt(M);
  const st = { amp: 1, prev: -1, coupled: false };
  for (let c = 0; c < nC; c++) {
    const l = l0 + c * CSTEP;
    lineGeom(P, l / (NLINE - 1), steer);
    const { sx, sy, sz, dx, dy, dz } = LG;
    BW[0] = dx; BW[1] = dy; BW[2] = dz; dirToVol(BW, BV);
    // in-plane lateral and elevation unit vectors, for the sample volume's extent
    const th = Math.atan2(dx * P.ux + dz * P.uz, -dy);          // the line's angle in the plane
    const lx = P.ux * Math.cos(th), ly = Math.sin(th), lz = P.uz * Math.cos(th);
    const ex = -P.uz, ez = P.ux;
    st.amp = 1; st.prev = -1; st.coupled = false;
    for (let k = 0; k <= k1; k++) {
      const r = k * ds;
      const x = sx + dx * r, y = sy + dy * r, z = sz + dz * r;
      const cid = idAt(x, y, z);
      const a1 = stepAmp(st, cid, freq, ds);
      if (k < k0) { if (st.amp < 1e-7) break; continue; }
      const A2 = a1 * a1;
      const bw = lamCm * 3 * (1 + Math.abs(r - U.focus) / Math.max(U.focus, 1));
      let nc = 0;
      for (let m = 0; m < M; m++) {
        const ja = (rnd() - 0.5) * 2 * lamCm * 2, jl = (rnd() - 0.5) * bw, je = (rnd() - 0.5) * bw;
        const qx = x + dx * ja + lx * jl + ex * je, qy = y + dy * ja + ly * jl, qz = z + dz * ja + lz * jl + ez * je;
        const id = idAt(qx, qy, qz);
        let vT, a;
        if (isVesselId(id) && sVol && flowDir((MP[0] / vsx) | 0, (MP[1] / vsy) | 0, (MP[2] / vsz) | 0, id)) {
          const fac = lumenAtVoxel((MP[0] / vsx) | 0, (MP[1] / vsy) | 0, (MP[2] / vsz) | 0, id);
          // toward the probe is AGAINST the beam, which points into the patient
          vT = -WV[waveId(id, MP[2])] * fac * (GD[0] * BV[0] + GD[1] * BV[1] + GD[2] * BV[2]);
          a = BLOOD_A * A2 * am;
        } else {
          const bs = TBL.bs[id];
          if (!(bs > 0)) continue;
          vT = tissueToward(qx, qy, qz);
          a = CLUT_A * bs * A2 * am;
        }
        const f = dopplerShift(f0, vT / 100, 0);
        comps[3 * nc] = a * Math.sqrt(wallFilterGain(f, fc, prf));
        comps[3 * nc + 1] = f; comps[3 * nc + 2] = rnd() * 2 * Math.PI;
        nc++;
      }
      const est = kasai(comps, nc, ENS, prf, sig, gauss);
      const i = c * NSAMP + k;
      /* Two tests, as on a machine: enough POWER (the colour gain), and a mean shift the wall
         filter was not set to remove. The second is the clutter reject. Tissue echoes stand
         ~45 dB above blood's, so the few tens of dB a slow-time filter takes off a breathing
         liver still leave power — but that power sits at the tissue's own shift, under the
         cutoff, and a mean shift under the cutoff is clutter by definition. What survives is
         tissue moving FASTER than the cutoff: the heart, which is the flash a real machine shows
         too, and which a higher wall filter clears. */
      if (est.p > thr && Math.abs(est.f) >= fc) {
        // the estimate is a phase in (-pi, pi], kept as measured: the baseline only decides
        // which window it is READ in, so it is applied at display time (drawFan), as the
        // post-processing re-map it is on a machine — it works on a frozen frame too
        v[i] = velocityFromShift(est.f, f0, 0) * 100 || 1e-6;
        on[i] = 1;
        vid[i] = isVesselId(cid) ? cid : 0;
      }
      if (isVesselId(cid)) ves[i] = 1;
      if (st.amp < 1e-7) break;
    }
  }
  return { nC, l0, l1, k0, k1, cstep: CSTEP, steer, v, on, vid, ves, vNyq, prf, prfLim };
}

/* ---- PW: the gate ------------------------------------------------------------
   A sample volume is a place on one line — a depth and a length along the beam, the beam's own
   width across it — and what it hears is every scatterer inside. They are drawn once a frame:
   256 points spread through the gate (uniform along it, Gaussian across, as the beam is), each
   either blood (with its flow direction, its place in the lumen, its vessel's waveform) or
   tissue (clutter, at its own motion). The spectral columns between frames re-time the
   waveform for each scatterer, so the trace is continuous in time while the anatomy updates
   at the frame rate. Also kept: the TRUE beam-flow angle in the gate — no machine knows it,
   and showing it is what makes the angle-correction lesson checkable. */
const NSC = 256;
const DOP_AP = 1.2;               // cm: the PW sub-aperture — the spread of angles it listens over
let pwSet = null;
function pwFrame(P, ds, freq, lamCm) {
  const steer = steerOf(P);
  lineGeom(P, U.pwLine, steer);
  const { sx, sy, sz, dx, dy, dz } = LG;
  BW[0] = dx; BW[1] = dy; BW[2] = dz; dirToVol(BW, BV);
  const d = Math.min(U.pwDepth, U.depth), g = U.pwGate / 10;   // cm
  const st = { amp: 1, prev: -1, coupled: false };
  let a1 = 1;
  for (let k = 0, kg = Math.round(d / ds); k <= kg; k++) {
    const r = k * ds;
    a1 = stepAmp(st, idAt(sx + dx * r, sy + dy * r, sz + dz * r), freq, ds);
  }
  const A2 = a1 * a1;
  const prfLim = prfMax((d + g / 2) / 100), prf = Math.min(U.pwPrf, prfLim);
  const bw = lamCm * 3 * (1 + Math.abs(d - U.focus) / Math.max(U.focus, 1)), sl = bw / 2.355;
  const sap = 0.5 * Math.atan(DOP_AP / 2 / Math.max(d, 1));
  const th = Math.atan2(dx * P.ux + dz * P.uz, -dy);          // the line's angle in the plane
  const lx = P.ux * Math.cos(th), ly = Math.sin(th), lz = P.uz * Math.cos(th);
  const ex = -P.uz, ez = P.ux;
  // a longer gate holds more blood and hears more of it: power in proportion to its length
  const aScale = A2 * Math.sqrt(g / 0.3) / Math.sqrt(NSC);
  const kind = new Uint8Array(NSC), spd = new Float32Array(NSC), cosE = new Float32Array(NSC);
  const rg = new Uint8Array(NSC), amp = new Float32Array(NSC), vT = new Float32Array(NSC);
  let nv = 0, sc = 0;
  const idc = {};
  /* ONE CYLINDER FOR THE WHOLE GATE. Measuring the lumen afresh at every scatterer put the voxel
     grid's stair-steps into every radius — two neighbouring points a millimetre apart could read
     rho 0.2 and 0.5 — and that noise filled the spectral window even under a 1 mm gate on the
     axis. A sonographer's gate sits in ONE stretch of vessel, so the lumen is measured once, at
     the gate's centre (axis, radius, continuity), and each scatterer's rho is its distance from
     that axis: a clean parabola, and the window is clear or filled by the gate, not the grid. */
  let fit = null;
  {
    const gid = idAt(sx + dx * d, sy + dy * d, sz + dz * d);
    if (isVesselId(gid) && sVol && flowDir((MP[0] / vsx) | 0, (MP[1] / vsy) | 0, (MP[2] / vsz) | 0, gid)) {
      chordProfile(MP[0], MP[1], MP[2], gid, GD);
      fit = { id: gid, c: [CC[0], CC[1], CC[2]], g: [GD[0], GD[1], GD[2]], R: CH[1], k: continuity(gid, CH[1]) };
    }
  }
  for (let i = 0; i < NSC; i++) {
    const ja = (rnd() - 0.5) * g, jl = gauss() * sl, je = gauss() * sl, r = d + ja;
    const qx = sx + dx * r + lx * jl + ex * je, qy = sy + dy * r + ly * jl, qz = sz + dz * r + lz * jl + ez * je;
    const id = idAt(qx, qy, qz);
    const ix = (MP[0] / vsx) | 0, iy = (MP[1] / vsy) | 0, iz = (MP[2] / vsz) | 0;
    if (isVesselId(id) && sVol && flowDir(ix, iy, iz, id)) {
      const mx = MP[0], my = MP[1], mz = MP[2];
      const cT = -(GD[0] * BV[0] + GD[1] * BV[1] + GD[2] * BV[2]);
      if (fit && id === fit.id) {
        const ox = mx - fit.c[0], oy = my - fit.c[1], oz = mz - fit.c[2];
        const al = ox * fit.g[0] + oy * fit.g[1] + oz * fit.g[2];
        const rho = Math.hypot(ox - al * fit.g[0], oy - al * fit.g[1], oz - al * fit.g[2]) / fit.R;
        spd[i] = VESSEL[id].vpk * fit.k * laminar(rho);
      } else spd[i] = VESSEL[id].vpk * lumenFactor(mx, my, mz, id);
      // INTRINSIC BROADENING: the sub-aperture hears each scatterer over a spread of angles,
      // so a single speed arrives as a band of shifts — wider the more oblique the beam
      const dl = gauss() * sap, sT = Math.sqrt(Math.max(0, 1 - cT * cT));
      cosE[i] = cT * Math.cos(dl) + sT * Math.sin(dl);
      kind[i] = WAVE_KINDS.indexOf(waveId(id, mz) === SUPRA ? VESSEL[29].above : VESSEL[id].wave) + 1;
      rg[i] = ['', 'abdo', 'thorax', 'portal'].indexOf(VESSEL[id].resp || '');
      amp[i] = BLOOD_A * aScale;
      nv++; sc += cT; idc[id] = (idc[id] || 0) + 1;
    } else {
      const bs = TBL.bs[id];
      amp[i] = bs > 0 ? CLUT_A * bs * aScale : 0;
      vT[i] = amp[i] ? tissueToward(qx, qy, qz) : 0;
    }
  }
  let vMain = 0, best = 0;
  for (const k in idc) if (idc[k] > best) { best = idc[k]; vMain = +k; }
  pwSet = { kind, spd, cosE, rg, amp, vT, prf, prfLim, f0: freq * 1e6, d, g, A2, fit,
    inVessel: nv / NSC, vessel: vMain, trueAngle: nv ? Math.acos(Math.min(1, Math.abs(sc / nv))) * 180 / Math.PI : null,
    towardSign: nv ? Math.sign(sc) : 0 };
  return pwSet;
}

/* ---- one frame ------------------------------------------------------------- */
let lastEcho = null, lastMs = 0, lastAcqMs = 0;
function scanFrame() {
  // REBIND WHEN THE SUBJECT CHANGES. This was `!vol && bindVolume()`, so the volume was
  // bound once and never again: pick a different subject mid-session and ultrasound kept
  // scanning the old one. Invisible in development, where the page is reloaded constantly,
  // and plainly wrong on the deployed site, where the hand loads first and the RUQ seat
  // then found no liver at all.
  if (vol !== (ctx.S.voxelModel && ctx.S.voxelModel.data) && !bindVolume()) return null;
  if (!vol) return null;
  const t0 = performance.now();
  syncPose();                       // the patient may have been rolled since the last frame
  if (!TBL) TBL = acousticTables(64);
  const ph = animTick();
  WST = anim ? motionState(anim, ph, vsz, vnz) : null;
  // the same anatomy DT_V later: what a tissue velocity is differenced against
  WST2 = anim && ph && !ph.off ? motionState(anim, { br: U.hold ? ph.br : ph.br + DT_V / 4.3,
    card: U.lockCard != null ? ph.card : ph.card + DT_V * U.hr / 60, peri: ph.peri + DT_V, sw: -1 }, vsz, vnz) : null;
  const pwOn = U.disp === 'pw';
  const dopOn = !!(U.dop && sVol);
  if (U.dop || pwOn) ensureSVol();
  rs = (t0 * 1000) | 0;
  // the blood's clocks run even when the anatomy is held still (see animTick)
  const card = U.lockCard != null ? U.lockCard : cardPhase, insp = breathAmp(brPhase);
  const { z: Zt, att: At, bs: Bt } = TBL;
  const depth = U.depth, freq = U.freq;
  const P = probeFrame();
  const { R0, sector, apert } = P;
  const ds = depth / NSAMP;
  const echo = new Float32Array(NLINE * NSAMP);
  const lamCm = C_SND / freq;                          // wavelength, cm

  // THE SCAN PLANE IS THE PROBE'S, NOT THE VOLUME'S. u is the in-plane lateral
  // direction: rot = 0 lays the fan across the patient (transverse), rot = 90 lays it
  // along them (sagittal), and anything between is the oblique a real hand produces.
  // Rocking steers the whole fan by adding to every line's angle.
  for (let l = 0; l < NLINE; l++) {
    const { sx: startX, sy: startY, sz: startZ, dx, dy, dz } = lineGeom(P, l / (NLINE - 1), 0);
    let amp = 1;                                       // one-way amplitude remaining
    let prevId = -1;
    let coupled = false;      // has this line reached the patient yet?
    const base = l * NSAMP;
    for (let k = 0; k < NSAMP; k++) {
      const r = k * ds;
      const x = startX + dx * r, y = startY + dy * r, zc = startZ + dz * r;
      let id = idAt(x, y, zc);
      // GEL. A convex face touches the skin at its centre and stands off it at the
      // edges, so every oblique line would cross an air gap and lose ~30 dB at the
      // air-skin mismatch — which is precisely what happens when you forget the gel,
      // and precisely what the gel is for. Air BEFORE the beam has entered the
      // patient is therefore coupling medium; air after it (bowel gas, the far skin
      // line) is real air and keeps its mirror.
      if (!coupled) { if (id === 0) id = 3; else coupled = true; }
      const zz = Zt[id];
      let e = 0;
      if (prevId >= 0 && id !== prevId) {
        // specular reflection at the impedance mismatch — the boundary itself
        const zp = Zt[prevId];
        const rc = (zz - zp) / (zz + zp);
        const Rp = rc * rc;
        e += Math.sqrt(Rp) * amp;                      // amplitude of the returned echo
        amp *= Math.sqrt(Math.max(0, 1 - Rp));         // what carries on into the tissue
      }
      // diffuse backscatter from sub-resolution structure, random phase: SPECKLE
      const bs = Bt[id];
      if (bs > 0) {
        const q = hash3((MP[0] * 50) | 0, (MP[1] * 50) | 0, (MP[2] * 50) | 0);
        e += bs * (q - 0.5) * 2.0 * amp * SCAT;
      }
      /* THE ECHO COMES BACK THE WAY IT WENT IN. `amp` is what survives the trip DOWN to this
         depth; the echo must make the same trip back up, through the same tissue and the same
         interfaces, so it is scaled by `amp` a second time. Without this the image paid
         attenuation one way while the TGC repaid it both ways — 0.5·f·d dB of free gain
         (+17 dB at 3.5 MHz and 10 cm), liver brightening with depth, and 19 cm of
         penetration at 12 MHz, which is what made the frequency lesson mean nothing. */
      echo[base + k] = e * amp;
      // attenuation over this step, one way — the echo pays it again on the way back (above)
      amp *= Math.exp(-At[id] * freq * ds / 8.686);
      if (amp < 1e-6) { prevId = id; break; }          // nothing is coming back from here
      prevId = id;
    }
  }
  // colour and PW, each on lines of its own (steered, on a linear array), after the B lines
  const col = dopOn ? colourFrame(P, ds, freq, lamCm, card, insp) : null;
  const pw = pwOn ? pwFrame(P, ds, freq, lamCm) : null;
  lastMs = performance.now() - t0;
  /* THE FRAME RATE IS ACOUSTIC, NOT COMPUTATIONAL. A machine cannot start the next line
     until the last echo of this one has come back, so a B frame costs NLINE x 2 x depth / c —
     which is why a deep scan is slower than a shallow one and why M-mode (one line) can sweep
     at kilohertz.

     The colour box costs what its PULSES cost: ENS of them per colour line, one every 1/PRF.
     That is at least ENS round trips to the bottom of the box (PRF_max = c/2d), and MORE when
     the scale is set below the ceiling — a low PRF, chosen to see slow flow, is a slow frame.
     (Phase E counted each box line as ENS round trips of the whole image depth; the PRF is the
     honest clock.) And PW in duplex shares the transducer with the image: the B frame gets
     about half the time, so it refreshes at half the rate. */
  const tLineMs = 2 * depth / (C_SND * 1e6) * 1e3;          // round trip, ms
  lastAcqMs = NLINE * tLineMs + (col ? col.nC * ENS / col.prf * 1e3 : 0);
  if (pw) lastAcqMs *= 2;
  lastEcho = { echo, depth, freq, ds, sector, R0, apert, lamCm, col, pw, acqMs: lastAcqMs,
    vel: col ? col.v : null, vNyq: col ? col.vNyq : 0, box: col ? { l0: col.l0, l1: col.l1, k0: col.k0, k1: col.k1 } : null };
  return lastEcho;
}

/* ---- the beam's point-spread function --------------------------------------
   Separable, and both widths are physics rather than taste: axial = pulse length
   (2 lambda), lateral = beam width, narrowest at the focus and diverging away
   from it. This is the whole frequency trade in two lines. */
function envelope(fr) {
  const { echo, ds, lamCm, sector, R0 } = fr;
  const out = new Float32Array(NLINE * NSAMP);
  const tmp = new Float32Array(NLINE * NSAMP);
  const wax = Math.max(1, Math.round((2 * lamCm) / ds / 2));       // half-width, samples
  // axial
  for (let l = 0; l < NLINE; l++) {
    const b = l * NSAMP;
    for (let k = 0; k < NSAMP; k++) {
      let s = 0, w = 0;
      for (let d = -wax; d <= wax; d++) {
        const kk = k + d; if (kk < 0 || kk >= NSAMP) continue;
        const g = Math.exp(-(d * d) / (wax * wax + 0.5));
        s += echo[b + kk] * g; w += g;
      }
      tmp[b + k] = s / (w || 1);
    }
  }
  // lateral, depth-dependent
  const focus = U.focus;
  for (let k = 0; k < NSAMP; k++) {
    const r = R0 + k * ds;
    const bw = lamCm * 3 * (1 + Math.abs(k * ds - focus) / Math.max(focus, 1));   // cm
    const lineSp = sector ? Math.max(r * sector / (NLINE - 1), 1e-4) : 4.0 / NLINE;
    const wl = Math.max(0, Math.min(6, Math.round(bw / lineSp / 2)));
    for (let l = 0; l < NLINE; l++) {
      let s = 0, w = 0;
      for (let d = -wl; d <= wl; d++) {
        const ll = l + d; if (ll < 0 || ll >= NLINE) continue;
        const g = Math.exp(-(d * d) / (wl * wl + 0.5));
        s += tmp[ll * NSAMP + k] * g; w += g;
      }
      // receiver noise rides on every sample, uncorrelated and stable per frame
      const nz = hash3(l * 7919, k * 104729, 17) - 0.5;
      out[l * NSAMP + k] = Math.abs(s / (w || 1)) + NOISE * (0.5 + Math.abs(nz));
    }
  }
  return out;
}

/* ---- scan conversion + display --------------------------------------------- */
let usCanvas = null, bCanvas = null;
/* One grey level from one echo, in the one place both displays can share — the B fan
   and the M trace must map identically or the trace would lie about the image. */
function greyOf(e, k, tgcLut, dr) {
  const db = 20 * Math.log10(e + 1e-7) + SYS_DB + tgcLut[k] + U.gain;
  const v = Math.max(0, Math.min(1, (db + dr) / dr));
  return Math.pow(v, 0.85) * 255;
}
function buildTgc(freq, ds) {
  // TGC as a depth lookup: the machine's own ramp (which assumes uniform tissue —
  // see the note in the header) PLUS the operator's six band offsets, interpolated.
  // Every bit of this is display-side; the echo underneath never changes.
  const B = U.tgcBands || [0, 0, 0, 0, 0, 0], nb = B.length;
  const lut = new Float64Array(NSAMP);
  for (let k = 0; k < NSAMP; k++) {
    const t = k / (NSAMP - 1) * (nb - 1);
    const i0 = Math.min(nb - 1, t | 0), i1 = Math.min(nb - 1, i0 + 1), fr2 = t - i0;
    lut[k] = Math.min(TGC_MAX, 2 * TGC_ASSUME * freq * (k * ds)) + (B[i0] * (1 - fr2) + B[i1] * fr2);
  }
  return lut;
}
/* THE COLOUR MAP. BART, the convention every machine ships with — Blue Away, Red Toward —
   with brightness rising to the edge of the window: dark red to red to YELLOW at the top of the
   scale, dark blue to blue to CYAN at the bottom. That ramp is not decoration, it is how
   aliasing is told from reversal: a true reversal passes through BLACK (slowing to zero and
   coming back), an alias jumps straight from yellow to cyan (the brightest toward becomes the
   brightest away). Invert swaps the two families for a vessel the probe meets the other way. */
function colourOf(v, half, b, inv, out) {
  const x = v / half;
  const t = x >= 0 ? Math.min(1, x / (1 + b)) : Math.min(1, -x / (1 - b));
  const hot = Math.min(1, 0.32 + 1.1 * t), glow = Math.max(0, (t - 0.6) / 0.4);
  const red = (x >= 0) !== !!inv;
  if (red) { out[0] = 255 * hot; out[1] = 230 * glow; out[2] = 20 * glow; }
  else { out[0] = 20 * glow; out[1] = 230 * glow; out[2] = 255 * hot; }
  return out;
}
const CRGB = new Float64Array(3);
let lastColStats = null;
/* The B fan, scan-converted. Returns the geometry so the M cursor can be drawn in the
   same frame the image was built in. */
function drawFan(env, fr, tgcLut) {
  const { depth, ds, sector, R0, apert, col } = fr;
  if (!bCanvas) { bCanvas = document.createElement('canvas'); bCanvas.width = 512; bCanvas.height = 512; }
  const W = bCanvas.width, H = bCanvas.height;
  const g = bCanvas.getContext('2d');
  const img = g.createImageData(W, H);
  const dr = U.range;                                   // displayed dynamic range, dB
  // The fan, sized so the sector just fills the frame.
  const halfW = sector ? (R0 + depth) * Math.sin(sector / 2) : apert / 2;
  const totalH = sector ? (R0 + depth) - R0 * Math.cos(sector / 2) : depth;
  const scale = Math.min(W / (2 * halfW), H / totalH) * 0.96;
  const cx = W / 2, cy = sector ? (H - totalH * scale) / 2 - (R0 * Math.cos(sector / 2)) * scale
                                : (H - totalH * scale) / 2;
  // a steered linear colour box is a parallelogram: its lines lean, so the pixel -> line map does too
  const tS = col ? Math.tan(col.steer) : 0, cS = col ? Math.cos(col.steer) : 1;
  // what the screen shows, by what is under it: the measurement hook for flash and bleed
  const cst = { ves: 0, vesOn: 0, tis: 0, tisOn: 0, vesHist: new Uint32Array(11), tisHist: new Uint32Array(11) };
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const X = (i - cx) / scale, Y = (j - cy) / scale;
      let l, k;
      if (sector) {
        const r = Math.hypot(X, Y);
        const th = Math.atan2(X, Y);
        if (r < R0 || r > R0 + depth || Math.abs(th) > sector / 2) { l = -1; }
        else { l = Math.round((th / sector + 0.5) * (NLINE - 1)); k = Math.round((r - R0) / ds); }
      } else {
        if (Math.abs(X) > apert / 2 || Y < 0 || Y > depth) { l = -1; }
        else { l = Math.round((X / apert + 0.5) * (NLINE - 1)); k = Math.round(Y / ds); }
      }
      const o = (j * W + i) * 4;
      let v = 0;
      // TGC: every machine compensates for an ASSUMED uniform tissue. That
      // assumption is what makes a cyst's far wall bright and a stone's shadow
      // black — the compensation is right for tissue and wrong for both.
      const inB = l >= 0 && l < NLINE && k >= 0 && k < NSAMP;
      if (inB) v = greyOf(env[l * NSAMP + k], k, tgcLut, dr);
      let R = v, G = v, B = v;
      if (col && inB) {
        let lc = l, kc = k;
        if (!sector && col.steer) { lc = Math.round(((X - Y * tS) / apert + 0.5) * (NLINE - 1)); kc = Math.round(Y / cS / ds); }
        const c = Math.round((lc - col.l0) / col.cstep);
        if (c >= 0 && c < col.nC && kc >= col.k0 && kc <= col.k1 && lc >= col.l0 && lc <= col.l1) {
          const ii = c * NSAMP + kc, isV = col.ves[ii] === 1;
          if (isV) { cst.ves++; cst.vesHist[(v / 25.5) | 0]++; } else { cst.tis++; cst.tisHist[(v / 25.5) | 0]++; }
          /* WRITE PRIORITY: colour is written only where the grey is darker than the priority
             level. Every machine has this knob, and it is not cosmetic: tissue clutter stands
             ~45 dB above blood, so even after the wall filter a moving liver or heart leaves
             Doppler power that a threshold on power alone would paint. A lumen is anechoic and
             tissue is not, so the B image itself says where colour belongs. Raise it to 100 %
             and the flash from moving tissue shows through. */
          if (col.on[ii] && v < U.cPri * 2.55) {
            if (isV) cst.vesOn++; else cst.tisOn++; colourOf(wrapToWindow(col.v[ii], col.vNyq, U.cBase), col.vNyq, U.cBase, U.cInv, CRGB); R = CRGB[0]; G = CRGB[1]; B = CRGB[2]; }
        }
      }
      img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // the colour box, drawn where the colour actually is: a wedge in the fan's own polar
  // frame, a parallelogram for a steered linear, never a rectangle pasted over it
  if (col) {
    // a steered box leans out of the image; only the part inside it is ever coloured
    g.save();
    if (!sector) { g.beginPath(); g.rect(cx - apert / 2 * scale, cy, apert * scale, depth * scale); g.clip(); }
    g.strokeStyle = 'rgba(120,230,140,0.8)'; g.lineWidth = 1.5;
    g.beginPath();
    if (sector) {
      const t0 = (col.l0 / (NLINE - 1) - 0.5) * sector, t1 = (col.l1 / (NLINE - 1) - 0.5) * sector;
      const r0 = R0 + col.k0 * ds, r1 = R0 + col.k1 * ds;
      const pt = (r, t) => [cx + Math.sin(t) * r * scale, cy + Math.cos(t) * r * scale];
      g.moveTo(...pt(r0, t0));
      g.arc(cx, cy, r0 * scale, Math.PI / 2 - t0, Math.PI / 2 - t1, true);
      g.lineTo(...pt(r1, t1));
      g.arc(cx, cy, r1 * scale, Math.PI / 2 - t1, Math.PI / 2 - t0, false);
      g.closePath();
    } else {
      const x0 = (col.l0 / (NLINE - 1) - 0.5) * apert, x1 = (col.l1 / (NLINE - 1) - 0.5) * apert;
      const sn = Math.sin(col.steer), r0 = col.k0 * ds, r1 = col.k1 * ds;
      const pt = (x, r) => [cx + (x + sn * r) * scale, cy + cS * r * scale];
      g.moveTo(...pt(x0, r0)); g.lineTo(...pt(x1, r0)); g.lineTo(...pt(x1, r1)); g.lineTo(...pt(x0, r1));
      g.closePath();
    }
    g.stroke();
    g.restore();
    drawColourBar(g, col);
  }
  lastColStats = cst;
  const geo = { W, H, cx, cy, scale };
  if (fr.pw) drawGate(g, geo, fr);
  drawDepthScale(g, geo, fr);
  drawCalipers(g, geo);
  lastGeo = geo;
  return geo;
}
/* The colour bar every machine prints beside the box: the window from -vlo to +vhi, the zero
   line where the baseline put it, and the scale in cm/s — the speed at which the colour runs
   out and wraps. Toward the probe is the top of the bar, whichever colour invert gives it. */
function drawColourBar(g, col) {
  const x = 10, y0 = 34, h = 150, hi = col.vNyq * (1 + U.cBase), lo = col.vNyq * (1 - U.cBase);
  for (let j = 0; j < h; j++) {
    const v = hi - (j + 0.5) / h * (hi + lo);
    colourOf(v, col.vNyq, U.cBase, U.cInv, CRGB);
    g.fillStyle = `rgb(${CRGB[0] | 0},${CRGB[1] | 0},${CRGB[2] | 0})`;
    g.fillRect(x, y0 + j, 10, 1);
  }
  const yz = y0 + h * hi / (hi + lo);
  g.strokeStyle = 'rgba(230,240,235,0.9)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(x - 3, yz + 0.5); g.lineTo(x + 13, yz + 0.5); g.stroke();
  g.fillStyle = 'rgba(200,240,210,0.95)'; g.font = '11px ui-monospace, monospace'; g.textAlign = 'left';
  g.fillText(`+${hi.toFixed(hi < 10 ? 1 : 0)}`, x + 14, y0 + 9);
  g.fillText(`-${lo.toFixed(lo < 10 ? 1 : 0)}`, x + 14, y0 + h);
  g.fillText('cm/s', x - 2, y0 + h + 14);
  if (U.cInv) g.fillText('INV', x - 2, y0 - 6);
}
/* The PW cursor on the B image: the beam line it fires down, the gate as the two short bars a
   machine draws, and the angle-correction cursor laid through the gate at theta to the beam —
   the line the operator turns until it lies along the vessel. */
function drawGate(g, geo, fr) {
  const { sector, R0, depth, apert } = fr, pw = fr.pw, { cx, cy, scale } = geo;
  let ox, oy, bx, by;                 // line origin on the face, beam direction (image frame)
  if (sector) { const th = (U.pwLine - 0.5) * sector; bx = Math.sin(th); by = Math.cos(th); ox = bx * R0; oy = by * R0; }
  else { const s = steerOf({ apert: 1 }); bx = Math.sin(s); by = Math.cos(s); ox = (U.pwLine - 0.5) * apert; oy = 0; }
  const P2 = (r) => [cx + (ox + bx * r) * scale, cy + (oy + by * r) * scale];
  g.save();
  g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 1; g.setLineDash([4, 5]);
  g.beginPath(); g.moveTo(...P2(0)); g.lineTo(...P2(depth)); g.stroke(); g.setLineDash([]);
  g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 2;
  const nx = by, ny = -bx, w = 0.45;   // the gate's bars, across the beam
  for (const r of [pw.d - pw.g / 2, pw.d + pw.g / 2]) {
    const [x, y] = P2(r);
    g.beginPath(); g.moveTo(x - nx * w * scale, y - ny * w * scale); g.lineTo(x + nx * w * scale, y + ny * w * scale); g.stroke();
  }
  const a = (U.pwAngle || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const ax = bx * ca - by * sa, ay = bx * sa + by * ca, L = 1.6;
  const [gx, gy] = P2(pw.d);
  g.strokeStyle = 'rgba(120,255,160,0.95)'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(gx - ax * L * scale, gy - ay * L * scale); g.lineTo(gx + ax * L * scale, gy + ay * L * scale); g.stroke();
  g.restore();
}

/* ---- the depth scale -------------------------------------------------------
   Every machine prints one down the side of the image, and without it nothing on the screen
   has a size: centimetre ticks from the skin line, numbered, and the focal-zone marker at the
   transmit focus, so "focus at the lesion" is something you can check rather than guess. */
function drawDepthScale(g, geo, fr) {
  const { depth, R0 } = fr;
  const { W, cx, cy, scale } = geo;
  const yOf = (d) => cy + ((R0 || 0) + d) * scale;      // along the centre line
  const x = W - 8;
  const every = depth <= 8 ? 1 : depth <= 16 ? 2 : 5;
  g.save();
  g.strokeStyle = 'rgba(190,225,240,0.85)'; g.fillStyle = 'rgba(190,225,240,0.85)';
  g.lineWidth = 1; g.font = '11px ui-monospace, monospace'; g.textAlign = 'right';
  g.beginPath(); g.moveTo(x + 0.5, yOf(0)); g.lineTo(x + 0.5, yOf(depth)); g.stroke();
  for (let d = 0; d <= depth + 1e-6; d += 0.5) {
    const major = Math.abs(d - Math.round(d)) < 1e-6;
    const len = major ? (Math.round(d) % every === 0 ? 8 : 5) : 2.5;
    const y = Math.round(yOf(d)) + 0.5;
    g.beginPath(); g.moveTo(x - len, y); g.lineTo(x, y); g.stroke();
    if (major && Math.round(d) % every === 0 && d > 0) g.fillText(String(Math.round(d)), x - 10, y + 4);
  }
  // the focal zone: a small triangle pointing at the scale
  const fy = yOf(Math.min(U.focus, depth));
  g.fillStyle = 'rgba(255,214,90,0.95)';
  g.beginPath(); g.moveTo(x - 14, fy); g.lineTo(x - 22, fy - 5); g.lineTo(x - 22, fy + 5); g.closePath(); g.fill();
  g.textAlign = 'left'; g.fillStyle = 'rgba(190,225,240,0.75)';
  g.fillText('cm', x - 18, yOf(depth) + 14 > geo.H - 2 ? geo.H - 4 : yOf(depth) + 14);
  g.restore();
}

/* ---- calipers --------------------------------------------------------------
   Freeze, click two points: the distance between them. Points are kept in the image's own
   centimetres — the scan conversion is geometric, so a centimetre on the screen is one in the
   patient at any depth or probe — and a third click starts the next pair (D1, D2). Going live
   clears them, as on a machine: a measurement belongs to the frame it was made on. */
let calipers = [];                    // [{X, Y}] in image cm, pairs
let lastGeo = null, lastFr = null;
const CAL_COL = ['rgba(255,226,90,0.95)', 'rgba(110,230,255,0.95)'];
function calDistances() {
  const out = [];
  for (let p = 0; p + 1 < calipers.length; p += 2) {
    const a = calipers[p], b = calipers[p + 1];
    out.push(Math.hypot(b.X - a.X, b.Y - a.Y));
  }
  return out;
}
function drawCalipers(g, geo) {
  if (!calipers.length) return;
  const { cx, cy, scale } = geo;
  const P = (q) => [cx + q.X * scale, cy + q.Y * scale];
  g.save();
  g.lineWidth = 1.5; g.font = '12px ui-monospace, monospace';
  calipers.forEach((q, i) => {
    const [x, y] = P(q), col = CAL_COL[(i >> 1) % 2];
    g.strokeStyle = col;
    g.beginPath(); g.moveTo(x - 6, y); g.lineTo(x + 6, y); g.moveTo(x, y - 6); g.lineTo(x, y + 6); g.stroke();
    if (i % 2 === 1) {
      const [x0, y0] = P(calipers[i - 1]);
      g.setLineDash([4, 4]); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x, y); g.stroke(); g.setLineDash([]);
    }
  });
  const d = calDistances();
  d.forEach((v, i) => { g.fillStyle = CAL_COL[i % 2]; g.fillText(`D${i + 1} ${v.toFixed(2)} cm`, 10, 20 + 16 * i); });
  g.restore();
}
/* Screen point -> image cm. The B canvas is letterboxed into whichever canvas was clicked. */
function imagePointFrom(e, cv) {
  if (!lastGeo || !usCanvas || U.disp !== 'b') return null;
  const r = cv.getBoundingClientRect();
  const px = (e.clientX - r.left) * cv.width / r.width, py = (e.clientY - r.top) * cv.height / r.height;
  const s = Math.min(cv.width / usCanvas.width, cv.height / usCanvas.height);
  const ox = (cv.width - usCanvas.width * s) / 2, oy = (cv.height - usCanvas.height * s) / 2;
  const bx = (px - ox) / s, by = (py - oy) / s;
  if (bx < 0 || by < 0 || bx > lastGeo.W || by > lastGeo.H) return null;
  return { X: (bx - lastGeo.cx) / lastGeo.scale, Y: (by - lastGeo.cy) / lastGeo.scale };
}
function caliperClick(e, cv) {
  if (ctx.S.mode !== 'us') return;
  if (U.live) { setStatus('Freeze first — calipers measure a frozen frame.'); return; }
  if (U.disp !== 'b') { setStatus('Calipers measure the B image; switch the display back to B.'); return; }
  const q = imagePointFrom(e, cv);
  if (!q) return;
  if (calipers.length >= 4) calipers = [];
  calipers.push(q);
  if (lastFr) render(lastFr, false);
  const d = calDistances();
  const el = $('usCalV');
  if (el) el.textContent = d.length ? d.map((v, i) => `D${i + 1} ${v.toFixed(2)} cm`).join(' · ') : 'first point set';
}
function clearCalipers() {
  calipers = [];
  const el = $('usCalV'); if (el) el.textContent = '—';
  if (lastFr) render(lastFr, false);
}

/* ---- exam presets ----------------------------------------------------------
   What a sonographer selects before touching anything else: the probe and a starting point for
   frequency, depth, focus, gain and dynamic range that suits the region. Starting points, not
   answers — the depth still wants setting to the organ, and the focus to the lesion. */
export const PRESETS = {
  abdomen:  { probe: 'curvi',  freq: 3.5, depth: 16, focus: 8, gain: 0, range: 55, label: 'Abdomen' },
  renal:    { probe: 'curvi',  freq: 4.0, depth: 14, focus: 8, gain: 2, range: 55, label: 'Renal' },
  aorta:    { probe: 'curvi',  freq: 3.0, depth: 18, focus: 11, gain: 2, range: 50, label: 'Aorta' },
  small:    { probe: 'linear', freq: 12, depth: 4, focus: 2, gain: 0, range: 60, label: 'Small parts' },
  vascular: { probe: 'linear', freq: 7.5, depth: 5, focus: 3, gain: 2, range: 55, label: 'Vascular' },
  msk:      { probe: 'linear', freq: 12, depth: 4, focus: 2, gain: 0, range: 65, label: 'MSK' },
};
function applyPreset(key) {
  const p = PRESETS[key]; if (!p) return;
  Object.assign(U, { probe: p.probe, freq: p.freq, depth: p.depth, focus: p.focus, gain: p.gain, range: p.range });
  document.querySelectorAll('#usProbeSeg button').forEach((x) => x.classList.toggle('on', x.dataset.probe === p.probe));
  document.querySelectorAll('#usPresetSeg button').forEach((x) => x.classList.toggle('on', x.dataset.preset === key));
  ['usFreq:freq', 'usDepth:depth', 'usFocus:focus', 'usGain:gain', 'usRange:range'].forEach((q) => {
    const [id, k] = q.split(':'); const el = $(id); if (el) el.value = U[k];
  });
  calipers = [];
  renderReadouts(); mReset(); sReset(); rescan(); usSyncScene();
  setStatus(`${p.label} preset — ${p.probe === 'linear' ? 'linear' : 'curvilinear'} ${p.freq} MHz, depth ${p.depth} cm, focus ${p.focus} cm.`);
}

/* ---- M-mode ----------------------------------------------------------------
   One scanline, plotted against TIME. Depth runs down, seconds run right, and an
   interface that moves toward the probe draws a line that climbs — which is the whole
   measurement: wall excursion in centimetres, and a period you can put a stopwatch on.

   The trace carries a real time axis, not a frame counter: columns are appended at
   MCOLS/M_SEC per second whatever the frame rate does, so a dropped frame stretches
   nothing. Grey is written once, when the column is swept, exactly as a machine writes
   it — turn the TGC afterwards and only the new columns change.

   (A real machine's M-mode fires its one line at ~1 kHz, far faster than any B frame.
   Ours resolves the sweep rate, ~50 Hz — well above wall motion, short of valve flutter.) */
const MCOLS = 384, M_SEC = 6.0;
let mCanvas = null, mCol1 = null, mHead = 0, mCarry = 0, mLastT = 0;
function mReset() {
  mHead = 0; mCarry = 0; mLastT = 0;
  if (mCanvas) { const g = mCanvas.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, MCOLS, NSAMP); }
}
function appendM(env, tgcLut) {
  if (!mCanvas) {
    mCanvas = document.createElement('canvas'); mCanvas.width = MCOLS; mCanvas.height = NSAMP;
    const g0 = mCanvas.getContext('2d'); g0.fillStyle = '#000'; g0.fillRect(0, 0, MCOLS, NSAMP);
  }
  const g = mCanvas.getContext('2d');
  if (!mCol1) mCol1 = g.createImageData(1, NSAMP);
  const now = performance.now() / 1000;
  const dt = mLastT ? Math.min(now - mLastT, 0.4) : 1 / 50;
  mLastT = now;
  mCarry += dt * (MCOLS / M_SEC);
  let n = mCarry | 0; mCarry -= n;
  if (n <= 0) return;
  if (n > 48) n = 48;                                   // a backgrounded tab, not a sweep
  const li = Math.round(U.mLine * (NLINE - 1)), dr = U.range;
  for (let k = 0; k < NSAMP; k++) {
    const v = greyOf(env[li * NSAMP + k], k, tgcLut, dr);
    const o = k * 4;
    mCol1.data[o] = mCol1.data[o + 1] = mCol1.data[o + 2] = v;
    mCol1.data[o + 3] = 255;
  }
  for (let i = 0; i < n; i++) { g.putImageData(mCol1, mHead, 0); mHead = (mHead + 1) % MCOLS; }
}
/* B on top with the cursor drawn through it, trace below — the split screen every
   machine shows, because an M trace means nothing without knowing what it cut. */
function drawMScreen(g, geo, fr) {
  // The M screen is TALLER than the B screen rather than a squeezed version of it: the
  // fan keeps its full size and the trace is added beneath, because a trace you have to
  // squint at measures nothing.
  const W = usCanvas.width, H = usCanvas.height, TOP = geo.H;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const s = TOP / geo.H;
  g.drawImage(bCanvas, (W - geo.W * s) / 2, 0, geo.W * s, TOP);
  const { sector, R0, depth, apert } = fr;
  const ox = (W - geo.W * s) / 2;
  g.strokeStyle = 'rgba(255,220,90,0.85)'; g.lineWidth = 1; g.setLineDash([5, 4]);
  g.beginPath();
  if (sector) {
    const th = (U.mLine - 0.5) * sector;
    const sx = Math.sin(th), sy = Math.cos(th);
    g.moveTo(ox + (geo.cx + sx * R0 * geo.scale) * s, (geo.cy + sy * R0 * geo.scale) * s);
    g.lineTo(ox + (geo.cx + sx * (R0 + depth) * geo.scale) * s, (geo.cy + sy * (R0 + depth) * geo.scale) * s);
  } else {
    const X = (U.mLine - 0.5) * apert;
    g.moveTo(ox + (geo.cx + X * geo.scale) * s, geo.cy * s);
    g.lineTo(ox + (geo.cx + X * geo.scale) * s, (geo.cy + depth * geo.scale) * s);
  }
  g.stroke(); g.setLineDash([]);
  // the trace, oldest column first so the newest is always at the right edge
  if (mCanvas) {
    const th2 = H - TOP - 2, y0 = TOP + 2, tail = MCOLS - mHead;
    g.imageSmoothingEnabled = false;
    g.drawImage(mCanvas, mHead, 0, tail, NSAMP, 0, y0, W * tail / MCOLS, th2);
    if (mHead > 0) g.drawImage(mCanvas, 0, 0, mHead, NSAMP, W * tail / MCOLS, y0, W * mHead / MCOLS, th2);
    g.imageSmoothingEnabled = true;
    // one gridline per second: the axis that turns "it wobbles" into a heart rate
    g.strokeStyle = 'rgba(120,220,255,0.30)'; g.lineWidth = 1;
    for (let t = 1; t < M_SEC; t++) {
      const x = Math.round(W * (1 - t / M_SEC)) + 0.5;
      g.beginPath(); g.moveTo(x, y0); g.lineTo(x, H); g.stroke();
    }
    g.fillStyle = 'rgba(150,230,255,0.75)'; g.font = '11px ui-monospace, monospace';
    g.fillText('1 s', W - Math.round(W / M_SEC) + 4, H - 6);
  }
}

/* ---- SPECTRAL DOPPLER (PW) ----------------------------------------------------
   Shift against time: one column per spectral line, shift up the screen (toward the probe
   above the baseline), grey for power — exactly the M trace's bookkeeping, a real time axis and
   grey written once when the column is swept. The axis is labelled in ANGLE-CORRECTED cm/s,
   as a machine labels it once the cursor is set, which is why turning the angle cursor
   rescales the axis and not the trace: the machine measured a shift, and the angle is only
   the operator's claim about what that shift means. */
const SCOLS = 512, NBIN = 128, PW_DR = 42;
let sCanvas = null, sCol1 = null, sHead = 0, sCarry = 0, sLastT = 0, sRows = new Array(SCOLS).fill(null), sPrevPh = -1;
const SPEC = new Float64Array(NBIN), SCOMP = new Float64Array(3 * NSC), WK = new Float64Array(8), RF = new Float64Array(4);
const REGION = ['', 'abdo', 'thorax', 'portal'];
function sReset() {
  sHead = 0; sCarry = 0; sLastT = 0; sPrevPh = -1; sRows = new Array(SCOLS).fill(null);
  if (sCanvas) { const g = sCanvas.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, SCOLS, NBIN); }
}
function appendSpectrum() {
  const pw = pwSet; if (!pw) return;
  if (!sCanvas) {
    sCanvas = document.createElement('canvas'); sCanvas.width = SCOLS; sCanvas.height = NBIN;
    const g0 = sCanvas.getContext('2d'); g0.fillStyle = '#000'; g0.fillRect(0, 0, SCOLS, NBIN);
  }
  const g = sCanvas.getContext('2d');
  if (!sCol1) sCol1 = g.createImageData(1, NBIN);
  const now = performance.now() / 1000;
  const dt = sLastT ? Math.min(now - sLastT, 0.5) : 1 / 50;
  sLastT = now;
  sCarry += dt * SCOLS / U.pwSweep;
  let n = sCarry | 0; sCarry -= n;
  if (n <= 0) return;
  if (n > 96) n = 96;
  const colDt = U.pwSweep / SCOLS, T = 60 / U.hr;
  // the receiver's noise, spread white across the analysis bins: a tone puts all its power in
  // one or two of them and the noise is shared by all NBIN — the FFT's processing gain, which is
  // why PW hears deeper and fainter flow than an 8-pulse colour ensemble can
  const noiseP = NOISE_D * NOISE_D / NBIN;
  for (let j = 0; j < n; j++) {
    const tau = (n - 1 - j) * colDt;              // how long ago this column's line was fired
    const ph = U.lockCard != null ? U.lockCard : (((cardPhase - tau * U.hr / 60) % 1) + 1) % 1;
    const br = U.hold ? brPhase : (((brPhase - tau / 4.3) % 1) + 1) % 1, insp = breathAmp(br);
    for (let q = 0; q < WAVE_KINDS.length; q++) WK[q + 1] = flowWave(WAVE_KINDS[q], ph * T, T);
    for (let q = 0; q < 4; q++) RF[q] = respFactor(REGION[q], insp);
    let nc = 0;
    for (let i = 0; i < NSC; i++) {
      const a = pw.amp[i]; if (!a) continue;
      const v = pw.kind[i] ? pw.spd[i] * WK[pw.kind[i]] * RF[pw.rg[i]] * pw.cosE[i] : pw.vT[i];
      SCOMP[3 * nc] = a; SCOMP[3 * nc + 1] = dopplerShift(pw.f0, v / 100, 0); nc++;
    }
    spectrumColumn(SPEC, SCOMP, nc, pw.prf, U.pwBase, U.pwWall, noiseP, rnd);
    const env = maxEnvelope(SPEC, pw.prf, U.pwBase, noiseP);
    const wrap = sPrevPh >= 0 && ph < sPrevPh - 0.5;  // the ECG trigger: a new beat began
    sPrevPh = ph;
    sRows[sHead] = { pos: env.pos, neg: env.neg, wrap, prf: pw.prf };
    for (let i = 0; i < NBIN; i++) {
      const db = 10 * Math.log10(SPEC[i] / noiseP + 1e-9) + U.pwGain - 4;
      const v = Math.pow(Math.max(0, Math.min(1, db / PW_DR)), 0.8) * 255;
      const o = (NBIN - 1 - i) * 4;
      sCol1.data[o] = sCol1.data[o + 1] = sCol1.data[o + 2] = v; sCol1.data[o + 3] = 255;
    }
    g.putImageData(sCol1, sHead, 0);
    sHead = (sHead + 1) % SCOLS;
  }
}
/* The swept rows oldest-first, and the measurements made on them, in angle-corrected cm/s. */
function sweptRows() { return [...sRows.slice(sHead), ...sRows.slice(0, sHead)].filter(Boolean); }
function pwVelScale(pw) {
  const a = Math.min(89, Math.abs(U.pwAngle || 0)) * Math.PI / 180;
  return velocityFromShift(1, pw.f0, a) * 100;            // cm/s per Hz of shift
}
function pwMeasures() {
  const pw = pwSet; if (!pw) return null;
  const m = peakMeasures(sweptRows());
  if (!m) return null;
  const k = pwVelScale(pw);
  return { psv: m.psv * k, edv: m.edv * k, ri: m.ri, tamax: m.tamax * k, dir: m.dir, fpk: m.psv };
}
function drawPWScreen(g, geo) {
  const W = usCanvas.width, H = usCanvas.height, TOP = geo.H, pw = pwSet;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  g.drawImage(bCanvas, (W - geo.W) / 2, 0);
  if (!sCanvas || !pw) return;
  const y0 = TOP + 2, h2 = H - TOP - 2, tail = SCOLS - sHead, wS = W - 46;
  g.imageSmoothingEnabled = true;
  // invert is a display flip, so it works on a frozen trace as well as a live one
  g.save();
  if (U.pwInv) { g.translate(0, 2 * y0 + h2); g.scale(1, -1); }
  g.drawImage(sCanvas, sHead, 0, tail, NBIN, 0, y0, wS * tail / SCOLS, h2);
  if (sHead > 0) g.drawImage(sCanvas, 0, 0, sHead, NBIN, wS * tail / SCOLS, y0, wS * sHead / SCOLS, h2);
  g.restore();
  // the baseline, where the baseline knob put it
  const b = U.pwBase;
  const yOfF = (f) => { const u = (f + (pw.prf / 2) * (1 - b)) / pw.prf; return y0 + h2 * (U.pwInv ? u : 1 - u); };
  g.strokeStyle = 'rgba(150,220,255,0.7)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, yOfF(0) + 0.5); g.lineTo(wS, yOfF(0) + 0.5); g.stroke();
  // the velocity axis, angle-corrected, on the right
  const k = pwVelScale(pw), vHi = pw.prf / 2 * (1 + b) * k, vLo = pw.prf / 2 * (1 - b) * k;
  const span = vHi + vLo, step = [5, 10, 20, 25, 50, 100, 200, 250, 500].find((s) => span / s <= 7) || 1000;
  g.fillStyle = 'rgba(170,225,255,0.85)'; g.font = '11px ui-monospace, monospace'; g.textAlign = 'right';
  for (let v = -Math.floor(vLo / step) * step; v <= vHi; v += step) {
    const y = yOfF(v / k);
    g.fillRect(wS, y, 5, 1);
    g.fillText(String(v), W - 2, y + 4);
  }
  g.fillText('cm/s', W - 2, y0 + h2 - 4);
  g.textAlign = 'left';
  // one gridline per second, as on the M trace
  g.strokeStyle = 'rgba(120,220,255,0.22)';
  for (let t = 1; t < U.pwSweep; t++) {
    const x = Math.round(wS * (1 - t / U.pwSweep)) + 0.5;
    g.beginPath(); g.moveTo(x, y0); g.lineTo(x, H); g.stroke();
  }
  // the auto-trace: the maximum-velocity envelope on the flow's own side
  const rows = sweptRows(), m = pwMeasures(), side = m ? m.dir : (pw.towardSign || 1);
  g.strokeStyle = 'rgba(120,255,160,0.85)'; g.lineWidth = 1.2; g.beginPath();
  rows.forEach((r, i) => {
    const f = side > 0 ? (r.pos || r.neg) : (r.neg || r.pos), x = wS * (SCOLS - rows.length + i + 0.5) / SCOLS;
    if (i) g.lineTo(x, yOfF(f)); else g.moveTo(x, yOfF(f));
  });
  g.stroke();
  // the readout block a sonographer reads off the screen
  g.fillStyle = 'rgba(230,245,255,0.95)'; g.font = '12px ui-monospace, monospace';
  const ang = Math.abs(U.pwAngle || 0);
  const l1 = m ? `PSV ${m.psv.toFixed(0)}  EDV ${m.edv.toFixed(0)} cm/s  RI ${m.ri.toFixed(2)}` : 'PSV —  (sweeping a whole beat…)';
  g.fillText(l1, 6, y0 + 15);
  g.fillStyle = ang > 60 ? 'rgba(255,180,90,0.95)' : 'rgba(190,225,240,0.9)';
  g.fillText(`∠ ${ang.toFixed(0)}°${ang > 60 ? ' > 60°: angle error grows fast' : ''}`, 6, y0 + 30);
  g.fillStyle = 'rgba(190,225,240,0.8)';
  g.fillText(`PRF ${(pw.prf / 1000).toFixed(1)} kHz${pw.prf < U.pwPrf ? ' (depth limit)' : ''} · gate ${U.pwGate} mm @ ${pw.d.toFixed(1)} cm`, 6, y0 + 45);
}

function render(fr, fresh = true) {
  const film = $('film'); if (!film || !fr) return;
  const env = envelope(fr);
  const { depth, freq, ds } = fr;
  const tgcLut = buildTgc(freq, ds);
  const geo = drawFan(env, fr, tgcLut);
  if (!usCanvas) { usCanvas = document.createElement('canvas'); usCanvas.width = 512; }
  const wantH = U.disp === 'b' ? 512 : 768;
  if (usCanvas.height !== wantH) usCanvas.height = wantH;
  const g = usCanvas.getContext('2d');
  if (U.disp === 'm') { if (fresh) appendM(env, tgcLut); drawMScreen(g, geo, fr); }
  else if (U.disp === 'pw') { if (fresh) appendSpectrum(); drawPWScreen(g, geo); }
  else { g.drawImage(bCanvas, 0, 0); }
  const W = usCanvas.width, H = usCanvas.height;
  const f2 = film.getContext('2d');
  if (film.width !== 330) { film.width = 330; film.height = 440; }
  f2.fillStyle = '#000'; f2.fillRect(0, 0, film.width, film.height);
  const s = Math.min(film.width / W, film.height / H);
  f2.imageSmoothingEnabled = true;
  f2.drawImage(usCanvas, (film.width - W * s) / 2, (film.height - H * s) / 2, W * s, H * s);
  $('noexp')?.style.setProperty('display', 'none');
  if (ctx.S.bayContent === 'image') usImageToBay();
  const tl = $('fnTL'); if (tl) tl.textContent = `US ${freq.toFixed(1)} MHz` + (U.disp === 'm' ? ' · M' : U.disp === 'pw' ? ' · PW' : '');
  const br = $('fnBR'); if (br) br.textContent = `D ${depth.toFixed(0)} cm · G ${U.gain} dB`;
}
export function usImageToBay() {
  const bf = $('bigFilm');
  if (!bf || !usCanvas) return false;
  const w = bf.clientWidth || 800, h = bf.clientHeight || 600;
  if (bf.width !== w || bf.height !== h) { bf.width = w; bf.height = h; }
  const g = bf.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  const s = Math.min(w / usCanvas.width, h / usCanvas.height);
  g.imageSmoothingEnabled = true;
  g.drawImage(usCanvas, (w - usCanvas.width * s) / 2, (h - usCanvas.height * s) / 2,
    usCanvas.width * s, usCanvas.height * s);
  return true;
}

/* ---- the loop -------------------------------------------------------------- */
let liveTimer = null;
function sweep() {
  const fr = scanFrame();
  if (fr) { lastFr = fr; render(fr); dopReadouts(fr); }
  // M-mode fires ONE line per column, so its budget is one round trip, not a whole frame
  const acq = U.disp === 'm' ? lastAcqMs / NLINE : lastAcqMs;
  const fps = 1000 / Math.max(acq, lastMs, 1);
  if (performance.now() >= noteUntil) setStatus(`${fps.toFixed(0)} fps · ${acq.toFixed(0)} ms acoustic · ${lastMs.toFixed(0)} ms compute`
    + (U.live ? ' · LIVE' : ' · FROZEN'));
  if (U.live) {
    clearTimeout(liveTimer);
    // wait out whatever is left of the acoustic budget after the compute
    liveTimer = setTimeout(sweep, Math.max(8, acq - lastMs));
  }
}
function setLive(on) {
  U.live = on;
  if (on && calipers.length) clearCalipers();
  $('usFreeze')?.classList.toggle('on', !on);
  clearTimeout(liveTimer); liveTimer = null;
  sweep();
}
/* A FROZEN FRAME IS A RECORD: what it shows is what was measured on it. Gain, dynamic range and
   TGC are applied to the stored echoes at display time (render), so on a frozen frame they act
   on that frame and leave its calipers where they are, as post-processing does on a machine.
   Everything else changes what is ACQUIRED (the probe, where it sits, frequency, depth, focus,
   colour, motion, the M line) and cannot apply to a frame already taken, so it unfreezes. It used
   to re-scan under the FROZEN label, which put the calipers from the old frame on new anatomy. */
function redisplay() { if (U.live) return; if (lastFr) render(lastFr, false); }
let noteUntil = 0;                    // a message the live loop's frame-rate line must not overwrite at once
function unfreeze() {
  if (U.live) return;
  setLive(true);
  setStatus('Live again — that control changes what is scanned, so the frozen frame and its measurements are gone.');
  noteUntil = performance.now() + 3500;
}
/* an immediate frame for a control that moves a lot at once (probe, preset, window) */
function rescan() { if (U.live) sweep(); else unfreeze(); }
const DISPLAY_KEYS = new Set(['gain', 'range', 'cBase', 'cPri', 'pwAngle', 'pwGain']);
function setStatus(t) { const el = $('usStatus'); if (el) el.textContent = t; }
function renderReadouts() {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('usFreqV', U.freq.toFixed(1) + ' MHz');
  set('usDepthV', U.depth.toFixed(0) + ' cm');
  set('usGainV', U.gain + ' dB');
  set('usFocusV', U.focus.toFixed(0) + ' cm');
  set('usRotV', U.rot + '°');
  set('usTiltV', U.tilt + '°');
  set('usRangeV', U.range + ' dB');
  set('usHrV', U.hr + ' bpm');
  set('usPrfV', (U.prf / 1000).toFixed(1) + ' kHz');
  set('usSteerV', U.probe === 'linear' ? U.steer + '°' : 'linear only');
  set('usCGainV', (U.cGain > 0 ? '+' : '') + U.cGain + ' dB');
  set('usCWallV', U.cWall + ' Hz');
  set('usCPriV', U.cPri + ' %');
  set('usCBaseV', U.cBase === 0 ? 'centre' : (U.cBase > 0 ? '▼ ' : '▲ ') + Math.abs(U.cBase * 100).toFixed(0) + ' %');
  set('usPwDepthV', U.pwDepth.toFixed(1) + ' cm');
  set('usPwGateV', U.pwGate + ' mm');
  set('usPwAngleV', U.pwAngle + '°');
  set('usPwPrfV', (U.pwPrf / 1000).toFixed(1) + ' kHz');
  set('usPwBaseV', U.pwBase === 0 ? 'centre' : (U.pwBase > 0 ? '▼ ' : '▲ ') + Math.abs(U.pwBase * 100).toFixed(0) + ' %');
  set('usPwWallV', U.pwWall + ' Hz');
  set('usPwGainV', (U.pwGain > 0 ? '+' : '') + U.pwGain + ' dB');
  $('usPwAngleV')?.classList.toggle('warn', Math.abs(U.pwAngle) > 60);
  $('usCInv')?.classList.toggle('on', !!U.cInv);
  $('usPwInv')?.classList.toggle('on', !!U.pwInv);
  document.querySelectorAll('#usPwSweepSeg button').forEach((x) => x.classList.toggle('on', +x.dataset.sweep === U.pwSweep));
  $('usDop')?.classList.toggle('on', U.dop);
  $('usHold')?.classList.toggle('on', U.hold);
  $('usMotion')?.classList.toggle('on', !U.motion);
}
/* What the PRF actually is, and why. The knob asks; the depth decides (PRF_max = c/2d), and a
   readout that showed the asked-for value would hide the very limit the lesson is about. */
function dopReadouts(fr) {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  const c = fr.col;
  if (c) {
    const dBot = (c.k1 + 1) * fr.ds;
    set('usDopRead', `scale ±${c.vNyq.toFixed(c.vNyq < 10 ? 1 : 0)} cm/s along the beam · PRF ${(c.prf / 1000).toFixed(1)} kHz`
      + (c.prf < U.prf ? ` — capped by depth: c/2d = ${(c.prfLim / 1000).toFixed(1)} kHz for a box reaching ${dBot.toFixed(1)} cm`
        : ` (ceiling ${(c.prfLim / 1000).toFixed(1)} kHz at ${dBot.toFixed(1)} cm)`));
  } else set('usDopRead', U.dop ? 'arming…' : '—');
  const pw = fr.pw;
  if (pw) {
    const m = pwMeasures(), ang = Math.abs(U.pwAngle || 0);
    set('usPwRead', m ? `PSV ${m.psv.toFixed(0)} · EDV ${m.edv.toFixed(0)} cm/s · RI ${m.ri.toFixed(2)} · peak shift ${(m.fpk / 1000).toFixed(2)} kHz`
      : 'sweeping — the measurements need one whole beat');
    set('usPwPrfRead', `PRF ${(pw.prf / 1000).toFixed(1)} kHz` + (pw.prf < U.pwPrf
      ? ` — capped by depth: c/2d = ${(pw.prfLim / 1000).toFixed(1)} kHz at ${(pw.d + pw.g / 2).toFixed(1)} cm` : ` (ceiling ${(pw.prfLim / 1000).toFixed(1)} kHz)`)
      + ` · scale ±${(pw.prf / 2 * pwVelScale(pw)).toFixed(0)} cm/s at ${ang}°`);
    set('usPwTruth', pw.trueAngle == null ? 'gate is not in a vessel'
      : `${(pw.inVessel * 100).toFixed(0)} % of the gate in a vessel · the flow meets the beam at ${pw.trueAngle.toFixed(0)}° `
        + `— cursor ${ang}°, so the reading is ${((Math.cos(pw.trueAngle * Math.PI / 180) / Math.cos(Math.min(89, ang) * Math.PI / 180) - 1) * 100).toFixed(0)} % off by angle alone`);
  } else { set('usPwRead', '—'); set('usPwPrfRead', '—'); set('usPwTruth', '—'); }
}

/* ---- the rig: a probe on the skin + the plane it images ---------------------
   The fan drawn in the room is the SAME sector the scan marches, rebuilt from the
   same numbers — so what the learner sees hovering in the patient is literally the
   picture on the monitor, stood up in space. */
let rig = null, probeMesh = null, fanMesh = null, probeGrab = null;
function buildRig() {
  const { THREE, three } = ctx;
  rig = new THREE.Group();
  probeMesh = new THREE.Mesh(new THREE.BoxGeometry(5.0, 8, 2.4),
    new THREE.MeshStandardMaterial({ color: 0xe6ecf2, roughness: 0.45 }));
  probeMesh.position.y = 4;
  rig.add(probeMesh);
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 6, 8),
    new THREE.MeshStandardMaterial({ color: 0x2a3138, roughness: 0.9 }));
  cable.position.y = 10.5;
  rig.add(cable);
  // an invisible, generous grab volume — picking a thin probe with a mouse is a
  // hit-test problem, not a teaching one
  probeGrab = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 10),
    new THREE.MeshBasicMaterial({ visible: false }));
  probeGrab.position.y = 4;
  rig.add(probeGrab);
  // the plane is drawn THROUGH the patient: the whole point of showing it is to say
  // where the picture on the monitor comes from, and the skin is in the way
  fanMesh = new THREE.Mesh(new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: 0x4fd1e0, transparent: true, opacity: 0.22,
      side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
  fanMesh.renderOrder = 3;
  rig.add(fanMesh);
  rig.visible = false;
  three.handGroup.parent.add(rig);
}
/* Rebuild the fan outline in the probe's LOCAL frame (x lateral, y up, origin at the
   contact point); the group's own rotation then carries it to the scan plane. */
function buildFanGeometry() {
  const { THREE } = ctx;
  const lin = U.probe === 'linear';
  const R0 = lin ? 0 : 6, sector = lin ? 0 : 1.05, apert = lin ? 4 : 0;
  const tilt = U.tilt * Math.PI / 180, d = U.depth;
  const pos = [];
  if (lin) {
    const a = apert / 2, sx = Math.sin(tilt), sy = -Math.cos(tilt);
    const c = [[-a, 0], [a, 0]].map(([x, y]) => [x, y]);
    const far = c.map(([x, y]) => [x + sx * d, y + sy * d]);
    pos.push(...c[0], 0, ...c[1], 0, ...far[1], 0, ...c[0], 0, ...far[1], 0, ...far[0], 0);
  } else {
    const N = 24;
    for (let i = 0; i < N; i++) {
      const t0 = sector * (i / N - 0.5) + tilt, t1 = sector * ((i + 1) / N - 0.5) + tilt;
      // the apex sits at local (0, R0); a point at angle th, radius r is apex + dir*r
      const q = (th, r) => [Math.sin(th) * r, R0 - Math.cos(th) * r, 0];
      const a0 = q(t0, R0), a1 = q(t1, R0), b0 = q(t0, R0 + d), b1 = q(t1, R0 + d);
      pos.push(...a0, ...a1, ...b1, ...a0, ...b1, ...b0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  fanMesh.geometry.dispose();
  fanMesh.geometry = g;
}
export function usSyncScene() {
  if (!ctx || !rig) return;
  const { S, three } = ctx;
  const on = S.mode === 'us';
  rig.visible = on;
  if (!on) return;
  if (three.tube) three.tube.visible = false;
  if (three.lamp) three.lamp.intensity = 0;
  if (three.cr) three.cr.visible = false;
  if (three.det) three.det.visible = false;
  if (three.detMarks) three.detMarks.visible = false;
  if (three.detArrow) three.detArrow.visible = false;
  if (three.aecGroup) three.aecGroup.visible = false;
  if (vol !== (ctx.S.voxelModel && ctx.S.voxelModel.data)) bindVolume();
  if (!vol) return;
  // the room centres the volume on x/z with its base at y = 0, so anatomy (x, y, z)
  // sits at world (x - ex/2, y, z - ez/2)
  const px = vex * U.px, pz = vez * U.pz, py = contactPoint(px, pz);
  rig.position.set(px - vex / 2, py, pz - vez / 2);
  rig.rotation.set(0, -U.rot * Math.PI / 180, 0);
  buildFanGeometry();
}

/* ---- grab the probe and slide it over the patient ---------------------------
   Returns true when the gesture belongs to the probe, so the bay's orbit stays out
   of the way. Dragging moves it across the skin in x/z; the surface march re-seats
   it in depth every frame, so it follows the body's own contour. */
let dragging = false, ray = null, plane = null, hit = null, dragY = 0;
export function usPointer(e, phase, cam, canvas) {
  if (!ctx || !rig || !rig.visible) return false;
  const { THREE } = ctx;
  if (!ray) { ray = new THREE.Raycaster(); plane = new THREE.Plane(); hit = new THREE.Vector3(); }
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, cam);
  if (phase === 'down') {
    dragging = ray.intersectObject(probeGrab, false).length > 0;
    dragY = rig.position.y;      // pinned for the whole gesture, see below
    return dragging;
  }
  if (phase === 'up') { const was = dragging; dragging = false; return was; }
  if (!dragging) return false;
  // Slide in a horizontal plane pinned at the height the grab STARTED at. Re-deriving it
  // from the current contact each frame fed the probe's own descent back into the
  // pointer mapping, so climbing onto the ribs would pull the seat out from under the
  // cursor. One plane per gesture, and the hand goes where you put it.
  plane.set(new THREE.Vector3(0, 1, 0), -dragY);
  if (!ray.ray.intersectPlane(plane, hit)) return true;
  U.px = Math.max(0.12, Math.min(0.88, (hit.x + vex / 2) / vex));
  U.pz = Math.max(0.10, Math.min(0.90, (hit.z + vez / 2) / vez));
  const sx = $('usPx'), sz = $('usPz');
  if (sx) sx.value = U.px; if (sz) sz.value = U.pz;
  usSyncScene();
  unfreeze();
  return true;
}

/* ---- mode + wiring --------------------------------------------------------- */
export function usApplyMode(on) {
  if (!ctx) return;
  // the monitor and the freeze move one pane left, as in fluoro — a live mode is watched,
  // not reviewed (core/paneDock.js)
  dockConsole(on, $('usScanRow'));
  if (on) {
    if (ctx.S.subject !== 'chestabdopelvis') ctx.setSubject?.('chestabdopelvis');
    renderReadouts();
    setStatus('Scanning…');
    mReset(); lastTick = 0;
    setTimeout(() => { bindVolume(); setLive(true); }, 400);
  } else {
    clearTimeout(liveTimer); liveTimer = null; U.live = false;
  }
  usSyncScene();
}

export function initUS(context) {
  ctx = context;
  U = ctx.S.us;
  buildRig();
  const slide = (id, key, after) => {
    $(id)?.addEventListener('input', (e) => {
      U[key] = parseFloat(e.target.value);
      renderReadouts();
      if (after) after();
      if (DISPLAY_KEYS.has(key)) redisplay(); else unfreeze();
      usSyncScene();
    });
  };
  slide('usFreq', 'freq'); slide('usDepth', 'depth'); slide('usGain', 'gain');
  slide('usFocus', 'focus');
  slide('usPx', 'px'); slide('usPz', 'pz');
  slide('usRot', 'rot'); slide('usTilt', 'tilt');
  $('usFreeze')?.addEventListener('click', () => setLive(!U.live));
  // the TGC column: six display-side gains, and the button that undoes a bad set
  for (let i = 0; i < 6; i++) {
    $('usTgc' + i)?.addEventListener('input', (e) => {
      U.tgcBands[i] = +e.target.value;
      redisplay();
    });
  }
  $('usTgcReset')?.addEventListener('click', () => {
    U.tgcBands = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6; i++) { const el = $('usTgc' + i); if (el) el.value = 0; }
    redisplay();
    setStatus('TGC centred.');
  });
  slide('usRange', 'range');
  // ---- colour Doppler ----
  $('usDop')?.addEventListener('click', () => {
    U.dop = !U.dop;
    $('usDop').classList.toggle('on', U.dop);
    if (U.dop) ensureSVol();
    unfreeze();
    setStatus(U.dop ? 'Colour box on — and it costs frame rate, as it should.' : 'Colour off.');
  });
  slide('usPrf', 'prf'); slide('usDopY', 'dopY'); slide('usDopH', 'dopH'); slide('usDopW', 'dopW');
  slide('usDopX', 'dopX'); slide('usSteer', 'steer');
  slide('usCGain', 'cGain'); slide('usCWall', 'cWall'); slide('usCBase', 'cBase'); slide('usCPri', 'cPri');
  $('usCInv')?.addEventListener('click', () => { U.cInv = !U.cInv; renderReadouts(); redisplay(); });
  // ---- spectral (PW) Doppler ----
  // the stored trace is in the old window once the PRF or baseline moves, so the sweep restarts
  slide('usPwLine', 'pwLine'); slide('usPwDepth', 'pwDepth'); slide('usPwGate', 'pwGate');
  slide('usPwAngle', 'pwAngle'); slide('usPwPrf', 'pwPrf', sReset); slide('usPwBase', 'pwBase', sReset);
  slide('usPwWall', 'pwWall'); slide('usPwGain', 'pwGain');
  $('usPwInv')?.addEventListener('click', () => { U.pwInv = !U.pwInv; renderReadouts(); redisplay(); });
  document.querySelectorAll('#usPwSweepSeg button').forEach((b) => b.addEventListener('click', () => {
    U.pwSweep = +b.dataset.sweep; sReset(); renderReadouts();
  }));
  $('usAorta')?.addEventListener('click', seatAorta);
  // ---- motion + M-mode ----
  slide('usMLine', 'mLine');
  $('usHr')?.addEventListener('input', (e) => {
    U.hr = +e.target.value;
    const el = $('usHrV'); if (el) el.textContent = U.hr + ' bpm';
  });
  $('usHold')?.addEventListener('click', () => {
    U.hold = !U.hold;
    $('usHold').classList.toggle('on', U.hold);
    setStatus(U.hold ? 'Breath held — the dome stops, the heart does not.' : 'Breathing.');
  });
  $('usMotion')?.addEventListener('click', () => {
    U.motion = !U.motion;
    $('usMotion').classList.toggle('on', !U.motion);
    setStatus(U.motion ? 'Motion on.' : 'Motion off — a still patient.');
    unfreeze();
  });
  document.querySelectorAll('#usDispSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      U.disp = b.dataset.disp;
      document.querySelectorAll('#usDispSeg button').forEach((x) => x.classList.toggle('on', x === b));
      mReset(); sReset();
      // M-mode is one line, so it can afford a faster sweep than a whole frame can. A trace is
      // recorded over time, so M and PW start live; back to B on a frozen frame shows that frame.
      if (U.live || U.disp !== 'b') setLive(true); else redisplay();
    });
  });
  // The cardiac seat was surveyed, not guessed: from below the costal margin, angled up
  // through the liver, is the one window into this subject's heart that ribs and lung do
  // not close. See docs/ultrasound.md §4.2.
  // calipers on whichever screen is clicked: the console monitor or the bay's big view
  for (const id of ['film', 'bigFilm']) $(id)?.addEventListener('click', (e) => caliperClick(e, $(id)));
  $('usCalClear')?.addEventListener('click', clearCalipers);
  document.querySelectorAll('#usPresetSeg button').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
  $('usCardiac')?.addEventListener('click', () => {
    Object.assign(U, CARDIAC_SEAT);
    ['usPx:px', 'usPz:pz', 'usRot:rot', 'usTilt:tilt', 'usDepth:depth', 'usFocus:focus']
      .forEach((p) => { const [id, k] = p.split(':'); const el = $(id); if (el) el.value = U[k]; });
    renderReadouts(); mReset(); rescan(); usSyncScene();
    setStatus('Subcostal window — the heart is up and to the left of the fan.');
  });
  document.querySelectorAll('#usProbeSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      U.probe = b.dataset.probe;
      document.querySelectorAll('#usProbeSeg button').forEach((x) => x.classList.toggle('on', x === b));
      // a linear probe is a superficial probe: its defaults come with it
      if (U.probe === 'linear') { U.freq = 10; U.depth = 5; U.focus = 2.5; }
      else { U.freq = 3.5; U.depth = 16; U.focus = 8; }
      ['usFreq:freq', 'usDepth:depth', 'usFocus:focus'].forEach((p) => {
        const [id, k] = p.split(':'); const el = $(id); if (el) el.value = U[k];
      });
      renderReadouts(); sReset(); rescan(); usSyncScene();
    });
  });
  if (typeof window !== 'undefined') window.__usProbe = () => ({
    U, lastMs, lastEcho, scanFrame, envelope, anim, WST, mReset,
    bind: bindVolume, vdims: () => ({ vnx, vny, vnz, vsx, vsy, vsz, vex, vey, vez }),
    idAt, buildTgc, greyOf, NLINE, NSAMP, mCanvas: () => mCanvas,
    contact: (x, z) => { cpKey = ''; return contactPoint(x, z); }, surfaceAt, GEL_PAD,
    sVol: () => sVol, ensureSVol, flowDir, GD, VESSEL, ENS, chordProfile, lumenFactor,
    pwSet: () => pwSet, tissueToward, wst: () => [WST, WST2], BV, phases: () => ({ cardPhase, brPhase }), sweptRows, pwMeasures, sReset, probeFrame, lineGeom, seatAorta, aimGate, pwFrame, AORTA_SEAT, sCanvas: () => sCanvas, sHead: () => sHead, colStats: () => lastColStats,
    setPhase: (c) => { cardPhase = c; },
    // where the probe is on screen — the hook the drag test aims at
    screenPos: () => {
      const { THREE, three } = ctx;
      const cv = three.renderer.domElement, r = cv.getBoundingClientRect();
      const v = new THREE.Vector3().copy(rig.position);
      v.y += 4;
      v.project(three.cam);
      return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
    },
  });
  renderReadouts();
}
