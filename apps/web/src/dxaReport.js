/* ============================================================================
   THE DENSITOMETRY REPORT

   A DXA study's deliverable is not the picture, it is the page: a referrer never
   sees the scan, they see a number, a T-score, and a curve with the patient's dot
   on it. This module builds that page in the shape of the GE Lunar iDXA printout
   the mode is modelled on — header block, the image with the analysed regions
   outlined, BMD-against-age with the WHO bands behind it, the densitometry table,
   the trend chart and trend table, and the small print at the bottom.

   Everything the simulation knows is carried through: age, sex, weight, the
   per-level BMD/BMC/area, T and Z, the serial history. Everything it cannot know
   is invented ONCE per patient and then held — name, ID, ethnicity, birth date,
   referrer — because a follow-up study that renamed the patient would be worse
   than useless for teaching what a trend report is.
   ============================================================================ */

import { REF, ageMean, scores, diagnosis, LSC_PCT } from './dxa.js';

/* ---- the invented half -------------------------------------------------------
   Deterministic from a seed so a re-render of the same study produces the same
   person; the seed is drawn once when the patient is created. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const SURNAMES = ['Okonkwo', 'Lindqvist', 'Ferreira', 'Nakamura', 'Vasquez', 'Bergeron',
  'Haddad', 'Kowalski', 'Ashworth', 'Petrova', 'Marchetti', 'Dubois', 'Novak', 'Sandoval'];
const FIRST_F = ['Miriam', 'Aiko', 'Rosalind', 'Femi', 'Ingrid', 'Carmen', 'Priya', 'Noor'];
const FIRST_M = ['Emeka', 'Anders', 'Rafael', 'Kenji', 'Marcus', 'Tobias', 'Idris', 'Levi'];
const ETHNIC = ['White', 'Black', 'Hispanic', 'Asian', 'Other'];
const REFERRERS = ['Dr. Phlox', 'Dr. Okafor', 'Dr. Lindholm', 'Dr. Amara', 'Dr. Whitfield'];

export function makePatient(sex, age, seed) {
  const r = rng(seed ?? ((Date.now() ^ (age * 7919)) >>> 0));
  const first = (sex === 'm' ? FIRST_M : FIRST_F)[Math.floor(r() * 8)];
  const last = SURNAMES[Math.floor(r() * SURNAMES.length)];
  const id = String(Math.floor(100000 + r() * 899999));
  const eth = ETHNIC[Math.floor(r() * ETHNIC.length)];
  // a birth date consistent with the age slider, which the report then re-derives
  const now = new Date();
  const by = now.getFullYear() - age;
  const bm = 1 + Math.floor(r() * 12), bd = 1 + Math.floor(r() * 28);
  return { name: `${last}, ${first}`, id, ethnicity: eth,
           dob: new Date(by, bm - 1, bd), referrer: REFERRERS[Math.floor(r() * REFERRERS.length)],
           height: Math.round((sex === 'm' ? 176 : 163) + (r() - 0.5) * 16) };
}
const fmtDate = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate())
  .padStart(2, '0')}/${d.getFullYear()}`;

/* ---- BMD against age, with the WHO bands behind it ---------------------------
   The bands are not decoration: T is measured from the YOUNG-ADULT mean, so the
   -1.0 and -2.5 lines are horizontal in BMD, while the reference curve running
   through them falls with age. That is the whole reason an 80-year-old can sit
   in the yellow and still be unremarkable for her age — the dot is below the
   young-adult line but on the age line. Drawing both is what makes T and Z
   visibly different quantities rather than two numbers in a table. */
export function drawAgeChart(cv, opts) {
  const { site, sex, points, xMin = 20, xMax = 100 } = opts;
  const r = REF[site][sex];
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const L = 46, R = 34, T = 12, B = 30;
  const yLo = Math.min(0.58, r.yMean - 4.2 * r.ySD), yHi = Math.max(1.42, r.yMean + 2.2 * r.ySD);
  const px = (a) => L + (a - xMin) / (xMax - xMin) * (W - L - R);
  const py = (v) => T + (yHi - v) / (yHi - yLo) * (H - T - B);
  g.clearRect(0, 0, W, H);
  // the three WHO zones, painted as horizontal bands in BMD
  const t1 = r.yMean - 1.0 * r.ySD, t25 = r.yMean - 2.5 * r.ySD;
  const band = (a, b, fill) => { g.fillStyle = fill;
    g.fillRect(L, py(b), W - L - R, Math.max(0, py(a) - py(b))); };
  band(t1, yHi, '#1f8f43');            // normal
  band(t25, t1, '#d8c341');            // osteopenia
  band(yLo, t25, '#c0392b');           // osteoporosis
  // the age-matched mean, and +/- 1 SD around it
  g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 1;
  for (const off of [-1, 0, 1]) {
    g.beginPath();
    for (let a = xMin; a <= xMax; a++) {
      const v = ageMean(site, sex, a) + off * r.ySD;
      a === xMin ? g.moveTo(px(a), py(v)) : g.lineTo(px(a), py(v));
    }
    g.stroke();
  }
  // frame + ticks
  g.strokeStyle = '#333'; g.strokeRect(L + .5, T + .5, W - L - R - 1, H - T - B - 1);
  g.fillStyle = '#111'; g.font = '9px ui-monospace, monospace'; g.textAlign = 'right';
  for (let v = 0.58; v <= yHi + 1e-6; v += 0.12) {
    if (v < yLo) continue;
    g.fillText(v.toFixed(2), L - 4, py(v) + 3);
  }
  g.textAlign = 'center';
  for (let a = xMin; a <= xMax; a += 10) g.fillText(String(a), px(a), H - B + 14);
  g.fillText('Age (years)', (L + W - R) / 2, H - 4);
  // zone labels, in the corner of each band like the printout
  g.textAlign = 'left'; g.fillStyle = '#fff'; g.font = '10px system-ui, sans-serif';
  g.fillText('Normal', L + 5, py(yHi) + 12);
  if (py(t1) - py(yHi) > 22) g.fillText('Osteopenia', L + 5, py(t1) + 12);
  g.fillText('Osteoporosis', L + 5, py(t25) + 12);
  // the patient: older studies hollow, the current one filled, joined in order
  const pts = (points || []).filter((p) => p.bmd > 0);
  g.strokeStyle = '#111'; g.lineWidth = 1.4;
  g.beginPath();
  pts.forEach((p, i) => { const X = px(p.age), Y = py(p.bmd);
    i === 0 ? g.moveTo(X, Y) : g.lineTo(X, Y); });
  if (pts.length > 1) g.stroke();
  pts.forEach((p, i) => {
    const X = px(p.age), Y = py(p.bmd), last = i === pts.length - 1;
    g.fillStyle = last ? '#111' : '#fff';
    g.strokeStyle = '#111'; g.lineWidth = 1.4;
    g.fillRect(X - 4, Y - 4, 8, 8); g.strokeRect(X - 4, Y - 4, 8, 8);
  });
  // right-hand T axis, which is just the left axis re-labelled
  g.fillStyle = '#111'; g.textAlign = 'left'; g.font = '9px ui-monospace, monospace';
  for (let t = 2; t >= -5; t--) {
    const v = r.yMean + t * r.ySD;
    if (v < yLo || v > yHi) continue;
    g.fillText(String(t), W - R + 6, py(v) + 3);
  }
}

/* ---- the page ---------------------------------------------------------------- */
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function reportHTML(entry, history, charts) {
  const p = entry.patient, spine = entry.region === 'spine';
  /* A femur report is not an alphabetised list. Its regions have a fixed order on every
     printout — neck, Ward's, trochanter, intertrochanteric, total — and each is scored
     against its OWN reference, because the intertrochanteric region is half again as dense
     as the trochanter and one mean for all five would call a normal trochanter osteoporotic.
     Sorting by name gave "Inter–Wards" as the study's title, which names nothing. */
  const FEMUR_ORDER = ['Neck', 'Wards', 'Troch', 'Inter', 'Total'];
  const rows = entry.rois.slice().sort(spine
    ? (a, b) => a.label.localeCompare(b.label)
    : (a, b) => FEMUR_ORDER.indexOf(a.label) - FEMUR_ORDER.indexOf(b.label));
  const label = entry.regionLabel;
  const site = spine ? 'spine' : 'total';           // what the study as a whole is scored on
  const span = spine
    ? (rows.length ? `${rows[0].label}–${rows[rows.length - 1].label}` : 'Total')
    : 'Total hip';
  const line = (r) => {
    const s = scores(r.bmd, spine ? 'spine' : (r.site || 'total'), entry.sex, entry.age);
    return `<tr><td>${r.label}</td><td>${r.area.toFixed(2)}</td><td>${r.bmc.toFixed(2)}</td>`
      + `<td><b>${r.bmd.toFixed(3)}</b></td><td>${s.T.toFixed(1)}</td><td>${s.Z.toFixed(1)}</td></tr>`;
  };
  // the trend rows: newest first, each against the one before it
  const hist = history.filter((h) => h.region === entry.region);
  const trend = hist.map((h, i) => {
    const prev = hist[i + 1];
    const d = prev ? h.mean - prev.mean : null;
    const pc = prev ? 100 * (h.mean / prev.mean - 1) : null;
    const sig = pc != null && Math.abs(pc) >= LSC_PCT;
    return `<tr><td>${fmtDate(h.when)}</td><td>${h.age.toFixed(1)}</td>`
      + `<td><b>${h.mean.toFixed(3)}</b></td>`
      + `<td>${d == null ? '—' : (d > 0 ? '+' : '') + d.toFixed(3)}</td>`
      + `<td>${pc == null ? '—' : (pc > 0 ? '+' : '') + pc.toFixed(1) + ' %' + (sig ? ' *' : '')}</td></tr>`;
  }).join('');
  const dx = diagnosis(entry.T);
  return `
<div class="dxrep-page">
  <div class="dxrep-hd">
    <div class="dxrep-org">GE Healthcare</div>
    <div class="dxrep-addr">3030 Ohmeda Drive, Madison, WI 53718</div>
    <div class="dxrep-addr">Phone: 608 221-1551</div>
  </div>
  <table class="dxrep-pt">
    <tr><td class="k">Patient:</td><td>${esc(p.name)}</td><td class="k">Referring Physician:</td><td>${esc(p.referrer)}</td></tr>
    <tr><td class="k">Birth Date:</td><td>${fmtDate(p.dob)}</td><td class="k">Patient ID:</td><td>${esc(p.id)}</td></tr>
    <tr><td class="k">Height:</td><td>${p.height} cm</td><td class="k">Measured:</td><td>${fmtDate(entry.when)}</td></tr>
    <tr><td class="k">Weight:</td><td>${entry.weight} kg</td><td class="k">Analyzed:</td><td>${fmtDate(entry.when)}</td></tr>
    <tr><td class="k">Sex:</td><td>${entry.sex === 'm' ? 'Male' : 'Female'}</td>
        <td class="k">Ethnicity:</td><td>${esc(p.ethnicity)}</td></tr>
    <tr><td class="k">Age:</td><td>${entry.age}</td><td class="k">Scan Mode:</td><td>Standard &middot; 146.0 &micro;Gy</td></tr>
  </table>
  <div class="dxrep-body">
    <div class="dxrep-col">
      <div class="dxrep-cap">${esc(label)} Bone Density</div>
      <img class="dxrep-img" src="${entry.img}" alt="">
      <div class="dxrep-note">Image not for diagnosis</div>
    </div>
    <div class="dxrep-col">
      <div class="dxrep-cap">USA (Combined NHANES/Lunar) ${esc(label)}: ${span} (BMD)</div>
      <img class="dxrep-chart" src="${charts.age}" alt="">
      <table class="dxrep-tab">
        <tr><th>Region</th><th>Area<br><small>(cm&sup2;)</small></th><th>BMC<br><small>(g)</small></th>
            <th>BMD<br><small>(g/cm&sup2;)</small></th><th>Young-Adult<br>T-score</th><th>Age-Matched<br>Z-score</th></tr>
        ${rows.map(line).join('')}
        <tr class="sum"><td>${span}</td><td>${entry.area.toFixed(2)}</td><td>${entry.bmc.toFixed(2)}</td>
            <td><b>${entry.mean.toFixed(3)}</b></td><td><b>${entry.T.toFixed(1)}</b></td>
            <td><b>${entry.Z.toFixed(1)}</b></td></tr>
      </table>
    </div>
  </div>
  <div class="dxrep-dx dxrep-${dx.toLowerCase()}">${dx} &middot; T ${entry.T.toFixed(1)} &middot; Z ${entry.Z.toFixed(1)}</div>
  ${hist.length > 1 ? `
  <div class="dxrep-cap" style="margin-top:14px">Densitometry Trend: ${span}</div>
  <img class="dxrep-chart wide" src="${charts.trend}" alt="">
  <table class="dxrep-tab">
    <tr><th>Measured Date</th><th>Age<br><small>(years)</small></th><th>BMD<br><small>(g/cm&sup2;)</small></th>
        <th>Change vs<br>Previous (g/cm&sup2;)</th><th>Change vs<br>Previous (%)</th></tr>
    ${trend}
  </table>` : '<div class="dxrep-note" style="margin-top:12px">Single study — no trend available. '
    + 'Store another scan to build a series.</div>'}
  <div class="dxrep-fine">
    (*) Indicates significant change based on the 95 % confidence interval (LSC = ${LSC_PCT.toFixed(1)} %
    for ${esc(label)} ${span}). USA (Combined NHANES / Lunar) Reference Population; matched for Age,
    Weight, Ethnic. World Health Organization definition of Osteoporosis and Osteopenia: Normal =
    T-score at or above &minus;1.0 SD; Osteopenia = T-score between &minus;1.0 and &minus;2.5 SD;
    Osteoporosis = T-score at or below &minus;2.5 SD. WHO definitions only apply when a young healthy
    Caucasian Women reference database is used to determine T-scores.
    <br>Simulated study &mdash; RadSim densitometry. Patient identifiers are fictitious.
  </div>
</div>`;
}
