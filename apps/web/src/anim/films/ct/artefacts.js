/* CT FILM, chapter: artefacts. Each one a scan of the model simulated with its cause and
   reconstructed (artsim.js, computed in a worker: S.art(name)), shown as it comes out beside the
   same scan without it, with its cause drawn where that helps. Axial images as the film shows
   them all: seen from the feet, the patient's right on the screen's left, anterior up.
     beam hardening (cupping), dense objects (dark streaks), photon starvation, metal, partial
     volume, motion, rings, too few views (aliasing), truncation, stair-step, windmill, cone beam */
import { BodyMaterials } from '../../../core/materials.js';
import { spectrumPlot, keVColor } from '../../kit/micro.js';
import { HU0, drawGrey } from './slice.js';
import { SPEC, meanKeV, spectrumAfter, huOfIds } from './simct.js';
import { N, WINDMILL } from './artsim.js';
import { box } from './kit.js';
import { drawHU, row, fit, under, plot, at, lab } from './draw.js';
import { sideGeo, sideView, guard, ROWS, ROW } from './rows.js';
import { helixPlot, straddle } from './zrecon.js';

export function artefacts(api, S) {
  const { px, sfx, span, rng, clamp01 } = api;
  const I = S.img, A = (k) => S.art(k);
  const steps = [];
  // three slots across (two images and a panel, or three images), their scale and lefts
  const slots = (n = 3, w = N, h = N, o = {}) => { const s = fit(px, n, w, h, o); return { s, xs: row(px, n, w * s, o.gap ?? 8), w: w * s, h: h * s }; };
  const Y0 = 20;
  // the body slices fill the middle 104 rows of their square grid: drawn cropped to them
  const BODY = [0, 12, N, 104];
  const img = (hu, x, s, L, W, o = {}) => drawHU(api, hu, N, N, x, Y0, s, L, W, { crop: BODY, ...o });
  // a grid point (c, r) on an image drawn cropped to BODY
  const atB = (b, c, r) => [b[0] + (c - BODY[0]) * b[2] / BODY[2], b[1] + (r - BODY[1]) * b[3] / BODY[3]];

  // ---------------------------------------------------------------- beam hardening: the cause
  /* The head's middle row: the water and bone path (cm) up to each pixel, as the film's basis
     decomposition has it; photons along it, each of an energy from the spectrum, stopped where
     their own energy's attenuation says. */
  const head = I.ax_head, hr = Math.round(head.h / 2), PXC = 0.15;
  const cumW = new Float32Array(head.w + 1), cumB = new Float32Array(head.w + 1);
  for (let x = 0; x < head.w; x++) {
    const id = head.ids[hr * head.w + x], hu = HU0[id], air = id === 0 || id === 47;
    const lw = air ? 0 : hu <= 120 ? 1 + hu / 1000 : 1 - hu / 1200, lb = air || hu <= 120 ? 0 : hu / 1200;
    cumW[x + 1] = cumW[x] + lw * PXC; cumB[x + 1] = cumB[x] + lb * PXC;
  }
  const keV0 = Math.round(meanKeV(0)), keV1 = Math.round(meanKeV(cumW[head.w], cumB[head.w]));
  const sampleE = (r) => { const u = r(); let c = 0; const tot = SPEC.w.reduce((s, w, i) => s + w / SPEC.E[i], 0); for (let i = 0; i < SPEC.E.length; i++) { c += SPEC.w[i] / SPEC.E[i] / tot; if (u <= c) return SPEC.E[i]; } return 120; };
  const phCache = new Map();
  const photon = (k) => {
    let p = phCache.get(k);
    if (!p) {
      const r = rng(7700 + k), E = sampleE(r), u = r(), mw = BodyMaterials.muWater(E), mb = BodyMaterials.muById(18, E);
      let stop = head.w;
      for (let x = 0; x < head.w; x++) if (Math.exp(-(cumW[x + 1] * mw + cumB[x + 1] * mb)) < u) { stop = x; break; }
      p = { E, stop, dy: (r() - 0.5) * 4 };
      if (phCache.size > 4000) phCache.clear();
      phCache.set(k, p);
    }
    return p;
  };
  const incident = spectrumAfter(0, 0), headHU = huOfIds(head);
  let iMax = 0; for (let E = 20; E <= 120; E += 2) iMax = Math.max(iMax, incident(E));
  steps.push({
    title: 'Beam hardening', dur: 16, view: 'pixel', fadeIn: 0.3, scale: '10 cm',
    cues: [[6, () => sfx.whoosh()], [11, () => sfx.click()]],
    frame(t) {
      px.fillAll('ink');
      const L = slots(3);
      const H = I.ax_head, sh = L.s * N / Math.max(H.w, H.h);            // the head image's pixels on screen
      const bx = L.xs[2], panel = [bx, Y0, L.w, L.h];
      if (t < 6) {
        // the head (its tissue in a brain window), photons along its middle row, the spectrum
        const hb = drawHU(api, headHU, H.w, H.h, L.xs[0] + (L.w - H.w * sh) / 2, Y0 + (L.h - H.h * sh) / 2, sh, 40, 80);
        const yRow = hb[1] + (hr + 0.5) * sh, front = clamp01((t - 0.5) / 4.5);
        const xFront = hb[0] - 6 + front * (hb[2] + 12);
        const rate = 40, v = (hb[2] + 30) / 1.2;
        for (let k = Math.max(0, Math.ceil((t - 1.4) * rate)); k <= Math.floor(t * rate); k++) {
          const p = photon(k), age = t - k / rate, x = hb[0] - 12 + age * v, xi = (x - hb[0]) / sh;
          if (xi > p.stop) { if (xi - p.stop < 3) px.rect(hb[0] + p.stop * sh - 1, yRow + p.dy - 1, 2, 2, 'white', 0.7); continue; }
          px.photon(x, yRow + p.dy, 1, 0, 4, keVColor(p.E), 0.9, t * 25 + k);
        }
        const xi = Math.max(0, Math.min(H.w, Math.round((xFront - hb[0]) / sh)));
        // the spectrum's shape there (each scaled to its own peak: what changes is where it peaks)
        const after = spectrumAfter(cumW[xi], cumB[xi]);
        let am = 1e-9; for (let E = 20; E <= 120; E += 2) am = Math.max(am, after(E));
        box(api, panel[0], panel[1], panel[2], panel[3]);
        spectrumPlot(px, panel[0] + 2, panel[1] + 2, panel[2] - 4, panel[3] - 18, 120, (E) => 0.92 * after(E) / am, { hard: (E) => 0.92 * incident(E) / iMax, axisMax: 125 });
        px.text(Math.round(meanKeV(cumW[xi], cumB[xi])) + ' keV', panel[0] + panel[2] / 2, panel[1] + panel[3] - 12, 'yellow', 1, 1, 'center');
        if (t > 0.8) api.mark(panel, 'yellow', t);
        return;
      }
      const r = A('cupping');
      const a = drawHU(api, r.raw, N, N, L.xs[0], Y0, L.s, 40, 80), b = drawHU(api, r.cor, N, N, L.xs[1], Y0, L.s, 40, 80, { a: clamp01((t - 10.6) / 0.6) });
      // the middle row's values across the brain: uncorrected (orange) and corrected (cyan)
      box(api, panel[0], panel[1], panel[2], panel[3]);
      const rr = N / 2, prof = (img) => { const v = []; for (let c = 8; c < N - 8; c++) { let s = 0; for (let k = -2; k <= 2; k++) s += img[(rr + k) * N + c]; v.push(s / 5); } return v; };
      const lo = -10, hi = 70;
      for (const hu of [0, 40]) { const yy = panel[1] + panel[3] - 4 - (hu - lo) / (hi - lo) * (panel[3] - 8); px.rect(panel[0] + 2, yy, panel[2] - 4, 1, 'dkgrey'); px.text(String(hu), panel[0] + panel[2] - 3, yy - 6, 'mid', 1, 1, 'right'); }
      plot(px, prof(r.raw), panel[0] + 3, panel[1] + 4, panel[2] - 6, panel[3] - 8, { c: 'orange', lo, hi });
      if (t > 11) plot(px, prof(r.cor), panel[0] + 3, panel[1] + 4, panel[2] - 6, panel[3] - 8, { c: 'cyan', lo, hi });
      px.text('HU', panel[0] + 3, panel[1] + 3, 'mid');
      // the row the profile runs along
      px.rect(a[0], a[1] + (rr + 0.5) * L.s, a[2], 1, 'orange', 0.35);
      api.mark(lab(t < 11 ? a : b), t < 11 ? 'orange' : 'cyan', t);
    },
    caption: [
      { from: 0.8, to: 6, text: `The beam is a spectrum, and tissue takes out its <b>low energies</b> first: across this head its mean energy rises from ${keV0} to ${keV1} keV. It gets <b>harder</b>.` },
      { from: 6, to: 11, text: 'A harder beam is attenuated less per cm, so the rays through the most tissue read too low: the middle comes out darker, <b>cupping</b> (left; its profile, orange).' },
      { from: 11, to: 16, text: 'The scanner’s <b>water correction</b> maps each reading back to the water path that would give it: the brain even again (right).' },
    ],
  });

  // ---------------------------------------------------------------- dense objects
  const ph = I.ax_metal;
  const rodsAt = (() => {
    // the rods' centres (grid coordinates of the 24 cm square the phantom is simulated in)
    const seen = new Uint8Array(ph.w * ph.h), out = [];
    for (let i = 0; i < ph.ids.length; i++) {
      if (ph.ids[i] !== 27 || seen[i]) continue;
      let sx = 0, sy = 0, n = 0; const st = [i]; seen[i] = 1;
      while (st.length) { const j = st.pop(), x = j % ph.w, y = (j / ph.w) | 0; sx += x; sy += y; n++;
        for (const d of [1, -1, ph.w, -ph.w]) { const q = j + d; if (q >= 0 && q < ph.ids.length && !seen[q] && ph.ids[q] === 27) { seen[q] = 1; st.push(q); } } }
      out.push([(sx / n + 0.5 + 20) * N / 240, (sy / n + 0.5 + 20) * N / 240]);
    }
    return out.sort((a, b) => a[1] - b[1]);
  })();
  const roi = (img, c, r) => { let s = 0, n = 0; for (let j = -1; j <= 1; j++) for (let i = -2; i <= 2; i++) { s += img[Math.round(r + j) * N + Math.round(c + i)]; n++; } return Math.round(s / n); };
  steps.push({
    title: 'Dense objects', dur: 12, view: 'pixel', scale: '1 cm',
    frame(t) {
      px.fillAll('ink');
      const r = A('rods'), L = slots(2, N, N, { max: 1.1 });
      const a = drawHU(api, r.ideal, N, N, L.xs[0], Y0, L.s, 40, 400), b = drawHU(api, r.water, N, N, L.xs[1], Y0, L.s, 40, 400);
      if (rodsAt.length >= 3) {
        const [p, q] = [rodsAt[1], rodsAt[2]], mc = (p[0] + q[0]) / 2, mr = (p[1] + q[1]) / 2;
        if (t < 6) {
          // the rays that cross two rods: along each pair's line
          for (const [u, w] of [[rodsAt[0], rodsAt[1]], [rodsAt[0], rodsAt[2]], [p, q]]) {
            const [x0, y0] = at(b, N, u[0], u[1]), [x1, y1] = at(b, N, w[0], w[1]), dx = x1 - x0, dy = y1 - y0, k = 0.45;
            px.line(x0 - dx * k, y0 - dy * k, x1 + dx * k, y1 + dy * k, 'yellow', 0.55 + 0.3 * Math.sin(t * 5));
          }
        }
        for (const [bb, img, c] of [[a, r.ideal, 'cyan'], [b, r.water, 'orange']]) {
          const [x, y] = at(bb, N, mc, mr);
          px.circle(x, y, 3, c);
          under(px, bb, roi(img, mc, mr) + ' HU', c);
        }
        const [x, y] = at(b, N, mc, mr);
        api.mark(t < 6 ? lab(b) : [x - 20, y - 6, 40, 12], 'yellow', t);
      }
    },
    caption: [
      { from: 0.8, to: 6, text: 'A ray through two dense objects at once is hardened more than the water correction allows for, and reads too low...' },
      { from: 6, to: 12, text: '...so a <b>dark streak</b> joins them (right; titanium rods in the app’s test phantom). Left, a beam of one energy: none. In patients: between the petrous bones, or the femoral heads.' },
    ],
  });

  // ---------------------------------------------------------------- photon starvation
  steps.push({
    title: 'Photon starvation', dur: 14, view: 'pixel', scale: '10 cm',
    cues: [[9.5, () => sfx.click()]],
    frame(t) {
      px.fillAll('ink');
      const r = A('starvation'), L = slots(2, N, BODY[3], { max: 1.3 });
      const a = img(r.flat, L.xs[0], L.s, 40, 400);
      const b = t > 9.5 ? img(r.tcm, L.xs[1], L.s, 40, 400, { a: clamp01((t - 9.5) / 0.6) }) : null;
      const cy = a[1] + a[3] / 2, cx = a[0] + a[2] / 2;
      if (t < 5) {
        // the side ray and the front ray through the middle, the photons each lets through
        px.line(a[0] - 4, cy, a[0] + a[2] + 4, cy, 'yellow', 0.8); px.line(cx, a[1] - 4, cx, a[1] + a[3] + 4, 'cyan', 0.8);
        const tx = L.xs[1];
        px.text(String(r.I0), tx, Y0 + 10, 'white'); px.text(String(r.counts.lat), tx, Y0 + 24, 'yellow'); px.text(String(r.counts.ap), tx, Y0 + 38, 'cyan');
        api.keepOut([tx - 2, Y0 + 6, 40, 40]);
        api.mark([a[0] - 2, cy - 4, a[2] + 4, 8], 'yellow', t);
      } else if (t < 9.5) api.mark(lab(a), 'yellow', t);
      if (b) {
        under(px, a, r.counts.lat + ' / ' + r.counts.ap, 'yellow'); under(px, b, r.counts.latTcm + ' / ' + r.counts.apTcm, 'lime');
        api.mark(lab(b), 'lime', t);
      }
    },
    caption: [
      { from: 0.8, to: 5, text: 'Across the shoulders the path is longest: at a low dose only a handful of the photons sent in reach the detector from the side (yellow), hundreds from the front (blue).' },
      { from: 5, to: 9.5, text: 'Those few counts are mostly noise, and back-projection smears it along their rays: horizontal <b>streaks</b>.' },
      { from: 9.5, to: 14, text: 'More mA for the side views and less for the front (<b>angular modulation</b>, right) evens the counts out: fewer streaks for the same dose.' },
    ],
  });

  // ---------------------------------------------------------------- metal
  steps.push({
    title: 'Metal', dur: 13, view: 'pixel', scale: '10 cm',
    frame(t) {
      px.fillAll('ink');
      const r = A('metal'), L = slots(2, N, BODY[3], { max: 1.3 });
      const a = img(r.clean, L.xs[0], L.s, 40, 400), b = img(r.metal, L.xs[1], L.s, 40, 400);
      const [x, y] = atB(b, r.at[0], r.at[1]), R = r.r * L.s;
      if (t < 6) {
        // rays through the steel, in a few directions: almost nothing comes out of them
        for (let k = 0; k < 6; k++) { const ang = k * Math.PI / 6 + t * 0.3, dx = Math.cos(ang) * b[2] * 0.6, dy = Math.sin(ang) * b[2] * 0.6; px.line(x - dx, y - dy, x + dx, y + dy, 'yellow', 0.35); }
        api.mark([x - R - 3, y - R - 3, 2 * R + 6, 2 * R + 6], 'yellow', t);
      } else api.mark(lab(b), 'yellow', t);
    },
    caption: [
      { from: 0.8, to: 6, text: 'A steel hip replacement (right): almost no photons get through it, and those that do are hardened most.' },
      { from: 6, to: 13, text: 'Every ray through it is wrong: dark bands beside it, bright and dark <b>streaks</b> across the pelvis. Metal artefact reduction replaces those rays before reconstructing.' },
    ],
  });

  // ---------------------------------------------------------------- partial volume
  // a side view through the right lung's base: the slab's layers (head up), anterior on the left
  const SAGX = 58, sag = (() => {
    const n = S.slices.length, w = S.slices[0].h, out = { w, h: n, ids: new Uint8Array(w * n) };
    for (let k = 0; k < n; k++) for (let y = 0; y < w; y++) out.ids[k * w + y] = S.slices[k].ids[y * S.slices[k].w + SAGX];
    return out;
  })();
  const sagHU = huOfIds(sag);
  steps.push({
    title: 'Partial volume', dur: 13, view: 'pixel', scale: '10 cm',
    frame(t) {
      px.fillAll('ink');
      const r = A('partialVolume'), L = slots(3, N, BODY[3]);
      const a = img(r.thin, L.xs[0], L.s, -600, 1500), b = img(r.thick, L.xs[1], L.s, -600, 1500);
      // the side view, its layers 2 mm; the slices' extent on it
      // (its lower part, round the slices: the lung base and the dome under it)
      const SC = [20, 25, 110, 24], s2 = L.w / SC[2], sb = drawHU(api, sagHU, sag.w, sag.h, L.xs[2], Y0 + 6, s2, -600, 1500, { crop: SC });
      const zRow = (z) => sb[1] + (S.slabTop - z - SC[1] + 0.5) * s2;
      const half = r.T / 4;
      px.rect(sb[0], zRow(r.z0 + half) - 1, sb[2], 1, 'yellow'); px.rect(sb[0], zRow(r.z0 - half) + 1, sb[2], 1, 'yellow');
      px.rect(sb[0], zRow(r.z0 + half), sb[2], zRow(r.z0 - half) - zRow(r.z0 + half), 'yellow', 0.18);
      px.rect(sb[0], zRow(r.z0), sb[2], 1, 'cyan');
      under(px, a, '2 mm', 'cyan'); under(px, b, r.T + ' mm', 'yellow');
      // the line on the axials the side view is cut along
      for (const bb of [a, b]) { const x = bb[0] + (SAGX + 0.5) / S.slices[0].w * bb[2]; px.line(x, bb[1], x, bb[1] + bb[3], 'mid', 0.35, 2); }
      if (t < 6) api.mark([sb[0] - 2, zRow(r.z0 + half) - 3, sb[2] + 4, zRow(r.z0 - half) - zRow(r.z0 + half) + 6], 'yellow', t);
      else api.mark(lab(b), 'yellow', t);
    },
    caption: [
      { from: 0.8, to: 6, text: 'A 10 mm slice through the base of the lung (side view, right) also takes in the top of the liver’s dome just below it...' },
      { from: 6, to: 13, text: '...and averages it into the lung as a haze that is not there: <b>partial volume</b> (middle). The 2 mm slice at its centre shows clear lung (left).' },
    ],
  });

  // ---------------------------------------------------------------- motion
  steps.push({
    title: 'Motion', dur: 14, view: 'pixel', scale: '10 cm',
    cues: [[4.5, () => sfx.blip(520)], [9, () => sfx.blip(620)]],
    frame(t) {
      px.fillAll('ink');
      const r = A('motion');
      if (t >= 9) {
        // the heart close up: still (left), beating (right)
        const k = Math.round(r.Rh * 1.7), crop = [Math.round(r.heart[0] - k), Math.round(r.heart[1] - k), 2 * k, 2 * k];
        const Z = slots(2, crop[2], crop[3], { max: 3 });
        const a = drawHU(api, r.still, N, N, Z.xs[0], Y0, Z.s, 40, 400, { crop }), b = drawHU(api, r.cardiac, N, N, Z.xs[1], Y0, Z.s, 40, 400, { crop });
        under(px, a, '0.5 s', 'cyan');
        api.mark(lab(b), 'yellow', t);
        return;
      }
      const L = slots(3, N, BODY[3]);
      const bs = [r.still, r.breathing, r.cardiac].map((m, i) => img(m, L.xs[i], L.s, 40, 400));
      if (t < 4.5) {
        // one rotation round the first: the tube, turning
        const b = bs[0], cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2, R = b[2] * 0.55, th = t * Math.PI;
        px.circle(cx, cy, R, 'dkgrey');
        px.glow(cx - Math.sin(th) * R, cy - Math.cos(th) * R, 3, 'orange', 1, 2);
        api.mark(lab(b), 'cyan', t);
      } else api.mark(lab(bs[1]), 'yellow', t);
      under(px, bs[0], '0.5 s', 'cyan');
    },
    caption: [
      { from: 0.8, to: 4.5, text: 'Each image is made from a whole rotation’s views, and assumes the patient was still through it (left).' },
      { from: 4.5, to: 9, text: 'Breathing in during the rotation: the rising chest wall is doubled, and streaks run from its edges (middle).' },
      { from: 9, to: 14, text: 'The beating heart, close up: its borders blurred and doubled (right; left, still). Breath-hold, faster rotation and ECG gating freeze the motion.' },
    ],
  });

  // ---------------------------------------------------------------- rings
  steps.push({
    title: 'Rings', dur: 12, view: 'pixel', scale: '10 cm',
    frame(t) {
      px.fillAll('ink');
      const r = A('ring'), L = slots(2, N, BODY[3], { max: 1.3 });
      // the sinogram: one row per view (half a turn, rebinned to parallel rays), one column per element
      let mx = 0; for (const v of r.sino) mx = Math.max(mx, v);
      const sx = L.xs[0], sw = L.w, sh = L.h;
      drawGrey(px, N, 180, sx, Y0, 1, (i) => r.sino[i] / mx, { scaleXY: [sw / N, sh / 180] });
      px.frame(sx - 1, Y0 - 1, sw + 2, sh + 2, 'dkgrey'); api.keepOut([sx - 1, Y0 - 1, sw + 2, sh + 2]);
      const bx = sx + (r.bin + 0.5) * sw / N;
      px.rect(bx, Y0 + sh + 2, 1, 4, 'red'); px.rect(bx, Y0 - 6, 1, 4, 'red');
      if (t > 3) px.rect(bx, Y0, 1, sh, 'red', 0.35 + 0.25 * Math.sin(t * 5));
      const b = img(t > 5.5 ? r.img : r.good, L.xs[1], L.s, 40, 400);
      if (t < 5.5) api.mark([bx - 4, Y0, 8, sh], 'red', t);
      else { const cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2, R = r.radius * L.s + 4; api.mark([cx - R, cy - R, 2 * R, 2 * R], 'red', t); }
    },
    caption: [
      { from: 0.8, to: 5.5, text: 'One detector element reading a few per cent high, the same in every view: a straight line down the <b>sinogram</b> (red).' },
      { from: 5.5, to: 12, text: 'Back-projected it becomes a <b>ring</b> round the centre of rotation (right). Recalibrating the detector clears it.' },
    ],
  });

  // ---------------------------------------------------------------- too few views
  steps.push({
    title: 'Too few views', dur: 12, view: 'pixel', scale: '10 cm',
    frame(t) {
      px.fillAll('ink');
      const r = A('aliasing'), L = slots(2, N, BODY[3], { max: 1.3 });
      const a = img(r.many, L.xs[0], L.s, 40, 400), b = img(r.few, L.xs[1], L.s, 40, 400);
      under(px, a, String(r.nMany), 'cyan'); under(px, b, String(r.nFew), 'orange');
      if (t < 5.5) {
        const cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2, R = b[3] * 0.5;
        for (let k = 0; k < r.nFew; k++) { const ph = k / r.nFew * Math.PI, dx = Math.sin(ph) * R, dy = Math.cos(ph) * R; px.line(cx - dx, cy - dy, cx + dx, cy + dy, 'orange', 0.3); }
      }
      api.mark(lab(t < 5.5 ? a : b), t < 5.5 ? 'cyan' : 'orange', t);
    },
    caption: [
      { from: 0.8, to: 5.5, text: 'A rotation is sampled in about a thousand views. The same slice from 360 views over a half turn (left)...' },
      { from: 5.5, to: 12, text: '...and from 24 (right): between too few views the back-projections no longer cancel, and fine <b>streaks</b> fan out from every edge (aliasing).' },
    ],
  });

  // ---------------------------------------------------------------- truncation
  steps.push({
    title: 'Truncation', dur: 13, view: 'pixel', scale: '10 cm',
    frame(t) {
      px.fillAll('ink');
      const r = A('truncation'), n = r.N, R = r.R, c0 = Math.floor(n / 2 - R - 2), cw = n - 2 * c0;
      const L = slots(2, cw, cw, { max: 1.1 }), crop = [c0, c0, cw, cw];
      const a = drawHU(api, r.centred, n, n, L.xs[0], Y0, L.s, 40, 400, { crop }), b = drawHU(api, r.off, n, n, L.xs[1], Y0, L.s, 40, 400, { crop });
      for (const bb of [a, b]) px.circle(bb[0] + bb[2] / 2, bb[1] + bb[3] / 2, R * L.s, 'cyan', 0.6);
      under(px, a, '50 cm', 'cyan');
      if (t < 5.5) api.mark(lab(a), 'cyan', t);
      else api.mark([b[0] + b[2] * 0.72, b[1] + b[3] * 0.2, b[2] * 0.3, b[3] * 0.6], 'yellow', t);
    },
    caption: [
      { from: 0.8, to: 5.5, text: 'The fan covers a 50 cm <b>scan field of view</b> (circle): this patient, centred, fits inside it (left).' },
      { from: 5.5, to: 13, text: 'Off centre (right), the side outside the field is never fully measured: it is missing from the image, and the edge of the field reads too bright. Centre the patient.' },
    ],
  });

  // ---------------------------------------------------------------- stair-step
  const ZC = [14, 238, 72, 72];                     // the coronal round the right iliac wing's curve
  steps.push({
    title: 'Stair-step', dur: 12, view: 'pixel', scale: '1 cm',
    frame(t) {
      px.fillAll('ink');
      const L = slots(2, ZC[2], ZC[3], { max: 2.4 });
      const thin = S.zaxis.coronal(2.5, 1.25), thick = S.zaxis.coronal(5, 10);
      const a = drawHU(api, thin.img, thin.w, thin.h, L.xs[0], Y0, L.s, 40, 400, { crop: ZC }), b = drawHU(api, thick.img, thick.w, thick.h, L.xs[1], Y0, L.s, 40, 400, { crop: ZC });
      // the thick images' centres down the side
      for (const z of thick.zs) { const y = b[1] + ((z - 1) / 2 - ZC[1] + 0.5) * L.s; if (y > b[1] && y < b[1] + b[3]) px.rect(b[0] + b[2] + 2, y, 4, 1, 'orange'); }
      under(px, a, '2.5 / 1.25 mm', 'cyan'); under(px, b, '5 / 10 mm', 'orange');
      api.mark(lab(t < 6 ? b : a), t < 6 ? 'orange' : 'cyan', t);
    },
    caption: [
      { from: 0.8, to: 6, text: 'Reformatted from thick slices far apart (ticks: their centres), a curved edge comes out in <b>steps</b> (right)...' },
      { from: 6, to: 12, text: '...from thin, overlapping ones, smooth (left). 3D renderings step the same way.' },
    ],
  });

  // ---------------------------------------------------------------- windmill
  steps.push({
    title: 'Windmill', dur: 13, view: 'pixel', scale: (t) => (t < 5.5 ? '1 cm' : '10 cm'),
    frame(t) {
      px.fillAll('ink');
      if (t < 5.5) {
        // the rows (16 of 2.5 mm, pitch 1.5) sweeping past one slice: interpolated between two,
        // differently at every view
        const b = [40, 20, px.W - 80, px.H - 76];
        const P = helixPlot(api, b, { zLo: -14, zHi: 26, rows: WINDMILL.rows, w: WINDMILL.w, feed: WINDMILL.pitch * WINDMILL.rows * WINDMILL.w });
        px.line(b[0], P.Y(6), b[0] + b[2], P.Y(6), 'yellow', 0.9);
        // view by view, the two rows either side of the slice and the value between them
        const upTh = 720 * span(t, 0.8, 4.5, api.ease.linear);
        for (let th = 6; th <= upTh; th += 12) {
          const st = straddle(P, th, 6);
          if (!st) continue;
          const X = P.X(th);
          px.rect(X - 1, P.Y(st[1]) - 1, 2, 2, 'cyan'); px.rect(X - 1, P.Y(st[2]) - 1, 2, 2, 'cyan');
          px.rect(X - 1, P.Y(6) - 1, 3, 3, 'yellow');
        }
        api.keepOut([b[0] - 40, b[1] - 12, b[2] + 44, b[3] + 24]);
        api.mark([b[0], P.Y(6) - 4, b[2], 8], 'yellow', t);
        return;
      }
      const r = A('windmill'), L = slots(2, N, BODY[3], { max: 1.3 });
      const a = img(r.truth, L.xs[0], L.s, 40, 400), b = img(r.helical, L.xs[1], L.s, 40, 400, { a: clamp01((t - 5.5) / 0.5) });
      api.mark(lab(b), 'yellow', t);
    },
    caption: [
      { from: 0.8, to: 5.5, text: 'In a helical scan the slice (yellow) is interpolated between rows sweeping past it, a little differently in every view.' },
      { from: 5.5, to: 13, text: 'Where anatomy changes fast along z the error rises and falls as the rows go by, and comes out as streaks fanning from those edges: the <b>windmill</b> (right).' },
    ],
  });

  // ---------------------------------------------------------------- cone beam
  steps.push({
    title: 'Cone beam', dur: 13, view: 'pixel', fadeOut: 0.5, scale: '10 cm',
    frame(t) {
      px.fillAll('ink');
      if (t < 6) {
        const g = sideGeo(px), out = ROWS - 1;
        // the patient across the isocentre (32 cm deep), the outermost row's rays, and the flat slice assumed
        const cm = (g.dy - g.fy) / 100;
        px.rect(g.X(-30, g.iy), g.iy - 16 * cm, g.X(30, g.iy) - g.X(-30, g.iy), 32 * cm, 'peach', 0.12);
        const { cell } = sideView(api, g, { hi: out });
        const [x0, x1] = cell(out), zr = (out - ROWS / 2 + 0.5) * ROW, xa = g.X(zr, g.iy);
        px.line(g.cx, g.fy, (x0 + x1) / 2, g.dy, 'yellow', 0.9);
        px.line(xa, g.iy - 16 * cm, xa, g.iy + 16 * cm, 'cyan', 0.8, 2);
        guard(api, g);
        api.keepOut([xa - 10, g.fy, (x0 + x1) / 2 - xa + 14, g.dy - g.fy]);
        api.mark([xa - 10, g.iy - 16 * cm, (x0 + x1) / 2 - xa + 14, 32 * cm], 'yellow', t);
        return;
      }
      const r = A('cone'), L = slots(2, N, BODY[3], { max: 1.3 });
      const a = img(r.truth, L.xs[0], L.s, -600, 1500), b = img(r.cone, L.xs[1], L.s, -600, 1500);
      api.mark(lab(b), 'yellow', t);
    },
    caption: [
      { from: 0.8, to: 6, text: 'The outermost row (yellow) is reached by rays tilted out of the focal spot’s plane: they cross the patient at a slant, not along the flat slice (blue).', place: 'right' },
      { from: 6, to: 13, text: 'Reconstructed as if flat, its slice mixes in anatomy from above and below, differently from each side: smeared vessels, doubled ribs, streaks (right: the outer row of a 160 mm wide detector; at 40 mm it is slight). Cone-beam reconstruction allows for the tilt.' },
    ],
  });
  return { title: 'Artefacts', steps };
}
