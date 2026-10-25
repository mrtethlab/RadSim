/* CT FILM, chapter 5: contrast and dose. The power injector and its saline flush; bolus tracking,
   the monitoring slice's aorta crossing the threshold and triggering the scan; the arterial and
   portal venous phases on the model's own slice (enhancement curves in slice.js); the dose
   phantom and its pencil chamber, CTDIw and CTDIvol; DLP and effective dose (the app's ctDose);
   tube current modulation along the body from the scout and round each rotation. */
import { setOpacity } from '../../kit/stage.js';
import { ctdiVol, dlp, effectiveDose } from '../../../core/ctDose.js';
import { ENH, huTable, drawSlice, drawGrey, drawTissue } from './slice.js';
import { ZP, PZ } from './rig.js';
import { hud, box, spinAngle, fanStream } from './kit.js';

export function contrastDose(api, S) {
  const { px, sfx, span, lerp, clamp01 } = api;
  const fanPhotons = fanStream(api, S);
  const A = S.img.ax_abd, scout = S.img.scout;
  const COUCH = 75;
  const roomBase = (o = {}) => {
    S.view({ inside: false, shell: 1, patient: true, injector: true, ...o });
    S.rig.couch.visible = S.rig.couchBase.visible = true;
    setOpacity(S.rig.couch, 1); setOpacity(S.rig.couchBase, 1);
    S.setCouch(COUCH, 0); S.setLasers(0); S.setAngle(0); S.setBeam(4, false);
    S.chamber.position.set(0, 0, 0);
  };
  // where the line meets the patient: the left side of the upper chest, where an arm would lie
  const lineEnd = () => [21, S.ISO_Y + 3, COUCH + PZ - 29];
  let lineCurve = null;

  // ---------------------------------------------------------------- the aorta on the slice
  const aortaPx = (() => {
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) if (A.ids[y * A.w + x] === 29) { sx += x; sy += y; n++; }
    return n ? [sx / n, sy / n] : [A.w / 2, A.h / 2];
  })();
  const liverPx = (() => {
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) if (A.ids[y * A.w + x] === 11) { sx += x; sy += y; n++; }
    return n ? [sx / n, sy / n] : [A.w / 3, A.h / 2];
  })();
  // monitoring scans: every 1.5 s of the injection's clock from 8 s; the HU tables kept by time
  const tables = new Map();
  const tableAt = (ts) => { const k = Math.round(ts * 10) / 10; let tb = tables.get(k); if (!tb) { tb = huTable(k); tables.set(k, tb); } return tb; };
  const aortaHU = (ts) => 45 + ENH.aorta(ts);
  const MON = []; for (let ts = 8; ts < 40; ts += 1.5) MON.push(ts);
  const THR = 150, DELAY = 7;
  const TRIG = MON.find((ts) => aortaHU(ts) >= THR);
  const SCAN = TRIG + DELAY;

  // ---------------------------------------------------------------- tube current modulation
  /* Along the body, from the scout: a row's projections summed across it are the slice's
     attenuation integrated over its area, so they give its water-equivalent area and diameter
     (Dw, as the scanner works it out). The mA follows e^(0.05 Dw), a partial compensation for
     the extra attenuation (full would be about e^(0.19 Dw)), smoothed over a few centimetres and held between 40 and 600 mA. */
  const pScale = 9;                                   // the scout's full grey: ~9 (mu x cm) of path
  const Dw = Array.from({ length: scout.h }, (_, r) => {
    let a = 0; for (let c = 0; c < scout.w; c++) a += scout.v[r * scout.w + c];
    const Aw = a * pScale * 0.2 / 0.19;               // cm^2 of water
    return 2 * Math.sqrt(Aw / Math.PI);
  });
  const DwS = Dw.map((_, r) => { let s = 0, n = 0; for (let k = -6; k <= 6; k++) { const v = Dw[r + k]; if (v != null) { s += v; n++; } } return s / n; });
  const sortedD = [...DwS].sort((a, b) => a - b), Dref = sortedD[Math.floor(sortedD.length / 2)];
  const mAz = DwS.map((d) => Math.max(40, Math.min(600, 250 * Math.exp(0.05 * (d - Dref)))));
  // round the rotation: each parallel view's thickest line integral through the abdomen slice
  const pmax0 = Array.from({ length: S.R.NA }, (_, a) => { let m = 0; for (let b = 0; b < S.R.N; b++) m = Math.max(m, S.R.par.p[a * S.R.N + b]); return m; });
  const pmax = pmax0.map((_, a) => { let s = 0; for (let k = -4; k <= 4; k++) s += pmax0[(a + k + pmax0.length) % pmax0.length]; return s / 9; });
  const pRef = [...pmax].sort((a, b) => a - b)[Math.floor(pmax.length / 2)];

  const steps = [
    {
      title: 'The power injector', dur: 12, fadeIn: 0.5, scale: '10 cm',
      enter() { roomBase(); S.setSyringe(0, 1); S.setSyringe(1, 1); lineCurve = S.setLine(lineEnd()); },
      cam: [[0, [290, 120, 300], [24, -10, 40], 38], [12, [225, 90, 235], [26, -6, 40], 36]],
      frame(t) {
        const a = span(t, 2, 9, api.ease.linear), b = span(t, 9.4, 11.4, api.ease.linear);
        S.setSyringe(0, 1 - a); S.setSyringe(1, 1 - 0.4 * b);
        S.sync();
        // the bolus along the line: contrast (amber), then saline (clear) behind it
        if (lineCurve && t > 2 && t < 11.8) for (let i = 0; i < 18; i++) {
          const f = ((t * 0.45 + i / 18) % 1), p = lineCurve.getPoint(f);
          const [x, y, ok] = api.toPx(p);
          const sal = t > 9.4 && f < (t - 9.4) * 0.45;
          if (ok && (t < 9.4 || f < 1)) px.rect(x - 1, y - 1, 2, 2, sal ? 'white' : 'orange', 0.9);
        }
        const ml = Math.round(100 * a), sec = (25 * a + 10 * b).toFixed(1);
        hud(api, [['mL/s', '4.0', 'yellow'], ['mL', String(ml), 'orange'], ['s', sec, 'white']], { w: 56 });
        if (t > 1 && t < 6.5) api.mark(S.injHead, 'orange', t);
        if (t > 6.5) api.mark(S.injHead, 'cyan', t);
      },
      cues: [[2, () => sfx.power()]],
      caption: [
        { from: 1, to: 6.5, text: 'Intravenous <b>iodinated contrast</b> comes from a <b>power injector</b>: a set volume at a set rate, here 100 mL at 4 mL/s into an arm vein.' },
        { from: 6.5, to: 12, text: 'A <b>saline flush</b> follows from the second syringe, pushing the last of the contrast on toward the heart as one tight bolus.' },
      ],
    },
    {
      title: 'Bolus tracking', dur: 16, view: 'pixel', scale: '10 cm',
      cues: [...MON.filter((ts) => ts <= TRIG).map((ts) => [(ts - 6) / 1.6, () => sfx.tick()]), [(TRIG - 6) / 1.6 + 0.05, () => sfx.chime()], [(SCAN - 6) / 1.6, () => sfx.zap()]],
      frame(t) {
        px.fillAll('ink');
        const ts = 6 + 1.6 * Math.min(t, 15.5);                   // the injection's clock (s)
        const done = MON.filter((m) => m <= Math.min(ts, TRIG));
        const scanned = ts >= SCAN;
        const last = scanned ? SCAN : done.length ? done[done.length - 1] : null;
        const s = Math.min(0.62, (px.W - 20) / 2 / A.w), ox = 6, oy = 24;
        if (last != null) drawSlice(px, A, ox, oy, s, { table: tableAt(last), L: 50, W: 400, sigma: scanned ? 8 : 22, seed: 13 });
        else px.rect(ox, oy, A.w * s, A.h * s, 'black');
        // the ROI on the aorta
        const [ax, ay] = aortaPx, R = 5 * s;
        px.circle(ox + ax * s, oy + ay * s, Math.max(3, R + 2), 'yellow');
        // the HU-time plot
        const gx = Math.round(ox + A.w * s + 12), gw = px.W - gx - 6, gy = 20, gh = 120;
        box(api, gx, gy, gw, gh);
        const X = (tt) => gx + 4 + (tt / 40) * (gw - 8), Y = (hu) => gy + gh - 4 - clamp01(hu / 400) * (gh - 8);
        px.line(gx + 4, Y(THR), gx + gw - 4, Y(THR), 'red', 0.9, 2);
        px.text(String(THR), gx + 3, Y(THR) - 7, 'red');
        for (const m of done) { const v = aortaHU(m); px.rect(X(m) - 1, Y(v) - 1, 3, 3, v >= THR ? 'yellow' : 'cyan'); }
        if (ts >= TRIG) { px.rect(X(TRIG), gy + 3, 1, gh - 6, 'yellow', 0.5); }
        if (scanned) { px.rect(X(SCAN), gy + 3, 2, gh - 6, 'lime', 0.9); }
        px.rect(X(Math.min(40, ts)), gy + gh - 4, 1, 3, 'white');
        px.text('s', gx + gw - 3, gy + gh + 2, 'mid', 1, 1, 'right');
        px.text('HU', gx + 3, gy + 3, 'mid');
        const roi = last != null ? Math.round(aortaHU(last)) : 45;
        hud(api, [['ROI', roi + ' HU', roi >= THR ? 'yellow' : 'cyan'], ['s', ts.toFixed(1), 'white']], { x: gx, y: gy + gh + 10, w: gw });
        if (t < 6) api.mark([ox + ax * s - R - 4, oy + ay * s - R - 4, 2 * R + 8, 2 * R + 8], 'yellow', t);
        else api.mark([gx, gy, gw, gh], 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 6, text: '<b>Bolus tracking</b>: a low-dose scan repeated at one level as the contrast travels, a <b>region of interest</b> on the aorta.' },
        { from: 6, to: 10.5, text: 'When the aorta’s value crosses the set <b>threshold</b>, here 150 HU, the scan is triggered...' },
        { from: 10.5, to: 16, text: '...after a short delay for the breath-hold instruction and for the couch to reach the start: the arterial phase.' },
      ],
    },
    {
      title: 'Arterial and portal venous phases', dur: 14, view: 'pixel', scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        const s = Math.min(0.56, (px.W - 18) / 2 / A.w), w = A.w * s, h = A.h * s, x0 = 6, x1 = px.W - 6 - w, y0 = 8;
        drawSlice(px, A, x0, y0, s, { table: tableAt(28), L: 50, W: 400, sigma: 8, seed: 21 });
        drawSlice(px, A, x1, y0, s, { table: tableAt(70), L: 50, W: 400, sigma: 8, seed: 21, a: span(t, 6.5, 7.5) });
        // the enhancement curves over the first 90 s: aorta, portal vein, liver
        const gx = 10, gy = Math.round(y0 + h + 12), gw = px.W - 20, gh = px.H - gy - 6;
        box(api, gx, gy, gw, gh);
        const X = (tt) => gx + 4 + (tt / 90) * (gw - 8), Y = (hu) => gy + gh - 3 - clamp01(hu / 320) * (gh - 6);
        for (const [f, c] of [[ENH.aorta, 'red'], [ENH.portal, 'violet'], [ENH.liver, 'brown']]) {
          let lx = null, ly = null;
          for (let tt = 0; tt <= 90; tt += 1) { const xx = X(tt), yy = Y(f(tt)); if (lx != null) px.line(lx, ly, xx, yy, c); lx = xx; ly = yy; }
        }
        for (const [tt, c] of [[28, 'yellow'], [70, 'cyan']]) { px.rect(X(tt), gy + 2, 1, gh - 4, c, 0.8); px.text(String(tt), X(tt), gy + 3, c, 1, 1, 'center'); }
        api.keepOut([gx, gy, gw, gh]);
        if (t > 0.8 && t < 7) api.mark([x0 + aortaPx[0] * s - 6, y0 + aortaPx[1] * s - 6, 12, 12], 'yellow', t);
        if (t > 7) api.mark([x1 + liverPx[0] * s - 14, y0 + liverPx[1] * s - 14, 28, 28], 'cyan', t);
      },
      caption: [
        { from: 0.8, to: 7, text: 'At about 25–30 s, the <b>arterial phase</b> (left): the aorta and its branches bright, the kidneys lit, the liver barely enhanced yet.' },
        { from: 7, to: 14, text: 'At about 70 s, the <b>portal venous phase</b> (right): the portal vein and the whole liver enhanced, the arteries fading toward the blood’s mean.' },
      ],
    },
    {
      title: 'Measuring dose: CTDI', dur: 13, scale: '10 cm',
      enter() {
        S.view({ inside: true, shell: 0, patient: false, injector: false, phantomOn: true });
        S.rig.couch.visible = S.rig.couchBase.visible = true; setOpacity(S.rig.couch, 1); setOpacity(S.rig.couchBase, 1);
        S.setCouch(-2, 0); S.setLasers(0);
      },
      cam: [[0, [200, 100, 210], [0, 4, ZP], 36], [13, [160, 80, 165], [0, 4, ZP], 34]],
      frame(t) {
        S.setAngle(spinAngle(t, 1.6));
        const moved = span(t, 6.4, 7.6);
        S.chamber.position.set(0, 15 * moved, 0);
        const on = (t > 1.2 && t < 6.2) || t > 7.8;
        S.setBeam(4, on);
        S.sync();
        if (on) fanPhotons(t, { rate: 50, v: 150, a: 0.7 });
        const c = 4.6 * span(t, 1.2, 6.2, api.ease.linear), p = 8.2 * span(t, 7.8, 12, api.ease.linear);
        const w = (1 / 3) * c + (2 / 3) * p;
        hud(api, [['C', c.toFixed(1), 'cyan'], ['P', p.toFixed(1), 'orange'], ['CTDIw', t > 12 ? w.toFixed(1) : '-', 'yellow'], ['', 'mGy', 'mid']], { w: 64 });
        sfx.hold('beam', 240, on ? 0.03 : 0, 'sawtooth');
        if (t > 1 && t < 6.5) api.mark(S.phantom, 'yellow', t);
        if (t > 6.5) api.mark(S.chamber, 'orange', t, { live: true });
      },
      caption: [
        { from: 1, to: 6.5, text: 'The scanner’s output is measured in an acrylic <b>phantom</b>, 32 cm across for the body (16 cm for the head), with a 10 cm <b>pencil ionisation chamber</b> in its centre...' },
        { from: 6.5, to: 13, text: '...and at its edge. <b>CTDI<sub>w</sub></b> = ⅓ centre + ⅔ edge; divided by the pitch it is the <b>CTDIvol</b>: the scanner’s output per slice, not the patient’s own dose.' },
      ],
    },
    {
      title: 'DLP and effective dose', dur: 12, view: 'pixel', scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        const h = px.H - 14, sc = h / scout.h, w = Math.round(scout.w * sc), x = 12, y = 7;
        drawGrey(px, scout.w, scout.h, x, y, sc, (i) => scout.v[i], { smooth: true, a: 0.85 });
        api.keepOut([x, y, w, h]);
        // the planned range (64 cm) and the irradiated length: half a feed more at each end
        const r0 = 14, r1 = 334, over = 10;                  // rows (2 mm): 20 mm a side
        const k = span(t, 1, 6, api.ease.linear);
        const rr = lerp(r0 - over, r1 + over, k);
        px.rect(x, y + (r0 - over) * sc, w, (rr - (r0 - over)) * sc, 'violet', 0.22);
        px.frame(x - 2, y + r0 * sc, w + 4, (r1 - r0) * sc, 'yellow', 0.8);
        px.frame(x - 4, y + (r0 - over) * sc, w + 8, (r1 - r0 + 2 * over) * sc, 'violet', 0.7);
        const ctdi = ctdiVol({ kv: 120, ma: 200, rotS: 0.5, pitch: 1, phantom: 'body' });
        const L = 640, feed = 40, dl = dlp(ctdi, L * k, feed), E = effectiveDose(dl, 'chestabdopelvis');
        hud(api, [['CTDIvol', ctdi.toFixed(1) + ' mGy', 'cyan'], ['L', Math.round((L * k + feed) / 10) + ' cm', 'violet'],
          ['DLP', Math.round(dl) + ' mGy cm', 'yellow'], ['E', t > 6.5 ? E.mSv.toFixed(1) + ' mSv' : '-', 'orange']], { x: x + w + 14, y: 14, w: px.W - x - w - 20 });
        if (t > 0.8 && t < 6.5) api.mark([x - 4, y + (r0 - over) * sc, w + 8, (r1 - r0 + 2 * over) * sc], 'yellow', t);
        if (t > 6.5) api.mark([x + w + 14, 14, px.W - x - w - 20, 40], 'orange', t);
      },
      caption: [
        { from: 0.8, to: 6.5, text: '<b>DLP</b>, the dose–length product: CTDIvol × the length irradiated, a little longer than the planned range. The whole scan’s output, in mGy·cm.', place: 'right' },
        { from: 6.5, to: 12, text: 'Times a factor for the body region (0.015 mSv per mGy·cm for the trunk) it estimates the <b>effective dose</b>, about 7 mSv: for comparing scans and protocols, not one patient’s risk.' },
      ],
    },
    {
      title: 'Tube current modulation', dur: 15, view: 'pixel', scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        if (t < 7.5) {
          const h = px.H - 14, sc = h / scout.h, w = Math.round(scout.w * sc), x = 12, y = 7;
          drawGrey(px, scout.w, scout.h, x, y, sc, (i) => scout.v[i], { smooth: true });
          // the mA along the body, beside it, drawn down as the scan goes
          const gx = x + w + 10, gw = px.W - gx - 30;
          box(api, gx - 2, y - 2, gw + 4, h + 4);
          const upTo = Math.floor(scout.h * span(t, 0.8, 6.5, api.ease.linear));
          let lx = null, ly = null;
          for (let r = 0; r < upTo; r++) { const xx = gx + (mAz[r] / 600) * gw, yy = y + r * sc; if (lx != null) px.line(lx, ly, xx, yy, 'yellow'); lx = xx; ly = yy; }
          const cur = Math.max(0, upTo - 1);
          px.rect(x, y + cur * sc, w, 1, 'yellow', 0.7);
          px.text(String(Math.round(mAz[cur])), px.W - 4, y + cur * sc - 2, 'yellow', 1, 1, 'right');
          px.text('mA', px.W - 4, 4, 'mid', 1, 1, 'right');
          api.keepOut([x, y, w, h]);
          api.mark([gx - 2, y - 2, gw + 4, h + 4], 'yellow', t);
          return;
        }
        // round each rotation: the abdomen's own slice, the tube orbiting it; the mA by angle
        // follows the thickest path the view must cross (the real projections' peak)
        const cx = Math.round(px.W / 2), cy = Math.round(px.H / 2), sc = 0.5, R = 84, kx = 1;
        drawTissue(px, A, cx - A.w * sc / 2, cy - A.h * sc / 2, sc, { dim: 0.75 });
        const th = (t - 7.5) * 1.4;
        const mAa = (a) => { const NA = S.R.NA, i = ((Math.round((a / Math.PI) * NA) % NA) + NA) % NA; return 250 * Math.exp(0.5 * (pmax[i] - pRef)); };
        for (let k = 0; k < 160; k++) {
          const a = (k / 160) * Math.PI * 2, rr = 34 + mAa(a) / 10;
          px.px(cx - Math.sin(a) * rr * kx, cy - Math.cos(a) * rr, 'yellow', 0.9);
        }
        const tx = cx - Math.sin(th) * R * kx, ty = cy - Math.cos(th) * R;
        px.glow(tx, ty, 4, 'orange', 1, 2); px.rect(tx - 2, ty - 2, 5, 5, 'white');
        px.line(tx, ty, cx + Math.sin(th) * R * kx * 0.5, cy + Math.cos(th) * R * 0.5, 'violet', 0.6, 2);
        const m = mAa(th);
        hud(api, [['mA', String(Math.round(m)), 'yellow']], { w: 50 });
        const ra = A.w * sc / 2, rb = A.h * sc / 2;
        api.keepOut([cx - R * kx - 6, cy - R - 6, 2 * R * kx + 12, 2 * R + 12]);
        api.mark([cx - ra - 4, cy - rb - 4, 2 * ra + 8, 2 * rb + 8], 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 7.5, text: '<b>Tube current modulation</b>, planned from the scout: along the body the mA rises through the shoulders and pelvis and falls through the air-filled lungs.', place: 'left' },
        { from: 7.5, to: 15, text: 'And round each rotation: more from the side, where the body is widest, less from the front. Much the same noise everywhere, for less dose.' },
      ],
    },
    {
      title: 'Images out', dur: 9, fadeOut: 1, scale: '1 m',
      enter() { roomBase({ injector: false }); },
      cam: [[0, [150, 70, 180], [0, -5, 20], 38], [9, [330, 150, 380], [0, -10, 10], 40]],
      frame(t) {
        S.setCouch(lerp(COUCH - 60, COUCH, span(t, 0, 5)), 0);
        S.sync();
        if (t > 2) api.mark(S.rig.shell, 'yellow', t);
      },
      cues: [[2, () => sfx.chime()]],
      caption: [{ from: 2, to: 9, text: 'A scan of seconds: raw data in; reconstructed, windowed and reformatted images out, to the radiologist and the archive (PACS).' }],
    },
  ];
  return { title: 'Contrast and dose', steps };
}
