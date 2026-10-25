/* DXA FILM: the studies it shows, baked from the app's own scan (bake.mjs -> public/anim/dxa.json):
   the AP lumbar spine and the left hip of the chest-abdomen-pelvis volume, each as its low- and
   high-energy attenuation, the solved bone mineral and soft tissue, the regions the analysis
   found and their numbers. Decoded once; drawn on the 8-bit layer as the console shows them
   (superior at the top, the patient's right on the viewer's left). */

const b64u8 = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };

export async function loadStudies(base) {
  let J = null;
  try { J = await (await fetch(base + 'anim/dxa.json')).json(); } catch (_) { J = null; }
  if (!J) return null;
  for (const key of ['spine', 'hip']) {
    const s = J[key];
    s.max = {};
    for (const k of ['lo', 'hi', 'bmd', 'soft']) {
      s.max[k] = s[k].max;
      const b = b64u8(s[k].data), u = new Uint16Array(b.buffer, 0, b.length >> 1), f = new Float32Array(u.length);
      for (let i = 0; i < u.length; i++) f[i] = (u[i] / 65535) * s[k].max;
      s[k] = f;                                    // physical units: A (ln I0/I) or g/cm2
    }
    if (s.mask) s.mask = b64u8(s.mask);
  }
  return J;
}

/* Draw one map of a study at (x, y), cell 8-bit pixels per scan pixel, the patient's right on the
   left (the stored column order is +x, the patient's right, first: so it is mirrored here).
   grey(v) -> 0..1. Rows/cols limits draw part of it (a raster building up). */
export function drawMap(px, s, map, x, y, cell, grey, { a = 1, rowMax = null, colOK = null, tint = null } = {}) {
  const g = px.g, { nx, nz } = s, src = s[map];
  const alpha = a * px.alpha;
  for (let r = 0; r < nz; r++) {
    if (rowMax != null && r > rowMax) break;
    for (let c = 0; c < nx; c++) {
      if (colOK && !colOK(r, c)) continue;
      const v = Math.max(0, Math.min(1, grey(src[r * nx + c], r, c))), k = Math.round(v * 255);
      const xx = x + (nx - 1 - c) * cell, yy = y + r * cell;
      const ix = Math.floor(xx), iy = Math.floor(yy), iw = Math.max(1, Math.floor(xx + cell) - ix), ih = Math.max(1, Math.floor(yy + cell) - iy);
      g.globalAlpha = alpha;
      g.fillStyle = tint ? tint(v) : `rgb(${k},${k},${k})`;
      g.fillRect(ix, iy, iw, ih);
    }
  }
  g.globalAlpha = 1;
}
/* The same map as a canvas made once (mirrored, superior at the top), for drawing whole or in part
   every frame: drawImage of a sub-rectangle is far cheaper than a rect per pixel. */
const canvases = new Map();
export function mapCanvas(s, map, colour) {
  const key = s[map];
  let byCol = canvases.get(key);
  if (!byCol) { byCol = new Map(); canvases.set(key, byCol); }
  let cv = byCol.get(colour);
  if (!cv) {
    const { nx, nz } = s, src = s[map];
    cv = document.createElement('canvas'); cv.width = nx; cv.height = nz;
    const g = cv.getContext('2d'), im = g.createImageData(nx, nz);
    for (let r = 0; r < nz; r++) for (let c = 0; c < nx; c++) {
      const [R, G, B] = colour(src[r * nx + c]), o = (r * nx + (nx - 1 - c)) * 4;
      im.data[o] = R; im.data[o + 1] = G; im.data[o + 2] = B; im.data[o + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    byCol.set(colour, cv);
  }
  return cv;
}
/* Draw a map canvas at (x, y), cell 8-bit pixels per scan pixel; part = [c0, r0, c1, r1] in the
   canvas's own (mirrored, superior-first) pixels draws only that rectangle, where it belongs. */
export function blit(px, cv, x, y, cell, part = null, a = 1) {
  const [c0, r0, c1, r1] = part || [0, 0, cv.width, cv.height];
  if (c1 <= c0 || r1 <= r0) return;
  const g = px.g;
  g.imageSmoothingEnabled = false;
  g.globalAlpha = a * px.alpha;
  g.drawImage(cv, c0, r0, c1 - c0, r1 - r0, Math.round(x + c0 * cell), Math.round(y + r0 * cell),
    Math.round((c1 - c0) * cell), Math.round((r1 - r0) * cell));
  g.globalAlpha = 1;
}
// a map's values at two percentiles (a display window)
export function rangeOf(a, p0 = 0.02, p1 = 0.998) {
  const s = Float32Array.from(a).sort();
  return [s[Math.floor(p0 * (s.length - 1))], s[Math.floor(p1 * (s.length - 1))]];
}
export const windowOf = ([lo, hi]) => (v) => { const k = Math.round(255 * Math.max(0, Math.min(1, (v - lo) / (hi - lo)))); return [k, k, k]; };
// colour maps for mapCanvas: v (the map's own units) -> [r, g, b]
export const greyOf = (max, gamma = 1) => (v) => { const k = Math.round(255 * Math.pow(Math.max(0, Math.min(1, v / max)), gamma)); return [k, k, k]; };
export const boneOf = (max) => (v) => {
  const k = Math.max(0, Math.min(1, v / max));
  return [Math.round(255 * Math.min(1, k * 1.2)), Math.round(255 * Math.min(1, k * 1.05)), Math.round(255 * Math.min(1, k * 0.9))];
};
// a scan pixel (stored row from the inferior edge, stored column) -> where drawMap put it
export const cellAt = (s, row, col, x, y, cell) => [x + (s.nx - 1 - col) * cell, y + (s.nz - 1 - row) * cell];

// the console's bone-image palette: black soft tissue to warm white bone
export function boneTint(v) {
  const r = Math.round(255 * Math.min(1, v * 1.25)), gg = Math.round(255 * Math.min(1, v * 1.08)), b = Math.round(255 * Math.min(1, v * 0.92));
  return `rgb(${r},${gg},${b})`;
}
