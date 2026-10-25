/* MODEL EDITOR FILM, chapter 1: from a scan to a model. The patient through the CT; the slices
   stacked into a volume; one voxel and its HU; the segmentation's labels; labels and HU turned
   into material ids (services/compute build_model.py materialize: the thresholds below are its);
   the volume written out a byte a voxel; the display surfaces cut from it. */
import * as THREE from 'three';
import { setOpacity } from '../../kit/stage.js';
import { RGB, SLICE, ID, huOfId } from './data.js';
import { Img, panel, mix } from './pix.js';

// a filled polygon on the 8-bit layer (small shapes: an isometric cube's faces)
export function fillPoly(px, pts, c, a = 1) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const g = px.g; g.globalAlpha = a * px.alpha; g.fillStyle = px.col(c);
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= y + 0.5 && by > y + 0.5) || (by <= y + 0.5 && ay > y + 0.5)) xs.push(ax + ((y + 0.5 - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) g.fillRect(Math.round(xs[k]), y, Math.max(1, Math.round(xs[k + 1]) - Math.round(xs[k])), 1);
  }
  g.globalAlpha = 1;
}
const rgbS = (c, k = 1) => `rgb(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)})`;

export function scanning(api, S) {
  const { px, sfx, span, lerp, clamp01 } = api;
  const D = S.D, E = D.E, C = S.ct;
  const W = () => px.W;

  // a box round a set of world points, in 8-bit pixels
  const boxOf = (pts, pad = 2) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { const [x, y] = api.toPx(p); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
  };
  const ex = S.extF;                                             // the volume's extent, cm
  const blockProxy = new THREE.Mesh(new THREE.BoxGeometry(ex[0], ex[1], ex[2]), new THREE.MeshBasicMaterial({ visible: false }));
  S.sets.vol.add(blockProxy);

  // ---- the slice SLICE on the 8-bit layer, a voxel a pixel, read from the feet
  const sl = new Img(D.nx, D.ny);
  const hu = D.huSlice(SLICE);
  const greyAt = (x, y) => { const v = D.grey(hu[x + D.nx * y]); return [v, v, v]; };
  const idAt = (x, y) => D.at(x, y, SLICE);
  const toXY = (c, r) => [D.nx - 1 - c, D.ny - 1 - r];         // screen (col, row) -> volume (x, y)
  // the structures the segmentation labels on this slice, in the order the film fills them in
  const LABELS = [
    { ids: [ID.KIDNEY] }, { ids: [ID.AORTA] }, { ids: [33] }, { ids: [ID.LIVER] },
    { ids: [51] }, { ids: [52, 47] }, { ids: [17, 18] },
  ];
  const labelled = new Set([5, 6, 11, 12, 13, 14, 15, 16, 17, 18, ...Array.from({ length: 24 }, (_, i) => 29 + i)]);
  for (const L of LABELS) {
    let n = 0, sx = 0, sy = 0, c0 = 1e9, r0 = 1e9, c1 = -1, r1 = -1;
    for (let r = 0; r < D.ny; r++) for (let c = 0; c < D.nx; c++) {
      const [x, y] = toXY(c, r);
      if (!L.ids.includes(idAt(x, y))) continue;
      n++; sx += c; sy += r; c0 = Math.min(c0, c); r0 = Math.min(r0, r); c1 = Math.max(c1, c); r1 = Math.max(r1, r);
    }
    L.c = [sx / n, sy / n]; L.box = [c0, r0, c1 - c0 + 1, r1 - r0 + 1];
    // the farthest any of its voxels lies from its middle (for the fill's spread)
    L.R = Math.hypot(Math.max(L.c[0] - c0, c1 - L.c[0]), Math.max(L.c[1] - r0, r1 - L.c[1])) + 1;
  }
  const labelOf = (id) => LABELS.findIndex((L) => L.ids.includes(id));
  // how far a voxel's label has filled in by time t (k: 0..1 of its spread)
  const segAt = (t) => LABELS.map((L, i) => clamp01((t - 1.2 - i * 1.15) / 0.9));
  // (high in the frame: the caption has the band under it)
  const sliceOrigin = () => [Math.round(W() / 2 - D.nx / 2), 3];

  // ---- the HU thresholds build_model.py gives a voxel no label has claimed
  const BANDS = [
    { lo: -1000, hi: -190, id: 1 }, { lo: -190, hi: -30, id: 2 }, { lo: -30, hi: 120, id: 7 },
    { lo: 120, hi: 300, id: 17 }, { lo: 300, hi: 1500, id: 18 },
  ];
  function bandPlot(x, y, w, h, k) {
    panel(px, x, y, w, h);
    const x0 = x + 4, x1 = x + w - 4, yb = y + h - 12;
    const X = (v) => x0 + ((v + 1000) / 2500) * (x1 - x0);
    BANDS.forEach((b, i) => {
      const kk = clamp01(k * BANDS.length - i);
      if (kk <= 0) return;
      px.rect(X(b.lo), yb - 14, (X(b.hi) - X(b.lo)) * kk, 14, rgbS(RGB[b.id]), 0.95);
    });
    px.rect(x0, yb, x1 - x0, 1, 'mid');
    for (const v of [-1000, -190, 120, 1500]) { px.rect(X(v), yb, 1, 3, 'mid'); }
    px.text('-1000', X(-1000), yb + 4, 'mid', 1, 1, 'left');
    px.text('-190', X(-190), yb + 4, 'grey', 1, 1, 'center');
    px.text('120', X(120) + 2, yb + 4, 'grey', 1, 1, 'center');
    px.text('HU', x1, y + 3, 'mid', 1, 1, 'right');
    // the two edges inside the soft band, above the bar
    for (const v of [-30, 300]) { px.rect(X(v), yb - 17, 1, 3, 'grey'); }
    px.text('-30', X(-30), yb - 23, 'grey', 1, 1, 'center');
    px.text('300', X(300), yb - 23, 'grey', 1, 1, 'center');
    return [x, y, w, h];
  }

  // ---- an isometric cube (the voxel lifted out)
  function isoCube(cx, cy, s, c, a = 1) {
    const h = s * 0.5, w = s * 0.866;
    const top = [[cx, cy - s], [cx + w, cy - s + h], [cx, cy - s + 2 * h], [cx - w, cy - s + h]];
    const left = [[cx - w, cy - s + h], [cx, cy - s + 2 * h], [cx, cy + 2 * h], [cx - w, cy + h]];
    const right = [[cx, cy - s + 2 * h], [cx + w, cy - s + h], [cx + w, cy + h], [cx, cy + 2 * h]];
    fillPoly(px, top, rgbS(c, 1.15), a); fillPoly(px, left, rgbS(c, 0.8), a); fillPoly(px, right, rgbS(c, 0.6), a);
    for (const f of [top, left, right]) for (let i = 0; i < 4; i++) px.line(f[i][0], f[i][1], f[(i + 1) % 4][0], f[(i + 1) % 4][1], 'white', 0.5 * a);
    return { top, left, right, w, h };
  }

  // ---- the byte block: a 6 x 4 x 3 corner of the volume by the left kidney
  const B = { x0: 48, y0: 56, z0: SLICE, nx: 6, ny: 4, nz: 3 };
  const bId = (x, y, z) => D.at(B.x0 + x, B.y0 + y, B.z0 + z);
  const gIdx = (x, y, z) => (B.x0 + x) + D.nx * ((B.y0 + y) + D.ny * (B.z0 + z));

  const steps = [
    {
      title: 'A CT scan', dur: 12, fadeIn: 0.8, scale: '1 m',
      enter() {
        S.only('ct');
        if (S.meshes.skin) { S.put(S.meshes.skin, C.patient); setOpacity(S.meshes.skin, 0.4); }
        if (S.meshes.bone) { S.put(S.meshes.bone, C.patient); setOpacity(S.meshes.bone, 1); }
        if (S.shellG.parent) S.shellG.parent.remove(S.shellG);
      },
      cam: [[0, [330, 135, -120], [0, -20, -50], 38], [12, [300, 105, -40], [0, -15, -30], 38]],
      cues: [[2.4, () => sfx.power()]],
      frame(t) {
        // positioned, then the scan: the head reaches the plane first (the couch feeds head first)
        const z = t < 2.4 ? lerp(-70, -36, span(t, 0, 2.4)) : lerp(-36, 36, span(t, 2.6, 11.2, api.ease.linear));
        C.travel.position.z = z;
        const on = t > 2.6 && t < 11.2;
        C.spin.rotation.z = t * 2.4;
        C.fan.visible = on; C.scanRing.material.opacity = on ? 0.55 + 0.3 * Math.sin(t * 20) : 0.15;
        if (on) sfx.hold('gantry', 150 + 20 * Math.sin(t * 2.4), 0.035, 'triangle'); else sfx.stop('gantry');
        if (t > 1 && t < 6.5) api.mark(C.hous, 'cyan', t);
        if (t >= 6.5) {
          // where the fan crosses the body: the slab being measured
          api.mark(boxOf([[-22, -17, -1], [22, 17, 1], [22, -17, 1], [-22, 17, -1]]), 'yellow', t);
        }
      },
      caption: [
        { from: 1, to: 6.5, text: 'A model begins as a <b>CT scan</b> of a real patient: the tube and detector spin round the body as the couch carries it through.' },
        { from: 6.5, to: 12, text: 'Each turn measures one slab from all round; the scanner rebuilds it as a <b>transverse slice</b>, an image of how strongly each spot attenuates.' },
      ],
    },
    {
      title: 'Slices into a volume', dur: 13, scale: '10 cm',
      enter() {
        S.only('vol'); sfx.stop('gantry');
        S.put(S.shellG, S.sets.vol); S.cutShell(null); S.colourShell(false); setOpacity(S.shell, 0);
        S.cap.visible = false; for (const k of Object.values(S.ed)) k.visible = false;
        if (S.meshes.skin) S.meshes.skin.visible = false;
        if (S.meshes.bone) S.meshes.bone.visible = false;
        S.dims.visible = true;
      },
      cam: [[0, [-95, 70, 120], [0, -2, 0], 38], [13, [-120, 55, 70], [0, -2, -4], 38]],
      cues: Array.from({ length: 12 }, (_, k) => [0.7 + k * 0.5, () => sfx.tick()]),
      frame(t) {
        // the slices arrive top (head) first and drop into their place
        const n = S.plates.length;
        const fade = span(t, 7.2, 9.2);
        S.plates.forEach((m, i) => {
          const k = n - 1 - i;                                   // (plates run feet to head)
          const a = span(t, 0.6 + k * 0.13, 1.1 + k * 0.13);
          m.position.y = (1 - a) * 30;
          setOpacity(m, a * (1 - fade));
        });
        setOpacity(S.shell, fade);
        // the dimensions, in mm
        const dk = span(t, 9.2, 10.4);
        const h = [ex[0] / 2, ex[1] / 2, ex[2] / 2], o = 3;
        // the volume's box: its twelve edges drawn out from one corner, its three sizes on the
        // edges toward the camera (the patient's left, the head end, underneath)
        const lines = [];
        for (const a of [0, 1, 2]) for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) {
          const p = [0, 0, 0], q = [0, 0, 0], [b, c] = [0, 1, 2].filter((k) => k !== a);
          p[a] = -h[a]; q[a] = h[a]; p[b] = q[b] = s1 * h[b]; p[c] = q[c] = s2 * h[c];
          lines.push([p, q]);
        }
        void o;
        S.dims.userData.set(dk > 0 ? lines.map(([a, b]) => [a, api.lerp3(a, b, dk)]) : []);
        if (dk > 0.95) {
          const lab = (p, s, c = 'cyan') => { const [x, y] = api.toPx(p); px.rect(x - 15, y - 4, 30, 9, 'ink', 0.85); px.text(s, x, y - 2, c, 1, 1, 'center'); };
          lab([0, -h[1], h[2]], '418 mm');
          lab([-h[0], 0, h[2]], '330 mm');
          lab([-h[0], -h[1], 0], '712 mm');
        }
        if (t > 0.8) api.mark(blockProxy, 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 7.2, text: 'Stacked in order, head to foot, the slices fill a <b>volume</b>.' },
        { from: 7.2, to: 13, text: 'This one is 209 × 165 × 356 samples, 2 mm apart in all three directions: 12.3 million values.' },
      ],
    },
    {
      title: 'The voxel', dur: 14, scale: (t) => (t < 4 ? '10 cm' : t < 6.4 ? '1 cm' : '1 mm'),
      enter() {
        S.only('vol'); S.put(S.shellG, S.sets.vol); setOpacity(S.shell, 1); S.cutShell(ZCUT); S.colourShell(false);
        for (const m of S.plates) m.visible = false;
        S.paintCap('hu'); S.cap.visible = true; S.cap.position.z = S.zOfE(ZCUT) - 0.25;
        for (const k of Object.values(S.ed)) k.visible = false;
        S.dims.visible = false;
      },
      // (from the feet, under the cut: the slice as it is read, the patient's right on the left)
      cam: (t) => {
        const z = S.zOfE(ZCUT) - 0.25, P = capPoint();
        const k1 = span(t, 0, 4), k2 = span(t, 4, 6.6);
        const far = { pos: [-40, 48, -78], look: [0, 0, z + 4] }, mid = { pos: [P[0] - 8, P[1] + 7, z - 26], look: [P[0], P[1], z] };
        const near = { pos: [P[0] - 0.4, P[1] + 0.4, z - 2.2], look: [P[0], P[1], z] };
        const a = t < 4 ? far : mid, b = t < 4 ? mid : near, k = t < 4 ? k1 : k2;
        return { pos: api.lerp3(a.pos, b.pos, k), look: api.lerp3(a.look, b.look, k), fov: 38 };
      },
      cues: [[4.4, () => sfx.whoosh()]],
      frame(t) {
        api.mosaic(span(t, 4.4, 6.6));
        if (t > 1 && t < 4.5) api.mark(S.cap, 'yellow', t);
        if (t < 6.2) return;
        px.alpha = span(t, 6.2, 7);
        px.fillAll('ink');
        // a patch of the slice: 14 x 5 voxels across muscle, fat, skin and air on the right flank
        const G = { c0: 192, r0: 66, cols: 14, rows: 5 }, cell = 19;
        const gx = 10, gy = Math.round(px.H / 2 - (G.rows * cell) / 2) - 18;
        for (let r = 0; r < G.rows; r++) for (let c = 0; c < G.cols; c++) {
          const x = G.c0 + (G.cols - 1 - c), y = G.r0 + (G.rows - 1 - r);   // (read from the feet: right on the left)
          const v = hu[x + D.nx * y], g = D.grey(v);
          px.rect(gx + c * cell, gy + r * cell, cell - 1, cell - 1, `rgb(${g},${g},${g})`);
          px.text(String(Math.round(v)), gx + c * cell + cell / 2, gy + r * cell + 6, g > 130 ? 'ink' : 'lime', 1, 1, 'center');
        }
        api.keepOut([gx, gy, G.cols * cell, G.rows * cell]);
        // one voxel lifts out of the grid: a 2 mm box with its one value
        const pick = { c: 7, r: 2 };
        const k = span(t, 8, 9.6);
        const bx = gx + pick.c * cell + cell / 2, by = gy + pick.r * cell + cell / 2;
        const cx = lerp(bx, px.W - 58, k), cy = lerp(by, px.H / 2 - 22, k), s = lerp(cell / 2, 26, k);
        px.frame(gx + pick.c * cell - 1, gy + pick.r * cell - 1, cell + 1, cell + 1, 'yellow');
        const x = G.c0 + (G.cols - 1 - pick.c), y = G.r0 + (G.rows - 1 - pick.r), v = hu[x + D.nx * y], g = D.grey(v);
        if (k > 0) {
          const f = isoCube(cx, cy, s, [g, g, g]);
          if (k > 0.9) {
            px.text(String(Math.round(v)) + ' HU', cx, cy - s - 12, 'yellow', 1, 1, 'center');
            // its edges: 2 mm each
            const e = f.left[3], e2 = f.left[2];
            px.text('2 mm', (e[0] + e2[0]) / 2 - 8, (e[1] + e2[1]) / 2 + 6, 'cyan', 1, 1, 'center');
            px.text('2 mm', (f.right[2][0] + f.right[3][0]) / 2 + 8, (f.right[2][1] + f.right[3][1]) / 2 + 6, 'cyan', 1, 1, 'center');
            px.text('2 mm', f.right[2][0] + 10, (f.right[1][1] + f.right[2][1]) / 2, 'cyan', 1, 1, 'left');
          }
          api.mark([cx - s - 4, cy - s - 16, 2 * s + 8, 2 * s + 26], 'yellow', t);
        }
        px.alpha = 1;
      },
      caption: [
        { from: 1, to: 4.5, text: 'Cut anywhere, the volume is a slice on a slice: a 3D grid.' },
        { from: 7, to: 14, text: 'Each sample is a <b>voxel</b>: a 2 mm box holding a single number, the CT value of what filled it, in <b>Hounsfield units</b>.' },
      ],
    },
    {
      title: 'Segmentation', dur: 13, view: 'pixel', scale: '10 cm',
      cues: LABELS.map((_, i) => [1.2 + i * 1.15, () => sfx.blip(520 + i * 70)]),
      frame(t) {
        px.fillAll('ink');
        const [ox, oy] = sliceOrigin(), seg = segAt(t);
        sl.paint('seg' + seg.map((k) => Math.round(k * 24)).join(','), (c, r) => {
          const [x, y] = toXY(c, r), id = idAt(x, y);
          if (id === 0) return null;
          const g = greyAt(x, y), li = labelOf(id);
          if (li < 0 || !labelled.has(id)) return g;
          const L = LABELS[li], d = Math.hypot(c - L.c[0], r - L.c[1]) / L.R;
          return d <= seg[li] ? mix(g, RGB[id], 0.78) : g;
        });
        sl.draw(px, ox, oy);
        // the structure filling in now (the last one, once all are in)
        let cur = 0; seg.forEach((k, i) => { if (k > 0) cur = i; });
        const L = LABELS[cur];
        if (t > 1.2) api.mark([ox + L.box[0] - 2, oy + L.box[1] - 2, L.box[2] + 4, L.box[3] + 4], 'yellow', t);
        api.keepOut([ox, oy, D.nx, D.ny]);
      },
      caption: [{ from: 0.8, to: 13, text: 'A <b>segmentation</b> (here TotalSegmentator’s) labels each voxel with the structure it lies in: kidney, aorta, vena cava, liver, bowel, bone.' }],
    },
    {
      title: 'Labels and HU make materials', dur: 14, view: 'pixel', scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        const ox = 8, oy = 3;
        const sweep = span(t, 1, 6.5, api.ease.linear) * D.ny;
        sl.paint('mat' + Math.floor(sweep), (c, r) => {
          const [x, y] = toXY(c, r), id = idAt(x, y);
          if (id === 0) return null;
          if (r < sweep) return RGB[id];
          const g = greyAt(x, y);
          return labelled.has(id) ? mix(g, RGB[id], 0.78) : g;
        });
        sl.draw(px, ox, oy);
        if (sweep < D.ny) px.rect(ox, oy + sweep, D.nx, 1, 'yellow', 0.9);
        api.keepOut([ox, oy, D.nx, D.ny]);
        // the thresholds
        const bx = ox + D.nx + 10, bw = px.W - bx - 8;
        const box = bandPlot(bx, 14, bw, 52, span(t, 0.8, 3.5));
        api.keepOut(box);
        if (t > 0.8 && t < 7) api.mark(box, 'cyan', t);
        if (t >= 7) {
          // a voxel of the liver, picked: its id, as the file holds it
          const r = rngPick(t);
          const [c, rr] = r, [x, y] = toXY(c, rr), id = idAt(x, y);
          px.frame(ox + c - 2, oy + rr - 2, 5, 5, 'yellow');
          const lx = bx, ly = 80, lw = bw, lh = 30;
          panel(px, lx, ly, lw, lh); api.keepOut([lx, ly, lw, lh]);
          px.rect(lx + 6, ly + 8, 14, 14, rgbS(RGB[id]));
          px.text(String(id), lx + 28, ly + 9, 'yellow', 1, 2, 'left');
          px.text(Math.round(huOfId(id)) + ' HU', lx + lw - 4, ly + 12, 'mid', 1, 1, 'right');
          const Lv = LABELS[3];
          api.mark([ox + Lv.box[0] - 2, oy + Lv.box[1] - 2, Lv.box[2] + 4, Lv.box[3] + 4], 'yellow', t);
        }
      },
      caption: [
        { from: 0.8, to: 7, text: 'Outside the labels the HU decides: under −190 lung, then fat to −30, muscle to 120, trabecular bone to 300, cortical above.' },
        { from: 7, to: 14, text: 'Inside a label the structure decides: every liver voxel becomes <b>Liver</b>, material 11. Each voxel ends as one number: its <b>material id</b>.' },
      ],
    },
    {
      title: 'One byte per voxel', dur: 12, view: 'pixel', scale: '1 cm',
      cues: Array.from({ length: 20 }, (_, k) => [1 + k * 0.5, () => sfx.tick()]),
      frame(t) {
        px.fillAll('ink');
        const N = B.nx * B.ny * B.nz, rate = 6, cur = Math.floor(Math.max(0, t - 1) * rate) % N;
        // the block, back to front (z up, then x + y toward the viewer): x to the right and down,
        // y to the left and down, z up
        const cs = 12, w = cs * 0.87, h = cs / 2, nz = B.nz;
        const ox = Math.round(px.W * 0.3), oy = 16 + 2 * h + (nz - 1) * cs;
        const Q = (X, Y, Z) => [ox + (X - Y) * w, oy + (X + Y - 2) * h - (Z - 1) * cs];
        let curFaces = null;
        for (let z = 0; z < B.nz; z++) for (let s2 = 0; s2 <= B.nx + B.ny - 2; s2++) for (let x = 0; x < B.nx; x++) {
          const y = s2 - x; if (y < 0 || y >= B.ny) continue;
          // (the block builds up in the file's order: only the voxels written so far)
          const i = x + B.nx * (y + B.ny * z), id = bId(x, y, z), c = RGB[id];
          if (i > cur) continue;
          const k = 1;
          const [sx, sy] = Q(x + 1, y + 1, z + 1);
          const top = [[sx, sy - cs], [sx + w, sy - h], [sx, sy], [sx - w, sy - h]];
          const left = [[sx - w, sy - h], [sx, sy], [sx, sy + cs], [sx - w, sy + h]];
          const right = [[sx, sy], [sx + w, sy - h], [sx + w, sy + h], [sx, sy + cs]];
          fillPoly(px, top, rgbS(c, 1.1 * k)); fillPoly(px, left, rgbS(c, 0.75 * k)); fillPoly(px, right, rgbS(c, 0.55 * k));
          if (i === cur) curFaces = [top, left, right];
        }
        // the block's outline, and the voxel being written
        for (const [a, b] of [[Q(0, 0, nz), Q(B.nx, 0, nz)], [Q(B.nx, 0, nz), Q(B.nx, B.ny, nz)], [Q(B.nx, B.ny, nz), Q(0, B.ny, nz)], [Q(0, B.ny, nz), Q(0, 0, nz)],
          [Q(B.nx, 0, 0), Q(B.nx, 0, nz)], [Q(B.nx, B.ny, 0), Q(B.nx, B.ny, nz)], [Q(0, B.ny, 0), Q(0, B.ny, nz)], [Q(0, B.ny, 0), Q(B.nx, B.ny, 0)], [Q(B.nx, 0, 0), Q(B.nx, B.ny, 0)]])
          px.line(a[0], a[1], b[0], b[1], 'dkgrey', 1, 2);
        if (curFaces) for (const f of curFaces) for (let j = 0; j < 4; j++) px.line(f[j][0], f[j][1], f[(j + 1) % 4][0], f[(j + 1) % 4][1], 'yellow');
        // the axes along the block's lower edges
        const axis = (a, b, lab, dx, dy) => { px.line(a[0] + dx, a[1] + dy, b[0] + dx, b[1] + dy, 'mid'); px.text(lab, b[0] + dx * 2.5 - 1, b[1] + dy * 2.5 - 2, 'grey'); };
        axis(Q(0, B.ny, 0), Q(B.nx, B.ny, 0), 'x', -2, 4);
        axis(Q(B.nx, 0, 0), Q(B.nx, B.ny, 0), 'y', 2, 4);
        axis(Q(B.nx, 0, 0), Q(B.nx, 0, nz), 'z', 4, 0);
        api.mark([ox - B.ny * w - 4, 10, (B.nx + B.ny) * w + 8, Q(B.nx, B.ny, 0)[1] - 4], 'yellow', t);
        // the file: a run of bytes round the one being written, the block's own coloured
        const x = cur % B.nx, y = Math.floor(cur / B.nx) % B.ny, z = Math.floor(cur / (B.nx * B.ny));
        const g = gIdx(x, y, z), tw = 11, n = Math.floor((px.W - 16) / tw), ty = px.H - 22, tx = Math.round(px.W / 2 - (n * tw) / 2);
        panel(px, tx - 3, ty - 12, n * tw + 6, 26);
        api.keepOut([tx - 3, ty - 12, n * tw + 6, 26]);
        for (let k = 0; k < n; k++) {
          const gi = g + k - Math.floor(n / 2), id = D.data[gi];
          const lx = (gi % D.nx) - B.x0, ly = Math.floor(gi / D.nx) % D.ny - B.y0, lz = Math.floor(gi / (D.nx * D.ny)) - B.z0;
          const mine = lx >= 0 && lx < B.nx && ly >= 0 && ly < B.ny && lz >= 0 && lz < B.nz;
          const xx = tx + k * tw;
          px.rect(xx, ty, tw - 1, 10, mine ? rgbS(RGB[id], 0.9) : 'dkgrey', mine ? 1 : 0.6);
          px.text(String(id), xx + tw / 2, ty + 3, mine && RGB[id][0] + RGB[id][1] > 300 ? 'ink' : 'white', 1, 1, 'center');
          if (gi === g) px.frame(xx - 1, ty - 1, tw + 1, 12, 'yellow');
        }
        px.text(String(g), px.W / 2, ty - 9, 'yellow', 1, 1, 'center');
      },
      caption: [{ from: 0.8, to: 12, text: 'Saved one byte a voxel, x fastest: voxel (x, y, z) is byte x + 209·(y + 165·z) of the <b>.mat.bin</b> file. A small header gives the dims, the spacing and the material list.' }],
    },
    {
      title: 'Surfaces for display', dur: 13, scale: '10 cm',
      enter() {
        S.only('vol'); S.put(S.shellG, S.sets.vol); S.cutShell(null); S.colourShell(false);
        for (const m of S.plates) m.visible = false;
        S.cap.visible = false; for (const k of Object.values(S.ed)) k.visible = false; S.dims.visible = false;
        if (S.meshes.skin) { S.put(S.meshes.skin, S.sets.vol); S.meshes.skin.visible = true; }
        if (S.meshes.bone) { S.put(S.meshes.bone, S.sets.vol); S.meshes.bone.visible = true; }
      },
      cam: [[0, [75, 30, -95], [0, 0, 0], 38], [13, [105, 40, -45], [0, 0, 2], 38]],
      frame(t) {
        const a = span(t, 1.5, 4), b = span(t, 4.5, 6.5), back = span(t, 8, 10);
        setOpacity(S.shell, Math.max(1 - a, back));
        if (S.meshes.skin) setOpacity(S.meshes.skin, a * lerp(1, 0.28, b) * (1 - back * 0.75));
        if (S.meshes.bone) setOpacity(S.meshes.bone, b * (1 - back));
        if (t > 1 && t < 8 && S.meshes.skin) api.mark(S.meshes.skin, 'yellow', t);
        if (t >= 8) api.mark(S.shellG, 'cyan', t);
      },
      caption: [
        { from: 1, to: 8, text: 'For display only, smooth <b>surfaces</b> are cut from the voxels (marching cubes): the skin and the bones the rooms show.' },
        { from: 8, to: 13, text: 'The physics never reads them. Every image is traced through the <b>voxels</b>.' },
      ],
    },
  ];
  // the cut and the point on it the voxel step dives to (a voxel of the patch above)
  const ZCUT = Math.floor(SLICE / 2);
  function capPoint() { const x = 198, y = 68; return [(x + 0.5) * 0.2 - ex[0] / 2, (y + 0.5) * 0.2 - ex[1] / 2]; }
  // a liver voxel to point at, hopping every second
  const liverPix = [];
  for (let r = 0; r < D.ny; r += 3) for (let c = 0; c < D.nx; c += 3) { const [x, y] = toXY(c, r); if (idAt(x, y) === ID.LIVER) liverPix.push([c, r]); }
  function rngPick(t) { const k = Math.floor(t); return liverPix[(k * 7919) % liverPix.length]; }
  void E;
  return { title: 'From a scan to a model', steps };
}
