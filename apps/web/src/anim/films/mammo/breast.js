/* MAMMOGRAPHY FILM, chapter 3: the breast. The phantom (the app's breast mesh, its fibroglandular
   tissue inside); compression, as the app models it (volume-conserving: thinner by c, wider by
   1/sqrt c; the force from mammo.js forceN); why it helps (less tissue: less scatter and dose; spread
   out: fewer structures on top of one another); the CC and the MLO; then into the tissue at
   mammography's energies: photoelectric absorption, gland against fat, microcalcifications, and
   scatter stopped by the moving cellular grid. */
import * as THREE from 'three';
import { setOpacity } from '../../kit/stage.js';
import { FOCAL, RECEPTOR_Y, FRONT, H0 } from './rig.js';
import { spectrum, muT, mkeV } from './phys.js';
import { tissueField } from './tissue.js';
import { hud, grey } from './common.js';

export async function breastChapter(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const R = S.R, T = R.tube, D2R = Math.PI / 180;
  const C = 4.5 / H0;                                         // the film's compression: 4.5 cm
  const forceN = (c) => { const s = 1 - c; return Math.round(420 * s * s + 90 * s); };   // mammo.js forceN
  const base = ({ comp = 1, paddle = 22, angle = 0, skin = 1 } = {}) => {
    S.only('unit');
    R.gantry.rotation.z = -angle * D2R; R.tubeArm.rotation.z = 0;
    R.setCompression(comp); R.setPaddle(paddle);
    R.breast.visible = true; R.inside.visible = false; R.beam.visible = false;
    R.parts.gland && (R.parts.gland.visible = true); R.parts.dense && (R.parts.dense.visible = false);
    R.showMuscle(false);
    setSkin(skin);
    for (const o of [R.tubeHead, R.nose, R.snout, R.plate, R.trim]) setOpacity(o, 1);
    T.g.visible = false;
  };
  const setSkin = (a) => { R.skinMat.opacity = a; R.skinMat.transparent = a < 0.999; R.skinMat.depthWrite = a > 0.6; };
  const nip = () => R.breast.localToWorld(new THREE.Vector3(0, 41.9, 0)).toArray();
  const centre = () => R.breast.localToWorld(new THREE.Vector3(0, 0, 0)).toArray();

  // the beam that reaches the breast: Mo/Mo at 28 kV, sampled by energy
  const mm = spectrum('MoMo', 28);
  const sampleMM = (r) => { for (let k = 0; k < 400; k++) { const E = 10 + r() * 18; if (r() * mm.peak < mm(E)) return E; } return 17.5; };

  // ---- why compression helps (8-bit): structures stiffer than the fat round them, spread apart
  function overlapScene(t, c) {
    px.fillAll('ink');
    const W = px.W, H = px.H, cx = Math.round(W / 2), detY = H - 70, k = 8;    // pixels a cm
    const thick = 7.2 * c, half = 9 / Math.sqrt(c);                 // the slice's half-width, cm
    const top = detY - thick * k;
    // paddle, tissue, detector
    px.rect(cx - half * k - 6, top - 4, 2 * half * k + 12, 3, 'cyan', 0.6);
    px.rect(cx - half * k, top, 2 * half * k, thick * k, 'fat', 0.18);
    const rr = rng(31);
    for (let i = 0; i < 70; i++) px.rect(cx + (rr() - 0.5) * 2 * half * k, top + rr() * thick * k, 2, 2, 'gold', 0.4);
    px.rect(cx - 9 * k - 20, detY + 2, 18 * k + 40, 4, 'navy');
    // the structures: a gland lobule and a small mass, positions spread with the fat, sizes kept
    const S_ = [{ x: -1.0, d: 0.32, r: 1.2, c: 'pink', mu: 0.35 }, { x: 0.55, d: 0.78, r: 0.55, c: 'white', mu: 0.5 }];
    const pos = S_.map((s) => ({ ...s, X: cx + (s.x / Math.sqrt(c)) * k, Y: top + s.d * thick * k }));
    for (const s of pos) px.circle(s.X, s.Y, s.r * k, s.c, 0.9, true);
    // the beam straight down, and the image under: each column's extra attenuation
    for (let x = -half * k; x <= half * k; x++) {
      let a = 0;
      for (const s of pos) { const dx = (cx + x - s.X) / k; if (Math.abs(dx) < s.r) a += 2 * Math.sqrt(s.r * s.r - dx * dx) * s.mu; }
      const g = Math.round(40 + Math.min(1, 0.25 + a * 0.45) * 200);
      px.rect(cx + x, detY + 10, 1, 14, `rgb(${g},${g},${g})`);
    }
    px.frame(cx - half * k - 1, detY + 9, 2 * half * k + 2, 16, 'dkgrey');
    for (let i = 0; i < 8; i++) {
      const ph = ((t * 0.8 + i / 8) % 1), x = cx + (i / 7 - 0.5) * 2 * half * k * 0.9;
      px.photon(x, lerp(top - 30, detY, ph), 0, 1, 4, 'violet', 0.6, t * 20 + i);
    }
    api.keepOut([cx - half * k - 8, top - 8, 2 * half * k + 16, detY - top + 36]);
    return { top, detY, half, k, cx, pos };
  }

  // ---- the cellular grid seen from above (an inset): square cells of copper, moving
  function gridTop(x, y, w, h, phase) {
    px.rect(x, y, w, h, 'ink', 0.9); px.frame(x, y, w, h, 'dkgrey');
    const p = 6, ox = ((phase % p) + p) % p;
    for (let gx = x + ox; gx < x + w; gx += p) px.rect(gx, y + 1, 1, h - 2, 'brown');
    for (let gy = y + ox * 0.5; gy < y + h; gy += p) px.rect(x + 1, gy, w - 2, 1, 'brown');
    api.keepOut([x, y, w, h]);
  }

  const sideCam = (d, y = 0) => [d, y, 6];
  const steps = [
    {
      title: 'The breast', dur: 12, fadeIn: 0.4, scale: '10 cm',
      enter() { base({ paddle: 22 }); },
      cam: [[0, [55, 30, 70], [0, 0, 8], 36], [12, [40, 18, 52], [0, -1, 6], 36]],
      frame(t) {
        setSkin(1 - 0.75 * span(t, 3, 6));
        if (t > 0.6 && t < 4.5) api.mark(R.parts.skin || R.breast, 'peach', t);
        if (t > 4.5) api.mark(R.parts.gland || R.breast, 'pink', t);
      },
      caption: [
        { from: 0.6, to: 4.5, text: 'The breast: skin over a body of <b>fat</b>, resting on the support with its chest wall at the front edge.' },
        { from: 4.5, to: 12, text: 'Inside lies the <b>fibroglandular tissue</b>: the lobules and ducts where most breast cancers begin. It attenuates only a little more than the fat round it.' },
      ],
    },
    {
      title: 'Compression', dur: 13, scale: '10 cm',
      enter() { base({ paddle: 22, skin: 0.35 }); },
      cam: [[0, [42, 26, 80], [0, 0, 8], 36], [13, [34, 18, 66], [0, 0, 8], 36]],
      cues: [[0.8, () => sfx.power()]],
      frame(t) {
        // down to touch, then pressing: the breast thins and spreads (mammo.js applyCompression)
        const touch = R.paddleAt(1), drop = span(t, 0.8, 3.2), press = span(t, 3.2, 8.5, api.ease.out);
        const c = lerp(1, C, press);
        R.setCompression(c);
        R.setPaddle(press > 0 ? R.paddleAt(c) : lerp(22, touch, drop));
        const moving = (t > 0.8 && t < 8.5) ? 1 : 0;
        sfx.hold('motor', 120 + 90 * press, 0.035 * moving, 'square');
        hud(api, [['mm', String(Math.round(H0 * c * 10)), 'yellow'], ['N', String(forceN(c)), press > 0.9 ? 'lime' : 'yellow']]);
        api.mark(R.paddleSheet, 'yellow', t, { live: true });
      },
      caption: [
        { from: 0.8, to: 6, text: 'The paddle comes down and <b>compresses</b> the breast: firmly, typically around 100 N, for the few seconds of the exposure.' },
        { from: 6, to: 13, text: 'The tissue cannot go anywhere but sideways: the breast becomes <b>thinner</b> (7 cm to 4.5 cm here) and spreads over more of the detector.' },
      ],
    },
    {
      title: 'Why compress: less tissue', dur: 14, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('ink');
        const half = Math.floor(px.W / 2), cm = 13;
        const mix = (h) => ({ layers: [['fat', h * 0.35], ['gland', h * 0.3], ['fat', h * 0.35]] });
        const top = 12;
        const l = tissueField(api, t + 3, { cols: [mix(7.2)], E: sampleMM, rate: 30, cm, x0: 2, w: half - 4, top, strip: false });
        const r = tissueField(api, t + 3, { cols: [mix(4.5)], E: sampleMM, rate: 30, cm, x0: half + 2, w: half - 4, top: top + (7.2 - 4.5) * cm, strip: false });
        // the share of the beam that reaches the detector under each (at 18 keV)
        for (const [q, x] of [[l, 2], [r, half + 2]]) {
          px.text((q.tr[0] * 100).toFixed(1) + '%', x + (half - 4) / 2, q.yDet + 8, 'violet', 1, 1, 'center');
          api.keepOut([x + 8, q.yDet - 2, half - 20, 16]);
        }
        if (t > 6.5) api.mark([half + 6, r.y0 - 4, half - 12, r.yDet - r.y0 + 8], 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 6.5, text: 'Uncompressed (left), each photon must cross more tissue: more are scattered, and far fewer reach the detector.' },
        { from: 6.5, to: 14, text: 'Thinner (right): <b>less scatter</b> to fog the image, and the same signal at the detector for a much <b>smaller dose</b>; a lower kV can be kept, for contrast.' },
      ],
    },
    {
      title: 'Why compress: spread out', dur: 14, view: 'pixel', scale: '1 cm',
      frame(t) {
        const c = lerp(1, C, span(t, 3, 7.5));
        const r = overlapScene(t, c);
        if (t > 7.5) {
          const [a, b] = r.pos;
          api.mark([Math.min(a.X - a.r * r.k, b.X - b.r * r.k) - 3, r.detY + 7, Math.abs(b.X - a.X) + (a.r + b.r) * r.k + 6, 20], 'yellow', t);
        }
      },
      caption: [
        { from: 0.8, to: 4, text: 'Thick, a lobule of gland (pink) and a small mass (white) lie on one line of sight: on the image they are one shadow.' },
        { from: 4, to: 14, text: 'Pressed thin, the soft fat round them spreads and they <b>separate</b>: two shadows. Held still, the breast cannot move and blur; it also lies closer to the detector.' },
      ],
    },
    {
      title: 'The CC view', dur: 12, scale: '10 cm',
      enter() { base({ comp: C, paddle: R.paddleAt(C), skin: 1 }); R.beam.visible = true; R.beam.material.opacity = 0.1; },
      cam: [[0, [74, 62, 44], [0, 4, 4], 36], [12, [56, 46, 30], [0, 0, 4], 36]],
      frame(t) {
        if (t > 0.6 && t < 6) api.mark(R.parts.skin || R.breast, 'yellow', t);
        if (t > 6) { const [x, y] = api.toPx(nip()); api.mark([x - 7, y - 7, 14, 14], 'yellow', t); }
      },
      caption: [
        { from: 0.6, to: 6, text: 'The <b>craniocaudal</b> (CC) view: the support raised to the fold under the breast, the breast drawn forward onto it, the beam from above.' },
        { from: 6, to: 12, text: 'The <b>nipple in profile</b>, pointing straight ahead, and as much of the back of the breast as can be pulled onto the detector.' },
      ],
    },
    {
      title: 'The MLO view', dur: 13, scale: '10 cm',
      enter() { base({ comp: C, paddle: R.paddleAt(C), skin: 0.45, angle: 45 }); R.beam.visible = true; R.beam.material.opacity = 0.1; R.showMuscle(true); },
      cam: [[0, [30, 34, 205], [0, 12, 0], 38], [13, [58, 24, 180], [0, 6, 4], 38]],
      frame(t) {
        if (t > 0.6 && t < 6.5) api.mark(R.tubeHead, 'yellow', t);
        if (t > 6.5) {
          let m = null; R.parts.gland?.traverse((o) => { if (o.userData.muscle) m = o; });
          api.mark(m || R.breast, 'red', t);
        }
      },
      caption: [
        { from: 0.6, to: 6.5, text: 'The <b>mediolateral oblique</b> (MLO): the C-arm turned parallel to the patient’s pectoral muscle; the beam crosses from the upper inner side to the lower outer.' },
        { from: 6.5, to: 13, text: 'It shows the most tissue in one view, up into the armpit. A good MLO includes the <b>pectoral muscle</b> down to the level of the nipple, with the fold under the breast open.' },
      ],
    },
    {
      title: 'Into the breast', dur: 5, scale: (t) => (t < 2 ? '1 cm' : '1 mm'),
      enter() { base({ comp: C, paddle: R.paddleAt(C), skin: 0.4 }); R.beam.visible = true; R.beam.material.opacity = 0.12; },
      cam: [[0, sideCam(70, 4), [0, 0, 6], 36], [5, sideCam(2.4, 0), [0, 0, 6], 36]],
      cues: [[0.3, () => sfx.whoosh()]],
      frame(t) {
        api.mosaic(span(t, 2, 4.6));
        if (t > 3.9) { px.alpha = span(t, 3.9, 5); px.fillAll('ink'); tissueField(api, t, { cols: [{ layers: [['fat', 4.5]] }, { layers: [['fat', 1.5], ['gland', 2], ['fat', 1]] }, { layers: [['fat', 1], ['gland', 3.5]] }], E: sampleMM }); px.alpha = 1; }
      },
    },
    {
      title: 'Photoelectric absorption', dur: 13, view: 'pixel', scale: '1 cm',
      cues: [[3.6, () => sfx.zap()], [11.6, () => sfx.zap()]],
      frame(t) {
        px.fillAll('ink');
        tissueField(api, t + 5, { cols: [{ layers: [['fat', 4.5]] }, { layers: [['fat', 1.5], ['gland', 2], ['fat', 1]] }, { layers: [['fat', 1], ['gland', 3.5]] }], E: sampleMM, rate: 30, hi: 'pe', hiCol: 1, hiAt: 6, every: 8 });
      },
      caption: [
        { from: 0.8, to: 13, text: 'At 15–20 keV most photons that interact in the breast are absorbed outright: the <b>photoelectric effect</b>, its odds rising steeply with lower energy and higher atomic number (about Z³/E³). Compton scatter is the minority here.' },
      ],
    },
    {
      title: 'Gland against fat', dur: 15, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('ink');
        const E = t < 2 ? 17 : t < 8 ? lerp(17, 35, span(t, 2, 8)) : t < 10 ? 35 : lerp(35, 18, span(t, 10, 13.5));
        const half = Math.floor(px.W * 0.58);
        const r = tissueField(api, t + 40, { cols: [{ layers: [['fat', 4.5]] }, { layers: [['fat', 1.75], ['gland', 1], ['fat', 1.75]] }], E, rate: 40, w: half, dots: true });
        // the contrast a centimetre of gland in place of fat makes, and how much of the beam gets through
        const Cn = 1 - Math.exp(-(muT('gland', E) - muT('fat', E)) * 1);
        const Tr = Math.exp(-(muT('fat', E) * 0.5 + muT('gland', E) * 0.5) * 4.5);
        const x0 = half + 8, bw = px.W - x0 - 10, base_ = px.H - 34;
        hud(api, [['keV', E.toFixed(0), 'yellow']], { w: 44, x: x0 + bw - 44, y: 6 });
        const bar = (x, v, c) => { const h = Math.round(Math.min(1, v) * 100); px.rect(x, base_ - h, 16, h, c); };
        px.rect(x0, base_, bw, 1, 'mid');
        bar(x0 + 4, Cn / 0.4, 'pink'); px.text(Math.round(Cn * 100) + '%', x0 + 12, base_ + 4, 'pink', 1, 1, 'center');
        bar(x0 + bw - 22, Tr / 0.4, 'violet'); px.text(Math.round(Tr * 1000) / 10 + '%', x0 + bw - 14, base_ + 4, 'violet', 1, 1, 'center');
        api.keepOut([x0, base_ - 104, bw, 112]);
        if (t > 8) api.mark([r.L, r.yDet + 5, r.colW * 2, 16], 'yellow', t);
      },
      caption: [
        { from: 0.6, to: 8, text: 'Gland and fat differ only slightly. A centimetre of gland in place of fat: about 30% <b>contrast</b> (pink) at 17 keV, under 10% by 30 keV, as the photoelectric effect fades.' },
        { from: 8, to: 15, text: 'But lower energy also means fewer photons get through 4.5 cm (violet), so more <b>dose</b> for the same image: 15–20 keV is the compromise for an average breast.' },
      ],
    },
    {
      title: 'Microcalcifications', dur: 14, view: 'pixel', scale: '1 cm',
      cues: [[3.6, () => sfx.zap()], [11.6, () => sfx.zap()]],
      frame(t) {
        px.fillAll('ink');
        const sp = [[0.5, 2.1], [0.3, 1.8], [0.7, 2.6], [0.62, 1.6], [0.38, 2.9]];
        tissueField(api, t + 70, { cols: [{ layers: [['fat', 1.5], ['gland', 2], ['fat', 1]] }, { layers: [['fat', 1.5], ['gland', 2], ['fat', 1]], specks: sp }, { layers: [['fat', 4.5]] }], E: sampleMM, rate: 30, hi: 'pe', hiCol: 1, hiAt: 6, every: 8 });
      },
      caption: [
        { from: 0.8, to: 7, text: '<b>Microcalcifications</b>: specks of calcium salts 0.1–0.5 mm across (drawn larger here), sometimes the earliest sign of a cancer.' },
        { from: 7, to: 14, text: 'Calcium (Z = 20) absorbs about <b>20 times</b> more than gland at 17.5 keV, nearly all by the photoelectric effect: even a tiny speck casts a white dot, if the detector’s pixels are small enough to hold it.' },
      ],
    },
    {
      title: 'Scatter and the cellular grid', dur: 16, view: 'pixel', scale: '1 cm',
      cues: [[1.5, () => sfx.click()]],
      frame(t) {
        px.fillAll('ink');
        const ph = Math.sin(t * 2.4) * 9;                         // the grid reciprocates during the exposure
        const w = Math.floor(px.W * 0.68);
        tissueField(api, t + 100, { cols: [{ layers: [['fat', 1.5], ['gland', 1.5], ['fat', 1.5]] }, { layers: [['gland', 4.5]] }, { layers: [['fat', 1], ['gland', 2.5], ['fat', 1]] }], E: sampleMM, rate: 46, w, cm: 18, grid: t > 1.5 ? { ratio: 4.5, pitch: 6, h: 16, phase: ph } : null, strip: false, hi: 'compton', hiCol: 1, hiAt: 2, every: 7, slow: 3 });
        const ix = w + 6, iw = px.W - ix - 6;
        if (t > 6) { gridTop(ix, 30, iw, iw, ph); api.mark([ix, 30, iw, iw], 'yellow', t); }
      },
      caption: [
        { from: 0.6, to: 6, text: 'Even at these energies some photons are scattered. A <b>grid</b> under the support stops most of those arriving at an angle.' },
        { from: 6, to: 11, text: 'Mammography’s is <b>cellular</b>: thin copper walls in a square lattice with air in the cells, low (about 4–5:1), so it stops scatter coming from either direction and passes nearly all the primary beam.' },
        { from: 11, to: 16, text: 'It <b>moves</b> during the exposure so its walls blur away and never show on the image. Magnification views leave it out: the air gap does the job.' },
      ],
    },
  ];
  void FOCAL; void RECEPTOR_Y; void FRONT; void mkeV; void grey; void clamp01; void centre;
  return { title: 'The breast', steps };
}
