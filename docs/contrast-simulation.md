# Contrast simulation — design

Real-time iodinated contrast for CT, and barium/CO₂ GI studies for x-ray. This document
records the architecture, the physics, and the decisions behind them. It is the reference
for the work; the phases at the end are the plan of record.

Status: **Phase 0 in progress.** Nothing below is implemented unless a phase says so.

---

## 1. The storage decision

The obvious design — precompute, for each combination of injector settings, a per-voxel
map of ΔHU at 1 s intervals — does not survive arithmetic:

| model             | voxels  | one 90 s timeline @ 1 Hz, int16 |
| ----------------- | ------- | ------------------------------- |
| chest             | 40.3 M  | **7.3 GB**                      |
| wholebody         | 29.7 M  | 5.3 GB                          |
| chestabdopelvis   |  8.4 M  | 1.5 GB                          |

That is *per parameter set*. A modest grid — 4 contrast volumes × 4 flow rates × 3 delays
× 3 heart rates — is 144 combinations, so ~1 TB for the chest alone. Unbuildable in
reasonable time, and undeployable regardless (the sub-mm volumes are already gitignored
for being over 100 MB).

The field does not need that many numbers. Contrast concentration varies **smoothly along
a vessel** and **near-uniformly within an organ** — the latter being the simplification
already accepted for perfusion (whole-organ enhancement, no sub-tissue detail on first
pass). So the state is stored on the vascular graph, not on the voxel grid:

- `C(s, t)` per vessel — ~20 vessels × 200 arclength samples × 90 s × float32 ≈ **1.4 MB**
- `C(t)` per organ — ~15 organs × 90 s ≈ 5 KB

**~1.5 MB instead of 7.3 GB.** Per-voxel ΔHU is then evaluated lazily at scan time, from
the voxel's compartment and its position along that compartment.

### Consequence: no precomputed library at all

A 1-D solve over ~4000 nodes × ~9000 timesteps is milliseconds in NumPy. Once the state is
that small, precomputing a *library* is pointless — the solver runs on demand whenever the
injector settings change. The combinatorial explosion disappears, and every injector
parameter becomes freely continuous rather than one of N presets.

It also makes bolus tracking straightforward: HU at any ROI at any time is a query against
the graph, with no volume ever materialised.

---

## 2. Physics

### 2.1 Why 1-D advection–dispersion is the real model, not a shortcut

3-D Navier–Stokes over the circulation is infeasible here and would not buy realism at the
scale a scan resolves. The correct model for bolus transport in large vessels is **1-D
advection–dispersion**, and it genuinely models the mixing of contrast with unenhanced
blood: Taylor–Aris dispersion spreads the bolus, dilutes it, and produces the characteristic
asymmetric time–attenuation curve with its long tail. This is what the contrast-CT
pharmacokinetic literature uses (Bae et al.), and it reproduces measured aortic TACs.

Per vessel segment, with `c` the iodine concentration (mgI/mL), `u` the mean velocity and
`D` the effective dispersion coefficient:

```
∂c/∂t + u ∂c/∂s = D ∂²c/∂s²
```

`u = Q / A` from the segment's flow and cross-sectional area; `D` from the Taylor–Aris
relation, which ties dispersion to velocity and radius, so a wide slow vein disperses
differently from a narrow fast artery — falling out of the geometry rather than being tuned.

### 2.2 Organ perfusion — two compartments

Per organ, intravascular (IV) and extravascular extracellular space (EES), exchanging:

```
V_iv dc_iv/dt  = Q_org (c_art − c_iv) − PS (c_iv − c_ees)
V_ees dc_ees/dt = PS (c_iv − c_ees)
```

`Q_org` is organ blood flow, `PS` the permeability–surface product. This gives parenchymal
enhancement and washout with the right shape, and the renal/hepatic timing differences fall
out of their different flows rather than being scripted.

### 2.3 Recirculation

Essential, and the reason the aorta does not fall to zero after first pass. The segments and
organs close into a loop through the heart, so contrast returns diluted by total blood
volume. Without it the curves are qualitatively wrong after ~40 s.

### 2.4 Driving parameters

Cardiac output is the single largest source of real-world timing variability and the most
useful teaching lever: low output ⇒ later arrival, higher and later peak. Peak arterial
enhancement scales with iodine flux (mgI/s) divided by cardiac output.

---

## 3. Rendering

### 3.1 Iodine must become a real material

`materials.js` currently has `{ id:20, name:'Iodine contrast', hu:350, kind:'tissue' }` —
water scaled to 350 HU via the tissue basis decomposition. That has **no K-edge and no
photoelectric energy dependence**, which is precisely the physics that matters for contrast:
iodine's K-edge at 33.2 keV is why enhancement is far stronger at 80 kVp than at 140 kVp.

Iodine moves to `kind:'elem'` with a NIST-style mass-attenuation curve × density. Correct
kVp dependence then costs nothing, and dual-energy becomes reachable later.

### 3.2 One extra path-length channel

The engines accumulate path length per material and take `L @ mu`. Contrast adds a single
concentration-weighted channel:

```
attenuation = L_materials @ mu  +  (∫ c(x,t) ds) · mu_iodine
```

One extra accumulation in `engine.py` / `ct.py` and their browser counterparts. Cheap, and
spectrally correct because `mu_iodine` is a real curve.

### 3.3 Sample contrast at each slice's acquisition time

A helical chest takes ~5 s, so the first and last slices see different bolus phases. Since
`c` is queryable at arbitrary `t`, sampling per slice acquisition time is free — and it
produces genuine bolus-chase behaviour rather than a volume frozen at one instant.

---

## 4. Model groundwork

### 4.1 Vessel identity is currently discarded

`build_model.py:93` maps all 18 vascular structures to a single `BLOOD` id. The source
segmentation retains them with realistic volumes:

| structure | volume | | structure | volume |
| --- | --- | --- | --- | --- |
| heart | 631 mL | | inferior vena cava | 81 mL |
| aorta | 379 mL | | iliac arteries L/R | 31 / 28 mL |
| pulmonary vein | 32 mL | | iliac veins L/R | 38 / 27 mL |
| superior vena cava | 24 mL | | portal + splenic vein | 24 mL |
| subclavian arteries L/R | 20 / 18 mL | | brachiocephalic veins L/R | 20 / 9 mL |
| carotids L/R | 11 / 10 mL | | brachiocephalic trunk | 6 mL |

Each vessel gets its own material id, so **vessel identity becomes material identity** and
costs zero extra per-voxel storage. Unenhanced HU stays 45 (blood) for all of them, so
nothing looks or images differently until contrast is added.

Legend grows 29 → ~50. Today's `mat_columns()` fix already makes a legend-length change safe
across old and new models.

### 4.2 Arclength field

Vessels additionally need a normalised position along the centerline per voxel, for the
`C(s,t)` lookup. Stored sparsely — vessel voxels are a small fraction of the volume
(404 k in the chest).

### 4.3 The pulmonary artery is missing — OPEN

This TotalSegmentator class map has `pulmonary_vein` but **no `pulmonary_artery`**, no heart
chambers, no coronaries. The PE double-rule-out needs the main PA; it is the vessel the
tracker goes on. Two options, undecided:

- run TotalSegmentator's `lung_vessels` task — real anatomy, needs a GPU re-run
- synthesise the main PA and bifurcation from the heart and hilar geometry — fast, approximate

### 4.4 Legend duplication is a standing hazard

`materials.js` `LIST` and `build_model.py` `LEGEND` are hand-duplicated and must agree in
id, order and count. A mismatch is exactly the bug that broke CT scout for seven models
(28-entry legend vs 29-row mu table). Phase 0 adds ~18 entries to both, so it also adds a
consistency check that fails loudly rather than at render time.

---

## 5. X-ray GI studies

Different physics, and worth being honest about: free-surface flow of a non-Newtonian fluid
in a deformable, peristaltic lumen under gravity is a research CFD problem, not a feature.
The right model at this scale is kinematic:

- transport along the GI centerline with a peristaltic wave
- gravity-dependent pooling driven by **patient position** — tied to the existing object
  rotate/tilt sliders, since positioning to move barium *is* the barium study
- a mucosal **coating layer** for double contrast: barium coats the lumen wall, CO₂ distends
  it, and the diagnostic image is the coated mucosa seen through gas

Stomach, small bowel and colon are already segmented. Oesophagus coverage needs checking.

---

## 6. Phases

| phase | deliverable |
| --- | --- |
| **0** | Per-vessel material ids in both legends + consistency check; centerline/arclength extraction; model rebuilds. PA sourcing pending §4.3. |
| **1** | Haemodynamic solver (Python): injector + patient settings → `C(s,t)` per vessel, `C(t)` per organ. |
| **2** | Renderer: iodine as `elem` with real μ(E); concentration path-length channel in both engines and both modes; per-slice acquisition time. |
| **3** | Contrast side panel — pull-out drawer, left edge. |
| **4** | Bolus tracking and triggering in CT scan planning; test-bolus as the alternative technique. |
| **5** | GI studies: swallow, enema, double contrast. |

First vertical slice: **CT chest through to a working PE double-rule-out**, before any GI work.

---

## 7. Teaching notes

Things the architecture gives for free and should be surfaced deliberately:

- scanning too early (nothing opacified) or too late (venous) — the whole skill; a timeline
  scrubber against the chosen scan window makes the error legible
- low kVp boosting iodine — falls out of §3.1
- cardiac output changing timing — falls out of §2.4
- bolus chase on a fast helical — falls out of §3.3
