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
  return true;
}
function idAt(x, y, z) {
  const ix = (x / vsx) | 0, iy = (y / vsy) | 0, iz = (z / vsz) | 0;
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
function contactPoint(px, pz) {
  for (let y = vey - 0.01; y > 0; y -= 0.05) {
    if (idAt(px, y, pz) !== 0) return y;
  }
  return vey * 0.5;
}

/* ---- one frame ------------------------------------------------------------- */
let lastEcho = null, lastMs = 0;
function scanFrame() {
  if (!vol && !bindVolume()) return null;
  const t0 = performance.now();
  if (!TBL) TBL = acousticTables(64);
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

  for (let l = 0; l < NLINE; l++) {
    const f = l / (NLINE - 1) - 0.5;
    // curvilinear lines diverge from a virtual apex R0 behind the face; linear lines
    // are parallel, offset across the aperture. Both scan the TRANSVERSE plane.
    let dx, dy, startX, startY;
    if (apert) {
      dx = 0; dy = -1; startX = px + apert * f; startY = py;
    } else {
      const th = sector * f;
      dx = Math.sin(th); dy = -Math.cos(th);
      startX = px + dx * R0; startY = (py + R0) + dy * R0;
    }
    let amp = 1;                                       // one-way amplitude remaining
    let prevId = -1;
    let coupled = false;      // has this line reached the patient yet?
    const base = l * NSAMP;
    for (let k = 0; k < NSAMP; k++) {
      const r = k * ds;
      const x = startX + dx * r, y = startY + dy * r, zc = pz;
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
        const q = hash3((x * 50) | 0, (y * 50) | 0, (zc * 50) | 0);
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
      out[l * NSAMP + k] = Math.abs(s / (w || 1));
    }
  }
  return out;
}

/* ---- scan conversion + display --------------------------------------------- */
let usCanvas = null;
function render(fr) {
  const film = $('film'); if (!film || !fr) return;
  const env = envelope(fr);
  const { depth, freq, ds, sector, R0, apert } = fr;
  if (!usCanvas) { usCanvas = document.createElement('canvas'); usCanvas.width = 512; usCanvas.height = 512; }
  const W = usCanvas.width, H = usCanvas.height;
  const g = usCanvas.getContext('2d');
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
      if (l >= 0 && l < NLINE && k >= 0 && k < NSAMP) {
        const r = R0 + k * ds;
        // TGC: every machine compensates for an ASSUMED uniform tissue. That
        // assumption is what makes a cyst's far wall bright and a stone's shadow
        // black — the compensation is right for tissue and wrong for both.
        const tgcDb = 2 * TGC_ASSUME * freq * (k * ds) * U.tgc;
        const db = 20 * Math.log10(env[l * NSAMP + k] + 1e-7) + SYS_DB + tgcDb + U.gain;
        v = Math.max(0, Math.min(1, (db + dr) / dr));
        v = Math.pow(v, 0.85) * 255;
      }
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const f2 = film.getContext('2d');
  if (film.width !== 330) { film.width = 330; film.height = 440; }
  f2.fillStyle = '#000'; f2.fillRect(0, 0, film.width, film.height);
  const s = Math.min(film.width / W, film.height / H);
  f2.imageSmoothingEnabled = true;
  f2.drawImage(usCanvas, (film.width - W * s) / 2, (film.height - H * s) / 2, W * s, H * s);
  $('noexp')?.style.setProperty('display', 'none');
  if (ctx.S.bayContent === 'image') usImageToBay();
  const tl = $('fnTL'); if (tl) tl.textContent = `US ${freq.toFixed(1)} MHz`;
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
  if (on) liveTimer = setInterval(sweep, 60);
  sweep();
}
function setStatus(t) { const el = $('usStatus'); if (el) el.textContent = t; }
function renderReadouts() {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('usFreqV', U.freq.toFixed(1) + ' MHz');
  set('usDepthV', U.depth.toFixed(0) + ' cm');
  set('usGainV', U.gain + ' dB');
  set('usFocusV', U.focus.toFixed(0) + ' cm');
}

/* ---- the rig: a probe on the skin + the plane it images --------------------- */
let rig = null, probeMesh = null, planeMesh = null;
function buildRig() {
  const { THREE, three } = ctx;
  rig = new THREE.Group();
  probeMesh = new THREE.Mesh(new THREE.BoxGeometry(4.2, 9, 2.6),
    new THREE.MeshStandardMaterial({ color: 0xdfe6ec, roughness: 0.5 }));
  rig.add(probeMesh);
  planeMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0x4fd1e0, transparent: true, opacity: 0.16,
      side: THREE.DoubleSide, depthWrite: false }));
  rig.add(planeMesh);
  rig.visible = false;
  three.handGroup.parent.add(rig);
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
  // the room places the volume centred on x/z with its base at y=0, so anatomy
  // (x, y, z) maps to world (x - ex/2, y, z - ez/2)
  const px = vex * U.px, pz = vez * U.pz, py = contactPoint(px, pz);
  const wx = px - vex / 2, wz = pz - vez / 2;
  probeMesh.position.set(wx, py + 4.5, wz);
  const d = U.depth;
  planeMesh.scale.set(2 * (6 + d) * Math.sin(0.525), d, 1);
  planeMesh.position.set(wx, py - d / 2, wz);
  planeMesh.rotation.set(0, 0, 0);
}

/* ---- mode + wiring --------------------------------------------------------- */
export function usApplyMode(on) {
  if (!ctx) return;
  if (on) {
    if (ctx.S.subject !== 'chestabdopelvis') ctx.setSubject?.('chestabdopelvis');
    renderReadouts();
    setStatus('Scanning…');
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
  $('usFreeze')?.addEventListener('click', () => setLive(!U.live));
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
  if (typeof window !== 'undefined') window.__usProbe = () => ({ U, lastMs, lastEcho, scanFrame, envelope });
  renderReadouts();
}
