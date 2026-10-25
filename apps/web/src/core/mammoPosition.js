/* Mammographic positioning: the geometry a technologist controls, and the image criteria it
   is judged by (docs/mammography.md §7). Pure — no DOM, no volume — so the judging is tested
   on its own.

   THE MODEL. A real view is good or bad by how much tissue it brought onto the receptor, and
   every positioning manoeuvre is a way of bringing more: pull the breast forward off the chest
   wall, lift the inframammary fold up and out, set the C-arm parallel to the pectoral muscle so
   the receptor's corner reaches into the axilla, rotate so medial tissue is not left behind. The
   phantom is cut at the chest wall, so all of them land on ONE quantity: how many centimetres of
   posterior tissue stay behind the receptor's chest-wall edge, per image column (edgeLossCm).
   The projector shifts the anatomy by that much per column — tissue behind the edge never
   reaches the detector — and everything the criteria read (the posterior nipple line, how far
   down the pectoral muscle runs, its angle and the shape of its border, the IMF) follows from
   the image that results. Nothing is graded from the slider positions: the judge reads the
   EXPOSED IMAGE's own maps (measureView), exactly as a reader with a ruler would.

   Coordinates. The image is the detector's: u (cm) runs along a detector row from the breast's
   centre line, + lateral on the CC and + superolateral (toward the axilla) on the MLO; y (cm)
   runs from the chest-wall edge (row 0) toward the nipple. Anatomy is the phantom's frame, in
   cm: X lateral, Y chest wall -> nipple, Z inferior -> superior, about the mound's centre.

   The patient comes with the reading case: the angle of her pectoral muscle (her build — the
   C-arm must match it), which way her nipple points at rest (the roll that brings it into
   profile), and how far her inframammary fold will travel (where to set the CC's height). A
   technologist sees those at the machine; the console says them in words. */

const D2R = Math.PI / 180;

export const PATIENTS = {
  demo: { pecDeg: 50, nipDeg: 0,   imfOpt: 0.60, build: 'average build — pectoral muscle near 50°; nipple points straight ahead' },
  A:    { pecDeg: 42, nipDeg: -14, imfOpt: 0.50, build: 'short, broad-chested — a flatter pectoral muscle; nipple points slightly down' },
  B:    { pecDeg: 58, nipDeg: 12,  imfOpt: 0.70, build: 'tall and slender — a steep pectoral muscle; nipple points slightly up' },
  C:    { pecDeg: 47, nipDeg: -18, imfOpt: 0.55, build: 'average height, heavier build — nipple points down' },
  D:    { pecDeg: 55, nipDeg: 10,  imfOpt: 0.65, build: 'tall — a steeper pectoral muscle; nipple points slightly up' },
  E:    { pecDeg: 44, nipDeg: 0,   imfOpt: 0.50, build: 'short — a flatter pectoral muscle; nipple points straight ahead' },
};
export const patientFor = (id) => PATIENTS[id] || PATIENTS.demo;

// where the console starts: a breast placed but not yet worked — tissue left on the chest wall,
// the fold not lifted, the C-arm at the default 45°. Positioning is what the learner adds.
export const POS_DEFAULT = {
  cc:  { pull: 0.45, lift: 0.30, rot: 0, roll: 0 },
  mlo: { pull: 0.45, lift: 0.30, angle: 45, roll: 0 },
};
export const ROLL_DEG = 25;          // the roll control's full travel, degrees of nipple tilt

/* Posterior tissue left behind the receptor's chest-wall edge (anatomy cm) at in-plane
   coordinate u (anatomy cm). The terms are the reasons a real view loses tissue:
     pull   — the breast not drawn forward off the chest wall: loses tissue everywhere;
     CC     — the fold set too low or too high (the receptor belongs at the IMF's natural
              mobility: below it the inferior-posterior tissue drops off, above it the superior
              pulls away), and rotation, which trades medial tissue for lateral across the row;
     MLO    — a C-arm not parallel to the pectoral muscle cannot reach into the axilla
              (quadratic: five degrees costs little, fifteen costs the muscle); and a fold not
              lifted up and out drops the inferior-posterior corner. */
export function edgeLossCm(view, p, pat, u) {
  const base = 0.15 + 4.2 * (1 - p.pull);
  let L;
  if (view === 'mlo') {
    const dA = Math.abs(p.angle - pat.pecDeg);
    const ramp = Math.min(1, Math.max(0, (-u - 2.6) / 2.4));
    L = mloPecLossCm(p, pat) + 1.2 * (1 - p.lift) * ramp;
  } else {
    L = base + 1.6 * Math.abs(p.lift - pat.imfOpt) + 1.6 * p.rot * (u / 6.4);
  }
  return Math.max(0, L);
}
// the MLO's loss across the pectoral muscle's run (no fold term: the muscle is superior)
export const mloPecLossCm = (p, pat) => 0.15 + 4.2 * (1 - p.pull) + 0.007 * (p.angle - pat.pecDeg) ** 2;

/* The inframammary fold on the MLO: how far the breast's inferior contour stands clear of the
   upper abdomen at the chest-wall edge (cm, detector). Lifted up and out, the fold opens; left
   to sag, the breast lies on the abdomen and the two overlap — a skin fold across the
   inferior breast. */
export const imfGapCm = (p) => -1.5 + 3.2 * p.lift;

/* The nipple's tilt out of the image plane (degrees; 0 = in profile). The patient's nipple
   points where it points; the CC's beam axis is vertical, so all of a downward tilt is out of
   plane, while the MLO's oblique beam sees cos(angle) of it. The roll control is the
   technologist rolling the tissue to bring the nipple back into profile. */
export function nippleTiltDeg(view, p, pat) {
  const nat = view === 'mlo' ? pat.nipDeg * Math.cos(p.angle * D2R) : pat.nipDeg;
  return nat + ROLL_DEG * p.roll;
}

/* The pectoral muscle that each view brings into the field (anatomy cm of depth in front of
   the chest-wall cut). The MLO's is the lateral free edge of pectoralis major, oriented with
   the patient's muscle: deepest toward the axilla and tapering to a tip just above the nipple
   level — a wedge whose anterior border is convex, as a relaxed muscle's is. The CC brings
   only the thin sheet on the chest wall, deepest centrally: it shows only when the breast is
   pulled very well, which is why only about a third of good CCs show any muscle at all.
   The shape of the MLO border is the C-arm's doing, not the patient's: parallel to the muscle,
   the relaxed muscle drapes forward across the run that clears the receptor's edge and its
   border bulges (convex); a few degrees off, the receptor's corner stretches it flat; further
   off, its middle is drawn back (concave). So the wedge is straight-edged, and the drape B
   (cm, + forward) is laid along the visible run — from where the muscle clears an edge loss
   of L0 to its top. */
export const MLO_PEC = { D: 2.4, W: 4.8, tip: 0.6 };
export const mloPecDrapeCm = (dA, L0 = 0) =>
  Math.max(-0.45 * Math.max(0, MLO_PEC.D - L0), 0.45 - 0.015 * dA * dA);
export function mloMuscleDepthCm(w, L0 = 0, B = 0) {
  const { D, W, tip } = MLO_PEC;
  if (w <= tip) return 0;
  const d = D * (w - tip) / (W - tip), wT = tip + (W - tip) * L0 / D;
  return wT < W && w > wT && w < W ? d + B * Math.sin(Math.PI * (w - wT) / (W - wT)) : d;
}
export const ccMuscleDepthCm = (X) => Math.max(0, 0.75 * (1 - (X / 5) ** 2));

/* ---- measuring the exposed image -------------------------------------------------------
   Input: the detector's own maps from the exposure, one value per pixel — tissue chord (cm,
   everything of the breast except the nipple), pectoral muscle chord, nipple chord, and the
   upper abdomen's chord (MLO only). The landmarks are read off them the way a reader reads a
   film: the outline, the muscle's anterior border column by column, the nipple, the fold. */
export const TH = { tissue: 0.05, muscle: 0.3, nipple: 0.05, profile: 0.5 };

export function measureView(m) {
  const { view, nx, ny, fovX, fovY, breast, muscle, nipple, abdomen } = m;
  const pxU = fovX / nx, pxY = fovY / ny;
  const U = (i) => ((i + 0.5) / nx - 0.5) * fovX, Y = (j) => (j + 0.5) * pxY;
  const col = (u) => Math.min(nx - 1, Math.max(0, Math.round((u / fovX + 0.5) * nx - 0.5)));

  // the outline: tissue depth from the chest-wall edge, per column
  const depth = new Float32Array(nx).fill(-1);
  for (let i = 0; i < nx; i++) {
    for (let j = ny - 1; j >= 0; j--) if (breast[j * nx + i] > TH.tissue) { depth[i] = Y(j) + pxY / 2; break; }
  }
  // cut-off: tissue running off a side or the anterior edge (the chest-wall edge is supposed to)
  const cutoff = [];
  let l = 0, r = 0, a = 0;
  for (let j = 0; j < ny; j++) { if (breast[j * nx] > TH.tissue) l++; if (breast[j * nx + nx - 1] > TH.tissue) r++; }
  for (let i = 0; i < nx; i++) if (breast[(ny - 1) * nx + i] > TH.tissue) a++;
  if (l) cutoff.push(view === 'mlo' ? 'inferior edge' : 'medial edge');
  if (r) cutoff.push(view === 'mlo' ? 'superior edge' : 'lateral edge');
  if (a) cutoff.push('anterior edge');

  // the nipple: its centroid, and how much of it stands clear of the skin line (in profile)
  let sw = 0, su = 0, sy = 0, nN = 0, nOut = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, v = nipple[k];
    if (v <= TH.nipple) continue;
    sw += v; su += v * U(i); sy += v * Y(j); nN++;
    if (breast[k] <= TH.tissue) nOut++;
  }
  let nip;
  if (nN) {
    const nu = su / sw, ny_ = sy / sw;
    nip = { u: nu, y: ny_, seen: true, profile: nOut / nN, inProfile: nOut / nN >= TH.profile,
            insideCm: Math.max(0, depth[col(nu)] - ny_) };
  } else {                                   // no nipple on the film: the outline's apex stands in
    let bi = 0; for (let i = 0; i < nx; i++) if (depth[i] > depth[bi]) bi = i;
    nip = { u: U(bi), y: Math.max(0, depth[bi]), seen: false, profile: 0, inProfile: false, insideCm: 0 };
  }

  // the pectoral muscle's anterior border: the run of muscle down from the chest-wall edge
  const border = new Float32Array(nx);
  for (let i = 0; i < nx; i++) {
    let j = 0; while (j < ny && muscle[j * nx + i] > TH.muscle) j++;
    border[i] = j * pxY;
  }
  // the columns where the border is the muscle's own free edge (not the skin it runs into)
  const ok = (i) => border[i] >= 2 * pxY && border[i] < depth[i] - 2 * pxY;
  let best = null;
  for (let i = 0; i < nx;) {                 // the longest contiguous run is the muscle
    if (!ok(i)) { i++; continue; }
    let e = i; while (e + 1 < nx && ok(e + 1)) e++;
    if (!best || e - i > best[1] - best[0]) best = [i, e];
    i = e + 1;
  }
  let mus = null;
  if (best) {
    // the muscle widens toward the axilla until the skin outline cuts it off: the border is
    // the muscle's own only up to its widest column, and the run is trimmed there
    let im = best[0]; for (let i = best[0]; i <= best[1]; i++) if (border[i] >= border[im]) im = i;
    const tipLeft = best[1] - im <= im - best[0];   // the tip is the far end
    if (tipLeft) best[1] = im; else best[0] = im;
  }
  if (best && (best[1] - best[0] + 1) * pxU >= 0.4) {
    const [i0, i1] = best;
    let n = 0, Su = 0, Sy = 0, Suu = 0, Suy = 0;
    for (let i = i0; i <= i1; i++) { const u = U(i), y = border[i]; n++; Su += u; Sy += y; Suu += u * u; Suy += u * y; }
    const den = n * Suu - Su * Su;
    const b = den > 1e-12 ? (n * Suy - Su * Sy) / den : 0, a0 = (Sy - b * Su) / n;
    // shape: the border against the chord joining its two ends; + bulges anteriorly (convex)
    const ua = U(i0), ub = U(i1), ya = border[i0], yb = border[i1];
    let dev = 0;
    for (let i = i0; i <= i1; i++) dev += border[i] - (ya + (yb - ya) * (U(i) - ua) / (ub - ua || 1));
    dev /= n;
    // on the MLO the muscle tapers toward the IMF: its tip is the run's inferior (-u) end
    let maxD = 0; for (let i = i0; i <= i1; i++) maxD = Math.max(maxD, border[i]);
    mus = { i0, i1, uTip: Math.min(ua, ub), uTop: Math.max(ua, ub), a: a0, b,
            angleDeg: Math.atan(Math.abs(b)) / D2R, devCm: dev, maxDepthCm: maxD,
            shape: dev >= 0.1 ? 'convex' : dev > -0.07 ? 'straight' : 'concave' };
  }

  const out = { view, nipple: nip, depth, cutoff, muscle: mus, border, pxU, pxY };

  // the posterior nipple line
  if (view === 'mlo') {
    // nipple to the pectoral muscle, PERPENDICULAR to the muscle; or to the film edge where
    // the line meets it first, which is what a muscle too short to reach the line forces
    if (mus) {
      const e = [1 / Math.hypot(1, mus.b), mus.b / Math.hypot(1, mus.b)];
      const t = (nip.u - 0) * e[0] + (nip.y - mus.a) * e[1];
      let F = [t * e[0], mus.a + t * e[1]];
      const foot = F.slice();
      let toMuscle = true;
      if (F[1] < 0) {                         // the line leaves the film before it meets the muscle
        const s = nip.y / (nip.y - F[1]);
        F = [nip.u + s * (F[0] - nip.u), 0]; toMuscle = false;
      }
      const reach = (foot[0] - mus.uTip) * Math.hypot(1, mus.b);   // + : muscle runs past the line
      out.pnl = { cm: Math.hypot(nip.u - F[0], nip.y - F[1]), from: [nip.u, nip.y], to: F, toMuscle, reachCm: reach };
    } else {
      out.pnl = { cm: nip.y, from: [nip.u, nip.y], to: [nip.u, 0], toMuscle: false, reachCm: null };
    }
    // the inframammary fold, at the chest-wall rows: breast's inferior contour vs the abdomen
    if (abdomen) {
      const rows = Math.max(2, Math.ceil(0.6 / pxY));
      let gap = Infinity, seen = false, over = 0, uB = null, uA = null;
      for (let j = 0; j < rows && j < ny; j++) {
        let bmin = Infinity, amax = -Infinity;
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          if (breast[k] > TH.tissue && U(i) < bmin) bmin = U(i);
          if (abdomen[k] > TH.tissue && U(i) > amax) amax = U(i);
        }
        if (amax > -Infinity) seen = true;
        if (bmin < Infinity && amax > -Infinity && bmin - amax < gap) { gap = bmin - amax; uB = bmin; uA = amax; }
      }
      for (let k = 0; k < breast.length; k++) if (breast[k] > TH.tissue && abdomen[k] > TH.tissue) over++;
      out.imf = { seen, gapCm: seen && gap < Infinity ? gap : null, overlapCm2: over * pxU * pxY, uBreast: uB, uAbd: uA };
    }
  } else {
    // CC: nipple straight back to the chest-wall edge — or to the muscle, if it is on the film
    const ib = col(nip.u), bm = border[ib] >= 2 * pxY ? border[ib] : 0;
    out.pnl = { cm: nip.y - bm, from: [nip.u, nip.y], to: [nip.u, bm], toMuscle: bm > 0 };
    // medial vs lateral: posterior depth at mirror-image columns either side of the breast's
    // centre at the chest wall. The phantom is symmetric, so any difference is positioning.
    let i0 = -1, i1 = -1;
    for (let i = 0; i < nx; i++) if (breast[nx + i] > TH.tissue) { if (i0 < 0) i0 = i; i1 = i; }
    if (i0 >= 0) {
      const c = (U(i0) + U(i1)) / 2, hw = (U(i1) - U(i0)) / 2;
      const avg = (u) => { const ic = col(u); let s = 0, n = 0; for (let i = ic - 3; i <= ic + 3; i++) if (i >= 0 && i < nx && depth[i] > 0) { s += depth[i]; n++; } return n ? s / n : 0; };
      const dl = avg(c + 0.5 * hw), dm = avg(c - 0.5 * hw);
      out.ml = { medCm: dm, latCm: dl, medDeficitCm: dl - dm };
    }
    let pec = 0;
    for (let i = 0; i < nx; i++) if (border[i] >= 2 * pxY && border[i] < depth[i] && border[i] > pec) pec = border[i];
    out.pecSeen = pec > 0;
    out.pecCm = pec;
  }
  return out;
}

/* ---- judging: the criteria, graded the PGMI way -----------------------------------------
   Every criterion carries a severity — 0 met, 1 minor, 2 moderate, 3 major — and the view's
   grade follows the worst of them, as the PGMI scheme grades: Perfect (all met), Good (minor
   deviations only), Moderate (a moderate deviation, or three minors — the breast is imaged but
   clearly short of the standard), Inadequate (tissue missing or cut off: repeat the view).
   An informational line carries sev -1; a criterion that needs the other view first, null. */
export const GRADE_NAME = { P: 'Perfect', G: 'Good', M: 'Moderate', I: 'Inadequate' };
export function pgmi(items) {
  const s = items.map((it) => it.sev).filter((v) => v != null && v >= 0);
  const worst = s.length ? Math.max(...s) : 0;
  if (worst >= 3) return 'I';
  if (worst === 2 || s.filter((v) => v === 1).length >= 3) return 'M';
  return worst === 1 ? 'G' : 'P';
}
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const band = (v, cuts) => { let k = 0; while (k < cuts.length && v > cuts[k]) k++; return k; };

export function judgeView(meas, other) {
  const items = [], v = meas.view;
  const nip = meas.nipple;
  if (v === 'mlo') {
    const p = meas.pnl, mus = meas.muscle;
    items.push({ key: 'pnl', label: 'Posterior nipple line', sev: -1,
      value: `${f1(p.cm)} cm, ${p.toMuscle ? 'to the pectoral muscle' : 'to the film edge'}` });
    if (!mus) {
      items.push({ key: 'pec', label: 'Pectoral muscle to the PNL', sev: 3, value: 'no muscle on the film',
        tip: 'Pull the breast forward and set the C-arm parallel to the muscle: without it the posterior tissue is not on the film.' });
    } else {
      const r = p.reachCm;
      items.push({ key: 'pec', label: 'Pectoral muscle to the PNL', sev: r >= 0 ? 0 : 1 + band(-r, [1, 2]),
        value: r >= 0 ? `runs ${f1(r)} cm past the PNL` : `ends ${f1(-r)} cm short of the PNL`,
        tip: r >= 0 ? '' : 'More posterior tissue: pull forward, and match the C-arm to the muscle so the receptor reaches the axilla.' });
      items.push({ key: 'shape', label: 'Pectoral border convex or straight',
        sev: mus.shape !== 'concave' ? 0 : mus.devCm > -0.25 ? 1 : 2,
        value: `${mus.shape} (${mus.devCm >= 0 ? '+' : '−'}${Math.round(Math.abs(mus.devCm) * 10)} mm)`,
        tip: mus.shape === 'concave' ? 'A concave border is a muscle not relaxed into the field — usually a C-arm angle that does not match it.' : '' });
      const ang = mus.angleDeg;
      items.push({ key: 'angle', label: 'Pectoral muscle at the proper angle',
        sev: ang >= 15 && ang <= 45 ? 0 : (ang >= 10 && ang <= 55) ? 1 : 2,
        value: `${Math.round(ang)}° to the chest-wall edge`,
        tip: ang < 15 ? 'Too flat a strip of muscle: not enough was brought in — check the C-arm angle against her build.' : ang > 45 ? 'Too steep.' : '' });
    }
    const im = meas.imf;
    if (im) {
      const g = im.gapCm;
      items.push({ key: 'imf', label: 'Inframammary fold open',
        sev: !im.seen ? 2 : g == null ? 2 : g >= 0.1 ? 0 : g > -0.4 ? 1 : 2,
        value: !im.seen ? 'not on the film' : g >= 0.1 ? `open, ${f1(g)} cm clear of the abdomen`
          : g > -0.4 ? 'closed' : `closed — a skin fold over the inferior breast (${f1(im.overlapCm2)} cm²)`,
        tip: g != null && g >= 0.1 ? '' : 'Lift the breast up and out before compressing, so it does not sag onto the abdomen.' });
    }
  } else {
    const p = meas.pnl;
    let sev = null, value = `${f1(p.cm)} cm — expose the MLO to compare`, tip = '';
    if (other && other.pnl) {
      const d = p.cm - other.pnl.cm;
      sev = band(Math.abs(d), [1, 1.5, 2]);
      value = `CC ${f1(p.cm)} vs MLO ${f1(other.pnl.cm)} cm (${d >= 0 ? '+' : '−'}${f1(Math.abs(d))})`;
      if (sev) tip = d < 0 ? 'The CC is short of posterior tissue: pull forward, and set the receptor at the fold’s natural height.'
                           : 'The CC reaches deeper than the MLO: the MLO is the one short of posterior tissue.';
      // an MLO whose PNL stops at the film edge is itself short: matching it proves little
      if (!other.pnl.toMuscle && sev < 1) {
        sev = 1; tip = 'The MLO’s PNL stops at the film edge, so the reference is itself short — fix the MLO, then compare.';
      }
    }
    items.push({ key: 'pnl', label: 'PNL within 1 cm of the MLO’s', sev, value, tip });
    const ml = meas.ml;
    if (ml) {
      const dm = ml.medDeficitCm;
      const s = dm > 0.5 ? band(dm, [1, 2]) + 1 : dm < -1.0 ? 1 : 0;
      items.push({ key: 'medial', label: 'Medial tissue included',
        sev: s, value: dm > 0.5 ? `medial ${f1(dm)} cm shallower than lateral` : dm < -1 ? `lateral ${f1(-dm)} cm shallower than medial` : 'medial and lateral balanced',
        tip: dm > 0.5 ? 'Rotated laterally: bring the medial breast onto the receptor.' : dm < -1 ? 'Rotated so far medially that lateral tissue is lost.' : '' });
    }
    items.push({ key: 'pec', label: 'Pectoral muscle at the posterior edge', sev: -1,
      value: meas.pecSeen ? `seen (${f1(meas.pecCm)} cm) — a well-pulled CC` : 'not seen — expected on only about a third of CCs' });
  }
  items.push({ key: 'nipple', label: 'Nipple in profile',
    sev: nip.inProfile ? 0 : !nip.seen ? 2 : nip.insideCm < 1 ? 1 : 2,
    value: nip.inProfile ? 'in profile' : !nip.seen ? 'not identified' : `rolled — ${f1(nip.insideCm)} cm inside the skin line`,
    tip: nip.inProfile ? '' : 'Roll the tissue so the nipple points straight ahead before compressing; out of profile it can mimic a mass.' });
  items.push({ key: 'cut', label: 'No tissue cut off', sev: meas.cutoff.length ? 3 : 0,
    value: meas.cutoff.length ? 'cut off at the ' + meas.cutoff.join(', ') : 'whole breast on the film' });
  return { grade: pgmi(items), items, provisional: items.some((it) => it.sev === null) };
}
