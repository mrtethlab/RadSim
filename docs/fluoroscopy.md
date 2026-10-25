# Fluoroscopy mode — plan

Live screening: a beam you drive with your foot, an image chain that trades dose for noise
in real time, and anatomy that *moves*. This is the mode the "In development" card has been
promising, and it is where three existing engines meet: the x-ray raycaster (the image), the
contrast solver (DSA and roadmapping), and the barium study (which finally gets its real
home — a pulsed image on a clock is what a barium study *is*).

Status: **shipped** — phases A–E and G built, measured and merged; F dropped (see the
phase table). The plan below is kept as written, with per-phase exit results recorded
in §7; deviations from plan are noted where they happened, with reasons.

Decisions taken (2026-08-12, with ML):
- Barium studies **move to fluoroscopy**; the x-ray BARIUM panel stays unchanged for now.
- **GE OEC C-arm first**; the Siemens Artis Zee table follows on the same beam plumbing.
- **Authentic pulse rates on a modest image** — all four rates run at true frequency.
- Plan reviewed before implementation begins.

---

## 1. The two machines

One `S.fluoro.machine` toggle, two three.js rigs (the CT gantry pattern), one shared beam
model. Specs from datasheets, rounded; both are teaching geometry, not CAD.

| | **GE OEC (portable C-arm)** | **Siemens Artis Zee (table)** |
| --- | --- | --- |
| Build order | **first** | second |
| Detector | 23 cm circular II field (9") | 30×38 cm flat detector |
| SID | 99 cm fixed | 90–120 cm motorised |
| Motions | orbital 115°, lateral roll ±180°, wig-wag ±10°, vertical 46 cm, horizontal 20 cm | C-arm RAO/LAO ±120°, cran/caud ±45°, table float + height, detector SID travel |
| Typical work | barium studies, ortho reduction, line placement | angiography — DSA, roadmapping |
| Image shape | circle | rectangle |

The patient stays where they are and the *machine* moves — the inverse of x-ray mode's
object-rotate model. Existing `tubeFrame()` geometry generalises: the C-arm defines
source/detector positions from its joint angles; the raycast is unchanged once the frame is
built. The subject lies on a stretcher (OEC) or the Artis table; the Object rotate/tilt
sliders still work (a decubitus swallow needs them, and `giSetPose` already listens).

## 2. The image chain

The heart of the mode. Everything below is per-pulse, because fluoroscopy is not a video
camera — it is a chain of tiny exposures.

- **Foot pedal**: press-and-hold (pointer or spacebar). Beam-on time only accrues while
  held. Release → **Last Image Hold**, tagged LIH on screen — the first thing every
  fluoroscopy course teaches you to use instead of the pedal.
- **Pulse rates 3 / 7.5 / 15 / 30 pps**: the simulation frame rate IS the pulse rate — a
  3 pps screen genuinely updates 3 times a second and feels exactly as jerky as the real
  thing. Dose scales with pulse rate at fixed per-pulse technique: the dose readout makes
  the 30→7.5 pps saving visible, which is the single highest-yield habit the mode can teach.
- **ABC (automatic brightness control)**: per-pulse closed loop on the detector ROI mean —
  the fluoroscopic sibling of the AEC. Pan from lung to abdomen and watch kV/mA climb along
  a characteristic curve (kV-priority, as GE tunes it); park over the spine and see contrast
  fall as kV rises. Manual override available, as on the real console.
- **Noise per pulse**: fluoro runs at ~1/1000 of radiographic mAs per frame, so quantum
  mottle dominates. The existing Poisson noise model applies per-pulse fluence — low pulse
  rate + low dose = the authentically ugly image. This is also what buys the render budget
  (§4): nobody can see resolution that noise has already destroyed.
- **Collimation**: circular iris (OEC) / rectangular shutters (Artis), live on screen.
- **Dose accounting**: fluoro timer with the mandated 5-minute alarm, cumulative air kerma
  and DAP estimated from technique via the existing spectrum fluence — the numbers an
  operator is examined on.
- **Mag modes** (OEC 9"/6"/4.5"): smaller field, sharper image, higher dose rate — classic
  trade-off, cheap to implement (field crop + technique bump). Phase B stretch.

### Vascular package (Artis-flavoured, works on both)

- **DSA**: pedal-start grabs a mask frame; subsequent frames display log-subtracted, so
  only iodine survives. Runs the existing per-site contrast timelines — inject femoral,
  screen the iliacs. Motion during the run wrecks it, which is exactly the point: §3's
  breathing animation + the **breath-hold button** turn "hold your breath" from a rubric
  into a visible artifact you cause and then fix. Pixel-shift and remask controls included.
- **Roadmapping**: peak-opacification image (max of the DSA run) held as an overlay under
  live fluoro — the navigation mode. V1 overlaid the map; wire/catheter simulation was
  explicitly out of scope. *As built since:* the roadmap is SUBTRACTED, vessels white and
  devices black, and a 0.035" guidewire rides the vessel tree — see "Guidewire on the
  roadmap" below.
- **Video recording**: `MediaRecorder` on the fluoro canvas — record loops, replay them in
  a cine strip (the image-history pattern), download as .webm. DSA runs auto-record.

## 3. Animated anatomy

**No new volumes — and, as built, no new FILES either.** The plan's `build_anim.py` +
`anim.json` turned out unnecessary: the pulse worker already holds the volume, so one scan
pass at init derives every moving region from the material ids themselves (~100 ms per
subject, stride-2). Zero build artifacts, and the motion geometry cannot drift from the
data it animates. Implementation notes from the build, all measured: a per-cell warp hook
on the shared tracer cost 5× the raycast (9M uninlinable closure calls per chest pulse), so
the worker carries its own specialised DDA with the warp inlined and `VoxelPhantom.trace`
stays pristine for x-ray/CT; sampling resolution is governed by a drop-rate tier controller
(192→112 px) because no single constant serves both a hand and an animated chest; and ML's
photogrammetry OEC (public/models/rigs/oec_rig.glb, 1.2 MB from the 8.6 MB OBJ) stands in
the room with its C-throat aligned to the isocentre from orthographic mesh analysis — its
beam housings sit 96 cm apart, the real machine's SID to within 3 cm. The scan's 821 fused
fragments were segmented geometrically (`scripts/segment_oec.py`) into FOUR nodes: the
C + tube + II (annulus about the throat centre plus beam-axis fences), the boom arm (the
horizontal member reaching the flip-flop hub, carrying the upper rear handle pair), the
telescoping column, and the static cart (which keeps the lower handle pair). The machine's
own C swings with orbital and tilts ALONE about the flip-flop line through hub and arc
centre — the boom holds still, as the real pivot does; the boom yaws with wig-wag, rises
with lift, slides with extend; the column rises with lift only. All three column motions
move the isocentre itself, so lift magnifies and extend/wig-wag pan the live image — and
the ABC re-meters as the beam crosses new anatomy. A faint cyan line marks the invisible
beam.

The tracer learns time-dependent *warps*: `VoxelPhantom` gets `setAnimTime(t)` and a list
of regions; a sample inside a region's bounding box remaps its lookup coordinate before
reading the volume. Rays outside the boxes pay one bounds check. Four warp kinds cover the
brief:

| Motion | Warp | Driven by | Models |
| --- | --- | --- | --- |
| **Breathing** | diaphragm slab: z-remap tapering over a transition slab (dome excursion 1.5–3 cm, ~14/min) + lung µ modulated with lung volume (density falls on inspiration — a visible lightening, no geometry needed) | cyclic; **breath-hold button** pauses it (and rescues your DSA) | chest, CAP |
| **Heartbeat** | radial scale of the heart ellipsoid, two-phase systole/diastole curve | the contrast panel's **HR slider** — one knob drives the haemodynamics AND the visible beat | chest, CAP |
| **Swallowing** | travelling constriction pulse along the oesophagus centreline — which `<name>.gi.json` already ships (`centreMM` per bin) | event: a **Swallow button**, which also drops a small barium bolus into the existing `GIStudy` so wall wave and bolus move together | head/neck, CAP |
| **Peristalsis** | slow travelling constriction waves along the gut centrelines (segments 49–52, same shipped data) | cyclic, slow; visible where barium outlines the lumen | CAP |

Two properties worth calling out:
- **The barium solver is untouched.** `GIStudy` moves the agent; the warps move the walls.
  They share the centreline data but not state — the mass audit stays exactly as verified.
- **Backend parity deferred**: warps are browser-JS in v1; the Python GPU engine renders
  static anatomy until a later phase teaches it the same remaps. Documented, not hidden.

## 4. The render budget

Measured base: the current 320×400 polyenergetic raycast with scatter completes in low
seconds on desktop. Fluoro's budget per §2's physics:

- ~**256 px circular field** (≈51k rays vs 128k), **2–3 spectrum bins** (a pulsed beam at
  fixed kV needs beam-hardening shape, not 20-bin fidelity), **no per-pulse scatter** (a
  cached scatter fraction from the first pulse at a given geometry), noise applied per
  pulse. Estimate 20–60 ms/pulse — 30 pps plausibly within reach, to be **measured in
  Phase A before anything else is built on top**.
- Raycasting runs in a **web worker pool** (the tracer and materials are dependency-free
  modules); the volume is copied into workers once per subject (no SharedArrayBuffer —
  GitHub Pages cannot set COOP/COEP). Main thread composites, applies LIH/DSA/roadmap, and
  never blocks.
- Warps price in at one bbox test per DDA cell plus the remap inside moving regions —
  estimated 10–30 % overhead, also measured in Phase A.
- Mobile: the pager already hosts new modes; fluoro's Bay page is the live image. 7.5 pps
  default on `body.mobile`, 30 pps available where measurement allows.

## 5. Integration

- The home card graduates: badge off, `data-mode="fluoro"`, tutorial button added (the
  tutorial itself is Phase G — pedal, pulse rate, ABC, LIH, dose, one barium swallow).
- `applyMode('fluoro')` joins the ct.js mode switch; vendor colour themes stay CT-only.
- The BARIUM panel appears in fluoro mode docked as a first-class panel (not a flyout);
  the x-ray flyout copy remains untouched.
- CONTRAST panel (injection sites and all) is reachable in fluoro for DSA.
- Subject selector limited to models with something to screen: chest, CAP, head/neck, plus
  the extremities for ortho C-arm work (static is fine there — a wrist doesn't breathe).
  As built the room takes the shared selector, so the Foot (cut from the lower extremity)
  screens like any other subject; the ankle case below loads it itself.

## 6. What does NOT change

Physics core (materials µ(E), tracer DDA, spectrum), the contrast and GI solvers and their
audits, x-ray and CT modes, the preset pipeline, the mobile pager architecture, themes.

## 7. Phases

| Phase | Scope | Exit test |
| --- | --- | --- |
| **A — pulse loop** ✅ | fluoro mode shell, OEC scene, pedal, 4 pulse rates, worker raycaster, **budget measurements** | screen the hand at all four rates; measured ms/pulse table in this doc |
| **B — image chain** ✅ | ABC loop + manual override, LIH, per-pulse noise, collimation, dose/timer/5-min alarm; mag modes | **passed**: lung 67 kV/1.1 mA → abdomen 110 kV/10 mA (rails, as real machines do on thick views); dose rate ×4.0 from 7.5→30 pps; iris halving cuts DAP/AK exactly 4.0×; alarm fires at 300 s and clears on reset |
| **C — animation** ✅ | tracer warps, lung µ modulation; breathing + heartbeat (chest/CAP), swallow, stomach peristalsis; breath-hold; the real OEC mesh in the room | **passed**: with a fixed noise seed, breath-hold gives bit-identical frames (Δ = 0.00) while breathing/heartbeat/swallow each produce strong frame-to-frame differences; animated chest delivers 58/61 pulses at 15 pps and 115/122 at 30 |
| **D — barium** ✅ | BARIUM panel docked in fluoro (the same live-study flyout x-ray uses); Swallow button = bolus + wall wave together | **passed**: on CAP at fixed manual technique, a 12-minute study changes the live frames by 110 grey levels mean-abs (breathing alone moves 4–15), zero drops at 145 ms/pulse; a Swallow press pours a 15 mL sip into an oesophagus 11 minutes empty and the wave rides the same warped index, so the bolus follows the wall |
| **E — vascular** ✅ | DSA (4-frame averaged mask, 60× acquisition dose on the meter, technique + tier locked), pixel-shift, remask, raw-peak roadmap overlay, per-site contrast in the pulses, MOTION OFF verification pose | **passed**, the whole gradient measured on CAP: motion off → subtraction flat at 6.7 grey mean-dev (the chain is exact); breath-hold → ~52 (the heart and gut keep moving — real abdominal DSA artifact); free breathing → ~80 (ruined); femoral iodine → 9 % of pixels saturate as vessels and the roadmap arms; the overlay darkens 12.8 % of the live field |
| **F — Artis Zee** ✂ | second rig, table float/height, rectangular FD, SID travel | **dropped** (2026-08-13, ML): the OEC covers the teaching brief; the beam plumbing stays rig-agnostic if a table machine ever earns its way back |
| **G — polish** ✅ | recording + cine loops, tutorial, mobile pass, home card graduation | **passed**: armed, every pedal run captures (DSA runs record themselves) — loops play on the monitor and download as .webm; 13-step fluoro tutorial walks pedal → pulse rate → ABC → C-arm → iris → orientation → motion → DSA → cine → dose, every goal achievable; mobile pool-of-1 renders all console groups and pulses at 59 ms |

## 7.1 Phase A measurements (hand, desktop, 4 s holds)

| pps | sampling | workers | fired | dropped | ms/pulse |
| --- | --- | --- | --- | --- | --- |
| 3 | 192 px | 2 | 13 | 0 | 60 |
| 7.5 | 192 px | 2 | 31 | 0 | 56 |
| 15 | 192 px | 2 | 61 | 0 | 56 |
| 30 | 160 px | 2 | **122** | **0** | 42 |

The path there: one worker at 192 px measured 54 ms/pulse (≈18 pps ceiling — 30 pps dropped
exactly half). The pool of two lifted 30 pps to ~23 effective under contention (67 ms/pulse).
Adaptive sampling closed the rest: 30 pps renders at 160 px (0.69× the rays), which upscales
into the same monitor and loses sharpness the per-pulse mottle had already taken. All four
rates now run at true frequency with zero drops. Frames carry pulse ids; a slow old frame is
discarded, never drawn over a newer one. Mobile keeps a pool of one.

## 8. Open questions (small, non-blocking)

1. Pulse beep / alarm audio — use the existing Sound options pattern?
2. Grid on the OEC (real ones have removable grids) — worth a toggle, or noise enough?
3. Dose display units — air kerma mGy + DAP µGy·m², or simplify to one number for v1?

## Breathing, refined against a real chest fluoroscopy run

ML flagged the breathing as artificial: a low-density strip sliding inferiorly and then
resetting, and an exaggerated travelling indent in the skin. Both were real, and both had
the same cause — the diaphragm "slab" was derived from the MIN and MAX z of every voxel
labelled lung, so a handful of stray mislabelled voxels stretched it to the entire volume
(measured on chest/abdo/pelvis: a lung spanning z = 4 to 355 of 356). Its lower edge
clamped to z = 0 with weight 1, so the whole pelvis-to-chest block slid together and was
sheared over 39 cm, and because the weight was flat across most of it the entire region
snapped in 2 mm steps and appeared to reset at end-expiration.

A frame-by-frame analysis of a real PA chest fluoroscopy clip (25 fps, 18 s) gave the
targets to build against:

| | reference | before | after |
| --- | --- | --- | --- |
| moving band | diaphragm and lung fields only | 0–39 cm (whole lower body) | 29–57 cm, centred on the dome |
| pelvis | still | full 2 cm shift | **0.0 mm** |
| lateral chest wall | **29 %** of the dome | 100 % | **30 %** |
| below the domes | dark in the variance map | slid as a block | 0 % motion energy in the lowest rows |

What changed:

- **The dome is located robustly** — per-slice lung counts against a fraction-of-peak
  threshold, not min/max — and WHICH end is the diaphragm is settled by the liver, since
  the liver sits under it. That also settles the z orientation, which differs between
  models and must not be assumed: get it backwards and the dome rises on inspiration.
- **The profile is a bump, not a slab**: a plateau at the dome (the liver goes with it
  nearly as a unit), a cosine taper to zero ~9 cm below and over the lung height above,
  and zero slope where it meets still tissue — which is what removes the seam.
- **The body wall does not move like the viscera.** An elliptical taper about the trunk's
  own axis carries the full shift through the core and a third of it at the surface,
  which is what the 29 % measurement asked for.
- **Quiet breathing is not a sine.** 40 % inspiring, 45 % expiring, 15 % paused on empty,
  flat at every junction — measured wrap discontinuity **0.000 mm**, where the symmetric
  sin² it replaced had no pause at all and read as a machine ticking.

Fluoro pulse cost is unchanged (121–141 ms on chest/abdo/pelvis, 0 dropped) even though
breathing now joins the heart on the recompute path, because the band it touches went
from most of the volume to 28 cm of it.

## Collimation shutters as wires

The shutter pair now draws itself: two dashed leaf edges brought in from the sides and
rotated as a pair, inside the orientation transform so they turn with the anatomy they
are cutting. It is the graphic a real machine paints over the last image so you can
collimate WITHOUT screening to do it — and it is honest, not decorative: with the leaves
at 45 % the wires land within **1 pixel** of where the beam actually stops (beam 148–291,
wires 147–292). Open, close and rotate are tap-for-a-nudge, hold-to-run, the same feel as
the orientation pad, because collimating is the same kind of job.

### The band that was actually the stomach

ML reported a white band still starting at the diaphragm, travelling inferiorly over a
couple of seconds and jumping back. It was not breathing at all — it was gastric
peristalsis. The wave position was `(t · L / 7) % L`, a sawtooth: it swept the length of
the stomach and then TELEPORTED back to the top at full amplitude, so a 35 % dilation
marched down the film and snapped back, forever.

A real wave does not teleport. It starts in the mid-body, deepens as it travels and dies
at the pylorus, so it needs an envelope that is zero at both ends of the traverse — and
then the wrap has nothing left to show. Measured across the wrap: dilation fades
1.72 → 1.11 → 0.63 → 0.28 → **0 %**, holds at zero for ~1.2 s while the position resets
unseen, then fades back in at the top. Worst frame-to-frame change anywhere in the cycle
is **0.18 percentage points** against an 18 % peak. Rate is now 3 per minute rather than
one every 7 s, and the amplitude is halved.

The swallow wave had the same defect from the other end — it ran to the cardia and simply
STOPPED at full 90 % depth, which pops off the image exactly like a teleport — so it takes
the same envelope.

## Ankle ORIF — a Weber B reduced under the C-arm

The ortho C-arm's commonest job, as a case on the Foot (`core/fracture.js`, the ANKLE ORIF
panel). START CASE loads the Foot, breaks its fibula, floats the ankle to the isocentre and
lifts the leg on a radiolucent bump (the height offset): the OEC cannot drop its isocentre
below its own column, so without the bump a horizontal beam passes under the ankle — which is
why every ankle list keeps one on the trolley. The views move the C alone, as they do under
the drapes: **AP** square to the table, **MORTISE** turned toward the lateral side until the
beam is square to the line through both malleoli, **LATERAL** horizontal, medial to lateral.

**The fibula is found on the volume, not read from the landmarks.** In this Foot the shipped
ankle points sit low — `lateralMalleolus` about 2.4 cm below the fibula's actual tip, the
ankle joint centre several centimetres below the plafond — and the lower-extremity models are
being re-cut, so a fracture placed from them would land in the calcaneus. In the proximal
slices a leg is two bone islands; the slender one is the fibula, and the side it lies on IS
lateral (either leg, no landmark). It is followed down slice by slice as the island
overlapping the one above. Where it touches the tibia (the incisura) or the talus the islands
fuse; the fused island is eroded until the bridge breaks, each voxel is given to the core it
is nearest along the bone, and the fibula keeps the cores that lie inside its own section
above. Two things had to be learned from the volume: a distal fibula is a cortical RING round
marrow the segmentation calls soft tissue, and an erosion destroys a ring — without it the
split lost the fibula at the syndesmosis, 162 voxels to 20 between two slices — so each slice's
marrow is filled in first (and the fragment carries its marrow with it, as a real one does);
and a split that would shrink the section by half is refused in favour of the slice above's
section, cut on the far side of the midline to the neighbour. Measured: 10.5 cm of fibula, its
largest section 3.25 cm² (a slice that took in the tibia would pass 4).

**The fracture** is a plane rising 55° from anteroinferior at the joint line to
posterosuperior, centred 3 cm above the malleolar tip — Lauge-Hansen SER, Weber B: at the
level of the syndesmosis, which is what makes it a B. The distal fragment measures 5.8 cm³
(6 % marrow), reaches 3.9 cm above the tip, and its top edge climbs 1.29 cm per cm toward the
back on a lateral. It presents **4 mm lateral, 3 mm short, 10° externally rotated**.

**The displacement is applied to the workers' own copies of the volume**, the way the knee's
rider carries the patella (`core/jointPose.js` rideAlong): the fragment's bone is lifted out —
soft tissue where it was — and set down where the move takes it, eight points a voxel so a
turned grid leaves no holes, marrow first and cortex over it. The box the fragment can reach
is saved as scanned when the fragment arrives and put back before every stamp, so the volume
is always the scanned one plus ONE fragment, wherever it is: reduced to anatomic it is the
scanned ankle byte for byte (tested after several moves), and a case that ends leaves nothing
behind. A move is three numbers and a version with each pulse; the fragment itself (~6000
voxels) goes to each worker once. Measured in the room with a fixed noise seed and the
recursive filter off: two reduced frames are pixel-identical, and displaced against reduced
differs in 10 047 of 310 736 displayed pixels (3.2 % of the field) by a mean 21 grey levels.

**The forceps** (tap 0.5 mm or 1°, hold to run): medial/lateral, pull to length/shorten,
anterior/posterior, internal/external rotation. Nothing on the console says where the fragment
is — the image does, which is the exercise. **CHECK REDUCTION** scores it the way a list
would: length restored within 2 mm (short or long), translation within 2 mm, rotation within
5°, each with what view shows it (length and rotation on the MORTISE, front-to-back only on
the LATERAL), and the screening it took since the case began: beam time, pulses, air kerma,
DAP. The MORTISE angle is this ankle's own: the distal 1.5 cm of fibula against the most medial
bone at the same level and within front-to-back reach of it (the navicular further forward
can be as medial), 20.3° measured, 20° on the button (clamped to 10-25).

Limits: the fragment is rigid and single (no butterfly, no medial or posterior malleolus, no
syndesmotic widening — the talus does not shift with the fibula); bone that overrides bone
reads as bone once, not twice (a voxel holds one material); the case needs the ankle as
scanned (bent joints make another grid, and the panel says so).

## Guidewire on the roadmap

A 0.035" (0.89 mm) wire through a femoral sheath (`core/guidewire.js`, the GUIDEWIRE panel):
pick the right or left groin, INSERT, then advance/withdraw (tap 5 mm, hold ~4.5 cm/s) and
torque the tip (15° a tap).

**The route is the contrast solver's own geometry.** Every vessel voxel carries its
normalised geodesic arclength (`sVol`, the map that puts iodine in the pulses, shared with the
CONTRAST panel and the ultrasound colour box), so a centreline is the centroid of each
arclength bin, smoothed and resampled at 2 mm. On both vessel models 100 % of centreline
points lie within a voxel of their own vessel (98-100 % in the very voxel). A two-means split
for labels that fork within a bin was built, measured to change nothing on the shipped data,
and removed. **Junctions** are where two vessels' voxels touch AND one of them ends there,
arteries with arteries and veins with veins — an iliac artery lies against its vein for its
whole length, and without the rule the two are joined; stray contacts are rejected by requiring the
contact on both centrelines. On CAP: the aortic bifurcation (both iliacs), the arch
(brachiocephalic trunk, left carotid, left subclavian), and the brachiocephalic's own
bifurcation. The iliac veins do not reach the IVC in the segmentation (a ~4 cm gap), so the
panel offers arterial access only; the chest alone, with no iliacs, starts from the
descending aorta's cut end.

**The wire** follows the route with an angled tip (45° over its last 8 mm, less in a vessel
too narrow to hold it) and 15 cm outside the groin through the sheath. At a branch it goes
where the tip points — taken when the tip faces the branch's take-off (cos ≥ 0.64, ≥ 0.8 for a
turn past 90°), otherwise straight on; at a vessel's end it follows a gentle way on (< 60°) by
itself; a sharp turn the tip is not facing stops it, and the panel says so. Withdrawn past a
branch it forgets the choice. Pushed from the right groin with the tip toward the table it
climbs the iliac and the aorta and stops at the aortic root (86 cm on CAP); turning the tip
takes it into the brachiocephalic, the left subclavian, or over the bifurcation into the left
iliac. Torque 0 points the tip at the patient's anterior; the console starts at 180.

**The image is attenuation, not a drawing.** The wire is far below a voxel (1-2 mm), so it is
not voxelised — that would image it 2-5 times too thick. The worker adds its exact chord to
each ray at the beam's three spectrum bins, as steel less the blood it displaces (the same
`muOverBins` tables as every voxel), averaged over a 3x3 grid of rays across the detector
pixel, because a pixel integrates photons over its face: at the coarsest sampling tier a
pixel is 1.24 mm at the isocentre, and rays through pixel centres alone image a 0.89 mm wire
dashed or not at all. Measured: the imaged integral of chord is 0.997 of the wire's true
volume; at 112 px every column it crosses sees it, ±2.5 %; through 12.8 cm of water at 70 kV
the pixel it is centred on falls to 0.30 of the water's transmission, the rows beside it are
untouched, and the frame without the wire is the water's exactly. It goes through the
breathing warp first (a cell at z shows the anatomy from z + s(z), so the wire at z0 is drawn
where z + s(z) = z0), then the flips and the patient's turn — tested against a bone rod
off-centre on every axis, unflipped, flipped and turned. Cost: within the noise of the pulse
(CAP 54 against 58 ms/pulse with and without it, 15 pps, 0 dropped).

**The roadmap is now subtracted**, as the angio suite shows it. The V1 overlay darkened the
vessels on live fluoro — black, exactly the colour of a wire inside them. Now live fluoro is
subtracted against the DSA run's own mask with the iodine put back: the anatomy cancels to
grey, the vessels (iodine in the map, not in the patient now) stand WHITE, and anything that
arrived since — the wire — draws BLACK inside them; a fifth of the plain image is mixed back
for landmarks, and the level is matched on the vessel-free field so a beam a few kV off the
mask still cancels (tested: background 0.50, vessel 1.00, wire 0.21, unchanged under a 0.3
log-unit shift). A wire already in place when the mask was taken cancels; where it moved away
from leaves a faint white ghost; move the table or the C and the map no longer fits — all
real behaviour. In the room the femoral preset (a venous injection: IVC 33 mgI/mL at 33 s,
iliac arteries 11 at 55 s) only arms the roadmap at a manual ~66 kV, and the pelvic roadmap at
that dose is noisy; the wire still reads black inside the white vessel.
