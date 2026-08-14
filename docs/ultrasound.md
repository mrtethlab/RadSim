# Ultrasound mode — plan

The one modality on the board with no ionising radiation at all — and the one where the
IMAGE is made of physics artifacts. Shadowing, enhancement, speckle and reverberation are
not defects to simulate reluctantly: they are how sonographers read tissue, and the mode
succeeds only if the artifacts are honest enough to diagnose with.

Status: **Phases A–C built and measured** on branch feature/ultrasound; D–F remain.

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
| **D — motion** | anim warps in the marcher (heart, breathing, gut), M-mode | the heart visibly beats at the HR slider's rate; M-mode through it shows wall excursion; breath-hold stills the diaphragm |
| **E — Doppler** (stretch) | colour box over `sVol` vessels, pulsatile velocity from the HR, aliasing at low PRF | flow paints red/blue by direction; the aorta pulses; turning the box off restores frame rate — the real cost of Doppler |
| **F — polish** | tutorial, home card graduation, mobile pass | tutorial goals all achievable |

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

## 5. Open questions for ML

1. First exam to tune for: RUQ abdomen (liver/gallbladder/kidney — classic teaching) or
   the beating heart (flashier, harder)?
2. Doppler in scope for v1, or explicitly a later feature (the plan treats it as stretch)?
3. Does the probe need a dedicated on-screen hand/skin contact visual, or is the surface
  -riding glyph + plane fan enough?
