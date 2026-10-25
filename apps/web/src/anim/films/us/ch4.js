/* ULTRASOUND FILM, chapter 4: resolution and artefacts. Axial resolution (the pulse's length),
   lateral (the beam's width, narrowest at the focus), elevational (the slice's thickness, in 3D on
   the probe); the frequency trade on the seat's own image; then the artefacts, each the physics
   doing what it always does under the scanner's assumptions: shadowing behind a stone, enhancement
   behind fluid, reverberation between parallel reflectors, the mirror image behind the diaphragm.
   The 8-bit scanner here marches the same way the app's does (bmode.js): reflection at every
   impedance jump, attenuation both ways, speckle, TGC that assumes 0.5 dB/cm/MHz. */
import * as THREE from 'three';
import { ACOUSTIC } from '../../../core/acoustics.js';
import { makeField, drawField, panel, poly, arrow, span2, faceStrip, pulseP, TIS } from './wave.js';
import { greyOf, Z, ATT, BS } from './bmode.js';
import { R0 } from './probe.js';
import { setOpacity } from '../../kit/stage.js';

const hash = (a, b) => { let h = Math.imul(a, 73856093) ^ Math.imul(b, 19349663); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

export function artefacts(api, S) {
  const { px, sfx, span, lerp, clamp01 } = api;
  const R = S.room, W = S.W, B = S.big, seat = S.seat, fr = seat.fr, M = S.mon;
  const FACE = 16;
  const field4 = makeField(-10, FACE + 1, 520, 200, 4, 61);
  const field3 = makeField(-10, FACE + 1, 520, 200, 3, 62);
  const every = (t, per, n, make) => { const k = Math.floor(t / per), out = []; for (let j = k - n + 1; j <= k; j++) if (j >= 0) out.push(...[].concat(make(j * per, j))); return out; };

  // ================================================================ the 8-bit scanner
  /* A scene: the left half is the tissue (objects in a background), the right half the image the
     scanner makes of it, line by line, on the same scale. objs: [{ c: [x, y] (fraction of the
     half's width, cm deep), r (cm), id }] in a background tissue id. 8 cm deep. */
  const MATTIS = { 11: 'liver', 10: 'soft', 6: 'fluid', 5: 'fluid', 22: 'bone', 18: 'bone', 0: 'air', 1: 'air', 47: 'air' };
  function miniScene(objs, bg = 11, freq = 3.5) {
    const cache = new Map();
    const geo = () => {
      const top = FACE + 2, bot = px.H - 6, cmPx = (bot - top) / 8, half = Math.floor(px.W / 2) - 6;
      return { top, bot, cmPx, half, x0: 4, x1: 4 + half - 8, ix: half + 10 };
    };
    const matAt = (g, x, y) => {
      for (const o of objs) { const ox = g.x0 + o.c[0] * (g.x1 - g.x0), oy = g.top + o.c[1] * g.cmPx; if (Math.hypot(x - ox, y - oy) < o.r * g.cmPx) return o.id; }
      return bg;
    };
    // one column's greys, the app's march at 0.05 cm steps
    const column = (g, x) => {
      const ns = 160, ds = 8 / ns, out = new Uint8Array(ns);
      let amp = 1, prev = -1;
      const e = new Float32Array(ns);
      for (let k = 0; k < ns; k++) {
        const y = g.top + (k + 0.5) * ds * g.cmPx, id = matAt(g, x, y);
        let v = 0;
        if (prev >= 0 && id !== prev) { const rc = (Z[id] - Z[prev]) / (Z[id] + Z[prev]), Rr = rc * rc; v += Math.sqrt(Rr) * amp; amp *= Math.sqrt(Math.max(0, 1 - Rr)); }
        if (BS[id] > 0) v += BS[id] * (hash(Math.round(x * 3), k * 7 + 3) - 0.5) * 2 * amp * 0.09;
        e[k] = v * amp;
        amp *= Math.exp(-ATT[id] * freq * ds / 8.686);
        prev = id;
      }
      for (let k = 0; k < ns; k++) {
        const s = Math.abs((e[k - 1] || 0) * 0.5 + e[k] + (e[k + 1] || 0) * 0.5) / 2 + 7e-7;
        out[k] = greyOf(s, Math.min(66, 2 * 0.5 * freq * k * ds), 0, 55);
      }
      return out;
    };
    const fields = new Map();
    return {
      geo,
      draw(t, { per = 6, hold = 0.6, showBeam = true, tint = null } = {}) {
        const g = geo(), key = g.half + ':' + px.H;
        if (!cache.has(key)) { const cols = []; for (let x = g.x0; x <= g.x1; x++) cols.push(column(g, x)); cache.set(key, cols); }
        const cols = cache.get(key);
        if (!fields.has(key)) fields.set(key, field4.filter((q) => q.x >= g.x0 && q.x <= g.x1 && q.y > g.top).map((q) => ({ ...q, m: MATTIS[matAt(g, q.x, q.y)] || 'soft' })));
        drawField(px, fields.get(key), [], t, { pal: TIS });
        // the objects themselves, so they read at a glance: fluid dark blue, stone bright
        for (const o of [...objs].reverse()) {
          const ox = g.x0 + o.c[0] * (g.x1 - g.x0), oy = g.top + o.c[1] * g.cmPx, r = o.r * g.cmPx;
          if (o.id === 22 || o.id === 18) { px.circle(ox, oy, r, 'bone', 0.95, true); px.circle(ox, oy, r, 'white', 1); }
          else { px.circle(ox, oy, r, 'navy', 0.55, true); px.circle(ox, oy, r, 'blue', 0.5); }
        }
        faceStrip(px, g.x0 - 2, g.x1 + 2, FACE, { n: 12, glow: () => 0 });
        // the image, as far as the sweep has gone (then held a moment, then swept again)
        // (after the first sweep the last frame stays, each sweep rewriting it)
        const ph = ((t % per) + per) % per / (per - hold), xb = g.x0 + Math.min(1, ph) * (g.x1 - g.x0), built = t >= per ? g.x1 : xb;
        px.rect(g.ix - 2, g.top - 2, g.x1 - g.x0 + 4, g.bot - g.top + 4, 'black');
        for (let i = 0; i < cols.length; i++) {
          const x = g.x0 + i;
          if (x > built) break;
          const c = cols[i];
          for (let y = g.top; y < g.bot; y++) {
            const k = Math.min(159, Math.floor((y - g.top) / g.cmPx / 0.05));
            const v = c[k];
            if (v > 10) px.rect(g.ix + i, y, 1, 1, tint ? tint(i, k, v) : `rgb(${v},${v},${v})`);
          }
        }
        px.frame(g.ix - 2, g.top - 2, g.x1 - g.x0 + 4, g.bot - g.top + 4, 'dkgrey');
        if (showBeam && ph < 1) {
          px.rect(xb - 1, g.top, 3, g.bot - g.top, 'cyan', 0.18);
          const yy = g.top + ((t * 3) % 1) * (g.bot - g.top);
          px.rect(xb - 2, yy, 5, 2, 'white', 0.9);
          px.rect(g.ix + xb - g.x0, g.top, 1, g.bot - g.top, 'cyan', 0.5);
        }
        api.keepOut([g.ix - 2, g.top - 2, g.x1 - g.x0 + 4, g.bot - g.top + 4]);
        return g;
      },
      // an object's box in the tissue half, and the same place in the image half
      box(g, o, below = 0) {
        const ox = g.x0 + o.c[0] * (g.x1 - g.x0), oy = g.top + o.c[1] * g.cmPx, r = o.r * g.cmPx;
        return { tis: [ox - r - 2, oy - r - 2, 2 * r + 4, 2 * r + 4 + below], img: [ox - g.x0 + g.ix - r - 2, oy - r - 2, 2 * r + 4, 2 * r + 4 + below] };
      },
    };
  }
  // the gallbladder with a stone at its floor; a cyst alone in liver
  const GB = { c: [0.5, 3.2], r: 1.25, id: 6 }, STONE = { c: [0.5, 4.1], r: 0.42, id: 22 };
  const shadowScene = miniScene([STONE, GB]);
  const CYST = { c: [0.5, 3.0], r: 1.1, id: 5 };
  const cystScene = miniScene([CYST]);

  // ================================================================ the slice (3D, on the big probe)
  const slab = new THREE.Group(); api.scene.add(slab); S.sets.slab = slab; slab.visible = false;
  const elevW = (d) => (d < 6 ? 0.3 + 1.2 * ((6 - d) / 6) ** 2 : 0.3 + 0.9 * ((d - 6) / 6) ** 2);   // cm, thickness across
  {
    const nA = 40, nD = 40, D = 12, pos = [], idx = [];
    const P = (a, d, s) => { const r = R0 + d; return [Math.sin(a) * r, R0 - Math.cos(a) * r, s * elevW(d) / 2]; };
    for (const s of [-1, 1]) {
      const b = pos.length / 3;
      for (let i = 0; i <= nA; i++) for (let j = 0; j <= nD; j++) pos.push(...P(-0.525 + 1.05 * i / nA, D * j / nD, s));
      for (let i = 0; i < nA; i++) for (let j = 0; j < nD; j++) { const a = b + i * (nD + 1) + j, c = a + nD + 1; idx.push(a, c, a + 1, c, c + 1, a + 1); }
    }
    // the slab's edges (its far arc and its two sides), so the thickness reads
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
    slab.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x4fd1e0, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })));
    const edge = [];
    for (const s of [-1, 1]) for (const a of [-0.525, 0.525]) for (let j = 0; j < nD; j++) edge.push(...P(a, D * j / nD, s), ...P(a, D * (j + 1) / nD, s));
    for (let j = 0; j <= nD; j += 4) for (const a of [-0.525, 0.525]) edge.push(...P(a, D * j / nD, -1), ...P(a, D * j / nD, 1));
    const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
    slab.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x7ff6ff, transparent: true, opacity: 0.6 })));
  }
  // a small cyst, partly inside the slice
  const cyst3 = new THREE.Mesh(new THREE.SphereGeometry(0.45, 24, 16), new THREE.MeshStandardMaterial({ color: 0x2f6fb0, roughness: 0.3, transparent: true, opacity: 0.85 }));
  cyst3.position.set(1.6, -9, 0.5); slab.add(cyst3);

  // ================================================================ steps
  const monCam = [[0, W.monPos, W.monLook, 36]];
  const shadowLine = (() => {
    let best = -1, bv = 1e9;
    for (let l = 30; l < fr.nl - 12; l++) {          // (clear of the fan's left edge, dark with gel)
      let nb = 0; for (let d = 6; d <= 12; d++) nb += seat.deep[l - d] + seat.deep[l + d];
      const v = seat.deep[l] / (nb / 14);
      if (v < bv) { bv = v; best = l; }
    }
    // where the shadow starts: the first gas, lung, air or bone on that line below the skin
    let d0 = 4;
    for (let k = 20; k < fr.ns; k++) { const id = fr.ids[best * fr.ns + k]; if (id === 47 || id === 1 || id === 17 || id === 18 || (id === 0 && k > 30)) { d0 = k * fr.ds; break; } }
    return { l: best, d0 };
  })();
  const gbBox = (() => {
    let l0 = 1e9, l1 = -1, k1 = 0;
    for (let l = 0; l < fr.nl; l++) for (let k = 0; k < fr.ns; k++) if (fr.ids[l * fr.ns + k] === 6) { l0 = Math.min(l0, l); l1 = Math.max(l1, l); k1 = Math.max(k1, k); }
    return { l0, l1, d1: k1 * fr.ds };
  })();

  const steps = [
    {
      title: 'Axial resolution', dur: 15, view: 'pixel', scale: '1 mm', fadeIn: 0.4,
      cues: [[0.3, () => sfx.blip(1200)], [7.8, () => sfx.blip(1200)]],
      frame(t) {
        px.fillAll('ink');
        const half = px.W / 2, c = 32, lam = 12, y1 = 78, gap = 16, per = 7.5;
        [[5, 0], [2, 1]].forEach(([n, side]) => {
          const x0 = side ? half + 4 : 0, x1 = side ? px.W : half - 4;
          const inside = (x) => x > x0 && x < x1 - 46;
          const comps = every(t, per, 2, (t0) => [
            { kind: 'plane', o: [0, FACE], d: [0, 1], t0: t0 + 0.3, c, a: 1, lam, n, keep: (x) => inside(x) },
            { kind: 'plane', o: [0, y1], d: [0, -1], t0: t0 + 0.3 + (y1 - FACE) / c, c, a: 0.6, lam, n, keep: (x, y) => inside(x) && y < y1 },
            { kind: 'plane', o: [0, y1 + gap], d: [0, -1], t0: t0 + 0.3 + (y1 + gap - FACE) / c, c, a: 0.6, lam, n, keep: (x, y) => inside(x) && y < y1 + gap },
          ]);
          drawField(px, field3.filter((q) => inside(q.x)), comps, t, { gain: 0.5 });
          faceStrip(px, x0, x1 - 46, FACE, { n: 8, glow: () => (((t - 0.3) % per + per) % per < n * lam / c ? 1 : 0) });
          // the two reflectors
          for (const y of [y1, y1 + gap]) px.rect(x0 + 20, y, x1 - x0 - 86, 1, 'white');
          // what the scanner draws: each echo lasts half the pulse's length in depth
          const bx = x1 - 36, top = FACE + 4;
          px.rect(bx - 3, top - 2, 30, px.H - top - 2, 'black');
          const tt = ((t - 0.3) % per + per) % per, dRet = tt * c / 2;     // depth the returning echoes have reached
          for (let y = top; y < px.H - 6; y++) {
            const d = y - FACE;
            if (d > dRet) break;
            let v = 0;
            for (const yr of [y1, y1 + gap]) { const s = (d - (yr - FACE)) * 2; v += s > 0 && s < n * lam ? Math.sin(Math.PI * s / (n * lam)) ** 2 : 0; }
            const gg = Math.round(Math.min(1, v) * 255);
            if (gg > 8) px.rect(bx, y, 24, 1, `rgb(${gg},${gg},${gg})`);
          }
          // the pulse's length, bracketed beside its column
          span2(px, x0 + 8, y1 - n * lam, x0 + 8, y1, 'yellow', 0.7);
          if ((t < 7.5) === (side === 0)) api.mark([bx - 4, y1 - 8, 32, gap + n * lam / 2 + 14], side ? 'lime' : 'orange', t);
          api.keepOut([x0, FACE - 14, x1 - x0, y1 + gap + n * lam / 2 + 16 - FACE + 14]);
        });
      },
      caption: [
        { from: 0.6, to: 7.5, text: '<b>Axial resolution</b>: two reflectors one behind the other show apart only if their echoes do not overlap. A 5-cycle pulse: the two merge into one.', place: 'below' },
        { from: 7.5, to: 15, text: 'A short pulse resolves them: the limit is <b>half the spatial pulse length</b>. Higher frequency and better damping, finer axial detail (0.2 to 0.5 mm).', place: 'below' },
      ],
    },
    {
      title: 'Lateral resolution', dur: 15, view: 'pixel', scale: '1 mm',
      frame(t) {
        px.fillAll('ink');
        const half = Math.floor(px.W / 2) - 6, top = FACE + 2, F = top + 60, w0 = 5, zr = 26;
        const width = (y) => w0 * Math.sqrt(1 + ((y - F) / zr) ** 2) * (y < F ? 1.15 : 1);
        drawField(px, field4.filter((q) => q.x < half && q.y > top), [], t);
        faceStrip(px, 2, half - 2, FACE, { n: 12, glow: () => 0 });
        const per = 7, xb = 14 + (((t % per) + per) % per) / per * (half - 28);
        // the beam, sweeping across: narrow at the focus, wider above and below
        for (let y = top; y < px.H - 4; y++) { const w = width(y); px.rect(xb - w / 2, y, w, 1, 'cyan', 0.16); }
        // two pairs of point reflectors, the same gap apart: at the focus, and deep
        const pairs = [[F, 9], [F + 82, 9]], X = half / 2;
        for (const [y, gp] of pairs) for (const s of [-1, 1]) px.rect(X + s * gp / 2 - 1, y - 1, 3, 3, 'white');
        // the image: every point is drawn as wide as the beam is at its depth
        const ix = half + 10;
        px.rect(ix - 2, top - 2, half + 4, px.H - top - 2, 'black'); px.frame(ix - 2, top - 2, half + 4, px.H - top - 2, 'dkgrey');
        api.keepOut([ix - 2, top - 2, half + 4, px.H - top - 2]);
        for (const [y, gp] of pairs) {
          for (let x = 14; x <= xb; x++) {
            let v = 0;
            for (const s of [-1, 1]) { const dx = (X + s * gp / 2 - x) / (width(y) / 2); v += Math.exp(-dx * dx * 1.4); }
            const gg = Math.round(Math.min(1, v) * 240);
            if (gg > 12) px.rect(ix + x, y - 1, 1, 3, `rgb(${gg},${gg},${gg})`);
          }
        }
        px.rect(ix + xb, top, 1, px.H - top - 6, 'cyan', 0.5);
        px.line(2, F, half - 2, F, 'yellow', 0.35, 2);
        if (t < 7.5) api.mark([ix + X - 16, F - 7, 32, 14], 'lime', t);
        else api.mark([ix + X - 30, F + 75, 60, 14], 'orange', t);
      },
      caption: [
        { from: 0.6, to: 7.5, text: '<b>Lateral resolution</b>: as the beam sweeps, a point echoes for as long as the beam covers it, so it is drawn as wide as the beam. At the <b>focus</b> the beam is narrow: two close points stay apart.', place: 'above' },
        { from: 7.5, to: 15, text: 'Deeper, the beam has spread: the same two points blur into one. Set the focus at the depth of interest; higher frequencies make narrower beams.', place: 'above' },
      ],
    },
    {
      title: 'Slice thickness', dur: 15, scale: '1 cm',
      enter() { S.only('probe'); slab.visible = true; setOpacity(B.housing, 1); B.explode(0); B.fire(() => 0); B.g.rotation.set(0, 0, 0); },
      cam: [[0, [4, -2, 36], [0, -4, 0], 36], [6, [4, -2, 36], [0, -4, 0], 36], [11, [30, 2, 17], [0, -4.5, 0], 36], [15, [33, -1, 12], [0, -4.5, 0], 36]],
      frame(t) {
        slab.visible = true;
        if (t < 6.5) api.mark(slab.children[0], 'cyan', t);
        else api.mark(cyst3, 'yellow', t);
      },
      caption: [
        { from: 0.6, to: 6.5, text: 'The image is not a plane but a <b>slice</b>: across it, the beam is as thick as the elements are tall, narrowed only by the lens’s fixed focus.' },
        { from: 6.5, to: 15, text: 'Everything in that thickness is averaged into one picture (<b>elevational resolution</b>): a small cyst lying half in the slice fills in with echoes from the tissue beside it.' },
      ],
    },
    {
      title: 'Frequency: detail or depth', dur: 15, scale: '10 cm',
      enter() { S.roomReset(); M.reset(); },
      cam: monCam,
      frame(t) {
        M.keep(api);
        const wipe = Math.round(span(t, 1, 5) * 40) / 40;
        M.paint(fr, seat.g, 'freq' + wipe, (c) => {
          const s = M.sprite(seat.fr75);
          s.paint(seat.g75, { key: 'full' });
          const x = 100 + 320 * (1 - wipe);
          c.save(); c.beginPath(); c.rect(x, 0, 520 - x, 340); c.clip(); c.fillStyle = '#000'; c.fillRect(x, 0, 520 - x, 340); c.drawImage(s.cv, 100, 10); c.restore();
          c.fillStyle = '#ffd166'; c.fillRect(x, 10, 2, 320);
          c.fillStyle = '#000'; c.fillRect(10, 8, 88, 22);            // (the two frequencies are named below instead)
          c.fillStyle = '#e0e6ea'; c.font = '16px monospace'; c.fillText('3.5 MHz', 14, 300); c.fillStyle = '#ffd166'; c.fillText('7.5 MHz', 440, 300);
        });
        if (t < 8) api.mark(M.box(fr, 120, 190, 0.5, 6), 'lime', t);
        else api.mark(M.box(fr, 100, 190, 9, 15.8), 'orange', t);
      },
      caption: [
        { from: 0.6, to: 8, text: 'The same plane at <b>7.5 MHz</b> (right): a shorter pulse and a narrower beam, so finer speckle and sharper edges near the probe...' },
        { from: 8, to: 15, text: '...but attenuation, 0.5 dB/cm/MHz each way, takes the deep half: past about 9 cm only noise is left. The trade is always <b>resolution against penetration</b>.' },
      ],
    },
    {
      title: 'Acoustic shadowing', dur: 18, scale: (t) => (t < 7 ? '10 cm' : '1 cm'),
      enter() { S.roomReset(); M.reset(); M.paint(fr, seat.g, 'seat'); },
      cam: monCam,
      cues: [[7, () => sfx.whoosh()]],
      frame(t) {
        if (t < 7) {
          M.keep(api);
          api.mosaic(span(t, 5.6, 7));
          api.mark(M.box(fr, shadowLine.l - 3, shadowLine.l + 3, shadowLine.d0, 15.8), 'yellow', t);
          return;
        }
        api.mosaic(1 - span(t, 7, 7.6));
        px.fillAll('ink');
        const g = shadowScene.draw(t - 7, { per: 5.5 });
        const b = shadowScene.box(g, STONE, 60);
        api.mark(t < 12 ? b.tis : b.img, 'yellow', t);
      },
      caption: [
        { from: 0.6, to: 7, text: 'A dark band behind gas or bone: an <b>acoustic shadow</b>.' },
        { from: 7.5, to: 12, text: 'A gallstone reflects about 40% of the pulse and absorbs the rest within millimetres...' },
        { from: 12, to: 18, text: '...so nothing comes back from behind it: a black shadow under a bright curve, the sign that names a stone.' },
      ],
    },
    {
      title: 'Posterior enhancement', dur: 18, scale: (t) => (t < 7 ? '10 cm' : '1 cm'),
      enter() { S.roomReset(); M.reset(); M.paint(fr, seat.g, 'seat'); },
      cam: monCam,
      cues: [[7, () => sfx.whoosh()]],
      frame(t) {
        if (t < 7) {
          M.keep(api);
          api.mosaic(span(t, 5.6, 7));
          api.mark(M.box(fr, gbBox.l0 + 4, gbBox.l1 - 4, gbBox.d1 + 0.2, 15.6), 'yellow', t);
          return;
        }
        api.mosaic(1 - span(t, 7, 7.6));
        px.fillAll('ink');
        const g = cystScene.draw(t - 7, { per: 5.5 });
        const b = cystScene.box(g, CYST, 70);
        api.mark(t < 12 ? b.tis : [b.img[0], b.img[1] + b.img[3] - 60, b.img[2], 60], 'yellow', t);
      },
      caption: [
        { from: 0.6, to: 7, text: 'Below the gallbladder, a band brighter than the liver beside it: <b>posterior enhancement</b>.' },
        { from: 7.5, to: 12, text: 'Fluid attenuates almost nothing, so the pulse crossing a cyst arrives deeper stronger than its neighbours crossing tissue...' },
        { from: 12, to: 18, text: '...and the TGC, set for tissue, amplifies it just as much: a bright band beneath, the sign of <b>fluid</b>.' },
      ],
    },
    {
      title: 'Reverberation', dur: 15, view: 'pixel', scale: '1 cm',
      cues: [[2.7, () => sfx.blip(1000)], [5.2, () => sfx.blip(800)], [7.6, () => sfx.blip(640)], [10, () => sfx.blip(520)]],
      frame(t) {
        px.fillAll('ink');
        const half = Math.floor(px.W / 2) - 6, D = 34, yR = FACE + D, c = 28, lam = 10, per = 11;
        const inside = (x) => x > half / 2 - 26 && x < half / 2 + 26;
        // the pulse goes down; at the reflector part returns; at the face part of that is sent down
        // again; each round trip a copy, weaker
        const comps = every(t, per, 2, (t0) => {
          const out = [];
          for (let j = 0; j < 4; j++) {
            const a = Math.pow(0.5, j);
            out.push({ kind: 'plane', o: [0, FACE], d: [0, 1], t0: t0 + 0.3 + 2 * j * D / c, c, a, lam, n: 2, keep: (x, y) => inside(x) && y < yR });
            out.push({ kind: 'plane', o: [0, yR], d: [0, -1], t0: t0 + 0.3 + (2 * j + 1) * D / c, c, a: a * 0.7, lam, n: 2, keep: (x, y) => inside(x) && y < yR });
          }
          out.push({ kind: 'plane', o: [0, yR], d: [0, 1], t0: t0 + 0.3 + D / c, c, a: 0.3, lam, n: 2, keep: (x, y) => inside(x) && y > yR });
          return out;
        });
        drawField(px, field3.filter((q) => q.x < half && q.y > FACE), comps, t, { gain: 0.5 });
        faceStrip(px, 2, half - 2, FACE, { n: 12, glow: () => 0 });
        px.rect(half / 2 - 34, yR, 68, 2, 'white');
        // the image: the reflector, and a copy at every multiple of its depth, fading
        const ix = half + 10, top = FACE + 2;
        px.rect(ix - 2, top - 2, half + 4, px.H - top - 2, 'black'); px.frame(ix - 2, top - 2, half + 4, px.H - top - 2, 'dkgrey');
        api.keepOut([ix - 2, top - 2, half + 4, px.H - top - 2]);
        const tt = ((t - 0.3) % per + per) % per;
        for (let j = 1; j <= 4; j++) {
          if (tt < 2 * j * D / c) break;
          const y = FACE + j * D, a = Math.pow(0.55, j - 1);
          if (y < px.H - 6) { px.rect(ix + half / 2 - 34, y, 68, 2, 'white', a); px.text(String(j), ix + half / 2 + 40, y - 2, 'mid'); }
        }
        if (tt > 4) api.mark([ix + half / 2 - 40, FACE + 2 * D - 6, 80, 3 * D], 'yellow', t);
        else api.mark([half / 2 - 40, FACE, 80, D + 8], 'cyan', t);
      },
      caption: [
        { from: 0.6, to: 6, text: 'Between two strong parallel reflectors (here the probe’s face and a bright interface) the echo bounces back and forth...', place: 'below' },
        { from: 6, to: 15, text: '...and each extra round trip arrives later, so it is drawn deeper: <b>reverberation</b>, equally spaced copies fading with depth.', place: 'below' },
      ],
    },
    {
      title: 'Mirror image', dur: 16, view: 'pixel', scale: '1 cm', fadeOut: 0.5,
      cues: [[1.2, () => sfx.blip(900)], [4.2, () => sfx.ping(700)]],
      frame(t) {
        px.fillAll('ink');
        const cx = px.W * 0.4, F = [cx, FACE];
        // the diaphragm cups the liver's dome: seen from below the ribs it is a curve concave to the
        // probe, the air-filled lung beyond it
        const C = [cx - 120, FACE - 40], Rd = 170;
        const inLung = (x, y) => Math.hypot(x - C[0], y - C[1]) > Rd;
        for (const q of field4) {
          if (q.y <= FACE + 1) continue;
          const lung = inLung(q.x, q.y);
          px.px(q.x + Math.sin(t * 9 + q.ph) * 0.3, q.y, lung ? 'slate' : 'muscle', lung ? 0.45 : 0.65);
        }
        for (let a = -1.6; a <= 1.6; a += 0.003) { const y = C[1] + Math.cos(a) * Rd; if (y > FACE + 3) px.px(C[0] + Math.sin(a) * Rd, y, 'white', 0.9); }
        faceStrip(px, cx - 50, cx + 50, FACE, { n: 10, glow: () => 0 });
        // a beam line angled into it: it meets the curve, reflects (angle in = angle out) onto a lesion
        const th = -0.35, d = [Math.sin(th), Math.cos(th)];
        // the far intersection of F + s d with the circle (F is inside it)
        const fx = F[0] - C[0], fy = F[1] - C[1], b = fx * d[0] + fy * d[1], cc = fx * fx + fy * fy - Rd * Rd;
        const s1 = -b + Math.sqrt(Math.max(0, b * b - cc));
        const Mp = [F[0] + d[0] * s1, F[1] + d[1] * s1];
        const n = [(Mp[0] - C[0]) / Rd, (Mp[1] - C[1]) / Rd], dn = d[0] * n[0] + d[1] * n[1];
        const d2 = [d[0] - 2 * dn * n[0], d[1] - 2 * dn * n[1]];
        const sL = 60, Lp = [Mp[0] + d2[0] * sL, Mp[1] + d2[1] * sL];
        const Gp = [F[0] + d[0] * (s1 + sL), F[1] + d[1] * (s1 + sL)];
        px.circle(Lp[0], Lp[1], 6, 'yellow', 0.9, true);
        // the pulse's trip: down to the dome, across to the lesion, and all the way back
        const per = 8, tt = ((t % per) + per) % per, v = 70, Ltot = s1 + sL;
        const dist = tt * v;
        let p = null;
        if (dist < s1) p = [F[0] + d[0] * dist, F[1] + d[1] * dist];
        else if (dist < Ltot) p = [Mp[0] + d2[0] * (dist - s1), Mp[1] + d2[1] * (dist - s1)];
        else if (dist < Ltot + sL) p = [Lp[0] - d2[0] * (dist - Ltot), Lp[1] - d2[1] * (dist - Ltot)];
        else if (dist < 2 * Ltot) p = [Mp[0] - d[0] * (dist - Ltot - sL), Mp[1] - d[1] * (dist - Ltot - sL)];
        px.line(F[0], F[1], Mp[0], Mp[1], 'cyan', 0.6); px.line(Mp[0], Mp[1], Lp[0], Lp[1], 'cyan', 0.6);
        if (p) { px.rect(p[0] - 1, p[1] - 1, 3, 3, 'white'); }
        // where the scanner puts it: straight on down the line, as far as the echo travelled
        const k = tt > (2 * Ltot) / v ? 1 : t > per ? 1 : 0;
        if (k) {
          px.line(Mp[0], Mp[1], Gp[0], Gp[1], 'grey', 0.8, 2);
          px.circle(Gp[0], Gp[1], 6, 'yellow', 0.55, true);
          px.circle(Gp[0], Gp[1], 7, 'orange', 0.9);
        }
        if (t < 5) api.mark([Lp[0] - 10, Lp[1] - 10, 20, 20], 'yellow', t);
        else api.mark([Gp[0] - 11, Gp[1] - 11, 22, 22], 'orange', t);
      },
      caption: [
        { from: 0.6, to: 5, text: 'The diaphragm over the air-filled lung is a curved mirror. A beam meeting it at an angle is reflected onto a structure in the liver, and its echo returns the same way.', place: 'right' },
        { from: 5, to: 16, text: 'The scanner assumes a straight path, and draws the echo on down the line, as far as it travelled: a <b>mirror image</b>, a copy of the liver beyond the diaphragm, where only lung should be.', place: 'right' },
      ],
    },
  ];
  void poly; void arrow; void pulseP; void ACOUSTIC; void panel; void lerp; void clamp01;
  return { title: 'Resolution and artefacts', steps };
}
