/* DXA FILM, chapter 1: the scanner and the patient. The densitometer (a padded table, the arm
   with the source under the table and the detector in the head over it), the patient laid on the
   centre line and squared to it, the knee block that flattens the lumbar curve, and the laser the
   arm is driven to: the lower edge of the spine's field. */
import { setOpacity } from '../../kit/stage.js';
import { ZP, FOCUS_Y, DET_Y } from './room.js';

export function machine(api, S) {
  const { px, sfx, span, lerp, clamp01 } = api;
  const J = S.J;
  const markZ = J ? J.spine.laser.z + ZP : -3;          // the console's mark: 1 in above the ASIS
  const PARK = 40;                                       // where the arm waits, toward the head end
  const box3 = (c, h) => {                               // a world point's surroundings, as an 8-bit box
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const [x, y] = api.toPx([c[0] + (i & 1 ? h : -h), c[1] + (i & 2 ? h : -h), c[2] + (i & 4 ? h : -h)]);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return [x0, y0, x1 - x0, y1 - y0];
  };

  /* The lumbar spine from the side (head left, feet right, as the camera sees it; the table at
     the bottom, the front of the body up): five bodies on a curve that the knee block flattens,
     the disc spaces opening as it does. k: 0 lying flat-legged .. 1 on the block. */
  function lordosis(x, y, w, h, k, t) {
    px.rect(x, y, w, h, 'ink', 0.88); px.frame(x, y, w, h, 'dkgrey');
    api.keepOut([x, y, w, h]);
    const base = y + h - 8;
    px.rect(x + 3, base + 3, w - 6, 2, 'slate');                       // the table
    const amp = lerp(14, 2, k), gap = Math.round(lerp(1, 3, k));
    const n = 5, span_ = (w - 22), x0 = x + 11, dx = span_ / n, bw = Math.floor(dx - gap);
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n, cx = x0 + (i + 0.5) * dx;
      const yy = base - 12 - Math.sin(u * Math.PI) * amp;
      const slope = Math.cos(u * Math.PI) * amp * Math.PI / span_;     // the curve's tilt here
      // the body: columns following the curve
      for (let c = 0; c < bw; c++) {
        const xx = cx - bw / 2 + c, yc = yy - slope * (c - bw / 2);
        px.rect(xx, yc, 1, 7, 'bone', 0.95);
        if (c > 1 && c < bw - 2 && c % 3 === 0) px.px(xx, yc + 3, 'peach', 0.7);
      }
      px.rect(cx - 1, yy + 7, 3, 4, 'bone', 0.55);                       // the spinous process, toward the table
      // the disc after it: a wedge, its front (top) opened by the curve
      if (i < n - 1) {
        const xd = cx + bw / 2, yd = yy - slope * (bw / 2);
        for (let g = 0; g < gap; g++) px.rect(xd + g, yd, 1, 7, 'blue', 0.8);
      }
    }
    // the curve itself, dashed: how far the low back lifts off the table
    for (let i = 0; i <= 24; i++) {
      const u = i / 24, xx = x0 + u * span_, yy = base - 1 - Math.sin(u * Math.PI) * amp;
      if (i % 2 === 0) px.px(xx, yy, 'yellow', 0.6 + 0.3 * Math.sin(t * 4));
    }
    return [x0 - 4, base - 30, span_ + 8, 30];
  }

  const steps = [
    {
      title: 'The densitometer', dur: 10, fadeIn: 0.8, scale: '1 m',
      enter() { S.reset(); S.patLook(0); S.legsTo(null); S.setArm(PARK); },
      cam: [[0, [300, 150, 250], [0, -15, 0], 38], [10, [170, 95, 150], [0, -5, 10], 38]],
      frame(t) {
        if (t > 1.5 && t < 5.5) api.mark(S.L.table, 'yellow', t);
        if (t > 5.5) api.mark(S.headG, 'cyan', t);
      },
      caption: [
        { from: 1.5, to: 5.5, text: 'A <b>DXA</b> densitometer: a long padded table, the scanning field marked on it.' },
        { from: 5.5, to: 10, text: 'The <b>scanning arm</b> travels along the table: a source under it, a detector in the head above, always facing each other.' },
      ],
    },
    {
      title: 'Source and detector', dur: 12, scale: '10 cm',
      enter() { S.reset(); S.patLook(0); S.legsTo(null); S.setArm(PARK); },
      cam: [[0, [190, 60, PARK + 110], [0, 0, PARK], 36], [12, [128, -2, PARK + 52], [0, 5, PARK], 38]],
      cues: [[2.2, () => sfx.power()]],
      frame(t) {
        const k = span(t, 0.5, 2.5);
        setOpacity(S.carriageG, 1 - 0.85 * k); setOpacity(S.headG, 1 - 0.8 * k);
        const on = span(t, 2.2, 3.2);
        S.spot.material.opacity = on;
        S.fan.visible = on > 0; S.fan.material.opacity = 0.22 * on;
        S.fanAt(PARK, 0);
        sfx.hold('tube', 70, 0.03 * on, 'triangle');
        if (t > 2.2 && t < 7) api.mark(S.housing, 'orange', t);
        if (t > 7) api.mark(S.det, 'cyan', t);
        // the beam's path between them, kept clear of the caption
        const a = api.toPx([0, FOCUS_Y, PARK]), b = api.toPx([0, DET_Y, PARK]);
        api.keepOut([Math.min(a[0], b[0]) - 6, Math.min(a[1], b[1]), Math.abs(a[0] - b[0]) + 12, Math.abs(a[1] - b[1])]);
      },
      caption: [
        { from: 2.4, to: 7, text: 'In the box under the table, the <b>x-ray tube</b>: its beam points up, through the table top.' },
        { from: 7, to: 12, text: 'Straight above it in the head, the <b>detector</b>: a short row of elements that counts the photons arriving.' },
      ],
    },
    {
      title: 'The patient lies down', dur: 12, scale: '10 cm',
      enter() { S.reset(); S.setArm(PARK); },
      cam: [[0, [90, 190, -150], [0, 5, 0], 38], [12, [40, 175, -125], [0, 10, 8], 38]],
      cues: [[0.6, () => sfx.thud()]],
      frame(t) {
        S.patLook(span(t, 0, 1.5), 0.32);
        // lying a little off the line and turned, then slid straight
        const k = span(t, 3.5, 8);
        S.body.position.x = lerp(7, 0, k);
        S.body.rotation.y = lerp(6, 0, k) * Math.PI / 180;
        // the pad's centre line, picked out
        if (t > 3) {
          const a = api.toPx([0, 0.3, -96]), b = api.toPx([0, 0.3, 96]);
          px.line(a[0], a[1], b[0], b[1], 'yellow', 0.35 + 0.25 * Math.sin(t * 5), 3);
        }
        if (t > 1.5) api.mark(S.skin || S.pat, 'yellow', t, { live: true });
      },
      caption: [
        { from: 1.5, to: 6.5, text: 'The patient lies on their back, the <b>midline on the table’s centre line</b>.' },
        { from: 6.5, to: 12, text: 'Straight and square to the line: a spine that is turned or curved sideways measures differently every time.' },
      ],
    },
    {
      title: 'The knee block', dur: 13, scale: '10 cm',
      enter() { S.reset(); S.setArm(PARK); S.block.visible = true; },
      cam: [[0, [175, 55, -55], [0, 18, -25], 38], [13, [160, 45, -30], [0, 18, -18], 38]],
      cues: [[3.3, () => sfx.thud()]],
      frame(t) {
        const ks = span(t, 0.5, 3.3);
        S.block.position.x = lerp(110, 0, ks);
        const kl = span(t, 3.4, 5.6);
        S.legs.flat.visible = kl < 1; S.legs.block.visible = kl > 0;
        setOpacity(S.legs.flat, 1 - kl); setOpacity(S.legs.block, kl);
        if (t > 1 && t < 6.2) api.mark(S.block, 'cyan', t, { live: true });
        if (t > 6.2) {
          const w = Math.min(120, px.W * 0.45), h = 64;
          const sp = lordosis(px.W - w - 6, 6, w, h, span(t, 7, 10.5), t);
          api.mark(sp, 'yellow', t);
        }
      },
      caption: [
        { from: 1, to: 6.2, text: 'For the spine, the legs go up on a <b>knee block</b>: hips and knees bent about 90°.' },
        { from: 6.2, to: 13, text: 'That flattens the <b>lumbar curve</b> onto the table and opens the disc spaces, so each vertebra is seen square on and the levels separate.' },
      ],
    },
    {
      title: 'To the mark', dur: 13, scale: '10 cm',
      enter() { S.reset(); S.block.visible = true; S.legsTo('block'); },
      cam: [[0, [150, 75, -70], [0, 20, 12], 36], [7, [135, 52, markZ - 30], [0, 24, markZ + 6], 34], [13, [120, 46, markZ - 22], [0, 25, markZ + 5], 32]],
      cues: [[1, () => sfx.blip(660)], [7.2, () => sfx.ping(1320)]],
      frame(t) {
        const k = span(t, 1, 7, api.ease.inOut);
        const z = lerp(PARK, markZ, k);
        S.setArm(z);
        S.setLaser(true, 0, z);
        sfx.hold('drive', 140, k > 0 && k < 1 ? 0.04 : 0, 'square');
        const b = box3([0, S.skinTop(0, z), z], 3.2);
        if (t > 1) api.mark(b, 'red', t);
        // the iliac crests and the ASIS level on the skeleton: the landmark the mark is set from
        if (t > 7.5) {
          const asisZ = markZ - 2.54;
          const a = api.toPx([-13, S.rest + 6, asisZ]), c = api.toPx([13, S.rest + 6, asisZ]);
          px.line(a[0], a[1], c[0], c[1], 'orange', 0.8, 2);
          px.rect(a[0] - 1, a[1] - 1, 3, 3, 'orange'); px.rect(c[0] - 1, c[1] - 1, 3, 3, 'orange');
          api.keepOut([Math.min(a[0], c[0]) - 4, Math.min(a[1], c[1]) - 4, Math.abs(a[0] - c[0]) + 8, Math.abs(a[1] - c[1]) + 8]);
        }
      },
      caption: [
        { from: 1, to: 7.5, text: 'A red <b>laser</b> cross from the head shows where the scan will start. The arm is driven to the patient.' },
        { from: 7.5, to: 13, place: 'left', text: 'Its mark: on the midline, <b>2.5 cm above the ASIS</b> (the front points of the iliac crests). From there the scan runs up toward the ribs.' },
      ],
    },
  ];
  void clamp01;
  return { title: 'The scanner and the patient', steps };
}
