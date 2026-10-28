/* SURGICAL ANIMATIONS: the lumbar epidural: the needle into the epidural space, the space opened.
   The child prone, the lumbar region.
   A placeholder until the film is written: the room and the title. */
import { buildKit } from './surg/kit.js';

export async function build(api) {
  const K = await buildKit(api, { patient: 'child', region: 'lumbar' });
  const c = K.toRoom([0, 9, 14]);
  return {
    title: 'Epidural injection',
    chapters: [{ title: 'Epidural injection', steps: [{
      title: 'Epidural injection', dur: 8, fadeIn: 0.6, scale: '1 m',
      enter() { K.reset('room'); },
      cam: [[0, [c[0] + 200, c[1] + 130, c[2] - 160], c, 40], [8, [c[0] + 170, c[1] + 110, c[2] - 130], c, 40]],
      caption: [{ from: 0.6, to: 8, text: '<b>Epidural injection</b>' }],
    }] }],
  };
}
