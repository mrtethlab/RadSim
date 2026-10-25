/* THE IV FILM: placing a peripheral IV for contrast, the whole of it. Four chapters
   (films/iv/*.js): why and where (the injection a CT needs, gauge and flow, the veins of the arm,
   a vein's wall and valves, what lies beside it); getting ready (hygiene and the patient, the
   supplies, the tourniquet, finding and choosing the vein, the skin's antisepsis); in (the closed
   catheter, the seal, anchoring, the puncture, the flashback, lowering and advancing, threading,
   the needle out, the clamp and the tourniquet off); secured and used (the dressing, the flush,
   the cap, what goes wrong, the power injector, contrast in the vein).

   Its set is the IV room's own (iv.js buildIVModels round the app's arm, films/iv/room.js); the
   needle meets the vein as the app's engine says it does (films/iv/engine.js); the small things
   are 8-bit (films/iv/px.js). In every shot of the site the vein runs to the right toward the
   heart and the needle comes in from the left, the hand's side. */
import { lights } from '../kit/stage.js';
import { buildRoom } from './iv/room.js';
import { runInsertion } from './iv/engine.js';
import { buildInjector } from './iv/injector.js';
import { whyWhere } from './iv/why.js';
import { getReady } from './iv/ready.js';
import { insertion } from './iv/insert.js';
import { secured } from './iv/secure.js';

export async function build(api) {
  const { scene } = api;
  lights(scene, { amb: 1.3, key: 1.8 });
  const S = await buildRoom(api);
  // the insertion, run once by the engine at the film's mark
  S.ins = runInsertion({ mark: { veinId: 'medianCubital', lateral: S.mark.lateral, radius: 3.0, depth: 3.5, roll: 0.6, fragility: 0.4,
    atValve: false, atJoin: false, valveAheadMM: null, jointMM: null, nerve: false } });
  S.inj = buildInjector(api, S);
  S.sets = { room: S.room, inj: S.inj.group };
  S.only = (k) => { S.room.visible = true; S.inj.group.visible = k === 'inj' || k === 'room+inj'; };
  /* Every step that shows the room starts it from the same plain state: the arm whole, no
     tourniquet, no kit, no hands, the camera's up the world's; then sets what it shows. */
  S.reset = () => {
    api.camera.up.set(0, 1, 0);
    S.cutaway(0);
    S.band.visible = false;
    S.R3.kit.visible = false; S.R3.syringe.visible = false; S.R3.luer.visible = false; S.R3.swab.visible = false;
    S.R3.prep.spent.visible = false; S.R3.prep.sharps.trayPivot.rotation.x = 0;
    S.hands.left.group.visible = S.hands.right.group.visible = false;
    S.inj.group.visible = false;
    S.R3.thumb.visible = false; S.R3.finger.visible = false; S.R3.gauze.visible = false;
    for (const t of Object.values(S.tubes)) t.visible = true;
    S.supplies(0);
    for (const f of S.resetHooks) f();
  };
  S.resetHooks = [];
  /* What has been used from the table by this point of the procedure (iv.js animatePrep: used
     supplies leave the table): 1 the tourniquet, 2 the dressing, 3 the flush, 4 the cap. */
  S.supplies = (n) => {
    const P = S.R3.prep;
    P.sup.tq.visible = n < 1; P.sup.tega.visible = n < 2; P.flush.group.visible = n < 3; P.sup.capIn.visible = n < 4;
  };  const chapters = [await whyWhere(api, S), await getReady(api, S), await insertion(api, S), await secured(api, S)];
  return { title: 'IV placement: the whole process', chapters };
}
