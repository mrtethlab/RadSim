/* MODEL EDITOR FILM, chapter 2: the materials. Every voxel's id points into one list
   (core/materials.js BodyMaterials; the editor's palette is its first 29); each material has an HU
   and, what the physics uses, a linear attenuation coefficient mu(E). Then down to the atoms:
   water and fat, bone's hydroxyapatite, iodine's K-edge, the metals, each a field of its own
   molecules with a beam through it whose photons interact as often as that material's mu says
   (the app's own mu, at each photon's energy, drawn from an 80 kVp spectrum). */
import { BodyMaterials } from '../../../core/materials.js';
import { Spectrum } from '../../../core/spectrum.js';
import { atom, electron, keVColor } from '../../kit/micro.js';
import { RGB } from './data.js';
import { panel } from './pix.js';

const LIST = BodyMaterials.LIST;
const mu = (name, E) => BodyMaterials.muByName(name, E);
const rgbS = (c, k = 1) => `rgb(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)})`;

export function matter(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const spec = Spectrum.make(80).bins;
  const sampleE = (r) => { let u = r(), acc = 0; for (const b of spec) { acc += b.w; if (u <= acc) return b.E + (r() - 0.5) * 3; } return 40; };
  // the share of interactions that are photoelectric: about 1 / (1 + (E / Ec)^3), Ec where it
  // equals Compton's (water about 30 keV; higher the higher the atomic number)
  const fPE = (Ec) => (E) => 1 / (1 + (E / Ec) ** 3);

  /* A beam through a field of a material: photons fall from the top; each interacts within the
     panel with probability 1 - exp(-mu(E) * DEFF) (the same depth for every panel, so the panels
     compare as the materials do), photoelectric or Compton by fpe(E). Only the last few seconds'
     photons are worked through (a held step runs on). focus: { at, kind, x, slow } forces one
     photon's story, slowed and drawn yellow, the rest dimmed round it. */
  const DEFF = 1.6;                                        // cm the panel stands for, in the odds
  function beam(t, o) {
    const { x, y, w, h, muE, fpe, seed = 1, rate = 26, focus = null, atomsAt = null } = o;
    const v = 110, N = Math.floor(t * rate);
    const fi = focus ? Math.floor(focus.at * rate) : -1;
    const fAge = focus ? (t - fi / rate) / focus.slow : -1;
    const dim = focus && fAge > 0 && fAge < 3.4 ? 0.35 : 1;
    let ev = null, through = 0, total = 0;
    for (let i = Math.max(0, N - rate * 4); i <= N; i++) {
      const r = rng(seed * 7919 + i), isF = i === fi;
      const age = (t - i / rate) / (isF ? focus.slow : 1);
      if (age < 0) continue;
      let E = isF && focus.E ? focus.E : sampleE(r);
      const px0 = isF && focus.x != null ? x + focus.x : x + 3 + r() * (w - 6);
      const m = muE(E), pInt = 1 - Math.exp(-m * DEFF);
      let depth = -Math.log(1 - r() * 0.9999) / m / DEFF * h;          // pixels
      let kind = depth < h ? (r() < fpe(E) ? 'pe' : 'compton') : 'through';
      if (isF) { kind = focus.kind; depth = focus.depth * h; }
      // land on an atom: the nearest one under the photon's path
      let hx = px0, hy = y + depth;
      if (kind !== 'through' && atomsAt) { const a = atomsAt(px0, hy); if (a) { hx = a[0]; hy = a[1]; } }
      const tHit = (hy - y + 8) / v;
      const a = isF ? 1 : dim * 0.9;
      total++; if (kind === 'through') through++;
      void pInt;
      if (age < tHit || kind === 'through') {
        const yy = y - 8 + age * v;
        if (yy > y + h + 6) continue;
        const xx = kind === 'through' ? px0 : lerp(px0, hx, clamp01(age / tHit));
        px.photon(xx, yy, 0, 1, isF ? 10 : 7, isF ? 'yellow' : keVColor(E), a, t * 30 + i);
        if (isF) ev = { x: xx, y: yy, kind, done: false };
        continue;
      }
      const e = age - tHit;
      if (kind === 'pe') {
        if (e < 0.25) px.glow(hx, hy, isF ? 6 : 3, 'white', 0.9, i);
        if (e < 1.0) electron(px, hx + e * 34 * (r() < 0.5 ? -1 : 1), hy - e * 16, (1 - e) * (isF ? 1 : 0.7), 'cyan');
      } else {
        const ang = (r() - 0.5) * 2.4 + (r() < 0.2 ? Math.PI : 0), E2 = E / (1 + (E / 511) * (1 - Math.cos(ang)));
        const sx = Math.sin(ang), sy = Math.cos(ang), L = e * v;
        if (e < 0.7) electron(px, hx - sx * e * 22, hy + e * 8, (1 - e / 0.7) * 0.8, 'cyan');
        if (e < 0.14) px.glow(hx, hy, isF ? 5 : 2, 'orange', 0.8, i);
        const fx = hx + sx * L, fy = hy + sy * L;
        if (fx > x - 4 && fx < x + w + 4 && fy > y - 10 && fy < y + h + 8) px.photon(fx, fy, sx, sy, isF ? 10 : 7, keVColor(E2), a, t * 30 + i);
      }
      if (isF) ev = { x: hx, y: hy, kind, done: true, e };
    }
    return { ev, focusOn: dim < 1, frac: total ? through / total : 0 };
  }

  // ---------------------------------------------------------------- the molecules
  const jit = (t, k, s = 1) => Math.round(Math.sin(t * 5.3 + k * 1.7) * s);
  function waterField(t, x, y, w, h, a = 1, sp = 12, seed = 3) {
    const r = rng(seed), out = [];
    for (let yy = y + 5; yy < y + h - 3; yy += sp * 0.87) for (let xx = x + 5 + (Math.round((yy - y) / sp) % 2) * sp / 2; xx < x + w - 4; xx += sp) {
      const k = out.length, ox = xx + (r() - 0.5) * 3 + jit(t, k), oy = yy + (r() - 0.5) * 3 + jit(t, k + 9);
      const th = r() * 6.28 + t * (0.6 + r() * 0.8) * (k % 2 ? 1 : -1), half = 0.91;   // 104.5 degrees between the O-H bonds
      px.rect(ox - 1, oy - 1, 3, 3, 'red', a);
      for (const s of [-1, 1]) px.rect(ox + Math.cos(th + s * half) * 2.6 - 0.5, oy + Math.sin(th + s * half) * 2.6 - 0.5, 2, 2, 'white', a * 0.9);
      out.push([ox, oy]);
    }
    return out;
  }
  function fatField(t, x, y, w, h, a = 1) {
    // chains of CH2: carbons in a zigzag, two hydrogens on each; the chains lie loose
    const r = rng(11), out = [];
    for (let yy = y + 8, row = 0; yy < y + h - 6; yy += 13, row++) {
      let xx = x + 2 + r() * 14;
      while (xx < x + w - 10) {
        const n = 6 + Math.floor(r() * 10), wob = r() * 6.28;
        for (let k = 0; k < n && xx < x + w - 4; k++, xx += 4) {
          const cy = yy + (k % 2 ? -2 : 2) + Math.round(Math.sin(t * 2 + wob + row) * 1.2);
          const nx2 = xx + 4, ny2 = yy + ((k + 1) % 2 ? -2 : 2) + Math.round(Math.sin(t * 2 + wob + row) * 1.2);
          if (k < n - 1) px.line(xx, cy, nx2, ny2, 'slate', a);
          px.rect(xx - 1, cy - 1, 2, 2, 'grey', a);
          px.px(xx, cy + (k % 2 ? -3 : 3), 'white', a * 0.85);
          out.push([xx, cy]);
        }
        xx += 10 + r() * 12;
      }
    }
    return out;
  }
  function boneField(t, x, y, w, h, a = 1) {
    // collagen fibrils (a twisted pair) with hydroxyapatite platelets along them: calcium,
    // phosphate (P with its O), hydroxide
    const out = [];
    for (let yy = y + 10, row = 0; yy < y + h - 4; yy += 26, row++) {
      for (let xx = x; xx < x + w; xx++) {
        const s = Math.sin((xx + row * 7) * 0.32 + t * 0.6);
        px.px(xx, yy + 13 + Math.round(s * 2), 'pink', a * 0.55);
        px.px(xx, yy + 13 - Math.round(s * 2), 'plum', a * 0.65);
      }
      for (let px0 = x + 4 + (row % 2) * 16; px0 < x + w - 28; px0 += 34) {
        px.rect(px0 - 1, yy - 2, 30, 13, 'navy', 0.35 * a);
        for (let j = 0; j < 3; j++) for (let i = 0; i < 7; i++) {
          const ax = px0 + i * 4 + (j % 2) * 2, ay = yy + j * 4 + jit(t, i + j * 7 + row, 0.6);
          const kind = (i + j) % 3;
          if (kind === 0) { px.rect(ax - 1, ay - 1, 3, 3, 'gold', a); out.push([ax, ay]); }    // Ca
          else if (kind === 1) { px.rect(ax, ay, 2, 2, 'orange', a); px.px(ax + 2, ay - 1, 'red', a); px.px(ax - 1, ay + 2, 'red', a); }   // PO4
          else px.px(ax, ay, 'red', a * 0.8);                                                    // O / OH
        }
      }
    }
    return out;
  }
  function iodineField(t, x, y, w, h, a = 1) {
    waterField(t, x, y, w, h, a * 0.45, 10, 5);
    // tri-iodinated benzene rings: six carbons, an iodine on every other one
    const r = rng(21), out = [];
    for (let k = 0; k < Math.floor((w * h) / 2400); k++) {
      const cx = x + 14 + r() * (w - 28), cy = y + 14 + r() * (h - 28), th = r() * 6.28 + t * 0.3 * (k % 2 ? 1 : -1);
      const pts = Array.from({ length: 6 }, (_, i) => [cx + Math.cos(th + i * Math.PI / 3) * 5, cy + Math.sin(th + i * Math.PI / 3) * 5]);
      for (let i = 0; i < 6; i++) px.line(pts[i][0], pts[i][1], pts[(i + 1) % 6][0], pts[(i + 1) % 6][1], 'grey', a);
      for (const i of [0, 2, 4]) {
        const ix = cx + Math.cos(th + i * Math.PI / 3) * 11, iy = cy + Math.sin(th + i * Math.PI / 3) * 11;
        px.line(pts[i][0], pts[i][1], ix, iy, 'grey', a * 0.7);
        atom(px, ix, iy, 4, t, { shells: [2, 6], ring: 'lav', e: 'violet', nucleus: 'violet', seed: k * 3 + i, a });
        out.push([ix, iy]);
      }
    }
    return out;
  }
  function metalField(t, x, y, w, h, kind, a = 1) {
    // close-packed rows of big atoms: titanium, iron (steel), lead
    const P = { ti: { sp: 9, r: 3, c: 'grey', e: 'white' }, fe: { sp: 8, r: 3, c: 'lead', e: 'grey' }, pb: { sp: 10, r: 4, c: 'slate', e: 'mid' } }[kind];
    const out = [];
    for (let j = 0, yy = y + 6; yy < y + h - 3; j++, yy += P.sp * 0.87) for (let xx = x + 5 + (j % 2) * P.sp / 2; xx < x + w - 3; xx += P.sp) {
      const ox = xx + jit(t, out.length, 0.5), oy = yy;
      px.circle(ox, oy, P.r, P.c, a, true);
      px.circle(ox, oy, P.r, P.e, a * 0.5);
      px.px(ox, oy, 'yellow', a * 0.8);
      out.push([ox, oy]);
    }
    return out;
  }
  // the nearest of a set of atoms to a point (the photon meets an atom, not empty space)
  const nearest = (list) => (X, Y) => { let b = null, d = 1e9; for (const p of list) { const q = (p[0] - X) ** 2 + (p[1] - Y) ** 2; if (q < d) { d = q; b = p; } } return b; };

  // ---------------------------------------------------------------- plots
  // mu(E) curves on log axes, E 20..150 keV, mu 0.1..lim cm^-1
  function muPlot(x, y, w, h, curves, { lo = 0.1, hi = 5, eMark = null, k = 1 } = {}) {
    panel(px, x, y, w, h);
    const x0 = x + 14, x1 = x + w - 4, y0 = y + h - 10, y1 = y + 4;
    const X = (E) => x0 + ((Math.log(E) - Math.log(20)) / (Math.log(150) - Math.log(20))) * (x1 - x0);
    const Y = (m) => y0 - ((Math.log(m) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (y0 - y1);
    px.rect(x0, y0, x1 - x0, 1, 'mid'); px.rect(x0, y1, 1, y0 - y1, 'mid');
    for (const E of [20, 60, 150]) { px.rect(X(E), y0, 1, 2, 'mid'); px.text(String(E), X(E), y0 + 3, 'mid', 1, 1, 'center'); }
    for (const m of [0.1, 1, 10, 100].filter((v) => v >= lo && v <= hi)) { px.rect(x0 - 2, Y(m), 2, 1, 'mid'); px.text(String(m), x0 - 3, Y(m) - 2, 'mid', 1, 1, 'right'); }
    px.text('keV', x1, y0 - 7, 'mid', 1, 1, 'right');
    for (const c of curves) {
      let lx = null, ly = null;
      const Emax = lerp(20, 150, k);
      for (let E = 20; E <= Emax; E += 0.5) {
        const v = c.f(E); if (!(v > 0)) continue;
        const xx = X(E), yy = Math.max(y1, Math.min(y0, Y(v)));
        if (lx != null && !(c.edge && Math.abs(yy - ly) > 6)) px.line(lx, ly, xx, yy, c.c, c.a ?? 1);
        else if (lx != null && c.edge) px.line(lx, ly, xx, yy, c.c, 0.5, 1);
        lx = xx; ly = yy;
      }
    }
    if (eMark) { px.line(X(eMark), y1, X(eMark), y0, 'yellow', 0.7, 2); }
    return { X, Y, box: [x, y, w, h] };
  }

  // ---------------------------------------------------------------- the editor's palette on the HU scale
  const PAL = LIST.filter((m) => m.id <= 28 && m.id > 0 || m.id === 0);
  const huItems = PAL.filter((m) => m.hu != null).sort((a, b) => a.hu - b.hu);
  const metals = PAL.filter((m) => m.hu == null);

  const steps = [
    {
      title: 'The material list', dur: 12, view: 'pixel', fadeIn: 0.5,
      cues: huItems.map((_, i) => [0.8 + i * 0.22, () => sfx.blip(300 + i * 40)]),
      frame(t) {
        px.fillAll('ink');
        const x0 = 18, x1 = px.W - 54, yb = 150;
        const X = (hu) => x0 + ((hu + 1000) / 3500) * (x1 - x0);
        px.rect(x0, yb, x1 - x0, 1, 'mid');
        for (const v of [-1000, -500, 0, 500, 1000, 1500, 2000, 2500]) { px.rect(X(v), yb, 1, 3, 'mid'); px.text(String(v), X(v), yb + 5, v === 0 ? 'white' : 'mid', 1, 1, 'center'); }
        px.text('HU', x1, yb + 12, 'mid', 1, 1, 'right');
        // the swatches drop onto their HU, stacked where they crowd (the soft tissues, 10 to 75)
        const stack = new Map();
        huItems.forEach((m, i) => {
          const k = span(t, 0.8 + i * 0.22, 1.2 + i * 0.22, api.ease.out);
          if (k <= 0) return;
          const bx = Math.round(X(m.hu) / 7) * 7, n = stack.get(bx) || 0; stack.set(bx, n + 1);
          const yy = lerp(10, yb - 9 - n * 8, k);
          px.rect(bx - 3, yy, 7, 7, rgbS(RGB[m.id]));
          px.frame(bx - 3, yy, 7, 7, 'white', 0.25);
          if (n === 0 && k > 0.95) px.line(X(m.hu), yb - 1, X(m.hu), yb - 2, 'grey');
        });
        // the metals: no HU, off the scale's end
        const km = span(t, 6, 7);
        metals.forEach((m, i) => {
          if (km <= 0) return;
          const xx = px.W - 30, yy = lerp(10, yb - 9 - i * 8, km);
          px.rect(xx - 3, yy, 7, 7, rgbS(RGB[m.id])); px.frame(xx - 3, yy, 7, 7, 'white', 0.3);
        });
        if (km > 0) { px.line(x1 + 2, yb, px.W - 36, yb, 'mid', 1, 2); px.text('>', px.W - 37, yb - 2, 'grey'); }
        if (t > 0.8 && t < 6) api.mark([X(-1000) - 6, yb - 110, X(1300) - X(-1000) + 12, 121], 'yellow', t);
        if (t >= 6) api.mark([px.W - 36, yb - 44, 14, 46], 'yellow', t);
        api.keepOut([x0 - 4, yb - 110, px.W - x0, 119]);
      },
      caption: [
        { from: 0.8, to: 6, text: 'Each id points into one list of <b>materials</b> (here the 29 the editor paints with), each with its HU: air −1000, fat −90, water 0, soft tissues 10 to 75, bone 300 to 1200.' },
        { from: 6, to: 12, text: 'Aluminium, titanium, steel and lead have no HU in the list: they lie far beyond the scale.' },
      ],
    },
    {
      title: 'Attenuation', dur: 13, view: 'pixel',
      frame(t) {
        px.fillAll('ink');
        const names = [['Fat', 2], ['Water', 3], ['Muscle', 7], ['Trabecular bone', 17], ['Cortical bone', 18]];
        const w = Math.min(px.W - 20, 250), x = Math.round(px.W / 2 - w / 2), y = 10, h = 128;
        const p = muPlot(x, y, w, h, names.map(([n, id]) => ({ f: (E) => mu(n, E), c: rgbS(RGB[id]) })), { lo: 0.1, hi: 5, k: span(t, 0.6, 3.5), eMark: t > 7 ? 60 : null });
        api.keepOut(p.box);
        if (t > 7) {
          // at 60 keV: each one's mu, and its HU
          // (the labels stacked clear of each other, a leader to each dot)
          const pts = names.map(([n, id]) => ({ id, y: p.Y(mu(n, 60)) })).sort((a, b) => a.y - b.y);
          let last = -1e9;
          for (const q of pts) { q.ly = Math.max(q.y, last + 9); last = q.ly; }
          const xx = p.X(60);
          for (const q of pts) {
            px.rect(xx - 1, q.y - 1, 3, 3, rgbS(RGB[q.id]));
            px.line(xx + 2, q.y, xx + 14, q.ly, rgbS(RGB[q.id]), 0.7);
            const hu = BodyMaterials.huOf(q.id), lab = (hu > 0 ? '+' : '') + hu + ' HU';
            px.rect(xx + 15, q.ly - 3, lab.length * 4 + 1, 7, 'ink', 0.9);
            px.text((hu > 0 ? '+' : '') + hu + ' HU', xx + 16, q.ly - 2, rgbS(RGB[q.id]), 1, 1, 'left');
          }
          px.text(mu('Water', 60).toFixed(3) + '/cm', p.X(60) - 3, y + h - 18, 'cyan', 1, 1, 'right');
          api.mark([p.X(60) - 4, y + 4, 66, h - 14], 'yellow', t);
        } else if (t > 0.6) api.mark(p.box, 'cyan', t);
      },
      caption: [
        { from: 0.6, to: 7, text: 'What the physics uses is each material’s <b>linear attenuation coefficient</b> μ(E): the share of photons it removes per cm, falling with energy.' },
        { from: 7, to: 13, text: 'HU is μ measured against water’s at 60 keV: <b>HU = 1000 × (μ − μ<sub>water</sub>) / μ<sub>water</sub></b>.' },
      ],
    },
    {
      title: 'Water and fat', dur: 14, view: 'pixel', scale: '500 pm',
      cues: [[3.3, () => sfx.pew(1100)], [9.3, () => sfx.pew(1000)]],
      frame(t) {
        px.fillAll('ink');
        const gw = Math.floor((px.W - 24) / 2), y = 12, h = 110;
        const L = { x: 8, y, w: gw, h }, R = { x: 16 + gw, y, w: gw, h };
        const fw = t > 1.5 && t < 7, ff = t >= 7;
        const aw = waterField(t, L.x, L.y, L.w, L.h, ff ? 0.5 : 1);
        const af = fatField(t, R.x, R.y, R.w, R.h, fw ? 0.5 : 1);
        const bw = beam(t, { ...L, muE: (E) => mu('Water', E), fpe: fPE(30), seed: 1, atomsAt: nearest(aw), focus: { at: 1.6, kind: 'compton', x: gw / 2, depth: 0.45, slow: 3, E: 60 } });
        const bf = beam(t, { ...R, muE: (E) => mu('Fat', E), fpe: fPE(27), seed: 2, atomsAt: nearest(af), focus: { at: 7.6, kind: 'compton', x: gw / 2 - 10, depth: 0.5, slow: 3, E: 60 } });
        px.frame(L.x, L.y, L.w, L.h, 'dkgrey'); px.frame(R.x, R.y, R.w, R.h, 'dkgrey'); api.keepOut([L.x, L.y, L.w, L.h]); api.keepOut([R.x, R.y, R.w, R.h]);
        for (const [P, name, rho] of [[L, 'Water', '1.00'], [R, 'Fat', '0.91']]) {
          px.text(mu(name, 60).toFixed(3) + '/cm', P.x + P.w / 2, P.y + P.h + 5, 'cyan', 1, 1, 'center');
          px.text(rho + ' g/cm3', P.x + P.w / 2, P.y + P.h + 13, 'mid', 1, 1, 'center');
        }
        api.keepOut([L.x, L.y + L.h + 3, L.w, 18]); api.keepOut([R.x, R.y + R.h + 3, R.w, 18]);
        const ev = fw ? bw.ev : ff ? bf.ev : null;
        if (ev && (!ev.done || ev.e < 2.4)) api.mark([ev.x - 9, ev.y - 9, 18, 18], 'yellow', t);
        else if (fw) api.mark([L.x, L.y, L.w, L.h], 'yellow', t);
        else if (ff) api.mark([R.x, R.y, R.w, R.h], 'yellow', t);
      },
      caption: [
        { from: 1.5, to: 7, text: 'Water: light atoms, H₂O at 1 g/cm³. At 60 keV nearly every photon it stops is <b>Compton</b> scattered. μ = (μ/ρ) × ρ: 0.206 cm²/g × 1 g/cm³.' },
        { from: 7, to: 14, text: 'Fat: chains of CH₂, packed looser (0.91 g/cm³). RadSim scales water’s μ by that density: 9% less attenuation, −90 HU.' },
      ],
    },
    {
      title: 'Bone', dur: 13, view: 'pixel', scale: '10 nm',
      cues: [[3.4, () => sfx.zap()]],
      frame(t) {
        px.fillAll('ink');
        const fw = Math.floor(px.W * 0.5), F = { x: 8, y: 12, w: fw, h: 124 };
        const atoms = boneField(t, F.x, F.y, F.w, F.h);
        const b = beam(t, { ...F, muE: (E) => mu('Cortical bone', E), fpe: fPE(55), seed: 4, rate: 12, atomsAt: nearest(atoms), focus: { at: 1.4, kind: 'pe', x: fw / 2, depth: 0.4, slow: 3, E: 30 } });
        px.frame(F.x, F.y, F.w, F.h, 'dkgrey'); api.keepOut([F.x, F.y, F.w, F.h]);
        const px0 = F.x + F.w + 10, pw = px.W - px0 - 8;
        const p = muPlot(px0, 14, pw, 110, [
          { f: (E) => mu('Water', E), c: rgbS(RGB[3]) },
          { f: (E) => mu('Cortical bone', E), c: rgbS(RGB[18]) },
        ], { lo: 0.1, hi: 5, k: span(t, 6.5, 9) });
        api.keepOut(p.box);
        if (t < 6.5 && b.ev && (!b.ev.done || b.ev.e < 2.4)) api.mark([b.ev.x - 9, b.ev.y - 9, 18, 18], 'yellow', t);
        else if (t < 6.5) api.mark([F.x, F.y, F.w, F.h], 'yellow', t);
        if (t >= 6.5) api.mark(p.box, 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 6.5, text: 'Bone: <b>hydroxyapatite</b> crystals, Ca₁₀(PO₄)₆(OH)₂, along collagen. Calcium (Z = 20) stops low-energy photons by the <b>photoelectric effect</b>, ∝ Z³/E³.' },
        { from: 6.5, to: 13, text: 'So bone’s μ climbs steeply at low energy. RadSim makes each bone material water plus a share of cortical bone, set by its HU.' },
      ],
    },
    {
      title: 'Iodine', dur: 13, view: 'pixel', scale: '500 pm',
      cues: [[3.4, () => sfx.zap()]],
      frame(t) {
        px.fillAll('ink');
        const fw = Math.floor(px.W * 0.5), F = { x: 8, y: 12, w: fw, h: 124 };
        const atoms = iodineField(t, F.x, F.y, F.w, F.h);
        // blood with 10 mg of iodine per mL: its iodine is nearly all photoelectric
        const muI = (E) => 10 * BodyMaterials.muIodinePerConc(E), muB = (E) => mu('Blood', E);
        const b = beam(t, { ...F, muE: (E) => muB(E) + muI(E), fpe: (E) => (muI(E) + muB(E) * fPE(30)(E)) / (muI(E) + muB(E)), seed: 6, rate: 12, atomsAt: nearest(atoms), focus: { at: 1.4, kind: 'pe', x: fw / 2 + 6, depth: 0.42, slow: 3, E: 36 } });
        px.frame(F.x, F.y, F.w, F.h, 'dkgrey'); api.keepOut([F.x, F.y, F.w, F.h]);
        const px0 = F.x + F.w + 10, pw = px.W - px0 - 8;
        // iodine's own mu/rho (cm^2/g): the K-edge at 33.2 keV
        const p = muPlot(px0, 14, pw, 110, [{ f: (E) => BodyMaterials.muIodinePerConc(E) * 1000, c: 'violet', edge: true }], { lo: 1, hi: 60, k: span(t, 0.5, 3), eMark: 33.17 });
        api.keepOut(p.box);
        px.text('33.2', p.X(33.17) + 2, 18, 'yellow', 1, 1, 'left');
        if (t < 6.5 && b.ev && (!b.ev.done || b.ev.e < 2.4)) api.mark([b.ev.x - 10, b.ev.y - 10, 20, 20], 'yellow', t);
        else if (t < 6.5) api.mark([p.X(33.17) - 8, 18, 16, 92], 'yellow', t);
        else api.mark([F.x, F.y, F.w, F.h], 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 6.5, text: 'Iodine (Z = 53), three to a contrast molecule. Its K electrons are bound by 33.2 keV: just above that, photons are absorbed four times as readily, the <b>K-edge</b>.' },
        { from: 6.5, to: 13, text: 'In a vessel RadSim carries iodine as a <b>concentration</b> in each voxel, mg per mL, its μ added to the blood’s.' },
      ],
    },
    {
      title: 'Metals', dur: 13, view: 'pixel', scale: '500 pm', fadeOut: 0.5,
      cues: [[1, () => sfx.thud()]],
      frame(t) {
        px.fillAll('ink');
        const gw = Math.floor((px.W - 32) / 3), y = 12, h = 104;
        const M = [['ti', 'Titanium', 25], ['fe', 'Stainless steel', 26], ['pb', 'Lead', 27]];
        const boxes = [];
        M.forEach(([k, name, id], i) => {
          const P = { x: 8 + i * (gw + 8), y, w: gw, h };
          const atoms = metalField(t, P.x, P.y, P.w, P.h, k);
          beam(t, { ...P, muE: (E) => mu(name, E), fpe: fPE({ ti: 100, fe: 120, pb: 450 }[k]), seed: 9 + i, rate: 12, atomsAt: nearest(atoms) });
          px.frame(P.x, P.y, P.w, P.h, 'dkgrey'); api.keepOut([P.x, P.y, P.w, P.h]);
          const m = mu(name, 60), r = m / mu('Water', 60);
          px.text(m.toFixed(m < 10 ? 2 : 1) + '/cm', P.x + P.w / 2, P.y + h + 5, 'cyan', 1, 1, 'center');
          px.text('x' + Math.round(r), P.x + P.w / 2, P.y + h + 14, 'yellow', 1, 1, 'center');
          px.rect(P.x + P.w / 2 - 3, P.y + h + 24, 7, 7, rgbS(RGB[id]));
          boxes.push(P);
        });
        api.keepOut([8, y + h + 3, px.W - 16, 30]);
        if (t > 0.8 && t < 7) api.mark([8, y + h + 2, px.W - 16, 22], 'yellow', t);
        if (t >= 7) api.mark([boxes[0].x, boxes[0].y, boxes[0].w, boxes[0].h], 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 7, text: 'Metals: heavy atoms packed tight. Per cm at 60 keV, titanium stops 7 times what water does, steel 46 times, lead about 280 times.' },
        { from: 7, to: 13, text: 'So a titanium implant is white on a radiograph, and on CT it throws <b>streaks</b> across the slice.' },
      ],
    },
  ];
  return { title: 'Materials', steps };
}
