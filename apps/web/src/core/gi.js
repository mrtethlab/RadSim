/* ============================================================================
   BARIUM FIELD
   The enteric counterpart of contrast.js. Same shape of problem, same solution: turn a
   solver timeline into the two lookups the ray-caster wants.

     giVol  — Uint8Array(nvox): which arclength bin each GI voxel sits at, from the sparse
              <name>.giarc.bin. Non-GI voxels are 0.
     baLUT  — Float32Array(nmat * NS): mg Ba/mL for [material id][arclength bin], rebuilt
              per acquisition time.

   One thing differs from contrast, and it is the interesting one. A vessel carries contrast
   only in its lumen. The gut carries barium in TWO places — suspended in the lumen, and
   coating the mucosa — and in a double-contrast study the coating is the entire point: the
   lumen is full of gas and the diagnostic image is the coated wall seen through it.

   Both end up in one table. The wall's mg/cm2 becomes an equivalent path length through the
   suspension that produced it (mg/cm2 divided by mg/mL is cm), which is the same currency the
   lumen column already uses, so the tracer needs no second channel and no branch.
   ============================================================================ */
import { BodyMaterials } from './materials.js';

export const NS = 256;                 // arclength bins — matches the uint8 giVol range
// The GI ids, matching build_model.py: 47 is bowel gas, 48..52 the lumen segments. Gas is
// part of the tract for transport (barium flows into a gas-filled bowel) so it carries an
// arclength entry too, and the file must be walked with exactly this set.
const FIRST_GI = 47, LAST_GI = 52;
const isGI = (id) => id >= FIRST_GI && id <= LAST_GI;

/* Decode the packed uint16 timeline from services/compute/app/gi_export.py. */
export function decodeGITimeline(json) {
  const cs = json.cMax / 65535, ws = json.wMax / 65535, nS = json.nS, nT = json.nT;
  const lumen = new Map(), wall = new Map();
  for (const [id, seg] of Object.entries(json.segments || {})) {
    const l = new Float32Array(seg.lumen.length), w = new Float32Array(seg.wall.length);
    for (let i = 0; i < l.length; i++) l[i] = seg.lumen[i] * cs;
    for (let i = 0; i < w.length; i++) w[i] = seg.wall[i] * ws;
    lumen.set(+id, l);                                      // (nT * nS), t-major
    wall.set(+id, w);
  }
  return { nS, nT, times: json.times, lumen, wall,
           coatConc: json.coatConcMgMl || 588.0, notes: json.notes || [] };
}

/* Expand the sparse arclength file into a per-voxel bin index. Same walk as the vessel one:
   giarc.bin holds one uint16 per GI voxel in raster order with no index, because which voxels
   those are is already in mat.bin. */
export function buildGIVolume(mat, giarc) {
  const s = new Uint8Array(mat.length);
  let k = 0;
  for (let i = 0; i < mat.length; i++) {
    if (isGI(mat[i])) s[i] = giarc[k++] >> 8;               // 65535 -> 255
  }
  if (k !== giarc.length) {
    console.warn(`gi: giarc has ${giarc.length} entries but the volume has ${k} GI voxels ` +
                 `— the model and its giarc file are out of sync`);
  }
  return s;
}

/* Concentration table for one acquisition time (seconds since administration).
   `times` is NOT uniform — gi_export samples every second through the swallow and every
   thirty minutes later — so the bracketing search cannot assume a 1 Hz grid the way the
   contrast version can. */
export function buildBariumLUT(tl, tSec) {
  const nmat = BodyMaterials.count;
  const lut = new Float32Array(nmat * NS);
  if (!tl) return lut;
  const T = tl.times;
  let i0 = 0;
  while (i0 + 1 < T.length && T[i0 + 1] <= tSec) i0++;
  const i1 = Math.min(T.length - 1, i0 + 1);
  const span = T[i1] - T[i0];
  const ft = span > 0 ? Math.max(0, Math.min(1, (tSec - T[i0]) / span)) : 0;

  for (const [id, f] of tl.lumen) {
    if (id >= nmat) continue;
    const wf = tl.wall.get(id);
    const a = i0 * tl.nS, b = i1 * tl.nS, row = id * NS;
    for (let k = 0; k < NS; k++) {
      const x = (k / (NS - 1)) * (tl.nS - 1);
      const j0 = Math.floor(x), j1 = Math.min(tl.nS - 1, j0 + 1), fs = x - j0;
      const l0 = f[a + j0] * (1 - fs) + f[a + j1] * fs;
      const l1 = f[b + j0] * (1 - fs) + f[b + j1] * fs;
      let c = l0 * (1 - ft) + l1 * ft;
      if (wf) {
        // mucosal coat -> equivalent suspension path length. mg/cm2 / (mg/mL) = cm, and the
        // tracer multiplies by segment length in cm, so express it as the concentration that
        // would give the same areal mass over one voxel of path.
        const w0 = wf[a + j0] * (1 - fs) + wf[a + j1] * fs;
        const w1 = wf[b + j0] * (1 - fs) + wf[b + j1] * fs;
        c += (w0 * (1 - ft) + w1 * ft) * COAT_PER_CM;
      }
      lut[row + k] = c;
    }
  }
  return lut;
}

/* A coat of w mg/cm2 lining a lumen contributes, per cm of ray through that lumen, the mass
   the ray meets on the way in and out: 2w over the voxel it crosses. Dividing by the voxel
   size would make it grid-dependent, so it is expressed per cm directly — at 2 mm voxels a
   12 mg/cm2 coat reads as ~120 mg/mL of equivalent suspension, which is what makes a
   double-contrast wall visible against gas without filling the lumen. */
const COAT_PER_CM = 10.0;
