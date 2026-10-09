/* ============================================================================
   LEAD SIDE MARKERS (x-ray)

   An R or L lead letter laid on the receptor. In the room it is a small tile you drag where you
   want it (or drop at the field's edge with a button); on the film it is lead: the beam stops
   under it, so it prints white, and only if it lies inside the collimated field. The letter is
   drawn so that it reads correctly on the film as hung, whichever way the patient was turned.
   After each exposure core/sideMarker.js judges it: wrong side, wrong lateral, collimated off,
   over the anatomy.
   ============================================================================ */
import { markerVerdict } from './core/sideMarker.js';

let ctx = null;
let tile = null, grab = null, tex = null, texSide = null, dragging = false;
const SIZE = 1.8;                      // marker letter box, cm (a lead letter is ~1.5 cm tall)
const LEAD_T = 0.03;                   // transmission of the lead letter at diagnostic kV
const TABLE_Y = 0.12;                  // just above the receptor surface

// the letter as a coverage mask, G x G, readable when drawn top-down
const G = 64;
const glyphs = {};
function glyph(side) {
  if (glyphs[side]) return glyphs[side];
  const c = document.createElement('canvas'); c.width = c.height = G;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.font = 'bold 54px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(side, G / 2, G / 2 + 3);
  const d = g.getImageData(0, 0, G, G).data, a = new Float32Array(G * G);
  for (let k = 0; k < G * G; k++) a[k] = d[k * 4 + 3] / 255;
  return (glyphs[side] = a);
}

function tileTexture(side) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#2b3036'; g.fillRect(0, 0, 64, 64);
  g.strokeStyle = '#ffcf4a'; g.lineWidth = 4; g.strokeRect(2, 2, 60, 60);
  // a plane laid flat by rotation.x = -PI/2 shows its texture upside down to a camera looking
  // down with +z up the screen (see the AEC labels in app.js): turn the canvas, not the mesh
  g.translate(32, 32); g.rotate(Math.PI); g.translate(-32, -32);
  g.fillStyle = '#ffcf4a'; g.font = 'bold 46px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(side, 32, 35);
  return new ctx.THREE.CanvasTexture(c);
}

export function initSideMarker(context) {
  ctx = context;
  const { THREE, three, S } = ctx;
  S.marker = S.marker || { side: null, x: 8, z: 10 };
  tile = new THREE.Mesh(new THREE.BoxGeometry(SIZE, 0.2, SIZE),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, emissive: 0xffffff, emissiveIntensity: 0.45 }));
  tile.position.y = TABLE_Y;
  // a generous, invisible handle: a 1.8 cm tile is a hit-test problem, not a teaching one
  grab = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 5), new THREE.MeshBasicMaterial({ visible: false }));
  tile.add(grab);
  tile.visible = false;
  three.scene.add(tile);

  const $ = ctx.$;
  document.querySelectorAll('#mkSeg button').forEach((b) => b.addEventListener('click', () => {
    S.marker.side = b.dataset.side || null;
    syncUI(); ctx.syncScene();
  }));
  $('mkPlace')?.addEventListener('click', () => { placeAtFieldEdge(); syncUI(); ctx.syncScene(); });
  syncUI();
}

function syncUI() {
  const S = ctx.S;
  document.querySelectorAll('#mkSeg button').forEach((b) => b.classList.toggle('on', (b.dataset.side || null) === S.marker.side));
  const v = ctx.$('mkPosV');
  if (v) v.textContent = S.marker.side ? `${S.marker.x.toFixed(1)}, ${S.marker.z.toFixed(1)} cm` : 'none';
  const p = ctx.$('mkPlace'); if (p) p.disabled = !S.marker.side;
}

/* Drop the marker just inside the field: at the head end, on the side it names for an AP or PA,
   on the +x edge otherwise. Where a radiographer puts it before positioning the last details. */
function placeAtFieldEdge() {
  const S = ctx.S, m = S.marker; if (!m.side) return;
  const r = ctx.rightVec();
  const lateral = Math.abs(r[1]) > Math.abs(r[0]) || !ctx.bilateral();
  const sgn = lateral ? 1 : (m.side === 'R' ? Math.sign(r[0]) || 1 : -(Math.sign(r[0]) || 1));
  m.x = S.tubeX + sgn * (S.collX / 2 - SIZE / 2 - 0.6);
  // a fifth of the way down from the head end: in the field, and clear of the image-view
  // labels that sit in the film's corners
  m.z = S.tubeZ + S.collZ / 2 - Math.max(SIZE / 2 + 0.6, 0.2 * S.collZ);
}

export function sideMarkerSync() {
  if (!tile) return;
  const S = ctx.S, m = S.marker;
  tile.visible = S.mode === 'xray' && !!m.side;
  if (!tile.visible) return;
  if (texSide !== m.side) {
    tex?.dispose(); tex = tileTexture(m.side); texSide = m.side;
    // self-lit a little: the room dims while the collimator lamp is on, and a marker outside the
    // light field should still be findable
    tile.material.map = tex; tile.material.emissiveMap = tex; tile.material.needsUpdate = true;
  }
  tile.position.set(m.x, TABLE_Y, m.z);
  syncUI();
}

/* Drag the tile across the receptor. Returns true when the event was the marker's. */
export function sideMarkerPointer(e, phase, cam, canvas) {
  if (!tile || !tile.visible) return false;
  const { THREE, S } = ctx;
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, cam);
  if (phase === 'down') {
    if (!ray.intersectObject(grab, false).length) return false;
    dragging = true; return true;
  }
  if (!dragging) return false;
  if (phase === 'up') { dragging = false; return true; }
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -TABLE_Y), hit)) return true;
  S.marker.x = Math.max(-28, Math.min(28, hit.x));
  S.marker.z = Math.max(-28, Math.min(28, hit.z));
  sideMarkerSync();
  return true;
}

/* Put the lead on the film: inside the collimated field the letter's pixels let LEAD_T of the
   beam through (the open-beam reference too, so the EI's raw-beam test is not fooled). The
   letter is laid out in DISPLAY orientation (flipH / flipV are the film's hanging flips), so
   it reads correctly as hung. Returns what the verdict needs. Call after scatter and the AEC. */
export function stampSideMarker({ dose, direct, mask, nx, ny, pxU, pxV, flipH, flipV }) {
  const S = ctx.S, m = S.marker;
  if (!m.side) return { inFrac: 0, overTissue: false };
  const a = glyph(m.side);
  const halfU = (nx - 1) / 2, halfV = (ny - 1) / 2;
  const i0 = Math.max(0, Math.floor((m.x - SIZE / 2) / pxU + halfU)), i1 = Math.min(nx - 1, Math.ceil((m.x + SIZE / 2) / pxU + halfU));
  const j0 = Math.max(0, Math.floor((m.z - SIZE / 2) / pxV + halfV)), j1 = Math.min(ny - 1, Math.ceil((m.z + SIZE / 2) / pxV + halfV));
  let inside = 0, rel = 0, relN = 0;
  // the letter's total coverage, so a letter partly off the receptor counts as partly missing
  let total = 0; for (let k = 0; k < a.length; k++) total += a[k];
  const cellArea = (pxU * pxV) / ((SIZE / G) * (SIZE / G));       // glyph cells per detector pixel
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const x = (i - halfU) * pxU - m.x, z = (j - halfV) * pxV - m.z;
    const u = (flipH ? -x : x) / SIZE + 0.5, v = (flipV ? -z : z) / SIZE + 0.5;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
    const w = a[Math.floor(v * G) * G + Math.floor(u * G)];
    if (!w) continue;
    const k = j * nx + i;
    if (!mask[k]) continue;
    inside += w * cellArea;
    if (direct[k] > 0) { rel += dose[k] / direct[k]; relN++; }
    const t = 1 - w * (1 - LEAD_T);
    dose[k] *= t; direct[k] *= t;
  }
  return {
    inFrac: total > 0 ? Math.min(1, inside / total) : 0,
    // OVER THE ANATOMY OF INTEREST: through tissue (beside the part the beam under the letter is
    // raw) AND in the middle of the field. Tissue alone is not enough: a trunk fills its field, so
    // a marker at the field's edge lies on the flank or shoulder as it does clinically; measured,
    // 1-15 % of the open beam reaches the letter there on a pelvis or chest, against ~98 % beside
    // a skull. The error is a letter laid over the part being imaged, near the central ray.
    overTissue: relN > 0 && rel / relN < 0.6
      && Math.abs(m.x - S.tubeX) < 0.3 * S.collX && Math.abs(m.z - S.tubeZ) < 0.3 * S.collZ,
    under: relN > 0 ? rel / relN : null,        // beam under the letter / open beam (QC)
  };
}

export function sideMarkerVerdict(stamp) {
  const S = ctx.S, m = S.marker;
  return markerVerdict({
    side: m.side, inFrac: stamp.inFrac, overTissue: stamp.overTissue,
    bilateral: ctx.bilateral(), rightVec: ctx.rightVec(), dx: m.x - ctx.midlineX(),
  });
}
