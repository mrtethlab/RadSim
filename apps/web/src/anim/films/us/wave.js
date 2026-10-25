/* THE ULTRASOUND FILM'S 8-BIT KIT: sound in a field of tissue particles. A wave here is a set of
   components (a plane pulse going down, its echo coming up, the wavelets of a row of elements...),
   each a short pulse of pressure travelling out from where it was born; every particle of the
   field is pushed along each component's direction by its displacement, and coloured by the
   summed pressure: bunched and bright where the tissue is compressed, spread and dark where it
   is rarefied. Everything is a function of the time given; the probe is always at the top of the
   frame and the sound goes down into the body, its echoes back up. */
import { rng } from '../../pixel.js';

/* A pulse's pressure at a distance s behind its front (s in 0..cycles*lam), a smooth envelope of
   n cycles; and the matching particle displacement (pressure is minus its gradient). */
export function pulseP(s, lam, cycles) {
  const L = cycles * lam;
  if (s <= 0 || s >= L) return 0;
  const e = Math.sin(Math.PI * s / L);
  return e * e * Math.sin(2 * Math.PI * s / lam);
}
export function pulseU(s, lam, cycles) {
  const L = cycles * lam;
  if (s <= 0 || s >= L) return 0;
  const e = Math.sin(Math.PI * s / L);
  return -e * e * Math.cos(2 * Math.PI * s / lam) * lam / (2 * Math.PI);
}
/* A ringing crystal's output: a fast rise, then a decay over `tau` wavelengths (a bell). */
export const ringShape = (lam, tau) => (s) => {
  const e = Math.min(1, s / (0.4 * lam)) * Math.exp(-s / (tau * lam)), ph = 2 * Math.PI * s / lam;
  return [e * Math.sin(ph), -e * Math.cos(ph) * lam / (2 * Math.PI)];
};
// a continuous wave (no envelope) behind its front: for the steady-tone scenes
export const cwP = (s, lam) => (s > 0 ? Math.sin(2 * Math.PI * s / lam) * Math.min(1, s / lam) : 0);
export const cwU = (s, lam) => (s > 0 ? -Math.cos(2 * Math.PI * s / lam) * lam / (2 * Math.PI) * Math.min(1, s / lam) : 0);

/* A wave component:
     { kind: 'plane', o: [x, y], d: [dx, dy] }   a front through o at t0, moving along d
     { kind: 'point', o: [x, y] }                a wavelet from o at t0, moving out
   with t0, c (px per second), a (amplitude), lam (px), n (cycles; 0 = continuous), and an
   optional keep(x, y) -> bool (where it exists: above an interface, inside a beam). */
export function evalComp(w, x, y, t, out) {
  const age = t - w.t0;
  if (age <= 0) return;
  let dist, ux, uy;
  if (w.kind === 'plane') { dist = (x - w.o[0]) * w.d[0] + (y - w.o[1]) * w.d[1]; ux = w.d[0]; uy = w.d[1]; }
  else {
    const dx = x - w.o[0], dy = y - w.o[1];
    dist = Math.hypot(dx, dy) || 1e-6; ux = dx / dist; uy = dy / dist;
  }
  const s = age * w.c - dist;
  if (s <= 0) return;
  if (w.n && s >= w.n * w.lam) return;
  if (w.len && s >= w.len) return;
  if (w.keep && !w.keep(x, y)) return;
  let a = w.a;
  if (w.kind === 'point' && w.spread !== false) a *= Math.min(1, Math.sqrt((w.r0 || 8) / Math.max(1, dist)));
  if (w.fade) a *= w.fade(x, y, dist);
  let p, u;
  if (w.shape) { const q = w.shape(s); p = q[0]; u = q[1]; }
  else { p = w.n ? pulseP(s, w.lam, w.n) : cwP(s, w.lam); u = w.n ? pulseU(s, w.lam, w.n) : cwU(s, w.lam); }
  out[0] += p * a; out[1] += ux * u * a; out[2] += uy * u * a;
}
const O = [0, 0, 0];
export function fieldAt(comps, x, y, t) {
  O[0] = O[1] = O[2] = 0;
  for (const w of comps) evalComp(w, x, y, t, O);
  return O;
}

/* A field of particles at rest in a rectangle: a jittered grid, seeded. mat(x, y) names the
   tissue each one belongs to (for its colour and its spacing). */
export function makeField(x0, y0, w, h, sp, seed = 1, mat = null) {
  const r = rng(seed), pts = [];
  for (let y = y0; y < y0 + h; y += sp) for (let x = x0; x < x0 + w; x += sp) {
    const px = x + (r() - 0.5) * sp * 0.7, py = y + (r() - 0.5) * sp * 0.7;
    const m = mat ? mat(px, py) : 'soft';
    if (m == null) continue;
    pts.push({ x: px, y: py, m, ph: r() * 6.28 });
  }
  return pts;
}
// tissue colours: rest, compressed, rarefied
export const TIS = {
  soft: ['pink', 'white', 'dkred'], liver: ['muscle', 'peach', 'dkred'], fat: ['fat', 'white', 'brown'],
  fluid: ['dkblue', 'cyan', 'navy'], bone: ['bone', 'white', 'slate'], air: ['slate', 'grey', 'dkgrey'],
  gel: ['teal', 'cyan', 'dkblue'], pzt: ['gold', 'yellow', 'brown'], blood: ['red', 'pink', 'dkred'],
};
/* Draw the field under the given components. gain scales the displacement (px per unit), hot
   0..1 per particle (absorption) warms them. Returns nothing; the particles' positions are
   pure functions of t. */
export function drawField(px, pts, comps, t, { gain = 2.2, thr = 0.28, alpha = 1, heat = null, jiggle = 0.25, pal = TIS } = {}) {
  for (const q of pts) {
    const f = fieldAt(comps, q.x, q.y, t);
    const p = f[0];
    const jx = Math.sin(t * 9 + q.ph) * jiggle, jy = Math.cos(t * 7 + q.ph * 1.3) * jiggle;   // thermal motion
    const x = q.x + f[1] * gain + jx, y = q.y + f[2] * gain + jy;
    const c = pal[q.m] || pal.soft;
    let col = p > thr ? c[1] : p < -thr ? c[2] : c[0];
    // squeezed together and bright in a compression, spread and faint in a rarefaction
    let a = alpha * (q.m === 'air' ? 0.8 : 1) * (p > thr ? 0.75 + Math.min(0.25, p * 0.3) : p < -thr ? 0.45 : 0.6);
    if (heat) { const h = heat(q); if (h > 0.05) { col = h > 0.6 ? 'orange' : 'red'; a = Math.max(a, 0.5 + h * 0.5); } }
    px.px(x, y, col, a);
  }
}

// a panel for a plot or readout, kept clear of the caption
export function panel(api, x, y, w, h, a = 0.88) {
  const { px } = api;
  px.rect(x, y, w, h, 'ink', a); px.frame(x, y, w, h, 'dkgrey');
  api.keepOut([x, y, w, h]);
}
// a polyline through f(i) for i = 0..n-1 (points [x, y])
export function poly(px, n, f, c, a = 1) {
  let lx = null, ly = null;
  for (let i = 0; i < n; i++) {
    const p = f(i);
    if (!p) { lx = null; continue; }
    if (lx != null) px.line(lx, ly, p[0], p[1], c, a);
    [lx, ly] = p;
  }
}
// a small double-headed bracket between two points (a length marked in a scene)
export function span2(px, x0, y0, x1, y1, c = 'yellow', a = 1) {
  px.line(x0, y0, x1, y1, c, a);
  const L = Math.hypot(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / L * 2, ny = (x1 - x0) / L * 2;
  px.line(x0 - nx, y0 - ny, x0 + nx, y0 + ny, c, a); px.line(x1 - nx, y1 - ny, x1 + nx, y1 + ny, c, a);
}
// an arrow from (x0, y0) to (x1, y1)
export function arrow(px, x0, y0, x1, y1, c = 'yellow', a = 1) {
  px.line(x0, y0, x1, y1, c, a);
  const L = Math.hypot(x1 - x0, y1 - y0) || 1, ux = (x1 - x0) / L, uy = (y1 - y0) / L;
  px.line(x1, y1, x1 - ux * 3 - uy * 2, y1 - uy * 3 + ux * 2, c, a);
  px.line(x1, y1, x1 - ux * 3 + uy * 2, y1 - uy * 3 - ux * 2, c, a);
}

/* The probe's face across the top of an 8-bit scene: its lens over a row of elements, so the
   close-ups keep the 3D shot's orientation (probe up, sound going down). glow(i) lights element i. */
export function faceStrip(px, x0, x1, y, { n = 16, glow = null, lens = true } = {}) {
  const w = (x1 - x0) / n;
  px.rect(x0 - 3, y - 14, x1 - x0 + 6, 8, 'dkgrey');                // the backing
  for (let i = 0; i < n; i++) {
    const g = glow ? glow(i) : 0;
    px.rect(x0 + i * w + 1, y - 6, w - 2, 4, g > 0.05 ? (g > 0.5 ? 'white' : 'yellow') : 'gold', 1);
  }
  px.rect(x0 - 3, y - 2, x1 - x0 + 6, 1, 'orange', 0.8);             // matching layer
  if (lens) px.rect(x0 - 3, y - 1, x1 - x0 + 6, 2, 'lav', 0.9);      // lens
}

/* A seeded cloud of scatterers (cells, smaller than a wavelength) in a box: [x, y, strength]. */
export function scatterers(n, x0, y0, w, h, seed) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) out.push([x0 + r() * w, y0 + r() * h, 0.4 + r() * 0.6]);
  return out;
}
