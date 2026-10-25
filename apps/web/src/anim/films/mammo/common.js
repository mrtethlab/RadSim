/* Small things every chapter of the mammography film uses. Every one is a function of the step's
   time, and stays right however long a step is held past its end (the player holds a step until
   the viewer moves on): streams loop, event fields iterate only their recent events. */
import { drawParticles } from '../../kit/flux.js';

// a small panel of readouts top right: [label, value, color]
export function hud(api, rows, { w = 50, x = null, y = 4 } = {}) {
  const px = api.px, h = 4 + rows.length * 9;
  x = x ?? px.W - w - 4;
  px.rect(x, y, w, h, 'ink', 0.85); px.frame(x, y, w, h, 'dkgrey');
  api.keepOut([x, y, w, h]);
  rows.forEach(([lab, val, c], i) => {
    px.text(lab, x + 3, y + 3 + i * 9, 'mid');
    px.text(val, x + w - 3, y + 3 + i * 9, c || 'yellow', 1, 1, 'right');
  });
  return [x, y, w, h];
}

/* A particle stream (kit/flux) made endless: the list's births span [0, P); drawn at t mod P, and
   again a period later for those born near the end of a cycle still in flight across the seam. */
export function loopParticles(api, list, t, P, style, opts = {}) {
  const tt = ((t % P) + P) % P;
  drawParticles(api, list, tt, style, opts);
  drawParticles(api, list, tt + P, style, opts);
}

/* The time of the highlighted event in a field: first at t0, then every P seconds, so a held step
   keeps showing it. Returns the birth time of the latest one (or t0 before it). */
export const cycleAt = (t, t0, P) => (t < t0 ? t0 : t0 + P * Math.floor((t - t0) / P));

/* The indices of a field's events born in the last `win` seconds (N the latest), and the
   highlighted one fi too, however long ago it was born (it plays slowed, so it outlives the rest). */
export function recentIdx(N, rate, win, fi = -1) {
  const a = Math.max(0, N - Math.ceil(win * rate)), out = [];
  if (fi >= 0 && fi < a && fi <= N) out.push(fi);
  for (let i = a; i <= N; i++) out.push(i);
  return out;
}

// a grey from 0..1
export const grey = (v) => { const g = Math.round(Math.max(0, Math.min(1, v)) * 255); return `rgb(${g},${g},${g})`; };

/* Draw an image (w, h, a: 0..1) into the 8-bit layer, cell pixels per image pixel, through a
   grey-mapping function; flip mirrors it left-right. Only whole screen pixels are filled, so
   fractional cells leave no seams. */
export function drawImg(px, img, x, y, cell, map = (v) => v, { flip = false, a = 1, clip = null } = {}) {
  const g = px.g;
  g.globalAlpha = a * px.alpha;
  for (let r = 0; r < img.h; r++) {
    const y0 = Math.floor(y + r * cell), y1 = Math.floor(y + (r + 1) * cell);
    if (y1 <= y0 || y1 < 0 || y0 > px.H) continue;
    for (let c = 0; c < img.w; c++) {
      const x0 = Math.floor(x + c * cell), x1 = Math.floor(x + (c + 1) * cell);
      if (x1 <= x0 || x1 < 0 || x0 > px.W) continue;
      if (clip && (x0 < clip[0] || x1 > clip[0] + clip[2] || y0 < clip[1] || y1 > clip[1] + clip[3])) continue;
      const v = map(img.a[r * img.w + (flip ? img.w - 1 - c : c)]);
      const q = Math.round(Math.max(0, Math.min(1, v)) * 255);
      g.fillStyle = `rgb(${q},${q},${q})`;
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
  g.globalAlpha = 1;
}
/* An image resampled down to a box (area-averaged), once: for drawing a 470-wide mammogram into a
   130-pixel slot without aliasing. */
export function shrink(img, w, h) {
  const out = new Float32Array(w * h), n = new Float32Array(w * h);
  for (let r = 0; r < img.h; r++) for (let c = 0; c < img.w; c++) {
    const k = Math.min(h - 1, Math.floor(r * h / img.h)) * w + Math.min(w - 1, Math.floor(c * w / img.w));
    out[k] += img.a[r * img.w + c]; n[k]++;
  }
  for (let k = 0; k < out.length; k++) out[k] /= n[k] || 1;
  return { w, h, a: out };
}
