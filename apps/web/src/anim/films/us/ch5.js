/* ULTRASOUND FILM, chapter 5: motion. M-mode (one line against time, through a beating heart:
   the left ventricle's walls closing in systole and parting in diastole); the Doppler effect in a
   field of moving blood cells, its equation, and why the angle matters; colour Doppler, BART;
   pulsed-wave spectral Doppler with the app's own waveform (core/doppler.js); aliasing at the
   Nyquist limit. Then the whole of it at work in the room. */
import { flowWave, wrapToWindow, dopplerShift } from '../../../core/doppler.js';
import { makeField, drawField, panel, poly, arrow, span2, faceStrip, TIS } from './wave.js';

const hash = (a, b) => { let h = Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
// the colour map every machine ships: Blue Away, Red Toward, brighter toward the window's edge (ultrasound.js colourOf)
function colourOf(v, half, b = 0) {
  const x = v / half, t = x >= 0 ? Math.min(1, x / (1 + b)) : Math.min(1, -x / (1 - b));
  const hot = Math.min(1, 0.32 + 1.1 * t), glow = Math.max(0, (t - 0.6) / 0.4);
  return x >= 0 ? [255 * hot, 230 * glow, 20 * glow] : [20 * glow, 230 * glow, 255 * hot];
}
const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

export function motion(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const R = S.room, W = S.W;
  const FACE = 16;
  const field3 = makeField(-10, FACE + 1, 520, 200, 3, 71);

  // ================================================================ M-mode: the heart along one line
  const HR = 72, T = 60 / HR;
  // the ventricle's contraction through a beat, 0 (relaxed, end diastole) to 1 (end systole)
  const squeeze = (t) => {
    const p = ((t / T) % 1 + 1) % 1;
    if (p < 0.38) return Math.sin(Math.PI / 2 * p / 0.38) ** 1.4;
    if (p < 0.55) return 1 - 0.8 * Math.sin(Math.PI / 2 * (p - 0.38) / 0.17);
    if (p < 0.86) return 0.2 - 0.12 * (p - 0.55) / 0.31;
    if (p < 0.95) return 0.08 - 0.13 * Math.sin(Math.PI * (p - 0.86) / 0.09);
    return 0.08 * (p - 0.95) / 0.05;
  };
  // depth (cm) of each boundary along the line at contraction s; x offset from the line bends them
  const layers = (s, dx) => {
    const k = dx * dx;                                      // (dx in cm: the walls curve gently off the line)
    return [
      ['wall', 0, 1.6], ['rvw', 1.6, 2.1 + 0.05 * s],
      ['blood', 2.1 + 0.05 * s, 3.8 + 0.25 * s + k * 0.015],
      ['myo', 3.8 + 0.25 * s + k * 0.015, 4.7 + 0.6 * s + k * 0.02],
      ['blood', 4.7 + 0.6 * s + k * 0.02, 9.5 - 1.1 * s - k * 0.03],
      ['myo', 9.5 - 1.1 * s - k * 0.03, 10.4 - 0.6 * s - k * 0.025],
      ['peri', 10.4 - 0.6 * s - k * 0.025, 10.75 - 0.6 * s - k * 0.025],
      ['lung', 10.75 - 0.6 * s - k * 0.025, 99],
    ];
  };
  const GREY = { wall: 130, rvw: 120, blood: 8, myo: 110, peri: 235, lung: 40 };
  // one column of the heart, its layers L (from layers()), drawn down from top; the speckle rides
  // with the tissue (hashed on the depth within its layer)
  const heartColumn = (xDraw, xHash, L, top, cmPx, y1) => {
    let li = 0;
    for (let y = top; y < y1; y++) {
      const dcm = (y - top) / cmPx;
      while (li < L.length - 1 && dcm >= L[li][2]) li++;
      const [kind, a] = L[li];
      const u = Math.floor((dcm - a) * 9), sp = hash(xHash * 3 + 7, u * 13 + kind.length * 101);
      let g = GREY[kind] * (0.45 + sp * 0.9);
      if (dcm - a < 0.12 && kind !== 'blood') g = Math.max(g, 200);     // the boundary's specular echo
      g = Math.min(255, g) | 0;
      if (g > 10) px.rect(xDraw, y, 1, 1, `rgb(${g},${g},${g})`);
    }
  };

  // ================================================================ Doppler scenes
  const VES = { y0: 108, y1: 142 };
  const cells = (() => { const r = rng(91), out = []; for (let i = 0; i < 140; i++) out.push({ x: r() * 560 - 20, y: VES.y0 + 3 + r() * (VES.y1 - VES.y0 - 6), ph: r() }); return out; })();
  // blood cells flowing left (laminar: fastest in the middle)
  const cellAt = (c, t, v = 40) => {
    const mid = (VES.y0 + VES.y1) / 2, hw = (VES.y1 - VES.y0) / 2, rho = (c.y - mid) / hw;
    const sp = v * (1 - rho * rho);
    const x = ((c.x - sp * t) % 580 + 580) % 580 - 20;
    return [x, c.y];
  };
  const vessel = (t, v = 40, a = 1) => {
    px.rect(-2, VES.y0 - 3, px.W + 4, 3, 'peach', 0.8 * a); px.rect(-2, VES.y1, px.W + 4, 3, 'peach', 0.8 * a);
    px.rect(-2, VES.y0, px.W + 4, VES.y1 - VES.y0, 'dkred', 0.35 * a);
    for (const c of cells) { const [x, y] = cellAt(c, t, v); px.rect(x - 1, y, 2, 2, 'red', 0.9 * a); }
  };
  const tissueOnly = field3.filter((q) => q.y < VES.y0 - 4 || q.y > VES.y1 + 4);

  // the colour/spectral scene: a linear probe over an artery and its vein; the colour box steered
  const ART = { y: 0.42, r: 0.075, tilt: -0.16, dir: 1 }, VEIN = { y: 0.64, r: 0.06, tilt: -0.16, dir: -1 };
  const steer = -20 * Math.PI / 180;
  const beam = [Math.sin(steer), Math.cos(steer)];                 // down and to the left
  const flowAng = (vs) => Math.atan2(Math.sin(vs.tilt), Math.cos(vs.tilt));
  // the beam-to-flow angle (cos): flow along the vessel's axis, sign by its direction
  const cosTo = (vs) => { const f = [Math.cos(flowAng(vs)) * vs.dir, Math.sin(flowAng(vs)) * vs.dir]; return -(f[0] * beam[0] + f[1] * beam[1]); };
  const vesOf = (vs, X, Y) => { const yc = vs.y + Math.tan(vs.tilt) * (X - 0.5); const d = (Y - yc) * Math.cos(vs.tilt); return Math.abs(d) < vs.r ? d / vs.r : null; };
  const WAVE_A = 'triphasic', VPK = 100;                           // cm/s: a high-resistance artery
  /* The grey picture (speckle, the vessels' walls, their dark lumens) is the same every frame:
     drawn once per size. What changes is the colour, so only the lumen pixels inside the box are
     kept, each with its vessel and its place across the lumen. */
  const dBase = new Map();
  const baseOf = (w, h) => {
    const key = w + ':' + h;
    let b = dBase.get(key);
    if (b) return b;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'), im = g.createImageData(w, h), cells = [];
    const lean = (YY) => (YY - 0.25) * (h / w) * Math.tan(steer);       // the box's sides run along the steered lines
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const X = i / w, Y = j / h, ra = vesOf(ART, X, Y), rv = vesOf(VEIN, X, Y);
      let v = ra != null || rv != null ? 6 + hash(i * 5, j * 3) * 14 : 50 + hash(i * 7 + 1, j * 11) * 120;
      if ((ra != null && Math.abs(Math.abs(ra) - 1) < 0.12) || (rv != null && Math.abs(Math.abs(rv) - 1) < 0.15)) v = 200;
      const o = (j * w + i) * 4; im.data[o] = im.data[o + 1] = im.data[o + 2] = v; im.data[o + 3] = 255;
      const bx0 = 0.32 + lean(Y);
      if (Y > 0.25 && Y < 0.8 && X > bx0 && X < bx0 + 0.5) {
        if (ra != null && Math.abs(ra) < 0.88) cells.push(i, j, 1, 1 - ra * ra);
        else if (rv != null && Math.abs(rv) < 0.85) cells.push(i, j, 2, 1 - rv * rv);
      }
    }
    g.putImageData(im, 0, 0);
    b = { cv, cells };
    dBase.set(key, b);
    return b;
  };
  function dopplerImage(t, x0, y0, w, h, { half = 70, base = 0, box = true, gate = null } = {}) {
    const vA = VPK * flowWave(WAVE_A, t, T), vV = 30 * flowWave('steady', t, T);
    const b = baseOf(w, h), cA = cosTo(ART), cV = cosTo(VEIN);
    px.g.drawImage(b.cv, x0, y0);
    if (box) {
      const c = b.cells;
      for (let k = 0; k < c.length; k += 4) {
        const v = c[k + 2] === 1 ? vA * c[k + 3] * cA : vV * c[k + 3] * cV;
        if (Math.abs(v) <= 3) continue;
        px.rect(x0 + c[k], y0 + c[k + 1], 1, 1, rgb(colourOf(wrapToWindow(v, half, base), half, base)));
      }
    }
    if (box) {
      // its outline
      const pt = (X, Y) => [x0 + X * w, y0 + Y * h];
      const lean = (YY) => (YY - 0.25) * (h / w) * Math.tan(steer);
      const corners = [[0.32, 0.25], [0.82, 0.25], [0.82, 0.8], [0.32, 0.8]].map(([X, Y]) => pt(X + lean(Y), Y));
      for (let k = 0; k < 4; k++) { const a = corners[k], b = corners[(k + 1) % 4]; px.line(a[0], a[1], b[0], b[1], 'lime', 0.8); }
    }
    if (gate) {
      // the PW line and its gate on the artery
      const gx = x0 + gate[0] * w, gy = y0 + gate[1] * h;
      px.line(gx - beam[0] * gy * 0.9, y0, gx + beam[0] * (h - gate[1] * h), y0 + h, 'white', 0.5, 2);
      px.line(gx - 4, gy - 3, gx + 4, gy - 3, 'white'); px.line(gx - 4, gy + 3, gx + 4, gy + 3, 'white');
    }
    return { vA, vV };
  }
  // the spectral display: velocity up (toward), time across, the newest at the right
  function spectrum(t, x0, y0, w, h, { nyq = 140, base = 0, colsPerSec = 110 } = {}) {
    panel(api, x0, y0, w, h, 0.95);
    const zeroY = y0 + h / 2 + base * h / 2;
    const vel = (row) => (zeroY - row) / (h / 2) * nyq;          // cm/s at a row (before the wrap)
    for (let i = 0; i < w - 2; i++) {
      const tc = t - (w - 2 - i) / colsPerSec;
      if (tc < 0) continue;
      const col = Math.floor(tc * colsPerSec);
      const vmax = VPK * flowWave(WAVE_A, tc, T);                 // angle-corrected, as the machine labels it
      // a small gate near the axis: speeds from about half the peak up to it (spectral broadening)
      for (let row = y0 + 1; row < y0 + h - 1; row++) {
        const v = vel(row + 0.5);
        let p = 0;
        for (const shift of [-2 * nyq * 2 / 2, 0, 2 * nyq]) {          // where an aliased shift lands
          const u = v + shift;
          const lo = Math.min(0.5 * vmax, vmax), hi = Math.max(0.5 * vmax, vmax);
          if (u >= lo - 2 && u <= hi + 2 && Math.abs(vmax) > 4) p = Math.max(p, 1 - Math.abs(u - (lo + hi) / 2) / (Math.abs(hi - lo) / 2 + 4));
        }
        const sp = -Math.log(1 - hash(col * 3 + 1, row * 7) * 0.999);
        const g = clamp01(p * sp * 0.8) * 255 + hash(col, row * 3) * 14;
        if (g > 18) px.rect(x0 + 1 + i, row, 1, 1, `rgb(${g | 0},${g | 0},${g | 0})`);
      }
    }
    px.rect(x0 + 1, zeroY, w - 2, 1, 'cyan', 0.6);
    // the scale: cm/s at the window's top and bottom (the Nyquist limit), and the baseline
    px.text(String(Math.round(nyq * (1 + base))), x0 + w - 3, y0 + 2, 'white', 1, 1, 'right');
    px.text('-' + Math.round(nyq * (1 - base)), x0 + w - 3, y0 + h - 7, 'white', 1, 1, 'right');
    px.text('cm/s', x0 + 3, y0 + 2, 'mid');
    return { zeroY };
  }
  const dopTone = (t, on = true) => {
    if (!on) { sfx.stop('dop'); return; }
    const v = Math.abs(VPK * flowWave(WAVE_A, t, T) * cosTo(ART));
    sfx.hold('dop', 140 + v * 9, Math.min(0.05, v / 600), 'sawtooth');
  };

  const steps = [
    {
      title: 'M-mode', dur: 17, view: 'pixel', scale: '1 cm', fadeIn: 0.4,
      frame(t) {
        px.fillAll('black');
        const top = FACE + 2, cmPx = (px.H - top - 6) / 13, s = squeeze(t);
        // left: the heart in B-mode (8-bit), the M line through it
        const lw = Math.round(px.W * 0.36), cx = Math.round(lw / 2);
        for (let x = 4; x < lw; x++) {
          const fan = Math.abs(x - cx) < 6 + (lw / 2 - 10) * 0.9;
          if (!fan) continue;
          // the sector widens with depth: this column starts where the fan reaches it
          const dStart = Math.max(0, (Math.abs(x - cx) - 8) * 13 / (lw / 2 - 8));
          heartColumn(x, x, layers(s, (x - cx) / cmPx), top, cmPx, px.H - 6);
          if (dStart > 0) px.rect(x, top, 1, dStart * cmPx, 'black');
        }
        faceStrip(px, cx - 8, cx + 8, FACE, { n: 2, glow: () => 1 });
        px.line(cx, top, cx, px.H - 6, 'yellow', 0.8, 2);
        // right: the line against time, newest at the right, a 1 s grid
        const x0 = lw + 10, w = px.W - x0 - 4, cps = 40;
        px.rect(x0 - 1, top - 1, w + 2, px.H - top - 5, 'black');
        for (let i = 0; i < w; i++) {
          const tc = t - (w - 1 - i) / cps;
          if (tc < 0) continue;
          heartColumn(x0 + i, cx, layers(squeeze(tc), 0), top, cmPx, px.H - 6);
        }
        for (let k = 1; k < w / cps; k++) { const x = x0 + w - 1 - ((t % 1) + k - 1) * cps; if (x > x0) px.rect(x, top, 1, px.H - top - 6, 'cyan', 0.25); }
        api.keepOut([x0, top, w, px.H - top - 6]);
        // calipers: the cavity at end diastole and end systole
        const Ld = layers(0, 0), Ls = layers(1, 0);
        const yd0 = top + Ld[3][2] * cmPx, yd1 = top + Ld[4][2] * cmPx, ys0 = top + Ls[3][2] * cmPx, ys1 = top + Ls[4][2] * cmPx;
        if (t > 6) {
          const xd = x0 + w - 1 - ((t % T) / T) * cps * T * 0, xe = Math.max(x0 + 20, x0 + w - 1 - cps * ((t % T)));
          span2(px, xe, yd0, xe, yd1, 'lime'); px.text('4.8', xe - 3, (yd0 + yd1) / 2 - 2, 'lime', 1, 1, 'right');
          const xs = xe + 0.38 * T * cps;
          if (xs < x0 + w - 4) { span2(px, xs, ys0, xs, ys1, 'orange'); px.text('3.1', xs + 3, (ys0 + ys1) / 2 - 2, 'orange'); }
          void xd;
        }
        px.text(HR + '/min', x0 + w - 3, top + 2, 'white', 1, 1, 'right');
        if (t < 6) api.mark([cx - 14, top, 28, px.H - top - 8], 'yellow', t);
        else api.mark([x0, top + Ld[3][1] * cmPx - 4, w, (Ld[5][2] - Ld[3][1]) * cmPx + 8], 'lime', t);
      },
      caption: [
        { from: 0.6, to: 6, text: '<b>M-mode</b> (motion mode) fires one line, over and over, a thousand times a second: here through the heart’s right ventricle, septum and left ventricle.', place: 'right' },
        { from: 6, to: 17, text: 'Drawn against time, the moving walls trace waves: the septum and the back wall closing in systole and parting in diastole. Their distance and timing can be measured: 4.8 cm relaxed, 3.1 cm contracted.', place: 'left' },
      ],
    },
    {
      title: 'The Doppler effect', dur: 17, view: 'pixel', scale: '0.3 mm',
      cues: [[8, () => sfx.chime()]],
      frame(t) {
        px.fillAll('ink');
        const th = 60 * Math.PI / 180;
        const b = [Math.cos(th), Math.sin(th)];
        // the beam: down and to the right at 60 degrees to the vessel; the incoming waves along it
        const c = 30, lam = 16, o = [px.W * 0.18, FACE];
        const inc = { kind: 'plane', o, d: b, t0: 0, c, a: 0.9, lam, n: 0 };
        drawField(px, tissueOnly, [inc], (((t % 8) + 8) % 8) + 20, { gain: 0.5 });
        vessel(t, 22);
        faceStrip(px, o[0] - 40, o[0] + 40, FACE, { n: 6, glow: () => 1 });
        // one cell picked out: it meets the crests more often as it moves toward them, and sends its
        // echo out in rings centred where it was: bunched ahead (toward the probe), spread behind
        const v = [-0.28 * c, 0];                                // drawn hugely exaggerated
        const r0 = [px.W * 0.78, (VES.y0 + VES.y1) / 2];
        const tt = ((t % 8) + 8) % 8;            // (8 s: a whole number of the drawn cycles, no seam)
        const P = (tm) => [r0[0] + v[0] * tm, r0[1]];
        const vb = v[0] * b[0] + v[1] * b[1];
        const base = (r0[0] - o[0]) * b[0] + (r0[1] - o[1]) * b[1];
        for (let n = 0; n < 400; n++) {
          const tn = (c * n * lam / c + base - 20 * c) / (c - vb) ;       // when crest n reaches it
          if (tn < 0) continue;
          if (tn > tt) break;
          const rr = c * (tt - tn), q = P(tn);
          if (rr > 260) continue;
          const N = Math.ceil(rr * 2.4);
          for (let j = 0; j < N; j++) { const a = 2 * Math.PI * j / N; const x = q[0] + Math.cos(a) * rr, y = q[1] + Math.sin(a) * rr; if (y < VES.y0 - 2 || y > VES.y1 + 2) px.px(x, y, 'yellow', 0.55); }
        }
        const cp = P(tt);
        px.rect(cp[0] - 2, cp[1] - 2, 5, 5, 'yellow');
        arrow(px, cp[0], cp[1] - 8, cp[0] - 14, cp[1] - 8, 'yellow');
        // sent and received, and the shift between them (real numbers: 3 MHz, 50 cm/s, 60 degrees)
        if (t > 8) {
          const sx = px.W - 104, sy = FACE + 4, sw = 98, sh = 46;
          panel(api, sx, sy, sw, sh);
          poly(px, sw - 4, (i) => [sx + 2 + i, sy + 12 + Math.sin(i * 0.55 - t * 6) * 6], 'cyan');
          poly(px, sw - 4, (i) => [sx + 2 + i, sy + 32 + Math.sin(i * 0.75 - t * 8) * 6], 'yellow');
          const fd = dopplerShift(3e6, 0.5, th);
          px.text('3 MHz', sx + sw - 3, sy + 2, 'cyan', 1, 1, 'right');
          px.text('+' + Math.round(fd) + ' Hz', sx + sw - 3, sy + sh - 7, 'yellow', 1, 1, 'right');
          if (t < 12) sfx.hold('dop', 520, 0.03, 'triangle'); else sfx.stop('dop');
          api.mark([sx, sy, sw, sh], 'yellow', t);
        } else { sfx.stop('dop'); api.mark([cp[0] - 30, cp[1] - 40, 60, 60], 'yellow', t); }
      },
      caption: [
        { from: 0.6, to: 8, text: 'Blood cells moving toward the probe meet the waves more often than they arrive, and send their echoes out bunched together: the echo returns at a <b>higher frequency</b> (drawn hugely exaggerated). Moving away, lower.' },
        { from: 8, to: 17, text: 'The <b>Doppler shift</b> f<sub>D</sub> = 2 f₀ v cos θ ÷ c. At 3 MHz, blood at 50 cm/s seen at 60° shifts the echo by about 1 kHz: a sound you can hear, and the scanner plays it.', place: 'below' },
      ],
    },
    {
      title: 'The angle', dur: 15, view: 'pixel', scale: '0.3 mm',
      frame(t) {
        px.fillAll('ink');
        const deg = t < 2 ? 30 : t < 8 ? lerp(30, 90, span(t, 2, 7)) : lerp(90, 60, span(t, 9, 12));
        const th = deg * Math.PI / 180;
        drawField(px, tissueOnly, [], t, {});
        vessel(t, 22);
        // the beam line from the probe to the vessel at angle theta to the flow
        const hit = [px.W * 0.45, (VES.y0 + VES.y1) / 2];
        const b = [Math.cos(th), Math.sin(th)];                   // pointing down toward the vessel
        const L = (hit[1] - FACE) / b[1];
        const o = [hit[0] - b[0] * L, FACE];
        px.line(o[0], o[1], hit[0], hit[1], 'cyan', 0.8, 2);
        faceStrip(px, o[0] - 22, o[0] + 22, FACE, { n: 4, glow: () => 1 });
        // the flow (left, toward the probe side) and its part along the beam
        const v = 46;
        arrow(px, hit[0], hit[1], hit[0] - v, hit[1], 'red');
        const comp = -v * b[0];                                   // the flow's projection on the beam (toward the probe: negative b)
        const along = [hit[0] - b[0] * v * Math.cos(th), hit[1] - b[1] * v * Math.cos(th)];
        if (Math.abs(Math.cos(th)) > 0.02) arrow(px, hit[0], hit[1], along[0], along[1], 'yellow');
        px.line(hit[0] - v, hit[1], along[0], along[1], 'grey', 0.5, 2);
        void comp;
        // the shift: f0 3 MHz, v 50 cm/s
        const fd = dopplerShift(3e6, 0.5, th);
        const bx = px.W - 70, by = 30, bh = 60;
        panel(api, bx, by, 62, bh + 26);
        px.rect(bx + 22, by + 6 + bh * (1 - Math.cos(th)), 18, bh * Math.cos(th), 'yellow');
        px.text(Math.round(deg) + '°', bx + 31, by + bh + 9, 'cyan', 1, 1, 'center');
        px.text(Math.round(fd) + ' Hz', bx + 31, by + bh + 17, 'yellow', 1, 1, 'center');
        api.mark([hit[0] - v - 4, Math.min(hit[1], along[1]) - 6, v + 10, Math.abs(hit[1] - along[1]) + 12], 'yellow', t);
      },
      caption: [
        { from: 0.6, to: 8, text: 'Only the part of the motion <b>along the beam</b> counts, v cos θ. Toward 90° it falls to nothing: a vessel crossed square-on shows no shift at all, however fast its blood.', place: 'right' },
        { from: 8, to: 15, text: 'So the beam is steered or the probe heeled to meet the flow at <b>60° or less</b>, and the angle is set on the screen for the machine to correct by.', place: 'right' },
      ],
    },
    {
      title: 'Colour Doppler', dur: 15, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('black');
        const w = Math.min(px.W - 20, 300), h = px.H - FACE - 8, x0 = Math.round((px.W - w) / 2), y0 = FACE + 2;
        dopplerImage(t, x0, y0, w, h, { half: 70 });
        faceStrip(px, x0, x0 + w, FACE, { n: 24, glow: () => 0 });
        // the colour bar: toward at the top
        const cbx = x0 + w + 4;
        for (let j = 0; j < 60; j++) { const v = (1 - j / 30) * 70; px.rect(cbx, y0 + 20 + j, 4, 1, rgb(colourOf(v, 70))); }
        px.text('70', cbx + 6, y0 + 18, 'white'); px.text('-70', cbx + 6, y0 + 76, 'white');
        const yA = y0 + ART.y * h, yV = y0 + VEIN.y * h;
        if (t < 7.5) api.mark([x0 + w * 0.3, yA - ART.r * h - 4, w * 0.4, ART.r * 2 * h + 8], 'yellow', t);
        else api.mark([x0 + w * 0.3, yV - VEIN.r * h - 4, w * 0.4, VEIN.r * 2 * h + 8], 'cyan', t);
        api.keepOut([x0 + w * 0.2, y0 + h * 0.25, w * 0.75, h * 0.55]);
      },
      caption: [
        { from: 0.6, to: 7.5, text: '<b>Colour Doppler</b>: in every pixel of a box, the mean shift from a short burst of pulses down each line, painted over the grey image. <b>Red toward</b> the probe, brighter faster: this artery pulses.', place: 'above' },
        { from: 7.5, to: 15, text: '<b>Blue away</b>: its vein, flowing back the other way, steady. Not artery and vein: only direction relative to the beam (BART: Blue Away, Red Toward).', place: 'below' },
      ],
    },
    {
      title: 'Spectral Doppler', dur: 17, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('black');
        const w = Math.min(160, px.W - 20), h = 74, x0 = 8, y0 = FACE + 2;
        dopplerImage(t, x0, y0, w, h, { half: 70, box: false, gate: [0.48, ART.y + 0.01] });
        faceStrip(px, x0, x0 + w, FACE, { n: 12, glow: () => 0 });
        const sx = 8, sy = y0 + h + 8, sw = px.W - 16, sh = px.H - sy - 6;
        spectrum(t, sx, sy, sw, sh, { nyq: 140 });
        dopTone(t);
        if (t < 6) api.mark([x0 + w * 0.48 - 8, y0 + (ART.y + 0.01) * h - 8, 16, 16], 'white', t);
        else api.mark([sx + sw - 70, sy, 70, sh], 'lime', t);
        api.keepOut([sx, sy, sw, sh]);
      },
      caption: [
        { from: 0.6, to: 6, text: '<b>Pulsed-wave Doppler</b> listens at one depth only: the <b>gate</b>, a few millimetres of one artery.', place: 'right' },
        { from: 6, to: 17, text: 'Every speed in the gate, moment by moment: the <b>spectral</b> trace. This high-resistance artery: a sharp systolic peak, a brief reversal below the baseline, then rest. Its sound is the shift itself.', place: 'above' },
      ],
    },
    {
      title: 'Aliasing', dur: 17, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('black');
        const w = Math.min(160, px.W - 20), h = 74, x0 = 8, y0 = FACE + 2;
        const fixed = t > 10;
        const nyq = fixed ? lerp(70, 140, span(t, 10, 12)) : 70;     // cm/s, angle-corrected (the spectrum's scale)
        dopplerImage(t, x0, y0, w, h, { half: nyq * cosTo(ART), box: true });   // (the colour scale is along the beam)
        faceStrip(px, x0, x0 + w, FACE, { n: 12, glow: () => 0 });
        const sx = 8, sy = y0 + h + 8, sw = px.W - 16, sh = px.H - sy - 6;
        spectrum(t, sx, sy, sw, sh, { nyq });
        dopTone(t);
        // the PRF that sets this window: f_nyq = PRF / 2, at 3 MHz and the beam's angle
        const prf = Math.round(nyq * cosTo(ART) / 100 * 4 * 3e6 / 1540 / 100) * 100;
        px.text(prf + ' Hz', x0 + w + 8, y0 + 4, 'cyan');
        if (t < 10) api.mark([sx + sw * 0.45, sy, sw * 0.55, sh], 'orange', t);
        else api.mark([x0 + w + 4, y0, 50, 12], 'cyan', t);
        api.keepOut([sx, sy, sw, sh]);
      },
      caption: [
        { from: 0.6, to: 10, text: 'A pulsed system samples the shift once per pulse, so it can only measure up to half the pulse rate: the <b>Nyquist limit</b>, PRF ÷ 2. Faster flow <b>aliases</b>: its peaks wrap round to the far side of the trace, and in the colour box the brightest red jumps straight to blue.', place: 'right' },
        { from: 10, to: 17, text: 'The cure: raise the scale (the <b>PRF</b>, up to what the depth allows), move the baseline, or use a lower frequency.', place: 'right' },
      ],
    },
    {
      title: 'The whole picture', dur: 12, scale: '1 m', fadeOut: 1.2,
      enter() { S.roomReset(); R.fan.visible = true; R.setFan(S.seat.fr, S.seat.g); R.sheet.visible = true; },
      cam: [[0, [W.face[0] - 46, W.face[1] + 50, W.face[2] - 50], [W.face[0], W.face[1] - 6, W.face[2]], 34], [12, [-120, 140, -210], [30, 15, 20], 40]],
      cues: [[0.4, () => sfx.chime()]],
      frame(t) {
        R.sheet.material.opacity = 0.14;
        if (t > 1) api.mark(R.sheet, 'cyan', t);
      },
      caption: [{ from: 1, to: 12, text: 'Pulse, echo, time, brightness: thousands of times a second, a moving picture of the body’s inside, with no ionising radiation at all.' }],
    },
  ];
  void TIS; void poly;
  return { title: 'Motion: M-mode and Doppler', steps };
}
