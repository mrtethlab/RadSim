/* ULTRASOUND FILM, chapter 3: building the image. One real line through the seat's anatomy (the
   gallbladder's): the echoes' round trip timed into depth; the A-mode trace; the same echoes as
   brightness, B-mode; then line after line, fired along the array, into the frame on the fan in the
   patient; electronic focusing and steering by element delays; what depth costs in frame rate;
   TGC, gain and dynamic range on the scanner's monitor. Every image is the seat's own frame. */
import { setOpacity } from '../../kit/stage.js';
import { makeField, drawField, panel, poly, arrow, faceStrip } from './wave.js';
import { greys, fanSprite, tgcLut, C_SND, Z } from './bmode.js';

export function imaging(api, S) {
  const { px, sfx, span, lerp, clamp01 } = api;
  const R = S.room, W = S.W, V = S.V, seat = S.seat, fr = seat.fr, SEAT = seat.o;
  const FACE = 16, ns = fr.ns, L = seat.line;
  const hex = (id) => V.colors[id] || '#c07a6a';

  // ---- the line's interfaces: where the tissue changes and how strong its echo comes home
  // (reflected share at the jump, paid for both ways by every interface and centimetre above)
  const echoes = (() => {
    const out = [], ids = fr.ids, b = L * ns;
    let amp = 1, prev = -1;
    const ATTv = (id) => (id === 6 ? 0.1 : id === 3 ? 0.02 : id === 2 ? 0.6 : id === 7 ? 1 : id === 23 ? 1 : 0.5);
    for (let k = 0; k < ns; k++) {
      const id = ids[b + k];
      if (prev >= 0 && id !== prev) {
        const z1 = Z[prev], z2 = Z[id], r = (z2 - z1) / (z2 + z1);
        out.push({ k, d: k * fr.ds, e: Math.abs(r) * amp * amp, from: prev, to: id });
        amp *= Math.sqrt(1 - r * r);
      }
      amp *= Math.exp(-ATTv(id) * SEAT.freq * fr.ds / 8.686);
      prev = id;
    }
    return out;
  })();
  // the story's five along this line: into the skin, fat onto muscle, into the bowel, the
  // gallbladder's front and back walls (the first of each)
  const pick = (f, g) => echoes.find((e) => f(e.from) && g(e.to));
  const any = () => true;
  const strong = [pick(any, (b) => b === 23) || echoes[0], pick((a) => a === 2, (b) => b === 7), pick(any, (b) => b === 52),
    pick(any, (b) => b === 6), pick((a) => a === 6, any)].filter(Boolean).sort((a, b) => a.d - b.d);

  // the column of anatomy the line crosses, top (the face) to 16 cm
  const strip = (x, w, top, cmPx, a = 1) => {
    const b = L * ns, rows = Math.round(16 * cmPx);
    for (let j = 0; j < rows; j++) {
      const k = Math.min(ns - 1, Math.floor(j / cmPx / fr.ds));
      px.rect(x, top + j, w, 1, hex(fr.ids[b + k]), a * 0.85);
    }
  };
  const ruler = (x, top, cmPx) => { for (let d = 0; d <= 16; d += 2) { const y = top + d * cmPx; px.rect(x - 3, y, 3, 1, 'mid'); if (d % 4 === 0) px.text(String(d), x - 5, y - 2, 'mid', 1, 1, 'right'); } };
  // the line's displayed greys (the A-trace's height, the B-line's brightness), binned to rows
  // the A-trace: the echo's amplitude after TGC, before log compression (spikes over low grass)
  const lut = tgcLut(fr);
  const aLine = (row, cmPx) => {
    const k0 = Math.floor(row / cmPx / fr.ds), k1 = Math.min(ns - 1, Math.floor((row + 1) / cmPx / fr.ds));
    let m = 0;
    for (let k = k0; k <= k1; k++) m = Math.max(m, fr.env[L * ns + k] * Math.pow(10, (9 + lut[k]) / 20));
    return Math.min(1, Math.sqrt(m));
  };
  const gLine = (row, cmPx, l = L) => { const k = Math.min(ns - 1, Math.floor((row + 0.5) / cmPx / fr.ds)); return seat.g[l * ns + k] / 255; };

  // 8-bit fan sprites of the seat's frames (painted once, or line by line)
  const spr = {};
  const sprite = (key, f, w, h) => (spr[key] ??= fanSprite(f, w, h));

  // the plane's normal (camera side): from the patient's left, the image the right way round
  const rot = SEAT.rot * Math.PI / 180, nrm = [-Math.sin(rot), 0, Math.cos(rot)];
  const fanCam = (dist, up = 12) => [W.deep[0] + nrm[0] * dist, W.deep[1] + up, W.deep[2] + nrm[2] * dist];

  // focusing: a row of elements, each firing on its own delay; the wavelets add up into a front
  const fieldF = makeField(-10, 35, 520, 180, 4, 52);
  const NE = 16, PITCH = 13;

  // the monitor, front on
  const M = S.mon;
  const paintMon = (g, key, extra) => M.paint(fr, g, key, extra);
  const monBox = (l0, l1, d0, d1) => M.box(fr, l0, l1, d0, d1);
  const tgcCurve = (g, ramp, bands = null) => {
    // the TGC ramp beside the image, depth down, as machines draw it
    g.strokeStyle = '#7fd6e0'; g.lineWidth = 2; g.beginPath();
    for (let i = 0; i <= 40; i++) {
      const d = i / 40, gain = ramp * Math.min(1, d * 1.1) + (bands ? bands[Math.min(5, Math.floor(d * 6))] / 30 : 0);
      const x = 440 + gain * 60, y = 20 + d * 300;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke(); g.fillStyle = '#3b4b5a'; g.fillRect(440, 20, 1, 300);
  };

  const steps = [
    {
      title: 'The round trip', dur: 15, view: 'pixel', scale: '1 cm', fadeIn: 0.4,
      frame(t) {
        px.fillAll('ink');
        const top = FACE + 2, cmPx = (px.H - top - 8) / 16, x0 = 40, sw = 22;
        strip(x0, sw, top, cmPx);
        ruler(x0 - 2, top, cmPx);
        faceStrip(px, x0 - 4, x0 + sw + 4, FACE, { n: 3, glow: () => 0 });
        const per = 15, tt = ((t % per) + per) % per, v = 2.4;            // cm per second, slowed
        const dp = tt * v;
        // the pulse going down
        if (dp < 16) { const y = top + dp * cmPx; px.rect(x0 - 2, y - 1, sw + 4, 2, 'white'); px.rect(x0 - 2, y + 1, sw + 4, 1, 'cyan', 0.6); }
        // the echoes coming back up, and their arrival times
        const lx = x0 + sw + 22;
        const tx = px.W - 118, ty = 24, tw = 112, th = 18 + strong.length * 12;
        panel(api, tx, ty, tw, th);
        px.text('µs', tx + 36, ty + 4, 'mid', 1, 1, 'right'); px.text('cm', tx + tw - 6, ty + 4, 'mid', 1, 1, 'right');
        let latest = null;
        strong.forEach((e, i) => {
          const back = tt * v - e.d;                       // cm the echo has come back
          const a = clamp01(0.45 + 0.12 * Math.log10(e.e * 1e4));
          if (back > 0 && back < e.d) {
            const y = top + (e.d - back) * cmPx;
            px.rect(x0 - 1, y, sw + 2, 1, 'yellow', a);
            px.line(x0 + sw + 3, y, x0 + sw + 8, y, 'yellow', a);
            latest = { e, y };
          }
          if (back >= 0 && back < 0.6) px.rect(x0 - 2, top + e.d * cmPx - 1, sw + 4, 3, 'orange', 0.9);
          if (back >= e.d) {
            const us = 2 * e.d / C_SND;
            px.text(String(Math.round(us)), tx + 36, ty + 16 + i * 12, 'yellow', 1, 1, 'right');
            arrow(px, tx + 42, ty + 18 + i * 12, tx + 58, ty + 18 + i * 12, 'mid');
            px.text(e.d.toFixed(1), tx + tw - 6, ty + 16 + i * 12, 'white', 1, 1, 'right');
          }
        });
        void lx;
        // the clock
        px.text(Math.round(tt * v / C_SND) + ' µs', x0 + sw + 10, top + 2, 'cyan');
        if (latest) api.mark([x0 - 4, latest.y - 4, sw + 8, 8], 'yellow', t);
        else if (tt > 2) api.mark([tx, ty, tw, th], 'yellow', t);
        api.keepOut([x0 - 4, top, sw + 8, px.H - top]);
      },
      cues: [[0.1, () => sfx.blip(1320)]],
      caption: [
        { from: 0.5, to: 7.5, text: 'One pulse down one line of the real anatomy. Each interface sends an echo back; deeper ones come home later.', place: 'right' },
        { from: 7.5, to: 15, text: 'The scanner turns time into depth: <b>depth = c × t ÷ 2</b> (there and back). At 1540 m/s, <b>13 µs</b> for every centimetre.', place: 'right' },
      ],
    },
    {
      title: 'A-mode', dur: 13, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('ink');
        const top = FACE + 2, cmPx = (px.H - top - 8) / 16, x0 = 40, sw = 22;
        strip(x0, sw, top, cmPx);
        ruler(x0 - 2, top, cmPx);
        faceStrip(px, x0 - 4, x0 + sw + 4, FACE, { n: 3, glow: () => 0 });
        // the trace builds as the echoes arrive (each 0.35 s of play is 1 cm of round trip)
        const per = 13, tt = ((t % per) + per) % per, dRet = Math.min(16, tt * 2.2);
        const ax = x0 + sw + 14, aw = Math.min(150, px.W - ax - 20);
        panel(api, ax - 4, top - 2, aw + 8, 16 * cmPx + 4);
        px.rect(ax, top, 1, 16 * cmPx, 'mid');
        poly(px, Math.floor(dRet * cmPx), (j) => [ax + aLine(j, cmPx) * aw, top + j], 'lime');
        // the gallbladder's front wall: the spike to look at
        const gb = strong.find((e) => e.to === 6) || strong[2];
        if (tt > 6 && gb && gb.d < dRet) api.mark([ax - 2, top + gb.d * cmPx - 5, aw * 0.9, 10], 'yellow', t);
        else api.mark([ax - 4, top - 2, aw + 8, Math.max(8, dRet * cmPx)], 'lime', t);
      },
      caption: [
        { from: 0.5, to: 6, text: 'Draw each echo’s strength against its depth and you have <b>A-mode</b> (amplitude mode): a spike for every interface, the grain of tissue scatter between.', place: 'right' },
        { from: 6, to: 13, text: 'Skin, fat, muscle, a fluid-filled loop of bowel, then the <b>gallbladder</b>: between their walls, fluids send back almost nothing.', place: 'right' },
      ],
    },
    {
      title: 'B-mode: brightness', dur: 14, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('ink');
        const top = FACE + 2, cmPx = (px.H - top - 8) / 16, x0 = 40, sw = 22;
        strip(x0, sw, top, cmPx, 0.5);
        ruler(x0 - 2, top, cmPx);
        const ax = x0 + sw + 14, aw = 70;
        // the A trace fading, the same numbers as greys in a column beside it
        const k1 = span(t, 0.5, 4);
        poly(px, Math.floor(16 * cmPx), (j) => [ax + aLine(j, cmPx) * aw, top + j], 'lime', 1 - 0.7 * k1);
        const bx = ax + aw + 12;
        for (let j = 0; j < 16 * cmPx; j++) { const g = Math.round(gLine(j, cmPx) * 255 * k1); px.rect(bx, top + j, 4, 1, `rgb(${g},${g},${g})`); }
        // then its neighbours, line by line: a picture (the lines still side by side, unconverted)
        const n = Math.floor(span(t, 5, 11, api.ease.linear) * 60);
        for (let c = 1; c <= n; c++) {
          for (const s of [-1, 1]) {
            const l = L + s * c * 1;
            if (l < 0 || l >= fr.nl) continue;
            for (let j = 0; j < 16 * cmPx; j += 1) {
              const g = Math.round(gLine(j, cmPx, l) * 255);
              px.rect(bx + s * c * 2 + (s > 0 ? 2 : 0), top + j, 2, 1, `rgb(${g},${g},${g})`);
            }
          }
        }
        if (t < 5) api.mark([bx - 2, top - 2, 8, 16 * cmPx + 4], 'yellow', t);
        else api.mark([bx - n * 2 - 2, top - 2, n * 4 + 8, 16 * cmPx + 4], 'white', t);
        api.keepOut([ax, top, aw + 20, 16 * cmPx]);
      },
      caption: [
        { from: 0.5, to: 5, text: '<b>B-mode</b> (brightness mode) writes the same echoes as dots along the line, brighter for stronger, after compressing their huge range into greys.', place: 'right' },
        { from: 5, to: 14, text: 'Fire the next line beside it, and the next: line by line, a cross-section of the body appears.', place: 'right' },
      ],
    },
    {
      title: 'Line by line', dur: 16, scale: '10 cm',
      cues: Array.from({ length: 16 }, (_, i) => [i + 0.02, () => sfx.tick()]),
      enter() {
        S.roomReset(); R.fan.visible = true; R.section.visible = true;
        setOpacity(R.meshes.skin, 0.22); setOpacity(R.meshes.bone, 0.5); setOpacity(R.probe.housing, 0.35);
        R.fan.material.opacity = 1;
      },
      cam: [[0, fanCam(95, 34), W.deep, 36], [16, fanCam(72, 18), W.deep, 36]],
      frame(t) {
        const per = 8, ph = ((t % per) + per) % per / per, up = ph * (fr.nl + 4);
        R.setFan(fr, seat.g, { upTo: up });
        R.section.material.opacity = 0.4;
        const el = Math.min(63, Math.max(0, Math.round(up / (fr.nl - 1) * 63)));
        R.probe.fire((i) => (Math.abs(i - el) < 6 ? 1 - Math.abs(i - el) / 6 : 0));
        // the line being fired, picked out
        const l = Math.min(fr.nl - 1, Math.floor(up));
        const th = (l / (fr.nl - 1) - 0.5) * fr.P.sector;
        const a = R.rock.localToWorld(new api.THREE.Vector3(Math.sin(th) * 6, -Math.cos(th) * 6, 0));
        const b = R.rock.localToWorld(new api.THREE.Vector3(Math.sin(th) * 22, -Math.cos(th) * 22, 0));
        const [ax, ay] = api.toPx(a), [bx, by] = api.toPx(b);
        if (up < fr.nl) px.line(ax, ay, bx, by, 'yellow', 0.8);
        if (t < 8) api.mark(R.probe.elements, 'yellow', t);
        else api.mark(R.sheet, 'cyan', t);
      },
      caption: [
        { from: 0.5, to: 8, text: 'A group of elements fires down one <b>scan line</b> and listens; its echoes become one line of the image. Then the next group, one step along the curve.' },
        { from: 8, to: 16, text: '192 lines make one <b>frame</b>, laid out in the fan they were fired in: the liver’s grain, and the dark, fluid-filled bowel and gallbladder.' },
      ],
    },
    {
      title: 'Focusing and steering', dur: 18, view: 'pixel', scale: '1 mm',
      cues: [0.3, 4.8, 9.3, 13.8].map((c) => [c, () => sfx.blip(1500)]),
      frame(t) {
        px.fillAll('ink');
        const top = 34, cx = px.W / 2 - 30;
        const xs = Array.from({ length: NE }, (_, i) => cx + (i - (NE - 1) / 2) * PITCH);
        const per = 4.5, k = Math.floor(t / per), tt = t - k * per;
        const mode = t < 9 ? 'focus' : 'steer';
        const c = 30, lam = 14;
        let tau;
        const F = [cx, top + 96];
        if (mode === 'focus') {
          const Ls = xs.map((x) => Math.hypot(x - F[0], F[1] - top)), Lm = Math.max(...Ls);
          tau = Ls.map((l) => (Lm - l) / c);
        } else {
          const th = (k % 2 ? -1 : 1) * 22 * Math.PI / 180;
          tau = xs.map((x, i) => (th > 0 ? i : NE - 1 - i) * PITCH * Math.abs(Math.sin(th)) / c);
        }
        const comps = xs.map((x, i) => ({ kind: 'point', o: [x, top], t0: 0.3 + tau[i], c, a: 1.1, lam, n: 2, r0: 10, keep: (xx, yy) => yy > top }));
        drawField(px, fieldF, comps, tt, { gain: 0.5, thr: 0.24 });
        // each element's wavelet, its leading edge as a faint ring (Huygens): their envelope is the front
        xs.forEach((x, i) => {
          const r = (tt - 0.3 - tau[i]) * c;
          if (r <= 1 || r > 220) return;
          const n = Math.ceil(r * 2.2);
          for (let j = 0; j <= n; j++) { const a = Math.PI * j / n; px.px(x + Math.cos(a) * r, top + Math.sin(a) * r, 'blue', 0.35); }
        });
        // the elements, lit as they fire, and their delays as bars above
        xs.forEach((x, i) => {
          const fire = tt - 0.3 - tau[i];
          px.rect(x - 5, top - 6, 10, 5, fire > 0 && fire < 0.25 ? 'white' : 'gold');
          const h = tau[i] / Math.max(...tau, 1e-6) * 18;
          px.rect(x - 2, top - 9 - h, 4, Math.max(1, h), 'cyan', 0.85);
        });
        px.rect(xs[0] - 8, top - 1, xs[NE - 1] - xs[0] + 16, 2, 'lav');
        api.keepOut([xs[0] - 8, 4, xs[NE - 1] - xs[0] + 16, top]);
        if (mode === 'focus') {
          px.line(F[0] - 3, F[1], F[0] + 3, F[1], 'yellow'); px.line(F[0], F[1] - 3, F[0], F[1] + 3, 'yellow');
          // the beam's outline: wide at the face, narrow at the focus, spreading beyond
          for (const s of [-1, 1]) {
            px.line(F[0] + s * (NE * PITCH / 2), top, F[0] + s * 4, F[1], 'dkgrey', 0.8, 2);
            px.line(F[0] + s * 4, F[1], F[0] + s * 26, px.H, 'dkgrey', 0.8, 2);
          }
          if (tt > 1.4) api.mark([F[0] - 12, F[1] - 10, 24, 20], 'yellow', t);
          else api.mark([xs[0] - 8, 4, xs[NE - 1] - xs[0] + 16, top - 4], 'cyan', t);
        } else {
          const th = (k % 2 ? -1 : 1) * 22 * Math.PI / 180;
          arrow(px, cx, top + 20, cx + Math.sin(th) * 80, top + 20 + Math.cos(th) * 80, 'yellow', 0.8);
          api.mark([xs[0] - 8, 4, xs[NE - 1] - xs[0] + 16, top - 4], 'cyan', t);
        }
      },
      caption: [
        { from: 0.5, to: 9, text: '<b>Electronic focusing</b>: the outer elements fire first, the middle ones last, a few nanoseconds apart. Their wavelets meet together at one depth, the <b>focus</b>, where the beam is narrowest. Echoes are delayed and summed the same way on the way back.', place: 'right' },
        { from: 9, to: 18, text: '<b>Steering</b>: a delay that grows steadily across the array tilts the front, and the beam leaves at an angle. A phased array sweeps its whole sector from a small face this way, the probe never moving.', place: 'right' },
      ],
    },
    {
      title: 'Frame rate', dur: 15, view: 'pixel', scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        const sw = Math.min(118, Math.floor(px.W / 2 - 64)), y0 = 12;
        const sets = [[fr, seat.g, 16, 2.4], [seat.fr8, seat.g8, 8, 1.2]];
        sets.forEach(([f, g, d, per], i) => {
          const sh = i ? Math.round(sw * 0.62) : sw;
          const s = sprite('fr' + i + ':' + sw, f, sw, sh);
          const x = Math.round(px.W / 4 + i * px.W / 2 - sw / 2 - 22);
          const ph = ((t % per) + per) % per / per, up = ph * (f.nl + 6);
          // the previous frame stays until the sweep rewrites it
          const cv = s.paint(g, { upTo: f.nl, key: 'full' });
          px.g.globalAlpha = 0.45; px.g.drawImage(cv, x, y0); px.g.globalAlpha = 1;
          s.paint(g, { upTo: up });
          px.g.drawImage(s.cv, x, y0);
          s.paint(g, { upTo: f.nl, key: 'full' });               // (back to the full frame for next time)
          // beside it: the time a line takes, a frame takes, and the frames a second
          const lineUs = 2 * d / C_SND, frameMs = lineUs * f.nl / 1000, fps = 1000 / frameMs;
          const nx = x + sw + 4, ny = y0 + 18;
          px.text(d + ' cm', nx, ny, 'mid');
          px.text(Math.round(lineUs) + ' µs', nx, ny + 12, 'white');
          px.text(frameMs.toFixed(0) + ' ms', nx, ny + 22, 'cyan');
          px.text(Math.round(fps) + ' Hz', nx, ny + 34, 'yellow', 1, 2);
          if ((t < 7.5) === (i === 0)) api.mark([x - 2, y0 - 2, sw + 4, sh + 4], 'yellow', t);
          api.keepOut([x - 4, y0 - 4, sw + 48, sw + 8]);
        });
      },
      caption: [
        { from: 0.5, to: 7.5, text: 'A line cannot be fired until the echo from the bottom of the image is home: 13 µs per cm of depth. At 16 cm, 192 lines take 40 ms: 25 <b>frames</b> a second.' },
        { from: 7.5, to: 15, text: 'Halve the depth and the <b>frame rate</b> doubles. Every extra line, a wider sector, more focal zones or a colour box costs time.' },
      ],
    },
    {
      title: 'Time-gain compensation', dur: 15, scale: '10 cm',
      enter() { S.roomReset(); M.reset(); },
      cam: [[0, W.monPos, W.monLook, 36]],
      frame(t) {
        M.keep(api);
        const ramp = Math.round(span(t, 6.5, 9.5) * 25) / 25;
        const g = ramp >= 1 ? seat.g : greys(fr, { gain: SEAT.gain, range: SEAT.range, ramp });
        paintMon(g, 'tgc' + ramp, (c) => tgcCurve(c, ramp));
        if (t < 6.5) api.mark(monBox(20, fr.nl - 20, 9, 15.5), 'orange', t);
        else api.mark(R.screenBox(430, 16, 90, 308), 'cyan', t);
      },
      caption: [
        { from: 0.5, to: 6.5, text: 'Echoes from deep have crossed more tissue, twice, and come back far weaker: uncorrected, the image fades into darkness with depth.' },
        { from: 6.5, to: 15, text: '<b>Time-gain compensation</b> (TGC) amplifies each echo more the later it arrives, by the 0.5 dB/cm/MHz the machine assumes: an even image. The sliders let the operator shape it by depth.' },
      ],
    },
    {
      title: 'Gain and dynamic range', dur: 15, scale: '10 cm',
      enter() { S.roomReset(); M.reset(); },
      cam: [[0, W.monPos, W.monLook, 36]],
      frame(t) {
        M.keep(api);
        let gain = 0, range = 55;
        if (t < 7) gain = Math.round(Math.sin(span(t, 0.5, 6.5, api.ease.linear) * Math.PI * 2) * 14);
        else range = Math.round(t < 11 ? lerp(55, 30, span(t, 7.5, 10)) : lerp(30, 80, span(t, 11, 14)));
        const g = gain === 0 && range === 55 ? seat.g : greys(fr, { gain, range });
        paintMon(g, 'gd' + gain + ':' + range, (c) => {
          c.fillStyle = '#e0e6ea'; c.font = '16px monospace';
          c.fillText((gain >= 0 ? '+' : '') + gain + ' dB', 14, 300);
          c.fillStyle = '#7fd6e0'; c.fillText(range + ' dB', 14, 322);
        });
        if (t < 7) api.mark(monBox(20, fr.nl - 20, 2, 15), 'yellow', t);
        else api.mark(monBox(20, fr.nl - 20, 2, 15), 'cyan', t);
      },
      caption: [
        { from: 0.5, to: 7, text: '<b>Gain</b> amplifies every echo alike: the whole image brighter or darker, the noise with it.' },
        { from: 7, to: 15, text: '<b>Dynamic range</b>: how many decibels of echo strength are spread over the greys. Narrow, a stark, contrasty picture; wide, a softer one that keeps the faint differences between tissues.' },
      ],
    },
  ];
  void poly; void lerp;
  return { title: 'Building the image', steps };
}
