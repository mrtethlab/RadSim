# Bone Mineral Density (DXA) mode — plan

Two energies, one answer. DXA is the smallest physics in the building — two attenuation
measurements per ray, one 2×2 solve — and the most report-shaped output: areal density in
g/cm², a T-score, and a diagnosis threshold a clinician actually uses. The mode teaches
why TWO energies solve the two-material problem that no single exposure can.

Status: **complete — phases A–H built, measured and shipped** (G and H, the forearm and the precision assessment, in §6).

## 1. What exists to build on

- The CAP and whole-body subjects already carry the anatomy (spine, pelvis, femora) —
  no new volumes.
- The build pipeline collapsed TotalSegmentator's per-vertebra labels into generic bone
  materials, so DXA needs a **region map**: a per-voxel Uint8 labelling L1–L4, femoral
  neck, trochanter, shaft. This is exactly the `giVol` / `sVol` side-channel pattern —
  a small export from the original segmentation, shipped per subject, sent to whatever
  traces the rays.
- The CT scout machinery (fan geometry, scan animation, table) is most of the rig.
- The fluoro lung-µ trick (scaling one material's µ per frame) is how bone loss will be
  simulated without touching the volume.

## 2. The machine

A scanning arm over a flat table (its own rig, simpler than CT): the arm sweeps a narrow
fan along the region while a progress raster builds the image — DXA images appear line by
line on real machines, and the slow raster IS the look of the exam.

- **Region select**: AP lumbar spine (L1–L4) · left hip · right hip. Presets position the
  arm; the patient positioning rules (legs raised on a block for spine, femur internally
  rotated for hip) are one-toggle poses with visible consequences in the image.
- **Acquisition**: two effective energies per ray (~40 and ~70 keV from a switched 100/140
  kVp beam) through the existing polyenergetic tracer. Per pixel: solve the 2×2 basis
  decomposition (bone mineral, soft tissue) → areal density map.
- **Analysis**: ROI boxes auto-placed from the region map, hand-adjustable (mis-placement
  changing the answer is a core teaching point). Per-ROI: area, BMC (g), BMD (g/cm²),
  **T-score** and **Z-score** against an NHANES-style reference table shipped as data.
- **Report**: the classic output — density image, ROI table, the T-score plotted on the
  reference curve with the −1.0 / −2.5 lines drawn. This is what the card promised:
  "a T-score at the end of it."
- **Bone-loss slider**: scales trabecular/cortical µ (0–40% mineral loss) per acquisition.
  Scan, drop the slider, rescan: watch the same skeleton cross from normal through
  osteopenia to osteoporosis. Serial-scan comparison (% change) is the follow-up lesson.

## 3. The physics, stated plainly

Each ray gives ln(I₀/I) at two energies. Two unknowns (areal densities of bone mineral
and soft tissue), two equations, per pixel. Soft-tissue thickness cancels — which is the
entire reason DXA works on a patient instead of only on an excised bone, and the mode
should demonstrate it: add a soft-tissue pad over the spine and show BMD unchanged while
a single-energy image brightens.

## 4. Phases

| Phase | Scope | Exit test |
| --- | --- | --- |
| **A — rig + raster** ✅ | scanning-arm rig, region presets, line-by-line dual-energy acquisition | **passed**: against soft tissue the 40 keV image carries **1.21** of bone contrast where 70 keV carries **0.62** — a ratio of **1.96**, which is the whole reason two energies separate what one cannot |
| **B — decomposition** ✅ | per-material basis solve, bone-mineral map, auto ROIs found in the image | **passed, against a 2 % bar, at 0.00 %.** A 4 cm soft-tissue pad moves a single-energy reading 8.46 → 9.58 (+13 %) and 8 cm moves it +26 %, while decomposed BMD holds at 2.0813 → 2.0813. The fat row is the one carrying information — fat is not the basis material and cancels anyway, because its own bone-equivalent component solves to zero |
| **C — the report** ✅ | BMC/BMD/T/Z per level, WHO banner, sex- and age-specific references | **passed.** L1–L4 mean **1.106 g/cm²** (levels 0.960–1.359), T +0.54, Normal — true by construction, since the calibration constant was set to put it there, exactly as a densitometer is cross-calibrated daily against a spine phantom. The real result is ROI sensitivity: trimming 3 px gives **+4.2 %**, widening 6 px **−11.5 %** — a wider swing than the gap between normal and osteopenia |
| **D — bone loss** ✅ | mineral-scaling slider, serial comparison against a least-significant-change bar | **passed on the substance, not on the plan's number.** 30 % of mineral removed drops BMD 29.4 % — near-exactly proportional, which only holds if attenuation and ground truth saw the same change. The skeleton walks the whole scale: **T +0.54 normal → −2.42 osteopenia at 30 % → −3.71 osteoporosis at 40 %**. The plan predicted −30 % would cross −2.5; it lands at −2.42 and needs ~32 %, so the doc's number is the one that changed |
| **E — polish** ✅ | six-step tutorial, home card, mobile pass | **passed**: all six steps render with their rings, and the goals register — moving the age ticks its goal and demonstrates its own claim, T unmoved at 0.54 while Z moves 2.17 → 0.54 |

## 4.1 What the build changed about the plan

- **No region-map export, and no `build_dxa_regions.py`.** The plan wanted a per-voxel
  L1–L4 map from the TotalSegmentator masks. Those masks do exist, but the shipped volume
  is resampled AND tight-cropped, so aligning them means reproducing that transform
  exactly — fragile, for a side-channel nothing else needs. It is also not what a
  densitometer does: it has no CT to consult and segments bone out of its own scan. The
  vertebrae are found in the image, by integrating across the spine column and walking the
  profile for the disc-space dips.
- **The window is placed off the anatomy, not the volume.** Phase A parked it a fixed
  offset from centre and landed on the lower chest. The ribcage and the iliac wings both
  throw bone wide of the midline and the waist between them does not — so counting bone
  beyond 5 cm of the midline per slice gives two humps and a trough, and the trough IS the
  lumbar level.
- **Mineral densities are computed, not assigned.** Phase A assigned them by hand and had
  trabecular bone 2.5× out. Every material now goes through the same 2×2 the image solve
  uses: cortical returns 1.920 (its own density, by construction), trabecular 0.480, and
  every soft tissue 0.000 — which is the mechanism behind the pad test rather than a
  coincidence, and removes any "which ids are bone" list to keep in step.
- **Reproducibility is the weak point, and it is stated in the mode itself.** A repeat
  scan reproduces to **0.003 %**, which is not a result — it is an artefact of an
  acquisition with no photon noise and a patient who is never repositioned. A real
  machine's ~1 % comes from exactly those two. The least-significant-change line teaches
  the concept honestly while the number under it is free, and the tutorial says so.
  Phase H put the repositioning back (§6): the LSC is now measured, by the operator.

## 5. Questions the plan asked, and how the build answered them

1. **Reference population** — sex-selectable, not a composite. A T-score against an
   averaged population would be meaningless for the sex being screened; the same bones
   read T +0.54 against a female reference and +0.16 against a male one.
2. **Both hips** — both presets ship, since they are only a window placement.
3. **Per-level exclusion** — deferred. The table prints each level separately so a
   degenerate one is visible, but excluding it from the mean is not wired yet.

## 6. The forearm and the precision assessment (phases G and H)

| Phase | Scope | Exit test |
| --- | --- | --- |
| **G — the forearm** ✅ | ISCD's 33 % radius of the non-dominant forearm on the upper-extremity volume: indications in the intake, positioning, the scan, the report row | **passed.** The ulna measured on the volume, olecranon to styloid, is **26.65 cm**; the scan finds the styloid in its own image within 3 mm of it and puts a 2 cm region on the radius 8.9 cm up. Full mineral reads raw **0.920 / 0.907** (right / left), **T +0.55 / +0.38** after the forearm's own cross-calibration; 20 % of the mineral removed reads × 0.80 |
| **H — precision** ✅ | ISCD's precision assessment: 15 × 3 or 30 × 2 repeats with repositioning, RMS-SD, %CV, LSC = 2.77 × precision against the ISCD minimums, and the reports judging follow-ups on it | **passed.** Spine **0.79 %CV**, RMS-SD 0.0084 g/cm², LSC **0.023 g/cm² (2.2 %)**; total hip **0.35 %CV** (LSC 1.0 %), femoral neck **1.57 %CV** (LSC 4.3 %) — all inside ISCD's 1.9 / 1.8 / 2.5 %. A −1.9 % follow-up the 1.5 % placeholder called significant now reads "within the LSC of 0.023 g/cm²: no significant change" |

**The forearm.**
- **The site and why.** ISCD measures the forearm when the hip and/or spine cannot be measured
  or interpreted, in hyperparathyroidism, and in patients over the table's weight limit. The
  intake now asks which hand the patient writes with, about spine and hip hardware and about
  other conditions, and the verdict turns those answers into a site plan: both hips replaced →
  spine + forearm; a spinal fusion → hip + forearm; hyperparathyroidism → all three (and the
  forearm loses an extra 8 % of mineral, since the disease takes cortex first); over 159 kg →
  forearm only, seated beside the table — which used to be a patient sent away. The forearm is the
  non-dominant one unless that wrist was the one broken.
- **One arm, both sides.** The shipped upper extremity is a RIGHT arm — measured, not assumed:
  shoulder superior, olecranon posterior, and the bone away from the torso lies along superior ×
  posterior, which is the patient's right. Most patients are right-handed, so the left forearm is
  the one usually wanted, and it is made the only way it can be: the right arm mirrored, which to
  a projection through a forearm is exact. `voxelFlips()` in app.js asks `dxaMirror()`, so the mesh
  on the table and the traced volume mirror together.
- **Positioning.** Forearm straight along the table and flat on it (turn and tilt within 2° and
  3°), its length measured with a tape from the ulnar styloid to the olecranon and keyed in, the
  laser an inch distal of the styloid. The inch is measured: with the mark a centimetre distal, a
  laser 1.4 cm proximal — inside the 2 cm the console calls on the mark — cut the styloid out of
  the picture, and the region hangs from it. The field is 16 cm, which holds the one-third site
  with the laser 2 cm distal.
- **The analysis** walks down the ulna's medial border from the shaft until it breaks — the
  styloid's tip — goes a third of the keyed-in length back up, and takes the lateral bone, the
  radius, over 2 cm, its edges following the bone. A wrong length moves the region by a third of
  the error (3 cm → 1 cm) and, because the site sits on the diaphysis's plateau, barely moves the
  number (0.912 against 0.921 / 0.920 keyed in as 24 and 29 cm, the true length 26.65) — the reproducibility that makes it the forearm site to use. A border that runs
  off the field without breaking, or a site outside it, is reported as no region, not measured.
- **Calibration.** The spine's 0.40 corrects the torso volume's segmentation, not the machine, and
  read this forearm at 0.37 g/cm² — T −5.4 on nothing wrong. The arm gets its own, 0.79, set the
  same way: the full-mineral skeleton reads like the healthy adult it is.
- **Reference.** 0.694 ± 0.060 g/cm², the one-third radius's peak in the ISCD DXA Atlas case
  "Improper Forearm Acquisition", on the same Hologic/NHANES scale as the spine and hip rows. Men
  are scored against it too, which is what ISCD (2019) recommends at every site.

**The precision assessment.**
- **What the operator does.** Pick spine or hip and 15 × 3 or 30 × 2. Each scan the patient gets
  off the table and back on — a little off the lines, turned, the arm parked a fractional press
  from any whole-cm route to the mark — and the operator repositions and scans. The patients are
  the one skeleton at mineral losses spread from 0 to 30 %.
- **Where the scatter comes from.** Nothing adds noise to a number. The operator's own residuals
  — where the laser stopped along and across, how square and centred the patient was — are
  recorded at each SCAN, and the foot holder seats each foot within ±3° (an assumption, stated);
  the real tracer and the real analysis turn those into BMD. Once one patient's set is done by
  hand, a simulated technologist can finish the rest, each repeat drawing each part of its
  positioning from a different one of the operator's scans, through the same pipeline: 42
  repeats in **1.5 s**. The page says what it is: the positioning share of precision alone,
  since this densitometer has no photon noise.
- **The statistics** (pure, `precisionStats`): RMS-SD pools the per-patient variances by their
  degrees of freedom (Glüer 1995) — not the mean SD; %CV pools the same way over SD/mean; LSC =
  2.77 × each, 1.96 × √2 for the difference of two measurements. Under 30 degrees of freedom the
  result is marked provisional. Saved, it replaces the 1.5 % placeholder: the serial table and
  the report trend judge a change against the LSC in g/cm² (ISCD's preference), and every bar says
  whether it was measured or is the placeholder.

**What the assessment found in the hip.** The first hip run failed ISCD at the neck — 4.63 %CV,
with one hip reading 0.61, 1.03 and 0.74 g/cm² at the neck across three near-identical
repositionings. Two bugs, both older than this phase:
- the trochanter and femoral-head landmarks were distances from the patient's midline handed to
  the femur analysis as room x. A patient 1 cm off the line — inside "centred" — had every region
  built 1 cm off the femur: neck **+9 % / +19 %** at ±1 cm, and +13 % / +8 % turned ±2°. Now they
  are carried with the patient's offset and turned with it: ±1 cm changes nothing at all, ±2°
  moves the neck 0.6 %;
- the femoral-head search stepped two voxels and kept the first largest sphere, so the head's
  centre — the neck region's anchor — jumped 0.4-0.8 cm between neighbouring degrees of turn-in:
  neck **0.701 at 19-20°, 0.776 at 21°**. A local full-resolution search taking the middle of all
  the maximal centres holds it within 0.2 cm (0.730 / 0.744). The console's and tutorial's
  "neutral reads about 8 % higher" was partly that jump: measured again it is **3 %** (0.766
  against 0.743), and 20° turned out reads a quarter higher.

After both, the same exercise gives the total hip 0.35 % and the neck 1.57 %.
