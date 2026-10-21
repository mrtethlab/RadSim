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
     motions: [{ key, axis }] — a positive angle turns the distal part toward the motion's
             positive direction (ulnar deviation, flexion, ...)
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
   or null when it is straight. The motions compose in order (the first, then the next about its
   fixed axis); the composite's axis-angle is read off its matrix. */
export function compileJoint(j, angles) {
  let R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let any = false;
  for (const m of j.motions) {
    const a = (angles[m.key] || 0) * Math.PI / 180;
    if (!a) continue;
    any = true;
    const [x, y, z] = m.axis, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    R = mul3([t * x * x + c, t * x * y - s * z, t * x * z + s * y,
              t * x * y + s * z, t * y * y + c, t * y * z - s * x,
              t * x * z - s * y, t * y * z + s * x, t * z * z + c], R);
  }
  if (!any) return null;
  const T = Math.acos(Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2)));
  if (T < 1e-9) return null;
  let n = [R[7] - R[5], R[2] - R[6], R[3] - R[1]];
  const ln = Math.hypot(n[0], n[1], n[2]);
  n = ln < 1e-9
    ? unit([Math.sqrt(Math.max(0, (R[0] + 1) / 2)), Math.sqrt(Math.max(0, (R[4] + 1) / 2)), Math.sqrt(Math.max(0, (R[8] + 1) / 2))])
    : [n[0] / ln, n[1] / ln, n[2] / ln];
  return { c: j.c, d: j.distal, b: j.blend, n, T, R2: j.radius ? j.radius * j.radius : Infinity };
}
export function compileChain(chain, angles) {
  return chain.map((j) => compileJoint(j, angles)).filter(Boolean);
}

// within the limb's cylinder (rest frame)
function inLimb(d, J, s) { return J.R2 === Infinity || dot(d, d) - s * s < J.R2; }
function forwardOne(p, J) {
  const d = [p[0] - J.c[0], p[1] - J.c[1], p[2] - J.c[2]];
  const s = dot(d, J.d);
  const w = blendWeight(s, J.b);
  if (!w || !inLimb(d, J, s)) return p;
  const r = rotate(d, J.n, w * J.T);
  return [J.c[0] + r[0], J.c[1] + r[1], J.c[2] + r[2]];
}
// a compiled chain, most proximal first: the most distal joint applies first
export function forwardCompiled(p, cc) {
  let q = p;
  for (let i = cc.length - 1; i >= 0; i--) q = forwardOne(q, cc[i]);
  return q;
}
export function forwardChain(p, chain, angles) {
  return forwardCompiled(p, compileChain(chain, angles));
}

/* Which rest points land on q, for one compiled joint. Bending can fold two pieces of the patient
   onto one place (a flexed forearm swings in front of the upper arm), so every consistent answer
   is returned, the moved part first: fully turned, then in the crease, then unmoved. The volume
   resampler takes the first that lands on tissue. */
function preimagesOne(q, J) {
  const out = [];
  const dq = [q[0] - J.c[0], q[1] - J.c[1], q[2] - J.c[2]];
  // s(phi): how far past the joint q lies once turned BACK by phi
  const A = dot(J.d, dq), B = -dot(J.d, cross(J.n, dq)), C = dot(J.d, J.n) * dot(J.n, dq);
  const s = (phi) => A * Math.cos(phi) + B * Math.sin(phi) + C * (1 - Math.cos(phi));
  const back = (phi) => { const r = rotate(dq, J.n, -phi); return [J.c[0] + r[0], J.c[1] + r[1], J.c[2] + r[2]]; };
  const limb = (p) => { const d = [p[0] - J.c[0], p[1] - J.c[1], p[2] - J.c[2]]; return inLimb(d, J, dot(d, J.d)); };
  if (s(J.T) >= J.b) { const p = back(J.T); if (limb(p)) out.push(p); }
  // the crease: phi = T w(s(phi)), by bisection on g(phi) = T w(s(phi)) - phi
  const g = (phi) => J.T * blendWeight(s(phi), J.b) - phi;
  if (g(0) > 0 && g(J.T) < 0) {
    let a = 0, b = J.T;
    for (let i = 0; i < 24; i++) { const m = (a + b) / 2; if (g(m) > 0) a = m; else b = m; }
    const phi = (a + b) / 2, w = blendWeight(s(phi), J.b);
    if (w > 0 && w < 1) { const p = back(phi); if (limb(p)) out.push(p); }
  }
  if (A <= -J.b || !inLimb(dq, J, A)) out.push(q);
  return out;
}
export function preimagesCompiled(q, cc) {
  let cands = [q];
  for (let i = 0; i < cc.length; i++) cands = cands.flatMap((p) => preimagesOne(p, cc[i]));
  return cands;
}
export function preimagesChain(q, chain, angles) {
  return preimagesCompiled(q, compileChain(chain, angles));
}

export function anyBent(chain, angles) {
  return chain.some((j) => j.motions.some((m) => Math.abs(angles[m.key] || 0) > 0.01));
}

/* ---------------------------------------------------------------- the volume
   Resample a label volume into the posed patient. Nearest neighbour: these are material labels,
   and a blend of bone and fat is neither. The output is padded symmetrically wherever the bent
   limb now reaches beyond the original crop (a flexed forearm swings out of an arm's narrow
   box), so its centre — and the patient's placement — is unchanged.

   vm: { dims, spacingMM, data }; flips: the frame flips (rest frame = flipped volume frame).
   Returns { data, dims, pad }. Speed: the output grid is the input grid shifted by the pad, so an
   unmoved voxel is an index copy; outside the box the bent part went into, a voxel is either
   unmoved or vacated; inside it, the fully turned and unmoved candidates are tried first, and only
   voxels within the crease's measured reach of a joint pay for the crease solve. */
export function poseVolume(vm, flips, chain, angles) {
  const [nx, ny, nz] = vm.dims, data = vm.data;
  const sp = vm.spacingMM.map((v) => v / 10);
  const sg = flips.map((f) => (f ? -1 : 1));
  const cc = compileChain(chain, angles);
  if (!cc.length) return { data, dims: [nx, ny, nz], pad: [0, 0, 0] };
  const cx = (nx - 1) / 2, cy = (ny - 1) / 2, cz = (nz - 1) / 2;
  // one pass over a coarse sample: where the bent parts go, how far the patient reaches, and how
  // far from each joint its crease tissue lies
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const blo = [Infinity, Infinity, Infinity], bhi = [-Infinity, -Infinity, -Infinity];
  const creaseR2 = cc.map(() => 0);
  const st = 2;
  for (let k = 0; k < nz; k += st) for (let j = 0; j < ny; j += st) for (let i = 0; i < nx; i += st) {
    if (!data[(k * ny + j) * nx + i]) continue;
    const p = [sg[0] * (i - cx) * sp[0], sg[1] * (j - cy) * sp[1], sg[2] * (k - cz) * sp[2]];
    for (let n = 0; n < cc.length; n++) {
      const J = cc[n], d = [p[0] - J.c[0], p[1] - J.c[1], p[2] - J.c[2]], sd = dot(d, J.d);
      if (Math.abs(sd) < J.b + 2 * st * sp[2] && inLimb(d, J, sd)) creaseR2[n] = Math.max(creaseR2[n], dot(d, d));
    }
    const q = forwardCompiled(p, cc);
    const moved = q[0] !== p[0] || q[1] !== p[1] || q[2] !== p[2];
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], q[a]); hi[a] = Math.max(hi[a], q[a]);
      if (moved) { blo[a] = Math.min(blo[a], q[a] - 3 * sp[a]); bhi[a] = Math.max(bhi[a], q[a] + 3 * sp[a]); }
    }
  }
  const reach2 = creaseR2.map((r) => (Math.sqrt(r) + 1) ** 2);
  const pad = [0, 1, 2].map((a) => {
    const half = ([nx, ny, nz][a] - 1) / 2 * sp[a];
    const need = Math.max(Math.abs(lo[a]), Math.abs(hi[a])) + 2 * sp[a];
    return Math.max(0, Math.ceil((need - half) / sp[a]));
  });
  const N = [nx + 2 * pad[0], ny + 2 * pad[1], nz + 2 * pad[2]];
  const out = new Uint8Array(N[0] * N[1] * N[2]);
  const at = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 0 : data[(k * ny + j) * nx + i]);
  const sampleRest = (x, y, z) => at(Math.round(sg[0] * x / sp[0] + cx), Math.round(sg[1] * y / sp[1] + cy), Math.round(sg[2] * z / sp[2] + cz));
  const one = cc.length === 1 ? cc[0] : null;
  // the full inverse turn of the one joint, as a matrix
  let M = null;
  if (one) {
    const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((e) => rotate(e, one.n, -one.T));
    M = [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]];
  }
  const Cx = (N[0] - 1) / 2, Cy = (N[1] - 1) / 2, Cz = (N[2] - 1) / 2;
  for (let k = 0; k < N[2]; k++) {
    const z = sg[2] * (k - Cz) * sp[2];
    const kin = z >= blo[2] && z <= bhi[2];
    for (let j = 0; j < N[1]; j++) {
      const y = sg[1] * (j - Cy) * sp[1];
      const jin = kin && y >= blo[1] && y <= bhi[1];
      const row = (k * N[1] + j) * N[0];
      for (let i = 0; i < N[0]; i++) {
        const x = sg[0] * (i - Cx) * sp[0];
        // vacated: distal of a bent joint at rest (the moved part has left)
        let vac = false;
        for (let n = 0; n < cc.length; n++) {
          const J = cc[n], ex = x - J.c[0], ey = y - J.c[1], ez = z - J.c[2];
          const sd = ex * J.d[0] + ey * J.d[1] + ez * J.d[2];
          if (sd > -J.b && (J.R2 === Infinity || ex * ex + ey * ey + ez * ez - sd * sd < J.R2)) { vac = true; break; }
        }
        const still = vac ? 0 : at(i - pad[0], j - pad[1], k - pad[2]);
        if (!(jin && x >= blo[0] && x <= bhi[0])) { out[row + i] = still; continue; }
        let v = 0;
        if (one) {
          const dx = x - one.c[0], dy = y - one.c[1], dz = z - one.c[2];
          const rx = M[0] * dx + M[1] * dy + M[2] * dz, ry = M[3] * dx + M[4] * dy + M[5] * dz, rz = M[6] * dx + M[7] * dy + M[8] * dz;
          const rs = rx * one.d[0] + ry * one.d[1] + rz * one.d[2];
          if (rs >= one.b && (one.R2 === Infinity || rx * rx + ry * ry + rz * rz - rs * rs < one.R2)) v = sampleRest(one.c[0] + rx, one.c[1] + ry, one.c[2] + rz);
          if (!v) v = still;
          if (!v && dx * dx + dy * dy + dz * dz < reach2[0]) {
            for (const p of preimagesOne([x, y, z], one)) { v = sampleRest(p[0], p[1], p[2]); if (v) break; }
          }
        } else {
          for (const p of preimagesCompiled([x, y, z], cc)) { v = sampleRest(p[0], p[1], p[2]); if (v) break; }
        }
        out[row + i] = v;
      }
    }
  }
  return { data: out, dims: N, pad };
}
