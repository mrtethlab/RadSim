/* ============================================================================
   TRAINER — judging a radiograph the way an instructor does.

   Every criterion is measured, not guessed:
   - POSITION: the patient's rotation against the view's (roll about the long axis, plus tilt
     and rotate, which should be zero).
   - CENTRING: the perpendicular distance from the central ray to the centring point, in the
     patient (cm at the landmark's own depth).
   - ANATOMY: the required anatomy is a cloud of points taken from the model's own tissue, bone
     or lung (trainer/regions.js), carried through the patient's pose and projected through the
     real beam: what fraction lies inside the collimated field, and how far any of it is cut.
   - COLLIMATION: a 1-inch (2.54 cm) border beyond the required anatomy, measured at the image
     receptor. The collimator is symmetric about the central ray, so the field each way must
     reach the furthest anatomy that way plus the border; more than half an inch beyond that
     is an open field.
   The geometry follows app.js tubeFrame(): src (focal spot), fd (central-ray direction),
   wAxis / lAxis (collimator width and length axes), field half-angles as tangents.
   ============================================================================ */

export const BORDER_CM = 2.54;              // the one-inch border
export const BORDER_TOL_CM = 1.27;          // half an inch of slack beyond it before it is "open"
export const ANATOMY_FRAC = 0.995;          // allows the odd stray voxel at a cut edge

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// a point in the volume's post-flip frame (as landmarkLocal returns) into the room
export function locToWorld(p, R, c) {
  return [R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + c[0],
          R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + c[1],
          R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + c[2]];
}

// field coordinates of a world point: [w, l] as tangents off the central ray (null behind)
export function fieldCoord(w, F) {
  const r = [w[0] - F.src[0], w[1] - F.src[1], w[2] - F.src[2]];
  const dv = dot(r, F.fd);
  if (!(dv > 1e-6)) return null;
  return [dot(r, F.wAxis) / dv, dot(r, F.lAxis) / dv];
}

// where a direction from the focal spot meets the receptor plane (y = 0): [x, z]
export function rayToReceptor(dir, src) {
  const t = -src[1] / dir[1];
  return [src[0] + t * dir[0], src[2] + t * dir[2]];
}
// a field coordinate [w, l] (tangents) on the receptor plane
export function fieldToReceptor(fw, fl, F) {
  const d = [F.fd[0] + fw * F.wAxis[0] + fl * F.lAxis[0], F.fd[1] + fw * F.wAxis[1] + fl * F.lAxis[1],
    F.fd[2] + fw * F.wAxis[2] + fl * F.lAxis[2]];
  return rayToReceptor(d, F.src);
}

/* The required anatomy against the field. pts: flat [x,y,z,...] world cm. Returns the fraction
   inside, the anatomy's extent along each field axis (cm at the SID, signed from the central
   ray), and how far it runs past each field edge (0 when it does not). */
export function analyseCoverage(pts, F) {
  const n = pts.length / 3;
  let inside = 0, seen = 0;
  let wMin = Infinity, wMax = -Infinity, lMin = Infinity, lMax = -Infinity;
  for (let k = 0; k < n; k++) {
    const c = fieldCoord([pts[3 * k], pts[3 * k + 1], pts[3 * k + 2]], F);
    if (!c) continue;
    seen++;
    if (Math.abs(c[0]) <= F.tw && Math.abs(c[1]) <= F.tl) inside++;
    if (c[0] < wMin) wMin = c[0]; if (c[0] > wMax) wMax = c[0];
    if (c[1] < lMin) lMin = c[1]; if (c[1] > lMax) lMax = c[1];
  }
  const s = F.sid;
  return {
    n: seen, inFrac: seen ? inside / seen : 0,
    ext: { wMin: wMin * s, wMax: wMax * s, lMin: lMin * s, lMax: lMax * s },
    cut: { wMin: Math.max(0, (-F.tw - wMin) * s), wMax: Math.max(0, (wMax - F.tw) * s),
           lMin: Math.max(0, (-F.tl - lMin) * s), lMax: Math.max(0, (lMax - F.tl) * s) },
    half: { w: F.tw * s, l: F.tl * s },
  };
}

// the central ray against the centring point: perpendicular offset in the patient, cm
export function crOffset(lm, F) {
  const r = [lm[0] - F.src[0], lm[1] - F.src[1], lm[2] - F.src[2]];
  const along = dot(r, F.fd);
  const p = [r[0] - along * F.fd[0], r[1] - along * F.fd[1], r[2] - along * F.fd[2]];
  return { dist: Math.hypot(p[0], p[1], p[2]), dw: dot(p, F.wAxis), dl: dot(p, F.lAxis) };
}

// shortest signed difference between two angles, degrees
export function angleDiff(a, b) {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

/* The field each axis needs: from the central ray to the furthest required anatomy on that axis,
   plus the border. (Symmetric collimators: the further side decides.) */
export function neededHalf(cov) {
  return {
    w: Math.max(Math.abs(cov.ext.wMin), Math.abs(cov.ext.wMax)) + BORDER_CM,
    l: Math.max(Math.abs(cov.ext.lMin), Math.abs(cov.ext.lMax)) + BORDER_CM,
  };
}

/* Words for a direction on the film as hung. +l is the patient's superior (or distal, on the
   hand) end, hung at the TOP. +w is world +x, which hangs on the LEFT when the patient's right
   is at +x (the display mirror). */
export function filmSide(axis, sign, rightAtPlusX) {
  if (axis === 'l') return sign > 0 ? 'top' : 'bottom';
  const left = rightAtPlusX ? sign > 0 : sign < 0;
  return left ? 'left' : 'right';
}

/* All the criteria for one exposure.
   view: { pose: { roll, tol }, cr: { cc, tol }, centre: { name, tol } }
   m:    { rot: {x, y, z}, angCC, angLM, cr (crOffset), cov (analyseCoverage), rightAtPlusX,
           marker (side-marker verdict or null), di (deviation index or null) }
   Returns [{ id, label, level: 'pass'|'warn'|'fail', detail }]. */
export function judge(view, m) {
  const out = [];
  const add = (id, label, level, detail) => out.push({ id, label, level, detail });
  // position
  const tol = view.pose?.tol ?? 5;
  const dRoll = angleDiff(m.rot.z, view.pose?.roll ?? 0);
  const off = [Math.abs(dRoll), Math.abs(angleDiff(m.rot.x, 0)), Math.abs(angleDiff(m.rot.y, 0))];
  // the joints: a view that needs one bent says so (view.joints: { key: [lo, hi] }); every other
  // motion the limb has should be neutral, within 10 degrees
  const jointFaults = [], jointNotes = [];
  const alignKey = view.align ? (view.align.motion || 'wrist.dev') : null;
  for (const mo of m.motions || []) {
    if (mo.key === alignKey) continue;                // judged on the bones, below
    const v = (m.joints || {})[mo.key] ?? mo.rest ?? 0;
    const r = view.joints?.[mo.key] || [-10, 10];
    const say = (a) => (a === 0 ? 'neutral' : `${Math.abs(a)}° ${a < 0 ? mo.neg : mo.pos}`);
    if (v < r[0] || v > r[1]) jointFaults.push(`${mo.joint.toLowerCase()} ${say(v)}, want ${view.joints?.[mo.key] ? `${say(r[0])} to ${say(r[1])}` : 'neutral'}`);
    else if (view.joints?.[mo.key]) jointNotes.push(`${mo.joint.toLowerCase()} ${say(v)}`);
  }
  // the hand on the forearm, measured on the bones (m.align: degrees, + toward the ulna)
  if (view.align && m.align != null) {
    const a = m.align, say = (x) => (Math.abs(x) < 0.5 ? 'in line with the radius' : `${Math.abs(x).toFixed(0)}° ${x > 0 ? 'ulnar' : 'radial'}`);
    if (view.align.range) {
      const [r0, r1] = view.align.range;
      if (a < r0 || a > r1) jointFaults.push(`3rd metacarpal ${say(a)} to the distal radius; want ${r0}-${r1}° ulnar deviation`);
      else jointNotes.push(`wrist ${say(a)}`);
    } else if (Math.abs(a) > view.align.tol) {
      jointFaults.push(`3rd metacarpal ${say(a)} to the distal radius: ${a > 0 ? 'radially' : 'ulnarly'} deviate the wrist to bring it in line`);
    } else jointNotes.push('3rd metacarpal in line with the radius');
  }
  const posOk = off.every((v) => v <= tol) && !jointFaults.length;
  add('position', 'Patient position', posOk ? 'pass' : 'fail',
    posOk ? `Rotation ${m.rot.z.toFixed(0)}° (want ${view.pose?.roll ?? 0}° ± ${tol}°)` + (jointNotes.length ? `; ${jointNotes.join(', ')}.` : '.')
      : [Math.abs(dRoll) > tol ? `rotated ${m.rot.z.toFixed(0)}° about the long axis, want ${view.pose?.roll ?? 0}° (${dRoll > 0 ? '+' : ''}${dRoll.toFixed(0)}°)` : '',
        off[1] > tol ? `tilted ${m.rot.x.toFixed(0)}°` : '', off[2] > tol ? `turned ${m.rot.y.toFixed(0)}°` : '', ...jointFaults]
        .filter(Boolean).join('; ') + '.');
  // central-ray angle
  const ccTol = view.cr?.tol ?? 2, wantCC = view.cr?.cc ?? 0;
  const dCC = m.angCC - wantCC, dLM = m.angLM;
  const angOk = Math.abs(dCC) <= ccTol && Math.abs(dLM) <= ccTol;
  const words = view.cr?.words || ['cephalic', 'caudal'];       // [negative, positive]
  const say = (a) => (Math.abs(a) < 0.5 ? 'perpendicular' : `${Math.abs(a).toFixed(0)}° ${a < 0 ? words[0] : words[1]}`);
  add('angle', 'Central-ray angle', angOk ? 'pass' : 'fail',
    `${say(m.angCC)} (want ${say(wantCC)})`
    + (Math.abs(dLM) > ccTol ? `; ${m.angLM.toFixed(0)}° across the part` : '') + '.');
  // centring
  const cTol = view.centre?.tol ?? 1;
  const cOk = m.cr.dist <= cTol;
  const dir = [];
  // the centring point lies at +dw/+dl from the ray: the ray is off the other way
  if (Math.abs(m.cr.dl) > 0.3) dir.push(`${Math.abs(m.cr.dl).toFixed(1)} cm toward the ${filmSide('l', -Math.sign(m.cr.dl), m.rightAtPlusX)}`);
  if (Math.abs(m.cr.dw) > 0.3) dir.push(`${Math.abs(m.cr.dw).toFixed(1)} cm toward the ${filmSide('w', -Math.sign(m.cr.dw), m.rightAtPlusX)}`);
  add('centring', 'Centring', cOk ? 'pass' : 'fail',
    `Central ray ${m.cr.dist.toFixed(1)} cm from the ${view.centre?.name || 'centring point'} (± ${cTol} cm)`
    + (dir.length ? ': ' + dir.join(' and ') + ' of the film' : '') + '.');
  // required anatomy
  const cov = m.cov;
  const anatOk = cov.inFrac >= ANATOMY_FRAC;
  const cuts = [];
  for (const [k, axis, sign] of [['lMax', 'l', 1], ['lMin', 'l', -1], ['wMax', 'w', 1], ['wMin', 'w', -1]]) {
    if (cov.cut[k] > 0.2) cuts.push(`${cov.cut[k].toFixed(1)} cm cut off at the ${filmSide(axis, sign, m.rightAtPlusX)}`);
  }
  add('anatomy', 'Required anatomy', anatOk ? 'pass' : 'fail',
    anatOk ? 'All of it is on the image.' : `${(100 * (1 - cov.inFrac)).toFixed(0)} % of it is outside the field: ${cuts.join(', ') || 'clipped at the edges'}.`);
  // collimation: the inch border as far as the receptor allows (m.recHalf: its half-size along
  // each field axis) — a broad chest can need more than a 35 cm receptor; then the full width is right
  const need0 = neededHalf(cov);
  const need = m.recHalf ? { w: Math.min(need0.w, m.recHalf.w), l: Math.min(need0.l, m.recHalf.l) } : need0;
  const overW = cov.half.w - need.w, overL = cov.half.l - need.l;
  const open = [];
  if (overW > BORDER_TOL_CM) open.push(`${(2 * overW).toFixed(1)} cm too wide`);
  if (overL > BORDER_TOL_CM) open.push(`${(2 * overL).toFixed(1)} cm too long`);
  const tight = [];
  for (const [k, axis, sign, half] of [['lMax', 'l', 1, 'l'], ['lMin', 'l', -1, 'l'], ['wMax', 'w', 1, 'w'], ['wMin', 'w', -1, 'w']]) {
    const edge = sign > 0 ? cov.ext[k] : -cov.ext[k];
    const margin = cov.half[half] - edge;
    if (need0[half] > need[half]) continue;            // the receptor's edge, not the student's choice
    if (margin >= 0 && margin < 0.6) tight.push(filmSide(axis, sign, m.rightAtPlusX));
  }
  const collLevel = !anatOk ? 'fail' : open.length ? 'fail' : tight.length ? 'warn' : 'pass';
  add('collimation', 'Collimation (1" border)', collLevel,
    `Field ${(2 * cov.half.w).toFixed(1)} × ${(2 * cov.half.l).toFixed(1)} cm; needed about ${(2 * need.w).toFixed(1)} × ${(2 * need.l).toFixed(1)} cm.`
    + (open.length ? ' Open: ' + open.join(', ') + '.' : '')
    + (!anatOk ? ' The field cuts required anatomy.' : '')
    + (tight.length ? ` Less than ¼" of border at the ${tight.join(', ')}.` : ''));
  // side marker
  if (m.marker) add('marker', 'Side marker', m.marker.level === 'ok' ? 'pass' : m.marker.level, m.marker.text);
  // exposure
  if (m.di != null) {
    const a = Math.abs(m.di);
    // technique is the protocol's here, not the student's, so the DI informs rather than fails;
    // what the student does change is the field, and a wider field sends more scatter to the
    // detector and raises the EI on its own
    add('exposure', 'Exposure (DI)', a <= 1 ? 'pass' : 'warn',
      `DI ${m.di >= 0.05 ? '+' : ''}${(Math.abs(m.di) < 0.05 ? 0 : m.di).toFixed(1)} (target 0 ± 1).`
      + (a > 1 ? ' Technique is set by the protocol; a wide field adds scatter and raises the EI.' : ''));
  }
  return out;
}
