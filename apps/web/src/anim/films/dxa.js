/* THE DXA FILM: bone densitometry, from the patient on the table to the T-score on the report.
   Four chapters (films/dxa/*.js): the scanner and the patient; the two energies; the scan and
   the physics of the dual-energy solve; the analysis and the report. One 3D set (dxa/room.js: the
   app's own densitometer, the chest-abdomen-pelvis patient on it); the small things on the 8-bit
   layer. The studies it shows are the app's own scans of that patient (dxa/bake.mjs), so every
   image, region and number on screen is what the DXA mode itself measures. */
import { lights } from '../kit/stage.js';
import { buildSet } from './dxa/room.js';
import { loadStudies } from './dxa/data.js';
import { machine } from './dxa/machine.js';
import { energies } from './dxa/energy.js';
import { scanning } from './dxa/scan.js';
import { results } from './dxa/result.js';

export async function build(api) {
  lights(api.scene, { amb: 1.5, key: 2.0 });
  const J = await loadStudies(import.meta.env.BASE_URL);
  const S = await buildSet(api, J);
  S.J = J;
  const chapters = [machine(api, S), energies(api, S), scanning(api, S), results(api, S)];
  return { title: 'Bone densitometry (DXA): the whole process', chapters };
}
