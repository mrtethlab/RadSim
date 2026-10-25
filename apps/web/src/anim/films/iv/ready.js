/* IV FILM, chapter 2: getting ready. Hands, gloves and the right patient; the supplies laid out;
   the tourniquet and why the veins fill under it (the artery still flowing, the veins shut);
   feeling for a bouncy vein; choosing a straight stretch clear of valves; the antiseptic scrub,
   and on the skin: the bacteria it kills, and the drying. */
import * as THREE from 'three';
import { Section, skinSurface, SPR, dimLine } from './px.js';
import { v3 } from './arm.js';
import { shots } from './shots.js';
import { setOpacity } from '../../kit/stage.js';

export async function getReady(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const C = shots(api, S), R3 = S.R3, G = S.G, F = S.F;
  const mk = S.mark;
  const At = v3.norm(v3.sub(G.Ax, v3.mul(F.n, v3.dot(G.Ax, F.n))));     // the limb's axis on the skin
  const site = S.siteW;

  // the tourniquet tightening: the ring drawn in to the skin about the limb's axis
  const bandC = G.toWorld(G.centre(G.site.tourniquetAlongCm));
  const tighten = (k) => {
    const s = 1 + 0.14 * (1 - k);
    S.band.scale.setScalar(s);
    S.band.position.set(bandC[0] * (1 - s), bandC[1] * (1 - s), bandC[2] * (1 - s));
  };
  // the fingertip's rebound under palpation: a soft ring on the skin (iv.js spawnRing)
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.42, 40), new THREE.MeshBasicMaterial({ color: 0xdfe9ff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  ring.renderOrder = 20; S.room.add(ring); ring.visible = false;
  S.resetHooks.push(() => { ring.visible = false; });
  const onSkinAt = (a, l, lift = 0) => { const w = G.worldAt(a, l), n = G.normalAt(a, l); return [v3.add(w, v3.mul(n, lift)), n]; };
  // a point on the skin at (da along the vein, dl across it) cm from the mark
  const fromMark = (da, dl) => [mk.a + da * mk.tan[0] - dl * mk.tan[1], mk.l + da * mk.tan[1] + dl * mk.tan[0]];

  // the right hand, two fingertips on the vein, pressing in and letting go
  function palpate(t, { a = mk.a, l = mk.l, press = 0 } = {}) {
    const H = S.hands.right; H.group.visible = true;
    H.pose({ f: [[18, 22, 12], [16, 20, 10], [50, 70, 40], [55, 75, 40]], thumb: [20, 30, 30], spread: 4 });
    const [p, n] = onSkinAt(a, l, 0.35 - 0.3 * press);
    const fwd = v3.norm(v3.sub(v3.mul(At, 0.75), v3.mul(n, 0.66)));
    H.place(0, p, fwd, v3.norm(v3.add(v3.mul(n, 0.75), v3.mul(At, 0.66))));
  }

  // ================================================================ 8-bit scenes
  /* Under the tourniquet, along the arm (the heart to the right): the band; the vein under it
     squeezed flat, the artery under it open; the arterial blood arriving from the right, the
     venous blood trapped on the left, swelling the vein. k 0..1 the band's tightening. */
  function tqScene(t, k, fillK) {
    px.fillAll('ink');
    const W = px.W, H = px.H, kk = (H - 16) / 32;                      // px per mm
    const sec = new Section(px, { k: kk, u0: 0, z0: -6 });
    const bw = Math.min(25, (sec.u1 - sec.u0) * 0.42), bandU = sec.u1 - 3 - bw / 2;
    const d0 = bandU - bw / 2, d1 = bandU + bw / 2;
    // the band squeezes the skin in under it
    const sq = (u) => -k * 2.6 * Math.exp(-(((u - bandU) / (bw * 0.55)) ** 6));
    sec.tissue(t, { fatBottom: 10.5, bulge: sq, dermis: 1.3 });
    // the vein: distal of the band it swells with fillK, under the band it is flat
    const rV = (u) => {
      const sw = 2.2 * (1 + 0.5 * fillK), fl = 2.2 * Math.max(0.1, 1 - k * 0.93);
      if (u < d0 - 2) return sw;
      if (u < d0 + 2) return sw + (fl - sw) * (u - d0 + 2) / 4;
      if (u < d1 - 2) return fl;
      if (u < d1 + 2) return fl + (2.2 - fl) * (u - d1 + 2) / 4;
      return 2.2;
    };
    const czV = 5.2, czAt = (u) => czV - sq(u) * 0.8;
    for (let x = 0; x < W; x++) {
      const u = sec.U(x), r = rV(u), c = czAt(u);
      px.rect(x, sec.Y(c - r - 0.45), 1, 0.45 * kk + 1, 'plum');
      px.rect(x, sec.Y(c - r), 1, 2 * r * kk, 'dkred', 0.95);
      px.rect(x, sec.Y(c + r), 1, 0.45 * kk + 1, 'plum');
    }
    // the artery, deeper, its thick wall holding it open under the band, pulsing
    const pulse = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 70 / 60), czA = 15, rA = 1.9 * (1 + 0.07 * pulse);
    px.rect(0, sec.Y(czA - rA - 1.0), W, 1.0 * kk, 'pink');
    px.rect(0, sec.Y(czA - rA), W, 2 * rA * kk, 'red');
    px.rect(0, sec.Y(czA + rA), W, 1.0 * kk, 'pink');
    // flow: arterial specks from the heart's side (right) toward the hand, pulsatile; venous
    // specks toward the heart, piling up behind the band as it tightens
    const r = rng(14), Lr = sec.u1 - sec.u0 + 8;
    for (let i = 0; i < 140; i++) {
      const fz = r() * 2 - 1, ph = r() * 200;
      const u = sec.u1 + 4 - (((ph + t * 30 + 4 * Math.sin(t * 7.3)) % Lr + Lr) % Lr);
      px.rect(sec.X(u), sec.Y(czA + fz * rA * 0.85), 2, 1, r() < 0.5 ? 'peach' : 'white', 0.9);
    }
    const vflow = 9 * (1 - k);
    for (let i = 0; i < 260; i++) {
      const fz = r() * 2 - 1, ph = r() * 300;
      let u = sec.u0 - 4 + (((ph + t * vflow) % Lr) + Lr) % Lr;
      if (k > 0.3 && u > d0 - 1 && u < d1 + 1) u = d0 - 1 - (u - d0 + 1) * 0.25;
      px.rect(sec.X(u), sec.Y(czAt(u) + fz * rV(u) * 0.85), 2, 1, r() < 0.55 ? 'red' : 'plum', 0.9);
    }
    // the band itself on the skin
    const by = sec.Y(k * 2.6) - 7;
    px.rect(sec.X(d0), by, bw * kk, 7, 'orange');
    px.rect(sec.X(d0), by + 5, bw * kk, 2, 'brown');
    // the pressures, a meter in the muscle at the bottom left, clear of the vessels
    const mw = 64, mh = 44, mx = 6, my = H - mh - 6;
    px.rect(mx, my, mw, mh, 'ink', 0.92); px.frame(mx, my, mw, mh, 'dkgrey');
    const bar = (i, v, col, lab) => {
      const y = my + 5 + i * 11, L = Math.max(1, Math.round(v / 130 * (mw - 30)));
      px.rect(mx + 4, y, L, 5, col); px.text(lab, mx + mw - 4, y, col, 1, 1, 'right');
    };
    const vp = Math.round(lerp(8, 40, fillK)), bp = Math.round(45 * k);
    bar(0, vp, 'plum', String(vp));
    bar(1, bp, 'orange', String(bp));
    bar(2, 80 + 40 * pulse, 'red', '120/80');
    px.text('mmHg', mx + 4, my + mh - 8, 'mid');
    api.keepOut([mx, my, mw, mh]);
    return {
      band: [sec.X(d0) - 2, by - 2, bw * kk + 4, sec.Y(czA + rA + 1.5) - by + 4],
      vein: [0, sec.Y(czV - 3.6), sec.X(d0) - 2, 7.2 * kk],
      art: [0, sec.Y(czA - rA - 1.4), W, (2 * rA + 2.8) * kk],
    };
  }
  /* Under a fingertip, across the vein: it gives and springs back; the artery beside it pulses. */
  function palpScene(t) {
    px.fillAll('ink');
    const W = px.W, H = px.H, kk = Math.min((W - 16) / 34, (H - 40) / 22);
    const sec = new Section(px, { k: kk, u0: -((W / kk) / 2), z0: -6.5 });
    // the press: down 1.2 s, held, let go (period 3 s)
    const ph = t % 3, press = ph < 0.6 ? span(ph, 0, 0.6) : ph < 1.4 ? 1 : 1 - span(ph, 1.4, 1.8);
    const fx = -3, dent = (u) => press * 2.2 * Math.exp(-(((u - fx) / 3.2) ** 2));
    sec.tissue(t, { fatBottom: 30, bulge: (u) => -dent(u), dermis: 1.2 });
    // the fingertip, gloved, from above
    const fy = sec.Y(dent(fx));
    px.rect(sec.X(fx - 5.5), 0, 11 * kk, fy - 5.5 * kk, 'blue'); px.rect(sec.X(fx - 5.5), 0, 2, fy - 5.5 * kk, 'navy'); px.rect(sec.X(fx + 5.5) - 2, 0, 2, fy - 5.5 * kk, 'navy');
    px.circle(sec.X(fx), fy - 5.5 * kk, 5.5 * kk, 'blue', 1, true);
    px.circle(sec.X(fx), fy - 5.5 * kk, 5.5 * kk, 'navy', 1);
    // the vein under it: flattened by the press, round again as it lifts (refilling)
    const refill = ph > 1.4 ? span(ph, 1.4, 2.2) : 1;
    const flat = press * 0.75 * (ph > 1.4 ? 1 - refill : 1);
    const cz = 3.5 + 0.4 + 3 + dent(fx) * 0.45, a = 3 * (1 + flat * 0.35), b = 3 * (1 - flat);
    const ell = (x0, z0, ra, rb, col) => {
      for (let y = Math.floor(sec.Y(z0 - rb)); y <= sec.Y(z0 + rb); y++) {
        const zz = (sec.Z(y) - z0) / rb, hw = ra * Math.sqrt(Math.max(0, 1 - zz * zz));
        px.rect(sec.X(x0 - hw), y, 2 * hw * kk, 1, col);
      }
    };
    ell(fx, cz, a + 0.45, b + 0.45, 'plum'); ell(fx, cz, a, Math.max(0.15, b), 'dkred');
    // the artery, deeper and to the side: its pulse lifts the tissue over it
    const pulse = Math.max(0, Math.sin(t * 2 * Math.PI * 70 / 60)) ** 3;
    ell(fx + 9, 12, 2.4 + 0.25 * pulse, 2.4 + 0.25 * pulse, 'pink'); ell(fx + 9, 12, 1.7 + 0.25 * pulse, 1.7 + 0.25 * pulse, 'red');
    return { vein: [sec.X(fx - 4), sec.Y(cz - 4), 8 * kk, 8 * kk], art: [sec.X(fx + 6), sec.Y(9), 6 * kk, 6 * kk], press };
  }

  // ================================================================ the steps
  const markOn = (k) => ({ fill: 1, mark: { a: mk.a, l: mk.l }, markA: k });
  const steps = [
    {
      title: 'Hands, gloves, patient', dur: 13, fadeIn: 0.5, scale: '10 cm',
      enter() { S.reset(); S.painter.paint({ fill: 0, mark: null }); },
      cam: [[0, ...C.side(85, 34, -8, 38)], [13, ...C.side(75, 30, -8, 38)]],
      frame(t) {
        // the two gloved hands, held up clear of everything (clean hands touch nothing on the way)
        for (const [key, sd] of [['left', -1], ['right', 1]]) {
          const H = S.hands[key]; H.group.visible = true;
          H.pose({ f: [[15, 20, 10], [15, 20, 10], [18, 22, 10], [20, 25, 10]], thumb: [30, 15, 10], spread: 3 });
          const rub = Math.sin(t * 3 + sd) * 0.8 * (1 - span(t, 4, 5));
          const at = v3.add(C.at(-10 + sd * 7, -6), v3.mul(F.n, 16 + rub));
          H.place(1, at, v3.norm(v3.add(v3.mul(F.n, 0.85), v3.mul(At, 0.3 * sd))), v3.norm(v3.mul(C.Sd, -1)));
        }
        if (t > 1 && t < 6.5) api.mark(S.hands.right.group, 'cyan', t);
        if (t > 6.5) C.markRegion(G, [[-6, 4], [6, 4], [-6, -4], [6, -4]], 'yellow', t);
      },
      caption: [
        { from: 1, to: 6.5, text: '<b>Hand hygiene</b>, then clean gloves. A peripheral IV is a clean, not sterile, procedure: nothing that touches the site is touched again.' },
        { from: 6.5, to: 13, text: 'The <b>right patient</b> (two identifiers against the order), and asked about allergies: contrast, latex, chlorhexidine. Then the arm, palm up, on its board.' },
      ],
    },
    {
      title: 'The supplies', dur: 14, scale: '10 cm',
      enter() { S.reset(); S.painter.paint({ fill: 0, mark: null }); S.placeKitInPack(0, 0, { sheath: true }); },
      cam: [[0, ...prepCam(62, 0)], [14, ...prepCam(56, 2)]],
      frame(t) {
        const items = [R3.prep.sup.tq, R3.prep.swab.group, R3.prep.pack.group, R3.prep.flush.group, R3.prep.sup.tega, R3.prep.sup.capIn, R3.prep.sup.gz, R3.prep.sharps.group];
        const i = Math.min(items.length - 1, Math.floor(Math.max(0, t - 1) / 1.5));
        if (t > 1) api.mark(items[i], 'yellow', t);
      },
      cues: Array.from({ length: 8 }, (_, i) => [1 + i * 1.5, () => sfx.tick()]),
      caption: [{ from: 1, to: 14, text: 'Laid out first: a <b>tourniquet</b>, an antiseptic swab, the IV catheter in its pack, a 10 mL saline flush, a film dressing, a cap, gauze, and the <b>sharps container</b> within reach.' }],
    },
    {
      title: 'The tourniquet', dur: 14, scale: '10 cm',
      enter() { S.reset(); S.supplies(1); S.band.visible = true; S.painter.paint({ fill: 0, mark: null }); },
      cam: [[0, ...C.side(46, 32, 3, 38)], [14, ...C.side(40, 36, 1, 38)]],
      cues: [[1.1, () => sfx.click()]],
      frame(t) {
        const k = span(t, 0.4, 1.4);
        setOpacity(S.band, k > 0 ? 1 : 0); tighten(k);
        const fill = span(t, 2.5, 12, api.ease.out);
        S.painter.paint({ fill, mark: null });
        if (t > 1 && t < 6.5) api.mark(S.band, 'orange', t);
        if (t > 6.5) C.markRegion(G, [[-5, 3.5], [3, 3.5], [-5, -3.5], [3, -3.5]], 'cyan', t);
      },
      caption: [
        { from: 1, to: 6.5, text: 'A <b>tourniquet</b> above the elbow, here 9 cm up, snug enough to stop the veins draining but not the artery: the wrist’s pulse can still be felt.' },
        { from: 6.5, to: 14, text: 'Below it the veins <b>fill</b>, swell and stand up (about half a minute). It comes off within 2 minutes: longer, and the blood stagnates.' },
      ],
    },
    {
      title: 'Why they fill', dur: 14, scale: '1 cm',
      enter() { S.reset(); S.supplies(1); S.band.visible = true; tighten(1); setOpacity(S.band, 1); S.painter.paint({ fill: 1, mark: null }); },
      cam: [[0, ...C.side(36, 10, 9, 36)], [2.4, ...C.side(10, 6, 9, 30)]],
      cues: [[0.3, () => sfx.whoosh()]],
      frame(t) {
        api.mosaic(span(t, 0.8, 2.4));
        if (t > 2.2) {
          px.alpha = span(t, 2.2, 3);
          const k = span(t, 3, 4.5), fillK = span(t, 4.5, 11);
          const b = tqScene(t, k, fillK);
          px.alpha = 1;
          if (t > 3 && t < 8.5) { api.mark(b.art, 'red', t); api.keepOut(b.band); }
          if (t >= 8.5) { api.mark(b.vein, 'yellow', t); api.keepOut(b.band); }
        }
      },
      caption: [
        { from: 3, to: 8.5, text: 'Under the band the soft-walled veins are squeezed flat. The <b>artery</b>, thick-walled and at 80–120 mmHg, stays open: blood keeps arriving from the heart.' },
        { from: 8.5, to: 14, text: 'It cannot get out: the <b>veins below</b> fill, their pressure climbing toward the band’s, and they swell and firm up, easier to feel and to hit.' },
      ],
    },
    {
      title: 'Feel for the vein', dur: 15, scale: (t) => (t < 7.5 ? '1 cm' : '1 cm'),
      enter() { S.reset(); S.supplies(1); S.band.visible = true; tighten(1); setOpacity(S.band, 1); S.painter.paint({ fill: 1, mark: null }); },
      cam: [[0, ...C.side(50, 38, 1, 34)], [7, ...C.side(42, 32, 0.5, 32)]],
      frame(t) {
        const ph = t % 1.6, press = ph < 0.4 ? span(ph, 0, 0.4) : ph < 0.8 ? 1 : 1 - span(ph, 0.8, 1.1);
        // along the vein, a little at a time, toward the mark
        const da = lerp(-1.6, 0, span(t, 0.5, 6));
        const [a, l] = fromMark(da, 0);
        palpate(t, { a, l, press });
        // the rebound under the finger
        const u = ph > 0.8 ? clamp01((ph - 0.8) / 0.5) : 0;
        const [p, n] = onSkinAt(a, l, 0.12);
        ring.visible = u > 0 && u < 1 && t < 7.5;
        ring.position.set(...p); ring.lookAt(...v3.add(p, n));
        ring.material.opacity = Math.sin(Math.PI * u) * 0.5;
        ring.scale.setScalar((0.6 + 0.9 * u - 0.25 * Math.sin(u * Math.PI * 2)) * 1.6);
        if (t > 1 && t < 7) api.mark(S.hands.right.group, 'cyan', t);
        api.mosaic(span(t, 6.8, 7.8));
        if (t > 7.6) {
          px.alpha = span(t, 7.6, 8.3);
          const b = palpScene(t);
          px.alpha = 1;
          if (t < 11.5) api.mark(b.vein, 'yellow', t); else api.mark(b.art, 'red', t);
        }
      },
      caption: [
        { from: 1, to: 7, text: 'With the fingertips, along the vein: a good one is <b>bouncy</b>, giving under the press and springing back as it refills.' },
        { from: 8, to: 11.5, text: 'Under the finger it flattens, then fills round again: soft, elastic, full.' },
        { from: 11.5, to: 15, text: 'A <b>pulse</b> is an artery; a hard cord, a tendon or a clotted vein. Neither takes a catheter.' },
      ],
    },
    {
      title: 'Choose the site', dur: 14, scale: '1 cm',
      enter() { S.reset(); api.camera.up.set(...C.topUp()); S.band.visible = true; tighten(1); setOpacity(S.band, 1); },
      cam: [[0, ...C.top(26, 0.5, 0, 34)], [14, ...C.top(22, 0.6, 0, 34)]],
      cues: [[2.2, () => sfx.blip(660)]],
      frame(t) {
        // the catheter's 25 mm laid ahead of the mark along the vein; the cephalic's valve shown
        const k = span(t, 1, 2.2);
        const guide = [];
        for (let i = 0; i <= 10; i++) guide.push(fromMark(i * 0.25, 0));
        S.painter.paint({ ...markOn(span(t, 2, 2.4)), guide, guideA: span(t, 2.6, 3.4) });
        S.cutaway(k * 0.55);
        for (const [id, m] of Object.entries(S.tubes)) m.visible = !['brachialArtery', 'medianNerve'].includes(id);
        if (t > 3 && t < 8.5) C.markRegion(G, guide.filter((_, i) => i % 5 === 0), 'yellow', t);
        const valve = S.valveMeshes.find((m) => m.userData.vein === 'cephalic');
        if (t > 8.5 && valve) api.mark(valve, 'red', t);
      },
      caption: [
        { from: 3, to: 8.5, text: 'Mark the entry where a straight stretch at least the catheter’s length (<b>25 mm</b>) runs on ahead toward the heart, and the vein is at least twice the catheter’s width.' },
        { from: 8.5, to: 14, text: 'Clear of <b>valves</b> (the knots) and of forks where veins join: a catheter that meets either stops.' },
      ],
    },
    {
      title: 'Antisepsis', dur: 14, scale: '1 cm',
      enter() { S.reset(); S.supplies(1); S.band.visible = true; tighten(1); setOpacity(S.band, 1); },
      cam: [[0, ...C.side(48, 52, -1, 34)], [14, ...C.side(42, 56, -0.5, 34)]],
      cues: [[1.2, () => sfx.hiss(0.4, 0.12, 2500)], [3.2, () => sfx.hiss(0.4, 0.12, 2500)], [5.2, () => sfx.hiss(0.4, 0.12, 2500)], [7.2, () => sfx.hiss(0.4, 0.12, 2500)]],
      frame(t) {
        // back-and-forth strokes across the 5 cm circle, row by row, for 9 s
        const s = span(t, 1, 10, api.ease.linear), row = s * 7, ri = Math.floor(row), f = row - ri;
        const dl = lerp(-2.2, 2.2, Math.min(1, ri / 6)), da = (ri % 2 ? 1 - f : f) * 4.4 - 2.2;
        const on = t > 0.8 && t < 10.3;
        const [a, l] = fromMark(da * Math.sqrt(Math.max(0.05, 1 - (dl / 2.6) ** 2)), dl);
        const [p, n] = onSkinAt(a, l, 0.08);
        R3.swab.visible = on;
        R3.swab.position.set(...p); R3.swab.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...n));
        const H = S.hands.right; H.group.visible = on;
        if (on) {
          H.pose({ f: [[10, 10, 5], [12, 12, 6], [45, 60, 40], [50, 65, 40]], thumb: [30, 30, 20], spread: 2 });
          H.place(0, v3.add(p, v3.mul(n, 0.15)), v3.norm(v3.sub(v3.mul(At, 0.85), v3.mul(n, 0.5))), v3.norm(v3.add(v3.mul(n, 0.85), v3.mul(At, 0.5))));
        }
        const wet = t < 10.3 ? s : 1 - 0.75 * span(t, 10.3, 14);
        S.painter.paint({ ...markOn(1), wet, wetR: 2.5 });
        if (on && t > 1.2) api.mark(R3.swab, 'cyan', t);
        if (t > 10.3) C.markRegion(G, [fromMark(-2.5, -2.5), fromMark(2.5, 2.5), fromMark(-2.5, 2.5), fromMark(2.5, -2.5)], 'cyan', t);
      },
      caption: [
        { from: 1.2, to: 10.3, text: 'The site scrubbed back and forth over a 5 cm circle with <b>chlorhexidine in alcohol</b> (the app’s swab is 70% alcohol), the friction working it into the skin’s creases.' },
        { from: 10.3, to: 14, text: 'Then left alone to <b>dry</b>: no fanning, no blotting, and no fingertip on it again.' },
      ],
    },
    {
      title: 'On the skin', dur: 16, view: 'pixel', scale: '10 µm',
      cues: [[3.2, () => sfx.hiss(0.9, 0.12, 3000)], [7.2, () => sfx.hiss(0.9, 0.12, 3000)]],
      frame(t) {
        px.fillAll('ink');
        const W = px.W;
        // the wet film comes with the swab: across left to right (3-7 s), back (7-10 s), then dries
        const wetAt = (x) => 3 + 4 * (x + 20) / (W + 40);                 // when the front reached x
        const front = lerp(-20, W + 20, span(t, 3, 7, api.ease.linear));
        const dry = span(t, 10.5, 14);
        // a bacterium dies over 1.5 s once wet: its membrane fails, it breaks up; down the
        // follicle the film reaches later and less, and a third of them live on
        const deadK = (b) => (b.deep ? (b.i % 3 === 0 ? 0 : span(t, 8, 10.5) * 0.99) : t < 3 ? 0 : clamp01((t - wetAt(b.x) - 0.3) / 1.5) * 0.99);
        const s = skinSurface(px, t, { surf: 0.3, kill: deadK });
        // the film, its front sweeping with the stroke, then thinning
        const film = 7 * (1 - dry);
        for (let x = 0; x < W; x++) {
          if (t < 3 || x > front || film <= 0.3) continue;
          const wob = Math.round(Math.sin(x * 0.2 + t * 4) * 0.8);
          px.rect(x, s.ys - film - 3 + wob, 1, film - wob, 'cyan', 0.26);
          px.px(x, s.ys - film - 3 + wob, 'cyan', 0.7);
        }
        // and down the follicle's mouth, slowly
        if (t > 4) px.rect(s.follicle[0] + 1, s.ys, s.follicle[2] - 2, Math.min(s.follicle[3], (t - 4) * 8) * (1 - dry * 0.6), 'cyan', 0.15);
        // chlorhexidine left bound to the skin: it keeps working after the alcohol has gone
        if (t > 4) { const r = rng(9); for (let i = 0; i < 70; i++) { const x = r() * W; if (x < front || t > 7) px.px(x, s.ys - 1 + r() * 12, 'teal', span(t, 4, 6)); } }
        // the alcohol going off as vapour
        if (dry > 0 && dry < 1) { const r = rng(3); for (let i = 0; i < 50; i++) { const x = r() * W, y = s.ys - 6 - ((t * 25 + r() * 80) % 70); px.px(x, y, 'cyan', 0.5 * (1 - dry)); } }
        // how many are left alive, as a share
        const alive = s.bugs.filter((b) => deadK(b) < 0.5).length / s.bugs.length;
        const mx = W - 54, my = 6;
        px.rect(mx, my, 48, 22, 'ink', 0.9); px.frame(mx, my, 48, 22, 'dkgrey');
        px.rect(mx + 4, my + 4, Math.max(1, Math.round(40 * alive)), 5, alive > 0.5 ? 'violet' : alive > 0.15 ? 'orange' : 'lime');
        px.text(Math.round(alive * 100) + '%', mx + 44, my + 13, 'white', 1, 1, 'right');
        api.keepOut([mx, my, 48, 22]);
        // what to look at: a cluster before; the cluster the front is reaching; the follicle
        const surf = s.bugs.filter((b) => !b.deep);
        if (t < 3) { const b = surf[3]; api.mark([b.x - 8, b.y - 10, 16, 14], 'violet', t); }
        else if (t < 10.5) {
          const fx = Math.min(W - 30, Math.max(30, front - 10));
          const b = surf.reduce((m, q) => (Math.abs(q.x - fx) < Math.abs(m.x - fx) ? q : m), surf[0]);
          api.mark([b.x - 9, b.y - 11, 18, 16], 'cyan', t);
          api.keepOut([b.x - 12, s.ys - 14, 24, 20]);
        } else api.mark(s.follicle, 'yellow', t);
      },
      caption: [
        { from: 0.5, to: 3, text: 'Skin carries bacteria on its surface and down its hair follicles: <b>staphylococci</b> above all, the commonest cause of line infections.' },
        { from: 3, to: 10.5, text: 'The antiseptic film: alcohol denatures their proteins in seconds, <b>chlorhexidine</b> breaks their membranes and stays bound to the skin, working on for hours.' },
        { from: 10.5, to: 16, text: 'It works as it <b>dries</b>, and wet skin stings. A few survive down the follicles: the site is clean, not sterile, so it is not touched again.' },
      ],
    },
  ];
  // the prep table from above the patient's side
  function prepCam(d, along) {
    const c = R3.prep.O, Z = R3.prep.Z, X = R3.prep.X;
    const tgt = v3.add(c, v3.mul(X, along));
    return [v3.add(tgt, v3.add(v3.mul([0, 1, 0], d * 0.85), v3.mul(Z, d * 0.55))), tgt, 38];
  }
  void SPR; void dimLine; void site;
  return { title: 'Getting ready', steps };
}
