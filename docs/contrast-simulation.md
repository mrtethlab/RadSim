# Contrast simulation — design

Real-time iodinated contrast for CT, and barium/CO₂ GI studies for x-ray. This document
records the architecture, the physics, and the decisions behind them. It is the reference
for the work; the phases at the end are the plan of record.

Status: **Phases 0-2 done: vessels, solver (mass-audited), and rendering. Contrast is
visible in x-ray; CT per-slice timing and the UI panel are next. See §6.1-6.2.** Nothing below is implemented unless a phase says so.

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

### 4.2 Arclength field — DONE (`app/build_vessels.py`)

`s` is the **geodesic** distance from the vessel's inlet, measured inside the mask. Not
Euclidean: the aorta is a hairpin, and straight-line distance from the root would put the
descending aorta next to the arch, so a bolus would reach the abdomen without traversing the
arch. Not a fitted centreline either: the pulmonary artery is a tree, and geodesic distance
generalises to branching for free where a longest-path polyline would discard every branch it
did not pick.

Verified on the chest: aorta geodesic **338.9 mm against a 298.5 mm bounding-box diagonal** —
longer than the straight line, so it is following the lumen. The PA's ratio is the inverse
(135 mm geodesic against a 400 mm diagonal) because tree *depth* is much less than the extent
the mask spans across both lungs. Directions check out: the aorta runs root → caudal, the PA
starts 65 mm from the heart centroid and ends 104 mm out.

Output is `<name>.vessels.json` (length, volume, flow direction, and the area profile A(s) the
solver needs for u = Q/A) plus `<name>.arclen.bin` — uint16 normalised s, one per vessel voxel
in raster order. Which voxels are vessels is already in `mat.bin` (id ≥ 29), so no index is
stored: **1.49 MB for 743 317 voxels**, against ~80 MB for a dense uint16 volume.

Two things the extraction had to handle, both worth keeping in mind:

- **Orphans.** A 1 mm grid breaks the peripheral pulmonary tree into ~281 disconnected
  islands. Left alone they keep s = 0, so a subsegmental branch would opacify with the main
  trunk. Each is given the s of the nearest connected voxel instead.
- **Seed thickness.** Every seed voxel starts the walk at 0, so a thick inlet band flattens a
  slab to s = 0. A 5 mm band gave the aorta a 10 717 mm² first bin — a 117 mm "vessel" — which
  would have handed the solver a near-zero inlet velocity. One voxel layer fixes it (aorta
  bin 0 is now 4× the median, which is genuinely the widest part).

### 4.2.1 The pulmonary artery inlet is approximate — follows from §4.3.1

The PA's first bin is still **21× its median area**: ~16 k voxels, 10 % of the vessel, sit at
s ≈ 0. The cause is anatomical, not a tuning problem. The inlet rule is "the end nearest the
heart", and the central PA lies against the heart over a broad contiguous surface, so that
rule selects a contact shell rather than a cross-section. Isolating the true inlet means
finding the **right ventricular outflow tract**, which needs heart chambers — the licence-gated
task in §4.3.1.

Until then, Phase 1 should clamp A(s) rather than trust the first few bins for the PA. The
build prints a warning naming the vessel whenever a first bin exceeds 6× the median, so this
cannot regress unnoticed, and it currently fires for the PA alone.

### 4.3 Pulmonary arteries — RESOLVED for the chest, blocked elsewhere

The `total` task has no `pulmonary_artery`. TotalSegmentator's **`lung_vessels`** task supplies
one, and this version separates arteries from veins (`lung_arteries` / `lung_veins`) — only its
`_LEGACY` variant returns a combined tree. Run on the chest CT it gives a **247 mL arterial
tree with 69 k voxels adjacent to the heart**, so the central PA is present, not just the
peripheral branches. The chest model is rebuilt with it.

**It does not transfer to the whole-body model.** That source (`data/vsd/z045`, VSD postmortem
full-body CT) is intact — nothing was lost — but re-running `lung_vessels` on it yields only
**12.9 mL of artery, 5.8 mL of vein, and zero voxels adjacent to the heart**. The lungs are
collapsed (523 mL of parenchyma against several litres in life) and the vessels are neither
distended nor blood-filled, so there is no tree for the network to find. This is a property of
postmortem imaging, not of the tool, and no re-run will fix it.

Its segmentation is also thin on vasculature generally: **1 of 18 named vessels** (aorta only,
107 mL), because it was segmented with a 45-label run rather than the 117-label one.

Consequence: **cardiac/pulmonary contrast work is confined to the `chest` model.** Extending
to the abdomen would need a living contrast-enhanced donor CT, not this one.

### 4.3.1 Heart chambers — BLOCKED on a licence

`heartchambers_highres` returns exactly what the cardiac compartment wants — myocardium, all
four chambers, aorta and pulmonary artery. It is **not openly available**: it requires a free
academic licence from https://backend.totalsegmentator.com/license-academic/, then
`totalseg_set_license -l <key>`. Requesting it is an account action for the repo owner.

Until then `heart` stays a single label. First-pass timing survives that (the heart is a mixing
compartment), but right-heart versus left-heart opacification — the thing a PE study actually
shows — does not.

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

### 6.1 Phase 1 status — runs, partly validated

`app/contrast_solver.py`. A 90 s solve takes **1.2 s**, so the on-demand design of §1 holds.

Getting there needed the scheme changed, not tuned. Explicit upwind + explicit diffusion was
limited by the SVC's *diffusive* stability to dt = 5.4e-6 s — **16.5 million steps**, and the
diffusive limit was 10-30x stricter than the advective one in every vessel, so no grid tuning
would have rescued it. Advection is now semi-Lagrangian and diffusion implicit (LAPACK banded
solve, factorised once per vessel since u and D are constant for a given flow). Both are
unconditionally stable, so dt = 10 ms is an accuracy choice: **9000 steps**.

**What is validated**

| check | result | expected |
| --- | --- | --- |
| CTPA 60 mL @ 5 mL/s — PA peak | **13.0 s** | 12–15 s |
| PA → aorta delay | **6.0 s** | 4–8 s (pulmonary transit) |
| IVC peak | 48 s | 50–70 s |
| Opacification order | SVC → PA → PV → aorta → IVC | correct |
| Organ order | kidney > spleen > pancreas > liver | correct |
| Cardiac output (Bae) | CO 3 → 653 HU @ 39 s; CO 8 → 404 HU @ 30 s | low CO ⇒ higher *and* later |

Two timing errors were found by attribution rather than guesswork, both physiological. The arm
vein was carrying only the injectate, giving tau = 60/4 = 15 s and putting **every** downstream
peak 15 s late — it carries the patient's own arm venous return too. And 750 mL of mixing
chamber on the RV→LA path was ~1.7x the real transit volume, stretching PA→aorta to 11 s.

**The mass audit** (`solve()` returns `audit`)

Every compartment's iodine is summed each step — vessels as `c·A·dx`, chambers as `c·V`, beds
as both compartments — and compared against injected minus excreted. It found **three genuine
leaks**, all in the coupling rather than the scheme:

1. **Arterial over-draw of 2.2 × CO.** The aorta, the arch branches, the organ beds and the
   body pool were each fed `left_heart.c` *in parallel*, while the left heart was debited only
   CO. That minted `1.2 × CO × c_art` of iodine every second. The systemic beds are now fed
   **downstream of the aorta** and the outlet fractions are asserted to sum to 1.0.
2. **Arm venous return** drawn from the body pool without debiting it.
3. **SVC flow inconsistency** — the vessel transported `q_upper` but the right heart was
   charged `c_out × (q_arm + q_upper)`. A vessel's transport flow must equal the flow charged
   to whatever it drains into; the junction now hands over its mass at the transport flow,
   which stays conservative however the injection rate varies.

Balance now closes to **0.34–0.44 % of injected dose**, uniformly across configurations. It
converges to 0.33 % as dt → 0, so the residual is the semi-Lagrangian scheme's spatial
non-conservation, not a leak. In HU terms it is 115 mg over 5 L: **0.6 HU**, below noise.

**The ceiling excess was recirculation, not a leak.** With mass closed, `recirculation=False`
severs the returning paths — a leak would survive that cut, returning iodine would not:

| case | ceiling | full | ratio | no recirc | ratio |
| --- | --- | --- | --- | --- | --- |
| CTPA 60 @ 5 | 525 | 408 | 0.78 | 407 | **0.77** |
| 100 @ 4 | 420 | 456 | 1.09 | 417 | **0.99** |
| routine 100 @ 3 | 315 | 395 | 1.25 | 326 | **1.04** |
| CO 3 | 700 | 639 | 0.91 | 633 | **0.90** |
| CO 8 | 262 | 359 | 1.37 | 276 | **1.05** |

Every case falls to ≤ 1.05 — the first-pass bound holds exactly. The pattern is physiological:
CTPA (12 s injection) and CO 3 (100 s loop) do not move at all, because nothing has time to
return before the peak; CO 8, with the shortest loop at 38 s, drops the furthest. **flux ÷ CO
is only a valid bound for injections short relative to loop transit time** — that was the wrong
yardstick, not a broken model.

**Organ calibration.** Four errors, each found by the audit rather than by tuning:

- **The portal vein bypassed the liver**, draining straight to the right heart. The liver ran
  on the hepatic artery alone — 6.5 % of CO instead of ~26 % — and could not show a portal
  venous phase at all. `OrganBed` now takes a dual supply.
- **Organ EES was 2–3 × oversized** (liver 900 mL for a 1500 mL organ). Since the EES only
  fills while `c_iv > c_ees`, an oversized one dominates the mean and the organ rises
  monotonically for the whole scan instead of peaking. Interstitium is ~20 % of organ volume.
- **Enhancement was averaged over `V_iv + V_ees`, not organ volume.** Most of an organ is
  cells, which hold no contrast but are still in the voxel — the liver reported 160 HU where a
  real one enhances 50–60.
- **No whole-body interstitium.** With the kidney's 2 mL/s GFR as the only sink, the 5 L blood
  pool decayed over 42 minutes, so nothing washed out. The ~9 L of muscle/fat/skin
  interstitium is the largest sink in the body; the two body beds now carry it, tuned to a
  ~70 s redistribution half-life against the audit's intravascular fraction.

| | model | real |
| --- | --- | --- |
| liver | 61 HU, broad 70–180 s plateau | 50–60 HU, portal venous plateau |
| spleen | 102 HU @ 49 s | 80–100 HU @ 50–60 s |
| kidney | 218 HU @ 43 s | 150–250 HU @ 40–60 s |
| pancreas | 69 HU @ 71 s | 80–100 HU @ 40–50 s |
| aorta | 456 HU @ 33 s | 300–400 HU @ 30–40 s |
| aorta at 3 min | 123 HU | 90–120 HU |
| intravascular at 3 min | 49 % of dose | 35–45 % |

**Still not right**

- **Aortic peak ~15 % high** (456 vs 300–400). Not a leak — the no-recirculation ratio is 0.99.
  Most likely `HU_PER_MGI_ML = 25` standing in for a real mu(E), which §3.1 replaces.
- **Pancreas peaks ~25 s late and low**; liver plateau is broad rather than peaked at 60–70 s.
- **Intravascular fraction 49 % vs 35–45 %** — whole-body redistribution still slightly slow.
- **Arch branches (ids 35–39) are visualisation-only taps**: fed from the proximal aorta but
  draining nowhere, so they hold iodine never debited from the aorta. Worth ~0.2 % of dose.

### 6.2 Phase 2 status — contrast renders, end to end

**Iodine is a virtual material column, not a material.** Contrast is not something a voxel
can BE, it is a concentration a voxel can CARRY, varying continuously in space and time. So
it rides as one extra column past the end of the legend: the tracer accumulates
concentration-weighted path length (cm x mgI/mL) into it and a matching mu row (cm^-1 per
mgI/mL) turns that into optical depth. Both engines already compute `L @ mu`, so neither
integration loop changed, and the GPU backend picked it up through `mat_columns()` untouched.

**Iodine carries its own energy grid** because of the K-edge at 33.17 keV, where mu/rho jumps
~4x. The shared 9-point grid straddles it between 30 and 40 keV, so log-log interpolation
would draw a smooth ramp through it and erase the effect that makes iodine work at all.

| | model | reference |
| --- | --- | --- |
| HU per mgI/mL at 70 keV (120 kVp) | **26.1** | textbook 25-26 |
| HU per mgI/mL at 50 keV (80 kVp) | **54.2** | — |
| 120 -> 80 kVp boost | **2.08x** | ~2x, the standard CTA trick |
| K-edge jump | **3.97x** | NIST XCOM ~4.0 |

**The pieces**

- `contrast_export.py` packs a solve into the renderer's timeline: 64 arclength samples,
  uint16 quantised. A 90 s run is **0.45 MB**, and one quantisation step is 0.16 HU.
- `contrast.js` builds the two lookups the trace wants — `sVol` (arclength bin per voxel,
  expanded from the sparse `arclen.bin` in **20 ms** for 40 M voxels) and `concLUT` (48 KB,
  mgI/mL per material per bin, rebuilt per acquisition). Organs fill every bin of their row
  with one value, so vessels and organs index identically and the hot loop needs no branch.
- `POST /contrast/timeline` solves on demand — **1.26 s** — which is what lets every injector
  parameter stay freely continuous instead of one of N presets (§1).
- The GPU backend builds its own per-voxel arclength from the same `arclen.bin`, so the wire
  carries the 48 KB table rather than a 40 MB field.

**Verified end to end**

- browser tracer: a ray through 8.8 cm of aorta at t=33 s accumulates 160.3 cm·mgI/mL against
  159.1 expected; the aorta shows a real root-to-distal gradient (18.2 -> 17.8 mgI/mL)
- GPU backend: contrast darkens 11,172 of 16,384 pixels (up to 63.8 % less signal) and leaves
  4,935 bit-identical where no vessel lies in the path
- **with contrast off, every material path length is bit-identical to before** — unenhanced
  scans are untouched
- in the running app, a chest radiograph's mediastinum tracks the bolus:

  | scan time | 5 s | 15 s | **25 s** | 40 s | 70 s |
  | --- | --- | --- | --- | --- | --- |
  | signal vs unenhanced | -6.2 % | -19.8 % | **-25.4 %** | -15.6 % | -12.1 % |

**Not done in Phase 2**

- No UI yet — `window.radsimContrast` drives it until the panel lands (Phase 3).
- Per-slice acquisition time is written (`acquisitionTime` in contrast.js) but **not yet wired
  into the CT scan loop**, so a helical scan still images every slice at one instant. That is
  the piece that makes "you scanned too early" visible in CT rather than only in radiography.
- The aortic peak is still ~15 % high. Real mu(E) did not explain it — 26.1 against the
  assumed 25 is 4 % — so it stays a solver concentration matter, recorded in §6.1.

---

## 7. Teaching notes

Things the architecture gives for free and should be surfaced deliberately:

- scanning too early (nothing opacified) or too late (venous) — the whole skill; a timeline
  scrubber against the chosen scan window makes the error legible
- low kVp boosting iodine — falls out of §3.1
- cardiac output changing timing — falls out of §2.4
- bolus chase on a fast helical — falls out of §3.3
