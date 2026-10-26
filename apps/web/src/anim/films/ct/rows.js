/* CT FILM: the detector along the patient (8-bit), for the scanner chapter and the cone-beam
   artefact. The gantry seen from the side, the patient's long axis (z) across the screen: the
   focal spot at the top, the isocentre 57 cm below it, the detector 1 m below it. z is drawn
   stretched (the beam is only 4 cm wide at the isocentre, 7 cm at the detector: its true shape
   would be a sliver), the same stretch at every depth, so the rays stay straight. The app's own
   detector: 64 rows of 0.625 mm at the isocentre (1.1 mm on the detector itself). */
import { F, SID } from './rig.js';
import { hud } from './kit.js';

export const ROWS = 64, ROW = 0.625;                    // rows; mm at the isocentre
const MAG = SID / F;                                    // isocentre -> detector

/* The side view's geometry for this frame: focal spot (cx, fy), isocentre depth iy, detector
   depth dy, kz 8-bit pixels per mm of z at the isocentre. A z (mm at the isocentre) at depth y
   lies on the ray from the focal spot: x = cx + z kz (y - fy) / (iy - fy). */
export function sideGeo(px, { top = 16, bottom = 24 } = {}) {
  // on the left two thirds of the frame: the right third is the captions'
  const fy = top, dy = px.H - bottom, iy = fy + (dy - fy) / MAG;
  const kz = Math.min(3.4, (px.W * 0.64 - 24) / (ROWS * ROW * MAG)), cx = Math.round(14 + ROWS * ROW * MAG * kz / 2);
  const X = (z, y) => cx + z * kz * (y - fy) / (iy - fy);
  return { fy, dy, iy, cx, kz, X };
}
/* Draw it: the detector's rows (lit: [from, to) of 0..63, the others dark), the beam to them (its
   width at the isocentre, mm, and a little over, `over` mm), the isocentre line, the jaws. */
export function sideView(api, g, { lit = [0, ROWS], beam = 40, over = 0, jaws = true, hi = -1, a = 1 } = {}) {
  const { px } = api, { fy, dy, iy, cx, X } = g;
  const half = beam / 2 + over;
  // the beam: rows of violet, wider with depth
  for (let y = fy + 1; y < dy; y++) {
    const x0 = X(-half, y), x1 = X(half, y);
    px.rect(x0, y, x1 - x0 + 1, 1, 'violet', 0.13 * a);
  }
  px.line(cx, fy, X(-half, dy), dy, 'violet', 0.5 * a); px.line(cx, fy, X(half, dy), dy, 'violet', 0.5 * a);
  if (over > 0) for (const s of [-1, 1]) {
    // the overbeam: beam that reaches no lit row
    for (let y = fy + 1; y < dy; y++) { const xa = X(s * beam / 2, y), xb = X(s * half, y); px.rect(Math.min(xa, xb), y, Math.abs(xb - xa) + 1, 1, 'red', 0.25 * a); }
  }
  // the focal spot and the jaws just under it (they set the beam's width)
  px.glow(cx, fy, 3, 'yellow', a, 1); px.rect(cx - 1, fy - 1, 3, 3, 'white', a);
  if (jaws) {
    const jy = fy + 9, e = half * g.kz * (jy - fy) / (iy - fy);
    px.rect(cx - e - 26, jy, 26, 4, 'lead', a); px.rect(cx + e, jy, 26, 4, 'lead', a);
  }
  // the isocentre's line (dashed) across
  px.line(X(-36, iy) - 10, iy, X(36, iy) + 10, iy, 'mid', 0.6 * a, 2);
  // the rows: cells on the detector, each 0.625 mm at the isocentre
  const cell = (k) => [X((k - ROWS / 2) * ROW, dy), X((k - ROWS / 2 + 1) * ROW, dy)];
  for (let k = 0; k < ROWS; k++) {
    const [x0, x1] = cell(k), on = k >= lit[0] && k < lit[1];
    px.rect(x0, dy, Math.max(1, x1 - x0 - 1), 7, k === hi ? 'yellow' : on ? 'teal' : 'dkgrey', a);
  }
  px.rect(X(-ROWS / 2 * ROW, dy) - 1, dy + 7, X(ROWS / 2 * ROW, dy) - X(-ROWS / 2 * ROW, dy) + 2, 2, 'slate', a);
  return { cell };
}

/* Keep the caption off the detector's strip and the focal spot and jaws (the beam between them
   it may cross); returns the strip's box. */
export function guard(api, g) {
  const x0 = g.X(-ROWS / 2 * ROW, g.dy) - 3, x1 = g.X(ROWS / 2 * ROW, g.dy) + 3;
  const strip = [x0, g.dy - 3, x1 - x0, 14];
  api.keepOut(strip); api.keepOut([g.cx - 46, g.fy - 5, 92, 20]);
  return strip;
}

export function rowSteps(api, S) {
  const { px, span, lerp, sfx } = api;
  const steps = [];
  steps.push({
    title: 'Rows along the patient', dur: 13, view: 'pixel', fadeIn: 0.3, scale: '10 cm',
    cues: [[6, () => sfx.blip(880)]],
    frame(t) {
      px.fillAll('ink');
      const g = sideGeo(px);
      // the rows light up one by one from the edge, then all
      const n = Math.floor(ROWS * span(t, 0.6, 4, api.ease.linear));
      const hi = t > 6 ? 23 : -1;
      const { cell } = sideView(api, g, { lit: [0, n], hi });
      const D = guard(api, g);
      hud(api, [['', Math.max(n, 1) + 'x0.625', 'teal'], ['mm', String(Math.round(n * ROW)), 'cyan']], { w: 56 });
      if (t > 6) {
        // one row: its edges back to the focal spot; its width at the isocentre and on the detector
        const [x0, x1] = cell(hi), z0 = (hi - ROWS / 2) * ROW, z1 = z0 + ROW;
        px.line(g.cx, g.fy, x0, g.dy, 'yellow', 0.8); px.line(g.cx, g.fy, x1, g.dy, 'yellow', 0.8);
        const i0 = g.X(z0, g.iy), i1 = g.X(z1, g.iy);
        px.rect(i0, g.iy - 1, Math.max(1, i1 - i0), 3, 'yellow');
        px.text('0.625', i0 - 4, g.iy - 8, 'yellow', 1, 1, 'right');
        px.text('1.1', x0 - 3, g.dy - 8, 'white', 1, 1, 'right');
        // the ray's band below the isocentre (the caption stays off it)
        api.keepOut([x0 - 2, g.iy + 5, i1 - x0 + 4, g.dy - g.iy - 5]);
        api.mark([i0 - 3, g.iy - 4, i1 - i0 + 6, 9], 'yellow', t);
      } else if (t > 0.8) api.mark(D, 'teal', t);
      // the isocentre's 40 mm, once all are lit
      if (t > 4) { const a0 = g.X(-20, g.iy), a1 = g.X(20, g.iy); px.rect(a0, g.iy + 4, 1, 4, 'cyan'); px.rect(a1, g.iy + 4, 1, 4, 'cyan'); px.text(String(Math.round(n * ROW)), a0 - 3, g.iy + 5, 'cyan', 1, 1, 'right'); }
    },
    caption: [
      { from: 0.8, to: 6, text: 'Along the patient the detector is divided into <b>rows</b>: here 64, side by side under the fan.', place: 'right' },
      { from: 6, to: 13, text: 'Each row is 0.625 mm wide measured at the <b>isocentre</b> (1.1 mm on the detector, magnified). 64 × 0.625 mm: 40 mm of patient in one rotation.', place: 'right' },
    ],
  });
  steps.push({
    title: 'Collimation picks the rows', dur: 14, view: 'pixel', scale: '10 cm',
    cues: [[3.5, () => sfx.click()], [6.5, () => sfx.click()]],
    frame(t) {
      px.fillAll('ink');
      const g = sideGeo(px);
      const n = t < 3.5 ? 64 : t < 6.5 ? 32 : 16, nPrev = t < 3.5 ? 64 : t < 6.5 ? 64 : 32;
      const k = t < 3.5 ? 1 : span(t - (t < 6.5 ? 3.5 : 6.5), 0, 1);
      const rows = lerp(nPrev, n, k), over = t > 9 ? 1 : 0;
      const beam = rows * ROW;
      sideView(api, g, { lit: [ROWS / 2 - Math.round(rows / 2), ROWS / 2 + Math.round(rows / 2)], beam, over });
      guard(api, g);
      hud(api, [['', Math.round(rows) + 'x0.625', 'teal'], ['mm', String(Math.round(beam)), 'cyan']], { w: 56 });
      if (t > 0.8 && t < 9) api.mark([g.cx - 46, g.fy - 5, 92, 20], 'yellow', t);
      if (t > 9) { const x0 = g.X(beam / 2, g.dy), x1 = g.X(beam / 2 + over, g.dy); api.mark([Math.min(x0, x1) - 2, g.dy - 10, Math.abs(x1 - x0) + 6, 18], 'red', t); }
    },
    caption: [
      { from: 0.8, to: 9, text: 'The <b>collimator</b> jaws set how many rows the beam lights: 64, 32 or 16 × 0.625 mm, a beam 40, 20 or 10 mm wide at the isocentre.', place: 'right' },
      { from: 9, to: 14, text: 'The beam is opened a little wider than the rows it lights, so all of them get its full strength: that edge (<b>overbeaming</b>) is dose that makes no image.', place: 'right' },
    ],
  });
  steps.push({
    title: 'Rows into slices', dur: 15, view: 'pixel', scale: '1 mm',
    cues: [[4.5, () => sfx.blip(660)], [6.2, () => sfx.blip(740)], [7.9, () => sfx.blip(880)], [10.5, () => sfx.thud()]],
    frame(t) {
      px.fillAll('ink');
      // the middle 16 rows, large: each a cell; groups of 1, 2, 4, 8 rows added into one slice
      const n = 16, cw = Math.min(18, Math.floor((px.W - 40) / n)), x0 = Math.round((px.W - n * cw) / 2), y0 = 54, ch = 22;
      const grp = t < 4.5 ? 1 : t < 6.2 ? 2 : t < 7.9 ? 4 : t < 10.5 ? 8 : 1;
      const cols = ['teal', 'blue'];
      for (let k = 0; k < n; k++) {
        const gi = Math.floor(k / grp);
        px.rect(x0 + k * cw, y0, cw - 1, ch, cols[gi % 2], 0.85);
        px.rect(x0 + k * cw + 2, y0 + 3, cw - 5, ch - 6, 'navy', 0.35);
      }
      px.rect(x0 - 1, y0 + ch, n * cw + 1, 3, 'slate');
      api.keepOut([x0 - 4, y0 - 4, n * cw + 8, ch + 10]);
      // the slices under them: one bar per group, its thickness in mm
      const sy = y0 + ch + 18;
      if (t < 10.5) {
        for (let gi = 0; gi < n / grp; gi++) {
          const bx = x0 + gi * grp * cw;
          px.rect(bx + 1, sy, grp * cw - 3, 8, 'yellow', 0.85);
          px.line(bx + grp * cw / 2, y0 + ch + 3, bx + grp * cw / 2, sy - 1, 'yellow', 0.5, 1);
        }
        const T = grp * ROW;
        px.text(T.toFixed(T < 1 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '') + ' mm', px.W / 2, sy + 14, 'yellow', 1, 1, 'center');
        api.keepOut([x0 - 4, sy - 2, n * cw + 8, 24]);
        if (t > 0.8) api.mark([x0 - 4, sy - 2, n * cw + 8, 24], 'yellow', t);
      } else {
        // half a row: no such slice
        const bx = x0 + 7 * cw, k = span(t, 10.5, 11.2);
        px.rect(bx + 1, sy, Math.round(cw / 2) - 1, 8, 'red', 0.9 * k);
        px.line(bx - 3, sy - 3, bx + cw / 2 + 3, sy + 11, 'red', k); px.line(bx + cw / 2 + 3, sy - 3, bx - 3, sy + 11, 'red', k);
        px.text('0.31 mm', bx + cw / 4, sy + 14, 'red', k, 1, 'center');
        api.mark([bx - 30, sy - 4, cw + 60, 26], 'red', t);
      }
    },
    caption: [
      { from: 0.8, to: 4.5, text: 'Each row can make its own slice: the thinnest, <b>0.625 mm</b>.' },
      { from: 4.5, to: 10.5, text: 'Or the signals of neighbouring rows are added, in the electronics or in the reconstruction, into thicker slices: 2, 4 or 8 rows make 1.25, 2.5 or 5 mm.' },
      { from: 10.5, to: 15, text: 'But never a slice <b>thinner than one row</b>: the row is the smallest part of the patient the detector tells apart along z.' },
    ],
  });
  return steps;
}
