/* THE IV FILM'S 8-BIT THINGS: blood cells, a vein's wall and valves, the tissue round it, a needle
   with its bevel and lumen, the catheter on it, skin bacteria. All drawn on the PixelLayer in its
   pixels, as functions of the time given (looping where they stream, so a held step never runs
   dry).

   Directions are the 3D shots' own: in every longitudinal section the vein runs left to right
   TOWARD THE HEART, the skin is at the top, the needle comes in from the left (the hand's side). */
import { sprite, rng } from '../../pixel.js';

// ---------------------------------------------------------------- sprites (about 1 µm a pixel)
export const SPR = {
  rbc: sprite([
    '..rrr..',
    '.rRRRr.',
    'rRRpRRr',
    'rRpppRr',
    'rRRpRRr',
    '.rRRRr.',
    '..rrr..'], { r: 'dkred', R: 'red', p: 'pink' }),
  rbcEdge: sprite([
    '.rrrrr.',
    'rRR.RRr',
    '.rrrrr.'], { r: 'dkred', R: 'red' }),
  rbcArt: sprite([
    '..rrr..',
    '.rRRRr.',
    'rRRpRRr',
    'rRpppRr',
    'rRRpRRr',
    '.rRRRr.',
    '..rrr..'], { r: 'red', R: 'pink', p: 'peach' }),
  wbc: sprite([
    '...lllll...',
    '..lLLLLLl..',
    '.lLLppLLLl.',
    'lLLpppLLLLl',
    'lLLLppLppLl',
    'lLLLLLpppLl',
    'lLLpLLLppLl',
    '.lLppLLLLl.',
    '..lLppLLl..',
    '...lllll...'], { l: 'lav', L: 'white', p: 'plum' }),
  plt: sprite(['.pp', 'ppp', 'pp.'], { p: 'peach' }),
  coccus: sprite(['.vv.', 'vVVv', 'vVVv', '.vv.'], { v: 'plum', V: 'violet' }),
  rod: sprite(['.gggg.', 'gGGGGg', '.gggg.'], { g: 'green', G: 'lime' }),
  deadC: sprite(['.s.s', 's..s', '.s..', 's.s.'], { s: 'slate' }),
  smc: sprite(['..mmmmmm..', 'mmMMMnMMmm', '..mmmmmm..'], { m: 'plum', M: 'pink', n: 'dkred' }),
};

// ---------------------------------------------------------------- a section, mm to pixels
/* A longitudinal (or any) section drawn at k pixels a mm: u mm across (toward the heart to the
   right), z mm down (0 the skin's surface). */
export class Section {
  constructor(px, { x0 = 0, y0 = 0, w = px.W, h = px.H, k = 8, u0 = -6, z0 = -4 } = {}) {
    Object.assign(this, { px, x0, y0, w, h, k, u0, z0 });
  }
  X(u) { return this.x0 + (u - this.u0) * this.k; }
  Y(z) { return this.y0 + (z - this.z0) * this.k; }
  U(x) { return this.u0 + (x - this.x0) / this.k; }
  Z(y) { return this.z0 + (y - this.y0) / this.k; }
  get u1() { return this.U(this.x0 + this.w); }
  get z1() { return this.Z(this.y0 + this.h); }
  /* The tissue: air, epidermis, dermis, subcutaneous fat (its lobules), muscle. bulge(u) mm
     lifts the skin (swelling); fatBottom the fat's depth. */
  tissue(t, { fatBottom = 14, bulge = null, dim = 1, dermis = 1.2 } = {}) {
    const px = this.px;
    px.rect(this.x0, this.y0, this.w, this.h, 'ink');
    const yMus = this.Y(fatBottom);
    for (let x = this.x0; x < this.x0 + this.w; x++) {
      const u = this.U(x), lift = bulge ? bulge(u) : 0;
      const ys = this.Y(-lift), yd = this.Y(0.12 - lift), yf = this.Y(dermis - lift * 0.6);
      px.rect(x, ys, 1, Math.max(1, yd - ys), 'peach', dim);
      px.rect(x, yd, 1, yf - yd, 'pink', 0.42 * dim);
      px.rect(x, yf, 1, yMus - yf, 'fat', 0.3 * dim);
      px.rect(x, yMus, 1, this.y0 + this.h - yMus, 'muscle', 0.42 * dim);
    }
    // the fat's lobules (fat cells packed in septa), the muscle's fibres: fixed, tissue not flow
    const r = rng(41), n = Math.round((this.u1 - this.u0) * (fatBottom - 1.4) / 7);
    for (let i = 0; i < n; i++) {
      const u = this.u0 + r() * (this.u1 - this.u0), z = 1.6 + r() * (fatBottom - 2);
      const rr = (0.5 + r() * 0.5) * Math.min(this.k, 9);
      // (a lobule's septum: an arc, not a ring)
      const a0 = r() * 6.3;
      for (let q = 0; q < rr * 3; q++) { const a = a0 + q / rr; px.px(this.X(u) + Math.cos(a) * rr, this.Y(z) + Math.sin(a) * rr, 'gold', 0.13 * dim); }
    }
    for (let y = yMus + 3; y < this.y0 + this.h; y += 4) px.line(this.x0, y, this.x0 + this.w, y + 1, 'dkred', 0.35 * dim);
  }
  /* A vessel along u at centre depth cz: lumen half-height b, radius r (half-width; only b is
     seen in a long section), wall thickness w. tent(u) mm pushes the top wall down. Blood
     streams at v mm/s (0 still), arterial or venous. */
  vessel(t, { cz, b, w = 0.4, tent = null, v = 6, blood = 'venous', u0 = this.u0, u1 = this.u1, wallA = 1, seed = 3, cells = 1,
    valves = [], valveOpen = 1, contrast = null, lumenCol = null } = {}) {
    const px = this.px, k = this.k;
    const xa = Math.max(this.x0, Math.floor(this.X(u0))), xb = Math.min(this.x0 + this.w, Math.ceil(this.X(u1)));
    const top = (u) => cz - b - (tent ? -tent(u) : 0);
    const art = blood === 'arterial';
    for (let x = xa; x < xb; x++) {
      const u = this.U(x);
      let bulge = 0;
      for (const vu of valves) bulge = Math.max(bulge, 0.45 * b * Math.exp(-(((u - vu - b * 0.55) / (b * 0.55)) ** 2)));
      const lt = top(u) - bulge, lb = cz + b + bulge;
      const y0 = this.Y(lt - w), y1 = this.Y(lt), y2 = this.Y(lb), y3 = this.Y(lb + w);
      // the wall: adventitia outside, media, intima on the lumen
      const wl = (ya, yb, flip) => {
        const hgt = yb - ya, n = Math.max(1, Math.round(hgt));
        for (let j = 0; j < n; j++) {
          const f = (j + 0.5) / n, ff = flip ? 1 - f : f;
          px.rect(x, ya + j, 1, 1, ff < 0.4 ? 'brown' : ff < 0.85 ? (art ? 'pink' : 'plum') : 'peach', wallA);
        }
      };
      wl(y0, y1, false); wl(y2, y3, true);
      px.rect(x, y1, 1, y2 - y1, lumenCol || (art ? 'red' : 'dkred'), lumenCol ? 1 : 0.9);
    }
    // blood: specks streaming toward the heart, fastest mid-stream (Poiseuille's profile)
    if (cells > 0 && v !== 0) {
      const r = rng(seed), n = Math.round((xb - xa) * (b * 2 * k) / 9 * cells), span = (u1 - u0) + 4;
      for (let i = 0; i < n; i++) {
        const fz = r() * 2 - 1, sp = v * (1 - fz * fz) * (0.6 + 0.4 * r());
        const u = u0 - 2 + ((r() * span + sp * t) % span + span) % span;
        const tz = top(u);
        const z = (tz + cz + b) / 2 + fz * (cz + b - tz) / 2 * 0.9;
        const x = this.X(u), y = this.Y(z);
        if (x < xa || x >= xb) continue;
        const c = r() < 0.08 ? 'white' : art ? (r() < 0.5 ? 'pink' : 'peach') : (r() < 0.55 ? 'red' : 'plum');
        px.rect(x, y, r() < 0.3 ? 2 : 1, 1, c, 0.85);
      }
    }
    // contrast: a plume of white from a source, dense near it, thinning, carried downstream
    if (contrast) {
      const { u: cu, z: czz, k: ck = 1, rate = 1, cols = ['white', 'grey'], jet = 1.3, life = 2.2 } = contrast, r = rng(seed + 9);
      const n = Math.round(320 * ck);
      for (let i = 0; i < n; i++) {
        const age = ((r() * life + t * rate) % life);
        // a jet out of the tip, slowing and spreading across the lumen as it mixes
        const u = cu + (v * 0.6 + jet * 6 * Math.exp(-age * 1.5)) * age + (r() - 0.5) * age * 1.6;
        const spread = Math.min(b * 0.95, 0.25 + age * age * b * 0.7);
        const z = czz + (r() - 0.5) * 2 * spread;
        if (z < top(u) || z > cz + b || u > u1) continue;
        px.rect(this.X(u), this.Y(z), r() < 0.4 ? 2 : 1, 1, age < 0.5 ? cols[0] : r() < 0.6 ? cols[1] : cols[0], ck * (0.95 - age / life * 0.5));
      }
    }
    // valves: two cusps from the wall leaning toward the heart; shut, they meet mid-stream
    for (const vu of valves) {
      for (const sd of [-1, 1]) {
        // (sd -1 the upper cusp, +1 the lower; open they lie back along the wall, shut they meet)
        const base = [vu, sd < 0 ? top(vu) : cz + b];
        const openTip = [vu + b * 1.3, sd < 0 ? base[1] + 0.3 * b : base[1] - 0.3 * b];
        const shutTip = [vu + b * 0.75, cz];
        const o = valveOpen, tip = [shutTip[0] + (openTip[0] - shutTip[0]) * o, shutTip[1] + (openTip[1] - shutTip[1]) * o];
        // a curved cusp: its belly bowed toward the sinus behind it
        let lx = this.X(base[0]), ly = this.Y(base[1]);
        for (let i = 1; i <= 8; i++) {
          const f = i / 8, bow = Math.sin(f * Math.PI) * 0.18 * b * (1 - 0.5 * o);
          const u = base[0] + (tip[0] - base[0]) * f - bow, z = base[1] + (tip[1] - base[1]) * f + (sd < 0 ? -bow : bow) * 0.3;
          const x = this.X(u), y = this.Y(z);
          px.line(lx, ly, x, y, 'peach', 1); px.line(lx + 1, ly, x + 1, y, 'pink', 0.7);
          lx = x; ly = y;
        }
      }
    }
    return { top };
  }
  /* The needle: a steel tube with its bevel (up, the point on its lower edge), lumen, on its
     shaft back from the tip at angle pitch (deg) below horizontal; len mm of it drawn; lumenFill
     0..1 how far back the lumen shows blood (the flash). */
  needle(t, { tip, pitch, od = 0.9, id = 0.6, bevel = 1.8, len = 40, lumenFill = 0, flashCol = 'dkred', a = 1, under = null } = {}) {
    const px = this.px, k = this.k, p = pitch * Math.PI / 180;
    const d = [Math.cos(p), Math.sin(p)];            // forward, in (u, z)
    const up = [Math.sin(p), -Math.cos(p)];          // across, toward the skin's side
    const R = od / 2, Ri = id / 2;
    const step = 0.5 / k;
    for (let s = 0; s < len; s += step) {
      for (let c = -R; c <= R; c += 0.6 / k) {
        const cn = (c + R) / (2 * R);                 // 0 lower edge .. 1 upper edge
        if (s < bevel * cn) continue;                 // in front of the bevel's face
        const u = tip[0] - d[0] * s + up[0] * c, z = tip[1] - d[1] * s + up[1] * c;
        if (under && under(u, z)) continue;
        const inner = Math.abs(c) < Ri;
        let col;
        // (the flash: blood in the lumen, specks of it running back up toward the chamber)
        if (inner) col = s < lumenFill * len ? ((((s * 9 + c * 23 - t * 14) % 1.6) + 1.6) % 1.6 < 0.35 ? 'red' : flashCol) : 'ink';
        else col = c > R * 0.45 ? 'white' : c < -R * 0.5 ? 'slate' : 'grey';
        px.px(this.X(u), this.Y(z), col, a);
      }
    }
    return { d, up };
  }
  /* The catheter: a clear sleeve (od mm) over the needle, from its tip `tip` back along the
     shaft; or, threaded, along a path of [u, z] points (tip first). */
  catheter(path, { od = 1.1, a = 0.9, col = 'white', taper = 0.8 } = {}) {
    const px = this.px, k = this.k, R = od / 2;
    let acc = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const [u0, z0] = path[i], [u1, z1] = path[i + 1], L = Math.hypot(u1 - u0, z1 - z0) || 1e-6;
      const nx = -(z1 - z0) / L, nz = (u1 - u0) / L;
      for (let s = 0; s <= L; s += 0.5 / k) {
        const u = u0 + (u1 - u0) * s / L, z = z0 + (z1 - z0) * s / L, from = acc + s;
        const rr = from < taper ? R * (0.62 + 0.38 * from / taper) : R;
        for (const sd of [-1, 1]) px.px(this.X(u + nx * rr * sd), this.Y(z + nz * rr * sd), col, a);
        // (the clear plastic between its edges: a faint sheen over whatever it sheathes)
        if (((from * k * 2) | 0) % 2 === 0) for (let c = -rr * 0.7; c <= rr * 0.7; c += 1.2 / k) px.px(this.X(u + nx * c), this.Y(z + nz * c), col, a * 0.1);
      }
      acc += L;
    }
  }
}

// a dimension: a line with end ticks between two points, its value beside it (numbers, units)
export function dimLine(px, x0, y0, x1, y1, label, c = 'yellow', a = 1) {
  px.line(x0, y0, x1, y1, c, a);
  const L = Math.hypot(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / L * 2, ny = (x1 - x0) / L * 2;
  px.line(x0 - nx, y0 - ny, x0 + nx, y0 + ny, c, a); px.line(x1 - nx, y1 - ny, x1 + nx, y1 + ny, c, a);
  if (label) {
    const vert = Math.abs(y1 - y0) > Math.abs(x1 - x0);
    px.text(label, (x0 + x1) / 2 + (vert ? 4 : 0), (y0 + y1) / 2 + (vert ? -2 : -8), c, a, 1, vert ? 'left' : 'center');
  }
}

// ---------------------------------------------------------------- µm fields
/* A stretch of blood at the cell scale, between two walls (or one): cells streaming right at a
   speed falling to nothing at the wall; white cells rolling along it; platelets. c: contrast
   (0..1) dissolved in the plasma (it does not enter the cells); sal: saline thinning the cells. */
export function bloodField(px, t, { x0 = 0, y0 = 0, w = px.W, h = px.H, wallTop = true, wallBot = true, v = 40, seed = 7,
  art = false, contrast = 0, contrastFront = null, sal = 0, dense = 1, a = 1 } = {}) {
  const r = rng(seed);
  const wt = wallTop ? 10 : 0, wb = wallBot ? 10 : 0;
  const ly0 = y0 + wt, ly1 = y0 + h - wb, lh = ly1 - ly0;
  // plasma: straw, tinted by contrast where it has reached
  px.rect(x0, ly0, w, lh, 'gold', 0.22 * a);
  const fr = contrastFront ? contrastFront : () => (contrast > 0 ? Infinity : -Infinity);
  // the plasma the contrast has reached, paler
  if (contrast > 0) for (let y = ly0; y < ly1; y++) { const f = Math.min(x0 + w, fr(y)); if (f > x0) px.rect(x0, y, f - x0, 1, 'white', 0.13 * contrast * a); }
  // the walls: endothelium (flat cells, nuclei bulging), the layers behind
  const wall = (yy, dir) => {
    px.rect(x0, yy, w, 10, 'plum', 0.55 * a);
    px.rect(x0, dir > 0 ? yy : yy + 7, w, 3, 'brown', 0.6 * a);
    for (let x = x0 - ((t * 0) % 14); x < x0 + w; x += 14) {
      px.rect(x, dir > 0 ? yy + 8 : yy, 13, 2, 'peach', 0.9 * a);
      px.rect(x + 5, dir > 0 ? yy + 7 : yy + 2, 4, 1, 'pink', a);
    }
  };
  if (wallTop) wall(y0, 1);
  if (wallBot) wall(ly1, -1);
  const span = w + 24;
  const n = Math.round(w * lh / 70 * dense * (1 - 0.6 * sal));
  const sp = (fy) => {
    // the speed across the lumen: zero at a wall, full in the middle (or far from one wall)
    const dTop = wallTop ? fy : 1, dBot = wallBot ? 1 - fy : 1;
    const q = Math.min(1, Math.min(dTop, dBot) * (wallTop && wallBot ? 2 : 1.4));
    return v * (1 - (1 - q) * (1 - q));
  };
  for (let i = 0; i < n; i++) {
    const fy = r(), y = ly0 + 3 + fy * (lh - 6), s = sp(fy) * (0.85 + 0.3 * r());
    const x = x0 - 12 + ((r() * span + s * t) % span + span) % span;
    const kind = r();
    if (kind < 0.012) continue;
    const tumble = Math.sin(t * 2 + i) > 0.6;
    px.sprite(tumble ? SPR.rbcEdge : art ? SPR.rbcArt : SPR.rbc, x, y, a);
  }
  // platelets
  for (let i = 0; i < n / 10; i++) {
    const fy = r(), y = ly0 + 2 + fy * (lh - 4), s = sp(fy);
    const x = x0 - 12 + ((r() * span + s * t) % span + span) % span;
    px.sprite(SPR.plt, x, y, a);
  }
  // white cells roll slowly along the walls
  const wbcs = [];
  for (let i = 0; i < Math.max(1, Math.round(w / 140)); i++) {
    const onTop = wallTop && (i % 2 === 0 || !wallBot);
    const y = onTop ? ly0 + 6 : ly1 - 6, s = v * 0.06;
    const x = x0 - 12 + ((r() * span + s * t) % span + span) % span;
    px.sprite(SPR.wbc, x, y, a);
    wbcs.push([x, y]);
  }
  // contrast: iodinated molecules in the plasma, between the cells, up to its front
  if (contrast > 0) {
    const nc = Math.round(w * lh / 12 * contrast);
    for (let i = 0; i < nc; i++) {
      const fy = r(), y = ly0 + 1 + fy * (lh - 2), s = sp(fy);
      const x = x0 - 12 + ((r() * span + s * t) % span + span) % span;
      if (x > fr(y)) continue;
      px.px(x, y, r() < 0.5 ? 'white' : 'yellow', 0.9 * a);
    }
  }
  return { ly0, ly1, wbcs };
}

/* The wall in section at about 4 µm a pixel: the lumen at the left; intima (endothelium on its
   basement membrane), media (smooth muscle, wrapped round: seen end on here), adventitia
   (collagen, a small vessel of its own). A vein's media is thin and its adventitia thick; an
   artery's media thick, with elastic laminae. */
export function wallLayers(px, t, { x0, y0, w, h, artery = false, a = 1 }) {
  const r = rng(artery ? 52 : 51);
  const lum = Math.round(w * 0.16), inti = 4;
  const med = Math.round((w - lum) * (artery ? 0.5 : 0.22)), adv = w - lum - inti - med;
  const bx = { lumen: [x0, y0, lum, h], intima: [x0 + lum, y0, inti, h], media: [x0 + lum + inti, y0, med, h], adventitia: [x0 + lum + inti + med, y0, adv, h] };
  // lumen: blood going by
  px.rect(x0, y0, lum, h, artery ? 'red' : 'dkred', a);
  for (let i = 0; i < 26; i++) {
    const yy = y0 + ((r() * h + t * (artery ? 40 : 18) * (0.6 + r() * 0.4)) % h);
    px.sprite(artery ? SPR.rbcArt : SPR.rbc, x0 + 3 + r() * (lum - 6), yy, a);
  }
  // intima: the endothelial cells, a single flat layer
  px.rect(bx.intima[0], y0, inti, h, 'peach', a);
  for (let y = y0; y < y0 + h; y += 9) px.rect(bx.intima[0] - 1, y + 3, 2, 3, 'pink', a);
  // media: smooth muscle cells (and, in an artery, wavy elastic sheets)
  px.rect(bx.media[0], y0, med, h, artery ? 'pink' : 'plum', 0.35 * a);
  for (let i = 0; i < med * h / 40; i++) px.sprite(SPR.smc, bx.media[0] + 5 + r() * (med - 10), y0 + 2 + r() * (h - 4), a);
  if (artery) for (const f of [0.02, 0.98]) for (let y = y0; y < y0 + h; y++) px.px(bx.media[0] + f * med + Math.sin(y * 0.6) * 1.2, y, 'yellow', 0.9 * a);
  // adventitia: collagen in loose bundles; a small vessel feeding the wall (vasa vasorum)
  px.rect(bx.adventitia[0], y0, adv, h, 'brown', 0.3 * a);
  for (let i = 0; i < adv * h / 70; i++) {
    const xx = bx.adventitia[0] + r() * adv, yy = y0 + r() * h, L = 5 + r() * 10, an = (r() - 0.5) * 0.7 + Math.sin(yy * 0.05) * 0.4;
    px.line(xx, yy, xx + Math.cos(an) * L, yy + Math.sin(an) * L, r() < 0.5 ? 'bone' : 'peach', 0.4 * a);
  }
  const vx = bx.adventitia[0] + adv * 0.6, vy = y0 + h * 0.35;
  px.circle(vx, vy, 4, 'red', a); px.circle(vx, vy, 3, 'dkred', a, true);
  return bx;
}

// ---------------------------------------------------------------- the skin's surface, µm
/* Corneocytes (flat dead cells, stacked like shingles), a hair in its follicle, a sweat pore, the
   bacteria living on and in it. kill(i, x, y) -> 0..1 how dead each is (0 alive). */
export function skinSurface(px, t, { x0 = 0, y0 = 0, w = px.W, h = px.H, surf = 0.45, kill = null, wetY = null, a = 1 } = {}) {
  const r = rng(61), ys = y0 + Math.round(h * surf);
  px.rect(x0, y0, w, h, 'ink', a);
  // the horny layer: plates, a few deep, edges lifting
  for (let row = 0; row < 7; row++) {
    for (let x = x0 - 20 + (row % 2) * 13 - 6; x < x0 + w; x += 26) {
      const yy = ys + row * 5 + Math.round(Math.sin(x * 0.05 + row) * 1.5);
      px.rect(x, yy, 24, 3, row === 0 ? 'bone' : 'peach', (0.85 - row * 0.07) * a);
      px.rect(x, yy + 3, 24, 1, 'brown', 0.4 * a);
    }
  }
  px.rect(x0, ys + 35, w, h - (ys - y0) - 35, 'peach', 0.45 * a);
  // the living layers under the dead ones: keratinocytes, each with its nucleus, rounder deeper
  for (let row = 0, y = ys + 37; y < y0 + h; row++, y += 9) {
    for (let x = x0 - (row % 2) * 6; x < x0 + w; x += 12) {
      px.frame(x + 1, y, 11, 8, 'brown', 0.35 * a);
      px.rect(x + 5, y + 3, 3, 2, 'plum', 0.6 * a);
    }
  }
  // a follicle with its hair, a pore
  const fx = x0 + w * 0.68, px0 = x0 + w * 0.22;
  px.rect(fx - 6, ys - 2, 12, h, 'ink', 0.85 * a);
  px.rect(fx - 6, ys - 2, 1, h, 'brown', a); px.rect(fx + 5, ys - 2, 1, h, 'brown', a);
  for (let y = y0; y < y0 + h; y++) px.rect(fx - 2 + Math.round(Math.sin(y * 0.08) * 1.5), y, 3, 1, 'brown', a);
  px.rect(px0 - 3, ys - 1, 6, h, 'ink', 0.85 * a); px.rect(px0 - 3, ys - 1, 1, h, 'pink', 0.6 * a); px.rect(px0 + 2, ys - 1, 1, h, 'pink', 0.6 * a);
  // the bacteria: grape clusters of cocci and a few rods on the surface; some down the follicle
  const bugs = [];
  for (let i = 0; i < 46; i++) {
    const deep = i < 6;
    const x = deep ? fx - 4 + r() * 8 : x0 + 6 + r() * (w - 12);
    const y = deep ? ys + 14 + r() * (h - (ys - y0) - 24) : ys - 3 - r() * 4;
    const rod = !deep && r() < 0.25, cl = rod ? 1 : 2 + Math.floor(r() * 4);
    bugs.push({ i, x, y, rod, cl, deep });
  }
  bugs.forEach((b) => {
    const k = kill ? kill(b) : 0;
    const jig = k < 0.3 ? Math.sin(t * 3 + b.i) * 0.6 : 0;
    for (let j = 0; j < b.cl; j++) {
      const ox = (j % 2) * 3 - 1, oy = -Math.floor(j / 2) * 3;
      if (k < 0.5) px.sprite(b.rod ? SPR.rod : SPR.coccus, b.x + ox + jig, b.y + oy, a * (1 - k));
      else if (k < 0.95) { px.sprite(SPR.deadC, b.x + ox + (j - 1) * (k - 0.5) * 6, b.y + oy - (k - 0.5) * 3, a * (1.6 - k)); }
    }
  });
  return { ys, bugs, follicle: [fx - 6, ys - 2, 12, h - (ys - y0) + 2], pore: [px0 - 3, ys - 1, 6, 20] };
}
