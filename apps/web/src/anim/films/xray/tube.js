/* THE X-RAY TUBE, inside: what the room's tube head (room.js buildTubeHead) holds. Frame: the focal
   spot at the origin, the beam out of the port down -y, the anode-cathode axis along x (cathode +x,
   anode -x), as the room's tube head has it. Units cm, to scale: a 10 cm anode disc, a 26 cm insert. */
import * as THREE from 'three';
import { std, mesh, glowMat } from '../../kit/stage.js';

export const ANODE_Y = 4.4;          // the anode's axis above the focal spot (the track's radius)
export const ANODE_ANGLE = 12;       // degrees: the target's bevel

export function buildTubeInsert() {
  const g = new THREE.Group();
  const M = {
    glass: new THREE.MeshPhysicalMaterial({ color: 0xbfe3ff, roughness: 0.05, metalness: 0, transparent: true,
      opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, clearcoat: 1 }),
    moly: std(0x8d949c, 0.35, 0.8),
    tungsten: std(0x5d6168, 0.3, 0.9),
    copper: std(0xb8683a, 0.35, 0.85),
    nickel: std(0xb7bcc2, 0.28, 0.85),
    ceramic: std(0xe9e3d6, 0.6, 0.0),
    lead: std(0x59606b, 0.6, 0.4),
    shell: std(0xe4e7e9, 0.45, 0.05, { side: THREE.DoubleSide }),
    oil: new THREE.MeshStandardMaterial({ color: 0xd8b860, transparent: true, opacity: 0.1, depthWrite: false, roughness: 0.2 }),
    al: std(0xc9ced4, 0.3, 0.7),
    dark: std(0x2a2f36, 0.6, 0.2),
  };

  // ---- the glass envelope: a bulb round the anode, a neck to the cathode (a lathe about x)
  // (coaxial with the anode: the cathode sits off the axis, aimed at the track near the rim)
  const prof = [[-16, 0.1], [-16, 2.9], [-14, 3.1], [-8.6, 3.1], [-7.8, 6.9], [-4, 7.4], [1.5, 7.3], [4, 6.4], [11, 6.2], [12.6, 4.5], [13.2, 0.1]];
  const env = new THREE.Mesh(new THREE.LatheGeometry(prof.map(([x, r]) => new THREE.Vector2(r, x)), 72), M.glass);
  env.rotation.z = -Math.PI / 2; env.position.y = ANODE_Y;
  g.add(env);

  // ---- the anode: a disc whose rim is bevelled to face the cathode, on a stem, on the rotor
  // placed so the bevel crosses the beam axis at the origin: the focal spot
  const anode = new THREE.Group(); anode.position.set(-(5.0 - ANODE_Y) * Math.tan(ANODE_ANGLE * Math.PI / 180), ANODE_Y, 0); g.add(anode);
  const spin = new THREE.Group(); anode.add(spin);                  // turns about x
  const bev = Math.tan(ANODE_ANGLE * Math.PI / 180);
  // disc profile in (r, x): a cone face toward +x (the bevel), flat back
  const R = 5.0, T = 0.9;
  const dprof = [[0, -T], [R, -T], [R, 0], [R - 0.9, 0.9 * bev * 1.0 + 0.0], [1.1, (R - 1.1) * bev], [0.6, (R - 1.1) * bev + 0.3], [0.6, 1.2], [0, 1.2]];
  const disc = new THREE.Mesh(new THREE.LatheGeometry(dprof.map(([r, x]) => new THREE.Vector2(r, x)), 96), M.moly);
  disc.rotation.z = -Math.PI / 2; spin.add(disc);
  // the tungsten-rhenium focal track: a band on the bevel near the rim
  const tprof = [[R - 0.05, 0.02], [R - 0.95, 0.9 * bev + 0.02]];
  const track = new THREE.Mesh(new THREE.LatheGeometry(tprof.map(([r, x]) => new THREE.Vector2(r, x)), 128), M.tungsten);
  track.rotation.z = -Math.PI / 2; spin.add(track);
  // spokes of shade on the track so the spin can be seen
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const s = mesh(new THREE.BoxGeometry(0.06, 0.8, 0.12), M.dark, 0.25, Math.cos(a) * (R - 0.5), Math.sin(a) * (R - 0.5));
    s.rotation.x = -a; spin.add(s);
  }
  // the hot spot on the track (where the electrons land) and the heat carried round by the spin
  const heatMat = glowMat(0xff5a1a);
  heatMat.transparent = true; heatMat.depthWrite = false; heatMat.opacity = 0;   // cold until the Heat step
  const heatRing = new THREE.Mesh(new THREE.TorusGeometry(ANODE_Y, 0.3, 8, 128), heatMat);
  heatRing.rotation.y = Math.PI / 2; heatRing.position.x = (R - ANODE_Y) * bev + 0.05; spin.add(heatRing);
  const spotMat = new THREE.MeshBasicMaterial({ color: 0xfff1b0, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const spot = mesh(new THREE.SphereGeometry(0.45, 16, 12), spotMat, (R - ANODE_Y) * bev + 0.05, -ANODE_Y, 0);
  spot.scale.set(0.35, 0.9, 0.55);           // a line up the bevel: the actual focal spot
  anode.add(spot);                                                  // fixed: the spot stays as the disc turns
  // stem and rotor
  const stem = mesh(new THREE.CylinderGeometry(0.55, 0.55, 6, 24).rotateZ(Math.PI / 2), M.moly, -3.5, 0, 0);
  spin.add(stem);
  const rotor = mesh(new THREE.CylinderGeometry(2.2, 2.2, 7, 48).rotateZ(Math.PI / 2), M.copper, -10, 0, 0);
  spin.add(rotor);
  for (let i = 0; i < 16; i++) {                                    // the rotor's bars
    const a = (i / 16) * Math.PI * 2;
    const bar = mesh(new THREE.BoxGeometry(6.6, 0.18, 0.3), M.dark, -10, Math.cos(a) * 2.21, Math.sin(a) * 2.21);
    bar.rotation.x = -a; spin.add(bar);
  }
  anode.add(mesh(new THREE.CylinderGeometry(0.9, 1.1, 3, 24).rotateZ(Math.PI / 2), M.nickel, -15, 0, 0));   // the bearing housing
  // the stator: coils outside the glass round the rotor
  const statorMat = glowMat(0x46d17f); statorMat.color.set(0xb8683a); statorMat.metalness = 0.7; statorMat.roughness = 0.35;
  const stator = new THREE.Group(); stator.position.set(-11, ANODE_Y, 0); g.add(stator);
  stator.add(mesh(new THREE.CylinderGeometry(4.6, 4.6, 6, 48, 1, true, Math.PI / 2, Math.PI).rotateZ(Math.PI / 2), M.dark));   // (the far half: the rotor shows)
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const coil = mesh(new THREE.TorusGeometry(1.2, 0.45, 10, 24), statorMat, 0, Math.cos(a) * 4.1, Math.sin(a) * 4.1);
    coil.lookAt(0, 0, 0); stator.add(coil);
  }

  // ---- the cathode: a support arm, the focusing cup and, in its slot, the coiled filament
  const cathode = new THREE.Group(); cathode.position.set(4.4, 0, 0); g.add(cathode);
  cathode.add(mesh(new THREE.CylinderGeometry(0.5, 0.5, 8, 16).rotateZ(Math.PI / 2), M.nickel, 4.5, 0.6, 0));
  cathode.add(mesh(new THREE.CylinderGeometry(1.1, 1.3, 1.6, 24).rotateZ(Math.PI / 2), M.ceramic, 8.8, 0.6, 0));
  const cup = new THREE.Group(); cathode.add(cup);
  // a cup: a block with a slot cut across its face toward the anode (made of four pieces)
  cup.add(mesh(new THREE.BoxGeometry(1.4, 2.0, 0.55), M.nickel, 0.3, 0, 0.75));
  cup.add(mesh(new THREE.BoxGeometry(1.4, 2.0, 0.55), M.nickel, 0.3, 0, -0.75));
  cup.add(mesh(new THREE.BoxGeometry(1.4, 0.6, 0.95), M.nickel, 0.3, 0.7, 0));
  cup.add(mesh(new THREE.BoxGeometry(1.4, 0.6, 0.95), M.nickel, 0.3, -0.7, 0));
  cup.add(mesh(new THREE.BoxGeometry(0.5, 0.8, 0.95), M.nickel, 0.75, 0, 0));
  // the filament: a tungsten helix across the slot
  const helix = [];
  for (let i = 0; i <= 400; i++) {
    const u = i / 400, a = u * Math.PI * 2 * 14;
    helix.push(new THREE.Vector3(0.12 + 0.07 * Math.cos(a), 0.07 * Math.sin(a), -0.42 + 0.84 * u));
  }
  const filMat = glowMat(0xffa040);
  filMat.color.set(0x8a8f96); filMat.metalness = 0.7;
  const filament = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(helix), 800, 0.016, 6), filMat);
  cup.add(filament);
  // its leads back to the arm
  for (const z of [-0.42, 0.42]) cup.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.2, 6).rotateZ(Math.PI / 2), M.nickel, 0.7, 0, z));

  // ---- the housing, cut open on the viewer's side: steel shell, lead lining, oil between
  const housing = new THREE.Group(); g.add(housing);
  housing.position.y = ANODE_Y;
  const hlen = 34, hr = 8.6;
  // the far half (z < 0): the near side is cut away toward the viewer
  const half = (r, mat) => mesh(new THREE.CylinderGeometry(r, r, hlen, 64, 1, true, Math.PI / 2, Math.PI).rotateZ(Math.PI / 2), mat);
  housing.add(half(hr, M.shell));
  housing.add(half(hr - 0.35, M.lead));
  const oil = mesh(new THREE.CylinderGeometry(hr - 0.4, hr - 0.4, hlen, 48, 1, false).rotateZ(Math.PI / 2), M.oil);
  housing.add(oil);
  for (const sx of [-1, 1]) {
    const cap = mesh(new THREE.CircleGeometry(hr, 48), M.shell, sx * hlen / 2, 0, 0);
    cap.rotation.y = sx * Math.PI / 2; housing.add(cap);
  }
  // the port: a window in the lead under the focal spot
  const port = mesh(new THREE.CylinderGeometry(2.4, 2.4, 0.8, 32), new THREE.MeshStandardMaterial({ color: 0x9fb7c8, transparent: true, opacity: 0.35, roughness: 0.1 }), 0, ANODE_Y - hr + 0.4, 0);
  g.add(port);

  // ---- under the port: the added aluminium filter, then the collimator's blades, mirror, lamp
  const below = ANODE_Y - hr;                    // the housing's underside (y)
  const filter = mesh(new THREE.BoxGeometry(6.5, 0.45, 6.5), std(0xdfe5ea, 0.25, 0.75, { emissive: 0x2a3036 }), 0, below - 0.9, 0);   // (drawn a little thick: 2.5 mm reads as a sheet)
  g.add(filter);
  const coll = new THREE.Group(); coll.position.y = below - 2; g.add(coll);
  const collBox = mesh(new THREE.BoxGeometry(22, 12, 20, 1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xe4e7e9, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }), 0, -6, 0);
  coll.add(collBox);
  const blades = {};
  // upper pair (x) and lower pair (z) of lead shutters
  for (const [k, axis, y] of [['xa', 'x', -2.2], ['xb', 'x', -2.2], ['za', 'z', -9.5], ['zb', 'z', -9.5]]) {
    const b = mesh(new THREE.BoxGeometry(axis === 'x' ? 8 : 16, 1.0, axis === 'x' ? 16 : 8), M.lead, 0, y, 0);
    coll.add(b); blades[k] = b;
  }
  const mirror = mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshStandardMaterial({ color: 0xdfe8f0, metalness: 0.9, roughness: 0.05, transparent: true, opacity: 0.45, side: THREE.DoubleSide }), 0, -5.8, 0);
  mirror.rotation.x = Math.PI / 4; coll.add(mirror);
  const lampMat = glowMat(0xfff4c8);
  const lamp = mesh(new THREE.SphereGeometry(0.7, 16, 12), lampMat, 0, -5.8, -8.5); coll.add(lamp);
  // set the field: half-widths (cm, at the blades) of the x and z openings
  const setField = (hx, hz) => {
    blades.xa.position.x = -(hx + 4); blades.xb.position.x = hx + 4;
    blades.za.position.z = -(hz + 4); blades.zb.position.z = hz + 4;
  };
  setField(3, 3);

  return {
    g, M, envelope: env, anode, spin, disc, track, heatRing, heatMat, spot, spotMat, rotor, stator, statorMat,
    cathode, cup, filament, filMat, housing, port, filter, coll, collBox, blades, mirror, lamp, lampMat, setField,
    // where things are, in the tube's frame (cm)
    at: {
      focal: [0, 0, 0],
      filament: [4.4 + 0.12, 0, 0],
      portY: below + 0.4,
      filterY: below - 0.9,
      collY: below - 2,
      bladesY: [below - 2 - 2.2, below - 2 - 9.5],
    },
  };
}
