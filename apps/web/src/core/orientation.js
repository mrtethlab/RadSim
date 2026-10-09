/* WHERE THE PATIENT'S RIGHT IS ON THE SCREEN.

   Fluoroscopy orients its image electronically: the operator flips and turns the DISPLAY, the
   beam does not move. So the side annotation a fluoro image carries has to be worked out from the
   geometry, and it has to follow every flip — an image flipped left-for-right with its R still
   on the old side is the wrong-side error in electronic form.

   rightVec   the patient's right in the room (world), after any roll
   detU, detV the detector's column and row directions in the room: image columns run along +u,
              rows along +v, row 0 at the top (so +v is DOWN on the screen)
   flipH, flipV, rotDeg   the display transform, applied as the monitor draws it: flips first,
              then the rotation (canvas: rotate(rot) then scale(flips))

   Returns the screen direction [x right, y down] of the patient's right, unit length, or null
   when the beam runs through the patient's sides (a lateral view: right and left lie along the
   beam and neither has a side of the screen). */
export function rightOnScreen(rightVec, detU, detV, flipH, flipV, rotDeg) {
  let ax = rightVec[0] * detU[0] + rightVec[1] * detU[1] + rightVec[2] * detU[2];
  let ay = rightVec[0] * detV[0] + rightVec[1] * detV[1] + rightVec[2] * detV[2];
  const len = Math.hypot(ax, ay);
  if (len < 0.5) return null;                 // more than 60° off: call it lateral
  ax /= len; ay /= len;
  if (flipH) ax = -ax;
  if (flipV) ay = -ay;
  const t = rotDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  return [ax * c - ay * s, ax * s + ay * c];
}
