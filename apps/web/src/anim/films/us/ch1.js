/* ULTRASOUND FILM, chapter 1: the transducer. The scan in the room (the probe on the right upper
   quadrant, its plane in the patient, the image on the scanner); the probe and, cut open, its
   layers; down into one element, a crystal of PZT, where a voltage becomes a vibration and an
   echo's pressure becomes a voltage; and why the backing block is there (a short pulse). */
import { setOpacity } from '../../kit/stage.js';
import { makeField, drawField, panel, poly, ringShape, pulseP } from './wave.js';
import { R0 } from './probe.js';

export function transducer(api, S) {
  const { px, sfx, span, lerp, clamp01 } = api;
  const R = S.room, B = S.big, W = S.W;

  // ---- pulses down the fan in the room: arcs at radius r from the apex (rock frame), and their
  // echoes coming back up, drawn on the 8-bit layer where the plane is on screen
  const arcPx = (r, c, a, th0 = -0.5, th1 = 0.5) => {
    let last = null;
    for (let i = 0; i <= 24; i++) {
      const th = (th0 + (th1 - th0) * i / 24) * 1.05;
      const v = R.rock.localToWorld(new api.THREE.Vector3(Math.sin(th) * r, -Math.cos(th) * r, 0));
      const [x, y, f] = api.toPx(v);
      if (f && last) px.line(last[0], last[1], x, y, c, a);
      last = f ? [x, y] : null;
    }
  };
  const roomPulses = (t, k = 1) => {
    const per = 1.6;                                        // shown slowed: a real pulse takes 0.2 ms
    for (let j = 0; j < 2; j++) {
      const ph = ((t + j * per / 2) % per) / per;
      const r = R0 + ph * S.seat.o.depth;
      arcPx(r, 'cyan', k * (1 - ph) * 0.9);
      // its echoes on the way back, weaker
      if (ph > 0.15) arcPx(R0 + (1 - ph) * S.seat.o.depth * 0.6, 'yellow', k * 0.35 * (1 - ph));
    }
  };

  // ---- the crystal in section (8-bit): PZT cells between two electrodes, the backing above,
  // the matching layer and lens below it, then tissue. strain s (-1..1) thickens or thins it.
  const XT = () => ({ cx: Math.round(px.W * 0.4), half: 72, top: 32 });
  function crystal(t, s, { charge = 0, backing = true, glowE = 0 } = {}) {
    const { cx, half, top } = XT();
    const h = Math.round(54 * (1 + 0.16 * s)), bot = top + h;
    if (backing) { px.rect(cx - half - 6, 6, 2 * half + 12, top - 8, 'dkgrey'); for (let i = 0; i < 40; i++) px.px(cx - half - 4 + ((i * 37) % (2 * half + 8)), 8 + ((i * 13) % (top - 12)), 'slate'); }
    px.rect(cx - half, top - 2, 2 * half, 2, 'grey');                       // top electrode
    px.rect(cx - half, top, 2 * half, h, 'brown', 0.35);
    // unit cells: lead at the corners, oxygen on the faces, a titanium/zirconium ion in the
    // middle, off centre (the poled dipole), pushed further or back by the field
    const nc = 7, nr = 3, cw = (2 * half) / nc, ch = h / nr;
    for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
      const x = cx - half + c * cw, y = top + r * ch;
      px.rect(x + 1, y + 1, 2, 2, 'grey'); px.px(x + cw / 2, y + 1, 'red'); px.px(x + 1, y + ch / 2, 'red');
      const off = 1.2 + 1.6 * s;
      px.rect(x + cw / 2 - 1, y + ch / 2 - 1 + off, 3, 3, glowE > 0.1 ? 'yellow' : 'cyan');
    }
    px.rect(cx - half, bot, 2 * half, 2, 'grey');                            // bottom electrode
    px.rect(cx - half - 4, bot + 2, 2 * half + 8, 3, 'orange', 0.85);        // matching layer
    px.rect(cx - half - 4, bot + 5, 2 * half + 8, 3, 'lav', 0.9);            // lens
    // the charges the strain leaves on the faces
    if (Math.abs(charge) > 0.08) {
      const n = Math.round(Math.abs(charge) * 9), up = charge > 0 ? '+' : '-', dn = charge > 0 ? '-' : '+';
      for (let i = 0; i < n; i++) {
        const x = cx - half + 8 + i * (2 * half - 16) / Math.max(1, n - 1);
        px.text(up, x, top - 9, up === '+' ? 'red' : 'blue', 0.9);
        px.text(dn, x, bot + 9, dn === '+' ? 'red' : 'blue', 0.9);
      }
    }
    return { cx, half, top, bot, face: bot + 8 };
  }
  // the wire from the electrodes to the scanner, out to the left
  const wires = (g, c = 'grey') => {
    px.line(g.cx - g.half, g.top - 1, g.cx - g.half - 24, g.top - 1, c); px.line(g.cx - g.half - 24, g.top - 1, g.cx - g.half - 24, 18, c);
    px.line(g.cx - g.half, g.bot + 1, g.cx - g.half - 30, g.bot + 1, c); px.line(g.cx - g.half - 30, g.bot + 1, g.cx - g.half - 30, 18, c);
  };
  // a trace panel of a signal over the last `span` seconds
  const scope = (x, y, w, h, f, t, { span: sp = 3, c = 'yellow', label = null, scale = 1 } = {}) => {
    panel(api, x, y, w, h);
    const mid = y + h / 2;
    px.rect(x + 2, mid, w - 4, 1, 'dkgrey');
    poly(px, w - 4, (i) => { const tt = t - sp + (i / (w - 5)) * sp; return [x + 2 + i, mid - Math.max(-1, Math.min(1, f(tt) * scale)) * (h / 2 - 3)]; }, c);
    if (label) px.text(label, x + w - 3, y + 3, 'mid', 1, 1, 'right');
  };

  // the tissue below the face, and the pulse the face sends into it
  const tissueField = makeField(0, 0, 440, 220, 3, 21);
  const LAM = 16, CPX = 44;                                   // px, px per second (slowed)
  const PER = 4;                                              // a burst every 4 s (a held step repeats it)
  // the voltage burst: the same 2.6 cycles the face then sends out (pressure follows the strain)
  const drive = (tt) => { const u = ((tt % PER) + PER) % PER; return pulseP(u * CPX, LAM, 2.6); };
  // the plane pulse the face emits each period: what the face did when it left (s / c ago)
  const emitted = (g, t) => {
    const k = Math.floor(t / PER), out = [];
    for (const j of [k - 1, k]) {
      if (j < 0) continue;
      out.push({ kind: 'plane', o: [0, g.face], d: [0, 1], t0: j * PER, c: CPX, a: 1, len: LAM * 2.6, keep: (x, y) => y > g.face && Math.abs(x - g.cx) < g.half + 30,
        shape: (s) => [pulseP(s, LAM, 2.6), 0.6 * pulseP(s + LAM / 4, LAM, 2.6) * LAM / 6] });
    }
    return out;
  };
  // an echo arriving from below each period (in the receive scene)
  const ECHO_T = 1.0;
  const arriving = (g, t) => {
    const k = Math.floor(t / PER), out = [];
    for (const j of [k - 1, k]) {
      if (j < 0) continue;
      out.push({ kind: 'plane', o: [0, px.H + 2], d: [0, -1], t0: j * PER + ECHO_T, c: CPX, a: 0.9, len: LAM * 2.6, keep: (x, y) => y > g.face && Math.abs(x - g.cx) < g.half + 30,
        shape: (s) => [pulseP(s, LAM, 2.6), -0.6 * pulseP(s + LAM / 4, LAM, 2.6) * LAM / 6] });
    }
    return out;
  };
  // the echo's pressure at the face at time t (what squeezes the crystal)
  const echoAtFace = (g, t) => {
    const dist = px.H + 2 - g.face, tt = ((t % PER) + PER) % PER - ECHO_T, s = tt * CPX - dist;
    return pulseP(s, LAM, 2.6);
  };

  const probeCam = { pos: [15, -4.5, 25], look: [0, 3.6, 0] };
  const steps = [
    {
      title: 'The scan', dur: 14, fadeIn: 0.8, scale: '1 m',
      enter() { S.roomReset(); R.sheet.visible = true; R.fan.visible = true; R.setFan(S.seat.fr, S.seat.g); },
      cam: [[0, [-150, 160, -240], [25, 10, 10], 40], [5.5, [W.face[0] - 50, W.face[1] + 55, W.face[2] - 55], [W.face[0], W.face[1] - 6, W.face[2]], 34],
        [8.5, [W.face[0] - 48, W.face[1] + 52, W.face[2] - 50], [W.face[0], W.face[1] - 6, W.face[2]], 34],
        [12, [W.screenFront[0], W.screenFront[1] + 6, W.screenFront[2]], [W.screen[0], W.screen[1] - 2, W.screen[2]], 38]],
      frame(t) {
        R.sheet.material.opacity = 0.16;
        R.fan.material.opacity = 0.35 + 0.6 * span(t, 3, 6);
        roomPulses(t, span(t, 2, 4));
        if (t > 4 && t < 8.5) api.mark(R.probe.shell, 'yellow', t);
        if (t > 9.5) api.mark(R.screen, 'cyan', t);
      },
      cues: [[2.5, () => sfx.blip(1320)]],
      caption: [
        { from: 4, to: 8.5, text: 'A <b>probe</b> on the skin sends short pulses of sound into the body and listens for their echoes. No ionising radiation.' },
        { from: 9.5, to: 14, text: 'The <b>scanner</b> times each echo and draws it where it came from: the picture of the plane under the probe, many times a second.' },
      ],
    },
    {
      title: 'The probe', dur: 10, scale: '1 cm',
      enter() { S.only('probe'); setOpacity(B.housing, 1); B.explode(0); B.fire(() => 0); B.g.rotation.set(0, 0, 0); },
      cam: [[0, [18, 12, 30], [0, 5, 0], 36], [10, probeCam.pos, probeCam.look, 34]],
      frame(t) {
        B.g.rotation.y = 0.6 * Math.sin(t * 0.35);
        if (t > 1.5 && t < 5.5) api.mark(B.shell, 'yellow', t);
        if (t > 5.5) api.mark(B.lens, 'cyan', t);
      },
      caption: [
        { from: 1.5, to: 5.5, text: 'A <b>curvilinear</b> probe, the abdominal one: 2 to 5 MHz, its curved face fanning the image lines out over 60°.' },
        { from: 5.5, to: 10, text: 'Behind the <b>face</b> lies a row of 128 to 192 tiny elements along the curve.' },
      ],
    },
    {
      title: 'Inside the probe', dur: 17, scale: '1 cm',
      enter() { S.only('probe'); B.g.rotation.set(0, 0, 0); B.fire(() => 0); },
      cam: [[0, probeCam.pos, probeCam.look, 34], [4, [5, 4, 27], [0, 2.4, 0], 32], [17, [8, 1, 25], [0, 2.0, 0], 32]],
      frame(t) {
        setOpacity(B.housing, 1 - span(t, 0.5, 3) * 0.94);
        B.explode(span(t, 2.5, 5));
        const parts = [B.elements, B.backing, B.match, B.lens], cols = ['yellow', 'grey', 'orange', 'lav'];
        const i = t < 4.5 ? -1 : Math.min(3, Math.floor((t - 4.5) / 3.1));
        if (i >= 0) api.mark(parts[i], cols[i] === 'grey' ? 'white' : 'yellow', t);
        // the elements light along the array as they are named
        B.fire((k) => (i === 0 ? 0.25 + 0.25 * Math.sin(t * 6 - k * 0.3) : 0));
      },
      caption: [
        { from: 4.5, to: 7.6, text: 'The <b>elements</b>: thin bars of a piezoelectric ceramic, lead zirconate titanate (<b>PZT</b>), each with its own wire.' },
        { from: 7.6, to: 10.7, text: 'Behind them the <b>backing block</b>, a heavy absorbing epoxy that stops their ringing.' },
        { from: 10.7, to: 13.8, text: 'In front, the <b>matching layers</b>, which help the sound out of the crystal into the body.' },
        { from: 13.8, to: 17, text: 'Outermost, the <b>lens</b>: it focuses the beam across the array, into a thin slice.' },
      ],
    },
    {
      title: 'Into an element', dur: 4.5, scale: (t) => (t < 2 ? '1 cm' : '1 mm'),
      enter() { S.only('probe'); setOpacity(B.housing, 0.1); B.explode(1); B.fire(() => 0); },
      cam: [[0, [8, 1, 25], [0, 2.0, 0], 32], [4.5, [0, 0.42, 0.9], [0, 0.40, 0], 32]],
      cues: [[0.3, () => sfx.whoosh()]],
      frame(t) {
        B.fire((k) => (k === 31 || k === 32 ? span(t, 1, 3) * 0.5 : 0));
        api.mosaic(span(t, 1.8, 4.3));
        if (t > 3.6) { px.alpha = span(t, 3.6, 4.5); px.fillAll('ink'); crystal(t, 0); px.alpha = 1; }
      },
    },
    {
      title: 'The piezoelectric effect', dur: 14, view: 'pixel', scale: '0.1 mm',
      cues: [[0.2, () => sfx.tone(880, 880, 0.3, 'square', 0.2)], [4.2, () => sfx.tone(880, 880, 0.3, 'square', 0.2)], [8.2, () => sfx.tone(880, 880, 0.3, 'square', 0.2)], [12.2, () => sfx.tone(880, 880, 0.3, 'square', 0.2)]],
      frame(t) {
        px.fillAll('ink');
        const v = drive(t);
        // the tissue under the face, with the pulse the face has sent
        const g0 = XT(), face = g0.top + 54 + 8 + 3;
        const g = { cx: g0.cx, half: g0.half, face };
        drawField(px, tissueField.filter((q) => q.y > face + 1), emitted(g, t), t, { gain: 0.45 });
        const c = crystal(t, v, { charge: 0, glowE: Math.abs(v) });
        wires(c, Math.abs(v) > 0.1 ? 'yellow' : 'grey');
        scope(px.W - 92, 8, 86, 40, drive, t, { c: 'yellow', span: 4 });
        api.keepOut([c.cx - c.half - 30, c.top - 10, 2 * c.half + 60, px.H - c.top + 10]);   // the crystal, and the pulse's way down
        if (t < 7) api.mark([c.cx - c.half - 2, c.top - 3, 2 * c.half + 4, c.bot - c.top + 6], 'yellow', t);
        else api.mark([c.cx - c.half, c.face + 2, 2 * c.half, 40], 'cyan', t);
      },
      caption: [
        { from: 0.6, to: 7, text: 'The <b>piezoelectric effect</b>: a voltage across the crystal shifts the charged ions in its cells, and the whole crystal grows or shrinks in thickness.' },
        { from: 7, to: 14, text: 'An alternating voltage makes it vibrate; its face pushes and pulls on the tissue: a pulse of <b>sound</b> at the crystal’s own resonant frequency, set by its thickness (half a wavelength).' },
      ],
    },
    {
      title: 'An echo becomes a voltage', dur: 13, view: 'pixel', scale: '0.1 mm',
      cues: [1, 5, 9, 13].map((c) => [c + 1.6, () => sfx.blip(1600)]),
      frame(t) {
        px.fillAll('ink');
        const g0 = XT(), face = g0.top + 54 + 8 + 3;
        const g = { cx: g0.cx, half: g0.half, face };
        const pe = echoAtFace(g, t);
        drawField(px, tissueField.filter((q) => q.y > face + 1), arriving(g, t), t, { gain: 0.45 });
        const c = crystal(t, -pe * 0.7, { charge: pe * 0.9, glowE: Math.abs(pe) });
        wires(c, Math.abs(pe) > 0.1 ? 'lime' : 'grey');
        scope(px.W - 92, 8, 86, 40, (tt) => echoAtFace(g, tt) * 0.35, t, { c: 'lime', span: 4 });
        api.keepOut([c.cx - c.half - 30, c.top - 12, 2 * c.half + 60, px.H - c.top + 12]);   // the crystal, and the echo's way up
        // the arriving echo, then the charge on the faces
        const tt = ((t % PER) + PER) % PER;
        if (tt < 1.9) api.mark([c.cx - c.half, c.face + 4, 2 * c.half, px.H - c.face - 8], 'cyan', t);
        else api.mark([px.W - 92, 8, 86, 40], 'lime', t);
      },
      caption: [
        { from: 0.6, to: 6, text: 'It works backwards too. An <b>echo</b> returning from the body squeezes and stretches the crystal...' },
        { from: 6, to: 13, text: '...and the strain leaves charges on its faces: a tiny <b>voltage</b>, microvolts to millivolts, that the scanner amplifies. The same element is speaker and microphone.' },
      ],
    },
    {
      title: 'Damping: a short pulse', dur: 13, view: 'pixel', scale: '1 mm',
      cues: [[0.3, () => sfx.ping(990)], [4.3, () => sfx.blip(990)]],
      frame(t) {
        px.fillAll('ink');
        // two elements struck the same way: one alone, one on its backing; below each, the sound
        // it sends into the tissue
        const W2 = px.W / 2;
        const left = { cx: W2 / 2 + 6, half: 40, face: 50 }, right = { cx: W2 + W2 / 2 - 6, half: 40, face: 50 };
        const per = 8, k = Math.floor(t / per);
        for (const [g, backed] of [[left, false], [right, true]]) {
          const comps = [];
          for (const j of [k - 1, k]) {
            if (j < 0) continue;
            comps.push({ kind: 'plane', o: [0, g.face], d: [0, 1], t0: j * per + 0.3, c: 26, a: 1, len: backed ? 14 * 2.5 : 14 * 14,
              keep: (x, y) => y > g.face && Math.abs(x - g.cx) < g.half,
              shape: backed ? (s) => [pulseP(s, 14, 2.5), 0] : ringShape(14, 3.2) });
          }
          drawField(px, tissueField.filter((q) => q.y > g.face + 1 && Math.abs(q.x - g.cx) < g.half), comps, t, { gain: 0.4 });
          api.keepOut([g.cx - g.half - 8, 12, 2 * g.half + 16, px.H - 12]);
          // the element (its own small block) and, on the right, its backing
          const ring = backed ? 0 : 1;
          const age = ((t - 0.3) % per + per) % per;
          const vib = backed ? pulseP(age * 26, 14, 2.5) : ringShape(14, 3.2)(age * 26)[0] * ring;
          if (backed) px.rect(g.cx - g.half, 16, 2 * g.half, 18, 'dkgrey');
          px.rect(g.cx - g.half, 36 - vib * 2, 2 * g.half, 12 + vib * 2, 'gold', 0.9);
          px.rect(g.cx - g.half, 48, 2 * g.half, 2, 'grey');
          // the pulse's length, bracketed once it is all out
          const len = backed ? 14 * 2.5 : 14 * 14 * 0.75, front = Math.min(px.H - 4, g.face + Math.max(0, age * 26));
          if (age > 2.5) {
            const y0 = front - len, y1 = front;
            if (y0 > g.face) { px.line(g.cx + g.half + 4, y0, g.cx + g.half + 4, y1, 'yellow'); px.line(g.cx + g.half + 2, y0, g.cx + g.half + 6, y0, 'yellow'); px.line(g.cx + g.half + 2, y1, g.cx + g.half + 6, y1, 'yellow'); }
          }
        }
        if (t < 6.5) api.mark([left.cx - left.half - 2, 34, 2 * left.half + 4, 18], 'orange', t);
        else api.mark([right.cx - right.half - 2, 14, 2 * right.half + 4, 38], 'yellow', t);
      },
      caption: [
        { from: 0.6, to: 6.5, text: 'Struck by a voltage spike, a crystal on its own <b>rings</b> like a bell: a long train of waves.' },
        { from: 6.5, to: 13, text: 'Bonded to the <b>backing block</b>, it is damped to two or three cycles: a <b>short pulse</b>, which keeps echoes from close-together surfaces apart (and spreads its frequencies wide: a broad bandwidth).' },
      ],
    },
  ];
  void lerp; void clamp01;
  return { title: 'The transducer', steps };
}
