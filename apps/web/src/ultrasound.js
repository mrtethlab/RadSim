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
import { deriveMotion, motionState, warpPoint } from './core/anatomyMotion.js';
import { dockConsole } from './core/paneDock.js';
import { buildSVolume } from './core/contrast.js';

let ctx = null, U = null;
const $ = (id) => document.getElementById(id);

const NLINE = 192;            // scanlines per frame
const NSAMP = 512;            // samples along each line
const C_SND = 0.154;          // cm per microsecond — 1540 m/s, fixed (see the plan)
const TGC_ASSUME = 0.5;       // dB/cm/MHz the TGC assumes: the lie that makes enhancement
// Diffuse backscatter, scaled so tissue speckle sits ~40 dB under a specular bone echo —
// which is what puts liver at mid-grey and leaves room for an interface to be bright.
const SCAT = 0.09;
// Receiver amplification. A real machine's "0 dB" is not zero amplification — it is the
// system's reference, chosen so ordinary tissue lands mid-grey. Calibrated here so liver
// at working depth reads ~45 % of full scale with the gain knob centred.
const SYS_DB = 2;
// ELECTRONIC NOISE FLOOR. Without one, the TGC — which scales with frequency, as real
// TGC does — would perfectly cancel attenuation at ANY frequency, and 12 MHz would see
// as deep as 2 MHz. It cannot, because past the depth where the echo falls under the
// receiver's own noise the gain amplifies noise instead of signal, and the far field
// turns to grey mush. That floor is what makes penetration cost something.
const NOISE = 2.2e-7;

// A window onto the heart, surveyed rather than guessed (docs/ultrasound.md §4.2): seven
// candidate seats were scored on how much of the image the systolic warp actually moves,
// and this one — epigastric, sagittal, angled up under the costal margin — won at 50.6
// grey levels RMS against 0.00 for the RUQ view, which has no heart in its plane at all.
const CARDIAC_SEAT = { px: 0.50, pz: 0.52, rot: 90, tilt: 25, depth: 22, focus: 12 };

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
  if (!U.motion) return { off: true };
  // every clock pinned to one instant: a still frame AT a phase, which is not the same
  // thing as motion off (the heart is held contracted, not put back at rest)
  if (U.lockCard != null) return { br: brPhase, card: U.lockCard, peri: periT, sw: -1 };
  if (!U.hold) brPhase = (brPhase + dt / 4.3) % 1;
  cardPhase = (cardPhase + dt * U.hr / 60) % 1;
  periT += dt;
  return { br: brPhase, card: cardPhase, peri: periT, sw: -1 };
}

/* ---- COLOUR DOPPLER (docs/ultrasound.md phase E) ----------------------------
   The one thing colour Doppler actually measures is the component of velocity ALONG
   THE BEAM. Everything a sonographer knows about angle follows from that dot product,
   including the fact that a vessel crossed at 90 degrees shows NOTHING however fast
   the blood is moving — which is why the box is steered and the probe is heeled.

   The flow DIRECTION is not authored. The contrast solver already ships an arclength
   field s over the vessel tree (one uint16 per vessel voxel, increasing downstream
   from the injection site), and grad-s therefore points along the vessel. Colour
   direction is that gradient dotted with the beam. Veins carry the same tree backwards,
   so their sign is flipped — which is what puts an artery and its companion vein in
   opposite colours, the classic picture.

   ALIASING is a consequence too. A pulsed system samples the Doppler shift at the PRF,
   so it can only represent velocities under c*PRF/(4*f0); past that the estimate WRAPS,
   exactly like any other phase measurement, and the middle of the fast jet comes back
   the wrong colour. Lower the PRF and watch it start.

   And it COSTS: a colour frame fires an ensemble of pulses per line instead of one, so
   the box really does run ENS times the work over its own area. The fps readout is not
   decorated — it is measured, and it drops because the machine is doing more. */
const ENS = 8;                   // pulses per line in the colour box: a real ensemble
const F0_MHZ_REF = 1;            // v_nyq scales with 1/f0; f0 comes from the probe
// Peak systolic speeds, cm/s — textbook, rounded. Veins are steady and slow; arteries
// pulse, which is what makes the colour flash at the heart rate.
const VPEAK = { 29: 100, 30: 75, 31: 45, 32: 20, 33: 18, 34: 22, 35: 90, 36: 85, 37: 85,
  38: 80, 39: 80, 40: 18, 41: 18, 42: 25, 43: 85, 44: 85, 45: 16, 46: 16 };
// Which of them run backwards along the tree the arclength was built on.
const VENOUS = { 31: 1, 32: 1, 33: 1, 34: 1, 40: 1, 41: 1, 45: 1, 46: 1 };
const isVesselId = (id) => id >= 29 && id <= 46;

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
    if (!U.live) sweep();
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
  // ---- colour box: geometry, Nyquist velocity, and the pulsatile waveform ----
  const dopOn = !!(U.dop && sVol);
  if (U.dop) ensureSVol();
  const dl0 = Math.round((0.5 - U.dopW / 2) * (NLINE - 1)), dl1 = Math.round((0.5 + U.dopW / 2) * (NLINE - 1));
  const dk0 = Math.round((U.dopY - U.dopH / 2) * (NSAMP - 1)), dk1 = Math.round((U.dopY + U.dopH / 2) * (NSAMP - 1));
  // v_nyq = c*PRF/(4*f0): the fastest a pulsed system can represent before the phase wraps
  const vNyq = (C_SND * 1e6) * U.prf / (4 * U.freq * 1e6);
  const cph = ph && !ph.off ? (ph.card || 0) : 0.5;
  const sysWave = 0.25 + 0.75 * (cph < 0.35 ? Math.sin(Math.PI * cph / 0.35) ** 2 : 0);
  const respWave = 1 + 0.25 * Math.sin(2 * Math.PI * (ph && !ph.off ? (ph.br || 0) : 0));
  const vel = dopOn ? new Float32Array(NLINE * NSAMP) : null;
  // which vessel each colour sample came from. Not used to draw anything — it is what
  // lets a measurement ask "what did the AORTA do" instead of averaging every vessel in
  // the box together, which is how the first angle test managed to say nothing.
  const velId = dopOn ? new Uint8Array(NLINE * NSAMP) : null;
  const fseed = (t0 * 13) | 0;
  const { z: Zt, att: At, bs: Bt } = TBL;
  const depth = U.depth, freq = U.freq;
  const R0 = U.probe === 'linear' ? 0 : 6.0;          // curvilinear: virtual apex 6 cm back
  const sector = U.probe === 'linear' ? 0 : 1.05;     // ~60 degrees
  const apert = U.probe === 'linear' ? 4.0 : 0;       // linear: 4 cm of parallel lines
  const px = vex * U.px, pz = vez * U.pz;
  const py = contactPoint(px, pz);
  const ds = depth / NSAMP;
  const echo = new Float32Array(NLINE * NSAMP);
  const lamCm = C_SND / freq;                          // wavelength, cm

  // THE SCAN PLANE IS THE PROBE'S, NOT THE VOLUME'S. u is the in-plane lateral
  // direction: rot = 0 lays the fan across the patient (transverse), rot = 90 lays it
  // along them (sagittal), and anything between is the oblique a real hand produces.
  // Rocking steers the whole fan by adding to every line's angle.
  const rot = U.rot * Math.PI / 180, tilt = U.tilt * Math.PI / 180;
  const ux = Math.cos(rot), uz = Math.sin(rot);
  for (let l = 0; l < NLINE; l++) {
    const f = l / (NLINE - 1) - 0.5;
    // curvilinear lines diverge from a virtual apex R0 behind the face; linear lines
    // are parallel, offset across the aperture.
    let dx, dy, dz, startX, startY, startZ;
    if (apert) {
      const th = tilt;
      dx = ux * Math.sin(th); dy = -Math.cos(th); dz = uz * Math.sin(th);
      startX = px + ux * apert * f; startY = py; startZ = pz + uz * apert * f;
    } else {
      const th = sector * f + tilt;
      dx = ux * Math.sin(th); dy = -Math.cos(th); dz = uz * Math.sin(th);
      startX = px + dx * R0; startY = (py + R0) + dy * R0; startZ = pz + dz * R0;
    }
    // the beam direction in the VOLUME's frame — constant down a line, and what the flow
    // gradient has to be dotted against once the patient is rolled
    BW[0] = dx; BW[1] = dy; BW[2] = dz;
    dirToVol(BW, BV);
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
      echo[base + k] = e;
      // ---- COLOUR: the axial component of flow, wrapped at the Nyquist velocity ----
      if (dopOn && id >= 29 && id <= 46 && k >= dk0 && k <= dk1 && l >= dl0 && l <= dl1) {
        const ix = (MP[0] / vsx) | 0, iy = (MP[1] / vsy) | 0, iz = (MP[2] / vsz) | 0;
        if (flowDir(ix, iy, iz, id)) {
          // THE dot product. A vessel crossed at 90 degrees returns zero however fast the
          // blood moves, and no other line of code is needed to say so.
          const cosT = GD[0] * BV[0] + GD[1] * BV[1] + GD[2] * BV[2];
          // No sign flip for veins, and the measurement is why. The arclength field was
          // built by following the CIRCULATION from the injection site — up the veins to
          // the heart, then out along the arteries — so grad-s is the flow direction
          // everywhere, not just on the arterial side. Measured: the aorta's gradient runs
          // caudally (z = -0.88 to -0.95 down its length) and the IVC's runs cranially
          // (z = +0.90). They oppose each other because the anatomy does, which is what
          // puts a vessel and its companion in opposite colours without being told to.
          const v0 = (VPEAK[id] || 30) * (VENOUS[id] ? respWave : sysWave) * cosT;
          // the ENSEMBLE: N pulses down this line, averaged. Real work, and the estimator
          // noise falls as 1/sqrt(N) because that is what averaging N of them does.
          let acc = 0;
          for (let e2 = 0; e2 < ENS; e2++) {
            const q = hash3((MP[0] * 31) | 0, (MP[1] * 31) | 0, ((MP[2] * 31) | 0) ^ (fseed + e2 * 7919));
            acc += v0 * (1 + (q - 0.5) * 0.7);
          }
          let w = acc / ENS;
          while (w > vNyq) w -= 2 * vNyq;          // ALIASING: a phase, and phases wrap
          while (w < -vNyq) w += 2 * vNyq;
          vel[base + k] = w;
          velId[base + k] = id;
        }
      }
      // attenuation over this step (one way; the echo pays it twice by construction)
      amp *= Math.exp(-At[id] * freq * ds / 8.686);
      if (amp < 1e-6) { prevId = id; break; }          // nothing is coming back from here
      prevId = id;
    }
  }
  lastMs = performance.now() - t0;
  /* THE FRAME RATE IS ACOUSTIC, NOT COMPUTATIONAL. A machine cannot start the next line
     until the last echo of this one has come back, so a frame costs
     NLINE x 2 x depth / c — which is why a deep scan is slower than a shallow one, why
     M-mode (one line) can sweep at kilohertz, and why the colour box is expensive: its
     lines are fired ENS times each for the ensemble the estimator needs.

     This replaced a fake. The first version let the loop run as fast as the CPU could
     manage and reported that as fps, so caching the flow directions made colour Doppler
     cost exactly nothing — x1.00 — which is the opposite of the lesson. Sound has a
     speed; that is the budget, and the box spends it. */
  const tLineMs = 2 * depth / (C_SND * 1e6) * 1e3;          // round trip, ms
  const nBoxLines = dopOn ? Math.max(0, dl1 - dl0 + 1) : 0;
  lastAcqMs = (NLINE + nBoxLines * (ENS - 1)) * tLineMs;
  lastEcho = { echo, depth, freq, ds, sector, R0, apert, lamCm, vel, velId, vNyq, acqMs: lastAcqMs,
    box: dopOn ? { l0: dl0, l1: dl1, k0: dk0, k1: dk1 } : null };
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
    lut[k] = 2 * TGC_ASSUME * freq * (k * ds) + (B[i0] * (1 - fr2) + B[i1] * fr2);
  }
  return lut;
}
/* The B fan, scan-converted. Returns the geometry so the M cursor can be drawn in the
   same frame the image was built in. */
function drawFan(env, fr, tgcLut) {
  const { depth, ds, sector, R0, apert, vel, vNyq } = fr;
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
      if (l >= 0 && l < NLINE && k >= 0 && k < NSAMP) v = greyOf(env[l * NSAMP + k], k, tgcLut, dr);
      let R = v, G = v, B = v;
      if (vel && l >= 0 && l < NLINE && k >= 0 && k < NSAMP) {
        const w = vel[l * NSAMP + k];
        if (w !== 0) {
          // BART, the convention every machine ships with: Blue Away, Red Toward. The
          // beam direction points INTO the patient, so a positive axial component is
          // receding. Brightness is speed as a fraction of the Nyquist velocity — which
          // is why an aliased jet comes back saturated in the OTHER colour.
          const a = Math.min(1, Math.abs(w) / vNyq);
          const mix = 0.15 + 0.85 * Math.min(1, a * 2.2);
          const cr = w < 0 ? 130 + 125 * a : 20;
          const cg = w < 0 ? 25 + 175 * a * a : 45 + 150 * a * a;
          const cb = w < 0 ? 20 : 135 + 120 * a;
          R = v * (1 - mix) + cr * mix; G = v * (1 - mix) + cg * mix; B = v * (1 - mix) + cb * mix;
        }
      }
      img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // the colour box, drawn where the colour actually is: a wedge in the fan's own polar
  // frame, not a rectangle pasted over it
  if (fr.box) {
    const b = fr.box;
    g.strokeStyle = 'rgba(120,230,140,0.8)'; g.lineWidth = 1.5;
    g.beginPath();
    if (sector) {
      const t0 = (b.l0 / (NLINE - 1) - 0.5) * sector, t1 = (b.l1 / (NLINE - 1) - 0.5) * sector;
      const r0 = R0 + b.k0 * ds, r1 = R0 + b.k1 * ds;
      const pt = (r, t) => [cx + Math.sin(t) * r * scale, cy + Math.cos(t) * r * scale];
      g.moveTo(...pt(r0, t0));
      g.arc(cx, cy, r0 * scale, Math.PI / 2 - t0, Math.PI / 2 - t1, true);
      g.lineTo(...pt(r1, t1));
      g.arc(cx, cy, r1 * scale, Math.PI / 2 - t1, Math.PI / 2 - t0, false);
      g.closePath();
    } else {
      const x0 = (b.l0 / (NLINE - 1) - 0.5) * apert, x1 = (b.l1 / (NLINE - 1) - 0.5) * apert;
      g.rect(cx + x0 * scale, cy + b.k0 * ds * scale, (x1 - x0) * scale, (b.k1 - b.k0) * ds * scale);
    }
    g.stroke();
    // the velocity scale: what the colour bar tops out at before it wraps
    g.fillStyle = 'rgba(160,240,180,0.9)'; g.font = '12px ui-monospace, monospace';
    g.fillText(`+${vNyq.toFixed(0)}`, 8, 18);
    g.fillText(`-${vNyq.toFixed(0)} cm/s`, 8, H - 8);
  }
  return { W, H, cx, cy, scale };
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

function render(fr) {
  const film = $('film'); if (!film || !fr) return;
  const env = envelope(fr);
  const { depth, freq, ds } = fr;
  const tgcLut = buildTgc(freq, ds);
  const geo = drawFan(env, fr, tgcLut);
  if (!usCanvas) { usCanvas = document.createElement('canvas'); usCanvas.width = 512; }
  const wantH = U.disp === 'm' ? 768 : 512;
  if (usCanvas.height !== wantH) usCanvas.height = wantH;
  const g = usCanvas.getContext('2d');
  if (U.disp === 'm') { appendM(env, tgcLut); drawMScreen(g, geo, fr); }
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
  const tl = $('fnTL'); if (tl) tl.textContent = `US ${freq.toFixed(1)} MHz` + (U.disp === 'm' ? ' · M' : '');
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
  if (fr) render(fr);
  // M-mode fires ONE line per column, so its budget is one round trip, not a whole frame
  const acq = U.disp === 'm' ? lastAcqMs / NLINE : lastAcqMs;
  const fps = 1000 / Math.max(acq, lastMs, 1);
  setStatus(`${fps.toFixed(0)} fps · ${acq.toFixed(0)} ms acoustic · ${lastMs.toFixed(0)} ms compute`
    + (U.live ? ' · LIVE' : ' · FROZEN'));
  if (U.live) {
    clearTimeout(liveTimer);
    // wait out whatever is left of the acoustic budget after the compute
    liveTimer = setTimeout(sweep, Math.max(8, acq - lastMs));
  }
}
function setLive(on) {
  U.live = on;
  $('usFreeze')?.classList.toggle('on', !on);
  clearTimeout(liveTimer); liveTimer = null;
  sweep();
}
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
  $('usDop')?.classList.toggle('on', U.dop);
  $('usHold')?.classList.toggle('on', U.hold);
  $('usMotion')?.classList.toggle('on', !U.motion);
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
  if (!U.live) sweep();
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
      if (!U.live) sweep();
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
      if (!U.live) sweep();
    });
  }
  $('usTgcReset')?.addEventListener('click', () => {
    U.tgcBands = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6; i++) { const el = $('usTgc' + i); if (el) el.value = 0; }
    if (!U.live) sweep();
    setStatus('TGC centred.');
  });
  slide('usRange', 'range');
  // ---- colour Doppler ----
  $('usDop')?.addEventListener('click', () => {
    U.dop = !U.dop;
    $('usDop').classList.toggle('on', U.dop);
    if (U.dop) ensureSVol();
    if (!U.live) sweep();
    setStatus(U.dop ? 'Colour box on — and it costs frame rate, as it should.' : 'Colour off.');
  });
  slide('usPrf', 'prf'); slide('usDopY', 'dopY'); slide('usDopH', 'dopH'); slide('usDopW', 'dopW');
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
    if (!U.live) sweep();
  });
  document.querySelectorAll('#usDispSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      U.disp = b.dataset.disp;
      document.querySelectorAll('#usDispSeg button').forEach((x) => x.classList.toggle('on', x === b));
      mReset();
      // M-mode is one line, so it can afford a faster sweep than a whole frame can
      if (U.live) setLive(true); else sweep();
    });
  });
  // The cardiac seat was surveyed, not guessed: from below the costal margin, angled up
  // through the liver, is the one window into this subject's heart that ribs and lung do
  // not close. See docs/ultrasound.md §4.2.
  $('usCardiac')?.addEventListener('click', () => {
    Object.assign(U, CARDIAC_SEAT);
    ['usPx:px', 'usPz:pz', 'usRot:rot', 'usTilt:tilt', 'usDepth:depth', 'usFocus:focus']
      .forEach((p) => { const [id, k] = p.split(':'); const el = $(id); if (el) el.value = U[k]; });
    renderReadouts(); mReset(); sweep(); usSyncScene();
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
      renderReadouts(); sweep(); usSyncScene();
    });
  });
  if (typeof window !== 'undefined') window.__usProbe = () => ({
    U, lastMs, lastEcho, scanFrame, envelope, anim, WST, mReset,
    bind: bindVolume, vdims: () => ({ vnx, vny, vnz, vsx, vsy, vsz, vex, vey, vez }),
    idAt, buildTgc, greyOf, NLINE, NSAMP, mCanvas: () => mCanvas,
    contact: (x, z) => { cpKey = ''; return contactPoint(x, z); }, surfaceAt, GEL_PAD,
    sVol: () => sVol, ensureSVol, flowDir, GD, VPEAK, VENOUS, ENS,
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
