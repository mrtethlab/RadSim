/* The irradiated field of a fluoroscope: the round iris, cut by the shutter pair.

   The shutters are two parallel blades a distance 2s apart (rotatable), closing across the
   iris circle of radius R. What reaches the patient is the circle clipped to that band, and the
   dose-area product has to be measured over THAT — it used to take the whole circle, so closing
   the shutters, the one thing a careful operator does to cut DAP, did not move the meter.

   Band of half-width s through the centre of a circle of radius R:
       A = 2 [ s * sqrt(R^2 - s^2) + R^2 * asin(s / R) ]      (s < R),   pi R^2 otherwise.
   Units follow the inputs. */
export function irisShutterArea(R, s) {
  if (!(R > 0)) return 0;
  if (!(s >= 0)) s = 0;
  if (s >= R) return Math.PI * R * R;
  return 2 * (s * Math.sqrt(R * R - s * s) + R * R * Math.asin(s / R));
}

/* THE FLAT PANEL'S FIELD is square, and so is its iris: four blades closing together, so the
   field is a square of half-side R, and the shutter band cuts THAT. The band is the one the
   worker images, |v cos(rot) - u sin(rot)| <= s on the detector's axes, so on a square its area
   depends on the leaves' angle too (at 45 degrees a narrow band runs along the diagonal, sqrt 2
   longer than across a side). Exact: the square clipped by the band's two half-planes. */
export function squareShutterArea(R, s, rot = 0) {
  if (!(R > 0)) return 0;
  if (!(s >= 0)) s = 0;
  const nx = -Math.sin(rot), ny = Math.cos(rot);
  let P = [[-R, -R], [R, -R], [R, R], [-R, R]];
  for (const sg of [1, -1]) P = clipHalf(P, sg * nx, sg * ny, s);
  let a = 0;
  for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a) / 2;
}
// the part of polygon P where a x + b y <= c (one Sutherland-Hodgman edge)
function clipHalf(P, a, b, c) {
  const out = [];
  for (let i = 0; i < P.length; i++) {
    const p = P[i], q = P[(i + 1) % P.length];
    const dp = a * p[0] + b * p[1] - c, dq = a * q[0] + b * q[1] - c;
    if (dp <= 0) out.push(p);
    if ((dp <= 0) !== (dq <= 0)) { const t = dp / (dp - dq); out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
  }
  return out;
}
// the irradiated area on either receptor: the intensifier's round iris or the flat panel's square
export const fieldArea = (flat, R, s, rot = 0) => (flat ? squareShutterArea(R, s, rot) : irisShutterArea(R, s));

/* Whether the detector point (u, v) — cm from the field's centre on the detector's axes — is
   irradiated: inside the iris (radius cut on the intensifier, a square of half-side cut on the
   flat panel) and between the shutter leaves (half-separation sh; c, s the cosine and sine of
   their angle). The worker draws every frame with this, so the image and the DAP above cannot
   disagree about the field's shape. */
export function inField(u, v, flat, cut, sh, c, s) {
  if (flat ? (u > cut || u < -cut || v > cut || v < -cut) : u * u + v * v > cut * cut) return false;
  return !(sh < 1e8 && Math.abs(v * c - u * s) > sh);
}
