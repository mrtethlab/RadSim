/* CT FILM: the artefact scans, asked for by name. A worker computes them all in the background from
   the film's start; a step that needs one before it has arrived computes it here, at once (the
   same seeded arithmetic, so the same image). */
import { JOBS } from './artsim.js';
import { slabSlices } from './simct.js';

export function artJobs(api, img) {
  const done = new Map();
  const SLAB = [209, 165, 49];
  const ok = img.slab && img.slab.w >= SLAB[0] * 7;
  let slices = null;
  const I = { ...img };
  if (!ok) I.slab = { w: SLAB[0] * 7, h: SLAB[1] * 7, ids: new Uint8Array(SLAB[0] * SLAB[1] * 49) };
  I.slabTile = SLAB;
  const order = Object.keys(JOBS);
  try {
    const w = new Worker(new URL('./artworker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { if (!done.has(e.data.k)) done.set(e.data.k, e.data.r); };
    w.onerror = () => w.terminate();
    const plain = {};
    for (const k of ['ax_head', 'ax_metal', 'ax_shoulder', 'ax_pelvis', 'ax_chest', 'ax_abd', 'slab']) plain[k] = { w: I[k].w, h: I[k].h, ids: I[k].ids };
    plain.slabTile = SLAB;
    w.postMessage({ I: plain, order });
    api.onDispose(() => w.terminate());
  } catch (_) { /* no workers: each is computed when first asked for */ }
  return (k) => {
    let r = done.get(k);
    if (!r) {
      if (!slices) slices = slabSlices(I.slab, SLAB[0], SLAB[1], SLAB[2]);
      r = JOBS[k](I, slices);
      done.set(k, r);
    }
    return r;
  };
}
