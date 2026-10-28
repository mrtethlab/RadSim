// The Protocol Trainer's pathology (core/pathology.js), stamped into the real volumes and taken
// out again. The anatomy and the physics of the films are checked in the running app; what is
// held here is what must never break: every requisition's id has an entry, every stamp comes out
// byte for byte, a fracture breaks one bone and only that bone, gravity decides where the fluid
// goes, and a lesion touches a bounded part of the volume in a bounded time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PATHOLOGY, makeCtx, stampPathology, undoPathology, boneNear, fracturePlane, bowelFluid, BONE } from '../src/core/pathology.js';
import { PATHOLOGY_IDS } from '../src/trainer/hospitalProtocols.js';

const json = (f) => JSON.parse(readFileSync(new URL(`../src/data/${f}.json`, import.meta.url), 'utf8'));
const LM = json('landmarks'), CP = json('centring'), JT = json('joints');
const ROLLED = new Set(['chestabdopelvis', 'headneck']);          // app.js ROLLED_180
function model(sub) {
  const hdr = JSON.parse(readFileSync(new URL(`../public/models/${sub}/${sub}.model.json`, import.meta.url), 'utf8'));
  const data = new Uint8Array(readFileSync(new URL(`../public/models/${sub}/${hdr.volume}`, import.meta.url)));
  const vol = { data, dims: hdr.dims, spacingMM: hdr.spacing };
  const flips = ROLLED.has(sub) ? [false, false, false] : [true, true, false];
  return { vol, ctx: makeCtx(sub, vol, { landmarks: LM[sub] || {}, centring: CP[sub] || {}, joints: JT[sub] || {}, flips }) };
}
const same = (a, b) => { if (a.length !== b.length) return false; for (let q = 0; q < a.length; q++) if (a[q] !== b[q]) return false; return true; };

test('every requisition pathology has a catalogue entry on the same subject', () => {
  for (const [id, sub] of Object.entries(PATHOLOGY_IDS)) {
    const P = PATHOLOGY[id];
    assert.ok(P, `${id} is catalogued`);
    assert.equal(P.subject, sub, `${id} is drawn on ${sub}`);
    assert.ok(P.label, `${id} has a label`);
    if (P.available === false) assert.ok(P.why, `${id} says why it is unavailable`);
    else assert.equal(typeof P.build, 'function', `${id} can be drawn`);
  }
});

/* Each subject loaded once; every lesion on it stamped, measured and taken out. Limits: a
   fracture moves a few cm of one bone (under 120 000 voxels), the soft-tissue and lung lesions
   a hemithorax or the bowel (under 2.5 M), and none takes more than 1.5 s here. */
const subjects = [...new Set(Object.values(PATHOLOGY_IDS))];
for (const sub of subjects) {
  test(`${sub}: each lesion comes out exactly, touches a bounded box, in bounded time`, (t) => {
    const { vol, ctx } = model(sub);
    const scanned = vol.data.slice();
    const big = new Set(['pneumothorax', 'effusion', 'pneumonia', 'sbo', 'fecalLoading', 'castWrist']);
    for (const [id, P] of Object.entries(PATHOLOGY)) {
      if (P.subject !== sub) continue;
      const opts = { force: true };
      if (P.available === false && !P.build) { assert.equal(stampPathology(vol, id, ctx, {}), null); continue; }
      if (P.available === false) assert.equal(stampPathology(vol, id, ctx, {}), null, `${id} unavailable stamps nothing`);
      const u = stampPathology(vol, id, ctx, opts);
      assert.ok(u && u.idx.length > 0, `${id} changes the volume`);
      assert.equal(u.idx.length, u.old.length);
      // the record is the change: every recorded voxel differs from its old value
      for (let q = 0; q < u.idx.length; q += 97) assert.notEqual(vol.data[u.idx[q]], u.old[q]);
      const cap = big.has(id) ? 2.5e6 : 1.2e5;
      assert.ok(u.idx.length < cap, `${id} touched ${u.idx.length} voxels (cap ${cap})`);
      assert.ok(u.ms < 1500, `${id} took ${u.ms.toFixed(0)} ms`);
      // nothing written over cartilage
      for (let q = 0; q < u.old.length; q++) if (u.old[q] === 16) assert.fail(`${id} wrote over cartilage`);
      undoPathology(vol, u);
      assert.ok(same(vol.data, scanned), `${id} comes out byte for byte`);
      t.diagnostic(`${id}: ${u.idx.length} voxels, ${u.ms.toFixed(0)} ms`);
    }
  });
}

test('a stamp on the wrong subject is refused', () => {
  const vol = { data: new Uint8Array(8), dims: [2, 2, 2], spacingMM: [1, 1, 1] };
  assert.throws(() => stampPathology(vol, 'distalRadiusFx', makeCtx('chest', vol), {}), /belongs to hand/);
});

/* Two long bones side by side, a voxel apart and bridged over a few slices (the contact two
   bones make in a coarse segmentation): a fracture near the first must not touch the second. */
test('a fracture breaks the bone it is anchored in and no other', () => {
  const dims = [48, 40, 80], sp = [1, 1, 1], n = dims[0] * dims[1] * dims[2];
  const data = new Uint8Array(n).fill(10);
  const at = (i, j, k) => (k * dims[1] + j) * dims[0] + i;
  const A = [16, 20], Bc = [29, 20], R = 6;
  const owner = new Uint8Array(n);                               // 1: bone A, 2: bone B
  for (let k = 5; k < 75; k++) for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) {
    for (const [c, tag] of [[A, 1], [Bc, 2]]) {
      const r = Math.hypot(i - c[0], j - c[1]);
      if (r <= R) { owner[at(i, j, k)] = tag; if (r > R - 2) data[at(i, j, k)] = 18; else data[at(i, j, k)] = 17; }
    }
  }
  for (let k = 35; k < 45; k++) data[at(22, 20, k)] = 18;          // the bridge between them
  const vol = { data, dims, spacingMM: sp };
  const before = data.slice();
  const comp = boneNear(vol, [16 * 0.1, 20 * 0.1, 40 * 0.1], { r: 2.5, erodeCm: 0.15 });
  assert.ok(comp, 'the anchored bone is found');
  // (where the search ball cuts the bones' ends the eroded cores thin out, and a contact voxel
  // there can go either way: a handful at most, and far from any fracture)
  const strays = comp.list.filter((o) => owner[o] === 2).length;
  assert.ok(strays < 0.002 * comp.list.length, `${strays} voxels of the other bone in the component`);
  const edits = { set(o, v) { data[o] = v; } };
  fracturePlane(edits, vol, comp, { p0: [1.6, 2.0, 4.0], n: [0, 0, 1], gap: 0.2,
    move: { side: 1, shift: [0.4, 0, 0], falloff: 2 } });     // pushed into the other bone
  let changed = 0;
  for (let q = 0; q < n; q++) {
    if (data[q] === before[q]) continue;
    changed++;
    assert.notEqual(owner[q], 2, 'no voxel of the other bone is written');
    assert.ok(!(BONE.has(before[q]) && owner[q] === 0 && data[q] !== before[q]), 'the bridge is left alone');
  }
  assert.ok(changed > 50, `the fracture changed ${changed} voxels`);
});

/* Gravity sets the fluid: erect, each loop's fluid lies under its gas (lower k); supine, behind
   it (toward the back, -j on this synthetic body where +j is anterior). */
test('posture moves the fluid level: under the gas erect, behind it supine', () => {
  const dims = [40, 30, 40], n = dims[0] * dims[1] * dims[2];
  const make = () => {
    const data = new Uint8Array(n).fill(2), list = [];
    for (let k = 10; k < 30; k++) for (let j = 8; j < 22; j++) for (let i = 8; i < 32; i++) { const o = (k * dims[1] + j) * dims[0] + i; data[o] = 51; list.push(o); }
    return { vol: { data, dims, spacingMM: [2, 2, 2] }, list };
  };
  const mean = (vol, list, mat, a) => {
    let s = 0, c = 0;
    for (const o of list) if (vol.data[o] === mat) { const v = [o % dims[0], ((o / dims[0]) | 0) % dims[1], Math.floor(o / (dims[0] * dims[1]))]; s += v[a]; c++; }
    return s / c;
  };
  const edits = (vol) => ({ set(o, v) { vol.data[o] = v; } });
  const er = make(), su = make();
  bowelFluid(edits(er.vol), er.vol, er.list, [0, 0, -1], { loop: [100, 100, 100] });
  bowelFluid(edits(su.vol), su.vol, su.list, [0, -1, 0], { loop: [100, 100, 100] });
  assert.ok(mean(er.vol, er.list, 5, 2) < mean(er.vol, er.list, 47, 2), 'erect: fluid below the gas');
  assert.ok(Math.abs(mean(er.vol, er.list, 5, 1) - mean(er.vol, er.list, 47, 1)) < 0.5, 'erect: no front-to-back split');
  assert.ok(mean(su.vol, su.list, 5, 1) < mean(su.vol, su.list, 47, 1), 'supine: fluid behind the gas');
  assert.ok(Math.abs(mean(su.vol, su.list, 5, 2) - mean(su.vol, su.list, 47, 2)) < 0.5, 'supine: no level up the body');
});

test('on the abdomen model the obstruction\'s fluid falls with gravity, and the effusion with it', () => {
  const { vol, ctx } = model('chestabdopelvis');
  const T = ctx.trunk();
  const [nx, ny] = vol.dims;
  const centre = (u, mat) => {
    let s = [0, 0, 0], c = 0;
    for (let q = 0; q < u.idx.length; q++) {
      const o = u.idx[q]; if (vol.data[o] !== mat) continue;
      s[0] += o % nx; s[1] += ((o / nx) | 0) % ny; s[2] += Math.floor(o / (nx * ny)); c++;
    }
    return s.map((v) => v / c);
  };
  const e = stampPathology(vol, 'sbo', ctx, { posture: 'erect' });
  const eF = centre(e, 5), eG = centre(e, 47);
  undoPathology(vol, e);
  const s = stampPathology(vol, 'sbo', ctx, { posture: 'supine' });
  const sF = centre(s, 5), sG = centre(s, 47);
  undoPathology(vol, s);
  assert.ok(eF[2] < eG[2] - 1, `erect: fluid ${eF[2].toFixed(1)} under gas ${eG[2].toFixed(1)} (k)`);
  const back = (v) => v[1] * T.ant[1];                        // larger is further forward
  assert.ok(back(sF) < back(sG) - 1, 'supine: fluid behind the gas');
  assert.ok(Math.abs(sF[2] - sG[2]) < Math.abs(eF[2] - eG[2]), 'supine: the levels go');
});

test('an effusion lies at the bottom erect and along the back supine', () => {
  const { vol, ctx } = model('chest');
  const T = ctx.trunk();
  const [nx, ny] = vol.dims;
  const c = (u) => { let s = [0, 0, 0]; for (const o of u.idx) { s[0] += o % nx; s[1] += ((o / nx) | 0) % ny; s[2] += Math.floor(o / (nx * ny)); } return s.map((v) => v / u.idx.length); };
  const e = stampPathology(vol, 'effusion', ctx, { side: 'R', posture: 'erect' }); const ce = c(e); undoPathology(vol, e);
  const s = stampPathology(vol, 'effusion', ctx, { side: 'R', posture: 'supine' }); const cs = c(s); undoPathology(vol, s);
  assert.ok(ce[2] < cs[2], `erect it sits lower (k ${ce[2].toFixed(0)} vs ${cs[2].toFixed(0)})`);
  assert.ok(cs[1] * T.ant[1] < ce[1] * T.ant[1], 'supine it lies further back');
  // and on the patient's right: the liver's side
  assert.ok((ce[0] - T.body[0] / (vol.spacingMM[0] / 10)) * T.right[0] > 0, 'on the right');
});

test('a pneumothorax is bigger on expiration', () => {
  const { vol, ctx } = model('chest');
  const i = stampPathology(vol, 'pneumothorax', ctx, { side: 'L' }); undoPathology(vol, i);
  const x = stampPathology(vol, 'pneumothorax', ctx, { side: 'L', expiration: true }); undoPathology(vol, x);
  assert.ok(x.info.airMl > 1.2 * i.info.airMl, `expiration ${x.info.airMl} ml against ${i.info.airMl} ml`);
});
