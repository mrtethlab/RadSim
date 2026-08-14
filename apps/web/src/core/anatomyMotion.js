/* ============================================================================
   ANATOMY IN MOTION — regions derived from the subject's own segmentation

   Nothing here is animated by hand. The lungs give the diaphragm, the heart
   label gives the heart its ellipsoid, and the oesophagus and stomach lumens
   give the centre-lines a peristaltic wave runs along. Change the subject and
   the motion changes with it, because it was never authored — it was measured.

   The warp is applied to the SAMPLE POSITION, not to the volume: nothing is
   ever rewritten, each engine simply reads from somewhere else. That is what
   makes it affordable at 9 M cells per fluoro pulse and 100 k samples per
   ultrasound frame alike.

   Three pieces, in the order an engine uses them:
     deriveMotion   once per subject   — find the regions (a few ms)
     motionState    once per frame     — turn the clocks into a warp
     warpPoint      per sample         — where to read from instead

   Fluoro inlines the last step by hand inside its DDA (a function call per cell
   is not free at 9 M cells); ultrasound calls warpPoint. Both share the first
   two, which is where all the anatomy knowledge lives.
   ============================================================================ */

/* The trunk's own axis and half-extents through the breathing band, from the body
   outline itself — the ellipse the radial taper is measured against. */
function coreOf(data, dims, zDia, down, up) {
  const [nx, ny, nz] = dims;
  const z0 = Math.max(0, zDia - down), z1 = Math.min(nz - 1, zDia + up);
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
  for (let z = z0; z <= z1; z += 3) {
    for (let y = 0; y < ny; y += 2) {
      const row = (z * ny + y) * nx;
      for (let x = 0; x < nx; x += 2) {
        if (data[row + x] === 0) continue;              // air is not the patient
        n++; sx += x; sy += y; sxx += x * x; syy += y * y;
      }
    }
  }
  if (n < 200) return null;
  const cx = sx / n, cy = sy / n;
  // 2 sigma reaches the surface for a roughly elliptical cross-section
  return { cx, cy, rx: 2 * Math.sqrt(Math.max(1, sxx / n - cx * cx)),
           ry: 2 * Math.sqrt(Math.max(1, syy / n - cy * cy)) };
}

/* ---- once per subject ------------------------------------------------------ */
export function deriveMotion(data, dims, vsMM) {
  const [nx, ny, nz] = dims;
  const cOes = new Float64Array(nz), cOesY = new Float64Array(nz), nOes = new Int32Array(nz);
  const cSto = new Float64Array(nz), cStoY = new Float64Array(nz), nSto = new Int32Array(nz);
  let nLung = 0, nLiver = 0, sLiverZ = 0;
  const lungZ = new Int32Array(nz);              // lung voxels per slice — a robust profile
  const h = { n: 0, sx: 0, sy: 0, sz: 0, x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9 };
  for (let z = 0; z < nz; z += 2) {
    for (let y = 0; y < ny; y += 2) {
      const row = (z * ny + y) * nx;
      for (let x = 0; x < nx; x += 2) {
        const id = data[row + x];
        if (id === 1) { nLung++; lungZ[z]++; }
        else if (id === 11) { nLiver++; sLiverZ += z; }
        else if (id === 15) {
          h.n++; h.sx += x; h.sy += y; h.sz += z;
          if (x < h.x0) h.x0 = x; if (x > h.x1) h.x1 = x;
          if (y < h.y0) h.y0 = y; if (y > h.y1) h.y1 = y;
          if (z < h.z0) h.z0 = z; if (z > h.z1) h.z1 = z;
        } else if (id === 48) { cOes[z] += x; cOesY[z] += y; nOes[z]++; }
        else if (id === 49) { cSto[z] += x; cStoY[z] += y; nSto[z]++; }
      }
    }
  }
  const a = { any: false };
  const vz = vsMM[2] / 10;
  if (nLung > 200) {
    /* BREATHING IS A BUMP CENTRED ON THE DIAPHRAGM, NOT A SLAB.
       The first version ran a linear ramp from the bottom of the VOLUME (the lower edge
       clamped to z = 0, weight 1) up to mid-chest, so the whole pelvis-to-chest block slid
       inferiorly together and was sheared over 39 cm. That is what put a low-density strip
       across the abdomen and a travelling indent in the skin, and — because the weight was
       flat over most of it — what made the entire region snap in 2 mm steps and appear to
       reset at end-expiration.

       What actually moves: the dome moves most; the liver directly under it goes with it
       almost as a unit for a few centimetres and then progressively less, reaching nothing
       by the mid-abdomen; above it the lung base follows the dome while the apex stays put,
       because the lung stretches rather than translating. So: a plateau at the dome, a
       cosine taper to zero at both ends, and nothing at all outside. Zero slope where it
       meets still tissue, which is what removes the seam. */
    /* WHERE THE DOME IS, ROBUSTLY. The first version took the min and max z of every
       voxel labelled lung, so a handful of stray mislabelled voxels at the ends of the
       volume set the whole region: on this subject that returned a lung spanning z = 4 to
       355 of 356 — the entire scan — which is how the band came to cover the pelvis. Per
       slice counts and a fraction-of-peak threshold ignore the strays. */
    let peak = 0;
    for (let z = 0; z < nz; z++) if (lungZ[z] > peak) peak = lungZ[z];
    const thr = peak * 0.08;
    let zA = -1, zB = -1;
    for (let z = 0; z < nz; z++) if (lungZ[z] >= thr) { if (zA < 0) zA = z; zB = z; }
    // WHICH END IS THE DIAPHRAGM: the one nearer the liver, since the liver sits under it.
    // That also settles the z orientation, which differs between models and must not be
    // assumed — get it backwards and the dome RISES on inspiration.
    const zLiver = nLiver > 50 ? sLiverZ / nLiver : (zA + zB) / 2;
    const dome = Math.abs(zA - zLiver) < Math.abs(zB - zLiver) ? zA : zB;
    const apexEnd = dome === zA ? zB : zA;
    const dirApex = Math.sign(apexEnd - dome) || 1;
    const lungH = Math.abs(apexEnd - dome) * vz;
    a.br = {
      zDia: Math.round(dome),
      dirApex,                                           // +1 or -1: toward the lung apex
      down: Math.max(4, Math.round(9 / vz)),             // liver and gut fade out over ~9 cm
      up: Math.max(4, Math.round(Math.max(7, 0.7 * lungH) / vz)),  // base moves, apex does not
      plat: 0.34,                                        // fraction of `down` that moves as a unit
      amp: 1.8 / vz,                                     // quiet-breathing dome excursion, cm
    };
    /* THE BODY WALL DOES NOT MOVE LIKE THE VISCERA. Measured off a real chest
       fluoroscopy run, the lateral chest wall travels 29 % of what the dome does (23 px
       against 80). A warp that is a pure function of z cannot tell wall from liver, so
       everything moved together and the skin got a travelling indent nobody has. An
       elliptical taper about the trunk's own axis fixes it: full shift through the core,
       falling to a third of it at the surface. */
    const c = coreOf(data, dims, Math.round(dome), a.br.down, a.br.up);
    if (c) { a.br.cx = c.cx; a.br.cy = c.cy; a.br.irx = 1 / c.rx; a.br.iry = 1 / c.ry; a.br.wall = 0.3; }
    a.any = true;
  }
  if (h.n > 50) {
    a.heart = { cx: h.sx / h.n, cy: h.sy / h.n, cz: h.sz / h.n,
      rx: (h.x1 - h.x0) * 0.55 + 2, ry: (h.y1 - h.y0) * 0.55 + 2, rz: (h.z1 - h.z0) * 0.55 + 2 };
    a.any = true;
  }
  const line = (cx, cy, cnt) => {
    let z0 = -1, z1 = -1;
    for (let z = 0; z < nz; z++) if (cnt[z] > 0) { if (z0 < 0) z0 = z; z1 = z; }
    if (z0 < 0 || z1 - z0 < 6) return null;
    const lx = new Float64Array(nz), ly = new Float64Array(nz);
    let px = 0, py = 0;
    for (let z = z0; z <= z1; z++) {            // fill gaps by carrying the last centroid
      if (cnt[z] > 0) { px = cx[z] / cnt[z]; py = cy[z] / cnt[z]; }
      lx[z] = px; ly[z] = py;
    }
    return { z0, z1, lx, ly };
  };
  a.oeso = line(cOes, cOesY, nOes);
  a.sto = line(cSto, cStoY, nSto);
  if (a.oeso || a.sto) a.any = true;
  return a.any ? a : null;
}

/* QUIET BREATHING IS NOT A SINE. Inspiration is active and quick, expiration is passive
   and slower, and there is a pause on empty before the next breath — which is precisely
   what a symmetric sin² does not have, and why the old one read as a machine ticking
   rather than someone lying on a table. 40 % in, 45 % out, 15 % waiting. The curve is
   flat at every junction and at the wrap, so nothing steps as the cycle comes round. */
export function breathAmp(ph) {
  const p = ((ph % 1) + 1) % 1;
  const TI = 0.40, TE = 0.45;
  if (p < TI) return 0.5 - 0.5 * Math.cos(Math.PI * p / TI);
  if (p < TI + TE) return 0.5 + 0.5 * Math.cos(Math.PI * (p - TI) / TE);
  return 0;                                    // the end-expiratory pause
}

/* ---- once per frame --------------------------------------------------------
   The clocks live in the UI (which is what makes breath-hold a one-line trick:
   stop advancing one phase and every other rhythm keeps its own time). This
   turns a set of phases into the flat state a marcher can use without branching
   on anatomy. `insp` comes back out because breathing also thins the lungs —
   an x-ray engine wants that, an acoustic one does not care. */
export function motionState(anim, p, vzCm, nz) {
  const st = { insp: 0, on: false, lo: 0, hi: 0,
    brShift: null, brZ0: 0, brZ1: 0, brCore: false, brWall: 1,
    brCx: 0, brCy: 0, brIrx: 0, brIry: 0,
    heOn: false, hx0: 0, hx1: 0, hy0: 0, hy1: 0, hz0: 0, hz1: 0,
    hcx: 0, hcy: 0, hcz: 0, hrx: 1, hry: 1, hrz: 1, hs: 1,
    swOn: false, swZ: 0, oeL: null, pinchW: 8,
    stOn: false, stZ: 0, stL: null, pinchWst: 12 };
  if (p && p.off) p = null;        // motion disabled: a verification pose, not a physiology
  st.insp = anim && anim.br && p ? breathAmp(p.br || 0) : 0;
  if (!anim || !p) return st;
  let lo = 1e9, hi = -1e9;
  const band = (a2, b2) => { if (a2 < lo) lo = a2; if (b2 > hi) hi = b2; };
  const br = anim.br, he = anim.heart, oe = anim.oeso, sto = anim.sto;
  if (br) {
    const dz = br.amp * st.insp;
    if (dz > 0.02) {
      const eApex = br.zDia + br.dirApex * br.up, eAbd = br.zDia - br.dirApex * br.down;
      const z0 = Math.max(0, Math.min(eApex, eAbd)), z1 = Math.min(nz - 1, Math.max(eApex, eAbd));
      st.brZ0 = z0; st.brZ1 = z1;
      st.brCx = br.cx; st.brCy = br.cy; st.brIrx = br.irx; st.brIry = br.iry;
      st.brWall = br.wall == null ? 1 : br.wall;
      st.brCore = br.irx != null;
      // A FLOAT table, because the shift is scaled per sample by the radial taper below
      // and lands on a real position either way. Clamped once here so neither consumer
      // needs a bounds test inside its loop.
      st.brShift = new Float32Array(nz);
      for (let z = z0; z <= z1; z++) {
        const d = (z - br.zDia) * br.dirApex;        // + toward the apex, - toward the gut
        let w;
        if (d >= 0) {
          w = 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, d / br.up));
        } else {
          const t = -d / br.down;                    // below: a plateau, then a taper
          w = t < br.plat ? 1
            : 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, (t - br.plat) / (1 - br.plat)));
        }
        // sampling TOWARD the apex is what makes the dome descend
        const s = Math.max(-z, Math.min(nz - 1 - z, br.dirApex * dz * w));
        st.brShift[z] = s;
      }
      band(z0, z1);
    }
  }
  // cardiac contraction: a sin^2 systolic pulse over the first 40 % of the cycle
  const cph = p.card || 0;
  const sysP = cph < 0.4 ? Math.sin(Math.PI * cph / 0.4) ** 2 : 0;
  st.heOn = !!he && sysP > 0.02;
  if (st.heOn) {
    st.hs = 1 / (1 - 0.08 * sysP);
    st.hcx = he.cx; st.hcy = he.cy; st.hcz = he.cz;
    st.hrx = he.rx; st.hry = he.ry; st.hrz = he.rz;
    st.hx0 = he.cx - he.rx; st.hx1 = he.cx + he.rx;
    st.hy0 = he.cy - he.ry; st.hy1 = he.cy + he.ry;
    st.hz0 = he.cz - he.rz; st.hz1 = he.cz + he.rz;
    band(st.hz0, st.hz1);
  }
  st.pinchW = 1.5 / vzCm;
  st.pinchWst = st.pinchW * 1.6;
  // swallow: a constriction wave running the oesophagus top -> bottom in ~1.2 s
  st.swOn = !!oe && p.sw != null && p.sw >= 0 && p.sw < 1.6;
  if (st.swOn) {
    st.swZ = oe.z1 - (oe.z1 - oe.z0) * (Math.min(p.sw, 1.2) / 1.2);
    st.oeL = oe;
    band(st.swZ - st.pinchW, st.swZ + st.pinchW);
  }
  // stomach peristalsis: slow waves crawling aborally, one every ~7 s
  st.stOn = !!sto;
  if (st.stOn) {
    st.stZ = sto.z1 - ((p.peri || 0) * (sto.z1 - sto.z0) / 7) % (sto.z1 - sto.z0);
    st.stL = sto;
    band(st.stZ - st.pinchWst, st.stZ + st.pinchWst);
  }
  if (lo <= hi) { st.on = true; st.lo = lo; st.hi = hi; }
  return st;
}

/* The radial part of the breathing profile: 1 through the trunk's core, tapering to
   `wall` at the surface. Kept branchy on purpose — nearly every sample is either well
   inside or well outside, and only the annulus between pays for the square root. */
export function brWall(st, x, y) {
  if (!st.brCore) return 1;
  const ex = (x - st.brCx) * st.brIrx, ey = (y - st.brCy) * st.brIry;
  const t2 = ex * ex + ey * ey;
  if (t2 <= 0.3025) return 1;                     // core (t <= 0.55)
  if (t2 >= 1) return st.brWall;                  // at or beyond the surface
  const t = Math.sqrt(t2);
  return st.brWall + (1 - st.brWall) * (0.5 + 0.5 * Math.cos(Math.PI * (t - 0.55) / 0.45));
}

/* ---- per sample ------------------------------------------------------------
   Voxel-index space in, voxel-index space out, written into `out` so the caller
   allocates nothing. Guard with `st.on && z >= st.lo && z <= st.hi` first: the
   warp touches a slab, and most of a volume is not in it. */
export function warpPoint(st, x, y, z, out) {
  let re = 0;
  if (st.brShift && z >= st.brZ0 && z <= st.brZ1) {
    let s = st.brShift[z | 0];
    if (s) { s *= brWall(st, x, y); z += s; re = 1; }
  }
  if (st.heOn && x > st.hx0 && x < st.hx1 && y > st.hy0 && y < st.hy1 && z > st.hz0 && z < st.hz1) {
    const ex = (x - st.hcx) / st.hrx, ey = (y - st.hcy) / st.hry, ez = (z - st.hcz) / st.hrz;
    if (ex * ex + ey * ey + ez * ez < 1) {
      x = st.hcx + (x - st.hcx) * st.hs;
      y = st.hcy + (y - st.hcy) * st.hs;
      z = st.hcz + (z - st.hcz) * st.hs;
      re = 1;
    }
  }
  const zi = z | 0;
  if (st.swOn && z > st.swZ - st.pinchW && z < st.swZ + st.pinchW && zi >= st.oeL.z0 && zi <= st.oeL.z1) {
    const g = Math.cos(Math.PI / 2 * (z - st.swZ) / st.pinchW) ** 2;
    const f = 1 + 0.9 * g;
    x = st.oeL.lx[zi] + (x - st.oeL.lx[zi]) * f;
    y = st.oeL.ly[zi] + (y - st.oeL.ly[zi]) * f;
    re = 1;
  }
  if (st.stOn && z > st.stZ - st.pinchWst && z < st.stZ + st.pinchWst && zi >= st.stL.z0 && zi <= st.stL.z1) {
    const g = Math.cos(Math.PI / 2 * (z - st.stZ) / st.pinchWst) ** 2;
    const f = 1 + 0.35 * g;
    x = st.stL.lx[zi] + (x - st.stL.lx[zi]) * f;
    y = st.stL.ly[zi] + (y - st.stL.ly[zi]) * f;
    re = 1;
  }
  out[0] = x; out[1] = y; out[2] = z;
  return re;
}
