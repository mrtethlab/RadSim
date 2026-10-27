/* ============================================================================
   PATHOLOGY — a lesion stamped into the material volume for an exposure, then taken out.

   The Protocol Trainer's patient may have something wrong with them, and the films have to show
   it where a real film would: a scaphoid waist fracture crisp on the scaphoid view and a faint
   blur on the PA, air-fluid levels on the erect abdomen and none on the supine. Nothing here
   decides what a view sees. The lesion is written into the label volume (S.voxelModel.data,
   x-fastest, as core/voxelPhantom.js reads it) and the ray-caster does the rest: a fracture
   plane is a line only where the beam runs along it, a fluid level only where the beam runs
   across the interface. Every write is recorded with the value it replaced, so the scanned
   volume comes back byte for byte.

   THE ANATOMY IS FOUND ON THE VOLUME. The landmarks, centring points and joint centres (data/*.json)
   say roughly where to look; the bone, lung, kidney or bowel is then found in the voxels around
   that point, as core/fracture.js finds the fibula. Coordinates are voxel indices [i, j, k] on the
   volume's own axes, or cm along them (index x spacing); directions are worked out per model:
     hand            -i radial (the thumb), -j dorsal, +k distal (a right hand)
     upper/lower ext. right limbs; +k proximal; which way is lateral is read off the bones
     trunk models    the patient's right is the liver's side, anterior the heart's side, +k superior
   The rest frame of the centring points and joint centres is the volume flipped by the x-ray
   room's flips (app.js voxelFlips), cm from the volume centre; ctx.flips carries them.

   WHAT IS NEVER TOUCHED: cartilage and the joint spaces. Osteophytes are added outside the
   joint; a fragment that moves leaves the cartilage where it was; nothing narrows a joint.

   Each lesion touches a small box: a fracture a few cm of one bone, a stone a centimetre, a
   pneumothorax one hemithorax's rim. The few that read a whole organ (the lung, the bowel)
   read it on a box found from a coarse pass first.
   ============================================================================ */

import { BONE, SOFT, findFibula, fractureFragment, fragmentMove, boxSave, stampFragment } from './fracture.js';
import { segmentFemur } from './limbPose.js';

export { BONE, SOFT };
const CART = 16;                              // cartilage: never written
const AIR = 0, LUNG = 1, FAT = 2, MUSCLE = 7, FLUID = 5, SKIN = 23;
const TRAB = 17, CORT = 18, CALC = 21, STONE = 22, TITANIUM = 25, STEEL = 26;
const GAS = 47, SB = 51, COLON = 52, KIDNEY = 13, LIVER = 11, HEART = 15;
const SOFTISH = new Set([FAT, MUSCLE, SOFT, 3, 5, 8, 9, 23]);   // what new bone may grow into

/* ---------------------------------------------------------------------------
   The record of a stamp: the first value each voxel had, kept once. A bit per voxel says which
   are kept (5 MB for the 40 M voxel chest), the record itself grows in typed arrays: a cast
   writes a million voxels, and a Map of a million entries took most of a second. */
class Edit {
  constructor(data) { this.d = data; this.bits = new Uint32Array((data.length >>> 5) + 1); this.n = 0; this.idx = new Int32Array(4096); this.old = new Uint8Array(4096); }
  keep(o, was) {
    const w = o >>> 5, b = 1 << (o & 31);
    if (this.bits[w] & b) return;
    this.bits[w] |= b;
    if (this.n === this.idx.length) {
      const i2 = new Int32Array(this.n * 2), o2 = new Uint8Array(this.n * 2);
      i2.set(this.idx); o2.set(this.old); this.idx = i2; this.old = o2;
    }
    this.idx[this.n] = o; this.old[this.n++] = was;
  }
  set(o, v) {
    const d = this.d, was = d[o];
    if (was === v || was === CART) return;
    this.keep(o, was);
    d[o] = v;
  }
  // a voxel some other code changed: keep what it was before
  adopt(o, was) { this.keep(o, was); }
  finish() {
    // only the voxels that changed in the end (one written and written back is not a change)
    let m = 0;
    for (let q = 0; q < this.n; q++) if (this.d[this.idx[q]] !== this.old[q]) { this.idx[m] = this.idx[q]; this.old[m++] = this.old[q]; }
    return { idx: this.idx.slice(0, m), old: this.old.slice(0, m) };
  }
}

/* ---------------------------------------------------------------------------
   small vector and volume helpers (cm unless named voxel) */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const nrm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const orth = (v, n) => nrm(sub(v, mul(n, dot(v, n))));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
function rotMat(e, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c, [x, y, z] = e;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}
const mv = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
const mtv = (R, v) => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];

export const spacing = (vol) => vol.spacingMM.map((s) => s / 10);
const toCm = (vol, v) => { const s = spacing(vol); return [v[0] * s[0], v[1] * s[1], v[2] * s[2]]; };
const toVox = (vol, p) => { const s = spacing(vol); return [p[0] / s[0], p[1] / s[1], p[2] / s[2]]; };
const ijk = (o, nx, ny) => [o % nx, ((o / nx) | 0) % ny, Math.floor(o / (nx * ny))];
/* the box of voxels within r cm (or [rx, ry, rz]) of a point (cm), clipped to the volume */
function boxR(vol, c, r) {
  const s = spacing(vol), rr = Array.isArray(r) ? r : [r, r, r];
  return [0, 1, 2].map((a) => [Math.max(0, Math.floor((c[a] - rr[a]) / s[a])), Math.min(vol.dims[a] - 1, Math.ceil((c[a] + rr[a]) / s[a]))]);
}
const boxSize = (B) => (B[0][1] - B[0][0] + 1) * (B[1][1] - B[1][0] + 1) * (B[2][1] - B[2][0] + 1);
/* visit every voxel of a box: fn(i, j, k, o, p) with p its centre in cm */
function forBox(vol, B, fn) {
  const [nx, ny] = vol.dims, s = spacing(vol), p = [0, 0, 0];
  for (let k = B[2][0]; k <= B[2][1]; k++) {
    p[2] = k * s[2];
    for (let j = B[1][0]; j <= B[1][1]; j++) {
      p[1] = j * s[1];
      let o = (k * ny + j) * nx + B[0][0];
      for (let i = B[0][0]; i <= B[0][1]; i++, o++) { p[0] = i * s[0]; fn(i, j, k, o, p); }
    }
  }
}

/* A smooth, repeatable noise in [-1, 1]: a hashed lattice blended trilinearly, the lattice
   `cell` cm apart. Fracture edges, erosion rims and mottled stool are drawn from it. */
function hash3(x, y, z, seed) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 974711) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) & 0xffff) / 32767.5 - 1;
}
export function noise3(p, cell, seed = 1) {
  const x = p[0] / cell, y = p[1] / cell, z = p[2] / cell;
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = smooth(x - x0), fy = smooth(y - y0), fz = smooth(z - z0);
  let v = 0;
  for (let c = 0; c < 8; c++) {
    const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
    v += hash3(x0 + dx, y0 + dy, z0 + dz, seed) * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
  }
  return v;
}

/* The principal axes of a set of points (cm): centroid, and the eigenvectors of their spread,
   longest first (Jacobi on the 3x3). */
export function principalAxes(pts) {
  const n = pts.length / 3, c = [0, 0, 0];
  for (let q = 0; q < pts.length; q += 3) { c[0] += pts[q]; c[1] += pts[q + 1]; c[2] += pts[q + 2]; }
  c[0] /= n; c[1] /= n; c[2] /= n;
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let q = 0; q < pts.length; q += 3) {
    const d = [pts[q] - c[0], pts[q + 1] - c[1], pts[q + 2] - c[2]];
    for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) A[r * 3 + s] += d[r] * d[s] / n;
  }
  const V = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 30; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = A[p * 3 + q];
      if (Math.abs(apq) < 1e-12) continue;
      const th = 0.5 * Math.atan2(2 * apq, A[q * 3 + q] - A[p * 3 + p]);
      const cs = Math.cos(th), sn = Math.sin(th);
      for (let k = 0; k < 3; k++) {
        const akp = A[k * 3 + p], akq = A[k * 3 + q];
        A[k * 3 + p] = cs * akp - sn * akq; A[k * 3 + q] = sn * akp + cs * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = A[p * 3 + k], aqk = A[q * 3 + k];
        A[p * 3 + k] = cs * apk - sn * aqk; A[q * 3 + k] = sn * apk + cs * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k * 3 + p], vkq = V[k * 3 + q];
        V[k * 3 + p] = cs * vkp - sn * vkq; V[k * 3 + q] = sn * vkp + cs * vkq;
      }
    }
  }
  const ev = [0, 1, 2].map((a) => ({ l: A[a * 3 + a], v: nrm([V[a], V[3 + a], V[6 + a]]) })).sort((a, b) => b.l - a.l);
  return { c, axes: ev.map((e) => e.v), sd: ev.map((e) => Math.sqrt(Math.max(0, e.l))) };
}

/* ---------------------------------------------------------------------------
   ONE BONE near a point. The bone within r cm of the anchor, its marrow filled in slice by
   slice (a cortex is a ring the segmentation fills with soft tissue or fat, and a fracture
   through it has to know the inside from the outside), split from its neighbours where they
   touch: eroded until the bridges go, the core nearest the anchor kept, and grown back through
   the bone by a race from every core at once, so each voxel goes to the bone it is nearest
   along the bone (core/fracture.js split, in three dimensions).
   Returns { B (box), w, h, mask (box-local, 1 = this bone), list (global indices), pts (cm) }. */
export function boneNear(vol, anchorCm, { r = 2.5, erodeCm = 0.1, fillAxis = 2, mats = BONE, minCm3 = 0.03 } = {}) {
  const [nx, ny] = vol.dims, d = vol.data, s = spacing(vol);
  const B = boxR(vol, anchorCm, r);
  const W = B[0][1] - B[0][0] + 1, H = B[1][1] - B[1][0] + 1, D = B[2][1] - B[2][0] + 1;
  const L = (i, j, k) => ((k - B[2][0]) * H + (j - B[1][0])) * W + (i - B[0][0]);
  const m = new Uint8Array(W * H * D);
  const r2 = r * r;
  forBox(vol, B, (i, j, k, o, p) => {
    if (!mats.has(d[o])) return;
    const dx = p[0] - anchorCm[0], dy = p[1] - anchorCm[1], dz = p[2] - anchorCm[2];
    if (dx * dx + dy * dy + dz * dz <= r2) m[L(i, j, k)] = 1;
  });
  fillSlices(m, [W, H, D], fillAxis);
  // the bone voxel nearest the anchor
  let best = -1, bd = Infinity;
  forBox(vol, B, (i, j, k, o, p) => {
    const q = L(i, j, k); if (!m[q]) return;
    const dd = (p[0] - anchorCm[0]) ** 2 + (p[1] - anchorCm[1]) ** 2 + (p[2] - anchorCm[2]) ** 2;
    if (dd < bd) { bd = dd; best = q; }
  });
  if (best < 0) return null;
  const n = W * H * D, nb = [1, -1, W, -W, W * H, -W * H];
  const inside = (q, t) => { const x = q % W, y = ((q / W) | 0) % H, z = (q / (W * H)) | 0;
    return !((t === 0 && x === W - 1) || (t === 1 && x === 0) || (t === 2 && y === H - 1) || (t === 3 && y === 0) || (t === 4 && z === D - 1) || (t === 5 && z === 0)); };
  let rE = Math.max(1, Math.round(erodeCm / Math.min(...s)));
  let lab, seedCore;
  for (; rE >= 0; rE--) {
    // erode rE times (6-neighbourhood)
    let E = m;
    for (let t = 0; t < rE; t++) {
      const e = new Uint8Array(n);
      for (let q = 0; q < n; q++) {
        if (!E[q]) continue;
        let all = 1;
        for (let a = 0; a < 6 && all; a++) if (!inside(q, a) || !E[q + nb[a]]) all = 0;
        e[q] = all;
      }
      E = e;
    }
    // cores, labelled
    lab = new Int32Array(n);
    let tag = 0;
    const cores = [];
    for (let q0 = 0; q0 < n; q0++) {
      if (!E[q0] || lab[q0]) continue;
      const c = [q0]; lab[q0] = ++tag;
      for (let h = 0; h < c.length; h++) for (let a = 0; a < 6; a++) {
        const q = c[h]; if (!inside(q, a)) continue;
        const t = q + nb[a]; if (E[t] && !lab[t]) { lab[t] = tag; c.push(t); }
      }
      cores.push(c);
    }
    if (!cores.length) continue;
    // the race back out through the bone
    const front = cores.flat();
    for (let h = 0; h < front.length; h++) for (let a = 0; a < 6; a++) {
      const q = front[h]; if (!inside(q, a)) continue;
      const t = q + nb[a]; if (m[t] && !lab[t]) { lab[t] = lab[q]; front.push(t); }
    }
    // the piece nearest the anchor among those big enough to be a bone (a speck of the
    // segmentation's noise, or a sesamoid, is not what the anchor means)
    const size = new Int32Array(tag + 1), near = new Float64Array(tag + 1).fill(Infinity);
    for (let q = 0; q < n; q++) {
      const l = lab[q]; if (!l) continue;
      size[l]++;
      const x = q % W + B[0][0], y = ((q / W) | 0) % H + B[1][0], z = ((q / (W * H)) | 0) + B[2][0];
      const dd = (x * s[0] - anchorCm[0]) ** 2 + (y * s[1] - anchorCm[1]) ** 2 + (z * s[2] - anchorCm[2]) ** 2;
      if (dd < near[l]) near[l] = dd;
    }
    const minVox = minCm3 / (s[0] * s[1] * s[2]);
    seedCore = 0;
    for (let l = 1; l <= tag; l++) if (size[l] >= minVox && (!seedCore || near[l] < near[seedCore])) seedCore = l;
    if (!seedCore) seedCore = lab[best];
    if (seedCore) break;
  }
  if (!seedCore) return null;
  const mask = new Uint8Array(n), list = [], pts = [];
  for (let q = 0; q < n; q++) {
    if (lab[q] !== seedCore) continue;
    mask[q] = 1;
    const x = q % W + B[0][0], y = ((q / W) | 0) % H + B[1][0], z = ((q / (W * H)) | 0) + B[2][0];
    list.push((z * ny + y) * nx + x); pts.push(x * s[0], y * s[1], z * s[2]);
  }
  return { B, W, H, D, mask, list: Int32Array.from(list), pts: Float32Array.from(pts),
    has: (o) => { const [i, j, k] = ijk(o, nx, ny);
      return i >= B[0][0] && i <= B[0][1] && j >= B[1][0] && j <= B[1][1] && k >= B[2][0] && k <= B[2][1] && mask[L(i, j, k)] === 1; } };
}
/* Fill a mask's holes slice by slice across `axis`: whatever the slice's edge cannot reach
   through the unmasked is inside. */
function fillSlices(m, [W, H, D], axis) {
  const dims = [W, H, D], [ua, va] = [0, 1, 2].filter((a) => a !== axis);
  const U = dims[ua], V = dims[va], st = [1, W, W * H], su = st[ua], sv = st[va];
  // the slice copied out flat (q = u + U v), flooded from its edge with a typed stack
  const seen = new Uint8Array(U * V), sl = new Uint8Array(U * V), stack = new Int32Array(U * V);
  for (let c = 0; c < dims[axis]; c++) {
    const base = c * st[axis];
    for (let v = 0; v < V; v++) for (let u = 0; u < U; u++) sl[v * U + u] = m[base + u * su + v * sv];
    seen.fill(0);
    let top = 0;
    const push = (q) => { if (!sl[q] && !seen[q]) { seen[q] = 1; stack[top++] = q; } };
    for (let u = 0; u < U; u++) { push(u); push((V - 1) * U + u); }
    for (let v = 0; v < V; v++) { push(v * U); push(v * U + U - 1); }
    while (top) {
      const q = stack[--top], u = q % U;
      if (u > 0) push(q - 1);
      if (u < U - 1) push(q + 1);
      if (q >= U) push(q - U);
      if (q < U * (V - 1)) push(q + U);
    }
    for (let v = 0; v < V; v++) for (let u = 0; u < U; u++) if (!seen[v * U + u] && !sl[v * U + u]) m[base + u * su + v * sv] = 1;
  }
}

/* ---------------------------------------------------------------------------
   A FRACTURE PLANE through one bone. The plane (point p0, unit normal n, cm) is roughened by a
   smooth in-plane wobble (a real fracture line is never ruled), and the bone within half the
   gap of it becomes soft tissue: on a film that is a line where the beam runs along the plane,
   and a blur where it crosses it, which is why the view matters.
   move (optional): the fragment on the +n side (side: 1) or the -n side (side: -1) carried by
     shift (cm), and turned by deg about axis through pivot (cm). falloff (cm): the move fades
     out over that distance from the plane, so a long bone's far end stays in its joint and the
     step shows only at the fracture; without it the fragment moves whole. weight(p) in [0, 1]
     in its place shapes the fade some other way (a condyle split: full in the condyle, none in
     the shaft below).
   The move is drawn backwards: each voxel of the box asks where its content came from, so a
   turned fragment leaves no holes. Other bones and cartilage are never written. */
export function fracturePlane(E, vol, comp, { p0, n, gap = 0.08, rough = 0.04, seed = 7, move = null }) {
  const d = vol.data, [nx, ny] = vol.dims, s = spacing(vol);
  n = nrm(n);
  const u = orth(Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], n), w = crs(n, u);
  const wob = (p) => {
    const a = dot(sub(p, p0), u), b = dot(sub(p, p0), w);
    return rough * (0.55 * Math.sin(a * 9.1 + seed) + 0.35 * Math.sin(b * 7.3 + 2 * seed) + 0.6 * noise3(p, 0.25, seed));
  };
  const sd = (p) => dot(sub(p, p0), n) + wob(p);
  const g2 = Math.max(gap, 1.05 * Math.min(...s)) / 2;
  // the gap
  for (let q = 0; q < comp.list.length; q++) {
    const o = comp.list[q];
    if (!BONE.has(d[o])) continue;
    const p = [comp.pts[3 * q], comp.pts[3 * q + 1], comp.pts[3 * q + 2]];
    if (Math.abs(sd(p)) < g2) E.set(o, SOFT);
  }
  if (!move) return;
  const side = move.side || 1;
  // the fragment: this bone's voxels (marrow with them) beyond the gap on the moving side
  const M = new Uint8Array(comp.mask.length);
  const { B, W, H } = comp;
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let q = 0; q < comp.list.length; q++) {
    const p = [comp.pts[3 * q], comp.pts[3 * q + 1], comp.pts[3 * q + 2]];
    if (side * sd(p) < g2) continue;
    const o = comp.list[q], [i, j, k] = ijk(o, nx, ny);
    M[((k - B[2][0]) * H + (j - B[1][0])) * W + (i - B[0][0])] = 1;
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); }
  }
  if (lo[0] === Infinity) return;
  const inM = (i, j, k) => i >= B[0][0] && i <= B[0][1] && j >= B[1][0] && j <= B[1][1] && k >= B[2][0] && k <= B[2][1]
    && M[((k - B[2][0]) * H + (j - B[1][0])) * W + (i - B[0][0])] === 1;
  const R = move.deg ? rotMat(nrm(move.axis), move.deg * Math.PI / 180) : null;
  const piv = move.pivot || p0, sh = move.shift || [0, 0, 0];
  const reach = len(sh) + (R ? Math.abs(move.deg) * Math.PI / 180 * Math.max(len(sub(lo, piv)), len(sub(hi, piv))) : 0) + 2 * Math.max(...s);
  const T = [0, 1, 2].map((a) => [Math.max(0, Math.floor((lo[a] - reach) / s[a])), Math.min(vol.dims[a] - 1, Math.ceil((hi[a] + reach) / s[a]))]);
  const orig = boxSave(d, vol.dims, T);
  const TW = T[0][1] - T[0][0] + 1, TH = T[1][1] - T[1][0] + 1;
  const origAt = (i, j, k) => orig[((k - T[2][0]) * TH + (j - T[1][0])) * TW + (i - T[0][0])];
  const fall = move.falloff || 0;
  const weight = move.weight || (fall ? (p) => 1 - smooth((side * sd(p) - g2) / fall) : null);
  forBox(vol, T, (i, j, k, o, p) => {
    const here = origAt(i, j, k), mine = inM(i, j, k);
    if (here === CART || (BONE.has(here) && !mine)) return;      // other bone, this bone's other side, cartilage
    // where this voxel's content came from: the inverse of the move (faded by distance, if asked)
    let q = sub(p, sh);
    if (R) q = add(piv, mtv(R, sub(q, piv)));
    if (weight) q = add(p, mul(sub(q, p), weight(p)));
    const si = Math.round(q[0] / s[0]), sj = Math.round(q[1] / s[1]), sk = Math.round(q[2] / s[2]);
    if (inM(si, sj, sk)) {
      const v = si >= T[0][0] && si <= T[0][1] && sj >= T[1][0] && sj <= T[1][1] && sk >= T[2][0] && sk <= T[2][1] ? origAt(si, sj, sk) : d[(sk * ny + sj) * nx + si];
      E.set(o, v);
    } else if (mine) E.set(o, SOFT);
  });
}

/* ---------------------------------------------------------------------------
   ADD a material inside a shape, over certain materials only (null: over anything but
   cartilage), and only where filter(index) says so when one is given. Shapes:
   { ellipsoid: { c, r: [a, b, c], axes? } } or { cylinder: { p0, p1, r (or [r0, r1], a taper) } },
   all cm. jitter (cm) roughens the surface with the noise. Returns voxels written. */
export function fillShape(E, vol, shape, mat, { over = null, jitter = 0, seed = 3, filter = null } = {}) {
  const d = vol.data;
  let inside, B;
  if (shape.ellipsoid) {
    const { c, r } = shape.ellipsoid, ax = shape.ellipsoid.axes || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const rm = Math.max(...r) + jitter;
    B = boxR(vol, c, rm);
    inside = (p) => {
      const v = sub(p, c);
      const e = (dot(v, ax[0]) / r[0]) ** 2 + (dot(v, ax[1]) / r[1]) ** 2 + (dot(v, ax[2]) / r[2]) ** 2;
      const j = jitter ? jitter * noise3(p, Math.max(0.15, Math.min(...r) * 0.7), seed) / Math.min(...r) : 0;
      return Math.sqrt(e) < 1 + j;
    };
  } else if (shape.cylinder) {
    const { p0, p1, r } = shape.cylinder, ax = sub(p1, p0), L = len(ax), e = nrm(ax);
    const rr = Array.isArray(r) ? r : [r, r];            // radius at p0 and at p1 (a taper)
    const rm = Math.max(...rr) + jitter;
    const lo = [0, 1, 2].map((a) => Math.min(p0[a], p1[a]) - rm), hi = [0, 1, 2].map((a) => Math.max(p0[a], p1[a]) + rm);
    const s = spacing(vol);
    B = [0, 1, 2].map((a) => [Math.max(0, Math.floor(lo[a] / s[a])), Math.min(vol.dims[a] - 1, Math.ceil(hi[a] / s[a]))]);
    inside = (p) => {
      const v = sub(p, p0), t = dot(v, e);
      if (t < 0 || t > L) return false;
      const rad = rr[0] + (rr[1] - rr[0]) * t / L;
      return len(sub(v, mul(e, t))) < rad + (jitter ? jitter * noise3(p, 0.3, seed) : 0);
    };
  } else return 0;
  let nW = 0;
  forBox(vol, B, (i, j, k, o, p) => {
    const here = d[o];
    if (here === CART || (over && !over.has(here)) || (filter && !filter(o))) return;
    if (!inside(p)) return;
    E.set(o, mat); nW++;
  });
  return nW;
}

/* EROSIONS: small bites of bone turned to soft tissue, each a roughened ball centred a little
   inside the bone's surface where the anchor's ray leaves it. */
export function erode(E, vol, at, { r = 0.12, depth = 0.05, seed = 5 } = {}) {
  const d = vol.data;
  for (const { p, dir } of at) {
    const q = surfaceAlong(vol, p, dir, 2.0);
    if (!q) continue;
    const c = sub(q, mul(nrm(dir), depth));
    const B = boxR(vol, c, r * 1.4);
    forBox(vol, B, (i, j, k, o, pp) => {
      if (!BONE.has(d[o])) return;
      const t = len(sub(pp, c)) / r + 0.25 * noise3(pp, r * 0.8, seed);
      if (t < 1) E.set(o, SOFT);
    });
  }
}
/* Where a ray from p (cm) along dir last leaves bone within maxCm: the bone's surface on that
   side. Null when it never meets bone. */
export function surfaceAlong(vol, p, dir, maxCm) {
  const s = spacing(vol), st = Math.min(...s) / 2, e = nrm(dir), [nx, ny, nz] = vol.dims, d = vol.data;
  let last = null, seen = false;
  for (let t = 0; t <= maxCm; t += st) {
    const q = add(p, mul(e, t));
    const i = Math.round(q[0] / s[0]), j = Math.round(q[1] / s[1]), k = Math.round(q[2] / s[2]);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) break;
    if (BONE.has(d[(k * ny + j) * nx + i])) { seen = true; last = q; } else if (seen && t - (last ? len(sub(last, p)) : 0) > 0.3) break;
  }
  return last;
}

/* OSTEOPHYTES: new bone at a joint's margin, a beak growing out from the bone's edge along
   `out` (away from the joint's centre), cortical over trabecular. Only into soft tissue and fat:
   never into cartilage, never across `keep` (a plane the joint line lies on: { p, n }, the new
   bone stays on the side of it its bone is on), so the joint space is exactly as it was. */
export function osteophyte(E, vol, { base, out, along, size = 0.35, thick = 0.18, keep = null, seed = 11 }) {
  const d = vol.data, e = nrm(out), a = nrm(along || orth([0, 0, 1], e)), b = crs(e, a);
  const B = boxR(vol, base, size + thick + 0.2);
  forBox(vol, B, (i, j, k, o, p) => {
    if (!SOFTISH.has(d[o])) return;
    const v = sub(p, base), x = dot(v, e);
    if (x < -0.05 || x > size) return;
    if (keep && dot(sub(p, keep.p), keep.n) < 0) return;
    // a beak: thick at the base, tapering to its tip, wider along the joint's rim than across it
    const taper = 1 - x / size, ra = thick * (0.4 + 1.6 * taper), rb = thick * (0.3 + 0.9 * taper);
    const rr = (dot(v, a) / ra) ** 2 + (dot(v, b) / rb) ** 2 + 0.3 * noise3(p, 0.12, seed);
    if (rr < 1) E.set(o, rr > 0.45 ? CORT : TRAB);
  });
}
/* SUBCHONDRAL SCLEROSIS: the trabecular bone under a joint surface made dense. */
export function sclerose(E, vol, comp, { p, n, depth = 0.5, mat = 59 }) {
  const d = vol.data, e = nrm(n);
  for (let q = 0; q < comp.list.length; q++) {
    const o = comp.list[q];
    const pt = [comp.pts[3 * q], comp.pts[3 * q + 1], comp.pts[3 * q + 2]];
    const x = dot(sub(pt, p), e);                             // depth into the bone from the surface plane
    if (x < 0 || x > depth) continue;
    if (len(sub(sub(pt, p), mul(e, x))) > 1.4) continue;
    if (d[o] === TRAB || (d[o] >= 54 && d[o] <= 58) || SOFTISH.has(d[o])) {
      if (noise3(pt, 0.08, 13) > 0.6 * x / depth - 0.35) E.set(o, mat);
    }
  }
}

/* ---------------------------------------------------------------------------
   THE CONTEXT a lesion is built in: the volume, and where the subject's measured points are.
     landmarks  data/landmarks.json[subject]   (volume frame, or frame 'world' = the rest frame)
     centring   data/centring.json[subject]    (rest frame)
     joints     data/joints.json[subject]      (rest frame: each joint's centre c, its distal axis)
     flips      the x-ray room's flips for the subject (app.js voxelFlips): rest = flipped volume
   Every point comes back in cm along the volume's own axes (index x spacing). */
export function makeCtx(subject, vol, { landmarks = {}, centring = {}, joints = {}, flips = [true, true, false] } = {}) {
  const s = spacing(vol), half = vol.dims.map((n, a) => (n - 1) / 2 * s[a]);
  const f = flips.map((b) => (b ? -1 : 1));
  const ctx = {
    subject, vol, landmarks, centring, joints, flips,
    // rest-frame cm (from the volume centre, flipped) -> volume cm
    rest: (p) => [f[0] * p[0] + half[0], f[1] * (p[1] || 0) + half[1], f[2] * p[2] + half[2]],
    restDir: (v) => nrm([f[0] * v[0], f[1] * v[1], f[2] * v[2]]),
    // a named point: a centring point, a landmark, or a joint's centre
    point(name) {
      const cp = centring[name];
      if (cp) return ctx.rest([cp.x, cp.y, cp.z]);
      const lm = landmarks[name];
      if (lm) return lm.frame === 'world' ? ctx.rest([lm.x || 0, lm.y || 0, lm.z]) : [lm.x + half[0], (lm.y || 0) + half[1], lm.z + half[2]];
      const jt = joints[name];
      if (jt?.c) return ctx.rest(jt.c);
      return null;
    },
    /* The trunk's own directions, read off the organs (a coarse pass): the patient's right is the
       liver's side of the body, anterior the heart's. Superior is +k on every model here. */
    trunk() {
      if (ctx._trunk) return ctx._trunk;
      const [nx, ny, nz] = vol.dims, d = vol.data, st = 3;
      const acc = { b: [0, 0, 0, 0], l: [0, 0, 0, 0], h: [0, 0, 0, 0] };
      for (let k = 0; k < nz; k += st) for (let j = 0; j < ny; j += st) for (let i = 0; i < nx; i += st) {
        const m = d[(k * ny + j) * nx + i];
        if (!m) continue;
        const t = m === LIVER ? acc.l : m === HEART ? acc.h : null;
        acc.b[0] += i; acc.b[1] += j; acc.b[2] += k; acc.b[3]++;
        if (t) { t[0] += i; t[1] += j; t[2] += k; t[3]++; }
      }
      const c = (a) => [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
      const right = acc.l[3] > 100 ? Math.sign(c(acc.l)[0] - c(acc.b)[0]) : f[0];
      const ant = acc.h[3] > 100 ? Math.sign(c(acc.h)[1] - c(acc.b)[1]) : f[1];
      return (ctx._trunk = { right: [right, 0, 0], ant: [0, ant, 0], sup: [0, 0, 1], body: toCm(vol, c(acc.b)) });
    },
  };
  return ctx;
}

/* ---------------------------------------------------------------------------
   STAMP AND UNDO. stampPathology writes the lesion and returns the record that takes it out
   again: { id, idx (Int32Array), old (Uint8Array), ms }. undoPathology puts back every voxel
   it changed, exactly. A lesion marked unavailable returns null (the trainer takes the patient
   as normal) unless opts.force asks for it to be drawn anyway, for QC. */
export function stampPathology(vol, id, ctx, opts = {}) {
  const P = PATHOLOGY[id];
  if (!P) throw new Error(`unknown pathology ${id}`);
  if (P.available === false && !(opts.force && P.build)) return null;
  if (ctx.subject && ctx.subject !== P.subject) throw new Error(`${id} belongs to ${P.subject}, not ${ctx.subject}`);
  const clock = globalThis.performance || Date, t0 = clock.now();
  const E = new Edit(vol.data);
  let info;
  try { info = P.build({ ...ctx, vol, E }, opts) || null; }
  catch (err) { undoPathology(vol, E.finish()); throw err; }
  const u = E.finish();
  return { id, opts: { ...opts }, idx: u.idx, old: u.old, info, ms: clock.now() - t0 };
}
export function undoPathology(vol, undo) {
  if (!undo) return;
  const d = vol.data, { idx, old } = undo;
  for (let n = 0; n < idx.length; n++) d[idx[n]] = old[n];
}

/* ---------------------------------------------------------------------------
   THE HAND (0.5 mm; cortical bone only, marrow as soft tissue): -i radial, -j dorsal, +k distal. */
const HAND = { radial: [-1, 0, 0], dorsal: [0, -1, 0], distal: [0, 0, 1] };

/* The distal radius, 2 cm above the radiocarpal joint (centring radiusDistal), its shaft's axis
   from radiusProx. Returns the bone, the plane's point and the radius's own frame. */
function distalRadius(ctx) {
  const pD = ctx.point('radiusDistal'), pP = ctx.point('radiusProx');
  const ax = nrm(sub(pD, pP));
  const comp = boneNear(ctx.vol, pD, { r: 3.4, erodeCm: 0.1 });
  const dors = orth(HAND.dorsal, ax), rad = orth(crs(dors, ax), ax);
  // the radius's own centre at the plane (the centring point is its centroid there)
  return { comp, p0: pD, ax, dors, rad: dot(rad, HAND.radial) > 0 ? rad : mul(rad, -1) };
}
/* A COLLES FRACTURE: transverse through the distal radius 2 cm above the joint, the distal
   fragment tilted dorsally (the joint surface faces back instead of forward ~11 degrees) and
   pushed a little dorsal and radial. It turns about the middle of its own joint surface: the
   carpus goes where the fragment goes in a real wrist, and this one cannot move the carpus, so
   the joint is left where it is and the deformity shows where it shows on the lateral, as the
   fragment's proximal end standing proud of the shaft on the volar side. */
function colles(ctx, { tilt = 16, dshift = 0.12, rshift = 0.08, gap = 0.08 } = {}) {
  const { comp, p0, ax, dors, rad } = distalRadius(ctx);
  if (!comp) throw new Error('no radius found');
  const n = nrm(add(ax, mul(rad, 0.12)));                   // a little oblique, as they are
  const joint = surfaceAlong(ctx.vol, p0, ax, 3.0) || add(p0, mul(ax, 2));
  fracturePlane(ctx.E, ctx.vol, comp, {
    p0, n, gap, rough: 0.05, seed: 4,
    move: tilt || dshift || rshift ? { side: 1, axis: crs(ax, dors), deg: tilt, pivot: joint,
      shift: add(mul(dors, dshift), mul(rad, rshift)) } : null,
  });
  return { at: p0 };
}
/* A ray's joint: its centre and its distal axis on the volume (joints.json, rest frame). */
function joint(ctx, name) {
  const j = ctx.joints[name];
  return j ? { c: ctx.rest(j.c), dir: ctx.restDir(j.distal) } : null;
}
/* A SCAPHOID WAIST FRACTURE: undisplaced, through the middle of the bone. The scaphoid lies
   tilted palmar of the forearm's axis (in this hand ~70 degrees, a flexed wrist), so a PA looks
   nearly along it and a line across it is a smudge. The scaphoid view angles the tube ~20 degrees
   toward the elbow to lay the bone out: the fracture is drawn as a horizontal-oblique waist
   fracture (Russe), its plane the one that holds that beam, so the scaphoid view is the film it
   is sharp on; the PA and the lateral cross it at 20 degrees and more, and see a faint band.
   (The bone is looked for in 2.4 cm: in a smaller ball the radial styloid's cut end, only
   reachable through the scaphoid, went with it.) */
function scaphoidWaist(ctx, { gap = 0.16, cranial = 20 } = {}) {
  const comp = boneNear(ctx.vol, ctx.point('scaphoid'), { r: 2.4, erodeCm: 0.1, minCm3: 0.4 });
  if (!comp) throw new Error('no scaphoid found');
  const { c, axes, sd } = principalAxes(comp.pts);
  // the scaphoid view's beam: dorsal to palmar, tilted toward the elbow along the radius
  const ax = nrm(sub(ctx.point('radiusDistal'), ctx.point('radiusProx')));
  const th = cranial * Math.PI / 180;
  const beam = nrm(add(mul(HAND.dorsal, -Math.cos(th)), mul(ax, -Math.sin(th))));
  const n = orth(axes[0], beam);
  fracturePlane(ctx.E, ctx.vol, comp, { p0: c, n, gap, rough: 0.02, seed: 9 });
  return { at: c, lengthCm: +(4 * sd[0]).toFixed(2), voxels: comp.list.length, obliqueDeg: +(Math.acos(Math.abs(dot(n, axes[0]))) * 180 / Math.PI).toFixed(0) };
}
/* A BOXER'S FRACTURE: the neck of the 5th metacarpal, the head bent toward the palm (apex
   dorsal, ~30 degrees). The head turns about its own centre, which keeps the MCP joint as it is
   and puts the angle at the neck, where it is seen on the oblique and the lateral; on the PA the
   head is foreshortened over the neck. */
function boxer(ctx, { deg = 32, gap = 0.06 } = {}) {
  const J5 = joint(ctx, 'mcp5');
  const head = sub(J5.c, mul(J5.dir, 0.45)), p0 = sub(J5.c, mul(J5.dir, 1.25));
  const comp = boneNear(ctx.vol, p0, { r: 2.0, erodeCm: 0.08 });
  if (!comp) throw new Error('no 5th metacarpal found');
  let ax = principalAxes(comp.pts).axes[0];
  if (dot(ax, J5.dir) < 0) ax = mul(ax, -1);
  const palm = orth(mul(HAND.dorsal, -1), ax);
  fracturePlane(ctx.E, ctx.vol, comp, { p0, n: ax, gap, rough: 0.04, seed: 5,
    move: { side: 1, axis: crs(ax, palm), deg, pivot: head } });
  return { at: p0 };
}
/* RHEUMATOID ARTHRITIS: periarticular osteopenia at the MCP and PIP joints and marginal erosions
   in the bare areas (the radial side of the 2nd and 3rd metacarpal heads, the ulnar side of the
   5th, the ulnar styloid). The joint spaces are left exactly as they are. */
function rheumatoid(ctx) {
  const { vol, E } = ctx, d = vol.data;
  const rays = ['mcp2', 'mcp3', 'mcp4', 'mcp5', 'pip2', 'pip3', 'pip4', 'pip5'].map((n) => joint(ctx, n)).filter(Boolean);
  // osteopenia: the cortex within ~7 mm of each joint thinned in density (1200 -> 700 HU)
  for (const J of rays) {
    const B = boxR(vol, J.c, 1.0);
    forBox(vol, B, (i, j, k, o, p) => {
      if (d[o] !== CORT) return;
      const r = len(sub(p, J.c)) + 0.1 * noise3(p, 0.2, 21);
      if (r < 0.6) E.set(o, 57); else if (r < 0.9) E.set(o, 58);
    });
  }
  // erosions: just proximal of the cartilage at the heads' margins
  const bites = [];
  for (const [nm, side] of [['mcp2', -1], ['mcp3', -1], ['mcp5', 1], ['pip2', -1], ['pip3', 1]]) {
    const J = joint(ctx, nm); if (!J) continue;
    const at = sub(J.c, mul(J.dir, nm.startsWith('pip') ? 0.2 : 0.3));
    bites.push({ p: at, dir: orth([side, 0, 0], J.dir) });
  }
  erode(E, vol, bites, { r: 0.15, depth: 0.05 });
  // the ulnar styloid: the tip of the bone on the ulnar side of the distal radius
  const pD = ctx.point('radiusDistal');
  const ulna = surfaceAlong(vol, add(pD, [1.6, 0, 0]), [0, 0, 1], 3.0);
  if (ulna) erode(E, vol, [{ p: sub(ulna, [0, 0, 0.25]), dir: [1, 0, 0] }], { r: 0.16, depth: 0.06 });
  return { joints: rays.length };
}
/* A PLASTER CAST over a reduced distal radius fracture: the fracture line still there, the
   alignment restored (a few degrees of residual tilt), and a below-elbow cast from the volume's
   proximal end to the metacarpal shafts, the thumb left out. Cotton padding (fat-like) then
   plaster (calcium sulphate: drawn as the 550 HU bone mix, mottled as a bandage's weave is).
   The cast is clipped where the hand's volume ends: on the dorsum of the wrist that leaves it
   ~2 mm thick, which the lateral shows. */
function castWrist(ctx, { pad = 0.1, thick = 0.45 } = {}) {
  colles(ctx, { tilt: 3, dshift: 0.03, rshift: 0, gap: 0.07 });
  const { vol, E } = ctx, d = vol.data, [nx, ny] = vol.dims, s = spacing(vol);
  const kEnd = Math.round((joint(ctx, 'mcp3').c[2] - 1.6) / s[2]);
  const n = nx * ny, dist = new Float32Array(n), lab = new Int32Array(n), q = [];
  const D1 = s[0], D2 = Math.hypot(s[0], s[1]);
  for (let k = 0; k <= kEnd; k++) {
    const off = k * n;
    // the slice's main island: the biggest piece of body (the thumb, where it is apart, is not cast)
    lab.fill(0);
    let best = 0, bestN = 0, tag = 0;
    for (let p0 = 0; p0 < n; p0++) {
      if (!d[off + p0] || lab[p0]) continue;
      const st = [p0]; lab[p0] = ++tag; let cnt = 0;
      while (st.length) {
        const p = st.pop(); cnt++;
        const i = p % nx;
        for (const t of [i > 0 ? p - 1 : -1, i < nx - 1 ? p + 1 : -1, p - nx, p + nx]) if (t >= 0 && t < n && d[off + t] && !lab[t]) { lab[t] = tag; st.push(t); }
      }
      if (cnt > bestN) { bestN = cnt; best = tag; }
    }
    if (bestN < 50) continue;
    // distance out from it (chamfer, by a Dijkstra-free two-pass)
    dist.fill(1e9);
    for (let p = 0; p < n; p++) if (lab[p] === best) dist[p] = 0;
    for (let pass = 0; pass < 2; pass++) {
      const fw = pass === 0;
      for (let jj = 0; jj < ny; jj++) {
        const j = fw ? jj : ny - 1 - jj;
        for (let ii = 0; ii < nx; ii++) {
          const i = fw ? ii : nx - 1 - ii, p = j * nx + i;
          const dj = fw ? -1 : 1, di = fw ? -1 : 1;
          let v = dist[p];
          const i2 = i + di, j2 = j + dj;
          if (i2 >= 0 && i2 < nx) v = Math.min(v, dist[p + di] + D1);
          if (j2 >= 0 && j2 < ny) {
            v = Math.min(v, dist[p + dj * nx] + D1);
            if (i2 >= 0 && i2 < nx) v = Math.min(v, dist[p + dj * nx + di] + D2);
            if (i - di >= 0 && i - di < nx) v = Math.min(v, dist[p + dj * nx - di] + D2);
          }
          dist[p] = v;
        }
      }
    }
    // the cast's distal edge bevelled over its last 5 mm
    const t = clamp((kEnd - k) * s[2] / 0.5, 0.35, 1);
    for (let p = 0; p < n; p++) {
      if (d[off + p] !== AIR) continue;
      const r = dist[p];
      if (r <= 0 || r > pad + thick * t) continue;
      const pt = [(p % nx) * s[0], ((p / nx) | 0) * s[1], k * s[2]];
      E.set(off + p, r <= pad ? FAT : noise3(pt, 0.12, 31) > 0.15 ? 58 : 57);
    }
  }
  return { castToSlice: kEnd };
}

/* ---------------------------------------------------------------------------
   THE LIMBS (1 mm; right limbs, +k proximal). Bones are told apart by their cross-sections. */

/* The bone islands of slice k within r cm of a point (cm), marrow filled, biggest first:
   [{ n, c (cm centroid) }]. */
function islandsAt(vol, k, near, r) {
  const [nx, ny] = vol.dims, d = vol.data, s = spacing(vol);
  const B = boxR(vol, [near[0], near[1], k * s[2]], [r, r, 0]);
  const W = B[0][1] - B[0][0] + 1, H = B[1][1] - B[1][0] + 1, m = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (BONE.has(d[(k * ny + j + B[1][0]) * nx + i + B[0][0]])) m[j * W + i] = 1;
  fillSlices(m, [W, H, 1], 2);
  const lab = new Int32Array(W * H), out = [];
  for (let q0 = 0; q0 < W * H; q0++) {
    if (!m[q0] || lab[q0]) continue;
    const st = [q0]; lab[q0] = out.length + 1;
    let si = 0, sj = 0, cnt = 0;
    while (st.length) {
      const q = st.pop(), i = q % W, j = (q / W) | 0;
      si += i; sj += j; cnt++;
      for (const t of [i > 0 ? q - 1 : -1, i < W - 1 ? q + 1 : -1, j > 0 ? q - W : -1, j < H - 1 ? q + W : -1]) if (t >= 0 && m[t] && !lab[t]) { lab[t] = lab[q0]; st.push(t); }
    }
    out.push({ n: cnt, c: [(si / cnt + B[0][0]) * s[0], (sj / cnt + B[1][0]) * s[1], k * s[2]] });
  }
  return out.filter((o) => o.n * s[0] * s[1] >= 0.1).sort((a, b) => b.n - a.n);
}
/* A long bone's axis near a point: the centroids of its cross-sections over +-span cm, fitted. */
function shaftAxis(vol, comp) {
  let ax = principalAxes(comp.pts).axes[0];
  if (ax[2] < 0) ax = mul(ax, -1);                        // pointing proximal (+k)
  return ax;
}
/* A SHAFT FRACTURE of one long bone: a plane across it at p0 (oblique by `oblique` degrees
   about `tiltAbout`), the distal side carried `shift` cm and bent `deg` degrees, the move fading
   over `falloff` cm so the far joint stays where it is. */
function shaftFracture(ctx, p0, { r = 6, shift = [0, 0, 0], deg = 0, bendToward = null, oblique = 0, falloff = 6, gap = 0.12, seed = 3, side = -1, tiltAbout = null } = {}) {
  const comp = boneNear(ctx.vol, p0, { r, erodeCm: 0.12, minCm3: 0.5 });
  if (!comp) throw new Error('no bone found');
  const ax = shaftAxis(ctx.vol, comp);
  let n = ax;
  if (oblique) {
    const t = tiltAbout ? nrm(tiltAbout) : orth([1, 0, 0], ax);
    n = mv(rotMat(t, oblique * Math.PI / 180), ax);
  }
  // the centre of the bone's own cross-section at p0, so the plane cuts it through its middle
  let c = [0, 0, 0], cn = 0;
  for (let q = 0; q < comp.list.length; q++) {
    const p = [comp.pts[3 * q], comp.pts[3 * q + 1], comp.pts[3 * q + 2]];
    if (Math.abs(dot(sub(p, p0), ax)) < 0.3) { c = add(c, p); cn++; }
  }
  if (cn) c = mul(c, 1 / cn);
  const bend = deg ? nrm(crs(ax, orth(bendToward || [1, 0, 0], ax))) : null;
  fracturePlane(ctx.E, ctx.vol, comp, { p0: c, n, gap, rough: 0.06, seed,
    move: { side, shift, deg, axis: bend || [1, 0, 0], pivot: c, falloff } });
  return { at: c, axis: ax };
}

/* The forearm at a level: [ulna, radius] or [radius, ulna] told apart by which bone is bigger at
   the wrist (the radius) — traced as islands at k. */
function forearmBones(ctx, k, near) {
  const isl = islandsAt(ctx.vol, k, near, 5);
  return isl.length >= 2 ? isl.slice(0, 2) : null;
}
/* The radius's side of the forearm: from the ulna to the radius, at the wrist (where the radius
   is the bigger bone). */
function radialDir(ctx) {
  const s = spacing(ctx.vol), w = ctx.point('wrist'), el = ctx.point('elbow');
  const k = Math.round((w[2] + 0.25 * (el[2] - w[2])) / s[2]);
  const b = forearmBones(ctx, k, [w[0] + 0.25 * (el[0] - w[0]), w[1] + 0.25 * (el[1] - w[1])]);
  if (!b) throw new Error('no forearm found');
  return { rad: nrm(sub(b[0].c, b[1].c)), k, b };
}
/* RADIAL HEAD: a vertical split through the lateral third of the head (Mason II), the fragment
   3 mm out to the side. The head is the smaller of the two bones 3 cm below the joint, followed
   up to 6 mm below the joint centre. On the AP and the radial head view the line runs down from
   the joint surface. */
function radialHead(ctx) {
  const s = spacing(ctx.vol), J = { c: ctx.point('elbowJoint'), dir: ctx.restDir(ctx.joints.elbow.distal) };
  const at = add(J.c, mul(J.dir, 3.0));
  const isl = islandsAt(ctx.vol, Math.round(at[2] / s[2]), at, 4);
  if (isl.length < 2) throw new Error('no radius at the elbow');
  const neck = isl[1].c, ulna = isl[0].c;                   // the ulna is the bigger bone up here
  const lat = orth(sub(neck, ulna), J.dir);
  const head = add(neck, mul(J.dir, -2.4));                 // 6 mm below the joint centre
  const comp = boneNear(ctx.vol, head, { r: 1.8, erodeCm: 0.15, minCm3: 0.3 });
  if (!comp) throw new Error('no radial head');
  const p0 = add(head, mul(lat, 0.4));
  fracturePlane(ctx.E, ctx.vol, comp, { p0, n: nrm(add(lat, mul(J.dir, 0.15))), gap: 0.15, rough: 0.04, seed: 2,
    move: { side: 1, shift: mul(lat, 0.3), weight: (p) => 1 - smooth((dot(sub(p, head), J.dir) - 0.7) / 0.6) } });
  return { at: p0 };
}
/* SURGICAL NECK OF HUMERUS: impacted, the head tipped ~15 degrees into varus about its own centre
   (which keeps the glenohumeral joint as it is) and driven 3 mm into the shaft. */
function humerusNeck(ctx) {
  const head = ctx.point('shoulder'), elbow = ctx.point('elbow');
  const ax = nrm(sub(head, elbow));                          // up the humerus
  const p0 = sub(head, mul(ax, 3.2));
  const comp = boneNear(ctx.vol, p0, { r: 4.5, erodeCm: 0.15, minCm3: 2 });
  if (!comp) throw new Error('no humerus');
  // varus: the head turned so its articular surface faces down and in, about the AP axis
  const med = orth([1, 0, 0], ax), ap = crs(ax, med);
  fracturePlane(ctx.E, ctx.vol, comp, { p0, n: nrm(add(ax, mul(med, 0.15))), gap: 0.1, rough: 0.08, seed: 6,
    move: { side: 1, axis: ap, deg: 15, pivot: head, shift: mul(ax, -0.3) } });
  return { at: p0 };
}
function humerusShaft(ctx) {
  const head = ctx.point('shoulder'), elbow = ctx.point('elbow');
  const p0 = add(elbow, mul(sub(head, elbow), 0.5));
  return shaftFracture(ctx, p0, { r: 7, shift: [-0.45, 0.25, -0.2], deg: 10, bendToward: [-1, 0, 0], oblique: 25, falloff: 7, gap: 0.12 });
}
/* BOTH-BONE FOREARM: radius and ulna through the middle third, the radius 1 cm lower, both
   distal ends carried the same way (they go together, held by the interosseous membrane). */
function forearmShaft(ctx) {
  const s = spacing(ctx.vol), mid = ctx.point('forearm');
  const isl = islandsAt(ctx.vol, Math.round(mid[2] / s[2]), mid, 5);
  if (isl.length < 2) throw new Error('no forearm bones');
  const shift = [0.4, -0.3, 0.25];
  const a = shaftFracture(ctx, isl[0].c, { r: 6, shift, deg: 8, bendToward: [1, 0, 0], falloff: 6, seed: 4 });
  const b = shaftFracture(ctx, add(isl[1].c, [0, 0, -1.0]), { r: 6, shift, deg: 8, bendToward: [1, 0, 0], oblique: 15, falloff: 6, seed: 8 });
  return { at: [a.at, b.at] };
}

/* The leg at a level: the tibia (the bigger bone) and the fibula, and the lateral direction (from
   the tibia to the fibula: lateral in either leg, no landmark needed). */
function legBones(ctx, z) {
  const s = spacing(ctx.vol), kn = ctx.point('knee'), an = ctx.point('ankle');
  const t = (z - an[2]) / (kn[2] - an[2]);
  const near = add(an, mul(sub(kn, an), t));
  const isl = islandsAt(ctx.vol, Math.round(z / s[2]), near, 6);
  if (isl.length < 2) throw new Error('no two-bone leg');
  return { tib: isl[0].c, fib: isl[1].c, lat: nrm([isl[1].c[0] - isl[0].c[0], isl[1].c[1] - isl[0].c[1], 0]) };
}
/* TIBIAL SHAFT: a long oblique (spiral-type) fracture at the junction of the middle and distal
   thirds, the distal tibia 4 mm lateral and 3 mm posterior, a few degrees of valgus. The fibula
   is left whole. */
function tibialShaft(ctx) {
  const kn = ctx.point('knee'), an = ctx.point('ankle');
  const z = an[2] + 0.38 * (kn[2] - an[2]);
  const { tib, lat } = legBones(ctx, z);
  const post = [0, 1, 0];                                   // posterior is +j in the limb models
  return shaftFracture(ctx, tib, { r: 8, shift: add(mul(lat, 0.4), mul(post, 0.3)), deg: 6, bendToward: lat,
    oblique: 40, tiltAbout: post, falloff: 8, gap: 0.12, seed: 12 });
}
/* TIBIAL PLATEAU: a split of the lateral condyle (Schatzker I), the fragment 3.5 mm out to the
   side; the split runs down from the joint surface and out through the lateral metaphysis. The
   condyle is not pushed down: its joint surface stays level with the rest. */
function tibialPlateau(ctx) {
  const J = { c: ctx.point('knee'), dir: ctx.restDir(ctx.joints.knee.distal) };
  const { tib, lat } = legBones(ctx, J.c[2] - 6);
  const top = add(J.c, mul(J.dir, 1.2));
  const centre = [tib[0], tib[1], top[2]];
  const comp = boneNear(ctx.vol, top, { r: 4.5, erodeCm: 0.15, minCm3: 5 });
  if (!comp) throw new Error('no tibia');
  // the tibia's own centre at this level
  let c = [0, 0, 0], cn = 0;
  for (let q = 0; q < comp.list.length; q++) {
    const p = [comp.pts[3 * q], comp.pts[3 * q + 1], comp.pts[3 * q + 2]];
    if (Math.abs(p[2] - top[2]) < 0.3) { c = add(c, p); cn++; }
  }
  c = cn ? mul(c, 1 / cn) : centre;
  const p0 = add(c, mul(lat, 1.0));
  const n = nrm(add(lat, mul(J.dir, -0.35)));               // leaning out as it goes down
  fracturePlane(ctx.E, ctx.vol, comp, { p0, n, gap: 0.15, rough: 0.07, seed: 14,
    move: { side: 1, shift: mul(lat, 0.35), weight: (p) => 1 - smooth((dot(sub(p, J.c), J.dir) - 3.0) / 1.5) } });
  return { at: p0 };
}
/* KNEE OSTEOARTHRITIS: marginal osteophytes on both femoral condyles and both tibial plateaux,
   and subchondral sclerosis under the medial plateau. The joint space is not narrowed: no bone
   is added on the joint's side of the articular surfaces, and nothing is written over cartilage. */
/* The knee's own side-to-side axis, pointing lateral: the widest chord through the tibial plateau
   1 cm below the joint (the fibula lies behind as well as beside the tibia, so the line between
   them is not it, and this leg rests turned in), turned to the fibula's side. */
function kneeAxis(ctx, J) {
  const { lat } = legBones(ctx, J.c[2] - 6);
  const from = add(J.c, mul(J.dir, 1.0)), a0 = orth([1, 0, 0], J.dir), b0 = crs(J.dir, a0);
  let best = null, bw = 0;
  for (let deg = 0; deg < 180; deg += 5) {
    const t = deg * Math.PI / 180, e = nrm(add(mul(a0, Math.cos(t)), mul(b0, Math.sin(t))));
    const p = surfaceAlong(ctx.vol, from, e, 6.5), q = surfaceAlong(ctx.vol, from, mul(e, -1), 6.5);
    if (!p || !q) continue;
    const w = len(sub(p, q));
    if (w > bw) { bw = w; best = e; }
  }
  if (!best) return orth(lat, J.dir);
  return dot(best, lat) < 0 ? mul(best, -1) : best;
}
function kneeOA(ctx) {
  const { vol, E } = ctx;
  const J = { c: ctx.point('knee'), dir: ctx.restDir(ctx.joints.knee.distal) };
  const lat = kneeAxis(ctx, J);
  const up = mul(J.dir, -1);
  const sites = [];
  for (const sgn of [1, -1]) {
    const side = orth(mul(lat, sgn), J.dir);
    // the margins: the bone's edge found 1 cm into the tibia and the femur (nearer the joint the ray
    // runs along the joint surface and stops short), the beak based 5 mm from the joint line
    for (const [h, keepN, size] of [[1.0, J.dir, 0.75], [-1.1, up, 0.6]]) {
      const from = add(J.c, mul(J.dir, h));
      const deep = surfaceAlong(vol, from, side, 6.5);
      if (!deep) continue;
      // back up to 5 mm from the joint line, and find the bone's edge there from inside
      const at = add(deep, mul(J.dir, Math.sign(h) * 0.5 - h));
      const edge = surfaceAlong(vol, sub(at, mul(side, 1.0)), side, 2.0) || at;
      // the beak grows outward and a little toward the joint line, as marginal osteophytes do
      const out = nrm(add(side, mul(keepN, -0.45)));
      osteophyte(E, vol, { base: sub(edge, mul(side, 0.08)), out, along: crs(side, J.dir), size: size * (sgn < 0 ? 1.25 : 1), thick: 0.3,
        keep: { p: add(J.c, mul(keepN, 0.12)), n: keepN }, seed: 20 + sites.length });
      sites.push(edge);
    }
  }
  // sclerosis: the medial plateau's subchondral bone (medial is away from the fibula)
  const med = orth(mul(lat, -1), J.dir);
  const plate = add(add(J.c, mul(J.dir, 0.3)), mul(med, 2.0));
  const tibia = boneNear(vol, add(plate, mul(J.dir, 0.6)), { r: 2.5, erodeCm: 0.12, minCm3: 2 });
  if (tibia) sclerose(E, vol, tibia, { p: plate, n: J.dir, depth: 0.8, mat: 60 });
  return { osteophytes: sites.length, sites: sites.map((p) => p.map((v) => +v.toFixed(2))) };
}
/* PATELLA: a transverse fracture through its middle, the fragments 3 mm apart (the quadriceps
   pulls the upper one away). The gap stays inside the patella, so it rides with the patella
   when the knee bends. */
function patella(ctx) {
  // the patella's own grid (the rider, joints.json) is drawn round it: its middle is the bone's
  const R = ctx.joints.knee.rider;
  const c = ctx.rest(R.origin.map((o, a) => o + R.dims[a] * R.sp / 2));
  const comp = boneNear(ctx.vol, c, { r: 3.2, erodeCm: 0.15, minCm3: 2 });
  if (!comp) throw new Error('no patella');
  const pa = principalAxes(comp.pts);
  // across it: square to the leg's axis, in the plane of the bone (its thinnest axis is front to
  // back; its height and width are near equal, so the principal axes alone cannot say which is which)
  const ax = orth(ctx.restDir(ctx.joints.knee.distal), pa.axes[2]);
  fracturePlane(ctx.E, ctx.vol, comp, { p0: pa.c, n: ax, gap: 0.3, rough: 0.08, seed: 15 });
  return { at: pa.c };
}
function femurShaft(ctx) {
  const hip = ctx.point('hip'), kn = ctx.point('knee');
  const p0 = add(kn, mul(sub(hip, kn), 0.5));
  const comp = boneNear(ctx.vol, p0, { r: 2.5, minCm3: 2 });
  const lat = [-1, 0, 0];                                   // a right leg: lateral is -i here
  return shaftFracture(ctx, comp ? principalAxes(comp.pts).c : p0, { r: 10, shift: add(mul(lat, 0.7), [0, -0.3, 0.6]), deg: 12, bendToward: lat,
    oblique: 15, falloff: 10, gap: 0.12, seed: 17 });
}

/* THE FOOT (1 mm; cut from the leg): the fibula is found by core/fracture.js. */
/* WEBER B: the ankle exercise's own fracture (core/fracture.js), displaced 2 mm lateral and
   2 mm short with 5 degrees of external rotation: clear on the mortise and the lateral. */
function weberB(ctx) {
  const { vol, E } = ctx, d = vol.data, sp = spacing(vol);
  const fib = findFibula(d, vol.dims, sp, 0);
  if (!fib) throw new Error('no fibula');
  const frag = fractureFragment(d, vol.dims, sp, fib, fib.latSign);
  if (!frag) throw new Error('no fragment');
  const saved = boxSave(d, vol.dims, frag.box);
  stampFragment(d, vol.dims, frag, saved, fragmentMove(frag, { lat: 0.2, prox: 0.2, rot: 5 }));
  // record what changed (and give back any cartilage the fragment landed on)
  const [nx, ny] = vol.dims, B = frag.box;
  let o2 = 0;
  for (let k = B[2][0]; k <= B[2][1]; k++) for (let j = B[1][0]; j <= B[1][1]; j++) for (let i = B[0][0]; i <= B[0][1]; i++, o2++) {
    const o = (k * ny + j) * nx + i, was = saved[o2];
    if (d[o] === was) continue;
    if (was === CART) { d[o] = was; continue; }
    E.adopt(o, was);
  }
  return { at: frag.p0 };
}
/* 5th METATARSAL BASE: a transverse avulsion of the tuberosity (the peroneus brevis' insertion),
   1 cm from its tip, pulled 1.5 mm back. The tuberosity is the most lateral bone of the midfoot. */
function mt5Base(ctx) {
  const { vol } = ctx, d = vol.data, [nx, ny, nz] = vol.dims, s = spacing(vol);
  const fib = findFibula(d, vol.dims, s, 0);
  const latSign = fib ? fib.latSign : 1;
  // the foot's length runs along j (anterior -j); its bone's extent there
  let jLo = ny, jHi = -1, kLo = nz;
  for (let k = 0; k < nz; k += 2) for (let j = 0; j < ny; j += 2) for (let i = 0; i < nx; i += 2) {
    if (!BONE.has(d[(k * ny + j) * nx + i])) continue;
    if (j < jLo) jLo = j; if (j > jHi) jHi = j; if (k < kLo) kLo = k;
  }
  // the midfoot: 40-55 % of the way from the heel (+j) to the toes (-j), the lower part of the foot
  const j0 = Math.round(jHi - 0.55 * (jHi - jLo)), j1 = Math.round(jHi - 0.38 * (jHi - jLo)), k1 = kLo + Math.round(4 / s[2]);
  let best = null, bl = -Infinity;
  for (let k = kLo; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = 0; i < nx; i++) {
    if (!BONE.has(d[(k * ny + j) * nx + i])) continue;
    const L = latSign * i;
    if (L > bl) { bl = L; best = [i * s[0], j * s[1], k * s[2]]; }
  }
  if (!best) throw new Error('no 5th metatarsal');
  const comp = boneNear(vol, best, { r: 2.6, erodeCm: 0.12, minCm3: 0.5 });
  if (!comp) throw new Error('no 5th metatarsal');
  const pa = principalAxes(comp.pts);
  let ax = pa.axes[0];
  if (dot(ax, sub(pa.c, best)) < 0) ax = mul(ax, -1);      // from the tip toward the shaft
  const p0 = add(best, mul(ax, 1.0));
  fracturePlane(ctx.E, vol, comp, { p0, n: ax, gap: 0.1, rough: 0.05, seed: 18,
    move: { side: -1, shift: mul(ax, -0.15) } });
  return { at: p0, tip: best };
}

/* ---------------------------------------------------------------------------
   THE CHEST (1 mm). The patient's right is the liver's side (ctx.trunk()), anterior the heart's.

   ONE LUNG, as a box-local field: its envelope (the lung and what the lung encloses, slice by
   slice: the vessels, the markings), each voxel's height along `up`, and its distance in from
   the chest wall (a race in through the envelope from its surface, the mediastinal surface left
   out: a pneumothorax and an effusion both sit against the parietal pleura of the wall). */
function lungField(ctx, side, up, { reach = 5 } = {}) {
  const { vol } = ctx, d = vol.data, [nx, ny, nz] = vol.dims, s = spacing(vol), T = ctx.trunk();
  const sgn = (side === 'L' ? -1 : 1) * T.right[0];         // +i or -i is this side
  const mid = Math.round(T.body[0] / s[0]);
  // the lung's box on this side, from a coarse pass
  let lo = [nx, ny, nz], hi = [-1, -1, -1];
  for (let k = 0; k < nz; k += 2) for (let j = 0; j < ny; j += 2) for (let i = 0; i < nx; i += 2) {
    if ((i - mid) * sgn <= 0 || d[(k * ny + j) * nx + i] !== LUNG) continue;
    const v = [i, j, k]; for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], v[a]); hi[a] = Math.max(hi[a], v[a]); }
  }
  if (hi[0] < 0) throw new Error('no lung on that side');
  const B = [0, 1, 2].map((a) => [Math.max(0, lo[a] - 2), Math.min(vol.dims[a] - 1, hi[a] + 2)]);
  const W = B[0][1] - B[0][0] + 1, H = B[1][1] - B[1][0] + 1, D = B[2][1] - B[2][0] + 1, n = W * H * D;
  const env = new Uint8Array(n);
  forBox(vol, B, (i, j, k, o) => { if ((i - mid) * sgn > 0 && d[o] === LUNG) env[((k - B[2][0]) * H + (j - B[1][0])) * W + (i - B[0][0])] = 1; });
  fillSlices(env, [W, H, D], 2);
  // lateral: away from the midline. The envelope's own extent sets what counts as the wall side.
  const at = (q) => [(q % W + B[0][0]) * s[0], (((q / W) | 0) % H + B[1][0]) * s[1], (((q / (W * H)) | 0) + B[2][0]) * s[2]];
  let lMin = Infinity, lMax = -Infinity, hMin = Infinity, hMax = -Infinity;
  for (let q = 0; q < n; q++) {
    if (!env[q]) continue;
    const px = (q % W + B[0][0]) * s[0], py = (((q / W) | 0) % H + B[1][0]) * s[1], pz = (((q / (W * H)) | 0) + B[2][0]) * s[2];
    const l = (px - T.body[0]) * sgn, h = px * up[0] + py * up[1] + pz * up[2];
    if (l < lMin) lMin = l; if (l > lMax) lMax = l; if (h < hMin) hMin = h; if (h > hMax) hMax = h;
  }
  // the wall's surface: envelope voxels with a non-envelope neighbour, on the outer 60 % of the
  // lung's width, or within 5 cm of its top; never the diaphragm's face (a neighbour below)
  const nb = [1, -1, W, -W, W * H, -W * H];
  const steps = new Uint16Array(n).fill(65535), queue = [];
  for (let q = 0; q < n; q++) {
    if (!env[q]) continue;
    const x = q % W, y = ((q / W) | 0) % H, z = (q / (W * H)) | 0;
    let face = -1;
    for (let a = 0; a < 6; a++) {
      const okA = !((a === 0 && x === W - 1) || (a === 1 && x === 0) || (a === 2 && y === H - 1) || (a === 3 && y === 0) || (a === 4 && z === D - 1) || (a === 5 && z === 0));
      if (!okA || !env[q + nb[a]]) { face = a; if (a !== 5) break; }
    }
    if (face < 0) continue;
    const p = at(q), l = (p[0] - T.body[0]) * sgn, h = dot(p, [0, 0, 1]);
    const wall = l > lMin + 0.4 * (lMax - lMin) || h > (B[2][1] * s[2]) - 5;
    if (!wall || face === 5) continue;
    steps[q] = 0; queue.push(q);
  }
  // breadth first in from the wall (6-connected, in voxel steps), out to `reach` cm
  const maxS = Math.ceil(reach / s[0]);
  for (let h = 0; h < queue.length; h++) {
    const q = queue[h], dq = steps[q] + 1;
    if (dq > maxS) continue;
    const x = q % W, y = ((q / W) | 0) % H, z = (q / (W * H)) | 0;
    for (let a = 0; a < 6; a++) {
      if ((a === 0 && x === W - 1) || (a === 1 && x === 0) || (a === 2 && y === H - 1) || (a === 3 && y === 0) || (a === 4 && z === D - 1) || (a === 5 && z === 0)) continue;
      const t = q + nb[a];
      if (env[t] && steps[t] > dq) { steps[t] = dq; queue.push(t); }
    }
  }
  const dist = new Float32Array(n);
  for (let q = 0; q < n; q++) dist[q] = steps[q] === 65535 ? Infinity : steps[q] * s[0];
  const glob = (q) => (((q / (W * H)) | 0) + B[2][0]) * nx * ny + ((((q / W) | 0) % H) + B[1][0]) * nx + (q % W + B[0][0]);
  return { B, W, H, D, n, env, dist, at, glob, hMin, hMax, lMin, lMax, sgn };
}
/* The direction gravity pulls in, as a unit vector on the volume, for a posture:
   erect: toward the feet; supine: toward the back; prone: toward the front; lateral: onto the
   lesion's side (the decubitus that shows it). */
function gravity(ctx, posture, side) {
  const T = ctx.trunk();
  if (posture === 'supine') return mul(T.ant, -1);
  if (posture === 'prone') return T.ant;
  if (posture === 'lateral') return mul(T.right, side === 'L' ? -1 : 1);
  return mul(T.sup, -1);
}

/* PNEUMOTHORAX: the lung fallen away from the chest wall toward its hilum, air where it was.
   The lung is redrawn smaller about the hilum, by more upward (where the air rises: the apex
   erect, the front supine) and outward than elsewhere, and never pulled off the mediastinum or
   up off the diaphragm: each voxel of the old lung takes what lay at its point in the lung
   scaled back up, its markings with it, so they crowd a little and end at the new edge. Past the
   edge is air and nothing else. The edge itself is the visceral pleura, a one-voxel line of soft
   tissue, which the PA catches where it runs along the beam: the white line parallel to the wall
   with no markings beyond it. On expiration the lung is smaller round the same air, so it is
   drawn a third further collapsed. */
function pneumothorax(ctx, { side = 'R', posture = 'erect', expiration = false, collapse = 0.22 } = {}) {
  const { vol } = ctx, d = vol.data, s = spacing(vol), T = ctx.trunk();
  const up = mul(gravity(ctx, posture, side), -1);
  const F = lungField(ctx, side, up, { reach: 0.1 });
  const { B, W, H, D, env, sgn } = F;
  const c = collapse * (expiration ? 1.35 : 1);
  // the hilum: 1.5 cm out from the lung's medial edge, at the middle of its depth, 45 % up
  let cy = 0, cz = 0, cn = 0;
  for (let q = 0; q < F.n; q++) if (env[q]) { cy += ((q / W) | 0) % H; cz += (q / (W * H)) | 0; cn++; }
  const lat = [sgn, 0, 0];
  const hil = [T.body[0] + sgn * (F.lMin + 1.5), (cy / cn + B[1][0]) * s[1], (cz / cn + B[2][0]) * s[2]];
  const hilH = F.hMin + 0.45 * (F.hMax - F.hMin);           // its height along `up`
  const third = nrm(crs(up, lat));
  const orig = boxSave(d, vol.dims, B);
  const envAt = (i, j, k) => i >= 0 && j >= 0 && k >= 0 && i < W && j < H && k < D && env[(k * H + j) * W + i] === 1;
  let nAir = 0;
  for (let q = 0; q < F.n; q++) {
    if (!env[q]) continue;
    const x = q % W, y = ((q / W) | 0) % H, z = (q / (W * H)) | 0;
    const p = [(x + B[0][0]) * s[0], (y + B[1][0]) * s[1], (z + B[2][0]) * s[2]];
    // the point's place relative to the hilum, along up, out, and the third way
    const v = sub(p, hil), h = dot(p, up) - hilH, l = dot(v, lat), t = dot(v, third);
    const fh = h > 0 ? 1 - c : 1, fl = l > 0 ? 1 - 0.8 * c : 1, ft = 1 - 0.35 * c;
    // where it came from in the full lung
    const src = add(add(add(p, mul(up, h / fh - h)), mul(lat, l / fl - l)), mul(third, t / ft - t));
    const si = Math.round(src[0] / s[0]) - B[0][0], sj = Math.round(src[1] / s[1]) - B[1][0], sk = Math.round(src[2] / s[2]) - B[2][0];
    const o = F.glob(q);
    if (!envAt(si, sj, sk)) { ctx.E.set(o, AIR); nAir++; continue; }
    const edge = !envAt(si + 1, sj, sk) || !envAt(si - 1, sj, sk) || !envAt(si, sj + 1, sk) || !envAt(si, sj - 1, sk) || !envAt(si, sj, sk + 1) || !envAt(si, sj, sk - 1);
    // the visceral pleura: the scaled lung's surface, where it has come away from the wall
    const m = edge && (h > 0 || l > 0) ? SOFT : orig[(sk * H + sj) * W + si];
    ctx.E.set(o, m);
  }
  return { side, posture, expiration, airMl: Math.round(nAir * s[0] * s[1] * s[2]) };
}
/* PLEURAL EFFUSION: the dependent lung turned to fluid. The fluid is a pool at the bottom and a
   sheet up the wall that thins as it climbs (the lung's recoil holds it there: the meniscus), so
   its surface is lowest in the middle and rises ~8 cm at the wall, steadily (no flat top: that
   is a fluid level, and a fluid level needs air above it). Erect, it fills the
   costophrenic angle and draws the concave meniscus on the PA; supine, the same fluid lies
   along the back as a veil with no edge; on the lesion's side down it runs along that wall. */
function effusion(ctx, { side = 'R', posture = 'erect', ml = 700 } = {}) {
  const g = gravity(ctx, posture, side), up = mul(g, -1);
  const F = lungField(ctx, side, up, { reach: 8 });
  const vox = spacing(ctx.vol).reduce((a, b) => a * b, 1);
  const E8 = new Float32Array(F.n);
  for (let q = 0; q < F.n; q++) if (F.env[q]) E8[q] = dot(F.at(q), up) - 8 * Math.exp(-(F.dist[q] === Infinity ? 99 : F.dist[q]) / 2.5);
  const eff = (q) => E8[q];
  // the level that holds ml: a histogram of the effective height in 1 mm bins
  const lo = F.hMin - 3, nb = Math.ceil((F.hMax - lo) / 0.1) + 2, hist = new Float64Array(nb);
  for (let q = 0; q < F.n; q++) if (F.env[q]) hist[clamp(Math.floor((eff(q) - lo) / 0.1), 0, nb - 1)] += vox;
  let acc = 0, b = 0;
  for (; b < nb && acc < ml; b++) acc += hist[b];
  const level = lo + b * 0.1;
  for (let q = 0; q < F.n; q++) if (F.env[q] && eff(q) < level) ctx.E.set(F.glob(q), FLUID);
  return { side, posture, ml: Math.round(acc), level };
}
/* LOBAR PNEUMONIA (the right lower lobe by default): the lobe's air replaced by fluid, its upper
   edge the oblique fissure (from the level of T4-5 behind down to the front of the diaphragm), a
   few air bronchograms branching out from the lobar bronchus. On the PA it blots out the
   hemidiaphragm and leaves the heart border; on the lateral it is a wedge on the spine. */
function pneumonia(ctx, { side = 'R' } = {}) {
  const T = ctx.trunk(), F = lungField(ctx, side, T.sup, { reach: 0.1 });
  // the lung's extent front to back and top to bottom
  let aMin = Infinity, aMax = -Infinity;
  for (let q = 0; q < F.n; q++) if (F.env[q]) { const a = dot(F.at(q), T.ant); if (a < aMin) aMin = a; if (a > aMax) aMax = a; }
  // the fissure meets the diaphragm in front: the lowest lung in the front quarter
  let zA = Infinity;
  for (let q = 0; q < F.n; q++) if (F.env[q]) { const p = F.at(q); if (dot(p, T.ant) > aMin + 0.75 * (aMax - aMin) && p[2] < zA) zA = p[2]; }
  const Hh = F.hMax - F.hMin, zP = F.hMax - 0.3 * Hh;
  zA += 0.5;
  const fiss = (a) => zP + (zA - zP) * (a - aMin) / (aMax - aMin);
  let c = [0, 0, 0], cn = 0;
  const cons = new Uint8Array(F.n);
  for (let q = 0; q < F.n; q++) {
    if (!F.env[q]) continue;
    const p = F.at(q);
    if (p[2] < fiss(dot(p, T.ant)) + 0.25 * noise3(p, 1.2, 51)) { cons[q] = 1; ctx.E.set(F.glob(q), FLUID); c = add(c, p); cn++; }
  }
  if (!cn) throw new Error('no lobe');
  c = mul(c, 1 / cn);
  // air bronchograms: the lobar bronchus from the hilum, branching toward the lobe's corners
  const hilum = [T.body[0] + F.sgn * (F.lMin + 2.0), 0, zP - 1.0];
  hilum[1] = c[1] - 0.2 * (aMax - aMin) * T.ant[1];
  const targets = [[-0.5, -0.6, -0.8], [0.6, -0.4, -0.8], [0.1, 0.5, -0.9], [0.7, 0.4, -0.5], [-0.3, 0.2, -1]];
  const lat = mul(T.right, F.sgn * T.right[0]);
  let nb = 0;
  for (const [l, a, h] of targets) {
    const end = add(c, add(add(mul(lat, l * 3), mul(T.ant, a * 3)), mul(T.sup, h * 3)));
    nb += fillShapeIn(ctx, F, cons, { cylinder: { p0: hilum, p1: end, r: [0.22, 0.08] } }, AIR);
  }
  return { side, ml: Math.round(cn * spacing(ctx.vol).reduce((x, y) => x * y, 1)), bronchogramVoxels: nb };
}
/* fillShape, restricted to a lung field's marked voxels */
function fillShapeIn(ctx, F, mark, shape, mat) {
  const [nx, ny] = ctx.vol.dims, { B, W, H } = F;
  return fillShape(ctx.E, ctx.vol, shape, mat, { filter: (o) => {
    const [i, j, k] = ijk(o, nx, ny);
    if (i < B[0][0] || i > B[0][1] || j < B[1][0] || j > B[1][1] || k < B[2][0] || k > B[2][1]) return false;
    return mark[((k - B[2][0]) * H + (j - B[1][0])) * W + (i - B[0][0])] === 1;
  } });
}
/* A RIB FRACTURE: one rib broken through, a 2 mm step inward fading over 3 cm. The rib is
   found by going out from the lung's surface at the given height and bearing (cm on the trunk:
   lat out from the midline, ant forward) to the first bone. */
function ribFracture(ctx, { side = 'R', bearing = 'anterior', drop = 1.0 } = {}) {
  const { vol } = ctx, T = ctx.trunk(), s = spacing(vol);
  const t7 = ctx.point('T7');
  const sgn = side === 'L' ? -1 : 1;
  const lat = mul(T.right, sgn);
  // the lung's centre on this side, at the height
  const z = t7[2] - drop;
  const lungC = (() => {
    const [nx, ny] = vol.dims, d = vol.data, k = Math.round(z / s[2]);
    let si = 0, sj = 0, cn = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (d[(k * ny + j) * nx + i] !== LUNG || (i * s[0] - T.body[0]) * lat[0] <= 0) continue;
      si += i; sj += j; cn++;
    }
    return cn ? [si / cn * s[0], sj / cn * s[1], z] : null;
  })();
  const from = lungC || add(t7, mul(lat, 7));
  const dir = bearing === 'anterior' ? nrm(add(mul(lat, 0.75), mul(T.ant, 0.66))) : nrm(add(mul(lat, 0.55), mul(T.ant, -0.83)));
  // out through the lung to the wall, then the first bone before the skin; the ray may pass
  // between two ribs, so it is tried a few mm higher and lower until it meets one
  const [nx, ny, nz] = vol.dims, d = vol.data;
  let hit = null;
  for (const dz of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6]) {
    let outside = 0;                                         // cm walked since the lung ended
    for (let t = 0; t < 25; t += s[0] / 2) {
      const q = add(add(from, [0, 0, dz]), mul(dir, t)), i = Math.round(q[0] / s[0]), j = Math.round(q[1] / s[1]), k = Math.round(q[2] / s[2]);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) break;
      const m = d[(k * ny + j) * nx + i];
      if (m === LUNG) { outside = 0; continue; }
      if (BONE.has(m) && t > 2) { hit = q; break; }
      outside += s[0] / 2;
      if (m === AIR && outside > 1.5) break;                 // past the skin
    }
    if (hit) break;
  }
  if (!hit) throw new Error('no rib found there');
  const comp = boneNear(vol, hit, { r: 2.5, erodeCm: 0.08, minCm3: 0.3 });
  if (!comp) throw new Error('no rib');
  const pa = principalAxes(comp.pts);
  const inward = mul(dir, -1);
  fracturePlane(ctx.E, vol, comp, { p0: hit, n: pa.axes[0], gap: 0.1, rough: 0.04, seed: 61,
    move: { side: 1, shift: mul(inward, 0.25), falloff: 3 } });
  return { at: hit, side, bearing };
}

/* ---------------------------------------------------------------------------
   THE ABDOMEN AND PELVIS (chestabdopelvis, 2 mm): +i the patient's right, +j anterior, +k up
   (read off the liver and heart by ctx.trunk(), not assumed). */

/* The voxels of a material in a box found by a coarse pass: { B, list } (global indices). */
function organ(ctx, mats, { side = null, stride = 2 } = {}) {
  const { vol } = ctx, d = vol.data, [nx, ny, nz] = vol.dims, s = spacing(vol), T = ctx.trunk();
  const mid = T.body[0] / s[0], sg = side ? (side === 'L' ? -1 : 1) * T.right[0] : 0;
  let lo = [nx, ny, nz], hi = [-1, -1, -1];
  for (let k = 0; k < nz; k += stride) for (let j = 0; j < ny; j += stride) for (let i = 0; i < nx; i += stride) {
    if (!mats.has(d[(k * ny + j) * nx + i]) || (sg && (i - mid) * sg <= 0)) continue;
    const v = [i, j, k]; for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], v[a]); hi[a] = Math.max(hi[a], v[a]); }
  }
  if (hi[0] < 0) return null;
  const B = [0, 1, 2].map((a) => [Math.max(0, lo[a] - stride), Math.min(vol.dims[a] - 1, hi[a] + stride)]);
  const list = [];
  forBox(vol, B, (i, j, k, o) => { if (mats.has(d[o]) && !(sg && (i - mid) * sg <= 0)) list.push(o); });
  return { B, list: Int32Array.from(list) };
}
/* FLUID LEVELS IN GAS-FILLED BOWEL. The lumen given is filled with gas and fluid, the fluid in
   the dependent part of each loop, and each loop has its own level.

   THE LOOPS ARE DRAWN, because the model does not have them: its small bowel is segmented as one
   lump (eroded by three voxels it is still one piece), with no tube in it to follow. So the lumen
   is cut into loops of the size an obstructed small bowel has, ~3 cm across: cells round a
   jittered lattice of centres, stretched across the body (dilated loops lie stacked, mostly
   transverse, in the middle of the abdomen), their edges bent by the noise, and one voxel of wall
   (soft tissue) between neighbours. Each loop then fills to `fill` of its own voxels from the
   bottom, gravity's bottom: erect, each is a gas cap over a flat fluid level, at the height its
   own loop puts it (the step ladder); supine, gravity is to the back, the fluid lies behind the
   gas, and the beam looks down through both: gas-filled loops, no levels. */
export function bowelFluid(E, vol, list, g, { fill = 0.45, loop = [8, 5, 3.4], right = [1, 0, 0], gasId = GAS, fluidId = FLUID, seed = 1 } = {}) {
  const [nx, ny] = vol.dims, s = spacing(vol), n = list.length;
  g = nrm(g);
  const P = (o) => { const [i, j, k] = ijk(o, nx, ny); return [i * s[0], j * s[1], k * s[2]]; };
  // the loops' axes: across the body, front to back, up the body (the volume's own axes here)
  const ax = [nrm(right), [0, 1, 0], [0, 0, 1]];
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const o of list) { const p = P(o); for (let a = 0; a < 3; a++) { const v = dot(p, ax[a]); lo[a] = Math.min(lo[a], v); hi[a] = Math.max(hi[a], v); } }
  // the lattice of loop centres, each nudged by up to 0.35 of its cell
  const C = [];
  const cnt = [0, 1, 2].map((a) => Math.max(1, Math.ceil((hi[a] - lo[a]) / loop[a])));
  for (let a = 0; a < cnt[0]; a++) for (let b = 0; b < cnt[1]; b++) for (let c = 0; c < cnt[2]; c++) {
    const id = [a, b, c], q = [0, 1, 2].map((t) => lo[t] + (id[t] + 0.5 + 0.35 * hash3(a, b, c, seed + t)) * loop[t]);
    C.push(q);
  }
  const cellOf = new Int32Array(n), at = new Map();
  list.forEach((o, q) => at.set(o, q));
  for (let q = 0; q < n; q++) {
    const p = P(list[q]);
    const w = [0, 1, 2].map((t) => dot(p, ax[t]) + 0.9 * noise3(p, 2.5, seed + 10 + t));
    let best = 0, bd = Infinity;
    for (let c = 0; c < C.length; c++) {
      const dd = ((w[0] - C[c][0]) / loop[0]) ** 2 + ((w[1] - C[c][1]) / loop[1]) ** 2 + ((w[2] - C[c][2]) / loop[2]) ** 2;
      if (dd < bd) { bd = dd; best = c; }
    }
    cellOf[q] = best;
  }
  // the walls between loops; then each loop's level
  const wall = new Uint8Array(n), byCell = new Map();
  for (let q = 0; q < n; q++) {
    const o = list[q], i = o % nx;
    for (const t of [i < nx - 1 ? o + 1 : -1, o + nx, o + nx * ny]) {
      const r = t >= 0 ? at.get(t) : undefined;
      if (r !== undefined && cellOf[r] !== cellOf[q]) { wall[q] = 1; break; }
    }
    if (wall[q]) { E.set(o, SOFT); continue; }
    if (!byCell.has(cellOf[q])) byCell.set(cellOf[q], []);
    byCell.get(cellOf[q]).push(q);
  }
  let levels = 0;
  for (const qs of byCell.values()) {
    const dep = qs.map((q) => dot(P(list[q]), g)).sort((a, b) => b - a);
    const cut = dep[Math.min(dep.length - 1, Math.floor(fill * dep.length))];
    for (const q of qs) E.set(list[q], dot(P(list[q]), g) > cut ? fluidId : gasId);
    if (qs.length * s[0] * s[1] * s[2] > 4) levels++;        // a loop that holds more than 4 ml
  }
  return levels;
}
/* SMALL BOWEL OBSTRUCTION: the small bowel distended with gas and fluid (here at its own calibre:
   the model's loops are drawn as segmented, and swelling them would fuse neighbours across their
   walls), the colon beyond the obstruction emptied of gas. */
function sbo(ctx, { posture = 'supine' } = {}) {
  // the collapsed colon first: the gas the model has goes (it lies in the colon and stomach)
  const gas = organ(ctx, new Set([GAS]));
  if (gas) for (const o of gas.list) ctx.E.set(o, COLON);
  const sb = organ(ctx, new Set([SB]));
  if (!sb) throw new Error('no small bowel');
  const levels = bowelFluid(ctx.E, ctx.vol, sb.list, gravity(ctx, posture), { fill: 0.4, right: ctx.trunk().right });
  return { posture, loops: levels };
}
/* FAECAL LOADING: the colon full of stool, which on a film is mottled: soft tissue with small
   pockets of gas through it. The colon's lumen is filled with a two-scale noise thresholded so
   about a third is gas. */
function fecalLoading(ctx) {
  const col = organ(ctx, new Set([COLON, GAS]));
  if (!col) throw new Error('no colon');
  const [nx, ny] = ctx.vol.dims, s = spacing(ctx.vol);
  let gas = 0;
  for (const o of col.list) {
    const [i, j, k] = ijk(o, nx, ny), p = [i * s[0], j * s[1], k * s[2]];
    const v = 0.65 * noise3(p, 0.7, 71) + 0.35 * noise3(p, 0.3, 72);
    if (v > 0.12) { ctx.E.set(o, GAS); gas++; } else ctx.E.set(o, SOFT);
  }
  return { gasFraction: +(gas / col.list.length).toFixed(2) };
}
/* A KIDNEY STONE: a 1.3 cm calcium oxalate stone in the renal pelvis (the kidney's middle, a
   third of the way to its medial edge), irregular as they are. */
function kidneyStone(ctx, { side = 'R', size = 0.65 } = {}) {
  const T = ctx.trunk(), k = organ(ctx, new Set([KIDNEY]), { side });
  if (!k) throw new Error('no kidney on that side');
  const pts = [], [nx, ny] = ctx.vol.dims, s = spacing(ctx.vol);
  for (const o of k.list) { const [i, j, kk] = ijk(o, nx, ny); pts.push(i * s[0], j * s[1], kk * s[2]); }
  const pa = principalAxes(pts);
  const med = mul(T.right, side === 'L' ? 1 : -1);
  const c = add(pa.c, mul(med, 0.8 * pa.sd[1]));
  fillShape(ctx.E, ctx.vol, { ellipsoid: { c, r: [size, size * 0.8, size * 0.75] } }, STONE, { jitter: 0.12, seed: 81 });
  return { at: c, side };
}
/* The lumbar vertebral bodies, found as the bone along the column between its discs: the bone in
   a 2 cm disc round the body's centre line, slice by slice, has a minimum at each disc. Returns
   the disc heights (cm) from the iliac crest (L4-5) up. */
function lumbarDiscs(ctx) {
  const { vol } = ctx, d = vol.data, [nx, ny, nz] = vol.dims, s = spacing(vol);
  const crest = ctx.point('crest');
  const prof = [];
  for (let k = Math.max(0, Math.round((crest[2] - 1) / s[2])); k < Math.min(nz, Math.round((crest[2] + 22) / s[2])); k++) {
    let c = 0;
    const B = boxR(vol, [crest[0], crest[1], k * s[2]], [2.0, 1.4, 0]);
    forBox(vol, B, (i, j, kk, o) => { if (BONE.has(d[o])) c++; });
    prof.push([k * s[2], c]);
  }
  // smooth, then the minima at least 2.4 cm apart, lowest first
  const sm = prof.map((p, n) => [p[0], (prof[n - 1]?.[1] ?? p[1]) * 0.25 + p[1] * 0.5 + (prof[n + 1]?.[1] ?? p[1]) * 0.25]);
  const minima = [];
  for (let n = 1; n < sm.length - 1; n++) {
    if (sm[n][1] > sm[n - 1][1] || sm[n][1] > sm[n + 1][1]) continue;
    const z = sm[n][0];
    if (minima.length && z - minima[minima.length - 1].z < 2.4) { if (sm[n][1] < minima[minima.length - 1].c) minima[minima.length - 1] = { z, c: sm[n][1] }; continue; }
    minima.push({ z, c: sm[n][1] });
  }
  return { crest, discs: minima.map((m) => m.z) };
}
/* L1 WEDGE COMPRESSION: the body of L1 a third shorter in front than behind, its top endplate
   tilted down to the front, a band of compacted bone under it. Column by column through the
   body, the run of bone that holds the body's middle is found (the endplates are not flat, and
   the disc minima only say roughly where they are) and squeezed toward its own lower end, by
   more the further forward it is, so the body keeps its outline and only its height goes. The
   space it leaves under the disc above is soft tissue; the disc itself is not touched. The body
   is placed by its front: the most anterior bone on the midline at its mid-height, less half a
   body's depth. */
function l1Compression(ctx, { loss = 0.38 } = {}) {
  const { vol, E } = ctx, d = vol.data, [nx, ny] = vol.dims, s = spacing(vol), T = ctx.trunk();
  const { crest, discs } = lumbarDiscs(ctx);
  // from L4-5 at the crest: L3-4, L2-3, L1-2, T12-L1
  const up = discs.filter((z) => z > crest[2] + 1.2);
  if (up.length < 4) throw new Error('lumbar discs not found');
  const zi = up[2], zs = up[3], zm = (zi + zs) / 2, km = Math.round(zm / s[2]);
  // the body's front on the midline at mid-height
  let front = -Infinity;
  for (let j = 0; j < ny; j++) {
    const p = [crest[0], j * s[1], zm], a = dot(p, T.ant);
    if (Math.abs(p[1] - crest[1]) < 5 && BONE.has(d[(km * ny + j) * nx + Math.round(crest[0] / s[0])]) && a > front) front = a;
  }
  if (front === -Infinity) throw new Error('no L1 body');
  const depth = 3.2, c = add([crest[0], 0, zm], mul(T.ant, front - depth / 2));
  c[1] = T.ant[1] ? (front - depth / 2) * T.ant[1] : crest[1];
  const kLo = Math.max(0, Math.round((zi - 0.8) / s[2])), kHi = Math.round((zs + 0.8) / s[2]);
  const B = boxR(vol, c, [2.6, depth / 2 + 0.2, 0]);
  let n = 0;
  for (let j = B[1][0]; j <= B[1][1]; j++) for (let i = B[0][0]; i <= B[0][1]; i++) {
    const p = [i * s[0], j * s[1], zm];
    const e = ((p[0] - c[0]) / 2.4) ** 2 + (dot(sub(p, c), T.ant) / (depth / 2)) ** 2;
    if (e > 1) continue;
    const col = (k) => d[(k * ny + j) * nx + i];
    if (!BONE.has(col(km))) continue;
    // this column's run of bone through the middle: its endplates
    let bot = km, top = km;
    while (bot > kLo && BONE.has(col(bot - 1))) bot--;
    while (top < kHi && BONE.has(col(top + 1))) top++;
    const a = clamp((dot(sub(p, c), T.ant) + depth / 2) / depth, 0, 1);   // 0 at the back, 1 at the front
    const sc = 1 - loss * a * (1 - 0.5 * e);                // less at the body's sides
    const h = top - bot + 1, nh = Math.max(1, Math.round(h * sc));
    const orig = [];
    for (let k = bot; k <= top; k++) orig.push(col(k));
    for (let t = 0; t < h; t++) {
      const k = bot + t, o = (k * ny + j) * nx + i;
      let m;
      if (t >= nh) m = SOFT;
      else {
        m = orig[Math.min(h - 1, Math.round(t / sc))];
        if (nh - t <= Math.round(0.5 / s[2]) && a > 0.25) m = 59;  // compacted under the endplate
      }
      if (m !== orig[t]) { E.set(o, m); n++; }
    }
  }
  return { level: 'L1', discs: [zi, zs], voxels: n };
}
/* The femur of one side, cut free of the pelvis as core/limbPose.js does for the leg rotation,
   as a bone component: { B, W, H, D, mask, list, pts, has }. */
function femurComp(ctx, side) {
  const lm = ctx.landmarks[side === 'L' ? 'femoralHeadL' : 'femoralHeadR'];
  if (!lm) throw new Error('no femoral head landmark');
  const { vol } = ctx, s = spacing(vol), [nx, ny] = vol.dims;
  const f = segmentFemur({ dims: vol.dims, vs: s, data: vol.data }, lm);
  if (!f) throw new Error('no femur');
  const { i0, bx, by, bz } = f.box;
  const B = [[i0, i0 + bx - 1], [0, by - 1], [0, bz - 1]];
  const list = [], pts = [];
  for (let k = 0; k < bz; k++) for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) {
    if (!f.mask[(k * by + j) * bx + i]) continue;
    list.push((k * ny + j) * nx + i0 + i); pts.push((i0 + i) * s[0], j * s[1], k * s[2]);
  }
  const head = ctx.point(side === 'L' ? 'femoralHeadL' : 'femoralHeadR');
  return { B, W: bx, H: by, D: bz, mask: f.mask, list: Int32Array.from(list), pts: Float32Array.from(pts), head, r: lm.r || 2.2 };
}
/* The femoral neck's axis: from the head's centre to the middle of the bone 2.5-4.5 cm out. */
function neckAxis(fc) {
  let c = [0, 0, 0], n = 0;
  for (let q = 0; q < fc.list.length; q++) {
    const p = [fc.pts[3 * q], fc.pts[3 * q + 1], fc.pts[3 * q + 2]], r = len(sub(p, fc.head));
    if (r > 2.5 && r < 4.5 && p[2] > fc.head[2] - 3) { c = add(c, p); n++; }
  }
  return nrm(sub(mul(c, 1 / n), fc.head));
}
/* The femoral shaft's axis, from its cross-sections in the volume's lowest 5 cm. */
function shaftLine(fc) {
  let zmin = Infinity;
  for (let q = 0; q < fc.list.length; q++) zmin = Math.min(zmin, fc.pts[3 * q + 2]);
  const lo = [], hi = [];
  for (let q = 0; q < fc.list.length; q++) {
    const p = [fc.pts[3 * q], fc.pts[3 * q + 1], fc.pts[3 * q + 2]];
    if (p[2] < zmin + 1.5) lo.push(p); else if (p[2] > zmin + 3.5 && p[2] < zmin + 5) hi.push(p);
  }
  const m = (a) => mul(a.reduce((x, y) => add(x, y), [0, 0, 0]), 1 / a.length);
  const a = m(lo), b = m(hi);
  return { p: a, dir: nrm(sub(b, a)) };
}
/* FEMORAL NECK (subcapital, Garden III): the head tipped ~20 degrees into varus about its own
   centre, so it stays in the acetabulum, and the neck's trabeculae meet it at an angle. */
function femoralNeck(ctx, { side = 'R' } = {}) {
  const fc = femurComp(ctx, side), ax = neckAxis(fc), T = ctx.trunk();
  const p0 = add(fc.head, mul(ax, fc.r * 0.75));
  const comp = { ...fc, has: null };
  fracturePlane(ctx.E, ctx.vol, comp, { p0, n: ax, gap: 0.2, rough: 0.12, seed: 91,
    move: { side: -1, axis: T.ant, deg: (side === 'L' ? -1 : 1) * 20, pivot: fc.head } });
  return { at: p0, side };
}
/* TOTAL HIP REPLACEMENT: the femoral head and neck taken off at the neck cut, a polished
   cobalt-chrome head (32 mm, drawn as steel) in a polyethylene liner (soft tissue) in a titanium
   cup set in the acetabulum (45 degrees of inclination), and a titanium stem down the femoral
   canal, tapered, cut off where the volume ends. The cup's shell sits outside the joint's
   cartilage, and the cartilage is left as it was: it reads as the liner does. */
function hipArthroplasty(ctx, { side = 'R' } = {}) {
  const { vol, E } = ctx, d = vol.data, T = ctx.trunk();
  const fc = femurComp(ctx, side), ax = neckAxis(fc), sh = shaftLine(fc);
  const lat = mul(T.right, side === 'L' ? -1 : 1);
  // the neck cut: across the neck's base, 3.4 cm out from the head's centre
  const cut = add(fc.head, mul(ax, 3.4));
  for (let q = 0; q < fc.list.length; q++) {
    const p = [fc.pts[3 * q], fc.pts[3 * q + 1], fc.pts[3 * q + 2]];
    if (dot(sub(p, cut), ax) < 0 && BONE.has(d[fc.list[q]])) E.set(fc.list[q], SOFT);
  }
  // the cup: a hemispherical shell opening down and out at 45 degrees
  const open = nrm(add(mul(lat, Math.SQRT1_2), mul(T.sup, -Math.SQRT1_2)));
  const rIn = fc.r + 0.25, rOut = rIn + 0.35;
  forBox(vol, boxR(vol, fc.head, rOut + 0.2), (i, j, k, o, p) => {
    const v = sub(p, fc.head), r = len(v);
    if (r < rIn || r > rOut || dot(v, open) > 0.15) return;
    E.set(o, TITANIUM);
  });
  // the femoral head (in the liner: what lies between it and the cup reads as polyethylene)
  forBox(vol, boxR(vol, fc.head, rIn), (i, j, k, o, p) => {
    const r = len(sub(p, fc.head));
    if (r < 1.6) E.set(o, STEEL); else if (r < rIn && BONE.has(d[o])) E.set(o, SOFT);
  });
  // the stem: from the head along the neck to the shoulder over the canal, then down the canal
  const tLT = dot(sub(fc.head, sh.p), sh.dir);
  const shoulder = add(sh.p, mul(sh.dir, tLT - 3.5));
  fillShape(E, vol, { cylinder: { p0: fc.head, p1: shoulder, r: [0.55, 0.75] } }, TITANIUM);
  fillShape(E, vol, { cylinder: { p0: shoulder, p1: add(shoulder, mul(sh.dir, -14)), r: [0.75, 0.42] } }, TITANIUM);
  return { side };
}
/* PUBIC RAMI: the superior and inferior rami of one side broken, each a 2 mm step. The
   symphysis is the midline bone in front, below the femoral heads. */
function pubicRami(ctx, { side = 'R' } = {}) {
  const { vol } = ctx, d = vol.data, [nx, ny] = vol.dims, s = spacing(vol), T = ctx.trunk();
  const hR = ctx.point('femoralHeadR'), hL = ctx.point('femoralHeadL');
  const mid = (hR[0] + hL[0]) / 2, zH = (hR[2] + hL[2]) / 2;
  // the symphysis: the most anterior bone within 1.5 cm of the midline, 0-8 cm below the heads
  let sym = null, best = -Infinity;
  for (let k = Math.max(0, Math.round((zH - 8) / s[2])); k <= Math.round(zH / s[2]); k++) for (let j = 0; j < ny; j++) for (let i = Math.round((mid - 1.5) / s[0]); i <= Math.round((mid + 1.5) / s[0]); i++) {
    if (!BONE.has(d[(k * ny + j) * nx + i])) continue;
    const a = dot([i * s[0], j * s[1], k * s[2]], T.ant);
    if (a > best) { best = a; sym = [i * s[0], j * s[1], k * s[2]]; }
  }
  if (!sym) throw new Error('no symphysis');
  const head = side === 'L' ? hL : hR, lat = mul(T.right, side === 'L' ? -1 : 1);
  const out = [];
  for (const [anchor, seed] of [[add(sym, mul(sub(head, sym), 0.4)), 92], [add(add(sym, mul(lat, 2.6)), mul(T.sup, -2.6)), 93]]) {
    const comp = boneNear(vol, anchor, { r: 2.0, erodeCm: 0.2, minCm3: 1 });
    if (!comp) continue;
    const pa = principalAxes(comp.pts);
    fracturePlane(ctx.E, vol, comp, { p0: pa.c, n: pa.axes[0], gap: 0.2, rough: 0.08, seed,
      move: { side: 1, shift: mul(T.sup, -0.25), falloff: 1.5 } });
    out.push(pa.c);
  }
  if (!out.length) throw new Error('no pubic rami');
  return { at: out, side };
}

/* ---------------------------------------------------------------------------
   THE HEAD AND NECK (1.5 mm; +i right, +j anterior, +k up). The airway is drawn as lung
   material (and air) inside the neck. */
const AIRWAY = new Set([AIR, LUNG]);
/* The cervical levels: each body's centre, stepped from C4 along the neck's axis (joints.json)
   by the spacing C1-2 to C7-T1 gives. */
function cervical(ctx) {
  const c4 = ctx.point('C4'), c12 = ctx.point('C1C2'), c7 = ctx.point('C7T1');
  const axis = ctx.joints.neck ? ctx.restDir(ctx.joints.neck.distal) : [0, 0, 1];
  const step = (c12[2] - c7[2]) / 5.5;                      // C1-2 to C7-T1 is five and a half levels
  return { c4, axis, step, body: (n) => add(c4, mul(axis, (4 - n) * step)) };
}
/* The airway in front of the spine at a body's level: the first run of air met going forward
   from the body's front, on the midline: { from, to } (cm along +j, at the point's i and k). */
function airwayAhead(ctx, p, ant) {
  const { vol } = ctx, d = vol.data, [nx, ny] = vol.dims, s = spacing(vol);
  const i = Math.round(p[0] / s[0]), k = Math.round(p[2] / s[2]);
  let j = Math.round(p[1] / s[1]), from = -1, to = -1;
  const stepJ = ant[1] > 0 ? 1 : -1;
  for (let t = 0; t < Math.round(6 / s[1]); t++, j += stepJ) {
    if (j < 0 || j >= ny) break;
    const air = AIRWAY.has(d[(k * ny + j) * nx + i]);
    if (air && from < 0) from = j;
    if (!air && from >= 0) { to = j - stepJ; break; }
  }
  return from < 0 ? null : { from: from * s[1], to: (to < 0 ? from : to) * s[1] };
}
/* CERVICAL SPONDYLOSIS: anterior osteophytes at the corners of C4, C5 and C6 (lipping, a beak
   toward each disc), and the endplates a little sclerotic. Discs and facet joints untouched. */
function cspineOA(ctx) {
  const { vol, E } = ctx, T = ctx.trunk(), C = cervical(ctx);
  let n = 0;
  for (const lev of [4, 5, 6]) {
    const c = C.body(lev);
    const front = surfaceAlong(vol, c, T.ant, 3);
    if (!front) continue;
    for (const sg of [1, -1]) {
      // the corner: 40 % of a level up or down from the body's middle, at its front
      const corner = add(add(front, mul(C.axis, sg * 0.36 * C.step)), mul(T.ant, -0.05));
      const edge = surfaceAlong(vol, sub(corner, mul(T.ant, 0.6)), T.ant, 1.5) || corner;
      const disc = add(c, mul(C.axis, sg * 0.5 * C.step));
      osteophyte(E, vol, { base: edge, out: nrm(add(T.ant, mul(C.axis, sg * 0.55))), along: [1, 0, 0], size: 0.55, thick: 0.24,
        keep: { p: disc, n: mul(C.axis, -sg) }, seed: 100 + lev * 2 + (sg > 0 ? 1 : 0) });
      n++;
    }
  }
  return { osteophytes: n };
}
/* CLAY-SHOVELER'S FRACTURE of C6: the tip of the spinous process broken off and pulled down
   3 mm. The process is the last bone met going back from the body. */
function c6Spinous(ctx) {
  const { vol } = ctx, T = ctx.trunk(), C = cervical(ctx);
  const c = add(C.body(6), mul(C.axis, -0.4 * C.step));     // the processes slope down
  // the tip: the most posterior bone within 1 cm of the midline, a third of a level up or down,
  // and no more than 7 cm behind the body
  const d = vol.data;
  let tip = null, best = -Infinity;
  forBox(vol, boxR(vol, c, [1.0, 7, 0.35 * C.step]), (i, j, k, o, p) => {
    if (!BONE.has(d[o])) return;
    const b = -dot(sub(p, c), T.ant);
    if (b > best) { best = b; tip = [p[0], p[1], p[2]]; }
  });
  if (!tip || best < 2) throw new Error('no spinous process');
  const comp = boneNear(vol, add(tip, mul(T.ant, 0.6)), { r: 1.6, erodeCm: 0.15, minCm3: 0.2 });
  if (!comp) throw new Error('no spinous process');
  let ax = principalAxes(comp.pts).axes[0];
  if (dot(ax, T.ant) > 0) ax = mul(ax, -1);                 // pointing back, to the tip
  const p0 = sub(tip, mul(ax, 0.9));
  fracturePlane(ctx.E, vol, comp, { p0, n: ax, gap: 0.15, rough: 0.05, seed: 111,
    move: { side: 1, shift: add(mul(C.axis, -0.3), mul(ax, 0.1)) } });
  return { at: p0 };
}
/* EPIGLOTTITIS: the epiglottis swollen to a thumb (the thumb sign), the aryepiglottic folds
   thick behind it, the vallecula gone: soft tissue filling the front of the airway at C3,
   leaning back as the epiglottis does. Written over the airway only. */
function epiglottitis(ctx) {
  const T = ctx.trunk(), C = cervical(ctx);
  const c3 = C.body(3);
  const aw = airwayAhead(ctx, add(c3, mul(T.ant, 0.8)), T.ant);
  if (!aw) throw new Error('no airway at C3');
  const front = [c3[0], aw.to, c3[2]], width = Math.abs(aw.to - aw.from);
  const lean = nrm(add(C.axis, mul(T.ant, -0.5)));          // up and back
  const thumb = sub(front, mul(T.ant, 0.25 * width + 0.2));
  const E = ctx.E, vol = ctx.vol;
  fillShape(E, vol, { ellipsoid: { c: add(thumb, mul(C.axis, 0.2)), r: [0.75, 0.45, 1.1], axes: [[1, 0, 0], orth(T.ant, lean), lean] } }, SOFT, { over: AIRWAY, jitter: 0.08, seed: 121 });
  const folds = add(sub(thumb, mul(C.axis, 0.9)), mul(T.ant, -0.35 * width));
  fillShape(E, vol, { ellipsoid: { c: folds, r: [0.9, 0.3, 0.7] } }, SOFT, { over: AIRWAY, jitter: 0.06, seed: 122 });
  return { at: thumb, airwayCm: +width.toFixed(2) };
}
/* ADENOIDS: hypertrophied adenoid tissue on the roof and back wall of the nasopharynx, a convex
   soft-tissue mass narrowing the airway behind the soft palate. Written over the airway only. */
function adenoids(ctx) {
  const T = ctx.trunk(), C = cervical(ctx);
  const p = add(C.body(1), mul(C.axis, 1.6));               // above the atlas: the nasopharynx
  const aw = airwayAhead(ctx, p, T.ant);
  if (!aw) throw new Error('no nasopharynx');
  const back = [p[0], aw.from, p[2]];
  fillShape(ctx.E, ctx.vol, { ellipsoid: { c: add(add(back, mul(T.ant, 0.15)), mul(C.axis, 0.5)), r: [1.1, 0.75, 1.2] } }, SOFT, { over: AIRWAY, jitter: 0.1, seed: 131 });
  return { at: back };
}

/* ===========================================================================
   THE CATALOGUE: every id of trainer/hospitalProtocols.js PATHOLOGY_IDS.
   { subject, label, build(ctx, opts) } — or available: false with why, and the trainer then
   takes the patient as normal. */
export const PATHOLOGY = {
  distalRadiusFx: { subject: 'hand', label: 'Distal radius fracture (Colles)', build: (ctx) => colles(ctx) },
  radialHeadFx: { subject: 'upperextremity', label: 'Radial head fracture', available: false,
    why: 'the radial head here is a thin shell of 1 mm voxels: a Mason II split, 3 mm apart, changes the AP and lateral elbow by less than their noise',
    build: (ctx) => radialHead(ctx) },
  humerusNeckFx: { subject: 'upperextremity', label: 'Surgical neck of humerus fracture', build: (ctx) => humerusNeck(ctx) },
  humerusShaftFx: { subject: 'upperextremity', label: 'Humeral shaft fracture', build: (ctx) => humerusShaft(ctx) },
  forearmShaftFx: { subject: 'upperextremity', label: 'Both-bone forearm fracture', build: (ctx) => forearmShaft(ctx) },
  clavicleFx: { subject: 'chest', label: 'Midshaft clavicle fracture', available: false,
    why: 'the chest volume ends at the medial third of the clavicles: the midshaft, where most break, is outside it' },
  ribFxAnterior: { subject: 'chest', label: 'Anterior rib fracture', build: (ctx, o) => ribFracture(ctx, { side: o.side || 'R', bearing: 'anterior', drop: 1.5 }) },
  ribFxPosterior: { subject: 'chest', label: 'Posterior rib fracture', build: (ctx, o) => ribFracture(ctx, { side: o.side || 'R', bearing: 'posterior', drop: 3.0 }) },
  pneumothorax: { subject: 'chest', label: 'Pneumothorax', build: (ctx, o) => pneumothorax(ctx, { side: o.side || 'R', posture: o.posture || 'erect', expiration: !!o.expiration }) },
  pneumonia: { subject: 'chest', label: 'Lobar pneumonia (lower lobe)', build: (ctx, o) => pneumonia(ctx, { side: o.side || 'R' }) },
  effusion: { subject: 'chest', label: 'Pleural effusion', build: (ctx, o) => effusion(ctx, { side: o.side || 'R', posture: o.posture || 'erect' }) },
  weberBFx: { subject: 'foot', label: 'Weber B fracture of the distal fibula', build: (ctx) => weberB(ctx) },
  mt5BaseFx: { subject: 'foot', label: 'Fracture of the base of the 5th metatarsal', build: (ctx) => mt5Base(ctx) },
  femoralNeckFx: { subject: 'chestabdopelvis', label: 'Subcapital femoral neck fracture', build: (ctx, o) => femoralNeck(ctx, { side: o.side || 'R' }) },
  hipArthroplasty: { subject: 'chestabdopelvis', label: 'Total hip arthroplasty', build: (ctx, o) => hipArthroplasty(ctx, { side: o.side || 'R' }) },
  pubicRamiFx: { subject: 'chestabdopelvis', label: 'Superior and inferior pubic rami fractures', available: false,
    why: 'at 2 mm the rami are 6-7 voxels thick: the breaks are drawn (force: true) but on the AP pelvis they read as noise in the obturator ring',
    build: (ctx, o) => pubicRami(ctx, { side: o.side || 'R' }) },
  acetabularFx: { subject: 'chestabdopelvis', label: 'Acetabular fracture', available: false,
    why: 'at 2 mm the femoral head and the acetabulum fuse and the columns are a few voxels thick; a transverse line through them reads as noise, and the Judet views that show it are not in the room' },
  sbo: { subject: 'chestabdopelvis', label: 'Small bowel obstruction', build: (ctx, o) => sbo(ctx, { posture: o.posture || 'supine' }) },
  kidneyStone: { subject: 'chestabdopelvis', label: 'Renal calculus', build: (ctx, o) => kidneyStone(ctx, { side: o.side || 'R' }) },
  fecalLoading: { subject: 'chestabdopelvis', label: 'Faecal loading', build: (ctx) => fecalLoading(ctx) },
  l1CompressionFx: { subject: 'chestabdopelvis', label: 'L1 wedge compression fracture', available: false,
    why: 'at 2 mm the wedge is 4-6 voxels and L1 lies at the edge of the lateral lumbar field, under the diaphragm: drawn (force: true) but not readable',
    build: (ctx) => l1Compression(ctx) },
  coccyxFx: { subject: 'chestabdopelvis', label: 'Coccyx fracture', available: false,
    why: 'at 2 mm the coccygeal segments are 3-4 voxels thick: a break or an angulation of them cannot be drawn without inventing the bone' },
  epiglottitis: { subject: 'headneck', label: 'Epiglottitis', build: (ctx) => epiglottitis(ctx) },
  adenoids: { subject: 'headneck', label: 'Enlarged adenoids', available: false,
    why: 'the model is an adult whose nasopharynx is drawn at lung density, under the skull base: the mass is drawn (force: true) but on the lateral it is a faint density, not an airway narrowed',
    build: (ctx) => adenoids(ctx) },
  cspineOA: { subject: 'headneck', label: 'Cervical spondylosis: anterior osteophytes', available: false,
    why: 'at 1.5 mm the prevertebral space in front of the bodies is 2-3 voxels before the airway: beaks big enough to see would grow into the airway',
    build: (ctx) => cspineOA(ctx) },
  c6SpinousFx: { subject: 'headneck', label: 'C6 spinous process fracture (clay-shoveler)', available: false,
    why: 'this model has the arms down: the shoulders cover C6-C7 on the lateral, so the fracture is drawn (force: true) but cannot be seen',
    build: (ctx) => c6Spinous(ctx) },
  tibialShaftFx: { subject: 'lowerextremity', label: 'Tibial shaft fracture', build: (ctx) => tibialShaft(ctx) },
  tibialPlateauFx: { subject: 'lowerextremity', label: 'Lateral tibial plateau fracture', build: (ctx) => tibialPlateau(ctx) },
  kneeOA: { subject: 'lowerextremity', label: 'Knee osteoarthritis: osteophytes and subchondral sclerosis', build: (ctx) => kneeOA(ctx) },
  patellaFx: { subject: 'lowerextremity', label: 'Transverse patella fracture', build: (ctx) => patella(ctx) },
  femurShaftFx: { subject: 'lowerextremity', label: 'Femoral shaft fracture', build: (ctx) => femurShaft(ctx) },
  scaphoidWaistFx: { subject: 'hand', label: 'Scaphoid waist fracture', build: (ctx) => scaphoidWaist(ctx) },
  boxerFx: { subject: 'hand', label: "Boxer's fracture (5th metacarpal neck)", build: (ctx) => boxer(ctx) },
  raHand: { subject: 'hand', label: 'Rheumatoid arthritis: osteopenia and marginal erosions', build: (ctx) => rheumatoid(ctx) },
  castWrist: { subject: 'hand', label: 'Reduced distal radius fracture in plaster', build: (ctx) => castWrist(ctx) },
};
