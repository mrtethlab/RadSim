/* ============================================================================
   DENSITOMETRY ROOM: the scanning table, its arm, and what the patient lies on
   ============================================================================
   Modelled after a full-size GE Lunar Prodigy (263 x 111 x 128 cm, its spec sheet): a long
   white table whose ends sweep down to the floor in two rounded arches, a black vinyl pad
   running over the top and down over both ends, the scanning field marked on the pad in white
   lines, a grey base plate between the arches, and the scanning ARM: the x-ray source in a box
   under the table, the detector in the head reaching over it from a pillar beside the table.
   Source and detector travel together along the table; between passes they step, and during a
   pass the narrow fan sweeps across (the head's underside shows where).

   Frame (cm): the pad's surface at y = 0 (where every mode lays its patient), the table's long
   axis along z (+z toward the head end), the pillar on the -x side. The arm's group has its
   origin on the table's centre line at the pad: dxa.js moves it along z.
   Also here: the knee block for the spine, the foot holder for the hip, and the patient's
   legs, drawn as phantoms (the chest-abdomen-pelvis volume ends at the upper thighs).
   ============================================================================ */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const LUNAR = { LEN: 263, W: 76, PAD_W: 64, FLOOR: -72, CAP: 34, ARM_D: 30, HEAD_UNDER: 31 };
// the scanning field marked on the pad: two long lines either side of the centre line
export const PAD_LINES = { halfW: 22, z0: -96, z1: 96 };

function mats() {
  const std = (color, roughness = 0.5, metalness = 0.04, extra = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
  return {
    white: std(0xf0f1f2, 0.38, 0.03, { emissive: 0x5a5e62 }),
    white2: std(0xe2e4e7, 0.45, 0.03, { emissive: 0x4c5055 }),
    grey: std(0xa7acb2, 0.5, 0.08, { emissive: 0x2a2d31 }),
    greyD: std(0x7c8289, 0.5, 0.1, { emissive: 0x1d2024 }),
    plate: std(0xb9b5ae, 0.55, 0.25, { emissive: 0x2b2a27 }),
    band: std(0x6d6f86, 0.45, 0.1, { emissive: 0x1e1f2c }),
    black: std(0x1b1d22, 0.62, 0.05, { side: THREE.DoubleSide }),
    rubber: std(0x202226, 0.8, 0),
    foam: std(0x7f9db3, 0.75, 0, { emissive: 0x1b2833 }),
    wood: std(0x9b7a3b, 0.6, 0.05, { emissive: 0x2a2010 }),
    strap: std(0x8a8d92, 0.7, 0.05),
    std,
  };
}
const rbox = (w, h, d, r, seg = 4) => new RoundedBoxGeometry(w, h, d, seg, Math.max(0.01, Math.min(r, w / 2, h / 2, d / 2) - 1e-3));
const mesh = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; };
function canvasTex(w, h, draw) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv); t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const decal = (tex, w, h) => new THREE.Mesh(new THREE.PlaneGeometry(w, h),
  new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
// a round blue emblem (a swirl in a ring: no maker's mark)
function emblem() {
  return canvasTex(256, 256, (g) => {
    g.clearRect(0, 0, 256, 256);
    g.fillStyle = '#e9ecf0'; g.beginPath(); g.arc(128, 128, 124, 0, 2 * Math.PI); g.fill();
    g.fillStyle = '#4a64a6'; g.beginPath(); g.arc(128, 128, 112, 0, 2 * Math.PI); g.fill();
    g.strokeStyle = '#e9ecf0'; g.lineWidth = 6; g.beginPath(); g.arc(128, 128, 98, 0, 2 * Math.PI); g.stroke();
    g.lineWidth = 11; g.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + 0.4;
      g.beginPath(); g.arc(128 + 42 * Math.cos(a), 128 + 42 * Math.sin(a), 28, a + 0.5, a + 3.6); g.stroke();
    }
  });
}

/* the pad's top: black vinyl with the scanning field in white lines */
function padTexture(lenCm, wCm) {
  const PX = 6;
  return canvasTex(Math.round(wCm * PX), Math.round(lenCm * PX), (g, W, H) => {
    g.fillStyle = '#1c1e23'; g.fillRect(0, 0, W, H);
    // a faint sheen down the middle, as the vinyl catches the light
    const gr = g.createLinearGradient(0, 0, W, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.05)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(235,238,242,0.9)'; g.lineWidth = 3;
    const X = (x) => W / 2 + x * PX, Z = (z) => H / 2 - z * PX;
    const L = PAD_LINES;
    g.strokeRect(X(-L.halfW), Z(L.z1), 2 * L.halfW * PX, (L.z1 - L.z0) * PX);
    // the centre line the patient's midline is laid on
    g.setLineDash([18, 10]); g.beginPath(); g.moveTo(X(0), Z(L.z1)); g.lineTo(X(0), Z(L.z0)); g.stroke(); g.setLineDash([]);
    // cross marks every 20 cm along the field
    for (let z = L.z0 + 16; z < L.z1; z += 32) { g.beginPath(); g.moveTo(X(-4), Z(z)); g.lineTo(X(4), Z(z)); g.stroke(); }
  });
}

/* ---------------------------------------------------------------- the table + arm */
export function buildLunar() {
  const M = mats();
  const { LEN, W, PAD_W, FLOOR, CAP } = LUNAR;
  const table = new THREE.Group();
  const deckLen = LEN - 2 * CAP;
  // the deck: a white slab under the pad, a grey-lavender band under its edge
  table.add(mesh(rbox(W, 7, deckLen + 2, 2), M.white, 0, -5.5, 0));
  table.add(mesh(rbox(W - 6, 3, deckLen, 1), M.band, 0, -10, 0));
  // the pad: over the whole top, its scanning field drawn on it
  // (flat from where one arch's rounded corner starts to the other's; it wraps over those below)
  const padLen = deckLen + 2 * (CAP - 24);
  const pad = mesh(rbox(PAD_W, 2.2, padLen, 1.0), [M.black, M.black, new THREE.MeshStandardMaterial({ map: padTexture(padLen, PAD_W), roughness: 0.6 }), M.black, M.black, M.black], 0, -1.1, 0);
  table.add(pad);
  // the two end arches: a rounded C from the deck down to the floor, the pad running over them
  const archShape = () => {
    // (its top just under the pad's: the bevel stands 2.5 proud of the shape)
    const s = new THREE.Shape(), T = 22, R = 24, top = -2.6, inner = -11;
    s.moveTo(0, top);
    s.lineTo(CAP - R, top);
    s.absarc(CAP - R, top - R, R, Math.PI / 2, 0, true);
    s.lineTo(CAP, FLOOR + 4);
    s.absarc(CAP - 4, FLOOR + 4, 4, 0, -Math.PI / 2, true);
    s.lineTo(CAP - T, FLOOR);
    s.lineTo(CAP - T, inner - 12);
    s.absarc(CAP - T - 12, inner - 12, 12, 0, Math.PI / 2, false);
    s.lineTo(0, inner);
    s.lineTo(0, top);
    return s;
  };
  for (const side of [-1, 1]) {
    const geo = new THREE.ExtrudeGeometry(archShape(), { depth: W, bevelEnabled: true, bevelThickness: 2.5, bevelSize: 2.5, bevelSegments: 4, curveSegments: 24 });
    geo.translate(0, 0, -W / 2);
    const arch = new THREE.Mesh(geo, M.white);
    arch.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;     // the shape's +x outward along +-z
    arch.position.set(0, 0, side * deckLen / 2);
    table.add(arch);
    // the pad wraps over the arch's rounded corner (a quarter cylinder across the table: about
    // x, from the top round to the outward face; turned about y for the other end)
    const R = 24, padR = R + 2.9;
    const wrap = new THREE.Mesh(new THREE.CylinderGeometry(padR, padR, PAD_W, 32, 1, true, 0, Math.PI / 2.2), M.black);
    wrap.rotation.z = Math.PI / 2;
    const wg = new THREE.Group(); wg.add(wrap);
    wg.rotation.y = side > 0 ? 0 : Math.PI;
    wg.position.set(0, -2.6 - R, side * (deckLen / 2 + CAP - R));
    table.add(wg);
  }
  // the base plate between the arches, on short feet
  table.add(mesh(rbox(W - 8, 5, deckLen + 6, 1.5), M.plate, 0, FLOOR + 3.5, 0));
  for (const x of [-W / 2 + 4, W / 2 - 4]) for (const z of [-LEN / 2 + 6, LEN / 2 - 6]) table.add(mesh(new THREE.CylinderGeometry(2.4, 2.8, 2, 16), M.greyD, x, FLOOR + 1, z));

  /* ---- the arm: pillar, head, and the source carriage under the table (they travel together) */
  const arm = new THREE.Group();
  const D = LUNAR.ARM_D, px = -W / 2 - 13, headY = LUNAR.HEAD_UNDER;
  // the source carriage: a white box under the deck, on the near side, its emblem outward
  arm.add(mesh(rbox(46, 50, D + 2, 8), M.white, 10, FLOOR + 6 + 26, 0));
  arm.add(mesh(rbox(44, 3, D, 1.2), M.band, 10, FLOOR + 6 + 52, 0));
  const em = decal(emblem(), 17, 17); em.position.set(33.2, FLOOR + 6 + 26, 0); em.rotation.y = Math.PI / 2; arm.add(em);
  // the pillar beside the table: light lower half, darker upper, a seam between
  arm.add(mesh(rbox(20, 70, D - 2, 4), M.white2, px, FLOOR + 35, 0));
  arm.add(mesh(rbox(19, headY + 4 - (FLOOR + 70) + 4, D - 4, 4), M.grey, px, (FLOOR + 70 + headY + 4) / 2, 0));
  arm.add(mesh(rbox(21, 1.4, D - 1, 0.6), M.greyD, px, FLOOR + 70, 0));
  // the head: over the table from the pillar, its far end rounded, a control panel on top
  const headLen = W + 26, hx = px + headLen / 2 - 4;
  arm.add(mesh(rbox(headLen, 10, D, 4.5), M.white, hx, headY + 5, 0));
  arm.add(mesh(rbox(headLen - 4, 3, D - 6, 1.2), M.grey, hx, headY + 0.6, 0));
  const panel = mesh(new THREE.CylinderGeometry(7.5, 7.5, 0.8, 32), M.white2, px + headLen - 16, headY + 10.4, 0);
  panel.scale.set(1.3, 1, 0.9); arm.add(panel);
  const leds = decal(canvasTex(128, 96, (g) => {
    g.clearRect(0, 0, 128, 96);
    [['#ffcf3a', 30, 36], ['#3fd07a', 56, 30], ['#e8473a', 84, 36], ['#3fa8ff', 100, 60]].forEach(([c, x, y]) => {
      g.fillStyle = c; g.beginPath(); g.arc(x, y, 7, 0, 2 * Math.PI); g.fill(); });
    g.strokeStyle = '#9aa1a8'; g.lineWidth = 3; g.beginPath(); g.arc(48, 62, 14, 0, 2 * Math.PI); g.stroke();
  }), 12, 9);
  leds.rotation.x = -Math.PI / 2; leds.position.set(px + headLen - 16, headY + 10.9, 0); arm.add(leds);
  // where the fan is, during a pass: a bright slot on the head's underside that sweeps across
  const sweep = mesh(new THREE.BoxGeometry(5, 0.4, D - 10), new THREE.MeshBasicMaterial({ color: 0x8fd8ff, transparent: true, opacity: 0 }), 0, headY - 1.1, 0);
  arm.add(sweep);

  for (const g of [table, arm]) g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { table, arm, sweep, headX: [px + 6, px + headLen - 6] };
}

/* ---------------------------------------------------------------- the accessories */
// The knee block (the spine's leg positioner): the calves rest on it, hips and knees at 90 degrees,
// which flattens the lumbar lordosis and opens the disc spaces. Origin: its base, centred.
export const BLOCK = { W: 52, H: 38, D: 40 };
export function buildBlock() {
  const M = mats();
  const g = new THREE.Group();
  g.add(mesh(rbox(BLOCK.W, BLOCK.H, BLOCK.D, 4), M.foam, 0, BLOCK.H / 2, 0));
  g.add(mesh(rbox(BLOCK.W + 0.4, 1.4, BLOCK.D + 0.4, 0.6), M.band, 0, BLOCK.H - 4, 0));
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}
// The foot holder (the hip's): an A-frame between the feet, which are strapped against its sides
// turned in, so the femoral necks lie flat. Origin: its base, centred, the frame across x.
export const HOLDER = { W: 24, H: 24, D: 14 };
export function buildHolder(strapSide = -1) {
  const M = mats();
  const g = new THREE.Group();
  const { W, H, D } = HOLDER;
  const len = Math.hypot(W / 2, H), ang = Math.atan2(H, W / 2);
  for (const s of [-1, 1]) {
    const board = mesh(rbox(len, 2, D, 0.8), M.wood, s * W / 4, H / 2, 0);
    board.rotation.z = s * ang;
    g.add(board);
    g.add(mesh(rbox(12, 1.2, D + 2, 0.5), M.wood, s * (W / 2 - 4), 0.6, 0));   // the foot plates
  }
  const pin = mesh(new THREE.CylinderGeometry(1.4, 1.4, D + 1, 16), M.wood, 0, H, 0);
  pin.rotation.x = Math.PI / 2;
  g.add(pin);
  // the strap over the scanned side's foot
  const strap = mesh(rbox(3, 16, D + 4, 1), M.strap, strapSide * (W / 2 - 2), 8, 0);
  strap.rotation.z = strapSide * 0.5;
  g.add(strap);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/* THE LEGS, as phantoms: semi-transparent, drawn from each thigh's cut end (stumps: room cm,
   { p: [x, y, z], r }) in one of two poses, along the patient's long axis (`down`: the unit
   vector toward the feet, in the room):
     'block'   the hips and knees flexed over the knee block (blockZ: the block's near face)
     'holder'  straight along the table, the feet up and turned in against the foot holder */
const SKIN = () => new THREE.MeshStandardMaterial({ color: 0xe2b496, roughness: 0.7, emissive: 0x5a3a28, transparent: true, opacity: 0.55, depthWrite: false });
function limb(a, b, r0, r1, mat) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), len = A.distanceTo(B);
  const g = new THREE.CylinderGeometry(r1, r0, len, 20, 1, false);
  const m = new THREE.Mesh(g, mat);
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  const cap = (p, r) => { const s = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat); s.position.copy(p); return s; };
  const grp = new THREE.Group(); grp.add(m, cap(A, r0), cap(B, r1));
  return grp;
}
export function buildLegs(stumps, pose, down, opts = {}) {
  const mat = SKIN();
  const g = new THREE.Group();
  const d = new THREE.Vector3(...down).setY(0).normalize();
  const side = new THREE.Vector3(-d.z, 0, d.x);                    // across the patient
  for (const st of stumps) {
    const P = new THREE.Vector3(...st.p), r = st.r;
    const s = Math.sign(side.dot(P.clone())) || 1;                // which side of the midline
    if (pose === 'block') {
      // the thigh rises from the stump to the knee over the block's near edge; the calf lies
      // along the block's top; the foot hangs past its far edge
      const knee = P.clone().addScaledVector(d, opts.kneeRun ?? 12).setY(BLOCK.H + 6.5);
      const ankle = knee.clone().addScaledVector(d, 38).setY(BLOCK.H + 5);
      g.add(limb(P.toArray(), knee.toArray(), r, 6.2, mat));
      g.add(limb(knee.toArray(), ankle.toArray(), 6.0, 3.8, mat));
      const toe = ankle.clone().addScaledVector(d, 6).setY(BLOCK.H + 16);
      g.add(limb(ankle.toArray(), toe.toArray(), 4.2, 3.4, mat));
    } else {
      // straight: thigh, calf, then the foot standing up, turned in by `turn` degrees
      const knee = P.clone().addScaledVector(d, 36).setY(6.3);
      const ankle = knee.clone().addScaledVector(d, 40).setY(4.2);
      g.add(limb(P.toArray(), knee.toArray(), r, 6.3, mat));
      g.add(limb(knee.toArray(), ankle.toArray(), 6.1, 3.9, mat));
      const turn = (opts.turn ?? 0) * Math.PI / 180;
      const toeDir = new THREE.Vector3(0, 1, 0).applyAxisAngle(d, -s * turn).normalize();
      const heel = ankle.clone().addScaledVector(d, 3).setY(3.2);
      const toe = heel.clone().addScaledVector(toeDir, 21).addScaledVector(d, 3);
      g.add(limb(heel.toArray(), toe.toArray(), 4.4, 3.6, mat));
    }
  }
  return g;
}
