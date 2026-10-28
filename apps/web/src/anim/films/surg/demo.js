/* THE KIT'S DEMONSTRATION: the kit end to end, as the lumbar puncture film's placeholder plays it.
   The opening (the tray, the betadine, the needle, the prep, the drape, the C-arm's cover); the C
   turned from AP into the left oblique with the monitor following it; a needle advanced to the
   left L4 medial branch with the live image and the cross-section; the closing. */
import { VIEWS, LANDMARKS } from './kit.js';

export function demoChapters(api, K) {
  const { span, px } = api;
  const LM = LANDMARKS.child;
  const view = (o, t) => ({ orbital: o, tilt: t });
  const AP = VIEWS.lumbar.ap, OBL = VIEWS.lumbar.scottie;
  // the needle: aimed at the left L4 medial branch, in from the skin straight down the beam of the
  // oblique (a 'down the barrel' approach)
  const target = LM.L4.mbL;
  const N = K.needle('spinal');
  const { d } = (() => { const o = OBL.orbital * Math.PI / 180, t = OBL.tilt * Math.PI / 180; return { d: [Math.sin(o), Math.cos(o) * Math.cos(t), Math.cos(o) * Math.sin(t)] }; })();
  const dir = [-d[0], -d[1], -d[2]];                        // into the body: against the beam
  const entry = K.entry(target, dir);
  K.setSite(entry);                                         // the prep and the drape's window round it
  const wide = () => { const c = K.toRoom([0, 8, 10]); return [[0, [c[0] + 190, c[1] + 120, c[2] - 150], [c[0] - 30, c[1] + 10, c[2] - 30], 40], [9, [c[0] + 170, c[1] + 100, c[2] - 130], [c[0] - 30, c[1] + 10, c[2] - 30], 40]]; };
  const near = () => { const c = K.toRoom(target); return [[0, [c[0] + 34, c[1] + 30, c[2] - 26], c, 40], [10, [c[0] + 26, c[1] + 24, c[2] - 18], c, 36]]; };

  const steps = [
    {
      title: 'The oblique: Scottie dogs', dur: 10, scale: '1 m',
      enter() { K.reset('procedure'); K.carm.set(AP); },
      cam: wide(),
      cues: [[0.6, K.sfx.pulse], [9, K.sfx.pulse]],
      frame(t) {
        const k = span(t, 1, 8);
        K.carm.ease(AP, OBL, k);
        K.carm.beam(0.6);
        K.monitor.show({ seed: 1 + Math.floor(t * 8) });
        const s = 70, at = K.monitor.blit(px, px.W - s - 6, 6, s);
        const pd = at(LM.L4.pedicleL);
        if (t > 8 && pd) api.mark([pd[0] - 5, pd[1] - 5, 10, 10], 'yellow', t);
      },
      caption: [{ from: 0.5, to: 10, text: 'The C turned <b>30°</b> toward the left and tilted to flatten the endplates: the <b>Scottie dogs</b> stand on the vertebral bodies.' }],
    },
    {
      title: 'The needle down the beam', dur: 10, scale: '10 cm',
      // (the drape off and the skin see-through: the needle's path to the bone in 3D)
      enter() { K.reset('procedure'); K.room.drape.set(0); K.carm.set(OBL); N.place(entry, target); N.stylet(1); },
      cam: near(),
      cues: [[1, K.sfx.pulse], [5, K.sfx.pulse], [9, K.sfx.pulse]],
      frame(t) {
        N.advance(span(t, 0.8, 8.5));
        K.xray(span(t, 0.3, 1.5) * 0.9);
        K.monitor.show({ needles: [N.segment()], seed: 20 + Math.floor(t * 8) });
        K.monitor.blit(px, px.W - 76, 6, 70);
        K.section({ needle: N, x: 6, y: 6, w: 84, h: 72, across: [1, 0, 0] });
      },
      caption: [{ from: 0.5, to: 10, text: 'In the oblique the needle is aimed <b>down the beam</b>: on the screen a dot, in the section a path through skin, fat and muscle to bone.' }],
    },
  ];
  return [
    { title: 'Opening', steps: K.opening() },
    { title: 'The kit', steps },
    { title: 'Closing', steps: K.closing({ sharps: [N], sites: [entry] }) },
  ];
}
