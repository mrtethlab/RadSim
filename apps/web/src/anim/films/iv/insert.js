/* IV FILM, chapter 3: in. The closed catheter and its parts; the seal broken, the skin anchored,
   the needle lined up; through the skin and the vein's wall (the engine's record: the tenting, the
   pop); the flashback; the angle lowered and the last 2 mm that bring the catheter's tip in;
   threading; the needle out into its shield and the sharps container; the clamp, the port, the
   tourniquet off. Every needle here, 3D or 8-bit, is where the app's engine had it. */
import * as THREE from 'three';
import { Section, dimLine } from './px.js';
import { at as recAt } from './engine.js';
import { v3 } from './arm.js';
import { shots } from './shots.js';
import { setOpacity } from '../../kit/stage.js';

const D = Math.PI / 180;

export async function insertion(api, S) {
  const { px, sfx, span, lerp, clamp01 } = api;
  const C = shots(api, S), R3 = S.R3, G = S.G, F = S.F, mk = S.mark;
  const R = S.ins, ev = R.ev, Pn = R.P.needle;
  const At = v3.norm(v3.sub(G.Ax, v3.mul(F.n, v3.dot(G.Ax, F.n))));
  const fromMark = (da, dl) => [mk.a + da * mk.tan[0] - dl * mk.tan[1], mk.l + da * mk.tan[1] + dl * mk.tan[0]];
  const first = R.rec[0], last = R.rec[R.rec.length - 1];
  const lineFull = { ...last, line: 1 };

  // every step starts with the kit solid, the pack sealed, the needle in place
  S.resetHooks.push(() => {
    setOpacity(R3.cathM, 1);
    R3.housing.children.forEach((o) => { if (o !== R3.flashFill && !R3.hands.includes(o)) setOpacity(o, 1); });
    R3.setLid(0);
    sfx.stop('tent');
  });
  // ---- the band, tied, in every step until it comes off
  const bandOn = (on) => { S.band.visible = on; if (on) { S.band.scale.setScalar(1); S.band.position.set(0, 0, 0); setOpacity(S.band, 1); } };
  // the left hand across the forearm below the site, palm down, fingers over its far side, the
  // thumb along the skin toward the site, its pad 3 cm below it, pulling the skin toward the hand
  function traction(on, pull = 1) {
    const H = S.hands.left; H.group.visible = on;
    if (!on) return;
    H.pose({ f: [[35, 45, 25], [38, 48, 25], [42, 50, 28], [45, 52, 28]], thumb: [80, 5, 5], spread: 3 });
    const [a, l] = fromMark(-3 - 0.4 * pull, 0);
    const w = G.worldAt(a, l), n = G.normalAt(a, l);
    H.place(4, v3.add(w, v3.mul(n, 0.7)), v3.norm(v3.sub(v3.mul(C.Sd, -0.9), v3.mul(n, 0.35))), v3.norm(v3.add(v3.mul(n, 0.9), v3.mul(C.Sd, -0.35))));
  }
  // the right hand on the needle's grip, index on the push tab, the thumb on its side
  function grip(on) {
    const H = S.hands.right; H.group.visible = on;
    if (!on) return;
    H.pose({ f: [[8, 12, 6], [30, 45, 30], [55, 70, 40], [60, 70, 40]], thumb: [45, 15, 15], spread: 1 });
    R3.kit.updateMatrixWorld(true);
    const p = new THREE.Vector3(-1.9, 0.42, 0).applyMatrix4(R3.housing.matrixWorld);
    const e = R3.kit.matrixWorld.elements, kx = [e[0], e[1], e[2]], ky = [e[4], e[5], e[6]];
    H.place(0, [p.x, p.y, p.z], v3.norm(v3.add(kx, v3.mul(ky, -0.25))), v3.norm(v3.add(ky, v3.mul(kx, 0.25))));
  }

  // ================================================================ the section (engine frame)
  /* The vein, the skin, the needle and the catheter in long section, as the engine had them at
     the record's state st. k px a mm; u0, z0 the corner. */
  function insSection(t, st, { k, u0, z0, flashFill = null, cath = true, needle = true } = {}) {
    const sec = new Section(px, { k, u0, z0 });
    sec.tissue(t, { fatBottom: 15 });
    const r = R.r, b = r * (1 - st.flat), top = st.cz - b;
    const contact = !st.front && st.tip[2] >= top - 0.05 && st.s > 0;
    const tipU = st.tip[0];
    const tent = contact ? (u) => Math.max(0, st.tip[2] - top) * Math.exp(-(((u - tipU) / 2.5) ** 2)) : null;
    sec.vessel(t, { cz: st.cz, b, w: Pn ? 0.4 : 0.4, tent, v: 4, seed: 21 });
    const p = st.pitch * D, d = [Math.cos(p), Math.sin(p)];
    const tip = [st.tip[0], st.tip[2]];
    if (needle && !st.shielded) {
      const N = [tip[0] - (st.withdrawn || 0) * d[0], tip[1] - (st.withdrawn || 0) * d[1]];
      sec.needle(t, { tip: N, pitch: st.pitch, bevel: 1.2, len: 45, lumenFill: flashFill ?? (st.flash > 0 ? 0.25 + 0.75 * st.flash : 0) });
    }
    // the catheter over it: on the shaft to 1.5 mm behind the bevel; threaded, on along the vein
    if (cath) {
      const base = [tip[0] - Pn.bevelToCathMM * d[0], tip[1] - Pn.bevelToCathMM * d[1]];
      const back = [base[0] - 40 * d[0], base[1] - 40 * d[1]];
      const path = st.thread > 0 ? [[st.cath[0], st.cath[2]], base, back] : [base, back];
      if (st.withdrawn > Pn.bevelToCathMM && st.thread > 0) {
        // the needle gone back: the catheter, unsupported, lies along the vein's floor of its own accord
        const sag = clamp01((st.withdrawn - Pn.bevelToCathMM) / 5);
        path[0] = [st.cath[0], st.cath[2] + sag * 1.2]; path[1] = [base[0], base[1] + sag * 0.8];
      }
      sec.catheter(path, { od: 1.1, a: 0.85 });
    }
    return { sec, tip, d, top, contact };
  }
  // the engine's state at record time rt, and the record time for a step's t (slowed `slow` times)
  const recT = (t, t0, a, slow) => a + Math.max(0, t - t0) / slow;
  // a small readout: the angle, top right, in a panel kept clear of
  function angleBox(st, ok) {
    const w = 40, h = 16, x = px.W - w - 6, y = 6;
    px.rect(x, y, w, h, 'ink', 0.9); px.frame(x, y, w, h, 'dkgrey');
    px.text(Math.round(st.pitch) + '°', x + w / 2, y + 6, ok ? 'lime' : 'yellow', 1, 1, 'center');
    api.keepOut([x, y, w, h]);
  }

  // ================================================================ the steps
  const atSite = (st) => ({ fill: 1, mark: { a: mk.a, l: mk.l }, wet: 0.12, wetR: 2.5 });
  const steps = [
    {
      title: 'The closed catheter', dur: 17, fadeIn: 0.4, scale: '1 cm',
      enter() {
        S.reset(); S.supplies(1); bandOn(true); S.painter.paint(atSite());
        R3.prep.pack.group.visible = true; R3.setLid(1);
        S.placeKitInPack(7, 0, { sheath: false });
      },
      cam(t) {
        R3.kit.updateMatrixWorld(true);
        const c = new THREE.Vector3(-2.6, 0, -0.6).applyMatrix4(R3.kit.matrixWorld);
        const e = R3.kit.matrixWorld.elements, kz = [e[8], e[9], e[10]];
        const dist = lerp(15, 9, span(t, 0, 4));
        return { pos: v3.add([c.x, c.y, c.z], v3.add(v3.mul(kz, dist), [0, dist * 0.55, 0])), look: [c.x, c.y, c.z], fov: 34 };
      },
      frame(t) {
        // see-through where the parts nest: the catheter on the needle, the needle in its grip
        setOpacity(R3.cathM, 1 - 0.35 * span(t, 1, 2));
        R3.housing.children.forEach((o) => { if (o !== R3.flashFill && !R3.hands.includes(o)) setOpacity(o, 1 - 0.6 * span(t, 4, 5) * (1 - span(t, 12, 13))); });
        const kitPt = (x, y = 0, z = 0) => { const v = new THREE.Vector3(x, y, z).applyMatrix4(R3.kit.matrixWorld); return [v.x, v.y, v.z]; };
        if (t > 1 && t < 4.5) C.markPts([kitPt(0.05), kitPt(-0.5, 0.12), kitPt(-0.5, -0.12)], 'yellow', t, 3);
        if (t > 4.5 && t < 8.5) { api.mark(R3.hub, 'yellow', t); api.mark(R3.housing.children[0], 'red', t); }
        if (t > 8.5 && t < 13) { api.mark(R3.clampM, 'cyan', t); api.mark(R3.port, 'cyan', t); }
        if (t > 13) api.mark(R3.housing, 'yellow', t);
      },
      caption: [
        { from: 1, to: 4.5, text: '<b>Catheter over needle</b>: a steel needle, its tip cut to a bevel, inside a soft plastic catheter that ends 1.5 mm behind the point.' },
        { from: 4.5, to: 8.5, text: 'The hub with its wings, pink for 20 G; behind, the needle’s grip with its clear <b>flash chamber</b>, where blood will show.' },
        { from: 8.5, to: 13, text: 'A <b>closed system</b>: blood can only reach the extension set, with its own clamp and a capped port. Nothing spills when the needle comes out.' },
        { from: 13, to: 17, text: 'The needle comes out backward into the grip, and a <b>safety shield</b> closes over its point.' },
      ],
    },
    {
      title: 'Seal, anchor, line up', dur: 16, scale: '1 cm',
      enter() { S.reset(); S.supplies(1); bandOn(true); S.painter.paint(atSite()); R3.setLid(1); },
      cam(t) {
        if (t < 5.5) {
          R3.kit.updateMatrixWorld(true);
          const c = new THREE.Vector3(-2.4, 0, 0).applyMatrix4(R3.kit.matrixWorld);
          const e = R3.kit.matrixWorld.elements, kz = [e[8], e[9], e[10]];
          return { pos: v3.add([c.x, c.y, c.z], v3.add(v3.mul(kz, 11), [0, 6, 0])), look: [c.x, c.y, c.z], fov: 34 };
        }
        const k = span(t, 5.5, 8);
        const a = C.side(52, 40, -2, 34), b = C.side(38, 44, -1.5, 34);
        return { pos: v3.add(a[0], v3.mul(v3.sub(b[0], a[0]), k)), look: v3.add(a[1], v3.mul(v3.sub(b[1], a[1]), k)), fov: 34 };
      },
      cues: [[1.8, () => sfx.click()], [3.2, () => sfx.click()]],
      frame(t) {
        if (t < 5.5) {
          // the seal: a millimetre off and back, the app's own pinching fingers on hub and grip
          const slide = 1.6 * Math.sin(Math.PI * span(t, 1, 3.4, api.ease.linear));
          S.placeKitInPack(7, slide, { sheath: false, hands: true });
          traction(false); grip(false);
          if (t > 1) api.mark(R3.hub, 'yellow', t);
          return;
        }
        // at the site: poised over the mark along the vein, bevel up, at 25°
        S.placeKit(first, { lift: lerp(1.2, 0.15, span(t, 6, 9)) });
        traction(t > 7.5, span(t, 7.5, 9));
        grip(false);
        if (t > 9 && t < 12.5) { const p = S.hands.left.tip(4).getWorldPosition(new THREE.Vector3()); C.markPts([[p.x - 1.2, p.y - 0.6, p.z - 1.2], [p.x + 1.2, p.y + 0.8, p.z + 1.2]], 'cyan', t); }
        if (t > 12.5) api.mark(R3.needle, 'yellow', t, { live: true });
      },
      caption: [
        { from: 1, to: 5.5, text: 'Break the <b>seal</b>: the catheter slid a millimetre off the needle and back, so it will slide freely later.' },
        { from: 9, to: 12.5, text: 'The other hand’s thumb pulls the skin taut toward the hand, 3 cm below the site: it <b>anchors</b> the vein, which would otherwise roll away.' },
        { from: 12.5, to: 16, text: 'The needle lined up along the vein, <b>bevel up</b>, at 15–30° to the skin: 25° here.' },
      ],
    },
    {
      title: 'Through the skin', dur: 18, scale: (t) => (t < 6 ? '1 cm' : '1 mm'),
      enter() { S.reset(); S.supplies(1); bandOn(true); S.painter.paint(atSite()); for (const [id, m] of Object.entries(S.tubes)) m.visible = id === 'medianCubital'; },
      cam: [[0, ...C.side(26, 20, -1, 34)], [5, ...C.side(16, 12, 0, 32)], [6.2, ...C.side(5, 6, 0.6, 30)]],
      cues: [[2.6, () => sfx.tick()], [10.6, () => sfx.pew(900)]],
      frame(t) {
        // 3D: in at 6 mm/s from the record (its 0.5-2.35 s), slowed by 2
        const rt3 = recT(t, 1, 0.5, 2), st3 = recAt(R, Math.min(rt3, ev.lumen + 0.1));
        S.placeKit(st3);
        S.cutaway(span(t, 0, 1.5) * 0.7);
        traction(false); grip(false);
        if (t > 1 && t < 5.5) api.mark(R3.needle, 'yellow', t, { live: true });
        api.mosaic(span(t, 5, 6.2));
        if (t > 6) {
          // 8-bit: the same 2 s again, slowed 4 times
          px.alpha = span(t, 6, 6.6);
          const rt = recT(t, 6.6, 0.5 + 0.55, 3.6), st = recAt(R, Math.min(rt, ev.lumen + 0.35));
          const k = Math.min(11, (px.W - 8) / 22, (px.H - 8) / 15);
          const s = insSection(t, st, { k, u0: st.tip[0] - (px.W / k) * 0.62, z0: -4.2 });
          px.alpha = 1;
          const tx = s.sec.X(s.tip[0]), ty = s.sec.Y(s.tip[1]);
          if (t > 6.6) api.mark([tx - 18, ty - 16, 36, 32], st.front ? 'lime' : 'yellow', t);
          api.keepOut([tx - 22, ty - 20, 44, 40]);
          if (s.contact && st.indent > 0.25) sfx.hold('tent', 90 + st.indent * 120, 0.03, 'triangle'); else sfx.stop('tent');
        }
      },
      caption: [
        { from: 1, to: 5.5, text: 'In through the skin in one smooth push, toward the vein along its line.' },
        { from: 6.8, to: 10.6, text: 'Through the skin and the fat, the bevel meets the vein’s wall and pushes it in ahead of it (<b>tenting</b>); the vein is pressed down.' },
        { from: 10.6, to: 18, text: 'It gives: the bevel is <b>in the lumen</b>. The tip lies just under the top wall, the far wall a few millimetres on.' },
      ],
    },
    {
      title: 'Flashback', dur: 15, scale: (t) => (t < 6.5 ? '1 cm' : '1 mm'),
      enter() { S.reset(); S.supplies(1); bandOn(true); S.painter.paint(atSite()); for (const [id, m] of Object.entries(S.tubes)) m.visible = id === 'medianCubital'; },
      cam(t) {
        R3.kit.updateMatrixWorld(true);
        const c = new THREE.Vector3(-3.2, 0.1, 0).applyMatrix4(R3.kit.matrixWorld), cc = [c.x, c.y, c.z];
        const d = lerp(9, 4.5, span(t, 0, 3));
        return { pos: v3.add(cc, v3.add(v3.mul(C.Sd, d), v3.mul(F.n, d * 0.45))), look: cc, fov: 32 };
      },
      cues: [[1.4, () => sfx.blip(520)]],
      frame(t) {
        // the record from the moment the bevel entered: the chamber fills over a second
        const rt = recT(t, 0.8, ev.lumen - 0.1, 1.2), st = recAt(R, Math.min(rt, ev.lowerStart - 0.05));
        S.placeKit(st);
        S.cutaway(0.5);
        if (t > 1.2 && t < 6) api.mark(R3.housing.children[0], 'red', t);
        api.mosaic(span(t, 5.4, 6.6));
        if (t > 6.4) {
          px.alpha = span(t, 6.4, 7);
          // the bevel in the lumen, close: blood into the opening and up the needle
          const st2 = recAt(R, ev.lumen + 0.6);
          const k = Math.min(26, (px.W - 8) / 9, (px.H - 8) / 7);
          const s = insSection(t, st2, { k, u0: st2.tip[0] - (px.W / k) * 0.6, z0: st2.tip[2] - (px.H / k) * 0.5, flashFill: 0.2 + 0.8 * span(t, 6.8, 9.5) });
          // cells drawn in through the bevel's mouth
          for (let i = 0; i < 26; i++) {
            const ph = ((t * 0.9 + i / 26) % 1), u = s.tip[0] + 1.6 - ph * 2.2, z = s.tip[1] + 0.9 - ph * 1.0 + Math.sin(i * 2.3) * 0.25;
            if (ph < 0.75) px.rect(s.sec.X(u), s.sec.Y(z), 2, 2, i % 3 ? 'red' : 'plum', 0.95);
          }
          px.alpha = 1;
          const bx = s.sec.X(s.tip[0] - 2.2), by = s.sec.Y(s.tip[1] - 1.6);
          if (t > 7) api.mark([bx, by, s.sec.X(s.tip[0] + 0.6) - bx, s.sec.Y(s.tip[1] + 1.1) - by], 'yellow', t);
          if (t > 11) {
            const cb = [s.tip[0] - Pn.bevelToCathMM * s.d[0], s.tip[1] - Pn.bevelToCathMM * s.d[1]];
            dimLine(px, s.sec.X(cb[0]), s.sec.Y(cb[1]) + 10, s.sec.X(s.tip[0]), s.sec.Y(s.tip[1]) + 10, '1.5 mm', 'yellow');
          }
        }
      },
      caption: [
        { from: 1.2, to: 6, text: 'Blood, under the tourniquet’s pressure, runs back up the needle into the <b>flash chamber</b>: the bevel is in the vein.' },
        { from: 7, to: 11, text: 'At the bevel’s mouth: blood drawn in and up the needle’s hollow core.' },
        { from: 11, to: 15, text: 'But only the bevel is in. The catheter’s tip, <b>1.5 mm</b> behind, is still in the wall: thread now and it buckles against it.' },
      ],
    },
    {
      title: 'Lower and advance', dur: 15, view: 'pixel', scale: '1 mm',
      cues: [[8.4, () => sfx.blip(880)]],
      frame(t) {
        // the record from just before the angle came down (3.2 s) to the catheter's tip in (5.0 s)
        const rt = recT(t, 1, ev.lowerStart - 0.1, 3.4), st = recAt(R, Math.min(rt, ev.cathIn));
        const k = Math.min(13, (px.W - 8) / 16, (px.H - 8) / 12);
        const s = insSection(t, st, { k, u0: 1.5, z0: -1.6 });
        angleBox(st, st.pitch <= R.P.angles.lowerMax);
        const cb = [s.tip[0] - Pn.bevelToCathMM * s.d[0], s.tip[1] - Pn.bevelToCathMM * s.d[1]];
        const bx = s.sec.X(cb[0]), by = s.sec.Y(cb[1]);
        if (t < 6.5) api.mark([s.sec.X(s.tip[0]) - 14, s.sec.Y(s.tip[1]) - 10, 28, 20], 'yellow', t);
        else api.mark([bx - 10, by - 10, 20, 20], st.cathAt === 'lumen' ? 'lime' : 'yellow', t);
        api.keepOut([s.sec.X(s.tip[0] - 3), s.sec.Y(s.tip[1] - 2), 4 * k, 3 * k]);
      },
      caption: [
        { from: 1, to: 6.5, text: 'The needle <b>lowered</b> almost flat, 15° or less, pivoting about its tip: now it points along the lumen, not across it.' },
        { from: 6.5, to: 15, text: 'Then on <b>2 mm</b> more: the catheter’s tip follows the bevel through the hole in the wall and into the lumen.' },
      ],
    },
    {
      title: 'Thread the catheter', dur: 15, scale: (t) => (t < 7 ? '1 cm' : '1 mm'),
      enter() { S.reset(); S.supplies(1); bandOn(true); S.painter.paint(atSite()); for (const [id, m] of Object.entries(S.tubes)) m.visible = id === 'medianCubital'; },
      cam: [[0, ...C.side(16, 38, 0, 32)], [6.5, ...C.side(12, 30, 0.6, 32)]],
      cues: [[1.4, () => sfx.tick()], [2.0, () => sfx.tick()], [2.6, () => sfx.tick()], [3.2, () => sfx.tick()], [4.4, () => sfx.click()]],
      frame(t) {
        const rt = recT(t, 1, ev.threadStart - 0.1, 1.0), st = recAt(R, Math.min(rt, ev.hubbed + 0.2));
        S.placeKit(st);
        S.cutaway(0.65);
        traction(false); grip(false);
        if (t > 1 && t < 6.8) api.mark(R3.cathM, 'yellow', t, { live: true });
        api.mosaic(span(t, 6.4, 7.4));
        if (t > 7.2) {
          px.alpha = span(t, 7.2, 7.8);
          const rt2 = recT(t, 7.6, ev.threadStart - 0.1, 1.6), st2 = recAt(R, Math.min(rt2, ev.hubbed + 0.2));
          const k = Math.min(9, (px.W - 8) / 30, (px.H - 8) / 16);
          const s = insSection(t, st2, { k, u0: st2.tip[0] - (px.W / k) * 0.42, z0: -3 });
          px.alpha = 1;
          const ct = [st2.cath[0], st2.cath[2]];
          api.mark([s.sec.X(ct[0]) - 12, s.sec.Y(ct[1]) - 12, 24, 24], 'yellow', t);
          api.keepOut([s.sec.X(s.tip[0] - 2), s.sec.Y(ct[1] - 2.5), (ct[0] - s.tip[0] + 5) * k, 5 * k]);
        }
      },
      caption: [
        { from: 1, to: 6.8, text: 'The needle held still; the catheter pushed off it, into the vein, all the way to its hub: <b>threading</b>.' },
        { from: 7.6, to: 15, text: 'Flat, at 10° or less, it runs on down the lumen ahead of the needle’s point; steep, it would catch on the back wall.' },
      ],
    },
    {
      title: 'Needle out', dur: 16, scale: '1 cm',
      enter() {
        S.reset(); S.supplies(1); bandOn(true); S.painter.paint(atSite());
        R3.prep.sharps.trayPivot.rotation.x = 0;
      },
      cam(t) {
        if (t < 8) { const c = C.side(22, 42, -2.5, 34); return { pos: c[0], look: c[1], fov: 34 }; }
        const S0 = R3.prep, c = S.prepPoint([-10, 11, -7 + 1]);
        void S0;
        return { pos: v3.add(c, v3.add([0, 18, 0], v3.mul(R3.prep.Z, 22))), look: c, fov: 36 };
      },
      cues: [[5.2, () => sfx.click()], [12.2, () => sfx.click()], [13.6, () => sfx.thud()]],
      frame(t) {
        const rt = recT(t, 1, ev.withdrawStart - 0.1, 2.4), st = recAt(R, Math.min(rt, ev.out + 0.3));
        S.placeKit(st);
        traction(false); grip(false);
        // the spent needle with its shield closed, in hand over the sharps container, laid on the
        // tray, the tray flipped, dropped in (iv.js placeSpent)
        const sp = R3.prep.spent;
        sp.visible = t > 8 && t < 14.4;
        if (sp.visible) {
          const SH = [-10, 0, -7], hinge = [SH[0], 10.55, SH[2] - 2.4];
          const th = 1.9 * span(t, 11.6, 12.6);
          R3.prep.sharps.trayPivot.rotation.x = -th;
          const onTray = (a) => [hinge[0], hinge[1] + 0.45 * Math.cos(a) + 2.7 * Math.sin(a), hinge[2] + 2.7 * Math.cos(a) - 0.45 * Math.sin(a)];
          const held = [SH[0], 15.5, SH[2] + 1.0], u = span(t, 9.5, 11);
          let p, up = [0, 1, 0];
          if (t > 12.3) { const f = span(t, 12.6, 13.6); p = [hinge[0], hinge[1] + 0.6 - 9 * f, hinge[2] + 1.6]; }
          else { const q = onTray(th); p = [held[0] + (q[0] - held[0]) * u, held[1] + (q[1] - held[1]) * u, held[2] + (q[2] - held[2]) * u]; up = [0, Math.cos(th * u), -Math.sin(th * u)]; }
          const x = new THREE.Vector3(1, 0, 0), z = new THREE.Vector3().crossVectors(x, new THREE.Vector3(...up)).normalize(), y = new THREE.Vector3().crossVectors(z, x);
          sp.matrix.makeBasis(x, y, z); sp.matrix.setPosition(...p); sp.matrixAutoUpdate = false; sp.matrixWorldNeedsUpdate = true;
        } else R3.prep.sharps.trayPivot.rotation.x = 0;
        if (t > 1 && t < 8) api.mark(R3.needle.visible ? R3.housing : R3.hub, 'yellow', t, { live: true });
        if (t > 8.5) api.mark(R3.prep.sharps.group, 'yellow', t);
      },
      caption: [
        { from: 1, to: 8, text: 'The needle drawn back out through the catheter, which stays; at its end the <b>shield</b> closes over the point. Blood fills the extension set.' },
        { from: 8.5, to: 16, text: 'Straight into the <b>sharps container</b>: never recapped, never put down.' },
      ],
    },
    {
      title: 'Clamp, port, tourniquet off', dur: 15, scale: '1 cm',
      enter() { S.reset(); S.supplies(1); bandOn(true); },
      cam: [[0, ...C.side(15, 42, -3.6, 34)], [7.6, ...C.side(15, 42, -3.6, 34)], [10.4, ...C.side(46, 34, 2, 36)]],
      cues: [[2, () => sfx.click()], [5.4, () => sfx.click()], [8.5, () => sfx.down()]],
      frame(t) {
        S.placeKit(lineFull, { clampOpen: t < 2, portCap: t < 5.4 });
        const off = span(t, 8.4, 9);
        S.band.visible = off < 1; if (off > 0) setOpacity(S.band, 1 - off);
        S.painter.paint({ ...atSite(), fill: 1 - span(t, 8.6, 14) });
        if (t > 1 && t < 4.8) api.mark(R3.clampM, 'yellow', t);
        if (t > 4.8 && t < 8.2) api.mark(R3.port, 'yellow', t);
        if (t > 8.2 && t < 10) api.mark(S.band, 'orange', t);
        if (t > 10) C.markRegion(G, [[-4, 3], [3, 3], [-4, -3], [3, -3]], 'cyan', t);
      },
      caption: [
        { from: 1, to: 4.8, text: 'The <b>clamp</b> on the extension set closed first, before the system is opened.' },
        { from: 4.8, to: 8.2, text: 'The cap off the port, where the flush goes on: with the clamp shut, no blood comes out.' },
        { from: 8.2, to: 15, text: 'The <b>tourniquet released</b>: the veins drain and soften, the pressure in them falls back.' },
      ],
    },
  ];
  void lerp;
  return { title: 'In', steps };
}
