/* CT FILM, chapter 1: the scanner. The room and the gantry (the app's own model); under the covers
   the rotating frame and what it carries: the tube (the X-ray film's insert, turned to lie along
   the patient), the generator, the cooling, the slip ring and brushes with the data link; the
   bowtie filter and the collimator jaws; the detector arc, one element in section (septa,
   scintillator, photodiode), and the data acquisition system reading it view by view. */
import * as THREE from 'three';
import { electron } from '../../kit/micro.js';
import { setOpacity } from '../../kit/stage.js';
import { HALF, ZP } from './rig.js';
import { hud, box, spinAngle, fanStream } from './kit.js';

export function scanner(api, S) {
  const { px, sfx, span, lerp, rng } = api;
  const T = S.T;
  const V = new THREE.Vector3();
  // a point in the rotating frame's own axes -> the 8-bit layer
  const rp = (x, y, z) => api.toPx(S.rot.localToWorld(V.set(x, y, z)));
  const statPlate = S.stat.children[0];
  const base = (o = {}) => {
    S.view({ inside: true, patient: false, injector: false, ...o });
    setOpacity(statPlate, 1);
    setOpacity(S.rig.couch, 1); setOpacity(S.rig.couchBase, 1);
    if (o.couch === false) { S.rig.couch.visible = S.rig.couchBase.visible = false; }
    S.setCouch(70, 8); S.setAngle(0); S.setLasers(0);
    T.g.visible = false; setOpacity(S.housing, 1); S.collBox.visible = true;
    S.setBeam(4, false);
  };

  const fanPhotons = fanStream(api, S);
  // dots running along a curve in the frame's axes (current to the tube, oil to the radiator)
  function flow(curve, t, { n = 10, speed = 0.35, c = 'orange', rev = false } = {}) {
    for (let i = 0; i < n; i++) {
      let f = ((t * speed + i / n) % 1); if (rev) f = 1 - f;
      const p = curve.getPoint(f);
      const [x, y, ok] = rp(p.x, p.y, p.z);
      if (ok) { px.rect(x - 1, y - 1, 2, 2, c, 0.95); px.px(x, y, 'white'); }
    }
  }

  // ---------------------------------------------------------------- one element, in section (8-bit)
  /* Nine elements across: septa above (tungsten plates aimed at the focal spot, which is far
     above: they stand nearly upright), the scintillator blocks with white reflector between,
     the photodiodes under them, each element's current as a bar below. Photons come down from
     the top, as they do in the gantry: primaries straight; scattered ones slanting. */
  function elementScene(t, P = 13) {
    px.fillAll('ink');
    const W = px.W, H = px.H, n = 9, ew = Math.floor(Math.min(28, (W - 30) / n)), x0 = Math.round((W - ew * n) / 2);
    const sTop = 34, sBot = 86, scTop = 88, scBot = 128, pdTop = 130, pdBot = 140, barTop = 150, barH = 34;
    const focusT = t % P, cur = new Float32Array(n);
    // the septa
    for (let k = 0; k <= n; k++) px.rect(x0 + k * ew - 1, sTop, 2, sBot - sTop, 'lead');
    for (let k = 0; k < n; k++) {
      const x = x0 + k * ew;
      px.rect(x + 1, scTop, ew - 2, scBot - scTop, 'teal', 0.5);
      px.rect(x, scTop, 1, scBot - scTop, 'white', 0.5);
      px.rect(x + 2, pdTop, ew - 4, pdBot - pdTop, 'dkblue');
      px.rect(x + 3, pdTop + 2, ew - 6, pdBot - pdTop - 4, 'blue', 0.6);
    }
    px.rect(x0, pdBot + 2, ew * n, 3, 'slate');
    // the events: recent ones only (a stream that never runs dry), and two slowed and pointed at
    const rate = 9, life = 1.6;
    const ev = [];
    for (let k = Math.max(0, Math.ceil((t - life) * rate)); k <= Math.floor(t * rate); k++) {
      const r = rng(4400 + k);
      ev.push({ k, age: t - k / rate, r, kind: r() < 0.82 ? 'primary' : 'scatter', focus: false });
    }
    const fA = 1.2, fB = 6.6, slow = 3;
    if (focusT > fA && focusT < 6.4) ev.push({ k: -1, age: (focusT - fA) / slow, r: rng(77), kind: 'primary', focus: true, el: 4 });
    if (focusT > fB) ev.push({ k: -2, age: (focusT - fB) / slow, r: rng(78), kind: 'scatter', focus: true, el: 5 });
    const anyFocus = ev.some((e) => e.focus && e.age < 2.4);
    for (const e of ev) {
      const { r, age, focus } = e;
      const a = focus ? 1 : anyFocus ? 0.35 : 0.9;
      const v = 150;
      if (e.kind === 'primary') {
        const k = focus ? e.el : Math.floor(r() * n), x = x0 + k * ew + 3 + r() * (ew - 6), depth = scTop + 4 + (r() ** 1.6) * (scBot - scTop - 8);
        const tIn = (depth + 10) / v;
        if (age < tIn) { px.photon(x, -10 + age * v, 0, 1, focus ? 8 : 5, focus ? 'yellow' : 'violet', a, t * 30 + e.k); if (focus) api.mark([x - 6, -10 + age * v - 6, 12, 12], 'yellow', t, { live: true }); continue; }
        const q = age - tIn;
        if (q < 0.25) px.glow(x, depth, focus ? 6 : 4, 'white', a, e.k + 9);
        // the light: visible photons bouncing off the element's reflective walls, down to the diode
        const wL = x0 + k * ew + 1, wR = x0 + k * ew + ew - 2, sp = wR - wL;
        for (let j = 0; j < 18; j++) {
          const rr = rng(e.k * 50 + j + 999), ang = (rr() - 0.5) * 2.6, d = q * (50 + rr() * 40);
          let lx = x - wL + Math.sin(ang) * d;
          lx = ((lx % (2 * sp)) + 2 * sp) % (2 * sp); if (lx > sp) lx = 2 * sp - lx;
          let ly = depth + Math.cos(ang) * d;
          if (ly < scTop) ly = 2 * scTop - ly;                       // reflected at the top too
          if (ly < pdTop && q < 0.9) px.px(wL + lx, ly, 'yellow', a);
        }
        if (q > 0.2 && q < 1.0) { electron(px, x, pdTop + 5 + (q - 0.2) * 14, a * (1 - (q - 0.2) / 0.8), 'cyan'); cur[k] += 1 - (q - 0.2) / 0.8; }
        if (focus && q < 1.6) { api.mark([x0 + k * ew - 2, scTop - 2, ew + 4, pdBot - scTop + 4], 'yellow', t); }
      } else {
        // scattered in the patient: it comes in slanting and meets a septum
        const k = focus ? e.el : 1 + Math.floor(r() * (n - 1)), xs = x0 + k * ew;
        const side = focus ? -1 : (r() < 0.5 ? -1 : 1), slope = 0.55 + r() * 0.5, yHit = sTop + 8 + r() * (sBot - sTop - 16);
        const x1 = xs, y1 = yHit, L = (y1 + 10) * Math.hypot(1, slope), tHit = L / v;
        if (age < tHit) {
          const f = age / tHit, sx = x1 + side * (y1 + 10) * slope * (1 - f), sy = -10 + (y1 + 10) * f;
          px.photon(sx, sy, -side * slope, 1, focus ? 8 : 5, focus ? 'orange' : 'lav', a, t * 30 + e.k);
          if (focus) api.mark([sx - 6, sy - 6, 12, 12], 'orange', t, { live: true });
          continue;
        }
        const q = age - tHit;
        if (q < 0.35) px.rect(x1 - 2, y1 - 2, 4, 4, 'grey', a * (1 - q / 0.35));
        if (focus && q < 1.5) api.mark([x1 - 8, y1 - 8, 16, 16], 'orange', t);
      }
    }
    // each element's current
    for (let k = 0; k < n; k++) {
      const x = x0 + k * ew, h = Math.min(barH - 2, cur[k] * 9 + 2);
      px.frame(x + 3, barTop, ew - 6, barH, 'dkgrey');
      px.rect(x + 4, barTop + barH - 1 - h, ew - 8, h, 'cyan');
    }
    api.keepOut([x0, barTop, ew * n, barH]);
    api.keepOut([x0 - 2, sTop, ew * n + 4, pdBot - sTop]);
    return { x0, ew, n };
  }

  // ---------------------------------------------------------------- the DAS (8-bit)
  /* A view at a time: each element's reading I (the real line integrals of the abdomen slice, as
     the frame turns), the reference detectors' I0 at both ends, and the projection -ln(I/I0). */
  function dasScene(t) {
    px.fillAll('ink');
    const W = px.W, Fs = S.R.fan, NC = Fs.NC;
    const VPR = 984, vps = 82;                          // views a rotation; shown at 82 a second
    const view = Math.floor(t * vps) % VPR, row = Math.floor(view / VPR * Fs.NV);
    const n = 48, x0 = 22, bw = Math.floor((W - 44 - 16) / n), y0 = 24, bh = 52;
    const sx = x0 + 8;
    // reference elements, outside the fan's edge: the open beam, always full
    for (const xx of [x0, sx + n * bw + 2]) { px.rect(xx, y0, 5, bh, 'cyan', 0.9); }
    let hi = 0, hiP = 0;
    const pAt = (i) => Fs.p[row * NC + Math.floor((i + 0.5) / n * NC)];
    for (let i = 0; i < n; i++) {
      const p = pAt(i), I = Math.exp(-p), h = Math.max(1, Math.round(I * bh));
      px.rect(sx + i * bw, y0 + bh - h, bw - 1, h, i === 26 ? 'yellow' : 'grey');
      if (i === 26) { hi = I; hiP = p; }
    }
    px.frame(x0 - 2, y0 - 2, n * bw + 22, bh + 4, 'dkgrey');
    api.keepOut([x0 - 2, y0 - 2, n * bw + 22, bh + 4]);
    // the projection
    const py0 = 120, ph = 56;
    px.rect(sx - 2, py0, n * bw + 4, ph, 'navy', 0.5);
    let lx = null, ly = null;
    let pmax = 0; for (let c = 0; c < NC; c++) pmax = Math.max(pmax, Fs.p[row * NC + c]);
    for (let i = 0; i < n * bw; i++) {
      const p = Fs.p[row * NC + Math.floor(i / (n * bw) * NC)], y = py0 + ph - 2 - (p / 9) * (ph - 4);
      if (lx != null) px.line(lx, ly, sx + i, y, 'yellow');
      lx = sx + i; ly = y;
    }
    px.rect(sx + 26 * bw + Math.floor(bw / 2), py0, 1, ph, 'yellow', 0.35);
    api.keepOut([sx - 2, py0, n * bw + 4, ph]);
    // the arrow down from the reading to its log
    px.line(sx + 26 * bw + 1, y0 + bh + 4, sx + 26 * bw + 1, py0 - 4, 'mid', 0.8, 2);
    // the numbers for the highlighted element
    const I0 = 65000, Ic = Math.round(I0 * hi);
    hud(api, [['VIEW', String(view), 'white'], ['I', String(Ic), 'grey'], ['I0', String(I0), 'cyan'], ['-ln', hiP.toFixed(2), 'yellow']], { w: 58, y: 84, x: W - 64 });
    return { sx, bw, n, y0, bh, py0, ph };
  }

  // ---------------------------------------------------------------- the steps
  const steps = [
    {
      title: 'The CT scanner', dur: 9, fadeIn: 0.6, scale: '1 m',
      enter() { base({ inside: false }); },
      cam: [[0, [420, 170, 470], [0, -10, 20], 40], [9, [290, 90, 340], [0, -6, 10], 40]],
      frame(t) {
        S.sync();
        if (t > 3.4 && t < 6.4) api.mark(S.rig.shell, 'yellow', t);
        if (t > 6.4) api.mark(S.rig.couch, 'cyan', t);
      },
      caption: [
        { from: 3.4, to: 6.4, text: 'The <b>gantry</b>: a ring round a 70 cm bore. Inside it the x-ray tube and the detectors turn round the patient.' },
        { from: 6.4, to: 9, text: 'The <b>couch</b> carries the patient through it.' },
      ],
    },
    {
      title: 'Under the covers', dur: 11, scale: '10 cm',
      enter() { base(); },
      cam: [[0, [200, 120, 360], [0, 6, 0], 40], [11, [90, 95, 320], [0, 8, -10], 40]],
      frame(t) {
        const k = span(t, 0.4, 3.4);
        setOpacity(S.rig.shell, 1 - k); setOpacity(S.rig.couch, 1 - k); setOpacity(S.rig.couchBase, 1 - k);
        S.setAngle(spinAngle(t, 12, 3.5, 2));
        S.fan.rotation.y = t * 9;
        S.sync();
        if (t > 4.5) api.mark(S.disc, 'yellow', t);
      },
      caption: [
        { from: 1, to: 4.5, text: 'Under the covers: the parts that turn, and the stationary frame that holds them.' },
        { from: 4.5, to: 11, text: 'One <b>rotating frame</b> carries everything that turns: the tube, the generator, the detectors and their electronics. It runs on a large bearing in the stationary frame.' },
      ],
    },
    {
      title: 'Tube and detector arc', dur: 12, scale: '10 cm',
      enter() { base({ shell: 0, couch: false }); },
      cam: [[0, [90, 95, 320], [0, 8, -10], 40], [12, [55, 70, 255], [0, 4, -10], 40]],
      frame(t) {
        S.fan.rotation.y = t * 9;
        const on = t > 7.2;
        S.setBeam(4, on);
        S.sync();
        if (on) fanPhotons(t - 7.2, { rate: 90 });
        if (t > 1 && t < 4.2) api.mark(S.housing, 'yellow', t);
        if (t > 4.2 && t < 7.2) api.mark(S.det, 'cyan', t);
        if (t > 7.2) api.mark(S.beam, 'violet', t);
      },
      cues: [[7.2, () => sfx.zap()]],
      caption: [
        { from: 1, to: 4.2, text: 'On one side the <b>x-ray tube</b>...' },
        { from: 4.2, to: 7.2, text: '...across the bore the <b>detector arc</b>, curved round the focal spot 1 m away.' },
        { from: 7.2, to: 12, text: 'Between them a <b>fan beam</b>: 50 cm wide across the bore, only a few centimetres thick along the patient.' },
      ],
    },
    {
      title: 'The generator', dur: 11, scale: '10 cm',
      enter() { base({ shell: 0, couch: false }); },
      cam: [[0, [-40, 80, 230], [-25, 24, -10], 38], [11, [-100, 60, 190], [-28, 22, -10], 38]],
      frame(t) {
        S.fan.rotation.y = t * 9;
        const on = t > 5.5;
        S.setBeam(4, on);
        S.sync();
        const k = span(t, 5.5, 6.5);
        if (on) { for (const c of S.cables) flow(c, t, { n: 12, speed: 0.5, c: 'orange' }); fanPhotons(t - 5.5, { rate: 60 }); }
        sfx.hold('gen', 90 + 40 * k, on ? 0.035 : 0, 'sawtooth');
        hud(api, [['kV', String(Math.round(120 * k)), 'yellow'], ['mA', String(Math.round(400 * k)), 'yellow'], ['kW', String(Math.round(48 * k)), 'orange']]);
        if (t > 1) api.mark(S.gen, 'orange', t);
      },
      cues: [[5.5, () => sfx.power()]],
      caption: [
        { from: 1, to: 5.5, text: 'The <b>high-voltage generator</b> rides on the frame with the tube: two tanks, positive and negative, cabled to the tube’s ends.' },
        { from: 5.5, to: 11, text: 'It holds <b>high kV and high mA</b> for many seconds at a time: here 120 kV at 400 mA, 48 kW.' },
      ],
    },
    {
      title: 'The tube at work', dur: 13, scale: '10 cm',
      enter() {
        base({ shell: 0, couch: false });
        T.g.visible = true; setOpacity(S.housing, 0.16); S.collBox.visible = false;
        T.filMat.emissiveIntensity = 1.6; T.filMat.emissive.setRGB(1, 0.65, 0.15);
      },
      cam: [[0, [80, 84, 34], [0, 63, -9], 34], [13, [58, 74, 8], [0, 63, -9], 30]],
      frame(t) {
        S.fan.rotation.y = t * 9;
        T.spin.rotation.x = t * 30;                        // (shown slowed: ~9,000 rpm would strobe)
        T.spotMat.opacity = 0.85 + 0.15 * Math.sin(t * 30);
        const h = span(t, 0.5, 12, api.ease.linear);
        T.heatMat.emissiveIntensity = 0.4 + h * 1.4; T.heatMat.opacity = 0.3 + h * 0.6;
        S.setBeam(4, true);
        S.sync();
        for (const c of S.cables) flow(c, t, { n: 8, speed: 0.5, c: 'orange' });
        if (t > 6.5) for (let i = 0; i < 2; i++) flow(S.hoses?.[i] || S.cables[i], t, { n: 6, speed: 0.25, c: 'lime' });
        hud(api, [['kV', '120', 'yellow'], ['mA', '500', 'yellow'], ['kW', '60', 'orange'], ['kJ', String(Math.round(60 * Math.min(t, 12))), 'red']]);
        if (t > 1 && t < 6.5) api.mark(T.anode, 'orange', t);
        if (t > 6.5) api.mark(S.cool, 'lime', t);
        sfx.hold('rotor', 700, 0.03, 'square');
      },
      caption: [
        { from: 1, to: 6.5, text: 'In the housing, a tube like radiography’s built for heat: a big anode spinning fast. 120 kV × 500 mA puts <b>60 kW</b> into the focal spot.' },
        { from: 6.5, to: 13, text: 'Almost all of it becomes <b>heat</b>, hundreds of kilojoules a scan: the anode stores it, and oil carries it to a radiator and fan on the frame.' },
      ],
    },
    {
      title: 'The slip ring', dur: 12, scale: '10 cm',
      enter() { base({ shell: 0, couch: false }); setOpacity(statPlate, 0.2); },
      cam: [[0, [160, -30, -225], [22, -22, -32], 38], [12, [115, -70, -180], [26, -30, -33], 34]],
      frame(t) {
        S.setAngle(spinAngle(t, 2.4, 0, 1.5));
        S.fan.rotation.y = t * 12;
        S.sync();
        // sparks of current at the brushes, the data bits round the link's ring toward the pickup
        for (const b of S.brushTips) {
          b.getWorldPosition(V);
          const [x, y, f] = api.toPx(V);
          if (f && ((t * 23 + x) % 1) < 0.5) px.glow(x, y, 2, (Math.floor(t * 17 + y) % 2) ? 'yellow' : 'white', 0.9, Math.floor(t * 30));
        }
        if (t > 6.2) {
          const pick = 145 * Math.PI / 180;
          for (let i = 0; i < 26; i++) {
            const f = (t * 0.9 + i / 26) % 1, side = i % 2 ? 1 : -1, a = pick + side * (1 - f) * Math.PI;
            const p = new THREE.Vector3(-55.6 * Math.sin(a), 55.6 * Math.cos(a), -22.4 + ZP);
            const [x, y, ok] = api.toPx(S.inner.localToWorld(p));
            if (ok) px.rect(x, y, 2, 2, 'cyan', 0.9);
          }
        }
        if (t > 1 && t < 6.2) api.mark(S.brushes, 'yellow', t);
        if (t > 6.2) api.mark(S.link, 'cyan', t);
        sfx.hold('rotor', 160, 0.025, 'triangle');
      },
      caption: [
        { from: 1, to: 6.2, text: 'No cable could follow a frame that never stops turning. Power comes in through carbon <b>brushes</b> pressed on copper <b>slip rings</b>.' },
        { from: 6.2, to: 12, text: 'The measurements leave the other way, across a narrow gap by a <b>contactless data link</b>: several gigabits a second.' },
      ],
    },
    {
      title: 'The bowtie filter', dur: 12, scale: '1 cm',
      enter() { base({ shell: 0, couch: false }); setOpacity(S.housing, 0.5); },
      cam: [[0, [12, 38, 44], [0, 49, -10], 32], [12, [6, 42, 30], [0, 49, -10], 30]],
      frame(t) {
        S.setBeam(4, true);
        S.sync();
        // photons dimmed toward the fan's edges by the thicker filter
        fanPhotons(t, { rate: 160, v: 60, dim: (ph) => (Math.abs(ph) / HALF > 0.6 ? 'slate' : Math.abs(ph) / HALF > 0.3 ? 'lav' : 'violet') });
        if (t > 1) api.mark(S.bowtie, 'yellow', t);
        // the beam's intensity across the fan after the filter, against the body's thickness
        const bx = 6, bw = 112, bh = 56, by = px.H - bh - 6;
        box(api, bx, by, bw, bh);
        const k = span(t, 5.5, 7.5);
        for (let i = 0; i < bw - 8; i++) {
          const u = (i / (bw - 9)) * 2 - 1;                  // -1..1 across the fan
          const thick = 0.3 + 2.1 * u * u;                   // the bowtie (cm)
          const I = Math.exp(-0.9 * thick);
          const h = Math.round(I * (bh - 12));
          px.rect(bx + 4 + i, by + bh - 6 - h, 1, h, 'violet', 0.85);
          // the body: an ellipse 35 cm by 25, its chord across the fan (dashed)
          const body = Math.sqrt(Math.max(0, 1 - (u * 1.25) ** 2));
          if (k > 0 && i % 3 === 0) px.px(bx + 4 + i, by + bh - 6 - Math.round(body * (bh - 12)), 'peach', k);
        }
        px.rect(bx + 4, by + bh - 5, bw - 8, 1, 'mid');
      },
      caption: [
        { from: 1, to: 5.5, text: 'Just under the tube, the <b>bowtie filter</b>: thin in the middle, thick at the edges.' },
        { from: 5.5, to: 12, text: 'It shapes the beam to the body: strong through the thick middle, weak where the body is thin. Less dose to the skin at the sides, a more even signal, a harder beam.' },
      ],
    },
    {
      title: 'Collimation and rows', dur: 12, scale: '10 cm',
      enter() { base({ shell: 0, couch: false }); },
      cam: [[0, [160, 80, 70], [0, 0, -10], 38], [12, [140, 62, 42], [0, -2, -10], 38]],
      frame(t) {
        const w = t < 5.5 ? 4 : lerp(4, 1, span(t, 5.5, 8));
        S.setBeam(w, true);
        S.sync();
        fanPhotons(t, { rate: 90, wIso: w, v: 120 });
        const rows = Math.round(64 * w / 4);
        hud(api, [['rows', String(rows), 'yellow'], ['mm', rows + 'x0.625', 'white'], ['mm', String(Math.round(w * 10)), 'cyan']], { w: 64 });
        if (t > 1 && t < 5.5) api.mark(S.coll, 'yellow', t);
        if (t > 6.5) api.mark(S.det, 'cyan', t);
      },
      cues: [[5.6, () => sfx.click()], [7.9, () => sfx.click()]],
      caption: [
        { from: 1, to: 5.5, text: 'Tungsten <b>collimator</b> jaws under the tube set the beam’s width along the patient: 40 mm at the centre, just covering 64 detector rows of 0.625 mm.' },
        { from: 5.5, to: 12, text: 'Close them and fewer rows are lit: 16 × 0.625 = 10 mm. One row is the thinnest <b>slice</b>; thicker ones are made by adding rows together.' },
      ],
    },
    {
      title: 'The detector arc', dur: 11, scale: '10 cm',
      enter() { base({ shell: 0, couch: false }); },
      cam: [[0, [70, 20, 70], [0, -34, -10], 34], [8.4, [34, -6, 36], [0, -37, -10], 30], [11, [-1.4, -31.5, -7.5], [-1.4, -37, -10], 30]],
      cues: [[8.6, () => sfx.whoosh()]],
      frame(t) {
        S.setBeam(4, true);
        S.sync();
        api.mosaic(span(t, 9.2, 11));
        fanPhotons(t, { rate: 70, v: 140 });
        if (t > 1 && t < 5.5) api.mark(S.det, 'yellow', t);
        if (t > 5.5 && t < 9.2) api.mark(S.modules[12], 'cyan', t);
      },
      caption: [
        { from: 1, to: 5.5, text: 'The <b>detector</b>: modules side by side on an arc centred on the focal spot, about 900 elements across the fan.' },
        { from: 5.5, to: 9.4, text: 'Each <b>module</b> is a block of elements: here 64 rows deep along the patient, each row 0.625 mm wide at the centre of the bore.' },
      ],
    },
    {
      title: 'One detector element', dur: 13, view: 'pixel', fadeIn: 0.3, scale: '1 mm',
      cues: [[1.4, () => sfx.blip(990)], [6.9, () => sfx.thud()]],
      frame(t) { elementScene(t); },
      caption: [
        { from: 0.8, to: 6.4, text: 'In section: each element is a ceramic <b>scintillator</b> that turns each x-ray into a flash of light, over a <b>photodiode</b> that turns the light into current.' },
        { from: 6.4, to: 13, text: 'Above them, thin tungsten <b>septa</b> aimed at the focal spot: photons scattered in the patient come in slanting and are stopped.' },
      ],
    },
    {
      title: 'Data acquisition', dur: 12, view: 'pixel', fadeOut: 0.5, scale: '1 cm',
      cues: Array.from({ length: 24 }, (_, k) => [0.25 + k * 0.5, () => sfx.tick()]),
      frame(t) {
        const r = dasScene(t);
        if (t > 0.8 && t < 6) api.mark([r.sx - 10, r.y0 - 3, r.n * r.bw + 24, r.bh + 6], 'yellow', t);
        if (t > 6) api.mark([r.sx - 2, r.py0, r.n * r.bw + 4, r.ph], 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 6, text: 'The <b>data acquisition system</b> reads every element at once, about a thousand times a rotation: each reading of the whole arc is one <b>view</b>.' },
        { from: 6, to: 12, text: 'Each signal is digitised, divided by a <b>reference detector</b>’s reading of the open beam (I₀), and its log taken: −ln(I/I₀), the attenuation along that ray.' },
      ],
    },
  ];
  return { title: 'The scanner', steps };
}
