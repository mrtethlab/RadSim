/* 3D helpers every film uses: the lighting, see-through cutaways, the x-ray beam as a soft cone,
   ray lines from a focal spot, glow. Units are the app's: cm. */
import * as THREE from 'three';

export function lights(scene, { amb = 1.6, key = 2.2 } = {}) {
  const a = new THREE.AmbientLight(0x6b7785, amb); scene.add(a);
  const k = new THREE.DirectionalLight(0xdff2ff, key); k.position.set(60, 140, 90);
  k.castShadow = true; k.shadow.mapSize.set(2048, 2048);
  Object.assign(k.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, near: 10, far: 500 });
  scene.add(k);
  const rim = new THREE.DirectionalLight(0x35c6d6, 0.35); rim.position.set(-80, 40, -60); scene.add(rim);
  const fill = new THREE.HemisphereLight(0xbfd8ff, 0x1a1410, 0.9); scene.add(fill);
  return { a, k, rim, fill };
}

export const std = (color, roughness = 0.5, metalness = 0.1, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
export const mesh = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; };

/* Opacity for a whole object: its materials are made its own and transparent the first time,
   so fading one object never fades another that shared a material. */
export function setOpacity(obj, a) {
  obj.traverse((o) => {
    if (!o.material) return;
    if (!o.userData.ownMat) {
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
      o.userData.ownMat = true;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) m.userData.baseOpacity = m.opacity;
    }
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) {
      const base = m.userData.baseOpacity ?? 1;
      m.opacity = base * a;
      m.transparent = m.opacity < 0.999 || m.userData.forceTransparent;
      m.depthWrite = m.opacity > 0.6;
    }
  });
  obj.visible = a > 0.003;
}

// a glowing material (filament, hot track, light): its colour, brightness steered by the film
export function glowMat(color = 0xff8a30) {
  return new THREE.MeshStandardMaterial({ color: 0x222222, emissive: color, emissiveIntensity: 0, roughness: 0.6 });
}

/* The x-ray beam: a pyramid from a focal spot to a rectangle, faintly violet, additive. Returns a
   mesh whose geometry set(apex, corners) can reshape every frame. */
export function beamCone(color = 0x9d7bff, opacity = 0.12) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12 * 3), 3));
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity,
    side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
  m.frustumCulled = false;
  m.userData.set = (apex, c) => {
    const p = geo.attributes.position.array;
    let i = 0;
    for (let k = 0; k < 4; k++) {
      const a = c[k], b = c[(k + 1) % 4];
      p.set([...apex, ...a, ...b], i); i += 9;
    }
    geo.attributes.position.needsUpdate = true;
    geo.computeBoundingSphere();
  };
  return m;
}

/* Lines from one point to many (rays from the focal spot past an object's edge), redrawn each
   frame: lines.userData.set(from, [to, ...]). */
export function rayLines(color = 0xffd166, opacity = 0.8, max = 64) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 6), 3));
  geo.setDrawRange(0, 0);
  const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  l.frustumCulled = false;
  l.userData.set = (pairs) => {
    const p = geo.attributes.position.array;
    let n = 0;
    for (const [a, b] of pairs) { if (n >= max) break; p.set([...a, ...b], n * 6); n++; }
    geo.setDrawRange(0, n * 2);
    geo.attributes.position.needsUpdate = true;
  };
  return l;
}

// a flat label-free plane (a screen, a detector face) showing a canvas the film draws on
export function canvasPlane(w, h, cw = 256, ch = 256, emissive = 0.9) {
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({
    map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: emissive, roughness: 0.4 }));
  m.userData.cv = cv; m.userData.g = cv.getContext('2d'); m.userData.tex = tex;
  return m;
}

// a group shown or hidden as one; returns the group for chaining
export function show(obj, on) { if (obj) obj.visible = !!on; return obj; }
