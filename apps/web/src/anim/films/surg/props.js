/* THE SURGICAL FILMS' PROPS, in 3D: the things the size of a hand or bigger, and the needles,
   which the camera comes close enough to see. Each is a group in cm with its origin where it
   rests (or, for a needle, at its tip) and setters that put it in one state of its motion, a
   function of 0..1 the film eases (a frame is a function of the step's time: every setter sets,
   none accumulates).

   Everything a hand would pick up is made along +z (a needle's shaft, a syringe's barrel, a
   sponge stick) so place(obj, at, dir, up) can point it anywhere. */
import * as THREE from 'three';
import { std, mesh } from '../../kit/stage.js';

const D = Math.PI / 180;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const seg = (k, a, b) => clamp01((k - a) / (b - a));

export const MAT = {
  steel: () => std(0xd5dadf, 0.22, 0.9),
  wrap: () => new THREE.MeshStandardMaterial({ color: 0x3f7fc4, roughness: 0.85, side: THREE.DoubleSide }),
  drape: () => new THREE.MeshStandardMaterial({ color: 0x2f6aa6, roughness: 0.9, side: THREE.DoubleSide }),
  white: () => std(0xf2f4f5, 0.6, 0.0),
  clear: (color = 0xe8f2fa, opacity = 0.3) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.08, metalness: 0, transparent: true, opacity,
    depthWrite: false, side: THREE.DoubleSide }),
  betadine: () => std(0x7a3a12, 0.25, 0.0, { emissive: 0x1a0800 }),
  foam: () => std(0xe9e4d4, 0.95, 0.0),
};

/* Put an object at `at` with its +z along dir and its +y toward up (both the parent's frame). */
export function place(obj, at, dir, up = [0, 1, 0]) {
  const z = new THREE.Vector3(...dir).normalize();
  let u = new THREE.Vector3(...up);
  if (Math.abs(u.clone().normalize().dot(z)) > 0.98) u = new THREE.Vector3(1, 0, 0);
  const x = new THREE.Vector3().crossVectors(u, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  obj.position.set(...at);
  obj.updateMatrixWorld(true);
  return obj;
}

// a canvas texture painted once
export function canvasTex(w, h, paint) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  paint(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  t.userData = { cv };
  return t;
}
// a cylinder along +z from z0 to z1
function rod(r0, r1, z0, z1, mat, seg_ = 16) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, z1 - z0, seg_), mat);
  m.rotation.x = Math.PI / 2; m.position.z = (z0 + z1) / 2;
  return m;
}

/* ---------------------------------------------------------------- the back table
   A stainless instrument table on four legs: its origin the middle of its top, the top 50 x 80. */
export function makeBackTable(floorY = -94) {
  const g = new THREE.Group(), st = std(0xc9ced3, 0.3, 0.75);
  g.add(mesh(new THREE.BoxGeometry(50, 1.2, 80), st, 0, -0.6, 0));
  g.add(mesh(new THREE.BoxGeometry(50.6, 2.4, 0.6), st, 0, -1.2, 40)); g.add(mesh(new THREE.BoxGeometry(50.6, 2.4, 0.6), st, 0, -1.2, -40));
  for (const [x, z] of [[-23, -37], [23, -37], [-23, 37], [23, 37]]) {
    g.add(mesh(new THREE.CylinderGeometry(1.1, 1.1, -floorY - 6, 10), st, x, (floorY - 6) / 2 + 3 - 1, z));
    g.add(mesh(new THREE.SphereGeometry(2.4, 10, 8), std(0x2a2f36, 0.6), x, floorY + 2.4 - 1, z));
  }
  g.add(mesh(new THREE.BoxGeometry(46, 0.8, 76), st, 0, floorY + 28, 0));          // the shelf
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { g };
}

/* ---------------------------------------------------------------- a wrapped pack
   A box of w x h x d (x, y, z) in sterile wrap, folded as an envelope: four walls hinged at the
   base, each with a triangular flap folded over the top. open(k): the far flap, the two sides,
   then the near one (toward +z... the opener's side is -z) unfold outward onto the table, the
   contents (pack.contents) left standing on the inner sheet. close(k) the same backwards: a
   re-pack for sterilization. */
export function makePack({ w = 40, h = 7, d = 30, color = 0x3f7fc4 } = {}) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.88, side: THREE.DoubleSide });
  const inner = new THREE.Mesh(new THREE.PlaneGeometry(w + 2, d + 2), mat); inner.rotation.x = -Math.PI / 2; inner.position.y = 0.05; g.add(inner);
  const contents = new THREE.Group(); g.add(contents);
  // the four sides: [edge midpoint, outward normal, edge length, the flap's height (to the centre)]
  const sides = [[[0, 0, d / 2], [0, 0, 1], w, d / 2], [[w / 2, 0, 0], [1, 0, 0], d, w / 2], [[-w / 2, 0, 0], [-1, 0, 0], d, w / 2], [[0, 0, -d / 2], [0, 0, -1], w, d / 2]];
  const walls = sides.map(([at, n, L, fh]) => {
    const pivot = new THREE.Group(); pivot.position.set(...at);
    pivot.rotation.order = 'YXZ';                                   // turned to face out, then hinged
    pivot.rotation.y = Math.atan2(n[0], n[2]);                     // local +z outward
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(L, h), mat); wall.position.y = h / 2; pivot.add(wall);
    const top = new THREE.Group(); top.position.y = h; pivot.add(top);
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-L / 2, 0, 0, L / 2, 0, 0, 0, fh, 0], 3));
    tri.computeVertexNormals();
    const flap = new THREE.Mesh(tri, mat); top.add(flap);
    g.add(pivot);
    return { pivot, top };
  });
  // the order it opens in: far (+z) first, then the sides, then the near (-z)
  function open(k) {
    walls.forEach((wl, i) => {
      const f = seg(k, i * 0.22, i * 0.22 + 0.34);
      // closed: the wall up, its flap folded in over the top; open: both flat on the table outward
      wl.pivot.rotation.x = f * Math.PI / 2;
      wl.top.rotation.x = -(1 - f) * Math.PI / 2 + 0.002 * i;
      wl.top.position.y = h + 0.03 * i * (1 - f);                 // the flaps lie on one another
    });
    contents.visible = k > 0.55;
  }
  open(0);
  g.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
  return { g, contents, open, close: (k) => open(1 - k), w, h, d };
}

/* ---------------------------------------------------------------- the procedure tray
   A moulded tray of compartments as it lies in its pack: a prep well (the betadine cup), three
   sponge sticks, gauze, a folded fenestrated drape, a needle well. Its origin the middle of its
   floor, 34 x 24 cm. spots: where things are laid in it (the tray's frame). */
export function makeTray() {
  const g = new THREE.Group();
  const plast = new THREE.MeshPhysicalMaterial({ color: 0xf4f6f8, roughness: 0.35, transparent: true, opacity: 0.88 });
  g.add(mesh(new THREE.BoxGeometry(34, 0.4, 24), plast, 0, 0.2, 0));
  for (const [x, z, w, d] of [[0, 12, 34, 0.4], [0, -12, 34, 0.4], [17, 0, 0.4, 24], [-17, 0, 0.4, 24], [-5, 0, 0.4, 24], [6, -3, 22, 0.4]]) g.add(mesh(new THREE.BoxGeometry(w, 3, d), plast, x, 1.5, z));
  // the prep cup (left front well) and what fills it
  const cup = new THREE.Group(); cup.position.set(-11, 0.4, -6); g.add(cup);
  cup.add(new THREE.Mesh(new THREE.CylinderGeometry(3.4, 2.8, 4, 24, 1, true), new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.3, side: THREE.DoubleSide })).translateY(2));
  cup.add(mesh(new THREE.CylinderGeometry(2.8, 2.8, 0.1, 24), MAT.white(), 0, 0.05, 0));
  const liquid = mesh(new THREE.CylinderGeometry(3.1, 2.85, 1, 24), MAT.betadine(), 0, 0.5, 0); cup.add(liquid);
  const fill = (k) => { liquid.visible = k > 0.01; liquid.scale.y = Math.max(0.01, k * 2.6); liquid.position.y = 0.1 + k * 1.3; };
  fill(0);
  // the sponge sticks across the back, resting on the divider; the gauze, the folded drape
  const sticks = [0, 1, 2].map((i) => {
    const s = makeSpongeStick();
    s.g.position.set(-16, 3.3, 6 + i * 2); s.g.rotation.y = Math.PI / 2;                 // its +z along the tray's +x
    g.add(s.g); return s;
  });
  const gauze = new THREE.Group(); gauze.position.set(11.5, 0.4, 8); g.add(gauze);
  for (let i = 0; i < 4; i++) gauze.add(mesh(new THREE.BoxGeometry(7.5, 0.25, 7.5), std(0xfbfbf8, 0.95), 0, 0.15 + i * 0.27, 0)).rotation.y = (i - 1.5) * 0.06;
  const drapeBlock = mesh(new THREE.BoxGeometry(14, 3, 6), MAT.drape(), 6, 1.9, 0.5); g.add(drapeBlock);
  const spots = { needle: [4, 0.6, -6.5], cup: [-11, 0.4, -6], syringe: [6, 0.9, -9.8], vial: [14, 0.4, -7] };
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { g, cup, fill, sticks, gauze, drapeBlock, spots };
}

/* A sponge stick: a white handle 20 cm along +z, the foam head at +z's end. soak(k): white to
   betadine brown. Origin at the handle's end. tip(): the head's middle, in its own frame. */
export function makeSpongeStick() {
  const g = new THREE.Group();
  g.add(rod(0.35, 0.35, 0, 18, MAT.white(), 10));
  g.add(rod(0.55, 0.6, 0, 3, std(0x9ec5e8, 0.6), 10));
  const foam = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), std(0xf0ece0, 0.95)); foam.scale.set(1.3, 1.0, 1.7); foam.position.z = 19.5; g.add(foam);
  const white = new THREE.Color(0xf0ece0), brown = new THREE.Color(0x6e3410);
  const soak = (k) => foam.material.color.copy(white).lerp(brown, clamp01(k));
  return { g, foam, soak, tip: [0, 0, 19.5] };
}

/* ---------------------------------------------------------------- the betadine bottle
   Brown, a white flip cap, its label. Origin its base; its mouth at y 15. pour(k, cup): carried
   from where it stands to over the cup, tipped, poured (a stream from mouth to cup) and set back.
   standAt: its place on the table (the parent's frame); cupAt: the cup's top (the same frame). */
export function makeBottle() {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  const brown = new THREE.MeshPhysicalMaterial({ color: 0x5a2a0e, roughness: 0.2, transparent: true, opacity: 0.95 });
  body.add(mesh(new THREE.CylinderGeometry(3.2, 3.2, 11, 24), brown, 0, 5.5, 0));
  body.add(mesh(new THREE.CylinderGeometry(1.4, 3.2, 2.4, 24), brown, 0, 12.2, 0));
  body.add(mesh(new THREE.CylinderGeometry(1.2, 1.2, 1.6, 16), MAT.white(), 0, 14.2, 0));
  const lab = canvasTex(256, 128, (c, w, h) => {
    c.fillStyle = '#f6f2e8'; c.fillRect(0, 0, w, h); c.fillStyle = '#7a3a12'; c.fillRect(0, 0, w, 26);
    c.fillStyle = '#7a3a12'; c.font = 'bold 30px Arial, sans-serif'; c.textAlign = 'center'; c.fillText('POVIDONE-IODINE', w / 2, 72);
    c.font = '20px Arial, sans-serif'; c.fillText('10% solution', w / 2, 104);
  });
  body.add(mesh(new THREE.CylinderGeometry(3.25, 3.25, 6, 24, 1, true, -Math.PI / 2, Math.PI), new THREE.MeshStandardMaterial({ map: lab, roughness: 0.7 }), 0, 6, 0));
  const stream = mesh(new THREE.CylinderGeometry(0.22, 0.3, 1, 8), MAT.betadine()); stream.visible = false; g.add(stream);
  body.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  const mouth = new THREE.Object3D(); mouth.position.set(0, 15, 0); body.add(mouth);
  function pour(k, standAt, cupAt) {
    const lift = seg(k, 0, 0.2) - seg(k, 0.85, 1), tip = seg(k, 0.2, 0.35) - seg(k, 0.75, 0.88);
    const over = [cupAt[0] + 7, cupAt[1] + 9, cupAt[2]];
    g.position.set(...[0, 1, 2].map((i) => standAt[i] + (over[i] - standAt[i]) * lift));
    body.rotation.z = tip * 118 * D;                                 // tipped toward -x, over the cup
    g.updateMatrixWorld(true);
    const flowing = k > 0.33 && k < 0.78;
    stream.visible = flowing;
    if (flowing) {
      const m = new THREE.Vector3(); mouth.getWorldPosition(m); g.worldToLocal(m);
      const c = new THREE.Vector3(...cupAt).sub(g.position);
      const L = Math.max(0.5, m.distanceTo(c));
      stream.position.copy(m.clone().add(c).multiplyScalar(0.5));
      stream.scale.set(1, L, 1);
      stream.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), m.clone().sub(c).normalize());
    }
    return { fill: seg(k, 0.36, 0.78) };
  }
  return { g, pour };
}

/* ---------------------------------------------------------------- needles
   A needle along +z from its tip (the origin) back to its hub: kind 'spinal' (22 G, 9 cm, a
   clear hub, the stylet's black cap; a Quincke bevel), 'locator' (a 25 G, 3.8 cm hypodermic:
   the spare needle that marks the spot, the lidocaine's), 'cannula' (an RF cannula, 18 G 10 cm,
   insulated but for its 10 mm active tip, a blue hub). The stylet (spinal, cannula): stylet(k),
   1 home, 0 drawn out its whole length (and gone past that: stylet(-1) hides it).
   shaft: the needle's length (cm); the hub's back at z = shaft + hubLen. */
export function makeNeedle({ kind = 'spinal' } = {}) {
  const spec = {
    spinal: { L: 8.9, r: 0.036, hub: 0x6b6f74, cap: 0x1b1d20, hubLen: 1.6, stylet: true },
    locator: { L: 3.8, r: 0.025, hub: 0xd8a35a, cap: null, hubLen: 1.2, stylet: false },
    cannula: { L: 10, r: 0.06, hub: 0x2f6fd6, cap: 0x2f6fd6, hubLen: 1.8, stylet: true, insul: 1.0 },
  }[kind];
  const g = new THREE.Group();
  const steel = MAT.steel();
  const shaft = rod(spec.r, spec.r, 0.08, spec.L, spec.insul ? std(0xd9c64a, 0.45, 0.1) : steel, 10);
  g.add(shaft);
  if (spec.insul) g.add(rod(spec.r * 1.02, spec.r * 1.02, 0.08, spec.insul, steel, 10));        // the active tip
  // the bevel: a short cone at the tip
  const bevel = new THREE.Mesh(new THREE.ConeGeometry(spec.r, 0.16, 10), steel); bevel.rotation.x = -Math.PI / 2; bevel.position.z = 0.08; g.add(bevel);
  const hubMat = new THREE.MeshPhysicalMaterial({ color: spec.hub, roughness: 0.3, transparent: kind === 'spinal', opacity: kind === 'spinal' ? 0.7 : 1 });
  g.add(rod(spec.r * 4, 0.42, spec.L, spec.L + spec.hubLen * 0.6, hubMat, 16));
  g.add(rod(0.42, 0.42, spec.L + spec.hubLen * 0.6, spec.L + spec.hubLen, hubMat, 16));
  // the hub's notch (which way the bevel faces) as a fin
  g.add(mesh(new THREE.BoxGeometry(0.12, 0.5, 0.7), hubMat, 0, 0.5, spec.L + spec.hubLen * 0.5));
  let st = null;
  if (spec.stylet) {
    st = new THREE.Group(); g.add(st);
    st.add(rod(spec.r * 0.6, spec.r * 0.6, 0.12, spec.L + spec.hubLen, steel, 6));
    st.add(rod(0.48, 0.48, spec.L + spec.hubLen, spec.L + spec.hubLen + 0.6, std(spec.cap, 0.5), 16));
    st.add(mesh(new THREE.BoxGeometry(0.9, 0.3, 0.3), std(spec.cap, 0.5), 0, 0, spec.L + spec.hubLen + 0.45));
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  const stylet = (k) => {
    if (!st) return;
    st.visible = k >= 0;
    st.position.z = (1 - clamp01(k)) * (spec.L + 0.6);
  };
  // drops of CSF from the hub: drip(t) (seconds), on is 0..1 (how freely it flows)
  const drops = [0, 1, 2].map(() => { const m = mesh(new THREE.SphereGeometry(0.11, 8, 6), MAT.clear(0xdaf0ff, 0.75)); m.visible = false; g.add(m); return m; });
  const drip = (t, on = 1) => drops.forEach((m, i) => {
    const ph = ((t * 0.9 * on + i / 3) % 1);
    m.visible = on > 0.05;
    // out of the hub and falling (the hub's back points up, roughly: the drop falls along the parent's -y)
    m.position.set(0, -ph * ph * 6, spec.L + spec.hubLen + 0.15);
    m.scale.setScalar(ph < 0.15 ? ph / 0.15 : 1);
  });
  return { g, kind, len: spec.L, hubLen: spec.hubLen, stylet, drip, drops };
}

/* An RF probe (the thermocouple electrode that goes down a cannula): a fine wire the cannula's
   length, a grey hub and its cable. Origin its tip; along +z. */
export function makeProbe({ L = 10 } = {}) {
  const g = new THREE.Group();
  g.add(rod(0.03, 0.03, 0, L + 1.8, MAT.steel(), 6));
  g.add(rod(0.36, 0.42, L + 1.8, L + 3.6, std(0x8d949c, 0.5), 14));
  const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[0, 0, L + 3.6], [0, 0.6, L + 7], [0, 3, L + 13], [0, 8, L + 20]].map((p) => new THREE.Vector3(...p))), 24, 0.18, 6), std(0x2c3036, 0.6));
  g.add(cable);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { g, L, cable };
}

/* ---------------------------------------------------------------- a syringe
   ml 3, 5 or 10; color the liquid's. Along +z: the luer tip at the origin, the barrel behind it,
   the plunger's thumb press at the back. set({ fill, plunger }): fill 0..1 of the barrel (the
   liquid), plunger 0..1 how far drawn back (default = fill). needle: true adds a drawing-up
   needle on the tip. */
export function makeSyringe({ ml = 10, color = 0xf4f8fb, needle = false } = {}) {
  const g = new THREE.Group();
  const R = { 3: 0.45, 5: 0.6, 10: 0.78 }[ml] || 0.7, L = { 3: 4.6, 5: 5.4, 10: 6.4 }[ml] || 6;
  g.add(rod(0.12, 0.2, 0, 0.8, MAT.clear(0xffffff, 0.6), 10));
  g.add(rod(R, R, 0.8, 0.8 + L, MAT.clear(0xf0f6fb, 0.32), 20));
  g.add(mesh(new THREE.BoxGeometry(R * 4.2, 0.18, 0.5), MAT.clear(0xffffff, 0.7), 0, 0, 0.8 + L));      // finger flanges
  const liquid = rod(R * 0.92, R * 0.92, 0, 1, new THREE.MeshPhysicalMaterial({ color, roughness: 0.15, transparent: true, opacity: 0.55, depthWrite: false }), 20);
  g.add(liquid);
  const plunger = new THREE.Group(); g.add(plunger);
  plunger.add(rod(R * 0.95, R * 0.95, 0, 0.35, std(0x2b2e33, 0.6), 20));                               // the stopper
  plunger.add(mesh(new THREE.BoxGeometry(R * 1.2, 0.12, L + 1), MAT.clear(0xffffff, 0.75), 0, 0, 0.35 + (L + 1) / 2));
  plunger.add(mesh(new THREE.BoxGeometry(0.12, R * 1.2, L + 1), MAT.clear(0xffffff, 0.75), 0, 0, 0.35 + (L + 1) / 2));
  plunger.add(rod(R * 1.1, R * 1.1, L + 1.35, L + 1.5, MAT.clear(0xffffff, 0.8), 20));
  let ndl = null;
  if (needle) { ndl = makeNeedle({ kind: 'locator' }); ndl.g.rotation.y = Math.PI; g.add(ndl.g); }
  function set({ fill = 0, plunger: p = null } = {}) {
    const f = clamp01(fill), q = p == null ? f : clamp01(p);
    liquid.visible = f > 0.01;
    liquid.scale.y = Math.max(0.01, f * L);
    liquid.position.z = 0.8 + f * L / 2;
    plunger.position.z = 0.8 + q * L;
  }
  set({ fill: 0 });
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { g, set, L, R, needle: ndl };
}

/* ---------------------------------------------------------------- a vial
   A glass vial with a coloured flip cap and its label (text: two short lines). Origin its base; the
   stopper's top at y 4.4. level(k): how full. */
export function makeVial({ lines = ['', ''], cap = 0x2f6fd6, band = '#2f6fd6', liquid = 0xf6fbff } = {}) {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(1.2, 1.2, 3.4, 20), MAT.clear(0xf4fbff, 0.35), 0, 1.7, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.8, 16), MAT.clear(0xf4fbff, 0.4), 0, 3.8, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.5, 16), std(0xb8bec4, 0.3, 0.8), 0, 4.15, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.3, 16), std(cap, 0.5), 0, 4.5, 0));
  const lab = canvasTex(256, 96, (c, w, h) => {
    c.fillStyle = '#fbfbf8'; c.fillRect(0, 0, w, h); c.fillStyle = band; c.fillRect(0, 0, w, 18);
    c.fillStyle = '#1d2228'; c.textAlign = 'center'; c.font = 'bold 26px Arial, sans-serif'; c.fillText(lines[0], w / 2, 50);
    c.font = '20px Arial, sans-serif'; c.fillText(lines[1] || '', w / 2, 80);
  });
  g.add(mesh(new THREE.CylinderGeometry(1.22, 1.22, 2, 20, 1, true, -Math.PI * 0.6, Math.PI * 1.2), new THREE.MeshStandardMaterial({ map: lab, roughness: 0.7 }), 0, 1.6, 0));
  const liq = mesh(new THREE.CylinderGeometry(1.1, 1.1, 1, 20), new THREE.MeshPhysicalMaterial({ color: liquid, roughness: 0.1, transparent: true, opacity: 0.5, depthWrite: false }), 0, 0, 0);
  g.add(liq);
  const level = (k) => { liq.visible = k > 0.01; liq.scale.y = Math.max(0.01, k * 3.1); liq.position.y = 0.15 + k * 3.1 / 2; };
  level(0.85);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { g, level, top: [0, 4.65, 0] };
}

/* ---------------------------------------------------------------- the RF generator
   A box on a cart: its screen a canvas the film draws (screen(state)), four output sockets and a
   knob. Origin the floor under its cart; the screen faces +z. screen({ mode: 'SENSORY'|'MOTOR'|
   'PULSED'|'CONTINUOUS'|'', temp (degC), ohms, volts, hz, time (s), on }). */
export function makeGenerator(floorY = -90) {
  const g = new THREE.Group();
  const shell = std(0xe8ebee, 0.45, 0.1), dark = std(0x23272c, 0.6, 0.2);
  // the cart: a post on castors, a shelf
  g.add(mesh(new THREE.CylinderGeometry(2, 2, 70, 12), std(0xb7bcc2, 0.35, 0.7), 0, 35, 0));
  g.add(mesh(new THREE.BoxGeometry(44, 2, 36), shell, 0, 72, 0));
  for (const [x, z] of [[-18, -14], [18, -14], [-18, 14], [18, 14]]) g.add(mesh(new THREE.SphereGeometry(2.4, 10, 8), dark, x, 2.4, z));
  g.add(mesh(new THREE.BoxGeometry(40, 2, 32), std(0xb7bcc2, 0.35, 0.7), 0, 5, 0));
  // the generator
  const box = new THREE.Group(); box.position.y = 73; g.add(box);
  box.add(mesh(new THREE.BoxGeometry(38, 16, 30), shell, 0, 8, 0));
  box.add(mesh(new THREE.BoxGeometry(38.4, 1.2, 30.4), std(0x2f6fd6, 0.5), 0, 1, 0));
  const cv = document.createElement('canvas'); cv.width = 320; cv.height = 160;
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const scr = mesh(new THREE.PlaneGeometry(20, 10), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }), -6, 9.5, 15.05);
  box.add(mesh(new THREE.BoxGeometry(21.4, 11.4, 0.4), dark, -6, 9.5, 14.9));
  box.add(scr);
  for (let i = 0; i < 4; i++) box.add(mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.6, 14), dark, 8.5 + (i % 2) * 4.5, 12 - Math.floor(i / 2) * 4.5, 15.1)).rotation.x = Math.PI / 2;
  const knob = mesh(new THREE.CylinderGeometry(1.6, 1.6, 1.4, 20), dark, 10.75, 4.2, 15.3); knob.rotation.x = Math.PI / 2; box.add(knob);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  function screen({ mode = '', temp = 37, ohms = 0, volts = 0, hz = 0, time = 0, on = false } = {}) {
    const c = cv.getContext('2d');
    c.fillStyle = '#071018'; c.fillRect(0, 0, 320, 160);
    c.fillStyle = on ? '#ffb347' : '#7fd3ff'; c.font = 'bold 20px monospace'; c.fillText(mode, 12, 28);
    c.fillStyle = '#e8f4ff'; c.font = 'bold 44px monospace'; c.fillText(`${Math.round(temp)}°C`, 12, 82);
    c.font = '18px monospace'; c.fillStyle = '#9fc7e0';
    c.fillText(`${Math.round(ohms)} Ω`, 196, 64);
    if (volts) c.fillText(`${volts.toFixed(1)} V`, 196, 90);
    if (hz) c.fillText(`${hz} Hz`, 196, 116);
    const m = Math.floor(time / 60), s = Math.floor(time % 60);
    c.fillStyle = '#e8f4ff'; c.font = 'bold 24px monospace'; c.fillText(`${m}:${String(s).padStart(2, '0')}`, 12, 140);
    if (on) { c.fillStyle = '#ff6b3d'; c.beginPath(); c.arc(298, 22, 8, 0, Math.PI * 2); c.fill(); }
    tex.needsUpdate = true;
  }
  screen();
  const socket = (i) => { const v = new THREE.Vector3(8.5 + (i % 2) * 4.5, 73 + 12 - Math.floor(i / 2) * 4.5, 15.4); return v; };
  return { g, screen, socket, knob };
}

/* ---------------------------------------------------------------- a cable
   A tube between two points that sags (both points in the parent's frame), set(a, b) each frame. */
export function makeCable(color = 0x2c3036, r = 0.25) {
  const mat = std(color, 0.6, 0.1);
  const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  m.castShadow = true;
  let key = '';
  m.userData.set = (a, b, sag = 20) => {
    const k = [...a, ...b].map((v) => v.toFixed(1)).join(',');
    if (k === key) return;
    key = k;
    const mid = [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - sag, (a[2] + b[2]) / 2];
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(...a), new THREE.Vector3(...mid), new THREE.Vector3(...b)]);
    m.geometry.dispose();
    m.geometry = new THREE.TubeGeometry(curve, 32, r, 6);
  };
  return m;
}

/* ---------------------------------------------------------------- the sharps container
   Yellow, a red lid with its slot. Origin its base; the slot at mouth (its frame). */
export function makeSharps() {
  const g = new THREE.Group();
  const yel = std(0xf2c418, 0.45), red = std(0xc8282c, 0.45);
  g.add(mesh(new THREE.BoxGeometry(16, 20, 12), yel, 0, 10, 0));
  g.add(mesh(new THREE.BoxGeometry(16.6, 2.4, 12.6), red, 0, 21.2, 0));
  g.add(mesh(new THREE.BoxGeometry(9, 0.1, 3), std(0x1a1c1f, 0.7), 0, 22.45, 1.5));
  const lab = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#f2c418'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#1d1d1d'; c.font = 'bold 40px Arial, sans-serif'; c.textAlign = 'center'; c.fillText('SHARPS', w / 2, 70);
    c.lineWidth = 8; c.strokeStyle = '#1d1d1d'; c.beginPath(); c.arc(w / 2, 160, 50, 0, Math.PI * 2); c.stroke();
    for (let i = 0; i < 3; i++) { const a = i * 2.094 - 1.571; c.beginPath(); c.arc(w / 2 + Math.cos(a) * 34, 160 + Math.sin(a) * 34, 22, 0, Math.PI * 2); c.stroke(); }
  });
  g.add(mesh(new THREE.PlaneGeometry(11, 11), new THREE.MeshStandardMaterial({ map: lab, roughness: 0.6 }), 0, 10, 6.02));
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { g, mouth: [0, 22.5, 1.5] };
}

/* ---------------------------------------------------------------- the grounding pad
   A dispersive pad, 14 x 9 cm: white foam, its blue gel face down, a lead off one end. A flat
   grid (the skin's shape is laid in by the kit). Along x and z, face down at y 0. */
export function makeGroundPad() {
  const g = new THREE.Group();
  const geo = new THREE.PlaneGeometry(14, 9, 14, 9); geo.rotateX(-Math.PI / 2);
  const tex = canvasTex(256, 160, (c, w, h) => {
    c.fillStyle = '#f7f7f4'; c.fillRect(0, 0, w, h); c.strokeStyle = '#2f6fd6'; c.lineWidth = 8; c.strokeRect(14, 14, w - 28, h - 28);
    c.fillStyle = '#2f6fd6'; c.font = 'bold 26px Arial, sans-serif'; c.textAlign = 'center'; c.fillText('RETURN', w / 2, h / 2 + 9);
  });
  const pad = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, side: THREE.DoubleSide }));
  g.add(pad);
  const tab = mesh(new THREE.BoxGeometry(3, 0.3, 3), std(0x2f6fd6, 0.5), 8.2, 0.15, 0); g.add(tab);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { g, pad, geo, rest: geo.attributes.position.array.slice(), lead: [9.5, 0.3, 0] };
}

/* ---------------------------------------------------------------- gauze and tape
   A folded gauze square with two strips of tape across it, laid on the skin by the kit (a small
   grid it conforms). Along x and z. */
export function makeDressing() {
  const g = new THREE.Group();
  const gz = new THREE.PlaneGeometry(5, 5, 6, 6); gz.rotateX(-Math.PI / 2);
  const gauze = new THREE.Mesh(gz, new THREE.MeshStandardMaterial({ color: 0xfcfcf8, roughness: 0.95, side: THREE.DoubleSide }));
  g.add(gauze);
  const tapes = [-1.4, 1.4].map((z) => {
    const tg = new THREE.PlaneGeometry(9, 1.6, 9, 2); tg.rotateX(-Math.PI / 2);
    const t = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ color: 0xf1ede2, roughness: 0.7, transparent: true, opacity: 0.92, side: THREE.DoubleSide }));
    t.position.set(0, 0.06, z); g.add(t);
    return t;
  });
  return { g, gauze, tapes };
}
