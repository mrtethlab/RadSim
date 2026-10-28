/* SURGICAL ANIMATIONS: the hip joint injection: contrast, then lidocaine and a corticosteroid. The
   adult (chest/abdomen/pelvis, with its thighs) supine, the right hip.
   A placeholder until the film is written: the room and the title. */
import { buildKit } from './surg/kit.js';

export async function build(api) {
  const K = await buildKit(api, { patient: 'adult', region: 'hip' });
  const c = K.toRoom([0, 5, -27]);
  return {
    title: 'Hip joint injection',
    chapters: [{ title: 'Hip joint injection', steps: [{
      title: 'Hip joint injection', dur: 8, fadeIn: 0.6, scale: '1 m',
      enter() { K.reset('room'); },
      cam: [[0, [c[0] + 200, c[1] + 130, c[2] - 160], c, 40], [8, [c[0] + 170, c[1] + 110, c[2] - 130], c, 40]],
      caption: [{ from: 0.6, to: 8, text: '<b>Hip joint injection</b>' }],
    }] }],
  };
}
