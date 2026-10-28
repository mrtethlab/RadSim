/* SURGICAL ANIMATIONS: the lumbar puncture (a placeholder: the kit's demonstration, surg/demo.js,
   until the film itself is written). The child prone, the lumbar region. */
import { buildKit } from './surg/kit.js';
import { demoChapters } from './surg/demo.js';

export async function build(api) {
  const K = await buildKit(api, { patient: 'child', region: 'lumbar' });
  return { title: 'Lumbar puncture', chapters: demoChapters(api, K) };
}
