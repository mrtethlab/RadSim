/* THE INSERTION, BY THE APP'S OWN ENGINE. The film does not invent how the needle meets the vein:
   it runs core/ivSim.js once, at build, on the antecubital site the film shows (the median cubital
   vein under its mark), with a learner's hands scripted (the tourniquet on and the veins full,
   the skin held, in at 25 degrees, stop at the flash, down to 12, on 2 mm, down to 8, thread, the
   needle out), and keeps the state every 1/60 s. The 8-bit sections are drawn from that record:
   the wall tenting under the tip, the pop, the flash when it came, the catheter's tip passing
   the hole, the thread. Times in the record are its own (s); each step maps its time onto it. */
import cfg from '../../../data/iv.json';
import * as IV from '../../../core/ivSim.js';

const DT = 1 / 60;

export function runInsertion({ site = 'antecubital', mark } = {}) {
  const A = IV.createAttempt(cfg, { site, mode: 'practice', gauge: '20' });
  for (const p of A.P.prep) IV.tickPrep(A, p);
  IV.applyTourniquet(A, true);
  for (let i = 0; i < 30 * 60; i++) IV.update(A, DT);          // (the veins fill over 25 s)
  IV.markSite(A, mark);
  IV.cleanStroke(A, 1, A.P.clean.scrubS + 1);
  IV.update(A, DT); IV.update(A, DT);
  IV.sealSlide(A, 2); IV.sealRelease(A, 2);
  IV.setYaw(A, 0);
  IV.setTraction(A, true);
  IV.setPitch(A, 25);
  A.t = 0;
  const rec = [], ev = {};
  const snap = () => {
    const n = A.needle;
    rec.push({
      t: A.t, s: n.s, tip: n.tip.slice(), pitch: n.pitch, cath: IV.catheterTip(A).slice(), dz: A.vein.dz, flat: A.vein.flat,
      tipAt: A.tip, cathAt: A.cathTip, flash: A.flash.level, thread: A.cath.thread, front: A.pierce.front,
      line: A.line.blood, withdrawn: n.withdrawn, shielded: n.shielded, cz: IV.veinCentreZ(A), indent: A.pierce.indent,
    });
  };
  const run = (secs, act) => { for (let i = 0; i < Math.round(secs * 60); i++) { if (act) act(i); IV.update(A, DT); snap(); } };
  snap();
  run(0.5);                                                      // poised over the mark
  // in at 6 mm/s until the bevel is in the lumen
  ev.skin = A.t;
  for (let i = 0; i < 6 * 60 && A.tip !== 'lumen'; i++) {
    IV.advance(A, 6 * DT);
    if (A.pierce.front && ev.pierce == null) ev.pierce = A.t;
    IV.update(A, DT); snap();
  }
  ev.lumen = A.t;
  run(0.9);                                                      // hold: the flash comes
  ev.flash = A.pierce.flashAt;
  // the angle down to 12, over 0.8 s, about the tip
  ev.lowerStart = A.t;
  run(0.8, (i) => IV.setPitch(A, 25 - 13 * Math.min(1, (i + 1) / 48)));
  ev.lowered = A.t;
  // on 2 mm, slowly: the catheter's tip passes the hole in the wall
  run(1.0, () => IV.advance(A, 2 * DT));
  ev.cathIn = A.t;
  run(0.6, (i) => IV.setPitch(A, 12 - 4 * Math.min(1, (i + 1) / 30)));
  // thread: the needle held, the catheter pushed off it (a tick every 0.2 s)
  ev.threadStart = A.t;
  for (let k = 0; k < 40 && !A.cath.hubbed; k++) run(0.2, (i) => { if (i === 0) IV.thread(A, 1); });
  ev.hubbed = A.t;
  run(0.6);
  // the needle back into its shield
  ev.withdrawStart = A.t;
  run(1.6, () => IV.withdrawNeedle(A, 34 / 1.6 * DT));
  ev.out = A.t;
  run(0.5);
  return { rec, ev, P: A.P, mark: A.mark, errors: A.errors.map((e) => e.code), r: A.mark.radius * (1 + A.P.vein.tqSwell * 1) };
}

// the record at time t (held at its ends)
export function at(R, t) {
  const i = Math.max(0, Math.min(R.rec.length - 1, Math.round(t * 60)));
  return R.rec[i];
}
