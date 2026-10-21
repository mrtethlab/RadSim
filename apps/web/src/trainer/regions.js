/* REQUIRED ANATOMY, from the model itself.

   A view's required anatomy is a rule — which tissue (all of it, bone, or lung) inside which
   window of the patient — and this samples it from the voxel volume into a point cloud in the
   volume's post-flip frame (the frame landmarkLocal() returns). The window's edges can hang
   off measured landmarks ("3.5 cm proximal of the carpals"), so the rule reads like the
   textbook's and moves with the model if it is rebuilt.

   part: { mat: 'tissue' | 'bone' | 'lung',
           x|y|z: [lo, hi] where each bound is a number (cm), null (open), or
                  { lm: 'wrist', axis: 'z', add: -3.5 } (a landmark's coordinate plus cm) }
   Sampling is on a grid of about 3-4 mm, which is the precision the border criterion needs. */

const BONE = new Set([17, 18, 19, 21, 54, 55, 56, 57, 58, 59, 60, 61]);
const NOT_PATIENT = new Set([0, 24, 25, 26, 27, 28]);       // air, metals, acrylic (test objects)
function matches(mat, id) {
  if (mat === 'bone') return BONE.has(id);
  if (mat === 'lung') return id === 1;
  return !NOT_PATIENT.has(id);
}

function bound(b, lmLoc) {
  if (b == null) return null;
  if (typeof b === 'number') return b;
  const p = lmLoc(b.lm);
  if (!p) return null;
  return p[{ x: 0, y: 1, z: 2 }[b.axis || 'z']] + (b.add || 0);
}

/* vm: the voxel model ({ dims, spacingMM, data }); flips: voxelFlips(); lmLoc(name): the landmark
   in the post-flip frame; parts: the rule. Returns Float32Array [x,y,z,...] (cm).
   part.connect: 'landmark' keeps only what is CONNECTED to that landmark inside the window — a
   CT of one leg can still carry a slice of the other at the ankle, and a field drawn round both
   would be marked as right. Flood fill on the sampling grid, 6-connected, seeded at the nearest
   matching cell to the landmark. */
export function sampleRegion(vm, flips, lmLoc, parts, gridCm = 0.35) {
  const [nx, ny, nz] = vm.dims, data = vm.data;
  const sp = vm.spacingMM.map((v) => v / 10);
  const step = sp.map((v) => Math.max(1, Math.round(gridCm / v)));
  const gx = Math.ceil(nx / step[0]), gy = Math.ceil(ny / step[1]), gz = Math.ceil(nz / step[2]);
  const cx = (nx - 1) / 2, cy = (ny - 1) / 2, cz = (nz - 1) / 2;
  const sx = flips[0] ? -1 : 1, sy = flips[1] ? -1 : 1, sz = flips[2] ? -1 : 1;
  const pos = (a, g) => [sx * (a * step[0] - cx) * sp[0], sy * (g[0] * step[1] - cy) * sp[1], sz * (g[1] * step[2] - cz) * sp[2]];
  const out = [];
  for (const part of parts) {
    const win = ['x', 'y', 'z'].map((a) => {
      const w = part[a];
      return w ? [bound(w[0], lmLoc), bound(w[1], lmLoc)] : [null, null];
    });
    const inWin = (v, w) => (w[0] == null || v >= w[0]) && (w[1] == null || v <= w[1]);
    // the matching cells of the sampling grid
    const occ = new Uint8Array(gx * gy * gz);
    for (let c = 0; c < gz; c++) {
      const z = sz * (c * step[2] - cz) * sp[2];
      if (!inWin(z, win[2])) continue;
      for (let b = 0; b < gy; b++) {
        const y = sy * (b * step[1] - cy) * sp[1];
        if (!inWin(y, win[1])) continue;
        const row = (c * step[2] * ny + b * step[1]) * nx;
        for (let a = 0; a < gx; a++) {
          if (!matches(part.mat, data[row + a * step[0]])) continue;
          if (!inWin(sx * (a * step[0] - cx) * sp[0], win[0])) continue;
          occ[(c * gy + b) * gx + a] = 1;
        }
      }
    }
    let keep = occ;
    const seed = part.connect ? lmLoc(part.connect) : null;
    if (seed) {
      // the matching cell nearest the landmark
      let best = -1, bd = Infinity;
      for (let q = 0; q < occ.length; q++) {
        if (!occ[q]) continue;
        const a = q % gx, b = ((q / gx) | 0) % gy, c = (q / (gx * gy)) | 0;
        const p = pos(a, [b, c]);
        const d = (p[0] - seed[0]) ** 2 + (p[1] - seed[1]) ** 2 + (p[2] - seed[2]) ** 2;
        if (d < bd) { bd = d; best = q; }
      }
      keep = new Uint8Array(occ.length);
      if (best >= 0) {
        const stack = [best]; keep[best] = 1;
        while (stack.length) {
          const q = stack.pop();
          const a = q % gx, b = ((q / gx) | 0) % gy, c = (q / (gx * gy)) | 0;
          const nb = [a > 0 ? q - 1 : -1, a < gx - 1 ? q + 1 : -1, b > 0 ? q - gx : -1, b < gy - 1 ? q + gx : -1,
            c > 0 ? q - gx * gy : -1, c < gz - 1 ? q + gx * gy : -1];
          for (const r of nb) if (r >= 0 && occ[r] && !keep[r]) { keep[r] = 1; stack.push(r); }
        }
      }
    }
    // part.largest: keep only the N largest connected pieces (the two lungs, not the stomach and
    // bowel gas the lung-density label also covers)
    if (part.largest) {
      const lab = new Int32Array(keep.length), sizes = [0];
      for (let q0 = 0; q0 < keep.length; q0++) {
        if (!keep[q0] || lab[q0]) continue;
        const id = sizes.length; let n = 0;
        const stack = [q0]; lab[q0] = id;
        while (stack.length) {
          const q = stack.pop(); n++;
          const a = q % gx, b = ((q / gx) | 0) % gy, c = (q / (gx * gy)) | 0;
          const nb = [a > 0 ? q - 1 : -1, a < gx - 1 ? q + 1 : -1, b > 0 ? q - gx : -1, b < gy - 1 ? q + gx : -1,
            c > 0 ? q - gx * gy : -1, c < gz - 1 ? q + gx * gy : -1];
          for (const r of nb) if (r >= 0 && keep[r] && !lab[r]) { lab[r] = id; stack.push(r); }
        }
        sizes.push(n);
      }
      const top = new Set(sizes.map((n, id) => [n, id]).slice(1).sort((x, y) => y[0] - x[0]).slice(0, part.largest).map((t) => t[1]));
      const k2 = new Uint8Array(keep.length);
      for (let q = 0; q < keep.length; q++) if (lab[q] && top.has(lab[q])) k2[q] = 1;
      keep = k2;
    }
    for (let q = 0; q < keep.length; q++) {
      if (!keep[q]) continue;
      const a = q % gx, b = ((q / gx) | 0) % gy, c = (q / (gx * gy)) | 0;
      out.push(...pos(a, [b, c]));
    }
  }
  return new Float32Array(out);
}

// the bounding box of a cloud: its centre is a centring point for views that have no landmark
export function cloudCentre(pts) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < pts.length; k += 3) for (let a = 0; a < 3; a++) {
    if (pts[k + a] < lo[a]) lo[a] = pts[k + a];
    if (pts[k + a] > hi[a]) hi[a] = pts[k + a];
  }
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
}
