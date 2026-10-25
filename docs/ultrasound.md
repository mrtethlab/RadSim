# Ultrasound mode — plan

The one modality on the board with no ionising radiation at all — and the one where the
IMAGE is made of physics artifacts. Shadowing, enhancement, speckle and reverberation are
not defects to simulate reluctantly: they are how sonographers read tissue, and the mode
succeeds only if the artifacts are honest enough to diagnose with.

Status: **complete — phases A–G built, measured and shipped.**

Decisions taken while building (the plan's own defaults, confirmed by measurement):
RUQ abdomen is the exam tuned for; Doppler, a stretch in the plan, is built — colour (E,
rebuilt as signal processing in G) and spectral PW (G); the probe is a
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
| **B — the probe** ✅ | grab the probe in the room and slide it over the skin (the bay's orbit yields only when the grab lands on it); the scan plane belongs to the PROBE — rotate 0–90° turns transverse into sagittal, rock ±25° steers the fan without moving the hand; the room draws the true sector, through the patient | **passed**: a grab-and-drag moved the seat from (0.80, 0.44) to (0.51, 0.54) while a drag that missed the probe left it untouched and orbited instead; rotate and rock each change the image (field mean 65.8 transverse → 51.2 sagittal → 34.1 rocked); and one number trades resolution against penetration — speckle correlation length **0.077 cm at 3.5 MHz vs 0.031 cm at 10 MHz**, while useful depth falls **18.0 → 17.5 → 16.7 → 14.0 → 11.8 cm** across 2.5 / 3.5 / 5 / 8 / 12 MHz. 500+ fps. **Superseded (Oct 2026):** those depths were measured with the echo paying attenuation one way while the TGC repaid it both ways. Corrected, with the noise floor and reference gain re-set: **20.2 / 18.2 / 14.3 / 9.4 / 6.4 cm** at 2.5 / 3.5 / 5 / 7.5 / 12 MHz (depth where median speckle crosses the noise floor), which is the textbook range. |
| **C — knobs** ✅ | the TGC column — six per-depth gains that ADD to the machine's own ramp — plus dynamic range, and depth/gain/focus/freeze from A–B; every one of them display-side | **passed**: alternating the column ±16 dB bands the image by **27.8 grey levels RMS**, in alternating sign, and it looks exactly like the mis-set screen it is; pressing *centre the TGC* returns the depth profile to the centred one **bit-identically (Δ = 0.0)**, which is the proof that none of it touched the echo underneath. Dynamic range behaves as the knob it is: at 35 dB the black point sits at 9 (crushed, hard contrast), at 80 dB it lifts to 49 (soft and grey) |
| **D — motion** ✅ | the fluoro warps moved into `core/anatomyMotion.js` and driven from the marcher; a clock column (HR, breath hold, motion off); M-mode with a real time axis and a steerable cursor; a surveyed cardiac window | **passed, and the rate is read back off the IMAGE**: tracking an interface in the M trace and autocorrelating its depth returns **60.0 / 72.5 / 89.3 / 120.0 bpm** for slider settings of 60 / 72 / 90 / 120 — within 1 %, measured through the real clock, the real warp and the real display. The contraction is affine and provable: boundaries move **7.9 % of their distance from the heart's centre**, inward (near wall +9.6 mm, far wall −7.6 mm, converging), and **exactly 0.000 mm outside the ellipsoid**. Breath-hold, tested at the RUQ seat that has no cardiac motion in its plane (beat RMS 0.00 there — the control): breathing moves the image **61.5 grey RMS** between frames 1.6 s apart, holding the breath moves it **0.000** |
| **E — Doppler** ✅ | colour box over the vessel tree, direction from the arclength gradient, pulsatile velocity from the HR clock, aliasing at low PRF, and an acoustically-limited frame rate | **passed on all four counts.** Direction is derived, not authored: the aorta's flow gradient runs caudally down its whole length (z = −0.88 to −0.95) and the IVC's runs cranially (**z = +0.90**), so a vessel and its companion take opposite colours because the anatomy opposes, not because anything says so. The dot product is the model and it measures as one — on the central beams, measured **−32.4 / −34.5 / −38.1 / −40.0** cm/s against predicted **−31.8 / −35.0 / −37.8 / −40.8**. The aorta pulses with the waveform (mean −2.1 → −10.7 → −2.1 cm/s as the systolic term runs 0.25 → 0.96 → 0.25). Aliasing arrives on schedule: at v_nyq 99 cm/s **0 %** of the aorta reads the wrong colour, at 28 cm/s **25 %**, at 10 cm/s **35 %**. And colour costs what it costs: 20.1 fps in B-mode at 20 cm becomes **7.3 / 4.5 / 2.8 fps** for a 25 / 50 / 90 % box. **Superseded in part (Phase G):** the velocities, the colour cost and the sign convention. The aliasing and frame-rate figures above came from a constant-per-vessel speed and a box charged ENS round trips of the image depth; re-measured with flow from waveforms and continuity, and colour paid at the PRF, they are in §4.4 (half-width box at 16 cm: 6 fps, not 4.5). Stored colour velocity is now positive TOWARD the probe |
| **F — polish** ✅ | a ten-step tutorial, the home card graduated to B/M/colour, the mobile pass (tab bar, freeze docked under the thumb), and the console header stops calling an ultrasound machine a GENERATOR | **passed**: all eight goals in the walkthrough were driven through the real controls and every one registered — plane to sagittal, frequency past 8 MHz, depth past 18 cm, mis-set the TGC and centre it, seat the probe on the heart and switch to M-mode, move the heart rate, colour box on, scale below 2.5 kHz. Mobile: 25 fps at 375 px wide, no horizontal overflow, freeze in the dock. Every mode re-checked after the shared refactors — fluoro still lights 55.9 % of its monitor, ultrasound 23.3 %, and the console throws nothing |
| **G — Doppler, properly** ✅ | flow for every labelled vessel (waveform by vascular bed, renal level from the kidneys, continuity against measured calibre, laminar parabola); colour as an 8-pulse ensemble through a wall filter into a Kasai autocorrelator, with colour gain, wall filter, baseline, invert, write priority, steering (linear) and a colour bar; PW spectral Doppler — gate, angle cursor, PRF, baseline, wall filter, gain, sweep, PSV/EDV/RI; PRF capped by depth; a surveyed aorta seat | **passed** (§4.4): the aorta seat reads **PSV 54, EDV 12 cm/s, RI 0.78** — biphasic above the renals — against a model peak of 52 in the gate; the spectral band widens **18 → 40 cm/s** from a 1 to a 20 mm gate; colour aliasing **0 / 31 / 50 %** of the aorta at v_nyq 32 / 19 / 13 cm/s, wrapping bright-to-bright; the PRF is **capped at 4.2 kHz** by a box reaching 18 cm; the heart's flash falls **23 → 0.2 %** of the tissue from a 25 to a 400 Hz wall filter. Eleven unit tests on the relations, **11 of 11 re-introduced bugs caught**. Found on the way: **the subject has a ~6 cm juxtarenal aortic aneurysm** |

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

## 4.4 Phase G — colour Doppler rebuilt as signal processing, and spectral (PW) Doppler

Phase E proved the dot product. It did not yet have a Doppler *machine*: velocity was a
constant per vessel times a sin² pulse, the colour was that number wrapped by a `while` loop,
and there was no spectral display at all. Phase G replaces the middle and adds the trace.
The physics lives in `core/doppler.js` (pure, unit-tested); the anatomy and the screens in
`ultrasound.js`.

**What the scene has, and the flow it was given.** The scanned subject (chest / abdomen /
pelvis) carries eighteen labelled great vessels (ids 29–46) and the arclength field Phase E
used for direction, so no vessel had to be added — they were given flow:

- **Waveforms by vascular bed**, in seconds from ejection (systole barely shortens with
  rate; diastole is what a fast heart loses), each beat summed with its neighbours:
  *triphasic* (infrarenal aorta, iliacs, subclavians — high-resistance beds: sharp peak,
  early-diastolic reversal, small second forward wave, EDV 0), *biphasic* (aorta above the
  renal arteries — the kidneys and gut draw through diastole: no reversal, EDV ≈ 15 % of PSV),
  *low resistance* (carotids, brachiocephalic trunk: RI ≈ 0.75), *pulmonary* (systolic only),
  *venous* (central veins and the IVC: S and D forward waves, an a-wave reversal), *steady*
  (portal, iliac veins). Veins also **breathe**: inspiration slows the abdominal veins and
  speeds the thoracic ones, the opposite-sign phasicity that is the classic obstruction test.
- **The renal level is derived, not authored**: the renal arteries are not segmented but the
  kidneys are, and the centroid height of the kidneys (z = 28.2 cm here) splits the aorta into
  its biphasic and triphasic segments.
- **Speed at a point** = textbook peak × waveform × continuity × parabola. The lumen is
  *measured* at the sample: two chords across the vessel, perpendicular to the flow, walked to
  the wall both ways. For a circle the half-difference of a chord's arms is the sample's
  offset along it and the half-sum with the other chord's offset gives R by Pythagoras — so
  R and r/R come from the segmentation, with no centre-line extraction.
- **Continuity against the TEXTBOOK calibre.** The first version measured continuity against
  each vessel's own median radius; the aorta's median (2.2 cm) is dominated by the arch,
  where a perpendicular chord runs along the curve, and by the aneurysm below, so the
  normal-calibre segment ran at 1.9× its textbook speed. Against a textbook radius (aorta
  1.25 cm, iliac 0.5, IVC 1.0, …) the ratio is honest, clamped to 0.15–1.5 (no stenoses here;
  a two-voxel vessel under-measures its radius and must not become a jet).

**The subject has an abdominal aortic aneurysm.** Measured by the chords: R ≈ 3.1 cm
(a ~6.3 cm sac) for z 20–28 cm, against 1.5–1.7 cm (3.0–3.3 cm across, ectatic) at
z 32–44 cm; the iliacs measure ~1.9 cm across. Nothing in the repo mentioned it. It is
juxtarenal (the sac's top, z ≈ 30 cm, is just above the kidney centroid), and continuity
makes its flow slow — a ~6 cm sac runs at 0.15–0.16 of the textbook peak, as real sacs do.

**Colour is signal processing now.** Per colour line (every second B line, as machines
thin colour lines), the line is marched with the same reflection and attenuation as B; in
the box four sub-samples span the sample volume (pulse length axially, beam width across
and in elevation). Each is blood — its own speed and flow direction — or tissue at the
CLUTTER level (+45 dB over blood) moving at its own velocity, which comes from the anatomy
warp evaluated 10 ms apart. Echoes go through the wall filter (an order-4 high-pass on slow
time, so periodic in the PRF: a flow at one PRF is removed like a wall) and an ensemble of 8
pulses with receiver noise into the Kasai autocorrelator. Aliasing is the autocorrelator's
phase wrap — nobody codes it. Colour is shown where (1) power beats the noise by the colour
gain's threshold, (2) the mean shift is not under the wall-filter cutoff (the clutter
reject: a breathing liver's leaked power sits at the liver's own shift), and (3) the grey
underneath is darker than the write priority. Baseline and invert are display-side re-maps,
so they work on a frozen frame. Toward the probe is red and the top of the bar; aliasing
jumps bright red → bright cyan with no black between, a true reversal passes through black.

**PW is a gate full of scatterers.** 256 points through the gate (uniform along it, Gaussian
across, as the beam is). The lumen is fitted ONCE, at the gate's centre: the first version
measured it per scatterer and the voxel grid's stair-steps put noise into every radius,
filling the spectral window even under a 1 mm gate on the axis. Each spectral column re-times
the waveform for every scatterer, adds intrinsic broadening (the 1.2 cm sub-aperture hears
each scatterer over a spread of angles), puts the shifts through the same wall filter into
a 128-bin periodogram — each bin exponentially distributed about its mean, which is the
grain of a real trace — over receiver noise spread across all 128 bins, so a tone stands
~21 dB further out of the floor than it does in one slow-time sample: PW hears what colour cannot. The auto-trace is a threshold crossing; PSV/EDV/RI come off the last
complete beat between ECG triggers. The axis is angle-corrected cm/s; the cursor rescales the
axis, not the trace. The panel also shows what no machine knows — the true beam-flow angle in
the gate — so the angle lesson can be checked.

**Depth caps the PRF**, for both: PRF_max = c/2d at the bottom of the colour box and at the
far edge of the gate, and the readout says when it has capped the knob.

**The frame rate model changed.** Phase E charged each colour line ENS round trips of the
whole image depth. The honest clock is the PRF: a colour line costs ENS/PRF, at least ENS
round trips to the box bottom and more when the scale is set low to see slow flow. PW in
duplex shares the transducer: the image refreshes at half its rate.

**The circulation does not stop with the anatomy.** *Motion off* stills the warps, but the
clocks run on — a still patient has a pulse, and the Doppler signal is the blood.

**The aorta seat was surveyed**, like the cardiac seat. 3024 sagittal seats × lines
(across 0.43–0.53, along 0.38–0.50, rock −25..25°) with the gate put mid-lumen, scored on the
two-way loss to it with the beam-flow angle ≤ 60°; then a centring pass, because a plane that
cuts the aorta off its axis puts a "mid-lumen" gate near the wall in elevation (40 % of
centre-line speed). Most epigastric lines to the normal segment cross costal cartilage or
gas (65–200 dB lost, or shadowed outright): the seat loses 44 dB to the aorta at 16.3 cm, its
gate sits within 0.35 R of the axis, flow comes toward the probe at 57°. The seat also holds
the breath at end expiration: the shared breathing warp carries the upper abdomen, aorta
included, a centimetre or more, and a 3 mm gate falls out of the lumen mid-breath — the trace
comes and goes until the breath is held, which is the lesson, if an overstated one.

### Measured (in the running app, motion on, breath held, 3 MHz, unless stated)

| What | Result |
| --- | --- |
| Aorta seat PW | **PSV 54, EDV 12 cm/s, RI 0.78** — biphasic, as the suprarenal aorta should be. Model peak in the gate 52 cm/s (textbook 100 × continuity 0.61 × parabola at rho 0.35); true angle 57.4°, in-plane cursor 54°. At the true angle the trace reads 58.8 (+13 %: intrinsic broadening plus the envelope's threshold, the known PSV overestimate of max-envelope tracing); at the in-plane cursor 53.9 (−8 %: the cursor cannot see the out-of-plane part of the angle) |
| Gate size → broadening | scatterer speeds (q10–q90, angle-corrected) **40–46 / 40–45 / 39–46 / 38–45 / 28–44 cm/s** for 1 / 3 / 6 / 10 / 20 mm; the displayed systolic band (above half its peak, 7 columns) **18 / 19 / 18 / 25 / 40 cm/s**: the window fills as the gate takes in the slow blood |
| PW aliasing | PRF 4 kHz: window ±87 cm/s, trace peaks +55. PRF 1.5 kHz: ±33, the peak runs off the top and re-enters from the bottom (envelope at both edges, auto PSV fails at 32 — as a machine's does). PRF 1 kHz with the baseline lowered 60 %: window −9..+35, still wraps |
| Colour aliasing (aorta seat, systole held) | v_nyq 54 (4.5 kHz asked, **capped to 4.2 kHz by the box depth**) / 45 / 32 cm/s: **0 %** of the aorta the wrong colour; 19 cm/s: **31 %**; 13 cm/s: **50 %** |
| Clutter and the wall filter (cardiac seat, 60 % box) | tissue painted **23.1 / 7.7 / 7.8 / 1.9 / 0.2 %** at 25 / 50 / 100 / 200 / 400 Hz, lumen filled 85 / 59 / 47 / 26 / 12 %: the heart's flash and the slow flow go together. RUQ transverse: **0 %** at every filter — breathing is cranio-caudal, out of that plane, so it has no axial component |
| Colour gain (RUQ box, no vessel) | noise painted **0 %** at 0 dB, **40 %** at +5 (threshold at the noise mean), **88 %** at +10 |
| Frequency trade (aorta seat) | two-way loss to the gate **37 / 44 / 52 / 74 / 103 dB** at 2.5 / 3 / 3.5 / 5 / 7 MHz; aorta colour fill 30 / 33 / 38 / 21 / 0 %; PW finds PSV through 5 MHz and nothing at 7; the angle-corrected scale at fixed PRF falls 105 → 37 cm/s with f0 |
| Frame rate (16 cm) | B **25 fps** (8 cm: 50) — unchanged; colour box 25 / 50 / 90 % wide at 3 kHz: **10 / 6 / 4 fps**; 50 % at 1 kHz: 2 fps, at 6 kHz: 10 fps; PW duplex 13 fps, triplex 3 fps |

### Unit tests (`apps/web/test/doppler.test.js`), each proved

Eleven tests hold f_d = 2 f0 v cosθ / c, v_nyq = c·PRF/(4 f0 cosθ), PRF_max = c/2d (and the
range-velocity product c²/8f0), wrap-not-clip with the baseline, the Kasai estimator (a tone at
0.7 PRF reads −0.3 PRF; noise power 2σ²), the angle-error growth (5° costs 5.7 / 18.3 / 32.1 % at
30 / 60 / 70°, and crosses 15 % exactly at 60°), the wall filter's periodicity, the waveform
shapes (triphasic reversal and EDV 0, low-resistance RI, biphasic EDV/PSV, the venous a wave,
continuity across the beat), the parabola's flat speed distribution (each decile of v/vmax holds
a tenth of the lumen), the spectral column (in-window, aliased and baseline-shifted tones land
in their bins; power is conserved) and PSV/EDV/RI off the last beat. Each was proved by putting a
bug back and running the suite: shift without the 2, PRF_max = c/d, aliasing that clips, v_nyq
without the 4, the angle error inverted, a non-periodic wall filter, plug flow, a spectrum that
clips, beats without their neighbours, EDV read at the minimum, and the Kasai lag sign flipped —
**11 of 11 caught**.

### Limitations, stated

- Doppler runs at the imaging frequency; real machines transmit Doppler lower than B.
- Steering is a linear-array control; the curvilinear is heeled (rock), not steered.
- The flow is laminar everywhere: no turbulence, no stenosis jets, no swirl in the aneurysm sac
  (which is slow, as continuity says, but orderly, which a real sac is not).
- The breathing warp moves retroperitoneal vessels with the diaphragm, overstating aortic motion.
- Continuity uses the subject's measured calibre against a textbook one; the chords are only as
  good as a 2 mm grid, which is why the ratio is clamped and the gate fits one cylinder.
- The aorta's waveform switches at the kidneys' centroid; the arch and thoracic aorta share the
  suprarenal (biphasic) waveform.
- The heart's chambers are labelled tissue, not blood, so there is no intracardiac flow; the cardiac
  seat's colour comes from the great vessels and the flash from the myocardium.

## 5. Open questions for ML

1. First exam to tune for: RUQ abdomen (liver/gallbladder/kidney — classic teaching) or
   the beating heart (flashier, harder)?
2. ~~Doppler in scope for v1, or explicitly a later feature (the plan treats it as stretch)?~~
   Built: colour in E, rebuilt with spectral PW in G (§4.4).
3. Does the probe need a dedicated on-screen hand/skin contact visual, or is the surface
  -riding glyph + plane fan enough?
