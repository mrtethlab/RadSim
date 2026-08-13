/* ============================================================================
   FLUORO PULSE WORKER
   One pulse = one raycast of the circular field, off the main thread so the pedal, the
   C-arm and the UI never stutter. The volume is COPIED in once per subject (GitHub Pages
   cannot set the COOP/COEP headers SharedArrayBuffer needs), then each pulse sends only
   geometry + technique and gets a Float32Array frame back, transferred.

   The budget that makes 30 pps thinkable (docs/fluoroscopy.md §4): a ~256 px circular
   field, THREE spectrum bins instead of twenty, no per-pulse scatter, and per-pulse
   Poisson noise — which is not a corner cut but the point: fluoro runs at ~1/1000 of a
   radiograph's mAs per frame, and the mottle that buys is what the operator learns to
   live with.
   ============================================================================ */
import { VoxelPhantom, muOverBins } from './core/voxelPhantom.js';

let ph = null;
let mu = null, binW = null, binKv = 0;

/* Three-point beam model: a pulsed beam at fixed kV needs beam-hardening SHAPE, not
   20-bin fidelity. Effective energies at ~45/65/88 % of kVp with weights that roughly
   match a 2.5 mm Al filtered tungsten spectrum's thirds. Phase B may refine this against
   the main thread's real spectrum; the bins are already exchangeable (kV-keyed). */
function setBins(kv) {
  const E = [0.45 * kv, 0.65 * kv, 0.88 * kv];
  binW = [0.35, 0.45, 0.20];
  mu = muOverBins(E.map((e) => ({ E: e })));
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

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    ph = new VoxelPhantom({ dims: m.dims, vs: m.vs, data: new Uint8Array(m.data) },
      m.center, m.flip, m.rot || null);
    postMessage({ type: 'ready' });
    return;
  }
  if (m.type !== 'pulse' || !ph) return;
  const t0 = performance.now();
  if (m.rot !== undefined) ph.setRotation(m.rot);
  if (m.center) ph.setCenter(m.center);
  if (m.kv !== binKv) setBins(m.kv);

  const { src, detC, detU, detV, half, n, photons } = m;
  seed = m.seed || seed;
  const img = new Float32Array(n * n);
  const nm = mu.length;
  const L0 = [src[0], src[1], src[2]];
  for (let j = 0; j < n; j++) {
    const v = ((j + 0.5) / n - 0.5) * 2 * half;
    for (let i = 0; i < n; i++) {
      const u = ((i + 0.5) / n - 0.5) * 2 * half;
      // circular II field: outside the circle there is no detector, flagged -1
      if (u * u + v * v > half * half) { img[j * n + i] = -1; continue; }
      const px = detC[0] + u * detU[0] + v * detV[0];
      const py = detC[1] + u * detU[1] + v * detV[1];
      const pz = detC[2] + u * detU[2] + v * detV[2];
      let dx = px - src[0], dy = py - src[1], dz = pz - src[2];
      const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
      const L = ph.trace(L0, [dx, dy, dz], 1e4);
      let T = 0;
      for (let b = 0; b < 3; b++) {
        let a = 0;
        for (let k = 1; k < nm; k++) { const l = L[k]; if (l) a += mu[k][b] * l; }
        T += binW[b] * Math.exp(-a);
      }
      img[j * n + i] = photons > 0 ? poisson(photons * T) / photons : T;
    }
  }
  postMessage({ type: 'frame', img, ms: performance.now() - t0, id: m.id }, [img.buffer]);
};
