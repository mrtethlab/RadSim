/* CT FILM, chapter 3: projections and reconstruction, all of it computed from the model's own
   upper-abdominal slice. Into the scan plane; photons across the slice, each ray thinned by the
   tissue it crosses; down among the atoms, Compton and photoelectric; one ray's line integral; a
   projection; the sinogram filling as the frame turns (a point's sine traced through it); the
   rays regrouped into parallel sets and back-projected; the star and the blur of the plain sum;
   the ramp kernel and the filtered profile; filtered back-projection building the slice; soft and
   sharp kernels on a noisy acquisition; iterative reconstruction of a low-dose one; then along z
   (zrecon.js): slices interpolated from the helix, and slice thickness against interval. */
import { atom, electron, keVColor } from '../../kit/micro.js';
import {
  muGrid, fanSinogram, parallelSinogram, noisySino, makeKernel, filterSino, filterRow, backproject, viewOrder, iterate,
  drawTissue, drawGrey, fanRay, rayProfile, muToHU, win,
} from './slice.js';
import { F, HALF, ZP } from './rig.js';
import { hud, box } from './kit.js';
import { zReconSteps } from './zrecon.js';

/* Everything computed once from the abdomen slice: its attenuation on a 128 grid, the fan
   sinogram (240 views over the turn, 128 channels), the parallel one (180 angles), its filtered
   versions, a noisy acquisition reconstructed with soft and sharp kernels, and a low-dose one
   reconstructed by FBP and by iteration. */
export function prepare(img) {
  const N = 128, G = muGrid(img.ax_abd, N);
  const Rpx = F / G.d;
  const fan = fanSinogram(G, Rpx, HALF, 240, 128);
  const NA = 180, par = parallelSinogram(G, NA);
  const K = { ramp: makeKernel('ramp', N), soft: makeKernel('soft', N), sharp: makeKernel('sharp', N) };
  const parF = filterSino(par, K.ramp);
  const order = viewOrder(NA);
  const all = Array.from({ length: NA }, (_, i) => i);
  const scaled = (a, s) => { for (let i = 0; i < a.length; i++) a[i] *= s; return a; };
  const parN = noisySino(par, 4e5, 11);
  const fbpSoft = scaled(backproject(filterSino(parN, K.soft), N, all), Math.PI / (NA * G.d));
  const fbpSharp = scaled(backproject(filterSino(parN, K.sharp), N, all), Math.PI / (NA * G.d));
  // a low-dose acquisition: a quarter of the photons, 120 angles
  const NA2 = 120, par2 = parallelSinogram(G, NA2), low = noisySino(par2, 1e5, 21);
  const fbpLow = scaled(backproject(filterSino(low, K.soft), N, Array.from({ length: NA2 }, (_, i) => i)), Math.PI / (NA2 * G.d));
  const ir = iterate(low, N, G.d, fbpLow, 8);
  // the noise (HU, standard deviation) in a patch of uniform tissue, iteration by iteration
  const patch = (() => { for (let r = 30; r < 100; r += 2) for (let c = 16; c < 110; c += 2) {
    let a = 0, b = 0; for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) { const v = G.mu[(r + i) * N + c + j]; a += v; b += v * v; }
    if (a / 64 > 0.15 && b / 64 - (a / 64) ** 2 < 1e-10) return [r, c]; } return [60, 40]; })();
  const sd = (x) => { let a = 0, b = 0; for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) { const v = 1000 * (x[(patch[0] + i) * N + patch[1] + j] / G.mu[patch[0] * N + patch[1]] - 1); a += v; b += v * v; } return Math.sqrt(Math.max(0, b / 64 - (a / 64) ** 2)); };
  ir.noise = ir.images.map(sd); ir.patch = patch;
  // back-projections of the first n views (in `order`), plain or filtered, kept for the last n
  const cache = { plain: { n: 0, img: new Float32Array(N * N) }, filt: { n: 0, img: new Float32Array(N * N) } };
  const bpUpTo = (n, filtered) => {
    const c = cache[filtered ? 'filt' : 'plain'], S = filtered ? parF : par;
    n = Math.max(0, Math.min(NA, Math.floor(n)));
    if (n < c.n) { c.img.fill(0); c.n = 0; }
    if (n > c.n) { backproject(S, N, order.slice(c.n, n), c.img); c.n = n; }
    return c.img;
  };
  // where things are on the grid: the vertebral body (bone near the midline, posterior) and the aorta
  const centroid = (test) => {
    const { w, h, ids } = img.ax_abd, side = Math.max(w, h), oy = (side - h) / 2, ox = (side - w) / 2;
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (test(ids[y * w + x], x, y)) { sx += x; sy += y; n++; }
    return n ? [(sx / n + ox + 0.5) * N / side, (sy / n + oy + 0.5) * N / side] : [N / 2, N / 2];
  };
  const W0 = img.ax_abd.w, H0 = img.ax_abd.h;
  const spine = centroid((id, x, y) => (id === 17 || id === 18) && Math.abs(x - W0 / 2) < W0 * 0.07 && y > H0 * 0.55 && y < H0 * 0.78);
  const aorta = centroid((id) => id === 29), spleen = centroid((id) => id === 12);
  return { N, G, Rpx, fan, NA, par, parF, K, order, fbpSoft, fbpSharp, NA2, low, fbpLow, ir, bpUpTo, spine, aorta, spleen };
}

export function reconstruction(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const R = S.R, G = R.G, N = R.N, img = S.img.ax_abd;
  const side = Math.max(img.w, img.h), gf = side / N, goy = (side - img.h) / 2, gox = (side - img.w) / 2;
  /* The slice on the 8-bit layer at (ix, iy), s px per image pixel; grid <-> screen. */
  const view = (ix, iy, s) => ({
    ix, iy, s, w: img.w * s, h: img.h * s,
    g2s: (c, r) => [ix + (c * gf - gox) * s, iy + (r * gf - goy) * s],
    s2g: (X, Y) => [((X - ix) / s + gox) / gf, ((Y - iy) / s + goy) / gf],
  });
  // where a ray (grid coords, A to B) crosses the screen rows y0 and y1
  const rayAtY = (V, ray, Y) => {
    const [ax, ay] = V.g2s(ray[0], ray[1]), [bx, by] = V.g2s(ray[2], ray[3]);
    const k = (Y - ay) / (by - ay);
    return [ax + (bx - ax) * k, Y];
  };
  const muOf = (c, r) => { const cc = Math.floor(c), rr = Math.floor(r); return cc >= 0 && rr >= 0 && cc < N && rr < N ? G.mu[rr * N + cc] : 0; };
  // the image's material id under a grid point (for what a photon met)
  const idAt = (c, r) => {
    const X = Math.floor(c * gf - gox), Y = Math.floor(r * gf - goy);
    return X >= 0 && Y >= 0 && X < img.w && Y < img.h ? img.ids[Y * img.w + X] : 0;
  };

  // ---------------------------------------------------------------- the fan across the slice (8-bit)
  // per channel (64 of the 128) at the tube's top position: the ray, its running integral
  const NCH = 64;
  const chans = Array.from({ length: NCH }, (_, j) => {
    const c = j * 2 + 1, g = -HALF + (c + 0.5) / 128 * 2 * HALF;
    const ray = fanRay(G, R.Rpx, 0, g);
    const prof = rayProfile(G, ray[0], ray[1], ray[2], ray[3], 400);
    return { c, g, ray, prof, p: prof.cum[prof.cum.length - 1] };
  });
  /* Photons down the fan from the top edge to the detector row: transmitted with e^-p; the others
     interact where their ray's running integral says, Compton (scattered off at an angle) or
     photoelectric (gone), by the tissue there. Only the last flight time's are walked. */
  function fanScene(t, V, { rate = 150, yDet, focusCh = -1, slowFocus = false, alpha = 1 } = {}) {
    const v = 150, top = -4, life = (yDet - top) / v + 0.6;
    const counts = new Float32Array(NCH);
    for (let k = Math.max(0, Math.ceil((t - life) * rate)); k <= Math.floor(t * rate); k++) {
      const r = rng(31000 + k), age = t - k / rate;
      const j = Math.floor(r() * NCH), ch = chans[j];
      const [x0] = rayAtY(V, ch.ray, top), [x1] = rayAtY(V, ch.ray, yDet);
      const L = yDet - top, y = top + age * v;
      // its fate
      const U = r(), interacts = U > Math.exp(-ch.p);
      let yHit = Infinity, kind = 'through';
      if (interacts) {
        const target = -Math.log(1 - r() * (1 - Math.exp(-ch.p)));
        let i = 0; while (i < ch.prof.cum.length - 1 && ch.prof.cum[i] < target) i++;
        const f = (i + 0.5) / ch.prof.cum.length;
        const gc = ch.ray[0] + (ch.ray[2] - ch.ray[0]) * f, gr = ch.ray[1] + (ch.ray[3] - ch.ray[1]) * f;
        yHit = V.g2s(gc, gr)[1];
        const id = idAt(gc, gr), bone = id === 17 || id === 18;
        kind = r() < (bone ? 0.12 : 0.04) ? 'pe' : 'compton';
      }
      const E = 50 + r() * 50;
      const xAt = (yy) => x0 + (x1 - x0) * (yy - top) / L;
      if (y < Math.min(yHit, yDet)) { px.photon(xAt(y), y, (x1 - x0) / L, 1, 4, keVColor(E), alpha * (j === focusCh ? 1 : 0.85), t * 25 + k); continue; }
      if (yHit < yDet) {
        const e = (y - yHit) / v;
        if (kind === 'pe') { if (e < 0.15) px.rect(xAt(yHit) - 1, yHit - 1, 3, 3, 'white', alpha); }
        else {
          // scattered: off at an angle, a little redder
          const ang = (r() - 0.5) * 2.4 + (r() < 0.2 ? Math.PI : 0), sx = Math.sin(ang), sy = Math.cos(ang);
          const X = xAt(yHit) + sx * e * v, Y = yHit + sy * e * v;
          if (e < 0.1) px.px(xAt(yHit), yHit, 'orange', alpha);
          if (k % 2 === 0 && Y < yDet && Y > -4 && X > -4 && X < px.W + 4) px.photon(X, Y, sx, sy, 3, keVColor(E * 0.8), 0.5 * alpha, t * 25 + k);
        }
        continue;
      }
      if (y - yDet < 0.12 * v) { counts[j] += 1; px.rect(xAt(yDet) - 1, yDet - 1, 2, 2, 'white', 0.8 * alpha); }
    }
    // the detector row: each channel's expected share of the photons (e^-p), lit as it reads
    for (let j = 0; j < NCH; j++) {
      const ch = chans[j], [xa] = rayAtY(V, ch.ray, yDet), [xb] = rayAtY(V, chans[Math.min(NCH - 1, j + 1)].ray, yDet);
      const wv = Math.max(1, Math.round(Math.abs(xb - xa)));
      const I = Math.exp(-ch.p), g = Math.round(30 + 225 * Math.sqrt(I));
      px.rect(xa, yDet, wv, 5, `rgb(${g},${g},${Math.min(255, g + 30)})`, alpha);
      if (counts[j]) px.rect(xa, yDet, wv, 5, 'white', 0.4 * alpha);
    }
    return chans;
  }

  // ---------------------------------------------------------------- among the atoms (8-bit)
  // soft tissue (H, C, O) on the left, bone (Ca, P, O) on the right; photons down from the top
  const atomField = (() => {
    const r = rng(808), list = [];
    for (let y = 22; y < 196; y += 17) for (let x = 6 + ((y / 17) % 2) * 8; x < 400; x += 17) {
      const jx = x + (r() - 0.5) * 6, jy = y + (r() - 0.5) * 6, u = r();
      list.push({ x: jx, y: jy, u, s: r() });
    }
    return list;
  })();
  function atomsScene(t, P = 13) {
    px.fillAll('ink');
    const W = px.W, mid = Math.round(W * 0.52);
    px.rect(mid, 0, W - mid, px.H, 'bone', 0.06);
    const ft = t % P;
    const kindOf = (a) => (a.x > mid ? (a.u < 0.22 ? 'Ca' : a.u < 0.36 ? 'P' : a.u < 0.7 ? 'O' : 'H') : (a.u < 0.25 ? 'C' : a.u < 0.5 ? 'O' : 'H'));
    const nearest = (x, y, ok) => { let b = null, bd = Infinity; for (const a of atomField) { if (a.x > W - 10 || !ok(a)) continue; const d = Math.hypot(a.x - x, a.y - y); if (d < bd) { bd = d; b = a; } } return b; };
    const aC = nearest(W * 0.27, 92, (a) => a.x < mid - 10 && kindOf(a) === 'O'), aP = nearest(W * 0.75, 92, (a) => a.x > mid + 10 && kindOf(a) === 'Ca');
    const fC = { at: 2.0, x: aC.x, y: aC.y, slow: 3, a: aC }, fP = { at: 7.2, x: aP.x, y: aP.y, slow: 3, a: aP };
    const focusOn = (ft > fC.at && ft < fC.at + 5) || (ft > fP.at && ft < fP.at + 5);
    const dim = focusOn ? 0.4 : 1;
    // the atoms
    for (const a of atomField) {
      if (a.x > W - 4) continue;
      const bone = a.x > mid, kind = kindOf(a);
      const isF = (a === aC && ft > fC.at && ft < fC.at + 5) || (a === aP && ft > fP.at && ft < fP.at + 5);
      const al = isF ? 1 : dim;
      if (kind === 'H') { px.rect(a.x - 1, a.y - 1, 2, 2, 'grey', 0.6 * al); px.px(a.x + 2, a.y, 'blue', 0.7 * al); continue; }
      const shells = kind === 'Ca' ? [2, 8, 8, 2] : kind === 'P' ? [2, 8, 5] : kind === 'O' ? [2, 6] : [2, 4];
      const rad = kind === 'Ca' ? 7 : kind === 'P' ? 6 : 4;
      atom(px, a.x, a.y, rad, t, { shells, seed: Math.floor(a.s * 50), ring: bone ? 'brown' : 'plum', e: 'blue', nucleus: kind === 'Ca' ? 'gold' : 'orange', a: al,
        missing: a === aP && ft > fP.at + 0.9 && ft < fP.at + 4 ? 0 : -1 });
    }
    // background photons: most pass straight through
    const rate = 9, v = 120;
    for (let k = Math.max(0, Math.ceil((t - 2.2) * rate)); k <= Math.floor(t * rate); k++) {
      const r = rng(9100 + k), age = t - k / rate, x = 4 + r() * (W - 8), y = -6 + age * v;
      const bone = x > mid, roll = r();
      const kind = roll < 0.07 ? 'compton' : (bone && roll < 0.1) ? 'pe' : 'through';
      const yHit = 30 + r() * 140;
      if (kind === 'through' || y < yHit) { if (y < px.H + 6) px.photon(x, y, 0, 1, 5, 'cyan', 0.8 * dim, t * 30 + k); continue; }
      const e = (y - yHit) / v;
      if (kind === 'pe') { if (e < 0.6) electron(px, x + e * 40, yHit - e * 20, (1 - e / 0.6) * dim, 'cyan'); continue; }
      const ang = (r() - 0.5) * 2.2, L = e * v;
      if (e < 0.6) electron(px, x - Math.sin(ang) * e * 30, yHit + e * 10, (1 - e / 0.6) * 0.8 * dim, 'cyan');
      px.photon(x + Math.sin(ang) * L, yHit + Math.cos(ang) * L, Math.sin(ang), Math.cos(ang), 5, 'lime', 0.8 * dim, t * 30 + k);
    }
    // the focus events, slowed: Compton in soft tissue, photoelectric in a calcium atom
    const ev = (f, kind) => {
      const yA = f.y, age = (ft - f.at) / f.slow;
      if (age < 0 || ft > f.at + 5) return;
      const tIn = (yA + 6) / v;
      if (age < tIn) {
        px.photon(f.x, -6 + age * v, 0, 1, 9, 'cyan', 1, t * 30);
        api.keepOut(kind === 'compton' ? [f.x - 45, yA - 16, 120, 100] : [f.x - 35, yA - 65, 80, 85]);
        api.mark([f.x - 7, -6 + age * v - 7, 14, 14], 'yellow', t, { live: true }); return;
      }
      const e = age - tIn;
      if (e < 0.15) px.glow(f.x, yA, 6, 'white', 1, 3);
      if (kind === 'compton') {
        // an outer electron knocked out; the photon goes on at an angle with less energy
        const ang = 0.7, L = e * v;
        electron(px, f.x - e * 34, yA + e * 8, Math.max(0, 1 - e / 1.2), 'cyan');
        if (L < 140) px.photon(f.x + Math.sin(ang) * L, yA + Math.cos(ang) * L, Math.sin(ang), Math.cos(ang), 9, 'lime', 1, t * 30);
        api.mark([f.x - 12, yA - 12, 24, 24], 'yellow', t);
        api.keepOut([f.x - 45, yA - 16, 120, 100]);
      } else {
        // the whole photon taken by a K electron, which leaves; an outer electron drops into the hole
        electron(px, f.x + e * 36, yA - e * 26, Math.max(0, 1 - e / 1.4), 'cyan');
        const drop = clamp01((e - 0.6) / 0.5);
        if (drop > 0 && drop < 1) px.rect(lerp(f.x + 6, f.x + 2, drop) - 1, lerp(yA - 5, yA, drop) - 1, 3, 3, 'yellow');
        api.mark([f.x - 12, yA - 12, 24, 24], 'yellow', t);
        api.keepOut([f.x - 35, yA - 65, 80, 85]);
      }
    };
    ev(fC, 'compton'); ev(fP, 'pe');
  }

  // ---------------------------------------------------------------- drawing reconstructions
  // a grid image (N x N) as greys, normalised (auto) or through an HU window
  function drawRecon(a, x, y, s, { L = null, W = null, crop = null, lo = null, hi = null } = {}) {
    const [c0, r0, cw, ch] = crop || [0, 0, N, N];
    let mn = lo, mx = hi;
    if (L == null && (mn == null || mx == null)) {
      mn = Infinity; mx = -Infinity;
      for (let r = r0; r < r0 + ch; r++) for (let c = c0; c < c0 + cw; c++) { const v = a[r * N + c]; if (v < mn) mn = v; if (v > mx) mx = v; }
    }
    drawGrey(px, cw, ch, x, y, s, (i) => {
      const v = a[(r0 + Math.floor(i / cw)) * N + c0 + (i % cw)];
      return L != null ? win(muToHU(v), L, W) : (v - mn) / (mx - mn || 1);
    });
    return [x, y, cw * s, ch * s];
  }
  // a profile curve in a box
  function curve(vals, x, y, w, h, { c = 'yellow', lo = null, hi = null, upTo = 1, zero = false } = {}) {
    let mn = lo ?? Math.min(...vals), mx = hi ?? Math.max(...vals);
    if (mx - mn < 1e-9) mx = mn + 1;
    const Y = (v) => y + h - 1 - (v - mn) / (mx - mn) * (h - 2);
    if (zero) px.rect(x, Y(0), w, 1, 'dkgrey');
    let lx = null, ly = null;
    const n = vals.length;
    for (let i = 0; i < Math.floor(n * upTo); i++) {
      const X = x + (i / (n - 1)) * (w - 1), yy = Y(vals[i]);
      if (lx != null) px.line(lx, ly, X, yy, c);
      lx = X; ly = yy;
    }
  }

  // ---------------------------------------------------------------- the steps
  const steps = [];
  const sliceCouch = () => S.setCouch(S.couchForMeshZ(-23), 0);
  steps.push({
    title: 'Into the scan plane', dur: 6.5, scale: (t) => (t < 3 ? '10 cm' : '1 cm'),
    enter() { S.view({ inside: true, shell: 0, patient: true, injector: false, skin: 0.3 }); S.rig.couch.visible = S.rig.couchBase.visible = true; sliceCouch(); S.setAngle(0); S.setBeam(4, true); },
    cam: [[0, [30, 40, 190], [0, 6, ZP], 38], [3, [0, 6, 70], [0, 6, ZP], 34], [6.5, [0, 6, 18], [0, 6, ZP], 30]],
    cues: [[0.3, () => sfx.whoosh()]],
    frame(t) {
      api.mosaic(span(t, 2.6, 5.6));
      if (t > 4.8) {
        px.alpha = span(t, 4.8, 6.3);
        px.fillAll('ink');
        const V = mainView();
        drawTissue(px, img, V.ix, V.iy, V.s);
        px.alpha = 1;
      }
    },
  });
  // the slice as it sits in the next steps
  const mainView = () => { const s = 0.82; return view(Math.round(px.W / 2 - img.w * s / 2), 22, s); };
  steps.push({
    title: 'Photons through the body', dur: 13, view: 'pixel', scale: '10 cm',
    frame(t) {
      px.fillAll('ink');
      const V = mainView(), yDet = Math.round(V.iy + V.h + 10);
      drawTissue(px, img, V.ix, V.iy, V.s);
      fanLines(V, 0, 8, 0.12);
      fanScene(t, V, { rate: 120, yDet });
      api.keepOut([0, yDet - 2, px.W, 9]);
      if (t > 6) {
        // behind the spine few get through; at the side, through little but fat, many
        let lo = 0, hi = 0;
        chans.forEach((c, j) => { if (c.p > chans[lo].p) lo = j; });
        while (hi < NCH / 2 && chans[hi].p < 1.2) hi++;
        const at = (j) => { const [x] = rayAtY(V, chans[j].ray, yDet); return [x - 5, yDet - 4, 12, 12]; };
        api.mark(at(hi), 'cyan', t);
        api.mark(at(lo), 'yellow', t);
      }
    },
    caption: [
      { from: 0.8, to: 6, text: 'In the scan plane the fan’s photons cross the slice on straight lines, each ray through its own mix of tissue.' },
      { from: 6, to: 13, text: 'Behind the spine few get through; past the side, through little but fat, many. The detector counts what each ray lets pass.' },
    ],
  });
  steps.push({
    title: 'Among the atoms', dur: 13, view: 'pixel', scale: (t) => (t < 0.8 ? '1 cm' : t < 1.6 ? '1 mm' : '100 pm'),
    cues: [[2.9, () => sfx.pew(1300)], [8.1, () => sfx.zap()]],
    frame(t) {
      if (t < 2.2) {
        // the zoom down, on the front edge of the vertebral body
        px.fillAll('ink');
        const z = Math.exp(lerp(Math.log(0.95), Math.log(14), span(t, 0, 2, api.ease.in)));
        const [sc, sr] = R.spine, gc = sc, gr = sr - 7;
        const ax = (gc * gf - gox), ay = (gr * gf - goy);           // image px of the focus point
        drawTissue(px, img, px.W / 2 - ax * z, px.H / 2 - ay * z, z);
        px.alpha = span(t, 1.6, 2.2);
        if (px.alpha > 0) atomsScene(t);
        px.alpha = 1;
        return;
      }
      atomsScene(t);
    },
    caption: [
      { from: 2.2, to: 7, text: 'Among the atoms, at CT’s energies (around 70 keV) the commonest event is <b>Compton scatter</b> off a loosely bound outer electron: it depends on the tissue’s electron density.' },
      { from: 7, to: 13, text: 'In bone, calcium’s inner electrons add the <b>photoelectric effect</b>: the photon absorbed outright. Together they set each tissue’s <b>μ</b>, the share of photons it removes per centimetre.' },
    ],
  });
  // one ray down the middle: through the abdomen, the aorta's edge, the vertebral body, the canal
  const mid = chans[NCH / 2];
  steps.push({
    title: 'One ray, one sum', dur: 12, view: 'pixel', scale: '10 cm',
    frame(t) {
      px.fillAll('ink');
      const s = 0.64, V = view(6, 22, s), yDet = Math.round(V.iy + V.h + 10);
      drawTissue(px, img, V.ix, V.iy, V.s, { dim: 0.55 });
      // the ray, from the top edge to the detector
      const [xa] = rayAtY(V, mid.ray, 2), [xb] = rayAtY(V, mid.ray, yDet);
      px.line(xa, 2, xb, yDet, 'yellow', 0.8);
      px.rect(xb - 3, yDet, 7, 5, 'grey');
      // mu along it, as bars beside the slice at the same depth, filled down to the photon
      const prof = mid.prof, n = prof.mu.length;
      const g2y = (f) => V.g2s(mid.ray[0] + (mid.ray[2] - mid.ray[0]) * f, mid.ray[1] + (mid.ray[3] - mid.ray[1]) * f)[1];
      const bx = Math.round(V.ix + V.w + 12), bw = px.W - bx - 8;
      box(api, bx - 3, V.iy - 3, bw + 6, V.h + 6);
      const prog = span(t, 1, 7, api.ease.linear);
      let yPhoton = lerp(V.iy, V.iy + V.h, prog), sum = 0;
      for (let i = 0; i < n; i++) {
        const f = (i + 0.5) / n, y = g2y(f);
        if (y < V.iy || y > V.iy + V.h) continue;
        const m = prof.mu[i], len = Math.round(Math.min(1, m / 0.45) * bw);
        const done = y <= yPhoton;
        px.rect(bx, y, len, 1, m > 0.25 ? 'bone' : m > 0.186 ? 'pink' : m > 0.05 ? 'fat' : 'navy', done ? 0.95 : 0.25);
        if (done) sum = prof.cum[i];
      }
      px.text('µ', bx + bw - 2, V.iy + 1, 'mid', 1, 1, 'right');
      // photons down the ray: each taken at a depth by its running integral
      for (let k = Math.max(0, Math.ceil((t - 2) * 10)); k <= Math.floor(t * 10); k++) {
        const r = rng(5500 + k), age = t - k / 10, y = 2 + age * 110;
        const target = -Math.log(Math.max(1e-6, r()));
        let i = 0; while (i < n - 1 && prof.cum[i] < target) i++;
        const yEnd = target > prof.cum[n - 1] ? yDet : g2y((i + 0.5) / n);
        const x = xa + (xb - xa) * (y - 2) / (yDet - 2);
        if (y < yEnd) px.photon(x, y, 0, 1, 4, 'cyan', 0.9, t * 30 + k);
        else if (y - yEnd < 10) px.rect(xa + (xb - xa) * (yEnd - 2) / (yDet - 2) - 1, yEnd - 1, 3, 3, yEnd >= yDet ? 'white' : 'orange', 0.8);
      }
      // the photon whose sum we follow
      const xp = xa + (xb - xa) * (yPhoton - 2) / (yDet - 2);
      if (prog < 1) px.rect(xp - 1, yPhoton - 1, 3, 3, 'yellow');
      hud(api, [['µx', sum.toFixed(2), 'yellow'], ['I/I0', Math.exp(-sum).toPrecision(2), 'cyan']], { x: bx - 3, y: V.iy + V.h + 8, w: 56 });
      api.keepOut([xa - 4, 0, 8, yDet + 6]);
      if (t > 1 && t < 6.5) api.mark([xp - 6, yPhoton - 6, 12, 12], 'yellow', t, { live: true });
      if (t > 6.5) api.mark([bx - 3, V.iy - 3, bw + 6, V.h + 6], 'yellow', t);
    },
    caption: [
      { from: 1, to: 6.5, text: 'Along one ray every bit of tissue takes its share, by its own <b>μ</b>: I = I₀·e<sup>−Σμx</sup>.' },
      { from: 6.5, to: 12, text: 'So −ln(I/I₀) is the sum of μ along the ray, its <b>line integral</b>: one number from each detector reading.', place: 'below' },
    ],
  });
  // the fan's rays and the projection at an angle (fan sinogram row nearest)
  const fanRow = (th) => { const NV = R.fan.NV, v = ((Math.round(th / (Math.PI * 2) * NV) % NV) + NV) % NV; return Array.from(R.fan.p.subarray(v * 128, v * 128 + 128)); };
  const fanLines = (V, th, every = 8, a = 0.25) => {
    for (let c = 0; c < 128; c += every) {
      const g = -HALF + (c + 0.5) / 128 * 2 * HALF, [ax, ay, bx, by] = fanRay(G, R.Rpx, th, g);
      const A = V.g2s(ax, ay), B = V.g2s(bx, by);
      px.line(A[0], A[1], B[0], B[1], 'violet', a);
    }
  };
  const sourceDot = (V, th) => {
    const sx = N / 2 - R.Rpx * Math.sin(th), sy = N / 2 - R.Rpx * Math.cos(th);
    const [X, Y] = V.g2s(sx, sy);
    return [X, Y];
  };
  steps.push({
    title: 'A projection', dur: 12, view: 'pixel', scale: '10 cm',
    frame(t) {
      px.fillAll('ink');
      const s = 0.62, V = view(Math.round(px.W / 2 - img.w * s / 2), 26, s);
      const th = t < 6 ? 0 : (t - 6) * 0.35;
      drawTissue(px, img, V.ix, V.iy, V.s, { dim: 0.8 });
      fanLines(V, th, 6, 0.25);
      // the source off the screen: an arrow at the edge pointing in toward it
      const [sx, sy] = sourceDot(V, th), cx = V.ix + V.w / 2, cy = V.iy + V.h / 2;
      const k = Math.min(1, Math.min((cx - 4) / Math.abs(sx - cx + 1e-6), (cy - 4) / Math.abs(sy - cy + 1e-6)));
      px.glow(cx + (sx - cx) * k, cy + (sy - cy) * k, 4, 'yellow', 1, 1);
      const bx = 10, by = 140, bw = px.W - 20, bh = 54;
      box(api, bx, by, bw, bh);
      curve(fanRow(th), bx + 3, by + 3, bw - 6, bh - 6, { lo: 0, hi: 9 });
      px.text('ch', bx + bw - 3, by + bh - 7, 'mid', 1, 1, 'right');
      if (t > 1) api.mark([bx, by, bw, bh], 'yellow', t);
    },
    caption: [
      { from: 0.8, to: 6, text: 'Every element’s reading across the fan, side by side: one <b>projection</b>, the slice’s attenuation seen from one angle.', place: 'above' },
      { from: 6, to: 12, text: 'As the frame turns, each new angle gives a different projection: about a thousand a rotation.', place: 'above' },
    ],
  });
  steps.push({
    title: 'The sinogram', dur: 14, view: 'pixel', scale: '10 cm',
    cues: Array.from({ length: 24 }, (_, k) => [0.5 + k * 0.5, () => sfx.tick()]),
    frame(t) {
      px.fillAll('ink');
      const s = 0.5, V = view(8, 50, s);
      const k = span(t, 0.5, 12.5, api.ease.linear), th = k * Math.PI * 2, NV = R.fan.NV, rows = Math.floor(k * NV);
      drawTissue(px, img, V.ix, V.iy, V.s, { dim: 0.8 });
      fanLines(V, th, 10, 0.3);
      // the sinogram: one row per view, top to bottom
      const sh = px.H - 12, sc = sh / NV, sw = Math.round(128 * sc), sx0 = px.W - sw - 10, sy0 = 6;
      box(api, sx0 - 2, sy0 - 2, sw + 4, sh + 4, 0.95);
      drawGrey(px, 128, NV, sx0, sy0, 1, (i) => (Math.floor(i / 128) < rows ? R.fan.p[i] / 9 : 0), { scaleXY: [sw / 128, sc] });
      if (rows < NV) px.rect(sx0, sy0 + rows * sc, sw, 1, 'yellow', 0.8);
      // the aorta: its channel at each view traces a wave
      const [pa, pr] = R.spleen;
      const [ax, ay] = V.g2s(pa, pr);
      if (t > 6.5) {
        for (let v = 0; v < rows; v += 2) {
          const th2 = (v / NV) * Math.PI * 2, sxg = N / 2 - R.Rpx * Math.sin(th2), syg = N / 2 - R.Rpx * Math.cos(th2);
          let g = Math.atan2(pr - syg, pa - sxg) - Math.atan2(N / 2 - syg, N / 2 - sxg);
          g = Math.atan2(Math.sin(g), Math.cos(g));
          const c = (g + HALF) / (2 * HALF) * 128;
          px.rect(sx0 + c * sw / 128 - 1, sy0 + v * sc, 2, 1, 'red', 0.95);
        }
        api.mark([ax - 4, ay - 4, 8, 8], 'red', t);
      }
      api.keepOut([V.ix, V.iy, V.w, V.h]);
      if (t > 0.8 && t < 6.5) api.mark([sx0 - 2, sy0 - 2, sw + 4, sh + 4], 'yellow', t);
    },
    caption: [
      { from: 0.8, to: 6.5, text: 'Stacked view under view, the projections make the <b>sinogram</b>: the raw data of one slice.' },
      { from: 6.5, to: 14, text: 'Each point in the slice draws a sine-shaped wave through it as the tube goes round, here the spleen: hence the name.' },
    ],
  });

  // ---- back-projection
  const singles = [0, 90, 45, 135].map((a) => backproject(R.par, N, [a]));
  const order4 = [0, 90, 45, 135];
  const parProfile = (a) => Array.from(R.par.p.subarray(a * N, a * N + N));
  steps.push({
    title: 'Back-projection', dur: 13, view: 'pixel', scale: '10 cm',
    frame(t) {
      px.fillAll('ink');
      const s = 1.05, size = N * s, x0 = Math.round(px.W / 2 - size / 2) + 24, y0 = Math.round((px.H - size) / 2) + 2;
      if (t < 4.5) {
        // the fan's rays regrouped: parallel lines across the slice at one angle
        const V = view(x0 + (size - img.w * s * N / side) / 2, y0 + (size - img.h * s * N / side) / 2, s * N / side);
        drawTissue(px, img, V.ix, V.iy, V.s, { dim: 0.7 });
        const k = span(t, 0.6, 2.4);
        for (let c = 2; c < N; c += 6) {
          const [X0, Y0] = V.g2s(c, 0), [X1, Y1] = V.g2s(c, N);
          px.line(X0, Y0, X1, Y1, 'violet', 0.5 * k);
        }
        api.mark([x0, y0, size, size], 'violet', t);
        return;
      }
      // views added in turn; each new one smeared across from its own edge
      const tt = t - 4.5, n = Math.min(4, 1 + Math.floor(tt / 2)), sweep = clamp01((tt - (n - 1) * 2) / 1.2);
      const ph = (order4[n - 1] / R.NA) * Math.PI, dx = Math.sin(ph), dy = Math.cos(ph);
      const acc = new Float32Array(N * N);
      for (let i = 0; i < n - 1; i++) for (let p = 0; p < acc.length; p++) acc[p] += singles[i][p];
      const cur = singles[n - 1];
      let mx = 0;
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        const along = ((c - N / 2) * dx + (r - N / 2) * dy) / N + 0.5;   // 0 at the entry edge
        const p = r * N + c;
        if (along <= sweep) acc[p] += cur[p];
        if (acc[p] > mx) mx = acc[p];
      }
      drawRecon(acc, x0, y0, s, { lo: 0, hi: mx || 1 });
      px.frame(x0 - 1, y0 - 1, size + 2, size + 2, 'dkgrey');
      // this view's profile, drawn along the edge the smear starts from
      const prof = parProfile(order4[n - 1]), pm = Math.max(...prof);
      const ux = Math.cos(ph), uy = -Math.sin(ph), cx = x0 + size / 2, cy = y0 + size / 2;
      for (let b = 0; b < N; b += 1) {
        const u = (b + 0.5 - N / 2) * s, h = prof[b] / pm * 16;
        const ex = cx + ux * u - dx * (size / 2 + 3), ey = cy + uy * u - dy * (size / 2 + 3);
        px.rect(ex - dx * h, ey - dy * h, 1, 1, 'yellow');
      }
      api.keepOut([x0 - 20, y0 - 20, size + 40, size + 40]);
      api.mark([x0, y0, size, size], 'yellow', t);
    },
    cues: [[4.5, () => sfx.whoosh()], [6.5, () => sfx.whoosh()], [8.5, () => sfx.whoosh()], [10.5, () => sfx.whoosh()]],
    caption: [
      { from: 0.8, to: 4.5, text: 'For reconstruction the fan’s rays are first regrouped into sets of <b>parallel</b> rays, one set per angle.', place: 'left' },
      { from: 4.5, to: 13, text: 'Each projection is smeared back across the image along the rays it came from: <b>back-projection</b>. Where smears from different angles cross, the slice begins to show.', place: 'left' },
    ],
  });
  const nAt = (t, sched) => { let n = sched[0][1]; for (const [tt, v] of sched) if (t >= tt) n = v; return n; };
  const SCHED = [[0, 2], [2, 4], [4, 8], [6, 16], [8, 32], [9.5, 64], [11, 180]];
  // a single dense point (a small calcification, say) beside the spine: its projections are spikes
  const pointSino = (() => {
    const p = new Float32Array(R.NA * N), [pc, pr] = [R.spine[0] + 22, R.spine[1] - 26];
    for (let a = 0; a < R.NA; a++) {
      const ph = (a / R.NA) * Math.PI, u0 = (pc + 0.5 - N / 2) * Math.cos(ph) + (pr + 0.5 - N / 2) * -Math.sin(ph) + N / 2 - 0.5;
      for (let b = 0; b < N; b++) p[a * N + b] = Math.exp(-(((b - u0) / 0.8) ** 2));
    }
    return { NA: R.NA, NB: N, p, at: [pc, pr] };
  })();
  const ptCache = { n: 0, img: new Float32Array(N * N) };
  const pointUpTo = (n) => {
    if (n < ptCache.n) { ptCache.img.fill(0); ptCache.n = 0; }
    if (n > ptCache.n) { backproject(pointSino, N, R.order.slice(ptCache.n, n), ptCache.img); ptCache.n = n; }
    return ptCache.img;
  };
  steps.push({
    title: 'Star and blur', dur: 13, view: 'pixel', scale: '10 cm',
    cues: SCHED.map(([tt]) => [tt + 0.02, () => sfx.blip(700)]),
    frame(t) {
      px.fillAll('ink');
      const n = nAt(t, SCHED);
      const s = Math.min(0.9, (px.W - 30) / (2 * N)), size = N * s, gap = 10;
      const x0 = Math.round(px.W / 2 - size - gap / 2), x1 = x0 + size + gap, y0 = Math.round((px.H - size) / 2) - 8;
      drawRecon(pointUpTo(n), x0, y0, s);
      drawRecon(R.bpUpTo(n, false), x1, y0, s);
      px.text(String(n), px.W / 2, y0 + size + 6, 'yellow', 1, 1, 'center');
      api.keepOut([x0, y0, size * 2 + gap, size + 14]);
      const [pc, pr] = pointSino.at;
      if (t < 8) api.mark([x0 + pc * s - 16, y0 + pr * s - 16, 32, 32], 'yellow', t);
      else api.mark([x1, y0, size, size], 'yellow', t);
    },
    caption: [
      { from: 0.8, to: 8, text: 'Back-project a single dense point (left): with few angles it throws a <b>star</b> of streaks across the image.' },
      { from: 8, to: 13, text: 'With all the angles the streaks merge, but each point is still spread into a halo that fades with distance: the plain back-projection of the slice (right) is <b>blurred</b>.' },
    ],
  });
  // ---- the filter
  const p0 = parProfile(0), q0 = Array.from(filterRow(Float32Array.from(p0), R.K.soft));
  steps.push({
    title: 'The filter', dur: 13, view: 'pixel', scale: '10 cm',
    frame(t) {
      px.fillAll('ink');
      const x = 10, w = px.W - 20, h = 52;
      const k = span(t, 3, 10, api.ease.linear);
      // the profile, with the kernel sliding along it
      box(api, x, 6, w, h); curve(p0, x + 3, 9, w - 6, h - 6, { c: 'yellow', lo: 0 });
      const kx = x + 3 + k * (w - 6);
      // the kernel: a spike and its negative sides (taps -10..10, drawn at the sliding point)
      const taps = 12, tw = (w - 6) / N;
      box(api, x, 64, w, h);
      const kmid = 64 + h * 0.62;
      px.rect(x + 3, kmid, w - 6, 1, 'dkgrey');
      for (let n = -taps; n <= taps; n++) {
        const v = R.K.soft[n + N - 1] / R.K.soft[N - 1];
        const X = x + w / 2 + n * 5, H = Math.round(v * (h * 0.55));
        px.rect(X, H > 0 ? kmid - H : kmid, 2, Math.max(1, Math.abs(H)), H > 0 ? 'lime' : 'red');
      }
      if (t > 3 && k < 1) { px.rect(kx - taps * tw, 9, 2 * taps * tw, h - 6, 'lime', 0.15); px.rect(kx, 9, 1, h - 6, 'lime', 0.8); }
      // the filtered profile, as far as the kernel has gone
      box(api, x, 122, w, h + 18);
      curve(q0, x + 3, 125, w - 6, h + 12, { c: 'cyan', upTo: t < 3 ? 0 : k, zero: true });
      if (t < 6.5) api.mark([x, 64, w, h], 'lime', t);
      else api.mark([x, 122, w, h + 18], 'cyan', t);
    },
    caption: [
      { from: 0.8, to: 6.5, text: 'So each projection is first <b>filtered</b>: convolved with a <b>kernel</b> that has a sharp positive centre and small negative sides.', place: 'below' },
      { from: 6.5, to: 13, text: 'Edges come out sharpened, each with a negative dip beside it. Back-projected, the dips cancel the halo.', place: 'above' },
    ],
  });
  const SCHED2 = [[0, 1], [1.2, 2], [2.4, 4], [3.6, 8], [4.8, 16], [6.2, 32], [7.6, 64], [9, 180]];
  steps.push({
    title: 'Filtered back-projection', dur: 13, view: 'pixel', scale: '10 cm',
    cues: SCHED2.map(([tt]) => [tt + 0.02, () => sfx.blip(880)]),
    frame(t) {
      px.fillAll('ink');
      const n = nAt(t, SCHED2), s = Math.min(0.94, (px.W - 30) / (2 * N)), size = N * s, gap = 10;
      const x0 = Math.round(px.W / 2 - size - gap / 2), x1 = x0 + size + gap, y0 = Math.round((px.H - size) / 2) - 4;
      drawRecon(R.bpUpTo(n, false), x0, y0, s);
      const f = R.bpUpTo(n, true), sc = Math.PI / (n * G.d), tmp = new Float32Array(f.length);
      for (let i = 0; i < f.length; i++) tmp[i] = f[i] * sc;
      drawRecon(tmp, x1, y0, s, { L: 40, W: 500 });
      px.text(String(n), px.W / 2, y0 + size + 6, 'yellow', 1, 1, 'center');
      api.keepOut([x0, y0, size * 2 + gap, size]);
      api.mark([x1, y0, size, size], 'yellow', t);
    },
    caption: [
      { from: 0.8, to: 6.5, text: 'Back-projected, the filtered projections (right) cancel each other’s blur: <b>filtered back-projection</b>, against the plain sum (left).' },
      { from: 6.5, to: 13, text: 'Each new angle adds detail and cancels a little more streak. With all of them, the slice: every pixel’s value its tissue’s μ.' },
    ],
  });
  // ---- kernels
  const crop = [Math.round(R.spine[0] - 30), Math.round(R.spine[1] - 34), 60, 52];
  steps.push({
    title: 'Soft and sharp kernels', dur: 13, view: 'pixel', scale: '1 cm',
    frame(t) {
      px.fillAll('ink');
      const s = Math.min(2.0, (px.W - 30) / 120), w = crop[2] * s, h = crop[3] * s, gap = 10;
      const x0 = Math.round(px.W / 2 - w - gap / 2), x1 = x0 + w + gap, y0 = 40;
      const L = 60, W = 500;
      drawRecon(R.fbpSoft, x0, y0, s, { L, W, crop });
      drawRecon(R.fbpSharp, x1, y0, s, { L, W, crop });
      // each kernel's response: how it passes each spatial frequency (the ramp's shaping)
      for (const [xx, type, c] of [[x0, 'soft', 'cyan'], [x1, 'sharp', 'orange']]) {
        box(api, xx, 6, w, 28);
        // the kernel's response across spatial frequency: the ramp times its window
        const vals = Array.from({ length: 40 }, (_, i) => {
          const u = i / 39;
          return u * (type === 'soft' ? 0.5 + 0.5 * Math.cos(Math.PI * u) : (1 + 0.9 * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 2) * (u > 0.85 ? Math.cos((u - 0.85) / 0.15 * Math.PI / 2) ** 2 : 1));
        });
        curve(vals, xx + 3, 9, w - 6, 22, { c, lo: 0, hi: 1.4 });
      }
      api.keepOut([x0, y0, w * 2 + gap, h]);
      if (t < 6.5) api.mark([x0, y0, w, h], 'cyan', t);
      else api.mark([x1, y0, w, h], 'orange', t);
    },
    caption: [
      { from: 0.8, to: 6.5, text: 'The kernel is chosen for the task. A <b>soft</b> kernel rolls off the finest detail: smooth soft tissue, low noise.' },
      { from: 6.5, to: 13, text: 'A <b>sharp</b> kernel (bone, lung) boosts it: crisp edges and fine structure, and far more noise.' },
    ],
  });
  // ---- iterative
  steps.push({
    title: 'Iterative reconstruction', dur: 14, view: 'pixel', scale: '10 cm',
    cues: Array.from({ length: 8 }, (_, k) => [2 + k * 1.1, () => sfx.blip(600 + k * 60)]),
    frame(t) {
      px.fillAll('ink');
      const it = Math.min(8, Math.max(0, Math.floor((t - 2) / 1.1) + 1)), fr = t < 2 ? 0 : ((t - 2) % 1.1) / 1.1;
      const s = Math.min(0.85, (px.W - 40) / (2 * N)), size = N * s;
      const x0 = 10, x1 = px.W - 10 - size, y0 = 30;
      drawRecon(R.fbpLow, x0, y0, s, { L: 40, W: 400 });
      drawRecon(R.ir.images[it], x1, y0, s, { L: 40, W: 400 });
      api.keepOut([x0, y0, size, size]); api.keepOut([x1, y0, size, size]);
      // the loop between them: project, compare with the measured sinogram, back-project, correct
      const cx = px.W / 2, cy = y0 + size / 2, rr = Math.min(20, (x1 - x0 - size) / 2 - 6);
      px.circle(cx, cy, rr, 'dkgrey');
      if (t > 2 && it < 8) { const a = fr * Math.PI * 2 - Math.PI / 2; px.rect(cx + Math.cos(a) * rr - 1, cy + Math.sin(a) * rr - 1, 3, 3, 'yellow'); }
      px.text('IT ' + it, cx, cy - 2, 'yellow', 1, 1, 'center');
      // the residual: measured minus projected, shrinking
      const bx = cx - 40, by = y0 + size + 12, bw = 80, bh = 34;
      box(api, bx, by, bw, bh);
      // the noise in a patch of even tissue, iteration by iteration (its standard deviation, HU)
      R.ir.noise.forEach((v, i) => { if (i <= it) { const hh = Math.max(1, Math.round(v / R.ir.noise[0] * (bh - 8))); px.rect(bx + 4 + i * 8, by + bh - 3 - hh, 6, hh, i ? 'cyan' : 'grey'); } });
      px.text(Math.round(R.ir.noise[it]) + ' HU', bx + bw, by + bh + 3, 'cyan', 1, 1, 'right');
      if (t < 7) api.mark([cx - rr - 3, cy - rr - 3, 2 * rr + 6, 2 * rr + 6], 'yellow', t);
      else api.mark([x1, y0, size, size], 'yellow', t);
    },
    caption: [
      { from: 0.8, to: 7, text: '<b>Iterative reconstruction</b>: from a first image, compute the projections it would give, compare them with the measured ones, and correct the image by the difference; again and again.', place: 'below' },
      { from: 7, to: 14, text: 'Modelling the photon noise and the scanner itself, it gets a cleaner image (right) from the same low-dose data than filtered back-projection (left): the same quality for <b>less dose</b>.' },
    ],
  });
  // along z: slices from the helix; thickness and interval
  steps.push(...zReconSteps(api, S));
  return { title: 'Reconstruction', steps };
}
