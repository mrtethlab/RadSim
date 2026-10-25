/* DXA FILM, chapter 2: the two energies. Inside the source (the tube, the cerium filter, the slit),
   down into the filter: a field of cerium atoms whose K shells take the photons just above their
   40.4 keV binding energy, leaving a beam with two peaks; the other way to get two energies,
   switching the tube's kV; and the detector that sorts each photon it counts into low or high. */
import { atom, electron, keVColor, spectrumPlot, tungstenSpectrum } from '../../kit/micro.js';
import { setOpacity } from '../../kit/stage.js';
import { ZP, FOCUS_Y } from './room.js';
import { CE_EDGE, CE_KA, KV, CE_RHOT, THRESH, ceMu, src76, filtered, dual, sampleE, stream } from './phys.js';

export function energies(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const J = S.J;
  const markZ = J ? J.spine.laser.z + ZP : -3;

  // a small panel of readouts: [value, color] rows, top right
  const hud = (rows, w = 40) => {
    const h = 4 + rows.length * 9, x = px.W - w - 4, y = 4;
    px.rect(x, y, w, h, 'ink', 0.85); px.frame(x, y, w, h, 'dkgrey');
    api.keepOut([x, y, w, h]);
    rows.forEach(([val, c], i) => px.text(val, x + w - 3, y + 3 + i * 9, c || 'yellow', 1, 1, 'right'));
  };

  /* ---------------------------------------------------------------- the cerium field (8-bit)
     Cerium atoms (Z = 58, drawn as 2/8/10/6, a hint of the real shells) in a lattice; photons
     from the tube rise through it, each by its energy: the chance it is taken is 1 - e^(-mu t),
     mu cerium's own, so those just over the K edge are nearly all taken and those just under it
     mostly pass. A photon taken by a K-shell electron ejects it (the photoelectron); an L electron
     refills the hole and cerium's own K-alpha photon leaves in a random direction. `focus`: one
     photon of 42 keV, slowed and pointed at, every P seconds. Returns the exits (for the plot). */
  let zapAt = -1;
  function ceriumScene(t, { rate = 26, panel = null, focus = true, P = 11, hiAt = 1.5 } = {}) {
    px.fillAll('ink');
    const W = px.W, H = px.H, sp = 24;
    const atoms = [];
    for (let y = 26; y < H - 14; y += sp) for (let x = 14 + ((y / sp) % 2) * sp / 2; x < W - 8; x += sp) atoms.push([x, y]);
    // the focus event, its phase in the cycle
    const ft = ((t - hiAt) % P + P) % P, cyc = Math.floor((t - hiAt) / P);
    const fOn = t >= hiAt && ft < 6.5;
    const okAt = (a) => a[1] > H * 0.35 && a[1] < H * 0.65 && a[0] > W * 0.3 && a[0] < W * 0.72
      && (!panel || a[0] < panel[0] - 18 || a[1] > panel[1] + panel[3] + 18);
    const fIdx = Math.max(0, atoms.findIndex(okAt)), fAtom = atoms[fIdx];
    const dim = fOn ? 0.35 : 1;
    // the electron knocked out of the focus atom's K shell, and the hole refilled
    const hole = fOn && ft > 2.2 && ft < 3.6;
    atoms.forEach(([x, y], k) => atom(px, x, y, 8, t, { shells: [2, 8, 10, 6], seed: k, ring: 'navy', e: 'blue', nucleus: 'gold',
      a: fOn && k === fIdx ? 1 : dim, missing: k === fIdx && hole ? 0 : -1 }));
    // the stream: photons from below, their fates by cerium's attenuation
    const v = 110, life = (H + 20) / v + 1.2;
    stream(t, 1 / rate, life, (i, age) => {
      const r = rng(7000 + i);
      const E = sampleE(r, src76, 18, KV), x = 10 + r() * (W - 20);
      const take = r() < 1 - Math.exp(-ceMu(E) * CE_RHOT);
      const yHit = H - 14 - r() * (H - 40);
      const y = H + 6 - age * v;
      px.alpha = dim;
      if (!take || y > yHit) { if (y > -8) px.photon(x, y, 0, -1, 6, keVColor(E), 0.9, t * 25 + i); }
      else {
        const e = (yHit - y) / v;                                      // seconds since it was taken
        if (e < 0.15) px.glow(x, yHit, 3, 'white', 0.9, i);
        if (e < 0.7) electron(px, x + e * 30 * (r() < 0.5 ? -1 : 1), yHit - e * 14, (1 - e / 0.7) * 0.8, 'cyan');
      }
      px.alpha = 1;
    });
    if (fOn) {
      // the 42 keV photon, slowed: up to the atom, taken by a K electron
      const [ax, ay] = fAtom, y0 = H + 6, tHit = 2.2;
      if (ft < tHit) {
        const y = lerp(y0, ay + 2, ft / tHit);
        for (let s = 0; s < 1; s += 0.03) px.px(ax + 2, lerp(y0, ay + 2, s * ft / tHit), 'yellow', 0.3);
        px.photon(ax + 2, y, 0, -1, 10, keVColor(42), 1, t * 25);
      } else {
        const e = ft - tHit;
        if (e < 0.25) px.glow(ax, ay, 7, 'white', 0.9, 3);
        if (e < 2) electron(px, ax + e * 34, ay - e * 20, 1 - e / 2.2, 'cyan');        // the K photoelectron
        if (e > 0.6 && e < 1.4) {                                                       // an L electron drops in
          const k = (e - 0.6) / 0.8;
          px.rect(lerp(ax + 6, ax + 2, k) - 1, lerp(ay - 5, ay, k) - 1, 3, 3, 'yellow');
        }
        if (e > 1.4 && e < 4.3) {                                                       // cerium's K-alpha, any direction
          const a = 2.6, L = (e - 1.4) * 70;
          px.photon(ax + Math.cos(a) * L, ay + Math.sin(a) * L, Math.cos(a), Math.sin(a), 9, keVColor(CE_KA), 1, t * 25);
        }
      }
      api.mark([ax - 13, ay - 13, 26, 26], 'yellow', t);
      api.keepOut([ax - 16, ay - 14, 32, H - ay + 14]);                                 // its path in, from below
      api.keepOut([ax - 70, ay - 14, 70, 60]);                                          // its K-alpha's, to the left
      if (ft >= tHit && ft < tHit + 0.3 && zapAt !== cyc) { zapAt = cyc; sfx.zap(); }
    }
    void cyc;
    return { atoms };
  }

  // the spectrum before (grey outline) and after the filter (bars), the edge marked
  function spectra(x, y, w, h, k, { lines = true } = {}) {
    spectrumPlot(px, x, y, w, h, KV, (E) => filtered(E, k) / 0.85, { hard: (E) => src76(E) / 0.85, axisMax: 90, label: true,
      lines: lines ? [59.3, 67.2] : [] });
    api.keepOut([x, y, w, h]);
    const x0 = x + 3, pw = w - 6, ex = x0 + Math.round((CE_EDGE / 90) * pw);
    px.line(ex, y + 4, ex, y + h - 8, 'red', 0.7 * k, 2);
  }

  // ---------------------------------------------------------------- 3D: photons out of the focal spot
  const outP = Array.from({ length: 160 }, (_, i) => { const r = rng(300 + i); return { i, u: r() - 0.5, w: r() - 0.5, E: sampleE(r, src76, 18, KV), r1: r() }; });
  function drawSourcePhotons(t, armZ, x, filterK = 1) {
    const P = 1.6;
    for (const p of outP) {
      const age = ((t + p.i * P / outP.length) % P) / P;          // looping: 0..1 of the way up
      const top = 26;                                              // cm above the spot that we follow them
      const d = age * top;
      const hz = Math.tan(2.25 * Math.PI / 180), dz = p.w * 2 * hz;
      // the filter (2.4 cm up) takes a photon by cerium's attenuation; the slit (5.2) everything off the fan
      const taken = filterK > 0 && p.r1 < (1 - Math.exp(-ceMu(p.E) * CE_RHOT)) * filterK;
      if (taken && d > 2.4) continue;
      const pos = [x + p.u * 0.25 * d, FOCUS_Y + d, armZ + dz * d];
      const [sx, sy, f] = api.toPx(pos);
      if (!f) continue;
      const [sx2, sy2] = api.toPx([pos[0], pos[1] + 0.6, pos[2] + dz * 0.6]);
      px.photon(sx, sy, sx2 - sx, sy2 - sy, 4, keVColor(p.E), 0.9, t * 20 + p.i);
    }
  }

  // ---------------------------------------------------------------- kV switching (8-bit)
  const s100 = tungstenSpectrum(100, 0.3), s140 = tungstenSpectrum(140, 0.3);

  // ---------------------------------------------------------------- the detector (8-bit)
  /* A row of cadmium zinc telluride elements across the top; photons of the dual beam arrive from
     below, each absorbed and turned into a pulse of charge whose height is its energy; the element
     in focus shows its pulses on a trace, the threshold between the peaks, and its two counters. */
  function detectorScene(t) {
    px.fillAll('ink');
    const W = px.W, H = px.H, n = 9, ew = Math.floor((W - 30) / n), x0 = Math.round((W - ew * n) / 2), y0 = 22, eh = 16;
    const fe = 4;                                                // the element in focus
    // the trace's box, low on the screen: the photons come up from behind it
    const tx = 12, ty = Math.round(H * 0.56), tw = W - 24, th = Math.round(H * 0.3);
    const rate = 18, v = 110, tIn = (ty - (y0 + eh / 2)) / v, win = 2.5;
    const photon = (i) => {
      const r = rng(9100 + i);
      const E = sampleE(r, dual, 18, KV), el = i % 3 === 0 ? fe : Math.floor(r() * n);
      return { E, el, x: x0 + el * ew + 3 + r() * (ew - 6) };
    };
    stream(t, 1 / rate, tIn + 0.2, (i, age) => {
      const p = photon(i), y = ty - age * v;
      if (age < tIn) px.photon(p.x, y, 0, -1, 6, keVColor(p.E), p.el === fe ? 1 : 0.6, t * 25 + i);
      else px.glow(p.x, y0 + eh / 2, 3, 'white', 0.9, i);
    });
    // the focus element's pulses: every one of its photons that arrived in the last `win` seconds
    const pulses = [];
    stream(t, 1 / rate, tIn + win, (i, age) => {
      if (i % 3 !== 0 || age < tIn) return;
      pulses.push({ at: i / rate + tIn, E: photon(i).E });
    });
    for (let k = 0; k < n; k++) {
      const x = x0 + k * ew;
      px.rect(x + 1, y0, ew - 2, eh, k === fe ? 'teal' : 'dkblue', 0.9);
      px.frame(x + 1, y0, ew - 2, eh, k === fe ? 'cyan' : 'navy');
      // its two counters: low (yellow), high (cyan), as bars that fill and roll over
      const cl = (t * 5.6 + k * 0.37) % 1, ch = (t * 3.9 + k * 0.53) % 1;
      px.rect(x + 3, y0 - 6, Math.round((ew - 6) * cl), 2, 'yellow', 0.85);
      px.rect(x + 3, y0 - 3, Math.round((ew - 6) * ch), 2, 'cyan', 0.85);
    }
    // the focus element's trace: pulse heights over the last 2.5 s, the threshold between the peaks
    px.rect(tx, ty, tw, th, 'ink', 0.95); px.frame(tx, ty, tw, th, 'dkgrey');
    api.keepOut([tx, ty, tw, th]);
    const yE = (E) => ty + th - 3 - (E / 80) * (th - 6);
    px.line(tx + 1, yE(THRESH), tx + tw - 2, yE(THRESH), 'white', 0.6, 3);
    px.text(String(THRESH), tx + tw - 3, yE(THRESH) - 7, 'white', 0.8, 1, 'right');
    px.text('keV', tx + 3, ty + 3, 'mid');
    for (const p of pulses) {
      const age = t - p.at;
      if (age < 0 || age > win) continue;
      const xx = tx + tw - 4 - (age / win) * (tw - 10), hi = p.E >= THRESH;
      for (let k = -1; k < 6; k++) {                                    // a sharp rise, a decay
        const yy = lerp(ty + th - 3, yE(p.E), k < 0 ? 0.5 : Math.exp(-k * 0.45));
        px.line(xx - k, ty + th - 3, xx - k, yy, hi ? 'cyan' : 'yellow', k === 0 ? 1 : 0.55);
      }
      if (age < 0.12) px.rect(xx - 1, yE(p.E) - 1, 3, 3, 'white');
    }
    // the counts so far in the focus element (low, high: the beam's shares either side of the threshold)
    const nf = Math.max(0, Math.floor((t - tIn) * rate / 3)), nl = Math.round(nf * 0.59), nh = nf - nl;
    px.text(String(nl), x0 + fe * ew + ew / 2, y0 + eh + 4, 'yellow', 1, 1, 'center');
    px.text(String(nh), x0 + fe * ew + ew / 2, y0 + eh + 11, 'cyan', 1, 1, 'center');
    return { el: [x0 + fe * ew - 1, y0 - 8, ew + 2, eh + 26], trace: [tx, ty, tw, th] };
  }

  const steps = [
    {
      title: 'Inside the source', dur: 13, scale: (t) => (t < 7 ? '10 cm' : '1 cm'),
      enter() { S.reset(); S.patLook(0.35, 0.2); S.block.visible = true; S.legsTo('block'); setOpacity(S.carriageG, 0.15); setOpacity(S.headG, 0.5); },
      cam: [[0, [120, -10, markZ + 60], [0, -20, markZ], 34], [7, [42, -22, markZ + 30], [0, FOCUS_Y + 2, markZ], 32], [13, [9, FOCUS_Y + 4, markZ + 8], [0, FOCUS_Y + 2.5, markZ], 30]],
      cues: [[0.8, () => sfx.power()]],
      frame(t) {
        S.setArm(markZ, 0);
        S.spot.material.opacity = 0.9;
        sfx.hold('tube', 70, 0.03, 'triangle');
        drawSourcePhotons(t, markZ, 0, span(t, 0, 0.01));
        // the beam's path up from the spot: the caption keeps off it
        { const a = api.toPx([0, FOCUS_Y, markZ]), b = api.toPx([0, FOCUS_Y + 26, markZ]);
          api.keepOut([Math.min(a[0], b[0]) - 8, Math.min(a[1], b[1]), Math.abs(a[0] - b[0]) + 16, Math.abs(a[1] - b[1])]); }
        api.mosaic(span(t, 11.2, 13));
        if (t > 1 && t < 6.5) api.mark(S.housing, 'orange', t);
        if (t > 6.5 && t < 11.2) api.mark(S.filter, 'yellow', t);
      },
      caption: [
        { from: 1, to: 6.5, text: 'The tube runs at a steady <b>76 kV</b>: one ordinary spectrum, every energy up to 76 keV.' },
        { from: 6.5, to: 11.5, text: 'Above it, a thin <b>cerium</b> filter, then a slit that trims the beam to a narrow fan.' },
      ],
    },
    {
      title: 'The K-edge filter', dur: 14, view: 'pixel', scale: '100 pm',
      cues: [[0.2, () => sfx.whoosh()]],
      enter() { zapAt = -1; },
      frame(t) {
        const panel = [4, 4, Math.min(116, px.W * 0.5), 62];
        ceriumScene(t, { panel, hiAt: 1.5, P: 12 });
        spectra(...panel, span(t, 6.5, 12));
        if (t > 6.5) api.mark([panel[0] + 3 + Math.round((CE_EDGE / 90) * (panel[2] - 6)) - 3, panel[1] + 2, 16, panel[3] - 10], 'red', t);
      },
      caption: [
        { from: 0.8, to: 6.5, text: 'Cerium’s innermost (K) electrons are bound by <b>40.4 keV</b>. A photon with just more is absorbed, ejecting one: the photoelectric effect.' },
        { from: 6.5, to: 14, text: 'Just below that <b>K-edge</b> they cannot be reached and most photons pass; far above it the chance falls again. A gap opens in the spectrum.' },
      ],
    },
    {
      title: 'Two energies in one beam', dur: 12, view: 'pixel', scale: '100 pm',
      frame(t) {
        px.fillAll('ink');
        const w = Math.min(px.W - 20, 220), h = 120, x = Math.round((px.W - w) / 2), y = 14;
        spectrumPlot(px, x, y, w, h, KV, dual, { axisMax: 90, lines: [59.3, 67.2] });
        api.keepOut([x, y, w, h]);
        const x0 = x + 3, pw = w - 6, X = (E) => x0 + Math.round((E / 90) * pw);
        // cerium's attenuation, the edge in it (on a scale of its own, faint)
        // (log scale, as attenuation is always drawn: the edge a six-fold jump)
        let lx = null, ly = null;
        const ka = 0.55 * span(t, 0.5, 2), yMu = (m) => y + h - 9 - Math.max(0, Math.min(1, Math.log(m / 1.5) / Math.log(60 / 1.5))) * (h - 16);
        for (let E = 16; E <= 80; E += 0.25) {
          const yy = yMu(ceMu(E));
          if (lx != null) px.line(lx, ly, X(E), yy, 'red', ka);
          lx = X(E); ly = yy;
        }
        // the two effective energies the console uses
        const k = span(t, 4, 5);
        for (const [E, c] of [[40, 'yellow'], [70, 'cyan']]) {
          px.rect(X(E), y + 3, 1, h - 10, c, 0.5 * k);
          px.text(String(E), X(E), y + h + 3, c, k, 1, 'center');
        }
        if (t > 4 && t < 8) api.mark([X(26), y + 8, X(41) - X(26), h - 16], 'white', t);
        if (t > 8) api.mark([X(50), y + 30, X(77) - X(50), h - 38], 'white', t);
      },
      caption: [
        { from: 0.6, to: 4, text: 'Out of the filter: one beam with a low peak just under the edge and a high one well above it.' },
        { from: 4, to: 8, text: 'The scanner treats them as about <b>40 keV</b> and <b>70 keV</b>: two measurements of every ray, at once.' },
        { from: 8, to: 12, text: 'Tungsten’s own lines (59, 67 keV) add to the <b>high</b> peak.' },
      ],
    },
    {
      title: 'Or: switching the kV', dur: 10, view: 'pixel', scale: '1 ms',
      frame(t) {
        px.fillAll('ink');
        const W = px.W, half = 1 / 120;                     // a half-cycle of 60 Hz mains, 8.3 ms
        const slow = 1.2;                                    // shown slowed: seconds per half-cycle
        const hiNow = Math.floor(t / slow) % 2 === 1;
        // the tube voltage against time
        const tx = 10, ty = 12, tw = W - 20, th = 46;
        px.rect(tx, ty, tw, th, 'ink', 0.9); px.frame(tx, ty, tw, th, 'dkgrey');
        api.keepOut([tx, ty, tw, th]);
        const yk = (kv) => ty + th - 4 - ((kv - 80) / 70) * (th - 8);
        let ly = null;
        for (let i = 0; i < tw - 4; i++) {
          const tt = t - (tw - 4 - i) * 0.02, kv = Math.floor(tt / slow) % 2 ? 140 : 100;
          const yy = yk(tt < 0 ? 100 : kv);
          if (ly != null) px.line(tx + 2 + i - 1, ly, tx + 2 + i, yy, i > tw - 8 ? 'white' : 'orange');
          ly = yy;
        }
        px.text('100', tx + 3, yk(100) - 7, 'yellow'); px.text('140', tx + 3, yk(140) + 2, 'cyan');
        px.text((half * 1000).toFixed(1) + ' ms', tx + tw - 3, ty + th - 8, 'mid', 1, 1, 'right');
        // the spectrum of the moment
        const w = Math.min(W - 20, 220), x = Math.round((W - w) / 2), y = ty + th + 10, h = 88;
        spectrumPlot(px, x, y, w, h, hiNow ? 140 : 100, (E) => (hiNow ? s140(E) : s100(E) * 0.6), { axisMax: 150, lines: [59.3, 67.2] });
        api.keepOut([x, y, w, h]);
        if (t > 1) api.mark([tx + tw - 10, ty + 2, 8, th - 4], hiNow ? 'cyan' : 'yellow', t);
      },
      cues: Array.from({ length: 8 }, (_, k) => [1.2 * (k + 1), () => sfx.blip(k % 2 ? 990 : 660)]),
      caption: [
        { from: 0.6, to: 10, text: 'Other densitometers instead switch the tube between about <b>100 and 140 kV</b> every half-cycle of the mains: low and high energy in turn.' },
      ],
    },
    {
      title: 'Counting low and high', dur: 13, view: 'pixel', scale: '1 mm',
      frame(t) {
        const r = detectorScene(t);
        if (t < 6) api.mark(r.el, 'yellow', t);
        else api.mark(r.trace, 'yellow', t);
      },
      cues: Array.from({ length: 13 }, (_, k) => [0.5 + k, () => sfx.tick()]),
      caption: [
        { from: 0.5, to: 6, text: 'In the head, each element of a <b>cadmium zinc telluride</b> detector counts photons one by one.' },
        { from: 6, to: 13, text: 'Each makes a pulse of charge as tall as its energy. A <b>threshold</b> between the peaks sorts every pulse into a low or a high count.' },
      ],
    },
  ];
  void clamp01; void dual;
  return { title: 'Two energies', steps };
}
