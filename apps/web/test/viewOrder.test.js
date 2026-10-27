// View order: the priority of the tiers, and the best order found exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepCost, orderCost, bestOrder, judgeOrder, compareCost, TIERS } from '../src/core/viewOrder.js';
import { HOSPITAL, VIEW_META } from '../src/trainer/hospitalProtocols.js';

const V = (name, room, posture, rot = 0, cc = 0, site = [0, 0], coll = [20, 20]) => ({ name, room, posture, rot, cc, site, coll });

test('a step costs each tier, the turn the short way round', () => {
  const c = stepCost(V('a', 'wall', 'erect', 135, 15, [0, 0]), V('b', 'wall', 'erect', -135, -15, [3, 4]));
  assert.deepEqual(c.slice(0, 5), [0, 0, 90, 30, 5]);
  assert.equal(stepCost(V('a', 'wall', 'erect'), V('b', 'table', 'supine'))[0], 1);
});

test('one room change fewer beats any amount of turning', () => {
  assert.equal(compareCost([0, 5, 900, 0, 0, 0], [1, 0, 0, 0, 0, 0]), -1);
  assert.equal(compareCost([0, 1, 0, 0, 0, 0], [0, 0, 400, 90, 500, 99]), 1);
  assert.equal(compareCost([0, 0, 10, 0, 0, 0], [0, 0, 10 + 1e-9, 0, 0, 0]), 0);
});

test('the best order groups the rooms, then turns progressively', () => {
  // chest PA (wall), KUB (table), upright abdomen (wall), chest lateral (wall)
  const views = [V('PA', 'wall', 'erect', 180), V('KUB', 'table', 'supine', 0), V('Erect AXR', 'wall', 'erect', 0), V('LAT', 'wall', 'erect', 90)];
  const j = judgeOrder(views);
  assert.equal(j.efficient, false);
  assert.equal(j.tier, 0);                                    // it loses on rooms first
  const names = j.bestOrder.map((i) => views[i].name);
  assert.equal(j.best[0], 1);                                 // one room change
  assert.ok(names[0] === 'KUB' || names[names.length - 1] === 'KUB');
  // the wall views turn 180 -> 90 -> 0 (or back), not 180 -> 0 -> 90
  const wall = names.filter((n) => n !== 'KUB');
  assert.ok(wall.join() === 'PA,LAT,Erect AXR' || wall.join() === 'Erect AXR,LAT,PA', wall.join());
});

test('a best order is judged efficient, and kept as given', () => {
  const views = [V('PA', 'detector', 'seated', 0), V('OBL', 'detector', 'seated', 45), V('LAT', 'detector', 'seated', 90)];
  const j = judgeOrder(views);
  assert.equal(j.efficient, true);
  assert.deepEqual(j.bestOrder, [0, 1, 2]);
  const k = judgeOrder([views[0], views[2], views[1]]);
  assert.equal(k.efficient, false);
  assert.equal(TIERS[k.tier].key, 'rot');
});

test('the exact search matches brute force on random series', () => {
  let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const rooms = ['wall', 'table', 'detector'], postures = ['erect', 'supine', 'seated', 'lateral'];
  const perms = (a) => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
  for (let trial = 0; trial < 30; trial++) {
    const n = 2 + Math.floor(r() * 5);
    const views = Array.from({ length: n }, (_, i) => V('v' + i, rooms[Math.floor(r() * 3)], postures[Math.floor(r() * 4)],
      Math.round(r() * 4) * 45, Math.round(r() * 2) * 15, [r() * 30, r() * 100], [10 + r() * 20, 10 + r() * 20]));
    let best = null;
    for (const p of perms(views.map((_, i) => i))) {
      const c = orderCost(p.map((i) => views[i])).total;
      if (!best || compareCost(c, best) < 0) best = c;
    }
    const got = orderCost(bestOrder(views).map((i) => views[i])).total;
    assert.equal(compareCost(got, best), 0, `trial ${trial}`);
  }
});

test('every hospital view has where-and-how metadata', () => {
  for (const line of HOSPITAL) {
    for (const v of [...line.views, ...(line.either || []).flatMap((e) => e.of)]) {
      const m = VIEW_META[v];
      assert.ok(m, `${line.id}: no VIEW_META for ${v}`);
      assert.ok(['wall', 'table', 'detector'].includes(m.room), v);
      assert.ok(Array.isArray(m.site), v);
    }
  }
});
