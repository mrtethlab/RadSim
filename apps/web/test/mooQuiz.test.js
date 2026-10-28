// The Order of Operations quiz marks the routine's ideas, not its exact words, and spaces its cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markConcepts, markList, buildDeck, newState, record, pickCard, askAs, mastery, TIMED_BOX } from '../src/core/mooQuiz.js';
import { MOO, SCENARIOS, flatSteps, stepById } from '../src/trainer/moo.js';

const seeded = (s = 7) => () => ((s = (s * 16807) % 2147483647) / 2147483647);

test('every step marks its own wording right', () => {
  for (const st of flatSteps()) assert.ok(markConcepts(st.text, st.concepts).ok, `${st.id}: ${st.text}`);
});

test('paraphrase and slips pass; a missing idea does not', () => {
  const st = (id) => stepById(id).concepts;
  assert.ok(markConcepts('check the patient history and order, ask for priors if follow up', st('2')).ok);
  assert.ok(markConcepts('verify 2 identifers and LMP', st('6c')).ok);             // one slip
  assert.ok(markConcepts('position once, center once, collimate once', st('8a')).ok);
  assert.ok(!markConcepts('check the order', st('2')).ok);                          // no history
  assert.ok(!markConcepts('confirm two identifiers', st('6c')).ok);                 // no LMP
  assert.ok(!markConcepts('Exposure check', st('10a')).ok);
  assert.ok(!markConcepts('tube to it', st('7')).ok);                               // IR is exact
});

test('lists keep their order', () => {
  const subs = stepById('6').subs;
  const right = subs.map((x) => x.text).join('\n');
  assert.ok(markList(right, subs).ok);
  const swapped = [subs[1], subs[0], ...subs.slice(2)].map((x) => x.text).join('\n');
  assert.ok(!markList(swapped, subs).ok);
  const whole = MOO.map((x) => x.text + '\n' + x.subs.map((y) => y.text).join('\n')).join('\n');
  assert.ok(markList(whole, MOO, true).ok, 'the whole routine with its sub-steps between');
  assert.ok(!markList(MOO.slice(1).map((x) => x.text).join('\n'), MOO, true).ok);
});

test('the deck asks about every step, every situation and the whole routine', () => {
  const deck = buildDeck(), ids = new Set(deck.map((c) => c.id));
  assert.equal(ids.size, deck.length, 'ids unique');
  for (const st of MOO) assert.ok(ids.has(`step:${st.id}`) && ids.has(`num:${st.id}`));
  for (const st of MOO.filter((x) => x.subs.length)) assert.ok(ids.has(`subs:${st.id}`) && ids.has(`order:${st.id}`));
  SCENARIOS.forEach((s, k) => { assert.ok(stepById(s.ans), s.ans); assert.ok(ids.has(`scn:${k}`)); });
  assert.ok(ids.has('full') && ids.has('order:main'));
  for (const c of deck) if (c.mark && c.kind !== 'number') assert.ok(c.mark(c.answer).ok, `${c.id} marks its own answer`);
  for (const c of deck.filter((x) => x.kind === 'number')) assert.ok(c.mark(`step ${c.answer}`).ok && !c.mark('99').ok);
});

test('spacing: right answers climb and wait, wrong ones come straight back', () => {
  const deck = buildDeck(), S = newState(deck), rng = seeded();
  const c = deck.find((x) => x.id === 'step:5');
  assert.ok(askAs(S, c, rng).options?.length === 4, 'multiple choice the first time');
  record(S, c, true); assert.equal(S.cards[c.id].box, 1); assert.equal(S.cards[c.id].due, S.n + 2);
  assert.equal(askAs(S, c, rng).options, null, 'recalled after');
  record(S, c, true); record(S, c, true); assert.ok(S.cards[c.id].due - S.n === 8);
  assert.ok(askAs(S, c, rng).timed > 0 && S.cards[c.id].box >= TIMED_BOX);
  record(S, c, false); assert.equal(S.cards[c.id].box, 0); assert.equal(S.cards[c.id].due, S.n + 2);
  // the whole routine waits for fifteen answers
  const S2 = newState(deck);
  for (let i = 0; i < 14; i++) { const p = pickCard(S2, deck, rng, null); assert.notEqual(p.id, 'full'); record(S2, p, true); }
  // never the same card twice running
  let last = null; for (let i = 0; i < 60; i++) { const p = pickCard(S2, deck, rng, last); assert.notEqual(p.id, last); last = p.id; record(S2, p, i % 3 !== 0); }
  assert.ok(mastery(S2) > 0 && mastery(S2) < 1);
});
