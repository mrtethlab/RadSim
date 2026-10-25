/* ============================================================================
   ANKLE FRACTURE — a displaced Weber B distal fibula, reduced under the C-arm
   (docs/fluoroscopy.md, "Ankle ORIF"). Pure functions on the label volume, so the pulse
   workers and the tests run the same code.

   THE FIBULA IS FOUND ON THE VOLUME, not read from the landmarks. The landmark tables are
   measured from the source leg and are being re-measured elsewhere; the bone itself cannot
   drift from the voxels it is made of. In the proximal slices of a leg the bone falls into two
   islands, and the smaller one on the lateral side is the fibula. It is followed down slice by
   slice, as the island that overlaps the one above. Where it touches the tibia (the
   syndesmosis, the incisura) or the talus (the lateral gutter) the islands fuse, and the
   fibula is then carried down as its own cross-section from the slice above, grown at most one
   voxel and cut on the far side of the midline to its neighbour — so a fused slice cannot pour
   the tibia into it. It ends where nothing overlaps: the tip of the lateral malleolus.

   THE FRACTURE is a plane, oblique as a supination-external-rotation injury breaks the fibula:
   from anteroinferior at the joint line to posterosuperior, rising ~55 degrees across the bone
   (Lauge-Hansen SER II, Weber B — at the level of the syndesmosis, which is what makes it a B).
   The distal fragment is every fibula voxel below it.

   THE DISPLACEMENT is a rigid move of that fragment, applied the way the knee's rider carries
   the patella (core/jointPose.js rideAlong): its bone is lifted out of its place, which becomes
   soft tissue, and set down where the move takes it, each voxel as 8 points so a turned grid
   leaves no holes. Restoring the box it can reach from a saved copy before each stamp makes any
   number of moves exact: the volume is always the scanned one plus ONE fragment, wherever it is.
   ============================================================================ */

// the bone materials (trabecular, cortical and the graded bone, as core/jointPose.js RIGID)
export const BONE = new Set([17, 18, 54, 55, 56, 57, 58, 59, 60, 61]);
export const SOFT = 10;                       // what a lifted fragment leaves behind (jointPose SOFT)

/* The injury as presented: the distal fragment ~4 mm lateral, ~3 mm short (drawn proximally
   past the fracture by the peroneals and the rotation), ~10 degrees externally rotated —
   a typical displaced SER IV-equivalent fibula on the mortise view. cm and degrees. */
export const WEBER_B = { lat: 0.4, ant: 0, prox: 0.3, rot: 10 };
/* What an acceptable reduction is: the fibula out to length and in line — residual
   displacement within 2 mm and rotation within 5 degrees (the usual intra-operative criteria:
   a 2 mm step or shortening on the mortise is the classic threshold for an incongruent joint). */
export const LIMITS = { mm: 2, deg: 5 };
const OBLIQUE = 55 * Math.PI / 180;           // the fracture line's rise across the bone
const LEVEL_CM = 3.0;                         // its centre above the malleolar tip
export const MARGIN_CM = 2.0;                 // how far the fragment may travel from where it broke

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const nrm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// rotation matrix (row-major) about unit axis e by ang radians
function rotMat(e, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c, [x, y, z] = e;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}
const mv = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];

const nb4 = (q, nx, n) => { const i = q % nx; return [i > 0 ? q - 1 : -1, i < nx - 1 ? q + 1 : -1, q - nx, q + nx >= n ? -1 : q + nx]; };
/* Slice k's bone as SOLID cross-sections: a distal fibula is a cortical ring round marrow the
   segmentation calls soft tissue, and a ring is what an erosion destroys — so the marrow is
   filled in (whatever the slice's outside cannot reach through non-bone is inside a bone). The
   fragment then carries its marrow with it, as a real one does. */
function sliceMask(data, nx, ny, k) {
  const n = nx * ny, off = n * k, m = new Uint8Array(n), out = [];
  for (let q = 0; q < n; q++) if (BONE.has(data[off + q])) m[q] = 1;
  for (let q = 0; q < n; q++) {
    const i = q % nx, j = (q / nx) | 0;
    if (!m[q] && (i === 0 || j === 0 || i === nx - 1 || j === ny - 1)) { m[q] = 2; out.push(q); }
  }
  for (let h = 0; h < out.length; h++) for (const r of nb4(out[h], nx, n)) if (r >= 0 && !m[r]) { m[r] = 2; out.push(r); }
  for (let q = 0; q < n; q++) m[q] = m[q] === 2 ? 0 : 1;
  return m;
}
/* The islands of a slice mask, 4-connected, each as its in-slice indices (q = i + nx j). */
function islands(m, nx, ny, minN, lab) {
  lab.fill(0);
  const n = nx * ny, out = [];
  let tag = 0;
  for (let q0 = 0; q0 < n; q0++) {
    if (lab[q0] || !m[q0]) continue;
    const px = [q0]; lab[q0] = ++tag;
    for (let h = 0; h < px.length; h++) for (const r of nb4(px[h], nx, n)) {
      if (r < 0 || lab[r] || !m[r]) continue;
      lab[r] = tag; px.push(r);
    }
    if (px.length >= minN) out.push(px);
  }
  return out;
}
function centroid(px, nx) {
  let si = 0, sj = 0;
  for (const q of px) { si += q % nx; sj += (q / nx) | 0; }
  return [si / px.length, sj / px.length];
}

/* A fused island split where it is thin: eroded by r voxels the bridge between two bones goes
   and they fall apart; each voxel of the island then goes to the core it is nearest along the
   bone (a breadth-first race from every core at once), and the fibula is the cores that lie
   mostly inside the slice above's fibula. Null when the erosion leaves one piece. */
function split(px, pm, nx, ny, r) {
  const M = new Uint8Array(nx * ny);
  for (const q of px) M[q] = 1;
  let E = M;
  for (let n = 0; n < r; n++) {
    const e = new Uint8Array(nx * ny);
    for (const q of px) {
      if (!E[q]) continue;
      const i = q % nx;
      if (i > 0 && i < nx - 1 && q >= nx && q + nx < nx * ny && E[q - 1] && E[q + 1] && E[q - nx] && E[q + nx]) e[q] = 1;
    }
    E = e;
  }
  const lab = new Int32Array(nx * ny), cores = [];
  for (const q0 of px) {
    if (!E[q0] || lab[q0]) continue;
    const c = [q0]; lab[q0] = cores.length + 1;
    for (let h = 0; h < c.length; h++) {
      const q = c[h], i = q % nx;
      for (const s of [i > 0 ? q - 1 : -1, i < nx - 1 ? q + 1 : -1, q - nx, q + nx]) {
        if (s < 0 || s >= nx * ny || lab[s] || !E[s]) continue;
        lab[s] = lab[q0]; c.push(s);
      }
    }
    cores.push(c);
  }
  if (cores.length < 2) return null;
  const front = cores.flat();
  for (let h = 0; h < front.length; h++) {
    const q = front[h], i = q % nx;
    for (const s of [i > 0 ? q - 1 : -1, i < nx - 1 ? q + 1 : -1, q - nx, q + nx]) {
      if (s < 0 || s >= nx * ny || lab[s] || !M[s]) continue;
      lab[s] = lab[q]; front.push(s);
    }
  }
  const keep = new Set();
  cores.forEach((c, n) => { if (c.filter((q) => pm[q]).length >= 0.5 * c.length) keep.add(n + 1); });
  return keep.size ? px.filter((q) => keep.has(lab[q])) : null;
}

/* latSign: which way the lateral side lies along the volume's own i axis (+1 or -1), or 0 to
   let the leg say: the fibula is the slenderer of the two bones, and the side it lies on IS
   lateral — which holds for either leg and needs no landmark.
   Returns { slices: [{ k, px }] top down, tipK, latSign } or null when no two-bone leg is found. */
export function findFibula(data, dims, sp, latSign) {
  const [nx, ny, nz] = dims;
  const minN = Math.max(6, Math.round(0.12 / (sp[0] * sp[1])));      // 0.12 cm^2: a fibula, not a speck
  const lab = new Int32Array(nx * ny);
  const erode = Math.max(1, Math.round(0.2 / sp[0]));               // a bridge up to ~4 mm wide
  // the start: the highest slice with two islands, the fibula the lateral one of the smaller; and
  // both whole there, a tibia of 3 cm^2 or more beside a fibula of 0.5 (the Foot's cut end is
  // domed, and in its narrowing top slices the bones are cut to slivers the trace then followed)
  const tibN = Math.round(3 / (sp[0] * sp[1])), fibN = Math.round(0.5 / (sp[0] * sp[1]));
  let k = nz - 1, prev = null;
  for (; k >= 0 && !prev; k--) {
    const isl = islands(sliceMask(data, nx, ny, k), nx, ny, minN, lab);
    if (isl.length < 2) continue;
    isl.sort((a, b) => b.length - a.length);
    if (isl[0].length < tibN) continue;
    const tib = centroid(isl[0], nx);
    if (!latSign) latSign = Math.sign(centroid(isl[1], nx)[0] - tib[0]) || 1;
    let best = null, bestL = 0;
    for (const p of isl.slice(1)) {
      const l = (centroid(p, nx)[0] - tib[0]) * latSign;
      if (l > bestL) { bestL = l; best = p; }
    }
    if (best && best.length >= fibN) prev = best;
  }
  if (!prev) return null;
  const slices = [{ k: k + 1, px: Int32Array.from(prev) }];
  const pm = new Uint8Array(nx * ny);
  for (; k >= 0; k--) {
    // the slice above, and the same grown by one voxel
    pm.fill(0);
    for (const q of prev) {
      pm[q] = 2;
      const i = q % nx;
      if (i > 0 && !pm[q - 1]) pm[q - 1] = 1;
      if (i < nx - 1 && !pm[q + 1]) pm[q + 1] = 1;
      if (q >= nx && !pm[q - nx]) pm[q - nx] = 1;
      if (q + nx < nx * ny && !pm[q + nx]) pm[q + nx] = 1;
    }
    const isl = islands(sliceMask(data, nx, ny, k), nx, ny, 1, lab);
    const over = isl.filter((p) => p.some((q) => pm[q]));
    if (!over.length) break;                                         // past the tip
    const tot = over.reduce((s, p) => s + p.length, 0);
    const cap = 1.6 * prev.length + 2 * Math.sqrt(prev.length) + 4;
    let cur = tot <= cap ? over.flat() : split(over.flat(), pm, nx, ny, erode);
    if (!cur || cur.length > cap || cur.length < 0.5 * prev.length) {
      // still fused: this slice's fibula is the one above (no growth), kept on its own side of
      // the midline to the rest of the island (the tibia or the talus)
      const [fi, fj] = centroid(prev, nx);
      const rest = over.flat().filter((q) => pm[q] !== 2);
      const [ri, rj] = rest.length ? centroid(rest, nx) : [fi, fj];
      const ax = ri - fi, ay = rj - fj, half = (ax * ax + ay * ay) / 2;
      cur = over.flat().filter((q) => pm[q] === 2 && ((q % nx) - fi) * ax + (((q / nx) | 0) - fj) * ay < half);
    }
    if (cur.length < Math.max(2, minN / 4)) break;
    slices.push({ k, px: Int32Array.from(cur) });
    prev = cur;
  }
  return { slices, tipK: slices[slices.length - 1].k, latSign };
}

/* The fracture and its fragment, from a found fibula. Coordinates are cm on the volume's own
   axes (p = index x spacing). Anterior is -j (the house convention: volume y = posterior),
   superior is +k; lateral is latSign along i. */
export function fractureFragment(data, dims, sp, fib, latSign) {
  const [nx, ny] = dims;
  const cm = (i, j, k) => [i * sp[0], j * sp[1], k * sp[2]];
  const cent = fib.slices.map((s) => { const [ci, cj] = centroid(s.px, nx); return cm(ci, cj, s.k); });
  const tipZ = fib.tipK * sp[2];
  // the fibula's axis: the shaft above the malleolus, mean of its upper half to mean of its lower
  const shaft = cent.filter((c) => c[2] > tipZ + 4);
  const use = shaft.length >= 6 ? shaft : cent;
  const h = (use.length / 2) | 0, mean = (a) => a.reduce((s, c) => [s[0] + c[0] / a.length, s[1] + c[1] / a.length, s[2] + c[2] / a.length], [0, 0, 0]);
  let sup = nrm(sub(mean(use.slice(0, h)), mean(use.slice(h))));
  if (sup[2] < 0) sup = sup.map((v) => -v);
  const orth = (v) => nrm(sub(v, sup.map((s) => s * dot(v, sup))));
  // three square axes on the fibula: along it, out to the side, and to the front (taken square
  // to the other two, toward -j, so a lateral push has no front-to-back part in it)
  const lat = orth([latSign, 0, 0]);
  let ant = nrm(crs(sup, lat));
  if (ant[1] > 0) ant = ant.map((v) => -v);
  // the plane's centre: on the axis line, LEVEL_CM above the tip
  const lev = tipZ + LEVEL_CM;
  let p0 = cent.reduce((b, c) => (Math.abs(c[2] - lev) < Math.abs(b[2] - lev) ? c : b), cent[0]);
  const n = nrm([0, 1, 2].map((a) => Math.sin(OBLIQUE) * ant[a] + Math.cos(OBLIQUE) * sup[a]));
  const idx = [], mat = [];
  let sc = [0, 0, 0];
  for (const s of fib.slices) for (const q of s.px) {
    const i = q % nx, j = (q / nx) | 0, p = cm(i, j, s.k);
    if (dot(sub(p, p0), n) >= 0) continue;                           // the proximal fibula stays
    const o = (s.k * ny + j) * nx + i;
    idx.push(o); mat.push(data[o]);
    sc = [sc[0] + p[0], sc[1] + p[1], sc[2] + p[2]];
  }
  if (!idx.length) return null;
  const pivot = sc.map((v) => v / idx.length);
  // external rotation turns the anterior surface laterally: about the axis that does that
  const er = dot(crs(sup, ant), lat) > 0 ? sup : sup.map((v) => -v);
  // the box the fragment can reach, in voxels
  const ext = [0, 1, 2].map(() => [Infinity, -Infinity]);
  for (const o of idx) {
    const v = [o % nx, ((o / nx) | 0) % ny, Math.floor(o / (nx * ny))];
    for (let a = 0; a < 3; a++) { ext[a][0] = Math.min(ext[a][0], v[a]); ext[a][1] = Math.max(ext[a][1], v[a]); }
  }
  const box = ext.map(([lo, hi], a) => [Math.max(0, lo - Math.ceil(MARGIN_CM / sp[a])), Math.min(dims[a] - 1, hi + Math.ceil(MARGIN_CM / sp[a]))]);
  return { idx: Int32Array.from(idx), mat: Uint8Array.from(mat), pivot, p0, n, lat, ant, sup, er, box,
    tipK: fib.tipK, sp: sp.slice(), dims: dims.slice() };
}

/* The fragment's move for a pose { lat, ant, prox (cm), rot (deg, + external) }, as a map of
   VOXEL INDICES p -> M p + t, so the worker stamps without knowing about centimetres. */
export function fragmentMove(frag, pose) {
  const R = rotMat(frag.er, (pose.rot || 0) * Math.PI / 180), s = frag.sp;
  const tc = [0, 1, 2].map((a) => frag.lat[a] * (pose.lat || 0) + frag.ant[a] * (pose.ant || 0) + frag.sup[a] * (pose.prox || 0));
  // cm: q = pivot + R (p - pivot) + tc ; voxels: p = S v
  const M = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M.push(R[r * 3 + c] * s[c] / s[r]);
  const Rp = mv(R, frag.pivot);
  const t = [0, 1, 2].map((a) => (frag.pivot[a] - Rp[a] + tc[a]) / s[a]);
  return { M, t };
}

/* The box's bytes, saved once while the volume is as scanned; put back before every stamp. */
export function boxSave(data, dims, box) {
  const [nx, ny] = dims, [[i0, i1], [j0, j1], [k0, k1]] = box, w = i1 - i0 + 1;
  const out = new Uint8Array(w * (j1 - j0 + 1) * (k1 - k0 + 1));
  let o = 0;
  for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++, o += w) {
    const s = (k * ny + j) * nx + i0;
    out.set(data.subarray(s, s + w), o);
  }
  return out;
}
export function boxRestore(data, dims, box, saved) {
  const [nx, ny] = dims, [[i0, i1], [j0, j1], [k0, k1]] = box, w = i1 - i0 + 1;
  let o = 0;
  for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++, o += w) data.set(saved.subarray(o, o + w), (k * ny + j) * nx + i0);
}
/* Put the fragment where `move` takes it: the box back as scanned, the fragment's bone lifted
   out (soft tissue where it was), then set down, 8 points a voxel, kept inside the box — its
   marrow first and its bone over it, so a turned voxel of marrow cannot punch a hole in the
   cortex beside it. */
export function stampFragment(data, dims, frag, saved, move) {
  boxRestore(data, dims, frag.box, saved);
  if (!move) return;
  const [nx, ny] = dims, idx = frag.idx, mat = frag.mat, { M, t } = move, B = frag.box;
  for (let n = 0; n < idx.length; n++) if (BONE.has(data[idx[n]])) data[idx[n]] = SOFT;
  for (let pass = 0; pass < 2; pass++) for (let n = 0; n < idx.length; n++) {
    if (BONE.has(mat[n]) !== (pass === 1)) continue;
    const o = idx[n], i = o % nx, j = ((o / nx) | 0) % ny, k = Math.floor(o / (nx * ny));
    for (const di of [-0.25, 0.25]) for (const dj of [-0.25, 0.25]) for (const dk of [-0.25, 0.25]) {
      const x = i + di, y = j + dj, z = k + dk;
      const X = Math.round(M[0] * x + M[1] * y + M[2] * z + t[0]);
      const Y = Math.round(M[3] * x + M[4] * y + M[5] * z + t[1]);
      const Z = Math.round(M[6] * x + M[7] * y + M[8] * z + t[2]);
      if (X < B[0][0] || X > B[0][1] || Y < B[1][0] || Y > B[1][1] || Z < B[2][0] || Z > B[2][1]) continue;
      data[(Z * ny + Y) * nx + X] = mat[n];
    }
  }
}

/* The reduction, judged as the image intensifier and the surgeon judge it: the fragment's
   residual displacement where it matters (its mean voxel, mm) split into length, side-to-side
   and front-to-back, and its rotation. Length is the one that cannot be argued with — a short
   fibula lets the talus shift, and 1 mm of talar shift costs ~40 % of tibiotalar contact. */
export function judgeReduction(pose, lim = LIMITS) {
  const mm = (v) => Math.round((v || 0) * 100) / 10;
  const r = { lengthMM: mm(pose.prox), latMM: mm(pose.lat), antMM: mm(pose.ant), rotDeg: Math.round((pose.rot || 0) * 10) / 10 };
  r.lengthOK = Math.abs(r.lengthMM) <= lim.mm;
  r.transOK = Math.hypot(r.latMM, r.antMM) <= lim.mm;
  r.rotOK = Math.abs(r.rotDeg) <= lim.deg;
  r.ok = r.lengthOK && r.transOK && r.rotOK;
  return r;
}

/* The mortise angle: how far the leg must turn in (or the C round) to put the beam square to
   the line through both malleoli — the lateral malleolus lies behind the medial in every ankle,
   which is why an AP hides the lateral clear space. Measured on the volume: the distal 1.5 cm of
   the fibula against the most medial bone in the same few cm, in front-to-back reach of it (the
   navicular, further forward, can be as medial). Degrees; positive turns the beam toward lateral. */
export function mortiseAngle(data, dims, sp, fib, latSign) {
  const [nx, ny] = dims;
  const top = fib.tipK + Math.round(1.5 / sp[2]);
  let lx = 0, ly = 0, ln = 0;
  for (const s of fib.slices) if (s.k <= top) for (const q of s.px) { lx += q % nx; ly += (q / nx) | 0; ln++; }
  if (!ln) return null;
  lx /= ln; ly /= ln;
  const reach = 2.5 / sp[1], k1 = fib.tipK + Math.round(2.5 / sp[2]);
  let lo = Infinity;
  const pts = [];
  for (let k = fib.tipK; k <= k1 && k < dims[2]; k++) for (let j = 0; j < ny; j++) {
    if (Math.abs(j - ly) > reach) continue;
    for (let i = 0; i < nx; i++) {
      if (!BONE.has(data[(k * ny + j) * nx + i])) continue;
      const m = -(i - lx) * latSign;                                   // how far medial, voxels
      pts.push(m, i, j);
      if (-m < lo) lo = -m;
    }
  }
  let mx = 0, my = 0, mn = 0;
  const tol = 0.4 / sp[0];
  for (let p = 0; p < pts.length; p += 3) if (-pts[p] <= lo + tol) { mx += pts[p + 1]; my += pts[p + 2]; mn++; }
  if (!mn) return null;
  const dLat = (lx - mx / mn) * latSign * sp[0];                      // lateral minus medial, cm
  const dAnt = -(ly - my / mn) * sp[1];                               // anterior is -j
  return Math.atan2(-dAnt, dLat) * 180 / Math.PI;
}
