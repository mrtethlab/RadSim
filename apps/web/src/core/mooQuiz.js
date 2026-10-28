/* ============================================================================
   ORDER OF OPERATIONS QUIZ — cards, marking and spacing for a memorised routine.

   MARKING. An answer is right when it names every concept of the step it answers (trainer/moo.js
   concepts: groups of words, any one of which counts). Words are matched forgivingly: a word that
   starts the same way ("collimat" in "collimation"), or is one or two keystrokes off a longer
   word, counts; short words (IR, 3, LMP) must be exact. A missing idea is never forgiven: the
   routine is to become automatic, and "check the order" without the history is a different step.

   CARDS. Every way of asking about the routine is a card: a step by its number, its number by
   its wording, what comes next and before, every sub-step of a step in order, a sub-step's
   successor, a blanked key term, a situation, the order itself (shuffled), and the whole routine
   from memory. Recognition (multiple choice) is offered once, the first time a card is seen;
   after that everything is recalled.

   SPACING (Leitner boxes, counted in questions rather than days, so a single sitting spaces too):
   a right answer moves the card up a box and puts it 2^box questions away; a wrong one sends it
   back to the first box, due again two questions later. Cards in the higher boxes are timed. The
   whole-routine card waits until 15 questions have been asked, then is spaced like the rest.
   ============================================================================ */
import { MOO, SCENARIOS, flatSteps, stepById } from '../trainer/moo.js';

export const norm = (t) => String(t || '').toLowerCase()
  .replace(/[–—]/g, '-').replace(/[^a-z0-9/\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (t) => norm(t).split(/[ \-/]+/).filter(Boolean);

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// one word of an answer against one word of a concept
function wordMatch(tok, w) {
  if (tok === w) return true;
  if (w.length <= 3) return false;                         // IR, 3, LMP, hx: exact only
  if (tok.startsWith(w) || (tok.length >= 5 && w.startsWith(tok))) return true;
  const allow = w.length >= 7 ? 2 : 1;
  return lev(tok, w) <= allow || (tok.length > w.length && lev(tok.slice(0, w.length), w) <= allow - 1);
}
// a concept word or phrase anywhere in the answer (a phrase: its words in a row)
function synMatch(toks, syn) {
  const ws = tokens(syn);
  for (let i = 0; i + ws.length <= toks.length; i++) {
    let ok = true;
    for (let k = 0; k < ws.length && ok; k++) ok = wordMatch(toks[i + k], ws[k]);
    if (ok) return true;
  }
  return false;
}
/* Which concept groups an answer names: { hit: [bool], ok: all named }. */
export function markConcepts(answer, concepts) {
  const toks = tokens(answer);
  const hit = concepts.map((g) => g.some((syn) => synMatch(toks, syn)));
  return { hit, ok: hit.every(Boolean) };
}

const shuffle = (a, rng) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const q = (t) => `“${t}”`;

/* The deck: every card, with how to ask it and how to mark it. */
export function buildDeck() {
  const deck = [], main = MOO, all = flatSteps();
  const missing = (st, m) => st.concepts.filter((_, i) => !m.hit[i]).map((g) => g[0]);
  const conceptCard = (id, prompt, st, extra = {}) => deck.push({ id, kind: 'text', prompt, answer: st.text, step: st,
    mark: (a) => { const m = markConcepts(a, st.concepts); return { ok: m.ok, missing: missing(st, m) }; }, ...extra });
  main.forEach((st, i) => {
    conceptCard(`step:${st.id}`, `What is step ${st.id}?`, st, { mc: main });
    deck.push({ id: `num:${st.id}`, kind: 'number', prompt: `Which step number is ${q(st.text)}?`, answer: st.id,
      mark: (a) => ({ ok: norm(a).replace(/^step /, '') === st.id, missing: [] }) });
    if (i < main.length - 1) conceptCard(`next:${st.id}`, `What comes after step ${st.id}, ${q(st.text)}?`, main[i + 1], { mc: main, from: st });
    if (i > 0) conceptCard(`prev:${st.id}`, `What comes before step ${st.id}, ${q(st.text)}?`, main[i - 1], { mc: main, from: st });
    if (st.subs.length) {
      deck.push({ id: `subs:${st.id}`, kind: 'list', prompt: `List every sub-step of step ${st.id}, ${q(st.text)}, in order (one per line).`,
        answer: st.subs.map((x) => `${x.id}) ${x.text}`).join('\n'), lines: st.subs.length,
        mark: (a) => markList(a, st.subs) });
      st.subs.forEach((sub, k) => {
        if (k < st.subs.length - 1) conceptCard(`subnext:${sub.id}`, `Step ${st.id}, ${q(st.text)}: what comes after ${q(sub.text)}?`, st.subs[k + 1], { mc: st.subs, from: sub });
      });
      deck.push({ id: `order:${st.id}`, kind: 'order', prompt: `Put the sub-steps of step ${st.id}, ${q(st.text)}, in order.`,
        items: st.subs.map((x) => x.text), answer: st.subs.map((x) => x.text).join('\n') });
    }
  });
  for (const st of all) st.blanks.forEach((b, k) => {
    const i = st.text.toLowerCase().indexOf(b.toLowerCase());
    if (i < 0) return;
    const shown = st.text.slice(0, i) + '_____' + st.text.slice(i + b.length);
    deck.push({ id: `cloze:${st.id}:${k}`, kind: 'text', prompt: `Fill in the blank (step ${st.id}): ${shown}`, answer: b,
      mark: (a) => { const need = tokens(b), got = tokens(a);
        const ok = need.length > 0 && need.every((w) => got.some((t) => wordMatch(t, w))) && got.length <= need.length + 3;
        return { ok, missing: ok ? [] : [b] }; } });
  });
  SCENARIOS.forEach((s, k) => {
    const st = stepById(s.ans);
    conceptCard(`scn:${k}`, s.q, st, { answer: `${st.id}) ${st.text}${s.expect ? ` — ${s.expect}` : ''}` });
  });
  deck.push({ id: 'order:main', kind: 'order', prompt: 'Put the eleven steps in order.', items: main.map((x) => x.text),
    answer: main.map((x) => `${x.id}) ${x.text}`).join('\n') });
  deck.push({ id: 'full', kind: 'list', prompt: 'Write the whole routine from memory: every step, in order (one per line; sub-steps may go on their own lines).',
    answer: main.map((x) => `${x.id}) ${x.text}` + x.subs.map((y) => `\n   ${y.id}) ${y.text}`).join('')).join('\n'), lines: 14,
    mark: (a) => markList(a, main, true) });
  return deck;
}

/* A list answer: each expected step named on a line of its own, in order. With `loose`, other
   lines (sub-steps) may come between. */
export function markList(answer, steps, loose = false) {
  const lines = String(answer || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let at = 0;
  const missing = [], found = [];
  for (const st of steps) {
    let k = -1;
    for (let j = at; j < lines.length; j++) { if (markConcepts(lines[j], st.concepts).ok) { k = j; break; } if (!loose && j > at) break; }
    if (k < 0) missing.push(`${st.id}) ${st.text}`); else { found.push(st.id); at = k + 1; }
  }
  return { ok: missing.length === 0, missing, found };
}
/* An ordering answer: the items as the student arranged them. */
export const markOrder = (arranged, items) => ({ ok: arranged.length === items.length && arranged.every((t, i) => t === items[i]), missing: [] });

/* ---------------------------------------------------------------- spacing */
export const TIMED_BOX = 3;
export function newState(deck) {
  const cards = {};
  for (const c of deck) cards[c.id] = { box: 0, due: c.id === 'full' ? 15 : 0, seen: 0, right: 0, wrong: 0 };
  return { n: 0, cards };
}
// cards added to the routine since the state was saved join it, unseen
export function reconcile(state, deck) {
  const fresh = newState(deck);
  for (const id of Object.keys(fresh.cards)) if (!state.cards[id]) state.cards[id] = fresh.cards[id];
  for (const id of Object.keys(state.cards)) if (!fresh.cards[id]) delete state.cards[id];
  return state;
}
/* The next card: due cards first, the lowest box first among them, never the one just asked. */
export function pickCard(state, deck, rng, last = null) {
  const pool = deck.filter((c) => c.id !== last);
  const due = pool.filter((c) => state.cards[c.id].due <= state.n);
  const from = due.length ? due : pool;
  const lo = Math.min(...from.map((c) => state.cards[c.id].box));
  const best = from.filter((c) => state.cards[c.id].box === lo);
  return best[Math.floor(rng() * best.length)];
}
export function record(state, card, ok) {
  const c = state.cards[card.id];
  state.n++; c.seen++;
  if (ok) { c.right++; c.box = Math.min(6, c.box + 1); c.due = state.n + 2 ** c.box; }
  else { c.wrong++; c.box = 0; c.due = state.n + 2; }
  return state;
}
/* How the card is asked this time: multiple choice only the first time, a time limit once learnt. */
export function askAs(state, card, rng) {
  const c = state.cards[card.id];
  const timed = c.box >= TIMED_BOX ? (card.kind === 'list' || card.kind === 'order' ? (card.id === 'full' ? 150 : 45) : 20) : 0;
  let options = null;
  if (card.mc && c.seen === 0) {
    const wrong = shuffle(card.mc.filter((x) => x !== card.step && x !== card.from), rng).slice(0, 3);
    options = shuffle([card.step, ...wrong], rng).map((x) => x.text);
  }
  return { timed, options };
}
/* Mastery, 0-1: how far the cards have climbed (box 4 counts as learnt). */
export const mastery = (state) => {
  const v = Object.values(state.cards);
  return v.reduce((a, c) => a + Math.min(c.box, 4) / 4, 0) / Math.max(1, v.length);
};
export { shuffle };
