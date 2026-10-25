/* ============================================================================
   IV SIMULATION — the procedure engine (src/iv.js is the room that drives it).

   A peripheral IV for contrast, with a closed-system catheter (BD Nexiva Diffusics style):
   prep, tourniquet, palpate and mark a vein, clean, break the seal, line up, anchor, insert,
   catch the flash, lower and advance, thread, withdraw the needle, clamp, uncap, release the
   tourniquet, dress, flush and cap. 21 steps (0-20), in order. Every number lives in
   data/iv.json, so an instructor tunes the procedure without touching code.

   Nothing here knows about pixels or meshes. The room measures where things are on the skin
   (mm, degrees) and calls the actions; the engine keeps the state, the timers, the tip of the
   needle against the vein, the errors and the score.

   THE INSERTION, in the vein's own frame (mm): X along the vein toward the heart, Y across it,
   Z down into the skin. The needle enters the skin at the marked point (0, y0, 0) and points
   along dir(pitch, yaw); its tip moves along that as it advances (s mm of needle are in), and
   the catheter's tip sits bevelToCath behind it. Changing the angle once in pivots about the
   TIP, as dropping the hub does: pivoting about the skin lifted a tip just inside the vein 2-3
   mm straight back out of it. The vein is a tube whose top lies `depth` under the skin, radius r
   (swollen by the tourniquet), whose centre the needle can push down (compression), roll
   sideways and flatten — a spring that rebounds when let go. The front wall gives only when enough of the
   needle's advance goes INTO it (its normal share, sin of the angle it meets the wall at):
   steep pierces, shallow shoves the vein away and, once it can be shoved no further, goes
   through a flattened vein's two walls at once. In the lumen the bevel draws blood into the
   flash chamber; then the angle has to come down before the last 1-2 mm that bring the
   catheter's tip in, and lower still to thread it.

   THE SITE changes the technique, not the steps. A site's `technique` in data/iv.json is laid
   over the procedure's numbers for that attempt (A.P): the back of the hand comes in at 10-15°
   over a thin-walled vein pinned on bone and tendon, rolls further when the skin is let go,
   hurts more, and takes no more than 1.5 mL/s (ACR, for a hand or wrist vein). Its own words
   for the steps and the errors (the tourniquet goes above the wrist) are laid over the same way,
   and every {name} in a step or a tip is filled from the attempt's own numbers.
   ============================================================================ */

export const STEP_IDS = ['prep', 'tourniquet', 'palpate', 'clean', 'seal', 'align', 'anchor', 'insert', 'flash',
  'thread', 'withdraw', 'clamp1', 'portcap', 'tqoff', 'dressing', 'syringe', 'clamp2', 'flush', 'clamp3',
  'syringeOff', 'cap'];

/* Every error: whether the attempt survives it, the score category it costs, how much, and a
   plain-language tip for the debrief. */
export const ERRORS = {
  order: { end: false, cat: 'sequence', pts: 0, msg: 'Step out of order', tip: 'Follow the sequence: each step makes the next one safe.' },
  orderCritical: { end: false, cat: 'sequence', pts: 8, msg: 'Critical step out of order', tip: 'Clamp before you open the system, and before the syringe comes off.' },
  prepSkipped: { end: false, cat: 'sequence', pts: 3, msg: 'Prep item skipped', tip: 'Hygiene, gloves, ID and the order come before anything touches the patient.' },
  tqBelowElbow: { end: false, cat: 'technique', pts: 3, msg: 'Tourniquet below the elbow', tip: 'Put the tourniquet above the elbow, well proximal of the site.' },
  siteOffVein: { end: false, cat: 'insertion', pts: 2, msg: 'Marked off the vein', tip: 'Mark where the rebound is strongest: the vein is under it.' },
  siteValve: { end: false, cat: 'insertion', pts: 3, msg: 'Site over a valve or a junction', tip: 'A valve or a fork stops the catheter: pick a straight segment between them.' },
  siteSmall: { end: false, cat: 'insertion', pts: 3, msg: 'Vein too small for the gauge', tip: 'Choose a vein at least twice the catheter, or a smaller gauge.' },
  siteDeep: { end: false, cat: 'insertion', pts: 3, msg: 'Vein too deep', tip: 'A vein you can barely feel is hard to hit: find a shallower one.' },
  valveAhead: { end: false, cat: 'insertion', pts: 2, msg: 'A valve within the catheter\'s length', tip: 'Feel along the vein for a valve (a small knot): the catheter needs {cathLen} mm clear ahead of the mark.' },
  siteJoint: { end: false, cat: 'insertion', pts: 3, msg: 'The catheter would lie across a joint', tip: 'Keep the catheter off joints: every bend kinks it and works it out of the vein.' },
  siteNerve: { end: false, cat: 'insertion', pts: 3, msg: 'Site over a nerve', tip: 'Avoid the radial side of the wrist: the superficial radial nerve runs with the cephalic vein there.' },
  gaugeLarge: { end: false, cat: 'technique', pts: 2, msg: 'Catheter too large for the site', tip: 'Choose the smallest gauge that does the job: {gauges} G here.' },
  flinch: { end: false, cat: 'insertion', pts: 2, msg: 'The patient flinched', tip: 'Probing hurts, on the back of the hand most: one smooth puncture, the hand held firm.' },
  valveHit: { end: false, cat: 'insertion', pts: 4, msg: 'Catheter stopped at a valve', tip: 'Never force a catheter on against a valve: mark where the vein runs clear for the catheter\'s length.' },
  insertWet: { end: false, cat: 'asepsis', pts: 5, msg: 'Inserted before the site dried', tip: 'Let the prep dry: wet alcohol does not disinfect and it stings.' },
  touchedClean: { end: false, cat: 'asepsis', pts: 4, msg: 'Touched the cleaned site', tip: 'Once the site is clean, do not palpate it again without re-cleaning.' },
  sealOff: { end: false, cat: 'technique', pts: 4, msg: 'Catheter slid off the needle', tip: 'Break the seal with a few millimetres, no more.' },
  acrossVein: { end: true, cat: 'insertion', pts: 15, msg: 'Inserted across the vein', tip: 'A catheter only goes in along the vein: line the needle up with it first.' },
  misaligned: { end: false, cat: 'insertion', pts: 3, msg: 'Inserted out of line with the vein', tip: 'Point the needle along the vein before you go in.' },
  tooShallow: { end: false, cat: 'insertion', pts: 2, msg: 'Too shallow: the vein was pushed away', tip: 'Come in at {pierceMin}-{pierceMax}°: shallower just pushes the vein away.' },
  tooSteep: { end: false, cat: 'insertion', pts: 2, msg: 'Too steep on entry', tip: 'Over {steepOver}° leaves little lumen ahead of the tip.' },
  missed: { end: false, cat: 'insertion', pts: 2, msg: 'Missed the vein', tip: 'Withdraw to just under the skin and redirect along the vein.' },
  notLowered: { end: false, cat: 'insertion', pts: 3, msg: 'Angle not lowered after the flash', tip: 'On flash, drop to {lowerMax}° or under before the last 1-2 mm.' },
  stoppedAtFlash: { end: false, cat: 'insertion', pts: 2, msg: 'Threaded at the first flash', tip: 'At first flash only the bevel is in: advance 1-2 mm so the catheter tip is too.' },
  threadSteep: { end: false, cat: 'insertion', pts: 3, msg: 'Threading at a steep angle', tip: 'Thread at {threadMax}° or less, or the catheter meets the back wall.' },
  tractionEarly: { end: false, cat: 'insertion', pts: 3, msg: 'Traction released before the vein was punctured', tip: 'Keep the skin anchored until the needle is in the vein: that is what stops it rolling.' },
  reinsert: { end: false, cat: 'insertion', pts: 4, msg: 'Needle pushed back into the catheter', tip: 'Never re-advance the needle into a threaded catheter: it can shear it.' },
  backWall: { end: true, cat: 'insertion', pts: 10, msg: 'Through the back wall', tip: 'After the flash, lower the angle before advancing.' },
  sideWall: { end: true, cat: 'insertion', pts: 10, msg: 'Out through the side wall', tip: 'Line the needle up with the vein before inserting.' },
  doubleWall: { end: true, cat: 'insertion', pts: 10, msg: 'Through both walls of a flattened vein', tip: 'Too shallow flattens the vein: enter at {pierceMin}-{pierceMax}°.' },
  arterial: { end: true, cat: 'insertion', pts: 15, msg: 'Arterial puncture', tip: 'A pulsing, bright flash is an artery: feel for the pulse before you mark.' },
  threadOutside: { end: true, cat: 'insertion', pts: 10, msg: 'Threaded with the tip outside the vein', tip: 'Thread only once the catheter tip is in the lumen.' },
  bunched: { end: false, cat: 'insertion', pts: 5, msg: 'Catheter caught on the back wall', tip: 'Thread at {threadMax}° or less, and stop at resistance.' },
  spill: { end: false, cat: 'securement', pts: 4, msg: 'Blood at the open port', tip: 'Close the clamp before the port is opened.' },
  tqWarn: { end: false, cat: 'time', pts: 0, msg: 'Tourniquet on over a minute', tip: '' },
  tqOver: { end: false, cat: 'time', pts: 5, msg: 'Tourniquet on too long', tip: 'Release the tourniquet within two minutes.' },
  tqLeft: { end: false, cat: 'time', pts: 5, msg: 'Tourniquet still on at the flush', tip: 'Release the tourniquet before you flush.' },
  dressingPoor: { end: false, cat: 'securement', pts: 4, msg: 'Dressing does not cover the site and the wings', tip: 'The film goes over the insertion site and the catheter\'s wings.' },
  syringeDirty: { end: false, cat: 'asepsis', pts: 4, msg: 'Syringe tip contaminated', tip: 'Keep the syringe tip off every surface but the port.' },
  capDirty: { end: false, cat: 'asepsis', pts: 4, msg: 'Cap contaminated', tip: 'Keep the cap off every surface but the port.' },
  flushClosed: { end: false, cat: 'securement', pts: 2, msg: 'Flushed against a closed clamp', tip: 'Open the clamp before you flush.' },
  flushFast: { end: false, cat: 'securement', pts: 2, msg: 'Flushed faster than the line is rated for', tip: 'Keep the push under {rate} mL/s: the rate printed on the port for its gauge, or the vein\'s own limit where it is lower.' },
  flushSlow: { end: false, cat: 'securement', pts: 2, msg: 'Flushed too slowly', tip: 'Push steadily, at least {minRate} mL a second.' },
  noBloodCheck: { end: false, cat: 'securement', pts: 3, msg: 'Flushed without checking for blood return', tip: 'Pull back on the syringe first: blood in it confirms the catheter is in the vein.' },
  sharpsLeft: { end: false, cat: 'sequence', pts: 4, msg: 'Needle not put in the sharps container', tip: 'The needle goes straight into the sharps container once it is out.' },
  infiltration: { end: true, cat: 'securement', pts: 10, msg: 'Infiltration', tip: 'Swelling or blanching at the tip: stop. The catheter is out of the vein, or the vein is leaking round it: push no faster than it takes.' },
  disconnectOpen: { end: false, cat: 'securement', pts: 4, msg: 'Syringe off with the clamp open', tip: 'Close the clamp before you disconnect.' },
  portOpen: { end: false, cat: 'securement', pts: 5, msg: 'Port left uncapped', tip: 'Cap the port with a sterile Luer-lock cap.' },
};

// steps whose order matters most (design doc: clamp before cap, clamp before disconnect, tourniquet release)
const CRITICAL = new Set(['clamp1', 'clamp3', 'tqoff']);

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const D = Math.PI / 180;

// the site's technique laid over the procedure: objects merged key by key, anything else replaced
const over = (a, b) => {
  if (!b || typeof b !== 'object' || Array.isArray(b) || !a || typeof a !== 'object') return b === undefined ? a : b;
  const o = { ...a };
  for (const k of Object.keys(b)) if (k[0] !== '_') o[k] = over(a[k], b[k]);
  return o;
};
export function createAttempt(cfg, opts = {}) {
  const site = typeof opts.site === 'string' ? opts.site : 'antecubital', S = cfg.sites?.[site] || {};
  const P = over(cfg.procedure, S.technique);
  return {
    cfg, P, S, mode: opts.mode || 'guided', site, gauge: String(opts.gauge || 20),
    number: opts.number || 1,
    t: 0, step: 0, done: new Set(), log: [], errors: [], flags: [], ended: null, finished: false,
    prep: new Set(),
    tq: { on: false, at: null, total: 0, fill: 0, warned: false, over: false, placedOk: true },
    mark: null,
    clean: { cells: null, coverage: 0, scrub: 0, dryFrom: null, dry: false, dirtied: false },
    kit: { slide: 0, broken: false, off: false },
    needle: { yaw: 25, pitch: 30, s: 0, tip: [0, 0, 0], inSkin: false, withdrawn: 0, shielded: false,
      pitchAtPuncture: null, yawAtEntry: null },
    vein: { dy: 0, dz: 0, flat: 0, pushing: false },
    pierce: { indent: 0, front: false, sPierce: null, back: false, side: false, artery: false, sAtFlash: null, flashAt: null,
      lowered: null, advancedAfterFlash: 0 },
    tip: 'outside', cathTip: 'outside',
    flash: { level: 0, lumenFor: 0, artery: false },
    cath: { thread: 0, hubbed: false, resist: 0, bunched: false, inVein: false },
    line: { blood: 0 },
    traction: false, everTraction: false,
    clampOpen: true, portOpen: false,
    dressing: { placed: false, ok: false, edges: [false, false, false, false] },
    syringe: { on: false, twist: 0, locked: false, dirty: false, vol: 0, lastT: 0, drawn: 0, blood: 0, checked: false, rate: 0, pushT: 0 },
    cap: { on: false, twist: 0, locked: false, dirty: false },
    spill: 0, hematoma: 0, infiltration: 0, pain: 0, flinched: false,
    pressure: { removed: false, gauze: false, held: 0, done: false },
    trace: [],
  };
}

/* ---- the site's limits and words ---------------------------------------------------------- */
// the fastest a push may go through this line: the catheter's rating, or the vein's own limit
// where that is lower (a hand vein: what CT power injection there may run at, too)
export const rateLimit = (A) => Math.min(A.P.gauges[A.gauge].rateMLs, A.P.flush.veinMaxMLs ?? Infinity);
// {name} in a step's or a tip's words, from this attempt's numbers
export function fill(A, s) {
  if (!s || !s.includes('{')) return s;
  const v = { ...A.P.angles, rate: rateLimit(A), minRate: A.P.flush.minRateMLs, cathLen: A.P.needle.cathLenMM,
    gauges: (A.S.gauges || Object.keys(A.P.gauges)).join(' or ') };
  return s.replace(/\{(\w+)\}/g, (m, k) => (v[k] ?? m));
}
// an error as this site words it
export function errorText(A, code) {
  const e = { ...ERRORS[code], ...(A.S.errors?.[code] || {}) };
  return { ...e, msg: fill(A, e.msg), tip: fill(A, e.tip) };
}
// a step as this site words it: { id, title, do, keys }
export function stepText(A, i) {
  const s = A.cfg.steps[i];
  if (!s) return { title: 'Done', do: '', keys: [] };
  const o = { ...s, ...(A.S.steps?.[s.id] || {}) };
  return { ...o, do: fill(A, o.do) };
}

/* ---- the log, errors and step order ----------------------------------------------------- */
function log(A, type, extra = {}) { A.log.push({ t: A.t, step: STEP_IDS[A.step], type, ...extra }); }
export function addError(A, code, extra = {}) {
  if (!ERRORS[code]) return;
  const e = errorText(A, code);
  // a standing condition is logged once
  if (!extra.repeat && A.errors.some((x) => x.code === code)) return;
  A.errors.push({ t: A.t, code, step: STEP_IDS[A.step], ...e });
  log(A, 'error', { code });
  if (e.end && !A.ended) { A.ended = { code, t: A.t }; log(A, 'attemptEnding', { code }); }
}
export const stepIndex = (id) => STEP_IDS.indexOf(id);
export const currentStep = (A) => STEP_IDS[A.step];

/* May this step be done now? Guided blocks anything ahead of the current step (with why);
   Practice allows it and flags it live; Assessment logs it silently. Steps already done may be
   repeated (re-cleaning, re-palpating) without complaint. */
export function gate(A, id) {
  if (A.finished) return { ok: false, why: 'The attempt is over.' };
  if (A.ended && !['withdraw'].includes(id)) return { ok: false, why: 'Remove the catheter and hold pressure.' };
  const k = stepIndex(id);
  if (k <= A.step || A.done.has(id)) return { ok: true };
  // (lining up is its own error when skipped — 'misaligned' — so only Guided waits for it)
  const missing = STEP_IDS.slice(0, k).filter((s) => !A.done.has(s) && (s !== 'align' || A.mode === 'guided')
    && !(s === 'portcap' && k < stepIndex('syringe')));
  if (!missing.length) return { ok: true };
  if (A.mode === 'guided') return { ok: false, why: `First: ${A.cfg.steps[stepIndex(missing[0])].title.toLowerCase()}.` };
  const critical = missing.some((s) => CRITICAL.has(s)) || CRITICAL.has(id);
  addError(A, critical ? 'orderCritical' : 'order', { repeat: true, skipped: missing[0], did: id });
  if (A.mode === 'practice') A.flags.push({ t: A.t, msg: `Out of order: ${A.cfg.steps[k].title}` });
  return { ok: true, flagged: true };
}
export function complete(A, id) {
  if (A.done.has(id)) return;
  A.done.add(id);
  log(A, 'stepDone', { id });
  // the current step is the first not yet done
  while (A.step < STEP_IDS.length && A.done.has(STEP_IDS[A.step])) A.step++;
  if (A.step >= STEP_IDS.length) finish(A);
}

/* ---- 0 prep ----------------------------------------------------------------------------- */
export function tickPrep(A, item) {
  if (!gate(A, 'prep').ok) return false;
  A.prep.add(item);
  if (A.P.prep.every((p) => A.prep.has(p))) complete(A, 'prep');
  return true;
}

/* ---- 1 / 13 tourniquet ------------------------------------------------------------------ */
export function applyTourniquet(A, aboveElbow = true) {
  const g = gate(A, 'tourniquet'); if (!g.ok) return g;
  if (A.step === 1 && !A.done.has('prep')) addError(A, 'prepSkipped');
  A.tq.on = true; A.tq.at = A.t; A.tq.placedOk = aboveElbow;
  if (!aboveElbow) addError(A, 'tqBelowElbow');
  log(A, 'tourniquetOn');
  complete(A, 'tourniquet');
  return { ok: true };
}
export function releaseTourniquet(A) {
  if (!A.tq.on) return { ok: false };
  const g = gate(A, 'tqoff'); if (!g.ok) return g;
  A.tq.total += A.t - A.tq.at; A.tq.on = false; A.tq.at = null;
  log(A, 'tourniquetOff');
  complete(A, 'tqoff');
  return { ok: true };
}
export const tourniquetTime = (A) => A.tq.total + (A.tq.on ? A.t - A.tq.at : 0);

/* ---- 2 palpate and mark ------------------------------------------------------------------
   The room finds what is under the fingertip (distance across each vein or distractor, mm) and
   asks how strongly each is felt: radius over depth, swollen by the tourniquet, falling off with
   distance. Returned cues: { kind: vein|artery|tendon|valve, strength 0-1 }. */
export function palpationCues(A, near) {
  const fill = A.tq.fill, out = [];
  for (const f of near) {
    const r = f.radius * (f.kind === 'vein' ? 1 + A.P.vein.tqSwell * fill : 1);
    const reach = r + 1.5;
    const fall = Math.exp(-((f.dist / reach) ** 2));
    let s = 0.7 * (r / 2) * (3 / Math.max(1.5, f.depth)) * fall;
    if (f.kind === 'vein') s *= 0.35 + 0.65 * fill;
    if (f.kind === 'artery') s *= 0.9;
    if (f.kind === 'tendon') s *= 1.2;
    if (s > 0.18) out.push({ kind: f.kind, id: f.id, strength: clamp(s, 0, 1) });
    if (f.kind === 'vein' && f.valveDist != null && f.valveDist < 3.5 && fall > 0.3) out.push({ kind: 'valve', id: f.id, strength: 0.5 * fall });
  }
  return out;
}
/* The site: { veinId, lateral (mm, from the vein's centre), radius, depth, atValve, atJoin,
   roll, fragility } and, where the room has measured them along the vein toward the heart,
   valveAheadMM (to the next valve) and jointMM (to the first joint the catheter would cross; 0
   on one), and nerve (over one) — or null when the click is on no vein. Marking again replaces it. */
export function markSite(A, site) {
  const g = gate(A, 'palpate'); if (!g.ok) return g;
  if (A.done.has('clean')) addError(A, 'touchedClean');
  if (!site) { addError(A, 'siteOffVein', { repeat: true }); A.mark = null; return { ok: false, why: 'No vein under the mark.' }; }
  const gauge = A.P.gauges[A.gauge], len = A.P.needle.cathLenMM;
  const reasons = [];
  if (Math.abs(site.lateral) > site.radius + 1.0) reasons.push('siteOffVein');
  if (site.atValve || site.atJoin) reasons.push('siteValve');
  // the catheter runs on its whole length up the vein: a valve there stops it, a joint bends it
  else if (site.valveAheadMM != null && site.valveAheadMM < len) reasons.push('valveAhead');
  if (site.jointMM != null && site.jointMM < len) reasons.push('siteJoint');
  if (site.nerve) reasons.push('siteNerve');
  if (A.S.gauges && !A.S.gauges.includes(A.gauge)) reasons.push('gaugeLarge');
  if (2 * site.radius < gauge.minVeinMM) reasons.push('siteSmall');
  if (site.depth > A.P.maxDepthMM) reasons.push('siteDeep');
  A.mark = { ...site, reasons };
  log(A, 'marked', { vein: site.veinId, lateral: +site.lateral.toFixed(1), reasons });
  for (const r of reasons) addError(A, r);
  // a fresh mark undoes the cleaning: the new site has not been prepped
  if (A.done.has('clean')) { A.done.delete('clean'); A.clean = { cells: null, coverage: 0, scrub: 0, dryFrom: null, dry: false, dirtied: false }; A.step = Math.min(A.step, stepIndex('clean')); }
  complete(A, 'palpate');
  return { ok: true, reasons };
}

/* ---- 3 clean ------------------------------------------------------------------------------
   The room paints the pad's strokes into a grid around the mark (mm) and passes the share of
   the target circle covered and the seconds spent scrubbing in it. */
export function cleanStroke(A, coverage, scrubS) {
  const g = gate(A, 'clean'); if (!g.ok) return g;
  if (!A.mark) return { ok: false, why: 'Mark a site first.' };
  A.clean.coverage = Math.max(A.clean.coverage, coverage);
  A.clean.scrub += scrubS;
  A.clean.dry = false; A.clean.dryFrom = null; A.clean.dirtied = false;
  if (A.clean.coverage >= A.P.clean.coverage && A.clean.scrub >= A.P.clean.scrubS) A.clean.dryFrom = A.t;
  return { ok: true };
}
export function touchCleaned(A) {
  if (!A.done.has('clean') && !A.clean.dryFrom) return;
  addError(A, 'touchedClean');
  A.clean.dirtied = true; A.clean.coverage = Math.min(A.clean.coverage, A.P.clean.coverage - 0.05);
  A.clean.dryFrom = null; A.clean.dry = false;
  if (A.done.has('clean') && !A.needle.inSkin) { A.done.delete('clean'); A.step = Math.min(A.step, stepIndex('clean')); }
}

/* ---- 4 seal ------------------------------------------------------------------------------ */
export function sealSlide(A, mm) {
  const g = gate(A, 'seal'); if (!g.ok) return g;
  A.kit.slide = clamp(mm, 0, 20);
  if (A.kit.slide > A.P.seal.offMM && !A.kit.off) { A.kit.off = true; addError(A, 'sealOff'); log(A, 'kitOff'); }
  return { ok: true };
}
// back on the needle: the seal is broken if the catheter went far enough off it (`peak`, mm; the
// slide as it stands if not given) and not so far it came off
export function sealRelease(A, peak) {
  const s = peak ?? A.kit.slide; A.kit.slide = 0;
  if (A.kit.off) return { ok: false, why: 'The catheter came off: take a new kit.' };
  if (s >= A.P.seal.breakMinMM && s < A.P.seal.offMM) { A.kit.broken = true; complete(A, 'seal'); return { ok: true }; }
  return { ok: false, why: s < A.P.seal.breakMinMM ? 'Slide it a little further.' : '' };
}
export function replaceKit(A) {
  A.kit = { slide: 0, broken: false, off: false };
  A.done.delete('seal'); A.step = Math.min(A.step, stepIndex('seal'));
  log(A, 'kitReplaced');
}

/* ---- 5-10 the insertion -------------------------------------------------------------------- */
const veinR = (A) => A.mark.radius * (1 + A.P.vein.tqSwell * A.tq.fill);
// how far this vein rolls: its own looseness, and the site's (a hand vein on bone and tendon
// under thin, loose skin slides further than one in the fat of the forearm)
const rollOf = (A) => (A.mark.roll || 1) * (A.P.vein.mobility ?? 1);
/* What the needle costs the patient. The skin is felt once; every millimetre drawn back or swept
   sideways in the tissue (probing for the vein) is felt again — on the back of the hand, thin
   skin over tendon and bone, about three times as much. Past the threshold the patient flinches
   the limb away: a hand held firm (traction) stays put, a loose one takes the vein with it. */
function hurt(A, x) {
  const p = A.P.pain;
  if (!p || x <= 0) return;
  A.pain += x;
  if (A.pain < p.flinchAt || A.flinched) return;
  A.flinched = true;
  addError(A, 'flinch');
  const limb = A.S.subject === 'hand' ? 'hand' : 'arm';
  if (A.mode !== 'assessment') A.flags.push({ t: A.t, msg: A.traction ? `Ouch: the patient flinched. The ${limb} was held.` : `Ouch: the patient pulled the ${limb} away.` });
  if (!A.traction && !A.pierce.front) A.vein.dy = clamp(A.vein.dy + p.flinchMM * rollOf(A) * Math.sign(A.mark.lateral || 1), -A.P.vein.maxRollMM, A.P.vein.maxRollMM);
  log(A, 'flinch', { pain: +A.pain.toFixed(2) });
}
export const needleDir = (A) => {
  const p = A.needle.pitch * D, y = A.needle.yaw * D;
  return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p)];
};
// the needle's tip, or a point `back` mm behind it along the shaft
function tipPos(A, back = 0) {
  const t = A.needle.inSkin ? A.needle.tip : [0, A.mark ? A.mark.lateral : 0, 0], d = needleDir(A);
  return [t[0] - back * d[0], t[1] - back * d[1], t[2] - back * d[2]];
}
// the vein's centre depth: its top lies `depth` under the skin
export const veinCentreZ = (A) => A.mark.depth + A.P.vein.wallMM + veinR(A) + A.vein.dz;
export const needleTip = (A) => tipPos(A);
export const catheterTip = (A) => (A.cath.thread > 0 ? cathAdvanced(A) : tipPos(A, A.P.needle.bevelToCathMM));
// once threading starts the catheter leaves the needle and runs on in the lumen, along the vein
function cathAdvanced(A) {
  const base = tipPos(A, A.P.needle.bevelToCathMM), extra = A.cath.thread;
  if (A.cathTip === 'lumen' || A.cath.inVein) return [base[0] + extra, base[1], base[2]];
  const d = needleDir(A);
  return [base[0] + extra * d[0], base[1] + extra * d[1], base[2] + extra * d[2]];
}
/* Where a point is against the vein: outside, in the wall, in the lumen, or beyond the far wall
   (through). The vein's centre moves with its displacement; its lumen flattens. */
export function whereIs(A, q, opt = {}) {
  const r = veinR(A), w = A.P.vein.wallMM, a = r, b = r * (1 - A.vein.flat);
  const cy = A.vein.dy, cz = veinCentreZ(A);
  const ry = q[1] - cy, rz = q[2] - cz;
  const inner = (ry / a) ** 2 + (rz / Math.max(0.15, b)) ** 2;
  const outer = (ry / (a + w)) ** 2 + (rz / (b + w)) ** 2;
  if (inner <= 1) return 'lumen';
  if (outer <= 1) return 'wall';
  if (opt.passed && q[2] > cz) return 'through';
  return 'outside';
}
function arteryAt(A, q) {
  const art = A.mark.artery;               // the room passes the nearest artery, if any, in the vein frame
  if (!art) return false;
  return (q[1] - art.lateral) ** 2 + (q[2] - (art.depth + art.radius)) ** 2 <= art.radius ** 2;
}
export function setTraction(A, on) {
  if (on === A.traction) return;
  A.traction = on;
  if (on) {
    A.everTraction = true;
    const g = gate(A, 'anchor');
    if (g.ok) complete(A, 'anchor');
  } else if (A.needle.inSkin && !A.pierce.front && !A.ended) {
    addError(A, 'tractionEarly');
    A.vein.dy += rollOf(A) * A.P.vein.rollOnReleaseMM * Math.sign(A.mark.lateral || 1);   // the vein drifts
  }
  log(A, on ? 'tractionOn' : 'tractionOff');
}
export function setYaw(A, deg) {
  if (A.cath.thread > 0) return;
  const n = A.needle;
  // in the vein it is held; in the skin short of it, it swings about the entry (fishing for the vein)
  if (n.inSkin && A.pierce.front) return;
  if (n.inSkin) {
    const d0 = needleDir(A), t = n.tip;
    const E = [t[0] - n.s * d0[0], t[1] - n.s * d0[1], t[2] - n.s * d0[2]], y0 = n.yaw;
    n.yaw = clamp(deg, -90, 90);
    hurt(A, n.s * Math.abs(n.yaw - y0) * D * A.P.pain.perMM);      // (the tip swept through the tissue)
    const d1 = needleDir(A);
    n.tip = [E[0] + n.s * d1[0], E[1] + n.s * d1[1], E[2] + n.s * d1[2]];
    A.pierce.indent = 0; A.vein.pushing = false;
    interact(A, 0);
    return;
  }
  n.yaw = clamp(deg, -90, 90);
  if (!A.needle.inSkin && A.done.has('seal')) {
    const g = gate(A, 'align');
    if (g.ok && Math.abs(A.needle.yaw) <= A.P.align.tolDeg) complete(A, 'align');
  }
}
export function setPitch(A, deg) {
  if (A.cath.thread > 0) return;
  A.needle.pitch = clamp(deg, 2, 60);
  if (A.needle.inSkin) interact(A, 0);
  flashDone(A);
}
// the flashback step is done once the flash has shown, the catheter's tip is in and the angle is
// down — whichever comes last (gone in far before the flash showed, lowering it is what's left)
function flashDone(A) {
  if (A.pierce.flashAt != null && A.cathTip === 'lumen' && !A.done.has('flash') && A.needle.pitch <= A.P.angles.lowerMax) complete(A, 'flash');
}
/* Advance (mm, negative withdraws) the needle along its axis. */
export function advance(A, mm) {
  if (A.cath.thread > 0) {
    if (mm > 0 && A.needle.withdrawn > 0 && !A.needle.shielded) addError(A, 'reinsert');
    return { ok: false };
  }
  if (A.needle.s <= 0 && mm > 0) {
    const g = gate(A, 'insert'); if (!g.ok) return g;
    if (!A.mark) return { ok: false, why: 'Mark a site first.' };
    if (!A.kit.broken && A.mode === 'guided') return { ok: false, why: 'Break the seal first.' };
    if (!A.needle.inSkin) {
      A.needle.inSkin = true; A.needle.yawAtEntry = A.needle.yaw; A.needle.tip = [0, A.mark.lateral, 0];
      log(A, 'skinEntry', { pitch: A.needle.pitch, yaw: A.needle.yaw });
      if (!A.done.has('clean')) addError(A, 'order', { repeat: true, skipped: 'clean', did: 'insert' });
      else if (!A.clean.dry) { addError(A, 'insertWet'); hurt(A, A.P.pain.skin); }     // (wet alcohol stings)
      hurt(A, A.P.pain.skin);
      if (Math.abs(A.needle.yaw) > A.P.align.tolDeg) addError(A, 'misaligned');
    }
  }
  const steps = Math.max(1, Math.ceil(Math.abs(mm) / 0.1)), d = mm / steps;
  for (let i = 0; i < steps; i++) {
    const before = A.needle.s;
    A.needle.s = Math.max(0, A.needle.s + d);
    const moved = A.needle.s - before, dir = needleDir(A), t = A.needle.tip;
    A.needle.tip = [t[0] + moved * dir[0], t[1] + moved * dir[1], t[2] + moved * dir[2]];
    if (A.needle.s === 0 || A.needle.tip[2] <= 0) {         // back out of the skin
      A.needle.s = 0; A.needle.inSkin = false; A.needle.tip = [0, A.mark.lateral, 0];
      A.pierce.front = false; A.pierce.indent = 0; A.tip = 'outside'; A.cathTip = 'outside';
      break;
    }
    if (moved < 0) hurt(A, -moved * A.P.pain.perMM);
    interact(A, moved);
    if (A.ended) break;
  }
  return { ok: true };
}

/* One sub-step of the needle against the vein: pushes, pierces, enters, passes. */
function interact(A, ds) {
  if (!A.mark) return;
  const P = A.P.vein, n = A.needle, k = A.pierce;
  const fill = A.tq.fill;
  // stiffness: a full vein resists, an anchored vein stays put
  const stiff = (0.6 + 0.4 * fill) * (A.traction ? 1 : 0.6);
  let q = tipPos(A);
  if (!k.front) {
    /* THE FRONT WALL. Once the tip reaches the top of the vein (where it lies, as pushed) and
       is over it, the wall tents down with the tip — the two stay in contact — and the advance
       splits: its share INTO the wall (sin of the angle it meets it at) builds toward puncture;
       the rest pushes the vein down, flattens it and, unanchored, rolls it away from the side
       it is pushed on. Under the pierce window the share into the wall falls off with the square
       of the angle: a shallow needle mostly shoves. When the vein can be pushed no further it is
       pinned, and the advance goes into the wall regardless — through a vein flattened by then. */
    const r = veinR(A), top = A.mark.depth + A.vein.dz;
    const across = q[1] - A.vein.dy;
    // FROM THE SIDE (fished across to it, or come at it at an angle): the tip against the vein's
    // flank, moving in toward its middle. The same build to a puncture, from the share of the
    // advance that goes into that wall; the rest shoves the vein sideways — it rolls away, unless
    // the skin is held.
    const d = needleDir(A), inward = -Math.sign(across) * d[1];
    const rz = q[2] - veinCentreZ(A), bz = r * (1 - A.vein.flat) + P.wallMM;
    const side = ds > 0 && Math.abs(across) > 0.8 * r && Math.abs(across) <= r + P.wallMM + 0.3 && Math.abs(rz) <= bz && inward > 0.05;
    if (side) {
      const incS = Math.asin(Math.min(1, inward)) / D;
      const shallowS = incS < A.P.angles.pierceMin ? (incS / A.P.angles.pierceMin) ** 2 : 1;
      // (loose, it slides off about as fast as it is pushed — until it can go no further; held, hardly
      // at all. Only what the needle gains on it goes into the wall)
      const roll = ds * (A.traction ? 0.1 : 1.1) * rollOf(A) * (0.4 + 0.6 * inward);
      const dy0 = A.vein.dy;
      A.vein.dy = clamp(A.vein.dy - Math.sign(across) * roll, -P.maxRollMM, P.maxRollMM);
      const gain = Math.max(0, ds * d[1] * -Math.sign(across) - Math.abs(A.vein.dy - dy0));
      k.indent += gain * shallowS * (0.6 + 0.4 * stiff);
      A.vein.pushing = true;
      if (k.indent >= P.punctureMM) {
        k.front = true; k.fromSide = true; k.sPierce = n.s; n.pitchAtPuncture = n.pitch;
        log(A, 'sideWallIn', { pitch: n.pitch, yaw: n.yaw });
        if (Math.abs(n.yaw) >= A.P.align.acrossDeg) addError(A, 'acrossVein');
        // the tip just inside the flank, at its depth (the vein is round: narrower above and below its middle)
        const bIn = r * (1 - A.vein.flat), hw = r * Math.sqrt(Math.max(0.05, 1 - (rz / bIn) ** 2));
        A.vein.dy = q[1] - Math.sign(across) * Math.max(0.2, hw - 0.15);
      }
    } else if (ds > 0 && Math.abs(across) <= r && q[2] >= top) {
      const inc = n.pitch, nIn = Math.sin(inc * D);
      const shallow = inc < A.P.angles.pierceMin ? (inc / A.P.angles.pierceMin) ** 2 : 1;
      const pinned = A.vein.dz >= P.maxPushMM - 1e-6;
      k.indent += ds * nIn * shallow * (0.6 + 0.4 * stiff) + (pinned ? ds * 0.5 : 0);
      A.vein.dz = Math.min(P.maxPushMM, q[2] - A.mark.depth);          // the wall follows the tip
      const push = ds * (1 - nIn) * P.pushPerMM / stiff;
      A.vein.flat = Math.min(0.9, A.vein.flat + push * P.flatPerMM / A.mark.radius * 2);
      const roll = ds * (A.traction ? 0.15 : 1) * rollOf(A) * P.rollPerMM * (1 - nIn)
        * (Math.abs(n.yaw) > 4 || Math.abs(across) > 0.5 ? 1 : 0.35);
      const away = -Math.sign(across || n.yaw || A.mark.lateral || 1);
      A.vein.dy = clamp(A.vein.dy + away * roll, -P.maxRollMM, P.maxRollMM);
      A.vein.pushing = true;
      if (k.indent >= P.punctureMM) {
        k.front = true; k.sPierce = n.s; n.pitchAtPuncture = n.pitch;
        log(A, 'frontWall', { pitch: n.pitch, flat: +A.vein.flat.toFixed(2) });
        if (n.pitch < A.P.angles.pierceMin) addError(A, 'tooShallow');
        if (n.pitch > A.P.angles.steepOver) addError(A, 'tooSteep');
        // across the vein a catheter cannot be threaded at all: that ends the attempt
        if (Math.abs(n.yaw) >= A.P.align.acrossDeg) addError(A, 'acrossVein');
        if (A.vein.flat >= P.doubleWallFlat) { k.back = true; A.tip = 'through'; addError(A, 'doubleWall'); return; }
        // the tip is just under the roof; the tented wall then springs back round the needle
        const b = r * (1 - A.vein.flat);
        A.vein.dz = q[2] - 0.1 + b - (A.mark.depth + P.wallMM + r);
      }
    } else {
      A.vein.pushing = false;
      if (arteryAt(A, q)) { k.artery = true; A.flash.artery = true; addError(A, 'arterial'); return; }
      // past the vein's depth without touching it: a miss (back off and redirect)
      if (q[2] > veinCentreZ(A) + r + 1.5) addError(A, 'missed');
    }
    A.tip = k.front ? whereIs(A, q) : 'outside';
  } else {
    A.vein.pushing = false;
    const where = whereIs(A, q, { passed: true });
    if (where === 'lumen') { A.tip = 'lumen'; }
    else {
      // left the lumen: back wall (below), side wall (across) or back out of the front
      const cz = veinCentreZ(A), r = veinR(A);
      if (q[2] > cz) {
        const beyond = q[2] - (cz + r * (1 - A.vein.flat));
        if (beyond > P.backWallMM && !k.back) { k.back = true; addError(A, 'backWall'); }
        A.tip = k.back ? 'through' : 'wall';
      } else if (ds >= 0 && Math.abs(q[1] - A.vein.dy) > r) {
        if (!k.side) { k.side = true; addError(A, 'sideWall'); }
        A.tip = 'through';
      } else if (where === 'outside' && ds < 0) {
        // drawn back up out of the vein: the next way in has to pierce the wall again
        A.tip = 'outside'; k.front = false; k.indent = 0;
      } else A.tip = 'wall';
    }
    if (arteryAt(A, q)) { k.artery = true; A.flash.artery = true; addError(A, 'arterial'); }
  }
  // The catheter's tip, bevelToCath behind the bevel, is in the vein once it has passed the hole
  // the needle made in the wall — not when its position falls inside the vein's outline, which a
  // tented wall puts it in early. That gap is why the needle goes on 1-2 mm after the flash.
  if (!k.front) A.cathTip = 'outside';
  else if (n.s - A.P.needle.bevelToCathMM < k.sPierce + 0.1) A.cathTip = 'wall';
  else A.cathTip = whereIs(A, tipPos(A, A.P.needle.bevelToCathMM), { passed: true }) === 'through' && k.back ? 'through' : 'lumen';
  // after the flash: did the angle come down before the extra advance?
  if (k.flashAt != null && ds > 0) {
    k.advancedAfterFlash += ds;
    if (n.pitch > A.P.angles.lowerMax && k.advancedAfterFlash > 0.8) addError(A, 'notLowered');
    if (k.lowered == null && n.pitch <= A.P.angles.lowerMax) k.lowered = A.t - k.flashAt;
    if (A.cathTip === 'lumen' && !A.done.has('flash') && n.pitch <= A.P.angles.lowerMax) complete(A, 'flash');
  }
  if (A.tip === 'lumen' && !A.done.has('insert')) complete(A, 'insert');
}

/* ---- 9 thread ------------------------------------------------------------------------------ */
export function thread(A, ticks = 1) {
  if (!A.pierce.front) return { ok: false, why: 'The needle is not in the vein.' };
  flashDone(A);
  const g = gate(A, 'thread'); if (!g.ok) return g;
  if (A.cath.hubbed) return { ok: true };
  const P = A.P;
  if (A.cath.thread === 0) {
    if (A.cathTip !== 'lumen' && A.tip === 'lumen') addError(A, 'stoppedAtFlash');
    A.cath.inVein = A.cathTip === 'lumen';
  }
  for (let i = 0; i < ticks; i++) {
    const inLumen = A.cath.inVein && !A.pierce.back && !A.pierce.side;
    if (!A.cath.inVein) {
      A.cath.resist++;
      A.cath.thread += P.thread.tickMM * 0.25;
      if (A.cath.resist >= P.thread.resistTicks) { A.cath.bunched = true; addError(A, 'threadOutside'); return { ok: false }; }
      continue;
    }
    if (A.needle.pitch > P.angles.threadMax && !A.cath.bunched) {
      A.cath.resist++;
      addError(A, 'threadSteep');
      A.cath.thread += P.thread.tickMM * 0.3;
      if (A.cath.resist >= P.thread.resistTicks + 2) { A.cath.bunched = true; A.cath.resist = 0; addError(A, 'bunched'); return { ok: false, resist: true }; }
      continue;
    }
    if (!inLumen) { A.cath.resist++; continue; }
    if (!A.traction && A.vein.dy !== 0 && Math.abs(A.vein.dy) > veinR(A)) { A.cath.resist++; continue; }
    // a valve ahead: the catheter's tip stops at it; pushed on, it is forced through
    const v = A.mark.valveAheadMM;
    if (v != null && !A.cath.pastValve && catheterTip(A)[0] + P.thread.tickMM > v) {
      if (++A.cath.resist < P.thread.resistTicks) continue;
      A.cath.pastValve = true; A.cath.resist = 0; addError(A, 'valveHit'); log(A, 'valveForced');
    }
    A.cath.thread += P.thread.tickMM;
    const need = P.needle.cathLenMM - A.needle.s + P.needle.bevelToCathMM;
    if (A.cath.thread >= need) { A.cath.hubbed = true; log(A, 'hubbed'); complete(A, 'thread'); if (!A.done.has('flash')) complete(A, 'flash'); }
  }
  return { ok: true, resist: A.cath.resist };
}

/* ---- 10 withdraw ---------------------------------------------------------------------------- */
export function withdrawNeedle(A, mm) {
  if (A.ended) {           // after an attempt-ending error, the whole thing comes out
    if (!A.pressure.removed) { A.pressure.removed = true; A.needle.s = 0; log(A, 'removed'); }
    return { ok: true };
  }
  const g = gate(A, 'withdraw'); if (!g.ok) return g;
  if (!A.cath.hubbed) return { ok: false, why: 'Thread the catheter first.' };
  A.needle.withdrawn = Math.max(0, A.needle.withdrawn + mm);
  if (A.needle.withdrawn >= P_len(A) && !A.needle.shielded) { A.needle.shielded = true; log(A, 'shielded'); }
  return { ok: true };
}
// the shielded needle into the sharps container
export function disposeNeedle(A) {
  if (!A.needle.shielded) return { ok: false, why: 'Withdraw the needle first.' };
  if (A.needle.disposed) return { ok: true };
  const g = gate(A, 'withdraw'); if (!g.ok) return g;
  A.needle.disposed = true; log(A, 'disposed');
  complete(A, 'withdraw');
  return { ok: true };
}
const P_len = (A) => A.P.needle.needleLenMM;

/* ---- 11 / 16 / 18 the clamp, 12 the port cap ----------------------------------------------------- */
// The clamp starts open. Its first close is step 11, opening it is 16, the close after that 18.
export function toggleClamp(A) {
  const id = !A.clampOpen ? 'clamp2' : (!A.done.has('clamp1') ? 'clamp1' : 'clamp3');
  const g = gate(A, id); if (!g.ok) return g;
  A.clampOpen = !A.clampOpen;
  log(A, A.clampOpen ? 'clampOpen' : 'clampClosed');
  complete(A, id);
  return { ok: true };
}
export function removePortCap(A) {
  const g = gate(A, 'portcap'); if (!g.ok) return g;
  if (A.portOpen) return { ok: true };
  A.portOpen = true;
  if (A.clampOpen) addError(A, 'orderCritical', { repeat: true, did: 'portcap', skipped: 'clamp1' });
  complete(A, 'portcap');
  return { ok: true };
}

/* ---- 14 dressing -------------------------------------------------------------------------------- */
export function placeDressing(A, offsetMM, covers) {
  const g = gate(A, 'dressing'); if (!g.ok) return g;
  A.dressing.placed = true;
  A.dressing.ok = covers ?? offsetMM <= A.P.dressing.tolMM;
  A.dressing.edges = [false, false, false, false];
  if (!A.dressing.ok) addError(A, 'dressingPoor');
  log(A, 'dressingPlaced', { offset: +offsetMM.toFixed(1) });
  return { ok: true };
}
export function pressEdge(A, i) {
  if (!A.dressing.placed) return { ok: false };
  A.dressing.edges[i] = true;
  if (A.dressing.edges.every(Boolean)) complete(A, 'dressing');
  return { ok: true };
}

/* ---- 15 / 19 syringe, 17 flush, 20 cap ---------------------------------------------------------------- */
export function attachSyringe(A, touchedOther = false) {
  const g = gate(A, 'syringe'); if (!g.ok) return g;
  if (!A.portOpen) return { ok: false, why: 'Take the port cap off first.' };
  if (touchedOther) { A.syringe.dirty = true; addError(A, 'syringeDirty'); }
  Object.assign(A.syringe, { on: true, twist: 0, locked: false, drawn: 0, blood: 0, checked: false, rate: 0, pushT: 0, pushed: 0 });
  return { ok: true };
}
export function twistSyringe(A, deg) {
  if (!A.syringe.on) return { ok: false };
  if (!A.syringe.locked) {
    A.syringe.twist = clamp(A.syringe.twist + deg, 0, A.P.twistLockDeg);
    if (A.syringe.twist >= A.P.twistLockDeg) { A.syringe.locked = true; log(A, 'syringeLocked'); complete(A, 'syringe'); }
    return { ok: true };
  }
  // twisting it back off (19)
  if (deg < 0) {
    const g = gate(A, 'syringeOff'); if (!g.ok) return g;
    A.syringe.twist = clamp(A.syringe.twist + deg, 0, A.P.twistLockDeg);
    if (A.syringe.twist <= 0) {
      if (A.clampOpen) addError(A, 'disconnectOpen');
      A.syringe.on = false; A.syringe.locked = false; log(A, 'syringeOff');
      complete(A, 'syringeOff');
    }
  }
  return { ok: true };
}
/* Pull the plunger back: mL. With the catheter in the vein, blood comes back into the syringe and
   clouds the saline — the check that it is in before anything is pushed. */
export function aspirate(A, ml) {
  if (!A.syringe.locked) return { ok: false };
  const g = gate(A, 'flush'); if (!g.ok) return g;
  if (!A.clampOpen) return { ok: false, resist: true, why: 'The clamp is closed.' };
  const P = A.P.flush, s = A.syringe;
  ml = Math.min(ml, Math.max(0, P.aspirateMaxML - s.drawn));
  s.drawn += ml;
  const tipIn = A.cath.inVein && A.cath.hubbed && !A.pierce.back && !A.pierce.side;
  if (tipIn) { s.blood += ml * 0.8; A.line.blood = 1; }
  if (s.blood >= P.bloodCheckML) s.checked = true;
  return { ok: true, blood: tipIn };
}
/* Push the plunger: mL, over dtS seconds. What was drawn back goes in first. */
export function flush(A, ml, dtS) {
  if (!A.syringe.locked) return { ok: false };
  const g = gate(A, 'flush'); if (!g.ok) return g;
  if (!A.clampOpen) { addError(A, 'flushClosed'); return { ok: false, resist: true }; }
  const P = A.P.flush, s = A.syringe;
  if (!s.checked) {
    if (A.mode === 'guided') return { ok: false, why: 'Pull back first: check for blood.' };
    addError(A, 'noBloodCheck');
  }
  const pushed = ml;
  if (s.drawn > 0) {
    const back = Math.min(ml, s.drawn);
    s.blood = Math.max(0, s.blood - back * (s.blood / s.drawn));
    s.drawn -= back; ml -= back;
  }
  const room = Math.max(0, P.volumeML - s.vol);
  ml = Math.min(ml, room);
  s.vol += ml;
  A.line.blood = Math.max(0, A.line.blood - ml * 0.6);
  // the speed: a running average while the plunger moves (the caller leaves pauses out of dtS)
  const dt = Math.max(1e-3, dtS || 0);
  if (pushed > 0) {
    s.pushT += dt; s.pushed = (s.pushed || 0) + pushed;
    const k = Math.min(1, dt / 0.3);
    s.rate = s.rate * (1 - k) + (pushed / dt) * k;
    if (s.rate > rateLimit(A)) addError(A, 'flushFast');
  }
  const tipIn = A.cath.inVein && A.cath.hubbed && !A.pierce.back && !A.pierce.side;
  // a small, thin-walled vein pushed faster than it takes leaks round the catheter even with
  // the tip in it: its share of what goes in grows with the overrun and the vein's fragility
  // (extravasation is twice as common on the back of the hand as in the antecubital fossa)
  const overrun = P.veinMaxMLs && tipIn ? Math.min(1, s.rate / P.veinMaxMLs - 1) : 0;
  if (!tipIn || overrun > 0) {
    A.infiltration += ml * (tipIn ? overrun * (A.mark.fragility ?? 0.5) : 1);
    if (A.infiltration >= P.infiltrationML) addError(A, 'infiltration');
    if (!tipIn || A.ended) return { ok: true, resist: true };
  }
  if (A.tq.on) addError(A, 'tqLeft');
  if (s.vol >= P.volumeML && !A.done.has('flush')) {
    if (s.pushed / Math.max(1e-3, s.pushT) < P.minRateMLs) addError(A, 'flushSlow');
    complete(A, 'flush');
  }
  return { ok: true };
}
export function attachCap(A, touchedOther = false) {
  const g = gate(A, 'cap'); if (!g.ok) return g;
  if (A.syringe.on) return { ok: false, why: 'Take the syringe off first.' };
  if (touchedOther) { A.cap.dirty = true; addError(A, 'capDirty'); }
  A.cap.on = true; A.cap.twist = 0;
  return { ok: true };
}
export function twistCap(A, deg) {
  if (!A.cap.on || A.cap.locked) return { ok: false };
  A.cap.twist = clamp(A.cap.twist + deg, 0, A.P.twistLockDeg);
  if (A.cap.twist >= A.P.twistLockDeg) { A.cap.locked = true; A.portOpen = false; log(A, 'capped'); complete(A, 'cap'); }
  return { ok: true };
}

/* ---- after an attempt-ending error: remove, gauze, hold pressure -------------------------------- */
export function applyGauze(A) { if (A.ended && A.pressure.removed) { A.pressure.gauze = true; return { ok: true }; } return { ok: false }; }
export function holdPressure(A, dtS) {
  if (!A.pressure.gauze) return { ok: false };
  A.pressure.held += dtS;
  if (A.pressure.held >= A.P.pressureS && !A.pressure.done) { A.pressure.done = true; log(A, 'pressureDone'); finish(A); }
  return { ok: true };
}

/* ---- time ------------------------------------------------------------------------------------------- */
export function update(A, dt) {
  if (A.finished) return;
  A.t += dt;
  const P = A.P;
  // the tourniquet fills the veins over fillS, and they empty over releaseS
  const tq = P.tourniquet;
  A.tq.fill = clamp(A.tq.fill + (A.tq.on ? dt / tq.fillS : -dt / tq.releaseS), 0, 1);
  if (A.tq.on) {
    const on = tourniquetTime(A);
    if (on > tq.warnS && !A.tq.warned) { A.tq.warned = true; addError(A, 'tqWarn'); }
    if (on > tq.limitS && !A.tq.over) { A.tq.over = true; addError(A, 'tqOver'); }
  }
  // the prep dries
  if (A.clean.dryFrom != null && !A.clean.dry && A.t - A.clean.dryFrom >= P.clean.dryS) {
    A.clean.dry = true; A.clean.dryAt = A.t; complete(A, 'clean'); log(A, 'dry');
  }
  // a pushed vein springs back when the needle stops pushing
  if (!A.vein.pushing) {
    const k = Math.exp(-dt / P.vein.reboundS);
    if (!A.pierce.front) {               // let go of, the vein springs back whole
      A.vein.dz *= k; A.vein.flat *= k; if (!A.needle.inSkin) A.vein.dy *= k;
      A.pierce.indent *= k;
    } else A.vein.flat *= k;             // pierced, its flattened wall springs back round the needle
  }
  A.vein.pushing = false;
  // blood into the flash chamber, once the bevel has been in the lumen for the delay
  if (A.mark && A.needle.inSkin) {
    if (A.tip === 'lumen' || A.flash.artery) A.flash.lumenFor += dt; else A.flash.lumenFor = 0;
    const delay = A.tq.on ? P.needle.flashDelayTqS : P.needle.flashDelayS;
    if (A.flash.lumenFor >= delay && !A.pierce.back && !A.pierce.side) {
      if (A.pierce.flashAt == null) { A.pierce.flashAt = A.t; A.pierce.sAtFlash = A.needle.s; log(A, 'flash', { pitch: A.needle.pitch }); }
      A.flash.level = clamp(A.flash.level + dt / P.needle.flashFillS * (A.flash.artery ? 2.5 : 1), 0, 1);
    }
  }
  // the vein drifts off an unanchored needle while it is in the skin
  if (A.needle.inSkin && !A.traction && !A.pierce.front && A.mark) {
    A.vein.dy = clamp(A.vein.dy + Math.sign(A.mark.lateral || 1) * rollOf(A) * 0.15 * dt, -P.vein.maxRollMM, P.vein.maxRollMM);
  }
  // a breached vein bleeds into the tissue
  if (A.pierce.back || A.pierce.side || A.pierce.artery) A.hematoma = clamp(A.hematoma + dt * (A.pierce.artery ? 0.25 : 0.12), 0, 1);
  // blood backs up the extension set while the clamp is open and the catheter is in the vein:
  // slowly past the needle still inside it, fast once that is out; a capped port stops it
  const inVein = A.cath.hubbed && A.cath.inVein;
  const inLumen = inVein || (A.cath.thread > 0 && A.cath.inVein) || (A.flash.level > 0 && A.cathTip === 'lumen');
  if (inLumen && A.clampOpen && !A.ended && !A.syringe.on) {
    const out = A.needle.shielded ? 1 : clamp(A.needle.withdrawn / P.needle.needleLenMM, 0, 1);
    A.line.blood = clamp(A.line.blood + dt * (0.03 + 0.97 * out) * (A.tq.on ? 1.6 : 1), 0, 1);
  }
  // an open system bleeds at the port, once the blood has reached it
  if (A.portOpen && A.clampOpen && inVein && !A.syringe.on && !A.cap.on && A.line.blood >= 1) {
    A.spill = clamp(A.spill + dt * (A.tq.on ? 0.6 : 0.25), 0, 1);
    if (A.spill > 0.05) addError(A, 'spill');
  }
  if (A.needle.inSkin && (A.trace.length === 0 || A.t - A.trace[A.trace.length - 1].t > 0.1)) {
    A.trace.push({ t: +A.t.toFixed(2), pitch: A.needle.pitch, s: +A.needle.s.toFixed(2), flash: A.flash.level > 0 });
  }
}

/* ---- the end and the score ---------------------------------------------------------------------------- */
export function finish(A) {
  if (A.finished) return;
  if (A.portOpen && !A.cap.locked && !A.ended) addError(A, 'portOpen');
  if (A.tq.on) { A.tq.total += A.t - A.tq.at; A.tq.on = false; }
  A.finished = true;
  log(A, 'finished');
}
/* 100 points in five categories (data/iv.json score.weights); critical failures cap the score
   at a fail in Assessment. */
export function score(A) {
  const W = A.cfg.score.weights, P = A.P;
  const cat = { sequence: W.sequence, insertion: W.insertion, asepsis: W.asepsis, securement: W.securement, time: W.time };
  const lose = (c, n) => { cat[c] = Math.max(0, cat[c] - n); };
  for (const e of A.errors) {
    const c = e.cat === 'technique' ? 'insertion' : e.cat;
    if (cat[c] != null) lose(c, e.pts);
  }
  // credit what was done right, not only what went wrong
  const n = A.needle, k = A.pierce;
  if (n.pitchAtPuncture == null || n.pitchAtPuncture < P.angles.pierceMin || n.pitchAtPuncture > P.angles.pierceMax) lose('insertion', 3);
  if (k.flashAt != null && (k.lowered == null || k.lowered > P.angles.lowerWithinS)) lose('insertion', 3);
  if (A.number > 1) lose('insertion', 5);
  if (!A.done.has('cap')) lose('securement', 5);
  if (!A.done.has('flush')) lose('securement', 5);
  if (!A.done.has('dressing')) lose('securement', 3);
  if (!A.done.has('clean')) lose('asepsis', 8);
  const on = tourniquetTime(A);
  if (on > P.tourniquet.warnS) lose('time', 3);
  const total = Math.round(Object.values(cat).reduce((a, b) => a + b, 0));
  const critical = A.errors.some((e) => A.cfg.score.criticalFails.includes(e.code));
  const pass = !critical && !A.ended && total >= A.cfg.score.passMark;
  return { total, cat, critical, pass, tourniquetS: on, timeS: A.t };
}
/* The debrief: the steps in order with their time, the errors, and the tips for the biggest losses. */
export function debrief(A) {
  const s = score(A);
  const steps = STEP_IDS.map((id, i) => ({
    id, title: stepText(A, i).title,
    t: A.log.find((e) => e.type === 'stepDone' && e.id === id)?.t ?? null,
    errors: A.errors.filter((e) => e.step === id).map((e) => e.msg),
  }));
  const byLoss = [...A.errors].filter((e) => e.tip).sort((a, b) => b.pts - a.pts);
  const tips = [...new Set(byLoss.map((e) => e.tip))].slice(0, 2);
  // (what the line will take: the contrast's flow rate on the injector may not go past it)
  return { score: s, steps, errors: A.errors, tips, trace: A.trace, flashAt: A.pierce.flashAt, ended: A.ended,
    rateLimit: rateLimit(A), pain: A.pain };
}
