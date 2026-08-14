# Bone Mineral Density (DXA) mode — plan

Two energies, one answer. DXA is the smallest physics in the building — two attenuation
measurements per ray, one 2×2 solve — and the most report-shaped output: areal density in
g/cm², a T-score, and a diagnosis threshold a clinician actually uses. The mode teaches
why TWO energies solve the two-material problem that no single exposure can.

Status: **complete — phases A–F built, measured and shipped.**

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

## 5. Questions the plan asked, and how the build answered them

1. **Reference population** — sex-selectable, not a composite. A T-score against an
   averaged population would be meaningless for the sex being screened; the same bones
   read T +0.54 against a female reference and +0.16 against a male one.
2. **Both hips** — both presets ship, since they are only a window placement.
3. **Per-level exclusion** — deferred. The table prints each level separately so a
   degenerate one is visible, but excluding it from the mean is not wired yet.
