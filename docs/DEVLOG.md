# RadSim development log

What shipped, why, and how it was checked — newest first. Each entry points at its pull
request, which carries the full detail. (`SUMMARY.md` at the repo root is a separate, local
handoff document and is not committed.)

---

## 2026-10-08

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
