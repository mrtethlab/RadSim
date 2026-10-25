/* CT FILM, chapter 2: scanning. The patient onto the couch and up to the isocentre; the lasers and
   the zeroed landmark; the scout, built line by line from the model's own projection as the couch
   slides through the parked tube's fan; the range and field of view planned on it; axial against
   helical acquisition, traced round the patient as the frame and couch really move; pitch and its
   dose (the app's own CTDIvol); the rotation time and what it asks of the tube's mounting. */
import * as THREE from 'three';
import { setOpacity } from '../../kit/stage.js';
import { ctdiVol } from '../../../core/ctDose.js';
import { ZP, ZL, BACK } from './rig.js';
import { hud, box, spinAngle, fanStream } from './kit.js';
import { drawGrey } from './slice.js';

export function scanning(api, S) {
  const { px, sfx, span, lerp, clamp01 } = api;
  const fanPhotons = fanStream(api, S);
  const scout = S.img.scout;
  const MZ_SN = 300;                                   // the landmark (sternal notch), mesh mm
  const base = (o = {}) => {
    S.view({ inside: false, patient: true, injector: false, ...o });
    setOpacity(S.rig.couch, 1); setOpacity(S.rig.couchBase, 1);
    S.rig.couch.visible = S.rig.couchBase.visible = true;
    S.setLasers(0); S.setAngle(0); S.setBeam(4, false);
    rings.forEach((r) => { r.visible = false; }); helix.visible = false;
  };

  // ---------------------------------------------------------------- lines round the patient
  // (children of the couch: drawn where the beam's centre passed, relative to the patient)
  // drawn as thin tubes (a line would be one pixel wide), revealed along their length, at the
  // tube's angle but just outside the body (RP), where the eye can follow them round the patient
  const RP = 25;
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9 });
  const RAD = 6;                                                // radial segments: indices per segment = RAD * 6
  const pathTube = (pts, segs) => {
    const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), segs, 0.35, RAD, false), lineMat);
    m.frustumCulled = false; m.visible = false; m.userData.segs = segs; S.rig.couch.add(m); S.extras.push(m);
    m.userData.reveal = (f) => m.geometry.setDrawRange(0, Math.floor(Math.max(0, Math.min(1, f)) * segs) * RAD * 6);
    return m;
  };
  const circle = () => {
    const pts = []; for (let i = 0; i <= 96; i++) { const th = (i / 96) * Math.PI * 2; pts.push(new THREE.Vector3(-RP * Math.sin(th), RP * Math.cos(th), 0)); }
    return pathTube(pts, 120);
  };
  const rings = [circle(), circle(), circle()];
  const HX = { t0: 1, t1: 11, P: 1.2, speed: 4 / 1.2 };          // pitch 1: 4 cm a rotation
  const zH0 = S.couchForMeshZ(150);
  const helix = (() => {
    const n = 700, pts = [], turns = (HX.t1 - HX.t0) / HX.P;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1), th = f * turns * Math.PI * 2, tt = f * (HX.t1 - HX.t0);
      pts.push(new THREE.Vector3(-RP * Math.sin(th), BACK + RP * Math.cos(th), ZP - (zH0 - HX.speed * tt)));
    }
    return pathTube(pts, 900);
  })();

  // the scout's panel: the projection built down to the row the plane has reached
  function scoutPanel(rowCur, { x, y, h, a = 1 }) {
    const sc = h / scout.h, w = Math.round(scout.w * sc);
    box(api, x - 2, y - 2, w + 4, h + 4, 0.95);
    drawGrey(px, scout.w, scout.h, x, y, sc, (i) => (Math.floor(i / scout.w) <= rowCur ? scout.v[i] : 0), { a, smooth: true });
    if (rowCur >= 0 && rowCur < scout.h) px.rect(x, y + rowCur * sc, w, 1, 'yellow', 0.9);
    return [x, y, w, h];
  }

  // ---------------------------------------------------------------- the steps
  const steps = [
    {
      title: 'Onto the couch', dur: 11, fadeIn: 0.5, scale: '1 m',
      enter() { base(); S.setCouch(75, 8); },
      cam: [[0, [260, 100, 300], [0, -12, 40], 38], [11, [190, 70, 230], [0, -6, 30], 38]],
      frame(t) {
        const lift = 8 * (1 - span(t, 5.2, 8.5));
        S.setCouch(75, lift);
        S.sync();
        const top = (S.COUCH_Y - lift - S.FLOOR_Y);
        hud(api, [['cm', top.toFixed(1), 'lime']]);
        if (t > 1) api.mark(S.patBox, 'yellow', t, { live: true });
      },
      cues: [[5.2, () => sfx.power()]],
      caption: [
        { from: 1, to: 5.2, text: 'The patient lies on the couch, supine and <b>head first</b> toward the gantry.' },
        { from: 5.2, to: 11, text: 'The couch rises until the middle of the body is level with the centre of the bore, the <b>isocentre</b>, where the scan’s geometry is set up.' },
      ],
    },
    {
      title: 'Lasers and zero', dur: 12, scale: '10 cm',
      enter() { base(); S.setCouch(75, 0); },
      cam: [[0, [170, 100, 170], [0, 2, 40], 36], [12, [120, 75, 120], [0, 6, 34], 34]],
      frame(t) {
        const zSN = S.couchForMeshZ(MZ_SN) + (ZL - ZP);
        const z = lerp(75, zSN, span(t, 1.5, 6));
        S.setCouch(z, 0);
        S.setLasers(span(t, 0.2, 0.8));
        S.sync();
        const zeroed = t > 7.2;
        const mm = Math.round((z - zSN) * 10);
        hud(api, [['mm', zeroed ? '0.0' : (mm > 0 ? 'S' : 'I') + Math.abs(mm) + '.0', zeroed ? 'lime' : 'orange']], { w: 56 });
        const [cx, cy] = api.toPx([0, S.ISO_Y + 9, ZL]);
        api.mark([cx - 12, cy - 9, 24, 18], 'red', t);
      },
      cues: [[7.2, () => sfx.chime()]],
      caption: [
        { from: 1, to: 6.4, text: 'Alignment <b>lasers</b> draw the scan’s planes on the skin: the patient is centred left to right and at mid-depth.', place: 'above' },
        { from: 6.4, to: 12, text: 'The landmark, here the sternal notch, is brought under the laser and the table position <b>zeroed</b>: every position is counted from it.', place: 'above' },
      ],
    },
    {
      title: 'The scout', dur: 13, scale: '10 cm',
      enter() { base({ inside: true, shell: 0 }); S.setCouch(S.couchForMeshZ(370), 0); },
      cam: [[0, [210, 120, 170], [0, 0, -5], 38], [13, [190, 100, 120], [0, 0, -12], 38]],
      frame(t) {
        const k = span(t, 1.5, 11.5, api.ease.linear);
        const cz = lerp(S.couchForMeshZ(370), S.couchForMeshZ(-370), k);
        S.setCouch(cz, 0); S.setAngle(0);
        const on = t > 1.5 && t < 11.5;
        S.setBeam(0.6, on);
        S.sync();
        if (on) fanPhotons(t, { rate: 80, wIso: 0.6, v: 140, a: 0.8 });
        const row = Math.floor((356 - S.meshZAtPlane(cz)) / 2);
        const panel = scoutPanel(t < 1.5 ? -1 : row, { x: px.W - 4 - Math.round(scout.w * 150 / scout.h), y: 26, h: 150 });
        hud(api, [['kV', '120', 'yellow'], ['mA', '40', 'yellow']], { x: 4, w: 44 });
        sfx.hold('beam', 220, on ? 0.03 : 0, 'sawtooth');
        if (t > 1.5 && t < 6.5) api.mark(S.housing, 'yellow', t);
        if (t > 6.5) api.mark(panel, 'yellow', t);
      },
      caption: [
        { from: 1.5, to: 6.5, text: 'First the <b>scout</b> (topogram): the tube parked above the patient while the couch slides through its thin fan.' },
        { from: 6.5, to: 13, text: 'Line by line it builds a projection like a radiograph, for a small fraction of the scan’s dose.' },
      ],
    },
    {
      title: 'Planning the range', dur: 12, view: 'pixel', scale: '10 cm',
      cues: [[1.5, () => sfx.click()], [4.4, () => sfx.click()], [7.4, () => sfx.click()]],
      frame(t) {
        px.fillAll('ink');
        const h = px.H - 14, sc = h / scout.h, w = Math.round(scout.w * sc), x = Math.round(px.W / 2 - w / 2) - 30, y = 7;
        drawGrey(px, scout.w, scout.h, x, y, sc, (i) => scout.v[i], { smooth: true });
        api.keepOut([x, y, w, h]);
        const r0 = 14, r1 = 334;                         // the lung apices; below the symphysis
        const top = lerp(-6, r0, span(t, 1, 2.8)), bot = lerp(r0 + 4, r1, span(t, 2.8, 4.8));
        const fov = span(t, 6.8, 8.4);
        const yT = y + top * sc, yB = y + bot * sc;
        if (t > 1) {
          px.rect(x - 3, yT, w + 6, 1, 'lime'); px.rect(x - 3, yB, w + 6, 1, 'red');
          px.frame(x - 3, yT, w + 6, yB - yT + 1, 'yellow', 0.6);
          px.rect(x - 3, yT, w + 6, yB - yT, 'yellow', 0.06);
        }
        // the field of view: 40 cm (200 of the image's 2 mm pixels) centred on the body
        const half = 100 * sc, cx = x + w / 2;
        if (fov > 0) for (const s of [-1, 1]) px.line(cx + s * half, yT, cx + s * half, yB, 'cyan', fov, 2);
        hud(api, [['cm', String(Math.round((bot - top) * 2 / 10)), 'yellow'], ['FOV', fov > 0.5 ? '40 cm' : '-', 'cyan']], { x: x + w + 10, y: 20, w: 52 });
        if (t > 1 && t < 6.8) api.mark([x - 4, yT - 1, w + 8, yB - yT + 3], 'yellow', t);
        if (t > 6.8) api.mark([cx - half - 3, yT, 2 * half + 6, 14], 'cyan', t);
      },
      caption: [
        { from: 0.8, to: 6.8, text: 'On the scout the scan <b>range</b> is set: for a chest, abdomen and pelvis, from above the lung apices to below the pubic symphysis.', place: 'right' },
        { from: 6.8, to: 12, text: 'Across it, the <b>field of view</b> to reconstruct: just wider than the body, 40 cm here.', place: 'right' },
      ],
    },
    {
      title: 'Axial: step and shoot', dur: 12, scale: '10 cm',
      enter() { base({ inside: true, shell: 0 }); },
      cam: [[0, [200, 100, 150], [0, 6, -18], 38], [12, [175, 80, 115], [0, 6, -18], 38]],
      frame(t) {
        const C = 3.4, t0 = 0.8, z0 = S.couchForMeshZ(40);
        const c = Math.max(0, Math.min(2, Math.floor((t - t0) / C))), tc = t - t0 - c * C;
        const rotK = clamp01(tc / 1.4), moveK = span(tc, 1.7, 2.9);
        S.setCouch(z0 - 4 * c - (c < 2 ? 4 * moveK : 0), 0);
        const on = t > t0 && tc < 1.4;
        S.setAngle(spinAngle(t, 1.4));
        S.setBeam(4, on);
        rings.forEach((r, i) => {
          r.visible = t > t0 && i <= c;
          r.position.set(0, BACK, ZP - (z0 - 4 * i));
          r.userData.reveal(i < c ? 1 : rotK);
        });
        S.sync();
        if (on) fanPhotons(t, { rate: 50, v: 140, a: 0.7 });
        sfx.hold('beam', 240, on ? 0.03 : 0, 'sawtooth');
        sfx.hold('rotor', 150, 0.02, 'triangle');
        px.rect(6, 6, 6, 6, on ? 'red' : 'dkgrey'); px.frame(5, 5, 8, 8, 'mid');
        if (t > 1) api.mark(rings[Math.min(c, 2)], 'yellow', t, { live: true });
      },
      caption: [
        { from: 1, to: 6.2, text: '<b>Axial</b> scanning, step and shoot: a full rotation with the couch standing still...' },
        { from: 6.2, to: 12, text: '...then the beam stops, the couch steps on by the beam’s width, and the next rotation: one block of slices at a time.' },
      ],
    },
    {
      title: 'Helical scanning', dur: 13, scale: '10 cm',
      enter() { base({ inside: true, shell: 0 }); helix.visible = true; },
      cam: [[0, [220, 110, 160], [0, 6, -22], 38], [13, [190, 90, 120], [0, 6, -22], 38]],
      frame(t) {
        const tt = Math.max(0, Math.min(t, HX.t1) - HX.t0);
        S.setCouch(zH0 - HX.speed * tt, 0);
        const on = t > HX.t0 && t < HX.t1;
        S.setAngle(spinAngle(t, HX.P, 0) - spinAngle(HX.t0, HX.P, 0));
        S.setBeam(4, on);
        helix.userData.reveal(tt / (HX.t1 - HX.t0));
        S.sync();
        if (on) fanPhotons(t, { rate: 50, v: 140, a: 0.7 });
        sfx.hold('beam', 240, on ? 0.03 : 0, 'sawtooth');
        sfx.hold('rotor', 170, 0.02, 'triangle');
        px.rect(6, 6, 6, 6, on ? 'red' : 'dkgrey'); px.frame(5, 5, 8, 8, 'mid');
        if (t > 6.5) api.mark(helix, 'yellow', t, { live: true });
      },
      caption: [
        { from: 1, to: 6.5, text: '<b>Helical</b> (spiral) scanning: the tube turns without stopping while the couch moves steadily through.' },
        { from: 6.5, to: 13, text: 'Seen from the patient the beam traces a spiral. Slices anywhere along it are interpolated from its data: chest, abdomen and pelvis in a few seconds, in one breath-hold.' },
      ],
    },
    {
      title: 'Pitch', dur: 13, view: 'pixel', scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        const P = [0.5, 1, 1.5], W = px.W, sx = 4.2, w = 4, R = 16;
        const x0 = 34, rowH = Math.floor((px.H - 20) / 3);
        P.forEach((p, i) => {
          const yc = 16 + rowH * i + rowH / 2;
          const show = span(t, 0.6 + i * 1.2, 1.6 + i * 1.2);
          if (show <= 0) return;
          const feed = p * w, zMax = (W - x0 - 70) / sx - w;
          // the spiral seen from the side (its front half bright), and under it what each rotation
          // covers along the patient: one beam width a turn, the turns a feed apart
          const grow = span(t, 0.6 + i * 1.2, 5 + i * 1.2, api.ease.linear);
          const thMax = (zMax / feed) * Math.PI * 2 * grow;
          let lx = null, ly = null, lf = false;
          for (let th = 0; th <= thMax; th += 0.08) {
            const x = x0 + (feed * th / (Math.PI * 2) + w / 2) * sx, y = yc - 8 - R * 0.7 * Math.cos(th), front = Math.sin(th) > 0;
            if (lx != null) px.line(lx, ly, x, y, front ? 'violet' : 'navy', front || lf ? 0.95 : 0.7);
            lx = x; ly = y; lf = front;
          }
          const turns = Math.floor(thMax / (Math.PI * 2) + 1e-6);
          for (let k = 0; k < turns; k++) {
            const bx = x0 + k * feed * sx;
            px.rect(bx, yc + 12, w * sx, 8, 'yellow', 0.4);
            px.frame(bx, yc + 12, w * sx, 8, 'orange', 0.8);
          }
          px.text(p.toFixed(1), x0 - 6, yc - 2, 'yellow', show, 1, 'right');
          const d = ctdiVol({ kv: 120, ma: 250, rotS: 0.5, pitch: p, phantom: 'body' });
          px.text(d.toFixed(1), W - 26, yc - 6, 'white', show, 1, 'right');
          px.text('mGy', W - 26, yc + 2, 'mid', show, 1, 'right');
        });
        api.keepOut([0, 10, W, px.H - 14]);
        if (t > 5 && t < 9) api.mark([x0 - 2, 16 + rowH * 1 + rowH / 2 + 10, W - x0 - 66, 12], 'yellow', t);
        if (t > 9) api.mark([W - 50, 16 + rowH * 2 + 4, 46, rowH - 8], 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 5, text: '<b>Pitch</b> = the couch’s travel in one rotation ÷ the beam’s width. Here 0.5, 1 and 1.5.' },
        { from: 5, to: 9, text: 'At 1 the turns of the spiral just meet. Below 1 they overlap: every point scanned again, more dose. Above 1 they leave gaps, bridged by the interpolation.' },
        { from: 9, to: 13, text: 'At the same mA and rotation time, <b>CTDIvol</b> falls as 1/pitch: the faster the couch, the less dose each slice gets.' },
      ],
    },
    {
      title: 'Rotation time', dur: 11, fadeOut: 0.6, scale: '10 cm',
      enter() { base({ inside: true, shell: 0 }); S.setCouch(S.couchForMeshZ(-23), 0); },
      cam: [[0, [70, 70, 270], [0, 6, -10], 40], [11, [45, 50, 235], [0, 6, -10], 40]],
      frame(t) {
        // the real rotation time steps 1.0 -> 0.5 -> 0.28 s; shown 5x slower
        const Tr = (u) => (u < 3 ? 1.0 : u < 6 ? lerp(1.0, 0.5, span(u, 3, 4)) : lerp(0.5, 0.28, span(u, 6, 7)));
        let th = 0; const tc = Math.min(t, 8);
        for (let u = 0; u < tc; u += 0.02) th += (2 * Math.PI / (5 * Tr(u))) * Math.min(0.02, tc - u);
        th += Math.max(0, t - 8) * 2 * Math.PI / (5 * 0.28);
        S.setAngle(th);
        S.setBeam(4, true);
        S.sync();
        fanPhotons(t, { rate: 40, v: 150, a: 0.6 });
        const T = Tr(t), g = (4 * Math.PI * Math.PI * 0.61) / (T * T) / 9.81;
        hud(api, [['s', T.toFixed(2), 'yellow'], ['g', String(Math.round(g)), g > 20 ? 'red' : 'orange']]);
        sfx.hold('rotor', 90 / T, 0.025, 'triangle');
        if (t > 1) api.mark(S.housing, 'yellow', t, { live: true });
      },
      caption: [
        { from: 1, to: 6, text: 'A rotation can take as little as 0.28 s. The tube, 0.6 m from the axis, then pulls about <b>30 times its own weight</b> on its mounting.' },
        { from: 6, to: 11, text: 'Faster rotation freezes motion, the heartbeat and breathing; but each turn collects fewer photons, so the <b>mA</b> must rise to keep the noise down.' },
      ],
    },
  ];
  return { title: 'Scanning', steps };
}
