/* THE SURGICAL FILMS' GEOMETRY: the numbers under the kit (kit.js), kept apart from three.js so the
   unit tests can load them.

   One frame for everything a film places: the PATIENT'S FRAME, cm, the room's own axes (x across
   the table toward the operator's side, y up, z toward the head). The patient's mesh is put in the
   room by a translation only (kit.js K.toRoom), so a direction is the same in both. The child lies
   prone: its +x is its LEFT, +y its back (the pediatric volume is LPS); the adult lies supine: its
   +x is its RIGHT, +y its front (the chest/abdomen/pelvis volume, capFrame.js).

   The C-arm (fluoro/suite.js setPose): `orbital` turns the beam about the long axis (0 straight up
   through the table, +90 a lateral with the receptor on +x), `tilt` about the table's cross axis
   (+ the receptor toward the head). The beam's direction and the image's axes (right U, up V):
     d = (sin o, cos o cos t, cos o sin t)
     U = (-cos o, sin o cos t, sin o sin t),   V = (0, -sin t, cos t)
   so the prone child's AP shows its right on the right (seen from behind, as the operator sees
   it) and the supine adult's its right on the left (a radiograph as it is viewed). The images
   (services/compute app/build_anim_images.py build_surg) are parallel projections round each
   region's centre: a point lands on pixel (column, row) = (n/2 + (p - c).U n/span,
   n/2 - (p - c).V n/span), pixel i covering [i, i + 1). */
const D = Math.PI / 180;

export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k],
};

/* The beam d and the image's right U and up V for a pose (degrees). */
export function beamAxes(orbital = 0, tilt = 0) {
  const o = orbital * D, t = tilt * D;
  const so = Math.sin(o), co = Math.cos(o), st = Math.sin(t), ct = Math.cos(t);
  return { d: [so, co * ct, co * st], U: [-co, so * ct, so * st], V: [0, -st, ct] };
}

/* A point (the patient's frame) -> [column, row] on region R's image (fractional pixels). */
export function project(R, orbital, tilt, p) {
  const { U, V } = beamAxes(orbital, tilt);
  const q = v3.sub(p, R.centre), k = R.n / R.span;
  return [R.n / 2 + v3.dot(q, U) * k, R.n / 2 - v3.dot(q, V) * k];
}

/* The frame nearest a pose: its index in R.frames ([orbital, tilt, lo, hi] each). Tilt counts
   double: a degree of it moves the endplates more than one of orbit moves anything. */
export function nearestFrame(R, orbital, tilt) {
  let best = 0, bd = Infinity;
  R.frames.forEach((f, i) => {
    const d = (f[0] - orbital) ** 2 + 2 * (f[1] - tilt) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

/* The frames to blend for a pose, [[index, weight], ...]: bilinear in whichever of the region's
   grids holds the pose (between its rows of orbit and of tilt, so a turning C-arm's image turns
   smoothly), else the nearest frame alone. */
export function frameWeights(R, orbital, tilt) {
  if (!R._at) {
    R._at = new Map();
    R.frames.forEach((f, i) => R._at.set(f[0] + '/' + f[1], i));
  }
  const bracket = (xs, x) => {
    if (xs.length === 1) return Math.abs(x - xs[0]) < 1e-6 ? [0, 0, 0] : null;
    if (x < xs[0] - 1e-6 || x > xs[xs.length - 1] + 1e-6) return null;
    let i = 0;
    while (i < xs.length - 2 && x > xs[i + 1]) i++;
    const k = Math.max(0, Math.min(1, (x - xs[i]) / (xs[i + 1] - xs[i])));
    return [i, i + 1, k];
  };
  for (const [os, ts] of R.grids) {
    const bo = bracket(os, orbital), bt = ts.length === 1 ? (Math.abs(tilt - ts[0]) < 0.5 ? [0, 0, 0] : null) : bracket(ts, tilt);
    if (!bo || !bt) continue;
    const out = [];
    for (const [oi, wo] of [[bo[0], 1 - bo[2]], [bo[1], bo[2]]]) for (const [ti, wt] of [[bt[0], 1 - bt[2]], [bt[1], bt[2]]]) {
      const w = wo * wt;
      if (w < 1e-4) continue;
      const i = R._at.get(os[oi] + '/' + ts[ti]);
      if (i == null) continue;
      const have = out.find((e) => e[0] === i);
      if (have) have[1] += w; else out.push([i, w]);
    }
    if (out.length) return out;
  }
  return [[nearestFrame(R, orbital, tilt), 1]];
}

/* A tissue crop (build_surg's surg_x_*): the code at a point of the patient's frame, -1 outside.
   crop: { origin (voxel 0's centre), voxel (cm), dims [nx, ny, nz], data (x fastest, z up) }. */
export function tissueAt(crop, p) {
  const [nx, ny, nz] = crop.dims, s = crop.voxel, o = crop.origin;
  const i = Math.round((p[0] - o[0]) / s), j = Math.round((p[1] - o[1]) / s), k = Math.round((p[2] - o[2]) / s);
  if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1;
  return crop.data[i + nx * (j + ny * k)];
}

/* The tissues a needle passes from p0 to p1, in order: [{ code, from, to }] (cm along it). */
export function tissuesAlong(crop, p0, p1, step = 0.05) {
  const L = v3.len(v3.sub(p1, p0)), out = [];
  for (let s = 0; s <= L + 1e-9; s += step) {
    const c = tissueAt(crop, v3.lerp(p0, p1, L ? s / L : 0));
    const last = out[out.length - 1];
    if (last && last.code === c) last.to = s; else out.push({ code: c, from: s, to: s });
  }
  return out;
}

/* The cross-section panel's plane: B (the panel's up) back along the needle toward the skin, A
   (its right) across, in the plane of the needle and `across` (default: the patient's long axis,
   or x when the needle runs along that). Returns { A, B }. */
export function sectionAxes(dir, across = null) {
  const B = v3.mul(v3.norm(dir), -1);
  let a = across || [0, 0, 1];
  if (Math.abs(v3.dot(v3.norm(a), B)) > 0.95) a = [1, 0, 0];
  const A = v3.norm(v3.sub(a, v3.mul(B, v3.dot(a, B))));
  return { A, B };
}

/* Where a line into the body from `target` back along -dir leaves the skin, given the body's top
   surface top(x, z) (the patient's frame, cm; null off the body): the entry point for a needle
   aimed at target along dir. */
export function skinEntry(top, target, dir, max = 30) {
  const d = v3.norm(dir);
  for (let s = 0; s <= max; s += 0.05) {
    const p = v3.sub(target, v3.mul(d, s));
    const y = top(p[0], p[2]);
    if (y == null || p[1] >= y) return p;
  }
  return v3.sub(target, v3.mul(d, max));
}
