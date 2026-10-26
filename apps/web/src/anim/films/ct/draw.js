/* CT FILM: drawing the computed images on the 8-bit layer: an HU image through a window, framed and
   kept out of the caption's way; a row of them side by side; a profile in a box. */
import { drawGrey, win } from './slice.js';

/* An HU image (w x h, row by row) through the window (L, W) at (x, y), s 8-bit pixels per image
   pixel; crop [c0, r0, cw, ch] in image pixels. Framed and kept out, with `below` rows under it
   for its numbers (under()). Returns its box. */
export function drawHU(api, hu, w, h, x, y, s, L, W, { crop = null, a = 1, frame = true, below = 20 } = {}) {
  const [c0, r0, cw, ch] = crop || [0, 0, w, h];
  x = Math.round(x); y = Math.round(y);
  drawGrey(api.px, cw, ch, x, y, s, (i) => win(hu[(r0 + Math.floor(i / cw)) * w + c0 + (i % cw)], L, W), { a });
  const b = [x, y, Math.round(cw * s), Math.round(ch * s)];
  if (frame) api.px.frame(b[0] - 1, b[1] - 1, b[2] + 2, b[3] + 2, 'dkgrey', a);
  api.keepOut([b[0] - 1, b[1] - 1, b[2] + 2, b[3] + 2 + below]);
  return b;
}
// an image's box with the numbers under it: what a mark on the image brackets
export const lab = (b, below = 20) => [b[0] - 1, b[1] - 1, b[2] + 2, b[3] + 2 + below];
/* n panels of pw x ph (8-bit pixels) side by side, centred, gap apart, their tops at y. */
export function row(px, n, pw, gap = 8) {
  const total = n * pw + (n - 1) * gap, x0 = Math.round((px.W - total) / 2);
  return Array.from({ length: n }, (_, i) => x0 + i * (pw + gap));
}
/* The largest scale that fits n images of w x h image pixels side by side within the frame,
   leaving `below` rows under them (for the caption) and `top` above. */
export function fit(px, n, w, h, { gap = 8, top = 22, below = 66, max = 1.2, side = 12 } = {}) {
  return Math.min(max, (px.W - 2 * side - (n - 1) * gap) / (n * w), (px.H - top - below) / h);
}
// numbers centred under a box
export function under(px, b, str, c = 'yellow', dy = 4) { px.text(str, b[0] + b[2] / 2, b[1] + b[3] + dy, c, 1, 1, 'center'); }
// a curve of values in a box: lo..hi up the box
export function plot(px, vals, x, y, w, h, { c = 'yellow', lo, hi, a = 1 } = {}) {
  let lx = null, ly = null;
  for (let i = 0; i < vals.length; i++) {
    const X = x + (i / (vals.length - 1)) * (w - 1), Y = y + h - 1 - Math.max(0, Math.min(1, (vals[i] - lo) / (hi - lo))) * (h - 1);
    if (lx != null) px.line(lx, ly, X, Y, c, a);
    lx = X; ly = Y;
  }
}
// a box of an image's grid point (c, r of an n-wide grid drawn at box b): its 8-bit position
export const at = (b, n, c, r) => [b[0] + (c / n) * b[2], b[1] + (r / n) * b[3]];
