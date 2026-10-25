/* CT FILM: small things the chapters share: the readout panel, the frame's turning, the 8-bit
   panels' frames, the photons of the fan beam. */
import * as THREE from 'three';
import { keVColor, tungstenSpectrum } from '../../kit/micro.js';
import { rng } from '../../pixel.js';
import { F, SID, HALF } from './rig.js';

/* Photons from the focal spot to the detector face, in the rotating frame's own axes (so they turn
   with it), born at `rate` a second, flying at v cm/s (shown slowed), across the fan and through
   the beam's width at the isocentre. Only those born within one flight time are walked: the
   stream never runs dry however long a step is held. dim(fanAngle, keV) may recolour one. */
export function fanStream(api, S) {
  const { px } = api, V = new THREE.Vector3();
  const rp = (x, y, z) => api.toPx(S.rot.localToWorld(V.set(x, y, z)));
  const spec = tungstenSpectrum(120, 0.6);
  const sampleE = (r) => { for (let k = 0; k < 60; k++) { const E = 20 + r() * 100; if (r() < spec(E)) return E; } return 60; };
  return function fanPhotons(t, { rate = 140, wIso = 4, v = 160, a = 1, seed = 1, dim = null } = {}) {
    const life = SID / v + 0.1;
    const k0 = Math.max(0, Math.ceil((t - life) * rate)), k1 = Math.floor(t * rate);
    for (let k = k0; k <= k1; k++) {
      const r = rng(seed * 100000 + k), age = t - k / rate;
      const ph = (r() * 2 - 1) * HALF, zf = (r() - 0.5) * wIso, E = sampleE(r);
      const tx = -SID * Math.sin(ph), ty = F - SID * Math.cos(ph), tz = zf * SID / F;
      const L = Math.hypot(tx, ty - F, tz), d = Math.min(age * v, L), u = d / L;
      const [x, y, f] = rp(tx * u, F + (ty - F) * u, tz * u);
      if (!f) continue;
      const [x2, y2] = rp(tx * (u + 0.02), F + (ty - F) * (u + 0.02), tz * (u + 0.02));
      if (d >= L) { if (age * v - L < 6) px.rect(x - 1, y - 1, 2, 2, 'yellow', 0.7 * a); continue; }
      px.photon(x, y, x2 - x, y2 - y, 4, dim ? dim(ph, E) : keVColor(E), a, t * 20 + k);
    }
  };
}

/* A panel of readouts (label, value, colour), top right unless placed; registered as kept out. */
export function hud(api, rows, { x = null, y = 4, w = 52 } = {}) {
  const { px } = api;
  const h = 4 + rows.length * 9, X = x == null ? px.W - w - 4 : x;
  px.rect(X, y, w, h, 'ink', 0.85); px.frame(X, y, w, h, 'dkgrey');
  api.keepOut([X, y, w, h]);
  rows.forEach(([lab, val, c], i) => {
    px.text(lab, X + 3, y + 3 + i * 9, 'mid');
    px.text(val, X + w - 3, y + 3 + i * 9, c || 'yellow', 1, 1, 'right');
  });
  return [X, y, w, h];
}
// a dark box with a frame (a panel the 8-bit layer draws in), kept out of the caption's way
export function box(api, x, y, w, h, a = 0.88) {
  api.px.rect(x, y, w, h, 'ink', a); api.px.frame(x, y, w, h, 'dkgrey');
  api.keepOut([x, y, w, h]);
}
/* The frame's angle at time t for a rotation period P (seconds, as shown: the real 0.3-0.5 s
   would strobe), spinning up over `up` seconds from rest at t0. */
export function spinAngle(t, P, t0 = 0, up = 0) {
  const w = (Math.PI * 2) / P;
  if (t < t0) return 0;
  if (up > 0 && t < t0 + up) return 0.5 * w * (t - t0) ** 2 / up;
  return 0.5 * w * up + w * (t - t0 - up);
}
// a pixel point on a screen-space polyline at fraction f
export function along(pts, f) {
  let L = 0; const seg = [];
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); L += d; }
  let s = f * L;
  for (let i = 0; i < seg.length; i++) {
    if (s <= seg[i]) { const k = s / (seg[i] || 1); return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k]; }
    s -= seg[i];
  }
  return pts[pts.length - 1];
}
