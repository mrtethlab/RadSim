/* THE MAMMOGRAPHY UNIT, for the film: the app's own rig (mammo.js buildRig: the column, the gantry
   with the tube head SID above the receptor, the snout, the breast support, the clear paddle and
   its chest-wall lip, the mag stand), in its frame and to its dimensions, with what a film needs
   that the console never shows: the C-arm that carries head and support, the face shield, the
   tube's nose over the chest wall, the tube insert inside it (the X-ray film's insert, scaled and
   tilted as a mammography tube is), and under the support's cover the grid and the selenium
   detector. The breast is the app's phantom mesh (breast.glb) with its fibroglandular tissue
   (breast_gland.glb, the same frame), compressed as the app compresses it.

   Frame (cm), as mammo.js: the origin at the breast's centre, y up, the patient standing at +z;
   everything meets at the front line z = 16 (the chest-wall edge). The gantry turns about z. */
import * as THREE from 'three';
import { std, mesh, canvasPlane, beamCone } from '../../kit/stage.js';
import { buildTubeInsert } from '../xray/tube.js';

export const SID = 65, H0 = 7.2, FRONT = 16;
export const RECEPTOR_Y = -H0 / 2;                         // the support's top face
export const FOCAL = [0, RECEPTOR_Y + SID, FRONT - 0.5];  // over the chest-wall edge (castMammo's src)
export const TUBE_SCALE = 0.5, TUBE_TILT = 6 * Math.PI / 180;
export const FIELD = { x: 12, z0: FRONT, z1: FRONT - 24 };   // the detector's field at the receptor

export function buildUnit(api) {
  const unit = new THREE.Group();
  const grey = (c, r = 0.8) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
  const M = {
    col: grey(0x8f99a2), head: grey(0xb7bfc7), snout: grey(0x6d7780), plate: grey(0x9aa4ad, 0.6),
    arm: std(0xa9b2ba, 0.55, 0.15), dark: std(0x2a2f36, 0.6, 0.2), trim: std(0x46d1c8, 0.4, 0.1),
    paddle: new THREE.MeshStandardMaterial({ color: 0xbfe4ee, transparent: true, opacity: 0.32, roughness: 0.15, side: THREE.DoubleSide, depthWrite: false }),
    shield: new THREE.MeshPhysicalMaterial({ color: 0xd6eef5, transparent: true, opacity: 0.22, roughness: 0.05, side: THREE.DoubleSide, depthWrite: false }),
  };
  // ---- the app's rig (mammo.js buildRig), as built there
  // (set back behind the C-arm: in the console's rig it stands through the support)
  const col = mesh(new THREE.BoxGeometry(16, 190, 24), M.col, 0, 95 - 110, -34);
  unit.add(col);
  const gantry = new THREE.Group(); unit.add(gantry);
  const tubeArm = new THREE.Group(); gantry.add(tubeArm);          // what sweeps for tomosynthesis
  const tubeHead = mesh(new THREE.BoxGeometry(24, 14, 20), M.head, 0, SID - H0 / 2, 8);
  tubeArm.add(tubeHead);
  const snout = mesh(new THREE.CylinderGeometry(4.5, 6.5, 7, 18), M.snout, 0, SID - H0 / 2 - 10, 11);
  tubeArm.add(snout);
  const plate = mesh(new THREE.BoxGeometry(30, 4, 28), M.plate, 0, -H0 / 2 - 2, 2);
  gantry.add(plate);
  const paddle = new THREE.Group(); gantry.add(paddle);
  const paddleSheet = mesh(new THREE.BoxGeometry(26, 0.8, 24), M.paddle, 0, 0, 4);
  const lip = mesh(new THREE.BoxGeometry(26, 3.4, 0.8), M.paddle, 0, 1.6, 15.6);
  paddle.add(paddleSheet, lip);
  // the paddle's bracket up to the carriage on the C-arm
  paddle.add(mesh(new THREE.BoxGeometry(10, 1.2, 10), M.dark, 0, 0.6, -11));
  paddle.add(mesh(new THREE.BoxGeometry(10, 8, 1.6), M.dark, 0, 4, -15.5));
  const magStand = mesh(new THREE.BoxGeometry(24, SID * (1 - 1 / 1.8), 20), M.col, 0, -H0 / 2 - 4 + SID * (1 - 1 / 1.8) / 2, 6);
  magStand.visible = false; gantry.add(magStand);
  // the unit's own soft light (as mammo.js buildRig carries it)
  const lamp = new THREE.PointLight(0xfff1e0, 2800, 400, 1.8); lamp.position.set(26, 46, 50); unit.add(lamp);
  const fillL = new THREE.DirectionalLight(0xcfdbe4, 0.55); fillL.position.set(-30, 20, 30); unit.add(fillL);

  // ---- what the film adds: the C-arm, the hub on the column, the head's nose, the face shield
  const arm = new THREE.Group(); gantry.add(arm);
  arm.add(mesh(new THREE.BoxGeometry(14, 72, 5), M.arm, 0, 28, -14.5));           // the C-arm's spine
  arm.add(mesh(new THREE.BoxGeometry(14, 4, 14), M.arm, 0, -6.5, -10));           // under the support
  const hub = mesh(new THREE.CylinderGeometry(9, 9, 6, 40).rotateX(Math.PI / 2), M.dark, 0, 0, -19.5);
  unit.add(hub);
  for (const x of [-1, 1]) {                                                         // handles either side of the support
    const h = mesh(new THREE.TorusGeometry(3, 0.55, 8, 20, Math.PI), M.dark, x * 18.5, -2, 4);
    h.rotation.y = Math.PI / 2; h.rotation.z = Math.PI; gantry.add(h);
  }
  const nose = mesh(new THREE.BoxGeometry(18, 12, 8), M.head, 0, SID - H0 / 2 + 1, 21.5);
  tubeArm.add(nose);
  const shield = new THREE.Group(); tubeArm.add(shield);
  shield.add(mesh(new THREE.BoxGeometry(24, 30, 0.5), M.shield, 0, SID - H0 / 2 - 20, 25.2));
  shield.add(mesh(new THREE.BoxGeometry(24, 0.6, 0.7), M.dark, 0, SID - H0 / 2 - 5, 25.2));
  shield.add(mesh(new THREE.BoxGeometry(24, 0.6, 0.7), M.dark, 0, SID - H0 / 2 - 35, 25.2));
  // a teal trim line on the head (the unit's look)
  const trim = new THREE.Group(); tubeArm.add(trim);
  const ty = SID - H0 / 2 - 6.4;
  trim.add(mesh(new THREE.BoxGeometry(24.2, 0.6, 0.3), M.trim, 0, ty, 18.05), mesh(new THREE.BoxGeometry(24.2, 0.6, 0.3), M.trim, 0, ty, -2.05),
    mesh(new THREE.BoxGeometry(0.3, 0.6, 20.2), M.trim, 12.05, ty, 8), mesh(new THREE.BoxGeometry(0.3, 0.6, 20.2), M.trim, -12.05, ty, 8));

  // ---- the tube inside the head: the X-ray film's insert at half size, cathode toward the
  // chest wall (+z), tilted so the beam's chest-wall edge stands vertical
  const tube = buildTubeInsert();
  const tubeTilt = new THREE.Group(); tubeTilt.position.set(...FOCAL); tubeTilt.rotation.x = TUBE_TILT;
  const tubeTurn = new THREE.Group(); tubeTurn.rotation.y = -Math.PI / 2; tubeTurn.scale.setScalar(TUBE_SCALE);
  tubeTurn.add(tube.g); tubeTilt.add(tubeTurn); tubeArm.add(tubeTilt);
  tube.g.visible = false;
  // a molybdenum anode: the X-ray tube's tungsten track made molybdenum
  tube.track.material = std(0x9ca3ab, 0.3, 0.85);
  // the port's window, beryllium (a light grey disc), and the filter slide under it: Mo and Rh foils
  tube.port.material = new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.35, metalness: 0.4, transparent: true, opacity: 0.85 });
  tube.filter.visible = false;
  const filterSlide = new THREE.Group(); filterSlide.position.y = tube.at.filterY; tube.g.add(filterSlide);
  const foilMo = mesh(new THREE.BoxGeometry(6, 0.25, 6), std(0xa7aeb6, 0.3, 0.85, { emissive: 0x1a1d22 }), 0, 0, 0);
  const foilRh = mesh(new THREE.BoxGeometry(6, 0.25, 6), std(0xd9dfe6, 0.2, 0.9, { emissive: 0x23262a }), 7, 0, 0);
  filterSlide.add(foilMo, foilRh, mesh(new THREE.BoxGeometry(14, 0.5, 1), M.dark, 3.5, 0, 3.4), mesh(new THREE.BoxGeometry(14, 0.5, 1), M.dark, 3.5, 0, -3.4));
  // two filaments: the large focal spot's and, beside it, the small one's
  const fil2 = tube.filament.clone(); const fil2Mat = tube.filMat.clone(); fil2.material = fil2Mat; fil2.scale.set(1, 1, 0.45); fil2.position.y = 0.32; tube.cup.add(fil2);
  tube.filament.position.y = -0.18; tube.filament.scale.set(1, 1, 0.8);

  // ---- under the support's cover: the grid, then the detector (front edge at the chest wall)
  const inside = new THREE.Group(); gantry.add(inside);
  const gridTex = canvasPlane(24, 26, 256, 256, 0.25);
  { const g = gridTex.userData.g; g.fillStyle = '#c98a4a'; g.fillRect(0, 0, 256, 256); g.fillStyle = '#20262c';
    for (let i = 0; i < 256; i += 6) for (let j = 0; j < 256; j += 6) g.fillRect(i + 1, j + 1, 5, 5);
    gridTex.userData.tex.needsUpdate = true; }
  gridTex.rotation.x = -Math.PI / 2; gridTex.position.set(0, -4.05, FRONT - 13.4);
  const grid = new THREE.Group(); grid.add(gridTex, mesh(new THREE.BoxGeometry(24, 0.25, 26), std(0xb87a40, 0.4, 0.6, { transparent: true, opacity: 0.35 }), 0, -4.2, FRONT - 13.4));
  inside.add(grid);
  const det = new THREE.Group(); inside.add(det);
  const layer = (h, mat, y) => { const m = mesh(new THREE.BoxGeometry(24, h, 26), mat, 0, y, FRONT - 13.4); det.add(m); return m; };
  const electrode = layer(0.05, std(0xd8c070, 0.3, 0.9), -4.65);
  const selenium = layer(0.35, std(0x3a2a2c, 0.35, 0.3, { emissive: 0x120606 }), -4.9);
  const tftFace = canvasPlane(24, 26, 512, 512, 0.45);
  { const g = tftFace.userData.g; g.fillStyle = '#1b3a5c'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 512; i += 6) { g.fillStyle = '#c9a24a'; g.fillRect(i, 0, 1, 512); g.fillRect(0, i, 512, 1);
      for (let j = 0; j < 512; j += 6) { g.fillStyle = '#3b77b0'; g.fillRect(i + 2, j + 2, 3, 3); g.fillStyle = '#2a2a2a'; g.fillRect(i + 1, j + 1, 1, 1); } }
    tftFace.userData.tex.needsUpdate = true; }
  tftFace.rotation.x = -Math.PI / 2; tftFace.position.set(0, -5.07, FRONT - 13.4); det.add(tftFace);
  const glass = layer(0.3, new THREE.MeshPhysicalMaterial({ color: 0xa8c8e0, roughness: 0.1, transparent: true, opacity: 0.5 }), -5.25);
  const pcb = layer(0.2, std(0x1f6b3a, 0.6, 0.1), -6.0);
  const chips = new THREE.Group(); det.add(chips);
  for (let i = 0; i < 6; i++) {
    chips.add(mesh(new THREE.BoxGeometry(2.6, 0.3, 1.2), std(0x111111, 0.4, 0.3), -9 + i * 3.6, -6.25, FRONT - 1.5 - 24));
    chips.add(mesh(new THREE.BoxGeometry(1.2, 0.3, 2.6), std(0x111111, 0.4, 0.3), -11.2, -6.25, FRONT - 4 - i * 3.6));
  }
  const layers = [grid, electrode, selenium, tftFace, glass, pcb, chips];
  const base = layers.map((m) => m.position.y);
  const explode = (k) => layers.forEach((m, i) => { m.position.y = base[i] + k * (layers.length - 1 - i) * 3.4 + k * 5; });
  inside.visible = false;

  // ---- the breast: the app's phantom mesh and its gland, one group, compressed as the app does
  const breast = new THREE.Group(); gantry.add(breast);
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd8a07a, roughness: 0.75, metalness: 0, transparent: true, opacity: 1, side: THREE.DoubleSide });
  const glandMat = new THREE.MeshStandardMaterial({ color: 0xf2d6d0, roughness: 0.6, emissive: 0x3a1a1a });
  const muscleMat = new THREE.MeshStandardMaterial({ color: 0xa8483e, roughness: 0.6 });
  const parts = { skin: null, gland: null, muscle: null, dense: null };
  const prep = (g, mat) => { g.traverse((o) => { if (o.isMesh) { if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); o.material = mat; } }); return g; };
  const loads = Promise.all([
    api.loadGlb('models/breast/breast.glb').catch(() => null),
    api.loadGlb('models/breast/breast_gland.glb').catch(() => null),
    api.loadGlb('models/breastdense/breastdense_gland.glb').catch(() => null),
  ]).then(([skin, gland, dense]) => {
    if (skin) { parts.skin = prep(skin, skinMat); breast.add(skin); }
    const split = (g, key) => {
      if (!g) return;
      g.traverse((o) => { if (o.isMesh) { if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); const n = (o.name || o.parent?.name || ''); o.material = /muscle/.test(n) ? muscleMat : glandMat; if (/muscle/.test(n)) o.userData.muscle = true; } });
      parts[key] = g; breast.add(g);
    };
    split(gland, 'gland'); split(dense, 'dense');
    if (parts.dense) parts.dense.visible = false;
  });
  // the muscle meshes inside both gland files: shown only on request
  const showMuscle = (on) => { for (const k of ['gland', 'dense']) parts[k]?.traverse((o) => { if (o.userData.muscle) o.visible = on; }); };
  const breastPose = { c: 1 };
  // c: the compression factor (thickness / 7.2 cm); volume-conserving as mammo.js applyCompression
  const setCompression = (c, lift = 0) => {
    const lat = 1 / Math.sqrt(c), s = 0.1, base_ = -H0 / 2 + lift;
    breast.rotation.set(-Math.PI / 2, 0, 0);
    breast.scale.set(s * lat, s * lat, s * c);
    breast.position.set(0, base_ + (H0 * c) / 2, 11.5);
    breastPose.c = c;
  };
  const setPaddle = (y) => { paddle.position.y = y; };
  const paddleAt = (c) => -H0 / 2 + H0 * c + 0.4;
  setCompression(1); setPaddle(22);

  // ---- the beam from the focal spot to the field, and the light field
  const beam = beamCone(0x9d7bff, 0.13); tubeArm.add(beam); beam.visible = false;
  const setBeam = (z1 = FIELD.z1, x = FIELD.x, y = RECEPTOR_Y) => beam.userData.set(FOCAL, [[-x, y, FIELD.z0], [x, y, FIELD.z0], [x, y, z1], [-x, y, z1]]);
  setBeam();

  return { unit, gantry, tubeArm, tubeHead, snout, nose, shield, trim, plate, paddle, paddleSheet, lip, magStand, arm, hub, col,
    tube, tubeTilt, filterSlide, foilMo, foilRh, fil2, fil2Mat, inside, grid, det, electrode, selenium, tftFace, glass, pcb, chips, explode,
    breast, parts, skinMat, glandMat, muscleMat, showMuscle, setCompression, setPaddle, paddleAt, breastPose, loads, beam, setBeam, M };
}

/* A world point of the gantry's frame (cm) -> the world, through the gantry's current turn. */
export function gantryToWorld(R, p) {
  R.gantry.updateMatrixWorld(true);
  return new THREE.Vector3(...p).applyMatrix4(R.gantry.matrixWorld);
}
export function armToWorld(R, p) {
  R.tubeArm.updateMatrixWorld(true);
  return new THREE.Vector3(...p).applyMatrix4(R.tubeArm.matrixWorld);
}
