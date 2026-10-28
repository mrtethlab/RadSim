/* THE SCAN ROOM: the app's table and floor (room.js), the subject it scans (the chest/abdomen/
   pelvis meshes, the same segmentation the B-mode is made from), a cart-based scanner with its
   monitor, and the probe on the right upper quadrant with its scan plane in the patient: the
   section of anatomy the plane cuts (the volume's own labels) and the fan of the image itself,
   stood up in space where it was made, as the app draws it. */
import * as THREE from 'three';
import { buildRoom, TABLE_FLOOR } from '../../../room.js';
import { std, mesh, canvasPlane } from '../../kit/stage.js';
import { buildProbe, R0 } from './probe.js';
import { fanMap, paintFan } from './bmode.js';
import { capMeshFrame } from '../capFrame.js';

export const TABLE_TOP = 5;           // the tabletop's height (room.js ROOM_GAP.table)

export async function buildScanRoom(api, V, seat) {
  const { scene } = api;
  const room = new THREE.Group(); scene.add(room);
  const r = buildRoom(room, { aecCells: { l: { x: 7.5, z: 4.5 }, c: { x: 0, z: -4.5 }, r: { x: -7.5, z: 4.5 } } });
  r.table.visible = true; r.floor.visible = true; r.floor.position.y = TABLE_FLOOR;   // (as app.js puts it)

  // ---- the patient: anatomy space (cm, origin at the volume's corner) laid on the table
  const body = new THREE.Group(); room.add(body);
  const meshes = {};
  const [skin, bone] = await Promise.all([
    api.loadGlb('models/chestabdopelvis/chestabdopelvis_skin.glb').catch(() => null),
    api.loadGlb('models/chestabdopelvis/chestabdopelvis_bone.glb').catch(() => null),
  ]);
  const clip = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);       // the cut along the scan plane (set below)
  const prep = (g, mat) => {
    if (!g) return null;
    capMeshFrame(g);
    g.scale.setScalar(0.1); g.position.set(V.ex / 2, V.ey / 2, V.ez / 2);
    g.traverse((o) => { if (o.isMesh) { if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); o.material = mat; o.castShadow = true; o.receiveShadow = true; } });
    body.add(g);
    return g;
  };
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd9a585, roughness: 0.62, metalness: 0, side: THREE.DoubleSide });
  const boneMat = std(0xeae2cc, 0.5, 0.05);
  meshes.skin = prep(skin, skinMat);
  meshes.bone = prep(bone, boneMat);
  // the body's back on the tabletop
  let minY = 0;
  if (meshes.skin) { const b = new THREE.Box3().setFromObject(meshes.skin); minY = b.min.y; }
  body.position.set(-V.ex / 2, TABLE_TOP - minY, -V.ez / 2);

  // ---- the probe on its seat: the apex of its lines (the face's centre of curvature) is the
  // pivot; rocking (tilt) turns it about that, in the scan plane, as the app's lines turn
  const P = seat.P;
  const seatG = new THREE.Group(); body.add(seatG);
  seatG.position.set(P.px, P.py + R0, P.pz);
  seatG.rotation.y = -(seat.o.rot || 0) * Math.PI / 180;
  const rock = new THREE.Group(); seatG.add(rock);
  rock.rotation.z = P.tilt;
  const probe = buildProbe();
  probe.g.position.y = -R0;
  rock.add(probe.g);

  // ---- the section: the anatomy in the scan plane, from the volume's labels
  const SEC = { x0: -26, x1: 26, y0: -(P.py + R0) - 1, y1: V.ey - (P.py + R0) + 1, res: 0.2 };
  const sw = Math.round((SEC.x1 - SEC.x0) / SEC.res), sh = Math.round((SEC.y1 - SEC.y0) / SEC.res);
  const secCv = document.createElement('canvas'); secCv.width = sw; secCv.height = sh;
  {
    const g = secCv.getContext('2d'), im = g.createImageData(sw, sh);
    const rgb = {};
    for (const [id, hex] of Object.entries(V.colors)) { const c = new THREE.Color(hex); rgb[id] = [c.r * 255, c.g * 255, c.b * 255]; }
    for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) {
      const X = SEC.x0 + (i + 0.5) * SEC.res, Y = SEC.y1 - (j + 0.5) * SEC.res;      // Y up, from the apex
      const id = V.idAt(P.px + P.ux * X, P.py + R0 + Y, P.pz + P.uz * X);
      const o = (j * sw + i) * 4;
      if (!id) { im.data[o + 3] = 0; continue; }
      const c = rgb[id] || [200, 120, 110];
      im.data[o] = c[0]; im.data[o + 1] = c[1]; im.data[o + 2] = c[2]; im.data[o + 3] = 255;
    }
    g.putImageData(im, 0, 0);
  }
  const secTex = new THREE.CanvasTexture(secCv); secTex.colorSpace = THREE.SRGBColorSpace;
  const section = new THREE.Mesh(new THREE.PlaneGeometry(SEC.x1 - SEC.x0, SEC.y1 - SEC.y0),
    new THREE.MeshStandardMaterial({ map: secTex, transparent: true, alphaTest: 0.05, side: THREE.DoubleSide, roughness: 0.8, emissive: 0xffffff, emissiveMap: secTex, emissiveIntensity: 0.25 }));
  section.position.set((SEC.x0 + SEC.x1) / 2, (SEC.y0 + SEC.y1) / 2, 0);
  section.visible = false; section.renderOrder = 2; section.material.depthTest = false;
  seatG.add(section);

  // ---- the fan: the image itself, in the plane (lines up to n drawn, the rest clear)
  const FW = 512, FH = 512;
  const fanCv = document.createElement('canvas'); fanCv.width = FW; fanCv.height = FH;
  const fanTex = new THREE.CanvasTexture(fanCv); fanTex.colorSpace = THREE.SRGBColorSpace;
  const fanMat = new THREE.MeshBasicMaterial({ map: fanTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, depthTest: false, opacity: 0.95 });
  const fan = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), fanMat);
  fan.renderOrder = 4; fan.visible = false;
  rock.add(fan);
  // an outline of the fan (the app's cyan sheet), for when the image is not shown
  const sheetMat = new THREE.MeshBasicMaterial({ color: 0x4fd1e0, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, depthTest: false });
  const sheet = new THREE.Mesh(new THREE.BufferGeometry(), sheetMat);
  sheet.renderOrder = 3; sheet.visible = false; rock.add(sheet);
  {
    const N = 24, pos = [], sector = P.sector, d = seat.o.depth;
    for (let i = 0; i < N; i++) {
      const t0 = sector * (i / N - 0.5), t1 = sector * ((i + 1) / N - 0.5);
      const q = (th, rr) => [Math.sin(th) * rr, -Math.cos(th) * rr, 0];
      pos.push(...q(t0, R0), ...q(t1, R0), ...q(t1, R0 + d), ...q(t0, R0), ...q(t1, R0 + d), ...q(t0, R0 + d));
    }
    sheet.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  }
  let fanFm = null, fanId = null, fanG = null;
  /* Show frame fr's greys g on the fan, lines up to upTo. */
  const setFan = (fr, g, opts = {}) => {
    if (fanFm?.fr !== fr) {
      fanFm = fanMap(fr, FW, FH, 1.0); fanFm.fr = fr;
      fanId = fanCv.getContext('2d').createImageData(FW, FH);
      const s = fanFm.scale;
      fan.geometry.dispose();
      fan.geometry = new THREE.PlaneGeometry(FW / s, FH / s);
      // the image's (cx, cy) is the apex: the plane's centre sits (W/2 - cx, cy - H/2) from it
      fan.position.set((FW / 2 - fanFm.cx) / s, (fanFm.cy - FH / 2) / s, 0);
    }
    if (fanG !== g || opts.upTo !== undefined || opts.tint || opts.depthFrac !== undefined) {
      paintFan(fanFm, g, fanId.data, { bg: [0, 0, 0, 0], ...opts });
      fanCv.getContext('2d').putImageData(fanId, 0, 0);
      fanTex.needsUpdate = true; fanG = opts.upTo !== undefined || opts.tint ? null : g;
    }
  };

  // ---- the scanner: a cart at the patient's right, its monitor turned to the table
  const cart = new THREE.Group(); room.add(cart);
  cart.position.set(105, TABLE_FLOOR, 55); cart.rotation.y = -Math.PI / 2 + 0.45;
  const C = { body: std(0xe8ebee, 0.45, 0.05), dark: std(0x2a2f36, 0.5, 0.2), mid: std(0x7d8791, 0.5, 0.3), key: std(0x3a4048, 0.6, 0.1) };
  cart.add(mesh(new THREE.BoxGeometry(56, 6, 66), C.body, 0, 9, 0));
  for (const [x, z] of [[-24, -28], [24, -28], [-24, 28], [24, 28]]) {
    cart.add(mesh(new THREE.CylinderGeometry(3.2, 3.2, 3, 18).rotateZ(Math.PI / 2), C.dark, x, 3.2, z));
  }
  cart.add(mesh(new THREE.BoxGeometry(42, 66, 40), C.body, 0, 45, -6));
  cart.add(mesh(new THREE.BoxGeometry(44, 2, 42), C.mid, 0, 79, -6));
  // the console: a tilted deck, its keys, the trackball, TGC sliders, knobs
  const deck = new THREE.Group(); deck.position.set(0, 88, 6); deck.rotation.x = 0.22; cart.add(deck);
  deck.add(mesh(new THREE.BoxGeometry(60, 4, 40), C.body, 0, 0, 0));
  const panel = canvasPlane(56, 36, 448, 288, 0.35); panel.rotation.x = -Math.PI / 2; panel.position.y = 2.05; deck.add(panel);
  {
    const g = panel.userData.g; g.fillStyle = '#2b3138'; g.fillRect(0, 0, 448, 288);
    g.fillStyle = '#3b434c';
    for (let i = 0; i < 12; i++) for (let j = 0; j < 4; j++) g.fillRect(30 + i * 22, 196 + j * 20, 18, 15);
    for (let i = 0; i < 8; i++) { g.fillStyle = '#1a1e23'; g.fillRect(28 + i * 18, 40, 4, 110); g.fillStyle = '#c9d1d8'; g.fillRect(22 + i * 18, 70 + Math.sin(i) * 20, 16, 8); }
    g.fillStyle = '#4a535d';
    for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(210 + (i % 3) * 40, 60 + Math.floor(i / 3) * 44, 13, 0, 7); g.fill(); }
    g.fillStyle = '#7fd6e0'; g.fillRect(330, 40, 90, 20); g.fillStyle = '#e0b04a'; g.fillRect(330, 70, 90, 20);
    panel.userData.tex.needsUpdate = true;
  }
  deck.add(mesh(new THREE.SphereGeometry(2.6, 24, 16), std(0x9fb0c0, 0.2, 0.3), 12, 2.4, 2));
  // the probe holders on the side
  for (const z of [-8, 0, 8]) cart.add(mesh(new THREE.BoxGeometry(4, 8, 5), C.dark, 31, 82, z));
  // the monitor on its arm
  cart.add(mesh(new THREE.CylinderGeometry(1.6, 1.6, 30, 16), C.mid, 0, 100, -20));
  const mon = new THREE.Group(); mon.position.set(0, 132, -14); mon.rotation.x = -0.08; cart.add(mon);
  mon.add(mesh(new THREE.BoxGeometry(56, 38, 3.4), C.dark, 0, 0, 0));
  const screen = canvasPlane(52, 34, 520, 340, 1.0); screen.position.z = 1.75; mon.add(screen);
  cart.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  /* Paint the monitor: the fan image (a canvas) centred on black, and a few machine numbers. */
  /* Paint the monitor: the fan image (a 320 x 320 canvas) centred on black, the machine's few
     numbers, and whatever extra(g) adds on top (a TGC curve, a second image...). */
  const paintScreen = (fanCanvas, { freq = seat.o.freq, depth = seat.o.depth, extra = null, x = 100 } = {}) => {
    const g = screen.userData.g;
    g.fillStyle = '#000'; g.fillRect(0, 0, 520, 340);
    if (fanCanvas) g.drawImage(fanCanvas, x, 10, 320, 320);
    g.fillStyle = '#7fd6e0'; g.font = '14px monospace';
    if (freq) { g.fillText(freq.toFixed(1) + ' MHz', 14, 24); g.fillText(depth + ' cm', 14, 44); }
    g.fillStyle = '#e0b04a'; g.fillText('C5-2', 466, 24);
    if (extra) extra(g);
    screen.userData.tex.needsUpdate = true;
  };
  // a point on the monitor's canvas (520 x 340) -> the 8-bit layer's pixels
  const screenPx = (sx, sy) => {
    const v = screen.localToWorld(new THREE.Vector3((sx / 520 - 0.5) * 52, (0.5 - sy / 340) * 34, 0));
    return api.toPx(v);
  };
  const screenBox = (sx, sy, w, h) => {
    const a = screenPx(sx, sy), b = screenPx(sx + w, sy + h);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
  };

  return { group: room, r, body, meshes, skinMat, boneMat, clip, seatG, rock, probe, section, fan, sheet, setFan, cart, screen, paintScreen, screenPx, screenBox, mon };
}
