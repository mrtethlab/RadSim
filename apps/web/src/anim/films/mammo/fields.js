/* The mammography film's 8-bit fields of atoms: the anode's molybdenum (electrons in, heat,
   bremsstrahlung, the K lines out) and a filter foil (photons in from above, the K-edge choosing
   which get through). Directions are the 3D shots' they zoom from: the side view, chest wall on
   the left, so the electrons arrive from the cathode on the left and the beam leaves downward.
   Every scene is a function of t, iterating only its recent events, so a held step runs on. */
import { atom, electron } from '../../kit/micro.js';
import { mkeV, foilT, METAL } from './phys.js';
import { cycleAt, recentIdx } from './common.js';

/* The anode. opts: rate (electrons a second), hi ('brems' | 'ka' | 'kb' | 'alt': ka then kb),
   hiAt (the first highlighted one's birth), every (repeat period), slow (how much slower it plays),
   avoid ([x,y,w,h] boxes the highlight must keep clear of), kVp. Returns { atoms, F } (F: the
   highlighted event, with its stage). */
export function moTarget(api, t, { rate = 4, hi = null, hiAt = 1, every = 9, slow = 3, avoid = [], kVp = 28, showHeat = true, edge = 20 } = {}) {
  const { px, lerp, clamp01, rng } = api;
  px.fillAll('ink');
  const W = px.W, H = px.H, sp = 26;
  const atoms = [];
  for (let y = 14; y < H - 10; y += sp) for (let x = 12 + ((y / sp) % 2) * sp / 2; x < W - 30; x += sp) atoms.push([x, y]);
  const heat = new Float32Array(atoms.length);
  const N = Math.floor(t * rate);
  const hiT = hi ? cycleAt(t, hiAt, every) : -1;
  const fi = hi ? Math.floor(hiT * rate) : -1;
  const kind0 = (i, r) => { const u = r(); return u < 0.86 ? 'heat' : u < 0.975 || kVp <= edge ? 'brems' : (u < 0.995 ? 'ka' : 'kb'); };
  const events = [];
  for (const i of recentIdx(N, rate, 9, fi)) {
    const r = rng(1000 + i);
    let kind = kind0(i, r);
    const focus = i === fi;
    if (focus) kind = hi === 'alt' ? (Math.round((hiT - hiAt) / every) % 2 ? 'kb' : 'ka') : hi;
    const age = (t - i / rate) / (focus ? slow : 1);
    if (age < 0) continue;
    let tgt = atoms[Math.floor(r() * atoms.length)];
    if (focus) {
      const ok = (a) => a[1] > H * 0.2 && a[1] < H * 0.5 && a[0] > W * 0.35 && a[0] < W * 0.78
        && avoid.every((b) => a[0] < b[0] - 18 || a[0] > b[0] + b[2] + 18 || a[1] < b[1] - 18 || a[1] > b[1] + b[3] + 18);
      for (let k = 0; k < 80 && !ok(tgt); k++) tgt = atoms[Math.floor(r() * atoms.length)];
    }
    events.push({ i, kind, age, tgt, r, focus });
  }
  const F = events.find((e) => e.focus);
  const focusOn = F && F.age < 3.6;
  const dim = focusOn ? 0.3 : 1;
  for (const ev of events) {
    if (ev.kind === 'heat' && ev.age > 0.6 && ev.age < 7) {
      for (let k = 0; k < atoms.length; k++) {
        const d = Math.hypot(atoms[k][0] - ev.tgt[0], atoms[k][1] - ev.tgt[1]);
        if (d < sp * 1.6) heat[k] += 0.55 * Math.exp(-(ev.age - 0.6) * 0.45) * (1 - d / (sp * 1.6));
      }
    }
  }
  for (let k = 0; k < heat.length; k++) heat[k] = showHeat ? heat[k] + 0.25 : heat[k] * 0.25;
  atoms.forEach(([x, y], k) => atom(px, x, y, 8, t, { shells: [2, 8, 12], seed: k, heat: Math.min(1, heat[k]),
    ring: 'navy', e: 'blue', nucleus: 'orange', a: focusOn && F.tgt === atoms[k] ? 1 : dim,
    missing: F && (F.kind === 'ka' || F.kind === 'kb') && F.tgt === atoms[k] && F.age > 0.8 && F.age < 1.95 ? 0 : -1 }));
  for (const ev of events) {
    const { kind, age, tgt, r, focus } = ev;
    const a = focus ? 1 : dim * 0.85, ec = focus ? 'yellow' : 'cyan';
    const startY = tgt[1] + (r() - 0.5) * 6;
    if (kind === 'heat') {
      if (age > 1.6) continue;
      const pos = (ag) => { const k = ag / 1.6; return [lerp(-4, tgt[0] + 12, Math.sqrt(k)), startY + Math.sin(ag * 9 + ev.i) * 4 * k]; };
      for (let j = 1; j <= 4; j++) { const q = pos(Math.max(0, age - j * 0.03)); px.px(q[0], q[1], 'blue', a * (0.5 - j * 0.1)); }
      const [x, y] = pos(age);
      electron(px, x, y, a * (1 - (age / 1.6) * 0.6));
    } else if (kind === 'brems') {
      // past the nucleus at impact distance b: the closer, the harder it is bent and braked
      const b = focus ? 4 : 2 + r() * 9, E = Math.min(kVp, kVp * (1 - b / 12) * (0.6 + r() * 0.4));
      const tIn = 0.9, nx = tgt[0], ny = tgt[1] - b, bend = (1 - b / 12) * 1.2;
      const path = (ag) => {
        if (ag < tIn) return [lerp(-4, nx, ag / tIn), ny];
        const k = Math.min(1.4, (ag - tIn) / 0.8);
        return [nx + Math.cos(bend) * 40 * k * (0.4 + b / 12), ny + Math.sin(bend) * 40 * k * 0.6];
      };
      if (focus) {
        for (let ag = 0; ag < Math.min(age, tIn + 1.1); ag += 0.04) { const q = path(ag); px.px(q[0], q[1], 'yellow', 0.45); }
        if (age < 3.6) { api.mark([nx - 13, ny - 13 + b, 26, 26], 'yellow', t); api.keepOut([nx - 30, ny + b + 10, 52, 90]); }
      }
      const [ex, ey] = path(age);
      if (age < tIn + 1.05) electron(px, ex, ey, a * (age < tIn ? 1 : 1 - (age - tIn) / 1.2), age < tIn ? ec : 'blue');
      const pa = age - tIn;
      if (pa > 0 && pa < 2.2) {
        const ang = focus ? Math.PI / 2 - 0.3 : Math.PI / 2 + (r() - 0.5) * 1.8;     // down, toward the port
        const L = pa * 80, fx = nx + Math.cos(ang) * L, fy = ny + Math.sin(ang) * L;
        if (fx > -5 && fx < W + 5 && fy > -5 && fy < H + 5) px.photon(fx, fy, Math.cos(ang), Math.sin(ang), focus ? 10 : 6, mkeV(E), focus ? 1 : a, t * 30 + ev.i);
        if (pa < 0.15) px.glow(nx, ny, focus ? 6 : 4, 'white', 0.9, ev.i);
      }
    } else {
      // characteristic: a K electron knocked out (it takes more than 20 keV), the hole filled from
      // the L shell (Ka, 17.5 keV) or the M shell (Kb, 19.6 keV), the difference leaving as a photon
      const tIn = 0.8, E = kind === 'ka' ? 17.5 : 19.6;
      if (age < tIn) {
        const k = age / tIn;
        if (focus) for (let ag = 0; ag < age; ag += 0.04) px.px(lerp(-4, tgt[0] - 2, ag / tIn), lerp(startY, tgt[1], ag / tIn), 'yellow', 0.45);
        electron(px, lerp(-4, tgt[0] - 2, k), lerp(startY, tgt[1], k), a, ec);
        if (focus) { api.mark([tgt[0] - 13, tgt[1] - 13, 26, 26], 'yellow', t); api.keepOut([tgt[0] - 30, tgt[1] + 16, 60, 90]); }
        continue;
      }
      const e = age - tIn;
      if (e < 1.2) {
        electron(px, tgt[0] - e * 30, tgt[1] - e * 22, a * (1 - e / 1.2), focus ? 'red' : 'cyan');   // the K electron, out
        electron(px, tgt[0] + e * 36, tgt[1] - e * 10, a * (1 - e / 1.2), 'blue');                  // the incoming one, on
      }
      if (e < 2.6) {
        const drop = clamp01((e - 0.45) / 0.55);
        const hx = tgt[0] + 3, hy = tgt[1];
        if (drop < 1 && focus) px.frame(hx - 2, hy - 2, 5, 5, 'red', 0.9);
        // from the second shell (L) for Ka, the third (M) for Kb: drawn from farther out
        const from = kind === 'ka' ? [tgt[0] + 6, tgt[1] - 5] : [tgt[0] + 7, tgt[1] - 9];
        if (drop > 0 && drop < 1) { const lx = lerp(from[0], hx, drop), ly = lerp(from[1], hy, drop); px.rect(lx - 1, ly - 1, 3, 3, 'yellow', a); }
        if (e > 1.0) {
          const pa = e - 1.0, ang = focus ? Math.PI / 2 + 0.3 : Math.PI / 2 + ((ev.i % 5) - 2) * 0.35, L = pa * 80;
          if (pa < 1.7) px.photon(hx + Math.cos(ang) * L, hy + Math.sin(ang) * L, Math.cos(ang), Math.sin(ang), focus ? 10 : 6, mkeV(E), focus ? 1 : a, t * 30);
        }
        if (focus) { api.mark([tgt[0] - 13, tgt[1] - 13, 26, 26], 'yellow', t); api.keepOut([tgt[0] - 30, tgt[1] + 16, 60, 90]); }
      }
    }
  }
  return { atoms, F };
}

/* A filter foil seen edge-on: a band of atoms across the middle; photons fall from the top with
   energies drawn from the spectrum given; each is absorbed in the foil with the probability its
   thickness gives at its energy (photoelectric: a K electron out when it can, and then, often, the
   metal's own K fluorescence leaving in any direction), or passes. hiE: the energy of a
   highlighted photon (absorbed if it would be, else passing), every `every` s. */
export function foilScene(api, t, { metal = "Mo", um = 30, sample, rate = 40, hiE = null, hiAt = 1, every = 7, slow = 3, panel = null } = {}) {
  const { px, lerp, clamp01, rng } = api;
  px.fillAll('ink');
  const W = px.W, H = px.H;
  const fy0 = Math.round(H * 0.44), fy1 = Math.round(H * 0.58), sp = 22;
  const x0 = 8, x1 = W - 8;
  // the foil: three rows of atoms in a slab
  px.rect(x0, fy0, x1 - x0, fy1 - fy0, 'slate', 0.25);
  const atoms = [];
  for (let y = fy0 + 5; y < fy1; y += 10) for (let x = x0 + 6 + ((y / 10) % 2) * 11; x < x1 - 4; x += sp) atoms.push([x, y]);
  const N = Math.floor(t * rate);
  const hiT = hiE ? cycleAt(t, hiAt, every) : -1;
  const fi = hiE ? Math.floor(hiT * rate) : -1;
  const v = 120;                                       // pixels a second
  const ev = [];
  for (const i of recentIdx(N, rate, 3, fi)) {
    const r = rng(7000 + i), focus = i === fi;
    let E = focus ? hiE : sample(r);
    const x = focus ? Math.round(W * 0.42) : x0 + 4 + r() * (x1 - x0 - 8);
    const absorbed = focus ? foilT(metal, E, um) < 0.5 : r() > foilT(metal, E, um);
    const depth = fy0 + 2 + r() * (fy1 - fy0 - 4);
    const age = (t - i / rate) / (focus ? slow : 1);
    if (age < 0) continue;
    ev.push({ i, r, E, x, absorbed, depth, age, focus, fluor: r() < 0.7 && E > METAL[metal].edge, dir: r() * Math.PI * 2 });
  }
  const F = ev.find((e) => e.focus);
  const focusOn = F && F.age < 3.4;
  const dim = focusOn ? 0.55 : 1;
  atoms.forEach(([x, y], k) => atom(px, x, y, 4, t, { shells: [2, 8], ring: 'lead', e: 'grey', nucleus: 'orange', seed: k,
    a: focusOn && F.absorbed && Math.abs(x - F.x) < sp / 2 && Math.abs(y - F.depth) < 6 ? 1 : dim * 0.9 }));
  const passed = [];
  for (const e of ev) {
    const a = e.focus ? 1 : dim * 0.9, y = -6 + e.age * v;
    if (!e.absorbed) {
      if (y < H + 6) px.photon(e.x, y, 0, 1, e.focus ? 9 : 5, mkeV(e.E), a, t * 30 + e.i);
      if (y > fy1) passed.push(e.E);
      continue;
    }
    if (y < e.depth) { px.photon(e.x, y, 0, 1, e.focus ? 9 : 5, mkeV(e.E), a, t * 30 + e.i); continue; }
    const k = (y - e.depth) / v;                         // seconds since it was absorbed
    if (k < 0.18) px.glow(e.x, e.depth, e.focus ? 6 : 3, 'white', 0.9, e.i);
    // the photoelectron: out of the K shell when the photon could free one
    if (k < 0.8) electron(px, e.x + k * 50 * (e.i % 2 ? 1 : -1), e.depth - k * 16, (1 - k / 0.8) * a, e.E > METAL[metal].edge ? 'red' : 'cyan');
    // fluorescence: the hole refilled, the metal's own Ka leaving in any direction
    if (e.fluor && k > 0.5 && k < 2.4) {
      const L = (k - 0.5) * 70, dx = Math.cos(e.dir), dy = Math.sin(e.dir);
      px.photon(e.x + dx * L, e.depth + dy * L, dx, dy, e.focus ? 8 : 4, mkeV(METAL[metal].ka), a * 0.9, t * 30 + e.i);
    }
  }
  if (F && focusOn) {
    const b = [F.x - 12, F.absorbed ? F.depth - 12 : fy0 - 6, 24, F.absorbed ? 24 : fy1 - fy0 + 12];
    api.mark(b, 'yellow', t);
    api.keepOut([F.x - 40, fy0 - 40, 80, fy1 - fy0 + 80]);
  }
  void clamp01; void lerp; void panel;
  return { fy0, fy1, F, passed };
}
