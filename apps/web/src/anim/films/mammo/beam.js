/* MAMMOGRAPHY FILM, chapter 2: the beam. Down into the molybdenum target from the side view (the
   electrons arriving from the cathode on the chest-wall side): bremsstrahlung, then molybdenum's
   own K lines at 17.5 and 19.6 keV; out through the filter slide, and down into its foil, where the
   K-edge cuts the spectrum on both sides (molybdenum, then rhodium); the five target/filter pairs;
   the kV, 25 to 32. All spectra are phys.js's: Kramers' continuum, the beryllium window, the
   foil's own attenuation with its K-edge, the target's lines above its K binding energy. */
import * as THREE from 'three';
import { setOpacity } from '../../kit/stage.js';
import { makeParticles, coneDir } from '../../kit/flux.js';
import { FOCAL, TUBE_TILT, electronStream } from './rig.js';
import { spectrum, foilT, mkeV, mSpectrumPlot, METAL, TFS } from './phys.js';
import { moTarget, foilScene } from './fields.js';
import { loopParticles, hud } from './common.js';

export async function beamChapter(api, S) {
  const { px, sfx, span, lerp } = api;
  const R = S.R, T = R.tube;
  const insideHead = () => {
    S.only('unit');
    R.gantry.rotation.z = 0; R.tubeArm.rotation.z = 0; R.setPaddle(12); R.setCompression(1);
    R.inside.visible = false; R.beam.visible = false;
    for (const o of [R.tubeHead, R.nose, R.snout, R.trim]) setOpacity(o, 0.1);
    setOpacity(R.plate, 1);
    T.g.visible = true; setOpacity(T.housing, 0.08); T.collBox.visible = true;
    T.filMat.emissiveIntensity = 1.4; T.spotMat.opacity = 0.9; T.lampMat.emissiveIntensity = 0;
  };
  const spinAt = (t) => t * 3400 / 60 * Math.PI * 2 * 0.06;

  // ---- the spectra (normalised to the unfiltered target's peak, so filtering shows as loss)
  const moRaw = spectrum('Mo', 28), pk = moRaw.peak;
  const n = (f, k = pk) => (E) => f(E) / k;
  const moBrems = spectrum('Mo', 28, { lines: false });
  const moMo = spectrum('MoMo', 28), moRh = spectrum('MoRh', 28);
  const sampleRaw = (r) => { for (let k = 0; k < 400; k++) { const E = 6 + r() * 22; if (r() * pk < moRaw(E)) return E; } return 17.5; };

  // ---- the filter slide in 3D: photons from the focal spot, through the window, into the foil
  R.unit.updateMatrixWorld(true);
  const axis = [0, -Math.cos(TUBE_TILT), -Math.sin(TUBE_TILT)];
  const foilAt = () => { R.unit.updateMatrixWorld(true); return R.foilMo.getWorldPosition(new THREE.Vector3()).toArray(); };
  const fP = foilAt();
  const foilDist = (dir) => {                          // along dir from the focal spot to the foil's plane
    const nn = axis, d = (fP[0] - FOCAL[0]) * nn[0] + (fP[1] - FOCAL[1]) * nn[1] + (fP[2] - FOCAL[2]) * nn[2];
    return d / (dir[0] * nn[0] + dir[1] * nn[1] + dir[2] * nn[2]);
  };
  const PER = 3;
  const out = makeParticles(380, 52, (i, r) => {
    const E = sampleRaw(r), dir = coneDir(r, axis, 0.3), dF = foilDist(dir), u = r();
    return { i, t0: (i / 380) * PER, from: FOCAL, dir, v: 16, E, dF, u, end: 22 };
  });
  const fateOut = (p, metal, um) => (p.u > foilT(metal, p.E, um) ? { ...p, end: p.dF } : p);

  // ---- the target/filter pairs: their spectra at a typical kV, each by its own peak
  const PAIRS = [['MoMo', 26, 'Mo/Mo'], ['MoRh', 28, 'Mo/Rh'], ['RhRh', 30, 'Rh/Rh'], ['WRh', 29, 'W/Rh'], ['WAg', 31, 'W/Ag']]
    .map(([k, kv, lab]) => { const f = spectrum(k, kv); return { k, kv, lab, f: n(f, f.peak), mean: f.mean, d: TFS[k] }; });

  const sideCam = (d) => [FOCAL[0] + d, FOCAL[1], FOCAL[2]];
  const steps = [
    {
      title: 'Into the molybdenum target', dur: 5, scale: (t) => (t < 1.6 ? '1 cm' : t < 3 ? '10 µm' : '100 pm'),
      enter() { insideHead(); },
      cam: [[0, sideCam(30), FOCAL, 36], [5, sideCam(0.35), FOCAL, 30]],
      cues: [[0.3, () => sfx.whoosh()]],
      frame(t) {
        T.spin.rotation.x = spinAt(t); electronStream(api, R, t, 0.5);
        api.mosaic(span(t, 2, 4.6));
        if (t > 3.9) { px.alpha = span(t, 3.9, 5); moTarget(api, t, { rate: 5 }); px.alpha = 1; }
      },
    },
    {
      title: 'Bremsstrahlung in molybdenum', dur: 13, view: 'pixel', scale: '100 pm',
      cues: [[3.7, () => sfx.pew(1500)]],
      frame(t) {
        const panel = [px.W - 104, 4, 100, 62];
        moTarget(api, t + 10, { rate: 4, hi: 'brems', hiAt: 11, every: 10, slow: 3, avoid: [panel], showHeat: false });
        mSpectrumPlot(px, ...panel, 28, n(moBrems), { fill: span(t, 4, 11), axisMax: 35 });
        api.keepOut(panel);
      },
      caption: [
        { from: 0.8, to: 6, text: 'A field of molybdenum atoms (Z = 42). Electrons arrive from the cathode on the left; one passing close to a nucleus is bent and braked, and radiates a photon: <b>bremsstrahlung</b>.' },
        { from: 6, to: 13, text: 'At 28 kV that continuum runs from almost nothing to <b>28 keV</b>, most of it soft. As in any tube, nearly all the electrons’ energy ends as heat.' },
      ],
    },
    {
      title: 'Molybdenum’s K lines', dur: 15, view: 'pixel', scale: '100 pm',
      cues: [[3.4, () => sfx.blip(660)], [5.4, () => sfx.ping(1568)], [12.4, () => sfx.blip(660)], [14.4, () => sfx.ping(1760)]],
      frame(t) {
        const panel = [px.W - 104, 4, 100, 62];
        moTarget(api, t + 30, { rate: 4, hi: 'alt', hiAt: 31, every: 9, slow: 3, avoid: [panel], showHeat: false });
        mSpectrumPlot(px, ...panel, 28, n(moRaw), { fill: 1, axisMax: 35, lines: [17.5, 19.6] });
        api.keepOut(panel);
      },
      caption: [
        { from: 1, to: 4.4, text: 'An electron with more than <b>20 keV</b>, molybdenum’s K-shell binding energy, can knock a K electron out of its atom.' },
        { from: 4.4, to: 9.6, text: 'An L electron drops into the hole and the difference leaves as a photon of molybdenum’s own energy: <b>17.5 keV</b> (K-alpha).' },
        { from: 9.6, to: 15, text: 'Filled from the M shell instead, the photon carries <b>19.6 keV</b> (K-beta). Both lie in the 15–20 keV band that suits an average breast.' },
      ],
    },
    {
      title: 'The filter slide', dur: 15, scale: (t) => (t < 11.5 ? '1 cm' : t < 13.5 ? '100 µm' : '10 µm'),
      enter() { insideHead(); R.filterSlide.position.x = 0; },
      cam: [[0, sideCam(0.35), FOCAL, 30], [3, [FOCAL[0] + 22, FOCAL[1] - 3, FOCAL[2] - 6], [fP[0], fP[1] + 1, fP[2]], 36],
        [11, [FOCAL[0] + 18, FOCAL[1] - 5, FOCAL[2] - 9], [fP[0], fP[1], fP[2]], 36], [14.6, [fP[0] + 0.6, fP[1] + 0.05, fP[2] + 0.1], [fP[0], fP[1], fP[2]], 36]],
      cues: [[0.1, () => sfx.whoosh()], [6.5, () => sfx.click()], [9, () => sfx.click()], [11.5, () => sfx.whoosh()]],
      frame(t) {
        // out of the target; at the end, down into the molybdenum foil
        api.mosaic(Math.max(1 - span(t, 0, 2), span(t, 11.8, 14.4)));
        T.spin.rotation.x = spinAt(t); electronStream(api, R, t, 0.5);
        sfx.hold('rotor', 800, 0.035, 'square');
        // the slide brings its rhodium foil under the port, then back
        const sl = span(t, 6.5, 7.5) - span(t, 9, 10);
        R.filterSlide.position.x = -7 * sl;
        const metal = sl < 0.5 ? 'Mo' : 'Rh', um = metal === 'Mo' ? 30 : 25;
        loopParticles(api, out.map((p) => fateOut(p, metal, um)), t, PER, (p, s) => ({ kind: 'photon', color: mkeV(p.E), flashColor: 'grey' }), { tail: 4 });
        if (t > 2.5 && t < 6.5) api.mark(R.foilMo, 'yellow', t);
        if (t > 7.5 && t < 9) api.mark(R.foilRh, 'yellow', t, { live: true });
        if (t > 13.8) { px.alpha = span(t, 13.8, 15); foilScene(api, t, { metal: 'Mo', um: 30, sample: sampleRaw }); px.alpha = 1; }
      },
      caption: [
        { from: 2.5, to: 6.5, text: 'Under the window, a <b>filter</b>: a foil of metal only 30 µm thick, molybdenum here, that the whole beam must cross.' },
        { from: 6.5, to: 10.5, text: 'The slide can swap in a <b>rhodium</b> foil (25 µm) for a thicker breast. The AEC chooses which.' },
      ],
    },
    {
      title: 'The molybdenum filter: a K-edge', dur: 16, view: 'pixel', scale: '10 µm',
      enter() { R.filterSlide.position.x = 0; },
      cues: [[0.2, () => sfx.whoosh()], [3.2, () => sfx.zap()], [10.2, () => sfx.zap()]],
      frame(t) {
        const r = foilScene(api, t + 3, { metal: 'Mo', um: 30, sample: sampleRaw, hiE: 21.5, hiAt: 4.2, every: 7 });
        const panel = [px.W - 104, px.H - 64, 100, 60];
        const k = span(t, 7, 10);
        mSpectrumPlot(px, ...panel, 28, n((E) => moRaw(E) * lerp(1, foilT('Mo', E, 30), k)), { before: n(moRaw), axisMax: 35, edges: [20], lines: [17.5, 19.6], curve: k > 0 ? (E) => foilT('Mo', E, 30) * k : null });
        api.keepOut(panel);
        void r;
      },
      caption: [
        { from: 0.6, to: 6.5, text: 'Inside the foil. A photon just above <b>20 keV</b> can free a molybdenum K electron, so it is absorbed far more often than one just below: that jump is the <b>K-edge</b>.' },
        { from: 6.5, to: 11.5, text: 'The foil also absorbs the softest photons (below about 15 keV), which would stop in the skin and only add dose. The white line is what it lets through.' },
        { from: 11.5, to: 16, text: 'What leaves is a narrow band, 15 to 20 keV, the molybdenum lines kept, the rest cut away on <b>both sides</b>: a nearly single-energy beam.' },
      ],
    },
    {
      title: 'The rhodium filter', dur: 13, view: 'pixel', scale: '10 µm',
      cues: [[3.2, () => sfx.zap()]],
      frame(t) {
        foilScene(api, t + 3, { metal: 'Rh', um: 25, sample: sampleRaw, hiE: 21.5, hiAt: 4.2, every: 7 });
        const panel = [px.W - 104, px.H - 64, 100, 60];
        mSpectrumPlot(px, ...panel, 28, n(moRh), { before: n(moMo), axisMax: 35, edges: [20, 23.2], lines: [17.5, 19.6], curve: (E) => foilT('Rh', E, 25) });
        api.keepOut(panel);
      },
      caption: [
        { from: 0.6, to: 6.5, text: 'Rhodium’s K-edge is higher, at <b>23.2 keV</b>: the 20–23 keV photons molybdenum would have stopped now pass, like this one.' },
        { from: 6.5, to: 13, text: 'Mo/Rh is a slightly harder beam (the grey outline is Mo/Mo), for a thicker or denser breast: more gets through, for less dose.' },
      ],
    },
    {
      title: 'Target and filter pairs', dur: 14, view: 'pixel', scale: null,
      frame(t) {
        px.fillAll('ink');
        const W = px.W, H = px.H, cw = Math.floor((W - 16) / 3), ch = Math.floor((H - 24) / 2);
        PAIRS.forEach((p, i) => {
          const cx = 6 + (i % 3) * (cw + 2) + (i >= 3 ? cw / 2 : 0), cy = 8 + Math.floor(i / 3) * (ch + 6);
          const a = span(t, 0.4 + i * 0.7, 1.2 + i * 0.7);
          if (a <= 0) return;
          px.alpha = a;
          const plot = mSpectrumPlot(px, cx, cy + 10, cw - 2, ch - 12, p.kv, p.f, { axisMax: 35, edges: p.d.filter ? [METAL[p.d.filter].edge] : [], lines: p.d.target !== 'W' ? [METAL[p.d.target].ka, METAL[p.d.target].kb] : [] });
          px.text(p.lab, cx + 2, cy + 2, 'white');
          px.text(p.kv + ' kV', cx + cw - 4, cy + 2, 'mid', 1, 1, 'right');
          // the mean energy, marked on the axis
          const mx = plot.xAt(p.mean);
          px.rect(mx, plot.y0 - plot.ph, 1, plot.ph, 'white', 0.35);
          px.text(p.mean.toFixed(1), mx, plot.y0 - plot.ph - 6 + 0, 'yellow', 1, 1, 'center');
          px.alpha = 1;
          api.keepOut([cx, cy, cw - 2, ch - 2]);
        });
        const hi = t < 6 ? [0, 1] : t < 9.5 ? [2] : [3, 4];
        for (const i of hi) {
          const cx = 6 + (i % 3) * (cw + 2) + (i >= 3 ? cw / 2 : 0), cy = 8 + Math.floor(i / 3) * (ch + 6);
          if (t > 2.5) api.mark([cx - 2, cy - 2, cw + 2, ch + 2], 'yellow', t);
        }
      },
      caption: [
        { from: 2.5, to: 6, text: 'Each target is paired with a filter whose K-edge sits just above the energies wanted. Molybdenum targets: <b>Mo/Mo</b> for thin breasts, <b>Mo/Rh</b> for thicker.' },
        { from: 6, to: 9.5, text: '<b>Rh/Rh</b>: rhodium’s own lines, 20.2 and 22.7 keV, under its own edge: harder again.' },
        { from: 9.5, to: 14, text: 'A <b>tungsten</b> target has no K lines at these kV but makes more bremsstrahlung; rhodium or silver (edge 25.5 keV) shape it into a band. The yellow number is each beam’s mean energy, keV.' },
      ],
    },
    {
      title: 'Low kV: 25 to 32', dur: 13, view: 'pixel', scale: null,
      frame(t) {
        px.fillAll('ink');
        const kv = t < 2 ? 25 : t < 7 ? lerp(25, 32, span(t, 2, 7)) : t < 9 ? 32 : lerp(32, 28, span(t, 9, 11));
        const f = spectrum('MoRh', kv), ref = spectrum('MoRh', 32).peak;
        const W = px.W, H = px.H, pw = Math.min(W - 24, 200), x = Math.round((W - pw) / 2), y = 20, h = H - 70;
        const plot = mSpectrumPlot(px, x, y, pw, h, kv, n(f, ref), { axisMax: 35, edges: [20, 23.2], lines: [17.5, 19.6] });
        api.keepOut([x, y - 14, pw, h + 14]);
        const mx = plot.xAt(f.mean);
        px.rect(mx, plot.y0 - plot.ph, 1, plot.ph, 'white', 0.4);
        hud(api, [['kV', String(Math.round(kv)), 'yellow'], ['mean', f.mean.toFixed(1), 'yellow']], { w: 52, x: x + pw - 52, y: y + 2 });
        api.mark([x, y, pw, h], 'yellow', t);
      },
      caption: [
        { from: 0.6, to: 7, text: 'Mammography runs at only <b>25–32 kV</b>, against 50–120 kV for the rest of radiography.' },
        { from: 7, to: 13, text: 'Within that range a thicker, denser breast gets a higher kV and a harder target/filter; the K-edge still trims the top, so the mean energy rises by only a keV or two.' },
      ],
    },
  ];
  void hud; void setOpacity;
  return { title: 'The beam: target and filter', steps };
}
