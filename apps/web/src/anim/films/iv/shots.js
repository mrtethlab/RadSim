/* The IV film's camera, in the site's own terms. Every shot of the site keeps the same sense:
   toward the heart (the vein frame's X) to the right of the screen, the skin's outward normal up
   (or, looking straight down, toward the patient's thumb side up). Each returns [pos, look, fov]
   for a step's cam keys. */
import { v3 } from './arm.js';

export function shots(api, S) {
  const F = S.F, site = S.siteW, n = F.n, X = F.X;
  // across the arm, the side that puts X on the right when looking from it toward the site
  const Sd = v3.norm(v3.cross(X, n));
  const at = (along = 0, across = 0) => v3.add(site, v3.add(v3.mul(X, along), v3.mul(Sd, across)));
  return {
    Sd,
    // from the side, elev degrees above the skin, dist cm away, aimed `along` cm up the vein
    side(dist, elev = 30, along = 0, fov = 34) {
      const e = elev * Math.PI / 180, tgt = at(along);
      return [v3.add(tgt, v3.add(v3.mul(Sd, Math.cos(e) * dist), v3.mul(n, Math.sin(e) * dist))), tgt, fov];
    },
    // straight down onto the skin (set camera.up to topUp())
    top(dist, along = 0, across = 0, fov = 34) {
      const tgt = at(along, across);
      return [v3.add(tgt, v3.add(v3.mul(n, dist), v3.mul(Sd, dist * 0.02))), tgt, fov];
    },
    // (looking down, the limb's own axis to the right: the heart's way, whatever the vein's slant)
    topUp: () => { const A = S.G.Ax, At = v3.norm(v3.sub(A, v3.mul(n, v3.dot(A, n)))); return v3.norm(v3.cross(n, At)); },
    // the same along the vein: X to the right
    topUpVein: () => v3.mul(Sd, -1),
    // down onto any point of a site (a, l), the camera's up from topUp
    topAt(G, a, l, dist) {
      const w = G.worldAt(a, l), nn = G.normalAt(a, l);
      return [v3.add(w, v3.add(v3.mul(nn, dist), v3.mul(Sd, dist * 0.02))), w];
    },
    // along the arm from the hand's end (distal, z cm from the site), h cm above the skin
    alongArm(z, h, fov = 34) {
      const Ax = S.G.Ax;
      return [v3.add(site, v3.add(v3.mul(Ax, z), v3.mul(n, h))), v3.add(site, v3.mul(n, -1.2)), fov];
    },
    // the back of the hand from above, the wrist (toward the heart) to the right
    handCam(G3, t) {
      if (!G3) return { pos: v3.add(site, [0, 40, 0]), look: site, fov: 34 };
      const tgt = G3.worldAt(1.4, -0.6), nn = G3.normalAt(1.4, -0.6), d = 30 - 6 * Math.min(1, t / 7);
      return { pos: v3.add(tgt, v3.mul(nn, d)), look: tgt, fov: 34 };
    },
    handUp(G3) { const nn = G3.normalAt(1.4, -0.6); return v3.norm(v3.cross(nn, G3.Ax)); },
    // brackets round a set of site points (a, l)
    markRegion(G, pts, color, t) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [a, l] of pts) {
        const [x, y] = api.toPx(G.worldAt(a, l));
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      api.mark([x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4], color, t);
      return [x0, y0, x1 - x0, y1 - y0];
    },
    // brackets round world points
    markPts(pts, color, t, pad = 2) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) {
        const [x, y] = api.toPx(p);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      const b = [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
      api.mark(b, color, t);
      return b;
    },
    at,
    // a point d cm under the mark (the vein's middle at 0.69)
    veinC: (d, along = 0) => v3.sub(at(along), v3.mul(n, d)),
  };
}
