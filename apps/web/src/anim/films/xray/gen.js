/* X-RAY FILM, chapter 1: making the x-rays. The tube's own parts at work (filament current, the
   electron cloud, the rotor, the kV across the gap, the focal spot and its heat), then down into
   the tungsten target, an 8-bit field of atoms where the electrons' energy becomes heat,
   bremsstrahlung and characteristic photons, and back out: the beam through the housing's port,
   the filter, the collimator. */
import { atom, electron, keVColor, spectrumPlot, tungstenSpectrum } from '../../kit/micro.js';
import { makeParticles, drawParticles, coneDir, toPlaneY, norm } from '../../kit/flux.js';
import { setOpacity, beamCone } from '../../kit/stage.js';
import { ANODE_Y, ANODE_ANGLE } from './tube.js';

export function generation(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const T = S.tube;                         // the insert (tube.js), in its own set
  const show = (k) => { S.only(k); T.heatMat.opacity = 0; T.heatMat.emissiveIntensity = 0; T.coll.visible = true; xBeam.visible = xLight.visible = false; };

  // a small panel of readouts top right: [label, value, color]
  const hud = (rows) => {
    const w = 46, h = 4 + rows.length * 9, x = px.W - w - 4, y = 4;
    px.rect(x, y, w, h, 'ink', 0.85); px.frame(x, y, w, h, 'dkgrey');
    api.keepOut([x, y, w, h]);
    rows.forEach(([lab, val, c], i) => {
      px.text(lab, x + 3, y + 3 + i * 9, 'mid');
      px.text(val, x + w - 3, y + 3 + i * 9, c || 'yellow', 1, 1, 'right');
    });
  };

  // ---------------------------------------------------------------- the electron cloud
  const cloud = makeParticles(70, 11, (i, r) => ({ i, ph: r() * 6.28, rad: 0.12 + r() * 0.45, sp: 0.6 + r() * 1.6, y: (r() - 0.5) * 0.9, z: (r() - 0.5) * 1.0, on: r() }));
  const filPos = T.at.filament;
  function drawCloud(t, k) {
    for (const e of cloud) {
      if (e.on > k) continue;
      const a = t * e.sp + e.ph;
      const p = [filPos[0] - 0.05 - Math.abs(Math.cos(a)) * e.rad * 0.8, e.y * 0.35 + Math.sin(a * 1.3) * e.rad * 0.4, e.z * 0.6 + Math.sin(a) * e.rad * 0.3];
      const [x, y, f] = api.toPx(p);
      if (f) px.px(x, y, 'cyan', 0.85);
    }
  }
  // ---------------------------------------------------------------- the beam across the gap
  // electrons leave the cloud and fall to the focal spot, faster and faster (a constant field),
  // squeezed by the cup to a line
  const gap = filPos[0];
  // (squeezed to a line up the bevel: tall in y, narrow in z, the actual focal spot's shape)
  const stream = makeParticles(260, 21, (i, r) => ({ i, t0: i * 0.023 + r() * 0.02, y0: (r() - 0.5) * 0.5, z0: (r() - 0.5) * 0.9, z1: (r() - 0.5) * 0.25, y1: (r() - 0.5) * 0.7 }));
  const TRANSIT = 0.55;
  function drawStream(t, density = 1, slow = 1) {
    for (const e of stream) {
      if ((e.i % 10) / 10 >= density) continue;
      const age = (t - e.t0 * slow) / slow;
      const k = (age % TRANSIT) / TRANSIT;           // looping: the stream never runs dry
      if (age < 0) continue;
      const f = k * k;                                // accelerating
      const p = [gap * (1 - f), lerp(e.y0, e.y1, f), lerp(e.z0, e.z1, f)];
      const [x, y, front] = api.toPx(p);
      if (!front) continue;
      const [x2, y2] = api.toPx([gap * (1 - Math.max(0, k - 0.06) ** 2), lerp(e.y0, e.y1, f), lerp(e.z0, e.z1, f)]);
      px.line(x2, y2, x, y, 'blue', 0.4);
      px.px(x, y, 'cyan', 0.95);
    }
  }
  // the anode's spin: an angle at time t for an rpm that ramps over [a, b]
  const spinAt = (t, a, b, rpm = 3400) => {
    // integrated: the angle of a spin-up that is linear in speed between a and b
    const w = (rpm / 60) * Math.PI * 2 * 0.06;           // shown slowed: 3,400 rpm would strobe
    if (t < a) return 0;
    if (t < b) return 0.5 * w * (t - a) ** 2 / (b - a);
    return 0.5 * w * (b - a) + w * (t - b);
  };

  // ---------------------------------------------------------------- photons out of the focal spot
  // energies drawn from the unfiltered spectrum; directions over the half-space toward the port
  // (and some everywhere else, which the lead stops); the heel effect thins those toward the anode
  const spec80 = tungstenSpectrum(80, 0.0);
  const brems80 = tungstenSpectrum(80, 0.0, false);
  const sampleE = (r) => { for (;;) { const E = 10 + r() * 70; if (r() < spec80(E)) return E; } };
  const portY = T.at.portY, filterY = T.at.filterY, bladeY = T.at.bladesY;
  const out = makeParticles(2600, 31, (i, r) => {
    const E = sampleE(r);
    let dir = coneDir(r, [0, -1, 0], r() < 0.75 ? 0.62 : 2.6);
    // the heel: photons leaving toward the anode (-x) along the target's face are absorbed in it
    const heel = dir[0] < 0 ? clamp01(-dir[0] / 0.6) : 0;
    let end = 40, fate = 'out';
    const hitHousing = 8.0;                                        // the lead lining, from the spot
    if (dir[1] > -0.25 || Math.hypot(dir[0], dir[2]) / -dir[1] > 0.55) { end = hitHousing * (0.75 + r() * 0.2); fate = 'lead'; }
    else if (r() < heel * 0.85) { end = 0.3 + r() * 0.4; fate = 'heel'; }
    return { i, t0: i * 0.0052 + r() * 0.01, from: [0, 0, 0], dir, v: 30, end, fate, E };
  });
  // the same photons met by the added filter, then the collimator (decided per film step)
  function photonFate(p, { filter = false, coll = null }) {
    if (p.fate !== 'out') return p;
    const q = { ...p };
    const dF = toPlaneY(p.from, p.dir, filterY);
    if (filter && dF < q.end) {
      // aluminium takes the soft photons: absorption by E (the app's own mu, 2.5 mm)
      const keep = Math.exp(-S.muAl(p.E) * 0.25);
      if (((p.i * 7919) % 1000) / 1000 > keep) { q.end = dF; q.fate = 'filter'; return q; }
    }
    if (coll) {
      // the upper pair limits x, the lower pair z (the field's half-widths at each)
      const d1 = toPlaneY(p.from, p.dir, bladeY[0]), d2 = toPlaneY(p.from, p.dir, bladeY[1]);
      if (Math.abs(p.dir[0] * d1) > coll[0]) { q.end = d1; q.fate = 'blade'; }
      else if (Math.abs(p.dir[2] * d2) > coll[1]) { q.end = d2; q.fate = 'blade'; }
    }
    return q;
  }

  // ---------------------------------------------------------------- the tungsten field (8-bit)
  const field = (() => {
    const cols = [], r = rng(5);
    return {
      atoms(W, H, spacing) {
        cols.length = 0;
        for (let y = 14; y < H - 10; y += spacing) for (let x = 30 + ((y / spacing) % 2) * spacing / 2; x < W - 8; x += spacing) cols.push([x, y]);
        return cols;
      },
      r,
    };
  })();

  /* The micro scene: tungsten atoms (74 electrons; drawn as 2/8/18/... a hint), electrons coming
     in from the left. Every electron's fate is set by its index: most give their energy up as heat
     a little at a time to the outer shells; some swing round a nucleus and radiate
     (bremsstrahlung); a few knock out a K electron (characteristic). `hi` picks one to slow down
     and point at. Returns the photons emitted so far (for the spectrum). */
  let hottest = 0, hotHeld = 0, hotHeldAt = -1;
  /* The micro scene: tungsten atoms (74 electrons; drawn as 2/8/12, a hint), electrons coming in
     from the left. Every electron's fate is set by its index: most give their energy up as heat
     a little at a time to the outer shells; some swing round a nucleus and radiate
     (bremsstrahlung); a few knock out a K electron (characteristic). `hi` makes the electron born
     at hiAt one of that kind, slowed by `slow`, drawn in yellow, everything else dimmed round it. */
  function targetScene(t, { rate = 3, hi = null, hiAt = 0, slow = 1, kVp = 80, showHeat = true, avoid = [] }) {
    px.fillAll('ink');
    const W = px.W, H = px.H, sp = 26;
    const atoms = field.atoms(W, H, sp);
    const heat = new Float32Array(atoms.length);
    const N = Math.floor(t * rate) + 1;
    const fi = hi ? Math.floor(hiAt * rate) : -1;           // the focus electron's index
    const emitted = [], events = [];
    // (only the last 8 s of electrons can still be seen or still warm an atom: a held step runs on)
    for (let i = Math.max(0, N - Math.ceil(rate * 8)); i <= N; i++) {
      const r = rng(1000 + i);
      const roll = r();
      const kind = i === fi ? hi : (roll < 0.86 ? 'heat' : roll < 0.975 ? 'brems' : 'char');
      const focus = i === fi;
      const age = (t - i / rate) / (focus ? slow : 1);
      if (age < 0) continue;
      let tgt = atoms[Math.floor(r() * atoms.length)];
      if (focus) {
        // the slowed one lands where it can be seen: clear of any panel, with room below it for
        // its photon (they leave toward the port, down the screen)
        const ok = (a) => a[1] > H * 0.22 && a[1] < H * 0.55 && a[0] > W * 0.3 && a[0] < W * 0.8
          && avoid.every((b) => a[0] < b[0] - 16 || a[0] > b[0] + b[2] + 16 || a[1] < b[1] - 16 || a[1] > b[1] + b[3] + 16);
        for (let k = 0; k < 80 && !ok(tgt); k++) tgt = atoms[Math.floor(r() * atoms.length)];
      }
      events.push({ i, kind, age, tgt, r, focus });
    }
    const F = events.find((e) => e.focus);
    const focusOn = F && F.age < (F.kind === 'brems' ? 3.4 : 3.4);
    const dim = focusOn ? 0.3 : 1;
    for (const ev of events) {
      if (ev.kind === 'heat' && ev.age > 0.6 && ev.age < 6) {
        for (let k = 0; k < atoms.length; k++) {
          const d = Math.hypot(atoms[k][0] - ev.tgt[0], atoms[k][1] - ev.tgt[1]);
          if (d < sp * 1.6) heat[k] += 0.55 * Math.exp(-(ev.age - 0.6) * 0.45) * (1 - d / (sp * 1.6));
        }
      }
    }
    const warm = showHeat ? Math.min(0.35, t * 0.012) : 0;
    for (let k = 0; k < heat.length; k++) heat[k] = showHeat ? heat[k] + warm : heat[k] * 0.25;
    hottest = heat.indexOf(Math.max(...heat));
    atoms.forEach(([x, y], k) => atom(px, x, y, 8, t, { shells: [2, 8, 12], seed: k, heat: Math.min(1, heat[k]),
      ring: 'navy', e: 'blue', nucleus: 'orange', a: focusOn && F.tgt === atoms[k] ? 1 : dim,
      missing: F && F.kind === 'char' && F.tgt === atoms[k] && F.age > 0.8 && F.age < 1.95 ? 0 : -1 }));
    for (const ev of events) {
      const { kind, age, tgt, r, focus } = ev;
      const a = focus ? 1 : dim * 0.85, ec = focus ? 'yellow' : 'cyan';
      const startY = tgt[1] + (r() - 0.5) * 6;
      if (kind === 'heat') {
        if (age > 1.6) continue;
        const pos = (ag) => { const k = ag / 1.6; return [lerp(W + 4, tgt[0] - 12, Math.sqrt(k)), startY + Math.sin(ag * 9 + ev.i) * 4 * k]; };
        for (let j = 1; j <= 4; j++) { const q = pos(Math.max(0, age - j * 0.03)); px.px(q[0], q[1], 'blue', a * (0.5 - j * 0.1)); }
        const [x, y] = pos(age);
        electron(px, x, y, a * (1 - (age / 1.6) * 0.6));
      } else if (kind === 'brems') {
        // it comes past the nucleus at an impact distance b; the closer, the harder it is bent
        // and the more energy the photon it radiates carries
        const b = focus ? 4 : 2 + r() * 9, E = Math.min(kVp, kVp * (1 - b / 12) * (0.6 + r() * 0.4));
        const tIn = 0.9, x0 = W + 4, nx = tgt[0], ny = tgt[1] - b;
        const bend = (1 - b / 12) * 1.2;
        const path = (ag) => {
          if (ag < tIn) return [lerp(x0, nx, ag / tIn), ny];
          const k = Math.min(1.4, (ag - tIn) / 0.8);
          return [nx - Math.cos(bend) * 40 * k * (0.4 + b / 12), ny + Math.sin(bend) * 40 * k * 0.6];
        };
        if (focus) {                                   // its whole path, dotted, as it goes
          for (let ag = 0; ag < Math.min(age, tIn + 1.1); ag += 0.04) { const q = path(ag); px.px(q[0], q[1], 'yellow', 0.45); }
          if (age < 3.4) { api.mark([nx - 13, ny - 13 + b, 26, 26], 'yellow', t); api.keepOut([nx - 34, ny + b + 10, 52, 90]); }
        }
        const [ex, ey] = path(age);
        if (age < tIn + 1.05) electron(px, ex, ey, a * (age < tIn ? 1 : 1 - (age - tIn) / 1.2), age < tIn ? ec : 'blue');
        const pa = age - tIn;
        if (pa > 0 && pa < 2.2) {
          const ang = focus ? Math.PI / 2 + 0.35 : Math.PI / 2 + (r() - 0.5) * 1.8;   // down, toward the port
          const L = pa * 90;
          const fx = nx + Math.cos(ang) * L, fy = ny + Math.sin(ang) * L;
          if (fx > -5 && fx < W + 5 && fy > -5 && fy < H + 5) px.photon(fx, fy, Math.cos(ang), Math.sin(ang), focus ? 10 : 6, keVColor(E), focus ? 1 : a, t * 30 + ev.i);
          if (pa < 0.15) px.glow(nx, ny, focus ? 6 : 4, 'white', 0.9, ev.i);
        }
        if (pa > 0) emitted.push(E);
      } else {
        // characteristic: it knocks out a K electron; an L electron falls into the hole and the
        // difference leaves as a photon of tungsten's own energy (59 keV, K-alpha)
        const tIn = 0.8, ok = kVp > 69.5;
        if (age < tIn) {
          const k = age / tIn;
          if (focus) for (let ag = 0; ag < age; ag += 0.04) px.px(lerp(W + 4, tgt[0] + 2, ag / tIn), lerp(startY, tgt[1], ag / tIn), 'yellow', 0.45);
          electron(px, lerp(W + 4, tgt[0] + 2, k), lerp(startY, tgt[1], k), a, ec);
          if (focus) { api.mark([tgt[0] - 13, tgt[1] - 13, 26, 26], 'yellow', t); api.keepOut([tgt[0] - 30, tgt[1] + 16, 60, 90]); }
          continue;
        }
        const e = age - tIn;
        if (e < 1.2) {                                  // the K electron knocked out, the incoming one goes on
          electron(px, tgt[0] + e * 30, tgt[1] - e * 22, a * (1 - e / 1.2), focus ? 'red' : 'cyan');
          electron(px, tgt[0] - e * 36, tgt[1] - e * 10, a * (1 - e / 1.2), 'blue');
        }
        if (ok && e < 2.6) {
          const drop = clamp01((e - 0.45) / 0.55);     // an L electron falls into the K hole
          const hx = tgt[0] + 3, hy = tgt[1];
          if (drop < 1 && focus) px.frame(hx - 2, hy - 2, 5, 5, 'red', 0.9);
          if (drop > 0 && drop < 1) { const lx = lerp(tgt[0] + 7, hx, drop), ly = lerp(tgt[1] - 6, hy, drop); px.rect(lx - 1, ly - 1, 3, 3, 'yellow', a); }
          if (e > 1.0) {
            const pa = e - 1.0, ang = focus ? Math.PI / 2 - 0.3 : Math.PI / 2 + ((ev.i % 5) - 2) * 0.35, L = pa * 90;
            if (pa < 1.6) px.photon(hx + Math.cos(ang) * L, hy + Math.sin(ang) * L, Math.cos(ang), Math.sin(ang), focus ? 10 : 6, keVColor(59), focus ? 1 : a, t * 30);
          }
        }
        if (ok && e > 1.0) emitted.push(59);
        if (focus && e < 2.6) { api.mark([tgt[0] - 13, tgt[1] - 13, 26, 26], 'yellow', t); api.keepOut([tgt[0] - 30, tgt[1] + 16, 60, 90]); }
      }
    }
    return { emitted, atoms };
  }

  // ---------------------------------------------------------------- the steps
  const tubeCam = { pos: [3, 7, 46], look: [-1, 1, 0] };
  // the beam as a soft pyramid from the focal spot through the blades' opening (and the light
  // field, the same pyramid in lamp-light)
  const xBeam = beamCone(0x9d7bff, 0.16), xLight = beamCone(0xfff1a0, 0.12);
  T.g.add(xBeam, xLight);
  const fieldAt = (hx, hz, D) => {
    const kx = hx * D / -bladeY[0], kz = hz * D / -bladeY[1];
    return [[-kx, -D, -kz], [kx, -D, -kz], [kx, -D, kz], [-kx, -D, kz]];
  };
  const steps = [
    {
      title: 'The x-ray room', dur: 8, fadeIn: 0.6, fadeOut: 0.5, scale: '1 m',
      enter() { show('room'); },
      cam: [[0, [190, 150, 210], [0, 30, 0], 40], [8, [55, 120, 60], [0, 95, 0], 40]],
      frame(t) {
        if (t > 4.5) api.mark(S.room.tubeHead, 'yellow', t);
      },
      caption: [{ from: 4.5, to: 8, text: 'The x-rays come from the <b>tube</b> in the ceiling-mounted head above the table.' }],
    },
    {
      title: 'Inside the tube head', dur: 9, fadeIn: 0.5, scale: '10 cm',
      enter() { show('tube'); T.spin.rotation.x = 0; T.filMat.emissiveIntensity = 0; setOpacity(T.housing, 1); },
      cam: [[0, [40, 30, 70], [-1, 2, 0], 38], [9, tubeCam.pos, tubeCam.look, 38]],
      frame(t) {
        setOpacity(T.housing, 1 - span(t, 1.2, 4) * 0.82);
        if (t > 4.5 && t < 6.6) api.mark(T.cathode, 'cyan', t);
        if (t > 6.6) api.mark(T.anode, 'yellow', t);
      },
      caption: [
        { from: 1.5, to: 4.5, text: 'The housing is lined with <b>lead</b> and filled with oil. Inside, a vacuum glass insert.' },
        { from: 4.5, to: 6.6, text: 'On one side, the <b>cathode</b>: the source of the electrons.' },
        { from: 6.6, to: 9, text: 'On the other, the <b>anode</b>: a tungsten target on a disc that spins.' },
      ],
    },
    {
      title: 'Filament current', dur: 10, scale: '1 cm',
      enter() { show('tube'); setOpacity(T.housing, 0); },
      // into the cup's slot from the anode's side, where the filament faces
      cam: [[0, [-2, 4, 14], [3.8, 0.2, 0], 34], [10, [1.7, 0.5, 2.6], [4.5, 0, 0], 32]],
      cues: [[0.8, () => sfx.power()]],
      frame(t) {
        const heat = span(t, 0.8, 5);
        T.filMat.emissiveIntensity = heat * 1.6;
        T.filMat.emissive.setRGB(1, 0.3 + heat * 0.35, 0.05 + heat * 0.1);
        sfx.hold('fil', 60 + heat * 30, 0.06 * heat, 'triangle');
        drawCloud(t, span(t, 3.5, 9));
        hud([['mA', String(Math.round(200 * heat)), 'yellow'], ['T', Math.round(20 + 2380 * heat) + '°C', 'orange']]);
        if (t > 3) api.mark(T.filament, 'orange', t);
      },
      caption: [
        { from: 1.0, to: 5.2, text: 'The <b>filament current</b> heats the coiled tungsten filament to about 2,400 °C.' },
        { from: 5.2, to: 10, text: 'Electrons boil off its surface (<b>thermionic emission</b>) and gather round it as a cloud: the space charge. More current, more electrons.',
          at: () => { const [x, y] = api.toPx(filPos); return [x - 3, y]; } },
      ],
    },
    {
      title: 'The rotor spins up', dur: 9, scale: '10 cm',
      enter() { show('tube'); setOpacity(T.housing, 0.18); T.filMat.emissiveIntensity = 1.6; T.filMat.emissive.setRGB(1, 0.65, 0.15); },
      cam: [[0, [-6, 14, 30], [-8, 4, 0], 36], [9, [-2, 9, 26], [-6, 4, 0], 36]],
      cues: [[0.5, () => sfx.power()]],
      frame(t) {
        const k = span(t, 0.5, 6.5, api.ease.linear);
        T.spin.rotation.x = spinAt(t, 0.5, 6.5);
        T.statorMat.emissiveIntensity = 0.6 + 0.5 * Math.abs(Math.sin(t * 18));
        sfx.hold('rotor', 120 + k * 760, 0.05 + 0.04 * k, 'square');
        hud([['rpm', String(Math.round(3400 * k)), 'lime']]);
        if (t > 1) api.mark(T.stator, 'lime', t);
      },
      caption: [{ from: 1, to: 9, text: 'Before the exposure, the <b>stator</b> coils outside the glass turn the rotor and the anode disc with it, to about 3,400 rpm.' }],
    },
    {
      title: 'kV: across the gap', dur: 11, scale: '1 cm',
      enter() { show('tube'); setOpacity(T.housing, 0); T.filMat.emissiveIntensity = 1.6; T.filMat.emissive.setRGB(1, 0.65, 0.15); },
      cam: [[0, [3, 2.5, 13], [2.2, 0.3, 0], 34], [11, [2.4, 1.8, 9], [1.9, 0.2, 0], 34]],
      cues: [[1.2, () => sfx.zap()]],
      frame(t) {
        T.spin.rotation.x = spinAt(t + 30, 0, 0.01);
        const kv = span(t, 1, 2.6);
        sfx.hold('rotor', 880, 0.05, 'square');
        sfx.hold('beam', 200 + kv * 400, 0.04 * kv, 'sawtooth');
        drawCloud(t, 1 - kv * 0.6);
        if (kv > 0.05) drawStream(t, kv);
        T.spotMat.opacity = kv * (0.75 + 0.25 * Math.sin(t * 30));
        hud([['kV', String(Math.round(80 * kv)), 'yellow'], ['mA', '200', 'yellow']]);
        if (t > 6) api.mark(T.cup, 'cyan', t);
      },
      caption: [
        { from: 1.2, to: 6, text: 'The <b>kV</b> is the voltage between cathode (−) and anode (+). It pulls the electrons across the gap at up to half the speed of light; the <b>mA</b> is how many cross each second.' },
        { from: 6, to: 11, text: 'The <b>focusing cup</b> round the filament is negative too: it squeezes the stream to a narrow line on the target.' },
      ],
    },
    {
      title: 'The focal spot', dur: 11, scale: '1 cm',
      enter() { show('tube'); setOpacity(T.housing, 0); T.filMat.emissiveIntensity = 1.6; T.filMat.emissive.setRGB(1, 0.65, 0.15); },
      cam: [[0, [1.5, 0.6, 9], [0.2, -0.2, 0], 30], [11, [0.9, -0.2, 7], [0.1, -0.6, 0], 30]],
      frame(t) {
        T.spin.rotation.x = spinAt(t + 30, 0, 0.01);
        sfx.hold('rotor', 880, 0.04, 'square');
        drawStream(t, 0.6);
        T.spotMat.opacity = 0.8 + 0.2 * Math.sin(t * 30);
        // the actual spot: a line along the bevel; the effective spot: what the detector sees,
        // the same line foreshortened by the 12 degree angle
        const k = span(t, 1, 3);
        if (k > 0) {
          const L = 0.35, a = (90 - ANODE_ANGLE) * Math.PI / 180;      // the bevel's tilt from the beam axis
          const top = [Math.cos(a) * -L * 0 + Math.sin(ANODE_ANGLE * Math.PI / 180) * L, L, 0];
          const bot = [-Math.sin(ANODE_ANGLE * Math.PI / 180) * L, -L, 0];
          const [x0, y0] = api.toPx(top), [x1, y1] = api.toPx(bot);
          px.line(x0, y0, x1, y1, 'orange', k);
          px.line(x0 + 1, y0, x1 + 1, y1, 'orange', k);
          // drop lines to a plane below: the projected (effective) spot
          const k2 = span(t, 4, 6.5);
          if (k2 > 0) {
            const dy = -2.2;
            const [a0x, a0y] = api.toPx([top[0], dy, 0]), [a1x, a1y] = api.toPx([bot[0], dy, 0]);
            px.line(x0, y0, a0x, a0y, 'yellow', k2 * 0.7, 2);
            px.line(x1, y1, a1x, a1y, 'yellow', k2 * 0.7, 2);
            px.rect(Math.min(a0x, a1x), a0y - 1, Math.abs(a1x - a0x) + 1, 3, 'yellow', k2);
          }
        }
      },
      caption: [
        { from: 1, to: 4.2, text: 'The electrons strike a line on the bevelled track: the <b>actual focal spot</b>. A long line spreads the heat.' },
        { from: 4.2, to: 11, text: 'Seen from the patient it is foreshortened by the 12° angle to a small square, the <b>effective focal spot</b> (the line-focus principle): a sharp image from a big heated area.' },
      ],
    },
    {
      title: 'Heat', dur: 10, scale: '10 cm',
      enter() { show('tube'); setOpacity(T.housing, 0.25); T.filMat.emissiveIntensity = 1.6; T.filMat.emissive.setRGB(1, 0.65, 0.15); },
      cam: [[0, [2, 6, 22], [-1, 3, 0], 36], [10, [-4, 10, 24], [-2, 3, 0], 36]],
      frame(t) {
        T.spin.rotation.x = spinAt(t + 30, 0, 0.01);
        sfx.hold('rotor', 880, 0.04, 'square');
        drawStream(t, 0.5);
        T.spotMat.opacity = 0.85;
        const h = span(t, 0, 5);
        T.heatMat.emissiveIntensity = h * 1.6;
        T.heatMat.opacity = 0.25 + h * 0.6;
        // heat leaving the anode: shimmering rings radiating out through the glass to the oil
        const [cx, cy] = api.toPx([0, ANODE_Y, 0]);
        for (let k = 0; k < 4; k++) {
          const ph = ((t * 0.6 + k / 4) % 1);
          px.circle(cx, cy, 10 + ph * 40, 'orange', h * (1 - ph) * 0.45);
        }
        if (t > 4) api.mark(T.disc, 'orange', t);
      },
      caption: [
        { from: 0.8, to: 5, text: 'About <b>99%</b> of the electrons’ energy becomes heat, under 1% x-rays.' },
        { from: 5, to: 10, text: 'The spin carries each hot spot round the whole track before it is hit again; the disc glows and radiates the heat through the vacuum into the oil.' },
      ],
    },
    {
      title: 'Into the target', dur: 4.5, scale: (t) => (t < 1.5 ? '1 cm' : t < 2.8 ? '10 µm' : '100 pm'),
      enter() { show('tube'); setOpacity(T.housing, 0); T.spotMat.opacity = 0.9; },
      cam: [[0, [0.9, -0.2, 7], [0.1, -0.2, 0], 30], [4.5, [0.08, 0.0, 0.3], [0.05, 0, 0], 30]],
      cues: [[0.3, () => sfx.whoosh()]],
      frame(t) {
        T.spin.rotation.x = spinAt(t + 30, 0, 0.01);
        drawStream(t, 0.5);
        api.mosaic(span(t, 1.8, 4.3));
        if (t > 3.6) { px.alpha = span(t, 3.6, 4.5); targetScene(t, { rate: 4 }); px.alpha = 1; }
      },
    },
    {
      title: 'Tungsten atoms: heat', dur: 10, view: 'pixel', scale: '100 pm',
      frame(t) {
        const r = targetScene(t + 4, { rate: 9 });
        if (t > 3) {
          // point at the warmest atom (held a while so the brackets do not jump about)
          const k = Math.floor(t / 2.5) !== hotHeldAt ? (hotHeldAt = Math.floor(t / 2.5), hotHeld = hottest) : hotHeld;
          const a = r.atoms[k];
          if (a) api.mark([a[0] - 13, a[1] - 13, 26, 26], 'orange', t);
        }
      },
      cues: [[0.5, () => sfx.tick()], [2, () => sfx.tick()], [3.5, () => sfx.tick()]],
      caption: [{ from: 1, to: 10, text: 'A field of tungsten atoms. Most electrons collide with the atoms’ outer electrons, giving their energy up a little at a time: the atoms shake harder. That is <b>heat</b>.' }],
    },
    {
      title: 'Bremsstrahlung', dur: 12, view: 'pixel', scale: '100 pm',
      cues: [[3.7, () => sfx.pew(1500)]],
      frame(t) {
        const panel = [4, 4, 100, 58];
        targetScene(t + 14, { rate: 4, hi: 'brems', hiAt: 15.2, slow: 3, showHeat: false, avoid: [panel] });
        if (t > 5) { spectrumPlot(px, ...panel, 80, brems80, { fill: span(t, 5, 11) }); api.keepOut(panel); }
      },
      caption: [
        { from: 1.2, to: 6, text: 'An electron passing close to a nucleus is pulled off course and braked. The energy it loses leaves as an x-ray photon: <b>bremsstrahlung</b>, braking radiation.' },
        { from: 6, to: 12, text: 'The closer it passes, the more it loses: photons of every energy from almost nothing up to the <b>kVp</b>. They build a continuous spectrum.' },
      ],
    },
    {
      title: 'Characteristic radiation', dur: 12, view: 'pixel', scale: '100 pm',
      cues: [[3.4, () => sfx.blip(660)], [6.4, () => sfx.ping(1568)]],
      frame(t) {
        const panel = [4, 4, 100, 58];
        targetScene(t + 30, { rate: 4, hi: 'char', hiAt: 31.2, slow: 3, showHeat: false, avoid: [panel] });
        spectrumPlot(px, ...panel, 80, tungstenSpectrum(80, 0), { fill: 1, lines: [59.3, 67.2] }); api.keepOut(panel);
      },
      caption: [
        { from: 1.2, to: 4.6, text: 'An electron with more than 69.5 keV can knock a tungsten <b>K-shell</b> electron clean out of its atom.' },
        { from: 4.6, to: 12, text: 'An outer electron drops into the hole and the difference in binding energy leaves as a photon of tungsten’s own energy, 59 keV: a <b>characteristic</b> spike on the spectrum.' },
      ],
    },
    {
      title: 'The spectrum and kVp', dur: 11, view: 'pixel', scale: '100 pm',
      frame(t) {
        const kVp = t < 3.5 ? 80 : t < 7.5 ? lerp(80, 120, span(t, 3.5, 5.5)) : lerp(120, 60, span(t, 7.5, 9.5));
        targetScene(t + 50, { rate: 5, kVp, showHeat: false });
        // the output grows about as kVp squared (shown against 120 kVp)
        const s0 = tungstenSpectrum(kVp, 0), g = (kVp / 120) ** 2, s = (E) => s0(E) * g;
        spectrumPlot(px, Math.round(px.W / 2 - 80), 16, 160, 92, kVp, s, { fill: 1, lines: kVp > 69.5 ? [59.3, 67.2] : [] });
        px.text(Math.round(kVp) + ' kVp', px.W / 2, 8, 'yellow', 1, 1, 'center');
      },
      caption: [
        { from: 0.5, to: 7.5, text: 'Raising the <b>kVp</b> stretches the spectrum to higher energies and makes more photons at every energy.' },
        { from: 7.5, to: 11, text: 'Below 69.5 kV the electrons cannot free a K electron: the characteristic spikes are gone.' },
      ],
    },
    {
      title: 'Out of the tube', dur: 10, scale: '10 cm',
      enter() { show('tube'); setOpacity(T.housing, 0.35); T.spotMat.opacity = 0.85; T.setField(4, 4); },
      cam: [[0, [0.2, -0.1, 1.2], [0.05, -0.1, 0], 30], [3.2, [4, 0, 40], [0, -3, 0], 36], [10, [9, -1, 50], [0, -5, 0], 34]],
      cues: [[0.1, () => sfx.whoosh()]],
      frame(t) {
        api.mosaic(1 - span(t, 0, 2.2));
        T.spin.rotation.x = spinAt(t + 30, 0, 0.01);
        sfx.hold('rotor', 880, 0.04, 'square');
        drawParticles(api, out, t * 1.0, (p, s) => ({ kind: 'photon', color: keVColor(p.E), flashColor: p.fate === 'lead' ? 'grey' : 'orange' }), { tail: 4, period: 12 });
        if (t > 6.5) {
          api.mark(T.anode, 'orange', t);
          // the beam's intensity across its width: lower on the anode side (the heel)
          const k = span(t, 6.5, 7.5), w = 90, x0 = Math.round(px.W / 2 - w / 2), y0 = px.H - 30;
          px.rect(x0 - 2, y0 - 2, w + 4, 14, 'ink', 0.9 * k);
          api.keepOut([x0 - 8, y0 - 2, w + 16, 14]);
          for (let i = 0; i < w; i++) {
            const f = i / (w - 1);                       // 0 anode side .. 1 cathode side
            const I = 0.55 + 0.45 * Math.min(1, f * 1.6) - 0.08 * Math.max(0, f - 0.8);
            const c = I > 0.9 ? 'white' : I > 0.78 ? 'grey' : I > 0.66 ? 'mid' : 'slate';
            px.rect(x0 + i, y0, 1, 10, c, k);
          }
          px.text('A', x0 - 6, y0 + 2, 'orange', k);
          px.text('C', x0 + w + 3, y0 + 2, 'cyan', k);
        }
      },
      caption: [
        { from: 2.5, to: 6.5, text: 'Photons leave the focal spot in every direction. The lead lining stops all but those headed for the <b>port</b>, the useful beam.' },
        { from: 6.5, to: 10, text: 'Those leaving close along the target’s face must cross more tungsten: the beam is weaker on the anode side, the <b>heel effect</b>.' },
      ],
    },
    {
      title: 'Filtration', dur: 11, scale: '1 cm',
      enter() { show('tube'); setOpacity(T.housing, 0.3); T.spotMat.opacity = 0.85; T.setField(4, 4); T.coll.visible = false; },
      cam: [[0, [3, -1, 26], [0, -3.5, 0], 34], [11, [6, -3, 20], [0, -4.8, 0], 34]],
      frame(t) {
        T.spin.rotation.x = spinAt(t + 30, 0, 0.01);
        sfx.hold('rotor', 880, 0.04, 'square');
        drawParticles(api, out.map((p) => photonFate(p, { filter: true })), t, (p) => (p.fate === 'lead' || p.fate === 'heel' ? null
          : { kind: 'photon', color: keVColor(p.E), flashColor: 'red' }), { tail: 4, period: 12 });
        if (t > 1) api.mark(T.filter, 'cyan', t);
        const k = span(t, 4, 7);
        const before = tungstenSpectrum(80, 0), after = tungstenSpectrum(80, 0.25 * k + 0.0001);
        spectrumPlot(px, px.W - 104, 26, 100, 58, 80, after, { hard: before, lines: [59.3, 67.2] });
        api.keepOut([px.W - 104, 26, 100, 58]);
      },
      caption: [
        { from: 1, to: 6, text: 'Under the port, an <b>aluminium filter</b> absorbs the low-energy photons: they could never reach the detector, only add skin dose.' },
        { from: 6, to: 11, text: 'What is left is fewer photons but a higher average energy: the beam is <b>hardened</b>.' },
      ],
    },
    {
      title: 'Collimation', dur: 11, fadeOut: 0.6, scale: '10 cm',
      enter() { show('tube'); setOpacity(T.housing, 0.3); T.spotMat.opacity = 0.85; T.coll.visible = true; },
      cam: [[0, [34, -6, 56], [0, -16, 0], 38], [11, [26, -14, 62], [0, -24, 0], 38]],
      cues: [[1.4, () => sfx.click()], [3.4, () => sfx.click()]],
      frame(t) {
        T.spin.rotation.x = spinAt(t + 30, 0, 0.01);
        sfx.hold('rotor', 880, 0.04, 'square');
        const k = span(t, 1.2, 4.2);
        const hx = lerp(4, 1.6, k), hz = lerp(4, 2.2, k);
        T.setField(hx, hz);
        const lamp = span(t, 6, 6.6);
        T.lampMat.emissiveIntensity = lamp * 3;
        xBeam.visible = true; xBeam.userData.set([0, 0, 0], fieldAt(hx, hz, 48));
        xLight.visible = lamp > 0; xLight.material.opacity = 0.14 * lamp; xLight.userData.set([0, 0, 0], fieldAt(hx, hz, 48));
        // the half-angles the blades now pass (tan, at the upper blades' height)
        const d = -bladeY[0];
        drawParticles(api, out.map((p) => photonFate(p, { filter: true, coll: [hx, hz] })), t, (p) => (p.fate === 'lead' || p.fate === 'heel' || p.fate === 'filter' ? null
          : { kind: 'photon', color: keVColor(p.E), flashColor: p.fate === 'blade' ? 'grey' : 'orange' }), { tail: 4, period: 12 });
        if (t > 1 && t < 6) api.mark(T.blades.xa, 'cyan', t);
        if (t > 6.5) api.mark(T.mirror, 'yellow', t);
        void d;
      },
      caption: [
        { from: 1, to: 6, text: 'Lead <b>collimator blades</b> close to the area of interest. Every photon outside it is stopped before it can reach the patient.' },
        { from: 6.5, to: 11, text: 'A lamp and a mirror at the focal spot’s distance shine a <b>light field</b> exactly where the x-ray field will fall.' },
      ],
    },
  ];
  return { title: 'X-ray generation', steps };
}
