/* THE CROSS-SECTION: an 8-bit inset of the tissue round a needle's tip, read from the model's own
   voxels (the tissue crops, images.js) in the plane of the needle, the needle drawn in and the
   tissue its tip is in named, one word or two. The skin is at the top: the panel's up runs back
   along the needle toward its hub (geom.js sectionAxes), so a needle always comes in from above. */
import { tissueAt, sectionAxes, v3 } from './geom.js';

// each tissue's colour on the 8-bit layer and its name at the tip (null: not named)
export const TISSUE = {
  air: ['ink', null], skin: ['peach', 'SKIN'], fat: ['fat', 'FAT'], muscle: ['muscle', 'MUSCLE'], soft: ['plum', 'SOFT TISSUE'],
  cortex: ['white', 'BONE'], marrow: ['bone', 'BONE'], disc: ['cyan', 'DISC'], flavum: ['orange', 'LIGAMENTUM FLAVUM'],
  epidural: ['gold', 'EPIDURAL SPACE'], dura: ['lav', 'DURA'], csf: ['blue', 'CSF'], nerve: ['yellow', 'NERVE'],
  capsule: ['grey', 'JOINT CAPSULE'], joint: ['teal', 'JOINT SPACE'], vessel: ['red', 'VESSEL'], lung: ['navy', 'LUNG'],
};

/* Draw the panel on api.px. SI: the loaded images (images.js); crop: its tissue crop's name.
     x, y, w, h   the panel (8-bit pixels; a frame round it, kept clear of captions)
     tip, dir     the needle's tip (the patient's frame) and the way it points (into the body)
     hub          where its shaft starts (default 10 cm back): the shaft is drawn from there
     cm           cm per 8-bit pixel (the crop's voxel)
     across       a direction the panel's right should lie toward (geom.js sectionAxes)
     centre       the panel's centre (default the tip)
     fills        [{ at, r, color, tissue?: [names], a? }]: an injectate spreading: the voxels
                  within r cm of `at` (only of those tissues, if given) drawn in color, dithered
     extras       [{ at, r, tissue }]: a structure the crop does not hold (a medial branch, a
                  root in its foramen) painted in as that tissue
     probe        { from, to, color }: a second line (an RF probe in the cannula, a stylet)
     glow         { at, r, color, k }: heat (or a pulse) round a point, 0..1
     label        name the tissue at the tip (true)
   Returns the name of the tissue at the tip (null in air). */
export function drawSection(api, SI, crop, { x, y, w = 64, h = 56, tip, dir, hub = null, cm = null, across = null, centre = null,
  fills = [], extras = [], probe = null, glow = null, label = true, needleColor = 'grey', a = 1 } = {}) {
  const px = api.px, C = SI.crops[crop];
  if (!C) return null;
  const s = cm || C.voxel, names = SI.tissue;
  const { A, B } = sectionAxes(dir, across);
  const c0 = centre || tip;
  px.rect(x - 1, y - 1, w + 2, h + 2, 'black', a);
  const at = (i, j) => v3.add(c0, v3.add(v3.mul(A, (i + 0.5 - w / 2) * s), v3.mul(B, (h / 2 - j - 0.5) * s)));
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const p = at(i, j);
    let code = tissueAt(C, p);
    for (const e of extras) if (v3.len(v3.sub(p, e.at)) <= e.r) code = names.indexOf(e.tissue);
    let col = code < 0 ? 'ink' : TISSUE[names[code]][0];
    for (const f of fills) {
      if (v3.len(v3.sub(p, f.at)) > f.r) continue;
      if (f.tissue && !f.tissue.includes(names[code])) continue;
      // dithered toward its edge
      const k = v3.len(v3.sub(p, f.at)) / f.r;
      if (((i * 7 + j * 13) & 7) / 8 < (1 - k * k) * 1.4 * (f.a ?? 1)) col = f.color;
    }
    px.px(x + i, y + j, col, a);
  }
  // the needle: from its hub (or the panel's edge) to the tip, two pixels' worth of steel
  const toPanel = (p) => {
    const q = v3.sub(p, c0);
    return [x + w / 2 + v3.dot(q, A) / s, y + h / 2 - v3.dot(q, B) / s];
  };
  const h0 = toPanel(hub || v3.sub(tip, v3.mul(v3.norm(dir), 12))), t0 = toPanel(tip);
  const clip = (p) => [Math.max(x, Math.min(x + w - 1, p[0])), Math.max(y, Math.min(y + h - 1, p[1]))];
  const line = (p, q, col) => {
    // clipped to the panel: stepped and drawn only inside
    const L = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]));
    for (let m = 0; m <= L; m++) {
      const u = p[0] + (q[0] - p[0]) * m / Math.max(1, L), v = p[1] + (q[1] - p[1]) * m / Math.max(1, L);
      if (u >= x && v >= y && u < x + w && v < y + h) px.px(u, v, col, a);
    }
  };
  if (glow && glow.k > 0.01) {
    const g = toPanel(glow.at);
    px.glow(g[0], g[1], Math.max(1, glow.r / s), glow.color || 'orange', glow.k * a, 3);
  }
  line(h0, t0, needleColor);
  // its edge, a pixel beside it, darker: a needle reads as a rod, not a scratch
  const n = [-(t0[1] - h0[1]), t0[0] - h0[0]], nl = Math.hypot(n[0], n[1]) || 1;
  line([h0[0] + n[0] / nl, h0[1] + n[1] / nl], [t0[0] + n[0] / nl, t0[1] + n[1] / nl], 'slate');
  if (probe) line(toPanel(probe.from), toPanel(probe.to), probe.color || 'white');
  const tp = clip(t0);
  px.px(tp[0], tp[1], 'white', a);
  px.frame(x - 1, y - 1, w + 2, h + 2, 'dkgrey', a);
  api.keepOut([x - 1, y - 1, w + 2, h + 2]);
  const code = tissueAt(C, tip);
  let name = code < 0 ? null : names[code];
  for (const e of extras) if (v3.len(v3.sub(tip, e.at)) <= e.r) name = e.tissue;
  const word = name ? TISSUE[name][1] : null;
  if (label && word) {
    const lw = word.length * 4 + 3;
    px.rect(x + (w - lw) / 2, y + h - 8, lw, 7, 'black', 0.75 * a);
    const c = TISSUE[name][0];
    px.text(word, x + w / 2, y + h - 7, ['ink', 'plum', 'navy', 'muscle', 'lav'].includes(c) ? 'white' : c, a, 1, 'center');
  }
  return name;
}
