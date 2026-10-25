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
- **Views**: CC and MLO pose the phantom (the C-arm rotates 0° / 30–70°, set to the patient — §7); a small
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

## 7. Positioning, judged on the film

A screening view is good by how much breast it brought onto the receptor, and the criteria
that grade it (ACR / the PGMI scheme) are all read off the image. The mode now lets the
learner place each view and then grades the film it produced. Model and judge:
`core/mammoPosition.js`; the anatomy it builds and the projector: `mammo.js`; tests:
`test/mammoposition.test.js`.

**The controls** (each view keeps its own placement, as at the machine):

- **Pull the breast forward** — tissue drawn off the chest wall onto the receptor.
- **Lift the fold (IMF)** — on the CC, the receptor belongs at the fold's natural mobility
  (too low drops inferior-posterior tissue, too high pulls the superior away); on the MLO,
  "up and out" opens the fold.
- **C-arm angle** (MLO, 30–70°) — parallel to *her* pectoral muscle. The case's patient has
  a build and a muscle angle (40–60°: short and broad flatter, tall and slender steeper),
  shown in words as a technologist would see them.
- **Rotation** (CC) — trades medial tissue for lateral across the chest-wall edge.
- **Nipple roll** — the patient's nipple points where it points (per case); rolling the
  tissue brings it back into profile. Only tilt OUT of the image plane takes a nipple out of
  profile, so the CC sees all of a downward tilt and the MLO cos(angle) of it.

**How placement becomes anatomy.** The phantom is cut at the chest wall, so every manoeuvre
lands on one quantity: how many centimetres of posterior tissue stay behind the receptor's
chest-wall edge, per image column (`edgeLossCm`). The projector shifts each column's anatomy
by that much — tissue behind the edge never reaches the detector (row 0 of the detector is
now the edge itself; the rows behind it used to image tissue no detector could see). Two
things are rebuilt in a PRIVATE copy of the volume, never in the shipped phantom: the baked
pectoral slab gives way to the muscle the view brings in (the MLO's wedge, oriented with the
patient's own muscle, deepest toward the axilla and tapering just above the nipple level; the
CC's thin central sheet, which shows only on an excellent pull — about a third of CCs), and the
nipple is re-stamped where tilt and roll leave it, under its own label so the film can find it.
On the MLO an upper-abdomen block below the fold stands clear when the breast is lifted and
overlaps it as a skin fold when it sags. The C-arm sets how the muscle lies: parallel, it
drapes forward and its border is convex; off-angle it flattens, then draws back (and the error
costs posterior tissue as its square — five degrees is cheap, fifteen loses the muscle).

The MLO used to turn the anatomy the other way — geometrically an LMO (beam superolateral to
inferomedial). It now runs superomedial to inferolateral, so the axilla, and the muscle, sit
in the image plane where an MLO puts them.

**The judge reads the exposed image**, from the projector's per-pixel maps (tissue, muscle,
nipple, abdomen chords) — never from the slider positions:

| View | Criterion | Measured as | Grading |
| --- | --- | --- | --- |
| MLO | PNL | nipple centroid to the pectoral border's fitted line, perpendicular to it; to the film edge where the line meets it first | reported |
| MLO | muscle to the PNL | distance along the border from the PNL's foot to the muscle's tip | past: met · ≤1 cm short minor · ≤2 moderate · beyond, or no muscle: major |
| MLO | border convex/straight | mean deviation of the border from the chord tip→widest column | concave minor, ≤ −2.5 mm moderate |
| MLO | angle | the fitted border against the chest-wall edge | 15–45° met |
| MLO | IMF open | breast's inferior contour vs the abdomen at the chest-wall rows | ≥1 mm clear met · closed minor · overlapping (skin fold) moderate |
| CC | PNL within 1 cm of the MLO's | nipple straight back to the edge (or to the muscle if it is on the film) | ≤1 met · ≤1.5 minor · ≤2 moderate · beyond major; provisional until an MLO exists; at least minor if the MLO's own PNL stops at the film edge |
| CC | medial tissue | posterior depth at mirror columns either side of the breast's centre (the phantom is symmetric, so any difference is placement) | medial >0.5 cm shallower minor, >1 moderate |
| CC | pectoral muscle seen | at the posterior edge | informational |
| both | nipple in profile | share of the nipple standing clear of the skin line (≥ ½) | inside by <1 cm minor, else moderate |
| both | no cut-off | tissue on a side or the anterior edge | major |

PGMI: Perfect (all met) · Good (minor only) · Moderate (a moderate, or three minors) ·
Inadequate (a major: tissue missing or cut off — repeat). The film carries the PNL (yellow),
the muscle's fitted border (dashed) and the fold, drawn where they were measured; a toggle
hides them. Spot (MAG) views and the QC slab are not graded.

**Measured** (demo patient, 40 mm, through the console):

- Well placed (pull 100 %, CC lift at the fold's 60 %, slight medial rotation; MLO lift 80 %,
  C-arm 50° on her 50°): MLO PNL 10.0 cm to the muscle, muscle 4.7 cm past the PNL, convex
  (+3 mm), 31°, fold open 0.9 cm; CC PNL 10.5 cm (the muscle on the film, 0.9 cm) — +0.5 cm
  against the MLO. Both **Perfect**.
- As first placed (pull 45 %, lift 30 %, C-arm 45°): the MLO has no muscle on the film, its
  PNL stops at the edge at 7.6 cm and the fold is closed with a skin fold — **Inadequate**. The
  CC (7.2 cm) agrees with that short MLO within a centimetre and is still marked down, because
  a short reference proves nothing.
- C-arm against her 50° (pull 90 %): within about ±10° the view stays Perfect while the muscle
  shortens (4.4 → 0.9 cm past the PNL) and its border flattens from convex to straight; 12°
  off it ends 1.3 cm short (Moderate), 13–15° off it is gone — Inadequate.
- Case C's nipple points 18° down: unrolled on the CC it sits 0.4 cm inside the skin line
  (minor); rolled up 18° it is in profile.
- CC rotated laterally by a quarter of the control's travel: medial 0.5 cm shallower (minor);
  by half: 1.0 cm (moderate).
- The AEC cell now rides with the tissue (the technologist sets the sensor under the gland),
  so placement does not move the exposure: CC 57.7 mAs well placed vs 53.8 as first placed;
  57.8 with the old geometry.

**Tests**: 14 (`test/mammoposition.test.js`) — the judge on synthetic films with closed-form
answers (perpendicular PNL, reach along the border, fold gap, PNL pairing, medial deficit,
the PGMI rule) and the real phantom cast at quarter resolution through the console's own
`castMammo`. Each of twelve deliberately re-introduced bugs fails at least one of them (PNL
measured straight back instead of perpendicular, reach sign, profile test inverted, fold gap
sign, three minors staying Good, medial sign, rotation sign, linear angle cost, the MLO turned
back to an LMO, no per-column shift, the nipple ignoring its tilt, the baked slab left in).

**What it does not model**: the placement is a per-column loss of posterior tissue and a
re-stamped muscle and nipple, not a deformation of the breast; the drape that makes a muscle
border convex or concave is a modelled consequence of the C-arm angle, not of a tense patient
(the shoulder is not modelled), and the projection softens it — concave borders are mild;
skin folds exist only at the IMF; the patient's breast is symmetric, which is what lets a
medial/lateral depth difference stand for rotation; and the thresholds are teaching values set
from the published criteria (PNL 1 cm rule, muscle to the PNL) and from what this phantom's
geometry produces, not from a reader study.
