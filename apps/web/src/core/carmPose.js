/* The mobile C-arm's beam, from its joints (degrees; fluoro.js F), as the machine is built
   (carm.js): wig-wag yaws the cross-arm about the room's vertical; at the arm's end the holder
   turns about the arm's own axis (x) by flip-flop (half a turn: the tube over the table) and by
   tilt; the C slides through the holder by the orbital angle, about the holder's z. The beam
   runs up the C's y, so it is Ry(wig) Rx(over ? 180 : 0) Rx(tilt) Rz(-orbital) up. At 0/0 it
   points straight up: the tube under the patient. */
const D = Math.PI / 180;

// the beam before wig-wag and flip-flop: Rx(tilt) Rz(-orbital) up
export function beamInHolder(orbital, tilt) {
  const th = orbital * D, ti = tilt * D;
  return [Math.sin(th), Math.cos(th) * Math.cos(ti), Math.cos(th) * Math.sin(ti)];
}

// the beam in the room
export function carmBeam({ orbital = 0, tilt = 0, over = false, wig = 0 }) {
  let [x, y, z] = beamInHolder(orbital, tilt);
  if (over) { y = -y; z = -z; }                                  // Rx(180)
  const w = wig * D, c = Math.cos(w), s = Math.sin(w);
  return [x * c + z * s, y, -x * s + z * c];                     // Ry(wig)
}
