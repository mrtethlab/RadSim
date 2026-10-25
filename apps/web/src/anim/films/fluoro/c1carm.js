/* FLUOROSCOPY FILM, chapter 1: the C-arm. The suite and the machine; the tube under the table and
   the receptor over the patient (and why that way up); the C's movements about the isocentre; the
   monitor cart; the foot pedal that runs the beam; the tube in its housing, the beam leaving it. */
import { setOpacity } from '../../kit/stage.js';
import { makeParticles, drawParticles, coneDir } from '../../kit/flux.js';
import { keVColor, tungstenSpectrum } from '../../kit/micro.js';
import { boxAt, boxLocal } from './util.js';
import { ISO, OEC } from './suite.js';

export function carmChapter(api, S) {
  const { px, sfx, span } = api;
  const U = S.suite, L = S.live;
  // the screens' live image: a field over the upper abdomen, a new noisy frame each pulse (15 pps)
  const ABD = { cx: L.IMG.W / 2, cy: 228 };
  const liveAt = (t, on = true) => S.screenFrame('abd' + (on ? Math.floor(t * 15) : 'hold'), { ...ABD, seed: on ? 100 + Math.floor(t * 15) : 7 });
  const refImg = () => S.screenFrame('chestref', { cx: L.IMG.W / 2 + 6, cy: 150, seed: 3, detected: 3000 });
  const towerPos = U.tower.group.position;
  const screenAt = (i) => U.screens[i]?.getWorldPosition(new api.THREE.Vector3()).toArray() ?? [towerPos.x, 72, towerPos.z];
  const isoPx = () => api.toPx(ISO);
  // the C itself: its ring, receptor and tube housing, in its own frame (its box follows it round)
  const markC = () => boxLocal(api, U.carm.c, [-82, -80, -18], [49, 82, 18]);

  // photons up out of the focal spot: an 80 kV spectrum, a cone just filling the field; a loop of P seconds
  const P = 4, spec = tungstenSpectrum(80, 0.35);
  const sampleE = (r) => { for (let k = 0; k < 200; k++) { const E = 15 + r() * 65; if (r() < spec(E)) return E; } return 50; };
  const focal = () => U.inC(0, -OEC.SRC_ISO, 0);
  const beamUp = makeParticles(420, 61, (i, r) => ({ i, t0: (i / 420) * P, from: [0, 0, 0], dir: coneDir(r, [0, 1, 0], 0.11), v: 60, end: 22 + r() * 30, E: sampleE(r) }));
  const drawBeamUp = (t) => {
    const f = focal();
    for (const tt of [t % P, (t % P) + P]) {
      drawParticles(api, beamUp.map((p) => ({ ...p, from: f })), tt, (p) => ({ kind: 'photon', color: keVColor(p.E), flash: false }), { tail: 4 });
    }
  };

  const steps = [
    {
      title: 'The fluoroscopy suite', dur: 11, fadeIn: 0.6, scale: '1 m',
      enter() { S.reset(); U.skinAlpha(1); S.screens(refImg(), refImg()); },
      cam: [[0, [300, 170, 230], [-50, -10, -40], 40], [11, [210, 120, 170], [-40, -5, -30], 40]],
      frame(t) { if (t > 4.6) api.mark(markC(), 'yellow', t); },
      caption: [
        { from: 0.8, to: 4.6, text: '<b>Fluoroscopy</b>: x-ray imaging in real time, a stream of low-dose images watched live as things move.' },
        { from: 4.6, to: 11, text: 'Here a mobile <b>C-arm</b> stands across a radiolucent table, its monitor cart at the foot.' },
      ],
    },
    {
      title: 'Tube under, receptor over', dur: 14, scale: '10 cm',
      enter() { S.reset(); U.skinAlpha(0.55); S.screens(refImg(), null); },
      cam: [[0, [95, 25, 285], [-10, 8, 0], 40], [14, [75, 18, 260], [-8, 8, 0], 40]],
      frame(t) {
        U.setBeam({ a: span(t, 0.5, 1.5) });
        if (t < 5) api.mark(U.parts.tube, 'cyan', t);
        else if (t < 9.5) api.mark(U.parts.ii, 'yellow', t);
        else api.mark(U.parts.tube, 'orange', t);
      },
      caption: [
        { from: 0.8, to: 5, text: 'Under the table, the <b>x-ray tube</b> and its collimator, aimed straight up through the tabletop and the patient.' },
        { from: 5, to: 9.5, text: 'Above the patient, the <b>image intensifier</b>: on the other end of the C, facing the tube at a fixed 99 cm (the SID).' },
        { from: 9.5, to: 14, text: 'Tube <b>under</b> the table: the patient’s strongest scatter, back toward the tube, goes down at the floor, not up at the staff’s eyes.' },
      ],
    },
    {
      title: 'Moving the C', dur: 16, scale: '1 m',
      enter() { S.reset(); U.skinAlpha(0.8); S.screens(refImg(), null); },
      cam: [[0, [270, 110, 250], [-35, 0, 0], 40], [16, [240, 130, 230], [-35, 0, 0], 40]],
      cues: [[1, () => sfx.power()], [6.5, () => sfx.power()]],
      frame(t) {
        const orb = 42 * Math.sin(Math.PI * 2 * span(t, 1, 5.5, api.ease.linear)) * Math.min(1, span(t, 1, 1.6) * 2) ;
        const tilt = 25 * Math.sin(Math.PI * 2 * span(t, 6.5, 11, api.ease.linear));
        U.setPose({ orbital: orb, tilt });
        U.setBeam({ a: 0.8 });
        const moving = (t > 1 && t < 5.5) || (t > 6.5 && t < 11);
        sfx[moving ? 'hold' : 'stop']('motor', 70 + Math.abs(orb + tilt) * 2, 0.025, 'square');
        api.keepOut(markC());                                   // the C itself is what moves: keep the caption off it
        if (t > 1 && t < 6) api.mark(markC(), 'yellow', t);
        else if (t > 6 && t < 11.2) api.mark(boxLocal(api, U.carm.holder, [-99, -15, -15], [-74, 15, 15]), 'cyan', t);
        // the isocentre: a cross that never moves
        const [x, y] = isoPx(), k = span(t, 11, 11.6);
        if (k > 0) { px.rect(x - 4, y, 9, 1, 'yellow', k); px.rect(x, y - 4, 1, 9, 'yellow', k); api.mark([x - 6, y - 6, 12, 12], 'yellow', t); }
      },
      caption: [
        { from: 1, to: 6, text: '<b>Orbital</b> rotation: the C slides round in its holder, swinging tube and receptor about the patient’s long axis.' },
        { from: 6, to: 11.2, text: '<b>Tilt</b>: the holder turns on the arm, angling the beam toward the head or the feet.' },
        { from: 11.2, to: 16, text: 'Here both turn about one point, the <b>isocentre</b>: whatever lies there stays in the middle of the field.' },
      ],
    },
    {
      title: 'The monitor cart', dur: 11, scale: '10 cm',
      enter() { S.reset(); },
      cam: (t) => {
        // square to the cart, between its two screens, backing off a little
        const a = screenAt(0), b = screenAt(1), s = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        const d = [Math.sin(U.tower.group.rotation.y + Math.PI / 2), 0, Math.cos(U.tower.group.rotation.y + Math.PI / 2)];
        const k = 175 + span(t, 0, 11) * 25;
        return { pos: [s[0] + d[0] * k + 20, s[1] + 30, s[2] + d[2] * k], look: [s[0], s[1] - 18, s[2]], fov: 38 };
      },
      frame(t) {
        S.screens(liveAt(t, true), refImg());
        if (t > 1 && t < 5.5) api.mark(U.screens[0], 'lime', t);
        if (t > 5.5) api.mark(U.screens[1], 'cyan', t);
      },
      caption: [
        { from: 1, to: 5.5, text: 'The <b>monitor cart</b>: the live image on one screen, a new frame with every pulse of x-rays.' },
        { from: 5.5, to: 11, text: 'On the other, a stored <b>reference image</b> to compare with. Images are processed here, stored, and sent on to the archive (PACS).' },
      ],
    },
    {
      title: 'The foot pedal', dur: 13, scale: '10 cm',
      enter() { S.reset(); U.staff.g.visible = true; U.staff.apron.visible = U.staff.collar.visible = true; U.skinAlpha(1); },
      cam: [[0, [100, -30, 55], [40, -84, -40], 40], [5.5, [92, -34, 46], [40, -84, -40], 40], [9, [150, 110, 200], [-10, -10, -45], 40], [13, [140, 115, 190], [-10, -10, -45], 40]],
      cues: [[1.6, () => sfx.click()], [8.6, () => sfx.click()]],
      frame(t) {
        const down = span(t, 1.5, 1.8) * (1 - span(t, 8.5, 8.8));
        U.press(down);
        const on = t > 1.8 && t < 8.6;
        U.setBeam({ a: on ? 1 : 0 });
        sfx[on ? 'hold' : 'stop']('beam', 96, 0.02, 'square');
        // the live screen: frames while the beam is on; after it, the last one stays
        S.screens(on ? liveAt(t) : t >= 8.6 ? liveAt(8.59) : null, refImg());
        if (t > 1 && t < 5.4) api.mark(boxLocal(api, U.pedal, [-18, 0, -13], [18, 9, 13]), 'yellow', t);
        if (t > 9.4 && on === false) api.mark(U.screens[0], 'lime', t);
        if (t > 5.6 && t < 8.6) api.mark(U.parts.ii, 'violet', t);
      },
      caption: [
        { from: 1, to: 5.4, text: 'The operator steps on the <b>foot pedal</b>. X-rays are made only while it is held down.' },
        { from: 5.6, to: 8.8, text: 'The beam crosses the patient to the receptor and the <b>live image</b> appears.' },
        { from: 9.2, to: 13, text: 'Lift the foot and the beam stops at once; the last image stays on the screen.' },
      ],
    },
    {
      title: 'The tube under the table', dur: 14, scale: '10 cm',
      enter() {
        S.reset(); U.skinAlpha(0.35); S.T.g.visible = true; setOpacity(U.parts.tube, 0.22);
        for (const m of U.parts.ring) setOpacity(m, 0.3);
        S.T.filMat.emissiveIntensity = 1.6; S.T.filMat.emissive.setRGB(1, 0.65, 0.15); S.T.spotMat.opacity = 0.9;
      },
      cam: [[0, [75, -15, 95], [4, -58, 0], 34], [14, [60, -10, 80], [4, -54, 0], 34]],
      frame(t) {
        S.T.spin.rotation.x = t * 12;
        sfx.hold('rotor', 880, 0.03, 'square');
        U.setBeam({ a: 0.7 });
        drawBeamUp(t);
        if (t < 6.8) api.mark(S.T.anode, 'orange', t);
        else api.mark(S.T.filter, 'cyan', t);
        api.keepOut(boxAt(api, [0, -20, 0], [8, 22, 8]));
      },
      caption: [
        { from: 0.8, to: 6.8, text: 'In the housing, an x-ray tube much like a radiography tube. For fluoroscopy it runs at a few mA for minutes, not hundreds of mA for a fraction of a second.' },
        { from: 6.8, to: 14, text: 'The beam leaves upward through the <b>filter</b> and collimator. Fluoroscopes often add copper to the aluminium: it removes soft x-rays that would only add skin dose.' },
      ],
    },
  ];
  return { title: 'The C-arm', steps };
}
