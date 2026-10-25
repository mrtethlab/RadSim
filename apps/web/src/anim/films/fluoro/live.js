/* THE LIVE IMAGE. The fluoroscopy film's monitor shows a real projection: the chest/abdomen/pelvis
   model's AP attenuation (public/anim/cap_ap.png, services/compute app/build_anim_images.py), its
   oesophagus, stomach and arteries kept apart so barium and iodine can flow into them as the film
   plays. A frame is made as the machine makes one: a few energies of the beam through the path
   (the app's own attenuation coefficients, core/materials.js), the photons per pixel the pulse
   delivers drawn with their quantum noise (seeded: the same pulse is the same frame every loop),
   then the console's display map, recursive filter and roadmap (core/fluoroDisplay.js).

   Image frame: W x H pixels of 0.174 cm, row 0 at the head, column 0 at the patient's right. The
   patient's own frame (the meshes, cm): x toward the patient's right, y anterior, z toward the head;
   column c lies at x = X0 - (c + 0.5) cm, row r at z = Z0 - (r + 0.5) cm (both scaled by CM). */
import { Materials, BodyMaterials } from '../../../core/materials.js';
import { displayMap } from '../../../core/fluoroDisplay.js';
import { rng } from '../../pixel.js';

const SCALE = { base: 10, oes: 2.5, sto: 16, art: 8 };       // the PNGs' fixed scales (build_anim_images)
export const IMG = { W: 240, H: 409, CM: 41.8 / 240, X0: 20.9, Z0: 35.6 };
export const FIELD_PX = 80;                                   // a 23 cm intensifier's field at the isocentre: 23 / (99/60) = 14 cm
// the agents' strengths: a 60 % w/v barium suspension (0.59 g Ba per g BaSO4), and arterial blood
// carrying iodine at 40 mg/mL during an injection
const BA_MG_ML = 600 * 0.5884, I_MG_ML = 40;

function loadPng(url) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => {
      const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
      const g = cv.getContext('2d'); g.drawImage(im, 0, 0);
      res(g.getImageData(0, 0, im.width, im.height));
    };
    im.onerror = () => res(null);
    im.src = url;
  });
}

export async function loadLive() {
  const base0 = import.meta.env.BASE_URL + 'anim/';
  const [rgb, art8] = await Promise.all([loadPng(base0 + 'cap_ap.png'), loadPng(base0 + 'cap_ap_art.png')]);
  const { W, H } = IMG, N = W * H;
  const base = new Float32Array(N), oes = new Float32Array(N), sto = new Float32Array(N), art = new Float32Array(N);
  if (rgb) for (let i = 0; i < N; i++) {
    base[i] = rgb.data[i * 4] / 255 * SCALE.base;
    oes[i] = rgb.data[i * 4 + 1] / 255 * SCALE.oes;
    sto[i] = rgb.data[i * 4 + 2] / 255 * SCALE.sto;
  }
  if (art8) for (let i = 0; i < N; i++) art[i] = art8.data[i * 4] / 255 * SCALE.art;

  // ---- the beam as three energies (a filtered spectrum's low, middle and high thirds)
  const muS50 = Materials.mu('soft', 50);
  const coeffMemo = new Map();
  function coeffs(kv) {
    const key = Math.round(kv);
    let c = coeffMemo.get(key);
    if (!c) {
      c = [[0.36, 0.3], [0.47, 0.45], [0.6, 0.25]].map(([f, w]) => {
        const E = Math.max(20, f * key);
        return { w, s: Materials.mu('soft', E) / muS50, ba: BodyMaterials.muBariumPerConc(E) * BA_MG_ML, io: BodyMaterials.muIodinePerConc(E) * I_MG_ML };
      });
      coeffMemo.set(key, c);
    }
    return c;
  }

  // ---- centrelines (image pixels): the oesophagus by its lumen, the aorta and iliacs by their runs
  const rowRuns = (arr, r, thr) => {
    const runs = [];
    let c0 = -1;
    for (let c = 0; c <= W; c++) {
      const on = c < W && arr[r * W + c] > thr;
      if (on && c0 < 0) c0 = c;
      if (!on && c0 >= 0) { runs.push([c0, c - 1]); c0 = -1; }
    }
    return runs;
  };
  const oesLine = [];
  for (let r = 0; r < H; r++) {
    let s = 0, m = 0;
    for (let c = 0; c < W; c++) { const v = oes[r * W + c]; if (v > 0.2) { s += v * c; m += v; } }
    if (m > 0.3) oesLine.push([s / m, r]);
  }
  // the bifurcation: the first row (going down the abdomen) where two separate runs stand either side
  let rB = Math.round(H * 0.72);
  for (let r = Math.round(H * 0.55); r < H * 0.9; r++) {
    const runs = rowRuns(art, r, 0.4).filter(([a, b]) => b - a >= 1 && Math.abs((a + b) / 2 - W / 2) < 45);
    if (runs.length >= 2 && runs[1][0] - runs[0][1] > 3) { rB = r; break; }
  }
  // follow one vessel row by row from column c0: the nearest run each row (a gap of a few rows is
  // bridged: the thin iliacs fade in and out of the threshold)
  const track = (r0, r1, step, c0, first = 20) => {
    const out = [];
    let c = c0, miss = 0;
    for (let r = r0; step > 0 ? r <= r1 : r >= r1; r += step) {
      const runs = rowRuns(art, r, 0.25);
      let best = null;
      const tol = out.length ? 9 : first;
      // the distance to a run is to its nearer edge (zero inside it): a vessel that widens or
      // merges for a few rows is still the same vessel
      const dist = (a, b) => (c >= a && c <= b ? 0 : Math.min(Math.abs(a - c), Math.abs(b - c)));
      let bd = Infinity;
      for (const [a, b] of runs) { const d = dist(a, b); if (d < tol && d < bd) { bd = d; best = [b - a > 14 ? c + Math.sign((a + b) / 2 - c) * 2 : (a + b) / 2, Math.min(b - a + 1, 14)]; } }
      if (!best) { if (++miss > 4) break; continue; }
      miss = 0;
      c = best[0];
      out.push([c, r, best[1]]);
    }
    return out;
  };
  const split = rowRuns(art, rB + 2, 0.4).filter(([a, b]) => Math.abs((a + b) / 2 - W / 2) < 45);
  const mid = split.length > 1 ? (split[0][0] + split[split.length - 1][1]) / 2 : W / 2;
  const aorta = track(rB - 1, Math.round(H * 0.36), -1, mid).reverse();              // head to the bifurcation
  const iliacR = split.length ? track(rB + 2, H - 1, 1, (split[0][0] + split[0][1]) / 2) : [];   // the patient's right: the image's left
  const iliacL = split.length > 1 ? track(rB + 2, H - 1, 1, (split[split.length - 1][0] + split[split.length - 1][1]) / 2) : [];
  const smooth = (pts, k = 3) => pts.map((p, i) => {
    let sc = 0, n = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(pts.length - 1, i + k); j++) { sc += pts[j][0]; n++; }
    return [sc / n, p[1], p[2]];
  });
  // the right external iliac, up from the groin (the lowest vessel on the patient's right) to where
  // it meets the common iliac
  const fromGroin = (side) => {
    for (let r = H - 1; r > rB + 10; r--) {
      const runs = rowRuns(art, r, 0.25).filter(([a, b]) => side * ((a + b) / 2 - W / 2) > 15);
      if (runs.length) return track(r, rB + 10, -1, (runs[0][0] + runs[0][1]) / 2, 3);
    }
    return [];
  };
  const extR = fromGroin(-1), extL = fromGroin(1);
  const lines = { oes: smooth(oesLine, 2), aorta: smooth(aorta), iliacR: smooth(iliacR), iliacL: smooth(iliacL), extR: smooth(extR), extL: smooth(extL), rB };
  /* A catheter's (or wire's) route in from the right groin: up the external iliac, across to the
     common iliac where they meet, up it to the bifurcation, up the aorta. */
  const ci = [...lines.iliacR].reverse();                                 // bottom to the bifurcation
  // where they meet: the first point up the external iliac that comes within 12 px of the common one
  let cut = lines.extR.length, join = 0;
  for (let k = 0; k < lines.extR.length && cut === lines.extR.length; k++) {
    const e = lines.extR[k];
    ci.forEach((p, i) => { if (cut === lines.extR.length && Math.hypot(p[0] - e[0], p[1] - e[1]) < 12) { cut = k + 1; join = i; } });
  }
  lines.route = [...lines.extR.slice(0, cut), ...ci.slice(join), ...[...lines.aorta].reverse()];

  // ---- one frame
  const gauss = (r) => { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.2831853 * v); };
  /* cx, cy: the field's centre (image pixels); span: image pixels across the frame; n: the frame's
     pixels; kv; quanta: detected photons per pixel through nothing (0 = no noise); seed;
     fills: oes(r) and sto(r) 0..1 barium, io(r) 0..1 iodine, by image row; paint: [{ pts (image
     pixels), od, w }] wires and catheters; shape(u, v) with u, v in -1..1: inside the field;
     shift: [dx, dy] image pixels (the patient moved). Returns transmission, -1 outside. */
  function frame({ cx, cy, n = 80, span = FIELD_PX, kv = 75, quanta = 0, detected = 0, seed = 1, oes: fo = null, sto: fs = null, io = null,
    paint = null, shape = null, shift = null, out = null } = {}) {
    const T = out && out.length === n * n ? out : new Float32Array(n * n);
    const K = coeffs(kv), k = span / n;
    const extra = paint ? rasterise(paint, n, cx, cy, span) : null;
    // detected: the photons per pixel the ABC holds at the receptor (at the field's mean transmission)
    if (detected) quanta = detected / Math.max(1e-4, meanT(cy, kv, cx));
    const r = quanta ? rng(seed) : null;
    const sx = shift ? shift[0] : 0, sy = shift ? shift[1] : 0;
    // sampled between the image's pixels (bilinear), so a magnified field is smooth, not blocky
    const bil = (a, p, fx, fy) => (a[p] * (1 - fx) + a[p + 1] * fx) * (1 - fy) + (a[p + W] * (1 - fx) + a[p + W + 1] * fx) * fy;
    for (let j = 0; j < n; j++) {
      const yr = cy - span / 2 + (j + 0.5) * k + sy - 0.5, ir = Math.floor(yr), fy = yr - ir;
      const v = (j + 0.5) / n * 2 - 1;
      const irr = Math.round(yr);
      const fO = irr >= 0 && irr < H && fo ? fo(irr) : 0, fS = irr >= 0 && irr < H && fs ? fs(irr) : 0, fI = irr >= 0 && irr < H && io ? io(irr) : 0;
      for (let i = 0; i < n; i++) {
        const u = (i + 0.5) / n * 2 - 1, q = j * n + i;
        if (shape ? !shape(u, v) : u * u + v * v > 1) { T[q] = -1; continue; }
        const xc = cx - span / 2 + (i + 0.5) * k + sx - 0.5, ic = Math.floor(xc), fx = xc - ic;
        let t;
        if (ir < 0 || ir >= H - 1 || ic < 0 || ic >= W - 1) t = 1;              // past the body: the open beam
        else {
          const p = ir * W + ic, b = bil(base, p, fx, fy), ba = bil(oes, p, fx, fy) * fO + bil(sto, p, fx, fy) * fS, ia = bil(art, p, fx, fy) * fI, e = extra ? extra[q] : 0;
          t = 0;
          for (const c of K) t += c.w * Math.exp(-(c.s * b + c.ba * ba + c.io * ia + e));
        }
        if (r) {
          const m = quanta * t;
          t = Math.max(0, m + Math.sqrt(m) * gauss(r)) / quanta;
        }
        T[q] = Math.max(t, 1e-5);
      }
    }
    return T;
  }
  // wires and catheters as optical depth on the frame's grid (image pixels -> frame pixels)
  function rasterise(paint, n, cx, cy, span) {
    const a = new Float32Array(n * n), k = n / span;
    for (const { pts, od, w = 1 } of paint) {
      for (let s = 0; s < pts.length - 1; s++) {
        const [c0, r0] = pts[s], [c1, r1] = pts[s + 1];
        const L = Math.max(1, Math.hypot(c1 - c0, r1 - r0) * k * 2);
        for (let m = 0; m <= L; m++) {
          const f = m / L, x = ((c0 + (c1 - c0) * f) - cx) * k + n / 2, y = ((r0 + (r1 - r0) * f) - cy) * k + n / 2;
          const rr = Math.max(0.5, w * k / 2);
          for (let yy = Math.floor(y - rr); yy <= Math.ceil(y + rr); yy++) for (let xx = Math.floor(x - rr); xx <= Math.ceil(x + rr); xx++) {
            if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
            const d = Math.hypot(xx + 0.5 - x, yy + 0.5 - y);
            if (d <= rr) a[yy * n + xx] = Math.max(a[yy * n + xx], od);
          }
        }
      }
    }
    return a;
  }

  // ---- the display: the console's map (log, background lifted, windowed on the centre)
  const scratch = {};
  let lastWin = null;                                          // the window the last display fitted (or held)
  function display(T, n, { harmonise = 0.55, win = null, out = null } = {}) {
    const L = out && out.length === n * n ? out : new Float32Array(n * n);
    displayMap(T, n, L, { harmonise, scratch, win });
    lastWin = scratch.win ? [...scratch.win] : null;
    return L;
  }

  // ---- drawing a frame: on the 8-bit layer (scaled up whole pixels), or onto a screen's canvas
  const off = document.createElement('canvas'), og = off.getContext('2d');
  function toOff(lum, n, { tint = null, bg = [4, 6, 9] } = {}) {
    if (off.width !== n) { off.width = n; off.height = n; }
    const id = og.createImageData(n, n), d = id.data;
    for (let k = 0; k < n * n; k++) {
      const v = lum[k];
      if (v < 0) { d[k * 4] = bg[0]; d[k * 4 + 1] = bg[1]; d[k * 4 + 2] = bg[2]; d[k * 4 + 3] = 255; continue; }
      const g = Math.round(Math.max(0, Math.min(1, v)) * 255);
      d[k * 4] = tint ? g * tint[0] : g; d[k * 4 + 1] = tint ? g * tint[1] : g; d[k * 4 + 2] = tint ? g * tint[2] : g; d[k * 4 + 3] = 255;
    }
    og.putImageData(id, 0, 0);
    return off;
  }
  // x, y: the top left (8-bit pixels); scale: 8-bit pixels per frame pixel; rot (radians) and flip
  // turn it about its centre as the console's image controls do
  function blit(px, lum, n, x, y, scale = 1, { a = 1, rot = 0, flipH = false, tint = null } = {}) {
    toOff(lum, n, { tint });
    const g = px.g, s = n * scale;
    g.save();
    g.globalAlpha = a * px.alpha;
    g.imageSmoothingEnabled = false;
    g.translate(Math.round(x + s / 2), Math.round(y + s / 2));
    if (rot) g.rotate(rot);
    if (flipH) g.scale(-1, 1);
    g.drawImage(off, -s / 2, -s / 2, s, s);
    g.restore();
  }
  // a screen's canvas (the monitor cart's): black, the image square in its middle
  function toScreen(screen, lum, n, { label = null } = {}) {
    const cv = screen.canvas, g = cv.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
    if (lum) {
      toOff(lum, n, { bg: [0, 0, 0] });
      g.imageSmoothingEnabled = false;
      const s = Math.min(cv.width, cv.height) * 0.92;
      g.drawImage(off, (cv.width - s) / 2, (cv.height - s) / 2, s, s);
    }
    if (label) { g.fillStyle = '#7fe3a4'; g.font = '20px monospace'; g.fillText(label, 14, 30); }
    screen.texture.needsUpdate = true;
  }

  // ---- what the automatic brightness control meters: the mean transmission over the central
  // part of the field, by the field's row and the kV (tabled once, then interpolated)
  const abcMemo = new Map();
  function meanT(cy, kv, cx = W / 2) {
    const rb = Math.round(cy / 4) * 4, kb = Math.round(kv / 5) * 5, key = rb * 1000 + kb + cx * 1e6;
    let v = abcMemo.get(key);
    if (v == null) {
      const K = coeffs(kb), R = FIELD_PX * 0.3;
      let s = 0, m = 0;
      for (let j = -R; j <= R; j += 2) for (let i = -R; i <= R; i += 2) {
        if (i * i + j * j > R * R) continue;
        const ir = Math.round(rb + j), ic = Math.round(cx + i);
        if (ir < 0 || ir >= H || ic < 0 || ic >= W) { s += 1; m++; continue; }
        const b = base[ir * W + ic];
        let t = 0; for (const c of K) t += c.w * Math.exp(-c.s * b);
        s += t; m++;
      }
      v = s / m; abcMemo.set(key, v);
    }
    return v;
  }

  // the patient's frame <-> the image (cm, the meshes' frame before they are placed)
  const colOf = (x) => (IMG.X0 - x) / IMG.CM - 0.5;
  const rowOf = (z) => (IMG.Z0 - z) / IMG.CM - 0.5;
  const xOf = (c) => IMG.X0 - (c + 0.5) * IMG.CM;
  const zOf = (r) => IMG.Z0 - (r + 0.5) * IMG.CM;

  return { IMG, FIELD_PX, base, oes, sto, art, coeffs, frame, display, winOf: () => lastWin, blit, toScreen, toOff, meanT, lines, colOf, rowOf, xOf, zOf };
}

/* A cache of frames by key (the pulse they belong to): a frame changes only when a new pulse lands,
   not every animation frame. */
export function frameCache(max = 48) {
  const m = new Map();
  return (key, make) => {
    let v = m.get(key);
    if (v === undefined) {
      v = make();
      m.set(key, v);
      if (m.size > max) m.delete(m.keys().next().value);
    }
    return v;
  };
}

/* A point a fraction f (0..1) of the way along a polyline of [c, r, ...] points, and the polyline
   up to it (a wire advanced that far). */
export function along(pts, f) {
  if (!pts.length) return { at: [0, 0], upto: [] };
  let L = 0;
  const seg = [];
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); L += d; }
  let want = Math.max(0, Math.min(1, f)) * L;
  const upto = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (want <= seg[i - 1]) {
      const k = seg[i - 1] ? want / seg[i - 1] : 0, p = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k];
      upto.push(p);
      return { at: p, upto };
    }
    want -= seg[i - 1];
    upto.push(pts[i]);
  }
  return { at: pts[pts.length - 1], upto };
}
