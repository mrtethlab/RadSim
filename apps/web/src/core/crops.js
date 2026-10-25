/* Models cut from another model (services/compute/app/build_crop.py: the foot from the lower
   extremity). A crop is the same voxels as its source, so its joints, landmarks, palpation and
   centring points are the source's, moved into the crop's frame and kept where the crop holds
   them (data/crops.json: the shift, and the source's rest-frame z the box spans). Filled in once,
   at load, into the shared data objects, so every reader (app.js, the Trainer's palpation) sees
   the crop as a subject of its own and a re-measured source carries its crops with it.

   Frames: joints, palpation and centring are rest-frame (crop.rest); landmarks are volume-frame
   (crop.volume) unless marked frame:"world", which a crop cannot shift and leaves out. */

const add = (p, s) => [p[0] + s[0], p[1] + s[1], p[2] + s[2]];
const inside = (z, crop) => z >= crop.z[0] && z <= crop.z[1];

function movePoint(e, s) {
  const [x, y, z] = add([e.x || 0, e.y || 0, e.z || 0], s);
  const r = (v) => Math.round(v * 100) / 100;
  return { ...e, x: r(x), y: r(y), z: r(z) };
}

/* one table of named points (centring, palpation: rest frame; landmarks: volume frame, whose z is
   the rest frame's in every model a crop is made from) */
function cropPoints(src, crop, shift) {
  const out = {};
  for (const [k, e] of Object.entries(src || {})) {
    if (k.startsWith('_') || !e || typeof e.z !== 'number' || e.frame === 'world') continue;
    if (inside(e.z, crop)) out[k] = movePoint(e, shift);
  }
  return out;
}

/* the joints whose centre the crop holds; one with a grid of its own (a rider, a field) is left out:
   its grid is the source's, cut and placed for the source's frame */
function cropJoints(src, crop) {
  const out = {};
  for (const [k, j] of Object.entries(src || {})) {
    if (k.startsWith('_') || !j?.c || j.rider || j.field) continue;
    if (inside(j.c[2], crop)) out[k] = { ...j, c: add(j.c, crop.rest).map((v) => Math.round(v * 1000) / 1000) };
  }
  return out;
}

export function applyCrops(crops, { joints, landmarks, centring, palpation }) {
  for (const [name, crop] of Object.entries(crops || {})) {
    if (name.startsWith('_')) continue;
    const of = crop.of;
    if (joints?.[of]) { const j = cropJoints(joints[of], crop); if (Object.keys(j).length) joints[name] = j; }
    if (landmarks?.[of]) landmarks[name] = cropPoints(landmarks[of], crop, crop.volume);
    if (centring?.[of]) centring[name] = cropPoints(centring[of], crop, crop.rest);
    if (palpation?.[of]) palpation[name] = cropPoints(palpation[of], crop, crop.rest);
  }
}
