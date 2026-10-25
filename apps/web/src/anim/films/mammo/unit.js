/* MAMMOGRAPHY FILM, chapter 1: the unit and its tube. The machine (the app's rig): tube head, C-arm,
   breast support with the detector in it, the compression paddle, the face shield; the C-arm
   turning from the CC to the MLO; inside the head, the rotating molybdenum anode; the two focal
   spots; the tube tilted with its cathode at the chest wall (the vertical chest-wall edge and the
   heel effect); the beryllium window. */
import * as THREE from 'three';
import { setOpacity } from '../../kit/stage.js';
import { makeParticles, coneDir } from '../../kit/flux.js';
import { FOCAL, RECEPTOR_Y, FRONT, SID, TUBE_TILT, FIELD, electronStream } from './rig.js';
import { spectrum, foilT, muRho, mkeV } from './phys.js';
import { loopParticles } from './common.js';

export function unitChapter(api, S) {
  const { px, sfx, span, lerp } = api;
  const R = S.R, T = R.tube;
  const D2R = Math.PI / 180;
  const wp = (o) => { R.unit.updateMatrixWorld(true); return o.getWorldPosition(new THREE.Vector3()).toArray(); };
  const rest = () => {
    S.only('unit');
    R.gantry.rotation.z = 0; R.tubeArm.rotation.z = 0;
    R.setCompression(1); R.setPaddle(22);
    R.breast.visible = true; R.inside.visible = false; R.beam.visible = false;
    R.parts.gland && (R.parts.gland.visible = true); R.parts.dense && (R.parts.dense.visible = false);
    R.showMuscle(false);
    R.skinMat.opacity = 1; R.skinMat.transparent = false; R.skinMat.depthWrite = true;
    for (const o of [R.tubeHead, R.nose, R.snout, R.plate, R.trim]) setOpacity(o, 1);
    T.g.visible = false; T.spotMat.opacity = 0; T.filMat.emissiveIntensity = 0;
    T.heatMat.opacity = 0; T.lampMat.emissiveIntensity = 0;
  };
  const insideHead = () => {
    rest();
    for (const o of [R.tubeHead, R.nose, R.snout, R.trim]) setOpacity(o, 0.12);
    T.g.visible = true; setOpacity(T.housing, 0.15); T.collBox.visible = true;
    T.filMat.emissiveIntensity = 1.4; T.filMat.emissive.setRGB(1, 0.62, 0.15); T.spotMat.opacity = 0.85;
    R.fil2Mat.emissiveIntensity = 0.2; R.fil2Mat.emissive.setRGB(1, 0.62, 0.15);
  };
  // the world places of the tube's parts, with the unit at rest
  rest(); T.g.visible = true;
  const P = {
    focal: FOCAL, cup: wp(T.cup), anode: wp(T.anode), port: wp(T.port), fil: wp(T.filament), fil2: wp(R.fil2),
    head: wp(R.tubeHead), plate: wp(R.plate), foil: wp(R.foilMo),
  };
  // a point in the tube's own frame (xray/tube.js: cathode +x, beam -y) -> the world
  const tw = (p) => T.g.localToWorld(new THREE.Vector3(...p)).toArray();
  T.g.visible = false;
  const axis = [0, -Math.cos(TUBE_TILT), -Math.sin(TUBE_TILT)];              // the port's axis (world)
  const spinAt = (t) => t * 3400 / 60 * Math.PI * 2 * 0.06;                     // shown slowed

  // photons out through the port: energies from the unfiltered molybdenum spectrum at 28 kV,
  // soft ones included; directions over the field
  const moRaw = spectrum('Mo', 28);
  const sampleE = (r) => { for (let k = 0; k < 300; k++) { const E = 5 + r() * 23; if (r() * moRaw.peak < moRaw(E)) return E; } return 17.5; };
  const PER = 3;
  const out = makeParticles(420, 41, (i, r) => {
    const E = sampleE(r), dir = coneDir(r, axis, 0.42);
    const T1 = foilT('Be', E, 1000);
    const stopped = r() > T1;
    // along its line to a plane across the beam's axis through point q
    const toPlane = (q) => ((q[0] - FOCAL[0]) * axis[0] + (q[1] - FOCAL[1]) * axis[1] + (q[2] - FOCAL[2]) * axis[2]) / (dir[0] * axis[0] + dir[1] * axis[1] + dir[2] * axis[2]);
    // stopped in the window, or on to the filter foil under it (the next chapter's)
    return { i, t0: (i / 420) * PER, from: FOCAL, dir, v: 12, end: stopped ? toPlane(P.port) : toPlane(P.foil), E, stopped };
  });

  const steps = [
    {
      title: 'The mammography unit', dur: 10, fadeIn: 0.6, scale: '1 m',
      enter() { rest(); },
      cam: [[0, [230, 60, 300], [0, -10, 0], 40], [10, [120, 50, 170], [0, 20, 0], 40]],
      frame(t) { if (t > 4.5) api.mark(R.tubeHead, 'yellow', t); },
      caption: [
        { from: 0.8, to: 4.5, text: 'A dedicated <b>mammography unit</b>: an x-ray tube and a detector on one C-arm, built for a single organ, the breast.' },
        { from: 4.5, to: 10, text: 'The <b>tube head</b> sits 65 cm above the detector, right over the edge where the patient’s chest wall will be.' },
      ],
    },
    {
      title: 'Support, paddle and face shield', dur: 13, scale: '10 cm',
      enter() { rest(); },
      cam: [[0, [70, 40, 95], [0, 12, 0], 40], [8, [52, 24, 74], [0, 6, 4], 40], [13, [66, 40, 104], [0, 20, 4], 40]],
      cues: [[4.5, () => sfx.click()]],
      frame(t) {
        R.setPaddle(lerp(22, 12, span(t, 4.6, 7.5)));
        if (t > 0.8 && t < 4.5) api.mark(R.plate, 'cyan', t);
        if (t > 4.5 && t < 8.6) api.mark(R.paddleSheet, 'yellow', t, { live: true });
        if (t > 8.6) api.mark(R.shield, 'lime', t);
      },
      caption: [
        { from: 0.8, to: 4.5, text: 'The <b>breast support</b>: the detector lies just under its top surface, its front edge flush with the chest wall.' },
        { from: 4.5, to: 8.6, text: 'The <b>compression paddle</b>, clear plastic, comes down onto the breast; its raised lip at the front holds the chest wall back.' },
        { from: 8.6, to: 13, text: 'The <b>face shield</b> keeps the patient’s head out of the beam while she leans in.' },
      ],
    },
    {
      title: 'CC and MLO: the C-arm turns', dur: 13, scale: '10 cm',
      enter() { rest(); R.setPaddle(12); },
      cam: [[0, [20, 40, 300], [0, 18, 0], 40], [13, [60, 40, 290], [0, 18, 0], 40]],
      cues: [[4.2, () => sfx.power()]],
      frame(t) {
        const ang = 45 * span(t, 4.2, 7.6);
        R.gantry.rotation.z = -ang * D2R;
        if (t > 4.2) {
          // the angle, on a protractor round the hub
          const c = api.toPx([0, 0, 26]);
          const rr = 26;
          for (let a = 0; a <= ang; a += 1.5) { const q = a * D2R; px.px(c[0] + Math.sin(q) * rr, c[1] - Math.cos(q) * rr, 'yellow', 0.85); }
          px.line(c[0], c[1], c[0], c[1] - rr - 4, 'mid', 0.7, 2);
          px.line(c[0], c[1], c[0] + Math.sin(ang * D2R) * (rr + 4), c[1] - Math.cos(ang * D2R) * (rr + 4), 'yellow', 0.9);
          px.text(Math.round(ang) + '°', c[0] + 6, c[1] - rr - 10, 'yellow');
          api.keepOut([c[0] - 4, c[1] - rr - 12, rr + 16, rr + 12]);
        }
        api.mark(R.tubeHead, t < 4.2 ? 'cyan' : 'yellow', t, { live: true });
      },
      caption: [
        { from: 0.6, to: 4.2, text: 'For the <b>CC</b> (craniocaudal) view the beam runs straight down through the breast, head to foot.' },
        { from: 4.2, to: 13, text: 'For the <b>MLO</b> (mediolateral oblique) the whole C-arm turns, about 45°, to lie parallel to the pectoral muscle. Tube and detector turn together and stay aligned.' },
      ],
    },
    {
      title: 'Inside the tube head', dur: 12, scale: '10 cm',
      enter() { insideHead(); },
      cam: [[0, [60, 70, 40], [0, 58, 10], 38], [12, [32, 64, 22], [0, 61, 14], 36]],
      cues: [[0.5, () => sfx.power()]],
      frame(t) {
        // the rotor up to speed first, then the exposure: electrons across the gap
        T.spin.rotation.x = spinAt(t); if (t > 4) electronStream(api, R, t, 0.5);
        T.spotMat.opacity = t > 4 ? 0.85 : 0;
        sfx.hold('rotor', 300 + 500 * span(t, 0.5, 4), 0.04, 'square');
        if (t > 0.8 && t < 6.5) api.mark(T.anode, 'yellow', t);
        if (t > 6.5) api.mark(T.cup, 'cyan', t);
      },
      caption: [
        { from: 0.8, to: 6.5, text: 'Inside: a vacuum x-ray tube whose <b>rotating anode</b> is made of molybdenum (on other units rhodium or tungsten). The anode’s metal sets the energies the beam is made of.' },
        { from: 6.5, to: 12, text: 'The <b>cathode</b> faces it on the chest-wall side; the focal spot between them sits right above the chest-wall edge.' },
      ],
    },
    {
      title: 'Two focal spots', dur: 12, scale: '1 cm',
      enter() { insideHead(); setOpacity(T.housing, 0); },
      // in at the cup from below and to the side, the anode beyond
      cam: [[0, tw([-2, 4, 14]), tw([3.8, 0.2, 0]), 34], [12, tw([1.9, 0.5, 2.4]), tw([4.6, 0.05, 0]), 32]],
      frame(t) {
        T.spin.rotation.x = spinAt(t); electronStream(api, R, t, 0.5);
        const small = t > 5.5;
        T.filMat.emissiveIntensity = small ? 0.3 : 1.5;
        R.fil2Mat.emissiveIntensity = small ? 1.6 : 0.2;
        // the effective spots they make, drawn to scale against each other
        const bx = px.W - 64, by = 18;
        px.rect(bx - 4, by - 6, 62, 54, 'ink', 0.85); px.frame(bx - 4, by - 6, 62, 54, 'dkgrey');
        api.keepOut([bx - 4, by - 6, 62, 54]);
        const sq = (cx, s, c, a) => { px.rect(cx - s / 2, by + 16 - s / 2, s, s, c, a); };
        sq(bx + 14, 18, 'orange', small ? 0.35 : 1);
        sq(bx + 42, 6, 'orange', small ? 1 : 0.35);
        px.text('0.3', bx + 14, by + 30, small ? 'mid' : 'yellow', 1, 1, 'center');
        px.text('0.1', bx + 42, by + 30, small ? 'yellow' : 'mid', 1, 1, 'center');
        px.text('mm', bx + 28, by + 38, 'mid', 1, 1, 'center');
        api.mark(small ? R.fil2 : T.filament, 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 5.5, text: 'The cathode holds two filaments. The larger makes the standard <b>0.3 mm</b> focal spot.' },
        { from: 5.5, to: 12, text: 'The smaller makes a <b>0.1 mm</b> spot, for magnification views: with the breast raised toward the tube, only a tiny spot keeps the enlarged image sharp.' },
      ],
    },
    {
      title: 'The tilted tube and the heel effect', dur: 14, scale: '10 cm',
      enter() { insideHead(); R.setPaddle(12); R.beam.visible = true; R.beam.material.opacity = 0.08; },
      cam: [[0, [124, 28, 6], [0, 26, 6], 40], [14, [116, 26, 4], [0, 24, 4], 40]],
      frame(t) {
        T.spin.rotation.x = spinAt(t); electronStream(api, R, t, 0.5);
        T.spotMat.opacity = 0.9;
        // rays down to the receptor across the field (chest wall to nipple), their brightness the
        // beam's intensity there: the heel effect thins those toward the anode
        const f = api.toPx(FOCAL), k = span(t, 0.6, 2.4);
        const n = 14, prof = [];
        for (let i = 0; i <= n; i++) {
          const z = lerp(FIELD.z0, FIELD.z1, i / n);
          const th = Math.atan2(FOCAL[2] - z, SID), thM = Math.atan2(FOCAL[2] - FIELD.z1, SID);
          const I = 1 - 0.42 * (Math.max(0, th) / thM) ** 1.6;
          prof.push(I);
          const q = api.toPx([0, RECEPTOR_Y, z]);
          px.line(f[0], f[1], lerp(f[0], q[0], k), lerp(f[1], q[1], k), I > 0.85 ? 'white' : I > 0.72 ? 'violet' : 'lav', 0.25 + 0.6 * I * k, i === 0 ? 0 : 2);
        }
        // the chest-wall edge: the beam's edge stands straight up from it
        const cw = api.toPx([0, RECEPTOR_Y, FRONT]);
        if (t > 1.5 && t < 7) api.mark([cw[0] - 6, f[1], 12, cw[1] - f[1] + 4], 'yellow', t);
        // the intensity across the field, under the support
        if (t > 7) {
          const a = span(t, 7, 8), q0 = api.toPx([0, RECEPTOR_Y - 6.5, FIELD.z0]), q1 = api.toPx([0, RECEPTOR_Y - 6.5, FIELD.z1]);
          const x0 = Math.min(q0[0], q1[0]), w = Math.abs(q1[0] - q0[0]), y0 = q0[1];
          px.rect(x0 - 3, y0 - 3, w + 6, 16, 'ink', 0.9 * a);
          for (let i = 0; i < w; i++) {
            const u = (q0[0] < q1[0] ? i : w - 1 - i) / Math.max(1, w - 1), I = prof[Math.round(u * n)];
            const c = I > 0.9 ? 'white' : I > 0.8 ? 'grey' : I > 0.7 ? 'mid' : 'slate';
            px.rect(x0 + i, y0, 1, 10, c, a);
          }
          px.text('C', q0[0] + (q0[0] < q1[0] ? -7 : 4), y0 + 2, 'cyan', a);
          px.text('A', q1[0] + (q0[0] < q1[0] ? 4 : -7), y0 + 2, 'orange', a);
          api.keepOut([x0 - 10, y0 - 3, w + 20, 16]);
          api.mark([x0 - 3, y0 - 3, w + 6, 16], 'yellow', t);
        }
      },
      caption: [
        { from: 1.5, to: 7, text: 'The tube is tilted and placed so the edge of the beam falls straight down the <b>chest wall</b>: no tissue next to the chest is left out of the field.' },
        { from: 7, to: 14, text: 'The cathode (C) is on the chest-wall side. The <b>heel effect</b> weakens the beam toward the anode (A), the nipple, where the breast is thinnest; the strongest part crosses the thickest tissue.' },
      ],
    },
    {
      title: 'The beryllium window', dur: 12, scale: '1 cm',
      enter() { insideHead(); setOpacity(T.housing, 0.08); },
      cam: [[0, [P.port[0] + 17, P.port[1] - 4, P.port[2] + 12], [P.port[0], P.port[1] - 0.6, P.port[2]], 36], [12, [P.port[0] + 10, P.port[1] - 2.5, P.port[2] + 7], [P.port[0], P.port[1] - 0.6, P.port[2]], 34]],
      frame(t) {
        T.spin.rotation.x = spinAt(t); electronStream(api, R, t, 0.5);
        T.spotMat.opacity = 0.9;
        loopParticles(api, out, t, PER, (p) => ({ kind: 'photon', color: mkeV(p.E), flashColor: 'grey' }), { tail: 4 });
        // transmission through 1 mm of beryllium (cyan) and of glass (orange), 5-35 keV
        const w = 96, h = 56, x = px.W - w - 6, y = px.H - h - 14;
        px.rect(x, y, w, h, 'ink', 0.88); px.frame(x, y, w, h, 'dkgrey');
        api.keepOut([x, y, w, h + 8]);
        const x0 = x + 3, y0 = y + h - 8, pw = w - 6, ph = h - 13;
        px.rect(x0, y0, pw, 1, 'mid');
        for (const E of [10, 20, 30]) { const tx = x0 + Math.round(((E - 5) / 30) * pw); px.rect(tx, y0 + 1, 1, 2, 'mid'); px.text(String(E), tx, y0 + 3, 'mid', 1, 1, 'center'); }
        px.text('keV', x + w - 3, y + 3, 'mid', 1, 1, 'right');
        const k = span(t, 2, 5);
        for (const [c, f] of [['orange', (E) => Math.exp(-muRho('Al', E) * 2.23 * 0.1)], ['cyan', (E) => foilT('Be', E, 1000)]]) {
          let lx = null, ly = null;
          for (let i = 0; i <= pw * k; i++) {
            const E = 5 + (i / pw) * 30, yy = y0 - Math.round(f(E) * ph);
            if (lx != null) px.line(lx, ly, x0 + i, yy, c);
            lx = x0 + i; ly = yy;
          }
        }
        { const a = api.toPx(FOCAL), b = api.toPx(P.foil); api.keepOut([Math.min(a[0], b[0]) - 22, a[1] - 6, Math.abs(b[0] - a[0]) + 44, b[1] - a[1] + 14]); }
        api.mark(T.port, 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 12, text: 'The beam leaves through a <b>beryllium window</b> (Z = 4). A millimetre of it lets out over 85% of the photons even at 10 keV (cyan); glass (orange) would stop most of the soft ones mammography depends on.' },
      ],
    },
  ];
  void THREE;
  return { title: 'The unit and its tube', steps };
}
