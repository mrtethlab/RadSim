/* FLUOROSCOPY FILM, chapter 4: collimation and the contrast studies. The iris and shutters (and what
   they do to the field and the dose-area product); DAP itself, the same at any distance; a barium
   swallow, the bolus followed down the oesophagus into the stomach in the room and on the monitor;
   an arterial catheter and iodinated contrast; digital subtraction angiography (the mask, the
   subtraction, misregistration); the roadmap.
   The images are the patient model's own projection (live.js) with its own oesophagus, stomach and
   arteries filled; the subtraction and the roadmap are the console's (core/fluoroDisplay.js). */
import * as THREE from 'three';
import { std, mesh, setOpacity } from '../../kit/stage.js';
import { fieldArea } from '../../../core/fieldArea.js';
import { akRate } from '../../../core/fluoroRate.js';
import { roadmapSubtract } from '../../../core/fluoroDisplay.js';
import { panel, boxAt, fanBeam, fieldOutline, cm2 } from './util.js';
import { FIELD_PX, frameCache, along } from './live.js';

export function contrastChapter(api, S) {
  const { px, sfx, span, lerp, clamp01 } = api;
  const U = S.suite, L = S.live, W0 = L.IMG.W, H0 = L.IMG.H;
  const cache = frameCache(120);

  // ================================================================ the collimator, close up (3D)
  /* Its own set: the focal spot at the origin, the beam up +y as under the table. The iris (eight
     lead leaves closing a round opening) 6 cm from the focus, the shutter pair above it (turnable),
     the DAP meter's flat chamber above them, the field cast on a plane 30 cm up. To scale. */
  const coll = new THREE.Group(); coll.position.set(2000, 0, 0); api.scene.add(coll); S.sets.coll = coll;
  const lead = std(0x6a7380, 0.45, 0.6), brass = std(0xb89850, 0.4, 0.7);
  const HALF = 0.116;                                      // the field's half-angle: 23 cm at 99 cm
  const leaves = [];
  for (let k = 0; k < 8; k++) {
    const pivot = new THREE.Group(); pivot.rotation.y = (k / 8) * Math.PI * 2; coll.add(pivot);
    const leaf = mesh(new THREE.BoxGeometry(1.4, 0.08, 1.25), lead, 0, 6, 0); pivot.add(leaf);
    leaves.push(leaf);
  }
  const setIris = (r) => { for (const l of leaves) l.position.x = r + 0.7; };
  const shutG = new THREE.Group(); shutG.position.y = 7.2; coll.add(shutG);
  const shutters = [mesh(new THREE.BoxGeometry(2.4, 0.12, 2.6), lead, 0, 0, 0), mesh(new THREE.BoxGeometry(2.4, 0.12, 2.6), lead, 0, 0, 0)];
  shutG.add(...shutters);
  const setShut = (s, rot) => { shutters[0].position.z = s + 1.3; shutters[1].position.z = -(s + 1.3); shutG.rotation.y = -rot; };
  // a frame round it all (the collimator's body, open toward the viewer)
  coll.add(mesh(new THREE.CylinderGeometry(2.6, 2.6, 4.2, 40, 1, true, Math.PI / 2, Math.PI), new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide, transparent: true, opacity: 0.35 }), 0, 6.8, 0));
  const chamber = mesh(new THREE.BoxGeometry(4.6, 0.25, 4.6), new THREE.MeshStandardMaterial({ color: 0x35c6d6, transparent: true, opacity: 0.25, depthWrite: false, emissive: 0x0b3a40 }), 0, 9.3, 0);
  chamber.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(4.6, 0.25, 4.6)), new THREE.LineBasicMaterial({ color: 0x35c6d6 })));
  coll.add(chamber);
  coll.add(mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshBasicMaterial({ color: 0xfff1b0 }), 0, 0, 0));   // the focal spot
  coll.add(mesh(new THREE.BoxGeometry(3, 0.6, 1.6), brass, 0, -0.5, 0));                                              // the anode's edge below it
  const skinPlane = mesh(new THREE.CircleGeometry(6, 64), new THREE.MeshStandardMaterial({ color: 0xd8a080, roughness: 0.7, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }), 0, 30, 0);
  skinPlane.rotation.x = -Math.PI / 2; coll.add(skinPlane);
  const cBeam = fanBeam(0x9d7bff, 0.22); coll.add(cBeam);
  // the beam through iris radius ri (at 6 cm) and shutter half-gap si (at 7.2), cast to y = 30
  function setCollBeam(ri, si, rot) {
    const D = 30, R = Math.min(ri / 6, HALF) * D, s = (si / 7.2) * D;
    const pts = fieldOutline(R, s, rot).map(([u, v]) => [u, D, v]);
    cBeam.userData.set([0, 0, 0], pts);
    return { R: R / D, s: s / D };                     // the half-angles the field now has
  }

  // ================================================================ the barium swallow (3D)
  // the oesophagus's centreline by height, from its own mesh (the patient's frame, cm)
  const oesLine = (() => {
    const o = U.gi.oesophagus; if (!o) return [];
    const p = o.geometry.attributes.position, bins = new Map();
    for (let i = 0; i < p.count; i++) {
      const z = Math.round(p.getZ(i) * 0.1), b = bins.get(z) || [0, 0, 0];
      b[0] += p.getX(i) * 0.1; b[1] += p.getY(i) * 0.1; b[2]++; bins.set(z, b);
    }
    return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([z, b]) => [b[0] / b[2], b[1] / b[2], z]);
  })();
  const oesZ = oesLine.length ? [oesLine[0][2], oesLine[oesLine.length - 1][2]] : [5, 30];
  const oesAt = (z) => { let best = oesLine[0] || [0, 0, z]; for (const q of oesLine) if (Math.abs(q[2] - z) < Math.abs(best[2] - z)) best = q; return best; };
  const stoBox = U.gi.stomach ? new THREE.Box3().setFromBufferAttribute(U.gi.stomach.geometry.attributes.position) : null;
  // the swallow's timing (s): the bolus front down the oesophagus, then the stomach filling
  const SW = { t0: 1.5, dur: 7, len: 5.5, sto0: 8, stoDur: 6 };
  const frontZ = (t) => lerp(oesZ[1], oesZ[0], clamp01((t - SW.t0) / SW.dur));
  const stoK = (t) => clamp01((t - SW.sto0) / SW.stoDur);
  function paintSwallow(t) {
    const zf = frontZ(t), k = stoK(t), sb = stoBox;
    S.gutPaint((part, x, y, z) => {
      if (part === 'oesophagus') {
        if (t < SW.t0) return 0;
        if (z < zf) return 0;
        if (z < zf + SW.len) return 1;                      // the bolus
        return 0.3;                                         // the coat it leaves on the wall
      }
      if (part === 'stomach' && sb) {
        // supine, the barium pools in the dependent (posterior) fundus first and rises
        const level = sb.min.y * 0.1 + (sb.max.y - sb.min.y) * 0.1 * k * 1.1;
        const top = sb.max.z * 0.1 - (sb.max.z - sb.min.z) * 0.1 * k * 1.3;
        return k > 0 && y < level && z > top ? 1 : 0;
      }
      if (part === 'duodenum') return clamp01((t - SW.sto0 - SW.stoDur + 1) / 3);
      return 0;
    });
  }
  // the same swallow in the image: by image row
  const oesRows = L.lines.oes.length ? [L.lines.oes[0][1], L.lines.oes[L.lines.oes.length - 1][1]] : [25, 184];
  const frontRow = (t) => L.rowOf(frontZ(t));
  const bolusRows = SW.len / L.IMG.CM;
  const oesFill = (t) => (r) => {
    if (t < SW.t0) return 0;
    const rf = frontRow(t);
    if (r > rf) return 0;
    // the bolus: a rounded head, full behind it, squeezed thin at its tail by the contraction
    if (r > rf - bolusRows) return Math.min(1, (rf - r) / 5, (r - (rf - bolusRows)) / (bolusRows * 0.35) + 0.25);
    return 0.08;                                                                                       // the coat behind it
  };
  const stoRows = (() => { let a = H0, b = 0; for (let r = 0; r < H0; r++) for (let c = 0; c < W0; c++) if (L.sto[r * W0 + c] > 0.5) { a = Math.min(a, r); b = Math.max(b, r); } return [a, b]; })();
  // the stomach, top down (the fundus first), only its upper part in the time shown, and dilute where it spreads
  const stoFill = (t) => (r) => { const k = stoK(t); return k <= 0 ? 0 : clamp01((k * 0.6 - (r - stoRows[0]) / (stoRows[1] - stoRows[0])) * 5) * 0.12; };
  const colAt = (r) => { let best = L.lines.oes[0] || [W0 / 2, r]; for (const q of L.lines.oes) if (Math.abs(q[1] - r) < Math.abs(best[1] - r)) best = q; return best[0]; };
  // where the screening field is: on the bolus, then on the stomach
  const swallowField = (t) => {
    const rf = clamp01((t - SW.t0) / SW.dur) < 1 ? frontRow(t) - bolusRows * 0.3 : lerp(oesRows[1], oesRows[1] + 18, clamp01((t - SW.t0 - SW.dur) / 2));
    const cy = Math.max(55, Math.min(H0 - 60, rf));
    const cx = t < SW.t0 + SW.dur ? colAt(cy) : lerp(colAt(oesRows[1]), colAt(oesRows[1]) + 14, clamp01((t - SW.t0 - SW.dur) / 2));
    return { cx, cy };
  };
  const swallowFrame = (t, n = FIELD_PX) => {
    const k = Math.floor(t * 15), f = swallowField(k / 15);
    return cache(`sw:${k}:${n}`, () => L.display(L.frame({ ...f, n, detected: 350, seed: 40000 + k, oes: oesFill(k / 15), sto: stoFill(k / 15) }), n));
  };

  // ================================================================ arteries and the catheter (3D)
  const vessels = new THREE.Group(); U.patient.add(vessels);
  const vesMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, emissive: 0x200404, vertexColors: true });   // (the colour is the vertices': blood red, iodine white)
  const toP = (c, r, y = -2) => new THREE.Vector3(L.xOf(c), y, L.zOf(r));
  const vesTubes = [];
  for (const line of [L.lines.aorta, L.lines.iliacR, L.lines.iliacL, L.lines.extR, L.lines.extL]) {
    if (line.length < 4) continue;
    const pts = line.filter((_, i) => i % 3 === 0).map(([c, r]) => toP(c, r));
    const wid = line.map((q) => q[2]).sort((a, b) => a - b)[Math.floor(line.length / 2)] * L.IMG.CM;
    const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.max(16, pts.length * 2), Math.max(0.35, wid / 2), 12, false);
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(1), 3));
    const m = new THREE.Mesh(geo, vesMat); vessels.add(m); vesTubes.push(m);
  }
  // the iodine in them: by height, from the catheter's tip downstream (toward the feet)
  function paintIodine(zFront, zTip) {
    for (const m of vesTubes) {
      const p = m.geometry.attributes.position, c = m.geometry.attributes.color;
      for (let i = 0; i < p.count; i++) {
        const z = p.getZ(i), on = z <= zTip && z >= zFront ? 1 : 0;
        c.setXYZ(i, 0.7 + 0.3 * on, 0.25 + 0.75 * on, 0.25 + 0.75 * on);
      }
      c.needsUpdate = true;
    }
  }
  vessels.visible = false;
  // the catheter: in at the right groin, up the right iliac artery into the aorta
  const route = L.lines.route;
  const tipF = 0.62;                                                  // how far up the route it goes (the renal arteries' level)
  const catPts = route.filter((_, i) => i % 2 === 0).map(([c, r]) => toP(c, r, -2));
  const groin = toP(route[0]?.[0] ?? W0 * 0.4, Math.min(H0 - 1, (route[0]?.[1] ?? 380) + 40), 4);
  catPts.unshift(groin.clone().add(new THREE.Vector3(0, 4, -3)), groin);
  const catCurve = new THREE.CatmullRomCurve3(catPts);
  const catGeo = new THREE.TubeGeometry(catCurve, 240, 0.16, 8, false);
  const catheter = new THREE.Mesh(catGeo, std(0x2a2f36, 0.4, 0.3, { emissive: 0x0a0c10 })); U.patient.add(catheter); catheter.visible = false;
  const catIndex = catGeo.index.count;
  const setCath = (f) => catGeo.setDrawRange(0, Math.floor(catIndex * clamp01(f) / 6) * 6);
  const tipAt = (f) => catCurve.getPointAt(clamp01(f));

  // ================================================================ DSA and the roadmap (the image)
  // the field over the aortic bifurcation and the iliac arteries, wide (a DSA run's)
  const DSA = { cx: W0 / 2, cy: L.lines.rB + 6, span: 120, n: 84 };
  const tipRow = (() => { const a = along(route.map((q) => [q[0], q[1]]), tipF); return a.at[1]; })();
  // iodine by row: from the tip down, a front moving toward the feet, then washing out
  const ioAt = (tt) => (r) => {
    if (r < tipRow - 4) return 0;
    const front = tipRow + (tt - 0) * 70;                             // ~12 cm/s down the aorta (shown)
    const wash = tt > 4 ? clamp01(1 - (tt - 4) / 3) : 1;
    return r <= front ? wash * clamp01((front - r) / 25 + 0.2) : 0;
  };
  const dsaFrame = (k, tt, { shift = null } = {}) => cache(`dsa:${k}:${shift ? shift.join(',') : ''}`, () =>
    L.frame({ ...DSA, kv: 75, detected: 4000, seed: 60000 + k, io: tt < 0 ? null : ioAt(tt), shift }));
  // the mask: the mean of the first four frames' log
  const mask = (() => {
    const N = DSA.n * DSA.n, m = new Float32Array(N);
    for (let k = 0; k < 4; k++) { const T = dsaFrame(k, -1); for (let i = 0; i < N; i++) m[i] += T[i] < 0 ? 0 : Math.log(T[i]) / 4; }
    return m;
  })();
  // a subtracted frame: log(live) - mask, shown as the angio suite does (vessels dark on grey)
  function subtract(T, { maskShift = null } = {}) {
    const n = DSA.n, out = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const q = j * n + i;
      if (T[q] < 0) { out[q] = -1; continue; }
      let mq = q;
      if (maskShift) { const ii = Math.min(n - 1, Math.max(0, i + maskShift[0])), jj = Math.min(n - 1, Math.max(0, j + maskShift[1])); mq = jj * n + ii; }
      out[q] = clamp01(0.62 + 0.32 * (Math.log(T[q]) - mask[mq]));
    }
    return out;
  }
  // the roadmap: the run's peak iodine (optical depth) over its own mask, then live fluoroscopy with
  // the wire subtracted against it (fluoroDisplay.roadmapSubtract)
  const road = (() => {
    const T = L.frame({ ...DSA, kv: 75, io: () => 1 }), n = DSA.n, r = new Float32Array(n * n);
    for (let i = 0; i < r.length; i++) r[i] = T[i] < 0 ? 0 : Math.max(0, mask[i] - Math.log(T[i]));
    // only where there is iodine (a threshold against the noise-free difference), and held to a modest
    // depth so a wire inside even the widest vessel still shows black against it
    for (let i = 0; i < r.length; i++) r[i] = r[i] < 0.08 ? 0 : Math.min(0.35, r[i]);
    return r;
  })();
  const roadBase = Float32Array.from(mask, (v, i) => (v === 0 && road[i] === 0 ? 1e9 : v));
  const wireRoute = route.map((q) => [q[0], q[1]]);

  const panelAt = (n, sc) => { const s = n * sc; return [Math.round(px.W / 2 - s / 2), Math.max(6, Math.round((px.H - s) / 2) - 10)]; };

  const steps = [
    {
      title: 'Iris and shutters', dur: 17, fadeIn: 0.4, scale: '1 cm',
      enter() { S.only('coll'); },
      cam: [[0, [2014, 13, 15], [2000, 7, 0], 40], [17, [2011, 15, 13], [2000, 7.5, 0], 40]],
      cues: [[2, () => sfx.click()], [7, () => sfx.click()], [11, () => sfx.click()]],
      frame(t) {
        const ri = lerp(0.7, 0.45, span(t, 2, 4.5));
        const si = t < 7 ? 2 : lerp(2, 0.32, span(t, 7, 9));
        const rot = lerp(0, 0.6, span(t, 11, 13));
        setIris(ri); setShut(si, rot);
        const f = setCollBeam(ri, si, rot);
        sfx.hold('beam', 96, 0.015, 'square');
        // the image: the same field on the patient (R, s at the receptor), and the DAP it gives
        const n = 64, sc = Math.max(1, Math.floor(Math.min(px.H * 0.42, px.W * 0.3) / n));
        const Rr = f.R / HALF, sr = f.s / HALF, c = Math.cos(rot), sn = Math.sin(rot);
        const lum = cache(`ir:${Math.round(Rr * 100)}:${Math.round(sr * 100)}:${Math.round(rot * 50)}:${Math.floor(t * 15)}`, () =>
          L.display(L.frame({ cx: W0 / 2, cy: 250, n, detected: 300, seed: 800 + Math.floor(t * 15),
            shape: (u, v) => u * u + v * v <= Rr * Rr && Math.abs(-u * sn + v * c) <= sr }), n));
        panel(api, 4, 4, n * sc + 4, n * sc + 4);
        L.blit(px, lum, n, 6, 6, sc);
        const area = fieldArea(false, Rr * 11.5, sr * 11.5, rot);                         // cm2 at the receptor
        const dapRate = akRate(75, 2.2, 15) * area * (45 / 99) ** 2 / 1000;               // Gy cm2 per minute (the reference point's kerma x its area)
        const w = 64, x = px.W - w - 4;
        panel(api, x, 4, w, 26);
        px.text(dapRate.toFixed(2), x + w - 4, 8, 'yellow', 1, 2, 'right');
        px.text('Gy', x + 4, 20, 'mid'); cm2(px, x + 13, 20, 'mid'); px.text('/min', x + 24, 20, 'mid');
        if (t > 1.5 && t < 6.5) api.mark(boxAt(api, [2000, 6, 0], [1.9, 0.4, 1.9]), 'yellow', t);
        else if (t >= 6.5 && t < 13.5) api.mark(boxAt(api, [2000, 7.2, 0], [2.4, 0.3, 2.4]), 'cyan', t);
        else if (t >= 13.5) api.mark(chamber, 'cyan', t);
      },
      caption: [
        { from: 1.5, to: 6.5, text: 'Above the focal spot, the <b>iris</b>: lead leaves that close the round field down to the area of interest.' },
        { from: 6.5, to: 13.5, text: 'Two lead <b>shutters</b> slide in from the sides to narrow it to a band, and turn to lie along the anatomy.' },
        { from: 13.5, to: 17, text: 'Less tissue in the beam: less dose and less scatter, so better contrast. The <b>DAP meter</b>’s chamber above them measures it all.' },
      ],
    },
    {
      title: 'Dose–area product', dur: 14, scale: '10 cm',
      enter() { S.reset(); U.patient.visible = false; U.bed.visible = false; U.stand.visible = false; discs.visible = true; },
      cam: [[0, [150, 45, 125], [0, -18, 0], 36], [14, [135, 55, 110], [0, -16, 0], 36]],
      frame(t) {
        U.setBeam({ a: 1 });
        const k = span(t, 1, 2.5);
        const rows = [];
        for (const [d, y] of [[30, -30], [60, 0]]) {
          const r = 11.5 * d / 99, A = Math.PI * r * r, K = 4.0 * (30 / d) ** 2;
          const [x, yy] = api.toPx(U.inC(r + 4, y, 0));
          rows.push({ x, y: yy, A, K });
        }
        for (const [i, q] of rows.entries()) {
          const a = span(t, 1 + i * 2.5, 2 + i * 2.5) * k;
          if (a <= 0) continue;
          const w = 50, x = Math.round(q.x + 6), y = Math.round(q.y - 16);
          panel(api, x, y, w, 32, 0.85 * a);
          // the air kerma there, the beam's area there, and (after 7 s) their product, in mGy cm2
          px.text(q.K.toFixed(1), x + 4, y + 4, 'orange', a); px.text('mGy', x + 22, y + 4, 'mid', a);
          px.text(String(Math.round(q.A)), x + 4, y + 13, 'cyan', a); cm2(px, x + 22, y + 13, 'mid', a);
          if (t > 7) { px.text(String(Math.round(q.K * q.A)), x + 4, y + 22, 'yellow', a); px.text('mGy', x + 18, y + 22, 'mid', a); cm2(px, x + 31, y + 22, 'mid', a); }
        }
        for (const [i, d] of discs.children.entries()) d.material.opacity = 0.35 * span(t, 1 + i * 2.5, 2 + i * 2.5);
        if (t > 1 && t < 3.5) api.mark(discs.children[0], 'orange', t);
        else if (t >= 3.5 && t < 7) api.mark(discs.children[1], 'orange', t);
        else if (t >= 7) api.mark(discs, 'yellow', t);
      },
      caption: [
        { from: 1, to: 7, text: 'At twice the distance from the focus the air kerma is a quarter (inverse square), but the beam covers four times the area.' },
        { from: 7, to: 14, text: 'Their product, the <b>dose–area product</b> (DAP), is the same at any distance: one number for how much radiation went into the patient, collimation included.' },
      ],
    },
    {
      title: 'Barium swallow', dur: 17, scale: '10 cm',
      enter() { S.reset(); U.skinAlpha(0.22); if (U.boneG) setOpacity(U.boneG, 0.25); },
      cam: [[0, [120, 70, 110], [0, 15, 8], 38], [17, [105, 80, 95], [0, 15, 4], 38]],
      cues: [[1.4, () => sfx.thud()]],
      frame(t) {
        paintSwallow(t);
        // the table follows the bolus: the beam stays on it
        const f = swallowField(t), z = L.zOf(f.cy);
        U.bed.position.z = -z;
        U.setBeam({ a: 0.9 });
        sfx.hold('beam', 96, 0.012, 'square');
        const n = 72, sc = Math.max(1, Math.floor(Math.min(px.H * 0.45, px.W * 0.3) / n));
        panel(api, 4, 4, n * sc + 4, n * sc + 4);
        L.blit(px, swallowFrame(t, n), n, 6, 6, sc);
        if (t > SW.t0 && t < SW.t0 + SW.dur) {
          const p = oesAt(frontZ(t) + SW.len / 2);
          const w = U.patient.localToWorld(new THREE.Vector3(p[0], p[1], p[2])).toArray();
          api.mark(boxAt(api, w, [3, 3, SW.len / 2 + 1]), 'yellow', t, { live: true });
        } else if (t > SW.sto0 && U.gi.stomach) api.mark(U.gi.stomach, 'yellow', t, { live: true });
      },
      caption: [
        { from: 0.6, to: 4.5, text: 'A <b>barium swallow</b>: the patient drinks a barium sulfate suspension while the oesophagus is screened.' },
        { from: 4.5, to: 9, text: 'A wave of contraction, <b>peristalsis</b>, carries the bolus down. Table and beam follow it, a low pulse rate screening all the way.' },
        { from: 9, to: 17, text: 'Into the stomach. Lying on the back, the heavy barium pools in its back part, the fundus, first.' },
      ],
    },
    {
      title: 'On the monitor: barium', dur: 17, view: 'pixel', scale: '1 cm',
      cues: [[12.5, () => sfx.click()]],
      frame(t) {
        px.fillAll('ink');
        const n = FIELD_PX, sc = Math.max(1, Math.floor((px.H - 24) / n)), [x, y] = panelAt(n, sc);
        L.blit(px, swallowFrame(t, n), n, x, y, sc);
        api.keepOut([x, y, n * sc, n * sc]);
        // the bolus: its head and tail in the field
        const f = swallowField(t), rf = frontRow(t), k = n * sc / FIELD_PX;
        if (t > SW.t0 && t < SW.t0 + SW.dur) {
          const yb = y + (rf - (f.cy - FIELD_PX / 2)) * k, ya = yb - bolusRows * k, xc = x + (colAt(rf - bolusRows / 2) - (f.cx - FIELD_PX / 2)) * k;
          api.mark([xc - 10 * sc, Math.max(y, ya), 20 * sc, Math.min(yb, y + n * sc) - Math.max(y, ya)], 'yellow', t);
        }
        // a spot image: the moment stored, sent to the reference screen
        if (t > 12.5) {
          const a = span(t, 12.5, 13.2), s = 48, sx = lerp(x, px.W - s - 6, a), sy = lerp(y, 6, a), ss = lerp(n * sc, s, a);
          const spot = cache('spot', () => L.display(L.frame({ ...swallowField(12.5), n: 48, detected: 3000, seed: 77, oes: oesFill(12.5), sto: stoFill(12.5) }), 48));
          px.frame(sx - 1, sy - 1, ss + 2, ss + 2, 'white', 0.8);
          L.blit(px, spot, 48, sx, sy, ss / 48);
          if (t > 13.2) api.keepOut([sx - 2, sy - 2, ss + 4, ss + 4]);
        }
      },
      caption: [
        { from: 0.6, to: 4.5, text: 'On the live image barium is <b>dark</b>: it absorbs so strongly that almost nothing reaches the receptor behind it.' },
        { from: 4.5, to: 9, text: 'The bolus outlines the lumen as it goes: its width, its wall, any narrowing or hold-up, and how the wave clears it.' },
        { from: 9, to: 12.5, text: 'Then the stomach fills, the fundus first.' },
        { from: 12.5, to: 17, text: 'A <b>spot image</b> (a single frame at a higher dose, less noisy) stores the moment for the report.' },
      ],
    },
    {
      title: 'Iodinated contrast', dur: 16, scale: '10 cm',
      enter() { S.reset(); U.skinAlpha(0.2); if (U.gutG) U.gutG.visible = false; if (U.boneG) setOpacity(U.boneG, 0.35); vessels.visible = true; catheter.visible = true; U.bed.position.z = -L.zOf(DSA.cy); },
      cam: [[0, [70, 120, 70], [0, 8, -4], 40], [16, [55, 125, 55], [0, 8, -6], 38]],
      cues: [[8, () => sfx.whoosh()]],
      frame(t) {
        setCath(span(t, 0.8, 6.5, api.ease.inOut) * tipF);
        const tip = tipAt(span(t, 0.8, 6.5, api.ease.inOut) * tipF);
        const zTip = tipAt(tipF).z, zFront = t < 8 ? 99 : zTip - (t - 8) * 9;
        paintIodine(t < 8 ? 99 : zFront, t < 8 ? -99 : zTip);
        U.setBeam({ a: 0.8 });
        const w = U.patient.localToWorld(tip.clone()).toArray();
        if (t > 1 && t < 8) api.mark(boxAt(api, w, [2.5, 2.5, 2.5]), 'yellow', t, { live: true });
        else if (t >= 8) api.mark(vessels, 'cyan', t);
      },
      caption: [
        { from: 0.8, to: 8, text: 'For arteries, a <b>catheter</b> is passed in at the groin, up the iliac artery into the aorta, steered under fluoroscopy.' },
        { from: 8, to: 16, text: '<b>Iodinated contrast</b> (iodine, Z = 53, K-edge 33 keV) is injected through it and carried off with the blood: the run is recorded as it flows.' },
      ],
    },
    {
      title: 'DSA: the mask', dur: 14, view: 'pixel', scale: '1 cm',
      cues: [[0.4, () => sfx.blip(990)], [0.9, () => sfx.blip(990)], [1.4, () => sfx.blip(990)], [1.9, () => sfx.blip(990)]],
      frame(t) {
        px.fillAll('ink');
        const n = DSA.n, sc = Math.max(1, Math.floor((px.H - 24) / n)), [x, y] = panelAt(n, sc);
        // frames at 4 a second: the first four averaged into the mask, then the contrast arrives
        const k = Math.floor(t * 4), tt = t - 3;
        const T = dsaFrame(k, tt < 0 ? -1 : tt);
        const lum = cache('dl' + k, () => L.display(T, n));
        L.blit(px, lum, n, x, y, sc);
        api.keepOut([x, y, n * sc, n * sc]);
        // the mask, filling in as its frames are summed
        const ms = 44, mx = 6, my = 6, a = span(t, 0.2, 2.2);
        const mlum = cache('masklum', () => L.display(Float32Array.from(mask, (v) => (v === 0 ? -1 : Math.exp(v))), n));
        panel(api, mx - 2, my - 2, ms + 4, ms + 4);
        L.blit(px, mlum, n, mx, my, ms / n, { a });
        if (t < 3) api.mark([mx - 3, my - 3, ms + 6, ms + 6], 'cyan', t);
        else api.mark([x + n * sc * 0.25, y + n * sc * 0.05, n * sc * 0.5, n * sc * 0.9], 'yellow', t);
      },
      caption: [
        { from: 0.4, to: 3, text: '<b>Digital subtraction angiography</b> (DSA) starts with a <b>mask</b>: frames of the anatomy before the contrast, averaged.' },
        { from: 3, to: 14, text: 'Then the iodine flows in, frame by frame (at a much higher dose per frame than screening). On the plain image the vessels are faint, crossed by bone and bowel.' },
      ],
    },
    {
      title: 'DSA: subtraction', dur: 17, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('ink');
        const n = DSA.n, sc = Math.max(1, Math.floor((px.H - 24) / n)), [x, y] = panelAt(n, sc);
        const k = Math.floor(t * 4) + 40, tt = Math.min(3.2, 0.5 + t * 0.5);
        // after 9 s the patient moves a pixel each way (about 2.5 mm); at 13 the mask is shifted to match
        const moved = t > 9 ? [1, 1] : null, fix = t > 13 ? [1, 1] : null;
        const T = dsaFrame(k, tt, { shift: moved });
        const lum = cache(`sub:${k}:${moved ? 1 : 0}:${fix ? 1 : 0}`, () => subtract(T, { maskShift: fix }));
        L.blit(px, lum, n, x, y, sc);
        api.keepOut([x, y, n * sc, n * sc]);
        if (t > 9 && t < 13) api.mark([x + n * sc * 0.3, y + n * sc * 0.45, n * sc * 0.4, n * sc * 0.5], 'orange', t);
        else if (t <= 9) api.mark([x + n * sc * 0.25, y + n * sc * 0.05, n * sc * 0.5, n * sc * 0.9], 'yellow', t);
      },
      cues: [[9, () => sfx.blip(330)], [13, () => sfx.blip(880)]],
      caption: [
        { from: 0.6, to: 9, text: 'Subtract the mask from each frame (in logarithms): bone and bowel cancel, and only what changed is left, the iodine. The vessels stand alone.' },
        { from: 9, to: 13, text: 'If the patient moves between mask and frame the anatomy no longer cancels: bright and dark edges, <b>misregistration</b>.' },
        { from: 13, to: 17, text: 'Shifting the mask a pixel or two to match (<b>pixel shift</b>) repairs small movements.' },
      ],
    },
    {
      title: 'Roadmap', dur: 17, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('ink');
        const n = DSA.n, sc = Math.max(1, Math.floor((px.H - 24) / n)), [x, y] = panelAt(n, sc);
        const k = Math.floor(t * 15), fw = 0.05 + 0.55 * span(t, 3, 15, api.ease.linear);
        const wire = along(wireRoute, fw);
        const lum = cache(`rm:${k}`, () => {
          const T = L.frame({ ...DSA, kv: 75, detected: 300, seed: 90000 + k, paint: [{ pts: wire.upto, od: 1.4, w: 0.8 }] });
          const out = L.display(T, n);
          if (t > 1.5) roadmapSubtract(T, n, out, road, roadBase, n);
          return out;
        });
        L.blit(px, lum, n, x, y, sc);
        api.keepOut([x, y, n * sc, n * sc]);
        // the wire's tip
        const tx = x + (wire.at[0] - (DSA.cx - DSA.span / 2)) * n * sc / DSA.span, ty = y + (wire.at[1] - (DSA.cy - DSA.span / 2)) * n * sc / DSA.span;
        if (t > 5) api.mark([tx - 8, ty - 8, 16, 16], 'yellow', t);
      },
      caption: [
        { from: 0.6, to: 5, text: '<b>Roadmapping</b>: the run’s peak-contrast frame is kept as a map, and live fluoroscopy is subtracted from it. The anatomy cancels to grey, the vessels stand white.' },
        { from: 5, to: 17, text: 'Whatever arrives since shows black inside them: here a <b>guidewire</b>, steered along the map with no more contrast injected.' },
      ],
    },
  ];

  // the two discs of the DAP step, in the C's frame: 30 and 60 cm from the focal spot
  const discs = new THREE.Group(); U.carm.c.add(discs); discs.visible = false;
  for (const [d, y] of [[30, -30], [60, 0]]) {
    const r = 11.5 * d / 99;
    const m = mesh(new THREE.CircleGeometry(r, 48), new THREE.MeshBasicMaterial({ color: 0xffa300, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }), 0, y, 0);
    m.rotation.x = -Math.PI / 2; discs.add(m);
  }
  // (the room steps leave the bed visible and the extras hidden for the next chapter)
  const restore = S.reset;
  S.reset = () => { restore(); if (U.gutG) U.gutG.visible = true; U.bed.visible = true; U.stand.visible = true; discs.visible = false; vessels.visible = false; catheter.visible = false; };
  return { title: 'Collimation and contrast', steps };
}
