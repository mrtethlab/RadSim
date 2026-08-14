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
function idAt(x, y, z) {
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

/* ---- one frame ------------------------------------------------------------- */
let lastEcho = null, lastMs = 0;
function scanFrame() {
  if (!vol && !bindVolume()) return null;
  const t0 = performance.now();
  if (!TBL) TBL = acousticTables(64);
  WST = anim ? motionState(anim, animTick(), vsz, vnz) : null;
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
      // attenuation over this step (one way; the echo pays it twice by construction)
      amp *= Math.exp(-At[id] * freq * ds / 8.686);
      if (amp < 1e-6) { prevId = id; break; }          // nothing is coming back from here
      prevId = id;
    }
  }
  lastMs = performance.now() - t0;
  lastEcho = { echo, depth, freq, ds, sector, R0, apert, lamCm };
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
  const { depth, ds, sector, R0, apert } = fr;
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
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
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
  setStatus(`${lastMs.toFixed(0)} ms/frame · ${(1000 / Math.max(lastMs, 1)).toFixed(0)} fps`
    + (U.live ? ' · LIVE' : ' · FROZEN'));
}
function setLive(on) {
  U.live = on;
  $('usFreeze')?.classList.toggle('on', !on);
  clearInterval(liveTimer); liveTimer = null;
  // M-mode buys its time resolution by asking for frames faster — the sweep writes a
  // column per frame, so the frame rate IS the temporal resolution of the trace.
  if (on) liveTimer = setInterval(sweep, U.disp === 'm' ? 20 : 60);
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
  if (!vol && !bindVolume()) return;
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
    clearInterval(liveTimer); liveTimer = null;
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
