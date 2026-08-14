// ============================================================================
//  Guided tutorials — a walk through one mode, control by control.
//
//  A tutorial is a list of steps. Each step points at a real control, dims
//  everything else, explains what that control does, and (usually) asks the
//  learner to actually use it before moving on. The engine here knows nothing
//  about radiography; the step lists in tutorial-content.js carry all of that.
//
//  Two decisions worth stating, because they shape the whole thing:
//
//  * The highlighted control stays LIVE. The dimming is four panels laid around
//    the target rather than one sheet with a hole punched in it, so the target
//    is not covered by anything and behaves exactly as it does outside the
//    tutorial. A tour that makes you watch instead of do teaches very little.
//  * Every step can be skipped. A goal is how the step would like to end, not a
//    gate — NEXT always advances. Some controls (the compute engine, the vendor
//    theme) have no sensible goal at all and are explanation-only.
// ============================================================================

import { XRAY_STEPS, CT_STEPS, EDITOR_STEPS, BARIUM_STEPS, FLUORO_STEPS, MAMMO_STEPS,
         US_STEPS, DXA_STEPS } from './tutorial-content.js';

let ctx = null;
let T = null;            // the running tutorial, or null
let tickTimer = null;

const $ = (id) => document.getElementById(id);
const PAD = 6;           // breathing room between the ring and the control
const TICK = 220;        // goal poll + rect re-measure, ms

export function initTutorial(context) {
  ctx = context;
  // The welcome message opens and closes in place. It stays collapsed by default so the mode
  // cards are the first thing on screen, but the button sits directly under the title where a
  // first-time visitor will actually see it.
  const wb = $('welcomeBtn'), wm = $('welcomeMsg');
  if (wb && wm) {
    wb.addEventListener('click', () => {
      const open = wm.hidden;
      wm.hidden = !open;
      wb.setAttribute('aria-expanded', String(open));
      wb.querySelector('.wb-t').textContent = open ? 'Hide the welcome message'
                                                   : 'Welcome \u2014 read this first';
      if (open) wm.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
  document.querySelectorAll('#homeScreen .hc-tut').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); startTutorial(b.dataset.tut); });
  });
  $('tutNext').addEventListener('click', () => go(T ? T.i + 1 : 0));
  $('tutPrev').addEventListener('click', () => go(T ? T.i - 1 : 0));
  $('tutExit').addEventListener('click', endTutorial);
  document.addEventListener('keydown', (e) => {
    if (!T) return;
    // Escape belongs to whatever popup is open — it is the cancel key on the value entry and
    // the protocol chooser. Stealing it would quit the entire tutorial from a routine cancel.
    if (e.key === 'Escape') { if (!openModal()) endTutorial(); return; }
    // Arrows belong to whatever the learner is typing in or dragging. A slider takes arrow
    // keys to nudge its value; jumping to the next step instead would be maddening.
    const f = document.activeElement;
    if (f && (f.matches('input, select, textarea') || f.isContentEditable)) return;
    if (openModal()) return;
    if (e.key === 'ArrowRight') go(T.i + 1);
    else if (e.key === 'ArrowLeft') go(T.i - 1);
  });
  addEventListener('resize', () => { if (T) paint(); });
}

const STEPS = { xray: XRAY_STEPS, ct: CT_STEPS, editor: EDITOR_STEPS, barium: BARIUM_STEPS,
                fluoro: FLUORO_STEPS, mammo: MAMMO_STEPS, us: US_STEPS, dxa: DXA_STEPS };
// A tutorial does not have to be a mode of its own: the barium walkthrough is a set of
// steps that happens to run inside x-ray mode, because fluoroscopy IS x-ray with a clock.
const TUT_MODE = { barium: 'xray' };

export function startTutorial(mode) {
  const steps = STEPS[mode];
  if (!steps) return;
  ctx.applyMode(TUT_MODE[mode] || mode);     // the tutorial runs inside the real mode
  T = { mode, steps, i: -1, met: false };
  document.body.classList.add('tut-on');
  tickTimer = setInterval(tick, TICK);
  setTimeout(() => go(0), 420);              // let the mode finish laying itself out
}

export function endTutorial() {
  if (!T) return;
  clearInterval(tickTimer); tickTimer = null;
  T = null;
  document.body.classList.remove('tut-on');
  ctx.applyMode('home');
}

/* Move to a step. Out of range at either end closes the tutorial (at the top it
   just clamps — walking backwards off step 1 should not quit). */
async function go(i) {
  if (!T) return;
  if (i < 0) return;
  if (i >= T.steps.length) { finish(); return; }
  T.i = i; T.met = false; T.done = false;
  const s = T.steps[i];
  // Let the click that brought us here finish propagating first. The bay drop-downs close
  // themselves on any document click, so a `before` that opens one during the same dispatch
  // gets shut again the moment the event reaches the document.
  if (s.before) {
    await new Promise((r) => setTimeout(r, 0));
    try { await s.before(); } catch (err) { /* a setup step that cannot run is not fatal */ }
  }
  // A goal already satisfied when the step opens is not a goal — it would tick
  // green before the learner did anything. Steps that can start satisfied say so
  // with `armed`, which snapshots the starting value and asks for a change.
  if (s.goal && s.goal.arm) { try { T.armVal = s.goal.arm(); } catch (err) { T.armVal = null; } }
  render();
  paint();
  scrollTargetIntoView(s);
  // Some targets need a beat before they have a rect — a drawer sliding open, a table being
  // re-rendered. Re-measure a couple of times rather than declaring the step target-less.
  const mine = T.i;
  [260, 700].forEach((d) => setTimeout(() => { if (T && T.i === mine) paint(); }, d));
}

function finish() {
  T.done = true;                     // stop the poll repainting the last step's ring over this
  const card = $('tutCard');
  card.innerHTML = '<div class="tut-hd"><span class="tut-n">DONE</span>'
    + '<button class="tut-x" id="tutExitEnd">Close</button></div>'
    + '<div class="tut-t">That is the whole workflow</div>'
    + '<div class="tut-p">You have been through every control this mode offers. Nothing is '
    + 'locked off now — go back through it at your own pace, and change one thing at a time so '
    + 'you can see what each control actually does to the image.</div>';
  $('tutExitEnd').addEventListener('click', endTutorial);
  hideMask();
  card.style.left = '50%'; card.style.top = '50%';
  card.style.transform = 'translate(-50%,-50%)';
}

/* ---- the dim mask + ring -------------------------------------------------
   Four panels around the target, so the target itself is covered by nothing and
   stays fully interactive. The panels absorb clicks (that is the "isolate" part)
   unless the step opts out with block:false — some steps, like dragging a scan
   box across a scout, need the whole region live. */
function paint() {
  if (!T || T.done) return;
  const s = T.steps[T.i]; if (!s) return;
  // A popup opened by this step takes over as the lit region: that is where the goal is met.
  const modal = openModal();
  const el = modal ? [modal] : target(s);
  const r = el && unionRect(el);
  if (!r || (!r.width && !r.height)) {
    // The control does not exist yet — almost always because an earlier goal was skipped
    // (no scouts, so no scan-group table). Say which, rather than leaving a blank ring.
    hideMask(); placeCard(null); showPending(s); return;
  }
  clearPending();
  const box = { l: r.left - PAD, t: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 };
  const W = innerWidth, H = innerHeight;
  const px = (n) => Math.max(0, n) + 'px';
  const set = (id, l, t, w, h) => {
    const d = $(id);
    d.style.display = 'block';
    d.style.left = px(l); d.style.top = px(t); d.style.width = px(w); d.style.height = px(h);
    d.style.pointerEvents = (s.block === false) ? 'none' : 'auto';
  };
  set('tutMaskT', 0, 0, W, box.t);
  set('tutMaskB', 0, box.t + box.h, W, H - box.t - box.h);
  set('tutMaskL', 0, box.t, box.l, box.h);
  set('tutMaskR', box.l + box.w, box.t, W - box.l - box.w, box.h);
  const ring = $('tutRing');
  ring.style.display = 'block';
  ring.style.left = px(box.l); ring.style.top = px(box.t);
  ring.style.width = px(box.w); ring.style.height = px(box.h);
  placeCard(box);
}

function showPending(s) {
  const card = $('tutCard');
  if (card.querySelector('.tut-pending')) return;
  const note = document.createElement('div');
  note.className = 'tut-goal read tut-pending';
  note.innerHTML = '<span class="tut-tick">!</span><span>'
    + (s.needs || 'This control is not on screen yet — go back and complete the earlier step that brings it up.')
    + '</span>';
  card.insertBefore(note, card.querySelector('.tut-nav'));
}

function clearPending() {
  const n = $('tutCard').querySelector('.tut-pending');
  if (n) n.remove();
}

function hideMask() {
  ['tutMaskT', 'tutMaskB', 'tutMaskL', 'tutMaskR', 'tutRing'].forEach((id) => {
    const d = $(id); if (d) d.style.display = 'none';
  });
}

/* A step can name one selector or several; several are lit as one region, which is how the
   stepper buttons stay reachable alongside the slider they belong to. */
function target(s) {
  if (!s.sel) return null;
  const sels = Array.isArray(s.sel) ? s.sel : [s.sel];
  const els = [];
  for (const q of sels) {
    try { const e = document.querySelector(q); if (e) els.push(e); } catch (err) { /* bad selector */ }
  }
  return els.length ? els : null;
}

function unionRect(els) {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const e of els) {
    const q = e.getBoundingClientRect();
    if (!q.width && !q.height) continue;
    l = Math.min(l, q.left); t = Math.min(t, q.top);
    r = Math.max(r, q.right); b = Math.max(b, q.bottom);
  }
  if (l === Infinity) return null;
  return { left: l, top: t, width: r - l, height: b - t };
}

/* Popups the app opens on top of everything — the protocol chooser, the value/station entry,
   the injector keypad, the bolus-tracking window. Several goals can only be met INSIDE one of
   these, so while one is open it becomes the lit region: the mask reshapes around it instead
   of around the control that opened it, and the dimming carries on doing its job. */
const MODALS = [
  ['#protoPop.show', '.protopop-card'],
  ['#ctPop.show', '.ctpop-inner'],
  ['#kpad.open', '.kpad-win'],
  ['#ctBtrk.show', null],
];

function openModal() {
  for (const [host, inner] of MODALS) {
    const h = document.querySelector(host);
    if (!h) continue;
    const el = inner ? h.querySelector(inner) : h;
    if (!el) continue;
    const q = el.getBoundingClientRect();
    if (q.width && q.height) return el;
  }
  return null;
}

/* The blurb sits beside the control it describes, not in a fixed corner: read
   the text, look 2 cm left, there is the thing it is talking about. Preference
   is left/right first because the settings columns are tall and narrow. */
function placeCard(box) {
  const card = $('tutCard');
  card.style.transform = '';
  const W = innerWidth, H = innerHeight, M = 12, WIDE = 340, MIN = 250;
  card.style.width = WIDE + 'px';
  if (!box) {
    card.style.left = px(W - WIDE - 24); card.style.top = px(H - card.offsetHeight - 24); return;
  }
  // Never sit on top of the lit region — that region is what the learner has to use, and a
  // wide popup (the protocol chooser is 680px) would otherwise be half-covered by the blurb.
  // Shrink the card to whatever margin is left before giving up and overlaying.
  const gapL = box.l - M * 2, gapR = W - (box.l + box.w) - M * 2;
  const gap = Math.max(gapL, gapR);
  let cw = WIDE;
  if (gap < WIDE && gap >= MIN) { cw = Math.floor(gap); card.style.width = cw + 'px'; }
  const ch = card.offsetHeight || 200;
  let l, t;
  if (gapL >= cw) l = box.l - M - cw;                               // left of it
  else if (gapR >= cw) l = box.l + box.w + M;                       // right of it
  else {                                                            // no room either side
    l = Math.min(Math.max(M, box.l + box.w / 2 - cw / 2), W - cw - M);
    t = (box.t - M - ch >= M) ? box.t - M - ch                      // above
      : (box.t + box.h + M + ch <= H - M) ? box.t + box.h + M       // below
      : H - ch - M;                                                 // last resort: bottom edge
    card.style.left = px(l); card.style.top = px(Math.max(M, t));
    return;
  }
  t = box.t + box.h / 2 - ch / 2;                                   // vertically centred on it
  card.style.left = px(Math.min(Math.max(M, l), W - cw - M));
  card.style.top = px(Math.min(Math.max(M, t), H - ch - M));
  function px(n) { return Math.round(n) + 'px'; }
}

function scrollTargetIntoView(s) {
  const els = target(s);
  if (!els) return;
  const el = els[0];
  // On the mobile pager the target may live on another PAGE entirely — bring that page to
  // the front first (no-op on desktop). The step's first paint ran before this and saw a
  // hidden target (zero rect), so a repaint is owed whether or not a scroll follows.
  const hadNoRect = !el.getBoundingClientRect().width;
  window.__mobilePageFor?.(el);
  if (hadNoRect) setTimeout(paint, 60);
  const r = el.getBoundingClientRect();
  if (r.top >= 0 && r.bottom <= innerHeight) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(paint, 380);
}

/* ---- the card ---------------------------------------------------------- */
/* A goal is only offered when it can actually be met. Some controls are locked by the state
   the app happens to be in — the injector protocol is fixed when the timeline is the shipped
   preset rather than a live solve — and asking for a change that the UI will not accept is
   worse than asking for nothing. `when` decides; `unless` says why not. */
function goalLive(s) {
  if (!s.goal) return false;
  if (!s.goal.when) return true;
  try { return !!s.goal.when(); } catch (err) { return false; }
}

function render() {
  const s = T.steps[T.i];
  const card = $('tutCard');
  T.live = goalLive(s);
  const goal = T.live
    ? '<div class="tut-goal" id="tutGoal"><span class="tut-tick">○</span><span>' + s.goal.label + '</span></div>'
    : '<div class="tut-goal read"><span class="tut-tick">·</span><span>'
      + (s.goal ? s.goal.unless : 'Nothing to change here — read on when ready.') + '</span></div>';
  card.innerHTML =
    '<div class="tut-hd"><span class="tut-n">' + (T.i + 1) + ' / ' + T.steps.length + '</span>'
    + '<button class="tut-x" id="tutExit2">Exit</button></div>'
    + '<div class="tut-t">' + s.title + '</div>'
    + '<div class="tut-p">' + s.text + '</div>'
    + goal
    + '<div class="tut-nav">'
    + '<button id="tutPrev2"' + (T.i === 0 ? ' disabled' : '') + '>Back</button>'
    + '<button id="tutNext2" class="pri">' + (T.i === T.steps.length - 1 ? 'Finish' : 'Next') + '</button>'
    + '</div>';
  $('tutExit2').addEventListener('click', endTutorial);
  $('tutPrev2').addEventListener('click', () => go(T.i - 1));
  $('tutNext2').addEventListener('click', () => go(T.i + 1));
  card.style.display = 'block';
}

/* Poll rather than listen: the goals watch application state (a value changed, a
   scan stored, a mode reached), and state here is mutated from a dozen places
   that do not all emit events. A 220 ms poll is cheap and never misses. */
function tick() {
  if (!T) return;
  paint();
  const s = T.steps[T.i]; if (!s || !s.goal || T.met) return;
  // The lock can lift while the step is open — start the compute service and the injector
  // protocol becomes editable — so re-check and redraw the card if the answer changed.
  if (goalLive(s) !== T.live) { render(); return; }
  if (!T.live) return;
  let ok = false;
  try { ok = !!s.goal.done(T.armVal); } catch (err) { ok = false; }
  if (!ok) return;
  T.met = true;
  const g = $('tutGoal');
  if (g) { g.classList.add('met'); g.querySelector('.tut-tick').textContent = '✓'; }
  const n = $('tutNext2');
  if (n) n.classList.add('ready');
}
