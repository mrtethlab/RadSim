// Long-length (pasting) studies: the angled-tube geometry, the plan of images, and the stitch
// (src/core/pasting.js). The tube stays at its focal spot and only tilts, the bucky tracks the field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { receptorZ, angleTo, focalOf, tiltAbout, magnification, planPasting, tileAngles, anatomicalLength,
         stitchTiles, rulerTicks, fmtCC } from '../src/core/pasting.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

test('a tilt and the receptor position it reaches are inverses; cephalad goes toward the head', () => {
  for (const deg of [-25, -10, 0, 7.5, 20]) close(angleTo(0, 180, receptorZ(0, 180, deg)), deg, 1e-9);
  assert.ok(receptorZ(0, 180, -10) > 0, 'cephalad (negative) lands superior (+z)');
  assert.ok(receptorZ(0, 180, 10) < 0, 'caudad lands inferior');
  close(receptorZ(5, 180, -45), 185, 1e-9, '45 degrees from 180 cm reaches 180 cm along');
});

test('tilting about the focal spot keeps the focal spot where it is', () => {
  // the console's tube frame swings the source on a sphere about the CR's point on the receptor:
  // tiltAbout picks that point and distance so the source lands back on the same focal spot
  const f = { zf: 12, H: 180 };
  for (const deg of [-30, -12, 0, 9, 25]) {
    const t = tiltAbout(f.zf, f.H, deg);
    const back = focalOf(t.tubeZ, t.sid, t.angCC);
    close(back.zf, f.zf, 1e-9, `zf at ${deg}`); close(back.H, f.H, 1e-9, `H at ${deg}`);
    close(t.tubeZ, receptorZ(f.zf, f.H, deg), 1e-9, 'the CR point is where the ray meets the receptor');
    assert.ok(t.sid >= f.H, 'a tilted ray is longer than the perpendicular');
  }
});

test('the number of images: one receptor per 43 cm less the overlap, 2-3 for the usual studies', () => {
  const n = (L) => planPasting({ zUpper: L / 2, zLower: -L / 2 }).n;
  assert.equal(n(40), 1, 'fits one receptor');
  assert.equal(n(43), 1);
  assert.equal(n(60), 2, 'a femur, hip to knee');
  assert.equal(n(82), 2, '2 x 43 - 4 overlap = 82 is the most two images cover');
  assert.equal(n(82.5), 3);
  assert.equal(n(97), 3, 'a leg length, ASIS to the malleolus at 180 cm');
  assert.equal(n(121), 3);
  assert.equal(n(121.5), 4);
  assert.ok(planPasting({ zUpper: 150, zLower: -150 }).tooLong, 'more than five images is refused');
});

test('the tiles cover the limits exactly, superior first, evenly overlapped by at least the minimum', () => {
  for (const [u, l] of [[55, -41.6], [30.8, -28.7], [48.2, -25.3], [10, -60]]) {
    const p = planPasting({ zUpper: u, zLower: l, det: 43, minOverlap: 4 });
    close(p.spanTop, u, 1e-9, 'first image top at the upper limit');
    close(p.spanBot, l, 1e-9, 'last image bottom at the lower limit');
    for (let i = 1; i < p.n; i++) {
      assert.ok(p.centres[i] < p.centres[i - 1], 'superior first');
      const ov = (p.centres[i] + 21.5) - (p.centres[i - 1] - 21.5);
      close(ov, p.overlap, 1e-9, 'every overlap the same');
      assert.ok(ov >= 4 - 1e-9, `overlap ${ov}`);
    }
  }
  // the limits can be accepted in either order
  assert.deepEqual(planPasting({ zUpper: -40, zLower: 50 }).centres, planPasting({ zUpper: 50, zLower: -40 }).centres);
});

test('each image is a tilt to its own centre from the one focal spot', () => {
  const p = planPasting({ zUpper: 55, zLower: -41.6 });
  const a = tileAngles(p, 0, 180);
  assert.equal(a.length, 3);
  assert.ok(a[0] < 0 && a[2] > 0, 'cephalad for the top image, caudad for the bottom');
  a.forEach((deg, i) => close(receptorZ(0, 180, deg), p.centres[i], 1e-9));
});

test('the COI sets the magnification and the length measured at the anatomy', () => {
  close(magnification(180, 0), 1, 1e-12);
  close(magnification(180, 11), 180 / 169, 1e-12, 'COI 8 cm over a 3 cm cover at the wall');
  close(magnification(100, 50), 2, 1e-12);
  close(anatomicalLength(96.6, 180, 11), 96.6 * 169 / 180, 1e-9);
  assert.ok(anatomicalLength(90, 180, 20) < anatomicalLength(90, 180, 5), 'deeper anatomy is magnified more');
});

test('the ruler: a tick per anatomical cm, 10 cm apart at the COI plane times its magnification', () => {
  const pxV = 0.1, M = 1.1, zf = 3;
  const t = rulerTicks({ spanBot: -40, spanTop: 50, pxV, zf, M });
  assert.equal(t[0].cm, 0); assert.equal(t[0].kind, 'major');
  close(t[0].row, 90 / pxV - 0.5, 1e-6, '0 at the top of the study');
  assert.equal(t[5].kind, 'mid'); assert.equal(t[3].kind, 'minor');
  close(t[0].row - t[10].row, 10 * M / pxV, 1e-6, '10 anatomical cm, magnified');
  assert.equal(t.length, Math.floor(90 / M) + 1);
});

// synthetic tiles: one long "patient" row profile seen through several detector windows
function makeTiles(centres, { nx = 4, ny = 43, pxV = 1, gain = [], profile = (z) => 100 + z } = {}) {
  return centres.map((cz, t) => {
    const dose = new Float32Array(nx * ny), direct = new Float32Array(nx * ny), mask = new Uint8Array(nx * ny).fill(1);
    for (let j = 0; j < ny; j++) {
      const z = cz + (j - (ny - 1) / 2) * pxV;
      for (let i = 0; i < nx; i++) { dose[j * nx + i] = profile(z) * (gain[t] ?? 1); direct[j * nx + i] = 1000 * (gain[t] ?? 1); }
    }
    return { dose, direct, mask, cz };
  });
}

test('the stitch places every image by its receptor position: one continuous profile', () => {
  const p = planPasting({ zUpper: 40, zLower: -45, det: 43, minOverlap: 4 });
  const tiles = makeTiles(p.centres);
  const st = stitchTiles(tiles, { nx: 4, ny: 43, pxV: 1, spanBot: p.spanBot, spanTop: p.spanTop, feather: p.overlap });
  assert.equal(st.ny, Math.round(p.spanTop - p.spanBot));
  for (let J = 0; J < st.ny; J++) {
    const z = p.spanBot + J + 0.5;
    close(st.arrays.dose[J * 4 + 1], 100 + z, 1e-3, `row ${J}`);
    assert.equal(st.mask[J * 4 + 1], 1);
  }
  st.gains.forEach((g) => close(g, 1, 1e-6));
});

test('gain matching takes out an exposure step between images (an AEC terminating differently)', () => {
  const p = planPasting({ zUpper: 40, zLower: -45 });
  const tiles = makeTiles(p.centres, { gain: [1, 0.7, 0.7] });
  const st = stitchTiles(tiles, { nx: 4, ny: 43, pxV: 1, spanBot: p.spanBot, spanTop: p.spanTop, feather: p.overlap });
  close(st.gains[1], 1 / 0.7, 1e-4);
  for (let J = 0; J < st.ny; J++) close(st.arrays.dose[J * 4], 100 + p.spanBot + J + 0.5, 1e-2, `row ${J}`);
  // the direct (open-beam) plane is matched with it, so dose/direct (what the VOI reads) is kept
  for (let J = 0; J < st.ny; J++) close(st.arrays.direct[J * 4], 1000, 1e-2);
  // and joined unmatched (gains given as 1), the step is what the receptor really received
  const raw = stitchTiles(tiles, { nx: 4, ny: 43, pxV: 1, spanBot: p.spanBot, spanTop: p.spanTop, feather: p.overlap, gains: tiles.map(() => 1) });
  close(raw.arrays.dose[0], (100 + p.spanBot + 0.5) * 0.7, 1e-2, 'the bottom of the study: the second image as exposed');
  close(raw.arrays.dose[(raw.ny - 1) * 4], 100 + p.spanTop - 0.5, 1e-2, 'the top: the first image');
});

test('the overlap is feathered: across it the weight passes from one image to the next', () => {
  // the two images agree on average over the overlap (gain 1) but row by row tile 1 is off by
  // +-10 (its own noise and scatter): at the overlap's top tile 0 rules, at its bottom tile 1
  const p = planPasting({ zUpper: 40, zLower: -36 });          // 76 cm: an overlap of 10
  const tiles = makeTiles(p.centres, { profile: () => 100 });
  for (let j = 0; j < 43; j++) for (let i = 0; i < 4; i++) tiles[1].dose[j * 4 + i] = 100 + (j % 2 ? 10 : -10);
  const st = stitchTiles(tiles, { nx: 4, ny: 43, pxV: 1, spanBot: p.spanBot, spanTop: p.spanTop, feather: p.overlap, planes: ['dose'] });
  close(st.gains[1], 1, 0.03);
  const ovTop = p.centres[1] + 21.5, ovBot = p.centres[0] - 21.5;
  const dev = (z) => Math.abs(st.arrays.dose[Math.floor(z - p.spanBot) * 4] - 100);
  assert.ok(dev(ovTop - 0.5) < 1.5, `top of the overlap: ${dev(ovTop - 0.5)}`);
  assert.ok(dev(ovBot + 0.5) > 8, `bottom of the overlap: ${dev(ovBot + 0.5)}`);
  const mid = dev((ovTop + ovBot) / 2);
  assert.ok(mid > 2 && mid < 8, `half way: ${mid}`);
  assert.ok(dev(ovTop + 3) < 1e-3, 'above the overlap: tile 0 alone');
});

test('the console says the CR angle the way the main panel does', () => {
  assert.equal(fmtCC(0), '0°');
  assert.equal(fmtCC(-17), '17° CEPH');
  assert.equal(fmtCC(6.357), '6.4° CAUD');
});

test('the pasting protocols: wall/table studies at 43 cm, on subjects that reach their landmarks', () => {
  const protocols = JSON.parse(readFileSync(new URL('../src/data/protocols.json', import.meta.url), 'utf8'));
  const paste = protocols.groups.flatMap((g) => g.regions.flatMap((r) => r.projections)).filter((p) => p.paste);
  assert.deepEqual(paste.map((p) => p.proj).sort(), ['Femur pasting', 'Lateral femur pasting', 'Leg length study', 'Scoliosis study']);
  for (const p of paste) {
    assert.equal(p.coll[1], 43, `${p.proj}: the field length is a whole receptor`);
    assert.deepEqual(p.det, [43, 43]);
    assert.ok(p.paste.coi > 0 && p.paste.coi < 40, `${p.proj}: COI`);
    assert.equal(p.sid, 180, `${p.proj}: the chart is written for 180 cm`);
  }
  const by = Object.fromEntries(paste.map((p) => [p.proj, p]));
  assert.equal(by['Leg length study'].subject, 'lowerextremity');
  assert.equal(by['Femur pasting'].subject, 'lowerextremity');
  assert.equal(by['Lateral femur pasting'].subject, 'lowerextremity');
  assert.deepEqual(by['Lateral femur pasting'].paste, by['Femur pasting'].paste, 'the lateral pastes the same length');
  assert.equal(by['Scoliosis study'].pose.roll, 180, 'a scoliosis series is taken PA');
});
