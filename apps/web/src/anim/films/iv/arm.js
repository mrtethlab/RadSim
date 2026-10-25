/* THE ARM, for the IV film: the app's own upper-extremity (and hand) skin, placed as the IV room
   places it (the rest frame: the mesh in mm, x and y flipped, a tenth of a unit to the mm), the
   sites' veins from data/iv.json painted on a patch laid over its skin, the veins, the artery and
   the nerve as tubes under it for the cutaways, and the tourniquet.

   The room finds the skin from the voxel volume (core/palpation.js skinPoint). The film does not
   download the 38 MB volume: it finds the same skin by casting against the skin mesh, whose
   triangles are binned along the limb so each cast tests only the few hundred near it. Otherwise
   buildGeometry, buildPatch and buildBand here are the room's (src/iv.js), line for line where
   they can be. Units cm; the site's coordinates `a` cm along the limb toward the heart, `l` cm
   across it, on the skin. */
import * as THREE from 'three';
import cfg from '../../../data/iv.json';

const v3 = { add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s], dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; } };
export { v3 };

/* ---------------------------------------------------------------- the skin and its caster */
// the mesh into the rest frame as the room has it in IV mode (app.js applyVoxelMeshTransform:
// flips x and y, 0.1 cm to the mm)
export async function loadSkin(api, url) {
  const g = await api.loadGlb(url);
  g.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    o.castShadow = true; o.receiveShadow = true;
    const vc = !!o.geometry.attributes.color;
    o.material = new THREE.MeshStandardMaterial({ roughness: 0.72, metalness: 0, vertexColors: vc, color: vc ? 0xffffff : 0xd8a080 });
  });
  const wrap = new THREE.Group(); wrap.scale.set(-0.1, -0.1, 0.1); wrap.add(g);
  wrap.updateMatrixWorld(true);
  return { group: wrap, caster: makeCaster(g) };
}
/* Triangles in the rest frame, binned by z (the limb's long axis on both models) into 1 cm bins. */
function makeCaster(g) {
  const tris = [];
  g.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position.array, idx = o.geometry.index?.array;
    const n = idx ? idx.length : p.length / 3;
    for (let i = 0; i < n; i += 3) {
      for (let k = 0; k < 3; k++) {
        const j = idx ? idx[i + k] : i + k;
        tris.push(-p[3 * j] / 10, -p[3 * j + 1] / 10, p[3 * j + 2] / 10);
      }
    }
  });
  const T = new Float32Array(tris), nt = T.length / 9;
  let z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < nt; i++) for (let k = 0; k < 3; k++) { const z = T[i * 9 + k * 3 + 2]; z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const nb = Math.ceil(z1 - z0) + 1, bins = Array.from({ length: nb }, () => []);
  for (let i = 0; i < nt; i++) {
    const a = T[i * 9 + 2], b = T[i * 9 + 5], c = T[i * 9 + 8];
    const lo = Math.floor(Math.min(a, b, c) - z0), hi = Math.floor(Math.max(a, b, c) - z0);
    for (let k = lo; k <= hi; k++) bins[k].push(i);
  }
  const binsI = bins.map((b) => Int32Array.from(b));
  // every crossing of the segment from o along d (unit) up to len: distances, sorted
  function hits(o, d, len = 30) {
    const za = o[2], zb = o[2] + d[2] * len;
    const lo = Math.max(0, Math.floor(Math.min(za, zb) - z0)), hi = Math.min(nb - 1, Math.floor(Math.max(za, zb) - z0));
    const out = [];
    for (let b = lo; b <= hi; b++) {
      for (const i of binsI[b]) {
        // (a triangle in two bins is tested twice: the same distance, dropped below)
        const q = i * 9;
        const e1x = T[q + 3] - T[q], e1y = T[q + 4] - T[q + 1], e1z = T[q + 5] - T[q + 2];
        const e2x = T[q + 6] - T[q], e2y = T[q + 7] - T[q + 1], e2z = T[q + 8] - T[q + 2];
        const px_ = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px_ + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-9) continue;
        const inv = 1 / det, sx = o[0] - T[q], sy = o[1] - T[q + 1], sz = o[2] - T[q + 2];
        const u = (sx * px_ + sy * py + sz * pz) * inv; if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > 1e-4 && t < len) out.push(t);
      }
    }
    out.sort((a, b) => a - b);
    const u = [];
    for (const t of out) if (!u.length || t - u[u.length - 1] > 1e-4) u.push(t);
    return u;
  }
  /* The room's skinPoint, on the mesh: from a point inside the body outward along dir, the skin
     where it leaves; from a point outside (an odd count of crossings tells), where it started. */
  function skinPoint(o, d) {
    const h = hits(o, d, 30);
    if (h.length % 2 === 0) return o.slice();
    return [o[0] + d[0] * h[0], o[1] + d[1] * h[0], o[2] + d[2] * h[0]];
  }
  return { hits, skinPoint };
}

/* ---------------------------------------------------------------- a site's geometry (iv.js buildGeometry) */
export function buildGeometry(siteKey, caster, C = [0, 0, 0]) {
  const site = cfg.sites[siteKey];
  const fr = site.frame;
  const O = fr.origin, Ax = v3.norm(fr.along);
  let L = v3.norm(v3.sub(fr.lateral, v3.mul(Ax, v3.dot(fr.lateral, Ax))));
  let N = v3.norm(v3.cross(Ax, L));
  if (v3.dot(N, fr.outward) < 0) N = v3.mul(N, -1);
  L = v3.norm(v3.cross(N, Ax));
  if (v3.dot(L, fr.lateral) < 0) L = v3.mul(L, -1);
  const wrap = site.subject !== 'hand';
  const rCache = new Map();
  const centre = (a) => v3.add(O, v3.mul(Ax, a));
  const radiusAt = (a) => {
    const k = Math.round(a * 2);
    if (!rCache.has(k)) {
      const c = centre(k / 2), s = caster.skinPoint(c, N);
      rCache.set(k, Math.max(1.2, Math.hypot(...v3.sub(s, c))));
    }
    return rCache.get(k);
  };
  const restAt = (a, l) => {
    if (wrap) {
      const c = centre(a), phi = l / radiusAt(a);
      const dir = v3.add(v3.mul(N, Math.cos(phi)), v3.mul(L, Math.sin(phi)));
      return caster.skinPoint(c, dir);
    }
    const start = v3.add(v3.add(O, v3.mul(Ax, a)), v3.add(v3.mul(L, l), v3.mul(N, -1.5)));
    return caster.skinPoint(start, N);
  };
  // (the film's world is the rest frame, moved by C: the patient is not turned)
  const toWorld = (p) => [p[0] + C[0], p[1] + C[1], p[2] + C[2]];
  const fromWorld = (w) => [w[0] - C[0], w[1] - C[1], w[2] - C[2]];
  const wCache = new Map();
  const worldAt = (a, l) => {
    const k = a.toFixed(3) + ',' + l.toFixed(3);
    let w = wCache.get(k);
    if (!w) { w = toWorld(restAt(a, l)); if (wCache.size > 20000) wCache.clear(); wCache.set(k, w); }
    return w;
  };
  const startAt = (a, l) => (wrap ? centre(a) : v3.add(v3.add(O, v3.mul(Ax, a)), v3.add(v3.mul(L, l), v3.mul(N, -1.5))));
  const foundAt = (a, l) => Math.hypot(...v3.sub(restAt(a, l), startAt(a, l))) > 0.05;
  const paramOf = (rest) => {
    const a = v3.dot(v3.sub(rest, O), Ax);
    if (!wrap) return { a, l: v3.dot(v3.sub(rest, O), L) };
    const v = v3.sub(rest, centre(a));
    return { a, l: Math.atan2(v3.dot(v, L), v3.dot(v, N)) * radiusAt(a) };
  };
  const normalAt = (a, l) => {
    const p0 = worldAt(a, l), pa = worldAt(a + 0.3, l), pl = worldAt(a, l + 0.3);
    let n = v3.norm(v3.cross(v3.sub(pa, p0), v3.sub(pl, p0)));
    const out = v3.norm(v3.sub(p0, toWorld(centre(a))));
    if (v3.dot(n, out) < 0) n = v3.mul(n, -1);
    return n;
  };
  const dens = (path) => {
    const pts = [];
    for (let i = 0; i < path.length - 1; i++) {
      const [a0, l0] = path[i], [a1, l1] = path[i + 1], n = Math.max(1, Math.ceil(Math.hypot(a1 - a0, l1 - l0) / 0.2));
      for (let k = 0; k < n; k++) pts.push([a0 + (a1 - a0) * k / n, l0 + (l1 - l0) * k / n]);
    }
    pts.push(path[path.length - 1]);
    return pts;
  };
  const feats = [
    ...site.veins.map((v) => ({ ...v, kind: 'vein', pts: dens(v.path) })),
    ...(site.distractors || []).map((d) => ({ ...d, pts: dens(d.path) })),
  ];
  return { site, siteKey, O, Ax, L, N, wrap, restAt, worldAt, foundAt, toWorld, fromWorld, paramOf, normalAt, feats, radiusAt, dens, centre };
}
// distance from (a, l) to a feature's path, where on it, its direction there (iv.js nearest)
export function nearest(f, a, l) {
  let best = { d: Infinity, i: 0 };
  for (let i = 0; i < f.pts.length; i++) {
    const d = Math.hypot(f.pts[i][0] - a, f.pts[i][1] - l);
    if (d < best.d) best = { d, i };
  }
  const i0 = Math.max(0, best.i - 1), i1 = Math.min(f.pts.length - 1, best.i + 1);
  const t = [f.pts[i1][0] - f.pts[i0][0], f.pts[i1][1] - f.pts[i0][1]], tl = Math.hypot(...t) || 1;
  const tan = [t[0] / tl, t[1] / tl];
  const dp = [a - f.pts[best.i][0], l - f.pts[best.i][1]];
  return { dist: best.d, at: f.pts[best.i], tan, across: -dp[0] * tan[1] + dp[1] * tan[0], i: best.i };
}

/* ---------------------------------------------------------------- the patch (iv.js buildPatch) */
export const PX_PER_CM = 48;
export function buildPatch(G, parent, { lift = 0.06, step = 0.4 } = {}) {
  const pr = G.site.patch, a0 = pr.along[0], a1 = pr.along[1], l0 = pr.lateral[0], l1 = pr.lateral[1];
  const na = Math.ceil((a1 - a0) / step), nl = Math.ceil((l1 - l0) / step);
  const pos = [], uv = [], idx = [], ok = [], grid = [];
  for (let i = 0; i <= na; i++) for (let j = 0; j <= nl; j++) {
    const a = a0 + (a1 - a0) * i / na, l = l0 + (l1 - l0) * j / nl;
    grid.push({ w: G.worldAt(a, l), n: G.normalAt(a, l), a, l, found: G.foundAt(a, l) });
  }
  // (the skin here is the mesh itself, not a voxel staircase: it needs no smoothing, and the
  // patch rides just off it)
  for (const g of grid) {
    pos.push(g.w[0] + g.n[0] * lift, g.w[1] + g.n[1] * lift, g.w[2] + g.n[2] * lift);
    uv.push((g.l - l0) / (l1 - l0), (g.a - a0) / (a1 - a0));
    ok.push(1, 1, 1, g.found ? 1 : 0);
  }
  for (let i = 0; i < na; i++) for (let j = 0; j < nl; j++) {
    const k = i * (nl + 1) + j;
    idx.push(k, k + nl + 1, k + 1, k + 1, k + nl + 1, k + nl + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(ok, 4));
  geo.setIndex(idx); geo.computeVertexNormals();
  const cv = document.createElement('canvas');
  cv.width = Math.round((l1 - l0) * PX_PER_CM); cv.height = Math.round((a1 - a0) * PX_PER_CM);
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, vertexColors: true, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  m.renderOrder = 5;
  parent.add(m);
  return { mesh: m, cv, g: cv.getContext('2d'), tex, a0, a1, l0, l1, na, nl, grid,
    toPx: (a, l) => [(l - l0) * PX_PER_CM, (a - a0) * PX_PER_CM] };
}

/* The skin's paint: the veins seen through it (fuller with the tourniquet), the mark, the wet
   prep, the dressing, a bruise, an infiltration. The room's paint(), at difficulty 0 (every vein
   shown), redrawn only when what it shows changes. */
export function makePainter(G, P) {
  const veinCache = new Map();
  function veinLayer(fill) {
    const fq = Math.round(fill * 10) / 10;
    if (veinCache.has(fq)) return veinCache.get(fq);
    const V = document.createElement('canvas'); V.width = P.cv.width; V.height = P.cv.height;
    const v = V.getContext('2d');
    v.strokeStyle = 'rgb(74,88,136)'; v.lineCap = 'round'; v.lineJoin = 'round';
    for (const f of G.feats) {
      if (f.kind !== 'vein') continue;
      v.lineWidth = Math.max(2, f.radius * 2 * (1 + 0.3 * fq) / 10 * PX_PER_CM);
      v.globalAlpha = Math.min(1, f.visibility * 1.1);
      v.beginPath();
      f.pts.forEach((q, i) => { const [x, y] = P.toPx(q[0], q[1]); i ? v.lineTo(x, y) : v.moveTo(x, y); });
      v.stroke();
    }
    const O = document.createElement('canvas'); O.width = V.width; O.height = V.height;
    const og = O.getContext('2d');
    const base = 0.32 + 0.3 * fq;
    og.filter = 'blur(12px)'; og.globalAlpha = 0.85 * base / 0.62; og.drawImage(V, 0, 0);
    og.filter = 'blur(5px)'; og.globalAlpha = 0.55 * base / 0.62; og.drawImage(V, 0, 0);
    veinCache.set(fq, O);
    return O;
  }
  let key = '';
  /* s: { fill, mark: {a, l} | null, markA (0..1), wet (0..1, the sheen), wetR (cm), dressing:
     { a, l, ang, k (0..1 laid), edges } | null, bruise (0..1), swell (0..1), swellAt: {a, l},
     guide: [[a, l], ...] (a dashed line along the vein: where the catheter will lie) } */
  function paint(s) {
    const k = JSON.stringify([Math.round(s.fill * 10), s.mark, Math.round((s.markA ?? 1) * 10), Math.round((s.wet || 0) * 20), s.wetR,
      s.dressing && [s.dressing.a, s.dressing.l, Math.round(s.dressing.k * 20), s.dressing.edges], Math.round((s.bruise || 0) * 30),
      Math.round((s.swell || 0) * 30), s.guide && s.guide.length, Math.round((s.guideA || 0) * 10)]);
    if (k === key) return;
    key = k;
    const { g, cv, tex } = P;
    g.clearRect(0, 0, cv.width, cv.height);
    g.drawImage(veinLayer(s.fill), 0, 0);
    if (s.guide && s.guideA > 0) {
      g.save(); g.globalAlpha = s.guideA; g.strokeStyle = 'rgba(255,236,39,0.9)'; g.lineWidth = 4; g.setLineDash([10, 7]);
      g.beginPath(); s.guide.forEach((q, i) => { const [x, y] = P.toPx(q[0], q[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); g.restore();
    }
    if (s.mark) {
      const [mx, my] = P.toPx(s.mark.a, s.mark.l);
      if (s.wet > 0) {
        const r = (s.wetR || 2.5) * PX_PER_CM;
        g.save(); g.filter = 'blur(6px)'; g.globalAlpha = 0.42 * s.wet; g.fillStyle = '#d0e4ff';
        g.beginPath(); g.arc(mx, my, r, 0, 2 * Math.PI); g.fill(); g.restore();
      }
      if (s.bruise > 0) {
        const r = (0.5 + 2.2 * s.bruise) * PX_PER_CM, gr = g.createRadialGradient(mx, my, 0, mx, my, r);
        gr.addColorStop(0, `rgba(70,20,60,${0.8 * s.bruise})`); gr.addColorStop(1, 'rgba(70,20,60,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(mx, my, r, 0, 2 * Math.PI); g.fill();
      }
      g.globalAlpha = s.markA ?? 1;
      g.fillStyle = '#7a3fd0'; g.beginPath(); g.arc(mx, my, 5, 0, 2 * Math.PI); g.fill();
      g.globalAlpha = 1;
      if (s.dressing && s.dressing.k > 0) drawDressing(g, P, s.dressing);
      // an infiltration: a pale, tight swelling over the tip (seen through the dressing's film),
      // its rim shadowed where it rises from the skin
      if (s.swell > 0 && s.swellAt) {
        const [tx, ty] = P.toPx(s.swellAt.a, s.swellAt.l), r = (0.7 + 1.9 * s.swell) * PX_PER_CM, k = Math.min(1, s.swell * 1.4);
        const sh = g.createRadialGradient(tx + r * 0.12, ty + r * 0.12, r * 0.6, tx, ty, r * 1.08);
        sh.addColorStop(0, 'rgba(90,60,50,0)'); sh.addColorStop(0.7, `rgba(90,60,50,${0.35 * k})`); sh.addColorStop(1, 'rgba(90,60,50,0)');
        g.fillStyle = sh; g.beginPath(); g.arc(tx, ty, r * 1.1, 0, 2 * Math.PI); g.fill();
        const gr = g.createRadialGradient(tx - r * 0.2, ty - r * 0.2, 0, tx, ty, r);
        gr.addColorStop(0, `rgba(255,255,252,${0.85 * k})`); gr.addColorStop(0.6, `rgba(250,240,232,${0.55 * k})`); gr.addColorStop(1, 'rgba(250,240,232,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(tx, ty, r, 0, 2 * Math.PI); g.fill();
      }
    }
    tex.needsUpdate = true;
  }
  return { paint };
}
// the Tegaderm I.V. (iv.js paint): a cloth border, a clear window over the site, a notch at the
// hub's end; local x along the vein toward the heart
function drawDressing(g, P, d) {
  const [dx, dy] = P.toPx(d.a, d.l);
  g.save(); g.translate(dx, dy); g.rotate(d.ang); g.globalAlpha = d.k;
  const C = PX_PER_CM, X = 3.5 * C, Y = 3 * C, r = 0.6 * C, nx = -1.7 * C, ny = 0.3 * C;
  const rr = (x0, y0, x1, y1, k) => { g.moveTo(x0 + k, y0); g.arcTo(x1, y0, x1, y1, k); g.arcTo(x1, y1, x0, y1, k); g.arcTo(x0, y1, x0, y0, k); g.arcTo(x0, y0, x1, y0, k); g.closePath(); };
  g.beginPath();
  g.moveTo(-X, -ny); g.lineTo(nx, -ny); g.lineTo(nx, ny); g.lineTo(-X, ny);
  g.arcTo(-X, Y, 0, Y, r); g.arcTo(X, Y, X, 0, r); g.arcTo(X, -Y, 0, -Y, r); g.arcTo(-X, -Y, -X, -ny, r); g.closePath();
  rr(-1.3 * C, -2 * C, 2.6 * C, 2 * C, 0.4 * C);
  g.fillStyle = 'rgba(244,238,222,0.88)'; g.fill('evenodd');
  g.beginPath(); rr(-1.3 * C, -2 * C, 2.6 * C, 2 * C, 0.4 * C);
  g.fillStyle = 'rgba(232,243,252,0.22)'; g.fill();
  g.strokeStyle = 'rgba(140,180,215,0.7)'; g.lineWidth = 2; g.stroke();
  g.strokeStyle = 'rgba(205,196,172,0.45)'; g.lineWidth = 1;
  for (let x = -X + 6; x < X; x += 7) { g.beginPath(); g.moveTo(x, -Y + 4); g.lineTo(x, -2 * C - 4); g.moveTo(x, 2 * C + 4); g.lineTo(x, Y - 4); g.stroke(); }
  g.lineWidth = 5;
  (d.edges || [0, 0, 0, 0]).forEach((on, i) => {
    g.strokeStyle = on ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.3)';
    g.beginPath();
    if (i === 0) { g.moveTo(X, -Y + r); g.lineTo(X, Y - r); }
    if (i === 1) { g.moveTo(-X + r, -Y); g.lineTo(X - r, -Y); }
    if (i === 2) { g.moveTo(-X, -Y + r); g.lineTo(-X, -ny); g.moveTo(-X, ny); g.lineTo(-X, Y - r); }
    if (i === 3) { g.moveTo(-X + r, Y); g.lineTo(X - r, Y); }
    g.stroke();
  });
  g.restore();
}

/* ---------------------------------------------------------------- under the skin, for the cutaways */
/* A feature as a tube at its depth: veins blue (their valves as a swelling), the artery red, a
   nerve yellow. depth: of the vessel's top (iv.json), so the centre is depth + wall + radius. */
export function featureTube(G, f, { color, radius, depthMM, lumen = false } = {}) {
  const r = (radius ?? f.radius) / 10, dc = ((depthMM ?? f.depth) + 0.4) / 10 + r;
  const pts = f.pts.map(([a, l]) => {
    const w = G.worldAt(a, l), n = G.normalAt(a, l);
    return new THREE.Vector3(w[0] - n[0] * dc, w[1] - n[1] * dc, w[2] - n[2] * dc);
  });
  const curve = new THREE.CatmullRomCurve3(pts);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.05, emissive: color, emissiveIntensity: 0.18 });
  const m = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, pts.length * 2), r, 14, false), mat);
  m.userData.curve = curve; m.userData.r = r;
  void lumen;
  return m;
}

/* ---------------------------------------------------------------- the tourniquet (iv.js buildBand) */
// a 2.5 cm latex strip round the limb at aCm, and its knot: the loop and the two tails
export function buildBand(G, caster, aCm, mat) {
  const ring = [], N = 48, w = 1.25;
  const c = v3.add(G.O, v3.mul(G.Ax, aCm));
  for (let i = 0; i <= N; i++) {
    const phi = (i / N) * 2 * Math.PI;
    const dir = v3.add(v3.mul(G.N, Math.cos(phi)), v3.mul(G.L, Math.sin(phi)));
    const s = caster.skinPoint(c, dir);
    ring.push(v3.add(s, v3.mul(dir, 0.16)));
  }
  const pos = [], idx = [];
  for (let i = 0; i <= N; i++) for (const off of [-w, w]) pos.push(...G.toWorld(v3.add(ring[i], v3.mul(G.Ax, off))));
  for (let i = 0; i < N; i++) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx); geo.computeVertexNormals();
  const band = new THREE.Group();
  band.add(new THREE.Mesh(geo, mat));
  // the knot on the lateral side, up: a tucked loop and two tails lying back along the arm
  const k0 = Math.round(N * 0.12), top = G.toWorld(ring[k0]);
  const dir = v3.norm(v3.add(v3.mul(G.N, Math.cos(k0 / N * 2 * Math.PI)), v3.mul(G.L, Math.sin(k0 / N * 2 * Math.PI))));
  // a tail: a flat ribbon of the same strip, lying back along the arm, arched off the skin
  const across = v3.norm(v3.cross(dir, G.Ax));
  const tail = (sideA, len, lift, wd) => {
    const pos2 = [], idx2 = [], n = 14;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const c0 = v3.add(v3.add(top, v3.mul(G.Ax, sideA * (0.2 + u * len))), v3.mul(dir, 0.18 + lift * Math.sin(u * Math.PI * 0.8) + 0.25 * u));
      const w = wd * (1 - 0.15 * u);
      pos2.push(...v3.add(c0, v3.mul(across, -w)), ...v3.add(c0, v3.mul(across, w)));
      if (i < n) { const k = i * 2; idx2.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.Float32BufferAttribute(pos2, 3));
    g2.setIndex(idx2); g2.computeVertexNormals();
    return new THREE.Mesh(g2, mat);
  };
  band.add(tail(-1, 7, 0.6, 1.1), tail(1, 4, 0.9, 1.0));
  band.userData.anchor = top;
  return band;
}
