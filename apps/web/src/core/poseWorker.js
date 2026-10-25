/* Joint posing off the main thread (core/jointPose.js). Resampling a limb's volume into a bent pose
   is a second or more of work at 1 mm, and done on the page it froze the room while a joint slider
   rested. The model is sent once; each pose returns its volume, transferred.

   One worker poses a volume whole ('pose'). Several share one (app.js, the pose pool), in stages:
   each samples its range of the input ('sample': the plan's extents), then marks where its moved
   samples land ('occ'), one worker grows the marks ('grow'); each builds its plan from the shared
   result (posePlan pre, kept for the pose's other messages) and fills the output slices of the
   chunks it is handed ('chunk'); the page puts the slices together, the workers smooth the crooks
   in slabs ('foldslab'), and one sets the riders down ('ride'). Each worker making the whole plan
   itself was ~0.15 s before its first chunk, and one worker folding all of it ~0.15 s after.

   in:  { type: 'model', key, dims, spacingMM, data }       (data copied, kept here)
        { type: 'pose', id, key, flips, chain, angles }
        { type: 'sample', id, key, flips, chain, angles, k0, k1 }       -> { id, sample }
        { type: 'occ', id, key, flips, chain, angles, S, k0, k1 }       -> { id, occ }
        { type: 'grow', id, key, S, parts }                            -> { id, occ }
        { type: 'chunk', id, key, flips, chain, angles, pre, c, m }    chunk c of m of the output slices
        { type: 'foldslab', id, key, flips, chain, angles, pre, data, base, k0, k1 }   slices k0..k1-1
        { type: 'fold' | 'ride', id, key, flips, chain, angles, pre, data }   (data transferred both ways)
   (chain and pre come with a worker's first message of a pose; the plan is kept for the rest)
   out: { id, data, dims, pad, box } | { id, c, k0, k1, data, dims, pad, box } | { id, data } | { id, error } */
import { poseVolume, posePlan, poseChunk, planSample, planOcc, growOcc } from './jointPose.js';

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
      if (key !== planFor) { plan = posePlan(model, m.flips, m.chain, m.angles, m.pre || null); planFor = key; }
      return plan;
    };
    if (m.type === 'sample') { self.postMessage({ id: m.id, sample: planSample(model, m.flips, m.chain, m.angles, m.k0, m.k1) }); return; }
    if (m.type === 'occ') {
      const occ = planOcc(model, m.flips, m.chain, m.angles, m.S, m.k0, m.k1);
      self.postMessage({ id: m.id, occ }, [occ.buffer]);
      return;
    }
    if (m.type === 'grow') { const occ = growOcc(model, m.S, m.parts); self.postMessage({ id: m.id, occ }, [occ.buffer]); return; }
    if (m.type === 'fold' || m.type === 'ride' || m.type === 'foldslab') {
      const P = planOf();
      if (P) { if (m.type === 'fold') P.fold(m.data); else if (m.type === 'ride') P.ride(m.data); else P.foldSlab(m.data, m.k0, m.k1, m.base); }
      self.postMessage({ id: m.id, data: m.data }, [m.data.buffer]);
      return;
    }
    if (m.type === 'pose') {
      const P = poseVolume(model, m.flips, m.chain, m.angles);
      // straight: poseVolume hands back the model's own array, which must stay here
      const data = P.data === model.data ? P.data.slice() : P.data;
      self.postMessage({ id: m.id, data, dims: P.dims, pad: P.pad, box: P.box }, [data.buffer]);
      return;
    }
    if (m.type === 'chunk') {
      const P = planOf();
      if (!P) { self.postMessage({ id: m.id, error: 'straight' }); return; }
      const [N0, N1, N2] = P.dims, [k0, k1] = poseChunk(N2, m.c, m.m);
      const data = new Uint8Array(N0 * N1 * (k1 - k0));
      P.rows(k0, k1, data);
      self.postMessage({ id: m.id, c: m.c, k0, k1, data, dims: P.dims, pad: P.pad, box: P.box }, [data.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err) });
  }
};
