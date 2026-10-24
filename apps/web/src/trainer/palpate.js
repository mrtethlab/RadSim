/* ============================================================================
   PALPATION — where a bony landmark is felt, shown on the skin.

   tools/measure_palpation.py measures each landmark on the model's bone (data/palpation.json):
   the bony point in the x-ray rest frame, and the direction it is felt from. Here the skin point
   is found the way a finger finds it: from the bone, outward along that direction, through the
   patient's own voxels until the last tissue before air. A red mark sits there and moves with the
   patient, so "centre 4 cm above the iliac crest" can be learned by looking, then by hand.
   ============================================================================ */
import palpData from '../data/palpation.json';
import { skinPoint } from '../core/palpation.js';

let ctx = null;              // { THREE, three, S, voxelFlips, objMat, modelCentre }
const marks = new Map();     // key -> { mesh, skin: [x,y,z] rest frame }
let markSubject = null;

export function initPalpation(context) { ctx = context; }

export { skinPoint };
export function palpationList(subject) {
  const d = palpData[subject];
  if (!d) return [];
  return Object.entries(d).map(([key, v]) => ({ key, label: v.label, how: v.how, confidence: v.confidence }));
}

export function setPalpated(key, on) {
  const S = ctx.S, d = palpData[S.subject]?.[key];
  if (!d || !S.voxelModel) return false;
  if (!on) { drop(key); return true; }
  if (marks.has(key)) return true;
  const { THREE, three } = ctx;
  const skin = skinPoint(S.voxelModel, ctx.voxelFlips(), [d.x, d.y, d.z], d.dir);
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.75, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xff2020, depthTest: true }));
  const halo = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.6, 32),
    new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthTest: false }));
  mesh.add(halo);
  mesh.renderOrder = 10; halo.renderOrder = 11;
  (three.rig || three.scene).add(mesh);         // in the room's frame, with the patient
  marks.set(key, { mesh, halo, skin, dir: d.dir });
  markSubject = S.subject;
  palpationSync();
  return true;
}
function drop(key) {
  const m = marks.get(key); if (!m) return;
  m.mesh.parent?.remove(m.mesh);
  m.mesh.geometry.dispose(); m.mesh.material.dispose();
  marks.delete(key);
}
export function clearPalpation() { for (const k of [...marks.keys()]) drop(k); }
export function palpatedKeys() { return [...marks.keys()]; }

/* Keep the marks on the patient: the rest-frame skin point through the patient's rotation and
   position, nudged a few millimetres out of the skin so it is not buried in the surface mesh. */
export function palpationSync() {
  if (!ctx || !marks.size) return;
  const S = ctx.S;
  if (S.subject !== markSubject || S.mode !== 'xray') { clearPalpation(); return; }
  const R = ctx.objMat(), c = ctx.modelCentre();
  const rot = (p) => [R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], R[6] * p[0] + R[7] * p[1] + R[8] * p[2]];
  for (const m of marks.values()) {
    // through the joints first (a bent wrist carries its styloid along), then the patient's pose
    const s0 = ctx.poseLoc ? ctx.poseLoc(m.skin) : m.skin;
    const s1 = ctx.poseLoc ? ctx.poseLoc([m.skin[0] + m.dir[0], m.skin[1] + m.dir[1], m.skin[2] + m.dir[2]]) : null;
    const dl = s1 ? [s1[0] - s0[0], s1[1] - s0[1], s1[2] - s0[2]] : m.dir;
    const p = rot([s0[0] + dl[0] * 0.4, s0[1] + dl[1] * 0.4, s0[2] + dl[2] * 0.4]);
    m.mesh.position.set(p[0] + c[0], p[1] + c[1], p[2] + c[2]);
    // the halo faces out of the skin
    const d = rot(dl);
    // (lookAt takes a world point: the room frame may be stood upright)
    const out = new ctx.THREE.Vector3(m.mesh.position.x + d[0], m.mesh.position.y + d[1], m.mesh.position.z + d[2]);
    m.mesh.updateMatrixWorld(true);
    m.halo.lookAt(m.mesh.parent ? m.mesh.parent.localToWorld(out) : out);
  }
}
