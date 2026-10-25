/* THE MAMMOGRAPHY FILM: the whole of a mammogram, from the tube to the reading room. Five chapters
   (films/mammo/*.js): the unit and its tube; the beam (the molybdenum target, its characteristic
   lines, K-edge filters, the target/filter pairs, the low kV); the breast (compression,
   positioning, the low-energy interactions, microcalcifications, the cellular grid); the
   detector (the AEC, direct conversion in amorphous selenium, small pixels); the image (the
   mammograms themselves, cast by the mode's own projector, hanging, density, dose) and
   tomosynthesis. Its sets: the unit (films/mammo/rig.js, the app's own rig, its tube and detector
   inside), the reading workstation. One set shows at a time. */
import * as THREE from 'three';
import { lights, std, mesh } from '../kit/stage.js';
import { buildUnit } from './mammo/rig.js';
import { unitChapter } from './mammo/unit.js';
import { beamChapter } from './mammo/beam.js';
import { breastChapter } from './mammo/breast.js';
import { detectorChapter } from './mammo/detector.js';
import { imageChapter } from './mammo/image.js';

export async function build(api) {
  const { scene } = api;
  lights(scene, { amb: 1.5, key: 2.0 });
  const sets = {};

  // ---- the unit, standing on the floor of a dim room
  const room = new THREE.Group(); scene.add(room);
  const R = buildUnit(api);
  room.add(R.unit);
  const floor = mesh(new THREE.CircleGeometry(420, 64).rotateX(-Math.PI / 2), std(0x1b2027, 0.95, 0), 0, -110, 0);
  floor.receiveShadow = true; room.add(floor);
  const back = mesh(new THREE.PlaneGeometry(600, 300), std(0x161a20, 0.95, 0), 0, 40, -160);
  room.add(back);
  R.unit.traverse((o) => { if (o.isMesh && !o.material.transparent) { o.castShadow = true; o.receiveShadow = true; } });
  sets.unit = room;
  await R.loads;

  const S = {
    sets, R,
    only(key) { for (const [k, g] of Object.entries(sets)) g.visible = k === key; },
    // load an image from public/anim as a 0..1 grey array
    img: (name) => new Promise((res) => {
      const im = new Image();
      im.onload = () => {
        const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
        const g = cv.getContext('2d'); g.drawImage(im, 0, 0);
        const d = g.getImageData(0, 0, im.width, im.height).data, a = new Float32Array(im.width * im.height);
        for (let i = 0; i < a.length; i++) a[i] = d[i * 4] / 255;
        res({ w: im.width, h: im.height, a });
      };
      im.onerror = () => res({ w: 4, h: 4, a: new Float32Array(16) });
      im.src = import.meta.env.BASE_URL + 'anim/' + name;
    }),
    meta: await fetch(import.meta.env.BASE_URL + 'anim/mammo.json').then((r) => r.json()).catch(() => null),
  };
  const chapters = [];
  for (const ch of [unitChapter, beamChapter, breastChapter, detectorChapter, imageChapter]) {
    const c = await ch(api, S);
    if (c) chapters.push(c);
  }
  return { title: 'Mammography: the whole process', chapters };
}
