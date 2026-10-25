/* Streams of particles in the 3D scene, drawn as 8-bit sprites where they are on screen: photons
   sprayed from a focal spot, electrons across a gap. A particle is born at t0, flies straight at
   speed v (cm/s) along dir from its origin, and ends at distance `end` (its fate decided at
   birth: absorbed somewhere, or out of the scene). Its position is a function of the time alone. */
import { rng } from '../pixel.js';

export function makeParticles(n, seed, born) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) out.push(born(i, r));
  return out;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
export const norm = (v) => { const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };

// a random direction in a cone round axis (half-angle in radians), seeded
export function coneDir(r, axis, half) {
  const ax = norm(axis);
  const tmp = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm([ax[1] * tmp[2] - ax[2] * tmp[1], ax[2] * tmp[0] - ax[0] * tmp[2], ax[0] * tmp[1] - ax[1] * tmp[0]]);
  const w = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
  const c = 1 - r() * (1 - Math.cos(half)), s = Math.sqrt(1 - c * c), phi = r() * Math.PI * 2;
  return norm(add(add(ax.map((x) => x * c), u, s * Math.cos(phi)), w, s * Math.sin(phi)));
}

/* Where particle p is at time t: null before birth or after its end (+ linger seconds of its end
   flash). Returns { pos, dir, age, done } (done: it has reached its end, still lingering). */
export function at(p, t, linger = 0.15) {
  const age = t - p.t0;
  if (age < 0) return null;
  const d = age * p.v;
  if (d >= p.end) {
    if (age - p.end / p.v > linger) return null;
    return { pos: add(p.from, p.dir, p.end), dir: p.dir, age, done: true };
  }
  return { pos: add(p.from, p.dir, d), dir: p.dir, age, done: false };
}

/* Draw a set of particles on the 8-bit layer. style(p, state) -> { kind: 'photon'|'electron'|'dot',
   color, a } or null to skip. A photon is drawn as a squiggle along its projected direction; an
   ending particle as a small flash. */
export function drawParticles(api, list, t, style, { linger = 0.15, tail = 5 } = {}) {
  const px = api.px;
  for (const p of list) {
    const s = at(p, t, linger);
    if (!s) continue;
    const st = style(p, s);
    if (!st) continue;
    const [x, y, front] = api.toPx(s.pos);
    if (!front || x < -4 || y < -4 || x > px.W + 4 || y > px.H + 4) continue;
    if (s.done) {
      if (st.flash !== false) {
        const k = 1 - (s.age - p.end / p.v) / linger;
        px.rect(x - 1, y - 1, 3, 3, st.flashColor || st.color, k * 0.9);
      }
      continue;
    }
    if (st.kind === 'electron') {
      px.rect(x - 1, y, 3, 1, st.color, 0.6 * (st.a ?? 1)); px.rect(x, y - 1, 1, 3, st.color, 0.6 * (st.a ?? 1));
      px.px(x, y, 'white', st.a ?? 1);
    } else if (st.kind === 'dot') {
      px.px(x, y, st.color, st.a ?? 1);
    } else {
      const [x2, y2] = api.toPx(add(s.pos, s.dir, 0.5));
      px.photon(x, y, x2 - x, y2 - y, tail, st.color, st.a ?? 1, t * 20 + p.i);
    }
  }
}

/* The distance along a ray (from, dir) to a horizontal plane y = Y, or Infinity. */
export function toPlaneY(from, dir, Y) {
  if (Math.abs(dir[1]) < 1e-6) return Infinity;
  const d = (Y - from[1]) / dir[1];
  return d > 0 ? d : Infinity;
}
export { sub, add };
