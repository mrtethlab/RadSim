/* THE PROCEDURE ROOM: the fluoroscopy suite (fluoro/suite.js: the app's own C-arm and monitor
   cart, the cantilevered table) with the patient the procedure needs, the sterile back table, a
   non-sterile side cart, and what is laid on the patient: the skin prep, the fenestrated drape,
   the C-arm's sterile cover, a grounding pad, the dressing.

   The patient: the child (pediatric_skin.glb, its bones under it) prone, as its mesh is (its
   volume is LPS: the back up, its left toward +x, the operator's side), raised on foam pads where
   its face and legs would hang over the table; or the adult (the suite's own chest/abdomen/pelvis,
   with its thighs) supine. Its group is placed by a translation only, so the patient's frame (cm)
   has the room's axes (geom.js). Its top surface (the back, or the front) is kept as a height
   field, top(x, z), for everything laid on it. */
import * as THREE from 'three';
import { buildSuite, FLOOR_Y, ISO } from '../fluoro/suite.js';
import { std, mesh, setOpacity } from '../../kit/stage.js';
import { MAT, canvasTex, makeBackTable } from './props.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const TABLE_TOP = -0.4;            // the suite's tabletop surface (its top board's face)

export async function buildRoom(api, { patient = 'child' } = {}) {
  const adult = patient === 'adult';
  const suite = await buildSuite(api, { patient: adult });
  const room = suite.g;

  // ---- the patient
  let pat, skinG, boneG, skinMat;
  if (adult) {
    pat = suite.patient; skinG = suite.skinG; boneG = suite.boneG; skinMat = suite.skinMat;
  } else {
    pat = new THREE.Group(); suite.bed.add(pat);
    const [skin, bone] = await Promise.all([
      api.loadGlb('models/pediatric/pediatric_skin.glb').catch(() => null),
      api.loadGlb('models/pediatric/pediatric_bone.glb').catch(() => null),
    ]);
    skinMat = new THREE.MeshStandardMaterial({ color: 0xe0aa88, roughness: 0.62, side: THREE.DoubleSide });
    const add = (m, mat) => {
      if (!m) return null;
      m.scale.setScalar(0.1);
      m.traverse((o) => { if (o.isMesh) { if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); o.material = mat; o.castShadow = true; o.receiveShadow = true; } });
      pat.add(m); return m;
    };
    skinG = add(skin, skinMat);
    boneG = add(bone, std(0xe8e0c8, 0.5, 0.05));
    if (boneG) boneG.visible = false;
  }
  pat.updateMatrixWorld(true);

  // ---- the patient's top surface: the highest skin over each 1 cm cell (the patient's frame)
  const HF = { x0: -36, z0: -80, n: 72, m: 170, s: 1 };
  const hf = new Float32Array(HF.n * HF.m).fill(NaN);
  let minY = Infinity;
  const bottom = [];                                         // the lowest skin per 1 cm of z (the pads)
  if (skinG) {
    const inv = new THREE.Matrix4().copy(pat.matrixWorld).invert(), M = new THREE.Matrix4(), v = new THREE.Vector3();
    skinG.updateMatrixWorld(true);
    skinG.traverse((o) => {
      if (!o.isMesh) return;
      M.multiplyMatrices(inv, o.matrixWorld);
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(M);
        const ci = Math.floor((v.x - HF.x0) / HF.s), cj = Math.floor((v.z - HF.z0) / HF.s);
        if (ci < 0 || cj < 0 || ci >= HF.n || cj >= HF.m) continue;
        const k = cj * HF.n + ci;
        if (!(hf[k] >= v.y)) hf[k] = v.y;
        if (Math.abs(v.x) < 15 && v.y < minY) minY = v.y;
        const b = bottom[cj] || (bottom[cj] = { y: Infinity, x0: Infinity, x1: -Infinity });
        if (v.y < b.y) b.y = v.y;
        b.x0 = Math.min(b.x0, v.x); b.x1 = Math.max(b.x1, v.x);
      }
    });
  }
  // cells the skin's vertices missed: the neighbours' highest
  for (let pass = 0; pass < 2; pass++) {
    const prev = hf.slice();
    for (let j = 1; j < HF.m - 1; j++) for (let i = 1; i < HF.n - 1; i++) {
      const k = j * HF.n + i;
      if (!isNaN(prev[k])) continue;
      let best = NaN, cnt = 0;
      for (const d of [-1, 1, -HF.n, HF.n]) if (!isNaN(prev[k + d])) { cnt++; if (!(best >= prev[k + d])) best = prev[k + d]; }
      if (cnt >= 2) hf[k] = best;
    }
  }
  const top = (x, z) => {
    const fx = (x - HF.x0) / HF.s - 0.5, fz = (z - HF.z0) / HF.s - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= HF.n - 1 || j >= HF.m - 1) return null;
    const a = hf[j * HF.n + i], b = hf[j * HF.n + i + 1], c = hf[(j + 1) * HF.n + i], d = hf[(j + 1) * HF.n + i + 1];
    const vals = [a, b, c, d].filter((q) => !isNaN(q));
    if (vals.length < 3) return null;
    const ax = fx - i, az = fz - j, f = (q) => (isNaN(q) ? Math.max(...vals) : q);
    return (f(a) * (1 - ax) + f(b) * ax) * (1 - az) + (f(c) * (1 - ax) + f(d) * ax) * az;
  };

  // ---- on the table: the child's front down on it, raised on pads where it would hang
  const pads = new THREE.Group(); suite.bed.add(pads);
  const padTop = [];                                         // per 1 cm of z: { y (the patient's frame), x0, x1 }
  if (!adult) {
    const PH = TABLE_TOP + 0.15 - (isFinite(minY) ? minY : -13.5);
    pat.position.set(0, PH, 0);
    const foam = std(0x8fb7d6, 0.9, 0.0);
    /* gel pads where the lowest skin hangs more than 1.5 cm over the table (the face, the shins):
       each a run of z, its side profile following the skin's underside (less a few mm), drawn out
       across the body's width and rounded at its edges */
    const gap = [];
    for (let j = 0; j < HF.m; j++) gap[j] = bottom[j] ? bottom[j].y + PH - TABLE_TOP : null;
    let j = 0;
    while (j < HF.m) {
      if (gap[j] == null || gap[j] < 1.5) { j++; continue; }
      let j1 = j;
      while (j1 + 1 < HF.m && gap[j1 + 1] != null && gap[j1 + 1] >= 1.5) j1++;
      if (j1 - j >= 2) {
        const sh = new THREE.Shape(), z = (k) => HF.z0 + (k + 0.5) * HF.s;
        let x0 = Infinity, x1 = -Infinity;
        sh.moveTo(z(j) - 1.5, 0);
        for (let k = j; k <= j1; k++) {
          const h = Math.min(gap[Math.max(j, k - 1)], gap[k], gap[Math.min(j1, k + 1)]) - 0.35;
          sh.lineTo(z(k), Math.max(0.5, h));
          x0 = Math.min(x0, bottom[k].x0); x1 = Math.max(x1, bottom[k].x1);
        }
        sh.lineTo(z(j1) + 1.5, 0);
        sh.lineTo(z(j) - 1.5, 0);
        const w = Math.max(12, Math.min(40, x1 - x0 - 2));
        for (let k = j; k <= j1; k++) padTop[k] = { y: TABLE_TOP + gap[k] - PH, x0: (x0 + x1) / 2 - w / 2 - 1, x1: (x0 + x1) / 2 + w / 2 + 1 };
        const geo = new THREE.ExtrudeGeometry(sh, { depth: w - 2, bevelEnabled: true, bevelThickness: 1, bevelSize: 0.8, bevelSegments: 3, curveSegments: 4 });
        geo.rotateY(-Math.PI / 2);
        geo.translate((x0 + x1) / 2 + (w - 2) / 2, TABLE_TOP, 0);
        const b = new THREE.Mesh(geo, foam); b.castShadow = b.receiveShadow = true; pads.add(b);
      }
      j = j1 + 1;
    }
    pat.updateMatrixWorld(true);
  }
  const toRoom = (p) => { const v = new THREE.Vector3(...p); pat.localToWorld(v); return [v.x, v.y, v.z]; };
  const fromRoom = (p) => { const v = new THREE.Vector3(...p); pat.worldToLocal(v); return [v.x, v.y, v.z]; };
  // the skin's see-through: k 0 opaque, 1 the bones shown through a ghost of it
  const xray = (k) => {
    if (skinG) setOpacity(skinG, 1 - 0.75 * clamp01(k));
    if (prep) prep.mesh.material.opacity = 1 - 0.8 * clamp01(k);       // the prep on the skin fades with it
    if (boneG) boneG.visible = k > 0.02;
  };

  // ---- the draped height: the top surface widened and smoothed, never under the table (the
  // patient's frame): what a sheet laid over the patient rests on
  const tableY = fromRoom([0, TABLE_TOP, 0])[1];
  const draped = (x, z) => {
    let h = -Infinity;
    for (const [dx, dz] of [[0, 0], [-3, 0], [3, 0], [0, -3], [0, 3], [-5, 0], [5, 0]]) {
      const t = top(x + dx, z + dz);
      if (t != null) h = Math.max(h, t - (Math.abs(dx) + Math.abs(dz)) * 0.45);
    }
    const rx = toRoom([x, 0, z])[0];
    const over = Math.max(0, Math.abs(rx) - 28);             // past the table's edge, the sheet hangs
    let base = tableY + 0.3 - over * 3.2;
    const pd = padTop[Math.floor((z - HF.z0) / HF.s)];
    if (pd && x > pd.x0 - 3 && x < pd.x1 + 3) base = Math.max(base, pd.y + 0.6);   // and over the pads
    return Math.max(h + 0.45, base);
  };

  // ---- the back table (sterile) and the side cart (not): beside the table on the operator's side
  const backT = makeBackTable(FLOOR_Y - 3); backT.g.position.set(72, 3, -70); room.add(backT.g);
  const side = new THREE.Group(); side.position.set(108, 0, -36); room.add(side);
  {
    const st = std(0xc9ced3, 0.3, 0.75);
    side.add(mesh(new THREE.BoxGeometry(34, 1.2, 44), st, 0, -0.6, 0));
    for (const [x, z] of [[-15, -20], [15, -20], [-15, 20], [15, 20]]) side.add(mesh(new THREE.CylinderGeometry(0.9, 0.9, -FLOOR_Y - 2, 10), st, x, FLOOR_Y / 2 - 1, z));
    side.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
  }

  // ---- the skin prep: a patch laid on the top surface round the site; its canvas painted (paint)
  // or wiped (clean) along the spiral a sponge stick draws, outward from the site
  const prep = (() => {
    const R = 13, N = 44, geo = new THREE.PlaneGeometry(2 * R, 2 * R, N, N); geo.rotateX(-Math.PI / 2);
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.35, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.renderOrder = 2; m.visible = false; pat.add(m);
    const rest = geo.attributes.position.array.slice();
    let at = [0, 0, 0];
    const turns = 4.5;
    // the spiral (the patient's frame) at s 0..1
    const spiral = (s) => { const a = s * turns * Math.PI * 2, r = 0.6 + s * (R - 2.2); return [at[0] + Math.cos(a) * r, at[2] + Math.sin(a) * r]; };
    function site(p) {
      at = p;
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = at[0] + rest[i * 3], z = at[2] + rest[i * 3 + 2];
        const t = top(x, z);
        pos.setXYZ(i, x, t == null ? -999 : t + 0.08, z);
      }
      pos.needsUpdate = true; geo.computeVertexNormals(); geo.computeBoundingSphere();
    }
    const g = cv.getContext('2d');
    const uv = ([x, z]) => [(x - at[0] + R) / (2 * R) * 256, (z - at[2] + R) / (2 * R) * 256];
    function stroke(s0, s1, color, alpha, wid) {
      g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = wid; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath();
      for (let s = s0; s <= s1 + 1e-6; s += 0.004) { const [u, v] = uv(spiral(Math.min(s, s1))); if (s === s0) g.moveTo(u, v); else g.lineTo(u, v); }
      g.stroke(); g.globalAlpha = 1;
    }
    /* paint(k): the prep painted out to k of its spiral; clean(k): then wiped off out to k. Both
       return where the sponge (or the gauze) is, on the skin (the patient's frame). */
    function draw(k, wipe) {
      g.clearRect(0, 0, 256, 256);
      m.visible = k > 0.002 || wipe != null;
      if (k > 0.002 || wipe != null) stroke(0, wipe != null ? 1 : k, '#7a3510', 0.82, 30);
      if (wipe != null && wipe > 0.002) { g.globalCompositeOperation = 'destination-out'; stroke(0, wipe, '#000', 1, 34); g.globalCompositeOperation = 'source-over'; }
      if (wipe != null && wipe > 0.995) m.visible = false;
      tex.needsUpdate = true;
      const [x, z] = spiral(wipe != null ? wipe : k), t = top(x, z);
      return [x, (t ?? 0) + 0.1, z];
    }
    return { mesh: m, site, paint: (k) => draw(clamp01(k), null), clean: (k) => draw(1, clamp01(k)), spiral };
  })();

  // ---- the fenestrated drape: a blue sheet over the patient, its window over the site (the
  // patient's frame), laid by set(k): folded above the site, unfolding outward as it settles
  const drape = (() => {
    const W = 100, L = 150, nx = 50, nz = 75;
    const geo = new THREE.PlaneGeometry(W, L, nx, nz); geo.rotateX(-Math.PI / 2);
    const tex = canvasTex(512, 768, () => {});
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, side: THREE.DoubleSide, alphaTest: 0.5 }));
    m.castShadow = true; m.receiveShadow = true; m.visible = false; pat.add(m);
    const rest = geo.attributes.position.array.slice();
    let laid = null, at = [0, 0, 0];
    function site(p, { hole = [9, 9] } = {}) {
      at = p;
      // the texture: blue, the window cut out (transparent) with its adhesive frame round it
      const cv = tex.userData.cv, c = cv.getContext('2d');
      c.clearRect(0, 0, 512, 768); c.fillStyle = '#2f6aa6'; c.fillRect(0, 0, 512, 768);
      c.fillStyle = '#3a78b6'; for (let i = 0; i < 768; i += 24) c.fillRect(0, i, 512, 3);
      const hx = hole[0] / W * 512, hz = hole[1] / L * 768;
      c.fillStyle = '#f4f2ea'; c.fillRect(256 - hx / 2 - 10, 384 - hz / 2 - 10, hx + 20, hz + 20);
      c.clearRect(256 - hx / 2, 384 - hz / 2, hx, hz);
      tex.needsUpdate = true;
      laid = new Float32Array(rest.length);
      for (let i = 0; i < rest.length; i += 3) {
        const x = at[0] + rest[i], z = at[2] - rest[i + 2];
        laid[i] = x; laid[i + 1] = draped(x, z); laid[i + 2] = z;
      }
      geo.attributes.uv.needsUpdate = true;
    }
    function set(k) {
      m.visible = k > 0.001 && !!laid;
      if (!m.visible) return;
      const pos = geo.attributes.position, up = 22;
      for (let i = 0; i < pos.count; i++) {
        const dx = rest[i * 3], dz = -rest[i * 3 + 2], r = Math.hypot(dx / W, dz / L) * 2;
        const kv = clamp01(k * 1.7 - r * 0.7);
        const fx = at[0] + dx * 0.1, fz = at[2] + dz * 0.1, fy = (top(at[0], at[2]) ?? 0) + up - r * 2;
        const e = kv * kv * (3 - 2 * kv);
        pos.setXYZ(i, fx + (laid[i * 3] - fx) * e, fy + (laid[i * 3 + 1] - fy) * e, fz + (laid[i * 3 + 2] - fz) * e);
      }
      pos.needsUpdate = true; geo.computeVertexNormals(); geo.computeBoundingSphere();
    }
    return { mesh: m, site, set };
  })();

  // ---- the C-arm's sterile cover: a clear bag drawn over the receptor end of the C, its elastic
  // band at the open end. set(k): 0 folded flat on the receptor's face, 1 pulled up past its cap
  const cover = (() => {
    const g = new THREE.Group(); suite.carm.c.add(g); g.visible = false;
    const DET = suite.DET, R = 27, H = 52;
    const geo = new THREE.CylinderGeometry(R, R * 0.97, 1, 40, 12, true);
    // crinkles: the radius wavers round and along it
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), a = Math.atan2(z, x);
      const w = 1 + 0.03 * Math.sin(a * 9 + y * 7) + 0.02 * Math.sin(a * 23 - y * 11);
      p.setXYZ(i, x * w, y + 0.5, z * w);                     // y 0..1 along the bag
    }
    geo.computeVertexNormals();
    const film = MAT.clear(0xdff0ff, 0.22);
    const tubeM = new THREE.Mesh(geo, film); g.add(tubeM);
    const face = new THREE.Mesh(new THREE.CircleGeometry(R, 40), film); face.rotation.x = Math.PI / 2; g.add(face);
    const band = new THREE.Mesh(new THREE.TorusGeometry(R * 0.97, 0.35, 6, 40), std(0x7aa6d8, 0.5)); band.rotation.x = Math.PI / 2; g.add(band);
    g.position.y = DET - 1.2;
    function set(k) {
      g.visible = k > 0.001;
      const L = Math.max(0.5, k * H);
      tubeM.scale.y = L; band.position.y = L;
      // folded: wider and flat, drawn in to the drum as it goes up
      const s = 1 + 0.25 * (1 - k);
      tubeM.scale.x = tubeM.scale.z = s; face.scale.setScalar(s); band.scale.setScalar(k < 0.9 ? s : 1);
    }
    return { g, set };
  })();

  // the monitor cart's screens' world centres (for the camera)
  const screenAt = (i = 0) => { const v = new THREE.Vector3(); suite.screens[i]?.getWorldPosition(v); return [v.x, v.y, v.z]; };

  return { suite, room, pat, skinG, boneG, skinMat, adult, top, draped, toRoom, fromRoom, xray, pads, backT, side, prep, drape, cover, screenAt, ISO };
}
