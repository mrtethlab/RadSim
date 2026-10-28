/* LIMB ROTATION AT THE HIP — the femur turned about its own head.

   A CT volume freezes the patient in whatever pose they were scanned in, and this one's legs
   are in neutral: the femoral neck points about 20 degrees forward of the table plane (the
   greater trochanter lies 2 cm behind the head's coronal plane). Projected AP, a forward-
   pointing neck is a foreshortened neck — and every hip projection, and the DXA femur, is
   taken with the leg turned INWARD 15-25 degrees precisely to lay the neck flat. Rolling the
   whole patient cannot do that: the pelvis has to stay put while the femur turns under it.

   So the femur is cut out of the volume and turned about a vertical axis through the centre
   of its own head. The head is a ball in a socket: rotated about its centre it lands exactly
   where it was, so the joint stays seated and nothing has to be invented at the acetabulum.

   Cutting the femur out. A 2 mm segmentation fuses the head to the acetabulum, so connected
   components alone cannot separate them. Removing a 3 cm ball around the head centre does:
   what is left splits into pelvis and femur (neck, trochanters, shaft), and the femur is the
   piece that carries the shaft out of the bottom of the volume. Inside the ball, bone within
   the head radius is femur, and the thin shell between that and the cut goes to whichever
   side reaches it first. Any voxel misassigned in that shell is harmless: the shell is a
   sphere about the pivot, so whatever is in it only turns within it.

   The volume ends a third of the way down the femur, so there is no knee to define the
   mechanical axis; the line from the shaft's centre at the volume's foot up through the head's
   centre is used in its place. It is not vertical: this patient lay with the hips a little
   flexed (on a knee cushion, as for a CT), the shaft running forward as it goes down, and
   turned about a vertical axis the lower shaft swung sideways through the thigh. The thigh's
   soft tissue is not turned — it is close to a cylinder about that axis — and the space the
   femur leaves is filled with muscle.

   Measured on the AP projection of the left femur alone (test/limbpose.test.js): the lesser
   trochanter stands 2.4 cm proud of the shaft at 30 degrees external rotation, 1.6 cm in
   neutral, 1.0 cm at 15 internal and 0.8 cm at 25 internal — the textbook sign that the
   rotation is right. */

export const BONE_IDS = [17, 18, 54, 55, 56, 57, 58, 59, 60, 61];   // trabecular, cortical, the graded bone
export const MUSCLE_ID = 7;
const R_HEAD = 2.25;   // cm: bone inside this is femoral head
const R_CUT = 3.0;     // cm: removing this ball separates femur from pelvis
const REACH = 19;      // cm from the midline: the box the femur is looked for in
const ABOVE = 6;       // cm above the head centre: top of that box
const AXIS_FOOT = 3;   // cm: the shaft's centre over the volume's lowest this much sets the axis

/* Find one femur. head = { x, y, z } in cm from the volume centre (voxel centres sit at
   (i - (n - 1) / 2) * vs). Returns a box-local mask plus what posing needs, or null when the
   shaft cannot be found (a subject without this anatomy). */
export function segmentFemur({ dims, vs, data }, head, boneIds = BONE_IDS) {
  const [nx, ny, nz] = dims;
  const isBone = new Uint8Array(256); for (const id of boneIds) isBone[id] = 1;
  const cx = (i) => (i - (nx - 1) / 2) * vs[0], cy = (j) => (j - (ny - 1) / 2) * vs[1], cz = (k) => (k - (nz - 1) / 2) * vs[2];
  const ix = (x) => Math.round(x / vs[0] + (nx - 1) / 2);
  const s = Math.sign(head.x) || 1;      // which side of the midline this hip is on
  // the box: from 1 cm off the midline to REACH, from the bottom of the volume to ABOVE the head
  const i0 = Math.max(0, ix(s > 0 ? 1 : -REACH)), i1 = Math.min(nx - 1, ix(s > 0 ? REACH : -1));
  const k1 = Math.min(nz - 1, Math.round((head.z + ABOVE) / vs[2] + (nz - 1) / 2));
  const bx = i1 - i0 + 1, by = ny, bz = k1 + 1, n = bx * by * bz;
  // per box voxel: 0 nothing, 1 bone outside the cut, 2 head, 3 shell
  const cls = new Uint8Array(n);
  const rh2 = R_HEAD * R_HEAD, rc2 = R_CUT * R_CUT;
  for (let k = 0; k < bz; k++) {
    const dz = cz(k) - head.z;
    for (let j = 0; j < by; j++) {
      const dy = cy(j) - head.y, row = (k * ny + j) * nx;
      for (let i = 0; i < bx; i++) {
        if (!isBone[data[row + i0 + i]]) continue;
        const dx = cx(i0 + i) - head.x, d2 = dx * dx + dy * dy + dz * dz;
        cls[(k * by + j) * bx + i] = d2 <= rh2 ? 2 : d2 <= rc2 ? 3 : 1;
      }
    }
  }
  // the shaft: the bone in the bottom slice nearest the head's column
  let seed = -1, best = Infinity;
  for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) {
    if (cls[j * bx + i] !== 1) continue;
    const dx = cx(i0 + i) - head.x, dy = cy(j) - head.y, d2 = dx * dx + dy * dy;
    if (d2 < best) { best = d2; seed = j * bx + i; }
  }
  if (seed < 0 || best > 8 * 8) return null;
  // label: 1 femur, 2 pelvis. Femur = the outside-the-cut component holding the shaft.
  const lab = new Uint8Array(n), q = new Int32Array(n);
  const sx = 1, sy = bx, sz = bx * by;
  const nb = (p, f) => {
    const i = p % bx, j = ((p / bx) | 0) % by, k = (p / sz) | 0;
    if (i > 0) f(p - sx); if (i < bx - 1) f(p + sx);
    if (j > 0) f(p - sy); if (j < by - 1) f(p + sy);
    if (k > 0) f(p - sz); if (k < bz - 1) f(p + sz);
  };
  let h = 0, t = 0;
  lab[seed] = 1; q[t++] = seed;
  while (h < t) nb(q[h++], (r) => { if (cls[r] === 1 && !lab[r]) { lab[r] = 1; q[t++] = r; } });
  // the shell goes to whichever side reaches it first: a simultaneous wave from both
  h = t = 0;
  for (let p = 0; p < n; p++) {
    if (cls[p] === 2) lab[p] = 1;
    else if (cls[p] === 1 && !lab[p]) lab[p] = 2;
    if (lab[p] && cls[p] !== 0) {
      let edge = false; nb(p, (r) => { if (cls[r] === 3) edge = true; });
      if (edge) q[t++] = p;
    }
  }
  while (h < t) { const p = q[h++], L = lab[p]; nb(p, (r) => { if (cls[r] === 3 && !lab[r]) { lab[r] = L; q[t++] = r; } }); }
  const mask = new Uint8Array(n);
  let count = 0;
  // the axis: from the shaft's centre in the volume's lowest AXIS_FOOT cm up through the head
  const kf = Math.max(1, Math.round(AXIS_FOOT / vs[2]));
  let fx = 0, fy = 0, fz = 0, fn = 0;
  for (let p = 0; p < n; p++) {
    if (lab[p] !== 1) continue;
    mask[p] = 1; count++;
    const k = (p / sz) | 0;
    if (k < kf) { fx += cx(i0 + p % bx); fy += cy(((p / bx) | 0) % by); fz += cz(k); fn++; }
  }
  let axis = [0, 0, 1];
  if (fn) {
    const a = [head.x - fx / fn, head.y - fy / fn, head.z - fz / fn], l = Math.hypot(...a);
    axis = a.map((v) => v / l);
  }
  // how far the femur reaches from it
  let r2max = 0;
  for (let p = 0; p < n; p++) {
    if (!mask[p]) continue;
    const dx = cx(i0 + p % bx) - head.x, dy = cy(((p / bx) | 0) % by) - head.y, dz = cz((p / sz) | 0) - head.z;
    const t = dx * axis[0] + dy * axis[1] + dz * axis[2];
    r2max = Math.max(r2max, dx * dx + dy * dy + dz * dz - t * t);
  }
  return { head, side: s, box: { i0, bx, by, bz }, mask, count, axis, rmax: Math.sqrt(r2max) };
}

/* Turn femurs by `internalDeg` (positive = internal rotation, the hip positioning; negative =
   external, the error) and return a NEW volume; the source is left alone. anteriorY is +1 when
   anterior is +y in the volume, -1 when it is -y: internal rotation turns the anterior surface
   toward the midline, so the sense of the turn depends on both the side and that axis. */
export function poseFemurs({ dims, vs, data }, femurs, internalDeg, anteriorY = 1, fillId = MUSCLE_ID) {
  const out = new Uint8Array(data);
  if (!internalDeg) return out;
  const [nx, ny, nz] = dims;
  for (const f of femurs) {
    if (!f) continue;
    const { head, side, box: { i0, bx, by, bz }, mask } = f;
    const th = (side / anteriorY) * internalDeg * Math.PI / 180;
    // destination -> source is the inverse turn
    const c = Math.cos(-th), s = Math.sin(-th);
    for (let k = 0; k < bz; k++) for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) {
      if (mask[(k * by + j) * bx + i]) out[(k * ny + j) * nx + i0 + i] = fillId;
    }
    // about the femur's own axis through the head (Rodrigues), destination -> source
    const u = f.axis || [0, 0, 1];
    const R = [0, 1, 2].map((r) => [0, 1, 2].map((q) => {
      const K = [[0, -u[2], u[1]], [u[2], 0, -u[0]], [-u[1], u[0], 0]][r][q];
      return (r === q ? c : 0) + s * K + (1 - c) * u[r] * u[q];
    }));
    const X = (i) => (i - (nx - 1) / 2) * vs[0], Y = (j) => (j - (ny - 1) / 2) * vs[1], Z = (k) => (k - (nz - 1) / 2) * vs[2];
    const half = f.rmax / Math.max(0.2, Math.abs(u[2]));            // the femur's reach in a slice
    for (let k = 0; k < bz; k++) {
      const z = Z(k) - head.z, t = z / u[2];
      const ax = head.x + u[0] * t, ay = head.y + u[1] * t;            // the axis in this slice
      const a0 = Math.max(0, Math.floor((ax - half) / vs[0] + (nx - 1) / 2) - 1), a1 = Math.min(nx - 1, Math.ceil((ax + half) / vs[0] + (nx - 1) / 2) + 1);
      const b0 = Math.max(0, Math.floor((ay - half) / vs[1] + (ny - 1) / 2) - 1), b1 = Math.min(ny - 1, Math.ceil((ay + half) / vs[1] + (ny - 1) / 2) + 1);
      for (let j = b0; j <= b1; j++) {
        const y = Y(j) - head.y;
        for (let i = a0; i <= a1; i++) {
          const x = X(i) - head.x;
          const si = Math.round((R[0][0] * x + R[0][1] * y + R[0][2] * z + head.x) / vs[0] + (nx - 1) / 2);
          const sj = Math.round((R[1][0] * x + R[1][1] * y + R[1][2] * z + head.y) / vs[1] + (ny - 1) / 2);
          const sk = Math.round((R[2][0] * x + R[2][1] * y + R[2][2] * z + head.z) / vs[2] + (nz - 1) / 2);
          const li = si - i0;
          if (li < 0 || li >= bx || sj < 0 || sj >= by || sk < 0 || sk >= bz) continue;
          if (!mask[(sk * by + sj) * bx + li]) continue;
          out[(k * ny + j) * nx + i] = data[(sk * ny + sj) * nx + si];
        }
      }
    }
  }
  return out;
}

/* THE OTHER LEG RAISED. A cross-table lateral hip is taken with the leg not being examined flexed
   up and held out of the beam, which runs in under it from the inner thigh. This volume's thighs
   lie straight on the table, so that thigh is taken out below the gluteal fold (RAISE_BELOW under
   its femoral head; the buttock stays), on its side of the midline, in `out` (a posed copy). */
const RAISE_BELOW = 9;   // cm under the head's centre: the fold, at the ischial tuberosity
const RAISE_MID = 1.5;   // cm off the midline the perineum is kept
export function raiseLeg({ dims, vs }, out, heads, side) {
  const [nx, ny, nz] = dims;
  const h = side === 'L' ? heads[0] : heads[1], s = Math.sign(h.x) || 1, mid = (heads[0].x + heads[1].x) / 2;
  const kc = Math.min(nz, Math.round((h.z - RAISE_BELOW) / vs[2] + (nz - 1) / 2));
  for (let i = 0; i < nx; i++) {
    if (s * ((i - (nx - 1) / 2) * vs[0] - mid) <= RAISE_MID) continue;
    for (let k = 0; k < kc; k++) for (let j = 0; j < ny; j++) out[(k * ny + j) * nx + i] = 0;
  }
  return out;
}
