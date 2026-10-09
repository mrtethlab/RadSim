# RadSim development log

What shipped, why, and how it was checked — newest first. Each entry points at its pull
request, which carries the full detail. (`SUMMARY.md` at the repo root is a separate, local
handoff document and is not committed.)

---

## 2026-10-09

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
