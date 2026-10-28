/* THE SURGICAL FILMS' KIT: the room, the patient, the C-arm and its live image, the props, the
   needles, the cross-section, and the opening and closing every procedure shares. The four films
   (films/surg-lp.js, surg-hip.js, surg-epidural.js, surg-rfa.js) are built from it.

   ---- FRAMES AND UNITS ---------------------------------------------------------------------
   cm throughout. Room: the fluoroscopy suite's (fluoro/suite.js): y up, the tabletop at y -0.4,
   the floor at -90, the patient's head toward +z, the C-arm's column on -x, the operator, the
   back table and the side cart on +x, the monitor cart past the foot (+x, -z).
   The PATIENT'S FRAME (every target, entry and needle the films give): the patient's mesh frame
   in cm, put in the room by a translation only, so its axes are the room's (geom.js):
     child (prone):  +x its LEFT, +y its BACK (up), +z its head. The lumbar spine runs along x = 0,
                     the canal at y about 1, the skin of the back at y 7.5-9.
     adult (supine): +x its RIGHT, +y its FRONT (up), +z its head (the chest/abdomen/pelvis as
                     the fluoroscopy film lays it, with its thighs).
   K.toRoom(p) / K.fromRoom(p) convert; K.top(x, z) is the patient's top surface (the back, or the
   front) over a point, null off the body.

   ---- THE C-ARM AND ITS IMAGE ----------------------------------------------------------------
   Poses in the suite's own angles: orbital (about the long axis: 0 the beam straight up through
   the table, +90 a lateral, the receptor on +x: the child's LEFT, the adult's RIGHT) and tilt
   (about the table's cross axis, + the receptor toward the head). So for the prone child +orbital
   is an oblique toward its left side (its left facets' Scottie dogs, its left sacral foramina);
   for the supine adult +orbital turns the receptor over its right hip.
   The images are precomputed round each REGION's centre (services/compute app/build_anim_images.py
   surg; public/anim/surg.json): K.aim(region) puts the C-arm's isocentre on that centre (it rolls
   the cart along the table, raises the C, runs the arm out) and K.monitor shows that region.
     region    model   centre (cm)          span   frames (orbital x tilt, degrees)
     lumbar    child   0, 0, 14.25 (L4)     15     0..45 by 3 x -10..25 by 5; 48..90 by 3 at tilt 0
     cervical  child   0.1, 1.0, 50.5       8      0..48 by 4 x -15..30 by 5; 52..90 by 4 at tilt 0
                                                   (a magnified field; the neck's soft tissue faint)
     sacrum    child   0, 3.0, 8.0          13     -8..8 by 4 x -15..39 by 3; 90 at 0
     hip       adult   8.9, -2.8, -27.2     16     -20..20 by 5 x -10..10 by 5 (the right hip)
   Between the grid's angles the image is blended (geom.js frameWeights): a C-arm turning
   smoothly shows a smoothly turning image. Outside a grid: the nearest frame.
   VIEWS (below) names the poses that show each procedure's view at its best.

   ---- THE API ---------------------------------------------------------------------------
   const K = await buildKit(api, { patient: 'child' | 'adult', region: 'lumbar' | ..., rfa: bool })
     api, THREE, SI (images.js), room (room.js), suite (fluoro/suite.js), VIEWS, LANDMARKS, v3
     K.toRoom(p), K.fromRoom(p), K.top(x, z), K.entry(target, dir) (geom.js skinEntry)
     K.xray(k)                          the skin see-through (0..1), the bones shown under it
     K.aim(region)                      the isocentre to region's centre; K.region (the current)
     K.carm.set({ orbital, tilt })      pose the C (degrees; merged with the current pose)
     K.carm.pose                        { orbital, tilt } as set
     K.carm.ease(a, b, k)               the pose a -> b at k (0..1), set and returned
     K.carm.beam(a)                     the beam's fan, faintly, 0..1
     K.cover.set(k)                     the C's sterile cover, 0 off .. 1 on
     K.monitor.show(opts)               the live screen: the current region at the current pose;
                                        opts: needles [{ from, to, od, w }], blobs [{ at, r, od }],
                                        seed (the pulse), label (a short line), orbital/tilt to
                                        override; returns the image (lum, n x n)
     K.monitor.dark(), K.monitor.spot() the live screen black; the last image held on the reference
     K.monitor.blit(px, x, y, size, opts)  the same image on the 8-bit layer (a frame drawn round
                                        it, kept clear of captions); returns at(p) -> [x, y]: where a
                                        point of the patient's frame shows on it
     K.monitor.at(): the live screen's world centre (for a camera)
     K.frameOf(orbital, tilt)           the nearest frame's index in the current region
     K.needle(kind)                     a new Needle (below): 'spinal' | 'locator' | 'cannula'
     K.probe()                          an RF probe (place it with K.seat(probe, cannula, k))
     K.syringe({ ml, color, needle })   a syringe (props.js makeSyringe), in the room
     K.vial(kind)                       'contrast' | 'lidocaine' | 'steroid' | 'saline', on the side cart
     K.section(opts)                    the 8-bit cross-section (xsec.js drawSection) in the
                                        region's tissue crop; opts.needle (a Needle) fills tip/dir/hub
     K.tissuesAlong(p0, p1)             the tissues a line crosses ([{ tissue, from, to }], cm)
     K.hands.left / right               gloved hands (iv/room.js gloveHand: pose, place, tip)
     K.props                            the table, pack, tray, bottle, side cart, sharps, wrap,
                                        generator, pad, dressings, trayNeedle (see below)
     K.reset(stage)                     every kit object as it is at the START of that stage
                                        (STAGES), the rest hidden; a step's enter() calls it first
     K.opening(opts), K.closing(opts)   the shared steps (arrays for a chapter's steps)
     K.sfx                              the 8-bit cues for the procedure (below)

   A Needle (K.needle): g (a child of the patient), kind, len (cm)
     place(entry, target)   aimed from entry (on the skin) at target (the patient's frame)
     advance(f)             its tip f of the way from entry to target (0 at the skin; past 1 deeper)
     stylet(k)              1 in, 0 drawn its whole length out, -1 gone
     tip(), hub(), dir      the patient's frame; segment() -> { from: hub, to: tip } for the image
     lay(at, dir)           lying on the skin from at along dir (the locating needle)
     drip(t, on)            CSF dripping from its hub (t seconds; on 0..1)
     show(on)

   ---- STAGES ------------------------------------------------------------------------------
   'room' (nothing done) 'tray' 'betadine' 'needle' 'pad' 'prep' 'drape' 'cover' 'procedure'
   'sharps' 'repack' 'clean' 'dressing' 'done'. K.reset('procedure') is the room with the tray open,
   the cup poured, the needle on the tray, the pad on (rfa), the skin painted, the drape and the
   cover on: where a film's own chapters start. The opening's steps cover 'tray' to 'cover', the
   closing's 'sharps' to 'dressing'.
   K.opening({ site, needles = ['spinal'], rfa, sharpsAt }) and K.closing({ sharps: [objects],
   repack: [objects], sites: [points] }): site is the skin point the prep and the drape centre on
   (the patient's frame); sharps the needles (Needle, or any Object3D) to drop in the container;
   repack the reusable things wrapped for sterilization (a continuous RF probe); sites the
   puncture sites to dress.

   The opening and closing cameras, captions and sounds are the kit's; a film may change any step
   it gets back (they are plain objects) before it hands them to the player. */
import * as THREE from 'three';
import { lights } from '../../kit/stage.js';
import { buildRoom, TABLE_TOP } from './room.js';
import { loadSurgImages } from './images.js';
import { drawSection, TISSUE } from './xsec.js';
import { nearestFrame, tissuesAlong, skinEntry, v3 } from './geom.js';
import { MAT, place, makePack, makeTray, makeBottle, makeNeedle, makeProbe, makeSyringe, makeVial, makeGenerator, makeCable,
  makeSharps, makeGroundPad, makeDressing, makeSpongeStick } from './props.js';
import { gloveHand } from '../iv/room.js';

export { TISSUE, v3, place };

/* The poses that show each procedure's view (orbital, tilt; the suite's degrees). The films
   sweep the C toward these. */
export const VIEWS = {
  lumbar: {
    ap: { orbital: 0, tilt: 0 },
    lateral: { orbital: 90, tilt: 0 },
    // the endplates flat at L4-L5: the beam along them (L3 0, L4 about 8, L5 about 23 degrees)
    apFlat: { orbital: 0, tilt: 10 },
    // the left Scottie dogs: oblique about 30, tilted to flatten the endplates
    scottie: { orbital: 30, tilt: 10 },
    // the interlaminar windows opened: tilted toward the head
    interlaminar: { orbital: 0, tilt: 20 },
  },
  cervical: {
    ap: { orbital: 0, tilt: 0 },
    lateral: { orbital: 90, tilt: 0 },
    // the 'American flag': oblique toward the left, the bodies' endplates flat (the stripes), the
    // transverse process and pillar in the corner (the canton)
    flag: { orbital: 36, tilt: 15 },
  },
  sacrum: {
    ap: { orbital: 0, tilt: 0 },
    // the S1-S3 foramina lined up (round, bright, in two columns), the ala clear of L5
    foramina: { orbital: 0, tilt: 30 },
    lateral: { orbital: 90, tilt: 0 },
  },
  hip: { ap: { orbital: 0, tilt: 0 } },
};

/* Points of the child's spine (the patient's frame, cm), measured from its voxels (approximate:
   check a path with K.tissuesAlong). Left = +x. mbL: the left medial branch's target, where the
   transverse process meets the superior articular process. interlaminar: the thecal sac's
   back wall on the midline between the laminae. skinBack: the skin on the midline. */
export const LANDMARKS = {
  child: {
    L1: { body: [0, -0.39, 21.9], pedicleL: [0.98, 1.8, 22.35], mbL: [1.95, 2.7, 22.2], canal: [0, 1.65, 21.9] },
    L2: { body: [0, -0.74, 19.44], pedicleL: [1.12, 1.5, 19.95], mbL: [2.25, 2.25, 19.8], canal: [0, 1.35, 19.44] },
    L3: { body: [0, -1.14, 16.91], pedicleL: [1.35, 0.9, 17.25], mbL: [2.7, 1.95, 17.1], canal: [0, 0.9, 16.91] },
    L4: { body: [0, -1.19, 14.25], pedicleL: [1.58, 0.9, 14.7], mbL: [3.0, 1.9, 14.55], canal: [0, 0.9, 14.25] },
    L5: { body: [0, -0.82, 11.59], pedicleL: [1.65, 1.43, 12.15], mbL: [3.3, 1.8, 12.0], canal: [0, 1.8, 11.59] },
    interlaminar: { 'L2-L3': [0, 1.65, 18.15], 'L3-L4': [0, 1.5, 15.6], 'L4-L5': [0, 1.65, 12.75] },
    skinBack: { L3: [0, 7.5, 16.8], 'L3-L4': [0, 8.1, 15.6], L4: [0, 8.7, 14.25], 'L4-L5': [0, 8.85, 13.05], L5: [0, 9.0, 11.55] },
    C4: { body: [0.09, 0.27, 50.64] },
    // the sacral foramina's dorsal openings, found down the beam of VIEWS.sacrum.foramina (the
    // rays through the bright holes cross no bone): left (+x) and right
    sacrum: { S1L: [1.74, 4.25, 9.23], S2L: [1.16, 3.6, 7.53], S3L: [1.16, 4.4, 5.63], S1R: [-2.74, 4.23, 8.87], S2R: [-2.02, 3.6, 7.4], S3R: [-1.88, 4.4, 5.63] },
  },
  adult: {
    femoralHeadR: [8.9, -2.8, -27.2],         // its centre, r 2.2 (landmarks.json, in the films' frame)
  },
};
export const STAGES = ['room', 'tray', 'betadine', 'needle', 'pad', 'prep', 'drape', 'cover', 'procedure', 'sharps', 'repack', 'clean', 'dressing', 'done'];

export async function buildKit(api, { patient = 'child', region = patient === 'adult' ? 'hip' : 'lumbar', rfa = false } = {}) {
  const { scene, span, sfx } = api;
  lights(scene, { amb: 1.4, key: 2.0 });
  scene.fog = new THREE.Fog(0x0a0c0f, 420, 1100);
  const [room, SI] = await Promise.all([buildRoom(api, { patient }), loadSurgImages()]);
  const U = room.suite;
  const K = { api, THREE, SI, room, suite: U, VIEWS, LANDMARKS, STAGES, v3, rfa, patient };
  K.toRoom = room.toRoom; K.fromRoom = room.fromRoom; K.top = room.top; K.xray = room.xray;
  K.entry = (target, dir) => skinEntry(room.top, target, dir);
  const crop = { lumbar: 'lspine', sacrum: 'lspine', cervical: 'cspine', hip: 'hip' };

  // ---- the C-arm
  K.carm = {
    pose: { orbital: 0, tilt: 0 },
    set(p = {}) { Object.assign(K.carm.pose, p); U.setPose({ orbital: K.carm.pose.orbital, tilt: K.carm.pose.tilt }); return K.carm.pose; },
    ease(a, b, k) { return K.carm.set({ orbital: a.orbital + (b.orbital - a.orbital) * k, tilt: a.tilt + (b.tilt - a.tilt) * k }); },
    beam(a = 1) { U.setBeam({ a }); },
  };
  K.aim = (name) => {
    K.region = name;
    const c = K.toRoom(SI.regions[name].centre);
    U.setPose({ ext: c[0], lift: c[1] - room.ISO[1], slide: c[2], wig: 0, over: 0 });
    K.carm.set();
  };
  K.cover = room.cover;
  K.frameOf = (o = K.carm.pose.orbital, t = K.carm.pose.tilt) => nearestFrame(SI.regions[K.region], o, t);

  // ---- the monitor
  let last = null, inset = null, insetFrame = 0;
  function crisp(px, L, x, y, size, a) {
    const host = px.cv.parentElement; if (!host) return;
    if (!inset || inset.parentElement !== host) {
      inset = document.createElement('canvas'); inset.className = 'surg-inset';
      host.insertBefore(inset, px.cv);
    }
    const k = px.cv.clientHeight / px.H, dpr = devicePixelRatio || 1;
    const w = Math.round(size * k * dpr);
    if (inset.width !== w) { inset.width = w; inset.height = w; }
    Object.assign(inset.style, { left: `${x * k}px`, top: `${y * k}px`, width: `${size * k}px`, height: `${size * k}px`, opacity: a, display: 'block' });
    const g = inset.getContext('2d');
    g.fillStyle = '#04060a'; g.fillRect(0, 0, w, w);
    const off = SI.offscreen(L.lum, L.n, [4, 6, 9]);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(off, 0, 0, w, w);
    // hidden again on the first frame no step draws it
    const f = ++insetFrame;
    requestAnimationFrame(() => requestAnimationFrame(() => { if (f === insetFrame && inset) inset.style.display = 'none'; }));
  }
  K.monitor = {
    show({ needles = [], blobs = [], seed = 1, label = null, orbital = K.carm.pose.orbital, tilt = K.carm.pose.tilt, region = K.region } = {}) {
      const n = SI.regions[region].n;
      last = { lum: SI.image(region, orbital, tilt, { needles, blobs, seed }), n, region, orbital, tilt };
      SI.toScreen(U.tower.live, last.lum, n, { label });
      return last.lum;
    },
    dark() { SI.toScreen(U.tower.live, null, 0); last = null; },
    spot(label = null) { if (last) SI.toScreen(U.tower.ref, last.lum, last.n, { label }); },
    clearRef() { SI.toScreen(U.tower.ref, null, 0); },
    /* The image is drawn at the screen's own resolution on a canvas under the 8-bit layer (the
       layer's 200 rows would block the vertebrae up); the layer draws only its frame, so marks
       on the image (api.mark at at(p)) land on top of it. */
    blit(px, x, y, size, { a = 1 } = {}) {
      if (!last) return () => null;
      px.frame(x - 2, y - 2, size + 4, size + 4, 'dkgrey', a);
      api.keepOut([x - 2, y - 2, size + 4, size + 4]);
      crisp(px, last, x, y, size, a);
      const L = last;
      return (p) => SI.onBlit(L.region, L.orbital, L.tilt, p, x, y, size);
    },
    at: () => room.screenAt(0),
    atRef: () => room.screenAt(1),
  };

  // ---- needles, probes, syringes, vials
  const made = [];
  K.needle = (kind = 'spinal') => {
    const N = makeNeedle({ kind });
    room.pat.add(N.g); made.push(N.g);
    let entry = [0, 0, 0], target = [0, 0, -1];
    N.dir = [0, 0, -1];
    N.place = (e, t) => { entry = e; target = t; N.dir = v3.norm(v3.sub(t, e)); N.advance(0); return N; };
    N.advance = (f) => {
      const L = v3.len(v3.sub(target, entry)), tip = v3.add(entry, v3.mul(N.dir, f * L));
      // its +z is back toward the hub: against the way it points
      place(N.g, tip, v3.mul(N.dir, -1), [0, 1, 0]);
      N._tip = tip;
      N.g.visible = true;
      return N;
    };
    N.lay = (at, dir) => {
      const d = v3.norm([dir[0], 0, dir[2]]), y = (room.top(at[0], at[2]) ?? at[1]) + 0.12;
      place(N.g, [at[0], y, at[2]], v3.mul(d, -1), [0, 1, 0]);
      N._tip = [at[0], y, at[2]]; N.dir = d; N.g.visible = true;
      return N;
    };
    N.tip = () => N._tip || entry;
    N.hub = () => v3.sub(N.tip(), v3.mul(N.dir, N.len + N.hubLen));
    N.segment = (od = kind === 'cannula' ? 2.2 : 1.6, w = kind === 'cannula' ? 1.4 : 1) => ({ from: v3.sub(N.tip(), v3.mul(N.dir, N.len)), to: N.tip(), od, w });
    N.show = (on) => { N.g.visible = !!on; return N; };
    N.g.visible = false;
    return N;
  };
  K.probe = () => { const p = makeProbe(); room.pat.add(p.g); made.push(p.g); p.g.visible = false; return p; };
  /* An RF probe down a cannula: k 0 its tip at the cannula's hub, 1 home (its tip at the cannula's). */
  K.seat = (probe, cannula, k) => {
    const tip = v3.add(cannula.tip(), v3.mul(cannula.dir, -(1 - k) * (cannula.len + 1.8)));
    place(probe.g, tip, v3.mul(cannula.dir, -1), [0, 1, 0]);
    probe.g.visible = true;
  };
  K.syringe = (o = {}) => { const s = makeSyringe(o); U.g.add(s.g); made.push(s.g); s.g.visible = false; return s; };
  /* A syringe on a needle's hub: k 0 three cm back along its line, 1 seated. */
  K.attach = (syr, needle, k = 1) => {
    const at = v3.sub(needle.tip(), v3.mul(needle.dir, needle.len + needle.hubLen + (1 - k) * 3));
    const w = K.toRoom(at), d = needle.dir;
    place(syr.g, w, v3.mul(d, -1), [0, 1, 0]);
    syr.g.visible = true;
  };
  const VIAL = {
    contrast: { lines: ['CONTRAST', 'iohexol 300'], cap: 0x7a4bc4, band: '#7a4bc4', liquid: 0xfaf6e6 },
    lidocaine: { lines: ['LIDOCAINE 1%', '5 mL'], cap: 0x2f6fd6, band: '#2f6fd6' },
    steroid: { lines: ['STEROID', 'triamcinolone 40'], cap: 0xe08a2a, band: '#e08a2a', liquid: 0xf2f2f0 },
    saline: { lines: ['SALINE 0.9%', '10 mL'], cap: 0x30a050, band: '#30a050' },
  };
  const vialSpots = { contrast: [-8, 0, -12], lidocaine: [-3, 0, -12], steroid: [2, 0, -12], saline: [7, 0, -12] };
  K.vial = (kind) => {
    const v = makeVial(VIAL[kind]); room.side.add(v.g); v.g.position.set(...vialSpots[kind]); v.kind = kind; return v;
  };

  // ---- props laid out: the pack and tray on the back table; the bottle, vials and the needle's
  // peel pack on the side cart; the sharps container on the side cart's far end; the generator
  // (rfa) at the head end; the wrap for re-packing on the back table's far end
  const pack = makePack({ w: 40, h: 7, d: 30 }); room.backT.g.add(pack.g); pack.g.position.set(0, 0, 8);
  const tray = makeTray(); pack.contents.add(tray.g); tray.g.position.set(0, 0.1, 0);
  const bottle = makeBottle(); room.side.add(bottle.g);
  const bottleStand = [8, 0, 8];
  bottle.g.position.set(...bottleStand);
  const trayNeedle = makeNeedle({ kind: rfa ? 'cannula' : 'spinal' });
  tray.g.add(trayNeedle.g);
  // the needle in its peel pack (the circulator's): two clear halves, opened over the tray
  const peel = new THREE.Group(); room.room.add(peel);
  const halves = [0, 1].map((i) => { const h = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.15, 14), MAT.clear(0xf2f7fb, 0.45)); peel.add(h); return h; });
  const sharps = makeSharps(); room.side.add(sharps.g); sharps.g.position.set(0, 0, -6); sharps.g.rotation.y = -Math.PI / 2;
  sharps.g.position.set(0, 0, 14);
  const wrap = makePack({ w: 30, h: 5, d: 22, color: 0x4a8a5a }); room.backT.g.add(wrap.g); wrap.g.position.set(0, 0, -26);
  // what goes back for sterilization in the wrap: a clamp, a bowl (and the films' own: K.props.wrap.contents)
  {
    const st = MAT.steel();
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 3, 3, 24, 1, true), st); bowl.position.set(-6, 1.5, 0); wrap.contents.add(bowl);
    wrap.contents.add(new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 0.2, 24), st)).position.set(-6, 0.1, 0);
    const clamp = new THREE.Group(); clamp.position.set(6, 0.4, 0); wrap.contents.add(clamp);
    for (const s of [-1, 1]) { const arm = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.3, 13), st); arm.rotation.y = s * 0.08; arm.position.x = s * 0.5; clamp.add(arm); }
    for (const s of [-1, 1]) { const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.2, 6, 16), st); ring.rotation.x = Math.PI / 2; ring.position.set(s * 1.4, 0, -7); clamp.add(ring); }
  }
  let gen = null, genCable = null;
  if (rfa) {
    gen = makeGenerator(); room.room.add(gen.g); gen.g.position.set(92, -90, 36); gen.g.rotation.y = -Math.PI / 2 - 0.3;
    genCable = makeCable(); room.room.add(genCable);
  }
  const pad = makeGroundPad(); room.pat.add(pad.g); pad.g.visible = false;
  const padCable = makeCable(0x2f6fd6, 0.2); room.room.add(padCable); padCable.visible = false;
  const dressings = [];
  const sponge = makeSpongeStick(); room.pat.add(sponge.g); sponge.g.visible = false;
  const gauzeWipe = new THREE.Mesh(new THREE.BoxGeometry(5, 0.6, 5), new THREE.MeshStandardMaterial({ color: 0xfbfbf6, roughness: 0.95 }));
  room.pat.add(gauzeWipe); gauzeWipe.visible = false;
  const hands = {
    left: gloveHand(new THREE.MeshStandardMaterial({ color: 0xe9d6a4, roughness: 0.42 }), new THREE.MeshStandardMaterial({ color: 0x2b5f7a, roughness: 0.9 }), -1),
    right: gloveHand(new THREE.MeshStandardMaterial({ color: 0xe9d6a4, roughness: 0.42 }), new THREE.MeshStandardMaterial({ color: 0x2b5f7a, roughness: 0.9 }), 1),
  };
  room.room.add(hands.left.group, hands.right.group);
  K.hands = hands;
  K.props = { table: room.backT, pack, tray, bottle, bottleStand, trayNeedle, peel, side: room.side, sharps, wrap, gen, genCable, pad, padCable, dressings, sponge };

  // world positions of things on the tables
  const wp = (obj, local = [0, 0, 0]) => { obj.updateMatrixWorld(true); const v = new THREE.Vector3(...local); obj.localToWorld(v); return [v.x, v.y, v.z]; };
  const inParent = (obj, worldP) => { const v = new THREE.Vector3(...worldP); obj.parent.worldToLocal(v); return [v.x, v.y, v.z]; };
  K.wp = wp;

  // ---- the procedure's 8-bit sounds
  K.sfx = {
    rustle: () => { sfx.hiss(0.18, 0.12, 2200); sfx.hiss(0.12, 0.08, 3200, 0.1); },
    pour: (on) => (on ? sfx.hold('pour', 180, 0.02, 'triangle') : sfx.stop('pour')),
    drop: () => { sfx.tick(); sfx.tone(1800, 1500, 0.04, 'square', 0.2, 0.05); },
    snap: () => sfx.tone(900, 600, 0.06, 'square', 0.3),
    pulse: () => sfx.blip(1040),                       // a fluoro pulse (a shot)
    stim: (hz = 2) => sfx.tone(hz > 10 ? 1200 : 520, hz > 10 ? 1200 : 480, 0.05, 'square', 0.25),
    heat: (on, f = 220) => (on ? sfx.hold('rf', f, 0.03, 'triangle') : sfx.stop('rf')),
    sharps: () => { sfx.thud(); },
  };

  // ---- the section
  K.section = (o = {}) => {
    const N = o.needle;
    const opts = { ...o };
    if (N) { opts.tip = opts.tip || N.tip(); opts.dir = opts.dir || N.dir; opts.hub = opts.hub || v3.sub(N.tip(), v3.mul(N.dir, N.len)); }
    return drawSection(api, SI, o.crop || crop[K.region], opts);
  };
  K.tissuesAlong = (p0, p1, cropName = crop[K.region]) => tissuesAlong(SI.crops[cropName], p0, p1).map((s) => ({ tissue: s.code < 0 ? null : SI.tissue[s.code], from: s.from, to: s.to }));

  // ---- the site: where the prep and the drape centre, and the pad's place
  let site = patient === 'adult' ? [LANDMARKS.adult.femoralHeadR[0], 0, LANDMARKS.adult.femoralHeadR[2]] : [0, 0, 14.25];
  K.setSite = (p) => {
    site = [p[0], room.top(p[0], p[2]) ?? p[1], p[2]];
    room.prep.site(site); room.drape.site(site);
  };
  K.setSite(site);
  // the pad: the child's left thigh (behind), the adult's right thigh (front); laid on the skin
  const padAt = patient === 'adult' ? [10, -48] : [6, -24];
  const padLaid = (() => {
    const out = [], p = pad.rest;
    for (let i = 0; i < p.length; i += 3) {
      const x = padAt[0] + p[i], z = padAt[1] + p[i + 2];
      out.push(x, (room.top(x, z) ?? 0) + 0.15, z);
    }
    return out;
  })();
  K.padOn = (k) => {
    pad.g.visible = k > 0.001;
    const pos = pad.geo.attributes.position, lift = (1 - k) * 12;
    for (let i = 0; i < pos.count; i++) {
      const curl = (1 - k) * (1 - k) * (pad.rest[i * 3] + 7) * 0.4;
      pos.setXYZ(i, padLaid[i * 3], padLaid[i * 3 + 1] + lift + curl, padLaid[i * 3 + 2]);
    }
    pos.needsUpdate = true; pad.geo.computeVertexNormals(); pad.geo.computeBoundingSphere();
    pad.g.children[1].position.set(padAt[0] + 8.2, (room.top(padAt[0] + 7, padAt[1]) ?? 0) + 0.3 + lift, padAt[1]);
    // its lead to the generator
    padCable.visible = k > 0.6 && !!gen;
    if (padCable.visible) padCable.userData.set(K.toRoom([padAt[0] + 9.5, (room.top(padAt[0] + 7, padAt[1]) ?? 0) + 0.4, padAt[1]]), wp(gen.g, [gen.socket(3).x, gen.socket(3).y, gen.socket(3).z]), 25);
  };
  /* A dressing (gauze and tape) laid on the skin at a site: k 0 above, 1 down and taped. */
  K.dressing = (at, k) => {
    let d = dressings.find((e) => e.at === at);
    if (!d) { d = makeDressing(); d.at = at; room.pat.add(d.g); dressings.push(d); }
    const y = (room.top(at[0], at[2]) ?? at[1]) + 0.15;
    d.g.visible = k > 0.001;
    d.g.position.set(at[0], y + (1 - span(k, 0, 0.5)) * 8, at[2]);
    d.tapes.forEach((t, i) => { t.visible = k > 0.55 + i * 0.2; });
    return d;
  };

  // ---- the stages
  K.reset = (stage = 'room') => {
    const s = STAGES.indexOf(stage), past = (name) => s > STAGES.indexOf(name);
    api.camera.up.set(0, 1, 0);
    K.aim(K.region || region);
    K.carm.set({ orbital: 0, tilt: 0 }); K.carm.beam(0);
    U.skinAlpha?.(1); K.xray(0);
    U.staff.g.visible = false; U.ceiling.visible = false; U.skirt.visible = false; U.pedal.visible = true; U.press(0);
    for (const g of made) g.visible = false;
    hands.left.group.visible = hands.right.group.visible = false;
    pack.open(past('tray') ? 1 : 0);
    tray.fill(past('betadine') ? 1 : 0);
    bottle.pour(0, bottleStand, bottleStand); bottle.g.position.set(...bottleStand);
    trayNeedle.g.visible = past('needle') && !past('sharps');
    place(trayNeedle.g, tray.spots.needle, [-1, 0, 0.05], [0, 1, 0]); trayNeedle.stylet(1);
    peel.visible = false;
    K.padOn(rfa && past('pad') && !past('clean') ? 1 : 0);
    room.prep.paint(past('prep') ? 1 : 0);
    if (past('clean')) room.prep.paint(0);
    room.drape.set(past('drape') && !past('clean') ? 1 : 0);
    K.cover.set(past('cover') ? 1 : 0);
    wrap.close(past('repack') ? 1 : 0);
    wrap.g.visible = past('procedure');
    for (const d of dressings) d.g.visible = false;
    sponge.g.visible = false; gauzeWipe.visible = false;
    if (gen) { gen.screen({ mode: '' }); genCable.visible = false; }
    tray.sticks.forEach((st) => { st.g.visible = !past('prep'); st.soak(0); });
    K.monitor.dark(); K.monitor.clearRef();
    for (const id of ['pour', 'rf']) sfx.stop(id);
  };

  // ---- camera framings (room): over the back table, at the site, at the C's receptor
  const tableCam = () => { const c = wp(room.backT.g, [0, 0, 8]); return { look: [c[0], c[1] + 2, c[2]], pos: [c[0] + 40, c[1] + 62, c[2] - 46] }; };
  const siteCam = (dist = 70) => { const c = K.toRoom(site); return { look: c, pos: [c[0] + dist * 0.75, c[1] + dist * 0.85, c[2] - dist * 0.5] }; };
  K.cams = { tableCam, siteCam };

  /* ---------------------------------------------------------------- the opening */
  K.opening = ({ needles = [rfa ? 'cannula' : 'spinal'], captions = true } = {}) => {
    const T = tableCam(), S = siteCam();
    const cap = (arr) => (captions ? arr : []);
    const steps = [];
    steps.push({
      title: 'Open the sterile tray', dur: 8, fadeIn: 0.6, scale: '10 cm',
      enter() { K.reset('tray'); },
      cam: [[0, [T.pos[0] + 30, T.pos[1] + 30, T.pos[2] - 30], T.look, 40], [8, T.pos, T.look, 38]],
      cues: [1.3, 2.5, 3.6, 4.7].map((c) => [c, K.sfx.rustle]),
      frame(t) { pack.open(span(t, 1, 5.6)); if (t > 1 && t < 5.8) api.mark(pack.g, 'yellow', t); },
      caption: cap([
        { from: 0.8, to: 4.4, text: 'The wrap opens <b>away</b> first, then the sides, then toward you: nothing reaches over the open tray.' },
        { from: 4.4, to: 8, text: 'Inside the inner wrap, everything is <b>sterile</b>; the outer edge of the wrap is not.' },
      ]),
    });
    steps.push({
      title: 'Betadine into the cup', dur: 7, scale: '10 cm',
      enter() { K.reset('betadine'); },
      cam: [[0, T.pos, T.look, 38], [7, [T.pos[0] + 10, T.pos[1] - 8, T.pos[2] - 8], T.look, 34]],
      cues: [[2.3, () => K.sfx.pour(true)], [5.4, () => K.sfx.pour(false)]],
      frame(t) {
        const k = span(t, 0.5, 6.5, api.ease.linear);
        const cupW = wp(tray.cup, [0, 4, 0]);
        const { fill } = bottle.pour(k, bottleStand, inParent(bottle.g, cupW));
        tray.fill(fill);
        if (t > 1 && t < 6) api.mark(tray.cup, 'yellow', t, { live: true });
      },
      caption: cap([{ from: 0.8, to: 7, text: 'The circulator pours <b>povidone-iodine</b> into the sterile cup from above: the bottle never touches the tray.' }]),
    });
    steps.push({
      title: 'The needle onto the tray', dur: 7, scale: '10 cm',
      enter() { K.reset('needle'); },
      cam: [[0, T.pos, T.look, 34], [7, [T.pos[0] - 6, T.pos[1] - 10, T.pos[2] + 6], T.look, 30]],
      cues: [[2.2, K.sfx.rustle], [4.6, K.sfx.drop]],
      frame(t) {
        // the peel pack held 14 cm over the tray, peeled apart, the needle dropped in
        const spot = wp(tray.g, tray.spots.needle), over = [spot[0], spot[1] + 14, spot[2]];
        peel.visible = t < 5.5;
        const op = span(t, 1.8, 3.2);
        peel.position.set(...over);
        halves.forEach((h, i) => { h.position.set((i ? 1 : -1) * (0.6 + op * 2.2), 0, 0); h.rotation.z = (i ? -1 : 1) * op * 0.9; });
        const fall = span(t, 3.4, 4.6, api.ease.in);
        trayNeedle.g.visible = true;
        const p = inParent(trayNeedle.g, [over[0], over[1] - fall * 13.4, over[2]]);
        place(trayNeedle.g, [p[0] + 4.5, p[1], p[2]], [-1, -0.0, 0.05 + (1 - fall) * 0.2], [0, 1, 0]);
        if (t > 3 && t < 6.5) api.mark(trayNeedle.g, 'yellow', t, { live: true });
      },
      caption: cap([{ from: 0.8, to: 7, text: needles[0] === 'cannula'
        ? 'The <b>RF cannulae</b> are peeled open and dropped onto the tray: the circulator’s hands stay outside the sterile field.'
        : 'The <b>spinal needle</b> is peeled open and dropped onto the tray: the circulator’s hands stay outside the sterile field.' }]),
    });
    if (rfa) steps.push({
      title: 'The grounding pad', dur: 7, scale: '10 cm',
      enter() { K.reset('pad'); genCable.visible = false; },
      cam: (() => { const c = K.toRoom([padAt[0], room.top(padAt[0], padAt[1]) ?? 0, padAt[1]]); return [[0, [c[0] + 60, c[1] + 55, c[2] - 30], c, 40], [7, [c[0] + 45, c[1] + 40, c[2] - 18], c, 38]]; })(),
      cues: [[3.6, K.sfx.snap]],
      frame(t) { K.padOn(span(t, 0.8, 3.6)); if (t > 1) api.mark(pad.g, 'yellow', t, { live: true }); },
      caption: cap([{ from: 0.8, to: 7, text: 'The <b>grounding pad</b> on clean, dry skin with good contact: the RF current returns through it, spread wide so it never heats the skin.' }]),
    });
    steps.push({
      title: 'Skin preparation', dur: 10, scale: '10 cm',
      enter() { K.reset('prep'); },
      cam: [[0, S.pos, S.look, 40], [10, [S.pos[0] - 12, S.pos[1] - 10, S.pos[2] + 6], S.look, 36]],
      frame(t) {
        // the stick dipped in the cup, then the prep painted outward from the site in a spiral
        const k = span(t, 2, 9.4, api.ease.linear), at = room.prep.paint(k);
        const soak = span(t, 0.4, 1.6);
        sponge.soak(soak); sponge.g.visible = true;
        if (t < 2) {
          const c = K.fromRoom(wp(tray.cup, [0, 2, 0]));
          place(sponge.g, v3.sub(c, [0, -14 + soak * 4, 12]), v3.norm([0, -0.7, 0.7]), [0, 0, 1]);
        } else {
          // the head on the skin, the handle up and back toward the operator
          const d = v3.norm([-0.35, -0.85, 0.4]);
          place(sponge.g, v3.sub(v3.add(at, [0, 0.9, 0]), v3.mul(d, 19.5)), d, [1, 0, 0]);
        }
        if (t > 2.2) api.mark(room.prep.mesh, 'yellow', t);
      },
      caption: cap([
        { from: 0.5, to: 5, text: 'Prep from the <b>site outward</b> in widening circles, never back over prepped skin.' },
        { from: 5, to: 10, text: 'Let it <b>dry</b>: povidone-iodine kills as it dries.' },
      ]),
    });
    steps.push({
      title: 'The fenestrated drape', dur: 7, scale: '10 cm',
      enter() { K.reset('drape'); },
      cam: [[0, [S.pos[0] + 30, S.pos[1] + 40, S.pos[2] - 20], S.look, 44], [7, [S.pos[0] + 20, S.pos[1] + 30, S.pos[2] - 10], S.look, 42]],
      cues: [[1, K.sfx.rustle], [3, K.sfx.rustle]],
      frame(t) { room.drape.set(span(t, 0.6, 5.2)); if (t > 4.5) api.mark(room.drape.mesh, 'yellow', t); },
      caption: cap([{ from: 0.8, to: 7, text: 'The <b>fenestrated drape</b>: its window over the prepped site, the rest of the patient covered.' }]),
    });
    steps.push({
      title: 'The C-arm cover', dur: 7, scale: '1 m',
      enter() { K.reset('cover'); },
      cam: () => {
        const c = wp(U.carm.c, [0, U.DET + 15, 0]);
        return [[0, [c[0] + 160, c[1] + 50, c[2] + 120], c, 40], [7, [c[0] + 130, c[1] + 30, c[2] + 95], c, 40]];
      },
      cues: [[1.2, K.sfx.rustle], [4.4, K.sfx.snap]],
      frame(t) { K.cover.set(span(t, 1, 4.4)); if (t > 1) api.mark(K.cover.g, 'yellow', t, { live: true }); },
      caption: cap([{ from: 0.8, to: 7, text: 'A clear <b>sterile cover</b> over the receptor: it sits over the open field and is touched during the case.' }]),
    });
    // (the cover step's camera follows the C wherever it was aimed: resolved when it begins)
    const cv = steps[steps.length - 1], camF = cv.cam;
    let keys = null;
    cv.cam = (t) => {
      if (!keys || t < 0.05) keys = camF();
      const k = api.ease.inOut(Math.min(1, t / 7));
      return { pos: v3.lerp(keys[0][1], keys[1][1], k), look: keys[0][2], fov: 40 };
    };
    return steps;
  };

  /* ---------------------------------------------------------------- the closing */
  K.closing = ({ sharps: toSharps = [], repack = [], sites = [site], captions = true } = {}) => {
    const S = siteCam(), T = tableCam();
    const cap = (arr) => (captions ? arr : []);
    const mouth = () => wp(sharps.g, sharps.mouth);
    const sideCam = () => { const m = mouth(); return { pos: [m[0] - 50, m[1] + 40, m[2] - 50], look: [m[0], m[1] - 4, m[2]] }; };
    const SC = sideCam();
    const steps = [];
    steps.push({
      title: 'Sharps', dur: 7, fadeIn: 0.4, scale: '10 cm',
      enter() { K.reset('sharps'); },
      cam: [[0, SC.pos, SC.look, 40], [7, [SC.pos[0] + 10, SC.pos[1] - 6, SC.pos[2] + 10], SC.look, 36]],
      cues: toSharps.map((_, i) => [2 + i * 1.4, K.sfx.sharps]),
      frame(t) {
        const m = mouth();
        toSharps.forEach((o, i) => {
          const g = o.g || o, k = span(t, 0.6 + i * 1.4, 2 + i * 1.4);
          if (k <= 0 || k >= 1) { g.visible = k <= 0 ? false : false; return; }
          g.visible = true;
          const from = [m[0] - 10, m[1] + 22, m[2] - 8], to = [m[0], m[1] - 1, m[2]];
          const p = v3.lerp(from, to, k);
          const local = new THREE.Vector3(...p); g.parent.worldToLocal(local);
          place(g, local.toArray(), [0, 1, 0], [1, 0, 0]);         // tip down, into the slot
        });
        api.mark(sharps.g, 'yellow', t);
      },
      caption: cap([{ from: 0.6, to: 7, text: 'Needles' + (rfa ? ', the cannulae and the single-use <b>pulsed</b> probes' : '') + ' go straight into the <b>sharps container</b>, tip first, never recapped.' }]),
    });
    steps.push({
      title: 'Re-pack for sterilization', dur: 7, scale: '10 cm',
      enter() { K.reset('repack'); },
      cam: (() => { const c = wp(wrap.g); return [[0, [c[0] + 40, c[1] + 50, c[2] - 40], c, 38], [7, [c[0] + 30, c[1] + 40, c[2] - 30], c, 36]]; })(),
      cues: [1.5, 2.6, 3.7, 4.8].map((c) => [c, K.sfx.rustle]),
      frame(t) {
        for (const o of repack) {
          const g = o.g || o;
          if (g.parent !== wrap.contents) { wrap.contents.add(g); g.position.set(0, 0.5, 5); g.rotation.set(0, Math.PI / 2, 0); }
          g.visible = true;
        }
        wrap.close(span(t, 1, 6));
        api.mark(wrap.g, 'yellow', t);
      },
      caption: cap([{ from: 0.6, to: 7, text: 'Reusable instruments' + (rfa ? ' and the <b>continuous</b> RF probes' : '') + ' are wrapped and sent for <b>sterilization</b>.' }]),
    });
    steps.push({
      title: 'Clean the skin', dur: 8, scale: '10 cm',
      enter() { K.reset('clean'); room.prep.paint(1); room.drape.set(1); },
      cam: [[0, S.pos, S.look, 40], [8, [S.pos[0] - 10, S.pos[1] - 8, S.pos[2] + 4], S.look, 36]],
      cues: [[0.6, K.sfx.rustle]],
      frame(t) {
        room.drape.set(1 - span(t, 0.3, 1.8));
        const k = span(t, 2.2, 7.4, api.ease.linear), at = room.prep.clean(k);
        gauzeWipe.visible = t > 2 && t < 7.6;
        gauzeWipe.position.set(at[0], at[1] + 0.3, at[2]);
        gauzeWipe.rotation.y = t * 2;
      },
      caption: cap([{ from: 0.6, to: 8, text: 'The drape off, the <b>povidone-iodine</b> wiped from the skin: left on, it stains and can irritate.' }]),
    });
    steps.push({
      title: 'Gauze and tape', dur: 6, scale: '10 cm', fadeOut: 0.8,
      enter() { K.reset('dressing'); },
      cam: [[0, S.pos, S.look, 36], [6, [S.pos[0] - 8, S.pos[1] - 12, S.pos[2] + 6], S.look, 30]],
      cues: sites.map((_, i) => [1.4 + i * 0.8, K.sfx.snap]),
      frame(t) { sites.forEach((p, i) => { const d = K.dressing(p, span(t, 0.5 + i * 0.8, 3 + i * 0.8)); if (t > 3) api.mark(d.g, 'yellow', t); }); },
      caption: cap([{ from: 0.6, to: 6, text: '<b>Gauze and tape</b> over each puncture site.' }]),
    });
    return steps;
  };

  K.aim(region);
  K.reset('room');
  // (in development the open film's kit is window.__surgKit, to look at its images and poses)
  if (import.meta.env.DEV) window.__surgKit = K;
  return K;
}
