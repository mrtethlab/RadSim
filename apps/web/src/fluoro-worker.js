/* ============================================================================
   FLUORO PULSE WORKER
   One pulse = one raycast of the circular field, off the main thread so the pedal, the
   C-arm and the UI never stutter. The volume is COPIED in once per subject (GitHub Pages
   cannot set the COOP/COEP headers SharedArrayBuffer needs), then each pulse sends only
   geometry + technique and gets a Float32Array frame back, transferred.

   THE MARCHER IS SPECIALISED, NOT SHARED. VoxelPhantom.trace stays pristine for x-ray
   and CT; this worker carries its own DDA with the animation warp INLINED, because the
   measured alternatives were bad: a per-cell hook closure cost 5x the whole raycast
   (~9M uninlinable calls per chest pulse), and recovering coordinates from flat indices
   with div/mod was as bad again. Here the warp is straight-line code inside the march,
   guarded by one z-band compare, and the three spectrum bins accumulate directly — no
   per-ray materials array at all.

   ANIMATED ANATOMY (docs/fluoroscopy.md §3) is derived, not shipped — and now lives in
   core/anatomyMotion.js, because ultrasound scans the same moving anatomy and two copies
   of "where is the diaphragm" would drift apart within a phase. This worker owns only the
   inlining. Motion PHASES are accumulated by the main thread (that is what makes
   breath-hold trivial); the worker stays stateless between pulses.
   ============================================================================ */
import { VoxelPhantom, muOverBins } from './core/voxelPhantom.js';
import { BodyMaterials } from './core/materials.js';
import { deriveMotion, motionState, brWall } from './core/anatomyMotion.js';

let ph = null;
let anim = null;
let vsMM = [2, 2, 2];
let binKv = 0, binW = null;
let mu0 = null, mu1 = null, mu2 = null;      // flat per-material mu, one array per bin
let muLung = [0, 0, 0];                       // unscaled lung mu per bin, for breathing
// Enteric barium (docs/fluoroscopy.md Phase D): the x-ray tracer's mechanism, inlined the
// worker's way. giVol maps each voxel to its arclength bin (per subject, sent once);
// ba/gas LUTs are [material id][bin] snapshots of the LIVE study, sent per pulse.
let giVol = null, baLut = null, gasLut = null, giNS = 256;
let muBa0 = 0, muBa1 = 0, muBa2 = 0;          // mu per (mg Ba/mL)·cm, one per bin
let muGas0 = 0, muGas1 = 0, muGas2 = 0;       // bowel gas, for the double-contrast displacement
// IV iodine (Phase E — DSA needs vessels that opacify): same mechanism, its own maps.
// sVol bins voxels along the vessel tree; the conc LUT snapshots the injector timeline.
let sVol = null, iodLut = null, svNS = 256;
let muIo0 = 0, muIo1 = 0, muIo2 = 0;          // mu per (mg I/mL)·cm, one per bin

function setBins(kv) {
  const E = [0.45 * kv, 0.65 * kv, 0.88 * kv];
  binW = [0.35, 0.45, 0.20];
  const mu = muOverBins(E.map((e) => ({ E: e })));
  const n = mu.length;
  mu0 = new Float64Array(n); mu1 = new Float64Array(n); mu2 = new Float64Array(n);
  for (let k = 0; k < n; k++) { mu0[k] = mu[k][0]; mu1[k] = mu[k][1]; mu2[k] = mu[k][2]; }
  muLung = [mu0[1], mu1[1], mu2[1]];
  const BARC = BodyMaterials.BARIUM_COL, GASI = BodyMaterials.idByName['Bowel gas'] || 0;
  const IODC = BodyMaterials.IODINE_COL;
  muBa0 = mu0[BARC]; muBa1 = mu1[BARC]; muBa2 = mu2[BARC];
  muGas0 = mu0[GASI]; muGas1 = mu1[GASI]; muGas2 = mu2[GASI];
  muIo0 = mu0[IODC]; muIo1 = mu1[IODC]; muIo2 = mu2[IODC];
  binKv = kv;
}

/* Poisson sample, gaussian approximation above 30 — per-pixel per-pulse, so speed wins. */
let seed = 12345;
function rand() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function randn() { return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(6.2831853 * rand()); }
function poisson(lam) {
  if (lam > 30) return Math.max(0, lam + Math.sqrt(lam) * randn());
  let l = Math.exp(-lam), k = 0, p = 1;
  do { k++; p *= rand(); } while (p > l);
  return k - 1;
}

/* ---- per-pulse warp state -------------------------------------------------
   The regions and the phase maths are shared (core/anatomyMotion.js); what stays here is
   the flattening into module-level scalars, so the marcher's inner loop reads locals
   instead of walking an object per cell. */
let wOn = false, wLo = 0, wHi = 0;
let brShift = null, brZ0 = 0, brZ1 = 0, WST = null;
let heOn = false, hx0 = 0, hx1 = 0, hy0 = 0, hy1 = 0, hz0 = 0, hz1 = 0;
let hcx = 0, hcy = 0, hcz = 0, hrx = 1, hry = 1, hrz = 1, hs = 1;
let swOn = false, swZ = 0, oeL = null;
let stOn = false, stZ = 0, stL = null;
let pinchW = 8, pinchWst = 12;

function applyAnimPulse(p) {
  const st = motionState(anim, p, vsMM[2] / 10, ph ? ph.nz : 1);
  // breathing thins the lungs too: more air in the same ribs — half of what makes a
  // breathing chest look alive is the density drop, no geometry needed. (Acoustically
  // it changes nothing, which is why this lives here and not in the shared module.)
  if (mu0) {
    const f = 1 - 0.22 * st.insp;
    mu0[1] = muLung[0] * f; mu1[1] = muLung[1] * f; mu2[1] = muLung[2] * f;
  }
  wOn = st.on; wLo = st.lo; wHi = st.hi;
  WST = st;                          // the radial taper needs the state, not just scalars
  brShift = st.brShift; brZ0 = st.brZ0; brZ1 = st.brZ1;
  heOn = st.heOn; hx0 = st.hx0; hx1 = st.hx1; hy0 = st.hy0; hy1 = st.hy1;
  hz0 = st.hz0; hz1 = st.hz1;
  hcx = st.hcx; hcy = st.hcy; hcz = st.hcz;
  hrx = st.hrx; hry = st.hry; hrz = st.hrz; hs = st.hs;
  swOn = st.swOn; swZ = st.swZ; oeL = st.oeL; pinchW = st.pinchW;
  stOn = st.stOn; stZ = st.stZ; stL = st.stL; pinchWst = st.pinchWst;
}

/* ---- the specialised marcher ----------------------------------------------
   Three attenuation sums (one per spectrum bin) for the ray o + t*d. A straight port of
   VoxelPhantom.trace's Amanatides-Woo DDA with the warp and mu accumulation inlined. */
const A3 = new Float64Array(3);
let bV = null;   // giVol when a barium study is live this pulse, else null — hoisted for the march
let iV = null;   // sVol when iodine is in the patient this pulse, else null
function traceMu(ox, oy, oz, dx, dy, dz) {
  A3[0] = A3[1] = A3[2] = 0;
  if (ph.rotated) {
    const R = ph.rotT;
    const cx = (ph.min[0] + ph.max[0]) / 2, cy = (ph.min[1] + ph.max[1]) / 2, cz = (ph.min[2] + ph.max[2]) / 2;
    const px = ox - cx, py = oy - cy, pz = oz - cz;
    ox = cx + R[0] * px + R[1] * py + R[2] * pz;
    oy = cy + R[3] * px + R[4] * py + R[5] * pz;
    oz = cz + R[6] * px + R[7] * py + R[8] * pz;
    const qx = R[0] * dx + R[1] * dy + R[2] * dz;
    const qy = R[3] * dx + R[4] * dy + R[5] * dz;
    const qz = R[6] * dx + R[7] * dy + R[8] * dz;
    dx = qx; dy = qy; dz = qz;
  }
  const min = ph.min, max = ph.max, vs = ph.vs;
  let t0 = 0, t1 = 1e4;
  for (let k = 0; k < 3; k++) {
    const ok = k === 0 ? ox : k === 1 ? oy : oz;
    const dk = k === 0 ? dx : k === 1 ? dy : dz;
    if (Math.abs(dk) < 1e-12) { if (ok < min[k] || ok > max[k]) return A3; continue; }
    const inv = 1 / dk;
    let ta = (min[k] - ok) * inv, tb = (max[k] - ok) * inv;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
    if (t1 <= t0) return A3;
  }
  const eps = 1e-6, nx = ph.nx, ny = ph.ny, nz = ph.nz, nxy = nx * ny;
  const fx = ph.flip[0], fy = ph.flip[1], fz = ph.flip[2];
  const data = ph.data;
  const px = ox + (t0 + eps) * dx, py = oy + (t0 + eps) * dy, pz = oz + (t0 + eps) * dz;
  let ix = Math.min(nx - 1, Math.max(0, Math.floor((px - min[0]) / vs[0])));
  let iy = Math.min(ny - 1, Math.max(0, Math.floor((py - min[1]) / vs[1])));
  let iz = Math.min(nz - 1, Math.max(0, Math.floor((pz - min[2]) / vs[2])));
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tDx = Math.abs(vs[0] / (dx || 1e-12)), tDy = Math.abs(vs[1] / (dy || 1e-12)), tDz = Math.abs(vs[2] / (dz || 1e-12));
  let tMaxX = dx ? ((min[0] + (ix + (dx > 0 ? 1 : 0)) * vs[0]) - ox) / dx : 1e30;
  let tMaxY = dy ? ((min[1] + (iy + (dy > 0 ? 1 : 0)) * vs[1]) - oy) / dy : 1e30;
  let tMaxZ = dz ? ((min[2] + (iz + (dz > 0 ? 1 : 0)) * vs[2]) - oz) / dz : 1e30;
  let t = t0;
  while (t < t1) {
    const tNext = Math.min(tMaxX, tMaxY, tMaxZ, t1);
    const seg = tNext - t;
    if (seg > 0) {
      const rx = fx ? nx - 1 - ix : ix;
      const ry = fy ? ny - 1 - iy : iy;
      const rz = fz ? nz - 1 - iz : iz;
      let di = rx + nx * (ry + ny * rz);
      if (wOn && rz >= wLo && rz <= wHi) {
        // ---- animation warp, inlined ----
        let x = rx, y = ry, z = rz, re = 0;
        if (brShift && z >= brZ0 && z <= brZ1) {
          // the body wall does not travel with the viscera, so the shift is scaled by how
          // far out of the trunk's core this cell sits — which makes it a float, and puts
          // breathing on the same recompute path as the heart
          const s = brShift[z] * brWall(WST, x, y);
          if (s >= 1 || s <= -1) { z += s; re = 1; }
        }
        if (heOn && x > hx0 && x < hx1 && y > hy0 && y < hy1 && z > hz0 && z < hz1) {
          const ex = (x - hcx) / hrx, ey = (y - hcy) / hry, ez = (z - hcz) / hrz;
          if (ex * ex + ey * ey + ez * ez < 1) {
            x = hcx + (x - hcx) * hs; y = hcy + (y - hcy) * hs; z = hcz + (z - hcz) * hs;
            re = 1;
          }
        }
        const zi0 = z | 0;
        if (swOn && z > swZ - pinchW && z < swZ + pinchW && zi0 >= oeL.z0 && zi0 <= oeL.z1) {
          const g = Math.cos(Math.PI / 2 * (z - swZ) / pinchW) ** 2;
          const f = 1 + 0.9 * g;
          x = oeL.lx[zi0] + (x - oeL.lx[zi0]) * f; y = oeL.ly[zi0] + (y - oeL.ly[zi0]) * f;
          re = 1;
        }
        if (stOn && z > stZ - pinchWst && z < stZ + pinchWst && zi0 >= stL.z0 && zi0 <= stL.z1) {
          const g = Math.cos(Math.PI / 2 * (z - stZ) / pinchWst) ** 2;
          const f = 1 + 0.35 * g;
          x = stL.lx[zi0] + (x - stL.lx[zi0]) * f; y = stL.ly[zi0] + (y - stL.ly[zi0]) * f;
          re = 1;
        }
        if (re) {
          const xi = x < 0 ? 0 : x >= nx ? nx - 1 : x | 0;
          const yi = y < 0 ? 0 : y >= ny ? ny - 1 : y | 0;
          const zi2 = z < 0 ? 0 : z >= nz ? nz - 1 : z | 0;
          di = xi + nx * (yi + ny * zi2);
        }
      }
      const id = data[di];
      if (id) {
        let m0 = mu0[id], m1 = mu1[id], m2 = mu2[id];
        // barium rides the SAME (warped) index as the anatomy, so the bolus follows the
        // wall wave for free; costs one boolean test per cell while no study runs
        if (bV) {
          const b = bV[di];
          if (b) {
            const k = id * giNS + b;
            if (gasLut) {
              const gf = gasLut[k];
              if (gf > 0) {   // gas displaces lumen fluid: swap that fraction of the material
                const g1 = 1 - gf;
                m0 = m0 * g1 + muGas0 * gf; m1 = m1 * g1 + muGas1 * gf; m2 = m2 * g1 + muGas2 * gf;
              }
            }
            const c = baLut[k];
            if (c > 0) { m0 += c * muBa0; m1 += c * muBa1; m2 += c * muBa2; }
          }
        }
        if (iV) {
          const b = iV[di];
          if (b) {
            const c = iodLut[id * svNS + b];
            if (c > 0) { m0 += c * muIo0; m1 += c * muIo1; m2 += c * muIo2; }
          }
        }
        A3[0] += m0 * seg; A3[1] += m1 * seg; A3[2] += m2 * seg;
      }
    }
    t = tNext;
    if (tNext >= t1) break;
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) { ix += sx; tMaxX += tDx; if (ix < 0 || ix >= nx) break; }
    else if (tMaxY <= tMaxZ) { iy += sy; tMaxY += tDy; if (iy < 0 || iy >= ny) break; }
    else { iz += sz; tMaxZ += tDz; if (iz < 0 || iz >= nz) break; }
  }
  return A3;
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    ph = new VoxelPhantom({ dims: m.dims, vs: m.vs, data: new Uint8Array(m.data) },
      m.center, m.flip, m.rot || null);
    vsMM = m.vsMM || [2, 2, 2];
    anim = null;
    giVol = null; baLut = null; gasLut = null; sVol = null; iodLut = null;
    anim = deriveMotion(ph.data, m.dims, vsMM);
    postMessage({ type: 'ready',
      anim: anim ? Object.keys(anim).filter((k) => k !== 'any' && anim[k]) : [] });
    return;
  }
  // the per-subject voxel -> arclength-bin maps, sent once when their study first goes live
  if (m.type === 'givol') { giVol = new Uint8Array(m.giVol); giNS = m.ns || giNS; return; }
  if (m.type === 'svol') { sVol = new Uint8Array(m.sVol); svNS = m.ns || svNS; return; }
  if (m.type !== 'pulse' || !ph) return;
  const t0 = performance.now();
  if (m.rot !== undefined) ph.setRotation(m.rot);
  if (m.center) ph.setCenter(m.center);
  if (m.kv !== binKv) setBins(m.kv);
  applyAnimPulse(m.anim);
  baLut = m.ba || null; gasLut = m.gas || null;
  if (m.giNS) giNS = m.giNS;
  bV = (baLut && giVol) ? giVol : null;
  iodLut = m.iod || null;
  if (m.svNS) svNS = m.svNS;
  iV = (iodLut && sVol) ? sVol : null;

  const { src, detC, detU, detV, half, n, photons } = m;
  const iris = m.iris || half;
  // the shutter pair: half-separation and the angle of its leaves. Wide open means no
  // band at all, and the compare below is skipped entirely.
  const shutHalf = (m.shut == null || m.shut >= half) ? 1e9 : m.shut;
  const shutC = Math.cos(m.shutRot || 0), shutS = Math.sin(m.shutRot || 0);
  seed = m.seed || seed;
  const img = new Float32Array(n * n);
  const w0 = binW[0], w1 = binW[1], w2 = binW[2];
  // ABC reads the mean transmission of the central disc BEFORE noise — the closed loop
  // wants the signal, not one pulse's mottle
  let roiSum = 0, roiCnt = 0;
  const roiR2 = (0.30 * half) * (0.30 * half);
  const cutR = Math.min(half, iris);
  for (let j = 0; j < n; j++) {
    const v = ((j + 0.5) / n - 0.5) * 2 * half;
    for (let i = 0; i < n; i++) {
      const u = ((i + 0.5) / n - 0.5) * 2 * half;
      // circular II field: outside the circle there is no detector; inside it but outside
      // the IRIS the beam never left the collimator — both draw black, but the iris is the
      // one that saves the patient dose
      const r2 = u * u + v * v;
      if (r2 > cutR * cutR) { img[j * n + i] = -1; continue; }
      // ...and the SHUTTERS: a rotatable pair of parallel leaves, so the collimated field
      // is a band across the circle rather than a smaller circle. Closing them onto the
      // anatomy of interest is the cheapest dose saving on the machine, and the only one
      // that costs nothing you wanted to see.
      if (shutHalf < 1e8 && Math.abs(v * shutC - u * shutS) > shutHalf) { img[j * n + i] = -1; continue; }
      const px = detC[0] + u * detU[0] + v * detV[0];
      const py = detC[1] + u * detU[1] + v * detV[1];
      const pz = detC[2] + u * detU[2] + v * detV[2];
      let dx = px - src[0], dy = py - src[1], dz = pz - src[2];
      const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
      const a = traceMu(src[0], src[1], src[2], dx, dy, dz);
      const T = w0 * Math.exp(-a[0]) + w1 * Math.exp(-a[1]) + w2 * Math.exp(-a[2]);
      if (r2 < roiR2) { roiSum += T; roiCnt++; }
      img[j * n + i] = photons > 0 ? poisson(photons * T) / photons : T;
    }
  }
  postMessage({ type: 'frame', img, ms: performance.now() - t0, id: m.id, film: !!m.film,
    roi: roiCnt ? roiSum / roiCnt : 0, photons }, [img.buffer]);
};
