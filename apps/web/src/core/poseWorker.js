/* Joint posing off the main thread (core/jointPose.js). Resampling a limb's volume into a bent pose
   is a second or more of work at 1 mm, and done on the page it froze the room while a joint slider
   rested. The model is sent once; each pose returns its volume, transferred.

   One worker poses a volume whole ('pose'). Several share one (app.js, the pose pool): each makes
   the same plan for the pose (posePlan: one pass over the input, ~0.1 s, kept for the pose's other
   chunks) and fills the output slices of the chunks it is handed ('chunk'); the page puts the
   slices together and one worker smooths the crooks of the whole ('fold').

   in:  { type: 'model', key, dims, spacingMM, data }       (data copied, kept here)
        { type: 'pose', id, key, flips, chain, angles }
        { type: 'chunk', id, key, flips, chain, angles, c, m }    chunk c of m of the output slices
        { type: 'fold', id, key, flips, chain, angles, data }     (data transferred both ways)
   out: { id, data, dims, pad } | { id, c, k0, k1, data, dims, pad } | { id, data } | { id, error } */
import { poseVolume, posePlan, poseChunk } from './jointPose.js';

let model = null;
let planFor = '', plan = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'model') {
    model = { key: m.key, dims: m.dims, spacingMM: m.spacingMM, data: m.data };
    planFor = ''; plan = null;
    return;
  }
  try {
    if (!model || model.key !== m.key) { self.postMessage({ id: m.id, error: 'no model' }); return; }
    // the pose's plan, kept for its other chunks and its fold
    const planOf = () => {
      const key = JSON.stringify([m.flips, m.angles]);
      if (key !== planFor) { plan = posePlan(model, m.flips, m.chain, m.angles); planFor = key; }
      return plan;
    };
    if (m.type === 'fold') {
      const P = planOf();
      if (P) P.fold(m.data);
      self.postMessage({ id: m.id, data: m.data }, [m.data.buffer]);
      return;
    }
    if (m.type === 'pose') {
      const P = poseVolume(model, m.flips, m.chain, m.angles);
      // straight: poseVolume hands back the model's own array, which must stay here
      const data = P.data === model.data ? P.data.slice() : P.data;
      self.postMessage({ id: m.id, data, dims: P.dims, pad: P.pad }, [data.buffer]);
      return;
    }
    if (m.type === 'chunk') {
      const P = planOf();
      if (!P) { self.postMessage({ id: m.id, error: 'straight' }); return; }
      const [N0, N1, N2] = P.dims, [k0, k1] = poseChunk(N2, m.c, m.m);
      const data = new Uint8Array(N0 * N1 * (k1 - k0));
      P.rows(k0, k1, data);
      self.postMessage({ id: m.id, c: m.c, k0, k1, data, dims: P.dims, pad: P.pad }, [data.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err) });
  }
};
