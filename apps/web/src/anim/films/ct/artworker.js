/* CT FILM: the artefact scans computed off the main thread (each takes a fraction of a second to a
   second or so, and the film would stutter). Given the images, it runs the jobs in order and
   posts each result as it is done, its arrays transferred. */
import { JOBS } from './artsim.js';
import { slabSlices } from './simct.js';

self.onmessage = (e) => {
  const { I, order } = e.data;
  const slices = slabSlices(I.slab, I.slabTile[0], I.slabTile[1], I.slabTile[2]);
  for (const k of order) {
    const r = JOBS[k](I, slices), transfer = [];
    for (const v of Object.values(r)) if (v instanceof Float32Array) transfer.push(v.buffer);
    self.postMessage({ k, r }, transfer);
  }
};
