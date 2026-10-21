/* PALPATION, the geometry: from a bony landmark outward to the skin over it (trainer/palpate.js
   shows it; tools/measure_palpation.py measures the bone). */

/* From the bone outward until the last tissue voxel (or the edge of the volume). Rest frame cm. */
export function skinPoint(vm, flips, bone, dir) {
  const [nx, ny, nz] = vm.dims, sp = vm.spacingMM.map((v) => v / 10), data = vm.data;
  const sgn = flips.map((f) => (f ? -1 : 1));
  const idx = (p) => [Math.round(sgn[0] * p[0] / sp[0] + (nx - 1) / 2),
    Math.round(sgn[1] * p[1] / sp[1] + (ny - 1) / 2), Math.round(sgn[2] * p[2] / sp[2] + (nz - 1) / 2)];
  const step = Math.min(sp[0], sp[1], sp[2]) / 2;
  let last = bone.slice(), airRun = 0;
  for (let t = 0; t < 30; t += step) {
    const p = [bone[0] + dir[0] * t, bone[1] + dir[1] * t, bone[2] + dir[2] * t];
    const [i, j, k] = idx(p);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) break;
    if (data[(k * ny + j) * nx + i] !== 0) { last = p; airRun = 0; }
    else if (++airRun * step > 1.0) break;        // a centimetre of air: out of the body
  }
  return last;
}

