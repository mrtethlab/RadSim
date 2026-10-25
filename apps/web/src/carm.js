/* ============================================================================
   FLUOROSCOPY ROOM: the mobile C-arm and its monitor cart
   ============================================================================
   Modelled after a GE OEC 9800 / Elite: off-white shells with lavender-grey trim, a 9" image
   intensifier over the patient, the tube and collimator housing under the table, the C sliding
   through its holder, the holder turning on a hub at the end of the cross-arm, the cross-arm
   on a telescoping column over the cart. The monitor cart (the workstation) stands apart with
   its two screens: they show the live and reference images as the console does (fluoro.js).

   Every moving part is its own group with its pivot at its local origin, so fluoro.js poses
   the machine joint by joint, exactly as the beam is computed (fluoro.js beamFrame):
     base     the cart and its base, still. Origin: the column's axis on the floor.
     column   the inner column and the control head: rises with lift. Origin as the base's.
     boom     the cross-arm: yaws with wig-wag about the column, slides out with extend, rises
              with lift. Origin on the column's axis at the isocentre's height; the isocentre
              is at (C.LARM, 0, 0) along it.
     holder   the hub and the C's holder: turned by flip-flop and by tilt about the cross-arm's
              own axis (x). Origin: the isocentre.
     c        the C, the image intensifier and the tube: inside the holder, turned by the
              orbital angle about the holder's z (the C slides through it). Origin: the isocentre.
   Units: cm. Local frames: +x from the column toward the patient, +y up, the beam up the C's
   +y (the focal spot at -SRC_ISO, the intensifier's face at SID - SRC_ISO), the C in its x-y
   plane, open toward +x. */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// The machine's own dimensions (cm). RC: the C's centreline radius about the isocentre; LARM:
// the column's axis to the beam's (the wig-wag radius); ARC: the C's span, degrees either side of
// its back (the holder's side, 180 in the C's frame); SHOE: the holder's grip on it. The C
// stays in the holder while |orbital| <= ARC - SHOE (fluoro's slider stops short of that).
export const CARM = { RC: 72, LARM: 125, ARC: 110, SHOE: 14, HUB: 98 };

function mats() {
  const std = (color, roughness = 0.5, metalness = 0.05, extra = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
  return {
    // (self-lit a little: the fluoro room is dim, and the shells should still read white)
    shell: std(0xf1f2f4, 0.42, 0.04, { emissive: 0x6c7076 }),
    shell2: std(0xe3e6ea, 0.5, 0.04, { emissive: 0x5e6268 }),
    lav: std(0xaeacd0, 0.45, 0.08, { emissive: 0x403e62 }),
    lavDark: std(0x8f8db3, 0.5, 0.1, { emissive: 0x2e2c4a }),
    grey: std(0x9aa1a8, 0.5, 0.15),
    dark: std(0x3a4047, 0.55, 0.2),
    black: std(0x111418, 0.35, 0.25),
    rubber: std(0x1d2024, 0.85, 0.0),
    chrome: std(0xc8cdd2, 0.25, 0.7),
    glass: std(0x0d1117, 0.12, 0.3),
    std,
  };
}
const rbox = (w, h, d, r, seg = 3) => new RoundedBoxGeometry(w, h, d, seg, Math.max(0.01, Math.min(r, w / 2, h / 2, d / 2) - 1e-3));
const mesh = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; };
function canvasTex(w, h, draw) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv); t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/* A segment of a ring about the z axis: a rounded-rectangle section (radial r0..r1, z -d..d,
   corner radius cr) swept from angle a0 to a1 (radians, from +x toward +y). */
function ringSeg(r0, r1, d, a0, a1, cr = 2, seg = 64) {
  const pts = [];
  const c = Math.min(cr, (r1 - r0) / 2, d);
  const arc = (cx, cy, s, e) => { for (let i = 0; i <= 4; i++) { const t = s + (e - s) * i / 4; pts.push(new THREE.Vector2(cx + c * Math.cos(t), cy + c * Math.sin(t))); } };
  // the profile in (radius, z), counter-clockwise; lathe turns it about its y (here: z)
  arc(r1 - c, -d + c, -Math.PI / 2, 0);
  arc(r1 - c, d - c, 0, Math.PI / 2);
  arc(r0 + c, d - c, Math.PI / 2, Math.PI);
  arc(r0 + c, -d + c, Math.PI, 1.5 * Math.PI);
  pts.push(pts[0].clone());
  // LatheGeometry sweeps about +y, a vertex at (r sin phi, h, r cos phi); turned a quarter about
  // x that is (r sin phi, -r cos phi, h): about +z, at the angle phi - 90 degrees from +x
  const g = new THREE.LatheGeometry(pts, seg, a0 + Math.PI / 2, a1 - a0);
  g.rotateX(Math.PI / 2);
  return g;
}
/* the same, closed at both ends (a holder's shoe, a band) */
function ringBlock(r0, r1, d, a0, a1, cr, M) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(ringSeg(r0, r1, d, a0, a1, cr), M));
  for (const a of [a0, a1]) {
    const cap = mesh(rbox(r1 - r0, 0.6, 2 * d, Math.min(cr, 0.3)), M);
    cap.position.set(Math.cos(a) * (r0 + r1) / 2, Math.sin(a) * (r0 + r1) / 2, 0);
    cap.rotation.z = a;                                       // (its x radial, its thin y along the arc)
    g.add(cap);
  }
  return g;
}
const tube = (pts, r, mat, closed = false) =>
  new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p))), 48, r, 10, closed), mat);

function badge(text, w = 256, h = 96, fg = '#7f7da3') {
  return canvasTex(w, h, (g) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = fg; g.font = `italic 700 ${h * 0.62}px Arial, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 2);
  });
}
// the round lavender emblem on the cart's flank (a swirl in a ring, no lettering)
function emblem() {
  return canvasTex(256, 256, (g) => {
    g.clearRect(0, 0, 256, 256);
    g.fillStyle = '#b3b1cf'; g.beginPath(); g.arc(128, 128, 118, 0, 2 * Math.PI); g.fill();
    g.strokeStyle = '#eceef0'; g.lineWidth = 7;
    g.beginPath(); g.arc(128, 128, 98, 0, 2 * Math.PI); g.stroke();
    g.lineWidth = 10; g.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2;
      g.beginPath();
      g.arc(128 + 46 * Math.cos(a), 128 + 46 * Math.sin(a), 30, a + Math.PI * 0.2, a + Math.PI * 1.3);
      g.stroke();
    }
  });
}
const decal = (tex, w, h) => new THREE.Mesh(new THREE.PlaneGeometry(w, h),
  new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
function caster(M, r, x, y, z) {
  const g = new THREE.Group();
  const wheel = mesh(new THREE.CylinderGeometry(r, r, r * 0.9, 20), M.rubber); wheel.rotation.x = Math.PI / 2;
  const hub = mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.45, r * 0.95, 16), M.grey); hub.rotation.x = Math.PI / 2;
  const fork = mesh(rbox(r * 1.4, r * 1.2, r * 1.3, r * 0.2), M.shell2, 0, r * 0.9, 0);
  g.add(wheel, hub, fork);
  g.position.set(x, y + r, z);
  return g;
}

/* ---------------------------------------------------------------- the C-arm */
export function buildCarm(SID, SRC_ISO) {
  const M = mats();
  const { RC, LARM, ARC, SHOE, HUB } = CARM;
  const DET = SID - SRC_ISO;                                  // the isocentre to the II's face
  const parts = { base: new THREE.Group(), column: new THREE.Group(), boom: new THREE.Group(),
    holder: new THREE.Group(), c: new THREE.Group() };
  const d2r = Math.PI / 180;

  /* ---- the C: arc, intensifier, tube ---- */
  const C = parts.c;
  const back = 180 * d2r, a0 = back - ARC * d2r, a1 = back + ARC * d2r;
  C.add(new THREE.Mesh(ringSeg(RC - 4.5, RC + 4.5, 8, a0, a1, 2.2, 96), M.shell));
  // the rails on both faces: a lavender band set into each flat side
  for (const s of [-1, 1]) {
    const band = new THREE.Mesh(ringSeg(RC - 2.2, RC + 2.2, 0.35, a0 + 0.12, a1 - 0.12, 0.3, 96), M.lav);
    band.position.z = s * 8.05;
    C.add(band);
  }
  // the image intensifier: its face DET above the isocentre, a drum, a lavender ring, the cap
  // that meets the C's upper end
  const ii = new THREE.Group();
  ii.add(mesh(new THREE.CylinderGeometry(17.5, 17.5, 22, 48), M.shell, 0, DET + 11, 0));
  ii.add(mesh(new THREE.CylinderGeometry(18.6, 18.6, 3.2, 48), M.lav, 0, DET + 6, 0));
  ii.add(mesh(new THREE.CylinderGeometry(18.2, 18.2, 1.0, 48), M.grey, 0, DET + 0.6, 0));
  ii.add(mesh(new THREE.CylinderGeometry(15.2, 15.2, 0.4, 48), M.dark, 0, DET + 0.05, 0));    // the input face
  ii.add(mesh(rbox(40, 22, 36, 6), M.shell, 2, DET + 32, 0));                                  // the cap
  ii.add(mesh(rbox(41, 1.2, 37, 0.5), M.lav, 2, DET + 21.4, 0));
  const oec = decal(badge('OEC'), 14, 5.2); oec.position.set(22.1, DET + 34, 0); oec.rotation.y = Math.PI / 2;
  ii.add(oec);
  C.add(ii);
  // the tube and collimator housing under the patient: the focal spot SRC_ISO below the
  // isocentre, the housing reaching forward of the beam with its grille at the front
  const tubeH = new THREE.Group();
  const ty = -SRC_ISO;
  tubeH.add(mesh(rbox(58, 18, 34, 5), M.shell, 10, ty - 10, 0));
  tubeH.add(mesh(rbox(59, 2.0, 35, 0.8), M.lav, 10, ty - 1.5, 0));                              // the trim band
  tubeH.add(mesh(rbox(30, 4, 26, 2), M.shell2, 0, ty + 1.2, 0));                                // the collimator face
  tubeH.add(mesh(new THREE.CylinderGeometry(7, 7, 0.4, 32), M.dark, 0, ty + 3.3, 0));           // its port
  for (let k = 0; k < 6; k++) tubeH.add(mesh(rbox(0.6, 8, 22, 0.2), M.dark, 39.3, ty - 10, -10 + k * 4));   // grille
  tubeH.add(mesh(rbox(1.2, 10, 24, 0.5), M.grey, 39.0, ty - 10, 0));
  C.add(tubeH);
  // the high-voltage cable: from the tube up the back of the C to the holder (it moves with the C)
  const cab = [];
  for (let i = 0; i <= 12; i++) {
    const a = 270 * d2r - i * (40 * d2r) / 12;
    cab.push([Math.cos(a) * (RC + 6.5), Math.sin(a) * (RC + 6.5), -9.5]);
  }
  C.add(tube([[4, ty - 18, -12], [0, ty - 22, -12], ...cab.slice(1)], 1.4, M.grey));

  /* ---- the holder: the shoe the C slides in, and the hub it turns on ---- */
  const H = parts.holder;
  H.add(ringBlock(RC + 4.6, RC + 12, 11, back - SHOE * d2r, back + SHOE * d2r, 2.5, M.shell2));
  H.add(ringBlock(RC + 4.6, RC + 6.5, 11.6, back - (SHOE - 1.5) * d2r, back + (SHOE - 1.5) * d2r, 0.6, M.lavDark));
  // the lips over the C's faces
  for (const s of [-1, 1]) {
    const lip = new THREE.Mesh(ringSeg(RC - 1, RC + 6, 0.9, back - SHOE * d2r, back + SHOE * d2r, 0.4), M.shell2);
    lip.position.z = s * 9.2;
    H.add(lip);
  }
  // the hub: a drum along the cross-arm's axis, from the shoe back to the cross-arm's end
  const hubLen = HUB - (RC + 12) + 0.5;
  const hub = mesh(new THREE.CylinderGeometry(12, 13, hubLen, 40), M.shell, -(RC + 12) - hubLen / 2 + 0.2, 0, 0);
  hub.rotation.z = Math.PI / 2; H.add(hub);
  const ring = mesh(new THREE.CylinderGeometry(13.6, 13.6, 2.4, 40), M.lav, -HUB + 4, 0, 0);
  ring.rotation.z = Math.PI / 2; H.add(ring);
  const handle = tube([[-(RC + 10), 9, 12], [-(RC + 16), 14, 16], [-(RC + 24), 14, 16], [-(RC + 26), 9, 13]], 1.3, M.lavDark);
  H.add(handle);

  /* ---- the cross-arm (boom): from behind the column out to the hub ---- */
  const B = parts.boom;
  const armEnd = LARM - HUB;                                  // the hub's face, along the arm
  B.add(mesh(rbox(armEnd + 32, 16, 22, 4), M.shell, (armEnd - 32) / 2, 0, 0));
  B.add(mesh(rbox(armEnd + 33, 1.4, 22.6, 0.6), M.lav, (armEnd - 32) / 2, -5, 0));
  const flange = mesh(new THREE.CylinderGeometry(13.2, 13.2, 3, 40), M.shell2, armEnd - 1.5, 0, 0);
  flange.rotation.z = Math.PI / 2; B.add(flange);
  // the brake handles either side
  for (const s of [-1, 1]) B.add(tube([[armEnd - 20, -6, s * 11], [armEnd - 20, -12, s * 15], [armEnd - 30, -12, s * 15], [armEnd - 30, -6, s * 11]], 1.0, M.lavDark));
  // the cable from the hub over to the column
  B.add(tube([[armEnd + 2, 6, -13], [armEnd - 10, 14, -16], [10, 18, -16], [-4, 6, -14], [-4, -30, -14]], 1.4, M.grey));

  /* ---- the column and its control head ---- */
  const COL = parts.column;
  COL.add(mesh(rbox(22, 120, 26, 3), M.shell2, 0, -60, 0));                   // telescopes into the cart
  COL.add(mesh(rbox(24, 4, 28, 1.5), M.lav, 0, -9, 0));
  // the control head on top: angled screen toward the operator (-x)
  const headY = 22;
  COL.add(mesh(rbox(34, 20, 30, 4), M.shell, -2, headY, 0));
  const scr = mesh(new THREE.PlaneGeometry(22, 12), new THREE.MeshBasicMaterial({ map: canvasTex(256, 140, (g, w, h) => {
    g.fillStyle = '#0b1622'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#5fd0ff'; g.font = 'bold 30px monospace'; g.fillText('75 kV', 14, 44);
    g.fillText('2.1 mA', 14, 84);
    g.fillStyle = '#9be38a'; g.font = '22px monospace'; g.fillText('AUTO  PULSE', 14, 122);
    g.fillStyle = '#2b3f56'; for (let k = 0; k < 4; k++) g.fillRect(160, 16 + k * 30, 80, 22);
  }) }));
  COL.add(mesh(rbox(1.2, 15, 25, 0.5), M.dark, -19.4, headY + 2, 0));                 // (x -20..-18.8)
  scr.position.set(-20.1, headY + 2, 0); scr.rotation.y = -Math.PI / 2;
  COL.add(scr);
  // the steering handles round the head
  COL.add(tube([[-14, headY - 8, -17], [-24, headY - 8, -20], [-24, headY - 8, 20], [-14, headY - 8, 17]], 1.3, M.lavDark));

  /* ---- the cart and its base (still) ---- */
  const BASE = parts.base;
  const cartX0 = -82, cartX1 = 14, cartH = 72, w = 30;          // behind the column, its sleeve at the front
  BASE.add(mesh(rbox(cartX1 - cartX0, cartH, 2 * w, 7), M.shell, (cartX0 + cartX1) / 2, 14 + cartH / 2, 0));
  BASE.add(mesh(rbox(cartX1 - cartX0 + 1, 3, 2 * w + 1, 1.2), M.lav, (cartX0 + cartX1) / 2, 14 + cartH - 10, 0));
  BASE.add(mesh(rbox(cartX1 - cartX0 + 3, 6, 2 * w + 3, 2.5), M.lavDark, (cartX0 + cartX1) / 2, 15, 0));   // the bumper
  // the column's sleeve rising from the cart's front
  BASE.add(mesh(rbox(28, 18, 32, 4), M.shell2, 0, 14 + cartH + 9, 0));
  // the emblem and a model plate on both flanks
  for (const s of [-1, 1]) {
    const e = decal(emblem(), 34, 34); e.position.set(cartX0 + 30, 14 + cartH / 2 - 4, s * (w + 0.05)); e.rotation.y = s > 0 ? 0 : Math.PI;
    BASE.add(e);
    const plate = decal(badge('OEC 9800', 320, 80, '#8e8cae'), 22, 5.5); plate.position.set(cartX0 + 64, 14 + cartH - 18, s * (w + 0.05)); plate.rotation.y = s > 0 ? 0 : Math.PI;
    BASE.add(plate);
  }
  // the push handle at the back
  BASE.add(tube([[cartX0 + 4, 14 + cartH - 6, -24], [cartX0 - 8, 14 + cartH + 4, -24], [cartX0 - 8, 14 + cartH + 4, 24], [cartX0 + 4, 14 + cartH - 6, 24]], 1.8, M.lavDark));
  // the base: a low frame under the cart and a leg forward under the C, on casters
  BASE.add(mesh(rbox(cartX1 - cartX0 + 6, 8, 2 * w + 8, 3), M.shell2, (cartX0 + cartX1) / 2, 8, 0));
  const legX1 = LARM - HUB - 14;                              // the leg's front, short of the C's holder
  for (const s of [-1, 1]) {
    BASE.add(mesh(rbox(legX1 - cartX1 + 8, 7, 9, 2.5), M.shell2, (cartX1 + legX1) / 2, 6.5, s * (w - 4)));
    BASE.add(caster(M, 4.5, legX1 - 3, 0, s * (w - 4)));
  }
  for (const s of [-1, 1]) {
    const wh = mesh(new THREE.CylinderGeometry(11, 11, 6, 32), M.rubber, cartX0 + 12, 11, s * (w + 1)); wh.rotation.x = Math.PI / 2;
    const cap = mesh(new THREE.CylinderGeometry(7, 7, 6.4, 24), M.shell2, cartX0 + 12, 11, s * (w + 1)); cap.rotation.x = Math.PI / 2;
    BASE.add(wh, cap);
  }

  for (const g of Object.values(parts)) g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return parts;
}

/* ------------------------------------------------------- the monitor cart */
/* The workstation: a cabinet on casters with a keyboard shelf, a printer and a storage door,
   a mast with two monitors side by side. The screens are canvases fluoro.js draws into (the
   live image, the reference), returned with the group. Origin: the floor under the cabinet's
   centre; it faces +x. */
export function buildTower() {
  const M = mats();
  const g = new THREE.Group();
  const W = 60, D = 52, H = 96, floor = 14;
  g.add(mesh(rbox(D, H, W, 5), M.shell, 0, floor + H / 2, 0));
  g.add(mesh(rbox(D + 4, 7, W + 4, 3), M.lavDark, 0, floor + 2, 0));                 // the bumper
  for (const [x, z] of [[-18, -22], [-18, 22], [18, -22], [18, 22]]) g.add(caster(M, 5, x, 0, z));
  // the front (+x): the printer slot, a door, the keyboard shelf on its rails
  g.add(mesh(rbox(1.2, 18, 44, 1), M.shell2, D / 2 + 0.3, floor + H - 22, 0));
  g.add(mesh(rbox(1.4, 2.4, 30, 0.6), M.dark, D / 2 + 0.6, floor + H - 18, 0));
  g.add(mesh(rbox(1.2, 34, 44, 2), M.shell2, D / 2 + 0.3, floor + 30, 0));
  g.add(mesh(rbox(1.6, 8, 2, 0.8), M.grey, D / 2 + 1, floor + 34, 16));
  g.add(mesh(rbox(26, 3, W - 6, 1.2), M.shell2, D / 2 + 10, floor + H - 2, 0));
  const kb = mesh(rbox(16, 1.4, 42, 0.5), M.dark, D / 2 + 12, floor + H, 0); g.add(kb);
  g.add(tube([[D / 2 - 2, floor + H - 6, -W / 2 - 1], [D / 2 + 14, floor + H - 6, -W / 2 - 3], [D / 2 + 14, floor + H - 6, W / 2 + 3], [D / 2 - 2, floor + H - 6, W / 2 + 1]], 1.6, M.lavDark));
  const e = decal(emblem(), 22, 22); e.position.set(D / 2 + 1.0, floor + 56, 0); e.rotation.y = Math.PI / 2; g.add(e);
  // the mast and the yoke
  g.add(mesh(rbox(10, 30, 12, 2), M.shell2, -8, floor + H + 15, 0));
  const top = floor + H + 30;
  g.add(mesh(rbox(16, 6, 92, 2.5), M.shell, -6, top + 2, 0));
  // two monitors, tilted a little back, their screens canvases: the live one on the left as
  // you face the cart (it faces +x, so its left is +z)
  const screens = [];
  for (const s of [1, -1]) {
    const mon = new THREE.Group();
    mon.add(mesh(rbox(5, 34, 44, 1.5), M.shell, 0, 0, 0));
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 400;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    // the bezel on the case's face (x 2.5..3.1), the screen just in front of it
    mon.add(mesh(rbox(0.6, 32, 41.5, 0.3), M.black, 2.8, 0, 0));
    const scr = mesh(new THREE.PlaneGeometry(39, 30.5), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }), 3.15, 0, 0);
    scr.rotation.y = Math.PI / 2;
    mon.add(scr);
    mon.position.set(0, top + 22, s * 23);
    mon.rotation.z = -0.08;
    g.add(mon);
    screens.push({ canvas: cv, texture: tex });
  }
  // the handle over the monitors
  g.add(tube([[-6, top + 40, -40], [-6, top + 47, -30], [-6, top + 47, 30], [-6, top + 40, 40]], 1.4, M.shell2));
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { group: g, live: screens[0], ref: screens[1] };
}
