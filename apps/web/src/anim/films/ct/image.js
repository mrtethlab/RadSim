/* CT FILM, chapter 4: the image. The slice as a slab of voxels in the patient; the matrix of CT
   numbers; Hounsfield units read off a chest slice against their scale; the windows (soft tissue,
   lung, bone, brain) on the model's own slices; and the volume: the axial slices stacked in the
   patient and cut again as coronal and sagittal reformats. */
import * as THREE from 'three';
import { setOpacity } from '../../kit/stage.js';
import { HU0, huMap, noiseField, drawSlice, win } from './slice.js';
import { PZ } from './rig.js';
import { hud } from './kit.js';

export function picture(api, S) {
  const { px, sfx, span, lerp, clamp01 } = api;
  const I = S.img;

  // ---------------------------------------------------------------- a canvas of an id image in a window
  const toCanvas = (ids, w, h, L, W, { noise = 0, seed = 5 } = {}) => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'), d = g.createImageData(w, h), nz = noise ? noiseField(w * h, seed) : null;
    for (let i = 0; i < w * h; i++) {
      const v = Math.round(Math.max(0, Math.min(1, win(HU0[ids[i]] + (nz && ids[i] ? noise * nz[i] : 0), L, W))) * 255);
      d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = v; d.data[i * 4 + 3] = ids[i] ? 255 : 0;
    }
    g.putImageData(d, 0, 0);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.NearestFilter;
    return tex;
  };
  const planeMat = (tex) => new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false, alphaTest: 0.02 });

  // ---------------------------------------------------------------- the slab of voxels (3D)
  const COUCH = 75;                                   // the couch, out of the gantry, for these shots
  const mzAbd = (166 + 0.5) * 2 - 356;                // the abdomen slice's mesh z (mm)
  const zAt = (mz) => COUCH + PZ - mz / 10;           // world z of a mesh z (couch at COUCH)
  const vox = new THREE.Group(); S.room.add(vox); S.extras.push(vox);
  const slabTex = toCanvas(I.ax_abd.ids, I.ax_abd.w, I.ax_abd.h, 40, 400);
  const slab = new THREE.Mesh(new THREE.BoxGeometry(41.8, 33, 0.5), [
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.35 }), new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.35 }),
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.35 }), new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.35 }),
    planeMat(slabTex), planeMat(slabTex)]);
  slab.position.set(0, S.ISO_Y, zAt(mzAbd)); vox.add(slab);
  // the voxel grid on its face (every 8th of the 512 lines: each cell here is 8 x 8 voxels)
  const gridPts = [];
  for (let i = 0; i <= 64; i++) { const x = -20.9 + i * 41.8 / 64; gridPts.push(x, -16.5, 0.26, x, 16.5, 0.26); }
  for (let j = 0; j <= 50; j++) { const y = -16.5 + j * 33 / 50; gridPts.push(-20.9, y, 0.26, 20.9, y, 0.26); }
  const gridGeo = new THREE.BufferGeometry(); gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
  const grid = new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: 0x7ff6ff, transparent: true, opacity: 0.35 }));
  slab.add(grid);
  const cube = new THREE.Mesh(new THREE.BoxGeometry(41.8 / 64, 33 / 50, 0.5), new THREE.MeshBasicMaterial({ color: 0xffec27, transparent: true, opacity: 0.85 }));
  cube.position.set(-41.8 / 64 * 9.5, 33 / 50 * 3.5, 0.02); slab.add(cube);
  vox.visible = false;

  // ---------------------------------------------------------------- the stack and its reformats (3D)
  const mpr = new THREE.Group(); S.room.add(mpr); S.extras.push(mpr);
  const sheet = I.stack, tw = Math.ceil(I.ax_abd.w / 2), th = Math.ceil(I.ax_abd.h / 2);
  const stack = [];
  for (let k = 0; k < 24; k++) {
    const ids = new Uint8Array(tw * th), ox = (k % 6) * tw, oy = Math.floor(k / 6) * th;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) ids[y * tw + x] = sheet.ids[(oy + y) * sheet.w + ox + x];
    const zs = Math.round(356 - 8 + (6 - (356 - 8)) * k / 23);          // as the build spaced them
    const mz = (zs + 0.5) * 2 - 356;
    const p = new THREE.Mesh(new THREE.PlaneGeometry(41.8, 33), planeMat(toCanvas(ids, tw, th, 40, 400)));
    p.position.set(0, S.ISO_Y, zAt(mz)); mpr.add(p); stack.push(p);
  }
  // coronal: in the x-z plane, seen from the front (above); sagittal: the y-z plane, seen from the left
  const cor = new THREE.Mesh(new THREE.PlaneGeometry(41.8, 71.2), planeMat(toCanvas(I.cor.ids, I.cor.w, I.cor.h, 40, 400)));
  cor.rotation.x = -Math.PI / 2; cor.position.set(0, S.ISO_Y - 0.4, COUCH + PZ); mpr.add(cor);
  const sag = new THREE.Mesh(new THREE.PlaneGeometry(33, 71.2), planeMat(toCanvas(I.sag.ids, I.sag.w, I.sag.h, 40, 400)));
  sag.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0)));
  sag.position.set(0, S.ISO_Y, COUCH + PZ); mpr.add(sag);
  mpr.visible = false;
  const fade = (m, a) => { m.material.opacity = a; m.visible = a > 0.01; };

  const roomBase = () => {
    S.view({ inside: false, shell: 1, patient: true, injector: false });
    S.rig.couch.visible = S.rig.couchBase.visible = true;
    setOpacity(S.rig.couch, 1); setOpacity(S.rig.couchBase, 1);
    S.setCouch(COUCH, 0); S.setLasers(0);
    vox.visible = false; mpr.visible = false;
  };

  // ---------------------------------------------------------------- the 8-bit pieces
  // a patch of the abdomen across the liver's edge, for the numbers
  const A = I.ax_abd;
  const patchAt = (() => {
    let best = [60, 90], bs = -1;
    for (let y = 20; y < A.h - 8; y += 2) for (let x = 20; x < A.w - 10; x += 2) {
      const n = {};
      for (let j = 0; j < 6; j++) for (let i = 0; i < 8; i++) { const id = A.ids[(y + j) * A.w + x + i]; n[id] = (n[id] || 0) + 1; }
      // liver, fat and muscle side by side, and no cartilage or air to confuse the numbers
      const sc = Math.min(n[11] || 0, 16) + Math.min(n[2] || 0, 12) + Math.min(n[7] || 0, 12) - 20 * ((n[16] || 0) + (n[0] || 0) + (n[47] || 0));
      if (sc > bs) { bs = sc; best = [x, y]; }
    }
    return best;
  })();
  // a probe's stops on the chest slice: inside each tissue, away from its edges
  const C = I.ax_chest;
  const interior = (id, R = 2) => {
    let cx = 0, cy = 0, n = 0;
    for (let y = 0; y < C.h; y++) for (let x = 0; x < C.w; x++) if (C.ids[y * C.w + x] === id) { cx += x; cy += y; n++; }
    if (!n) return [C.w / 2, C.h / 2];
    cx /= n; cy /= n;
    let best = null, bd = Infinity;
    for (let y = 3; y < C.h - 3; y++) for (let x = 3; x < C.w - 3; x++) {
      let ok = true;
      for (let j = -R; j <= R && ok; j++) for (let i = -R; i <= R; i++) if (C.ids[(y + j) * C.w + x + i] !== id) { ok = false; break; }
      if (ok) { const d = Math.hypot(x - cx, y - cy); if (d < bd) { bd = d; best = [x, y]; } }
    }
    return best;
  };
  const stops = [[0, [6, 6]], [1, interior(1)], [2, interior(2)], [7, interior(7)], [15, interior(15)], [18, interior(18, 1) || interior(17, 1)]].filter(([, p]) => p).map(([id, p]) => ({ id, p }));
  stops[0].p = [8, Math.round(C.h / 2)];
  const huC = huMap(C, HU0), nzC = C._nz || (C._nz = noiseField(C.w * C.h, 7));
  const huAt = (x, y) => Math.round(huC[y * C.w + x] + (C.ids[y * C.w + x] ? 8 * nzC[y * C.w + x] : 0));
  // the HU scale: a vertical bar, -1000 at the bottom to +1400 at the top
  function huBar(x, y, h, { L = null, W = null, marks = true } = {}) {
    const lo = -1000, hi = 1400, Y = (hu) => y + h - (hu - lo) / (hi - lo) * h;
    for (let i = 0; i < h; i++) {
      const hu = lo + (1 - i / h) * (hi - lo);
      const g = L == null ? Math.round(clamp01((hu - lo) / (hi - lo)) * 255) : Math.round(clamp01(win(hu, L, W)) * 255);
      px.rect(x, y + i, 8, 1, `rgb(${g},${g},${g})`);
    }
    px.frame(x - 1, y - 1, 10, h + 2, 'dkgrey');
    for (const v of [-1000, -500, 0, 500, 1000]) px.text((v > 0 ? '+' : '') + v, x + 12, Y(v) - 2, 'mid');
    if (marks) for (const [hu, c] of [[-1000, 'navy'], [-700, 'blue'], [-90, 'fat'], [0, 'cyan'], [45, 'pink'], [1200, 'bone']]) px.rect(x - 4, Y(hu), 3, 1, c);
    if (L != null) {
      const a = Y(Math.min(hi, L + W / 2)), b = Y(Math.max(lo, L - W / 2));
      px.rect(x - 3, a, 1, b - a, 'yellow'); px.rect(x - 3, a, 3, 1, 'yellow'); px.rect(x - 3, b, 3, 1, 'yellow');
    }
    return Y;
  }

  const steps = [
    {
      title: 'Voxels', dur: 12, fadeIn: 0.5, scale: (t) => (t < 7 ? '10 cm' : '1 cm'),
      enter() { roomBase(); S.view({ inside: false, shell: 0, patient: true, injector: false, skin: 0.28 }); S.rig.couch.visible = S.rig.couchBase.visible = true; vox.visible = true; S.parts.bone && (S.parts.bone.visible = true); },
      cam: [[0, [110, 70, 170], [0, 4, zAt(mzAbd)], 36], [6, [55, 30, zAt(mzAbd) + 60], [0, 6, zAt(mzAbd)], 34], [12, [-4, 9, zAt(mzAbd) + 14], [-6, 8, zAt(mzAbd)], 34]],
      frame(t) {
        S.sync();
        grid.material.opacity = 0.15 + 0.4 * span(t, 4, 6);
        cube.visible = t > 6.5;
        if (t > 1 && t < 6.5) api.mark(slab, 'yellow', t);
        if (t > 6.5) api.mark(cube, 'yellow', t);
      },
      caption: [
        { from: 1, to: 6.5, text: 'A slice is a <b>slab</b> of the patient, as thick as the slice; the image divides it into <b>voxels</b>.' },
        { from: 6.5, to: 12, text: 'Each voxel becomes one <b>pixel</b>, its grey the voxel’s average attenuation: a structure filling only part of it is averaged in (the partial volume effect).' },
      ],
    },
    {
      title: 'The matrix', dur: 12, view: 'pixel', scale: (t) => (t < 4 ? '10 cm' : '1 cm'),
      cues: [[4, () => sfx.whoosh()]],
      frame(t) {
        px.fillAll('ink');
        const [pxX, pxY] = patchAt;
        const z = span(t, 3.5, 7, api.ease.inOut);
        const s0 = Math.min((px.H - 20) / A.h, (px.W - 70) / A.w), s1 = Math.min((px.W - 20) / 8, (px.H - 60) / 6);
        const s = Math.exp(lerp(Math.log(s0), Math.log(s1), z));
        const cx = pxX + 4, cy = pxY + 3;                          // the patch's centre (image px)
        const fx = lerp(10 + A.w * s0 / 2, px.W / 2, z), fy = lerp(px.H / 2, px.H / 2 - 18, z);
        const ox = fx - (z < 1 ? lerp(A.w / 2, cx, z) : cx) * s, oy = fy - (z < 1 ? lerp(A.h / 2, cy, z) : cy) * s;
        const hu = drawSlice(px, A, ox, oy, s, { L: 40, W: 400, sigma: 8 });
        if (z < 0.05) {
          hud(api, [['', '512x512', 'yellow'], ['FOV', '40 cm', 'cyan'], ['mm', '0.78', 'white']], { x: px.W - 62, y: 10, w: 58 });
          px.frame(ox + pxX * s, oy + pxY * s, 8 * s, 6 * s, 'yellow', 0.8);
          api.mark([ox + pxX * s - 2, oy + pxY * s - 2, 8 * s + 4, 6 * s + 4], 'yellow', t);
        }
        if (z > 0.9) {
          const nz = A._nz;
          for (let j = 0; j < 6; j++) for (let i = 0; i < 8; i++) {
            const X = ox + (pxX + i) * s, Y = oy + (pxY + j) * s, k = (pxY + j) * A.w + pxX + i;
            px.frame(X, Y, s, s, 'dkgrey', 0.8);
            const v = Math.round(hu[k] + (A.ids[k] ? 8 * nz[k] : 0));
            const g = win(v, 40, 400);
            px.text(String(v), X + s / 2, Y + s / 2 - 2, g > 0.55 ? 'ink' : 'lime', clamp01((z - 0.9) * 10), 1, 'center');
          }
          api.keepOut([ox + pxX * s, oy + pxY * s, 8 * s, 6 * s]);
          api.mark([ox + (pxX + 3) * s, oy + (pxY + 2) * s, s, s], 'yellow', t);
        }
      },
      caption: [
        { from: 0.8, to: 4, text: 'The image is a <b>matrix</b>, 512 × 512 pixels across the field of view: a 40 cm field gives pixels 0.78 mm wide.' },
        { from: 7, to: 12, text: 'Each pixel holds one number, its voxel’s attenuation as a <b>CT number</b>.' },
      ],
    },
    {
      title: 'Hounsfield units', dur: 14, view: 'pixel', scale: '10 cm',
      cues: [2, 4, 6, 8, 10, 12].map((tt) => [tt, () => sfx.blip(520)]),
      frame(t) {
        px.fillAll('ink');
        const s = Math.min((px.H - 20) / C.h, (px.W - 80) / C.w), ox = 8, oy = Math.round((px.H - C.h * s) / 2);
        drawSlice(px, C, ox, oy, s, { L: 100, W: 2400, sigma: 8 });
        // the probe stops in each tissue in turn
        const i = Math.min(stops.length - 1, Math.max(0, Math.floor((t - 1) / 2))), k = span(t - 1 - i * 2, 0, 0.6);
        const a = stops[Math.max(0, i - 1)].p, b = stops[i].p, p = i === 0 ? b : [lerp(a[0], b[0], k), lerp(a[1], b[1], k)];
        const X = ox + p[0] * s, Y = oy + p[1] * s;
        px.line(X - 5, Y, X - 2, Y, 'yellow'); px.line(X + 2, Y, X + 5, Y, 'yellow'); px.line(X, Y - 5, X, Y - 2, 'yellow'); px.line(X, Y + 2, X, Y + 5, 'yellow');
        const v = huAt(Math.round(p[0]), Math.round(p[1]));
        const bx = Math.round(ox + C.w * s + 14), Yb = huBar(bx, 14, px.H - 40);
        px.rect(bx - 6, Yb(Math.max(-1000, Math.min(1400, v))), 16, 1, 'yellow');
        px.text((v > 0 ? '+' : '') + v, bx + 4, px.H - 18, 'yellow', 1, 1, 'center');
        px.text('HU', bx + 4, px.H - 10, 'mid', 1, 1, 'center');
        api.keepOut([bx - 8, 8, px.W - bx + 6, px.H - 8]);
        api.mark([X - 7, Y - 7, 14, 14], 'yellow', t, { live: true });
      },
      caption: [
        { from: 0.8, to: 7, text: 'CT numbers are <b>Hounsfield units</b>: each voxel’s μ against water’s, HU = 1000 × (μ − μ<sub>water</sub>) ÷ μ<sub>water</sub>.' },
        { from: 7, to: 14, text: 'Water is 0 and air −1000 by definition; lung about −700, fat −100, soft tissue +20 to +70, bone from +300 to over +1,000.' },
      ],
    },
    {
      title: 'Windows', dur: 20, view: 'pixel', scale: '10 cm',
      cues: [[4, () => sfx.click()], [8, () => sfx.click()], [12, () => sfx.click()], [16, () => sfx.click()]],
      frame(t) {
        px.fillAll('ink');
        // [image, level, width] per section; within a section the window eases in from the last
        const seg = [[I.ax_abd, 1000, 4000], [I.ax_abd, 40, 400], [I.ax_chest, -600, 1500], [I.ax_abd, 400, 1800], [I.ax_head, 40, 80]];
        const i = Math.min(4, Math.floor(t / 4)), k = span(t - i * 4, 0, 1.2);
        const [im, L1, W1] = seg[i], prev = seg[Math.max(0, i - 1)];
        const same = prev[0] === im;
        const L = same ? lerp(prev[1], L1, k) : L1, W = same ? lerp(prev[2], W1, k) : W1;
        const s = Math.min((px.H - 30) / im.h, (px.W - 70) / im.w), ox = Math.round((px.W - 60 - im.w * s) / 2), oy = Math.round((px.H - im.h * s) / 2);
        drawSlice(px, im, ox, oy, s, { L, W, sigma: im === I.ax_head ? 4 : 8, a: same ? 1 : k });
        const bx = px.W - 46;
        huBar(bx, 14, px.H - 50, { L, W, marks: false });
        px.text('W' + Math.round(W), bx + 4, px.H - 30, 'yellow', 1, 1, 'center');
        px.text('L' + Math.round(L), bx + 4, px.H - 22, 'yellow', 1, 1, 'center');
        api.keepOut([bx - 6, 8, 52, px.H - 14]);
        api.mark([ox, oy, im.w * s, im.h * s], 'yellow', t);
      },
      caption: [
        { from: 0.5, to: 4, text: 'The image holds thousands of CT numbers, the eye tells apart only about a hundred greys. The <b>window</b> sets which are spread from black to white: its <b>width</b> how many HU, its <b>level</b> their centre.' },
        { from: 4, to: 8, text: '<b>Soft tissue</b> (W400 L40): liver, spleen, kidneys, vessels, muscle and fat told apart; bone white, air black.' },
        { from: 8, to: 12, text: '<b>Lung</b> (W1500 L−600): the air-filled lung opened up to show its vessels; everything solid is white.' },
        { from: 12, to: 16, text: '<b>Bone</b> (W1800 L400): the cortex and marrow of the spine and ribs; the soft tissues all one grey.' },
        { from: 16, to: 20, text: '<b>Brain</b> (W80 L40): a window only 80 HU wide, for the brain’s small differences; the skull white.' },
      ],
    },
    {
      title: 'A volume', dur: 15, fadeIn: 0.4, scale: '10 cm',
      enter() { roomBase(); S.view({ inside: false, shell: 0, patient: true, injector: false, skin: 0.12 }); S.rig.couch.visible = S.rig.couchBase.visible = true; mpr.visible = true; if (S.parts.bone) S.parts.bone.visible = false; },
      cam: [[0, [100, 62, 150], [0, 4, COUCH - 5], 34], [6, [85, 80, 135], [0, 4, COUCH - 5], 34], [9.5, [45, 120, 105], [0, 2, COUCH - 5], 36], [15, [135, 18, 78], [0, 6, COUCH - 5], 36]],
      frame(t) {
        const n = Math.floor(24 * span(t, 0.5, 5.5, api.ease.linear));
        const back = span(t, 6, 7.2);
        stack.forEach((p, k) => fade(p, k < n ? lerp(0.95, 0.16, back) * (1 - 0.6 * span(t, 10, 11)) : 0));
        fade(cor, span(t, 6.2, 7.6) * (1 - 0.7 * span(t, 10, 11)));
        fade(sag, span(t, 10.2, 11.6));
        S.sync();
        if (t > 0.8 && t < 6.2) api.mark(stack[Math.max(0, Math.min(23, n - 1))], 'yellow', t);
        if (t > 6.2 && t < 10.2) api.mark(cor, 'cyan', t);
        if (t > 10.2) api.mark(sag, 'cyan', t);
      },
      caption: [
        { from: 0.8, to: 6.2, text: 'Thin axial slices stack up into a <b>volume</b> of near-cubic voxels.' },
        { from: 6.2, to: 15, text: 'Cut it along any plane: <b>coronal</b> and <b>sagittal</b> reformats (multiplanar reformation, MPR) from the same data, with no new scan.' },
      ],
    },
    {
      title: 'Coronal and sagittal', dur: 10, view: 'pixel', fadeOut: 0.5, scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        const h = px.H - 16, s = h / I.cor.h, wc = I.cor.w * s, ws = I.sag.w * s, gap = 10;
        const x0 = Math.round((px.W - wc - ws - gap) / 2), y0 = 8;
        const k = span(t, 0.2, 1.2);
        drawSlice(px, I.cor, x0, y0, s, { L: 40, W: 400, sigma: 6, a: k, seed: 9 });
        drawSlice(px, I.sag, x0 + wc + gap, y0, s, { L: 40, W: 400, sigma: 6, a: k, seed: 10 });
        api.keepOut([x0, y0, wc + ws + gap, h]);
        if (t > 1 && t < 5.5) api.mark([x0, y0, wc, h], 'cyan', t);
        if (t > 5.5) api.mark([x0 + wc + gap, y0, ws, h], 'cyan', t);
      },
      caption: [
        { from: 1, to: 5.5, text: 'The <b>coronal</b> reformat: the body seen from the front, head up, its right on the viewer’s left.', place: 'right' },
        { from: 5.5, to: 10, text: 'The <b>sagittal</b>: seen from the side, the whole spine at once.', place: 'left' },
      ],
    },
  ];
  return { title: 'The image', steps };
}
