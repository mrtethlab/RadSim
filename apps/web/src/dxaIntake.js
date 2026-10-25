/* ============================================================================
   THE DXA INTAKE FORM
   Before a bone density scan the technologist asks the patient a short list of questions and
   writes the answers down. Most of them shape the report (risk factors the referrer needs next
   to the T-score); a few mean the scan must not go ahead today:
     - possibly pregnant                        -> postpone until pregnancy is excluded
     - a barium study in the last 14 days       -> barium in the bowel overlies the spine
     - iodinated contrast (CT, IVP) or a nuclear
       medicine study in the last 7 days        -> contrast or tracer still in the body
     - a calcium supplement in the last 24 hours -> an undissolved tablet in the gut can lie
                                                   over L1-L4 and read as bone
     - over the table's weight limit (159 kg)   -> refer to a scanner that can take them
   A previous scan within the year is not a reason to send them home (it is an insurance
   question, not a clinical one), and nor is any risk factor: those are why the scan is done.

   Pure: a seed makes one patient, the same every time (the report re-derives from it).
   ============================================================================ */

export const TABLE_LIMIT_KG = 159;        // 350 lb
export const DELAY_DAYS = { barium: 14, contrast: 7, nuclear: 7, calcium: 1 };

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];

const SURNAMES = ['Okonkwo', 'Lindqvist', 'Ferreira', 'Nakamura', 'Vasquez', 'Bergeron', 'Haddad',
  'Kowalski', 'Ashworth', 'Petrova', 'Marchetti', 'Dubois', 'Novak', 'Sandoval', 'Moreau', 'Achebe'];
const FIRST_F = ['Miriam', 'Aiko', 'Rosalind', 'Femi', 'Ingrid', 'Carmen', 'Priya', 'Noor', 'Helen', 'Grace'];
const FIRST_M = ['Emeka', 'Anders', 'Rafael', 'Kenji', 'Marcus', 'Tobias', 'Idris', 'Levi', 'Walter', 'Omar'];

/* One patient. `force` (tests) sets a field's case: { delay: 'pregnant' | 'barium' | ... | null }. */
export function makeIntake(seed, force = {}) {
  const r = rng(seed);
  const sex = force.sex || (r() < 0.82 ? 'f' : 'm');           // most DXA patients are women
  const age = force.age ?? Math.round(sex === 'f' ? 44 + r() * 42 : 52 + r() * 34);
  const height = Math.round((sex === 'm' ? 175 : 162) + (r() - 0.5) * 16 - Math.max(0, age - 65) * 0.12);
  let bmi = 19 + r() * 13;
  // which reason (if any) this patient should be sent home for: about one in three
  const delayKinds = ['pregnant', 'barium', 'contrast', 'nuclear', 'calcium', 'weight'];
  let delay = 'delay' in force ? force.delay : (r() < 0.34 ? pick(r, delayKinds) : null);
  if (delay === 'pregnant' && (sex === 'm' || age > 50)) delay = sex === 'm' ? 'contrast' : 'calcium';
  if (delay === 'weight') bmi = TABLE_LIMIT_KG / (height / 100) ** 2 + 1 + r() * 4;
  const weight = Math.round(bmi * (height / 100) ** 2);

  // ---- the answers
  const prevYears = r();
  const previous = prevYears < 0.4 ? 'No, this is my first one'
    : prevYears < 0.75 ? `Yes, ${2 + Math.floor(r() * 3)} years ago, at this clinic`
    : `Yes, about ${8 + Math.floor(r() * 10)} months ago`;
  let imaging = 'None';
  if (delay === 'barium') imaging = `Barium swallow ${2 + Math.floor(r() * 10)} days ago`;
  else if (delay === 'contrast') imaging = `CT abdomen with IV contrast ${1 + Math.floor(r() * 5)} days ago`;
  else if (delay === 'nuclear') imaging = `Nuclear medicine bone scan ${1 + Math.floor(r() * 5)} days ago`;
  else if (r() < 0.25) imaging = pick(r, ['CT chest with contrast about 3 months ago',
    'Barium enema last year', 'Chest x-ray last month (no contrast)', 'Ultrasound of the thyroid 3 weeks ago']);

  const meds = [];
  const steroids = r() < 0.18, thyroid = r() < 0.2, chemo = r() < 0.1;
  if (steroids) meds.push(pick(r, ['Prednisone 10 mg daily for 8 months', 'Prednisone 5 mg daily for 2 years']));
  if (thyroid) meds.push('Levothyroxine 100 mcg daily');
  if (chemo) meds.push(sex === 'f' ? 'Letrozole (aromatase inhibitor) since breast cancer' : 'Leuprolide injections (androgen deprivation)');
  if (r() < 0.35) meds.push(pick(r, ['Atorvastatin', 'Metformin', 'Lisinopril', 'Omeprazole for 6 years']));
  if (!meds.length) meds.push('None');

  const fragility = r() < 0.22;
  const fracture = fragility ? pick(r, [`Wrist, falling from standing, at ${Math.max(45, age - 1 - Math.floor(r() * 8))}`,
    `Spine (compression fracture) found on x-ray at ${Math.max(50, age - 1 - Math.floor(r() * 5))}`,
    `Hip, falling from standing, at ${Math.max(55, age - 1 - Math.floor(r() * 4))}`])
    : r() < 0.3 ? `Ankle, skiing accident, at ${18 + Math.floor(r() * 15)}` : 'None';

  const sm = r();
  const smoking = sm < 0.55 ? 'Never' : sm < 0.8 ? `Former, quit ${3 + Math.floor(r() * 20)} years ago` : 'Current, about a pack a day';
  const vitamins = pick(r, ['Vitamin D 1000 IU daily', 'Multivitamin daily', 'None', 'Vitamin D 2000 IU and a multivitamin']);
  const calcium = delay === 'calcium' ? pick(r, ['Yes, 600 mg with breakfast this morning', 'Yes, a calcium chew about an hour ago'])
    : r() < 0.4 ? 'Not today (I take it in the evening)' : 'No';
  const cancer = chemo ? (sex === 'f' ? 'Breast cancer, treated 3 years ago' : 'Prostate cancer, on hormone therapy')
    : r() < 0.08 ? 'Skin cancer (basal cell) removed' : 'None';

  let menses = 'Not applicable';
  let menoAge = null;
  if (sex === 'f') {
    if (delay === 'pregnant') menses = `Still having periods; last one ${5 + Math.floor(r() * 3)} weeks ago, could be pregnant`;
    else if (age < 48 && r() < 0.7) menses = `Still having periods; last one ${1 + Math.floor(r() * 3)} weeks ago`;
    else {
      menoAge = Math.min(age, r() < 0.15 ? 40 + Math.floor(r() * 5) : 47 + Math.floor(r() * 8));
      menses = r() < 0.15 ? `Hysterectomy with ovaries removed at ${menoAge}` : `Menopause at ${menoAge}`;
    }
  }

  const fields = [
    { key: 'age', q: 'Age', a: `${age}` },
    { key: 'height', q: 'Height', a: `${height} cm (${Math.floor(height / 30.48)}' ${Math.round((height / 2.54) % 12)}")` },
    { key: 'weight', q: 'Weight', a: `${weight} kg (${Math.round(weight * 2.2046)} lb)` },
    { key: 'previous', q: 'Previous bone density scan?', a: previous },
    { key: 'imaging', q: 'Any x-rays or scans with contrast (barium, CT dye, nuclear medicine) recently?', a: imaging },
    { key: 'meds', q: 'Medications (steroids, thyroid, chemotherapy or hormone therapy)?', a: meds.join('; ') },
    { key: 'fracture', q: 'Have you ever broken a bone? How?', a: fracture },
    { key: 'smoking', q: 'Do you smoke?', a: smoking },
    { key: 'vitamins', q: 'Vitamins taken?', a: vitamins },
    { key: 'calcium', q: 'Have you taken calcium today?', a: calcium },
    { key: 'cancer', q: 'History of cancer?', a: cancer },
    { key: 'menses', q: sex === 'f' ? 'Menstruation / menopause (age)?' : 'Menstruation / menopause?', a: menses },
  ];

  // ---- the bone: how much mineral this skeleton has lost, from what the form says
  const risks = [];
  // (a woman loses bone fastest in the decade after menopause; a man slowly from his fifties)
  let loss;
  if (sex === 'f') { const m = menoAge ?? (age >= 51 ? 51 : null); loss = m != null ? Math.min(0.3, (age - m) * 0.0085) : 0; }
  else loss = Math.max(0, age - 55) * 0.004;
  if (sex === 'f' && menoAge != null && menoAge < 45) { loss += 0.04; risks.push(`Early menopause (${menoAge})`); }
  if (steroids) { loss += 0.08; risks.push('Long-term glucocorticoids'); }
  if (chemo) { loss += 0.06; risks.push(sex === 'f' ? 'Aromatase inhibitor therapy' : 'Androgen deprivation therapy'); }
  if (thyroid) { loss += 0.02; risks.push('Thyroid hormone replacement'); }
  if (fragility) { loss += 0.06; risks.push('Prior fragility fracture'); }
  if (smoking.startsWith('Current')) { loss += 0.05; risks.push('Current smoker'); }
  const bmiNow = weight / (height / 100) ** 2;
  if (bmiNow < 20) { loss += 0.05; risks.push(`Low body weight (BMI ${bmiNow.toFixed(1)})`); }
  loss += (r() - 0.5) * 0.06;
  loss = Math.max(0, Math.min(0.4, loss));

  const P = {
    seed, sex, age, height, weight, bmi: +bmiNow.toFixed(1),
    name: `${pick(r, SURNAMES)}, ${pick(r, sex === 'm' ? FIRST_M : FIRST_F)}`,
    id: String(Math.floor(100000 + r() * 899999)),
    fields, risks, loss: +loss.toFixed(3),
    indication: risks.length ? 'Osteoporosis screening; risk factors below'
      : sex === 'f' ? (age >= 65 ? 'Routine screening, woman 65 or older' : 'Postmenopausal screening')
      : 'Screening, man with risk of bone loss',
  };
  P.verdict = intakeVerdict(P);
  return P;
}

/* Whether the scan must wait, and why: read off the ANSWERS, as the technologist would. */
export function intakeVerdict(P) {
  const a = Object.fromEntries(P.fields.map((f) => [f.key, f.a]));
  const reasons = [];
  const days = (s) => { const m = /(\d+) days? ago/.exec(s); return m ? +m[1] : null; };
  const img = a.imaging || '', d = days(img);
  if (/barium/i.test(img) && d != null && d <= DELAY_DAYS.barium)
    reasons.push(`Barium study ${d} days ago: barium in the bowel overlies the spine and hips. Wait ${DELAY_DAYS.barium} days.`);
  if (/(contrast|dye)/i.test(img) && !/barium/i.test(img) && d != null && d <= DELAY_DAYS.contrast)
    reasons.push(`Iodinated contrast ${d} days ago. Wait ${DELAY_DAYS.contrast} days.`);
  if (/nuclear/i.test(img) && d != null && d <= DELAY_DAYS.nuclear)
    reasons.push(`Nuclear medicine study ${d} days ago: the tracer is still in the body. Wait ${DELAY_DAYS.nuclear} days.`);
  if (/^yes/i.test(a.calcium || ''))
    reasons.push('Calcium taken today: an undissolved tablet can lie over the lumbar spine and read as bone. Rebook in 24 hours, no calcium beforehand.');
  if (/could be pregnant/i.test(a.menses || ''))
    reasons.push('Possibly pregnant: postpone until pregnancy is excluded.');
  if (P.weight > TABLE_LIMIT_KG)
    reasons.push(`${P.weight} kg is over the table limit (${TABLE_LIMIT_KG} kg): refer to a scanner rated for it.`);
  return { delay: reasons.length > 0, reasons };
}
