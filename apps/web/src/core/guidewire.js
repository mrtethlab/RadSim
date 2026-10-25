/* ============================================================================
   GUIDEWIRE — a 0.035" wire on the vessel tree (docs/fluoroscopy.md, "Guidewire")
   Pure functions, shared by the console (which drives the wire) and the pulse worker (which
   images it), so the tests check the same arithmetic the monitor shows.

   THE ROUTE IS THE CONTRAST SOLVER'S OWN GEOMETRY. Every vessel voxel carries its normalised
   geodesic arclength along its vessel (sVol, core/contrast.js — the same map that puts the
   iodine in the pulses), so the centreline is simply the centroid of each arclength bin. (A
   two-means split of bins holding two cross-sections, for a label that forks, was built and
   measured to change nothing: no shipped vessel forks within its label, and every centreline
   point lies in its own vessel's voxels on both vessel models, with or without it. It went.)
   Junctions are where two vessels' voxels touch and one of them
   ENDS there: arteries only with arteries, veins with veins (an iliac artery lies against its
   vein for its whole length, and no wire crosses a vessel wall).

   THE WIRE has a body that follows the route and a short angled tip (a shaped hydrophilic wire,
   ~45 degrees over its last 8 mm). Torquing turns the tip about the wire's axis; at a branch the
   wire goes where the tip points — taken when the tip faces the branch's take-off, ignored
   otherwise, which is the whole skill of selective work. Pulled back past a branch it forgets
   the choice, and advancing again re-decides with the tip as it now is.

   THE IMAGE: the wire is a steel cylinder 0.89 mm across, far below a voxel (1-2 mm), so it is
   not voxelised — it would image 2-5 times too thick. The worker adds its exact chord length to
   each ray instead, at the beam's three spectrum bins (steel's mu less the blood it displaces),
   averaged over a 3x3 grid of rays across the detector pixel, because a pixel integrates the
   photons over its area: a point-sampled 0.9 mm wire on a ~0.7 mm-at-isocentre pixel grid comes
   out dashed. wireFactors returns that per-bin transmission factor per pixel.
   ============================================================================ */

export const WIRE_R_CM = 0.0889 / 2;          // 0.035 inch
export const ARTERIES = [29, 35, 36, 37, 38, 39, 43, 44];
export const VEINS = [32, 33, 40, 41, 45, 46];
const STEP = 0.2;                             // route point spacing, cm
const TIP_LEN = 0.8, TIP_BEND = 45;           // the angled tip: cm, degrees
const OUTSIDE = 15;                           // wire left outside the access, through the sheath, cm

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const nrm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/* Centrelines, cm on the volume's own axes (p = index x spacing): { id: { pts, r } }, r the
   vessel's mean radius from its volume over its length. */
export function vesselCentrelines(mat, sVol, dims, sp, ids = [...ARTERIES, ...VEINS]) {
  const [nx, ny] = dims, want = new Set(ids);
  const acc = new Map();                                    // id -> per bin [n, sum i, sum j, sum k]
  for (let o = 0; o < mat.length; o++) {
    const id = mat[o];
    if (!want.has(id)) continue;
    let A = acc.get(id);
    if (!A) { A = new Float64Array(128 * 4); acc.set(id, A); }
    const q = (sVol[o] >> 1) * 4;
    A[q]++; A[q + 1] += o % nx; A[q + 2] += ((o / nx) | 0) % ny; A[q + 3] += Math.floor(o / (nx * ny));
  }
  const out = {};
  for (const [id, A] of acc) {
    const raw = [];
    let n = 0;
    for (let q = 0; q < A.length; q += 4) {
      if (!A[q]) continue;
      n += A[q];
      raw.push([A[q + 1] / A[q] * sp[0], A[q + 2] / A[q] * sp[1], A[q + 3] / A[q] * sp[2]]);
    }
    if (raw.length < 3) continue;
    // smoothed (5-point), then resampled at STEP along its length; s = 0 first, as the solver runs
    const sm = raw.map((_, i) => {
      const w = raw.slice(Math.max(0, i - 2), i + 3);
      return w.reduce((s, p) => add(s, p, 1 / w.length), [0, 0, 0]);
    });
    const pts = resample(sm, STEP);
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += dist(pts[i], pts[i - 1]);
    const vol = n * sp[0] * sp[1] * sp[2];
    out[id] = { pts, r: Math.sqrt(vol / (Math.PI * Math.max(len, STEP))) };
  }
  return out;
}
function resample(P, step) {
  const out = [P[0]];
  let acc = 0;
  for (let i = 1; i < P.length; i++) {
    let a = P[i - 1];
    const b = P[i];
    let seg = dist(a, b);
    while (acc + seg >= step) {
      const f = (step - acc) / seg;
      a = add(a, sub(b, a), f);
      out.push(a);
      seg = dist(a, b); acc = 0;
    }
    acc += seg;
  }
  if (dist(out[out.length - 1], P[P.length - 1]) > step * 0.3) out.push(P[P.length - 1]);
  return out;
}

/* Junctions: [{ a, ia, b, ib }] — vessel a's point ia meets vessel b's point ib, at least one of
   them within 1 cm of its own end. Found from the voxels themselves (6-neighbours of different
   labels in the same system), placed on the centrelines by their contact centroid. */
export function vesselJunctions(mat, dims, sp, lines) {
  const [nx, ny, nz] = dims, sys = new Map();
  ARTERIES.forEach((id) => sys.set(id, 1)); VEINS.forEach((id) => sys.set(id, 2));
  const acc = new Map();
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const o = (k * ny + j) * nx + i, a = mat[o], sa = sys.get(a);
    if (!sa || !lines[a]) continue;
    for (const [di, dj, dk] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      if (i + di >= nx || j + dj >= ny || k + dk >= nz) continue;
      const b = mat[o + di + dj * nx + dk * nx * ny];
      if (b === a || sys.get(b) !== sa || !lines[b]) continue;
      const key = Math.min(a, b) * 256 + Math.max(a, b);
      if (!acc.has(key)) acc.set(key, []);
      acc.get(key).push([(i + di / 2) * sp[0], (j + dj / 2) * sp[1], (k + dk / 2) * sp[2]]);
    }
  }
  const near = (pts, p) => { let best = 0, bd = Infinity; pts.forEach((q, i) => { const d = dist(q, p); if (d < bd) { bd = d; best = i; } }); return best; };
  const out = [];
  for (const [key, cs] of acc) {
    const a = key >> 8, b = key & 255, A = lines[a], B = lines[b];
    /* Two vessels can touch in more than one place (stray labels, a vessel lying across
       another), so the contact is taken at an END: the end with the most contacts within a
       centimetre of it, and those contacts' centroid must lie on both vessels — within their
       radii of each centreline — or it is a graze, not a junction. */
    const ends = [];
    for (const [v, L] of [[a, A], [b, B]]) for (const ie of [0, L.pts.length - 1]) {
      const near1 = cs.filter((p) => dist(p, L.pts[ie]) <= 1 + 2 * L.r);
      if (near1.length >= 3) ends.push({ v, ie, cs: near1 });
    }
    ends.sort((x, y) => y.cs.length - x.cs.length);
    // an index within a centimetre of its vessel's end IS the end: the wire must meet the
    // junction where it runs out of vessel, not pass it a few points short
    const snap = (L, i) => (i * STEP <= 1 ? 0 : (L.pts.length - 1 - i) * STEP <= 1 ? L.pts.length - 1 : i);
    for (const e of ends) {
      const c = e.cs.reduce((s, p) => add(s, p, 1 / e.cs.length), [0, 0, 0]);
      const ia = e.v === a ? e.ie : near(A.pts, c), ib = e.v === b ? e.ie : near(B.pts, c);
      if (dist(c, A.pts[ia]) > A.r + 4 || dist(c, B.pts[ib]) > B.r + 4) continue;
      out.push({ a, ia: snap(A, ia), b, ib: snap(B, ib) });
      break;
    }
  }
  return out;
}

/* The access: the end of `id` that touches nothing (the groin end of an iliac), and the
   direction into the vessel from it. */
export function accessOf(lines, juncs, id) {
  const L = lines[id]; if (!L) return null;
  const m = L.pts.length - 1;
  const used = (i) => juncs.some((J) => (J.a === id && J.ia === i) || (J.b === id && J.ib === i));
  let end = !used(m) && used(0) ? m : !used(0) && used(m) ? 0 : (L.pts[0][2] < L.pts[m][2] ? 0 : m);
  return { v: id, i: end, d: end === 0 ? 1 : -1 };
}

/* ---- the wire ------------------------------------------------------------------------
   state: { lines, juncs, route: [{ v, i, d }], len (cm inside), torque (deg) }. The route's
   points are centreline points; its first is the access. */
export function wireStart(lines, juncs, id, up = [0, -1, 0]) {
  const acc = accessOf(lines, juncs, id);
  if (!acc) return null;
  return { lines, juncs, up, route: [{ ...acc }], len: 0, torque: 0, blocked: false };
}
const P = (w, r) => w.lines[r.v].pts[r.i];
// the wire's direction at the end of its route, over the last ~5 mm
function headDir(w) {
  const R = w.route, n = R.length;
  if (n < 2) { const L = w.lines[R[0].v], j = Math.min(L.pts.length - 1, Math.max(0, R[0].i + R[0].d * 3)); return nrm(sub(L.pts[j], P(w, R[0]))); }
  return nrm(sub(P(w, R[n - 1]), P(w, R[Math.max(0, n - 4)])));
}
/* Where the tip points: the bend's direction, square to the wire. Torque 0 points it toward
   `up` (the console passes the patient's anterior, the ceiling for a supine patient: a tip
   pointing up picks no side branch by accident), or along i where the wire runs along `up`. */
export function tipBendDir(t, torque, up = [0, -1, 0]) {
  let ref = Math.abs(dot(t, up)) < 0.9 ? up : [1, 0, 0];
  ref = nrm(sub(ref, t.map((v) => v * dot(ref, t))));
  const b = crs(t, ref), a = torque * Math.PI / 180;
  return nrm(add(ref.map((v) => v * Math.cos(a)), b, Math.sin(a)));
}
// the ways on from the route's head: along its vessel, and into any vessel joined there
function choices(w) {
  const h = w.route[w.route.length - 1], L = w.lines[h.v], out = [];
  if (h.i + h.d >= 0 && h.i + h.d < L.pts.length) out.push({ v: h.v, i: h.i + h.d, d: h.d, along: true });
  for (const J of w.juncs) {
    for (const [x, ix, y, iy] of [[J.a, J.ia, J.b, J.ib], [J.b, J.ib, J.a, J.ia]]) {
      if (x !== h.v || ix !== h.i || y === h.v) continue;
      const M = w.lines[y].pts.length;
      if (iy + 1 < M) out.push({ v: y, i: iy + 1, d: 1 });
      if (iy - 1 >= 0) out.push({ v: y, i: iy - 1, d: -1 });
    }
  }
  return out;
}
/* Which way the wire goes. Straight on along its vessel unless the tip points into a branch
   (cos >= 0.64 between the bend and the branch's take-off, square to the wire; >= 0.8 for a
   turn past 90 degrees, which a shaped tip only just makes). At the end of a vessel the wire
   follows the gentlest way on by itself (< 60 degrees: it slides round a smooth curve) unless
   the tip is squarely (>= 0.8) facing another; a sharp turn the tip is not facing stops it. */
export function pickWay(w) {
  const opts = choices(w);
  if (!opts.length) return null;
  const D = headDir(w), B = tipBendDir(D, w.torque, w.up), h = w.route[w.route.length - 1], from = P(w, h);
  const scored = opts.map((o) => {
    // the way's own take-off: along the vessel it enters, from where it joins (a junction can
    // join the two centrelines a centimetre apart, and that hop is not a direction)
    const L = w.lines[o.v], j = Math.min(L.pts.length - 1, Math.max(0, o.i + o.d * 3));
    const C = nrm(sub(L.pts[j], o.along ? from : L.pts[o.i - o.d])), turn = Math.acos(Math.max(-1, Math.min(1, dot(C, D)))) * 180 / Math.PI;
    const perp = sub(C, D.map((v) => v * dot(C, D))), pl = Math.hypot(...perp);
    return { ...o, turn, point: pl > 1e-6 ? dot(B, perp) / pl : 0 };
  });
  const along = scored.find((o) => o.along);
  const easy = along || scored.filter((o) => o.turn < 60).sort((a, b) => a.turn - b.turn)[0];
  const need = (o) => (!easy || o.turn > 90 ? 0.8 : along ? 0.64 : 0.8);
  const branch = scored.filter((o) => o !== easy && o.turn >= 10 && o.turn <= 165 && o.point >= need(o))
    .sort((a, b) => b.point - a.point)[0];
  return branch || easy || null;
}
/* Advance (dl > 0) or withdraw (dl < 0) by dl cm. Returns the wire, its len capped where it
   could go no further (w.blocked set: the tip is against a wall or at the end of the map). */
export function wireMove(w, dl) {
  w.len = Math.max(0, w.len + dl);
  const lenOf = () => (w.route.length - 1) * STEP;
  while (lenOf() > w.len + 1e-9 && w.route.length > 1) w.route.pop();
  w.blocked = false;
  while (lenOf() < w.len - 1e-9) {
    const nx = pickWay(w);
    if (!nx) { w.blocked = true; w.len = lenOf(); break; }
    w.route.push({ v: nx.v, i: nx.i, d: nx.d });
  }
  return w;
}
// the vessel the tip is in, and how far in (cm)
export function wireTip(w) { const h = w.route[w.route.length - 1]; return { v: h.v, i: h.i, len: w.len }; }

/* The wire as a polyline, cm on the volume's axes: OUTSIDE cm out through the access along the
   vessel's own line, the route, and the angled tip bent toward where the torque points it —
   less in a vessel too narrow to hold the bend. */
export function wirePolyline(w) {
  const pts = w.route.map((r) => P(w, r));
  const t0 = nrm(sub(pts[0], w.lines[w.route[0].v].pts[Math.min(w.lines[w.route[0].v].pts.length - 1, Math.max(0, w.route[0].i + w.route[0].d * 5))]));
  const out = [];
  for (let s = OUTSIDE; s > 0; s -= 1) out.push(add(pts[0], t0, s));
  if (pts.length < 2) { out.push(pts[0]); return out; }
  const nTip = Math.min(pts.length - 1, Math.round(TIP_LEN / STEP));
  const body = pts.slice(0, pts.length - nTip);
  out.push(...body);
  const r = w.lines[w.route[w.route.length - 1].v].r;
  // the bend's sideways reach is ~0.37 x its length at 45 degrees; keep it inside 0.6 r
  const bend = Math.min(TIP_BEND, TIP_BEND * (0.6 * r) / (0.37 * TIP_LEN));
  let p = body[body.length - 1], t = headDir({ ...w, route: w.route.slice(0, w.route.length - nTip) });
  const B = tipBendDir(t, w.torque, w.up), dA = (bend * Math.PI / 180) / nTip;
  for (let n = 0; n < nTip; n++) {
    t = nrm(add(t.map((v) => v * Math.cos(dA)), B, Math.sin(dA)));
    p = add(p, t, STEP);
    out.push(p);
  }
  return out;
}

/* ---- imaging ---------------------------------------------------------------------------
   Chord length of the ray o + t d (|d| = 1) through the cylinder of radius r about the segment
   a -> b, ends cut square. Scalars underneath (chordW): the worker calls it ~10^5 times a pulse,
   and with every ray starting at the focal spot everything but d is fixed per segment. */
function chordW(we, wpx, wpy, wpz, C, dx, dy, dz, ex, ey, ez, l) {
  const de = dx * ex + dy * ey + dz * ez;
  const A = 1 - de * de, Bq = 2 * (wpx * dx + wpy * dy + wpz * dz);     // wp is square to e
  let t0, t1;
  if (A < 1e-12) { if (C > 0) return 0; t0 = -Infinity; t1 = Infinity; }
  else {
    const disc = Bq * Bq - 4 * A * C;
    if (disc <= 0) return 0;
    const sq = Math.sqrt(disc);
    t0 = (-Bq - sq) / (2 * A); t1 = (-Bq + sq) / (2 * A);
  }
  // the slab 0 <= (w + t d).e <= l
  if (Math.abs(de) < 1e-12) { if (we < 0 || we > l) return 0; }
  else {
    let s0 = -we / de, s1 = (l - we) / de;
    if (s0 > s1) { const q = s0; s0 = s1; s1 = q; }
    if (s0 > t0) t0 = s0;
    if (s1 < t1) t1 = s1;
  }
  return t1 > t0 ? t1 - t0 : 0;
}
// a segment's constants for rays from o: its axis e and length l, o - a split along e and square to it
function segOf(o, a, b, r) {
  const ab = sub(b, a), l = Math.hypot(ab[0], ab[1], ab[2]);
  if (l < 1e-9) return null;
  const e = [ab[0] / l, ab[1] / l, ab[2] / l], w = sub(o, a), we = dot(w, e);
  const wp = [w[0] - e[0] * we, w[1] - e[1] * we, w[2] - e[2] * we];
  return { e, l, we, wp, C: dot(wp, wp) - r * r };
}
export function chord(o, d, a, b, r) {
  const g = segOf(o, a, b, r);
  return g ? chordW(g.we, g.wp[0], g.wp[1], g.wp[2], g.C, d[0], d[1], d[2], g.e[0], g.e[1], g.e[2], g.l) : 0;
}

/* Per-pixel transmission factors of the wire, one array per spectrum bin (null where the wire
   misses): pts the wire in world cm, dmu the steel-minus-blood mu per bin, the detector frame
   as the worker's. A pixel is 3x3 rays across its face; each pays exp(-dmu x its total chord). */
export function wireFactors(pts, r, dmu, src, detC, detU, detV, half, n) {
  if (!pts || pts.length < 2) return null;
  const pix = 2 * half / n;
  const dn = nrm(sub(detC, src));
  const D = dot(sub(detC, src), dn);
  // project to (u, v) on the detector, in pixels
  const uv = pts.map((p) => {
    const q = sub(p, src), s = D / dot(q, dn), h = sub(add(src, q, s), detC);
    return [(dot(h, detU) + half) / pix - 0.5, (dot(h, detV) + half) / pix - 0.5];
  });
  const touched = new Map();                                 // pixel -> chord per sub-ray
  const L = new Float64Array(9);
  for (let s = 0; s < pts.length - 1; s++) {
    const a = uv[s], b = uv[s + 1];
    // the wire projects to under a pixel across: one pixel of margin round the segment
    const i0 = Math.max(0, Math.floor(Math.min(a[0], b[0])) - 1), i1 = Math.min(n - 1, Math.ceil(Math.max(a[0], b[0])) + 1);
    const j0 = Math.max(0, Math.floor(Math.min(a[1], b[1])) - 1), j1 = Math.min(n - 1, Math.ceil(Math.max(a[1], b[1])) + 1);
    if (i0 > i1 || j0 > j1) continue;
    const G = segOf(src, pts[s], pts[s + 1], r);
    if (!G) continue;
    const [wpx, wpy, wpz] = G.wp, [ex, ey, ez] = G.e;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      let any = false;
      for (let q = 0; q < 9; q++) {
        const u = (i + 0.5 + ((q % 3) - 1) / 3) * pix - half, v = (j + 0.5 + (((q / 3) | 0) - 1) / 3) * pix - half;
        let dx = detC[0] + u * detU[0] + v * detV[0] - src[0];
        let dy = detC[1] + u * detU[1] + v * detV[1] - src[1];
        let dz = detC[2] + u * detU[2] + v * detV[2] - src[2];
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz); dx /= dl; dy /= dl; dz /= dl;
        L[q] = chordW(G.we, wpx, wpy, wpz, G.C, dx, dy, dz, ex, ey, ez, G.l);
        if (L[q] > 0) any = true;
      }
      if (!any) continue;
      const k = j * n + i;
      let c = touched.get(k);
      if (!c) { c = new Float64Array(9); touched.set(k, c); }
      for (let q = 0; q < 9; q++) c[q] += L[q];
    }
  }
  if (!touched.size) return null;
  const g = [new Float32Array(n * n).fill(1), new Float32Array(n * n).fill(1), new Float32Array(n * n).fill(1)];
  for (const [k, c] of touched) for (let b = 0; b < 3; b++) {
    let s = 0;
    for (let q = 0; q < 9; q++) s += Math.exp(-dmu[b] * c[q]);
    g[b][k] = s / 9;
  }
  return g;
}
