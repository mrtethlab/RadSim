/* Joint posing off the main thread (core/jointPose.js poseVolume). Resampling a limb's volume into
   a bent pose is seconds of work at 1 mm (the leg: 42 M voxels, 2.6 s), and done on the page it
   froze the room while a joint slider rested. The model is sent once; each pose returns its
   volume, transferred.

   in:  { type: 'model', key, dims, spacingMM, data }       (data copied, kept here)
        { type: 'pose', id, key, flips, chain, angles }
   out: { id, data, dims, pad } | { id, error } */
import { poseVolume } from './jointPose.js';

let model = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'model') {
    model = { key: m.key, dims: m.dims, spacingMM: m.spacingMM, data: m.data };
    return;
  }
  if (m.type !== 'pose') return;
  if (!model || model.key !== m.key) { self.postMessage({ id: m.id, error: 'no model' }); return; }
  try {
    const P = poseVolume(model, m.flips, m.chain, m.angles);
    // straight: poseVolume hands back the model's own array, which must stay here
    const data = P.data === model.data ? P.data.slice() : P.data;
    self.postMessage({ id: m.id, data, dims: P.dims, pad: P.pad }, [data.buffer]);
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err) });
  }
};
