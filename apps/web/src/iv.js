/* ============================================================================
   IV ROOM — placing a peripheral IV for contrast (core/ivSim.js is the procedure engine;
   data/iv.json holds every number and the three sites' veins).

   The patient is the x-ray room's own arm or hand, lying on an arm board: the upper extremity
   palm up for the antecubital fossa and the radial forearm, the hand palm down for its dorsum.
   Veins, the prep, the mark, the dressing, a haematoma are painted into one texture laid over
   the skin of the working area (a patch whose every vertex is found on the skin from the
   voxels, so it follows the arm's own curve). The tools are small models. The learner works
   with the mouse and a few keys; the screen says only the step, what to know, and the controls.

   The site's own coordinates, in which everything here is measured: `a` cm along the limb
   (toward the heart), `l` cm across it (lateral on the arm, radial on the hand), on the skin.
   On a limb `l` is arc length round it, so a vein on the side of the forearm sits on its side.
   ============================================================================ */
import cfg from './data/iv.json';
import * as IV from './core/ivSim.js';
import { skinPoint } from './core/palpation.js';

let ctx = null;              // { THREE, S, three, $, setSubject, phantomPose }
let A = null;                // the attempt
let attempts = 0;
const setup = { site: 'antecubital', mode: 'guided', gauge: '20', difficulty: 50 };
let G = null;                // the site's geometry
let R3 = null;               // the room's three.js objects
let tool = null;
let viewKey = 'overview', viewPinned = null;
let loop = 0, lastT = 0;
const keys = { f: false, space: false };
const ptr = { down: false, button: 0, x: 0, y: 0, t: 0, onPatch: null, last: null, pressT: 0 };
const $ = (id) => document.getElementById(id);
const P = cfg.procedure;
const D = Math.PI / 180;

/* ---------------------------------------------------------------- the site's geometry */
const v3 = { add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s], dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; } };

function buildGeometry(siteKey) {
  const site = cfg.sites[siteKey], vm = ctx.S.voxelModel, pose = ctx.phantomPose();
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
      const c = centre(k / 2), s = skinPoint(vm, pose.flip, c, N);
      rCache.set(k, Math.max(1.2, Math.hypot(...v3.sub(s, c))));
    }
    return rCache.get(k);
  };
  // the skin point at (a, l), rest frame cm
  const restAt = (a, l) => {
    if (wrap) {
      const c = centre(a), phi = l / radiusAt(a);
      const dir = v3.add(v3.mul(N, Math.cos(phi)), v3.mul(L, Math.sin(phi)));
      return skinPoint(vm, pose.flip, c, dir);
    }
    const start = v3.add(v3.add(O, v3.mul(Ax, a)), v3.add(v3.mul(L, l), v3.mul(N, -1.5)));
    return skinPoint(vm, pose.flip, start, N);
  };
  const toWorld = (p) => {
    const Rm = pose.rot, c = pose.center;
    return [Rm[0] * p[0] + Rm[1] * p[1] + Rm[2] * p[2] + c[0], Rm[3] * p[0] + Rm[4] * p[1] + Rm[5] * p[2] + c[1],
      Rm[6] * p[0] + Rm[7] * p[1] + Rm[8] * p[2] + c[2]];
  };
  const fromWorld = (w) => {
    const Rm = pose.rot, c = pose.center, d = v3.sub(w, c);
    return [Rm[0] * d[0] + Rm[3] * d[1] + Rm[6] * d[2], Rm[1] * d[0] + Rm[4] * d[1] + Rm[7] * d[2], Rm[2] * d[0] + Rm[5] * d[1] + Rm[8] * d[2]];
  };
  const worldAt = (a, l) => toWorld(restAt(a, l));
  // did the search at (a, l) find skin at all (off the limb's edge it returns where it started)
  const startAt = (a, l) => (wrap ? centre(a) : v3.add(v3.add(O, v3.mul(Ax, a)), v3.add(v3.mul(L, l), v3.mul(N, -1.5))));
  const foundAt = (a, l) => Math.hypot(...v3.sub(restAt(a, l), startAt(a, l))) > 0.05;
  const paramOf = (rest) => {
    const a = v3.dot(v3.sub(rest, O), Ax);
    if (!wrap) return { a, l: v3.dot(v3.sub(rest, O), L) };
    const v = v3.sub(rest, centre(a));
    return { a, l: Math.atan2(v3.dot(v, L), v3.dot(v, N)) * radiusAt(a) };
  };
  // the outward normal at (a, l), world, from the surface's own tangents
  const normalAt = (a, l) => {
    const p0 = worldAt(a, l), pa = worldAt(a + 0.3, l), pl = worldAt(a, l + 0.3);
    let n = v3.norm(v3.cross(v3.sub(pa, p0), v3.sub(pl, p0)));
    const out = v3.norm(v3.sub(p0, toWorld(centre(a))));
    if (v3.dot(n, out) < 0) n = v3.mul(n, -1);
    return n;
  };
  // features: the paths densified every 2 mm in (a, l)
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
  return { site, siteKey, O, Ax, L, N, wrap, restAt, worldAt, foundAt, toWorld, fromWorld, paramOf, normalAt, feats, radiusAt };
}

/* Distance (cm) from (a, l) to a feature's path, where on it, and its direction there. */
function nearest(f, a, l) {
  let best = { d: Infinity, i: 0 };
  for (let i = 0; i < f.pts.length; i++) {
    const d = Math.hypot(f.pts[i][0] - a, f.pts[i][1] - l);
    if (d < best.d) best = { d, i };
  }
  const i0 = Math.max(0, best.i - 1), i1 = Math.min(f.pts.length - 1, best.i + 1);
  const t = [f.pts[i1][0] - f.pts[i0][0], f.pts[i1][1] - f.pts[i0][1]], tl = Math.hypot(...t) || 1;
  const tan = [t[0] / tl, t[1] / tl];
  // signed across: to the left of the direction of flow (toward +l for a vein running up the arm)
  const dp = [a - f.pts[best.i][0], l - f.pts[best.i][1]];
  const across = -dp[0] * tan[1] + dp[1] * tan[0];
  return { dist: best.d, at: f.pts[best.i], tan, across, i: best.i };
}
const minDist = (pts, a, l) => (pts && pts.length ? Math.min(...pts.map((p) => Math.hypot(p[0] - a, p[1] - l))) : Infinity);

/* ---------------------------------------------------------------- three.js: the room */
function makeRoom() {
  const { THREE, three } = ctx;
  const group = new THREE.Group(); group.name = 'ivRoom';
  three.scene.add(group);
  const mat = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.05, ...o });
  // a treatment room's light: soft from above, a little warmth on the skin
  const hemi = new THREE.HemisphereLight(0xfff6ee, 0x3a4250, 0.9);
  const sun = new THREE.DirectionalLight(0xffffff, 0.8); sun.position.set(30, 80, 20);
  group.add(hemi, sun);
  // the arm board, padded and covered
  const board = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat(0x2b3f5c, { roughness: 0.85 }));
  board.receiveShadow = true; group.add(board);
  // ---- the catheter kit (a closed system, after the BD Nexiva Diffusics): needle; clear catheter;
  // hub with gauge-coloured wings; grey needle housing with its flash chamber; extension set of
  // clear tubing, navy pinch clip and navy port under a clear cap. Kit frame: +x to the tip, +y out
  // of the skin, z across.
  const kit = new THREE.Group(); group.add(kit);
  const gaugeCol = new THREE.Color(P.gauges[setup.gauge].color);
  const clear = (c = 0xf3f7fa, o = 0.5) => mat(c, { transparent: true, opacity: o, roughness: 0.15, depthWrite: false });
  const NAVY = 0x1d2563;
  const alongX = (m, x = 0) => { m.rotation.z = -Math.PI / 2; m.position.x = x; return m; };
  const needle = alongX(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 3.2, 10), mat(0xd9dde2, { metalness: 0.9, roughness: 0.2 })));
  const cathM = alongX(new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.066, 2.5, 12), clear(0xf6f8fa, 0.7)));
  const sheath = new THREE.Group();
  sheath.add(alongX(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.19, 2.6, 14), clear(0xbfdcf5, 0.5)), -0.8));
  sheath.add(alongX(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.5, 14), mat(0x2f6fd6)), 0.55));
  const hub = new THREE.Group();
  hub.add(alongX(new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.24, 0.8, 16), clear(0xeef4f8, 0.55))));
  hub.add(alongX(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.7, 12), mat(gaugeCol))));
  // the wings: a rounded triangle each side, flat on the skin
  const wingShape = (sd) => {
    const sh = new THREE.Shape();
    sh.moveTo(0.3, 0.18 * sd); sh.quadraticCurveTo(-0.1, 0.7 * sd, -0.55, 1.05 * sd);
    sh.quadraticCurveTo(-0.72, 1.1 * sd, -0.72, 0.9 * sd); sh.lineTo(-0.6, 0.18 * sd); sh.closePath();
    return sh;
  };
  const wings = [];
  for (const sd of [1, -1]) {
    const w = new THREE.Mesh(new THREE.ExtrudeGeometry(wingShape(sd), { depth: 0.05, bevelEnabled: false }), mat(gaugeCol, { side: THREE.DoubleSide }));
    w.rotation.x = Math.PI / 2; w.position.y = -0.14; w.frustumCulled = false; hub.add(w);
    w.userData = { rest: w.geometry.attributes.position.array.slice() };
    wings.push(w);
  }
  const housing = new THREE.Group();
  const chamber = alongX(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.55, 14), clear(0xffffff, 0.35)), -0.3);
  const flashFill = alongX(new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.55, 12), new THREE.MeshBasicMaterial({ color: 0x9a0a12 })), -0.3);
  // the grey safety housing: a long rounded body, a lighter push-off tab with ridges on top
  const body = new THREE.Group(); body.scale.set(1, 0.78, 1.3); body.position.x = -1.95;
  body.add(alongX(new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 2.5, 6, 16), mat(0xa9adb2, { roughness: 0.6 }))));
  const tab = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.55), mat(0xd3d6d9));
  tab.position.set(-1.3, 0.27, 0);
  housing.add(chamber, flashFill, body, tab);
  for (let i = 0; i < 4; i++) { const r = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.5), mat(0xb9bdc1)); r.position.set(-0.8 - i * 0.2, 0.32, 0); housing.add(r); }
  // the extension set
  const extRest = { curve: [[-0.3, 0, -0.25], [-1.0, 0.05, -1.3], [-1.8, 0.05, -2.0], [-2.6, 0.05, -2.3], [-3.5, 0.05, -2.45], [-4.45, 0.05, -2.4]],
    clamp: [-2.6, 0.12, -2.3], port: [-6.3, 0.05, -2.4], cap: [-7.15, 0.05, -2.4] };
  const tubeCurve = new THREE.CatmullRomCurve3(extRest.curve.map((p) => new THREE.Vector3(...p)));
  const tubing = new THREE.Mesh(new THREE.TubeGeometry(tubeCurve, 40, 0.1, 8, false), clear(0xf4f8fb, 0.32));
  // the pinch clip: a base, a jaw hinged at the back that presses the tube, a hook at the front
  const clampM = new THREE.Group();
  const navy = mat(NAVY, { roughness: 0.45 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.1, 0.55), navy); base.position.y = -0.14;
  const hook = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.55), navy); hook.position.set(0.5, 0.08, 0);
  const lip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.55), navy); lip.position.set(0.4, 0.3, 0);
  const pivot = new THREE.Group(); pivot.position.set(-0.5, -0.1, 0);
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.09, 0.55), navy); jaw.position.set(0.47, 0.2, 0);
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22, 0.55), navy); ramp.position.set(0.12, 0.12, 0);
  pivot.add(jaw, ramp); clampM.add(base, hook, lip, pivot);
  // the port: a navy body with a gauge-coloured collar at the tubing, a luer end, a clear cap on it
  const port = new THREE.Group();
  const prof = [[0.1, 0], [0.16, 0.1], [0.26, 0.45], [0.31, 1.1], [0.3, 1.6], [0.22, 1.95], [0.2, 2.15], [0, 2.15]].map(([r, y]) => new THREE.Vector2(r, y));
  const portBody = new THREE.Mesh(new THREE.LatheGeometry(prof, 20), navy);
  portBody.rotation.z = Math.PI / 2; portBody.position.x = 1.85; port.add(portBody);
  port.add(alongX(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.32, 16), mat(gaugeCol)), 1.55));
  const portTip = alongX(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 0.3, 14), clear(0xf2f6f9, 0.7)), -0.45);
  port.add(portTip);
  const portCap = new THREE.Group(); portCap.position.x = -0.85; port.add(portCap);
  portCap.add(alongX(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.7, 14), clear(0xf3f6f8, 0.6))));
  portCap.add(alongX(new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.12, 14), clear(0xffffff, 0.8)), -0.32));
  clampM.position.set(...extRest.clamp); port.position.set(...extRest.port);
  // the blood in the line: a red core in the tubing, shown as far along as it has come
  const bloodTube = new THREE.Mesh(new THREE.TubeGeometry(tubeCurve, 40, 0.075, 6, false), new THREE.MeshBasicMaterial({ color: 0x8a0d16 }));
  bloodTube.geometry.setDrawRange(0, 0);
  const ext = new THREE.Group(); ext.add(tubing, bloodTube, clampM, port);
  // the hands that break the seal: a gloved thumb and finger pinching the wings and flash chamber,
  // another pair on the needle housing; the first pair rides forward with the catheter
  const glove = mat(0x6b8fd6, { roughness: 0.45 });
  // a gloved finger, tip toward -z: the last joint (rounded, its pad a little flat) and the one
  // behind it, bent up slightly at the knuckle between
  const gloveFinger = (r, pad) => {
    const f = new THREE.Group();
    const tipPts = [[0, 0], [r, 0.02], [r * 1.02, 0.42], [r * 0.95, 0.68], [r * 0.8, 0.86], [r * 0.52, 0.96], [r * 0.2, 1.0], [0, 1.01]];
    const tip = new THREE.LatheGeometry(tipPts.map(([a, b]) => new THREE.Vector2(a, b)), 18);
    tip.scale(1, 1, 0.8);                       // (the pad: flatter than round)
    const dist = new THREE.Mesh(tip, glove); dist.rotation.x = -Math.PI / 2; f.add(dist);
    const knuckle = new THREE.Mesh(new THREE.SphereGeometry(r * 1.02, 14, 10), glove); knuckle.scale.set(1, 0.82, 1); f.add(knuckle);
    const mid = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.06, r * 1.1, 1.1, 16), glove);
    mid.scale.set(1, 1, 0.84); mid.rotation.x = Math.PI / 2 + 0.18 * pad; mid.position.set(0, 0.1 * pad, 0.55); f.add(mid);
    return f;
  };
  const pinch = (parent, x) => {
    const gp = new THREE.Group();
    // thumb above, finger below, their pads on the plastic
    for (const [y, r, pad] of [[0.42, 0.23, 1], [-0.4, 0.2, -1]]) {
      const f = gloveFinger(r, pad); f.position.set(x, y, 0.15); gp.add(f);
    }
    gp.visible = false; parent.add(gp); return gp;
  };
  const hands = [pinch(hub, -0.15), pinch(housing, -1.7)];
  kit.add(needle, cathM, hub, housing, ext, sheath);
  kit.visible = false;
  // the flush on the port: a 10 mL PosiFlush (its white cap already off)
  const fsy = buildFlushSyringe(THREE, mat, clear);
  const syringe = fsy.group, saline = fsy.saline, sBlood = fsy.sBlood, plunger = fsy.plunger;
  fsy.cap.visible = false;
  syringe.visible = false; group.add(syringe);
  // the cap after the flush: a clear, faintly violet needleless connector, ribbed at its collar
  // (built along +y, out of the port)
  const luer = new THREE.Group();
  const lc = clear(0xcfc8f2, 0.6);
  const lb = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.8, 16), lc); lb.position.y = 0.38; luer.add(lb);
  for (const y of [0.06, 0.18]) { const r = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.08, 16), lc); r.position.y = y; luer.add(r); }
  const seal = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.08, 16), mat(0xf2f0fa, { transparent: true, opacity: 0.9 })); seal.position.y = 0.8; luer.add(seal);
  luer.visible = false; group.add(luer);
  // blood spilled at an open port
  const leak = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.02, 24), new THREE.MeshBasicMaterial({ color: 0x7a0a12, transparent: true, opacity: 0.85 }));
  leak.visible = false; group.add(leak);
  // the alcohol swab, under the fingers while scrubbing
  const swab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 2.2), mat(0xfafafa, { roughness: 0.95 }));
  swab.visible = false; group.add(swab);
  // the tourniquet, the traction thumb, the gauze
  // (an orange latex strip)
  const band = new THREE.Mesh(new THREE.BufferGeometry(), mat(0xe8875a, { side: THREE.DoubleSide, roughness: 0.8 }));
  band.visible = false; group.add(band);
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.8, 1.6, 6, 12), mat(0x6b8fd6, { roughness: 0.6 }));
  thumb.visible = false; group.add(thumb);
  const gauze = new THREE.Mesh(new THREE.BoxGeometry(4, 0.25, 4), mat(0xffffff, { roughness: 0.95 }));
  gauze.visible = false; group.add(gauze);
  const finger = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12), mat(0x6b8fd6, { transparent: true, opacity: 0.85 }));
  finger.visible = false; group.add(finger);
  R3 = { group, board, kit, needle, cathM, hub, housing, flashFill, ext, clampM, clampJaw: pivot, wings, sheath, hands, port, portCap, portTip, bloodTube, tubing, extRest, extAt: extRest, drapeKey: '',
    syringe, plunger, saline, sBlood, luer, swab, leak, band, thumb, gauze, finger, patch: null, rings: [], blood: null };
  R3.prep = buildPrep(THREE, mat, clear, group);
}
function disposeRoom() {
  if (!R3) return;
  ctx.three.scene.remove(R3.group);
  R3.group.traverse((o) => {
    o.geometry?.dispose?.();
    // (a mesh may carry one material or one per face)
    for (const m of [].concat(o.material || [])) { m.map?.dispose?.(); m.dispose?.(); }
  });
  R3 = null;
}

/* The working area's patch: a grid over (a, l) laid on the skin, carrying one canvas. */
const PX_PER_CM = 48;
function buildPatch() {
  const { THREE } = ctx;
  const pr = G.site.patch, a0 = pr.along[0], a1 = pr.along[1], l0 = pr.lateral[0], l1 = pr.lateral[1];
  const na = Math.ceil((a1 - a0) / 0.4), nl = Math.ceil((l1 - l0) / 0.4);
  const pos = [], uv = [], idx = [], ok = [];
  const grid = [];
  for (let i = 0; i <= na; i++) for (let j = 0; j <= nl; j++) {
    const a = a0 + (a1 - a0) * i / na, l = l0 + (l1 - l0) * j / nl;
    grid.push({ w: G.worldAt(a, l), n: G.normalAt(a, l), a, l, found: G.foundAt(a, l) });
  }
  // smoothed a few passes: found voxel by voxel (1.5 mm on the arm) the surface is stepped, and a
  // vein drawn on it wavers
  const at = (i, j) => grid[i * (nl + 1) + j];
  for (let pass = 0; pass < 4; pass++) {
    const nxt = grid.map((g) => g.w.slice());
    for (let i = 1; i < na; i++) for (let j = 1; j < nl; j++) {
      const c = at(i, j).w, s4 = [at(i - 1, j).w, at(i + 1, j).w, at(i, j - 1).w, at(i, j + 1).w];
      for (let k = 0; k < 3; k++) nxt[i * (nl + 1) + j][k] = 0.5 * c[k] + 0.125 * (s4[0][k] + s4[1][k] + s4[2][k] + s4[3][k]);
    }
    grid.forEach((g, k) => { g.w = nxt[k]; });
  }
  for (const g of grid) {
    // lifted 2.5 mm: the voxels are found to half a voxel (0.75 mm on the arm), and the smoothed
    // skin mesh over them sits up to a millimetre outside — at 0.25 mm the patch was buried in it
    pos.push(g.w[0] + g.n[0] * 0.25, g.w[1] + g.n[1] * 0.25, g.w[2] + g.n[2] * 0.25);
    uv.push((g.l - l0) / (l1 - l0), (g.a - a0) / (a1 - a0));
    // off the limb's edge the skin search finds nothing and folds back inside: hidden
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
  // (uv.y runs with `a` from the canvas's top row: unflipped, or every vein is drawn mirrored along the limb;
  // both sides drawn, as the grid's winding faces in on the hand's flat frame)
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, vertexColors: true, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  m.renderOrder = 5;
  R3.group.add(m);
  R3.patch = { mesh: m, cv, g: cv.getContext('2d'), tex, a0, a1, l0, l1, na, nl, grid };
}
// The veins as seen through the skin, as a finished layer. Costly to make (two wide blurs and a
// mask per pixel), so made once for each state that changes it — the tourniquet's fill in 5% steps,
// the difficulty, the attempt — and laid down as it is on every other repaint.
function veinLayer(fill) {
  const dif = A.difficulty ?? 0.5;
  if (dif >= 1) return null;
  const { cv } = R3.patch, fq = Math.round(fill * 20) / 20;
  const key = `${fq}|${dif}|${A.number}|${cv.width}x${cv.height}|${G.siteKey}`;
  if (veinLayer.key === key) return veinLayer.out;
  // drawn whole and opaque (no build-up where strokes overlap), then faded along their length by
  // a mask taken as the brightest of every segment's own visibility
  const mk2 = () => document.createElement('canvas');
  const V = veinLayer.V || (veinLayer.V = mk2()), M = veinLayer.M || (veinLayer.M = mk2());
  const B = veinLayer.B || (veinLayer.B = mk2()), O = veinLayer.O || (veinLayer.O = mk2());
  V.width = M.width = B.width = O.width = cv.width; V.height = M.height = B.height = O.height = cv.height;
  const v = V.getContext('2d', { willReadFrequently: true }), mk = M.getContext('2d');
  mk.fillStyle = '#000'; mk.fillRect(0, 0, M.width, M.height);
  mk.globalCompositeOperation = 'lighten';
  v.strokeStyle = 'rgb(74,88,136)'; v.lineCap = mk.lineCap = 'round'; v.lineJoin = 'round';
  for (const f of G.feats) {
    if (f.kind !== 'vein') continue;
    const lw = Math.max(2, f.radius * 2 * (1 + 0.3 * fq) / 10 * PX_PER_CM);
    v.lineWidth = lw; v.beginPath();
    f.pts.forEach((q, i) => { const [x, y] = toPx(q[0], q[1]); i ? v.lineTo(x, y) : v.moveTo(x, y); });
    v.stroke();
    mk.lineWidth = lw + 20;
    for (let i = 0; i < f.pts.length - 1; i++) {
      const k = veinShow(f, i, dif, fq);
      if (k < 0.01) continue;
      const [x0, y0] = toPx(...f.pts[i]), [x1, y1] = toPx(...f.pts[i + 1]);
      mk.strokeStyle = `rgb(${Math.round(k * 255)},0,0)`;
      mk.beginPath(); mk.moveTo(x0, y0); mk.lineTo(x1, y1); mk.stroke();
    }
  }
  // (softened, so the fade runs along the vein rather than stepping segment by segment)
  const bk = B.getContext('2d', { willReadFrequently: true });
  bk.filter = 'blur(9px)'; bk.drawImage(M, 0, 0);
  const vd = v.getImageData(0, 0, V.width, V.height), md = bk.getImageData(0, 0, B.width, B.height).data;
  const base = 0.2 + 0.22 * fq;
  for (let o = 3; o < vd.data.length; o += 4) vd.data[o] = vd.data[o] * md[o - 3] / 255 * base;
  v.putImageData(vd, 0, 0);
  // (seen through the skin: a wide haze and, over it, a soft core — no edge anywhere)
  const og = O.getContext('2d'); og.clearRect(0, 0, O.width, O.height);
  og.filter = 'blur(14px)'; og.globalAlpha = 0.85; og.drawImage(V, 0, 0);
  og.filter = 'blur(6px)'; og.globalAlpha = 0.5; og.drawImage(V, 0, 0);
  veinLayer.key = key; veinLayer.out = O;
  return O;
}
// how much of a vein shows at its i-th point (0..1). What shows is what a real arm shows first: a
// bigger, shallower vein, a fuller one, a junction; and in stretches, not end to end (the stretches
// move from attempt to attempt).
function veinShow(f, i, dif, fill) {
  if (dif <= 0) return 1;
  const [a, l] = f.pts[i];
  const size = Math.min(1.1, Math.max(0.4, f.radius / 2.6));
  const depth = Math.min(1.2, Math.max(0.25, 1.45 - veinDepthAt(f, i) / 5.5));
  let k = f.visibility * size * depth * (0.75 + 0.35 * fill) * 1.25;
  // (the harder the patient, the more the vein comes and goes along its length)
  const amp = Math.min(1, dif * 1.6);
  k *= (1 - amp) + amp * veinWave(f, i);
  if ((f.joins || []).some(([ja, jl]) => Math.hypot(a - ja, l - jl) < 0.8)) k += 0.25;
  const t = (k - (dif - 0.12)) / 0.24;
  return Math.max(0, Math.min(1, t * t * (3 - 2 * t)));
}
// where along a vein it runs nearer the skin (1) or dives (0): this attempt's own pattern
function veinWave(f, i) {
  const ph = (A.number || 1) * 2.399 + f.id.length * 0.7, s = i * 0.2;   // (points every 2 mm)
  return 0.5 + 0.5 * Math.sin(s * 1.9 + ph) * Math.cos(s * 0.71 + ph * 1.3);
}
// a harder patient's veins wander in depth: up near the skin where they show (and are felt
// best), down between — the path between the spots is found by touch
function veinDepthAt(f, i) {
  const amp = Math.min(1, (A?.difficulty ?? 0.5) * 1.6);
  return f.depth * (1 + 0.35 * amp * (1 - 2 * veinWave(f, i)));
}
// the smoothed skin at (a, l), and its normal: bilinear over the patch's own grid (the surface the
// dressing is painted 2.5 mm out from), clamped at the patch's edge
function skinAt(a, l) {
  const P3 = R3.patch, { na, nl, grid } = P3;
  const fi = Math.max(0, Math.min(na - 1e-6, (a - P3.a0) / (P3.a1 - P3.a0) * na));
  const fj = Math.max(0, Math.min(nl - 1e-6, (l - P3.l0) / (P3.l1 - P3.l0) * nl));
  const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, w = fj - j;
  const g00 = grid[i * (nl + 1) + j], g01 = grid[i * (nl + 1) + j + 1], g10 = grid[(i + 1) * (nl + 1) + j], g11 = grid[(i + 1) * (nl + 1) + j + 1];
  const mix = (k) => (g00[k].map((_, c) => (1 - u) * ((1 - w) * g00[k][c] + w * g01[k][c]) + u * ((1 - w) * g10[k][c] + w * g11[k][c])));
  return { p: mix('w'), n: v3.norm(mix('n')) };
}
// (a, l) cm -> the patch canvas, px
const toPx = (a, l) => [(l - R3.patch.l0) * PX_PER_CM, (a - R3.patch.a0) * PX_PER_CM];

/* ---- the clean grid: 2 mm cells over a 6 cm square round the mark */
const CG = { n: 31, cell: 0.2 };
function cleanCells() {
  if (!A.clean.cells) A.clean.cells = new Uint8Array(CG.n * CG.n);
  return A.clean.cells;
}

/* ---------------------------------------------------------------- painting the skin */
function paint() {
  if (!R3?.patch || !A) return;
  const { g, cv, tex } = R3.patch;
  g.clearRect(0, 0, cv.width, cv.height);
  const fill = A.tq.fill;
  // the veins under the skin: bluish, soft, fuller with the tourniquet, and as visible as the
  // difficulty allows (0: every vein drawn plainly; 0.5: the larger, shallower ones and their
  // junctions, in stretches; 1: none, palpation only)
  const vl = veinLayer(fill);
  if (vl) g.drawImage(vl, 0, 0);
  if (A.mark) {
    const [mx, my] = toPx(A.mark.a, A.mark.l);
    // the prep: wet, then dry
    const cells = A.clean.cells;
    if (cells) {
      // a wet sheen where the pad has been, soft-edged (drawn opaque into a mask, then laid down
      // once: overlapping translucent cells mottled); dry, it all but vanishes
      const off = paint.mask || (paint.mask = document.createElement('canvas'));
      off.width = cv.width; off.height = cv.height;
      const o = off.getContext('2d');
      o.fillStyle = '#d0e4ff';
      const half = (CG.n - 1) / 2, s = CG.cell * PX_PER_CM * 1.3;
      for (let i = 0; i < CG.n; i++) for (let j = 0; j < CG.n; j++) {
        if (!cells[i * CG.n + j]) continue;
        // (cells are in the vein's frame: i along, j across)
        const da = (i - half) * CG.cell, dl = (j - half) * CG.cell;
        const [x, y] = toPx(A.mark.a + da * A.mark.tan[0] - dl * A.mark.tan[1], A.mark.l + da * A.mark.tan[1] + dl * A.mark.tan[0]);
        o.fillRect(x - s / 2, y - s / 2, s, s);
      }
      g.save(); g.filter = 'blur(5px)'; g.globalAlpha = A.clean.dry ? 0.07 + 0.31 * Math.max(0, 1 - (A.t - (A.clean.dryAt ?? A.t)) / 12) : 0.38;
      g.drawImage(off, 0, 0); g.restore();
    }
    // the target circle (Guided)
    if (A.mode === 'guided' && IV.currentStep(A) === 'clean') {
      g.strokeStyle = 'rgba(255,255,255,0.7)'; g.setLineDash([6, 5]); g.lineWidth = 2;
      g.beginPath(); g.arc(mx, my, P.clean.radiusMM / 10 * PX_PER_CM, 0, 2 * Math.PI); g.stroke(); g.setLineDash([]);
    }
    // haematoma and infiltration
    if (A.hematoma > 0) {
      const r = (0.5 + 2.2 * A.hematoma) * PX_PER_CM, gr = g.createRadialGradient(mx, my, 0, mx, my, r);
      gr.addColorStop(0, `rgba(70,20,60,${0.75 * A.hematoma})`); gr.addColorStop(1, 'rgba(70,20,60,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(mx, my, r, 0, 2 * Math.PI); g.fill();
    }
    if (A.infiltration > 0) {
      const tip = siteOfTip(), r = (0.6 + 1.2 * Math.min(1, A.infiltration / 2)) * PX_PER_CM;
      const gr = g.createRadialGradient(tip[0], tip[1], 0, tip[0], tip[1], r);
      gr.addColorStop(0, 'rgba(255,255,250,0.7)'); gr.addColorStop(1, 'rgba(255,255,250,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(tip[0], tip[1], r, 0, 2 * Math.PI); g.fill();
    }
    // the mark
    g.fillStyle = '#7a3fd0'; g.beginPath(); g.arc(mx, my, 4, 0, 2 * Math.PI); g.fill();
    // the dressing, a Tegaderm IV: a cloth border, a clear window over the site, and a notch at the
    // hub's end the catheter leaves through. Local x runs along the vein (toward the heart), y across.
    if (A.dressing.placed) {
      const ang = Math.atan2(A.mark.tan[0], A.mark.tan[1]);
      const [dx, dy] = toPx(A.dressingAt.a, A.dressingAt.l);
      g.save(); g.translate(dx, dy); g.rotate(ang);
      const C = PX_PER_CM, X = 3.5 * C, Y = 3 * C, r = 0.6 * C, nx = -1.7 * C, ny = 0.3 * C;
      const rr = (x0, y0, x1, y1, k) => { g.moveTo(x0 + k, y0); g.arcTo(x1, y0, x1, y1, k); g.arcTo(x1, y1, x0, y1, k); g.arcTo(x0, y1, x0, y0, k); g.arcTo(x0, y0, x1, y0, k); g.closePath(); };
      // the outline, the notch cut into its back edge; the window a hole in the border
      g.beginPath();
      g.moveTo(-X, -ny); g.lineTo(nx, -ny); g.lineTo(nx, ny); g.lineTo(-X, ny);
      g.arcTo(-X, Y, 0, Y, r); g.arcTo(X, Y, X, 0, r); g.arcTo(X, -Y, 0, -Y, r); g.arcTo(-X, -Y, -X, -ny, r); g.closePath();
      rr(-1.3 * C, -2 * C, 2.6 * C, 2 * C, 0.4 * C);
      g.fillStyle = 'rgba(244,238,222,0.85)'; g.fill('evenodd');
      // the window: clear film, a faint blue edge
      g.beginPath(); rr(-1.3 * C, -2 * C, 2.6 * C, 2 * C, 0.4 * C);
      g.fillStyle = 'rgba(232,243,252,0.22)'; g.fill();
      g.strokeStyle = 'rgba(140,180,215,0.7)'; g.lineWidth = 2; g.stroke();
      // the cloth's weave on the border
      g.strokeStyle = 'rgba(205,196,172,0.45)'; g.lineWidth = 1;
      for (let x = -X + 6; x < X; x += 7) { g.beginPath(); g.moveTo(x, -Y + 4); g.lineTo(x, -2 * C - 4); g.moveTo(x, 2 * C + 4); g.lineTo(x, Y - 4); g.stroke(); }
      // the edges: pressed down, they show bright (0 front, 1 and 3 the sides, 2 the notched back)
      g.lineWidth = 5;
      A.dressing.edges.forEach((on, i) => {
        g.strokeStyle = on ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.3)';
        g.beginPath();
        if (i === 0) { g.moveTo(X, -Y + r); g.lineTo(X, Y - r); }
        if (i === 1) { g.moveTo(-X + r, -Y); g.lineTo(X - r, -Y); }
        if (i === 2) { g.moveTo(-X, -Y + r); g.lineTo(-X, -ny); g.moveTo(-X, ny); g.lineTo(-X, Y - r); }
        if (i === 3) { g.moveTo(-X + r, Y); g.lineTo(X - r, Y); }
        g.stroke();
      });
      g.restore();
    }
  }
  tex.needsUpdate = true;
}
// would a dressing laid at h (7 cm along the vein, 6 across) cover the insertion site and both of
// the catheter's wings?
function dressingCovers(h) {
  const t = A.mark.tan, { THREE } = ctx;
  const inside = (a, l) => {
    const da = a - h.a, dl = l - h.l, along = da * t[0] + dl * t[1], across = -da * t[1] + dl * t[0];
    return Math.abs(along) <= 3.3 && Math.abs(across) <= 2.8;
  };
  if (!inside(A.mark.a, A.mark.l)) return false;
  R3.kit.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  for (const w of R3.wings) {
    const pos = w.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 7) {
      v.fromBufferAttribute(pos, i).applyMatrix4(w.matrixWorld);
      const { a, l } = G.paramOf(G.fromWorld([v.x, v.y, v.z]));
      if (!inside(a, l)) return false;
    }
  }
  return true;
}
// where the catheter's tip is on the patch canvas
function siteOfTip() {
  const q = IV.catheterTip(A), m = A.mark;
  const da = q[0] / 10, dl = (q[1] - m.lateral) / 10;
  return toPx(m.a + da * m.tan[0] - dl * m.tan[1], m.l + da * m.tan[1] + dl * m.tan[0]);
}

/* ---------------------------------------------------------------- the needle frame */
// the vein's frame at the mark, in the world: X along the vein (toward the heart), Y across, Z in
function veinFrame() {
  const m = A.mark, E = G.worldAt(m.a, m.l), n = G.normalAt(m.a, m.l);
  const p1 = G.worldAt(m.a + m.tan[0] * 0.3, m.l + m.tan[1] * 0.3);
  let X = v3.norm(v3.sub(p1, E));
  X = v3.norm(v3.sub(X, v3.mul(n, v3.dot(X, n))));
  const Z = v3.mul(n, -1), Y = v3.norm(v3.cross(Z, X));
  // +Y must be the side the engine calls positive: toward +across on the skin
  const pY = G.worldAt(m.a - m.tan[1] * 0.3, m.l + m.tan[0] * 0.3);
  const s = v3.dot(v3.sub(pY, E), Y) < 0 ? -1 : 1;
  return { E, X, Y: v3.mul(Y, s), Z };
}
// an engine point (mm, vein frame) in the world (cm)
function engineToWorld(F, q) {
  return v3.add(F.E, v3.add(v3.mul(F.X, q[0] / 10), v3.add(v3.mul(F.Y, (q[1] - A.mark.lateral) / 10), v3.mul(F.Z, q[2] / 10))));
}
function engineDirWorld(F, d) { return v3.norm(v3.add(v3.mul(F.X, d[0]), v3.add(v3.mul(F.Y, d[1]), v3.mul(F.Z, d[2])))); }
function orient(obj, pos, dir, up) {
  const { THREE } = ctx;
  const x = new THREE.Vector3(...dir).normalize();
  const z = new THREE.Vector3().crossVectors(x, new THREE.Vector3(...up)).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  obj.matrix.makeBasis(x, y, z); obj.matrix.setPosition(...pos);
  obj.matrixAutoUpdate = false; obj.matrixWorldNeedsUpdate = true;
}

/* ---------------------------------------------------------------- the prep table
   Supplies are opened beside the patient on a steel table: the alcohol swab torn open at its notched
   corner and the swab taken out; the IV's pack peeled open from its tab, the IV lifted out, and its
   seal broken in hand (the catheter slid a millimetre off the needle and back) before it goes to
   the arm. Prep-table frame: X along the limb, Y up, Z toward the patient. */
const SWAB_AT = [-13, 0, 4], PACK_AT = [6, 0, -4], KIT_IN_PACK = [5.2, 0.45, 0.78];
const SHARPS_AT = [-10, 0, -7], FLUSH_AT = [-2.5, 0, 6], TEGA_AT = [10.5, 0, 6.5], CAPP_AT = [16, 0, -6], GAUZE_AT = [17, 0, 4], TQ_AT = [-2, 0, 11.8];
const PREP0 = { swab: 'closed', swabT: 0, swabPop: 0, swabLift: 0, pack: 'closed', packT: 0, lift: 0, sealPeak: 0, atSite: false,
  flush: 'closed', flushT: 0, flushLift: 0, capOff: 0, sharps: 'held', sharpT: 0, flip: 0, drop: 0 };
const PREP = { ...PREP0 };
function resetPrep() { Object.assign(PREP, PREP0); }
const kitAtSite = () => !!A && (A.done.has('seal') || A.needle.inSkin || PREP.atSite);
// the spent needle is in hand, on its way to the sharps container
const sharpsStage = () => !!A && A.needle.shielded && !A.needle.disposed && !A.ended;
const SLEEVE = { L: 15.5, W: 3.8 };
const LID = { L: 13.6, W: 7.4, x0: -6.8, nx: 72, nz: 8, y: 1.25, curl: 0.35, tab: 1.1 };

function buildPrep(THREE, mat, clear, group) {
  const g = new THREE.Group(); group.add(g);
  const ax = (m, x = 0) => { m.rotation.z = -Math.PI / 2; m.position.x = x; return m; };
  const canvasTex = (w, h, draw) => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h; draw(cv.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
  };
  const table = new THREE.Mesh(new THREE.BoxGeometry(40, 0.6, 26), mat(0x8e979f, { metalness: 0.5, roughness: 0.45 }));
  table.position.y = -0.3; g.add(table);

  // ---- the alcohol swab: a printed foil packet; the strip across its top tears off from the notch,
  // left to right, and the swab inside rides up out of the opening
  const sw = new THREE.Group(); sw.position.set(...SWAB_AT); g.add(sw);
  const stex = canvasTex(256, 256, (c) => {
    c.fillStyle = '#f6f7f9'; c.fillRect(0, 0, 256, 256);
    c.strokeStyle = '#cfd4da'; c.lineWidth = 1;
    for (let i = 8; i < 250; i += 5) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, 11); c.moveTo(i, 245); c.lineTo(i, 256); c.moveTo(0, i); c.lineTo(11, i); c.moveTo(245, i); c.lineTo(256, i); c.stroke(); }
    c.fillStyle = '#2f74c0'; c.fillRect(26, 74, 204, 90);
    c.fillStyle = '#fff'; c.textAlign = 'center'; c.font = 'bold 34px Arial, sans-serif';
    c.fillText('ALCOHOL', 128, 114); c.fillText('SWAB', 128, 152);
    c.fillStyle = '#2f74c0'; c.font = 'bold 15px Arial, sans-serif'; c.fillText('70% Isopropyl Alcohol', 128, 190);
    c.fillStyle = '#4c5a68'; c.font = '12px Arial, sans-serif'; c.textAlign = 'left';
    c.fillText('• For external use only', 40, 214); c.fillText('• Sterile', 40, 230);
    // the tear: a notch at the top left, a dotted line across
    c.fillStyle = '#8f99a3'; c.beginPath(); c.moveTo(0, 32); c.lineTo(12, 42); c.lineTo(0, 52); c.closePath(); c.fill();
    c.strokeStyle = '#a7b0b9'; c.setLineDash([3, 4]); c.lineWidth = 1.5; c.beginPath(); c.moveTo(14, 42); c.lineTo(254, 42); c.stroke();
    c.setLineDash([]); c.fillStyle = '#8f99a3'; c.font = 'bold 13px Arial, sans-serif'; c.fillText('TEAR →', 18, 32);
  });
  const uvFrom = (geo) => {
    const pos = geo.attributes.position, uv = [];
    for (let i = 0; i < pos.count; i++) uv.push((pos.getX(i) + 2.75) / 5.5, (pos.getY(i) + 2.75) / 5.5);
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return geo;
  };
  const back = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.08, 4.6), mat(0xe9ecef));
  back.position.set(0, 0.04, 0.45); sw.add(back);
  const face = new THREE.Group(); face.rotation.x = -Math.PI / 2; face.position.y = 0.17; sw.add(face);
  const fs = new THREE.Shape(); fs.moveTo(-2.75, -2.75); fs.lineTo(2.75, -2.75); fs.lineTo(2.75, 1.85); fs.lineTo(-2.75, 1.85); fs.closePath();
  const sheet = mat(0xffffff, { map: stex, side: THREE.DoubleSide, roughness: 0.4, metalness: 0.15 });
  face.add(new THREE.Mesh(uvFrom(new THREE.ShapeGeometry(fs)), sheet));
  const stripGeo = new THREE.PlaneGeometry(5.5, 0.9, 22, 1); stripGeo.translate(0, 2.3, 0); uvFrom(stripGeo);
  const stripRest = stripGeo.attributes.position.array.slice();
  const strip = new THREE.Mesh(stripGeo, sheet); face.add(strip);
  const pad = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.1, 4.0), mat(0xfbfbfa, { roughness: 0.95 }));
  pad.position.set(0, 0.11, 0.6); sw.add(pad);

  // ---- the IV's pack: a clear blister, the IV laid in it, under a printed paper lid with a pull tab
  const pk = new THREE.Group(); pk.position.set(...PACK_AT); g.add(pk);
  const rr = (w, h, r) => {
    const sh = new THREE.Shape(), x = -w / 2, y = -h / 2;
    sh.moveTo(x + r, y); sh.lineTo(x + w - r, y); sh.quadraticCurveTo(x + w, y, x + w, y + r); sh.lineTo(x + w, y + h - r);
    sh.quadraticCurveTo(x + w, y + h, x + w - r, y + h); sh.lineTo(x + r, y + h); sh.quadraticCurveTo(x, y + h, x, y + h - r);
    sh.lineTo(x, y + r); sh.quadraticCurveTo(x, y, x + r, y); return sh;
  };
  const floor = new THREE.Mesh(new THREE.ShapeGeometry(rr(13, 7, 0.7)), clear(0xdcecf8, 0.4));
  floor.material.side = THREE.DoubleSide; floor.rotation.x = -Math.PI / 2; floor.position.y = 0.02; pk.add(floor);
  const ring = rr(13, 7, 0.7); ring.holes.push(rr(12.3, 6.3, 0.5));
  const rim = new THREE.Mesh(new THREE.ExtrudeGeometry(ring, { depth: 1.22, bevelEnabled: false }), clear(0xc9e0f4, 0.5));
  rim.rotation.x = -Math.PI / 2; pk.add(rim);
  // the lid: one sheet, folded back over itself as it peels (label above, plain paper beneath)
  const lidGeo = new THREE.BufferGeometry(), nx = LID.nx, rest = [], uv = [], idx = [];
  const nz = LID.nz;
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) {
    const x = LID.x0 + LID.L * i / nx, z = -LID.W / 2 + LID.W * j / nz;
    rest.push([x, z]); uv.push(i / nx, 1 - j / nz);
  }
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const a = i * (nz + 1) + j, c = a + nz + 1;
    idx.push(a, a + 1, c, c, a + 1, c + 1);
  }
  lidGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(rest.length * 3), 3));
  lidGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  lidGeo.setIndex(idx);
  const lc = document.createElement('canvas'); lc.width = 1024; lc.height = 557;
  const ltex = new THREE.CanvasTexture(lc); ltex.colorSpace = THREE.SRGBColorSpace; ltex.anisotropy = 4;
  const lid = new THREE.Mesh(lidGeo, mat(0xffffff, { map: ltex, roughness: 0.8 }));
  const lidBack = new THREE.Mesh(lidGeo, mat(0xf1f2f0, { side: THREE.BackSide, roughness: 0.9 }));
  pk.add(lid, lidBack);

  // ---- the sharps container: yellow, labelled, a black safety tray in its lid hinged at the back,
  // flipped up to drop what lies on it inside
  const sh = new THREE.Group(); sh.position.set(...SHARPS_AT); g.add(sh);
  const yel = mat(0xf2c418, { roughness: 0.45 }), blk = mat(0x1c1e21, { roughness: 0.6 });
  const shBody = new THREE.Mesh(new THREE.BoxGeometry(16, 9, 9), yel); shBody.position.y = 4.5; sh.add(shBody);
  const shTex = canvasTex(1024, 512, paintSharpsLabel);
  const shLabel = new THREE.Mesh(new THREE.PlaneGeometry(12.4, 6.2), mat(0xffffff, { map: shTex, roughness: 0.6 }));
  shLabel.position.set(-0.9, 4.4, 4.51); sh.add(shLabel);
  const win = new THREE.Mesh(new THREE.CapsuleGeometry(0.6, 1.3, 4, 12), mat(0x3a1012, { roughness: 0.25 }));
  win.scale.z = 0.12; win.position.set(6.5, 4.6, 4.5); sh.add(win);
  const shLid = new THREE.Mesh(new THREE.BoxGeometry(16.6, 1.4, 9.6), yel); shLid.position.y = 9.7; sh.add(shLid);
  for (const lx of [-5.5, 5.5]) { const k = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.5, 2.2), yel); k.position.set(lx, 10.6, 0.3); sh.add(k); }
  const hole = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.06, 5.6), blk); hole.position.set(0, 10.42, 0.4); sh.add(hole);
  const latch = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.9, 0.5), blk); latch.position.set(0, 9.1, 4.85); sh.add(latch);
  for (let i = 0; i < 4; i++) { const r = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.7, 0.1), mat(0x2c2f33)); r.position.set(-0.75 + i * 0.5, 9.1, 5.13); sh.add(r); }
  for (const ex of [-8.45, 8.45]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.7, 1.8), blk); l.position.set(ex, 9.6, 0); sh.add(l); }
  const trayPivot = new THREE.Group(); trayPivot.position.set(0, 10.55, -2.4); sh.add(trayPivot);
  const tplate = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.18, 5.4), blk); tplate.position.set(0, 0.09, 2.7); trayPivot.add(tplate);
  const tlip = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.8, 0.22), blk); tlip.position.set(0, 0.4, 5.3); trayPivot.add(tlip);
  for (let i = 0; i < 6; i++) { const r = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 4.2), mat(0x2a2d31)); r.position.set(-2.9 + i * 1.16, 0.22, 2.6); trayPivot.add(r); }

  // ---- the needle as it comes out (a child of the table, placed in its frame): the grey housing
  // with its ridged push-off tab, the bare needle, the white shield closed over the tip
  const spent = new THREE.Group(); spent.visible = false; g.add(spent);
  const grey = mat(0xb6babe, { roughness: 0.55 }), white = mat(0xf4f4f2, { roughness: 0.45 });
  const hb = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.72, 0.82), grey); hb.position.x = -3.5; spent.add(hb);
  const hTop = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.18, 0.6), grey); hTop.position.set(-3.3, 0.44, 0); spent.add(hTop);
  const ptab = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.7, 0.7), grey); ptab.position.set(-4.45, 0.55, 0); ptab.rotation.z = 0.3; spent.add(ptab);
  for (let i = 0; i < 4; i++) { const r = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.62, 0.66), mat(0xa4a8ac)); r.position.set(-4.62 + i * 0.09, 0.62 - i * 0.03, 0); r.rotation.z = 0.3; spent.add(r); }
  spent.add(ax(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.2, 0.5, 12), grey), -2.2));
  spent.add(ax(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 4.4, 8), mat(0xd9dde2, { metalness: 0.9, roughness: 0.2 })), 0.15));
  const shield = new THREE.Group(); shield.position.x = 2.9; spent.add(shield);
  shield.add(ax(new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.9, 6, 14), white), 0.25));
  for (const sd of [1, -1]) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.12, 0.5), white);
    f.position.set(-0.55, 0.12 * sd, 0); f.rotation.z = 0.32 * sd; shield.add(f);
  }

  // ---- the flush in its printed sleeve; the sleeve tears open down its length
  const fl = new THREE.Group(); fl.position.set(...FLUSH_AT); g.add(fl);
  const slTex = canvasTex(1024, 256, paintFlushSleeve);
  const slMat = mat(0xffffff, { map: slTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.3, metalness: 0.1 });
  const bottom = new THREE.Mesh(new THREE.PlaneGeometry(SLEEVE.L, SLEEVE.W), slMat); bottom.rotation.x = -Math.PI / 2; bottom.position.y = 0.03; fl.add(bottom);
  const topGeo = new THREE.PlaneGeometry(SLEEVE.L, SLEEVE.W, 48, 6); topGeo.rotateX(-Math.PI / 2); topGeo.translate(0, 1.6, 0);
  const topRest = topGeo.attributes.position.array.slice();
  fl.add(new THREE.Mesh(topGeo, slMat));
  // the sides, a crinkled fold of the same film
  for (const sz of [-1, 1]) { const sd = new THREE.Mesh(new THREE.PlaneGeometry(SLEEVE.L, 1.6), slMat); sd.position.set(0, 0.8, sz * SLEEVE.W / 2); fl.add(sd); }
  const fsy = buildFlushSyringe(THREE, mat, clear);
  const syr = fsy.group; syr.position.set(6.4, 0.8, 0); fl.add(syr);
  const wcap = fsy.cap;
  // ---- the rest of the supplies, laid out: the tourniquet strip, the dressing in its packet, a
  // needleless cap in its blister, a stack of gauze
  const tq = new THREE.Mesh(new THREE.BoxGeometry(25, 0.06, 2.5), mat(0xe8875a, { roughness: 0.8 }));
  tq.position.set(TQ_AT[0], 0.03, TQ_AT[2]); g.add(tq);
  const tegaTex = canvasTex(256, 288, (c, w, h) => {
    c.fillStyle = '#f9fafb'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#1f5fae'; c.fillRect(0, 0, w, 64);
    c.fillStyle = '#fff'; c.font = 'bold 30px Arial, sans-serif'; c.textAlign = 'center'; c.fillText('Tegaderm™ I.V.', w / 2, 42);
    c.strokeStyle = '#8fa3b8'; c.lineWidth = 4; c.strokeRect(58, 96, 140, 150);
    c.strokeStyle = '#9fc0dc'; c.strokeRect(84, 122, 88, 70);
    c.fillStyle = '#5c6670'; c.font = '16px Arial, sans-serif'; c.fillText('Transparent film dressing', w / 2, 272);
  });
  const tega = new THREE.Mesh(new THREE.BoxGeometry(8, 0.15, 9), [mat(0xf2f4f6), mat(0xf2f4f6), mat(0xffffff, { map: tegaTex, roughness: 0.8 }), mat(0xf2f4f6), mat(0xf2f4f6), mat(0xf2f4f6)]);
  tega.position.set(TEGA_AT[0], 0.08, TEGA_AT[2]); g.add(tega);
  const capP = new THREE.Group(); capP.position.set(...CAPP_AT); g.add(capP);
  capP.add(new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.9, 2.6), clear(0xe2edf7, 0.35))).position.y = 0.45;
  const capIn = new THREE.Group(); capIn.position.y = 0.42; capP.add(capIn);
  const lav = clear(0xcfc8f2, 0.65);
  capIn.add(ax(new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 1.6, 14), lav), 0));
  for (const x of [-0.6, -0.45]) capIn.add(ax(new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.08, 14), lav), x));
  const gz = new THREE.Group(); gz.position.set(...GAUZE_AT); g.add(gz);
  for (let i = 0; i < 3; i++) { const sq = new THREE.Mesh(new THREE.BoxGeometry(5, 0.12, 5), mat(0xfcfcfa, { roughness: 0.95 })); sq.position.y = 0.06 + i * 0.13; sq.rotation.y = (i - 1) * 0.12; gz.add(sq); }

  return { group: g, swab: { group: sw, strip, stripGeo, stripRest, pad },
    pack: { group: pk, lid, lidBack, lidGeo, rest, lc, ltex },
    sharps: { group: sh, trayPivot }, spent,
    flush: { group: fl, topGeo, topRest, syr, wcap },
    sup: { tq, tega, capIn, gz } };
}
// A 10 mL saline flush, after BD's PosiFlush: a clear barrel half wrapped in its printed label with
// the scale on it, a grey ribbed stopper, a clear cross-ribbed rod and round press, oval grips, the
// luer tip and, until it comes off, its white cap. Along +x, the tip at 0; the stopper's front at
// the plunger group's own 0 (placed by the caller: -6 when full).
let flushLabelTex = null;
function buildFlushSyringe(THREE, mat, clear) {
  const ax = (m, x = 0) => { m.rotation.z = -Math.PI / 2; m.position.x = x; return m; };
  const g = new THREE.Group();
  g.add(ax(new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 6.5, 28, 1, true), clear(0xffffff, 0.28)), -3.6));
  if (!flushLabelTex) {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 1024;
    const c = cv.getContext('2d');
    c.fillStyle = 'rgba(250,250,248,0.94)'; c.fillRect(0, 0, 256, 1024);
    // the scale, 1 to 10 mL from the tip back, a tick each half mL
    c.fillStyle = '#2a2d31'; c.font = 'bold 24px Arial, sans-serif'; c.textAlign = 'left';
    for (let i = 1; i <= 20; i++) {
      const y = i * 0.55 / 2 / 5.6 * 1024;
      c.fillRect(196, y - 1.5, i % 2 ? 26 : 50, 3);
      if (i % 2 === 0) { c.save(); c.translate(150, y + 9); c.fillText(String(i / 2), 0, 0); c.restore(); }
    }
    c.save(); c.translate(150, 1000); c.font = 'bold 22px Arial, sans-serif'; c.fillText('mL', 0, 0); c.restore();
    // the print, along the barrel
    // (read from the stopper's end toward the tip, upright as the syringe lies)
    c.save(); c.translate(56, 990); c.rotate(-Math.PI / 2);
    c.fillStyle = '#d24f26'; c.font = 'bold 34px Arial, sans-serif'; c.fillText('BD PosiFlush\u2122 SP Syringe', 0, 0);
    c.font = 'bold 28px Arial, sans-serif'; c.fillText('0.9% Sodium Chloride (0.9% NaCl) 10 mL', 0, 38);
    c.fillStyle = '#4b5056'; c.font = '20px Arial, sans-serif'; c.fillText('FOR FLUSHING ONLY \u00b7 STERILE FLUID PATH', 0, 72);
    c.font = 'bold 30px Arial, sans-serif'; c.fillText('REF 306575', 560, 74);
    c.restore();
    // the dashed band at the stopper's end
    c.fillStyle = '#1e2124'; for (let k = 0; k < 9; k++) c.fillRect(20 + k * 22, 990, 12, 12);
    flushLabelTex = new THREE.CanvasTexture(cv); flushLabelTex.colorSpace = THREE.SRGBColorSpace; flushLabelTex.anisotropy = 4;
  }
  // (centred on the barrel's top as it lies: theta 3pi/2 after the turn along x)
  g.add(ax(new THREE.Mesh(new THREE.CylinderGeometry(0.762, 0.762, 5.6, 28, 1, true, 1.5 * Math.PI - 1.15, 2.3),
    new THREE.MeshStandardMaterial({ map: flushLabelTex, transparent: true, roughness: 0.6, side: THREE.DoubleSide })), -3.3));
  // the finger grips: an oval flange
  const fl = ax(new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 0.16, 28), clear(0xf4f6f8, 0.8)), -6.9);
  fl.scale.set(1, 1, 0.55); g.add(fl);
  g.add(ax(new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.26, 0.55, 14), clear(0xffffff, 0.85)), 0.15));
  g.add(ax(new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.45, 0.3, 18), clear(0xffffff, 0.7)), -0.1));
  const saline = ax(new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1, 20), clear(0xe8f3fb, 0.35)));
  const sBlood = ax(new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.66, 1, 18), clear(0x9a1020, 0.5)));
  sBlood.visible = false;
  g.add(saline, sBlood);
  const plunger = new THREE.Group();
  const grey = mat(0x6d7176, { roughness: 0.75 });
  plunger.add(ax(new THREE.Mesh(new THREE.CylinderGeometry(0.71, 0.71, 0.6, 22), grey), -0.3));
  for (const x of [-0.08, -0.52]) plunger.add(ax(new THREE.Mesh(new THREE.CylinderGeometry(0.74, 0.74, 0.09, 22), grey), x));
  const rodM = clear(0xf2f4f6, 0.82);
  const rA = new THREE.Mesh(new THREE.BoxGeometry(6.3, 0.12, 1.0), rodM); rA.position.x = -3.75; plunger.add(rA);
  const rB = new THREE.Mesh(new THREE.BoxGeometry(6.3, 1.0, 0.12), rodM); rB.position.x = -3.75; plunger.add(rB);
  plunger.add(ax(new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.14, 24), rodM), -6.95));
  plunger.position.x = -6.0;
  g.add(plunger);
  // the white tip cap: square-ribbed
  const cap = new THREE.Group(); cap.position.x = 0.75; g.add(cap);
  const white = mat(0xf6f6f4, { roughness: 0.45 });
  cap.add(ax(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.9, 16), white)));
  for (let k = 0; k < 4; k++) {
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.12, 0.14), white);
    const t = k * Math.PI / 2; rib.position.set(-0.05, Math.cos(t) * 0.33, Math.sin(t) * 0.33); rib.rotation.x = t; cap.add(rib);
  }
  return { group: g, saline, sBlood, plunger, cap };
}
// the flush's sleeve: clear film printed all over in grey, both faces; the top one tears open
// down the length
function paintFlushSleeve(c, W, H) {
  c.fillStyle = 'rgba(236,240,244,0.22)'; c.fillRect(0, 0, W, H);
  // (small, grey, a little crooked: the syringe shows through between the lines)
  c.fillStyle = 'rgba(64,68,74,0.55)'; c.font = 'bold 15px Arial, sans-serif';
  const line = 'BD PosiFlush™ SP Syringe     0.9% Sodium Chloride     10 mL     ';
  for (let r = 0; r < 4; r++) {
    c.save(); c.translate(30 - r * 90, 34 + r * 62); c.rotate(-0.015 + r * 0.01);
    c.globalAlpha = r % 2 ? 0.45 : 0.75; c.fillText(line + line + line, 0, 0); c.restore();
  }
  c.globalAlpha = 0.7;
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) if (((i * 5 + j * 3 + i * j) % 4) < 2) c.fillRect(W - 130 + i * 5, 96 + j * 5, 5, 5);
  c.globalAlpha = 1;
  // the crimped ends
  c.fillStyle = 'rgba(120,124,130,0.4)';
  for (let y = 0; y < H; y += 8) { c.fillRect(0, y, 22, 3); c.fillRect(W - 22, y, 22, 3); }
}
// the sleeve's top face, torn open along its length up to t (0..1): it lifts away from the tear,
// hinged on its far long edge
function setSleeve(t) {
  const { topGeo, topRest } = R3.prep.flush, pos = topGeo.attributes.position, L = SLEEVE.L, W = SLEEVE.W;
  const xf = -L / 2 + L * t;
  for (let i = 0; i < pos.count; i++) {
    const x = topRest[3 * i], z = topRest[3 * i + 2], d = Math.max(0, xf - x);
    const th = Math.min(2.6, d * 1.1), u = z + W / 2;                   // (distance from the hinge edge)
    pos.setXYZ(i, x, topRest[3 * i + 1] + u * Math.sin(th), -W / 2 + u * Math.cos(th));
  }
  pos.needsUpdate = true; topGeo.computeVertexNormals(); topGeo.computeBoundingSphere();
}
// the sharps container's label: a biohazard mark, the warnings, the fill line
function paintSharpsLabel(c, W, H) {
  c.fillStyle = '#f2c418'; c.fillRect(0, 0, W, H);
  c.fillStyle = '#f7da55'; c.strokeStyle = '#3a3a2a'; c.lineWidth = 4;
  c.beginPath(); c.roundRect(10, 10, W - 20, H - 20, 60); c.fill(); c.stroke();
  // the instructions, as pictures
  for (let i = 0; i < 4; i++) { c.strokeStyle = '#3a3a2a'; c.lineWidth = 3; c.strokeRect(90, 70 + i * 95, 120, 80); c.fillStyle = '#e9ce48'; c.fillRect(104, 92 + i * 95, 92, 36); }
  // the biohazard mark
  const bx = 470, by = 230;
  c.strokeStyle = '#111'; c.lineWidth = 6; c.strokeRect(bx - 95, by - 105, 190, 230);
  c.lineWidth = 12;
  for (let k = 0; k < 3; k++) {
    const a = -Math.PI / 2 + k * 2 * Math.PI / 3;
    c.beginPath(); c.arc(bx + Math.cos(a) * 34, by + Math.sin(a) * 34, 36, 0, 2 * Math.PI); c.stroke();
  }
  c.beginPath(); c.arc(bx, by, 20, 0, 2 * Math.PI); c.stroke();
  c.fillStyle = '#111'; c.textAlign = 'center'; c.font = 'bold 28px Arial, sans-serif'; c.fillText('BIOHAZARD', bx, by + 100);
  c.font = 'bold 30px Arial, sans-serif'; c.fillText('Caution : Waste Sharps', bx, by + 168);
  c.font = 'bold 54px Arial, sans-serif'; c.fillStyle = '#3d6f3a'; c.fillText('Sharps', bx, 110);
  c.fillStyle = '#111'; c.font = 'bold 22px Arial, sans-serif';
  c.fillText('↓ DO NOT FILL ABOVE THIS LEVEL ↓', 800, 230);
  c.lineWidth = 3; c.beginPath(); c.moveTo(640, 244); c.lineTo(960, 244); c.stroke();
  c.font = 'bold 40px Arial, sans-serif'; c.fillText('↑↑', 800, 340); c.font = '20px Arial, sans-serif'; c.fillText('THIS WAY UP', 800, 372);
}
// the swab packet's top strip, torn from the left up to t (0..1)
function setStrip(t) {
  const { stripGeo, stripRest } = R3.prep.swab, pos = stripGeo.attributes.position, xf = -2.75 + 5.5 * t;
  for (let i = 0; i < pos.count; i++) {
    const x = stripRest[3 * i], y = stripRest[3 * i + 1], d = Math.max(0, xf - x);
    pos.setXYZ(i, x - d * 0.15, y + d * 0.25, Math.min(2.2, d * 0.6));
  }
  pos.needsUpdate = true; stripGeo.computeVertexNormals(); stripGeo.computeBoundingSphere();
}
// the lid's label, after the real one: the gauge's band in its colour
function paintLid() {
  const { lc, ltex } = R3.prep.pack, c = lc.getContext('2d'), W = lc.width, H = lc.height, gauge = P.gauges[setup.gauge];
  c.fillStyle = '#eef1f4'; c.fillRect(0, 0, W, H);
  c.fillStyle = '#f8fafb'; c.strokeStyle = '#d3d9df'; c.lineWidth = 3;
  c.beginPath(); c.roundRect(70, 26, W - 100, H - 52, 30); c.fill(); c.stroke();
  // the tab's mark: a triangle by the corner, under the band
  c.strokeStyle = '#8f979f'; c.lineWidth = 7; c.lineJoin = 'miter';
  c.beginPath(); c.moveTo(96, 478); c.lineTo(96, 540); c.lineTo(156, 540); c.closePath(); c.stroke();
  c.fillStyle = '#5c636b'; c.textAlign = 'left';
  c.font = '600 48px Arial, sans-serif'; c.fillText('BD Nexiva™ Diffusics™', 130, 104);
  c.font = '24px Arial, sans-serif'; c.fillText('Closed IV Catheter System.', 130, 142);
  // the line drawing: the catheter in its box
  c.strokeStyle = '#6c737b'; c.lineWidth = 3; c.strokeRect(130, 166, 190, 168);
  c.beginPath(); c.moveTo(150, 300); c.lineTo(250, 220); c.lineTo(262, 236); c.lineTo(162, 316); c.closePath(); c.stroke();
  c.beginPath(); c.moveTo(250, 220); c.lineTo(290, 196); c.lineTo(270, 246); c.closePath(); c.stroke();
  c.beginPath(); c.moveTo(286, 200); c.lineTo(312, 178); c.stroke();
  c.beginPath(); c.moveTo(150, 260); c.quadraticCurveTo(210, 190, 300, 230); c.stroke();
  c.font = '30px Arial, sans-serif'; c.fillText('REF', 132, 368);
  // the small print, as print
  c.fillStyle = '#b4bcc4';
  for (let i = 0; i < 7; i++) c.fillRect(350, 176 + i * 22, 470 - (i % 3) * 70, 8);
  // the port, drawn
  c.fillStyle = '#7b838c'; c.beginPath(); c.roundRect(660, 300, 220, 46, 18); c.fill();
  c.fillStyle = '#f8fafb'; c.font = 'bold 20px Arial, sans-serif'; c.fillText('BD Diffusics', 705, 330);
  // the gauge band
  c.fillStyle = gauge.pack; c.fillRect(70, 392, W - 100, 66);
  c.fillStyle = '#29505d'; c.font = 'bold 50px Arial, sans-serif'; c.fillText(gauge.label, 130, 443);
  c.fillStyle = '#b4bcc4'; for (let i = 0; i < 4; i++) c.fillRect(150, 478 + i * 16, 420, 7);
  // a square code
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) if (((i * 7 + j * 13 + i * j) % 5) < 2) { c.fillStyle = '#8c949c'; c.fillRect(640 + i * 6, 472 + j * 6, 6, 6); }
  ltex.needsUpdate = true;
}
// fold the lid back: t 0 sealed, 1 peeled clear of the tray
function setLid(t) {
  const { lidGeo, rest } = R3.prep.pack, pos = lidGeo.attributes.position, r = LID.curl;
  const h = t * (LID.L + 1.2);
  rest.forEach(([x, z], i) => {
    const u = x - LID.x0;
    let X = x, Y = 0;
    if (u < h) {
      const d = h - u;
      if (d < Math.PI * r) { const th = d / r; X = LID.x0 + h - r * Math.sin(th); Y = r * (1 - Math.cos(th)); }
      else { X = LID.x0 + h + (d - Math.PI * r); Y = 2 * r; }
    } else if (t === 0) {
      // the tab: the corner by the printed triangle, unsealed and a little proud
      const cu = 1 - u / LID.tab, cz = 1 - (LID.W / 2 - z) / LID.tab;
      if (cu > 0 && cz > 0) Y = 0.22 * Math.min(cu, cz);
    }
    pos.setXYZ(i, X, LID.y + Y, z);
  });
  pos.needsUpdate = true; lidGeo.computeVertexNormals(); lidGeo.computeBoundingSphere();
}
// the table beside the board, on the limb's lateral side, the pack lying along the limb
function placePrep(box) {
  if (!R3?.prep) return;
  const s0 = G.worldAt(0, 0), o = G.toWorld(G.O);
  const flat = (v) => v3.norm([v[0], 0, v[2]]);
  const X = flat(v3.sub(G.toWorld(v3.add(G.O, G.Ax)), o)), Y = [0, 1, 0];
  let side = v3.cross(Y, X);
  if (v3.dot(side, flat(v3.sub(G.toWorld(v3.add(G.O, G.L)), o))) < 0) side = v3.mul(side, -1);
  let half = 0;
  for (const cx of [box.min.x, box.max.x]) for (const cz of [box.min.z, box.max.z]) half = Math.max(half, v3.dot(v3.sub([cx, s0[1], cz], s0), side));
  const at = v3.add([s0[0], box.min.y + 0.4, s0[2]], v3.mul(side, half + 15));
  // (the table's +Z runs back toward the patient: X x Y)
  orient(R3.prep.group, at, X, Y);
  R3.prep.group.updateMatrixWorld(true);
  R3.prep.X = X; R3.prep.Y = Y; R3.prep.Z = v3.cross(X, Y); R3.prep.O = at;
  paintLid(); setLid(0);
}
const prepPoint = (q) => v3.add(R3.prep.O, v3.add(v3.mul(R3.prep.X, q[0]), v3.add(v3.mul(R3.prep.Y, q[1]), v3.mul(R3.prep.Z, q[2]))));
// each frame: everything on the table toward where the learner left it
function animatePrep(dt) {
  if (!R3?.prep) return;
  const k = 1 - Math.exp(-dt * 8), P0 = R3.prep;
  const to = (key, want, dragging) => { if (!dragging) PREP[key] += (want - PREP[key]) * k; };
  to('swabT', PREP.swab === 'closed' ? 0 : 1, ptr.kind === 'tear');
  to('swabPop', PREP.swab === 'closed' ? 0 : 1, false);
  to('swabLift', PREP.swab === 'out' ? 1 : 0, ptr.kind === 'swabOut');
  to('packT', PREP.pack === 'closed' ? 0 : 1, ptr.kind === 'peel');
  to('lift', PREP.pack === 'out' ? 1 : 0, ptr.kind === 'lift');
  to('flushT', PREP.flush === 'closed' ? 0 : 1, ptr.kind === 'flushTear');
  to('flushLift', PREP.flush === 'out' || PREP.flush === 'ready' ? 1 : 0, ptr.kind === 'flushLift');
  to('capOff', PREP.flush === 'ready' ? 1 : 0, ptr.kind === 'flushCap');
  to('sharpT', PREP.sharps === 'held' ? 0 : 1, ptr.kind === 'toTray');
  to('flip', 0, ptr.kind === 'flip' || (PREP.sharps === 'done' && PREP.drop < 0.6));
  to('drop', PREP.sharps === 'done' ? 1 : 0, false);
  // the swab: its top strip tears off; the pad rides up out of the opening, then out
  const sw = P0.swab;
  if (Math.abs(PREP.swabT - (sw.t ?? -1)) > 1e-4) { setStrip(PREP.swabT); sw.t = PREP.swabT; }
  sw.strip.visible = !(PREP.swab !== 'closed' && PREP.swabT > 0.97);
  const L = PREP.swabLift;
  // (inside, it stays under the front sheet: only what rides out past the torn edge shows)
  sw.pad.position.set(0, 0.105 + 2.2 * L, 0.6 - 1.6 * PREP.swabPop - 4.5 * L);
  sw.pad.visible = L < 0.97;
  if (Math.abs(PREP.packT - (P0.lidT ?? -1)) > 1e-4) { setLid(PREP.packT < 1e-3 ? 0 : PREP.packT); P0.lidT = PREP.packT; }
  // the flush: its header torn back, the syringe lifted out, its white cap pulled off
  const fl = P0.flush;
  if (Math.abs(PREP.flushT - (fl.t ?? -1)) > 1e-4) { setSleeve(PREP.flushT); fl.t = PREP.flushT; }
  fl.syr.position.set(6.4, 0.8 + 5 * PREP.flushLift, 2.5 * PREP.flushLift);
  fl.wcap.position.set(0.75 + 2.2 * PREP.capOff, -1.2 * Math.max(0, PREP.capOff - 0.5), 0);
  fl.wcap.visible = PREP.capOff < 0.98;
  fl.syr.visible = PREP.flush !== 'ready' || PREP.capOff < 0.98;
  // used supplies leave the table
  const S = P0.sup;
  S.tq.visible = !!A && !(A.tq.on || A.tq.total > 0 || R3.band.visible);
  S.tega.visible = !!A && !A.dressing.placed;
  S.capIn.visible = !!A && !(A.cap.on || A.cap.locked);
  S.gz.visible = !!A && !A.pressure.gauze;
  // the sharps tray flips up; the needle rides it, then slides off into the container
  const th = 1.9 * PREP.flip;
  P0.sharps.trayPivot.rotation.x = -th;
  placeSpent(th);
}
// the needle out, in the table's own frame: held over the sharps tray, laid on it, tipped in
function placeSpent(th) {
  const sp = R3.prep.spent;
  sp.visible = sharpsStage() || (PREP.sharps === 'done' && PREP.drop < 0.3);
  if (!sp.visible) return;
  const S = SHARPS_AT, hinge = [S[0], 10.55, S[2] - 2.4];
  // on the tray: 2.7 cm in from the hinge, rotated up with it
  const onTray = (t) => [hinge[0], hinge[1] + 0.45 * Math.cos(t) + 2.7 * Math.sin(t), hinge[2] + 2.7 * Math.cos(t) - 0.45 * Math.sin(t)];
  const held = [S[0], 15.5, S[2] + 1.0];
  let p, up = [0, 1, 0];
  if (PREP.sharps === 'done' || PREP.flip > 0.45) {
    // slid off the tray, down into the opening
    const f = PREP.sharps === 'done' ? PREP.drop : 0;
    p = [hinge[0], hinge[1] + 0.6 - 9 * f, hinge[2] + 1.6];
  } else {
    const q = onTray(th), u = PREP.sharpT;
    p = [held[0] + (q[0] - held[0]) * u, held[1] + (q[1] - held[1]) * u, held[2] + (q[2] - held[2]) * u];
    up = [0, Math.cos(th * u), -Math.sin(th * u)];
  }
  orient(sp, p, [1, 0, 0], up);
}
function screenAxis(cam, w, dir) {
  const { THREE } = ctx, r = ctx.three.renderer.domElement.getBoundingClientRect();
  const a = new THREE.Vector3(...w).project(cam), b = new THREE.Vector3(...v3.add(w, dir)).project(cam);
  const dx = (b.x - a.x) * 0.5 * r.width, dy = -(b.y - a.y) * 0.5 * r.height, n = Math.hypot(dx, dy) || 1;
  return { ux: dx / n, uy: dy / n, px: n };
}
const hubWorld = () => worldOfKitPart(R3.hub);
const prepWorldOf = (obj) => { const v = new ctx.THREE.Vector3(); obj.getWorldPosition(v); return [v.x, v.y, v.z]; };
// is the table where this click works now, and on what? Whatever the camera is showing there,
// whatever is in hand (a swab still held after the clean must not leave the IV's pack dead)
function prepJob() {
  if (!A || A.ended) return null;
  return { prepSharps: 'sharps', prepFlush: 'flush', prepSwab: 'swab', prepIV: 'iv', prepSeal: 'iv' }[stepView()] || null;
}
function prepDown(e, canvas, cam) {
  const P0 = R3.prep, job = prepJob();
  ptr.sx = e.clientX; ptr.sy = e.clientY;
  if (job === 'sharps') { ptr.kind = PREP.sharps === 'held' ? 'toTray' : 'flip'; return; }
  if (job === 'flush') {
    if (PREP.flush === 'closed') {
      const hit = ray(e, canvas, cam).intersectObject(P0.flush.group, true)[0];
      if (!hit) return;
      const q = P0.flush.group.worldToLocal(hit.point.clone());
      if (q.x > -SLEEVE.L / 2 + 2.5) { toast('Tear it open from its end.'); return; }
      ptr.ax = screenAxis(cam, prepPoint(FLUSH_AT), P0.X); ptr.kind = 'flushTear'; return;
    }
    if (PREP.flush === 'open') { ptr.kind = 'flushLift'; return; }
    ptr.ax = screenAxis(cam, prepWorldOf(P0.flush.wcap), P0.X); ptr.kind = 'flushCap'; return;
  }
  if (job === 'swab') {
    const hit = ray(e, canvas, cam).intersectObject(P0.swab.group, true)[0];
    if (!hit) return;
    if (PREP.swab === 'closed') {
      const q = P0.swab.group.worldToLocal(hit.point.clone());
      if (q.x > -1.0 || q.z > -0.9) { toast('Tear it from the notch at the top left.'); return; }
      ptr.ax = screenAxis(cam, prepPoint(SWAB_AT), P0.X); ptr.kind = 'tear'; return;
    }
    ptr.kind = 'swabOut'; return;
  }
  // the IV
  if (A.mode === 'guided' && !A.done.has('clean')) { toast('Clean the site first.'); return; }
  if (A.kit.off) { toast('The catheter came off: take a new kit.'); return; }
  if (PREP.pack === 'closed') {
    const hit = ray(e, canvas, cam).intersectObjects([P0.pack.lid, P0.pack.lidBack], false)[0];
    if (!hit) return;
    const q = P0.pack.group.worldToLocal(hit.point.clone());
    if (q.x > LID.x0 + 2.2 || q.z < LID.W / 2 - 2.2) { toast('Peel it from the corner by the triangle.'); return; }
    ptr.ax = screenAxis(cam, prepPoint(PACK_AT), P0.X); ptr.az = screenAxis(cam, prepPoint(PACK_AT), v3.mul(P0.Z, -1));
    ptr.kind = 'peel'; return;
  }
  if (PREP.pack === 'open') { ptr.kind = 'lift'; return; }
  // in hand: Practice and Assessment may take it straight to the arm (the skipped seal is theirs)
  if (A.mode !== 'guided' && !A.done.has('seal')) {
    const h = hitSkin(e, canvas, cam);
    if (h) { PREP.atSite = true; refresh(); return; }
  }
  ptr.ax = screenAxis(cam, hubWorld(), P0.X); ptr.slide0 = A.kit.slide; ptr.kind = 'seal';
}
const PREP_KINDS = ['tear', 'swabOut', 'peel', 'lift', 'seal', 'flushTear', 'flushLift', 'flushCap', 'toTray', 'flip'];
function prepMove(e) {
  const dx = e.clientX - ptr.sx, dy = e.clientY - ptr.sy, cl = (v) => Math.max(0, Math.min(1, v));
  const along = (a) => dx * a.ux + dy * a.uy;
  if (ptr.kind === 'tear') PREP.swabT = cl(along(ptr.ax) / (ptr.ax.px * 5.5 * 0.75));
  else if (ptr.kind === 'swabOut') PREP.swabLift = cl(Math.hypot(dx, dy) / 140);
  else if (ptr.kind === 'peel') PREP.packT = cl(Math.max(along(ptr.ax), along(ptr.az)) / (ptr.ax.px * LID.L * 0.5));
  else if (ptr.kind === 'lift') PREP.lift = cl(-dy / 130);
  else if (ptr.kind === 'flushTear') PREP.flushT = cl(along(ptr.ax) / (ptr.ax.px * SLEEVE.L * 0.8));
  else if (ptr.kind === 'flushLift') PREP.flushLift = cl(-dy / 130);
  else if (ptr.kind === 'flushCap') PREP.capOff = cl(along(ptr.ax) / (ptr.ax.px * 1.6));
  else if (ptr.kind === 'toTray') PREP.sharpT = cl(dy / 120);
  else if (ptr.kind === 'flip') PREP.flip = cl(-dy / 140);
  else if (ptr.kind === 'seal') {
    const mm = Math.max(0, ptr.slide0 + along(ptr.ax) / (ptr.ax.px / 10));
    const r = IV.sealSlide(A, mm);
    if (r && r.why) { toast(r.why); ptr.kind = null; return; }
    if (A.kit.off) { sfx('creak'); toast('Too far: the catheter came off.'); ptr.kind = null; refresh(); return; }
    const peak0 = PREP.sealPeak;
    PREP.sealPeak = Math.max(PREP.sealPeak, A.kit.slide);
    if (peak0 < P.seal.breakMinMM && PREP.sealPeak >= P.seal.breakMinMM) { sfx('click'); toast('Seal broken. Slide it back.'); }
    if (PREP.sealPeak >= P.seal.breakMinMM && A.kit.slide <= 0.2) {
      const res = IV.sealRelease(A, PREP.sealPeak);
      ptr.kind = null;
      if (res.ok) sfx('click'); else if (res.why) toast(res.why);
      refresh();
    }
  }
}
function prepUp() {
  const k = ptr.kind;
  if (k === 'tear' && PREP.swabT >= 0.6) { PREP.swab = 'open'; sfx('snap'); refresh(); }
  else if (k === 'swabOut' && PREP.swabLift >= 0.5) { PREP.swab = 'out'; refresh(); }
  else if (k === 'peel' && PREP.packT >= 0.35) { PREP.pack = 'open'; sfx('snap'); refresh(); }
  else if (k === 'lift' && PREP.lift >= 0.5) { PREP.pack = 'out'; refresh(); }
  else if (k === 'flushTear' && PREP.flushT >= 0.6) { PREP.flush = 'open'; sfx('snap'); refresh(); }
  else if (k === 'flushLift' && PREP.flushLift >= 0.5) { PREP.flush = 'out'; refresh(); }
  else if (k === 'flushCap' && PREP.capOff >= 0.6) { PREP.flush = 'ready'; sfx('click'); refresh(); }
  else if (k === 'toTray' && PREP.sharpT >= 0.6) { PREP.sharps = 'onTray'; sfx('click'); refresh(); }
  else if (k === 'flip' && PREP.flip >= 0.6) {
    const r = IV.disposeNeedle(A);
    if (r.ok) { PREP.sharps = 'done'; sfx('snap'); } else if (r.why) toast(r.why);
    refresh();
  }
}
// the step card's own lines while a supply is being opened or put away
function miniStep() {
  if (!A || A.ended || A.finished) return null;
  if (sharpsStage()) {
    return PREP.sharps === 'held' ? { do: 'Lay the needle in the sharps tray.', keys: [['Left-drag ↓', 'needle']] }
      : { do: 'Flip the tray up to drop it in.', keys: [['Left-drag ↑', 'tray']] };
  }
  if (tool === 'syringe' && PREP.flush !== 'ready') {
    if (PREP.flush === 'closed') return { do: 'Tear the sleeve open, down its length.', keys: [['Left-drag →', 'along it']] };
    if (PREP.flush === 'open') return { do: 'Take the syringe out.', keys: [['Left-drag ↑', 'syringe']] };
    return { do: 'Pull the white cap off its tip.', keys: [['Left-drag →', 'cap']] };
  }
  if (tool === 'pad' && PREP.swab !== 'out') {
    return PREP.swab === 'closed' ? { do: 'Tear the top off, from the notch, left to right.', keys: [['Left-drag →', 'top strip']] }
      : { do: 'Take the swab out.', keys: [['Left-drag', 'swab out']] };
  }
  if (!kitAtSite() && (tool === 'catheter' || IV.currentStep(A) === 'seal')) {
    if (A.kit.off) return { do: 'The catheter came off the needle.', keys: [], newKit: true };
    if (PREP.pack === 'closed') return { do: 'Peel the lid back from the corner by the triangle.', keys: [['Left-drag', 'corner tab']] };
    if (PREP.pack === 'open') return { do: 'Lift the IV out.', keys: [['Left-drag ↑', 'IV']] };
    return { do: 'Slide the catheter 1 mm off the needle, then back.', keys: [['Left-drag →', 'break'], ['Left-drag ←', 'reseat']] };
  }
  return null;
}
// a camera that keeps an area of radius R round t in the clear part of the screen (left of the
// tray, under the step card), looking along -n
function fitView(t, n, up, R) {
  const cv = ctx.three.renderer.domElement.getBoundingClientRect();
  const tray = $('ivTray')?.getBoundingClientRect(), card = $('ivStep')?.getBoundingClientRect();
  const fx = tray && tray.width ? Math.max(0, Math.min(0.4, (cv.right - tray.left + 8) / cv.width)) : 0;
  const fy = card && card.height ? Math.max(0, Math.min(0.35, (card.bottom - cv.top + 8) / cv.height)) : 0;
  const tn = Math.tan(21 * D), asp = cv.width / Math.max(1, cv.height);
  const d = Math.max(R / (tn * asp * (1 - fx)), R / (tn * (1 - fy)));
  const u0 = v3.norm(v3.sub(up, v3.mul(n, v3.dot(up, n)))), r0 = v3.cross(v3.mul(n, -1), u0);
  const Hh = d * tn, Hw = Hh * asp;
  const tgt = v3.add(t, v3.add(v3.mul(r0, fx * Hw), v3.mul(u0, fy * Hh)));
  return { pos: v3.add(tgt, v3.mul(n, d)), target: tgt, up: u0, fitted: true };
}
// any other view: moved sideways so what it centres on sits in the clear part of the screen
function clearOfOverlays(w) {
  const cv = ctx.three.renderer.domElement.getBoundingClientRect();
  const tray = $('ivTray')?.getBoundingClientRect(), card = $('ivStep')?.getBoundingClientRect();
  const fx = tray && tray.width ? Math.max(0, Math.min(0.4, (cv.right - tray.left + 8) / cv.width)) : 0;
  const fy = card && card.height ? Math.max(0, Math.min(0.35, (card.bottom - cv.top + 8) / cv.height)) : 0;
  const f = v3.sub(w.target, w.pos), d = Math.hypot(...f), fn = v3.mul(f, 1 / (d || 1));
  const u0 = v3.norm(v3.sub(w.up, v3.mul(fn, v3.dot(w.up, fn)))), r0 = v3.cross(fn, u0);
  const Hh = d * Math.tan(21 * D), Hw = Hh * cv.width / Math.max(1, cv.height);
  const sh = v3.add(v3.mul(r0, fx * Hw), v3.mul(u0, fy * Hh));
  return { pos: v3.add(w.pos, sh), target: v3.add(w.target, sh), up: w.up };
}

/* ---------------------------------------------------------------- placing everything */
function placeKit() {
  const k = R3.kit;
  if (!A || A.pressure.removed || !R3.prep?.O) { k.visible = false; return; }
  if (!kitAtSite()) {
    // in its pack on the table, lifted out, then held over it for the seal
    k.visible = true;
    const q = [KIT_IN_PACK[0] + PACK_AT[0], KIT_IN_PACK[1] + PREP.lift * 4.5, KIT_IN_PACK[2] + PACK_AT[2]];
    orient(k, prepPoint(q), R3.prep.X, R3.prep.Y);
    const off = A.kit.slide / 10, hubX = -0.15 - 2.5 - 0.45 + off;
    drapeExt(false, hubX);
    R3.needle.position.set(-1.6, 0, 0); R3.needle.visible = true;
    R3.cathM.position.set(-0.15 - 1.25 + off, 0, 0); R3.cathM.rotation.z = -Math.PI / 2; R3.cathM.visible = !A.kit.off;
    R3.bloodTube.geometry.setDrawRange(0, 0);
    R3.hub.position.set(hubX, 0, 0); R3.ext.position.set(hubX, 0, 0);
    R3.housing.position.set(-0.15 - 2.5 - 0.9, 0, 0); R3.housing.visible = true;
    R3.flashFill.visible = false;
    R3.sheath.visible = PREP.pack !== 'out';
    for (const h of R3.hands) h.visible = PREP.pack === 'out' && !A.done.has('seal') && !A.kit.off;
    R3.clampJaw.rotation.z = A.clampOpen ? 0.42 : 0.0;
    R3.portCap.visible = true;
    restWings();
    return;
  }
  R3.sheath.visible = false; R3.cathM.visible = true;
  for (const h of R3.hands) h.visible = false;
  k.visible = !!A.mark;
  if (!k.visible) return;
  const F = veinFrame(), dir = IV.needleDir(A), dW = engineDirWorld(F, dir);
  const tip = engineToWorld(F, IV.needleTip(A));
  // hovering over the skin until it goes in: lift it a little along the needle
  const lift = A.needle.inSkin ? 0 : 0.15;
  let tipW = v3.sub(tip, v3.mul(dW, lift));
  // (the kit's +y is out of the skin: the grip on top, the wings underneath)
  const up = F.Z.map((v) => -v);
  const thr = A.cath.thread / 10, off = A.kit.slide / 10, hubX = -0.15 - 2.5 - 0.45 + thr + off;
  // once the catheter is threaded and the needle is coming out, the hub lies flat on the skin
  const settled = A.cath.hubbed && (A.needle.withdrawn > 0 || A.needle.shielded);
  let kd = dW;
  if (settled) {
    kd = v3.norm(v3.sub(dW, v3.mul(up, v3.dot(dW, up))));
    const hubOn = onSkin(v3.add(tipW, v3.mul(dW, hubX)), 0.25);
    tipW = v3.sub(hubOn, v3.mul(kd, hubX));
  }
  orient(k, tipW, kd, up);
  drapeExt(settled, hubX);
  // in the kit's frame: +x toward the tip (at 0), the rest behind it
  const back = (A.needle.withdrawn || 0) / 10;
  R3.needle.position.set(-1.6 - back, 0, 0);
  R3.needle.visible = !A.needle.shielded;
  R3.cathM.position.set(-0.15 - 1.25 + thr + off, 0, 0);
  R3.cathM.rotation.z = -Math.PI / 2;
  if (settled) {
    // (lying flat, the hub's nose is at the puncture: the cannula dips straight in, never along the surface)
    const a = 30 * D, nose = hubX + 0.4;
    R3.cathM.rotation.z = -Math.PI / 2 - a;
    R3.cathM.position.set(nose + Math.cos(a) * 1.25, -Math.sin(a) * 1.25, 0);
  }
  R3.hub.position.set(hubX, 0, 0);
  R3.ext.position.set(hubX, 0, 0);
  showBlood();
  R3.housing.position.set(-0.15 - 2.5 - 0.9 - back, 0, 0);
  R3.housing.visible = !A.needle.shielded;
  R3.flashFill.scale.set(1, Math.max(0.01, A.flash.level), 1);
  R3.flashFill.material.color.setHex(A.flash.artery ? 0xff2a2a : 0x9a0a12);
  R3.flashFill.visible = A.flash.level > 0.01;
  // the clip's jaw: lifted open, pressed shut on the tube
  R3.clampJaw.rotation.z = A.clampOpen ? 0.42 : 0.0;
  R3.portCap.visible = !A.portOpen && !A.cap.locked;
  conformWings(settled);
}
// The wings are soft plastic. Wherever they would sink into the skin they lie on it instead, and
// once the catheter is in they lie flat on it — under the dressing, not through it: each point of
// the wing 1.7-2.2 mm out from the smoothed skin under it (the dressing is painted 2.5 mm out).
function restWings() {
  if (R3.wingsAtRest) return;
  for (const w of R3.wings) { w.geometry.attributes.position.array.set(w.userData.rest); w.geometry.attributes.position.needsUpdate = true; w.geometry.computeVertexNormals(); }
  R3.wingsAtRest = true;
}
function conformWings(flat) {
  const { THREE } = ctx;
  if (!R3.patch?.grid) return;
  R3.wingsAtRest = false;
  R3.kit.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  for (const w of R3.wings) {
    const pos = w.geometry.attributes.position, { rest } = w.userData, M = w.matrixWorld, inv = M.clone().invert();
    for (let i = 0; i < pos.count; i++) {
      v.set(rest[3 * i], rest[3 * i + 1], rest[3 * i + 2]).applyMatrix4(M);
      const { a, l } = G.paramOf(G.fromWorld([v.x, v.y, v.z]));
      const { p: s0, n: n0 } = skinAt(a, l);
      const h = (v.x - s0[0]) * n0[0] + (v.y - s0[1]) * n0[1] + (v.z - s0[2]) * n0[2];
      // (local z 0 is the upper face, 0.05 the face against the skin)
      const want = 0.17 + (0.05 - rest[3 * i + 2]);
      const tgt = flat ? want : Math.max(h, want);
      v.x += n0[0] * (tgt - h); v.y += n0[1] * (tgt - h); v.z += n0[2] * (tgt - h);
      v.applyMatrix4(inv); pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true; w.geometry.computeVertexNormals();
  }
}
// a world point dropped onto the skin, lifted along the normal
function onSkin(w, lift) {
  const { a, l } = G.paramOf(G.fromWorld(w));
  return v3.add(G.worldAt(a, l), v3.mul(G.normalAt(a, l), lift));
}
// the extension set lies on the skin once the kit is down: its tubing, clamp and port follow the arm's curve
function drapeExt(on, hubX) {
  const { THREE } = ctx, X = R3.extRest;
  const key = on ? R3.kit.matrix.elements.map((v) => v.toFixed(3)).join() + hubX.toFixed(2) : '';
  if (key === R3.drapeKey) return;
  R3.drapeKey = key;
  let pts = X.curve, at = { clamp: X.clamp, port: X.port, cap: X.cap };
  if (on) {
    const M = R3.kit.matrix, inv = M.clone().invert();
    const drop = (p, lift) => {
      const w = new THREE.Vector3(p[0] + hubX, p[1], p[2]).applyMatrix4(M);
      const s = onSkin([w.x, w.y, w.z], lift);
      const q = new THREE.Vector3(...s).applyMatrix4(inv);
      return [q.x - hubX, q.y, q.z];
    };
    // (the first point stays at the hub)
    pts = X.curve.map((p, i) => (i ? drop(p, 0.11) : p));
    at = { clamp: drop(X.clamp, 0.2), port: drop(X.port, 0.34), cap: drop(X.cap, 0.3) };
  }
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
  R3.tubing.geometry.dispose(); R3.tubing.geometry = new THREE.TubeGeometry(curve, 40, 0.1, 8, false);
  const dr = R3.bloodTube.geometry.drawRange.count;
  R3.bloodTube.geometry.dispose(); R3.bloodTube.geometry = new THREE.TubeGeometry(curve, 40, 0.075, 6, false);
  R3.bloodTube.geometry.setDrawRange(0, dr);
  R3.clampM.position.set(...at.clamp); R3.port.position.set(...at.port);
  R3.extAt = at;
}
// blood: in the catheter once it is in the lumen, up the line as far as it has come, in the port's
// clear end when full; at an open port it spills onto the skin
function showBlood() {
  const inLumen = A.flash.level > 0 && (A.cathTip === 'lumen' || A.cath.inVein);
  R3.cathM.material.color.setHex(inLumen ? 0xc9505a : 0xf6f8fa);
  R3.bloodTube.geometry.setDrawRange(0, Math.floor(A.line.blood * 40) * 6 * 6);
  R3.portTip.material.color.setHex(A.line.blood >= 1 ? 0x9a1822 : 0xf2f6f9);
  const leak = R3.leak;
  leak.visible = A.spill > 0.01 && R3.kit.visible;
  if (leak.visible) {
    const tipW = new ctx.THREE.Vector3(-0.6, 0, 0); R3.port.localToWorld(tipW);
    const { a, l } = G.paramOf(G.fromWorld([tipW.x, tipW.y, tipW.z])), n = G.normalAt(a, l);
    leak.position.set(...v3.add(G.worldAt(a, l), v3.mul(n, 0.28)));
    leak.quaternion.setFromUnitVectors(new ctx.THREE.Vector3(0, 1, 0), new ctx.THREE.Vector3(...n));
    const r = 0.3 + 2.2 * A.spill; leak.scale.set(r, 1, r);
  }
}
function worldOfKitPart(obj) {
  const { THREE } = ctx;
  R3.kit.updateMatrixWorld(true);
  const v = new THREE.Vector3(); obj.getWorldPosition(v); return [v.x, v.y, v.z];
}
function placeSyringe() {
  const s = R3.syringe;
  s.visible = !!(A && A.syringe.on);
  R3.luer.visible = !!(A && A.cap.on);
  if (!s.visible && !R3.luer.visible) return;
  // the port's end of the extension set, pointing away from the hub
  const { THREE } = ctx;
  R3.kit.updateMatrixWorld(true);
  const pp = R3.port.position;
  const pw = pp.clone().applyMatrix4(R3.ext.matrixWorld);
  const pb = pp.clone().add(new THREE.Vector3(-1, 0, 0)).applyMatrix4(R3.ext.matrixWorld);
  const dir = v3.norm([pb.x - pw.x, pb.y - pw.y, pb.z - pw.z]);
  const up = [0, 1, 0];
  if (s.visible) {
    orient(s, [pw.x + dir[0] * 0.62, pw.y + dir[1] * 0.62, pw.z + dir[2] * 0.62], v3.mul(dir, -1), v3.cross(v3.mul(dir, -1), [1, 0, 0]));
    // the plunger goes in as the saline goes out; the twist shows as a turn about the axis
    const fs = A.syringe, left = Math.max(0, P.flush.volumeML - fs.vol + (fs.drawn || 0)) / P.flush.volumeML;
    R3.plunger.position.x = -0.5 - 5.5 * left;
    R3.saline.scale.set(1, Math.max(0.01, 5.5 * left), 1);
    R3.saline.position.x = -0.5 - 5.5 * left / 2;
    // blood drawn back clouds into the saline from the tip
    const bl = Math.min(5.5 * left, 1.2 + 9 * (fs.blood || 0));
    R3.sBlood.visible = (fs.blood || 0) > 0.01;
    R3.sBlood.scale.set(1, Math.max(0.01, bl), 1); R3.sBlood.position.x = -0.5 - bl / 2;
    R3.sBlood.material.opacity = Math.min(0.7, 0.25 + fs.blood);
    R3.saline.material.color.setHex((fs.blood || 0) > 0.01 ? 0xe9b9bf : 0xd6ecff);
    s.matrix.multiply(new ctx.THREE.Matrix4().makeRotationX((A.syringe.twist || 0) * D));
  }
  if (R3.luer.visible) {
    orient(R3.luer, [pw.x + dir[0] * 0.55, pw.y + dir[1] * 0.55, pw.z + dir[2] * 0.55], dir, up);
    R3.luer.matrix.multiply(new ctx.THREE.Matrix4().makeRotationZ(-Math.PI / 2)).multiply(new ctx.THREE.Matrix4().makeRotationY((A.cap.twist || 0) * D));
  }
}
function buildBand(aCm) {
  const { THREE } = ctx;
  const ring = [], N = 36, w = 1.25;
  const c = v3.add(G.O, v3.mul(G.Ax, aCm));
  const pose = ctx.phantomPose();
  for (let i = 0; i <= N; i++) {
    const phi = (i / N) * 2 * Math.PI;
    const dir = v3.add(v3.mul(G.N, Math.cos(phi)), v3.mul(G.L, Math.sin(phi)));
    const s = skinPoint(ctx.S.voxelModel, pose.flip, c, dir);
    const out = v3.add(s, v3.mul(dir, 0.18));
    ring.push(out);
  }
  const pos = [], idx = [];
  for (let i = 0; i <= N; i++) {
    for (const off of [-w, w]) { const p = G.toWorld(v3.add(ring[i], v3.mul(G.Ax, off))); pos.push(...p); }
  }
  for (let i = 0; i < N; i++) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx); geo.computeVertexNormals();
  R3.band.geometry.dispose(); R3.band.geometry = geo;
  R3.band.userData.anchor = G.toWorld(ring[0]);
  R3.band.userData.a = aCm;
}
function placeThumb() {
  const t = R3.thumb;
  t.visible = !!(A && keys.space && A.mark);
  if (!t.visible) return;
  // on the skin, 3 cm distal of the site, pulling it taut
  const m = A.mark, a = m.a - m.tan[0] * 3, l = m.l - m.tan[1] * 3;
  const w = G.worldAt(a, l), n = G.normalAt(a, l);
  t.position.set(w[0] + n[0] * 0.7, w[1] + n[1] * 0.7, w[2] + n[2] * 0.7);
  // lying on the skin, pointing at the site
  const { THREE } = ctx;
  t.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...v3.norm(v3.sub(G.worldAt(m.a, m.l), w))));
}

/* ---------------------------------------------------------------- the camera */
function siteWorld() { const m = A?.mark; return m ? G.worldAt(m.a, m.l) : G.worldAt(0, 0); }
function desiredView() {
  const key = viewPinned || viewKey;
  const s = siteWorld(), nrm = A?.mark ? G.normalAt(A.mark.a, A.mark.l) : G.normalAt(0, 0);
  const alongW = v3.norm(v3.sub(G.worldAt((A?.mark?.a ?? 0) + 1, A?.mark?.l ?? 0), G.worldAt(A?.mark?.a ?? 0, A?.mark?.l ?? 0)));
  if (key === 'overview') {
    // from the patient's side, above: the limb lies across the screen
    const box = R3.bbox, c = box.c, span = box.span, side = Math.sign(G.L[0] || 1);
    return { pos: [c[0] + side * span * 0.75, c[1] + span * 1.0, c[2] - span * 0.08], target: c, up: [0, 1, 0] };
  }
  if (key === 'band') {
    const b = R3.band.userData.anchor || s;
    return { pos: [b[0] + 20, b[1] + 28, b[2] - 18], target: b, up: [0, 1, 0] };
  }
  if (key === 'clean') return fitView(s, nrm, alongW, 3.6);
  if (key === 'syringe' && R3.syringe.visible) {
    const { THREE } = ctx, sc = new THREE.Vector3(-3.6, 0, 0).applyMatrix4(R3.syringe.matrix), pt = worldOfKitPart(R3.port);
    const c = [(sc.x + pt[0]) / 2, (sc.y + pt[1]) / 2, (sc.z + pt[2]) / 2];
    return fitView(c, nrm, alongW, 6.5);
  }
  if (key.startsWith('prep') && R3.prep?.O) {
    const P0 = R3.prep, n = v3.norm(v3.add(P0.Y, v3.mul(P0.Z, 0.35))), up = v3.mul(P0.Z, -1);
    if (key === 'prepSwab') return fitView(prepPoint(SWAB_AT), n, up, 4.2);
    if (key === 'prepIV') return fitView(prepPoint([PACK_AT[0], 0.6, PACK_AT[2]]), n, up, 7.8);
    if (key === 'prepFlush') return PREP.flush === 'closed' ? fitView(prepPoint(FLUSH_AT), n, up, 9.2) : fitView(v3.add(prepWorldOf(P0.flush.syr), v3.mul(P0.X, -3.5)), n, up, 7.5);
    if (key === 'prepSharps') return fitView(prepPoint([SHARPS_AT[0], 11, SHARPS_AT[2] + 1]), v3.norm(v3.add(P0.Y, v3.mul(P0.Z, 0.7))), up, 8.5);
    return fitView(hubWorld(), n, up, 2.8);
  }
  if (key === 'site') {
    // looking down on the site, the limb running up the screen
    return { pos: v3.add(s, v3.add(v3.mul(nrm, 22), v3.mul(alongW, -4))), target: s, up: alongW };
  }
  if (key === 'wide') {
    return { pos: v3.add(s, v3.add(v3.mul(nrm, 26), v3.mul(alongW, -16))), target: v3.add(s, v3.mul(alongW, -3)), up: [0, 1, 0] };
  }
  // the needle: three-quarter view from behind and beside the hub, looking along it
  const F = A?.mark ? veinFrame() : null;
  if (!F) return { pos: v3.add(s, v3.mul(nrm, 20)), target: s, up: [0, 1, 0] };
  const yw = (A.needle.yaw || 0) * D, dirH = v3.add(v3.mul(F.X, Math.cos(yw)), v3.mul(F.Y, Math.sin(yw)));
  // (behind and above, along the needle: aimed a little behind the entry so tip and hub both show)
  const pos = v3.add(F.E, v3.add(v3.mul(dirH, -11), v3.mul(F.Z, -9)));
  return { pos, target: v3.add(F.E, v3.mul(dirH, -1.2)), up: v3.mul(F.Z, -1) };
}
function stepView() {
  if (!A) return 'overview';
  const st = IV.currentStep(A);
  if (A.ended) return 'site';
  // opening supplies, and putting the needle away, at the table
  if (sharpsStage()) return 'prepSharps';
  if (tool === 'syringe' && PREP.flush !== 'ready') return 'prepFlush';
  if (tool === 'pad' && PREP.swab !== 'out') return 'prepSwab';
  if (!kitAtSite() && (tool === 'catheter' || st === 'seal')) return PREP.pack === 'out' ? 'prepSeal' : 'prepIV';
  if (st === 'clean') return 'clean';
  // the syringe on the port: framed with it
  if (A.syringe.on && ['syringe', 'clamp2', 'flush', 'clamp3', 'syringeOff'].includes(st)) return 'syringe';
  if (['prep', 'tourniquet'].includes(st)) return 'overview';
  if (['palpate', 'clean', 'dressing'].includes(st)) return 'site';
  if (['seal', 'align', 'anchor', 'insert', 'flash', 'thread', 'withdraw'].includes(st)) return 'needle';
  if (st === 'tqoff') return 'band';            // (its hotspot must be in view to be clicked)
  return 'wide';
}
function updateCamera(dt) {
  const { THREE, three } = ctx;
  let want = desiredView();
  if (!want.fitted && (viewPinned || viewKey) !== 'overview') want = clearOfOverlays(want);
  if (!three.ivView) three.ivView = { pos: new THREE.Vector3(...want.pos), target: new THREE.Vector3(...want.target), up: new THREE.Vector3(...want.up), zoom: 1 };
  const v = three.ivView;
  const tgt = new THREE.Vector3(...want.target);
  const pos = new THREE.Vector3(...want.pos).sub(tgt).multiplyScalar(v.zoom).add(tgt);
  // where it should look from and how it should be turned; the turn eased as a rotation, so a
  // change of view swings round rather than rolling through a flip
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, tgt, new THREE.Vector3(...want.up)));
  if (!v.q) { v.q = q.clone(); v.dist = pos.distanceTo(tgt); v.pos.copy(pos); }
  const k = 1 - Math.exp(-dt * 2.4);
  v.pos.lerp(pos, k); v.q.slerp(q, k); v.dist += (pos.distanceTo(tgt) - v.dist) * k;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(v.q);
  v.target.copy(v.pos).addScaledVector(fwd, v.dist);
  v.up.set(0, 1, 0).applyQuaternion(v.q);
}

/* ---------------------------------------------------------------- input */
function ray(e, canvas, cam) {
  const { THREE } = ctx;
  const r = canvas.getBoundingClientRect();
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), cam);
  return rc;
}
function hitPatch(e, canvas, cam) {
  if (!R3?.patch) return null;
  const h = ray(e, canvas, cam).intersectObject(R3.patch.mesh, false)[0];
  if (!h) return null;
  const p = R3.patch;
  return { a: p.a0 + h.uv.y * (p.a1 - p.a0), l: p.l0 + h.uv.x * (p.l1 - p.l0), point: [h.point.x, h.point.y, h.point.z] };
}
function hitSkin(e, canvas, cam) {
  const g = ctx.three.chestGroup; if (!g) return null;
  const meshes = []; g.traverseVisible((o) => { if (o.isMesh) meshes.push(o); });   // (the hidden plain mesh too would answer)
  const h = ray(e, canvas, cam).intersectObjects(meshes, false)[0];
  if (!h) return null;
  const rest = G.fromWorld([h.point.x, h.point.y, h.point.z]);
  return { ...G.paramOf(rest), point: [h.point.x, h.point.y, h.point.z] };
}

export function ivPointer(e, phase, cam, canvas) {
  if (!ctx || ctx.S.mode !== 'iv') return false;
  if (!A || A.finished) return true;
  const now = performance.now() / 1000;
  if (phase === 'down') {
    ptr.down = true; ptr.button = e.button; ptr.x = e.clientX; ptr.y = e.clientY; ptr.t = now; ptr.pressT = 0;
    onDown(e, canvas, cam);
    return true;
  }
  if (phase === 'up') { if (ptr.down) onUp(e, canvas, cam); ptr.down = false; return true; }
  // move
  const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y, dt = Math.max(1e-3, now - ptr.t);
  ptr.x = e.clientX; ptr.y = e.clientY; ptr.t = now;
  onMove(e, canvas, cam, dx, dy, dt);
  return true;
}
function onDown(e, canvas, cam) {
  const st = IV.currentStep(A);
  // every drag is a left-drag but the needle's angle, which is a right-drag
  if (e.button === 2) {
    if (!A.ended && R3.kit.visible && kitAtSite() && !A.cath.hubbed) { ptr.kind = 'angle'; ptr.pitchRaw = A.needle.pitch; }
    return;
  }
  if (e.button !== 0) return;
  // after an attempt-ending error: the catheter comes out, gauze, hold pressure
  if (A.ended) {
    if (!A.pressure.removed) { ptr.kind = 'withdraw'; return; }
    if (tool === 'gauze') {
      const h = hitPatch(e, canvas, cam);
      if (h && (A.pressure.gauze || IV.applyGauze(A).ok)) { R3.gauze.userData.at = h; ptr.kind = 'press'; refresh(); }
    }
    return;
  }
  if (tool === 'tourniquet') {
    const h = hitSkin(e, canvas, cam);
    if (!h) return;
    const elbowA = G.siteKey === 'antecubital' ? 0 : G.siteKey === 'forearm' ? 14 : -99;
    const above = G.siteKey === 'hand' ? h.a > 3.5 : h.a > elbowA + 2;
    const r = IV.applyTourniquet(A, above);
    if (!r.ok) return toast(r.why);
    buildBand(h.a);
    R3.band.visible = true; sfx('snap'); setTool(null); refresh();
    return;
  }
  // (the seal step shows the pack whatever is in hand: a click on it picks the IV up)
  const job = prepJob();
  if (job === 'iv' && tool !== 'catheter') setTool('catheter');
  if (job) { prepDown(e, canvas, cam); return; }
  if (tool === 'pad') { ptr.kind = 'scrub'; return; }
  if (tool === 'tegaderm') {
    const h = hitPatch(e, canvas, cam); if (!h || !A.mark) return;
    const off = Math.hypot(h.a - A.mark.a, h.l - A.mark.l) * 10;
    const r = IV.placeDressing(A, off, dressingCovers(h)); if (!r.ok) return toast(r.why);
    A.dressingAt = { a: h.a, l: h.l }; setTool(null); refresh(); return;
  }
  if (tool === 'syringe' || tool === 'cap') {
    // clicking anything but the port touches a non-sterile surface
    const h = hitSkin(e, canvas, cam);
    if (h) { A[tool === 'syringe' ? 'syringeTouched' : 'capTouched'] = true; toast('That touched the skin.'); }
    return;
  }
  // the needle, from the align step to the withdrawal: left-drag advances, right-drag angles
  if (R3.kit.visible && kitAtSite()) {
    if (st === 'withdraw' || (A.cath.hubbed && !A.needle.shielded)) { ptr.kind = 'withdraw'; return; }
    if (A.syringe.locked && st === 'flush') { ptr.kind = 'flush'; ptr.flushT = performance.now() / 1000; return; }
    if (!A.cath.hubbed) { ptr.kind = e.button === 2 ? 'angle' : 'advance'; ptr.pitchRaw = A.needle.pitch; return; }
  }
  if (A.syringe.locked && (st === 'flush' || st === 'clamp2' || st === 'clamp3')) { ptr.kind = 'flush'; return; }
  // otherwise a click on the skin marks the site
  if (e.button === 0 && ['palpate', 'clean', 'seal', 'align'].includes(st) || (!A.mark && e.button === 0)) {
    const h = hitPatch(e, canvas, cam); if (!h) return;
    markAt(h.a, h.l);
  }
}
function onMove(e, canvas, cam, dx, dy, dt) {
  // the palpating finger follows the cursor while F is held
  if (keys.f && !ptr.down) palpateAt(e, canvas, cam);
  if (!ptr.down) { R3.finger.visible = keys.f && !!hitPatch(e, canvas, cam); return; }
  if (PREP_KINDS.includes(ptr.kind)) { prepMove(e); return; }
  if (ptr.kind === 'scrub') {
    const h = hitPatch(e, canvas, cam); if (!h || !A.mark) return;
    // the swab rides under the cursor, flat on the skin
    const n = G.normalAt(h.a, h.l);
    R3.swab.position.set(...v3.add(h.point, v3.mul(n, 0.12)));
    R3.swab.quaternion.setFromUnitVectors(new ctx.THREE.Vector3(0, 1, 0), new ctx.THREE.Vector3(...n));
    R3.swab.visible = true;
    scrubAt(h, dt, Math.hypot(dx, dy));
  } else if (ptr.kind === 'advance') {
    const r = IV.advance(A, -dy * 0.05);
    if (r && r.why) toast(r.why);
  } else if (ptr.kind === 'angle') {
    // whole degrees, so the readout is the angle the engine checks
    ptr.pitchRaw -= dy * 0.12;
    IV.setPitch(A, Math.round(ptr.pitchRaw));
  } else if (ptr.kind === 'withdraw') {
    if (A.ended && dy <= 0) return;                 // (out, all of it, with a pull down)
    const r = IV.withdrawNeedle(A, Math.max(0, dy) * 0.12);
    if (r && r.why) toast(r.why);
    if (A.needle.shielded || A.pressure.removed) { sfx('click'); refresh(); }
  } else if (ptr.kind === 'flush') {
    // pulled back first: blood into the syringe if it is in; then pushed (a pause is not a slow push)
    if (dy > 0) {
      const r = IV.aspirate(A, dy * 0.005);
      if (r.why) toast(r.why);
      else if (r.blood && !ptr.sawBlood) { ptr.sawBlood = true; toast('Blood return: the catheter is in.'); }
    } else if (dy < 0) {
      const ml = -dy * 0.008, r = IV.flush(A, ml, Math.min(0.1, dt));
      if (r.why) toast(r.why);
      if (r.resist) { sfx('creak'); toast(A.clampOpen ? 'Resistance. Swelling?' : 'The clamp is closed.'); }
      ptr.lastPush = performance.now();
    }
  } else if (ptr.kind === 'press') {
    // holding still on the gauze
  }
}
function onUp() {
  if (ptr.kind === 'scrub') sfx('scrubStop');
  prepUp();
  if (R3) R3.swab.visible = false;
  ptr.kind = null;
}
function markAt(a, l) {
  if (A.needle.inSkin) return;
  // the vein under the mark, and an artery near it
  let best = null;
  for (const f of G.feats) {
    if (f.kind !== 'vein') continue;
    const n = nearest(f, a, l);
    if (!best || n.dist < best.n.dist) best = { f, n };
  }
  if (!best || best.n.dist * 10 > best.f.radius + 4) {
    const r = IV.markSite(A, null);
    toast(r.why || 'No vein there.'); paint(); return;
  }
  const f = best.f, n = best.n;
  // (the engine's +Y is the vein frame's +across: the mark's offset from the vein's centre)
  const site = { veinId: f.id, lateral: n.across * 10, radius: f.radius, depth: veinDepthAt(f, n.i), roll: f.roll, fragility: f.fragility,
    atValve: minDist(f.valves, a, l) < 0.5, atJoin: minDist(f.joins, a, l) < 0.6 };
  for (const d of G.feats) {
    if (d.kind !== 'artery') continue;
    const dn = nearest(d, a, l);
    if (dn.dist < 2.5) site.artery = { lateral: site.lateral - dn.across * 10 * Math.sign(n.tan[0] * dn.tan[0] + n.tan[1] * dn.tan[1] || 1), depth: d.depth, radius: d.radius };
  }
  const r = IV.markSite(A, site);
  if (!r.ok && r.why) toast(r.why);
  if (A.mark) Object.assign(A.mark, { a, l, tan: n.tan });
  if (A.mode !== 'assessment' && r.reasons?.length) toast(r.reasons.map((c) => IV.ERRORS[c].msg).join(' · '));
  paint(); refresh();
}
function palpateAt(e, canvas, cam) {
  const h = hitPatch(e, canvas, cam);
  R3.finger.visible = !!h;
  if (!h) return;
  R3.finger.position.set(...v3.add(h.point, v3.mul(G.normalAt(h.a, h.l), 0.45)));
  // a fingertip on the cleaned site undoes the prep
  if (A.mark && A.clean.cells && Math.hypot(h.a - A.mark.a, h.l - A.mark.l) * 10 < P.clean.radiusMM && (A.clean.dryFrom != null || A.done.has('clean'))) {
    IV.touchCleaned(A); paint();
    if (A.mode !== 'assessment') toast('That touched the clean site.');
  }
  const now = performance.now() / 1000;
  if (now - (ptr.lastPalp || 0) < 0.25) return;          // sweep slowly: one pulse at a time
  ptr.lastPalp = now;
  const near = [];
  for (const f of G.feats) {
    const n = nearest(f, h.a, h.l);
    if (n.dist > 2) continue;
    near.push({ kind: f.kind, id: f.id, dist: n.dist * 10, radius: f.radius, depth: f.kind === 'vein' ? veinDepthAt(f, n.i) : f.depth,
      valveDist: f.valves ? minDist(f.valves, h.a, h.l) * 10 : null, tan: n.tan });
  }
  const cues = IV.palpationCues(A, near).sort((x, y) => y.strength - x.strength);
  // (a faint cue is felt only some of the time)
  if (cues.length && Math.random() < Math.pow(cues[0].strength, 1.5)) spawnRing(h, cues[0], near.find((f) => f.id === cues[0].id));
}
function scrubAt(h, dt, movedPx) {
  const m = A.mark, cells = cleanCells(), half = (CG.n - 1) / 2;
  // the pad, 8 mm round, in the vein's frame
  const da = (h.a - m.a) * m.tan[0] + (h.l - m.l) * m.tan[1], dl = -(h.a - m.a) * m.tan[1] + (h.l - m.l) * m.tan[0];
  const ci = Math.round(da / CG.cell + half), cj = Math.round(dl / CG.cell + half), pr = Math.round(0.8 / CG.cell);
  for (let i = ci - pr; i <= ci + pr; i++) for (let j = cj - pr; j <= cj + pr; j++) {
    if (i < 0 || j < 0 || i >= CG.n || j >= CG.n) continue;
    if ((i - ci) ** 2 + (j - cj) ** 2 <= pr * pr) cells[i * CG.n + j] = 1;
  }
  // coverage of the target circle
  const rc = P.clean.radiusMM / 10 / CG.cell;
  let tot = 0, hit = 0;
  for (let i = 0; i < CG.n; i++) for (let j = 0; j < CG.n; j++) {
    if ((i - half) ** 2 + (j - half) ** 2 > rc * rc) continue;
    tot++; if (cells[i * CG.n + j]) hit++;
  }
  const inTarget = Math.hypot(da, dl) * 10 < P.clean.radiusMM;
  const r = IV.cleanStroke(A, hit / tot, inTarget && movedPx > 0 ? dt : 0);
  if (r && r.why) toast(r.why);
  sfx('scrub');
  paint();
}

/* palpation feedback: a soft ring under the fingertip, faint, gone in 0.4 s */
function spawnRing(h, cue, f) {
  const { THREE } = ctx;
  const col = { vein: 0xdfe9ff, artery: 0xff5a5a, tendon: 0xffffff, valve: 0xffe08a }[cue.kind];
  let geo;
  if (cue.kind === 'tendon') geo = new THREE.PlaneGeometry(0.25, 1.6);
  else if (cue.kind === 'valve') geo = new THREE.CircleGeometry(0.22, 16);
  else geo = new THREE.RingGeometry(0.3, 0.42, 32);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, depthTest: false, side: THREE.DoubleSide }));
  const n = G.normalAt(h.a, h.l);
  const jit = [(Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5];
  m.position.set(...v3.add(v3.add(h.point, v3.mul(n, 0.1)), v3.sub(jit, v3.mul(n, v3.dot(jit, n)))));
  m.lookAt(...v3.add(h.point, v3.mul(n, 5)));
  if (cue.kind === 'tendon' && f?.tan) {
    const along = v3.norm(v3.sub(G.worldAt(h.a + f.tan[0], h.l + f.tan[1]), h.point));
    m.up.set(...along); m.lookAt(...v3.add(h.point, v3.mul(n, 5)));
  }
  m.renderOrder = 20;
  R3.group.add(m);
  R3.rings.push({ m, kind: cue.kind, s: cue.strength, t: 0, life: cue.kind === 'artery' ? 0.6 : 0.4 });
}
function animateRings(dt) {
  for (const r of R3.rings) {
    r.t += dt;
    const u = r.t / r.life;
    const a = Math.max(0, Math.sin(Math.PI * Math.min(1, u))) * (0.05 + 0.3 * r.s);
    r.m.material.opacity = a;
    if (r.kind === 'vein') r.m.scale.setScalar(0.6 + 0.9 * u - 0.25 * Math.sin(u * Math.PI * 2));   // a springy rebound
    if (r.kind === 'artery') r.m.scale.setScalar(0.5 + 1.1 * u);
  }
  for (const r of R3.rings.filter((x) => x.t >= x.life)) { R3.group.remove(r.m); r.m.geometry.dispose(); r.m.material.dispose(); }
  R3.rings = R3.rings.filter((x) => x.t < x.life);
}

/* ---------------------------------------------------------------- keys */
function onKey(e, down) {
  if (!ctx || ctx.S.mode !== 'iv') return;
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'f') { keys.f = down; if (!down && R3) R3.finger.visible = false; e.preventDefault(); return; }
  if (e.code === 'Space') {
    e.preventDefault();
    if (keys.space === down) return;
    keys.space = down;
    if (A && !A.finished && !A.ended && A.mark) IV.setTraction(A, down);
    refresh(); return;
  }
  if (!down) return;
  if (k === 'tab') { e.preventDefault(); document.body.classList.toggle('iv-hide-help'); return; }
  if (k === 'escape') { setTool(null); return; }
  if (!A || A.finished) return;
  if (k === 'r' && !e.repeat) { restart(); return; }
  if (k === 'q' || k === 'e') {
    const s = k === 'e' ? 1 : -1;
    if (A.syringe.on && !A.syringe.locked) { IV.twistSyringe(A, 15 * s); if (A.syringe.locked) sfx('twist'); }
    else if (A.syringe.locked && IV.currentStep(A) === 'syringeOff' && s < 0) { IV.twistSyringe(A, -15); if (!A.syringe.on) sfx('twist'); }
    else if (A.cap.on && !A.cap.locked) { IV.twistCap(A, 15 * s); if (A.cap.locked) sfx('twist'); }
    else if (kitAtSite()) IV.setYaw(A, A.needle.yaw + 2 * s);
    refresh(); return;
  }
  // keyboard alternatives to the drags
  if (k === 'w' || k === 's') { const r = IV.advance(A, k === 'w' ? 0.4 : -0.4); if (r?.why) toast(r.why); }
  if (k === 'z' || k === 'x') IV.setPitch(A, A.needle.pitch + (k === 'x' ? 1 : -1));
}
export function ivWheel(e) {
  if (!ctx || ctx.S.mode !== 'iv' || !A) return false;
  e.preventDefault();
  const st = IV.currentStep(A);
  if (st === 'thread' || (A.pierce.front && !A.cath.hubbed && A.done.has('insert'))) {
    if (e.deltaY < 0) {
      const r = IV.thread(A, 1);
      if (r?.why) toast(r.why);
      if (r && r.resist) toast('Resistance.');
      if (A.cath.hubbed) sfx('click');
    }
    refresh(); return true;
  }
  // (the cap twists on with the wheel too; the syringe only with Q / E)
  if (A.cap.on && !A.cap.locked) {
    IV.twistCap(A, e.deltaY < 0 ? 15 : -15);
    refresh(); return true;
  }
  const v = ctx.three.ivView; if (v) v.zoom = Math.max(0.35, Math.min(2.5, v.zoom * (e.deltaY > 0 ? 1.1 : 0.9)));
  return true;
}


/* ---------------------------------------------------------------- the cross-section */
const XS = { w: 160, h: 90, u0: -4, u1: 28, z0: -3, z1: 15 };
function drawSection() {
  const cv = $('ivXsCanvas'); if (!cv || !A?.mark) return;
  const g = cv.getContext('2d'), img = g.createImageData(XS.w, XS.h), d = img.data;
  const m = A.mark, n = A.needle, yaw = n.yaw * D, cy = Math.cos(yaw), sy = Math.sin(yaw);
  const r = m.radius * (1 + P.vein.tqSwell * A.tq.fill), b = r * (1 - A.vein.flat), w = P.vein.wallMM;
  const cz = IV.veinCentreZ(A);
  const tip = IV.needleTip(A), contact = !A.pierce.front && A.needle.inSkin && tip[2] >= m.depth + A.vein.dz - 0.05;
  const tipU = (tip[0]) * cy + (tip[1] - m.lateral) * sy;
  const fatBottom = m.depth + 2 * r + 4;
  const art = m.artery, pulse = 0.5 + 0.5 * Math.sin(performance.now() / 1000 * 2 * Math.PI * 70 / 60);
  for (let py = 0; py < XS.h; py++) {
    const z = XS.z0 + (XS.z1 - XS.z0) * (py + 0.5) / XS.h;
    for (let px = 0; px < XS.w; px++) {
      const u = XS.u0 + (XS.u1 - XS.u0) * (px + 0.5) / XS.w;
      const X = u * cy, Y = m.lateral + u * sy;
      let c = z < 0 ? [24, 30, 44] : z < 1.2 ? [214, 160, 140] : z < fatBottom ? [226, 196, 120] : [150, 60, 60];
      // the vein, cut by the slice: its height at this distance across, tented under the tip
      const ry = Y - A.vein.dy;
      if (Math.abs(ry) < r + w) {
        const k = Math.sqrt(Math.max(0, 1 - (ry / (r + w)) ** 2));
        let top = cz - (b + w) * k;
        if (contact) top += Math.max(0, tip[2] - (m.depth + A.vein.dz)) * Math.exp(-(((u - tipU) / 2.5) ** 2));
        const bot = cz + (b + w) * k;
        if (z >= top && z <= bot) {
          const kin = Math.sqrt(Math.max(0, 1 - (ry / r) ** 2));
          const inLumen = z >= cz - b * kin && z <= cz + b * kin && Math.abs(ry) < r && z >= top + w;
          c = inLumen ? [150, 18, 30] : [110, 40, 70];
        }
      }
      if (art) {
        const ay = Y - art.lateral;
        if (Math.abs(ay) < art.radius) {
          const k = Math.sqrt(1 - (ay / art.radius) ** 2), ac = art.depth + art.radius;
          if (Math.abs(z - ac) < art.radius * k * (0.9 + 0.1 * pulse)) c = [200 + 50 * pulse, 40, 40];
        }
      }
      if (A.hematoma > 0) {
        const dd = Math.hypot(u - tipU, z - cz);
        if (dd < 1 + 6 * A.hematoma && ((px * 7 + py * 13) % 5) < 3) c = [60, 20, 45];
      }
      const o = (py * XS.w + px) * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const U = (u) => (u - XS.u0) / (XS.u1 - XS.u0) * XS.w, Z = (z) => (z - XS.z0) / (XS.z1 - XS.z0) * XS.h;
  const pitch = n.pitch * D;
  // the ghost (Guided): the angle to come in at for this phase, drawn outside the skin only, back
  // from where the needle enters (or would, at that angle, to reach the tip where it is)
  if (A.mode === 'guided' && !n.shielded && !A.cath.hubbed) {
    const ga = (A.pierce.flashAt == null ? 22 : A.done.has('flash') ? 8 : 12) * D;
    const ex = n.inSkin ? tipU - (tip[2] / Math.tan(ga)) : tipU;
    g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = 1; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(U(ex), Z(0)); g.lineTo(U(ex - 16 * Math.cos(ga)), Z(-16 * Math.sin(ga))); g.stroke(); g.setLineDash([]);
  }
  // One path for both. The needle is straight along its shaft; the catheter rides on it to 1.5 mm
  // behind the bevel and, once threaded, runs on along the vein. As the needle comes back it follows
  // that path, and the catheter ahead of its tip, unsupported, goes limp: it sags to the vein's
  // floor, and outside the skin the hub's end lies down.
  const tz = tip[2], back = 30, cp = Math.cos(pitch), sp = Math.sin(pitch);
  const T = [tipU, tz];
  const along = (q, mm) => [q[0] - mm * cp, q[1] - mm * sp];               // back along the shaft
  const Bq = along(T, P.needle.bevelToCathMM);
  const cath = IV.catheterTip(A), C = A.cath.thread > 0 ? [cath[0] * cy + (cath[1] - m.lateral) * sy, cath[2]] : Bq;
  const E = tz > 0 && sp > 1e-3 ? along(T, tz / sp) : T;                    // where the shaft crosses the skin
  const wd = n.shielded ? 99 : (A.needle.withdrawn || 0);
  const N = along(T, wd);                                                   // the needle's tip now
  const limp = Math.max(0, Math.min(1, (wd - P.needle.bevelToCathMM) / 5));
  const far = along(E, 10), farLimp = [E[0] - 10, -0.6];
  const F0 = [far[0] + (farLimp[0] - far[0]) * limp, far[1] + (farLimp[1] - far[1]) * limp];
  const cathPath = () => {
    g.beginPath(); g.moveTo(U(F0[0]), Z(F0[1]));
    if (limp <= 0) {
      g.lineTo(U(E[0]), Z(E[1])); g.lineTo(U(Bq[0]), Z(Bq[1])); g.lineTo(U(C[0]), Z(C[1]));
    } else {
      // supported as far as the needle still reaches (never back past the skin), limp beyond
      const S = N[1] > E[1] ? N : E;
      const floor = cz + 0.45 * b;
      const Q = [Bq[0] + limp * 1.2, Bq[1] + limp * Math.max(0, Math.min(floor, cz) - Bq[1])];
      const Cl = [C[0], C[1] + limp * (floor - C[1])];
      g.lineTo(U(E[0]), Z(E[1])); if (S !== E) g.lineTo(U(S[0]), Z(S[1]));
      g.quadraticCurveTo(U(Q[0]), Z(Q[1]), U(Cl[0]), Z(Cl[1]));
    }
    g.stroke();
  };
  if (!n.shielded && N[1] > -12) {
    const Nb = along(N, back);
    g.strokeStyle = '#5d646d'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(U(N[0]), Z(N[1])); g.lineTo(U(Nb[0]), Z(Nb[1])); g.stroke();
    g.strokeStyle = '#b9c0c8'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(U(N[0]), Z(N[1]) - 0.5); g.lineTo(U(Nb[0]), Z(Nb[1]) - 0.5); g.stroke();
  }
  g.strokeStyle = 'rgba(225,230,236,0.5)'; g.lineWidth = 4; g.lineJoin = 'round'; g.lineCap = 'round';
  cathPath();
  // the hub's flash chamber, top right
  g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(XS.w - 22, 4, 18, 7);
  g.fillStyle = A.flash.artery ? `rgb(${200 + 55 * pulse},30,30)` : '#a01020';
  g.fillRect(XS.w - 21, 5, Math.round(16 * A.flash.level), 5);
  // the readout: the angle, in or out of this phase's window (a symbol too, not colour alone)
  const ang = Math.round(n.pitch), win = A.pierce.flashAt == null ? [P.angles.pierceMin, P.angles.pierceMax]
    : A.done.has('flash') ? [0, P.angles.threadMax] : [P.angles.lowerMin, P.angles.lowerMax];
  const inWin = ang >= win[0] && ang <= win[1], close = !inWin && (ang >= win[0] - 4 && ang <= win[1] + 4);
  const ro = $('ivXsAngle');
  if (ro) { ro.textContent = `${ang}° ${inWin ? '✓' : close ? '~' : '✗'}`; ro.className = 'ivxs-angle ' + (inWin ? 'in' : close ? 'close' : 'out'); }
  drawStrip();
}
// the top-down strip: the vein's direction against the needle's
function drawStrip() {
  const cv = $('ivXsStrip'); if (!cv) return;
  const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#1b2433'; g.fillRect(0, 0, cv.width, cv.height);
  const yaw = A.needle.yaw * D, cx = cv.width / 2, cy = cv.height / 2;
  g.save(); g.translate(cx, cy); g.rotate(yaw);
  g.fillStyle = 'rgba(70,90,150,0.9)'; g.fillRect(-cv.width, -4 - A.vein.dy, cv.width * 2, 8);
  g.restore();
  g.strokeStyle = '#e8edf2'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(8, cy + A.mark.lateral * 1.5); g.lineTo(cv.width - 8, cy + A.mark.lateral * 1.5); g.stroke();
}

/* ---------------------------------------------------------------- the screen */
function toast(msg) {
  if (!msg) return;
  const el = $('ivToast'); if (!el) return;
  el.textContent = msg; el.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 2200);
}
// the supply tray: each item drawn plainly, as it lies on a real tray
const TOOLS = [
  { id: 'tourniquet', label: 'Tourniquet', svg: '<path d="M9 35 L22 13 Q26 5 20 5 Q14 5 18 13 L31 35" fill="none" stroke="#e8875a" stroke-width="5.5" stroke-linejoin="round"/>' },
  { id: 'pad', label: 'Alcohol swab', svg: '<g transform="rotate(-8 20 20)"><rect x="6" y="8" width="28" height="24" rx="2" fill="#fbfbfc" stroke="#c3c9cf"/><rect x="8" y="14" width="24" height="9" fill="#2f74c0"/><rect x="11" y="16.4" width="15" height="1.7" fill="#fff"/><rect x="11" y="19.4" width="10" height="1.7" fill="#fff"/></g>' },
  { id: 'catheter', label: 'IV', svg: '<path d="M21 19 C7 22, 1 33, 10 35.5 L17 35.5" fill="none" stroke="#cdd7e0" stroke-width="2.2"/>'
    + '<rect x="5" y="17" width="20" height="8" rx="4" fill="#a9adb2" transform="rotate(-38 15 21)"/>'
    + '<path d="M20 11 L31 8.5 L26.5 19 Z" style="fill:var(--gc,#f08a9b)"/><line x1="26" y1="12.5" x2="38.5" y2="2.5" stroke="#6b737c" stroke-width="1.5"/>'
    + '<rect x="3.5" y="28.5" width="6" height="4" rx="1" fill="#1d2563"/>'
    + '<rect x="16.5" y="32.3" width="2.8" height="6.4" style="fill:var(--gc,#f08a9b)"/><rect x="19" y="32" width="14" height="7" rx="3.5" fill="#1d2563"/><rect x="33" y="33.5" width="5" height="4" rx="1.2" fill="#e6ecf1" stroke="#b9c3cc" stroke-width=".6"/>' },
  { id: 'tegaderm', label: 'Tegaderm', svg: '<path d="M7 9h26a2 2 0 0 1 2 2v18a2 2 0 0 1-2 2H22v-7h-4v7H7a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2z" fill="#f3efe4" stroke="#c9c2ad"/><rect x="12" y="12" width="16" height="10" rx="2" fill="#e3f0fb" stroke="#9fc0dc"/>' },
  { id: 'syringe', label: 'Flush', svg: '<g transform="rotate(-38 20 20)"><rect x="2" y="18.6" width="4" height="2.8" fill="#d5dde4"/><rect x="6" y="14.5" width="21" height="11" rx="1.5" fill="#f2f7fb" stroke="#9fb0bf"/><rect x="7.5" y="16" width="12.5" height="8" fill="#d6ecff"/>'
    + '<rect x="20" y="15.3" width="2.3" height="9.4" fill="#222"/><path d="M9 14.5v3M11 14.5v2M13 14.5v3M15 14.5v2M17 14.5v3M19 14.5v2" stroke="#3a4048" stroke-width=".8"/>'
    + '<rect x="27" y="11.5" width="1.7" height="17" rx=".6" fill="#c9d3dc"/><rect x="22.3" y="19" width="13.5" height="2" fill="#c9d3dc"/><rect x="35.5" y="14.5" width="2.2" height="11" rx="1" fill="#c9d3dc"/></g>' },
  { id: 'cap', label: 'Cap', svg: '<rect x="15" y="9" width="10" height="17" rx="3" fill="#ddd8f6" stroke="#a69de0"/><rect x="13" y="25" width="14" height="3" rx="1" fill="#cfc8f2" stroke="#a69de0"/><rect x="13" y="29.5" width="14" height="3" rx="1" fill="#cfc8f2" stroke="#a69de0"/><rect x="17" y="7" width="6" height="3" rx="1.2" fill="#f4f2fc" stroke="#a69de0"/>' },
  { id: 'gauze', label: 'Gauze', svg: '<rect x="7" y="7" width="26" height="26" rx="2" fill="#fbfbf8" stroke="#c4c9ce"/><path d="M7 15.7h26M7 24.3h26M15.7 7v26M24.3 7v26" stroke="#dde1e4"/>' },
];
function setTool(id) {
  tool = tool === id ? null : id;
  document.querySelectorAll('#ivTools button').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
  if (tool === 'syringe' && A) A.syringeTouched = false;
  if (tool === 'cap' && A) A.capTouched = false;
  document.body.classList.toggle('iv-tool', !!tool);
  refresh();
}
// which tool, if any, the current step wants in the hand (for the Guided glow)
const STEP_TOOL = { tourniquet: 'tourniquet', clean: 'pad', seal: 'catheter', align: 'catheter', dressing: 'tegaderm', syringe: 'syringe', cap: 'cap' };
function refresh() {
  if (!A) return;
  const st = IV.currentStep(A), si = IV.stepIndex(st), step = cfg.steps[si] || { title: 'Done', do: '', keys: [] };
  const guided = A.mode === 'guided', assess = A.mode === 'assessment';
  // the step card: the step, one line, the controls (Practice: the controls; Assessment: nothing)
  const card = $('ivStep');
  if (card) {
    if (A.ended && !A.finished) {
      card.innerHTML = `<div class="ivs-t ivs-bad">${IV.ERRORS[A.ended.code].msg}</div>`
        + `<div class="ivs-do">${!A.pressure.removed ? 'Remove the catheter.' : !A.pressure.gauze ? 'Gauze over the site.' : 'Hold pressure.'}</div>`
        + `<div class="ivs-keys">${!A.pressure.removed ? chip('Left-drag ↓', 'on the needle') : !A.pressure.gauze ? chip('Tool', 'gauze') + chip('Left-click', 'site') : chip('Hold left-click', 'on the gauze')}</div>`
        + (A.pressure.gauze ? '<div class="ivs-prog dry" id="ivProg"><i id="ivPressFill"></i><span id="ivPressLab"></span></div>' : '');
    } else if (A.finished) card.innerHTML = '';
    else {
      const mini = miniStep();
      const title = guided ? `<div class="ivs-t"><span class="ivs-n">${si}</span>${step.title}</div>` : '';
      const doText = mini ? mini.do : step.do;
      const doLine = guided && doText ? `<div class="ivs-do">${doText}</div>` : '';
      const prep = st === 'prep' ? `<div class="ivs-prep">${P.prep.map((p) => `<button data-prep="${p}" class="${A.prep.has(p) ? 'on' : ''}">${PREP_LABEL[p]}</button>`).join('')}</div>` : '';
      const ks = (assess ? '' : `<div class="ivs-keys">${(mini ? mini.keys : step.keys).map(([k, v]) => chip(k, v)).join('')}</div>`)
        + (mini?.newKit ? '<div class="ivs-prep"><button data-newkit="1">New kit</button></div>' : '');
      const fprog = st === 'flush' && !assess && A.syringe.locked ? '<div class="ivs-prog" id="ivFlushProg"><i id="ivFlushFill"></i><span id="ivFlushLab"></span></div>' : '';
      const prog = st === 'clean' && !assess && !mini ? '<div class="ivs-prog" id="ivProg"><i id="ivProgFill"></i><span id="ivProgLab"></span></div>' : '';
      card.innerHTML = title + doLine + prep + ks + prog + fprog;
      card.querySelectorAll('[data-prep]').forEach((b) => b.addEventListener('click', () => { IV.tickPrep(A, b.dataset.prep); refresh(); }));
      card.querySelector('[data-newkit]')?.addEventListener('click', () => {
        IV.replaceKit(A); Object.assign(PREP, { pack: 'closed', lift: 0, sealPeak: 0 }); refresh();
      });
    }
    card.classList.toggle('empty', !card.innerHTML);
  }
  // the tool tray: the tool this step wants glows in Guided
  document.querySelectorAll('#ivTools button').forEach((b) => {
    b.classList.toggle('want', guided && (STEP_TOOL[st] === b.dataset.tool || (A.ended && A.pressure.removed && b.dataset.tool === 'gauze')) && tool !== b.dataset.tool);
  });
  // the checklist (Guided)
  const cl = $('ivChecklist');
  if (cl) cl.start = 0;
  if (cl) cl.innerHTML = guided ? cfg.steps.map((s, i) => `<li class="${A.done.has(IV.STEP_IDS[i]) ? 'done' : i === si ? 'cur' : ''}">${s.title}</li>`).join('') : '';
  $('ivChecklistWrap')?.classList.toggle('hide', !guided);
  // the cross-section shows from the seal to the withdrawal, Guided and Practice
  const xs = !assess && A.mark && (A.done.has('seal') || A.needle.inSkin || PREP.atSite) && (!A.needle.shielded || st === 'clamp1') && !A.finished;
  $('ivXs')?.classList.toggle('show', !!xs);
  viewKey = stepView();
  paint();
}
const chip = (k, v) => `<span class="ivk"><b>${k}</b>${v}</span>`;
const PREP_LABEL = { hygiene: 'Hand hygiene', gloves: 'Gloves', patientId: 'Patient ID', order: 'Order' };

/* Hotspots: round buttons over the small things there are to click (clamp, port, tourniquet,
   the dressing's edges). They glow when the step wants them, in Guided. */
function hotspots(cam) {
  const box = $('ivHot'); if (!box || !A || !R3) return;
  const st = IV.currentStep(A), list = [];
  const { THREE } = ctx;
  if (R3.band.visible && R3.band.userData.anchor) list.push({ id: 'tq', at: R3.band.userData.anchor, want: st === 'tqoff', icon: '⊂⊃', tip: 'Tourniquet' });
  if (R3.kit.visible && A.cath.hubbed) {
    list.push({ id: 'clamp', at: worldOfKitPart(R3.clampM), want: ['clamp1', 'clamp2', 'clamp3'].includes(st), icon: A.clampOpen ? '◇' : '◆', tip: A.clampOpen ? 'Clamp: open' : 'Clamp: closed' });
    if (!A.portOpen && !A.cap.locked) list.push({ id: 'portcap', at: worldOfKitPart(R3.portCap), want: st === 'portcap', icon: '○', tip: 'Port cap' });
    if (A.portOpen && (tool === 'syringe' || tool === 'cap')) list.push({ id: 'port', at: worldOfKitPart(R3.port), want: true, icon: '◎', tip: 'Port' });
  }
  if (A.mode !== 'assessment' && R3.prep?.O && !A.ended) {
    if (tool === 'pad' && PREP.swab === 'closed' && PREP.swabT < 0.05) list.push({ id: 'cueSwab', at: prepPoint([SWAB_AT[0] - 2.3, 0.3, SWAB_AT[2] - 2.3]), cue: true });
    if (tool === 'pad' && PREP.swab === 'open') list.push({ id: 'cuePad', at: prepPoint([SWAB_AT[0], 0.5, SWAB_AT[2] - 2.4]), cue: true });
    if (tool === 'syringe' && PREP.flush !== 'ready' && PREP.flushT < 0.05 || (tool === 'syringe' && PREP.flush !== 'ready' && PREP.flush !== 'closed')) {
      const fl = R3.prep.flush;
      list.push({ id: 'cueFlush', at: PREP.flush === 'closed' ? prepPoint([FLUSH_AT[0] - SLEEVE.L / 2 + 0.8, 1.7, FLUSH_AT[2]]) : prepWorldOf(PREP.flush === 'open' ? fl.syr : fl.wcap), cue: true });
    }
    if (sharpsStage()) list.push({ id: 'cueSharps', at: PREP.sharps === 'held' ? prepWorldOf(R3.prep.spent) : prepPoint([SHARPS_AT[0], 11.2, SHARPS_AT[2] + 2.9]), cue: true });
    if ((tool === 'catheter' || IV.currentStep(A) === 'seal') && !kitAtSite() && !A.kit.off) {
      if (PREP.pack === 'closed') { if (PREP.packT < 0.05) list.push({ id: 'cueTab', at: prepPoint([PACK_AT[0] + LID.x0 + 0.45, LID.y + 0.2, PACK_AT[2] + LID.W / 2 - 0.45]), cue: true }); } else list.push({ id: 'cueKit', at: hubWorld(), cue: true });
    }
  }
  if (A.dressing.placed && !A.done.has('dressing') && A.dressingAt) {
    const m = A.mark, c = A.dressingAt, t = m.tan, hw = 3, hh = 3.5;
    const pts = [[c.a + t[0] * hh, c.l + t[1] * hh], [c.a - t[1] * hw, c.l + t[0] * hw], [c.a - t[0] * hh, c.l - t[1] * hh], [c.a + t[1] * hw, c.l - t[0] * hw]];
    pts.forEach((p, i) => { if (!A.dressing.edges[i]) list.push({ id: 'edge' + i, at: G.worldAt(p[0], p[1]), want: true, icon: '·', tip: 'Press the edge' }); });
  }
  const cv = ctx.three.renderer.domElement, r = cv.getBoundingClientRect(), br = box.getBoundingClientRect();
  const seen = new Set();
  for (const h of list) {
    const v = new THREE.Vector3(...h.at).project(cam);
    if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;      // (off the view: no button over the panels)
    let el = box.querySelector(`[data-hot="${h.id}"]`);
    if (!el) {
      el = document.createElement('button'); el.dataset.hot = h.id; el.type = 'button';
      el.addEventListener('pointerdown', (e) => { e.stopPropagation(); hotClick(h.id); });
      box.appendChild(el);
    }
    el.textContent = h.cue ? '' : h.icon; el.title = h.tip || '';
    el.classList.toggle('cue', !!h.cue);
    el.classList.toggle('want', A.mode === 'guided' && h.want);
    el.style.left = (r.left - br.left + (v.x * 0.5 + 0.5) * r.width) + 'px';
    el.style.top = (r.top - br.top + (-v.y * 0.5 + 0.5) * r.height) + 'px';
    seen.add(h.id);
  }
  box.querySelectorAll('[data-hot]').forEach((el) => { if (!seen.has(el.dataset.hot)) el.remove(); });
}
function hotClick(id) {
  if (!A) return;
  let r = { ok: true };
  if (id === 'tq') { r = IV.releaseTourniquet(A); if (r.ok) { R3.band.visible = false; sfx('snap'); } }
  else if (id === 'clamp') { r = IV.toggleClamp(A); if (r.ok) sfx('click'); }
  else if (id === 'portcap') { r = IV.removePortCap(A); if (r.ok) sfx('click'); }
  else if (id === 'port') {
    if (tool === 'syringe') {
      if (PREP.flush !== 'ready') { toast('Open the flush first.'); return; }
      r = IV.attachSyringe(A, !!A.syringeTouched); ptr.sawBlood = false;
    }
    else if (tool === 'cap') r = IV.attachCap(A, !!A.capTouched);
    if (r.ok) setTool(null);
  } else if (id.startsWith('edge')) r = IV.pressEdge(A, +id.slice(4));
  if (!r.ok && r.why) toast(r.why);
  refresh();
}

/* ---------------------------------------------------------------- the debrief */
function showDebrief() {
  const el = $('ivDebrief'); if (!el) return;
  const db = IV.debrief(A), s = db.score, mode = A.mode;
  const head = mode === 'guided' ? '<div class="ivd-score">Done</div>'
    : `<div class="ivd-score ${mode === 'assessment' ? (s.pass ? 'pass' : 'fail') : ''}">${s.total}<small>/100</small>${mode === 'assessment' ? `<span>${s.pass ? 'PASS' : 'FAIL'}</span>` : ''}</div>`;
  const cats = mode === 'guided' ? '' : `<div class="ivd-cats">${Object.entries(cfg.score.weights).map(([k, w]) =>
    `<div><span>${k}</span><i style="width:${(s.cat[k] / w * 100).toFixed(0)}%"></i><b>${Math.round(s.cat[k])}/${w}</b></div>`).join('')}</div>`;
  const steps = `<ol class="ivd-steps" start="0">${db.steps.map((st) => `<li class="${st.t == null ? 'miss' : st.errors.length ? 'err' : ''}">`
    + `<span>${st.title}</span><em>${st.t == null ? '—' : st.t.toFixed(0) + ' s'}</em>${st.errors.map((m) => `<b>${m}</b>`).join('')}</li>`).join('')}</ol>`;
  const tips = db.tips.length ? `<div class="ivd-tips">${db.tips.map((t) => `<p>${t}</p>`).join('')}</div>` : '';
  el.innerHTML = `<div class="ivd-card">${head}${cats}<div class="ivd-row"><div>${steps}</div><div><canvas id="ivTrace" width="300" height="140"></canvas>`
    + `<div class="ivd-meta">Tourniquet ${s.tourniquetS.toFixed(0)} s · total ${s.timeS.toFixed(0)} s · veins ${Math.round(A.difficulty * 100)}% hidden</div>${tips}</div></div>`
    + `<div class="ivd-btns"><button id="ivRetry">Retry</button><button id="ivSetupBtn">Change setup</button></div></div>`;
  el.classList.add('show');
  drawTrace(db);
  $('ivRetry').onclick = () => { el.classList.remove('show'); start(); };
  $('ivSetupBtn').onclick = () => { el.classList.remove('show'); A = null; showSetup(true); };
}
function drawTrace(db) {
  const cv = $('ivTrace'); if (!cv) return;
  const g = cv.getContext('2d'), tr = db.trace;
  g.fillStyle = '#121a26'; g.fillRect(0, 0, cv.width, cv.height);
  if (tr.length < 2) { g.fillStyle = '#7f8ea3'; g.font = '12px sans-serif'; g.fillText('No insertion', 12, 24); return; }
  const t0 = tr[0].t, t1 = tr[tr.length - 1].t || t0 + 1;
  const X = (t) => 8 + (t - t0) / (t1 - t0) * (cv.width - 16);
  // the pierce window, shaded
  const Ya = (a) => cv.height - 8 - a / 45 * (cv.height - 16);
  g.fillStyle = 'rgba(80,180,120,0.15)'; g.fillRect(8, Ya(P.angles.pierceMax), cv.width - 16, Ya(P.angles.pierceMin) - Ya(P.angles.pierceMax));
  g.strokeStyle = '#e6edf5'; g.lineWidth = 1.5; g.beginPath();
  tr.forEach((p, i) => (i ? g.lineTo(X(p.t), Ya(p.pitch)) : g.moveTo(X(p.t), Ya(p.pitch)))); g.stroke();
  const maxS = Math.max(...tr.map((p) => p.s), 1), Ys = (s) => cv.height - 8 - s / maxS * (cv.height - 16);
  g.strokeStyle = '#d7a64a'; g.beginPath();
  tr.forEach((p, i) => (i ? g.lineTo(X(p.t), Ys(p.s)) : g.moveTo(X(p.t), Ys(p.s)))); g.stroke();
  if (db.flashAt != null) { g.strokeStyle = '#d0303a'; g.beginPath(); g.moveTo(X(db.flashAt), 4); g.lineTo(X(db.flashAt), cv.height - 4); g.stroke(); }
  g.font = '11px sans-serif'; g.fillStyle = '#e6edf5'; g.fillText('angle', 12, 14);
  g.fillStyle = '#d7a64a'; g.fillText('depth', 54, 14); g.fillStyle = '#d0303a'; g.fillText('flash', 98, 14);
}

/* ---------------------------------------------------------------- sound: short, quiet, synthesised */
let audio = null, scrubSrc = null;
function sfx(kind) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const a = audio, t = a.currentTime, out = a.createGain(); out.gain.value = 0.12; out.connect(a.destination);
    const noise = (dur) => { const b = a.createBuffer(1, a.sampleRate * dur, a.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; const s = a.createBufferSource(); s.buffer = b; return s; };
    if (kind === 'snap') { const s = noise(0.08), f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; s.connect(f).connect(out); s.start(t); }
    else if (kind === 'click' || kind === 'twist') { const o = a.createOscillator(); o.frequency.value = kind === 'click' ? 2200 : 1300; const e = a.createGain(); e.gain.setValueAtTime(0.6, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.05); o.connect(e).connect(out); o.start(t); o.stop(t + 0.06); }
    else if (kind === 'pop') { const o = a.createOscillator(); o.frequency.setValueAtTime(500, t); o.frequency.exponentialRampToValueAtTime(180, t + 0.08); const e = a.createGain(); e.gain.setValueAtTime(0.5, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.1); o.connect(e).connect(out); o.start(t); o.stop(t + 0.12); }
    else if (kind === 'creak') { const o = a.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 90; const e = a.createGain(); e.gain.setValueAtTime(0.25, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.18); o.connect(e).connect(out); o.start(t); o.stop(t + 0.2); }
    else if (kind === 'scrub' && !scrubSrc) { const s = noise(0.3), f = a.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2500; s.loop = true; const e = a.createGain(); e.gain.value = 0.25; s.connect(f).connect(e).connect(out); s.start(t); scrubSrc = s; clearTimeout(sfx.st); sfx.st = setTimeout(() => sfx('scrubStop'), 200); }
    else if (kind === 'scrub') { clearTimeout(sfx.st); sfx.st = setTimeout(() => sfx('scrubStop'), 200); }
    else if (kind === 'scrubStop' && scrubSrc) { try { scrubSrc.stop(); } catch { /* */ } scrubSrc = null; }
  } catch { /* no audio, no matter */ }
}

/* ---------------------------------------------------------------- the frame */
let prevTip = 'outside', prevStep = null, prevFlash = false, prevEnded = false;
function frame(now) {
  loop = requestAnimationFrame(frame);
  if (!ctx || ctx.S.mode !== 'iv' || !R3) return;
  const dt = Math.min(0.1, (now - (lastT || now)) / 1000); lastT = now;
  if (A && !A.finished) {
    IV.update(A, dt);
    if (A.ended && ptr.kind === 'press' && ptr.down) IV.holdPressure(A, dt);
    // events worth a sound or a redraw
    if (A.tip === 'lumen' && prevTip !== 'lumen' && A.mode === 'guided') sfx('pop');
    prevTip = A.tip;
    const st = IV.currentStep(A);
    if (st !== prevStep || (A.flash.level > 0) !== prevFlash || !!A.ended !== prevEnded) {
      prevStep = st; prevFlash = A.flash.level > 0; prevEnded = !!A.ended;
      refresh();
    }
    // the skin changes slowly (veins filling, a bruise spreading, the prep drying): ten times a second
    if ((A.tq.fill > 0 && A.tq.fill < 1) || A.hematoma > 0 || A.infiltration > 0 || (A.clean.dryFrom != null && !A.clean.dry)
      || (A.clean.dry && A.t - (A.clean.dryAt ?? -99) < 12.5)) {
      if (now - (frame.painted || 0) > 100) { paint(); frame.painted = now; }
    }
    if (A.flags.length) toast(A.flags.shift().msg);
  }
  // (the last step, or End, finishes the attempt from an input handler: the debrief follows on the next frame)
  if (A && A.finished && !A.debriefShown) { A.debriefShown = true; showDebrief(); }
  animatePrep(dt);
  placeKit(); placeSyringe(); placeThumb();
  if (R3.gauze) {
    R3.gauze.visible = !!(A && A.ended && A.pressure.gauze);
    if (R3.gauze.visible && R3.gauze.userData.at) {
      const h = R3.gauze.userData.at, n = G.normalAt(h.a, h.l);
      R3.gauze.position.set(...v3.add(h.point, v3.mul(n, ptr.down && ptr.kind === 'press' ? 0.08 : 0.2)));
      R3.gauze.quaternion.setFromUnitVectors(new ctx.THREE.Vector3(0, 1, 0), new ctx.THREE.Vector3(...n));
    }
  }
  animateRings(dt);
  updateCamera(dt);
  hotspots(ctx.three.cam);
  if ($('ivXs')?.classList.contains('show')) drawSection();
  // the tourniquet clock
  const tq = $('ivTq');
  if (tq && A) {
    const s = IV.tourniquetTime(A);
    tq.textContent = A.tq.on || s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '–:––';
    tq.className = 'ivtq ' + (s > P.tourniquet.limitS ? 'over' : s > P.tourniquet.warnS ? 'warn' : A.tq.on ? 'on' : '');
  }
  // the flush: drawn back for blood, then pushed; the speed against the catheter's rating
  const ff = $('ivFlushFill');
  if (ff && A) {
    const fs = A.syringe, max = P.gauges[A.gauge].rateMLs, rate = performance.now() - (ptr.lastPush || 0) < 300 ? fs.rate : 0;
    ff.style.width = (Math.min(1, fs.vol / P.flush.volumeML) * 100).toFixed(1) + '%';
    $('ivFlushLab').textContent = !fs.checked ? 'Pull back first: blood?'
      : `${fs.vol.toFixed(1)} / ${P.flush.volumeML} mL \u00b7 ${rate.toFixed(1)} mL/s (1\u2013${max})`;
    ff.parentElement.classList.toggle('bad', rate > max || (rate > 0 && rate < P.flush.minRateMLs));
  }
  // pressure on the gauze: how long left to hold
  const pr = $('ivPressFill');
  if (pr && A?.ended) {
    pr.style.width = (Math.min(1, A.pressure.held / P.pressureS) * 100).toFixed(1) + '%';
    $('ivPressLab').textContent = `Pressure · ${Math.max(0, Math.ceil(P.pressureS - A.pressure.held))} s`;
  }
  // the needle's angle, in Assessment, where there is no section to read it from
  const an = $('ivAngle');
  if (an) {
    const show = !!A && A.mode === 'assessment' && !!A.mark && kitAtSite() && !A.needle.shielded && !A.ended && !A.finished;
    an.classList.toggle('show', show);
    if (show) $('ivAngleV').textContent = `${Math.round(A.needle.pitch)}\u00b0`;
  }
  // the clean: how much is scrubbed, then how long left to dry
  const pf = $('ivProgFill');
  if (pf && A && !A.done.has('clean')) {
    const c = A.clean, pc = P.clean;
    let f, lab, dry = false;
    if (c.dryFrom != null && !c.dry && pc.dryS > 0) {
      f = Math.min(1, (A.t - c.dryFrom) / pc.dryS); dry = true;
      lab = `Drying · ${Math.max(0, Math.ceil(pc.dryS - (A.t - c.dryFrom)))} s · hands off`;
    } else {
      const fc = Math.min(1, c.coverage / pc.coverage), ft = Math.min(1, c.scrub / pc.scrubS);
      f = Math.min(fc, ft);
      lab = (fc >= 1 && ft < 1 ? 'Keep scrubbing' : ft >= 1 && fc < 1 ? 'Cover the whole circle' : 'Scrub') + ` · ${Math.round(f * 100)}%`;
    }
    pf.style.width = (f * 100).toFixed(1) + '%';
    pf.parentElement.classList.toggle('dry', dry);
    $('ivProgLab').textContent = lab;
  }
  // the flash, magnified, for every mode (it is what the hand sees)
  const fb = $('ivFlashFill');
  if (fb && A) { fb.style.width = (A.flash.level * 100).toFixed(0) + '%'; fb.classList.toggle('art', !!A.flash.artery); }
  $('ivFlash')?.classList.toggle('gone', !A || !A.mark || A.needle.shielded || !!A.pressure.removed);
}

/* ---------------------------------------------------------------- setup, start, the mode */
function showSetup(on) {
  document.body.classList.toggle('iv-setup', on);
  $('ivSetup')?.classList.toggle('show', on);
  $('ivRun')?.classList.toggle('show', !on);
  if (on) { $('ivStep').innerHTML = ''; $('ivStep').classList.add('empty'); $('ivXs')?.classList.remove('show'); }
}
async function loadSite() {
  const site = cfg.sites[setup.site], S = ctx.S;
  if (S.subject !== site.subject) await ctx.setSubject(site.subject);
  S.objRot = { x: 0, y: 0, z: 0 }; S.objOff.x = 0; S.objOff.z = 0; S.objOff.y = 0; S.joints = {}; S.legRot = 0;
  ctx.syncScene();
  disposeRoom(); makeRoom();
  G = buildGeometry(setup.site);
  placeBoard();
  buildPatch();
}
// the board under the limb, and the overview framing (again for every fresh room)
function placeBoard() {
  const { THREE, three } = ctx;
  const box = new THREE.Box3().setFromObject(three.chestGroup);
  const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
  R3.board.scale.set(sz.x + 10, 2.4, sz.z + 6);
  R3.board.position.set(c.x, box.min.y - 1.2, c.z);
  R3.bbox = { c: [c.x, c.y, c.z], span: Math.max(sz.x, sz.z, 30) };
  placePrep(box);
}
async function start() {
  attempts += 1;
  if (!G || G.siteKey !== setup.site) await loadSite();
  else { disposeRoom(); makeRoom(); placeBoard(); buildPatch(); }
  A = IV.createAttempt(cfg, { ...setup, number: attempts });
  // (Assessment: somewhere between some veins seen and none, unannounced)
  A.difficulty = (setup.mode === 'assessment' ? 25 + 5 * Math.floor(Math.random() * 16) : setup.difficulty) / 100;
  $('ivTools')?.style.setProperty('--gc', P.gauges[setup.gauge].color);
  tool = null; keys.space = false; keys.f = false;
  resetPrep();
  prevTip = 'outside'; prevStep = null; prevFlash = false; prevEnded = false;
  if (ctx.three.ivView) ctx.three.ivView.zoom = 1;
  showSetup(false);
  setTool(null);
  refresh();
}
function restart() { $('ivDebrief')?.classList.remove('show'); attempts = Math.max(0, attempts - 1); start(); }

export function ivSyncScene() {
  if (!ctx) return;
  const { S, three } = ctx;
  const on = S.mode === 'iv';
  if (R3) R3.group.visible = on;
  if (!on) return;
  if (three.tube) three.tube.visible = false;
  if (three.lamp) three.lamp.intensity = 0;
  if (three.cr) three.cr.visible = false;
  for (const k of ['det', 'detMarks', 'detArrow', 'aecGroup']) if (three[k]) three[k].visible = false;
  if (three.amb) three.amb.intensity = 0.95;
  if (three.key) three.key.intensity = 1.0;
}
export function ivApplyMode(on) {
  if (!ctx) return;
  if (on) {
    attempts = 0; A = null;
    showSetup(true);
    loadSite().then(() => { ctx.syncScene(); });
    cancelAnimationFrame(loop); lastT = 0; loop = requestAnimationFrame(frame);
  } else {
    cancelAnimationFrame(loop); loop = 0;
    disposeRoom(); G = null; A = null;
    ctx.three.ivView = null;
    $('ivDebrief')?.classList.remove('show');
  }
  ivSyncScene();
}

export function initIV(context) {
  ctx = context;
  // setup: the site, the mode, the gauge
  const seg = (id, key) => document.querySelectorAll(`#${id} button`).forEach((b) => b.addEventListener('click', async () => {
    setup[key] = b.dataset.v;
    document.querySelectorAll(`#${id} button`).forEach((x) => x.classList.toggle('on', x === b));
    if (key === 'site' && ctx.S.mode === 'iv') { await loadSite(); ctx.syncScene(); }
  }));
  seg('ivSiteSeg', 'site'); seg('ivModeSeg', 'mode'); seg('ivGaugeSeg', 'gauge');
  // difficulty: how much of the veins shows. Set in Guided and Practice; Assessment draws its own
  const diff = $('ivDiff');
  const syncDiff = () => {
    const assess = setup.mode === 'assessment';
    if (diff) { diff.disabled = assess; setup.difficulty = +diff.value; }
    if ($('ivDiffV')) $('ivDiffV').textContent = assess ? 'Random' : `${setup.difficulty}%`;
    $('ivDiffWrap')?.classList.toggle('off', assess);
  };
  diff?.addEventListener('input', syncDiff);
  document.querySelectorAll('#ivModeSeg button').forEach((b) => b.addEventListener('click', syncDiff));
  syncDiff();
  $('ivStart')?.addEventListener('click', () => { attempts = 0; start(); });
  $('ivRestart')?.addEventListener('click', restart);
  $('ivEnd')?.addEventListener('click', () => { if (A && !A.finished) IV.finish(A); });
  $('ivBack')?.addEventListener('click', () => { if (A && !A.finished && !confirm('Leave this attempt?')) return; A = null; showSetup(true); });
  const tools = $('ivTools');
  if (tools) {
    tools.innerHTML = TOOLS.map((t) => `<button type="button" data-tool="${t.id}" title="${t.label}"><svg viewBox="0 0 40 40" aria-hidden="true">${t.svg}</svg><span>${t.label}</span></button>`).join('');
    tools.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  }
  document.querySelectorAll('#ivViews button').forEach((b) => b.addEventListener('click', () => {
    viewPinned = viewPinned === b.dataset.view ? null : b.dataset.view;
    document.querySelectorAll('#ivViews button').forEach((x) => x.classList.toggle('on', x.dataset.view === viewPinned));
    if (ctx.three.ivView) ctx.three.ivView.zoom = 1;
  }));
  document.addEventListener('keydown', (e) => onKey(e, true));
  document.addEventListener('keyup', (e) => onKey(e, false));
  window.addEventListener('blur', () => { if (keys.space && A && A.mark) IV.setTraction(A, false); keys.space = false; keys.f = false; });
  // the hook the browser checks drive the room with: where a site point is on the screen
  if (typeof window !== 'undefined') window.radsimIV = { attempt: () => A, IV, cfg, geometry: () => G, room: () => R3, start, setup, view: () => ctx.three.ivView, THREE: () => ctx.THREE, three: () => ctx.three,
    hit: (x, y) => hitPatch({ clientX: x, clientY: y }, ctx.three.renderer.domElement, ctx.three.cam), tool: () => tool,
    screen: (a, l) => {
      const { THREE, three } = ctx, w = G.worldAt(a, l), v = new THREE.Vector3(...w).project(three.cam);
      const r = three.renderer.domElement.getBoundingClientRect();
      return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
    } };
}
