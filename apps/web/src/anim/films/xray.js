/* THE X-RAY FILM: the whole of projection radiography, from the filament to the displayed image.
   Four chapters (films/xray/*.js): making the x-rays, the beam in the patient, the detector, the
   image. Its sets: the x-ray room (room.js, the app's own), the tube's insides (xray/tube.js),
   the patient sets and the detector (built by their chapters). One set shows at a time. */
import * as THREE from 'three';
import { buildRoom, buildTubeHead, ROOM_GAP, TABLE_FLOOR } from '../../room.js';
import { Materials } from '../../core/materials.js';
import { lights } from '../kit/stage.js';
import { buildTubeInsert } from './xray/tube.js';
import { generation } from './xray/gen.js';
import { patient } from './xray/patient.js';
import { detector } from './xray/detector.js';
import { imaging } from './xray/image.js';

export async function build(api) {
  const { scene } = api;
  lights(scene);
  const sets = {};

  // ---- the room: the app's table, floor, column and tube head; the hand on the tabletop
  const room = new THREE.Group(); scene.add(room);
  const r = buildRoom(room, { aecCells: { l: { x: 7.5, z: 4.5 }, c: { x: 0, z: -4.5 }, r: { x: -7.5, z: 4.5 } } });
  r.table.visible = true; r.floor.visible = true; r.column.visible = true;
  r.floor.position.y = TABLE_FLOOR;                // (buildRoom leaves it at the origin: app.js sets it per room)
  const tube = new THREE.Group(); tube.position.set(0, 100, 0); room.add(tube);
  const head = buildTubeHead(tube);
  // aimed as the app aims it (app.js syncScene): down the central ray, the housing squared to the field
  tube.lookAt(0, 0, 0); tube.rotateX(Math.PI / 2); tube.rotateY(-Math.PI / 2);
  room.updateMatrixWorld(true);
  r.placeColumn(head.mount.getWorldPosition(new THREE.Vector3()), TABLE_FLOOR);
  const hand = new THREE.Group(); room.add(hand);
  api.loadGlb('models/hand/hand_skin.glb').then((g) => {
    g.scale.setScalar(0.1);
    const b = new THREE.Box3().setFromObject(g);
    g.position.set(-(b.min.x + b.max.x) / 2, ROOM_GAP.table - b.min.y, -(b.min.z + b.max.z) / 2);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); } });
    hand.add(g);
  }).catch(() => { /* the room still reads without the hand */ });
  sets.room = room;

  // ---- the tube's insides
  const T = buildTubeInsert();
  scene.add(T.g);
  sets.tube = T.g;

  const S = {
    sets,
    room: { group: room, tubeHead: tube, hand, r },
    tube: T,
    muAl: (E) => Materials.muAl(E),
    only(key) { for (const [k, g] of Object.entries(sets)) g.visible = k === key; },
  };
  const chapters = [generation(api, S)];
  for (const ch of [patient, detector, imaging]) {
    const c = await ch(api, S);
    if (c) chapters.push(c);
  }
  return { title: 'X-ray: the whole process', chapters };
}
