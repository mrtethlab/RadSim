/* THE SIDE MARKER, JUDGED. A radiograph without a lead side marker is not a legal image, and the
   two classic errors are the wrong letter (a right marker on the patient's left, or on a left
   lateral) and a marker collimated off the film. A third is a marker laid over the anatomy it is
   meant to label. This decides which of these an exposure made, from where the marker lay.

   side       'R' | 'L' | null (none used)
   inFrac     fraction of the marker's letter inside the collimated field (0-1)
   overTissue true when the letter lies over the patient rather than beside it
   bilateral  the subject has a midline (trunk, head, pelvis); a single limb does not, and which
              limb it is cannot be told from here, so the letter is then not judged
   rightVec   the patient's right in the room (world x, y, z), after the roll; the receptor is
              below (−y). Mostly ±x: an AP or PA, judged by which side of the midline the
              marker lies. Mostly ±y: a lateral, named for the side DOWN on the receptor.
   dx         marker x minus the patient's midline x, cm

   Returns { level: 'ok' | 'warn' | 'bad', text }. */
const MIDLINE_CM = 2;

export function expectedLateral(rightVec) {
  // the side nearest the receptor: the patient's right points down -> right lateral
  return rightVec[1] < 0 ? 'R' : 'L';
}

export function markerVerdict({ side, inFrac, overTissue, bilateral, rightVec, dx }) {
  if (!side) return { level: 'warn', text: 'No side marker on this image: every radiograph needs one.' };
  const name = side === 'R' ? 'R' : 'L';
  if (!(inFrac > 0.05)) return { level: 'bad', text: `The ${name} marker is outside the collimated field, so it is not on the image.` };
  const notes = [];
  let level = 'ok';
  if (inFrac < 0.9) { notes.push(`it is cut by the collimation (${Math.round(inFrac * 100)} % on the image)`); level = 'warn'; }
  if (overTissue) { notes.push('it lies over the anatomy: put it beside the part, not on it'); level = 'warn'; }
  const tail = notes.length ? ', but ' + notes.join('; ') + '.' : '.';
  if (!bilateral) return { level, text: `${name} marker in the field (which limb it is, is not checked)${tail}` };
  const lateral = Math.abs(rightVec[1]) > Math.abs(rightVec[0]);
  if (lateral) {
    const want = expectedLateral(rightVec);
    if (want !== side) return { level: 'bad', text: `Wrong marker: this is a ${want === 'R' ? 'right' : 'left'} lateral (${want === 'R' ? 'right' : 'left'} side to the receptor), and the marker says ${name}.` };
    return { level, text: `${name} marker on a ${want === 'R' ? 'right' : 'left'} lateral${tail}` };
  }
  if (Math.abs(dx) < MIDLINE_CM) {
    return { level: 'warn', text: `The ${name} marker sits on the midline: it should lie on the side it marks${notes.length ? '; also ' + notes.join('; ') : ''}.` };
  }
  // which side of the midline is the patient's right, in the room
  const onRight = Math.sign(dx) === Math.sign(rightVec[0]);
  const truth = onRight ? 'R' : 'L';
  if (truth !== side) return { level: 'bad', text: `Wrong side: the ${name} marker lies on the patient's ${onRight ? 'RIGHT' : 'LEFT'}.` };
  return { level, text: `${name} marker in the field, on the patient's ${onRight ? 'right' : 'left'}${tail}` };
}
