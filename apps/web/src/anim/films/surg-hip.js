/* SURGICAL ANIMATIONS: THE HIP JOINT INJECTION, under fluoroscopy: contrast to prove the needle is
   in the joint, then lidocaine and a corticosteroid. The adult (chest/abdomen/pelvis, with its
   thighs) supine, the right hip; an anterior approach to the lateral femoral head-neck junction,
   lateral to the femoral nerve, artery and vein.

   Six chapters: the opening (the kit's: the tray, the betadine, the needle, the prep, the drape,
   the C-arm's cover; then the syringes drawn up); localizing (the AP, the C turned to the
   working view, the spare needle laid on the skin under spot images, the skin's lidocaine); the
   needle in (down the beam to bone, the 8-bit cross-section naming what it passes, a check from
   the other side); the
   arthrogram (contrast flowing away from the tip round the head and along the neck); the
   lidocaine and steroid (the syringe swapped, the contrast diluted; the needle out); the closing
   (the kit's: sharps, re-packing, the betadine off, gauze and tape).

   Every point is in the patient's frame (kit.js): +x its RIGHT (lateral here), +y its FRONT, +z its
   head. The target and the entry are found at build time from the tissue crop (the first bone
   down the working view's beam through the head-neck junction), so the needle stops on bone. */
import { buildKit, LANDMARKS, v3, place } from './surg/kit.js';
import { beamAxes, sectionAxes } from './surg/geom.js';

const AP = { orbital: 0, tilt: 0 };
// the working view: rolled toward the right hip and tilted a little toward the head; the
// femoral head round, the joint line sharp, the neck at its full length (frames: ±20 x ±10)
const VIEW = { orbital: 20, tilt: 5 };
// the check from the other side: the needle, end on in VIEW, seen along its length
const CHECK = { orbital: -15, tilt: 5 };
const H = LANDMARKS.adult.femoralHeadR;                     // the femoral head's centre (r about 2.2)
const TRO = [13.8, -3.6, -31.5];                            // down the neck toward the trochanter
// aimed at: the anterior cortex at the lateral head-neck junction (refined on the crop below)
const AIM = [11.2, -1.3, -28.6];
// the femoral nerve (the crop holds the vessels, not the nerve): lateral to the artery
const NERVE = [];
for (let z = -24; z >= -30.5; z -= 0.5) NERVE.push({ at: [9.95, 1.7, z], r: 0.32, tissue: 'nerve' });

const into = (pose) => v3.mul(beamAxes(pose.orbital, pose.tilt).d, -1);      // against the beam
const fmt = (n) => (n > 0 ? '+' : n < 0 ? '-' : ' ') + Math.abs(Math.round(n));

export async function build(api) {
  const { span, px, THREE } = api;
  const K = await buildKit(api, { patient: 'adult', region: 'hip' });
  const room = K.room;

  // ---- the target and the entry: down VIEW's beam through AIM, the first bone, 0.05 cm short
  const dir = into(VIEW);
  const target = (() => {
    const from = v3.sub(AIM, v3.mul(dir, 8));
    const segs = K.tissuesAlong(from, v3.add(AIM, v3.mul(dir, 3)));
    const bone = segs.find((s) => s.tissue === 'cortex' || s.tissue === 'marrow');
    return bone ? v3.add(from, v3.mul(dir, bone.from - 0.05)) : [11.17, -1.39, -28.61];
  })();
  const entry = K.entry(target, dir);
  K.setSite(entry);

  // ---- what the film uses: the spinal needle, the locator, three syringes, the vials
  const N = K.needle('spinal');
  const loc = K.needle('locator');
  // the drawing-up needle: its hub on the luer, its tip 5 cm out front (along the syringe's -z)
  const drawNeedle = (s) => { if (s.needle) { s.needle.g.rotation.set(0, 0, 0); s.needle.g.position.set(0, 0, -(s.needle.len + s.needle.hubLen)); } return s; };
  const sCon = drawNeedle(K.syringe({ ml: 5, color: 0xf6efc8, needle: true }));                    // contrast
  const sLid = drawNeedle(K.syringe({ ml: 3, color: 0xeaf4ff, needle: true }));                    // lidocaine, the skin's
  const sMix = drawNeedle(K.syringe({ ml: 5, color: 0xffffff, needle: true }));                    // lidocaine + triamcinolone
  const vials = { contrast: K.vial('contrast'), lidocaine: K.vial('lidocaine'), steroid: K.vial('steroid') };
  vials.contrast.level(0.85); vials.lidocaine.level(0.85); vials.steroid.level(0.6);

  // the skin's mark (the hub's imprint) and the lidocaine wheal
  const imprint = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.07, 6, 20), new THREE.MeshStandardMaterial({ color: 0x5a2416, roughness: 0.8 }));
  imprint.rotation.x = Math.PI / 2; room.pat.add(imprint); imprint.visible = false;
  const wheal = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshStandardMaterial({ color: 0xd8a27c, roughness: 0.55 }));
  room.pat.add(wheal); wheal.visible = false;
  const skinY = (p) => room.top(p[0], p[2]) ?? p[1];
  const showImprint = (on) => { imprint.visible = on; imprint.position.set(entry[0], skinY(entry) + 0.05, entry[2]); };
  const showWheal = (k) => {
    wheal.visible = k > 0.02;
    wheal.position.set(entry[0], skinY(entry) - 0.05, entry[2]);
    wheal.scale.set(0.65 * k + 0.01, 0.22 * k + 0.01, 0.65 * k + 0.01);
  };

  // ---- the arthrogram: contrast points in the head's plane of VIEW (a parallel projection: depth
  // does not move them on the image), each with its distance from the tip (it fills outward)
  const AX = beamAxes(VIEW.orbital, VIEW.tilt);
  const uv = (p) => { const q = v3.sub(p, H); return [v3.dot(q, AX.U), v3.dot(q, AX.V)]; };
  const atUV = (u, v) => v3.add(H, v3.add(v3.mul(AX.U, u), v3.mul(AX.V, v)));
  const ARTHRO = (() => {
    const out = [], tipUV = uv(target);
    const n = uv(TRO), nl = Math.hypot(n[0], n[1]), ax = [n[0] / nl, n[1] / nl];
    let pp = [-ax[1], ax[0]];
    if (pp[1] < 0) pp = [-pp[0], -pp[1]];                   // the neck's superior border's side
    const push = (u, v, r, od) => out.push({ at: atUV(u, v), r, od, d: Math.hypot(u - tipUV[0], v - tipUV[1]) });
    // round the head (the joint line under the acetabulum, and the capsule over it), the neck's
    // sector left out: there the contrast runs down the neck's borders instead
    const neckA = Math.atan2(ax[1], ax[0]);
    for (let a = 0; a < 360; a += 4) {
      const th = a * Math.PI / 180;
      let dd = Math.abs(th - neckA); dd = Math.min(dd, 2 * Math.PI - dd);
      if (dd < 0.7) continue;
      push(Math.cos(th) * 2.4, Math.sin(th) * 2.4, 0.3, 0.42);
    }
    // the superior and inferior recesses along the neck, the inferior the fuller, pinched at
    // the zona orbicularis, their ends rounded off at the capsule's attachment (the
    // intertrochanteric line); a thin layer over the neck between them
    const at = (s, w) => [ax[0] * s + pp[0] * w, ax[1] * s + pp[1] * w];
    const waist = (s) => 0.22 * Math.exp(-(((s - 3.0) / 0.35) ** 2));
    for (let s = 1.6; s <= 4.5; s += 0.12) {
      const end = Math.max(0, (s - 4.0) / 0.5), round = 1 - 0.55 * end * end;
      const sup = (1.25 + 0.12 * Math.sin((s - 1.6) / 2.9 * Math.PI) - waist(s)) * round;
      const inf = (1.4 + 0.5 * Math.sin((s - 1.6) / 2.9 * Math.PI) - waist(s)) * round;
      push(...at(s, sup), 0.3, 0.4);
      push(...at(s, -inf), 0.36, 0.46);
    }
    for (let s = 2.0; s <= 4.3; s += 0.45) for (let w = -1.0; w <= 0.9; w += 0.45) push(...at(s, w), 0.55, 0.1);
    return out;
  })();
  const DMAX = Math.max(...ARTHRO.map((b) => b.d));
  /* The contrast on the image: k 0..1 how far it has run from the tip; dilute 0..1 the injectate
     after it (fainter, spread a little wider). */
  const contrast = (k, dilute = 0) => {
    if (k <= 0) return [];
    const reach = k * DMAX * 1.05, fade = 1 - 0.5 * dilute, grow = 1 + 0.3 * dilute;
    const blobs = [];
    // the first drop at the tip, thinning as it runs on
    blobs.push({ at: target, r: 0.4, od: 0.75 * (1 - 0.7 * Math.min(1, k * 3)) * fade });
    for (const b of ARTHRO) {
      const w = Math.min(1, (reach - b.d) / 0.9);
      if (w > 0) blobs.push({ at: b.at, r: b.r * grow, od: b.od * w * fade });
    }
    return blobs;
  };

  // ---- the pictures on the 8-bit layer
  const IMG = 112;                                            // the fluoro image, big: the point
  const imgX = () => px.W - IMG - 6;
  // the live image with its pose underneath (as the C-arm's screen gives it)
  const fluoro = (opts = {}, size = IMG, x = imgX(), y = 6) => {
    const s = `ORB ${fmt(K.carm.pose.orbital)} TILT ${fmt(K.carm.pose.tilt)}`;
    K.monitor.show({ label: s, ...opts });
    const at = K.monitor.blit(px, x, y, size);
    px.rect(x + size - s.length * 4 - 1, y + size + 3, s.length * 4 + 1, 7, 'black', 0.8);
    px.text(s, x + size, y + size + 4, 'grey', 1, 1, 'right');
    return at;
  };
  // a box round a point of the patient on the image (r cm)
  const markAt = (at, p, r, t, color = 'yellow') => {
    const c = at(p); if (!c) return;
    const h = r * IMG / 16;
    api.mark([c[0] - h, c[1] - h, 2 * h, 2 * h], color, t);
  };
  // the cross-section: the needle's plane across the hip (its right lateral), the nerve, artery
  // and vein named where they lie medial to the path
  const SEC = { x: 6, y: 6, w: 84, h: 84, cm: 0.16 };
  const secCentre = () => v3.add(target, v3.add(v3.mul(dir, -3.0), v3.mul(sectionAxes(dir, [1, 0, 0]).A, -1.6)));
  const NAV = [['N', [9.95, 1.7, entry[2]]], ['A', [8.7, 2.0, entry[2]]], ['V', [6.7, 1.9, entry[2]]]];
  const section = (needle, opts = {}) => {
    const c = secCentre();
    const name = K.section({ needle, ...SEC, across: [1, 0, 0], centre: c, extras: NERVE, ...opts });
    const { A, B } = sectionAxes(dir, [1, 0, 0]), s = SEC.cm;
    for (const [l, p] of NAV) {
      const q = v3.sub(p, c), x = SEC.x + SEC.w / 2 + v3.dot(q, A) / s, y = SEC.y + SEC.h / 2 - v3.dot(q, B) / s;
      if (x < SEC.x + 2 || x > SEC.x + SEC.w - 4 || y < SEC.y + 2 || y > SEC.y + SEC.h - 12) continue;
      px.text(l, x - 1, y - 9, 'white');
    }
    return name;
  };

  // ---- camera framings (room)
  const E = K.toRoom(entry), Tg = K.toRoom(target);
  const wide = () => { const c = K.toRoom([6, 4, -30]); return [[0, [c[0] + 175, c[1] + 105, c[2] - 150], [c[0] - 10, c[1] + 12, c[2] - 10], 40], [10, [c[0] + 155, c[1] + 92, c[2] - 128], [c[0] - 10, c[1] + 12, c[2] - 10], 40]]; };
  // the needle's path, from above the thigh on the foot side: the head and neck under it
  const pathCam = (dur = 12) => {
    const look = v3.lerp(E, Tg, 0.3);
    return [[0, [look[0] + 12, look[1] + 13, look[2] - 36], look, 40], [dur, [look[0] + 10, look[1] + 11, look[2] - 31], look, 38]];
  };
  // the hip from the operator's side, under the receptor
  const hipCam = (dist = 1, dur = 10) => {
    const look = v3.lerp(E, Tg, 0.4);
    return [[0, [look[0] + 46 * dist, look[1] + 22 * dist, look[2] - 34 * dist], look, 40], [dur, [look[0] + 38 * dist, look[1] + 18 * dist, look[2] - 27 * dist], look, 38]];
  };

  // ---- the syringes: drawn up at the side cart; on the needle's hub; their state
  const vialTop = (v) => K.wp(v.g, v.top);
  // a syringe over a vial, its needle k 0 above the stopper to 1 in the liquid
  const overVial = (s, v, k) => {
    const top = vialTop(v);
    s.g.visible = true;
    if (s.needle) s.needle.g.visible = true;
    place(s.g, [top[0], top[1] + 5.2 + 4 * (1 - k) - 2.6 * k, top[2]], [0, 1, 0], [0, 0, 1]);
  };
  const onHub = (s, k) => { if (s.needle) s.needle.g.visible = false; K.attach(s, N, k); };
  // the lidocaine syringe at the skin: its needle's tip at p, pointing along d
  const atSkin = (s, p, d) => {
    s.g.visible = true; if (s.needle) s.needle.g.visible = true;
    place(s.g, K.toRoom(v3.sub(p, v3.mul(d, 5))), v3.mul(d, -1), [0, 1, 0]);
  };

  // ---- the locator laid on the skin: its tip walked onto the entry under single pulses
  const LAY = v3.norm([-1, 0, -0.55]);                        // pointing medially and down the leg
  const locAt = (k) => v3.add(entry, v3.mul([1.6, 0, 2.4], 1 - k));
  const PULSES = [1.6, 3.6, 5.6, 7.4];
  const lastPulse = (t) => { let p = null; for (const q of PULSES) if (t >= q) p = q; return p; };
  const locK = (t) => span(t, 0.6, 7.0);

  // ---- the steps
  const steps = { prep: [], local: [], needle: [], arthro: [], inj: [] };

  steps.prep.push({
    title: 'Drawing up', dur: 12, scale: '10 cm',
    enter() {
      K.reset('procedure');
      vials.contrast.level(0.85); vials.lidocaine.level(0.85); vials.steroid.level(0.6);
    },
    cam: (() => {
      const a = vialTop(vials.contrast), b = vialTop(vials.steroid), c = v3.lerp(a, b, 0.5);
      return [[0, [c[0] + 10, c[1] + 24, c[2] - 34], [c[0], c[1] + 4, c[2]], 38], [12, [c[0] + 6, c[1] + 18, c[2] - 27], [c[0], c[1] + 4, c[2]], 36]];
    })(),
    cues: [[1.4, K.sfx.snap], [5.2, K.sfx.snap], [8.4, K.sfx.snap]],
    frame(t) {
      // contrast 0.5-4; the skin's lidocaine 4.5-7.5; the injectate: lidocaine 8-10, steroid 10-12
      for (const s of [sCon, sLid, sMix]) s.g.visible = false;
      if (t < 4.2) {
        const k = span(t, 0.4, 1.4) * (1 - span(t, 3.4, 4.2));
        overVial(sCon, vials.contrast, k); sCon.set({ fill: span(t, 1.5, 3.3) * 0.7 });
        vials.contrast.level(0.85 - 0.12 * span(t, 1.5, 3.3));
        if (t > 1) api.mark(vials.contrast.g, 'yellow', t);
      } else if (t < 7.8) {
        const k = span(t, 4.4, 5.2) * (1 - span(t, 7, 7.8));
        overVial(sLid, vials.lidocaine, k); sLid.set({ fill: span(t, 5.3, 6.9) * 0.8 });
        vials.lidocaine.level(0.73 - 0.1 * span(t, 5.3, 6.9));
        api.mark(vials.lidocaine.g, 'yellow', t);
      } else {
        const v = t < 10.2 ? vials.lidocaine : vials.steroid;
        const k = t < 10.2 ? span(t, 7.9, 8.4) * (1 - span(t, 9.6, 10.2)) : span(t, 10.2, 10.7) * (1 - span(t, 12.4, 13));
        overVial(sMix, v, k);
        sMix.set({ fill: span(t, 8.4, 9.5) * 0.65 + span(t, 10.7, 11.8) * 0.2 });
        vials.lidocaine.level(0.63 - 0.12 * span(t, 8.4, 9.5));
        vials.steroid.level(0.6 - 0.12 * span(t, 10.7, 11.8));
        api.mark(v.g, 'yellow', t);
      }
    },
    caption: [
      { from: 0.4, to: 4.2, text: 'The circulator holds each vial; the operator draws up through its stopper. First <b>iodinated contrast</b> (iohexol 300), a few mL.' },
      { from: 4.2, to: 7.8, text: '<b>Lidocaine 1%</b> for the skin and the track, on a fine 25 G needle.' },
      { from: 7.8, to: 12, text: 'The injectate: lidocaine with <b>triamcinolone 40 mg</b>, a corticosteroid <b>suspension</b> that settles, so it is drawn up last.' },
    ],
  });

  steps.local.push({
    title: 'The AP of the hip', dur: 9, scale: '1 m',
    enter() { K.reset('procedure'); K.carm.set(AP); },
    cam: wide(),
    cues: [[1, K.sfx.pulse], [1.2, () => K.suite.press(1)], [3.4, () => K.suite.press(0)]],
    frame(t) {
      K.carm.beam(t > 1 && t < 3.4 ? 0.6 : 0);
      if (t < 1) { K.monitor.dark(); return; }
      const at = fluoro({ seed: t < 3.4 ? 1 + Math.floor(t * 8) : 27 });
      if (t > 3.6) markAt(at, H, 2.6, t);
    },
    caption: [
      { from: 0.5, to: 4.4, text: 'The C over the right hip, an <b>AP</b>: the beam up through the table, the receptor close over the groin.' },
      { from: 4.4, to: 9, text: 'The <b>femoral head</b> is there but soft: the joint line blurred, the anteverted <b>neck</b> foreshortened.' },
    ],
  });

  steps.local.push({
    title: 'The C-arm to the working view', dur: 14, scale: '1 m',
    enter() { K.reset('procedure'); K.carm.set(AP); },
    cam: (() => { const w = wide(); return [[0, w[0][1], w[0][2], 40], [14, w[1][1], w[1][2], 40]]; })(),
    cues: [[0.8, K.sfx.pulse], [4.6, K.sfx.pulse], [7.4, K.sfx.pulse], [10.2, K.sfx.pulse]],
    frame(t) {
      // the roll toward the hip (0.8-4.6), a tilt the wrong way (5-7.4), then toward the head (7.6-10.2)
      const P1 = { orbital: VIEW.orbital, tilt: 0 }, P2 = { orbital: VIEW.orbital, tilt: -5 };
      if (t < 4.6) K.carm.ease(AP, P1, span(t, 0.8, 4.6));
      else if (t < 7.4) K.carm.ease(P1, P2, span(t, 5, 7.4));
      else K.carm.ease(P2, VIEW, span(t, 7.6, 10.2));
      K.carm.beam(t > 0.8 && t < 10.4 ? 0.55 : 0);
      K.suite.press(t > 0.8 && t < 10.4 ? 1 : 0);
      const at = fluoro({ seed: t < 10.4 ? 40 + Math.floor(t * 8) : 123 });
      if (t > 10.6) { markAt(at, H, 2.6, t); markAt(at, target, 0.7, t, 'lime'); }
    },
    caption: [
      { from: 0.5, to: 4.8, text: 'The C <b>rolled 20°</b> toward the hip: the head comes out round and the neck lengthens, much as turning the leg <b>15° inward</b> would.' },
      { from: 4.8, to: 7.6, text: 'Tilted toward the feet, the acetabular rim smears across the head: the wrong way.' },
      { from: 7.6, to: 10.6, text: 'Tilted <b>5° toward the head</b>: the rim clears and the <b>joint line</b> sharpens.' },
      { from: 10.6, to: 14, text: 'The <b>working view</b>. The target: the <b>lateral head-neck junction</b>, inside the capsule and well lateral of the femoral vessels.' },
    ],
  });

  steps.local.push({
    title: 'The spare needle and a spot image', dur: 11, scale: '10 cm',
    enter() { K.reset('procedure'); K.carm.set(VIEW); },
    cam: hipCam(0.45, 11),
    cues: [...PULSES.map((p) => [p, K.sfx.pulse]), [8.6, K.sfx.snap]],
    frame(t) {
      loc.lay(locAt(locK(t)), LAY);
      const lp = lastPulse(t);
      K.carm.beam(lp != null && t - lp < 0.35 ? 0.6 : 0);
      if (lp == null) { K.monitor.dark(); } else {
        // the image is the last pulse's: the locator where it was then
        const was = loc.tip();
        loc.lay(locAt(locK(lp)), LAY);
        const seg = loc.segment(1.4, 1);
        loc.lay(was, LAY);
        const at = fluoro({ needles: [seg], seed: Math.round(lp * 10) });
        if (t > 7.6) { markAt(at, target, 0.6, t); K.monitor.spot('LOCATOR'); }
      }
      // the hub pressed into the skin: its imprint marks the entry
      showImprint(t > 8.8);
      if (t > 8.8) api.mark(imprint, 'yellow', t, { live: true });
      if (t > 1 && t < 8.6) api.mark(loc.g, 'yellow', t, { live: true });
    },
    caption: [
      { from: 0.5, to: 4.6, text: 'A <b>spare needle</b> laid on the skin, metal that shows on the image, its tip slid over the target between <b>single pulses</b>.' },
      { from: 4.6, to: 8.4, text: 'Its tip on the <b>lateral head-neck junction</b>: the <b>spot image</b> is kept on the reference screen.' },
      { from: 8.4, to: 11, text: 'The <b>entry</b> marked on the skin: straight down the beam from here is the target.' },
    ],
  });

  const DEEP = dir;
  const SHALLOW = v3.norm([-0.55, -0.3, -0.75]);          // in from the operator's side, toward the feet
  steps.local.push({
    title: 'Lidocaine: the skin and the track', dur: 10, scale: '10 cm',
    enter() { K.reset('procedure'); K.carm.set(VIEW); showImprint(true); },
    cam: hipCam(0.5, 10),
    frame(t) {
      // the wheal (0.5-4), then down the track to 3 cm, injecting as it goes (5-9)
      if (t < 4.6) {
        const k = span(t, 0.4, 1.4);
        atSkin(sLid, v3.add(entry, v3.mul(SHALLOW, -1.5 * (1 - k) + 0.25 * k)), SHALLOW);
        sLid.set({ fill: 0.8 - 0.25 * span(t, 1.6, 3.8), plunger: 0.8 - 0.25 * span(t, 1.6, 3.8) });
        showWheal(span(t, 1.6, 3.8));
      } else {
        const k = span(t, 4.8, 5.4), deep = span(t, 5.6, 9);
        const d = v3.norm(v3.lerp(SHALLOW, DEEP, k));
        atSkin(sLid, v3.add(entry, v3.mul(d, 0.25 + 3.0 * deep - 1.2 * (1 - k) * span(t, 4.6, 4.8))), d);
        sLid.set({ fill: 0.55 - 0.4 * deep });
        showWheal(1);
      }
      showImprint(t < 1.5);
      if (t > 2.4 && t < 4.6) api.mark(wheal, 'yellow', t, { live: true });
    },
    caption: [
      { from: 0.4, to: 4.6, text: 'A <b>skin wheal</b> of lidocaine at the mark: in just under the skin, a pale bump raised.' },
      { from: 4.6, to: 10, text: 'Then down the <b>planned track</b>, along the beam, aspirating before each little injection: nothing should be drawn back.' },
    ],
  });

  // ---- the needle in
  const xs = (t) => K.xray(span(t, 0.3, 1.6) * 0.88);
  steps.needle.push({
    title: 'Down the beam', dur: 12, scale: '10 cm',
    enter() { K.reset('procedure'); room.drape.set(0); K.carm.set(VIEW); N.place(entry, target); N.stylet(1); showWheal(1); },
    cam: pathCam(12),
    cues: [[1, K.sfx.pulse], [4, K.sfx.pulse], [7, K.sfx.pulse], [10, K.sfx.pulse]],
    frame(t) {
      xs(t);
      N.advance(span(t, 0.8, 10.5) * 0.72);
      K.carm.beam(0.35);
      const at = fluoro({ needles: [N.segment()], seed: 300 + Math.floor(t * 8) });
      section(N);
      if (t > 2) markAt(at, N.tip(), 0.6, t);
    },
    caption: [
      { from: 0.5, to: 4, text: 'The <b>spinal needle</b> (22 G, 9 cm) in at the mark and aimed <b>down the beam</b>: on the screen it is a <b>dot</b> on the target.' },
      { from: 4, to: 8, text: 'In the section: through <b>skin</b>, <b>fat</b> and <b>muscle</b>; the femoral <b>nerve, artery and vein</b> lie medial to the path.' },
      { from: 8, to: 12, text: 'Kept a dot, not a line: if it lengthens, the needle has drifted off the beam and is redirected.' },
    ],
  });

  steps.needle.push({
    title: 'To bone at the head-neck junction', dur: 13, scale: '10 cm',
    enter() { K.reset('procedure'); room.drape.set(0); K.carm.set(VIEW); N.place(entry, target); N.stylet(1); showWheal(1); },
    cam: pathCam(13),
    cues: [[1, K.sfx.pulse], [4.2, () => api.sfx.tick()], [7.4, K.sfx.pulse], [11, K.sfx.pulse]],
    frame(t) {
      K.xray(0.88);
      N.advance(0.72 + 0.28 * span(t, 0.5, 4.2));
      // then the C rolled the other way: the needle seen along its length, its tip on the neck
      K.carm.ease(VIEW, CHECK, span(t, 6.4, 10.4));
      K.carm.beam(t < 4.4 || t > 10.4 ? 0.35 : 0);
      const at = fluoro({ needles: [N.segment()], seed: t < 6 ? 500 + Math.floor(t * 8) : 700 + Math.floor(t * 8) });
      section(N);
      if (t > 4.4 && t < 6.4) markAt(at, N.tip(), 0.6, t);
      if (t > 10.6) markAt(at, N.tip(), 0.8, t);
    },
    caption: [
      { from: 0.4, to: 4.4, text: 'On through the <b>joint capsule</b>, a firm give, to <b>bone</b>: the tip on the neck at the head-neck junction.' },
      { from: 4.4, to: 6.4, text: 'Bone is felt, not seen: the tip rests on the neck, inside the capsule, in the thin <b>joint space</b> over it.' },
      { from: 6.4, to: 13, text: 'Rolled to the <b>other side</b>, the needle shows its length: a line ending on the neck, at the depth wanted.' },
    ],
  });

  // ---- the arthrogram
  steps.arthro.push({
    title: 'Contrast: the arthrogram', dur: 14, scale: '10 cm',
    enter() {
      K.reset('procedure'); room.drape.set(0); K.carm.set(VIEW);
      N.place(entry, target); N.advance(1); N.stylet(1); showWheal(1); sCon.set({ fill: 0.7 });
    },
    cam: pathCam(14),
    cues: [[0.6, K.sfx.snap], [3.2, K.sfx.pulse], [12.4, K.sfx.pulse]],
    frame(t) {
      K.xray(0.88);
      // the stylet out (0.4-1.6), the contrast syringe on (1.8-3), 2 mL in under live fluoro (3.4-11)
      N.stylet(t < 1.8 ? 1 - span(t, 0.4, 1.6) : -1);
      sCon.g.visible = t > 1.8;
      if (t > 1.8) onHub(sCon, span(t, 1.8, 3));
      const k = span(t, 3.4, 11, api.ease.out);
      sCon.set({ fill: 0.7 - 0.35 * k });
      const live = t > 3.2 && t < 12.4;
      K.carm.beam(live ? 0.35 : 0); K.suite.press(live ? 1 : 0);
      const at = fluoro({ needles: [N.segment()], blobs: contrast(k), seed: live ? 900 + Math.floor(t * 8) : 1001 });
      if (t > 12.4) K.monitor.spot('ARTHROGRAM');
      section(N, { fills: k > 0 ? [{ at: target, r: 0.3 + 2.6 * k, color: 'white', tissue: ['joint', 'capsule'] }] : [] });
      if (t > 7) markAt(at, H, 2.9, t);
    },
    caption: [
      { from: 0.4, to: 3.2, text: 'The stylet out, a short line of <b>contrast</b> on the hub (no air: bubbles mimic loose bodies).' },
      { from: 3.2, to: 8, text: 'Under live fluoro it runs <b>away from the tip</b>, round the femoral head and down the <b>recesses</b> along the neck.' },
      { from: 8, to: 14, text: 'An <b>arthrogram</b>: the capsule outlined, so the tip is <b>intra-articular</b>. A blob that pools round the tip would mean it is outside, in the soft tissue.' },
    ],
  });

  // ---- the lidocaine and steroid; the needle out
  steps.inj.push({
    title: 'Lidocaine and corticosteroid', dur: 12, scale: '10 cm',
    enter() {
      K.reset('procedure'); room.drape.set(0); K.carm.set(VIEW);
      N.place(entry, target); N.advance(1); N.stylet(-1); showWheal(1); sMix.set({ fill: 0.85 });
    },
    cam: pathCam(12),
    cues: [[3.6, K.sfx.pulse], [10.6, K.sfx.pulse]],
    frame(t) {
      K.xray(0.88);
      // the contrast syringe off (0.3-1.3), the injectate on (1.6-2.8), in slowly (3.2-10)
      sCon.g.visible = t < 1.4; sCon.set({ fill: 0.35 });
      if (t < 1.4) { K.attach(sCon, N, 1 - span(t, 0.3, 1.3)); if (sCon.needle) sCon.needle.g.visible = false; }
      sMix.g.visible = t > 1.5;
      if (t > 1.5) onHub(sMix, span(t, 1.6, 2.8));
      const k = span(t, 3.2, 10, api.ease.linear);
      sMix.set({ fill: 0.85 - 0.75 * k });
      const live = (t > 3.6 && t < 4.2) || (t > 10.6 && t < 11.2);
      K.carm.beam(live ? 0.35 : 0);
      const at = fluoro({ needles: [N.segment()], blobs: contrast(1, k), seed: 1200 + Math.floor((t > 10.6 ? 10.6 : 3.6) * 8) });
      section(N, { fills: [{ at: target, r: 2.9, color: 'white', tissue: ['joint', 'capsule'], a: 1 - 0.5 * k }, { at: target, r: 0.3 + 2.8 * k, color: 'cyan', tissue: ['joint', 'capsule'], a: 0.7 }] });
      if (t > 3.4 && t < 10) api.mark(sMix.g, 'yellow', t, { live: true });
      if (t > 10.8) markAt(at, H, 2.9, t);
    },
    caption: [
      { from: 0.3, to: 3.2, text: 'The contrast syringe off, the <b>lidocaine and triamcinolone</b> on, the hub held still so the tip does not move.' },
      { from: 3.2, to: 8, text: 'In with <b>little resistance</b>: the joint takes it. Hard pushing would mean the tip is in the capsule or against cartilage.' },
      { from: 8, to: 12, text: 'The contrast <b>diluted</b> and spread wider round the head: the injectate went where the contrast did.' },
    ],
  });

  steps.inj.push({
    title: 'The needle out', dur: 7, scale: '10 cm',
    enter() { K.reset('procedure'); room.drape.set(0); K.carm.set(VIEW); N.place(entry, target); N.advance(1); N.stylet(-1); showWheal(1); sMix.set({ fill: 0.1 }); },
    cam: hipCam(0.55, 7),
    frame(t) {
      K.xray(0.88 * (1 - span(t, 4.4, 6)));
      // the stylet back in, the needle out in one movement, pressure on the site
      N.stylet(t < 0.4 ? -1 : span(t, 0.4, 1.6));
      sMix.g.visible = t < 0.4;
      if (t < 0.4) onHub(sMix, 1 - span(t, 0, 0.4));
      const out = span(t, 1.8, 4);
      N.advance(1 - out * 1.05);
      N.show(out < 0.98);
      fluoro({ needles: out < 0.98 ? [N.segment()] : [], blobs: contrast(1, 1), seed: 1288 });
      if (t > 4) api.mark(wheal, 'yellow', t, { live: true });
    },
    caption: [
      { from: 0.3, to: 4, text: 'The <b>stylet</b> back in so no steroid is tracked through the skin, then the needle out in one smooth pull.' },
      { from: 4, to: 7, text: 'Pressure on the site. Relief within minutes (the <b>lidocaine</b>) says the pain is the joint’s; the <b>steroid</b> works over days.' },
    ],
  });

  // ---- the opening and the closing (the kit's), the skin's mark kept off where it does not belong
  const opening = K.opening({ needles: ['spinal'] });
  for (const s of opening) { const e = s.enter; s.enter = () => { e(); showImprint(false); showWheal(0); }; }
  const closing = K.closing({ sharps: [N, loc, sLid], sites: [entry] });
  for (const s of closing) { const e = s.enter; s.enter = () => { e(); showImprint(false); showWheal(0); }; }
  // every own step: the mark and the wheal only where the step shows them
  for (const s of [...steps.prep, ...steps.local, ...steps.needle, ...steps.arthro, ...steps.inj]) {
    const e = s.enter;
    s.enter = () => { showImprint(false); showWheal(0); e(); };
  }

  return {
    title: 'Hip joint injection',
    chapters: [
      { title: 'Opening', steps: [...opening, ...steps.prep] },
      { title: 'Localizing', steps: steps.local },
      { title: 'The needle in', steps: steps.needle },
      { title: 'Contrast', steps: steps.arthro },
      { title: 'Lidocaine and steroid', steps: steps.inj },
      { title: 'Closing', steps: closing },
    ],
  };
}
