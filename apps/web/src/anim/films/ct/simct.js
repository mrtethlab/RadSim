/* CT FILM: the scanner simulated a step further than slice.js, for the steps on slice thickness and
   the artefacts. Everything here is the model's own material ids pushed through the physics:
     - a polychromatic beam (the 120 kV tungsten spectrum, 6 mm Al, weighted by energy as an
       energy-integrating detector weighs it) through each tissue's own mu(E) (core/materials.js:
       soft tissues water-scaled, calcified ones with a cortical-bone part, steel its own curve);
     - the water beam-hardening correction a scanner applies (the polychromatic log mapped back to
       the water length that gives it);
     - quantum noise as Poisson counts with an electronic noise floor (where the photons run out);
     - parallel projections over a half or a full turn, filtered back-projection (slice.js), with
       the patient moving, a detector element off, too few views, rays leaving the field, rows
       interpolated along a helix, rays tilted by the cone.
   Pure functions of their inputs (seeded noise): no DOM, so they run anywhere. */
import { BodyMaterials } from '../../../core/materials.js';
import { tungstenSpectrum } from '../../kit/micro.js';
import { rng } from '../../pixel.js';
import { MUW70, makeKernel, filterSino, backproject, lineIntegral, HU0, noiseField } from './slice.js';

// ---------------------------------------------------------------- the beam and the materials
/* The spectrum on 2 keV bins, weighted by energy (the detector integrates energy, not counts). */
export const SPEC = (() => {
  const s = tungstenSpectrum(120, 0.6), E = [], w = [];
  for (let e = 20; e <= 120; e += 2) { E.push(e); w.push(s(e) * e); }
  const tot = w.reduce((a, b) => a + b, 0);
  return { E, w: w.map((v) => v / tot) };
})();
const NE = SPEC.E.length;
const MW = SPEC.E.map((e) => BodyMaterials.muWater(e));          // water, cm^-1
const MB = SPEC.E.map((e) => BodyMaterials.muById(18, e));       // cortical bone
// the metals by id (aluminium, titanium, steel, lead): one at a time, as a grid's third basis
const METAL = Object.fromEntries([24, 25, 26, 27].map((id) => [id, SPEC.E.map((e) => BodyMaterials.muById(id, e))]));
let MM = METAL[26];
const MI = SPEC.E.map((e) => BodyMaterials.muIodinePerConc(e));  // iodine, per mg/mL (its K edge)
export const MU70 = { w: MUW70, b: BodyMaterials.muById(18, 70), m: BodyMaterials.muById(26, 70), i: BodyMaterials.muIodinePerConc(70) };
/* Each id as water + cortical bone (+ steel): the legend's own decomposition (a tissue at or
   below 120 HU is water scaled by density; above, a mix of water and cortical bone in the
   proportion of its HU). Air and gas: nothing. */
const BA = new Float32Array(256), BB = new Float32Array(256), BM = new Float32Array(256);
for (const m of BodyMaterials.LIST) {
  if (m.kind === 'elem') { if (m.key !== 'air') BM[m.id] = 1; continue; }
  if (m.hu <= 120) BA[m.id] = 1 + m.hu / 1000;
  else { BA[m.id] = 1 - m.hu / 1200; BB[m.id] = m.hu / 1200; }
}
export const STEEL = 26;
// mu at 70 keV of a metal by id
const M70 = {};
export const MU70m = (id) => M70[id] ?? (M70[id] = BodyMaterials.muById(id, 70));
/* -ln of the detected (energy-weighted) intensity through water, bone and steel path lengths (cm)
   and iodine (mg/mL x cm) */
export function polyP(lw, lb, lm, li = 0, metal = 26) {
  if (lm && METAL[metal] !== MM) MM = METAL[metal];
  let s = 0;
  for (let i = 0; i < NE; i++) s += SPEC.w[i] * Math.exp(-(lw * MW[i] + lb * MB[i] + lm * MM[i] + li * MI[i]));
  return -Math.log(Math.max(1e-300, s));
}
// the mean energy of the beam after those path lengths (keV)
export function meanKeV(lw, lb = 0) {
  let s = 0, e = 0;
  for (let i = 0; i < NE; i++) { const v = SPEC.w[i] / SPEC.E[i] * Math.exp(-(lw * MW[i] + lb * MB[i])); s += v; e += v * SPEC.E[i]; }
  return e / s;
}
// the spectrum's photons per bin after those lengths, relative to the incident's largest
export function spectrumAfter(lw, lb = 0) {
  const n = SPEC.w.map((w, i) => (w / SPEC.E[i]) * Math.exp(-(lw * MW[i] + lb * MB[i])));
  const m0 = Math.max(...SPEC.w.map((w, i) => w / SPEC.E[i]));
  return (E) => { const i = Math.round((E - 20) / 2); return i >= 0 && i < NE ? n[i] / m0 : 0; };
}
/* The water correction: the polychromatic log -> the water length that gives it -> that length's
   log at 70 keV. Soft tissue then reads true; what is not water (bone, metal) does not. */
const WL = (() => {
  const dl = 0.05, n = 2400, p = new Float64Array(n);
  for (let i = 0; i < n; i++) p[i] = polyP(i * dl, 0, 0);
  return { dl, n, p };
})();
export function waterCorrect(p) {
  const { dl, n, p: t } = WL;
  if (p <= 0) return p * MUW70 / (t[1] / dl);
  if (p >= t[n - 1]) return MUW70 * ((n - 1) * dl + (p - t[n - 1]) / ((t[n - 1] - t[n - 2]) / dl));
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= p) lo = m; else hi = m; }
  return MUW70 * dl * (lo + (p - t[lo]) / (t[hi] - t[lo]));
}

// ---------------------------------------------------------------- the slice on a grid
/* An id image resampled onto an N x N grid `side` image pixels across (pxCm each: the body
   model's are 0.2 cm, the head's 0.15), its top-left at (ox, oy) image pixels within the square
   (default: centred). Four samples a cell. iodine: { id: mg/mL } carried by those ids (contrast in
   blood); metal: the id whose mu(E) the grid's metal has (all its metal voxels are that one). Returns the basis maps (water, bone, steel: cm of each per cm; iodine: mg/mL) and mu at
   70 keV, per cell. */
export function grids(img, N, { side = Math.max(img.w, img.h), ox = null, oy = null, ids = img.ids, pxCm = 0.2, iodine = null, metal = 26 } = {}) {
  const X0 = ox ?? (side - img.w) / 2, Y0 = oy ?? (side - img.h) / 2, f = side / N, n = N * N;
  const w = new Float32Array(n), b = new Float32Array(n), m = new Float32Array(n), io = new Float32Array(n), mu = new Float32Array(n);
  const BIo = new Float32Array(256);
  if (iodine) for (const [id, c] of Object.entries(iodine)) BIo[+id] = c;
  let anyB = false, anyM = false, anyI = false;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    let sw = 0, sb = 0, sm = 0, si = 0;
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
      const X = Math.floor((c + 0.25 + sx * 0.5) * f - X0), Y = Math.floor((r + 0.25 + sy * 0.5) * f - Y0);
      if (X < 0 || Y < 0 || X >= img.w || Y >= img.h) continue;
      const id = ids[Y * img.w + X];
      sw += BA[id]; sb += BB[id]; sm += BM[id]; si += BIo[id];
    }
    const k = r * N + c;
    w[k] = sw / 4; b[k] = sb / 4; m[k] = sm / 4; io[k] = si / 4;
    if (b[k]) anyB = true; if (m[k]) anyM = true; if (io[k]) anyI = true;
    mu[k] = w[k] * MU70.w + b[k] * MU70.b + m[k] * MU70m(metal) + io[k] * MU70.i;
  }
  return { N, d: side * pxCm / N, side, w, b, m, i: io, mu, anyB, anyM, anyI, metal };
}
const sub = (G, key) => ({ N: G.N, d: G.d, mu: G[key] });

// ---------------------------------------------------------------- projections
/* Parallel rays: NA views over half a turn (or a full one), N bins one grid pixel apart, as
   slice.parallelSinogram (phi 0: the tube at the top, the rays straight down the screen). Each bin
   is an element with a width: `sub` rays across it, their intensities averaged as the element
   averages them. ray(a, ax, ay, bx, by, b) -> the ray's basis path lengths [water, bone, steel,
   iodine] (cm; iodine mg/mL x cm). Returns the sinograms at 70 keV (mono: what an ideal beam would give) and through the
   polychromatic beam (poly, before noise or any correction). */
export function project(N, NA, full, ray, sub = 2, withPoly = true, metal = 26) {
  const mono = new Float32Array(NA * N), poly = new Float32Array(NA * N), cx = N / 2, cy = N / 2, span = full ? 2 * Math.PI : Math.PI;
  for (let a = 0; a < NA; a++) {
    const ph = (a / NA) * span, dx = Math.sin(ph), dy = Math.cos(ph), ux = dy, uy = -dx;
    for (let b = 0; b < N; b++) {
      let sm = 0, si = 0;
      for (let s = 0; s < sub; s++) {
        const u = b + (s + 0.5) / sub - N / 2, ox = cx + ux * u, oy = cy + uy * u;
        const [lw, lb, lm, li = 0] = ray(a, ox - dx * N * 0.75, oy - dy * N * 0.75, ox + dx * N * 0.75, oy + dy * N * 0.75, b);
        sm += lw * MU70.w + lb * MU70.b + lm * MU70m(metal) + li * MU70.i;
        if (withPoly) si += Math.exp(-polyP(lw, lb, lm, li, metal));
      }
      mono[a * N + b] = sm / sub; poly[a * N + b] = -Math.log(si / sub);
    }
  }
  const S = (p) => ({ NA, NB: N, p, full });
  return { mono: S(mono), poly: S(poly) };
}
// the basis path lengths (cm) along a ray of a grid
export function paths(G, ax, ay, bx, by) {
  return [lineIntegral(sub(G, 'w'), ax, ay, bx, by, 0.7), G.anyB ? lineIntegral(sub(G, 'b'), ax, ay, bx, by, 0.7) : 0,
    G.anyM ? lineIntegral(sub(G, 'm'), ax, ay, bx, by, 0.7) : 0, G.anyI ? lineIntegral(sub(G, 'i'), ax, ay, bx, by, 0.7) : 0];
}
/* What the scanner makes of the polychromatic data: quantum noise for I0 photons per element
   (i0(a) scales it view by view: tube current modulation), then the water correction. */
export function measure(poly, { I0 = 0, i0 = null, seed = 1, correct = true } = {}) {
  const r = rng(seed), p = new Float32Array(poly.p.length), N = poly.NB;
  for (let i = 0; i < p.length; i++) {
    let v = poly.p[i];
    if (I0) v = noisyP(v, I0 * (i0 ? i0(Math.floor(i / N)) : 1), r);
    p[i] = correct ? waterCorrect(v) : v;
  }
  return { ...poly, p };
}
/* Photon counts: Poisson about the mean m (exact below 30, Gaussian above), plus the electronics'
   own noise (sigma e photons); never below a floor (the log of nothing is not taken). */
export function count(m, r, e = 2.5) {
  let n;
  if (m < 30) { const L = Math.exp(-m); let k = 0, q = r(); while (q > L && k < 200) { k++; q *= r(); } n = k; }
  else { const u = Math.max(1e-9, r()), v = r(); n = m + Math.sqrt(m) * Math.sqrt(-2 * Math.log(u)) * Math.cos(6.2832 * v); }
  const u = Math.max(1e-9, r()), v = r();
  n += e * Math.sqrt(-2 * Math.log(u)) * Math.cos(6.2832 * v);
  return Math.max(0.5, n);
}
/* The log of the counts: a ray's -ln(n / I0) for its true polychromatic p and I0 incident photons. */
export const noisyP = (p, I0, r) => Math.log(I0 / count(I0 * Math.exp(-p), r));

/* A full turn's data folded onto a half turn: the view at phi + 180 is the view at phi reversed
   (the same lines), and back-projection is linear, so adding them is back-projecting both. */
export function fold(S) {
  if (!S.full) return S;
  const NA = S.NA / 2, NB = S.NB, p = new Float32Array(NA * NB);
  for (let a = 0; a < NA; a++) for (let b = 0; b < NB; b++) p[a * NB + b] = 0.5 * (S.p[a * NB + b] + S.p[(a + NA) * NB + NB - 1 - b]);
  return { NA, NB, p, full: false };
}
const KERN = new Map();
export function kernel(type, NB) { const k = type + NB; if (!KERN.has(k)) KERN.set(k, makeKernel(type, NB)); return KERN.get(k); }
/* Filtered back-projection of a sinogram (a half or a full turn) onto an N x N grid of pixel d cm:
   mu per pixel (cm^-1). */
export function fbp(S, d, type = 'soft') {
  const H = fold(S), N = H.NB, all = Array.from({ length: H.NA }, (_, i) => i);
  const img = backproject(filterSino(H, kernel(type, N)), N, all);
  const k = Math.PI / (H.NA * d);
  for (let i = 0; i < img.length; i++) img[i] *= k;
  return img;
}
export const toHU = (mu) => 1000 * (mu - MUW70) / MUW70;

// ---------------------------------------------------------------- slabs along z
/* A stack of consecutive slices (2 mm apart) from a sheet of tiles, head first. */
export function slabSlices(sheet, tw, th, n, cols = 7) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const ids = new Uint8Array(tw * th), ox = (k % cols) * tw, oy = Math.floor(k / cols) * th;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) ids[y * tw + x] = sheet.ids[(oy + y) * sheet.w + ox + x];
    out.push({ w: tw, h: th, ids });
  }
  return out;
}
/* The weight a slice of nominal thickness T (mm) centred at z gives the 2 mm voxel layer centred
   at zj: the overlap of the two (a rectangular slice profile), normalised. */
export function sspWeights(z, T, zs) {
  const w = zs.map((zj) => Math.max(0, Math.min(z + T / 2, zj + 1) - Math.max(z - T / 2, zj - 1)));
  const s = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((v) => v / s);
}

// ---------------------------------------------------------------- HU images straight from ids
// an id image's HU at 70 keV (the basis), per pixel: for the averaged slices and the reformats
export function huOfIds(img) {
  const a = new Float32Array(img.w * img.h);
  for (let i = 0; i < a.length; i++) { const id = img.ids[i]; a[i] = id === 0 || id === 47 ? -1000 : HU0[id]; }
  return a;
}
// a field of unit Gaussian noise (seeded), smoothed a little in x as a reconstruction's grain is
export function grain(n, w, seed) {
  const a = noiseField(n, seed), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i % w; b[i] = 0.6 * a[i] + 0.4 * (x > 0 ? a[i - 1] : a[i]); }
  const s = Math.sqrt(0.6 * 0.6 + 0.4 * 0.4);
  for (let i = 0; i < n; i++) b[i] /= s;
  return b;
}
export { rng };
