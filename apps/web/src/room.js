/* ============================================================================
   X-RAY ROOM: the table, the wall stand, the ceiling-mounted tube
   ============================================================================
   Three set-ups for the same radiography physics (app.js setRoom):
     table     the patient lies on a floating tabletop; the receptor is in the bucky tray under it
     wall      the patient stands at a wall stand; the receptor is in the upright bucky
     detector  a free detector, the patient lying on it (the original room)
   The physics frame never changes: the receptor is the plane y = 0, the beam comes down -y, the
   patient's long axis is +z. The wall stand is that same frame turned upright (app.js rotates
   the room group), so everything below is modelled in WORLD space for its own set-up:
     table: the frame as is; the tabletop surface at y = ROOM_GAP.table, the floor at TABLE_FLOOR
     wall:  physics +y (toward the tube) = world +z, physics +z (head) = world +y; the cover's
            front at z = ROOM_GAP.wall, the floor at WALL_FLOOR
   ROOM_GAP is real geometry, not decoration: the patient rests that far above the receptor
   (the tabletop and bucky, the stand's cover), so it is object-to-image distance in the image.
   Units: cm. Modelled after a modern ceiling-suspended DR room: floating white tabletop on a
   two-block pedestal, a column wall stand with a lit crown, a white tube on a telescoping column
   with a touchscreen collimator. */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const ROOM_GAP = { detector: 0, table: 5, wall: 3 };   // receptor to patient surface (cm)
export const TABLE_FLOOR = -80;                                 // the tabletop 85 cm above the floor
export const WALL_FLOOR = -130;                                 // the receptor centre 130 cm up
const CEILING_ABOVE_FLOOR = 270;

function mats() {
  const std = (color, roughness = 0.5, metalness = 0.05, extra = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
  return {
    // (a little self-light: the room dims while the collimator lamp is on, and white plastics
    // should still read white, not slate)
    white: std(0xeef0f1, 0.42, 0.05, { emissive: 0x4a5056 }),
    shell: std(0xe4e7e9, 0.5, 0.05, { emissive: 0x42474c }),
    grey: std(0xa3aab1, 0.5, 0.1),
    dark: std(0x3b4148, 0.55, 0.15),
    black: std(0x15191d, 0.4, 0.2),
    silver: std(0xc5cace, 0.32, 0.55),
    std,
  };
}
const rbox = (w, h, d, r, seg = 3) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2, h / 2, d / 2) - 1e-3);
const mesh = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; };

function canvasTex(w, h, draw) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv); t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------------------------------------------------------------- the table */
function buildTable(M) {
  const g = new THREE.Group();
  const top = ROOM_GAP.table;
  // the floating tabletop (it pans with the patient: app.js roomSync): white, a grey edge band
  // under its lip, accessory rails along both long edges on short standoffs
  const deck = new THREE.Group(); g.add(deck);
  const slab = mesh(rbox(70, 4, 220, 1.6), M.white, 0, top - 2, 0);
  slab.receiveShadow = true; deck.add(slab);
  deck.add(mesh(rbox(70.8, 1.4, 220.8, 0.6), M.grey, 0, top - 3.6, 0));
  for (const sx of [-1, 1]) {
    deck.add(mesh(new THREE.BoxGeometry(0.9, 1.8, 150), M.silver, sx * 36.4, top - 2.2, 0));
    for (const z of [-60, 0, 60]) deck.add(mesh(new THREE.BoxGeometry(1.4, 1.2, 2), M.grey, sx * 35.6, top - 2.2, z));
  }
  // the bucky: a long rail housing under the top, and the tray the receptor rides in (it runs
  // along the rails to follow the tube: app.js roomSync), its handle out of the front (+x)
  g.add(mesh(rbox(40, 2.6, 180, 0.8), M.grey, 0, -0.9, 0));
  const tray = new THREE.Group(); g.add(tray);
  tray.add(mesh(rbox(50, 4.2, 52, 1.0), M.dark, 0, -1.2, 0));
  tray.add(mesh(new THREE.BoxGeometry(1.2, 2.6, 46), M.grey, 25.4, -1.2, 0));       // tray front plate
  for (const z of [-9, 9]) tray.add(mesh(new THREE.BoxGeometry(3.2, 1.1, 1.3), M.grey, 27.4, -1.2, z));
  tray.add(mesh(new THREE.CylinderGeometry(0.65, 0.65, 19.3, 16).rotateX(Math.PI / 2), M.grey, 29.0, -1.2, 0));
  // the two-block pedestal and its logo badge
  g.add(mesh(rbox(40, 34, 56, 3), M.white, 0, -19.5, 0));
  g.add(mesh(rbox(52, 40, 70, 3.5), M.shell, 0, -56.5, 0));
  g.add(mesh(new THREE.BoxGeometry(40.4, 0.6, 56.4), M.grey, 0, -36.5, 0));    // the seam between them
  const badge = mesh(new THREE.CylinderGeometry(4.2, 4.2, 0.5, 40).rotateZ(Math.PI / 2),
    new THREE.MeshStandardMaterial({ roughness: 0.35, map: canvasTex(128, 128, (c, w) => {
      c.fillStyle = '#f4f6f7'; c.fillRect(0, 0, w, w);
      c.strokeStyle = '#2a63b8'; c.lineWidth = 11; c.beginPath(); c.arc(w / 2, w / 2, w * 0.36, 0, Math.PI * 2); c.stroke();
      c.lineWidth = 7; c.beginPath(); c.arc(w / 2, w / 2, w * 0.18, Math.PI * 0.2, Math.PI * 1.6); c.stroke();
    }) }), 20.1, -14, 0);
  badge.rotation.x = Math.PI / 2; g.add(badge);
  // grey base and the foot pedals on the operator's side
  g.add(mesh(rbox(64, 4, 86, 1.5), M.grey, 0, TABLE_FLOOR + 2, 0));
  g.add(mesh(rbox(7, 1.6, 40, 0.6), M.dark, 36, TABLE_FLOOR + 0.8, 0));
  for (const z of [-11, 0, 11]) g.add(mesh(rbox(6, 1.4, 8, 0.5), M.black, 36.4, TABLE_FLOOR + 2.1, z));
  shade(g);
  return { g, deck, tray };
}
// every part of the room casts and takes shadows: the collimator's light stops on the patient and
// the tabletop (or the stand's cover), as light does, and never shows through on the base or floor
function shade(g) { g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); }

/* ---------------------------------------------------------------- the wall stand */
function buildWall(M, aecCells) {
  const g = new THREE.Group();
  const front = ROOM_GAP.wall;
  // the bucky (housing, cover, grips and carriage) rides up and down the column to follow the
  // tube (app.js roomSync); the receptor is inside it behind the cover
  const bucky = new THREE.Group(); g.add(bucky);
  bucky.add(mesh(rbox(62, 66, 12, 2.6), M.white, 0, 0, front - 6));
  // the printed cover: border, centring cross and the AEC chambers where the bucky has them
  // (physics x, z -> world -x, y on this face)
  const W = 58, H = 62;
  const cover = mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ roughness: 0.6,
    map: canvasTex(580, 620, (c, w, h) => {
      const k = w / W, cx = w / 2, cy = h / 2;
      c.fillStyle = '#f1f3f4'; c.fillRect(0, 0, w, h);
      c.strokeStyle = '#c9ced3'; c.lineWidth = 3; c.strokeRect(18, 18, w - 36, h - 36);
      c.strokeStyle = '#8b939b'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(cx, cy - 70); c.lineTo(cx, cy + 70); c.moveTo(cx - 70, cy); c.lineTo(cx + 70, cy); c.stroke();
      c.lineWidth = 2.5; c.strokeStyle = '#a7aeb5';
      for (const p of Object.values(aecCells)) {
        c.beginPath(); c.arc(cx - p.x * k, cy - p.z * k, 2.9 * k, 0, Math.PI * 2); c.stroke();
      }
    }) }), 0, 0, front + 0.02);
  cover.receiveShadow = true; bucky.add(cover);
  // side grips
  for (const sx of [-1, 1]) bucky.add(mesh(rbox(2.4, 30, 3.4, 1.1), M.grey, sx * 32.2, 0, front - 5));
  // carriage, column, crown with its cyan light, the small display, the floor plate
  bucky.add(mesh(rbox(26, 32, 8, 1.2), M.grey, 0, 0, front - 16));
  const colTop = 86, colH = colTop - WALL_FLOOR;
  g.add(mesh(rbox(16, colH, 12, 1.5), M.silver, 0, WALL_FLOOR + colH / 2, front - 26));
  g.add(mesh(new THREE.BoxGeometry(16.6, 1.6, 12.6),
    new THREE.MeshStandardMaterial({ color: 0x0d3940, emissive: 0x35d6e8, emissiveIntensity: 1.4 }), 0, colTop - 4, front - 26));
  g.add(mesh(rbox(17.2, 3.4, 13.2, 1.2), M.white, 0, colTop - 1.3, front - 26));
  const dcv = document.createElement('canvas'); dcv.width = 192; dcv.height = 112;
  const dtex = new THREE.CanvasTexture(dcv); dtex.colorSpace = THREE.SRGBColorSpace;
  g.add(mesh(new THREE.PlaneGeometry(9, 5.25),
    new THREE.MeshStandardMaterial({ map: dtex, emissive: 0xffffff, emissiveMap: dtex, emissiveIntensity: 0.7, roughness: 0.3 }),
    0, 46, front - 19.9));
  g.add(mesh(rbox(10.4, 6.6, 0.8, 0.4), M.black, 0, 46, front - 20.4));
  g.add(mesh(rbox(40, 2.4, 34, 1), M.grey, 0, WALL_FLOOR + 1.2, front - 22));
  let lastSid = null;
  const setSid = (sid) => {
    if (sid === lastSid) return; lastSid = sid;
    const c = dcv.getContext('2d');
    c.fillStyle = '#071722'; c.fillRect(0, 0, 192, 112);
    c.fillStyle = '#7fe6f2'; c.font = 'bold 22px Arial'; c.textAlign = 'center';
    c.fillText('SID', 96, 34); c.font = 'bold 40px Arial'; c.fillText(Math.round(sid) + ' cm', 96, 84);
    dtex.needsUpdate = true;
  };
  setSid(180);
  shade(g);
  return { g, setSid, bucky };
}

/* ---------------------------------------------------------------- the ceiling column */
function buildColumn(M) {
  const g = new THREE.Group();
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const secs = [[15, M.white], [12.6, M.shell], [10.4, M.white]].map(([w, m]) => {
    const s = new THREE.Mesh(unit, m); s.userData.w = w; g.add(s); return s;
  });
  const carriage = mesh(rbox(42, 10, 30, 2), M.grey); g.add(carriage);
  const rails = [-1, 1].map((sx) => { const r = mesh(new THREE.BoxGeometry(4, 3, 420), M.dark); r.userData.sx = sx; g.add(r); return r; });
  // the column from the ceiling down to the tube's mount (world point), telescoped
  const place = (mount, floorY) => {
    const ceil = Math.max(floorY + CEILING_ABOVE_FLOOR, mount.y + 24);
    const L = ceil - mount.y;
    const spans = [[0, 0.42], [0.36, 0.74], [0.68, 1]];
    secs.forEach((s, i) => {
      const [a, b] = spans[i], h = L * (b - a), w = s.userData.w;
      s.scale.set(w, h, w); s.position.set(mount.x, ceil - L * a - h / 2, mount.z);
    });
    carriage.position.set(mount.x, ceil + 5, mount.z);
    for (const r of rails) r.position.set(mount.x + r.userData.sx * 17, ceil + 11.5, 0);
  };
  return { g, place };
}

/* ---------------------------------------------------------------- the tube head
   Built into the tube group's shell (origin = focal spot, -y toward the patient, +z = the
   operator's side, where the touchscreen faces). The housing's long axis is the anode-cathode
   axis. Returns the collimator screen's canvas (app.js updateCollimatorLCD draws it) and the
   mount point the ceiling column comes down to. */
export function buildTubeHead(tube) {
  const M = mats();
  const shell = new THREE.Group(); shell.rotation.x = Math.PI; tube.add(shell);
  // housing: a white drum with grey end rings and domed caps
  const drum = mesh(new THREE.CylinderGeometry(8.6, 8.6, 34, 56).rotateZ(Math.PI / 2), M.white, 0, 4.6, 0);
  shell.add(drum);
  for (const sx of [-1, 1]) {
    shell.add(mesh(new THREE.TorusGeometry(8.5, 0.7, 14, 56).rotateY(Math.PI / 2), M.grey, sx * 17, 4.6, 0));
    const cap = mesh(new THREE.SphereGeometry(8.4, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), M.shell, sx * 17.2, 4.6, 0);
    cap.scale.set(1, 0.32, 1); cap.rotation.z = -sx * Math.PI / 2;   // (the dome's height, squashed) shell.add(cap);
  }
  shell.add(mesh(new THREE.CylinderGeometry(8.75, 8.75, 3.2, 56).rotateZ(Math.PI / 2), M.grey, 0, 4.6, 0));   // the port band
  // the HV cables, coiled, out of both ends and up
  for (const sx of [-1, 1]) {
    const pts = [];
    for (let i = 0; i <= 260; i++) {
      const t = i / 260, a = t * Math.PI * 2 * 11;
      pts.push(new THREE.Vector3(sx * (14 - 7.2 * t) + 1.3 * Math.cos(a), 11 + 36 * t, -2 + 1.3 * Math.sin(a)));   // in to the column
    }
    shell.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 520, 0.5, 8), M.white));
  }
  // the yoke the column holds
  shell.add(mesh(rbox(13, 5, 11, 1.2), M.grey, 0, 15.2, 0));
  const mount = new THREE.Object3D(); mount.position.set(0, 17.7, 0); shell.add(mount);
  // port neck and the collimator box: the box (with its screen, handle and knobs) turns on the
  // neck about the central ray (the shell's y axis); the drum and the yoke above it stay put
  shell.add(mesh(new THREE.CylinderGeometry(4.6, 5.2, 2.6, 40), M.dark, 0, -4.4, 0));
  const coll = new THREE.Group(); shell.add(coll);
  coll.add(mesh(rbox(22, 12, 20, 2.2), M.shell, 0, -11.6, 0));
  coll.add(mesh(new THREE.BoxGeometry(22.2, 0.5, 20.2), M.grey, 0, -6.2, 0));
  // touchscreen, tilted up a little toward the operator
  const scr = new THREE.Group(); scr.position.set(0, -11.2, 10.2); scr.rotation.x = -0.18; coll.add(scr);
  scr.add(mesh(rbox(15, 9, 1, 0.6), M.black, 0, 0, 0.3));
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 300;
  const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 8; tex.colorSpace = THREE.SRGBColorSpace;
  scr.add(mesh(new THREE.PlaneGeometry(13.4, 7.8),
    new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.6, roughness: 0.3 }), 0, 0, 0.83));
  // the handle: a grey loop round the front of the collimator
  const loop = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-11.6, -15.6, 4), new THREE.Vector3(-12.6, -16.4, 11.5), new THREE.Vector3(-8, -16.8, 15.2),
    new THREE.Vector3(0, -17, 15.8), new THREE.Vector3(8, -16.8, 15.2), new THREE.Vector3(12.6, -16.4, 11.5),
    new THREE.Vector3(11.6, -15.6, 4)]);
  coll.add(mesh(new THREE.TubeGeometry(loop, 80, 0.95, 14), M.grey));
  // control knobs and the beam exit underneath
  for (const x of [-6, 6]) {
    coll.add(mesh(new THREE.CylinderGeometry(1.5, 1.6, 1.8, 28), M.grey, x, -18.3, 5.5));
    coll.add(mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.4, 20), M.dark, x, -19.3, 5.5));
  }
  coll.add(mesh(new THREE.BoxGeometry(7, 0.3, 7), M.black, 0, -17.7, -1));
  return { cv, tex, last: '', mount, coll };
}

/* ---------------------------------------------------------------- the room */
export function buildRoom(scene, { aecCells }) {
  const M = mats();
  const tb = buildTable(M), table = tb.g; table.visible = false; scene.add(table);
  const wall = buildWall(M, aecCells); wall.g.visible = false; scene.add(wall.g);
  const column = buildColumn(M); column.g.visible = false; scene.add(column.g);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(420, 64).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x1b2027, roughness: 0.95, metalness: 0 }));
  floor.receiveShadow = true; floor.visible = false; scene.add(floor);
  return { table, deck: tb.deck, tray: tb.tray, wall: wall.g, wallBucky: wall.bucky, setWallSid: wall.setSid,
    column: column.g, placeColumn: column.place, floor };
}
