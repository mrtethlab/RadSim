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

   ANIMATED ANATOMY (docs/fluoroscopy.md §3) is derived, not shipped: one scan pass at
   init finds the moving regions from the material ids themselves — lungs (1) give the
   diaphragm, heart (15) its ellipsoid, oesophagus (48) and stomach (49) their per-slice
   centrelines. Motion PHASES are accumulated by the main thread (that is what makes
   breath-hold trivial); the worker stays stateless between pulses.
   ============================================================================ */
import { VoxelPhantom, muOverBins } from './core/voxelPhantom.js';
import { BodyMaterials } from './core/materials.js';

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

/* ---- motion-region scan (once per subject) -------------------------------- */
function scanAnim(dims) {
  const [nx, ny, nz] = dims, data = ph.data;
  const cOes = new Float64Array(nz), cOesY = new Float64Array(nz), nOes = new Int32Array(nz);
  const cSto = new Float64Array(nz), cStoY = new Float64Array(nz), nSto = new Int32Array(nz);
  let lungLo = 1e9, lungHi = -1e9, nLung = 0;
  const h = { n: 0, sx: 0, sy: 0, sz: 0, x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9 };
  for (let z = 0; z < nz; z += 2) {
    for (let y = 0; y < ny; y += 2) {
      const row = (z * ny + y) * nx;
      for (let x = 0; x < nx; x += 2) {
        const id = data[row + x];
        if (id === 1) { nLung++; if (z < lungLo) lungLo = z; if (z > lungHi) lungHi = z; }
        else if (id === 15) {
          h.n++; h.sx += x; h.sy += y; h.sz += z;
          if (x < h.x0) h.x0 = x; if (x > h.x1) h.x1 = x;
          if (y < h.y0) h.y0 = y; if (y > h.y1) h.y1 = y;
          if (z < h.z0) h.z0 = z; if (z > h.z1) h.z1 = z;
        } else if (id === 48) { cOes[z] += x; cOesY[z] += y; nOes[z]++; }
        else if (id === 49) { cSto[z] += x; cStoY[z] += y; nSto[z]++; }
      }
    }
  }
  const a = { any: false };
  const vz = vsMM[2] / 10;
  if (nLung > 200) {
    // The diaphragm slab: from just below the lung base up through the lower half of the
    // lungs, weight 1 at the base tapering to 0 at the top. The shift samples superiorly,
    // which moves every boundary in the slab inferiorly — the dome descends on
    // inspiration. ~2 cm of quiet breathing.
    a.br = { z0: Math.max(0, Math.round(lungLo - 3 / vz)),
             z1: Math.round(lungLo + 0.55 * (lungHi - lungLo)),
             amp: 2.0 / vz };
    a.any = true;
  }
  if (h.n > 50) {
    a.heart = { cx: h.sx / h.n, cy: h.sy / h.n, cz: h.sz / h.n,
      rx: (h.x1 - h.x0) * 0.55 + 2, ry: (h.y1 - h.y0) * 0.55 + 2, rz: (h.z1 - h.z0) * 0.55 + 2 };
    a.any = true;
  }
  const line = (cx, cy, cnt) => {
    let z0 = -1, z1 = -1;
    for (let z = 0; z < nz; z++) if (cnt[z] > 0) { if (z0 < 0) z0 = z; z1 = z; }
    if (z0 < 0 || z1 - z0 < 6) return null;
    const lx = new Float64Array(nz), ly = new Float64Array(nz);
    let px = 0, py = 0;
    for (let z = z0; z <= z1; z++) {            // fill gaps by carrying the last centroid
      if (cnt[z] > 0) { px = cx[z] / cnt[z]; py = cy[z] / cnt[z]; }
      lx[z] = px; ly[z] = py;
    }
    return { z0, z1, lx, ly };
  };
  a.oeso = line(cOes, cOesY, nOes);
  a.sto = line(cSto, cStoY, nSto);
  if (a.oeso || a.sto) a.any = true;
  anim = a.any ? a : null;
}

/* ---- per-pulse warp state (rebuilt from the phases each pulse) ------------ */
let wOn = false, wLo = 0, wHi = 0;
let brShift = null, brZ0 = 0, brZ1 = 0;
let heOn = false, hx0 = 0, hx1 = 0, hy0 = 0, hy1 = 0, hz0 = 0, hz1 = 0;
let hcx = 0, hcy = 0, hcz = 0, hrx = 1, hry = 1, hrz = 1, hs = 1;
let swOn = false, swZ = 0, oeL = null;
let stOn = false, stZ = 0, stL = null;
let pinchW = 8, pinchWst = 12;

function applyAnimPulse(p) {
  if (p && p.off) p = null;   // motion disabled: every warp off, lung mu at rest
  // breathing thins the lungs too: more air in the same ribs — half of what makes a
  // breathing chest look alive is the density drop, no geometry needed
  const insp = anim && anim.br && p ? Math.sin(Math.PI * (p.br || 0)) ** 2 : 0;
  if (mu0) {
    const f = 1 - 0.22 * insp;
    mu0[1] = muLung[0] * f; mu1[1] = muLung[1] * f; mu2[1] = muLung[2] * f;
  }
  wOn = false;
  if (!anim || !p) return;
  const nz = ph.nz;
  let lo = 1e9, hi = -1e9;
  const band = (a2, b2) => { if (a2 < lo) lo = a2; if (b2 > hi) hi = b2; };
  const br = anim.br, he = anim.heart, oe = anim.oeso, st = anim.sto;
  brShift = null;
  if (br) {
    const dz = br.amp * insp;
    if (dz > 0.3) {
      brZ0 = br.z0; brZ1 = br.z1;
      brShift = new Int16Array(nz);
      for (let z = br.z0; z <= br.z1 && z < nz; z++) {
        const w = z <= br.z0 + 3 ? 1 : 1 - (z - br.z0) / (br.z1 - br.z0);
        brShift[z] = Math.min(nz - 1 - z, Math.round(dz * w));
      }
      band(br.z0, br.z1);
    }
  }
  // cardiac contraction: a sin^2 systolic pulse over the first 40 % of the cycle
  const cph = p.card || 0;
  const sysP = cph < 0.4 ? Math.sin(Math.PI * cph / 0.4) ** 2 : 0;
  heOn = !!he && sysP > 0.02;
  if (heOn) {
    hs = 1 / (1 - 0.08 * sysP);
    hcx = he.cx; hcy = he.cy; hcz = he.cz; hrx = he.rx; hry = he.ry; hrz = he.rz;
    hx0 = hcx - hrx; hx1 = hcx + hrx; hy0 = hcy - hry; hy1 = hcy + hry;
    hz0 = hcz - hrz; hz1 = hcz + hrz;
    band(hz0, hz1);
  }
  pinchW = 1.5 / (vsMM[2] / 10);
  pinchWst = pinchW * 1.6;
  // swallow: a constriction wave running the oesophagus top -> bottom in ~1.2 s
  swOn = !!oe && p.sw != null && p.sw >= 0 && p.sw < 1.6;
  if (swOn) {
    swZ = oe.z1 - (oe.z1 - oe.z0) * (Math.min(p.sw, 1.2) / 1.2);
    oeL = oe;
    band(swZ - pinchW, swZ + pinchW);
  }
  // stomach peristalsis: slow waves crawling aborally, one every ~7 s
  stOn = !!st;
  if (stOn) {
    stZ = st.z1 - ((p.peri || 0) * (st.z1 - st.z0) / 7) % (st.z1 - st.z0);
    stL = st;
    band(stZ - pinchWst, stZ + pinchWst);
  }
  if (lo <= hi) { wOn = true; wLo = lo; wHi = hi; }
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
          const s = brShift[z];
          if (s) { z += s; di += s * nxy; }
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
    scanAnim(m.dims);
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
  postMessage({ type: 'frame', img, ms: performance.now() - t0, id: m.id,
    roi: roiCnt ? roiSum / roiCnt : 0, photons }, [img.buffer]);
};
