/* ============================================================================
   LONG-LENGTH IMAGING (PASTING): the geometry and the stitch, as pure functions
   ============================================================================
   The angled-tube technique (a ceiling tube over a tracking bucky, as on a wall stand or a
   table): the focal spot stays where it is and the tube only TILTS, cephalad for the top of
   the study and caudad for the bottom, while the bucky drives along its rails to sit under each
   tilted field. Every image is then a projection from the same point onto the same plane, so the
   images are pieces of one long projection: they join by their places on the receptor, at every
   depth in the patient, with no parallax step at the seams (the step a tube that TRANSLATES
   between images leaves, which is why that technique stitches at one chosen depth only).

   Units: cm and degrees. z runs along the receptor's long axis (+z toward the patient's head),
   in the room. The focal spot is at long position zf, a height H above the receptor plane (the
   perpendicular SID). An angle follows the console's CR sign: negative = cephalad (toward +z),
   positive = caudad.

   COI (centre of interest) is the height of the anatomy of interest above the stand's cover or
   the tabletop, as the operator enters it. The limits do not need it, because a limit set by the
   central ray projects along that ray: wherever along it the anatomy lies, its image lands at the
   same place on the receptor. What it decides is SIZE: the anatomy at the COI plane is magnified
   by H / (H - h) (h its height over the receptor), and the stitched image's ruler and its length
   are calibrated there, as the console calibrates its measurements.
   ============================================================================ */

const RAD = Math.PI / 180;

/* Where the central ray, tilted by `deg`, meets the receptor. */
export function receptorZ(zf, H, deg) {
  return zf - H * Math.tan(deg * RAD);
}

/* The tilt that puts the central ray on receptor position z. */
export function angleTo(zf, H, z) {
  return Math.atan2(zf - z, H) / RAD;
}

/* The focal spot of the console's tube frame (the source swings on a sphere of radius `sid`
   about the central ray's point on the receptor, tubeZ): where it is, and how high. */
export function focalOf(tubeZ, sid, deg) {
  return { zf: tubeZ + sid * Math.sin(deg * RAD), H: sid * Math.cos(deg * RAD) };
}

/* The console's tube frame for a tilt about a FIXED focal spot: the central ray's point on the
   receptor (tubeZ) and the source-to-that-point distance (sid), which the tube frame then turns
   back into the same focal spot. */
export function tiltAbout(zf, H, deg) {
  const t = deg * RAD;
  return { tubeZ: zf - H * Math.tan(t), sid: H / Math.cos(t), angCC: deg };
}

/* Magnification of the plane `h` above the receptor, the focal spot `H` above it. */
export function magnification(H, h) {
  return H / Math.max(1e-6, H - h);
}

/* THE PLAN. Images of `det` cm (the receptor's long side) to cover the receptor from zLower to
   zUpper, each overlapping the next by at least `minOverlap` (the stitch needs a band of shared
   anatomy to match the images on). The first image's top edge is at the upper limit and the last
   one's bottom edge at the lower limit; the rest are spaced evenly between them, so the overlap
   is shared out rather than left in one image. Superior first, as the study runs. */
export function planPasting({ zUpper, zLower, det = 43, minOverlap = 4, maxImages = 5 }) {
  const top = Math.max(zUpper, zLower), bot = Math.min(zUpper, zLower);
  const length = top - bot;
  let n = length <= det ? 1 : Math.ceil((length - minOverlap) / (det - minOverlap));
  const tooLong = n > maxImages;
  if (tooLong) n = maxImages;
  const step = n > 1 ? (length - det) / (n - 1) : 0;
  const centres = [];
  if (n === 1) centres.push((top + bot) / 2);
  else for (let i = 0; i < n; i++) centres.push(top - det / 2 - i * step);
  const overlap = n > 1 ? det - step : 0;
  const spanTop = centres[0] + det / 2, spanBot = centres[n - 1] - det / 2;
  return { n, centres, overlap, length, top, bot, spanTop, spanBot, det, tooLong };
}

/* Each image's tilt about the focal spot: the central ray to the image's centre. */
export function tileAngles(plan, zf, H) {
  return plan.centres.map((c) => angleTo(zf, H, c));
}

/* Length at the COI plane: what the receptor length measures in the patient. */
export function anatomicalLength(receptorLength, H, h) {
  return receptorLength / magnification(H, h);
}

/* THE STITCH. Tiles are detector images (row-major, nx across, ny along z; row j at
   z = cz + (j - (ny-1)/2) * pxV on the receptor, cz the bucky's place for that image). They are
   joined by receptor position into one image from spanBot to spanTop:
     - gain matched: each image is scaled to the one before it over the band they share (the
       generator's exposure for each image can differ: an AEC terminating on each), so the
       processing that follows sees one exposure, not a staircase;
     - blended: across each overlap the two images are feathered linearly, so no seam is left
       where one image's noise and scatter give way to the next one's.
   `planes` names the per-pixel arrays to join (dose, direct); masks are joined as their union.
   The gains are matched on `dose`, or given (`gains`: all 1 joins what the receptor received).
   Returns { arrays, mask, nx, ny, gains }. */
export function stitchTiles(tiles, { nx, ny, pxV, spanBot, spanTop, feather, planes = ['dose', 'direct'], gains: fixed = null }) {
  const NY = Math.max(1, Math.round((spanTop - spanBot) / pxV));
  const half = (ny - 1) / 2, det = ny * pxV;
  const fe = Math.max(pxV, feather ?? 0);
  // where row J of the stitch falls in tile t (fractional row), or null
  const rowIn = (t, J) => {
    const z = spanBot + (J + 0.5) * pxV;
    const f = (z - t.cz) / pxV + half;
    return f < -0.5 || f > ny - 0.5 ? null : Math.max(0, Math.min(ny - 1, f));
  };
  const sample = (arr, f, i) => {
    const j0 = Math.floor(f), j1 = Math.min(ny - 1, j0 + 1), a = f - j0;
    return arr[j0 * nx + i] * (1 - a) + arr[j1 * nx + i] * a;
  };
  const inMask = (m, f, i) => m[Math.round(f) * nx + i] > 0;
  // gain matching over the shared band, tile by tile (superior first, as taken)
  const gains = fixed ? fixed.slice() : tiles.map(() => 1);
  for (let t = 1; t < tiles.length && !fixed; t++) {
    const A = tiles[t - 1], B = tiles[t];
    let sa = 0, sb = 0;
    for (let J = 0; J < NY; J++) {
      const fa = rowIn(A, J), fb = rowIn(B, J);
      if (fa == null || fb == null) continue;
      for (let i = 0; i < nx; i++) {
        if (!inMask(A.mask, fa, i) || !inMask(B.mask, fb, i)) continue;
        sa += sample(A.dose, fa, i); sb += sample(B.dose, fb, i);
      }
    }
    const g = sb > 0 && sa > 0 ? (gains[t - 1] * sa) / sb : gains[t - 1];
    gains[t] = Math.max(0.1, Math.min(10, g));
  }
  const arrays = {};
  for (const p of planes) arrays[p] = new Float32Array(nx * NY);
  const mask = new Uint8Array(nx * NY);
  for (let J = 0; J < NY; J++) {
    const z = spanBot + (J + 0.5) * pxV;
    const rows = [];
    for (let t = 0; t < tiles.length; t++) {
      const f = rowIn(tiles[t], J);
      if (f == null) continue;
      const lo = tiles[t].cz - det / 2, hi = tiles[t].cz + det / 2;
      const w = Math.max(1e-3, Math.min(1, Math.min(z - lo, hi - z) / fe));
      rows.push({ t, f, w });
    }
    if (!rows.length) continue;
    for (let i = 0; i < nx; i++) {
      let W = 0;
      const acc = planes.map(() => 0);
      for (const r of rows) {
        const T = tiles[r.t];
        if (!inMask(T.mask, r.f, i)) continue;
        W += r.w;
        planes.forEach((p, q) => { acc[q] += r.w * gains[r.t] * sample(T[p], r.f, i); });
      }
      if (W <= 0) continue;
      const k = J * nx + i;
      mask[k] = 1;
      planes.forEach((p, q) => { arrays[p][k] = acc[q] / W; });
    }
  }
  return { arrays, mask, nx, ny: NY, gains };
}

/* THE RULER, calibrated at the COI plane: a tick for every centimetre of anatomy there, longer
   at every 5 and numbered at every 10, from 0 at the top of the study. The anatomy at the COI
   plane at long position a projects to zf + (a - zf) * M on the receptor (M its magnification,
   about the focal spot's foot). Returned in rows of the stitched image (row 0 at spanBot). */
export function rulerTicks({ spanBot, spanTop, pxV, zf, M }) {
  const toAnat = (z) => zf + (z - zf) / M;
  const aTop = toAnat(spanTop), aBot = toAnat(spanBot);
  const ticks = [];
  for (let v = 0; v <= aTop - aBot + 1e-9; v++) {
    const z = zf + (aTop - v - zf) * M;
    const row = (z - spanBot) / pxV - 0.5;
    ticks.push({ row, cm: v, kind: v % 10 === 0 ? 'major' : v % 5 === 0 ? 'mid' : 'minor' });
  }
  return ticks;
}

/* The CR angle as the console says it. */
export function fmtCC(deg) {
  const a = Math.round(deg * 10) / 10;
  return a === 0 ? '0°' : `${Math.abs(a)}° ${a < 0 ? 'CEPH' : 'CAUD'}`;
}
