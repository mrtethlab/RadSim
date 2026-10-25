/* 8-BIT SOUND for the films: square, triangle and noise channels, made as they play (no files).
   One-shots for events (an electron striking, a photon absorbed, a row read out) and a few
   held tones (the filament's hum, the rotor's whine) whose pitch a film can steer. Quiet by
   design: a cue, not a soundtrack. */
let ac = null, master = null, muted = false;
const loops = new Map();

function ctx() {
  if (!ac) {
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      master = ac.createGain(); master.gain.value = muted ? 0 : 0.18; master.connect(ac.destination);
    } catch (_) { ac = null; }
  }
  if (ac && ac.state === 'suspended') ac.resume();
  return ac;
}
let noiseBuf = null;
function noise() {
  if (!noiseBuf) {
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    // 8-bit noise: a short-period LFSR, held for a few samples, not white hiss
    let r = 1, v = 0;
    for (let i = 0; i < d.length; i++) {
      if (i % 4 === 0) { r ^= r << 7; r ^= r >> 9; r &= 0xffff; v = (r & 1) ? 1 : -1; }
      d[i] = v;
    }
  }
  return noiseBuf;
}

export const sfx = {
  setMuted(m) {
    muted = m;
    if (master) master.gain.setTargetAtTime(m ? 0 : 0.18, ac.currentTime, 0.02);
  },
  get muted() { return muted; },
  unlock() { ctx(); },
  // a tone sweeping f0 -> f1 over dur seconds with a quick attack and a decay
  tone(f0, f1 = f0, dur = 0.12, type = 'square', vol = 0.5, delay = 0) {
    if (muted || !ctx()) return;
    const t = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
  },
  hiss(dur = 0.2, vol = 0.3, hp = 1000, delay = 0) {
    if (muted || !ctx()) return;
    const t = ac.currentTime + delay, s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noise(); f.type = 'highpass'; f.frequency.value = hp;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + dur + 0.02);
  },
  // the presets the films use
  blip(f = 880) { this.tone(f, f, 0.06, 'square', 0.35); },
  zap() { this.tone(1400, 180, 0.14, 'square', 0.35); },
  pew(f = 1800) { this.tone(f, f * 0.45, 0.09, 'square', 0.3); },
  ping(f = 1320) { this.tone(f, f, 0.22, 'triangle', 0.5); this.tone(f * 2, f * 2, 0.12, 'triangle', 0.2, 0.02); },
  thud() { this.tone(160, 50, 0.18, 'triangle', 0.7); this.hiss(0.08, 0.25, 300); },
  click() { this.hiss(0.025, 0.4, 2500); },
  tick() { this.tone(2600, 2600, 0.02, 'square', 0.25); },
  chime() { [0, 4, 7, 12].forEach((s, i) => this.tone(660 * 2 ** (s / 12), 660 * 2 ** (s / 12), 0.18, 'triangle', 0.4, i * 0.07)); },
  power() { this.tone(110, 440, 0.5, 'square', 0.25); },
  down() { this.tone(520, 90, 0.35, 'square', 0.25); },
  whoosh() { this.hiss(0.35, 0.18, 600); },
  /* A held tone, by name, its pitch and level steered by the film each frame (hold(id, f, v));
     stop(id) or stopAll() fades it out. */
  hold(id, freq, vol = 0.2, type = 'square') {
    if (muted || !ctx()) { this.stop(id); return; }
    let L = loops.get(id);
    if (!L) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.value = freq; g.gain.value = 0;
      o.connect(g); g.connect(master); o.start();
      L = { o, g }; loops.set(id, L);
    }
    L.o.frequency.setTargetAtTime(freq, ac.currentTime, 0.03);
    L.g.gain.setTargetAtTime(vol, ac.currentTime, 0.04);
  },
  stop(id) {
    const L = loops.get(id);
    if (!L) return;
    loops.delete(id);
    try { L.g.gain.setTargetAtTime(0, ac.currentTime, 0.04); L.o.stop(ac.currentTime + 0.3); } catch (_) { /* already stopped */ }
  },
  stopAll() { for (const id of [...loops.keys()]) this.stop(id); },
};
