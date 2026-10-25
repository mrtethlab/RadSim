/* ============================================================================
   THE DXA EXAM, START TO FINISH
   intro -> a patient -> the intake interview (each answer hidden until it is asked: click the
   box) -> accept, or delay the scan for a reason on the form -> the AP lumbar spine: centre the
   patient between the lines on the pad, put the knee block under the legs, drive the arm to the
   mark, scan -> the hip: swap the block for the foot holder (feet turned in), drive the arm to
   the hip's mark, scan -> both studies reported against what the form said.
   The scanning, the analysis and the report are dxa.js's; this decides what the operator must
   have done before SCAN does anything, and says what is missing.
   ============================================================================ */
import { makeIntake } from './dxaIntake.js';
import { makePatient } from './dxaReport.js';
import { dxa, registerExam } from './dxa.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// how close is close enough: the patient's midline on the pad's centre line, square to it
export const TOL = { offX: 1.5, yaw: 2, laser: 2 };

let X = null;                         // the exam (null: free scanning)
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
function steps() {
  if (!X) return [];
  const D = dxa.D;
  if (X.phase === 'spine') return [
    { k: 'centre', t: 'Centre the patient between the lines', ok: centred(),
      tip: 'Offset (cross axis) lays the midline on the dashed line; Rotate (vertical) squares the patient to it.' },
    { k: 'block', t: 'Rest the legs on the knee block', ok: D.props === 'block',
      tip: 'Hips and knees at 90 degrees flatten the lumbar curve and open the disc spaces.', act: 'Place knee block' },
    { k: 'mark', t: 'Laser 1 in above the ASIS, on the midline', ok: onMark(),
      tip: 'Drive the arm with the pad; the laser is the field\'s lower edge.' },
  ];
  if (X.phase === 'hip') return [
    { k: 'centre', t: 'Patient still centred between the lines', ok: centred() },
    { k: 'holder', t: 'Feet in the foot holder, turned in', ok: D.props === 'holder',
      tip: 'The holder turns both legs in about 20 degrees, which lays the femoral neck flat.', act: 'Swap block for foot holder' },
    { k: 'mark', t: 'Laser 2 in below the greater trochanter, on the shaft', ok: onMark(),
      tip: 'Left hip: drive the arm down the table and the laser out to the femoral shaft.' },
  ];
  return [];
}

/* ---- the panel over the room ---- */
function renderPanel() {
  const el = $('dxExam'); if (!el) return;
  if (!X) { el.innerHTML = `<div class="dxe-t">DXA</div><button class="dxe-b" data-act="intro">&#9654; Start a patient</button>`; return; }
  const P = X.P;
  const head = `<div class="dxe-t">DXA &middot; ${esc(P.name)}</div><div class="dxe-s">${P.sex === 'f' ? 'F' : 'M'}, ${P.age} &middot; ${P.weight} kg &middot; ID ${P.id}</div>`;
  if (X.phase === 'spine' || X.phase === 'hip') {
    const st = steps();
    const allOk = st.every((s) => s.ok);
    el.innerHTML = head + `<div class="dxe-h">${X.phase === 'spine' ? '1 of 2 &middot; AP lumbar spine' : '2 of 2 &middot; Left hip'}</div>`
      + st.map((s) => `<div class="dxe-step ${s.ok ? 'ok' : ''}"><span class="dxe-i">${s.ok ? '&#10003;' : '&#9675;'}</span>`
        + `<span>${esc(s.t)}${!s.ok && s.tip ? `<small>${esc(s.tip)}</small>` : ''}</span>`
        + (s.act && !s.ok ? `<button class="dxe-b sm" data-act="${s.k}">${esc(s.act)}</button>` : '') + '</div>').join('')
      + `<div class="dxe-step ${allOk ? 'go' : ''}"><span class="dxe-i">${allOk ? '&#9655;' : '&#9675;'}</span><span>${allOk ? 'Ready: press SCAN' : 'Then SCAN'}</span></div>`;
    return;
  }
  if (X.phase === 'spineDone') {
    const r = X.results.spine;
    el.innerHTML = head + `<div class="dxe-h">AP lumbar spine done</div>${resultLine(r)}`
      + `<button class="dxe-b" data-act="report">Open the report</button><button class="dxe-b" data-act="toHip">&#9654; Next: hip scan</button>`;
    return;
  }
  if (X.phase === 'done') {
    const { spine, hip } = X.results;
    const worst = [spine, hip].filter(Boolean).sort((a, b) => a.T - b.T)[0];
    el.innerHTML = head + `<div class="dxe-h">Exam complete</div>${resultLine(spine)}${resultLine(hip)}`
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
    today, then position them and scan the <b>AP lumbar spine</b> and the <b>left hip</b>. Each study
    is analysed and reported against what the form says about them.</p>
    <div class="dxm-acts"><button class="dxe-b big" data-act="generate">Generate a patient</button>
    <button class="dxe-b ghost" data-act="free">Free scanning (no patient)</button></div>`);
}

function generate() {
  const P = makeIntake((Math.random() * 4294967296) >>> 0);
  X = { P, revealed: new Set(), phase: 'intake', decision: null, results: {} };
  renderPanel(); intake();
}
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
    const v = P.verdict, right = (X.decision === 'delay') === v.delay;
    foot = `<div class="dxf-verdict ${right ? 'right' : 'wrong'}"><b>${right ? 'Correct.' : 'Not quite.'}</b> `
      + (v.delay ? `This scan ${X.decision === 'delay' ? 'is' : 'should have been'} delayed:<ul>${v.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
        : `Nothing on this form is a reason to delay: the risk factors are why the scan is wanted.`)
      + `</div><div class="dxm-acts">`
      + (v.delay ? `<button class="dxe-b" data-act="generate">Next patient</button>` + (X.decision === 'accept' ? `<button class="dxe-b ghost" data-act="scanAnyway">Scan anyway (for practice)</button>` : '')
        : `<button class="dxe-b big" data-act="begin">Bring the patient in</button>`)
      + `</div>`;
  } else {
    foot = `<div class="dxm-acts"><button class="dxe-b big" data-act="accept" ${all ? '' : 'disabled'}>Accept: scan today</button>`
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
function begin() {
  const P = X.P, D = dxa.D, s = S();
  hideModal();
  D.intake = P; D.sex = P.sex; D.age = P.age; D.weight = P.weight; D.loss = P.loss;
  D.patient = { ...makePatient(P.sex, P.age, P.seed), name: P.name, id: P.id, height: P.height, sex: P.sex, fromIntake: P.seed };
  setUI();
  const r = (a, b) => (Math.random() < 0.5 ? -1 : 1) * (a + Math.random() * (b - a));
  setSlider('objOffX', +r(5, 9).toFixed(1)); setSlider('objRotY', Math.round(r(4, 7)));
  // (toward the head end of the long table, so the legs and the foot holder lie on the flat pad)
  setSlider('objOffZ', +(8 + Math.random() * 12).toFixed(1));
  D.props = null; D.legRot = 0; setSlider('dxLeg', 0);
  D.region = 'spine';
  document.querySelectorAll('#dxRegionSeg button').forEach((b) => b.classList.toggle('on', b.dataset.region === 'spine'));
  // the arm waits at the head end; the operator drives it to the mark
  const t = dxa.landmarkTargets();
  D.headZ = t ? t.z + 28 : 40; D.crossX = 0; dxa.syncHead();
  X.phase = 'spine';
  dxa.setStatus('The patient is on the table: centre them between the lines.');
  renderPanel(); dxa.syncProps();
}
function toHip() {
  const D = dxa.D;
  X.phase = 'hip';
  D.region = 'hipL';
  document.querySelectorAll('#dxRegionSeg button').forEach((b) => b.classList.toggle('on', b.dataset.region === 'hipL'));
  dxa.setStatus('Hip next: swap the knee block for the foot holder, then drive to the hip\'s mark.');
  renderPanel();
}
function setSlider(id, v) {
  const el = $(id); if (!el) return;
  el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
}
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
  if (X.phase !== 'spine' && X.phase !== 'hip') return X.phase === 'intake' ? 'Finish the intake form first.' : 'Choose the next step in the exam panel.';
  const miss = steps().find((s) => !s.ok);
  return miss ? `Not ready: ${miss.t.toLowerCase()}.` : null;
}
function onScanDone() {
  if (!X) return;
  const e = dxa.D.history?.[0];
  if (!e) return;
  if (X.phase === 'spine') { X.results.spine = e; X.phase = 'spineDone'; }
  else if (X.phase === 'hip') { X.results.hip = e; X.phase = 'done'; }
  renderPanel();
}

function act(a) {
  const D = dxa.D;
  if (a === 'intro') intro();
  else if (a === 'generate') generate();
  else if (a === 'free') { X = null; hideModal(); renderPanel(); }
  else if (a === 'intake') intake();
  else if (a === 'accept' || a === 'delay') { X.decision = a; intake(); }
  else if (a === 'begin' || a === 'scanAnyway') begin();
  else if (a === 'block') { D.props = 'block'; D.legRot = 0; setSlider('dxLeg', 0); dxa.syncProps(); renderPanel(); }
  else if (a === 'holder') { D.props = 'holder'; setSlider('dxLeg', 20); dxa.syncProps(); renderPanel(); }
  else if (a === 'toHip') toHip();
  else if (a === 'report') dxa.ctx.setContent?.('report');
}

export function dxaExamMode(on) {
  clearInterval(timer); timer = null;
  if (!on) { hideModal(); return; }
  if (!introShown) { introShown = true; intro(); }
  renderPanel();
  // the checklist follows the room (sliders, the pad), a few times a second
  timer = setInterval(() => { if (X && (X.phase === 'spine' || X.phase === 'hip')) renderPanel(); }, 300);
}

export function initDxaExam() {
  registerExam({ canScan, onScanDone, active: () => !!X && (X.phase === 'spine' || X.phase === 'hip') });
  for (const id of ['dxExam', 'dxModal']) {
    $(id)?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b && !b.disabled) { act(b.dataset.act); return; }
      const f = e.target.closest('.dxf-a');
      if (f && X && !X.decision) { X.revealed.add(+f.dataset.i); intake(); }
    });
  }
  renderPanel();
  if (typeof window !== 'undefined') window.__dxaExam = () => ({ X, steps, canScan, act, TOL });
}
