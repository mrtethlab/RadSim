/* X-RAY FILM, chapter 4: the image. The digitised values placed pixel by pixel into the image
   matrix; the histogram they make; rescaling to the values of interest; the look-up table and
   the window (brightness and contrast); the finished image on the monitor. The image is the hand
   model's own projection (public/anim/hand_pa.png, services/compute app/build_anim_images.py). */
import * as THREE from 'three';
import { histogramPlot, curvePlot } from '../../kit/micro.js';
import { std, mesh, canvasPlane } from '../../kit/stage.js';

const BITS = 16383;

export async function imaging(api, S) {
  const { px, sfx, span, lerp, clamp01 } = api;

  // ---- the image: attenuation (0..1) per pixel, from the hand's projection
  const img = await new Promise((res) => {
    const im = new Image();
    im.onload = () => {
      const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
      const g = cv.getContext('2d'); g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, im.width, im.height).data, a = new Float32Array(im.width * im.height);
      for (let i = 0; i < a.length; i++) a[i] = d[i * 4] / 255;
      res({ w: im.width, h: im.height, a });
    };
    im.onerror = () => res({ w: 96, h: 142, a: new Float32Array(96 * 142) });
    im.src = import.meta.env.BASE_URL + 'anim/hand_pa.png';
  });
  // what the detector reports: the transmitted signal, 14 bits (open field near the top)
  const raw = Float32Array.from(img.a, (q) => Math.min(BITS, Math.round(BITS * 0.96 * Math.exp(-2.6 * q))));
  const rawN = Float32Array.from(raw, (v) => v / BITS);      // 0..1
  // processing: log of the signal (attenuation again), inverted so bone is white, then the curve
  const logv = Float32Array.from(raw, (v) => Math.min(1, -Math.log(Math.max(1, v) / (BITS * 0.96)) / 2.6));
  const VOI = (() => {                                          // the anatomy's values: not the open field
    const s = [...logv].filter((v) => v > 0.03).sort((x, y) => x - y);
    return [s[Math.floor(s.length * 0.01)], s[Math.floor(s.length * 0.995)]];
  })();

  // draw the image: cell pixels per image pixel, grey(i) 0..1, a window of rows/cols (optional)
  function drawImage(x, y, cell, grey, { c0 = 0, r0 = 0, cols = img.w, rows = img.h, a = 1 } = {}) {
    for (let r = r0; r < Math.min(img.h, r0 + rows); r++) for (let c = c0; c < Math.min(img.w, c0 + cols); c++) {
      const v = clamp01(grey(r * img.w + c)), g = Math.round(v * 255);
      const xx = x + (c - c0) * cell, yy = y + (r - r0) * cell;
      if (xx > px.W || yy > px.H || xx + cell < 0 || yy + cell < 0) continue;
      // edge to edge on whole pixels (rounding each cell alone leaves seams at fractional sizes)
      const ix = Math.floor(xx), iy = Math.floor(yy), iw = Math.max(1, Math.floor(xx + cell) - ix), ih = Math.max(1, Math.floor(yy + cell) - iy);
      px.g.globalAlpha = a; px.g.fillStyle = `rgb(${g},${g},${g})`; px.g.fillRect(ix, iy, iw, ih); px.g.globalAlpha = 1;
    }
  }
  // the processed grey for a pixel: rescale to the VOI, then an S-shaped LUT of steepness s, then
  // the window (level, width) on top
  const sCurve = (u, s) => (s <= 0.01 ? u : 1 / (1 + Math.exp(-s * 8 * (u - 0.5))));
  const sNorm = (u, s) => { const a = sCurve(0, s), b = sCurve(1, s); return (sCurve(u, s) - a) / (b - a || 1); };
  const process = (i, { voi = 1, s = 0, level = 0.5, width = 1 }) => {
    const v = logv[i];
    const lo = lerp(0, VOI[0], voi), hi = lerp(1, VOI[1], voi);
    let u = clamp01((v - lo) / (hi - lo));
    u = sNorm(u, s);
    return clamp01((u - (level - width / 2)) / width);
  };

  // ---- the console monitor in the room
  const monitor = new THREE.Group(); S.room.group.add(monitor);
  monitor.position.set(-150, 0, 160); monitor.rotation.y = 0.6;        // the desk 75 cm above the floor
  monitor.add(mesh(new THREE.BoxGeometry(56, 36, 3), std(0x15191d, 0.4, 0.2), 0, 30, 0));
  monitor.add(mesh(new THREE.CylinderGeometry(2, 2, 20, 16), std(0x3b4148, 0.5, 0.3), 0, 6, -2));
  monitor.add(mesh(new THREE.BoxGeometry(22, 1.5, 16), std(0x3b4148, 0.5, 0.3), 0, -4, -2));
  monitor.add(mesh(new THREE.BoxGeometry(120, 4, 60), std(0xd9dde1, 0.6, 0.05), 0, -6, 10));     // the desk
  const screen = canvasPlane(52, 32, 520, 320, 1.0); screen.position.set(0, 30, 1.6); monitor.add(screen);
  const paintScreen = () => {
    const g = screen.userData.g; g.fillStyle = '#000'; g.fillRect(0, 0, 520, 320);
    const cell = 2, ox = 260 - img.w, oy = 160 - img.h;
    for (let r = 0; r < img.h; r++) for (let c = 0; c < img.w; c++) {
      const v = Math.round(process(r * img.w + c, { voi: 1, s: 0.6, level: 0.5, width: 1 }) * 255);
      g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(ox + c * cell, oy + r * cell, cell, cell);
    }
    g.fillStyle = '#7fe3a4'; g.font = '14px monospace'; g.fillText('L HAND PA', 16, 24);
    screen.userData.tex.needsUpdate = true;
  };
  paintScreen();

  // the corner of the hand the matrix scene starts in: a finger joint
  const Z = { c0: 30, r0: 34, cols: 10, rows: 7 };
  const steps = [
    {
      title: 'Into the image matrix', dur: 16, view: 'pixel', fadeIn: 0.5,
      scale: (t) => (t < 8 ? '1 mm' : t < 12 ? '1 cm' : '10 cm'),
      cues: Array.from({ length: 14 }, (_, k) => [0.6 + k * 0.45, () => sfx.tick()]),
      frame(t) {
        px.fillAll('ink');
        // a few rows of pixels arrive as numbers, then the view pulls back to the whole image
        const zoom = span(t, 8, 13, api.ease.inOut);
        const cellBig = Math.floor(Math.min((px.W - 20) / Z.cols, (px.H - 70) / Z.rows));   // (room under it for the caption)
        const cellAll = Math.min((px.H - 16) / img.h, (px.W - 20) / img.w);
        const cell = Math.exp(lerp(Math.log(cellBig), Math.log(cellAll), zoom));
        // keep the zoomed patch's centre fixed on screen as the whole image comes in
        const fcx = Z.c0 + Z.cols / 2, fcy = Z.r0 + Z.rows / 2;
        const cx = px.W / 2, cy = lerp(px.H / 2 - 24, px.H / 2 + 4, zoom);
        const ox = cx - fcx * cell + lerp(0, (fcx - img.w / 2) * cellAll, zoom), oy = cy - fcy * cell + lerp(0, (fcy - img.h / 2) * cellAll, zoom);
        const filled = Math.floor(span(t, 0.5, 7, api.ease.linear) * Z.cols * Z.rows);
        const rawGrey = (i) => rawN[i];
        if (zoom < 0.02) {
          for (let k = 0; k < Z.cols * Z.rows; k++) {
            const c = Z.c0 + (k % Z.cols), r = Z.r0 + Math.floor(k / Z.cols), i = r * img.w + c;
            const x = ox + c * cell, y = oy + r * cell;
            px.frame(x, y, cell, cell, 'dkgrey');
            if (k < filled) {
              const age = (filled - k) / 6;
              const g = Math.round(rawGrey(i) * 255);
              px.rect(x + 1, y + 1, cell - 2, cell - 2, `rgb(${g},${g},${g})`, clamp01(age));
              px.text(String(raw[i]), x + cell / 2, y + cell / 2 - 2, g > 140 ? 'ink' : 'lime', 1, 1, 'center');
            }
          }
          // the next value flying in from the readout
          if (filled < Z.cols * Z.rows && t < 7) {
            const k = filled, c = Z.c0 + (k % Z.cols), r = Z.r0 + Math.floor(k / Z.cols);
            const f = (t * 1000 % 450) / 450;
            px.text(String(raw[r * img.w + c]), lerp(-10, ox + c * cell + cell / 2, f), lerp(px.H - 10, oy + r * cell + cell / 2, f), 'yellow', 1, 1, 'center');
          }
          api.keepOut([ox + Z.c0 * cell, oy + Z.r0 * cell, Z.cols * cell, Z.rows * cell]);
          const kk = Math.min(filled, Z.cols * Z.rows - 1);
          api.mark([ox + (Z.c0 + kk % Z.cols) * cell, oy + (Z.r0 + Math.floor(kk / Z.cols)) * cell, cell, cell], 'yellow', t);
        } else {
          // the rest of the image fills in (as the readout did it), then all of it
          drawImage(ox, oy, cell, rawGrey);
          if (cell > 12) for (let r = Z.r0; r < Z.r0 + Z.rows; r++) for (let c = Z.c0; c < Z.c0 + Z.cols; c++) px.text(String(raw[r * img.w + c]), ox + c * cell + cell / 2, oy + r * cell + cell / 2 - 2, 'lime', clamp01((cell - 12) / 6), 1, 'center');
        }
      },
      caption: [
        { from: 0.6, to: 7.5, text: 'Each number from the ADC is placed in the <b>image matrix</b> at its pixel’s row and column, as the rows are read.' },
        { from: 7.5, to: 16, text: 'Thousands of them together: the raw image. The detector’s values run from many photons (the open field) to few (bone): here it looks flat and the wrong way round.' },
      ],
    },
    {
      title: 'The histogram', dur: 14, view: 'pixel', scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        const cell = Math.min((px.H - 16) / img.h, (px.W * 0.45) / img.w);
        const ox = 10, oy = (px.H - img.h * cell) / 2;
        // the image scanned into the plot row by row
        const k = span(t, 0.5, 6, api.ease.linear), n = Math.floor(k * img.h);
        drawImage(ox, oy, cell, (i) => rawN[i]);
        if (k < 1) px.rect(ox, oy + n * cell, img.w * cell, 1, 'yellow');
        const vals = Array.from(rawN.subarray(0, n * img.w));
        const hx = Math.round(ox + img.w * cell + 14), hw = px.W - hx - 10, hy = 24, hh = px.H - 60;
        histogramPlot(px, hx, hy, hw, hh, vals, { bins: 64, fill: 1, color: 'grey', clip: true });
        api.keepOut([hx, hy, hw, hh]);
        // the lobes in turn: the open field, then the soft tissue, then the bone
        if (t > 6.5 && t < 9) api.mark([hx + hw * 0.86, hy, hw * 0.13, hh], 'cyan', t);
        if (t > 9 && t < 11.5) api.mark([hx + hw * 0.2, hy + hh * 0.3, hw * 0.32, hh * 0.7], 'pink', t);
        if (t > 11.5) api.mark([hx + hw * 0.03, hy + hh * 0.3, hw * 0.18, hh * 0.7], 'yellow', t);
        px.text('few', hx + 3, hy + hh + 6, 'mid'); px.text('many photons', hx + hw - 2, hy + hh + 6, 'mid', 1, 1, 'right');
      },
      caption: [
        { from: 0.5, to: 6.5, text: 'Counting how many pixels have each value gives the image’s <b>histogram</b>.' },
        { from: 6.5, to: 9, text: 'A tall spike where the beam missed the hand: the open field, nothing but raw beam.' },
        { from: 9, to: 11.5, text: 'A broad hump for the soft tissue...' },
        { from: 11.5, to: 14, text: '...and a lower one for the bone. The anatomy lies between the edges of these: the <b>values of interest</b> (VOI).' },
      ],
    },
    {
      title: 'Rescaling to the VOI', dur: 12, view: 'pixel', scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        const k = span(t, 1.5, 6);
        const cell = Math.min((px.H - 16) / img.h, (px.W * 0.45) / img.w);
        const ox = 10, oy = (px.H - img.h * cell) / 2;
        // from the raw signal to its log, inverted, stretched over the VOI
        drawImage(ox, oy, cell, (i) => lerp(rawN[i], process(i, { voi: k }), k));
        const hx = Math.round(ox + img.w * cell + 14), hw = px.W - hx - 10;
        curvePlot(px, hx, 20, hw, 90, (u) => (k < 0.5 ? lerp(u, 1 - u, k * 2) : clamp01(((1 - u) - lerp(0, VOI[0], k)) / (lerp(1, VOI[1], k) - lerp(0, VOI[0], k)))), { color: 'yellow' });
        histogramPlot(px, hx, 116, hw, 50, Array.from(logv), { bins: 64, voi: [lerp(0, VOI[0], k), lerp(1, VOI[1], k)], color: 'grey', clip: true });
        api.keepOut([hx, 20, hw, 146]);
        if (t > 6) api.mark([hx + 3 + VOI[0] * (hw - 6), 116, (VOI[1] - VOI[0]) * (hw - 6), 50], 'yellow', t);
      },
      caption: [
        { from: 1, to: 6, text: 'Processing first takes the log of the signal and inverts it, so attenuation, and bone, reads as white.' },
        { from: 6, to: 12, text: 'Then <b>automatic rescaling</b> finds the VOI in the histogram and stretches just that range over the whole grey scale: the same image at any exposure.' },
      ],
    },
    {
      title: 'The look-up table', dur: 12, view: 'pixel', scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        const s = t < 6 ? lerp(0, 0.9, span(t, 1, 5)) : lerp(0.9, 0.35, span(t, 7, 10));
        const cell = Math.min((px.H - 16) / img.h, (px.W * 0.45) / img.w);
        const ox = 10, oy = (px.H - img.h * cell) / 2;
        drawImage(ox, oy, cell, (i) => process(i, { voi: 1, s }));
        const hx = Math.round(ox + img.w * cell + 14), hw = px.W - hx - 10;
        curvePlot(px, hx, 20, hw, 110, (u) => sNorm(u, s), { color: 'yellow' });
        px.text('in', hx + hw - 2, 134, 'mid', 1, 1, 'right'); px.text('out', hx + 2, 12, 'mid');
        api.keepOut([hx, 12, hw, 128]);
      },
      caption: [
        { from: 0.8, to: 6, text: 'A <b>look-up table</b> (LUT) maps each value to the grey it is shown as. Its <b>response curve</b>: a steep S gives high contrast in the middle greys.' },
        { from: 6, to: 12, text: 'A gentler curve keeps more of the range visible: each body part has its own LUT, chosen with the protocol.' },
      ],
    },
    {
      title: 'Brightness and contrast', dur: 14, view: 'pixel', scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        let level = 0.5, width = 1;
        if (t < 7) level = 0.5 + 0.22 * Math.sin(span(t, 1, 6.5, api.ease.linear) * Math.PI * 2);
        else width = lerp(1, 0.45, span(t, 7.5, 10)) + lerp(0, 0.55, span(t, 11.5, 13.5));
        const cell = Math.min((px.H - 16) / img.h, (px.W * 0.45) / img.w);
        const ox = 10, oy = (px.H - img.h * cell) / 2;
        drawImage(ox, oy, cell, (i) => process(i, { voi: 1, s: 0.35, level, width }));
        const hx = Math.round(ox + img.w * cell + 14), hw = px.W - hx - 10;
        curvePlot(px, hx, 20, hw, 110, (u) => clamp01((sNorm(u, 0.35) - (level - width / 2)) / width), { color: 'yellow' });
        px.text('WL ' + Math.round(level * 4095), hx + 2, 140, 'white');
        px.text('WW ' + Math.round(width * 4095), hx + 2, 150, 'white');
        api.keepOut([hx, 20, hw, 136]);
      },
      caption: [
        { from: 0.8, to: 7, text: 'The <b>window level</b> slides the curve along: the whole image lighter or darker, its <b>brightness</b>.' },
        { from: 7, to: 14, text: 'The <b>window width</b> sets its steepness: narrow, high <b>contrast</b> over a few values; wide, low contrast over many.' },
      ],
    },
    {
      title: 'On the monitor', dur: 9, fadeOut: 1.2, scale: '10 cm',
      enter() { S.only('room'); },
      cam: [[0, [-60, 40, 300], [-150, 10, 160], 40], [9, [-110, 20, 230], [-150, 10, 160], 34]],
      cues: [[0.5, () => sfx.chime()]],
      frame(t) { if (t > 2) api.mark(screen, 'lime', t); },
      caption: [{ from: 2, to: 8, text: 'The processed image goes to the monitor for review, and on to the archive (PACS).' }],
    },
  ];
  return { title: 'The image', steps };
}
