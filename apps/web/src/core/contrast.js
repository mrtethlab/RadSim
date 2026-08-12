/* ============================================================================
   CONTRAST FIELD
   Turns a solver timeline (concentration on the vascular graph, C(s,t) per vessel and
   C(t) per organ) into the two lookups the ray-caster wants:

     sVol    — Uint8Array(nvox): which arclength bin each voxel sits at. Built once per
               model from the sparse <name>.arclen.bin, which stores s only for vessel
               voxels, in raster order. Non-vessel voxels are 0.
     concLUT — Float32Array(nmat * NS): mgI/mL for [material id][arclength bin], rebuilt
               for each acquisition time. Organs fill every bin of their row with the same
               number, so the tracer indexes both the same way and needs no branch.

   Why a table rather than evaluating per voxel: the trace is the hot loop, and a voxel's
   concentration depends only on (material, s, t). t is fixed for one acquisition, so the
   whole dependence collapses to a 48 KB table built once per image.
   ============================================================================ */
import { BodyMaterials } from './materials.js';

export const NS = 256;                 // arclength bins — matches the uint8 sVol range
// Vessels are ids 29..46. A bare `>= 29` test would be wrong now that the GI tract sits at
// 47+: this walk has to select exactly the voxels build_vessels.py wrote entries for, and
// including the gut here would shift every entry after the first GI voxel.
const FIRST_VESSEL = 29, LAST_VESSEL = 46;
const isVessel = (id) => id >= FIRST_VESSEL && id <= LAST_VESSEL;

/* Decode the packed uint16 timeline from services/compute/app/contrast_export.py. */
export function decodeTimeline(json) {
  const scale = json.cMax / 65535, nS = json.nS, nT = json.nT;
  const vessels = new Map(), organs = new Map();
  for (const [id, arr] of Object.entries(json.vessels || {})) {
    const f = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) f[i] = arr[i] * scale;
    vessels.set(+id, f);                                    // (nT * nS), t-major
  }
  for (const [id, arr] of Object.entries(json.organs || {})) {
    const f = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) f[i] = arr[i] * scale;
    organs.set(+id, f);                                     // (nT)
  }
  return { nS, nT, times: json.times, vessels, organs,
           injection: json.injection, patient: json.patient,
           approximations: json.approximations || [] };
}

/* Expand the sparse arclength file into a per-voxel bin index.
   arclen.bin holds one uint16 per VESSEL voxel in raster order, with no index — which
   voxels those are is already in mat.bin (ids 29..46). So the two are walked together, and
   the uint16 normalised s is dropped to the 8 bits sVol keeps. */
export function buildSVolume(mat, arclen) {
  const s = new Uint8Array(mat.length);
  let k = 0;
  for (let i = 0; i < mat.length; i++) {
    if (isVessel(mat[i])) s[i] = arclen[k++] >> 8;           // 65535 -> 255
  }
  if (k !== arclen.length) {
    console.warn(`contrast: arclen has ${arclen.length} entries but the volume has ${k} ` +
                 `vessel voxels — the model and its arclen file are out of sync`);
  }
  return s;
}

/* Concentration table for one acquisition time (seconds since injection start).
   Linear in t between the timeline's 1 Hz samples, and linear in s between its nS nodes. */
export function buildConcLUT(tl, tSec) {
  const nmat = BodyMaterials.count;
  const lut = new Float32Array(nmat * NS);
  if (!tl) return lut;
  // bracket the time samples
  const tt = Math.max(0, Math.min(tl.nT - 1, tSec));
  const i0 = Math.floor(tt), i1 = Math.min(tl.nT - 1, i0 + 1), ft = tt - i0;

  for (const [id, f] of tl.vessels) {
    if (id >= nmat) continue;
    const a = i0 * tl.nS, b = i1 * tl.nS, row = id * NS;
    for (let k = 0; k < NS; k++) {
      // s in [0,1] across NS bins -> the timeline's nS nodes
      const x = (k / (NS - 1)) * (tl.nS - 1);
      const j0 = Math.floor(x), j1 = Math.min(tl.nS - 1, j0 + 1), fs = x - j0;
      const c0 = f[a + j0] * (1 - fs) + f[a + j1] * fs;
      const c1 = f[b + j0] * (1 - fs) + f[b + j1] * fs;
      lut[row + k] = c0 * (1 - ft) + c1 * ft;
    }
  }
  for (const [id, f] of tl.organs) {
    if (id >= nmat) continue;
    const c = f[i0] * (1 - ft) + f[i1] * ft, row = id * NS;
    lut.fill(c, row, row + NS);                  // uniform along s — whole-organ enhancement
  }
  return lut;
}

/* Acquisition time of a slice.
   A CT scan is not an instant: a chest-abdomen helical takes 8-12 s to travel the body, so
   the liver is imaged seconds after the lungs and can be in a different contrast phase.
   Mapping z to time is what makes "you scanned too early" visible rather than theoretical.
     z      — world position along the scan axis (cm)
     zStart — where the scan began (cm), tStart — when (s)
     speed  — table speed (cm/s); 0 for a single axial acquisition */
export function acquisitionTime(z, zStart, tStart, speed) {
  if (!speed) return tStart;
  return tStart + (z - zStart) / speed;
}
