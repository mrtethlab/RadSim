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

export class VoxelPhantom {
  // model: { dims:[nx,ny,nz], vs:[sx,sy,sz] (cm), data:Uint8Array (x-fastest) }
  constructor(model, center = [0, 0, 0], flip = [false, false, false]) {
    this.voxel = true;
    const [nx, ny, nz] = model.dims;
    this.nx = nx; this.ny = ny; this.nz = nz;
    this.data = model.data;                     // null => geometry-only (backend does the tracing)
    this.geometryOnly = !model.data;
    this.vs = model.vs.slice();                 // cm/voxel per axis
    this.nmat = BodyMaterials.count;
    this.setCenter(center);
    this.flip = flip.slice();
  }
  setCenter(center) {
    // world AABB [min,max] with the volume centred on `center`
    const ext = [this.nx * this.vs[0], this.ny * this.vs[1], this.nz * this.vs[2]];
    this.min = [center[0] - ext[0] / 2, center[1] - ext[1] / 2, center[2] - ext[2] / 2];
    this.max = [center[0] + ext[0] / 2, center[1] + ext[1] / 2, center[2] + ext[2] / 2];
    this.extent = ext;
  }
  // material id at grid index (with anatomical flips applied on the data lookup)
  idAt(ix, iy, iz) {
    const dx = this.flip[0] ? this.nx - 1 - ix : ix;
    const dy = this.flip[1] ? this.ny - 1 - iy : iy;
    const dz = this.flip[2] ? this.nz - 1 - iz : iz;
    return this.data[dx + this.nx * (dy + this.ny * dz)];
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
  trace(o, d, maxT = Infinity) {
    const L = new Float32Array(this.nmat);
    if (this.geometryOnly) return L;   // no volume in the browser — the GPU backend traces
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
    while (t < t1) {
      const tNext = Math.min(tMaxX, tMaxY, tMaxZ, t1);
      const seg = tNext - t;
      if (seg > 0) L[this.idAt(ix, iy, iz)] += seg;
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
export function muAtEnergy(keV) {
  const n = BodyMaterials.count, arr = new Float64Array(n);
  for (let i = 0; i < n; i++) arr[i] = BodyMaterials.muById(i, keV);
  return arr;
}
// Precompute per-material μ over a polyenergetic spectrum's bins — used by the scout
// (polyenergetic transmission Σ_bin w·exp(−Σ_m μ_m·L_m)). Returns [nmat][nbins].
export function muOverBins(bins) {
  const n = BodyMaterials.count, tbl = new Array(n);
  for (let i = 0; i < n; i++) { const row = new Float64Array(bins.length); for (let b = 0; b < bins.length; b++) row[b] = BodyMaterials.muById(i, bins[b].E); tbl[i] = row; }
  return tbl;
}
