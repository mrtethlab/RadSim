/* THE FLUOROSCOPY SUITE: the app's own C-arm and monitor cart (carm.js), posed joint by joint the
   way fluoro.js poses them; the cantilevered stretcher fluoro.js builds; the chest/abdomen/pelvis
   patient (skin, bones, gut); and what only the film needs: a foot pedal, a member of staff with
   lead to put on, a ceiling-suspended shield and a table skirt.

   Frame (as fluoro.js): cm, the tabletop at y = 0, the floor at y = -90, the patient's long axis z
   (head +z), lying supine (anterior +y), the patient's right at +x. The C-arm's column stands at
   x = -125 (CARM.LARM) across from the beam; the C opens toward +x; at rest the beam points
   straight up through the isocentre, the patient's mid-plane over the table's centre. */
import * as THREE from 'three';
import { buildCarm, buildTower, setReceptor, CARM } from '../../../carm.js';
import { std, mesh, setOpacity } from '../../kit/stage.js';
import { fanBeam, fieldOutline } from './util.js';
import { capMeshFrame } from '../capFrame.js';

export const OEC = { SID: 99, SRC_ISO: 60, FIELD: 23 };      // fluoro.js's OEC geometry
export const FLOOR_Y = -90;
export const PAT_HALF = 16.5;                                 // the model's AP half-thickness: its centre above the tabletop
export const ISO = [0, PAT_HALF, 0];

/* opts.patient: false leaves the patient out (the surgical films lay their own, surg/kit.js). */
export async function buildSuite(api, { patient: withPatient = true } = {}) {
  const g = new THREE.Group();
  api.scene.add(g);

  // ---- the floor: dark vinyl in large tiles
  const fcv = document.createElement('canvas'); fcv.width = fcv.height = 256;
  { const c = fcv.getContext('2d'); c.fillStyle = '#20252b'; c.fillRect(0, 0, 256, 256); c.fillStyle = '#262c33';
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if ((i + j) % 2) c.fillRect(i * 64, j * 64, 64, 64);
    c.strokeStyle = '#171b20'; c.lineWidth = 2; for (let i = 0; i <= 4; i++) { c.strokeRect(i * 64, 0, 0.1, 256); c.strokeRect(0, i * 64, 256, 0.1); } }
  const ftex = new THREE.CanvasTexture(fcv); ftex.wrapS = ftex.wrapT = THREE.RepeatWrapping; ftex.repeat.set(24, 24); ftex.colorSpace = THREE.SRGBColorSpace;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshStandardMaterial({ map: ftex, roughness: 0.85, metalness: 0.05 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = FLOOR_Y; floor.receiveShadow = true;
  g.add(floor);

  // ---- the stretcher (fluoro.js buildStretcher): a carbon-fibre top cantilevered from a pedestal
  // at the foot; the top (and the patient on it) is the part that floats
  const bed = new THREE.Group(); g.add(bed);
  const stand = new THREE.Group(); g.add(stand);
  {
    const top = new THREE.MeshStandardMaterial({ color: 0x23272c, roughness: 0.55, metalness: 0.2 });
    const white = new THREE.MeshStandardMaterial({ color: 0xe9ecee, roughness: 0.45, emissive: 0x3a3e43 });
    const grey = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.5, metalness: 0.2 });
    const box = (grp, w, h, d, m, x, y, z) => { const o = mesh(new THREE.BoxGeometry(w, h, d), m, x, y, z); o.castShadow = o.receiveShadow = true; grp.add(o); return o; };
    box(bed, 55, 2.4, 210, top, 0, -1.6, 0);
    for (const s of [-1, 1]) box(bed, 2.2, 3.4, 210, white, s * 28.6, -1.9, 0);
    box(bed, 55, 3.4, 4, white, 0, -1.9, 104);
    box(stand, 48, 6, 60, white, 0, -6.4, -78);
    box(stand, 26, 70, 22, white, 0, FLOOR_Y + 41, -80);
    box(stand, 40, 3, 50, grey, 0, FLOOR_Y + 6, -80);
    box(stand, 60, 3, 64, white, 0, FLOOR_Y + 1.5, -80);
  }
  // the table skirt: a lead drape hanging from the rail on the staff's side (the patient's right)
  const skirt = new THREE.Group(); bed.add(skirt);
  {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
    const c = cv.getContext('2d'); c.fillStyle = '#3c4a5c'; c.fillRect(0, 0, 64, 64);
    c.fillStyle = '#334052'; for (let i = 0; i < 64; i += 8) c.fillRect(i, 0, 4, 64);         // its folds
    const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; t.repeat.set(6, 1); t.colorSpace = THREE.SRGBColorSpace;
    const dr = mesh(new THREE.PlaneGeometry(90, 62), new THREE.MeshStandardMaterial({ map: t, roughness: 0.8, side: THREE.DoubleSide }), 30.2, -34, -6);
    dr.rotation.y = Math.PI / 2; skirt.add(dr);
    skirt.add(mesh(new THREE.BoxGeometry(1.2, 2, 92), std(0x9aa1a8, 0.4, 0.4), 30.2, -3, -6));
  }
  skirt.visible = false;

  // ---- the patient: skin (seen through), bones, the gut, on the tabletop
  const patient = new THREE.Group(); patient.position.set(0, PAT_HALF, 0); bed.add(patient);
  const gi = {};
  const [skin, bone, gut] = !withPatient ? [null, null, null] : await Promise.all([
    api.loadGlb('models/chestabdopelvis/chestabdopelvis_skin.glb').catch(() => null),
    api.loadGlb('models/chestabdopelvis/chestabdopelvis_bone.glb').catch(() => null),
    api.loadGlb('models/chestabdopelvis/chestabdopelvis_gi.glb').catch(() => null),
  ]);
  const add = (m, f) => {
    if (!m) return null;
    capMeshFrame(m);
    m.scale.setScalar(0.1);
    m.traverse((o) => { if (o.isMesh) { if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); f(o); } });
    patient.add(m); return m;
  };
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd8a080, transparent: false, opacity: 1, roughness: 0.6, side: THREE.DoubleSide, depthWrite: true });
  const skinG = add(skin, (o) => { o.material = skinMat; o.castShadow = true; });
  const boneG = add(bone, (o) => { o.material = std(0xe8e0c8, 0.5, 0.05); });
  const gutG = add(gut, (o) => {
    const part = o.name || o.parent?.name;
    // per-vertex colour, so barium can be painted in as it flows (the film sets it each frame)
    const n = o.geometry.attributes.position.count;
    o.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.6), 3));
    o.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0, emissive: 0x000000 });
    gi[part] = o;
  });
  // the patient's skin opacity, the film's one dial on the patient
  // (under an opaque skin the bones and gut are hidden: a rib a millimetre under the skin fought it
  // for the same pixels and flickered through as white flecks)
  const skinAlpha = (a) => {
    if (skinG) setOpacity(skinG, a);
    const inside = !skinG || a < 0.99;
    if (boneG) boneG.visible = inside;
    if (gutG) gutG.visible = inside;
  };
  skinAlpha(1);

  // ---- the C-arm and its cart
  const carm = buildCarm(OEC.SID, OEC.SRC_ISO);
  for (const p of Object.values(carm)) g.add(p);
  const DET = OEC.SID - OEC.SRC_ISO;
  const named = { ii: carm.c.getObjectByName('ii'), fpd: carm.c.getObjectByName('fpd') };
  // the C's other pieces, found by what they are (carm.js builds them unnamed)
  for (const ch of carm.c.children) {
    if (ch.isGroup && !ch.name) named.tube = ch;                                    // the tube and collimator housing
    if (ch.isMesh && Math.abs(ch.position.y - (DET + 32)) < 0.5) named.cap = ch;   // the cap over the receptor
    if (ch.isMesh && Math.abs(ch.position.y - (DET + 21.4)) < 0.3) named.trim = ch; // its lavender trim
    if (ch.isMesh && ch.geometry?.type === 'LatheGeometry') (named.ring ??= []).push(ch);  // the C's arc and its rails
  }
  named.head = carm.column.children.find((o) => o.isMesh && Math.abs(o.position.x + 2) < 0.1 && Math.abs(o.position.y - 22) < 0.1);   // the control head
  const pose = { orbital: 0, tilt: 0, over: 0, wig: 0, ext: 0, lift: 0, slide: 0 };
  /* fluoroSyncScene's chain: wig-wag yaws the cross-arm about the column; the holder turns on the
     arm's end by flip-flop (over, 0..1 of half a turn) and tilt; the C slides through the holder
     by the orbital angle. lift raises the whole C; the isocentre moves with it. slide rolls the
     whole cart along the table (cm toward the head). */
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
  function setPose(p = {}) {
    Object.assign(pose, p);
    const w = pose.wig * Math.PI / 180, r = CARM.LARM + pose.ext;
    const iso = [ISO[0] - CARM.LARM + Math.cos(w) * r, ISO[1] + pose.lift, ISO[2] + pose.slide - Math.sin(w) * r];
    const qw = new THREE.Quaternion().setFromAxisAngle(Y, w);
    const qh = qw.clone().multiply(new THREE.Quaternion().setFromAxisAngle(X, pose.over * Math.PI))
      .multiply(new THREE.Quaternion().setFromAxisAngle(X, pose.tilt * Math.PI / 180));
    const qc = qh.clone().multiply(new THREE.Quaternion().setFromAxisAngle(Z, -pose.orbital * Math.PI / 180));
    carm.c.position.set(...iso); carm.c.quaternion.copy(qc);
    carm.holder.position.set(...iso); carm.holder.quaternion.copy(qh);
    const colX = ISO[0] - CARM.LARM, colZ = ISO[2] + pose.slide;
    carm.boom.position.set(colX + Math.cos(w) * pose.ext, ISO[1] + pose.lift, colZ - Math.sin(w) * pose.ext);
    carm.boom.quaternion.copy(qw);
    carm.column.position.set(colX, ISO[1] + pose.lift, colZ);
    carm.base.position.set(colX, FLOOR_Y, colZ);
    for (const p of Object.values(carm)) p.updateMatrixWorld(true);
    return iso;
  }
  setPose();
  // a point in the C's own frame (the beam up its +y: the focal spot at -SRC_ISO) -> the room
  const inC = (x, y, z) => carm.c.localToWorld(new THREE.Vector3(x, y, z)).toArray();
  // the beam: a fan from the focal spot to the field's outline at the receptor's face, in the C's frame
  const beam = fanBeam(0x9d7bff, 0.12); carm.c.add(beam); beam.visible = false;
  function setBeam({ R = OEC.FIELD / 2, s = 1e9, rot = 0, square = false, a = 1 } = {}) {
    beam.visible = a > 0.01;
    beam.material.opacity = 0.12 * a;
    beam.userData.set([0, -OEC.SRC_ISO, 0], fieldOutline(R, s, rot, square).map(([u, v]) => [u, DET, v]));
  }
  setBeam();
  const flat = (on) => setReceptor(carm, on);

  // ---- the monitor cart (fluoro.js places it past the foot of the table, turned up toward it)
  const tower = buildTower();
  tower.group.position.set(55, FLOOR_Y, -165);
  tower.group.rotation.y = -Math.PI / 2 + 0.4;
  g.add(tower.group);
  // its screens' meshes (for marking): the two planes carm.js gives the canvases to
  const screens = [];
  tower.group.traverse((o) => { if (o.isMesh && o.material?.map && (o.material.map === tower.live.texture || o.material.map === tower.ref.texture)) screens[o.material.map === tower.live.texture ? 0 : 1] = o; });

  // ---- the foot pedal: a low housing on the floor, its cable back to the C-arm's cart
  const pedal = new THREE.Group(); pedal.position.set(46, FLOOR_Y, -42); pedal.rotation.y = -0.35; g.add(pedal);
  const pedM = { body: std(0x3a4047, 0.6, 0.2), lav: std(0x8f8db3, 0.5, 0.1, { emissive: 0x2e2c4a }), plate: std(0xc8cdd2, 0.4, 0.5) };
  pedal.add(mesh(new THREE.BoxGeometry(34, 4, 24), pedM.body, 0, 2, 0));
  pedal.add(mesh(new THREE.BoxGeometry(36, 1.2, 26), pedM.lav, 0, 0.6, 0));
  pedal.add(mesh(new THREE.BoxGeometry(4, 9, 24), pedM.body, -15, 4.5, 0));          // the guard at the back
  const pedals = [];
  for (const z of [-6, 6]) {
    const hinge = new THREE.Group(); hinge.position.set(-11, 5, z); pedal.add(hinge);
    const plate = mesh(new THREE.BoxGeometry(22, 1.4, 9.5), pedM.plate, 11, 0.7, 0);
    plate.rotation.z = -0.12; hinge.add(plate); hinge.rotation.z = 0;
    pedals.push(hinge);
  }
  {
    const pts = [[-17, 2, 0], [-30, 1, -10], [-80, 1, 20], [-150, 1, 30], [-180, 4, 20]].map((p) => new THREE.Vector3(...p));
    pedal.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.7, 6), std(0x2a2f36, 0.7, 0.1)));
  }
  pedal.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  const press = (k, which = 0) => { pedals[which].rotation.z = -0.11 * k; };

  // ---- a member of staff in scrubs, with the lead that goes on
  const staff = buildStaff();
  g.add(staff.g);
  staff.g.position.set(80, FLOOR_Y, -34); staff.g.rotation.y = -Math.PI / 2 - 0.3;

  // ---- the ceiling-suspended shield: an arm from the ceiling, a lead-acrylic pane
  const ceiling = new THREE.Group(); g.add(ceiling);
  {
    const arm = std(0xd8dcdf, 0.45, 0.2, { emissive: 0x2a2d31 });
    ceiling.add(mesh(new THREE.CylinderGeometry(2.2, 2.2, 120, 16), arm, 0, 150, 0));
    ceiling.add(mesh(new THREE.BoxGeometry(8, 6, 8), arm, 0, 92, 0));
    const pane = mesh(new THREE.BoxGeometry(1.2, 62, 76), new THREE.MeshPhysicalMaterial({ color: 0xc9a86a, transparent: true, opacity: 0.32,
      roughness: 0.08, metalness: 0, depthWrite: false, side: THREE.DoubleSide }), 0, 58, 0);
    ceiling.add(pane);
    ceiling.add(mesh(new THREE.BoxGeometry(2.4, 63, 2.4), arm, 0, 58, 38.5));
    ceiling.add(mesh(new THREE.BoxGeometry(2.4, 63, 2.4), arm, 0, 58, -38.5));
    ceiling.add(mesh(new THREE.BoxGeometry(2.4, 2.4, 79), arm, 0, 89, 0));
    // the cut-out that fits round the patient: a lead-rubber flap along its lower edge
    ceiling.add(mesh(new THREE.BoxGeometry(1.4, 10, 76), std(0x3c4a5c, 0.8, 0.0), 0, 22, 0));
    ceiling.userData.pane = pane;
  }
  ceiling.position.set(40, 0, -22); ceiling.visible = false;

  return {
    g, bed, stand, floor, patient, skinG, boneG, gutG, gi, skinAlpha, skinMat,
    carm, parts: named, DET, setPose, pose, inC, beam, setBeam, flat,
    tower, screens, pedal, pedals, press, staff, ceiling, skirt,
  };
}

/* A plain figure in teal scrubs, 1.75 m, with its lead as separate pieces: apron (wrap-round),
   thyroid collar, glasses. Origin: the floor between the feet; it faces +z. */
function buildStaff() {
  const g = new THREE.Group();
  const M = {
    scrub: std(0x2e8c8a, 0.8, 0.0, { emissive: 0x0c2422 }), skin: std(0xd9a07e, 0.6, 0.0, { emissive: 0x2a170c }),
    cap: std(0x3a6fb0, 0.8, 0.0), shoe: std(0x2a2f36, 0.7, 0.1),
    lead: std(0x2f4a78, 0.55, 0.05, { emissive: 0x0b1428 }), trim: std(0x9db4d6, 0.5, 0.05),
    glass: new THREE.MeshStandardMaterial({ color: 0x9fd0e8, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.55 }),
  };
  const body = new THREE.Group(); g.add(body);
  for (const s of [-1, 1]) {
    body.add(mesh(new THREE.CylinderGeometry(6.2, 5.2, 82, 14), M.scrub, s * 8, 45, 0));       // legs
    body.add(mesh(new THREE.BoxGeometry(10, 5, 24), M.shoe, s * 8, 2.5, 4));
    const arm = mesh(new THREE.CylinderGeometry(4.2, 3.6, 56, 12), M.scrub, s * 22, 117, 6);
    arm.rotation.x = -0.35; arm.rotation.z = s * 0.12; body.add(arm);
    body.add(mesh(new THREE.SphereGeometry(4.2, 12, 10), M.skin, s * 23.5, 92, 16));              // hands
  }
  body.add(mesh(new THREE.CylinderGeometry(17, 14, 62, 20), M.scrub, 0, 116, 0));                // torso
  body.add(mesh(new THREE.SphereGeometry(17.2, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.scrub, 0, 146, 0));
  body.add(mesh(new THREE.CylinderGeometry(5.5, 6, 10, 14), M.skin, 0, 153, 0));                // neck
  body.add(mesh(new THREE.SphereGeometry(10.5, 22, 18), M.skin, 0, 167, 1));                    // head
  body.add(mesh(new THREE.SphereGeometry(11, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2.2), M.cap, 0, 169, 0));
  body.add(mesh(new THREE.SphereGeometry(2.2, 10, 8), M.skin, 0, 166, 11.2));                   // nose
  // the lead
  const apron = new THREE.Group(); g.add(apron);
  apron.add(mesh(new THREE.CylinderGeometry(18.6, 17.8, 76, 24, 1, true), M.lead, 0, 104, 0));
  apron.add(mesh(new THREE.CylinderGeometry(18.7, 18.7, 2.4, 24, 1, true), M.trim, 0, 141, 0));
  for (const s of [-1, 1]) apron.add(mesh(new THREE.BoxGeometry(8, 3, 30), M.lead, s * 11, 146, 0));   // the shoulders
  const collar = mesh(new THREE.TorusGeometry(7.2, 2.6, 10, 24), M.lead, 0, 152, 0); collar.rotation.x = Math.PI / 2; g.add(collar);
  const glasses = new THREE.Group(); g.add(glasses);
  for (const s of [-1, 1]) { const l = mesh(new THREE.BoxGeometry(6.5, 4, 1.2), M.glass, s * 4.4, 169, 10.6); glasses.add(l); }
  glasses.add(mesh(new THREE.BoxGeometry(17, 0.8, 0.8), std(0x2a2f36, 0.5, 0.3), 0, 171, 10.8));
  for (const s of [-1, 1]) glasses.add(mesh(new THREE.BoxGeometry(0.8, 0.8, 11), std(0x2a2f36, 0.5, 0.3), s * 8.6, 171, 5.5));
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { g, body, apron, collar, glasses, M };
}
