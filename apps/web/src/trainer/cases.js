/* ============================================================================
   TRAINER CASES — the requisitions a department gets, as templates for the Protocol Trainer.

   Each case is one kind of request: who orders it, why, and the clinical story that tells the
   student which hospital routine applies (hospitalProtocols.js). The history points to the line
   without naming it: RA in the PMH and a rheumatologist ordering, a reduction and its date, a
   child's age, vomiting and no flatus, stones or constipation. Some are distractors: an
   arthritic patient who fell still gets the trauma routine. requisition.js rolls a fictional
   patient around a case and fills its tokens.

   case:
     id         stable key
     lines      HOSPITAL line ids (1-3), one exam each on the requisition: the answer
     age        [min, max] years: inside the line's peds range for a paediatric routine, and
                above it for the adult routine of an exam that has one
     sex        'any' | 'F' | 'M' | { F: 3, M: 1 }
     setting    'ED' | 'outpatient' | 'inpatient' | 'fracture clinic' (a choice)
     referrer   a DEPTS key (requisition.js), or { setting: key } when it depends on the setting
     priority   'Routine' | 'Urgent' | 'STAT' (a choice; default by setting)
     question   the reason for exam as the physician writes it
     request    free text naming a view or a routine ('' = none); never the whole list
     history    the clinical history
     pathology  [{ id (PATHOLOGY_IDS), p, line?, positive? }]: at most one is rolled; line: the
                exam it shows on (default the first); positive: its own findings text
     findings   { positive, negative }: what the films show with the rolled pathology, or without
     meds       current medications (default none);  vars { days: [5, 9] } token ranges
     names      { lineId: exam name } where the requisition calls an exam something else
     mobility, isolation   overrides of the setting's defaults (choices)
   A choice is a string, an array (uniform) or { value: weight }.
   Tokens: {side} {Side} {SIDE} {other} {age} {hours} {days} {weeks} {months} {years} {temp} {hr}
   {spo2} {dateDaysAgo} {dateWeeksAgo} {dateMonthsAgo} (dates count back from the order date).
   Clinical text says 'pt', never he or she.
   ============================================================================ */

// seen in the ED or, the next morning, at a walk-in clinic
const EDW = { setting: { ED: 3, outpatient: 1 }, referrer: { ED: 'ED', outpatient: 'walk-in' } };
const PED = { setting: 'ED', referrer: 'paeds ED' };
const FXC = { setting: 'fracture clinic', referrer: 'fracture clinic', priority: 'Routine' };
const NWB = { mobility: { wheelchair: 3, stretcher: 1 } };       // not weight-bearing
const RA_MEDS = ['methotrexate 20 mg SC weekly', 'folic acid 5 mg PO weekly', 'hydroxychloroquine 200 mg PO BID'];
const OSTEO_MEDS = ['alendronate 70 mg PO weekly', 'calcium carbonate 500 mg PO BID', 'vitamin D3 1000 IU PO daily'];

export const CASES = [
  // ---- hand
  { id: 'hand-boxer', lines: ['hand-routine'], age: [17, 40], sex: { M: 4, F: 1 }, ...EDW,
    question: ['? 5th MC fx', '? # {side} hand', 'Hand injury ? fx'],
    history: 'Punched a wall {hours} h ago. Swelling and bruising over ulnar border of {side} hand, TTP 5th MC '
      + 'neck, loss of knuckle contour on making a fist. No rotational deformity. Superficial abrasion over 5th '
      + 'MCP, no fight bite. NV intact. PMH nil.',
    pathology: [{ id: 'boxerFx', p: 0.55 }],
    findings: { positive: 'Fracture of the 5th metacarpal neck with volar angulation of the head.',
      negative: 'No fracture or dislocation. Soft-tissue swelling over the ulnar side of the hand.' } },
  { id: 'hand-ra-fall', lines: ['hand-routine'], age: [50, 80], sex: { F: 3, M: 1 }, ...EDW,
    question: ['? fx {side} 5th MC', 'Fall onto hand ? fx'],
    history: 'Tripped over a dog leash, fell and struck ulnar side of {side} hand on the sidewalk. Swelling and TTP '
      + 'over 5th MC, pain on making a fist. PMH: rheumatoid arthritis x {years} y (stable on MTX), HTN. Chronic '
      + 'ulnar drift of both hands, unchanged per pt.',
    meds: ['methotrexate 15 mg PO weekly', 'folic acid 1 mg PO daily', 'amlodipine 5 mg PO daily'],
    pathology: [{ id: 'boxerFx', p: 0.45 }],
    findings: { positive: 'Fracture of the 5th metacarpal neck with volar angulation.',
      negative: 'No acute fracture. Soft-tissue swelling over the 5th metacarpal.' } },
  { id: 'hand-ra', lines: ['hand-ra'], age: [35, 75], sex: { F: 3, M: 1 },
    setting: 'outpatient', referrer: 'rheumatology', priority: 'Routine',
    question: ['RA - assess erosive disease', 'Seropositive RA, ? erosions', 'RA: baseline films before biologic'],
    request: { '': 3, 'Please include Norgaard view': 1 },
    history: 'Seropositive RA (RF+, anti-CCP+) dx {years} y ago. AM stiffness ~1 h, synovitis 2nd/3rd MCPs and '
      + 'PIPs bilat, {side} worse. ESR/CRP elevated. Inadequate response to MTX + HCQ, starting a biologic. '
      + 'Last hand films > 2 y ago.',
    meds: [...RA_MEDS, 'prednisone 5 mg PO daily'],
    pathology: [{ id: 'raHand', p: 0.8 }],
    findings: { positive: 'Periarticular osteopenia, joint-space narrowing and marginal erosions at the MCP and PIP joints and the ulnar styloid.',
      negative: 'No erosions. Joint spaces and bone density preserved.' } },
  { id: 'hand-recheck', lines: ['hand-recheck'], age: [17, 45], sex: { M: 4, F: 1 }, ...FXC, vars: { days: [5, 10] },
    question: ['F/u 5th MC neck fx post-reduction', 'Post CR check {side} hand'],
    history: '{Side} 5th MC neck fx, ~45° angulation, closed reduction under haematoma block in ED {dateDaysAgo}, '
      + 'ulnar gutter splint applied. Seen in clinic today: splint intact, swelling settling, no rotational '
      + 'deformity. Films to confirm position maintained.',
    pathology: [{ id: 'boxerFx', p: 1 }],
    findings: { positive: 'Healing 5th metacarpal neck fracture in an ulnar-gutter splint; residual volar angulation about 20°, position maintained.' } },

  // ---- wrist
  { id: 'wrist-colles', lines: ['wrist-trauma'], age: [55, 92], sex: { F: 3, M: 1 }, ...EDW,
    question: ['FOOSH ? distal radius fx', '? # {side} wrist', 'Wrist injury post fall'],
    history: 'Slipped on ice {hours} h ago, FOOSH onto {side} wrist. Swelling, ? dorsal deformity, TTP distal radius, '
      + 'ROM limited by pain. Median nerve sensation intact, cap refill < 2 s. PMH osteopenia (DXA {years} y ago), '
      + 'HTN. Lives alone, independent.',
    meds: ['ramipril 5 mg PO daily', 'calcium carbonate 500 mg PO BID', 'vitamin D3 1000 IU PO daily'],
    pathology: [{ id: 'distalRadiusFx', p: 0.7 }],
    findings: { positive: 'Distal radius fracture with dorsal angulation and impaction.',
      negative: 'No fracture. Soft-tissue swelling over the dorsum of the wrist.' } },
  { id: 'wrist-pain', lines: ['wrist-trauma'], age: [18, 50], sex: 'any',
    setting: 'outpatient', referrer: 'family medicine', priority: 'Routine',
    question: ['{Side} wrist pain x {months} mo', 'Chronic wrist pain ? ganglion ? arthritis'],
    history: 'Dorsal {side} wrist pain x {months} mo, worse with weight-bearing on the hand (push-ups, yoga). Small '
      + 'firm dorsal swelling, mildly tender. No trauma recalled. No other joints involved, no AM stiffness. '
      + 'Physio without improvement.',
    findings: { negative: 'Normal wrist: no bone, joint or soft-tissue abnormality.' } },
  { id: 'wrist-recheck', lines: ['wrist-recheck'], age: [20, 85], sex: { F: 2, M: 1 }, ...FXC, vars: { days: [6, 10] },
    question: ['1 wk check distal radius fx', 'Post-reduction f/u {side} wrist', 'Distal radius fx in cast, check position'],
    history: 'Distal radius fx {side} wrist, closed reduction and below-elbow cast in ED {dateDaysAgo}. Post-reduction '
      + 'films acceptable. Cast intact, fingers warm and pink, mild swelling. Films in cast to confirm position '
      + 'maintained.',
    pathology: [{ id: 'castWrist', p: 1 }],
    findings: { positive: 'Distal radius fracture in a below-elbow cast: alignment maintained, no loss of reduction.' } },
  { id: 'wrist-scaphoid', lines: ['wrist-scaphoid'], age: [16, 40], sex: { M: 2, F: 1 }, ...EDW, vars: { days: [1, 3] },
    question: ['? scaphoid fx', 'FOOSH, ? scaphoid', 'Snuffbox tenderness ? scaphoid #'],
    request: { '': 3, 'Scaphoid views please': 1 },
    history: 'FOOSH snowboarding {days} d ago, ongoing radial-sided {side} wrist pain. TTP anatomical snuffbox and '
      + 'scaphoid tubercle, pain on axial compression of the thumb. Mild swelling, full ROM with pain at end range. '
      + 'NV intact.',
    pathology: [{ id: 'scaphoidWaistFx', p: 0.3 }],
    findings: { positive: 'Lucent fracture line across the scaphoid waist.',
      negative: 'No fracture seen. Carpus aligned.' } },
  { id: 'wrist-scaphoid-subtle', lines: ['wrist-scaphoid'], age: [18, 45], sex: 'any',
    setting: 'outpatient', referrer: { outpatient: { 'walk-in': 2, 'family medicine': 1 } }, vars: { days: [2, 5] },
    question: ['{Side} wrist pain post fall ? fx', '? fracture {side} wrist'],
    history: 'Came off a mountain bike {days} d ago, landed on outstretched {side} hand. Thought it was a sprain, still '
      + 'sore. Pain radial side of wrist when gripping, worst on palpation in the hollow at the base of the thumb. '
      + 'No deformity, mild swelling.',
    pathology: [{ id: 'scaphoidWaistFx', p: 0.25 }],
    findings: { positive: 'Fracture through the waist of the scaphoid.',
      negative: 'No fracture seen. Carpus aligned.' } },
  { id: 'wrist-scaphoid-fu', lines: ['wrist-scaphoid-fu'], age: [16, 45], sex: 'any', ...FXC, vars: { days: [10, 14] },
    question: ['Clinical scaphoid fx: repeat films', '? occult scaphoid fx - 2/52 f/u'],
    request: { '': 2, 'Repeat scaphoid series': 1 },
    history: 'FOOSH {dateDaysAgo}. Snuffbox tenderness at the time; ED films showed no fracture, managed as a clinical '
      + 'scaphoid fx in a thumb spica. Still tender in the snuffbox and over the scaphoid tubercle today.',
    pathology: [{ id: 'scaphoidWaistFx', p: 0.35 }],
    findings: { positive: 'Scaphoid waist fracture now visible as a lucent line (resorption at the fracture).',
      negative: 'No scaphoid fracture. Carpus normal.' } },
  { id: 'wrist-scaphoid-union', lines: ['wrist-scaphoid-fu'], age: [17, 45], sex: 'any', ...FXC, vars: { weeks: [6, 10] },
    question: ['Scaphoid waist fx - ? union', 'F/u {side} scaphoid #'],
    history: 'Undisplaced {side} scaphoid waist fx dx {dateWeeksAgo}, treated in a below-elbow thumb spica cast. Cast off '
      + 'today: mild residual snuffbox tenderness. Non-smoker. Assessing union.',
    pathology: [{ id: 'scaphoidWaistFx', p: 1 }],
    findings: { positive: 'Scaphoid waist fracture line still visible, no displacement; no sclerosis of the proximal pole.' } },

  // ---- forearm, elbow, humerus
  { id: 'forearm-nightstick', lines: ['forearm-routine'], age: [17, 50], sex: { M: 2, F: 1 }, ...EDW,
    question: ['? fx {side} forearm', 'Direct blow forearm ? ulna #'],
    history: 'Struck across the {side} forearm by a hockey stick {hours} h ago, arm raised to protect the face. Focal '
      + 'swelling and TTP mid-shaft ulna, pronation/supination painful. Elbow and wrist non-tender. NV intact.',
    pathology: [{ id: 'forearmShaftFx', p: 0.4 }],
    findings: { positive: 'Transverse mid-shaft forearm fracture; the elbow and wrist are congruent.',
      negative: 'No fracture. Soft-tissue swelling over the mid forearm.' } },
  { id: 'elbow-child', lines: ['elbow-routine'], age: [3, 9], sex: 'any', ...PED,
    question: ['? supracondylar fx', 'Elbow injury, refusing to move arm'],
    history: 'Fell from a trampoline onto outstretched {side} arm {hours} h ago. Holding arm flexed, refuses to move '
      + 'the elbow. Swelling around distal humerus, diffusely tender. Radial pulse palpable, warm hand, able to '
      + 'make an "OK" sign and give a thumbs up. Immunizations up to date.',
    findings: { negative: 'No fracture seen. Anterior humeral line through the capitellum; no fat-pad elevation.' } },
  { id: 'elbow-radialhead', lines: ['elbow-radialhead'], age: [18, 60], sex: 'any',
    setting: { ED: 3, outpatient: 1 }, referrer: { ED: 'ED', outpatient: 'sports medicine' },
    question: ['? radial head fx', 'FOOSH, lateral elbow pain ? radial head'],
    request: { '': 3, 'Radial head view please': 1 },
    history: 'FOOSH playing basketball {hours} h ago. Lateral {side} elbow pain, TTP over radial head, pain on '
      + 'pronation/supination, lacks ~20° of extension. Effusion palpable at the lateral soft spot. Wrist '
      + 'non-tender. NV intact.',
    pathology: [{ id: 'radialHeadFx', p: 0.45 }],
    findings: { positive: 'Undisplaced radial head fracture; anterior and posterior fat pads elevated.',
      negative: 'No fracture. No joint effusion.' } },
  { id: 'elbow-radialhead-subtle', lines: ['elbow-radialhead'], age: [20, 55], sex: 'any',
    setting: 'outpatient', referrer: 'walk-in', vars: { days: [2, 5] },
    question: ['{Side} elbow pain since fall', 'Elbow pain ? fx'],
    history: 'Fell off an e-scooter {days} d ago, caught self on outstretched {side} hand. Wrist fine. Now aching '
      + 'lateral elbow, tender just distal to the lateral epicondyle, worse turning door handles. Cannot fully '
      + 'straighten the arm.',
    pathology: [{ id: 'radialHeadFx', p: 0.4 }],
    findings: { positive: 'Subtle radial head fracture with elevated fat pads.',
      negative: 'No fracture. No joint effusion.' } },
  { id: 'elbow-ra', lines: ['elbow-ra'], age: [35, 80], sex: { F: 3, M: 1 },
    setting: 'outpatient', referrer: 'rheumatology', priority: 'Routine',
    question: ['RA - {side} elbow pain, loss of extension', 'Known RA, ? erosive change {side} elbow'],
    history: 'Seropositive RA x {years} y on MTX and adalimumab. New {side} elbow pain x {months} mo with loss of '
      + 'extension (lacks 25°), boggy swelling at the radiocapitellar joint. Rheumatoid nodules over the extensor '
      + 'forearm. No trauma.',
    meds: ['methotrexate 20 mg SC weekly', 'folic acid 5 mg PO weekly', 'adalimumab 40 mg SC q2wk'],
    findings: { negative: 'No erosions; joint spaces preserved.' } },
  { id: 'humerus-shaft', lines: ['humerus-routine'], age: [20, 75], sex: 'any', setting: 'ED', referrer: 'ED',
    question: ['? humeral shaft fx', '{Side} upper arm injury ? fx'],
    history: 'Fell ~1.5 m from a ladder onto {side} side {hours} h ago. Pain and swelling mid upper arm, unable to lift '
      + 'the arm, holding it against the chest. Shoulder and elbow exam limited by pain. Radial nerve function '
      + 'intact (wrist and finger extension normal).',
    mobility: { wheelchair: 2, ambulatory: 1 },
    pathology: [{ id: 'humerusShaftFx', p: 0.5 }],
    findings: { positive: 'Mid-shaft humeral fracture with angulation.',
      negative: 'No fracture. Soft-tissue swelling of the upper arm.' } },

  // ---- shoulder, clavicle
  { id: 'shoulder-pain', lines: ['shoulder-routine'], age: [40, 75], sex: 'any',
    setting: 'outpatient', referrer: { outpatient: { 'family medicine': 3, 'sports medicine': 1 } }, priority: 'Routine',
    question: ['{Side} shoulder pain ? calcific tendinitis', 'Chronic shoulder pain, r/o OA', 'Painful arc ? impingement'],
    history: 'Insidious {side} shoulder pain x {months} mo, night pain, painful arc 60-120°, Hawkins and Neer +. '
      + 'Strength 5/5. No trauma. Works overhead (house painter). 6 wk of physio without improvement. ? calcific '
      + 'tendinitis vs impingement before US.',
    findings: { negative: 'No calcific deposit. Glenohumeral and AC joints normal.' } },
  { id: 'shoulder-prox', lines: ['shoulder-trauma'], age: [60, 92], sex: { F: 2, M: 1 }, setting: 'ED', referrer: 'ED',
    question: ['? # proximal humerus', 'Fall, {side} shoulder pain ? fx'],
    history: 'Mechanical fall at home onto {side} side. Pain and bruising over the proximal arm, unable to abduct, '
      + 'holding arm against chest. Axillary nerve sensation intact. PMH osteoporosis, AF on apixaban.',
    meds: ['apixaban 5 mg PO BID', 'metoprolol 25 mg PO BID', ...OSTEO_MEDS],
    mobility: { wheelchair: 2, stretcher: 1 },
    pathology: [{ id: 'humerusNeckFx', p: 0.55 }],
    findings: { positive: 'Fracture of the surgical neck of the humerus, mildly impacted; humeral head located.',
      negative: 'No fracture or dislocation.' } },
  { id: 'shoulder-postreduction', lines: ['shoulder-trauma'], age: [18, 40], sex: { M: 3, F: 1 },
    setting: 'ED', referrer: 'ED', priority: 'Urgent',
    question: ['Post-reduction films', 'Post reduction {side} shoulder'],
    history: 'Anterior {side} shoulder dislocation playing rugby {hours} h ago, first episode. Pre-reduction films: '
      + 'anterior dislocation, no fx seen. Reduced in ED under procedural sedation. Now comfortable, contour '
      + 'restored, axillary nerve sensation and deltoid function intact post reduction.',
    mobility: { stretcher: 2, wheelchair: 1 },
    findings: { negative: 'Humeral head located in the glenoid. No Hill-Sachs or bony Bankart lesion.' } },
  { id: 'shoulder-peds', lines: ['shoulder-peds'], age: [6, 15], sex: 'any', ...PED,
    question: ['? # {side} shoulder', 'Shoulder injury ? fx proximal humerus'],
    history: 'Checked into the boards at hockey {hours} h ago, fell onto {side} shoulder. Pain proximal arm, unwilling '
      + 'to lift it. Mild swelling, no deformity, clavicle non-tender. NV intact.',
    pathology: [{ id: 'humerusNeckFx', p: 0.3 }],
    findings: { positive: 'Fracture of the proximal humeral metaphysis.',
      negative: 'No fracture. Proximal humeral physis normal.' } },
  { id: 'shoulder-peds-throw', lines: ['shoulder-peds'], age: [11, 15], sex: 'any',
    setting: 'outpatient', referrer: 'sports medicine', priority: 'Routine',
    question: ['{Side} shoulder pain in a pitcher', '? proximal humeral physis stress injury'],
    history: 'Competitive baseball pitcher, {age} y. Gradual {side} shoulder pain x {weeks} wk, worse when throwing, '
      + 'pitch count up this season. TTP lateral proximal humerus. Full ROM, strength normal.',
    findings: { negative: 'No fracture. Proximal humeral physis symmetric, not widened.' } },
  { id: 'shoulder-ra', lines: ['shoulder-ra'], age: [40, 80], sex: { F: 3, M: 1 },
    setting: 'outpatient', referrer: 'rheumatology', priority: 'Routine',
    question: ['RA - {side} shoulder pain', 'Known RA, {side} shoulder ? GH involvement'],
    history: 'RA x {years} y on etanercept and MTX. Worsening {side} shoulder pain and stiffness x {months} mo, '
      + 'difficulty washing hair. Global ROM loss, crepitus. No trauma.',
    meds: ['methotrexate 15 mg PO weekly', 'folic acid 1 mg PO daily', 'etanercept 50 mg SC weekly'],
    findings: { negative: 'No erosions; glenohumeral joint space preserved.' } },
  { id: 'clavicle-adult', lines: ['clavicle-routine'], age: [16, 45], sex: { M: 2, F: 1 }, ...EDW,
    question: ['? # {side} clavicle', 'Fall onto shoulder, clavicle pain'],
    history: 'Went over the handlebars mountain biking, landed on the point of the {side} shoulder. Swelling and TTP '
      + 'mid clavicle, ? step, skin intact (not tented). Supporting the arm. NV intact, AE equal bilat.',
    pathology: [{ id: 'clavicleFx', p: 0.65 }],
    findings: { positive: 'Mid-shaft clavicle fracture with inferior displacement of the lateral fragment.',
      negative: 'No fracture. AC joint normal.' } },
  { id: 'clavicle-child', lines: ['clavicle-routine'], age: [2, 8], sex: 'any', ...PED,
    question: ['? # clavicle', 'Not using {side} arm after fall'],
    history: 'Fell off the couch onto {side} shoulder {hours} h ago. Not using the arm since, cries when lifted under '
      + 'the arms. Swelling and tenderness over the mid clavicle. Moves fingers, good pulses.',
    pathology: [{ id: 'clavicleFx', p: 0.6 }],
    findings: { positive: 'Mid-shaft clavicle fracture.', negative: 'No fracture.' } },

  // ---- foot, ankle, leg
  { id: 'foot-mt5', lines: ['foot-routine'], age: [18, 60], sex: 'any', ...EDW, ...NWB,
    question: ['? 5th MT base fx', 'Inversion injury {side} foot ? fx'],
    history: 'Rolled {side} foot stepping off a curb {hours} h ago. Pain lateral midfoot, TTP base of 5th MT, unable to '
      + 'weight-bear 4 steps. Malleoli and navicular non-tender.',
    pathology: [{ id: 'mt5BaseFx', p: 0.4 }],
    findings: { positive: 'Transverse fracture at the base of the 5th metatarsal.',
      negative: 'No fracture. Soft-tissue swelling over the lateral midfoot.' } },
  { id: 'ankle-inversion', lines: ['ankle-routine'], age: [17, 65], sex: 'any', ...EDW, ...NWB,
    question: ['? # {side} ankle', 'Inversion injury, Ottawa +'],
    history: 'Inversion injury {side} ankle playing soccer {hours} h ago. Swelling and bruising lateral ankle, TTP '
      + 'posterior edge of lateral malleolus, unable to weight-bear 4 steps. Base 5th MT and navicular non-tender. '
      + 'NV intact.',
    pathology: [{ id: 'weberBFx', p: 0.35 }],
    findings: { positive: 'Oblique fracture of the distal fibula at the level of the syndesmosis (Weber B); mortise congruent.',
      negative: 'No fracture. Lateral soft-tissue swelling.' } },
  { id: 'ankle-ra-trip', lines: ['ankle-routine'], age: [50, 80], sex: { F: 3, M: 1 }, setting: 'ED', referrer: 'ED', ...NWB,
    question: ['? fx {side} ankle', 'Fall, ankle pain'],
    history: 'Tripped on a curb, twisted {side} ankle. Immediate pain and swelling, TTP lateral malleolus, unable to '
      + 'weight-bear. PMH rheumatoid arthritis on MTX/prednisone, osteopenia, HTN. Some chronic ankle swelling at '
      + 'baseline per pt, now much worse.',
    meds: ['methotrexate 20 mg PO weekly', 'folic acid 1 mg PO daily', 'prednisone 5 mg PO daily', 'hydrochlorothiazide 25 mg PO daily'],
    pathology: [{ id: 'weberBFx', p: 0.4 }],
    findings: { positive: 'Weber B fracture of the distal fibula; mortise congruent. Generalised osteopenia.',
      negative: 'No fracture. Lateral soft-tissue swelling.' } },
  { id: 'ankle-recheck', lines: ['ankle-recheck'], age: [17, 70], sex: 'any', ...FXC, vars: { days: [10, 16] },
    question: ['Weber B fx - 2 wk check', 'F/u {side} ankle fx in boot'],
    history: 'Isolated {side} Weber B fibular fx {dateDaysAgo}, mortise stable on initial films, managed in an aircast '
      + 'boot, WBAT. Seen in fracture clinic today: swelling improving, walking in the boot. Films to confirm no '
      + 'displacement.',
    pathology: [{ id: 'weberBFx', p: 1 }],
    findings: { positive: 'Weber B fibular fracture with early callus; mortise congruent, medial clear space not widened.' } },
  { id: 'ankle-peds', lines: ['ankle-peds'], age: [8, 15], sex: 'any', ...PED,
    question: ['? # {side} ankle', 'Ankle injury ? growth plate fx'],
    history: 'Rolled {side} ankle at basketball {hours} h ago. Swelling lateral ankle, TTP over the distal fibula at '
      + 'the growth plate rather than the ligaments, limping. Foot non-tender. NV intact.',
    findings: { negative: 'No fracture. Distal tibial and fibular physes symmetric; lateral soft-tissue swelling.' } },
  { id: 'ankle-ra', lines: ['ankle-ra'], age: [35, 75], sex: { F: 3, M: 1 },
    setting: 'outpatient', referrer: 'rheumatology', priority: 'Routine',
    question: ['RA - {side} ankle pain/swelling', 'RA, ? erosive change {side} ankle'],
    history: 'Seropositive RA x {years} y on MTX and sulfasalazine. Persistent {side} ankle and hindfoot swelling x '
      + '{months} mo despite an IA steroid injection. Boggy synovitis anterior ankle. No trauma.',
    meds: ['methotrexate 20 mg SC weekly', 'folic acid 5 mg PO weekly', 'sulfasalazine 1 g PO BID'],
    findings: { negative: 'No erosions. Ankle mortise and joint space preserved.' } },
  { id: 'leg-adult', lines: ['leg-routine'], age: [17, 60], sex: { M: 2, F: 1 }, setting: 'ED', referrer: 'ED',
    mobility: { stretcher: 2, wheelchair: 1 },
    question: ['? # tib/fib', '{Side} lower leg injury ? fx'],
    history: 'Kicked in the {side} shin during a soccer tackle {hours} h ago, unable to weight-bear. Swelling and TTP '
      + 'mid tibia, no open wound. Compartments soft, pain not out of proportion, DP/PT pulses palpable.',
    pathology: [{ id: 'tibialShaftFx', p: 0.45 }],
    findings: { positive: 'Fracture of the tibial shaft.', negative: 'No fracture. Anterior soft-tissue swelling.' } },
  { id: 'leg-toddler', lines: ['leg-toddler'], age: [1, 3], sex: 'any', ...PED, vars: { days: [1, 3] },
    question: ['Refusing to weight bear ? fx', 'Toddler limp, ? fx {side} leg'],
    history: 'Went down a slide on a parent\'s lap {days} d ago, {side} foot caught. Refusing to weight-bear since, '
      + 'crawls normally. Afebrile. No visible swelling; mild tenderness distal tibia, pain on gentle twisting of '
      + 'the leg. Hips and knees full painless ROM.',
    pathology: [{ id: 'tibialShaftFx', p: 0.45 }],
    findings: { positive: 'Subtle spiral lucency in the distal tibial shaft (toddler fracture).',
      negative: 'No fracture seen.' } },

  // ---- knee, femur
  { id: 'knee-dashboard', lines: ['knee-trauma'], age: [18, 65], sex: 'any', setting: 'ED', referrer: 'ED',
    mobility: { stretcher: 2, wheelchair: 1 },
    question: ['? fx {side} knee', 'Knee injury, unable to weight bear'],
    history: 'Front-seat passenger in MVC, {side} knee struck the dashboard. Large effusion, TTP over patella, unable '
      + 'to weight-bear 4 steps or flex to 90°. Able to straight-leg raise with pain. NV intact distally.',
    pathology: [
      { id: 'patellaFx', p: 0.3, positive: 'Transverse fracture of the patella with a joint effusion.' },
      { id: 'tibialPlateauFx', p: 0.15, positive: 'Depressed lateral tibial plateau fracture with a fat-fluid level on the cross-table lateral.' }],
    findings: { negative: 'No fracture. Suprapatellar effusion.' } },
  { id: 'knee-trauma-oa', lines: ['knee-trauma'], age: [60, 85], sex: 'any', setting: 'ED', referrer: 'ED', ...NWB,
    question: ['Fall, ? fx {side} knee', 'Twisting fall, knee pain ? fx'],
    history: 'PMH bilat knee OA (on the TKA wait list), HTN, DM2. Missed the last 2 steps, twisting fall onto {side} '
      + 'knee. New tense effusion, TTP lateral joint line/tibial plateau, unable to weight-bear. Pain much worse '
      + 'than the usual arthritic pain.',
    meds: ['metformin 1000 mg PO BID', 'ramipril 10 mg PO daily', 'acetaminophen 1 g PO TID'],
    pathology: [{ id: 'tibialPlateauFx', p: 0.35 }],
    findings: { positive: 'Depressed lateral tibial plateau fracture with a fat-fluid level on the cross-table lateral.',
      negative: 'No fracture. Joint effusion.' } },
  { id: 'knee-lump', lines: ['knee-pathology'], age: [17, 35], sex: 'any',
    setting: 'outpatient', referrer: 'family medicine', priority: 'Routine',
    question: ['Lump {side} knee ? osteochondroma', 'Bony lump distal femur'],
    history: 'Painless hard lump medial {side} distal thigh just above the knee, noticed {months} mo ago, unchanged in '
      + 'size. Mild irritation with running. Full ROM, no effusion. No night pain, no constitutional sx.',
    findings: { negative: 'No bone lesion seen. Normal knee.' } },
  { id: 'knee-oa', lines: ['knee-arthritis'], age: [50, 85], sex: 'any',
    setting: 'outpatient', referrer: { outpatient: { 'family medicine': 3, orthopaedics: 1 } }, priority: 'Routine',
    question: ['? OA {side} knee', 'Knee OA - assess severity', 'Chronic knee pain ? OA, for ortho referral'],
    history: 'Progressive {side} knee pain x {years} y, worse on stairs and after walking > 15 min, AM stiffness '
      + '< 30 min. Crepitus, varus alignment, small effusion, medial joint-line TTP. BMI ~33. Partial relief with '
      + 'acetaminophen and naproxen.',
    meds: ['acetaminophen 1 g PO TID', 'naproxen 500 mg PO BID PRN', 'pantoprazole 40 mg PO daily'],
    pathology: [{ id: 'kneeOA', p: 0.85 }],
    findings: { positive: 'Medial compartment joint-space narrowing with osteophytes and subchondral sclerosis, best seen weight-bearing.',
      negative: 'Joint spaces preserved; no significant OA.' } },
  { id: 'knee-rosenberg', lines: ['knee-rosenberg'], age: [35, 65], sex: 'any',
    setting: 'outpatient', referrer: { outpatient: { 'sports medicine': 2, orthopaedics: 1 } }, priority: 'Routine',
    question: ['? early medial compartment OA', 'Knee pain post partial meniscectomy'],
    request: { 'Rosenberg view requested': 2, 'Please add a PA flexion (Rosenberg) view': 1 },
    history: 'Partial medial meniscectomy {side} knee {years} y ago. Now recurrent medial joint-line pain and '
      + 'effusions with running. Previous films at an outside clinic reported as normal. ? early cartilage loss.',
    pathology: [{ id: 'kneeOA', p: 0.5 }],
    findings: { positive: 'Medial joint-space narrowing, most obvious on the flexed PA view, with small osteophytes.',
      negative: 'Joint spaces preserved on all views.' } },
  { id: 'knee-tunnel', lines: ['knee-rosenberg'], age: [17, 40], sex: 'any',
    setting: 'outpatient', referrer: 'orthopaedics', priority: 'Routine',
    question: ['? OCD lesion / loose body {side} knee', 'Knee catching ? loose body'],
    request: { 'Tunnel view please': 2, 'Incl. intercondylar notch view': 1 },
    history: 'Activity-related {side} knee pain and intermittent catching x {months} mo. TTP medial femoral condyle '
      + 'with the knee flexed, Wilson test +. Small effusion. No single injury recalled.',
    findings: { negative: 'No osteochondral defect or loose body seen.' } },
  { id: 'knee-peds', lines: ['knee-peds'], age: [8, 15], sex: 'any', ...PED,
    question: ['? # {side} knee', 'Twisting injury, knee effusion'],
    history: 'Twisted {side} knee pivoting in soccer {hours} h ago, felt a pop. Rapid swelling, effusion, limping, TTP '
      + 'medial joint line and distal femoral physis. Ligaments difficult to assess due to guarding.',
    findings: { negative: 'No fracture. Distal femoral and proximal tibial physes normal; joint effusion.' } },
  { id: 'femur-mvc', lines: ['femur-routine'], age: [18, 50], sex: { M: 3, F: 1 }, setting: 'ED', referrer: 'ED',
    priority: 'STAT', mobility: 'stretcher',
    question: ['? # {side} femur', 'High-energy MVC, thigh injury'],
    history: 'Motorcyclist vs car, ~60 km/h. {Side} thigh painful and swollen, unable to move the leg, in a traction '
      + 'splint from EMS. GCS 15, HD stable after 1 L crystalloid. Distal pulses present. Pelvis stable on exam.',
    pathology: [{ id: 'femurShaftFx', p: 0.7 }],
    findings: { positive: 'Mid-shaft femoral fracture with overriding fragments.',
      negative: 'No fracture. Soft-tissue swelling of the thigh.' } },

  // ---- hip, pelvis, sacrum
  { id: 'hip-nof', lines: ['hip-trauma'], age: [65, 95], sex: { F: 2, M: 1 }, setting: 'ED', referrer: 'ED',
    mobility: 'stretcher',
    question: ['? # NOF', '? fx {side} hip', 'Fall, unable to weight-bear ? hip fx'],
    history: 'Mechanical fall at home (lives alone), found on the floor by a neighbour after ~{hours} h. {Side} leg held '
      + 'in slight external rotation, pain on log-roll, unable to weight-bear. PMH HTN, mild dementia.',
    meds: ['ASA 81 mg PO daily', 'perindopril 4 mg PO daily', 'donepezil 10 mg PO daily'],
    pathology: [{ id: 'femoralNeckFx', p: 0.65 }],
    findings: { positive: 'Displaced subcapital fracture of the femoral neck.', negative: 'No fracture. Hip joint normal.' } },
  { id: 'hip-oa-fall', lines: ['hip-trauma'], age: [60, 90], sex: 'any', setting: 'ED', referrer: 'ED',
    mobility: { stretcher: 3, wheelchair: 1 },
    question: ['Fall, ? # {side} hip', 'Hip pain post fall ? fx'],
    history: 'Known {side} hip OA, on the wait list for THA, walks with a cane. Slipped on a wet floor, landed on the '
      + '{side} side. Now unable to weight-bear, pain much worse than usual, groin pain on any rotation.',
    meds: ['acetaminophen 1 g PO QID', 'celecoxib 200 mg PO daily'],
    pathology: [{ id: 'femoralNeckFx', p: 0.45 }],
    findings: { positive: 'Fracture of the femoral neck.', negative: 'No fracture.' } },
  { id: 'hip-oa', lines: ['hip-pathology'], age: [45, 80], sex: 'any',
    setting: 'outpatient', referrer: 'family medicine', priority: 'Routine',
    question: ['{Side} hip pain ? OA', 'Groin pain x {months} mo'],
    history: '{Side} groin pain x {months} mo, worse walking and getting out of a car. AM stiffness ~15 min. IR '
      + 'painful and limited at 90° flexion; difficulty putting on socks. Lumbar spine non-tender.',
    findings: { negative: 'Hip joint space preserved. No fracture or lesion.' } },
  { id: 'hip-scfe', lines: ['hip-pathology'], age: [10, 14], sex: { M: 2, F: 1 },
    setting: 'outpatient', referrer: { outpatient: { 'family medicine': 2, paediatrics: 1 } }, priority: 'Urgent',
    question: ['{Side} knee pain and limp', 'Limp x {weeks} wk, no trauma'],
    history: 'Pt is {age} y, BMI > 95th percentile. Limp and vague {side} knee/thigh pain x {weeks} wk, no trauma. Knee '
      + 'exam normal. Loss of IR of the {side} hip; the leg externally rotates on hip flexion.',
    findings: { negative: 'Normal hip: no slip of the capital femoral epiphysis.' } },
  { id: 'hip-tha-postop', lines: ['hip-hardware'], age: [50, 85], sex: 'any',
    setting: 'outpatient', referrer: 'orthopaedics', priority: 'Routine', vars: { weeks: [6, 7] },
    question: ['6/52 post-op {side} THA', 'Post-op THA f/u'],
    history: 'Primary {side} THA (uncemented, posterior approach) {dateWeeksAgo} for OA. Uneventful recovery, walking '
      + 'with a cane, wound healed. Routine 6 wk post-op review.',
    pathology: [{ id: 'hipArthroplasty', p: 1 }],
    findings: { positive: 'Total hip arthroplasty in satisfactory position; no lucency, fracture or dislocation.' } },
  { id: 'pelvis-hip', lines: ['pelvis-routine'], age: [45, 80], sex: 'any', names: { 'pelvis-routine': 'XR PELVIS AND HIP' },
    setting: 'outpatient', referrer: { outpatient: { orthopaedics: 2, rheumatology: 1 } }, priority: 'Routine',
    question: ['{Side} hip pain ? AVN', 'Hip/groin pain ? OA ? AVN'],
    history: 'Deep {side} groin and buttock pain x {months} mo, now limping. Long-term prednisone for polymyalgia '
      + 'rheumatica. Painful restricted IR. No trauma.',
    meds: ['prednisone 7.5 mg PO daily', 'calcium carbonate 500 mg PO BID', 'vitamin D3 1000 IU PO daily'],
    findings: { negative: 'Pelvis and hip normal; femoral head contour preserved.' } },
  { id: 'pelvis-rami', lines: ['pelvis-only'], age: [70, 95], sex: { F: 3, M: 1 }, setting: 'ED', referrer: 'ED',
    mobility: { stretcher: 2, wheelchair: 1 },
    question: ['? pubic rami fx', 'Fall ? # pelvis'],
    history: 'Fall from standing at a retirement residence, landed on the buttocks. Groin and pubic pain, able to '
      + 'weight-bear with a walker but painful. Log-roll of both hips painless, full hip ROM; TTP over the {side} '
      + 'pubic rami. PMH osteoporosis, CKD 3.',
    meds: [...OSTEO_MEDS, 'amlodipine 5 mg PO daily'],
    pathology: [{ id: 'pubicRamiFx', p: 0.5 }],
    findings: { positive: 'Undisplaced fractures of the {side} superior and inferior pubic rami.',
      negative: 'No pelvic fracture.' } },
  { id: 'pelvis-judet', lines: ['pelvis-judet'], age: [20, 70], sex: 'any',
    setting: { ED: 1, inpatient: 1 }, referrer: 'orthopaedics', priority: 'Urgent', mobility: 'stretcher',
    question: ['? acetabular fx', '? {side} acetabular fx - characterise'],
    request: { 'Judet views please': 2, '': 1 },
    history: 'Dashboard injury, driver in a frontal MVC. {Side} hip pain. AP pelvis in the trauma bay: ? break in the '
      + '{side} ilioischial line. Sciatic nerve function intact. Ortho trauma planning.',
    pathology: [{ id: 'acetabularFx', p: 0.6 }],
    findings: { positive: 'Fracture of the {side} acetabulum involving the posterior column.',
      negative: 'No acetabular fracture; iliopectineal and ilioischial lines intact.' } },
  { id: 'pelvis-ring', lines: ['pelvis-inletoutlet'], age: [18, 70], sex: 'any',
    setting: { ED: 1, inpatient: 1 }, referrer: 'orthopaedics', priority: 'Urgent', mobility: 'stretcher',
    question: ['Pelvic ring injury - characterise', '? pelvic ring disruption'],
    request: { 'Inlet/outlet views': 2, '': 1 },
    history: 'Crush injury: pinned by a forklift against a wall. Pubic and {side} SI tenderness. AP pelvis in the trauma '
      + 'bay: ? {side} superior ramus fx. Pelvic binder on. Ortho to assess ring stability.',
    pathology: [{ id: 'pubicRamiFx', p: 0.6 }],
    findings: { positive: 'Fractures of the {side} superior and inferior pubic rami; ring otherwise intact.',
      negative: 'No fracture; pelvic ring intact.' } },
  { id: 'sacrum-coccyx', lines: ['sacrum-routine'], age: [20, 75], sex: 'any',
    setting: 'outpatient', referrer: { outpatient: { 'family medicine': 2, 'walk-in': 1 } }, priority: 'Routine', vars: { days: [2, 10] },
    question: ['? # coccyx', 'Tailbone pain post fall'],
    history: 'Slipped on ice {days} d ago, landed hard on the buttocks. Pain over the coccyx, worse sitting and rising '
      + 'from a chair. Point TTP over the coccyx. No neuro sx, bladder and bowel normal.',
    pathology: [{ id: 'coccyxFx', p: 0.3 }],
    findings: { positive: 'Fracture of the coccyx with anterior angulation.',
      negative: 'No fracture of the sacrum or coccyx.' } },
  { id: 'si-sacroiliitis', lines: ['si-routine'], age: [18, 40], sex: 'any',
    setting: 'outpatient', referrer: 'rheumatology', priority: 'Routine',
    question: ['? sacroiliitis', 'Inflammatory back pain, ? axial SpA'],
    history: 'Low back and alternating buttock pain x {months} mo, onset before 40, AM stiffness > 1 h, better with '
      + 'exercise, wakes in the second half of the night. HLA-B27 +, CRP mildly elevated. Hx anterior uveitis.',
    meds: ['naproxen 500 mg PO BID'],
    findings: { negative: 'SI joints normal: no erosion, sclerosis or widening.' } },

  // ---- spine
  { id: 'lspine-osteo', lines: ['lspine-routine'], age: [60, 92], sex: { F: 3, M: 1 }, vars: { days: [1, 6] },
    setting: { ED: 1, outpatient: 1 }, referrer: { ED: 'ED', outpatient: 'family medicine' },
    question: ['? compression fx', 'Acute back pain ? vertebral #'],
    history: 'Sudden severe low back pain lifting a laundry basket {days} d ago. Point TTP over the thoracolumbar '
      + 'junction (~L1). No leg weakness, no saddle anaesthesia, bladder and bowel normal. Osteoporosis, previous '
      + 'wrist fx. Courses of prednisone for COPD exacerbations.',
    meds: ['tiotropium 18 mcg inhaled daily', 'salbutamol 100 mcg 2 puffs PRN', ...OSTEO_MEDS],
    pathology: [{ id: 'l1CompressionFx', p: 0.55 }],
    findings: { positive: 'Anterior wedge compression fracture of L1.',
      negative: 'No vertebral fracture; alignment normal.' } },
  { id: 'tspine-fall', lines: ['tspine-routine'], age: [30, 75], sex: 'any', setting: 'ED', referrer: 'ED',
    mobility: { stretcher: 2, wheelchair: 1 },
    question: ['? # T-spine', 'Fall, mid-back pain'],
    history: 'Fell ~2 m off a ladder onto the back. Midline TTP mid thoracic spine (T6-T9). Neuro intact, no chest pain '
      + 'or SOB. C-spine cleared clinically (Canadian C-spine rule), L-spine non-tender.',
    findings: { negative: 'No fracture; thoracic alignment normal.' } },
  { id: 'tspine-c7t1', lines: ['tspine-c7t1'], age: [20, 70], sex: 'any', setting: 'ED', referrer: 'ED',
    mobility: 'stretcher',
    question: ['? fx C7-T1', 'Cervicothoracic junction pain post fall', 'T-spine ? fx: C7-T1 not seen on C-spine series'],
    history: 'Fell down a flight of stairs {hours} h ago. Midline TTP at the cervicothoracic junction (C7-T2), upper '
      + 'C-spine non-tender. C-spine films earlier this shift: C1-C6 normal, C7-T1 not demonstrated. Neuro intact '
      + 'all limbs.',
    findings: { negative: 'No fracture; cervicothoracic junction aligned.' } },
  { id: 'cspine-mvc', lines: ['cspine-trauma'], age: [18, 64], sex: 'any', setting: 'ED', referrer: 'ED',
    mobility: 'stretcher',
    question: ['? # C-spine', 'MVC, neck pain'],
    history: 'Restrained driver, rear-ended at highway speed. Midline neck TTP C5-C7, unable to rotate 45° to either '
      + 'side. Neuro intact. In a c-collar from EMS. Canadian C-spine rule: imaging indicated.',
    pathology: [{ id: 'c6SpinousFx', p: 0.15 }],
    findings: { positive: 'Avulsion fracture of the C6 spinous process; alignment maintained.',
      negative: 'No fracture; alignment and prevertebral soft tissue normal.' } },
  { id: 'cspine-elderly', lines: ['cspine-trauma'], age: [70, 92], sex: 'any', setting: 'ED', referrer: 'ED',
    mobility: 'stretcher',
    question: ['Fall, neck pain ? fx', '? # C-spine, age > 65'],
    history: 'Fall from standing, struck forehead on the floor. Neck pain, midline TTP lower C-spine. PMH cervical '
      + 'spondylosis with chronic neck stiffness, OA of the hands, AF on warfarin (INR pending). Neuro grossly intact.',
    meds: ['warfarin 5 mg PO daily', 'bisoprolol 5 mg PO daily', 'acetaminophen 650 mg PO PRN'],
    pathology: [
      { id: 'c6SpinousFx', p: 0.1, positive: 'Fracture of the C6 spinous process on a background of degenerative change.' },
      { id: 'cspineOA', p: 0.5, positive: 'Multilevel degenerative disc disease and osteophytes; no fracture.' }],
    findings: { negative: 'No fracture; alignment and prevertebral soft tissue normal.' } },
  { id: 'cspine-preop-ra', lines: ['cspine-preop'], age: [45, 80], sex: { F: 3, M: 1 },
    setting: 'outpatient', referrer: 'pre-op clinic', priority: 'Routine', vars: { weeks: [2, 5] },
    question: ['Pre-op: RA, ? atlantoaxial instability', 'Pre-GA C-spine assessment, RA'],
    request: { '': 2, 'Lateral flexion view please': 1 },
    history: 'Long-standing RA x {years} y on MTX and prednisone. Booked for elective {side} TKA under GA in {weeks} wk. '
      + 'Occasional occipital headache, no neuro sx. Anaesthesia requests C-spine assessment before intubation.',
    meds: [...RA_MEDS, 'prednisone 5 mg PO daily'],
    findings: { negative: 'Atlanto-dens interval normal in flexion.' } },
  { id: 'cspine-radic', lines: ['cspine-routine'], age: [45, 85], sex: 'any',
    setting: 'outpatient', referrer: { outpatient: { 'family medicine': 3, 'spine surgery': 1 } }, priority: 'Routine',
    question: ['Neck pain radiating to {side} arm', '? C-spine spondylosis / foraminal narrowing'],
    history: 'Neck pain x {months} mo with intermittent paraesthesia down the {side} arm into the thumb and index '
      + 'finger. Spurling + on the {side}. Reflexes symmetric, strength 5/5. No trauma, no myelopathic sx.',
    pathology: [{ id: 'cspineOA', p: 0.75 }],
    findings: { positive: 'Degenerative disc disease C5-C7 with uncovertebral osteophytes narrowing the foramina.',
      negative: 'Normal cervical spine; no foraminal narrowing.' } },

  // ---- soft-tissue neck
  { id: 'stneck-adenoids', lines: ['stneck-adenoids'], age: [2, 8], sex: 'any',
    setting: 'outpatient', referrer: { outpatient: { ENT: 2, paediatrics: 1 } }, priority: 'Routine',
    question: ['? adenoid hypertrophy', 'Snoring, mouth breathing'],
    history: 'Loud nightly snoring with witnessed pauses, mouth breathing, hyponasal speech, recurrent otitis media '
      + '(3 episodes this year). Tonsils 2+. Assessing for adenoidectomy.',
    pathology: [{ id: 'adenoids', p: 0.7 }],
    findings: { positive: 'Enlarged adenoid pad narrowing the nasopharyngeal airway.',
      negative: 'Adenoid pad normal in size; nasopharyngeal airway patent.' } },
  { id: 'stneck-epiglottis', lines: ['stneck-epiglottis'], age: [25, 70], sex: 'any', setting: 'ED', referrer: 'ED',
    priority: 'STAT', vars: { days: [1, 2] }, mobility: { wheelchair: 2, stretcher: 1 },
    question: ['? epiglottitis', 'Severe sore throat, muffled voice'],
    history: 'Severe sore throat x {days} d, odynophagia, unable to swallow saliva, muffled voice. T {temp} °C, HR '
      + '{hr}. Oropharynx near normal on exam, pain out of proportion. No stridor, sitting upright. ENT aware.',
    isolation: { 'Droplet/Contact': 1, None: 1 },
    pathology: [{ id: 'epiglottitis', p: 0.4 }],
    findings: { positive: 'Swollen epiglottis (thumb sign) with thickened aryepiglottic folds.',
      negative: 'Epiglottis and prevertebral soft tissues normal.' } },
  { id: 'stneck-fb', lines: ['stneck-epiglottis'], age: [25, 80], sex: 'any', setting: 'ED', referrer: 'ED',
    question: ['? FB (fish bone)', 'FB sensation throat'],
    history: 'Eating salmon at dinner {hours} h ago, felt something stick in the throat. Persistent sharp sensation on '
      + 'the {side} side when swallowing, able to swallow liquids. No drooling or SOB. Nil seen on oral exam.',
    findings: { negative: 'No radio-opaque foreign body; prevertebral soft tissue normal.' } },

  // ---- abdomen
  { id: 'abdo-sbo', lines: ['abdo-obstruction'], age: [40, 85], sex: 'any', setting: 'ED', referrer: 'ED',
    vars: { days: [1, 3] }, mobility: 'stretcher',
    question: ['? SBO', '? bowel obstruction', 'Vomiting, distension ? obstruction'],
    history: 'Colicky central abdo pain x {days} d, bilious vomiting x 8 today, increasing distension, no flatus or BM '
      + 'x 2 d. Previous laparotomy (bowel resection). Abdo distended and tympanic, high-pitched BS. Afebrile. NG '
      + 'tube pending.',
    pathology: [{ id: 'sbo', p: 0.55 }],
    findings: { positive: 'Dilated small-bowel loops with multiple air-fluid levels on the upright film; little colonic gas.',
      negative: 'Normal bowel gas pattern; no air-fluid levels.' } },
  { id: 'abdo-stone', lines: ['abdo-kub'], age: [25, 65], sex: 'any', setting: 'ED', referrer: 'ED',
    question: ['? ureteric stone {side}', '? renal colic'],
    history: 'Sudden severe {side} flank pain radiating to the groin, unable to settle, vomiting x 2. Urinalysis: '
      + 'microscopic haematuria. Afebrile. Previous stone {years} y ago, passed spontaneously.',
    pathology: [{ id: 'kidneyStone', p: 0.5 }],
    findings: { positive: 'Calcific density projected over the {side} renal outline.',
      negative: 'No urinary tract calculus seen.' } },
  { id: 'abdo-stone-fu', lines: ['abdo-kub'], age: [30, 70], sex: 'any',
    setting: 'outpatient', referrer: 'urology', priority: 'Routine', vars: { months: [2, 6] },
    question: ['F/u known {side} renal calculus', 'KUB: stone surveillance'],
    history: 'Known {side} renal calculus, ~6 mm lower pole, on CT {dateMonthsAgo}. Asymptomatic since. On potassium '
      + 'citrate. KUB to monitor size and position.',
    meds: ['potassium citrate 1080 mg PO TID'],
    pathology: [{ id: 'kidneyStone', p: 0.85 }],
    findings: { positive: 'Calcific density projected over the {side} renal outline, unchanged in position.',
      negative: 'No urinary tract calculus seen.' } },
  { id: 'abdo-constipation-child', lines: ['abdo-kub'], age: [4, 12], sex: 'any',
    setting: 'outpatient', referrer: 'paediatrics', priority: 'Routine',
    question: ['? fecal loading', 'Chronic constipation, abdo pain'],
    history: 'Pt is {age} y with chronic constipation: BM every 5-7 d, large hard stools, soiling. Intermittent '
      + 'periumbilical pain. Stool palpable LLQ. No vomiting, eating well, growth normal. Assessing stool burden.',
    meds: ['PEG 3350 17 g PO daily'],
    pathology: [{ id: 'fecalLoading', p: 0.8 }],
    findings: { positive: 'Large stool burden throughout the colon and rectum.',
      negative: 'Small amount of stool; no fecal loading.' } },
  { id: 'abdo-constipation-inpt', lines: ['abdo-kub'], age: [70, 95], sex: 'any',
    setting: 'inpatient', referrer: 'inpatient medicine', priority: 'Routine', vars: { days: [5, 8] },
    question: ['? constipation / fecal loading', 'Abdo discomfort, no BM x {days} d'],
    history: 'Admitted with delirium. No BM x {days} d, on hydromorphone for hip pain. Abdo soft, mildly distended, '
      + 'non-tender, BS present, passing small amounts of flatus. No vomiting.',
    meds: ['hydromorphone 1 mg PO q4h PRN', 'sennosides 8.6 mg PO HS', 'quetiapine 12.5 mg PO HS PRN'],
    pathology: [{ id: 'fecalLoading', p: 0.75 }],
    findings: { positive: 'Large stool burden in the colon and rectum; no bowel dilatation.',
      negative: 'Normal bowel gas pattern; moderate stool.' } },

  // ---- ribs, chest
  { id: 'ribs-anterior', lines: ['ribs-anterior'], age: [25, 80], sex: 'any', ...EDW,
    question: ['? # {side} anterior ribs', 'Chest wall injury ? rib fx'],
    history: 'Fell against the edge of a kitchen counter, struck the {side} anterior chest. Point TTP anterior {side} '
      + 'ribs 5-7 near the costochondral junction, pain on deep breath. SpO2 98 % RA, AE equal.',
    pathology: [{ id: 'ribFxAnterior', p: 0.35 }],
    findings: { positive: 'Undisplaced fractures of the {side} anterior ribs; no pneumothorax.',
      negative: 'No rib fracture or pneumothorax.' } },
  { id: 'ribs-posterior', lines: ['ribs-posterior'], age: [25, 80], sex: 'any', ...EDW,
    question: ['? # {side} posterior ribs', 'Back/rib pain post fall'],
    history: 'Slipped on ice and fell backwards onto the edge of a step. Pain {side} posterior lower chest, TTP over '
      + 'ribs 8-10 posteriorly, pain on coughing. AE equal, SpO2 97 % RA. Abdo soft, no flank tenderness.',
    pathology: [{ id: 'ribFxPosterior', p: 0.4 }],
    findings: { positive: 'Undisplaced fractures of the {side} posterior lower ribs; no pneumothorax.',
      negative: 'No rib fracture or pneumothorax.' } },
  { id: 'chest-pneumonia', lines: ['chest-routine'], age: [20, 85], sex: 'any',
    setting: { ED: 2, outpatient: 1 }, referrer: { ED: 'ED', outpatient: 'family medicine' }, vars: { days: [3, 7] },
    question: ['? pneumonia', 'Cough, fever ? CAP'],
    history: 'Productive cough x {days} d, fever T {temp} °C, pleuritic {side} chest pain, SOB on exertion. Crackles '
      + 'and bronchial breathing at the {side} base. SpO2 {spo2} % RA, HR {hr}.',
    isolation: { None: 2, 'Droplet/Contact (viral swab pending)': 1 },
    pathology: [{ id: 'pneumonia', p: 0.55 }],
    findings: { positive: 'Consolidation in the {side} lower lobe with air bronchograms.',
      negative: 'Lungs clear. No consolidation or effusion.' } },
  { id: 'chest-effusion', lines: ['chest-routine'], age: [60, 90], sex: 'any',
    setting: 'inpatient', referrer: 'inpatient medicine', priority: { Routine: 1, Urgent: 1 },
    question: ['? effusion', 'SOB, reduced AE {side} base'],
    history: 'Admitted with CHF exacerbation. Increasing SOB, reduced AE and stony dullness at the {side} base. Weight '
      + 'up 3 kg. On IV furosemide. Assess for effusion before ? thoracentesis.',
    meds: ['furosemide 40 mg IV BID', 'bisoprolol 2.5 mg PO daily', 'sacubitril/valsartan 49/51 mg PO BID', 'apixaban 5 mg PO BID'],
    pathology: [{ id: 'effusion', p: 0.6 }],
    findings: { positive: 'Blunted {side} costophrenic angle with a meniscus: pleural effusion.',
      negative: 'No effusion. Costophrenic angles sharp.' } },
  { id: 'chest-ptx', lines: ['chest-ptx'], age: [17, 35], sex: { M: 3, F: 1 }, setting: 'ED', referrer: 'ED',
    priority: { STAT: 1, Urgent: 1 }, vars: { spo2: [93, 98] },
    question: ['r/o PTX', '? pneumothorax', 'Sudden pleuritic chest pain ? PTX'],
    request: { '': 3, 'Insp/exp films': 1 },
    history: 'Tall, thin, smoker. Sudden onset {side} pleuritic chest pain and SOB at rest {hours} h ago. Reduced AE '
      + '{side} apex, HR {hr}, SpO2 {spo2} % RA. No trauma, no previous episodes.',
    pathology: [{ id: 'pneumothorax', p: 0.5 }],
    findings: { positive: '{Side} apical pneumothorax: a pleural line with no lung markings beyond it, clearer on expiration.',
      negative: 'No pneumothorax on inspiration or expiration.' } },
  { id: 'chest-ptx-fu', lines: ['chest-ptx-fu'], age: [18, 40], sex: { M: 3, F: 1 },
    setting: 'outpatient', referrer: { outpatient: { respirology: 2, 'thoracic surgery': 1 } }, priority: 'Routine',
    vars: { days: [7, 14] },
    question: ['F/u {side} PTX', 'Resolving pneumothorax f/u'],
    history: 'Primary spontaneous {side} PTX {dateDaysAgo}, ~2 cm apical, managed conservatively (observation, O2), '
      + 'discharged the next day. Now asymptomatic apart from a mild residual ache. Assess resolution before a '
      + 'return to work and air travel.',
    pathology: [{ id: 'pneumothorax', p: 0.35 }],
    findings: { positive: 'Small residual {side} apical pneumothorax.',
      negative: 'Pneumothorax resolved. Lungs fully expanded.' } },

  // ---- multi-exam requisitions
  { id: 'multi-acute-abdo', lines: ['chest-routine', 'abdo-obstruction'], age: [45, 90], sex: 'any',
    setting: 'ED', referrer: 'ED', priority: { STAT: 1, Urgent: 2 }, vars: { days: [1, 3] }, mobility: 'stretcher',
    question: ['Acute abdo series: ? SBO, r/o free air', '? bowel obstruction / perforation'],
    history: 'Colicky abdo pain x {days} d with distension, repeated vomiting, no flatus or BM x 48 h. Two previous '
      + 'laparotomies (adhesions). Abdo distended, tympanic, diffusely tender, no peritonism. Lactate pending. '
      + 'Surgery consulted.',
    pathology: [{ id: 'sbo', p: 0.55, line: 'abdo-obstruction' }],
    findings: { positive: 'Dilated small-bowel loops with air-fluid levels; no free air under the diaphragm.',
      negative: 'Normal bowel gas pattern; no free air under the diaphragm.' } },
  { id: 'multi-foosh', lines: ['wrist-trauma', 'elbow-routine'], age: [20, 70], sex: 'any', ...EDW,
    question: ['FOOSH ? fx wrist/elbow', 'Fall on outstretched hand: wrist and elbow pain'],
    history: 'Fell off a bicycle onto outstretched {side} hand {hours} h ago. Swelling and TTP distal radius; also '
      + 'pain and swelling at the elbow, ROM 40-110°. Snuffbox non-tender. NV intact.',
    pathology: [
      { id: 'distalRadiusFx', p: 0.45, line: 'wrist-trauma', positive: 'Distal radius fracture with dorsal angulation; elbow normal.' },
      { id: 'radialHeadFx', p: 0.15, line: 'elbow-routine', positive: 'Undisplaced radial head fracture with elevated fat pads; wrist normal.' }],
    findings: { negative: 'No fracture of the wrist or elbow.' } },
  { id: 'multi-forearm-child', lines: ['forearm-routine', 'wrist-trauma', 'elbow-routine'], age: [6, 12], sex: 'any', ...PED,
    question: ['? # forearm, ? Monteggia/Galeazzi', 'Forearm deformity: forearm, wrist and elbow please'],
    history: 'Fell ~2 m from a tree house onto outstretched {side} arm. Angulated mid forearm, swelling extends to the '
      + 'elbow, painful wrist. Radial pulse present, median/ulnar/radial sensation intact. IN fentanyl at triage.',
    pathology: [{ id: 'forearmShaftFx', p: 0.65, line: 'forearm-routine' }],
    findings: { positive: 'Angulated mid-shaft forearm fracture; wrist and elbow congruent.',
      negative: 'No fracture. Wrist and elbow congruent.' } },
  { id: 'multi-sacrum-si', lines: ['sacrum-routine', 'si-routine'], age: [25, 80], sex: 'any',
    setting: { ED: 1, outpatient: 1 }, referrer: { ED: 'ED', outpatient: 'family medicine' }, vars: { days: [1, 7] },
    question: ['Fall onto buttocks ? sacral/coccyx fx, SI pain', '? # sacrum/coccyx and SI joints'],
    history: 'Fell down 5 stairs landing on the buttocks {days} d ago. Pain over the sacrum and coccyx, also {side} '
      + 'SI/buttock pain when walking. TTP sacrum, coccyx and {side} SI joint. No neuro deficit, no saddle '
      + 'anaesthesia.',
    pathology: [{ id: 'coccyxFx', p: 0.3, line: 'sacrum-routine' }],
    findings: { positive: 'Fracture of the coccyx; SI joints normal.', negative: 'No fracture. SI joints normal.' } },
  { id: 'multi-ankle-leg', lines: ['ankle-routine', 'leg-routine'], age: [18, 60], sex: 'any', setting: 'ED', referrer: 'ED', ...NWB,
    question: ['? # ankle, ? proximal fibula', 'Ankle injury with proximal leg pain ? Maisonneuve'],
    history: 'External-rotation injury {side} ankle playing rugby {hours} h ago. Swelling medial ankle, TTP medial '
      + 'malleolus/deltoid AND proximal fibula below the knee. Unable to weight-bear. Knee itself non-tender, no '
      + 'effusion.',
    pathology: [{ id: 'weberBFx', p: 0.3, line: 'ankle-routine' }],
    findings: { positive: 'Distal fibular fracture; proximal fibula intact.',
      negative: 'No fracture of the ankle or fibula. Mortise congruent.' } },
  { id: 'multi-c-t-spine', lines: ['cspine-trauma', 'tspine-routine'], age: [18, 65], sex: 'any', setting: 'ED', referrer: 'ED',
    priority: 'STAT', mobility: 'stretcher',
    question: ['C- and T-spine ? fx', 'Fall from horse: neck and mid-back pain'],
    history: 'Thrown from a horse, landed on the back. Midline TTP C5-C7 and T5-T8. GCS 15, moving all limbs, no '
      + 'sensory level. Spine precautions and c-collar from EMS.',
    pathology: [{ id: 'c6SpinousFx', p: 0.15, line: 'cspine-trauma' }],
    findings: { positive: 'Fracture of the C6 spinous process; thoracic spine normal.',
      negative: 'No fracture of the cervical or thoracic spine.' } },
  { id: 'multi-c-spine-c7t1', lines: ['cspine-trauma', 'tspine-c7t1'], age: [20, 70], sex: 'any', setting: 'ED', referrer: 'ED',
    priority: 'STAT', mobility: 'stretcher',
    question: ['C- and T-spine ? fx; C7-T1 not seen on CT scout', 'Trauma: C/T-spine, pls ensure C7-T1 seen'],
    history: 'Fell ~3 m from scaffolding. Midline TTP lower neck and upper thoracic spine. CT head negative; C7-T1 not '
      + 'seen on the CT scout. Broad, muscular shoulders. Neuro intact.',
    pathology: [{ id: 'c6SpinousFx', p: 0.2, line: 'cspine-trauma' }],
    findings: { positive: 'Fracture of the C6 spinous process; C7-T1 aligned.',
      negative: 'No fracture; cervicothoracic junction aligned.' } },
  { id: 'multi-ribs-ptx', lines: ['ribs-posterior', 'chest-ptx'], age: [25, 80], sex: 'any', setting: 'ED', referrer: 'ED',
    vars: { spo2: [92, 97] },
    question: ['? # {side} ribs, r/o PTX', 'Rib injury ? pneumothorax'],
    history: 'Fell ~2 m from a ladder onto the {side} side, back striking a railing. TTP {side} posterior ribs 7-10, '
      + 'pain on breathing. SpO2 {spo2} % RA, slightly reduced AE {side} base. No haemoptysis.',
    pathology: [
      { id: 'ribFxPosterior', p: 0.4, line: 'ribs-posterior', positive: 'Fractures of the {side} posterior ribs; no pneumothorax.' },
      { id: 'pneumothorax', p: 0.15, line: 'chest-ptx', positive: '{Side} pneumothorax, clearer on expiration; no displaced rib fracture.' }],
    findings: { negative: 'No rib fracture or pneumothorax.' } },
  { id: 'multi-ribs-chest', lines: ['ribs-anterior', 'chest-routine'], age: [55, 90], sex: 'any',
    setting: { ED: 2, outpatient: 1 }, referrer: { ED: 'ED', outpatient: 'family medicine' }, vars: { days: [2, 5] },
    question: ['? # {side} anterior ribs, ? pneumonia', 'Chest wall pain post fall + cough'],
    history: 'Fell against the edge of the bathtub {days} d ago, {side} anterior chest wall pain since. Now also '
      + 'productive cough and fever T {temp} °C. Point TTP {side} anterior ribs 4-6; crackles at the {side} base, '
      + 'SpO2 {spo2} % RA.',
    pathology: [
      { id: 'ribFxAnterior', p: 0.3, line: 'ribs-anterior', positive: 'Undisplaced {side} anterior rib fractures; lungs clear.' },
      { id: 'pneumonia', p: 0.3, line: 'chest-routine', positive: 'Consolidation at the {side} base; no rib fracture seen.' }],
    findings: { negative: 'No rib fracture, consolidation or pneumothorax.' } },
  { id: 'multi-ra-hand-ankle', lines: ['hand-ra', 'ankle-ra'], age: [35, 75], sex: { F: 3, M: 1 },
    setting: 'outpatient', referrer: 'rheumatology', priority: 'Routine',
    question: ['RA: hand and ankle - erosions?', 'RA follow-up imaging'],
    history: 'RA x {years} y (RF+, anti-CCP+). Persistent synovitis of the {side} MCPs and {side} ankle despite MTX. '
      + 'Stepping up to a biologic; baseline films for erosion scoring.',
    meds: RA_MEDS,
    pathology: [{ id: 'raHand', p: 0.75, line: 'hand-ra' }],
    findings: { positive: 'Marginal erosions and joint-space narrowing at the MCP joints; ankle without erosions.',
      negative: 'No erosions in the hand or ankle.' } },
  { id: 'multi-preop-ra', lines: ['cspine-preop', 'chest-routine'], age: [50, 80], sex: { F: 3, M: 1 },
    setting: 'outpatient', referrer: 'pre-op clinic', priority: 'Routine', vars: { weeks: [2, 4] },
    question: ['Pre-op (GA): RA, ? AAI; baseline CXR', 'Pre-admission: C-spine and chest'],
    history: 'RA x {years} y on MTX and prednisone; ex-smoker. Booked for elective {side} THA under GA in {weeks} wk. '
      + 'No neck pain or neuro sx, no cough. Anaesthesia requests C-spine and chest films.',
    meds: [...RA_MEDS, 'prednisone 5 mg PO daily'],
    findings: { negative: 'Atlanto-dens interval normal in flexion. Lungs clear.' } },
  { id: 'multi-knee-hip', lines: ['knee-arthritis', 'hip-pathology'], age: [55, 85], sex: 'any',
    setting: 'outpatient', referrer: 'orthopaedics', priority: 'Routine',
    question: ['{Side} knee pain - ? OA knee vs referred hip pain', 'Knee and hip pain ? OA'],
    history: '{Side} knee pain x {years} y, worse walking, now also groin pain and a limp. Knee: crepitus, medial '
      + 'joint-line TTP, small effusion. Hip: IR painful and limited. ? knee OA vs pain referred from the hip.',
    meds: ['acetaminophen 1 g PO TID', 'diclofenac 2.32 % gel topical QID'],
    pathology: [{ id: 'kneeOA', p: 0.7, line: 'knee-arthritis' }],
    findings: { positive: 'Medial compartment knee OA on the weight-bearing films; hip joint space preserved.',
      negative: 'Knee and hip joint spaces preserved.' } },
  { id: 'multi-shoulder-humerus', lines: ['shoulder-trauma', 'humerus-routine'], age: [55, 90], sex: 'any',
    setting: 'ED', referrer: 'ED', mobility: { wheelchair: 2, stretcher: 1 },
    question: ['Fall: {side} shoulder and upper arm ? fx', '? # proximal humerus/shaft'],
    history: 'Fell on stairs onto the {side} arm. Extensive bruising of the proximal and mid upper arm, unable to lift, '
      + 'pain along the humeral shaft. Radial nerve intact. PMH osteoporosis on denosumab.',
    meds: ['denosumab 60 mg SC q6mo', 'calcium carbonate 500 mg PO BID', 'vitamin D3 1000 IU PO daily'],
    pathology: [
      { id: 'humerusNeckFx', p: 0.4, line: 'shoulder-trauma', positive: 'Fracture of the surgical neck of the humerus; shaft intact.' },
      { id: 'humerusShaftFx', p: 0.15, line: 'humerus-routine', positive: 'Humeral shaft fracture; shoulder joint normal.' }],
    findings: { negative: 'No fracture or dislocation.' } },
  { id: 'multi-foot-ankle', lines: ['foot-routine', 'ankle-routine'], age: [17, 60], sex: 'any', ...EDW, ...NWB,
    question: ['Inversion injury ? # ankle/foot', 'Ankle and foot injury, Ottawa +'],
    history: 'Inversion injury {side} ankle stepping into a pothole {hours} h ago. TTP posterior edge of lateral '
      + 'malleolus and base of 5th MT. Unable to weight-bear 4 steps. Navicular non-tender.',
    pathology: [
      { id: 'weberBFx', p: 0.25, line: 'ankle-routine', positive: 'Weber B fracture of the distal fibula; foot normal.' },
      { id: 'mt5BaseFx', p: 0.25, line: 'foot-routine', positive: 'Fracture at the base of the 5th metatarsal; ankle normal.' }],
    findings: { negative: 'No fracture of the ankle or foot.' } },
  { id: 'multi-lspine-si', lines: ['lspine-routine', 'si-routine'], age: [20, 40], sex: 'any',
    setting: 'outpatient', referrer: 'rheumatology', priority: 'Routine',
    question: ['? axial SpA: L-spine and SI joints', 'Inflammatory back pain'],
    history: 'Low back pain and stiffness x {months} mo, AM stiffness > 1 h and after rest, better with activity and '
      + 'NSAIDs. Reduced lumbar flexion (modified Schober 3 cm). HLA-B27 +. Psoriasis.',
    meds: ['naproxen 500 mg PO BID', 'calcipotriol/betamethasone ointment'],
    findings: { negative: 'SI joints and lumbar spine normal.' } },
];

export const caseById = (id) => CASES.find((c) => c.id === id) || null;
