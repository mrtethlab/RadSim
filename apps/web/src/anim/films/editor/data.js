/* MODEL EDITOR FILM: its data. One real model, the chest/abdomen/pelvis (a TotalSegmentator CT,
   public/models/chestabdopelvis: 209 x 165 x 356 voxels at 2 mm), loaded as the app loads it
   (model/voxelLoader.js), and everything the film shows of it worked out from its voxels with the
   app's own code:
     - the HU and material slices (BodyMaterials.LIST: each id's HU and colour);
     - the copy the Model Editor would hold: the preset halved to 4 mm exactly as editor.js
       loadPreset does it (every 2nd voxel), then the film's two edits: a kidney stone brushed
       into the left kidney on five slices, and the aorta filled with iodine contrast;
     - the projection of that edited copy, by the app's engine (AttenuationEngine.project through
       a VoxelPhantom, an 80 kVp Spectrum), as the x-ray room would make it; a C-arm's view too;
     - one ray's walk through the voxels (the same Amanatides-Woo stepping as VoxelPhantom.trace,
       recorded cell by cell) and the path lengths trace() returns for it;
     - a CT slice: its sinogram and filtered back-projection (as ct.js does it: parallel views over
       180 degrees, a Ram-Lak ramp), at 70 keV, from muAtEnergy;
     - ultrasound lines through the same slice, by the materials' acoustic impedance (acoustics.js).
   Axes (the volume's and the film's world): +x the patient's RIGHT (the liver is at high x), +y
   ANTERIOR, +z SUPERIOR; cm in the world, the volume centred on its set's origin. Every view is
   from the feet or the front, as radiographs and CT slices are read: the patient's right on the
   screen's left. */
import { loadVoxelModel } from '../../../model/voxelLoader.js';
import { BodyMaterials } from '../../../core/materials.js';
import { VoxelPhantom, muAtEnergy, muOverBins } from '../../../core/voxelPhantom.js';
import { AttenuationEngine } from '../../../core/engine.js';
import { Spectrum } from '../../../core/spectrum.js';
import { acousticOf } from '../../../core/acoustics.js';
import { rng } from '../../pixel.js';
import { capVolumeFrame } from '../capFrame.js';

export const NAME = 'chestabdopelvis';
export const SLICE = 145;              // the full-resolution slice the film works on: both kidneys, the aorta, the liver's tip
export const K = 2;                    // the editor's reduction of this preset (editor.js: <= 2.2 M voxels)
export const ZE = 72;                  // that slice in the editor's copy (145 / 2)
export const ID = { AIR: 0, KIDNEY: 13, AORTA: 29, IODINE: 20, STONE: 22, LIVER: 11 };
const LIST = BodyMaterials.LIST;

// each id's colour as [r, g, b] (the legend's own: the colours the app's 3D organs use)
export const RGB = new Array(256).fill(null).map((_, i) => {
  const m = LIST.find((q) => q.id === i);
  const c = m ? m.color : 0xff00ff;
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
});
export const hex = (id) => { const [r, g, b] = RGB[id]; return `rgb(${r},${g},${b})`; };
// an id's nominal HU (metals have none in the list: drawn as the top of the scale)
export const huOfId = (id) => { const m = LIST.find((q) => q.id === id); return m && m.hu != null ? m.hu : 3000; };

export async function loadData() {
  // (from where the volume began when the film was laid out: capFrame.js)
  const all = await loadVoxelModel(import.meta.env.BASE_URL + 'models/' + NAME, NAME);
  const vm = { ...all, ...capVolumeFrame(all.data, all.dims) };
  const [nx, ny, nz] = vm.dims, sp = vm.spacingMM[0], data = vm.data;
  const D = { nx, ny, nz, sp, data, vm };
  D.at = (x, y, z) => data[x + nx * (y + ny * z)];

  // ---- HU slices: each voxel's material HU, as the CT measured it more or less: a little
  // noise and the partial volume of a 3x3 average (the film's stand-in for the CT's own values)
  const huCache = new Map();
  D.huSlice = (z) => {
    if (huCache.has(z)) return huCache.get(z);
    const raw = new Float32Array(nx * ny), r = rng(900 + z);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) raw[x + nx * y] = huOfId(data[x + nx * (y + ny * z)]);
    const out = new Float32Array(nx * ny);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue;
        const w = dx || dy ? 1 : 4; s += raw[X + nx * Y] * w; n += w;
      }
      const v = s / n;
      out[x + nx * y] = v > -950 ? v + (r() + r() + r() - 1.5) * 22 : v + r() * 20;
    }
    huCache.set(z, out);
    return out;
  };
  // the grey a HU shows as through a window (level, width)
  D.grey = (hu, L = 40, W = 400) => Math.max(0, Math.min(255, Math.round(((hu - (L - W / 2)) / W) * 255)));

  // ---- the editor's copy: halved as editor.js does it, then the film's edits
  const mx = Math.floor(nx / K), my = Math.floor(ny / K), mz = Math.floor(nz / K);
  const ed0 = new Uint8Array(mx * my * mz);
  for (let z = 0; z < mz; z++) for (let y = 0; y < my; y++) for (let x = 0; x < mx; x++)
    ed0[x + mx * (y + my * z)] = data[x * K + nx * (y * K + ny * (z * K))];
  const E = { nx: mx, ny: my, nz: mz, sp: sp * K, data: ed0.slice(), orig: ed0 };
  E.i = (x, y, z) => x + mx * (y + my * z);
  // the left kidney (low x) on the slice: the stone goes in its middle
  let sx = 0, sy = 0, sn = 0;
  for (let y = 0; y < my; y++) for (let x = 0; x < mx / 2; x++) if (ed0[E.i(x, y, ZE)] === ID.KIDNEY) { sx += x; sy += y; sn++; }
  const stone = [Math.round(sx / sn), Math.round(sy / sn)];
  E.stone = stone;
  // the brush (editor.js paintDab: every voxel within size/2 of the dab's centre), size 4; one
  // stroke of three dabs on the slice, a dab on each of the two slices either side
  E.brushSize = 5;
  E.strokes = { [ZE]: [[stone[0] + 1, stone[1]], [stone[0], stone[1]], [stone[0] - 1, stone[1] + 1]] };
  for (const dz of [-3, -2, -1, 1, 2, 3]) E.strokes[ZE + dz] = [[stone[0], stone[1]]];
  E.dab = (cx, cy) => {
    const r = E.brushSize / 2, out = [];
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r && x >= 0 && y >= 0 && x < mx && y < my) out.push([x, y]);
    return out;
  };
  // the stone's voxels on the slice, in the order the stroke paints them
  E.stoneOrder = [];
  { const seen = new Set();
    for (const [cx, cy] of E.strokes[ZE]) for (const [x, y] of E.dab(cx, cy)) { const k = x + mx * y; if (!seen.has(k)) { seen.add(k); E.stoneOrder.push([x, y]); } } }
  for (const [zs, list] of Object.entries(E.strokes)) for (const [cx, cy] of list) for (const [x, y] of E.dab(cx, cy)) E.data[E.i(x, y, +zs)] = ID.STONE;
  // the fill (editor.js floodFill: 4-connected, the same id as under the click): its order on the
  // slice, breadth first from the aorta's middle; then every slice's aorta, as if filled in turn
  let ax = 0, ay = 0, an = 0;
  for (let y = 0; y < my; y++) for (let x = 0; x < mx; x++) if (ed0[E.i(x, y, ZE)] === ID.AORTA) { ax += x; ay += y; an++; }
  let seed = [Math.round(ax / an), Math.round(ay / an)];
  if (ed0[E.i(seed[0], seed[1], ZE)] !== ID.AORTA) {      // (the centroid of a crescent can miss it)
    let best = 1e9;
    for (let y = 0; y < my; y++) for (let x = 0; x < mx; x++) if (ed0[E.i(x, y, ZE)] === ID.AORTA) { const d = (x - ax / an) ** 2 + (y - ay / an) ** 2; if (d < best) { best = d; seed = [x, y]; } }
  }
  E.fillSeed = seed;
  E.fillOrder = [];
  { const seen = new Uint8Array(mx * my), q = [seed]; seen[seed[0] + mx * seed[1]] = 1;
    while (q.length) {
      const [x, y] = q.shift(); E.fillOrder.push([x, y]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= mx || Y >= my || seen[X + mx * Y]) continue;
        if (ed0[E.i(X, Y, ZE)] !== ID.AORTA) continue;
        seen[X + mx * Y] = 1; q.push([X, Y]);
      }
    } }
  for (let i = 0; i < E.data.length; i++) if (E.data[i] === ID.AORTA) E.data[i] = ID.IODINE;
  D.E = E;

  // ---- the surface voxels the editor's 3D preview draws (editor.js buildVoxelInstanced: any
  // of the six neighbours air), z by z
  const shell = [];
  { const at = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= mx || y >= my || z >= mz ? 0 : ed0[x + mx * (y + my * z)]);
    for (let z = 0; z < mz; z++) for (let y = 0; y < my; y++) for (let x = 0; x < mx; x++) {
      if (!ed0[x + mx * (y + my * z)]) continue;
      if (!at(x - 1, y, z) || !at(x + 1, y, z) || !at(x, y - 1, z) || !at(x, y + 1, z) || !at(x, y, z - 1) || !at(x, y, z + 1)) shell.push(x, y, z);
    } }
  E.shell = Int16Array.from(shell);
  E.shellBelow = (z) => { let lo = 0, hi = E.shell.length / 3; while (lo < hi) { const m = (lo + hi) >> 1; if (E.shell[m * 3 + 2] < z) lo = m + 1; else hi = m; } return lo; };

  // ---- the x-ray room's geometry (room.js: the receptor the plane y = 0, the tabletop at y = 5,
  // the focal spot 100 cm above), the saved model lying supine on the tabletop
  let post = my;
  for (let y = 0; y < my && post === my; y++) for (let x = 0; x < mx; x++) if (ed0[E.i(x, y, ZE)]) { post = y; break; }
  const ext = [mx * E.sp / 10, my * E.sp / 10, mz * E.sp / 10];
  const sliceZ = (ZE + 0.5) * E.sp / 10 - ext[2] / 2;     // the slice's z about the volume's centre
  const room = { centre: [0, 5.3 + ext[1] / 2 - post * E.sp / 10, -sliceZ], source: [0, 100, 0], ext };
  D.room = room;
  const phantom = new VoxelPhantom({ dims: [mx, my, mz], vs: [E.sp / 10, E.sp / 10, E.sp / 10], data: E.data }, room.centre);
  D.phantom = phantom;
  // the voxel's centre in the room
  D.roomPos = (x, y, z) => [phantom.min[0] + (x + 0.5) * E.sp / 10, phantom.min[1] + (y + 0.5) * E.sp / 10, phantom.min[2] + (z + 0.5) * E.sp / 10];
  const spectrum = Spectrum.make(80);
  D.spectrum = spectrum;
  const PW = 120, PH = 144, PX = 0.3;                      // a 36 x 43 cm receptor, 3 mm pixels
  const dose = await AttenuationEngine.project({ phantom, source: room.source, detCenter: [0, 0, 0], detU: [-1, 0, 0], detV: [0, 0, -1],
    nx: PW, ny: PH, pxU: PX, pxV: PX, spectrum, I0: 1, refDist: 100 });
  D.proj = { w: PW, h: PH, px: PX, dose, grey: toGrey(dose) };
  // where a room point falls on that image (pixel col, row), through the focal spot
  D.onImage = (p) => {
    const s = room.source, k = s[1] / (s[1] - p[1]);
    const X = s[0] + (p[0] - s[0]) * k, Z = s[2] + (p[2] - s[2]) * k;
    return [(-X) / PX + (PW - 1) / 2, (-Z) / PX + (PH - 1) / 2];
  };

  // ---- one ray: from the focal spot through the stone's middle, on to the receptor
  const target = D.roomPos(stone[0], stone[1], ZE);
  const dir = norm(sub(target, room.source));
  const tDet = -room.source[1] / dir[1];
  const L = phantom.trace(room.source, dir, tDet);
  const walk = ddaCells(phantom, room.source, dir, tDet).filter((c) => c.id !== 0 || c.inBody);
  D.ray = { dir, tDet, L, walk, target, hit: [room.source[0] + dir[0] * tDet, 0, room.source[2] + dir[2] * tDet] };
  // per energy bin: mu of each material on the path, the transmission
  const muB = muOverBins(spectrum.bins);
  const mats = [];
  for (let m = 1; m < BodyMaterials.count; m++) if (L[m] > 1e-6) mats.push({ id: m, len: L[m] });
  mats.sort((a, b) => b.len - a.len);
  D.ray.mats = mats;
  D.ray.bins = spectrum.bins.map((b, k) => {
    let e = 0; for (const { id, len } of mats) e += muB[id][k] * len;
    return { E: b.E, w: b.w, T: Math.exp(-e), e };
  });
  D.ray.Ttot = D.ray.bins.reduce((s, b) => s + b.w * b.T, 0);
  D.ray.meanIn = spectrum.meanE;
  D.ray.meanOut = D.ray.bins.reduce((s, b) => s + b.w * b.T * b.E, 0) / D.ray.Ttot;

  // ---- the C-arm's view (fluoro.js's OEC: SID 99, the focal spot 60 cm under the isocentre),
  // the isocentre at the kidneys, the tube under the table: a PA view, drawn as seen from above
  const isoY = room.centre[1] - 1.5;
  const fl = await AttenuationEngine.project({ phantom, source: [0, isoY - 60, 0], detCenter: [0, isoY + 39, 0], detU: [-1, 0, 0], detV: [0, 0, -1],
    nx: 80, ny: 80, pxU: 0.3, pxV: 0.3, spectrum: Spectrum.make(75), I0: 1, refDist: 99 });
  D.fluoro = { w: 80, h: 80, grey: toGrey(fl), isoY };

  // ---- CT of the slice (ct.js: a parallel-beam sinogram over 180 degrees, a ramp filter, back-
  // projection), at 70 keV: mu per voxel from the edited slice
  D.ct = ctSlice(E, ZE);

  // ---- ultrasound through the slice: a curved probe on the right flank, aimed at the kidney
  D.us = usSector(E, ZE);
  return D;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };

// the detector's values to a radiograph's greys, as the x-ray film's processing does it: the log
// of the transmission (bone white), rescaled to the values of interest (3 % / 99.7 %), through an
// S-shaped look-up table
function toGrey(dose) {
  const a = Float32Array.from(dose, (v) => -Math.log(Math.max(1e-9, v)));
  const s = [...a].sort((x, y) => x - y), lo = s[Math.floor(s.length * 0.03)], hi = s[Math.floor(s.length * 0.997)];
  const S = (u) => 1 / (1 + Math.exp(-6 * (u - 0.5))), s0 = S(0), s1 = S(1);
  return Uint8ClampedArray.from(a, (v) => Math.round(((S(Math.max(0, Math.min(1, (v - lo) / (hi - lo)))) - s0) / (s1 - s0)) * 255));
}

/* The cells a ray crosses, in order, each with its length and id: VoxelPhantom.trace's walk
   (Amanatides & Woo: from boundary to boundary, the nearest of the next x, y or z crossing),
   recorded instead of summed. inBody marks air inside the body's span (kept for the drawing). */
function ddaCells(ph, o, d, maxT) {
  const min = ph.min, max = ph.max, vs = ph.vs, out = [];
  let t0 = 0, t1 = maxT;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) continue;
    let ta = (min[k] - o[k]) / d[k], tb = (max[k] - o[k]) / d[k];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
  }
  if (t1 <= t0) return out;
  const fl = (k, p) => Math.min(ph[['nx', 'ny', 'nz'][k]] - 1, Math.max(0, Math.floor((p - min[k]) / vs[k])));
  let ix = fl(0, o[0] + (t0 + 1e-6) * d[0]), iy = fl(1, o[1] + (t0 + 1e-6) * d[1]), iz = fl(2, o[2] + (t0 + 1e-6) * d[2]);
  const st = d.map((v) => (v >= 0 ? 1 : -1));
  const nextT = (i, s, k) => (Math.abs(d[k]) < 1e-12 ? Infinity : (min[k] + (i + (s > 0 ? 1 : 0)) * vs[k] - o[k]) / d[k]);
  let tx = nextT(ix, st[0], 0), ty = nextT(iy, st[1], 1), tz = nextT(iz, st[2], 2);
  const dX = Math.abs(vs[0] / d[0]), dY = Math.abs(vs[1] / d[1]), dZ = Math.abs(vs[2] / d[2]);
  let t = t0;
  while (t < t1) {
    const tn = Math.min(tx, ty, tz, t1);
    if (tn > t) out.push({ x: ix, y: iy, z: iz, id: ph.idAt(ix, iy, iz), len: tn - t, t0: t, t1: tn, axis: tn === tx ? 0 : tn === ty ? 1 : 2 });
    t = tn;
    if (tn >= t1) break;
    if (tx <= ty && tx <= tz) { ix += st[0]; tx += dX; if (ix < 0 || ix >= ph.nx) break; }
    else if (ty <= tz) { iy += st[1]; ty += dY; if (iy < 0 || iy >= ph.ny) break; }
    else { iz += st[2]; tz += dZ; if (iz < 0 || iz >= ph.nz) break; }
  }
  // the body's span along the ray (first to last non-air): air within it is kept
  const f = out.findIndex((c) => c.id !== 0), l = out.length - 1 - [...out].reverse().findIndex((c) => c.id !== 0);
  out.forEach((c, i) => { c.inBody = i >= f && i <= l; });
  return out;
}

/* CT of one slice of the editor's copy: line integrals of mu (70 keV) over NA parallel views
   across 180 degrees, each filtered with the Ram-Lak ramp and back-projected; the partial
   back-projections kept at a few stages so the film can show the slice building up. */
function ctSlice(E, z) {
  const nx = E.nx, ny = E.ny, s = E.sp / 10, mu = muAtEnergy(70), muW = BodyMaterials.muWater(70);
  const m = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) m[x + nx * y] = mu[E.data[E.i(x, y, z)]];
  const NA = 180, ND = 150, ds = 0.32, half = (ND - 1) / 2, cx = nx * s / 2, cy = ny * s / 2;
  const sample = (X, Y) => { const ix = Math.floor((X + cx) / s), iy = Math.floor((Y + cy) / s); return ix < 0 || iy < 0 || ix >= nx || iy >= ny ? 0 : m[ix + nx * iy]; };
  const sino = new Float32Array(NA * ND), R = 26, step = 0.1;
  for (let a = 0; a < NA; a++) {
    const th = (a * Math.PI) / NA, c = Math.cos(th), sn = Math.sin(th);
    for (let k = 0; k < ND; k++) {
      const u = (k - half) * ds;
      let acc = 0;
      for (let v = -R; v <= R; v += step) acc += sample(u * c - v * sn, u * sn + v * c);
      sino[a * ND + k] = acc * step;
    }
  }
  // Ram-Lak (ct.js buildKernel, the quick detector's)
  const h = new Float32Array(2 * ND - 1);
  for (let n = -(ND - 1); n <= ND - 1; n++) h[n + ND - 1] = n === 0 ? 1 / (4 * ds * ds) : n % 2 ? -1 / (Math.PI * Math.PI * n * n * ds * ds) : 0;
  const q = new Float32Array(NA * ND);
  for (let a = 0; a < NA; a++) for (let k = 0; k < ND; k++) {
    let acc = 0;
    for (let j = 0; j < ND; j++) acc += sino[a * ND + j] * h[k - j + ND - 1];
    q[a * ND + k] = acc * ds;
  }
  const STAGES = [0, 6, 12, 24, 45, 90, 135, 180], snaps = [], img = new Float32Array(nx * ny);
  let done = 0;
  for (const upto of STAGES) {
    for (; done < upto; done++) {
      const th = (done * Math.PI) / NA, c = Math.cos(th), sn = Math.sin(th);
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const X = (x + 0.5) * s - cx, Y = (y + 0.5) * s - cy, u = X * c + Y * sn, f = u / ds + half, i0 = Math.floor(f);
        if (i0 < 0 || i0 >= ND - 1) continue;
        const w = f - i0;
        img[x + nx * y] += q[done * ND + i0] * (1 - w) + q[done * ND + i0 + 1] * w;
      }
    }
    // in HU, as the scanner shows it (mu over water's, at the same energy)
    snaps.push(Float32Array.from(img, (v) => 1000 * ((v * Math.PI) / NA - muW) / muW));
  }
  let smax = 0; for (const v of sino) smax = Math.max(smax, v);
  return { NA, ND, sino, smax, stages: STAGES, snaps, nx, ny };
}

/* Ultrasound lines through the slice: a curved probe on the right flank's skin aimed at the right
   kidney; along each line every step's echo is the reflection at a change of impedance,
   ((Z2 - Z1) / (Z2 + Z1))^2, plus the tissue's own backscatter (its speckle), both weakened by
   the attenuation there and back and by what the boundaries above already reflected. */
function usSector(E, z) {
  const nx = E.nx, ny = E.ny, s = E.sp;                   // mm
  let kx = 0, ky = 0, kn = 0;
  for (let y = 0; y < ny; y++) for (let x = Math.floor(nx / 2); x < nx; x++) if (E.data[E.i(x, y, z)] === ID.KIDNEY) { kx += x; ky += y; kn++; }
  const kid = [kx / kn, ky / kn];
  const u = norm([1, 0.2, 0]);                            // out through the right flank (the liver's side)
  let p = [kid[0], kid[1]];
  const idAt = (X, Y) => { const ix = Math.floor(X), iy = Math.floor(Y); return ix < 0 || iy < 0 || ix >= nx || iy >= ny ? 0 : E.data[E.i(ix, iy, z)]; };
  for (let k = 0; k < 200 && idAt(p[0], p[1]) !== 0; k++) p = [p[0] + u[0] * 0.5, p[1] + u[1] * 0.5];
  const apex = [p[0] + u[0] * 5, p[1] + u[1] * 5];          // the curved face's centre of curvature, 2 cm out
  const LINES = 72, HALF = 0.5, DEPTH = 160, NS = 120, f = 3.5, rFace = 20;      // radians, mm, samples, MHz, mm
  const r = rng(77), img = new Float32Array(LINES * NS), ang0 = Math.atan2(-u[1], -u[0]);
  for (let l = 0; l < LINES; l++) {
    const a = ang0 + (l / (LINES - 1) - 0.5) * 2 * HALF, dx = Math.cos(a), dy = Math.sin(a);
    // amp: what the boundaries above have let through; dB: the attenuation there and back, of
    // which the time-gain compensation gives most back (as a scanner's TGC does)
    let amp = 1, dB = 0, prevZ = null;
    for (let k = 0; k < NS; k++) {
      const d = rFace + (k / NS) * DEPTH;                 // mm from the centre of curvature
      const X = apex[0] + (dx * d) / s, Y = apex[1] + (dy * d) / s, id = idAt(X, Y);
      const ac = acousticOf(id);
      let e = 0;
      if (prevZ != null && id !== 0 && ac.z !== prevZ) {
        const R = ((ac.z - prevZ) / (ac.z + prevZ)) ** 2;
        e += Math.min(1, R * 60); amp *= 1 - R;
      }
      if (id !== 0) {
        e += ac.bs * ac.bs * (0.4 + 1.2 * r()) * 0.9;            // (its echogenicity, with a speckle round it)
        dB += ac.att * f * 2 * (DEPTH / NS / 10);
      }
      if (id !== 0) prevZ = ac.z;
      img[l * NS + k] = Math.min(1, e * amp * Math.pow(10, -(dB * 0.25) / 20));
    }
  }
  return { apex, ang0, HALF, LINES, NS, DEPTH, rFace, img, kid, skin: p };
}
