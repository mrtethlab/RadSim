/* ============================================================================
   CT RIG: the GE Optima CT660 and the Canon Aquilion Precision (gantry covers, couch)
   ============================================================================
   Geometry only. ct.js owns the groups, the live screens' drawing and every motion
   (rebuildCTModel / buildCTRig call in here for the vendor in use); the first-generation
   builders are kept, unwired, in ctRigLegacy.js. Units cm (world units). The bore centre is
   (0, ISO_Y), the patient's long axis z (head toward -z, the couch at +z), the floor FLOOR_Y.

   The housing is hollow where it matters. The bore's throat is opaque at both ends and a
   translucent inner cover in the middle (the window); behind the window a dark annular
   cavity holds the rotor: the tube and its collimator, the detector arc and its electronics,
   the generators. The rotor turns about z inside that cavity, so it is only ever seen through
   the window, never in the bore beside the patient. Along z:
     FACE (15)  face moulding, throat  Z_WIN_F (3)  window + rotor  Z_WIN_B (-17)  rear throat  back
   The simulation's scan plane (the lasers', z 0) falls inside the window.

   Proportions from the vendors' photographs and datasheets (the 70 cm bore of both):
     GE Optima CT660   a white face, near square with big rounded top corners (2.24 m wide,
                       1.9 m tall), dished round the bore with a slim grey lip; a blue-grey
                       body behind it and a dark plinth; the blue LCD in a tapering module at
                       the top, round keypads either side of the bore; the couch a long white
                       cradle on a dark tapered pedestal, a handle at its foot.
     Canon Aquilion    a round tilting drum (1.72 m), a light blue-grey ring round its face,
     Precision         stationary "ear" stands either side; angled control panels with small
                       LCD read-outs and lit blue keys, the LCD screen at the crown, red
                       indicator lights; the couch on a white bellows column.
   The brand names are drawn as canvas text; no artwork is copied. */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const Z_WIN_F = 3, Z_WIN_B = -17;                       // the bore window's front and back (z)
const ROTOR_Z = (Z_WIN_F + Z_WIN_B) / 2;                       // the rotor's plane, mid-window
const ROTOR_D = Z_WIN_F - Z_WIN_B - 3;                         // the rotor's depth, clear of the cavity walls
const D2R = Math.PI / 180;

const mat = (color, rough = 0.5, metal = 0.05, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
// cover plastics carry a little self-light (as the x-ray room's do) so white reads white under
// the bay's cool key light
const plastic = (color, rough = 0.42, glow = 0x575654) => mat(color, rough, 0.03, { emissive: glow });
const rbox = (w, h, d, r, seg = 3) => new RoundedBoxGeometry(w, h, d, seg, Math.max(0.01, Math.min(r, w / 2, h / 2, d / 2) - 1e-3));
const mesh = (geo, m, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); return o; };
const alongZ = (geo) => geo.rotateX(Math.PI / 2);              // a y-axis primitive (cylinder) laid along z
// A key cap: a squashed half sphere facing +z.
function dome(r, seg = 14) {
  const g = new THREE.SphereGeometry(r, seg, Math.max(4, seg >> 1), 0, Math.PI * 2, 0, Math.PI / 2);
  g.rotateX(Math.PI / 2); g.scale(1, 1, 0.5); return g;
}
function canvasTex(w, h, draw) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv); t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// Printed artwork (wordmarks, labels, icons): a lit transparent plane laid on a surface.
function decal(tex, w, h) {
  const m = new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.5,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
}
// A live screen: the canvas texture ct.js redraws, lit from within.
function screen(tex, w, h) {
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.85, roughness: 0.22 }));
}
// A surface of revolution about the bore axis, from (r, z) points (z in world units).
function lathe(pts, m, segs, isoY) {
  const g = new THREE.LatheGeometry(pts.map(([r, z]) => new THREE.Vector2(r, -z)), segs);
  const o = new THREE.Mesh(g, m); o.rotation.x = -Math.PI / 2; o.position.y = isoY; return o;
}
// Points on a circular arc in the (r, z) profile plane: centre (cr, cz), radius rad, a0 → a1 degrees.
function arc(cr, cz, rad, a0, a1, n = 6) {
  const p = [];
  for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * D2R; p.push([cr + rad * Math.cos(a), cz + rad * Math.sin(a)]); }
  return p;
}
// An extruded slab between two z planes (front zF, back zB), its edges rounded by a bevel.
function slab(shape, zF, zB, bev, m, curveSegments = 36) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.01, zF - zB - 2 * bev), bevelEnabled: true,
    bevelThickness: bev, bevelSize: bev, bevelSegments: 4, curveSegments });
  const o = new THREE.Mesh(g, m); o.position.z = zB + bev; return o;
}
const circleHole = (shape, cy, r) => { const h = new THREE.Path(); h.absarc(0, cy, r, 0, Math.PI * 2, true); shape.holes.push(h); return shape; };
// A rounded box whose top is narrowed (a tapered column): the vertices scaled with height.
function taperBox(w, h, d, r, kTop) {
  const g = rbox(w, h, d, r); const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const k = 1 + (kTop - 1) * (p.getY(i) / h + 0.5); p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k); }
  g.computeVertexNormals(); return g;
}

// ---- printed artwork ----
const texOptima = () => canvasTex(512, 128, (g, W, H) => {
  g.fillStyle = '#6c7a8a'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '300 88px "Helvetica Neue", Helvetica, Arial, sans-serif'; g.fillText('Optima', W / 2, H / 2 + 4);
});
const texGERoundel = (col = '#7e93ad') => canvasTex(256, 256, (g, W) => {
  g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 12;
  g.beginPath(); g.arc(W / 2, W / 2, 112, 0, Math.PI * 2); g.stroke();
  g.font = 'italic 118px Georgia, "Times New Roman", serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('GE', W / 2 + 2, W / 2 + 8);
});
const texWarn = () => canvasTex(256, 96, (g, W, H) => {
  g.fillStyle = '#f4d23c'; g.fillRect(0, 0, 118, H); g.fillStyle = '#f2f2ee'; g.fillRect(124, 0, W - 124, H);
  g.fillStyle = '#1d1d1d'; g.beginPath(); g.moveTo(59, 14); g.lineTo(100, 82); g.lineTo(18, 82); g.closePath(); g.fill();
  g.fillStyle = '#f4d23c'; g.font = 'bold 50px Arial'; g.textAlign = 'center'; g.fillText('!', 59, 76);
  g.fillStyle = '#5a5f63'; for (let i = 0; i < 5; i++) g.fillRect(134, 14 + i * 15, 104 - (i % 2) * 22, 6);
});
const texPatientIcon = () => canvasTex(96, 64, (g, W, H) => {
  g.strokeStyle = '#c8737e'; g.fillStyle = '#c8737e'; g.lineWidth = 5;
  g.beginPath(); g.arc(W / 2, 24, 9, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(W / 2 - 18, H - 10); g.quadraticCurveTo(W / 2, 30, W / 2 + 18, H - 10); g.stroke();
});
const texAquilion = () => canvasTex(512, 200, (g, W) => {
  g.fillStyle = '#2f4f8e'; g.textBaseline = 'alphabetic';
  g.font = 'italic 48px Georgia, "Times New Roman", serif'; g.textAlign = 'right'; g.fillText('Precision', W - 40, 66);
  g.font = 'italic bold 104px Georgia, "Times New Roman", serif'; g.textAlign = 'center'; g.fillText('Aquilion', W / 2, 160);
});
const texCanonWord = () => canvasTex(256, 64, (g, W, H) => {
  g.fillStyle = '#8b9095'; g.font = 'bold 44px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('Canon', W / 2, H / 2 + 2);
});
// The detector arc's face: dark modules with light seams (repeated round the arc).
const texModules = () => {
  const t = canvasTex(64, 64, (g, W, H) => {
    g.fillStyle = '#2a3036'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#4b555f'; g.fillRect(0, 0, 3, H); g.fillRect(0, 30, W, 2);
    g.fillStyle = '#39424b'; for (let x = 8; x < W; x += 8) g.fillRect(x, 0, 1, H);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(18, 1); return t;
};

// ---- the bore, its window and the cavity behind it (both vendors) ----
function buildBore(shell, E, o) {
  const { ISO_Y, BORE_R } = E;
  const cyl = (z0, z1, m) => mesh(alongZ(new THREE.CylinderGeometry(BORE_R, BORE_R, z0 - z1, 96, 1, true)), m, 0, ISO_Y, (z0 + z1) / 2);
  const liner = o.liner.clone(); liner.side = THREE.DoubleSide;
  if (o.zThroat > Z_WIN_F + 0.01) shell.add(cyl(o.zThroat, Z_WIN_F, liner));
  if (o.zBack < Z_WIN_B - 0.01) shell.add(cyl(Z_WIN_B, o.zBack, liner));
  // the window: a translucent inner cover, seen from the bore (its inside face)
  const win = cyl(Z_WIN_F, Z_WIN_B, new THREE.MeshStandardMaterial({ color: o.window, transparent: true, opacity: 0.4,
    roughness: 0.25, metalness: 0, side: THREE.BackSide, depthWrite: false, emissive: 0x1a1d20 }));
  win.renderOrder = 2; win.castShadow = false; shell.add(win);
  const seam = mat(o.seam, 0.45, 0.1);
  for (const z of [Z_WIN_F, Z_WIN_B]) shell.add(mesh(new THREE.TorusGeometry(BORE_R + 0.05, 0.32, 6, 96), seam, 0, ISO_Y, z));
  // the cavity the rotor turns in: dark walls, open only toward the window
  shell.add(lathe([[BORE_R + 0.1, Z_WIN_F - 0.05], [o.rCav, Z_WIN_F - 0.05], [o.rCav, Z_WIN_B + 0.05], [BORE_R + 0.1, Z_WIN_B + 0.05]],
    mat(0x262c32, 0.85, 0.15, { side: THREE.DoubleSide }), 64, ISO_Y));
}

// ---- the rotor (spins about z in the cavity): tube + collimator at the top (angle 0), the
// detector arc opposite, generators and cooling between, all on one disc ----
function buildRotor(E, rCav) {
  const { ISO_Y, BORE_R } = E, D = ROTOR_D;
  const spin = new THREE.Group(); spin.position.set(0, ISO_Y, ROTOR_Z);
  // (a little self-light: the cavity is shut from the room, and the parts must still read
  // through the window as they pass)
  const M = { alu: mat(0xa9b1b9, 0.4, 0.5, { side: THREE.DoubleSide, emissive: 0x23272b }), dark: mat(0x48505a, 0.5, 0.3, { emissive: 0x15181b }),
    tube: mat(0xe2e6e9, 0.3, 0.4, { emissive: 0x3a3d40 }), tank: mat(0x7a8693, 0.45, 0.3, { emissive: 0x1f2328 }),
    pcb: mat(0x3a7556, 0.55, 0.15, { emissive: 0x10261a }), band: mat(0x59626c, 0.5, 0.4, { emissive: 0x15181b }) };
  // the disc, at the back of the cavity
  spin.add(mesh(new THREE.RingGeometry(BORE_R + 1.5, rCav - 1.2, 72, 1), M.alu, 0, 0, -D / 2));
  // placement round the disc: angle phi from the BOTTOM (detector side), the part's local +y
  // pointing at the axis
  const at = (o, r, phi) => { o.position.set(r * Math.sin(phi), -r * Math.cos(phi), 0); o.rotation.z = phi; spin.add(o); return o; };
  // the tube: a housing along z, the collimator and the beam port toward the axis
  const tube = new THREE.Group();
  tube.add(mesh(alongZ(new THREE.CylinderGeometry(5.6, 5.6, D - 1.5, 24)), M.tube));
  for (const z of [-(D / 2 - 1.4), D / 2 - 1.4]) tube.add(mesh(alongZ(new THREE.CylinderGeometry(6.05, 6.05, 1.3, 24)), M.band, 0, 0, z));
  tube.add(mesh(rbox(10, 3.4, 8.4, 0.5), M.dark, 0, 7.2, 0));
  const beam = mesh(new THREE.PlaneGeometry(1.4, 6.4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffc766 }), 0, 8.95, 0);
  beam.visible = false; tube.add(beam);
  at(tube, BORE_R + 12.6, Math.PI);
  // the detector arc (its face toward the tube), modules and data electronics behind it
  const rD = BORE_R + 4.6;
  spin.add(mesh(alongZ(new THREE.CylinderGeometry(rD, rD, D - 2, 28, 1, true, -0.62, 1.24)),
    new THREE.MeshStandardMaterial({ map: texModules(), roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide })));
  spin.add(mesh(alongZ(new THREE.CylinderGeometry(rD + 2.6, rD + 2.6, D - 2, 28, 1, true, -0.66, 1.32)), mat(0x56606a, 0.5, 0.35, { side: THREE.DoubleSide, emissive: 0x15181b })));
  for (let i = 0; i < 7; i++) at(new THREE.Mesh(rbox(5.6, 2.6, D - 3.5, 0.4), M.pcb), rD + 5.4, (i - 3) * 0.17);
  // the high-voltage generators either side, the cooling unit and a counterweight above them
  for (const s of [-1, 1]) {
    at(new THREE.Mesh(rbox(13, 8, D - 3, 1), M.tank), BORE_R + 11, s * 1.72);
    at(new THREE.Mesh(rbox(8, 6, D - 4, 0.8), M.dark), BORE_R + 10, s * 2.42);
  }
  return { spin, beam };
}

// ============================================================================ GE Optima CT660
function buildGE(shell, E) {
  const { ISO_Y, BORE_R, FLOOR_Y, scr } = E, FACE = E.FRONT_Z + 3;
  const HW = 112, TOP = ISO_Y + 92, BOT = FLOOR_Y + 12, RC = 40, DISH = 64, BACK = -72;
  const M = {
    cover: plastic(0xf2f4f5), side: plastic(0x8e9eb2, 0.48, 0x262a30), trim: plastic(0xa3afbe, 0.5, 0x262a2e),
    base: mat(0x383e45, 0.62, 0.2), module: plastic(0xb0bbc8, 0.42, 0x2c3036), lip: plastic(0xbcc5cf, 0.4, 0x30343a),
    white: plastic(0xf7f8f9, 0.35), dark: mat(0x1e252c, 0.4, 0.3), keyGrey: mat(0x56616c, 0.4, 0.2),
    keyBlue: mat(0x2b5fb8, 0.32, 0.1, { emissive: 0x18418f, emissiveIntensity: 0.55 }), keyPale: plastic(0xd8e0ea, 0.35),
  };
  // the face outline: straight sides, big rounded top corners, a slight crown along the top
  const outline = (grow) => {
    const s = new THREE.Shape(), hw = HW + grow, t = TOP + grow, b = BOT - grow, rc = RC + grow;
    s.moveTo(-hw, b); s.lineTo(hw, b); s.lineTo(hw, t - rc);
    s.bezierCurveTo(hw, t - rc * 0.45, hw - rc * 0.45, t, hw - rc, t);
    s.quadraticCurveTo(0, t + 7, -hw + rc, t);
    s.bezierCurveTo(-hw + rc * 0.45, t, -hw, t - rc * 0.45, -hw, t - rc);
    s.lineTo(-hw, b);
    return s;
  };
  // white front cover; the blue-grey body behind it, a little larger so it frames the face
  shell.add(slab(circleHole(outline(0), ISO_Y, DISH), FACE, FACE - 30, 3, M.cover));
  shell.add(slab(circleHole(outline(1.6), ISO_Y, DISH), FACE - 22, BACK, 4, M.side));
  // the dish round the bore (proud of the cover's lip at its rim), down to the throat
  const dish = new THREE.SplineCurve([[66, 0.35], [63.5, 0.1], [61, -0.5], [56, -1.6], [50, -3.0], [44, -4.6], [40, -5.9], [37.6, -7.1], [36.2, -8.2]]
    .map(([r, d]) => new THREE.Vector2(r, d))).getPoints(36).map((p) => [p.x, FACE + p.y]);
  shell.add(lathe([...dish, [35.3, FACE - 9.2], [35, FACE - 10.2], [35, Z_WIN_F]], Object.assign(M.cover.clone(), { side: THREE.DoubleSide }), 128, ISO_Y));
  shell.add(mesh(new THREE.TorusGeometry(36.3, 0.95, 10, 128), M.lip, 0, ISO_Y, FACE - 8.4));   // the slim grey lip
  // the rear: the throat flares out to a blue-grey back
  shell.add(lathe([[BORE_R, BACK + 4], ...arc(BORE_R + 4, BACK + 4, 4, 180, 270), [DISH + 2, BACK - 0.2]], Object.assign(M.side.clone(), { side: THREE.DoubleSide }), 96, ISO_Y));
  buildBore(shell, E, { zThroat: Z_WIN_F, zBack: BACK + 4, rCav: 58, liner: M.cover, window: 0xdfe6ec, seam: 0xa9b3bd });
  // the light arc above the bore, on the dish
  const tab = new THREE.Shape(); tab.absarc(0, 0, 42, 62 * D2R, 118 * D2R, false); tab.absarc(0, 0, 39.2, 118 * D2R, 62 * D2R, true);
  const tabM = slab(tab, FACE - 4.6, FACE - 6.4, 0.4, M.lip, 24); tabM.position.y = ISO_Y; shell.add(tabM);
  // the display module: a tapering blue-grey housing hung from the top edge, the blue gantry
  // LCD (live), a two-lamp strip, a card slot and a lamp at its tip
  const mt = TOP + 5, mb = TOP - 42, tw = 21, bw = 14, mod = new THREE.Shape();
  mod.moveTo(-tw + 4, mt); mod.lineTo(tw - 4, mt); mod.quadraticCurveTo(tw, mt, tw - 0.3, mt - 4);
  mod.lineTo(bw + 0.5, mb + 7); mod.quadraticCurveTo(bw, mb, bw - 7, mb);
  mod.lineTo(-bw + 7, mb); mod.quadraticCurveTo(-bw, mb, -bw - 0.5, mb + 7);
  mod.lineTo(-tw + 0.3, mt - 4); mod.quadraticCurveTo(-tw, mt, -tw + 4, mt);
  shell.add(slab(mod, FACE + 6, FACE - 4, 1.6, M.module, 12));
  shell.add(mesh(rbox(27.4, 21, 1, 1.4), M.dark, 0, TOP - 12, FACE + 6.2));
  const lcd = screen(scr.top.tex, 25.4, 19); lcd.position.set(0, TOP - 12, FACE + 6.75); shell.add(lcd);
  shell.add(mesh(rbox(15, 3.4, 0.8, 0.8), M.dark, 0, TOP - 27.5, FACE + 6.1));
  [[-3.5, 0x57e089, 0x2fae5c], [3.5, 0xffb347, 0xc77a18]].forEach(([x, c, e]) =>
    shell.add(mesh(dome(0.55, 10), mat(c, 0.3, 0, { emissive: e, emissiveIntensity: 0.9 }), x, TOP - 27.5, FACE + 6.5)));
  shell.add(mesh(rbox(11, 1.1, 0.6, 0.5), M.dark, 0, TOP - 33, FACE + 6));
  shell.add(mesh(dome(0.6, 10), mat(0xf4f8ff, 0.3, 0, { emissive: 0xd8e6ff, emissiveIntensity: 0.7 }), 0, TOP - 38.5, FACE + 6));
  // the keypads either side of the bore: grey surround, white face, the live timer LCD and two
  // dark keys along the top, a ring of blue keys round a centre key
  for (const s of [-1, 1]) {
    const kp = new THREE.Group(); kp.position.set(s * 84, ISO_Y + 16, FACE); shell.add(kp);
    kp.scale.setScalar(1.15);
    kp.add(mesh(rbox(17, 21.5, 1.6, 3.2), M.lip, 0, 0, 0.3));
    kp.add(mesh(rbox(15.6, 20, 1.6, 2.7), M.white, 0, 0, 0.75));
    kp.add(mesh(rbox(7.8, 3.1, 0.6, 0.45), M.dark, -2.4, 6.8, 1.65));
    const t = screen(scr.timer.tex, 7, 2.4); t.position.set(-2.4, 6.8, 1.98); kp.add(t);
    for (const x of [3.6, 6.1]) kp.add(mesh(dome(0.78, 12), M.keyGrey, x, 6.8, 1.5));
    for (let i = 0; i < 8; i++) { const a = (i / 8 + 1 / 16) * Math.PI * 2; kp.add(mesh(dome(0.92, 12), M.keyBlue, Math.cos(a) * 4.4, -1.4 + Math.sin(a) * 4.4, 1.5)); }
    kp.add(mesh(dome(1.6, 14), M.keyPale, 0, -1.4, 1.5));
    for (const x of [-5.4, 5.4]) kp.add(mesh(dome(0.72, 10), M.keyBlue, x, -7.9, 1.5));
    // the patient-indicator pill above, an oval moulding below
    const pill = new THREE.Group(); pill.position.set(s * 84, ISO_Y + 40, FACE); shell.add(pill);
    pill.add(mesh(rbox(8.2, 4.4, 1.2, 2.1), M.lip, 0, 0, 0.2));
    pill.add(mesh(rbox(7.2, 3.4, 1.2, 1.6), M.white, 0, 0, 0.6));
    const ic = decal(texPatientIcon(), 2.6, 1.75); ic.position.set(0, 0, 1.22); pill.add(ic);
    shell.add(mesh(rbox(7.6, 3.4, 0.8, 1.6), plastic(0xe1e6ea, 0.45), s * 84, ISO_Y - 14, FACE + 0.15));
  }
  // badging and the rating labels
  const opt = decal(texOptima(), 30, 7.5); opt.position.set(-68, ISO_Y + 56, FACE + 0.05); shell.add(opt);
  const ge = decal(texGERoundel(), 12, 12); ge.position.set(70, ISO_Y + 56, FACE + 0.05); shell.add(ge);
  const wl = decal(texWarn(), 12, 4.5); wl.position.set(88, BOT + 10, FACE + 0.05); shell.add(wl);
  // the plinth: a blue-grey trim band on a dark base
  shell.add(mesh(rbox(2 * HW + 10, 6, FACE + 2 - BACK + 2, 2), M.base, 0, FLOOR_Y + 3, (FACE + 2 + BACK - 2) / 2));
  shell.add(mesh(rbox(2 * HW + 6, 7, FACE - BACK, 2.5), M.trim, 0, FLOOR_Y + 9.5, (FACE + BACK) / 2));
  return { rCav: 58 };
}

// ======================================================================= Canon Aquilion Precision
function buildCanon(shell, E) {
  const { ISO_Y, BORE_R, FLOOR_Y, scr } = E, FACE = E.FRONT_Z + 3;
  const R = 86, ZB = -55;
  const M = {
    cover: plastic(0xf2f0ea, 0.42, 0x5a5751), ring: plastic(0xb3c7d7, 0.38, 0x2a3036), panel: plastic(0xe3e1da, 0.48, 0x4e4c47),
    ear: plastic(0xefede6, 0.45, 0x58554f), dark: mat(0x20262c, 0.4, 0.3), seam: mat(0x9c9f9f, 0.5, 0.1),
    keyGrey: mat(0x8f989f, 0.4, 0.2), keyWhite: plastic(0xf8f9f9, 0.3), collar: plastic(0xdadbd8, 0.45),
    keyBlue: mat(0x8fd6ff, 0.3, 0, { emissive: 0x3aa6ff, emissiveIntensity: 0.95 }),
    red: mat(0xe0372b, 0.3, 0, { emissive: 0xc0281e, emissiveIntensity: 0.8 }),
  };
  // the tilting drum: ONE lathe from the rear throat round the outside to the front lip
  const prof = [[BORE_R, Z_WIN_B], [BORE_R, ZB + 4], ...arc(BORE_R + 4, ZB + 4, 4, 180, 270),
    [R - 6, ZB], ...arc(R - 6, ZB + 6, 6, 270, 360), [R, FACE - 6], ...arc(R - 6, FACE - 6, 6, 0, 90),
    [42, FACE], ...arc(42, FACE - 7, 7, 90, 180), [BORE_R, Z_WIN_F]];
  const drum = lathe(prof, Object.assign(M.cover.clone(), { side: THREE.DoubleSide }), 128, ISO_Y); shell.add(drum);
  buildBore(shell, E, { zThroat: Z_WIN_F, zBack: Z_WIN_B, rCav: 60, liner: M.cover, window: 0xe6edf2, seam: 0xb8c4cc });
  // the light blue-grey ring round the face, and the tilt seam along the drum's side
  shell.add(mesh(new THREE.TorusGeometry(R - 3.2, 1.7, 12, 160), M.ring, 0, ISO_Y, FACE - 0.9));
  shell.add(mesh(new THREE.TorusGeometry(R + 0.02, 0.3, 6, 160), M.seam, 0, ISO_Y, FACE - 22));
  // the stationary ear stands either side (their outer sides vented), and the plinth between
  for (const s of [-1, 1]) {
    const ear = new THREE.Shape(), X = (x) => s * x;
    ear.moveTo(X(46), FLOOR_Y); ear.lineTo(X(94), FLOOR_Y); ear.lineTo(X(94), ISO_Y + 4);
    ear.bezierCurveTo(X(94), ISO_Y + 40, X(82), ISO_Y + 64, X(52), ISO_Y + 71);
    ear.lineTo(X(44), ISO_Y + 62); ear.lineTo(X(46), FLOOR_Y);
    shell.add(slab(ear, 1, -70, 4, M.ear, 24));
    for (let c = 0; c < 2; c++) for (let r = 0; r < 4; r++)
      shell.add(mesh(rbox(0.8, 5.4, 8.4, 1), plastic(0xbabdc0, 0.5), s * 98.1, ISO_Y - 22 - r * 8.5, -38 - c * 12));
  }
  shell.add(mesh(rbox(96, 20, 64, 3), plastic(0xe6e3dc, 0.5), 0, FLOOR_Y + 10, -34));
  // the angled control panels, upper left and right between the bore and the ring: an LCD
  // read-out (live) and a cascade of grey, white and lit-blue keys round a four-way pad
  const PZ = FACE + 2.2;
  for (const s of [-1, 1]) {
    const P = (a, r) => [r * Math.cos(a * D2R), r * Math.sin(a * D2R)];
    const mx = ([x, y]) => [s < 0 ? x : -x, y];                     // the points are drawn for the left panel
    const A = mx(P(127, 80)), C = mx([-45.5, 7]), Dp = mx(P(125, 58));
    const sh = new THREE.Shape(); sh.moveTo(...Dp); sh.lineTo(...A);
    sh.absarc(0, 0, 80, (s < 0 ? 127 : 53) * D2R, (s < 0 ? 175 : 5) * D2R, s > 0); sh.lineTo(...C); sh.closePath();
    const pan = slab(sh, PZ, FACE - 0.4, 0.8, M.panel, 24); pan.position.y = ISO_Y; shell.add(pan);
    const g = new THREE.Group(); g.position.set(0, ISO_Y, PZ); g.scale.x = -s; shell.add(g);   // laid out for the LEFT panel
    g.add(mesh(rbox(13.2, 9.2, 0.6, 0.6), M.dark, -51, 45, 0.25));
    const lcd = screen(scr.panel.tex, 12.2, 8.2); lcd.position.set(-51, 45, 0.6); lcd.scale.x = -s; g.add(lcd);
    const key = (x, y, kind, r = 1.15) => {
      g.add(mesh(alongZ(new THREE.CylinderGeometry(r + 0.42, r + 0.6, 0.5, 20)), M.collar, x, y, 0.2));
      g.add(mesh(dome(r, 14), kind === 'b' ? M.keyBlue : kind === 'w' ? M.keyWhite : M.keyGrey, x, y, 0.4));
    };
    [[-62.5, 41, 'g'], [-61, 36.5, 'g'], [-56, 34.5, 'w'], [-51, 34.5, 'b'], [-46, 34.5, 'w'], [-50.5, 30, 'w'], [-45.5, 30, 'w'],
      [-48.5, 23.5, 'g'], [-66, 18, 'g'], [-61.5, 17, 'b'], [-68, 12, 'b'], [-63, 11.5, 'b']].forEach(([x, y, k]) => key(x, y, k));
    g.add(mesh(alongZ(new THREE.CylinderGeometry(4.6, 4.8, 0.6, 32)), M.collar, -57.5, 25, 0.25));     // the four-way pad
    key(-57.5, 28.4, 'b', 1.05); key(-60.9, 25, 'g', 1.05); key(-54.1, 25, 'g', 1.05); key(-57.5, 21.6, 'g', 1.05); key(-57.5, 25, 'w', 0.8);
    shell.add(mesh(dome(1.0, 12), M.red, s * 31, ISO_Y + 55, FACE + 0.1));           // the red indicator above
    // the oval grips either side of the bore
    shell.add(mesh(rbox(4.8, 8.2, 1, 2.3), M.panel, s * (BORE_R + 12.5), ISO_Y - 1, FACE + 0.2));
    shell.add(mesh(rbox(1.1, 3.6, 0.6, 0.5), M.dark, s * (BORE_R + 12.5), ISO_Y - 1, FACE + 0.75));
  }
  // the crown: the LCD screen (live) in a shield-shaped housing, the wordmark under it; the
  // Aquilion wordmark to its left, two icons and the green power lamp either side
  const t = ISO_Y + 79, mod = new THREE.Shape();
  mod.moveTo(-15, t - 4); mod.quadraticCurveTo(-15, t, -11, t); mod.lineTo(11, t); mod.quadraticCurveTo(15, t, 15, t - 4);
  mod.lineTo(15, t - 22); mod.bezierCurveTo(15, t - 32, 8, t - 35, 0, t - 35); mod.bezierCurveTo(-8, t - 35, -15, t - 32, -15, t - 22);
  mod.closePath();
  shell.add(slab(mod, FACE + 2.4, FACE - 1, 0.9, plastic(0xf6f5f1, 0.32), 16));
  shell.add(mesh(rbox(22.4, 16.8, 0.6, 0.9), mat(0x2a3540, 0.35, 0.2), 0, t - 11.5, FACE + 2.55));
  const top = screen(scr.top.tex, 21, 15.6); top.position.set(0, t - 11.5, FACE + 2.9); shell.add(top);
  const cw = decal(texCanonWord(), 8, 2); cw.position.set(0, t - 23.5, FACE + 2.45); shell.add(cw);
  const aq = decal(texAquilion(), 25, 9.8); aq.position.set(-29, ISO_Y + 63, FACE + 0.05); shell.add(aq);
  for (const y of [74, 70.5]) shell.add(mesh(dome(0.75, 12), M.keyGrey, -18.5, ISO_Y + y, FACE + 0.1));
  shell.add(mesh(dome(0.65, 12), mat(0x7de08f, 0.3, 0, { emissive: 0x3fbf5a, emissiveIntensity: 0.9 }), 18.5, ISO_Y + 74, FACE + 0.1));
  // the laser window (a dark slit) and a sensor below the screen, the tab at the bore's top
  const slit = mesh(rbox(1.4, 5.6, 0.8, 0.6), M.dark, 0, ISO_Y + 46, FACE + 0.2); slit.rotation.z = 0.16; shell.add(slit);
  shell.add(mesh(dome(0.6, 10), M.keyGrey, -5, ISO_Y + 45, FACE + 0.1));
  shell.add(mesh(rbox(12, 2.4, 0.8, 1), M.panel, 0, ISO_Y + 42.6, FACE + 0.2));
  return { rCav: 60 };
}

/* The gantry for `look.v` ('ge' | 'canon'). E = { ISO_Y, BORE_R, FRONT_Z, FLOOR_Y, scr } where scr
   holds the live screens ({ top, timer, panel }, each { tex }). Returns the bare framing ring for
   the planning PoVs, the shell (every cover, the cavity and the rotor) and the rotor itself. */
export function buildGantryModel(look, E) {
  const { ISO_Y, BORE_R, FRONT_Z } = E;
  const ring = mesh(new THREE.TorusGeometry(BORE_R + 2, 2, 16, 80), mat(look.v === 'canon' ? 0xbcd2e0 : 0x8ea3b5, 0.5, 0.4), 0, ISO_Y, FRONT_Z - 2);
  const shell = new THREE.Group();
  const { rCav } = look.v === 'canon' ? buildCanon(shell, E) : buildGE(shell, E);
  const { spin, beam } = buildRotor(E, rCav);
  shell.add(spin);                                  // inside the cavity: shown and hidden with the covers
  shell.traverse((o) => { if (o.isMesh && !o.material.transparent) { o.castShadow = true; o.receiveShadow = true; } });
  return { ring, shell, spin, setBeam: (on) => { beam.visible = !!on; } };
}

/* The couch for `look.v`: the cradle and its pad into `couch` (it moves; its pad's top centre is
   the couch top, local y 0), the table body and pedestal into `couchBase` (world z 82). The table
   body rides a lift group that setTop(y) raises to the couch top (world y): the GE column slides
   in its sleeve, the Canon bellows stretch. E = { ISO_Y, FLOOR_Y, spec, travelHalf, top }. */
export function buildCouchModel(couch, couchBase, look, E) {
  const { FLOOR_Y, spec, travelHalf } = E, canon = look.v === 'canon';
  const L = spec.cradleU, W = spec.cradleWU, hw = W / 2;
  const white = plastic(0xf3f4f4, 0.38), grey = plastic(canon ? 0xbcc2c6 : 0xb7c0ca, 0.48, 0x1e2124);
  // ---- the cradle (moves): a shallow trough, its rounded ends running z -50 .. L - 50 ----
  const cr = new THREE.Shape();
  cr.moveTo(-hw, -0.9); cr.quadraticCurveTo(0, -3.1, hw, -0.9);                     // the trough (-2.0 on the centre line)
  cr.quadraticCurveTo(hw + 0.4, -3.4, hw - 1.6, -4.6); cr.quadraticCurveTo(0, -7.0, -hw + 1.6, -4.6);
  cr.quadraticCurveTo(-hw - 0.4, -3.4, -hw, -0.9);
  couch.add(mesh(new THREE.ExtrudeGeometry(cr, { depth: L - 3, bevelEnabled: true, bevelThickness: 1.5, bevelSize: 0.6, bevelSegments: 3, curveSegments: 10 }), white, 0, 0, -48.5));
  // the pad: its top centre line IS the couch top (y 0), its edges a little proud
  const pw = 19.5, pad = new THREE.Shape(), padZ0 = canon ? -41 : -46;
  pad.moveTo(-pw, 0.6); pad.quadraticCurveTo(0, -0.6, pw, 0.6);
  pad.quadraticCurveTo(pw + 1.2, 0.1, pw - 0.2, -1.3); pad.quadraticCurveTo(0, -3.4, -pw + 0.2, -1.3);
  pad.quadraticCurveTo(-pw - 1.2, 0.1, -pw, 0.6);
  couch.add(mesh(new THREE.ExtrudeGeometry(pad, { depth: L - 62 - (padZ0 + 46), bevelEnabled: true, bevelThickness: 1.2, bevelSize: 0.5, bevelSegments: 3, curveSegments: 10 }),
    mat(canon ? 0xd3d8dc : 0xd9d6cc, 0.85, 0), 0, 0, padZ0 + 1.2));
  if (canon) couch.add(mesh(rbox(W - 6, 2.4, 7, 1), mat(0xa9afb4, 0.5, 0.1), 0, -2.3, -45));   // the grey head-end holder
  couch.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // ---- the table body (lifts) and its pedestal (static); couchBase-local z = world z - 82 ----
  const foot = L - 50;                                        // the cradle's foot (couch-local z)
  const zF = 30 - 82, zE = foot + travelHalf - 82 + 1.5;      // body: from world z 30 to just past the foot's full reach
  const bodyLen = zE - zF, bodyZ = (zF + zE) / 2;
  const lift = new THREE.Group(); couchBase.add(lift);
  const colZ = canon ? 70 : 72;                               // the column under the body (local z)
  let bellows = null, H0 = 1;
  if (!canon) {
    lift.add(mesh(rbox(52, 13, bodyLen, 4), white, 0, -12.5, bodyZ));
    lift.add(mesh(rbox(46, 6, bodyLen - 8, 2), grey, 0, -21, bodyZ));
    lift.add(mesh(rbox(36, 0.5, bodyLen - 6, 0.25), plastic(0xdde2e7, 0.5), 0, -6.1, bodyZ));
    for (const s of [-1, 1]) for (const y of [-10.5, -14.5]) lift.add(mesh(rbox(0.5, 0.5, bodyLen - 16, 0.2), mat(0x9aa3ad, 0.5, 0.1), s * 26, y, bodyZ));
    // the foot end: a raised end cap with the handle hoop and the roundel
    lift.add(mesh(rbox(56, 15, 15, 5), white, 0, -6.5, zE + 7.5));
    const hoop = mesh(new THREE.TorusGeometry(10.5, 1.3, 10, 36, Math.PI), mat(0xcdd4da, 0.25, 0.75), 0, 1, zE + 7.5); lift.add(hoop);
    const rd = decal(texGERoundel('#8a9bb0'), 7, 7); rd.position.set(0, -7, zE + 15.05); lift.add(rd);
    // the inner column (lifts with the body) in the dark tapered sleeve, on the dark base
    lift.add(mesh(rbox(30, 37, 40, 2), plastic(0xcfd5db, 0.45), 0, -40.5, colZ));
    couchBase.add(mesh(taperBox(42, 36, 56, 3, 0.84), mat(0x3b4148, 0.55, 0.25), 0, FLOOR_Y + 33, colZ));
    const bs = new THREE.Shape(); bs.moveTo(-62, 0); bs.lineTo(62, 0); bs.lineTo(46, 15); bs.lineTo(-40, 15); bs.closePath();
    const bg = new THREE.ExtrudeGeometry(bs, { depth: 56, bevelEnabled: true, bevelThickness: 2, bevelSize: 2, bevelSegments: 3 });
    bg.translate(0, 0, -28); bg.rotateY(-Math.PI / 2);         // the profile drawn along z (toward the foot), 60 wide
    couchBase.add(mesh(bg, mat(0x2f343a, 0.6, 0.2), 0, FLOOR_Y, colZ));
    couchBase.add(mesh(rbox(16, 2, 8, 1), mat(0x2f343a, 0.6, 0.2), 0, FLOOR_Y + 1, colZ - 70));   // the foot pedals
    for (const s of [-1, 1]) couchBase.add(mesh(rbox(6, 0.6, 5.4, 0.25), mat(0x3f6290, 0.45, 0.1), s * 3.8, FLOOR_Y + 2.1, colZ - 70));
  } else {
    lift.add(mesh(rbox(56, 15, bodyLen + 8, 5), white, 0, -13.5, bodyZ + 4));
    lift.add(mesh(rbox(56.8, 3.2, bodyLen - 6, 1.2), grey, 0, -9.5, bodyZ + 4));
    lift.add(mesh(rbox(50, 4, bodyLen - 6, 1.5), plastic(0xdcdbd5, 0.5), 0, -22.5, bodyZ + 4));
    // the grey base plate, a floor rail toward the gantry
    couchBase.add(mesh(rbox(68, 7, 118, 6), mat(0xc4c6c6, 0.5, 0.1), 0, FLOOR_Y + 3.5, colZ));
    couchBase.add(mesh(rbox(64, 1.2, 114, 5), plastic(0xdcdddc, 0.5), 0, FLOOR_Y + 7.4, colZ));
    couchBase.add(mesh(rbox(12, 2.2, 64, 1), mat(0xbfc1c2, 0.5, 0.1), 0, FLOOR_Y + 1.1, colZ - 59 - 32));
    // the bellows: soft pleats round a core, stretched between the plate and the body
    bellows = new THREE.Group(); bellows.position.set(0, FLOOR_Y + 8, colZ); couchBase.add(bellows);
    const ps = new THREE.Shape(), pr = 22, pw2 = 25, pd2 = 35;
    ps.moveTo(-pw2 + pr, -pd2); ps.lineTo(pw2 - pr, -pd2); ps.quadraticCurveTo(pw2, -pd2, pw2, -pd2 + pr); ps.lineTo(pw2, pd2 - pr);
    ps.quadraticCurveTo(pw2, pd2, pw2 - pr, pd2); ps.lineTo(-pw2 + pr, pd2); ps.quadraticCurveTo(-pw2, pd2, -pw2, pd2 - pr);
    ps.lineTo(-pw2, -pd2 + pr); ps.quadraticCurveTo(-pw2, -pd2, -pw2 + pr, -pd2);
    const pleat = new THREE.ExtrudeGeometry(ps, { depth: 1.4, bevelEnabled: true, bevelThickness: 2.4, bevelSize: 2.6, bevelSegments: 3, curveSegments: 10 });
    pleat.rotateX(-Math.PI / 2);
    const N = 7, pitch = 9.6, pm = plastic(0xf4f3ee, 0.55, 0x4a4945); H0 = N * pitch;
    for (let i = 0; i < N; i++) bellows.add(mesh(pleat, pm, 0, 3 + i * pitch, 0));
    bellows.add(mesh(rbox(48, H0, 66, 10), plastic(0xd9d7cf, 0.6), 0, H0 / 2, 0));
  }
  couchBase.traverse((o) => { if (o.isMesh && !o.material.transparent) { o.castShadow = true; o.receiveShadow = true; } });
  const setTop = (y) => {
    lift.position.y = y;
    if (bellows) bellows.scale.y = Math.max(0.3, (y - 23 - (FLOOR_Y + 8)) / H0);   // up to the body's underside
  };
  setTop(E.top);
  return { setTop };
}
