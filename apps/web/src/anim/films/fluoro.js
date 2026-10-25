/* THE FLUOROSCOPY FILM: the whole of fluoroscopy, from the C-arm to the staff's lead. Five chapters
   (films/fluoro/*.js): the C-arm; the image intensifier (and the flat panel); pulses, the automatic
   brightness control and the image on the screen; collimation and the contrast studies (barium,
   DSA, roadmap); radiation protection. Its sets: the suite (fluoro/suite.js: the app's own C-arm,
   monitor cart and stretcher, the chest/abdomen/pelvis patient), the intensifier's insides built in
   the C's receptor (fluoro/ii3d.js), the x-ray film's tube insert under the table, and a close-up of
   the collimator. The live image is a real projection of the patient model (fluoro/live.js). */
import * as THREE from 'three';
import { lights, setOpacity } from '../kit/stage.js';
import { buildTubeInsert } from './xray/tube.js';
import { buildSuite } from './fluoro/suite.js';
import { buildII } from './fluoro/ii3d.js';
import { loadLive, frameCache, FIELD_PX } from './fluoro/live.js';
import { carmChapter } from './fluoro/c1carm.js';
import { iiChapter } from './fluoro/c2ii.js';
import { controlChapter } from './fluoro/c3control.js';
import { contrastChapter } from './fluoro/c4contrast.js';
import { protectChapter } from './fluoro/c5protect.js';

export async function build(api) {
  const { scene } = api;
  lights(scene, { amb: 1.4, key: 2.0 });
  scene.fog = new THREE.Fog(0x0a0c0f, 420, 1100);         // the floor fades into the dark room
  const sets = {};

  const [suite, live] = await Promise.all([buildSuite(api), loadLive()]);
  sets.suite = suite.g;
  const ii = buildII(suite);

  // the x-ray film's tube insert, in the C-arm's housing under the table: turned so its beam goes
  // up the C, its focal spot on the C's (the beam's apex), small enough to sit in the OEC's housing
  const T = buildTubeInsert();
  T.g.scale.setScalar(0.7);
  T.g.rotation.z = Math.PI;
  T.g.position.set(0, -60, 0);
  suite.carm.c.add(T.g);
  T.housing.visible = false; T.coll.visible = false; T.port.visible = false;
  T.g.visible = false;

  // the screens on the monitor cart: what they show is drawn into their canvases
  const screenCache = frameCache(8);
  const S = {
    sets, suite, ii, live, T,
    only(key) { for (const [k, g] of Object.entries(sets)) g.visible = k === key; },
    /* The suite as it stands at rest; each step's enter() starts from here. */
    reset() {
      S.only('suite');
      suite.setPose({ orbital: 0, tilt: 0, over: 0, wig: 0, ext: 0, lift: 0 });
      suite.setBeam({ a: 0 });
      for (const k of ['ii', 'fpd', 'cap', 'tube', 'trim']) if (suite.parts[k]) setOpacity(suite.parts[k], 1);
      for (const m of suite.parts.ring || []) setOpacity(m, 1);
      suite.flat(false);                                  // (after: setOpacity shows what it touches)
      suite.skinAlpha(0.85);
      if (suite.boneG) setOpacity(suite.boneG, 1);
      suite.bed.position.set(0, 0, 0);
      suite.patient.visible = true;
      suite.staff.g.visible = false;
      suite.staff.apron.visible = suite.staff.collar.visible = suite.staff.glasses.visible = false;
      suite.ceiling.visible = false; suite.skirt.visible = false;
      suite.pedal.visible = true; suite.press(0);
      ii.g.visible = false; ii.setFov(11.5, 0);
      T.g.visible = false;
      S.gutPaint(() => 0);
      S.screens(null, null);
    },
    /* Paint the gut by a barium share per vertex: f(part, x, y, z) -> 0..1 in the patient's frame. */
    gutPaint(f) {
      for (const [part, o] of Object.entries(suite.gi)) {
        const pos = o.geometry.attributes.position, col = o.geometry.attributes.color;
        const s = 0.1;                                    // the mesh is in mm
        for (let i = 0; i < pos.count; i++) {
          const k = Math.max(0, Math.min(1, f(part, pos.getX(i) * s, pos.getY(i) * s, pos.getZ(i) * s)));
          // the bowel's own pink-brown, to barium's chalk white
          col.setXYZ(i, 0.62 + 0.36 * k, 0.42 + 0.56 * k, 0.36 + 0.62 * k);
        }
        col.needsUpdate = true;
        o.material.emissive.setRGB(0, 0, 0);
      }
    },
    /* The monitor cart's two screens: lum arrays (0..1, -1 outside) of n x n, or null for dark. */
    screens(live_, ref, n = FIELD_PX) {
      live.toScreen(suite.tower.live, live_, live_ ? n : 0);
      live.toScreen(suite.tower.ref, ref, ref ? n : 0);
    },
    // a display frame for the monitor: the field centred on image row cy (column cx), pulse k
    screenFrame(key, opts) {
      return screenCache(key, () => {
        const T_ = live.frame({ n: FIELD_PX, kv: 75, detected: 300, ...opts });
        return live.display(T_, FIELD_PX);
      });
    },
  };

  const chapters = [];
  for (const ch of [carmChapter, iiChapter, controlChapter, contrastChapter, protectChapter]) {
    const c = await ch(api, S);
    if (c) chapters.push(c);
  }
  return { title: 'Fluoroscopy: the whole process', chapters };
}
