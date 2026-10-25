// The IV procedure engine (src/core/ivSim.js): the step machine, the needle against the vein,
// the closed system, and the score.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as IV from '../src/core/ivSim.js';

const cfg = JSON.parse(readFileSync(new URL('../src/data/iv.json', import.meta.url), 'utf8'));
// a median cubital vein: 3 mm radius, its top 3.5 mm under the skin, marked dead centre
const SITE = { veinId: 'medianCubital', lateral: 0, radius: 3, depth: 3.5, atValve: false, atJoin: false, roll: 0.6, fragility: 0.4 };

function run(A, s) { for (let t = 0; t < s; t += 0.05) IV.update(A, 0.05); }
// everything up to the needle at the skin, done right
function toSkin(opts = {}) {
  const A = IV.createAttempt(cfg, { mode: 'guided', ...opts });
  for (const p of cfg.procedure.prep) IV.tickPrep(A, p);
  IV.applyTourniquet(A, true);
  run(A, 26);                                   // the veins fill
  IV.markSite(A, { ...SITE, ...(opts.site || {}) });
  IV.cleanStroke(A, 1, cfg.procedure.clean.scrubS);
  run(A, cfg.procedure.clean.dryS + 0.2);
  IV.sealSlide(A, 2.5); IV.sealRelease(A);
  IV.setYaw(A, 0);
  IV.setTraction(A, true);
  return A;
}
// advance in small steps, letting time pass, until the flash or a limit
function advanceUntil(A, maxMM, stop) {
  for (let d = 0; d < maxMM; d += 0.2) {
    IV.advance(A, 0.2); IV.update(A, 0.05);
    if (stop(A) || A.ended) return;
  }
}

test('a textbook attempt runs all 21 steps, with nothing logged against it', () => {
  const A = toSkin();
  assert.equal(IV.currentStep(A), 'insert');
  IV.setPitch(A, 25);
  advanceUntil(A, 20, (a) => a.flash.level > 0);
  assert.ok(A.flash.level > 0, `flash at 25°: tip ${A.tip}`);
  assert.equal(A.needle.pitchAtPuncture, 25);
  IV.setPitch(A, 12);                           // lower on flash
  advanceUntil(A, 4, (a) => a.cathTip === 'lumen');
  assert.equal(A.cathTip, 'lumen');
  IV.setPitch(A, 8);
  for (let i = 0; i < 15 && !A.cath.hubbed; i++) IV.thread(A, 1);
  assert.ok(A.cath.hubbed, 'threaded to the hub');
  IV.setTraction(A, false);
  IV.withdrawNeedle(A, 40);
  IV.disposeNeedle(A);                          // into the sharps container
  IV.toggleClamp(A);                            // close
  IV.removePortCap(A);
  IV.releaseTourniquet(A);
  IV.placeDressing(A, 2); [0, 1, 2, 3].forEach((i) => IV.pressEdge(A, i));
  IV.attachSyringe(A); IV.twistSyringe(A, 90);
  IV.toggleClamp(A);                            // open
  assert.equal(IV.flush(A, 1, 1).ok, false, 'Guided: no flush before the pull-back');
  assert.equal(IV.aspirate(A, 0.5).blood, true, 'blood comes back');
  for (let i = 0; i < 12 && !A.done.has('flush'); i++) { IV.flush(A, 1, 0.8); IV.update(A, 0.8); }
  IV.toggleClamp(A);                            // close
  IV.twistSyringe(A, -90);
  IV.attachCap(A); IV.twistCap(A, 90);
  assert.ok(A.finished, `finished at ${IV.currentStep(A)}`);
  assert.deepEqual(A.errors.map((e) => e.code), []);
  const s = IV.score(A);
  assert.ok(s.pass && s.total >= 95, JSON.stringify(s));
});

test('the angle decides: 15-30° pierces clean, shallow shoves and goes through both walls, steep is logged', () => {
  const good = toSkin(); IV.setPitch(good, 22);
  advanceUntil(good, 20, (a) => a.pierce.front);
  assert.ok(good.pierce.front && !good.pierce.back, '22°: front wall only');
  assert.ok(good.vein.dz < 1, `little displacement: ${good.vein.dz.toFixed(2)} mm`);

  const pushed = toSkin(); IV.setPitch(pushed, 8);
  advanceUntil(pushed, 30, (a) => a.pierce.front);
  assert.ok(!pushed.pierce.front, '8°: the vein is only pushed');
  assert.ok(pushed.vein.flat > 0.4 && pushed.vein.dz > 0.5, `pushed down and flattened: ${pushed.vein.dz.toFixed(2)} / ${pushed.vein.flat.toFixed(2)}`);

  const flat = toSkin(); IV.setPitch(flat, 12);
  advanceUntil(flat, 40, (a) => a.pierce.front);
  assert.ok(flat.errors.some((e) => e.code === 'doubleWall'), flat.errors.map((e) => e.code).join());
  assert.ok(flat.ended, '12°: late, through both walls of the flattened vein, and the attempt ends');

  const steep = toSkin(); IV.setPitch(steep, 45);
  advanceUntil(steep, 20, (a) => a.pierce.front);
  assert.ok(steep.errors.some((e) => e.code === 'tooSteep'));
});

test('after the flash: advancing at the entry angle runs into the back wall', () => {
  const A = toSkin(); IV.setPitch(A, 30);
  advanceUntil(A, 20, (a) => a.flash.level > 0);
  advanceUntil(A, 20, (a) => a.pierce.back);
  const codes = A.errors.map((e) => e.code);
  assert.ok(codes.includes('notLowered') && codes.includes('backWall'), codes.join());
  run(A, 2);
  assert.ok(A.hematoma > 0, 'a haematoma spreads');
});

test('threading: at the first flash the catheter is not in; steep threading bunches it', () => {
  // (Guided would block threading before the flashback step; Practice lets it happen and logs it)
  const early = toSkin({ mode: 'practice' }); IV.setPitch(early, 25);
  advanceUntil(early, 20, (a) => a.flash.level > 0);
  IV.setPitch(early, 8);
  IV.thread(early, 1);                          // the bevel is in, the catheter not yet
  assert.ok(early.errors.some((e) => e.code === 'stoppedAtFlash'));

  const steep = toSkin(); IV.setPitch(steep, 25);
  advanceUntil(steep, 20, (a) => a.flash.level > 0);
  IV.setPitch(steep, 12); advanceUntil(steep, 4, (a) => a.cathTip === 'lumen');
  IV.setPitch(steep, 20);
  // (once threading starts the needle is locked, so set the angle before)
  for (let i = 0; i < 8; i++) IV.thread(steep, 1);
  const codes = steep.errors.map((e) => e.code);
  assert.ok(codes.includes('threadSteep') && codes.includes('bunched'), codes.join());
});

test('an unanchored vein rolls away from a needle that is not dead on it', () => {
  const A = toSkin({ site: { lateral: 1.5, roll: 1.3 } });
  IV.setTraction(A, false);
  IV.setPitch(A, 14);
  advanceUntil(A, 25, (a) => a.pierce.front);
  assert.ok(Math.abs(A.vein.dy) > 0.5, `rolled ${A.vein.dy.toFixed(2)} mm`);
});

test('the closed system: opening the port with the clamp open bleeds and is a critical order error', () => {
  const A = toSkin({ mode: 'practice' }); IV.setPitch(A, 25);
  advanceUntil(A, 20, (a) => a.flash.level > 0);
  IV.setPitch(A, 12); advanceUntil(A, 4, (a) => a.cathTip === 'lumen');
  IV.setPitch(A, 8);
  for (let i = 0; i < 15 && !A.cath.hubbed; i++) IV.thread(A, 1);
  IV.withdrawNeedle(A, 40);
  IV.removePortCap(A);                          // the clamp is still open
  run(A, 1);
  const codes = A.errors.map((e) => e.code);
  assert.ok(codes.includes('orderCritical') && codes.includes('spill'), codes.join());
  assert.ok(A.spill > 0);
});

test('Guided blocks a step taken early; Practice allows it and flags it', () => {
  const g = IV.createAttempt(cfg, { mode: 'guided' });
  const r = IV.applyTourniquet(g, true);
  assert.equal(r.ok, false, 'tourniquet before prep is blocked');
  assert.match(r.why, /prep/i);
  const p = IV.createAttempt(cfg, { mode: 'practice' });
  assert.equal(IV.applyTourniquet(p, true).ok, true);
  assert.ok(p.errors.some((e) => e.code === 'order' || e.code === 'prepSkipped'));
  assert.ok(p.flags.length > 0, 'flagged live');
});

test('the tourniquet: warned at a minute, an error past two', () => {
  const A = IV.createAttempt(cfg, { mode: 'practice' });
  for (const p of cfg.procedure.prep) IV.tickPrep(A, p);
  IV.applyTourniquet(A, true);
  run(A, 61);
  assert.ok(A.errors.some((e) => e.code === 'tqWarn'));
  run(A, 61);
  assert.ok(A.errors.some((e) => e.code === 'tqOver'));
  assert.ok(A.tq.fill > 0.99, 'the veins are full');
});

test('the seal: a few millimetres reseats, too far and the catheter comes off', () => {
  const A = IV.createAttempt(cfg, { mode: 'practice' });
  IV.sealSlide(A, 2); assert.equal(IV.sealRelease(A).ok, true);
  const B = IV.createAttempt(cfg, { mode: 'practice' });
  IV.sealSlide(B, 10);
  assert.ok(B.kit.off && B.errors.some((e) => e.code === 'sealOff'));
  IV.replaceKit(B); assert.equal(B.kit.off, false);
});

test('an artery under the needle: a bright flash, and the attempt ends', () => {
  const A = toSkin({ site: { radius: 1.2, depth: 2, artery: { lateral: 0, depth: 7, radius: 2 } } });
  IV.setPitch(A, 35);
  advanceUntil(A, 30, (a) => a.ended);
  assert.ok(A.errors.some((e) => e.code === 'arterial') || A.errors.some((e) => e.code === 'backWall'),
    A.errors.map((e) => e.code).join());
});

test('palpation: a vein is felt more with the tourniquet on, a deep one less', () => {
  const A = IV.createAttempt(cfg, { mode: 'practice' });
  const near = [{ kind: 'vein', id: 'v', dist: 0, radius: 3, depth: 3.5 }];
  const before = IV.palpationCues(A, near)[0]?.strength ?? 0;
  A.tq.fill = 1;
  const after = IV.palpationCues(A, near)[0].strength;
  assert.ok(after > before, `${before} -> ${after}`);
  const deep = IV.palpationCues(A, [{ ...near[0], depth: 9 }])[0]?.strength ?? 0;
  assert.ok(deep < after);
  const art = IV.palpationCues(A, [{ kind: 'artery', id: 'a', dist: 1, radius: 2, depth: 6 }]);
  assert.equal(art[0].kind, 'artery');
});

test('a needle across the vein is a fail where it pierces it: the attempt ends and Assessment cannot pass', () => {
  // come in from beside the middle, turned 60° off the vein: it meets the vein's top at that angle
  const A = toSkin({ mode: 'assessment', site: { lateral: -2 } });
  IV.setYaw(A, 60); IV.setPitch(A, 35);
  advanceUntil(A, 30, (a) => a.pierce.front);
  assert.ok(A.errors.some((e) => e.code === 'acrossVein'), A.errors.map((e) => e.code).join());
  assert.ok(A.ended, 'the attempt ends');
  IV.finish(A);
  assert.equal(IV.score(A).pass, false);
  // a little off line is only an error, not the end
  const B = toSkin({ mode: 'practice' });
  IV.setYaw(B, 20); IV.setPitch(B, 22); IV.advance(B, 0.5);
  assert.ok(B.errors.some((e) => e.code === 'misaligned') && !B.ended);
});

test('the flush cannot push more than the syringe holds', () => {
  const A = toSkin(); IV.setPitch(A, 25);
  advanceUntil(A, 20, (a) => a.flash.level > 0);
  IV.setPitch(A, 12); advanceUntil(A, 4, (a) => a.cathTip === 'lumen');
  IV.setPitch(A, 8);
  for (let i = 0; i < 15 && !A.cath.hubbed; i++) IV.thread(A, 1);
  IV.setTraction(A, false); IV.withdrawNeedle(A, 40); IV.disposeNeedle(A);
  IV.toggleClamp(A); IV.removePortCap(A); IV.releaseTourniquet(A);
  IV.placeDressing(A, 2); [0, 1, 2, 3].forEach((i) => IV.pressEdge(A, i));
  IV.attachSyringe(A); IV.twistSyringe(A, 90); IV.toggleClamp(A);
  IV.aspirate(A, 0.5);
  for (let i = 0; i < 20; i++) { IV.flush(A, 1, 1); IV.update(A, 1); }
  assert.ok(A.syringe.vol <= cfg.procedure.flush.volumeML + 1e-9, `${A.syringe.vol} mL`);
});

test('the seal breaks off the needle and back: it counts how far the catheter went, not where it ends', () => {
  const A = IV.createAttempt(cfg, { mode: 'practice' });
  IV.sealSlide(A, 2); IV.sealSlide(A, 0);           // out 2 mm, back home
  assert.equal(IV.sealRelease(A, 2).ok, true);
  assert.ok(A.kit.broken && A.done.has('seal'));
  const B = IV.createAttempt(cfg, { mode: 'practice' });
  IV.sealSlide(B, 0.5); IV.sealSlide(B, 0);         // not far enough to break it
  assert.equal(IV.sealRelease(B, 0.5).ok, false);
  assert.ok(!B.done.has('seal'));
});

test('the prep needs no drying wait: the site is clean once scrubbed', () => {
  const A = IV.createAttempt(cfg, { mode: 'guided' });
  for (const p of cfg.procedure.prep) IV.tickPrep(A, p);
  IV.applyTourniquet(A, true); run(A, 26);
  IV.markSite(A, SITE);
  IV.cleanStroke(A, 1, cfg.procedure.clean.scrubS);
  IV.update(A, 0.05);
  assert.ok(A.done.has('clean') && A.clean.dry);
});

test('a steep thread catches on the back wall: logged, and the catheter rides over it to the hub', () => {
  const A = toSkin(); IV.setPitch(A, 25);
  advanceUntil(A, 20, (a) => a.flash.level > 0);
  IV.setPitch(A, 12); advanceUntil(A, 4, (a) => a.cathTip === 'lumen');
  IV.setPitch(A, 20);
  for (let i = 0; i < 25 && !A.cath.hubbed; i++) IV.thread(A, 1);
  assert.ok(A.errors.some((e) => e.code === 'bunched'));
  assert.ok(!A.ended, 'the attempt goes on');
  assert.ok(A.cath.hubbed, 'threaded to the hub');
});

test('once threading starts the needle is held: asking it to move is no fault', () => {
  const A = toSkin(); IV.setPitch(A, 25);
  advanceUntil(A, 20, (a) => a.flash.level > 0);
  IV.setPitch(A, 12); advanceUntil(A, 4, (a) => a.cathTip === 'lumen');
  IV.setPitch(A, 8); IV.thread(A, 1);
  const p = A.needle.pitch, y = A.needle.yaw;
  IV.setPitch(A, 20); IV.setYaw(A, 30); IV.advance(A, -1);
  assert.equal(A.needle.pitch, p); assert.equal(A.needle.yaw, y);
  assert.deepEqual(A.errors.map((e) => e.code), []);
});

test('the withdrawal ends in the sharps container', () => {
  const A = toSkin(); IV.setPitch(A, 25);
  advanceUntil(A, 20, (a) => a.flash.level > 0);
  IV.setPitch(A, 12); advanceUntil(A, 4, (a) => a.cathTip === 'lumen');
  IV.setPitch(A, 8);
  for (let i = 0; i < 15 && !A.cath.hubbed; i++) IV.thread(A, 1);
  IV.setTraction(A, false); IV.withdrawNeedle(A, 40);
  assert.ok(A.needle.shielded && !A.done.has('withdraw'), 'shielded, not yet put away');
  assert.equal(IV.disposeNeedle(A).ok, true);
  assert.ok(A.done.has('withdraw'));
});

test('blood backs up the line with the clamp open: slow past the needle, fast without it; it stops at the cap and spills at an open port', () => {
  const A = toSkin({ mode: 'practice' }); IV.setPitch(A, 25);
  advanceUntil(A, 20, (a) => a.flash.level > 0);
  IV.setPitch(A, 12); advanceUntil(A, 4, (a) => a.cathTip === 'lumen');
  IV.setPitch(A, 8);
  for (let i = 0; i < 15 && !A.cath.hubbed; i++) IV.thread(A, 1);
  const b0 = A.line.blood; run(A, 1); const slow = A.line.blood - b0;
  IV.withdrawNeedle(A, 40);
  const b1 = A.line.blood; run(A, 0.3); const fast = A.line.blood - b1;
  assert.ok(fast > slow * 3, `needle out fills faster: ${slow.toFixed(3)} vs ${fast.toFixed(3)} per`);
  run(A, 3);
  assert.equal(A.line.blood, 1, 'full to the capped port');
  assert.equal(A.spill, 0, 'capped: nothing spills');
  IV.removePortCap(A); run(A, 1);
  assert.ok(A.spill > 0, 'open: it spills');
});

test('the flush speed is judged against the gauge: over its rating, or under 1 mL/s', () => {
  const setUp = (gauge) => {
    const A = toSkin({ mode: 'practice', gauge }); IV.setPitch(A, 25);
    advanceUntil(A, 20, (a) => a.flash.level > 0);
    IV.setPitch(A, 12); advanceUntil(A, 4, (a) => a.cathTip === 'lumen');
    IV.setPitch(A, 8);
    for (let i = 0; i < 15 && !A.cath.hubbed; i++) IV.thread(A, 1);
    IV.withdrawNeedle(A, 40); IV.disposeNeedle(A);
    IV.toggleClamp(A); IV.removePortCap(A); IV.releaseTourniquet(A);
    IV.placeDressing(A, 2); [0, 1, 2, 3].forEach((i) => IV.pressEdge(A, i));
    IV.attachSyringe(A); IV.twistSyringe(A, 90); IV.toggleClamp(A); IV.aspirate(A, 0.5);
    return A;
  };
  const codes = (A) => A.errors.map((e) => e.code);
  const push = (A, ml, dt) => { for (let i = 0; i < 400 && !A.done.has('flush'); i++) IV.flush(A, ml, dt); assert.ok(A.done.has('flush')); };
  const ok = setUp(24); push(ok, 0.25, 0.1);       // 2.5 mL/s on a 24G (rated 3)
  assert.ok(!codes(ok).includes('flushFast') && !codes(ok).includes('flushSlow'), codes(ok).join());
  const fast = setUp(24); push(fast, 0.4, 0.1);    // 4 mL/s on a 24G
  assert.ok(codes(fast).includes('flushFast'));
  const big = setUp(20); push(big, 0.6, 0.1);      // 6 mL/s on a 20G (rated 10)
  assert.ok(!codes(big).includes('flushFast') && !codes(big).includes('flushSlow'), codes(big).join());
  const slow = setUp(22); push(slow, 0.05, 0.1);   // 0.5 mL/s
  assert.ok(codes(slow).includes('flushSlow') && !codes(slow).includes('flushFast'));
});

test('fishing: missed beside the vein, drawn back and turned toward it, it goes in through the side wall and threads', () => {
  const A = toSkin({ mode: 'practice', site: { lateral: -9 } });
  IV.setPitch(A, 25);
  advanceUntil(A, 26, () => false);                       // straight past, beside the vein
  assert.ok(!A.pierce.front, 'it passed beside the vein');
  IV.advance(A, -(A.needle.s - 1));                        // back to just under the skin
  assert.ok(A.needle.inSkin, 'still in the skin');
  IV.setYaw(A, 25);                                        // swung about the entry, toward the vein
  advanceUntil(A, 30, (a) => a.pierce.front || a.ended);
  assert.ok(A.pierce.front && A.pierce.fromSide, `in through the side: ${A.tip}`);
  assert.ok(!A.ended, A.errors.map((e) => e.code).join());
  advanceUntil(A, 4, (a) => a.flash.level > 0);
  IV.setPitch(A, 10); advanceUntil(A, 4, (a) => a.cathTip === 'lumen');
  IV.setPitch(A, 8);
  for (let i = 0; i < 15 && !A.cath.hubbed; i++) IV.thread(A, 1);
  assert.ok(A.cath.hubbed, 'threaded to the hub');
  assert.ok(!A.errors.some((e) => e.code === 'sideWall'), 'not out through the far side');
});

test('from the side without traction the vein rolls away from the needle', () => {
  const A = toSkin({ mode: 'practice', site: { lateral: -9 } });
  IV.setTraction(A, false);
  IV.setPitch(A, 25); IV.advance(A, 1); IV.setYaw(A, 25);
  advanceUntil(A, 30, (a) => a.pierce.front || a.ended);
  assert.ok(Math.abs(A.vein.dy) > 1, `rolled ${A.vein.dy.toFixed(2)} mm`);
});

test('traction is needed until the vein is punctured, not after', () => {
  const A = toSkin(); IV.setPitch(A, 25);
  advanceUntil(A, 20, (a) => a.flash.level > 0);
  IV.setTraction(A, false);
  assert.ok(!A.errors.some((e) => e.code === 'tractionEarly'), 'let go after the flash: fine');
  const B = toSkin(); IV.setPitch(B, 25); IV.advance(B, 2);
  IV.setTraction(B, false);
  assert.ok(B.errors.some((e) => e.code === 'tractionEarly'), 'let go on the way in: an error');
});

test('the port cap may come off before or after the dressing; out of order costs nothing unless critical', () => {
  const A = toSkin(); IV.setPitch(A, 25);
  advanceUntil(A, 20, (a) => a.flash.level > 0);
  IV.setPitch(A, 12); advanceUntil(A, 4, (a) => a.cathTip === 'lumen');
  IV.setPitch(A, 8);
  for (let i = 0; i < 15 && !A.cath.hubbed; i++) IV.thread(A, 1);
  IV.withdrawNeedle(A, 40); IV.disposeNeedle(A); IV.toggleClamp(A);
  IV.releaseTourniquet(A);
  assert.equal(IV.placeDressing(A, 2).ok, true, 'Guided: the dressing before the port cap');
  [0, 1, 2, 3].forEach((i) => IV.pressEdge(A, i));
  assert.ok(A.done.has('dressing'));
  assert.equal(IV.attachSyringe(A).ok, false, 'but not the syringe');
  assert.equal(IV.removePortCap(A).ok, true);
  assert.equal(IV.attachSyringe(A).ok, true);
  assert.deepEqual(A.errors.map((e) => e.code), []);
  // Practice: a step out of order is flagged, and costs nothing
  const P = IV.createAttempt(cfg, { mode: 'practice' });
  for (const x of cfg.procedure.prep) IV.tickPrep(P, x);
  IV.markSite(P, SITE);                                    // before the tourniquet
  assert.ok(P.errors.some((e) => e.code === 'order'));
  assert.equal(IV.score(P).cat.sequence, cfg.score.weights.sequence);
});

/* ---- the back of the hand --------------------------------------------------------------- */
// a dorsal metacarpal vein: 1.5 mm radius (3 mm across), its top 2 mm under the skin
const HAND = { veinId: 'dm23', lateral: 0, radius: 1.5, depth: 2.0, atValve: false, atJoin: false, roll: 1.0, fragility: 0.7 };
// up to the needle at the skin on a site (by its key in data/iv.json), with a mark of its own
function siteToSkin(site, opts = {}) {
  const A = IV.createAttempt(cfg, { mode: 'guided', gauge: site === 'hand' ? 22 : 20, ...opts, site });
  for (const p of cfg.procedure.prep) IV.tickPrep(A, p);
  IV.applyTourniquet(A, true);
  run(A, 26);
  IV.markSite(A, { ...(site === 'hand' ? HAND : SITE), ...(opts.mark || {}) });
  IV.cleanStroke(A, 1, cfg.procedure.clean.scrubS);
  run(A, cfg.procedure.clean.dryS + 0.2);
  IV.sealSlide(A, 2.5); IV.sealRelease(A);
  IV.setYaw(A, 0);
  IV.setTraction(A, true);
  return A;
}
// in at an angle, lowered on the flash, threaded to the hub
function placed(A, enter, lower, thr) {
  IV.setPitch(A, enter);
  advanceUntil(A, 30, (a) => a.flash.level > 0);
  IV.setPitch(A, lower); advanceUntil(A, 4, (a) => a.cathTip === 'lumen');
  IV.setPitch(A, thr);
  for (let i = 0; i < 20 && !A.cath.hubbed; i++) IV.thread(A, 1);
  return A;
}
// on through the clamp, port, tourniquet, dressing and syringe to the pull-back
function toFlush(A) {
  IV.setTraction(A, false); IV.withdrawNeedle(A, 40); IV.disposeNeedle(A);
  IV.toggleClamp(A); IV.removePortCap(A); IV.releaseTourniquet(A);
  IV.placeDressing(A, 2); [0, 1, 2, 3].forEach((i) => IV.pressEdge(A, i));
  IV.attachSyringe(A); IV.twistSyringe(A, 90); IV.toggleClamp(A);
  IV.aspirate(A, 0.5);
  return A;
}
const codes = (A) => A.errors.map((e) => e.code);

test('the hand: a textbook attempt at 12°, flat on the flash, a slow flush, runs with nothing logged', () => {
  const A = placed(siteToSkin('hand'), 12, 6, 6);
  assert.ok(A.cath.hubbed, codes(A).join());
  assert.equal(A.needle.pitchAtPuncture, 12);
  toFlush(A);
  for (let i = 0; i < 200 && !A.done.has('flush'); i++) { IV.flush(A, 0.12, 0.1); IV.update(A, 0.1); }   // 1.2 mL/s
  IV.toggleClamp(A); IV.twistSyringe(A, -90); IV.attachCap(A); IV.twistCap(A, 90);
  assert.ok(A.finished, `finished at ${IV.currentStep(A)}`);
  assert.deepEqual(codes(A), []);
  const s = IV.score(A);
  assert.ok(s.pass && s.total >= 95, JSON.stringify(s));
});

test('the hand comes in at 10-15°: an arm\'s 25° is too steep there, and its 12° would flatten an arm vein', () => {
  assert.deepEqual([IV.createAttempt(cfg, { site: 'hand' }).P.angles.pierceMin, IV.createAttempt(cfg, { site: 'hand' }).P.angles.pierceMax], [10, 15]);
  assert.equal(IV.createAttempt(cfg, { site: 'forearm' }).P.angles.pierceMin, 15, 'the arm sites keep 15-30°');
  const steep = siteToSkin('hand'); IV.setPitch(steep, 25);
  advanceUntil(steep, 20, (a) => a.pierce.front);
  assert.ok(codes(steep).includes('tooSteep'), codes(steep).join());
  const arm = siteToSkin('antecubital'); IV.setPitch(arm, 25);
  advanceUntil(arm, 20, (a) => a.pierce.front);
  assert.ok(arm.pierce.front && !codes(arm).includes('tooSteep'), codes(arm).join());
  // at 12° the hand vein, pinned on its bed, pierces clean; an arm vein is flattened through both walls
  const hand12 = siteToSkin('hand'); IV.setPitch(hand12, 12);
  advanceUntil(hand12, 30, (a) => a.pierce.front);
  assert.ok(hand12.pierce.front && !hand12.ended && hand12.vein.flat < 0.4, `${codes(hand12)} flat ${hand12.vein.flat.toFixed(2)}`);
  const arm12 = siteToSkin('antecubital'); IV.setPitch(arm12, 12);
  advanceUntil(arm12, 40, (a) => a.pierce.front);
  assert.ok(codes(arm12).includes('doubleWall'));
  // and flatter still, the hand vein goes the same way
  const flat = siteToSkin('hand'); IV.setPitch(flat, 6);
  advanceUntil(flat, 40, (a) => a.pierce.front);
  assert.ok(codes(flat).includes('doubleWall'), codes(flat).join());
});

test('a hand vein leaves half the room an arm vein does between the flash and the back wall', () => {
  const room = (site) => {
    const A = siteToSkin(site); IV.setPitch(A, 25);
    advanceUntil(A, 30, (a) => a.flash.level > 0);
    const s0 = A.needle.s;
    for (let i = 0; i < 400 && !A.pierce.back; i++) IV.advance(A, 0.1);
    assert.ok(A.pierce.back, site);
    return A.needle.s - s0;
  };
  const hand = room('hand'), arm = room('antecubital');
  assert.ok(hand < 0.6 * arm, `hand ${hand.toFixed(1)} mm, arm ${arm.toFixed(1)} mm`);
});

test('the hand: lowered on the flash means almost flat, 8° or under', () => {
  const A = siteToSkin('hand'); IV.setPitch(A, 12);
  advanceUntil(A, 30, (a) => a.flash.level > 0);
  advanceUntil(A, 2, () => false);                         // on at 12°: fine on the arm, not here
  assert.ok(codes(A).includes('notLowered'), codes(A).join());
});

test('a hand vein rolls further than an arm vein off the same mark when the skin is let go', () => {
  // the same vein and mark on both: only the site's looseness differs. The needle just in the
  // skin, the traction let go, two seconds
  const roll = (site) => {
    const A = siteToSkin(site, { mode: 'practice', mark: { ...SITE, lateral: 1.5, roll: 1 } });
    IV.setPitch(A, 20); IV.advance(A, 1);
    IV.setTraction(A, false); run(A, 2);
    return Math.abs(A.vein.dy);
  };
  const hand = roll('hand'), arm = roll('antecubital');
  assert.ok(hand > 1.4 * arm, `hand ${hand.toFixed(2)} mm, arm ${arm.toFixed(2)} mm`);
});

test('the line\'s limit: a hand vein takes 1.5 mL/s whatever the gauge; the arm the gauge\'s rating', () => {
  const lim = (site, gauge) => IV.rateLimit(IV.createAttempt(cfg, { site, gauge }));
  assert.equal(lim('hand', 22), 1.5); assert.equal(lim('hand', 24), 1.5); assert.equal(lim('hand', 20), 1.5);
  assert.equal(lim('antecubital', 22), 6.5); assert.equal(lim('forearm', 20), 10); assert.equal(lim('antecubital', 24), 3);
  // pushed at 3 mL/s: logged, and the fragile vein leaks round the catheter until it shows
  const fast = toFlush(placed(siteToSkin('hand', { mode: 'practice' }), 12, 6, 6));
  for (let i = 0; i < 200 && !fast.done.has('flush') && !fast.ended; i++) IV.flush(fast, 0.3, 0.1);
  assert.ok(codes(fast).includes('flushFast') && codes(fast).includes('infiltration'), codes(fast).join());
  assert.ok(fast.ended, 'infiltration ends the attempt');
  // the same push into a 22 G in the arm is within its rating
  const arm = toFlush(placed(siteToSkin('antecubital', { mode: 'practice', gauge: 22 }), 25, 12, 8));
  for (let i = 0; i < 200 && !arm.done.has('flush'); i++) IV.flush(arm, 0.3, 0.1);
  assert.ok(arm.done.has('flush') && !codes(arm).includes('flushFast') && arm.infiltration === 0, codes(arm).join());
  // and the hand under its limit is clean (0.5 mL/s is slow enough for it)
  const slow = toFlush(placed(siteToSkin('hand', { mode: 'practice' }), 12, 6, 6));
  for (let i = 0; i < 400 && !slow.done.has('flush'); i++) IV.flush(slow, 0.06, 0.1);
  assert.ok(slow.done.has('flush') && !codes(slow).includes('flushSlow') && slow.infiltration === 0, codes(slow).join());
});

test('choosing the site on the hand: a 20 G, a joint under the catheter, the radial nerve, a valve ahead', () => {
  const mark = (site, gauge, extra) => {
    const A = IV.createAttempt(cfg, { mode: 'practice', site, gauge });
    return IV.markSite(A, { ...HAND, ...extra }).reasons;
  };
  assert.deepEqual(mark('hand', 22, {}), []);
  assert.deepEqual(mark('hand', 24, {}), []);
  assert.deepEqual(mark('hand', 20, {}), ['gaugeLarge']);
  assert.deepEqual(mark('antecubital', 20, {}), [], 'a 20 G is the arm\'s own');
  // the catheter (25 mm) laid up the vein reaches the wrist 10 mm on; on the knuckle itself; clear
  assert.deepEqual(mark('hand', 22, { jointMM: 10 }), ['siteJoint']);
  assert.deepEqual(mark('hand', 22, { jointMM: 0 }), ['siteJoint']);
  assert.deepEqual(mark('hand', 22, { jointMM: 30 }), []);
  assert.deepEqual(mark('hand', 22, { nerve: true }), ['siteNerve']);
  assert.deepEqual(mark('hand', 22, { valveAheadMM: 15 }), ['valveAhead']);
  assert.deepEqual(mark('hand', 22, { valveAheadMM: 30 }), []);
  // (on the valve itself it is the valve that is named)
  assert.deepEqual(mark('hand', 22, { valveAheadMM: 2, atValve: true }), ['siteValve']);
  // the site's avoid zones are where the hand model's own landmarks put them
  const zones = cfg.sites.hand.avoid;
  const knuckle = zones.find((z) => /knuckle/i.test(z.label)), wrist = zones.find((z) => /^the wrist/i.test(z.label));
  assert.ok(knuckle.along[1] > -2.12 && knuckle.along[1] < -1, 'the 3rd MCP knuckle (along -2.1) is in the knuckle zone');
  assert.ok(wrist.along[0] > 4.1 && wrist.along[0] < 5.37, 'the wrist zone starts past the midcarpal (4.1), before the radial styloid (5.4)');
});

test('a valve ahead stops the threading catheter; forced on, it is logged', () => {
  const A = placed(siteToSkin('hand', { mode: 'practice', mark: { valveAheadMM: 14 } }), 12, 6, 6);
  assert.ok(codes(A).includes('valveAhead'), 'marked short of a valve');
  assert.ok(codes(A).includes('valveHit') && A.cath.hubbed, codes(A).join());
  assert.ok(A.log.some((e) => e.type === 'valveForced'));
  const B = placed(siteToSkin('hand', { mode: 'practice', mark: { valveAheadMM: 40 } }), 12, 6, 6);
  assert.ok(B.cath.hubbed && !codes(B).includes('valveHit'), codes(B).join());
});

test('probing hurts, the hand three times the arm: the patient flinches, and a loose hand takes the vein', () => {
  const probe = (site, traction, mm) => {
    const A = siteToSkin(site, { mode: 'practice', mark: { lateral: 0.5 } });
    IV.setTraction(A, traction);
    IV.setPitch(A, site === 'hand' ? 12 : 22);
    IV.advance(A, 8);
    const dy = A.vein.dy;
    for (let i = 0; i < mm; i++) { IV.advance(A, -1); IV.advance(A, 1); }   // back and on, 1 mm at a time
    return { A, shift: Math.abs(A.vein.dy - dy) };
  };
  const hand = probe('hand', true, 6), arm = probe('antecubital', true, 6);
  assert.ok(codes(hand.A).includes('flinch'), `hand: pain ${hand.A.pain.toFixed(2)}`);
  assert.ok(!codes(arm.A).includes('flinch'), `arm: pain ${arm.A.pain.toFixed(2)}`);
  assert.ok(hand.shift < 0.01, 'held firm, the hand stays put');
  const loose = probe('hand', false, 6);
  assert.ok(codes(loose.A).includes('flinch') && loose.shift > 2, `loose: ${loose.shift.toFixed(2)} mm`);
  // the arm too, probed long enough
  assert.ok(codes(probe('antecubital', true, 25).A).includes('flinch'));
});

test('the site\'s words: the hand\'s tourniquet above the wrist, its angles in the steps and the tips', () => {
  const hand = IV.createAttempt(cfg, { site: 'hand' }), arm = IV.createAttempt(cfg, { site: 'antecubital' });
  const step = (A, id) => IV.stepText(A, IV.stepIndex(id)).do;
  assert.match(step(hand, 'tourniquet'), /wrist/); assert.match(step(arm, 'tourniquet'), /elbow/);
  assert.match(step(hand, 'insert'), /10-15°/); assert.match(step(arm, 'insert'), /15-30°/);
  assert.match(step(hand, 'flush'), /0\.5-1\.5 mL\/s/); assert.match(step(arm, 'flush'), /1-10 mL\/s/);
  assert.match(IV.errorText(hand, 'tooShallow').tip, /10-15°/);
  assert.match(IV.errorText(hand, 'tqBelowElbow').msg, /wrist/);
  assert.match(IV.errorText(arm, 'tqBelowElbow').msg, /elbow/);
  // every {name} in the data and the errors is filled, for every site
  for (const site of Object.keys(cfg.sites)) {
    const A = IV.createAttempt(cfg, { site });
    for (let i = 0; i < IV.STEP_IDS.length; i++) assert.ok(!/\{\w+\}/.test(IV.stepText(A, i).do), `${site} ${IV.STEP_IDS[i]}`);
    for (const c of Object.keys(IV.ERRORS)) assert.ok(!/\{\w+\}/.test(IV.errorText(A, c).tip + IV.errorText(A, c).msg), `${site} ${c}`);
  }
  // and the error as logged is in the site's words
  const B = IV.createAttempt(cfg, { site: 'hand', mode: 'practice' });
  for (const p of cfg.procedure.prep) IV.tickPrep(B, p);
  IV.applyTourniquet(B, false);
  assert.match(B.errors.find((e) => e.code === 'tqBelowElbow').msg, /wrist/);
});

test('gone in far before the flash shows, lowering the angle completes the flashback step', () => {
  const A = toSkin(); IV.setPitch(A, 25);
  // advance with no time passing: the catheter is in before the flash has had time to show
  for (let i = 0; i < 80 && A.cathTip !== 'lumen'; i++) IV.advance(A, 0.2);
  run(A, 0.5);
  assert.ok(A.flash.level > 0 && A.cathTip === 'lumen' && !A.done.has('flash'));
  IV.setPitch(A, 12);
  assert.ok(A.done.has('flash'), 'lowered: the step is done');
  assert.equal(IV.currentStep(A), 'thread');
});
