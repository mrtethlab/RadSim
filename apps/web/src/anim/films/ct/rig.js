/* CT FILM: the 3D sets. The app's own scanner (ct.js buildCTRig: the gantry's covers, its panels,
   the couch and its pedestal) in a room, the chest/abdomen/pelvis patient on the couch, and, under
   the covers, the rotating frame the app does not model: the tube in its housing, the bowtie and
   the collimator, the detector arc and its electronics, the generator, the cooling, the slip ring
   and its brushes, the stationary frame. Units cm (the app's world units). Seen from the couch's
   end (+z) the frame turns counter-clockwise for a positive angle; at angle 0 the tube is at the
   top. The patient lies supine, head first into the bore (toward -z): their right at -x. */
import * as THREE from 'three';
import { buildCTRig } from '../../../ct.js';
import { std, mesh, beamCone, glowMat, setOpacity } from '../../kit/stage.js';
import { buildTubeInsert } from '../xray/tube.js';
import { capMeshFrame } from '../capFrame.js';

export const ZP = -10;                 // the scan plane (z), mid-gantry
export const ZL = 32;                  // the external lasers' plane, in front of the gantry
export const F = 57;                   // focal spot to isocentre, cm
export const SID = 100;                // focal spot to detector, cm
export const HALF = 26 * Math.PI / 180;  // half the fan angle: a 50 cm scan field
export const NMOD = 24;                // detector modules across the arc
export const BACK = 15.8;              // the patient's back below their centre (the mesh's half depth)
export const PZ = -4.4;                // the patient's centre on the couch (couch-local z)

export async function buildSets(api) {
  const { scene } = api;
  const rig = buildCTRig(THREE);
  const ISO_Y = rig.ISO_Y, FLOOR_Y = rig.FLOOR_Y;
  const COUCH_Y = ISO_Y - BACK;        // the couch top with the patient's centre at the isocentre
  rig.setCouchTop(COUCH_Y);            // the table body under it (couchBase-local, lifted with it below)
  const room = new THREE.Group(); scene.add(room);
  room.add(rig.gantry, rig.couch, rig.couchBase);
  rig.spin.visible = false; rig.ring.visible = false;
  rig.gantry.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  rig.couch.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  // the room: a floor, a back wall
  const floor = mesh(new THREE.PlaneGeometry(900, 900), std(0x3a4148, 0.85, 0.05), 0, FLOOR_Y, 60);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; room.add(floor);
  const grid = new THREE.GridHelper(900, 30, 0x4a525b, 0x434b53); grid.position.set(0, FLOOR_Y + 0.05, 60); room.add(grid);
  const wall = mesh(new THREE.PlaneGeometry(900, 320), std(0x2b333b, 0.9, 0.0), 0, FLOOR_Y + 160, -160); room.add(wall);
  const wallL = mesh(new THREE.PlaneGeometry(900, 320), std(0x283038, 0.9, 0.0), -330, FLOOR_Y + 160, 290); wallL.rotation.y = Math.PI / 2; room.add(wallL);
  // the console's window in the wall (the control room behind)
  const win = mesh(new THREE.PlaneGeometry(150, 70), new THREE.MeshStandardMaterial({ color: 0x101a24, emissive: 0x0b2436, emissiveIntensity: 0.35, roughness: 0.1 }), -190, FLOOR_Y + 150, -159);
  room.add(win);

  // ---- the patient: skin, bone and gut meshes, scaled mm -> cm and turned supine, head to -z
  const pat = new THREE.Group(); pat.position.set(0, BACK, PZ); rig.couch.add(pat);
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd9a183, roughness: 0.62, metalness: 0, side: THREE.DoubleSide });
  const boneMat = std(0xeee4c8, 0.5, 0.05);
  const giMat = std(0xc88a6a, 0.55, 0.0);
  const parts = {};
  const load = (name, mat) => api.loadGlb(`models/chestabdopelvis/chestabdopelvis_${name}.glb`).then((g) => {
    capMeshFrame(g);
    g.scale.set(-0.1, 0.1, -0.1);
    g.traverse((o) => { if (o.isMesh) { if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); o.material = mat; o.castShadow = true; o.receiveShadow = true; } });
    pat.add(g); parts[name] = g;
  }).catch(() => null);
  await Promise.all([load('skin', skinMat), load('bone', boneMat), load('gi', giMat)]);
  if (parts.gi) parts.gi.visible = false;
  // a stand-in for the body's bounds (8 corners: cheap to measure every frame while it moves)
  const patBox = mesh(new THREE.BoxGeometry(38, 30, 71), new THREE.MeshBasicMaterial()); patBox.visible = false; pat.add(patBox);

  // ---- under the covers
  const inner = new THREE.Group(); inner.position.set(0, ISO_Y, 0); room.add(inner);
  const M = {
    al: std(0xc3cad2, 0.5, 0.25), alDark: std(0x9aa2aa, 0.55, 0.25), dark: std(0x3a414a, 0.6, 0.2),
    housing: std(0xe3e6ea, 0.4, 0.1), copper: std(0xd08850, 0.35, 0.45), pcb: std(0x2a8048, 0.6, 0.1),
    chip: std(0x1c2024, 0.4, 0.2), tank: std(0x5b6773, 0.45, 0.25), cable: std(0x202429, 0.7, 0.1),
    tungsten: std(0x6a7078, 0.35, 0.5), insul: std(0x4a3a2e, 0.7, 0.05), carbon: std(0x262626, 0.8, 0.1),
    scint: new THREE.MeshStandardMaterial({ color: 0xdde8c4, emissive: 0x1d2a12, roughness: 0.5 }),
    shellGlass: new THREE.MeshStandardMaterial({ color: 0xdfe6ec, transparent: true, opacity: 0.18, depthWrite: false, roughness: 0.3, side: THREE.DoubleSide }),
  };
  // stationary frame (behind the disc): a cast ring, the main bearing, the drive motor and belt
  const stat = new THREE.Group(); stat.position.z = ZP; inner.add(stat);
  const annulus = (r0, r1, depth, mat, z) => {
    const s = new THREE.Shape(); s.absarc(0, 0, r1, 0, Math.PI * 2, false);
    const h = new THREE.Path(); h.absarc(0, 0, r0, 0, Math.PI * 2, true); s.holes.push(h);
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 96 });
    const m = new THREE.Mesh(g, mat); m.position.z = z; return m;
  };
  stat.add(annulus(40, 88, 4, M.alDark, -28));
  stat.add(mesh(new THREE.TorusGeometry(41, 1.4, 12, 96), M.al, 0, 0, -24.5));
  const motor = mesh(new THREE.CylinderGeometry(5, 5, 11, 24).rotateX(Math.PI / 2), M.dark, 22, -80, -21);
  stat.add(motor);
  stat.add(mesh(new THREE.TorusGeometry(82.4, 0.55, 6, 160), M.cable, 0, 0, -19.5));
  // the brush block: carbon brushes on spring arms, one per ring, at the lower right
  const brushes = new THREE.Group(); stat.add(brushes);
  const BA = 215 * Math.PI / 180;
  brushes.rotation.z = BA;
  brushes.add(mesh(new THREE.BoxGeometry(5, 15, 3), M.insul, 0, 49.5, -25.2));
  const brushTips = [];
  for (let k = 0; k < 6; k++) {
    const r = 43.5 + k * 2;
    const b = mesh(new THREE.BoxGeometry(1.3, 1.1, 1.6), M.carbon, 0, r, -23.4); brushes.add(b); brushTips.push(b);
    brushes.add(mesh(new THREE.BoxGeometry(0.3, 0.3, 1.8), M.copper, 0.9, r, -24.2));
  }
  // the rotating frame
  const rot = new THREE.Group(); rot.position.z = ZP; inner.add(rot);
  const disc = annulus(40, 82, 3, M.al, -21); rot.add(disc);
  // slip rings on the disc's back, the data link's ring outside them
  const rings = new THREE.Group(); rot.add(rings);
  rings.add(annulus(42, 57, 1.1, M.insul, -22.1));
  for (let k = 0; k < 6; k++) rings.add(mesh(new THREE.TorusGeometry(43.5 + k * 2, 0.45, 8, 140), M.copper, 0, 0, -22.4));
  const linkMat = glowMat(0x35d0ff); linkMat.color.set(0x1d4a5a); linkMat.emissiveIntensity = 0.5;
  const link = mesh(new THREE.TorusGeometry(55.6, 0.6, 8, 140), linkMat, 0, 0, -22.4); rings.add(link);

  // the tube: housing along z (the anode-cathode axis along the patient), focal spot at radius F
  const tube = new THREE.Group(); rot.add(tube);
  const TH_Y = 61, TH_R = 8.5;
  const housing = mesh(new THREE.CylinderGeometry(TH_R, TH_R, 32, 40).rotateX(Math.PI / 2), M.housing, 0, TH_Y, 1); tube.add(housing);
  for (const z of [-16, 18]) tube.add(mesh(new THREE.CylinderGeometry(TH_R + 0.6, TH_R + 0.6, 2.2, 40).rotateX(Math.PI / 2), M.alDark, 0, TH_Y, z));
  const port = mesh(new THREE.BoxGeometry(5, 1, 6), new THREE.MeshStandardMaterial({ color: 0x9fb7c8, roughness: 0.15, transparent: true, opacity: 0.6 }), 0, TH_Y - TH_R - 0.2, 0); tube.add(port);
  // the HV connectors at the ends, cables down to the generator tanks
  for (const z of [-15, 17]) tube.add(mesh(new THREE.CylinderGeometry(1.6, 1.6, 4, 16), M.dark, 0, TH_Y + TH_R + 1.5, z));
  const focal = mesh(new THREE.SphereGeometry(0.5, 12, 8), new THREE.MeshBasicMaterial({ color: 0xfff1b0, transparent: true, opacity: 0 }), 0, F, 0);
  rot.add(focal);
  // the x-ray insert from the X-ray film, turned so its axis runs along z (shown in the tube step)
  const T = buildTubeInsert();
  T.housing.visible = false; T.port.visible = false; T.filter.visible = false; T.coll.visible = false;
  T.g.position.set(0, F, 0); T.g.rotation.y = -Math.PI / 2; T.g.scale.setScalar(0.92);
  T.g.visible = false; rot.add(T.g);
  // collimator box under the port: the bowtie, the z jaws
  const coll = new THREE.Group(); rot.add(coll);
  const collBox = mesh(new THREE.BoxGeometry(16, 8, 13), M.shellGlass, 0, 48, 0); coll.add(collBox);
  const bt = new THREE.Shape();
  const bw = 5.2, tAt = (x) => 0.3 + 2.1 * (x / bw) ** 2;
  bt.moveTo(-bw, 0);
  for (let i = 0; i <= 40; i++) { const x = -bw + (i / 40) * 2 * bw; bt.lineTo(x, tAt(x)); }
  bt.lineTo(bw, 0); bt.lineTo(-bw, 0);
  const bowGeo = new THREE.ExtrudeGeometry(bt, { depth: 9, bevelEnabled: false }); bowGeo.translate(0, 0, -4.5);
  const bowtie = new THREE.Mesh(bowGeo, new THREE.MeshStandardMaterial({ color: 0xe9e2d0, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.88 }));
  bowtie.position.y = 49.3; coll.add(bowtie);
  const jaws = [-1, 1].map((s) => { const j = mesh(new THREE.BoxGeometry(13, 1.8, 4), M.tungsten, 0, 46, s * 3); coll.add(j); return j; });
  // the detector arc: modules facing the focal spot at SID, their electronics behind
  const det = new THREE.Group(); rot.add(det);
  const faceCv = document.createElement('canvas'); faceCv.width = 40; faceCv.height = 64;
  { const g = faceCv.getContext('2d'); g.fillStyle = '#dfe9c6'; g.fillRect(0, 0, 40, 64);
    g.fillStyle = '#6f7a5c'; for (let i = 0; i < 40; i += 3) g.fillRect(i, 0, 1, 64); for (let j = 0; j < 64; j += 4) g.fillRect(0, j, 40, 1); }
  const faceTex = new THREE.CanvasTexture(faceCv); faceTex.colorSpace = THREE.SRGBColorSpace; faceTex.magFilter = THREE.NearestFilter;
  const faceMat = new THREE.MeshStandardMaterial({ map: faceTex, emissive: 0xffffff, emissiveMap: faceTex, emissiveIntensity: 0.15, roughness: 0.5 });
  const modW = 2 * SID * Math.sin(HALF / NMOD) * 0.97;
  const WZ0 = 4 * SID / F;                                  // 40 mm at the isocentre, magnified at the detector
  const modules = [];
  for (let i = 0; i < NMOD; i++) {
    const ph = -HALF + (i + 0.5) * 2 * HALF / NMOD;
    const g = new THREE.Group();
    g.position.set(-SID * Math.sin(ph), F - SID * Math.cos(ph), 0);
    g.rotation.z = -ph;
    g.add(mesh(new THREE.BoxGeometry(modW, 2.4, WZ0 + 0.4), M.dark, 0, -1.25, 0));
    const face = mesh(new THREE.PlaneGeometry(modW * 0.98, WZ0), faceMat, 0, 0.01, 0); face.rotation.x = -Math.PI / 2; g.add(face);
    g.add(mesh(new THREE.BoxGeometry(modW * 0.9, 3.2, WZ0 * 0.9), M.pcb, 0, -4.2, 0));
    for (let k = 0; k < 3; k++) g.add(mesh(new THREE.BoxGeometry(modW * 0.5, 0.6, 1.2), M.chip, 0, -5.9, -2.5 + k * 2.5));
    det.add(g); modules.push(g);
  }
  // the generator: two high-voltage tanks either side, cables up to the tube's ends
  const gen = new THREE.Group(); rot.add(gen);
  const tanks = [-1, 1].map((s) => {
    const a = s * 100 * Math.PI / 180, r = 63;
    const g = new THREE.Group(); g.position.set(-r * Math.sin(a), r * Math.cos(a), 1); g.rotation.z = a;
    g.add(mesh(new THREE.BoxGeometry(20, 12, 22), M.tank));
    for (let k = 0; k < 7; k++) g.add(mesh(new THREE.BoxGeometry(18, 0.5, 0.5), M.alDark, 0, 6.3, -9 + k * 3));
    gen.add(g); return g;
  });
  const cableMat = M.cable;
  const cables = [];
  for (const [s, z] of [[-1, -15], [1, 17]]) {
    const a = s * 100 * Math.PI / 180, r = 63;
    const p0 = new THREE.Vector3(-r * Math.sin(a) * 0.9, r * Math.cos(a) * 0.9 + 6, z * 0.4);
    const pts = [p0, new THREE.Vector3(p0.x * 0.75, 40, z * 0.7), new THREE.Vector3(s * -14, 66, z), new THREE.Vector3(0, TH_Y + TH_R + 3, z)];
    const curve = new THREE.CatmullRomCurve3(pts);
    const c = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.9, 8), cableMat); rot.add(c);
    cables.push(curve);
  }
  // cooling: oil-to-air heat exchanger with its fan, beside the tube
  const cool = new THREE.Group(); rot.add(cool);
  { const a = 42 * Math.PI / 180, r = 62; cool.position.set(-r * Math.sin(a), r * Math.cos(a), 0); cool.rotation.z = a; }
  cool.add(mesh(new THREE.BoxGeometry(16, 9, 20), M.alDark));
  const fan = new THREE.Group(); fan.position.set(0, 4.8, 0); cool.add(fan);
  fan.add(mesh(new THREE.CylinderGeometry(6.5, 6.5, 0.6, 32), M.dark));
  for (let k = 0; k < 5; k++) { const b = mesh(new THREE.BoxGeometry(1.6, 0.3, 6), M.al, 0, 0.5, 0); b.rotation.y = k * Math.PI * 2 / 5; b.position.set(Math.sin(k * 1.2566) * 3, 0.5, Math.cos(k * 1.2566) * 3); fan.add(b); }
  const hoses = [];
  for (const z of [-6, 6]) {
    const p0 = new THREE.Vector3(-r42(0.85).x, r42(0.85).y, z), curve = new THREE.CatmullRomCurve3([p0, new THREE.Vector3(-20, 62, z), new THREE.Vector3(-TH_R + 0.5, TH_Y + 2, z)]);
    rot.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.7, 8), std(0x2d3a2a, 0.6, 0.1))); hoses.push(curve);
  }
  function r42(k) { const a = 42 * Math.PI / 180, r = 62 * k; return { x: r * Math.sin(a), y: r * Math.cos(a) }; }
  // the DAS cabinets either side of the arc, a control box opposite the cooling
  const das = new THREE.Group(); rot.add(das);
  for (const s of [-1, 1]) {
    const a = (180 + s * 42) * Math.PI / 180, r = 63;
    const g = new THREE.Group(); g.position.set(-r * Math.sin(a), r * Math.cos(a), 0); g.rotation.z = a;
    g.add(mesh(new THREE.BoxGeometry(18, 9, 18), M.dark));
    for (let k = 0; k < 4; k++) g.add(mesh(new THREE.BoxGeometry(16, 0.3, 3), M.pcb, 0, 4.7, -6.5 + k * 4.3));
    das.add(g);
  }
  { const a = -42 * Math.PI / 180, r = 62; const g = mesh(new THREE.BoxGeometry(14, 9, 16), M.tank); g.position.set(-r * Math.sin(a), r * Math.cos(a), 0); g.rotation.z = a; rot.add(g); }

  // the fan beam: a pyramid from the focal spot to the detector's face, in the frame's own axes
  const beam = beamCone(0x9d7bff, 0.16); rot.add(beam);
  const setBeam = (wIso, on = true) => {
    const wz = wIso * SID / F / 2, x = SID * Math.sin(HALF), y = F - SID * Math.cos(HALF);
    beam.userData.set([0, F, 0], [[-x, y, -wz], [x, y, -wz], [x, y, wz], [-x, y, wz]]);
    beam.visible = on;
    const gap = wIso * (F - 46) / F;
    jaws[0].position.z = -(gap / 2 + 2); jaws[1].position.z = gap / 2 + 2;
  };
  setBeam(4, false);

  // ---- the lasers (as the app projects them: red light through a line mask)
  const laser = (draw, pos, tgt) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 256; draw(cv.getContext('2d'), 256);
    const tex = new THREE.CanvasTexture(cv);
    const sl = new THREE.SpotLight(0xff2222, 0, 300, 0.55, 0.02, 0.0); sl.map = tex;
    sl.position.set(...pos); sl.target.position.set(...tgt); room.add(sl, sl.target); return sl;
  };
  const lineCookie = (vert) => (g, S) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, S, S); g.strokeStyle = '#fff'; g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke();
    if (vert) { g.beginPath(); g.moveTo(S / 2, S * 0.3); g.lineTo(S / 2, S * 0.7); g.stroke(); }
  };
  const lasers = [
    laser(lineCookie(true), [0, ISO_Y + 70, ZL], [0, ISO_Y, ZL]),
    laser(lineCookie(false), [70, ISO_Y, ZL], [0, ISO_Y, ZL]),
  ];
  lasers[0].shadow.camera.up.set(0, 0, -1);
  const setLasers = (k) => { for (const l of lasers) l.intensity = 9 * k; };

  // ---- the power injector, by the couch on the patient's left
  const inj = new THREE.Group(); inj.position.set(52, FLOOR_Y, 30); room.add(inj);
  const injWhite = std(0xe9ecef, 0.45, 0.1);
  inj.add(mesh(new THREE.CylinderGeometry(20, 22, 4, 5), M.dark, 0, 3, 0));
  for (let k = 0; k < 5; k++) { const a = k * 1.2566; inj.add(mesh(new THREE.SphereGeometry(2.2, 10, 8), M.dark, Math.cos(a) * 19, 1.5, Math.sin(a) * 19)); }
  inj.add(mesh(new THREE.CylinderGeometry(2.4, 2.4, 92, 16), M.al, 0, 50, 0));
  const injHead = new THREE.Group(); injHead.position.set(0, 104, 0); injHead.rotation.z = 0.35; inj.add(injHead);
  injHead.add(mesh(new THREE.BoxGeometry(14, 22, 26), injWhite, 0, 0, 0));
  const syr = [];
  for (const [z, col] of [[-6, 0xffd166], [6, 0xe6f4ff]]) {
    const barrel = mesh(new THREE.CylinderGeometry(3, 3, 20, 24), new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, roughness: 0.05, depthWrite: false }), 0, -18, z);
    const fluid = mesh(new THREE.CylinderGeometry(2.7, 2.7, 1, 24), new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0.85, roughness: 0.2 }), 0, -18, z);
    const plunger = mesh(new THREE.CylinderGeometry(2.8, 2.8, 1.2, 24), M.dark, 0, -9, z);
    injHead.add(barrel, fluid, plunger); syr.push({ fluid, plunger, z });
  }
  const injScreen = mesh(new THREE.PlaneGeometry(10, 7), new THREE.MeshStandardMaterial({ color: 0x0b3a5a, emissive: 0x1d6a9a, emissiveIntensity: 0.8 }), 7.1, 4, 0);
  injScreen.rotation.y = Math.PI / 2; injHead.add(injScreen);
  // the syringe's level: 0..1 full; the fluid column and the plunger follow
  const setSyringe = (i, full) => {
    const s = syr[i], L = 19 * Math.max(0.02, full);
    s.fluid.scale.y = L; s.fluid.position.y = -28 + L / 2; s.plunger.position.y = -28 + L + 0.6;
  };
  setSyringe(0, 1); setSyringe(1, 1);
  // the line from the head to the patient (its end follows the couch: set each frame)
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf4f0e0, transparent: true, opacity: 0.75, roughness: 0.3 });
  let lineMesh = null;
  const setLine = (endWorld) => {
    if (lineMesh) { room.remove(lineMesh); lineMesh.geometry.dispose(); }
    inj.updateMatrixWorld(true);
    const a = new THREE.Vector3(0, -30, 0).applyMatrix4(injHead.matrixWorld);
    const e = new THREE.Vector3(...endWorld);
    const curve = new THREE.CatmullRomCurve3([a, new THREE.Vector3(a.x - 4, a.y - 30, a.z - 5), new THREE.Vector3((a.x + e.x) / 2, e.y - 18, (a.z + e.z) / 2), new THREE.Vector3(e.x + 4, e.y - 2, e.z), e]);
    lineMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 60, 0.35, 6), lineMat); room.add(lineMesh);
    lineMesh.userData.curve = curve;
    return curve;
  };

  // ---- the dose phantom: 32 cm acrylic, five holes, a 10 cm pencil chamber
  const phantom = new THREE.Group(); phantom.position.set(0, ISO_Y, ZP); room.add(phantom);
  const pm = new THREE.MeshPhysicalMaterial({ color: 0xd6e6ee, roughness: 0.15, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
  phantom.add(mesh(new THREE.CylinderGeometry(16, 16, 15, 64).rotateX(Math.PI / 2), pm));
  const holes = [[0, 0], [0, 15], [15, 0], [0, -15], [-15, 0]].map(([x, y]) => { const h = mesh(new THREE.CylinderGeometry(0.65, 0.65, 15.2, 16).rotateX(Math.PI / 2), std(0x223038, 0.6, 0.1), x, y, 0); phantom.add(h); return h; });
  const chamber = new THREE.Group(); phantom.add(chamber);
  chamber.add(mesh(new THREE.CylinderGeometry(0.5, 0.5, 10, 16).rotateX(Math.PI / 2), std(0xd0d6dc, 0.3, 0.6), 0, 0, 0));
  chamber.add(mesh(new THREE.CylinderGeometry(0.42, 0.42, 14, 12).rotateX(Math.PI / 2), M.dark, 0, 0, 12));
  chamber.add(mesh(new THREE.CylinderGeometry(0.25, 0.25, 30, 8).rotateX(Math.PI / 2), M.cable, 0, 0, 33));
  phantom.visible = false;

  // ---- positioning
  const setCouch = (z, lift = 0) => {
    rig.couch.position.set(0, COUCH_Y - lift, z);
    rig.couchBase.position.set(0, -lift, 82);
  };
  setCouch(70, 0);
  const setAngle = (a) => { rot.rotation.z = a; };
  // where the scan plane cuts the patient: the mesh's own z (mm) at the plane, for a couch z
  const meshZAtPlane = (couchZ) => (couchZ + PZ - ZP) * 10;
  // the couch z that puts mesh z (mm, + toward the head) in the scan plane
  const couchForMeshZ = (mz) => ZP - PZ + mz / 10;
  // the focal spot in the world for a frame angle
  const focalAt = (a) => [-F * Math.sin(a), ISO_Y + F * Math.cos(a), ZP];

  return {
    rig, room, inner, stat, rot, disc, rings, link, brushes, brushTips, tube, housing, focal, T, coll, collBox, bowtie, jaws,
    det, modules, gen, tanks, cables, hoses, cool, fan, das, beam, setBeam, lasers, setLasers, pat, parts, skinMat, boneMat,
    inj, injHead, setSyringe, setLine, phantom, holes, chamber, M, floor,
    patBox, ISO_Y, FLOOR_Y, COUCH_Y, setCouch, setAngle, meshZAtPlane, couchForMeshZ, focalAt, setOpacity,
    /* What shows: the covers' opacity (1 closed .. 0 off), the frame inside, the patient. */
    view({ shell = 1, inside = false, patient = true, skin = 1, phantomOn = false, injector = true } = {}) {
      setOpacity(rig.shell, shell);
      inner.visible = inside;
      pat.visible = patient;
      if (parts.skin) setOpacity(parts.skin, skin);
      phantom.visible = phantomOn;
      inj.visible = injector;
      if (lineMesh) lineMesh.visible = injector;
      T.g.visible = false; housing.visible = true;
      beam.visible = false;
      for (const e of this.extras) e.visible = false;
      if (parts.bone) parts.bone.visible = true;
    },
    extras: [],
  };
}
