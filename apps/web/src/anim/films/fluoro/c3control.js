/* FLUOROSCOPY FILM, chapter 3: pulses, automatic control and the image on the screen. Pulsed against
   continuous; the pulse rate and the motion it can follow; the pulse width and motion blur; the
   beam-on clock and its 5-minute alarm; the automatic brightness control, in the room (the table
   slides from the chest to the pelvis) and in a field of tissue; quantum noise against dose; the
   recursive filter and its lag; last image hold; the image's rotate and flip.
   Live images are the patient model's own projection (live.js), with the technique the app's ABC
   curve sets (fluoro.js: kV 52 + 58q, mA 0.5 + 9.5q^2) and the rate ceiling (core/fluoroRate.js). */
import { keVColor, tungstenSpectrum, electron } from '../../kit/micro.js';
import { Materials } from '../../../core/materials.js';
import { akRate, maCeiling, RATE_LIMIT } from '../../../core/fluoroRate.js';
import { NR_K, recursiveStep } from '../../../core/fluoroDisplay.js';
import { hud, panel, boxLocal, mmss } from './util.js';
import { FIELD_PX, frameCache } from './live.js';

export function controlChapter(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const U = S.suite, L = S.live, W0 = L.IMG.W;
  const cache = frameCache(160);

  // ---- the ABC's curve (fluoro.js abcApply) and the generator's ceiling
  const kvOf = (q) => 52 + 58 * q;
  const maOf = (q, pps = 15) => Math.min(0.5 + 9.5 * q * q, maCeiling(kvOf(q), pps));
  // what the receptor collects, relative: tube output (mA, kV^2) times what gets through
  const signal = (q, row) => (maOf(q) / 2) * (kvOf(q) / 70) ** 2 * L.meanT(row, kvOf(q));
  const TARGET = signal(0.42, 250);
  const qFor = (row) => { let a = 0, b = 1; for (let k = 0; k < 18; k++) { const m = (a + b) / 2; if (signal(m, row) < TARGET) a = m; else b = m; } return (a + b) / 2; };
  /* The loop as it runs, pulse by pulse at 15 pps (fluoro.js abcStep: a log step of 0.3 / 6), over
     the last two seconds of the field's path rowAt(t); the result a function of t alone. */
  function abcAt(t, rowAt) {
    const pps = 15, k1 = Math.floor(t * pps), k0 = Math.max(0, k1 - 30);
    let q = qFor(rowAt(k0 / pps));
    for (let k = k0 + 1; k <= k1; k++) {
      const row = rowAt(k / pps), meas = signal(q, row);
      q = clamp01(q + 0.3 * Math.log(TARGET / meas) / 6);
    }
    return { q, kv: kvOf(q), ma: maOf(q), meas: signal(q, rowAt(t)) / TARGET };
  }

  // ---- a moving catheter over the heart: the motion the pulse rate and the filter are judged on
  const HEART = { cx: W0 / 2 + 14, cy: 150 };
  const cath = (tt) => {
    const dx = 9 * Math.sin(tt * Math.PI * 2 * 1.2), dy = 3 * Math.sin(tt * Math.PI * 2 * 1.2 + 1);
    const pts = [];
    for (let k = 0; k <= 14; k++) {
      const s = k / 14;
      // up from below the field, curving to the left, a small hook at the tip
      pts.push([HEART.cx - 4 + Math.sin(s * 2.4) * 12 - s * s * 10 + dx * s, HEART.cy + 40 - s * 52 + dy * s]);
    }
    return pts;
  };
  const cathPaint = (tt) => [{ pts: cath(tt), od: 1.6, w: 1.6 }];
  // a frame of the heart field at pulse k of a run at pps; width: the pulse's length (s), blurring
  function heartFrame(k, pps, { n = 72, span = 40, width = 0.004, detected = 300, tag = '' } = {}) {
    return cache(`h${tag}:${pps}:${k}:${n}:${width}:${detected}`, () => {
      const tt = k / pps, sub = width > 0.01 ? 5 : 1;
      let T = null;
      for (let s = 0; s < sub; s++) {
        const Ts = L.frame({ ...HEART, n, span, detected: detected / sub, seed: 3000 + k * 7 + s + pps * 1000, paint: cathPaint(tt + (s / Math.max(1, sub - 1) - 0.5) * width) });
        if (!T) T = Ts; else for (let i = 0; i < T.length; i++) T[i] = T[i] < 0 ? -1 : T[i] + Ts[i];
      }
      if (sub > 1) for (let i = 0; i < T.length; i++) if (T[i] >= 0) T[i] /= sub;
      return T;
    });
  }

  // ================================================================ 8-bit: pulsed against continuous
  function pulseScene(t) {
    px.fillAll('ink');
    const W = px.W, H = px.H, x0 = 22, x1 = W - 10, slow = 12;          // shown 12 times slower
    const now = t / slow;                                                // (900 px a second of real time)
    const rows = [{ y: 60, kind: 'cont' }, { y: 130, kind: 'pulse' }];
    for (const { y, kind } of rows) {
      panel(api, x0 - 4, y - 44, x1 - x0 + 8, 54);
      px.rect(x0, y, x1 - x0, 1, 'mid');
      px.rect(x0, y - 38, 1, 38, 'mid');
      px.text('mA', x0 - 2, y - 43, 'mid');
      // the current through time, the newest at the right edge
      for (let x = x0 + 1; x < x1; x++) {
        const tt = now - (x1 - x) / 900;
        if (tt < 0) continue;
        const ph = (tt * 30) % 1, on = kind === 'cont' ? true : ph < 0.24;     // 8 ms of each 33
        const h = kind === 'cont' ? 6 : on ? 32 : 0;
        if (h) px.rect(x, y - h, 1, h, kind === 'cont' ? 'violet' : 'violet', on ? 0.9 : 0.4);
        // the camera's frames: a tick every 33 ms
        if (Math.floor(tt * 30) !== Math.floor((tt - 1 / 900) * 30)) px.rect(x, y + 2, 1, 4, 'yellow');
      }
      // the beam now: on or off
      const ph = (now * 30) % 1, on = kind === 'cont' || ph < 0.24;
      px.glow(x1 + 2, y - 18, 4, 'violet', on ? 0.9 : 0.1, 2);
    }
    // the 33 ms between pulses, the 8 ms of one
    const y = 130, pAt = (k) => x1 - (now - (Math.floor(now * 30) - k) / 30) * 900;
    const a = pAt(1), b = pAt(2);
    if (b > x0 + 20) {
      // from one pulse's start to the next's, over their tops; the width of one beside it
      px.line(b, y - 35, a, y - 35, 'yellow', 0.8); px.rect(b, y - 37, 1, 5, 'yellow'); px.rect(a, y - 37, 1, 5, 'yellow');
      px.text('33 ms', (a + b) / 2, y - 42, 'yellow', 1, 1, 'center');
      px.text('8 ms', b + 0.24 * 30 + 3, y - 20, 'white', 0.9);
    }
    return { contBox: [x0 - 4, 16, x1 - x0 + 8, 54], pulseBox: [x0 - 4, 86, x1 - x0 + 8, 54] };
  }

  // ================================================================ 8-bit: the ABC's loop in a field of tissue
  /* Photons up from the tube (bottom) through soft tissue to the receptor (top). The tissue thickens
     when a second block slides in; fewer get through; the brightness meter drops; the ABC climbs
     its curve, more photons and harder ones, until the meter is back on its line. */
  const specMemo = new Map(), specOf = (kv) => { const k = Math.round(kv); if (!specMemo.has(k)) specMemo.set(k, tungstenSpectrum(k, 0.35)); return specMemo.get(k); };
  const LT = (q, cm) => { let s = 0, w = 0; const sp = specOf(kvOf(q)); for (let E = 15; E <= kvOf(q); E += 2) { const f = sp(E) * E; s += f * Math.exp(-Materials.mu('soft', E) * cm); w += f; } return s / w; };
  const loopSig = (q, cm) => (maOf(q) / 2) * (kvOf(q) / 70) ** 2 * LT(q, cm);
  const solveLoop = (cm, tgt) => { let a = 0, b = 1; for (let k = 0; k < 16; k++) { const m = (a + b) / 2; if (loopSig(m, cm) < tgt) a = m; else b = m; } return (a + b) / 2; };
  const LOOP = (() => { const tgt = loopSig(0.25, 5); return { tgt, q1: 0.25, q2: solveLoop(10, tgt) }; })();
  const loopQ = (t) => {
    // the thickness: 5 cm, a second 5 cm block sliding in between 4 and 5 s; the ABC catches up
    if (t < 6) return LOOP.q1;                         // (shown slowed: the real loop settles in a few pulses)
    const k = 1 - Math.exp(-(t - 6) / 0.9);
    return lerp(LOOP.q1, LOOP.q2, k);
  };
  function loopScene(t) {
    px.fillAll('ink');
    const W = px.W, H = px.H, yR = 34, yB = H - 22, cmPx = (yB - yR - 26) / 10;
    const thick = 5 + 5 * span(t, 4, 5);
    const q = loopQ(t), kv = kvOf(q), ma = maOf(q);
    const yT = yB - thick * cmPx;
    // the tissue (and the block sliding in from the right), its atoms
    const fx = lerp(W + 10, 0, span(t, 4, 5));
    px.rect(0, yB - 5 * cmPx, W, 5 * cmPx, 'muscle', 0.2);
    px.rect(fx, yB - 10 * cmPx, W, 5 * cmPx, 'muscle', 0.28);
    const ra = rng(12);
    for (let k = 0; k < 900; k++) { const x = ra() * W, y = yB - ra() * 10 * cmPx, big = k % 7 === 0; if (y > yB - 5 * cmPx || x > fx) px.rect(x, y, big ? 2 : 1, big ? 2 : 1, big ? 'peach' : 'pink', big ? 0.5 : 0.4); }
    // the receptor along the top, the tube's side along the bottom
    px.rect(0, yR - 6, W, 6, 'teal', 0.8);
    px.rect(0, yB + 6, W, 2, 'violet', 0.5);
    // the photons: born at a rate set by the mA and kV, each with an energy from the spectrum
    const rate = 34;
    const i0 = Math.max(0, Math.floor((t - 1.4) * rate * 6)), i1 = Math.floor(t * rate * 6);
    for (let i = i0; i <= i1; i++) {
      const r = rng(20000 + i), tb = i / (rate * 6);
      // thinning: only a share of the candidate photons is made, as the output allows
      const out = (maOf(loopQ(tb)) / 2) * (kvOf(loopQ(tb)) / 70) ** 2 / 1.2;
      if (r() > out) continue;
      const kvb = kvOf(loopQ(tb)), spb = specOf(kvb);
      let E = 30; for (let k = 0; k < 50; k++) { const e = 15 + r() * (kvb - 15); if (r() < spb(e)) { E = e; break; } }
      const age = t - tb, v = 160, x = 4 + r() * (W - 8);
      const thAt = 5 + 5 * span(tb, 4, 5), d = -Math.log(1 - r() * 0.999) / Materials.mu('soft', E);
      const inBlock = (yy) => yy < yB - 5 * cmPx ? x > lerp(W + 10, 0, span(tb, 4, 5)) : true;
      const yHit = yB - d * cmPx, hit = d < thAt && inBlock(yHit);
      const tHit = (yB + 8 - yHit) / v, y = yB + 8 - age * v;
      if (!hit) {
        if (y > yR) px.photon(x, y, 0, -1, 5, keVColor(E), 0.9, t * 30 + i);
        else if (y > yR - 8) px.rect(x - 1, yR - 4, 3, 3, 'white', 0.9);
        continue;
      }
      if (age < tHit) { px.photon(x, y, 0, -1, 5, keVColor(E), 0.9, t * 30 + i); continue; }
      const e = age - tHit, fPE = 1 / (1 + (E / 25) ** 3);
      if (r() < fPE) { if (e < 0.15) px.glow(x, yHit, 3, 'white', 0.8, i); if (e < 0.5) electron(px, x + e * 20, yHit - e * 8, 1 - e / 0.5, 'cyan'); }
      else {
        const ang = (r() - 0.5) * 3.2 + Math.PI, sx = Math.sin(ang), sy = Math.cos(ang);
        if (e < 0.1) px.glow(x, yHit, 2, 'orange', 0.8, i);
        const xx = x + sx * e * v, yy = yHit + sy * e * v;
        if (e < 1.2 && yy > yR && yy < yB + 8 && xx > 0 && xx < W) px.photon(xx, yy, sx, sy, 4, keVColor(E * 0.9), 0.7, t * 30 + i);
      }
    }
    // the brightness meter against its set level, and the technique
    const meas = loopSig(q, thick) / LOOP.tgt;
    const mx = W - 16, my = 30, mh = 70;
    panel(api, mx - 4, my - 4, 14, mh + 8);
    px.rect(mx, my + mh - Math.min(mh, meas * mh * 0.6), 6, Math.min(mh, meas * mh * 0.6), meas < 0.85 ? 'orange' : 'yellow');
    px.rect(mx - 3, my + mh - mh * 0.6, 12, 1, 'white');
    hud(api, [['kV', String(Math.round(kv)), 'yellow'], ['mA', ma.toFixed(1), 'yellow']], { x: 4, y: 4, w: 46 });
    if (t > 4.5 && t < 9) api.mark([mx - 6, my - 6, 18, mh + 12], meas < 0.85 ? 'orange' : 'yellow', t);
    api.keepOut([0, yR - 8, W, yB - yR + 18]);
    return { meas };
  }

  // ================================================================ 8-bit: image orientation
  // the upper abdomen with barium in the stomach (on the patient's left): the image as the receptor
  // delivers it, then turned and flipped to match the patient
  const ORIENT = { cx: W0 / 2 + 6, cy: 212 };
  // the stomach's box in that field (0..1 of its width and height), from the model's own lumen
  const stoBox = (() => {
    let c0 = 1, c1 = 0, r0 = 1, r1 = 0;
    for (let r = 0; r < L.IMG.H; r++) for (let c = 0; c < W0; c++) {
      if (L.sto[r * W0 + c] < 1.5) continue;
      const u = (c - (ORIENT.cx - 60)) / 120, v = (r - (ORIENT.cy - 60)) / 120;
      if (u < 0.45 || u > 1 || v < 0 || v > 1) continue;              // (the stomach: not the duodenum, on the right)
      c0 = Math.min(c0, u); c1 = Math.max(c1, u); r0 = Math.min(r0, v); r1 = Math.max(r1, v);
    }
    return [c0, r0, Math.max(0.05, c1 - c0), Math.max(0.05, r1 - r0)];
  })();
  const orientImg = (() => { const n = 80; const T = L.frame({ ...ORIENT, n, span: 120, detected: 1500, seed: 9, sto: () => 0.12, oes: () => 0.3 }); return L.display(T, n); })();

  // the live screens in the 3D steps: the heart field (catheter moving), at 15 pps
  const liveHeart = (t) => cache('lv' + Math.floor(t * 15), () => L.display(heartFrame(Math.floor(t * 15), 15, { n: FIELD_PX, span: FIELD_PX }), FIELD_PX));

  const steps = [
    {
      title: 'Pulsed fluoroscopy', dur: 14, view: 'pixel', fadeIn: 0.4, scale: '10 ms',
      frame(t) {
        const r = pulseScene(t);
        if (t < 6.5) api.mark(r.contBox, 'violet', t); else api.mark(r.pulseBox, 'violet', t);
      },
      caption: [
        { from: 0.6, to: 6.5, text: '<b>Continuous fluoroscopy</b>: the tube runs all the time at a low current while the camera reads out a frame every 33 ms.' },
        { from: 6.5, to: 14, text: '<b>Pulsed fluoroscopy</b>: one short, stronger pulse for each frame (here 8 ms), the beam off in between. Each image is a single pulse.' },
      ],
    },
    {
      title: 'Pulse rate', dur: 16, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('ink');
        const rates = [30, 15, 7.5], n = Math.max(48, Math.min(96, Math.floor((px.W - 24) / 3))), gap = Math.floor((px.W - 3 * n) / 4);
        rates.forEach((pps, i) => {
          const x = gap + i * (n + gap), y = Math.max(14, Math.round((px.H - n - 44) / 2)), k = Math.floor(t * pps);
          const T = heartFrame(k, pps, { n, span: 52 });
          const lum = cache(`hl:${pps}:${k}:${n}`, () => L.display(T, n));
          panel(api, x - 2, y - 2, n + 4, n + 4);
          L.blit(px, lum, n, x, y, 1);
          px.text(String(pps), x + n / 2, y + n + 6, 'yellow', 1, 2, 'center');
          px.text('pps', x + n / 2, y + n + 18, 'mid', 1, 1, 'center');
          // the dose rate, relative to 30 pps
          const bw = Math.round((n - 8) * pps / 30);
          px.rect(x + 4, y + n + 28, n - 8, 5, 'dkgrey'); px.rect(x + 4, y + n + 28, bw, 5, 'orange');
          // each pulse, a flash on the panel's corner
          if ((t * pps) % 1 < 0.35) px.rect(x + n - 4, y + 2, 3, 3, 'violet');
          if (t > 6 && i === 2) api.mark([x - 3, y - 3, n + 6, n + 6], 'yellow', t);
          api.keepOut([x - 2, y - 2, n + 4, n + 38]);
        });
      },
      cues: [[0.5, () => sfx.tick()]],
      caption: [
        { from: 0.6, to: 6, text: 'Each pulse is one image. At 30 pulses a second (<b>pps</b>) the moving catheter is followed smoothly.' },
        { from: 6, to: 11, text: 'At 15 or 7.5 pps it jumps from frame to frame: less <b>temporal resolution</b>. But the dose rate falls about in proportion.' },
        { from: 11, to: 16, text: 'So the rule: the lowest pulse rate that still follows the motion.' },
      ],
    },
    {
      title: 'Pulse width', dur: 13, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('ink');
        const n = Math.max(56, Math.min(110, Math.floor((px.W - 30) / 2))), gap = Math.floor((px.W - 2 * n) / 3);
        [[0.004, '4 ms'], [0.033, '33 ms']].forEach(([w, lab], i) => {
          const x = gap + i * (n + gap), y = Math.max(14, Math.round((px.H - n - 30) / 2)), k = Math.floor(t * 15);
          const T = heartFrame(k, 15, { n, span: 40, width: w, tag: 'w' });
          const lum = cache(`wl:${w}:${k}:${n}`, () => L.display(T, n));
          panel(api, x - 2, y - 2, n + 4, n + 4);
          L.blit(px, lum, n, x, y, 1);
          px.text(lab, x + n / 2, y + n + 7, 'yellow', 1, 2, 'center');
          if (t > 5 && i === 1) api.mark([x - 3, y - 3, n + 6, n + 6], 'orange', t);
          api.keepOut([x - 2, y - 2, n + 4, n + 22]);
        });
      },
      caption: [
        { from: 0.6, to: 5, text: 'Each pulse lasts only a few milliseconds (the <b>pulse width</b>): the moving catheter is caught sharp in every frame.' },
        { from: 5, to: 13, text: 'Exposed for a whole 33 ms video frame, as in continuous fluoroscopy, it moves during the exposure and smears: <b>motion blur</b>.' },
      ],
    },
    {
      title: 'Beam-on time', dur: 13, scale: '10 cm',
      enter() { S.reset(); U.skinAlpha(0.9); },
      cam: [[0, [-250, 95, 110], [-128, 38, 0], 38], [13, [-230, 85, 90], [-128, 38, 0], 36]],
      cues: [[5, () => { sfx.tone(1760, 1760, 0.18, 'square', 0.4); sfx.tone(1760, 1760, 0.18, 'square', 0.4, 0.3); sfx.tone(1760, 1760, 0.18, 'square', 0.4, 0.6); }], [9.5, () => sfx.click()]],
      frame(t) {
        U.setBeam({ a: 1 });
        sfx.hold('beam', 96, 0.015, 'square');
        // the clock, shown fast (6 seconds a second) from 4:30 to the alarm at 5:00 and its reset at 9.5 s; after that at its own pace
        const clock = t < 5 ? 270 + t * 6 : t < 9.5 ? 300 + (t - 5) * 6 : 327 + (t - 9.5);
        const alarm = t >= 5 && t < 9.5, blink = alarm && (t * 3) % 1 < 0.5;
        // about 10 mGy a minute at the reference point (an adult abdomen); DAP: that times the field there
        // (a 23 cm field at 99 cm from the focus is 10.5 cm across at the reference point's 45)
        const ak = (clock / 60) * 10, dap = ak * Math.PI * (23 * 45 / 99 / 2) ** 2 / 1000;
        const w = 90, x = px.W - w - 6, y = 6;
        panel(api, x, y, w, 46);
        px.text(mmss(clock), x + w / 2, y + 6, blink ? 'red' : alarm ? 'orange' : 'lime', 1, 3, 'center');
        px.text(ak.toFixed(1) + ' mGy', x + w - 4, y + 26, 'mid', 1, 1, 'right');
        px.text(dap.toFixed(1) + ' Gycm', x + w - 8, y + 36, 'mid', 1, 1, 'right'); px.text('2', x + w - 7, y + 34, 'mid');
        if (blink) px.frame(x - 1, y - 1, w + 2, 48, 'red');
        if (U.parts.head) api.mark(boxLocal(api, U.parts.head, [-19, -10, -15], [15, 10, 15]), alarm ? 'red' : 'yellow', t);
      },
      caption: [
        { from: 0.6, to: 5, text: 'The console adds up every second the beam is on, the <b>fluoroscopy time</b>, with the dose so far: air kerma and dose–area product.' },
        { from: 5, to: 13, text: 'Every 5 minutes of beam-on time an <b>alarm</b> sounds until someone resets it: a required prompt to weigh the dose given so far.' },
      ],
    },
    {
      title: 'Automatic brightness control', dur: 18, scale: '10 cm',
      enter() { S.reset(); U.skinAlpha(0.45); },
      cam: [[0, [190, 60, 120], [0, 10, 0], 40], [18, [170, 70, 100], [0, 10, 0], 40]],
      frame(t) {
        // the table carries the patient head-ward: the beam (at z = 0) moves from the chest to the abdomen
        const off = lerp(-20, 10, span(t, 1.5, 14, api.ease.inOut));
        U.bed.position.z = off;
        const rowAt = (tt) => L.rowOf(-lerp(-20, 10, span(tt, 1.5, 14, api.ease.inOut)));
        U.setBeam({ a: 0.9 });
        sfx.hold('beam', 96, 0.015, 'square');
        const a = abcAt(t, rowAt), row = rowAt(t);
        const n = 72, sc = Math.max(1, Math.floor(Math.min(px.H * 0.48, px.W * 0.32) / n)), x = 6, y = 6;
        const k = Math.floor(t * 15);
        const lum = cache('abc' + k, () => {
          const T = L.frame({ cx: W0 / 2, cy: row, n, kv: a.kv, detected: 300 * a.meas, seed: 7000 + k });
          // displayed as the console does, then darkened by the receptor's shortfall (meas: its
          // signal against the set level), which is what the loop is correcting
          const lum = L.display(T, n), dk = 0.55 * Math.log(Math.min(1.2, a.meas));
          for (let i = 0; i < lum.length; i++) if (lum[i] >= 0) lum[i] = clamp01(lum[i] + dk);
          return lum;
        });
        panel(api, x - 2, y - 2, n * sc + 4, n * sc + 4);
        L.blit(px, lum, n, x, y, sc);
        // the brightness against its set level, beside the image
        const bx = x + n * sc + 6, bh = n * sc;
        px.rect(bx, y, 5, bh, 'dkgrey');
        px.rect(bx, y + bh - Math.min(bh, a.meas * bh * 0.6), 5, Math.min(bh, a.meas * bh * 0.6), a.meas < 0.85 ? 'orange' : 'yellow');
        px.rect(bx - 2, y + bh - bh * 0.6, 9, 1, 'white');
        api.keepOut([bx - 2, y, 9, bh]);
        const rate = akRate(a.kv, a.ma, 15);
        hud(api, [['kV', String(Math.round(a.kv)), 'yellow'], ['mA', a.ma.toFixed(1), 'yellow'], ['mGy/m', rate.toFixed(0), rate > RATE_LIMIT * 0.98 ? 'red' : 'orange']], { w: 60 });
        if (t > 9) api.mark(U.patient, 'yellow', t);
      },
      caption: [
        { from: 1, to: 6, text: 'The table carries the patient through the beam, from the chest down to the abdomen: ever thicker, denser anatomy, fewer photons reaching the receptor.' },
        { from: 6, to: 11, text: '<b>Automatic brightness control</b> (ABC) senses the drop and climbs its curve, raising kV and mA until the brightness is back at its set level.' },
        { from: 11, to: 18, text: 'So the dose rate follows the patient’s thickness, up to a legal ceiling: 88 mGy per minute at the reference point in normal mode (US).' },
      ],
    },
    {
      title: 'The ABC’s loop', dur: 14, view: 'pixel', scale: '1 cm',
      frame(t) { loopScene(t); },
      caption: [
        { from: 0.6, to: 4, text: 'Photons from the tube cross the tissue; those that reach the receptor make the image and set its brightness.' },
        { from: 4, to: 7.5, text: 'Thicker tissue absorbs and scatters more: the <b>brightness</b> drops below its set level.' },
        { from: 7.5, to: 14, text: 'The ABC raises the mA (more photons) and the kV (more penetrating ones, at some cost in contrast) until the brightness is restored.' },
      ],
    },
    {
      title: 'Noise and dose', dur: 15, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('ink');
        const levels = [[25, '1x'], [100, '4x'], [400, '16x']], n = Math.max(48, Math.min(90, Math.floor((px.W - 24) / 3))), gap = Math.floor((px.W - 3 * n) / 4);
        const k = Math.floor(t * 4);
        levels.forEach(([d, lab], i) => {
          const x = gap + i * (n + gap), y = Math.max(10, Math.round((px.H - n - 60) / 2));
          const lum = cache(`nz:${d}:${k}:${n}`, () => L.display(L.frame({ cx: W0 / 2, cy: 255, n, span: 56, detected: d, seed: 500 + k * 3 + i }), n));
          panel(api, x - 2, y - 2, n + 4, n + 4);
          L.blit(px, lum, n, x, y, 1);
          px.text(lab, x + n / 2, y + n + 5, 'yellow', 1, 2, 'center');
          if (t < 6 && i === 0) api.mark([x - 3, y - 3, n + 6, n + 6], 'yellow', t);
          api.keepOut([x - 2, y - 2, n + 4, n + 18]);
        });
        // a row of pixels counting the photons that land in them: the counts scatter by about their square root
        const cells = 10, cw = 14, cx0 = Math.round(px.W / 2 - cells * cw / 2), cy0 = px.H - 30, per = 3;
        const ph = (t % per) / per, mean = 16;
        for (let c = 0; c < cells; c++) {
          const r = rng(800 + c + Math.floor(t / per) * 31);
          // Poisson-ish count for this pixel this frame
          let N = 0; for (let m = 0; m < mean * 2; m++) if (r() < 0.5) N++;
          const shown = Math.floor(N * Math.min(1, ph * 1.4));
          const g = Math.round(40 + Math.min(1, shown / 26) * 200);
          px.rect(cx0 + c * cw, cy0, cw - 1, 12, `rgb(${g},${g},${g})`);
          px.text(String(shown), cx0 + c * cw + cw / 2, cy0 + 14, 'lime', 1, 1, 'center');
          for (let m = shown; m < N; m++) {
            const rr = rng(c * 100 + m), ty = lerp(px.H + 4, cy0 + 6, clamp01(ph * 1.4 * N / Math.max(1, m + 1) - 0.1));
            if (ty < px.H) px.px(cx0 + c * cw + 2 + rr() * (cw - 4), ty, 'violet', 0.9);
          }
        }
        if (t >= 6) api.mark([cx0 - 2, cy0 - 2, cells * cw + 3, 24], 'lime', t);
        api.keepOut([cx0 - 2, cy0 - 2, cells * cw + 3, 24]);
      },
      caption: [
        { from: 0.6, to: 6, text: 'Each frame is built from relatively few photons, and they arrive at random: the grainy mottle is <b>quantum noise</b>.' },
        { from: 6, to: 15, text: 'A pixel expecting N photons gets N ± √N. Four times the dose halves the noise. The ABC’s set level is the compromise: enough photons to see, no more.' },
      ],
    },
    {
      title: 'Recursive filtering and lag', dur: 15, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('ink');
        const n = Math.max(56, Math.min(110, Math.floor((px.W - 30) / 2))), gap = Math.floor((px.W - 2 * n) / 3), k = Math.floor(t * 15);
        [[0, '0%'], [NR_K[2], '70%']].forEach(([K, lab], i) => {
          const x = gap + i * (n + gap), y = Math.max(14, Math.round((px.H - n - 30) / 2));
          const lum = cache(`rf:${K}:${k}:${n}`, () => {
            // the filter run over the last 14 pulses (0.7^14 is under 1 %: the start is forgotten)
            let acc = null;
            for (let j = Math.max(0, k - 14); j <= k; j++) acc = recursiveStep(acc, heartFrame(j, 15, { n, span: 40, detected: 120, tag: 'r' }), K);
            return L.display(acc, n);
          });
          panel(api, x - 2, y - 2, n + 4, n + 4);
          L.blit(px, lum, n, x, y, 1);
          px.text(lab, x + n / 2, y + n + 7, i ? 'yellow' : 'mid', 1, i ? 2 : 1, 'center');
          if (i === 1 && t > 1) api.mark([x - 3, y - 3, n + 6, n + 6], 'yellow', t);
          api.keepOut([x - 2, y - 2, n + 4, n + 22]);
        });
      },
      caption: [
        { from: 0.6, to: 7, text: '<b>Recursive filtering</b>: each frame shown is 70% the one before and 30% the new pulse (the console’s medium setting). What holds still loses most of its noise...' },
        { from: 7, to: 15, text: '...but what moves leaves a fading trail behind it: <b>lag</b>. Less filtering for fast-moving work, more for still anatomy.' },
      ],
    },
    {
      title: 'Last image hold', dur: 12, scale: '10 cm',
      enter() { S.reset(); },
      cam: [[0, [150, 70, 10], [50, 35, -160], 40], [12, [140, 75, -5], [50, 40, -165], 38]],
      cues: [[5.2, () => sfx.click()]],
      frame(t) {
        const on = t < 5.2;
        U.press(on ? 1 : 1 - span(t, 5.2, 5.5));
        U.setBeam({ a: on ? 1 : 0 });
        sfx[on ? 'hold' : 'stop']('beam', 96, 0.015, 'square');
        S.screens(liveHeart(on ? t : 5.19), cache('refheart', () => L.display(heartFrame(3, 15, { n: FIELD_PX, span: FIELD_PX, detected: 2000 }), FIELD_PX)));
        if (t > 5.4) api.mark(U.screens[0], 'lime', t);
        else api.mark(U.screens[0], 'violet', t);
      },
      caption: [
        { from: 0.6, to: 5.2, text: 'Screening: the live image follows the catheter while the pedal is held.' },
        { from: 5.4, to: 12, text: 'Lift the pedal: <b>last image hold</b> keeps the final frame (filtered, so less noisy) on the screen to study, with no more radiation.' },
      ],
    },
    {
      title: 'Turning the image', dur: 15, view: 'pixel', scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        const n = 80, sc = Math.max(1, Math.floor(Math.min(px.H - 36, px.W * 0.75) / n)), s = n * sc;
        const x = Math.round(px.W / 2 - s / 2), y = Math.max(8, Math.round((px.H - s) / 2) - 8);
        // as delivered: a quarter turn out and mirrored; then the rotate, then the flip
        const rot = (-Math.PI / 2) * (1 - span(t, 4.5, 6.5));
        const flip = span(t, 9, 10.5);
        panel(api, x - 3, y - 3, s + 6, s + 6);
        px.g.save();
        L.blit(px, orientImg, n, x, y, sc, { rot, flipH: flip < 0.5 });
        px.g.restore();
        // the flip shown as a squeeze through zero width
        if (flip > 0 && flip < 1) { const w = Math.abs(1 - 2 * flip) * s; px.rect(x, y, (s - w) / 2, s, 'ink'); px.rect(x + s - (s - w) / 2, y, (s - w) / 2, s, 'ink'); }
        // the stomach (barium, on the patient's left), once the image is the right way round
        if (t > 10.5) api.mark([x + s * stoBox[0] - 2, y + s * stoBox[1] - 2, s * stoBox[2] + 4, s * stoBox[3] + 4], 'yellow', t);
        api.keepOut([x - 3, y - 3, s + 6, s + 6]);
      },
      cues: [[4.5, () => sfx.blip(660)], [9, () => sfx.blip(880)]],
      caption: [
        { from: 0.6, to: 4.5, text: 'The image comes off the receptor however the C and its camera happen to sit: here turned a quarter and mirrored.' },
        { from: 4.5, to: 9, text: '<b>Rotate</b> turns the displayed image (not the beam) until the head is up...' },
        { from: 9, to: 15, text: '...and <b>flip</b> mirrors it so the patient’s left is on the screen’s right: the barium-filled stomach where it should be. Now moves of the C or table go the expected way.' },
      ],
    },
  ];
  return { title: 'Pulses and control', steps };
}
