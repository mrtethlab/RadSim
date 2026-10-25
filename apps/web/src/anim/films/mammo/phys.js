/* The mammography film's physics, for the 8-bit plots and fields: target/filter spectra (the kit's
   tungstenSpectrum is tungsten-only and diagnostic-energy), the filters' K edges, and the breast
   tissues' low-energy attenuation (the mode's own table: mammo.js MU_LOW, ICRU-44-flavoured). */
import { PAL } from '../../pixel.js';

// ---- the breast tissues, cm^-1 (mammo.js MU_LOW, the same anchors, log-interpolated)
const MU_E = [15, 17.5, 20, 25, 30, 40];
const MU_LOW = {
  fat: [1.05, 0.72, 0.53, 0.36, 0.28, 0.22],
  gland: [1.62, 1.09, 0.79, 0.50, 0.37, 0.27],
  skin: [1.72, 1.16, 0.84, 0.54, 0.39, 0.28],
  muscle: [1.68, 1.13, 0.82, 0.53, 0.38, 0.27],
  calc: [30.0, 20.0, 13.7, 7.3, 4.4, 2.0],
};
export function muT(m, keV) {
  const row = MU_LOW[m] || MU_LOW.gland;
  const e = Math.min(Math.max(keV, MU_E[0]), MU_E[MU_E.length - 1]);
  let i = 0;
  while (i + 2 < MU_E.length && MU_E[i + 1] < e) i++;
  const f = (Math.log(e) - Math.log(MU_E[i])) / (Math.log(MU_E[i + 1]) - Math.log(MU_E[i]));
  return Math.exp(Math.log(row[i]) + f * (Math.log(row[i + 1]) - Math.log(row[i])));
}
/* The photoelectric share of a tissue's interactions at E (the rest Compton, and a few percent
   coherent): water-like tissue crosses over near 26 keV, fat (lower Z) a little lower, calcium
   (Z 20) far higher. */
export const fPE = (m, E) => 1 / (1 + (E / (m === 'calc' ? 60 : m === 'fat' ? 23 : 26)) ** 3);

// ---- the anode and filter metals
// K edges (keV) and characteristic lines (Ka, Kb); mass attenuation just below the K edge (cm^2/g),
// the jump ratio across it, density (g/cm^3)
export const METAL = {
  Mo: { Z: 42, edge: 20.0, ka: 17.5, kb: 19.6, below: 13.0, jump: 6.2, rho: 10.22 },
  Rh: { Z: 45, edge: 23.22, ka: 20.2, kb: 22.7, below: 9.4, jump: 6.4, rho: 12.41 },
  Ag: { Z: 47, edge: 25.51, ka: 22.2, kb: 24.9, below: 8.0, jump: 6.2, rho: 10.49 },
  W: { Z: 74, edge: 69.5, ka: 59.3, kb: 67.2 },
  Al: { Z: 13, rho: 2.70 },
  Be: { Z: 4, rho: 1.85 },
};
// mass attenuation (cm^2/g): a power law in E, stepping up by the jump ratio at the K edge
export function muRho(metal, E) {
  if (metal === 'Be') return 0.646 * (10 / E) ** 2.9 + 0.15;          // mostly scatter above 15 keV
  if (metal === 'Al') return 26.2 * (10 / E) ** 2.85 + 0.17;
  const m = METAL[metal];
  const v = m.below * (E / m.edge) ** -2.7;
  return E >= m.edge ? v * m.jump : v;
}
// transmission of a foil: thickness in µm
export const foilT = (metal, E, um) => Math.exp(-muRho(metal, E) * METAL[metal].rho * um * 1e-4);

/* A target/filter's spectrum at kVp (energy fluence per keV, 0..1 by its own peak unless norm is
   given): Kramers' bremsstrahlung (kVp - E), the 1 mm beryllium window, the filter foil, and the
   target's own K lines when the kV can free a K electron. tf: 'MoMo' | 'MoRh' | 'RhRh' | 'WRh' |
   'WAg' | 'Mo' (no filter) | 'W' (none). */
export const TFS = {
  MoMo: { target: 'Mo', filter: 'Mo', um: 30 },
  MoRh: { target: 'Mo', filter: 'Rh', um: 25 },
  RhRh: { target: 'Rh', filter: 'Rh', um: 25 },
  WRh: { target: 'W', filter: 'Rh', um: 50 },
  WAg: { target: 'W', filter: 'Ag', um: 50 },
  Mo: { target: 'Mo', filter: null, um: 0 },
  W: { target: 'W', filter: null, um: 0 },
};
export function spectrum(tf, kVp, { filterUm = null, lines = true, brems = true } = {}) {
  const d = TFS[tf], tg = METAL[d.target];
  const um = filterUm ?? d.um;
  const pts = [];
  let mx = 0;
  const lineAmp = (d.target !== 'W' && lines && kVp > tg.edge) ? Math.min(1.6, 1.25 * (kVp / tg.edge - 1) ** 1.3 * 4) : 0;
  for (let E = 1; E <= kVp + 0.01; E += 0.25) {
    let w = brems ? Math.max(0, kVp - E) * (d.target === 'W' ? 1.4 : 1) / kVp : 0;     // W makes more (Z 74)
    // the target's own self-absorption above its edge (a soft dip in a Mo spectrum just past 20)
    if (d.target !== 'W' && E > tg.edge) w *= 0.8;
    if (lineAmp) {
      w += lineAmp * 1.0 * Math.exp(-((E - tg.ka) ** 2) / 0.08);
      w += lineAmp * 0.24 * Math.exp(-((E - tg.kb) ** 2) / 0.08);
    }
    w *= Math.exp(-muRho('Be', E) * 1.85 * 0.1);                  // the window
    if (d.filter && um > 0) w *= foilT(d.filter, E, um);
    pts.push([E, w]);
    mx = Math.max(mx, w);
  }
  const f = (E) => {
    const i = Math.round((E - 1) / 0.25);
    return i < 0 || i >= pts.length ? 0 : pts[i][1];
  };
  f.peak = mx;
  f.mean = (() => { let a = 0, b = 0; for (const [E, w] of pts) { a += E * w; b += w; } return b ? a / b : 0; })();
  return f;
}
// a spectrum scaled to a given peak (so two can share an axis): norm(f, k)(E) = f(E) / k
export const scaled = (f, k) => (E) => f(E) / k;

// a photon's colour by energy on the mammography scale (10-35 keV): red soft to violet hard
export function mkeV(E) {
  if (E < 14) return PAL.dkred;
  if (E < 17) return PAL.red;
  if (E < 19) return PAL.orange;
  if (E < 21) return PAL.yellow;
  if (E < 24) return PAL.lime;
  if (E < 28) return PAL.cyan;
  if (E < 32) return PAL.blue;
  return PAL.violet;
}

/* A mammography spectrum plot on the 8-bit layer: 0..axisMax keV, bars coloured by energy,
   an optional 'before' outline (what the filter took), the K edges as dashed lines, energies of
   the lines marked, and the kVp tick. */
export function mSpectrumPlot(px, x, y, w, h, kVp, f, { fill = 1, before = null, edges = [], lines = [], axisMax = 40, ticks = [10, 20, 30], label = true, kvp = true, curve = null } = {}) {
  px.rect(x, y, w, h, 'ink', 0.88);
  px.frame(x, y, w, h, 'dkgrey');
  const x0 = x + 3, y0 = y + h - 8, pw = w - 6, ph = h - 13;
  px.rect(x0, y0, pw, 1, 'mid');
  for (const T of ticks) {
    const tx = x0 + Math.round((T / axisMax) * pw);
    px.rect(tx, y0 + 1, 1, 2, 'mid');
    if (label) px.text(String(T), tx, y0 + 3, 'mid', 1, 1, 'center');
  }
  for (const E of edges) {
    const ex = x0 + Math.round((E / axisMax) * pw);
    for (let yy = y0 - ph; yy < y0; yy += 3) px.px(ex, yy, 'pink', 0.8);
  }
  for (let i = 0; i < pw; i++) {
    const E = (i / pw) * axisMax, E2 = ((i + 1) / pw) * axisMax;
    if (E > kVp) break;
    // the bar: the most in this column's keV span (lines are narrower than a column)
    let v = 0, vb = 0;
    for (let e = E; e < E2; e += 0.25) { v = Math.max(v, f(e)); if (before) vb = Math.max(vb, before(e)); }
    v *= fill; vb *= fill;
    const hh = Math.round(Math.min(1, v) * ph);
    if (hh > 0) px.rect(x0 + i, y0 - hh, 1, hh, mkeV(E), 0.95);
    if (before) {
      const hb = Math.round(Math.min(1, vb) * ph);
      if (hb > hh) { px.px(x0 + i, y0 - hb, 'grey', 0.85); if (hb - hh > 2) px.rect(x0 + i, y0 - hb + 1, 1, hb - hh - 1, 'slate', 0.25); }
    }
  }
  if (curve) {                                   // a transmission curve 0..1 over the same axis
    let lx = null, ly = null;
    for (let i = 0; i < pw; i++) {
      const E = (i / pw) * axisMax;
      if (E < 5) continue;
      const yy = y0 - Math.round(Math.min(1, curve(E)) * ph);
      if (lx != null) px.line(lx, ly, x0 + i, yy, 'white', 0.7);
      lx = x0 + i; ly = yy;
    }
  }
  for (const E of lines) {
    const lx = x0 + Math.round((E / axisMax) * pw);
    px.rect(lx, y0 - ph - 2, 1, 2, 'white', 0.9);
  }
  if (kvp) {
    const kx = x0 + Math.round((kVp / axisMax) * pw);
    px.rect(kx, y0, 1, 3, 'yellow');
  }
  if (label) px.text('keV', x + w - 3, y + 3, 'mid', 1, 1, 'right');
  return { x0, y0, pw, ph, xAt: (E) => x0 + Math.round((E / axisMax) * pw) };
}
