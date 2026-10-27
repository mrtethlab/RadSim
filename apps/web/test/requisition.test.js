// Protocol Trainer requisitions: the cases cover the hospital's protocol chart and only name lines
// and pathology that exist, a seed always rebuilds the same form, and the rolled patient is
// consistent (age and DOB, the paediatric ranges, LMP only where it can apply, no unfilled tokens).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOSPITAL, PATHOLOGY_IDS, lineById } from '../src/trainer/hospitalProtocols.js';
import { CASES, caseById } from '../src/trainer/cases.js';
import { makeRequisition, seedRng, ageOn, EXAM_NAMES, DEPT_KEYS } from '../src/trainer/requisition.js';

const TODAY = new Date(2026, 9, 27, 14, 30);
const SETTINGS = new Set(['ED', 'outpatient', 'inpatient', 'fracture clinic']);
// every value a choice can take ('a', ['a', 'b'] or { a: 1, b: 2 })
const values = (c) => (c == null ? [] : typeof c !== 'object' ? [c] : Array.isArray(c) ? c : Object.keys(c));
// every string a case can put on the form
const texts = (c) => [c.question, c.request, c.history].flatMap(values)
  .concat(c.findings ? Object.values(c.findings) : [], (c.pathology || []).map((p) => p.positive).filter(Boolean));
// the adult routine of an exam with a paediatric one must not take the paediatric ages
const PEDS_SIBLING = (line) => HOSPITAL.find((l) => l !== line && l.exam === line.exam && l.peds && /^Paediatric/.test(l.indication));
// many requisitions: every case, with several seeds each
const many = () => CASES.flatMap((c) => Array.from({ length: 25 }, (_, i) =>
  makeRequisition({ rng: seedRng(`${c.id}:${i}`), caseId: c.id, today: TODAY })));

test('every hospital line has at least one case', () => {
  const used = new Set(CASES.flatMap((c) => c.lines));
  for (const l of HOSPITAL) assert.ok(used.has(l.id), `no case for ${l.id}`);
  assert.ok(CASES.length >= 70 && CASES.length <= 95, `${CASES.length} cases`);
  const multi = CASES.filter((c) => c.lines.length > 1).length;
  assert.ok(multi >= 10 && multi <= 15, `${multi} multi-exam cases`);
});

test('every case names lines, pathology, departments and settings that exist', () => {
  const ids = new Set();
  for (const c of CASES) {
    assert.ok(!ids.has(c.id), `duplicate case ${c.id}`); ids.add(c.id);
    assert.ok(c.lines.length >= 1 && c.lines.length <= 3, `${c.id}: ${c.lines.length} lines`);
    assert.equal(new Set(c.lines).size, c.lines.length, `${c.id}: a line twice`);
    for (const id of c.lines) {
      assert.ok(lineById(id), `${c.id}: no line ${id}`);
      assert.ok(EXAM_NAMES[lineById(id).exam], `${c.id}: no exam name for ${lineById(id).exam}`);
    }
    assert.ok(c.age[0] >= 0 && c.age[0] <= c.age[1], `${c.id}: age ${c.age}`);
    for (const s of values(c.setting)) assert.ok(SETTINGS.has(s), `${c.id}: setting ${s}`);
    const refs = typeof c.referrer === 'object' && !Array.isArray(c.referrer)
      ? Object.entries(c.referrer).flatMap(([s, v]) => { assert.ok(SETTINGS.has(s), `${c.id}: referrer keyed by ${s}`); return values(v); })
      : values(c.referrer);
    for (const r of refs) assert.ok(DEPT_KEYS.includes(r), `${c.id}: department ${r}`);
    for (const p of values(c.priority)) assert.ok(['Routine', 'Urgent', 'STAT'].includes(p), `${c.id}: priority ${p}`);
    let sum = 0;
    for (const p of c.pathology || []) {
      assert.ok(p.id in PATHOLOGY_IDS, `${c.id}: no pathology ${p.id}`);
      assert.ok(p.p > 0 && p.p <= 1, `${c.id}: p ${p.p}`);
      if (p.line) assert.ok(c.lines.includes(p.line), `${c.id}: pathology on ${p.line}, not one of its exams`);
      assert.ok(p.positive || c.findings?.positive, `${c.id}: no positive findings for ${p.id}`);
      sum += p.p;
    }
    assert.ok(sum <= 1 + 1e-9, `${c.id}: pathology chances sum to ${sum}`);
    if (sum < 1) assert.ok(c.findings?.negative, `${c.id}: no negative findings`);
    assert.ok(values(c.question).length && values(c.history).length, `${c.id}: question and history`);
  }
});

test('case text has no gendered pronouns', () => {
  const pronoun = /\b(he|she|his|her|hers|him|himself|herself)\b/i;
  for (const c of CASES) for (const t of texts(c)) assert.ok(!pronoun.test(t), `${c.id}: "${t.match(pronoun)?.[0]}" in ${t}`);
});

test('the same seed gives the same requisition; another seed another', () => {
  for (const seed of [1, 42, 'trainer', 2 ** 31 + 7]) {
    const a = makeRequisition({ rng: seedRng(seed), today: TODAY });
    const b = makeRequisition({ rng: seedRng(seed), today: TODAY });
    assert.deepEqual(a, b);
    assert.equal(a.seed, seed);
    assert.deepEqual(makeRequisition({ seed, today: TODAY }), a);   // the seed alone rebuilds it
  }
  const a = makeRequisition({ seed: 1, caseId: 'hand-boxer', today: TODAY });
  const b = makeRequisition({ seed: 2, caseId: 'hand-boxer', today: TODAY });
  assert.notDeepEqual(a.patient, b.patient);
});

test('paediatric routines take paediatric ages, and adult routines of the same exam do not', () => {
  for (const c of CASES) for (const id of c.lines) {
    const L = lineById(id);
    if (L.peds) assert.ok(c.age[0] >= L.peds[0] && c.age[1] <= L.peds[1], `${c.id}: ages ${c.age} outside ${id} ${L.peds}`);
    const sib = PEDS_SIBLING(L);
    if (!L.peds && sib) assert.ok(c.age[0] > sib.peds[1] || c.age[1] < sib.peds[0],
      `${c.id}: ages ${c.age} belong to ${sib.id} ${sib.peds}`);
  }
  for (const r of many()) {
    const c = caseById(r.caseId);
    assert.ok(r.patient.age >= c.age[0] && r.patient.age <= c.age[1], `${r.caseId}: age ${r.patient.age}`);
  }
});

test('the patient is consistent: DOB and age, LMP only for females 12-55, sides on sided exams', () => {
  for (const r of many()) {
    const p = r.patient;
    const [y, m, d] = p.dob.split('-').map(Number);
    assert.equal(ageOn(new Date(y, m - 1, d), TODAY), p.age, `${r.caseId}: DOB ${p.dob} is not age ${p.age}`);
    if (p.sex === 'F' && p.age >= 12 && p.age <= 55) {
      assert.ok(p.pregnancy?.status, `${r.caseId}: no pregnancy status for a ${p.age} y female`);
      if (p.pregnancy.lmp) assert.ok(p.pregnancy.lmp <= r.encounter.ordered.slice(0, 10), `${r.caseId}: LMP after the order`);
    } else assert.equal(p.pregnancy, null, `${r.caseId}: pregnancy for a ${p.age} y ${p.sex}`);
    assert.match(p.phone, /^\(\d{3}\) 555-01\d\d$/);
    assert.match(p.healthCard, /^WHC-\d{4}-\d{3}-\d{3}-[XYZ]{2}$/);
    assert.ok(p.weightKg > 5 && p.weightKg < 200 && p.heightCm > 60 && p.heightCm < 210, `${r.caseId}: body ${p.weightKg} kg ${p.heightCm} cm`);
    assert.ok(['ambulatory', 'wheelchair', 'stretcher', 'carried'].includes(p.mobility), `${r.caseId}: mobility ${p.mobility}`);
    assert.equal(r.exams.length, caseById(r.caseId).lines.length);
    for (const e of r.exams) {
      assert.equal(!!e.side, !!lineById(e.line).side, `${r.caseId}: side on ${e.line}`);
      if (e.side) assert.ok(e.name.endsWith(e.side === 'L' ? 'LEFT' : 'RIGHT'), `${r.caseId}: ${e.name}`);
    }
    if (r.pathology) {
      assert.ok(r.exams.some((e) => e.line === r.pathology.line), `${r.caseId}: pathology off the exams`);
      const ex = r.exams.find((e) => e.line === r.pathology.line);
      if (ex.side && r.pathology.side) assert.equal(r.pathology.side, ex.side, `${r.caseId}: pathology side`);
    }
    if (r.encounter.patientClass === 'Inpatient') assert.ok(r.encounter.room && r.encounter.bed);
    if (r.encounter.patientClass === 'Emergency') assert.ok(r.encounter.bed);
    if (r.referrer.cc) assert.notEqual(r.referrer.cc.name, r.referrer.name);
  }
});

test('no token is left unfilled', () => {
  for (const r of many()) {
    for (const [k, t] of Object.entries({ question: r.question, request: r.request, history: r.history, findings: r.findings })) {
      if (t != null) assert.ok(!/[{}]/.test(t), `${r.caseId}: ${k} "${t}"`);
    }
  }
});

test('pathology is rolled at about its chance', () => {
  const n = 400;
  const c = caseById('ankle-inversion');
  let hits = 0;
  for (let i = 0; i < n; i++) if (makeRequisition({ seed: i, caseId: c.id, today: TODAY }).pathology) hits++;
  assert.ok(Math.abs(hits / n - c.pathology[0].p) < 0.08, `${hits}/${n}`);
  for (let i = 0; i < 20; i++) assert.equal(makeRequisition({ seed: i, caseId: 'hand-recheck', today: TODAY }).pathology.id, 'boxerFx');
});
