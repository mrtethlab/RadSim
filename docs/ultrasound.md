# Ultrasound mode — plan

The one modality on the board with no ionising radiation at all — and the one where the
IMAGE is made of physics artifacts. Shadowing, enhancement, speckle and reverberation are
not defects to simulate reluctantly: they are how sonographers read tissue, and the mode
succeeds only if the artifacts are honest enough to diagnose with.

Status: **planning — awaiting review**. Nothing below is implemented.

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
| **A — acoustics** | material acoustic table; scanline marcher in a worker; fixed probe pose; A-mode strip then B-mode fan on CAP | liver/kidney interface visible; bone casts a clean shadow; a fluid structure brightens what lies behind it — all three as CONSEQUENCES, no per-artifact code |
| **B — the probe** | surface-riding probe UI, plane indicator, both probes, live loop at ≥ 20 fps | drag from RUQ to flank and the image follows; 10 MHz linear resolves what 3.5 MHz cannot, and dies at depth where 3.5 MHz still sees |
| **C — knobs** | depth, gain, TGC rows, focus, freeze; display-side processing | mis-set TGC produces the classic banded image; correcting it recovers uniformity without touching physics |
| **D — motion** | anim warps in the marcher (heart, breathing, gut), M-mode | the heart visibly beats at the HR slider's rate; M-mode through it shows wall excursion; breath-hold stills the diaphragm |
| **E — Doppler** (stretch) | colour box over `sVol` vessels, pulsatile velocity from the HR, aliasing at low PRF | flow paints red/blue by direction; the aorta pulses; turning the box off restores frame rate — the real cost of Doppler |
| **F — polish** | tutorial, home card graduation, mobile pass | tutorial goals all achievable |

## 5. Open questions for ML

1. First exam to tune for: RUQ abdomen (liver/gallbladder/kidney — classic teaching) or
   the beating heart (flashier, harder)?
2. Doppler in scope for v1, or explicitly a later feature (the plan treats it as stretch)?
3. Does the probe need a dedicated on-screen hand/skin contact visual, or is the surface
  -riding glyph + plane fan enough?
