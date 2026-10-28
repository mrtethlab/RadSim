/* THE ULTRASOUND FILM'S SCANNER: the app's own pulse-echo march (ultrasound.js scanFrame and
   envelope), replicated here so the film's images are made the way the mode makes them, from the
   same subject (the chest/abdomen/pelvis segmentation) and the same acoustic tables
   (core/acoustics.js). Per scanline: an amplitude spent on reflection at every impedance
   mismatch ((Z2-Z1)/(Z2+Z1))^2 and on attenuation (dB/cm/MHz) through every step, both ways; the
   backscatter of sub-resolution structure summed with a phase hashed on the tissue's position
   (speckle); then the point-spread function (axial: the pulse, 2 wavelengths; lateral: the beam,
   narrowest at the focus) and the receiver's noise floor. TGC, gain and dynamic range are
   display-side, as on the machine. Constants are the app's. */
import { acousticTables } from '../../../core/acoustics.js';
import { deriveMotion, motionState, warpPoint } from '../../../core/anatomyMotion.js';
import { capVolumeFrame } from '../capFrame.js';

export const C_SND = 0.154;           // cm per microsecond: 1540 m/s
export const TGC_ASSUME = 0.5;        // dB/cm/MHz the TGC assumes
const TGC_MAX = 66, SCAT = 0.09, SYS_DB = 9, NOISE = 7.0e-7;
export const GEL_PAD = 0.6;           // cm of gel between the face and the skin
export const NLINE = 192, NSAMP = 512;

const TBL = acousticTables(64);
export const Z = TBL.z, ATT = TBL.att, BS = TBL.bs;

function hash3(a, b, c) {
  let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* The subject's material volume: cm, origin at the min corner, x lateral, y anterior, z superior. */
export async function loadVolume() {
  const base = import.meta.env.BASE_URL + 'models/chestabdopelvis/';
  const meta = await (await fetch(base + 'chestabdopelvis.model.json')).json();
  // (from where the volume began when the film was laid out: capFrame.js)
  const { data, dims } = capVolumeFrame(new Uint8Array(await (await fetch(base + meta.volume)).arrayBuffer()), meta.dims);
  const [nx, ny, nz] = dims, vs = meta.spacing[0] / 10;
  const colors = {};
  for (const m of meta.materials) colors[m.id] = m.color;
  const V = { data, nx, ny, nz, vs, ex: nx * vs, ey: ny * vs, ez: nz * vs, colors, wst: null, anim: null,
    MP: new Float64Array(3), WP: new Float64Array(3) };
  V.idAt = (x, y, z) => {
    let fx = x / vs, fy = y / vs, fz = z / vs;
    const W = V.wst;
    if (W && W.on && fz >= W.lo && fz <= W.hi) { warpPoint(W, fx, fy, fz, V.WP); fx = V.WP[0]; fy = V.WP[1]; fz = V.WP[2]; }
    V.MP[0] = fx * vs; V.MP[1] = fy * vs; V.MP[2] = fz * vs;
    const ix = fx | 0, iy = fy | 0, iz = fz | 0;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return 0;
    return data[ix + nx * (iy + ny * iz)];
  };
  // the heart and the breath: the app's derived motion, set to a phase by setPhase
  V.setPhase = (card, br = 0.9) => {
    if (card == null) { V.wst = null; return; }
    if (!V.anim) V.anim = deriveMotion(data, dims, meta.spacing);
    V.wst = motionState(V.anim, { br, card, peri: 0, sw: -1 }, vs, nz);
  };
  return V;
}

/* The skin under the face: the mean surface over the footprint, plus the gel (the app's). */
function surfaceAt(V, px, pz) {
  for (let y = V.ey - 0.01; y > 0; y -= V.vs) {
    if (V.idAt(px, y, pz) !== 0) {
      for (let t = y + V.vs; t > y - 1e-9; t -= 0.01) if (V.idAt(px, t, pz) !== 0) return t;
      return y;
    }
  }
  return -1;
}
export function contactPoint(V, px, pz, rotDeg) {
  const save = V.wst; V.wst = null;
  const rot = rotDeg * Math.PI / 180, ux = Math.cos(rot), uz = Math.sin(rot);
  let s = 0, n = 0;
  for (let i = -2; i <= 2; i++) for (let j = -1; j <= 1; j++) {
    const f = i * 0.9, g = j * 0.6;
    const y = surfaceAt(V, px + ux * f - uz * g, pz + uz * f + ux * g);
    if (y > 0) { s += y; n++; }
  }
  V.wst = save;
  return (n ? s / n : V.ey * 0.5) + GEL_PAD;
}

/* The probe: curvilinear (a 6 cm radius face, a 60 degree sector) or linear (4 cm). */
export function probeFrame(V, o) {
  const lin = o.probe === 'linear';
  const px = V.ex * o.px, pz = V.ez * o.pz, rot = (o.rot || 0) * Math.PI / 180;
  return { lin, R0: lin ? 0 : 6.0, sector: lin ? 0 : 1.05, apert: lin ? 4.0 : 0,
    px, py: contactPoint(V, px, pz, o.rot || 0), pz, ux: Math.cos(rot), uz: Math.sin(rot), tilt: (o.tilt || 0) * Math.PI / 180 };
}
export function lineGeom(P, f, steer = 0, o = {}) {
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

/* One frame of raw echoes. o: { probe, px, pz, rot, tilt, freq, depth, focus, nline, nsamp }.
   Also keeps each line's tissue ids (for the A-mode's labels) when keepIds. */
export function scan(V, o, { lines = null, keepIds = false } = {}) {
  const nl = o.nline || NLINE, ns = o.nsamp || NSAMP;
  const P = probeFrame(V, o), ds = o.depth / ns, freq = o.freq;
  const echo = new Float32Array(nl * ns), ids = keepIds ? new Uint8Array(nl * ns) : null;
  const G = {};
  for (let l = 0; l < nl; l++) {
    if (lines && !lines.includes(l)) continue;
    lineGeom(P, nl > 1 ? l / (nl - 1) : 0.5, 0, G);
    let amp = 1, prev = -1, coupled = false;
    const b = l * ns;
    for (let k = 0; k < ns; k++) {
      const r = k * ds;
      let id = V.idAt(G.sx + G.dx * r, G.sy + G.dy * r, G.sz + G.dz * r);
      if (!coupled) { if (id === 0) id = 3; else coupled = true; }      // gel before the skin
      if (ids) ids[b + k] = id;
      let e = 0;
      if (prev >= 0 && id !== prev) {
        const rc = (Z[id] - Z[prev]) / (Z[id] + Z[prev]), R = rc * rc;
        e += Math.sqrt(R) * amp;
        amp *= Math.sqrt(Math.max(0, 1 - R));
      }
      const bs = BS[id];
      if (bs > 0) {
        const q = hash3((V.MP[0] * 50) | 0, (V.MP[1] * 50) | 0, (V.MP[2] * 50) | 0);
        e += bs * (q - 0.5) * 2.0 * amp * SCAT;
      }
      echo[b + k] = e * amp;                       // back the way it came: paid twice
      amp *= Math.exp(-ATT[id] * freq * ds / 8.686);
      prev = id;
      if (amp < 1e-6) break;
    }
  }
  return { echo, ids, o, P, nl, ns, ds, lamCm: C_SND / freq };
}

/* The point-spread function and the noise floor: the detected echo. */
export function envelope(fr) {
  const { echo, ds, lamCm, nl, ns, P } = fr, focus = fr.o.focus;
  const out = new Float32Array(nl * ns), tmp = new Float32Array(nl * ns);
  const wax = Math.max(1, Math.round((2 * lamCm) / ds / 2));
  for (let l = 0; l < nl; l++) {
    const b = l * ns;
    for (let k = 0; k < ns; k++) {
      let s = 0, w = 0;
      for (let d = -wax; d <= wax; d++) {
        const kk = k + d; if (kk < 0 || kk >= ns) continue;
        const g = Math.exp(-(d * d) / (wax * wax + 0.5));
        s += echo[b + kk] * g; w += g;
      }
      tmp[b + k] = s / (w || 1);
    }
  }
  for (let k = 0; k < ns; k++) {
    const r = P.R0 + k * ds;
    const bw = lamCm * 3 * (1 + Math.abs(k * ds - focus) / Math.max(focus, 1));
    const lineSp = P.sector ? Math.max(r * P.sector / (nl - 1), 1e-4) : P.apert / nl;
    const wl = Math.max(0, Math.min(6, Math.round(bw / lineSp / 2)));
    for (let l = 0; l < nl; l++) {
      let s = 0, w = 0;
      for (let d = -wl; d <= wl; d++) {
        const ll = l + d; if (ll < 0 || ll >= nl) continue;
        const g = Math.exp(-(d * d) / (wl * wl + 0.5));
        s += tmp[ll * ns + k] * g; w += g;
      }
      const nz = hash3(l * 7919, k * 104729, 17) - 0.5;
      out[l * ns + k] = Math.abs(s / (w || 1)) + NOISE * (0.5 + Math.abs(nz));
    }
  }
  fr.env = out;
  return out;
}

/* One line at fraction f across the face, fired alone (M-mode): its echoes through the pulse's
   axial spread and the noise floor, as greys. The anatomy as V's phase has it. */
export function oneLine(V, o, f, { gain = 0, range = 55 } = {}) {
  const ns = o.nsamp || NSAMP, P = probeFrame(V, o), ds = o.depth / ns, G = lineGeom(P, f, 0, {});
  const echo = new Float32Array(ns);
  let amp = 1, prev = -1, coupled = false;
  for (let k = 0; k < ns; k++) {
    const r = k * ds;
    let id = V.idAt(G.sx + G.dx * r, G.sy + G.dy * r, G.sz + G.dz * r);
    if (!coupled) { if (id === 0) id = 3; else coupled = true; }
    let e = 0;
    if (prev >= 0 && id !== prev) { const rc = (Z[id] - Z[prev]) / (Z[id] + Z[prev]), R = rc * rc; e += Math.sqrt(R) * amp; amp *= Math.sqrt(Math.max(0, 1 - R)); }
    const bs = BS[id];
    if (bs > 0) e += bs * (hash3((V.MP[0] * 50) | 0, (V.MP[1] * 50) | 0, (V.MP[2] * 50) | 0) - 0.5) * 2.0 * amp * SCAT;
    echo[k] = e * amp;
    amp *= Math.exp(-ATT[id] * o.freq * ds / 8.686);
    prev = id;
    if (amp < 1e-6) break;
  }
  const lam = C_SND / o.freq, wax = Math.max(1, Math.round((2 * lam) / ds / 2)), out = new Uint8Array(ns);
  const fr = { o, ns, ds };
  const lut = tgcLut(fr);
  for (let k = 0; k < ns; k++) {
    let s = 0, w = 0;
    for (let d = -wax; d <= wax; d++) { const kk = k + d; if (kk < 0 || kk >= ns) continue; const g = Math.exp(-(d * d) / (wax * wax + 0.5)); s += echo[kk] * g; w += g; }
    const e = Math.abs(s / (w || 1)) + NOISE * (0.5 + Math.abs(hash3(k * 104729, 7, 17) - 0.5));
    out[k] = greyOf(e, lut[k], gain, range);
  }
  return out;
}

/* The machine's TGC ramp (its assumed 0.5 dB/cm/MHz, both ways) plus band offsets. k = 0..1 of it. */
export function tgcLut(fr, { ramp = 1, bands = null } = {}) {
  const lut = new Float64Array(fr.ns), B = bands || [0, 0, 0, 0, 0, 0], nb = B.length;
  for (let k = 0; k < fr.ns; k++) {
    const t = k / (fr.ns - 1) * (nb - 1), i0 = Math.min(nb - 1, t | 0), i1 = Math.min(nb - 1, i0 + 1), f = t - i0;
    lut[k] = ramp * Math.min(TGC_MAX, 2 * TGC_ASSUME * fr.o.freq * (k * fr.ds)) + (B[i0] * (1 - f) + B[i1] * f);
  }
  return lut;
}
// one echo to a grey 0..255: log compression into the displayed dynamic range
export const greyOf = (e, tgc, gain, dr) => {
  const db = 20 * Math.log10(e + 1e-7) + SYS_DB + tgc + gain;
  return Math.pow(Math.max(0, Math.min(1, (db + dr) / dr)), 0.85) * 255;
};
export function greys(fr, { gain = 0, range = 55, ramp = 1, bands = null } = {}) {
  const env = fr.env || envelope(fr), lut = tgcLut(fr, { ramp, bands }), out = new Uint8Array(env.length);
  for (let l = 0; l < fr.nl; l++) for (let k = 0; k < fr.ns; k++) out[l * fr.ns + k] = greyOf(env[l * fr.ns + k], lut[k], gain, range);
  return out;
}

/* Scan conversion: for a W x H picture of the fan (it just fills the frame, as the app's does),
   each pixel's sample index (l * ns + k) or -1, and the fan's placement (apex cx, cy, px per cm). */
export function fanMap(fr, W, H, fill = 0.96) {
  const { P, ns, nl } = fr, depth = fr.o.depth, { sector, R0, apert } = P;
  const halfW = sector ? (R0 + depth) * Math.sin(sector / 2) : apert / 2;
  const totalH = sector ? (R0 + depth) - R0 * Math.cos(sector / 2) : depth;
  const scale = Math.min(W / (2 * halfW), H / totalH) * fill;
  const cx = W / 2, cy = sector ? (H - totalH * scale) / 2 - (R0 * Math.cos(sector / 2)) * scale : (H - totalH * scale) / 2;
  const map = new Int32Array(W * H).fill(-1);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const X = (i - cx) / scale, Y = (j - cy) / scale;
    let l, k;
    if (sector) {
      const r = Math.hypot(X, Y), th = Math.atan2(X, Y);
      if (r < R0 || r > R0 + depth || Math.abs(th) > sector / 2) continue;
      l = Math.round((th / sector + 0.5) * (nl - 1)); k = Math.round((r - R0) / fr.ds);
    } else {
      if (Math.abs(X) > apert / 2 || Y < 0 || Y > depth) continue;
      l = Math.round((X / apert + 0.5) * (nl - 1)); k = Math.round(Y / fr.ds);
    }
    if (l >= 0 && l < nl && k >= 0 && k < ns) map[j * W + i] = l * ns + k;
  }
  return { map, W, H, cx, cy, scale, ns, nl };
}
/* Paint a fan into an ImageData-sized RGBA buffer: grey g (Uint8Array per sample), lines up to
   upTo (fractional: the last one partly down), outside the fan transparent or black. tint(sample,
   grey, out) may recolour a pixel. */
export function paintFan(fm, g, rgba, { upTo = Infinity, depthFrac = 1, bg = [0, 0, 0, 0], tint = null, gamma = null, floor = 12 } = {}) {
  const { map, ns } = fm, n = fm.W * fm.H, out = [0, 0, 0];
  const full = Math.floor(upTo), part = upTo - full;
  for (let p = 0; p < n; p++) {
    const s = map[p], o = p * 4;
    if (s < 0) { rgba[o] = bg[0]; rgba[o + 1] = bg[1]; rgba[o + 2] = bg[2]; rgba[o + 3] = bg[3]; continue; }
    const l = (s / ns) | 0, k = s - l * ns;
    let v = g[s];
    // lines not yet fired (or not yet this deep) are not there at all
    if (l > full || (l === full && k > part * ns) || k > depthFrac * ns) { rgba[o + 3] = 0; continue; }
    if (gamma) v = gamma(v, l, k);
    if (v < floor) v = floor;                  // the fan's own dark grey: its shape shows where it is black
    if (tint) { out[0] = out[1] = out[2] = v; tint(s, v, out); rgba[o] = out[0]; rgba[o + 1] = out[1]; rgba[o + 2] = out[2]; }
    else { rgba[o] = rgba[o + 1] = rgba[o + 2] = v; }
    rgba[o + 3] = 255;
  }
}
/* A fan picture for repeated painting (on the 8-bit layer, or a monitor): paint(g, opts) redraws
   it from greys g (lines up to opts.upTo, ...), then draw it where wanted. */
export function fanSprite(fr, w, h, fill = 0.98) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d'), id = ctx.createImageData(w, h), fm = fanMap(fr, w, h, fill);
  let last = null;
  return {
    cv, fm, w, h,
    paint(g, opts = {}) {
      const key = opts.key;
      if (key != null && key === last) return cv;
      paintFan(fm, g, id.data, { bg: [0, 0, 0, 0], ...opts });
      ctx.putImageData(id, 0, 0); last = key ?? null;
      return cv;
    },
    // a sample (line l, depth cm d) -> pixel in this picture
    at(l, d) {
      const P = fr.P;
      if (P.sector) { const th = (l / (fr.nl - 1) - 0.5) * P.sector, r = P.R0 + d; return [fm.cx + Math.sin(th) * r * fm.scale, fm.cy + Math.cos(th) * r * fm.scale]; }
      return [fm.cx + (l / (fr.nl - 1) - 0.5) * P.apert * fm.scale, fm.cy + d * fm.scale];
    },
  };
}
// a canvas of a fan image (black outside), for quick use
export function fanCanvas(fr, g, W, H, opts = {}) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const fm = fanMap(fr, W, H, opts.fill ?? 0.96);
  const ctx = cv.getContext('2d'), id = ctx.createImageData(W, H);
  paintFan(fm, g, id.data, { bg: opts.bg || [0, 0, 0, 255], ...opts });
  ctx.putImageData(id, 0, 0);
  return { cv, fm };
}
