/* THE 8-BIT LAYER. Small things — atoms, electrons, photons, light, a detector's pixels, the numbers
   a pixel becomes — are drawn here, on a low-resolution canvas the browser scales up with no
   smoothing, over the 3D view (or alone, for the scenes that are all small things). Coordinates are
   in its own pixels: H rows always, W columns to fill the frame's width. */

// one palette for every film (a warm NES/PICO-8 cast), by name
export const PAL = {
  black: '#000000', ink: '#0d1220', navy: '#1d2b53', plum: '#7e2553', green: '#008751',
  brown: '#ab5236', slate: '#5f574f', grey: '#c2c3c7', white: '#fff1e8', red: '#ff004d',
  orange: '#ffa300', yellow: '#ffec27', lime: '#00e436', blue: '#29adff', lav: '#83769c',
  pink: '#ff77a8', peach: '#ffccaa', teal: '#1a8f8f', cyan: '#7ff6ff', dkred: '#7a1020',
  dkblue: '#0f3a6b', dkgrey: '#33363d', mid: '#83878f', bone: '#e8dcc0', fat: '#d9b26a',
  muscle: '#a8483e', lead: '#6a7380', gold: '#e8b830', violet: '#b06cff',
};

/* Sprites as text: one character a pixel, '.' clear, any other character a palette key from the
   map given. Parsed once. */
const spriteCache = new Map();
export function sprite(rows, map) {
  const key = rows.join('|') + JSON.stringify(map);
  let s = spriteCache.get(key);
  if (!s) {
    const h = rows.length, w = rows[0].length, px = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = rows[y][x];
      if (c !== '.' && map[c]) px.push(x, y, PAL[map[c]] || map[c]);
    }
    s = { w, h, px };
    spriteCache.set(key, s);
  }
  return s;
}

// a 3x5 pixel font: digits, a few letters and signs (for numbers on screen, never for prose)
const FONT = {
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001',
  5: '111100111001111', 6: '111100111101111', 7: '111001010010010', 8: '111101111101111', 9: '111101111001111',
  '.': '000000000000010', '-': '000000111000000', '+': '000010111010000', ':': '000010000010000',
  '%': '101001010100101', '/': '001001010100100', ' ': '000000000000000', 'x': '000101010101000',
  'k': '100101110101101', 'V': '101101101101010', 'm': '000110111101101', 'A': '010101111101101',
  'K': '101101110101101', 'L': '100100100100111', 'e': '000111111100111', 'c': '000111100100111',
  'n': '000110101101101', 'u': '000101101101111', 'H': '101101111101101', 'z': '000111011110111',
  's': '000011010001110', 'B': '110101110101110', 'W': '101101101111101', 'C': '111100100100111',
  'T': '111010010010010', 'D': '110101101101110', 'E': '111100111100111', 'P': '111101111100100',
  'R': '110101110101101', 'S': '011100010001110', 'I': '111010010010111', 'M': '101111111101101',
  'N': '110101101101101', 'O': '111101101101111', 'F': '111100110100100', 'G': '011100101101011',
  'Y': '101101010010010', 'U': '101101101101111', 'X': '101101010101101', 'Q': '111101101110011',
  'Z': '111001010100111', 'J': '001001001101111', 'a': '000011101101011', 'b': '100110101101110',
  'd': '001011101101011', 'f': '011100110100100', 'g': '011101011001110', 'h': '100110101101101',
  'i': '010000010010010', 'l': '010010010010001', 'o': '000111101101111', 'p': '000110101110100',
  'r': '000110100100100', 't': '010111010010001', 'v': '000101101101010', 'w': '000101101111101',
  'y': '000101011001110', 'µ': '000101101111100', '=': '000111000111000', '>': '100010001010100',
  '<': '001010100010001', '(': '010100100100010', ')': '010001001001010', '°': '010101010000000',
  '#': '101111101111101', '^': '010101000000000', ',': '000000000010100', "'": '010010000000000',
};

export class PixelLayer {
  constructor(canvas, rows = 200) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.H = rows;
    this.W = rows;
    this.alpha = 1;
  }
  resize(cssW, cssH) {
    this.W = Math.max(1, Math.round(this.H * cssW / Math.max(1, cssH)));
    this.cv.width = this.W; this.cv.height = this.H;
    this.g.imageSmoothingEnabled = false;
  }
  clear() { this.g.clearRect(0, 0, this.W, this.H); }
  fillAll(color) { this.g.fillStyle = PAL[color] || color; this.g.fillRect(0, 0, this.W, this.H); }
  col(c) { return PAL[c] || c; }
  px(x, y, c, a = 1) {
    const g = this.g; g.globalAlpha = a * this.alpha; g.fillStyle = this.col(c);
    g.fillRect(Math.round(x), Math.round(y), 1, 1); g.globalAlpha = 1;
  }
  rect(x, y, w, h, c, a = 1) {
    const g = this.g; g.globalAlpha = a * this.alpha; g.fillStyle = this.col(c);
    g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); g.globalAlpha = 1;
  }
  frame(x, y, w, h, c, a = 1) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    this.rect(x, y, w, 1, c, a); this.rect(x, y + h - 1, w, 1, c, a);
    this.rect(x, y, 1, h, c, a); this.rect(x + w - 1, y, 1, h, c, a);
  }
  // a Bresenham line, optionally dashed (on/off pixel counts)
  line(x0, y0, x1, y1, c, a = 1, dash = 0) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, n = 0;
    const g = this.g; g.globalAlpha = a * this.alpha; g.fillStyle = this.col(c);
    for (let guard = 0; guard < 4000; guard++) {
      if (!dash || (n++ % (dash * 2)) < dash) g.fillRect(x0, y0, 1, 1);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    g.globalAlpha = 1;
  }
  circle(cx, cy, r, c, a = 1, fill = false) {
    cx = Math.round(cx); cy = Math.round(cy); r = Math.max(0, Math.round(r));
    if (fill) {
      for (let y = -r; y <= r; y++) {
        const w = Math.floor(Math.sqrt(r * r - y * y + r * 0.8));
        this.rect(cx - w, cy + y, 2 * w + 1, 1, c, a);
      }
      return;
    }
    let x = r, y = 0, err = 1 - r;
    const g = this.g; g.globalAlpha = a * this.alpha; g.fillStyle = this.col(c);
    while (x >= y) {
      for (const [px, py] of [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]]) g.fillRect(cx + px, cy + py, 1, 1);
      y++;
      if (err < 0) err += 2 * y + 1; else { x--; err += 2 * (y - x) + 1; }
    }
    g.globalAlpha = 1;
  }
  sprite(s, x, y, a = 1, scale = 1, tint = null) {
    const g = this.g; g.globalAlpha = a * this.alpha;
    x = Math.round(x - (s.w * scale) / 2); y = Math.round(y - (s.h * scale) / 2);
    for (let i = 0; i < s.px.length; i += 3) {
      g.fillStyle = tint || s.px[i + 2];
      g.fillRect(x + s.px[i] * scale, y + s.px[i + 1] * scale, scale, scale);
    }
    g.globalAlpha = 1;
  }
  // a wavy photon: a short sine squiggle along a direction, its colour its energy
  photon(x, y, dx, dy, len, c, a = 1, phase = 0) {
    const L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    for (let i = 0; i < len; i++) {
      const w = Math.round(Math.sin(i * 1.6 + phase) * 1.2);
      this.px(x - ux * i + nx * w, y - uy * i + ny * w, c, a * (1 - i / (len + 1)));
    }
    this.px(x, y, 'white', a);
  }
  text(str, x, y, c = 'white', a = 1, scale = 1, align = 'left') {
    str = String(str);
    const adv = 4 * scale, w = str.length * adv - scale;
    if (align === 'center') x -= w / 2; else if (align === 'right') x -= w;
    x = Math.round(x); y = Math.round(y);
    const g = this.g; g.globalAlpha = a * this.alpha; g.fillStyle = this.col(c);
    for (let k = 0; k < str.length; k++) {
      const f = FONT[str[k]] ?? FONT[str[k].toLowerCase()] ?? FONT[str[k].toUpperCase()];
      if (!f) continue;
      for (let i = 0; i < 15; i++) if (f[i] === '1') g.fillRect(x + k * adv + (i % 3) * scale, y + Math.floor(i / 3) * scale, scale, scale);
    }
    g.globalAlpha = 1;
    return w;
  }
  // corner brackets round a box: the film's one way of pointing at something
  brackets(x, y, w, h, c = 'yellow', a = 1, arm = 4) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    for (const [bx, by, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
      this.rect(sx > 0 ? bx : bx - arm + 1, by, arm, 1, c, a);
      this.rect(bx, sy > 0 ? by : by - arm + 1, 1, arm, c, a);
    }
  }
  // a dithered disc of glow (heat, light), its density falling off with radius
  glow(cx, cy, r, c, a = 1, seed = 0) {
    r = Math.max(1, r);
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      const d = Math.hypot(x, y) / r;
      if (d > 1) continue;
      const k = ((x * 7 + y * 13 + seed * 31) & 7) / 8;      // an ordered dither
      if (k < (1 - d) * (1 - d) * 1.2) this.px(cx + x, cy + y, c, a);
    }
  }
}

// deterministic random numbers: the same seed gives the same field of atoms every loop
export function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
