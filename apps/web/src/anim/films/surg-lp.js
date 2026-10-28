/* SURGICAL ANIMATIONS: THE LUMBAR PUNCTURE, under fluoroscopy. The child prone, the lumbar region
   (the kit: films/surg/kit.js). Five chapters:
     Opening     the kit's: the tray, the betadine, the spinal needle dropped on, the prep, the
                 drape, the C-arm's cover.
     Localizing  AP with the L3-L4 endplates squared; a spare locator needle laid on the skin and
                 one spot image; the mark; the lidocaine wheal and track.
     Insertion   the spinal needle (stylet in) on the midline, angled a little toward the head:
                 AP for the level and the midline, the C swung to a lateral for the depth, back to
                 AP, lateral again through the dura. The 3D view with the skin see-through, the
                 live image with the tip marked, and the cross-section of the tissue it crosses
                 (the layers named down the side).
     CSF         the stylet out, CSF dripping into four numbered tubes, an intrathecal drug given
                 slowly, the stylet back in and the needle out.
     Closing     the kit's: sharps, re-packing, the betadine cleaned off, gauze and tape.

   The path: the midline at the L3-L4 interlaminar window, 6 degrees toward the head, checked on
   the model's own voxels (K.tissuesAlong: skin, fat, the ligaments, the ligamentum flavum, the
   epidural fat, the dura, CSF; no bone). The voxels have no ligament of their own between the
   spinous processes (they call it muscle): the cross-section paints it in and names it.

   The live image is the C-arm's at its pose: screened in short windows (the pedal pressed, the
   beam's fan shown); between them the monitor holds the last image, the needle where it was
   when the beam was last on. */
import { buildKit, LANDMARKS, v3 } from './surg/kit.js';
import { MAT, canvasTex } from './surg/props.js';

const D2R = Math.PI / 180;

export async function build(api) {
  const K = await buildKit(api, { patient: 'child', region: 'lumbar' });
  const { span, px, sfx } = api;
  const THREE = K.THREE, U = K.suite, room = K.room;
  const LM = LANDMARKS.child;

  // ---- the views: AP with the L3-L4 endplates squared, and the true lateral
  const AP0 = { orbital: 0, tilt: 0 }, AP = { orbital: 0, tilt: 5 }, LAT = { orbital: 90, tilt: 0 };
  // AP <-> lateral: the tilt taken out in the first half of the turn (the lateral frames are at
  // tilt 0), the orbit eased the whole way
  const swing = (k, from = AP, to = LAT) => {
    const o = from.orbital + (to.orbital - from.orbital) * k;
    const tk = from.tilt === 0 ? Math.min(1, Math.max(0, (k - 0.5) * 2)) : Math.min(1, k * 2);
    return K.carm.set({ orbital: o, tilt: from.tilt + (to.tilt - from.tilt) * tk });
  };

  // ---- the path
  const ANG = 6;                                              // degrees toward the head
  const dir = [0, -Math.cos(ANG * D2R), Math.sin(ANG * D2R)];
  const aim = [-0.1, 0.9, 15.15];                             // in the thecal sac at L3-L4
  const entry = K.entry(aim, dir);
  const L = v3.len(v3.sub(aim, entry));
  const segs = K.tissuesAlong(entry, v3.add(aim, v3.mul(dir, 1.2)));
  const first = (name, after = 0) => segs.find((s) => s.tissue === name && s.from >= after);
  const dSkin = first('skin')?.from ?? 0, dFat = first('fat').from, dLig = first('muscle').from;
  const dFlav = first('flavum').from, dEpi = first('epidural', dFlav).from, dDura = first('dura', dEpi).from;
  const csf = first('csf', dDura), dCsf = csf.from, dCsfMid = (csf.from + csf.to) / 2;
  const fAt = (d) => d / L;                                   // a depth (cm from the entry) as advance()'s f
  const at = (d) => v3.add(entry, v3.mul(dir, d));
  K.setSite(entry);

  // the layers the needle crosses, as the cross-section names them (depths along the path)
  const LAYERS = [
    ['SKIN', 'peach', dSkin, dFat],
    ['FAT', 'fat', dFat, dLig],
    ['SUPRASPINOUS LIG', 'mid', dLig, dLig + 0.5],
    ['INTERSPINOUS LIG', 'mid', dLig + 0.5, dFlav],
    ['LIGAMENTUM FLAVUM', 'orange', dFlav, dEpi],
    ['EPIDURAL FAT', 'gold', dEpi, dDura],
    ['DURA', 'lav', dDura, dCsf],
    ['CSF', 'blue', dCsf, 99],
  ];
  const layerAt = (d) => LAYERS.findIndex((l) => d >= l[2] && d < l[3]);
  // the ligaments between the spinous processes painted over the voxels' 'muscle'
  // (on the midline there is no muscle: what the voxels call muscle there is ligament)
  const ligFills = [{ at: at(L * 0.6), r: 14, color: 'mid', tissue: ['muscle'] }];

  // ---- the needles
  const N = K.needle('spinal');
  const loc = K.needle('locator');
  const lido = K.syringe({ ml: 3 });
  const drug = K.syringe({ ml: 5, color: 0xf2dc5a });
  // a needle's shaft for the image at a depth (cm), without moving the needle itself
  const shaftAt = (d, len = N.len) => ({ from: at(d - len), to: at(d), od: 2.2, w: 1.3 });

  // the skin mark (a sterile marker's dot) and the lidocaine wheal
  const markDot = new THREE.Mesh(new THREE.CircleGeometry(0.28, 16), new THREE.MeshBasicMaterial({ color: 0x5b2a86 }));
  markDot.rotation.x = -Math.PI / 2; room.pat.add(markDot);
  const wheal = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8a4a22, roughness: 0.4 }));
  room.pat.add(wheal);
  const skinY = (p) => (K.top(p[0], p[2]) ?? p[1]);
  const showMark = (k) => { markDot.visible = k > 0.01; markDot.scale.setScalar(Math.max(0.01, k)); markDot.position.set(entry[0], skinY(entry) + 0.06, entry[2]); };
  const showWheal = (k) => { wheal.visible = k > 0.01; wheal.scale.set(0.7 * k + 0.01, 0.22 * k + 0.01, 0.7 * k + 0.01); wheal.position.set(entry[0], skinY(entry) - 0.05, entry[2]); };

  // ---- the tubes: four, numbered (their caps' colours), in a rack on the drape
  const tubes = [1, 2, 3, 4].map((n) => {
    const g = new THREE.Group(); room.pat.add(g);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.5, 5, 16, 1, true), MAT.clear(0xf4fbff, 0.4));
    body.position.y = 2.5; g.add(body);
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), MAT.clear(0xf4fbff, 0.4)));
    const lab = canvasTex(64, 96, (c, w, h) => {
      c.fillStyle = '#fbfbf6'; c.fillRect(0, 0, w, h); c.fillStyle = ['#d23a3a', '#2f6fd6', '#30a050', '#e0a020'][n - 1]; c.fillRect(0, 0, w, 16);
      c.fillStyle = '#1d2228'; c.font = 'bold 54px Arial, sans-serif'; c.textAlign = 'center'; c.fillText(String(n), w / 2, 78);
    });
    const label = new THREE.Mesh(new THREE.CylinderGeometry(0.57, 0.57, 2.2, 16, 1, true, -Math.PI * 0.45, Math.PI * 0.9), new THREE.MeshStandardMaterial({ map: lab, roughness: 0.7 }));
    label.position.y = 2.6; label.rotation.y = Math.PI; g.add(label);
    const liquid = new THREE.Mesh(new THREE.CylinderGeometry(0.47, 0.47, 1, 14), new THREE.MeshPhysicalMaterial({ color: 0xcfe9ff, roughness: 0.1, transparent: true, opacity: 0.7, depthWrite: false }));
    g.add(liquid);
    const fill = (k) => { liquid.visible = k > 0.01; liquid.scale.y = Math.max(0.01, k * 1.6); liquid.position.y = 0.1 + k * 0.8; };
    fill(0);
    g.visible = false;
    return { g, fill, n };
  });
  // the rack: on the drape beside the hip, out of the close shot
  const rackAt = (i) => { const x = 9 + i * 1.6, z = 3; return [x, room.draped(x, z) + 0.05, z]; };
  // the drops: from the hub's rim, over its edge, down into the tube held against it
  const drops = [0, 1, 2].map(() => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), MAT.clear(0xcfe9ff, 0.85)); room.pat.add(m); m.visible = false; return m; });
  const hubTop = () => v3.sub(N.tip(), v3.mul(N.dir, N.len + N.hubLen));
  const mouthAt = () => v3.add(hubTop(), [0.6, -0.4, 0]);
  const drip = (t, on) => drops.forEach((m, i) => {
    const ph = (t * 0.8 + i / 3) % 1, h = hubTop();
    m.visible = on > 0.05;
    if (!m.visible) return;
    const p = ph < 0.4 ? v3.lerp(v3.add(h, [0, 0.05, 0]), v3.add(h, [0.45, -0.02, 0]), ph / 0.4)
      : v3.add(h, [0.45 + (ph - 0.4) * 0.3, -0.6 * (((ph - 0.4) / 0.6) ** 2), 0]);
    m.position.set(...p);
    m.scale.setScalar(ph < 0.2 ? 0.4 + ph * 3 : 1);
  });
  // a tube: k 0 in the rack, 1 held nearly on its side, its mouth against the hub, its closed end
  // out over the back and lower (the patient's left, toward the operator)
  const TILT = 1.25;
  const holdTube = (tb, k, i) => {
    tb.g.visible = true;
    const axis = [-Math.sin(TILT), Math.cos(TILT), 0];
    const rest = rackAt(i), hold = v3.sub(mouthAt(), v3.mul(axis, 5));
    const lift = Math.sin(Math.PI * Math.min(1, k)) * 4;
    const p = v3.add(v3.lerp(rest, hold, k), [0, lift, 0]);
    tb.g.position.set(...p);
    tb.g.rotation.set(0, 0, TILT * k);
  };

  const resetLP = (stage = 'procedure') => {
    K.reset(stage);
    showMark(0); showWheal(0);
    tubes.forEach((tb) => { tb.g.visible = false; tb.fill(0); });
    drops.forEach((m) => { m.visible = false; });
    U.press(0);
  };

  // ---- the screen: the C's image, screened in windows; between them the last image held
  // the time the beam was last on (0 before the first window)
  const lastBeam = (t, wins) => { let tb = 0; for (const [w0, w1] of wins) if (t >= w0) tb = Math.min(t, w1); return tb; };
  /* wins: [[t0, t1], ...] the beam on; depth(t): the needle's depth at time t (null: not in
     the image); extra(t): needles besides it; pose: the pose the held image was taken at, if the C
     has moved since. Returns the blit's at(). */
  const screen = (t, { wins = [], depth = null, extra = () => [], a = 1, size = 112, label = null, pose = null } = {}) => {
    const on = wins.some(([w0, w1]) => t >= w0 && t <= w1);
    const tb = lastBeam(t, wins);
    const seed = 11 + Math.floor(tb * 8);
    K.carm.beam(on ? 0.5 : 0); U.press(on ? 1 : 0);
    const d = depth ? depth(tb) : null;
    const needles = [...(d != null ? [shaftAt(d)] : []), ...extra(tb)];
    K.monitor.show({ needles, seed, label, ...(pose || {}) });
    return K.monitor.blit(px, 6, 6, size, { a });
  };
  const cueWins = (wins) => wins.map(([w]) => [w, K.sfx.pulse]);
  // the tip marked on the image, and the vertebrae named beside it
  const markTip = (atF, p, t) => { const q = atF(p); if (q) api.mark([q[0] - 4, q[1] - 4, 8, 8], 'yellow', t); };
  const nameLevels = (atF, a, lateral = false) => {
    for (const [name, p] of [['L3', LM.L3.body], ['L4', LM.L4.body]]) {
      const q = atF(p); if (!q) continue;
      px.text(name, lateral ? q[0] - 22 : q[0] - 30, q[1] - 2, 'yellow', a);
    }
  };

  // ---- the cross-section and its layers
  const secCentre = at(L * 0.62);
  const SX = () => px.W - 90;
  const section = (a = 1) => {
    const x = SX(), y = 6, w = 84, h = 92;
    K.section({ needle: N, x, y, w, h, across: [0, 0, 1], centre: secCentre, cm: 0.12, fills: ligFills, label: false, a });
    const d = v3.dot(v3.sub(N.tip(), entry), dir), i = layerAt(d);
    if (i >= 0) {
      const [word, col] = LAYERS[i], lw = word.length * 4 + 3;
      px.rect(x + (w - lw) / 2, y + h - 8, lw, 7, 'black', 0.75 * a);
      px.text(word, x + w / 2, y + h - 7, col === 'lav' || col === 'mid' ? 'white' : col, a, 1, 'center');
    }
    // the layers, in the order the needle meets them
    const ly = y + h + 5;
    LAYERS.forEach(([word, col], k) => {
      const yy = ly + k * 7, cur = k === i;
      px.rect(x + 2, yy, 4, 5, col, a);
      px.text(word, x + 9, yy, cur ? 'white' : 'mid', a);
      if (cur) px.text('>', x - 4, yy, 'yellow', a);
    });
    api.keepOut([x - 6, ly - 2, w + 8, LAYERS.length * 7 + 3]);
  };

  // ---- cameras (the room's coordinates)
  const C = (p) => K.toRoom(p);
  // close: over the needle from one side, above and toward the feet, the skin see-through: the
  // needle's whole length and the spine under it (s 1 the operator's side, the patient's left;
  // -1 the other, when the C is in a lateral and its receptor is on the operator's side)
  const needleMid = C([entry[0], 6.8, entry[2] + 0.4]);
  const close = (t1 = 12, s = 1) => [[0, [needleMid[0] + 19 * s, needleMid[1] + 17, needleMid[2] - 10], needleMid, 36], [t1, [needleMid[0] + 17 * s, needleMid[1] + 14, needleMid[2] - 8], needleMid, 36]];
  // the C-arm and the patient: from the foot end, the operator's side
  const iso = C([0, 2, 14]);
  const wideC = (t1 = 10) => [[0, [iso[0] + 150, iso[1] + 95, iso[2] - 170], [iso[0] - 10, iso[1] + 5, iso[2]], 40], [t1, [iso[0] + 135, iso[1] + 80, iso[2] - 150], [iso[0] - 10, iso[1] + 5, iso[2]], 40]];
  // the C from the head end: its turn round the patient seen across the table
  const headC = (t1 = 10) => [[0, [iso[0] + 60, iso[1] + 85, iso[2] + 175], [iso[0], iso[1] + 2, iso[2] - 5], 42], [t1, [iso[0] + 45, iso[1] + 75, iso[2] + 160], [iso[0], iso[1] + 2, iso[2] - 5], 42]];
  const siteC = C(entry);
  const above = (t1 = 10) => [[0, [siteC[0] + 11, siteC[1] + 13, siteC[2] - 8], v3.add(siteC, [1.5, 0, 0]), 34], [t1, [siteC[0] + 8, siteC[1] + 10, siteC[2] - 6], v3.add(siteC, [1.5, 0, 0]), 32]];

  // the depth schedule of an insertion step: [[t, depth], ...] held between keys, eased along them
  const schedule = (keys) => (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) return keys[i - 1][1] + (keys[i][1] - keys[i - 1][1]) * span(t, keys[i - 1][0], keys[i][0]);
    return keys[keys.length - 1][1];
  };
  const dAP = dLig + 1.2;                                     // in the interspinous ligament
  const dLat = dEpi + 0.12;                                   // through the flavum, in the epidural fat

  // ---------------------------------------------------------------- Localizing
  const localizing = [
    {
      title: 'AP: the endplates squared', dur: 12, fadeIn: 0.4, scale: '1 m',
      enter() { resetLP(); K.carm.set(AP0); },
      cam: wideC(12),
      cues: cueWins([[1, 1.6], [2.4, 7.4]]),
      frame(t) {
        K.carm.ease(AP0, AP, span(t, 2.6, 7));
        const a = span(t, 0.6, 1.2), q = screen(t, { wins: [[1, 1.6], [2.4, 7.4]], a });
        if (t > 7.6) {
          // the L3-L4 disc space, ticked either side of the spine; the bodies named
          const s = q([0, -1.15, 15.6]);
          if (s) { px.rect(s[0] - 24, s[1], 8, 1, 'yellow', a); px.rect(s[0] + 17, s[1], 8, 1, 'yellow', a); }
          nameLevels(q, span(t, 7.6, 8.2));
        }
      },
      caption: [
        { from: 0.6, to: 6, text: '<b>AP</b>, the C tilted toward the head until the <b>L3-L4</b> endplates are sharp single lines.' },
        { from: 6, to: 12, text: 'The <b>conus</b> ends near L1-L2 in a child, lower in an infant: the puncture is at <b>L3-L4</b> or below.' },
      ],
    },
    {
      title: 'The locator needle', dur: 12, scale: '1 cm',
      enter() { resetLP(); K.carm.set(AP); },
      cam: above(12),
      cues: [[5.2, K.sfx.pulse], [9.6, K.sfx.snap]],
      frame(t) {
        // slid in across the skin from the operator's side until its tip is over the window
        const k = span(t, 0.8, 4.2), tipAt = v3.add(entry, [7 * (1 - k), 0, -2 * (1 - k)]);
        loc.lay(tipAt, [-1, 0, 0.15]);
        const wins = [[5.2, 5.8]];
        const q = screen(t, { wins, extra: (tb) => (tb > 0 ? [loc.segment(1.6, 1)] : []), a: span(t, 0.4, 1) });
        if (t > 1 && t < 5.2) api.mark(loc.g, 'yellow', t, { live: true });
        if (t > 5.8) { K.monitor.spot('L3-4'); markTip(q, loc.tip(), t); nameLevels(q, 1); }
        showMark(span(t, 9.4, 10));
        if (t > 10) api.mark(markDot, 'yellow', t);
      },
      caption: [
        { from: 0.6, to: 5.2, text: 'A spare <b>locator needle</b> laid on the skin over the L3-L4 space.' },
        { from: 5.2, to: 9.4, text: 'One <b>spot image</b>: its tip on the midline, just below the <b>interlaminar space</b>.' },
        { from: 9.4, to: 12, text: 'The entry <b>marked</b> on the skin.' },
      ],
    },
    {
      title: 'Local anaesthetic', dur: 11, scale: '1 cm',
      enter() { resetLP(); K.carm.set(AP); showMark(1); },
      cam: (() => { const c = v3.add(siteC, [0, 3, 0]); return [[0, [c[0] + 15, c[1] + 8, c[2] - 12], c, 36], [10, [c[0] + 12, c[1] + 6, c[2] - 9], c, 34]]; })(),
      cues: [[1.6, () => sfx.tick()]],
      frame(t) {
        // the locator needle on the lidocaine syringe: a wheal at the mark, then along the track
        const d = 0.25 * span(t, 1, 1.6) + 2.2 * span(t, 4.6, 7.4);
        loc.place(entry, aim); loc.advance(fAt(d) - (1 - span(t, 0, 1)) * 0.25);
        const push = span(t, 2, 4.4) * 0.35 + span(t, 4.6, 8.4) * 0.45;
        lido.set({ fill: 0.85 - push }); K.attach(lido, loc, 1);
        showWheal(span(t, 2, 4.4));
        showMark(1 - span(t, 2, 3));
        if (t > 2 && t < 9) api.mark(wheal, 'yellow', t);
      },
      caption: [
        { from: 0.5, to: 4.6, text: '<b>Lidocaine 1%</b>: a skin <b>wheal</b> at the mark,' },
        { from: 4.6, to: 11, text: 'then along the track. The child is usually <b>sedated</b> too: the needle must not move once in.' },
      ],
    },
  ];

  // ---------------------------------------------------------------- Insertion
  const sched1 = schedule([[0.6, 0], [2.2, 1.2], [4.2, 1.2], [5.4, 3.0], [7.4, 3.0], [8.6, dAP]]);
  const w1 = [[2.4, 3.0], [5.6, 6.2], [8.8, 9.6]];
  const sched3 = schedule([[0.8, dAP], [2.4, dFlav - 0.4], [4.6, dFlav - 0.4], [6.4, dFlav + 0.12], [7.0, dLat]]);
  const w3 = [[2.6, 3.2], [7.4, 8.2]];
  const sched5 = schedule([[3.6, dLat], [5.0, dDura + 0.05], [6.8, dDura + 0.05], [7.6, dCsfMid]]);
  const w5 = [[3.0, 3.5], [5.2, 5.8], [8.2, 8.9]];
  const insertView = (t, d, wins, depth, opts = {}) => {
    N.place(entry, aim); N.advance(fAt(d)); N.stylet(1);
    K.xray(span(t, 0.2, 1.4) * 0.88);
    room.drape.set(1 - span(t, 0.2, 1.4));
    const q = screen(t, { wins, depth, a: span(t, 0.3, 1), ...opts });
    section(span(t, 0.4, 1));
    return q;
  };
  const insertion = [
    {
      title: 'Into the ligaments: AP', dur: 13, fadeIn: 0.3, scale: '1 cm',
      enter() { resetLP(); K.carm.set(AP); showMark(1); },
      cam: close(13, 1),
      cues: [...cueWins(w1), [1.6, () => sfx.tick()]],
      frame(t) {
        // (not on the screen until the first pulse after it goes in)
        const q = insertView(t, sched1(t), w1, (tb) => (tb > 0 ? sched1(tb) : null));
        if (t > 2.4) markTip(q, at(sched1(lastBeam(t, w1))), t);
        nameLevels(q, span(t, 1, 1.6));
      },
      caption: [
        { from: 0.5, to: 5.4, text: 'The <b>spinal needle</b>, stylet in: midline, a little toward the head, bevel facing sideways.' },
        { from: 5.4, to: 13, text: 'Small steps, a pulse after each. In <b>AP</b> it must stay on the <b>midline</b>: a drift is corrected now, while shallow.' },
      ],
    },
    {
      title: 'The C to a lateral', dur: 11, scale: '1 m',
      enter() { resetLP(); K.carm.set(AP); N.place(entry, aim); N.advance(fAt(dAP)); N.stylet(1); },
      cam: headC(11),
      cues: [[1.2, K.sfx.pulse], [9.2, K.sfx.pulse]],
      frame(t) {
        swing(span(t, 1.4, 8.6));
        // screened as it turns: the image turns with the C
        const q = screen(t, { wins: [[1.2, 9.6]], depth: () => dAP, a: span(t, 0.3, 0.9) });
        if (t > 9) { markTip(q, at(dAP), t); nameLevels(q, span(t, 9, 9.6), true); }
      },
      caption: [
        { from: 0.6, to: 5.6, text: 'The C swings <b>90°</b> to a <b>lateral</b>; the image turns with it.' },
        { from: 5.6, to: 11, text: 'AP shows the level and the midline; the <b>lateral</b> shows the <b>depth</b>: still well behind the canal.' },
      ],
    },
    {
      title: 'Through the ligamentum flavum: lateral', dur: 12, scale: '1 cm',
      enter() { resetLP(); K.carm.set(LAT); },
      cam: close(12, -1),
      cues: [...cueWins(w3), [6.3, () => sfx.tick()]],
      frame(t) {
        const q = insertView(t, sched3(t), w3, sched3);
        markTip(q, at(sched3(lastBeam(t, w3))), t);
        nameLevels(q, span(t, 1, 1.6), true);
      },
      caption: [
        { from: 0.5, to: 4.6, text: 'On in small steps toward the <b>back of the canal</b>.' },
        { from: 4.6, to: 12, text: 'The <b>ligamentum flavum</b> is firm, then gives: a first <b>pop</b>, into the <b>epidural fat</b>.' },
      ],
    },
    {
      title: 'Back to AP: still on the midline', dur: 11, scale: '1 m',
      enter() { resetLP(); K.carm.set(LAT); N.place(entry, aim); N.advance(fAt(dLat)); N.stylet(1); },
      cam: headC(11),
      cues: [[7.6, K.sfx.pulse]],
      frame(t) {
        swing(span(t, 0.8, 7), LAT, AP);
        if (t < 7.6) {
          // the beam off while it turns: the screen holds the lateral, whatever the C does now
          K.carm.beam(0); U.press(0);
          K.monitor.show({ needles: [shaftAt(dLat)], seed: 66, orbital: LAT.orbital, tilt: LAT.tilt });
          K.monitor.blit(px, 6, 6, 112, { a: span(t, 0.2, 0.8) });
          return;
        }
        const q = screen(t, { wins: [[7.6, 8.2]], depth: () => dLat });
        if (t > 8.2) { markTip(q, at(dLat), t); nameLevels(q, span(t, 8.2, 8.8)); }
      },
      caption: [
        { from: 0.5, to: 7.4, text: 'Back to <b>AP</b>, the beam off while the C turns: the screen holds the last image.' },
        { from: 7.4, to: 11, text: 'One pulse: still on the <b>midline</b>, over the canal.' },
      ],
    },
    {
      title: 'Through the dura: lateral', dur: 12, scale: '1 cm',
      enter() { resetLP(); K.carm.set(AP); },
      cam: close(12, -1),
      cues: [...cueWins(w5), [7.5, () => sfx.tick()]],
      frame(t) {
        swing(span(t, 0.2, 2.8));
        const q = insertView(t, sched5(t), w5, sched5, { pose: t < 3 ? AP : null });
        if (t > 3) { markTip(q, at(sched5(lastBeam(t, w5))), t); nameLevels(q, span(t, 3.4, 4), true); }
      },
      caption: [
        { from: 0.5, to: 4.8, text: 'Lateral again, and on in <b>1-2 mm</b> steps.' },
        { from: 4.8, to: 12, text: 'A second, softer <b>pop</b>: the <b>dura</b>. The tip is in the <b>CSF</b> of the thecal sac.' },
      ],
    },
  ];

  // ---------------------------------------------------------------- CSF
  const placed = () => { N.place(entry, aim); N.advance(fAt(dCsfMid)); };
  const held = (t, a = 1) => { K.carm.set(LAT); K.monitor.show({ needles: [shaftAt(dCsfMid)], seed: 71 }); K.monitor.spot('LAT'); return K.monitor.blit(px, 6, 6, 92, { a }); };
  const hubW = () => C(at(dCsfMid - N.len - N.hubLen));
  const csfCam = (t1 = 10) => { const h = hubW(); return [[0, [h[0] + 9, h[1] + 4, h[2] - 7], [h[0], h[1] - 1.5, h[2]], 34], [t1, [h[0] + 7, h[1] + 3, h[2] - 5], [h[0], h[1] - 1.8, h[2]], 32]]; };
  const csfSteps = [
    {
      title: 'The stylet out', dur: 10, fadeIn: 0.3, scale: '1 cm',
      enter() { resetLP(); K.carm.set(LAT); placed(); },
      cam: csfCam(10),
      frame(t) {
        N.stylet(t < 4.2 ? 1 - span(t, 1, 4) : -1);
        drip(t, span(t, 5, 6));
        if (t > 5.5) api.mark(drops[0], 'yellow', t, { live: true });
        const q = held(t, span(t, 0.3, 0.9)); markTip(q, at(dCsfMid), t);
      },
      caption: [
        { from: 0.5, to: 5, text: 'The <b>stylet</b> comes out.' },
        { from: 5, to: 10, text: 'Clear <b>CSF</b> drips from the hub: let it drip, never aspirate. Prone, it comes slowly.' },
      ],
    },
    {
      title: 'Numbered tubes', dur: 15, scale: '1 cm',
      enter() { resetLP(); K.carm.set(LAT); placed(); N.stylet(-1); },
      cam: (() => { const h = hubW(), c = [h[0] + 2.2, h[1] - 1.2, h[2]]; return [[0, [c[0] + 3, c[1] + 5, c[2] - 13], c, 36], [15, [c[0] + 2, c[1] + 4, c[2] - 11], c, 34]]; })(),
      frame(t) {
        drip(t, 1);
        tubes.forEach((tb, i) => {
          const t0 = 0.6 + i * 3.4;
          const k = span(t, t0, t0 + 0.8) * (1 - span(t, t0 + 2.6, t0 + 3.3));
          holdTube(tb, k, i);
          tb.fill(span(t, t0 + 0.8, t0 + 2.6, api.ease.linear) * 0.55);
          if (k > 0.5) api.mark(tb.g, 'yellow', t, { live: true });
        });
        held(t, span(t, 0.3, 0.9));
      },
      caption: [
        { from: 0.5, to: 7.4, text: '<b>Numbered tubes</b>, filled in order, about <b>1 mL</b> each: cell count, protein and glucose, culture.' },
        { from: 7.4, to: 15, text: 'Blood from a <b>traumatic tap</b> clears from tube 1 to tube 4; blood alike in every tube is not from the needle.' },
      ],
    },
    {
      title: 'An intrathecal drug', dur: 12, scale: '1 cm',
      enter() { resetLP(); K.carm.set(LAT); placed(); N.stylet(-1); tubes.forEach((tb, i) => { tb.g.visible = true; tb.fill(0.55); const p = rackAt(i); tb.g.position.set(...p); tb.g.rotation.set(0, 0, 0); }); },
      cam: (() => { const h = hubW(), c = [h[0], h[1] + 3.5, h[2]]; return [[0, [c[0] + 9, c[1] + 3, c[2] - 7], [h[0], h[1] - 1, h[2]], 34], [2.4, [c[0] + 15, c[1] + 4, c[2] - 13], c, 36], [12, [c[0] + 13, c[1] + 3, c[2] - 11], c, 36]]; })(),
      frame(t) {
        drip(t, 1 - span(t, 0.5, 1.4));
        K.attach(drug, N, span(t, 0.6, 2.4));
        drug.set({ fill: 0.9 * (1 - span(t, 3.4, 11, api.ease.linear)) });
        if (t > 2.4) api.mark(drug.g, 'yellow', t, { live: true });
        held(t, span(t, 0.3, 0.9));
      },
      caption: [
        { from: 0.5, to: 5, text: 'For an <b>intrathecal drug</b> (chemotherapy, nusinersen), the CSF volume asked for is taken first,' },
        { from: 5, to: 12, text: 'then the syringe on the hub, the drug given <b>slowly</b>, the needle held still.' },
      ],
    },
    {
      title: 'Stylet in, needle out', dur: 9, scale: '1 cm',
      enter() { resetLP(); K.carm.set(LAT); N.stylet(-1); tubes.forEach((tb, i) => { tb.g.visible = true; tb.fill(0.55); const p = rackAt(i); tb.g.position.set(...p); }); },
      cam: csfCam(9),
      cues: [[5.2, () => sfx.tick()]],
      frame(t) {
        N.place(entry, aim);
        N.advance(fAt(dCsfMid * (1 - span(t, 4.4, 7.4))) - (t > 7.4 ? span(t, 7.4, 8.4) * 0.8 : 0));
        N.stylet(t < 1 ? -1 : span(t, 1, 3.6));
        if (t > 8.4) N.show(false);
        if (t > 1 && t < 4) api.mark(N.g, 'yellow', t, { live: true });
      },
      caption: [
        { from: 0.5, to: 4.4, text: 'The <b>stylet back in</b> before the needle comes out: fewer <b>post-puncture headaches</b>.' },
        { from: 4.4, to: 9, text: 'The needle out in one pull, then pressure on the site.' },
      ],
    },
  ];

  // ---------------------------------------------------------------- the opening and the closing
  const opening = K.opening({ needles: ['spinal'] });
  const closing = K.closing({ sharps: [N, loc], sites: [entry] });

  const chapters = [
    { title: 'Opening', steps: opening },
    { title: 'Localizing', steps: localizing },
    { title: 'Insertion', steps: insertion },
    { title: 'CSF', steps: csfSteps },
    { title: 'Closing', steps: closing },
  ];
  return { title: 'Lumbar puncture', chapters };
}
