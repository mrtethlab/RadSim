/* CT FILM: the images and the arithmetic of reconstruction, done for real on the shipped model.
   The slices are the chest/abdomen/pelvis voxel model's own material ids (public/anim/ct_*.png,
   services/compute app/build_anim_images.py ct), turned into Hounsfield units by the app's legend
   (core/materials.js), enhanced phase by phase, given partial volume and noise. The sinograms are
   the line integrals of the slice's attenuation, ray by ray; the back-projections, filters and
   iterations are computed from them, so what the film shows is what the arithmetic gives. */
import { BodyMaterials } from '../../../core/materials.js';
import { rng, PAL } from '../../pixel.js';

// ---------------------------------------------------------------- loading
function loadPng(url) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => {
      const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
      const g = cv.getContext('2d'); g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, im.width, im.height).data, a = new Uint8Array(im.width * im.height);
      for (let i = 0; i < a.length; i++) a[i] = d[i * 4];
      res({ w: im.width, h: im.height, ids: a });
    };
    im.onerror = () => res({ w: 64, h: 64, ids: new Uint8Array(64 * 64) });
    im.src = url;
  });
}
export async function loadImages() {
  const base = import.meta.env.BASE_URL + 'anim/';
  const names = ['ax_abd', 'ax_chest', 'ax_head', 'cor', 'sag', 'stack', 'scout'];
  const out = {};
  await Promise.all(names.map(async (n) => { out[n] = await loadPng(base + 'ct_' + n + '.png'); }));
  out.scout.v = Float32Array.from(out.scout.ids, (q) => q / 255);
  return out;
}

// ---------------------------------------------------------------- Hounsfield units
// the legend's nominal HU per id (metals, which have none, as 3000)
export const HU0 = new Float32Array(256).fill(40);
for (const m of BodyMaterials.LIST) HU0[m.id] = m.hu == null ? 3000 : m.hu;
export const MUW70 = BodyMaterials.muWater(70);          // cm^-1, water at a 120 kV beam's mean energy
export const muOfHU = (hu) => Math.max(0, MUW70 * (1 + hu / 1000));

/* Enhancement (HU added) by tissue, t seconds after the injection starts (100 mL at 4 mL/s into
   an arm vein): gamma-variate first passes on a recirculation plateau. Arrival and peak times
   are typical adult values (aortic arrival ~15 s, arterial peak ~25-30 s, portal venous ~60-70 s). */
const gv = (t, t0, tp, peak, a = 3) => { if (t <= t0) return 0; const x = (t - t0) / (tp - t0); return peak * Math.pow(x, a) * Math.exp(a * (1 - x)); };
const plat = (t, t0, v, tau = 12) => (t <= t0 ? 0 : v * (1 - Math.exp(-(t - t0) / tau)));
export const ENH = {
  aorta: (t) => gv(t, 12, 28, 260) + plat(t, 30, 120),
  pa: (t) => gv(t, 6, 14, 280) + plat(t, 22, 120),
  portal: (t) => gv(t, 22, 42, 120) + plat(t, 40, 90, 15),
  liver: (t) => plat(t, 24, 70, 22),
  spleen: (t) => gv(t, 16, 32, 60) + plat(t, 30, 55),
  kidney: (t) => gv(t, 15, 30, 110) + plat(t, 28, 100),
  pancreas: (t) => gv(t, 16, 38, 70) + plat(t, 40, 30),
  ivc: (t) => plat(t, 38, 110, 14),
  heart: (t) => gv(t, 14, 28, 50) + plat(t, 32, 25),
  svc: (t) => gv(t, 2, 10, 900, 2) + plat(t, 30, 110),
};
const ENH_IDS = { aorta: [29, 35, 36, 37, 38, 39, 43, 44], pa: [30], portal: [34], liver: [11], spleen: [12], kidney: [13],
  pancreas: [14], ivc: [33, 45, 46], heart: [15], svc: [32, 40, 41] };
// the per-id HU table at time t after the injection (t < 0: unenhanced)
export function huTable(t = -1) {
  const a = Float32Array.from(HU0);
  if (t > 0) for (const [k, ids] of Object.entries(ENH_IDS)) { const v = ENH[k](t); for (const id of ids) a[id] += v; }
  // the pulmonary veins and left heart follow the pulmonary arteries by a few seconds
  if (t > 0) { const v = ENH.pa(t - 5); for (const id of [31, 42]) a[id] += v; }
  return a;
}

/* An image's HU map: the table applied, then a light 3x3 blur (partial volume: a 2 mm voxel at an
   edge holds both tissues). Cached by table identity. */
export function huMap(img, table, blur = true) {
  img._hu = img._hu || new Map();
  const key = table;
  let m = img._hu.get(key);
  if (m) return m;
  const { w, h, ids } = img, a = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = table[ids[i]];
  if (blur) {
    const b = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const k = (dx ? 1 : 2) * (dy ? 1 : 2);
        s += a[yy * w + xx] * k; n += k;
      }
      b[y * w + x] = s / n;
    }
    m = b;
  } else m = a;
  if (img._hu.size > 40) img._hu.clear();
  img._hu.set(key, m);
  return m;
}
// a fixed field of unit Gaussian noise for an image (seeded: the same grain every loop)
export function noiseField(n, seed = 7) {
  const r = rng(seed), a = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = Math.max(1e-9, r()), v = r(), m = Math.sqrt(-2 * Math.log(u));
    a[i] = m * Math.cos(6.2832 * v); if (i + 1 < n) a[i + 1] = m * Math.sin(6.2832 * v);
  }
  return a;
}

// ---------------------------------------------------------------- drawing greys on the 8-bit layer
/* A grey image drawn through an offscreen canvas, one cell per value, scaled with no smoothing.
   grey(i) -> 0..1, or a Float32Array with lo/hi. Also tinted (rgb(i) -> [r,g,b]). */
const offs = new Map();
function off(w, h) {
  const k = w + 'x' + h;
  let o = offs.get(k);
  if (!o) { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; o = { cv, g: cv.getContext('2d'), id: null }; o.id = o.g.createImageData(w, h); offs.set(k, o); }
  return o;
}
export function drawGrey(px, w, h, x, y, scale, value, { a = 1, rgb = null, clip = null, smooth = false, scaleXY = null } = {}) {
  const o = off(w, h), d = o.id.data;
  for (let i = 0, n = w * h; i < n; i++) {
    let r, g, b;
    if (rgb) [r, g, b] = rgb(i);
    else { const v = Math.round(Math.max(0, Math.min(1, value(i))) * 255); r = g = b = v; }
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  o.g.putImageData(o.id, 0, 0);
  const G = px.g;
  G.save();
  G.imageSmoothingEnabled = smooth;                       // (smooth: an area-averaged shrink)
  G.globalAlpha = a * px.alpha;
  if (clip) { G.beginPath(); G.rect(...clip); G.clip(); }
  const [sx, sy] = scaleXY || [scale, scale];
  G.drawImage(o.cv, Math.round(x), Math.round(y), Math.round(w * sx), Math.round(h * sy));
  G.restore();
}
// HU through a window (level, width) to grey; below black, above white
export const win = (hu, L, W) => (hu - (L - W / 2)) / W;
/* A slice drawn in HU through a window, with quantum noise of sigma HU. */
export function drawSlice(px, img, x, y, scale, { table = HU0, L = 40, W = 400, sigma = 8, a = 1, seed = 7, clip = null, map = null } = {}) {
  const hu = map || huMap(img, table);
  const nz = img._nz || (img._nz = noiseField(img.w * img.h, seed));
  drawGrey(px, img.w, img.h, x, y, scale, (i) => win(hu[i] + (img.ids[i] ? sigma * nz[i] : 0), L, W), { a, clip });
  return hu;
}

/* The tissue palette for the 8-bit slice the photons cross (not a CT image: a map of what is
   where, in the film's colours). */
const TCOL = (() => {
  const t = new Array(256).fill('muscle');
  t[0] = null; t[47] = null; t[1] = 'navy'; t[2] = 'fat'; t[23] = 'peach'; t[17] = 'bone'; t[18] = 'white';
  t[11] = 'brown'; t[12] = 'plum'; t[13] = 'pink'; t[14] = 'gold'; t[15] = 'red';
  for (const id of [29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 8]) t[id] = 'dkred';
  for (const id of [48, 49, 50, 51, 52, 5, 6]) t[id] = 'slate';
  return t;
})();
const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const TRGB = TCOL.map((c) => (c ? hex(PAL[c]) : hex(PAL.ink)));
export const tissueName = (id) => TCOL[id];
export function drawTissue(px, img, x, y, scale, { a = 1, dim = 1, clip = null } = {}) {
  drawGrey(px, img.w, img.h, x, y, scale, null, { a, clip, rgb: (i) => { const id = img.ids[i], c = TRGB[id], k = TCOL[id] ? dim : 1; return [c[0] * k, c[1] * k, c[2] * k]; } });
}

// ---------------------------------------------------------------- the slice as attenuation
/* The slice resampled to an N x N grid of mu (cm^-1, at 70 keV), square, the image centred in it.
   cm: the grid's size (the image's width, voxel 0.2 cm). Image rows run anterior to posterior,
   columns patient's right to left, as displayed. */
export function muGrid(img, N, table = HU0) {
  const hu = huMap(img, table, false);
  const side = Math.max(img.w, img.h), oy = (side - img.h) / 2, ox = (side - img.w) / 2, f = side / N;
  const mu = new Float32Array(N * N);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    let s = 0, n = 0;
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
      const X = Math.floor((c + 0.25 + sx * 0.5) * f - ox), Y = Math.floor((r + 0.25 + sy * 0.5) * f - oy);
      s += X >= 0 && Y >= 0 && X < img.w && Y < img.h ? (img.ids[Y * img.w + X] ? muOfHU(hu[Y * img.w + X]) : 0) : 0; n++;
    }
    mu[r * N + c] = s / n;
  }
  return { N, d: side * 0.2 / N, mu, side };
}
// bilinear sample of the grid at (col, row) in grid pixels
function samp(G, c, r) {
  const N = G.N, c0 = Math.floor(c - 0.5), r0 = Math.floor(r - 0.5), fc = c - 0.5 - c0, fr = r - 0.5 - r0;
  let s = 0;
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const cc = c0 + i, rr = r0 + j;
    if (cc < 0 || rr < 0 || cc >= N || rr >= N) continue;
    s += G.mu[rr * N + cc] * (i ? fc : 1 - fc) * (j ? fr : 1 - fr);
  }
  return s;
}
/* The line integral from screen-frame point A to B (grid pixels, y down): sum of mu ds, cm. */
export function lineIntegral(G, ax, ay, bx, by, step = 0.5) {
  // clipped to the grid (Liang-Barsky): outside it there is only air
  let t0 = 0, t1 = 1;
  const dx0 = bx - ax, dy0 = by - ay;
  for (const [p, q] of [[-dx0, ax], [dx0, G.N - ax], [-dy0, ay], [dy0, G.N - ay]]) {
    if (p === 0) { if (q < 0) return 0; continue; }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
  }
  if (t1 <= t0) return 0;
  const x0 = ax + dx0 * t0, y0 = ay + dy0 * t0, x1 = ax + dx0 * t1, y1 = ay + dy0 * t1;
  const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(L / step)), dx = (x1 - x0) / n, dy = (y1 - y0) / n;
  let s = 0;
  for (let k = 0; k < n; k++) s += samp(G, x0 + dx * (k + 0.5), y0 + dy * (k + 0.5));
  return s * (L / n) * G.d;
}
/* mu sampled along a ray, n points from A to B (for the plots), and the running integral. */
export function rayProfile(G, ax, ay, bx, by, n) {
  const mu = new Float32Array(n), cum = new Float32Array(n), L = Math.hypot(bx - ax, by - ay) * G.d;
  let s = 0;
  for (let k = 0; k < n; k++) {
    const f = (k + 0.5) / n;
    mu[k] = samp(G, ax + (bx - ax) * f, ay + (by - ay) * f);
    s += mu[k] * L / n; cum[k] = s;
  }
  return { mu, cum, L };
}
export function muAt(G, c, r) { return samp(G, c, r); }

/* Fan-beam geometry in grid pixels, as the gantry has it seen from the feet: the source at
   radius R from the centre at angle th (0 at the top; positive turns the tube toward the
   screen's left, as the frame turns), the channel angle g across the fan (positive to the
   source's left). Returns the ray's source and the point past the far side. */
export function fanRay(G, R, th, g) {
  const cx = G.N / 2, cy = G.N / 2;
  const sx = cx - R * Math.sin(th), sy = cy - R * Math.cos(th);
  // the central ray points at the centre; the channel turns it by g
  const a = Math.atan2(cy - sy, cx - sx) + g;
  return [sx, sy, sx + Math.cos(a) * 2 * R, sy + Math.sin(a) * 2 * R];
}
export function fanSinogram(G, R, half, NV, NC) {
  const p = new Float32Array(NV * NC);
  for (let v = 0; v < NV; v++) {
    const th = (v / NV) * Math.PI * 2;
    for (let c = 0; c < NC; c++) {
      const g = -half + (c + 0.5) / NC * 2 * half;
      const [ax, ay, bx, by] = fanRay(G, R, th, g);
      p[v * NC + c] = lineIntegral(G, ax, ay, bx, by, 0.7);
    }
  }
  return { NV, NC, R, half, p };
}

/* Parallel projections (the fan rebinned): NA angles over 180 degrees, NB bins one grid pixel
   apart. Angle phi: the rays run along (sin phi, cos phi) in screen coordinates (phi 0: straight
   down the screen, the tube at the top, as at the start of the fan). */
export function parallelSinogram(G, NA) {
  const N = G.N, NB = N, p = new Float32Array(NA * NB), cx = N / 2, cy = N / 2;
  for (let a = 0; a < NA; a++) {
    const ph = (a / NA) * Math.PI, dx = Math.sin(ph), dy = Math.cos(ph), ux = dy, uy = -dx;   // u: across the rays
    for (let b = 0; b < NB; b++) {
      const u = b + 0.5 - NB / 2;
      const ox = cx + ux * u, oy = cy + uy * u;
      p[a * NB + b] = lineIntegral(G, ox - dx * N * 0.75, oy - dy * N * 0.75, ox + dx * N * 0.75, oy + dy * N * 0.75, 0.7);
    }
  }
  return { NA, NB, p };
}
/* Quantum noise: each ray's detected photons are Poisson about I0 e^-p (a Gaussian of the same
   variance here), and the log of the counts is what is reconstructed. */
export function noisySino(S, I0, seed = 3) {
  const nz = noiseField(S.p.length, seed), q = new Float32Array(S.p.length);
  for (let i = 0; i < q.length; i++) {
    const m = I0 * Math.exp(-S.p[i]), n = Math.max(1, m + Math.sqrt(m) * nz[i]);
    q[i] = Math.log(I0 / n);
  }
  return { ...S, p: q };
}
/* A reconstruction kernel: the ramp |f| shaped by a window, as a convolution kernel in space
   (2NB-1 taps, inverse DFT). 'ramp' the bare Ram-Lak; 'soft' rolled off (Hann: smoothing);
   'sharp' a mild high-frequency boost before a late roll-off (edge-enhancing, noisier). */
export function makeKernel(type, NB) {
  const M = 4 * NB, H = new Float32Array(M);
  for (let k = 0; k < M; k++) {
    const f = Math.min(k, M - k) / M;                  // cycles per bin, 0..0.5
    const u = f / 0.5;
    let w = 1;
    if (type === 'soft') w = 0.5 + 0.5 * Math.cos(Math.PI * u);
    else if (type === 'sharp') w = (1 + 0.9 * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 2) * (u > 0.85 ? Math.cos((u - 0.85) / 0.15 * Math.PI / 2) ** 2 : 1);
    else if (type === 'ramp') w = 1;
    H[k] = f * w;
  }
  const kern = new Float32Array(2 * NB - 1);
  for (let n = -(NB - 1); n <= NB - 1; n++) {
    let s = 0;
    for (let k = 0; k < M; k++) s += H[k] * Math.cos(2 * Math.PI * k * n / M);
    kern[n + NB - 1] = s / M;
  }
  // the DC term exactly zero-sum-plus: the ramp has no DC, keep it so
  return kern;
}
export function filterSino(S, kern) {
  const { NA, NB } = S, q = new Float32Array(NA * NB), K = NB - 1;
  for (let a = 0; a < NA; a++) for (let b = 0; b < NB; b++) {
    let s = 0;
    for (let j = 0; j < NB; j++) s += S.p[a * NB + j] * kern[b - j + K];
    q[a * NB + b] = s;
  }
  return { ...S, p: q };
}
export function filterRow(row, kern) {
  const NB = row.length, K = NB - 1, out = new Float32Array(NB);
  for (let b = 0; b < NB; b++) { let s = 0; for (let j = 0; j < NB; j++) s += row[j] * kern[b - j + K]; out[b] = s; }
  return out;
}
/* Back-projection of views [0, n) (in the order `order` gives, spread over the half-turn) into
   an N x N image. Each view adds its value along the line it was measured on. */
export function backproject(S, N, views, out = null) {
  const img = out || new Float32Array(N * N);
  if (!out) img.fill(0);
  const cx = N / 2, cy = N / 2, NB = S.NB;
  for (const a of views) {
    const ph = (a / S.NA) * Math.PI, ux = Math.cos(ph), uy = -Math.sin(ph);
    for (let r = 0; r < N; r++) {
      const y = r + 0.5 - cy;
      for (let c = 0; c < N; c++) {
        const u = (c + 0.5 - cx) * ux + y * uy + NB / 2 - 0.5;
        const b0 = Math.floor(u), f = u - b0;
        if (b0 < 0 || b0 >= NB - 1) continue;
        img[r * N + c] += S.p[a * NB + b0] * (1 - f) + S.p[a * NB + b0 + 1] * f;
      }
    }
  }
  return img;
}
// a spread of view indices: the first few far apart (0, 90, 45, 135 degrees...), as a learner
// would want to see them arrive, then filling in
export function viewOrder(NA) {
  const seen = new Set(), out = [];
  for (let k = 1; k <= NA; k *= 2) for (let j = 0; j < k; j++) {
    const a = Math.floor(j / k * NA) % NA;
    if (!seen.has(a)) { seen.add(a); out.push(a); }
  }
  for (let a = 0; a < NA; a++) if (!seen.has(a)) out.push(a);
  return out;
}
/* Forward projection of an image (the estimate) with the same geometry as parallelSinogram. */
export function forwardProject(img, N, NA, d) {
  const G = { N, d, mu: img };
  return parallelSinogram(G, NA);
}
/* Iterative reconstruction (SIRT with a positivity constraint and an edge-preserving smoothing
   prior), starting from the FBP image: project, compare with the measured data, back-project the
   difference, correct; then nudge each pixel toward its neighbours where they are alike. Returns
   the images after each iteration and the residual's size. */
export function iterate(meas, N, d, start, iters) {
  const NA = meas.NA, all = Array.from({ length: NA }, (_, i) => i);
  let x = Float32Array.from(start);
  const out = [Float32Array.from(x)], resid = [];
  // the normalisation: each ray's length in the image (cm, ~N d) and the NA rays through a pixel
  const norm = 1 / (NA * N * d * 0.75);
  for (let it = 0; it < iters; it++) {
    const fp = forwardProject(x, N, NA, d);
    const diff = { NA, NB: meas.NB, p: new Float32Array(meas.p.length) };
    let rs = 0;
    for (let i = 0; i < diff.p.length; i++) { diff.p[i] = meas.p[i] - fp.p[i]; rs += diff.p[i] * diff.p[i]; }
    resid.push(Math.sqrt(rs / diff.p.length));
    const bp = backproject(diff, N, all);
    for (let i = 0; i < x.length; i++) x[i] = Math.max(0, x[i] + 1.0 * bp[i] * norm);
    // the prior: an edge-stopping average (a bilateral step)
    const y = new Float32Array(x.length), dl = 0.03;   // ~150 HU: noise is smoothed, edges between tissues kept
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const v = x[r * N + c];
      let s = v, ws = 1;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= N || rr >= N) continue;
        const u = x[rr * N + cc], w = Math.exp(-(((u - v) / dl) ** 2)) * (dc && dr ? 0.5 : 1);
        s += u * w; ws += w;
      }
      y[r * N + c] = v + 0.6 * (s / ws - v);
    }
    x = y;
    out.push(Float32Array.from(x));
  }
  return { images: out, resid };
}
// mu (cm^-1) to HU and the window to grey, for the reconstructions
export const muToHU = (m) => 1000 * (m - MUW70) / MUW70;
