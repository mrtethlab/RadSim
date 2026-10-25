/* DXA FILM, chapter 3: the scan and its physics. The fan beam through the patient; the arm stepping
   pass by pass up the spine while the fan sweeps across, the study building band by band; the
   dose. Then into the body: a field of soft tissue (water, fat) and bone (hydroxyapatite: calcium,
   phosphate) where the low-energy photons are taken far more by bone than the high-energy ones;
   the soft tissue's own ratio, R, measured beside the bone; the two equations and their solve,
   drawn on the scan's own pixels; the soft tissue cancelling, however much there is; and the two
   images becoming a map of bone mineral. */
import { atom, electron, keVColor } from '../../kit/micro.js';
import { setOpacity } from '../../kit/stage.js';
import { ZP, FOCUS_Y, DET_Y } from './room.js';
import { physOf, stream } from './phys.js';
import { mapCanvas, blit, greyOf, boneOf, rangeOf, windowOf } from './data.js';

export function scanning(api, S) {
  const { px, sfx, span, lerp, clamp01, rng } = api;
  const J = S.J, SP = J?.spine, PH = physOf(J);
  const markZ = SP ? SP.laser.z + ZP : -3;
  const E_LO = PH.E_LO, E_HI = PH.E_HI;
  // linear attenuation (cm^-1) of the two basis materials at the two energies
  const MU = { soft: { lo: PH.soft.lo * PH.rhoS, hi: PH.soft.hi * PH.rhoS }, bone: { lo: PH.bone.lo * PH.rhoB, hi: PH.bone.hi * PH.rhoB } };
  const A = (layers, e) => layers.reduce((s, [m, th]) => s + MU[m][e] * th, 0);     // ln(I0/I)

  // ---------------------------------------------------------------- the scan's timing (shown sped up)
  const plan = SP?.plan || { passes: 10, stepCm: 2.4, passS: 3 };
  const z0 = SP ? SP.z0 + ZP : markZ, x0 = SP ? SP.x0 : -7, wx = SP ? SP.nx * SP.px : 14;
  const PASS = 1.15, MOVE = 0.28;                              // seconds a pass, and of it the step
  function armAt(tt) {                                         // tt: seconds into the (sped-up) scan
    const total = plan.passes * PASS, T = Math.max(0, Math.min(total - 1e-6, tt));
    const p = Math.floor(T / PASS), tin = T - p * PASS;
    const move = Math.min(1, tin / MOVE), sweep = clamp01((tin - MOVE) / (PASS - MOVE));
    const fwd = p % 2 === 0;
    return { p, move, sweep, fwd, done: tt >= total,
      z: z0 + (Math.max(0, p - 1 + move) + 0.5) * plan.stepCm,
      x: x0 + (fwd ? sweep : 1 - sweep) * wx };
  }

  // ---------------------------------------------------------------- the fan's photons (3D, 8-bit sprites)
  const fanP = Array.from({ length: 140 }, (_, i) => { const r = rng(500 + i); return { i, u: r() - 0.5, w: r() - 0.5, hi: r() < 0.42, r1: r(), r2: r() }; });
  function fanPhotons(t, armZ, x, a = 1) {
    const P = 1.4, top = DET_Y - FOCUS_Y, hz = Math.tan(2.25 * Math.PI / 180);
    const body = S.skinTop(x, armZ);                              // the patient's front, over the fan
    for (const p of fanP) {
      const k = ((t + p.i * P / fanP.length) % P) / P;
      const d = k * top, y = FOCUS_Y + d;
      // taken in the body (low energy more often), at some depth in it
      const takeP = p.hi ? 0.55 : 0.75, yStop = 1 + p.r2 * (body - 2);
      if (p.r1 < takeP && y > yStop) continue;
      const pos = [x + p.u * 0.24 * d / top, y, armZ + p.w * 2 * hz * d];
      const [sx, sy, f] = api.toPx(pos);
      if (!f) continue;
      const [sx2, sy2] = api.toPx([pos[0], pos[1] + 0.8, pos[2] + p.w * 2 * hz * 0.8]);
      px.photon(sx, sy, sx2 - sx, sy2 - sy, 4, p.hi ? keVColor(E_HI) : keVColor(E_LO), 0.9 * a, t * 20 + p.i);
    }
  }

  // ---------------------------------------------------------------- the study, building (8-bit panel)
  const bmdCol = boneOf(SP ? SP.max.bmd * 0.75 : 1.5);
  function buildingPanel(st, x, y, h) {
    if (!SP) return null;
    const cv = mapCanvas(SP, 'bmd', bmdCol), cell = h / SP.nz, w = SP.nx * cell;
    px.rect(x - 2, y - 2, w + 4, h + 4, 'ink', 0.95); px.frame(x - 2, y - 2, w + 4, h + 4, 'dkgrey');
    api.keepOut([x - 2, y - 2, w + 4, h + 4]);
    const nz = SP.nz, nx = SP.nx, rowsPer = nz / plan.passes;
    const doneRows = Math.round(st.p * rowsPer);                 // whole passes before this one
    blit(px, cv, x, y, cell, [0, nz - doneRows, nx, nz]);
    if (!st.done) {
      const r0 = doneRows, r1 = Math.min(nz, Math.round((st.p + 1) * rowsPer)), cols = Math.round(st.sweep * nx);
      // forward passes run toward +x, the patient's right: the left of the picture
      const part = st.fwd ? [nx - cols, nz - r1, nx, nz - r0] : [0, nz - r1, cols, nz - r0];
      blit(px, cv, x, y, cell, part);
      const cx = st.fwd ? x + (nx - cols) * cell : x + cols * cell;
      if (st.sweep > 0 && st.sweep < 1) px.rect(cx, y + (nz - r1) * cell, 1, (r1 - r0) * cell, 'cyan', 0.9);
    } else blit(px, cv, x, y, cell);
    return [x, y, w, h];
  }

  // ---------------------------------------------------------------- the tissue field (8-bit)
  /* Columns of tissue lying on the table (the bottom), the beam rising through them from the
     source below to the detector row at the top, as the camera saw it from the patient's feet:
     the patient's right on the left. layers bottom-up, [material, cm]. Soft tissue drawn as water
     molecules (an O with its two H) and fat chains; bone as hydroxyapatite: calcium atoms (Z = 20,
     shells 2/8/8/2) with phosphate and oxygen between them. Each photon's history is drawn from
     the materials' own attenuation at its energy: taken by the photoelectric effect (its energy
     to an inner electron, which flies off) or by Compton scatter (off at an angle, an electron
     recoiling), or through to the detector. */
  const PXCM = 26;                                                 // 8-bit pixels per cm of tissue
  function field(t, { cols, energies = ['lo'], rate = 34, focus = null, x = 0, w = null, meters = null, dim = 1 } = {}) {
    const W = w ?? px.W, H = px.H, yTable = H - 16, yDet = 14;
    const n = cols.length, cw = Math.floor((W - 8) / n), L = x + 4;
    // the focus event: its phase in its cycle
    const fP = focus ? focus.P : 1, ft = focus ? ((t - focus.at) % fP + fP) % fP : 0;
    const fOn = focus && t >= focus.at && ft < 4.2;
    const back = fOn ? 0.4 : 1;
    px.rect(x, yTable, W, 3, 'slate');                              // the table top
    px.rect(x, yDet - 6, W, 6, 'dkblue'); px.rect(x, yDet - 1, W, 1, 'teal');   // the detector row
    const geo = cols.map((c, ci) => {
      const segs = []; let y = yTable;
      for (const [m, th] of c.layers) { const h = th * PXCM; segs.push({ m, th, y0: y - h, y1: y }); y -= h; }
      return { ...c, x0: L + ci * cw, segs, top: y };
    });
    // the tissue and its atoms
    px.alpha = back * dim;
    geo.forEach((c, ci) => {
      for (const s of c.segs) {
        px.rect(c.x0 + 1, s.y0, cw - 2, s.y1 - s.y0, s.m === 'bone' ? 'bone' : 'muscle', s.m === 'bone' ? 0.22 : 0.16);
        const rr = rng(40 + ci * 17 + Math.round(s.y0));
        const area = (cw - 6) * (s.y1 - s.y0);
        if (s.m === 'bone') {
          const nCa = Math.round(area / 130);
          for (let k = 0; k < nCa; k++) {
            const ax = c.x0 + 5 + rr() * (cw - 10), ay = s.y0 + 4 + rr() * Math.max(1, s.y1 - s.y0 - 8);
            atom(px, ax, ay, 4, t, { shells: [2, 8], ring: 'peach', e: 'yellow', nucleus: 'orange', seed: k });
          }
          for (let k = 0; k < nCa * 2; k++) {
            const ax = c.x0 + 3 + rr() * (cw - 6), ay = s.y0 + 2 + rr() * Math.max(1, s.y1 - s.y0 - 4);
            px.rect(ax, ay, 2, 2, k % 3 ? 'pink' : 'lime', 0.75);          // oxygen, phosphorus
          }
        } else {
          const nW = Math.round(area / 120);
          for (let k = 0; k < nW; k++) {
            const ax = c.x0 + 4 + rr() * (cw - 8), ay = s.y0 + 2 + rr() * Math.max(1, s.y1 - s.y0 - 4);
            const j = Math.round(Math.sin(t * 7 + k) * 0.6);
            if (k % 4 === 3) { px.line(ax, ay + j, ax + 2, ay + 1 + j, 'fat', 0.7); px.line(ax + 2, ay + 1 + j, ax + 4, ay + j, 'fat', 0.7); }
            else { px.rect(ax, ay + j, 2, 2, 'red', 0.55); px.px(ax - 1, ay - 1 + j, 'white', 0.6); px.px(ax + 2, ay - 1 + j, 'white', 0.6); }
          }
        }
      }
      px.frame(c.x0, c.top, cw, yTable - c.top, 'dkgrey', 0.6);
    });
    px.alpha = 1;
    // the photons
    const v = 120, life = (yTable + 16 - yDet) / v + 1.4;
    stream(t, 1 / rate, life, (i, age) => {
      const r = rng(20000 + i);
      const ci = Math.floor(r() * n), c = geo[ci], e = energies[Math.floor(r() * energies.length)], E = e === 'lo' ? E_LO : E_HI;
      const xIn = c.x0 + 3 + r() * (cw - 6);
      // the history: through each layer in turn (bottom up)
      let hit = null;
      for (const s of c.segs) {
        const d = -Math.log(1 - r() * 0.9999) / MU[s.m][e];
        if (d < s.th) { hit = { y: s.y1 - d * PXCM, m: s.m, pe: r() < PH.fPE(s.m, E) }; break; }
      }
      const yStart = yTable + 16, y = yStart - age * v;
      px.alpha = back;
      if (!hit || y > hit.y) {
        if (y > yDet) px.photon(xIn, y, 0, -1, 5, keVColor(E), 0.9, t * 25 + i);
        else if (y > yDet - 8) px.rect(xIn - 1, yDet - 3, 3, 3, 'white', 0.8);
      } else {
        const ea = (hit.y - y) / v;                                  // seconds since it was taken
        if (hit.pe) {
          if (ea < 0.15) px.glow(xIn, hit.y, 3, 'white', 0.9, i);
          if (ea < 0.6) electron(px, xIn + ea * 30 * (r() < 0.5 ? -1 : 1), hit.y - ea * 10, (1 - ea / 0.6) * 0.8, 'cyan');
        } else {
          const ang = (r() - 0.5) * 2.4, sx = Math.sin(ang), sy = -Math.cos(ang);
          const fx = xIn + sx * ea * v, fy = hit.y + sy * ea * v;
          if (ea < 0.5) electron(px, xIn - sx * ea * 20, hit.y + ea * 6, (1 - ea / 0.5) * 0.7, 'cyan');
          if (ea < 0.1) px.glow(xIn, hit.y, 2, 'orange', 0.8, i);
          if (fy > yDet && fx > x && fx < x + W) px.photon(fx, fy, sx, sy, 5, keVColor(E * 0.9), 0.8, t * 25 + i);
        }
      }
      px.alpha = 1;
    });
    // the focus: one photon slowed, its fate forced, every P seconds
    if (fOn) {
      const c = geo[focus.col], s = c.segs.findLast((q) => q.m === focus.mat) || c.segs[0];
      const E = focus.e === 'lo' ? E_LO : E_HI, xIn = c.x0 + cw / 2 + 3, yHit = (s.y0 + s.y1) / 2, yStart = yTable + 16;
      const tHit = 1.6, slowV = (yStart - yHit) / tHit;
      if (ft < tHit) {
        for (let yy = yStart; yy > yStart - ft * slowV; yy -= 3) px.px(xIn, yy, 'yellow', 0.35);
        px.photon(xIn, yStart - ft * slowV, 0, -1, 9, keVColor(E), 1, t * 25);
      } else {
        const ea = ft - tHit;
        if (focus.type === 'pe') {
          if (ea < 0.3) px.glow(xIn, yHit, 6, 'white', 0.95, 7);
          if (ea < 2.2) electron(px, xIn + ea * 26, yHit - ea * 16, 1 - ea / 2.4, 'cyan');
          if (ea < 2.4) atom(px, xIn, yHit, 6, t, { shells: [2, 8, 8, 2], ring: 'peach', e: 'yellow', nucleus: 'orange', missing: 0 });
        } else {
          const ang = -0.9, sx = Math.sin(ang), sy = -Math.cos(ang);
          if (ea < 2.4) px.photon(xIn + sx * ea * 50, yHit + sy * ea * 50, sx, sy, 9, keVColor(E * 0.9), 1, t * 25);
          if (ea < 2) electron(px, xIn + ea * 18, yHit + ea * 8, 1 - ea / 2.2, 'cyan');
          if (ea < 0.25) px.glow(xIn, yHit, 4, 'orange', 0.9, 3);
        }
      }
      api.mark([xIn - 9, yHit - 9, 18, 18], 'yellow', t);
      api.keepOut([xIn - 10, yHit, 20, yStart - yHit]);
      api.keepOut(focus.type === 'pe' ? [xIn, yHit - 44, 64, 44] : [xIn - 100, yHit - 80, 100, 80]);   // where its electron / scattered photon goes
      if (ft >= tHit && ft < tHit + 0.3 && focusSnd !== Math.floor((t - focus.at) / fP)) {
        focusSnd = Math.floor((t - focus.at) / fP); focus.type === 'pe' ? sfx.zap() : sfx.pew(1100);
      }
    }
    // what reaches the detector over each column (the primary beam's share, from the attenuation)
    const out = geo.map((c) => {
      const lay = c.segs.map((s) => [s.m, s.th]);
      return { x0: c.x0, w: cw, top: c.top, Alo: A(lay, 'lo'), Ahi: A(lay, 'hi'), lay };
    });
    if (meters) for (const o of out) meters(o, yDet);
    return { cols: out, yDet, yTable, cw };
  }
  let focusSnd = -1;
  // two bars over a column: the share of low (yellow) and high (cyan) photons reaching the detector
  const bars = (o, yDet, { lo = true, hi = true } = {}) => {
    const bw = Math.max(3, Math.floor(o.w / 5)), cx = o.x0 + o.w / 2, base = yDet - 7;
    void base;
    const mk = (on, T, c, dx) => { if (!on) return; const h = Math.round(T * 34); px.rect(cx + dx, yDet + 4, bw, h, c, 0.85); px.text(Math.round(T * 100) + '%', cx + dx + bw / 2, yDet + 6 + h, c, 1, 1, 'center'); };
    mk(lo, Math.exp(-o.Alo), 'yellow', -bw - 2); mk(hi, Math.exp(-o.Ahi), 'cyan', 2);
  };

  // the soft-only and spine columns (cm), as the camera saw them from the feet: right, spine, left
  const COLS3 = [{ layers: [['soft', 4]] }, { layers: [['soft', 0.6], ['bone', 0.6], ['soft', 2.8]] }, { layers: [['soft', 4]] }];

  // ---------------------------------------------------------------- the solve on the scan's own pixels
  const solvePts = (() => {
    if (!SP) return [];
    const pts = [];
    for (let r = 0; r < SP.nz; r += 2) for (let c = 0; c < SP.nx; c += 2) { const k = r * SP.nx + c; pts.push([SP.hi[k], SP.lo[k], SP.bmd[k]]); }
    return pts;
  })();
  // the pixel picked out: in L3, on the spine's middle (image row, stored column)
  const pick = (() => {
    if (!SP) return null;
    const l3 = SP.rois.find((q) => q.label === 'L3') || SP.rois[0];
    const row = Math.round((l3.a + l3.b) / 2), col = Math.round((l3.x0 + l3.x1) / 2), k = (SP.nz - 1 - row) * SP.nx + col;
    return { hi: SP.hi[k], lo: SP.lo[k], bmd: SP.bmd[k] };
  })();
  // the plot's window: the body's own range of attenuation (the origin is far off, down-left)
  const win = (() => {
    if (!SP) return { x0: 2, x1: 7, y0: 3, y1: 11 };
    const his = solvePts.map((p) => p[0]).filter((v) => v > 0.3).sort((a, b) => a - b);
    const x0 = his[Math.floor(his.length * 0.03)] * 0.97, x1 = his[his.length - 1] * 1.02;
    const y1 = Math.max(...solvePts.map((p) => p[1])) * 1.02;
    return { x0, x1, y0: x0 * PH.Rs * 0.97, y1 };
  })();
  function solvePlot(t, x, y, w, h) {
    px.rect(x, y, w, h, 'ink', 0.9); px.frame(x, y, w, h, 'dkgrey');
    api.keepOut([x, y, w, h]);
    const X = (a) => x + 4 + ((a - win.x0) / (win.x1 - win.x0)) * (w - 8), Y = (a) => y + h - 4 - ((a - win.y0) / (win.y1 - win.y0)) * (h - 8);
    const inside = (a, b) => a >= win.x0 && a <= win.x1 && b >= win.y0 && b <= win.y1;
    px.rect(x + 4, y + h - 4, w - 8, 1, 'cyan', 0.7); px.rect(x + 4, y + 4, 1, h - 8, 'yellow', 0.7);
    px.text(E_HI + ' keV', x + w - 4, y + h - 11, 'cyan', 1, 1, 'right');
    px.text(E_LO + ' keV', x + 7, y + 6, 'yellow');
    const k = span(t, 0.5, 4, api.ease.linear);
    const nShow = Math.floor(solvePts.length * k);
    for (let i = 0; i < nShow; i++) {
      const [hi, lo, b] = solvePts[i];
      if (!inside(hi, lo)) continue;
      px.px(X(hi), Y(lo), b > 0.25 ? 'bone' : 'pink', b > 0.25 ? 0.9 : 0.6);
    }
    // the soft-tissue line, slope R through the origin: soft tissue alone, any amount, lies on it
    const kl = span(t, 4, 5.5);
    if (kl > 0) px.line(X(win.x0), Y(win.x0 * PH.Rs), X(lerp(win.x0, win.x1, kl)), Y(lerp(win.x0, win.x1, kl) * PH.Rs), 'pink', 0.95);
    let box = null;
    if (pick && t > 7) {
      // the picked pixel: back down bone's own direction to the soft-tissue line. That run is the
      // bone (M_b); where it lands is the soft tissue alone (M_s)
      const Mb = PH.Mb(pick.lo, pick.hi);
      const Sx = pick.hi - Mb * PH.bone.hi, Sy = pick.lo - Mb * PH.bone.lo;
      const b = span(t, 8, 10.5);
      px.rect(X(pick.hi) - 1, Y(pick.lo) - 1, 3, 3, 'white');
      if (b > 0) px.line(X(pick.hi), Y(pick.lo), X(lerp(pick.hi, Sx, b)), Y(lerp(pick.lo, Sy, b)), 'yellow');
      // every pixel with the same bone lies on a line parallel to the soft tissue's
      const c = span(t, 10.5, 12.5);
      if (c > 0) {
        const d = (win.x1 - win.x0) * 0.6 * c;
        px.line(X(pick.hi - d), Y(pick.lo - d * PH.Rs), X(pick.hi + d * 0.4), Y(pick.lo + d * 0.4 * PH.Rs), 'white', 0.7, 2);
      }
      if (b >= 1) {
        px.rect(X(Sx) - 1, Y(Sy) - 1, 3, 3, 'pink');
        const mx = (X(pick.hi) + X(Sx)) / 2, my = (Y(pick.lo) + Y(Sy)) / 2;
        px.text(pick.bmd.toFixed(2) + ' g/cm2', mx - 6, my, 'yellow', 1, 1, 'right');
      }
      box = [Math.min(X(Sx), X(pick.hi)) - 6, Y(pick.lo) - 6, Math.abs(X(pick.hi) - X(Sx)) + 12, Y(Sy) - Y(pick.lo) + 12];
    }
    const lineBox = [X(win.x0), Y(Math.min(win.y1, win.x1 * PH.Rs)), X(win.x1) - X(win.x0), Y(win.x0 * PH.Rs) - Y(Math.min(win.y1, win.x1 * PH.Rs))];
    return { box, X, Y, lineBox };
  }

  // ---------------------------------------------------------------- the images (8-bit)
  const loCol = SP ? windowOf(rangeOf(SP.lo, 0.05, 0.999)) : greyOf(1);
  const hiCol = SP ? windowOf(rangeOf(SP.hi, 0.05, 0.999)) : greyOf(1);
  const softCol = SP ? windowOf(rangeOf(SP.soft, 0.05, 0.999)) : greyOf(1);

  const sideCam = { pos: [118, 14, markZ + 34], look: [0, 10, markZ + 6] };
  const steps = [
    {
      title: 'The fan beam', dur: 12, scale: '10 cm',
      enter() { S.reset(); S.block.visible = true; S.legsTo('block'); S.patLook(1, 0.28); setOpacity(S.carriageG, 0.25); setOpacity(S.headG, 0.35); },
      cam: [[0, [150, 60, markZ + 70], [0, 10, markZ], 36], [12, sideCam.pos, sideCam.look, 36]],
      cues: [[0.6, () => sfx.power()]],
      frame(t) {
        S.setArm(markZ + 6, 0);
        const on = span(t, 0.6, 1.4);
        S.spot.material.opacity = on; S.fan.visible = on > 0; S.fan.material.opacity = 0.2 * on;
        S.fanAt(markZ + 6, 0);
        sfx.hold('tube', 70, 0.03 * on, 'triangle');
        if (on > 0) fanPhotons(t, markZ + 6, 0, on);
        if (t > 2) {
          const a = api.toPx([0, FOCUS_Y, markZ + 6]), b = api.toPx([0, DET_Y, markZ + 9]), c = api.toPx([0, DET_Y, markZ + 3]);
          const bx = Math.min(a[0], b[0], c[0]) - 3, by = Math.min(a[1], b[1], c[1]);
          const box = [bx, by, Math.max(a[0], b[0], c[0]) + 3 - bx, Math.max(a[1], b[1], c[1]) - by];
          api.mark(box, 'violet', t); api.keepOut(box);
        }
      },
      caption: [
        { from: 2, to: 7, text: 'A narrow <b>fan beam</b>, 4.5° along the body and a slit across it, rises through the table and the patient to the detector.' },
        { from: 7, to: 12, text: 'So narrow a beam makes little scatter: almost every photon counted came straight from the source.' },
      ],
    },
    {
      title: 'Pass by pass', dur: 17, scale: '10 cm',
      enter() { S.reset(); S.block.visible = true; S.legsTo('block'); S.patLook(1, 0.3); setOpacity(S.headG, 0.6); },
      cam: [[0, [60, 165, markZ - 105], [0, 14, markZ + 14], 38], [17, [45, 150, markZ - 92], [0, 14, markZ + 14], 38]],
      cues: Array.from({ length: 10 }, (_, k) => [1.5 + k * PASS, () => sfx.tick()]).concat([[1.5 + 10 * PASS + 0.1, () => sfx.chime()]]),
      frame(t) {
        const st = armAt(t - 1.5);
        const scanning = t > 1.5 && !st.done;
        S.setArm(st.z, st.x);
        S.spot.material.opacity = scanning ? 1 : 0;
        S.fan.visible = scanning; if (scanning) { S.fan.material.opacity = 0.22; S.fanAt(st.z, st.x); }
        S.L.sweep.material.opacity = scanning && st.sweep > 0 && st.sweep < 1 ? 0.85 : 0;
        sfx.hold('tube', 70 + st.p * 3, scanning ? 0.03 : 0, 'triangle');
        if (scanning) fanPhotons(t, st.z, st.x, 0.8);
        const ph = Math.min(px.H - 70, 118);
        const panel = buildingPanel(t > 1.5 ? st : { p: 0, sweep: 0, fwd: true, done: false }, px.W - ph * (SP ? SP.nx / SP.nz : 0.6) - 8, 8, ph);
        if (panel) {
          px.text((Math.min(plan.passes, st.p + (st.done ? 0 : 1))) + '/' + plan.passes, panel[0] + panel[2], panel[1] + panel[3] + 5, 'white', 1, 1, 'right');
          px.text(Math.round(Math.min(1, Math.max(0, t - 1.5) / (plan.passes * PASS)) * plan.passes * plan.passS) + ' s', panel[0], panel[1] + panel[3] + 5, 'mid');
        }
        if (t > 1.5) api.mark(S.headG, 'cyan', t, { live: true });
      },
      caption: [
        { from: 1.5, to: 8, text: 'The arm steps along the body <b>2.4 cm</b> at a time; at each step the fan sweeps across the spine, source and detector moving together.' },
        { from: 8, to: 17, text: 'Ten passes cover the 24 cm field, from the pelvis to the lower ribs, in about <b>30 seconds</b>. The picture builds band by band.' },
      ],
    },
    {
      title: 'A very low dose', dur: 11, view: 'pixel', scale: null,
      frame(t) {
        px.fillAll('ink');
        const rows = [['dxa', 3, 'lime'], ['day', 8, 'yellow'], ['cxr', 20, 'orange']];
        const W = px.W, x0 = 40, bw = W - x0 - 46, gap = 40, y0 = Math.round((px.H - gap * 3) / 2) + 14, max = 22;
        rows.forEach(([k, v, c], i) => {
          const y = y0 + i * gap, g = span(t, 0.5 + i * 0.8, 1.8 + i * 0.8);
          icon(k, 18, y + 6, t);
          px.rect(x0, y, Math.round(bw * v / max * g), 12, c, 0.9);
          px.text(Math.round(v * g) + ' µSv', x0 + bw * v / max * g + 4, y + 4, c);
        });
        api.keepOut([x0, y0, bw + 40, gap * 3]);
        if (t > 3) api.mark([4, y0 - 6, x0 + Math.round(bw * 3 / max) + 32, 24], 'lime', t);
      },
      caption: [
        { from: 1, to: 6.5, text: 'A spine scan gives an effective dose of a few <b>µSv</b>: less than a day of natural background radiation, a fraction of a chest x-ray.' },
        { from: 6.5, to: 11, text: 'The technologist can stay at the console beside the table throughout.' },
      ],
    },
    {
      title: 'Into the spine', dur: 5, scale: (t) => (t < 2 ? '10 cm' : t < 3.6 ? '1 cm' : '1 cm'),
      enter() { S.reset(); S.block.visible = true; S.legsTo('block'); S.patLook(1, 0.25); setOpacity(S.carriageG, 0.25); setOpacity(S.headG, 0.35); setOpacity(S.block, 0.15); setOpacity(S.legs.block, 0.15); },
      cam: [[0, sideCam.pos, sideCam.look, 36], [2.4, [26, 12, markZ - 40], [0, 11, markZ + 6], 34], [5, [0.5, 9, markZ - 2], [0, 9, markZ + 6], 34]],
      cues: [[0.3, () => sfx.whoosh()]],
      frame(t) {
        S.setArm(markZ + 6, 0);
        S.spot.material.opacity = 1; S.fan.visible = true; S.fan.material.opacity = 0.2; S.fanAt(markZ + 6, 0);
        fanPhotons(t, markZ + 6, 0, 1 - span(t, 3, 4));
        api.mosaic(span(t, 2.6, 4.6));
        if (t > 4) { px.alpha = span(t, 4, 5); px.fillAll('ink'); field(t, { cols: COLS3, energies: ['lo', 'hi'] }); px.alpha = 1; }
      },
    },
    {
      title: 'Low energy: bone absorbs', dur: 13, view: 'pixel', scale: '1 cm',
      enter() { focusSnd = -1; },
      frame(t) {
        px.fillAll('ink');
        const r = field(t, { cols: COLS3, energies: ['lo'], focus: { col: 1, mat: 'bone', type: 'pe', e: 'lo', at: 1.2, P: 13 }, meters: (o, y) => bars(o, y, { hi: false }) });
        if (t > 7.5) { const o = r.cols[1]; api.mark([o.x0 - 2, r.yDet + 2, o.w + 4, 44], 'yellow', t); }
      },
      caption: [
        { from: 0.8, to: 7.5, text: 'At <b>40 keV</b> the calcium of bone (Z = 20) takes photons by the <b>photoelectric effect</b>, its likelihood rising steeply with atomic number (∝ Z³/E³).' },
        { from: 7.5, to: 13, text: 'Soft tissue (hydrogen, carbon, oxygen) mostly scatters them instead. Far fewer low-energy photons get through where there is bone.' },
      ],
    },
    {
      title: 'High energy: bone and tissue alike', dur: 13, view: 'pixel', scale: '1 cm',
      enter() { focusSnd = -1; },
      frame(t) {
        px.fillAll('ink');
        const r = field(t, { cols: COLS3, energies: ['hi'], focus: { col: 1, mat: 'soft', type: 'compton', e: 'hi', at: 1.2, P: 13 }, meters: (o, y) => bars(o, y, { lo: false }) });
        if (t > 7.5) api.mark([r.cols[0].x0, r.yDet + 2, r.cols[2].x0 + r.cw - r.cols[0].x0, 44], 'cyan', t);
      },
      caption: [
        { from: 0.8, to: 7.5, text: 'At <b>70 keV</b> the photoelectric effect has faded: in bone and soft tissue alike, photons are mostly taken by <b>Compton scatter</b>, which hardly depends on Z.' },
        { from: 7.5, to: 13, text: 'So bone stands out much less at high energy than at low. That difference between the two energies is what DXA measures.' },
      ],
    },
    {
      title: 'The R value', dur: 13, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('ink');
        const r = field(t, { cols: COLS3, energies: ['lo', 'hi'], rate: 40, meters: (o, y) => {
          // the attenuation at each energy, ln(I0/I), and their ratio
          const cx = o.x0 + o.w / 2;
          px.text(o.Alo.toFixed(2), cx, y + 6, 'yellow', 1, 1, 'center');
          px.text(o.Ahi.toFixed(2), cx, y + 14, 'cyan', 1, 1, 'center');
          px.rect(cx - 10, y + 21, 20, 1, 'mid');
          px.text((o.Alo / o.Ahi).toFixed(2), cx, y + 24, 'white', 1, 1, 'center');
        } });
        const soft = r.cols[0], spine = r.cols[1];
        api.keepOut([r.cols[0].x0, r.yDet + 2, r.cols[2].x0 + r.cw - r.cols[0].x0, 32]);
        if (t < 7.5) api.mark([soft.x0 + 2, r.yDet + 3, soft.w - 4, 30], 'pink', t);
        else api.mark([spine.x0 + 2, r.yDet + 3, spine.w - 4, 30], 'yellow', t);
      },
      caption: [
        { from: 0.8, to: 7.5, text: 'Beside the spine a ray crosses soft tissue alone. Its attenuation at 40 keV over that at 70 keV is the <b>R value</b> of this patient’s soft tissue.' },
        { from: 7.5, to: 13, text: 'Over the spine the ratio is higher: bone adds more at low energy. R is measured on every scan line, since fat and lean tissue differ slightly.' },
      ],
    },
    {
      title: 'Two equations, two unknowns', dur: 15, view: 'pixel', scale: null,
      frame(t) {
        px.fillAll('ink');
        const s = Math.min(px.H - 24, px.W - 24), x = Math.round((px.W - s) / 2), y = 8;
        const r = solvePlot(t, x, y, s, s);
        if (t > 0.5 && t < 4) api.mark([x, y, s, s], 'grey', t);
        else if (t >= 4 && t < 7) api.mark(r.lineBox, 'pink', t);
        else if (r.box) { api.mark(r.box, 'yellow', t); }
      },
      caption: [
        { from: 0.5, to: 4, text: 'Every pixel of the scan, its attenuation at 70 keV (across) against 40 keV (up).' },
        { from: 4, to: 7, text: 'Soft tissue alone, any thickness, falls on a line of slope <b>R</b>. Bone lifts a pixel above it.' },
        { from: 7, to: 10.5, text: 'Each pixel: A<sub>40</sub> = μ<sub>b,40</sub>M<sub>b</sub> + μ<sub>s,40</sub>M<sub>s</sub> and A<sub>70</sub> = μ<sub>b,70</sub>M<sub>b</sub> + μ<sub>s,70</sub>M<sub>s</sub>: two equations, two unknowns, bone and soft tissue.' },
        { from: 10.5, to: 15, text: 'Solved: <b>M<sub>b</sub> = (A<sub>40</sub> − R·A<sub>70</sub>) ÷ (μ<sub>b,40</sub> − R·μ<sub>b,70</sub>)</b>, how far bone lifts the pixel off the line. Along the dashed line the bone is the same, whatever the soft tissue.' },
      ],
    },
    {
      title: 'The soft tissue cancels', dur: 14, view: 'pixel', scale: '1 cm',
      frame(t) {
        px.fillAll('ink');
        const g = span(t, 1.5, 8);
        const cols = [0, 1, 2].map((k) => ({ layers: [['soft', 0.6], ['bone', 0.6], ['soft', lerp(1.2, 1.2 + k * 1.5, g)]] }));
        const r = field(t, { cols, energies: ['lo', 'hi'], rate: 36, meters: (o, y) => {
          const cx = o.x0 + o.w / 2;
          px.text(o.Alo.toFixed(2), cx, y + 6, 'yellow', 1, 1, 'center');
          px.text(o.Ahi.toFixed(2), cx, y + 14, 'cyan', 1, 1, 'center');
          const Mb = PH.Mb(o.Alo, o.Ahi);
          px.rect(cx - 13, y + 21, 26, 9, 'ink', 0.9); px.frame(cx - 13, y + 21, 26, 9, 'white', 0.8);
          px.text(Mb.toFixed(2), cx, y + 23, 'white', 1, 1, 'center');
        } });
        api.keepOut([r.cols[0].x0, r.yDet + 2, r.cols[2].x0 + r.cw - r.cols[0].x0, 30]);
        if (t > 8) api.mark([r.cols[0].x0 + 2, r.yDet + 20, r.cols[2].x0 + r.cw - r.cols[0].x0 - 4, 12], 'white', t);
      },
      caption: [
        { from: 0.8, to: 8, text: 'The same bone under more and more soft tissue: both attenuations climb together, along R.' },
        { from: 8, to: 14, text: 'M<sub>b</sub> does not move: 0.6 cm of bone reads the same under any amount of tissue. The soft tissue <b>cancels</b>.' },
      ],
    },
    {
      title: 'The bone mineral image', dur: 14, view: 'pixel', scale: '10 cm',
      frame(t) {
        px.fillAll('ink');
        if (!SP) return;
        const H = px.H, hs = Math.floor((H - 26) / 2), cs = hs / SP.nz, ws = SP.nx * cs;
        const hb = H - 20, cb = hb / SP.nz, wb = SP.nx * cb;
        const gap = 14, total = ws + gap + wb, x0 = Math.round((px.W - total) / 2), xb = x0 + ws + gap;
        const lo = mapCanvas(SP, 'lo', loCol), hi = mapCanvas(SP, 'hi', hiCol), bm = mapCanvas(SP, 'bmd', bmdCol), so = mapCanvas(SP, 'soft', softCol);
        const kSoft = span(t, 9.5, 11);
        blit(px, lo, x0, 8, cs, null, 1 - kSoft); blit(px, hi, x0, 12 + hs, cs, null, 1 - kSoft);
        if (kSoft > 0) blit(px, so, x0, 8, (hs * 2 + 4) / SP.nz, null, kSoft);
        px.rect(x0 - 3, 8, 2, hs, 'yellow', 0.8 * (1 - kSoft)); px.rect(x0 - 3, 12 + hs, 2, hs, 'cyan', 0.8 * (1 - kSoft));
        // the solve sweeping down, row by row
        const k = span(t, 4, 9, api.ease.linear), rows = Math.round(k * SP.nz);
        px.frame(xb - 1, 9, wb + 2, hb + 2, 'dkgrey');
        blit(px, bm, xb, 10, cb, [0, 0, SP.nx, rows]);
        if (k > 0 && k < 1) px.rect(xb, 10 + rows * cb, wb, 1, 'white', 0.9);
        api.keepOut([x0 - 4, 6, total + 6, H - 10]);
        if (t < 4) api.mark([x0 - 4, 6, ws + 6, hs * 2 + 10], 'grey', t);
        else if (t < 9.5) api.mark([xb - 2, 8, wb + 4, hb + 4], 'yellow', t);
        else api.mark([x0 - 2, 6, (hs * 2 + 4) / SP.nz * SP.nx + 4, hs * 2 + 8], 'pink', t);
      },
      caption: [
        { from: 0.6, to: 4, text: 'The scan gives two images: attenuation at <b>40 keV</b> and at <b>70 keV</b>. In both, the soft tissue dominates.' },
        { from: 4, to: 9.5, text: 'Solved pixel by pixel they become one map of <b>bone mineral</b>, g/cm²: the bowel, the muscle and the fat are gone.' },
        { from: 9.5, to: 14, text: 'The soft tissue comes out as a second map, M<sub>s</sub>: the start of body-composition scanning.' },
      ],
    },
  ];

  // small 8-bit pictures for the dose bars (no words): the densitometer, the sun (background), a chest film
  function icon(k, x, y, t) {
    if (k === 'dxa') { px.rect(x - 8, y + 2, 16, 3, 'grey'); px.rect(x - 8, y - 6, 3, 8, 'grey'); px.rect(x - 8, y - 7, 12, 3, 'grey'); px.line(x + 2, y - 4, x + 2, y + 1, 'violet'); }
    else if (k === 'day') { px.circle(x, y, 4, 'yellow', 1, true); for (let a = 0; a < 8; a++) { const q = a * Math.PI / 4 + t * 0.5; px.px(x + Math.cos(q) * 7, y + Math.sin(q) * 7, 'yellow'); } }
    else { px.rect(x - 7, y - 7, 14, 15, 'dkgrey'); for (let r = 0; r < 4; r++) { px.line(x - 5, y - 4 + r * 3, x - 1, y - 3 + r * 3, 'grey'); px.line(x + 1, y - 3 + r * 3, x + 5, y - 4 + r * 3, 'grey'); } px.rect(x, y - 6, 1, 13, 'white', 0.8); }
  }
  void lerp;
  return { title: 'The scan and the physics', steps };
}
