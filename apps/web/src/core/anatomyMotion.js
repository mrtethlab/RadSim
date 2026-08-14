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

/* ---- once per subject ------------------------------------------------------ */
export function deriveMotion(data, dims, vsMM) {
  const [nx, ny, nz] = dims;
  const cOes = new Float64Array(nz), cOesY = new Float64Array(nz), nOes = new Int32Array(nz);
  const cSto = new Float64Array(nz), cStoY = new Float64Array(nz), nSto = new Int32Array(nz);
  let lungLo = 1e9, lungHi = -1e9, nLung = 0;
  const h = { n: 0, sx: 0, sy: 0, sz: 0, x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9 };
  for (let z = 0; z < nz; z += 2) {
    for (let y = 0; y < ny; y += 2) {
      const row = (z * ny + y) * nx;
      for (let x = 0; x < nx; x += 2) {
        const id = data[row + x];
        if (id === 1) { nLung++; if (z < lungLo) lungLo = z; if (z > lungHi) lungHi = z; }
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
    // The diaphragm slab: from just below the lung base up through the lower half of the
    // lungs, weight 1 at the base tapering to 0 at the top. The shift samples superiorly,
    // which moves every boundary in the slab inferiorly — the dome descends on
    // inspiration. ~2 cm of quiet breathing.
    a.br = { z0: Math.max(0, Math.round(lungLo - 3 / vz)),
             z1: Math.round(lungLo + 0.55 * (lungHi - lungLo)),
             amp: 2.0 / vz };
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

/* ---- once per frame --------------------------------------------------------
   The clocks live in the UI (which is what makes breath-hold a one-line trick:
   stop advancing one phase and every other rhythm keeps its own time). This
   turns a set of phases into the flat state a marcher can use without branching
   on anatomy. `insp` comes back out because breathing also thins the lungs —
   an x-ray engine wants that, an acoustic one does not care. */
export function motionState(anim, p, vzCm, nz) {
  const st = { insp: 0, on: false, lo: 0, hi: 0,
    brShift: null, brZ0: 0, brZ1: 0,
    heOn: false, hx0: 0, hx1: 0, hy0: 0, hy1: 0, hz0: 0, hz1: 0,
    hcx: 0, hcy: 0, hcz: 0, hrx: 1, hry: 1, hrz: 1, hs: 1,
    swOn: false, swZ: 0, oeL: null, pinchW: 8,
    stOn: false, stZ: 0, stL: null, pinchWst: 12 };
  if (p && p.off) p = null;        // motion disabled: a verification pose, not a physiology
  st.insp = anim && anim.br && p ? Math.sin(Math.PI * (p.br || 0)) ** 2 : 0;
  if (!anim || !p) return st;
  let lo = 1e9, hi = -1e9;
  const band = (a2, b2) => { if (a2 < lo) lo = a2; if (b2 > hi) hi = b2; };
  const br = anim.br, he = anim.heart, oe = anim.oeso, sto = anim.sto;
  if (br) {
    const dz = br.amp * st.insp;
    if (dz > 0.3) {
      st.brZ0 = br.z0; st.brZ1 = br.z1;
      st.brShift = new Int16Array(nz);
      // clamped here, once, so a consumer that only breathes can add the shift straight
      // to a volume index without a bounds test in its inner loop
      for (let z = br.z0; z <= br.z1 && z < nz; z++) {
        const w = z <= br.z0 + 3 ? 1 : 1 - (z - br.z0) / (br.z1 - br.z0);
        st.brShift[z] = Math.min(nz - 1 - z, Math.round(dz * w));
      }
      band(br.z0, br.z1);
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

/* ---- per sample ------------------------------------------------------------
   Voxel-index space in, voxel-index space out, written into `out` so the caller
   allocates nothing. Guard with `st.on && z >= st.lo && z <= st.hi` first: the
   warp touches a slab, and most of a volume is not in it. */
export function warpPoint(st, x, y, z, out) {
  let re = 0;
  if (st.brShift && z >= st.brZ0 && z <= st.brZ1) {
    const s = st.brShift[z | 0];
    if (s) { z += s; re = 1; }
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
