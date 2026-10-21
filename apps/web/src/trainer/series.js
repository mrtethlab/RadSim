/* ============================================================================
   TRAINER SERIES — the routine views, each with what a student is marked on.

   view:
     label, proto: [part, projection] in protocols.json (technique, receptor, SID, subject)
     pose:   { roll, range?, tol }   roll about the long axis from the subject's rest pose (degrees):
             the ideal, or the range a textbook gives (the mortise's 15-20), with tol degrees of
             leniency either side; tilt and turn must be within tol of zero
     cr:     { cc, tol, words }  central-ray angle (negative = toward +z, the head / the fingers)
     centre: { lm, name, tol (cm) }  lm names a textbook centring point in data/centring.json
             (tools/measure_centring.py), whose guide text says which source and what it says
     require: { parts (trainer/regions.js), text }  the anatomy that must be on the film
     field:  { w, l } a textbook field size (cm at the receptor): the ideal field is never smaller
     align:  { tol } or { range }: the 3rd metacarpal against the distal radius, degrees (+ ulnar),
             measured on the bones: in line within tol for a hand or wrist, or deviated into range
     how:    what the student is told to do
     approx: why a rigid CT model cannot fully make this view (optional)
   Rolls follow protocols.json, so the Trainer and the sandbox agree on what a view is.
   ============================================================================ */

const HAND_REQ = { parts: [{ mat: 'tissue', connect: 'hand', z: [{ lm: 'wrist', add: -3.5 }, null] }],
  text: 'all phalanges, metacarpals and carpals, with about 1" of distal radius and ulna' };
// the soft tissue of the wrist, then the bases of the metacarpals as bone (Bontrager: the proximal
// metacarpals): further out, the hand's soft tissue and the abducted thumb's shaft take the
// symmetric field to 17-21 cm, where a wrist film is about 12
const WRIST_REQ = { parts: [{ mat: 'tissue', connect: 'wrist', z: [{ lm: 'wrist', add: -4.0 }, { lm: 'wrist', add: 1.0 }] },
  { mat: 'bone', z: [{ lm: 'wrist', add: 0 }, { lm: 'wrist', add: 3.5 }] }],
  text: 'distal radius and ulna and the soft tissue of the wrist, the carpals, and the bases of the metacarpals' };
// measured from the malleoli (the centring point), not the ankle landmark 2.4 cm above them: an
// AP ankle is about 22 cm long, the distal third of the leg to just below the talus
const ANKLE_REQ = { parts: [{ mat: 'tissue', connect: 'ankle', z: [{ lm: 'intermalleolar', add: -4 }, { lm: 'intermalleolar', add: 8 }] }],
  text: 'the distal tibia and fibula (about 8 cm of leg), the mortise and the talus' };
const ANKLE_LAT_REQ = { parts: [{ mat: 'tissue', connect: 'ankle', z: [{ lm: 'intermalleolar', add: -7 }, { lm: 'intermalleolar', add: 8 }] }],
  text: 'the distal tibia and fibula, talus, calcaneus and the base of the fifth metatarsal' };
const CHEST_REQ = { parts: [{ mat: 'lung', largest: 2 }], text: 'both lungs, apices to costophrenic angles' };
/* The spines are bone only: the film is of the column, and the field is the column plus the inch.
   An AP takes the bodies, pedicles and transverse processes (a long narrow field, 12-15 cm on
   the thoracic spine, about 20 on the lumbar with its sacroiliac joints). A lateral takes the
   column from the front of the bodies to the tips of the spinous processes and no more: none
   of the abdomen or chest in front of it, which only adds scatter. Depths hang off the column
   points tools/measure_centring.py measures (crestCol, T7col: the middle of the column's depth). */
const TSPINE_REQ = { parts: [{ mat: 'bone', x: [-3.5, 3.5],
  y: [{ lm: 'thoracic', axis: 'y', add: -7 }, { lm: 'thoracic', axis: 'y', add: 3 }],
  z: [{ lm: 'thoracic', add: -14.5 }, { lm: 'thoracic', add: 16.5 }] }],
  text: 'T1 to T12 (C7 and L1 at the ends): bodies, pedicles and the transverse processes' };
// T3 to T12: on a lateral the shoulders hide T1-T3 (they take a swimmer's view)
const TSPINE_LAT_REQ = { parts: [{ mat: 'bone', x: [-3, 3],
  y: [{ lm: 'T7col', axis: 'y', add: -5.1 }, { lm: 'T7col', axis: 'y', add: 5.1 }],
  z: [{ lm: 'T7col', add: -13 }, { lm: 'T7col', add: 9.5 }] }],
  text: 'T3 to T12, from the front of the bodies to the spinous processes (T1-T3 hide behind the shoulders: a swimmer view takes them)' };
const LSPINE_REQ = { parts: [{ mat: 'bone', x: [-7.5, 7.5],
  y: [{ lm: 'lumbar', axis: 'y', add: -7 }, { lm: 'lumbar', axis: 'y', add: 3 }],
  z: [{ lm: 'lumbar', add: -12 }, { lm: 'lumbar', add: 9 }] }],
  text: 'T12 to the sacrum, with the sacroiliac joints and transverse processes' };
const LSPINE_LAT_REQ = { parts: [{ mat: 'bone', x: [-3, 3],
  y: [{ lm: 'crestCol', axis: 'y', add: -5.3 }, { lm: 'crestCol', axis: 'y', add: 5.3 }],
  z: [{ lm: 'crestCol', add: -8 }, { lm: 'crestCol', add: 13 }] }],
  text: 'L1 to the upper sacrum, from the front of the bodies to the spinous processes: the bodies, disc spaces, foramina and L5-S1' };

// the foot, measured from the malleoli (it points down, plantarflexed, so "below the ankle" in z is
// the foot): the AP and oblique take the toes back to the talus, the lateral the whole foot with
// the heel and 2.5 cm of the leg
const FOOT_REQ = { parts: [{ mat: 'tissue', connect: 'ankle', z: [null, { lm: 'intermalleolar', add: -1 }] }],
  text: 'the toes, metatarsals and tarsals, to the talus' };
const FOOT_LAT_REQ = { parts: [{ mat: 'tissue', connect: 'ankle', z: [null, { lm: 'intermalleolar', add: 2.5 }] }],
  text: 'the whole foot, heel to toes, with about 2.5 cm of the distal tibia and fibula' };
// the elbow: the distal humerus and the proximal forearm, 7 cm either side of the joint
const ELBOW_REQ = { parts: [{ mat: 'tissue', connect: 'elbow', z: [{ lm: 'elbowJoint', add: -7 }, { lm: 'elbowJoint', add: 7 }] }],
  text: 'the distal humerus, the elbow joint and the proximal radius and ulna, with their soft tissue' };
/* The cervical spine is bone only, hung off the vertebral bodies the CT's own labels place (C4,
   C1-C2, C7-T1). Every window is wide enough for the transverse processes on the AP and the
   spinous processes on the lateral, and keeps the mandible and the skull out. */
const CS_AP_REQ = { parts: [{ mat: 'bone', x: [-3.5, 3.5], y: [{ lm: 'C4', axis: 'y', add: -6 }, { lm: 'C4', axis: 'y', add: 1.5 }],
  z: [{ lm: 'C7T1', add: -4 }, { lm: 'C4', add: 2 }] }], text: 'C3 to T2: the bodies, the intervertebral spaces and the uncovertebral joints' };
const CS_OM_REQ = { parts: [{ mat: 'bone', x: [-4, 4], y: [{ lm: 'C1C2', axis: 'y', add: -2.5 }, { lm: 'C1C2', axis: 'y', add: 1.5 }],
  z: [{ lm: 'C1C2', add: -2.5 }, { lm: 'C1C2', add: 1.5 }] }], text: 'C1 and C2: the dens, the lateral masses of the atlas and the atlantoaxial joints' };
const CS_LAT_REQ = { parts: [{ mat: 'bone', x: [-2.5, 2.5], y: [{ lm: 'C4', axis: 'y', add: -7 }, { lm: 'C4', axis: 'y', add: 2 }],
  z: [{ lm: 'C7T1', add: -1.5 }, { lm: 'C1C2', add: 2.5 }] }], text: 'C1 to T1: the bodies, disc spaces, articular pillars and spinous processes' };
const CS_OBL_REQ = { parts: [{ mat: 'bone', x: [-3.5, 3.5], y: [{ lm: 'C4', axis: 'y', add: -5 }, { lm: 'C4', axis: 'y', add: 2 }],
  z: [{ lm: 'C7T1', add: -1.5 }, { lm: 'C1C2', add: 2.5 }] }], text: 'C1 to T1, with the intervertebral foramina open' };
const CS_SW_REQ = { parts: [{ mat: 'bone', x: [-3, 3], y: [{ lm: 'C7T1', axis: 'y', add: -6 }, { lm: 'C7T1', axis: 'y', add: 2 }],
  z: [{ lm: 'C7T1', add: -6 }, { lm: 'C7T1', add: 4 }] }], text: 'C5 to T3: the cervicothoracic junction' };

export const SERIES = [
  { id: 'hand3', name: 'Hand · 3 views', views: [
    { label: 'PA', proto: ['Upper extremity', 'PA hand'], pose: { roll: 0, tol: 2 },
      align: { tol: 6 },
      centre: { lm: 'mcp3Joint', name: '3rd MCP joint', tol: 1.0 }, require: HAND_REQ,
      how: 'Hand pronated flat on the receptor, fingers extended and slightly spread. Central ray perpendicular to the 3rd MCP joint. Forearm along the long axis of the receptor.' },
    { label: 'PA oblique', proto: ['Upper extremity', 'Oblique hand'], pose: { roll: 45, tol: 2 },
      align: { tol: 6 },
      centre: { lm: 'mcp3Joint', name: '3rd MCP joint', tol: 1.0 }, require: HAND_REQ,
      how: 'From PA, rotate the hand 45° laterally (thumb side up), fingertips on the receptor. Central ray to the 3rd MCP joint. Forearm along the long axis of the receptor.' },
    { label: 'Lateral', proto: ['Upper extremity', 'Lateral hand'], pose: { roll: 90, tol: 2 },
      align: { tol: 6 },
      centre: { lm: 'mcp2Joint', name: '2nd MCP joint', tol: 1.0 }, require: HAND_REQ,
      how: 'Rotate to a true lateral (ulnar side down), fingers superimposed and extended. Central ray to the 2nd MCP joint. Forearm along the long axis of the receptor.' },
  ] },
  { id: 'wrist4', name: 'Wrist · 4 views', views: [
    { label: 'PA', proto: ['Upper extremity', 'PA wrist'], pose: { roll: 0, tol: 2 },
      align: { tol: 6 },
      centre: { lm: 'midcarpal', name: 'midcarpal area', tol: 1.0 }, require: WRIST_REQ,
      how: 'Hand pronated, fingers flexed slightly so the wrist lies flat. Central ray perpendicular to the midcarpal area. Forearm along the long axis of the receptor.' },
    { label: 'PA oblique', proto: ['Upper extremity', 'Oblique wrist'], pose: { roll: 45, tol: 2 },
      align: { tol: 6 },
      centre: { lm: 'midcarpal', name: 'midcarpal area', tol: 1.0 }, require: WRIST_REQ,
      how: 'From PA, rotate the wrist 45° laterally. Central ray to the midcarpal area. Forearm along the long axis of the receptor.' },
    { label: 'Lateral', proto: ['Upper extremity', 'Lateral wrist'], pose: { roll: 90, tol: 2 },
      align: { tol: 6 },
      centre: { lm: 'midcarpal', name: 'midcarpal area', tol: 1.0 }, require: WRIST_REQ,
      how: 'True lateral, ulnar side down: the radius and ulna superimpose. Central ray to the midcarpal area. Forearm along the long axis of the receptor.' },
    { label: 'PA axial (scaphoid)', proto: ['Upper extremity', 'PA wrist'], pose: { roll: 0, tol: 2 },
      align: { range: [15, 35] },
      cr: { cc: 15, tol: 3, words: ['toward the fingers', 'toward the elbow'] },
      centre: { lm: 'scaphoid', name: 'scaphoid', tol: 1.0 }, require: WRIST_REQ,
      how: 'PA with the wrist in ulnar deviation, as far as the patient can (15-35 degrees): it brings the scaphoid out from under the radius. Central ray angled 10-15 degrees toward the elbow, centred to the scaphoid. Forearm along the long axis of the receptor.' },
  ] },
  { id: 'ankle4', name: 'Ankle · 4 views', views: [
    { label: 'AP', proto: ['Lower extremity', 'AP ankle'], pose: { roll: 0, tol: 2 },
      centre: { lm: 'intermalleolar', name: 'point midway between the malleoli', tol: 1.0 }, require: ANKLE_REQ,
      how: 'Leg extended, foot dorsiflexed, no rotation. Central ray perpendicular, midway between the malleoli.' },
    { label: 'AP mortise', proto: ['Lower extremity', 'Mortise ankle'], pose: { roll: 15, range: [15, 20], tol: 2 },
      centre: { lm: 'intermalleolar', name: 'point midway between the malleoli', tol: 1.0 }, require: ANKLE_REQ,
      how: 'Rotate the leg and foot 15-20° medially, so the intermalleolar line is parallel to the receptor and the mortise opens.' },
    { label: 'AP oblique', proto: ['Lower extremity', 'Mortise ankle'], pose: { roll: 45, tol: 2 },
      centre: { lm: 'intermalleolar', name: 'point midway between the malleoli', tol: 1.0 }, require: ANKLE_REQ,
      how: 'Rotate the leg and foot 45° medially. Central ray midway between the malleoli.' },
    { label: 'Lateral', proto: ['Lower extremity', 'Lateral ankle'], pose: { roll: -90, tol: 2 },
      centre: { lm: 'medialMalleolus', name: 'medial malleolus', tol: 1.0 }, require: ANKLE_LAT_REQ,
      how: 'Mediolateral: lateral side of the ankle to the receptor, malleoli superimposed. Central ray to the medial malleolus.' },
  ] },
  { id: 'foot3', name: 'Foot · 3 views', views: [
    { label: 'AP (dorsoplantar)', proto: ['Lower extremity', 'AP foot'], pose: { roll: 0, tol: 2 },
      joints: { 'ankle.flex': [-80, -60] }, sole: { tol: 5 },
      cr: { cc: -10, tol: 3, words: ['toward the heel', 'toward the toes'] },
      centre: { lm: 'mt3Base', name: 'base of the 3rd metatarsal', tol: 1.0 }, require: FOOT_REQ,
      how: 'Knee flexed, sole flat on the receptor. Central ray 10 degrees toward the heel (perpendicular to the metatarsals), to the base of the 3rd metatarsal. This leg is straight and its foot rests plantarflexed: tilt the leg until the sole lies flat.' },
    { label: 'AP oblique (medial)', proto: ['Lower extremity', 'Oblique foot'], pose: { roll: 30, tol: 2 },
      joints: { 'ankle.flex': [-80, -60] }, sole: { tol: 5 },
      centre: { lm: 'mt3Base', name: 'base of the 3rd metatarsal', tol: 1.0 }, require: FOOT_REQ,
      how: 'From the AP, rotate the leg and foot 30 degrees medially, sole flat. Central ray perpendicular to the base of the 3rd metatarsal.' },
    { label: 'Lateral (mediolateral)', proto: ['Lower extremity', 'Lateral foot'], pose: { roll: -90, tol: 2 },
      joints: { 'ankle.flex': [-10, 10] },
      centre: { lm: 'mt3Base', name: 'medial cuneiform, at the level of the base of the 3rd metatarsal', tol: 1.0 }, require: FOOT_LAT_REQ,
      how: 'Lateral side down, foot dorsiflexed to 90 degrees to the leg, plantar surface perpendicular to the receptor. Central ray to the medial cuneiform, at the level of the base of the 3rd metatarsal.' },
  ] },
  { id: 'elbow4', name: 'Elbow · 4 views', views: [
    { label: 'AP', proto: ['Upper extremity', 'AP elbow'], pose: { roll: -9, tol: 2 },
      centre: { lm: 'elbowJoint', name: 'mid elbow joint', tol: 1.0 }, require: ELBOW_REQ,
      how: 'Elbow fully extended, hand supinated, epicondyles parallel to the receptor. Central ray perpendicular to the mid elbow joint.' },
    { label: 'AP oblique (medial)', proto: ['Upper extremity', 'AP elbow'], pose: { roll: 36, tol: 2 },
      centre: { lm: 'elbowJoint', name: 'mid elbow joint', tol: 1.0 }, require: ELBOW_REQ,
      how: 'From the AP, rotate the arm 45 degrees medially (pronate the hand): the coronoid process in profile. Central ray to the mid elbow joint.' },
    { label: 'AP oblique (lateral)', proto: ['Upper extremity', 'AP elbow'], pose: { roll: -54, tol: 2 },
      centre: { lm: 'elbowJoint', name: 'mid elbow joint', tol: 1.0 }, require: ELBOW_REQ,
      how: 'From the AP, rotate the arm 45 degrees laterally: the radial head and neck free of the ulna. Central ray to the mid elbow joint.' },
    { label: 'Lateral', proto: ['Upper extremity', 'Lateral elbow'], pose: { roll: 81, tol: 2 },
      joints: { 'elbow.flex': [85, 95] },
      centre: { lm: 'elbowJoint', name: 'mid elbow joint', tol: 1.0 }, require: ELBOW_REQ,
      how: 'Elbow flexed 90 degrees, humerus and forearm on the receptor, epicondyles perpendicular to it (lateral epicondyle up), hand lateral. Central ray to the mid elbow joint.' },
  ] },
  { id: 'chest2', name: 'Chest · 2 views', views: [
    { label: 'PA', proto: ['Chest', 'PA chest'], pose: { roll: 180, tol: 2 },
      centre: { lm: 'T7', name: 'midsagittal plane at T7', tol: 2.5 }, require: CHEST_REQ,
      how: 'Erect PA: anterior chest to the receptor, shoulders rolled forward, no rotation. Central ray to the midsagittal plane at T7, 18-20 cm below the vertebra prominens.' },
    { label: 'Lateral', proto: ['Chest', 'Lateral chest'], pose: { roll: 90, tol: 2 },
      centre: { lm: 'T7mc', name: 'midcoronal plane at T7', tol: 2.5 }, require: CHEST_REQ,
      how: 'Left lateral: left side to the receptor, arms raised, no rotation. Central ray to T7 at the mid-coronal plane.' },
  ] },
  { id: 'cspine6', name: 'Cervical spine · 6 views', views: [
    { label: 'AP axial', proto: ['Spine', 'AP cervical'], pose: { roll: 0, tol: 2 },
      cr: { cc: -15, tol: 3, words: ['cephalad', 'caudad'] },
      centre: { lm: 'C4', name: 'C4 (the lower margin of the thyroid cartilage)', tol: 1.5 }, require: CS_AP_REQ,
      how: 'Supine, no rotation, chin raised so the occlusal plane and the mastoid tips line up. Central ray 15-20 degrees cephalad, to C4.' },
    { label: 'AP open mouth (C1-C2)', proto: ['Spine', 'AP open mouth'], pose: { roll: 0, tol: 2 },
      centre: { lm: 'C1C2', name: 'C1-C2, through the open mouth', tol: 1.5 }, require: CS_OM_REQ,
      approx: 'This model cannot open its mouth: the lower teeth and the mandible lie over the dens.',
      how: 'Supine, mouth open as wide as possible, the line from the upper incisors to the mastoid tips perpendicular to the receptor. Central ray perpendicular through the centre of the open mouth, to C1-C2.' },
    { label: 'Lateral', proto: ['Spine', 'Lateral cervical'], pose: { roll: 90, tol: 2 },
      centre: { lm: 'C4', name: 'C4', tol: 1.5 }, require: CS_LAT_REQ,
      how: 'True lateral at 150-180 cm, shoulders depressed, chin slightly raised. Central ray horizontal to C4.' },
    { label: 'Right posterior oblique', proto: ['Spine', 'Oblique cervical'], pose: { roll: -45, tol: 2 },
      cr: { cc: -15, tol: 3, words: ['cephalad', 'caudad'] },
      centre: { lm: 'C4', name: 'C4', tol: 1.5 }, require: CS_OBL_REQ,
      how: 'Rotate the body 45 degrees, right side down (RPO): the left intervertebral foramina open. Central ray 15-20 degrees cephalad, to C4.' },
    { label: 'Left posterior oblique', proto: ['Spine', 'Oblique cervical'], pose: { roll: 45, tol: 2 },
      cr: { cc: -15, tol: 3, words: ['cephalad', 'caudad'] },
      centre: { lm: 'C4', name: 'C4', tol: 1.5 }, require: CS_OBL_REQ,
      how: 'Rotate the body 45 degrees, left side down (LPO): the right intervertebral foramina open. Central ray 15-20 degrees cephalad, to C4.' },
    { label: 'Swimmers lateral', proto: ['Spine', 'Swimmers lateral'], pose: { roll: 90, tol: 2 },
      centre: { lm: 'C7T1', name: 'C7-T1', tol: 1.5 }, require: CS_SW_REQ,
      approx: 'This patient lies with both arms at the sides; the arm nearer the receptor cannot be raised.',
      how: 'Lateral with the arm nearer the receptor raised over the head and the other shoulder depressed. Central ray to C7-T1, about 2.5 cm above the jugular notch.' },
  ] },
  { id: 'tspine2', name: 'Thoracic spine · 2 views', views: [
    { label: 'AP', proto: ['Spine', 'AP thoracic'], pose: { roll: 0, tol: 2 },
      centre: { lm: 'T7', name: 'T7', tol: 2.0 }, require: TSPINE_REQ,
      how: 'Supine, midsagittal plane on the midline, no rotation. Central ray to T7, 8-10 cm below the jugular notch.' },
    { label: 'Lateral', proto: ['Spine', 'Lateral thoracic'], pose: { roll: 90, tol: 2 },
      centre: { lm: 'T7col', name: 'T7, on the vertebral column', tol: 2.0 }, require: TSPINE_LAT_REQ,
      how: 'Lateral recumbent, arms forward at right angles, spine parallel to the table. Central ray to T7, centred on the column (the posterior half of the thorax); collimate long and narrow to it.' },
  ] },
  { id: 'lspine2', name: 'Lumbar spine · 2 views', views: [
    { label: 'AP', proto: ['Spine', 'AP lumbar'], pose: { roll: 0, tol: 2 },
      centre: { lm: 'crest', name: 'level of the iliac crest (L4-L5)', tol: 2.0 }, require: LSPINE_REQ,
      how: 'Supine, knees flexed to flatten the lumbar curve, no rotation. On a 35 x 43 cm receptor, central ray to the level of the iliac crest (L4-L5), to include the sacrum.' },
    { label: 'Lateral', proto: ['Spine', 'Lateral lumbar'], pose: { roll: 90, tol: 2 },
      centre: { lm: 'crestCol', name: 'iliac crest (L4-L5), on the vertebral column', tol: 2.0 }, require: LSPINE_LAT_REQ,
      field: { w: 20 },
      how: 'Lateral recumbent, knees flexed, spine parallel to the table. Central ray to the level of the iliac crest (L4-L5), centred on the column (the midcoronal plane); collimate to about 20 cm wide, 1" in front of the bodies and behind the spinous processes.' },
  ] },
];
