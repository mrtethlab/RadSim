/* ============================================================================
   HOSPITAL PROTOCOLS — which views a department does for which reason for exam.

   The Protocol Trainer's answer key. Each line is one routine as a department writes it
   ("Wrist (Scaphoid Routine): Trauma Wrist Routine + Scaphoid shot"); its views are projection
   names in data/protocols.json (unique across the chart), so the films are made by the same
   protocols the x-ray room runs.

   line:
     id         stable key (cases.js refers to it)
     exam       the body part as the requisition names it
     indication the reason-for-exam column
     views      projection names, in the department's own listed order
     side       'limb': the requisition gives a side and the films are of that limb;
                'trunk': a side matters only for where the field goes (a hip, ribs, a clavicle);
                absent: midline
     peds       a paediatric routine (ages in years: [min, max])
     either     alternative views that satisfy one slot ({ slot: 'SI or IS axial', of: [...] })
     combine    ids of lines this one merges with on one requisition, sharing views
   ============================================================================ */

export const HOSPITAL = [
  // ---- hand
  { id: 'hand-routine', exam: 'Hand', indication: 'Routine / Trauma', side: 'limb',
    views: ['PA hand', 'Oblique hand', 'Fan lateral hand'] },
  { id: 'hand-ra', exam: 'Hand', indication: 'Rheumatoid arthritis', side: 'limb',
    views: ['PA hand', 'Fan lateral hand', 'Ballcatcher hands (Norgaard)'] },
  { id: 'hand-recheck', exam: 'Hand', indication: 'Recheck / Post-reduction', side: 'limb',
    views: ['PA hand', 'Lateral hand'] },
  // ---- wrist
  { id: 'wrist-trauma', exam: 'Wrist', indication: 'Trauma / Pathology', side: 'limb',
    views: ['PA wrist', 'Oblique wrist', 'Lateral wrist', 'External oblique wrist'] },
  { id: 'wrist-recheck', exam: 'Wrist', indication: 'Recheck / Follow-up', side: 'limb',
    views: ['PA wrist', 'Lateral wrist'] },
  { id: 'wrist-scaphoid', exam: 'Wrist', indication: 'Scaphoid routine', side: 'limb',
    views: ['PA wrist', 'Oblique wrist', 'Lateral wrist', 'External oblique wrist', 'Scaphoid view wrist'] },
  { id: 'wrist-scaphoid-fu', exam: 'Wrist', indication: 'Scaphoid follow-up', side: 'limb',
    views: ['PA wrist', 'Lateral wrist', 'Scaphoid view wrist'] },
  // ---- forearm, elbow, humerus
  { id: 'forearm-routine', exam: 'Forearm', indication: 'Routine', side: 'limb',
    views: ['AP forearm', 'Lateral forearm'] },
  { id: 'elbow-routine', exam: 'Elbow', indication: 'Routine / Trauma / Pathology', side: 'limb',
    views: ['AP elbow', 'Internal oblique elbow', 'External oblique elbow', 'Lateral elbow'] },
  { id: 'elbow-radialhead', exam: 'Elbow', indication: '? Radial head', side: 'limb',
    views: ['AP elbow', 'Internal oblique elbow', 'External oblique elbow', 'Lateral elbow', 'Radial head lateral elbow'] },
  { id: 'elbow-ra', exam: 'Elbow', indication: 'Rheumatoid arthritis', side: 'limb',
    views: ['AP elbow', 'Lateral elbow'] },
  { id: 'humerus-routine', exam: 'Humerus', indication: 'Routine', side: 'limb',
    views: ['AP humerus', 'Lateral humerus'] },
  // ---- shoulder, clavicle
  { id: 'shoulder-routine', exam: 'Shoulder', indication: 'Routine / Pathology', side: 'limb',
    views: ['AP shoulder internal rotation', 'AP shoulder external rotation', 'Axial shoulder (inferosuperior)'],
    either: [{ slot: 'SI or IS axial', of: ['Axial shoulder (inferosuperior)', 'Axial shoulder (superoinferior)'] }] },
  { id: 'shoulder-trauma', exam: 'Shoulder', indication: 'Trauma / Post-reduction', side: 'limb',
    views: ['AP shoulder neutral rotation', 'Y view shoulder', 'Axial shoulder (inferosuperior)'],
    either: [{ slot: 'SI or IS axial', of: ['Axial shoulder (inferosuperior)', 'Axial shoulder (superoinferior)'] }] },
  { id: 'shoulder-peds', exam: 'Shoulder', indication: 'Paediatric', side: 'limb', peds: [2, 16],
    views: ['AP shoulder internal rotation', 'Grashey shoulder (glenoid AP oblique)', 'Y view shoulder', 'Axial shoulder (inferosuperior)'],
    either: [{ slot: 'SI or IS axial', of: ['Axial shoulder (inferosuperior)', 'Axial shoulder (superoinferior)'] }] },
  { id: 'shoulder-ra', exam: 'Shoulder', indication: 'Rheumatoid arthritis', side: 'limb',
    views: ['AP shoulder internal rotation', 'AP shoulder external rotation'] },
  { id: 'clavicle-routine', exam: 'Clavicle', indication: 'Routine', side: 'trunk',
    views: ['AP clavicle', 'AP axial clavicle'] },
  // ---- foot, ankle, leg
  { id: 'foot-routine', exam: 'Foot', indication: 'Routine', side: 'limb',
    views: ['AP foot', 'Oblique foot', 'Lateral foot'] },
  { id: 'ankle-routine', exam: 'Ankle', indication: 'Routine / Trauma', side: 'limb',
    views: ['Mortise ankle', 'External oblique ankle', 'Lateral ankle'] },
  { id: 'ankle-recheck', exam: 'Ankle', indication: 'Recheck / Follow-up', side: 'limb',
    views: ['AP ankle', 'Mortise ankle', 'Lateral ankle'] },
  { id: 'ankle-peds', exam: 'Ankle', indication: 'Paediatric', side: 'limb', peds: [2, 16],
    views: ['External oblique ankle', 'AP ankle', 'Mortise ankle', 'Lateral ankle'] },
  { id: 'ankle-ra', exam: 'Ankle', indication: 'Rheumatoid arthritis', side: 'limb',
    views: ['Mortise ankle', 'Lateral ankle'] },
  { id: 'leg-routine', exam: 'Lower leg (tibia/fibula)', indication: 'Routine', side: 'limb',
    views: ['AP tibia/fibula', 'Lateral tibia/fibula'] },
  { id: 'leg-toddler', exam: 'Lower leg (tibia/fibula)', indication: 'Paediatric 1-3 y, ? fracture', side: 'limb', peds: [1, 3],
    views: ['AP tibia/fibula', 'Internal oblique tibia/fibula', 'External oblique tibia/fibula', 'Lateral tibia/fibula'] },
  // ---- knee, femur
  { id: 'knee-trauma', exam: 'Knee', indication: 'Trauma', side: 'limb',
    views: ['AP knee', 'Internal oblique knee', 'External oblique knee', 'Cross-table lateral knee'] },
  { id: 'knee-pathology', exam: 'Knee', indication: 'Pathology', side: 'limb',
    views: ['AP knee', 'Lateral knee'] },
  { id: 'knee-arthritis', exam: 'Knee', indication: 'Arthritis', side: 'limb',
    views: ['AP knee standing', 'Lateral knee standing', 'Skyline knee'] },
  { id: 'knee-rosenberg', exam: 'Knee', indication: 'Tunnel / Rosenberg view requested', side: 'limb',
    views: ['AP knee', 'Internal oblique knee', 'External oblique knee', 'Cross-table lateral knee', 'Rosenberg knee (PA 45° flexion)'] },
  { id: 'knee-peds', exam: 'Knee', indication: 'Paediatric', side: 'limb', peds: [2, 16],
    views: ['AP knee', 'Internal oblique knee', 'External oblique knee', 'Lateral knee'] },
  { id: 'femur-routine', exam: 'Femur', indication: 'Routine', side: 'limb',
    views: ['Femur pasting', 'Lateral femur pasting'] },
  // ---- hip, pelvis, sacrum
  { id: 'hip-pathology', exam: 'Hip', indication: 'Pathology', side: 'trunk',
    views: ['AP hip', 'Frog-leg lateral hip'] },
  { id: 'hip-hardware', exam: 'Hip', indication: 'Pre-op / Post-op / Hardware follow-up', side: 'trunk',
    views: ['AP hip', 'Roll-up lateral hip (Lauenstein)'] },
  { id: 'hip-trauma', exam: 'Hip', indication: 'Trauma (emergency)', side: 'trunk',
    views: ['AP hip (no leg rotation)', 'Cross-table lateral hip'] },
  // (Judet and inlet/outlet are mostly trauma, where the AP pelvis is taken without the legs
  // turned in: either AP is accepted)
  { id: 'pelvis-routine', exam: 'Pelvis', indication: 'Routine (with hip)', side: 'trunk',
    views: ['AP pelvis', 'AP hip', 'Frog-leg lateral hip'] },
  { id: 'pelvis-only', exam: 'Pelvis', indication: 'No hip ordered',
    views: ['AP pelvis'] },
  { id: 'pelvis-judet', exam: 'Pelvis', indication: 'Judet (acetabulum)',
    views: ['AP pelvis (no leg rotation)', 'Judet RPO pelvis', 'Judet LPO pelvis'],
    either: [{ slot: 'AP pelvis', of: ['AP pelvis (no leg rotation)', 'AP pelvis'] }] },
  { id: 'pelvis-inletoutlet', exam: 'Pelvis', indication: 'Inlet / Outlet',
    views: ['AP pelvis (no leg rotation)', 'Inlet pelvis', 'Outlet pelvis'],
    either: [{ slot: 'AP pelvis', of: ['AP pelvis (no leg rotation)', 'AP pelvis'] }] },
  { id: 'sacrum-routine', exam: 'Sacrum + Coccyx', indication: 'Routine', combine: ['si-routine'],
    views: ['AP axial sacrum / SI joints', 'AP axial coccyx', 'Lateral sacrum / coccyx'] },
  { id: 'si-routine', exam: 'SI joints', indication: 'Routine', combine: ['sacrum-routine'],
    views: ['AP axial sacrum / SI joints'] },
  // ---- spine
  { id: 'lspine-routine', exam: 'Lumbar spine', indication: 'Routine',
    views: ['AP lumbar', 'Lateral lumbar'] },
  { id: 'tspine-routine', exam: 'Thoracic spine', indication: 'Routine',
    views: ['AP thoracic', 'Lateral thoracic'] },
  { id: 'tspine-c7t1', exam: 'Thoracic spine', indication: 'C7-T1 in the reason for exam',
    views: ['AP thoracic', 'Lateral thoracic', 'Swimmers lateral'] },
  { id: 'cspine-preop', exam: 'Cervical spine', indication: 'Pre-op',
    views: ['Lateral cervical flexion'] },
  { id: 'cspine-trauma', exam: 'Cervical spine', indication: 'Trauma',
    views: ['Lateral cervical', 'AP cervical', 'AP open mouth'] },
  { id: 'cspine-routine', exam: 'Cervical spine', indication: 'Pathology / Arthritis / Routine',
    views: ['Lateral cervical flexion', 'Lateral cervical extension', 'RAO cervical', 'LAO cervical', 'AP cervical', 'AP open mouth'] },
  { id: 'stneck-adenoids', exam: 'Soft-tissue neck', indication: 'Adenoids', peds: [1, 12],
    views: ['Lateral soft-tissue neck (adenoids)'] },
  { id: 'stneck-epiglottis', exam: 'Soft-tissue neck', indication: 'Epiglottis',
    views: ['Lateral soft-tissue neck (epiglottis)'] },
  // ---- abdomen, chest, ribs
  { id: 'abdo-obstruction', exam: 'Abdomen', indication: '? Obstruction',
    views: ['Upright abdomen', 'AP abdomen (KUB)'] },
  { id: 'abdo-kub', exam: 'Abdomen', indication: 'Fecal loading / Stones',
    views: ['AP abdomen (KUB)'] },
  { id: 'ribs-anterior', exam: 'Ribs', indication: 'Anterior ribs', side: 'trunk',
    views: ['PA chest', 'Lateral chest', 'Anterior oblique ribs'] },
  { id: 'ribs-posterior', exam: 'Ribs', indication: 'Posterior ribs', side: 'trunk',
    views: ['PA chest', 'Lateral chest', 'Posterior oblique ribs'] },
  { id: 'chest-routine', exam: 'Chest', indication: 'Routine',
    views: ['PA chest', 'Lateral chest'] },
  { id: 'chest-ptx', exam: 'Chest', indication: '? or r/o pneumothorax',
    views: ['PA chest', 'PA chest expiration', 'Lateral chest'] },
  { id: 'chest-ptx-fu', exam: 'Chest', indication: 'Follow-up pneumothorax',
    views: ['PA chest', 'PA chest expiration'] },
];

export const lineById = (id) => HOSPITAL.find((l) => l.id === id) || null;

/* WHERE AND HOW each view is taken, for judging the order of a series (core/viewOrder.js).
     room     the set-up, as the room selector names them: 'wall' (the wall stand, upright),
              'table' (the table's bucky), 'detector' (a free detector, the patient lying on it or
              on a stretcher, the plate placed as needed), 'seated' (the wall stand's bucky turned
              flat, the patient on a stool beside it)
     posture  how the patient is: 'seated', 'supine', 'prone', 'erect', 'lateral' (recumbent on
              the side), 'oblique' (recumbent, turned)
     rot      degrees the body (or the limb) is turned from that posture's start
     xt       a horizontal beam: the receptor stood beside the patient, who does not move
     site     the anatomy on a standing adult, [x across (cm, the patient's right +), z height (cm)]
   The hand, wrist, forearm and elbow are taken seated at the flat bucky, and so are the seated
   (Merchant) skyline and the superoinferior axial shoulder, with the bucky tilted off level. */
const S_ = (x, z) => [x, z];
const SITE = {
  hand: S_(27, 74), wrist: S_(26, 82), forearm: S_(24, 92), elbow: S_(22, 105), humerus: S_(20, 120),
  shoulder: S_(18, 140), clavicle: S_(10, 143), foot: S_(12, 3), ankle: S_(10, 8), leg: S_(10, 30),
  knee: S_(10, 50), femur: S_(10, 70), hip: S_(9, 88), pelvis: S_(0, 92), sacrum: S_(0, 90),
  coccyx: S_(0, 84), lspine: S_(0, 105), abdomen: S_(0, 100), tspine: S_(0, 125), chest: S_(0, 125),
  ribs: S_(12, 125), cspine: S_(0, 148), c7t1: S_(0, 140), neck: S_(0, 152), odontoid: S_(0, 155),
};
const v = (room, posture, rot, site, xt = false) => ({ room, posture, rot, site: SITE[site], xt });
export const VIEW_META = {
  'PA hand': v('seated', 'seated', 0, 'hand'),
  'Oblique hand': v('seated', 'seated', 45, 'hand'),
  'Lateral hand': v('seated', 'seated', 90, 'hand'),
  'Fan lateral hand': v('seated', 'seated', 90, 'hand'),
  'Ballcatcher hands (Norgaard)': v('seated', 'seated', 135, 'hand'),
  'PA wrist': v('seated', 'seated', 0, 'wrist'),
  'Oblique wrist': v('seated', 'seated', 45, 'wrist'),
  'Lateral wrist': v('seated', 'seated', 90, 'wrist'),
  'External oblique wrist': v('seated', 'seated', 135, 'wrist'),
  'Scaphoid view wrist': v('seated', 'seated', 0, 'wrist'),
  'AP forearm': v('seated', 'seated', 0, 'forearm'),
  'Lateral forearm': v('seated', 'seated', 90, 'forearm'),
  'AP elbow': v('seated', 'seated', 0, 'elbow'),
  'Internal oblique elbow': v('seated', 'seated', 45, 'elbow'),
  'External oblique elbow': v('seated', 'seated', -45, 'elbow'),
  'Lateral elbow': v('seated', 'seated', 90, 'elbow'),
  'Radial head lateral elbow': v('seated', 'seated', 90, 'elbow'),
  'AP humerus': v('wall', 'erect', 0, 'humerus'),
  'Lateral humerus': v('wall', 'erect', 90, 'humerus'),
  'AP shoulder internal rotation': v('wall', 'erect', 0, 'shoulder'),
  'AP shoulder external rotation': v('wall', 'erect', 0, 'shoulder'),
  'AP shoulder neutral rotation': v('wall', 'erect', 0, 'shoulder'),
  'Grashey shoulder (glenoid AP oblique)': v('wall', 'erect', 35, 'shoulder'),
  'Y view shoulder': v('wall', 'erect', 50, 'shoulder'),
  'Axial shoulder (inferosuperior)': v('table', 'supine', 0, 'shoulder'),
  'Axial shoulder (superoinferior)': v('seated', 'seated', 0, 'shoulder'),
  'AP clavicle': v('wall', 'erect', 0, 'clavicle'),
  'AP axial clavicle': v('wall', 'erect', 0, 'clavicle'),
  'AP foot': v('detector', 'supine', 0, 'foot'),
  'Oblique foot': v('detector', 'supine', 30, 'foot'),
  'Lateral foot': v('detector', 'supine', 90, 'foot'),
  'AP ankle': v('detector', 'supine', 0, 'ankle'),
  'Mortise ankle': v('detector', 'supine', 18, 'ankle'),
  'External oblique ankle': v('detector', 'supine', -45, 'ankle'),
  'Lateral ankle': v('detector', 'supine', 90, 'ankle'),
  'AP tibia/fibula': v('detector', 'supine', 0, 'leg'),
  'Internal oblique tibia/fibula': v('detector', 'supine', 45, 'leg'),
  'External oblique tibia/fibula': v('detector', 'supine', -45, 'leg'),
  'Lateral tibia/fibula': v('detector', 'supine', 90, 'leg'),
  'AP knee': v('detector', 'supine', 0, 'knee'),
  'Internal oblique knee': v('detector', 'supine', 45, 'knee'),
  'External oblique knee': v('detector', 'supine', -45, 'knee'),
  'Lateral knee': v('table', 'lateral', 90, 'knee'),
  'Cross-table lateral knee': v('detector', 'supine', 0, 'knee', true),
  'AP knee standing': v('wall', 'erect', 0, 'knee'),
  'Lateral knee standing': v('wall', 'erect', 90, 'knee'),
  'Rosenberg knee (PA 45° flexion)': v('wall', 'erect', 180, 'knee'),
  'Skyline knee': v('seated', 'seated', 0, 'knee'),
  'AP femur': v('table', 'supine', 0, 'femur'),
  'Lateral femur': v('table', 'lateral', 90, 'femur'),
  'Femur pasting': v('table', 'supine', 0, 'femur'),
  'Lateral femur pasting': v('table', 'supine', 45, 'femur'),
  'AP hip': v('table', 'supine', 0, 'hip'),
  'AP hip (no leg rotation)': v('table', 'supine', 0, 'hip'),
  'Frog-leg lateral hip': v('table', 'supine', 0, 'hip'),
  'Roll-up lateral hip (Lauenstein)': v('table', 'oblique', 45, 'hip'),
  'Cross-table lateral hip': v('detector', 'supine', 0, 'hip', true),
  'AP pelvis': v('table', 'supine', 0, 'pelvis'),
  'AP pelvis (no leg rotation)': v('table', 'supine', 0, 'pelvis'),
  'Judet RPO pelvis': v('table', 'oblique', -45, 'pelvis'),
  'Judet LPO pelvis': v('table', 'oblique', 45, 'pelvis'),
  'Inlet pelvis': v('table', 'supine', 0, 'pelvis'),
  'Outlet pelvis': v('table', 'supine', 0, 'pelvis'),
  'AP axial sacrum / SI joints': v('table', 'supine', 0, 'sacrum'),
  'AP axial coccyx': v('table', 'supine', 0, 'coccyx'),
  'Lateral sacrum / coccyx': v('table', 'lateral', 90, 'sacrum'),
  'AP lumbar': v('table', 'supine', 0, 'lspine'),
  'Lateral lumbar': v('table', 'lateral', 90, 'lspine'),
  'AP thoracic': v('table', 'supine', 0, 'tspine'),
  'Lateral thoracic': v('table', 'lateral', 90, 'tspine'),
  'Swimmers lateral': v('table', 'lateral', 90, 'c7t1'),
  'Lateral cervical': v('wall', 'erect', 90, 'cspine'),
  'Lateral cervical flexion': v('wall', 'erect', 90, 'cspine'),
  'Lateral cervical extension': v('wall', 'erect', 90, 'cspine'),
  'RAO cervical': v('wall', 'erect', 135, 'cspine'),
  'LAO cervical': v('wall', 'erect', -135, 'cspine'),
  'AP cervical': v('wall', 'erect', 0, 'cspine'),
  'AP open mouth': v('wall', 'erect', 0, 'odontoid'),
  'Oblique cervical': v('wall', 'erect', 45, 'cspine'),
  'Lateral soft-tissue neck (adenoids)': v('wall', 'erect', 90, 'neck'),
  'Lateral soft-tissue neck (epiglottis)': v('wall', 'erect', 90, 'neck'),
  'Upright abdomen': v('wall', 'erect', 0, 'abdomen'),
  'AP abdomen (KUB)': v('table', 'supine', 0, 'abdomen'),
  'PA chest': v('wall', 'erect', 180, 'chest'),
  'PA chest expiration': v('wall', 'erect', 180, 'chest'),
  'Lateral chest': v('wall', 'erect', 90, 'chest'),
  'Anterior oblique ribs': v('wall', 'erect', 135, 'ribs'),
  'Posterior oblique ribs': v('wall', 'erect', 45, 'ribs'),
};

/* The pathology the requisition's patient may have (core/pathology.js stamps it into the volume
   when the films are made; a view sees it or not as the physics decides). subject: the model it
   belongs to. */
export const PATHOLOGY_IDS = {
  distalRadiusFx: 'hand', scaphoidWaistFx: 'hand', boxerFx: 'hand', raHand: 'hand', castWrist: 'hand',
  radialHeadFx: 'upperextremity', humerusNeckFx: 'upperextremity', humerusShaftFx: 'upperextremity',
  forearmShaftFx: 'upperextremity',
  clavicleFx: 'chest', ribFxAnterior: 'chest', ribFxPosterior: 'chest', pneumothorax: 'chest',
  pneumonia: 'chest', effusion: 'chest',
  weberBFx: 'foot', mt5BaseFx: 'foot',
  tibialShaftFx: 'lowerextremity', tibialPlateauFx: 'lowerextremity', kneeOA: 'lowerextremity',
  patellaFx: 'lowerextremity', femurShaftFx: 'lowerextremity',
  femoralNeckFx: 'chestabdopelvis', hipArthroplasty: 'chestabdopelvis', pubicRamiFx: 'chestabdopelvis',
  acetabularFx: 'chestabdopelvis', sbo: 'chestabdopelvis', kidneyStone: 'chestabdopelvis',
  fecalLoading: 'chestabdopelvis', l1CompressionFx: 'chestabdopelvis', coccyxFx: 'chestabdopelvis',
  epiglottitis: 'headneck', adenoids: 'headneck', cspineOA: 'headneck', c6SpinousFx: 'headneck',
};
