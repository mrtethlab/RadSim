/* Small drawing helpers the fluoroscopy film's chapters share: readout panels, a box round a world
   point, the superscript 2 the 3x5 font lacks, a beam whose outline can be reshaped. */
import * as THREE from 'three';

// a panel of readouts: [label, value, colour] rows, top right unless placed; kept clear of captions
export function hud(api, rows, { x = null, y = 4, w = 50 } = {}) {
  const px = api.px, h = 4 + rows.length * 9;
  x = x == null ? px.W - w - 4 : x;
  px.rect(x, y, w, h, 'ink', 0.88); px.frame(x, y, w, h, 'dkgrey');
  api.keepOut([x, y, w, h]);
  rows.forEach(([lab, val, c], i) => {
    px.text(lab, x + 3, y + 3 + i * 9, 'mid');
    px.text(val, x + w - 3, y + 3 + i * 9, c || 'yellow', 1, 1, 'right');
  });
  return [x, y, w, h];
}

// an empty panel (a plot's or an image's ground), registered as a keep-out
export function panel(api, x, y, w, h, a = 0.9) {
  const px = api.px;
  px.rect(x, y, w, h, 'ink', a); px.frame(x, y, w, h, 'dkgrey');
  api.keepOut([x, y, w, h]);
  return [x, y, w, h];
}

// the screen box (8-bit pixels) of a world box centred on c with half-sizes h
export function boxAt(api, c, h) {
  const hh = Array.isArray(h) ? h : [h, h, h];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const [x, y] = api.toPx([c[0] + (i & 1 ? hh[0] : -hh[0]), c[1] + (i & 2 ? hh[1] : -hh[1]), c[2] + (i & 4 ? hh[2] : -hh[2])]);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

// the screen box of a box given in an object's own frame (min, max corners): follows it as it moves
export function boxLocal(api, obj, min, max) {
  obj.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]).applyMatrix4(obj.matrixWorld);
    const [x, y] = api.toPx(v);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

// "cm" with a small raised 2 after it (the font has no superscripts); returns the width drawn
export function cm2(px, x, y, c = 'mid', a = 1, align = 'left') {
  const w = 9;
  if (align === 'right') x -= w; else if (align === 'center') x -= w / 2;
  px.text('cm', x, y, c, a);
  // a 2 four pixels tall: top bar, down the right, across to the left, bottom bar
  px.rect(x + 8, y - 2, 2, 1, c, a); px.px(x + 9, y - 1, c, a); px.px(x + 8, y, c, a); px.rect(x + 8, y + 1, 2, 1, c, a);
  return w + 1;
}

/* A beam as a fan of triangles from one point to an outline (a circle cut by the shutters, a
   square): set(apex, pts) reshapes it every frame. Faintly violet, additive. */
export function fanBeam(color = 0x9d7bff, opacity = 0.13, max = 96) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 9 * 2), 3));
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity,
    side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
  m.frustumCulled = false;
  m.userData.set = (apex, pts) => {
    const p = geo.attributes.position.array;
    let i = 0;
    const n = Math.min(max, pts.length);
    for (let k = 0; k < n; k++) {
      const a = pts[k], b = pts[(k + 1) % n];
      p.set([...apex, ...a, ...b], i); i += 9;
    }
    // the far end's disc too, so the beam reads as a solid
    for (let k = 1; k < n - 1; k++) { p.set([...pts[0], ...pts[k], ...pts[k + 1]], i); i += 9; }
    geo.setDrawRange(0, i / 3);
    geo.attributes.position.needsUpdate = true;
    geo.computeBoundingSphere();
  };
  return m;
}

/* The outline of the field in its own plane: a circle of radius R (or a square of half-side R)
   cut by the shutters' band |v| <= s turned by rot. Returns [u, v] points. */
export function fieldOutline(R, s = 1e9, rot = 0, square = false, n = 64) {
  const c = Math.cos(rot), sn = Math.sin(rot), out = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    let u = Math.cos(a) * R, v = Math.sin(a) * R;
    if (square) { const m = Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a))); u /= m; v /= m; }
    // into the band's frame, clamp across it, back
    let p = u * c + v * sn, q = -u * sn + v * c;
    q = Math.max(-s, Math.min(s, q));
    u = p * c - q * sn; v = p * sn + q * c;
    out.push([u, v]);
  }
  return out;
}

/* The events (born rate per second, numbered from 0) still worth drawing at time t: those born in the
   last win seconds, and the slowed one (fi) if it has been born, however long ago (it plays slowed).
   So a step that holds on long after its end still draws only a few seconds' worth. */
export function recent(t, rate, win, fi = -1) {
  const i1 = Math.floor(t * rate), i0 = Math.max(0, Math.floor((t - win) * rate)), out = [];
  if (fi >= 0 && fi < i0 && fi <= i1) out.push(fi);
  for (let i = i0; i <= i1; i++) out.push(i);
  return out;
}

// seconds as m:ss
export const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
