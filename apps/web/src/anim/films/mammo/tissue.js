/* The breast in 8-bit: a slice of compressed breast between the paddle (top) and the detector
   (bottom), as the side view sees it (chest wall to the left, the beam downward). Photons fall
   through it and each meets its fate by the mode's own attenuation table (phys.js muT): absorbed
   (photoelectric), scattered (Compton, coherent) or through. Columns of tissue side by side; a
   strip under them shows the image they make. Every scene iterates only its recent photons. */
import { electron } from '../../kit/micro.js';
import { muT, fPE, mkeV } from './phys.js';
import { cycleAt, recentIdx } from './common.js';

export const TCOL = { fat: 'fat', gland: 'pink', skin: 'peach', calc: 'white', muscle: 'muscle' };

/* cols: [{ layers: [[material, cm], ...] }]; cm: pixels a centimetre. opts: E (keV, or a sampler
   (r) => keV), rate, hi ('pe' | 'compton'), hiCol, hiAt/every/slow, strip, grid ({ ratio, pitch,
   h, phase }) between tissue and detector, scatter visible or not, x0/w the area used. */
export function tissueField(api, t, { cols, E = 18, rate = 40, hi = null, hiCol = null, hiAt = 1, every = 8, slow = 4,
  strip = true, grid = null, showScatter = true, x0 = 0, w = null, top = 12, cm = 20, dots = true, fogGain = 1 } = {}) {
  const { px, rng } = api;
  const W = w || px.W, L = x0 + 8;
  const colW = Math.floor((W - 16) / cols.length);
  const thick = Math.max(...cols.map((c) => c.layers.reduce((s, l) => s + l[1], 0)));
  const y0 = top + 16, yB = y0 + thick * cm, yDet = yB + (grid ? 20 : 6);
  const hiT = hi ? cycleAt(t, hiAt, every) : -1;
  const fi = hi ? Math.floor(hiT * rate) : -1;
  const fAge = hi ? (t - hiT) / slow : -1;
  const dimAll = hi && fAge >= 0 && fAge < 3.4 ? 0.4 : 1;
  // the paddle and the tissue
  px.rect(L - 4, y0 - 4, colW * cols.length + 8, 3, 'cyan', 0.35);
  cols.forEach((c, ci) => {
    let y = y0;
    for (const [m, th] of c.layers) {
      const h = th * cm;
      if (m !== 'calc') px.rect(L + ci * colW + 1, y, colW - 2, h, TCOL[m], 0.15 * dimAll);
      if (dots && m !== 'calc') {
        const rr = rng(77 + ci * 13 + Math.round(y));
        const n = Math.round((m === 'fat' ? 0.004 : 0.006) * (colW - 2) * h);
        for (let k = 0; k < n; k++) px.rect(L + ci * colW + 3 + rr() * (colW - 6), y + 2 + rr() * (h - 4), 2, 2, m === 'fat' ? 'gold' : 'pink', 0.5 * dimAll);
      }
      y += h;
    }
    // specks of calcium: drawn at least 2 px (a 0.3 mm speck is 0.6 px at this scale)
    for (const s of c.specks || []) px.rect(L + ci * colW + s[0] * colW - 1, y0 + s[1] * cm - 1, 3, 3, 'white', 0.95);
    px.frame(L + ci * colW, y0, colW, thick * cm, 'dkgrey', 0.6);
  });
  // the grid: copper septa between the tissue and the detector, moving across during the exposure
  if (grid) {
    const off = ((grid.phase || 0) % grid.pitch + grid.pitch) % grid.pitch;
    for (let gx = L - grid.pitch + off; gx < L + colW * cols.length; gx += grid.pitch) if (gx >= L) px.rect(gx, yB + 18 - grid.h, 1, grid.h, 'brown');
  }
  px.rect(L, yDet, colW * cols.length, 4, 'navy');
  const counts = new Array(cols.length).fill(0), fog = new Array(cols.length).fill(0), seen = new Array(cols.length).fill(0);
  const N = Math.floor(t * rate);
  const v = 150;
  let focus = null;
  const win = 2.6;
  for (const i of recentIdx(N, rate, win, fi)) {
    const r = rng(5000 + i), isF = i === fi;
    const ci = isF && hiCol != null ? hiCol : Math.floor(r() * cols.length), col = cols[ci];
    const e = typeof E === 'function' ? E(r) : E;
    const xIn = isF ? L + ci * colW + colW / 2 : L + ci * colW + 4 + r() * (colW - 8);
    // its history: the depth it interacts at (or none), and how
    let h = { type: 'through', depth: thick };
    const hist = () => {
      let depth = 0;
      for (const [m, th] of col.layers) {
        const d = -Math.log(1 - r() * 0.9999) / muT(m, e);
        if (d < th) { const u = r(); return { type: u < 0.06 ? 'coh' : u < 0.06 + fPE(m, e) * 0.94 ? 'pe' : 'compton', depth: depth + d, mat: m }; }
        depth += th;
      }
      return { type: 'through', depth: thick };
    };
    h = hist();
    // a speck in the photon's path: calcium takes it (photoelectric) almost every time
    for (const s of col.specks || []) if (Math.abs(xIn - (L + ci * colW + s[0] * colW)) < 2 && s[1] < h.depth && r() < 0.95) h = { type: 'pe', depth: s[1], mat: 'calc' };
    if (isF && hi) for (let k = 0; k < 80 && h.type !== hi; k++) h = hist();
    if (isF && hi === 'pe' && col.specks?.length) h = { type: 'pe', depth: col.specks[0][1], mat: 'calc' };
    const age = (t - i / rate) / (isF ? slow : 1);
    if (age < 0) continue;
    px.alpha = isF ? 1 : dimAll;
    const yHit = y0 + h.depth * cm, tHit = (yHit - (top - 8)) / v;
    if (isF) focus = { x: xIn, y: yHit, type: h.type, age, tHit, E: e };
    if (h.type === 'through') {
      const tDet = (yDet - (top - 8)) / v;
      if (age < tDet) px.photon(xIn, top - 8 + age * v, 0, 1, isF ? 9 : 5, mkeV(e), isF ? 1 : 0.85, t * 30 + i);
      else if (age - tDet < 0.1) px.rect(xIn - 1, yDet - 1, 3, 3, 'white', 0.8);
      counts[ci]++; seen[ci]++;
      continue;
    }
    seen[ci]++;
    if (age < tHit) { px.photon(xIn, top - 8 + age * v, 0, 1, isF ? 9 : 5, mkeV(e), isF ? 1 : 0.85, t * 30 + i); continue; }
    const k = age - tHit;
    if (h.type === 'pe') {
      if (k < 0.2) px.glow(xIn, yHit, isF ? 5 : 3, 'white', 0.9, i);
      if (k < 0.7) electron(px, xIn + k * 26 * (i % 2 ? 1 : -1), yHit + k * 10, (1 - k / 0.7) * (isF ? 1 : 0.7), 'cyan');
      continue;
    }
    // scattered: a new direction, a little less energy for Compton
    const ang = (r() - 0.5) * (h.type === 'coh' ? 0.8 : 2.8) + (r() < 0.3 ? Math.PI : 0);
    const sx = Math.sin(ang), sy = Math.cos(ang);
    const E2 = h.type === 'coh' ? e : e / (1 + (e / 511) * (1 - Math.cos(ang)));
    if (h.type === 'compton' && k < 0.6) electron(px, xIn - sx * k * 20, yHit + k * 8, (1 - k / 0.6) * 0.8, 'cyan');
    if (k < 0.12) px.glow(xIn, yHit, isF ? 4 : 2, 'orange', 0.8, i);
    const fx = xIn + sx * k * v, fy = yHit + sy * k * v;
    // the grid: an angled photon meets copper, the steeper the surer (a crossed grid: both ways)
    let stopY = Infinity;
    if (grid && sy > 0) {
      const tanA = Math.abs(sx / sy) + Math.abs(r() - 0.5) * 0.6, pass = Math.max(0, 1 - tanA * grid.ratio);
      if (((i * 2654435761) % 1000) / 1000 > pass) stopY = yB + 18 - grid.h + r() * grid.h;
    }
    if (fy >= stopY) { if (fy - stopY < 6) px.rect(fx - 1, stopY - 1, 3, 3, 'orange', 0.8); continue; }
    if (fy >= yDet) { const cx = Math.floor((fx - L) / colW); if (cx >= 0 && cx < cols.length) fog[cx]++; continue; }
    if (!showScatter) continue;
    if (fx < L - 8 || fx > L + colW * cols.length + 8 || fy < top - 10) continue;
    px.photon(fx, fy, sx, sy, isF ? 9 : 5, mkeV(E2), isF ? 1 : 0.8, t * 30 + i);
  }
  px.alpha = 1;
  if (focus && focus.age < focus.tHit + 2.6) {
    api.mark([focus.x - 9, focus.y - 9, 18, 18], 'yellow', t);
    api.keepOut([focus.x - 30, top - 10, 60, focus.y - top + 40]);          // its path, and what flies off
  }
  // the image: the share of photons arrived (plus scatter's fog), dark where many arrived
  // (from the columns' own transmission at the energy, not the few photons on screen; a speck by
  // its own chord; fogGain adds scatter's even fog)
  const tr = cols.map((c) => {
    const e = typeof E === 'function' ? 18 : E;
    let a = 0; for (const [m, th] of c.layers) a += muT(m, e) * th;
    return Math.exp(-a);
  });
  const tmax = Math.max(...tr);
  if (strip) {
    cols.forEach((c, ci) => {
      const f = tr[ci] / tmax * (1 - 0.35 * fogGain) + 0.35 * fogGain * (tr.reduce((s, x) => s + x, 0) / tr.length) / tmax;
      const g = Math.round(30 + (1 - Math.min(1, f)) * (c.stretch || 220));
      px.rect(L + ci * colW, yDet + 7, colW, 12, `rgb(${g},${g},${g})`);
      for (const s of c.specks || []) {
        const fs = f * Math.exp(-(muT('calc', typeof E === 'function' ? 18 : E) - muT('gland', typeof E === 'function' ? 18 : E)) * 0.03);
        const gs = Math.round(30 + (1 - Math.min(1, fs)) * (c.stretch || 220));
        px.rect(L + ci * colW + s[0] * colW - 1, yDet + 7, 3, 12, `rgb(${gs},${gs},${gs})`);
      }
    });
    px.frame(L, yDet + 7, colW * cols.length, 12, 'dkgrey');
  }
  return { L, colW, y0, yB, yDet, counts, fog, seen, focus, tr };
}
