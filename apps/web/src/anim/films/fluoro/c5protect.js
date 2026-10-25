/* FLUOROSCOPY FILM, chapter 5: radiation protection. The patient as the staff's source (scatter, from
   where the beam enters); in a field of tissue, why the entrance side is the hot side; the tube under
   the table against the tube over it, as an isodose map in the plane the staff stand in; distance and
   the inverse square; the lead (apron, collar, glasses, ceiling shield, table skirt); and the
   receptor kept close to the patient.
   The doses are the app's own staff model (core/staffDose.js: scatter ~2 µGy at 1 m per Gy cm², most
   of it back toward the tube) at the ABC's typical abdominal technique (core/fluoroRate.js). */
import * as THREE from 'three';
import { setOpacity } from '../../kit/stage.js';
import { keVColor, electron } from '../../kit/micro.js';
import { makeParticles, drawParticles } from '../../kit/flux.js';
import { Materials } from '../../../core/materials.js';
import { staffPulse, scatterAngleFactor, SCATTER_K, BODY_H, skinEntranceMGy } from '../../../core/staffDose.js';
import { akRate } from '../../../core/fluoroRate.js';
import { panel, boxAt, boxLocal, recent } from './util.js';
import { FLOOR_Y, PAT_HALF, OEC } from './suite.js';

export function protectChapter(api, S) {
  const { px, sfx, span, lerp, rng } = api;
  const U = S.suite;
  const THICK = 2 * PAT_HALF;                                       // the patient's AP thickness (cm)

  // ---- the dose numbers: a minute of screening an adult abdomen (75 kV, 2.2 mA, 15 pps)
  const AK_MIN = akRate(75, 2.2, 15);                                // mGy/min at the reference point
  const IRP_AREA = Math.PI * (OEC.FIELD / 2 * 45 / 99) ** 2;          // cm2 of the field at the reference point
  const DAP_MIN = AK_MIN * IRP_AREA / 1000 / 0.01;                    // µGy m2 per minute (Gy cm2 / 0.01)
  const entryOf = (over) => (over ? { point: [0, THICK, 0], dir: [0, -1, 0] } : { point: [0, 0, 0], dir: [0, 1, 0] });
  const staffDose = (op, over, prot = {}) => {
    const e = entryOf(over);
    return staffPulse({ dapUGym2: DAP_MIN, entry: e.point, beamDir: e.dir, op, floorY: FLOOR_Y, tableTopY: 0, prot });
  };
  const fmt = (v) => (v >= 10 ? Math.round(v).toString() : v >= 1 ? v.toFixed(1) : v.toFixed(2));
  const STAFF0 = { x: 80, z: -34 };

  // ================================================================ scatter in the room (3D, 8-bit photons)
  // born where the beam is in the patient, densest at the entrance; flying off in every direction,
  // back toward the tube more often than forward (the model's angular factor); a loop of P seconds
  const P = 3;
  const scat = makeParticles(700, 91, (i, r) => {
    const depth = Math.min(THICK * 0.95, -Math.log(1 - r() * 0.97) * 6);       // ~6 cm mean free path
    const rad = Math.sqrt(r()) * 6, a = r() * 6.283;
    // a direction, accepted in proportion to the angular factor (relative to the beam, up)
    let d = [0, 1, 0];
    for (let k = 0; k < 30; k++) {
      const u = r() * 2 - 1, ph = r() * 6.283, s = Math.sqrt(1 - u * u);
      d = [s * Math.cos(ph), u, s * Math.sin(ph)];
      if (r() * 1.5 < scatterAngleFactor(u)) break;
    }
    // forward-going ones mostly die in the patient
    const fwd = d[1] > 0, end = fwd && r() < 0.75 ? (THICK - depth) / Math.max(0.2, d[1]) * r() : 160;
    return { i, t0: (i / 700) * P, from: [Math.cos(a) * rad, depth, Math.sin(a) * rad], dir: d, v: 160, end, E: 40 + r() * 25 };
  });
  const drawScatter = (t, over = false, dens = 1) => {
    const bz = U.bed.position.z;
    for (const tt of [t % P, (t % P) + P]) {
      drawParticles(api, scat.map((p) => (p.i % 10 >= dens * 10 ? null : {
        ...p,
        from: over ? [p.from[0], THICK - p.from[1], p.from[2] + bz] : [p.from[0], p.from[1], p.from[2] + bz],
        dir: over ? [p.dir[0], -p.dir[1], p.dir[2]] : p.dir,
      })).filter(Boolean), tt, (p) => ({ kind: 'photon', color: keVColor(p.E), flash: false, a: 0.9 }), { tail: 4 });
    }
  };

  // ================================================================ the isodose map, in the staff's plane
  const MAP = { x0: -200, x1: 200, y0: FLOOR_Y, y1: 200, z: STAFF0.z, nx: 100, ny: 72 };
  const mapCv = document.createElement('canvas'); mapCv.width = MAP.nx; mapCv.height = MAP.ny;
  const mapTex = new THREE.CanvasTexture(mapCv); mapTex.magFilter = THREE.NearestFilter; mapTex.colorSpace = THREE.SRGBColorSpace;
  const mapMesh = new THREE.Mesh(new THREE.PlaneGeometry(MAP.x1 - MAP.x0, MAP.y1 - MAP.y0), new THREE.MeshBasicMaterial({ map: mapTex, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }));
  mapMesh.position.set((MAP.x0 + MAP.x1) / 2, (MAP.y0 + MAP.y1) / 2, MAP.z); mapMesh.visible = false;
  api.scene.add(mapMesh);
  // the bands, a factor of 2 apart: under 0.5 µGy/min clear, then 0.5, 1, 2, 4, 8, and 16 and over (red)
  const BANDS = [null, '#1d4f8f', '#1a8f8f', '#00e436', '#ffec27', '#ffa300', '#ff004d'];
  // paint the map for the tube under the table or over it (each worked out once)
  const mapMemo = new Map();
  let mapState = null;                                               // which map the canvas holds
  function paintMap(over) {
    const key = over ? 1 : 0;
    if (!mapMemo.has(key)) {
      const e = entryOf(over), out = new Uint8Array(MAP.nx * MAP.ny);
      for (let j = 0; j < MAP.ny; j++) for (let i = 0; i < MAP.nx; i++) {
        const x = lerp(MAP.x0, MAP.x1, (i + 0.5) / MAP.nx), y = lerp(MAP.y1, MAP.y0, (j + 0.5) / MAP.ny), z = MAP.z;
        const d = [x - e.point[0], y - e.point[1], z - e.point[2]], r = Math.hypot(...d);
        const cos = (d[0] * e.dir[0] + d[1] * e.dir[1] + d[2] * e.dir[2]) / r;
        const K = SCATTER_K * (DAP_MIN * 0.01) * (100 / Math.max(r, 20)) ** 2 * scatterAngleFactor(cos);   // µGy/min
        // its band: 0 below 0.5 µGy/min, 6 at 16 and over
        out[j * MAP.nx + i] = Math.max(0, Math.min(BANDS.length - 1, 2 + Math.floor(Math.log2(K))));
      }
      mapMemo.set(key, out);
    }
    const b = mapMemo.get(key), g = mapCv.getContext('2d');
    g.clearRect(0, 0, MAP.nx, MAP.ny);
    for (let q = 0; q < b.length; q++) { if (!BANDS[b[q]]) continue; g.fillStyle = BANDS[b[q]]; g.fillRect(q % MAP.nx, Math.floor(q / MAP.nx), 1, 1); }
    mapTex.needsUpdate = true;
  }

  // ================================================================ 8-bit: where the scatter comes from
  /* A slab of soft tissue the patient's thickness, the beam up from the bottom (the entrance) to the
     receptor at the top. Each photon: through, absorbed, or Compton-scattered at a depth, then out
     the back, out the front, or absorbed before it gets out. The tally of what escapes each side. */
  function scatterScene(t, { hi = false, hiAt = 0, slow = 3 } = {}) {
    px.fillAll('ink');
    const W = px.W, H = px.H, yB = H - 28, yT = 30, cm = (yB - yT) / THICK, rate = 44;
    px.rect(0, yT, W, yB - yT, 'muscle', 0.16);
    const ra = rng(4);
    for (let k = 0; k < 700; k++) px.px(ra() * W, yT + ra() * (yB - yT), k % 6 ? 'pink' : 'peach', 0.35);
    px.rect(0, yT - 6, W, 4, 'teal', 0.7);                          // the receptor's side
    px.rect(W * 0.3, yB + 14, W * 0.4, 2, 'violet', 0.7);           // the tube's side
    const fi = hi ? Math.floor(hiAt * rate) : -1;
    let back = 0, fwd = 0, n = 0, focus = null;
    for (const i of recent(t, rate, 5, fi)) {
      const r = rng(31000 + i), isF = i === fi;
      const age = (t - i / rate) / (isF ? slow : 1);
      if (age < 0) continue;
      let E = 35 + r() * 35;
      const x = W * 0.32 + r() * W * 0.36, v = 120;
      const mu = (e) => Materials.mu('soft', e);
      let d1 = -Math.log(1 - r() * 0.999) / mu(E);
      let kind = d1 > THICK ? 'through' : r() < 1 / (1 + (E / 25) ** 3) ? 'pe' : 'compton';
      let ang = r() * 6.283;                                          // 0: straight on (up)
      if (isF) { d1 = 2.2; kind = 'compton'; ang = Math.PI * 0.82; }
      const yHit = yB - Math.min(d1, THICK) * cm, tHit = (yB + 16 - yHit) / v;
      const dimA = hi && !isF && focus ? 0.4 : 0.95;
      if (age < tHit || kind === 'through') {
        const y = yB + 16 - age * v;
        if (y > yT - 8) px.photon(x, y, 0, -1, isF ? 8 : 5, keVColor(E), isF ? 1 : dimA, t * 30 + i);
        if (isF) focus = { x, y: yHit };
        continue;
      }
      const e = age - tHit;
      if (kind === 'pe') { if (e < 0.15) px.glow(x, yHit, 3, 'white', 0.8 * dimA, i); if (e < 0.5) electron(px, x + e * 16, yHit - e * 6, (1 - e / 0.5) * dimA, 'cyan'); continue; }
      // Compton: off at the new angle with less energy; out of the slab, or absorbed before it
      const c = Math.cos(ang), E2 = E / (1 + (E / 511) * (1 - c));
      const sx = Math.sin(ang), sy = -c;                                // screen direction (y down)
      const toExit = sy > 0 ? (Math.min(d1, THICK)) / Math.max(0.05, sy) : (THICK - d1) / Math.max(0.05, -sy);
      let d2 = -Math.log(1 - r() * 0.999) / mu(E2);
      if (isF) d2 = 99;
      const L = Math.min(d2, toExit, 60), out = d2 >= toExit;
      if (e < 0.12) px.glow(x, yHit, isF ? 5 : 3, 'orange', 0.9 * dimA, i);
      if (e * v / cm < L + (out ? 30 : 0)) {
        const dd = e * v / cm, xx = x + sx * dd * cm, yy = yHit + sy * dd * cm;
        if (dd < L || out) px.photon(xx, yy, sx, sy, isF ? 8 : 5, keVColor(E2), isF ? 1 : dimA, t * 30 + i);
      } else if (!out && e * v / cm < L + 3) px.rect(x + sx * L * cm - 1, yHit + sy * L * cm - 1, 3, 3, 'grey', 0.8 * dimA);
      if (isF) focus = { x, y: yHit, e };
      if (!isF && e > 0) { n++; if (out && sy > 0) back++; else if (out && sy < 0) fwd++; }
    }
    // the tally: what got out the back (toward the tube, down) and out the front (up)
    const w = 46, bx = W - w - 4, by = 4;
    panel(api, bx, by, w, 24);
    const arrow = (x, y, up, c) => { px.rect(x, y, 1, 7, c); px.line(x - 2, up ? y + 2 : y + 4, x, up ? y : y + 6, c); px.line(x + 2, up ? y + 2 : y + 4, x, up ? y : y + 6, c); };
    arrow(bx + 6, by + 3, false, 'orange'); px.text(String(back), bx + w - 4, by + 4, 'orange', 1, 1, 'right');
    arrow(bx + 6, by + 13, true, 'cyan'); px.text(String(fwd), bx + w - 4, by + 14, 'cyan', 1, 1, 'right');
    if (focus && (focus.e ?? 0) < 3) { api.mark([focus.x - 9, focus.y - 9, 18, 18], 'yellow', t); api.keepOut([focus.x - 12, focus.y - 12, 64, H - focus.y + 12]); }
    return { back, fwd, bx, by, w, yB, yT };
  }

  // the staff's readouts beside the figure: numbers at eye height and at the legs (µGy per minute)
  function staffNumbers(t, dose, keys = ['eyes', 'legs'], colors = { eyes: 'yellow', thyroid: 'cyan', trunk: 'orange', legs: 'lime' }) {
    const g = U.staff.g, out = [];
    for (const k of keys) {
      const w = [g.position.x + 26, FLOOR_Y + BODY_H[k], g.position.z];            // beside the figure, away from the table
      const [x1, y1] = api.toPx(w);
      const s = fmt(dose[k]);
      const bw = s.length * 4 + 4;
      const x = Math.max(bw + 4, Math.min(px.W - 8, x1)), y = Math.max(6, Math.min(px.H - 8, y1));   // never cut off at an edge
      px.rect(x - bw - 2, y - 4, bw + 2, 9, 'ink', 0.85);
      px.text(s, x - 2, y - 2, colors[k] || 'white', 1, 1, 'right');
      px.line(x, y, x + 6, y, colors[k] || 'white', 0.8);
      out.push([x - bw - 2, y - 4, bw + 8, 9]);
      api.keepOut([x - bw - 2, y - 4, bw + 8, 9]);
    }
    return out;
  }
  const unitTag = () => { const w = 54, x = px.W - w - 4; panel(api, x, px.H - 30, w, 13); px.text('µGy/min', x + w / 2, px.H - 26, 'mid', 1, 1, 'center'); api.keepOut([x, px.H - 30, w, 13]); };   // (above the scale bar)

  const room = (staff = true) => {
    S.reset();
    U.skinAlpha(0.9);
    if (staff) { U.staff.g.visible = true; U.staff.g.position.set(STAFF0.x, FLOOR_Y, STAFF0.z); }
  };

  const steps = [
    {
      title: 'Scatter from the patient', dur: 14, fadeIn: 0.4, scale: '1 m',
      enter() { room(); U.staff.apron.visible = U.staff.collar.visible = true; U.skinAlpha(0.5); },
      cam: [[0, [190, 80, 250], [0, -12, -20], 40], [14, [170, 70, 225], [0, -12, -20], 40]],
      frame(t) {
        U.setBeam({ a: 0.8 });
        sfx.hold('beam', 96, 0.012, 'square');
        drawScatter(t);
        if (t > 5) api.mark(boxAt(api, [0, 2, 0], [10, 2.5, 10]), 'orange', t);
        api.keepOut(boxAt(api, [0, -30, 0], [30, 28, 30]));            // where the backscatter goes, under the table
      },
      caption: [
        { from: 0.6, to: 5, text: 'For the staff, the source of radiation is not the tube but the <b>patient</b>: x-rays Compton-scattered out of the body in every direction.' },
        { from: 5, to: 14, text: 'Most of it starts where the beam <b>enters</b> (here the patient’s back, on the table), and more of it goes back toward the tube than on through the patient.' },
      ],
    },
    {
      title: 'The entrance side is the hot side', dur: 16, scale: (t) => (t < 2 ? '10 cm' : '1 cm'),
      enter() { room(false); U.skinAlpha(0.5); },
      cam: [[0, [60, 10, 70], [0, 4, 0], 36], [2.4, [3, 3, 8], [0, 3, 0], 36]],
      cues: [[0.2, () => sfx.whoosh()], [5.6, () => sfx.pew(1100)]],
      frame(t) {
        U.setBeam({ a: 0.8 });
        api.mosaic(span(t, 1.1, 2.5));
        if (t > 2.1) { px.alpha = span(t, 2.1, 2.7); scatterScene(t - 2.1, { hi: true, hiAt: 2.4, slow: 3 }); px.alpha = 1; }
        if (t > 10.5) api.mark([px.W - 52, 2, 50, 28], 'orange', t);
      },
      caption: [
        { from: 2.6, to: 6.4, text: 'The beam enters from below. Most photons interact in the first few centimetres, where the beam is still strong.' },
        { from: 6.4, to: 10.5, text: 'A photon scattered back toward the entrance has little tissue to cross and gets out: <b>backscatter</b>.' },
        { from: 10.5, to: 16, text: 'One scattered forward must cross the rest of the patient, and most are absorbed on the way. So far more escapes the entrance side.' },
      ],
    },
    {
      title: 'Tube under, tube over', dur: 18, scale: '1 m',
      enter() { room(); U.staff.apron.visible = U.staff.collar.visible = true; mapMesh.visible = true; paintMap(false); mapState = false; },
      cam: [[0, [40, 60, 300], [20, 20, -34], 40], [18, [55, 55, 290], [20, 20, -34], 40]],
      cues: [[7, () => sfx.power()]],
      frame(t) {
        const k = span(t, 7, 10);
        const over = k >= 0.5;
        // the C swings round on its holder (flip-flop), drawn faint while it passes the table
        U.setPose({ over: k });
        const fade = k > 0 && k < 1 ? 0.25 : 1;
        for (const m of U.parts.ring) setOpacity(m, fade);
        for (const p of ['ii', 'tube', 'cap', 'trim']) setOpacity(U.parts[p], fade);
        // the map fades out as the C turns and back in for the new position
        mapMesh.material.opacity = 0.45 * Math.abs(1 - 2 * k);
        if (mapState !== over) { paintMap(over); mapState = over; }
        U.setBeam({ a: k > 0 && k < 1 ? 0 : 0.8 });
        sfx[k > 0 && k < 1 ? 'stop' : 'hold']('beam', 96, 0.012, 'square');
        if (!(k > 0 && k < 1)) drawScatter(t, over, 0.5);
        const d = staffDose(STAFF0, over, { apron: true, collar: true });
        staffNumbers(t, d, ['eyes', 'legs']);
        unitTag();
        if (t > 3 && t < 7) api.mark(boxAt(api, [0, -45, -34], [70, 45, 1]), 'orange', t);
        if (t > 11) api.mark(boxAt(api, [0, 110, -34], [70, 40, 1]), 'red', t);
      },
      caption: [
        { from: 0.6, to: 7, text: 'The scatter in the plane the staff stand in, a band for each halving. Tube <b>under</b> the table: the strongest field is low, at the floor and the legs.' },
        { from: 7, to: 11, text: 'Turn the C over (flip-flop), the tube <b>over</b> the table...' },
        { from: 11, to: 18, text: '...and the same backscatter comes up at the operator’s eyes and neck: several times the dose to the eyes. Keep the tube under.' },
      ],
    },
    {
      title: 'Distance', dur: 14, scale: '1 m',
      enter() { room(); U.staff.apron.visible = U.staff.collar.visible = true; },
      // (the camera eases back as the figure steps to 2 m, so it stays in shot)
      cam: [[0, [270, 200, 300], [95, -15, -45], 40], [7, [280, 204, 304], [105, -15, -48], 40], [9, [360, 250, 380], [140, -15, -60], 40], [14, [368, 254, 384], [145, -15, -62], 40]],
      cues: [[2, () => sfx.thud()], [2.5, () => sfx.thud()], [7, () => sfx.thud()], [7.5, () => sfx.thud()], [8, () => sfx.thud()]],
      frame(t) {
        U.setBeam({ a: 0.8 });
        sfx.hold('beam', 96, 0.012, 'square');
        drawScatter(t, false, 0.5);
        // from 0.5 m to 1 m to 2 m from the beam, along the line away from it
        const dist = t < 2 ? 50 : t < 7 ? lerp(50, 100, span(t, 2, 3)) : lerp(100, 200, span(t, 7, 8.5));
        const dir = [Math.cos(-0.4), Math.sin(-0.4)];
        U.staff.g.position.set(dir[0] * dist, FLOOR_Y, dir[1] * dist);
        U.staff.g.rotation.y = -Math.PI / 2 + 0.4;
        U.staff.body.position.y = Math.abs(Math.sin(t * 9)) * (t > 2 && t < 3 || t > 7 && t < 8.5 ? 2 : 0);
        const op = { x: dir[0] * dist, z: dir[1] * dist }, dose = staffDose(op, false, {});
        // the figure's waist dose (no lead), and its distance
        const gp = U.staff.g.position, [x0, y0] = api.toPx([gp.x + 45, FLOOR_Y + 150, gp.z]);       // beside the head, away from the table
        const s = fmt(dose.trunk), w = s.length * 8 + 8;
        // kept whole inside the frame, whatever the distance
        const x = Math.max(w / 2 + 3, Math.min(px.W - w / 2 - 3, x0)), y = Math.max(26, Math.min(px.H - 30, y0));
        panel(api, x - w / 2, y - 22, w, 22);
        px.text(s, x, y - 19, 'orange', 1, 2, 'center');
        px.text((dist / 100).toFixed(1) + ' m', x, y - 7, 'mid', 1, 1, 'center');
        unitTag();
        api.mark(boxLocal(api, U.staff.g, [-24, 0, -20], [24, 182, 20]), 'yellow', t, { live: true });
      },
      caption: [
        { from: 0.6, to: 7, text: 'Scatter spreads out from the patient like the beam from the focal spot: step from 0.5 m to 1 m away and the dose rate falls to about a <b>quarter</b>.' },
        { from: 7, to: 14, text: 'At 2 m, about a sixteenth: the <b>inverse square law</b>. A step back from the table, whenever the hands are not needed, is the cheapest protection there is.' },
      ],
    },
    {
      title: 'Lead', dur: 18, scale: '10 cm',
      enter() { room(); },
      cam: [[0, [150, 70, -250], [55, 15, -30], 40], [18, [165, 80, -240], [55, 20, -30], 40]],
      cues: [[1, () => sfx.thud()], [4.5, () => sfx.click()], [7.5, () => sfx.click()], [10.5, () => sfx.thud()], [14, () => sfx.thud()]],
      frame(t) {
        U.setBeam({ a: 0.8 });
        sfx.hold('beam', 96, 0.012, 'square');
        drawScatter(t, false, 0.5);
        const prot = { apron: t > 1, collar: t > 4.5, glasses: t > 7.5, ceiling: t > 10.5, skirt: t > 14 };
        U.staff.apron.visible = prot.apron; U.staff.collar.visible = prot.collar; U.staff.glasses.visible = prot.glasses;
        U.ceiling.visible = t > 10; U.ceiling.position.y = lerp(80, 0, span(t, 10, 10.8));
        U.skirt.visible = t > 13.5; U.skirt.scale.y = Math.max(0.01, span(t, 13.5, 14.2));
        const d = staffDose(STAFF0, false, prot);
        staffNumbers(t, d, ['eyes', 'thyroid', 'trunk', 'legs']);
        unitTag();
        const g = U.staff;
        if (t > 1 && t < 4.5) api.mark(g.apron, 'orange', t);
        else if (t > 4.5 && t < 7.5) api.mark(g.collar, 'cyan', t);
        else if (t > 7.5 && t < 10.5) api.mark(g.glasses, 'yellow', t);
        else if (t > 10.5 && t < 14) api.mark(U.ceiling.userData.pane, 'yellow', t);
        else if (t >= 14) api.mark(boxLocal(api, U.bed, [29, -66, -52], [31, -2, 40]), 'lime', t);
      },
      caption: [
        { from: 1, to: 4.5, text: 'A <b>lead apron</b> (0.25–0.5 mm of lead) stops about 95% of the scatter reaching the trunk.' },
        { from: 4.5, to: 7.5, text: 'A <b>thyroid collar</b> protects the neck...' },
        { from: 7.5, to: 10.5, text: '...and <b>lead glasses</b> the lenses of the eyes, which radiation can cloud (cataract).' },
        { from: 10.5, to: 14, text: 'A <b>ceiling-suspended shield</b> of lead acrylic between the patient and the operator’s head cuts the eyes’ dose about tenfold.' },
        { from: 14, to: 18, text: 'And a lead <b>skirt</b> on the table stops what comes off under it, toward the legs.' },
      ],
    },
    {
      title: 'Receptor close, skin far', dur: 18, fadeOut: 1, scale: '10 cm',
      enter() { room(false); U.skinAlpha(0.6); },
      cam: [[0, [30, 10, 230], [-5, 0, 0], 38], [18, [40, 15, 220], [-5, 2, 0], 38]],
      frame(t) {
        U.setBeam({ a: 0.9 });
        sfx.hold('beam', 96, 0.012, 'square');
        // the table low (the patient near the tube), then raised up to the receptor
        const lift = t < 2 ? -13 : lerp(-13, 12, span(t, 2, 7));
        U.bed.position.y = lift;
        const fsd = OEC.SRC_ISO - PAT_HALF + lift;                       // focal spot to the patient's back (cm)
        const gap = OEC.SID - OEC.SRC_ISO - (PAT_HALF + lift);           // the patient's front to the receptor
        const skin = skinEntranceMGy(AK_MIN, OEC.SRC_ISO - 15, fsd, true);
        // the readouts: the skin's dose rate where the beam enters, the distances
        const [sx, sy] = api.toPx(U.inC(14, -OEC.SRC_ISO + fsd, 0));
        panel(api, sx, sy - 10, 54, 20);
        px.text(skin.toFixed(0), sx + 50, sy - 7, 'red', 1, 2, 'right');
        px.text('mGy/min', sx + 50, sy + 5, 'mid', 1, 1, 'right');
        const [ax, ay] = api.toPx(U.inC(-14, -OEC.SRC_ISO + fsd / 2, 0));
        panel(api, ax - 30, ay - 5, 30, 11); px.text(Math.round(fsd) + ' cm', ax - 3, ay - 2, 'orange', 1, 1, 'right');
        const [gx, gy] = api.toPx(U.inC(-14, OEC.SID - OEC.SRC_ISO - gap / 2, 0));
        panel(api, gx - 30, gy - 5, 30, 11); px.text(Math.round(gap) + ' cm', gx - 3, gy - 2, 'cyan', 1, 1, 'right');
        if (t > 2 && t < 9) api.mark(boxAt(api, U.inC(0, -OEC.SRC_ISO + fsd / 2, 0), [8, fsd / 2, 8]), 'orange', t);
        else if (t >= 9) api.mark(boxAt(api, U.inC(0, OEC.SID - OEC.SRC_ISO - gap / 2, 0), [12, Math.max(2, gap / 2), 12]), 'cyan', t);
      },
      caption: [
        { from: 0.6, to: 9, text: 'The SID is fixed. Raise the table to bring the patient up to the receptor: the skin moves away from the focal spot, and the <b>skin dose</b> rate falls with the square of that distance.' },
        { from: 9, to: 14, text: 'A small air gap also means less magnification and blur. On a mobile C-arm the skin must never come closer than 30 cm to the focal spot.' },
        { from: 14, to: 18, text: 'Time, distance, shielding: the fewest pulses and seconds, the smallest field, the most distance, lead in between. The same for every fluoroscopy, start to finish.' },
      ],
    },
  ];
  // the protection chapter's pieces put back when another step starts
  const restore = S.reset;
  S.reset = () => {
    restore();
    mapMesh.visible = false;
    U.bed.position.y = 0;
    U.ceiling.position.y = 0; U.skirt.scale.y = 1;
    U.staff.g.position.set(80, FLOOR_Y, -34); U.staff.g.rotation.y = -Math.PI / 2 - 0.3; U.staff.body.position.y = 0;
    for (const m of U.parts.ring || []) setOpacity(m, 1);
  };
  return { title: 'Radiation protection', steps };
}
