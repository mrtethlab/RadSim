/* ============================================================================
   REQUISITION — a diagnostic-imaging requisition for the Protocol Trainer.

   makeRequisition rolls a case (cases.js) into the form a department receives: a patient
   (name, DOB, MRN, health card, address, allergies, meds, LMP, isolation, mobility), the
   encounter (class, location, priority, when ordered, accession), the ordering physician and
   the family physician copied, the exams, and the reason for exam and history with their
   tokens filled. The answer travels with it and is not for the student's eyes: each exam's
   hospital line, and the pathology the patient was rolled to have.

   Everything is drawn from a seeded generator (mulberry32): seedRng(seed) gives the same
   requisition for the same seed and the same day, so a requisition is stored as { seed, today }.

   All of it is fictional: the hospital, clinics and people are invented, the province
   (Westmarch, WM) does not exist, postal codes start with Z (unused in Canada), phone numbers
   are 555-01xx, and health cards carry a WHC- prefix no province issues.

   req:
     seed, caseId
     patient    { surname, given, name, sex, dob, age, ageText, mrn, healthCard, address, phone,
                  language, interpreter, weightKg, heightCm, allergies[], meds[],
                  pregnancy: { status, lmp } | null (females 12-55 only), isolation, mobility,
                  familyPhysician: { name, clinic, phone, fax } | null (unattached) }
     encounter  { patientClass, location, unit, room, bed, priority, ordered, accession, facility }
     referrer   { name, credentials, specialty, department, address, phone, fax, billing, cc }
     exams      [{ name, side: 'L' | 'R' | null, line }]   line: the answer
     question, request (or null), history
     pathology  { id, side, line } | null   side: for a lesion that has one
     findings   what the films show (null when the case says nothing)
   ============================================================================ */
import { CASES, caseById } from './cases.js';
import { lineById } from './hospitalProtocols.js';

// ---- the generator
export function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// a number, or any string (hashed, FNV-1a); the generator carries its seed
export function seedRng(seed) {
  let s = seed;
  if (typeof s !== 'number') {
    s = 2166136261;
    for (const ch of String(seed)) { s ^= ch.codePointAt(0); s = Math.imul(s, 16777619); }
  }
  const rng = mulberry32(s >>> 0);
  rng.seed = seed;
  return rng;
}
export const newSeed = () => Math.floor(Math.random() * 2 ** 32);

const int = (rng, a, b) => a + Math.floor(rng() * (b - a + 1));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const chance = (rng, p) => rng() < p;
const digits = (rng, n) => Array.from({ length: n }, () => int(rng, 0, 9)).join('');
// a string, an array (uniform) or { value: weight }
function choose(rng, c) {
  if (c == null || typeof c !== 'object') return c;
  if (Array.isArray(c)) return pick(rng, c);
  const keys = Object.keys(c);
  let t = rng() * keys.reduce((s, k) => s + c[k], 0);
  for (const k of keys) { t -= c[k]; if (t < 0) return k; }
  return keys[keys.length - 1];
}

// ---- dates (local time, so the form reads as the department's clock)
const pad = (n) => String(n).padStart(2, '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dmy = (d) => `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMinutes = (d, n) => new Date(d.getTime() + n * 60000);
export function ageOn(dob, d) {
  const before = d.getMonth() < dob.getMonth() || (d.getMonth() === dob.getMonth() && d.getDate() < dob.getDate());
  return d.getFullYear() - dob.getFullYear() - (before ? 1 : 0);
}
// a birthday that makes the patient `age` on day `on`
function dobFor(rng, age, on) {
  const anniversary = new Date(on.getFullYear() - age, on.getMonth(), on.getDate());
  const dob = addDays(anniversary, -int(rng, 0, 364));
  return ageOn(dob, on) === age ? dob : anniversary;
}

// ---- the world
const REGION = 'WM';
const CITIES = ['Kestrel Bay', 'Kestrel Bay', 'Kestrel Bay', 'Port Aldine', 'Millbrook Falls', 'Saint-Aurèle',
  'Hollins Crossing', 'Ravensmere', 'Tillbury Mills'];
const STREETS = ['Lighthouse Rd', 'Quay St', 'Harbourfront Dr', 'Juniper Ave', 'Kingfisher Cres', 'Old Mill Rd',
  'rue des Érables', 'Tamarack Way', 'Sandpiper Lane', 'Gull Point Rd', 'Birchwood Dr', 'Ferry Rd', 'Cartwright St',
  'Beacon Hill Rd', 'Larch Crt', 'Osprey Blvd', 'Chandler Ave', 'boul. Saint-Aurèle', 'Netmender Row', 'Foundry St'];
const AREA = ['613', '705', '519'];
const LET = 'ABCEGHJKLMNPRSTVXY';
const postal = (rng) => `Z${int(rng, 1, 9)}${pick(rng, LET)} ${int(rng, 1, 9)}${pick(rng, LET)}${int(rng, 0, 9)}`;
const phone = (rng) => `(${pick(rng, AREA)}) 555-01${digits(rng, 2)}`;
const address = (rng, city = pick(rng, CITIES)) =>
  `${int(rng, 2, 2400)} ${pick(rng, STREETS)}${chance(rng, 0.2) ? `, Apt ${int(rng, 101, 1804)}` : ''}, ${city}, ${REGION} ${postal(rng)}`;

export const HOSPITAL_INFO = { name: 'Kestrel Bay Regional Health Centre', short: 'KBRHC',
  address: '400 Lighthouse Rd, Kestrel Bay, WM Z1K 4B2', phone: '(613) 555-0100', imaging: 'Diagnostic Imaging' };

/* Names by cultural group: the surname, given names and the language spoken at home go together.
   w: how often the group appears; langs: the language field, weighted. */
const GROUPS = [
  { w: 6, langs: { English: 1 },
    sur: ['Thompson', 'MacDonald', 'Campbell', 'Stewart', 'Fraser', 'Murphy', 'Walsh', 'Brennan', 'Harper', 'Ellis',
      'Whitfield', 'Calder', 'Ashby', 'Penrose', 'Hollis', 'Marsh', 'Doyle', 'Kerr', 'McAllister', 'Pritchard'],
    F: ['Emily', 'Sarah', 'Megan', 'Olivia', 'Claire', 'Hannah', 'Rebecca', 'Margaret', 'Joan', 'Brenda', 'Ava', 'Chloe', 'Abigail', 'Heather'],
    M: ['James', 'Liam', 'Ryan', 'Connor', 'Matthew', 'Robert', 'Douglas', 'Gordon', 'Kevin', 'Owen', 'Noah', 'Ethan', 'Wyatt', 'Graham'] },
  { w: 4, langs: { French: 3, English: 2 },
    sur: ['Tremblay', 'Gagnon', 'Bouchard', 'Côté', 'Pelletier', 'Lavoie', 'Gauthier', 'Fortin', 'Bélanger', 'Morin',
      'Ouellet', 'Thibodeau', 'Arsenault', 'Cormier', 'Robichaud'],
    F: ['Geneviève', 'Isabelle', 'Mélanie', 'Chloé', 'Émilie', 'Nathalie', 'Sophie', 'Julie', 'Léa', 'Monique', 'Josée'],
    M: ['Luc', 'François', 'Mathis', 'Étienne', 'Olivier', 'Jean-Philippe', 'Marc-André', 'Gabriel', 'Denis', 'Réjean', 'Yves'] },
  { w: 2, langs: { English: 3, Punjabi: 2 },
    sur: ['Sandhu', 'Gill', 'Dhillon', 'Grewal', 'Brar', 'Sidhu', 'Bains'],
    F: ['Harpreet', 'Simran', 'Navneet', 'Jaspreet', 'Manpreet', 'Gurleen'],
    M: ['Gurpreet', 'Harjit', 'Sandeep', 'Jagdeep', 'Amarjit', 'Ravinder'] },
  { w: 2, langs: { English: 4, Gujarati: 1, Hindi: 1, Tamil: 1, Urdu: 1 },
    sur: ['Patel', 'Shah', 'Sharma', 'Iyer', 'Krishnan', 'Reddy', 'Chaudhry', 'Qureshi', 'Menon'],
    F: ['Priya', 'Anjali', 'Kavya', 'Ayesha', 'Lakshmi', 'Meera', 'Divya', 'Sana'],
    M: ['Arjun', 'Rohan', 'Vikram', 'Imran', 'Karthik', 'Rajesh', 'Nikhil', 'Faisal'] },
  { w: 3, langs: { English: 3, Mandarin: 2, Cantonese: 2 },
    sur: ['Chen', 'Wong', 'Li', 'Zhang', 'Liu', 'Lam', 'Chan', 'Huang', 'Wu', 'Zhou', 'Tse'],
    F: ['Mei Ling', 'Xiao Hui', 'Yan', 'Grace', 'Jenny', 'Ling', 'Wing Yan', 'Jia Yi'],
    M: ['Wei', 'Jun', 'Hao', 'Kevin', 'Ming', 'Zhi Hao', 'Kwok Wai', 'Andy'] },
  { w: 2, langs: { English: 3, Tagalog: 2 },
    sur: ['Santos', 'Reyes', 'Cruz', 'Bautista', 'Dela Cruz', 'Mendoza', 'Villanueva', 'Aquino', 'Manalo'],
    F: ['Maricel', 'Jocelyn', 'Kristine', 'Angelica', 'Rosario', 'Liza'],
    M: ['Jericho', 'Rodel', 'Mark Anthony', 'Ramon', 'Joel', 'Arnel'] },
  { w: 1, langs: { English: 2, Vietnamese: 2 },
    sur: ['Nguyen', 'Tran', 'Le', 'Pham', 'Hoang', 'Vu', 'Dang'],
    F: ['Linh', 'Thao', 'Mai', 'Hoa', 'Ngoc Anh'], M: ['Minh', 'Tuan', 'Duc', 'Quang', 'Huy'] },
  { w: 2, langs: { English: 2, Arabic: 2, French: 1 },
    sur: ['Haddad', 'Khoury', 'Mansour', 'Saleh', 'Nasser', 'Hamdan', 'Aziz', 'Farouk'],
    F: ['Layla', 'Rania', 'Nour', 'Mariam', 'Yasmin', 'Huda'], M: ['Omar', 'Karim', 'Youssef', 'Samir', 'Tarek', 'Ahmad'] },
  { w: 1, langs: { English: 2, Somali: 2, Amharic: 1 },
    sur: ['Abdi', 'Hassan', 'Warsame', 'Yusuf', 'Tesfaye', 'Bekele', 'Farah'],
    F: ['Hodan', 'Amina', 'Fadumo', 'Selam', 'Hana'], M: ['Abdirahman', 'Mahad', 'Dawit', 'Yonas', 'Mohamed'] },
  { w: 1, langs: { English: 1 },
    sur: ['Okafor', 'Mensah', 'Adeyemi', 'Osei', 'Boateng', 'Eze', 'Nwosu', 'Owusu'],
    F: ['Chiamaka', 'Ama', 'Adaeze', 'Efua', 'Folake'], M: ['Kwame', 'Chinedu', 'Emeka', 'Kofi', 'Tunde'] },
  { w: 1, langs: { English: 3, French: 1, 'Haitian Creole': 1 },
    sur: ['Clarke', 'Bailey', 'Francis', 'Grant', 'Joseph', 'Baptiste', 'Charles'],
    F: ['Kezia', 'Shanice', 'Marcia', 'Tamara', 'Nadège'], M: ['Andre', 'Delroy', 'Marlon', 'Jerome', 'Wilner'] },
  { w: 2, langs: { English: 2, Spanish: 2 },
    sur: ['Hernández', 'Martínez', 'Rodríguez', 'López', 'Ramírez', 'Torres', 'Flores', 'Morales'],
    F: ['Valentina', 'Camila', 'Sofía', 'Gabriela', 'María José'], M: ['Diego', 'Mateo', 'Alejandro', 'Javier', 'Carlos'] },
  { w: 1, langs: { English: 3, Portuguese: 2 },
    sur: ['Ferreira', 'Silva', 'Pereira', 'Costa', 'Medeiros', 'Rebelo', 'Furtado'],
    F: ['Ana Paula', 'Fátima', 'Inês', 'Rita'], M: ['João', 'Manuel', 'Rui', 'Tiago'] },
  { w: 1, langs: { English: 4, Italian: 1 },
    sur: ['Rossi', 'Russo', 'Esposito', 'Romano', 'Bianchi', 'DiMarco', 'Ricci'],
    F: ['Giulia', 'Francesca', 'Rosa', 'Teresa'], M: ['Marco', 'Giuseppe', 'Luca', 'Antonio'] },
  { w: 1, langs: { English: 3, Ukrainian: 1, Polish: 1 },
    sur: ['Kovalenko', 'Bondarenko', 'Melnyk', 'Novak', 'Horvat', 'Tkachuk', 'Wiśniewski'],
    F: ['Olena', 'Iryna', 'Natalia', 'Katarzyna', 'Oksana'], M: ['Andriy', 'Taras', 'Piotr', 'Dmytro', 'Tomasz'] },
  { w: 1, langs: { English: 2, Korean: 1 },
    sur: ['Kim', 'Park', 'Choi', 'Jung', 'Kang', 'Yoon'],
    F: ['Ji-woo', 'Seo-yeon', 'Min-ji', 'Eun-ji', 'Hye-jin'], M: ['Min-jun', 'Jae-hyun', 'Seung-ho', 'Dong-hyun'] },
  { w: 1, langs: { English: 2, Farsi: 1 },
    sur: ['Ahmadi', 'Karimi', 'Hosseini', 'Rahimi', 'Tehrani', 'Moradi'],
    F: ['Shirin', 'Parisa', 'Leila', 'Neda'], M: ['Reza', 'Dariush', 'Kian', 'Arash'] },
];
const GROUP_W = Object.fromEntries(GROUPS.map((g, i) => [i, g.w]));
function person(rng, sex) {
  const g = GROUPS[choose(rng, GROUP_W)];
  const s = sex || (chance(rng, 0.5) ? 'F' : 'M');
  let given = pick(rng, g[s]);
  if (chance(rng, 0.25)) { const m = pick(rng, g[s]); if (m !== given) given += ` ${m}`; }
  return { group: g, surname: pick(rng, g.sur), given };
}
const fullName = (p) => `${p.given} ${p.surname}`;

// ---- referring departments: in-house ones sit in the hospital, the rest have offices
const FM_OFFICES = [
  { name: 'Harbourside Family Health Team', address: '15 Quay St, Kestrel Bay, WM Z1K 2A3' },
  { name: 'Old Mill Road Family Medicine', address: '880 Old Mill Rd, Kestrel Bay, WM Z1M 3C8' },
  { name: 'Millbrook Falls Community Health Centre', address: '42 Ferry Rd, Millbrook Falls, WM Z3A 1H5' },
  { name: 'Clinique médicale Saint-Aurèle', address: '310 boul. Saint-Aurèle, Saint-Aurèle, WM Z4B 2N1' },
  { name: 'Northgate Family Practice', address: '1210 Osprey Blvd, Suite 2, Kestrel Bay, WM Z1R 5T2' },
  { name: 'Ravensmere Family Health Organization', address: '77 Foundry St, Ravensmere, WM Z5C 3P4' },
];
const WALKIN = [
  { name: 'Pinecrest Walk-in Clinic', address: '505 Chandler Ave, Kestrel Bay, WM Z1L 4V6' },
  { name: 'Quayside Urgent Care Clinic', address: '9 Netmender Row, Port Aldine, WM Z2E 1B7' },
];
const office = (name, address) => [{ name, address }];
const DEPTS = {
  ED: { specialty: 'Emergency Medicine', creds: ['MD, CCFP(EM)', 'MD, FRCPC'], dept: 'Emergency Department', inHouse: true },
  'paeds ED': { specialty: 'Paediatric Emergency Medicine', creds: ['MD, FRCPC'], dept: 'Paediatric Emergency Department', inHouse: true },
  'fracture clinic': { specialty: 'Orthopaedic Surgery', creds: ['MD, FRCSC'], dept: 'Fracture Clinic', inHouse: true },
  orthopaedics: { specialty: 'Orthopaedic Surgery', creds: ['MD, FRCSC'], dept: 'Division of Orthopaedic Surgery',
    offices: office('Kestrel Bay Orthopaedic Associates', '220 Quay St, Suite 410, Kestrel Bay, WM Z1K 2R7') },
  'family medicine': { specialty: 'Family Medicine', creds: ['MD, CCFP', 'MD, CCFP', 'MD, CCFP, FCFP'], offices: FM_OFFICES },
  'walk-in': { specialty: 'Family Medicine', creds: ['MD, CCFP', 'MD'], offices: WALKIN },
  rheumatology: { specialty: 'Rheumatology', creds: ['MD, FRCPC'],
    offices: office('Lakeside Arthritis & Rheumatology Clinic', '1450 Harbourfront Dr, Suite 300, Kestrel Bay, WM Z1K 6G2') },
  paediatrics: { specialty: 'Paediatrics', creds: ['MD, FRCPC'], dept: 'Department of Paediatrics',
    offices: office('Little Harbour Paediatrics', '60 Sandpiper Lane, Kestrel Bay, WM Z1N 2J9') },
  respirology: { specialty: 'Respirology', creds: ['MD, FRCPC'], dept: 'Division of Respirology',
    offices: office('Bayview Chest & Sleep Clinic', '220 Quay St, Suite 615, Kestrel Bay, WM Z1K 2R7') },
  'general surgery': { specialty: 'General Surgery', creds: ['MD, FRCSC'], dept: 'General Surgery', inHouse: true },
  urology: { specialty: 'Urology', creds: ['MD, FRCSC'],
    offices: office('Westmarch Urology Group', '3 Beacon Hill Rd, Suite 120, Kestrel Bay, WM Z1P 3S5') },
  ENT: { specialty: 'Otolaryngology - Head & Neck Surgery', creds: ['MD, FRCSC'],
    offices: office('Harbour ENT & Facial Surgery', '1450 Harbourfront Dr, Suite 210, Kestrel Bay, WM Z1K 6G2') },
  'sports medicine': { specialty: 'Sport & Exercise Medicine', creds: ['MD, CCFP, Dip. Sport Med'],
    offices: office('Northgate Sport Medicine Centre', '1210 Osprey Blvd, Suite 8, Kestrel Bay, WM Z1R 5T2') },
  'inpatient medicine': { specialty: 'Internal Medicine', creds: ['MD, FRCPC'], dept: 'Hospitalist Service', inHouse: true },
  'pre-op clinic': { specialty: 'Anaesthesiology', creds: ['MD, FRCPC'], dept: 'Pre-Admission Clinic', inHouse: true },
  'spine surgery': { specialty: 'Orthopaedic Spine Surgery', creds: ['MD, FRCSC'], dept: 'Regional Spine Program', inHouse: true },
  'thoracic surgery': { specialty: 'Thoracic Surgery', creds: ['MD, FRCSC'], dept: 'Thoracic Surgery Clinic', inHouse: true },
  plastics: { specialty: 'Plastic Surgery (Hand)', creds: ['MD, FRCSC'], dept: 'Hand & Upper Limb Clinic', inHouse: true },
};
export const DEPT_KEYS = Object.keys(DEPTS);

// inpatient units by service: [floor, wing, name]
const UNITS = { 'inpatient medicine': [7, 'W', 'Medicine'], 'general surgery': [5, 'N', 'General Surgery'],
  orthopaedics: [4, 'E', 'Orthopaedics'], paediatrics: [3, 'S', 'Paediatrics'], respirology: [6, 'E', 'Respirology'],
  'thoracic surgery': [5, 'S', 'Thoracic Surgery'], 'spine surgery': [4, 'E', 'Orthopaedics'] };
const WING = { N: 'North', S: 'South', E: 'East', W: 'West' };
const ED_BED = { 'Paediatric ED': 'P', Resus: 'R', Acute: 'A', 'Fast Track': 'FT', Hallway: 'H' };   // bed prefixes

// ---- defaults by setting
const CLASS = { ED: 'Emergency', inpatient: 'Inpatient', outpatient: 'Outpatient', 'fracture clinic': 'Outpatient' };
const PRIORITY = { ED: { Urgent: 3, STAT: 1 }, inpatient: { Routine: 2, Urgent: 1 }, outpatient: 'Routine', 'fracture clinic': 'Routine' };
const MOBILITY = { ED: { ambulatory: 3, wheelchair: 2, stretcher: 2 }, inpatient: { ambulatory: 1, wheelchair: 2, stretcher: 2 },
  outpatient: { ambulatory: 9, wheelchair: 1 }, 'fracture clinic': { ambulatory: 4, wheelchair: 1 } };
const ISOLATION = { ED: { None: 18, 'Droplet/Contact (ILI screen +)': 1, 'Contact (MRSA)': 1 },
  inpatient: { None: 7, 'Contact (MRSA)': 1, 'Contact (VRE)': 1, 'Contact Plus (C. difficile)': 1 },
  outpatient: 'None', 'fracture clinic': 'None' };
const ALLERGIES = { NKDA: 14, 'Penicillin (rash)': 3, 'Sulfa (hives)': 1, 'Codeine (nausea/vomiting)': 1,
  'Iodinated contrast (hives)': 1, Latex: 1, 'ASA (angioedema)': 1, 'Morphine (pruritus)': 1, 'Cephalexin (rash)': 1 };

// token ranges: [min, max, decimals]
const VARS = { hours: [1, 8], days: [2, 7], weeks: [2, 6], months: [3, 12], years: [2, 12],
  temp: [38.1, 39.6, 1], hr: [98, 124], spo2: [90, 95] };

// the requisition's name for each HOSPITAL exam
export const EXAM_NAMES = { Hand: 'XR HAND', Wrist: 'XR WRIST', Forearm: 'XR FOREARM', Elbow: 'XR ELBOW',
  Humerus: 'XR HUMERUS', Shoulder: 'XR SHOULDER', Clavicle: 'XR CLAVICLE', Foot: 'XR FOOT', Ankle: 'XR ANKLE',
  'Lower leg (tibia/fibula)': 'XR TIBIA/FIBULA', Knee: 'XR KNEE', Femur: 'XR FEMUR', Hip: 'XR HIP', Pelvis: 'XR PELVIS',
  'Sacrum + Coccyx': 'XR SACRUM/COCCYX', 'SI joints': 'XR SI JOINTS', 'Lumbar spine': 'XR SPINE LUMBAR',
  'Thoracic spine': 'XR SPINE THORACIC', 'Cervical spine': 'XR SPINE CERVICAL', 'Soft-tissue neck': 'XR NECK SOFT TISSUE',
  Abdomen: 'XR ABDOMEN', Ribs: 'XR RIBS', Chest: 'XR CHEST' };

// lesions that are on one side of the body: the requisition's side
const LATERAL = new Set(['distalRadiusFx', 'scaphoidWaistFx', 'boxerFx', 'raHand', 'castWrist', 'radialHeadFx',
  'humerusNeckFx', 'humerusShaftFx', 'forearmShaftFx', 'clavicleFx', 'ribFxAnterior', 'ribFxPosterior', 'pneumothorax',
  'pneumonia', 'effusion', 'weberBFx', 'mt5BaseFx', 'tibialShaftFx', 'tibialPlateauFx', 'kneeOA', 'patellaFx',
  'femurShaftFx', 'femoralNeckFx', 'hipArthroplasty', 'pubicRamiFx', 'acetabularFx', 'kidneyStone']);

// height (cm) and weight (kg) for an age and sex
function body(rng, age, sex) {
  let h, w;
  if (age < 13) {
    h = 76 + 6.2 * age + (rng() - 0.5) * 10;
    w = (2 * age + 8) * (0.85 + rng() * 0.35);
  } else if (age < 18) {
    h = (sex === 'F' ? 150 + (age - 13) * 2.5 : 155 + (age - 13) * 5) + (rng() - 0.5) * 12;
    w = (17 + rng() * 8) * (h / 100) ** 2;
  } else {
    h = sex === 'F' ? 152 + rng() * 24 : 164 + rng() * 26;
    w = (19 + rng() * 13 + (age > 40 ? 2 : 0)) * (h / 100) ** 2;
  }
  return { heightCm: Math.round(h), weightKg: age < 13 ? Math.round(w * 10) / 10 : Math.round(w) };
}

// LMP and pregnancy status on the day of the exam: females 12-55 only
function pregnancy(rng, sex, age, setting, on) {
  if (sex !== 'F' || age < 12 || age > 55) return null;
  if (age >= 48 && chance(rng, 0.25 + (age - 48) * 0.1)) return { status: 'Post-menopausal', lmp: null };
  if (age <= 13 && chance(rng, 0.4)) return { status: 'Pre-menarchal', lmp: null };
  const status = choose(rng, setting === 'ED'
    ? { 'Not pregnant (β-hCG negative)': 3, 'Not pregnant': 2, Unsure: 1 }
    : { 'Not pregnant': 8, Unsure: 1 });
  return { status, lmp: ymd(addDays(on, -int(rng, 3, 34))) };
}

function physician(rng, key, setting) {
  const D = DEPTS[key];
  const p = person(rng);
  const atHospital = D.inHouse || !D.offices || setting === 'ED' || setting === 'inpatient' || setting === 'fracture clinic';
  const off = atHospital ? null : pick(rng, D.offices);
  return { name: fullName(p), credentials: pick(rng, D.creds), specialty: D.specialty,
    department: off ? off.name : `${D.dept || D.specialty}, ${HOSPITAL_INFO.short}`,
    address: off ? off.address : HOSPITAL_INFO.address,
    phone: off ? phone(rng) : `${HOSPITAL_INFO.phone} ext. ${int(rng, 2000, 7999)}`,
    fax: phone(rng), billing: digits(rng, 6) };
}

/* A requisition. rng: a seeded generator (seedRng), or seed to make one; caseId: a case from
   cases.js (default: any); today: the day it is made (default now). */
export function makeRequisition({ rng, seed, caseId, today, drawable } = {}) {
  rng = rng || seedRng(seed ?? newSeed());
  const now = today ? new Date(today) : new Date();
  const c = caseId ? caseById(caseId) : pick(rng, CASES);
  if (!c) throw new Error(`makeRequisition: no case '${caseId}'`);

  // ---- who and where
  const age = int(rng, c.age[0], c.age[1]);
  const sex = !c.sex || c.sex === 'any' ? (chance(rng, 0.5) ? 'F' : 'M') : choose(rng, c.sex);
  const setting = choose(rng, c.setting) || 'outpatient';
  const refKey = choose(rng, typeof c.referrer === 'object' && !Array.isArray(c.referrer)
    ? c.referrer[setting] ?? Object.values(c.referrer)[0] : c.referrer);
  if (!DEPTS[refKey]) throw new Error(`case ${c.id}: no department '${refKey}'`);
  const priority = choose(rng, c.priority ?? PRIORITY[setting]);
  const side = chance(rng, 0.5) ? 'L' : 'R';
  const sideWord = side === 'L' ? 'left' : 'right';

  // ---- when: the ED, the wards and the fracture clinic order on the day, offices days before
  const ordered = setting === 'outpatient'
    ? (() => { const d = addDays(now, -int(rng, 1, 28)); d.setHours(8, 0, 0, 0); return addMinutes(d, 5 * int(rng, 0, 108)); })()
    : addMinutes(now, -int(rng, 10, 180));

  // ---- tokens
  const T = { side: sideWord, Side: sideWord[0].toUpperCase() + sideWord.slice(1), SIDE: sideWord.toUpperCase(),
    other: side === 'L' ? 'right' : 'left', age: String(age) };
  for (const [k, def] of Object.entries(VARS)) {
    const [a, b, dp = 0] = c.vars?.[k] ?? def;
    T[k] = dp ? (a + rng() * (b - a)).toFixed(dp) : String(int(rng, a, b));
  }
  T.dateDaysAgo = dmy(addDays(ordered, -Number(T.days)));
  T.dateWeeksAgo = dmy(addDays(ordered, -7 * Number(T.weeks)));
  T.dateMonthsAgo = (() => { const d = new Date(ordered); d.setMonth(d.getMonth() - Number(T.months)); return dmy(d); })();
  const fill = (s) => (s == null ? null : s.replace(/\{(\w+)\}/g, (m, k) => (k in T ? T[k] : m)));

  // ---- the patient
  const who = person(rng, sex);
  const language = choose(rng, who.group.langs);
  const interpreter = language !== 'English' && language !== 'French'
    && chance(rng, age >= 60 ? 0.8 : age < 18 ? 0.3 : 0.45);
  const dob = dobFor(rng, age, now);
  const months = (now.getFullYear() - dob.getFullYear()) * 12 + now.getMonth() - dob.getMonth() - (now.getDate() < dob.getDate() ? 1 : 0);
  const allergies = [choose(rng, ALLERGIES)];
  if (allergies[0] !== 'NKDA' && chance(rng, 0.2)) {
    const more = choose(rng, ALLERGIES);
    if (more !== 'NKDA' && more !== allergies[0]) allergies.push(more);
  }
  const fpDept = refKey === 'family medicine';
  const referrer = physician(rng, refKey, setting);
  const familyPhysician = fpDept ? { name: referrer.name, clinic: referrer.department, phone: referrer.phone, fax: referrer.fax }
    : chance(rng, 0.12) ? null
      : (() => {
        let name = fullName(person(rng));
        while (name === referrer.name) name = fullName(person(rng));
        const o = pick(rng, FM_OFFICES);
        return { name, clinic: o.name, phone: phone(rng), fax: phone(rng) };
      })();
  referrer.cc = fpDept ? null : familyPhysician;

  const patient = {
    surname: who.surname, given: who.given, name: `${who.surname.toUpperCase()}, ${who.given}`, sex,
    dob: ymd(dob), age, ageText: age < 2 ? `${months} mo` : `${age} y`,
    mrn: `KB${digits(rng, 7)}`,
    healthCard: `WHC-${digits(rng, 4)}-${digits(rng, 3)}-${digits(rng, 3)}-${pick(rng, 'XYZ')}${pick(rng, 'XYZ')}`,
    address: address(rng), phone: phone(rng), language, interpreter,
    ...body(rng, age, sex),
    allergies, meds: c.meds ? [...c.meds] : ['None'],
    pregnancy: pregnancy(rng, sex, age, setting, now),
    isolation: choose(rng, c.isolation ?? ISOLATION[setting]),
    mobility: age < 4 ? 'carried' : choose(rng, c.mobility ?? MOBILITY[setting]),
    familyPhysician,
  };

  // ---- the encounter
  const enc = { patientClass: CLASS[setting], location: 'Outpatient', unit: null, room: null, bed: null, priority };
  if (setting === 'ED') {
    enc.unit = age < 17 ? 'Paediatric ED'
      : choose(rng, priority === 'STAT' ? { Resus: 1, Acute: 2 } : { Acute: 2, 'Fast Track': 2, Hallway: 1 });
    enc.bed = `${ED_BED[enc.unit]}${int(rng, 1, enc.unit === 'Resus' ? 4 : 18)}`;
    enc.location = `Emergency, ${enc.unit} ${enc.bed}`;
  } else if (setting === 'inpatient') {
    const [floor, wing, service] = age < 17 ? UNITS.paediatrics : UNITS[refKey] || UNITS['inpatient medicine'];
    enc.unit = `${floor} ${WING[wing]} (${service})`;
    enc.room = `${floor}${wing}-${pad(int(rng, 1, 36))}`;
    enc.bed = pick(rng, ['A', 'B']);
    enc.location = `${enc.unit}, room ${enc.room}, bed ${enc.bed}`;
  } else if (setting === 'fracture clinic') {
    enc.location = 'Outpatient, Fracture Clinic';
  }
  enc.ordered = `${ymd(ordered)} ${pad(ordered.getHours())}:${pad(ordered.getMinutes())}`;
  enc.accession = `XR${ymd(ordered).slice(2).replace(/-/g, '')}${digits(rng, 4)}`;
  enc.facility = `${HOSPITAL_INFO.imaging}, ${HOSPITAL_INFO.name}`;

  // ---- the exams (the answer rides along)
  const exams = c.lines.map((id) => {
    const L = lineById(id);
    const s = L.side ? side : null;
    return { name: `${c.names?.[id] ?? EXAM_NAMES[L.exam]}${s ? ` ${T.SIDE}` : ''}`, side: s, line: id };
  });

  // ---- the pathology, at most one
  let hit = null;
  let r = rng();
  for (const p of c.pathology || []) { if (r < p.p) { hit = p; break; } r -= p.p; }
  // (a lesion the films cannot show is not given: the requisition is then a normal one)
  if (hit && drawable && !drawable(hit.id)) hit = null;
  const pathology = hit ? { id: hit.id, side: LATERAL.has(hit.id) ? side : null, line: hit.line ?? c.lines[0] } : null;
  const findings = fill(hit ? hit.positive ?? c.findings?.positive : c.findings?.negative) ?? null;

  return {
    seed: rng.seed ?? seed ?? null, caseId: c.id,
    patient, encounter: enc, referrer, exams,
    question: fill(choose(rng, c.question)), request: fill(choose(rng, c.request)) || null,
    history: fill(choose(rng, c.history)), pathology, findings,
  };
}
