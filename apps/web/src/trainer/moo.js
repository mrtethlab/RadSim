/* ============================================================================
   METHOD OF OPERATION — the routine the Order of Operations Trainer drills.

   Each step (and sub-step) carries its own wording and the CONCEPTS an answer must name: a list
   of groups, each a set of words any one of which counts (core/mooQuiz.js matches them, forgiving
   a slip of the keyboard but not a missing idea). `blanks` are the terms worth hiding for a
   fill-in-the-blank; `id`s are stable (the trainer's progress is kept by them).
   ============================================================================ */

export const MOO_TITLE = 'Method of Operation';

const s = (id, text, concepts, blanks = [], subs = []) => ({ id, text, concepts, blanks, subs });

export const MOO = [
  s('1', 'Acquire Req – Electronic Order',
    [['acquire', 'get', 'obtain', 'pull', 'receive', 'grab'], ['req', 'requisition', 'order']],
    ['Electronic Order']),
  s('2', 'Check pt hx and order (if f/u ask for previous)',
    [['check', 'review', 'read', 'verify'], ['hx', 'history'], ['order', 'req', 'requisition'], ['previous', 'prior', 'old', 'f/u', 'follow up', 'followup']],
    ['hx', 'ask for previous']),
  s('3', 'Pull up patient on console, select first view, select technique',
    [['console', 'computer', 'workstation'], ['patient', 'pt'], ['first view', 'view', 'projection'], ['technique', 'kvp', 'mas', 'exposure factors']],
    ['first view', 'technique']),
  s('4', 'Setup Room', [['setup', 'set up', 'prepare', 'prep'], ['room']], [], [
    s('4a', 'Table: sheet, sponges, lead – tube detent but not over table',
      [['table'], ['sheet'], ['sponge'], ['lead', 'shield'], ['detent'], ['not over', 'off the table', 'away from the table', 'not above', 'not on top']],
      ['sheet, sponges, lead', 'detent', 'not over table']),
    s('4b', 'Wall: detent tube, lead',
      [['wall', 'bucky', 'upright', 'chest stand'], ['detent'], ['lead', 'shield']],
      ['detent tube', 'lead']),
    s('4c', 'Set pre-collimation',
      [['pre-collimation', 'precollimation', 'pre collimation', 'pre-collimate', 'precollimate', 'pre collimate']],
      ['pre-collimation']),
  ]),
  s('5', 'Call patient (First and Last name always)',
    [['call'], ['patient', 'pt'], ['first'], ['last']],
    ['First and Last name']),
  s('6', 'Welcome patient into room', [['welcome', 'greet', 'bring', 'invite'], ['room', 'in']], [], [
    s('6a', 'Show where to set things – observe for artifacts',
      [['show', 'where'], ['things', 'belongings', 'items', 'stuff'], ['observe', 'watch', 'look', 'check'], ['artifact']],
      ['observe for artifacts']),
    s('6b', 'Introduce yourself – Slow down!',
      [['introduce'], ['slow']],
      ['Slow down']),
    s('6c', 'Confirm two identifiers – LMP',
      [['confirm', 'verify', 'check'], ['two', '2'], ['identifier', 'id'], ['lmp', 'menstrual', 'pregnan']],
      ['two identifiers', 'LMP']),
    s('6d', 'Confirm body part – ask questions to tell you hx',
      [['confirm', 'verify', 'check'], ['body part', 'part', 'side', 'anatomy'], ['question', 'ask'], ['hx', 'history']],
      ['body part', 'tell you hx']),
    s('6e', 'Collect specific info not on order',
      [['collect', 'gather', 'get', 'ask'], ['info', 'information', 'details'], ['not on', 'missing']],
      ['not on order']),
    s('6f', 'Set the patient expectation (general positions, hold still)',
      [['expect'], ['position'], ['hold still', 'still']],
      ['expectation', 'hold still']),
  ]),
  s('7', 'Tube to IR', [['tube'], ['ir', 'receptor', 'detector', 'plate', 'bucky']], ['IR'], [
    s('7a', 'Once aligned for table, raise table to working height, pull pt straight',
      [['raise', 'lift', 'height'], ['working'], ['straight']],
      ['working height', 'pull pt straight']),
    s('7b', 'Place lead if appropriate',
      [['lead', 'shield'], ['appropriate', 'if needed', 'if required', 'where needed']],
      ['lead']),
    s('7c', 'Align wireless IR w/ midline of anatomy',
      [['align', 'centre', 'center', 'line up'], ['wireless', 'ir', 'detector', 'plate'], ['midline']],
      ['wireless IR', 'midline']),
  ]),
  s('8', 'Position and collimate', [['position'], ['collimat']], [], [
    s('8a', 'ONCE – position once, centre once, collimate once',
      [['once'], ['position'], ['centre', 'center'], ['collimat']],
      ['ONCE']),
    s('8b', '3 second check',
      [['3', 'three'], ['second', 'sec'], ['check']],
      ['3 second']),
  ]),
  s('9', 'Breathing instructions – always watching patient from console',
    [['breath'], ['watch', 'observe', 'eye', 'look'], ['console']],
    ['Breathing instructions', 'watching patient']),
  s('10', '3 second check – CR, position, collimation (all anatomy included)',
    [['3', 'three'], ['check'], ['cr', 'central ray'], ['position'], ['collimat'], ['anatomy', 'included']],
    ['CR, position, collimation', 'all anatomy included'], [
      s('10a', 'Exposure index check',
        [['exposure index', 'ei', 'di', 'deviation index'], ['check']],
        ['Exposure index']),
    ]),
  s('11', 'Set console for next image',
    [['console'], ['next']],
    ['next image']),
];

/* Situations: what to do now, by the routine. `ans` names the step or sub-step that answers. */
export const SCENARIOS = [
  { q: 'An order has just come in. Before you look at anything else, what do you do?', ans: '1' },
  { q: 'The order is a follow-up exam. What do you ask for while checking the history?', ans: '2', expect: 'Ask for the previous images' },
  { q: 'You have reviewed the history and order. What do you do at the console?', ans: '3' },
  { q: 'Setting up for a table exam: what goes on the table, and where does the tube go?', ans: '4a' },
  { q: 'Setting up for a wall exam: what two things do you do?', ans: '4b' },
  { q: 'The room is set for the patient\'s position. What is the last thing you set before calling them?', ans: '4c' },
  { q: 'You step into the waiting room. How do you call the patient?', ans: '5' },
  { q: 'The patient walks in carrying a bag and wearing a necklace. What do you do?', ans: '6a' },
  { q: 'You are about to introduce yourself. What is your reminder to yourself?', ans: '6b' },
  { q: 'Your patient is a 32-year-old woman. Besides two identifiers, what else do you confirm at this step?', ans: '6c' },
  { q: 'How do you confirm the body part without leading the patient?', ans: '6d' },
  { q: 'The order lacks the mechanism of injury. Which step covers this, and what do you do?', ans: '6e' },
  { q: 'Before positioning, what do you tell the patient to expect?', ans: '6f' },
  { q: 'The tube is aligned for a table exam. What three things happen with the table and patient?', ans: '7a' },
  { q: 'You are using a wireless IR. What do you align it with?', ans: '7c' },
  { q: 'Positioning: how many times do you position, centre and collimate?', ans: '8a' },
  { q: 'You have just positioned and collimated. What do you do before leaving the patient?', ans: '8b' },
  { q: 'You are at the console giving breathing instructions. What must you always be doing?', ans: '9' },
  { q: 'The image is on the screen. What three things do you check in your 3-second check?', ans: '10' },
  { q: 'The image passes your 3-second check. What number do you check next?', ans: '10a' },
  { q: 'The image is accepted. What do you do before the next exposure?', ans: '11' },
];

/* Every step and sub-step, flat, in routine order. */
export function flatSteps() {
  const out = [];
  for (const st of MOO) { out.push(st); for (const sub of st.subs) out.push(sub); }
  return out;
}
export const stepById = (id) => flatSteps().find((x) => x.id === id) || null;
