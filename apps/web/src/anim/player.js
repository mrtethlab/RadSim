/* THE ANIMATION PLAYER. Each mode has a film of its whole process, start to finish: a 3D scene
   of the real equipment for what is the size of a hand or bigger, the 8-bit layer (pixel.js) for
   what is smaller, the camera moving between the two scales. It plays on a loop, chapter by
   chapter, step by step; the learner can pause, step, jump to a chapter, mute.

   By default a step HOLDS when it ends: its time runs on (frame(t) is called with t past dur), the
   camera stays on its last key, its last caption stays up, until the viewer presses next. With
   AUTOPLAY on (the toggle under play), the film runs on from step to step and loops. So a frame
   must stay sensible for t well past dur (streams that keep flowing, not ones that run dry).

   A film is a module under ./films exporting build(api) -> { title, chapters }:
     chapters: [{ title, steps: [step] }]
     step: {
       title,                      the step's name (the step rail's tooltip)
       dur,                        seconds
       cam,                        [[t, [x,y,z] position, [x,y,z] target, fov?], ...] (eased between
                                   keys) or (t) => ({ pos, look, fov })
       enter(),                    on becoming the current step (also on a jump): set what shows
       frame(t, dt),               every frame: move things, draw the 8-bit layer (api.px)
       caption: [{ from, to, text, at? }]   the one caption on screen; at() -> [x, y] in 8-bit
                                   pixels draws a leader from it to that point
       cues: [[t, fn]],            sounds and one-off events, fired when play crosses t
       scale,                      the scale bar's label ('10 cm', '1 µm'), or null
       fadeIn, fadeOut,            seconds of black at the step's start / end
       bg,                         the 3D view's background colour (default the room's)
     }
   Every frame is a function of the step's time alone, so a jump lands exactly where a play
   would have. Films seed their randomness (pixel.js rng) for the same reason. */
import * as THREE from 'three';
import { PixelLayer, PAL, rng, sprite } from './pixel.js';
import { sfx } from './sfx.js';

// a film is a file: ./films/<mode>.js, loaded only when it is opened
const FILMS = Object.fromEntries(Object.entries(import.meta.glob('./films/*.js'))
  .map(([path, load]) => [path.match(/([^/]+)\.js$/)[1], load]));
export const hasFilm = (mode) => !!FILMS[mode];

export const ease = {
  linear: (x) => x,
  inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  out: (x) => 1 - Math.pow(1 - x, 3),
  in: (x) => x * x * x,
};
export const clamp01 = (x) => Math.max(0, Math.min(1, x));
// where t sits in [a, b], 0..1, eased
export const span = (t, a, b, e = ease.inOut) => e(clamp01((t - a) / (b - a)));
export const lerp = (a, b, k) => a + (b - a) * k;
export const lerp3 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];

let P = null;            // the open player

function el(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}

function buildDom() {
  const root = el('div', 'anim', document.body);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Process animation');
  const stage = el('div', 'anim-stage', root);
  const c3 = el('canvas', 'anim-3d', stage);
  const cp = el('canvas', 'anim-px', stage);
  const fade = el('div', 'anim-fade', stage);
  const load = el('div', 'anim-load', stage, '<span>Loading</span>');
  const cap = el('div', 'anim-cap', stage);
  const scale = el('div', 'anim-scale', stage, '<i></i><span></span>');
  const top = el('div', 'anim-top', root);
  const title = el('div', 'anim-title', top);
  const chaps = el('div', 'anim-chaps', top);
  const close = el('button', 'anim-x', top, '&#10005;');
  close.title = 'Close (Esc)';
  const bar = el('div', 'anim-bar', root);
  const ctl = el('div', 'anim-ctl', bar);
  const prev = el('button', '', ctl, '&#9198;'); prev.title = 'Previous step (←)';
  // play, and under it the autoplay toggle: off, a step holds its shot when it ends until next
  // is pressed; on, the film runs on from step to step and loops
  const stack = el('div', 'anim-playstack', ctl);
  const play = el('button', 'anim-play', stack, '&#10074;&#10074;'); play.title = 'Play / pause (Space)';
  const auto = el('button', 'anim-auto', stack, 'AUTO'); auto.title = 'Autoplay: run on to the next step by itself (A)';
  const next = el('button', '', ctl, '&#9197;'); next.title = 'Next step (→)';
  const steps = el('div', 'anim-steps', bar);
  const right = el('div', 'anim-ctl', bar);
  const speed = el('button', 'anim-speed', right, '1&times;'); speed.title = 'Speed';
  const mute = el('button', '', right, '&#128264;'); mute.title = 'Sound on / off';
  const stepName = el('div', 'anim-stepname', root);
  return { root, stage, c3, cp, fade, load, cap, scale, title, chaps, close, prev, play, auto, next, steps, speed, mute, stepName };
}

export async function openAnimation(mode) {
  if (P) closeAnimation();
  if (!FILMS[mode]) return;
  sfx.unlock();
  const dom = buildDom();
  const renderer = new THREE.WebGLRenderer({ canvas: dom.c3, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0c0f);
  const cam = new THREE.PerspectiveCamera(40, 1, 0.05, 6000);
  const px = new PixelLayer(dom.cp, 200);
  // the mosaic: the 3D view drawn at a fraction of its resolution and scaled up with no
  // smoothing, the hand-over between the scales
  const mosaicRT = new THREE.WebGLRenderTarget(16, 16, { magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter });
  mosaicRT.texture.colorSpace = THREE.SRGBColorSpace;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ map: mosaicRT.texture, depthTest: false, depthWrite: false }));
  const quadScene = new THREE.Scene(); quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let autoplay = false;
  try { autoplay = localStorage.getItem('radsim.anim.autoplay') === '1'; } catch (_) { /* a per-viewer convenience */ }
  P = { mode, dom, renderer, scene, cam, px, film: null, tl: 0, pending: null, autoplay, playing: true, speed: 1, idx: -1,
        markCache: new Map(), marks: [], keep: [], capPos: null,
        mosaic: 0, raf: 0, last: 0, total: 0, flat: [], mosaicRT, quad, quadScene, quadCam, disposers: [] };

  const api = makeApi(P);
  wire(P);
  resize();
  addEventListener('resize', resize);
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVis);
  P.last = performance.now();
  loopFrame();                                   // the loading card animates while the film builds
  try {
    const mod = await FILMS[mode]();
    const film = await mod.build(api);
    if (!P || P.api !== api) return;             // closed while loading
    P.film = film;
    P.flat = [];
    film.chapters.forEach((c, ci) => c.steps.forEach((s, si) => {
      P.flat.push({ ...s, ci, si, t0: P.total });
      P.total += s.dur;
    }));
    dom.title.textContent = film.title;
    paintChapters();
    dom.load.hidden = true;
  } catch (e) {
    console.error('animation failed', e);
    dom.load.innerHTML = '<span>Could not load this animation.</span>';
  }
}
export function closeAnimation() {
  if (!P) return;
  cancelAnimationFrame(P.raf);
  sfx.stopAll();
  removeEventListener('resize', resize);
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('visibilitychange', onVis);
  for (const d of P.disposers) try { d(); } catch (_) { /* best effort */ }
  P.scene.traverse((o) => {
    o.geometry?.dispose?.();
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) { for (const k in m) if (m[k]?.isTexture) m[k].dispose(); m.dispose(); }
  });
  P.mosaicRT.dispose();
  P.renderer.dispose();
  P.renderer.forceContextLoss?.();
  P.dom.root.remove();
  P = null;
}

function makeApi(p) {
  const api = {
    THREE, scene: p.scene, camera: p.cam, renderer: p.renderer, px: p.px, PAL, sfx, rng, sprite, ease, span, lerp, lerp3, clamp01,
    // a world point -> the 8-bit layer's pixels (and whether it is in front of the camera)
    toPx(v) {
      const q = (v.isVector3 ? v.clone() : new THREE.Vector3(v[0], v[1], v[2])).project(p.cam);
      return [(q.x + 1) / 2 * p.px.W, (1 - q.y) / 2 * p.px.H, q.z < 1];
    },
    /* An object's screen box in 8-bit pixels. Its world box is measured once a step (from its
       vertices) and kept: a spinning anode's rotating bounds would set the brackets spinning too.
       live: measure every frame (an object that moves). */
    boxPx(obj, pad = 2, live = false) {
      let b = live ? null : p.markCache.get(obj);
      if (!b) { b = new THREE.Box3().setFromObject(obj, true); if (!live) p.markCache.set(obj, b); }
      if (b.isEmpty()) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < 8; i++) {
        const [x, y] = api.toPx([i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z]);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      return [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
    },
    // corner brackets round an object or a pixel box, blinking softly; the caption sits by it
    mark(target, color = 'yellow', t = 0, { live = false } = {}) {
      const b = Array.isArray(target) ? target : api.boxPx(target, 2, live);
      if (!b) return;
      const a = 0.65 + 0.35 * Math.sin(t * 6);
      p.px.brackets(b[0], b[1], b[2], b[3], color, a);
      p.marks.push(b);
    },
    // a box (8-bit pixels) the caption must not cover: a plot, a panel, an event's path
    keepOut(b) { p.keep.push(b); },
    mosaic(k) { p.mosaic = clamp01(k); },
    onDispose(fn) { p.disposers.push(fn); },
    loadGlb: async (url) => {
      const { loadModelUrl } = await import('../model/loader.js');
      return loadModelUrl(import.meta.env.BASE_URL + url);
    },
  };
  p.api = api;
  return api;
}

function wire(p) {
  const d = p.dom;
  d.close.addEventListener('click', closeAnimation);
  d.play.addEventListener('click', () => setPlaying(!p.playing));
  d.prev.addEventListener('click', () => jumpStep(-1));
  d.next.addEventListener('click', () => jumpStep(1));
  d.auto.addEventListener('click', () => setAutoplay(!p.autoplay));
  paintAuto();
  d.mute.addEventListener('click', () => { sfx.setMuted(!sfx.muted); paintMute(); if (sfx.muted) sfx.stopAll(); });
  d.speed.addEventListener('click', () => {
    const s = [0.5, 1, 1.5, 2], i = (s.indexOf(p.speed) + 1) % s.length;
    p.speed = s[i]; d.speed.innerHTML = (s[i] === 0.5 ? '½' : s[i]) + '&times;';
  });
  paintMute();
}
function paintMute() { if (P) P.dom.mute.innerHTML = sfx.muted ? '&#128263;' : '&#128264;'; }
function setPlaying(on) {
  P.playing = on;
  P.dom.play.innerHTML = on ? '&#10074;&#10074;' : '&#9654;';
  if (!on) sfx.stopAll();
}
function setAutoplay(on) {
  P.autoplay = on;
  try { localStorage.setItem('radsim.anim.autoplay', on ? '1' : '0'); } catch (_) { /* fine without it */ }
  paintAuto();
}
function paintAuto() { if (!P) return; P.dom.auto.classList.toggle('on', P.autoplay); P.dom.auto.setAttribute('aria-pressed', String(P.autoplay)); }
function jumpStep(d) {
  if (!P?.flat.length) return;
  const cur = P.idx < 0 ? 0 : P.idx;
  // back within the first second of a step goes to the one before; later, to this one's start
  const i = d < 0 && P.tl > 1 ? cur : (cur + d + P.flat.length) % P.flat.length;
  P.pending = i;
  sfx.stopAll();
}
function jumpTo(i) { if (!P?.flat[i]) return; P.pending = i; sfx.stopAll(); }

function paintChapters() {
  const d = P.dom;
  d.chaps.innerHTML = '';
  P.film.chapters.forEach((c, ci) => {
    const b = el('button', 'anim-chap', d.chaps, c.title);
    b.addEventListener('click', () => jumpTo(P.flat.findIndex((s) => s.ci === ci)));
  });
  d.steps.innerHTML = '';
  P.flat.forEach((s, i) => {
    const b = el('button', 'anim-seg', d.steps);
    b.style.flexGrow = String(s.dur);
    b.title = s.title || '';
    b.dataset.ci = s.ci;
    el('i', '', b);
    b.addEventListener('click', () => jumpTo(i));
  });
}

function resize() {
  if (!P) return;
  const r = P.dom.stage.getBoundingClientRect();
  P.renderer.setSize(r.width, r.height, false);
  P.cam.aspect = r.width / Math.max(1, r.height);
  P.cam.updateProjectionMatrix();
  P.px.resize(r.width, r.height);
}
function onKey(e) {
  if (!P) return;
  if (e.key === 'Escape') { closeAnimation(); e.preventDefault(); }
  else if (e.key === ' ') { setPlaying(!P.playing); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { jumpStep(1); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { jumpStep(-1); e.preventDefault(); }
  else if (e.key === 'a' || e.key === 'A') setAutoplay(!P.autoplay);
}
function onVis() { if (P && document.hidden) sfx.stopAll(); }

function camAt(step, t) {
  const c = step.cam;
  if (!c) return null;
  if (typeof c === 'function') return c(t);
  if (t <= c[0][0]) return { pos: c[0][1], look: c[0][2], fov: c[0][3] };
  for (let i = 0; i < c.length - 1; i++) {
    const a = c[i], b = c[i + 1];
    if (t <= b[0]) {
      const k = ease.inOut((t - a[0]) / Math.max(1e-6, b[0] - a[0]));
      return { pos: lerp3(a[1], b[1], k), look: lerp3(a[2], b[2], k),
               fov: a[3] != null && b[3] != null ? lerp(a[3], b[3], k) : (b[3] ?? a[3]) };
    }
  }
  const z = c[c.length - 1];
  return { pos: z[1], look: z[2], fov: z[3] };
}

function loopFrame() {
  if (!P) return;
  P.raf = requestAnimationFrame(loopFrame);
  const now = performance.now(), dt = Math.min(0.1, (now - P.last) / 1000);
  P.last = now;
  const p = P, d = p.dom;
  if (!p.flat.length) {                             // still loading: the 8-bit spinner
    p.px.clear();
    const k = Math.floor(now / 120) % 8;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      p.px.rect(p.px.W / 2 + Math.cos(a) * 10 - 1, p.px.H / 2 + Math.sin(a) * 10 - 1, 3, 3, i === k ? 'yellow' : 'dkgrey');
    }
    return;
  }
  /* The clock is the step's own. At a step's end: with autoplay, on to the next (the film loops
     after its last); without, the step holds: its time runs on in the last camera shot, its last
     caption stays, until next is pressed. */
  const prevTl = p.tl;
  if (p.playing && !document.hidden) p.tl += dt * p.speed;
  let enter = false;
  if (p.idx < 0) { p.idx = 0; p.tl = 0; enter = true; }
  if (p.pending != null) { p.idx = p.pending; p.pending = null; p.tl = 0.001; enter = true; }
  else if (p.autoplay && p.tl >= p.flat[p.idx].dur) { p.tl -= p.flat[p.idx].dur; p.idx = (p.idx + 1) % p.flat.length; enter = true; }
  const i = p.idx, st = p.flat[i], t = p.tl;
  if (enter) {
    const wasPlaying = p.playing;
    if (!st.keepSound) sfx.stopAll();
    p.mosaic = 0;
    p.markCache.clear();
    p.scene.background = new THREE.Color(st.bg ?? 0x0a0c0f);
    st.enter?.();
    paintProgress();
    d.stepName.textContent = st.title || '';
    d.stepName.classList.remove('show'); void d.stepName.offsetWidth; d.stepName.classList.add('show');
    if (wasPlaying) for (const [ct, fn] of st.cues || []) if (ct <= t && ct >= 0 && t - ct < 0.05) fn();
  } else if (p.playing) {
    for (const [ct, fn] of st.cues || []) if (prevTl < ct && ct <= t) fn();
  }
  const c = camAt(st, t);
  if (c) {
    p.cam.position.set(...c.pos);
    p.cam.lookAt(...c.look);
    if (c.fov && c.fov !== p.cam.fov) { p.cam.fov = c.fov; p.cam.updateProjectionMatrix(); }
  }
  p.px.clear();
  p.marks.length = 0; p.keep.length = 0;
  st.frame?.(t, p.playing ? dt * p.speed : 0);
  // the frame may move the camera itself; draw after it has
  if (st.view === 'pixel') {
    p.renderer.setClearColor(0x000000, 1);
    p.renderer.clear();
  } else if (p.mosaic > 0.001) {
    const r = d.stage.getBoundingClientRect();
    const div = 1 + p.mosaic * p.mosaic * 60;
    const w = Math.max(2, Math.round(r.width / div)), h = Math.max(2, Math.round(r.height / div));
    if (p.mosaicRT.width !== w || p.mosaicRT.height !== h) p.mosaicRT.setSize(w, h);
    p.renderer.setRenderTarget(p.mosaicRT);
    p.renderer.render(p.scene, p.cam);
    p.renderer.setRenderTarget(null);
    p.renderer.render(p.quadScene, p.quadCam);
  } else {
    p.renderer.render(p.scene, p.cam);
  }
  // fades
  let f = 0;
  if (st.fadeIn && t < st.fadeIn) f = 1 - t / st.fadeIn;
  // (a held step does not fade out: it is waiting on the viewer)
  if (st.fadeOut && p.autoplay && t > st.dur - st.fadeOut) f = Math.max(f, (t - (st.dur - st.fadeOut)) / st.fadeOut);
  d.fade.style.opacity = String(clamp01(f));
  // the caption: one at a time, next to what it is about
  const held = t >= st.dur;
  let cap = (st.caption || []).find((k) => t >= k.from && t < k.to);
  if (held) cap = [...(st.caption || [])].reverse().find((k) => k.from < st.dur);   // held: its last caption stays
  if (cap) {
    if (d.cap.dataset.text !== cap.text) {
      d.cap.dataset.text = cap.text;
      d.cap.innerHTML = cap.text;
      p.capPos = null;                                        // a new caption: placed afresh
    }
    d.cap.classList.add('show');
    const k = held ? 1 : clamp01(Math.min(t - cap.from, cap.to - t) / 0.35);
    d.cap.style.opacity = String(k);
    placeCaption(p, cap, t);
  } else {
    d.cap.classList.remove('show');
    d.cap.dataset.text = '';
    p.capPos = null;
  }
  // the scale bar
  if (st.scale) { d.scale.hidden = false; d.scale.querySelector('span').textContent = typeof st.scale === 'function' ? st.scale(t) : st.scale; }
  else d.scale.hidden = true;
  // progress within the step
  const seg = d.steps.children[i];
  if (seg) seg.firstChild.style.width = (100 * clamp01(t / st.dur)) + '%';
}
/* Where the caption goes: right under what it is about (the point it names, or the brackets
   drawn this frame), so the eye does not cross the screen to read it; above it, or beside it,
   when that would cover the highlight, a panel or an event's path (api.keepOut), or run off the
   frame. Eased, so it does not jitter with a moving camera. With nothing to sit by, bottom left. */
function placeCaption(p, cap, t) {
  const d = p.dom, sr = d.stage.getBoundingClientRect();
  const cw = d.cap.offsetWidth, ch = d.cap.offsetHeight;
  const sx = sr.width / p.px.W, sy = sr.height / p.px.H, M = 12, G = 12;
  let anchor = null;
  if (cap.at) { const a = cap.at(t); if (a) anchor = [a[0] - 2, a[1] - 2, 4, 4]; }
  if (!anchor && p.marks.length) anchor = p.marks[p.marks.length - 1];
  let x = M, y = sr.height - ch - M;
  if (anchor && !cap.corner) {
    const A = { l: anchor[0] * sx, t: anchor[1] * sy, r: (anchor[0] + anchor[2]) * sx, b: (anchor[1] + anchor[3]) * sy };
    const cx = (A.l + A.r) / 2, cy = (A.t + A.b) / 2;
    const obst = [...p.keep, ...p.marks].map((k) => ({ l: k[0] * sx, t: k[1] * sy, r: (k[0] + k[2]) * sx, b: (k[1] + k[3]) * sy }));
    const fits = (r) => r.l >= M && r.t >= M && r.r <= sr.width - M && r.b <= sr.height - M;
    const clear = (r) => obst.every((o) => r.r <= o.l || r.l >= o.r || r.b <= o.t || r.t >= o.b);
    const clampX = (v) => Math.max(M, Math.min(sr.width - cw - M, v));
    const clampY = (v) => Math.max(M, Math.min(sr.height - ch - M, v));
    const at = {
      below: () => [clampX(cx - cw / 2), A.b + G],
      above: () => [clampX(cx - cw / 2), A.t - G - ch],
      right: () => [A.r + G, clampY(cy - ch / 2)],
      left: () => [A.l - G - cw, clampY(cy - ch / 2)],
    };
    const order = cap.place ? [cap.place, 'below', 'above', 'right', 'left'] : ['below', 'above', 'right', 'left'];
    let best = null;
    for (const o of order) {
      const [px_, py_] = at[o](), r = { l: px_, t: py_, r: px_ + cw, b: py_ + ch };
      if (fits(r) && clear(r)) { best = [px_, py_]; break; }
    }
    if (!best) best = [M, sr.height - ch - M];               // no room round it: the corner, not over it
    [x, y] = best;
  }
  if (!p.capPos) p.capPos = [x, y];
  else { p.capPos[0] += (x - p.capPos[0]) * 0.18; p.capPos[1] += (y - p.capPos[1]) * 0.18; }
  d.cap.style.left = Math.round(p.capPos[0]) + 'px';
  d.cap.style.top = Math.round(p.capPos[1]) + 'px';
  d.cap.style.bottom = 'auto';
  // a short leader to a named point
  if (cap.at) {
    const a = cap.at(t);
    if (a) {
      const bx = Math.min(Math.max(a[0], p.capPos[0] / sx), (p.capPos[0] + cw) / sx);
      const by = (p.capPos[1] > a[1] * sy ? p.capPos[1] : p.capPos[1] + ch) / sy;
      p.px.line(bx, by, a[0], a[1], 'yellow', 0.7, 2);
      p.px.rect(a[0] - 1, a[1] - 1, 3, 3, 'yellow', 0.9);
    }
  }
}
function paintProgress() {
  const p = P, d = p.dom;
  [...d.steps.children].forEach((b, j) => {
    b.classList.toggle('done', j < p.idx);
    b.classList.toggle('on', j === p.idx);
    b.firstChild.style.width = j < p.idx ? '100%' : '0%';
  });
  const ci = p.flat[p.idx].ci;
  [...d.chaps.children].forEach((b, j) => b.classList.toggle('on', j === ci));
}
