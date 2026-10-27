/* ============================================================================
   THE ARM MODEL'S CHEST WALL — lung where the crop left muscle.

   The arm model (build_limbs.py) is cut from a CT with a slab of the chest beside the shoulder:
   the lateral arc of the upper ribs, and medial of them, up to the crop, what the segmentation
   called soft tissue. In the source that is the lung's edge and the chest wall over it; in the
   model it is solid. On an AP the slab is beside the field, but turned for a scapular Y the beam
   runs 15-20 cm along it, and the shoulder hung under a white dome where the film shows the
   scapula over the lateral ribs and the lung.

   So when the model is loaded, the soft tissue medial of the ribs' arc is made lung. The arc is
   found on the volume: the bone pieces that are not the arm's (the forearm and hand, the humerus,
   the scapula, the clavicle: the largest four) are the ribs; at each level the ribs within a few
   centimetres above and below give, row by row, how far out the cage reaches, and everything
   beyond that (and a rib's thickness in) is the cage's inside. Only fat, muscle and soft tissue
   change; the ribs, the cartilage and the skin stay.
   ============================================================================ */

export const LUNG = 1;
const SOFT = new Set([2, 7, 10]);                        // fat, muscle, soft tissue
const BONE = new Set([17, 18, 54, 55, 56, 57, 58, 59, 60, 61]);

/* vol: { data: Uint8Array (x fastest), dims: [nx, ny, nz], spacingMM }. Returns how many voxels
   were made lung (the volume is changed in place). keep: the largest bone pieces that are the
   limb and its girdle, not ribs; window, wall: cm. */
export function fillThoraxLung(vol, { keep = 4, window = 2.5, wall = 0.25 } = {}) {
  const [nx, ny, nz] = vol.dims, d = vol.data, sp = (vol.spacingMM?.[0] || 1) / 10;
  const N = nx * ny * nz;
  // the bone pieces (6-connected)
  const lab = new Int32Array(N);
  const sizes = [0];
  const stack = new Int32Array(N > 1 << 24 ? 1 << 24 : N);
  for (let s = 0; s < N; s++) {
    if (lab[s] || !BONE.has(d[s])) continue;
    const id = sizes.length; let n = 0, top = 0;
    stack[top++] = s; lab[s] = id;
    while (top) {
      const q = stack[--top]; n++;
      const x = q % nx, y = ((q / nx) | 0) % ny, z = (q / (nx * ny)) | 0;
      const nb = [x > 0 ? q - 1 : -1, x < nx - 1 ? q + 1 : -1, y > 0 ? q - nx : -1, y < ny - 1 ? q + nx : -1,
        z > 0 ? q - nx * ny : -1, z < nz - 1 ? q + nx * ny : -1];
      for (const r of nb) if (r >= 0 && !lab[r] && BONE.has(d[r]) && top < stack.length) { lab[r] = id; stack[top++] = r; }
    }
    sizes.push(n);
  }
  const order = sizes.map((n, i) => [n, i]).slice(1).sort((a, b) => b[0] - a[0]).map((p) => p[1]);
  const limb = new Set(order.slice(0, keep));
  const ribs = new Set(order.slice(keep).filter((i) => sizes[i] >= 500));
  if (!ribs.size) return 0;
  // which way the trunk lies (the ribs' side of the humerus, the second piece) and the ribs' levels
  let rx = 0, rn = 0, hx = 0, hn = 0, z0 = nz, z1 = -1;
  const pts = [];
  for (let q = 0; q < N; q++) {
    const l = lab[q]; if (!l) continue;
    const x = q % nx;
    if (ribs.has(l)) {
      const y = ((q / nx) | 0) % ny, z = (q / (nx * ny)) | 0;
      pts.push(x, y, z); rx += x; rn++;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    } else if (l === order[1]) { hx += x; hn++; }
  }
  const medialUp = rx / rn > hx / Math.max(1, hn);         // the cage lies toward +x in the grid
  const W = Math.round(window / sp), T = Math.max(1, Math.round(wall / sp));
  let made = 0;
  for (let z = z0; z <= z1; z++) {
    // the cage's lateral reach, row by row, from the ribs within the window
    const reach = new Float64Array(ny).fill(NaN);
    for (let k = 0; k < pts.length; k += 3) {
      if (Math.abs(pts[k + 2] - z) > W) continue;
      const y = pts[k + 1], x = pts[k];
      const r = reach[y];
      reach[y] = Number.isNaN(r) ? x : medialUp ? Math.min(r, x) : Math.max(r, x);
    }
    // rows between ribs that the window missed: the cage between the rows either side of them
    let last = -1;
    for (let y = 0; y < ny; y++) {
      if (Number.isNaN(reach[y])) continue;
      if (last >= 0 && y - last > 1) for (let k = last + 1; k < y; k++) reach[k] = Math.round(reach[last] + (reach[y] - reach[last]) * (k - last) / (y - last));
      last = y;
    }
    for (let y = 0; y < ny; y++) {
      const r = reach[y]; if (Number.isNaN(r)) continue;
      const o = (z * ny + y) * nx;
      if (medialUp) { for (let x = r + T; x < nx; x++) if (SOFT.has(d[o + x])) { d[o + x] = LUNG; made++; } }
      else { for (let x = r - T; x >= 0; x--) if (SOFT.has(d[o + x])) { d[o + x] = LUNG; made++; } }
    }
  }
  return made;
}
