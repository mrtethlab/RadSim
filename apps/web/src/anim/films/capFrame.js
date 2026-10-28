/* THE CHEST/ABDOMEN/PELVIS AS THE FILMS WERE LAID OUT ON IT. The model grew 15 cm of thigh at its
   foot (services/compute/app/build_cap_thighs.py): CAP_FOOT slices under the 356 the films were
   drawn on, the trunk's voxels as they were above them. Its meshes are centred on the whole volume,
   so every point of the trunk now sits CAP_SHIFT_MM further up their z than when the films placed
   them: a film moves its meshes back down by that much (the thighs run on below, as legs do), and
   a film that reads the volume itself takes it from where it used to begin. */
export const CAP_FOOT = 75;                    // slices (2 mm) grafted at the foot
export const CAP_SHIFT_MM = CAP_FOOT * 2 / 2;  // the volume's centre moved down by half of them

/* A loaded CAP mesh (glb scene, mm) back in the frame the film was laid out in. Each load parses
   its own geometry, so it is moved in place. */
export function capMeshFrame(g) {
  if (g) g.traverse((o) => { if (o.isMesh) o.geometry.translate(0, 0, -CAP_SHIFT_MM); });
  return g;
}

/* The CAP's voxels from where the films' volume began: { data, dims } (data shares the buffer). */
export function capVolumeFrame(data, dims) {
  const [nx, ny, nz] = dims;
  return { data: data.subarray(CAP_FOOT * nx * ny), dims: [nx, ny, nz - CAP_FOOT] };
}
