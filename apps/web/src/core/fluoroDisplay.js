/* Fluoroscopy image processing, as every fluoroscope does it — pure functions on square frames
   of transmission values (negative = outside the field), so they can be tested off the page.

   RECURSIVE FILTER. A screening pulse is noisy. Each displayed frame is k x the previous plus
   (1 - k) x the new pulse, which cuts the noise of anatomy that holds still by
   sqrt((1 + k) / (1 - k)) and smears what moves — the lag a fast pan shows. That trade is why
   the setting exists.

   DISPLAY MAP, flat-panel style. LOG transmission (equal steps of attenuation, equal steps of
   grey), the slowly-varying background lifted out (body thickness — "harmonisation") so bone's
   local contrast fills the screen, then a window on the central field. What the beam got through
   is bright, bone and contrast dark, as on the monitor. It replaced a central-mean gain and a
   square root that, through a 30 cm abdomen at the 110 kV the ABC rails at, squeezed a spine into
   a few grey levels.

   EDGE ENHANCEMENT: a mild unsharp mask, restoring the cortical margins the averaging softened. */

export const NR_K = [0, 0.5, 0.7, 0.85];          // off / low / medium / high

/* acc: the running average (or null to start afresh). Returns the frame to display; reuses acc
   when it can. */
export function recursiveStep(acc, img, k) {
  if (!k || !acc || acc.length !== img.length) return Float32Array.from(img);
  for (let i = 0; i < img.length; i++) {
    const t = img[i];
    acc[i] = t >= 0 && acc[i] >= 0 ? k * acc[i] + (1 - k) * t : t;
  }
  return acc;
}

// separable running-box blur, in place, on a square n x n array
export function boxBlurSq(a, n, r, row = new Float32Array(n)) {
  const w = 2 * r + 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let line = 0; line < n; line++) {
      const at = (i) => (pass === 0 ? line * n + i : i * n + line);
      let s = 0;
      for (let i = -r; i <= r; i++) s += a[at(Math.min(n - 1, Math.max(0, i)))];
      for (let i = 0; i < n; i++) {
        row[i] = s / w;
        s += a[at(Math.min(n - 1, i + r + 1))] - a[at(Math.max(0, i - r))];
      }
      for (let i = 0; i < n; i++) a[at(i)] = row[i];
    }
  }
}

/* img: transmission (>= 0 in the field, < 0 outside). out: receives 0..1, or -1 outside.
   harmonise: fraction of the log background lifted out (0 = plain log display). */
export function displayMap(img, n, out, { harmonise = 0.6, scratch = null } = {}) {
  const N = n * n;
  const L = scratch?.L && scratch.L.length === N ? scratch.L : new Float32Array(N);
  const B = scratch?.B && scratch.B.length === N ? scratch.B : new Float32Array(N);
  if (scratch) { scratch.L = L; scratch.B = B; }
  let sum = 0, cnt = 0;
  for (let k = 0; k < N; k++) { const t = img[k]; if (t >= 0) { L[k] = Math.log(Math.max(t, 1e-7)); sum += L[k]; cnt++; } }
  const mean = cnt ? sum / cnt : 0;
  for (let k = 0; k < N; k++) B[k] = img[k] >= 0 ? L[k] : mean;
  // the background is BODY-scale: a few centimetres. A kernel the size of a vertebra would lift
  // out the vertebrae themselves and leave only edges and noise.
  const r = Math.max(2, Math.round(n / 5));
  boxBlurSq(B, n, r); boxBlurSq(B, n, r);
  const vals = [];
  const c0 = n * 0.2 | 0, c1 = n * 0.8 | 0;
  for (let k = 0; k < N; k++) {
    if (img[k] < 0) { out[k] = -1; continue; }
    const h = L[k] - harmonise * B[k];
    out[k] = h;
    const i = k % n, j = (k / n) | 0;
    if (i >= c0 && i < c1 && j >= c0 && j < c1) vals.push(h);
  }
  if (!vals.length) return out;
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.01)], hi = vals[Math.floor(vals.length * 0.99)];
  const span = hi - lo || 1;
  for (let k = 0; k < N; k++) if (out[k] !== -1) { const v = (out[k] - lo) / span; out[k] = v < 0 ? 0 : v > 1 ? 1 : v; }
  return out;
}

/* Unsharp mask over the field only (3x3 neighbourhood mean), in place. */
export function edgeEnhance(lum, n, amount, tmp = null) {
  if (!amount) return lum;
  const src = tmp && tmp.length === lum.length ? tmp : new Float32Array(lum.length);
  src.set(lum);
  for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
    const k = j * n + i, c = src[k];
    if (c < 0) continue;
    let s = 0, m = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const v = src[k + dj * n + di];
      if (v >= 0) { s += v; m++; }
    }
    const v = c + amount * (c - s / m);
    lum[k] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return lum;
}
