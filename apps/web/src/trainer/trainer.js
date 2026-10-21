/* ============================================================================
   TRAINER — routine series, marked like a practical exam.

   A different interface from the sandbox: one view at a time, in the order a radiographer
   works — POSITION the patient, CENTRE to the landmark, COLLIMATE to an inch beyond the
   required anatomy (and mark the side), EXPOSE. The film is then marked against measured
   criteria (core/trainerEval.js), the faults are drawn on it, and it hangs beside a
   reference film of the same patient made with the ideal setup.

   The Trainer drives the real x-ray room (app.js hooks): the same patient models, protocols,
   physics and side markers as the sandbox. It only takes over the controls column.
   ============================================================================ */
import { SERIES } from './series.js';
import { sampleRegion, cloudCentre } from './regions.js';
import { locToWorld, analyseCoverage, crOffset, judge, neededHalf, fieldCoord, fieldToReceptor,
  BORDER_CM } from '../core/trainerEval.js';

let H = null;                 // app hooks
let T = null;                 // { series, vi, step, results: [], req, busy }
const STEPS = ['position', 'centre', 'collimate', 'expose'];
const STEP_LABEL = { position: 'Position', centre: 'Centre', collimate: 'Collimate', expose: 'Expose' };

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function initTrainer(hooks) {
  H = hooks;
  document.querySelectorAll('#homeScreen .hc-trainer').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation(); openTrainer();
  }));
}

export function trainerActive() { return !!T; }

/* Leaving the x-ray room (home, another mode) ends the session. */
export function trainerOnMode(mode) {
  if (T && mode !== 'xray') closeTrainer();
}

function openTrainer() {
  H.applyMode('xray');
  T = { series: null, vi: 0, step: 'position', results: [], req: null, busy: false };
  document.body.classList.add('trainer');
  showCompare(false);
  renderChooser();
}

function closeTrainer() {
  T = null;
  H.palpation.clear();
  document.body.classList.remove('trainer');
  showCompare(false);
  const col = $('trainerCol'); if (col) col.innerHTML = '';
}

/* ---------------------------------------------------------------- series chooser */
function renderChooser() {
  const col = $('trainerCol');
  col.innerHTML = `
    <div class="tr-head"><div class="tr-title">Trainer</div>
      <button class="tr-x" id="trHome" title="Back to the home screen">&times;</button></div>
    <div class="tr-intro">Pick a series. Each view is set up in order &mdash; position, centre,
      collimate &mdash; then exposed and marked against the criteria an instructor uses. The film
      hangs beside a reference made with the ideal setup.</div>
    <div class="tr-series">${SERIES.map((s) => `<button class="tr-sbtn" data-s="${s.id}">${esc(s.name)}
      <small>${s.views.map((v) => esc(v.label)).join(' · ')}</small></button>`).join('')}</div>`;
  $('trHome').onclick = () => H.applyMode('home');
  col.querySelectorAll('.tr-sbtn').forEach((b) => b.onclick = () => startSeries(b.dataset.s));
}

function startSeries(id) {
  T.series = SERIES.find((s) => s.id === id);
  T.results = T.series.views.map(() => null);
  startView(0);
}

/* ---------------------------------------------------------------- a view */
const rnd = (a, b) => a + Math.random() * (b - a);
function startView(vi) {
  T.vi = vi; T.step = 'position'; T.req = null;
  H.palpation.clear();
  const view = T.series.views[vi];
  showCompare(false);
  H.setContent('3d');
  renderPanel('Loading the patient…');
  const p = H.findProtocol(view.proto[0], view.proto[1]);
  if (!p) { renderPanel('This view has no protocol.'); return; }
  H.applyProtocol(p, view.proto[0], () => {
    if (!T || T.series.views[T.vi] !== view) return;
    const S = H.S;
    // the required anatomy, from this patient's own volume
    T.req = sampleRegion(S.voxelModel, H.voxelFlips(), H.landmarkLocal, view.require.parts);
    // START STATE: the patient near, not at, the right position; the field wide open; no marker.
    // Every step has something to do, and nothing is set up for the student.
    const sgn = Math.random() < 0.5 ? -1 : 1;
    const startRoll = view.pose.roll === 0 ? sgn * rnd(8, 15) : (Math.abs(view.pose.roll) >= 90 ? 0 : sgn * rnd(6, 12));
    S.objRot = { x: 0, y: 0, z: Math.round(startRoll) };
    S.angCC = 0; S.angLM = 0; S.tubeX = 0; S.tubeZ = 0;
    const ideal = idealOffset(view, S.objRot);
    const th = rnd(0, 2 * Math.PI), r = rnd(3, 6);
    S.objOff.x = clampOff(ideal.x + r * Math.cos(th));
    S.objOff.z = clampOff(ideal.z + r * Math.sin(th));
    S.collX = S.detW; S.collZ = S.detH;
    H.setMarker(null);
    H.syncSandbox();
    H.syncScene();
    renderPanel();
  });
}
const clampOff = (v) => Math.max(-45, Math.min(45, v));

// the centring point in the post-flip frame
function centreLoc(view) {
  if (view.centre.lm) return H.landmarkLocal(view.centre.lm);
  if (view.centre.fromRequired && T.req && T.req.length) return cloudCentre(T.req);
  return [0, 0, 0];
}
/* The table offset that puts the centring point on the central ray, for a given rotation:
   the point is rotated with the patient, and an angled ray is followed down to the point's
   own height (protocol centring ignores the angle; at 15° on a wrist that is a few mm). */
function idealOffset(view, rot, cc = 0) {
  const S = H.S, R = H.matFor(rot);
  const loc = centreLoc(view);
  const w = locToWorld(loc, R, [0, H.modelCentreY(), 0]);
  const t = Math.tan(cc * Math.PI / 180);
  return { x: -w[0], z: -w[2] + w[1] * t };
}

/* ---------------------------------------------------------------- the panel */
function renderPanel(msg) {
  const col = $('trainerCol'); if (!col || !T) return;
  const view = T.series.views[T.vi], S = H.S;
  const tabs = T.series.views.map((v, i) => {
    const r = T.results[i];
    const mark = r ? (r.pass ? '<i class="ok">&#10003;</i>' : '<i class="bad">&#10007;</i>') : '';
    return `<button class="tr-vtab${i === T.vi ? ' on' : ''}" data-v="${i}">${esc(v.label)}${mark}</button>`;
  }).join('');
  const steps = STEPS.map((s, i) => `<button class="tr-step${s === T.step ? ' on' : ''}${STEPS.indexOf(T.step) > i ? ' done' : ''}" data-step="${s}">${i + 1}. ${STEP_LABEL[s]}</button>`).join('');
  let body = '';
  if (msg) body = `<div class="tr-note">${esc(msg)}</div>`;
  else if (T.step === 'results') body = resultsHTML();
  else body = stepHTML(view, S);
  col.innerHTML = `
    <div class="tr-head"><div class="tr-title">${esc(T.series.name)}</div>
      <button class="tr-x" id="trBack" title="Choose another series">&#8617;</button>
      <button class="tr-x" id="trHome" title="Back to the home screen">&times;</button></div>
    <div class="tr-vtabs">${tabs}</div>
    <div class="tr-view"><b>${esc(view.label)}</b> &middot; ${esc(view.proto[1])}</div>
    <div class="tr-how">${esc(view.how)}${view.approx ? `<div class="tr-approx">${esc(view.approx)}</div>` : ''}</div>
    <div class="tr-req"><b>Required:</b> ${esc(view.require.text)}</div>
    ${T.step === 'results' || msg ? '' : `<div class="tr-steps">${steps}</div>`}
    <div class="tr-body">${body}</div>`;
  $('trHome').onclick = () => H.applyMode('home');
  $('trBack').onclick = () => { showCompare(false); T.series = null; renderChooser(); };
  col.querySelectorAll('.tr-vtab').forEach((b) => b.onclick = () => startView(+b.dataset.v));
  col.querySelectorAll('.tr-step').forEach((b) => b.onclick = () => { T.step = b.dataset.step; renderPanel(); });
  wireStep(col, view);
}

const slider = (id, label, min, max, step, val, unit) => `
  <div class="row"><div class="rl">${label}</div><div class="valchip" id="${id}V">${fmt(val, step)}${unit}</div></div>
  <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}" data-unit="${unit}">`;
const fmt = (v, step) => (step < 1 ? (+v).toFixed(1) : Math.round(+v));

function stepHTML(view, S) {
  const next = (to, label) => `<button class="tr-next" data-to="${to}">${label} &rsaquo;</button>`;
  if (T.step === 'position') {
    return `<div class="tr-sec">
      ${slider('trRoll', 'Rotate <small>about the long axis</small>', -180, 180, 1, S.objRot.z, '°')}
      ${slider('trTilt', 'Tilt <small>side to side</small>', -30, 30, 1, S.objRot.x, '°')}
      ${slider('trTurn', 'Turn <small>in the plane of the table</small>', -30, 30, 1, S.objRot.y, '°')}
      <div class="tr-tip">Watch the patient in the room: the rotation is judged against the view's,
        within ${view.pose.tol}°. The film is the only feedback after the exposure &mdash; as on the job.</div>
      ${next('centre', 'Centre')}</div>`;
  }
  if (T.step === 'centre') {
    const words = view.cr?.words || ['cephalic', 'caudal'];
    return `<div class="tr-sec">
      <div class="tr-target">Centre to: <b>${esc(view.centre.name)}</b> (&plusmn; ${view.centre.tol} cm)</div>
      ${slider('trOffZ', 'Table <small>along the patient</small>', -45, 45, 0.1, S.objOff.z, ' cm')}
      ${slider('trOffX', 'Table <small>across</small>', -45, 45, 0.1, S.objOff.x, ' cm')}
      ${slider('trCC', `Central-ray angle <small>&minus; ${esc(words[0])} / + ${esc(words[1])}</small>`, -30, 30, 1, S.angCC, '°')}
      <div class="tr-tip">The collimator light's crosshair on the skin is the central ray. Move the
        table until it sits on the centring point.</div>
      ${palpateHTML(S)}
      ${next('collimate', 'Collimate')}</div>`;
  }
  if (T.step === 'collimate') {
    const m = S.marker || {};
    return `<div class="tr-sec">
      ${slider('trCollX', 'Field width', 4, S.detW, 0.5, S.collX, ' cm')}
      ${slider('trCollZ', 'Field length', 4, S.detH, 0.5, S.collZ, ' cm')}
      <div class="tr-tip">Collimate to about 1&Prime; (2.5 cm) beyond the required anatomy on every
        side &mdash; including its soft tissue &mdash; and no wider.</div>
      <div class="row" style="margin-top:8px"><div class="rl">Side marker</div></div>
      <div class="seg" id="trMk">
        <button data-side="" class="${!m.side ? 'on' : ''}">None</button>
        <button data-side="R" class="${m.side === 'R' ? 'on' : ''}">R</button>
        <button data-side="L" class="${m.side === 'L' ? 'on' : ''}">L</button></div>
      <div class="tr-tip">The marker drops at the edge of the field on the side it names; drag the
        yellow tile in the room to move it.</div>
      ${next('expose', 'Ready')}</div>`;
  }
  // expose
  return `<div class="tr-sec">
    <div class="tr-tip">Technique is set from the protocol (${S.kv} kVp, ${S.mas} mAs${S.aecOn ? ', AEC' : ''}).
      Check the patient, the centring and the field in the room, then expose.</div>
    <button class="tr-expose" id="trExpose"${T.busy ? ' disabled' : ''}>${T.busy ? 'Exposing…' : 'EXPOSE'}</button></div>`;
}

/* PALPATE: show where a bony landmark is felt on this patient's skin (trainer/palpate.js) */
function palpateHTML(S) {
  const list = H.palpation.list(S.subject);
  if (!list.length) return '';
  const on = new Set(H.palpation.active());
  return `<div class="tr-palp"><button class="tr-palp-btn" id="trPalpBtn">Palpate&hellip;</button>
    <div class="tr-palp-menu" id="trPalpMenu">${list.map((p) => `<button data-k="${p.key}" class="${on.has(p.key) ? 'on' : ''}"
      title="${esc(p.how)}">${esc(p.label)}</button>`).join('')}
      <button data-k="" class="clear">Clear</button></div></div>`;
}

function wireStep(col, view) {
  const S = H.S;
  const pb = $('trPalpBtn');
  if (pb) {
    pb.onclick = () => $('trPalpMenu').classList.toggle('show');
    col.querySelectorAll('#trPalpMenu button').forEach((b) => b.onclick = () => {
      if (!b.dataset.k) { H.palpation.clear(); col.querySelectorAll('#trPalpMenu button').forEach((x) => x.classList.remove('on')); return; }
      const on = !b.classList.contains('on');
      if (H.palpation.set(b.dataset.k, on)) b.classList.toggle('on', on);
    });
  }
  col.querySelectorAll('.tr-next').forEach((b) => b.onclick = () => { T.step = b.dataset.to; renderPanel(); });
  const bind = (id, set) => {
    const el = $(id); if (!el) return;
    el.oninput = () => {
      const v = +el.value; set(v);
      const lab = $(id + 'V'); if (lab) lab.textContent = fmt(v, +el.step) + el.dataset.unit;
      H.syncSandbox(); H.syncScene();
    };
  };
  bind('trRoll', (v) => { S.objRot.z = v; });
  bind('trTilt', (v) => { S.objRot.x = v; });
  bind('trTurn', (v) => { S.objRot.y = v; });
  bind('trOffZ', (v) => { S.objOff.z = v; });
  bind('trOffX', (v) => { S.objOff.x = v; });
  bind('trCC', (v) => { S.angCC = v; });
  bind('trCollX', (v) => { S.collX = v; });
  bind('trCollZ', (v) => { S.collZ = v; });
  col.querySelectorAll('#trMk button').forEach((b) => b.onclick = () => {
    H.setMarker(b.dataset.side || null);
    col.querySelectorAll('#trMk button').forEach((x) => x.classList.toggle('on', x === b));
    H.syncScene();
  });
  const ex = $('trExpose'); if (ex) ex.onclick = () => expose(view);
  col.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => {
    if (b.dataset.act === 'retake') { T.step = 'position'; showCompare(false); H.setContent('3d'); renderPanel(); }
    else if (b.dataset.act === 'next') startView(T.vi + 1);
    else if (b.dataset.act === 'film') showCompare(true);
  });
}

/* ---------------------------------------------------------------- expose + mark */
function frameNow() {
  const S = H.S, f = H.tubeFrame();
  return { src: f.source, fd: f.d, wAxis: f.wAxis, lAxis: f.lAxis, sid: S.sid,
           tw: (S.collX / 2) / S.sid, tl: (S.collZ / 2) / S.sid };
}
function worldCloud(R, centre) {
  const n = T.req.length / 3, out = new Float32Array(T.req.length);
  for (let k = 0; k < n; k++) {
    const w = locToWorld([T.req[3 * k], T.req[3 * k + 1], T.req[3 * k + 2]], R, centre);
    out[3 * k] = w[0]; out[3 * k + 1] = w[1]; out[3 * k + 2] = w[2];
  }
  return out;
}
function measure(view) {
  const S = H.S, R = H.objMat(), centre = H.modelCentre();
  const F = frameNow();
  const pts = worldCloud(R, centre);
  const lmW = locToWorld(centreLoc(view), R, centre);
  return { F, pts, lmW, R,
    m: { rot: { ...S.objRot }, angCC: S.angCC, angLM: S.angLM, cr: crOffset(lmW, F), cov: analyseCoverage(pts, F),
         rightAtPlusX: R[0] > -0.5, marker: S.lastMarker || null, di: H.lastDI() } };
}

async function expose(view) {
  if (T.busy || !T.req) return;
  T.busy = true; renderPanel();
  try {
    await H.expose();
    const meas = measure(view);
    const criteria = judge(view, meas.m);
    const entry = H.S.imgHistory[H.S.imgHistory.length - 1];
    const res = { criteria, pass: !criteria.some((c) => c.level === 'fail'), entry, meas, ref: null };
    T.results[T.vi] = res;
    T.busy = false; T.step = 'results';
    renderPanel();
    showCompare(true);
    // the reference film is made after the student's is on the wall: it is a second exposure
    res.ref = await referenceImage(view);
    if (T && T.results[T.vi] === res) drawCompare(view, res);
  } catch (err) {
    console.error('trainer exposure failed', err);
    T.busy = false; renderPanel('The exposure failed: ' + (err?.message || err));
  }
}

/* THE REFERENCE FILM: this patient with the view set up as it should be — the rotation, the
   central ray on the centring point, the field an inch beyond the required anatomy, the right
   marker — exposed with the same physics and not recorded anywhere. The room is put back. */
async function referenceImage(view) {
  const S = H.S;
  const save = { rot: { ...S.objRot }, off: { ...S.objOff }, cc: S.angCC, lm: S.angLM, tx: S.tubeX, tz: S.tubeZ,
    collX: S.collX, collZ: S.collZ, marker: S.marker ? { ...S.marker } : null, aec: S.aecResult };
  try {
    applyIdeal(view);
    const img = await H.exposeDry();
    return { img, meas: measure(view) };
  } finally {
    S.objRot = save.rot; S.objOff.x = save.off.x; S.objOff.z = save.off.z; S.objOff.y = save.off.y;
    S.angCC = save.cc; S.angLM = save.lm; S.tubeX = save.tx; S.tubeZ = save.tz;
    S.collX = save.collX; S.collZ = save.collZ; S.aecResult = save.aec;
    if (save.marker) Object.assign(S.marker, save.marker);
    H.syncScene();
  }
}
/* The ideal setup of a view, applied to the room (the reference film, and the QC hook). */
function applyIdeal(view) {
  const S = H.S, cc = view.cr?.cc ?? 0;
  S.objRot = { x: 0, y: 0, z: view.pose.roll };
  S.angCC = cc; S.angLM = 0; S.tubeX = 0; S.tubeZ = 0;
  const off = idealOffset(view, S.objRot, cc);
  S.objOff.x = clampOff(off.x); S.objOff.z = clampOff(off.z);
  // the field the anatomy needs, at this geometry
  S.collX = S.detW; S.collZ = S.detH;
  const need = neededHalf(measure(view).m.cov);
  S.collX = Math.min(S.detW, 2 * need.w); S.collZ = Math.min(S.detH, 2 * need.l);
  H.setMarker(idealMarker(view), true);
}
/* QC: drive the Trainer from tests — the session, and the ideal setup of the current view. */
if (typeof window !== 'undefined') window.radsimTrainer = {
  state: () => T,
  applyIdeal: () => { if (T && T.series) { applyIdeal(T.series.views[T.vi]); H.syncSandbox(); H.syncScene(); } },
  measure: () => (T && T.series ? measure(T.series.views[T.vi]) : null),
};
// the marker a perfect film carries: the side down on a lateral, the patient's right otherwise
function idealMarker(view) {
  const roll = ((view.pose.roll % 360) + 360) % 360;
  if (roll === 90) return 'L';          // +90 lifts the right: left lateral
  if (roll === 270) return 'R';
  return 'R';
}

/* ---------------------------------------------------------------- results */
function resultsHTML() {
  const r = T.results[T.vi];
  if (!r) return '';
  const icon = { pass: '&#10003;', warn: '!', fail: '&#10007;' };
  const last = T.vi >= T.series.views.length - 1;
  const done = T.results.filter(Boolean).length;
  const passed = T.results.filter((x) => x && x.pass).length;
  return `<div class="tr-verdict ${r.pass ? 'ok' : 'bad'}">${r.pass ? 'PASS' : 'REPEAT'}</div>
    <ul class="tr-crit">${r.criteria.map((c) => `<li class="${c.level}"><span class="ic">${icon[c.level]}</span>
      <b>${esc(c.label)}</b><div>${esc(c.detail)}</div></li>`).join('')}</ul>
    <div class="tr-legend"><span class="lg-req"></span> required anatomy
      <span class="lg-cut"></span> cut off <span class="lg-ideal"></span> ideal field
      <span class="lg-tgt"></span> centring point</div>
    <div class="tr-acts">
      <button data-act="film">Show films</button>
      <button data-act="retake">Retake</button>
      ${last ? '' : '<button data-act="next" class="tr-next">Next view &rsaquo;</button>'}
    </div>
    <div class="tr-tally">Series: ${passed} of ${T.series.views.length} passed${done < T.series.views.length ? ` (${done} taken)` : ''}.</div>`;
}

function showCompare(on) {
  const el = $('trainerCompare'); if (!el) return;
  el.classList.toggle('show', !!on && !!T);
  if (on && T) {
    const r = T.results[T.vi]; if (r) drawCompare(T.series.views[T.vi], r);
  }
}

function drawCompare(view, r) {
  const el = $('trainerCompare'); if (!el) return;
  el.innerHTML = `
    <div class="trc-pane"><div class="trc-cap">Your film ${r.pass ? '<i class="ok">PASS</i>' : '<i class="bad">REPEAT</i>'}</div><canvas id="trcYou"></canvas></div>
    <div class="trc-pane"><div class="trc-cap">Reference</div><canvas id="trcRef"></canvas>
      ${r.ref ? '' : '<div class="trc-wait">making the reference film…</div>'}</div>
    <button class="trc-close" title="Back to the room">&times;</button>`;
  el.querySelector('.trc-close').onclick = () => showCompare(false);
  paintFilm($('trcYou'), r.entry, r.meas, view, true);
  if (r.ref) paintFilm($('trcRef'), r.ref.img, r.ref.meas, view, false);
}

/* One film with what the marking found drawn on it, on the whole receptor so that what the
   field cut off can be shown where it would have been. */
function paintFilm(cv, entry, meas, view, faults) {
  if (!cv || !entry) return;
  const full = document.createElement('canvas');
  const map = H.renderFull(full, entry, 2, 0.15);
  if (!map) return;
  const g = full.getContext('2d'), F = meas.F;
  // everything drawn is tracked, so the hung film can be cropped to what matters
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (p) => { box[0] = Math.min(box[0], p[0]); box[1] = Math.min(box[1], p[1]); box[2] = Math.max(box[2], p[0]); box[3] = Math.max(box[3], p[1]); };
  const onFilm = (w) => {   // a world point -> receptor plane -> canvas
    const t = -F.src[1] / (w[1] - F.src[1]);
    return map(F.src[0] + t * (w[0] - F.src[0]), F.src[2] + t * (w[2] - F.src[2]));
  };
  // the required anatomy: a faint fill, its outline (convex hull) in green, and in red every part
  // the field did not take
  const pts = meas.pts, n = pts.length / 3, stride = Math.max(1, Math.floor(n / 12000));
  const film = [];
  for (let k = 0; k < n; k += stride) {
    const w = [pts[3 * k], pts[3 * k + 1], pts[3 * k + 2]];
    const c = fieldCoord(w, F); if (!c) continue;
    const inside = Math.abs(c[0]) <= F.tw && Math.abs(c[1]) <= F.tl;
    const p = onFilm(w); film.push(p); grow(p);
    if (!inside && !faults) continue;
    g.fillStyle = inside ? 'rgba(80,220,120,0.07)' : 'rgba(255,70,70,0.6)';
    g.fillRect(p[0] - 1, p[1] - 1, 2, 2);
  }
  const hull = convexHull(film);
  if (hull.length > 2) {
    g.save(); g.strokeStyle = 'rgba(80,220,120,0.85)'; g.lineWidth = 2;
    g.beginPath(); hull.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.stroke(); g.restore();
  }
  // the field that was used, and (on the student's film) the one the view needed
  const rect = (cw, cl, hw, hl, style, dash) => {
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => map(...fieldToReceptor(cw + a * hw, cl + b * hl, F)));
    c.forEach(grow);
    g.save(); g.strokeStyle = style; g.lineWidth = 2; g.setLineDash(dash || []);
    g.beginPath(); c.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.stroke(); g.restore();
  };
  rect(0, 0, F.tw, F.tl, 'rgba(255,255,255,0.55)');
  if (faults) {
    const lc = fieldCoord(meas.lmW, F) || [0, 0];
    // the ideal field: centred on the centring point, an inch beyond the anatomy each way
    const e = meas.m.cov.ext, s = F.sid;
    const hw = (Math.max(Math.abs(e.wMin / s - lc[0]), Math.abs(e.wMax / s - lc[0])) * s + BORDER_CM) / s;
    const hl = (Math.max(Math.abs(e.lMin / s - lc[1]), Math.abs(e.lMax / s - lc[1])) * s + BORDER_CM) / s;
    rect(lc[0], lc[1], hw, hl, 'rgba(90,200,255,0.9)', [8, 6]);
  }
  // the central ray, and the centring point it should have been on
  const cr = map(...fieldToReceptor(0, 0, F)), tp = onFilm(meas.lmW);
  grow(tp);
  g.save();
  g.strokeStyle = '#ffffff'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(cr[0] - 12, cr[1]); g.lineTo(cr[0] + 12, cr[1]); g.moveTo(cr[0], cr[1] - 12); g.lineTo(cr[0], cr[1] + 12); g.stroke();
  g.strokeStyle = '#ffcf4a'; g.beginPath(); g.arc(tp[0], tp[1], 9, 0, 2 * Math.PI); g.stroke();
  if (faults && Math.hypot(tp[0] - cr[0], tp[1] - cr[1]) > 14) {
    g.setLineDash([5, 4]); g.beginPath(); g.moveTo(cr[0], cr[1]); g.lineTo(tp[0], tp[1]); g.stroke();
  }
  g.restore();
  // hang it cropped to the film, the fields and the anatomy, with a margin
  const m = 30;
  const x0 = Math.max(0, Math.floor(box[0] - m)), y0 = Math.max(0, Math.floor(box[1] - m));
  const x1 = Math.min(full.width, Math.ceil(box[2] + m)), y1 = Math.min(full.height, Math.ceil(box[3] + m));
  cv.width = Math.max(1, x1 - x0); cv.height = Math.max(1, y1 - y0);
  cv.getContext('2d').drawImage(full, x0, y0, cv.width, cv.height, 0, 0, cv.width, cv.height);
}
// 2-D convex hull (monotone chain) of [x, y] points
function convexHull(p) {
  if (p.length < 3) return p.slice();
  const s = p.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of s) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = s.length - 1; i >= 0; i--) { const q = s[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
