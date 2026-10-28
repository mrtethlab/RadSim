/* X-RAY FILM, chapter 2: the beam in the patient. Divergence and the inverse square; a field of
   tissue (fat, soft tissue, bone) where each photon is absorbed (photoelectric), scattered
   (Compton, coherent) or transmitted, by the app's own attenuation coefficients; what kV does to
   that and to contrast; the geometry of magnification, elongation and foreshortening, cast by real
   projection; scatter, the grid, its ratio and its four errors; barium, and double contrast. */
import * as THREE from 'three';
import { atom, electron, keVColor, tungstenSpectrum, curvePlot } from '../../kit/micro.js';
import { std, mesh, rayLines, setOpacity, beamCone } from '../../kit/stage.js';
import { Materials } from '../../../core/materials.js';
import { capMeshFrame } from '../capFrame.js';

const SID = 100;

export async function patient(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const scene = api.scene;

  // ================================================================ the projection set (3D)
  const geo = new THREE.Group(); scene.add(geo); S.sets.geo = geo;
  const focal = mesh(new THREE.SphereGeometry(0.9, 20, 14), new THREE.MeshBasicMaterial({ color: 0xfff1b0 }), 0, SID, 0);
  geo.add(focal);
  const detMat = std(0x10161c, 0.9, 0.0);
  const det = mesh(new THREE.BoxGeometry(60, 1, 60), detMat, 0, -0.5, 0); det.receiveShadow = true; geo.add(det);
  const gridLines = new THREE.GridHelper(60, 12, 0x2b3a48, 0x1c2630); gridLines.position.y = 0.02; geo.add(gridLines);
  const objMat = std(0xe8dcc0, 0.45, 0.05, { emissive: 0x2a2418 });
  const ball = mesh(new THREE.SphereGeometry(5, 40, 28), objMat); geo.add(ball);
  const disc = mesh(new THREE.CylinderGeometry(6, 6, 1.2, 48), objMat); geo.add(disc);
  const rod = mesh(new THREE.CylinderGeometry(1.6, 1.6, 26, 32), objMat); geo.add(rod);
  // the shadow: a fan of triangles over the projected outline's convex hull, just above the plate
  const MAXH = 160;
  const shGeo = new THREE.BufferGeometry();
  shGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((MAXH + 2) * 3 * 3), 3));
  const shadow = new THREE.Mesh(shGeo, new THREE.MeshBasicMaterial({ color: 0xd6e2ec, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
  shadow.frustumCulled = false; geo.add(shadow);
  // a second shadow, for two objects at once (a part over another, cleared by angling)
  const shGeo2 = new THREE.BufferGeometry();
  shGeo2.setAttribute('position', new THREE.BufferAttribute(new Float32Array((MAXH + 2) * 3 * 3), 3));
  const shadow2 = new THREE.Mesh(shGeo2, new THREE.MeshBasicMaterial({ color: 0x9fd8a8, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  shadow2.frustumCulled = false; shadow2.visible = false; geo.add(shadow2);
  const trueOutline = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x46d17f, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false }));
  const rays = rayLines(0xffd166, 0.55, 40); geo.add(rays);
  const cone = beamCone(0x9d7bff, 0.08); geo.add(cone);
  void trueOutline;
  // project points of a convex object from the focal spot onto y = 0.05; return the hull (x, z)
  function castShadow(obj, src, G = shGeo, yy = 0.06) {
    obj.updateMatrixWorld(true);
    const pos = obj.geometry.attributes.position, v = new THREE.Vector3(), pts = [];
    const step = Math.max(1, Math.floor(pos.count / 600));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
      const k = src[1] / (src[1] - v.y);
      pts.push([src[0] + (v.x - src[0]) * k, src[2] + (v.z - src[2]) * k, v.x, v.y, v.z]);
    }
    // monotone chain hull in (x, z)
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], hi = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
    const hull = lo.slice(0, -1).concat(hi.slice(0, -1));
    // thin it to MAXH points
    const out = [];
    const st = Math.max(1, Math.ceil(hull.length / MAXH));
    for (let i = 0; i < hull.length; i += st) out.push(hull[i]);
    const a = G.attributes.position.array;
    let cx = 0, cz = 0; out.forEach((p) => { cx += p[0]; cz += p[1]; }); cx /= out.length; cz /= out.length;
    let n = 0;
    for (let i = 0; i < out.length; i++) {
      const p = out[i], q = out[(i + 1) % out.length];
      a.set([cx, yy, cz, p[0], yy, p[1], q[0], yy, q[1]], n * 9); n++;
    }
    G.setDrawRange(0, n * 3);
    G.attributes.position.needsUpdate = true;
    return out;
  }
  // a shadow's box on screen (8-bit pixels), so the caption keeps off it
  const hullBox = (hull, pad = 4) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of hull) { const [x, y] = api.toPx([q[0], 0.06, q[1]]); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
  };
  // rays from the focal spot past a few hull points to the plate
  function drawRays(hull, src, every = 8) {
    const pairs = [];
    for (let i = 0; i < hull.length; i += every) pairs.push([src, [hull[i][0], 0.06, hull[i][1]]]);
    rays.userData.set(pairs);
  }
  // an extent of the hull along x (the shadow's width) and z
  const extent = (hull) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of hull) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    return [x1 - x0, z1 - z0];
  };

  // ================================================================ the abdomen set (3D)
  const abdo = new THREE.Group(); scene.add(abdo); S.sets.abdo = abdo;
  const gi = {};
  const giMat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, metalness: 0, emissive: 0x000000 });
  const abdoBody = new THREE.Group(); abdo.add(abdoBody);
  // (the model's frame as is: its long axis along z, lying on the table)
  const loadAbdo = Promise.all([
    api.loadGlb('models/chestabdopelvis/chestabdopelvis_skin.glb').catch(() => null),
    api.loadGlb('models/chestabdopelvis/chestabdopelvis_bone.glb').catch(() => null),
    api.loadGlb('models/chestabdopelvis/chestabdopelvis_gi.glb').catch(() => null),
  ]).then(([skin, bone, gut]) => {
    // (the meshes ship without normals, as the app finds them: app.js computes them on load)
    const add = (g, f) => { if (!g) return; capMeshFrame(g); g.scale.setScalar(0.1); g.traverse((o) => { if (o.isMesh) { if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); f(o); } }); abdoBody.add(g); };
    add(skin, (o) => { o.material = new THREE.MeshStandardMaterial({ color: 0xd8a080, transparent: true, opacity: 0.16, depthWrite: false, roughness: 0.6, side: THREE.DoubleSide }); });
    add(bone, (o) => { o.material = std(0xe8e0c8, 0.5, 0.05); });
    add(gut, (o) => {
      const part = o.name || o.parent?.name;
      o.material = giMat(0xb98a62);
      gi[part] = o;
    });
  });
  await loadAbdo;

  // ================================================================ the tissue field (8-bit)
  // three columns, top to bottom (cm): fat; soft tissue; soft tissue with a bone in it
  const COLS = [
    { name: 'fat', layers: [['fat', 10]] },
    { name: 'soft', layers: [['soft', 10]] },
    { name: 'bone', layers: [['soft', 4], ['bone', 2], ['soft', 4]] },
  ];
  // mu (cm^-1): fat about 0.9 of soft tissue's, bone from the app's table
  const mu = (m, E) => (m === 'fat' ? 0.9 * Materials.mu('soft', E) : m === 'air' ? 0.0013 * Materials.mu('soft', E) : Materials.mu(m, E));
  // the share of interactions that are photoelectric, by material and energy (crossover with
  // Compton near 25 keV in soft tissue, 35 keV in bone); coherent a few percent
  const fPE = (m, E) => 1 / (1 + (E / (m === 'bone' ? 36 : m === 'barium' ? 70 : 25)) ** 3);
  const specAt = (kVp) => tungstenSpectrum(kVp, 0.25, true);
  const sampleE = (r, kVp) => { const s = specAt(kVp); for (let k = 0; k < 400; k++) { const E = 15 + r() * (kVp - 15); if (r() < s(E)) return E; } return kVp * 0.5; };
  /* One photon's history through a column: interaction depth (cm) and type, or transmitted. */
  function history(r, col, E) {
    let depth = 0;
    for (const [m, th] of col.layers) {
      const d = -Math.log(1 - r() * 0.9999) / mu(m, E);
      if (d < th) {
        const u = r();
        const type = u < 0.04 ? 'coh' : u < 0.04 + fPE(m, E) * 0.96 ? 'pe' : 'compton';
        return { type, depth: depth + d, mat: m };
      }
      depth += th;
    }
    return { type: 'through', depth };
  }

  /* The field. Columns side by side; photons fall from the top, each by its own history. Counts
     at the detector row build an image strip under it (white where few arrive). Options pick the
     kV, which event to slow and point at, scatter's visibility and a grid. */
  function tissueScene(t, { kVp = 80, rate = 40, hi = null, hiAt = 0, hiCol = null, slow = 1, strip = true, grid = null, hideScatter = false, x0 = 0, w = null, top = 10, atomsOn = true, colsDef = COLS }) {
    const W = w || px.W, H = px.H;
    const colW = Math.floor((W - 16) / colsDef.length), L = x0 + 8;
    // while a slowed event plays, everything else fades back
    const fAge = hi ? (t - Math.floor(hiAt * rate) / rate) / slow : -1;
    const dimAll = hi && fAge > 0 && fAge < 3.2 ? 0.35 : 1;
    px.alpha = dimAll;
    const y0 = top + 14, cm = 9;                           // pixels per cm
    const thick = 10 * cm, yDet = y0 + thick + (grid ? 22 : 8);
    // the tissue, shaded by material, with its atoms
    colsDef.forEach((c, ci) => {
      let y = y0;
      for (const [m, th] of c.layers) {
        const h = th * cm, col = m === 'fat' ? 'fat' : m === 'bone' ? 'bone' : m === 'barium' ? 'white' : m === 'air' ? 'ink' : 'muscle';
        px.rect(L + ci * colW + 1, y, colW - 2, h, col, m === 'air' ? 0.3 : 0.16);
        if (atomsOn) {
          const rr = rng(77 + ci * 13 + Math.round(y));
          const dens = m === 'bone' ? 0.006 : m === 'barium' ? 0.012 : m === 'fat' ? 0.0035 : m === 'air' ? 0.0004 : 0.0055;
          const n = Math.round(dens * (colW - 2) * h);
          for (let k = 0; k < n; k++) {
            const ax = L + ci * colW + 3 + rr() * (colW - 6), ay = y + 2 + rr() * (h - 4);
            if (m === 'bone' || m === 'barium') atom(px, ax, ay, m === 'barium' ? 4 : 3, t, { shells: [2, 6], ring: m === 'barium' ? 'grey' : 'peach', e: 'yellow', nucleus: 'orange', seed: k });
            else px.rect(ax, ay, 2, 2, m === 'fat' ? 'gold' : 'pink', 0.55);
          }
        }
        y += h;
      }
      px.frame(L + ci * colW, y0, colW, thick, 'dkgrey', 0.7);
    });
    px.alpha = 1;
    // the grid (lead strips, focused straight down here) above the detector
    if (grid) {
      const gy = y0 + thick + 6, gh = grid.h;
      for (let gx = L; gx < L + colW * colsDef.length; gx += grid.pitch) px.rect(gx, gy + (16 - gh), 1, gh, 'lead');
    }
    // the detector row
    px.rect(L, yDet, colW * colsDef.length, 4, 'navy');
    const counts = new Array(colsDef.length).fill(0), fog = new Array(colsDef.length).fill(0);
    const N = Math.floor(t * rate);
    const fi = hi ? Math.floor(hiAt * rate) : -1;
    let focusEv = null;
    // the last 10 s of photons: enough for the counts' proportions, and a held step stays cheap
    for (let i = Math.max(0, N - Math.ceil(rate * 10)); i <= N; i++) {
      const r = rng(5000 + i);
      const focus = i === fi;
      const ci = focus && hiCol != null ? hiCol : Math.floor(r() * colsDef.length), col = colsDef[ci];
      let E = sampleE(r, kVp);
      let h = history(r, col, E);
      if (focus && hi) {                                     // the slowed one: force its story
        for (let k = 0; k < 60 && h.type !== hi; k++) h = history(r, col, E);
      }
      const xIn = L + ci * colW + 4 + r() * (colW - 8);
      const age = (t - i / rate) / (focus ? slow : 1);
      if (age < 0) continue;
      px.alpha = focus ? 1 : dimAll;
      const v = 160;                                         // pixels per second
      const yHit = y0 + h.depth * cm;
      const tHit = (yHit - (top - 10)) / v;
      if (focus) focusEv = { x: xIn, y: yHit, type: h.type, age, tHit, E };
      if (h.type === 'through') {
        const tDet = (yDet - (top - 10)) / v;
        if (age < tDet) px.photon(xIn, top - 10 + age * v, 0, 1, focus ? 9 : 5, keVColor(E), focus ? 1 : 0.85, t * 30 + i);
        else { counts[ci]++; if (age - tDet < 0.08) px.rect(xIn - 1, yDet - 1, 3, 3, 'white', 0.8); }
        continue;
      }
      if (age < tHit) { px.photon(xIn, top - 10 + age * v, 0, 1, focus ? 9 : 5, keVColor(E), focus ? 1 : 0.85, t * 30 + i); continue; }
      const e = age - tHit;
      if (h.type === 'pe') {
        // gone: absorbed by an inner electron, which flies off (the photoelectron), the atom ionised
        if (e < 0.2) px.glow(xIn, yHit, focus ? 5 : 3, 'white', 0.9, i);
        if (e < 0.9) electron(px, xIn + e * 40 * (r() < 0.5 ? -1 : 1), yHit + e * 18, (1 - e / 0.9) * (focus ? 1 : 0.7), 'cyan');
      } else {
        if (hideScatter) continue;                           // primary only: as if none reached the detector
        // scattered: off at an angle with less energy (Compton) or the same (coherent); a recoil
        // electron for Compton
        const ang = (r() - 0.5) * (h.type === 'coh' ? 0.6 : 2.6) + (r() < 0.25 ? Math.PI : 0);
        const E2 = h.type === 'coh' ? E : E / (1 + (E / 511) * (1 - Math.cos(ang)));
        const sx = Math.sin(ang), sy = Math.cos(ang);
        const L2 = e * v;
        const fx = xIn + sx * L2, fy = yHit + sy * L2;
        if (h.type === 'compton' && e < 0.7) electron(px, xIn - sx * e * 25, yHit + e * 10, (1 - e / 0.7) * 0.8, 'cyan');
        if (e < 0.12) px.glow(xIn, yHit, focus ? 4 : 2, 'orange', 0.8, i);
        // through a grid, an angled photon meets lead (the steeper, the surer)
        let stopY = Infinity;
        if (grid && sy > 0) {
          const tanA = Math.abs(sx / sy), pass = Math.max(0, 1 - tanA * grid.ratio);
          if (((i * 2654435761) % 1000) / 1000 > pass) stopY = y0 + thick + 6 + (16 - grid.h) + r() * grid.h;
        }
        if (fy >= stopY) { if (fy - stopY < 6) px.rect(fx - 1, stopY - 1, 3, 3, 'grey', 0.8); continue; }
        if (fy >= yDet) {
          const cx = Math.floor((fx - L) / colW);
          if (cx >= 0 && cx < colsDef.length) fog[cx]++;
          continue;
        }
        if (fx < L - 6 || fx > L + colW * colsDef.length + 6 || fy < top - 12) continue;
        px.photon(fx, fy, sx, sy, focus ? 9 : 5, keVColor(E2), focus ? 1 : 0.8, t * 30 + i);
      }
    }
    px.alpha = 1;
    if (focusEv && focusEv.age < focusEv.tHit + 2.5) api.mark([focusEv.x - 9, focusEv.y - 9, 18, 18], 'yellow', t);
    // the image strip: grey by photons arrived (more photons, darker; bone light)
    if (strip) {
      const mx = Math.max(1, ...counts.map((c, k) => c + fog[k]));
      colsDef.forEach((c, ci) => {
        const v = 1 - (counts[ci] + fog[ci]) / mx;
        const g = Math.round(30 + v * 220);
        px.rect(L + ci * colW, yDet + 8, colW, 14, `rgb(${g},${g},${g})`);
      });
      px.frame(L, yDet + 8, colW * colsDef.length, 14, 'dkgrey');
    }
    return { counts, fog, L, colW, yDet };
  }

  // transmitted fraction of a spectrum through a column (for the kV and contrast plots)
  const transmitted = (kVp, layers) => {
    const s = specAt(kVp);
    let a = 0, b = 0;
    for (let E = 15; E <= kVp; E += 1) {
      const w = s(E) * E;                                    // energy-weighted, as a detector sees it
      let att = 0; for (const [m, th] of layers) att += mu(m, E) * th;
      a += w * Math.exp(-att); b += w;
    }
    return a / b;
  };

  // ================================================================ grid errors (8-bit)
  // a focused grid: strips leaning toward a focal line SID above; each error changes the angle
  // each interspace sees the beam at, and the transmission across the grid is the profile
  function gridErrorScene(t, err, k) {
    px.fillAll('ink');
    const W = px.W, H = px.H, cx = W / 2, gy = H - 64, gw = Math.min(W - 40, 260), ratio = 8;
    const f0 = 140;                                          // the grid's focal distance in pixels
    let fx = cx, fy = gy - f0, tilt = 0, flip = 1;
    if (err === 'level') tilt = 0.18 * k;
    if (err === 'center') fx = cx + 50 * k;
    if (err === 'focus') fy = gy - f0 * (1 - 0.55 * k);
    if (err === 'upside') flip = 1 - 2 * k;
    // the source
    px.glow(fx, fy, 4, 'yellow', 1, 1); px.rect(fx - 1, fy - 1, 3, 3, 'white');
    // the strips and the profile
    const n = 36, prof = [];
    for (let s = 0; s < n; s++) {
      const u = (s + 0.5) / n - 0.5, x = cx + u * gw;
      const lean = flip * Math.atan2(u * gw, f0) + tilt;     // the strip's angle from vertical
      const xs = x + Math.sin(tilt) * 0, ys = gy;
      const L = 16;
      px.line(xs - Math.sin(lean) * L / 2, ys - Math.cos(lean) * L / 2, xs + Math.sin(lean) * L / 2, ys + Math.cos(lean) * L / 2, 'lead');
      const rayA = Math.atan2(x - fx, gy - fy);
      const tr = Math.max(0, 1 - ratio * Math.abs(Math.tan(rayA - lean)));
      prof.push(tr);
      if (s % 3 === 1) px.line(fx, fy, x, gy - 9, tr > 0.5 ? 'violet' : 'dkgrey', 0.35 + 0.4 * tr, 2);
    }
    // the exposure across the image
    const py = gy + 22;
    prof.forEach((tr, s) => {
      // the image: dark where exposed, light where the grid cut the beam off (the yellow line is
      // the exposure itself)
      const g = Math.round(40 + (1 - tr) * 200);
      px.rect(cx - gw / 2 + (s / n) * gw, py, gw / n + 1, 12, `rgb(${g},${g},${g})`);
      px.rect(cx - gw / 2 + (s / n) * gw, py + 26 - tr * 10, gw / n + 1, 1, 'yellow');
    });
    px.frame(cx - gw / 2, py, gw, 12, 'dkgrey');
  }

  // ================================================================ double contrast (8-bit)
  function bowelScene(t, mode) {
    px.fillAll('ink');
    const W = px.W, H = px.H;
    const cases = mode === 'all' ? ['none', 'single', 'double'] : [mode];
    const cw = W / cases.length;
    cases.forEach((c, i) => {
      const cx = cw * i + cw / 2, cy = H / 2 - 18, R = Math.min(34, cw * 0.32);
      // the bowel wall (soft tissue), its lumen: fluid, barium, or air with a barium coat
      px.circle(cx, cy, R + 6, 'muscle', 0.7, true);
      px.circle(cx, cy, R, c === 'single' ? 'white' : c === 'double' ? 'ink' : 'brown', c === 'none' ? 0.6 : 1, true);
      if (c === 'double') { px.circle(cx, cy, R, 'white', 1); px.circle(cx, cy, R - 1, 'grey', 0.8); }
      // folds of mucosa, picked out by the coat
      if (c === 'double') for (let k = 0; k < 6; k++) { const a = k * 1.05 + 0.3; px.line(cx + Math.cos(a) * R, cy + Math.sin(a) * R, cx + Math.cos(a) * (R - 7), cy + Math.sin(a) * (R - 7), 'white'); }
      // photons down through it, and the projection below: the attenuation along each line
      const y0 = cy - R - 22, yb = cy + R + 26;
      for (let x = -R - 8; x <= R + 8; x += 1) {
        const d2 = R * R - x * x, inL = d2 > 0 ? 2 * Math.sqrt(d2) : 0;
        const rw = (R + 6) ** 2 - x * x, wall = rw > 0 ? 2 * Math.sqrt(rw) - inL : 0;
        let att = wall * 0.012;
        if (c === 'none') att += inL * 0.013;
        if (c === 'single') att += inL * 0.09;
        if (c === 'double') att += inL * 0.0002 + (d2 > 0 ? Math.min(2.6, 2.2 / Math.max(0.35, Math.sqrt(d2) / R * 3.0)) : 0) * 0.35;
        const v = 1 - Math.exp(-att);
        const g = Math.round(24 + v * 230);
        px.rect(cx + x, yb, 1, 14, `rgb(${g},${g},${g})`);
      }
      px.frame(cx - R - 9, yb, 2 * R + 18, 14, 'dkgrey');
      for (let k = 0; k < 6; k++) {
        const ph = ((t * 0.9 + k / 6) % 1), xx = cx - R + (k / 5) * 2 * R;
        px.photon(xx, y0 + ph * (yb - y0), 0, 1, 4, 'violet', 0.7, t * 20 + k);
      }
    });
  }

  // ================================================================ the steps
  const geoCam = [[0, [60, 70, 110], [0, 30, 0], 38]];
  const steps = [
    {
      title: 'Divergence', dur: 11, fadeIn: 0.6, scale: '10 cm',
      enter() { S.only('geo'); shadow2.visible = false; ball.scale.setScalar(1); disc.position.set(0, 0, 0); focal.position.set(0, SID, 0); ball.visible = disc.visible = rod.visible = false; shadow.visible = false; rays.visible = false; cone.visible = true; },
      cam: [[0, [70, 150, 95], [0, 45, 0], 40], [11, [55, 140, 80], [0, 40, 0], 40]],
      frame(t) {
        const src = [0, SID, 0];
        cone.userData.set(src, [[-15, 0, -15], [15, 0, -15], [15, 0, 15], [-15, 0, 15]]);
        // the same 16 photons crossing a square at 50 cm and four squares at 100 cm
        const k = span(t, 2, 4);
        const sq = (D, h) => [[-h, SID - D, -h], [h, SID - D, -h], [h, SID - D, h], [-h, SID - D, h]];
        const draw = (c, col) => { for (let i = 0; i < 4; i++) { const [a, b] = [api.toPx(c[i]), api.toPx(c[(i + 1) % 4])]; px.line(a[0], a[1], b[0], b[1], col, k); } };
        draw(sq(50, 3.75), 'yellow'); draw(sq(100, 7.5), 'yellow');
        const r = rng(9);
        for (let i = 0; i < 16; i++) {
          // through the small square at 50 cm, so at 100 cm they fill the big one
          const u = r() - 0.5, w = r() - 0.5, ph = ((t * 0.5 + i / 16) % 1);
          const D = ph * 100;
          const p = [u * 7.5 * D / 50, SID - D, w * 7.5 * D / 50];
          const [x, y] = api.toPx(p);
          if (k > 0) px.rect(x - 1, y - 1, 2, 2, 'violet', k);
        }
      },
      caption: [
        { from: 1, to: 5.5, text: 'From the focal spot the beam <b>diverges</b>: every photon travels in a straight line away from it.' },
        { from: 5.5, to: 11, text: 'At twice the distance the same photons cover four times the area: the intensity falls as 1/distance² (the <b>inverse square law</b>).' },
      ],
    },
    {
      title: 'Into the tissue', dur: 9, view: 'pixel', scale: '1 cm',
      frame(t) { px.fillAll('ink'); tissueScene(t, { rate: 30 }); },
      caption: [{ from: 0.8, to: 9, text: 'A slice through three paths: fat, soft tissue, and soft tissue with bone. Each photon either passes straight through or interacts with an atom on its way.' }],
    },
    {
      title: 'Photoelectric absorption', dur: 11, view: 'pixel', scale: '1 cm',
      cues: [[3.1, () => sfx.zap()]],
      frame(t) { px.fillAll('ink'); tissueScene(t + 6, { rate: 18, hi: 'pe', hiAt: 7, hiCol: 2, slow: 4 }); },
      caption: [{ from: 1, to: 11, text: 'The <b>photoelectric effect</b>: the photon gives all its energy to an inner-shell electron, which is ejected. The photon is gone. It is likeliest at low energy and in high atomic number atoms like the calcium of bone (∝ Z³/E³).' }],
    },
    {
      title: 'Compton scatter', dur: 11, view: 'pixel', scale: '1 cm',
      cues: [[3.1, () => sfx.pew(1200)]],
      frame(t) { px.fillAll('ink'); tissueScene(t + 20, { rate: 18, hi: 'compton', hiAt: 21, hiCol: 1, slow: 4 }); },
      caption: [{ from: 1, to: 11, text: '<b>Compton scatter</b>: the photon knocks out a loosely bound outer electron and carries on in a new direction with less energy. It barely depends on Z, and dominates in soft tissue at diagnostic energies.' }],
    },
    {
      title: 'Differential absorption', dur: 12, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('ink');
        const r = tissueScene(t + 40, { rate: 60, hideScatter: false });
        const k = span(t, 4, 5);
        if (k > 0) r.counts.forEach((c, ci) => api.mark([r.L + ci * r.colW + 2, r.yDet + 6, r.colW - 4, 18], ci === 2 ? 'yellow' : 'grey', t));
      },
      caption: [
        { from: 0.8, to: 6, text: 'Bone absorbs far more than soft tissue, and soft tissue a little more than fat: different numbers of photons reach the detector under each.' },
        { from: 6, to: 12, text: 'That difference is <b>differential absorption</b>: it is the image. Few photons, a light area (bone); many, a dark one.' },
      ],
    },
    {
      title: 'kV and contrast', dur: 14, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('ink');
        const kVp = t < 2 ? 55 : t < 7 ? lerp(55, 120, span(t, 2, 7)) : t < 9 ? 120 : lerp(120, 55, span(t, 9, 13));
        const W = px.W, half = Math.floor(W * 0.55);
        tissueScene(t + 60, { kVp, rate: 50, w: half, strip: true, atomsOn: false, colsDef: [COLS[1], COLS[2]] });
        // the transmitted shares and the contrast between them
        const a = transmitted(kVp, [['soft', 10]]), b = transmitted(kVp, [['soft', 8], ['bone', 2]]);
        const x0 = half + 14, bw = 26, base = px.H - 40, hmax = 300;      // (the fractions are small: drawn x300)
        px.rect(x0, base - Math.min(120, a * hmax), bw, Math.min(120, a * hmax), 'muscle');
        px.rect(x0 + bw + 8, base - Math.min(120, b * hmax), bw, Math.min(120, b * hmax), 'bone');
        px.rect(x0 - 2, base, bw * 2 + 12, 1, 'mid');
        const C = (a - b) / a;
        px.line(x0 + bw * 2 + 14, base - Math.min(120, a * hmax), x0 + bw * 2 + 14, base - Math.min(120, b * hmax), 'yellow');
        px.text(Math.round(kVp) + ' kV', x0 + bw + 4, 14, 'yellow', 1, 1, 'center');
        px.text('C ' + C.toFixed(2), x0 + bw + 4, 24, 'white', 1, 1, 'center');
        // the two greys the image would show
        const g1 = Math.round(30 + (1 - a / Math.max(a, 1e-6)) * 200), g2 = Math.round(30 + (1 - b / a) * 220);
        px.rect(x0, base + 8, bw * 2 + 8, 12, `rgb(${g1},${g1},${g1})`);
        px.rect(x0 + bw + 4, base + 8, bw + 4, 12, `rgb(${g2},${g2},${g2})`);
      },
      caption: [
        { from: 1, to: 7, text: 'Raise the <b>kV</b> and the photons carry more energy: more of them get through everything, bone included.' },
        { from: 7, to: 14, text: 'The difference between what passes soft tissue and what passes bone shrinks: lower <b>subject contrast</b>, a greyer image. Low kV, high contrast; high kV, more latitude and less dose.' },
      ],
    },
    {
      title: 'Magnification', dur: 12, scale: '10 cm',
      enter() { S.only('geo'); shadow2.visible = false; ball.scale.setScalar(1); disc.position.set(0, 0, 0); focal.position.set(0, SID, 0); ball.visible = rod.visible = false; disc.visible = true; disc.rotation.set(0, 0, 0); shadow.visible = rays.visible = true; cone.visible = false; },
      cam: [[0, [70, 40, 95], [0, 30, 0], 40], [12, [60, 50, 85], [0, 32, 0], 40]],
      frame(t) {
        const h = t < 2 ? 5 : t < 8 ? lerp(5, 60, span(t, 2, 8)) : 60;
        disc.position.set(0, h, 0);
        const src = [0, SID, 0], hull = castShadow(disc, src);
        drawRays(hull, src, 10);
        const [w] = extent(hull), M = w / 12;
        px.text('M ' + M.toFixed(2), px.W - 8, 10, 'yellow', 1, 1, 'right');
        px.text('OID ' + Math.round(h) + ' cm', px.W - 8, 20, 'mid', 1, 1, 'right');
      },
      caption: [
        { from: 1, to: 6.5, text: 'Every image is a shadow cast from a point: the farther the part is from the detector (the <b>OID</b>), the bigger its shadow.' },
        { from: 6.5, to: 12, text: '<b>Magnification</b> = SID ÷ SOD. Keep the part close to the detector and the SID long to keep it true to size (and sharp: a shorter OID also shrinks the focal spot’s blur).' },
      ],
    },
    {
      title: 'Elongation', dur: 11, scale: '10 cm',
      enter() { S.only('geo'); shadow2.visible = false; ball.scale.setScalar(1); disc.position.set(0, 0, 0); focal.position.set(0, SID, 0); disc.visible = rod.visible = false; ball.visible = true; ball.position.set(0, 18, 0); shadow.visible = rays.visible = true; cone.visible = false; },
      cam: [[0, [10, 60, 120], [0, 20, 0], 40], [11, [-20, 55, 115], [0, 18, 0], 40]],
      frame(t) {
        // the tube angled along x, still aimed at the part
        const ang = lerp(0, 40, span(t, 1.5, 6)) * Math.PI / 180;
        const src = [-Math.sin(ang) * SID, 18 + Math.cos(ang) * (SID - 18), 0];
        focal.position.set(...src);
        const hull = castShadow(ball, src);
        drawRays(hull, src, 12);
        const [w, d] = extent(hull);
        px.text((w / d).toFixed(2) + ' : 1', px.W - 8, 10, 'yellow', 1, 1, 'right');
        px.text(Math.round(ang * 180 / Math.PI) + '°', px.W - 8, 20, 'mid', 1, 1, 'right');
      },
      caption: [{ from: 1, to: 11, text: 'Angle the tube against the part and its shadow is stretched along the angle: <b>elongation</b>. A round ball casts an oval.' }],
    },
    {
      title: 'Foreshortening', dur: 11, scale: '10 cm',
      enter() { S.only('geo'); shadow2.visible = false; ball.scale.setScalar(1); disc.position.set(0, 0, 0); focal.position.set(0, SID, 0); disc.visible = ball.visible = false; rod.visible = true; rod.position.set(0, 14, 0); focal.position.set(0, SID, 0); shadow.visible = rays.visible = true; cone.visible = false; },
      cam: [[0, [80, 45, 80], [0, 15, 0], 40], [11, [70, 55, 90], [0, 15, 0], 40]],
      frame(t) {
        // a long bone tilted away from the detector's plane under a straight beam
        const tilt = lerp(90, 30, span(t, 1.5, 7)) * Math.PI / 180;
        rod.rotation.set(0, 0, tilt);
        const src = [0, SID, 0], hull = castShadow(rod, src);
        drawRays(hull, src, 12);
        const [w] = extent(hull);
        px.text(Math.round((w / 26) * 100) + '%', px.W - 8, 10, 'yellow', 1, 1, 'right');
        px.text(Math.round(90 - tilt * 180 / Math.PI) + '°', px.W - 8, 20, 'mid', 1, 1, 'right');
      },
      caption: [{ from: 1, to: 11, text: 'Tilt the part out of the detector’s plane and its shadow is shorter than it is: <b>foreshortening</b>. Keep the long axis parallel to the detector.' }],
    },
    {
      title: 'Angling for true length', dur: 16, scale: '10 cm',
      enter() { S.only('geo'); disc.visible = ball.visible = false; rod.visible = true; rod.position.set(0, 14, 0); rod.rotation.set(0, 0, 50 * Math.PI / 180); shadow.visible = rays.visible = true; shadow2.visible = false; cone.visible = false; },
      cam: [[0, [30, 55, 120], [8, 15, 0], 40], [16, [45, 60, 115], [10, 15, 0], 40]],
      cues: [[3, () => sfx.click()], [9, () => sfx.click()]],
      frame(t) {
        /* A part that cannot lie flat (here 40 degrees off the detector, as a scaphoid in its wrist):
           a straight beam foreshortens it. Angling the CR along the part elongates its image back:
           at half the part's tilt (the CR square to the bisector of part and detector) the image is
           its true length; at the full tilt, longer than true. */
        const phi = (t < 3 ? 0 : t < 9 ? lerp(0, 20, span(t, 3, 5.5)) : lerp(20, 40, span(t, 9, 11.5))) * Math.PI / 180;
        const D = SID - 14, src = [Math.sin(phi) * D, 14 + Math.cos(phi) * D, 0];
        focal.position.set(...src);
        const hull = castShadow(rod, src);
        drawRays(hull, src, 12);
        api.keepOut(hullBox(hull));
        // the shadow's length against the part's own: its axis's two ends projected, the CR's
        // magnification taken out
        const ax = [-Math.sin(rod.rotation.z), Math.cos(rod.rotation.z)], ends = [-13, 13].map((k) => [ax[0] * k, 14 + ax[1] * k]);
        const proj = ends.map(([x, y]) => src[0] + (x - src[0]) * src[1] / (src[1] - y));
        const M = src[1] / (src[1] - 14);
        const pct = Math.round(Math.abs(proj[1] - proj[0]) / (26 * M) * 100);
        px.text(pct + '%', px.W - 8, 10, pct >= 97 && pct <= 103 ? 'lime' : 'yellow', 1, 1, 'right');
        px.text('CR ' + Math.round(phi * 180 / Math.PI) + '°', px.W - 8, 20, 'mid', 1, 1, 'right');
        api.keepOut([px.W - 50, 4, 46, 24]);
        api.mark(rod, 'yellow', t);
      },
      caption: [
        { from: 0.5, to: 3, text: 'A part that cannot lie parallel to the detector: under a straight beam it is <b>foreshortened</b>.' },
        { from: 3, to: 9, text: 'Angle the CR along it and the image lengthens. At <b>half the part’s tilt</b>, square to the bisector of the part and the detector, it is its true length: the scaphoid view, the AP axial sacrum and coccyx.' },
        { from: 9, to: 16, text: 'Angle by the full tilt and it is <b>elongated</b> past its true length: distortion is a tool, set by the angle.' },
      ],
    },
    {
      title: 'Angling to clear overlap', dur: 14, scale: '10 cm',
      enter() {
        S.only('geo'); rod.visible = false; ball.visible = disc.visible = true;
        disc.rotation.set(0, 0, 0); disc.position.set(0, 3, 0); ball.position.set(0, 22, 0); ball.scale.setScalar(0.7);
        shadow.visible = shadow2.visible = rays.visible = true; cone.visible = false;
      },
      cam: [[0, [90, 60, 40], [0, 12, 8], 40], [14, [95, 65, 50], [0, 12, 10], 40]],
      cues: [[3, () => sfx.click()]],
      frame(t) {
        /* Two structures one above the other (a clavicle over the scapula and ribs, the occipital
           bone under the face): a straight beam lays one shadow on the other. An angled beam shifts
           each shadow by its height times tan(angle), the higher one more, and they come apart. */
        const phi = lerp(0, 25, span(t, 3, 7)) * Math.PI / 180;
        const D = SID - 12, src = [0, 12 + Math.cos(phi) * D, -Math.sin(phi) * D];
        focal.position.set(...src);
        const h1 = castShadow(disc, src, shGeo, 0.06), h2 = castShadow(ball, src, shGeo2, 0.09);
        drawRays(h2, src, 10);
        api.keepOut(hullBox(h1)); api.keepOut(hullBox(h2));
        const db = api.boxPx(disc); if (db) api.keepOut(db);
        const c = (h) => h.reduce((a, q) => [a[0] + q[0] / h.length, a[1] + q[1] / h.length], [0, 0]);
        const a1 = c(h1), a2 = c(h2);
        px.text(Math.round(Math.hypot(a2[0] - a1[0], a2[1] - a1[1])) + ' cm', px.W - 8, 10, 'yellow', 1, 1, 'right');
        px.text('CR ' + Math.round(phi * 180 / Math.PI) + '°', px.W - 8, 20, 'mid', 1, 1, 'right');
        api.keepOut([px.W - 50, 4, 46, 24]);
        api.mark(ball, 'yellow', t);
      },
      caption: [
        { from: 0.5, to: 3, text: 'A structure lying over another: under a straight beam their shadows land on top of each other.' },
        { from: 3, to: 14, text: 'Angle the CR and each shadow shifts by its height above the detector: the higher one moves farther, and they <b>separate</b>. The AP axial clavicle (cephalic) and Towne’s (caudal) use this.' },
      ],
    },
    {
      title: 'Scatter', dur: 12, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('ink');
        const half = Math.floor(px.W / 2);
        // left: primary only; right: with scatter reaching the detector
        tissueScene(t + 80, { rate: 45, w: half - 4, hideScatter: true, colsDef: [COLS[1], COLS[2], COLS[1]] });
        const r = tissueScene(t + 80, { rate: 45, w: half - 4, x0: half + 4, colsDef: [COLS[1], COLS[2], COLS[1]] });
        // scatter adds a fog to the right image (counted in its strip already)
        if (t > 6) api.mark([half + 8, r.yDet + 6, half - 20, 18], 'yellow', t);
      },
      caption: [
        { from: 1, to: 6, text: 'Compton photons leave the patient at all angles. Those that reach the detector land in the wrong place: they carry no information about where they came from.' },
        { from: 6, to: 12, text: 'They add an even <b>fog</b> over the image, lifting the dark areas toward grey: less contrast.' },
      ],
    },
    {
      title: 'The grid', dur: 12, view: 'pixel', scale: '1 mm',
      cues: [[2, () => sfx.click()]],
      frame(t) {
        px.fillAll('ink');
        tissueScene(t + 100, { rate: 45, grid: { pitch: 4, h: 14, ratio: 8 }, colsDef: [COLS[1], COLS[2], COLS[1]] });
      },
      caption: [
        { from: 1, to: 6.5, text: 'A <b>grid</b> of thin lead strips stands between patient and detector, aligned with the primary beam.' },
        { from: 6.5, to: 12, text: 'Primary photons pass between the strips; scattered ones arrive at an angle and are stopped by the lead. Contrast is restored, at the price of more exposure.' },
      ],
    },
    {
      title: 'Grid ratio', dur: 12, view: 'pixel', scale: '1 mm',
      frame(t) {
        px.fillAll('ink');
        const W = px.W, H = px.H, half = W / 2;
        [[6, 'lead'], [12, 'lead']].forEach(([ratio], s) => {
          const cx = half * s + half / 2, gy = H / 2 + 10, D = 8, h = ratio * D * 0.5;
          // three strips and their acceptance: the steepest angle that still gets through
          for (let k = -2; k <= 2; k++) px.rect(cx + k * D, gy - h, 2, h, 'lead');
          const acc = Math.atan(D / h);
          px.line(cx + D / 2, gy, cx + D / 2 - Math.tan(acc) * 60, gy - 60, 'lime', 0.8, 2);
          px.line(cx + D / 2, gy, cx + D / 2 + Math.tan(acc) * 60, gy - 60, 'lime', 0.8, 2);
          px.text(ratio + ':1', cx, gy + 10, 'yellow', 1, 1, 'center');
          px.text('h', cx - 2 * D - 8, gy - h / 2 - 2, 'mid');
          // scatter at random angles: green if it gets through, a flash where lead stops it
          const r = rng(300 + s);
          for (let i = 0; i < 26; i++) {
            const a = (r() - 0.5) * 1.6, ph = ((t * 0.7 + r()) % 1);
            const x = cx + D / 2 + Math.tan(a) * (1 - ph) * 60 * 0.8, y = gy - 60 + ph * 60;
            const ok = Math.abs(a) < acc;
            if (ph < 0.9 || ok) px.photon(x, y, -Math.sin(a), Math.cos(a), 4, ok ? 'lime' : 'red', 0.85, t * 20 + i);
            else px.rect(x - 1, y - 1, 3, 3, 'grey');
          }
        });
      },
      caption: [
        { from: 1, to: 6.5, text: '<b>Grid ratio</b> = the strips’ height ÷ the gap between them. The taller the strips, the narrower the angle a photon can arrive at and still get through.' },
        { from: 6.5, to: 12, text: 'A 12:1 grid cleans up more scatter than a 6:1, but needs more mAs (the Bucky factor) and is less forgiving of misalignment.' },
      ],
    },
    {
      title: 'Grid errors', dur: 20, view: 'pixel', scale: '10 cm',
      frame(t) {
        const errs = ['level', 'center', 'focus', 'upside'];
        const i = Math.min(3, Math.floor(t / 5)), k = span(t - i * 5, 0.6, 2.4);
        gridErrorScene(t, errs[i], k);
        px.text(['OFF-LEVEL', 'OFF-CENTER', 'OFF-FOCUS', 'UPSIDE DOWN'][i], px.W / 2, 8, 'yellow', 1, 1, 'center');
      },
      cues: [[0.6, () => sfx.blip(520)], [5.6, () => sfx.blip(520)], [10.6, () => sfx.blip(520)], [15.6, () => sfx.blip(520)]],
      caption: [
        { from: 0.5, to: 5, text: 'A focused grid’s strips lean toward one focal distance. <b>Off-level</b> (tilted): every strip is off the beam’s angle, an even loss across the image.' },
        { from: 5, to: 10, text: '<b>Off-center</b>: the tube to one side, the same even loss (cut-off) across the image.' },
        { from: 10, to: 15, text: '<b>Off-focus</b>: the SID outside the grid’s range, the edges lose the most, on both sides.' },
        { from: 15, to: 20, text: '<b>Upside down</b>: the strips lean away from the tube; only the middle gets through, the edges are cut off.' },
      ],
    },
    {
      title: 'Barium', dur: 12, scale: '10 cm', fadeIn: 0.5,
      enter() { S.only('abdo'); for (const g of Object.values(gi)) { g.material.color.set(0xb98a62); g.material.emissive.set(0x000000); } },
      cam: [[0, [0, 95, -70], [0, 0, 0], 40], [12, [-12, 88, -58], [0, 0, 4], 40]],      // (head at the top of the screen)
      frame(t) {
        // barium fills the stomach and runs on: white where it is, the rest of the gut still soft
        const k = span(t, 2, 7);
        for (const [part, g] of Object.entries(gi)) {
          const kk = part === 'stomach' || part === 'oesophagus' ? k : part === 'duodenum' ? span(t, 4, 8) : part === 'small_bowel' ? span(t, 6, 10) : 0;
          g.material.color.setRGB(lerp(0.73, 0.98, kk), lerp(0.54, 0.98, kk), lerp(0.38, 0.98, kk));
          g.material.emissive.setRGB(0.5 * kk, 0.5 * kk, 0.5 * kk);
        }
        if (gi.stomach && t > 2) api.mark(gi.stomach, 'yellow', t);
      },
      caption: [
        { from: 1, to: 6.5, text: '<b>Barium sulfate</b> (Z = 56) absorbs x-rays strongly by the photoelectric effect, its K-edge at 37 keV sitting under much of the beam.' },
        { from: 6.5, to: 12, text: 'Swallowed, it fills the stomach and bowel and makes them white on the image, a <b>positive contrast</b> agent.' },
      ],
    },
    {
      title: 'Double contrast', dur: 14, view: 'pixel', scale: '1 cm', fadeOut: 0.6,
      frame(t) {
        const mode = t < 4 ? 'none' : t < 8 ? 'single' : 'all';
        bowelScene(t, t < 4 ? 'none' : t < 8 ? 'single' : t < 10 ? 'double' : 'all');
        void mode;
      },
      caption: [
        { from: 0.5, to: 4, text: 'The bowel without contrast: its contents attenuate like its wall, and it barely shows.' },
        { from: 4, to: 8, text: 'Filled with barium: a white cast of the lumen, but it hides the lining.' },
        { from: 8, to: 14, text: '<b>Double contrast</b>: a thin coat of barium on the wall, the lumen distended with air or CO₂ (a <b>negative</b> contrast agent): the mucosa is drawn as a fine white line round a dark space.' },
      ],
    },
  ];
  void geoCam; void setOpacity; void curvePlot; void clamp01;
  return { title: 'The beam in the patient', steps };
}
