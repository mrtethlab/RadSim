/* CT FILM: slice thickness and reconstruction interval, worked on the model's own volume.
   Along z the model is layers 2 mm deep. An image of nominal thickness T centred at z averages
   the layers its (rectangular) slice profile covers, each by its overlap; its noise is the
   layers' own (independent from layer to layer, so it falls as 1/sqrt(T)) averaged the same way,
   which also makes overlapping images share their noise, as they share their data. A reformat
   along z samples the images at each row, linearly between the two nearest: so its sharpness
   along z is the images' thickness, and its smoothness their spacing.
     coronal(T, I)   the coronal through the aorta (ct_cor) rebuilt from images T mm thick every
                     I mm (HU, 209 x 356, rows head first)
     axial(T)        the lower chest (the slab) as one image T mm thick at z 236 (HU, 209 x 165)
   SIGMA: the noise of a 5 mm image, HU (a body protocol's); thinner and thicker scale from it. */
import { huOfIds, grain, sspWeights } from './simct.js';

export const SIGMA5 = 10;
const LAYER = 2;                                         // mm
// a single layer's noise, so that an image 5 mm thick centred on a layer has SIGMA5
const SIG2 = SIGMA5 / Math.sqrt([0.5, 2, 2, 0.5].reduce((s, v) => s + (v / 5) ** 2, 0));
// the noise of an image T mm thick centred on a layer (what the readouts quote)
export function sigmaOf(T) {
  const zs = []; for (let z = -LAYER * Math.ceil(T / 4 + 1); z <= LAYER * Math.ceil(T / 4 + 1); z += LAYER) zs.push(z);
  return SIG2 * Math.sqrt(sspWeights(0, T, zs).reduce((s, v) => s + v * v, 0));
}

export function zaxis(I, slices, zTop) {
  const cor = I.cor, W = cor.w, H = cor.h, hu = huOfIds(cor), nz = grain(W * H, W, 61);
  const cache = new Map();
  /* The coronal rebuilt: images at z_k = z0 + k I (mm from the top of the volume, layer r centred
     at 2r + 1), each the layers' weighted mean; each output row read between the nearest two. */
  function coronal(T, I_, z0 = 1) {
    const key = `c${T}/${I_}/${z0}`;
    if (cache.has(key)) return cache.get(key);
    const zc = Array.from({ length: H }, (_, r) => LAYER * r + 1);
    const n = Math.floor((zc[H - 1] - z0) / I_) + 1, imgs = [];
    for (let k = 0; k < n; k++) {
      const z = z0 + k * I_, r0 = Math.max(0, Math.floor((z - T / 2 - 1) / LAYER)), r1 = Math.min(H - 1, Math.ceil((z + T / 2 - 1) / LAYER));
      const rs = [], ws = sspWeights(z, T, zc.slice(r0, r1 + 1));
      for (let r = r0; r <= r1; r++) rs.push(r);
      const row = new Float32Array(W);
      for (let x = 0; x < W; x++) { let s = 0; rs.forEach((r, j) => { s += ws[j] * (hu[r * W + x] + (cor.ids[r * W + x] ? SIG2 * nz[r * W + x] : 0)); }); row[x] = s; }
      imgs.push({ z, row });
    }
    const out = new Float32Array(W * H);
    for (let r = 0; r < H; r++) {
      const z = zc[r], f = (z - z0) / I_, k = Math.max(0, Math.min(n - 2, Math.floor(f))), t = Math.max(0, Math.min(1, f - k));
      const A = imgs[k].row, B = imgs[Math.min(n - 1, k + 1)].row;
      for (let x = 0; x < W; x++) out[r * W + x] = A[x] * (1 - t) + B[x] * t;
    }
    const res = { img: out, w: W, h: H, n, zs: imgs.map((m) => m.z) };
    cache.set(key, res);
    return res;
  }
  // the slab's layers as HU, with their own noise fields (seeded by z)
  const sl = new Map();
  const layer = (z) => {
    if (!sl.has(z)) { const im = slices[zTop - z]; sl.set(z, { im, hu: huOfIds(im), nz: grain(im.w * im.h, im.w, 300 + z) }); }
    return sl.get(z);
  };
  /* One axial image T mm thick centred on layer zc (z counts layers, 2 mm each). */
  function axial(T, zc = 236) {
    const key = `a${T}/${zc}`;
    if (cache.has(key)) return cache.get(key);
    const zs = []; for (let z = zc - Math.ceil(T / 4) - 1; z <= zc + Math.ceil(T / 4) + 1; z++) zs.push(z);
    const ws = sspWeights(zc * LAYER, T, zs.map((z) => z * LAYER));
    const first = layer(zc).im, n = first.w * first.h, out = new Float32Array(n);
    zs.forEach((z, j) => {
      if (!ws[j]) return;
      const L = layer(z);
      for (let i = 0; i < n; i++) out[i] += ws[j] * (L.hu[i] + (L.im.ids[i] ? SIG2 * L.nz[i] : 0));
    });
    const res = { img: out, w: first.w, h: first.h, sigma: sigmaOf(T) };
    cache.set(key, res);
    return res;
  }
  return { coronal, axial, cor };
}
