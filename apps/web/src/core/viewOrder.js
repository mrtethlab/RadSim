/* ============================================================================
   VIEW ORDER — how efficiently a series is ordered (the Protocol Trainer).

   A radiographer orders the views of a requisition to move as little as possible, and moves
   the big things least: the ROOM (wall stand, table, free detector: the tube, the receptor and
   often the patient go with it), then the patient's POSITION (getting up, lying down or rolling
   over, then how far the body or limb turns between views: PA, then the oblique, then the
   lateral, not PA, lateral, oblique), then the CENTRAL-RAY ANGLE (re-angling the tube), then
   the ANATOMY (working along the limb rather than back and forth), and last the COLLIMATION
   (similar fields together).

   Each step between two views costs a tuple in that priority, and a series costs the sum. Two
   series compare LEXICOGRAPHICALLY: one room change fewer beats any amount of turning, one
   posture change fewer beats any amount of tube angle. The best order is found exactly
   (Held-Karp over the subsets: lexicographic order is preserved under addition, so the
   dynamic programme's local choice is the global one), which is quick for the 1-12 views a
   requisition has.

   view: { name, room, posture, rot (deg), cc (deg, + caudal), site: [x, z] (cm), coll: [w, l] (cm) }
   ============================================================================ */

export const TIERS = [
  { key: 'room', label: 'Room changes', unit: '' },
  { key: 'posture', label: 'Patient position changes', unit: '' },
  { key: 'rot', label: 'Patient or limb turning', unit: '°' },
  { key: 'angle', label: 'Tube re-angling', unit: '°' },
  { key: 'travel', label: 'Anatomy travel', unit: ' cm' },
  { key: 'coll', label: 'Collimation changes', unit: ' cm' },
];
const N = TIERS.length;
const EPS = 1e-6;

// the shorter way round between two turns (a PA at 180 is a PA at -180)
const turn = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

/* The cost of going from view a to view b, one entry per tier. The turn counts only within one
   room and posture: a patient who gets up off the table is positioned afresh at the wall. */
export function stepCost(a, b) {
  const room = a.room !== b.room ? 1 : 0, posture = a.posture !== b.posture ? 1 : 0;
  return [
    room,
    posture,
    room || posture ? 0 : turn(a.rot || 0, b.rot || 0),
    Math.abs((a.cc || 0) - (b.cc || 0)),
    a.site && b.site ? Math.hypot(a.site[0] - b.site[0], a.site[1] - b.site[1]) : 0,
    a.coll && b.coll ? Math.abs(a.coll[0] - b.coll[0]) + Math.abs(a.coll[1] - b.coll[1]) : 0,
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
  if (n > 14) throw new Error('bestOrder: too many views');
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

/* What changes on a step, in words, for the worklist's step markers. */
export function stepChanges(a, b) {
  const c = stepCost(a, b), out = [];
  if (c[0]) out.push({ tier: 0, text: `room: ${a.room} → ${b.room}` });
  if (c[1]) out.push({ tier: 1, text: `position: ${a.posture} → ${b.posture}` });
  if (c[2] >= 1) out.push({ tier: 2, text: `turn ${Math.round(c[2])}°` });
  if (c[3] >= 1) out.push({ tier: 3, text: `tube ${Math.round(c[3])}°` });
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
