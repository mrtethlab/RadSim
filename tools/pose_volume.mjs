// Pose a model's label volume with the app's own joint code (apps/web/src/core/jointPose.js), for
// services/compute/app/bake_pose.py: the limb models are baked into the anatomical position.
//   node tools/pose_volume.mjs <model> '<angles json>' <out.bin> [in.bin]   -> out.bin (uint8) + out.bin.json {dims}
// in.bin: pose this uint8 volume (the model's dims) instead of its materials, by the same joints: the
// joint-space sheets travel with the bake this way (services/compute/app/joint_space.py).
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'apps', 'web');
const JP = await import(pathToFileURL(path.join(WEB, 'src', 'core', 'jointPose.js')));
const [name, ang, out, input] = process.argv.slice(2);
const dir = path.join(WEB, 'public', 'models', name);
const h = JSON.parse(fs.readFileSync(path.join(dir, `${name}.model.json`), 'utf8'));
const data = new Uint8Array(fs.readFileSync(input || path.join(dir, `${name}.mat.bin`)));
const js = JSON.parse(fs.readFileSync(path.join(WEB, 'src', 'data', 'joints.json'), 'utf8'))[name];
const chain = Object.values(js).map((j) => ({ ...j,
  // a field joint's weights, from the grid beside the model (app.js loadJointFields)
  ...(j.field ? { field: { ...j.field, data: new Uint8Array(fs.readFileSync(path.join(dir, j.field.file))) } } : {}),
  // a joint's rider (the knee's patella), from its grid beside the model too
  ...(j.rider ? { rider: { ...j.rider, data: new Uint8Array(fs.readFileSync(path.join(dir, j.rider.file))) } } : {}),
  motions: j.motions.map((m) => ({ ...m, axis: JP.axisToward(m.from || j.distal, m.toward) })) }));
const sp = (h.spacing || h.spacingMM || [1.5, 1.5, 1.5]).map(Number);
// the x-ray room's frame flips (app.js voxelFlips; a subject rolled 180 degrees has x and y unflipped)
const ROLLED_180 = new Set(['chestabdopelvis', 'headneck']);
const flips = ROLLED_180.has(name) ? [false, false, false] : [true, true, false];
const P = JP.poseVolume({ dims: h.dims, spacingMM: sp, data }, flips, chain, JSON.parse(ang));
fs.writeFileSync(out, P.data);
fs.writeFileSync(out + '.json', JSON.stringify({ dims: P.dims, pad: P.pad }));
console.log(name, 'posed', ang, '->', P.dims.join('x'));
