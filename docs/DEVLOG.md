# RadSim development log

What shipped, why, and how it was checked — newest first. Each entry points at its pull
request, which carries the full detail. (`SUMMARY.md` at the repo root is a separate, local
handoff document and is not committed.)

---

## 2026-10-25

### The ankle measured where it is — [#85](https://github.com/mrtethlab/RadSim/pull/85)
**The fault.** The leg's ankle landmark was the peak of the bone's cross-section profile; with the foot at 90° the hindfoot's bones fill that profile, and it sat 4 cm below the joint, on the calcaneus. The malleoli were searched for below it, so they landed on the calcaneus too; the AP ankle centred 3.5 cm low, the lateral ankle likewise, and the ankle bent about a point in the calcaneus.
- *The joint:* the ankle is now the tibiotalar joint, the first joint sheet met going down the tibia's own axis (`measure_landmarks.tibiotalar`; the subtalar is the next, 2.6 cm on). The sheets and the joint spaces are only read: no voxel of the leg changed.
- *What follows from it:* the malleoli (0.9 and 2.3 cm below the joint), the point midway between them (the ankle's pivot and the AP ankle's centre), the base of the 3rd metatarsal (now at the tarsometatarsal joint, not mid-shaft), the medial cuneiform, the base of the 5th, and the calcaneus (its body, under the subtalar joint).
- *Measured on the shafts:* the foot's inversion is read across the metatarsal shafts (it reached back into the tarsals' arch): it rests 8° inverted, 5° plantarflexed, as cross-sections of the shafts show.
- *The sole:* the Trainer and the tests judge "flat" on the foot's long axis (the one its flexion is measured from), not the line from the ankle to the 3rd metatarsal, which dips 13° more; the AP and oblique foot and toes take a tilt of −59° with 30° of plantarflexion.
- *The Foot* is cut again, now a true third of the leg above the real ankle; below its dome it is the leg voxel for voxel, joint spaces and all.

**Checked:** points marked on bone projections and material slices; the AP, mortise and lateral ankle, AP foot and lateral calcaneus films in the app; the ankle bending about the joint; `npm test`: 272 pass (the sole test fails at the old tilt).

### Twenty refinements across the modes — [#84](https://github.com/mrtethlab/RadSim/pull/84)
**X-ray, foot and ankle.**
- *Anatomical ankle:* `bake_pose --trim` took out what the leg's bake left (the foot rested 11° turned out and 10° inverted): every ankle slider now opens within 2° of 0. The Foot is cut again from it, its cut end domed.
- *Views:* the AP and oblique foot lay the sole flat with the leg raised as a flexed knee does (protocol poses take a tilt), no longer approximate; new AP and oblique toes (CR to the 3rd MTP joint, found as the gap along the 3rd ray) and axial and lateral calcaneus (CR to the calcaneal body, measured). The foot and ankle protocols load the Foot.
- *AP ankle:* an `ankle` LUT with latitude (equalisation, `core/equalise.js`): the foot standing end-on over the talus left 35 % of the film in the top tone band; now none.
- the collimator's screen shows its rotation; the protocols' 35×43 receptors read 43×43; the Trainer's tilt raises one end, to 75°.

**CT.** Ankle and Foot protocols, zeroed at the medial malleolus, load the Foot.

**Fluoroscopy.** An ankle ORIF case on the Foot: a Weber B distal fibula (traced from the voxels, cut by a 55° plane) reduced with forceps under AP, mortise and lateral screening, judged to 2 mm and 5° with the screening used. A 0.035″ guidewire steered through the contrast solver's vessel tree, imaged by the beam (its path length through steel at each spectrum bin); the roadmap is now subtracted, vessels white and the wire black.

**DXA.** The forearm (33 % radius of the non-dominant arm, the ulna measured on the volume, the intake's indications), and a precision assessment (RMS-SD, LSC = 2.77 × precision against ISCD minimums, from the learner's own repositioning) whose LSC the reports then use. It found two hip bugs: landmarks that did not follow the patient, and a coarse femoral-head search (neutral leg now reads 3 % higher, not 8 %).

**Mammography.** CC and MLO positioning (pull, fold lift, C-arm angle, rotation, nipple roll) on a patient of her own build, and the film graded P/G/M/I by measuring it: PNL, pectoral muscle to the PNL, its border and angle, IMF, nipple in profile, cut-off, CC vs MLO PNL within 1 cm. The MLO now projects superomedial to inferolateral (it was geometrically an LMO).

**Ultrasound.** Colour Doppler rebuilt as signal processing (ensembles, Kasai, wall filter, aliasing that wraps) and spectral PW Doppler (gate, angle correction, PRF capped by depth), with flow by vascular bed; a seat on the aorta reads PSV 53 / EDV 12 cm/s, RI 0.78.

**IV.** The back of the hand with its own technique: 22–24 G at 10–15°, a mobile vein, pain on probing, valves, joint and nerve sites, and contrast capped at 1.5 mL/s.

**Around the app.** A model that fails to load is said over the room with a retry; the local backend check stops after three misses; three.js and each room build into chunks of their own (the app core 257 kB).

**Found, not yet fixed.** The malleoli, the ankle landmark and the ankle's pivot sit 2–3 cm below the tibial plafond, on the calcaneus (the AP and lateral ankle centre low). (First put down to cartilage in the talus: that was a misreading of a summed projection; fixed in #85.)

**Checked:** each feature in the running app and on the production build (every room opens clean); `npm test`: 272 pass, with each new test proved by reintroducing its bug.

### A Foot model, cut from the lower extremity — [#83](https://github.com/mrtethlab/RadSim/pull/83)
A new **Foot** subject: the foot and the distal third of the tibia and fibula, cut from the lower
extremity, so a foot or ankle film loads a 4.8 MB volume instead of 50 MB.
- `build_crop.py` cuts the shipped leg a third of the way from the ankle joint to the knee and records the shift into the crop's frame (`data/crops.json`).
- `core/crops.js` derives the foot's ankle joint, landmarks, palpation and centring points from the leg's at load, keeping only what the box holds. A re-measured leg carries the foot with it.

**Checked:** the voxels around the malleoli, the 5th metatarsal base and the ankle landmark are identical in the foot and the leg after the shift; the ankle bends about the ankle; a Foot exposure images normally. The new `crops.test.js` fails if the landmark frame is swapped.

### X-ray room: bucky follows the tube, floating tabletop, turning collimator — [#82](https://github.com/mrtethlab/RadSim/pull/82)
**Room.**
- *Bucky:* it runs along its rails (the table's long axis, the wall stand's column) at 30 cm/s to follow the tube. The physics frame is the receptor's, so the tube and patient are placed relative to the bucky and exposures stay centred on it.
- *Tabletop:* at the table, moving the patient moves the top with them, under the tube and bucky.
- *Light field:* every room part casts shadows, so the field stops on what it hits instead of showing through the tabletop onto the base.
- *AEC:* the selected chambers appear on the patient's skin as light-blue boxes.

**Controls.**
- a collimator rotation slider, 90° either way with a 5° detent at square; the light field (which had turned the wrong way), the exposed field, the Trainer's field checks and the collimator box itself turn together, the tube above it still;
- receptors are 25×30 and 43×43 only (protocols that asked for 35×43 take 43×43);
- grids are 8:1 or 12:1, focused at 115 or 180 cm, with the nearer focus picked on a room or protocol change;
- SID limits are 80–130 cm at the table and 80–210 cm at the wall stand or over a free plate;
- the room selector is three small icons in a row at the bottom right.

At the table the SID is 100 cm against a 115 cm grid focus, so large fields show slight cut-off at their edges, more at 12:1.

**Checked:** in the app (bucky tracking at the table and wall, the panning top, shadows over the base, AEC on the skin, collimator rotation, SID limits, an exposure with the bucky moved); `npm test`: 194 pass.

### DXA: patient intake, a guided spine and hip exam, the Lunar table — [#81](https://github.com/mrtethlab/RadSim/pull/81)
Bone densitometry gains an exam to work through, beside free scanning, and moves ahead of Mammography on the home page.
- **Intake** (`dxaIntake.js`): a generated patient's questionnaire, each answer hidden until it is asked. The student accepts or delays; the scan must wait for possible pregnancy, barium within 14 days, iodinated contrast or nuclear medicine within 7, calcium taken today, or weight over the 159 kg table limit. Risk factors are never a reason to delay.
- **Exam** (`dxaExam.js`):
  - *AP lumbar spine:* centre the patient on the pad (they start 5–9 cm and 4–7° off), place the knee block, drive the laser to 1 in above the ASIS, scan;
  - *left hip:* swap to the foot holder (feet in 20°), drive the laser to 2 in below the greater trochanter, scan.

  SCAN says what is still missing.
- **Results:** the answers drive the bone (menopause age, steroids, aromatase inhibitor or ADT, fragility fracture, smoking, low BMI). The report carries the history and is read on the lowest T-score.
- **Room** (`dxaRoom.js`): a modelled Lunar Prodigy-style table (263 cm) with its pad, travelling arm, knee block and foot holder. The two photogrammetry tables (7 MB) are gone.
- **Scan:** timed to the Prodigy spec (4.5° fan, 30 s per region). The arm steps 2.4 cm between overlapping passes and the image builds pass by pass; ×5 fast-forward for practice.
- **Fixes:** the landmarks follow the patient along the table, and the laser is read in the table's frame.

**Checked:** the full exam in the app, every gate and the delay feedback; `npm test`: 194 pass, with new tests on the delay rules, the bone model and the scan plan.

### Fluoroscopy: joints, a modelled C-arm, a monitor cart — [#80](https://github.com/mrtethlab/RadSim/pull/80)
**Joints in fluoroscopy.** Every joint slider (knee, ankle, elbow, wrist, neck, jaw) now works in fluoroscopy. The pose is made in the posing workers and handed to the pulse workers before their next pulse (`fluoro.js` `syncPose`); until then the monitor keeps the last pose. Fluoroscopy never poses on the main thread.

**The C-arm.** The dark photogrammetry scan, with its loose fragments, is replaced by a modelled machine after the GE OEC 9800 / Elite (`carm.js`). Each part is posed by the machine's own joint chain, so nothing separates through orbital, tilt, flip-flop, lift, extend or wig-wag.
- tilt now sits outside orbital, as on the real machine (`core/carmPose.js`), with a test holding the beam formula to the chain;
- orbital is ±95° (it was ±115°), so the C never leaves its holder;
- the column stands 125 cm from the beam axis; in the scan it stood inside the C.

**Also in the room:**
- a monitor cart past the foot of the table, showing the live and reference images with a status bar;
- the patella rides the knee, keeping the patellar tendon at its rest length (about 0.75 of the flexion early, 0.6 at 90°), with a test on the tendon;
- the staff-dose point stands by default at the C-arm's control head, about 1.6 m from the beam;
- a carbon-fibre table on a pedestal at the foot, so the C reaches under it.

**Speed.** Slider to new image went from 1.45 s to 0.7–0.8 s, including the 250 ms wait for the slider to settle:
- handoff to the pulse workers is 50–100 ms, from about 550: they take only the patient's box (a 60° knee: 91 of 181 MB), transferred rather than copied;
- the crease is solved by the Illinois method; a one-thread knee pose went from 890 to 690 ms, voxel for voxel the same;
- the pool shares the plan's pass and folds in slabs with a halo. A test poses a two-joint limb both ways and fails, 119 voxels off, without the halo.

**Checked:** live, a knee at 60° and a lateral C-spine with the jaw opened then the neck flexed 40°; `npm test`: 189 pass.

### Open joint spaces, a new leg, the jaw, knee positioning — [#79](https://github.com/mrtethlab/RadSim/pull/79)
**Joint spaces.** `joint_space.py` finds the gap between two bones on the CT, from curvature sheets between dense plates and label sheets between named bones. The sheets ride through the bake and are cut to a cartilage width at the end; the hand's joints are cut from their own measures. The PA hand, ankle mortise and C-spine laterals and obliques now show open joints.

**Leg, arm and foot.**
- the leg is now z035 (30 F, healthy young bone) at 1 mm, with textbook ankle and foot rolls;
- the arm is rebuilt at 1 mm with seeded bone labels, its rolls following the epicondyles; the lateral forearm is landscape with the elbow at 90°;
- *the foot is carried whole through the bake.* The bake turned only what lay below the ankle's plane, and this pointed foot had its heel above it, so the foot broke at the midfoot. Now markers in the bone give the forefoot's rigid turn, the whole foot turns by it about the talar dome, and the sole is squared to the tibia (20° of eversion corrected);
- the ankle and foot skin is relaid without fins or ledges, and the hand that lay on the hip is cut away.

**Jaw.** A "Mandible" slider for the open-mouth odontoid: a field joint hinged at the condyles that glides forward as it opens (`core/jointPose.js`), so the chin drops instead of pressing into the throat. Everything below stays still, including the laryngeal air column.

**Knee.** The AP is at −23° and the lateral at −117° of roll, both measured on this leg; the femur views use the same. The Trainer gains "Knee · 2 views".

**Checked:** films for every view, traced and in the app; skin renders from all sides; knee and ankle landmarks re-pinned to the bone; `npm test`: 184 pass.

---

## 2026-10-24

### Room set-ups, a new tube, realistic modes, phones throughout — [#78](https://github.com/mrtethlab/RadSim/pull/78)
**X-ray room set-up.** A Room panel picks Wall stand, Table or Free detector (the original room).
- *Wall stand:* the room's physics frame is stood upright by one rotation, so the physics is unchanged. The SID defaults to 180 and the barium study goes erect.
- *Table:* a floating tabletop with rails, a bucky tray and a pedestal.
- *Real OID:* the tabletop (5 cm) and the stand's cover (3 cm) go through `restHeight()`, so their magnification and air gap are in the image and the readout.
- *New tube:* ceiling-suspended on a telescoping column, with a touchscreen collimator showing the live field, SID and filter. Camera orbit, Tube POV, marker drag and palpation all work through the room frame.

**Realistic X-ray / Realistic CT.** Two experimental home cards force the Python GPU engine, the High DR matrix and the realistic CT detector with every feature on. Online they are greyed out ("Local only") and on phones desktop-only; the engine, resolution and detector controls now appear only in these modes.

**Phones.**
- `touch-action:none` on the 3D view fixes rotate against page scroll on iOS, with pinch zoom and two-finger pan;
- IV has a phone layout with a touch pad for traction, rotate and advance;
- the Trainer opens on its chooser, and the tab bar no longer shows over the home screen.

**Checked:** `npm test`: 182 pass, build clean; in the browser on desktop and a 375×812 phone.

---

## 2026-10-23

### IV: fishing for a vein, side-wall entry, kinder rules, a real flush — [#77](https://github.com/mrtethlab/RadSim/pull/77)
Changes to the IV mode from its first review.

**Technique.**
- *Fishing:* with the needle in the skin but short of the vein, Q/E turns it about the entry point, and it can be pulled back and advanced again.
- *Side-wall entry:* with traction held the vein stays put; without it the vein rolls off as fast as it is pushed.
- *Across the vein* is judged where the vein is punctured, so fishing can correct a bad entry. Traction is needed only until then.
- *Kinder rules:* out-of-order steps cost points only when critical; the port cap can come off any time before the syringe; the Tegaderm passes when it covers the site and the catheter's wings.
- *Bug fix:* a catheter already in the vein before the flash showed left the Flashback step unfinished and threading refused. Lowering the angle now completes it.

**Look and feel.** A PosiFlush-style syringe in a tear-open sleeve, flushing half as sensitive to the mouse, glove fingertips, the angle as a number in Assessment, and, on harder difficulties, veins that come and go along their length so the path has to be found by touch. The camera eases between views.

**Checked:** `npm test`: 182 pass; the fishing and flashback tests fail with the old behaviour back. The procedure was run in the browser.

### IV placement: a new mode for peripheral IV cannulation — [#76](https://github.com/mrtethlab/RadSim/pull/76)
A new **IV Placement** mode, after CT on the home page, built from the IV Simulation Mode design doc.
- **Procedure:** 21 steps at three sites on the existing arm and hand models: the antecubital fossa, the radial forearm and the dorsal hand.
- **Modes:** Guided (a checklist, out-of-order steps blocked), Practice (flagged live, scored at the end) and Assessment (no hints, pass/fail). Difficulty sets how much of the veins shows, down to palpation only.
- **Catheters:** 20G, 22G and 24G.
- **Prep table:** every supply, each opened in ministeps: the swab torn and drawn out, the IV pack peeled and its seal broken, the flush pouch torn open and the syringe uncapped, the spent needle into the sharps container.
- **Insertion:** the vein tents, flattens and rolls under the needle. The angle must be 15–30° to pierce, then lowered to ≤10° once the flash shows to thread. Going across the vein (45° or more) fails the attempt; a steep thread catches on the back wall.
- **Blood and flush:** blood backs up the extension set slowly past the needle and fast once it is out. The flush needs a pull-back first and is judged against the gauge's rated flow (3, 6.5 or 10 mL/s).
- **Scoring:** the design doc's error table, out of 100, with a debrief, a timeline, an insertion trace and a cross-section cut along the needle.

**Checked:** `npm test`: 177 pass, 31 for the IV engine, each new test failing with its bug put back; the full procedure run in the browser at all three sites.

### Hand: anatomical soft tissue, and films that show it — [#75](https://github.com/mrtethlab/RadSim/pull/75)
**Why.** The hand's soft tissue was a uniform shell on the skeleton (5 mm round every phalanx, 9.5 mm round the palm), so the fingers were waisted at every shaft and the palm as thin in front as behind. The extremity LUT's detail processing mapped the tissue into the bone's range, so the fingers read as bare bone.

**The model** (`build_hand.py`):
- the rays are found on the bone and each knuckle is snapped to the narrowest section near its joint gap;
- the palm's cover is 18 / 10 / 6 mm palmar / side / dorsal, with a 22 mm thenar and 20 mm hypothenar;
- the fingers follow their bones at about twice their width, taken from the user's adult reference films, and only narrow from the web to a round tip;
- the border knuckles, which stood 1.1 and 0.75 cm proud on the lateral, are held within 3 mm of rays 2 and 3;
- the wrist and forearm are ellipses on each slice, morphing into the palm over 25 mm;
- layers of skin, fat, muscle and tendon.

Fingers three bone-widths wide, and straight tubes about each finger, were tried with the user and rejected.

**The film.** A new `hand` LUT for all 8 hand-model protocols, without DR detail processing (it smeared the cortex) and windowed so the finger envelope shows grey.

**Checked:** DI −0.38 to +0.37 on the 8 protocols; the hand series passes at its ideal setup and the wrist series on positioning; landmarks and centring re-measured (the bones moved 6.8 mm in the new crop); `npm test`: 157 pass.

---

## 2026-10-22

### Joint posing across a pool of workers — [#74](https://github.com/mrtethlab/RadSim/pull/74)
Follow-up to #73: a joint pose is now made by several CPU cores at once.
- **Split:** `poseVolume` (`core/jointPose.js`) became a plan pass, independent output slices and the crease fold, so any split gives the same volume.
- **Pool** (`core/poseWorker.js`): up to 6 workers on desktop, 2 on phones and iOS, handed 16 chunks each as they come free (at 3 a worker, the chunk holding the knee's crease took 0.9 s while the rest idled). No SharedArrayBuffer, which GitHub Pages cannot enable; with no worker the pose is made on the page as before.
- **Bug fixed:** each worker now remembers which model it holds. After switching subject and back, a worker held the other model and the pose silently fell back to the page, freezing it.

**Measured** in the app, one worker → six: lateral knee 1302 → 671 ms, knee 90° 2441 → 797 ms, AP foot 833 → 318 ms, neck 2261 → 683 ms, knee 90° plus ankle 6480 → 2498 ms. The volume is byte-identical to a single pass.

**Checked:** `npm test`: 156 pass; a new test poses in 2, 5 or 9 chunks in any order and fails if a chunk's slices are misplaced.

### Joint posing: 2–11× faster, posed ahead of the exposure — [#73](https://github.com/mrtethlab/RadSim/pull/73)
**Why.** The first film of a bent joint took 2–4 s (lateral knee 3714 ms, AP foot 2960 ms), nearly all of it resampling the volume into the pose; the ray-cast is about 300 ms either way.

**Fixes** (`core/jointPose.js`):
- *Round-off bug:* a point a joint does not move came back as (p − c) + c, off in the last bit, so the whole proximal limb counted as moved and took the slow path. It now returns p itself.
- *Faster paths:* rows outside the moved region are copied with their vacated stretches zeroed; inside it, only coarse cells holding moved tissue are searched; chains skip the crease solve beyond its reach; crease smoothing uses running sums.

**Latency.** A pose is cached by its angles as applied, so a protocol's and the Trainer's identical poses share an entry. Posing starts as soon as the joints are known (a protocol picked, a Trainer view opened). The cache is capped at 480 MB, 160 MB on phones. `radsimQC.timing()` reports an exposure by phase.

**Results.** Voxel for voxel the same on 12 poses. In Node, knee 25° 2253 → 993 ms and knee 45° plus ankle roll 40841 → 3697 ms. In the app, posing takes 1302 ms (lateral knee), 833 ms (AP foot) and 433 ms (lateral elbow), and the Trainer's ideal films are ready before the exposure.

**Browser compatibility**, audited statically (run in Chromium only): WebGL 2 makes Safari 15 the floor, with everything working from Chrome 105, Firefox 121 and Safari 15.4. `dvh` gets a `vh` fallback, `-webkit-backdrop-filter` and a `color-mix()` fallback are added, and the phone cache budget covers every iPhone and iPad.

**Checked:** `npm test`: 155 pass; the two new tests (an unmoved point comes back bit for bit, a roll keeps the tissue at its crease) fail with their fix reverted.

### Limb models, three new series, joint rolls and a neck — [#71](https://github.com/mrtethlab/RadSim/pull/71)
**One patient, one part.** The arm and leg models are rebuilt from one healthy patient (z053) by `build_limbs.py`:
- each limb is separated from its neighbours along the skin, with tubes and sheets pared off;
- the leg is at 1 mm, so the lateral foot shows its tarsals as a true lateral;
- the soft tissue is flat or convex, never concave, with at least 2 cm over every bone (easing to 1 cm at the wrist and ankle). The medial epicondyle no longer pierces the skin;
- both limbs are baked into the anatomical position, palm up and the foot at 90° to the leg (`bake_pose.py`).

**Display.** A new `limb` LUT gives the extremity films transparent grey soft tissue with the bone detail clear: no detail processing, and headroom above the densest bone. This also removes the elbow's line artifact.

**Series.** The Trainer gains foot ×3, elbow ×4 and cervical spine ×6, with palpation marks for the head, neck and arm.

**Joints.**
- *Rolls:* the wrist, elbow (pronation and supination spread along the forearm), knee and ankle now roll, and the ankle inverts. This allows a pronated hand or a mortise ankle.
- *Skin:* dorsiflexing the ankle no longer domes the skin or tears the heel into it. The room's skin is drawn taut over a bend and folds on the crook's bisector inside it. The bones keep their exact rigid map.
- *Neck:* the head and neck model flexes, extends, tilts and rotates. Each point turns by its own share of one rotation, read from a weight grid made from the CT's labels:
  - the skull and jaw turn whole;
  - C1 to C6 turn progressively less;
  - C7 and the shoulders stay still.
- *C-spine judging:* the Trainer's C-spine views now judge the chin. The AP views want it raised about 10°, measured from this patient's incisor–mastoid line.
- *Performance:* posing runs in a Web Worker, sliders move in 5° stations, and the last three poses are cached. Dragging went from about 7 fps to 0 ms per input.

**Clean-up.** The GPU-only hand and shoulder models and the 1 mm lumbopelvic model are gone. The line-pair gauge shows again.

**Checked:**
- every new view passes at its ideal setup;
- the chart recalibrated within ±1 DI;
- the neck checked in projections and on the room mesh at flexion 40°, extension 50°, tilt 30° and rotation 60°;
- `npm test`: 153 pass. The new tests fail when their fixes are reverted.

---

## 2026-10-21

### X-ray: Palpate drawer, 43×43 receptor, resolution under Simulation — [#69](https://github.com/mrtethlab/RadSim/pull/69)
- **Palpate drawer:** the Trainer's Palpate… menu is now in the x-ray sandbox too, as a **PALPATE** pull-out under BARIUM. Each landmark measured on the subject (ASIS, crests, jugular notch, styloids, malleoli…) toggles a red mark on the skin that follows the patient. A subject with none has the tab dimmed, with the reason on hover.
- **43×43 receptor:** added beside 25×30 and 35×43. It takes a square matrix, so its pixels stay square.
- **Detector resolution:** the ray-cast matrix moved from Detector to Simulation, beside the compute engine that pays for it.

### Trainer: films that look like the textbook's — [#68](https://github.com/mrtethlab/RadSim/pull/68)
**Lateral L-spine.** The ideal lateral L-spine field was 33 cm wide and the film was a flat white band:
- *Why the field was so wide:* "midcoronal" had been measured as halfway between the skin front and back, which on this deep abdomen lies in front of the vertebral bodies.
- *Fix:* the spine laterals now centre on the vertebral column (measured on the bone) and require only the column, from the front of the bodies to the spinous processes. The lateral lumbar field is 20 × 37 cm.
- *Why the film was flat:* a strip of thin tissue at the back of the field pinned the auto-window.
- *Fix:* the spine laterals take their display window from the middle of the field, as DR body-part processing does. The bodies, discs and spinous processes now read at full contrast.

**Other fields fixed:**
- the wrist (metacarpal bases, forearm along the film: the arm is turned 25° to line it up);
- the ankle (23 cm long, not 30);
- the AP and lateral T-spine.

**Grading.** Collimation is graded per axis:
- within the inch (and half an inch) passes;
- open by up to half the ideal field again is marked;
- open beyond that is a repeat.

Positioning allows 2° in any axis, and the mortise takes its textbook 15–20° range.

### Home card and a Contrast Tutorial — [#67](https://github.com/mrtethlab/RadSim/pull/67)
- **Home card:** Trainer sits beside Open in its style; the amber ▶ is for tutorials only. "Barium" became "Barium Tutorial".
- **Contrast Tutorial:** the injector steps left the CT tutorial for a 13-step Contrast Tutorial on the CT card. It covers a vascular subject, scouts, the injector, agent, site and circulation, bolus-tracked timing, the study, and reading the phase.
- **Tutorial scrolling fix:** tutorial targets hidden in the scan-group table's horizontal scroller now scroll into view.

### Trainer mode — [#62](https://github.com/mrtethlab/RadSim/pull/62), [#63](https://github.com/mrtethlab/RadSim/pull/63), [#65](https://github.com/mrtethlab/RadSim/pull/65)
The sandbox let a student do anything and judged only the exposure. The Trainer, entered from the X-ray
home card, takes a routine series view by view as a practical exam does. The steps are:
1. position the patient (roll, tilt, turn, place on the table, bend the joints);
2. centre the field on the named point;
3. collimate to an inch beyond the required anatomy and place the side marker;
4. expose.

Each film is then marked on position, central-ray angle, centring distance, required anatomy, collimation
and marker. The faults are drawn on the film, and a reference film made with the ideal setup hangs beside it.
- **Series:** hand ×3, wrist ×4, ankle ×4, chest ×2, thoracic and lumbar spine ×2: 17 views.
- **Centring points:** measured on each model's bone where Bontrager, Lampignano and McQuillen put them, for
  example the 3rd MCP joint for a PA hand, the midpoint of the malleoli for an AP ankle, and T7 for a PA chest.
  T7 cross-checks against a disc count from L4–L5 at the iliac crest.
- **Palpate…:** marks bony landmarks (ASIS, iliac crest, styloids, malleoli, jugular notch…) in red on the skin
  over the measured bone.
- **Joints:** the limb models now bend at the wrist, elbow, knee and ankle. One map moves the voxel volume
  the x-ray traces, the mesh and every landmark. A hand or wrist must have its 3rd metacarpal in line with the
  distal radius, and the scanned hand rests 26° ulnar, so the student radially deviates it. The scaphoid
  view needs 15–35° of ulnar deviation. The lateral elbow and knee protocols now expose flexed.
- **Side markers:** a marker can be laid face down. A PA trunk film is hung as if facing the patient, so its
  marker must be pronated; on every other view a pronated marker reads backward and is marked wrong.

Checked in the app:
- Every ideal setup passes.
- A face-up marker on the PA chest, a pronated one on the lateral, and the hand left at its rest deviation
  each fail with the reason.

### Smooth skin for every body model — [#64](https://github.com/mrtethlab/RadSim/pull/64)
Every model but the hand showed the voxel staircase in its skin, because its mesh was cut from a
0/1 mask without smoothing. The other eight models now get the hand's treatment, built from the shipped
volumes:
- a blurred occupancy of the patient alone;
- marching cubes at about 2.6 mm, then Taubin smoothing;
- one skin tone, written in linear colour as glTF expects.

The physics never reads the mesh, so images and doses are unchanged.

## 2026-10-10

### CT size-specific dose and Dose Check — [#60](https://github.com/mrtethlab/RadSim/pull/60)
CTDIvol is the dose to an acrylic phantom whoever is scanned. The planned range's water-equivalent
diameter is now measured on the anatomy the scan will image (rays across five slices, weighted by
attenuation relative to water) and CTDIvol is corrected by the AAPM Report 204 fit: the default
chest/abdomen/pelvis measures 32 cm, so 11.0 mGy CTDIvol is 12.6 mGy SSDE. Dose Check (NEMA XR 25,
AAPM values) flags a series over 80 mGy head or 50 mGy body CTDIvol, or over 1000 mGy accumulating at
one level (repeat or overlapping series, a monitoring level fired many times), and START then asks
for confirmation.

### Fluoroscopy dose-rate limit — [#59](https://github.com/mrtethlab/RadSim/pull/59)
On the large lumbar subject the automatic brightness control had railed at 110 kV / 10 mA, about
170 mGy/min at the reference point, roughly twice the 88 mGy/min any fluoroscope may deliver in
normal mode. The mA is now clipped at that ceiling and the control climbs in kV alone; the rate
readout says LIMIT. A lower pulse rate buys more mA per pulse (4.7 mA at 15 pps, 9.4 at 7.5).

### Fluoroscopy staff dose and the tube over the table — [#57](https://github.com/mrtethlab/RadSim/pull/57)
The fluoro room showed the patient's reference air kerma and nothing of the operator's dose. Scatter
is now worked out from where the beam enters the patient, strongest back toward the tube and weakest
through the patient, to the eyes, thyroid, trunk and legs of an operator who chooses a side, a distance
and their lead (apron, collar, glasses, ceiling shield, table skirt), with an effective dose by the
two-dosimeter (Niklason) method. The C can now be turned over the table. Measured on the lumbar
subject: tube under the table, eyes 1.1 and legs 6.0 µSv in 3 s; over it, 6.6 and 1.1. On a lateral
the tube side's eye dose is 6.5 times the detector side's. The patient's skin dose is taken at the
real entrance rather than the reference point: raising the column 25 cm leaves the console's air
kerma unchanged and multiplies the skin dose by 5.2, and the source-to-skin readout warns under 30 cm.

## 2026-10-09

### Side markers — [#54](https://github.com/mrtethlab/RadSim/pull/54), [#55](https://github.com/mrtethlab/RadSim/pull/55)
There were no L/R markers, so neither the wrong-side error nor the collimated-off error could be
taught. In x-ray, an R or L lead letter lies on the receptor: dropped at the field edge or dragged in
the room, it prints white only inside the collimated field, and reads correctly on the film as hung
whatever the roll. Each exposure is then judged: no marker, collimated off or clipped, wrong side
on an AP or PA (from the patient's actual roll), wrong letter on a lateral (named for the side to the
receptor), on the midline, or over the anatomy of interest. A trunk fills its field, so an edge
marker lying on the flank is accepted; the warning needs the letter over tissue and inside the
central part of the field. Fluoro orients its image on the display, so it gets an electronic R worked
out from the geometry that follows every flip and turn; moving the patient toward their right
moves the spine toward the R, flipped or not.

### X-ray patient dose — [#52](https://github.com/mrtethlab/RadSim/pull/52)
The x-ray console showed the detector's dose (EI, DI) and nothing of the patient's. Each exposure
now reports the entrance surface dose (skin kerma on the central ray, with backscatter), the
dose-area product, and a running DAP total for the patient, repeats included. The focus-to-skin
distance is found on the central ray as the caliper finds thickness, and the AEC's delivered mAs is
used, not the backup. The scale is a typical tube output (50 µGy/mAs at 1 m at 80 kV): the chain's
own units come from the EI calibration and are about a quarter of a real tube's. Measured: PA chest
0.28 mGy and 0.2 Gy·cm²; half the field halves the DAP and leaves the ESD; a 31 cm pelvis charted to
100 mAs reads 13.6 mGy, which is what that technique costs. A tutorial step asks for a tighter
field and checks the DAP fall.

### Audit 2, group 1: bugs across the modes — [#50](https://github.com/mrtethlab/RadSim/pull/50)
A PA chest hung mirrored, with the heart on the viewer's left: the display mirror now follows the
roll each image was taken at. On a frozen ultrasound image the knobs re-scanned under the FROZEN
label and left the calipers on new anatomy; gain, dynamic range and TGC now act on the frozen
frame, and anything that changes the acquisition unfreezes first. DXA compares each scan with the
previous scan of the same site, classifies under-50s by Z-score per ISCD, and its report names the
male reference it uses for men. CT counts the bolus-tracking exposures in the study DLP, shows the
unmodelled gantry tilt as n/a, and Quick mode keeps quantum noise on. Space on a focused dropdown
no longer fires the rotor, a focused slider no longer swallows the fluoro pedal, and an arrow key
no longer turns the tutorial page while it moves the table. Also: the mammo QC slab's dose, the
fluoro alarm acknowledge, and two dead tutorial targets, now guarded by a test. Each new test was
checked by putting its bug back.

### CT HU offset and noise floor — [#48](https://github.com/mrtethlab/RadSim/pull/48)
The CT preview read soft tissue about 130 HU low. Checked pixel by pixel against the phantom's
own HU, the reconstruction itself is exact: a water cylinder comes back within 0.2 % in every
detector mode. The scan group, however, still had the 25 cm head field from the previously
loaded patient, so on a 40 cm abdomen every projection was truncated. The SFOV now widens to fit
a new patient, and the scan table warns when a patient is wider than the field. That exposed a
second bug: the detector's electronic noise grew with mAs, so on thick patients a quarter of the
mAs raised the noise only 1.4×. Electronic noise is now fixed, while the dynamic-range clip that
draws metal streaks stays relative to the beam (streaking unchanged). Noise was recalibrated in
the proper field: about 15 HU in the preview and 13–14 HU in the full reconstruction for the
default abdomen. #42's figures had been measured in the truncated field.

### Radiograph display centred on the LUT — [#46](https://github.com/mrtethlab/RadSim/pull/46)
Thick parts beside raw beam (AP pelvis, cervical spine, skull) displayed washed white: the
auto-window's low end was set by the thin tissue at the edge, so the anatomy filled only the
top fifth of the grey scale. The low end now rises just far enough for the median anatomy to sit
on the exam LUT's centre, capped so no more than about an eighth of the anatomy burns out.
Scored on the same exposures of all 40 protocols, the anatomy's tonal spread went from 0.62 to
0.91 on an AP pelvis, 0.64 to 0.81 on AP cervical and 0.39 to 0.84 on a lateral skull. No exam got
worse, and hands, feet and the chest are unchanged.

### Cervical spine centred on C4 — [#45](https://github.com/mrtethlab/RadSim/pull/45)
The cervical landmark had been sitting on C1. With the arms raised in this CT the neck's bone
section narrows at the atlas, so both cervical views were centred 4.8 cm high. The CT's own
vertebra labels (seven masks, about 0.4 MB, fetched with a new `--only` option) were
registered to the model (99.8 % of label voxels land on bone), and the landmark is now the C4
vertebral body. AP cervical is read by caliper like the trunk: this neck measures 18 cm, so mAs
goes from 12.5 to 50 and the film reads DI −0.6 (it read −8.4 on C1). Lateral cervical stays an
approximate view, because at C4 the beam crosses both raised arms.

### Docs — [#43](https://github.com/mrtethlab/RadSim/pull/43)
The README was UTF-16 and described a prototype; it now covers the seven modes, the live site,
running and testing, and where the patients come from. The DXA tutorial gained steps for
driving the arm to the laser and for the foot brace, and its mineral-loss figures were
re-measured (L1–L4 T +1.6 → −1.7 at 30 % → −2.8 at 40 %).

### CT quantum noise calibrated and on — [#42](https://github.com/mrtethlab/RadSim/pull/42)
Measured with a new QC hook (the same scan with and without photon statistics, subtracted):
the full 512² reconstruction already read a clinical 11–13 HU in a default abdomen, but the
quick preview, which is what you see by default, read about 40. Its photon base was raised to
match, giving 11.5–13.3 HU, with a quarter of the mAs doubling it as it should. Noise is now on by
default.

### Ultrasound measurement — [#41](https://github.com/mrtethlab/RadSim/pull/41)
A centimetre depth scale with the focal-zone marker, calipers on the frozen image (a 3.00 cm
separation reads 3.01 cm), and six exam presets.

### Fluoroscopy workflow and a readable spine — [#40](https://github.com/mrtethlab/RadSim/pull/40)
The live and reference monitors float over the room instead of scrolling away with the
controls. Dragging the live image floats the table, the scroll wheel and arrow keys drive the
C-arm, and LIVE LOCK (not a real machine feature) holds the beam on. For anatomy: a new 1 mm
lumbar-spine-and-pelvis subject with bone kept as eight density grades instead of two, a
flat-panel display curve, recursive noise reduction, edge enhancement, and 8× the detector
quanta at unchanged technique and dose. An AP spot film now shows pedicles and spinous
processes, and a 15° oblique moves the pedicle as it should. The 1.5 mm source CT still limits
the finest posterior detail.

### Dose readouts follow their controls; lead K-edge — [#39](https://github.com/mrtethlab/RadSim/pull/39)
A FILM press that found the fluoro workers busy left every later pulse dosed and filed at 12×;
the boost now belongs to the one pulse. DAP now counts the field the shutters leave rather than
the whole iris. Mammography glandular dose now follows the Dance method, so the target/filter
counts. Lead's 88 keV K-edge is modelled, and its todo test became a real one.

### Protocols choose their AEC chambers — [#38](https://github.com/mrtethlab/RadSim/pull/38)
Standard chamber choices per exam. The lateral pair over the lungs for a PA chest is the one
that matters: on the centre chamber a chest burns out at DI +6.3.

## 2026-10-08

### Technique chart calibrated — [#36](https://github.com/mrtethlab/RadSim/pull/36)
At chart technique the 40 x-ray protocols read DI −7.6 to +8.8, and a KUB and an AP pelvis of
the same patient at nearly the same mAs read 10 DI apart. Every protocol was exposed in the
app and the same exposures re-read under each candidate fix, which found four causes. The
exposure index took the brightest 2 % of the field to be raw beam, wrong when the field has
none; it now compares against the open beam. The scatter fog followed the mean primary, which
the thinnest tissue at the field edge dominates (2.5× the abdomen's own signal on an AP
pelvis, behind a grid); it now follows the median. The EI read every exam's thinnest anatomy;
it now reads the lung fields for chest and the median anatomy elsewhere, as DR systems do. The
trunk subject is 31 cm thick against the chart's 22 cm adult; trunk and skull entries now
state their thickness, and the console measures the patient along the central ray and scales
mAs to match, on screen. The chart mAs was then calibrated per exam, the AEC re-based on a
uniform phantom (a chest on the wrong chamber now burns out the lungs, as it should), and the
trunk laterals re-centred on the vertebral bodies. Result: 35 of 40 exams within ±0.8 DI. Not
calibrated, and said why: AP/lateral cervical (landmark at C1; arms raised in the CT), lateral
forearm/elbow (arm against the trunk), lateral lumbar −1.6 (600 mAs ceiling).

### Legs turned at the hip — [#34](https://github.com/mrtethlab/RadSim/pull/34)
The CT volume has the legs in neutral, so each femoral neck points about 20° forward of the
table and projects foreshortened. Each femur is now cut out of the volume (a 3 cm ball
around the head separates it from the acetabulum) and turned about its own head, so the
joint stays seated while the pelvis stays put. The head centres are measured by the landmark
tool and checked on orthogonal slices. AP pelvis sets the legs 15° in; the DXA femur defaults
to 20° in (the foot brace), with a control to show what happens without it. Measured: the
lesser trochanter stands 2.0 / 1.2 / 1.0 / 0.8 cm proud of the shaft at 30° out / neutral /
15° in / 25° in. DXA neck BMD is 0.934 / 0.757 / 0.701 at 20° out / neutral / 20° in, so the
default hip report now reads osteopenia (neck T −1.3). Also fixed: a protocol that loaded a
new subject lost its kV to the subject default (AP pelvis went out at 120 kVp, not 80).

### X-ray protocols position the patient — [#32](https://github.com/mrtethlab/RadSim/pull/32)
Protocols used to set only the technique: a lateral chest was exposed supine and labelled AP,
29 of 40 projections loaded no model, and nothing was centred. Each projection now has a
subject, a roll, a tube angle and an anatomical landmark to centre on; the patient is moved so
the landmark sits under the central ray. Landmarks are measured from the models' own bone by
`tools/measure_landmarks.py` (joint-space valleys; bones counted per slice for the hand and
arm; the pelvis midway between the ASIS and the symphysis). Checked by tracing the posed
phantom: single-bone joints land within 0.15 cm of the central ray. Five views that a rigid,
straight limb cannot produce are flagged approximate on screen.

### CT dose readout and HU ROI — [#31](https://github.com/mrtethlab/RadSim/pull/31)
CTDIvol, DLP and an effective-dose estimate per scan group and per study; a draggable HU
region of interest on the slice viewer. Noise and dose now share one definition (effective
mAs = mA × rotation time ÷ pitch) — pitch had been missing from the noise model. Measured:
a quarter of the mAs raises noise 2.03×, doubling the pitch 1.414×.

### Unit-test harness — [#30](https://github.com/mrtethlab/RadSim/pull/30)
Node's built-in test runner, no dependencies. Pins the numbers that had only ever been
checked by hand (detector noise, K-edges, DXA level finding and hip regions, the CT clock).
Every fixed bug was re-introduced to prove the suite catches it. The runner refuses to pass
if no tests ran. The tests gate the Pages deploy and run on every pull request.

### Load each room's assets on entry — [#29](https://github.com/mrtethlab/RadSim/pull/29)
The home screen cost 9.7 MB on the wire; it now costs about 0.37 MB. Rigs, models and sounds
load when their room is first opened. Fixed four things that had only worked because
everything was preloaded (fluoro hung, x-ray could expose an empty table, CT timing could fall
back to a guess, and overlapping subject loads raced). The public site no longer polls for a
local compute backend.

### Correctness fixes — [#28](https://github.com/mrtethlab/RadSim/pull/28)
- **Ultrasound** echoes now pay attenuation both ways; penetration fell from 19 cm to 6.4 cm
  at 12 MHz, in line with real probes.
- **CT** multiphase scans fire each group at its own moment in the bolus.
- **DXA** hip diagnosis uses the lower of the femoral neck and total hip, per WHO/ISCD.
- **X-ray** a failed exposure no longer locks the console.

### Audit
A full review of missing features and improvements across all modes. One headline finding
(uncompressed volumes) was disproved on checking; the rest were acted on above or recorded
as open in `SUMMARY.md`.

---

## 2026-08 — Bone densitometry — [#27](https://github.com/mrtethlab/RadSim/pull/27)
The DXA mode: a scanned densitometer room, lumbar L1–L4 and proximal-femur analysis, and a
GE Lunar-style report.
