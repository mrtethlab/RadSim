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

   The volume ends a few centimetres below the lesser trochanter, so there is no knee to define
   the mechanical axis; a vertical axis through the head is used in its place (the mechanical
   axis runs within a few degrees of vertical). The thigh's soft tissue is not turned — it is
   close to a cylinder about that axis — and the space the femur leaves is filled with muscle.

   Measured on the AP projection of the left femur alone (test/limbpose.test.js): the lesser
   trochanter stands 2.0 cm proud of the shaft at 30 degrees external rotation, 1.2 cm in
   neutral, 1.0 cm at 15 internal and 0.8 cm at 25 internal — the textbook sign that the
   rotation is right. */

export const BONE_IDS = [17, 18];   // trabecular, cortical
export const MUSCLE_ID = 7;
const R_HEAD = 2.25;   // cm: bone inside this is femoral head
const R_CUT = 3.0;     // cm: removing this ball separates femur from pelvis
const REACH = 19;      // cm from the midline: the box the femur is looked for in
const ABOVE = 6;       // cm above the head centre: top of that box

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
  let count = 0, r2max = 0;
  for (let p = 0; p < n; p++) {
    if (lab[p] !== 1) continue;
    mask[p] = 1; count++;
    const i = p % bx, j = ((p / bx) | 0) % by;
    const dx = cx(i0 + i) - head.x, dy = cy(j) - head.y;
    if (dx * dx + dy * dy > r2max) r2max = dx * dx + dy * dy;
  }
  return { head, side: s, box: { i0, bx, by, bz }, mask, count, rmax: Math.sqrt(r2max) };
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
    const hx = head.x / vs[0] + (nx - 1) / 2, hy = head.y / vs[1] + (ny - 1) / 2;   // head column, voxel units
    const rx = Math.ceil(f.rmax / vs[0]) + 1, ry = Math.ceil(f.rmax / vs[1]) + 1;
    const a0 = Math.max(0, Math.floor(hx - rx)), a1 = Math.min(nx - 1, Math.ceil(hx + rx));
    const b0 = Math.max(0, Math.floor(hy - ry)), b1 = Math.min(ny - 1, Math.ceil(hy + ry));
    for (let k = 0; k < bz; k++) {
      for (let j = b0; j <= b1; j++) {
        const y = (j - hy) * vs[1];
        for (let i = a0; i <= a1; i++) {
          const x = (i - hx) * vs[0];
          const si = Math.round((x * c - y * s) / vs[0] + hx), sj = Math.round((x * s + y * c) / vs[1] + hy);
          const li = si - i0;
          if (li < 0 || li >= bx || sj < 0 || sj >= by) continue;
          if (!mask[(k * by + sj) * bx + li]) continue;
          out[(k * ny + j) * nx + i] = data[(k * ny + sj) * nx + si];
        }
      }
    }
  }
  return out;
}
