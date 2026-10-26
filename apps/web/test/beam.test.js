// The ultrasound beam model (core/beam.js): widths, sub-ray nodes, the beam's transmission past
// an obstacle (the soft shadow), and reverberation (the dirty one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KA, beamWidth, txAperture, rxWidth, twoWay, beamAt, profileNodes, ELEV_NODES, beamTransmission, addReverb, obliqueInterface } from '../src/core/beam.js';
import { reverbCoherence } from '../src/core/acoustics.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

test('a focused beam is KA lambda F / D at the focus, wider either side, and finer with frequency', () => {
  const lam = 0.154 / 3.5, F = 8, D = 8 / 3;
  near(beamWidth(F, F, D, lam), KA * lam * F / D, 1e-12, 'width at the focus');
  assert.ok(beamWidth(3, F, D, lam) > 2 * beamWidth(F, F, D, lam), 'shallow of the focus: converging, wider');
  assert.ok(beamWidth(16, F, D, lam) > 4 * beamWidth(F, F, D, lam), 'past the focus: diverging, wider');
  // the waist sits at (or a little shallow of) the focus
  let best = 0, bw = 1e9;
  for (let r = 0.1; r < 20; r += 0.05) { const w = beamWidth(r, F, D, lam); if (w < bw) { bw = w; best = r; } }
  assert.ok(best <= F + 1e-9 && best > 0.8 * F, `waist at ${best}`);
  // diffraction alone (no geometric cone) spreads in proportion to depth: a far-field angle
  near(beamWidth(2 * F, F, D, lam, 0), 2 * beamWidth(F, F, D, lam, 0), 1e-12, 'diffraction grows with depth');
  // frequency buys focal resolution: 7 MHz focuses twice as fine as 3.5
  near(beamWidth(F, F, D, lam / 2) / beamWidth(F, F, D, lam), 0.5, 1e-9, 'width ratio');
});

test('apertures: transmit F-number until the face runs out; receive focuses dynamically', () => {
  near(txAperture(6, 3, 3.5), 2, 1e-12, 'F/F#');
  near(txAperture(16, 3, 3.5), 3.5, 1e-12, 'capped by the face');
  const lam = 0.044;
  near(rxWidth(4, lam, 3, 3.5), KA * 3 * lam, 1e-12, 'constant F# while the aperture grows');
  near(rxWidth(21, lam, 3, 3.5), KA * 6 * lam, 1e-12, 'full aperture: width grows with depth');
  near(twoWay(1, 1), Math.SQRT1_2, 1e-12, 'two equal Gaussians');
  assert.ok(twoWay(10, 0.2) < 0.2 && twoWay(10, 0.2) > 0.19, 'the narrower one dominates');
  // so the two-way PSF stays sharp far past the transmit focus, while the transmit beam does not
  const b = beamAt(15, 'curvi', 0.044, 6);
  assert.ok(b.tx > 4 * b.lat, `tx ${b.tx} vs two-way ${b.lat}`);
  // the elevation lens ignores the focus knob
  near(beamAt(7, 'curvi', 0.044, 3).elev, beamAt(7, 'curvi', 0.044, 12).elev, 1e-12, 'elevation width');
});

test('sub-ray nodes integrate the beam profile', () => {
  for (const n of [5, 7, 9]) {
    const { s, w } = profileNodes(n);
    near([...w].reduce((a, b) => a + b, 0), 1, 1e-12, `weights sum, n=${n}`);
    near([...s].reduce((a, x, i) => a + x * w[i], 0), 0, 1e-12, `symmetric, n=${n}`);
    const m2 = [...s].reduce((a, x, i) => a + x * x * w[i], 0);
    assert.ok(m2 > 0.8 && m2 < 1.05, `second moment ${m2}, n=${n}`);
  }
  // Gauss-Hermite for the two-way profile (variance 1/2 in one-way sigmas): exact moments
  const { s, w } = ELEV_NODES;
  near(w.reduce((a, b) => a + b, 0), 1, 1e-12, 'elevation weights');
  near(s.reduce((a, x, i) => a + x * x * w[i], 0), 0.5, 1e-12, 'elevation variance');
  near(s.reduce((a, x, i) => a + x ** 4 * w[i], 0), 0.75, 1e-12, 'elevation 4th moment (3 sigma^4)');
});

// a field of lines with a perfect absorber on some of them at one depth
function field(nl, ns, block) {
  const M = new Float32Array(nl * ns).fill(1);
  for (const [l, k] of block) M[k * nl + l] = 0;              // depth-major
  return M;
}
test('a shadow has a penumbra as wide as the beam, not a knife edge', () => {
  const nl = 101, ns = 60, T = new Float32Array(nl * ns), nodes = profileNodes(9);
  // a wide obstacle covering lines 50.. at depth 10; the beam 4 lines (sigma) wide everywhere
  const M = field(nl, ns, Array.from({ length: 51 }, (_, i) => [50 + i, 10]));
  beamTransmission(M, nl, ns, new Float64Array(ns).fill(4), nodes, T);
  const at = (l, k) => T[l * ns + k];
  near(at(30, 20), 1, 1e-6, 'far from the edge: clear');
  near(at(80, 20), 0, 1e-6, 'deep in the shadow: dark');
  assert.ok(at(50, 20) > 0.25 && at(50, 20) < 0.75, `on the edge: half a beam (${at(50, 20)})`);
  // a monotone ramp across the edge, several lines wide
  let ramp = 0;
  for (let l = 40; l <= 60; l++) { assert.ok(at(l, 20) <= at(l - 1, 20) + 1e-9, 'monotone'); if (at(l, 20) > 0.05 && at(l, 20) < 0.95) ramp++; }
  assert.ok(ramp >= 6, `penumbra ${ramp} lines`);
  // a ray model (zero-width beam) gives the knife edge
  beamTransmission(M, nl, ns, new Float64Array(ns), nodes, T);
  near(at(49, 20), 1, 1e-6, 'ray: clear beside'); near(at(50, 20), 0, 1e-6, 'ray: dark behind');
});

test('a small obstacle in a wide beam casts only a partial shadow — deepest at the focus', () => {
  const nl = 101, ns = 80, T = new Float32Array(nl * ns), nodes = profileNodes(9);
  const M = field(nl, ns, [[49, 30], [50, 30], [51, 30]]);    // 3 lines wide, at depth 30
  const sig = (focus) => Float64Array.from({ length: ns }, (_, k) => 0.5 + 0.12 * Math.abs(k - focus));
  beamTransmission(M, nl, ns, sig(30), nodes, T);
  const inFocus = T[50 * ns + 60];
  beamTransmission(M, nl, ns, sig(70), nodes, T);
  const outOfFocus = T[50 * ns + 60];
  assert.ok(inFocus < 0.1, `obstacle at the focus: a full shadow (${inFocus})`);
  assert.ok(outOfFocus > 0.4, `obstacle where the beam is wide: mostly filled in (${outOfFocus})`);
});

test('reverberation: A-lines at multiples of the depth, a dirty shadow behind gas, a clean one behind bone', () => {
  const ns = 200, I = new Float32Array(ns), Q = new Float32Array(ns);
  const unit = (k, o, out) => { out[0] = 1; out[1] = 0; };
  // near-field tissue (unit echo, 5..39), a gas surface at 40 returning 0.5
  for (let k = 5; k < 40; k++) I[k] = 0.01;
  I[40] = 0.5;
  addReverb(I, Q, 0, ns, [40, 0.5, 1], 1, 0.3, 3, unit);
  near(I[80], 0.3 * 0.5 * 0.5, 1e-7, 'the first A-line: RF e^2');
  near(I[120], 0.3 * 0.5 * 0.3 * 0.5 * 0.5, 1e-7, 'the second: another factor RF e');
  near(I[60], 0.3 * 0.5 * 0.01, 1e-7, 'the tissue above re-appears beneath: the dirty shadow');
  // the same echo off bone, whose coherence is small: little is re-launched
  const J = new Float32Array(ns), Jq = new Float32Array(ns);
  for (let k = 5; k < 40; k++) J[k] = 0.01;
  J[40] = 0.5;
  addReverb(J, Jq, 0, ns, [40, 0.5, reverbCoherence(18)], 1, 0.3, 3, unit);
  assert.ok(J[60] < 0.15 * I[60], 'bone: a clean shadow');
  assert.ok(reverbCoherence(47) > 5 * reverbCoherence(18), 'gas is the mirror, bone is not');
  assert.ok(reverbCoherence(22) < 0.2 && reverbCoherence(21) < 0.2, 'stones are clean too');
});

test('an oblique boundary: Fresnel at normal incidence, nothing past the critical angle, a specular lobe', () => {
  const o = {};
  // bile (1.52 MRayl, 1520 m/s) into liver (1.65, 1570)
  const z1 = 1.52, z2 = 1.65, c1 = 1520, c2 = 1570, rc = (z2 - z1) / (z2 + z1);
  obliqueInterface(z1, z2, c1, c2, 1, o);
  near(o.t, Math.sqrt(1 - rc * rc), 1e-12, 'normal incidence: the old transmission');
  near(o.r, rc, 1e-12, 'normal incidence: the old reflection');
  const crit = Math.asin(c1 / c2);
  near(crit * 180 / Math.PI, 75.5, 0.1, 'critical angle leaving the gallbladder');
  obliqueInterface(z1, z2, c1, c2, Math.cos(crit + 0.01), o);
  assert.equal(o.t, 0, 'past it: total internal reflection — the edge shadow');
  // approaching it the beam fades continuously, not as a switch
  let prev = 1;
  for (const d of [0.3, 0.1, 0.03, 0.01, 0.003]) {
    obliqueInterface(z1, z2, c1, c2, Math.cos(crit - d), o);
    assert.ok(o.t < prev && o.t > 0, `${d} rad short of critical: ${o.t}`); prev = o.t;
  }
  assert.ok(prev < 0.7, `just short of it: a weakened beam (${prev})`);
  // the other way (into the slower medium) there is no critical angle, but grazing still loses it
  obliqueInterface(z2, z1, c2, c1, Math.cos(1.2), o);
  assert.ok(o.t > 0.9, `entering at 69 degrees: most of it (${o.t})`);
  obliqueInterface(z2, z1, c2, c1, Math.cos(1.565), o);
  assert.ok(o.t < 0.3, `entering at grazing incidence: little (${o.t})`);
  // the echo: square-on is the full coefficient, 45 degrees off keeps only the diffuse floor
  obliqueInterface(1.38, 1.65, 1450, 1570, 1, o); const r0 = o.r;
  obliqueInterface(1.38, 1.65, 1450, 1570, Math.cos(Math.PI / 4), o);
  assert.ok(Math.abs(o.r) < 0.6 * Math.abs(r0), `oblique specular echo ${o.r} vs ${r0}`);
  obliqueInterface(1.38, 1.65, 1450, 1570, Math.cos(0.1), o);
  assert.ok(Math.abs(o.r) > 0.85 * Math.abs(r0), `nearly square-on keeps the mirror (${o.r} vs ${r0})`);
});
