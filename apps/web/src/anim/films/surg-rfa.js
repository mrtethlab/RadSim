/* SURGICAL ANIMATIONS: radiofrequency ablation (RFA), continuous and pulsed, of the nerves that
   carry facet and sacroiliac pain: the lumbar medial branch, the sacral lateral branches and the
   cervical medial branch. The child prone, its LEFT side treated throughout (the kit's obliques
   turn the receptor over its left).

   The film: the opening (with the grounding pad); the lumbar spine (AP, the endplates flattened,
   the C turned into the Scottie dog, the target at the junction of the superior articular and
   transverse processes, a spare needle and a spot image to mark the skin, the cannula down the
   beam to bone, the lateral for depth); the tests (impedance, sensory 50 Hz, motor 2 Hz); the
   lesions (lidocaine through the cannula, continuous RF at 80 °C, then pulsed RF at 42 °C for
   contrast); the sacrum (tilted so the ala clears L5 and the posterior foramina line up, the
   lateral branches at the foramina's lateral rims); the cervical spine (the 'American flag', the
   cannula to the waist of the articular pillar, the lateral: not anterior to the pillar); the
   closing (the pad off as well).

   Targets are the kit's landmarks moved onto bone: near each landmark, the point where a ray down
   the beam first meets solid bone (4 mm of it or more, not a stray voxel; measured in the browser
   with the kit's tissue crops, K.tissuesAlong), so the cannula ends on bone as it should. */
import { buildKit, VIEWS, LANDMARKS } from './surg/kit.js';

const D = Math.PI / 180;

export async function build(api) {
  const K = await buildKit(api, { patient: 'child', region: 'lumbar', rfa: true });
  const { span, px } = api;
  const v3 = K.v3, LM = LANDMARKS.child, room = K.room;
  const gen = K.props.gen, genCable = K.props.genCable;

  // ---- poses and the beam
  const pose = (orbital, tilt) => ({ orbital, tilt });
  const LV = VIEWS.lumbar, SV = VIEWS.sacrum, CV = VIEWS.cervical;
  const AP = pose(0, 0), FLAT = LV.apFlat, SCOTTIE = LV.scottie, LLAT = LV.lateral;
  const SAP = SV.ap, FORAM = SV.foramina;
  const CAP = CV.ap, CTILT = pose(0, CV.flag.tilt), FLAG = CV.flag, CLAT = CV.lateral;
  // the beam's way (source to receptor) at a pose; a needle down the beam goes against it
  const beam = (p) => { const o = p.orbital * D, t = p.tilt * D; return [Math.sin(o), Math.cos(o) * Math.cos(t), Math.cos(o) * Math.sin(t)]; };
  const down = (p) => v3.mul(beam(p), -1);

  // ---- the targets (the patient's frame, cm), on bone
  // lumbar: the left L4 medial branch, where the transverse process meets the superior articular
  // process (LM.L4.mbL moved 0.5 cm, to where its ray down the Scottie view's beam meets solid bone)
  const tL4 = [2.71, 1.57, 14.7];
  // sacral: the lateral rims of the left S1-S3 posterior foramina (from 0.5 cm lateral of each
  // opening, on the bone down the beam of the foramina view)
  const tS = [[2.34, 3.8, 9.2], [1.36, 3.51, 7.59], [1.66, 5.63, 6.8]];
  // cervical: the waist of the left C4 articular pillar, its posterolateral face
  const tC4 = [2.32, 1.16, 50.59];
  const eL4 = K.entry(tL4, down(SCOTTIE)), eS = tS.map((t) => K.entry(t, down(FORAM))), eC4 = K.entry(tC4, down(FLAG));

  // the nerves the crops do not hold, painted into the sections: the medial branch running over
  // the root of the transverse process (head to foot, beside the tip), the sacral lateral branches
  // leaving each foramen's rim, the cervical medial branch round the pillar's waist
  const run = (p, off, along, n = 6, r = 0.16) => Array.from({ length: n }, (_, i) => ({ at: v3.add(v3.add(p, off), v3.mul(along, (i - (n - 1) / 2) * 0.16)), r, tissue: 'nerve' }));
  const nervesL4 = run(tL4, [0.22, 0.12, 0], v3.norm([-0.3, 0, -1]), 9);
  const nervesS = tS.map((t) => run(t, [0.7, 0.12, -0.3], v3.norm([1, 0, -0.6]), 7));
  const nervesC4 = run(tC4, [0.14, 0.1, 0], v3.norm([0, 0.3, -1]), 7);

  // the prep and the drape: one window over the lumbar and sacral entries, another on the neck
  const siteLS = [(eL4[0] + eS[2][0]) / 2, 0, (eL4[2] + eS[2][2]) / 2];
  const siteC = [eC4[0], 0, eC4[2]];
  let siteNow = null;
  const useSite = (p, hole) => {
    if (siteNow === p) return;
    siteNow = p;
    K.setSite(p);
    room.drape.site([p[0], K.top(p[0], p[2]) ?? 0, p[2]], { hole });
  };
  const lumbarSite = () => useSite(siteLS, [14, 18]);
  const neckSite = () => useSite(siteC, [9, 9]);
  lumbarSite();

  // ---- the instruments
  const loc = K.needle('locator');
  const cL4 = K.needle('cannula');
  const cS = [K.needle('cannula'), K.needle('cannula'), K.needle('cannula')];
  const cC4 = K.needle('cannula');
  const probeC = K.probe();                     // the continuous probe (reusable: re-packed)
  const probeP = K.probe();                     // the pulsed probe (single use: the sharps)
  const syr = K.syringe({ ml: 3, color: 0xf4f8fb });
  cL4.place(eL4, tL4); cC4.place(eC4, tC4); cS.forEach((c, i) => c.place(eS[i], tS[i]));
  const lido = K.vial('lidocaine');
  lido.g.visible = true;

  // the probes go back in the wrap at the closing (re-parented): bring them home first
  const home = (pr) => { if (pr.g.parent !== room.pat) room.pat.add(pr.g); return pr; };
  // a cannula in place, its stylet in (k 1) or out
  const at = (N, f = 1, stylet = 1) => { N.advance(f); N.stylet(stylet); return N; };
  // a probe seated (k) in a cannula, its cable to the generator
  const sock = gen.socket(0);
  const seat = (pr, N, k) => {
    home(pr);
    K.seat(pr, N, k);
    genCable.visible = true;
    genCable.userData.set(K.wp(pr.g, [0, 8, pr.L + 20]), K.wp(gen.g, [sock.x, sock.y, sock.z]), 30);
  };

  // ---- the procedure's start: the region aimed, the room as the opening left it, the site
  const begin = (region) => {
    K.aim(region);
    K.reset('procedure');
    if (region === 'cervical') neckSite(); else lumbarSite();
    lido.g.visible = true;
  };

  // ---- the 8-bit panels: the live image (right, big), the section (left), the generator (left)
  const IMG = 116;
  let shot = null;                             // the image's at(p) this frame
  const inset = (t, { needles = [], seed = 0, label = null, a = 1 } = {}) => {
    K.monitor.show({ needles, seed: seed + Math.floor(t * 8), label });
    shot = K.monitor.blit(px, px.W - IMG - 6, 6, IMG, { a });
    return shot;
  };
  // brackets round a point on the image (a box of s pixels); the caption names it
  const pin = (p, t, s = 9, color = 'yellow') => {
    const q = shot && shot(p);
    if (q) api.mark([q[0] - s / 2, q[1] - s / 2, s, s], color, t);
  };
  const SEC = { x: 6, y: 6, w: 90, h: 76 };
  const ZOOM = 0.05;                            // cm per pixel, close round the tip (the crop's own is 0.15)
  const section = (N, o = {}) => K.section({ needle: N, ...SEC, across: [1, 0, 0], ...o });
  // the active tip's middle (the cannula's last cm is bare)
  const active = (N) => v3.sub(N.tip(), v3.mul(N.dir, 0.5));
  const probeLine = (N) => ({ from: v3.sub(N.tip(), v3.mul(N.dir, 9)), to: N.tip(), color: 'white' });
  // the lesion: an ellipsoid of coagulation round the active tip (three overlapping balls along it)
  // (the soft tissue cooked, the nerve in it browned; the bone it lies on left as it is)
  const SOFT = ['muscle', 'fat', 'soft', 'capsule', 'flavum', 'vessel'];
  const lesion = (N, k) => (k <= 0.01 ? [] : [0.15, 0.5, 0.85].flatMap((s) => {
    const c = v3.sub(N.tip(), v3.mul(N.dir, s));
    return [{ at: c, r: 0.4 * k, color: 'dkred', tissue: SOFT, a: 0.9 }, { at: c, r: 0.45 * k, color: 'brown', tissue: ['nerve'], a: 1.2 }];
  }));

  /* The generator: its own screen (3D) and the same numbers on the 8-bit layer, under the
     section (or at the top left when no section shows). */
  const readout = (s, y = SEC.y + SEC.h + 6) => {
    gen.screen({ ...s, temp: s.temp ?? 37 });
    const x = 6, w = 90, h = 38;
    px.rect(x - 1, y - 1, w + 2, h + 2, 'black', 0.85);
    px.frame(x - 1, y - 1, w + 2, h + 2, 'dkgrey');
    api.keepOut([x - 1, y - 1, w + 2, h + 2]);
    px.text(s.mode || 'RF', x + 3, y + 3, s.on ? 'orange' : 'cyan');
    if (s.on) px.rect(x + w - 6, y + 3, 3, 3, (Math.floor(s.time * 4) % 2) ? 'red' : 'orange');
    px.text(s.temp == null ? '--°C' : `${Math.round(s.temp)}°C`, x + 3, y + 11, 'white', 1, 2);
    px.text(s.ohms ? `${Math.round(s.ohms)} OHM` : '--- OHM', x + w - 3, y + 11, 'grey', 1, 1, 'right');
    if (s.volts) px.text(`${s.volts.toFixed(1)} V`, x + w - 3, y + 18, 'grey', 1, 1, 'right');
    if (s.hz) px.text(s.ms ? `${s.hz} HZ ${s.ms} MS` : `${s.hz} HZ`, x + w - 3, y + 25, 'grey', 1, 1, 'right');
    const m = Math.floor((s.time || 0) / 60), sec = Math.floor((s.time || 0) % 60);
    px.text(`${m}:${String(sec).padStart(2, '0')}`, x + 3, y + 29, 'white');
  };

  // ---- the cameras
  // the C-arm and the patient, from the operator's side
  const wide = (centre, d = 9) => {
    const c = K.toRoom(centre), look = [c[0] - 30, c[1] + 15, c[2] - 10];
    return [[0, [c[0] + 190, c[1] + 125, c[2] - 150], look, 40], [d, [c[0] + 172, c[1] + 108, c[2] - 128], look, 40]];
  };
  // the needle's site, close
  const near = (p, d = 10, k = 1) => {
    const c = K.toRoom(p);
    // from the foot of the table, off the operator's side: the receptor over the site stays out of shot
    return [[0, [c[0] + 18 * k, c[1] + 21 * k, c[2] - 29 * k], c, 38], [d, [c[0] + 14 * k, c[1] + 16 * k, c[2] - 22 * k], c, 36]];
  };

  // the sacrum from over the operator's shoulder, higher: the cannulae fanned into it
  const over = (p, d) => { const c = K.toRoom(p); return [[0, [c[0] + 30, c[1] + 38, c[2] - 30], c, 38], [d, [c[0] + 24, c[1] + 31, c[2] - 23], c, 36]]; };

  // ---- sounds: the fluoro pulses of a shot, the stimulator's ticks
  const pulses = (...ts) => ts.map((c) => [c, K.sfx.pulse]);
  const ticks = (a, b, hz) => { const out = []; for (let c = a; c < b; c += 1 / Math.min(hz, 4)) out.push([c, () => K.sfx.stim(hz)]); return out; };

  /* ================================================================= THE LUMBAR SPINE */
  const lumbar = [
    {
      title: 'AP: the endplates flattened', dur: 11, scale: '1 m',
      enter() { begin('lumbar'); K.carm.set(AP); },
      cam: wide(tL4, 11),
      cues: pulses(0.6, 4, 8.6),
      frame(t) {
        K.carm.ease(AP, FLAT, span(t, 3, 8));
        K.carm.beam(0.5);
        inset(t, { seed: 10, label: 'AP' });
        if (t > 8.5) pin(LM.L4.body, t, 20);
      },
      caption: [
        { from: 0.5, to: 4.5, text: 'The <b>AP</b> first: the spinous processes on the midline, the pedicles paired and level.' },
        { from: 4.5, to: 11, text: 'Tilted toward the head until the <b>L4 endplates</b> are single flat lines: the beam runs along the disc, not across it.' },
      ],
    },
    {
      title: 'The oblique: the Scottie dog', dur: 19, scale: '1 m',
      enter() { begin('lumbar'); K.carm.set(FLAT); },
      cam: wide(tL4, 19),
      cues: pulses(0.6, 3.5, 6.5, 9.5),
      frame(t) {
        K.carm.ease(FLAT, SCOTTIE, span(t, 0.8, 6));
        K.carm.beam(0.5);
        inset(t, { seed: 30, label: 'OBL L' });
        const P = LM.L4.pedicleL;
        if (t > 6.5 && t < 9.5) pin(P, t, 9);
        if (t > 9.5 && t < 12.5) pin(v3.add(P, [-0.1, 0.9, -0.7]), t, 9);
        if (t > 12.5) pin(tL4, t, 7, 'orange');
      },
      caption: [
        { from: 0.5, to: 6.5, text: 'Rotated about <b>30°</b> toward the left, the endplates kept flat: the left posterior elements draw a <b>Scottie dog</b>.' },
        { from: 6.5, to: 9.5, text: 'Its <b>eye</b>: the pedicle, end on.' },
        { from: 9.5, to: 12.5, text: 'Its <b>neck</b>: the pars interarticularis.' },
        { from: 12.5, to: 19, text: 'The target: where the <b>superior articular process</b> (the ear) meets the <b>transverse process</b> (the nose). The <b>medial branch</b> crosses there.' },
      ],
    },
    {
      title: 'A spare needle and a spot image', dur: 10, scale: '10 cm',
      enter() { begin('lumbar'); K.carm.set(SCOTTIE); loc.lay(eL4, [0.6, 0, 1]); },
      cam: near(eL4, 10, 1.4),
      cues: [[1.2, K.sfx.drop], ...pulses(3, 3.3)],
      frame(t) {
        // the spare needle laid on the skin, its tip over the target in the image
        const k = span(t, 0.5, 2.5), from = v3.add(eL4, [2, 0, 3]);
        loc.lay(v3.lerp(from, eL4, k), [0.6, 0, 1]);
        K.carm.beam(t > 3 && t < 3.6 ? 0.8 : 0.25);
        const s = { needles: [loc.segment()], seed: 50, label: 'OBL L' };
        if (t < 3) K.monitor.show({ ...s, seed: 50 }); else { inset(3, s); if (t > 3.6) K.monitor.spot('SPOT'); }
        if (t > 3) pin(tL4, t, 7, 'orange');
      },
      caption: [
        { from: 0.5, to: 4.5, text: 'A <b>spare needle</b> laid on the skin; one <b>spot image</b>, not continuous fluoroscopy.' },
        { from: 4.5, to: 10, text: 'Its tip sits over the target: the skin mark is where the beam, and so the cannula, will go in.' },
      ],
    },
    {
      title: 'Local anaesthetic in the skin', dur: 8, scale: '10 cm',
      enter() { begin('lumbar'); K.carm.set(SCOTTIE); syr.set({ fill: 0.8 }); },
      cam: near(eL4, 8, 1.1),
      frame(t) {
        // the same small needle on a syringe, down the line of the beam, a wheal then the track
        loc.place(eL4, tL4);
        loc.advance(span(t, 0.8, 3.5) * 2 / v3.len(v3.sub(tL4, eL4)));
        K.attach(syr, loc, 1);
        syr.set({ fill: 0.8 - span(t, 3.5, 7) * 0.6 });
      },
      caption: [{ from: 0.5, to: 8, text: '<b>Lidocaine</b> raises a skin wheal and numbs the track along the same line.' }],
    },
    {
      title: 'The cannula down the beam', dur: 14, scale: '10 cm',
      enter() { begin('lumbar'); K.room.drape.set(0); K.carm.set(SCOTTIE); at(cL4, 0); },
      cam: near(tL4, 14, 0.9),
      cues: pulses(1, 4.5, 8, 11.5),
      frame(t) {
        at(cL4, span(t, 0.8, 11), 1);
        K.xray(span(t, 0.3, 1.5) * 0.9);
        K.carm.beam(0.3);
        inset(t, { needles: [cL4.segment()], seed: 70, label: 'OBL L' });
        if (t > 11) pin(tL4, t, 9, 'orange');
        section(cL4, { extras: nervesL4 });
      },
      caption: [
        { from: 0.5, to: 6, text: 'The <b>RF cannula</b>, insulated but for its last 10 mm, goes in parallel to the beam: on the screen it stays a <b>dot</b>.' },
        { from: 6, to: 14, text: 'Through skin, fat and multifidus until its tip touches <b>bone</b> at the target: bone first, then the depth.' },
      ],
    },
    {
      title: 'Lateral: the depth', dur: 13, scale: '1 m',
      enter() { begin('lumbar'); K.carm.set(SCOTTIE); at(cL4); },
      cam: wide(tL4, 13),
      cues: [[0.5, K.sfx.snap], ...pulses(5.6, 6)],
      frame(t) {
        K.carm.ease(SCOTTIE, LLAT, span(t, 0.6, 5.2));
        K.carm.beam(t > 5.4 ? 0.5 : 0.15);
        inset(t, { needles: [cL4.segment()], seed: 90, label: t > 5 ? 'LAT' : 'OBL L' });
        if (t > 6) pin(cL4.tip(), t, 9, 'orange');
      },
      caption: [
        { from: 0.5, to: 5.5, text: 'The C swung to a <b>lateral</b>: the oblique cannot show how deep the tip is.' },
        { from: 5.5, to: 13, text: 'The tip on bone at the root of the transverse process: no deeper, where the <b>foramen</b> and its root lie.' },
      ],
    },
  ];

  /* ================================================================= THE TESTS */
  const TEST_CAM = near(eL4, 10, 1.3);
  // the generator's screen, from where the operator stands (it faces the table)
  const GEN = (() => {
    const s = K.wp(gen.g, [-6, 82.5, 15.15]), f = K.wp(gen.g, [-6, 82.5, 16.15]), n = v3.sub(f, s);
    return { pos: [s[0] + n[0] * 30, s[1] + 14, s[2] + n[2] * 30 - 6], look: [s[0], s[1] - 1, s[2]] };
  })();
  // the needle, then the generator's screen from tA to tB
  const toGen = (tA, tB, end) => [TEST_CAM[0], [tA, ...TEST_CAM[1].slice(1)], [tB, GEN.pos, GEN.look, 40], [end, v3.add(GEN.pos, [3, -2, 2]), GEN.look, 38]];
  // the back and the left leg together: the multifidus twitches, the leg must not
  const BACK = (() => { const c = K.toRoom([4, 8, -6]); return [[0, [c[0] + 75, c[1] + 70, c[2] - 55], c, 40], [13, [c[0] + 66, c[1] + 62, c[2] - 46], c, 40]]; })();
  const testing = [
    {
      title: 'The probe in: impedance', dur: 9, scale: '10 cm',
      enter() { begin('lumbar'); K.carm.set(SCOTTIE); at(cL4); },
      cam: toGen(4.2, 6, 9),
      cues: [[1.5, K.sfx.snap], [5, K.sfx.drop]],
      frame(t) {
        cL4.stylet(1 - span(t, 0.6, 2.4));
        if (t > 2.4) cL4.stylet(-1);
        if (t > 2.6) seat(probeC, cL4, span(t, 2.6, 5));
        const ohm = t > 5 ? 320 + Math.sin(t * 3) * 6 : 0;
        readout({ mode: 'IMPEDANCE', temp: t > 5 ? 36.6 : null, ohms: ohm, on: false });
        section(cL4, { extras: nervesL4, cm: ZOOM, probe: t > 5 ? probeLine(cL4) : null });
      },
      caption: [
        { from: 0.5, to: 4.5, text: 'The stylet out, the <b>RF probe</b> in: its thermocouple reads the temperature at the tip.' },
        { from: 4.5, to: 9, text: 'The <b>impedance</b>, 200-400 Ω in tissue, proves the circuit through the patient to the grounding pad.' },
      ],
    },
    {
      title: 'Sensory test: 50 Hz', dur: 11, scale: '10 cm',
      enter() { begin('lumbar'); K.carm.set(SCOTTIE); at(cL4, 1, -1); seat(probeC, cL4, 1); },
      cam: TEST_CAM,
      cues: ticks(1, 9.5, 50),
      frame(t) {
        seat(probeC, cL4, 1);
        const v = Math.min(0.4, span(t, 1, 7, api.ease.linear) * 0.4);
        readout({ mode: 'SENSORY', temp: 37, ohms: 318, volts: v, hz: 50, time: Math.max(0, t - 1), on: t > 1 && t < 9.5 });
        const on = t > 1 && t < 9.5 ? v / 0.4 : 0;
        section(cL4, { extras: nervesL4, cm: ZOOM, probe: probeLine(cL4), glow: { at: cL4.tip(), r: 0.25, color: 'yellow', k: on * (0.5 + 0.5 * Math.sin(t * 40)) } });
      },
      caption: [
        { from: 0.5, to: 6, text: '<b>Sensory</b> stimulation at 50 Hz, the voltage raised slowly: the patient feels a familiar ache or tingle in the back.' },
        { from: 6, to: 11, text: 'Felt below about <b>0.5 V</b>: the tip lies close to the nerve.' },
      ],
    },
    {
      title: 'Motor test: 2 Hz', dur: 13, scale: '10 cm',
      enter() { begin('lumbar'); K.carm.set(SCOTTIE); at(cL4, 1, -1); seat(probeC, cL4, 1); },
      cam: BACK,
      cues: ticks(1, 11, 2),
      frame(t) {
        seat(probeC, cL4, 1);
        const v = Math.min(2, span(t, 1, 8, api.ease.linear) * 2);
        const live = t > 1 && t < 11;
        readout({ mode: 'MOTOR', temp: 37, ohms: 318, volts: v, hz: 2, time: Math.max(0, t - 1), on: live });
        // each 2 Hz pulse: the multifidus round the tip twitches
        const ph = (t - 1) * 2 % 1, twitch = live && v > 0.6 && ph < 0.25 ? 1 : 0;
        section(cL4, { extras: nervesL4, cm: ZOOM, probe: probeLine(cL4),
          fills: twitch ? [{ at: v3.add(cL4.tip(), [0, 1.0, 0]), r: 1.3, color: 'pink', tissue: ['muscle'], a: 0.8 }] : [] });
        // the skin over the multifidus jumps with each pulse; the leg (on the pad) does not
        if (twitch) api.mark(api.boxPx(cL4.g, 3, true) || [0, 0, 0, 0], 'pink', t);
        if (t > 7.5) {
          const a = api.toPx(K.toRoom([6, K.top(6, -10) ?? 4, -10])), b = api.toPx(K.toRoom([7, K.top(7, -45) ?? 4, -45]));
          api.mark([Math.min(a[0], b[0]) - 4, Math.min(a[1], b[1]) - 4, Math.abs(a[0] - b[0]) + 8, Math.abs(a[1] - b[1]) + 8], 'lime', t);
        }
      },
      caption: [
        { from: 0.5, to: 7.5, text: '<b>Motor</b> stimulation at 2 Hz up to about <b>2 V</b>: the <b>multifidus</b> twitches in time, as the medial branch supplies it.' },
        { from: 7.5, to: 13, text: 'Nothing in the <b>leg</b>: no root is near the tip. A leg twitch means move the cannula before any lesion.' },
      ],
    },
  ];

  /* ================================================================= THE LESIONS */
  const lesions = [
    {
      title: 'Lidocaine through the cannula', dur: 10, scale: '10 cm',
      enter() { begin('lumbar'); K.carm.set(SCOTTIE); at(cL4, 1, -1); syr.set({ fill: 0.6 }); },
      cam: TEST_CAM,
      frame(t) {
        // the probe out, the syringe on, the anaesthetic in, the probe back
        const out = span(t, 0.4, 2), back = span(t, 7.4, 9.2);
        if (t < 2.2) seat(probeC, cL4, 1 - out); else if (t > 7.2) seat(probeC, cL4, back); else { probeC.g.visible = false; genCable.visible = false; }
        if (t > 2.2 && t < 7.2) { K.attach(syr, cL4, span(t, 2.2, 3)); syr.set({ fill: 0.6 - span(t, 3.2, 6.4) * 0.4 }); } else syr.g.visible = false;
        const k = span(t, 3.2, 6.6);
        readout({ mode: 'STANDBY', temp: 37, ohms: 320 - k * 40, on: false });
        section(cL4, { extras: nervesL4, cm: ZOOM, probe: t > 7.4 ? probeLine(cL4) : null,
          fills: k > 0 ? [{ at: active(cL4), r: 0.15 + 0.6 * k, color: 'blue', a: 0.6 }] : [] });
      },
      caption: [
        { from: 0.5, to: 6.5, text: '<b>Lidocaine</b>, 0.5-1 mL down the cannula, before any heat: the lesion would hurt without it.' },
        { from: 6.5, to: 10, text: 'The probe back in; a minute for it to work.' },
      ],
    },
    {
      title: 'Continuous RF: heat', dur: 16, scale: '10 cm',
      enter() { begin('lumbar'); K.carm.set(SCOTTIE); at(cL4, 1, -1); },
      cam: toGen(3.5, 5.5, 16),
      cues: [[1, () => K.sfx.heat(true, 220)], [13.5, () => K.sfx.heat(false)]],
      frame(t) {
        seat(probeC, cL4, 1);
        // 90 s of generator time over 12 s of film: up to 80 °C, held, then off
        const time = span(t, 1, 13, api.ease.linear) * 90, on = t > 1 && t < 13;
        const temp = on ? 37 + 43 * Math.min(1, time / 15) : t < 1 ? 37 : 80 - 43 * span(t, 13, 15.5);
        readout({ mode: 'CONTINUOUS', temp, ohms: 300 - Math.min(1, time / 30) * 50, volts: on ? 17 + Math.sin(t * 2) : 0, time, on });
        const grow = span(t, 2, 12), hot = on ? Math.min(1, time / 15) : 1 - span(t, 13, 15.5);
        section(cL4, { extras: nervesL4, cm: ZOOM, probe: probeLine(cL4), fills: lesion(cL4, grow),
          glow: { at: active(cL4), r: 0.6 * Math.max(0.4, grow), color: 'orange', k: hot * (0.75 + 0.25 * Math.sin(t * 9)) } });
      },
      caption: [
        { from: 0.5, to: 6, text: '<b>Continuous RF</b>: current at about 500 kHz heats the tissue round the active tip to <b>80 °C</b>, held for <b>90 s</b>.' },
        { from: 6, to: 16, text: 'A <b>heat lesion</b> forms round the bare tip, a few mm wide, little beyond its end, and <b>coagulates</b> the medial branch. Months of relief, until it regrows.' },
      ],
    },
    {
      title: 'Pulsed RF: no lesion', dur: 16, scale: '10 cm',
      enter() { begin('lumbar'); K.carm.set(SCOTTIE); at(cL4, 1, -1); },
      cam: toGen(2.5, 4.5, 16),
      cues: ticks(2.5, 14, 2),
      frame(t) {
        // the single-use pulsed probe in the same cannula, for the contrast
        if (t < 2) seat(probeP, cL4, span(t, 0.2, 1.8)); else seat(probeP, cL4, 1);
        const time = span(t, 2.5, 14, api.ease.linear) * 120, on = t > 2.5 && t < 14;
        // 2 bursts a second, 20 ms each: shown slowed, each burst a flash; between them, it cools
        const ph = ((t - 2.5) * 2) % 1, burst = on && ph < 0.18;
        readout({ mode: 'PULSED', temp: on ? 40.5 + (burst ? 1.5 : 0.4) : 37, ohms: 310, volts: on ? 45 : 0, hz: 2, ms: 20, time, on });
        section(cL4, { extras: nervesL4, cm: ZOOM, probe: probeLine(cL4),
          glow: burst ? { at: cL4.tip(), r: 0.9, color: 'cyan', k: 1 - ph / 0.18 } : null });
      },
      caption: [
        { from: 0.5, to: 6.5, text: '<b>Pulsed RF</b> instead: <b>20 ms bursts, 2 a second</b>, for 120 s. The tissue cools between bursts and never passes <b>42 °C</b>.' },
        { from: 6.5, to: 16, text: 'No heat lesion: the strong field <b>modulates</b> pain signalling rather than destroying the nerve. Used near motor nerves or the dorsal root ganglion.' },
      ],
    },
  ];

  /* ================================================================= THE SACRUM */
  const sacrum = [
    {
      title: 'The sacrum: AP', dur: 9, scale: '1 m',
      enter() { begin('sacrum'); K.carm.set(SAP); },
      cam: wide(tS[0], 9),
      cues: pulses(0.6, 5),
      frame(t) {
        K.carm.beam(0.5);
        inset(t, { seed: 110, label: 'AP' });
        if (t > 4) pin([2.6, 4.5, 10.4], t, 16);
      },
      caption: [
        { from: 0.5, to: 4, text: 'The C moved down to the <b>sacrum</b>, straight AP.' },
        { from: 4, to: 9, text: 'The sacrum slopes away from the beam: L5 and the <b>sacral ala</b> overlap, and the foramina are foreshortened ovals.' },
      ],
    },
    {
      title: 'Tilted: the foramina lined up', dur: 17, scale: '1 m',
      enter() { begin('sacrum'); K.carm.set(SAP); },
      cam: wide(tS[0], 17),
      cues: pulses(0.6, 3.5, 6.5),
      frame(t) {
        K.carm.ease(SAP, FORAM, span(t, 0.8, 6.5));
        K.carm.beam(0.5);
        inset(t, { seed: 130, label: 'TILT' });
        const S = LM.sacrum;
        if (t > 7 && t < 11.5) pin([2.6, 4.5, 10.4], t, 16);
        if (t > 11.5) { pin(S.S1L, t, 8); pin(S.S2L, t, 8); pin(S.S3L, t, 8); pin(S.S1R, t, 8, 'blue'); pin(S.S2R, t, 8, 'blue'); pin(S.S3R, t, 8, 'blue'); }
      },
      caption: [
        { from: 0.5, to: 7, text: 'Tilted toward the head about <b>30°</b>, the beam runs along the sacrum\'s slope.' },
        { from: 7, to: 11.5, text: 'The <b>ala</b> separates from the body and transverse process of <b>L5</b>.' },
        { from: 11.5, to: 17, text: 'The posterior <b>S1-S3 foramina</b> line up as round holes in two columns: the left ones are the targets.' },
      ],
    },
    {
      title: 'Cannulae at the lateral rims', dur: 15, scale: '10 cm',
      enter() { begin('sacrum'); K.room.drape.set(0); K.carm.set(FORAM); cS.forEach((c) => at(c, 0)); },
      cam: over(tS[1], 15),
      cues: pulses(1, 4.5, 8, 11.5, 13),
      frame(t) {
        K.xray(span(t, 0.3, 1.5) * 0.9);
        K.carm.beam(0.3);
        cS.forEach((c, i) => at(c, span(t, 0.8 + i * 3.6, 3.8 + i * 3.6), 1));
        const cur = Math.min(2, Math.floor(Math.max(0, t - 0.8) / 3.6));
        inset(t, { needles: cS.filter((c, i) => t > 0.8 + i * 3.6).map((c) => c.segment()), seed: 150, label: 'TILT' });
        if (t > 11.5) tS.forEach((p) => pin(p, t, 7, 'orange'));
        section(cS[cur], { extras: nervesS[cur] });
      },
      caption: [
        { from: 0.5, to: 7, text: 'The <b>lateral branches</b> leave each posterior foramen and run out across the sacrum toward the sacroiliac joint.' },
        { from: 7, to: 15, text: 'A cannula down the beam to bone at the <b>lateral rim</b> of S1, S2 and S3: never into the hole, where the sacral root lies.' },
      ],
    },
    {
      title: 'Test, then lesion', dur: 15, scale: '10 cm',
      enter() { begin('sacrum'); K.room.drape.set(0); K.carm.set(FORAM); cS.forEach((c) => at(c, 1, -1)); },
      cam: over(tS[0], 15),
      cues: [...ticks(0.8, 5, 2), [6.5, () => K.sfx.heat(true, 240)], [14, () => K.sfx.heat(false)]],
      frame(t) {
        K.xray(0.9);
        seat(probeC, cS[0], 1);
        const N = cS[0];
        if (t < 5.5) {
          readout({ mode: 'MOTOR', temp: 37, ohms: 290, volts: Math.min(2, span(t, 0.8, 4, api.ease.linear) * 2), hz: 2, time: Math.max(0, t - 0.8), on: t > 0.8 });
          section(N, { extras: nervesS[0], cm: ZOOM, probe: probeLine(N) });
        } else {
          const time = span(t, 6.5, 14, api.ease.linear) * 90, on = t > 6.5 && t < 14;
          readout({ mode: 'CONTINUOUS', temp: on ? 37 + 43 * Math.min(1, time / 15) : (t < 6.5 ? 37 : 80 - span(t, 14, 15) * 40), ohms: 270, volts: on ? 18 : 0, time, on });
          section(N, { extras: nervesS[0], cm: ZOOM, probe: probeLine(N), fills: lesion(N, span(t, 7, 13)), glow: on ? { at: active(N), r: 0.5, color: 'orange', k: 0.8 } : null });
        }
      },
      caption: [
        { from: 0.5, to: 5.5, text: 'The motor test at each cannula: <b>no leg or foot</b> movement, so no sacral root is in reach.' },
        { from: 5.5, to: 15, text: 'Lidocaine, then a <b>continuous</b> lesion at each. Two or three lesions round each rim cover branches that leave at different points.' },
      ],
    },
  ];

  /* ================================================================= THE CERVICAL SPINE */
  const cervical = [
    {
      title: 'The neck: the American flag', dur: 21, scale: '1 m',
      enter() { begin('cervical'); K.carm.set(CAP); },
      cam: wide(tC4, 21),
      cues: pulses(0.6, 4, 8, 11.2),
      frame(t) {
        if (t < 6.5) K.carm.ease(CAP, CTILT, span(t, 1.5, 5.5)); else K.carm.ease(CTILT, FLAG, span(t, 6.5, 11));
        K.carm.beam(0.5);
        inset(t, { seed: 170, label: t < 6.5 ? 'AP' : 'OBL L' });
        if (t > 11 && t < 15.5) pin(LM.C4.body, t, 26);
        if (t > 15.5) pin(tC4, t, 9, 'orange');
      },
      caption: [
        { from: 0.5, to: 6.5, text: 'Up to the <b>neck</b>, prepped and draped the same way: AP, then tilted about <b>15°</b> toward the head.' },
        { from: 6.5, to: 11, text: 'Turned about <b>36°</b> toward the left, onto the left articular pillars.' },
        { from: 11, to: 15.5, text: 'The <b>American flag</b>: the bodies\' flat endplates stacked like stripes...' },
        { from: 15.5, to: 21, text: '...the <b>articular pillars</b> a column in the corner. The target: the <b>waist</b> of the C4 pillar.' },
      ],
    },
    {
      title: 'The cannula to the pillar', dur: 13, scale: '10 cm',
      enter() { begin('cervical'); K.room.drape.set(0); K.carm.set(FLAG); at(cC4, 0); },
      cam: near(tC4, 13, 0.9),
      cues: pulses(1, 5, 9),
      frame(t) {
        at(cC4, span(t, 0.8, 10), 1);
        K.xray(span(t, 0.3, 1.5) * 0.9);
        K.carm.beam(0.3);
        inset(t, { needles: [cC4.segment()], seed: 190, label: 'OBL L' });
        if (t > 10) pin(tC4, t, 9, 'orange');
        section(cC4, { extras: nervesC4 });
      },
      caption: [
        { from: 0.5, to: 6, text: 'Down the beam to the <b>waist of the pillar</b>, where the medial branch wraps round it.' },
        { from: 6, to: 13, text: 'The neck is thin: only a couple of centimetres to bone, and the vertebral artery and the roots lie just in front of the pillar.' },
      ],
    },
    {
      title: 'Lateral: not past the pillar', dur: 13, scale: '1 m',
      enter() { begin('cervical'); K.carm.set(FLAG); at(cC4); },
      cam: wide(tC4, 13),
      cues: pulses(5.8, 6.2),
      frame(t) {
        K.carm.ease(FLAG, CLAT, span(t, 0.6, 5.4));
        K.carm.beam(t > 5.6 ? 0.5 : 0.15);
        inset(t, { needles: [cC4.segment()], seed: 210, label: t > 5 ? 'LAT' : 'OBL L' });
        if (t > 6) pin(cC4.tip(), t, 9, 'orange');
      },
      caption: [
        { from: 0.5, to: 5.5, text: 'A <b>lateral</b> to check the depth.' },
        { from: 5.5, to: 13, text: 'The tip over the <b>centre of the pillar</b>, never in front of it: there lie the root and the vertebral artery.' },
      ],
    },
    {
      title: 'Test, then lesion', dur: 16, scale: '10 cm',
      enter() { begin('cervical'); K.room.drape.set(0); K.carm.set(CLAT); at(cC4, 1, -1); },
      cam: near(tC4, 16, 1.0),
      cues: [...ticks(0.8, 5, 2), [7, () => K.sfx.heat(true, 230)], [14.5, () => K.sfx.heat(false)]],
      frame(t) {
        K.xray(0.9);
        seat(probeC, cC4, 1);
        if (t < 5.5) {
          readout({ mode: 'MOTOR', temp: 37, ohms: 340, volts: Math.min(2, span(t, 0.8, 4, api.ease.linear) * 2), hz: 2, time: Math.max(0, t - 0.8), on: t > 0.8 });
          section(cC4, { extras: nervesC4, cm: ZOOM, probe: probeLine(cC4) });
        } else {
          const time = span(t, 7, 14.5, api.ease.linear) * 90, on = t > 7 && t < 14.5;
          const k = span(t, 5.5, 7);
          readout({ mode: on ? 'CONTINUOUS' : 'STANDBY', temp: on ? 37 + 43 * Math.min(1, time / 15) : (t < 7 ? 37 : 80 - span(t, 14.5, 15.5) * 40), ohms: 330 - k * 30, volts: on ? 16 : 0, time, on });
          section(cC4, { extras: nervesC4, cm: ZOOM, probe: probeLine(cC4),
            fills: [...(k > 0 && t < 7.5 ? [{ at: active(cC4), r: 0.15 + 0.4 * k, color: 'blue', a: 0.6 }] : []), ...lesion(cC4, span(t, 7.5, 13.5))],
            glow: on ? { at: active(cC4), r: 0.45, color: 'orange', k: 0.8 } : null });
        }
      },
      caption: [
        { from: 0.5, to: 5.5, text: 'Motor test: the neck muscles twitch, <b>nothing in the arm</b> or shoulder.' },
        { from: 5.5, to: 16, text: 'Lidocaine, then <b>80 °C for 90 s</b>: the medial branch coagulated on the pillar\'s waist.' },
      ],
    },
  ];

  /* ================================================================= OPENING AND CLOSING */
  // the opening at the lumbar region, its window over the lumbar and sacral sites
  const opening = K.opening({ needles: ['cannula'] });
  for (const s of opening) { const e = s.enter; s.enter = () => { K.aim('lumbar'); lumbarSite(); e(); }; }

  const closing = K.closing({ sharps: [loc, cL4, ...cS, cC4, probeP], repack: [probeC], sites: [eL4, ...eS, eC4] });
  for (const s of closing) { const e = s.enter; s.enter = () => { K.aim('lumbar'); lumbarSite(); e(); }; }
  // seven sharps, 1.4 s apart
  closing[0].dur = 11;
  closing[0].caption = [{ from: 0.6, to: 11, text: 'The cannulae, the spare needle and the single-use <b>pulsed</b> probe go straight into the <b>sharps container</b>, tip first, never recapped.' }];
  // the grounding pad off before the dressings, the skin under it checked
  const padSpot = [6, K.top(6, -24) ?? 4, -24];
  closing.splice(3, 0, {
    title: 'The grounding pad off', dur: 7, scale: '10 cm',
    enter() { K.aim('lumbar'); lumbarSite(); K.reset('dressing'); },
    cam: (() => { const c = K.toRoom(padSpot); return [[0, [c[0] + 60, c[1] + 55, c[2] - 30], c, 40], [7, [c[0] + 45, c[1] + 40, c[2] - 18], c, 38]]; })(),
    cues: [[1.5, K.sfx.rustle]],
    frame(t) { K.padOn(1 - span(t, 0.8, 3.4)); if (t > 3.6) api.mark(api.boxPx(K.props.pad.g, 2) || [0, 0, 0, 0], 'yellow', t); },
    caption: [{ from: 0.6, to: 7, text: 'The <b>grounding pad</b> peeled off slowly and the skin under it checked: a burn there means poor contact.' }],
  });
  // every puncture, the neck's too: seen from higher up the back
  const dress = closing[closing.length - 1];
  {
    const c = K.toRoom([2, 6, 30]);
    dress.cam = [[0, [c[0] + 95, c[1] + 85, c[2] - 30], c, 40], [6, [c[0] + 85, c[1] + 75, c[2] - 22], c, 38]];
    dress.dur = 8;
  }

  return {
    title: 'Radiofrequency ablation',
    chapters: [
      { title: 'Opening', steps: opening },
      { title: 'L-spine', steps: lumbar },
      { title: 'Testing', steps: testing },
      { title: 'Lesioning', steps: lesions },
      { title: 'S-spine', steps: sacrum },
      { title: 'C-spine', steps: cervical },
      { title: 'Closing', steps: closing },
    ],
  };
}
