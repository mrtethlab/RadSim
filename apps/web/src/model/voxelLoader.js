// Loader for RadSim voxel phantoms (a chest built by services/compute/app/build_chest.py).
// A model folder holds:  <name>.model.json  (header + material legend),
//   <name>.mat.bin (raw uint8 material ids, x-fastest), and <name>.glb (display mesh).
// Loads the header + material volume; the mesh is loaded separately via loadModelFile.
import { VoxelPhantom } from '../core/voxelPhantom.js';

const MM_PER_UNIT = 10;   // 1 world unit = 10 mm = 1 cm (matches app.js / ct.js)

// baseUrl: folder holding the model, e.g. "/models/chest". name: e.g. "chest".
export async function loadVoxelModel(baseUrl, name) {
  const hdr = await (await fetch(`${baseUrl}/${name}.model.json`)).json();
  const [nx, ny, nz] = hdr.dims;
  const vs = hdr.spacing.map(s => s / MM_PER_UNIT);   // mm → world units (cm)
  // backend-only models (large, e.g. a 0.25 mm section that is 100s of MB) never load
  // the material volume into the browser: the Python GPU engine reads it from disk.
  // We still build a geometry-only phantom (extent/placement) for positioning.
  const backendOnly = !!hdr.backendOnly;
  let data = null;
  if (!backendOnly) {
    const buf = await (await fetch(`${baseUrl}/${hdr.volume}`)).arrayBuffer();
    data = new Uint8Array(buf);
    if (data.length !== nx * ny * nz) throw new Error(`voxel volume size mismatch: ${data.length} vs ${nx * ny * nz}`);
  }
  return {
    header: hdr,
    dims: [nx, ny, nz],
    spacingMM: hdr.spacing,
    vs,                                   // cm/voxel per axis
    data,
    backendOnly,
    legend: hdr.materials,
    meshUrl: hdr.mesh ? `${baseUrl}/${hdr.mesh}` : null,
    extentMM: [nx * hdr.spacing[0], ny * hdr.spacing[1], nz * hdr.spacing[2]],
    // build a VoxelPhantom centred at `center` (world cm) with optional axis flips.
    // With data=null it is geometry-only (extent/flip for placement; trace unused —
    // the backend does the ray-casting).
    makePhantom(center, flip, rot) { return new VoxelPhantom({ dims: [nx, ny, nz], vs, data }, center, flip, rot); },
  };
}
