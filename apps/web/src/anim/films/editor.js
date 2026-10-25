/* THE MODEL EDITOR FILM: how a voxel phantom is made and how the simulator images it, on one real
   model (the chest/abdomen/pelvis, a TotalSegmentator CT) from scan to image. Three chapters
   (films/editor/*.js): from a CT scan to a volume of material ids; the materials and what they
   do to x-rays, at the scale of their atoms; the editor, and the volume imaged by x-ray, CT,
   fluoroscopy and ultrasound. Everything shown of the model is computed from its voxels by the
   app's own code (editor/data.js). */
import { lights } from '../kit/stage.js';
import { loadData } from './editor/data.js';
import { buildSets } from './editor/sets.js';
import { scanning } from './editor/scan.js';
import { matter } from './editor/matter.js';
import { imaging } from './editor/image.js';

export async function build(api) {
  lights(api.scene);
  const D = await loadData();
  const S = { sets: {}, D };
  await buildSets(api, S, D);
  const chapters = [scanning(api, S), matter(api, S), imaging(api, S)];
  return { title: 'Model Editor: the whole process', chapters };
}
