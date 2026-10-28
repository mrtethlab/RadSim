/* DXA FILM: the 3D set. The app's own densitometer (dxaRoom.js: the GE Lunar-style table, its arm
   with the source carriage under the table and the detector head over it, the knee block, the
   foot holder, the phantom legs), the chest-abdomen-pelvis patient lying on it as the DXA room lays
   it (the volume's own frame: +x the patient's right, +y anterior, +z superior; the pillar on the
   patient's left), the centring laser, and what the app does not model in 3D: the source's
   insides (tube, cerium filter, slit), the detector array in the head, the fan beam, the console.
   Frame (cm): the pad's surface at y = 0, the table along z, +z the head end. */
import * as THREE from 'three';
import { buildLunar, buildBlock, buildHolder, buildLegs, LUNAR, BLOCK } from '../../../dxaRoom.js';
import { std, mesh, setOpacity, beamCone, canvasPlane } from '../../kit/stage.js';
import { capMeshFrame } from '../capFrame.js';

export const ZP = 14;                // the patient's centre along the table (toward the head end, as the exam lays them)
export const FOCUS_Y = -27;          // the focal spot, under the table (local to the arm)
export const DET_Y = 41.2;           // the detector array, in the head
export const FAN_DEG = 4.5;          // the fan's angle, along the patient (dxa.js SCAN)

export async function buildSet(api, J) {
  const { scene } = api;
  const set = new THREE.Group(); scene.add(set);

  // ---- the room: a floor, a back wall, the densitometer
  const floor = mesh(new THREE.PlaneGeometry(900, 900), std(0x2b2f35, 0.9, 0.0), 0, LUNAR.FLOOR, 0);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; set.add(floor);
  const wall = mesh(new THREE.PlaneGeometry(900, 300), std(0x3a4048, 0.95, 0.0), 0, LUNAR.FLOOR + 150, 260);
  wall.rotation.y = Math.PI; set.add(wall);
  const L = buildLunar();
  set.add(L.table, L.arm);
  const kids = L.arm.children;
  // (dxaRoom.js adds them in this order: carriage, its band, emblem, pillar x2, seam, head, its underside, panel, leds, sweep)
  const carriage = [kids[0], kids[1], kids[2]], head = [kids[6], kids[7], kids[8], kids[9]];
  const carriageG = new THREE.Group(), headG = new THREE.Group();
  for (const k of carriage) carriageG.add(k);
  for (const k of head) headG.add(k);
  L.arm.add(carriageG, headG);

  // ---- the source's insides: a small tube housing, the cerium K-edge filter, the slit; they ride
  // across the table with the fan (the group's x is the sweep's)
  const src = new THREE.Group(); L.arm.add(src);
  const housing = mesh(new THREE.CylinderGeometry(5.5, 5.5, 18, 32), std(0x59606b, 0.45, 0.5), 0, FOCUS_Y - 6.5, 0);
  housing.rotation.x = Math.PI / 2; src.add(housing);
  const port = mesh(new THREE.BoxGeometry(4, 2, 4), std(0x3a3f46, 0.5, 0.4), 0, FOCUS_Y - 0.6, 0); src.add(port);
  const spot = mesh(new THREE.SphereGeometry(0.5, 16, 12), new THREE.MeshBasicMaterial({ color: 0xfff1b0, transparent: true, opacity: 0 }), 0, FOCUS_Y, 0); src.add(spot);
  const filter = mesh(new THREE.BoxGeometry(3.6, 0.35, 5), std(0xd9cfa0, 0.25, 0.85, { emissive: 0x2a2610 }), 0, FOCUS_Y + 2.4, 0); src.add(filter);
  const slit = new THREE.Group(); slit.position.y = FOCUS_Y + 5.2; src.add(slit);
  for (const s of [-1, 1]) slit.add(mesh(new THREE.BoxGeometry(3, 1.6, 7), std(0x6a7380, 0.55, 0.45), s * 1.62, 0, 0));
  // ---- the detector: a row of elements along the fan, in the head, over the source
  const det = new THREE.Group(); L.arm.add(det); det.position.y = DET_Y;
  const detBody = mesh(new THREE.BoxGeometry(2.4, 1.2, 9), std(0x1f3540, 0.4, 0.3, { emissive: 0x0a1a20 }), 0, 0.4, 0); det.add(detBody);
  const elMat = std(0x6fd4c4, 0.3, 0.2, { emissive: 0x1f6a60 });
  for (let i = 0; i < 16; i++) det.add(mesh(new THREE.BoxGeometry(1.2, 0.3, 0.42), elMat, 0, -0.3, -3.6 + i * 0.48));

  // ---- the fan beam, apex at the focal spot, opened along z, a slit across x
  const fan = beamCone(0x9d7bff, 0.22); set.add(fan); fan.visible = false;
  const fanAt = (armZ, x, k = 1) => {
    const top = DET_Y - FOCUS_Y, hz = Math.tan(FAN_DEG / 2 * Math.PI / 180) * top, hx = 0.12;
    const a = [x, FOCUS_Y, armZ];
    const y = FOCUS_Y + top * k;
    fan.userData.set(a, [[x - hx * k, y, armZ - hz * k], [x + hx * k, y, armZ - hz * k], [x + hx * k, y, armZ + hz * k], [x - hx * k, y, armZ + hz * k]]);
    return { apex: a, top: FOCUS_Y + top, hz };
  };

  // ---- the patient: the skin, faint, over the skeleton
  // the body (the patient and the phantom legs) on a pivot at its centre, so it can lie a little
  // off the line and turned, and be slid straight
  const body = new THREE.Group(); body.position.z = ZP; set.add(body);
  const inner = new THREE.Group(); inner.position.z = -ZP; body.add(inner);
  const pat = new THREE.Group(); inner.add(pat);
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd8a080, roughness: 0.6, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide });
  const boneMat = std(0xe8e0c8, 0.5, 0.05, { emissive: 0x2a2418 });
  const [skinG, boneG] = await Promise.all([
    api.loadGlb('models/chestabdopelvis/chestabdopelvis_skin.glb').catch(() => null),
    api.loadGlb('models/chestabdopelvis/chestabdopelvis_bone.glb').catch(() => null),
  ]);
  let skin = null, bone = null, rest = 15.8;
  const prep = (g, mat) => {
    capMeshFrame(g);
    g.scale.setScalar(0.1);
    let m = null;
    g.traverse((o) => { if (o.isMesh) { if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); o.material = mat; o.castShadow = mat === boneMat; m = m || o; } });
    pat.add(g);
    return m;
  };
  if (skinG) skin = prep(skinG, skinMat);
  if (boneG) bone = prep(boneG, boneMat);
  if (skin) { skin.geometry.computeBoundingBox(); rest = -skin.geometry.boundingBox.min.y * 0.1; }
  pat.position.set(0, rest, ZP);
  pat.updateMatrixWorld(true);

  // the thighs' cut ends (the volume stops at the upper thighs): from the skin's inferior slab,
  // as dxa.js finds them in the volume
  let stumps = [{ p: [-9, rest - 2, ZP - 34], r: 7 }, { p: [9, rest - 2, ZP - 34], r: 7 }];
  if (skin) {
    const pos = skin.geometry.attributes.position, zmin = skin.geometry.boundingBox.min.z;
    const acc = [[0, 0, 0, 0, []], [0, 0, 0, 0, []]];
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      if (z < zmin + 15 || z > zmin + 35) continue;
      const x = pos.getX(i), y = pos.getY(i);
      if (Math.abs(x) < 20) continue;
      const a = acc[x < 0 ? 0 : 1]; a[0] += x; a[1] += y; a[2] += z; a[3]++; a[4].push([x, y]);
    }
    if (acc.every((a) => a[3] > 20)) {
      stumps = acc.map((a) => {
        const cx = a[0] / a[3], cy = a[1] / a[3], cz = a[2] / a[3];
        const r = a[4].reduce((s, [x, y]) => s + Math.hypot(x - cx, y - cy), 0) / a[3] / 10;
        return { p: [cx / 10, rest + cy / 10, ZP + cz / 10], r: Math.min(8, Math.max(5.5, r * 0.75)) };
      });
    }
  }
  const down = [0, 0, -1];
  const mid = [(stumps[0].p[0] + stumps[1].p[0]) / 2, 0, (stumps[0].p[2] + stumps[1].p[2]) / 2];
  const block = buildBlock(); block.position.set(mid[0], 0, mid[2] - (12 + BLOCK.D / 2)); block.rotation.y = Math.PI; set.add(block);
  const HOLDER_AT = 67;                // (dxa.js: from the stumps to the heels)
  const holder = buildHolder(); holder.position.set(mid[0], 0, mid[2] - HOLDER_AT); holder.rotation.y = Math.PI; set.add(holder);
  const legs = {
    flat: buildLegs(stumps, 'holder', down, {}),
    block: buildLegs(stumps, 'block', down, {}),
    holder: buildLegs(stumps, 'holder', down, { holderAt: [holder.position.x, 0, holder.position.z] }),
  };
  for (const l of Object.values(legs)) inner.add(l);

  // where the skin's top is at a point of the table (for the laser's cross to lie on it)
  const ray = new THREE.Raycaster(), topCache = new Map();
  const skinTop = (x, z) => {
    const k = `${x.toFixed(1)}|${z.toFixed(1)}`;
    if (topCache.has(k)) return topCache.get(k);
    let y = rest * 2 - 1;
    if (skin) {
      ray.set(new THREE.Vector3(x, 120, z), new THREE.Vector3(0, -1, 0));
      skin.material.side = THREE.DoubleSide;
      const hit = ray.intersectObject(skin, false)[0];
      if (hit) y = hit.point.y;
    }
    topCache.set(k, y);
    return y;
  };

  // ---- the centring laser: a red cross on the skin, and its sheet of light from the head
  const laser = new THREE.Group(); set.add(laser);
  const A = 2.54;
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute([-A, 0, 0, A, 0, 0, 0, 0, -A, 0, 0, A], 3));
  const cross = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xff2d2d, transparent: true, opacity: 0.95, depthTest: false }));
  cross.renderOrder = 999; laser.add(cross);
  const dot = mesh(new THREE.SphereGeometry(0.35, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff4040, depthTest: false }));
  dot.renderOrder = 999; laser.add(dot);
  const sheetGeo = new THREE.BufferGeometry();
  sheetGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Array(18).fill(0), 3));
  const sheet = new THREE.Mesh(sheetGeo, new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
  sheet.frustumCulled = false; set.add(sheet);
  const setLaser = (on, x = 0, z = 0) => {
    laser.visible = sheet.visible = on;
    if (!on) return;
    const y = skinTop(x, z) + 0.3;
    laser.position.set(x, y, z);
    const p = sheetGeo.attributes.position.array, h = LUNAR.HEAD_UNDER;
    p.set([x - A, y, z, x + A, y, z, x, h, z, x, y, z - A, x, y, z + A, x, h, z]);
    sheetGeo.attributes.position.needsUpdate = true;
  };

  // ---- the console: a desk and a monitor beside the table (the report goes on it)
  const desk = new THREE.Group(); set.add(desk);
  desk.position.set(-150, LUNAR.FLOOR, 150); desk.rotation.y = Math.PI / 2 + 0.5;
  desk.add(mesh(new THREE.BoxGeometry(110, 4, 60), std(0xd9dde1, 0.6, 0.05), 0, 73, 10));
  for (const x of [-50, 50]) desk.add(mesh(new THREE.BoxGeometry(4, 72, 52), std(0xb9bec4, 0.6, 0.1), x, 36, 10));
  desk.add(mesh(new THREE.BoxGeometry(60, 40, 3), std(0x15191d, 0.4, 0.2), 0, 104, 0));
  desk.add(mesh(new THREE.CylinderGeometry(2, 2, 12, 16), std(0x3b4148, 0.5, 0.3), 0, 80, -2));
  const screen = canvasPlane(56, 36, 560, 360, 1.0); screen.position.set(0, 104, 1.6); desk.add(screen);

  const S = {
    set, body, L, arm: L.arm, carriageG, headG, src, spot, filter, slit, housing, det, fan, fanAt, pat, skin, bone, skinMat, boneMat,
    rest, stumps, block, holder, legs, laser, setLaser, skinTop, desk, screen,
    // the arm along the table (room z), the fan across it (room x)
    setArm(z, x = 0) { L.arm.position.z = z; src.position.x = x; det.position.x = x; L.sweep.position.x = x; },
    legsTo(which) { for (const [k, l] of Object.entries(legs)) l.visible = k === which; },
    /* the patient's look: k fades the whole body in, skinA is the skin's own opacity */
    patLook(k = 1, skinA = 0.3) {
      pat.visible = k > 0.003;
      skinMat.opacity = skinA * k;
      boneMat.opacity = k; boneMat.transparent = k < 0.999; boneMat.depthWrite = k > 0.6;
    },
    reset() {
      set.visible = true;
      setOpacity(carriageG, 1); setOpacity(headG, 1); S.patLook(1, 0.3);
      fan.visible = false; spot.material.opacity = 0;
      L.sweep.material.opacity = 0;
      body.position.set(0, 0, ZP); body.rotation.set(0, 0, 0);
      for (const l of Object.values(legs)) setOpacity(l, 1);
      setOpacity(block, 1); setOpacity(holder, 1);
      block.visible = holder.visible = false; S.legsTo('flat'); setLaser(false);
      S.setArm(40, 0);
      desk.visible = true;
    },
  };
  // the patient lying on the table moves the studies' frame with it: the bake's x0/z0 are the
  // volume's own (its centre at the origin), the room's are offset by where the patient lies
  S.room = (x, z) => [x, z + ZP];
  return S;
}
