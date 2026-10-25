/* X-RAY FILM, chapter 3: the detector. The AEC's chambers ending the exposure; the flat panel's
   layers; an x-ray turned to light in a caesium iodide needle and to charge in a pixel's
   photodiode; the pixel's parts (detecting area, storage capacitor, thin-film transistor, gate and
   data lines); the rows read out one at a time; the charge amplified and digitised. */
import * as THREE from 'three';
import { electron, keVColor } from '../../kit/micro.js';
import { std, mesh, setOpacity, canvasPlane } from '../../kit/stage.js';

export async function detector(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const scene = api.scene;

  // ================================================================ the flat panel (3D)
  const det = new THREE.Group(); scene.add(det); S.sets.det = det;
  const layer = (h, mat, y) => { const m = mesh(new THREE.BoxGeometry(43, h, 43), mat, 0, y, 0); det.add(m); return m; };
  const cover = layer(0.4, new THREE.MeshStandardMaterial({ color: 0x1c2228, roughness: 0.6, transparent: true, opacity: 0.9 }), 3.0);
  // the scintillator: needles drawn on its edge and face
  const csi = canvasPlane(43, 43, 256, 256, 0.5); csi.rotation.x = -Math.PI / 2; csi.position.y = 2.0;
  { const g = csi.userData.g; g.fillStyle = '#6fd4c4'; g.fillRect(0, 0, 256, 256); g.fillStyle = '#4bb3a3';
    for (let i = 0; i < 256; i += 3) for (let j = 0; j < 256; j += 3) if ((i * 7 + j * 3) % 5 < 3) g.fillRect(i, j, 2, 2);
    csi.userData.tex.needsUpdate = true; }
  const csiSlab = layer(0.6, std(0x5fc4b4, 0.4, 0.0, { emissive: 0x0d2a26 }), 1.65);
  det.add(csi);
  // the TFT array on glass: a pixel grid on its face
  const tft = canvasPlane(43, 43, 512, 512, 0.45); tft.rotation.x = -Math.PI / 2; tft.position.y = 1.02;
  { const g = tft.userData.g; g.fillStyle = '#1b3a5c'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 512; i += 8) { g.fillStyle = '#c9a24a'; g.fillRect(i, 0, 1, 512); g.fillRect(0, i, 512, 1);
      for (let j = 0; j < 512; j += 8) { g.fillStyle = '#3b77b0'; g.fillRect(i + 2, j + 2, 5, 5); g.fillStyle = '#2a2a2a'; g.fillRect(i + 1, j + 1, 2, 2); } }
    tft.userData.tex.needsUpdate = true; }
  const glass = layer(0.5, new THREE.MeshPhysicalMaterial({ color: 0xa8c8e0, roughness: 0.1, transparent: true, opacity: 0.45 }), 0.75);
  det.add(tft);
  const pcb = layer(0.3, std(0x1f6b3a, 0.6, 0.1), -0.6);
  const chips = new THREE.Group(); det.add(chips);
  for (let i = 0; i < 8; i++) {
    chips.add(mesh(new THREE.BoxGeometry(3.2, 0.4, 1.4), std(0x111111, 0.4, 0.3), -17.5 + i * 5, -0.95, 20.5));   // readout ICs (the data lines' end)
    chips.add(mesh(new THREE.BoxGeometry(1.4, 0.4, 3.2), std(0x111111, 0.4, 0.3), -20.5, -0.95, -17.5 + i * 5));   // gate drivers (the rows' end)
  }
  const housing = layer(0.6, std(0x2a3036, 0.5, 0.3), -1.4);
  const layers = [cover, csiSlab, glass, pcb, housing];
  const base = layers.map((m) => m.position.y);
  const explode = (k) => {
    layers.forEach((m, i) => { m.position.y = base[i] + k * (layers.length - 1 - i) * 7 - k * 10; });
    csi.position.y = csiSlab.position.y + 0.32; tft.position.y = glass.position.y + 0.27;
    chips.position.y = pcb.position.y - base[3];
  };
  // the AEC's three chambers, just under the cover (drawn above it so they show)
  const aec = new THREE.Group(); det.add(aec);
  const cells = [[7.5, 4.5], [0, -4.5], [-7.5, 4.5]].map(([x, z]) => {
    const c = new THREE.Group(); c.position.set(x, 3.4, z); aec.add(c);
    c.add(new THREE.Mesh(new THREE.BoxGeometry(5, 0.3, 6.5), new THREE.MeshBasicMaterial({ color: 0x35c6d6, transparent: true, opacity: 0.3, depthWrite: false })));
    c.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(5, 0.3, 6.5)), new THREE.LineBasicMaterial({ color: 0x35c6d6 })));
    return c;
  });
  // a block of tissue over it for the AEC: thin, then thick
  const slab = mesh(new THREE.BoxGeometry(30, 1, 30), new THREE.MeshStandardMaterial({ color: 0xc9907a, transparent: true, opacity: 0.32, roughness: 0.7, depthWrite: false }), 0, 0, 0);
  det.add(slab);

  // ================================================================ 8-bit scenes
  // the scintillator in section: needles, an x-ray absorbed, its light down the needle
  function scintScene(t) {
    px.fillAll('ink');
    const W = px.W, H = px.H, n = 14, nw = Math.floor((W - 40) / n), x0 = Math.round((W - nw * n) / 2);
    const top = 34, csiH = 92, pdY = top + csiH + 4, pdH = 16;
    const charge = new Array(n).fill(0);
    // the needles
    for (let k = 0; k < n; k++) {
      const x = x0 + k * nw;
      px.rect(x + 2, top, nw - 4, csiH, 'teal', 0.55);
      px.rect(x + 2, top, 1, csiH, 'cyan', 0.6); px.rect(x + nw - 3, top, 1, csiH, 'cyan', 0.6);
      // the photodiode under it, and its capacitor's charge as a bar
      px.rect(x + 1, pdY, nw - 2, pdH, 'dkblue');
      px.rect(x + 3, pdY + 2, nw - 6, pdH - 4, 'blue', 0.55);
    }
    px.rect(x0, pdY + pdH + 2, nw * n, 3, 'slate');           // the glass
    // x-rays arrive; each is absorbed at some depth in a needle and makes a burst of light
    const rate = 2.6, N = Math.floor(t * rate);
    for (let i = Math.max(0, N - 40); i <= N; i++) {            // (the recent ones: a held step runs on)
      const r = rng(900 + i), k = Math.floor(r() * n), x = x0 + k * nw + 4 + r() * (nw - 8), depth = top + 10 + r() * (csiH - 26);
      const age = t - i / rate, E = 40 + r() * 40;
      if (age < 0) continue;
      const tIn = (depth + 10) / 220;
      if (age < tIn) { px.photon(x, -10 + age * 220, 0, 1, 7, keVColor(E), 1, t * 30 + i); continue; }
      const e = age - tIn;
      if (e < 0.25) px.glow(x, depth, 6, 'yellow', 0.95, i);
      // the light: a few dozen visible photons, bouncing down inside the needle's walls
      const nl = 26;
      for (let j = 0; j < nl; j++) {
        const rr = rng(i * 100 + j), a = (rr() - 0.5) * 2.4, sp = 60 + rr() * 50;
        const d = e * sp;
        if (d > (pdY - depth) / Math.max(0.3, Math.cos(a)) + 4) continue;
        // a straight path folded at the needle's walls (total internal reflection)
        const wL = x0 + k * nw + 3, wR = x0 + k * nw + nw - 4, span_ = wR - wL;
        let lx = x - wL + Math.sin(a) * d;
        lx = ((lx % (2 * span_)) + 2 * span_) % (2 * span_); if (lx > span_) lx = 2 * span_ - lx;
        const ly = depth + Math.abs(Math.cos(a)) * d;
        if (ly < pdY) px.px(wL + lx, ly, 'yellow', 0.95);
      }
      // what reached the photodiode, as charge
      charge[k] += clamp01((e - 0.25) / 0.35);
      if (e > 0.25 && e < 0.9) electron(px, x, pdY + 6 + (e - 0.25) * 12, 1 - (e - 0.25) / 0.65, 'cyan');
    }
    // the capacitors' charge
    for (let k = 0; k < n; k++) {
      const x = x0 + k * nw, h = Math.min(30, charge[k] * 4);
      px.frame(x + nw / 2 - 3, pdY + pdH + 8, 6, 32, 'mid');
      px.rect(x + nw / 2 - 2, pdY + pdH + 39 - h, 4, h, 'cyan');
    }
    return { x0, nw, top, csiH, pdY };
  }
  // one pixel element seen from above, its parts lit in turn
  function pixelScene(t, lit) {
    px.fillAll('ink');
    const W = px.W, H = px.H, s = Math.min(H - 40, 140), x = Math.round(W / 2 - s / 2), y = 24;
    const on = (k) => (lit === k ? 1 : lit ? 0.35 : 1);
    // neighbours, dim, to show it repeats
    for (const [dx, dy] of [[-1, 0], [1, 0]]) px.frame(x + dx * (s + 6), y + dy * (s + 6), s, s, 'dkgrey', 0.6);
    // gate line (a row) across the top, data line (a column) down the left
    px.rect(x - 60, y + 4, s + 120, 4, 'gold', on('gate'));
    px.rect(x + 4, y - 14, 4, s + 28, 'orange', on('data'));
    // the photodiode: the detecting area
    px.rect(x + 14, y + 14, s - 22, s - 22, 'blue', 0.85 * on('pd'));
    px.frame(x + 14, y + 14, s - 22, s - 22, 'cyan', on('pd'));
    // the storage capacitor (two plates) and the TFT in the corner
    px.rect(x + 16, y + s - 30, 18, 3, 'grey', on('cap')); px.rect(x + 16, y + s - 24, 18, 3, 'grey', on('cap'));
    px.rect(x + 10, y + 10, 12, 12, 'lime', 0.85 * on('tft')); px.frame(x + 10, y + 10, 12, 12, 'white', on('tft'));
    // the TFT's gate to the gate line, its drain to the data line
    px.line(x + 16, y + 10, x + 16, y + 8, 'lime', on('tft')); px.line(x + 10, y + 16, x + 8, y + 16, 'lime', on('tft'));
    // fill factor shading
    if (lit === 'ff') {
      const k = span(t, 0, 1);
      px.rect(x + 14, y + 14, s - 22, s - 22, 'yellow', 0.25 * k);
      px.text(Math.round(((s - 22) ** 2 / s ** 2) * 100) + '%', x + s / 2 + 4, y + s / 2, 'yellow', 1, 2, 'center');
    }
    const box = { pd: [x + 14, y + 14, s - 22, s - 22], ff: [x + 14, y + 14, s - 22, s - 22], cap: [x + 14, y + s - 32, 22, 12],
      tft: [x + 8, y + 8, 16, 16], gate: [x - 60, y + 2, s + 120, 8], data: [x + 2, y - 14, 8, s + 28] }[lit];
    if (box) api.mark(box, 'yellow', t);
    return { x, y, s };
  }
  // the readout: rows switched on in turn, each pixel's charge down its column
  const M = { cols: 12, rows: 8 };
  const charges = (() => { const r = rng(44), a = []; for (let i = 0; i < M.rows * M.cols; i++) a.push(0.2 + r() * 0.8); return a; })();
  function readoutScene(t, rowTime = 0.9) {
    px.fillAll('ink');
    const W = px.W, H = px.H, cw = Math.floor(Math.min((W - 80) / M.cols, (H - 70) / M.rows)), x0 = Math.round((W - cw * M.cols) / 2) + 6, y0 = 14;
    const cur = Math.floor(t / rowTime), into = (t % rowTime) / rowTime;
    // gate drivers on the left
    for (let r = 0; r < M.rows; r++) {
      const y = y0 + r * cw;
      const active = r === cur;
      px.rect(x0 - 16, y + 2, 10, cw - 4, active ? 'yellow' : 'dkgrey');
      px.rect(x0 - 6, y + 2, M.cols * cw + 6, 1, active ? 'yellow' : 'gold', active ? 1 : 0.35);
    }
    for (let c = 0; c < M.cols; c++) {
      const x = x0 + c * cw;
      px.rect(x + 1, y0 - 4, 1, M.rows * cw + 10, 'orange', 0.4);
      // the charge amplifier at the bottom of each column
      const ay = y0 + M.rows * cw + 8;
      px.line(x - 2, ay, x + 4, ay + 6, 'grey'); px.line(x + 4, ay + 6, x + 10, ay, 'grey'); px.line(x - 2, ay, x + 10, ay, 'grey');
    }
    for (let r = 0; r < M.rows; r++) for (let c = 0; c < M.cols; c++) {
      const x = x0 + c * cw, y = y0 + r * cw, q = charges[r * M.cols + c];
      // read rows are empty (reset), the current one drains
      const left = r < cur ? 0 : r === cur ? q * (1 - span(into, 0.1, 0.6)) : q;
      const b = Math.round(40 + left * 200);
      px.rect(x + 3, y + 3, cw - 5, cw - 5, `rgb(${Math.round(b * 0.35)},${Math.round(b * 0.6)},${b})`);
      px.rect(x + 2, y + 2, 3, 3, r === cur ? 'lime' : 'dkgrey');
      // the charge running down the column to its amplifier
      if (r === cur && into > 0.1 && into < 0.9) {
        const fy = lerp(y + cw / 2, y0 + M.rows * cw + 6, span(into, 0.1, 0.8));
        px.rect(x, fy, 3, 3, 'cyan');
      }
    }
    // the row just read, as numbers in a line buffer at the bottom
    const by = H - 24;
    if (cur > 0 || into > 0.8) {
      const rr = into > 0.8 ? cur : cur - 1;
      for (let c = 0; c < M.cols; c++) {
        const v = Math.round(charges[rr * M.cols + c] * 16383);
        px.text(String(v), x0 + c * cw + cw / 2, by + (c % 2) * 8, 'lime', 1, 1, 'center');   // (staggered: 5 digits are wider than a cell)
      }
    }
    if (cur < M.rows) api.mark([x0 - 18, y0 + cur * cw, M.cols * cw + 20, cw], 'yellow', t);
    return { cur };
  }
  // the ADC: the amplifier's voltage, sampled and rounded to a level, written in binary
  function adcScene(t) {
    px.fillAll('ink');
    const W = px.W, H = px.H, gx = 20, gy = 18, gw = W - 40, gh = 110, levels = 16;
    px.rect(gx, gy, gw, gh, 'navy', 0.6);
    for (let l = 0; l <= levels; l++) px.rect(gx, gy + gh - (l / levels) * gh, gw, 1, 'dkgrey', 0.6);
    // the analog signal: each pixel's level held for a moment, with a little settling
    const per = 0.5, n = Math.floor(gw / 16);
    const val = (k) => { const r = rng(70 + k); return 0.12 + r() * 0.8; };
    let lx = null, ly = null;
    const tShown = Math.min(n, t / per * 1.0);
    for (let i = 0; i < gw; i++) {
      const u = i / 16, k = Math.floor(u), f = u - k;
      if (u > tShown) break;
      const v = lerp(val(k - 1), val(k), 1 - Math.exp(-f * 8));
      const y = gy + gh - v * gh;
      if (lx != null) px.line(lx, ly, gx + i, y, 'orange');
      lx = gx + i; ly = y;
    }
    // samples, and the levels they round to
    const ks = Math.floor(tShown);
    for (let k = 0; k <= ks && k < n; k++) {
      const x = gx + k * 16 + 12, v = val(k), q = Math.round(v * levels) / levels;
      px.rect(x - 1, gy + gh - v * gh - 1, 3, 3, 'white');
      px.rect(x - 5, gy + gh - q * gh, 10, 1, 'lime');
    }
    // the latest sample in 4 bits (on screen) and 14 (in the detector)
    const v = val(Math.min(ks, n - 1)), q4 = Math.round(v * 15), q14 = Math.round(v * 16383);
    const bin = q4.toString(2).padStart(4, '0');
    px.text(bin, W / 2 - 30, gy + gh + 14, 'lime', 1, 3, 'center');
    px.text(String(q14), W / 2 + 50, gy + gh + 14, 'yellow', 1, 3, 'center');
  }

  // ================================================================ the steps
  const steps = [
    {
      title: 'Automatic exposure control', dur: 16, fadeIn: 0.5, scale: '10 cm',
      enter() { S.only('det'); explode(0); aec.visible = true; slab.visible = true; setOpacity(cover, 1); },
      cam: [[0, [45, 55, 60], [0, 4, 0], 40], [16, [35, 50, 55], [0, 4, 0], 40]],
      frame(t) {
        // two exposures: a thin part, then a thick one; the chambers' charge to the same set level
        const thick = t >= 8, t0 = thick ? 8 : 0, T = thick ? 20 : 8, tr = thick ? 0.22 : 0.6;
        slab.scale.y = T; slab.position.y = 3.6 + T / 2;
        const tt = t - t0;
        const need = 1.0, rateQ = tr * 0.9;             // the charge per second the chambers gather
        const tCut = need / rateQ;                       // when they reach the set level
        const on = tt > 0.4 && tt < 0.4 + tCut;
        const q = clamp01((tt - 0.4) * rateQ / need);
        // photons through the block onto the chambers
        if (on) {
          for (let i = 0; i < 30; i++) {
            const r = rng(i + Math.floor(t * 20) * 31);
            const x = (r() - 0.5) * 28, z = (r() - 0.5) * 28, y = 3.6 + T + 12 - ((t * 60 + i * 7) % (T + 12));
            if (y < 3.6 + T && r() > tr) continue;
            const [sx, sy, f] = api.toPx([x, y, z]);
            if (f) px.photon(sx, sy, 0, 1, 4, 'violet', 0.9, t * 30 + i);
          }
          sfx.hold('beam', 300, 0.035, 'sawtooth');
        } else sfx.stop('beam');
        cells.forEach((c) => { c.children[0].material.opacity = 0.3 + 0.6 * q; });
        if (tt > 0.4) cells.forEach((c) => api.mark(c, 'cyan', t));
        // the meter: charge against the set level
        const mx = px.W - 30, my = 20, mh = 90;
        px.frame(mx, my, 12, mh, 'mid');
        px.rect(mx + 1, my + mh - 1 - q * (mh - 2), 10, q * (mh - 2), q >= 1 ? 'yellow' : 'cyan');
        px.rect(mx - 4, my, 20, 1, 'red');
        const ms = Math.round(Math.min(tt - 0.4, tCut) * 100);
        if (tt > 0.4) px.text(Math.max(0, ms) + ' ms', mx + 6, my + mh + 6, q >= 1 ? 'yellow' : 'white', 1, 1, 'center');
        if (Math.abs(tt - 0.4 - tCut) < 0.03) sfx.blip(440);
      },
      caption: [
        { from: 0.5, to: 6, text: 'With <b>AEC</b>, ionisation chambers in front of the detector measure the radiation reaching it during the exposure.' },
        { from: 6, to: 11, text: 'When their charge reaches the level set for the right image, the exposure is <b>cut off</b>. A thin part: a short exposure.' },
        { from: 11, to: 16, text: 'A thick part lets fewer photons through, so the chambers take longer to fill: the AEC gives it a <b>longer exposure</b> automatically.' },
      ],
    },
    {
      title: 'The flat-panel detector', dur: 13, scale: '10 cm',
      enter() { S.only('det'); aec.visible = false; slab.visible = false; setOpacity(cover, 0.9); },
      cam: [[0, [50, 40, 60], [0, 0, 0], 40], [13, [55, 30, 55], [0, -4, 0], 40]],
      frame(t) {
        explode(span(t, 1, 4));
        const order = [csiSlab, glass, pcb];
        const i = t < 5 ? -1 : Math.min(2, Math.floor((t - 5) / 2.6));
        if (i >= 0) api.mark(order[i], 'yellow', t);
      },
      caption: [
        { from: 1, to: 5, text: 'Inside the detector, layer on layer under a carbon-fibre cover.' },
        { from: 5, to: 7.6, text: 'A <b>scintillator</b> of caesium iodide turns each x-ray into a flash of visible light.' },
        { from: 7.6, to: 10.2, text: 'Under it, on glass, the <b>pixel array</b>: millions of photodiodes, each with its own switch.' },
        { from: 10.2, to: 13, text: 'Beneath, the electronics: <b>gate drivers</b> along one edge, <b>readout</b> chips along the other.' },
      ],
    },
    {
      title: 'Light, then charge', dur: 13, view: 'pixel', scale: '100 µm',
      cues: [[0.4, () => sfx.tick()], [0.7, () => sfx.tick()]],
      frame(t) { const r = scintScene(t); if (t > 4.5 && t < 8.5) api.mark([r.x0 + 1, r.top, 40, r.csiH], 'yellow', t); },
      caption: [
        { from: 0.5, to: 4.5, text: 'An x-ray is absorbed in a <b>caesium iodide needle</b> and its energy comes out as a burst of thousands of visible light photons.' },
        { from: 4.5, to: 8.5, text: 'The needles are columns: the light runs down inside them, reflected at their walls, instead of spreading sideways and blurring the image.' },
        { from: 8.5, to: 13, text: 'At the bottom each pixel’s <b>photodiode</b> turns the light into electric charge, held in its <b>storage capacitor</b>: more x-rays, more charge.' },
      ],
    },
    {
      title: 'One pixel element', dur: 16, view: 'pixel', scale: '100 µm',
      frame(t) {
        const parts = ['pd', 'cap', 'tft', 'gate', 'data', 'ff'];
        const i = t < 1 ? -1 : Math.min(5, Math.floor((t - 1) / 2.5));
        pixelScene(t - 1 - i * 2.5, i >= 0 ? parts[i] : null);
      },
      caption: [
        { from: 1, to: 3.5, text: 'The <b>photodiode</b>: the pixel’s detecting area.' },
        { from: 3.5, to: 6, text: 'The <b>storage capacitor</b> holds the charge the photodiode makes.' },
        { from: 6, to: 8.5, text: 'The <b>thin-film transistor (TFT)</b>: a switch, closed through the exposure.' },
        { from: 8.5, to: 11, text: 'The <b>gate line</b> runs along the row: it opens every TFT in that row at once.' },
        { from: 11, to: 13.5, text: 'The <b>data line</b> runs down the column, carrying each pixel’s charge out to the readout.' },
        { from: 13.5, to: 16, text: 'Only the photodiode collects light: its share of the pixel is the <b>fill factor</b>. Smaller pixels lose more of it to the switch and lines.' },
      ],
    },
    {
      title: 'Read out row by row', dur: 12, view: 'pixel', scale: '1 mm',
      cues: Array.from({ length: 12 }, (_, k) => [k * 0.9 + 0.05, () => sfx.tick()]),
      frame(t) { readoutScene(t % (M.rows * 0.9 + 1.5)); },
      caption: [
        { from: 0.5, to: 6, text: 'After the exposure, the gate driver switches on one <b>row</b> of TFTs at a time.' },
        { from: 6, to: 12, text: 'Each pixel in that row empties its charge down its <b>data line</b> to a charge amplifier; then the next row, until the whole panel is read.' },
      ],
    },
    {
      title: 'Analog to digital', dur: 12, view: 'pixel', scale: '1 µs',
      cues: Array.from({ length: 20 }, (_, k) => [k * 0.5 + 0.2, () => sfx.blip(1200 + (k % 4) * 120)]),
      frame(t) { adcScene(t); },
      caption: [
        { from: 0.5, to: 6, text: 'The amplifier turns each pixel’s charge into a voltage: an <b>analog</b> signal, any value at all.' },
        { from: 6, to: 12, text: 'The <b>ADC</b> samples it and rounds it to the nearest of a fixed set of levels: 16 here, 16,384 (14 bits) in the detector. The pixel is now a number.' },
      ],
    },
  ];
  void lerp;
  return { title: 'The detector', steps };
}
