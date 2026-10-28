/* ============================================================================
   VOXEL PHANTOM
   A labelled voxel volume (every voxel = a BodyMaterials id) that the ray-caster
   can sample the same way it samples the analytic Phantom. trace(o,d,maxT)
   DDA-marches the grid (Amanatides–Woo) and returns the path length spent in each
   material (world units = cm), so the scout + CT engines integrate attenuation
   over the real anatomy exactly as they do for the hand.

   Placement: the volume is axis-aligned with the world, centred at `center`
   (world cm), with isotropic-ish voxel size `vs` (cm per voxel per axis). Anatomical
   orientation (which way is up / head-first) is handled by per-axis `flip` on the
   DATA index, so the world-space DDA stays simple and monotonic.
   ============================================================================ */
import { BodyMaterials } from './materials.js';

// Rotation matrix (row-major 3x3, flat 9) from euler angles rx,ry,rz applied as
// Rz·Ry·Rx (X first, then Y, then Z). Shared by the phantom + the display mesh so
// the ray-cast object and the 3D preview always agree.
export function eulerMatrix(rx, ry, rz) {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}
const isIdentity = (m) => m[0] === 1 && m[4] === 1 && m[8] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 0 && m[5] === 0 && m[6] === 0 && m[7] === 0;

export class VoxelPhantom {
  // model: { dims:[nx,ny,nz], vs:[sx,sy,sz] (cm), data:Uint8Array (x-fastest) }
  // rot: row-major 3x3 world rotation about the volume centre (identity = none).
  constructor(model, center = [0, 0, 0], flip = [false, false, false], rot = null) {
    this.voxel = true;
    const [nx, ny, nz] = model.dims;
    this.nx = nx; this.ny = ny; this.nz = nz;
    this.data = model.data;                     // null => geometry-only (backend does the tracing)
    this.geometryOnly = !model.data;
    this.vs = model.vs.slice();                 // cm/voxel per axis
    this.nmat = BodyMaterials.count;
    this.concLUT = null;                        // contrast off — see setContrast()
    this.sVol = null;
    this.baLUT = null;                          // barium off — see setBarium()
    this.giVol = null;
    this.setCenter(center);
    this.flip = flip.slice();
    this.setRotation(rot);
  }
  // Store the volume rotation + its transpose (= inverse) for the world→local ray map.
  setRotation(rot) {
    this.rot = rot ? rot.slice() : null;
    this.rotated = !!rot && !isIdentity(rot);
    if (this.rotated) this.rotT = [rot[0], rot[3], rot[6], rot[1], rot[4], rot[7], rot[2], rot[5], rot[8]];
  }
  setCenter(center) {
    // world AABB [min,max] with the volume centred on `center`
    const ext = [this.nx * this.vs[0], this.ny * this.vs[1], this.nz * this.vs[2]];
    this.min = [center[0] - ext[0] / 2, center[1] - ext[1] / 2, center[2] - ext[2] / 2];
    this.max = [center[0] + ext[0] / 2, center[1] + ext[1] / 2, center[2] + ext[2] / 2];
    this.extent = ext;
  }
  // flat data index at a grid index (with anatomical flips applied)
  dataIndex(ix, iy, iz) {
    const dx = this.flip[0] ? this.nx - 1 - ix : ix;
    const dy = this.flip[1] ? this.ny - 1 - iy : iy;
    const dz = this.flip[2] ? this.nz - 1 - iz : iz;
    return dx + this.nx * (dy + this.ny * dz);
  }
  // material id at grid index (with anatomical flips applied on the data lookup)
  idAt(ix, iy, iz) { return this.data[this.dataIndex(ix, iy, iz)]; }

  /* Attach a contrast field for one acquisition.
       concLUT — Float32Array(nmat * NS): iodine concentration (mgI/mL) for
                 [material id][arclength bin]. Organs are uniform, so every bin of an
                 organ's row holds the same value; vessels vary along the row. Folding
                 both into one table means the trace needs no branch to tell them apart.
       sVol    — Uint8Array(nvox): arclength bin per voxel, 0 for everything that is not
                 a vessel, which is exactly the bin an organ's uniform row wants anyway.
     Pass null to turn contrast off. */
  setContrast(concLUT, sVol, ns) {
    this.concLUT = concLUT || null;
    this.sVol = sVol || null;
    this.ns = ns || 256;
  }

  /* The same mechanism for enteric barium, on its own table and its own per-voxel bin map.
     Separate from the iodine pair rather than sharing one "contrast" channel, because the
     two agents have different K-edges and can be present at once — enteric barium with IV
     iodine is an ordinary abdominal CT, and a shared column could not tell them apart at
     the point where mu(E) is applied.
       baLUT — Float32Array(nmat * NS): mg Ba/mL for [material id][arclength bin]
       giVol — Uint8Array(nvox): arclength bin per voxel, 0 outside the gut */
  /* gasLUT — Float32Array(nmat * NS): gas volume fraction for [material id][arclength bin].
     A double-contrast study is two agents at once, and the gas is not an attenuator to add
     but an attenuator to REMOVE: it takes the place of the fluid the segmentation put in the
     lumen. Optional — null leaves the lumen filled, which is a single-contrast study. */
  setBarium(baLUT, giVol, ns, gasLUT) {
    this.baLUT = baLUT || null;
    this.giVol = giVol || null;
    this.gasLUT = gasLUT || null;
    this.ns = ns || this.ns || 256;
  }
  /* The part of the volume a beam can reach: the rays from the focal spot src to the rectangle
     [x0, x1] x [z0, z1] on the receptor plane (y = 0). Where the beam and the volume meet is a convex
     solid, its corners where the beam's edge rays enter and leave the volume and the volume's own
     corners inside the beam (and where its edges cross the beam's faces, which the edge rays, taken
     closely, bound to within the margin). The crop is the grid box round them. Returns a phantom of
     that box alone, placed where it was, or this one when the box saves little or a contrast field
     is attached (its per-voxel maps are the full grid's). A tight field over a big volume was paying
     for the cache misses of a volume it never touched: an axial shoulder's 12 cm field over an
     abducted arm, 22 s. */
  cropTo(src, [x0, x1, z0, z1], margin = 3) {
    if (!this.data || this.sVol || this.giVol || !(src[1] > 0)) return this;
    const c = [(this.min[0] + this.max[0]) / 2, (this.min[1] + this.max[1]) / 2, (this.min[2] + this.max[2]) / 2];
    const n = [this.nx, this.ny, this.nz], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const R = this.rotT, rot = this.rotated;
    const local = (p) => { if (!rot) return p; const x = p[0] - c[0], y = p[1] - c[1], z = p[2] - c[2];
      return [c[0] + R[0] * x + R[1] * y + R[2] * z, c[1] + R[3] * x + R[4] * y + R[5] * z, c[2] + R[6] * x + R[7] * y + R[8] * z]; };
    const grow = (q) => { for (let k = 0; k < 3; k++) { const g = (q[k] - this.min[k]) / this.vs[k]; if (g < lo[k]) lo[k] = g; if (g > hi[k]) hi[k] = g; } };
    const o = local(src);
    const edge = (px, pz) => {                       // one ray, clipped to the volume's box
      const q = local([px, 0, pz]), d = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
      let t0 = 0, t1 = 1;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(d[k]) < 1e-12) { if (o[k] < this.min[k] || o[k] > this.max[k]) return; continue; }
        let ta = (this.min[k] - o[k]) / d[k], tb = (this.max[k] - o[k]) / d[k];
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
        if (t1 < t0) return;
      }
      for (const t of [t0, t1]) grow([o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]]);
    };
    const S = 64;
    for (let s = 0; s <= S; s++) {
      const a = x0 + (x1 - x0) * s / S, b = z0 + (z1 - z0) * s / S;
      edge(a, z0); edge(a, z1); edge(x0, b); edge(x1, b);
    }
    // the volume's corners that lie inside the beam (world: the corner turned about the centre)
    const Rw = this.rot;
    for (const cx of [this.min[0], this.max[0]]) for (const cy of [this.min[1], this.max[1]]) for (const cz of [this.min[2], this.max[2]]) {
      const l = [cx - c[0], cy - c[1], cz - c[2]];
      const w = rot ? [c[0] + Rw[0] * l[0] + Rw[1] * l[1] + Rw[2] * l[2], c[1] + Rw[3] * l[0] + Rw[4] * l[1] + Rw[5] * l[2], c[2] + Rw[6] * l[0] + Rw[7] * l[1] + Rw[8] * l[2]] : [cx, cy, cz];
      if (w[1] >= src[1]) continue;
      const t = src[1] / (src[1] - w[1]), hx = src[0] + (w[0] - src[0]) * t, hz = src[2] + (w[2] - src[2]) * t;
      if (hx >= x0 && hx <= x1 && hz >= z0 && hz <= z1) grow([cx, cy, cz]);
    }
    if (!(hi[0] >= lo[0])) return this;
    const i0 = [0, 1, 2].map((k) => Math.max(0, Math.floor(lo[k]) - margin));
    const i1 = [0, 1, 2].map((k) => Math.min(n[k] - 1, Math.ceil(hi[k]) + margin));
    if (i1.some((v, k) => v < i0[k])) return this;
    const m = [0, 1, 2].map((k) => i1[k] - i0[k] + 1);
    if (m[0] * m[1] * m[2] > 0.6 * n[0] * n[1] * n[2]) return this;
    // LAID OUT ALONG THE BEAM: the data runs fastest along the axis the beam mostly travels. A
    // beam down the grid's slowest axis (a body tilted onto it: the axial shoulders) steps a slice's
    // width at every voxel and misses the cache at each, five times the cost of the same rays along
    // the rows. The grid's axes are permuted (perm[k]: the old axis that is new axis k) and the
    // rotation with them, so the box is the same box in the room.
    const lc = local([(x0 + x1) / 2, 0, (z0 + z1) / 2]), dl = [lc[0] - o[0], lc[1] - o[1], lc[2] - o[2]];
    const ax = [0, 1, 2].reduce((a, k) => (Math.abs(dl[k]) > Math.abs(dl[a]) ? k : a), 0);
    const perm = ax === 0 ? [0, 1, 2] : ax === 1 ? [1, 0, 2] : [2, 0, 1];
    const M = perm.map((k) => m[k]), f = this.flip, nf = perm.map((k) => f[k]);
    const out = new Uint8Array(M[0] * M[1] * M[2]), g = [0, 0, 0];
    for (let k2 = 0; k2 < M[2]; k2++) for (let k1 = 0; k1 < M[1]; k1++) {
      g[perm[2]] = k2 + i0[perm[2]]; g[perm[1]] = k1 + i0[perm[1]];
      const row = ((nf[2] ? M[2] - 1 - k2 : k2) * M[1] + (nf[1] ? M[1] - 1 - k1 : k1)) * M[0];
      for (let k0 = 0; k0 < M[0]; k0++) {
        g[perm[0]] = k0 + i0[perm[0]];
        out[row + (nf[0] ? M[0] - 1 - k0 : k0)] = this.idAt(g[0], g[1], g[2]);
      }
    }
    // the box's centre, from the grid's, in the local frame; and where the rotation puts it
    const off = [0, 1, 2].map((k) => this.min[k] + (i0[k] + i1[k] + 1) / 2 * this.vs[k] - c[k]);
    const w = rot ? [Rw[0] * off[0] + Rw[1] * off[1] + Rw[2] * off[2], Rw[3] * off[0] + Rw[4] * off[1] + Rw[5] * off[2], Rw[6] * off[0] + Rw[7] * off[1] + Rw[8] * off[2]] : off;
    // the rotation of the permuted grid: R' = R P^T (its column k is R's column perm[k])
    const R0 = rot ? Rw : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const Rp = [0, 1, 2].flatMap((i) => perm.map((k) => R0[i * 3 + k]));
    const ph = new VoxelPhantom({ dims: M, vs: perm.map((k) => this.vs[k]), data: out }, [c[0] + w[0], c[1] + w[1], c[2] + w[2]], nf, Rp);
    ph.concLUT = this.concLUT; ph.baLUT = this.baLUT; ph.gasLUT = this.gasLUT; ph.ns = this.ns;
    return ph;
  }
  // material id at a world point (or -1 outside the volume) — used for previews/debug
  idAtWorld(p) {
    const ix = Math.floor((p[0] - this.min[0]) / this.vs[0]);
    const iy = Math.floor((p[1] - this.min[1]) / this.vs[1]);
    const iz = Math.floor((p[2] - this.min[2]) / this.vs[2]);
    if (ix < 0 || ix >= this.nx || iy < 0 || iy >= this.ny || iz < 0 || iz >= this.nz) return -1;
    return this.idAt(ix, iy, iz);
  }
  // path length (cm) spent in each material along ray o + t*d, t in [0, maxT].
  // d is a unit vector; returns a Float32Array indexed by BodyMaterials id.
  // The extra slot past the materials is the iodine column: concentration-weighted path
  // length, cm x mgI/mL. It stays zero unless setContrast() has been called.
  trace(o, d, maxT = Infinity) {
    const L = new Float32Array(BodyMaterials.TRACE_LEN);
    if (this.geometryOnly) return L;   // no volume in the browser — the GPU backend traces
    // rotate the object by inverse-rotating the ray into the volume's local frame
    // (about the centre); the DDA below stays axis-aligned. Lengths are preserved.
    if (this.rotated) {
      const R = this.rotT, cx = (this.min[0] + this.max[0]) / 2, cy = (this.min[1] + this.max[1]) / 2, cz = (this.min[2] + this.max[2]) / 2;
      const ox = o[0] - cx, oy = o[1] - cy, oz = o[2] - cz;
      o = [cx + R[0] * ox + R[1] * oy + R[2] * oz, cy + R[3] * ox + R[4] * oy + R[5] * oz, cz + R[6] * ox + R[7] * oy + R[8] * oz];
      d = [R[0] * d[0] + R[1] * d[1] + R[2] * d[2], R[3] * d[0] + R[4] * d[1] + R[5] * d[2], R[6] * d[0] + R[7] * d[1] + R[8] * d[2]];
    }
    const min = this.min, max = this.max, vs = this.vs;
    // slab-clip the ray to the volume AABB
    let t0 = 0, t1 = maxT;
    for (let k = 0; k < 3; k++) {
      const dk = d[k];
      if (Math.abs(dk) < 1e-12) { if (o[k] < min[k] || o[k] > max[k]) return L; continue; }
      const inv = 1 / dk; let ta = (min[k] - o[k]) * inv, tb = (max[k] - o[k]) * inv;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
      if (t1 <= t0) return L;
    }
    if (t1 <= t0) return L;
    const eps = 1e-6, nx = this.nx, ny = this.ny, nz = this.nz;
    const clampi = (v, n) => v < 0 ? 0 : v >= n ? n - 1 : v;
    let px = o[0] + (t0 + eps) * d[0], py = o[1] + (t0 + eps) * d[1], pz = o[2] + (t0 + eps) * d[2];
    let ix = clampi(Math.floor((px - min[0]) / vs[0]), nx);
    let iy = clampi(Math.floor((py - min[1]) / vs[1]), ny);
    let iz = clampi(Math.floor((pz - min[2]) / vs[2]), nz);
    const stepx = d[0] >= 0 ? 1 : -1, stepy = d[1] >= 0 ? 1 : -1, stepz = d[2] >= 0 ? 1 : -1;
    const nextT = (i, step, k) => {
      if (Math.abs(d[k]) < 1e-12) return Infinity;
      const b = min[k] + (i + (step > 0 ? 1 : 0)) * vs[k];
      return (b - o[k]) / d[k];
    };
    let tMaxX = nextT(ix, stepx, 0), tMaxY = nextT(iy, stepy, 1), tMaxZ = nextT(iz, stepz, 2);
    const tDx = Math.abs(d[0]) < 1e-12 ? Infinity : vs[0] / Math.abs(d[0]);
    const tDy = Math.abs(d[1]) < 1e-12 ? Infinity : vs[1] / Math.abs(d[1]);
    const tDz = Math.abs(d[2]) < 1e-12 ? Infinity : vs[2] / Math.abs(d[2]);
    let t = t0;
    const conc = this.concLUT, sVol = this.sVol, NS = this.ns;
    const IOD = BodyMaterials.IODINE_COL, BAR = BodyMaterials.BARIUM_COL;
    const ba = this.baLUT, giVol = this.giVol, gasL = this.gasLUT;
    const GASM = BodyMaterials.idByName['Bowel gas'];
    while (t < t1) {
      const tNext = Math.min(tMaxX, tMaxY, tMaxZ, t1);
      const seg = tNext - t;
      if (seg > 0) {
        const di = this.dataIndex(ix, iy, iz), id = this.data[di];
        // Gas displaces the lumen rather than adding to it, so it is the one agent that
        // changes how the base material length is booked.
        if (gasL) {
          const gf = gasL[id * NS + (giVol ? giVol[di] : 0)];
          if (gf > 0) { L[id] += seg * (1 - gf); L[GASM] += seg * gf; }
          else L[id] += seg;
        } else L[id] += seg;
        // Both agents ride the same walk: concentration-weighted length into their own
        // columns. Neither costs anything when its table is absent.
        if (conc) L[IOD] += seg * conc[id * NS + (sVol ? sVol[di] : 0)];
        if (ba) L[BAR] += seg * ba[id * NS + (giVol ? giVol[di] : 0)];
      }
      t = tNext;
      if (tNext >= t1) break;
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) { ix += stepx; tMaxX += tDx; if (ix < 0 || ix >= nx) break; }
      else if (tMaxY <= tMaxZ) { iy += stepy; tMaxY += tDy; if (iy < 0 || iy >= ny) break; }
      else { iz += stepz; tMaxZ += tDz; if (iz < 0 || iz >= nz) break; }
    }
    return L;
  }
}

// Precompute per-material linear attenuation (cm^-1) at a single energy — used by the
// monochromatic CT reconstruction (line integral Σ μ_m · L_m).
// Length is count+1: the trailing entry is iodine in cm^-1 per mgI/mL, matching the
// concentration column the tracer fills. See muOverBins.
export function muAtEnergy(keV) {
  const n = BodyMaterials.count, arr = new Float64Array(BodyMaterials.TRACE_LEN);
  for (let i = 0; i < n; i++) arr[i] = BodyMaterials.muById(i, keV);
  arr[BodyMaterials.IODINE_COL] = BodyMaterials.muIodinePerConc(keV);
  arr[BodyMaterials.BARIUM_COL] = BodyMaterials.muBariumPerConc(keV);
  return arr;
}
// Precompute per-material μ over a polyenergetic spectrum's bins — used by the scout
// (polyenergetic transmission Σ_bin w·exp(−Σ_m μ_m·L_m)). Returns [nmat+1][nbins].
// The extra trailing row is iodine, in cm^-1 per mgI/mL: the tracer puts
// concentration-weighted path length in the matching column, so the same L @ mu that
// integrates the materials also integrates the contrast. See BodyMaterials.IODINE_COL.
export function muOverBins(bins) {
  const n = BodyMaterials.count, tbl = new Array(BodyMaterials.TRACE_LEN);
  for (let i = 0; i < n; i++) { const row = new Float64Array(bins.length); for (let b = 0; b < bins.length; b++) row[b] = BodyMaterials.muById(i, bins[b].E); tbl[i] = row; }
  const io = new Float64Array(bins.length), ba = new Float64Array(bins.length);
  for (let b = 0; b < bins.length; b++) {
    io[b] = BodyMaterials.muIodinePerConc(bins[b].E);
    ba[b] = BodyMaterials.muBariumPerConc(bins[b].E);
  }
  tbl[BodyMaterials.IODINE_COL] = io;
  tbl[BodyMaterials.BARIUM_COL] = ba;
  return tbl;
}
