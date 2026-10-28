/* ============================================================================
   ORDER OF OPERATIONS TRAINER — the department's Method of Operation, drilled until automatic.

   One question at a time from core/mooQuiz.js's deck, chosen by its spacing: what was missed
   comes back two questions later, what is known drifts further away each time it is answered.
   Answers are typed (the first sight of a step/next/previous card offers four choices, once);
   a wrong typed answer must be typed again correctly before the next question, and a card
   that has climbed to the third box is answered against the clock. Progress is kept in this
   browser (localStorage, when it can be).
   ============================================================================ */
import { MOO_TITLE } from './moo.js';
import { buildDeck, newState, reconcile, pickCard, record, askAs, mastery, markOrder, shuffle, markConcepts } from '../core/mooQuiz.js';

const KEY = 'radsim.moo.v1';
let H = null;
let M = null;            // the session: { deck, state, card, ask, phase, arranged, items, streak, best, last, result, timer }

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rng = Math.random;

function load(deck) {
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s?.cards) return reconcile(s, deck); } catch { /* private window */ }
  return newState(deck);
}
function save() { try { localStorage.setItem(KEY, JSON.stringify({ ...M.state, best: M.best })); } catch { /* not kept */ } }

export function initMooTrainer(hooks) {
  H = hooks;
  document.querySelectorAll('#homeScreen .hc-moo').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); open(); }));
  window.radsimMoo = {
    open, state: () => M && { n: M.state.n, card: M.card?.id, phase: M.phase, ask: M.ask, streak: M.streak, mastery: mastery(M.state) },
    answer: (a) => { if (!M) return null; if (M.card.kind === 'order') M.arranged = a; else { const i = $('mooIn'); if (i) i.value = a; } submit(); return M.result; },
    goto: (id) => { if (!M) return; const c = M.deck.find((x) => x.id === id); if (c) ask(c); },
  };
}
export function mooTrainerOnMode(mode) { if (M && mode !== 'xray') close(); }

function open() {
  H.applyMode('xray');
  const deck = buildDeck();
  const state = load(deck);
  M = { deck, state, streak: 0, best: state.best || 0, last: null };
  document.body.classList.add('mootrainer');
  const el = $('mootrainer'); if (el) el.hidden = false;
  document.addEventListener('keydown', onKey, true);
  next();
}
function close() {
  if (!M) return;
  clearInterval(M.timer);
  document.removeEventListener('keydown', onKey, true);
  M = null;
  document.body.classList.remove('mootrainer');
  const el = $('mootrainer'); if (el) { el.hidden = true; el.innerHTML = ''; }
}

/* ---------------------------------------------------------------- the questions */
function next() { ask(pickCard(M.state, M.deck, rng, M.last)); }
function ask(card) {
  clearInterval(M.timer);
  M.card = card; M.last = card.id; M.phase = 'ask'; M.result = null;
  M.ask = askAs(M.state, card, rng);
  if (card.kind === 'order') {
    // never offered already in order
    let items; do { items = shuffle(card.items, rng); } while (items.length > 1 && items.every((t, i) => t === card.items[i]));
    M.items = items; M.arranged = [];
  }
  M.left = M.ask.timed;
  render();
  if (M.left) M.timer = setInterval(() => {
    if (!M || M.phase !== 'ask') return;
    M.left--; const t = $('mooClock'); if (t) { t.textContent = `${M.left}s`; t.classList.toggle('low', M.left <= 5); }
    if (M.left <= 0) { clearInterval(M.timer); submit(true); }
  }, 1000);
}
function submit(timeUp = false, choice = null) {
  if (!M || M.phase !== 'ask') return;
  clearInterval(M.timer);
  const c = M.card;
  let res;
  if (choice != null) res = { ok: choice === c.step.text, missing: [] , given: choice };
  else if (c.kind === 'order') res = { ...markOrder(M.arranged, c.items), given: M.arranged.join('\n') };
  else { const a = $('mooIn')?.value || ''; res = { ...c.mark(a), given: a }; }
  if (timeUp && !res.ok) res.timeUp = true;
  M.result = res;
  record(M.state, c, res.ok);
  M.streak = res.ok ? M.streak + 1 : 0; M.best = Math.max(M.best, M.streak);
  save();
  // a wrong typed answer to a single step is copied out correctly before moving on
  M.phase = !res.ok && c.kind === 'text' && c.step && choice == null ? 'retype' : 'shown';
  render();
}
function retype() {
  const a = $('mooFix')?.value || '';
  if (markConcepts(a, M.card.step.concepts).ok) { M.phase = 'shown'; render(); }
  else { const f = $('mooFix'); f?.classList.remove('shake'); void f?.offsetWidth; f?.classList.add('shake'); }
}
function onKey(e) {
  if (!M) return;
  e.stopPropagation();                                        // the room behind (Space exposes) hears nothing
  if (e.key === 'Escape') { e.preventDefault(); H.applyMode('home'); return; }
  if (e.key !== 'Enter') {
    if (M.phase === 'ask' && M.ask.options && /^[1-4]$/.test(e.key)) { e.preventDefault(); submit(false, M.ask.options[+e.key - 1]); }
    return;
  }
  const multi = M.phase === 'ask' && M.card.kind === 'list';
  if (multi && !(e.ctrlKey || e.metaKey)) return;               // new line in the list
  e.preventDefault(); e.stopPropagation();
  if (M.phase === 'ask') { if (!M.ask.options) submit(); }
  else if (M.phase === 'retype') retype();
  else next();
}

/* ---------------------------------------------------------------- rendering */
const KIND = { text: '', number: 'Number', list: 'Recall', order: 'Order' };
function render() {
  const el = $('mootrainer'); if (!el || !M) return;
  const c = M.card, cs = M.state.cards[c.id], pct = Math.round(mastery(M.state) * 100);
  el.innerHTML = `
    <div class="ptr-bar">
      <div class="ptr-title">Order of Operations</div>
      <div class="ptr-tally">${esc(MOO_TITLE)} &middot; mastery ${pct}% &middot; streak ${M.streak} <small>(best ${M.best})</small> &middot; ${M.state.n} answered</div>
      <button class="ptr-btn" id="mooFull">Whole routine</button>
      <button class="ptr-btn" id="mooReset">Reset</button>
      <button class="tr-x" id="mooHome" title="Back to the home screen">&times;</button>
    </div>
    <div class="moo-meter"><i style="width:${pct}%"></i></div>
    <div class="moo-card">
      <div class="moo-meta"><span>${esc(KIND[c.kind] || '')}</span><span class="moo-box">${'●'.repeat(cs.box)}${'○'.repeat(Math.max(0, 6 - cs.box))}</span>
        ${M.ask.timed && M.phase === 'ask' ? `<span class="moo-clock" id="mooClock">${M.left}s</span>` : ''}</div>
      <div class="moo-q">${esc(c.prompt)}</div>
      ${M.phase === 'ask' ? askHTML(c) : resultHTML(c)}
    </div>`;
  $('mooHome').onclick = () => H.applyMode('home');
  $('mooFull').onclick = () => ask(M.deck.find((x) => x.id === 'full'));
  $('mooReset').onclick = () => { if (!confirm('Forget all progress?')) return; M.state = newState(M.deck); M.streak = 0; M.best = 0; save(); next(); };
  el.querySelectorAll('[data-opt]').forEach((b) => b.onclick = () => submit(false, M.ask.options[+b.dataset.opt]));
  el.querySelectorAll('[data-item]').forEach((b) => b.onclick = () => { M.arranged.push(M.items[+b.dataset.item]); render(); if (M.arranged.length === M.items.length) submit(); });
  const undo = $('mooUndo'); if (undo) undo.onclick = () => { M.arranged.pop(); render(); };
  const go = $('mooGo'); if (go) go.onclick = () => submit();
  const fix = $('mooFixGo'); if (fix) fix.onclick = retype;
  const nx = $('mooNext'); if (nx) nx.onclick = next;
  ($('mooIn') || $('mooFix') || $('mooNext'))?.focus();
}
function askHTML(c) {
  if (M.ask.options) return `<div class="moo-opts">${M.ask.options.map((o, i) =>
    `<button class="moo-opt" data-opt="${i}"><b>${i + 1}</b>${esc(o)}</button>`).join('')}</div>`;
  if (c.kind === 'order') {
    const placed = M.arranged.map((t, i) => `<li>${i + 1}. ${esc(t)}</li>`).join('');
    return `<ol class="moo-placed">${placed}</ol>
      <div class="moo-items">${M.items.map((t, i) => M.arranged.includes(t) ? ''
        : `<button class="moo-item" data-item="${i}">${esc(t)}</button>`).join('')}</div>
      <div class="ptr-acts"><button class="ptr-btn" id="mooUndo" ${M.arranged.length ? '' : 'disabled'}>Undo</button></div>`;
  }
  const field = c.kind === 'list'
    ? `<textarea id="mooIn" class="moo-in" rows="${Math.max(3, c.lines || 4)}" spellcheck="false" autocomplete="off"></textarea>`
    : `<input id="mooIn" class="moo-in" type="text" spellcheck="false" autocomplete="off">`;
  return `${field}<div class="ptr-acts"><button class="ptr-btn ptr-go" id="mooGo">Answer</button>
    <small class="moo-key">${c.kind === 'list' ? 'Ctrl+Enter' : 'Enter'}</small></div>`;
}
function resultHTML(c) {
  const r = M.result;
  const head = r.ok ? '<div class="moo-v ok">Correct</div>' : `<div class="moo-v bad">${r.timeUp ? 'Out of time' : 'Not quite'}</div>`;
  const given = r.given ? `<div class="moo-given"><span>You</span><pre>${esc(r.given)}</pre></div>` : '';
  const miss = !r.ok && r.missing?.length ? `<div class="moo-miss"><span>Missing</span>${r.missing.map((m) => `<i>${esc(m)}</i>`).join('')}</div>` : '';
  const ans = `<div class="moo-ans"><span>Routine</span><pre>${esc(c.answer)}</pre></div>`;
  const tail = M.phase === 'retype'
    ? `<div class="moo-fix"><input id="mooFix" class="moo-in" type="text" spellcheck="false" autocomplete="off" placeholder="Type it correctly">
         <button class="ptr-btn" id="mooFixGo">Enter</button></div>`
    : `<div class="ptr-acts"><button class="ptr-btn ptr-go" id="mooNext">Next</button><small class="moo-key">Enter</small></div>`;
  return head + given + miss + ans + tail;
}
