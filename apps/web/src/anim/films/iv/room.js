/* THE IV ROOM, for the film: the app's own models (iv.js buildIVModels: the arm board, the prep
   table and every supply on it, the closed-system catheter, the flush, the cap) round the app's
   arm, laid out as the room lays them out (placeBoard, placePrep), the catheter placed on the
   vein as the room places it (placeKit: the engine's tip and angle in the vein's frame), and what
   the film adds: the bevel on the needle, the veins, artery and nerve under the skin for the
   cutaways, gloved hands, the tourniquet tied. */
import * as THREE from 'three';
import { buildIVModels } from '../../../iv.js';
import { loadSkin, buildGeometry, buildPatch, makePainter, nearest, featureTube, buildBand, v3 } from './arm.js';
import { setOpacity } from '../../kit/stage.js';

const D = Math.PI / 180;

function orient(obj, pos, dir, up) {
  const x = new THREE.Vector3(...dir).normalize();
  const z = new THREE.Vector3().crossVectors(x, new THREE.Vector3(...up)).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  obj.matrix.makeBasis(x, y, z); obj.matrix.setPosition(...pos);
  obj.matrixAutoUpdate = false; obj.matrixWorldNeedsUpdate = true;
}
export { orient };

export async function buildRoom(api) {
  const R3 = buildIVModels(THREE, api.scene, '20');
  // (the film lights every set alike: the room's own lamps out)
  for (const o of [...R3.group.children]) if (o.isLight) R3.group.remove(o);
  const room = R3.group;

  // ---- the arm, palm up on its board: the antecubital site's geometry, its veins painted
  const arm = await loadSkin(api, 'models/upperextremity/upperextremity_skin.glb');
  room.add(arm.group);
  const G = buildGeometry('antecubital', arm.caster);
  const patch = buildPatch(G, room);
  const painter = makePainter(G, patch);
  const box = new THREE.Box3().setFromObject(arm.group);
  const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
  R3.board.scale.set(sz.x + 10, 2.4, sz.z + 6);
  R3.board.position.set(c.x, box.min.y - 1.2, c.z);
  // the prep table beside the board, on the limb's lateral side (iv.js placePrep)
  {
    const s0 = G.worldAt(0, 0), o = G.toWorld(G.O);
    const flat = (v) => v3.norm([v[0], 0, v[2]]);
    const X = flat(v3.sub(G.toWorld(v3.add(G.O, G.Ax)), o)), Y = [0, 1, 0];
    let side = v3.cross(Y, X);
    if (v3.dot(side, flat(v3.sub(G.toWorld(v3.add(G.O, G.L)), o))) < 0) side = v3.mul(side, -1);
    let half = 0;
    for (const cx of [box.min.x, box.max.x]) for (const cz of [box.min.z, box.max.z]) half = Math.max(half, v3.dot(v3.sub([cx, s0[1], cz], s0), side));
    const at = v3.add([s0[0], box.min.y + 0.4, s0[2]], v3.mul(side, half + 15));
    orient(R3.prep.group, at, X, Y);
    R3.prep.group.updateMatrixWorld(true);
    R3.prep.X = X; R3.prep.Y = Y; R3.prep.Z = v3.cross(X, Y); R3.prep.O = at;
  }
  const prepPoint = (q) => v3.add(R3.prep.O, v3.add(v3.mul(R3.prep.X, q[0]), v3.add(v3.mul(R3.prep.Y, q[1]), v3.mul(R3.prep.Z, q[2]))));

  // ---- the site: on the median cubital, where it runs straight for well over a catheter's length
  const mc = G.feats.find((f) => f.id === 'medianCubital');
  const MA = -0.45, ML = 0.59;
  const nm = nearest(mc, MA, ML);
  const mark = { a: MA, l: ML, tan: nm.tan, lateral: nm.across * 10 };
  // the vein's frame at the mark (iv.js veinFrame): X along it toward the heart, Y across, Z in
  const F = (() => {
    const E = G.worldAt(MA, ML), n = G.normalAt(MA, ML);
    const p1 = G.worldAt(MA + nm.tan[0] * 0.3, ML + nm.tan[1] * 0.3);
    let X = v3.norm(v3.sub(p1, E));
    X = v3.norm(v3.sub(X, v3.mul(n, v3.dot(X, n))));
    const Z = v3.mul(n, -1), Y = v3.norm(v3.cross(Z, X));
    const pY = G.worldAt(MA - nm.tan[1] * 0.3, ML + nm.tan[0] * 0.3);
    const s = v3.dot(v3.sub(pY, E), Y) < 0 ? -1 : 1;
    return { E, X, Y: v3.mul(Y, s), Z, n };
  })();
  const toW = (q) => v3.add(F.E, v3.add(v3.mul(F.X, q[0] / 10), v3.add(v3.mul(F.Y, (q[1] - mark.lateral) / 10), v3.mul(F.Z, q[2] / 10))));
  const dirW = (d) => v3.norm(v3.add(v3.mul(F.X, d[0]), v3.add(v3.mul(F.Y, d[1]), v3.mul(F.Z, d[2]))));
  const onSkin = (w, lift) => { const { a, l } = G.paramOf(G.fromWorld(w)); return v3.add(G.worldAt(a, l), v3.mul(G.normalAt(a, l), lift)); };

  // ---- under the skin: the veins (blue), the brachial artery (red), the median nerve (yellow,
  // medial to the artery: not in the room's data, laid beside it here), for the cutaways
  const under = new THREE.Group(); room.add(under);
  const tubes = {};
  for (const f of G.feats) {
    tubes[f.id] = featureTube(G, f, { color: f.kind === 'artery' ? 0xd23040 : 0x3f5fb8 });
    under.add(tubes[f.id]);
  }
  const art = G.feats.find((f) => f.kind === 'artery');
  const nerveF = { id: 'medianNerve', kind: 'nerve', pts: art.pts.map(([a, l]) => [a, l - 0.75]), radius: 1.6, depth: 11.5 };
  tubes.medianNerve = featureTube(G, nerveF, { color: 0xf2d24a });
  under.add(tubes.medianNerve);
  // valves: a swelling on the vein where each sits (the 'knot' a fingertip finds)
  const valveMeshes = [];
  for (const f of G.feats) for (const [a, l] of f.valves || []) {
    const w = G.worldAt(a, l), n = G.normalAt(a, l), dc = (f.depth + 0.4) / 10 + f.radius / 10;
    const m = new THREE.Mesh(new THREE.SphereGeometry(f.radius / 10 * 1.45, 16, 12), new THREE.MeshStandardMaterial({ color: 0x5b78d0, roughness: 0.4, emissive: 0x2a3c80, emissiveIntensity: 0.4 }));
    m.position.set(w[0] - n[0] * dc, w[1] - n[1] * dc, w[2] - n[2] * dc);
    m.userData.vein = f.id; tubes[f.id].add(m); valveMeshes.push(m);   // (shown with its vein)
  }
  under.visible = false;

  // ---- the tourniquet, 9 cm above the elbow, tied
  const bandMat = new THREE.MeshStandardMaterial({ color: 0xe8875a, side: THREE.DoubleSide, roughness: 0.8 });
  const band = buildBand(G, arm.caster, G.site.tourniquetAlongCm, bandMat);
  room.add(band); band.visible = false;

  // ---- the needle's bevel: the room's needle, cut on a slant at its tip (the point on the side
  // toward the skin: bevel up), hollow
  {
    const r = 0.045, bev = 0.12, Lh = 1.6;
    const cut = (geo, rr) => {
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) if (p.getY(i) > Lh - 1e-4) p.setY(i, Lh - bev * (rr - p.getX(i)) / (2 * rr));
      p.needsUpdate = true; geo.computeVertexNormals(); return geo;
    };
    R3.needle.geometry.dispose();
    R3.needle.geometry = cut(new THREE.CylinderGeometry(r, r, 3.2, 20, 1, true), r);
    R3.needle.material.side = THREE.DoubleSide;
    const lumen = new THREE.Mesh(cut(new THREE.CylinderGeometry(r * 0.72, r * 0.72, 3.19, 16, 1, true), r * 0.72),
      new THREE.MeshBasicMaterial({ color: 0x1a0c0e, side: THREE.BackSide }));
    R3.needle.add(lumen);
    R3.needleLumen = lumen;
  }

  // ---- the kit on the vein (iv.js placeKit), from an engine state
  const kitHubX = (thr, off) => -0.15 - 2.5 - 0.45 + thr + off;
  function drapeExt(on, hubX) {
    const X = R3.extRest;
    const key = on ? R3.kit.matrix.elements.map((v) => v.toFixed(3)).join() + hubX.toFixed(2) : 'rest';
    if (key === R3.drapeKey) return;
    R3.drapeKey = key;
    let pts = X.curve, at2 = { clamp: X.clamp, port: X.port, cap: X.cap };
    if (on) {
      const M = R3.kit.matrix, inv = M.clone().invert();
      const drop = (p, lift) => {
        const w = new THREE.Vector3(p[0] + hubX, p[1], p[2]).applyMatrix4(M);
        const s = onSkin([w.x, w.y, w.z], lift);
        const q = new THREE.Vector3(...s).applyMatrix4(inv);
        return [q.x - hubX, q.y, q.z];
      };
      pts = X.curve.map((p, i) => (i ? drop(p, 0.11) : p));
      at2 = { clamp: drop(X.clamp, 0.2), port: drop(X.port, 0.34), cap: drop(X.cap, 0.3) };
    }
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
    R3.tubing.geometry.dispose(); R3.tubing.geometry = new THREE.TubeGeometry(curve, 40, 0.1, 8, false);
    R3.bloodTube.geometry.dispose(); R3.bloodTube.geometry = new THREE.TubeGeometry(curve, 40, 0.075, 6, false);
    R3.clampM.position.set(...at2.clamp); R3.port.position.set(...at2.port);
    R3.extAt = at2;
  }
  let wingKey = '';
  function conformWings(flat) {
    const key = flat ? R3.kit.matrix.elements.map((v) => v.toFixed(2)).join() : 'rest';
    if (key === wingKey) return;
    wingKey = key;
    R3.kit.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    for (const w of R3.wings) {
      const pos = w.geometry.attributes.position, { rest } = w.userData;
      if (!flat) { pos.array.set(rest); pos.needsUpdate = true; w.geometry.computeVertexNormals(); continue; }
      const M = w.matrixWorld, inv = M.clone().invert();
      for (let i = 0; i < pos.count; i++) {
        v.set(rest[3 * i], rest[3 * i + 1], rest[3 * i + 2]).applyMatrix4(M);
        const { a, l } = G.paramOf(G.fromWorld([v.x, v.y, v.z]));
        const s0 = G.worldAt(a, l), n0 = G.normalAt(a, l);
        const h = (v.x - s0[0]) * n0[0] + (v.y - s0[1]) * n0[1] + (v.z - s0[2]) * n0[2];
        const want = 0.1 + (0.05 - rest[3 * i + 2]);
        v.x += n0[0] * (want - h); v.y += n0[1] * (want - h); v.z += n0[2] * (want - h);
        v.applyMatrix4(inv); pos.setXYZ(i, v.x, v.y, v.z);
      }
      pos.needsUpdate = true; w.geometry.computeVertexNormals();
    }
  }
  /* st: an engine record (tip mm in the vein frame, pitch, thread, withdrawn, shielded, flash,
     line, cathAt); o: { lift (cm off the skin before it goes in), slide (mm, the seal), clampOpen,
     portCap, artery (a bright flash) } */
  function placeKit(st, o = {}) {
    const k = R3.kit; k.visible = true;
    const p = st.pitch * D, dir = [Math.cos(p), 0, Math.sin(p)];
    const dW = dirW(dir);
    let tipW = v3.sub(toW(st.tip), v3.mul(dW, o.lift || 0));
    const up = F.Z.map((x) => -x);
    const thr = st.thread / 10, off = (o.slide || 0) / 10, hubX = kitHubX(thr, off);
    const settled = o.settled ?? (st.thread > 0 && (st.withdrawn > 0 || st.shielded));
    let kd = dW;
    if (settled) {
      kd = v3.norm(v3.sub(dW, v3.mul(up, v3.dot(dW, up))));
      const hubOn = onSkin(v3.add(tipW, v3.mul(dW, hubX)), 0.25);
      tipW = v3.sub(hubOn, v3.mul(kd, hubX));
    }
    orient(k, tipW, kd, up);
    k.updateMatrixWorld(true);
    drapeExt(settled, hubX);
    const back = (st.withdrawn || 0) / 10;
    R3.needle.position.set(-1.6 - back, 0, 0);
    R3.needle.visible = !st.shielded && o.needle !== false;
    R3.cathM.visible = true;
    R3.cathM.position.set(-0.15 - 1.25 + thr + off, 0, 0);
    R3.cathM.rotation.z = -Math.PI / 2;
    if (settled) {
      const a = 30 * D, nose = hubX + 0.4;
      R3.cathM.rotation.z = -Math.PI / 2 - a;
      R3.cathM.position.set(nose + Math.cos(a) * 1.25, -Math.sin(a) * 1.25, 0);
    }
    R3.hub.position.set(hubX, 0, 0);
    R3.ext.position.set(hubX, 0, 0);
    const inLumen = st.flash > 0 && (st.cathAt === 'lumen' || st.thread > 0);
    R3.cathM.material.color.setHex(inLumen ? 0xc9505a : 0xf6f8fa);
    R3.bloodTube.geometry.setDrawRange(0, Math.floor((st.line || 0) * 40) * 6 * 6);
    R3.portTip.material.color.setHex((st.line || 0) >= 1 ? 0x9a1822 : 0xf2f6f9);
    R3.housing.position.set(-0.15 - 2.5 - 0.9 - back, 0, 0);
    R3.housing.visible = !st.shielded && o.needle !== false;
    R3.flashFill.scale.set(1, Math.max(0.01, st.flash), 1);
    R3.flashFill.material.color.setHex(o.artery ? 0xff2a2a : 0x9a0a12);
    R3.flashFill.visible = st.flash > 0.01;
    R3.clampJaw.rotation.z = o.clampOpen === false ? 0 : 0.42;
    R3.portCap.visible = o.portCap !== false;
    R3.sheath.visible = false;
    for (const h of R3.hands) h.visible = false;
    conformWings(settled);
  }
  // in the pack on the table, lifted by `lift` cm, its seal slid `slide` mm (iv.js placeKit, off site)
  function placeKitInPack(lift = 0, slide = 0, { sheath = true, hands = false } = {}) {
    const k = R3.kit; k.visible = true;
    const q = [5.2 + 6, 0.45 + lift, 0.78 - 4];
    orient(k, prepPoint(q), R3.prep.X, R3.prep.Y);
    k.updateMatrixWorld(true);
    const off = slide / 10, hubX = kitHubX(0, off);
    drapeExt(false, hubX);
    R3.needle.position.set(-1.6, 0, 0); R3.needle.visible = true;
    R3.cathM.position.set(-0.15 - 1.25 + off, 0, 0); R3.cathM.rotation.z = -Math.PI / 2; R3.cathM.visible = true;
    R3.cathM.material.color.setHex(0xf6f8fa);
    R3.bloodTube.geometry.setDrawRange(0, 0);
    R3.hub.position.set(hubX, 0, 0); R3.ext.position.set(hubX, 0, 0);
    R3.housing.position.set(-3.55, 0, 0); R3.housing.visible = true;
    R3.flashFill.visible = false;
    R3.sheath.visible = sheath;
    for (const h of R3.hands) h.visible = hands;
    R3.clampJaw.rotation.z = 0.42; R3.portCap.visible = true;
    R3.portTip.material.color.setHex(0xf2f6f9);
    conformWings(false);
  }

  // ---- the flush and the cap on the port (iv.js placeSyringe)
  function placeSyringe({ on = false, left = 1, blood = 0, twist = 0, cap = false, capTwist = 0 } = {}) {
    const s = R3.syringe;
    s.visible = on; R3.luer.visible = cap;
    if (!on && !cap) return;
    R3.kit.updateMatrixWorld(true);
    const pp = R3.port.position;
    const pw = pp.clone().applyMatrix4(R3.ext.matrixWorld);
    const pb = pp.clone().add(new THREE.Vector3(-1, 0, 0)).applyMatrix4(R3.ext.matrixWorld);
    const dir = v3.norm([pb.x - pw.x, pb.y - pw.y, pb.z - pw.z]);
    if (on) {
      orient(s, [pw.x + dir[0] * 0.62, pw.y + dir[1] * 0.62, pw.z + dir[2] * 0.62], v3.mul(dir, -1), v3.cross(v3.mul(dir, -1), [1, 0, 0]));
      R3.plunger.position.x = -0.5 - 5.5 * left;
      R3.saline.scale.set(1, Math.max(0.01, 5.5 * left), 1);
      R3.saline.position.x = -0.5 - 5.5 * left / 2;
      const bl = Math.min(5.5 * left, 1.2 + 9 * blood);
      R3.sBlood.visible = blood > 0.01;
      R3.sBlood.scale.set(1, Math.max(0.01, bl), 1); R3.sBlood.position.x = -0.5 - bl / 2;
      R3.sBlood.material.opacity = Math.min(0.7, 0.25 + blood);
      R3.saline.material.color.setHex(blood > 0.01 ? 0xe9b9bf : 0xd6ecff);
      s.matrix.multiply(new THREE.Matrix4().makeRotationX(twist * D));
    }
    if (cap) {
      orient(R3.luer, [pw.x + dir[0] * 0.55, pw.y + dir[1] * 0.55, pw.z + dir[2] * 0.55], dir, [0, 1, 0]);
      R3.luer.matrix.multiply(new THREE.Matrix4().makeRotationZ(-Math.PI / 2)).multiply(new THREE.Matrix4().makeRotationY(capTwist * D));
    }
  }
  // the port's end, world (where the syringe, the cap, the injector's line connect)
  const portWorld = () => { R3.kit.updateMatrixWorld(true); const v = new THREE.Vector3(-0.6, 0, 0); R3.port.localToWorld(v); return [v.x, v.y, v.z]; };

  // ---- gloved hands
  const glove = new THREE.MeshStandardMaterial({ color: 0x6b8fd6, roughness: 0.42, metalness: 0.02 });
  const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x2b5f7a, roughness: 0.9 });
  const hands = { left: gloveHand(glove, sleeveMat, -1), right: gloveHand(glove, sleeveMat, 1) };
  room.add(hands.left.group, hands.right.group);
  hands.left.group.visible = hands.right.group.visible = false;

  // ---- the cutaway: the skin made see-through, the tubes under it shown
  function cutaway(k) {
    setOpacity(arm.group, 1 - 0.62 * k);
    // (a see-through skin still has to hide the board's far side: drawn after the tubes)
    arm.group.traverse((o) => { if (o.isMesh) o.renderOrder = k > 0 ? 3 : 0; });
    under.visible = k > 0.02;
    patch.mesh.material.opacity = 1 - 0.5 * k;
  }

  const S = { R3, room, arm, G, patch, painter, mark, F, toW, dirW, onSkin, prepPoint, under, tubes, valveMeshes, nerveF, band, bandMat,
    placeKit, placeKitInPack, placeSyringe, portWorld, hands, cutaway, siteW: G.worldAt(MA, ML) };
  return S;
}

/* ---------------------------------------------------------------- a gloved hand
   Built of capsules, jointed: its frame at the wrist, +z toward the fingers, +y the back of the
   hand, +x the thumb's side for a right hand (side 1; -1 a left). pose({ f: [[mcp, pip, dip] x 4],
   thumb: [abd, mcp, ip] }) in degrees, flexion toward the palm. tip(i) the pad of finger i (0
   index .. 3 little, 4 the thumb). A cuffed sleeve runs back from the wrist. */
export function gloveHand(mat, sleeveMat, side = 1) {
  const g = new THREE.Group();
  const inner = new THREE.Group(); inner.scale.x = side; g.add(inner);
  const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18), mat);
  palm.scale.set(4.0, 1.35, 5.0); palm.position.set(0.1, 0, 4.4); inner.add(palm);
  const heel = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), mat);
  heel.scale.set(3.2, 1.6, 2.4); heel.position.set(0.3, -0.2, 1.6); inner.add(heel);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.2, 3, 24), mat);
  cuff.scale.set(1, 1, 0.62); cuff.rotation.x = Math.PI / 2; cuff.position.set(0.2, 0, -0.6); inner.add(cuff);
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 4.2, 22, 24), sleeveMat);
  sleeve.scale.set(1, 1, 0.75); sleeve.rotation.x = Math.PI / 2; sleeve.position.set(0.2, 0, -12.5); inner.add(sleeve);
  const fingers = [];
  const FD = [[2.5, 8.2, 0.82, [4.2, 2.5, 2.0]], [0.75, 8.6, 0.85, [4.6, 2.9, 2.2]], [-1.0, 8.3, 0.8, [4.3, 2.7, 2.1]], [-2.6, 7.6, 0.7, [3.3, 2.0, 1.8]]];
  const chain = (parent, r, lens) => {
    const joints = [];
    let at = parent;
    for (let i = 0; i < lens.length; i++) {
      const j = new THREE.Group(); at.add(j); joints.push(j);
      const L = lens[i], rr = r * (1 - i * 0.07);
      const seg = new THREE.Mesh(new THREE.CapsuleGeometry(rr, Math.max(0.01, L - rr * 1.2), 6, 14), mat);
      seg.rotation.x = Math.PI / 2; seg.position.z = L / 2; seg.scale.set(1, 1, 0.86); j.add(seg);
      const nxt = new THREE.Group(); nxt.position.z = L; j.add(nxt);
      at = nxt;
    }
    const tip = new THREE.Object3D(); tip.position.set(0, -r * 0.55, -r * 0.35); at.add(tip);
    return { joints, tip };
  };
  for (const [x, z, r, lens] of FD) {
    const base = new THREE.Group(); base.position.set(x, 0.1, z); inner.add(base);
    fingers.push(chain(base, r, lens));
  }
  const tb = new THREE.Group(); tb.position.set(2.9, -0.6, 2.4); inner.add(tb);
  const thumb = chain(tb, 1.0, [3.6, 3.0, 2.5]);
  function pose({ f = [[10, 15, 8], [10, 15, 8], [12, 18, 10], [14, 20, 10]], thumb: th = [40, 10, 10], spread = 0 } = {}) {
    fingers.forEach((fg, i) => {
      fg.joints.forEach((j, k) => { j.rotation.set(f[i][k] * D, k === 0 ? (1.5 - i) * spread * D : 0, 0); });
    });
    // the thumb: out from the palm (abduction), then curled across it
    // (rolled first so its pad faces the fingers, then bent toward the palm, then swung out)
    thumb.joints[0].rotation.order = 'YXZ';
    thumb.joints[0].rotation.set(18 * D, (28 + th[0] * 0.5) * D, -65 * D);
    thumb.joints[1].rotation.set(th[1] * D, 0, 0);
    thumb.joints[2].rotation.set(th[2] * D, 0, 0);
  }
  pose();
  const tip = (i) => (i === 4 ? thumb.tip : fingers[i].tip);
  /* Put the hand so the pad of finger i lands on `at`, its frame turned so +z (toward the
     fingers) points along `fwd` and +y (the back) along `up`. */
  function place(i, at, fwd, up) {
    const z = new THREE.Vector3(...fwd).normalize();
    const y0 = new THREE.Vector3(...up);
    const x = new THREE.Vector3().crossVectors(y0, z).normalize();
    const y = new THREE.Vector3().crossVectors(z, x).normalize();
    g.matrixAutoUpdate = true;
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    g.position.set(0, 0, 0); g.updateMatrixWorld(true);
    const p = new THREE.Vector3(); tip(i).getWorldPosition(p);
    const parentInv = g.parent ? new THREE.Matrix4().copy(g.parent.matrixWorld).invert() : new THREE.Matrix4();
    const want = new THREE.Vector3(...at).applyMatrix4(parentInv), have = p.applyMatrix4(parentInv);
    g.position.copy(want.sub(have));
    g.updateMatrixWorld(true);
  }
  return { group: g, pose, place, tip };
}
