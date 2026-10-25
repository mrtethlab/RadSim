/* IV FILM, chapter 1: why and where. The line a contrast CT needs; gauge and flow (Poiseuille);
   the veins of the elbow, the forearm and the hand, on the app's own arm and hand; into the vein:
   its section, its wall's layers, the blood in it, a valve; and what lies beside it (the
   aponeurosis, the brachial artery, the median nerve). */
import * as THREE from 'three';
import { Section, bloodField, wallLayers, SPR, dimLine } from './px.js';
import { loadSkin, buildGeometry, featureTube, v3 } from './arm.js';
import { std, mesh, setOpacity } from '../../kit/stage.js';
import { shots } from './shots.js';

export async function whyWhere(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const C = shots(api, S);

  // ---- the forearm's veins (the room's forearm site, on the same arm), as tubes
  const G2 = buildGeometry('forearm', S.arm.caster);
  const fore = new THREE.Group(); S.room.add(fore); fore.visible = false;
  const foreT = {};
  const foreVeins = new THREE.Group(); fore.add(foreVeins);
  for (const f of G2.feats) { foreT[f.id] = featureTube(G2, f, { color: f.kind === 'artery' ? 0xd23040 : 0x3f5fb8 }); (f.kind === 'vein' ? foreVeins : fore).add(foreT[f.id]); }

  // ---- the hand, palm down on its own board (the room's hand site), its dorsal veins
  const handSet = new THREE.Group(); api.scene.add(handSet); handSet.visible = false;
  const HC = [260, 0, 0];
  let G3 = null; const handT = {};
  const handVeins = new THREE.Group(); handSet.add(handVeins);
  try {
    const hand = await loadSkin(api, 'models/hand/hand_skin.glb');
    hand.group.position.set(...HC); hand.group.updateMatrixWorld(true);
    handSet.add(hand.group);
    G3 = buildGeometry('hand', hand.caster, HC);
    for (const f of G3.feats) {
      const tendon = f.kind === 'tendon';
      handT[f.id] = featureTube(G3, f, { color: tendon ? 0xe8e2d0 : 0x3f5fb8, depthMM: tendon ? 1.5 : undefined });
      handT[f.id].visible = !tendon;
      (tendon ? handSet : handVeins).add(handT[f.id]);
    }
    const hb = new THREE.Box3().setFromObject(hand.group);
    handSet.add(mesh(new THREE.BoxGeometry(hb.max.x - hb.min.x + 12, 2.4, hb.max.z - hb.min.z + 10), std(0x2b3f5c, 0.85, 0.05),
      (hb.min.x + hb.max.x) / 2, hb.min.y - 1.2, (hb.min.z + hb.max.z) / 2));
    handSet.userData.skin = hand.group;
  } catch (e) { console.warn('hand model', e); }

  S.resetHooks.push(() => { fore.visible = false; handSet.visible = false; S.room.visible = true; });

  // ================================================================ 8-bit scenes
  // gauge and flow: four catheters in long section, their streams, the flow each passes
  const GA = [['18', 'green', 1.0, 1.3], ['20', 'pink', 0.8, 1.1], ['22', 'blue', 0.6, 0.9], ['24', 'yellow', 0.47, 0.7]];
  function flowScene(t, hi) {
    px.fillAll('ink');
    const W = px.W, H = px.H, k = Math.min(24, (H - 40) / 4 / 1.3);
    const plotW = Math.max(70, Math.round(W * 0.28)), x0 = 26, x1 = W - plotW - 18;
    const boxes = [];
    GA.forEach(([g, col, id, od], i) => {
      const cy = 18 + (i + 0.5) * (H - 36) / 4, ri = id / 2 * k, ro = od / 2 * k;
      // the hub, in its colour; the catheter's wall (clear plastic) and lumen
      px.rect(x0 - 12, cy - ro - 3, 12, 2 * ro + 6, col);
      px.text(g, x0 - 6, cy - 2, 'ink', 1, 1, 'center');
      px.rect(x0, cy - ro, x1 - x0, ro - ri, 'grey', 0.5); px.rect(x0, cy + ri, x1 - x0, ro - ri, 'grey', 0.5);
      px.rect(x0, cy - ri, x1 - x0, 2 * ri, 'navy', 0.55);
      // the stream: as many particles as the lumen's area, each as fast as r² and its place in
      // the parabolic profile allow — the flow goes as r⁴
      const r = rng(70 + i), n = Math.round(ri * ri * 0.9 * (x1 - x0) / 40), vmax = 26 * (id / 0.8) ** 2;
      for (let j = 0; j < n; j++) {
        const fy = r() * 2 - 1, v = vmax * (1 - fy * fy), x = x0 + ((r() * (x1 - x0) + v * t) % (x1 - x0));
        px.px(x, cy + fy * (ri - 0.5), 'cyan', 0.9);
      }
      boxes.push([x0 - 14, cy - ro - 5, x1 - x0 + 16, 2 * ro + 10]);
    });
    // the flow each passes, relative to the 20 G (r⁴): bars, the numbers over them
    const px0 = W - plotW - 8, py0 = 16, ph = H - 44;
    px.rect(px0, py0, plotW, ph + 18, 'ink', 0.9); px.frame(px0, py0, plotW, ph + 18, 'dkgrey');
    const bw = Math.floor((plotW - 10) / 4), base = py0 + ph - 2, grow = span(t, 1.5, 4);
    GA.forEach(([g, col, id], i) => {
      const rel = (id / 0.8) ** 4, hgt = Math.round(rel / 2.5 * (ph - 18) * grow);
      const bx = px0 + 5 + i * bw;
      px.rect(bx + 1, base - hgt, bw - 3, hgt, col);
      px.text(rel >= 1 ? rel.toFixed(1) : rel.toFixed(2), bx + bw / 2, base - hgt - 7, 'white', grow, 1, 'center');
      px.text(g + 'G', bx + bw / 2, base + 5, col, 1, 1, 'center');
    });
    px.rect(px0 + 3, base, plotW - 6, 1, 'mid');
    api.keepOut([px0, py0, plotW, ph + 18]);
    if (hi != null) api.mark(boxes[hi], 'yellow', t);
    return { boxes, plot: [px0, py0, plotW, ph + 18] };
  }

  // the vein in long section: skin, fat, the median cubital (6 mm across, 3.5 mm down), blood
  const veinSec = (t, o = {}) => {
    const k = Math.min(9, (px.W - 16) / 30, (px.H - 20) / 17);
    const sec = new Section(px, { k, u0: -((px.W / k) / 2), z0: -2.4 });
    sec.tissue(t, { fatBottom: 13 });
    const cz = 3.5 + 0.4 + 3;
    const ves = sec.vessel(t, { cz, b: 3, v: 7, valves: o.valves || [], valveOpen: o.valveOpen ?? 1, seed: 5 });
    return { sec, cz, ves };
  };

  // a valve, its cusps opening to the flow toward the heart and shutting on the flow back
  function valveScene(t) {
    px.fillAll('ink');
    const P = 9, ph = t % P;
    // forward for 5 s; then a reversal (a hanging arm, a cough): the cusps fill and meet
    const back = ph > 5 && ph < 8.4 ? span(ph, 5, 5.6) * (1 - span(ph, 7.8, 8.4)) : 0;
    const k = Math.min(16, (px.W - 16) / 18, (px.H - 26) / 10);
    const sec = new Section(px, { k, u0: -((px.W / k) / 2) + 1, z0: -1.4 });
    sec.tissue(t, { fatBottom: 30, dermis: 0.9 });
    const cz = 3.6;
    // the cells' drift: forward, then back and slow; the stream integrates its own speed
    const s = forwardDist(t, P);
    sec.vessel(s, { cz, b: 2.6, v: 1, valves: [0], valveOpen: 1 - back, seed: 8, cells: 1.2 });
    // in the sinus behind each cusp, an eddy: cells turning
    for (const sd of [-1, 1]) {
      for (let i = 0; i < 9; i++) {
        const a = t * 2.4 + i * 0.7, rr = 0.55 + (i % 3) * 0.18;
        px.rect(sec.X(1.55 + Math.cos(a) * rr * 0.8), sec.Y(cz + sd * 2.35 + Math.sin(a) * rr * 0.5), 2, 1, i % 2 ? 'red' : 'plum', 0.9);
      }
    }
    const box = [sec.X(-0.6), sec.Y(cz - 3.7), sec.X(3.4) - sec.X(-0.6), sec.Y(cz + 3.7) - sec.Y(cz - 3.7)];
    return { sec, box, back };
  }
  // how far the blood has moved by t: 7 mm/s forward, a slow return while the valve is shut
  const forwardDist = (t, P) => {
    const n = Math.floor(t / P), ph = t % P;
    const per = (x) => (x < 5 ? 7 * x : x < 8.4 ? 35 - 0.6 * (x - 5) : 35 - 2.04 + 7 * (x - 8.4));
    return n * per(P) + per(ph);
  };

  // across the fossa (seen from the hand, the skin up: lateral on the left, medial on the right)
  function fossaScene(t, hi) {
    px.fillAll('ink');
    const W = px.W, H = px.H, k = Math.min((W - 20) / 80, (H - 24) / 52);     // px per mm
    const cx = W / 2, top = 14;
    const X = (mm) => cx + mm * k, Y = (mm) => top + mm * k;
    // skin and fat over the whole width, an arch
    const skinZ = (x) => 0.004 * x * x;
    for (let x = -40; x <= 40; x += 1 / k) {
      const z = skinZ(x);
      px.rect(X(x), Y(z), 1, 1.2 * k, 'peach');
      px.rect(X(x), Y(z + 1.2), 1, (9 - z * 0.3) * k, 'fat', 0.32);
    }
    // muscle below: brachialis, the biceps' tendon, the humerus at the bottom
    const mz = (x) => 10 + 0.004 * x * x;
    for (let x = -40; x <= 40; x += 1 / k) px.rect(X(x), Y(mz(x)), 1, H, 'muscle', 0.45);
    // the muscles in their sheaths: brachioradialis (lateral), pronator teres (medial), brachialis deep
    const belly = (cx, cz, rx, rz) => {
      for (let i = 0; i < 90; i++) { const a = i / 90 * 6.283; px.px(X(cx + Math.cos(a) * rx), Y(cz + Math.sin(a) * rz), 'peach', 0.5); }
      for (let j = -rz + 2; j < rz; j += 2.2) { const hw = rx * Math.sqrt(Math.max(0, 1 - (j / rz) ** 2)); px.line(X(cx - hw + 1), Y(cz + j), X(cx + hw - 1), Y(cz + j) + 1, 'dkred', 0.35); }
    };
    belly(-27, 24, 11, 10); belly(26, 24, 11, 10); belly(0, 32, 16, 7);
    px.circle(X(-6), Y(19), 3.2 * k, 'bone', 0.95, true);                 // the biceps tendon (lateral to the artery)
    // the humerus at its lower end, below the brachialis: cortex, marrow
    px.circle(X(0), Y(50), 12 * k, 'bone', 0.95, true); px.circle(X(0), Y(50), 9 * k, 'fat', 0.55, true);
    // the bicipital aponeurosis: a sheet from the tendon sweeping medially, over the artery and nerve
    for (let x = -4; x <= 22; x += 0.5 / k) { const z = 12 + (x + 4) * 0.08; px.rect(X(x), Y(z), 1, 2, 'white', 0.9); }
    // the superficial veins in the fat: cephalic (lateral), median cubital, basilic (medial)
    const pulse = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 70 / 60);
    const vessel = (x, z, r, col, wallCol) => { px.circle(X(x), Y(z), r * k + 1, wallCol, 1, true); px.circle(X(x), Y(z), r * k, col, 1, true); };
    vessel(-26, 5.5, 2.5, 'dkred', 'plum');
    vessel(-2, 6.6, 3.0, 'dkred', 'plum');
    vessel(24, 9.0, 3.0, 'dkred', 'plum');
    // under the sheet: the brachial artery (its pulse) and, medial to it, the median nerve
    const ar = 2.2 * (1 + 0.08 * pulse);
    vessel(6, 17, ar, 'red', 'pink');
    px.circle(X(12.5), Y(17.5), 1.7 * k, 'yellow', 1, true);
    for (let i = 0; i < 6; i++) px.px(X(12.5) + Math.cos(i) * k, Y(17.5) + Math.sin(i * 1.3) * k, 'gold');
    const boxes = {
      ceph: [X(-29), Y(2.5), 6 * k, 6 * k], mc: [X(-5.5), Y(3.2), 7 * k, 7 * k], bas: [X(20.5), Y(5.5), 7 * k, 7 * k],
      apo: [X(-4), Y(11), 26 * k, 4 * k], art: [X(3.2), Y(14), 6 * k, 6 * k], nerve: [X(10.3), Y(15.3), 4.5 * k, 4.5 * k],
    };
    if (hi) for (const h of [].concat(hi)) api.mark(boxes[h], h === 'art' ? 'red' : h === 'nerve' ? 'yellow' : 'cyan', t);
    return boxes;
  }

  // ================================================================ the steps
  const steps = [
    {
      title: 'A line for contrast', dur: 12, fadeIn: 0.8, scale: (t) => (t < 6 ? '10 cm' : '1 cm'),
      enter() { S.reset(); S.painter.paint({ fill: 0, mark: null }); },
      cam: [[0, ...C.side(120, 38, 6, 40)], [5.5, ...C.side(70, 30, 0, 38)], [12, ...C.side(32, 42, 0, 34)]],
      frame(t) {
        if (t > 6.5) C.markRegion(S.G, [[-3, 3], [3, 3], [-3, -3], [3, -3]], 'yellow', t);
      },
      caption: [
        { from: 1, to: 6.3, text: 'A contrast CT needs a <b>peripheral IV</b>: a short plastic catheter in an arm vein, through which an injector pushes the contrast at 3–5 mL a second.' },
        { from: 6.5, to: 12, text: 'The usual place: the large, straight veins at the front of the elbow, the <b>antecubital fossa</b>.' },
      ],
    },
    {
      title: 'Gauge and flow', dur: 15, view: 'pixel', scale: '1 mm',
      frame(t) { flowScene(t, t > 6.5 && t < 11 ? 1 : t > 11 ? 0 : null); },
      caption: [
        { from: 0.6, to: 6.5, text: 'A catheter’s <b>gauge</b> is its size: the higher the number, the thinner. Each has its colour: 18 green, 20 pink, 22 blue, 24 yellow.' },
        { from: 6.5, to: 11, text: 'Flow rises with the <b>fourth power</b> of the radius (Poiseuille): at the same pressure a 20 G passes about three times what a 22 G does.' },
        { from: 11, to: 15, text: 'For contrast at 3–5 mL/s: an <b>18–20 G</b> in a large vein. The 20 G closed catheter here is rated to 10 mL/s.' },
      ],
    },
    {
      title: 'The veins at the elbow', dur: 16, scale: '1 cm',
      enter() { S.reset(); api.camera.up.set(...C.topUp()); S.painter.paint({ fill: 0.3, mark: null }); },
      cam: [[0, ...C.top(30, 0, 0, 34)], [16, ...C.top(24, 0.5, 0, 34)]],
      frame(t) {
        S.cutaway(span(t, 0.5, 2.5) * 0.85);
        const hiArt = t > 10.5;
        S.tubes.brachialArtery.visible = S.tubes.medianNerve.visible = hiArt;
        if (t > 1.2 && t < 5.4) { api.mark(S.tubes.cephalic, 'cyan', t); api.mark(S.tubes.basilic, 'cyan', t); }
        if (t > 5.4 && t < 10.5) api.mark(S.tubes.medianCubital, 'yellow', t);
        if (hiArt) C.markRegion(S.G, [[-3, -0.4], [3, -0.4], [-3, -2.1], [3, -2.1]], 'red', t);      // (the stretch of artery and nerve under the fossa)
      },
      caption: [
        { from: 1.2, to: 5.4, text: 'On the thumb’s side runs the <b>cephalic</b> vein; on the little finger’s side, the <b>basilic</b>.' },
        { from: 5.4, to: 10.5, text: 'Between them, slanting across the fossa, the <b>median cubital</b>: large, near the surface and well anchored, the usual first choice.' },
        { from: 10.5, to: 16, text: 'Deeper and to the inside: the <b>brachial artery</b> and the <b>median nerve</b>. The basilic runs nearest to them, one reason to prefer the other two.' },
      ],
    },
    {
      title: 'Forearm and hand', dur: 15, scale: '1 cm',
      enter() { S.reset(); api.camera.up.set(...C.topUp()); fore.visible = true; S.cutaway(0.85); for (const t of Object.values(S.tubes)) t.visible = false; },
      cam(t) {
        if (t < 7.5) {
          // (from the elbow down the forearm: the forearm site's own frame, 14 cm distal)
          const a = lerp(9, 0, span(t, 0, 4));
          const p = C.topAt(G2, a, 0.5, 36);
          return { pos: p[0], look: p[1], fov: 34 };
        }
        return C.handCam(G3, t - 7.5);
      },
      frame(t) {
        const onHand = t >= 7.5 && G3;
        S.room.visible = !onHand; handSet.visible = !!onHand; fore.visible = !onHand;
        if (onHand) { api.camera.up.set(...C.handUp(G3)); setOpacity(handSet.userData.skin, 1 - 0.45 * span(t, 8, 9.5)); }
        else api.camera.up.set(...C.topUp());
        if (!onHand && t > 2.5) api.mark(foreVeins, 'cyan', t);
        if (onHand && t > 9.5) api.mark(handVeins, 'cyan', t);
      },
      caption: [
        { from: 2.5, to: 7.4, text: 'Down the forearm the veins run on, straight and splinted by its bones: good sites too, for a <b>20–22 G</b>.' },
        { from: 9.5, to: 15, text: 'On the back of the hand: small veins under thin skin that roll. A <b>22–24 G</b> at 10–15°, and contrast no faster than <b>1.5 mL/s</b>.' },
      ],
    },
    {
      title: 'Into the vein', dur: 13, scale: (t) => (t < 3.5 ? '1 cm' : '1 mm'),
      enter() { S.reset(); S.painter.paint({ fill: 0.3, mark: null }); for (const t of Object.values(S.tubes)) t.visible = false; S.tubes.medianCubital.visible = true; },
      // (down through the see-through skin to the vein's middle, 7 mm under the mark, from its side)
      cam: [[0, ...C.side(10, 25, 0, 34)], [3.6, v3.add(C.veinC(0.69), v3.add(v3.mul(C.Sd, 1.3), v3.mul(S.F.n, 0.12))), C.veinC(0.69), 30]],
      cues: [[0.4, () => sfx.whoosh()]],
      frame(t) {
        S.cutaway(span(t, 0, 1.5) * 0.85);
        api.mosaic(span(t, 1.8, 3.6));
        if (t > 3.4) {
          px.alpha = span(t, 3.4, 4.2);
          const { sec, cz } = veinSec(t);
          px.alpha = 1;
          const ux = sec.U(px.W * 0.78);
          if (t > 4.5) {
            dimLine(px, sec.X(ux), sec.Y(cz - 3), sec.X(ux), sec.Y(cz + 3), '6 mm', 'yellow', span(t, 4.5, 5.2));
            if (t < 8.5) api.mark([sec.X(ux - 2), sec.Y(cz - 3.5), sec.X(ux + 2) - sec.X(ux - 2), sec.Y(cz + 3.5) - sec.Y(cz - 3.5)], 'yellow', t);
          }
          if (t > 8.5) {
            const ud = sec.U(px.W * 0.22);
            dimLine(px, sec.X(ud), sec.Y(0), sec.X(ud), sec.Y(3.5), '3.5 mm', 'cyan', span(t, 8.5, 9.2));
            api.mark([sec.X(ud - 1.5), sec.Y(-0.4), sec.X(ud + 1.5) - sec.X(ud - 1.5), sec.Y(3.9) - sec.Y(-0.4)], 'cyan', t);
          }
        }
      },
      caption: [
        { from: 4.5, to: 8.5, text: 'The median cubital in section: about 6 mm across, its blood flowing back to the heart at a pressure of only a few mmHg.' },
        { from: 8.5, to: 13, text: 'It lies in the fat 3–4 mm under the skin, its wall thin enough to flatten under a fingertip.' },
      ],
    },
    {
      title: 'The wall', dur: 15, view: 'pixel', scale: '10 µm',
      frame(t) {
        px.fillAll('ink');
        const W = px.W, H = px.H, art = t > 11;
        const bx = wallLayers(px, t, { x0: 8, y0: 10, w: W - 16, h: H - 20, artery: art });
        const order = ['intima', 'media', 'adventitia'];
        if (!art) { const i = t < 2 ? -1 : Math.min(2, Math.floor((t - 2) / 3)); if (i >= 0) api.mark(bx[order[i]], 'yellow', t); }
        else api.mark(bx.media, 'red', t);
      },
      caption: [
        { from: 2, to: 5, text: 'The <b>intima</b>: one smooth layer of endothelial cells. Scrape it (a probing needle, a catheter rubbing) and a clot or an inflamed vein (phlebitis) can follow.' },
        { from: 5, to: 8, text: 'The <b>media</b>: in a vein, a thin layer of smooth muscle.' },
        { from: 8, to: 11, text: 'The <b>adventitia</b>: tough collagen. The needle feels the wall’s resistance give: the “pop”.' },
        { from: 11, to: 15, text: 'An artery’s media is thick, muscle and elastic sheets: a wall built for a pressure of 120/80 mmHg and a pulse.' },
      ],
    },
    {
      title: 'Blood', dur: 11, view: 'pixel', scale: '10 µm',
      frame(t) {
        px.fillAll('ink');
        const b = bloodField(px, t, { x0: 0, y0: 0, w: px.W, h: px.H, wallBot: false, v: 34, seed: 11 });
        // the white cell most in view
        const w = b.wbcs.reduce((m, q) => (Math.abs(q[0] - px.W / 2) < Math.abs(m[0] - px.W / 2) ? q : m), b.wbcs[0]);
        if (t > 5.5 && w) api.mark([w[0] - 8, w[1] - 8, 16, 16], 'yellow', t);
      },
      caption: [
        { from: 0.6, to: 5.5, text: 'Close to the wall: <b>red cells</b>, 7–8 µm discs, tumbling along, fastest mid-stream and slowest at the wall; tiny platelets between them.' },
        { from: 5.5, to: 11, text: 'A <b>white cell</b> rolls slowly along the endothelium. This is what will rise up the needle into the flash chamber.' },
      ],
    },
    {
      title: 'Valves', dur: 14, view: 'pixel', scale: '1 mm',
      frame(t) {
        const v = valveScene(t);
        if (t > 1) api.mark(v.box, 'yellow', t);
        api.keepOut([v.box[0], v.box[1] - 4, v.box[2], v.box[3] + 8]);
      },
      caption: [
        { from: 1, to: 7, text: 'Veins have <b>valves</b>: paired cusps that open to blood flowing toward the heart and shut when it flows back.' },
        { from: 7, to: 14, text: 'Behind each cusp the wall bulges into a sinus: a small knot under the finger. A catheter pushed into a valve stops, so the site must be clear of them.' },
      ],
    },
    {
      title: 'Beside the vein', dur: 15, scale: (t) => (t < 2.5 ? '10 cm' : '1 cm'),
      enter() { S.reset(); S.painter.paint({ fill: 0.3, mark: null }); },
      cam: [[0, ...C.alongArm(-30, 14, 34)], [2.6, ...C.alongArm(-12, 4, 30)]],
      frame(t) {
        api.mosaic(span(t, 0.8, 2.6));
        if (t > 2.4) {
          px.alpha = span(t, 2.4, 3.2);
          const hi = t < 6.5 ? ['ceph', 'mc', 'bas'] : t < 10 ? ['apo'] : ['art', 'nerve'];
          fossaScene(t, t > 3.2 ? hi : null);
          px.alpha = 1;
        }
      },
      cues: [[10.2, () => sfx.thud()]],
      caption: [
        { from: 3.2, to: 6.5, text: 'Across the fossa, seen from the hand: the superficial veins in the fat, cephalic on the thumb’s side, median cubital, basilic.' },
        { from: 6.5, to: 10, text: 'Under them a tough sheet, the <b>bicipital aponeurosis</b>, between the veins and what lies deeper.' },
        { from: 10, to: 15, text: 'Beneath it the <b>brachial artery</b>, pulsing, and the <b>median nerve</b>. Too deep or too steep reaches them: a bright red, pulsing flash, or a sharp electric pain down the arm. Stop.' },
      ],
    },
  ];
  void clamp01; void v3; void SPR;
  return { title: 'Why and where', steps };
}
