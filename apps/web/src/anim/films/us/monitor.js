/* The scanner's monitor as the films' screen for real images: paint a frame's greys onto it (only
   when what is shown changes), and find where on the 8-bit layer a part of the image appears (for
   the brackets and the caption's keep-outs). The fan is drawn 320 x 320 at (100, 10) of the
   monitor's 520 x 340 canvas, as room.js paintScreen lays it out. */
import { fanSprite } from './bmode.js';

export function makeMonitor(S) {
  const R = S.room, sprites = new Map();
  let key = '';
  const spriteOf = (fr) => {
    let s = sprites.get(fr);
    if (!s) { s = fanSprite(fr, 320, 320); sprites.set(fr, s); }
    return s;
  };
  return {
    reset() { key = ''; },
    // the screen is the picture: the caption keeps off it
    keep(api) { api.keepOut(R.screenBox(100, 10, 320, 320)); },
    sprite: spriteOf,
    // paint greys g of frame fr (with extra(ctx) drawn on top), unless k is what is already there
    paint(fr, g, k, extra = null, opts = {}) {
      if (k === key) return;
      key = k;
      R.paintScreen(spriteOf(fr).paint(g, opts), { freq: fr.o.freq, depth: fr.o.depth, extra });
    },
    // the monitor canvas's point for line l at depth d (cm) of frame fr
    at(fr, l, d) { const p = spriteOf(fr).at(l, d); return [100 + p[0], 10 + p[1]]; },
    // the 8-bit box round lines l0..l1, depths d0..d1 of frame fr
    box(fr, l0, l1, d0, d1) {
      const pts = [];
      for (const l of [l0, (l0 + l1) / 2, l1]) for (const d of [d0, d1]) pts.push(this.at(fr, l, d));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const x0 = Math.min(...xs), y0 = Math.min(...ys);
      return R.screenBox(x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0);
    },
  };
}
