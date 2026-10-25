/* The 8-bit things every film shares: atoms, electrons, photons coloured by energy, and the
   plots that build up as the film runs (a spectrum, a histogram, a response curve). All drawn on
   a PixelLayer, in its pixels; all a function of the time given, never of the frame rate. */
import { PAL } from '../pixel.js';
import { Materials } from '../../core/materials.js';

// a photon's colour by its energy: soft (low keV) red to hard (high keV) violet-white
export function keVColor(keV) {
  if (keV < 25) return PAL.red;
  if (keV < 35) return PAL.orange;
  if (keV < 45) return PAL.yellow;
  if (keV < 60) return PAL.lime;
  if (keV < 75) return PAL.cyan;
  if (keV < 95) return PAL.blue;
  return PAL.violet;
}

/* An atom: a nucleus and its shells as rings of electrons that turn. r is the outer radius;
   shells = electrons per shell drawn (a hint of the real count); heat 0..1 shakes and reddens it. */
export function atom(px, x, y, r, t, { shells = [2, 8, 8], nucleus = 'orange', ring = 'dkgrey', e = 'blue', heat = 0, seed = 0, missing = -1, a = 1 } = {}) {
  if (heat > 0) {
    const j = heat * 2.2;
    x += Math.round(Math.sin(t * 37 + seed * 3.1) * j);
    y += Math.round(Math.cos(t * 41 + seed * 1.7) * j);
    px.glow(x, y, Math.round(r * (0.9 + heat * 0.6)), heat > 0.6 ? 'orange' : 'red', 0.55 * heat, seed);
    if (heat > 0.3) { ring = heat > 0.65 ? 'red' : 'plum'; e = heat > 0.65 ? 'peach' : 'pink'; }
  }
  const n = shells.length;
  for (let s = 0; s < n; s++) {
    const rr = Math.max(2, Math.round(r * (s + 1) / n));
    px.circle(x, y, rr, ring, 0.5 * a);
    const k = shells[s];
    for (let i = 0; i < k; i++) {
      if (s === 0 && i === missing) continue;
      const ang = t * (2.2 - s * 0.5) * (s % 2 ? -1 : 1) + (i / k) * Math.PI * 2 + seed;
      px.px(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr, e, a);
    }
  }
  px.rect(x - 1, y - 1, 3, 3, nucleus, a);
  px.px(x, y, 'yellow', a);
}

export function electron(px, x, y, a = 1, c = 'cyan') {
  px.rect(x - 1, y - 1, 3, 3, c, a * 0.9); px.rect(x - 2, y, 5, 1, c, a * 0.45); px.rect(x, y - 2, 1, 5, c, a * 0.45);
  px.px(x, y, 'white', a);
}

// a trail of fading pixels behind a moving point (pts: newest last)
export function trail(px, pts, c, a = 1) {
  for (let i = 0; i < pts.length; i++) px.px(pts[i][0], pts[i][1], c, a * (i + 1) / pts.length * 0.8);
}

/* The x-ray spectrum as a bar plot: intensity per keV from 0 to kVp. counts(E) gives the height,
   0..1; marks draws the characteristic lines' energies; fill 0..1 grows it up from nothing. */
export function spectrumPlot(px, x, y, w, h, kVp, counts, { fill = 1, label = true, hard = null, lines = [], axisMax = 150 } = {}) {
  px.rect(x, y, w, h, 'ink', 0.85);
  px.frame(x, y, w, h, 'dkgrey');
  const x0 = x + 3, y0 = y + h - 7, pw = w - 6, ph = h - 12;
  px.rect(x0, y0, pw, 1, 'mid');
  px.rect(x0, y0 - ph, 1, ph, 'mid');
  for (let i = 0; i < pw; i++) {
    const E = (i / pw) * axisMax;
    if (E > kVp) break;
    let v = counts(E) * fill;
    if (v <= 0) continue;
    const hh = Math.round(Math.min(1, v) * ph);
    px.rect(x0 + i, y0 - hh, 1, hh, keVColor(E), 0.95);
    if (hard) {                                   // what the filter takes out: the outline of before
      const hb = Math.round(Math.min(1, hard(E) * fill) * ph);
      if (hb > hh) px.px(x0 + i, y0 - hb, 'grey', 0.8);
    }
  }
  for (const E of lines) {
    const xx = x0 + Math.round((E / axisMax) * pw);
    px.rect(xx, y0 - ph, 1, 2, 'white', 0.8);
  }
  if (label) {
    px.text('keV', x + w - 3, y + h - 6, 'mid', 1, 1, 'right');
    const kx = x0 + Math.round((kVp / axisMax) * pw);
    px.rect(kx, y0, 1, 2, 'yellow');
    px.text(String(Math.round(kVp)), kx, y0 + 2, 'yellow', 1, 1, 'center');
  }
}

/* A tungsten anode's spectrum: Kramers' bremsstrahlung (kVp - E), hardened by the given
   aluminium (cm), with tungsten's K lines (57-59, 67 keV) when kVp is above the K edge (69.5). */
export function tungstenSpectrum(kVp, alCm = 0.25, lines = true) {
  const pts = [];
  let mx = 0;
  for (let E = 1; E <= kVp; E += 0.5) {
    let w = Math.max(0, kVp - E) * Math.exp(-Materials.muAl(Math.max(10, E)) * alCm);
    if (E < 10) w *= Math.exp(-(10 - E));
    pts.push([E, w]);
    mx = Math.max(mx, w);
  }
  const k = lines && kVp > 69.5 ? 1 : 0;
  return (E) => {
    const i = Math.min(pts.length - 1, Math.max(0, Math.round((E - 1) / 0.5)));
    let v = (pts[i]?.[1] ?? 0) / (mx || 1) * 0.72;
    if (k) {
      for (const [L, a] of [[57.98, 0.55], [59.32, 0.95], [67.2, 0.35]]) v += a * Math.exp(-((E - L) ** 2) / 0.6);
    }
    return v;
  };
}

/* A histogram of values 0..1 (an image's pixels), bars growing to their height by fill. */
export function histogramPlot(px, x, y, w, h, values, { bins = 48, fill = 1, voi = null, color = 'grey', clip = false } = {}) {
  px.rect(x, y, w, h, 'ink', 0.85);
  px.frame(x, y, w, h, 'dkgrey');
  const H = new Array(bins).fill(0);
  for (const v of values) H[Math.min(bins - 1, Math.max(0, Math.floor(v * bins)))]++;
  // clip: scale to the second-tallest bin, so one spike (an open field) does not flatten the rest
  const mx = clip ? Math.max(1, [...H].sort((a, b) => b - a)[1] * 1.15) : Math.max(1, ...H);
  const x0 = x + 3, y0 = y + h - 4, pw = w - 6, ph = h - 8;
  if (voi) px.rect(x0 + voi[0] * pw, y0 - ph, (voi[1] - voi[0]) * pw, ph, 'dkblue', 0.6);
  for (let b = 0; b < bins; b++) {
    const bh = Math.round(Math.min(1, H[b] / mx) * ph * fill);
    const bx = x0 + Math.floor((b / bins) * pw), bw = Math.max(1, Math.floor(pw / bins));
    if (bh > 0) px.rect(bx, y0 - bh, bw, bh, color);
  }
  px.rect(x0, y0, pw, 1, 'mid');
  return H;
}

// a curve y = f(x) on 0..1 x 0..1, drawn as a pixel line in a box
export function curvePlot(px, x, y, w, h, f, { color = 'yellow', grid = true, a = 1 } = {}) {
  px.rect(x, y, w, h, 'ink', 0.85);
  px.frame(x, y, w, h, 'dkgrey');
  if (grid) px.line(x + 1, y + h - 2, x + w - 2, y + 1, 'dkgrey', 0.6, 2);
  let lx = null, ly = null;
  for (let i = 0; i <= w - 3; i++) {
    const v = Math.max(0, Math.min(1, f(i / (w - 3))));
    const xx = x + 1 + i, yy = y + h - 2 - v * (h - 3);
    if (lx != null) px.line(lx, ly, xx, yy, color, a);
    lx = xx; ly = yy;
  }
}

// transmission through t cm of a tissue at E keV (Materials: soft, bone, marrow)
export const transmit = (mat, E, tcm) => Math.exp(-Materials.mu(mat, E) * tcm);
