/* ============================================================================
   THE DXA EXAM, START TO FINISH
   intro -> a patient -> the intake interview (each answer hidden until it is asked: click the
   box) -> accept with the sites to scan, or delay the scan for a reason on the form -> each site
   in the plan: the AP lumbar spine (centre the patient between the lines on the pad, the knee
   block under the legs, the arm to the mark, scan), the hip (the block swapped for the foot
   holder, feet turned in, the arm to the hip's mark, scan), the forearm when ISCD calls for it
   (the non-dominant arm on the table, laid straight and flat, its length measured, the arm to
   the wrist's mark, scan) -> every study reported against what the form said.
   The other exercise is the PRECISION ASSESSMENT: the same patients scanned again and again,
   off the table and back on between scans, and the scatter of the repeats turned into the
   least significant change the reports then judge follow-ups by.
   The scanning, the analysis and the report are dxa.js's; this decides what the operator must
   have done before SCAN does anything, and says what is missing.
   ============================================================================ */
import { makeIntake } from './dxaIntake.js';
import { makePatient } from './dxaReport.js';
import { dxa, registerExam, precisionStats, precisionVerdict, ISCD_MIN_PRECISION, ISCD_MIN_DF } from './dxa.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// how close is close enough: the patient's midline on the pad's centre line, square to it; the
// forearm straight along the table and flat on it
export const TOL = { offX: 1.5, yaw: 2, laser: 2, faYaw: 2, faPitch: 3 };
/* THE FOOT HOLDER SEATS EACH FOOT WITHIN A FEW DEGREES. The holder fixes the turn-in at about 20
   degrees, but a foot settles into it a little differently every time the patient lies down — a
   real and well-known part of hip precision. The sim draws the seat (whole degrees, +-3) and its
   own projection turns that into BMD: nothing here adds noise to a number. */
export const HOLDER_SEAT = 3;
const holderSeat = () => 20 + Math.round((Math.random() * 2 - 1) * HOLDER_SEAT);
const SITE_REGION = { spine: 'spine', hip: 'hipL' };
const SITE_LABEL = { spine: 'AP lumbar spine', hip: 'Left hip', forearm: 'Forearm (33% radius)' };

let X = null;                         // the exam or the precision exercise (null: free scanning)
let timer = null, introShown = false;

/* ---- what the operator has done, read off the room ---- */
function S() { return dxa.ctx.S; }
function centred() {
  const s = S();
  return Math.abs(s.objOff.x) <= TOL.offX && Math.abs(s.objRot.y) <= TOL.yaw;
}
function onMark() {
  const e = dxa.positionError();
  return !!e && Math.abs(e.dz) <= TOL.laser && Math.abs(e.dx) <= TOL.laser;
}
const scanning = () => !!X && (X.phase === 'scan');
const siteNow = () => (X?.kind === 'prec' ? X.site : X?.plan?.[X.i]);
function steps() {
  if (!scanning()) return [];
  const D = dxa.D, site = siteNow();
  if (site === 'spine') return [
    { k: 'centre', t: 'Centre the patient between the lines', ok: centred(),
      tip: 'Offset (cross axis) lays the midline on the dashed line; Rotate (vertical) squares the patient to it.' },
    { k: 'block', t: 'Rest the legs on the knee block', ok: D.props === 'block',
      tip: 'Hips and knees at 90 degrees flatten the lumbar curve and open the disc spaces.', act: 'Place knee block' },
    { k: 'mark', t: 'Laser 1 in above the ASIS, on the midline', ok: onMark(),
      tip: 'Drive the arm with the pad; the laser is the field\'s lower edge.' },
  ];
  if (site === 'hip') return [
    { k: 'centre', t: 'Patient still centred between the lines', ok: centred() },
    { k: 'holder', t: 'Feet in the foot holder, turned in', ok: D.props === 'holder',
      tip: 'The holder turns both legs in about 20 degrees, which lays the femoral neck flat.', act: 'Swap block for foot holder' },
    { k: 'mark', t: 'Laser 2 in below the greater trochanter, on the shaft', ok: onMark(),
      tip: 'Left hip: drive the arm down the table and the laser out to the femoral shaft.' },
  ];
  if (site === 'forearm') {
    const want = `forearm${X.P.verdict.forearmSide}`, onTable = D.region === 'forearmL' || D.region === 'forearmR';
    const fa = onTable ? dxa.forearm() : null;
    const flat = !!fa && Math.abs(fa.yaw) <= TOL.faYaw && Math.abs(fa.pitch) <= TOL.faPitch;
    const len = D.forearmLen;
    return [
      { k: 'arm', t: 'The non-dominant forearm on the table', ok: D.region === want,
        tip: onTable ? 'ISCD measures the NON-dominant forearm. Check the form: which hand do they write with, and was a wrist broken?'
          : 'The patient sits beside the table. Which arm goes on it?',
        acts: [['armL', 'Left arm'], ['armR', 'Right arm']] },
      { k: 'flat', t: 'Forearm straight along the table and flat on it', ok: flat,
        tip: fa ? `Rotate (vertical) swings it parallel to the table, Tilt lays it flat: now ${Math.abs(fa.yaw).toFixed(0)}° off the table's axis and ${Math.abs(fa.pitch).toFixed(0)}° off flat.` : '' },
      { k: 'length', t: 'Measure the forearm: ulnar styloid to olecranon', ok: len != null,
        tip: 'The region is placed a third of this length above the styloid, so a wrong length moves it.',
        act: 'Measure with the tape',
        extra: len != null ? `<small>Keyed in: <b>${len.toFixed(1)} cm</b> <button class="dxe-b sm" data-act="lenDn">&minus; 0.5</button>`
          + `<button class="dxe-b sm" data-act="lenUp">+ 0.5</button></small>` : '' },
      { k: 'mark', t: 'Laser 1 in distal of the ulnar styloid, on the forearm', ok: onTable && onMark(),
        tip: 'The sweep runs up the forearm from the laser: the styloid must be in the picture.' },
    ];
  }
  return [];
}

/* ---- the panel over the room ---- */
function stepsHTML(st) {
  const allOk = st.every((s) => s.ok);
  return st.map((s) => `<div class="dxe-step ${s.ok ? 'ok' : ''}"><span class="dxe-i">${s.ok ? '&#10003;' : '&#9675;'}</span>`
      + `<span>${esc(s.t)}${!s.ok && s.tip ? `<small>${esc(s.tip)}</small>` : ''}${s.extra || ''}</span>`
      + (s.act && !s.ok ? `<button class="dxe-b sm" data-act="${s.k}">${esc(s.act)}</button>` : '')
      + (s.acts && !s.ok ? s.acts.map(([a, l]) => `<button class="dxe-b sm" data-act="${a}">${esc(l)}</button>`).join('') : '') + '</div>').join('')
    + `<div class="dxe-step ${allOk ? 'go' : ''}"><span class="dxe-i">${allOk ? '&#9655;' : '&#9675;'}</span><span>${allOk ? 'Ready: press SCAN' : 'Then SCAN'}</span></div>`;
}
function renderPanel() {
  const el = $('dxExam'); if (!el) return;
  if (!X) { el.innerHTML = `<div class="dxe-t">DXA</div><button class="dxe-b" data-act="intro">&#9654; Start a patient</button>`; return; }
  if (X.kind === 'prec') { renderPrecPanel(el); return; }
  const P = X.P;
  const head = `<div class="dxe-t">DXA &middot; ${esc(P.name)}</div><div class="dxe-s">${P.sex === 'f' ? 'F' : 'M'}, ${P.age} &middot; ${P.weight} kg &middot; ID ${P.id}</div>`;
  const of = () => `${X.i + 1} of ${X.plan.length} &middot; ${SITE_LABEL[siteNow()]}`;
  if (X.phase === 'scan') {
    el.innerHTML = head + `<div class="dxe-h">${of()}</div>` + stepsHTML(steps())
      + (X.note ? `<div class="dxe-sum">${esc(X.note)}</div>` : '');
    return;
  }
  if (X.phase === 'next') {
    const r = X.results[X.plan[X.i - 1]];
    el.innerHTML = head + `<div class="dxe-h">${SITE_LABEL[X.plan[X.i - 1]]} done</div>${resultLine(r)}`
      + `<button class="dxe-b" data-act="report">Open the report</button><button class="dxe-b" data-act="toNext">&#9654; Next: ${SITE_LABEL[siteNow()]}</button>`;
    return;
  }
  if (X.phase === 'done') {
    const done = X.plan.map((s) => X.results[s]).filter(Boolean);
    const worst = done.slice().sort((a, b) => a.T - b.T)[0];
    el.innerHTML = head + `<div class="dxe-h">Exam complete</div>${done.map(resultLine).join('')}`
      + (worst ? `<div class="dxe-sum">Reported on the lowest T-score: <b>${esc(worst.dx)}</b> (${esc(worst.regionLabel)}, T ${worst.T.toFixed(1)})</div>` : '')
      + `<button class="dxe-b" data-act="report">Open the reports</button><button class="dxe-b" data-act="intro">&#9654; Next patient</button>`;
    return;
  }
  el.innerHTML = head + `<button class="dxe-b" data-act="intake">Back to the intake form</button>`;
}
const resultLine = (r) => r ? `<div class="dxe-res"><b>${esc(r.regionLabel)}</b> BMD ${r.mean.toFixed(3)} &middot; T ${r.T.toFixed(1)} &middot; Z ${r.Z.toFixed(1)}<br><span>${esc(r.dx)}</span></div>` : '';

/* ---- the intro and the intake form ---- */
function showModal(html) {
  const m = $('dxModal'); if (!m) return;
  m.innerHTML = `<div class="dxm-card">${html}</div>`;
  m.classList.add('show');
}
function hideModal() { $('dxModal')?.classList.remove('show'); }

function intro() {
  X = null; renderPanel();
  showModal(`<div class="dxm-t">Bone densitometry</div>
    <p>A DXA exam: interview the patient with the intake form, decide whether they can be scanned
    today and which sites, then position them and scan &mdash; the <b>AP lumbar spine</b> and the
    <b>left hip</b>, and the <b>forearm</b> when the form calls for it. Each study is analysed and
    reported against what the form says about them.</p>
    <p>Or do what ISCD asks of every technologist before their follow-ups mean anything: a
    <b>precision assessment</b>, the same patients scanned repeatedly with repositioning, which
    gives the least significant change your reports will use.</p>
    <div class="dxm-acts"><button class="dxe-b big" data-act="generate">Generate a patient</button>
    <button class="dxe-b" data-act="precSetup">Precision assessment</button>
    <button class="dxe-b ghost" data-act="free">Free scanning (no patient)</button></div>`);
}

function generate() {
  const P = makeIntake((Math.random() * 4294967296) >>> 0);
  X = { kind: 'exam', P, revealed: new Set(), phase: 'intake', decision: null, results: {},
    choice: new Set(['spine', 'hip']), plan: null, i: 0 };
  renderPanel(); intake();
}
const sameSites = (a, b) => a.length === b.length && a.every((s) => b.includes(s));
function intake() {
  const P = X.P;
  const all = X.revealed.size === P.fields.length;
  const row = (f, i) => {
    const shown = X.revealed.has(i);
    return `<div class="dxf-row"><div class="dxf-q">${esc(f.q)}</div>`
      + `<button class="dxf-a ${shown ? 'shown' : ''}" data-i="${i}" ${shown ? 'disabled' : ''}>`
      + (shown ? `<span class="dxf-ink">${esc(f.a)}</span>` : '<span class="dxf-hint">*click to write down*</span>') + '</button></div>';
  };
  let foot = '';
  if (X.decision) {
    const v = P.verdict, d = X.decision;
    const delayRight = d.delay === v.delay;
    const sitesRight = v.delay || d.delay || sameSites(d.sites, v.plan);
    const right = delayRight && sitesRight;
    const planTxt = v.plan.map((s) => SITE_LABEL[s]).join(' + ');
    foot = `<div class="dxf-verdict ${right ? 'right' : 'wrong'}"><b>${right ? 'Correct.' : 'Not quite.'}</b> `
      + (v.delay ? `This scan ${d.delay ? 'is' : 'should have been'} delayed:<ul>${v.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
        : d.delay ? 'Nothing on this form is a reason to delay: the risk factors are why the scan is wanted.'
        : `The sites today: <b>${esc(planTxt)}</b>.`)
      + (!v.delay && v.why.length ? `<ul>${v.why.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '')
      + `</div><div class="dxm-acts">`
      + (v.delay ? `<button class="dxe-b" data-act="generate">Next patient</button>` + (!d.delay ? `<button class="dxe-b ghost" data-act="scanAnyway">Scan anyway (for practice)</button>` : '')
        : `<button class="dxe-b big" data-act="begin">Bring the patient in${sitesRight ? '' : ' (the correct sites)'}</button>`)
      + `</div>`;
  } else {
    const siteBtn = (s) => `<button class="dxe-b sm ${X.choice.has(s) ? '' : 'ghost'}" data-act="site:${s}" ${all ? '' : 'disabled'}>`
      + `${X.choice.has(s) ? '&#9745;' : '&#9744;'} ${SITE_LABEL[s]}</button>`;
    foot = `<div class="dxf-note" style="margin-top:10px"><b>Sites to scan today:</b> ${['spine', 'hip', 'forearm'].map(siteBtn).join(' ')}</div>`
      + `<div class="dxm-acts"><button class="dxe-b big" data-act="accept" ${all && X.choice.size ? '' : 'disabled'}>Accept: scan today</button>`
      + `<button class="dxe-b warn" data-act="delay" ${all ? '' : 'disabled'}>Delay the scan</button></div>`
      + (all ? '' : `<div class="dxf-note">Ask every question first: click each box to write the answer down.</div>`);
  }
  showModal(`<div class="dxf-paper">
    <div class="dxf-hd"><div class="dxf-title">Bone Density (DXA) Patient Questionnaire</div>
      <div class="dxf-pt"><span><b>Name:</b> ${esc(P.name)}</span><span><b>ID:</b> ${P.id}</span><span><b>Sex:</b> ${P.sex === 'f' ? 'Female' : 'Male'}</span></div>
      <div class="dxf-pt"><span><b>Indication:</b> ${esc(P.indication)}</span></div></div>
    <div class="dxf-grid">${P.fields.map(row).join('')}</div></div>${foot}`);
}

/* the patient on the table: the console takes their details, and they lie down a little off */
async function begin() {
  const P = X.P, D = dxa.D;
  hideModal();
  D.intake = P; D.sex = P.sex; D.age = P.age; D.weight = P.weight; D.loss = P.loss; D.faLoss = P.faLoss || 0;
  D.patient = { ...makePatient(P.sex, P.age, P.seed), name: P.name, id: P.id, height: P.height, sex: P.sex, fromIntake: P.seed };
  setUI();
  X.plan = P.verdict.plan.slice(); X.i = 0; X.results = {};
  await toSite();
}
const rnd = (a, b) => (Math.random() < 0.5 ? -1 : 1) * (a + Math.random() * (b - a));
/* THE PATIENT LIES DOWN — a little off the lines and a little turned, as patients do — with
   nothing under the legs; the arm waits at the head end for the operator to drive it. */
function lieDown() {
  const D = dxa.D;
  setSlider('objOffX', +rnd(5, 9).toFixed(1)); setSlider('objRotY', Math.round(rnd(4, 7)));
  // (toward the head end of the long table, so the legs and the foot holder lie on the flat pad)
  setSlider('objOffZ', +(8 + Math.random() * 12).toFixed(1));
  D.props = null; D.legRot = 0; setSlider('dxLeg', 0);
  // the arm a fraction of a press away from any whole-cm route to the mark: where the operator
  // stops is then theirs, not the arithmetic of the start
  const t = dxa.landmarkTargets();
  D.headZ = t ? t.z + 28 + Math.random() : 40; D.crossX = 0; dxa.syncHead();
  dxa.syncProps();
}
/* Into the plan's next site: the torso for the spine and hip, the arm for the forearm. */
async function toSite() {
  const D = dxa.D, site = siteNow();
  X.phase = 'scan'; X.note = '';
  if (site === 'forearm') {
    D.forearmLen = null; D.props = null;
    X.note = 'The patient sits beside the table: choose the arm to lay on it.';
    dxa.setStatus('Forearm: the patient sits beside the table.');
    renderPanel();
    return;
  }
  const region = SITE_REGION[site];
  const first = site === X.plan[0] || dxa.ctx.S.subject !== 'chestabdopelvis';
  await dxa.useRegion(region, { park: false });
  if (first) lieDown();
  dxa.setStatus(site === 'spine' ? 'The patient is on the table: centre them between the lines.'
    : 'Hip next: swap the knee block for the foot holder, then drive to the hip\'s mark.');
  renderPanel();
}
/* The arm on the table, as the patient lays it: roughly along the table, not straight, not flat. */
async function chooseArm(side) {
  const D = dxa.D;
  await dxa.useRegion(`forearm${side}`, { park: false });
  const al = dxa.forearmAlignment();
  if (al) { setSlider('objRotX', al.x + Math.round(rnd(4, 8))); setSlider('objRotY', al.y + Math.round(rnd(5, 10))); }
  setSlider('objOffX', +rnd(1, 4).toFixed(1)); setSlider('objOffZ', +(Math.random() * 10).toFixed(1));
  const t = dxa.landmarkTargets();
  D.headZ = t ? t.z + 24 + Math.random() : 0; D.crossX = 0; dxa.syncHead();
  X.note = '';
  dxa.setStatus(`The ${side === 'L' ? 'left' : 'right'} forearm is on the table.`);
  renderPanel();
}
function setSlider(id, v) { dxa.setSlider(id, v); }
// the console's patient controls show who is on the table
function setUI() {
  const D = dxa.D;
  document.querySelectorAll('#dxSexSeg button').forEach((b) => b.classList.toggle('on', b.dataset.sex === D.sex));
  const set = (id, v, txt) => { const el = $(id); if (el) el.value = v; const t = $(id + 'V'); if (t) t.textContent = txt; };
  set('dxAge', D.age, String(D.age));
  set('dxWt', D.weight, `${D.weight} kg`);
  set('dxLoss', Math.round(D.loss * 100), `${Math.round(D.loss * 100)} %`);
}

/* ---- what SCAN waits for, and what follows it ---- */
function canScan() {
  if (!X) return null;
  if (X.phase === 'auto') return 'The simulated technologist is scanning.';
  if (X.phase !== 'scan') return X.phase === 'intake' ? 'Finish the intake form first.' : 'Choose the next step in the exam panel.';
  const site = siteNow();
  if (site !== 'forearm' && dxa.D.region !== SITE_REGION[site]) return `Not ready: select ${SITE_LABEL[site]} on the console.`;
  const miss = steps().find((s) => !s.ok);
  return miss ? `Not ready: ${miss.t.toLowerCase()}.` : null;
}
function onScanDone(sc) {
  if (!X) return;
  // a study that found no region is not a result: the operator rescans (the console says why)
  if (!sc?.rois?.length) { X.note = 'No region was found: check the laser and scan again.'; renderPanel(); return; }
  if (X.kind === 'prec') { precScanDone(sc); return; }
  const e = dxa.D.history?.[0];
  if (!e || X.phase !== 'scan') return;
  X.results[siteNow()] = e;
  X.i++;
  X.phase = X.i < X.plan.length ? 'next' : 'done';
  renderPanel();
}

/* ============================================================================
   THE PRECISION ASSESSMENT (ISCD)
   Patients scanned repeatedly — 15 x 3 or 30 x 2, 30 degrees of freedom either way — each
   getting off the table and back on between scans, so every repeat is positioned afresh. The
   operator scans by hand, which is the point: the scatter is THEIR repositioning, measured by the
   real tracer, and nothing adds noise to a number. A densitometer of this sim has no photon noise,
   so what comes out is the positioning share of precision alone, and it is said so.
   Fifteen patients by hand is an afternoon, so once the operator has done one patient's set the
   rest can be finished by a SIMULATED TECHNOLOGIST who positions the way they did: each repeat
   draws one of the operator's own recorded misses (laser along and across, the patient's offset
   and turn) and puts the next patient down with it, a fresh foot-holder seat for a hip, and runs
   the same scan, the same analysis. The patients are the one skeleton at different mineral
   losses, spanning a clinic's range, since the sim has one body to offer.
   ============================================================================ */
function precSetup() {
  X = null; renderPanel();
  const b = (site, n, k) => `<button class="dxe-b" data-act="prec:${site}:${n}:${k}">${site === 'spine' ? 'AP spine' : 'Left hip'} &middot; ${n} patients &times; ${k}</button>`;
  showModal(`<div class="dxm-t">Precision assessment</div>
    <p>ISCD: every technologist measures their own precision before their follow-up studies are
    compared. Scan the same patients repeatedly, the patient getting <b>off the table and back on</b>
    between scans and repositioned each time: 15 patients three times, or 30 patients twice &mdash;
    30 degrees of freedom either way.</p>
    <p>The result is the root-mean-square SD of the repeats (g/cm&sup2; and %CV) and the
    <b>least significant change</b>, LSC = 2.77 &times; precision, the smallest change between two
    studies that is real at 95 % confidence. ISCD's minimum for one technologist: spine
    ${ISCD_MIN_PRECISION.spine.cv} % (LSC ${ISCD_MIN_PRECISION.spine.lsc} %), total hip
    ${ISCD_MIN_PRECISION.total.cv} % (${ISCD_MIN_PRECISION.total.lsc} %), femoral neck
    ${ISCD_MIN_PRECISION.neck.cv} % (${ISCD_MIN_PRECISION.neck.lsc} %).</p>
    <p>Scan at least the first patient's set yourself; a simulated technologist can then finish
    the rest, positioning the way you did.</p>
    <div class="dxm-acts">${b('spine', 15, 3)}${b('spine', 30, 2)}${b('hip', 15, 3)}${b('hip', 30, 2)}</div>
    <div class="dxm-acts"><button class="dxe-b ghost" data-act="intro">Back</button></div>`);
}
async function precStart(site, n, k) {
  hideModal();
  const D = dxa.D;
  // a clinic's spread of skeletons, from normal to osteoporotic, in a shuffled order
  const pts = Array.from({ length: n }, (_, j) => ({ loss: +(0.3 * j / Math.max(1, n - 1)).toFixed(3), vals: [] }))
    .sort(() => Math.random() - 0.5).map((p, j) => ({ ...p, no: j + 1 }));
  X = { kind: 'prec', site, n, k, pts, j: 0, phase: 'scan', manual: [], auto: 0, note: '' };
  D.intake = null; D.sex = 'f'; D.age = 65; D.faLoss = 0; D.loss = pts[0].loss; setUI();
  await dxa.useRegion(SITE_REGION[site], { park: false });
  lieDown();
  dxa.setStatus('Precision assessment: position the first patient and scan.');
  renderPanel();
}
const precValues = (sc) => {
  if (sc.region === 'spine') return { spine: sc.mean };
  const r = (l) => sc.rois.find((q) => q.label === l)?.bmd;
  return { total: r('Total'), neck: r('Neck') };
};
const precKeys = (site) => (site === 'spine' ? ['spine'] : ['total', 'neck']);
function precScanDone(sc) {
  if (X.phase !== 'scan') return;
  const D = dxa.D, s = S(), e = dxa.positionError();
  const p = X.pts[X.j];
  p.vals.push(precValues(sc));
  // the operator's own positioning, as it was when they pressed SCAN
  X.manual.push({ dz: e?.dz || 0, dx: e?.dx || 0, offX: s.objOff.x, yaw: s.objRot.y });
  precNext();
  if (X.j < X.n) { lieDown(); D.loss = X.pts[X.j].loss; setUI(); }
  X.note = `Scan filed. ${X.j < X.n ? 'The patient gets off the table and back on: reposition and scan again.' : ''}`;
  renderPanel();
  if (X.j >= X.n) precResults();
}
function precNext() { if (X.pts[X.j].vals.length >= X.k) X.j++; }
const precDone = () => X.pts.reduce((s, p) => s + p.vals.length, 0);
function renderPrecPanel(el) {
  const total = X.n * X.k, done = precDone();
  const head = `<div class="dxe-t">Precision &middot; ${X.site === 'spine' ? 'AP spine' : 'Left hip'}</div>`
    + `<div class="dxe-s">${X.n} patients &times; ${X.k} &middot; ${done} of ${total} scans${X.auto ? ` (${X.auto} by the simulated technologist)` : ''}</div>`;
  const fullOne = X.pts.some((p) => p.vals.length >= X.k);
  const canStats = X.pts.filter((p) => p.vals.length >= 2).length >= 1;
  if (X.phase === 'auto') { el.innerHTML = head + `<div class="dxe-h">Simulated technologist scanning&hellip;</div><div class="dxe-sum">${done} of ${total}</div>`; return; }
  if (X.phase === 'result') {
    el.innerHTML = head + '<button class="dxe-b" data-act="precShow">Show the results</button><button class="dxe-b ghost" data-act="intro">&#9654; Done</button>';
    return;
  }
  const p = X.pts[X.j];
  el.innerHTML = head + `<div class="dxe-h">Patient ${X.j + 1} of ${X.n} &middot; scan ${p.vals.length + 1} of ${X.k}</div>`
    + stepsHTML(steps())
    + (X.note ? `<div class="dxe-sum">${esc(X.note)}</div>` : '')
    + (fullOne ? `<button class="dxe-b" data-act="precAuto">Finish the set (simulated technologist)</button>` : '')
    + (canStats ? `<button class="dxe-b ghost" data-act="precShow">Results so far</button>` : '');
}
/* The simulated technologist: one of the operator's recorded positionings per repeat, a new lie
   on the table each time, the real scan and analysis. Yields between scans so the room breathes. */
async function precAuto() {
  if (!X || X.kind !== 'prec' || !X.manual.length) return;
  const D = dxa.D, s = S();
  X.phase = 'auto'; renderPanel();
  /* Each part of a positioning drawn from a DIFFERENT one of the operator's scans: where the
     laser stopped along the table has nothing to do with how square the patient was, and
     redrawing whole scans from a handful of them repeated the same scan outright — three
     identical repeats, a patient with no scatter at all. */
  const any = (k) => X.manual[Math.floor(Math.random() * X.manual.length)][k];
  while (X && X.kind === 'prec' && X.j < X.n) {
    const m = { dz: any('dz'), dx: any('dx'), offX: any('offX'), yaw: any('yaw') }, p = X.pts[X.j];
    D.loss = p.loss;
    setSlider('objOffX', m.offX); setSlider('objRotY', m.yaw);
    setSlider('objOffZ', +(8 + Math.random() * 12).toFixed(1));
    if (X.site === 'hip') { D.props = 'holder'; setSlider('dxLeg', holderSeat()); }
    else D.props = 'block';
    const t = dxa.landmarkTargets();
    if (t) { D.headZ = t.z + m.dz; D.crossX = t.x + m.dx; }
    const sc = dxa.scanNow();
    if (sc) {
      const { bmd } = dxa.decompose(sc);
      const an = dxa.analyse(sc, bmd);
      sc.rois = dxa.measure(sc, bmd, an.rois);
      if (sc.region === 'spine') {
        let b = 0, a = 0; for (const r of sc.rois) { b += r.bmc; a += r.area; }
        sc.mean = a > 0 ? b / a : 0;
      }
      if (sc.rois.length) { p.vals.push(precValues(sc)); X.auto++; }
    }
    precNext();
    renderPanel();
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!X || X.kind !== 'prec') return;
  dxa.syncHead(); dxa.syncProps(); dxa.ctx.syncScene?.(); setUI();
  precResults();
}
function precResults() { X.phase = 'result'; renderPanel(); precShow(); }
function precStats() {
  return Object.fromEntries(precKeys(X.site).map((key) => [key,
    precisionStats(X.pts.map((p) => p.vals.map((v) => v[key]).filter((v) => v > 0)))]));
}
function precShow() {
  if (!X || X.kind !== 'prec') return;
  const st = precStats(), keys = precKeys(X.site);
  const rows = X.pts.filter((p) => p.vals.length).map((p) => `<tr><td>${p.no}</td><td>${(100 * p.loss).toFixed(0)} %</td>`
    + keys.map((key) => {
      const v = p.vals.map((q) => q[key]);
      const per = precisionStats([v]).per[0];
      return `<td>${v.map((x) => x.toFixed(3)).join(' / ')}</td><td>${per ? per.sd.toFixed(4) : '—'}</td><td>${per ? per.cv.toFixed(2) : '—'}</td>`;
    }).join('') + '</tr>').join('');
  const summary = keys.map((key) => {
    const s = st[key], v = precisionVerdict(key, s), min = ISCD_MIN_PRECISION[key];
    return `<tr><td><b>${min.label}</b></td><td>${s.df}</td><td>${s.rmsSd.toFixed(4)}</td><td>${s.cvPct.toFixed(2)} %</td>`
      + `<td><b>${s.lscAbs.toFixed(3)}</b> g/cm&sup2;</td><td>${s.lscPct.toFixed(1)} %</td>`
      + `<td class="${v.ok ? 'dxup' : 'dxdown'}">${v.ok ? 'meets' : 'fails'} ${min.cv} % / ${min.lsc} %</td></tr>`;
  }).join('');
  const enough = keys.every((key) => st[key].df >= ISCD_MIN_DF);
  showModal(`<div class="dxm-t">Precision assessment &middot; ${X.site === 'spine' ? 'AP spine' : 'Left hip'}</div>
    <table class="dxtab"><tr><th>Site</th><th>df</th><th>RMS-SD<br><small>g/cm²</small></th><th>RMS %CV</th><th>LSC</th><th>LSC %</th><th>ISCD minimum</th></tr>${summary}</table>
    <p>${enough ? `${ISCD_MIN_DF} degrees of freedom: a complete assessment.`
      : `<b>Not yet a valid assessment:</b> ISCD needs ${ISCD_MIN_DF} degrees of freedom (15 &times; 3 or 30 &times; 2); these numbers are provisional.`}
    LSC = 2.77 &times; RMS-SD: a follow-up that changes by less than this is the machine and the
    operator, not the patient. ${X.auto ? `${X.manual.length} scans were yours; ${X.auto} were the simulated technologist repeating your positioning.` : ''}
    This densitometer has no photon noise, so this is the <b>positioning</b> share of precision alone.</p>
    <table class="dxtab"><tr><th>#</th><th>Loss</th>${keys.map((key) => `<th>${ISCD_MIN_PRECISION[key].label} BMD</th><th>SD</th><th>%CV</th>`).join('')}</tr>${rows}</table>
    <div class="dxm-acts">${enough ? '<button class="dxe-b big" data-act="precSave">Use this LSC for my reports</button>' : ''}
    <button class="dxe-b ghost" data-act="precClose">Close</button></div>`);
}
function precSave() {
  const D = dxa.D, st = precStats();
  D.precision = D.precision || {};
  for (const [key, s] of Object.entries(st)) {
    D.precision[key] = { rmsSd: s.rmsSd, cvPct: s.cvPct, lscAbs: s.lscAbs, lscPct: s.lscPct, df: s.df, m: s.m,
      when: Date.now(), manual: X.manual.length };
  }
  dxa.renderSerial();
  showModal(`<div class="dxm-t">Saved</div><p>Follow-up studies of this site are now judged against
    your LSC: the serial table and the report trend mark a change as significant only when it
    exceeds it.</p><div class="dxm-acts"><button class="dxe-b" data-act="precClose">Close</button></div>`);
}

function act(a) {
  const D = dxa.D;
  if (a === 'intro') intro();
  else if (a === 'generate') generate();
  else if (a === 'free') { X = null; D.faLoss = 0; D.intake = null; hideModal(); renderPanel(); }
  else if (a === 'intake') intake();
  else if (a.startsWith('site:')) { const s = a.slice(5); X.choice.has(s) ? X.choice.delete(s) : X.choice.add(s); intake(); }
  else if (a === 'accept' || a === 'delay') { X.decision = { delay: a === 'delay', sites: [...X.choice] }; intake(); }
  else if (a === 'begin' || a === 'scanAnyway') begin();
  else if (a === 'block') { D.props = 'block'; D.legRot = 0; setSlider('dxLeg', 0); dxa.syncProps(); renderPanel(); }
  else if (a === 'holder') {
    D.props = 'holder';
    setSlider('dxLeg', holderSeat());
    dxa.syncProps(); renderPanel();
  }
  else if (a === 'armL' || a === 'armR') chooseArm(a.slice(3));
  else if (a === 'length') { const fa = dxa.forearm(); if (fa) D.forearmLen = Math.round(fa.len * 2) / 2; renderPanel(); }
  else if (a === 'lenDn' || a === 'lenUp') { D.forearmLen = Math.max(15, (D.forearmLen || 25) + (a === 'lenUp' ? 0.5 : -0.5)); renderPanel(); }
  else if (a === 'toNext') toSite();
  else if (a === 'report') dxa.ctx.setContent?.('report');
  else if (a === 'precSetup') precSetup();
  else if (a.startsWith('prec:')) { const [, site, n, k] = a.split(':'); precStart(site, +n, +k); }
  else if (a === 'precAuto') precAuto();
  else if (a === 'precShow') precShow();
  else if (a === 'precSave') precSave();
  else if (a === 'precClose') hideModal();
}

export function dxaExamMode(on) {
  clearInterval(timer); timer = null;
  if (!on) { hideModal(); return; }
  if (!introShown) { introShown = true; intro(); }
  renderPanel();
  // the checklist follows the room (sliders, the pad), a few times a second
  timer = setInterval(() => { if (scanning()) renderPanel(); }, 300);
}

export function initDxaExam() {
  registerExam({ canScan, onScanDone, active: () => scanning() || X?.phase === 'auto', noFile: () => X?.kind === 'prec' });
  for (const id of ['dxExam', 'dxModal']) {
    $(id)?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b && !b.disabled) { act(b.dataset.act); return; }
      const f = e.target.closest('.dxf-a');
      if (f && X?.kind === 'exam' && !X.decision) { X.revealed.add(+f.dataset.i); intake(); }
    });
  }
  renderPanel();
  if (typeof window !== 'undefined') window.__dxaExam = () => ({ X, steps, canScan, act, TOL, precAuto });
}
