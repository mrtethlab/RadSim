/* CT FILM: the artefacts, each a scan of the model simulated with its cause (simct.js) and
   reconstructed by filtered back-projection, beside the same scan without it. Every image here is
   computed, none drawn: what the artefact looks like is what the physics gives. HU images, N x N.
     cupping       the head, the water correction off and on
     starvation    the shoulders at a low dose: the same mA at every angle, and modulated
     metal         the pelvis with a steel femoral head, and without
     rods          the app's metal phantom with titanium rods: water-corrected, and as an ideal beam
     motion        the chest still; breathing through the turn; the heart beating
     ring          the abdomen with one element a few per cent off in gain
     aliasing      the pelvis from 24 views over the half turn, and from 360
     truncation    the abdomen centred, and off centre past the edge of the 50 cm field
     partialVolume the lung bases, a 2 mm slice and a 10 mm one over the dome of the liver
     windmill      the lower chest, a slice interpolated from helical rows, and the true slice
     coneBeam      the lower chest, the outermost row's slice of an axial scan (a 160 mm wide
                   detector), and the true one */
import { grids, project, paths, measure, fbp, toHU, polyP, MU70, STEEL, rng } from './simct.js';
import { MUW70 } from './slice.js';
// the focal spot's distance from the isocentre, cm (rig.js F; not imported: this runs in a worker,
// and the rig pulls in the app's scene code)
const F = 57;

export const N = 128;
const hu = (mu) => Float32Array.from(mu, toHU);
const still = (G) => (a, ax, ay, bx, by) => paths(G, ax, ay, bx, by);
// the bin's distance from the centre (grid pixels)
const ub = (b) => b + 0.5 - N / 2;

// ---------------------------------------------------------------- beam hardening
export function cupping(head) {
  const G = grids(head, N, { pxCm: 0.15 });
  const P = project(N, 180, false, still(G), 2);
  const cor = fbp(measure(P.poly), G.d), raw = fbp(measure(P.poly, { correct: false }), G.d);
  // without the correction the numbers are scaled to water through the head's own width
  const k = MUW70 / (polyP(16, 0, 0) / 16);
  return { G, cor: hu(cor), raw: Float32Array.from(raw, (m) => toHU(m * k)) };
}
/* Dense objects: the app's metal test phantom (a water box, three rods 12 mm across, 1 mm voxels)
   with titanium rods, so that what shows is beam hardening, not the photons running out: each
   ray through two rods is hardened more than the water correction allows for and reads low. */
export function rods(phantom, metal = 25) {
  const ids = Uint8Array.from(phantom.ids, (id) => (id === 27 ? metal : id));
  const G = grids(phantom, N, { pxCm: 0.1, ids, metal, side: 240 });
  const P = project(N, 180, false, still(G), 2, true, metal);
  return { G, water: hu(fbp(measure(P.poly), G.d)), ideal: hu(fbp(P.mono, G.d)) };
}

// ---------------------------------------------------------------- photon starvation
export function starvation(shoulder, I0 = 3e4) {
  const G = grids(shoulder, N);
  const P = project(N, 180, false, still(G), 2);
  // each view's thickest path; angular modulation: the mA follows it, the mean unchanged
  const pmax = Array.from({ length: 180 }, (_, a) => { let m = 0; for (let b = 0; b < N; b++) m = Math.max(m, P.poly.p[a * N + b]); return m; });
  const mean = pmax.reduce((s, v) => s + v, 0) / 180;
  const raw = pmax.map((v) => Math.exp(0.5 * (v - mean))), z = raw.reduce((s, v) => s + v, 0) / 180;
  const i0 = (a) => raw[a] / z;
  const cnt = (a, mod) => Math.round(I0 * (mod ? i0(a) : 1) * Math.exp(-P.poly.p[a * N + N / 2]));
  return {
    G, I0, flat: hu(fbp(measure(P.poly, { I0, seed: 3 }), G.d)), tcm: hu(fbp(measure(P.poly, { I0, i0, seed: 3 }), G.d)),
    counts: { lat: cnt(90, false), ap: cnt(0, false), latTcm: cnt(90, true), apTcm: cnt(0, true) }, mA: { lat: i0(90), ap: i0(0) },
  };
}

// ---------------------------------------------------------------- metal
export function metal(pelvis, I0 = 1e5) {
  // the femoral head on the patient's right (the image's left): the bone's centroid there
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < pelvis.h; y++) for (let x = 0; x < pelvis.w * 0.4; x++) { const id = pelvis.ids[y * pelvis.w + x]; if (id === 17 || id === 18) { sx += x; sy += y; n++; } }
  const cx = sx / n, cy = sy / n, R = 7.5;            // a 30 mm head (image pixels 2 mm)
  const ids = Uint8Array.from(pelvis.ids);
  for (let y = 0; y < pelvis.h; y++) for (let x = 0; x < pelvis.w; x++) if (Math.hypot(x - cx, y - cy) < R) ids[y * pelvis.w + x] = STEEL;
  const G0 = grids(pelvis, N), G1 = grids(pelvis, N, { ids });
  const P0 = project(N, 180, false, still(G0), 2), P1 = project(N, 180, false, still(G1), 2);
  const side = Math.max(pelvis.w, pelvis.h), at = [(cx + (side - pelvis.w) / 2) * N / side, (cy + (side - pelvis.h) / 2) * N / side];
  return { G: G1, clean: hu(fbp(measure(P0.poly, { I0, seed: 5 }), G0.d)), metal: hu(fbp(measure(P1.poly, { I0, seed: 5 }), G1.d)), at, r: R * N / side };
}

// ---------------------------------------------------------------- motion
// bilinear mu of a grid at (c, r) grid pixels
function bil(mu, c, r) {
  const c0 = Math.floor(c - 0.5), r0 = Math.floor(r - 0.5), fc = c - 0.5 - c0, fr = r - 0.5 - r0;
  let s = 0;
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const cc = c0 + i, rr = r0 + j;
    if (cc >= 0 && rr >= 0 && cc < N && rr < N) s += mu[rr * N + cc] * (i ? fc : 1 - fc) * (j ? fr : 1 - fr);
  }
  return s;
}
/* A patient moving through the turn: view a sees the slice warped, each point of it where
   inv(a, x, y) says it came from; mu summed along each ray through the warped slice. A full turn
   of views, NA of them; mono (70 keV). */
function warped(mu, d, NA, inv) {
  const p = new Float32Array(NA * N), cx = N / 2, cy = N / 2;
  for (let a = 0; a < NA; a++) {
    const ph = (a / NA) * 2 * Math.PI, dx = Math.sin(ph), dy = Math.cos(ph), ux = dy, uy = -dx;
    for (let b = 0; b < N; b++) {
      let acc = 0;
      for (let s = 0; s < 2; s++) {
        const u = b + (s + 0.5) / 2 - N / 2, ox = cx + ux * u, oy = cy + uy * u;
        for (let t = -N * 0.72; t < N * 0.72; t += 0.7) {
          const x = ox + dx * t, y = oy + dy * t;
          if (x < 0 || y < 0 || x >= N || y >= N) continue;
          const [X, Y] = inv(a, x, y);
          acc += bil(mu, X, Y);
        }
      }
      p[a * N + b] = acc * 0.7 * d / 2;
    }
  }
  return { NA, NB: N, p, full: true };
}
/* Motion during the turn (0.5 s, NA views): still; breathing in, the chest wall rising 10 % of the
   depth from the spine forward over the turn; the heart beating (0.8 s a beat), its outline
   swelling and shrinking 20 % about its centre (its wall moving about a centimetre) and
   pushing the lung round it. */
export function motion(chest, NA = 360) {
  const G = grids(chest, N);
  const P0 = warped(G.mu, G.d, NA, (a, x, y) => [x, y]);
  let yb = 0; for (let r = N - 1; r >= 0 && !yb; r--) for (let c = 0; c < N; c++) if (G.mu[r * N + c] > 0.05) { yb = r + 1; break; }
  const breathe = (a) => 0.1 * (0.5 - 0.5 * Math.cos(Math.PI * a / NA));
  const P1 = warped(G.mu, G.d, NA, (a, x, y) => [x, yb + (y - yb) / (1 + breathe(a))]);
  const HEART = new Set([15, 42]);
  let hx = 0, hy = 0, hn = 0;
  const side = Math.max(chest.w, chest.h), ox = (side - chest.w) / 2, oy = (side - chest.h) / 2;
  for (let y = 0; y < chest.h; y++) for (let x = 0; x < chest.w; x++) if (HEART.has(chest.ids[y * chest.w + x])) { hx += x; hy += y; hn++; }
  const hc = [(hx / hn + ox) * N / side, (hy / hn + oy) * N / side], Rh = Math.sqrt(hn / Math.PI) * N / side;
  const beat = (a) => 0.2 * Math.sin(2 * Math.PI * (a / NA) * (0.5 / 0.8));
  const P2 = warped(G.mu, G.d, NA, (a, x, y) => {
    // inside the heart's radius it scales by 1 + e; beyond, the push fades out by 1.7 radii
    const e = beat(a), dx = x - hc[0], dy = y - hc[1], r = Math.hypot(dx, dy) || 1e-6;
    const g = r < Rh ? 1 : r > 1.7 * Rh ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * (r - Rh) / (0.7 * Rh));
    const k = 1 / (1 + e * g * (r < Rh ? 1 : Rh / r));
    return [hc[0] + dx * k, hc[1] + dy * k];
  });
  return { G, still: hu(fbp(P0, G.d)), breathing: hu(fbp(P1, G.d)), cardiac: hu(fbp(P2, G.d)), heart: hc, Rh };
}

// ---------------------------------------------------------------- a ring
/* One element's gain wrong (it reads `gain` high in every view): its line in the sinogram, at a
   fixed distance from the centre, back-projects to a ring of that radius. Sharp kernel. */
export function ring(abd, bin = N / 2 + 20, gain = 0.06) {
  const G = grids(abd, N);
  const P = project(N, 180, false, still(G), 2);
  const m = measure(P.poly);
  const bad = { ...m, p: Float32Array.from(m.p) };
  for (let a = 0; a < 180; a++) bad.p[a * N + bin] -= Math.log(1 + gain);
  return { G, sino: bad, img: hu(fbp(bad, G.d, 'ramp')), good: hu(fbp(m, G.d, 'ramp')), bin, radius: Math.abs(ub(bin)) };
}

// ---------------------------------------------------------------- too few views
export function aliasing(pelvis) {
  const G = grids(pelvis, N);
  const many = project(N, 360, false, still(G), 2, false), few = project(N, 24, false, still(G), 2, false);
  return { G, many: hu(fbp(many.mono, G.d)), few: hu(fbp(few.mono, G.d)), nFew: 24, nMany: 360 };
}

// ---------------------------------------------------------------- truncation
/* A 60 cm grid (the field of view is 50): the abdomen centred, then 12 cm off to one side. Rays
   that would pass beyond 25 cm from the centre are not measured (no detector there). */
export function truncation(abd, NT = 160) {
  const side = 300, fovR = 25;
  const run = (shift) => {
    const G = grids(abd, NT, { side, ox: (side - abd.w) / 2 + shift / 0.2, oy: (side - abd.h) / 2 });
    const R = fovR / G.d;
    const P = project(NT, 180, false, (a, ax, ay, bx, by, b) => (Math.abs(b + 0.5 - NT / 2) > R ? [0, 0, 0] : paths(G, ax, ay, bx, by)), 2, false);
    const img = hu(fbp(P.mono, G.d));
    for (let r = 0; r < NT; r++) for (let c = 0; c < NT; c++) if (Math.hypot(c + 0.5 - NT / 2, r + 0.5 - NT / 2) > R) img[r * NT + c] = -1000;
    return { G, img, R };
  };
  const a = run(0), b = run(12);
  return { N: NT, centred: a.img, off: b.img, R: a.R, d: a.G.d, shift: 12 / a.G.d };
}

// ---------------------------------------------------------------- along z: the slab
/* The slab's slices are the model's voxel layers, 2 mm deep, head first from zTop; z here counts
   them (layer k spans k - 0.5 to k + 0.5). As grids, by z. */
function slabGrids(slices, zTop, zs) { const m = new Map(); for (const z of zs) m.set(z, grids(slices[zTop - z], N)); return m; }
// a grid of mu alone, as one project() can trace (its water equivalent: mu over water's)
const muOnly = (mu, d) => ({ N, d, w: Float32Array.from(mu, (m) => m / MU70.w), b: null, m: null, anyB: false, anyM: false });
/* Partial volume: a thick slice is measured as the intensity through all of it (the detector
   adds the photons, then the log is taken), so a structure in part of it is averaged in, and an
   edge crossing it is not a straight sum: thin (one 2 mm layer) at z0, thick (T mm) centred on it. */
export function partialVolume(slices, zTop, z0 = 213, T = 10) {
  const h = T / 4, zs = [];                                     // half the thickness, in layers
  for (let z = Math.floor(z0 - h); z <= Math.ceil(z0 + h); z++) zs.push(z);
  const w = zs.map((zj) => Math.max(0, Math.min(z0 + h, zj + 0.5) - Math.max(z0 - h, zj - 0.5)));
  const sw = w.reduce((a, b) => a + b, 0);
  const Gm = slabGrids(slices, zTop, zs);
  const proj = zs.map((z, i) => (w[i] > 0 ? project(N, 180, false, still(Gm.get(z)), 2, false).mono.p : null));
  const thick = new Float32Array(180 * N);
  for (let i = 0; i < thick.length; i++) { let s = 0; zs.forEach((z, j) => { if (proj[j]) s += (w[j] / sw) * Math.exp(-proj[j][i]); }); thick[i] = -Math.log(s); }
  const G = Gm.get(z0), thin = { NA: 180, NB: N, p: proj[zs.indexOf(z0)], full: false };
  return { G, thin: hu(fbp(thin, G.d)), thick: hu(fbp({ NA: 180, NB: N, p: thick, full: false }, G.d)), z0, T };
}
/* Helical windmill: each view's projection at the slice's z0 interpolated from the two detector
   rows either side of it (rows w mm apart, sliding past at pitch x rows x w a turn). The anatomy is
   the model's voxel layers, so the row above and the row below can see different layers. */
export function windmill(slices, zTop, { z0 = 236.4, rows = 16, w = 0.625, pitch = 1.5, NA = 360 } = {}) {
  const wv = w / 2, zs = [...new Set([z0 - 2 * wv, z0 - wv, z0, z0 + wv, z0 + 2 * wv].map(Math.round))];
  const Gm = slabGrids(slices, zTop, zs);
  const proj = new Map([...Gm].map(([z, G]) => [z, project(N, NA, true, still(G), 2, false).mono.p]));
  const at = (z) => proj.get(Math.round(z));
  const feed = pitch * rows * wv, p = new Float32Array(NA * N);
  for (let a = 0; a < NA; a++) {
    // the rows' z at this view: their centre advances a feed a turn; the two rows either side of z0
    const zc = z0 + feed * (a / NA - 0.5), k = Math.floor((z0 - zc) / wv + rows / 2 - 0.5);
    const zLo = zc + (k - rows / 2 + 0.5) * wv, f = (z0 - zLo) / wv;
    const A = at(zLo), B = at(zLo + wv);
    for (let b = 0; b < N; b++) p[a * N + b] = (1 - f) * A[a * N + b] + f * B[a * N + b];
  }
  const G = Gm.get(Math.round(z0));
  return { G, helical: hu(fbp({ NA, NB: N, p, full: true }, G.d)), truth: hu(fbp({ NA, NB: N, p: at(z0), full: true }, G.d)), rows, w, pitch, vanes: pitch * rows };
}
/* Cone beam: in an axial scan the outermost row (row mm off the central plane at the isocentre) is
   reached by rays tilted out of the focal spot, which turns in the central plane zc: along a ray
   z grows in proportion to the distance from the source. Reconstructed as if it were flat. */
export function coneBeam(slices, zTop, { zc = 226, row = 19.6875, NA = 360 } = {}) {
  const rv = row / 2, zs = [];
  for (let z = Math.max(zTop - slices.length + 1, Math.floor(zc + rv * 0.4)); z <= Math.min(zTop, Math.ceil(zc + rv * 1.6)); z++) zs.push(z);
  const Gm = slabGrids(slices, zTop, zs), list = zs.map((z) => Gm.get(z).mu), G0 = Gm.get(zs[0]);
  const d = G0.d, Fp = F / d, cx = N / 2, cy = N / 2;
  const bil = (mu, c, r) => {
    const c0 = Math.floor(c - 0.5), r0 = Math.floor(r - 0.5), fc = c - 0.5 - c0, fr = r - 0.5 - r0;
    let s = 0;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const cc = c0 + i, rr = r0 + j;
      if (cc >= 0 && rr >= 0 && cc < N && rr < N) s += mu[rr * N + cc] * (i ? fc : 1 - fc) * (j ? fr : 1 - fr);
    }
    return s;
  };
  const p = new Float32Array(NA * N);
  for (let a = 0; a < NA; a++) {
    const ph = (a / NA) * 2 * Math.PI, dx = Math.sin(ph), dy = Math.cos(ph), ux = dy, uy = -dx;
    for (let b = 0; b < N; b++) {
      let acc = 0;
      for (let s = 0; s < 2; s++) {
        const u = b + (s + 0.5) / 2 - N / 2, ox = cx + ux * u, oy = cy + uy * u;
        let sum = 0;
        for (let t = -N * 0.72; t < N * 0.72; t += 0.7) {
          const x = ox + dx * t, y = oy + dy * t;
          if (x < 0 || y < 0 || x >= N || y >= N) continue;
          // the source is Fp before the ray's nearest point to the centre, in the central plane
          const zi = zc + rv * (Fp + t) / Fp - zs[0];
          const k0 = Math.max(0, Math.min(zs.length - 2, Math.floor(zi))), f = Math.max(0, Math.min(1, zi - k0));
          sum += bil(list[k0], x, y) * (1 - f) + bil(list[k0 + 1], x, y) * f;
        }
        acc += sum * 0.7 * d;
      }
      p[a * N + b] = acc / 2;
    }
  }
  // the truth: the layer at the row's own z, flat
  const zt = zc + rv, k0 = Math.floor(zt), f = zt - k0, ga = Gm.get(k0), gb = Gm.get(k0 + 1) || ga;
  const Gt = muOnly(Float32Array.from(ga.mu, (v, i) => v * (1 - f) + gb.mu[i] * f), d);
  const Pt = project(N, 180, false, still(Gt), 2, false);
  return { G: G0, cone: hu(fbp({ NA, NB: N, p, full: true }, d)), truth: hu(fbp(Pt.mono, d)), zc, row };
}
export { rng };

/* The jobs, as the film asks for them: each from the loaded images (I) and the slab's slices,
   returning only what is drawn (plain arrays and numbers: they cross from a worker). */
export const SLAB_TOP = 252;
export const JOBS = {
  cupping: (I) => { const r = cupping(I.ax_head); return { raw: r.raw, cor: r.cor, d: r.G.d }; },
  rods: (I) => { const r = rods(I.ax_metal); return { water: r.water, ideal: r.ideal }; },
  starvation: (I) => { const r = starvation(I.ax_shoulder); return { flat: r.flat, tcm: r.tcm, counts: r.counts, mA: r.mA, I0: r.I0 }; },
  metal: (I) => { const r = metal(I.ax_pelvis); return { clean: r.clean, metal: r.metal, at: r.at, r: r.r }; },
  motion: (I) => { const r = motion(I.ax_chest); return { still: r.still, breathing: r.breathing, cardiac: r.cardiac, heart: r.heart, Rh: r.Rh }; },
  ring: (I) => { const r = ring(I.ax_abd); return { sino: r.sino.p, img: r.img, good: r.good, bin: r.bin, radius: r.radius }; },
  aliasing: (I) => { const r = aliasing(I.ax_pelvis); return { many: r.many, few: r.few, nFew: r.nFew, nMany: r.nMany }; },
  truncation: (I) => truncation(I.ax_abd),
  partialVolume: (I, sl) => { const r = partialVolume(sl, SLAB_TOP); return { thin: r.thin, thick: r.thick, z0: r.z0, T: r.T }; },
  windmill: (I, sl) => { const r = windmill(sl, SLAB_TOP, WINDMILL); return { helical: r.helical, truth: r.truth }; },
  cone: (I, sl) => { const r = coneBeam(sl, SLAB_TOP, CONE); return { cone: r.cone, truth: r.truth }; },
};
/* The cone shown: the outermost row of a wide (160 mm: 320 rows of 0.5 mm) detector, 79.75 mm off
   the central plane; at this scanner's 40 mm the error is a quarter as large and hard to see. */
export const CONE = { zc: 189, row: 79.75 };
// the helical acquisition the windmill is shown for: 16 rows of 2.5 mm (4 of the 0.625 mm rows each)
export const WINDMILL = { rows: 16, w: 2.5, pitch: 1.5, z0: 241.2 };
