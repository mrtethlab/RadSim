/* A circular region of interest on a reconstructed slice: mean and standard deviation in HU.
   It is the basic measuring tool of CT, and the one the dose readout needs beside it — the SD
   inside a uniform organ IS the image noise, so halving the mA and watching the SD rise by
   sqrt(2) is the dose-vs-noise lesson made measurable.

   The ROI is placed in DISPLAY coordinates (what the user dragged on), while the slice data
   is stored with +world-y at the bottom, so rows are flipped on the way in. Pixels outside
   the reconstructed disc are NaN and are not counted. */
export function roiStats(mu, N, muWater, cx, cy, r) {
  let n = 0, s = 0, s2 = 0, mn = Infinity, mx = -Infinity;
  const r2 = r * r;
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(N - 1, Math.ceil(cy + r));
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(N - 1, Math.ceil(cx + r));
  for (let iy = y0; iy <= y1; iy++) {
    const srcY = N - 1 - iy;
    for (let ix = x0; ix <= x1; ix++) {
      const dx = ix + 0.5 - cx, dy = iy + 0.5 - cy;
      if (dx * dx + dy * dy > r2) continue;
      const m = mu[srcY * N + ix];
      if (Number.isNaN(m)) continue;
      const hu = 1000 * (m - muWater) / muWater;
      n++; s += hu; s2 += hu * hu;
      if (hu < mn) mn = hu; if (hu > mx) mx = hu;
    }
  }
  if (!n) return null;
  const mean = s / n;
  const sd = n > 1 ? Math.sqrt(Math.max(0, (s2 - n * mean * mean) / (n - 1))) : 0;
  return { n, mean, sd, min: mn, max: mx };
}
