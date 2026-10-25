/* ULTRASOUND FILM, chapter 2: sound in tissue. Down from the probe's face into a field of tissue
   particles: the pulse as compressions and rarefactions passing through particles that only
   oscillate in place; frequency, wavelength and speed; pulses and the long listening between
   them; acoustic impedance and what an interface reflects (the app's own Z table), gel and the
   matching layers; specular reflection against scatter and the speckle it makes; refraction;
   attenuation, with frequency. The probe is always at the top, the sound always going down. */
import { ACOUSTIC } from '../../../core/acoustics.js';
import { makeField, drawField, panel, poly, span2, arrow, faceStrip, pulseP, fieldAt, scatterers } from './wave.js';

const Zof = (id) => ACOUSTIC[id].z;
const Rpct = (z1, z2) => ((z2 - z1) / (z2 + z1)) ** 2;

export function tissue(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const R = S.room, W = S.W;
  const FACE = 16;                                           // the face's line in the 8-bit scenes
  const field3 = makeField(-10, FACE + 1, 520, 200, 3, 31);
  const field4 = makeField(-10, FACE + 1, 520, 200, 4, 32);
  // repeated emissions: a burst every per seconds, only the last few in flight (a held step
  // keeps sending)
  const every = (t, per, n, make) => { const k = Math.floor(t / per), out = []; for (let j = k - n + 1; j <= k; j++) if (j >= 0) out.push(...[].concat(make(j * per, j))); return out; };
  const MEMO = new Map();
  const memo = (key, f) => { let v = MEMO.get(key); if (!v) { v = f(); MEMO.set(key, v); } return v; };
  const face = (glow = 0) => faceStrip(px, -4, px.W + 4, FACE, { n: Math.ceil(px.W / 14), glow: () => glow });
  // the face lights while it sends
  const sending = (t, per, dur) => (((t % per) + per) % per < dur ? 1 : 0);

  // ---------------------------------------------------------------- step scenes
  // the field under a train of pulses; one particle picked out; a pressure trace beside, depth down
  const LAM = 18, C = 34, NCYC = 3;
  const pulses = (t) => every(t, 4.5, 2, (t0) => ({ kind: 'plane', o: [0, FACE], d: [0, 1], t0, c: C, a: 1, lam: LAM, n: NCYC }));
  const watch = field3.reduce((b, q) => (Math.abs(q.x - 120) + Math.abs(q.y - 96) < Math.abs(b.x - 120) + Math.abs(b.y - 96) ? q : b), field3[0]);

  // impedance columns: tissues side by side, the same pulse into each at its own speed
  const COLS = [['fat', 2], ['liver', 11], ['bone', 18], ['air', 0]];
  const colMat = { fat: 'fat', liver: 'liver', bone: 'bone', air: 'air' };

  // one interface: medium 1 above y = yi, medium 2 below; incident, reflected, transmitted
  function interfaceComps(t, yi, z1, z2, c1, c2, per = 6, x0 = -20, x1 = 600, att2 = 0) {
    const r = (z2 - z1) / (z2 + z1), Tt = Math.sqrt(Math.max(0, 1 - r * r));
    return every(t, per, 2, (t0) => {
      const tHit = t0 + (yi - FACE) / c1;
      const inX = (x) => x > x0 && x < x1;
      return [
        { kind: 'plane', o: [0, FACE], d: [0, 1], t0, c: c1, a: 1, lam: LAM, n: NCYC, keep: (x, y) => y < yi && inX(x) },
        { kind: 'plane', o: [0, yi], d: [0, -1], t0: tHit, c: c1, a: r, lam: LAM, n: NCYC, keep: (x, y) => y < yi && inX(x) },
        { kind: 'plane', o: [0, yi], d: [0, 1], t0: tHit, c: c2, a: Tt, lam: LAM * c2 / c1, n: NCYC, keep: (x, y) => y >= yi && inX(x),
          fade: att2 ? (x, y, dist) => Math.exp(-dist * att2) : null },
      ];
    });
  }

  // specular: an oblique smooth boundary; the reflection leaves at the mirror angle
  const SPEC_ANG = 0.32;                                    // the boundary's tilt (rad)
  // scatterers smaller than a wavelength, each re-radiating weakly as the pulse passes
  const cells = scatterers(46, 20, 70, 440, 110, 77);

  const steps = [
    {
      title: 'Into the tissue', dur: 5, scale: (t) => (t < 2 ? '10 cm' : '1 mm'),
      enter() { S.roomReset(); R.fan.visible = true; R.setFan(S.seat.fr, S.seat.g); R.fan.material.opacity = 0.6; },
      cam: [[0, [W.face[0] - 40, W.face[1] + 40, W.face[2] - 40], [W.face[0], W.face[1] - 4, W.face[2]], 34],
        [4.5, [W.face[0] - 2.2, W.face[1] + 1.2, W.face[2] - 2.2], [W.face[0], W.face[1] - 1.5, W.face[2]], 34]],
      cues: [[0.3, () => sfx.whoosh()]],
      frame(t) {
        api.mosaic(span(t, 1.8, 4.3));
        if (t > 3.6) { px.alpha = span(t, 3.6, 4.5); px.fillAll('ink'); drawField(px, field3, pulses(t), t); face(); px.alpha = 1; }
      },
    },
    {
      title: 'Compression and rarefaction', dur: 14, view: 'pixel', scale: '0.3 mm',
      cues: [[0.1, () => sfx.tone(440, 440, 0.25, 'triangle', 0.3)], [4.6, () => sfx.tone(440, 440, 0.25, 'triangle', 0.3)], [9.1, () => sfx.tone(440, 440, 0.25, 'triangle', 0.3)], [13.6, () => sfx.tone(440, 440, 0.25, 'triangle', 0.3)]],
      frame(t) {
        px.fillAll('ink');
        const comps = pulses(t);
        drawField(px, field3, comps, t, { gain: 0.5 });
        face(sending(t, 4.5, NCYC * LAM / C));
        // the watched particle: its rest place (a tick) and where it is now
        const f = fieldAt(comps, watch.x, watch.y, t);
        const y = watch.y + f[2] * 0.5;
        px.rect(watch.x - 4, watch.y, 2, 1, 'grey'); px.rect(watch.x + 3, watch.y, 2, 1, 'grey');
        px.rect(watch.x - 1, y - 1, 3, 3, 'yellow');
        // the pressure down the field, beside it: right is compression
        const pw = 54, x0 = px.W - pw - 6;
        panel(api, x0, FACE + 4, pw, px.H - FACE - 10);
        const mid = x0 + pw / 2;
        px.rect(mid, FACE + 6, 1, px.H - FACE - 14, 'dkgrey');
        poly(px, px.H - FACE - 14, (i) => { const yy = FACE + 6 + i; return [mid + fieldAt(comps, 200, yy, t)[0] * (pw / 2 - 4), yy]; }, 'cyan');
        px.text('+', x0 + pw - 6, FACE + 8, 'white'); px.text('-', x0 + 3, FACE + 8, 'mid');
        if (t < 7) {
          // the band of the pulse now in the field
          const age = ((t % 4.5) + 4.5) % 4.5, yb = FACE + age * C;
          if (yb < px.H) api.mark([90, Math.max(FACE + 2, yb - NCYC * LAM), 80, Math.min(NCYC * LAM, yb - FACE)], 'white', t);
          api.keepOut([0, Math.max(FACE, yb - NCYC * LAM - 1), x0, NCYC * LAM + 2]);       // (inside the caption's 12 px margin)
        } else api.mark([watch.x - 6, watch.y - 7, 13, 14], 'yellow', t);
      },
      caption: [
        { from: 0.6, to: 7, text: 'Sound is a <b>pressure wave</b>. The face pushes on the tissue, squeezing its particles together (<b>compression</b>), then pulls back and spreads them (<b>rarefaction</b>).' },
        { from: 7, to: 14, text: 'Each particle only shuffles back and forth about its own place, along the direction of travel: a <b>longitudinal</b> wave. The energy moves on, the tissue stays.' },
      ],
    },
    {
      title: 'Frequency and wavelength', dur: 14, view: 'pixel', scale: '0.3 mm',
      frame(t) {
        px.fillAll('ink');
        const half = px.W / 2, c = 30;
        // left: 3.5 MHz; right: 7.5 MHz; the same speed, so the wavelength scales as 1/f
        const lamA = 26, lamB = lamA * 3.5 / 7.5;
        const per = 9;
        const A = every(t, per, 2, (t0) => ({ kind: 'plane', o: [0, FACE], d: [0, 1], t0, c, a: 1, lam: lamA, len: per * c * 0.9, shape: (s) => [Math.sin(2 * Math.PI * s / lamA) * Math.min(1, s / lamA), -Math.cos(2 * Math.PI * s / lamA) * lamA / 6.28], keep: (x) => x < half - 3 }));
        const B = every(t, per, 2, (t0) => ({ kind: 'plane', o: [0, FACE], d: [0, 1], t0, c, a: 1, lam: lamB, len: per * c * 0.9, shape: (s) => [Math.sin(2 * Math.PI * s / lamB) * Math.min(1, s / lamB), -Math.cos(2 * Math.PI * s / lamB) * lamB / 6.28], keep: (x) => x > half + 3 }));
        drawField(px, field3, [...A, ...B], t, { gain: 0.5 });
        faceStrip(px, -4, half - 4, FACE, { n: 12, glow: () => 1 });
        faceStrip(px, half + 4, px.W + 4, FACE, { n: 12, glow: () => 1 });
        px.rect(half - 1, FACE - 16, 2, px.H, 'ink');
        // a wavelength bracketed on each, between two compressions
        const age = (((t % per) + per) % per) * c;
        const comp = (lam, k) => FACE + age - lam * (k + 0.25);          // where the k-th crest is
        const ya = comp(lamA, 2), yb = comp(lamB, 4);
        if (ya - lamA > FACE + 4 && ya < px.H - 4) { span2(px, half - 22, ya - lamA, half - 22, ya, 'yellow'); px.text('0.44 mm', half - 26, ya - lamA / 2 - 2, 'yellow', 1, 1, 'right'); }
        if (yb - lamB > FACE + 4 && yb < px.H - 4) { span2(px, px.W - 22, yb - lamB, px.W - 22, yb, 'yellow'); px.text('0.21 mm', px.W - 26, yb - lamB / 2 - 2, 'yellow', 1, 1, 'right'); }
        px.text('3.5 MHz', half / 2, 2, 'white', 1, 1, 'center'); px.text('7.5 MHz', half * 1.5, 2, 'white', 1, 1, 'center');
        px.text('1540 m/s', half, px.H - 8, 'cyan', 1, 1, 'center');
        if (t < 7) api.mark([8, FACE + 4, half - 40, Math.min(px.H - FACE - 10, 130)], 'yellow', t);
        else api.mark([half + 8, FACE + 4, half - 40, Math.min(px.H - FACE - 10, 130)], 'yellow', t);
      },
      caption: [
        { from: 0.6, to: 7, text: 'The <b>frequency</b> is how many cycles the face makes each second: 3.5 million here (3.5 MHz). Sound crosses soft tissue at about 1540 m/s, so each <b>wavelength</b> λ = c ÷ f = 0.44 mm.', place: 'right' },
        { from: 7, to: 14, text: 'At 7.5 MHz the speed is the same and the waves are packed tighter: λ = 0.21 mm. Shorter waves resolve finer detail, as we will see.', place: 'left' },
      ],
    },
    {
      title: 'Pulses, and listening', dur: 13, view: 'pixel', scale: '0.3 mm',
      cues: [[0.1, () => sfx.blip(1200)], [6.6, () => sfx.blip(1200)]],
      frame(t) {
        px.fillAll('ink');
        const per = 6.5;
        const comps = every(t, per, 2, (t0) => ({ kind: 'plane', o: [0, FACE], d: [0, 1], t0, c: C, a: 1, lam: LAM, n: NCYC }));
        drawField(px, field3, comps, t, { gain: 0.5 });
        face(sending(t, per, NCYC * LAM / C));
        // the pulse's length, bracketed: n cycles x wavelength
        const age = ((t % per) + per) % per, yb = FACE + age * C, y0 = yb - NCYC * LAM;
        if (y0 > FACE + 2 && yb < px.H - 2) { span2(px, 42, y0, 42, yb, 'yellow'); px.text('1.3 mm', 36, (y0 + yb) / 2 - 2, 'yellow', 1, 1, 'right'); }
        // the time line: a short burst, then a long silence spent listening (not to scale: the
        // listening is 300 times longer)
        const tx = px.W - 120, ty = px.H - 46, tw = 112, th = 38;
        panel(api, tx, ty, tw, th);
        for (let k = 0; k < 3; k++) {
          const x = tx + 6 + k * 34;
          px.rect(x, ty + 8, 2, 14, 'yellow');
          px.rect(x + 3, ty + 20, 29, 2, 'dkblue');                   // listening
          for (let e = 0; e < 5; e++) px.rect(x + 6 + e * 5 + ((e * 7) % 3), ty + 20 - (5 - e) * 1.6, 1, (5 - e) * 1.6, 'lime', 0.8);
        }
        const now = tx + 6 + ((t / per) % 1) * 34;
        px.rect(now, ty + 4, 1, 20, 'white', 0.6);
        px.text('1 µs', tx + 4, ty + 28, 'yellow'); px.text('250 µs', tx + tw - 4, ty + 28, 'cyan', 1, 1, 'right');
        if (t < 6.5) { if (y0 > FACE && yb < px.H) api.mark([44, y0 - 2, 120, NCYC * LAM + 4], 'yellow', t); }
        else api.mark([tx, ty, tw, th], 'cyan', t);
      },
      caption: [
        { from: 0.6, to: 6.5, text: 'Imaging uses short <b>pulses</b>, not a steady tone: two or three cycles, about 1 µs. The <b>spatial pulse length</b> = cycles × λ, here 1.3 mm.' },
        { from: 6.5, to: 13, text: 'Then the probe falls silent and <b>listens</b> for the echoes, for about 250 µs, before the next pulse: a few thousand pulses a second (the <b>PRF</b>), sending less than 1% of the time.' },
      ],
    },
    {
      title: 'Acoustic impedance', dur: 13, view: 'pixel', scale: '0.3 mm',
      frame(t) {
        px.fillAll('ink');
        const n = COLS.length, cw = Math.floor((px.W - 20) / n), x0 = 10, per = 3.5;
        COLS.forEach(([name, id], i) => {
          const a = ACOUSTIC[id], cx0 = x0 + i * cw, cpx = C * a.c / 1540;   // its own speed (px/s)
          const sp = name === 'air' ? 7 : name === 'bone' ? 3 : 3;
          const pts = memo('imp' + i + ':' + cx0 + ':' + cw, () => makeField(cx0 + 3, FACE + 1, cw - 6, px.H - FACE - 34, sp, 40 + i, () => colMat[name]));
          const comps = every(t, per, 2, (t0) => ({ kind: 'plane', o: [0, FACE], d: [0, 1], t0, c: cpx, a: 1, lam: LAM * a.c / 1540, n: NCYC,
            fade: name === 'bone' ? (x, y, d) => Math.exp(-d / 70) : name === 'air' ? (x, y, d) => Math.exp(-d / 40) : null }));
          drawField(px, pts, comps, t, { gain: name === 'bone' ? 0.25 : name === 'air' ? 0.9 : 0.5 });
          faceStrip(px, cx0, cx0 + cw - 2, FACE, { n: 5, glow: () => sending(t, per, 0.4) });
          // its impedance as a bar (log scale: air is 4000 times less than tissue)
          const zb = px.H - 26, lz = Math.log10(a.z / 0.0001) / Math.log10(10 / 0.0001);
          px.rect(cx0 + 4, zb, cw - 10, 18, 'ink', 0.9);
          px.rect(cx0 + 4, zb + 12, Math.max(1, (cw - 10) * lz), 5, name === 'bone' ? 'bone' : name === 'air' ? 'grey' : name === 'fat' ? 'fat' : 'muscle');
          px.text(String(a.z), cx0 + cw / 2 - 2, zb + 3, 'white', 1, 1, 'center');
        });
        px.text('MRayl', px.W - 4, px.H - 7, 'mid', 1, 1, 'right');
        api.keepOut([0, px.H - 28, px.W, 28]);
        const i = t < 4 ? 1 : t < 8.5 ? 2 : 3;
        api.mark([x0 + i * cw + 2, FACE + 2, cw - 4, px.H - FACE - 32], 'yellow', t);
      },
      caption: [
        { from: 0.6, to: 4, text: 'Each tissue has its own <b>acoustic impedance</b>, Z = density × speed of sound: how hard it is to set moving. Soft tissues lie close together, 1.4 to 1.7 MRayl.', place: 'above' },
        { from: 4, to: 8.5, text: 'Bone is dense and stiff: Z about five times soft tissue’s; sound runs through it 2.6 times faster, and it soaks the sound up quickly.', place: 'above' },
        { from: 8.5, to: 13, text: 'Gas is the opposite: a few thousandths of tissue’s Z, its sound slow and quickly lost.', place: 'above' },
      ],
    },
    {
      title: 'Reflection at an interface', dur: 18, view: 'pixel', scale: '0.3 mm',
      cues: [[1.6, () => sfx.blip(660)], [7.6, () => sfx.blip(990)], [13.6, () => sfx.ping(1320)]],
      frame(t) {
        px.fillAll('ink');
        const yi = 104, k = Math.min(2, Math.floor(t / 6));
        const pairs = [['fat', 'liver', 2, 11], ['soft', 'bone', 10, 18], ['soft', 'air', 10, 0]];
        const [m1, m2, i1, i2] = pairs[k], a1 = ACOUSTIC[i1], a2 = ACOUSTIC[i2];
        const tt = t - k * 6;
        const comps = interfaceComps(tt, yi, a1.z, a2.z, C, C * a2.c / a1.c, 6, -20, 600, m2 === 'bone' ? 0.02 : m2 === 'air' ? 0.05 : 0);
        const pts = memo('ref' + k, () => field3.map((q) => ({ ...q, m: q.y < yi ? m1 : m2 }))
          .filter((q) => !(q.m === 'air' && ((q.x * 7 + q.y * 13) | 0) % 5)));
        drawField(px, pts, comps, tt, { gain: 0.5 });
        face(sending(tt, 6, NCYC * LAM / C));
        px.rect(0, yi, px.W, 1, 'white', 0.35);
        // the shares: reflected and transmitted intensity
        const Rv = Rpct(a1.z, a2.z), bx = px.W - 64, by = 30;
        panel(api, bx, by, 58, 70);
        px.text('R', bx + 13, by + 4, 'yellow', 1, 1, 'center'); px.text('T', bx + 43, by + 4, 'cyan', 1, 1, 'center');
        const hh = 44;
        px.rect(bx + 7, by + 12 + hh * (1 - Rv), 12, Math.max(1, hh * Rv), 'yellow');
        px.rect(bx + 37, by + 12 + hh * Rv, 12, Math.max(1, hh * (1 - Rv)), 'cyan');
        const pct = (v) => (v < 0.1 ? (v * 100).toFixed(1) : v > 0.99 ? (v * 100).toFixed(1) : Math.round(v * 100)) + '%';
        px.text(pct(Rv), bx + 14, by + 60, 'yellow', 1, 1, 'center'); px.text(pct(1 - Rv), bx + 44, by + 60, 'cyan', 1, 1, 'center');
        px.text(String(a1.z), 6, yi - 9, 'white'); px.text(String(a2.z), 6, yi + 4, 'white');
        // the echo heading back up, picked out
        const tHit = (yi - FACE) / C, e = ((tt % 6) + 6) % 6 - tHit;
        if (e > 0.2 && e < (yi - FACE) / C) api.mark([60, yi - e * C - NCYC * LAM / 2 - 6, 140, NCYC * LAM / 2 + 12], 'yellow', t);
        else api.mark([60, yi - 6, 140, 12], 'white', t);
        api.keepOut([0, yi - 2, px.W, 4]);                              // the interface itself
      },
      caption: [
        { from: 0.8, to: 6, text: 'Where two tissues meet, the jump in impedance sends part of the pulse back: an <b>echo</b>. Reflected share R = ((Z₂ − Z₁) ÷ (Z₂ + Z₁))²: fat on liver, under 1%. The rest goes on.', place: 'above' },
        { from: 6, to: 12, text: 'Soft tissue on <b>bone</b>: about 43% comes back, and bone absorbs most of what enters. Little reaches beyond it.', place: 'above' },
        { from: 12, to: 18, text: 'Soft tissue on <b>air</b> or gas: 99.9% is reflected. Nothing gets through: why lung and bowel gas block the view.', place: 'above' },
      ],
    },
    {
      title: 'Gel and matching layers', dur: 15, view: 'pixel', scale: '0.3 mm',
      cues: [[0.2, () => sfx.blip(880)], [5.2, () => sfx.click()], [5.4, () => sfx.blip(880)]],
      frame(t) {
        px.fillAll('ink');
        // the face, a thin gap, then skin; the gap is air until the gel fills it
        const gel = t >= 5, yGap = FACE + 1, yi = FACE + 9;
        const zGap = gel ? 1.5 : Zof(0), zSkin = Zof(23);
        const tt = gel ? t - 5 : t;
        const comps = interfaceComps(tt % 10, yi, gel ? 1.5 : zGap, zSkin, C, C, 5);
        // in air the pulse never really starts: what does is reflected straight back into the face
        const pts = memo('gel' + gel, () => field3.map((q) => ({ ...q, m: q.y < yi ? (gel ? 'gel' : 'air') : 'soft' }))
          .filter((q) => !(q.m === 'air' && ((q.x * 7 + q.y * 13) | 0) % 4)));
        drawField(px, pts, comps, tt % 10, { gain: 0.5 });
        face(sending(tt, 5, NCYC * LAM / C));
        if (!gel) { const e = ((tt % 5) + 5) % 5; if (e > 0.3 && e < 1.4) px.rect(0, yGap - 3, px.W, 2, 'red', 0.8 * (1 - e / 1.4)); }
        // the impedance staircase from crystal to skin, and what each step reflects
        const bx = px.W - 104, by = 36, bw = 98, bh = 92;
        if (t >= 9) {
          panel(api, bx, by, bw, bh);
          const steps2 = [['PZT', 30], ['', 7], ['', 2.6], ['gel', 1.5], ['skin', 1.6]];
          const y0 = by + bh - 14;
          steps2.forEach(([lab, z], i) => {
            const h = Math.max(1, Math.log10(z / 0.5) / Math.log10(60) * (bh - 30));
            px.rect(bx + 6 + i * 18, y0 - h, 14, h, i === 0 ? 'gold' : i < 3 ? 'orange' : i === 3 ? 'teal' : 'pink');
            px.text(String(z), bx + 13 + i * 18, y0 + 3, 'white', 1, 1, 'center');
          });
          px.text('MRayl', bx + bw - 4, by + 4, 'mid', 1, 1, 'right');
          api.mark([bx, by, bw, bh], 'orange', t);
        } else api.mark([0, yGap - 4, px.W, yi - yGap + 8], gel ? 'cyan' : 'red', t);
        api.keepOut([0, FACE - 16, px.W, 30]);
      },
      caption: [
        { from: 0.6, to: 5, text: 'Between the face and the skin, even a film of <b>air</b> reflects 99.9%: the pulse never gets in.', place: 'below' },
        { from: 5, to: 9, text: '<b>Gel</b> fills the gap with something close to tissue’s impedance: the pulse passes into the skin.', place: 'below' },
        { from: 9, to: 15, text: 'The same problem inside the probe: crystal (about 30 MRayl) on tissue (1.6) would reflect 80%. <b>Matching layers</b> of in-between impedance, each a quarter-wavelength thick, step it down so most of the energy gets out.', place: 'left' },
      ],
    },
    {
      title: 'Specular reflection and scatter', dur: 18, view: 'pixel', scale: '0.3 mm',
      cues: [[1.5, () => sfx.blip(990)], [9.5, () => sfx.hiss(0.5, 0.2, 2000)]],
      frame(t) {
        px.fillAll('ink');
        if (t < 8) {
          // a smooth boundary bigger than the beam, tilted: the echo goes off at the mirror angle
          const tt = t % 8, yb = (x) => 112 + (x - px.W / 2) * Math.tan(SPEC_ANG);
          const below = (x, y) => y > yb(x);
          const pts = memo('spec' + px.W, () => field3.map((q) => ({ ...q, m: below(q.x, q.y) ? 'liver' : 'soft' })));
          const xc = px.W * 0.42, bw = 46;
          const inc = { kind: 'plane', o: [0, FACE], d: [0, 1], t0: 0.2, c: C, a: 1, lam: LAM, n: NCYC, keep: (x, y) => !below(x, y) && Math.abs(x - xc) < bw };
          // reflected about the boundary's normal: direction (sin 2a, -cos 2a)
          const yh = yb(xc), dR = [Math.sin(2 * SPEC_ANG), -Math.cos(2 * SPEC_ANG)];
          const tHit = 0.2 + (yh - FACE) / C;
          const ref = { kind: 'plane', o: [xc, yh], d: dR, t0: tHit, c: C, a: 0.6, lam: LAM, n: NCYC,
            keep: (x, y) => !below(x, y) && Math.abs((x - xc) * dR[1] - (y - yh) * dR[0]) < bw * Math.cos(SPEC_ANG) };
          const tra = { ...inc, a: 0.85, keep: (x, y) => below(x, y) && Math.abs(x - xc) < bw };
          drawField(px, pts, [inc, ref, tra], tt, { gain: 0.5 });
          face(sending(tt, 99, 0.6));
          px.line(0, yb(0), px.W, yb(px.W), 'peach', 0.7);
          // the echo's path: in at the top, off to the side
          const ex = xc + dR[0] * (yh - FACE) / -dR[1];
          if (tt > tHit) arrow(px, xc, yh, lerp(xc, ex, 0.75), lerp(yh, FACE + 2, 0.75), 'yellow', 0.8);
          api.mark([xc - 30, yh - 18, 60, 30], 'yellow', t);
        } else {
          // scatterers: each cell re-radiates a weak wavelet as the pulse passes it
          const tt = t - 8, per = 10, k = Math.floor(tt / per), ttt = tt - k * per;
          const inc = { kind: 'plane', o: [0, FACE], d: [0, 1], t0: 0.2, c: C, a: 1, lam: LAM, n: NCYC };
          const wav = cells.map(([x, y, s]) => ({ kind: 'point', o: [x, y], t0: 0.2 + (y - FACE) / C, c: C, a: 0.55 * s, lam: LAM, n: NCYC, r0: 3 }));
          drawField(px, field4, [inc, ...wav], ttt, { gain: 0.5, thr: 0.22 });
          face(sending(ttt, 99, 0.6));
          for (const [x, y] of cells) px.rect(x - 1, y - 1, 2, 2, 'orange');
          // each cell's wavelet, its leading edge as a faint ring: out in every direction
          for (const w of wav) {
            const r = (ttt - w.t0) * C;
            if (r < 2 || r > 110) continue;
            const n = Math.ceil(r * 2.5), a = 0.9 * (1 - r / 110) * Math.min(1, w.a * 1.6);
            for (let j = 0; j < n; j++) { const an = 2 * Math.PI * j / n; px.px(w.o[0] + Math.cos(an) * r, w.o[1] + Math.sin(an) * r, 'peach', a); }
          }
          // what the face hears: the wavelets summed, an interference pattern in time
          const sx = px.W - 92, sy = FACE + 6;
          panel(api, sx, sy, 86, 34);
          poly(px, 82, (i) => {
            const tq = ttt - (i / 82) * 4;
            let s = 0;
            for (const w of wav) { const d = Math.hypot(w.o[0] - 160, w.o[1] - FACE), ss = (tq - w.t0) * C - d; s += pulseP(ss, LAM, NCYC) * w.a * Math.min(1, Math.sqrt(3 / Math.max(1, d))) * 4; }
            return [sx + 84 - i, sy + 17 - Math.max(-1, Math.min(1, s)) * 14];
          }, 'lime');
          // the speckle that echo makes: a column of grey, its brightness the summed echo
          if (ttt > 3) api.mark([sx, sy, 86, 34], 'lime', t);
          else api.mark([20, 66, 300, 118], 'orange', t);
        }
      },
      caption: [
        { from: 0.6, to: 8, text: 'A smooth boundary larger than the wavelength reflects like a mirror: <b>specular</b> reflection. Strongest when the beam meets it square-on; tilted, the echo goes off to the side and may miss the probe.' },
        { from: 8, to: 11, text: 'Cells and fibres smaller than the wavelength <b>scatter</b> a little of the pulse in all directions...', place: 'below' },
        { from: 11, to: 18, text: '...and their echoes arrive together and interfere, adding here and cancelling there: <b>speckle</b>, the grainy texture of an organ on the image, set by its tissue and the beam.', place: 'below' },
      ],
    },
    {
      title: 'Refraction', dur: 14, view: 'pixel', scale: '1 mm',
      frame(t) {
        px.fillAll('ink');
        // fat above, muscle below a boundary tilted 35 degrees from the beam's normal; Snell
        const a1 = 35 * Math.PI / 180, c1 = ACOUSTIC[2].c, c2 = ACOUSTIC[7].c;
        const a2 = Math.asin(Math.sin(a1) * c2 / c1);
        const x0 = px.W * 0.34, yB = 70;                         // where the beam's axis meets the boundary
        const nrm = [Math.sin(a1), -Math.cos(a1)];               // boundary normal (up)
        const below = (x, y) => (x - x0) * nrm[0] + (y - yB) * nrm[1] < 0;
        const pts = memo('refr' + px.W, () => field3.map((q) => ({ ...q, m: below(q.x, q.y) ? 'liver' : 'fat' })));
        const cpx = 26, cpx2 = cpx * c2 / c1;
        // incident: straight down; transmitted: bent away from the normal by a2 - a1
        const d2 = [Math.sin(a2 - a1), Math.cos(a2 - a1)];
        const per = 9, k = Math.floor(t / per), tt = t - k * per;
        const tB = 0.3 + (yB - FACE) / cpx;
        const inc = { kind: 'plane', o: [0, FACE], d: [0, 1], t0: 0.3, c: cpx, a: 1, lam: LAM, n: NCYC, keep: (x, y) => !below(x, y) && Math.abs(x - x0) < 34 };
        const tr = { kind: 'plane', o: [x0, yB], d: d2, t0: tB, c: cpx2, a: 1, lam: LAM * c2 / c1, n: NCYC,
          keep: (x, y) => below(x, y) && Math.abs((x - x0) * d2[1] - (y - yB) * d2[0]) < 34 };
        drawField(px, pts, [inc, tr], tt, { gain: 0.5 });
        face(sending(tt, per, 0.8));
        const yAt = (x) => yB + (x - x0) * Math.tan(a1);
        const bx0 = x0 + (FACE + 1 - yB) / Math.tan(a1), bx1 = px.W + 10;     // (from where it meets the face)
        px.line(bx0, yAt(bx0), bx1, yAt(bx1), 'peach', 0.7);
        // the true path to a target, and where the scanner draws it (straight down, same distance)
        const L = 92, tx = x0 + d2[0] * L, ty = yB + d2[1] * L, gx = x0, gy = yB + L;
        const k2 = span(tt, 4, 6);
        if (k2 > 0) {
          px.line(x0, FACE, x0, yB, 'yellow', 0.8); px.line(x0, yB, tx, ty, 'yellow', 0.8);
          px.line(x0, yB, gx, gy, 'grey', 0.7 * k2, 2);
          px.circle(tx, ty, 4, 'lime', 1, true);
          px.circle(gx, gy, 4, 'lime', 0.6 * k2);
          px.text(Math.round((a2 - a1) * 180 / Math.PI * 10) / 10 + '°', x0 + 10, yB + 22, 'yellow');
        }
        if (tt < 4.5) api.mark([x0 - 30, yB - 26, 60, 50], 'yellow', t);
        else api.mark([Math.min(tx, gx) - 8, ty - 8, Math.abs(tx - gx) + 16, 16], 'lime', t);
      },
      caption: [
        { from: 0.6, to: 6, text: 'Crossing a tilted boundary between tissues of different speed (fat 1450, muscle 1580 m/s), the beam bends: <b>refraction</b>, sin θ₂ ÷ sin θ₁ = c₂ ÷ c₁.' },
        { from: 6, to: 14, text: 'The scanner assumes every echo came straight down the line it sent, so whatever lies beyond is drawn <b>out of place</b>, to the side of where it really is.' },
      ],
    },
    {
      title: 'Attenuation', dur: 16, view: 'pixel', scale: '1 cm',
      cues: [[0.2, () => sfx.down()]],
      frame(t) {
        px.fillAll('ink');
        // 16 cm of tissue down the screen; the pulse a thin band at this scale, weakening
        const top = FACE + 2, bot = px.H - 6, cmPx = (bot - top) / 16;
        const fw = Math.round(px.W * 0.5);
        const per = 8, tt = ((t % per) + per) % per;
        const dPulse = tt * 2.6;                                 // cm the pulse has gone (slowed)
        const loss = (f, d) => 0.5 * f * d;                      // dB, one way
        const amp = Math.pow(10, -loss(3.5, Math.min(16, dPulse)) / 20);
        const pts = field4.filter((q) => q.x < fw && q.y > top);
        for (const q of pts) {
          const d = (q.y - top) / cmPx, s = dPulse - d;
          // heat left behind where the pulse has passed, more near the top where it was strong
          const passed = s > 0 ? Math.pow(10, -loss(3.5, d) / 20) : 0;
          const inP = s > 0 && s < 0.35;
          const p = inP ? Math.sin(s / 0.35 * Math.PI * 2.6) * amp : 0;
          const jx = Math.sin(t * 9 + q.ph) * (0.25 + passed * 0.5), jy = Math.cos(t * 7 + q.ph) * (0.25 + passed * 0.5);
          const col = p > 0.12 ? 'white' : passed > 0.35 ? 'orange' : passed > 0.12 ? 'red' : 'pink';
          px.px(q.x + jx, q.y + jy + p * 1.5, col, p > 0.12 ? 0.6 + 0.4 * amp : 0.55);
        }
        faceStrip(px, -4, fw, FACE, { n: 10, glow: () => (tt < 0.3 ? 1 : 0) });
        // the plot beside it, on the same depth axis: dB lost one way at three frequencies
        const gx = fw + 14, gw = px.W - gx - 8;
        panel(api, gx - 4, top - 2, gw + 8, bot - top + 4);
        for (let d = 0; d <= 16; d += 4) { const y = top + d * cmPx; px.rect(gx, y, gw, 1, 'dkgrey'); px.text(String(d), gx - 2, y - 2, 'mid', 1, 1, 'right'); }
        const dbMax = 60;
        [[2, 'lime'], [3.5, 'cyan'], [7.5, 'violet']].forEach(([f, c]) => {
          poly(px, 33, (i) => { const d = i / 2; const L = loss(f, d); return L > dbMax ? null : [gx + (L / dbMax) * gw, top + d * cmPx]; }, c);
          const dEnd = Math.min(16, dbMax / (0.5 * f));
          px.text(f + ' MHz', gx + (loss(f, dEnd) / dbMax) * gw - 3, top + dEnd * cmPx - 9, c, 1, 1, 'right');
        });
        for (const db of [20, 40, 60]) px.text(String(db), gx + (db / dbMax) * gw - (db === 60 ? 2 : 0), top + 2, 'mid', 1, 1, db === 60 ? 'right' : 'center');
        px.text('dB', gx + gw - 2, top + 9, 'mid', 1, 1, 'right');
        px.text('cm', gx + 1, bot - 7, 'mid');
        const yP = top + Math.min(16, dPulse) * cmPx;
        px.rect(gx, yP, gw, 1, 'white', 0.35);
        px.rect(gx + (loss(3.5, Math.min(16, dPulse)) / dbMax) * gw - 1, yP - 1, 3, 3, 'yellow');
        if (t < 8) api.mark([4, Math.max(top, yP - 10), fw - 8, 20], 'yellow', t);
        else api.mark([gx - 4, top - 2, gw + 8, bot - top + 4], 'cyan', t);
      },
      caption: [
        { from: 0.6, to: 8, text: 'With depth the pulse weakens: <b>attenuation</b>. Mostly <b>absorption</b>, its energy left behind as heat (a fraction of a degree), the rest scattered and reflected away.', place: 'right' },
        { from: 8, to: 16, text: 'In soft tissue about <b>0.5 dB per cm per MHz</b>: the higher the frequency, the faster the loss, and the echo pays it again on its way back. High frequency, fine detail, shallow; low frequency, depth.', place: 'left' },
      ],
    },
  ];
  void clamp01; void rng;
  return { title: 'Sound in tissue', steps };
}
