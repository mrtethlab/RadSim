# Mammography mode — plan

Soft-tissue contrast at 26–32 kV: a beam an order of magnitude softer than radiography's,
an AEC tuned for it, compression that is not optional, and the CC / MLO positioning that
makes screening work. The whole mode is one lesson taught four ways: at these energies the
photoelectric effect still cares about tiny differences in Z and density, and everything —
target, filter, kV, compression — exists to protect that contrast.

Status: **shipped** — all five phases built, measured and merged. Per-phase exit results
are in the table below; deviations from this plan are recorded where they happened.

## 1. What exists to build on

- The polyenergetic raycaster and `muOverBins` machinery work at any keV the attenuation
  tables cover; the tables need checking (and likely extending) below 20 keV, where the
  photoelectric term dominates and interpolation error costs real contrast.
- The AEC (three cells, backup mAs) ports directly — it just meters a softer beam.
- The Model Editor + build-script pipeline is the way to make the phantom.
- The fluoro warps proved geometric deformation is affordable; compression is a milder
  version of the same trick.

## 2. The machine

One upright unit (the CT-gantry build pattern): tube head above, receptor plate below,
compression paddle between. The BREAST is the subject — a purpose-built voxel phantom, not
a crop of the whole-body model, because screening resolution demands ~0.1–0.2 mm voxels
over a small volume (the hi-res shoulder precedent).

- **Target / filter seg**: Mo/Mo · Mo/Rh · W/Rh. Each is a different spectrum, not a
  different constant — Mo's characteristic peaks at 17.5/19.6 keV are the whole reason
  the anode is molybdenum, and the Rh filter's K-edge is why dense breasts switch to it.
- **kV 24–34**, small steps; the useful range is that narrow, which is itself the lesson.
- **Compression**: a paddle drive with a force readout (N, not "thickness"). Compression
  thins the breast (geometric z-scale warp of the phantom + the paddle visibly descending),
  which cuts scatter, cuts dose, freezes motion and separates structures — the image gets
  BETTER as the patient gets less comfortable, and the mode should make that trade felt.
- **AEC** behind the receptor, metering under the densest region; manual override.
- **Views**: CC and MLO presets pose the phantom (the C-arm rotates 0° / 45–60°); a small
  magnification stand doubles OID for spot views, trading dose and field for sharpness.
- **Grid**: mammo grids move during exposure; model as a scatter cut + Bucky factor.

## 3. The phantom(s)

`build_breast.py` (region-builder pattern) generates layered phantoms:

- New materials: **Glandular** (~35 HU at CT energies but defined by its low-keV µ, which
  is where it separates from fat) and reuse Fat, Skin, Calcification.
- Parenchyma as a fractal/blobby glandular-in-fat mix at four densities (BI-RADS a–d);
  density is the variable that changes technique, dose and sensitivity all at once.
- **Findings, procedurally seeded**: microcalcification clusters (0.1–0.3 mm — at the
  voxel limit deliberately), a spiculated mass, a circumscribed cyst. A seed selector
  ("Case 1..N") so learners can be blinded.
- An **ACR-style QC phantom** (fibres, speck groups, masses in wax) — scoring an image of
  it is a real technologist task and a perfect exit test.

## 4. Phases

| Phase | Scope | Exit test |
| --- | --- | --- |
| **A — beam** ✅ | 3-bin mammo spectra per target/filter; the projector carries its OWN low-energy µ table (the house HU-model clamps at 20 keV and gives fat/gland a constant ratio — it would have erased the mode's central lesson) | **passed**: tissue contrast SD falls 20.3 → 15.9 as kV rises 24 → 34; W/Rh at 28 kV keeps 13.0 where Mo/Mo keeps 19.7 |
| **B — machine + phantom** ✅ | upright rig, receptor, paddle; ONE phantom shipped (0.4 mm, 15.3 M voxels, BI-RADS c at 30 % glandular, seeded findings); density variants deferred to D | **passed**: AEC meters the gland and lands 60.6 mAs / AGD 1.72 mGy at 28 kV / 40 mm — textbook screening numbers; exposure 280 ms |
| **C — compression** ✅ | motorised paddle drive with force readout; compression is a volume-conserving affine (c axially, 1/√c laterally) driving the 3D mesh AND the raycast from one mechanism — rays pull through the inverse, one chord-ratio per ray corrects the path lengths | **passed**: 40 mm at 126 N; under AEC, releasing to 72 mm rails the generator (400 mAs, AGD 6.25 mGy) while compressed runs 60.6 mAs / 1.72 — the paddle cuts the dose 3.6× as the image improves |
| **D — views + findings** ✅ | CC/MLO; MAG ×1.8 stand (raised base plane — the cone does the rest); dense (d, 50 %) phantom; ACR-style QC slab (fibres/specks/masses, hardest-first); patient-correct orientation (chest wall at the front edge, nipple to the gantry); full-res bay reading surface; median/IQR display window; photon budget ×10 to mammographic SNR (AEC target scaled — mAs/AGD calibrations untouched) | **passed**: mag overfills the fixed receptor and pays ×3.25 on the meter; dense d meters 68 vs c's 56 mAs; the seeded speck cluster carries 1.1–1.8 lnT excess in the raw projection and its conspicuity climbs 2.1× (starved technique) → 2.7× (AEC) → 3.0× (compressed + AEC) over the p99.9 texture floor; the QC slab scores as it should — speck groups visible descending in difficulty, masses faint, fibres at the limit. Case-seed blinding selector → E. Honest note: affine compression buys dose/noise/spread, not de-superposition |
| **E — polish** ✅ | blinded reading cases (findings injected analytically, not baked — A–E are unseen and two are NORMAL, with a reveal); detector to 0.245 mm; 8-step tutorial; mobile pass; card graduated | **passed**: on the demo case the sharp-scale conspicuity is 0.62 against a 0.15 texture floor and a normal case's 0.27 — a 4.1× margin; every tutorial step finds its target; mobile renders all five console groups with EXPOSE docked under the thumb (718 ms/exposure); x-ray and fluoro regression-clean |

## 5. The questions, answered by building

1. **Phantom scope** — screening breast WITH a chest-wall margin: a pectoralis slab ships
   in the phantom, which is what makes the MLO worth having.
2. **Findings** — procedural, and injected at READ time rather than baked into the volume.
   That was not the plan, and it is better than the plan: cases can be blinded (A–E are
   unseen, two are normal), a case costs nothing to ship, and a 0.4 mm speck stays
   sub-voxel where a baked one would alias against the 0.4 mm grid.
3. **Dose** — average glandular dose, the number mammography is legally reported in,
   parameterised on mAs, kV and compressed thickness and calibrated to ~1.7 mGy for a
   compressed scattered breast at 28 kV.

## 6. What this mode does NOT model

Stated plainly, because the rest is measured:

- **Compression is affine, not deformable.** It buys the real dose, noise and spread —
  thickness 72 → 40 mm cuts AGD 3.6× and spreads the breast 1.29× across the receptor —
  but it does not separate superimposed structures the way squeezing real tissue does.
- **Scatter and the grid** are absorbed into the technique rather than transported.
- **The detector is 0.245 mm**, finer than the 0.4 mm speck it must show but still
  coarser than the 50–100 µm a real unit runs; screen-limited resolution is therefore
  optimistic about large detail and pessimistic about the very smallest.
