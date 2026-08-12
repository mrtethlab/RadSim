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
    // optional photo-textured display skin (build_hand_skin.py). Display ONLY — the
    // physics always uses the material volume, never this mesh.
    skinUrl: hdr.skinMesh ? `${baseUrl}/${hdr.skinMesh}` : null,
    extentMM: [nx * hdr.spacing[0], ny * hdr.spacing[1], nz * hdr.spacing[2]],
    // Contrast: models built with build_vessels carry a vascular transport coordinate.
    // Loaded lazily — the expanded per-voxel form is as big as the material volume, so a
    // model that is never scanned with contrast should never pay for it.
    hasVessels: !!hdr.arclen,
    // A timeline solved offline and shipped with the model, so contrast works without the
    // Python service. Fixed protocol, but one file PER INJECTION SITE — switching the
    // access route is the one injector control that still works on presets, because the
    // route changes the topology of the solve, not a continuous parameter of it.
    hasPresetContrast: !!hdr.contrast,
    presetSites: hdr.contrastSites ? Object.keys(hdr.contrastSites) : (hdr.contrast ? ['basilic'] : []),
    async loadPresetContrast(site = 'basilic') {
      const fn = (hdr.contrastSites && hdr.contrastSites[site]) || hdr.contrast;
      if (!fn) return null;
      this._preset = this._preset || {};
      if (!this._preset[fn]) this._preset[fn] = await (await fetch(`${baseUrl}/${fn}`)).json();
      return this._preset[fn];
    },
    // GI: models built with build_gi carry a transport coordinate for the gut, and may ship
    // a solved barium timeline. Same lazy contract as the vascular pair above — a model that
    // is never given barium never pays for the expanded per-voxel form.
    hasGI: !!hdr.giarc,
    hasPresetBarium: !!hdr.barium,
    async loadPresetBarium() {
      if (!hdr.barium) return null;
      if (!this._barium) this._barium = await (await fetch(`${baseUrl}/${hdr.barium}`)).json();
      return this._barium;
    },
    // The GI segment geometry itself: per-segment volume, area profile and the bin centroids
    // the live solver rotates into the patient's pose to get an elevation profile.
    async loadGI() {
      if (!hdr.gi) return null;
      if (!this._gi) this._gi = await (await fetch(`${baseUrl}/${hdr.gi}`)).json();
      return this._gi;
    },
    async loadGIArc() {
      if (!hdr.giarc) return null;
      if (!this._giarc) {
        const buf = await (await fetch(`${baseUrl}/${hdr.giarc}`)).arrayBuffer();
        this._giarc = new Uint16Array(buf);
      }
      return this._giarc;
    },
    arclenUrl: hdr.arclen ? `${baseUrl}/${hdr.arclen}` : null,
    async loadArclen() {
      if (!hdr.arclen) return null;
      if (!this._arclen) {
        const buf = await (await fetch(`${baseUrl}/${hdr.arclen}`)).arrayBuffer();
        this._arclen = new Uint16Array(buf);
      }
      return this._arclen;
    },
    // build a VoxelPhantom centred at `center` (world cm) with optional axis flips.
    // With data=null it is geometry-only (extent/flip for placement; trace unused —
    // the backend does the ray-casting).
    makePhantom(center, flip, rot) { return new VoxelPhantom({ dims: [nx, ny, nz], vs, data }, center, flip, rot); },
  };
}
