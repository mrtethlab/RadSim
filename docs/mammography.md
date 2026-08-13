# Mammography mode — plan

Soft-tissue contrast at 26–32 kV: a beam an order of magnitude softer than radiography's,
an AEC tuned for it, compression that is not optional, and the CC / MLO positioning that
makes screening work. The whole mode is one lesson taught four ways: at these energies the
photoelectric effect still cares about tiny differences in Z and density, and everything —
target, filter, kV, compression — exists to protect that contrast.

Status: **planning — awaiting review**. Nothing below is implemented.

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
| **A — beam** | mammo spectra (Mo/Mo, Mo/Rh, W/Rh) in the spectrum model; µ tables verified < 20 keV; fixed phantom slab imaged | glandular-vs-fat contrast measurably collapses as kV rises 24→34; filter switch shifts the curve as the K-edges say it must |
| **B — machine + phantom** | upright rig, receptor, paddle, breast phantoms at 4 densities | thicker/denser phantom at fixed technique → underexposed; AEC brings it back with the mAs the density chart predicts |
| **C — compression** | paddle drive, force readout, z-scale warp, scatter/dose coupling | halving thickness at fixed technique measurably raises contrast-to-noise and cuts dose; the image sharpens as structures separate |
| **D — views + findings** | CC/MLO presets, mag stand, seeded cases, ACR phantom | a speck cluster invisible at BI-RADS d + poor technique becomes visible with proper compression + AEC; ACR phantom scores reproducibly |
| **E — polish** | tutorial, home card graduation, mobile pass | tutorial goals all achievable |

## 5. Open questions for ML

1. Phantom scope: screening breast only, or also a chest-wall margin (pectoralis edge is
   how MLO adequacy is judged)?
2. Findings: procedural seeding as planned, or hand-authored cases in the Model Editor?
3. Is dose reported as average glandular dose (the mammography-legal number, needs a
   conversion-factor table) or entrance kerma (simpler, less honest)?
