/* MAMMOGRAPHY FILM, chapter 4: the detector. The AEC for a beam too soft for chambers in front of
   the detector (a pre-exposure read by the detector itself, its densest region found); the
   direct-conversion panel under the support: top electrode, amorphous selenium, the TFT array;
   an x-ray turned straight into charge and drawn down its field line; direct against indirect;
   why the pixels must be small. */
import * as THREE from 'three';
import { setOpacity } from '../../kit/stage.js';
import { electron } from '../../kit/micro.js';
import { FRONT, RECEPTOR_Y, H0 } from './rig.js';
import { mkeV } from './phys.js';
import { hud, grey, cycleAt, recentIdx } from './common.js';

export async function detectorChapter(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const R = S.R, T = R.tube;
  const C = 4.5 / H0;
  const cc = await S.img('mammo_breast_cc.png');
  const base = ({ inside = false, plate = 1, breast = true } = {}) => {
    S.only('unit');
    R.gantry.rotation.z = 0; R.tubeArm.rotation.z = 0;
    R.setCompression(C); R.setPaddle(R.paddleAt(C));
    R.breast.visible = breast; R.inside.visible = inside; R.beam.visible = false; R.explode(0);
    R.skinMat.opacity = 1; R.skinMat.transparent = false; R.skinMat.depthWrite = true;
    for (const o of [R.tubeHead, R.nose, R.snout, R.trim]) setOpacity(o, 1);
    setOpacity(R.plate, plate);
    T.g.visible = false;
  };

  // ---- the AEC's regions: a 6 x 4 grid over the detector's field, each the CC image's mean
  // density there (the processed image: white = dense)
  const GX = 6, GY = 4, FX = 23, FY = 14.6;
  const cells = [];
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
    let s = 0, n = 0;
    for (let r = Math.floor(j * cc.h / GY); r < Math.floor((j + 1) * cc.h / GY); r += 2)
      for (let c = Math.floor(i * cc.w / GX); c < Math.floor((i + 1) * cc.w / GX); c += 2) { const v = cc.a[r * cc.w + c]; if (v > 0.08) { s += v; n++; } }
    cells.push({ i, j, v: n > 40 ? s / n : 0, n });
  }
  const densest = cells.reduce((a, b) => (b.v > a.v ? b : a));
  // a cell's corners on the support's top (x lateral, z from the chest-wall edge back)
  const cellQuad = (i, j) => [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([a, b]) => api.toPx([(a / GX - 0.5) * FX, RECEPTOR_Y + 0.05, FRONT - (b / GY) * FY]));
  function drawCells(t, k) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of cells) {
      if (!c.n) continue;
      const q = cellQuad(c.i, c.j), on = c === densest && t > 6.5;
      // the region's reading: its mean density as a grey over it (white: the most attenuating)
      if (c.v > 0) {
        const g = px.g; g.globalAlpha = 0.75 * k; g.fillStyle = grey(clamp01((c.v - 0.15) / 0.5));
        g.beginPath(); g.moveTo(q[0][0], q[0][1]); for (let e = 1; e < 4; e++) g.lineTo(q[e][0], q[e][1]); g.closePath(); g.fill(); g.globalAlpha = 1;
      }
      for (let e = 0; e < 4; e++) px.line(q[e][0], q[e][1], q[(e + 1) % 4][0], q[(e + 1) % 4][1], on ? 'yellow' : 'cyan', (on ? 1 : 0.5) * k);
      for (const p of q) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    }
    if (k > 0) api.keepOut([x0, y0, x1 - x0, y1 - y0]);
  }

  // ---- the selenium in section: x-rays absorbed, their charge drawn straight down
  const NPIX = 10;
  function seleniumScene(t, { x0 = 0, w = null, hiEvery = 6, mode = 'se' } = {}) {
    const W = w || px.W, H = px.H;
    const pw = Math.floor((W - 20) / NPIX), L = x0 + Math.round((W - pw * NPIX) / 2);
    const top = 30, th = 100, bot = top + th;
    const qs = new Array(NPIX).fill(0);
    if (mode === 'se') {
      // the top electrode at high voltage, the selenium, the field lines straight down
      px.rect(L, top - 4, pw * NPIX, 3, 'gold');
      for (let i = 0; i < NPIX * 2; i++) px.text('+', L + i * pw / 2 + pw / 4, top - 11, 'gold', 0.8, 1, 'center');
      px.rect(L, top, pw * NPIX, th, 'plum', 0.22);
      for (let i = 0; i < NPIX * 2; i++) for (let y = top + ((t * 30) % 8); y < bot; y += 8) px.px(L + i * pw / 2 + pw / 4, y, 'lav', 0.35);
    } else {
      // caesium iodide needles over photodiodes
      for (let i = 0; i < NPIX * 3; i++) { const x = L + i * pw / 3; px.rect(x + 1, top, pw / 3 - 2, th, 'teal', 0.4); }
    }
    // the pixel electrodes (or photodiodes) and their storage capacitors
    for (let i = 0; i < NPIX; i++) {
      px.rect(L + i * pw + 2, bot + 2, pw - 4, 4, mode === 'se' ? 'grey' : 'blue');
      px.frame(L + i * pw + pw / 2 - 3, bot + 12, 6, 30, 'mid');
    }
    px.rect(L, bot + 8, pw * NPIX, 2, 'slate');
    const rate = 2.6, N = Math.floor(t * rate);
    let F = null;
    const hiT = cycleAt(t, 1, hiEvery), fi = Math.floor(hiT * rate);
    for (const i of recentIdx(N, rate, 8, fi)) {
      const r = rng(900 + i), age = t - i / rate;
      if (age < 0) continue;
      const k = Math.floor(r() * NPIX), x = L + k * pw + 3 + r() * (pw - 6), depth = top + 8 + r() * (th - 30), E = 15 + r() * 8;
      const tIn = (depth + 10) / 200, focus = i === fi;
      if (focus) F = { x, depth, age, tIn };
      if (age < tIn) { px.photon(x, -10 + age * 200, 0, 1, 7, mkeV(E), 1, t * 30 + i); continue; }
      const e = age - tIn;
      if (e < 0.2) px.glow(x, depth, 5, mode === 'se' ? 'white' : 'yellow', 0.95, i);
      const travel = clamp01(e / 0.9);
      if (mode === 'se') {
        // electron-hole pairs: holes (peach) drift down the field line, electrons (cyan) up
        for (let j = 0; j < 12; j++) {
          const jx = x + ((j % 4) - 1.5) * 1.4;
          if (travel < 1) {
            px.px(jx, lerp(depth, bot, travel) + (j % 3), 'peach', 0.95);
            px.px(jx, lerp(depth, top, travel) - (j % 3), 'cyan', 0.85);
          }
        }
        qs[k] += clamp01((e - 0.6) / 0.4) * Math.exp(-Math.max(0, e - 1) / 0.8);
      } else {
        // light: spreading in a cone as it goes down, some of it into the neighbours
        for (let j = 0; j < 22; j++) {
          const rr = rng(i * 50 + j), a = (rr() - 0.5) * 1.0, d = Math.min(1, travel * (0.6 + rr() * 0.8)) * (bot - depth) / Math.cos(a);
          const lx = Math.max(L + 1, Math.min(L + pw * NPIX - 2, x + Math.sin(a) * d * 0.3)), ly = depth + Math.cos(a) * d;
          if (travel < 1 && ly < bot) px.px(lx, ly, 'yellow', 0.9);
          if (e > 0.6) { const kk = Math.floor((lx - L) / pw); if (kk >= 0 && kk < NPIX) qs[kk] += clamp01((e - 0.6) / 0.4) * Math.exp(-Math.max(0, e - 1) / 0.8) / 22; }
        }
      }
    }
    for (let i = 0; i < NPIX; i++) {
      const h = Math.min(28, qs[i] * 26);
      px.rect(L + i * pw + pw / 2 - 2, bot + 41 - h, 4, h, 'cyan');
    }
    return { L, pw, top, bot, F, qs };
  }

  // ---- pixel size: specks of calcium sampled by pixels of a given pitch
  const specks = (() => { const r = rng(17), a = []; for (let i = 0; i < 11; i++) a.push([0.6 + r() * 2.8, 0.6 + r() * 2.8, 0.045 + r() * 0.09]); return a; })();   // mm: x, y, radius
  const patch = 4;                                                      // mm across
  function sampled(pitch) {
    const n = Math.round(patch / pitch), out = new Float32Array(n * n), r = rng(Math.round(pitch * 1000));
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      let cov = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const x = (i + (sx + 0.5) / 4) * pitch, y = (j + (sy + 0.5) / 4) * pitch;
        for (const s of specks) if ((x - s[0]) ** 2 + (y - s[1]) ** 2 < s[2] ** 2) { cov++; break; }
      }
      out[j * n + i] = 0.32 + 0.1 * (r() - 0.5) + 0.6 * cov / 16;
    }
    return { n, a: out };
  }
  const PITCH = [0.07, 0.1, 0.2].map((p) => ({ p, s: sampled(p) }));

  const steps = [
    {
      title: 'AEC for a soft beam', dur: 15, fadeIn: 0.4, scale: '10 cm',
      enter() { base({ plate: 1 }); R.skinMat.opacity = 0.3; R.skinMat.transparent = true; R.skinMat.depthWrite = false; },
      cam: [[0, [72, 64, 34], [0, -3, 5], 36], [15, [60, 56, 28], [0, -3, 5], 36]],
      cues: [[1.4, () => sfx.blip(520)], [9.5, () => sfx.blip(880)]],
      frame(t) {
        // the pre-exposure: a brief flash of beam, read by the detector's regions
        const pre = t > 1.4 && t < 1.9, main = t > 9.5 && t < 11.5;
        R.beam.visible = pre || main; R.beam.material.opacity = pre ? 0.06 : 0.14;
        const k = span(t, 2, 3.5);
        if (k > 0) drawCells(t, k);
        if (t > 6.5) { const q = cellQuad(densest.i, densest.j); const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]); api.mark([Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) - Math.min(...xs) + 4, Math.max(...ys) - Math.min(...ys) + 4], 'yellow', t); }
        if (t > 8) hud(api, [['kV', '28', 'yellow'], ['T/F', 'Mo/Mo', 'yellow'], ['mAs', String(S.meta?.views?.breast_cc?.mas ?? 71), 'lime']], { w: 62 });
      },
      caption: [
        { from: 0.6, to: 6.5, text: 'At 28 kV an ionisation chamber in front of the detector would cast its own shadow. Instead the detector meters itself: a brief, low-dose <b>pre-exposure</b> is read region by region.' },
        { from: 6.5, to: 15, text: 'The AEC finds the <b>densest region</b> (the gland, not the thin edge) and, from it and the compressed thickness, sets the kV, target/filter and mAs for the main exposure.' },
      ],
    },
    {
      title: 'The selenium detector', dur: 16, scale: '10 cm',
      enter() { base({ inside: true, plate: 0.15, breast: false }); },
      cam: [[0, [46, 22, 66], [0, -2, 4], 38], [16, [44, 30, 62], [0, 6, 4], 38]],
      frame(t) {
        R.explode(span(t, 0.8, 4));
        const order = [R.grid, R.electrode, R.selenium, R.tftFace];
        const i = t < 4.2 ? -1 : Math.min(3, Math.floor((t - 4.2) / 3));
        if (i >= 0) api.mark(order[i], 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 4.2, text: 'Under the support’s cover, the grid, then a <b>direct-conversion</b> flat panel, layer on layer.' },
        { from: 4.2, to: 7.2, text: 'The grid, on top: it moves during the exposure.' },
        { from: 7.2, to: 10.2, text: 'A thin <b>top electrode</b>, held at a high voltage.' },
        { from: 10.2, to: 13.2, text: 'A layer of <b>amorphous selenium</b>, about a quarter of a millimetre thick: the x-ray absorber itself, with no scintillator.' },
        { from: 13.2, to: 16, text: 'Under it, on glass, the <b>TFT array</b>: a pixel electrode, a storage capacitor and a switch for every pixel, read row by row.' },
      ],
    },
    {
      title: 'X-rays straight to charge', dur: 15, view: 'pixel', scale: '100 µm',
      cues: [[1.6, () => sfx.tick()], [7.6, () => sfx.tick()], [13.6, () => sfx.tick()]],
      frame(t) {
        px.fillAll('ink');
        const r = seleniumScene(t);
        if (r.F && r.F.age < 3.2) api.mark([r.F.x - 8, r.top, 16, r.bot - r.top + 8], 'yellow', t);
        api.keepOut([r.L, r.bot, r.pw * NPIX, 44]);
      },
      caption: [
        { from: 0.6, to: 7, text: 'Selenium (Z = 34) absorbs almost every photon of mammography’s energies within a quarter of a millimetre. Each absorbed x-ray frees a few hundred <b>electron–hole pairs</b> where it stops.' },
        { from: 7, to: 15, text: 'The high voltage pulls them apart along straight <b>field lines</b>: the holes drift down to the pixel electrode right beneath, the electrons up to the top. The charge waits on that pixel’s capacitor.' },
      ],
    },
    {
      title: 'Direct against indirect', dur: 14, view: 'pixel', scale: '100 µm',
      frame(t) {
        px.fillAll('ink');
        const half = Math.floor(px.W / 2);
        const a = seleniumScene(t + 3, { x0: 0, w: half - 2, mode: 'csi' });
        const b = seleniumScene(t + 3, { x0: half + 2, w: half - 2, mode: 'se' });
        px.rect(half, 10, 1, px.H - 20, 'dkgrey');
        if (t > 1 && t < 7) api.mark([a.L - 2, a.top - 2, a.pw * NPIX + 4, a.bot - a.top + 50], 'yellow', t);
        if (t > 7) api.mark([b.L - 2, b.top - 14, b.pw * NPIX + 4, b.bot - b.top + 62], 'yellow', t);
      },
      caption: [
        { from: 1, to: 7, text: 'The general-radiography panel (left) is <b>indirect</b>: caesium iodide turns the x-ray into light first, and some light still spreads into the neighbouring pixels.' },
        { from: 7, to: 14, text: 'Selenium (right) is <b>direct</b>: no light, the charge stays on its own field line and lands in one pixel. A sharper image: what microcalcifications need.' },
      ],
    },
    {
      title: 'Small pixels', dur: 14, view: 'pixel', scale: '1 mm',
      frame(t) {
        px.fillAll('ink');
        const W = px.W, n = 3, gap = 8, size = Math.min(Math.floor((W - 16 - gap * (n - 1)) / n), px.H - 70);
        PITCH.forEach((P, i) => {
          const x = 8 + i * (size + gap), y = 30, cell = size / P.s.n;
          const a = span(t, 0.5 + i * 1.2, 1.5 + i * 1.2);
          if (a <= 0) return;
          px.alpha = a;
          for (let r = 0; r < P.s.n; r++) for (let c = 0; c < P.s.n; c++) {
            const x0 = Math.floor(x + c * cell), y0 = Math.floor(y + r * cell);
            px.rect(x0, y0, Math.max(1, Math.floor(x + (c + 1) * cell) - x0), Math.max(1, Math.floor(y + (r + 1) * cell) - y0), grey(P.s.a[r * P.s.n + c]));
          }
          px.frame(x - 1, y - 1, size + 2, size + 2, 'dkgrey');
          px.text(Math.round(P.p * 1000) + ' µm', x + size / 2, y + size + 6, i < 2 ? 'yellow' : 'orange', 1, 1, 'center');
          px.alpha = 1;
          api.keepOut([x - 1, y - 1, size + 2, size + 14]);
        });
        const sel = t < 7 ? 0 : 2, x = 8 + sel * (size + gap);
        if (t > 3.5) api.mark([x - 3, 27, size + 6, size + 6], 'yellow', t);
      },
      caption: [
        { from: 0.5, to: 7, text: 'The same 4 mm of breast with a cluster of calcifications, sampled by pixels of 70 and 100 µm: mammography detectors use pixels this small, so each speck keeps its shape.' },
        { from: 7, to: 14, text: 'At 200 µm, a general radiography pixel, each speck is averaged with the tissue round it: the shapes are lost, and the faintest specks fade into the noise.' },
      ],
    },
  ];
  void THREE; void electron; void FRONT;
  return { title: 'The detector', steps };
}
