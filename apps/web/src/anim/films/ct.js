/* THE CT FILM: computed tomography from the machine to the dose report. Five chapters
   (films/ct/*.js): the scanner (gantry, tube, generator, slip ring, bowtie, collimation, the
   detector and its electronics); scanning (couch, lasers, scout, planning, axial and helical,
   pitch, rotation); projections and reconstruction (photons through a real slice, line
   integrals, the sinogram, back-projection, filtering, FBP, kernels, iterative); the image
   (voxels, the matrix, Hounsfield units, windows, reformats); contrast and dose (injector, bolus
   tracking, phases, CTDI, DLP, tube current modulation). Its sets: the app's own CT rig in a
   room with the patient and, under the covers, the rotating frame (ct/rig.js); its slices and
   their arithmetic (ct/slice.js, prepared once in ct/recon.js). */
import { lights } from '../kit/stage.js';
import { buildSets } from './ct/rig.js';
import { loadImages } from './ct/slice.js';
import { scanner } from './ct/scanner.js';
import { scanning } from './ct/scanning.js';
import { prepare, reconstruction } from './ct/recon.js';
import { picture } from './ct/image.js';
import { contrastDose } from './ct/dose.js';

export async function build(api) {
  lights(api.scene);
  const [S, img] = await Promise.all([buildSets(api), loadImages()]);
  S.img = img;
  S.R = prepare(img);
  // matrices current before a frame measures anything on screen (the player renders after it)
  S.sync = () => { api.camera.updateMatrixWorld(true); S.room.updateMatrixWorld(true); };
  const chapters = [];
  for (const ch of [scanner, scanning, reconstruction, picture, contrastDose]) {
    const c = await ch(api, S);
    if (c?.steps.length) chapters.push(c);
  }
  for (const c of chapters) for (const s of c.steps) {
    const f = s.frame;
    if (s.view !== 'pixel') s.frame = (t, dt) => { api.camera.updateMatrixWorld(true); f?.(t, dt); };
  }
  return { title: 'CT: the whole process', chapters };
}
