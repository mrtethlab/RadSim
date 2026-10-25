/* FLUOROSCOPY FILM, chapter 2: the image intensifier. The drum opened; down into the caesium iodide
   input phosphor (x-ray to light) and the photocathode (light to electrons), an 8-bit field of
   needles and atoms; back out to the electron optics (focusing, crossover, the anode's kilovolts);
   down again into the output phosphor (electrons to a burst of light); the gains; magnification
   modes; the distortions; the camera; and the flat panel that replaces it all.
   Directions are the 3D view's throughout: the beam comes up from the tube below, so in every
   close-up the x-rays arrive from the bottom of the screen and what they make goes up. */
import { setOpacity } from '../../kit/stage.js';
import { electron, keVColor, tungstenSpectrum } from '../../kit/micro.js';
import { hud, panel, boxLocal, recent } from './util.js';
import { II, yPC } from './ii3d.js';
import { FIELD_PX } from './live.js';

export function iiChapter(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const U = S.suite, I = S.ii, L = S.live;
  const spec = tungstenSpectrum(75, 0.35);
  const sampleE = (r) => { for (let k = 0; k < 200; k++) { const E = 18 + r() * 57; if (r() < spec(E)) return E; } return 45; };

  // the C's receptor opened: its drum and cap see-through, the insides shown
  const openDrum = (k) => {
    setOpacity(U.parts.ii, 1 - 0.88 * k); setOpacity(U.parts.cap, 1 - 0.88 * k); setOpacity(U.parts.trim, 1 - 0.88 * k);
    for (const m of U.parts.ring) setOpacity(m, 1 - 0.8 * k);
    I.g.visible = k > 0.02;
  };
  // the intensifier's centre (the C's frame -> the room)
  const iiAt = (y) => I.toWorld(0, y, 0);

  // ================================================================ 8-bit: the input phosphor
  /* The input in section, the beam up from the bottom: the aluminium substrate, the CsI needles,
     the photocathode on their tops, the vacuum above. Each x-ray is absorbed in a needle (most of
     them), in the substrate (a few) or passes through; an absorbed one makes a burst of light that
     runs along its needle to the photocathode, where now and then an electron leaves. */
  function inputScene(t, { rate = 4, hi = false, hiAt = 0, slow = 3 } = {}) {
    px.fillAll('ink');
    const W = px.W, H = px.H, nw = 10, n = Math.floor((W - 12) / nw), x0 = Math.round((W - n * nw) / 2);
    const yAl = H - 22, yTop = 42;
    // the substrate
    px.rect(0, yAl, W, 7, 'slate');
    for (let x = 2; x < W; x += 5) for (let y = yAl + 2; y < yAl + 7; y += 3) px.px(x + (y % 2), y, 'grey', 0.6);
    px.rect(0, yAl + 7, W, 2, 'dkgrey');
    // the needles, their lattice (caesium and iodine), their walls
    for (let k = 0; k < n; k++) {
      const x = x0 + k * nw;
      px.rect(x + 1, yTop, nw - 2, yAl - yTop, 'teal', 0.4);
      px.rect(x + 1, yTop, 1, yAl - yTop, 'cyan', 0.35); px.rect(x + nw - 2, yTop, 1, yAl - yTop, 'cyan', 0.35);
      for (let y = yTop + 3; y < yAl - 1; y += 5) { px.px(x + 3, y, 'lav', 0.7); px.px(x + 6, y + 2, 'violet', 0.7); }
    }
    // the photocathode on their tops, the vacuum above
    px.rect(0, yTop - 4, W, 4, 'gold', 0.75);
    for (let x = 1; x < W; x += 4) px.px(x, yTop - 3, 'brown', 0.9);
    const fi = hi ? Math.floor(hiAt * rate) : -1;
    let focus = null;
    for (const i of recent(t, rate, 4, fi)) {
      const r = rng(700 + i), isF = i === fi;
      const E = sampleE(r), roll = r();
      let k = Math.floor(r() * n);
      if (isF) k = Math.floor(n / 2) + 1;
      const x = x0 + k * nw + 2 + r() * (nw - 4);
      // the fate: absorbed in the CsI (depth by its attenuation), the substrate, or through
      const fate = isF ? 'csi' : roll < 0.05 ? 'al' : roll < 0.72 ? 'csi' : 'through';
      const yA = fate === 'al' ? yAl + 3 : fate === 'csi' ? yAl - 4 - (isF ? 0.45 : Math.min(0.92, -Math.log(1 - r() * 0.95) * 0.35)) * (yAl - yTop - 8) : -20;
      const age = (t - i / rate) / (isF ? slow : 1);
      if (age < 0) continue;
      const v = 150, tHit = (H + 6 - yA) / v;
      const a = hi && !isF && focus ? 0.4 : 1;
      if (age < tHit) { px.photon(x, H + 6 - age * v, 0, -1, isF ? 9 : 6, keVColor(E), isF ? 1 : 0.9, t * 30 + i); if (isF) focus = { x, yA, k, age, tHit }; continue; }
      if (fate === 'through') continue;
      const e = age - tHit;
      if (isF) focus = { x, yA, k, age, tHit, e };
      if (fate === 'al') { if (e < 0.25) px.glow(x, yA, 3, 'grey', 0.9, i); continue; }
      if (e < 0.25) px.glow(x, yA, isF ? 6 : 4, 'white', 0.95 * a, i);
      if (e < 0.8) electron(px, x + e * 14 * (r() < 0.5 ? -1 : 1), yA - e * 6, (1 - e / 0.8) * 0.8 * a, 'cyan');   // the photoelectron, absorbed nearby
      // the light: a few dozen photons inside the needle's walls, folded at them, up (and down,
      // off the reflecting substrate) to the photocathode
      const wL = x0 + k * nw + 2, wR = x0 + k * nw + nw - 3, sp = wR - wL, nl = isF ? 44 : 30;
      for (let j = 0; j < nl; j++) {
        const rr = rng(i * 131 + j), ang = (rr() - 0.5) * 2.6 + (rr() < 0.3 ? Math.PI : 0), s = 70 + rr() * 50, d = e * s;
        let lx = x - wL + Math.sin(ang) * d;
        lx = ((lx % (2 * sp)) + 2 * sp) % (2 * sp); if (lx > sp) lx = 2 * sp - lx;
        let ly = yA - Math.cos(ang) * d;
        if (ly > yAl) ly = 2 * yAl - ly;                       // off the substrate, back up
        if (ly < yTop) {
          // it has reached the photocathode: a last spark, and sometimes an electron out
          const over = (yTop - ly) / s;
          if (over < 0.08) px.px(wL + lx, yTop - 2, 'white', 0.9 * a);
          if (j % 8 === 0 && over < 0.9) electron(px, wL + lx, yTop - 6 - over * over * 120, (1 - over / 0.9) * a, 'cyan');
          continue;
        }
        px.px(wL + lx, ly, 'blue', 0.95 * a);
      }
    }
    if (focus && (focus.e ?? 0) < 3.2) {
      const fx = x0 + focus.k * nw;
      api.mark([fx - 2, focus.yA - 10, nw + 4, 20], 'yellow', t);
      api.keepOut([fx - 4, yTop - 30, nw + 8, H - yTop + 30]);
    }
    return { yTop, yAl, x0, nw, n };
  }

  // ================================================================ 8-bit: the photocathode
  /* Nanometres across: the needles' tops below, two rows of antimony and caesium atoms, the vacuum
     above with the field that pulls electrons away (toward the anode, up). Light arrives from
     below; most is absorbed (the atom warms), some reflected, about one in ten frees an electron. */
  function cathodeScene(t, { hi = false, hiAt = 0, slow = 3 } = {}) {
    px.fillAll('ink');
    const W = px.W, H = px.H, rate = 14, yN = H - 30, yL = yN - 30;
    // the needles' tops
    for (let x = 0; x < W; x += 46) { px.rect(x + 2, yN, 42, H - yN, 'teal', 0.4); px.rect(x + 2, yN, 1, H - yN, 'cyan', 0.35); px.rect(x + 43, yN, 1, H - yN, 'cyan', 0.35); }
    // the field lines up through the vacuum
    for (let x = 12; x < W; x += 24) px.line(x, 6, x, yL - 14, 'dkgrey', 0.6, 2);
    // the layer: antimony and caesium (SbCs3: three caesium to each antimony), three rows deep
    const atoms = [];
    for (let row = 0; row < 3; row++) for (let x = 10 + (row % 2) * 8, j = 0; x < W - 6; x += 16, j++) atoms.push([x, yL + row * 12, (j + row * 2) % 4 === 0 ? 'Sb' : 'Cs']);
    const events = [];
    const fi = hi ? Math.floor(hiAt * rate) : -1;
    const warm = new Float32Array(atoms.length);
    for (const i of recent(t, rate, 3, fi)) {
      const r = rng(9000 + i), isF = i === fi;
      let a = Math.floor(r() * atoms.length);
      if (isF) a = atoms.findIndex((q) => q[1] === yL + 12 && q[0] > W * 0.45);
      const roll = r(), fate = isF ? 'emit' : roll < 0.11 ? 'emit' : roll < 0.86 ? 'absorb' : 'reflect';
      const age = (t - i / rate) / (isF ? slow : 1);
      events.push({ i, a, fate, age, isF, r });
      if (fate === 'absorb' && age > 0.35 && age < 1.6) warm[a] += 0.5 * (1 - (age - 0.35) / 1.25);
    }
    const F = events.find((e) => e.isF && e.age > 0 && e.age < 3.2);
    const dim = F ? 0.35 : 1;
    atoms.forEach(([x, y, kind], k) => {
      const isFA = F && F.a === k;
      const missing = isFA && F.age > 0.35 ? 0 : -1;
      // drawn by hand (a nucleus, two shells): Sb orange, Cs violet
      const j = warm[k] > 0 ? Math.round(Math.sin(t * 40 + k) * warm[k] * 1.5) : 0;
      const al = isFA ? 1 : dim;
      px.circle(x + j, y, 3, 'dkgrey', 0.6 * al); px.circle(x + j, y, 5, 'dkgrey', 0.45 * al);
      for (let e = 0; e < 4; e++) { if (e === 0 && missing === 0) continue; const ang = t * 2 + e * 1.57 + k; px.px(x + j + Math.cos(ang) * 5, y + Math.sin(ang) * 5, 'blue', al); }
      px.rect(x + j - 1, y - 1, 3, 3, kind === 'Sb' ? 'orange' : 'violet', al);
      if (warm[k] > 0.2) px.glow(x, y, 5, 'red', warm[k] * 0.4 * al, k);
    });
    for (const ev of events) {
      if (ev.age < 0) continue;
      const [ax, ay] = atoms[ev.a], al = ev.isF ? 1 : dim, v = 120;
      const x = ax + (ev.r() - 0.5) * 3, tIn = (H + 4 - ay) / v;
      if (ev.age < tIn) { px.photon(x, H + 4 - ev.age * v, 0, -1, ev.isF ? 8 : 5, 'blue', al, t * 25 + ev.i); continue; }
      const e = ev.age - tIn;
      if (ev.fate === 'reflect') { if (e < 0.6) px.photon(x + e * 30, ay + e * v, 0.4, 1, 5, 'blue', al * (1 - e / 0.6), t * 25); continue; }
      if (ev.fate === 'absorb') { if (e < 0.15) px.glow(ax, ay, 3, 'orange', 0.8 * al, ev.i); continue; }
      // photoemission: the freed electron leaves the surface, slow at first, then pulled away
      if (e < 0.12) px.glow(ax, ay, 4, 'white', 0.95 * al, ev.i);
      const yy = ay - 6 - (14 * e + 70 * e * e);
      if (yy > -6) {
        if (ev.isF) for (let q = 0; q < e; q += 0.05) px.px(ax, ay - 6 - (14 * q + 70 * q * q), 'cyan', 0.45);
        electron(px, ax, yy, al, ev.isF ? 'yellow' : 'cyan');
      }
    }
    if (F) { const [ax, ay] = atoms[F.a]; api.mark([ax - 10, ay - 10, 20, 20], 'yellow', t); api.keepOut([ax - 14, 0, 28, ay - 12]); }
    // the tally over the last few seconds: light in, electrons out
    let nl = 0, ne = 0;
    for (const ev of events) if (ev.age > 0.5 && !ev.isF) { nl++; if (ev.fate === 'emit') ne++; }
    return { nl, ne, yL };
  }

  // ================================================================ 8-bit: the output phosphor
  /* Micrometres across: fast electrons up from the vacuum below, through the thin aluminium film
     into the layer of zinc cadmium sulfide grains; each one a burst of green light, most of it up
     through the output window (what goes down, the aluminium sends back up). */
  const grains = (() => { const r = rng(55), a = []; for (let k = 0; k < 160; k++) a.push([r(), r(), 2 + Math.floor(r() * 3)]); return a; })();
  function outputScene(t, { hi = false, hiAt = 0, slow = 3 } = {}) {
    px.fillAll('ink');
    const W = px.W, H = px.H, yAl = H - 58, yP = yAl - 30, yW = yP - 4;
    // the output window (glass) above, the phosphor grains, the aluminium film, the vacuum below
    px.rect(0, 0, W, yW, 'dkblue', 0.35);
    px.rect(0, yP - 2, W, yAl - yP + 2, 'green', 0.12);
    for (const [gx, gy, s] of grains) { const x = gx * W, y = yP + gy * (yAl - yP - 3); px.rect(x, y, s + 1, s, 'green', 0.55); px.px(x, y, 'lime', 0.5); }
    px.rect(0, yAl, W, 2, 'grey', 0.9);
    const rate = 6, fi = hi ? Math.floor(hiAt * rate) : -1;
    let focus = null;
    for (const i of recent(t, rate, 3, fi)) {
      const r = rng(4400 + i), isF = i === fi;
      const age = (t - i / rate) / (isF ? slow : 1);
      if (age < 0) continue;
      const x = isF ? W * 0.55 : 6 + r() * (W - 12), yHit = yAl - 6 - r() * 18, v = 360;
      const tHit = (H + 6 - yHit) / v;
      const dimA = hi && !isF && focus ? 0.4 : 1;
      if (age < tHit) {
        const y = H + 6 - age * v;
        px.line(x, y, x, Math.min(H + 6, y + 14), 'blue', 0.5 * dimA); electron(px, x, y, dimA, isF ? 'yellow' : 'cyan');
        if (isF) focus = { x, yHit };
        continue;
      }
      const e = age - tHit;
      if (isF) focus = { x, yHit, e };
      if (e < 0.2) px.glow(x, yHit, isF ? 7 : 5, 'lime', 0.95 * dimA, i);
      const nl = isF ? 60 : 30;
      for (let j = 0; j < nl; j++) {
        const rr = rng(i * 97 + j), ang = rr() * Math.PI * 2, s = 50 + rr() * 60;
        let lx = x + Math.cos(ang) * e * s, ly = yHit + Math.sin(ang) * e * s;
        if (ly > yAl) ly = 2 * yAl - ly;                       // off the aluminium, back up
        if (ly < -2 || lx < -2 || lx > W + 2) continue;
        px.px(lx, ly, ly < yW ? 'lime' : 'yellow', 0.95 * dimA);
      }
    }
    if (focus) { api.mark([focus.x - 9, focus.yHit - 9, 18, 18], 'yellow', t); api.keepOut([focus.x - 40, 0, 80, focus.yHit + 12]); }
  }

  // ================================================================ 8-bit: the gains
  function gainScene(t) {
    px.fillAll('ink');
    const W = px.W, H = px.H, R = Math.min(48, H * 0.25), cy = H * 0.4, xi = W * 0.3, xo = W * 0.78, ro = Math.max(3, R * 2.5 / 23);
    // the input image: dim light over a big disc
    px.circle(xi, cy, R, 'dkblue', 0.8, true); px.circle(xi, cy, R, 'blue', 0.7);
    const r = rng(3);
    for (let k = 0; k < 140; k++) { const a = r() * 6.283, d = Math.sqrt(r()) * (R - 2); if (((t * 3 + k * 0.37) % 1) < 0.5) px.px(xi + Math.cos(a) * d, cy + Math.sin(a) * d, 'blue', 0.8); }
    // the electrons converging on the small output, its light rising with the gain shown
    const k1 = span(t, 1, 3);
    for (let k = 0; k < 50; k++) {
      const rr = rng(80 + k), a = rr() * 6.283, d = Math.sqrt(rr()) * (R - 2), ph = (t * 0.6 + rr()) % 1;
      const sx = xi + Math.cos(a) * d, sy = cy + Math.sin(a) * d, ex = xo - Math.cos(a) * d * ro / R, ey = cy - Math.sin(a) * d * ro / R;
      if (k1 > 0) px.px(lerp(sx, ex, ph), lerp(sy, ey, ph) - Math.sin(ph * Math.PI) * 6 * Math.sin(a), 'cyan', 0.7 * k1);
    }
    const b = span(t, 2, 4) * 0.5 + span(t, 6.5, 8.5) * 0.5;
    px.glow(xo, cy, Math.round(ro * (2 + 3 * b)), 'lime', 0.4 + 0.6 * b, 2);
    px.circle(xo, cy, ro, 'lime', 1, true); px.circle(xo, cy, ro, 'white', b);
    px.text('23 cm', xi, cy + R + 6, 'mid', 1, 1, 'center');
    px.text('2.5 cm', xo, cy + R + 6, 'mid', 1, 1, 'center');
    // the sums
    const y = H - 52;
    const s1 = span(t, 2.5, 3.2), s2 = span(t, 6.5, 7.2), s3 = span(t, 9, 9.7);
    if (s1 > 0) { px.text('(23/2.5)^2', W * 0.3, y, 'white', s1, 1, 'center'); px.text('85', W * 0.3, y + 10, 'yellow', s1, 2, 'center'); }
    if (s2 > 0) { px.text('x', W * 0.5, y + 12, 'mid', s2, 1, 'center'); px.text('50', W * 0.62, y + 10, 'yellow', s2, 2, 'center'); }
    if (s3 > 0) { px.text('=', W * 0.74, y + 12, 'mid', s3, 1, 'center'); px.text('4200', W * 0.86, y + 10, 'lime', s3, 2, 'center'); }
    api.keepOut([W * 0.15, y - 2, W * 0.8, 24]);
    if (t > 2.5 && t < 6.5) api.mark([W * 0.3 - 22, y - 3, 44, 24], 'yellow', t);
    else if (t > 6.5 && t < 9) api.mark([W * 0.62 - 12, y + 7, 24, 15], 'yellow', t);
    else if (t >= 9) api.mark([W * 0.86 - 20, y + 7, 40, 15], 'lime', t);
  }

  // ================================================================ 8-bit: distortion and vignetting
  // a test grid of straight wires seen through the intensifier (pin: pincushion, vig: vignetting,
  // s: S-distortion, flat: the flat panel's square field)
  function gridScene(t, { pin = 0, vig = 0, s = 0, flat = 0, wob = 0 } = {}) {
    px.fillAll('ink');
    const W = px.W, H = px.H, R = Math.min(H * 0.42, W * 0.4), cx = W / 2, cy = H * 0.46;
    const map = (u, v) => {
      // u, v in -1..1 of the field; pincushion stretches with the square of the radius
      const r2 = u * u + v * v, k = 1 + pin * 0.22 * r2;
      let x = u * k, y = v * k;
      // S: the electrons pushed sideways one way at the top and the other at the bottom, so a
      // straight line across the field bends into an S
      x += s * 0.12 * Math.sin(y * Math.PI) * (1 + 0.35 * Math.sin(wob));
      y += s * 0.05 * Math.sin(x * Math.PI) * (1 + 0.35 * Math.cos(wob));
      return [cx + x * R, cy + y * R];
    };
    const inside = (x, y) => (flat > 0.5 ? Math.abs(x - cx) <= R && Math.abs(y - cy) <= R : Math.hypot(x - cx, y - cy) <= R);
    // the field: grey, darker toward the rim with vignetting
    for (let y = Math.floor(cy - R); y <= cy + R; y++) for (let x = Math.floor(cx - R); x <= cx + R; x++) {
      if (!inside(x, y)) continue;
      const d = Math.hypot(x - cx, y - cy) / R, g = 0.78 - vig * 0.42 * d * d;
      const q = Math.round(Math.max(0.1, g) * 200);
      px.g.fillStyle = `rgb(${q},${q},${q})`; px.g.fillRect(x, y, 1, 1);
    }
    // the wires: straight lines in the object, drawn through the map
    const N = 9;
    for (let k = 0; k <= N; k++) {
      const w = k / N * 2 - 1;
      for (const horiz of [true, false]) {
        let last = null;
        for (let m = 0; m <= 120; m++) {
          const z = m / 120 * 2.4 - 1.2;
          const [x, y] = horiz ? map(z, w * 0.98) : map(w * 0.98, z);
          if (inside(x, y)) { if (last) px.line(last[0], last[1], x, y, 'ink', 0.85); last = [x, y]; } else last = null;
        }
      }
    }
    if (flat < 0.5) px.circle(cx, cy, R, 'dkgrey'); else px.frame(cx - R, cy - R, 2 * R + 1, 2 * R + 1, 'dkgrey');
    return { cx, cy, R };
  }

  // ================================================================ electrons in the tube (3D, drawn 8-bit)
  // electrons down the tube, each on its path, looping; rf the input radius in use (the mode)
  const eList = (() => { const r = rng(17), a = []; for (let k = 0; k < 150; k++) { const s = r() < 0.5 ? -1 : 1; a.push({ k, u0: r(), r0: s * Math.sqrt(r()), phi: (r() - 0.5) * 0.9 }); } return a; })();
  const magOf = (rf) => (II.R_IN - rf) / 6;
  function drawElectrons(t, { rf = II.R_IN, dens = 1, hi = null, P = 1.4 } = {}) {
    const mag = magOf(rf);
    for (const e of eList) {
      if (e.k / eList.length > dens) continue;
      const ph = ((t / P + e.u0) % 1), u = Math.pow(ph, 1.6);
      const p = I.ePos(e.r0 * rf, e.phi, u, mag);
      const [x, y, f] = api.toPx(p);
      if (!f) continue;
      const q = I.ePos(e.r0 * rf, e.phi, Math.max(0, u - 0.05), mag), [x2, y2] = api.toPx(q);
      px.line(x2, y2, x, y, 'blue', 0.4); px.px(x, y, 'cyan', 0.95);
    }
    // two marked ones from opposite edges, slow, so the crossover can be followed
    if (hi) for (const [s, c] of [[-1, 'yellow'], [1, 'orange']]) {
      const ph = clamp01(hi), u = Math.pow(ph, 1.6), r0 = s * rf * 0.85;
      for (let q = 0; q < u; q += 0.02) { const [x, y] = api.toPx(I.ePos(r0, 0, q, mag)); px.px(x, y, c, 0.5); }
      const [x, y] = api.toPx(I.ePos(r0, 0, u, mag));
      electron(px, x, y, 1, c);
    }
  }
  const iiCam = { pos: [26, 78, 60], look: [0, 73, 0] };   // the opened tube, side on
  const setRest = () => { S.reset(); U.skinAlpha(0.7); openDrum(1); I.outMat.emissiveIntensity = 0; I.setFov(II.R_IN, 0); };

  const steps = [
    {
      title: 'Inside the intensifier', dur: 15, fadeIn: 0.4, scale: '10 cm',
      enter() { S.reset(); U.skinAlpha(0.7); I.outMat.emissiveIntensity = 0; },
      cam: [[0, [120, 110, 170], [0, 60, 0], 38], [4, [60, 88, 110], [0, 70, 0], 36], [15, iiCam.pos, iiCam.look, 36]],
      frame(t) {
        openDrum(span(t, 1.2, 3.6));
        I.outMat.emissiveIntensity = span(t, 11, 12) * 1.4;
        if (t > 3.8 && t < 6.6) api.mark(I.envelope, 'yellow', t);
        else if (t > 6.6 && t < 9.4) api.mark(I.csi, 'cyan', t);
        else if (t > 9.4 && t < 12) api.mark(boxLocal(api, I.g, [-13, 4, -13], [13, 26.5, 13]), 'yellow', t);
        else if (t >= 12) api.mark(boxLocal(api, I.g, [-4, 26, -4], [4, 39, 4]), 'lime', t);
      },
      caption: [
        { from: 1, to: 3.8, text: 'Open the drum on top of the C...' },
        { from: 3.8, to: 6.6, text: 'Inside, the <b>image intensifier</b>: a glass vacuum tube 23 cm across at its input, facing the patient.' },
        { from: 6.6, to: 9.4, text: 'At its input, behind a thin curved metal window, the <b>input phosphor</b> with the <b>photocathode</b> on it.' },
        { from: 9.4, to: 12, text: 'Along its length, ring-shaped <b>focusing electrodes</b> and the <b>anode</b>...' },
        { from: 12, to: 15, text: '...and at its far end the small <b>output phosphor</b>, watched by a camera.' },
      ],
    },
    {
      title: 'Input phosphor: x-rays to light', dur: 16, scale: (t) => (t < 1.6 ? '10 cm' : t < 2.6 ? '1 mm' : '100 µm'),
      enter() { setRest(); },
      cam: [[0, iiCam.pos, iiCam.look, 36], [2.6, [2.2, 59.5, 2.6], [2.2, 58.3, 0], 30]],
      cues: [[0.3, () => sfx.whoosh()], [5.0, () => sfx.blip(990)]],
      frame(t) {
        api.mosaic(span(t, 1.2, 2.6));
        if (t > 2.2) {
          px.alpha = span(t, 2.2, 2.8);
          const r = inputScene(t - 2.2, { rate: 8, hi: true, hiAt: 2.0, slow: 3.2 });
          px.alpha = 1;
          if (t > 11.5) api.mark([0, r.yTop - 5, px.W, 6], 'gold', t);
        }
      },
      caption: [
        { from: 2.8, to: 6.6, text: 'X-rays from the patient cross the window and are absorbed in the <b>caesium iodide</b> input phosphor: most of them, though some pass straight through.' },
        { from: 6.6, to: 11.5, text: 'Each absorbed x-ray gives a flash of <b>thousands of light photons</b>. CsI grows as packed needles that guide the light along them, not sideways: a sharp image.' },
        { from: 11.5, to: 16, text: 'The light reaches the <b>photocathode</b> on the needles’ tops.' },
      ],
    },
    {
      title: 'Photocathode: light to electrons', dur: 15, view: 'pixel', scale: '10 nm',
      cues: [[3.6, () => sfx.blip(1320)]],
      frame(t) {
        const r = cathodeScene(t + 3, { hi: true, hiAt: 4, slow: 3 });
        // the tally
        const w = 54, x = px.W - w - 4;
        panel(api, x, 4, w, 26);
        px.photon(x + 12, 13, 0, -1, 6, 'blue', 1, t * 20); px.text(String(r.nl), x + w - 4, 9, 'blue', 1, 1, 'right');
        electron(px, x + 12, 23, 1, 'cyan'); px.text(String(r.ne), x + w - 4, 21, 'cyan', 1, 1, 'right');
      },
      caption: [
        { from: 0.6, to: 5.2, text: 'The <b>photocathode</b>: a layer of antimony and caesium atoms only nanometres thick, the vacuum above it.' },
        { from: 5.2, to: 10, text: 'A light photon can give its energy to one of their electrons and free it into the vacuum: <b>photoemission</b>.' },
        { from: 10, to: 15, text: 'Only about one photon in ten does. So the electrons leaving each point follow the brightness of the light there: the image is now made of <b>electrons</b>.' },
      ],
    },
    {
      title: 'Focusing and acceleration', dur: 16, scale: '10 cm',
      enter() { setRest(); },
      cam: [[0, [12, 60, 18], [0, 60, 0], 34], [3, iiCam.pos, iiCam.look, 36], [16, [28, 76, 66], [0, 72, 0], 36]],
      cues: [[0.2, () => sfx.whoosh()], [10.5, () => sfx.zap()]],
      frame(t) {
        api.mosaic(1 - span(t, 0, 1.6));
        const kv = span(t, 10, 11.5);
        I.outMat.emissiveIntensity = 0.6 + kv;
        I.M.anode.emissive?.setRGB(0.25 * kv, 0.18 * kv, 0);
        sfx.hold('ii', 120 + 300 * kv, 0.02 + 0.02 * kv, 'sawtooth');
        drawElectrons(t, { dens: t > 5 && t < 10 ? 0.35 : 1, hi: t > 5 && t < 10 ? span(t, 5.3, 9.3, api.ease.linear) : null, P: 1.4 - 0.5 * kv });
        api.keepOut(boxLocal(api, I.g, [-12, 2, -12], [12, 28, 12]));          // the electrons' whole path
        if (t > 1.6 && t < 5) api.mark(I.electrodes[1], 'cyan', t);
        else if (t > 5 && t < 10) api.mark(boxLocal(api, I.g, [-2.5, 17.5, -2.5], [2.5, 23, 2.5]), 'yellow', t);
        else if (t >= 10) api.mark(I.anode, 'orange', t);
        if (t >= 10) hud(api, [['kV', '+' + Math.round(25 * kv), 'orange']]);
      },
      caption: [
        { from: 1.6, to: 5, text: 'The <b>focusing electrodes</b>, at rising positive voltages, pull the electrons up the tube and bend their paths in toward the axis.' },
        { from: 5, to: 10, text: 'They cross over at a focal point, so each lands on the opposite side: the image arrives at the output <b>inverted</b>.' },
        { from: 10, to: 16, text: 'The <b>anode</b>, 25 to 35 kV above the photocathode, accelerates them: each reaches the output phosphor with 25 to 35 keV.' },
      ],
    },
    {
      title: 'Output phosphor: electrons to light', dur: 15, scale: (t) => (t < 2 ? '1 cm' : '10 µm'),
      enter() { setRest(); I.outMat.emissiveIntensity = 1.6; },
      cam: [[0, iiCam.pos, iiCam.look, 36], [2.4, [0.6, 83.0, 2.4], [0.3, 83.2, 0], 30]],
      cues: [[0.3, () => sfx.whoosh()], [5.3, () => sfx.ping(1760)]],
      frame(t) {
        drawElectrons(t, { P: 0.9 });
        api.mosaic(span(t, 1.2, 2.5));
        if (t > 2.1) { px.alpha = span(t, 2.1, 2.7); outputScene(t - 2.1, { hi: true, hiAt: 2.2, slow: 3 }); px.alpha = 1; }
      },
      caption: [
        { from: 2.8, to: 7.4, text: 'The fast electrons strike the <b>output phosphor</b> (zinc cadmium sulfide) through a thin aluminium film that stops its light shining back at the photocathode.' },
        { from: 7.4, to: 15, text: 'Each electron’s energy comes out as a burst of light. In all the output phosphor gives off about 50 times the light the input phosphor made: the <b>flux gain</b>.' },
      ],
    },
    {
      title: 'Brightness gain', dur: 14, view: 'pixel', scale: '10 cm',
      cues: [[2.5, () => sfx.blip(660)], [6.5, () => sfx.blip(880)], [9, () => sfx.chime()]],
      frame(t) { gainScene(t); },
      caption: [
        { from: 0.6, to: 6.4, text: 'The 23 cm image is squeezed onto the 2.5 cm output: its light concentrated (23 ÷ 2.5)² ≈ 85 times, the <b>minification gain</b>.' },
        { from: 6.4, to: 14, text: 'Times the flux gain of about 50: a <b>brightness gain</b> of some 4,000. The output image is small, and thousands of times brighter than the input’s.' },
      ],
    },
    {
      title: 'Magnification modes', dur: 17, scale: '10 cm',
      enter() { setRest(); I.outMat.emissiveIntensity = 1.4; },
      cam: [[0, iiCam.pos, iiCam.look, 36], [17, [40, 70, 80], [0, 70, 0], 36]],
      cues: [[2, () => sfx.click()], [8, () => sfx.click()]],
      frame(t) {
        const rf = t < 2 ? II.R_IN : t < 8 ? lerp(II.R_IN, 7.5, span(t, 2, 3.5)) : t < 14 ? lerp(7.5, 5.5, span(t, 8, 9.5)) : lerp(5.5, II.R_IN, span(t, 14, 15.5));
        I.setFov(rf, 1);
        drawElectrons(t, { rf });
        api.keepOut(boxLocal(api, I.g, [-12, 2, -12], [12, 28, 12]));
        if (t > 2 && t < 8) api.mark(boxLocal(api, I.g, [-rf, yPC(rf) - 0.5, -rf], [rf, yPC(rf) + 0.5, rf]), 'yellow', t);
        // what the monitor shows: the same receptor field, a smaller part of the patient
        const fov = rf * 2, n = 72, sc = Math.max(1, Math.floor(Math.min(px.H * 0.5, px.W * 0.34) / n));
        const x = 6, y = 6;
        const lum = S.screenFrame('mag' + Math.round(rf * 10) + ':' + Math.floor(t * 15), { cx: L.IMG.W / 2, cy: 250, n, span: FIELD_PX * rf / II.R_IN, seed: 900 + Math.floor(t * 15) });
        panel(api, x - 2, y - 2, n * sc + 4, n * sc + 4);
        L.blit(px, lum, n, x, y, sc);
        hud(api, [['cm', String(Math.round(fov)), 'yellow'], ['dose', 'x' + ((II.R_IN / rf) ** 2).toFixed(1), 'orange']], { w: 54 });
      },
      caption: [
        { from: 2, to: 8, text: 'In a <b>magnification mode</b> the electrode voltages change: the crossover moves nearer the input and only its centre, 15 cm, then 11, fills the output.' },
        { from: 8, to: 17, text: 'The anatomy looks bigger and sharper. But less minification makes a dimmer output, so the dose rate goes up to keep it bright: about (23 ÷ 15)² ≈ 2.4 times.' },
      ],
    },
    {
      title: 'Distortion and vignetting', dur: 20, view: 'pixel', scale: '10 cm',
      cues: [[4, () => sfx.blip(520)], [8, () => sfx.blip(520)], [12, () => sfx.blip(520)], [16, () => sfx.blip(780)]],
      frame(t) {
        const pin = t < 16 ? span(t, 4, 6) : 0, vig = t < 16 ? span(t, 8, 10) : 0, s = t < 16 ? span(t, 12, 13.5) : 0, flat = t >= 16 ? 1 : 0;
        const g = gridScene(t, { pin, vig, s, flat, wob: t * 1.5 });
        if (t > 4 && t < 8) api.mark([g.cx + g.R * 0.55, g.cy + g.R * 0.45, g.R * 0.5, g.R * 0.5], 'yellow', t);
        if (t > 8 && t < 12) api.mark([g.cx - g.R, g.cy - g.R * 0.2, g.R * 0.35, g.R * 0.4], 'yellow', t);
        if (t > 12 && t < 16) api.mark([g.cx - g.R * 0.6, g.cy - g.R * 0.9, g.R * 1.2, g.R * 0.5], 'yellow', t);
        api.keepOut([g.cx - g.R, g.cy - g.R, g.R * 2, g.R * 2]);
      },
      caption: [
        { from: 0.6, to: 4, text: 'A test grid of straight wires, imaged through the intensifier.' },
        { from: 4, to: 8, text: 'The curved input is imaged onto the flat output: the edges are stretched, <b>pincushion distortion</b>.' },
        { from: 8, to: 12, text: 'The edges are dimmer too: <b>vignetting</b>, from the curved input and the electron optics.' },
        { from: 12, to: 16, text: 'Magnetic fields, even the Earth’s, bend the electrons’ paths: straight lines take an S shape that shifts as the C turns, <b>S-distortion</b>.' },
        { from: 16, to: 20, text: 'A <b>flat panel</b> has none of these: lines stay straight and the field uniform to its square corners.' },
      ],
    },
    {
      title: 'The camera', dur: 13, scale: '10 cm',
      enter() { setRest(); I.outMat.emissiveIntensity = 1.6; },
      cam: [[0, iiCam.pos, iiCam.look, 36], [4, [14, 92, 30], [0, 89, 0], 34], [13, [18, 94, 34], [0, 89, 0], 34]],
      frame(t) {
        drawElectrons(t, { dens: 0.5, P: 0.9 });
        // the light from the output phosphor through the lenses to the chip: a narrow cone of green
        const o = iiAt(II.Y_OUT), c = iiAt(32.7);
        for (let k = 0; k < 14; k++) {
          const rr = rng(k), ph = (t * 1.6 + rr()) % 1, a = rr() * 6.283, d = (rr() - 0.5) * 2;
          const p = [o[0] + Math.cos(a) * d * (1 - ph), lerp(o[1], c[1], ph), o[2] + Math.sin(a) * d * (1 - ph)];
          const [x, y, f] = api.toPx(p); if (f) px.px(x, y, 'lime', 0.9);
        }
        if (t > 1 && t < 6.5) api.mark(boxLocal(api, I.g, [-2.6, 28.4, -2.6], [2.6, 32.6, 2.6]), 'cyan', t);
        if (t >= 6.5) api.mark(boxLocal(api, I.g, [-4, 32.5, -5.3], [4, 38.7, 2.3]), 'yellow', t);
        api.keepOut(boxLocal(api, I.g, [-3, 26, -3], [3, 32.6, 3]));           // the light's path up to the chip
        // the camera's picture of the output: an image of the patient, turned the right way up
        if (t > 7) {
          const n = 64, sc = Math.max(1, Math.floor(Math.min(px.H * 0.45, px.W * 0.3) / n));
          const lum = S.screenFrame('cam' + Math.floor(t * 15), { cx: L.IMG.W / 2, cy: 250, n, seed: 1200 + Math.floor(t * 15) });
          panel(api, 4, 4, n * sc + 4, n * sc + 4);
          L.blit(px, lum, n, 6, 6, sc, { a: span(t, 7, 7.6) });
        }
      },
      caption: [
        { from: 1, to: 6.5, text: 'Lenses carry the small, bright output image up to a <b>video camera</b> on top of the tube.' },
        { from: 6.5, to: 13, text: 'Its <b>CCD</b> chip reads the image out frame by frame; the signal is digitised, the inversion undone, and the frames sent to the monitor cart.' },
      ],
    },
    {
      title: 'The flat-panel C-arm', dur: 14, scale: '10 cm',
      enter() { S.reset(); U.skinAlpha(0.8); },
      cam: [[0, [140, 90, 150], [0, 50, 0], 38], [14, [110, 110, 120], [0, 50, 0], 38]],
      cues: [[2, () => sfx.power()]],
      frame(t) {
        const k = span(t, 2, 4);
        U.parts.ii.visible = true; U.parts.fpd.visible = true;
        setOpacity(U.parts.ii, 1 - k); setOpacity(U.parts.fpd, k);
        U.setBeam({ a: 0.8, square: k > 0.5, R: k > 0.5 ? 11.5 : 11.5 });
        if (t > 4) api.mark(U.parts.fpd, 'cyan', t);
        const n = 64, sc = Math.max(1, Math.floor(Math.min(px.H * 0.45, px.W * 0.3) / n));
        const sq = k > 0.5;
        const lum = S.screenFrame((sq ? 'fpd' : 'iir') + Math.floor(t * 15), { cx: L.IMG.W / 2, cy: 250, n, seed: 1500 + Math.floor(t * 15), shape: sq ? () => true : null });
        panel(api, 4, 4, n * sc + 4, n * sc + 4);
        L.blit(px, lum, n, 6, 6, sc);
      },
      caption: [
        { from: 1, to: 7, text: 'Newer C-arms replace the whole intensifier with a <b>flat-panel detector</b>: caesium iodide on a grid of photodiodes, read out up to 30 times a second.' },
        { from: 7, to: 14, text: 'No distortion, no vignetting, and a square field uniform to its corners. The rest of fluoroscopy works the same.' },
      ],
    },
  ];
  return { title: 'The image intensifier', steps };
}
