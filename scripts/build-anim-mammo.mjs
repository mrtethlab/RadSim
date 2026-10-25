/* The mammography film's images, cast through the console's own projector (apps/web/src/mammo.js
   castMammo + positionedData, the same code the mode and its tests run):

       node scripts/build-anim-mammo.mjs     -> apps/web/public/anim/mammo_*.png + mammo.json

   - mammo_<subject>_<view>.png: the fatty ('breast') and dense ('breastdense') phantoms, CC and
     MLO, well positioned, the demo case's findings planted (a microcalcification cluster, a
     circumscribed mass, a spiculated mass), Mo/Mo 28 kV under AEC, displayed as the console does
     (log, the tissue's median/IQR window, dense = white; the dense phantom in the fatty one's
     window, so its density shows), area-averaged to half resolution
     (0.49 mm pixels: 470 x 300).
   - mammo_calc.png: the CC's calcification cluster at the detector's full resolution (0.245 mm).
   - mammo_raw_cc.png: the CC's raw detector signal (transmission, 8 bits): flat, inverted.
   - mammo_dbt_<k>.png: tomosynthesis slices of the fatty phantom by shift-and-add over a 15 degree
     sweep (9 projections), with a high-pass standing in for the reconstruction's filter.
   - mammo.json: where the landmarks fell (nipple, PNL, pectoral border, the findings), in image
     pixels, for the film to point at, and the dose of each view. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { castMammo, positionedData } from '../apps/web/src/mammo.js';
import { patientFor, nippleTiltDeg, measureView } from '../apps/web/src/core/mammoPosition.js';
import { relativeOutput, agdMGy } from '../apps/web/src/core/mammoDose.js';

const ROOT = new URL('../apps/web/public/', import.meta.url);
const OUT = new URL('anim/', ROOT);
mkdirSync(OUT, { recursive: true });

// ---- a grey PNG, no dependencies
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
}
function png(file, w, h, grey) {            // grey: 0..1 per pixel, row-major
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = Math.round(Math.min(1, Math.max(0, grey[y * w + x])) * 255);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  writeFileSync(new URL(file, OUT), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
  console.log(file, w + 'x' + h);
}
const half = (a, w, h) => {                 // area-average by 2
  const W = w >> 1, H = h >> 1, o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = 2 * y * w + 2 * x; o[y * W + x] = (a[i] + a[i + 1] + a[i + w] + a[i + w + 1]) / 4;
  }
  return o;
};

// ---- the console's display: log signal, attenuation up, the tissue's own window (mammo.js drawMammo)
function display(img, win = null) {
  const a = new Float32Array(img.length);
  let mx = 0;
  for (let k = 0; k < img.length; k++) { a[k] = Math.log(1 + Math.max(0, img[k])); if (a[k] > mx) mx = a[k]; }
  const att = a.map((v) => mx - v);
  if (!win) {
    const tis = [];
    for (let k = 0; k < att.length; k += 7) if (att[k] > 0.12 * mx) tis.push(att[k]);
    tis.sort((p, q) => p - q);
    const med = tis[tis.length >> 1], iqr = tis[(tis.length * 0.75) | 0] - tis[(tis.length * 0.25) | 0];
    const lo = med - Math.max(2.6 * iqr, 0.03), hi = med + Math.max(4.5 * iqr, 0.06);
    win = { lo, span: Math.max(hi - lo, 0.06) };
  }
  const out = att.map((v) => Math.pow(Math.min(1, Math.max(0, (v - win.lo) / win.span)), 0.85));
  out.win = win;
  return out;
}

// ---- the subjects
function loadVm(name) {
  const dir = new URL(`models/${name}/`, ROOT);
  const hdr = JSON.parse(readFileSync(new URL(`${name}.model.json`, dir)));
  return { dims: hdr.dims, vs: hdr.spacing.map((s) => s / 10), data: new Uint8Array(readFileSync(new URL(hdr.volume, dir))),
    extentMM: hdr.dims.map((n, k) => n * hdr.spacing[k]) };
}
// the demo case's findings, as mammo.js caseFindings places them (anatomy cm)
function findings(vm) {
  let s = 1013904223;
  for (const ch of 'demo') s = (s * 1103515245 + ch.charCodeAt(0) * 7919) & 0x7fffffff;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const ex = vm.extentMM[0] / 10, ey = vm.extentMM[1] / 10, ez = vm.extentMM[2] / 10;
  const C = [ex / 2, 0, ez / 2], A = [ex * 0.425, ey * 0.907, ez * 0.458];
  const place = () => { const u = 0.30 + 0.42 * rnd(), th = rnd() * 2 * Math.PI;
    return [C[0] + Math.cos(th) * u * A[0], (0.28 + 0.34 * rnd()) * A[1], C[2] + Math.sin(th) * u * A[2] * 0.85]; };
  const finds = [], centres = {};
  for (const kind of ['specks', 'mass', 'spic']) {
    const p = place(); centres[kind] = p;
    if (kind === 'specks') {
      for (let i = 0; i < 13; i++) {
        const v = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], L = Math.hypot(...v) || 1, k = 0.44 * Math.cbrt(rnd()) / L;
        finds.push({ x: p[0] + v[0] * k, y: p[1] + v[1] * k, z: p[2] + v[2] * k, r: 0.016 + 0.009 * rnd(), m: 21 });
      }
    } else if (kind === 'mass') finds.push({ x: p[0], y: p[1], z: p[2], r: 0.42 + 0.12 * rnd(), m: 10 });
    else {
      const r0 = 0.40 + 0.10 * rnd();
      finds.push({ x: p[0], y: p[1], z: p[2], r: r0, m: 10 });
      for (let i = 0; i < 11; i++) {
        const v = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], L = Math.hypot(...v) || 1;
        for (let t = 1; t <= 5; t++) { const d = r0 + t * 0.17; finds.push({ x: p[0] + v[0] / L * d, y: p[1] + v[1] / L * d, z: p[2] + v[2] / L * d, r: 0.05, m: 10 }); }
      }
    }
  }
  return { finds, centres };
}

const SID = 65, KV = 28, C = 4.5 / 7.2;                     // a 4.5 cm compressed breast
const E = [0.58 * KV, 17.5, 19.6], W = [0.32, 0.45, 0.23];    // Mo/Mo (mammo.js beamBins)
const pat = patientFor('demo');
const POS = { cc: { pull: 1, lift: pat.imfOpt, rot: 0.05, roll: 0 }, mlo: { pull: 1, lift: 0.8, angle: pat.pecDeg, roll: 0 } };
const WIN = {};                                              // the fatty breast's window, kept for the dense one:
                                                              // the same window, so density shows as density
const meta = { kv: KV, tf: 'Mo/Mo', thicknessCm: 4.5, views: {} };

// a point in anatomy cm -> the CC detector's pixel (mammo.js castMammo's affine, no rotation)
function ccPixel(vm, p, lossCm, NX, NY, fovX, fovY) {
  const lat = 1 / Math.sqrt(C), ex = vm.extentMM[0] / 10, ey = vm.extentMM[1] / 10, ez = vm.extentMM[2] / 10;
  const pm = [(p[0] - ex / 2) * lat, (p[1] - lossCm - ey / 2) * lat + (ey / 2) * lat, (p[2] - ez / 2) * C + (ez * C) / 2];
  const k = SID / (SID - pm[2]);
  const x = pm[0] * k, y = 0.5 + (pm[1] - 0.5) * k;
  return [(x / fovX + 0.5) * NX, (y / fovY) * NY];
}

for (const subject of ['breast', 'breastdense']) {
  const vm = loadVm(subject);
  const { finds, centres } = findings(vm);
  for (const view of ['cc', 'mlo']) {
    const pos = POS[view], angleDeg = POS.mlo.angle;
    const data = positionedData(vm, view, pat, nippleTiltDeg(view, pos, pat), angleDeg, pos);
    const out = relativeOutput('momo', KV);
    let r = castMammo({ vm, data: new Uint8Array(data), view, angleDeg, c: C, E, w: W, photons0: 900 * 60 * out, finds, pos, pat, seed: 11 });
    // AEC as the console does it: the metered cell to 4,000 photons a pixel
    const tMean = r.aecSum / r.aecCnt, mas = Math.min(400, Math.max(4, 4000 / (900 * out * tMean)));
    r = castMammo({ vm, data: new Uint8Array(data), view, angleDeg, c: C, E, w: W, photons0: 900 * mas * out, finds, pos, pat, seed: 11 });
    const disp = display(r.img, WIN[view]);
    WIN[view] = disp.win;
    const m = measureView({ view, nx: r.NX, ny: r.NY, fovX: r.fovX, fovY: r.fovY, ...r.maps });
    const H = half(disp, r.NX, r.NY);
    png(`mammo_${subject}_${view}.png`, r.NX >> 1, r.NY >> 1, H);
    // detector cm -> half-resolution pixels
    const P = ([u, y]) => [Math.round(((u / r.fovX + 0.5) * r.NX) / 2 * 10) / 10, Math.round((y / r.fovY) * r.NY / 2 * 10) / 10];
    const v = {
      w: r.NX >> 1, h: r.NY >> 1, pixelMm: (r.fovX / (r.NX >> 1)) * 10, mas: Math.round(mas * 10) / 10,
      agdMGy: Math.round(agdMGy({ tf: 'momo', kv: KV, mas, tCm: 4.5 }).agd * 100) / 100,
      nipple: m.nipple ? P([m.nipple.u, m.nipple.y]) : null,
      pnl: { from: P(m.pnl.from), to: P(m.pnl.to), cm: Math.round(m.pnl.cm * 10) / 10 },
      muscle: m.muscle ? { tip: P([m.muscle.uTip, Math.max(0, m.muscle.a + m.muscle.b * m.muscle.uTip)]), top: P([m.muscle.uTop, m.muscle.a + m.muscle.b * m.muscle.uTop]) } : null,
    };
    if (view === 'cc') {
      const loss = 0.15;                                    // edgeLossCm at pull 1, lift at the fold's optimum, centre line
      v.finds = Object.fromEntries(Object.entries(centres).map(([k, p]) => [k, ccPixel(vm, p, loss, r.NX, r.NY, r.fovX, r.fovY).map((q) => Math.round(q / 2 * 10) / 10)]));
      if (subject === 'breast') {
        // the cluster at full resolution, and the raw signal
        const [cx, cy] = ccPixel(vm, centres.specks, loss, r.NX, r.NY, r.fovX, r.fovY).map(Math.round);
        const S = 72, x0 = Math.max(0, Math.min(r.NX - S, cx - S / 2)), y0 = Math.max(0, Math.min(r.NY - S, cy - S / 2));
        const crop = new Float32Array(S * S);
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) crop[y * S + x] = disp[(y0 + y) * r.NX + x0 + x];
        png('mammo_calc.png', S, S, crop);
        v.calcCrop = { x0: x0 / 2, y0: y0 / 2, size: S / 2, fullPixelMm: (r.fovX / r.NX) * 10 };
        let mx = 0; for (const q of r.img) mx = Math.max(mx, q);
        png('mammo_raw_cc.png', r.NX >> 1, r.NY >> 1, half(r.img.map((q) => q / mx), r.NX, r.NY));
      }
    }
    meta.views[`${subject}_${view}`] = v;
    console.log(subject, view, 'mAs', v.mas, 'AGD', v.agdMGy, 'PNL', v.pnl.cm);
  }
}

/* ---- tomosynthesis: shift-and-add over the sweep, through the uncompressed fatty phantom.
   Each projection at angle a sees layer z shifted by z tan(a) along the sweep (x); a slice at
   depth zk shifts every projection back by zk tan(a) and averages, so layer zk adds up in
   register and every other layer is smeared by (z - zk) tan(a). Low frequencies (the whole
   stack's sum) are taken out as filtered back-projection does, so the slice shows its own plane. */
{
  const vm = loadVm('breast');
  const { finds } = findings(vm);
  const [nx, ny, nz] = vm.dims, s = vm.extentMM[0] / nx / 10;      // cm per voxel
  const MU = { 0: 0, 2: 0.53, 53: 0.79, 23: 0.84, 7: 0.82, 10: 0.81, 21: 13.7 };   // cm^-1 at 20 keV (mammo.js MU_LOW)
  const data = new Uint8Array(vm.data);
  for (const f of finds) {                                  // plant them (at least a voxel: the slices are 0.8 mm)
    const R = Math.max(f.r, s * 0.9), i0 = Math.floor((f.x - R) / s), i1 = Math.ceil((f.x + R) / s);
    for (let k = Math.floor((f.z - R) / s); k <= Math.ceil((f.z + R) / s); k++) for (let j = Math.floor((f.y - R) / s); j <= Math.ceil((f.y + R) / s); j++)
      for (let i = i0; i <= i1; i++) {
        if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
        if (((i + 0.5) * s - f.x) ** 2 + ((j + 0.5) * s - f.y) ** 2 + ((k + 0.5) * s - f.z) ** 2 <= R * R) data[i + nx * (j + ny * k)] = f.m;
      }
  }
  // layers at half resolution in x and y (0.8 mm), each the mu-length through its voxel
  const X = nx >> 1, Y = ny >> 1, L = new Float32Array(X * Y * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < Y * 2; j++) for (let i = 0; i < X * 2; i++)
    L[k * X * Y + (j >> 1) * X + (i >> 1)] += (MU[data[i + nx * (j + ny * k)]] ?? 0.8) * s / 4;
  const angles = Array.from({ length: 9 }, (_, a) => (-7.5 + a * 15 / 8) * Math.PI / 180);
  const slices = [0.22, 0.36, 0.5, 0.64, 0.78].map((f) => Math.round(f * nz));
  const blur = (a, w, h, r) => {                             // a box blur, twice (near gaussian)
    let o = a;
    for (let p = 0; p < 2; p++) {
      const t = new Float32Array(w * h), u = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let acc = 0, n = 0; for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < w) { acc += o[y * w + xx]; n++; } } t[y * w + x] = acc / n; }
      for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) { let acc = 0, n = 0; for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < h) { acc += t[yy * w + x]; n++; } } u[y * w + x] = acc / n; }
      o = u;
    }
    return o;
  };
  const vox = s * 2;                                         // cm per slice pixel
  meta.dbt = { w: X, h: Y, slices: [], sweepDeg: 15, projections: 9 };
  slices.forEach((zk, n) => {
    const img = new Float32Array(X * Y);
    for (const a of angles) {
      const ta = Math.tan(a);
      for (let k = 0; k < nz; k++) {
        const sh = ((k - zk) * s * ta) / vox, i0 = Math.floor(sh), f = sh - i0, base = k * X * Y;
        for (let j = 0; j < Y; j++) for (let i = 0; i < X; i++) {
          const q = i + i0;
          if (q < 0 || q + 1 >= X) continue;
          img[j * X + i] += (L[base + j * X + q] * (1 - f) + L[base + j * X + q + 1] * f) / angles.length;
        }
      }
    }
    const lo = blur(img, X, Y, 9);
    const hp = img.map((v, k) => v - 0.9 * lo[k]);
    const tis = [...hp].filter((_, k) => img[k] > 0.4).sort((p, q) => p - q);
    const a0 = tis[(tis.length * 0.01) | 0], a1 = tis[(tis.length * 0.999) | 0];
    png(`mammo_dbt_${n}.png`, X, Y, hp.map((v, k) => (img[k] > 0.4 ? (v - a0) / (a1 - a0) : 0)));
    meta.dbt.slices.push(Math.round(zk * s * 10) / 10);
  });
  meta.dbt.finds = Object.fromEntries(Object.entries(findings(vm).centres).map(([k, p]) => [k, [Math.round(p[0] / vox), Math.round(p[1] / vox), Math.round(p[2] * 10) / 10]]));
}
writeFileSync(new URL('mammo.json', OUT), JSON.stringify(meta, null, 1));
console.log('mammo.json');
