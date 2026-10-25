/* MAMMOGRAPHY FILM, chapter 5: the image, and tomosynthesis. The mammograms are the mode's own:
   the breast phantoms cast through mammo.js castMammo with the demo case's findings planted
   (scripts/build-anim-mammo.mjs -> public/anim/mammo_*.png, mammo.json: landmarks, mAs, AGD). From
   the raw signal to the displayed image; the four views hung back to back; what a good pair
   shows; the calcification cluster at the detector's own resolution; density and dose; the
   reading workstation; then tomosynthesis: the sweep, shift-and-add, the slices. */
import * as THREE from 'three';
import { std, mesh, canvasPlane, setOpacity } from '../../kit/stage.js';
import { H0, FOCAL } from './rig.js';
import { drawImg, shrink, hud, grey } from './common.js';

export async function imageChapter(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const R = S.R, T = R.tube, M = S.meta || { views: {}, dbt: { slices: [] } };
  const C = 4.5 / H0;
  const [cc, mlo, ccD, raw, calc] = await Promise.all(['mammo_breast_cc.png', 'mammo_breast_mlo.png', 'mammo_breastdense_cc.png', 'mammo_raw_cc.png', 'mammo_calc.png'].map(S.img));
  const dbt = await Promise.all([0, 1, 2, 3, 4].map((k) => S.img(`mammo_dbt_${k}.png`)));
  const V = M.views || {};
  // the cluster crop read with a narrow window of its own, as a reader zooms and windows in
  const calcWin = (() => { const s = [...calc.a].sort((p, q) => p - q), lo = s[Math.floor(s.length * 0.05)], hi = s[s.length - 1]; return (v) => clamp01((v - lo) / Math.max(0.02, hi - lo)); })();

  /* The displayed orientation: the detector image has the chest wall along row 0 and + lateral
     (CC) or + toward the axilla (MLO) along the row. Hung as a reader sees it: rotated so the
     chest wall is an upright edge and the lateral (axillary) side is up; the right breast with its
     chest wall on the right, the left (its mirror image here) on the left, back to back. */
  const rot = (img, side) => {
    const w = img.h, h = img.w, a = new Float32Array(w * h);
    for (let r = 0; r < img.h; r++) for (let c = 0; c < img.w; c++) {
      const X = side === 'R' ? img.h - 1 - r : r, Y = img.w - 1 - c;
      a[Y * w + X] = img.a[r * img.w + c];
    }
    return { w, h, a };
  };
  // an image point (col u, row y; half-resolution pixels) -> its place on screen when hung
  const hungAt = (img, side, x, y, cell, [u, v]) => [x + (side === 'R' ? img.h - 1 - v : v) * cell, y + (img.w - 1 - u) * cell];
  const cache = new WeakMap();                                   // image -> { side+height: the hung copy }
  const hung = (img, side, hPx) => {
    if (!cache.has(img)) cache.set(img, new Map());
    const own = cache.get(img), key = side + hPx;
    if (!own.has(key)) { const r = rot(img, side); own.set(key, shrink(r, Math.max(2, Math.round(hPx * r.w / r.h)), hPx)); }
    return own.get(key);
  };
  // the reader's grey: a gentle S on the console's display values (a reading LUT)
  const lut = (v) => clamp01(1 / (1 + Math.exp(-6 * (v - 0.48))) * 1.08 - 0.04);
  const marker = (txt, x, y, a = 1) => px.text(txt, x, y, 'white', a);

  // ---- the reading workstation: two portrait monitors, the four views hung on them
  const ws = new THREE.Group(); api.scene.add(ws); S.sets.ws = ws;
  ws.add(mesh(new THREE.BoxGeometry(160, 4, 70), std(0x2a2f36, 0.7, 0.1), 0, 70, 0));        // the desk
  ws.add(mesh(new THREE.PlaneGeometry(600, 300), std(0x15181d, 0.95, 0), 0, 120, -60));
  const floor = mesh(new THREE.CircleGeometry(300, 48).rotateX(-Math.PI / 2), std(0x1b2027, 0.95, 0), 0, 0, 0); ws.add(floor);
  const screens = [];
  for (const sx of [-1, 1]) {
    const g = new THREE.Group(); g.position.set(sx * 21, 72, -12); g.rotation.y = -sx * 0.14; ws.add(g);
    g.add(mesh(new THREE.BoxGeometry(40, 58, 3), std(0x101317, 0.4, 0.2), 0, 38, 0));
    g.add(mesh(new THREE.CylinderGeometry(1.6, 1.6, 10, 12), std(0x3b4148, 0.5, 0.3), 0, 6, -2));
    g.add(mesh(new THREE.BoxGeometry(16, 1.2, 12), std(0x3b4148, 0.5, 0.3), 0, 1, -2));
    const s = canvasPlane(37, 55, 370, 550, 1.0); s.position.set(0, 38, 1.6); g.add(s);
    screens.push(s);
  }
  ws.add(mesh(new THREE.BoxGeometry(44, 1.5, 15), std(0x23272d, 0.6, 0.1), 0, 72.8, 22));        // a keyboard
  const lamp = new THREE.PointLight(0xbfd8ff, 900, 260, 1.6); lamp.position.set(0, 140, 80); ws.add(lamp);
  // paint the hanging: CCs on the left monitor, MLOs on the right, each pair back to back
  const paint = (s, img, l1, l2) => {
    const g = s.userData.g; g.fillStyle = '#000'; g.fillRect(0, 0, 370, 550);
    for (const [side, lab] of [['R', l1], ['L', l2]]) {
      const r = rot(img, side), cv = document.createElement('canvas'); cv.width = r.w; cv.height = r.h;
      const id = cv.getContext('2d').createImageData(r.w, r.h);
      for (let k = 0; k < r.a.length; k++) { const q = Math.round(lut(r.a[k]) * 255); id.data[k * 4] = id.data[k * 4 + 1] = id.data[k * 4 + 2] = q; id.data[k * 4 + 3] = 255; }
      cv.getContext('2d').putImageData(id, 0, 0);
      const ww = 182, hh = Math.round(ww * r.h / r.w), x = side === 'R' ? 185 - ww : 185;
      g.drawImage(cv, x, Math.round((550 - hh) / 2), ww, hh);
      g.fillStyle = '#e8e8e8'; g.font = '16px monospace'; g.fillText(lab, side === 'R' ? 10 : 300, 30);
    }
    s.userData.tex.needsUpdate = true;
  };
  paint(screens[0], cc, 'RCC', 'LCC');
  paint(screens[1], mlo, 'RMLO', 'LMLO');
  ws.visible = false;

  // ---- tomosynthesis (8-bit): shift and add over three projections
  function shiftAdd(t) {
    px.fillAll('ink');
    const W = px.W, H = px.H, cx = Math.round(W / 2), det = 112, k = 10;
    const top = det - 4.5 * k - 4;
    px.rect(cx - 60, top, 120, 4.5 * k, 'fat', 0.15);
    px.rect(cx - 64, det + 2, 128, 3, 'navy');
    const A = { x: -8, d: 1.1, c: 'pink' }, B = { x: 10, d: 3.6, c: 'white' };      // cm from the paddle
    const angs = [-1, 0, 1].map((s) => s * 0.33);
    const srcY = 6, prog = (t % 16);
    const which = prog < 8 ? A : B;                        // the plane brought into focus
    const sh = span(prog % 8, 3, 5.5);                     // shifting the projections into register
    angs.forEach((a, i) => {
      const sx = cx + Math.tan(a) * (det - srcY);
      px.glow(sx, srcY, 3, 'yellow', 0.9, i); px.rect(sx - 1, srcY - 1, 3, 3, 'white');
      for (const O of [A, B]) {
        const oy = top + O.d * k, ox = cx + O.x;
        const hx = sx + (ox - sx) * (det - srcY) / (oy - srcY);
        if (prog % 8 < 3) px.line(sx, srcY, hx, det, i === 1 ? 'violet' : 'lav', 0.35, 2);
        // its shadow in projection row i, shifted so `which` lines up
        const ref = cx + which.x + (cx + which.x - sx) * ((det - srcY) / (top + which.d * k - srcY) - 1);
        const shift = (cx + which.x - ref) * sh;
        px.rect(hx + shift - 2, det + 10 + i * 7, 5, 4, O.c, 0.9);
      }
    });
    for (const O of [A, B]) px.circle(cx + O.x, top + O.d * k, 3, O.c, 1, true);
    // the sum: the plane in register, sharp; the other smeared
    if (sh > 0.95) {
      const y = det + 36;
      px.rect(cx - 64, y - 2, 128, 10, 'ink', 0.9); px.frame(cx - 64, y - 2, 128, 10, 'dkgrey');
      angs.forEach((a, i) => {
        const sx = cx + Math.tan(a) * (det - srcY);
        for (const O of [A, B]) {
          const oy = top + O.d * k, ox = cx + O.x, hx = sx + (ox - sx) * (det - srcY) / (oy - srcY);
          const ref = cx + which.x + (cx + which.x - sx) * ((det - srcY) / (top + which.d * k - srcY) - 1);
          px.rect(hx + (cx + which.x - ref) - 2, y, 5, 6, O.c, O === which ? 0.9 : 0.35);
        }
      });
      api.mark([cx + which.x - 8, y - 4, 16, 14], 'yellow', t);
    }
    px.rect(cx - 70, top + which.d * k, 140, 1, 'yellow', 0.5);
    api.keepOut([cx - 70, 0, 140, det + 50]);
  }

  let lastPulse = -1;
  const dbtSlices = M.dbt?.slices || [];
  const calcZ = M.dbt?.finds?.specks?.[2];
  const steps = [
    {
      title: 'From signal to image', dur: 15, view: 'pixel', fadeIn: 0.4, scale: '10 cm',
      cues: Array.from({ length: 10 }, (_, k) => [0.4 + k * 0.4, () => sfx.tick()]),
      frame(t) {
        px.fillAll('ink');
        const hP = px.H - 16, img = hung(raw, 'R', hP), img2 = hung(cc, 'R', hP);
        const cell = hP / img.h, x = Math.round(px.W * 0.3 - img.w * cell / 2), y = 8;
        // the raw signal arrives row by row (the readout's order), then turns into the image
        const rows = Math.floor(span(t, 0.3, 4.5, api.ease.linear) * img.w);
        const k = span(t, 6.5, 10);
        drawImg(px, { w: img.w, h: img.h, a: img.a.map((v, i) => ((img.w - 1 - (i % img.w)) < rows ? lerp(v, lut(img2.a[i]), k) : 0)) }, x, y, cell);
        // the curve: raw -> log, inverted, windowed
        const gx = Math.round(px.W * 0.62), gw = px.W - gx - 8, gy = 24, gh = 90;
        px.rect(gx, gy, gw, gh, 'ink', 0.85); px.frame(gx, gy, gw, gh, 'dkgrey');
        let lx = null, ly = null;
        for (let i = 0; i <= gw - 3; i++) {
          const u = i / (gw - 3), lin = u, proc = lut(clamp01((-Math.log(Math.max(0.02, u)) - 0.6) / 2.6));
          const v = lerp(lin, proc, k), yy = gy + gh - 2 - v * (gh - 3);
          if (lx != null) px.line(lx, ly, gx + 1 + i, yy, 'yellow'); lx = gx + 1 + i; ly = yy;
        }
        px.text('in', gx + gw - 2, gy + gh + 3, 'mid', 1, 1, 'right'); px.text('out', gx + 2, gy - 7, 'mid');
        api.keepOut([gx, gy - 8, gw, gh + 16]);
        if (t > 4.5) api.mark([x - 2, y - 2, img.w * cell + 4, img.h * cell + 4], 'yellow', t);
      },
      caption: [
        { from: 0.4, to: 6.5, text: 'Row by row the panel’s numbers fill the image: the raw signal, bright where many photons arrived (the air round the breast), flat and the wrong way round.' },
        { from: 6.5, to: 15, text: 'Processing takes its <b>log</b>, inverts it so dense tissue is white, and windows it to the breast’s own narrow range: the mammogram.' },
      ],
    },
    {
      title: 'Four views, back to back', dur: 15, view: 'pixel', scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        const hP = Math.floor((px.H - 22) / 2), gap = 3;
        const set = [[cc, 'R', 'RCC'], [cc, 'L', 'LCC'], [mlo, 'R', 'RMLO'], [mlo, 'L', 'LMLO']];
        const boxes = [];
        set.forEach(([img, side, lab], i) => {
          const h = hung(img, side, hP), cell = 1;
          const x = Math.round(px.W / 2 + (side === 'R' ? -h.w - gap / 2 : gap / 2)), y = 6 + (i >> 1) * (hP + 10);
          const a = span(t, 0.4 + i * 0.6, 1.2 + i * 0.6);
          drawImg(px, h, x, y, cell, lut, { a });
          marker(lab, side === 'R' ? x + 2 : x + h.w - lab.length * 4, y + 2, a);
          boxes.push([x, y, h.w, h.h]);
          api.keepOut([x, y, h.w, h.h]);
        });
        if (t > 3.5 && t < 9) { api.mark(boxes[0], 'yellow', t); api.mark(boxes[1], 'yellow', t); }
        if (t > 9) { api.mark(boxes[2], 'yellow', t); api.mark(boxes[3], 'yellow', t); }
      },
      caption: [
        { from: 0.5, to: 9, text: 'A screening exam is four views: <b>CC</b> and <b>MLO</b> of each breast. They are hung <b>back to back</b>, chest walls together, as mirror images.' },
        { from: 9, to: 15, text: 'Side by side, left and right should look alike: an <b>asymmetry</b>, or anything new against last year’s films, stands out.' },
      ],
    },
    {
      title: 'A well-positioned pair', dur: 15, view: 'pixel', scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        const hP = px.H - 20, gap = 6;
        const vm = V.breast_mlo || {}, vc = V.breast_cc || {};
        const hM = hung(mlo, 'R', hP), hC = hung(cc, 'R', hP);
        const cM = hP / mlo.w, cC = hP / cc.w;                                // screen px per image px
        const xM = Math.round(px.W / 2 - hM.w - gap / 2), xC = Math.round(px.W / 2 + gap / 2), y = 8;
        drawImg(px, hM, xM, y, 1, lut); drawImg(px, hC, xC, y, 1, lut);
        api.keepOut([xM, y, hM.w, hM.h]); api.keepOut([xC, y, hC.w, hC.h]);
        const k = span(t, 1, 2.5);
        // the MLO: the pectoral muscle's border, the PNL from the nipple to it
        if (vm.muscle && k > 0) {
          const a = hungAt(mlo, 'R', xM, y, cM, vm.muscle.tip), b = hungAt(mlo, 'R', xM, y, cM, vm.muscle.top);
          px.line(a[0], a[1], b[0], b[1], 'cyan', k, 2);
        }
        if (vm.pnl && t > 4.5) {
          const a = hungAt(mlo, 'R', xM, y, cM, vm.pnl.from), b = hungAt(mlo, 'R', xM, y, cM, vm.pnl.to);
          px.line(a[0], a[1], b[0], b[1], 'yellow', span(t, 4.5, 5.5));
          px.text(vm.pnl.cm.toFixed(1) + ' cm', (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 8, 'yellow', 1, 1, 'center');
          if (t < 9.5) api.mark([Math.min(a[0], b[0]) - 3, Math.min(a[1], b[1]) - 3, Math.abs(b[0] - a[0]) + 6, Math.abs(b[1] - a[1]) + 6], 'yellow', t);
        }
        if (vc.pnl && t > 9.5) {
          const a = hungAt(cc, 'R', xC, y, cC, vc.pnl.from), b = hungAt(cc, 'R', xC, y, cC, vc.pnl.to);
          px.line(a[0], a[1], b[0], b[1], 'yellow', span(t, 9.5, 10.5));
          px.text(vc.pnl.cm.toFixed(1) + ' cm', (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 8, 'yellow', 1, 1, 'center');
          api.mark([Math.min(a[0], b[0]) - 3, Math.min(a[1], b[1]) - 6, Math.abs(b[0] - a[0]) + 6, Math.abs(b[1] - a[1]) + 12], 'yellow', t);
        }
        if (t > 1 && t < 4.5) api.mark([xM - 2, y - 2, hM.w + 4, hM.h * 0.55], 'cyan', t);
      },
      caption: [
        { from: 1, to: 4.5, text: 'On the MLO the <b>pectoral muscle</b> (its border dashed) runs down to the level of the nipple, its edge convex.' },
        { from: 4.5, to: 9.5, text: 'The <b>posterior nipple line</b> (PNL) runs from the nipple, in profile, back to the muscle at a right angle.' },
        { from: 9.5, to: 15, text: 'On the CC the same line, to the chest-wall edge, must come within 1 cm of the MLO’s: then the CC has reached as deep into the breast.' },
      ],
    },
    {
      title: 'Finding the calcifications', dur: 15, view: 'pixel', scale: (t) => (t < 4 ? '10 cm' : '1 cm'),
      cues: [[4, () => sfx.whoosh()]],
      frame(t) {
        px.fillAll('ink');
        const hP = px.H - 16, h = hung(cc, 'R', hP), cell = hP / cc.w;
        const x = Math.round(px.W / 2 - h.w / 2), y = 8;
        const cr = V.breast_cc?.calcCrop || { x0: 188, y0: 112, size: 36 };
        // the crop's corners on the hung image (rows run right to left on the right breast)
        const p0 = hungAt(cc, 'R', x, y, cell, [cr.x0 + cr.size, cr.y0 + cr.size]), p1 = hungAt(cc, 'R', x, y, cell, [cr.x0, cr.y0]);
        const box = [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.abs(p1[0] - p0[0]), Math.abs(p1[1] - p0[1])];
        const z = span(t, 4, 7);
        drawImg(px, h, x, y, 1, lut, { a: 1 - z * 0.85 });
        if (z <= 0) { api.mark(box, 'yellow', t); return; }
        // the crop at the detector's own pixels (0.245 mm), opening out of its box
        const big = Math.min(px.H - 24, px.W - 24), bx = lerp(box[0], (px.W - big) / 2, z), by = lerp(box[1], 10, z), bs = lerp(box[2], big, z);
        const rc = rot(calc, 'R');
        drawImg(px, rc, bx, by, bs / rc.w, calcWin);
        px.frame(bx - 1, by - 1, bs + 2, bs + 2, 'dkgrey');
        api.keepOut([bx, by, bs, bs]);
        if (t > 7.5) api.mark([bx + bs * 0.2, by + bs * 0.15, bs * 0.65, bs * 0.7], 'yellow', t);
      },
      caption: [
        { from: 0.5, to: 4, text: 'Somewhere in this CC is a cluster of calcifications, invisible at this size.' },
        { from: 7.5, to: 15, text: 'At the detector’s full resolution: a <b>cluster</b> of tiny bright specks, each a few pixels. Their number, shape and spread are what the radiologist judges; a group like this would be recalled for magnification views.' },
      ],
    },
    {
      title: 'Density and dose', dur: 16, view: 'pixel', scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        const hP = px.H - 60, gap = 10;
        const a = hung(cc, 'R', hP), b = hung(ccD, 'R', hP);
        const xa = Math.round(px.W / 2 - a.w - gap / 2), xb = Math.round(px.W / 2 + gap / 2), y = 6;
        // both through one narrower window, so the difference in density is what shows
        const win = (v) => lut(clamp01((v - 0.32) / 0.5));
        drawImg(px, a, xa, y, 1, win); drawImg(px, b, xb, y, 1, win);
        api.keepOut([xa, y, a.w, a.h]); api.keepOut([xb, y, b.w, b.h]);
        // under each: the AEC's mAs and the mean glandular dose, against the 3 mGy limit
        const va = V.breast_cc || { mas: 71, agdMGy: 1.77 }, vb = V.breastdense_cc || { mas: 88, agdMGy: 2.2 };
        const k = span(t, 7, 9), by = y + hP + 6, bw = Math.max(a.w, b.w) - 4;
        for (const [x, v] of [[xa, va], [xb, vb]]) {
          px.text(v.mas + ' mAs', x + 2, by, 'mid');
          px.rect(x + 2, by + 9, bw, 6, 'dkgrey', 0.6);
          px.rect(x + 2, by + 9, bw * (v.agdMGy / 3) * k, 6, v.agdMGy > 2 ? 'orange' : 'lime');
          px.rect(x + 2 + bw - 1, by + 7, 1, 10, 'red');
          px.text(v.agdMGy.toFixed(2) + ' mGy', x + 2, by + 19, 'yellow', k);
          api.keepOut([x, by - 2, bw + 4, 28]);
        }
        if (t > 0.6 && t < 7) api.mark([xb - 2, y - 2, b.w + 4, b.h + 4], 'yellow', t);
        if (t > 7) api.mark([xa, by + 6, xb + bw - xa + 4, 12], 'yellow', t);
      },
      caption: [
        { from: 0.6, to: 7, text: 'A denser breast (right) has more fibroglandular tissue: more of it is white, and a cancer, white too, can hide in it (<b>masking</b>). Density is reported in four grades, a (fatty) to d (extremely dense).' },
        { from: 7, to: 16, text: 'Dense tissue also stops more of the beam, so the AEC gives it more mAs. The dose that matters is the <b>mean glandular dose</b>: about 1.5–2.5 mGy a view here, under the 3 mGy limit (red) for a standard breast.' },
      ],
    },
    {
      title: 'Reading the images', dur: 11, scale: '10 cm',
      enter() { S.only('ws'); },
      cam: [[0, [60, 130, 170], [0, 108, -12], 38], [11, [8, 112, 92], [0, 108, -12], 38]],
      cues: [[0.5, () => sfx.chime()]],
      frame(t) { if (t > 2) { api.mark(screens[0], 'lime', t); api.mark(screens[1], 'lime', t); } },
      caption: [{ from: 2, to: 11, text: 'They are read on a pair of high-resolution (5-megapixel) monitors, the views side by side and against the woman’s previous mammograms.' }],
    },
    {
      title: 'Tomosynthesis: the sweep', dur: 14, scale: '10 cm',
      enter() {
        S.only('unit'); R.gantry.rotation.z = 0; R.setCompression(C); R.setPaddle(R.paddleAt(C)); R.breast.visible = true; R.inside.visible = false;
        for (const o of [R.tubeHead, R.nose, R.snout, R.plate, R.trim]) setOpacity(o, 1);
        R.skinMat.opacity = 1; R.skinMat.transparent = false; R.skinMat.depthWrite = true; T.g.visible = false;
        R.beam.visible = false; R.beam.material.opacity = 0.16;
      },
      cam: [[0, [10, 34, 175], [0, 26, 0], 40], [14, [42, 32, 165], [0, 26, 0], 40]],
      frame(t) {
        // 15 low-dose pulses over a 15 degree arc, 7 s a sweep, then back
        const P = 8, u = (t % P) / 7, n = 15;
        const ang = u <= 1 ? lerp(-7.5, 7.5, u) : lerp(7.5, -7.5, (u - 1) * 7);
        R.tubeArm.rotation.z = -ang * Math.PI / 180;
        const k = Math.floor(u * (n - 1) + 0.5), pulse = u <= 1 && Math.abs(u * (n - 1) - k) < 0.18;
        R.beam.visible = pulse;
        if (pulse && lastPulse !== k) { lastPulse = k; sfx.tick(); } else if (!pulse && u > 1) lastPulse = -1;
        hud(api, [['deg', (ang >= 0 ? '+' : '') + ang.toFixed(1), 'yellow'], ['n', String(u <= 1 ? k + 1 : n), 'lime']], { w: 50 });
        // the focal spot's arc, a dot for each exposure position (lit once fired)
        const Rf = Math.hypot(FOCAL[1], 0);
        for (let j = 0; j < n; j++) {
          const a = lerp(-7.5, 7.5, j / (n - 1)) * Math.PI / 180, q = api.toPx([Math.sin(a) * Rf, Math.cos(a) * Rf, FOCAL[2]]);
          const fired = u <= 1 ? j <= k : true;
          px.rect(q[0] - 1, q[1] - 1, 3, 3, fired ? "yellow" : "dkgrey", fired ? 0.95 : 0.7);
        }
        const top = api.toPx([0, FOCAL[1] + 4, FOCAL[2]]), bot = api.toPx([0, -6, FOCAL[2]]);
        api.keepOut([top[0] - 30, top[1] - 6, 60, bot[1] - top[1] + 6]);
        api.mark(R.tubeHead, "yellow", t, { live: true });
      },
      caption: [
        { from: 0.6, to: 7, text: '<b>Digital breast tomosynthesis</b> (DBT): the breast stays compressed and the detector still, while the tube sweeps an arc, 15° to 50° by maker.' },
        { from: 7, to: 14, text: 'Along the way it fires a series of <b>low-dose</b> exposures, 9 to 25 of them: projections from slightly different angles, for about the dose of one ordinary view.' },
      ],
    },
    {
      title: 'Shift and add', dur: 16, view: 'pixel', scale: '1 cm',
      frame(t) { shiftAdd(t); },
      caption: [
        { from: 0.6, to: 5.5, text: 'Seen from each angle, a structure near the paddle (pink) and one near the detector (white) cast their shadows shifted by different amounts.' },
        { from: 5.5, to: 16, text: 'Shift the projections so one height lines up and add them: structures at that height come <b>sharp</b>, all the others smear out. Each height in turn: a <b>slice</b>.' },
      ],
    },
    {
      title: 'The slices', dur: 16, view: 'pixel', fadeOut: 1.2, scale: '1 cm',
      cues: Array.from({ length: 16 }, (_, k) => [0.6 + k, () => sfx.tick()]),
      frame(t) {
        px.fillAll('ink');
        // scroll down and up through the stack, a slice a second
        const n = dbt.length, cyc = (2 * n - 2), s = Math.floor(t) % cyc, i = s < n ? s : cyc - s;
        const img = dbt[i], hP = px.H - 30, r = rot(img, 'R'), cell = hP / r.h;
        const x = Math.round(px.W / 2 - r.w * cell / 2), y = 8;
        drawImg(px, r, x, y, cell, (v) => v);
        api.keepOut([x, y, r.w * cell, r.h * cell]);
        // the stack's position, as a scale beside it
        const sx = x + r.w * cell + 10, sh = 100;
        px.rect(sx, y + 10, 2, sh, 'dkgrey');
        dbtSlices.forEach((z, j) => px.rect(sx - 2, y + 10 + sh - (j / (n - 1)) * sh, 6, 1, j === i ? 'yellow' : 'mid'));
        px.text(Math.round((dbtSlices[i] || 0) * 10) + ' mm', sx + 6, y + 10 + sh - (i / (n - 1)) * sh - 2, 'yellow');
        api.keepOut([sx - 2, y, 40, sh + 20]);
        // the cluster, sharp only in its own slice
        if (calcZ != null && M.dbt.finds?.specks) {
          const near = dbtSlices.reduce((b, z, j) => (Math.abs(z - calcZ) < Math.abs(dbtSlices[b] - calcZ) ? j : b), 0);
          if (i === near) {
            const [fx, fy] = M.dbt.finds.specks;
            const X = x + (img.h - 1 - fy) * cell, Y = y + (img.w - 1 - fx) * cell;
            api.mark([X - 9, Y - 9, 18, 18], 'yellow', t);
          }
        }
      },
      caption: [
        { from: 0.6, to: 8, text: 'The result is a <b>stack of slices</b>, about 1 mm apart, scrolled through like the pages of a book. Tissue that overlapped on the 2D image is pulled apart.' },
        { from: 8, to: 16, text: 'Each finding is sharp only in its own slice: the calcification cluster comes into focus at its depth. Fewer false alarms, more cancers found in dense breasts.' },
      ],
    },
  ];
  void FOCAL; void grey; void rng; void hud;
  return { title: 'The image and tomosynthesis', steps };
}
