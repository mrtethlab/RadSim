/* SURGICAL ANIMATIONS: the lumbar interlaminar epidural, the child prone (the kit's pediatric model,
   the lumbar region). Six chapters: the opening (the kit's, the needle a Tuohy); the view (AP,
   the levels counted, the C tilted until the L3-L4 interlaminar window opens, the entry found with
   a spare needle and a spot image, the skin wheal); the needle in (down the beam through the
   skin and the supraspinous and interspinous ligaments, checked on the AP for the midline and on
   the lateral for the depth, in 3D with the skin see-through and the 8-bit section naming each
   layer); creating the space (the loss-of-resistance syringe through the ligamentum flavum, the
   plunger giving as the tip enters the epidural space, the saline pushing the dura away); the
   epidurogram (lateral and AP) and the steroid; the closing (the kit's).

   The model's numbers (measured on its voxels, tissue crop lspine): the spinous processes and
   the canal sit about 0.45 cm to the right of x = 0; at L3-L4 the window (the canal seen between
   the laminae, with nothing bony behind it) is widest with the C tilted about 10 degrees CAUDALLY
   (tilt -10: the receptor toward the feet, the beam rising toward the head), and shut at +20,
   because the laminae shingle downward. The needle runs along that beam (10 degrees cephalad)
   from the skin to the posterior epidural space: skin, fat, the midline (supraspinous and
   interspinous ligaments: muscle in the voxels, painted as ligament in the section), the
   ligamentum flavum (3 mm), the epidural space (3 mm), the dura. */
import { buildKit, VIEWS, LANDMARKS } from './surg/kit.js';
import { sectionAxes, tissueAt } from './surg/geom.js';

const D = Math.PI / 180;

export async function build(api) {
  const K = await buildKit(api, { patient: 'child', region: 'lumbar' });
  const { span, px, sfx } = api;
  const { THREE, v3 } = K;
  const LM = LANDMARKS.child;
  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  // ---- the views: AP, the window opened (the caudal tilt found on the frames), the lateral
  const AP = VIEWS.lumbar.ap;
  const WIN = { orbital: 0, tilt: -10 };
  const SHUT = { orbital: 0, tilt: 15 };
  const LAT = VIEWS.lumbar.lateral;
  // WIN <-> LAT: the tilt levelled first (the frames past 45 degrees of orbit are at tilt 0)
  const swing = (k) => (k < 0.3 ? { orbital: 0, tilt: WIN.tilt * (1 - api.ease.inOut(k / 0.3)) } : { orbital: 90 * api.ease.inOut((k - 0.3) / 0.7), tilt: 0 });

  // ---- the path: the posterior epidural space at L3-L4, in along the beam of WIN
  const MID = -0.45;                                          // the model's midline at L3-L4
  const TARGET = [MID, 1.88, 15.3];
  const DIR = [0, -Math.cos(10 * D), Math.sin(10 * D)];
  const ENTRY = K.entry(TARGET, DIR);
  const L = v3.len(v3.sub(TARGET, ENTRY));
  const along = (s) => v3.add(ENTRY, v3.mul(DIR, s));
  // where each layer starts along it (cm from the skin), from the voxels
  const layers = K.tissuesAlong(ENTRY, along(L + 0.8));
  const first = (name, dflt) => layers.find((s) => s.tissue === name)?.from ?? dflt;
  const sFat = first('fat', 0.3), sMid = first('muscle', 4.1), sFlav = first('flavum', 6.65), sEpi = first('epidural', 7.0), sDura = first('dura', 7.3);
  const sInter = Math.max(sMid + 0.3, (ENTRY[1] - 4.2) / Math.cos(10 * D));   // below the spinous processes' tips
  const sEnd = sEpi + 0.08;                                   // the tip just through the flavum
  const fOf = (s) => s / L;

  // the midline's soft tissue between and over the spinous processes: ligament, not muscle
  const CROP = K.SI.crops.lspine, MUSCLE = K.SI.tissue.indexOf('muscle');
  const isLigament = (p) => Math.abs(p[0] - MID) < 0.35 && p[1] > 2.2 && p[1] < 4.9 && tissueAt(CROP, p) === MUSCLE;
  // the canal's back wall (the spinolaminar line in the lateral) at the midline, and the posterior
  // epidural space just in front of it
  const back = (x, z) => {
    let inCanal = false;
    for (let y = 0.9; y <= 3.6; y += 0.05) {
      const c = K.tissuesAlong([x, y, z], [x, y, z])[0]?.tissue;
      const canal = c === 'epidural' || c === 'dura' || c === 'csf' || c === 'nerve';
      if (canal) inCanal = true; else if (inCanal) return y;
    }
    return null;
  };
  const SPL = [];
  for (let z = 11; z <= 19.01; z += 0.25) { const y = back(MID, z); if (y != null) SPL.push([MID, y, z]); }
  // what is injected, in the section: the posterior epidural space filled up and down from the tip
  const posterior = (reach, color, a = 1) => (a < 0.02 ? [] : SPL.filter((p, i) => i % 2 === 0 && Math.abs(p[2] - TARGET[2]) < reach).map((p) => ({ at: [p[0], p[1] - 0.15, p[2]], r: 0.45, color, tissue: ['epidural'], a })));

  // the contrast: seeded points in the posterior epidural space round the tip, the nearer first
  const CON = [];
  {
    const r = api.rng(7);
    for (let i = 0; i < 180; i++) {
      const dz = (r() - 0.5) * 2 * (0.4 + 2.6 * (i / 180)), dx = (r() - 0.5) * (0.7 + 1.9 * (i / 180));
      const z = TARGET[2] + dz, x = MID + dx, y = back(x, z) ?? back(MID, z);
      if (y == null) continue;
      CON.push({ at: [x, y - 0.1 - r() * 0.06, z], d: Math.hypot(dz, dx * 1.6), r: 0.16 + r() * 0.08 });
    }
    CON.sort((a, b) => a.d - b.d);
  }
  // k 0..1 of the volume in: the spread reaching out from the tip; fade: the contrast thinned
  const contrast = (k, fade = 1) => {
    const reach = 0.3 + 3 * k;
    return CON.filter((c) => c.d < reach).map((c) => ({ at: c.at, r: c.r, od: 0.26 * fade * clamp01((reach - c.d) / 0.5) }));
  };

  // ---- the needles and syringes
  const T = K.needle('spinal');                // the Tuohy (the kit's spinal needle, dressed below)
  const LOC = K.needle('locator');             // the spare needle that finds the entry
  const LID = K.needle('locator');             // the lidocaine's
  const lidoSyr = K.syringe({ ml: 3, color: 0xf6fbff });
  const lorSyr = K.syringe({ ml: 5, color: 0xeaf4ff });
  const conSyr = K.syringe({ ml: 3, color: 0xfaf6e6 });
  const steSyr = K.syringe({ ml: 3, color: 0xf2f2ee });
  for (const kind of ['lidocaine', 'saline', 'contrast', 'steroid']) K.vial(kind);
  // a Tuohy: the tip's last 2 mm curved (the Huber tip), centimetre marks, wings on the hub
  const tuohy = (n) => {
    const steel = new THREE.MeshStandardMaterial({ color: 0xd5dadf, roughness: 0.22, metalness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.5 });
    const wingMat = new THREE.MeshStandardMaterial({ color: 0xf2f4f5, roughness: 0.5 });
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.036, 0.24, 10), steel);
    tip.rotation.x = Math.PI / 2 - 0.4; tip.position.set(0, 0.045, 0.1); n.g.add(tip);
    for (let z = 1; z < n.len - 0.4; z += 1) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.043, 0.07, 10), dark);
      m.rotation.x = Math.PI / 2; m.position.z = z; n.g.add(m);
    }
    const wing = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.09, 0.7), wingMat); wing.position.z = n.len + 0.25; n.g.add(wing);
  };
  tuohy(T); tuohy(K.props.trayNeedle);

  // the skin's mark and the lidocaine's wheal (the film's own: shown by the steps that want them)
  const skinY = K.top(ENTRY[0], ENTRY[2]) ?? ENTRY[1];
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8), new THREE.MeshStandardMaterial({ color: 0x4b1f6e, roughness: 0.6 }));
  dot.scale.y = 0.25; dot.position.set(ENTRY[0], skinY + 0.02, ENTRY[2]);
  const wheal = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 10), new THREE.MeshStandardMaterial({ color: 0xf0d2bd, roughness: 0.7 }));
  wheal.position.set(ENTRY[0], skinY - 0.1, ENTRY[2]);
  K.room.pat.add(dot, wheal);
  const own = (stage = 'procedure', { mark = true } = {}) => {
    K.reset(stage);
    dot.visible = mark; wheal.visible = false;
  };

  K.setSite(ENTRY);

  // ---- the 8-bit layer's panels
  const BIG = 116;
  // the live image; its view's name (opts.label) also written in the inset's corner
  let shown = null;
  const live = (t, opts = {}) => { shown = opts.label || null; K.monitor.show({ seed: 1 + Math.floor(t * 8), ...opts }); };
  const inset = (x, y, size) => {
    const at = K.monitor.blit(px, x, y, size);
    if (shown) px.text(shown, x + 3, y + 3, 'lime', 0.9);
    return at;
  };
  const bigImage = () => inset(6, 6, BIG);
  const SEC = () => ({ x: px.W - 96, y: 6, w: 90, h: 100 });
  // the layer the tip is in, by its depth along the path (the section's own name for it)
  const layerAt = (s) => {
    if (s < 0.02) return null;
    if (s < sFat) return ['SKIN', 'peach'];
    if (s < sMid) return ['FAT', 'fat'];
    if (s < sInter) return ['SUPRASPINOUS LIG.', 'grey'];
    if (s < sFlav) return ['INTERSPINOUS LIG.', 'grey'];
    if (s < sEpi) return ['LIGAMENTUM FLAVUM', 'orange'];
    if (s < sDura) return ['EPIDURAL SPACE', 'gold'];
    return ['DURA', 'lav'];
  };
  /* The section (the kit's), and over it the midline's ligaments: the voxels hold muscle between
     and over the spinous processes, where the supraspinous and interspinous ligaments are; they are
     repainted as ligament and the needle drawn again over them, as the kit draws it. */
  const section = (N, s, o = {}) => {
    const b = { ...SEC(), ...o.box }, cm = o.cm || 0.15;
    const tip = N.tip(), dir = N.dir, centre = o.centre || tip, hub = v3.sub(tip, v3.mul(dir, N.len));
    K.section({ needle: N, ...b, cm, across: [0, 0, 1], extras: o.extras || [], fills: o.fills || [], centre, label: false });
    const { A, B } = sectionAxes(dir, [0, 0, 1]);
    for (let j = 0; j < b.h; j++) for (let i = 0; i < b.w; i++) {
      const u = (i + 0.5 - b.w / 2) * cm, w = (b.h / 2 - j - 0.5) * cm;
      const p = [centre[0] + A[0] * u + B[0] * w, centre[1] + A[1] * u + B[1] * w, centre[2] + A[2] * u + B[2] * w];
      if (isLigament(p)) px.px(b.x + i, b.y + j, (i * 7 + j * 13) % 11 ? 'grey' : 'mid');
    }
    if (N.g.visible) {
      const toPanel = (p) => { const q = v3.sub(p, centre); return [b.x + b.w / 2 + v3.dot(q, A) / cm, b.y + b.h / 2 - v3.dot(q, B) / cm]; };
      const h0 = toPanel(hub), t0 = toPanel(tip);
      const line = (p, q, col) => {
        const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]));
        for (let m = 0; m <= n; m++) {
          const x = p[0] + (q[0] - p[0]) * m / Math.max(1, n), y = p[1] + (q[1] - p[1]) * m / Math.max(1, n);
          if (x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h && isLigament(v3.add(centre, v3.add(v3.mul(A, (x - b.x - b.w / 2) * cm), v3.mul(B, (b.y + b.h / 2 - y) * cm))))) px.px(x, y, col);
        }
      };
      const nn = [-(t0[1] - h0[1]), t0[0] - h0[0]], nl = Math.hypot(nn[0], nn[1]) || 1;
      line(h0, t0, 'grey');
      line([h0[0] + nn[0] / nl, h0[1] + nn[1] / nl], [t0[0] + nn[0] / nl, t0[1] + nn[1] / nl], 'slate');
    }
    const word = o.word || layerAt(s);
    if (word) {
      const lw = word[0].length * 4 + 3;
      px.rect(b.x + (b.w - lw) / 2, b.y + b.h - 8, lw, 7, 'black', 0.75);
      px.text(word[0], b.x + b.w / 2, b.y + b.h - 7, word[1], 1, 1, 'center');
    }
  };
  // a syringe in 8 bits, its tip on the left: the barrel, the saline in it, the plunger's stopper
  // at `stop` (0..1 of the barrel) and the thumb's pressure on it (an arrow, pushing in)
  const gauge = (x, y, { stop, press = 0, color = 'blue' }) => {
    const w = 46, h = 9;
    px.rect(x - 4, y + 3, 4, 3, 'grey');
    px.rect(x, y, w, h, 'ink', 0.8);
    px.frame(x, y, w, h, 'grey');
    const lx = Math.round((w - 2) * stop);
    if (lx > 0) px.rect(x + 1, y + 1, lx, h - 2, color, 0.85);
    const sx = x + 1 + lx;
    px.rect(sx, y + 1, 2, h - 2, 'slate');
    px.rect(sx + 2, y + 3, 16, 3, 'grey');
    px.rect(sx + 18, y - 1, 2, h + 2, 'grey');
    if (press > 0.05) {
      const ax = sx + 23;
      px.line(ax, y + 4, ax + 8, y + 4, 'yellow', press);
      px.line(ax, y + 4, ax + 3, y + 1, 'yellow', press);
      px.line(ax, y + 4, ax + 3, y + 7, 'yellow', press);
    }
    api.keepOut([x - 5, y - 2, w + 40, h + 4]);
  };
  // a needle's shaft at depth s on the path (for an image held from an earlier shot)
  const segAt = (s) => ({ from: along(s - T.len), to: along(s), od: 1.6, w: 1 });
  // the last shot at or before t (a held image shows the C and the needle as they were then)
  const lastShot = (t, shots) => shots.reduce((a, s) => (s <= t ? s : a), null);

  // ---- cameras (the room's frame)
  const R = (p) => K.toRoom(p);
  const wide = (d = 9) => { const c = R([0, 8, 12]); return [[0, [c[0] + 190, c[1] + 110, c[2] - 150], [c[0] - 20, c[1] + 10, c[2] - 20], 40], [d, [c[0] + 172, c[1] + 98, c[2] - 128], [c[0] - 20, c[1] + 10, c[2] - 20], 40]]; };
  const side = (d = 12) => { const c = R([0, 12, 15]); return [[0, [c[0] + 210, c[1] + 40, c[2] + 30], [c[0], c[1] + 10, c[2]], 40], [d, [c[0] + 200, c[1] + 36, c[2] + 18], [c[0], c[1] + 10, c[2]], 40]]; };
  const near = (p, d, r0 = 1, r1 = 0.85, fov = 40) => { const c = R(p); return [[0, v3.add(c, v3.mul([30, 26, -22], r0)), c, fov], [d, v3.add(c, v3.mul([30, 26, -22], r1)), c, fov - 4]]; };
  const mid = along(L * 0.55);

  /* ------------------------------------------------------------------ the view */
  const LEVELS = { L2: [0, -0.74, 19.44], L3: LM.L3.body, L4: LM.L4.body, L5: LM.L5.body };
  const labelLevels = (at, a = 1) => {
    for (const [name, p] of Object.entries(LEVELS)) {
      const q = at(p); if (!q) continue;
      px.text(name, q[0] + 16, q[1] - 2, 'cyan', a);
    }
  };
  const markWindow = (at, t, color = 'yellow') => {
    const q = at(TARGET); if (q) api.mark([q[0] - 7, q[1] - 5, 14, 10], color, t);
  };

  const TILT_SHOTS = [0.4, 1.6, 2.6, 3.6, 4.2, 6, 7, 8, 9, 10.1];
  const view = [
    {
      title: 'AP: count the levels', dur: 10, scale: '1 m',
      enter() { own('procedure', { mark: false }); K.carm.set(AP); },
      cam: wide(10),
      cues: [[0.8, K.sfx.pulse], [5, K.sfx.pulse]],
      frame(t) {
        K.carm.beam(t > 0.8 && t < 1.4 || t > 5 && t < 5.6 ? 0.6 : 0);
        const shot = lastShot(t, [0.8, 5]);
        if (shot == null) { K.monitor.dark(); shown = null; } else live(shot, { label: 'AP' });
        const at = bigImage();
        if (t > 2) labelLevels(at, span(t, 2, 3));
        if (t > 6) markWindow(at, t);
      },
      caption: [
        { from: 0.5, to: 5, text: 'The child prone, sedated. <b>AP</b> first: the beam straight up through the table, the levels counted up from the <b>sacrum</b>.' },
        { from: 5, to: 10, text: 'The target: the <b>L3–L4</b> interspace. Straight AP, the lamina above partly covers the gap between the laminae.' },
      ],
    },
    {
      title: 'Tilt the C: open the window', dur: 13, scale: '1 m',
      enter() { own('procedure', { mark: false }); K.carm.set(AP); },
      cam: side(13),
      cues: TILT_SHOTS.map((c) => [c, K.sfx.pulse]),
      frame(t) {
        // tilted between shots: the screen holds each shot's image until the next
        const poseAt = (u) => (u < 4.5 ? K.carm.ease(AP, SHUT, span(u, 0.8, 4)) : K.carm.ease(SHUT, WIN, span(u, 5, 10)));
        const shot = lastShot(t, TILT_SHOTS) ?? 0;
        const p = { ...poseAt(shot) };
        poseAt(t);
        K.carm.beam(t - shot < 0.4 ? 0.6 : 0);
        live(shot, { orbital: p.orbital, tilt: p.tilt, label: `TILT ${p.tilt > 0 ? '+' : ''}${Math.round(p.tilt)}` });
        const at = bigImage();
        labelLevels(at, 0.6);
        if (t > 10.2) markWindow(at, t);
      },
      caption: [
        { from: 0.5, to: 4.8, text: 'Tilted toward the <b>head</b>, the beam crosses the laminae, which slope down like roof tiles: the window <b>closes</b>.' },
        { from: 4.8, to: 9.6, text: 'Tilted the other way, the intensifier toward the <b>feet</b> (here about 10°): the beam runs between the laminae, along the line the needle will take.' },
        { from: 9.6, to: 13, text: 'The <b>interlaminar window</b> at its widest: the <b>bright</b> gap in the midline, between the laminae.' },
      ],
    },
    {
      title: 'Find the entry', dur: 11, scale: '10 cm',
      enter() { own('procedure', { mark: false }); K.carm.set(WIN); LOC.show(true); },
      cam: near(ENTRY, 11, 0.6, 0.5),
      cues: [[3.6, K.sfx.pulse], [7, K.sfx.pulse], [8.6, K.sfx.snap]],
      frame(t) {
        // the spare needle laid on the skin, its tip slid onto the spot over the window
        const at0 = [ENTRY[0] + 1.4, ENTRY[1], ENTRY[2] - 2.6];
        const lay = (u) => LOC.lay(v3.lerp(at0, ENTRY, span(u, 0.8, 3.4) * 0.6 + span(u, 4.4, 6.6) * 0.4), [0.15, 0, 1]);
        dot.visible = t > 8.6;
        K.carm.beam(t > 3.6 && t < 4.1 || t > 7 && t < 7.5 ? 0.6 : 0);
        // a spot image at each shot: the screen holds it (the needle where it was then)
        const shot = lastShot(t, [3.6, 7]);
        if (shot != null) { lay(shot); live(shot, { needles: [LOC.segment()], label: 'SPOT' }); K.monitor.spot('SPOT'); } else live(0, { label: 'AP' });
        lay(t);
        LOC.show(t < 9.5);
        if (t > 0.8 && t < 7.4) api.mark(LOC.g, 'yellow', t, { live: true });
        const at = bigImage();
        if (t > 7.2) markWindow(at, t);
        if (t > 8.8) api.mark(dot, 'yellow', t);
      },
      caption: [
        { from: 0.5, to: 4.4, text: 'A spare needle on the skin, and a <b>spot image</b>: one shot, held on the screen while the hand moves.' },
        { from: 4.4, to: 8.4, text: 'Moved until its tip sits <b>on the window</b>: straight down the beam from it is the epidural space.' },
        { from: 8.4, to: 11, text: 'The <b>entry point</b> marked on the skin.' },
      ],
    },
    {
      title: 'The skin wheal', dur: 9, scale: '10 cm',
      enter() { own('procedure'); K.carm.set(WIN); LID.place(ENTRY, TARGET); lidoSyr.set({ fill: 0.7 }); },
      cam: near(ENTRY, 9, 0.45, 0.38),
      cues: [[1.6, () => sfx.click()]],
      frame(t) {
        const dep = span(t, 1, 2.2) * 0.35 + span(t, 5.2, 7) * 0.9;
        LID.advance(fOf(dep));
        K.attach(lidoSyr, LID, 1);
        const inj = span(t, 2.6, 5) * 0.25 + span(t, 7, 8.4) * 0.2;
        lidoSyr.set({ fill: 0.7 - inj });
        wheal.visible = t > 2.6;
        const w = span(t, 2.6, 5);
        wheal.scale.set(0.3 + 0.7 * w, 0.2 + 0.25 * w, 0.3 + 0.7 * w);
        wheal.position.y = skinY - 0.12 + 0.05 * w;
        section(LID, dep, { cm: 0.06, centre: v3.add(ENTRY, v3.mul(DIR, 1)), fills: [
          { at: along(0.25), r: 0.55 * w, color: 'white', tissue: ['skin', 'fat'], a: 0.7 },
          { at: along(1.1), r: 0.6 * span(t, 7, 8.4), color: 'white', tissue: ['fat'], a: 0.6 }] });
      },
      caption: [
        { from: 0.5, to: 5, text: '<b>Lidocaine 1%</b> through a fine needle: a <b>skin wheal</b> over the mark.' },
        { from: 5, to: 9, text: 'Then a little more along the track, the way the epidural needle will go.' },
      ],
    },
  ];

  /* ------------------------------------------------------------------ the needle in */
  const needleIn = [
    {
      title: 'The Tuohy needle', dur: 11, scale: '10 cm',
      enter() { own('procedure'); K.carm.set(WIN); T.place(ENTRY, TARGET); T.stylet(1); },
      cam: (() => { const c = R(along(-6.5)); return [[0, v3.add(c, [15, 5, -11]), c, 38], [4.5, v3.add(c, [13, 4, -9]), c, 36], [11, v3.add(R(mid), [34, 24, -24]), R(mid), 40]]; })(),
      cues: [[5.2, () => sfx.click()], [7, K.sfx.pulse], [10, K.sfx.pulse]],
      frame(t) {
        const sOf = (u) => span(u, 5, 10.2, api.ease.linear) * (sInter + 0.25) - (1 - span(u, 0.5, 5)) * 1.2;
        const s = sOf(t);
        T.advance(fOf(Math.max(-1.2, s)));
        K.xray(span(t, 6, 8) * 0.9);
        K.carm.beam(t > 7 && t < 7.4 || t > 10 && t < 10.4 ? 0.5 : 0);
        const shot = lastShot(t, [7, 10]);
        live(shot ?? 0, { needles: shot == null ? [] : [segAt(sOf(shot))], label: 'AP' });
        inset(6, 6, 70);
        section(T, Math.max(0, s));
      },
      caption: [
        { from: 0.5, to: 5, text: 'The <b>Tuohy</b> epidural needle: a blunt, curved tip, less likely to puncture the dura; a stylet inside; a mark every centimetre.' },
        { from: 5, to: 11, text: 'In at the mark, along the beam: through the <b>skin</b> and the <b>fat</b> to the <b>supraspinous ligament</b>.' },
      ],
    },
    {
      title: 'AP: in the midline', dur: 10, scale: '10 cm',
      enter() { own('procedure'); K.carm.set(WIN); T.place(ENTRY, TARGET); T.stylet(1); },
      cam: near(mid, 10, 0.6, 0.5),
      cues: [[1, K.sfx.pulse], [4.5, K.sfx.pulse], [8, K.sfx.pulse]],
      frame(t) {
        const sOf = (u) => sInter + 0.25 + span(u, 0.5, 8, api.ease.linear) * (sFlav - 0.45 - sInter - 0.25);
        const s = sOf(t);
        T.advance(fOf(s));
        K.xray(0.9);
        const shot = lastShot(t, [1, 4.5, 8]) ?? 0;
        K.carm.beam(t - shot < 0.4 ? 0.5 : 0);
        live(shot, { needles: [segAt(sOf(shot))], label: 'AP' });
        const at = bigImage();
        if (t > 3) { const q = at(T.tip()); if (q) api.mark([q[0] - 6, q[1] - 6, 12, 12], 'yellow', t); }
        section(T, s);
      },
      caption: [
        { from: 0.5, to: 5, text: 'On down through the <b>interspinous ligament</b>, between the spinous processes: firm and gritty under the needle.' },
        { from: 5, to: 10, text: 'On the AP the needle is seen <b>end on</b>, a dot in the middle of the window: in the <b>midline</b> and on course.' },
      ],
    },
    {
      title: 'Lateral: the depth', dur: 12, scale: '1 m',
      enter() { own('procedure'); K.carm.set(WIN); T.place(ENTRY, TARGET); T.stylet(1); T.advance(fOf(sFlav - 0.45)); },
      cam: wide(12),
      cues: [[8, K.sfx.pulse], [10.5, K.sfx.pulse]],
      frame(t) {
        K.carm.set(swing(span(t, 0.6, 7)));
        K.carm.beam(t > 8 && t < 8.5 || t > 10.5 && t < 11 ? 0.5 : 0);
        K.xray(0.9);
        // the AP held while the C swings; the lateral's shot at 8
        if (t < 8) live(0, { needles: [T.segment()], label: 'AP', ...WIN }); else live(t < 10.5 ? 8 : 10.5, { needles: [T.segment()], label: 'LAT', ...LAT });
        const at = bigImage();
        if (t > 8.4) {
          // the spinolaminar line: the canal's back wall, dashed
          const a = span(t, 8.4, 9.2);
          for (let i = 1; i < SPL.length; i++) { const q0 = at(SPL[i - 1]), q1 = at(SPL[i]); if (q0 && q1) px.line(q0[0], q0[1], q1[0], q1[1], 'cyan', a, 1); }
          const q = at(T.tip()); if (q) api.mark([q[0] - 5, q[1] - 5, 10, 10], 'yellow', t);
        }
        section(T, sFlav - 0.45);
      },
      caption: [
        { from: 0.5, to: 7.5, text: 'The AP shows the midline, never the <b>depth</b>: the C swung round to a <b>lateral</b>.' },
        { from: 7.5, to: 12, text: 'The tip is still behind the <b>spinolaminar line</b> (dashed), the back wall of the canal: half a centimetre to go.' },
      ],
    },
  ];

  /* ------------------------------------------------------------------ creating the space */
  // the passage through the flavum: millimetre steps from 4 mm short of the flavum to just past it
  const D0 = sFlav - 0.45, NSTEP = Math.max(4, Math.round((sEnd - D0) / 0.1)), MM = (sEnd - D0) / NSTEP;
  const T0 = 1.2, PER = 0.95;
  const depth = (t) => {
    const x = Math.max(0, (t - T0) / PER), i = Math.min(NSTEP, Math.floor(x));
    const f = i >= NSTEP ? 0 : api.ease.inOut(Math.min(1, (x - i) / 0.4));
    return D0 + (i + f) * MM;
  };
  let tLOR = T0 + NSTEP * PER;
  for (let t = 0; t < 30; t += 0.01) if (depth(t) >= sEpi) { tLOR = t; break; }
  const PUSH0 = 0.8;
  // the saline in the space: the dura pushed ahead of it (in the section's plane)
  const { A: ACROSS } = (() => { const B = v3.mul(DIR, -1), a = [0, 0, 1]; return { A: v3.norm(v3.sub(a, v3.mul(B, v3.dot(a, B)))) }; })();
  const space = (k) => {
    if (k <= 0.01) return { extras: [], fills: [] };
    const r = 0.36 * k, tip = along(sEnd), c = v3.add(tip, v3.mul(DIR, r * 0.55));
    const extras = [{ at: c, r, tissue: 'epidural' }];
    for (let th = -100; th <= 100; th += 10) {
      const a = th * D;
      extras.push({ at: v3.add(c, v3.add(v3.mul(DIR, (r + 0.05) * Math.cos(a)), v3.mul(ACROSS, (r + 0.05) * Math.sin(a)))), r: 0.07, tissue: 'dura' });
    }
    return { extras, fills: [{ at: c, r: r * 1.6, color: 'cyan', tissue: ['epidural'], a: 0.8 }] };
  };

  const theSpace = [
    {
      title: 'The loss-of-resistance syringe', dur: 10, scale: '10 cm',
      enter() { own('procedure'); K.carm.set(LAT); T.place(ENTRY, TARGET); T.advance(fOf(D0)); lorSyr.set({ fill: 0.8, plunger: PUSH0 }); },
      cam: (() => { const h = R(along(-1.5)); return [[0, v3.add(h, [20, 10, -14]), h, 36], [10, v3.add(h, [16, 8, -10]), h, 34]]; })(),
      cues: [[1.2, () => sfx.click()], [5.6, () => sfx.click()]],
      frame(t) {
        T.stylet(t < 1 ? 1 : t < 3.4 ? 1 - span(t, 1, 3.2) : -1);
        if (t > 3.4) K.attach(lorSyr, T, span(t, 3.6, 5.4)); else lorSyr.g.visible = false;
        // the test push: the plunger goes in a little, and springs back
        const bounce = Math.max(0, Math.sin(Math.PI * clamp01((t - 6.4) / 1.4))) * 0.06 + Math.max(0, Math.sin(Math.PI * clamp01((t - 8.2) / 1.2))) * 0.05;
        lorSyr.set({ fill: 0.8, plunger: PUSH0 - bounce });
        K.xray(0.9);
        live(4, { needles: [T.segment()], label: 'LAT' });
        inset(6, 6, 70);
        section(T, D0);
        if (t > 5.4) gauge(px.W - 92, 112, { stop: 0.8 - bounce * 1.5, press: t > 6.2 ? 1 : 0 });
      },
      caption: [
        { from: 0.5, to: 3.6, text: 'The needle is held in the <b>interspinous ligament</b>; the <b>stylet</b> comes out.' },
        { from: 3.6, to: 6.2, text: 'A <b>loss-of-resistance syringe</b> onto the hub: its plunger glides freely, here with <b>saline</b> (air is the alternative).' },
        { from: 6.2, to: 10, text: 'Pressed while the tip is in ligament, the plunger will not go in: it <b>springs back</b>.' },
      ],
    },
    {
      title: 'Through the ligamentum flavum', dur: 16, scale: '10 cm',
      enter() { own('procedure'); K.carm.set(LAT); T.place(ENTRY, TARGET); T.stylet(-1); },
      cam: (() => { const c = R(along(sFlav * 0.4)); return [[0, v3.add(c, [19, 12, -14]), c, 38], [16, v3.add(c, [16, 10, -11]), c, 36]]; })(),
      cues: [
        ...Array.from({ length: NSTEP }, (_, i) => [T0 + i * PER, () => sfx.tick()]),
        [tLOR, () => sfx.tone(520, 260, 0.16, 'triangle', 0.45)],
        [tLOR + 1.5, K.sfx.pulse],
      ],
      frame(t) {
        const s = depth(t);
        T.advance(fOf(s));
        K.attach(lorSyr, T, 1);
        // constant pressure: the plunger held (a hair in, against the ligament) until the tip is
        // through; then it gives, the saline going in
        const lost = span(t, tLOR, tLOR + 1.6);
        const push = PUSH0 - 0.025 - lost * 0.32;
        lorSyr.set({ fill: 0.8 - lost * 0.32, plunger: push });
        K.xray(0.9);
        const k = span(t, tLOR, tLOR + 3.5);
        const sp = space(k);
        if (t < tLOR + 1.5) live(4, { needles: [segAt(D0)], label: 'LAT' }); else live(tLOR + 1.5, { needles: [T.segment()], label: 'LAT' });
        const at = bigImage();
        if (t > tLOR + 1.6) {
          for (let i = 1; i < SPL.length; i++) { const q0 = at(SPL[i - 1]), q1 = at(SPL[i]); if (q0 && q1) px.line(q0[0], q0[1], q1[0], q1[1], 'cyan', 0.8, 1); }
          const q = at(T.tip()); if (q) api.mark([q[0] - 5, q[1] - 5, 10, 10], 'yellow', t);
        }
        section(T, s, { cm: 0.06, centre: along(sFlav + 0.1), extras: sp.extras, fills: sp.fills, word: k > 0.3 ? ['EPIDURAL SPACE', 'gold'] : null });
        gauge(px.W - 92, 112, { stop: 0.8 - 0.02 - lost * 0.32, press: 1 });
      },
      caption: [
        { from: 0.5, to: 4.5, text: 'Steady pressure on the plunger, the needle advanced a <b>millimetre at a time</b>.' },
        { from: 4.5, to: tLOR, text: 'The <b>ligamentum flavum</b>: dense and rubbery, the most resistance of the whole passage.' },
        { from: tLOR, to: tLOR + 3.5, text: 'Through it, the resistance is <b>lost</b> all at once: the plunger gives, the saline runs in. The tip is in the <b>epidural space</b>.' },
        { from: tLOR + 3.5, to: 16, text: 'The saline <b>creates the space</b>, pushing the dura ahead of the blunt tip. On the lateral, the tip is at the <b>spinolaminar line</b>.' },
      ],
    },
    {
      title: 'Nothing back', dur: 8, scale: '10 cm',
      enter() { own('procedure'); K.carm.set(LAT); T.place(ENTRY, TARGET); T.stylet(-1); T.advance(fOf(sEnd)); lorSyr.set({ fill: 0.48, plunger: PUSH0 - 0.35 }); },
      cam: (() => { const h = R(along(-1.5)); return [[0, v3.add(h, [18, 9, -12]), h, 34], [8, v3.add(h, [15, 7, -9]), h, 32]]; })(),
      frame(t) {
        // the syringe off: the hub watched; nothing drips
        const off = span(t, 0.6, 2.4);
        K.attach(lorSyr, T, 1 - off);
        lorSyr.g.position.y += off * 4;
        T.drip(t, 0);
        K.xray(0.6);
        if (t > 3) { const q = api.toPx(R(v3.sub(T.tip(), v3.mul(T.dir, T.len + T.hubLen)))); if (q[2]) api.mark([q[0] - 6, q[1] - 6, 12, 12], 'yellow', t); }
        const sp = space(1);
        section(T, sEnd, { cm: 0.06, centre: along(sFlav + 0.1), extras: sp.extras, fills: sp.fills });
      },
      caption: [
        { from: 0.5, to: 8, text: 'The syringe off, the hub watched: <b>nothing comes back</b>. No CSF, so the dura is intact; no blood.' },
      ],
    },
  ];

  /* ------------------------------------------------------------------ confirm and inject */
  const inject = [
    {
      title: 'Epidurogram: the lateral', dur: 12, scale: '10 cm',
      enter() { own('procedure'); K.carm.set(LAT); T.place(ENTRY, TARGET); T.stylet(-1); T.advance(fOf(sEnd)); conSyr.set({ fill: 0.8 }); },
      cam: wide(12),
      cues: [[2.5, K.sfx.pulse]],
      frame(t) {
        K.attach(conSyr, T, span(t, 0.4, 1.8));
        const k = span(t, 2.5, 9.5, api.ease.linear);
        conSyr.set({ fill: 0.8 - 0.4 * k });
        K.carm.beam(t > 2.5 && t < 10 ? 0.5 : 0);
        K.xray(0.9);
        live(Math.min(t, 10), { needles: [T.segment()], blobs: contrast(k), label: 'LAT' });
        const at = bigImage();
        if (t > 9.6) {
          const q0 = at([MID, 1.8, TARGET[2] - 2.6]), q1 = at([MID, 1.8, TARGET[2] + 2.6]);
          if (q0 && q1) api.mark([q1[0] - 6, q1[1] - 2, 12, q0[1] - q1[1] + 4], 'yellow', t);
        }
        const sp = space(1);
        section(T, sEnd, { cm: 0.08, centre: along(sEnd), extras: sp.extras, fills: posterior(0.3 + 2.6 * k, 'violet'), word: ['EPIDURAL SPACE', 'gold'] });
      },
      caption: [
        { from: 0.5, to: 2.5, text: '<b>Contrast</b> in a small syringe onto the hub.' },
        { from: 2.5, to: 8, text: 'A little at a time, on <b>live</b> fluoroscopy: on the lateral it runs up and down as a <b>thin line</b> along the back of the canal.' },
        { from: 8, to: 12, text: 'That line is the <b>posterior epidural space</b>: the needle is in the right place.' },
      ],
    },
    {
      title: 'Epidurogram: the AP', dur: 12, scale: '1 m',
      enter() { own('procedure'); K.carm.set(LAT); T.place(ENTRY, TARGET); T.stylet(-1); T.advance(fOf(sEnd)); conSyr.set({ fill: 0.4 }); },
      cam: wide(12),
      cues: [[6, K.sfx.pulse]],
      frame(t) {
        K.attach(conSyr, T, 1);
        K.carm.set(swing(1 - span(t, 0.6, 5.6)));
        K.carm.beam(t > 6 && t < 6.6 ? 0.5 : 0);
        K.xray(0.9);
        // the lateral held while the C swings back; the AP's shot at 6
        if (t < 6) live(9.5, { needles: [T.segment()], blobs: contrast(1), label: 'LAT', ...LAT }); else live(6, { needles: [T.segment()], blobs: contrast(1), label: 'AP', ...WIN });
        const at = bigImage();
        if (t > 6.4) { const q = at(TARGET); if (q) api.mark([q[0] - 14, q[1] - 22, 28, 44], 'yellow', t); }
      },
      caption: [
        { from: 0.5, to: 6, text: 'Back to the <b>AP</b>.' },
        { from: 6, to: 12, text: 'A patchy spread up and down, either side of the midline: <b>epidural</b>. Not a <b>myelogram</b> (contrast mixing in the CSF, outlining the roots), not <b>vascular</b> (a fine line that washes away).' },
      ],
    },
    {
      title: 'The steroid', dur: 12, scale: '10 cm',
      enter() { own('procedure'); K.carm.set(WIN); T.place(ENTRY, TARGET); T.stylet(-1); T.advance(fOf(sEnd)); steSyr.set({ fill: 0.8 }); },
      cam: (() => { const h = R(along(-1.5)); return [[0, v3.add(h, [20, 10, -14]), h, 36], [12, v3.add(h, [26, 18, -18]), h, 38]]; })(),
      cues: [[1, () => sfx.click()], [10.2, () => sfx.click()]],
      frame(t) {
        const k = span(t, 2.2, 8.4, api.ease.linear);
        if (t < 9.2) { K.attach(steSyr, T, span(t, 0.4, 1.8)); steSyr.set({ fill: 0.8 - 0.6 * k }); } else steSyr.g.visible = false;
        // the stylet back in, then the needle out
        T.stylet(t < 9.2 ? -1 : span(t, 9.2, 10.2));
        T.advance(fOf(sEnd * (1 - span(t, 10.4, 11.8))));
        T.show(t < 11.8);
        K.xray(0.6 * (1 - span(t, 10.4, 11.8)));
        const sp = space(1);
        const s = sEnd * (1 - span(t, 10.4, 11.8));
        if (t < 11.8) section(T, s, { cm: 0.08, centre: along(sEnd), extras: sp.extras, fills: [...posterior(2.9, 'violet', 1 - k), ...posterior(0.3 + 2.6 * k, 'lime')], word: t < 10.4 ? ['EPIDURAL SPACE', 'gold'] : undefined });
      },
      caption: [
        { from: 0.5, to: 2.2, text: 'The <b>steroid</b> onto the hub.' },
        { from: 2.2, to: 8.6, text: 'Injected <b>slowly</b>, with saline or a little local anaesthetic, into the space the contrast has shown.' },
        { from: 8.6, to: 12, text: 'The <b>stylet back in</b>, and the needle out in one movement.' },
      ],
    },
  ];

  // ---- the opening and the closing: the kit's, the needle a Tuohy
  const opening = K.opening({ needles: ['spinal'] });
  const drop = opening.find((s) => s.title === 'The needle onto the tray');
  if (drop) drop.caption = [{ from: 0.8, to: 7, text: 'The <b>Tuohy epidural needle</b> is peeled open and dropped onto the tray: the circulator’s hands stay outside the sterile field.' }];
  const closing = K.closing({ sharps: [T, LID, LOC], sites: [ENTRY] });
  // (the kit's steps know nothing of the film's skin mark and wheal)
  for (const s of [...opening, ...closing]) { const e = s.enter; s.enter = () => { e?.(); dot.visible = wheal.visible = false; }; }

  return {
    title: 'Epidural injection',
    chapters: [
      { title: 'Opening', steps: opening },
      { title: 'The view', steps: view },
      { title: 'The needle in', steps: needleIn },
      { title: 'Creating the space', steps: theSpace },
      { title: 'Confirm and inject', steps: inject },
      { title: 'Closing', steps: closing },
    ],
  };
}
