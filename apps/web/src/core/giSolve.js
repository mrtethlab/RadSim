/* ============================================================================
   BARIUM TRANSPORT, IN THE BROWSER
   A port of services/compute/app/gi_solver.py. Same model, same constants, same numerics;
   the Python module remains the reference and the two are cross-checked.

   WHY THIS RUNS CLIENT-SIDE WHEN THE CONTRAST SOLVER DOES NOT
   -----------------------------------------------------------
   The design (docs §5) ties barium to the patient's position, because turning the patient to
   move the agent IS the barium study. That only teaches anything if it responds while you
   drag the slider — and a solved timeline cannot, because the pose is baked into it. A
   round-trip to the Python service would not fix that either: it would still be a request per
   drag, and GI studies are exactly the case where the service is least likely to be running.

   It is also small enough to be unremarkable. The contrast solver stayed in Python because it
   is genuinely heavy — ~4000 nodes x ~9000 steps, plus organ compartments and a closed
   recirculation loop. This is 5 segments x 128 nodes, and the expensive-looking parts are a
   gather and a 128-wide tridiagonal solve.

   Numerics are the same as the reference for the same reason: explicit upwind advection blows
   up here (the oesophagus transits in 8 s, giving a Courant number of 4 at a 0.25 s step), so
   advection is semi-Lagrangian and diffusion is backward-Euler. Neither has a stability limit.
   ============================================================================ */

export const N = 128;                  // arclength nodes per segment
export const G_GAIN = 1.5;             // gravity as a MULTIPLIER on each segment's own rate

// Must stay in step with gi_solver.py SEGMENTS.
export const SEGMENTS = {
  48: { name: 'Oesophagus',  transit: 8,     disp: 0.010, mobility: 0.95, radius: 1.0 },
  49: { name: 'Stomach',     transit: 1800,  disp: 0.060, mobility: 0.90, radius: 5.0 },
  50: { name: 'Duodenum',    transit: 120,   disp: 0.030, mobility: 0.55, radius: 1.5 },
  51: { name: 'Small bowel', transit: 9000,  disp: 0.040, mobility: 0.35, radius: 1.2 },
  52: { name: 'Colon',       transit: 43200, disp: 0.050, mobility: 0.45, radius: 2.5 },
};
export const ORDER = [48, 49, 50, 51, 52];

/* 'Down' in model coordinates. Model axes are (x lateral, y anteroposterior, z
   cranio-caudal): supine, down is -y; erect, down is -z. The rotations are applied in
   reverse to bring world-down into the model's frame. */
export function gravityDir({ rotX = 0, rotY = 0, rotZ = 0, erect = false } = {}) {
  let g = erect ? [0, 0, -1] : [0, -1, 0];
  const rot = (v, axis, deg) => {
    const a = -deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const [x, y, z] = v;
    if (axis === 0) return [x, c * y - s * z, s * y + c * z];
    if (axis === 1) return [c * x + s * z, y, -s * x + c * z];
    return [c * x - s * y, s * x + c * y, z];
  };
  g = rot(g, 0, rotX); g = rot(g, 1, rotY); g = rot(g, 2, rotZ);
  const n = Math.hypot(g[0], g[1], g[2]) || 1;
  return [g[0] / n, g[1] / n, g[2] / n];
}

/* Elevation along a segment under the current pose, at N nodes. Bins with no voxels come
   back as null in the geometry and are interpolated over so the gradient stays finite. */
function heightProfile(seg, gdir) {
  const c = seg.centreMM || [];
  const xs = [], hs = [];
  for (let i = 0; i < c.length; i++) {
    const p = c[i];
    if (!p || p[0] == null || p[1] == null || p[2] == null) continue;
    xs.push(i / Math.max(1, c.length - 1));
    hs.push(-(p[0] * gdir[0] + p[1] * gdir[1] + p[2] * gdir[2]));   // height = onto 'up'
  }
  const out = new Float64Array(N);
  if (xs.length < 2) return out;
  for (let k = 0; k < N; k++) {
    const x = k / (N - 1);
    let j = 0;
    while (j + 1 < xs.length && xs[j + 1] < x) j++;
    const j1 = Math.min(xs.length - 1, j + 1), span = xs[j1] - xs[j];
    const f = span > 0 ? (x - xs[j]) / span : 0;
    out[k] = hs[j] + f * (hs[j1] - hs[j]);
  }
  return out;
}

/* Thomas algorithm for the tridiagonal (I - dt L) solve. scipy's solve_banded hands this to
   LAPACK; at n=128 a direct sweep is far below anything measurable. */
function thomas(lo, di, up, b) {
  const n = b.length, cp = new Float64Array(n), dp = new Float64Array(n), x = new Float64Array(n);
  cp[0] = up[0] / di[0]; dp[0] = b[0] / di[0];
  for (let i = 1; i < n; i++) {
    const m = di[i] - lo[i] * cp[i - 1];
    cp[i] = up[i] / m;
    dp[i] = (b[i] - lo[i] * dp[i - 1]) / m;
  }
  x[n - 1] = dp[n - 1];
  for (let i = n - 2; i >= 0; i--) x[i] = dp[i] - cp[i] * x[i + 1];
  return x;
}

class Tube {
  constructor(u, disp, ds, dt) {
    this.ds = ds; this.c = new Float64Array(N);
    const xi = new Float64Array(N), i0 = new Int32Array(N), w = new Float64Array(N);
    let minI = 0;
    for (let i = 0; i < N; i++) {
      xi[i] = i - u[i] * dt / ds;
      i0[i] = Math.floor(xi[i]);
      w[i] = xi[i] - i0[i];
      if (i0[i] < minI) minI = i0[i];
    }
    // Pad BOTH ends: gravity can reverse the flow, and a reversed cell's departure point
    // lies downstream, past the outlet. Nothing flows back in from beyond it, so that pad is
    // zero rather than a clamp onto the last cell.
    let maxI = 0;
    for (let i = 0; i < N; i++) if (i0[i] > maxI) maxI = i0[i];
    this.pad = Math.max(0, -minI);
    this.padHi = Math.max(0, maxI + 1 - (N - 1));
    this.idx = new Int32Array(N);
    for (let i = 0; i < N; i++) this.idx[i] = i0[i] + this.pad;
    this.w = w; this.u = u; this.dt = dt;
    this._ext = new Float64Array(N + this.pad + this.padHi);
    const r = dt / (ds * ds);
    this.lo = new Float64Array(N); this.di = new Float64Array(N); this.up = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const Dp = i === N - 1 ? 0 : disp;         // zero flux out of the far end
      const Dm = i === 0 ? 0 : disp;             // zero flux back out of the inlet
      this.di[i] = 1 + r * (Dm + Dp);
      this.up[i] = i < N - 1 ? -r * Dp : 0;
      this.lo[i] = i > 0 ? -r * Dm : 0;
    }
  }

  /* Nothing enters through the padding — incoming mass is a parcel at the inlet (addMass).
     Feeding a concentration through the padding manufactures barium, because every one of the
     `pad` upstream cells takes that value; see the note in gi_solver.py. */
  /* Returns [offFarEnd, refluxedOutTheInlet], both in concentration units. */
  step() {
    let before = 0;
    for (let i = 0; i < N; i++) before += this.c[i];
    const ext = this._ext;
    ext.fill(0);
    ext.set(this.c, this.pad);
    const cs = new Float64Array(N);
    let tot = 0;
    for (let i = 0; i < N; i++) {
      const a = this.idx[i];
      cs[i] = ext[a] + this.w[i] * (ext[a + 1] - ext[a]);
      tot += cs[i];
    }
    // Semi-Lagrangian advection conserves mass only for a UNIFORM velocity, and u varies
    // along s here because gravity does. The gather sets the SHAPE; the conservation law is
    // imposed on top of it. Without this the scheme's divergence error shows up as a
    // pose-dependent mass gain — it reached +4.7 % prone.
    if (tot > 1e-12) { const k = before / tot; for (let i = 0; i < N; i++) cs[i] *= k; }
    const r = this.dt / this.ds;
    const outFwd = Math.min(cs[N - 1] * Math.max(this.u[N - 1], 0) * r, cs[N - 1]);
    const outBack = Math.min(cs[0] * Math.max(-this.u[0], 0) * r, cs[0]);
    cs[N - 1] -= outFwd; cs[0] -= outBack;
    this.c = thomas(this.lo, this.di, this.up, cs);
    for (let i = 0; i < N; i++) if (this.c[i] < 0) this.c[i] = 0;
    return [outFwd, outBack];
  }

  /* Fill forward, overflowing onward. A lumen cannot exceed the administered concentration —
     nothing here removes water — and 150 mL of barium does not fit in a 46 mL oesophagus. */
  addMass(conc, ceiling) {
    if (!(conc > 0)) return 0;
    let excess = conc;
    for (let i = 0; i < N; i++) {
      const room = Math.max(ceiling - this.c[i], 0);
      const take = Math.min(room, excess);
      this.c[i] += take; excess -= take;
      if (excess <= 0) return 0;
    }
    return excess;
  }
}

/* Run the tract. `gi` is the parsed <name>.gi.json.
   Returns { times, lumen: Map(vid -> Float32Array(nT*N)), wall: same, audit } — the same
   shape decodeGITimeline produces, so buildBariumLUT consumes either without caring. */
/* ============================================================================
   A LIVE STUDY
   A barium examination is not a precomputed timeline. The operator screens, turns the
   patient, and watches the agent respond FROM THAT MOMENT — so re-solving the whole study
   with a new pose would rewrite history, putting barium where it would have gone had the
   patient been lying that way the entire time.

   GIStudy therefore holds the state and is advanced. `setPose` changes gravity from now on,
   which is what turning a patient does, and costs only a velocity-field rebuild — the
   departure map and the diffusion band depend on u, so they are rebuilt with it while the
   lumen and mucosal contents carry straight across.
   ============================================================================ */
export class GIStudy {
  constructor(gi, {
    route = 'oral', volumeMl = 150, concMgBaMl = 588, overS = 5,
    pose = {}, dt = 0.5,
    kOn = 0.010, kOff = 0.0009, wMax = 12.0, coatPerCm = 10.0,
  } = {}) {
    const segs = gi.segments || {};
    this.segs = segs;
    this.order = ORDER.filter((v) => segs[String(v)]);
    if (!this.order.length) throw new Error('this model has no GI segments');
    if (route === 'rectal') this.order = this.order.slice().reverse();
    Object.assign(this, { route, volumeMl, concMgBaMl, overS, dt, kOn, kOff, wMax, coatPerCm });
    this.ds = 1 / (N - 1);
    this.t = 0; this.given = 0; this.spill = 0;
    this.volNode = {}; this.area = {}; this.wall = {}; this.handover = {}; this.tubes = {};
    for (const v of this.order) {
      const p = SEGMENTS[v];
      this.volNode[v] = Math.max(segs[String(v)].volumeML, 1e-3) / N;
      this.area[v] = 2 * this.volNode[v] / p.radius;   // mucosal area, not the cross-section
      this.wall[v] = new Float64Array(N);
      this.handover[v] = 0;
    }
    this.setPose(pose);
  }

  /* Rebuild the velocity field for a new patient position. The lumen and mucosal state are
     untouched — only what happens NEXT changes, which is the whole point. */
  setPose(pose) {
    this.pose = pose || {};
    const gdir = gravityDir(this.pose), ds = this.ds;
    const hprof = {};
    let lo = Infinity, hi = -Infinity;
    for (const v of this.order) {
      hprof[v] = heightProfile(this.segs[String(v)], gdir);
      for (let i = 0; i < N; i++) {
        if (hprof[v][i] < lo) lo = hprof[v][i];
        if (hprof[v][i] > hi) hi = hprof[v][i];
      }
    }
    const span = Math.max(hi - lo, 1);
    const sgn = this.route === 'rectal' ? -1 : 1;
    for (const v of this.order) {
      const p = SEGMENTS[v], u = new Float64Array(N), u0 = 1 / Math.max(p.transit, 1e-3);
      for (let i = 0; i < N; i++) {
        const im = Math.max(i - 1, 0), ip = Math.min(i + 1, N - 1);
        const dh = (hprof[v][ip] - hprof[v][im]) / ((ip - im) * ds) / span;
        const ug = Math.max(-2, Math.min(4, -dh * G_GAIN * p.mobility));
        u[i] = sgn * u0 * (1 + ug);
      }
      const old = this.tubes[v];
      const tube = new Tube(u, p.disp, ds, this.dt);
      if (old) tube.c.set(old.c);                     // contents carry across the change
      this.tubes[v] = tube;
    }
  }

  stepOnce() {
    const { order, dt, volNode, area, wall, handover, tubes } = this;
    const t = this.t;
    const rate = (t >= 0 && t < this.overS)
      ? this.volumeMl * this.concMgBaMl / Math.max(this.overS, 1e-3) : 0;
    const mg = rate * dt; this.given += mg;
    const cInFirst = mg > 0 ? mg / volNode[order[0]] : 0;

    for (let i = 0; i < order.length; i++) {
      const v = order[i], tube = tubes[v];
      const over = tube.addMass((i === 0 ? cInFirst : 0) + handover[v], this.concMgBaMl);
      handover[v] = 0;
      if (over > 0) {
        if (i + 1 < order.length) handover[order[i + 1]] += over * volNode[v] / volNode[order[i + 1]];
        else this.spill += over * volNode[v];
      }
      const [left, refluxed] = tube.step();
      const c = tube.c, w = wall[v];
      for (let j = 0; j < N; j++) {
        const on = this.kOn * c[j] * Math.max(0, Math.min(1, 1 - w[j] / this.wMax));
        const off = this.kOff * w[j];
        let dm = (on - off) * area[v] * dt;
        dm = Math.min(dm, c[j] * volNode[v]);
        dm = Math.max(dm, -w[j] * area[v]);
        dm = Math.min(dm, (this.wMax - w[j]) * area[v]);
        c[j] -= dm / Math.max(volNode[v], 1e-6);
        w[j] += dm / Math.max(area[v], 1e-9);
      }
      if (left > 0) {
        const mass = left * volNode[v];
        if (i + 1 < order.length) handover[order[i + 1]] += mass / volNode[order[i + 1]];
        else this.spill += mass;
      }
      if (refluxed > 0) {            // back up the tract: reflux is a finding, not an error
        const mass = refluxed * volNode[v];
        if (i > 0) handover[order[i - 1]] += mass / volNode[order[i - 1]];
        else this.spill += mass;     // out of the mouth
      }
    }
    this.t += dt;
  }

  /* Advance by `seconds` of study time. Capped so a long fast-forward cannot lock the tab —
     4000 steps is ~30 min of tract for ~100 ms of wall clock. */
  advance(seconds, maxSteps = 4000) {
    const n = Math.min(Math.max(0, Math.round(seconds / this.dt)), maxSteps);
    for (let k = 0; k < n; k++) this.stepOnce();
    return n * this.dt;
  }

  /* The current state in the shape buildBariumLUT consumes — a one-frame timeline. */
  sample() {
    const lumen = new Map(), wall = new Map();
    for (const v of this.order) {
      lumen.set(v, Float32Array.from(this.tubes[v].c));
      wall.set(v, Float32Array.from(this.wall[v]));
    }
    return { nS: N, nT: 1, times: [this.t], lumen, wall,
             coatConc: this.concMgBaMl, coatPerCm: this.coatPerCm };
  }

  audit() {
    let lum = 0, muc = 0, pend = 0;
    for (const v of this.order) {
      for (let j = 0; j < N; j++) {
        lum += this.tubes[v].c[j] * this.volNode[v];
        muc += this.wall[v][j] * this.area[v];
      }
      pend += this.handover[v] * this.volNode[v];
    }
    const total = lum + muc + this.spill + pend;
    return { t: this.t, given: this.given, lumen: lum, mucosa: muc, spill: this.spill,
             errPct: this.given ? (total - this.given) / this.given * 100 : 0 };
  }
}

/* Batch solve, for the export path and for cross-checking against gi_solver.py. A thin
   wrapper over GIStudy so the live and batch paths cannot drift apart. */
export function solveGI(gi, { duration = 1800, ...opts } = {}) {
  const st = new GIStudy(gi, opts);
  const steps = Math.round(duration / st.dt);
  const keepEvery = (t) => (t <= 30 ? 1 : t <= 300 ? 5 : 30);
  const times = [], lumOut = {}, walOut = {};
  for (const v of st.order) { lumOut[v] = []; walOut[v] = []; }
  // Frame k is labelled with the time the step was taken FOR, and holds the state AFTER it,
  // which is what gi_solver.py records. Keeping before the step instead labelled every frame
  // with the previous step's state — a one-step lag that showed up as an 11 % disagreement
  // with the reference at 10 s, where the duodenum is filling fastest.
  const keep = (label) => {
    times.push(label);
    for (const v of st.order) { lumOut[v].push(st.tubes[v].c.slice()); walOut[v].push(st.wall[v].slice()); }
    return label;
  };
  let lastKept = -1e9;
  for (let k = 0; k <= steps; k++) {
    const label = st.t;
    st.stepOnce();
    if (label - lastKept >= keepEvery(label) - 1e-6 || k === steps) lastKept = keep(label);
  }
  const nT = times.length, lumen = new Map(), wallM = new Map();
  for (const v of st.order) {
    const L = new Float32Array(nT * N), W = new Float32Array(nT * N);
    for (let i = 0; i < nT; i++) { L.set(lumOut[v][i], i * N); W.set(walOut[v][i], i * N); }
    lumen.set(v, L); wallM.set(v, W);
  }
  const a = st.audit();
  return {
    nS: N, nT, times, lumen, wall: wallM, coatConc: st.concMgBaMl, coatPerCm: st.coatPerCm,
    audit: a,
    notes: ['given ' + (a.given / 1000).toFixed(1) + ' g Ba; lumen ' + (a.lumen / 1000).toFixed(1)
            + ' g, mucosa ' + (a.mucosa / 1000).toFixed(1) + ' g, past-end '
            + (a.spill / 1000).toFixed(1) + ' g (' + a.errPct.toFixed(2) + ' %)'],
  };
}
