/* ============================================================================
   LONG-LENGTH (PASTING) STUDIES: leg length, scoliosis, femur — the console panel and the run
   ============================================================================
   The workflow, as on the machine:
     1. the protocol is chosen (wall stand or table: the study needs the tracking bucky) and the
        patient positioned; the longitudinal collimation is held at 43 cm;
     2. the COI is entered: the height of the anatomy above the cover / tabletop (cm), which the
        stitched image's measurements are calibrated at;
     3. the tube is tilted cephalad until the central ray's laser falls just above the superior
        landmark, and ACCEPT SUPERIOR stores it; tilted caudad below the inferior landmark, and
        ACCEPT INFERIOR stores that;
     4. CONFIRM works out the images for full coverage and drives the tube and bucky to the first;
     5. one press of the exposure switch, HELD, takes them all: between images the tube re-tilts
        about its focal spot and the bucky drives to the next place; letting go stops the study
        where it is. The images are stitched into one, processed as one, and filed like any other.
   The geometry and the stitch are pure functions in core/pasting.js.
   ============================================================================ */
import { receptorZ, focalOf, tiltAbout, angleTo, planPasting, tileAngles, magnification,
         anatomicalLength, stitchTiles, rulerTicks, fmtCC } from './core/pasting.js';

const DRIVE_SPEED = 30;                  // cm/s along the rails: the bucky's motor (app.js BUCKY_SPEED)
const MIN_OVERLAP = 4;                   // cm shared between neighbouring images
const MAX_IMAGES = 5;
const COI_MIN = 0, COI_MAX = 40;
// the distance each set-up pastes at (the wall stand's 180, the table's grid focus), and the
// chart's mAs, written for 180, follows it by the inverse square
export const PASTE_SID = { wall: 180, table: 115 };
const CHART_SID = 180;

let C = null;                            // app glue (initPasting)
const P = {
  proto: null,                           // the selected pasting protocol: { proj, coi, mas }
  coi: 8,
  upper: null, lower: null,              // accepted limits: { deg, z (receptor, room cm) }
  plan: null, angles: null, focal: null, // the confirmed study
  state: 'idle',                         // idle | moving | ready | running | done | incomplete
  done: 0, tiles: [], released: false,
};
const $ = (id) => document.getElementById(id);

export function pastingActive() { return !!P.proto; }
export function pastingState() { return P.state; }
/* The switch takes a pasting run: the study is confirmed and the tube is at its first image. */
export function pastingArmed() { return !!P.proto && P.state === 'ready'; }
/* Why the switch is inhibited (a pasting protocol with no confirmed study at its start), or null. */
export function pastingBlocked() {
  if (!P.proto) return null;
  if (P.state === 'ready') return null;
  if (P.state === 'moving') return ['TUBE AND BUCKY STILL MOVING'];
  return ['PASTING STUDY NOT CONFIRMED'];
}

export function initPasting(ctx) {
  C = ctx;
  $('ppCoi')?.addEventListener('change', (e) => setCoi(parseFloat(e.target.value)));
  $('ppCoiPlus')?.addEventListener('click', () => setCoi(P.coi + 0.5));
  $('ppCoiMinus')?.addEventListener('click', () => setCoi(P.coi - 0.5));
  $('ppUpper')?.addEventListener('click', () => accept('upper'));
  $('ppLower')?.addEventListener('click', () => accept('lower'));
  $('ppConfirm')?.addEventListener('click', confirm);
  $('ppReset')?.addEventListener('click', reset);
  $('ppCC')?.addEventListener('input', (e) => {
    if (P.state === 'running' || P.state === 'moving') { e.target.value = C.S.angCC; return; }
    tilt(parseFloat(e.target.value));
  });
  render();
}

/* A protocol was chosen: `p` is its pasting block (or null for any other protocol). */
export function pastingSelect(p) {
  if (P.state === 'running') abort();
  if (!p) { P.proto = null; clearStudy(); render(); C.lockControls(false); return; }
  P.proto = p; P.coi = p.coi ?? 8;
  clearStudy();
  roomDefaults();
  C.lockControls(true);
  render();
}

/* The room changed (wall stand <-> table): a new distance, so a new study. */
export function pastingRoomChanged() {
  if (!P.proto) return;
  if (P.state === 'running') abort();
  clearStudy();
  roomDefaults();
  render();
}

function roomDefaults() {
  const S = C.S, sid = PASTE_SID[S.room];
  if (!sid) return;
  C.setSid(sid);
  if (P.proto.mas) C.setMas(P.proto.mas * (sid / CHART_SID) ** 2);
}

function clearStudy() {
  P.upper = P.lower = null; P.plan = P.angles = P.focal = null;
  P.state = 'idle'; P.done = 0; P.tiles = []; P.released = false;
  clearClock();
}
// the generator's line still saying how the last study ended
function clearClock() { const c = $('clock'); if (c && /^PASTING/.test(c.textContent)) c.textContent = ''; }

function setCoi(v) {
  if (!Number.isFinite(v)) v = P.coi;
  P.coi = Math.round(Math.max(COI_MIN, Math.min(COI_MAX, v)) * 10) / 10;
  render();
}

/* The focal spot where the tube is now (its tilt and centring as the console frame has them). */
function focalNow() { const S = C.S; return focalOf(S.tubeZ, S.sid, S.angCC); }

/* Tilt the tube about its focal spot: the tube stays put, the ray swings, the bucky follows. */
function tilt(deg, f = focalNow()) {
  const S = C.S, t = tiltAbout(f.zf, f.H, deg);
  S.angCC = t.angCC; S.sid = t.sid; S.tubeZ = t.tubeZ;
  C.geometryChanged();
  render();
}

function accept(which) {
  if (P.state === 'running' || P.state === 'moving') return;
  const S = C.S, f = focalNow();
  P[which] = { deg: S.angCC, z: receptorZ(f.zf, f.H, S.angCC) };
  // a limit moved after the study was planned: the plan is stale
  if (P.plan) { P.plan = P.angles = null; P.state = 'idle'; P.done = 0; P.tiles = []; }
  render();
}

function confirm() {
  if (P.state === 'running' || P.state === 'moving' || !P.upper || !P.lower) return;
  const S = C.S;
  if (S.room !== 'wall' && S.room !== 'table') return;
  if (P.upper.z <= P.lower.z) { P.plan = null; P.state = 'idle'; render(); flagBad(); return; }
  const f = focalNow();
  const plan = planPasting({ zUpper: P.upper.z, zLower: P.lower.z, det: S.detH, minOverlap: MIN_OVERLAP, maxImages: MAX_IMAGES });
  if (plan.tooLong) { P.plan = null; P.state = 'idle'; render(); flagBad(); return; }
  P.plan = plan; P.focal = f; P.angles = tileAngles(plan, f.zf, f.H);
  P.done = 0; P.tiles = []; P.released = false;
  P.state = 'moving'; clearClock(); render();
  driveTo(0, false).then(() => { if (P.state === 'moving') { P.state = 'ready'; render(); } });
}
function flagBad() {
  const el = $('ppStatus'); if (!el) return;
  el.hidden = false; el.classList.add('bad');
  $('ppCount').textContent = '—';
  $('ppNote').textContent = P.upper && P.lower && P.upper.z <= P.lower.z ? 'limits reversed' : 'too long';
}

function reset() {
  if (P.state === 'running') abort();
  clearStudy();
  render();
}

/* Drive the tube's tilt (and so the bucky) to image i at the motor's speed. Resolves true at the
   place, false if the switch was let go on the way (when it is being held for the run). */
function driveTo(i, held) {
  const target = P.plan.centres[i], f = P.focal;
  return new Promise((res) => {
    let last = performance.now();
    const step = (now) => {
      if (held && P.released) { res(false); return; }
      if (!P.plan) { res(false); return; }
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const S = C.S, d = target - S.tubeZ, mv = DRIVE_SPEED * dt;
      const z = Math.abs(d) <= mv ? target : S.tubeZ + Math.sign(d) * mv;
      tilt(z === target ? P.angles[i] : angleTo(f.zf, f.H, z), f);
      if (z === target) C.S.tubeZ = target;         // (exactly: the stitch places the image by it)
      if (z === target && !C.buckyBusy()) { res(true); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/* Hold the switch for one exposure's time. Resolves true when it has run its time, false when the
   switch is let go first. */
function holdFor(ms) {
  return new Promise((res) => {
    const t0 = performance.now();
    const prog = $('prog');
    const tick = () => {
      if (P.released) { res(false); return; }
      const el = performance.now() - t0;
      if (prog) prog.style.width = Math.min(100, el / ms * 100).toFixed(0) + '%';
      if (el >= ms) { res(true); return; }
      requestAnimationFrame(tick);
    };
    tick();
    setTimeout(() => { if (!P.released) res(true); }, ms + 40);
  });
}

/* THE RUN: the switch is down. Image after image while it stays down. */
export async function pastingStart() {
  if (!pastingArmed()) return;
  const S = C.S, Sound = C.Sound;
  P.state = 'running'; P.released = false; P.done = 0; P.tiles = [];
  S.exposing = true;
  render();
  const fire = $('fire');
  fire?.classList.remove('armed'); fire?.classList.add('firing');
  $('noexp').style.display = 'none';
  Sound.resume();
  let ok = true;
  try {
    for (let i = 0; i < P.plan.n; i++) {
      if (i > 0) {
        C.setWarn('ready'); $('clock').textContent = `PASTING · TO IMAGE ${i + 1}`;
        if (!(await driveTo(i, true))) { ok = false; break; }
      }
      C.setWarn('live'); $('clock').textContent = `EXPOSING ${i + 1}/${P.plan.n}`;
      Sound.play('start'); Sound.startBuzz();
      const held = await holdFor(C.exposureMs());
      Sound.stopBuzz();
      if (!held) { ok = false; break; }
      P.done = i + 1; render();
      $('clock').textContent = `ACQUIRING ${i + 1}/${P.plan.n}`;
      const t = await C.computeTile({ marker: i === 0 });
      t.cz = S.bucky.z;
      P.tiles.push(t);
    }
    if (ok) {
      $('clock').textContent = 'STITCHING';
      await new Promise((r) => setTimeout(r, 0));
      publish();
      P.state = 'done';
      $('clock').textContent = '';
    } else {
      P.state = 'incomplete';
      $('clock').textContent = 'PASTING INCOMPLETE';
      const prog = $('prog'); if (prog) prog.style.width = '0%';
    }
  } catch (err) {
    console.error('pasting failed', err);
    P.state = 'incomplete';
    $('clock').textContent = 'EXPOSURE FAILED';
  } finally {
    Sound.stopBuzz();
    Sound.play('end', () => Sound.play('cooldown'));
    fire?.classList.remove('firing');
    C.setWarn('standby');
    S.prepped = false; $('rotor')?.classList.remove('on');
    if (fire) { fire.disabled = true; fire.classList.remove('armed'); }
    S.exposing = false;
    P.tiles = P.state === 'done' ? [] : P.tiles;
    render();
  }
}
export function pastingRelease() {
  if (P.state !== 'running') return;
  P.released = true;
}
function abort() { P.released = true; P.state = 'incomplete'; }

/* Join the images, then hand the one long image to the console's processing. */
function publish() {
  const S = C.S, plan = P.plan, f = P.focal, t0 = P.tiles[0];
  const { nx, ny, pxU, pxV } = t0;
  const geo = { nx, ny, pxV, spanBot: plan.spanBot, spanTop: plan.spanTop, feather: plan.overlap };
  // each image keeps the quantum noise of its own exposure (an AEC may have ended them at very
  // different mAs): read out image by image, then matched and blended with the dose
  for (const t of P.tiles) t.sig = C.detectorSignal(t);
  const st = stitchTiles(P.tiles, { ...geo, planes: ['dose', 'direct', 'sig'] });
  // and what the receptor actually received, unmatched: the exposure index is of that
  const raw = stitchTiles(P.tiles, { ...geo, gains: P.tiles.map(() => 1) });
  const h = C.receptorGap() + P.coi;                          // the COI plane's height over the receptor
  const M = magnification(f.H, h);
  const length = st.ny * pxV;
  const ticks = rulerTicks({ spanBot: plan.spanBot, spanTop: plan.spanBot + length, pxV, zf: f.zf, M });
  C.publishStitched({
    signal: st.arrays.sig, dose: st.arrays.dose, direct: st.arrays.direct, mask: st.mask, nx, ny: st.ny, pxU, pxV,
    rawDose: raw.arrays.dose, rawDirect: raw.arrays.direct,
    detH: +length.toFixed(2),
    ruler: { ticks, pxPerCm: M / pxV },
    paste: { n: plan.n, coi: P.coi, H: +f.H.toFixed(1), M, lengthAtCoi: anatomicalLength(plan.length, f.H, h),
             overlap: plan.overlap, angles: P.angles.slice(), gains: st.gains },
    tiles: P.tiles,
  });
}

/* ---- the panel ---- */
function render() {
  const panel = $('pastePanel'); if (!panel || !C) return;
  const S = C.S;
  panel.hidden = !P.proto;
  if (!P.proto) return;
  const busy = P.state === 'running' || P.state === 'moving';
  const name = $('ppProto'); if (name) name.textContent = P.proto.proj || '';
  const coi = $('ppCoi');
  if (coi && document.activeElement !== coi) coi.value = P.coi.toFixed(1);
  for (const [k, id] of [['upper', 'ppUpper'], ['lower', 'ppLower']]) {
    const b = $(id); if (!b) continue;
    b.classList.toggle('on', !!P[k]); b.disabled = busy;
    const v = $(id + 'V'); if (v) v.textContent = P[k] ? fmtCC(P[k].deg) : '—';
  }
  const cf = $('ppConfirm');
  if (cf) { cf.disabled = busy || !P.upper || !P.lower; cf.classList.toggle('on', !!P.plan); }
  const rs = $('ppReset'); if (rs) rs.disabled = P.state === 'moving';
  const cc = $('ppCC'); if (cc) { cc.value = S.angCC; cc.disabled = busy; }
  const ccv = $('ppCCv'); if (ccv) ccv.textContent = fmtCC(S.angCC);
  const st = $('ppStatus');
  if (st) {
    st.hidden = !P.plan;
    st.classList.remove('bad');
    st.classList.toggle('done', P.state === 'done');
    st.classList.toggle('inc', P.state === 'incomplete');
    if (P.plan) {
      $('ppCount').textContent = `${P.done}/${P.plan.n}`;
      const h = C.receptorGap() + P.coi;
      const note = P.state === 'incomplete' ? 'incomplete'
        : `${anatomicalLength(P.plan.length, P.focal.H, h).toFixed(1)} cm`;
      $('ppNote').textContent = note;
    }
  }
}
/* the tube was moved by another control: keep the panel's slider and readout with it */
export function pastingSync() { if (P.proto && P.state !== 'running') render(); }

// observability (dev + QC): the study as the panel holds it
if (typeof window !== 'undefined') window.__pasting = () => ({
  proto: P.proto?.proj || null, coi: P.coi, state: P.state, done: P.done,
  upper: P.upper, lower: P.lower, focal: P.focal,
  plan: P.plan && { n: P.plan.n, centres: P.plan.centres, overlap: P.plan.overlap, length: P.plan.length },
  angles: P.angles,
});
