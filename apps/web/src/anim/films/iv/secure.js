/* IV FILM, chapter 4: secured and used. The film dressing; the flush (blood return, 10 mL pushed,
   no swelling), the clamp and the cap; the saline in the vein; what goes wrong (through the back
   wall, infiltration, an artery, a valve); the power injector; the contrast in the vein, down to
   the plasma between the cells. */
import * as THREE from 'three';
import { Section, bloodField, dimLine } from './px.js';
import { at as recAt } from './engine.js';
import { v3 } from './arm.js';
import { shots } from './shots.js';
import { setOpacity } from '../../kit/stage.js';

const D = Math.PI / 180;

export async function secured(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const C = shots(api, S), R3 = S.R3, G = S.G, mk = S.mark;
  const R = S.ins, last = R.rec[R.rec.length - 1], Pn = R.P.needle;
  const fromMark = (da, dl) => [mk.a + da * mk.tan[0] - dl * mk.tan[1], mk.l + da * mk.tan[1] + dl * mk.tan[0]];
  // the catheter in, the needle gone, the line flushed (0) or full of blood (1)
  const inSt = (line) => ({ ...last, line });
  const dAt = fromMark(-0.6, 0);
  const dressing = (k, edges) => ({ a: dAt[0], l: dAt[1], ang: Math.atan2(mk.tan[0], mk.tan[1]), k, edges });
  const sitePaint = (o = {}) => ({ fill: 0, mark: { a: mk.a, l: mk.l }, wet: 0.05, wetR: 2.5, dressing: dressing(1, [1, 1, 1, 1]), ...o });
  // where the catheter's tip lies on the skin (the engine's x mm along the vein from the mark)
  const tipAL = fromMark(last.cath[0] / 10, 0);

  // ================================================================ 8-bit sections
  // the threaded catheter in the vein, the needle gone (the engine's last state); a plume from its tip
  function cathSection(t, { plume = null, k: kk = null, tissueBulge = null, outside = false } = {}) {
    const k = kk || Math.min(9, (px.W - 8) / 30, (px.H - 8) / 15);
    const sec = new Section(px, { k, u0: (outside ? 4 : last.cath[0]) - (px.W / k) * (outside ? 0.42 : 0.55), z0: -3 });
    sec.tissue(t, { fatBottom: 15, bulge: tissueBulge });
    const r = 3.0, cz = 3.5 + 0.4 + r;
    sec.vessel(t, { cz, b: r, v: 5, seed: 23, contrast: plume && !outside ? { u: last.cath[0], z: outside ? 0 : cz - 0.6, ...plume } : null });
    // the catheter: from the skin's entry down into the vein, along it to its tip
    const p = 10 * D, d = [Math.cos(p), Math.sin(p)];
    const tipZ = outside ? 2.2 : cz - 0.6, tipU = outside ? 4 : last.cath[0];
    const bend = [tipU - 7, outside ? 1.6 : cz - 1.4];
    sec.catheter([[tipU, tipZ], bend, [bend[0] - 30 * d[0], bend[1] - 30 * d[1]]], { od: 1.1 });
    return { sec, tip: [tipU, tipZ], cz, r };
  }
  // fluid pooling in the tissue round a tip outside the vein: a growing blob, the skin lifted
  function poolBlob(sec, at, k, col) {
    const R0 = 0.6 + 4.2 * k, r = rng(77);
    for (let i = 0; i < 900 * Math.min(1, k + 0.15); i++) {
      const a = r() * 6.283, d = Math.sqrt(r()) * R0;
      const u = at[0] + Math.cos(a) * d * 1.3, z = at[1] + Math.sin(a) * d * 0.7;
      if (z < 0.2 || z > 3.7) continue;          // (in the fat, over the vein's wall)
      px.px(sec.X(u), sec.Y(z), r() < 0.6 ? col : 'white', 0.55);
    }
    return R0;
  }

  // two flash chambers side by side: a vein's (dark, steady) and an artery's (bright, in beats)
  function chambers(t) {
    px.fillAll('ink');
    const W = px.W, H = px.H, cw = Math.min(56, W * 0.22), ch = Math.min(120, H * 0.6);
    const out = [];
    [['vein', W * 0.3], ['art', W * 0.7]].forEach(([kind, cx], i) => {
      const x0 = Math.round(cx - cw / 2), y0 = Math.round(H * 0.5 - ch / 2);
      // the chamber: a clear barrel on the needle's grip, the needle entering at the bottom
      px.rect(x0 - 6, y0 + ch, cw + 12, 18, 'mid'); px.rect(x0 - 6, y0 + ch, cw + 12, 2, 'grey');
      px.rect(cx - 1, y0 + ch + 18, 3, H - (y0 + ch + 18), 'grey');
      px.frame(x0, y0, cw, ch, 'grey'); px.rect(x0 + 2, y0, 2, ch, 'white', 0.35);
      // the fill: steady for the vein; in beats, a jet at each systole, for the artery
      const T = (t % 12);
      let lev;
      if (kind === 'vein') lev = span(T, 0.8, 4.5, api.ease.out);
      else {
        const beat = 60 / 75, n = Math.floor(T / beat), f = (T % beat) / beat;
        lev = Math.min(1, (n + span(f, 0, 0.25, api.ease.out)) * 0.085);
      }
      const h = Math.round((ch - 4) * lev);
      px.rect(x0 + 2, y0 + ch - 2 - h, cw - 4, h, kind === 'vein' ? 'dkred' : 'red');
      const r = rng(30 + i);
      for (let j = 0; j < h * cw / 18; j++) px.px(x0 + 3 + r() * (cw - 6), y0 + ch - 2 - r() * h, kind === 'vein' ? 'plum' : 'pink', 0.8);
      // the arterial jet in the needle's mouth at each beat
      if (kind === 'art') {
        const beat = 60 / 75, f = (T % beat) / beat;
        if (f < 0.25 && lev < 1) for (let j = 0; j < 8; j++) px.rect(cx - 1 + (j % 3) - 1, y0 + ch - 2 - h - j * 3 * (1 - f * 4), 2, 2, 'pink');
      }
      out.push([x0 - 8, y0 - 6, cw + 16, ch + 30]);
    });
    return out;
  }

  // ================================================================ the steps
  const steps = [
    {
      title: 'Dressing', dur: 13, scale: '1 cm',
      enter() { S.reset(); S.supplies(2); api.camera.up.set(...C.topUp()); },
      cam: [[0, ...C.top(24, -0.4, 0, 34)], [13, ...C.top(21, -0.4, 0, 34)]],
      cues: [[1.6, () => sfx.hiss(0.3, 0.1, 1500)], [6.2, () => sfx.tick()], [7, () => sfx.tick()], [7.8, () => sfx.tick()], [8.6, () => sfx.tick()]],
      frame(t) {
        S.placeKit(inSt(1), { clampOpen: false, portCap: false });
        const k = span(t, 1, 2.6);
        const edges = [0, 1, 2, 3].map((i) => (t > 6 + i * 0.8 ? 1 : 0));
        S.painter.paint(sitePaint({ dressing: dressing(k, edges) }));
        const box = [fromMark(-4.1, -3), fromMark(2.9, 3), fromMark(-4.1, 3), fromMark(2.9, -3)];
        if (t > 1 && t < 6) C.markRegion(G, box, 'cyan', t);
        if (t > 6) C.markRegion(G, box, 'yellow', t);
      },
      caption: [
        { from: 1, to: 6, text: 'A clear <b>film dressing</b> over the entry and the catheter’s wings: the site stays in sight, the catheter cannot slide in or out.' },
        { from: 6, to: 13, text: 'Its edges pressed down all round to seal it, and it is labelled with the date: a catheter is checked every shift and replaced when no longer needed or at the first sign of trouble.' },
      ],
    },
    {
      title: 'Flush and cap', dur: 17, scale: '1 cm',
      enter() { S.reset(); S.supplies(4); S.painter.paint(sitePaint()); },
      cam: [[0, ...C.side(30, 40, -4, 34)], [17, ...C.side(28, 42, -3.5, 34)]],
      cues: [[1.8, () => sfx.click()], [2.6, () => sfx.click()], [10.6, () => sfx.click()], [11.6, () => sfx.click()], [13.6, () => sfx.click()]],
      frame(t) {
        // on and locked (a quarter turn), the clamp opened, pulled back, pushed 10 mL in 5 s, the
        // clamp shut, the syringe off, the cap on
        const clampOpen = t > 2.6 && t < 10.6;
        const drawn = 0.5 * span(t, 3.2, 4.6) * (1 - span(t, 5.2, 5.5));
        const pushed = span(t, 5.2, 10.2, api.ease.linear);
        const blood = 0.45 * span(t, 3.4, 4.6) * (1 - span(t, 5.2, 6));
        const line = t < 5.2 ? 1 : 1 - span(t, 5.2, 6.4);
        S.placeKit(inSt(line), { clampOpen, portCap: false });
        const on = t > 0.5 && t < 12.2;
        S.placeSyringe({ on, left: 1 + drawn / 10 - pushed, blood, twist: 90 * span(t, 0.8, 1.8) * (1 - span(t, 11, 12)), cap: t > 12.6, capTwist: 90 * span(t, 12.8, 13.6) });
        if (on && t < 5.2) api.mark(R3.syringe, 'red', t);
        if (t >= 5.2 && t < 10.4) C.markRegion(G, [fromMark(-1, -1.2), fromMark(2.4, 1.2), fromMark(-1, 1.2), fromMark(2.4, -1.2)], 'cyan', t);
        if (t > 12.6) api.mark(R3.luer, 'yellow', t);
      },
      caption: [
        { from: 1, to: 5.2, text: 'The saline flush on the port, the clamp opened, a gentle pull back: <b>blood return</b>, the catheter is in the vein.' },
        { from: 5.2, to: 10.4, text: 'Then <b>10 mL</b> pushed steadily: no resistance, no swelling over the tip, no pain.' },
        { from: 10.6, to: 17, text: 'The clamp shut before the syringe comes off, and a sterile <b>cap</b> twisted on: the line is closed and ready.' },
      ],
    },
    {
      title: 'Saline in the vein', dur: 12, scale: '1 mm',
      enter() { S.reset(); S.supplies(4); S.painter.paint(sitePaint()); for (const [id, m] of Object.entries(S.tubes)) m.visible = id === 'medianCubital'; },
      cam: [[0, ...C.side(14, 20, 1, 32)], [2.6, v3.add(C.veinC(0.69, 1.2), v3.add(v3.mul(C.Sd, 1.3), v3.mul(S.F.n, 0.1))), C.veinC(0.69, 1.2), 30]],
      cues: [[0.3, () => sfx.whoosh()]],
      frame(t) {
        S.placeKit(inSt(0), { clampOpen: false, portCap: false });
        S.placeSyringe({ cap: true, capTwist: 90 });
        S.cutaway(span(t, 0, 1) * 0.7);
        api.mosaic(span(t, 1, 2.6));
        if (t > 2.4) {
          px.alpha = span(t, 2.4, 3.1);
          const pulse = 0.5 + 0.5 * Math.sin((t - 3) * 1.4);
          const c = cathSection(t, { plume: { cols: ['cyan', 'white'], k: 0.55 + 0.4 * pulse, rate: 1, jet: 0.8 } });
          px.alpha = 1;
          const x = c.sec.X(c.tip[0]), y = c.sec.Y(c.tip[1]);
          if (t > 3.2) api.mark([x - 6, y - 14, 70, 28], 'cyan', t);
          api.keepOut([x - 6, y - 16, 74, 32]);
        }
      },
      caption: [{ from: 3.2, to: 12, text: 'At the catheter’s tip the saline streams out into the blood and is carried off toward the heart: the catheter is <b>patent</b>, the vein intact.' }],
    },
    {
      title: 'Through the back wall', dur: 13, view: 'pixel', scale: '1 mm',
      cues: [[4.4, () => sfx.pew(700)], [7.2, () => sfx.thud()]],
      frame(t) {
        // a steep needle, not lowered at the flash, pushed on: in, across, and out the back
        const k = Math.min(8, (px.W - 8) / 30, (px.H - 8) / 19);
        const sec = new Section(px, { k, u0: -6, z0: -3 });
        const r = 4.05, cz = 3.5 + 0.4 + r, p = 35, s = lerp(4, 25, span(t, 1, 7.5, api.ease.linear));
        const tip = [s * Math.cos(p * D), s * Math.sin(p * D)];
        const out = tip[1] > cz + r + 0.4;
        const hk = span(t, 7, 12.5);
        sec.tissue(t, { fatBottom: 17, bulge: (u) => hk * 1.2 * Math.exp(-(((u - 17) / 7) ** 2)) });
        sec.vessel(t, { cz, b: r, v: 4, seed: 31 });
        // the haematoma: blood out through the hole in the back wall, spreading into the fat
        if (t > 6.8) {
          const at = [tip[0] - 1.4, cz + r + 1.6], rr = rng(5);
          const R0 = 1 + 5.5 * hk;
          for (let i = 0; i < 1400 * Math.min(1, hk + 0.2); i++) {
            const a = rr() * 6.283, d = Math.sqrt(rr()) * R0, u = at[0] + Math.cos(a) * d * 1.5, z = at[1] + Math.sin(a) * d * 0.6 + d * 0.15;
            if (z < cz + r + 0.4) continue;
            px.px(sec.X(u), sec.Y(z), rr() < 0.6 ? 'plum' : 'dkred', 0.85);
          }
          px.alpha = 1;
        }
        sec.catheter([[tip[0] - 1.5 * Math.cos(p * D), tip[1] - 1.5 * Math.sin(p * D)], [tip[0] - 40 * Math.cos(p * D), tip[1] - 40 * Math.sin(p * D)]], { od: 1.1 });
        sec.needle(t, { tip, pitch: p, bevel: 1.2, len: 45, lumenFill: t > 3.5 && !out ? 0.6 : out ? 0.3 : 0 });
        const tx = sec.X(tip[0]), ty = sec.Y(tip[1]);
        api.mark([tx - 16, ty - 14, 32, 28], 'yellow', t);
        api.keepOut([tx - 20, ty - 18, 40, 36]);
      },
      caption: [
        { from: 1, to: 6.8, text: 'Left steep after the flash and pushed on, the bevel crosses the lumen and goes out through the <b>back wall</b>: a through-and-through puncture.' },
        { from: 6.8, to: 13, text: 'Blood leaks into the tissue: a <b>haematoma</b> swells and darkens. Out, firm pressure, and a fresh site above it or on the other arm.' },
      ],
    },
    {
      title: 'Infiltration', dur: 15, scale: (t) => (t < 6 ? '1 cm' : '1 mm'),
      enter() { S.reset(); S.supplies(4); S.painter.paint(sitePaint()); },
      cam: [[0, ...C.side(26, 40, 0.5, 34)], [5.5, ...C.side(20, 30, 0.8, 32)]],
      cues: [[1.2, () => sfx.tone(300, 200, 0.4, 'triangle', 0.25)]],
      frame(t) {
        S.placeKit(inSt(0), { clampOpen: true, portCap: false });
        S.placeSyringe({ on: t < 6, left: 1 - 0.3 * span(t, 1, 5.5), twist: 90 });
        const sw = span(t, 1, 5.5);
        S.painter.paint(sitePaint({ swell: sw, swellAt: { a: tipAL[0], l: tipAL[1] } }));
        if (t > 1.5 && t < 5.8) C.markRegion(G, [fromMark(0, -1.8), fromMark(2.6, 1.8), fromMark(0, 1.8), fromMark(2.6, -1.8)], 'yellow', t);
        api.mosaic(span(t, 5.2, 6.4));
        if (t > 6.2) {
          px.alpha = span(t, 6.2, 6.8);
          const pk = span(t, 6.8, 13.5);
          const bulge = (u) => pk * 2.6 * Math.exp(-(((u - 5) / 5) ** 2));
          const c = cathSection(t, { outside: true, tissueBulge: bulge });
          const R0 = poolBlob(c.sec, [c.tip[0] + 1.2, c.tip[1] + 0.1], pk, 'cyan');
          // the jet still coming out of the tip into the fat
          for (let i = 0; i < 20; i++) { const ph = (t * 1.5 + i / 20) % 1; px.px(c.sec.X(c.tip[0] + ph * 2), c.sec.Y(c.tip[1] + (i % 5 - 2) * 0.15 * ph), 'white', 1 - ph); }
          px.alpha = 1;
          const bx = c.sec.X(c.tip[0] + 1.2 - R0 * 1.3), by = c.sec.Y(c.tip[1] - R0 * 0.7 - pk * 2.6);
          api.mark([bx, by, R0 * 2.6 * c.sec.k, (R0 * 1.4 + pk * 2.6) * c.sec.k], 'yellow', t);
        }
      },
      caption: [
        { from: 1.5, to: 5.8, text: 'Swelling, tightness, pain, pale cool skin over the tip as it is flushed: stop at once.' },
        { from: 6.4, to: 15, text: 'The tip has slipped out of the vein: the fluid pools in the tissue instead, <b>infiltration</b>. With contrast it is <b>extravasation</b>: out, elevate, and report.' },
      ],
    },
    {
      title: 'An artery', dur: 12, view: 'pixel', scale: '1 cm',
      cues: [[0.8, () => sfx.blip(440)], ...Array.from({ length: 9 }, (_, i) => [0.4 + i * 0.8, () => sfx.tone(180, 120, 0.08, 'triangle', 0.3)])],
      frame(t) {
        const b = chambers(t);
        if (t < 4.5) api.mark(b[0], 'plum', t); else api.mark(b[1], 'red', t);
        api.keepOut(b[0]); api.keepOut(b[1]);
      },
      caption: [
        { from: 0.6, to: 4.5, text: 'A vein’s flash: dark red, rising steadily.' },
        { from: 4.5, to: 12, text: 'Bright red blood that jumps up the chamber with each beat is <b>arterial</b>: out at once, firm pressure for at least 5 minutes, and tell the doctor.' },
      ],
    },
    {
      title: 'A valve in the way', dur: 13, view: 'pixel', scale: '1 mm',
      cues: [[4, () => sfx.thud()], [9.4, () => sfx.hiss(0.5, 0.12, 2500)]],
      frame(t) {
        const k = Math.min(10, (px.W - 8) / 26, (px.H - 8) / 15);
        const sec = new Section(px, { k, u0: -4, z0: -2.6 });
        sec.tissue(t, { fatBottom: 14 });
        const r = 3.2, cz = 3.9 + r, vu = 13;
        // the catheter threads on toward a valve; its tip stops in the cusps and the shaft bows;
        // a flush as it is eased on floats the cusps open and it slips through
        const float = span(t, 9.2, 10.6), push = span(t, 1, 4, api.ease.linear) + span(t, 10, 12.5, api.ease.linear) * 0.8;
        const tipU = Math.min(vu + 0.4 + float * 6, 4 + push * 9.4 + float * 6);
        const stuck = t > 4 && t < 10;
        const bow = stuck ? span(t, 4, 6) * (1 - float) * 1.3 : 0;
        sec.vessel(t, { cz, b: r, v: 3, seed: 41, valves: [vu], valveOpen: 0.15 + 0.85 * float, contrast: float > 0 && float < 1 ? { u: tipU, z: cz, cols: ['cyan', 'white'], k: 0.6 } : null });
        const pts = [];
        for (let i = 0; i <= 12; i++) {
          const f = i / 12, u = tipU - f * 14, z = cz - 0.2 - Math.sin(f * Math.PI) * bow;
          pts.push([u, z]);
        }
        pts.push([-6, -2]);
        sec.catheter(pts, { od: 1.1 });
        api.mark([sec.X(vu - 1.5), sec.Y(cz - r - 0.6), sec.X(vu + 4) - sec.X(vu - 1.5), sec.Y(cz + r + 0.6) - sec.Y(cz - r - 0.6)], stuck ? 'orange' : 'yellow', t);
        api.keepOut([sec.X(vu - 1.5), sec.Y(cz - r - 0.6), sec.X(vu + 4) - sec.X(vu - 1.5), sec.Y(cz + r + 0.6) - sec.Y(cz - r - 0.6)]);
      },
      caption: [
        { from: 1, to: 9.2, text: 'Threading stops dead, the catheter bowing behind its tip: it has met a <b>valve</b>. Never force it on.' },
        { from: 9.2, to: 13, text: 'A slow flush as it is eased on can float the cusps open; if it will not pass, take it out and choose a site clear of valves.' },
      ],
    },
    {
      title: 'The power injector', dur: 16, scale: '10 cm',
      enter() {
        S.reset(); S.supplies(4); S.painter.paint(sitePaint());
        S.placeKit(inSt(0), { clampOpen: true, portCap: false }); S.placeSyringe({ cap: true, capTwist: 90 });
        S.inj.group.visible = true; S.inj.routeLine(S.portWorld());
      },
      cam(t) {
        const head = S.inj.head.getWorldPosition(new THREE.Vector3()), hd = [head.x, head.y, head.z];
        const mid = v3.add(v3.mul(hd, 0.5), v3.mul(S.siteW, 0.5));
        const a = [v3.add(mid, [70, 75, 120]), mid], b = [v3.add(hd, [52, 46, 72]), v3.add(hd, [0, -8, 6])];
        const k = span(t, 7, 10);
        return { pos: v3.add(a[0], v3.mul(v3.sub(b[0], a[0]), k)), look: v3.add(a[1], v3.mul(v3.sub(b[1], a[1]), k)), fov: 36 };
      },
      cues: [[2, () => sfx.power()], [10.5, () => sfx.chime()]],
      frame(t) {
        S.placeKit(inSt(0), { clampOpen: true, portCap: false });
        S.placeSyringe({ cap: true, capTwist: 90 });
        // a saline test at the planned rate (2-6 s), then the contrast (10.5 s on)
        const sal = span(t, 2, 6, api.ease.linear), con = span(t, 10.5, 16, api.ease.linear);
        const running = (t > 2 && t < 6) || (t > 10.5 && t < 16);
        const psi = running ? Math.round(150 + 25 * Math.sin(t * 3) + (con > 0 ? 40 : 0)) : 0;
        S.inj.set({ a: 1 - 0.55 * con, b: 1 - 0.12 * sal, fill: con > 0 ? Math.min(1, con * 3) : 0,
          rows: [[running ? '4.0' : '0.0', 'mL/s', '#7fe3a4'], [String(Math.round(sal * 15 + con * 80)), 'mL', '#e8edf2'], [String(psi), 'psi', psi > 300 ? '#ff5a5a' : '#ffd166']] });
        if (running) sfx.hold('inj', 140, 0.025, 'square'); else sfx.stop('inj');
        if (t > 1 && t < 7) api.mark(S.inj.line.mesh || S.inj.group, 'cyan', t);
        if (t > 7) api.mark(S.inj.head, 'yellow', t);
      },
      caption: [
        { from: 1, to: 7, text: 'For the scan the line goes to the <b>power injector</b>. First a saline test at the planned rate, a hand over the site: no swelling, no pain.' },
        { from: 7, to: 16, text: 'Then the contrast: one syringe of contrast, one of saline to chase it, at a set rate (4 mL/s here) and under a <b>pressure limit</b> it will not exceed.' },
      ],
    },
    {
      title: 'Contrast in the vein', dur: 17, scale: (t) => (t < 9 ? '1 mm' : '10 µm'),
      enter() { S.reset(); S.supplies(4); S.painter.paint(sitePaint()); for (const [id, m] of Object.entries(S.tubes)) m.visible = id === 'medianCubital'; S.inj.group.visible = true; },
      cam: [[0, ...C.side(14, 22, 1, 32)], [2.4, v3.add(C.veinC(0.69, 1.2), v3.add(v3.mul(C.Sd, 1.3), v3.mul(S.F.n, 0.1))), C.veinC(0.69, 1.2), 30]],
      cues: [[0.3, () => sfx.whoosh()]],
      frame(t) {
        S.placeKit(inSt(0), { clampOpen: true, portCap: false });
        S.placeSyringe({ cap: true, capTwist: 90 });
        S.cutaway(span(t, 0, 1) * 0.7);
        api.mosaic(span(t, 0.8, 2.4));
        if (t > 2.2 && t < 9.4) {
          px.alpha = span(t, 2.2, 2.9) * (1 - span(t, 8.6, 9.4));
          const c = cathSection(t, { plume: { cols: ['white', 'yellow'], k: 1, rate: 1, jet: 2, life: 3.6 } });
          px.alpha = 1;
          const x = c.sec.X(c.tip[0]), y = c.sec.Y(c.tip[1]);
          if (t > 3) api.mark([x - 6, y - 16, Math.min(px.W - x, 110), 32], 'yellow', t);
          api.keepOut([x - 8, y - 18, Math.min(px.W - x, 114), 36]);
        }
        if (t >= 8.6) {
          // the cell scale: the contrast's front arriving fastest mid-stream (laminar flow)
          px.alpha = span(t, 8.6, 9.4);
          px.rect(0, 0, px.W, px.H, 'ink');
          const front = (y) => lerp(-30, px.W + 40, span(t, 9.4, 13)) - (Math.abs(y - px.H / 2) / px.H) * 60;
          bloodField(px, t, { contrast: 1, contrastFront: front, v: 46, seed: 13 });
          px.alpha = 1;
          if (t > 10) {
            const cx = Math.min(px.W - 30, Math.max(30, front(px.H / 2) - 30)), cy = px.H / 2;
            api.mark([cx - 22, cy - 18, 44, 36], 'yellow', t);
          }
        }
      },
      caption: [
        { from: 3, to: 8.6, text: 'Out of the tip a jet of contrast, many times denser than blood to x-rays, mixing as it goes and carried to the heart, the lungs, and on to the arteries the scan is timed for.' },
        { from: 10, to: 17, text: 'Up close: the iodine-rich molecules dissolve in the <b>plasma</b>, between the cells, not in them. That plasma is what lights up white on the scan.' },
      ],
    },
  ];
  void dimLine; void clamp01; void setOpacity; void Pn; void recAt;
  return { title: 'Secured and used', steps };
}
