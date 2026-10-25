/* THE CT FILM: computed tomography from the machine to the dose report. Six chapters
   (films/ct/*.js): the scanner (gantry, tube, generator, slip ring, bowtie, collimation, the
   detector, its rows along the patient and the slices made of them, its electronics); scanning
   (couch, lasers, scout, planning, axial and helical, pitch, rotation); projections and
   reconstruction (photons through a real slice, line integrals, the sinogram, back-projection,
   filtering, FBP, kernels, iterative; slices from the helix, thickness and interval); the image
   (voxels, the matrix, Hounsfield units, windows, reformats; thin and thick slices, interval and
   overlap in reformats); artefacts (beam hardening, dense objects, photon starvation, metal,
   partial volume, motion, rings, too few views, truncation, stair-step, windmill, cone beam:
   each a simulated scan of the model, ct/artsim.js); contrast and dose (injector, bolus
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
import { artefacts } from './ct/artefacts.js';
import { artJobs } from './ct/artjobs.js';
import { slabSlices } from './ct/simct.js';
import { SLAB_TOP } from './ct/artsim.js';
import { zaxis } from './ct/zaxis.js';

export async function build(api) {
  lights(api.scene);
  const [S, img] = await Promise.all([buildSets(api), loadImages()]);
  S.img = img;
  S.R = prepare(img);
  // the lower chest's consecutive layers (the slab), and the artefact scans (computed in a worker)
  S.slabTop = SLAB_TOP;
  S.slices = img.slab.w >= 209 * 7 ? slabSlices(img.slab, 209, 165, 49) : Array.from({ length: 49 }, () => ({ w: 209, h: 165, ids: new Uint8Array(209 * 165) }));
  S.art = artJobs(api, img);
  S.zaxis = zaxis(img, S.slices, SLAB_TOP);
  // matrices current before a frame measures anything on screen (the player renders after it)
  S.sync = () => { api.camera.updateMatrixWorld(true); S.room.updateMatrixWorld(true); };
  const chapters = [];
  for (const ch of [scanner, scanning, reconstruction, picture, artefacts, contrastDose]) {
    const c = await ch(api, S);
    if (c?.steps.length) chapters.push(c);
  }
  for (const c of chapters) for (const s of c.steps) {
    const f = s.frame;
    if (s.view !== 'pixel') s.frame = (t, dt) => { api.camera.updateMatrixWorld(true); f?.(t, dt); };
  }
  return { title: 'CT: the whole process', chapters };
}
