/* THE TRANSDUCER, inside: the app's curvilinear probe (ultrasound.js buildRig / probeFrame: a face
   on a 6 cm radius, its lines spread over a 60 degree sector) built in full. Frame: the middle of
   the face, where it touches the gel, at the origin; y up the handle, x along the array (the
   image's lateral direction), z across it (elevation). Units cm, to scale except where noted.

   From the patient inward: the silicone LENS (curved across the array too: it focuses the beam in
   elevation), two MATCHING LAYERS, the row of PZT ELEMENTS (each with its electrodes; drawn a
   little thick), the BACKING block that damps their ringing, the flex circuit taking each element's
   wire up to the cable. The shell round it all. */
import * as THREE from 'three';
import { std, mesh, glowMat } from '../../kit/stage.js';

export const R0 = 6.0;            // the face's radius of curvature (the app's virtual apex)
export const SECTOR = 1.05;       // radians of arc the lines spread over
export const NEL = 64;            // elements drawn (a real curved array has 128-192)

// an annular sector (in x-y, about the centre of curvature at (0, R0)) extruded across z
function arcBand(r0, r1, a0, a1, w, seg = 48) {
  const s = new THREE.Shape();
  const P = (r, a) => [Math.sin(a) * r, R0 - Math.cos(a) * r];
  s.moveTo(...P(r1, a0));
  for (let i = 1; i <= seg; i++) s.lineTo(...P(r1, a0 + (a1 - a0) * i / seg));
  for (let i = seg; i >= 0; i--) s.lineTo(...P(r0, a0 + (a1 - a0) * i / seg));
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false, curveSegments: 4 });
  g.translate(0, 0, -w / 2);
  return g;
}

/* The lens: its outer face bulges across the array (a cylindrical lens: thickest at z = 0),
   its inner face sits on the matching layer. */
function lensGeometry(rIn, rOut, bulge, a0, a1, w, nu = 64, nv = 16) {
  const pos = [], idx = [];
  const P = (r, a, z) => [Math.sin(a) * r, R0 - Math.cos(a) * r, z];
  const outer = (i, j) => { const a = a0 + (a1 - a0) * i / nu, z = -w / 2 + w * j / nv, q = 2 * z / w; return P(rOut + bulge * (1 - q * q), a, z); };
  const inner = (i, j) => { const a = a0 + (a1 - a0) * i / nu, z = -w / 2 + w * j / nv; return P(rIn, a, z); };
  const grid = (f) => { const b = pos.length / 3; for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) pos.push(...f(i, j)); return b; };
  const quadGrid = (b, flip) => {
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const a = b + i * (nv + 1) + j, c = a + nv + 1;
      if (flip) idx.push(a, a + 1, c, c, a + 1, c + 1); else idx.push(a, c, a + 1, c, c + 1, a + 1);
    }
  };
  const bo = grid(outer), bi = grid(inner);
  quadGrid(bo, false); quadGrid(bi, true);
  // the four edges
  for (let i = 0; i < nu; i++) for (const j of [0, nv]) {
    const a = bo + i * (nv + 1) + j, b = bo + (i + 1) * (nv + 1) + j, c = bi + i * (nv + 1) + j, d = bi + (i + 1) * (nv + 1) + j;
    if (j === 0) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
  }
  for (let j = 0; j < nv; j++) for (const i of [0, nu]) {
    const a = bo + i * (nv + 1) + j, b = bo + i * (nv + 1) + j + 1, c = bi + i * (nv + 1) + j, d = bi + i * (nv + 1) + j + 1;
    if (i === 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

export function buildProbe() {
  const g = new THREE.Group();
  const M = {
    shell: new THREE.MeshPhysicalMaterial({ color: 0xdfe5ea, roughness: 0.32, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.25 }),
    grip: std(0x8e99a4, 0.75, 0.05),
    lens: new THREE.MeshPhysicalMaterial({ color: 0x5f6f86, roughness: 0.55, metalness: 0, clearcoat: 0.4 }),
    match1: std(0xc8a35a, 0.5, 0.1),
    match2: std(0x8f7a52, 0.5, 0.1),
    backing: std(0x2a2d33, 0.85, 0.15),
    flex: std(0xd98a2b, 0.45, 0.3),
    pcb: std(0x1f6b3a, 0.6, 0.1),
    cable: std(0x2a3138, 0.9, 0.0),
    dark: std(0x15181c, 0.6, 0.2),
  };
  const half = SECTOR / 2 + 0.03;          // the array spans a touch more than the lines

  // ---- the stack, outer to inner (radii about the centre of curvature)
  const W = 1.5;                            // the elements' height across the array (elevation)
  const lens = mesh(lensGeometry(R0 - 0.16, R0 - 0.06, 0.06, -half, half, W + 0.1), M.lens);
  const match = new THREE.Group();
  match.add(mesh(arcBand(R0 - 0.20, R0 - 0.16, -half, half, W), M.match1));
  match.add(mesh(arcBand(R0 - 0.24, R0 - 0.20, -half, half, W), M.match2));
  // the elements: each a PZT bar with its own glow (fired one by one, or in groups), silver
  // electrodes on both faces
  const elements = new THREE.Group(), elMats = [];
  const pitch = (2 * half) / NEL, kerf = pitch * 0.18;
  for (let i = 0; i < NEL; i++) {
    const a0 = -half + i * pitch + kerf / 2, a1 = a0 + pitch - kerf;
    const m = glowMat(0x7ff6ff); m.color.set(0x9a8f7a); m.roughness = 0.4; m.metalness = 0.3;
    elMats.push(m);
    const e = new THREE.Group();
    e.add(mesh(arcBand(R0 - 0.52, R0 - 0.26, a0, a1, W, 2), m));
    e.add(mesh(arcBand(R0 - 0.26, R0 - 0.24, a0, a1, W, 2), std(0xd9dde2, 0.25, 0.9)));   // electrodes
    e.add(mesh(arcBand(R0 - 0.54, R0 - 0.52, a0, a1, W, 2), std(0xd9dde2, 0.25, 0.9)));
    elements.add(e);
  }
  // the backing: a thick block of tungsten-loaded epoxy behind the elements
  const backing = mesh(arcBand(R0 - 1.95, R0 - 0.54, -half, half, W + 0.1), M.backing);
  // flex circuit: one trace per element out of the backing's sides, to a board above
  const flex = new THREE.Group();
  for (const s of [-1, 1]) {
    const sheet = mesh(new THREE.BoxGeometry(0.05, 2.6, W), M.flex, s * 2.85, 2.2, 0);
    sheet.rotation.z = s * 0.12; flex.add(sheet);
  }
  for (let i = 0; i < NEL; i += 4) {          // a few traces drawn on the sheets
    const s = i < NEL / 2 ? -1 : 1, z = -W / 2 + 0.1 + ((i % 32) / 32) * (W - 0.2);
    const tr = mesh(new THREE.BoxGeometry(0.06, 2.5, 0.02), std(0xffd27a, 0.3, 0.8), s * 2.88, 2.2, z);
    tr.rotation.z = s * 0.12; flex.add(tr);
  }
  const pcb = mesh(new THREE.BoxGeometry(5.0, 0.15, 1.9), M.pcb, 0, 3.7, 0);
  flex.add(pcb);
  for (let i = 0; i < 4; i++) flex.add(mesh(new THREE.BoxGeometry(0.8, 0.2, 0.7), M.dark, -1.5 + i, 3.85, 0));
  const stack = new THREE.Group();
  stack.add(lens, match, elements, backing, flex);
  g.add(stack);

  // ---- the shell: a lathe-free extrusion of the handle's outline, its face open over the lens
  const s = new THREE.Shape();
  const arcR = R0 - 0.76, aE = half + 0.02;          // (+ its bevel: the lens stands just proud of it)
  const P = (r, a) => [Math.sin(a) * r, R0 - Math.cos(a) * r];
  s.moveTo(...P(arcR, -aE));
  for (let i = 1; i <= 40; i++) s.lineTo(...P(arcR, -aE + 2 * aE * i / 40));
  const ex = P(arcR, aE);
  s.lineTo(ex[0] + 0.1, ex[1] + 0.3);
  s.bezierCurveTo(3.1, 2.6, 2.6, 4.2, 1.6, 5.8);
  s.bezierCurveTo(1.25, 6.6, 1.35, 8.4, 1.55, 9.2);
  s.bezierCurveTo(1.6, 9.9, 1.0, 10.8, 0.45, 11.0);
  s.lineTo(-0.45, 11.0);
  s.bezierCurveTo(-1.0, 10.8, -1.6, 9.9, -1.55, 9.2);
  s.bezierCurveTo(-1.35, 8.4, -1.25, 6.6, -1.6, 5.8);
  s.bezierCurveTo(-2.6, 4.2, -3.1, 2.6, -ex[0] - 0.1, ex[1] + 0.3);
  s.closePath();
  const D = 0.7;                                     // (+ two 0.85 cm bevels: a pillowed, rounded body)
  const shellGeo = new THREE.ExtrudeGeometry(s, { depth: D, bevelEnabled: true, bevelThickness: 0.85, bevelSize: 0.62, bevelSegments: 8, curveSegments: 24 });
  shellGeo.translate(0, 0, -D / 2);
  const shell = mesh(shellGeo, M.shell);
  // a seam round the shell where its two halves meet, and a coloured band at the neck
  const seam = mesh(new THREE.ExtrudeGeometry(s, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.235, bevelSegments: 1, curveSegments: 24 }), M.dark, 0, 0, -0.025);
  const band = mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.35, 32), std(0x2fa4c8, 0.35, 0.2), 0, 11.0, 0);
  band.scale.set(1.15, 1, 1.25);
  void seam;
  const housing = new THREE.Group(); housing.add(shell, band);
  g.add(housing);
  // the strain relief and the cable, up and away
  const relief = mesh(new THREE.CylinderGeometry(0.42, 0.8, 2.6, 20), M.cable, 0, 12.6, 0);
  const cablePts = [];
  for (let i = 0; i <= 30; i++) { const u = i / 30; cablePts.push(new THREE.Vector3(Math.sin(u * 1.4) * 6 * u, 13.4 + u * 22, -u * u * 8)); }
  const cable = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(cablePts), 60, 0.36, 10), M.cable);
  g.add(relief, cable);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });

  /* Explode the stack along y (k 0..1): the lens down, the backing and flex up, so each layer is
     seen apart. */
  const explode = (k) => {
    lens.position.y = -1.2 * k; match.position.y = -0.55 * k;
    elements.position.y = 0; backing.position.y = 0.9 * k; flex.position.y = 2.0 * k;
  };
  // fire elements: glow(i) 0..1 per element
  const fire = (f) => { for (let i = 0; i < NEL; i++) { const v = f(i); elMats[i].emissiveIntensity = v * 2.2; } };
  // where element i's middle is (in the probe's frame) and its outward normal
  const elementAt = (i, r = R0 - 0.39) => {
    const a = -half + (i + 0.5) * pitch;
    return { p: [Math.sin(a) * r, R0 - Math.cos(a) * r, 0], n: [Math.sin(a), -Math.cos(a), 0], a };
  };
  return { g, stack, lens, match, elements, backing, flex, housing, shell, cable, relief, M, explode, fire, elementAt, half, pitch };
}
