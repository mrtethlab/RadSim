/* MODEL EDITOR FILM, chapter 3: editing, and imaging. The editor's slices and its 3D preview;
   a stone brushed into a kidney, the aorta filled with iodine; the model saved as a subject and
   laid on the x-ray table; one ray's walk through the voxels and its Beer-Lambert sum, energy bin
   by energy bin; the projection filling in (the app's engine made it, data.js); then the same
   voxels in CT (sinogram, back-projection), fluoroscopy (a pulse, an image) and ultrasound (the
   materials' impedance). */
import { BodyMaterials } from '../../../core/materials.js';
import { setOpacity } from '../../kit/stage.js';
import { keVColor } from '../../kit/micro.js';
import { RGB, ZE, ID } from './data.js';
import { Img, panel } from './pix.js';

const rgbS = (c, k = 1) => `rgb(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)})`;

export function imaging(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const D = S.D, E = D.E, C = S.ct, R = S.room;

  const boxOf = (pts, pad = 2) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { const [x, y] = api.toPx(p); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
  };
  // the editor's slice on the 8-bit layer: scale s, read from the feet (the patient's right on the left)
  const sx = (ox, s, x) => ox + (E.nx - 1 - x) * s, sy = (oy, s, y) => oy + (E.ny - 1 - y) * s;

  // ---------------------------------------------------------------- the edit's timeline
  const dabSet = (z) => { const out = new Set(); for (const [cx, cy] of E.strokes[z] || []) for (const [x, y] of E.dab(cx, cy)) out.add(x + E.nx * y); return out; };
  const STROKE0 = 1.7, PER = 0.11;
  const SIDE = [[ZE + 1, 4.2], [ZE + 2, 4.6], [ZE + 3, 5.0], [ZE - 1, 5.6], [ZE - 2, 6.0], [ZE - 3, 6.4]];
  const SEL_I = 8.0, CLICK = 8.9, FILL = 2.2;
  const MONT = [ZE + 3, ZE + 7, ZE + 12, ZE + 18, ZE + 25, ZE + 34, ZE - 5, ZE - 10, ZE - 16].map((z, j) => [z, 11.4 + j * 0.38]);
  const BACK = MONT[MONT.length - 1][1] + 0.5;
  const zShown = (t) => {
    let z = ZE;
    for (const [zz, at] of SIDE) if (t >= at) z = zz;
    if (t >= 7.0) z = ZE;
    for (const [zz, at] of MONT) if (t >= at) z = zz;
    if (t >= BACK) z = ZE;
    return z;
  };
  const stoneIdx = new Map(E.stoneOrder.map(([x, y], k) => [x + E.nx * y, k]));
  const fillIdx = new Map(E.fillOrder.map(([x, y], k) => [x + E.nx * y, k]));
  const sideSets = Object.fromEntries(SIDE.map(([z]) => [z, dabSet(z)]));
  // the id the editor shows at (x, y) of slice z, at time t
  function shownId(z, x, y, t) {
    let id = E.orig[E.i(x, y, z)];
    const k = x + E.nx * y;
    if (z === ZE) {
      const s = stoneIdx.get(k);
      if (s != null && t >= STROKE0 + s * PER) id = ID.STONE;
      const f = fillIdx.get(k);
      if (f != null && t >= CLICK + (f / E.fillOrder.length) * FILL) id = ID.IODINE;
    } else {
      const sd = SIDE.find(([zz]) => zz === z);
      if (sd && t >= sd[1] + 0.25 && sideSets[z].has(k)) id = ID.STONE;
      const mt = MONT.find(([zz]) => zz === z);
      if (mt && t >= mt[1] + 0.15 && id === ID.AORTA) id = ID.IODINE;
    }
    return id;
  }
  const edImg = new Img(E.nx, E.ny);
  const paintEd = (t) => {
    const z = zShown(t);
    const nS = z === ZE ? E.stoneOrder.filter((_, k) => t >= STROKE0 + k * PER).length : 0;
    const nF = z === ZE ? Math.floor(clamp01((t - CLICK) / FILL) * E.fillOrder.length) : 0;
    const side = SIDE.find(([zz]) => zz === z), mt = MONT.find(([zz]) => zz === z);
    const key = [z, nS, nF, side && t >= side[1] + 0.25, mt && t >= mt[1] + 0.15].join('/');
    edImg.paint(key, (c, r) => { const id = shownId(z, E.nx - 1 - c, E.ny - 1 - r, t); return id ? RGB[id] : null; });
    return z;
  };
  // the editor's palette (ids 0..28): a grid of swatches
  function palette(x, y, sel, a = 1) {
    const cols = 6, s = 9;
    panel(px, x, y, cols * s + 6, Math.ceil(29 / cols) * s + 6);
    for (let id = 0; id <= 28; id++) {
      const cx = x + 3 + (id % cols) * s, cy = y + 3 + Math.floor(id / cols) * s;
      px.rect(cx, cy, s - 2, s - 2, id === 0 ? '#000000' : rgbS(RGB[id]), a);
      if (id === 0) px.frame(cx, cy, s - 2, s - 2, 'dkgrey');
      if (id === sel) px.frame(cx - 1, cy - 1, s, s, 'yellow');
    }
    return [x, y, cols * s + 6, Math.ceil(29 / cols) * s + 6];
  }
  const swatchAt = (x, y, id) => [x + 3 + (id % 6) * 9 + 3, y + 3 + Math.floor(id / 6) * 9 + 3];
  const brushIcon = api.sprite(['..ww', '.ww.', 'oo..', 'oo..'], { w: 'grey', o: 'orange' });
  const bucketIcon = api.sprite(['.w...', 'wwww.', 'wbbw.', 'wbbwy', '.ww.y'], { w: 'grey', b: 'blue', y: 'yellow' });

  // ---------------------------------------------------------------- the ray walk
  const walk = D.ray.walk.filter((c) => c.inBody), mu60 = (id) => BodyMaterials.muById(id, 60);
  const sliceImg = new Img(E.nx, E.ny);
  sliceImg.paint('ed', (c, r) => { const id = E.data[E.i(E.nx - 1 - c, E.ny - 1 - r, ZE)]; return id ? RGB[id] : null; });
  // a world point of the room on the slice's 8-bit layout (x, y of the volume, continuous)
  const toVox = (p) => [(p[0] - D.phantom.min[0]) / 0.4, (p[1] - D.phantom.min[1]) / 0.4];
  const matName = (id) => BodyMaterials.LIST.find((m) => m.id === id)?.name || '';
  void matName;

  // ---------------------------------------------------------------- images
  const sinoImg = new Img(D.ct.ND, D.ct.NA), reconImg = new Img(E.nx, E.ny);
  const ctRows = (a) => sinoImg.paint('s' + a, (c, r) => { if (r >= a) return [10, 14, 20]; const v = Math.round(255 * Math.min(1, D.ct.sino[r * D.ct.ND + c] / D.ct.smax)); return [v, v, v]; });
  const ctStage = (k) => reconImg.paint('r' + k, (c, r) => {
    const x = E.nx - 1 - c, y = E.ny - 1 - r, hu = D.ct.snaps[k][x + E.nx * y];
    const v = Math.max(0, Math.min(255, Math.round(((hu + 160) / 500) * 255))); return [v, v, v];
  });
  const flImg = new Img(D.fluoro.w, D.fluoro.h);
  const flPulse = (n) => flImg.paint('f' + n, (c, r) => {
    const h = D.fluoro.w / 2, d = Math.hypot(c - h + 0.5, r - h + 0.5);
    if (d > h - 1) return d > h ? null : [40, 44, 50];
    const q = rng(n * 131 + r * 977 + c)();
    const v = Math.max(0, Math.min(255, D.fluoro.grey[r * D.fluoro.w + c] + (q - 0.5) * 26));
    return [v, v, v];
  });
  // the ultrasound sector, as a scanner draws it: the probe at the top, depth down
  const U = D.us, usW = 128, usH = 112, usImg = new Img(usW, usH);
  const usPaint = (line) => usImg.paint('u' + line, (c, r) => {
    // the sector's apex above the image's top centre
    const ax = usW / 2, ay = -U.rFace / U.DEPTH * usH, dx = c - ax, dy = r - ay;
    const d = Math.hypot(dx, dy) / usH * U.DEPTH - U.rFace, a = Math.atan2(dx, dy);
    if (d < 0 || d >= U.DEPTH || Math.abs(a) > U.HALF) return null;
    // (the image's left is the line at the sector's first edge)
    const l = Math.round(((a / U.HALF) * 0.5 + 0.5) * (U.LINES - 1)), k = Math.floor((d / U.DEPTH) * U.NS);
    if (l > line) return [8, 10, 12];
    const v = Math.round(Math.pow(U.img[l * U.NS + k], 0.75) * 255);
    return [v, v, v];
  });

  // ---------------------------------------------------------------- the steps
  const steps = [
    {
      title: 'The Model Editor', dur: 13, fadeIn: 0.5, scale: '10 cm',
      enter() {
        S.only('vol'); S.put(S.shellG, S.sets.vol); setOpacity(S.shell, 1); S.colourShell(false);
        for (const m of S.plates) m.visible = false; S.cap.visible = false; S.dims.visible = false;
        if (S.meshes.skin) S.meshes.skin.visible = false; if (S.meshes.bone) S.meshes.bone.visible = false;
        S.ed.plane.visible = true; S.ed.frame.visible = true; S.ed.glass.visible = true;
      },
      cam: [[0, [70, 52, -95], [0, -2, -4], 38], [13, [92, 40, -70], [0, -2, -4], 38]],
      cues: Array.from({ length: 22 }, (_, k) => [0.8 + k * 0.25, () => sfx.tick()]),
      frame(t) {
        // the slider: up the body, down past it, back to the slice the edits go on
        const k = span(t, 0.8, 6.3, api.ease.linear);
        const z = Math.round(k < 0.35 ? lerp(ZE, 120, k / 0.35) : k < 0.75 ? lerp(120, 40, (k - 0.35) / 0.4) : lerp(40, ZE, (k - 0.75) / 0.25));
        const cut = t < 6.5;
        S.cutShell(cut ? z : null);
        S.paintEd(z, false);
        S.ed.plane.visible = cut;
        if (t > 0.8 && t < 6.5) api.mark(S.ed.frame, 'cyan', t, { live: true });
        if (t >= 6.5) api.mark(S.shellG, 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 6.5, text: 'The <b>Model Editor</b> shows the volume one <b>transverse slice</b> at a time, a voxel thick; its slider steps through them.' },
        { from: 6.5, to: 13, text: 'Beside it, a live 3D preview: a cube for every voxel that touches air. (A preset this big loads at half resolution: 4 mm voxels.)' },
      ],
    },
    {
      title: 'Paint and fill', dur: 17, view: 'pixel', scale: '10 cm',
      cues: [
        ...E.stoneOrder.map((_, k) => [STROKE0 + k * PER, () => sfx.blip(700 + (k % 5) * 40)]),
        ...SIDE.map(([, at]) => [at, () => sfx.tick()]), [7.0, () => sfx.tick()],
        ...SIDE.map(([, at]) => [at + 0.25, () => sfx.blip(760)]),
        [CLICK, () => sfx.click()], [CLICK + 0.05, () => sfx.tone(300, 900, FILL, 'triangle', 0.2)],
        ...MONT.map(([, at]) => [at, () => sfx.tick()]), ...MONT.map(([, at]) => [at + 0.15, () => sfx.blip(990)]),
      ],
      frame(t) {
        px.fillAll('ink');
        const s = 2, ox = 8, oy = 3;
        const z = paintEd(t);
        edImg.draw(px, ox, oy, s);
        px.frame(ox - 1, oy - 1, E.nx * s + 2, E.ny * s + 2, z === ZE ? 'cyan' : 'mid');
        api.keepOut([ox - 1, oy - 1, E.nx * s + 2, E.ny * s + 2]);
        // the palette and the tool
        const px0 = ox + E.nx * s + 12;
        const sel = t < 0.8 ? 10 : t < SEL_I ? ID.STONE : ID.IODINE;
        const pb = palette(px0, oy, sel);
        api.keepOut(pb);
        px.sprite(t < SEL_I ? brushIcon : bucketIcon, px0 + 6, oy + pb[3] + 9, 1, 2);
        // the slider under them: where this slice sits in the volume, and its number
        const sy0 = oy + pb[3] + 22, sw = pb[2];
        px.rect(px0, sy0, sw, 2, 'dkgrey'); px.rect(px0 + (z / (E.nz - 1)) * sw - 1, sy0 - 2, 3, 6, z === ZE ? 'cyan' : 'grey');
        px.text(String(z + 1), px0 + sw, sy0 + 6, z === ZE ? 'cyan' : 'mid', 1, 1, 'right');
        api.keepOut([px0, sy0 - 3, sw, 16]);
        // the cursor: from the palette to the kidney, the stroke, then to the aorta
        const st = E.stone, to = (x, y) => [sx(ox, s, x) + s / 2, sy(oy, s, y) + s / 2];
        const swS = swatchAt(px0, oy, ID.STONE), swI = swatchAt(px0, oy, ID.IODINE);
        let cur;
        if (t < STROKE0) cur = api.lerp3([...swS, 0], [...to(E.strokes[ZE][0][0], E.strokes[ZE][0][1]), 0], span(t, 0.9, STROKE0));
        else if (t < 4) {
          const path = E.strokes[ZE], k = clamp01((t - STROKE0) / (E.stoneOrder.length * PER)) * (path.length - 1), i = Math.min(path.length - 2, Math.floor(k));
          cur = [...api.lerp3([...to(...path[i]), 0], [...to(...path[i + 1]), 0], k - i)];
        } else if (t < SEL_I) cur = [...to(st[0], st[1]), 0];
        else if (t < CLICK) cur = api.lerp3([...swI, 0], [...to(...E.fillSeed), 0], span(t, SEL_I + 0.1, CLICK - 0.1));
        else cur = [...to(...E.fillSeed), 0];
        if (t < SEL_I) px.circle(cur[0], cur[1], (E.brushSize / 2) * s, 'white', 0.9);
        else px.sprite(bucketIcon, cur[0] + 4, cur[1] - 4, 1, 1);
        px.rect(cur[0], cur[1], 1, 1, 'white');
        // what to look at
        if (t > 0.8 && t < 8) api.mark([sx(ox, s, st[0] + 4), sy(oy, s, st[1] + 4), 9 * s, 9 * s], 'yellow', t);
        if (t >= 8) {
          let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
          for (const [x, y] of E.fillOrder) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
          api.mark([sx(ox, s, x1) - 2, sy(oy, s, y1) - 2, (x1 - x0 + 1) * s + 4, (y1 - y0 + 1) * s + 4], 'yellow', t);
        }
      },
      caption: [
        { from: 0.8, to: 8, text: 'The brush sets every voxel under it to the chosen material: a <b>kidney stone</b> (800 HU) in the left kidney, painted on seven slices.' },
        { from: 8, to: 17, text: '<b>Fill</b> floods the connected region of one material under the click: the aorta becomes <b>iodine contrast</b> (350 HU), slice by slice.' },
      ],
    },
    {
      title: 'Saved as a subject', dur: 11, scale: '1 m',
      enter() {
        S.only('room'); S.put(S.shellG, R.g, D.room.centre); setOpacity(S.shell, 1); S.colourShell(true); S.cutShell(null);
        setOpacity(R.r.deck, 1); R.rays.visible = false; R.beam.visible = false; S.paintImage(0);
      },
      cam: [[0, [170, 120, -190], [0, 30, 0], 40], [11, [140, 85, -150], [0, 20, 0], 40]],
      cues: [[0.4, () => sfx.whoosh()], [3.4, () => sfx.chime()]],
      frame(t) {
        const k = span(t, 0.5, 3.4, api.ease.out);
        S.shellG.position.set(D.room.centre[0], D.room.centre[1] + (1 - k) * 70, D.room.centre[2]);
        S.shellG.rotation.y = (1 - k) * 1.2;
        if (t > 0.8) api.mark(S.shellG, 'yellow', t, { live: t < 3.6 });
      },
      caption: [{ from: 0.8, to: 11, text: '<b>Save to session</b> makes the edited volume a subject: the rooms can now lay it on the table, shown as its voxels, and image it.' }],
    },
    {
      title: 'Through the voxels', dur: 15, scale: (t) => (t < 4 ? '10 cm' : '1 cm'),
      enter() {
        S.only('room'); S.put(S.shellG, R.g, D.room.centre); S.shellG.rotation.y = 0; S.colourShell(true);
        setOpacity(S.shell, 0.55); setOpacity(R.r.deck, 0.35); S.paintImage(0);
        R.rays.visible = true; R.beam.visible = true;
      },
      cam: (t) => {
        const st = D.ray.target, d = D.ray.dir;
        const a = { pos: [95, 70, -120], look: [0, 25, 0] };
        const b = { pos: [st[0] - d[0] * 24 + 10, st[1] - d[1] * 24, st[2] - 18], look: st };
        const c = { pos: [st[0] - d[0] * 3 + 0.6, st[1] - d[1] * 3, st[2] - 1.4], look: st };
        const k1 = span(t, 1.8, 4.4), k2 = span(t, 4.4, 6.4);
        const A = t < 4.4 ? a : b, B = t < 4.4 ? b : c, k = t < 4.4 ? k1 : k2;
        return { pos: api.lerp3(A.pos, B.pos, k), look: api.lerp3(A.look, B.look, k), fov: 40 };
      },
      cues: [[4.6, () => sfx.whoosh()], ...Array.from({ length: 28 }, (_, k) => [6.6 + k * 0.25, () => sfx.tick()])],
      frame(t) {
        const s = D.room.source, h = 18, w = 21.6;
        R.beam.userData.set(s, [[-h, 0, -w], [h, 0, -w], [h, 0, w], [-h, 0, w]]);
        // a few of the rays (a sparse grid of the detector's thousands), and the one followed
        const pairs = [];
        for (let i = 0; i < 9; i++) for (let j = 0; j < 7; j++) pairs.push([s, [-h + (i / 8) * 2 * h, 0, -w + (j / 6) * 2 * w]]);
        R.rays.userData.set(pairs);
        if (t < 6.2) {
          const [ax, ay] = api.toPx(s), [bx, by] = api.toPx(D.ray.hit);
          px.line(ax, ay, bx, by, 'yellow', 0.95);
          const [tx, ty] = api.toPx(D.ray.target); px.rect(tx - 1, ty - 1, 3, 3, 'white');
        }
        if (t > 0.6 && t < 6) api.mark(boxOf([D.ray.target, D.ray.hit, [D.ray.target[0], D.ray.target[1] + 18, 0]], 3), 'yellow', t);
        api.mosaic(span(t, 4.8, 6.4));
        if (t < 6.2) return;
        px.alpha = span(t, 6.2, 6.9);
        px.fillAll('ink');
        const sc = 2, ox = 8, oy = 3;
        sliceImg.draw(px, ox, oy, sc);
        const P = (p) => { const [vx, vy] = toVox(p); return [ox + (E.nx - vx) * sc, oy + (E.ny - vy) * sc]; };
        // the ray across the slice (it lies in the slice's plane: the focal spot is level with it)
        const a0 = P(walk[0] ? [D.room.source[0] + D.ray.dir[0] * walk[0].t0, D.room.source[1] + D.ray.dir[1] * walk[0].t0, 0] : D.ray.target);
        const last = walk[walk.length - 1];
        const a1 = P([D.room.source[0] + D.ray.dir[0] * last.t1, D.room.source[1] + D.ray.dir[1] * last.t1, 0]);
        px.line(a0[0], a0[1] - 14, a1[0], a1[1] + 10, 'yellow', 0.35);
        // its cells, one after another
        const n = Math.floor(span(t, 6.6, 13.4, api.ease.linear) * walk.length);
        let sum = 0; const len = new Map();
        for (let i = 0; i < n; i++) {
          const c = walk[i], cx = ox + (E.nx - 1 - c.x) * sc, cy = oy + (E.ny - 1 - c.y) * sc;
          px.frame(cx, cy, sc, sc, i === n - 1 ? 'white' : 'yellow', i === n - 1 ? 1 : 0.65);
          sum += mu60(c.id) * c.len; len.set(c.id, (len.get(c.id) || 0) + c.len);
        }
        api.keepOut([ox, oy, E.nx * sc, E.ny * sc]);
        // the running sums: path length per material, and the sum of mu * length at 60 keV
        const mx = ox + E.nx * sc + 10, mw = px.W - mx - 8, rows = [...len.entries()].sort((p, q) => q[1] - p[1]).slice(0, 6);
        panel(px, mx, oy, mw, 16 + 11 * 6 + 14);
        api.keepOut([mx, oy, mw, 16 + 11 * 6 + 14]);
        px.text('cm', mx + mw - 4, oy + 4, 'mid', 1, 1, 'right');
        rows.forEach(([id, l], i) => {
          const yy = oy + 14 + i * 11;
          px.rect(mx + 4, yy, 6, 6, rgbS(RGB[id]));
          px.rect(mx + 13, yy + 1, Math.min(mw - 40, l * 4), 4, rgbS(RGB[id], 0.8));
          px.text(l.toFixed(1), mx + mw - 4, yy, 'white', 1, 1, 'right');
        });
        const yy = oy + 16 + 11 * 6;
        px.text(sum.toFixed(2), mx + mw - 4, yy, 'yellow', 1, 1, 'right');
        px.text('60 keV', mx + 4, yy, 'mid');
        if (n > 0 && n < walk.length) {
          const c = walk[n - 1];
          api.mark([ox + (E.nx - 1 - c.x) * sc - 5, oy + (E.ny - 1 - c.y) * sc - 5, sc + 10, sc + 10], 'yellow', t);
        } else if (n >= walk.length) api.mark([mx, oy, mw, 16 + 11 * 6 + 14], 'yellow', t);
        px.alpha = 1;
      },
      caption: [
        { from: 0.6, to: 6.2, text: 'For every pixel of the detector, a <b>ray</b> runs from the focal spot through the voxels.' },
        { from: 6.6, to: 15, text: 'It steps from one voxel boundary to the next (an Amanatides–Woo walk), adding up the <b>path length</b> it spends in each material.' },
      ],
    },
    {
      title: 'Energy by energy', dur: 14, view: 'pixel',
      cues: D.ray.bins.map((_, k) => [1.5 + k * 0.28, () => sfx.blip(380 + k * 30)]),
      frame(t) {
        px.fillAll('ink');
        const bins = D.ray.bins, n = bins.length;
        // left: what the ray crossed
        const lx = 8, lw = 92, ly = 14, lh = 14 + 11 * Math.min(7, D.ray.mats.length);
        panel(px, lx, ly, lw, lh); api.keepOut([lx, ly, lw, lh]);
        px.text('cm', lx + lw - 4, ly + 4, 'mid', 1, 1, 'right');
        D.ray.mats.slice(0, 7).forEach(({ id, len }, i) => {
          const yy = ly + 12 + i * 11;
          px.rect(lx + 4, yy, 6, 6, rgbS(RGB[id]));
          px.rect(lx + 13, yy + 1, Math.min(lw - 40, len * 3), 4, rgbS(RGB[id], 0.8));
          px.text(len.toFixed(1), lx + lw - 4, yy, 'white', 1, 1, 'right');
        });
        // right: the beam's bins, each through the path
        const x = lx + lw + 10, w = px.W - x - 8, y = 14, h = 120;
        panel(px, x, y, w, h); api.keepOut([x, y, w, h]);
        // (a log scale: what gets through is a thousandth of what went in, or less)
        const x0 = x + 26, y0 = y + h - 12, pw = w - 32, ph = h - 22, bw = Math.max(2, Math.floor(pw / n) - 1);
        const wMax = Math.max(...bins.map((b) => b.w)), DEC = 7;
        const Hy = (v) => Math.max(0, Math.round(((Math.log10(Math.max(1e-12, v)) + DEC) / DEC) * ph));
        const done = Math.floor(clamp01((t - 1.5) / (n * 0.28)) * n);
        for (const [v, lab] of [[1, '1'], [1e-3, '10^-3'], [1e-6, '10^-6']]) {
          px.line(x0, y0 - Hy(v), x0 + pw, y0 - Hy(v), 'dkgrey', 0.8, 2);
          px.text(lab, x0 - 2, y0 - Hy(v) - 2, 'mid', 1, 1, 'right');
        }
        bins.forEach((b, k) => {
          const xx = x0 + k * (pw / n), hi = Hy(b.w / wMax);
          px.frame(xx, y0 - hi, bw, hi, 'mid', 0.7);
          if (k < done) {
            const ht = Hy((b.w * b.T) / wMax);
            px.rect(xx, y0 - ht, bw, ht, keVColor(b.E));
          }
          if (k === done && done < n) px.rect(xx, y0 - hi, bw, hi, 'yellow', 0.35);
        });
        px.rect(x0, y0, pw, 1, 'mid');
        for (const Ek of [20, 40, 60, 80]) {
          const k = bins.findIndex((b) => b.E >= Ek); if (k < 0) continue;
          px.text(String(Ek), x0 + k * (pw / n), y0 + 3, 'mid', 1, 1, 'center');
        }
        px.text('keV', x + w - 4, y0 + 3, 'mid', 1, 1, 'right');
        // the mean energy, before and after; the whole transmission
        const my = y + h + 6, mw = w;
        panel(px, x, my, mw, 26); api.keepOut([x, my, mw, 26]);
        const k = done / n;
        px.text(D.ray.meanIn.toFixed(0) + ' keV', x + 6, my + 5, 'grey');
        px.text('>', x + mw / 2 - 2, my + 5, 'mid');
        px.text((k >= 1 ? D.ray.meanOut : D.ray.meanIn).toFixed(0) + ' keV', x + mw - 6, my + 5, k >= 1 ? 'yellow' : 'mid', 1, 1, 'right');
        px.text((D.ray.Ttot * 100).toFixed(2) + '%', x + mw / 2, my + 15, k >= 1 ? 'white' : 'mid', 1, 1, 'center');
        if (t > 0.8 && t < 7.5) api.mark([x, y, w, h], 'yellow', t);
        if (t >= 7.5) api.mark([x, my, mw, 26], 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 7.5, text: 'For each energy in the beam, <b>Beer–Lambert</b>: I = I₀ · e<sup>−Σ μ(E) Δx</sup>, every material’s μ at that energy times its path length.' },
        { from: 7.5, to: 14, text: 'Low energies are taken most, so what gets through is <b>harder</b>. The pixel’s signal is the sum over all the energies.' },
      ],
    },
    {
      title: 'The projection', dur: 13, scale: '10 cm',
      enter() {
        S.only('room'); S.put(S.shellG, R.g, D.room.centre); S.shellG.rotation.y = 0; S.colourShell(true);
        setOpacity(S.shell, 0.4); setOpacity(R.r.deck, 0.18); R.rays.visible = true; R.beam.visible = true;
      },
      // (at the end from above, beside the tube head, the head at the top: as a radiograph is read)
      cam: [[0, [70, 85, -75], [0, 0, 0], 40], [8.5, [40, 90, -45], [0, 0, 0], 40], [11, [0, 80, -30], [0, 0, 0], 40]],
      cues: Array.from({ length: 16 }, (_, k) => [1 + k * 0.5, () => sfx.tick()]),
      frame(t) {
        const P = D.proj, rows = Math.floor(span(t, 1, 9, api.ease.linear) * P.h), cols = Math.floor(((span(t, 1, 9, api.ease.linear) * P.h) % 1) * P.w);
        S.paintImage(rows, cols);
        const clear = span(t, 8.5, 10);
        setOpacity(S.shell, lerp(0.4, 0, clear)); setOpacity(R.r.deck, lerp(0.18, 0, clear));
        R.beam.visible = clear < 1;
        api.keepOut(api.boxPx(R.imgPlane, 0));
        const s = D.room.source, hw = (P.w * P.px) / 2, hh = (P.h * P.px) / 2;
        R.beam.userData.set(s, [[-hw, 0, -hh], [hw, 0, -hh], [hw, 0, hh], [-hw, 0, hh]]);
        // the rays to the row being filled
        const z = hh - (Math.min(rows, P.h - 1) + 0.5) * P.px, pairs = [];
        if (rows < P.h) for (let i = 0; i <= 16; i++) pairs.push([s, [hw - (i / 16) * 2 * hw, 0.95, z]]);
        R.rays.userData.set(pairs);
        if (t > 0.8 && t < 7) api.mark(R.imgPlane, 'cyan', t);
        if (t >= 7) {
          const p = D.ray.hit;
          api.mark(boxOf([[p[0] - 2, 1, p[2] - 2], [p[0] + 2, 1, p[2] + 2]], 3), 'yellow', t);
        }
      },
      caption: [
        { from: 0.8, to: 7, text: 'Ray after ray, row by row, the transmitted signals fill the <b>projection</b>: the radiograph of the edited model.' },
        { from: 7, to: 13, text: 'The edit is in it: the <b>stone</b> painted a moment ago shows white over the left kidney, because the rays crossed its voxels.' },
      ],
    },
    {
      title: 'CT of the same voxels', dur: 15, scale: '10 cm',
      enter() {
        S.only('ct'); sfx.stop('gantry');
        if (S.meshes.skin) S.meshes.skin.visible = false; if (S.meshes.bone) S.meshes.bone.visible = false;
        S.put(S.shellG, C.patient); S.shellG.rotation.y = 0; setOpacity(S.shell, 1); S.colourShell(true); S.cutShell(null);
        C.travel.position.z = -S.zOfE(ZE); C.fan.visible = true;
      },
      cam: [[0, [150, 60, -170], [0, -5, -10], 40], [15, [120, 40, -140], [0, -5, -5], 40]],
      cues: [[0.8, () => sfx.power()]],
      frame(t) {
        const a = Math.floor(span(t, 1, 7.4, api.ease.linear) * D.ct.NA);
        C.spin.rotation.z = t * 2.4;
        sfx.hold('gantry', 150, t < 13 ? 0.03 : 0, 'triangle');
        C.scanRing.material.opacity = 0.6 + 0.3 * Math.sin(t * 20);
        // the sinogram (a row a view), the slice back-projected view by view
        ctRows(Math.max(a, 0));
        const sw = Math.round(D.ct.ND * 0.6), sh = Math.round(D.ct.NA * 0.6);
        panel(px, 4, 4, sw + 4, sh + 4); sinoImg.draw(px, 6, 6, 0.6);
        api.keepOut([4, 4, sw + 4, sh + 4]);
        const kk = Math.min(D.ct.stages.length - 1, Math.floor(span(t, 7.6, 12.6, api.ease.linear) * (D.ct.stages.length - 1) + 0.0001));
        ctStage(kk);
        const rx = px.W - E.nx * 1.2 - 8;
        panel(px, rx - 2, 4, E.nx * 1.2 + 4, E.ny * 1.2 + 4); reconImg.draw(px, rx, 6, 1.2);
        api.keepOut([rx - 2, 4, E.nx * 1.2 + 4, E.ny * 1.2 + 4]);
        if (t > 0.8 && t < 7.6) api.mark([4, 4, sw + 4, sh + 4], 'yellow', t);
        if (t >= 7.6) api.mark([rx - 2, 4, E.nx * 1.2 + 4, E.ny * 1.2 + 4], 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 7.6, text: 'CT casts the same rays across the slice from every angle round it: each view is one row of the <b>sinogram</b>.' },
        { from: 7.6, to: 15, text: 'Filtered and <b>back-projected</b>, view by view, the views rebuild the slice as μ in every voxel, shown in HU: the aorta glows with its iodine.' },
      ],
    },
    {
      title: 'Fluoroscopy', dur: 12, scale: '1 m',
      enter() {
        S.only('fluoro'); sfx.stop('gantry');
        S.put(S.shellG, S.fluoro.g, D.room.centre); S.shellG.rotation.y = 0; setOpacity(S.shell, 1); S.colourShell(true);
      },
      cam: [[0, [175, 70, -165], [-20, 15, 0], 40], [12, [150, 55, -140], [-20, 15, 0], 40]],
      cues: Array.from({ length: 40 }, (_, k) => [0.5 + k * 0.25, () => sfx.tone(1800, 1800, 0.02, 'square', 0.12)]),
      frame(t) {
        // pulses at 4 a second (shown slowed): the beam on for a moment, a new frame each time
        const n = Math.floor(Math.max(0, t - 0.5) * 4), ph = ((t - 0.5) * 4) % 1;
        S.fluoro.beam.material.opacity = t > 0.5 && ph < 0.35 ? 0.2 * (1 - ph / 0.35) : 0;
        flPulse(t > 0.5 ? n : -1);
        const s = 1.25, w = D.fluoro.w * s, x = 6, y = 6;
        panel(px, x - 2, y - 2, w + 4, w + 4);
        if (t > 0.5) flImg.draw(px, x, y, s);
        api.keepOut([x - 2, y - 2, w + 4, w + 4]);
        if (t > 0.8) api.mark([x - 2, y - 2, w + 4, w + 4], 'yellow', t);
      },
      caption: [{ from: 0.8, to: 12, text: '<b>Fluoroscopy</b> casts the same projection again for every pulse, many times a second: a live image through the same voxels.' }],
    },
    {
      title: 'Ultrasound', dur: 14, view: 'pixel', scale: '10 cm', fadeOut: 1,
      cues: [[0.8, () => sfx.ping(1760)]],
      frame(t) {
        px.fillAll('ink');
        const sc = 2, ox = 8, oy = 3;
        sliceImg.draw(px, ox, oy, sc);
        api.keepOut([ox, oy, E.nx * sc, E.ny * sc]);
        // the sweep: line by line, again and again (a frame every 2.5 s, shown slowed)
        const sweep = t < 1 ? -1 : Math.floor((((t - 1) % 2.5) / 2.5) * U.LINES);
        const line = t < 3.5 ? sweep : (t - 1) % 2.5 < 0.05 ? U.LINES - 1 : sweep;
        const P = (vx, vy) => [ox + (E.nx - vx) * sc, oy + (E.ny - vy) * sc];
        // the sector on the slice, and the line being fired
        const ap = U.apex, s4 = E.sp;
        const edge = (l) => {
          const a = U.ang0 + (l / (U.LINES - 1) - 0.5) * 2 * U.HALF;
          return [P(ap[0] + (Math.cos(a) * U.rFace) / s4, ap[1] + (Math.sin(a) * U.rFace) / s4), P(ap[0] + (Math.cos(a) * (U.rFace + U.DEPTH)) / s4, ap[1] + (Math.sin(a) * (U.rFace + U.DEPTH)) / s4)];
        };
        for (const l of [0, U.LINES - 1]) { const [a, b] = edge(l); px.line(a[0], a[1], b[0], b[1], 'cyan', 0.6, 2); }
        if (line >= 0) { const [a, b] = edge(Math.min(U.LINES - 1, Math.max(0, line))); px.line(a[0], a[1], b[0], b[1], 'yellow', 0.9); }
        // the probe's face on the skin
        for (let l = 0; l < U.LINES; l += 4) { const [a] = edge(l); px.rect(a[0] - 1, a[1] - 1, 3, 3, 'grey'); }
        // the image, building line by line as a scanner shows it
        const ux = ox + E.nx * sc + 10, uy = 8, k = 1;
        usPaint(t < 3.5 ? line : U.LINES - 1);
        panel(px, ux - 2, uy - 2, usW * k + 4, usH * k + 4);
        usImg.draw(px, ux, uy, k);
        api.keepOut([ux - 2, uy - 2, usW * k + 4, usH * k + 4]);
        const [pa] = edge(Math.floor(U.LINES / 2));
        if (t > 0.8 && t < 7) api.mark([pa[0] - 12, pa[1] - 12, 24, 24], 'yellow', t);
        if (t >= 7) api.mark([ux - 2, uy - 2, usW * k + 4, usH * k + 4], 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 7, text: 'Ultrasound reads the same material ids another way: each material has an acoustic <b>impedance</b> Z, its density times its speed of sound.' },
        { from: 7, to: 14, text: 'Echoes come back from the boundaries where Z changes, ((Z₂ − Z₁)/(Z₂ + Z₁))² of the sound: gas returns nearly all of it, bone much of it, and both leave a <b>shadow</b>.' },
      ],
    },
  ];
  return { title: 'Editing and imaging', steps };
}
