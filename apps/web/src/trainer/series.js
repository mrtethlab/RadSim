/* ============================================================================
   TRAINER SERIES — the routine views, each with what a student is marked on.

   view:
     label, proto: [part, projection] in protocols.json (technique, receptor, SID, subject)
     pose:   { roll, tol }   roll about the long axis from the subject's rest pose (degrees)
     cr:     { cc, tol, words }  central-ray angle (negative = toward +z, the head / the fingers)
     centre: { lm, name, tol (cm) }  lm names a textbook centring point in data/centring.json
             (tools/measure_centring.py), whose guide text says which source and what it says
     require: { parts (trainer/regions.js), text }  the anatomy that must be on the film
     how:    what the student is told to do
     approx: why a rigid CT model cannot fully make this view (optional)
   Rolls follow protocols.json, so the Trainer and the sandbox agree on what a view is.
   ============================================================================ */

const HAND_REQ = { parts: [{ mat: 'tissue', connect: 'hand', z: [{ lm: 'wrist', add: -3.5 }, null] }],
  text: 'all phalanges, metacarpals and carpals, with about 1" of distal radius and ulna' };
const WRIST_REQ = { parts: [{ mat: 'tissue', connect: 'wrist', z: [{ lm: 'wrist', add: -4.0 }, { lm: 'hand', add: -2.5 }] }],
  text: 'distal radius and ulna, the carpals, and the proximal half of the metacarpals' };
const ANKLE_REQ = { parts: [{ mat: 'tissue', connect: 'ankle', z: [{ lm: 'ankle', add: -4 }, { lm: 'ankle', add: 9 }] }],
  text: 'the distal tibia and fibula (about 9 cm of leg), the talus and the ankle mortise' };
const ANKLE_LAT_REQ = { parts: [{ mat: 'tissue', connect: 'ankle', z: [{ lm: 'ankle', add: -8 }, { lm: 'ankle', add: 9 }] }],
  text: 'the distal tibia and fibula, talus, calcaneus and the base of the fifth metatarsal' };
const CHEST_REQ = { parts: [{ mat: 'lung', largest: 2 }], text: 'both lungs, apices to costophrenic angles' };
const TSPINE_REQ = { parts: [{ mat: 'bone', x: [-4.5, 4.5],
  y: [{ lm: 'thoracic', axis: 'y', add: -7 }, { lm: 'thoracic', axis: 'y', add: 3 }],
  z: [{ lm: 'thoracic', add: -14.5 }, { lm: 'thoracic', add: 16.5 }] }],
  text: 'T1 to T12 (C7 and L1 at the ends), with the vertebral bodies and posterior elements' };
const LSPINE_REQ = { parts: [{ mat: 'bone', x: [-7.5, 7.5],
  y: [{ lm: 'lumbar', axis: 'y', add: -7 }, { lm: 'lumbar', axis: 'y', add: 3 }],
  z: [{ lm: 'lumbar', add: -12 }, { lm: 'lumbar', add: 9 }] }],
  text: 'T12 to the sacrum, with the sacroiliac joints and transverse processes' };
const LSPINE_LAT_REQ = { parts: [{ mat: 'bone', x: [-3, 3],
  y: [{ lm: 'lumbar', axis: 'y', add: -7 }, { lm: 'lumbar', axis: 'y', add: 3 }],
  z: [{ lm: 'lumbar', add: -12 }, { lm: 'lumbar', add: 9 }] }],
  text: 'T12 to the sacrum: bodies, intervertebral spaces and spinous processes' };

export const SERIES = [
  { id: 'hand3', name: 'Hand · 3 views', views: [
    { label: 'PA', proto: ['Upper extremity', 'PA hand'], pose: { roll: 0, tol: 5 },
      centre: { lm: 'mcp3Joint', name: '3rd MCP joint', tol: 1.0 }, require: HAND_REQ,
      how: 'Hand pronated flat on the receptor, fingers extended and slightly spread. Central ray perpendicular to the 3rd MCP joint.' },
    { label: 'PA oblique', proto: ['Upper extremity', 'Oblique hand'], pose: { roll: 45, tol: 5 },
      centre: { lm: 'mcp3Joint', name: '3rd MCP joint', tol: 1.0 }, require: HAND_REQ,
      how: 'From PA, rotate the hand 45° laterally (thumb side up), fingertips on the receptor. Central ray to the 3rd MCP joint.' },
    { label: 'Lateral', proto: ['Upper extremity', 'Lateral hand'], pose: { roll: 90, tol: 5 },
      centre: { lm: 'mcp2Joint', name: '2nd MCP joint', tol: 1.0 }, require: HAND_REQ,
      how: 'Rotate to a true lateral (ulnar side down), fingers superimposed and extended. Central ray to the 2nd MCP joint.' },
  ] },
  { id: 'wrist4', name: 'Wrist · 4 views', views: [
    { label: 'PA', proto: ['Upper extremity', 'PA wrist'], pose: { roll: 0, tol: 5 },
      centre: { lm: 'midcarpal', name: 'midcarpal area', tol: 1.0 }, require: WRIST_REQ,
      how: 'Hand pronated, fingers flexed slightly so the wrist lies flat. Central ray perpendicular to the midcarpal area.' },
    { label: 'PA oblique', proto: ['Upper extremity', 'Oblique wrist'], pose: { roll: 45, tol: 5 },
      centre: { lm: 'midcarpal', name: 'midcarpal area', tol: 1.0 }, require: WRIST_REQ,
      how: 'From PA, rotate the wrist 45° laterally. Central ray to the midcarpal area.' },
    { label: 'Lateral', proto: ['Upper extremity', 'Lateral wrist'], pose: { roll: 90, tol: 5 },
      centre: { lm: 'midcarpal', name: 'midcarpal area', tol: 1.0 }, require: WRIST_REQ,
      how: 'True lateral, ulnar side down: the radius and ulna superimpose. Central ray to the midcarpal area.' },
    { label: 'PA axial (scaphoid)', proto: ['Upper extremity', 'PA wrist'], pose: { roll: 0, tol: 5 },
      joints: { 'wrist.dev': [15, 35] },
      cr: { cc: 15, tol: 3, words: ['toward the fingers', 'toward the elbow'] },
      centre: { lm: 'scaphoid', name: 'scaphoid', tol: 1.0 }, require: WRIST_REQ,
      how: 'PA with the wrist in ulnar deviation, as far as the patient can (15-35 degrees): it brings the scaphoid out from under the radius. Central ray angled 10-15 degrees toward the elbow, centred to the scaphoid.' },
  ] },
  { id: 'ankle4', name: 'Ankle · 4 views', views: [
    { label: 'AP', proto: ['Lower extremity', 'AP ankle'], pose: { roll: 0, tol: 5 },
      centre: { lm: 'intermalleolar', name: 'point midway between the malleoli', tol: 1.0 }, require: ANKLE_REQ,
      how: 'Leg extended, foot dorsiflexed, no rotation. Central ray perpendicular, midway between the malleoli.' },
    { label: 'AP mortise', proto: ['Lower extremity', 'Mortise ankle'], pose: { roll: 15, tol: 4 },
      centre: { lm: 'intermalleolar', name: 'point midway between the malleoli', tol: 1.0 }, require: ANKLE_REQ,
      how: 'Rotate the leg and foot 15-20° medially, so the intermalleolar line is parallel to the receptor and the mortise opens.' },
    { label: 'AP oblique', proto: ['Lower extremity', 'Mortise ankle'], pose: { roll: 45, tol: 5 },
      centre: { lm: 'intermalleolar', name: 'point midway between the malleoli', tol: 1.0 }, require: ANKLE_REQ,
      how: 'Rotate the leg and foot 45° medially. Central ray midway between the malleoli.' },
    { label: 'Lateral', proto: ['Lower extremity', 'Lateral ankle'], pose: { roll: -90, tol: 5 },
      centre: { lm: 'medialMalleolus', name: 'medial malleolus', tol: 1.0 }, require: ANKLE_LAT_REQ,
      how: 'Mediolateral: lateral side of the ankle to the receptor, malleoli superimposed. Central ray to the medial malleolus.' },
  ] },
  { id: 'chest2', name: 'Chest · 2 views', views: [
    { label: 'PA', proto: ['Chest', 'PA chest'], pose: { roll: 180, tol: 4 },
      centre: { lm: 'T7', name: 'midsagittal plane at T7', tol: 2.5 }, require: CHEST_REQ,
      how: 'Erect PA: anterior chest to the receptor, shoulders rolled forward, no rotation. Central ray to the midsagittal plane at T7, 18-20 cm below the vertebra prominens.' },
    { label: 'Lateral', proto: ['Chest', 'Lateral chest'], pose: { roll: 90, tol: 4 },
      centre: { lm: 'T7mc', name: 'midcoronal plane at T7', tol: 2.5 }, require: CHEST_REQ,
      how: 'Left lateral: left side to the receptor, arms raised, no rotation. Central ray to T7 at the mid-coronal plane.' },
  ] },
  { id: 'tspine2', name: 'Thoracic spine · 2 views', views: [
    { label: 'AP', proto: ['Spine', 'AP thoracic'], pose: { roll: 0, tol: 4 },
      centre: { lm: 'T7', name: 'T7', tol: 2.0 }, require: TSPINE_REQ,
      how: 'Supine, midsagittal plane on the midline, no rotation. Central ray to T7, 8-10 cm below the jugular notch.' },
    { label: 'Lateral', proto: ['Spine', 'Lateral thoracic'], pose: { roll: 90, tol: 4 },
      centre: { lm: 'T7', name: 'T7', tol: 2.0 }, require: TSPINE_REQ,
      how: 'Lateral recumbent, arms forward, spine parallel to the table. Central ray to T7.' },
  ] },
  { id: 'lspine2', name: 'Lumbar spine · 2 views', views: [
    { label: 'AP', proto: ['Spine', 'AP lumbar'], pose: { roll: 0, tol: 4 },
      centre: { lm: 'crest', name: 'level of the iliac crest (L4-L5)', tol: 2.0 }, require: LSPINE_REQ,
      how: 'Supine, knees flexed to flatten the lumbar curve, no rotation. On a 35 x 43 cm receptor, central ray to the level of the iliac crest (L4-L5), to include the sacrum.' },
    { label: 'Lateral', proto: ['Spine', 'Lateral lumbar'], pose: { roll: 90, tol: 4 },
      centre: { lm: 'crestMc', name: 'iliac crest (L4-L5) at the midcoronal plane', tol: 2.0 }, require: LSPINE_LAT_REQ,
      how: 'Lateral recumbent, knees flexed, spine parallel to the table. Central ray to the level of the iliac crest (L4-L5), at the midcoronal plane.' },
  ] },
];
