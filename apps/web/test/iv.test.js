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
  IV.toggleClamp(A);                            // close
  IV.removePortCap(A);
  IV.releaseTourniquet(A);
  IV.placeDressing(A, 2); [0, 1, 2, 3].forEach((i) => IV.pressEdge(A, i));
  IV.attachSyringe(A); IV.twistSyringe(A, 90);
  IV.toggleClamp(A);                            // open
  for (let i = 0; i < 12 && !A.done.has('flush'); i++) { IV.flush(A, 1, 1); IV.update(A, 1); }
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

test('a needle across the vein is a fail: the attempt ends and Assessment cannot pass', () => {
  const A = toSkin({ mode: 'assessment' });
  IV.setYaw(A, 80); IV.setPitch(A, 22);
  IV.advance(A, 0.5);
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
  IV.setTraction(A, false); IV.withdrawNeedle(A, 40);
  IV.toggleClamp(A); IV.removePortCap(A); IV.releaseTourniquet(A);
  IV.placeDressing(A, 2); [0, 1, 2, 3].forEach((i) => IV.pressEdge(A, i));
  IV.attachSyringe(A); IV.twistSyringe(A, 90); IV.toggleClamp(A);
  for (let i = 0; i < 20; i++) { IV.flush(A, 1, 1); IV.update(A, 1); }
  assert.ok(A.syringe.vol <= cfg.procedure.flush.volumeML + 1e-9, `${A.syringe.vol} mL`);
});
