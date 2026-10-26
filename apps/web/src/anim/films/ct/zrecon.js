/* CT FILM, reconstruction along z (8-bit): slices from a helix (the rows' paths along the patient
   against the view angle, a slice's value interpolated between the rows either side of it in
   each view, the z-filter's width setting its thickness), and slice thickness against
   reconstruction interval (contiguous, overlapping, gapped) on the model's own coronal. */
import { hud, box } from './kit.js';
import { huOfIds } from './simct.js';
import { drawHU } from './draw.js';

// the helical acquisition drawn: 16 rows of 0.625 mm at pitch 1, 10 mm a turn
export const HEL = { rows: 16, w: 0.625, pitch: 1 };
const FEED = HEL.pitch * HEL.rows * HEL.w;

/* The z against view-angle diagram in a box: x the view angle 0..720 degrees, y the z of each row
   (mm, up the box) in the patient's frame. upTo: the angle the rows are drawn to. Returns its
   mappings. */
export function helixPlot(api, b, { upTo = 720, zLo = 0, zHi = 12, a = 1, rows = HEL.rows, w = HEL.w, feed = FEED } = {}) {
  const { px } = api, [x, y, W, H] = b;
  const X = (th) => x + (th / 720) * W, Y = (z) => y + H - ((z - zLo) / (zHi - zLo)) * H;
  box(api, x - 3, y - 3, W + 6, H + 6, 0.92);
  const zc = (th) => 6 + feed * (th - 360) / 360;
  const zr = (k, th) => zc(th) + (k - (rows - 1) / 2) * w;
  for (let k = 0; k < rows; k++) {
    let lx = null, ly = null;
    for (let th = 0; th <= upTo; th += 4) {
      const z = zr(k, th), X1 = X(th), Y1 = Y(z);
      const inside = z >= zLo && z <= zHi;
      if (lx != null && inside) px.line(lx, ly, X1, Y1, 'violet', 0.75 * a);
      lx = inside ? X1 : null; ly = Y1;
    }
  }
  // the axes' numbers
  for (const th of [0, 360, 720]) px.text(String(th), X(th), y + H + 5, 'mid', a, 1, 'center');
  for (const z of [zLo, (zLo + zHi) / 2, zHi]) px.text(String(z), x - 5, Y(z) - 2, 'mid', a, 1, 'right');
  px.text('mm', x - 5, y - 9, 'mid', a, 1, 'right');
  return { X, Y, zr, zc, rows, w };
}
// the two rows either side of z0 at angle th: [k, z below, z above]
export function straddle(P, th, z0) {
  for (let k = 0; k < P.rows - 1; k++) { const a = P.zr(k, th), b = P.zr(k + 1, th); if (a <= z0 && z0 < b) return [k, a, b]; }
  return null;
}

export function zReconSteps(api, S) {
  const { px, span, sfx } = api;
  const steps = [];
  steps.push({
    title: 'Slices from a helix', dur: 17, view: 'pixel', scale: '1 mm',
    cues: [[4.5, () => sfx.blip(700)], [10, () => sfx.click()], [12, () => sfx.click()], [14, () => sfx.click()]],
    frame(t) {
      px.fillAll('ink');
      const b = [34, 16, px.W - 112, px.H - 72];
      const upTo = 720 * span(t, 0.6, 4.2, api.ease.linear);
      const P = helixPlot(api, b, { upTo });
      const z0 = 6;
      const T = t < 10 ? 0 : t < 12 ? 0.625 : t < 14 ? 2.5 : 5;
      if (t > 4.5) {
        // the slice's z and, view by view, the rows either side of it and the value between
        px.line(b[0], P.Y(z0), b[0] + b[2], P.Y(z0), 'yellow', 0.9);
        if (T > 0) {
          const y0 = P.Y(z0 + T / 2), y1 = P.Y(z0 - T / 2);
          px.rect(b[0], y0, b[2], Math.max(1, y1 - y0), 'yellow', 0.18);
          for (let th = 0; th <= 720; th += 8) for (let k = 0; k < P.rows; k++) {
            const z = P.zr(k, th);
            if (Math.abs(z - z0) <= T / 2) px.rect(P.X(th) - 1, P.Y(z) - 1, 2, 2, 'cyan', 0.9);
          }
        } else {
          const upTh = 720 * span(t, 4.5, 9, api.ease.linear);
          for (let th = 12; th <= upTh; th += 24) {
            const s = straddle(P, th, z0);
            if (!s) continue;
            const X = P.X(th);
            px.rect(X - 1, P.Y(s[1]) - 1, 3, 3, 'cyan'); px.rect(X - 1, P.Y(s[2]) - 1, 3, 3, 'cyan');
            px.line(X, P.Y(s[1]), X, P.Y(s[2]), 'cyan', 0.5);
            px.rect(X - 1, P.Y(z0) - 1, 3, 3, 'yellow');
          }
        }
      }
      api.keepOut([b[0] - 40, b[1] - 12, b[2] + 44, b[3] + 24]);
      hud(api, [['', HEL.rows + 'x0.625', 'teal'], ['mm', T ? String(T) : '-', 'yellow']], { w: 58 });
      if (t > 0.8 && t < 4.5) api.mark([b[0], b[1], b[2], b[3]], 'violet', t);
      if (t > 4.5 && t < 10) { const X = P.X(Math.min(708, 720 * span(t, 4.5, 9, api.ease.linear))); api.mark([X - 6, P.Y(z0) - 10, 12, 20], 'yellow', t, { live: true }); }
      if (t > 10) { const y0 = P.Y(z0 + T / 2), y1 = P.Y(z0 - T / 2); api.mark([b[0], y0 - 2, b[2], y1 - y0 + 4], 'yellow', t); }
    },
    caption: [
      { from: 0.8, to: 4.5, text: 'In a helical scan no turn stays at one z: each row sweeps along the patient as the couch moves (16 rows of 0.625 mm, pitch 1).', place: 'below' },
      { from: 4.5, to: 10, text: 'For a slice at any z, each view’s reading there is <b>interpolated</b> between the two rows either side of it.', place: 'below' },
      { from: 10, to: 17, text: 'Widen the band of rows averaged (the <b>z-filter</b>) and the slice is thicker: 0.625, 2.5, 5 mm. Never thinner than a row; placed anywhere along the scan.', place: 'below' },
    ],
  });

  // ---- thickness and interval on the coronal
  const cor = S.img.cor, corHU = huOfIds(cor);
  const CASES = [[5, 5, 0], [5, 2.5, 5], [5, 10, 10]];
  steps.push({
    title: 'Thickness and interval', dur: 15, view: 'pixel', fadeOut: 0.5, scale: '10 cm',
    cues: [[5, () => sfx.click()], [10, () => sfx.click()]],
    frame(t) {
      px.fillAll('ink');
      const c = CASES[t < 5 ? 0 : t < 10 ? 1 : 2], [T, I] = c;
      // the coronal, and on it the slices' centres through a 6 cm window (rows 2 mm)
      const s = (px.H - 76) / cor.h, cb = drawHU(api, corHU, cor.w, cor.h, 14, 10, s, 40, 400);
      const zA = 400, zB = 460;                                   // mm from the top
      const wy0 = cb[1] + (zA / 2) * s, wy1 = cb[1] + (zB / 2) * s;
      px.frame(cb[0] - 2, wy0, cb[2] + 4, wy1 - wy0, 'yellow', 0.8);
      // the zoom: each image a bar [z - T/2, z + T/2], in four staggered columns, its centre a tick
      const gx = cb[0] + cb[2] + 26, gw = Math.min(150, px.W - gx - 70), gy = 14, gh = px.H - 84, k = gh / (zB - zA);
      box(api, gx - 4, gy - 4, gw + 8, gh + 8);
      px.line(cb[0] + cb[2] + 2, wy0, gx - 4, gy - 4, 'yellow', 0.4); px.line(cb[0] + cb[2] + 2, wy1, gx - 4, gy + gh + 4, 'yellow', 0.4);
      const z0 = zA - 20;
      let col = 0;
      for (let z = z0; z < zB + 20; z += I, col++) {
        const ya = gy + (z - T / 2 - zA) * k, yb = gy + (z + T / 2 - zA) * k;
        if (yb < gy || ya > gy + gh) continue;
        const cx = gx + 6 + (col % 4) * (gw - 12) / 4;
        const Y0 = Math.max(gy, ya), Y1 = Math.min(gy + gh, yb);
        px.rect(cx, Y0, (gw - 12) / 4 - 4, Y1 - Y0, 'teal', 0.75);
        const yc = gy + (z - zA) * k;
        if (yc > gy && yc < gy + gh) { px.rect(gx, yc, gw, 1, 'yellow', 0.5); px.rect(cx, yc, (gw - 12) / 4 - 4, 1, 'yellow'); }
      }
      hud(api, [['mm', String(T), 'teal'], ['mm', String(I), 'yellow'], ['', String(Math.round(640 / I)), 'white']], { w: 50 });
      if (t > 0.8) api.mark([gx - 4, gy - 4, gw + 8, gh + 8], t < 5 ? 'teal' : 'yellow', t);
    },
    caption: [
      { from: 0.8, to: 5, text: '<b>Slice thickness</b> (bars): how much of the patient along z each image averages. <b>Interval</b> (lines): how far apart the images are. Here both 5 mm: <b>contiguous</b>.' },
      { from: 5, to: 10, text: 'Interval less than thickness: <b>overlapping</b> images, twice as many, from the same data at no extra dose.' },
      { from: 10, to: 15, text: 'Interval more than thickness: <b>gaps</b>. Parts of the patient fall in no image.' },
    ],
  });
  return steps;
}
