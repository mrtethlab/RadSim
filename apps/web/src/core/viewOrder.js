/* ============================================================================
   VIEW ORDER — how efficiently a series is ordered (the Protocol Trainer).

   A radiographer orders the views of a requisition to make the fewest costly changes between
   them. The costs, dearest first:
     ROOM     going between the room's set-ups (the wall stand, the table, a free detector on the
              stretcher, the seated bucky): the patient gets up or lies down, the tube and
              receptor are set up again;
     MOVES    moving the patient (sitting, lying, standing, rolling, turning, obliquing) or the
              receptor round them (under the leg, or stood beside it for a horizontal beam);
     ADJUSTS  what the radiographer does at the tube alone: re-angling the central ray, then
              re-centring along the anatomy, then re-collimating.
   Each step between two views costs a tuple in that priority, and a series costs the sum. Two
   series compare LEXICOGRAPHICALLY: one room change fewer beats any number of moves, one move
   fewer beats any amount of angling, centring and collimating. So the views that need only the
   tube adjusted go together (a leg's APs along the limb), and the last ties go to the fewer
   degrees turned (PA, oblique, lateral rather than PA, lateral, oblique).

   The best order is found exactly (Held-Karp over the subsets: lexicographic order is preserved
   under addition, so the dynamic programme's local choice is the global one), which is quick for
   the views a requisition has; a very long worklist is improved locally instead.

   view: { name, room ('wall' | 'table' | 'detector' | 'seated'), posture, rot (deg),
           xt (a horizontal beam, the receptor beside the patient), cc (deg, + caudal),
           site: [x, z] (cm), coll: [w, l] (cm) }
   ============================================================================ */

export const TIERS = [
  { key: 'room', label: 'Room changes', unit: '' },
  { key: 'moves', label: 'Patient or receptor moves', unit: '' },
  { key: 'angle', label: 'Tube re-angling', unit: '°' },
  { key: 'travel', label: 'Re-centring along the anatomy', unit: ' cm' },
  { key: 'coll', label: 'Re-collimating', unit: ' cm' },
  { key: 'turn', label: 'Turning, in all', unit: '°' },
];
const N = TIERS.length;
const EPS = 1e-6;

// the shorter way round between two turns (a PA at 180 is a PA at -180)
const turn = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

/* The cost of going from view a to view b, one entry per tier. Within one room a move is a
   change of posture, a turn of the patient or the limb (a smaller change than TURN_MIN is the same
   position, adjusted), or the receptor taken from under the patient to beside them for a
   horizontal beam; a patient who changes room is set up afresh, so nothing more is counted. */
const TURN_MIN = 10;
export function stepCost(a, b) {
  const room = a.room !== b.room ? 1 : 0;
  const posture = !room && a.posture !== b.posture;
  const deg = room || posture ? 0 : turn(a.rot || 0, b.rot || 0);
  const moves = room ? 0 : (posture ? 1 : 0) + (deg >= TURN_MIN ? 1 : 0) + (!!a.xt !== !!b.xt ? 1 : 0);
  return [
    room,
    moves,
    Math.abs((a.cc || 0) - (b.cc || 0)),
    a.site && b.site ? Math.hypot(a.site[0] - b.site[0], a.site[1] - b.site[1]) : 0,
    a.coll && b.coll ? Math.abs(a.coll[0] - b.coll[0]) + Math.abs(a.coll[1] - b.coll[1]) : 0,
    deg,
  ];
}

const add = (p, q) => p.map((v, i) => v + q[i]);
/* -1 if p is the cheaper, 1 if q, 0 if they tie (each tier to within EPS). */
export function compareCost(p, q) {
  for (let i = 0; i < N; i++) {
    if (p[i] < q[i] - EPS) return -1;
    if (p[i] > q[i] + EPS) return 1;
  }
  return 0;
}
/* The first tier where p costs more than q (the reason p is worse), or -1. */
export function worseTier(p, q) {
  for (let i = 0; i < N; i++) {
    if (p[i] > q[i] + EPS) return i;
    if (p[i] < q[i] - EPS) return -1;
  }
  return -1;
}

/* The cost of a series in the order given, and each step's cost. */
export function orderCost(views) {
  const steps = [];
  let total = new Array(N).fill(0);
  for (let i = 1; i < views.length; i++) {
    const c = stepCost(views[i - 1], views[i]);
    steps.push(c); total = add(total, c);
  }
  return { total, steps };
}

/* The cheapest order: indices into views (one of them, when several tie). */
export function bestOrder(views) {
  const n = views.length;
  if (n <= 1) return views.map((_, i) => i);
  if (n > 13) return improvedOrder(views);
  const step = views.map((a) => views.map((b) => stepCost(a, b)));
  const full = (1 << n) - 1;
  // cost[mask][last]: the cheapest way to take the views in mask, ending at last
  const cost = new Array(1 << n), prev = new Array(1 << n);
  for (let m = 0; m <= full; m++) { cost[m] = new Array(n).fill(null); prev[m] = new Int8Array(n).fill(-1); }
  for (let i = 0; i < n; i++) cost[1 << i][i] = new Array(N).fill(0);
  for (let m = 1; m <= full; m++) {
    for (let last = 0; last < n; last++) {
      const c = cost[m][last]; if (!c) continue;
      for (let nx = 0; nx < n; nx++) {
        if (m & (1 << nx)) continue;
        const m2 = m | (1 << nx), c2 = add(c, step[last][nx]);
        const cur = cost[m2][nx];
        if (!cur || compareCost(c2, cur) < 0) { cost[m2][nx] = c2; prev[m2][nx] = last; }
      }
    }
  }
  let end = 0;
  for (let i = 1; i < n; i++) if (compareCost(cost[full][i], cost[full][end]) < 0) end = i;
  const order = [];
  for (let m = full, at = end; at >= 0;) { order.push(at); const p = prev[m][at]; m &= ~(1 << at); at = p; }
  return order.reverse();
}

/* Past 13 views the subsets run to the millions (a worklist padded with every view going): the
   given order improved by moving single views and reversing runs until nothing helps. Not
   always the best, but never worse than the order given. */
function improvedOrder(views) {
  let ord = views.map((_, i) => i);
  const cost = (o) => orderCost(o.map((i) => views[i])).total;
  let best = cost(ord), better = true;
  while (better) {
    better = false;
    for (let i = 0; i < ord.length; i++) for (let j = 0; j < ord.length; j++) {
      if (i === j) continue;
      const moved = ord.slice(); const [v] = moved.splice(i, 1); moved.splice(j, 0, v);
      const rev = i < j ? [...ord.slice(0, i), ...ord.slice(i, j + 1).reverse(), ...ord.slice(j + 1)] : null;
      for (const o of rev ? [moved, rev] : [moved]) {
        const c = cost(o);
        if (compareCost(c, best) < 0) { ord = o; best = c; better = true; }
      }
    }
  }
  return ord;
}

/* What changes on a step, in words, for the worklist's step markers. */
export function stepChanges(a, b) {
  const c = stepCost(a, b), out = [];
  if (c[0]) { out.push({ tier: 0, text: `room: ${a.room} → ${b.room}` }); return out; }
  if (a.posture !== b.posture) out.push({ tier: 1, text: `position: ${a.posture} → ${b.posture}` });
  else if (c[5] >= TURN_MIN) out.push({ tier: 1, text: `turn ${Math.round(c[5])}°` });
  if (!!a.xt !== !!b.xt) out.push({ tier: 1, text: b.xt ? 'receptor beside, beam horizontal' : 'receptor under, beam vertical' });
  if (c[2] >= 1) out.push({ tier: 2, text: `tube ${Math.round(c[2])}°` });
  return out;
}

/* Judge an order against the best: { efficient, total, best, bestOrder, tier } where tier is the
   first tier the order loses on (-1 when it is as good as the best). */
export function judgeOrder(views) {
  const mine = orderCost(views).total;
  const order = bestOrder(views);
  const best = orderCost(order.map((i) => views[i])).total;
  const tier = worseTier(mine, best);
  // an order as good as the best is its own best (a reversed series costs the same)
  return { efficient: tier < 0, total: mine, best, bestOrder: tier < 0 ? views.map((_, i) => i) : order, tier };
}
