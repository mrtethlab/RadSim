/* DXA FILM, chapter 4: the analysis and the report. The bone's edges found against the soft-tissue
   baseline; the vertebrae counted up from the iliac crest by the dips the discs make; BMC summed
   and area counted in a region, BMD their ratio; the hip positioned in the foot holder and its
   regions (neck, trochanter, intertrochanteric, Ward's, total); the T-score against young adults,
   the WHO categories, the Z-score against the patient's own age; precision and the least
   significant change for follow-up; and the report. Every image, region and number is the app's
   own study of this patient (dxa.json, baked from dxa.js). */
import { setOpacity } from '../../kit/stage.js';
import { ZP } from './room.js';
import { mapCanvas, blit, boneOf } from './data.js';

export function results(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const J = S.J, SP = J?.spine, HP = J?.hip;
  const bmdCol = boneOf(SP ? SP.max.bmd * 0.75 : 1.5), hipCol = boneOf(HP ? HP.max.bmd * 0.55 : 1.2);
  const pxA = SP ? SP.px * SP.px : 0.0144;                       // cm2 a pixel
  const pt = J?.patient || { sex: 'f', age: 68 };

  // ---------------------------------------------------------------- the spine image, placed
  const fitSpine = (x, y, h) => { const cell = h / SP.nz; return { x, y, cell, w: SP.nx * cell, h }; };
  // a region's box (stored rows a..b from the inferior edge, stored cols x0..x1) where the image is
  const roiBox = (g, r) => [g.x + (SP.nx - 1 - r.x1) * g.cell, g.y + (SP.nz - r.b) * g.cell, (r.x1 - r.x0 + 1) * g.cell, (r.b - r.a) * g.cell];
  const rowY = (g, row) => g.y + (SP.nz - row) * g.cell;

  // the bone's edges: bone pixels (over the soft-tissue baseline) with a non-bone neighbour,
  // inside the spine's column (the analysis' own, findLevels)
  const THR = 0.1;                                                 // g/cm2: present, not baseline
  const edges = (() => {
    if (!SP) return [];
    const { nx, nz, bmd } = SP, col = SP.col || [0, nx - 1], out = [];
    const bone = (r, c) => r >= 0 && r < nz && c >= 0 && c < nx && bmd[r * nx + c] > THR;
    for (let r = 0; r < nz; r++) for (let c = Math.max(0, col[0] - 6); c <= Math.min(nx - 1, col[1] + 6); c++) {
      if (bone(r, c) && (!bone(r - 1, c) || !bone(r + 1, c) || !bone(r, c - 1) || !bone(r, c + 1))) out.push([r, c]);
    }
    return out;                                                    // image rows (superior first), stored cols
  })();
  // the sums over a region, row by row from its inferior edge (for the BMC count)
  function roiSums(r) {
    const rows = [];
    let bmc = 0, n = 0;
    for (let row = r.a; row < r.b; row++) {
      const ir = SP.nz - 1 - row;
      for (let c = r.x0; c <= r.x1; c++) { const v = SP.bmd[ir * SP.nx + c]; if (v > 0.02) { bmc += v * pxA; n++; } }
      rows.push([bmc, n * pxA]);
    }
    return rows;
  }

  // ---------------------------------------------------------------- the hip's regions as overlays
  const REG = { Neck: [255, 236, 39], Wards: [176, 108, 255], Troch: [41, 173, 255], Inter: [255, 119, 168] };
  const overlays = (() => {
    if (!HP || typeof document === 'undefined') return {};
    const out = {}, { nx, nz, mask, regions } = HP;
    const make = (paint) => {
      const cv = document.createElement('canvas'); cv.width = nx; cv.height = nz;
      const g = cv.getContext('2d'), im = g.createImageData(nx, nz);
      for (let r = 0; r < nz; r++) for (let c = 0; c < nx; c++) {
        const rgba = paint(r, c); if (!rgba) continue;
        const o = (r * nx + (nx - 1 - c)) * 4; im.data.set(rgba, o);
      }
      g.putImageData(im, 0, 0); return cv;
    };
    regions.forEach((name, k) => {
      if (name === 'Total') {
        const inT = (r, c) => r >= 0 && r < nz && c >= 0 && c < nx && (mask[r * nx + c] >> k) & 1;
        out.Total = make((r, c) => (inT(r, c) && (!inT(r - 1, c) || !inT(r + 1, c) || !inT(r, c - 1) || !inT(r, c + 1)) ? [255, 255, 255, 255] : null));
      } else {
        const col = REG[name], inR = (r, c) => r >= 0 && r < nz && c >= 0 && c < nx && (mask[r * nx + c] >> k) & 1;
        // a faint fill, a solid border
        out[name] = make((r, c) => (!inR(r, c) ? null : (!inR(r - 1, c) || !inR(r + 1, c) || !inR(r, c - 1) || !inR(r, c + 1)) ? [...col, 255] : [...col, 50]));
      }
    });
    return out;
  })();
  const hipRoi = (label) => HP?.rois.find((r) => r.label === label);
  // a region's bounding box in the drawn image
  const hipBox = (g, label) => {
    const k = HP.regions.indexOf(label); if (k < 0) return null;
    let c0 = 1e9, c1 = -1, r0 = 1e9, r1 = -1;
    for (let r = 0; r < HP.nz; r++) for (let c = 0; c < HP.nx; c++) if ((HP.mask[r * HP.nx + c] >> k) & 1) { const cc = HP.nx - 1 - c; c0 = Math.min(c0, cc); c1 = Math.max(c1, cc); r0 = Math.min(r0, r); r1 = Math.max(r1, r); }
    return c1 < 0 ? null : [g.x + c0 * g.cell - 1, g.y + r0 * g.cell - 1, (c1 - c0 + 1) * g.cell + 2, (r1 - r0 + 1) * g.cell + 2];
  };

  // ---------------------------------------------------------------- the reference population
  const ref = (site) => J?.ref?.[site] || { yMean: 1, ySD: 0.12 };
  const neck = hipRoi('Neck') || { bmd: 0.52, T: -2.8, Z: -1.3 }, total = hipRoi('Total') || { bmd: 0.62, T: -2.7, Z: -1.2 };
  const spineT = SP?.total || { bmd: 0.865, T: -1.7, Z: 0.3 };
  const ageMeanAt = (site, age) => {                               // the bake's table, every 10 years from 20
    const a = J?.ref?.age?.[site]; if (!a) return ref(site).yMean;
    const u = (age - 20) / 10, i = Math.max(0, Math.min(a.length - 2, Math.floor(u)));
    return lerp(a[i], a[i + 1], clamp01(u - i));
  };

  // a plot frame with a title-less box; keeps the caption off it
  const box = (x, y, w, h) => { px.rect(x, y, w, h, 'ink', 0.92); px.frame(x, y, w, h, 'dkgrey'); api.keepOut([x, y, w, h]); };

  // ---------------------------------------------------------------- the report on the console's monitor
  function paintReport() {
    const g = S.screen.userData.g, W = 560, H = 360;
    g.fillStyle = '#f4f5f6'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#2b3440'; g.fillRect(0, 0, W, 26);
    if (SP) {
      // the image with its regions
      const cv = mapCanvas(SP, 'bmd', bmdCol), ih = 230, cell = ih / SP.nz, iw = SP.nx * cell, ix = 18, iy = 40;
      g.imageSmoothingEnabled = false; g.drawImage(cv, ix, iy, iw, ih);
      g.strokeStyle = '#ffd400'; g.lineWidth = 1.5;
      for (const r of SP.rois) g.strokeRect(ix + (SP.nx - 1 - r.x1) * cell, iy + (SP.nz - r.b) * cell, (r.x1 - r.x0 + 1) * cell, (r.b - r.a) * cell);
      // BMD against age, the WHO bands behind (as dxaReport.js draws it)
      const cx = ix + iw + 26, cy = 40, cw = W - cx - 18, ch = 150;
      const R = ref('spine'), yLo = 0.58, yHi = 1.42, Y = (v) => cy + (yHi - v) / (yHi - yLo) * ch, X = (a) => cx + (a - 20) / 80 * cw;
      const band = (a, b, c) => { g.fillStyle = c; g.fillRect(cx, Y(b), cw, Y(a) - Y(b)); };
      band(R.yMean - R.ySD, yHi, '#1f8f43'); band(R.yMean - 2.5 * R.ySD, R.yMean - R.ySD, '#d8c341'); band(yLo, R.yMean - 2.5 * R.ySD, '#c0392b');
      g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1.2; g.beginPath();
      for (let a = 20; a <= 100; a++) { const v = ageMeanAt('spine', a); a === 20 ? g.moveTo(X(a), Y(v)) : g.lineTo(X(a), Y(v)); }
      g.stroke();
      g.fillStyle = '#111'; g.fillRect(X(pt.age) - 5, Y(spineT.bmd) - 5, 10, 10);
      g.strokeStyle = '#333'; g.strokeRect(cx, cy, cw, ch);
      // the table: numbers only
      g.font = '13px monospace'; g.fillStyle = '#222';
      const rows = [...SP.rois.map((r) => [r.label, r.bmd, r.T, r.Z]), ['L1-L4', spineT.bmd, spineT.T, spineT.Z]];
      rows.forEach((r, i) => {
        const yy = cy + ch + 22 + i * 17;
        g.fillText(r[0], cx, yy); g.fillText(r[1].toFixed(3), cx + 60, yy); g.fillText(r[2].toFixed(1), cx + 130, yy); g.fillText(r[3].toFixed(1), cx + 180, yy);
      });
      // the banner: the diagnosis's colour
      g.fillStyle = J?.dx?.cls === 'osteoporosis' ? '#c0392b' : J?.dx?.cls === 'osteopenia' ? '#d8c341' : '#1f8f43';
      g.fillRect(0, H - 34, W, 34);
      g.fillStyle = '#fff'; g.font = 'bold 16px monospace';
      if (J?.dx) g.fillText(`T ${J.dx.T.toFixed(1)}   Z ${J.dx.Z.toFixed(1)}`, 18, H - 12);
    }
    S.screen.userData.tex.needsUpdate = true;
  }

  const hipMarkZ = HP ? HP.laser.z + ZP : -20, hipMarkX = HP ? HP.laser.x : -10;
  const spineMarkZ = SP ? SP.laser.z + ZP : -3;
  const steps = [
    {
      title: 'The bone’s edges', dur: 13, view: 'pixel', scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        if (!SP) return;
        const g = fitSpine(14, 6, px.H - 12);
        blit(px, mapCanvas(SP, 'bmd', bmdCol), g.x, g.y, g.cell);
        api.keepOut([g.x, g.y, g.w, g.h]);
        // the edges, traced up the column (from the inferior edge, as the scan ran)
        const k = span(t, 0.8, 6, api.ease.linear), rowsUp = k * SP.nz;
        for (const [r, c] of edges) {
          if (SP.nz - 1 - r > rowsUp) continue;
          px.rect(g.x + (SP.nx - 1 - c) * g.cell, g.y + r * g.cell, Math.max(1, g.cell), Math.max(1, g.cell), 'yellow', 0.9);
        }
        // a profile across one row of L3: the soft-tissue baseline, then the bone
        const l3 = SP.rois.find((q) => q.label === 'L3') || SP.rois[0], row = Math.round((l3.a + l3.b) / 2), ir = SP.nz - 1 - row;
        const kp = span(t, 6.5, 8);
        if (kp > 0) {
          const yr = g.y + ir * g.cell;
          px.line(g.x, yr, g.x + g.w, yr, 'cyan', 0.8 * kp, 2);
          const bx = g.x + g.w + 12, bw = px.W - bx - 8, by = 30, bh = 90;
          box(bx, by, bw, bh);
          const vmax = 1.8, yv = (v) => by + bh - 6 - Math.min(1, v / vmax) * (bh - 12);
          px.line(bx + 2, yv(THR), bx + bw - 3, yv(THR), 'yellow', 0.7 * kp, 2);
          px.line(bx + 2, yv(0), bx + bw - 3, yv(0), 'mid', kp);
          let lx = null, ly = null;
          for (let c = 0; c < SP.nx; c++) {
            const v = SP.bmd[ir * SP.nx + (SP.nx - 1 - c)], xx = bx + 3 + (c / (SP.nx - 1)) * (bw - 6), yy = yv(v);
            if (lx != null) px.line(lx, ly, xx, yy, v > THR ? 'bone' : 'pink', kp);
            lx = xx; ly = yy;
          }
          px.text('g/cm2', bx + 3, by + 3, 'mid', kp);
          if (t > 8) api.mark([bx, by, bw, bh], 'cyan', t);
        }
        if (t < 8) api.mark([g.x, g.y, g.w, g.h], 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 6.5, text: 'First the software finds the bone’s <b>edges</b>, row by row, up the spine.' },
        { from: 6.5, to: 13, text: 'Across a row: a flat <b>baseline</b> where there is soft tissue alone (near zero, the tissue cancelled), then the bone rising clear of it. The edge is where it crosses.' },
      ],
    },
    {
      title: 'L1 to L4', dur: 14, view: 'pixel', scale: '10 cm',
      cues: [[5, () => sfx.blip(660)], [5.6, () => sfx.blip(740)], [6.2, () => sfx.blip(830)], [6.8, () => sfx.blip(990)]],
      frame(t) {
        px.fillAll('ink');
        if (!SP) return;
        const g = fitSpine(14, 6, px.H - 12);
        blit(px, mapCanvas(SP, 'bmd', bmdCol), g.x, g.y, g.cell);
        api.keepOut([g.x, g.y, g.w, g.h]);
        // the profile up the column: mineral summed across each row, the discs its dips
        const bw = Math.min(64, px.W - g.x - g.w - 18), bx = px.W - bw - 6;
        box(bx, g.y, bw, g.h);
        const pmax = Math.max(...SP.prof), kp = span(t, 0.5, 3, api.ease.linear);
        let lx = null, ly = null;
        for (let row = 0; row < SP.nz; row++) {
          if (row > kp * SP.nz) break;
          const xx = bx + 3 + (SP.prof[row] / pmax) * (bw - 6), yy = rowY(g, row);
          if (lx != null) px.line(lx, ly, xx, yy, 'bone'); lx = xx; ly = yy;
        }
        // the dips: the disc spaces; the lowest, at the iliac crest, L4-L5
        const kd = span(t, 3, 4.5);
        (SP.dips || []).forEach((d, i) => {
          const yy = rowY(g, d);
          px.line(g.x, yy, g.x + g.w, yy, i === 0 ? 'orange' : 'cyan', 0.75 * kd, 2);
          px.line(bx, yy, bx + bw, yy, i === 0 ? 'orange' : 'cyan', 0.75 * kd, 2);
        });
        // the regions, counted up from the crest
        const order = ['L4', 'L3', 'L2', 'L1'];
        order.forEach((lab, i) => {
          const r = SP.rois.find((q) => q.label === lab); if (!r) return;
          const k = span(t, 5 + i * 0.6, 5.4 + i * 0.6); if (k <= 0) return;
          const b = roiBox(g, r);
          px.frame(b[0], b[1], b[2], b[3], 'yellow', k);
          px.text(lab, b[0] - 2, b[1] + b[3] / 2 - 2, 'yellow', k, 1, 'right');
        });
        if (t > 3 && t < 7.5) { const d = SP.dips?.[0]; if (d != null) api.mark([g.x - 4, rowY(g, d) - 5, g.w + bw + 18, 10], 'orange', t); }
        if (t >= 7.5) { const r1 = SP.rois.find((q) => q.label === 'L1'), r4 = SP.rois.find((q) => q.label === 'L4'); const a = roiBox(g, r1), b = roiBox(g, r4); api.mark([a[0] - 12, a[1], a[2] + 14, b[1] + b[3] - a[1]], 'yellow', t); }
      },
      caption: [
        { from: 0.5, to: 3, text: 'Summed across each row, the mineral rises at every vertebral body and dips at every disc.' },
        { from: 3, to: 7.5, text: 'The dip at the iliac crest is the <b>L4–L5</b> disc. Counting up from it: L4, L3, L2, L1.' },
        { from: 7.5, to: 14, text: 'Each vertebra gets a box between its discs, bone edge to bone edge: its <b>region of interest</b>.' },
      ],
    },
    {
      title: 'BMC ÷ area = BMD', dur: 16, view: 'pixel', scale: '1 cm',
      cues: [[2, () => sfx.tick()], [3, () => sfx.tick()], [4, () => sfx.tick()], [5, () => sfx.tick()], [6, () => sfx.tick()], [7.2, () => sfx.ping(1320)]],
      frame(t) {
        px.fillAll('ink');
        if (!SP) return;
        const r = SP.rois.find((q) => q.label === 'L3') || SP.rois[0];
        const nr = r.b - r.a, ncol = r.x1 - r.x0 + 1;
        // zoomed into the region: each scan pixel a cell
        const cell = Math.max(2, Math.min(Math.floor((px.H - 50) / nr), Math.floor((px.W * 0.55) / ncol)));
        const gx = 10, gy = Math.round((px.H - nr * cell) / 2);
        const cv = mapCanvas(SP, 'bmd', bmdCol);
        const cc0 = SP.nx - 1 - r.x1, rr0 = SP.nz - r.b;
        px.g.imageSmoothingEnabled = false;
        px.g.drawImage(cv, cc0, rr0, ncol, nr, gx, gy, ncol * cell, nr * cell);
        px.frame(gx - 1, gy - 1, ncol * cell + 2, nr * cell + 2, 'yellow');
        api.keepOut([gx - 2, gy - 2, ncol * cell + 4, nr * cell + 4]);
        // the sweep adding them up, row by row from the inferior edge
        const sums = roiSums(r), ks = span(t, 1.5, 7, api.ease.linear), done = Math.min(nr, Math.floor(ks * nr));
        const fin = sums[nr - 1], f = (v, i) => v * (i === 0 ? r.bmc / fin[0] : r.area / fin[1]);
        if (ks > 0 && ks < 1) px.rect(gx, gy + (nr - done) * cell, ncol * cell, 1, 'white');
        if (done > 0) px.rect(gx, gy + (nr - done) * cell, ncol * cell, done * cell, 'yellow', 0.12);
        const cur = done > 0 ? sums[done - 1] : [0, 0];
        // the readouts: BMC (g), area (cm2), and their ratio
        const tx = gx + ncol * cell + 14, tw = px.W - tx - 6;
        box(tx, gy, tw, 64);
        px.text(f(cur[0], 0).toFixed(2) + ' g', tx + tw - 4, gy + 6, 'orange', 1, 1, 'right');
        px.text(f(cur[1], 1).toFixed(2) + ' cm2', tx + tw - 4, gy + 18, 'lav', 1, 1, 'right');
        const kr = span(t, 7.2, 8);
        if (kr > 0) {
          px.rect(tx + 4, gy + 30, tw - 8, 1, 'mid', kr);
          px.text(r.bmd.toFixed(3) + ' g/cm2', tx + tw - 4, gy + 36, 'yellow', kr, 1, 'right');
        }
        // the four together
        const kt = span(t, 10.5, 11.5);
        if (kt > 0) {
          const ty = gy + 72, rows = [...SP.rois.map((q) => [q.label, q.bmd]), ['L1-L4', SP.total.bmd]];
          box(tx, ty, tw, 8 + rows.length * 9);
          rows.forEach(([lab, v], i) => {
            px.text(lab, tx + 4, ty + 4 + i * 9, i === rows.length - 1 ? 'white' : 'mid', kt);
            px.text(v.toFixed(3), tx + tw - 4, ty + 4 + i * 9, i === rows.length - 1 ? 'yellow' : 'grey', kt, 1, 'right');
          });
          if (t > 11.5) api.mark([tx - 2, ty + 2 + (rows.length - 1) * 9, tw + 4, 10], 'yellow', t);
        }
        if (t < 7.2) api.mark([tx, gy, tw, 26], 'orange', t);
        else if (t < 10.5) api.mark([tx, gy + 32, tw, 14], 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 7.2, text: 'In L3’s box: add up the mineral of every bone pixel, the <b>BMC</b> in grams; count the pixels, the projected <b>area</b> in cm².' },
        { from: 7.2, to: 10.5, text: '<b>BMD = BMC ÷ area</b>: an areal density, g/cm², not a true volume density. A bigger bone reads a little denser.' },
        { from: 10.5, to: 16, text: 'L1–L4 together, their BMC over their area: the spine’s BMD.' },
      ],
    },
    {
      title: 'The hip', dur: 16, scale: '10 cm',
      enter() { S.reset(); S.patLook(1, 0.3); S.holder.visible = true; S.block.visible = true; S.legsTo('block'); setOpacity(S.headG, 0.55); },
      cam: [[0, [110, 120, -170], [0, 10, -55], 38], [8, [80, 95, -150], [-5, 10, -60], 36], [12, [hipMarkX + 30, 100, hipMarkZ - 80], [hipMarkX, 16, hipMarkZ + 6], 34], [16, [hipMarkX + 24, 92, hipMarkZ - 70], [hipMarkX, 16, hipMarkZ + 6], 32]],
      cues: [[1.5, () => sfx.whoosh()], [4.2, () => sfx.thud()], [11.5, () => sfx.ping(1320)]],
      frame(t) {
        // the block out, the holder in, the legs straightened and the feet turned in against it
        const kb = span(t, 0.5, 2.5);
        S.block.position.x = lerp(0, -120, kb); S.block.visible = kb < 1;
        const kh = span(t, 1.5, 4);
        S.holder.position.x = lerp(110, 0, kh);
        const kl = span(t, 4, 6.5);
        S.legs.block.visible = kl < 1; S.legs.holder.visible = kl > 0;
        setOpacity(S.legs.block, 1 - kl); setOpacity(S.legs.holder, kl);
        // the arm down the table to the hip's mark
        const ka = span(t, 7.5, 11.5);
        const z = lerp(spineMarkZ, hipMarkZ, ka), x = lerp(0, hipMarkX, ka);
        S.setArm(z); S.setLaser(true, x, z);
        sfx.hold('drive', 140, ka > 0 && ka < 1 ? 0.04 : 0, 'square');
        if (t > 2 && t < 7.5) api.mark(S.holder, 'yellow', t, { live: true });
        if (t >= 7.5) {
          const c = api.toPx([x, S.skinTop(x, z), z]);
          api.mark([c[0] - 9, c[1] - 9, 18, 18], 'red', t);
        }
      },
      caption: [
        { from: 2, to: 7.5, text: 'For the hip the block makes way for a <b>foot holder</b>: legs straight, both feet turned in about 20°.' },
        { from: 7.5, to: 11.5, text: 'Turning the leg in brings the <b>femoral neck</b> parallel to the table, seen at its full length instead of foreshortened.' },
        { from: 11.5, to: 16, place: 'right', text: 'The laser goes on the femoral shaft, <b>5 cm below the greater trochanter</b>; the scan runs up over the neck and head.' },
      ],
    },
    {
      title: 'The hip’s regions', dur: 15, view: 'pixel', scale: '10 cm',
      cues: [[1.2, () => sfx.blip(660)], [4.2, () => sfx.blip(740)], [6.2, () => sfx.blip(830)], [8.6, () => sfx.blip(990)]],
      frame(t) {
        px.fillAll('ink');
        if (!HP) return;
        const h = px.H - 16, cell = h / HP.nz, g = { x: 14, y: 8, cell, w: HP.nx * cell, h };
        blit(px, mapCanvas(HP, 'bmd', hipCol), g.x, g.y, cell);
        api.keepOut([g.x, g.y, g.w, g.h]);
        const show = [['Neck', 1], ['Troch', 4], ['Inter', 6], ['Wards', 8.6], ['Total', 10]];
        for (const [name, at] of show) { const k = span(t, at, at + 0.8); if (k > 0 && overlays[name]) blit(px, overlays[name], g.x, g.y, cell, null, k); }
        // the numbers: neck and total hip
        const tx = g.x + g.w + 12, tw = px.W - tx - 6;
        const rows = [['Neck', 'yellow'], ['Troch', 'blue'], ['Inter', 'pink'], ['Wards', 'violet'], ['Total', 'white']];
        box(tx, g.y, tw, 8 + rows.length * 10);
        rows.forEach(([lab, c], i) => {
          const r = hipRoi(lab), at = show.find((s) => s[0] === lab)[1], k = span(t, at, at + 0.8);
          if (!r || k <= 0) return;
          px.rect(tx + 4, g.y + 5 + i * 10, 5, 5, c, k);
          px.text(r.bmd.toFixed(3), tx + tw - 4, g.y + 5 + i * 10, c, k, 1, 'right');
        });
        const mk = t < 4 ? 'Neck' : t < 10 ? null : 'Total';
        if (t >= 4 && t < 10) { const a = hipBox(g, 'Troch'), b = hipBox(g, 'Inter'); if (a && b) { const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]); api.mark([x0, y0, Math.max(a[0] + a[2], b[0] + b[2]) - x0, Math.max(a[1] + a[3], b[1] + b[3]) - y0], 'cyan', t); } }
        else if (mk) { const b = hipBox(g, mk); if (b) api.mark(b, mk === 'Neck' ? 'yellow' : 'white', t); }
      },
      caption: [
        { from: 1, to: 4, text: 'The <b>femoral neck</b>: a band across its narrowest part, square to its axis.' },
        { from: 4, to: 10, text: 'Below it the <b>trochanter</b> and the <b>intertrochanteric</b> region; Ward’s area, the neck’s least dense spot, is shown but never used to diagnose.' },
        { from: 10, to: 15, text: 'Together they make the <b>total hip</b>. The femoral neck and the total hip are the two the diagnosis uses.' },
      ],
    },
    {
      title: 'Against young adults: the T-score', dur: 15, view: 'pixel', scale: null,
      frame(t) {
        px.fillAll('ink');
        const R = ref('neck'), W = px.W;
        const x = 12, y = 20, w = W - 24, h = px.H - 64;
        box(x, y, w, h);
        const v0 = R.yMean - 4 * R.ySD, v1 = R.yMean + 2.6 * R.ySD;
        const X = (v) => x + 4 + ((v - v0) / (v1 - v0)) * (w - 8), base = y + h - 14;
        // the young-adult population: a bell curve of their femoral-neck BMD
        const kb = span(t, 0.5, 2.5);
        for (let i = 0; i < w - 8; i++) {
          const v = v0 + (i / (w - 9)) * (v1 - v0), z = (v - R.yMean) / R.ySD, f = Math.exp(-z * z / 2);
          const hh = Math.round(f * (h - 34) * kb);
          if (hh > 0) px.rect(x + 4 + i, base - hh, 1, hh, Math.abs(z) < 1 ? 'teal' : 'dkblue', 0.9);
        }
        px.rect(x + 3, base, w - 6, 1, 'mid');
        // SD steps under it, numbered as T
        for (let s = -4; s <= 2; s++) {
          const xx = X(R.yMean + s * R.ySD);
          px.rect(xx, base, 1, 3, 'grey');
          px.text(String(s), xx, base + 5, s === 0 ? 'white' : 'mid', kb, 1, 'center');
        }
        const kv = span(t, 3, 4);
        px.text(R.yMean.toFixed(3), X(R.yMean), y + 4, 'teal', kv, 1, 'center');
        // the patient's neck, and the distance in SDs counted out
        const kp = span(t, 5, 6);
        if (kp > 0) {
          const xp = X(neck.bmd);
          px.rect(xp, y + 14, 1, base - y - 14, 'yellow', kp);
          px.text(neck.bmd.toFixed(3), xp, y + 4, 'yellow', kp, 1, 'center');
          const kc = span(t, 7, 11, api.ease.linear), steps = Math.abs(neck.T) * kc;
          const xs = X(R.yMean), xe = X(R.yMean - steps * R.ySD);
          if (kc > 0) {
            px.line(xe, base - 8, xs, base - 8, 'yellow', 0.9);
            for (let s = 1; s <= Math.floor(steps); s++) px.rect(X(R.yMean - s * R.ySD) - 1, base - 10, 3, 5, 'yellow');
            px.text((-steps).toFixed(1), (xs + xe) / 2, base - 18, 'yellow', 1, 1, 'center');
          }
          if (t > 5) api.mark([xp - 6, y + 2, Math.max(12, xs - xp + 12), base - y], 'yellow', t);
        }
      },
      caption: [
        { from: 0.5, to: 5, text: 'The BMD is compared with healthy <b>young adults</b> of the same sex at peak bone mass: their mean and their spread, the standard deviation.' },
        { from: 5, to: 15, text: '<b>T-score</b> = (BMD − young-adult mean) ÷ SD. Femoral neck: (0.520 − 0.858) ÷ 0.120 = <b>−2.8</b> SD.' },
      ],
    },
    {
      title: 'The WHO categories', dur: 13, view: 'pixel', scale: null,
      cues: [[6.5, () => sfx.down()]],
      frame(t) {
        px.fillAll('ink');
        const W = px.W, x = 30, w = W - 60, y = Math.round(px.H / 2 - 48), h = 30;
        // the T axis, -4.5 .. +2, the three bands
        const T0 = -4.5, T1 = 2, X = (T) => x + ((T - T0) / (T1 - T0)) * w;
        const kb = span(t, 0.5, 2.5);
        px.rect(X(-1), y, X(T1) - X(-1), h, 'green', 0.85 * kb);
        px.rect(X(-2.5), y, X(-1) - X(-2.5), h, 'gold', 0.85 * kb);
        px.rect(X(T0), y, X(-2.5) - X(T0), h, 'dkred', 0.95 * kb);
        api.keepOut([x - 4, y - 14, w + 8, h + 60]);
        for (const T of [-2.5, -1]) { px.rect(X(T), y - 4, 1, h + 8, 'white'); px.text(T.toFixed(1), X(T), y - 11, 'white', 1, 1, 'center'); }
        for (let T = -4; T <= 2; T++) px.text(String(T), X(T), y + h + 3, 'mid', 1, 1, 'center');
        // the patient's three sites
        const sites = [['L1-L4', spineT.T, 3.5], ['TOTAL', total.T, 4.5], ['NECK', neck.T, 5.5]];
        sites.forEach(([lab, T, at], i) => {
          const k = span(t, at, at + 0.6); if (k <= 0) return;
          const xx = X(T), yy = y + h + 14 + i * 11;
          px.line(xx, y + h, xx, yy, 'white', 0.5 * k, 2);
          px.rect(xx - 2, yy - 2, 5, 5, i === 2 ? 'yellow' : 'white', k);
          px.text(lab + ' ' + T.toFixed(1), xx + 5, yy - 2, i === 2 ? 'yellow' : 'grey', k);
        });
        if (t < 3.5) api.mark([x - 2, y - 2, w + 4, h + 4], 'white', t);
        else if (t >= 6.5) api.mark([X(neck.T) - 6, y + h + 30, 60, 12], 'yellow', t);
      },
      caption: [
        { from: 0.5, to: 6.5, text: 'The <b>WHO</b> categories: T −1.0 or above, <b>normal</b>; between −1.0 and −2.5, <b>osteopenia</b>; −2.5 or below, <b>osteoporosis</b>.' },
        { from: 6.5, to: 13, text: 'The lowest of the spine, total hip and femoral neck decides: the neck at −2.8, <b>osteoporosis</b>. (T-scores diagnose after menopause, and in men from 50.)' },
      ],
    },
    {
      title: 'Against her own age: the Z-score', dur: 14, view: 'pixel', scale: null,
      frame(t) {
        px.fillAll('ink');
        const R = ref('neck'), W = px.W, x = 16, y = 10, w = W - 32, h = px.H - 40;
        box(x, y, w, h);
        const vLo = R.yMean - 4.2 * R.ySD, vHi = R.yMean + 2.2 * R.ySD;
        const X = (a) => x + 3 + ((a - 20) / 80) * (w - 6), Y = (v) => y + 3 + ((vHi - v) / (vHi - vLo)) * (h - 6);
        // the WHO bands behind, flat in BMD (they are set from the young adults)
        const band = (a, b, c) => px.rect(x + 3, Y(b), w - 6, Y(a) - Y(b), c, 0.35);
        band(R.yMean - R.ySD, vHi, 'green'); band(R.yMean - 2.5 * R.ySD, R.yMean - R.ySD, 'gold'); band(vLo, R.yMean - 2.5 * R.ySD, 'dkred');
        // the age-matched mean, falling with age, and a band of one SD round it
        const ka = span(t, 0.5, 3, api.ease.linear);
        let l0 = null;
        for (let a = 20; a <= 20 + 80 * ka; a += 0.5) {
          const v = ageMeanAt('neck', a), xx = X(a);
          px.px(xx, Y(v + R.ySD), 'grey', 0.5); px.px(xx, Y(v - R.ySD), 'grey', 0.5);
          if (l0) px.line(l0[0], l0[1], xx, Y(v), 'white'); l0 = [xx, Y(v)];
        }
        for (let a = 20; a <= 100; a += 10) px.text(String(a), X(a), y + h + 3, 'mid', 1, 1, 'center');
        for (let v = 0.5; v <= vHi; v += 0.2) px.text(v.toFixed(1), x + 5, Y(v) - 2, 'mid', 0.9);
        // the patient: 68, her neck BMD; the distance to the line for her age, in SD
        const kp = span(t, 3.5, 4.5);
        if (kp > 0) {
          const xp = X(pt.age), yp = Y(neck.bmd), ym = Y(ageMeanAt('neck', pt.age));
          px.rect(xp - 2, yp - 2, 5, 5, 'yellow', kp);
          const kz = span(t, 5, 7);
          if (kz > 0) {
            px.line(xp, yp, xp, lerp(yp, ym, kz), 'yellow', 0.9, 2);
            px.text(neck.Z.toFixed(1), xp + 5, (yp + ym) / 2 - 2, 'yellow', kz);
          }
          api.mark([xp - 6, Math.min(yp, ym) - 6, 12, Math.abs(yp - ym) + 12], 'yellow', t);
        }
      },
      caption: [
        { from: 0.5, to: 3.5, text: 'Bone is lost with age: the <b>age-matched</b> mean falls year by year.' },
        { from: 3.5, to: 9, text: '<b>Z-score</b> = (BMD − mean for her age and sex) ÷ SD: at 68 her neck is −1.3, within the range expected for her age.' },
        { from: 9, to: 14, text: 'A Z-score of −2.0 or below is “below the expected range for age”: look for a cause beyond age. Before 50 it is the Z-score that is reported.' },
      ],
    },
    {
      title: 'Precision and the LSC', dur: 18, view: 'pixel', scale: null,
      frame(t) {
        px.fillAll('ink');
        const W = px.W, H = px.H, half = Math.floor(W / 2);
        // left: 15 patients scanned 3 times each, repositioned between scans: their scatter
        const x = 8, y = 10, w = half - 12, h = H - 40;
        box(x, y, w, h);
        const CV = 0.010;                                            // this technologist's precision: 1.0 %
        // each repeat as its difference from that patient's own mean, in %
        const pts = [];
        for (let p = 0; p < 15; p++) {
          const r = rng(800 + p), d = [0, 1, 2].map(() => (r() + r() + r() - 1.5) * 2 * CV * 100);
          const m = (d[0] + d[1] + d[2]) / 3;
          d.forEach((v) => pts.push([p, v - m]));
        }
        const Y = (v) => y + h / 2 - (v / 3.5) * (h / 2 - 6), Xp = (p) => x + 8 + p * ((w - 16) / 14);
        px.line(x + 3, Y(0), x + w - 4, Y(0), 'mid', 0.8);
        const kc = span(t, 4.5, 5.5);
        px.rect(x + 3, Y(1), w - 7, Y(-1) - Y(1), 'dkblue', 0.6 * kc);
        for (const v of [-3, -2, -1, 1, 2, 3]) px.text((v > 0 ? '+' : '') + v + '%', x + 4, Y(v) - 2, 'mid', 0.8);
        const kp = span(t, 0.5, 4, api.ease.linear);
        pts.forEach(([p, v], i) => { if (i / pts.length <= kp) px.rect(Xp(p) - 1, Y(v) - 1, 3, 3, ['cyan', 'lime', 'yellow'][i % 3], 0.95); });
        px.text('1.0%', x + w - 3, y + 3, 'white', kc, 1, 'right');
        // right: the follow-up, against the LSC (2.77 x the precision) round the baseline
        const fx = half + 4, fw = W - fx - 8;
        box(fx, y, fw, h);
        const base = spineT.bmd, lsc = 2.77 * CV * base;
        const vl = base - 0.07, vh = base + 0.03, Yf = (v) => y + h - 4 - ((v - vl) / (vh - vl)) * (h - 8);
        const kl = span(t, 6.5, 7.5);
        px.rect(fx + 2, Yf(base + lsc), fw - 4, Yf(base - lsc) - Yf(base + lsc), 'dkblue', 0.9 * kl);
        px.text('2.77 x 1.0% = ' + (2.77 * CV * 100).toFixed(1) + '%', fx + fw - 3, y + 3, 'white', kl, 1, 'right');
        const studies = [[0, base, 'white', 9], [1, base - 0.015, 'grey', 10.5], [2, base - 0.046, 'red', 13]];
        const Xf = (i) => fx + 12 + i * ((fw - 24) / 2);
        studies.forEach(([i, v, c, at]) => {
          const k = span(t, at, at + 0.6); if (k <= 0) return;
          px.rect(Xf(i) - 2, Yf(v) - 2, 5, 5, c, k);
          px.text(v.toFixed(3), Xf(i), Yf(v) + 5, c, k, 1, 'center');
          if (i > 0) px.line(Xf(i - 1), Yf(studies[i - 1][1]), Xf(i), Yf(v), 'mid', 0.7 * k);
        });
        if (t < 6.5) api.mark([x, y, w, h], 'cyan', t);
        else if (t < 10.5) api.mark([fx + 2, Yf(base + lsc) - 2, fw - 4, Yf(base - lsc) - Yf(base + lsc) + 4], 'white', t);
        else if (t < 13) api.mark([Xf(1) - 8, Yf(base - 0.015) - 8, 16, 18], 'grey', t);
        else api.mark([Xf(2) - 8, Yf(base - 0.046) - 8, 16, 18], 'red', t);
      },
      cues: [[10.5, () => sfx.blip(520)], [13, () => sfx.down()]],
      caption: [
        { from: 0.5, to: 6.5, text: '<b>Precision</b>: each technologist scans the same patients again and again, off the table and back on each time (15 × 3 or 30 × 2).' },
        { from: 6.5, to: 10.5, text: '<b>Least significant change</b> = 2.77 × precision: the smallest change between two scans that is real at 95 % confidence. ISCD’s limit for the spine: 1.9 %, an LSC of 5.3 %.' },
        { from: 10.5, to: 13, text: 'At follow-up, on the same machine: a fall inside the LSC is no measurable change.' },
        { from: 13, to: 18, text: 'Beyond it, a real <b>loss</b> of bone: the change the report flags.' },
      ],
    },
    {
      title: 'The report', dur: 11, fadeOut: 1.2, scale: '10 cm',
      enter() { S.reset(); S.patLook(0); S.legsTo(null); S.setArm(40); paintReport(); },
      cam: [[0, [40, 60, 40], [-150, 20, 150], 40], [11, [-75, 30, 95], [-150, 32, 150], 34]],
      cues: [[0.5, () => sfx.chime()]],
      frame(t) { if (t > 1.5) api.mark(S.screen, 'lime', t); },
      caption: [{ from: 1.5, to: 11, text: 'The <b>report</b>: the image with its regions, BMD against age with the WHO bands, every region’s T- and Z-score, and the diagnosis from the lowest.' }],
    },
  ];
  return { title: 'Analysis and report', steps };
}
