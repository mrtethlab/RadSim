// Custom model import. .glb / .gltf files load directly in the browser via
// three's GLTFLoader. .blend files are NOT a browser format — they are converted
// to .glb by the Python backend (services/compute, see compute/client.js).
//
// Foundation scope: load a user model and display it in the positioning bay as a
// visual overlay. Turning an imported mesh into a phantom the ray-caster can use
// (mesh voxelisation / signed-distance sampling) is the next step toward custom
// phantoms and CT — see phantom/hand.js for the analytic contract to match.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

// Load a File (from an <input type=file>) -> resolves to a THREE.Group (gltf.scene).
export function loadModelFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    loader.load(
      url,
      (gltf) => { URL.revokeObjectURL(url); resolve(gltf.scene); },
      undefined,
      (err) => { URL.revokeObjectURL(url); reject(err); }
    );
  });
}
