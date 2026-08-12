// ============================================================================
//  Tutorial content — what each control is, and what to try with it.
//
//  Written for someone learning radiography, not someone learning this program:
//  the blurbs say what the control does to the beam, the detector or the image,
//  and the goals ask for the change that makes the effect visible. Steps run in
//  the order the work is actually done — set up, technique, expose, read.
//
//  Step shape:
//    sel    CSS selector of the control to isolate
//    title  short heading
//    text   the explanation (HTML allowed)
//    goal   { label, done(arm), arm? }  — omit for explanation-only steps
//    before optional async setup (open a drawer, switch a view)
//    block  false to leave the whole page clickable for this step
// ============================================================================

const S = () => window.__radsimState;
const $ = (id) => document.getElementById(id);
const openBayMenu = async () => { const d = $('viewDrop'); if (d && !d.classList.contains('open')) $('bayMenuBtn').click(); };
const closeBayMenu = async () => { const d = $('viewDrop'); if (d && d.classList.contains('open')) $('bayMenuBtn').click(); };
const showImageView = async () => { await openBayMenu(); $('contentImageBtn')?.click(); await closeBayMenu(); };
const customCount = () => [...($('subjectSel')?.options || [])]
  .filter((o) => /^Custom:/.test(o.textContent)).length;

// ---------------------------------------------------------------- X-RAY
export const XRAY_STEPS = [
  {
    sel: '.bay',
    title: 'The positioning bay',
    text: 'This is the room. The tube hangs above, the receptor sits below or behind, and the '
      + 'subject lies between them. Everything you image is a real voxel volume — the picture is '
      + 'made by casting rays through actual tissue, so anatomy that overlaps in space overlaps '
      + 'in the image. Drag in the bay to orbit, scroll to zoom.',
  },
  {
    sel: '#subjectGrp',
    title: 'Subject',
    text: 'Pick the body part on the table — it lives at the top of the positioning column, '
      + 'because it is the first decision of any examination. Each subject is a segmented CT '
      + 'volume with its own materials — bone, soft tissue, lung, fat, marrow — so a hand '
      + 'attenuates like a hand and a chest like a chest. The subject you choose drives '
      + 'everything downstream: how much beam gets through, what technique you need, whether a '
      + 'grid is worth using. Models that ship a photographic skin (the hand, today) simply '
      + 'wear it — the image is always computed from the voxel volume underneath.',
    goal: {
      label: 'Load a different subject — try the chest',
      arm: () => S().subject,
      done: (a) => S().subject !== a,
    },
  },
  {
    sel: '.grp:has(#objRotY)',
    title: 'Positioning the part',
    text: 'Rotate, tilt and roll the subject, and slide it across the receptor. This is your '
      + 'positioning: an oblique hand, a rotated chest, a lateral. Rotation here is the patient '
      + 'moving, not the tube — get the part where you want it first, then angle the beam only if '
      + 'the projection genuinely calls for it.',
    goal: {
      label: 'Rotate the subject away from 0°',
      arm: () => JSON.stringify(S().objRot),
      done: (a) => JSON.stringify(S().objRot) !== a,
    },
  },
  {
    sel: ['.grp:has(#objOffY)', '#oidV'],
    title: 'Height off the receptor — where OID comes from',
    text: 'Lift the part and you have made an air gap. The OID readout under Tube &amp; distance '
      + 'follows this slider because OID is <i>geometry</i>, not a dial: it is the distance from '
      + 'the part to the receptor, and the only way to change it is to move the part. The '
      + 'divergent beam does the rest — a lifted part casts a larger, softer-edged shadow '
      + '(magnification and geometric unsharpness), which is why the rule is part flat on the '
      + 'receptor unless the projection says otherwise. The deliberate exception is the air-gap '
      + 'technique: a big enough gap lets obliquely scattered photons miss the receptor '
      + 'entirely, buying contrast without a grid.',
    goal: {
      label: 'Lift the part — watch the OID readout follow',
      arm: () => S().objOff.y,
      done: (a) => S().objOff.y !== a,
    },
  },
  {
    sel: ['#protocolBtn', '.protocur:has(#protocolV)'],
    title: 'Protocol (APR)',
    text: 'Anatomically Programmed Radiography. Choosing a protocol loads the department\'s '
      + 'starting technique for that projection — kV, mAs, grid, receptor, AEC configuration — '
      + 'the same way pressing a body-part button on a real console does. It is a starting point, '
      + 'not an answer: you still adjust for the patient in front of you.',
    goal: {
      label: 'Open the protocol list and select one',
      done: () => !!S().protocol,
    },
  },
  {
    sel: ['#kv', '.row:has(#kvSv)'],
    title: 'kV — beam quality',
    text: 'kV sets the energy of the photons, and so how penetrating the beam is. Raise it and '
      + 'more of the beam reaches the detector, but subject contrast falls, because at higher '
      + 'energies the photoelectric effect — the process that makes bone stand out from soft '
      + 'tissue — drops away sharply. Low kV gives high contrast and high patient dose; high kV '
      + 'gives a flatter, greyer, more forgiving image. This simulation is polyenergetic, so the '
      + 'beam hardens as it passes through the patient, exactly as a real one does.',
    goal: {
      label: 'Change the kV',
      arm: () => S().kv,
      done: (a) => S().kv !== a,
    },
  },
  {
    sel: ['#mas', '.row:has(#masSv)'],
    title: 'mAs — beam quantity',
    text: 'mAs is tube current × exposure time: how many photons you send. It controls the amount '
      + 'of radiation, not its penetrating power. Doubling mAs doubles the dose and halves the '
      + 'quantum noise (mottle) — the grainy speckle you see on an underexposed image. mAs cannot '
      + 'rescue an image where the kV is too low to get through the part at all.',
    goal: {
      label: 'Change the mAs',
      arm: () => S().mas,
      done: (a) => S().mas !== a,
    },
  },
  {
    sel: ['#aecBtn', '.row:has(#aecBtn)'],
    title: 'AEC — automatic exposure control',
    text: 'With AEC on, the generator stops the exposure when the ionisation chambers have '
      + 'collected enough radiation, so the exposure time is decided for you. It is the right tool '
      + 'when the part is centred over a chamber and made of what you expect — and the wrong one '
      + 'when it is not, because the chamber will happily terminate on lung, or run on and on '
      + 'under a prosthesis.',
    goal: {
      label: 'Switch AEC on',
      done: () => S().aecOn === true,
    },
  },
  {
    sel: '#aecCellsBox',
    title: 'AEC chambers',
    text: 'Three chambers: left, centre, right. Select the ones that sit under the tissue you want '
      + 'correctly exposed — the lung fields for a PA chest, the centre alone for a spine. Choose a '
      + 'chamber that is not covered by the part and the exposure terminates almost immediately, '
      + 'leaving the anatomy badly underexposed. This is the single most common AEC error.',
    before: async () => { if (!S().aecOn) $('aecBtn').click(); },
    goal: {
      label: 'Change which chambers are selected',
      arm: () => JSON.stringify(S().aecCells),
      done: (a) => JSON.stringify(S().aecCells) !== a,
    },
  },
  {
    sel: '.grp:has(#sidV)',
    title: 'SID, OID and tube angle',
    text: 'SID is the source-to-image distance, OID the object-to-image distance. Increasing SID '
      + 'reduces magnification and geometric unsharpness but costs intensity by the inverse square '
      + 'law — double the distance, quarter the dose at the receptor. OID here is a readout, not '
      + 'a control: it reports the air gap you made with the Height slider in the Object group, '
      + 'because the only way to move the part away from the receptor is to move the part. The '
      + 'angle sliders tilt the central ray for projections that need it, and the readout tells '
      + 'you when the beam is no longer perpendicular.',
    goal: {
      label: 'Change the SID',
      arm: () => S().sid,
      done: (a) => S().sid !== a,
    },
  },
  {
    sel: '.grp:has(#collX)',
    title: 'Collimation',
    text: 'Close the collimators to the anatomy of interest. This is not tidiness — every '
      + 'centimetre of tissue outside your field is producing scattered photons that land on the '
      + 'receptor and fog the image, and it is irradiating the patient for nothing. Tight '
      + 'collimation improves contrast and lowers dose at the same time. The light field shows you '
      + 'the borders on the subject.',
    goal: {
      label: 'Close the collimators in',
      arm: () => S().collX + S().collZ,
      done: (a) => S().collX + S().collZ < a,
    },
  },
  {
    sel: '.grp:has(#detSizeSeg)',
    title: 'Receptor and matrix',
    text: 'Receptor size and orientation decide how much anatomy fits. The resolution setting is a '
      + 'simulation control rather than a clinical one: it is the ray-cast matrix. Quick is a coarse '
      + 'grid that returns in a moment; full resolution is far sharper and far slower, and is worth '
      + 'switching to the Python GPU engine for.',
    goal: {
      label: 'Switch the receptor between portrait and landscape',
      arm: () => S().detOrient,
      done: (a) => S().detOrient !== a,
    },
  },
  {
    sel: '.grp:has(#gridSeg)',
    title: 'Anti-scatter grid',
    text: 'A grid is a comb of lead strips that absorbs obliquely travelling scattered photons and '
      + 'passes the primary beam. It restores contrast on thick parts — abdomen, chest, spine — at '
      + 'the cost of needing several times the mAs, because it absorbs some primary too. Grid ratio '
      + 'is strip height to gap: higher cleans up more scatter and is less forgiving of alignment. '
      + 'Use the focal distance the grid was built for, or you get grid cut-off across the image.',
    goal: {
      label: 'Put the grid in',
      done: () => S().gridOn === true,
    },
  },
  {
    sel: '#simGrp',
    title: 'Compute engine',
    text: 'Where the physics runs. <b>Browser</b> ray-casts on the CPU in this tab — always '
      + 'available, and fine at quick resolution. <b>Python GPU</b> hands the projection to the '
      + 'compute backend if you have it running, which is dramatically faster and makes full '
      + 'resolution practical. Nothing about the image changes, only how long you wait for it. '
      + 'Nothing to set here — it depends on what is installed.',
  },
  {
    sel: '#rotor',
    title: 'Rotor',
    text: 'Engage the rotor first. On a real tube this spins the anode up to speed so the heat of '
      + 'the exposure is spread around its rim instead of melting one spot. Until the rotor is up, '
      + 'the exposure button does nothing.',
    goal: {
      label: 'Engage the rotor',
      done: () => S().prepped === true,
    },
  },
  {
    sel: ['#fire', '#rotor'],
    title: 'Expose',
    text: 'Press and hold for the exposure time. Release early and you get a partial exposure, '
      + 'exactly as you would on the machine. Watch the timer: with AEC on, this is where you find '
      + 'out whether your chamber choice was right.',
    goal: {
      label: 'Take an exposure',
      done: () => S().hasImage === true,
    },
  },
  {
    sel: '.di',
    title: 'Exposure index and deviation index',
    text: 'EI is a measure of the radiation the detector actually received in the anatomy of '
      + 'interest — the IEC 62494 definition. DI compares that with the target for the examination: '
      + '<b>DI 0</b> is on target, <b>+3</b> is double the intended dose, <b>−3</b> is half of it. '
      + 'Roughly, ±1 is fine, beyond ±3 needs a reason. It is the number that tells you whether '
      + 'your technique was right, independently of how the image happens to look after processing.',
  },
  {
    sel: '.grp:has(#level)',
    title: 'Window and level',
    text: 'Post-processing: brightness and contrast applied to the stored image. The histogram '
      + 'above shows the pixel distribution with the response curve laid over it — drag the toe and '
      + 'shoulder to reshape it. Remember that this changes only the display. A dark image from too '
      + 'little exposure can be brightened here, but the noise comes up with it; windowing cannot '
      + 'put back photons you never sent.',
    goal: {
      label: 'Adjust the level or window',
      arm: () => S().lev + '/' + S().win,
      done: (a) => S().lev + '/' + S().win !== a,
    },
  },
  {
    sel: '#imgStrip',
    before: showImageView,
    title: 'Image history',
    needs: 'The strip fills once you have taken an exposure.',
    text: 'The last ten exposures are kept here with the technique that produced each one. This is '
      + 'the useful part of the simulator: change one variable, expose again, and compare the two '
      + 'side by side. Halve the mAs and look at the noise; drop 20 kV and look at the contrast.',
  },
];

// ---------------------------------------------------------------- CT
export const CT_STEPS = [
  {
    sel: '#subjectGrp',
    title: 'Subject',
    text: 'Choose what is on the couch — the selector sits at the top of the positioning column. '
      + 'CT reconstructs from projections taken all the way around '
      + 'the patient, so unlike a radiograph nothing is superimposed — but everything inside the '
      + 'scan field contributes, including the table. Chest and chest-abdomen-pelvis are the '
      + 'subjects with vessel maps, so they are the ones that can be given contrast.',
    goal: {
      label: 'Load the chest',
      done: () => S().subject === 'chest',
    },
  },
  {
    sel: ['#ctProtocolBtn', '.protocur:has(#ctProtocolName)'],
    title: 'Protocol',
    text: 'The protocol sets the scan range and, importantly, the <b>isocentre landmark</b> — the '
      + 'anatomical point you are told to line up with the laser before you zero the table. Choose '
      + 'the protocol for the examination first; everything after this is measured relative to the '
      + 'zero you are about to set.',
    goal: {
      label: 'Select a CT protocol',
      arm: () => S().ct.protocol,
      done: (a) => S().ct.protocol !== a,
    },
  },
  {
    sel: '#ctScoutTable',
    title: 'Scout planning',
    text: 'The scout (topogram, scanogram) is a plain projection taken with the tube parked, used '
      + 'only to plan from. Two are planned by default: 0° gives you the AP, 90° the lateral. Each '
      + 'has its own kV and mA — a scout is a low-dose image and does not need diagnostic '
      + 'technique, it only needs to show you where the anatomy is.',
    goal: {
      label: 'Change a scout technique value',
      arm: () => JSON.stringify(S().ct.scoutTech),
      done: (a) => JSON.stringify(S().ct.scoutTech) !== a,
    },
  },
  {
    sel: '#ctTableGrp',
    title: 'Table position and height',
    text: 'Table position is where the couch sits along the bore, signed relative to the '
      + 'isocentre: S is superior, I inferior. Table <b>height</b> matters more than students '
      + 'expect — centring the part at the isocentre is what keeps the bowtie filter, the dose '
      + 'modulation and the reconstruction geometry all doing what they were designed to do. A '
      + 'patient scanned off-centre gets a noisier image and, often, more dose.',
  },
  {
    sel: '#ctIsocentre',
    title: 'Zero the table',
    text: 'Line the landmark up and press this. It records the current table position as zero, so '
      + 'every scan range from here on is quoted relative to that anatomical point. Until it is '
      + 'zeroed the scan start and end read in red and the scanner will not proceed — the same '
      + 'interlock the real machine has, for the same reason.',
    goal: {
      label: 'Set the isocentre',
      done: () => S().ct.isocentred === true,
    },
  },
  {
    sel: ['#ctMoveScan', '#ctHint'],
    title: 'Move to scan',
    text: 'Drives the couch to the scan start position. On the machine this is the moment the '
      + 'patient travels into the bore, and it is the last point at which you can look at them '
      + 'rather than at a screen.',
    goal: {
      label: 'Move the table to the scan start',
      done: () => /at scan|at scout|ready to scan|press START/i.test($('ctHint')?.textContent || ''),
    },
  },
  {
    sel: ['#ctStart', '#ctMoveScan'],
    title: 'Acquire the scouts',
    text: 'START runs whatever the console is currently set up to do. Right now that is the scout '
      + 'pair — though the couch has to be at the scan start first, so MOVE TO SCAN stays lit '
      + 'beside it. Once the scouts are on screen the console moves into planning and the '
      + 'scan-group table appears beneath them.',
    goal: {
      label: 'Acquire the scouts',
      done: () => S().ct.scoutsReady === true,
    },
  },
  {
    sel: '#ctScanGroups',
    title: 'The scan-group table',
    needs: 'The scan plan appears once the scouts are on screen — go back and acquire them.',
    text: 'One row per planned acquisition — a modern examination is usually several: a '
      + 'non-contrast series, an arterial phase, a delayed. Each row carries its own range, field '
      + 'of view, collimation, pitch, technique and delay, and each is stored as its own series. '
      + 'Click any value in a row to edit it.',
    block: false,
  },
  {
    sel: '.scanbox[data-view="ap"]',
    title: 'The scan box',
    needs: 'The scan box is drawn on the scouts — go back and acquire them first.',
    text: 'Drag the box on the scout to set where the scan starts and stops. Its edges are the '
      + 'first and last slice. Include what the question needs and no more: unlike collimation on a '
      + 'radiograph, over-ranging here is straightforwardly extra dose to tissue nobody is going to '
      + 'look at. The box on the lateral scout is the same scan seen from the side.',
    block: false,
  },
  {
    sel: '#ctScanGroups tr.sg-row:first-child td:nth-child(5)',
    title: 'SFOV and DFOV',
    needs: 'This column is in the scan-group table, which needs the scouts.',
    text: '<b>SFOV</b> is the scan field — how wide a fan of detector the scanner reads, chosen to '
      + 'cover the patient. Anything outside it is not measured at all and cannot be reconstructed. '
      + '<b>DFOV</b> is the display field: the part of that data you actually reconstruct into the '
      + 'image matrix. Shrinking DFOV puts the same matrix over less anatomy, so pixels get smaller '
      + 'and detail improves — but only within what SFOV captured.',
    block: false,
  },
  {
    sel: '#ctDetectorGrp',
    title: 'Detector configuration',
    text: 'How many detector rows you switch on, times the element size, gives the total beam '
      + 'collimation. More rows cover more anatomy per rotation, so the scan is quicker — which is '
      + 'why wide detectors matter for a breath-hold or a moving heart. Preview mode reconstructs '
      + 'fast and roughly; the realistic detector adds the physics and is much slower.',
    goal: {
      label: 'Try a different detector configuration',
      arm: () => $('ctDetModeV')?.textContent,
      done: (a) => $('ctDetModeV')?.textContent !== a,
    },
  },
  {
    sel: '#ctScanGroups tr.sg-row:first-child td:nth-child(9)',
    title: 'Pitch',
    needs: 'This column is in the scan-group table, which needs the scouts.',
    text: 'Pitch is table travel per rotation divided by the total beam collimation. Below 1 the '
      + 'helices overlap — more dose, less noise, better z-resolution. Above 1 they spread apart — '
      + 'faster and lower dose, at the cost of noise and interpolation artefact. Pitch changes the '
      + 'scan time for a given range, which is why it is the knob you reach for when a patient '
      + 'cannot hold their breath.',
    block: false,
  },
  {
    sel: '#ctScanGroups tr.sg-row:first-child td:nth-child(13)',
    title: 'kV and mA',
    needs: 'This column is in the scan-group table, which needs the scouts.',
    text: 'The same physics as radiography. kV sets penetration and contrast — and note that '
      + 'iodine is far more conspicuous at low kV, because 80 kVp sits much closer to its K-edge at '
      + '33 keV, which is exactly why CTA is often done at 80 or 100 rather than 120. mA sets the '
      + 'photon count and so the noise.',
    block: false,
  },
  {
    sel: '#ctScanGroups tr.sg-row:first-child td:last-child',
    title: 'Scan delay',
    needs: 'This column is in the scan-group table, which needs the scouts.',
    text: 'When this series fires relative to the start of the contrast injection. Either a '
      + '<b>fixed time delay</b> — simple, and wrong for any patient whose circulation is not '
      + 'average — or <b>bolus tracking</b>, which watches the contrast arrive and triggers on it. '
      + 'Choosing bolus tracking builds a second scan group automatically: a monitoring series and '
      + 'the enhanced series it triggers.',
    block: false,
  },
  {
    sel: '#ctReconPlan',
    title: 'Reconstruction planning',
    needs: 'The recon planner sits under the scan plan, which needs the scouts.',
    text: 'Reconstruction is separate from acquisition, and this is the part that surprises people: '
      + 'one scan can be reconstructed many times over. Different slice thickness, different '
      + 'interval, different kernel — a sharp algorithm for lung and bone, a smooth one for soft '
      + 'tissue — all from the same raw data, at no extra dose. Plan as many as the report needs.',
    block: false,
  },
  {
    sel: '#ctrstTab',
    title: 'The contrast injector',
    text: 'Opens the power injector. Contrast needs a subject with a vessel map, so it is '
      + 'available on the chest and CAP. The panel is a separate machine with its own interface — '
      + 'that is why it does not follow the scanner\'s vendor colours.',
    goal: {
      label: 'Open the contrast panel',
      when: () => !$('ctrstTab')?.disabled,
      unless: 'Contrast needs a subject with a vessel map — go back and load the chest.',
      done: () => $('ctrstPanel')?.classList.contains('open'),
    },
  },
  {
    sel: '#ctrstBar',
    title: 'Programming the injection',
    text: 'The bar is the injection as a timeline: contrast in green, saline in blue, drawn to '
      + 'scale in time. Each phase carries a volume and a flow rate. Flow rate '
      + 'sets how tight the bolus is — 4–5 mL/s for a CTA, slower for a portal-venous study. The '
      + 'saline chaser is not padding: it pushes the tail of the contrast out of the arm veins and '
      + 'into the circulation, so all of what you paid for is doing work. With the Python compute '
      + 'service running, tap a phase to reprogram it on the keypad.',
    goal: {
      label: 'Open a phase and change a value',
      when: () => !!S().computeInfo,
      unless: 'Nothing to change on the browser engine: the protocol is fixed on the shipped '
        + 'preset timeline. Programming the injector needs the Python compute service to solve '
        + 'the haemodynamics for whatever you enter.',
      arm: () => JSON.stringify(S().contrast.params),
      done: (a) => JSON.stringify(S().contrast.params) !== a,
    },
  },
  {
    sel: '.grp:has(#ctrstSite)',
    title: 'Injection site',
    text: 'Where the needle is changes when — and how sharply — the bolus arrives. The basilic '
      + 'vein is the reference route every timing chart assumes. A central line\'s tip already '
      + 'sits at the cavoatrial junction, so its bolus skips the peripheral veins and arrives '
      + 'earliest and sharpest. The arterial sites are the instructive ones: a radial or femoral '
      + 'bolus must first cross the limb\'s capillary bed before it can return to the heart, so '
      + 'it comes back later and flatter — the limb is not part of the segmented anatomy, so its '
      + 'transit is estimated as a mixing bed plus a transport delay, and the note under the '
      + 'selector says exactly what was assumed. This one works on the browser engine too: each '
      + 'site ships its own solved timeline.',
    goal: {
      label: 'Switch the injection site and watch the curves move',
      when: () => S().contrast.on,
      unless: 'Turn the injector ON first — the power button at the top of the panel.',
      arm: () => S().contrast.params.site,
      done: (a) => S().contrast.params.site !== a,
    },
  },
  {
    sel: '.grp:has(#ctrstHr)',
    title: 'The patient',
    text: 'Cardiac output is the dominant variable in contrast timing, and this is where the '
      + 'teaching is. Heart rate × stroke volume gives the output; a patient in failure with a low '
      + 'output takes markedly longer to bring the bolus round and peaks higher when it arrives. '
      + 'With the solver running you can change these and watch the predicted enhancement curve '
      + 'move — then think about what a fixed 25-second delay would have done to that patient.',
    goal: {
      label: 'Change the heart rate or stroke volume',
      when: () => !!S().computeInfo,
      unless: 'Nothing to change on the browser engine: the preset timeline is one fixed '
        + 'patient. Moving these needs the Python compute service, which is what re-solves the '
        + 'circulation each time you do.',
      arm: () => S().contrast.params.cardiac_output_l_min,
      done: (a) => S().contrast.params.cardiac_output_l_min !== a,
    },
  },
  {
    sel: '#ctrstCurve',
    title: 'Predicted enhancement',
    text: 'The solved haemodynamics: iodine concentration against time in the pulmonary artery and '
      + 'the aorta, converted to the HU they would show. The gap between the two curves is the '
      + 'window in which you can catch the pulmonary arteries before the systemic circulation '
      + 'fills — the PE study. The vertical line is the injector clock, so you can watch it walk '
      + 'across the curve while the injection runs.',
  },
  {
    sel: ['#ctrstGo', '#ctrstReset'],
    title: 'Start the injection',
    text: 'Starts the injector clock. From this moment the images the scanner reconstructs are '
      + 'taken at whatever time the clock reads — that is the entire game. Start it, watch the '
      + 'curve, and scan at the phase you want. On a bolus-tracked study you do not have to press '
      + 'this at all: the tracking window has the same transport, and starting tracking starts the '
      + 'injection with it.',
  },
  {
    // The console will not start until the couch is at the scan start, so MOVE TO SCAN has to be
    // lit alongside START — lighting START alone left the learner pressing a button whose only
    // reply was "press the flashing MOVE TO SCAN button", which the mask had gone dark over.
    sel: ['#ctStart', '#ctMoveScan'],
    title: 'Run the scan',
    text: 'The couch travels to the scan start before the gantry will run, so press '
      + '<b>MOVE TO SCAN</b> and then <b>START</b> — the same two presses as on the machine. '
      + 'Each group is acquired in turn, applying '
      + 'its delay. If a group is a monitoring series, the tracking window opens instead: '
      + 'position the ROI on the vessel, start tracking, and the scan fires when the contrast '
      + 'crosses your threshold — or when you press SCANNING PHASE yourself.',
    goal: {
      label: 'Run the scan',
      done: () => /complete/i.test($('ctHint')?.textContent || ''),
    },
  },
  {
    sel: ['#ctSliceSlider', '#ctSliceCanvas'],
    title: 'Reading the series',
    needs: 'The slice viewer appears once a scan has been run.',
    text: 'Scroll the slices. The histogram shows the HU distribution of the current image with '
      + 'the window laid over it.',
    block: false,
  },
  {
    sel: ['#ctWLPresets', '#ctWL', '#ctWW'],
    title: 'Window presets',
    needs: 'The window controls appear once a scan has been run.',
    text: 'CT measures in Hounsfield units on an absolute scale — water is 0, air is −1000, dense '
      + 'bone is well over 1000 — so the same data is windowed differently for each tissue rather '
      + 'than being re-acquired. Soft tissue around 40/400, lung around −600/1500, bone around '
      + '300/1500. Every one of these is the same slice.',
    goal: {
      label: 'Try a window preset',
      arm: () => $('ctWL')?.value + '/' + $('ctWW')?.value,
      done: (a) => $('ctWL')?.value + '/' + $('ctWW')?.value !== a,
    },
  },
  {
    sel: '#ctStorageGrp',
    title: 'Image storage',
    text: 'Each scan group is stored as its own series and can be recalled from the selector under '
      + 'the viewer. Older groups are dropped automatically once the limit is reached, so a long '
      + 'session does not fill memory.',
  },
  {
    sel: '#ctIfaceGrp',
    title: 'Vendor interface',
    text: 'Cosmetic, but worth knowing about: CT consoles from different manufacturers look and '
      + 'read very differently, and part of being useful in a new department is not being thrown by '
      + 'that. Switching this restyles the console. Nothing in the physics changes.',
  },
];

// ---------------------------------------------------------------- EDITOR
export const EDITOR_STEPS = [
  {
    sel: '#edPage',
    title: 'The model editor',
    text: 'A voxel phantom is a 3D grid where every cell holds a material id — bone, fat, muscle, '
      + 'lung, air, metal. That grid is all the scanners ever see. Here you can build one by hand '
      + 'or alter an existing one, then save it as a subject and image it.',
  },
  {
    sel: '.grp:has(#edNewSize)',
    title: 'Starting a model',
    text: 'Name it and choose a grid size. Bigger grids resolve finer structure and cost more to '
      + 'ray-cast through — the same trade you make choosing a reconstruction matrix. Start small '
      + 'while you are learning the tools.',
    goal: {
      // Creating a model at the SAME grid size leaves the DOM identical, so there would be
      // nothing to detect. Asking for a different size is both checkable and the better
      // lesson: it makes the resolution-versus-cost trade concrete.
      label: 'Create a blank model at a different grid size',
      arm: () => $('edSlice')?.max,
      done: (a) => $('edSlice')?.max !== a,
    },
  },
  {
    sel: '#edPreset',
    title: 'Loading a preset',
    text: 'Rather than starting from nothing, load an existing phantom and modify it. This is the '
      + 'quickest way to build a teaching case: take the chest, paint in a lesion or a piece of '
      + 'metal, and scan it.',
  },
  {
    sel: '#edSlice',
    title: 'Slice navigation',
    text: 'You paint one transverse slice at a time, exactly as the volume is stored. Step through '
      + 'the stack to see how the anatomy changes with level — and remember that a structure has to '
      + 'be painted on every slice it passes through to exist in three dimensions.',
    goal: {
      label: 'Move to a different slice',
      arm: () => $('edSlice')?.value,
      done: (a) => $('edSlice')?.value !== a,
    },
  },
  {
    sel: '#edMats',
    title: 'The material palette',
    text: 'Every material carries its own energy-dependent attenuation, taken from the NIST tables. '
      + 'That is why cortical bone, marrow and fat look different in the image without anyone '
      + 'assigning them a brightness — the difference falls out of the physics. Pick one to paint '
      + 'with.',
    goal: {
      label: 'Select a material',
      arm: () => document.querySelector('#edMats .on')?.textContent,
      done: (a) => document.querySelector('#edMats .on')?.textContent !== a,
    },
  },
  {
    sel: '#edTools',
    title: 'Tools and brush size',
    text: 'Paint, erase, fill. The brush size is in voxels, so its real-world size depends on the '
      + 'grid spacing of the model you are working in.',
  },
  {
    sel: '#edWrap',
    title: 'Painting',
    text: 'Drag on the slice to lay material down. The 3D preview beside it rebuilds as you go, so '
      + 'you can see the shape you are actually making rather than guessing from cross-sections.',
    block: false,
  },
  {
    sel: '.grp:has(#edSaveSession)',
    title: 'Saving',
    needs: 'Create or load a model first — there is nothing to save yet.',
    text: '<b>Save to session</b> registers the model as a subject immediately — switch to X-ray or '
      + 'CT and it is in the subject list, ready to image. <b>Download</b> writes it to a file you '
      + 'can keep and load again later.',
    goal: {
      // A saved model shows up as a "Custom: …" entry in the subject selector — that is the
      // observable effect, and the only one, so it is what the goal watches.
      label: 'Save the model to the session',
      arm: () => customCount(),
      done: (a) => customCount() > a,
    },
  },
];

// ---------------------------------------------------------------- BARIUM
// Runs inside x-ray mode: fluoroscopy is projection radiography with a clock.
export const BARIUM_STEPS = [
  {
    sel: '#subjectGrp',
    title: 'A barium study needs a gut',
    text: 'Barium is enteric contrast: it goes down the oesophagus, not into a vein, so the '
      + 'subject must carry a segmented GI tract. Chest / abdo / pelvis is the one that does. '
      + 'Everything in this tutorial — transit, gravity, coating — happens inside that '
      + 'segmented anatomy.',
    goal: {
      label: 'Load Chest / abdo / pelvis',
      done: () => S().subject === 'chestabdopelvis',
    },
  },
  {
    sel: '#giTab',
    title: 'The fluoroscopy panel',
    text: 'The BARIUM tab hangs on the left edge, beside CONTRAST. It is greyed out for any '
      + 'subject without GI data — the honest signal lives on the closed tab, not buried in a '
      + 'message after you open it.',
    goal: {
      label: 'Open the barium panel',
      when: () => !$('giTab')?.disabled,
      unless: 'The tab is greyed out — go back and load Chest / abdo / pelvis first.',
      done: () => $('giPanel')?.classList.contains('open'),
    },
  },
  {
    sel: '#giOn',
    title: 'Power',
    text: 'ON loads the GI geometry — the tract\'s centreline, calibre and volume, measured from '
      + 'the segmentation — and arms the study. Nothing is administered yet: that is what the '
      + 'transport button below does.',
    goal: {
      label: 'Turn the barium study on',
      done: () => !!S().barium.on,
    },
  },
  {
    sel: '.grp:has(#giRouteSeg)',
    title: 'Route, volume, density — and technique',
    text: '<b>Swallow</b> runs the tract from the top: oesophagus, stomach, small bowel, colon. '
      + '<b>Enema</b> loads 800 mL and runs it backwards from the rectum, against peristalsis, '
      + 'which is why an enema fills a colon in minutes that transit would take a day to reach. '
      + 'Density is the suspension strength in % w/v. <b>Single</b> contrast fills the lumen and '
      + 'you read its outline; <b>Double</b> adds gas — effervescent granules on a swallow, an '
      + 'insufflator on an enema — which pushes the barium off the non-dependent wall and leaves '
      + 'it as a thin coat. You then read the mucosal <i>surface</i>, which is where early '
      + 'disease lives.',
    goal: {
      label: 'Switch the technique to Double',
      done: () => S().barium.gasMl > 0,
    },
  },
  {
    // One rect, not two: lighting this group AND the rotate sliders across the screen made
    // the ring span the whole viewport, which isolates nothing.
    sel: '.grp:has(#giStandSeg)',
    title: 'The patient is the pump',
    text: 'There is no injector here — gravity is the only control you have over where the '
      + 'barium goes, and you steer it by turning the patient. The stand toggle and the rotate / '
      + 'tilt / roll sliders are the same controls you position with, because positioning the '
      + 'patient to move the agent IS the examination. Gravity applies from the moment you turn: '
      + 'stand the patient up and the stomach empties faster; roll them left and the fundus '
      + 'fills. In a double-contrast study the gas re-levels the instant you turn, pushing '
      + 'barium into whatever has just become dependent.',
    goal: {
      label: 'Change the patient\'s position — stand them up, or roll them',
      arm: () => JSON.stringify([S().barium.erect, S().objRot]),
      done: (a) => JSON.stringify([S().barium.erect, S().objRot]) !== a,
    },
  },
  {
    sel: ['.gi-clock', '#giGo', '#giSpeedSeg'],
    title: 'The study clock',
    text: 'Press ▶ and the agent is given: the clock starts and the solver moves barium through '
      + 'the tract in real time. Real time is slow — a stomach empties over half an hour — so '
      + 'the speed buttons compress it: at 300× a whole small-bowel series runs in about a '
      + 'minute. Pause whenever you want to screen; the study holds its state and continues '
      + 'where it left off.',
    goal: {
      label: 'Start the study and let it run',
      done: () => !!S().barium.study && S().barium.study.t > 30,
    },
  },
  {
    sel: '.grp:has(#giBars)',
    title: 'Where the barium is',
    text: 'One bar per segment, in anatomical order. Amber is barium in the lumen; the pale band '
      + 'stacked after it is the mucosal coat — the part a double-contrast film is actually of, '
      + 'because the coat stays behind after the lumen empties. The blue shading from the right '
      + 'is gas. The line underneath is the mass audit: given, in the lumen, coating. It should '
      + 'always add up — if barium vanished anywhere, the physics would be lying to you.',
  },
  {
    sel: ['#rotor', '#fire'],
    title: 'Expose — this is fluoroscopy',
    text: 'The generator does not know the barium panel exists: you take an ordinary exposure, '
      + 'and whatever the study clock says is where the barium is on the film. Pause at the '
      + 'phase you want — early gastric filling, small-bowel transit at an hour, a filled colon '
      + 'on an enema — position, collimate, and expose. Compare films at different clock times '
      + 'from the image history, exactly as a fluoroscopy series would.',
    goal: {
      label: 'Take an exposure with barium in the tract',
      arm: () => (S().imgHistory || []).length,
      done: (a) => (S().imgHistory || []).length > a,
    },
  },
];
