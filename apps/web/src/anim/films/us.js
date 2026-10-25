/* THE ULTRASOUND FILM: the whole of diagnostic ultrasound, from the voltage on a crystal to the
   moving image and the blood's Doppler shift. Five chapters (films/us/*.js): the transducer;
   sound in tissue; building the image; resolution and artefacts; motion (M-mode and Doppler).
   Its sets: the scan room (us/room.js: the app's table, the subject the mode scans, the scanner,
   the probe on its seat with its plane in the patient), the probe's insides (us/probe.js); the
   images are the mode's own physics (us/bmode.js) run on the same segmentation. */
import * as THREE from 'three';
import { lights, setOpacity } from '../kit/stage.js';
import { loadVolume, probeFrame, scan, envelope, greys, fanCanvas } from './us/bmode.js';
import { buildScanRoom } from './us/room.js';
import { buildProbe } from './us/probe.js';
import { makeMonitor } from './us/monitor.js';
import { transducer } from './us/ch1.js';
import { tissue } from './us/ch2.js';
import { imaging } from './us/ch3.js';
import { artefacts } from './us/ch4.js';
import { motion } from './us/ch5.js';

/* The seat: the right upper quadrant, an oblique subcostal plane rocked 20 degrees: liver,
   the gallbladder and the ribs' shadows in one fan (surveyed on the volume: the seat that
   crosses the most liver and gallbladder with the fewest lines lost). The abdominal preset. */
export const SEAT = { probe: 'curvi', px: 0.78, pz: 0.42, rot: 120, tilt: 20, freq: 3.5, depth: 16, focus: 8, gain: 0, range: 55 };

export async function build(api) {
  const { scene, renderer } = api;
  lights(scene);
  renderer.localClippingEnabled = true;
  const V = await loadVolume();
  const seat = { o: SEAT, P: probeFrame(V, SEAT) };
  // the seat's frame, made once: raw echoes, the detected envelope, the displayed greys
  seat.fr = scan(V, SEAT, { keepIds: true });
  envelope(seat.fr);
  seat.g = greys(seat.fr, { gain: SEAT.gain, range: SEAT.range });
  seat.cv = fanCanvas(seat.fr, seat.g, 320, 320).cv;
  // the line through the gallbladder's middle (the A-mode's), and the lines whose far field the
  // gas and bone above them darken (the shadows), from the frame itself
  {
    const { nl, ns, ids, env } = seat.fr;
    let best = 0;
    for (let l = 0; l < nl; l++) { let n = 0; for (let k = 0; k < ns; k++) if (ids[l * ns + k] === 6) n++; if (n > best) { best = n; seat.line = l; } }
    const deep = new Float64Array(nl);
    for (let l = 0; l < nl; l++) { let s = 0; for (let k = ns >> 1; k < ns; k++) s += seat.g[l * ns + k]; deep[l] = s / (ns / 2); }
    seat.deep = deep;
    void env;
  }
  // the same seat at half the depth, and at 7.5 MHz (frame rate; frequency)
  seat.fr8 = scan(V, { ...SEAT, depth: 8, focus: 4 }); envelope(seat.fr8); seat.g8 = greys(seat.fr8, SEAT);
  seat.fr75 = scan(V, { ...SEAT, freq: 7.5 }); envelope(seat.fr75); seat.g75 = greys(seat.fr75, SEAT);

  const room = await buildScanRoom(api, V, seat);
  // the big probe for the close-ups, in a set of its own
  const big = buildProbe();
  scene.add(big.g);
  const sets = { room: room.group, probe: big.g };
  // where things are in the room (world cm), for the cameras
  room.group.updateMatrixWorld(true);
  const wp = (o, x = 0, y = 0, z = 0) => o.localToWorld(new THREE.Vector3(x, y, z)).toArray().map((v) => +v.toFixed(2));
  const W = {
    face: wp(room.rock, 0, -6, 0),                 // the face's middle on the skin
    apex: wp(room.rock),
    deep: wp(room.rock, 0, -6 - SEAT.depth / 2, 0),   // the middle of the image in the patient
    screen: wp(room.screen), screenFront: wp(room.screen, 0, 0, 62), screenNear: wp(room.screen, 0, 0, 56),
    // the monitor up and to the left of the frame, room beside it for the caption
    monPos: wp(room.screen, 19, -1, 82), monLook: wp(room.screen, 19, -1, 0),
    cart: wp(room.cart, 0, 100, 0),
  };
  const S = {
    V, seat, room, big, sets, W,
    only(key) { for (const [k, g] of Object.entries(sets)) g.visible = k === key; },
    mon: null,
    // the room as it stands: everything opaque, nothing extra shown, the seat's image on the monitor
    roomReset() {
      S.mon?.reset();
      S.only('room');
      for (const m of [room.meshes.skin, room.meshes.bone, room.probe.housing]) if (m) setOpacity(m, 1);
      room.section.visible = false; room.fan.visible = false; room.sheet.visible = false;
      room.fan.material.opacity = 0.95; room.probe.fire(() => 0);
      room.paintScreen(seat.cv);
    },
  };
  S.mon = makeMonitor(S);
  const chapters = [];
  for (const ch of [transducer, tissue, imaging, artefacts, motion]) {
    const c = await ch(api, S);
    if (c) chapters.push(c);
  }
  // (development only: window.__usT pins every step's time, to inspect a frame at leisure)
  if (import.meta.env.DEV) {
    const T = (t) => (typeof window.__usT === 'number' ? window.__usT : t);
    window.__usS = S;
    for (const c of chapters) for (const s of c.steps) {
      const f = s.frame, cam = s.cam;
      if (f) s.frame = (t, dt) => f(T(t), dt);
      if (Array.isArray(cam)) s.cam = (t) => camKeys(cam, T(t));
      else if (cam) s.cam = (t) => cam(T(t));
    }
  }
  return { title: 'Ultrasound: the whole process', chapters };
}
function camKeys(c, t) {
  const io = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const L = (a, b, k) => a + (b - a) * k;
  if (t <= c[0][0]) return { pos: c[0][1], look: c[0][2], fov: c[0][3] };
  for (let i = 0; i < c.length - 1; i++) {
    const a = c[i], b = c[i + 1];
    if (t <= b[0]) {
      const k = io((t - a[0]) / Math.max(1e-6, b[0] - a[0]));
      return { pos: a[1].map((v, j) => L(v, b[1][j], k)), look: a[2].map((v, j) => L(v, b[2][j], k)),
        fov: a[3] != null && b[3] != null ? L(a[3], b[3], k) : (b[3] ?? a[3]) };
    }
  }
  const z = c[c.length - 1];
  return { pos: z[1], look: z[2], fov: z[3] };
}
