// CT dose and the HU ROI. The ratios are the lesson; the reference-level checks keep the
// absolute numbers believable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ctdiVol, dlp, effectiveMAs, phantomFor, effectiveDose, groupDose, KV_EXPONENT } from '../src/core/ctDose.js';
import { roiStats } from '../src/core/ctRoi.js';

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const base = { kv: 120, ma: 200, rotS: 0.5, pitch: 1, phantom: 'body' };

test('CTDIvol is proportional to mA and rotation time, inversely to pitch', () => {
  const c = ctdiVol(base);
  assert.ok(near(ctdiVol({ ...base, ma: 400 }), 2 * c), 'double mA');
  assert.ok(near(ctdiVol({ ...base, rotS: 1.0 }), 2 * c), 'double rotation time');
  assert.ok(near(ctdiVol({ ...base, pitch: 2 }), c / 2), 'double pitch');
});

test('effective mAs is the one quantity dose depends on: same mA·t/pitch, same CTDIvol', () => {
  // 400 mA at pitch 2 delivers what 200 mA at pitch 1 does — and makes the same noise
  assert.equal(effectiveMAs(400, 0.5, 2), effectiveMAs(200, 0.5, 1));
  assert.ok(near(ctdiVol({ ...base, ma: 400, pitch: 2 }), ctdiVol(base)));
});

test('kV raises CTDIvol faster than fluence', () => {
  const r = ctdiVol({ ...base, kv: 100 }) / ctdiVol(base);
  assert.ok(near(r, Math.pow(100 / 120, KV_EXPONENT)));
  assert.ok(r < Math.pow(100 / 120, 2), 'steeper than kV^2');
});

test('the head phantom reports about twice the CTDIvol of the body phantom', () => {
  assert.equal(phantomFor(250), 'head');
  assert.equal(phantomFor(500), 'body');
  const r = ctdiVol({ ...base, phantom: 'head' }) / ctdiVol(base);
  assert.ok(r > 2 && r < 2.6, `head/body ${r.toFixed(2)}`);
});

test('DLP covers the irradiated length, which overruns the planned range', () => {
  assert.ok(near(dlp(10, 300, 40), 10 * 34), 'CTDIvol x (L + one rotation of feed) in cm');
  assert.ok(dlp(10, 300, 40) > dlp(10, 300, 0));
});

test('routine adult protocols land inside diagnostic reference levels', () => {
  // body: 120 kV, 200 mA, 0.5 s, pitch 1 over a 35 cm chest. UK/EU DRLs are ~12-15 mGy and
  // ~500-600 mGy·cm; a routine scan should sit comfortably under them, not at 5x or 0.1x.
  const chest = groupDose({ kv: 120, ma: 200, rotSpeed: 0.5, pitch: 1, sfovMM: 500 },
    { scanLenMM: 350, feedMMPerRot: 40, subject: 'chest' });
  assert.ok(chest.ctdiVol > 3 && chest.ctdiVol < 15, `chest CTDIvol ${chest.ctdiVol.toFixed(1)}`);
  assert.ok(chest.dlp > 150 && chest.dlp < 600, `chest DLP ${chest.dlp.toFixed(0)}`);
  assert.ok(chest.effective.mSv > 2 && chest.effective.mSv < 9, `chest E ${chest.effective.mSv.toFixed(1)} mSv`);
  // head: 120 kV, 300 mA, 1 s, pitch 1 over 15 cm. Head DRL ~60 mGy / ~1000 mGy·cm.
  const head = groupDose({ kv: 120, ma: 300, rotSpeed: 1, pitch: 1, sfovMM: 250 },
    { scanLenMM: 150, feedMMPerRot: 20, subject: 'headneck' });
  assert.ok(head.ctdiVol > 25 && head.ctdiVol < 65, `head CTDIvol ${head.ctdiVol.toFixed(1)}`);
});

test('phantoms have no effective dose', () => {
  assert.equal(effectiveDose(500, 'acrphantom'), null);
  assert.equal(effectiveDose(500, 'metalphantom'), null);
});

// ---- the HU ROI ----
const MU_W = 0.2;
const slice = (N, muAt) => { const mu = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) mu[y * N + x] = muAt(x, y); return mu; };

test('ROI on uniform water reads 0 HU with no spread; on fat-like tissue its own HU', () => {
  const N = 64;
  const w = roiStats(slice(N, () => MU_W), N, MU_W, 32, 32, 10);
  assert.ok(Math.abs(w.mean) < 0.01 && w.sd < 0.01, `water ${w.mean} ± ${w.sd}`);   // Float32 storage
  const f = roiStats(slice(N, () => MU_W * 0.9), N, MU_W, 32, 32, 10);
  assert.ok(Math.abs(f.mean + 100) < 0.01, `fat-like ${f.mean}`);
});

test('ROI SD is the noise: it measures a known standard deviation', () => {
  const N = 256; let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const sigmaHU = 12;
  const st = roiStats(slice(N, () => MU_W * (1 + gauss() * sigmaHU / 1000)), N, MU_W, 128, 128, 80);
  assert.ok(Math.abs(st.sd / sigmaHU - 1) < 0.03, `SD ${st.sd.toFixed(2)} vs ${sigmaHU}`);
});

test('ROI excludes pixels outside the reconstructed disc', () => {
  const N = 64;
  const mu = slice(N, (x) => (x < 32 ? NaN : MU_W));
  const st = roiStats(mu, N, MU_W, 32, 32, 12);
  assert.ok(st.n > 0 && Math.abs(st.mean) < 0.01, 'only the measured half counts');
});

test('ROI is placed in display orientation: rows are flipped from storage', () => {
  // storage row 0 is the BOTTOM of the displayed image
  const N = 64;
  const mu = slice(N, (x, y) => (y < N / 2 ? MU_W * 2 : MU_W));   // bottom half (in storage) is bone-like
  const top = roiStats(mu, N, MU_W, 32, 10, 5), bottom = roiStats(mu, N, MU_W, 32, 54, 5);
  assert.ok(Math.abs(top.mean) < 0.01, 'the top of the display is storage row N-1: water');
  assert.ok(Math.abs(bottom.mean - 1000) < 0.01, 'the bottom of the display is storage row 0');
});

// ---- the link: image noise follows the same effective mAs the dose readout uses ----
// Measured in the app before this was pinned: pitch 2 raised the reconstructed noise by
// 1.414x and a quarter of the mA by 2.03x, exactly the inverse-sqrt of the photons below.
// Before the fix pitch was missing here, so the console said "half the dose" over an image
// whose noise had not moved.
test('CT photons per slice scale with effective mAs, pitch included', async () => {
  const { photonsFor } = await import('../src/ct.js');
  const g = { ma: 300, rotSpeed: 0.5, pitch: 1, kv: 120, beamColl: 0.625, detRows: 1, recons: [{ thk: 5 }] };
  const geo = { m: { nAngles: 288 } };
  const p = photonsFor(g, geo);
  assert.ok(near(photonsFor({ ...g, pitch: 2 }, geo), p / 2), 'double pitch halves the photons');
  assert.ok(near(photonsFor({ ...g, ma: 75 }, geo), p / 4), 'a quarter of the mA, a quarter of the photons');
  assert.ok(near(photonsFor({ ...g, ma: 600, pitch: 2 }, geo), p), 'same effective mAs, same photons');
});

test('CT detector: electronic noise is fixed, so more mAs always buys less noise; the clip is relative', async () => {
  const { detectedIntegral, SAT_P, ELEC_FLOOR } = await import('../src/ct.js');
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const randn = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sdOf = (photons0, Tr) => {
    const v = []; for (let i = 0; i < 20000; i++) v.push(detectedIntegral(photons0, Tr, ELEC_FLOOR, randn));
    const m = v.reduce((s, x) => s + x, 0) / v.length; return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
  };
  // a starved lateral ray through a 40 cm abdomen (T ~ 1e-4): four times the photons -> half the
  // noise. With the floor tied to the tube output, this ratio was ~1.4.
  const r = sdOf(2e6, 1e-4) / sdOf(8e6, 1e-4);
  assert.ok(Math.abs(r - 2) < 0.15, `quadrupling the beam cut the noise ${r.toFixed(2)}x`);
  // the dynamic-range clip stays at e^-SAT_P of the beam, whatever the beam
  for (const ph of [1e5, 1e7]) assert.ok(Math.abs(detectedIntegral(ph, 1e-9, ELEC_FLOOR, () => -10) - SAT_P) < 1e-9);
});
