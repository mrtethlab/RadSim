/* ============================================================================
   JOINT POSING — bending a rigid CT at its joints.

   The patient models are CT volumes taken in one position. To deviate a wrist, flex an elbow or
   bend a knee, everything distal to the joint is turned about the joint's centre of rotation.
   Turned rigidly it would tear the skin at the crease, so the turn is BLENDED across a short
   zone straddling the joint: a point's share of the rotation rises smoothly from 0 a little
   proximal of the joint to 1 a little distal of it. Bone either side of the zone stays rigid;
   the soft tissue in it bends — what a real crease does, near enough to teach with.

   A joint (rest frame — the post-flip frame the landmarks use, cm):
     c:      centre of rotation (e.g. the head of the capitate for the wrist)
     distal: unit vector along the limb, pointing distally (the side that moves)
     blend:  half-width of the crease, cm
     radius: (optional) only tissue within this distance of the limb's axis (the line through c
             along distal) moves — a CT of an arm against the flank carries flank in its crop,
             and flexing the elbow must not swing the flank with the forearm
     motions: [{ key, axis, rest }] — a positive angle turns the distal part toward the motion's
             positive direction (ulnar deviation, flexion, ...). Angles are ANATOMICAL: `rest` is
             the angle the model already has (the hand CT lies in 26 degrees of ulnar deviation
             against its forearm), the model is turned by (angle - rest), and an angle left unset
             means the model as scanned.
   A joint's motions compose (in the order listed) into ONE rotation, axis n and angle T; a
   point at share w turns by w*T about n. One axis per joint is what makes the inverse cheap:
   a rest point's distance past the joint, as a function of the turn, is
       s(phi) = A cos(phi) + B sin(phi) + C (1 - cos(phi))
   so the crease is solved with a scalar bisection.

   The same map moves the volume (resampled through the inverse), the mesh, the centring
   points, the required anatomy and the palpation marks, so all of them agree. A chain (elbow
   then wrist) applies the most distal joint first, in the rest frame, then each joint above it:
   turning the elbow carries an already-deviated hand along with it.
   ============================================================================ */

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// the share of a joint's rotation a point gets, by its distance s past the joint along the limb
export function blendWeight(s, blend) {
  if (s <= -blend) return 0;
  if (s >= blend) return 1;
  const t = (s + blend) / (2 * blend);
  return t * t * (3 - 2 * t);                       // smoothstep
}

// rotate v about a unit axis by an angle (radians): Rodrigues
export function rotate(v, axis, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), d = dot(axis, v);
  const k = cross(axis, v);
  return [v[0] * c + k[0] * s + axis[0] * d * (1 - c),
          v[1] * c + k[1] * s + axis[1] * d * (1 - c),
          v[2] * c + k[2] * s + axis[2] * d * (1 - c)];
}

/* The axis that turns `from` toward `toward` for a positive angle: for a rotation about a, a
   vector v moves toward a x v, and (d x t) x d = t for perpendicular unit d, t. */
export function axisToward(from, toward) {
  return unit(cross(from, toward));
}

function mul3(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) r[i * 3 + k] = a[i * 3] * b[k] + a[i * 3 + 1] * b[3 + k] + a[i * 3 + 2] * b[6 + k];
  return r;
}
/* A joint at given angles, as one rotation: { c, d (distal), b (blend), n (axis), T (radians) },
   and a roll: { tw (radians), sp }, or null when it is straight. The bending motions compose in
   order (the first, then the next about its fixed axis); the composite's axis-angle is read off its
   matrix.

   A ROLL (a motion with roll: true) turns the distal part about its own long axis — the line
   through c along `distal` — before the bend: pronation of the forearm, rotation of the leg at
   the knee, of the foot at the ankle. It does not change how far a point lies along the limb, so
   its inverse is exact and the bend's crease solve is untouched. Its share rises like the bend's
   across the crease, or, with `spread` (cm past the joint), linearly from the crease's far edge
   to there: a forearm pronates along its length, the radius turning round the ulna, not at the
   elbow, whose bones keep still.

   A FIELD JOINT (j.field: { data: Uint8Array 0-255, dims, sp (cm), origin (cm) }, a weight per
   rest-frame cell) is not cut by a plane at all: each point turns about c by its own share of the
   joint's one rotation, read from the field. The neck is one: the skull and mandible take all of
   it, each cervical vertebra less, C7 and the shoulders none, the soft tissue between them a smooth
   blend — no plane through the neck can tell the jaw (in front of C1-C3) from the spine. Its rolls
   are plain rotations (no exactness to keep: the inverse is solved, fieldInverse). */
export function compileJoint(j, angles) {
  let R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let any = false, tw = 0;
  const field = j.field || null;
  for (const m of j.motions) {
    const a = (motionAngle(angles, m) - (m.rest || 0)) * Math.PI / 180;
    if (!a) continue;
    if (m.roll && !field) { tw += dot(m.axis, j.distal) < 0 ? -a : a; continue; }
    any = true;
    const [x, y, z] = m.axis, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    R = mul3([t * x * x + c, t * x * y - s * z, t * x * z + s * y,
              t * x * y + s * z, t * y * y + c, t * y * z - s * x,
              t * x * z - s * y, t * y * z + s * x, t * z * z + c], R);
  }
  let T = any ? Math.acos(Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2))) : 0;
  if (T < 1e-9) T = 0;
  if (!T && Math.abs(tw) < 1e-9) return null;
  let n = [1, 0, 0];
  if (T) {
    n = [R[7] - R[5], R[2] - R[6], R[3] - R[1]];
    const ln = Math.hypot(n[0], n[1], n[2]);
    n = ln < 1e-9
      ? unit([Math.sqrt(Math.max(0, (R[0] + 1) / 2)), Math.sqrt(Math.max(0, (R[4] + 1) / 2)), Math.sqrt(Math.max(0, (R[8] + 1) / 2))])
      : [n[0] / ln, n[1] / ln, n[2] / ln];
  }
  if (field) {
    if (!T) return null;
    return { c: j.c, d: j.distal, b: j.blend, n, T, tw: 0, sp: 0, R2: Infinity, wf: field,
      ins: [0, 0, 0], bis: [0, 0, 1], bisL: 1 };                  // (no crook: the field decides)
  }
  const f = rotate(j.distal, n, T);
  return { c: j.c, d: j.distal, b: j.blend, n, T, tw, sp: j.spread || 0, R2: j.radius ? j.radius * j.radius : Infinity,
    ins: [f[0] - j.distal[0], f[1] - j.distal[1], f[2] - j.distal[2]],
    bis: [-f[0] - j.distal[0], -f[1] - j.distal[1], -f[2] - j.distal[2]],
    bisL: Math.hypot(f[0] + j.distal[0], f[1] + j.distal[1], f[2] + j.distal[2]) };
}
/* THE CROOK. On the inside of a bend the turned part swings into the space the part above it
   still holds: a flexed forearm's flexor mass rises beside the biceps, the two cut faces are
   planes, and the film showed a straight-edged block of doubled muscle in the elbow's bend.
   Real tissue there folds. So inside the bend (ins: the way the two pieces close on each
   other) the crook is split on the bisector of the bend (bis: its normal, toward the part
   above): the proximal side is filled only by tissue turned by up to half the bend, the
   distal side only by tissue turned by at least half. Outside the bend the pieces part, and
   nothing is decided. dq: the point less the joint's centre; phi: the candidate's turn. */
function inCrook(J, dq, phi) {
  if (dot(dq, J.ins) <= 0) return true;
  return dot(dq, J.bis) >= 0 ? phi <= J.T / 2 : phi >= J.T / 2;
}

// the share of a joint's roll a point gets, by its distance s past the joint
function twistWeight(s, J) {
  // spread: from the far edge of the crease, so the joint itself (the humerus's condyles, the
  // olecranon) does not turn; the forearm then turns evenly to `spread`
  if (J.sp > J.b) return Math.max(0, Math.min(1, (s - J.b) / (J.sp - J.b)));
  return blendWeight(s, J.b);
}
// a point relative to the joint's centre, rolled (sign +1) or unrolled (-1) about the limb's axis
function roll(r, J, sign) {
  if (!J.tw) return r;
  const w = twistWeight(dot(r, J.d), J);
  return w ? rotate(r, J.d, sign * w * J.tw) : r;
}
export function compileChain(chain, angles) {
  return chain.map((j) => compileJoint(j, angles)).filter(Boolean);
}

// within the limb's cylinder (rest frame)
function inLimb(d, J, s) { return J.R2 === Infinity || dot(d, d) - s * s < J.R2; }
// a field joint's share at a rest-frame point: trilinear in the field, 0 outside it
export function fieldWeight(F, p) {
  const gx = (p[0] - F.origin[0]) / F.sp, gy = (p[1] - F.origin[1]) / F.sp, gz = (p[2] - F.origin[2]) / F.sp;
  const [nx, ny, nz] = F.dims;
  if (!(gx >= 0 && gy >= 0 && gz >= 0 && gx <= nx - 1 && gy <= ny - 1 && gz <= nz - 1)) return 0;
  const i = Math.min(nx - 2, Math.floor(gx)), j = Math.min(ny - 2, Math.floor(gy)), k = Math.min(nz - 2, Math.floor(gz));
  const fx = gx - i, fy = gy - j, fz = gz - k, D = F.data, row = nx, sl = nx * ny;
  const o = (k * ny + j) * nx + i;
  const c00 = D[o] * (1 - fx) + D[o + 1] * fx, c10 = D[o + row] * (1 - fx) + D[o + row + 1] * fx;
  const c01 = D[o + sl] * (1 - fx) + D[o + sl + 1] * fx, c11 = D[o + sl + row] * (1 - fx) + D[o + sl + row + 1] * fx;
  return ((c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz) / 255;
}
/* Which rest points a field joint carries to q. A rest point p goes to q when p = c + R(-w T)(q - c)
   with w = W(p): along that one arc of candidates, parametrised by w, it is a root of
   g(w) = W(p(w)) - w, and as g(0) >= 0 and g(1) <= 0 there is always one. (Iterating p = c +
   R(-W(p) T)(q - c) instead diverged in front of the face: 20 cm from c, a weight that falls over
   3 cm and half a radian of turn make the step longer than the error.) Several roots are a fold:
   tissue pressed together, as behind the neck in extension; all are returned. Rigid places (the
   head, the shoulders: g flat at 1 or 0) cost the two ends. */
const FIELD_SCAN = 8;
function fieldInverse(q, J) {
  const dq = [q[0] - J.c[0], q[1] - J.c[1], q[2] - J.c[2]];
  const at = (w) => { const r = rotate(dq, J.n, -w * J.T); return [J.c[0] + r[0], J.c[1] + r[1], J.c[2] + r[2]]; };
  const W = (w) => fieldWeight(J.wf, at(w));
  const g0 = W(0), g1 = W(1) - 1;
  const out = g0 === 0 ? [q] : [];                             // unmoved, where nothing turns
  if (g1 === 0) { out.push(at(1)); return out; }               // a point of the head, turned whole
  let wa = 0, ga = g0;
  for (let i = 1; i <= FIELD_SCAN; i++) {
    const wb = i / FIELD_SCAN, gb = i === FIELD_SCAN ? g1 : W(wb) - wb;
    if (ga > 0 && gb <= 0) {
      let lo = wa, hi = wb;
      for (let k = 0; k < 8; k++) { const m = (lo + hi) / 2; if (W(m) - m > 0) lo = m; else hi = m; }
      out.push(at((lo + hi) / 2));
    }
    wa = wb; ga = gb;
  }
  return out;
}
function forwardOne(p, J) {
  if (J.wf) {
    const w = fieldWeight(J.wf, p);
    if (!w) return p;
    const r = rotate([p[0] - J.c[0], p[1] - J.c[1], p[2] - J.c[2]], J.n, w * J.T);
    return [J.c[0] + r[0], J.c[1] + r[1], J.c[2] + r[2]];
  }
  let d = [p[0] - J.c[0], p[1] - J.c[1], p[2] - J.c[2]];
  const s = dot(d, J.d);
  if (!inLimb(d, J, s)) return p;
  const rolled = roll(d, J, 1);
  const w = J.T ? blendWeight(s, J.b) : 0;
  // untouched by both turns: the very point, not (p - c) + c, whose last bit differs and made
  // poseVolume count the whole proximal limb as moved (every voxel took the slow path)
  if (!w && rolled === d) return p;
  const r = w ? rotate(rolled, J.n, w * J.T) : rolled;
  return [J.c[0] + r[0], J.c[1] + r[1], J.c[2] + r[2]];
}
// a compiled chain, most proximal first: the most distal joint applies first
export function forwardCompiled(p, cc) {
  let q = p;
  for (let i = cc.length - 1; i >= 0; i--) q = forwardOne(q, cc[i]);
  return q;
}
/* THE SKIN in the room. Turned by its share of the bend, a point in the crease sweeps an arc at its
   own distance from the joint: on the outside of a bend that rounded the front of a plantarflexed
   ankle into a dome 2 cm proud of the shin, and on the inside the heel swung up through the back
   of the calf. Real skin goes taut over the outside of a bend and folds on the inside. So, for
   the mesh:
   - outside the bend, beyond SKIN_CORE cm from the joint's axis (the bone near the joint keeps its
     arc), a crease point's distance from the axis shrinks as a linear blend of the unmoved and
     the fully turned point would have it, |(1 - w) + w e^iT|, and a little more (to the power
     1.5): a chord, not the arc, where the ankle's front then runs on from the shin to the dorsum;
   - inside the bend, neither piece crosses the bisector (the volume's crook rule): a point of the
     part above that lies past it, or of the part below short of it, is laid onto it, a fold.
   The volume the film is traced through is posed by the map above; this only shapes the outline
   the room shows. */
const SKIN_CORE = 1;
function skinOne(p, J) {
  if (J.wf) return forwardOne(p, J);                 // (a field bends smoothly already)
  let d = [p[0] - J.c[0], p[1] - J.c[1], p[2] - J.c[2]];
  const s = dot(d, J.d);
  if (!inLimb(d, J, s)) return p;
  const outside = dot(d, J.ins) < 0;
  d = roll(d, J, 1);
  const w = J.T ? blendWeight(s, J.b) : 0;
  let r = w ? rotate(d, J.n, w * J.T) : d;
  if (w > 0 && w < 1 && outside) {
    const ax = dot(r, J.n), rp = [r[0] - ax * J.n[0], r[1] - ax * J.n[1], r[2] - ax * J.n[2]];
    const len = Math.hypot(rp[0], rp[1], rp[2]);
    if (len > SKIN_CORE) {
      const rho = Math.pow(Math.max(0, 1 - 2 * w * (1 - w) * (1 - Math.cos(J.T))), 0.75);
      const k = (SKIN_CORE + (len - SKIN_CORE) * rho) / len;
      r = [ax * J.n[0] + rp[0] * k, ax * J.n[1] + rp[1] * k, ax * J.n[2] + rp[2] * k];
    }
  }
  if (J.T && dot(r, J.ins) > 0) {
    const h = (r[0] * J.bis[0] + r[1] * J.bis[1] + r[2] * J.bis[2]) / J.bisL;   // + toward the part above
    if ((w < 0.5 && h < 0) || (w >= 0.5 && h > 0)) {
      r = [r[0] - h * J.bis[0] / J.bisL, r[1] - h * J.bis[1] / J.bisL, r[2] - h * J.bis[2] / J.bisL];
    }
  }
  return [J.c[0] + r[0], J.c[1] + r[1], J.c[2] + r[2]];
}
export function forwardSkin(p, cc) {
  let q = p;
  for (let i = cc.length - 1; i >= 0; i--) q = skinOne(q, cc[i]);
  return q;
}
export function forwardChain(p, chain, angles) {
  return forwardCompiled(p, compileChain(chain, angles));
}

/* Which rest points land on q, for one compiled joint. Bending can fold two pieces of the patient
   onto one place (a flexed forearm swings in front of the upper arm), so every consistent answer
   is returned, the moved part first: fully turned, then in the crease, then unmoved. The volume
   resampler takes the first that lands on tissue. */
// reach2: how far from the joint (squared) its crease reaches, when known (poseVolume): a point
// farther than that has no pre-image in the crease, and is spared the solve
function preimagesOne(q, J, reach2 = Infinity) {
  if (J.wf) return fieldInverse(q, J);
  const dq = [q[0] - J.c[0], q[1] - J.c[1], q[2] - J.c[2]];
  // the roll is undone last: it keeps a point's distance along the limb, which the bend's solve uses
  const unroll = (p) => { const r = roll([p[0] - J.c[0], p[1] - J.c[1], p[2] - J.c[2]], J, -1); return [J.c[0] + r[0], J.c[1] + r[1], J.c[2] + r[2]]; };
  if (!J.T) return [unroll(q)];
  const out = [];
  // s(phi): how far past the joint q lies once turned BACK by phi
  const A = dot(J.d, dq), B = -dot(J.d, cross(J.n, dq)), C = dot(J.d, J.n) * dot(J.n, dq);
  const s = (phi) => A * Math.cos(phi) + B * Math.sin(phi) + C * (1 - Math.cos(phi));
  const back = (phi) => { const r = rotate(dq, J.n, -phi); return [J.c[0] + r[0], J.c[1] + r[1], J.c[2] + r[2]]; };
  const limb = (p) => { const d = [p[0] - J.c[0], p[1] - J.c[1], p[2] - J.c[2]]; return inLimb(d, J, dot(d, J.d)); };
  if (s(J.T) >= J.b && inCrook(J, dq, J.T)) { const p = back(J.T); if (limb(p)) out.push(p); }
  // the crease: phi = T w(s(phi)), by bisection on g(phi) = T w(s(phi)) - phi
  const g = (phi) => J.T * blendWeight(s(phi), J.b) - phi;
  if (dot(dq, dq) < reach2 && g(0) > 0 && g(J.T) < 0) {
    let a = 0, b = J.T;
    for (let i = 0; i < 24; i++) { const m = (a + b) / 2; if (g(m) > 0) a = m; else b = m; }
    const phi = (a + b) / 2, w = blendWeight(s(phi), J.b);
    if (w > 0 && w < 1) { const p = back(phi); if (limb(p)) out.push(p); }
  }
  if ((A <= -J.b || !inLimb(dq, J, A)) && inCrook(J, dq, 0)) out.push(q);
  return J.tw ? out.map(unroll) : out;
}
export function preimagesCompiled(q, cc) {
  let cands = [q];
  for (let i = 0; i < cc.length; i++) cands = cands.flatMap((p) => preimagesOne(p, cc[i]));
  return cands;
}
export function preimagesChain(q, chain, angles) {
  return preimagesCompiled(q, compileChain(chain, angles));
}

// an angle as set, or the model's own when unset
export function motionAngle(angles, m) { return angles[m.key] ?? m.rest ?? 0; }
export function anyBent(chain, angles) {
  return chain.some((j) => j.motions.some((m) => Math.abs(motionAngle(angles, m) - (m.rest || 0)) > 0.01));
}

/* THE FOLD. Where the two sides of a crook meet on its bisector the outline is pieced together
   from three sources (the part above, the crease band, the part below), and the joins are sharp:
   the crease band, the elbow's own section, lay along the bisector a few millimetres proud of the
   arm and forearm either side, and the skins left cracks of air between them. Seen edge on both
   printed as a thin bright line across the bend. Skin over a fold is smooth: within FOLD_R of the
   joint, on the inside of the bend and within FOLD of the bisector, the outline is smoothed by a
   majority of its neighbourhood, 2 FOLD_W + 1 voxels a side. A voxel it adds is fat; one it takes away is air. */
const FOLD = 2, FOLD_R = 9, FOLD_W = 4, FAT = 2;
function smoothFold(out, N, sg, sp, cc) {
  const C = [(N[0] - 1) / 2, (N[1] - 1) / 2, (N[2] - 1) / 2];
  for (const J of cc) {
    if (J.wf) continue;                               // (a field joint has no crook to fold)
    const m = [J.bis[0] / J.bisL, J.bis[1] / J.bisL, J.bis[2] / J.bisL];
    // the subvolume around the joint
    const lo = [0, 1, 2].map((a) => Math.max(0, Math.floor(C[a] + (sg[a] * J.c[a] - FOLD_R) / sp[a]) - 2));
    const hi = [0, 1, 2].map((a) => Math.min(N[a] - 1, Math.ceil(C[a] + (sg[a] * J.c[a] + FOLD_R) / sp[a]) + 2));
    const n = [0, 1, 2].map((a) => hi[a] - lo[a] + 1);
    if (n.some((v) => v < 2 * FOLD_W + 1)) continue;
    // tissue, then its box sums along x, y and z in turn
    let a = new Uint16Array(n[0] * n[1] * n[2]);
    for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++)
      a[(k * n[1] + j) * n[0] + i] = out[((k + lo[2]) * N[1] + j + lo[1]) * N[0] + i + lo[0]] ? 1 : 0;
    // (a running sum along each line: the window's new end in, its old start out)
    const strides = [1, n[0], n[0] * n[1]];
    for (let ax = 0; ax < 3; ax++) {
      const b = new Uint16Array(a.length), st = strides[ax], len = n[ax];
      const [u, v] = [0, 1, 2].filter((e) => e !== ax);
      for (let pv = 0; pv < n[v]; pv++) for (let pu = 0; pu < n[u]; pu++) {
        const base = pu * strides[u] + pv * strides[v];
        let sum = 0;
        for (let p = 0; p < Math.min(FOLD_W, len); p++) sum += a[base + p * st];
        for (let p = 0; p < len; p++) {
          if (p + FOLD_W < len) sum += a[base + (p + FOLD_W) * st];
          b[base + p * st] = sum;
          if (p - FOLD_W >= 0) sum -= a[base + (p - FOLD_W) * st];
        }
      }
      a = b;
    }
    for (let k = 0; k < n[2]; k++) {
      const z = sg[2] * (k + lo[2] - C[2]) * sp[2] - J.c[2];
      for (let j = 0; j < n[1]; j++) {
        const y = sg[1] * (j + lo[1] - C[1]) * sp[1] - J.c[1];
        for (let i = 0; i < n[0]; i++) {
          const x = sg[0] * (i + lo[0] - C[0]) * sp[0] - J.c[0];
          if (x * x + y * y + z * z > FOLD_R * FOLD_R || x * J.ins[0] + y * J.ins[1] + z * J.ins[2] <= 0) continue;
          if (Math.abs(x * m[0] + y * m[1] + z * m[2]) > FOLD) continue;
          const o = ((k + lo[2]) * N[1] + j + lo[1]) * N[0] + i + lo[0];
          const keep = 2 * a[(k * n[1] + j) * n[0] + i] > (2 * FOLD_W + 1) ** 3;
          if (keep && !out[o]) out[o] = FAT;
          else if (!keep && out[o]) out[o] = 0;
        }
      }
    }
  }
}

/* ---------------------------------------------------------------- the volume
   Resample a label volume into the posed patient. Nearest neighbour: these are material labels,
   and a blend of bone and fat is neither. The output is padded symmetrically wherever the bent
   limb now reaches beyond the original crop (a flexed forearm swings out of an arm's narrow
   box), so its centre — and the patient's placement — is unchanged.

   vm: { dims, spacingMM, data }; flips: the frame flips (rest frame = flipped volume frame).
   Returns { data, dims, pad }. Speed: the output grid is the input grid shifted by the pad, so an
   unmoved row is a copy with its vacated stretches zeroed; outside the box the bent part went
   into, a voxel is either unmoved or vacated; inside it, only cells where moved tissue landed are
   searched, the fully turned and unmoved candidates first, and only voxels within a crease's
   measured reach pay for its solve. (Measured on the 1 mm leg: a knee at 25 degrees 2.3 s -> 1.0 s,
   the knee and ankle together 41 s -> 3.7 s, voxel for voxel the same volume.)

   In parts, for several workers (core/poseWorker.js): posePlan makes the plan (the one pass over
   the input, the box, its occupancy, the padded grid), plan.rows(k0, k1, out) fills output slices
   k0..k1-1 into out, and plan.fold(out) smooths the crooks of the whole volume. The slices are
   independent, so any split of them gives the same volume as poseVolume. */
export function poseVolume(vm, flips, chain, angles) {
  const plan = posePlan(vm, flips, chain, angles);
  if (!plan) return { data: vm.data, dims: vm.dims.slice(), pad: [0, 0, 0] };
  const [N0, N1, N2] = plan.dims;
  const out = new Uint8Array(N0 * N1 * N2);
  plan.rows(0, N2, out);
  plan.fold(out);
  return { data: out, dims: plan.dims, pad: plan.pad };
}
// the output slices of chunk c of m: [k0, k1)
export function poseChunk(n2, c, m) { return [Math.floor((c * n2) / m), Math.floor(((c + 1) * n2) / m)]; }
export function posePlan(vm, flips, chain, angles) {
  const [nx, ny, nz] = vm.dims, data = vm.data;
  const sp = vm.spacingMM.map((v) => v / 10);
  const sg = flips.map((f) => (f ? -1 : 1));
  const cc = compileChain(chain, angles);
  if (!cc.length) return null;
  const cx = (nx - 1) / 2, cy = (ny - 1) / 2, cz = (nz - 1) / 2;
  // one pass over a coarse sample: where the bent parts go, how far the patient reaches, and how
  // far from each joint its crease tissue lies
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const blo = [Infinity, Infinity, Infinity], bhi = [-Infinity, -Infinity, -Infinity];
  // vacated: distal of a bent joint at rest (the moved part has left), or past the crook's
  // bisector (the part below folds against it there); a field joint vacates whatever it moves
  const vacAt = (x, y, z) => {
    for (let n = 0; n < cc.length; n++) {
      const J = cc[n], ex = x - J.c[0], ey = y - J.c[1], ez = z - J.c[2];
      if (J.wf) { if (fieldWeight(J.wf, [x, y, z]) > 0) return true; continue; }
      const sd = ex * J.d[0] + ey * J.d[1] + ez * J.d[2];
      if (sd > -J.b && (J.R2 === Infinity || ex * ex + ey * ey + ez * ez - sd * sd < J.R2)) return true;
      if (ex * J.ins[0] + ey * J.ins[1] + ez * J.ins[2] > 0 && ex * J.bis[0] + ey * J.bis[1] + ez * J.bis[2] < 0) return true;
    }
    return false;
  };
  const creaseR2 = cc.map(() => 0);
  const st = 2;
  const mq = [];                                                  // where the sampled moved tissue went
  for (let k = 0; k < nz; k += st) for (let j = 0; j < ny; j += st) for (let i = 0; i < nx; i += st) {
    if (!data[(k * ny + j) * nx + i]) continue;
    const p = [sg[0] * (i - cx) * sp[0], sg[1] * (j - cy) * sp[1], sg[2] * (k - cz) * sp[2]];
    for (let n = 0; n < cc.length; n++) {
      const J = cc[n], d = [p[0] - J.c[0], p[1] - J.c[1], p[2] - J.c[2]], sd = dot(d, J.d);
      if (J.wf) continue;
      if (Math.abs(sd) < J.b + 2 * st * sp[2] && inLimb(d, J, sd)) creaseR2[n] = Math.max(creaseR2[n], dot(d, d));
    }
    const q = forwardCompiled(p, cc);
    // (and what is vacated without moving — the start of a roll's crease — is refilled there too)
    const moved = q[0] !== p[0] || q[1] !== p[1] || q[2] !== p[2] || vacAt(p[0], p[1], p[2]);
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], q[a]); hi[a] = Math.max(hi[a], q[a]);
      if (moved) { blo[a] = Math.min(blo[a], q[a] - 3 * sp[a]); bhi[a] = Math.max(bhi[a], q[a] + 3 * sp[a]); }
    }
    if (moved) mq.push(q[0], q[1], q[2]);
  }
  /* THE BOX'S OCCUPANCY. Most of the box a bent limb went into is air (a knee flexed 45 degrees
     sweeps the leg through a box of 35 M voxels, three quarters of it empty), and every voxel of it
     used to search its pre-images to find none. Cells of OCC voxels where sampled moved tissue
     landed, grown by OCC_GROW cells (the samples are 2 voxels apart at rest, and the outside of a
     bend stretches them up to 4 times: 8 voxels apart), say where tissue can be; the rest of the
     box keeps what never moved. */
  const OCC = 3, OCC_GROW = 2, oh = OCC * Math.min(sp[0], sp[1], sp[2]);
  const on = [0, 1, 2].map((a) => (bhi[a] >= blo[a] ? Math.ceil((bhi[a] - blo[a]) / oh) + 1 : 0));
  let occ = new Uint8Array(on[0] * on[1] * on[2]);
  const cell = (v, a) => Math.floor((v - blo[a]) / oh);
  for (let m = 0; m < mq.length; m += 3) occ[(cell(mq[m + 2], 2) * on[1] + cell(mq[m + 1], 1)) * on[0] + cell(mq[m], 0)] = 1;
  for (let a = 0; a < 3 && occ.length; a++) {                       // grown, one axis at a time
    const grown = new Uint8Array(occ.length), stA = [1, on[0], on[0] * on[1]][a];
    for (let k = 0; k < on[2]; k++) for (let j = 0; j < on[1]; j++) for (let i = 0; i < on[0]; i++) {
      const o = (k * on[1] + j) * on[0] + i;
      if (!occ[o]) continue;
      const p0 = [i, j, k][a];
      for (let d = -OCC_GROW; d <= OCC_GROW; d++) if (p0 + d >= 0 && p0 + d < on[a]) grown[o + d * stA] = 1;
    }
    occ = grown;
  }
  const occAt = (x, y, z) => occ[(cell(z, 2) * on[1] + cell(y, 1)) * on[0] + cell(x, 0)];
  mq.length = 0;                                                  // (a worker keeps the plan between chunks)
  const reach2 = creaseR2.map((r) => (Math.sqrt(r) + 1) ** 2);
  const pad = [0, 1, 2].map((a) => {
    const half = ([nx, ny, nz][a] - 1) / 2 * sp[a];
    const need = Math.max(Math.abs(lo[a]), Math.abs(hi[a])) + 2 * sp[a];
    return Math.max(0, Math.ceil((need - half) / sp[a]));
  });
  const N = [nx + 2 * pad[0], ny + 2 * pad[1], nz + 2 * pad[2]];
  const at = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 0 : data[(k * ny + j) * nx + i]);
  const sampleRest = (x, y, z) => at(Math.round(sg[0] * x / sp[0] + cx), Math.round(sg[1] * y / sp[1] + cy), Math.round(sg[2] * z / sp[2] + cz));
  const one = cc.length === 1 && !cc[0].wf ? cc[0] : null;
  // the full inverse turn of the one joint, as a matrix
  let M = null;
  if (one) {
    const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((e) => rotate(e, one.n, -one.T));
    M = [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]];
  }
  const Cx = (N[0] - 1) / 2, Cy = (N[1] - 1) / 2, Cz = (N[2] - 1) / 2;
  // where the turned parts are drawn from (the slow path, inside the box they went into)
  const posedAt = (x, y, z, still) => {
    if (!one) {
      let cands = [[x, y, z]];
      for (let n = 0; n < cc.length; n++) cands = cands.flatMap((p) => preimagesOne(p, cc[n], reach2[n]));
      for (const p of cands) { const v = sampleRest(p[0], p[1], p[2]); if (v) return v; }
      return 0;
    }
    let v = 0;
    const dx = x - one.c[0], dy = y - one.c[1], dz = z - one.c[2];
    const rx = M[0] * dx + M[1] * dy + M[2] * dz, ry = M[3] * dx + M[4] * dy + M[5] * dz, rz = M[6] * dx + M[7] * dy + M[8] * dz;
    const rs = rx * one.d[0] + ry * one.d[1] + rz * one.d[2];
    if (rs >= one.b && (one.R2 === Infinity || rx * rx + ry * ry + rz * rz - rs * rs < one.R2) && inCrook(one, [dx, dy, dz], one.T)) {
      const u = roll([rx, ry, rz], one, -1);
      v = sampleRest(one.c[0] + u[0], one.c[1] + u[1], one.c[2] + u[2]);
    }
    if (!v) v = still;
    if (!v && dx * dx + dy * dy + dz * dz < reach2[0]) {
      for (const p of preimagesOne([x, y, z], one)) { v = sampleRest(p[0], p[1], p[2]); if (v) break; }
    }
    return v;
  };
  /* A ROW AT A TIME. Along a row only x changes, and every test that vacates a voxel of a plain
     joint is linear in x: the row is the input row copied in, with the vacated stretches zeroed,
     found exactly (lin). Only the voxels inside the box the moved parts went into pay per voxel.
     A field joint's vacated set is not linear; its rows go voxel by voxel. (Before, every voxel of
     a 100 M voxel leg paid the joint tests: most of a pose's time.) */
  const rowWise = cc.every((J) => !J.wf && J.R2 === Infinity);
  const ax = sg[0] * sp[0], bx = -sg[0] * Cx * sp[0];            // x = bx + ax i
  const N0 = N[0];
  // the i in [0, N0) where A + B i > 0, as [lo, hi)
  const lin = (A, B) => {
    const f = (i) => A + B * i > 0;
    if (B === 0) return A > 0 ? [0, N0] : [0, 0];
    let t = Math.max(-1, Math.min(N0, Math.floor(-A / B)));
    if (B > 0) { while (t >= 0 && f(t)) t--; while (t + 1 < N0 && !f(t + 1)) t++; return [t + 1, N0]; }
    while (t + 1 < N0 && f(t + 1)) t++; while (t >= 0 && !f(t)) t--; return [0, t + 1];
  };
  // output slices k0..k1-1, into out (their own N0 x N1 x (k1 - k0) block)
  const rows = (k0, k1, out) => {
    for (let k = k0; k < k1; k++) {
      const z = sg[2] * (k - Cz) * sp[2];
      const kin = z >= blo[2] && z <= bhi[2];
      const ks = k - pad[2];
      for (let j = 0; j < N[1]; j++) {
        const y = sg[1] * (j - Cy) * sp[1];
        const jin = kin && y >= blo[1] && y <= bhi[1];
        const row = ((k - k0) * N[1] + j) * N0, js = j - pad[1];
        if (rowWise) {
          if (ks >= 0 && ks < nz && js >= 0 && js < ny) out.set(data.subarray((ks * ny + js) * nx, (ks * ny + js + 1) * nx), row + pad[0]);
          for (const J of cc) {
            const ey = y - J.c[1], ez = z - J.c[2], ex0 = bx - J.c[0];
            const sd = lin(ex0 * J.d[0] + ey * J.d[1] + ez * J.d[2] + J.b, ax * J.d[0]);
            out.fill(0, row + sd[0], row + sd[1]);
            const a = lin(ex0 * J.ins[0] + ey * J.ins[1] + ez * J.ins[2], ax * J.ins[0]);
            const b = lin(-(ex0 * J.bis[0] + ey * J.bis[1] + ez * J.bis[2]), -ax * J.bis[0]);
            const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]);
            if (lo < hi) out.fill(0, row + lo, row + hi);
          }
          if (!jin) continue;
          // the box's columns
          const i0 = (blo[0] - bx) / ax, i1 = (bhi[0] - bx) / ax;
          const ia = Math.max(0, Math.ceil(Math.min(i0, i1))), ib = Math.min(N0 - 1, Math.floor(Math.max(i0, i1)));
          for (let i = ia; i <= ib; i++) { const x = bx + ax * i; if (occAt(x, y, z)) out[row + i] = posedAt(x, y, z, out[row + i]); }
          continue;
        }
        for (let i = 0; i < N0; i++) {
          const x = bx + ax * i;
          const still = vacAt(x, y, z) ? 0 : at(i - pad[0], js, ks);
          out[row + i] = jin && x >= blo[0] && x <= bhi[0] && occAt(x, y, z) ? posedAt(x, y, z, still) : still;
        }
      }
    }
  };
  return { dims: N, pad, rows, fold: (out) => smoothFold(out, N, sg, sp, cc) };
}
