/* ============================================================================
   PROTOCOL TRAINER — read the requisition, choose the views, order them, see the films.

   The other half of the job from the Positioning Trainer: before a patient is positioned,
   the requisition is read and the series decided. A requisition is generated
   (trainer/requisition.js: demographics, encounter, the referring office, the history and
   the question), the student picks the anatomy and the views from the room's own protocol
   chart, and puts them in the order they would take them.

   CHECKING marks two things:
     the protocol — the department's routine for this reason for exam
                    (trainer/hospitalProtocols.js): views missing, views not needed;
     the order    — how much the room, the patient and the tube move between views
                    (core/viewOrder.js), against the best order for the same views.
   THE FILMS are then made of the views chosen, in the order chosen, by the x-ray room itself:
   each protocol applied as the sandbox applies it, the patient's pathology stamped into the
   volume (core/pathology.js, through the app's setPathology), and exposed dry. What a view
   shows of the pathology is what the physics shows — a missed view can miss the fracture.
   ============================================================================ */
import { HOSPITAL, VIEW_META, lineById } from './hospitalProtocols.js';
import { makeRequisition, seedRng, HOSPITAL_INFO } from './requisition.js';
import { PATHOLOGY } from '../core/pathology.js';
import { judgeOrder, orderCost, stepChanges, TIERS } from '../core/viewOrder.js';

let H = null;                 // app hooks
let P = null;                 // the session: { req, seed, region, list, checked, films, ticket, tally }

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function initProtocolTrainer(hooks) {
  H = hooks;
  document.querySelectorAll('#homeScreen .hc-ptrainer').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation(); open();
  }));
}
export function protocolTrainerActive() { return !!P; }
/* Leaving the x-ray room (home, another mode) ends the session. */
export function protocolTrainerOnMode(mode) { if (P && mode !== 'xray') close(); }

function open() {
  H.applyMode('xray');
  P = { tally: { reqs: 0, protocol: 0, order: 0 }, ticket: 0 };
  document.body.classList.add('ptrainer');
  const el = $('ptrainer'); if (el) el.hidden = false;
  newRequisition();
}
function close() {
  if (!P) return;
  P.ticket++;
  P = null;
  H.clearPathology?.();
  document.body.classList.remove('ptrainer');
  const el = $('ptrainer'); if (el) { el.hidden = true; el.innerHTML = ''; }
}

/* ---------------------------------------------------------------- the session */
function newRequisition(seed) {
  P.ticket++;
  H.clearPathology?.();
  P.seed = seed ?? ((Math.random() * 2 ** 31) >>> 0);
  P.req = makeRequisition({ rng: seedRng(P.seed), drawable: (id) => PATHOLOGY[id]?.available !== false });
  P.region = null; P.list = []; P.checked = null; P.films = {}; P.missed = false; P.counted = false; P.report = false; P.order = 0;
  render();
}

// the chart, and where a projection sits in it
function chart() { return H.protocols().groups; }
function findProj(name) {
  for (const g of chart()) for (const r of g.regions) {
    const p = r.projections.find((x) => x.proj === name);
    if (p) return { part: g.part, region: r.region, p };
  }
  return null;
}

/* The answer: one slot per view the routine(s) need, shared between lines that combine (a
   sacrum and an SI joints on one requisition take the AP axial once). An "either" slot is
   filled by any of its views. */
function answerKey(req) {
  const slots = [];
  for (const ex of req.exams) {
    const line = lineById(ex.line); if (!line) continue;
    for (const v of line.views) {
      const either = (line.either || []).find((e) => e.of.includes(v));
      const alts = either ? either.of : [v];
      if (slots.some((s) => s.alts.some((a) => alts.includes(a)))) continue;
      slots.push({ alts, label: either ? either.slot : v, line });
    }
  }
  return slots;
}
function checkProtocol(req, list) {
  const slots = answerKey(req), chosen = new Set(list);
  const missing = slots.filter((s) => !s.alts.some((a) => chosen.has(a)));
  const extra = list.filter((v) => !slots.some((s) => s.alts.includes(v)));
  return { slots, missing, extra, ok: !missing.length && !extra.length };
}

/* Where and how a view is taken (core/viewOrder.js), for any projection in the chart: the
   department's views carry their own; anything else is placed by its part of the body. */
const PART_DEFAULT = {
  'Upper extremity': ['seated', 'seated', [24, 90]], 'Lower extremity': ['detector', 'supine', [10, 30]],
  'Chest': ['wall', 'erect', [0, 125]], 'Abdomen / Pelvis': ['table', 'supine', [0, 95]],
  'Spine': ['table', 'supine', [0, 120]], 'Head': ['table', 'supine', [0, 165]], 'Long length': ['wall', 'erect', [0, 90]],
};
/* A patient who came on a stretcher neither stands at the wall stand nor sits at the flat bucky:
   those views are taken where they lie, on a free detector. */
function whereTaken(m, part) {
  const d = PART_DEFAULT[part] || ['table', 'supine', [0, 100]];
  let room = m?.room || d[0], posture = m?.posture || d[1];
  if (P?.req?.patient?.mobility === 'stretcher' && (room === 'wall' || room === 'seated')) { room = 'detector'; posture = 'supine'; }
  return { room, posture, site: m?.site || d[2] };
}
function orderView(name) {
  const f = findProj(name), m = VIEW_META[name];
  const w = whereTaken(m, f?.part);
  return { name, room: w.room, posture: w.posture, rot: m ? m.rot : (f?.p.pose?.roll || 0), xt: !!m?.xt,
    cc: f?.p.pose?.cc || 0, site: w.site, coll: f?.p.coll || null };
}

/* ---------------------------------------------------------------- rendering */
function render() {
  const el = $('ptrainer'); if (!el || !P) return;
  const t = P.tally;
  el.innerHTML = `
    <div class="ptr-bar">
      <div class="ptr-title">Protocol Trainer</div>
      <div class="ptr-tally">${t.reqs ? `Protocols ${t.protocol}/${t.reqs} &middot; Orders ${t.order}/${t.reqs}` : ''}</div>
      <button class="ptr-btn" id="ptrNew">New requisition</button>
      <button class="tr-x" id="ptrHome" title="Back to the home screen">&times;</button>
    </div>
    <div class="ptr-main">
      <section class="ptr-req">${ordersHTML(P.req)}<div class="ptr-paper">${reqHTML(P.req, P.req.exams[P.order] || P.req.exams[0])}</div></section>
      <section class="ptr-work">${workHTML()}</section>
    </div>
    <section class="ptr-films" id="ptrFilms">${filmsHTML()}</section>`;
  $('ptrHome').onclick = () => H.applyMode('home');
  $('ptrNew').onclick = () => newRequisition();
  wireWork(el);
  paintFilms();
}

/* SEVERAL ORDERS for one patient (a fall: the ankle, the leg, the knee and the femur) come as
   separate requisitions from the one physician, each with its own accession and reason. */
function ordersHTML(r) {
  if ((r.exams || []).length < 2) return '';
  return `<div class="ptr-orders"><span>${r.exams.length} orders</span>${r.exams.map((x, i) =>
    `<button class="ptr-ord${i === P.order ? ' on' : ''}" data-ord="${i}">${esc(x.name)}</button>`).join('')}</div>`;
}
/* THE REQUISITION, as it comes off the printer: one order of the patient's. */
function reqHTML(r, ex) {
  const p = r.patient || {}, e = r.encounter || {}, d = r.referrer || {};
  const row = (k, v) => v || v === 0 ? `<div class="rq-f"><span>${esc(k)}</span><b>${esc(v)}</b></div>` : '';
  const name = p.name || [p.surname?.toUpperCase(), p.given].filter(Boolean).join(', ');
  const loc = e.location || [e.unit, e.room && `Rm ${e.room}`, e.bed && `Bed ${e.bed}`].filter(Boolean).join(' · ');
  const preg = p.pregnancy ? (typeof p.pregnancy === 'string' ? p.pregnancy : [p.pregnancy.status, p.pregnancy.lmp && `LMP ${p.pregnancy.lmp}`].filter(Boolean).join(' · ')) : null;
  const list = (v) => Array.isArray(v) ? v.join(', ') : v;
  return `
    <div class="rq-head">
      <div><div class="rq-fac">${esc(HOSPITAL_INFO.name)}</div>
        <div class="rq-doc">Diagnostic Imaging Requisition</div></div>
      <div class="rq-acc">${row('Accession', ex?.accession || e.accession)}${row('Ordered', e.ordered)}
        <div class="rq-pri pri-${esc(String(e.priority || 'Routine').toLowerCase())}">${esc(e.priority || 'Routine')}</div></div>
    </div>
    <div class="rq-grid">
      <div class="rq-box"><div class="rq-bt">Patient</div>
        <div class="rq-name">${esc(name)}</div>
        ${row('Sex', p.sex)}${row('DOB', p.dob && `${p.dob} (${p.ageText || p.age + ' y'})`)}${row('MRN', p.mrn)}${row('Health card', p.healthCard || p.hcn)}
        ${row('Address', p.address)}${row('Phone', p.phone)}${row('Language', p.language)}${row('Interpreter', p.interpreter === true ? 'Required' : p.interpreter || null)}</div>
      <div class="rq-box"><div class="rq-bt">Encounter</div>
        ${row('Class', e.patientClass || e.class)}${row('Location', loc)}${row('Mobility', p.mobility || e.mobility)}${row('Isolation', p.isolation || e.isolation)}
        ${row('Weight', p.weightKg ? p.weightKg + ' kg' : p.weight)}${row('Height', p.heightCm ? p.heightCm + ' cm' : p.height)}
        ${p.familyPhysician ? row('Family MD', p.familyPhysician.name) : row('Family MD', 'None (unattached)')}</div>
      <div class="rq-box rq-wide"><div class="rq-bt">Referring physician</div>
        <div class="rq-name">${esc(d.name)}${d.credentials ? `, ${esc(d.credentials)}` : ''}</div>
        ${row('Specialty', d.specialty)}${row('Office / department', d.office || d.department)}${row('Address', d.address)}
        ${row('Phone', d.phone)}${row('Fax', d.fax)}${row('Billing #', d.billing)}${row('cc', d.cc && typeof d.cc === 'object' ? [d.cc.name, d.cc.clinic].filter(Boolean).join(', ') : d.cc)}</div>
    </div>
    <div class="rq-box rq-exam"><div class="rq-bt">Examination requested</div>
      <div class="rq-ex">${esc(ex?.name)}</div>
      ${r.request ? `<div class="rq-req">${esc(r.request)}</div>` : ''}</div>
    <div class="rq-box"><div class="rq-bt">Reason for exam</div><div class="rq-q">${esc(ex?.question || r.question)}</div></div>
    <div class="rq-box"><div class="rq-bt">Clinical history</div><div class="rq-hx">${esc(r.history)}</div></div>
    <div class="rq-grid">
      <div class="rq-box"><div class="rq-bt">Safety</div>${row('Allergies', list(p.allergies) || 'NKDA')}${row('Pregnancy', preg)}</div>
      <div class="rq-box"><div class="rq-bt">Medications</div><div class="rq-hx">${esc(list(p.meds) || 'None listed')}</div></div>
    </div>
    <div class="rq-sig">Electronically signed &middot; ${esc(d.name)}</div>`;
}

/* THE WORKLIST: the chart's anatomy, the region's views, and the series in order. */
function workHTML() {
  const chosen = new Set(P.list);
  const anat = chart().map((g) => `<div class="ptr-part"><div class="ptr-pt">${esc(g.part)}</div>
    ${g.regions.map((r) => {
      const n = r.projections.filter((x) => chosen.has(x.proj)).length;
      return `<button class="ptr-reg${P.region === g.part + '|' + r.region ? ' on' : ''}" data-reg="${esc(g.part + '|' + r.region)}">${esc(r.region)}${n ? `<i>${n}</i>` : ''}</button>`;
    }).join('')}</div>`).join('');
  let views = '';
  if (P.region) {
    const [part, region] = P.region.split('|');
    const r = chart().find((g) => g.part === part)?.regions.find((x) => x.region === region);
    views = `<div class="ptr-h">${esc(region)}</div><div class="ptr-views">${(r?.projections || []).map((x) =>
      `<button class="ptr-view${chosen.has(x.proj) ? ' on' : ''}" data-v="${esc(x.proj)}">${esc(x.proj)}</button>`).join('')}</div>`;
  }
  const ov = P.list.map(orderView);
  const items = P.list.map((v, i) => {
    const chg = P.checked && i ? stepChanges(ov[i - 1], ov[i]) : [];
    const mark = P.checked ? (P.checked.proto.extra.includes(v) ? '<i class="bad" title="Not in the routine">&#10007;</i>' : '<i class="ok">&#10003;</i>') : '';
    return `${chg.length ? `<li class="ptr-step">${chg.map((c) => `<span class="t${c.tier}">${esc(c.text)}</span>`).join('')}</li>` : ''}
      <li class="ptr-item" draggable="true" data-i="${i}"><span class="ptr-grip">&#8942;&#8942;</span><span class="ptr-n">${i + 1}</span>
        <span class="ptr-vn">${esc(v)}</span>${mark}
        <button data-mv="-1" data-i="${i}" title="Move up">&#9650;</button><button data-mv="1" data-i="${i}" title="Move down">&#9660;</button>
        <button data-rm="${i}" title="Remove">&times;</button></li>`;
  }).join('');
  return `
    <div class="ptr-h">Anatomy</div><div class="ptr-anat">${anat}</div>
    ${views}
    <div class="ptr-h">Worklist <small>(${P.list.length} view${P.list.length === 1 ? '' : 's'})</small></div>
    <ol class="ptr-list" id="ptrList">${items || '<li class="ptr-empty">No views</li>'}</ol>
    <div class="ptr-acts">
      <button class="ptr-btn ptr-go" id="ptrCheck"${P.list.length ? '' : ' disabled'}>${P.checked ? 'Re-check' : 'Check'}</button>
      ${P.checked ? '<button class="ptr-btn" id="ptrFilm">Make films</button>' : ''}
    </div>
    ${P.checked ? resultHTML() : ''}`;
}

function resultHTML() {
  const c = P.checked, pr = c.proto, o = c.order;
  const lines = [...new Set(pr.slots.map((s) => s.line))];
  const routine = lines.map((l) => `<div class="ptr-line"><b>${esc(l.exam)}</b> (${esc(l.indication)})<div>${l.views.map((v) => {
    const s = pr.slots.find((x) => x.alts.includes(v));
    return esc(s && s.alts.length > 1 ? s.label : v);
  }).join(' &middot; ')}</div></div>`).join('');
  const miss = pr.missing.map((s) => `<li class="fail"><span class="ic">&#10007;</span><b>Missing</b> ${esc(s.label)}</li>`).join('');
  const extra = pr.extra.map((v) => `<li class="warn"><span class="ic">!</span><b>Not needed</b> ${esc(v)}</li>`).join('');
  let order = '';
  if (o) {
    const rows = TIERS.map((t, i) => `<tr class="${i === o.tier ? 'lose' : ''}"><td>${esc(t.label)}</td><td>${fmtTier(o.total[i], t)}</td><td>${fmtTier(o.best[i], t)}</td></tr>`).join('');
    order = `<div class="tr-verdict ${o.efficient ? 'ok' : 'bad'} ptr-v">${o.efficient ? 'EFFICIENT ORDER' : 'REORDER'}</div>
      ${o.efficient ? '' : `<div class="ptr-why">${esc(orderWhy(o))}</div>`}
      <table class="ptr-tiers"><tr><th></th><th>Yours</th><th>Best</th></tr>${rows}</table>
      ${o.efficient ? '' : `<div class="ptr-best"><b>A best order</b><ol>${o.bestOrder.map((i) => `<li>${esc(P.list[i])}</li>`).join('')}</ol>
        <button class="ptr-btn" id="ptrUseBest">Use this order</button></div>`}`;
  }
  return `<div class="ptr-result">
    <div class="tr-verdict ${pr.ok ? 'ok' : 'bad'} ptr-v">${pr.ok ? 'PROTOCOL CORRECT' : 'PROTOCOL INCOMPLETE'}</div>
    <div class="ptr-routine">${routine}</div>
    ${miss || extra ? `<ul class="tr-crit">${miss}${extra}</ul>` : ''}
    ${order}</div>`;
}
const fmtTier = (v, t) => (t.unit ? Math.round(v) + t.unit : String(Math.round(v)));
function orderWhy(o) {
  const t = TIERS[o.tier], mine = Math.round(o.total[o.tier]), best = Math.round(o.best[o.tier]);
  const n = (v, one, many) => `${v} ${v === 1 ? one : many}`;
  switch (t.key) {
    case 'room': return `The room changes ${n(mine, 'time', 'times')}; ${best} ${best === 1 ? 'is' : 'are'} enough. Take every view in one room set-up before moving to the next.`;
    case 'moves': return `The patient or the receptor is moved ${n(mine, 'time', 'times')}; ${best} ${best === 1 ? 'is' : 'are'} enough. Take every view that needs only the tube re-centred, re-angled or re-collimated before moving the patient.`;
    case 'angle': return `The tube is re-angled ${mine}° in all; ${best}° is enough. Take the views at one central-ray angle together.`;
    case 'travel': return `The centring moves ${mine} cm along the patient; ${best} cm is enough. Work along the anatomy, not back and forth.`;
    case 'coll': return `The field changes ${mine} cm in all; ${best} cm is enough. Take similar fields together.`;
    default: return `The turns add up to ${mine}°; ${best}° is enough. Turn progressively in one direction (PA, oblique, lateral).`;
  }
}

function wireWork(el) {
  el.querySelectorAll('.ptr-ord').forEach((b) => b.onclick = () => { P.order = +b.dataset.ord; render(); });
  el.querySelectorAll('.ptr-reg').forEach((b) => b.onclick = () => { P.region = P.region === b.dataset.reg ? null : b.dataset.reg; render(); });
  el.querySelectorAll('.ptr-view').forEach((b) => b.onclick = () => {
    const v = b.dataset.v, i = P.list.indexOf(v);
    if (i >= 0) P.list.splice(i, 1); else P.list.push(v);
    edited(); render();
  });
  el.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { P.list.splice(+b.dataset.rm, 1); edited(); render(); });
  el.querySelectorAll('[data-mv]').forEach((b) => b.onclick = () => move(+b.dataset.i, +b.dataset.i + +b.dataset.mv));
  // drag to reorder
  let from = -1;
  el.querySelectorAll('.ptr-item').forEach((li) => {
    li.addEventListener('dragstart', (e) => { from = +li.dataset.i; li.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; });
    li.addEventListener('dragend', () => li.classList.remove('drag'));
    li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('over'); });
    li.addEventListener('dragleave', () => li.classList.remove('over'));
    li.addEventListener('drop', (e) => { e.preventDefault(); move(from, +li.dataset.i); });
  });
  const ck = $('ptrCheck'); if (ck) ck.onclick = check;
  const fm = $('ptrFilm'); if (fm) fm.onclick = () => makeFilms(P.list.slice());
  const ub = $('ptrUseBest'); if (ub) ub.onclick = () => { P.list = P.checked.order.bestOrder.map((i) => P.list[i]); reorderOnly(); };
}
function move(i, j) {
  if (i < 0 || j < 0 || i >= P.list.length || j >= P.list.length || i === j) return;
  const [v] = P.list.splice(i, 1); P.list.splice(j, 0, v);
  reorderOnly();
}
/* A reorder keeps the protocol's marking and re-judges the order (and re-hangs the films). */
function reorderOnly() {
  if (P.checked) P.checked.order = P.list.length > 1 ? judgeOrder(P.list.map(orderView)) : null;
  render();
}
// a change to which views are chosen undoes the check (the tally counts the first check only)
function edited() { if (P.checked) P.checked = null; }

function check() {
  const proto = checkProtocol(P.req, P.list);
  const order = P.list.length > 1 ? judgeOrder(P.list.map(orderView)) : null;
  if (!P.counted) {
    P.counted = true; P.tally.reqs++;
    if (proto.ok) P.tally.protocol++;
    if (proto.ok && (!order || order.efficient)) P.tally.order++;
  }
  P.checked = { proto, order };
  render();
}
function missedViews() {
  return P.checked ? P.checked.proto.missing.map((s) => s.alts[0]) : [];
}

/* ---------------------------------------------------------------- the films */
function filmsHTML() {
  const names = P.list.filter((v) => P.films[v]);
  const missed = P.missed ? missedViews().filter((v) => P.films[v]) : [];
  if (!names.length && !missed.length) return '';
  const tile = (v, cls = '') => {
    const f = P.films[v], fp = findProj(v);
    const approx = fp?.p.pose?.fidelity === 'approx';
    return `<figure class="ptr-film ${cls}" data-film="${esc(v)}"><div class="ptr-fc">${esc(v)}${approx ? `<span class="ptr-ax" title="${esc(fp.p.pose.note || '')}">approx</span>` : ''}</div>
      <div class="ptr-fi">${f.state === 'done' ? '<canvas></canvas>' : `<div class="ptr-wait">${f.state === 'error' ? esc(f.error) : 'exposing…'}</div>`}</div></figure>`;
  };
  const allDone = [...names, ...missed].every((v) => P.films[v].state !== 'busy');
  const pending = P.checked && P.checked.proto.missing.length && !P.missed;
  return `<div class="ptr-h">Films</div><div class="ptr-lightbox">${names.map((v) => tile(v)).join('')}
      ${missed.map((v) => tile(v, 'missed')).join('')}</div>
    ${allDone ? `<div class="ptr-acts">${pending ? '<button class="ptr-btn" id="ptrMissed">Show the views not taken</button>' : ''}
      <button class="ptr-btn" id="ptrReport">${P.report ? 'Hide report' : 'Report'}</button></div>
      ${P.report ? reportHTML() : ''}` : ''}`;
}
function reportHTML() {
  const r = P.req, f = r.findings;
  const text = typeof f === 'string' ? f : f && (r.pathology ? f.positive : f.negative);
  return `<div class="ptr-report"><div class="rq-bt">Findings</div><div>${esc(text || 'No acute findings.')}</div></div>`;
}
function paintFilms() {
  document.querySelectorAll('#ptrFilms .ptr-film').forEach((fig) => {
    const f = P.films[fig.dataset.film], cv = fig.querySelector('canvas');
    if (f?.state === 'done' && cv) { cv.width = f.canvas.width; cv.height = f.canvas.height; cv.getContext('2d').drawImage(f.canvas, 0, 0); }
  });
  const rp = $('ptrReport'); if (rp) rp.onclick = () => { P.report = !P.report; render(); };
  const ms = $('ptrMissed'); if (ms) ms.onclick = () => { P.missed = true; makeFilms(missedViews()); };
}

/* Make the films of these views, one after another (they share one room). A newer
   requisition, or closing, abandons the rest. */
async function makeFilms(views) {
  const ticket = P.ticket;
  for (const v of views) if (!P.films[v] || P.films[v].state === 'error') P.films[v] = { state: 'busy' };
  render();
  for (const v of views) {
    if (!P || P.ticket !== ticket) return;
    if (P.films[v].state === 'done') continue;
    try {
      P.films[v] = { state: 'done', canvas: await expose(v) };
    } catch (err) {
      console.error('protocol trainer: film failed', v, err);
      if (!P || P.ticket !== ticket) return;
      P.films[v] = { state: 'error', error: 'The exposure failed' };
    }
    if (P && P.ticket === ticket) render();
  }
  if (P && P.ticket === ticket) H.clearPathology?.();
}

const apply = (p, part) => new Promise((done) => H.applyProtocol(p, part, done));
/* One film: the protocol as the chart has it, turned to the requisition's side; the patient's
   pathology in the volume; exposed dry and hung. */
async function expose(name) {
  const f = findProj(name);
  if (!f) throw new Error('no protocol ' + name);
  const meta = VIEW_META[name];
  const ex = examFor(name);
  const side = ex?.side || null;
  const line = ex ? lineById(ex.line) : null;
  const trunkLeft = line?.side === 'trunk' && side === 'L';
  const p = { ...f.p, pose: { ...(f.p.pose || {}) } };
  if (trunkLeft) {
    // the left of a trunk model: the turn mirrored, the centring point on the other side
    if (p.pose.roll) p.pose.roll = -p.pose.roll;
    if (/R$/.test(p.pose.centre || '') && H.hasCentre(p.subject, p.pose.centre.slice(0, -1) + 'L')) p.pose.centre = p.pose.centre.slice(0, -1) + 'L';
  }
  const room = whereTaken(meta, f.part).room;
  // (a pasting study needs its tracking bucky, wherever the patient is)
  H.setRoom(f.p.paste && (room === 'detector' || room === 'seated') ? 'table' : room);
  const res = H.setResolution('film');
  try {
    await apply(p, f.part);
    return await filmOf(name, p, line, side, whereTaken(meta, f.part));
  } finally { H.setResolution(res); }
}
async function filmOf(name, p, line, side, meta) {
  const req = P.req;
  // the pathology belongs to one model: stamped when this view is of it
  const path = req.pathology;
  if (path && PATHOLOGY[path.id]?.subject === H.S.subject) {
    await H.setPathology(path.id, { side: path.side || side || 'R', posture: posture(meta), expiration: /expiration/i.test(name) });
  } else await H.clearPathology?.();
  H.setMarker(null);
  const entry = await H.exposeDry();
  const film = document.createElement('canvas');
  H.renderFilm(film, entry);
  return hang(film, marker(name, line, side, p), line?.side === 'limb' && side === 'L');
}
// the exam this view answers (its line has the view), for the side
function examFor(name) {
  return (P.req.exams || []).find((x) => { const l = lineById(x.line); return l && (l.views.includes(name) || (l.either || []).some((e) => e.of.includes(name))); })
    || (P.req.exams || []).find((x) => x.side) || null;
}
const posture = (m) => (m?.posture === 'erect' ? 'erect' : m?.posture === 'lateral' ? 'lateral' : m?.posture === 'prone' ? 'prone' : 'supine');
/* The side marker: the limb's side; on the trunk the side down on a lateral or posterior oblique
   (+ roll lifts the right: trainer.js idealMarker), the patient's right otherwise. */
function marker(name, line, side, p) {
  if (line?.side === 'limb' && side) return side;
  const roll = ((((p.pose?.roll || 0) + 180) % 360) + 360) % 360 - 180;
  return roll > 0 && roll < 180 ? 'L' : 'R';
}
/* Hang the film: mirrored for a left limb (every limb model is a right one), the marker
   burned into the top corner. */
function hang(src, mk, mirror) {
  const out = document.createElement('canvas');
  out.width = src.width; out.height = src.height;
  const g = out.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, out.width, out.height);
  g.save();
  if (mirror) { g.translate(out.width, 0); g.scale(-1, 1); }
  g.drawImage(src, 0, 0);
  g.restore();
  const s = Math.max(14, Math.round(Math.min(out.width, out.height) * 0.06));
  g.font = `bold ${s}px "Share Tech Mono",monospace`;
  g.textBaseline = 'top';
  g.lineWidth = Math.max(2, s * 0.12); g.strokeStyle = 'rgba(0,0,0,0.8)'; g.fillStyle = '#fff';
  const x = Math.round(s * 0.5), y = Math.round(s * 0.4);
  g.strokeText(mk, x, y); g.fillText(mk, x, y);
  return out;
}

/* QC: drive the trainer from tests. */
if (typeof window !== 'undefined') window.radsimProtocolTrainer = {
  state: () => P,
  load: (seed) => { if (P) newRequisition(seed); },
  pick: (views) => { if (P) { P.list = views.slice(); edited(); render(); } },
  check: () => { if (P) check(); return P?.checked; },
  films: () => (P ? makeFilms(P.list.slice()) : null),
  answer: () => (P ? answerKey(P.req).map((s) => s.alts[0]) : null),
  hospital: HOSPITAL,
  orderCost: (views) => orderCost(views.map(orderView)),
};
