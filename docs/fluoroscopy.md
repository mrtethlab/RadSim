# Fluoroscopy mode — plan

Live screening: a beam you drive with your foot, an image chain that trades dose for noise
in real time, and anatomy that *moves*. This is the mode the "In development" card has been
promising, and it is where three existing engines meet: the x-ray raycaster (the image), the
contrast solver (DSA and roadmapping), and the barium study (which finally gets its real
home — a pulsed image on a clock is what a barium study *is*).

Status: **planning — awaiting review**. Nothing below is implemented.

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
  live fluoro — the navigation mode. V1 overlays the map; wire/catheter simulation is
  explicitly out of scope.
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

## 6. What does NOT change

Physics core (materials µ(E), tracer DDA, spectrum), the contrast and GI solvers and their
audits, x-ray and CT modes, the preset pipeline, the mobile pager architecture, themes.

## 7. Phases

| Phase | Scope | Exit test |
| --- | --- | --- |
| **A — pulse loop** ✅ | fluoro mode shell, OEC scene, pedal, 4 pulse rates, worker raycaster, **budget measurements** | screen the hand at all four rates; measured ms/pulse table in this doc |
| **B — image chain** ✅ | ABC loop + manual override, LIH, per-pulse noise, collimation, dose/timer/5-min alarm; mag modes | **passed**: lung 67 kV/1.1 mA → abdomen 110 kV/10 mA (rails, as real machines do on thick views); dose rate ×4.0 from 7.5→30 pps; iris halving cuts DAP/AK exactly 4.0×; alarm fires at 300 s and clears on reset |
| **C — animation** ✅ | tracer warps, lung µ modulation; breathing + heartbeat (chest/CAP), swallow, stomach peristalsis; breath-hold; the real OEC mesh in the room | **passed**: with a fixed noise seed, breath-hold gives bit-identical frames (Δ = 0.00) while breathing/heartbeat/swallow each produce strong frame-to-frame differences; animated chest delivers 58/61 pulses at 15 pps and 115/122 at 30 |
| **D — barium** | BARIUM panel docked in fluoro; Swallow button = bolus + wall wave together | a swallow screened at 15 pps, LIH spot of the filled stomach |
| **E — vascular** | DSA mask/subtract/pixel-shift/remask, roadmap overlay, per-site contrast | femoral-injection iliac DSA on CAP; breathing ruins it; breath-hold fixes it |
| **F — Artis Zee** | second rig, table float/height, rectangular FD, SID travel | same exam on the table machine |
| **G — polish** | recording + cine loops, tutorial, mobile pass, home card graduation | tutorial goals all achievable; loops download |

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
