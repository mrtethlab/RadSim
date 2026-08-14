# Ultrasound mode — plan

The one modality on the board with no ionising radiation at all — and the one where the
IMAGE is made of physics artifacts. Shadowing, enhancement, speckle and reverberation are
not defects to simulate reluctantly: they are how sonographers read tissue, and the mode
succeeds only if the artifacts are honest enough to diagnose with.

Status: **complete — phases A–F built, measured and shipped.**

Decisions taken while building (the plan's own defaults, confirmed by measurement):
RUQ abdomen is the exam tuned for; Doppler stays a later phase; the probe is a
surface-riding glyph plus a plane indicator.

## 1. What exists to build on

- The fluoro worker-pool loop is the template: a frame is a job, the main thread owns the
  clocks, the worker stays stateless. B-mode is CHEAPER than a fluoro pulse (≈192
  scanlines × ~512 depth samples ≈ 100k samples/frame vs 9M cells) — 20–30 fps is easy.
- The animated-anatomy warps (heartbeat, breathing, peristalsis) transfer as-is: echo of
  a beating heart is the showpiece the mode is built around.
- The vessel maps (`sVol`) and the contrast panel's HR slider set up Doppler later.
- The voxel subjects provide the anatomy; what they lack is acoustic properties — one
  table fixes that.

## 2. The physics (v1: ray acoustics, honestly faked where stated)

Per material id, a new table in `materials.js`: **impedance Z, attenuation (dB/cm/MHz),
speed** (speed ships in the table but v1 renders at a fixed 1540 m/s; refraction and
speed-error artifacts are explicitly out of scope).

Per scanline, marched through the (warped) volume from the probe face:

- **Reflection** at id boundaries: amplitude from the impedance mismatch ((Z₂−Z₁)/(Z₂+Z₁))²,
  plus fine scattering within tissue (speckle — multiplicative Rayleigh-ish noise, seeded
  per frame like the fluoro mottle).
- **Attenuation** accumulates with depth × frequency; the echo train is what returns.
- **Shadowing** falls out of the march for free behind bone and gas (near-total loss);
  **enhancement** behind fluid likewise (nothing lost crossing it). No special cases —
  the artifacts are consequences, which is the standard this project holds.
- **Reverberation**: cheap post-pass repeating strong shallow interfaces down the line
  (A-lines); comet tails behind metal.
- **TGC** is applied at DISPLAY, not in physics: gain sliders per depth band, and the raw
  frame underneath — set them wrong and see exactly what the real knob row is for.

## 3. The probe and the room

The novel UI: no tube, no pedal — a **probe held against the skin**.

- Two probes: **curvilinear** (3–5 MHz, sector fan — abdomen) and **linear** (7–12 MHz,
  rectangle — superficial). Frequency is the resolution-vs-penetration trade, and
  switching probes mid-exam is how that lesson lands.
- **Placement**: drag the probe across the 3D body surface (raycast to the skin, the
  probe glyph rides the surface); rotate and rock it with modifier-drag or sliders. The
  imaging plane is drawn in the room as a translucent fan — the same beam-legibility
  language as the fluoro rig.
- Freeze / live toggle, depth, overall gain, TGC rows, focus marker.
- The monitor reuses the fluoro display plumbing (viewer pane, cine recorder, bay Image
  view) — the whole Phase G kit carries over unchanged.
- **M-mode**: one selected scanline scrolling against time — with the beating heart from
  the warps, this is the classic image for free.

## 4. Phases

| Phase | Scope | Exit test |
| --- | --- | --- |
| **A — acoustics** ✅ | acoustic table (Z, attenuation, backscatter, speed) for every material id; pulse-echo scanline march; beam PSF; scan conversion; curvilinear + linear probes; live sweep | **passed, and all three artifacts are consequences — there is no shadow code and no enhancement code**: behind bone/gas the display reads **0.000** against a clear-path 0.295 (a total shadow); behind fluid it reads **0.575**, nearly 2× the clear path, purely because the TGC compensates for an assumed uniform 0.5 dB/cm/MHz that the fluid does not have; the gallbladder itself reads **0.119** against liver's 0.318. Frequency trades as it must: 2.5 MHz reaches 15.9 cm with 5.3-sample speckle, 8 MHz reaches 13.8 cm with 4.6-sample speckle |
| **B — the probe** ✅ | grab the probe in the room and slide it over the skin (the bay's orbit yields only when the grab lands on it); the scan plane belongs to the PROBE — rotate 0–90° turns transverse into sagittal, rock ±25° steers the fan without moving the hand; the room draws the true sector, through the patient | **passed**: a grab-and-drag moved the seat from (0.80, 0.44) to (0.51, 0.54) while a drag that missed the probe left it untouched and orbited instead; rotate and rock each change the image (field mean 65.8 transverse → 51.2 sagittal → 34.1 rocked); and one number trades resolution against penetration — speckle correlation length **0.077 cm at 3.5 MHz vs 0.031 cm at 10 MHz**, while useful depth falls **18.0 → 17.5 → 16.7 → 14.0 → 11.8 cm** across 2.5 / 3.5 / 5 / 8 / 12 MHz. 500+ fps |
| **C — knobs** ✅ | the TGC column — six per-depth gains that ADD to the machine's own ramp — plus dynamic range, and depth/gain/focus/freeze from A–B; every one of them display-side | **passed**: alternating the column ±16 dB bands the image by **27.8 grey levels RMS**, in alternating sign, and it looks exactly like the mis-set screen it is; pressing *centre the TGC* returns the depth profile to the centred one **bit-identically (Δ = 0.0)**, which is the proof that none of it touched the echo underneath. Dynamic range behaves as the knob it is: at 35 dB the black point sits at 9 (crushed, hard contrast), at 80 dB it lifts to 49 (soft and grey) |
| **D — motion** ✅ | the fluoro warps moved into `core/anatomyMotion.js` and driven from the marcher; a clock column (HR, breath hold, motion off); M-mode with a real time axis and a steerable cursor; a surveyed cardiac window | **passed, and the rate is read back off the IMAGE**: tracking an interface in the M trace and autocorrelating its depth returns **60.0 / 72.5 / 89.3 / 120.0 bpm** for slider settings of 60 / 72 / 90 / 120 — within 1 %, measured through the real clock, the real warp and the real display. The contraction is affine and provable: boundaries move **7.9 % of their distance from the heart's centre**, inward (near wall +9.6 mm, far wall −7.6 mm, converging), and **exactly 0.000 mm outside the ellipsoid**. Breath-hold, tested at the RUQ seat that has no cardiac motion in its plane (beat RMS 0.00 there — the control): breathing moves the image **61.5 grey RMS** between frames 1.6 s apart, holding the breath moves it **0.000** |
| **E — Doppler** ✅ | colour box over the vessel tree, direction from the arclength gradient, pulsatile velocity from the HR clock, aliasing at low PRF, and an acoustically-limited frame rate | **passed on all four counts.** Direction is derived, not authored: the aorta's flow gradient runs caudally down its whole length (z = −0.88 to −0.95) and the IVC's runs cranially (**z = +0.90**), so a vessel and its companion take opposite colours because the anatomy opposes, not because anything says so. The dot product is the model and it measures as one — on the central beams, measured **−32.4 / −34.5 / −38.1 / −40.0** cm/s against predicted **−31.8 / −35.0 / −37.8 / −40.8**. The aorta pulses with the waveform (mean −2.1 → −10.7 → −2.1 cm/s as the systolic term runs 0.25 → 0.96 → 0.25). Aliasing arrives on schedule: at v_nyq 99 cm/s **0 %** of the aorta reads the wrong colour, at 28 cm/s **25 %**, at 10 cm/s **35 %**. And colour costs what it costs: 20.1 fps in B-mode at 20 cm becomes **7.3 / 4.5 / 2.8 fps** for a 25 / 50 / 90 % box |
| **F — polish** ✅ | a ten-step tutorial, the home card graduated to B/M/colour, the mobile pass (tab bar, freeze docked under the thumb), and the console header stops calling an ultrasound machine a GENERATOR | **passed**: all eight goals in the walkthrough were driven through the real controls and every one registered — plane to sagittal, frequency past 8 MHz, depth past 18 cm, mis-set the TGC and centre it, seat the probe on the heart and switch to M-mode, move the heart rate, colour box on, scale below 2.5 kHz. Mobile: 25 fps at 375 px wide, no horizontal overflow, freeze in the dock. Every mode re-checked after the shared refactors — fluoro still lights 55.9 % of its monitor, ultrasound 23.3 %, and the console throws nothing |

## 4.1 What Phase A changed about the plan

- **No worker.** The plan took the fluoro worker-pool as its template. Measured, a frame
  costs **1–6 ms on the main thread** (170–770 fps), because a B-mode frame is ~98 k
  samples against a fluoro pulse's 9 M cells. A worker would have added a volume copy and
  a message protocol to buy nothing, so the loop stayed simple.
- **Gel is physics, not set dressing.** The first images had a 30 dB brightness step
  between the central scanlines and the rest, present from the very first sample. The
  cause was geometric: a convex face touches the skin at its centre and stands off it at
  the edges, so every oblique line crossed an air gap and lost ~30 dB at the air–skin
  mismatch. That is precisely what happens when you forget the gel, and precisely what
  the gel is for — so air encountered *before* the beam enters the patient is coupling
  medium, while air after it (bowel gas, the far skin line) keeps its mirror.
- **Gallbladder instead of kidney.** The plan's exit test named the liver/kidney
  interface. Surveying the volume showed the transverse RUQ plane carries liver and
  gallbladder but no kidney; the gallbladder is the better demonstration anyway, since
  it is anechoic AND casts enhancement.
- **Penetration needed a NOISE FLOOR to cost anything (Phase B).** Real TGC scales its
  compensation with frequency, and so does this one — which meant it perfectly cancelled
  attenuation at *any* frequency, and 12 MHz saw exactly as deep as 2 MHz. That is wrong
  for a reason worth stating: past the depth where the echo falls under the receiver's own
  noise, gain amplifies noise instead of signal. Adding that floor is what turns the
  frequency knob into a trade rather than a free lunch, and it is what makes the far field
  of a high-frequency image go to grey mush instead of staying crisp.
- **Speckle is hashed on POSITION, not time.** Scatterers sit where they sit, so a still
  probe gives a still image and moving the probe moves the speckle with the anatomy —
  which is how a sonographer tells texture from noise.

## 4.2 What Phase D changed about the plan

- **The motion is now SHARED with fluoro, not copied from it.** The plan said the warps
  "transfer as-is", which quietly meant a second copy of "where is the diaphragm". They
  now live in `core/anatomyMotion.js`: one region derivation, one phase-to-warp step, two
  consumers. Fluoro keeps its hand-inlined inner loop (a call per cell is not free at 9 M
  cells per pulse) and ultrasound calls `warpPoint`, but neither owns the anatomy any
  more. Re-measured after the move, fluoro is unchanged: motion on 41.0 grey RMS
  frame-to-frame against 10.9 with motion off — that floor being quantum mottle, which
  should not stop when the patient does.
- **An animation nobody measured was not animating at all.** The first build looked
  entirely plausible — grainy, alive, a fine-looking scan — and every clock in it was
  frozen: `lastTick` was only ever assigned when `dt > 0`, so `dt` was pinned at zero
  forever. Nothing in the picture said so. It took an M trace with a time axis, which
  drew six seconds of perfectly straight horizontal lines, to show it.
- **Speckle is hashed on MATERIAL coordinates, not on where you looked.** Phase A hashed
  the sample position, which was right while the anatomy held still and wrong the moment
  it moved: the texture would have sat in the screen while the organs slid through it.
  The hash now uses the WARPED coordinate — which piece of tissue this is, not which bit
  of space — so the speckle travels with the anatomy. Verified rather than assumed: at
  peak systole the deep-block correlation peaks at **−1.3 mm of shift**, not at zero. It
  only reaches 0.43 there, because a contraction deforms rather than translates and no
  single shift can align a block that spans a range of radii — which is also why real
  speckle decorrelates during systole.
- **The probe seat is deliberately NOT warped.** The contact search runs on the resting
  volume, so the hand holds its position and the patient moves underneath it. Seating the
  probe on the breathing surface instead would slide the entire image every frame, which
  is a moving hand, not a moving patient.
- **The cardiac window was surveyed, like the RUQ seat before it.** Seven candidate seats
  were scored by how much of the image the systolic warp actually moves. The winner —
  epigastric, sagittal, angled up under the costal margin, i.e. the subcostal view a real
  operator uses when ribs are in the way — scored **50.6 grey RMS** against **0.00** for
  the RUQ view, which has no heart in its plane at all. That zero is what makes the rest
  of the number trustworthy.
- **Per-column trackers are the wrong instrument on a speckle image.** Block matching and
  peak tracking both railed at their search limits: they were measuring speckle, not
  tissue. The honest instrument is the anatomy itself — walk the M-line ray at two locked
  phases and report where the material boundaries went. That is what produced the affine
  result, and it also found its own controls (the skin at 0.57 cm: 0.00 mm).
- **The heart warp moves a REGION, not a segmented myocardium** — everything inside the
  heart's ellipsoid contracts, including a little neighbouring fat and the oesophagus
  behind it. Invisible in a fluoro projection, visible here. Real peri-cardiac tissue does
  move with the heart, so it is not absurd, but it is a simplification and it is named.
- **M-mode resolves 50 Hz, not the ~1 kHz a real machine gets.** A real M-mode fires its
  one line far faster than any B frame; ours appends a column per frame at a 20 ms sweep.
  Above wall motion, short of valve flutter.

## 4.3 What Phase E changed about the plan

- **The frame rate is ACOUSTIC, and it was fake until this phase.** The loop ran as fast
  as the CPU allowed and reported that as fps — so when the flow-direction field turned
  out to be cacheable, colour Doppler cost exactly **×1.00**, the precise opposite of the
  lesson the phase exists to teach. Sound has a speed: a line cannot start until the last
  echo of the previous one is back, so a frame costs `NLINE × 2 × depth / c`. That is now
  the budget, and it pays for three things at once — B-mode runs **50.1 / 25.1 / 20.1 fps
  at 8 / 16 / 20 cm** (deeper is slower, and now visibly so), the colour box is expensive
  because its lines are fired ENS times each, and M-mode is fast because it fires *one*
  line. One model, three consequences, none of them decorated.
- **Flow direction is the arclength gradient — and veins needed no special case.** The
  plan assumed the venous side would have to be flipped. Measured, it does not: the
  contrast solver builds `s` by following the CIRCULATION from the injection site, up the
  veins to the heart and out along the arteries, so ∇s is the flow direction throughout.
  The IVC's gradient points cranially all by itself.
- **grad-s has to be FITTED, not differenced.** Axis-wise central differences failed on
  exactly the vessels that matter: an aorta is a few voxels across and long, so on the
  thin axes both neighbours are missing, the one-sided fallback measures variation across
  the lumen rather than along it, and the aorta came back with a flow direction of
  (1,1,1)/√3 — a diagonal, from a vessel that runs straight down the body. A least-squares
  plane fit over a small ball fixes it and is cached per voxel.
- **A mean over the whole colour box measures nothing**, which cost three attempts to
  learn. The box holds several vessels, and a sector fan crosses any one of them at a
  different angle on every line — so the average of everything hides the very dot product
  the phase is about. The frame now records WHICH vessel produced each colour sample, and
  the comparison is made per vessel and per beam line, where the model is actually stated.

## 5. Open questions for ML

1. First exam to tune for: RUQ abdomen (liver/gallbladder/kidney — classic teaching) or
   the beating heart (flashier, harder)?
2. Doppler in scope for v1, or explicitly a later feature (the plan treats it as stretch)?
3. Does the probe need a dedicated on-screen hand/skin contact visual, or is the surface
  -riding glyph + plane fan enough?
