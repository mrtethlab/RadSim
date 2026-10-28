/* THE SURGICAL FILMS' LIVE IMAGE: what the C-arm's monitor shows at the C's angles, from the
   projections build_anim_images.py (surg) made round each region (public/anim/surg.json, the
   frames in sheets surg_<region>.png) and the tissue crops for the cross-section (surg_x_*.png).

   A frame is drawn as the console draws one: the blended projections (geom.js frameWeights) of
   the attenuation, the needles, cannulae and contrast laid in as extra attenuation where they
   project (geom.js project), windowed by the frame's own brightness control (its lo/hi, blended
   with it), shown dark where the beam is stopped (bone, steel, contrast) as a C-arm shows it,
   edge-enhanced, in the round field of the intensifier with a little seeded quantum mottle. */
import { frameWeights, project, v3 } from './geom.js';
import { rng } from '../../pixel.js';

function loadImg(url) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => {
      const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
      const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
      res(g.getImageData(0, 0, im.width, im.height));
    };
    im.onerror = () => res(null);
    im.src = url;
  });
}

/* Load the manifest and the named regions' sheets and crops (all, by default). Returns SI (below). */
export async function loadSurgImages({ regions = null, crops = null } = {}) {
  const base = import.meta.env.BASE_URL + 'anim/';
  const man = await fetch(base + 'surg.json').then((r) => r.json());
  const want = (all, list) => Object.keys(all).filter((k) => !list || list.includes(k));
  const R = {}, C = {};
  await Promise.all([
    ...want(man.regions, regions).map(async (k) => {
      const r = { name: k, ...man.regions[k] };
      r.sheet = await loadImg(base + r.file);
      r.cache = new Map();
      R[k] = r;
    }),
    ...want(man.crops, crops).map(async (k) => {
      const c = { name: k, ...man.crops[k] };
      const im = await loadImg(base + c.file);
      const [nx, ny, nz] = c.dims;
      c.data = new Uint8Array(nx * ny * nz);
      if (im) for (let i = 0; i < nz; i++) {
        const z = nz - 1 - i, x0 = (i % c.cols) * nx, y0 = Math.floor(i / c.cols) * ny;       // head first in the sheet
        for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) c.data[x + nx * (y + ny * z)] = im.data[((y0 + y) * im.width + x0 + x) * 4];
      }
      C[k] = c;
    }),
  ]);
  const tissue = man.tissue;

  // one frame's attenuation path (mu x cm), decoded from its sheet once
  function path(r, i) {
    let a = r.cache.get(i);
    if (!a) {
      const n = r.n, x0 = (i % r.cols) * n, y0 = Math.floor(i / r.cols) * n, s = r.scale / 255;
      a = new Float32Array(n * n);
      if (r.sheet) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) a[y * n + x] = r.sheet.data[((y0 + y) * r.sheet.width + x0 + x) * 4] * s;
      r.cache.set(i, a);
    }
    return a;
  }

  /* The live image of region `name` at the C's pose: lum 0..1 (-1 outside the round field), n x n.
     opts:
       needles  [{ from, to, od = 1.6, w = 1 }]  steel from `from` to `to` (the patient's frame):
                a needle's shaft (Needle.segment()), a cannula, a probe; od the extra attenuation
                (mu x cm) on its line, w its width in image pixels
       blobs    [{ at, r, od = 2 }]  contrast (or anything dense): a soft ball of radius r cm
       field    the round field's radius, a fraction of the half-width (1)
       edge     the edge enhancement (1.2); noise the quantum mottle (0.035); seed (the pulse) */
  function image(name, orbital, tilt, { needles = [], blobs = [], field = 1, edge = 1.2, noise = 0.035, seed = 1 } = {}) {
    const r = R[name], n = r.n, N = n * n;
    const P = new Float32Array(N);
    let lo = 0, hi = 0;
    for (const [i, w] of frameWeights(r, orbital, tilt)) {
      const a = path(r, i);
      for (let k = 0; k < N; k++) P[k] += a[k] * w;
      lo += r.frames[i][2] * w; hi += r.frames[i][3] * w;
    }
    // the steel and the contrast where they project
    for (const nd of needles) {
      const a = project(r, orbital, tilt, nd.from), b = project(r, orbital, tilt, nd.to);
      // a needle seen end on (down the beam) stops more: the steel along the beam, per pixel it
      // crosses, is its length over its projected length (at most 8 times a side-on needle's)
      const Lp = Math.hypot(b[0] - a[0], b[1] - a[1]), L3 = v3.len(v3.sub(nd.to, nd.from)) * r.n / r.span;
      const od = (nd.od ?? 1.6) * Math.min(8, L3 / Math.max(1, Lp)), rr = Math.max(0.5, (nd.w ?? 1) / 2);
      const L = Math.max(1, Math.ceil(Lp * 2));
      const hit = new Uint8Array(N);
      for (let m = 0; m <= L; m++) {
        const x = a[0] + (b[0] - a[0]) * m / L, y = a[1] + (b[1] - a[1]) * m / L;
        for (let yy = Math.floor(y - rr); yy <= Math.floor(y + rr); yy++) for (let xx = Math.floor(x - rr); xx <= Math.floor(x + rr); xx++) {
          if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
          const d = Math.hypot(xx + 0.5 - x, yy + 0.5 - y);
          if (d <= rr + 0.2 && !hit[yy * n + xx]) { hit[yy * n + xx] = 1; P[yy * n + xx] += od * (d <= rr ? 1 : 0.5); }
        }
      }
    }
    for (const b of blobs) {
      const c = project(r, orbital, tilt, b.at), rp = b.r * n / r.span, od = b.od ?? 2;
      for (let yy = Math.floor(c[1] - rp - 1); yy <= c[1] + rp + 1; yy++) for (let xx = Math.floor(c[0] - rp - 1); xx <= c[0] + rp + 1; xx++) {
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const d = Math.hypot(xx + 0.5 - c[0], yy + 0.5 - c[1]) / Math.max(0.5, rp);
        if (d < 1) P[yy * n + xx] += od * Math.sqrt(1 - d * d);           // a ball's chord
      }
    }
    // windowed: dark where the beam is stopped
    const L = new Float32Array(N), span = Math.max(1e-3, hi - lo);
    for (let k = 0; k < N; k++) L[k] = 1 - Math.max(0, Math.min(1.15, (P[k] - lo) / span));
    // edge enhancement: the image plus a share of itself less its blur (a box blur, 9 pixels, twice)
    const B = blur(blur(L, n, 4), n, 4);
    const ran = noise ? rng(seed) : null;
    const R2 = (n / 2 * field) ** 2;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const k = y * n + x;
      if ((x + 0.5 - n / 2) ** 2 + (y + 0.5 - n / 2) ** 2 > R2) { L[k] = -1; continue; }
      let v = L[k] + edge * (L[k] - B[k]);
      if (ran) v += (ran() + ran() + ran() - 1.5) * noise;
      L[k] = Math.max(0, Math.min(1, v * 0.92 + 0.04));
    }
    return L;
  }
  function blur(a, n, r) {
    const t = new Float32Array(a.length), o = new Float32Array(a.length), w = 2 * r + 1;
    for (let y = 0; y < n; y++) {
      let s = 0;
      for (let x = -r; x <= r; x++) s += a[y * n + Math.max(0, Math.min(n - 1, x))];
      for (let x = 0; x < n; x++) {
        t[y * n + x] = s / w;
        s += a[y * n + Math.min(n - 1, x + r + 1)] - a[y * n + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += t[Math.max(0, Math.min(n - 1, y)) * n + x];
      for (let y = 0; y < n; y++) {
        o[y * n + x] = s / w;
        s += t[Math.min(n - 1, y + r + 1) * n + x] - t[Math.max(0, y - r) * n + x];
      }
    }
    return o;
  }

  // ---- drawing a frame: onto a canvas (a monitor's screen), or onto the 8-bit layer
  const off = document.createElement('canvas'), og = off.getContext('2d');
  function toOff(lum, n, bg = [0, 0, 0]) {
    if (off.width !== n) { off.width = n; off.height = n; }
    const id = og.createImageData(n, n), d = id.data;
    for (let k = 0; k < n * n; k++) {
      const v = lum[k];
      if (v < 0) { d[k * 4] = bg[0]; d[k * 4 + 1] = bg[1]; d[k * 4 + 2] = bg[2]; d[k * 4 + 3] = 255; continue; }
      const g = Math.round(v * 255);
      d[k * 4] = g; d[k * 4 + 1] = g; d[k * 4 + 2] = Math.min(255, g + 4); d[k * 4 + 3] = 255;
    }
    og.putImageData(id, 0, 0);
    return off;
  }
  /* A screen ({ canvas, texture }, as carm.js buildTower's): black, the image square in its middle;
     label: a short line of text top left (a view's name). */
  function toScreen(screen, lum, n, { label = null } = {}) {
    const cv = screen.canvas, g = cv.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
    if (lum) {
      toOff(lum, n);
      g.imageSmoothingEnabled = true;
      const s = Math.min(cv.width, cv.height) * 0.94;
      g.drawImage(off, (cv.width - s) / 2, (cv.height - s) / 2, s, s);
    }
    if (label) { g.fillStyle = '#9fe0b4'; g.font = '18px monospace'; g.fillText(label, 12, 26); }
    if (screen.texture) screen.texture.needsUpdate = true;
  }
  // x, y the top left (8-bit pixels), size its width; a: opacity
  function blit(px, lum, n, x, y, size, { a = 1 } = {}) {
    toOff(lum, n, [4, 6, 9]);
    const g = px.g;
    g.save(); g.globalAlpha = a * px.alpha; g.imageSmoothingEnabled = false;
    g.drawImage(off, Math.round(x), Math.round(y), Math.round(size), Math.round(size));
    g.restore();
  }
  // where a point of the patient's frame shows on a frame blitted at x, y, size (8-bit pixels)
  const onBlit = (name, orbital, tilt, p, x, y, size) => {
    const r = R[name], [c, w] = project(r, orbital, tilt, p);
    return [x + c / r.n * size, y + w / r.n * size];
  };

  return { man, tissue, regions: R, crops: C, path, image, toScreen, blit, onBlit, project: (name, o, t, p) => project(R[name], o, t, p), v3 };
}
