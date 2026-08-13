# Bone Mineral Density (DXA) mode — plan

Two energies, one answer. DXA is the smallest physics in the building — two attenuation
measurements per ray, one 2×2 solve — and the most report-shaped output: areal density in
g/cm², a T-score, and a diagnosis threshold a clinician actually uses. The mode teaches
why TWO energies solve the two-material problem that no single exposure can.

Status: **planning — awaiting review**. Nothing below is implemented.

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
| **A — rig + raster** | scanning-arm rig, region presets, line-by-line dual-energy acquisition of the spine | both energy images build in the raster; the low-energy image shows more bone contrast, as it must |
| **B — decomposition** | per-pixel 2×2 solve, bone-mineral map, region-map export (`build_dxa_regions.py`) + auto ROIs | soft-tissue pad test: single-energy value shifts, decomposed BMD does not (< 2%) |
| **C — the report** | BMC/BMD/T/Z per ROI, reference curves, report view; hip region | L1–L4 BMD on the shipped subject lands in a plausible adult range; moving an ROI edge moves the number honestly |
| **D — bone loss** | µ-scaling slider, serial comparison, Z vs T teaching | slider −30% → T-score crosses −2.5; rescan reproducibility < 1.5% at fixed pose |
| **E — polish** | tutorial, home card graduation, mobile pass | tutorial goals all achievable |

## 5. Open questions for ML

1. Reference population: one composite curve (simple) or sex-selectable tables (truer)?
2. Does the hip exam need both hips, or is left-hip-only acceptable for v1?
3. Vertebral exclusion (a degenerate L-level skewing the mean) — worth a per-level
   include/exclude toggle in v1, or defer?
