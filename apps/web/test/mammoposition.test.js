// Mammographic positioning, judged on the film. Two halves: the geometric judge on synthetic films
// whose answers are known in closed form (the PNL is a perpendicular, the muscle's reach is a
// distance along it, the fold is a gap), then the real phantom cast through the console's own
// projector, where a well-placed pair must grade Perfect and each named error must cost the
// criterion it is supposed to cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { measureView, judgeView, pgmi, edgeLossCm, imfGapCm, nippleTiltDeg, mloPecLossCm,
  patientFor, POS_DEFAULT } from '../src/core/mammoPosition.js';
import { castMammo, positionedData } from '../src/mammo.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* A synthetic film on the console's detector (23 x 14.6 cm, chest-wall edge at row 0). Every
   shape is a function of detector cm: the breast outline, the muscle's border, the nipple disc,
   an abdomen region. */
function film({ view = 'mlo', nx = 470, ny = 300, half = 7, depth = 10, shift = () => 0,
  border = null, nip = { u: 0, y: 10.25, r: 0.35 }, abd = null, wide = 0 } = {}) {
  const fovX = 23, fovY = 14.6, N = nx * ny;
  const m = { view, nx, ny, fovX, fovY, breast: new Float32Array(N), muscle: new Float32Array(N),
    nipple: new Float32Array(N), abdomen: view === 'mlo' ? new Float32Array(N) : null };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const u = ((i + 0.5) / nx - 0.5) * fovX, y = (j + 0.5) * fovY / ny, k = j * nx + i;
    const h = half + wide;
    const out = Math.abs(u) < h ? depth * Math.sqrt(1 - (u / h) ** 2) - shift(u) : -1;
    if (y < out) m.breast[k] = 4;
    if (border && y < border(u) && y < out) m.muscle[k] = 3;
    if ((u - nip.u) ** 2 + (y - nip.y) ** 2 < nip.r ** 2) m.nipple[k] = 0.5;
    if (abd && abd(u, y)) m.abdomen[k] = 4;
  }
  return m;
}
// where the judge's reach should land: the PNL's foot on the border, less the border's measured
// tip (the first column at least 2 px deep), along the line
const PX = 14.6 / 300;
const reachOf = (b, u0, yn = 10.25) => ((b * (yn + b * u0)) / (1 + b * b) - (u0 + 2 * PX / b)) * Math.hypot(1, b);
// the muscle: a straight border y = b (u - u0) from its tip at u0 up toward the axilla (+u)
const line = (b, u0, bulge = 0, u1 = 7) => (u) => (u < u0 ? 0
  : b * (u - u0) + bulge * Math.sin(Math.PI * Math.min(1, (u - u0) / (u1 - u0))));

test('the MLO PNL is the perpendicular from the nipple to the pectoral border', () => {
  const b = 0.5, u0 = 1;
  const m = measureView(film({ border: line(b, u0) }));
  // the nipple's centroid sits at (0, 10.25); the border y = b(u - 1): distance |b·0 - y - b| / sqrt(1+b²)
  const expect = Math.abs(-b * u0 - 10.25) / Math.hypot(1, b);
  assert.ok(near(m.pnl.cm, expect, 0.08), `PNL ${m.pnl.cm.toFixed(2)} vs ${expect.toFixed(2)}`);
  assert.ok(m.pnl.toMuscle);
  // the foot lies (u_F - u_tip)·sqrt(1+b²) up the border from its tip: the muscle runs past it
  assert.ok(near(m.pnl.reachCm, reachOf(b, u0), 0.08), `reach ${m.pnl.reachCm.toFixed(2)} vs ${reachOf(b, u0).toFixed(2)}`);
  assert.ok(near(m.muscle.angleDeg, Math.atan(b) * 180 / Math.PI, 1.0), `angle ${m.muscle.angleDeg.toFixed(1)}`);
  const j = judgeView(m);
  assert.equal(j.items.find((it) => it.key === 'pec').sev, 0);
});

test('a muscle that stops above the PNL is graded by how far short it falls', () => {
  // the same slope, beginning higher: its tip lands above the foot of the perpendicular
  const m = measureView(film({ border: line(0.5, 5.3) }));
  assert.ok(reachOf(0.5, 5.3) < 0 && near(m.pnl.reachCm, reachOf(0.5, 5.3), 0.12), `reach ${m.pnl.reachCm.toFixed(2)}`);
  assert.equal(judgeView(m).items.find((it) => it.key === 'pec').sev, 1);
  const far = measureView(film({ border: line(0.5, 7.4, 0, 9) , wide: 2 }));
  assert.ok(near(far.pnl.reachCm, reachOf(0.5, 7.4), 0.15) && far.pnl.reachCm < -2,`reach ${far.pnl.reachCm.toFixed(2)}`);
  assert.equal(judgeView(far).items.find((it) => it.key === 'pec').sev, 3);
  // no muscle at all: the PNL runs to the film edge, and the view cannot pass
  const none = measureView(film());
  assert.equal(none.muscle, null);
  assert.ok(near(none.pnl.cm, 10.25, 0.06));
  assert.equal(judgeView(none).grade, 'I');
});

test('a PNL that meets the film edge before the muscle stops there', () => {
  // a flat, short muscle: the perpendicular's foot lies behind the chest-wall edge
  const m = measureView(film({ border: line(0.15, 6) }));
  assert.equal(m.pnl.toMuscle, false);
  assert.ok(near(m.pnl.to[1], 0, 1e-9));
  assert.ok(m.pnl.cm < 10.25 / Math.cos(Math.atan(0.15)) + 0.05);
});

test('the pectoral border reads convex, straight or concave', () => {
  const shape = (bulge) => measureView(film({ border: line(0.5, 1, bulge, 6.6) })).muscle;
  assert.equal(shape(0.5).shape, 'convex');
  assert.equal(shape(0).shape, 'straight');
  const cc = shape(-0.5);
  assert.equal(cc.shape, 'concave');
  const m = measureView(film({ border: line(0.5, 1, -0.5, 6.6) }));
  assert.ok(judgeView(m).items.find((it) => it.key === 'shape').sev >= 1);
});

test('the nipple is in profile only when it stands clear of the skin line', () => {
  const out = measureView(film({ border: line(0.5, 1) }));
  assert.ok(out.nipple.inProfile, `profile ${out.nipple.profile}`);
  const rolled = measureView(film({ border: line(0.5, 1), nip: { u: 0.5, y: 8.8, r: 0.35 } }));
  assert.equal(rolled.nipple.inProfile, false);
  assert.ok(near(rolled.nipple.insideCm, 10 * Math.sqrt(1 - (0.5 / 7) ** 2) - 8.8, 0.1));
  assert.equal(judgeView(rolled).items.find((it) => it.key === 'nipple').sev, 2);
});

test('the inframammary fold: open when the abdomen stands clear, a skin fold when it overlaps', () => {
  const at = (uA) => (u, y) => u < uA - 0.9 * y;
  const open = measureView(film({ border: line(0.5, 1), abd: at(-7.6) }));
  assert.ok(near(open.imf.gapCm, 0.6, 0.12), `gap ${open.imf.gapCm}`);
  assert.equal(open.imf.overlapCm2, 0);
  assert.equal(judgeView(open).items.find((it) => it.key === 'imf').sev, 0);
  const sag = measureView(film({ border: line(0.5, 1), abd: at(-6.2) }));
  assert.ok(sag.imf.gapCm < -0.4 && sag.imf.overlapCm2 > 0, JSON.stringify(sag.imf));
  assert.equal(judgeView(sag).items.find((it) => it.key === 'imf').sev, 2);
});

test('tissue running off a side of the film is cut off, and the view is inadequate', () => {
  const m = measureView(film({ border: line(0.5, 1), wide: 6 }));
  assert.ok(m.cutoff.length >= 1, JSON.stringify(m.cutoff));
  assert.equal(judgeView(m).grade, 'I');
});

test('the CC: PNL to the edge, judged within 1 cm of the MLO, and the medial tissue', () => {
  const mlo = measureView(film({ border: line(0.5, 1) }));
  const cc = (ny, shift) => measureView(film({ view: 'cc', nip: { u: 0, y: ny, r: 0.35 }, depth: ny - 0.25, shift }));
  const good = cc(9.9);
  assert.ok(near(good.pnl.cm, 9.9, 0.06));
  const jg = judgeView(good, mlo).items.find((it) => it.key === 'pnl');
  assert.equal(jg.sev, 0, jg.value);
  // 1.7 cm short of the MLO's: the CC left posterior tissue on the chest wall
  const short = judgeView(cc(mlo.pnl.cm - 1.7), mlo);
  assert.equal(short.items.find((it) => it.key === 'pnl').sev, 2);
  assert.equal(short.grade, 'M');
  // no MLO yet: the criterion waits, and the grade says it is provisional
  const alone = judgeView(good);
  assert.equal(alone.items.find((it) => it.key === 'pnl').sev, null);
  assert.ok(alone.provisional);
  // an MLO whose PNL stops at the film edge cannot vouch for the CC
  const shortMlo = measureView(film({ border: line(0.15, 6) }));
  assert.ok(judgeView(cc(shortMlo.pnl.cm), shortMlo).items.find((it) => it.key === 'pnl').sev >= 1);
  // rotated laterally: the medial (-u) posterior tissue is left behind
  const rot = cc(9.9, (u) => (u < 0 ? -0.5 * u : 0));
  assert.ok(rot.ml.medDeficitCm > 1.0, `deficit ${rot.ml.medDeficitCm.toFixed(2)}`);
  assert.ok(judgeView(rot, mlo).items.find((it) => it.key === 'medial').sev >= 1);
  assert.equal(judgeView(good, mlo).items.find((it) => it.key === 'medial').sev, 0);
});

test('PGMI: the worst criterion sets the grade, and three minors make a Moderate', () => {
  const g = (...s) => pgmi(s.map((sev) => ({ sev })));
  assert.equal(g(0, 0, -1, null), 'P');
  assert.equal(g(0, 1), 'G');
  assert.equal(g(1, 1), 'G');
  assert.equal(g(1, 1, 1), 'M');
  assert.equal(g(0, 2), 'M');
  assert.equal(g(1, 3), 'I');
});

test('the placement model: what each manoeuvre buys', () => {
  const pat = patientFor('demo');
  const cc = { pull: 0.5, lift: pat.imfOpt, rot: 0, roll: 0 };
  // pulling forward leaves less behind, everywhere
  assert.ok(edgeLossCm('cc', { ...cc, pull: 0.9 }, pat, 0) < edgeLossCm('cc', cc, pat, 0));
  // the CC receptor belongs at the fold's natural height: too low and too high both cost
  assert.ok(edgeLossCm('cc', { ...cc, lift: 0.2 }, pat, 0) > edgeLossCm('cc', cc, pat, 0));
  assert.ok(edgeLossCm('cc', { ...cc, lift: 1.0 }, pat, 0) > edgeLossCm('cc', cc, pat, 0));
  // rotated laterally (rot < 0): the medial side (-u) loses, the lateral side gains
  const lat = { ...cc, rot: -0.5 };
  assert.ok(edgeLossCm('cc', lat, pat, -4) > edgeLossCm('cc', lat, pat, 4));
  // the C-arm: matched costs nothing extra, and the cost grows with the square of the error
  const m = { pull: 0.9, lift: 0.7, angle: pat.pecDeg, roll: 0 };
  const d = (a) => mloPecLossCm({ ...m, angle: a }, pat) - mloPecLossCm(m, pat);
  assert.ok(near(d(pat.pecDeg + 10), 4 * d(pat.pecDeg + 5), 1e-9) && d(pat.pecDeg - 10) > 0.5);
  // the fold opens as the breast is lifted
  assert.ok(imfGapCm({ lift: 0.3 }) < 0 && imfGapCm({ lift: 0.8 }) > 0);
  // the roll that brings a drooping nipple back into profile
  const C = patientFor('C');
  assert.ok(Math.abs(nippleTiltDeg('cc', { roll: -C.nipDeg / 25 }, C)) < 1e-9);
  assert.ok(Math.abs(nippleTiltDeg('cc', { roll: 0 }, C)) > 15);
});

/* ---- the real phantom, through the console's projector ------------------------------ */
const root = new URL('../public/models/breast/', import.meta.url);
const hdr = JSON.parse(readFileSync(new URL('breast.model.json', root)));
const vm = { dims: hdr.dims, vs: hdr.spacing.map((s) => s / 10), data: new Uint8Array(readFileSync(new URL(hdr.volume, root))),
  extentMM: hdr.dims.map((n, k) => n * hdr.spacing[k]) };
function shoot(view, pos, caseId = 'demo') {
  const pat = patientFor(caseId), angleDeg = view === 'mlo' ? pos.angle : 45;
  const data = positionedData(vm, view, pat, nippleTiltDeg(view, pos, pat), angleDeg, pos);
  // quarter resolution: the landmarks are centimetres, the pixels a millimetre
  const r = castMammo({ vm, data, view, angleDeg, c: 4.0 / 7.2, E: [16, 17.5, 19.6], w: [0.32, 0.45, 0.23],
    photons0: 54000, finds: [], pos, pat, seed: 7, NX: 235, NY: 150 });
  return measureView({ view, nx: r.NX, ny: r.NY, fovX: r.fovX, fovY: r.fovY, ...r.maps });
}
const pat = patientFor('demo');
const BEST = { cc: { pull: 1, lift: pat.imfOpt, rot: 0.05, roll: 0 }, mlo: { pull: 1, lift: 0.8, angle: pat.pecDeg, roll: 0 } };
const bestMlo = shoot('mlo', BEST.mlo), bestCc = shoot('cc', BEST.cc);

test('the phantom, well placed: both views Perfect, and the PNLs agree', () => {
  const jm = judgeView(bestMlo, bestCc), jc = judgeView(bestCc, bestMlo);
  assert.equal(jm.grade, 'P', JSON.stringify(jm.items.map((i) => [i.key, i.sev, i.value])));
  assert.equal(jc.grade, 'P', JSON.stringify(jc.items.map((i) => [i.key, i.sev, i.value])));
  assert.ok(bestMlo.pnl.toMuscle && bestMlo.pnl.cm > 8.5 && bestMlo.pnl.cm < 11.5, `MLO PNL ${bestMlo.pnl.cm}`);
  assert.ok(Math.abs(bestCc.pnl.cm - bestMlo.pnl.cm) <= 1, `CC ${bestCc.pnl.cm} MLO ${bestMlo.pnl.cm}`);
  assert.equal(bestMlo.muscle.shape, 'convex');
});

test('the phantom, as first placed: the MLO loses its muscle and the fold sags', () => {
  const m = shoot('mlo', POS_DEFAULT.mlo);
  const j = judgeView(m);
  assert.ok(j.items.find((it) => it.key === 'pec').sev >= 2);
  assert.ok(j.items.find((it) => it.key === 'imf').sev >= 1);
  assert.ok(m.pnl.cm < bestMlo.pnl.cm - 1, `${m.pnl.cm} vs ${bestMlo.pnl.cm}`);
  // a CC pulled no better is short against the well-placed MLO
  const c = shoot('cc', POS_DEFAULT.cc);
  assert.ok(judgeView(c, bestMlo).items.find((it) => it.key === 'pnl').sev >= 2);
});

test('the phantom: the C-arm off her muscle by 15 degrees costs the muscle', () => {
  const m = shoot('mlo', { ...BEST.mlo, angle: pat.pecDeg - 15 });
  assert.ok(judgeView(m).items.find((it) => it.key === 'pec').sev >= 2);
});

test('the phantom: a rolled nipple and a lateral rotation on the CC', () => {
  const C = patientFor('C');            // her nipple points down: out of profile unless rolled
  const posC = { pull: 1, lift: C.imfOpt, rot: 0.05, roll: 0 };
  assert.equal(shoot('cc', posC, 'C').nipple.inProfile, false);
  assert.equal(shoot('cc', { ...posC, roll: -C.nipDeg / 25 }, 'C').nipple.inProfile, true);
  const rot = shoot('cc', { ...BEST.cc, rot: -0.6 });
  assert.ok(rot.ml.medDeficitCm > 0.5, `deficit ${rot.ml.medDeficitCm}`);
  assert.ok(judgeView(rot, bestMlo).items.find((it) => it.key === 'medial').sev >= 1);
});
