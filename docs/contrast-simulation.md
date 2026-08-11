# Contrast simulation — design

Real-time iodinated contrast for CT, and barium/CO₂ GI studies for x-ray. This document
records the architecture, the physics, and the decisions behind them. It is the reference
for the work; the phases at the end are the plan of record.

Status: **Phases 0-3 done: vessels, solver (mass-audited), rendering, per-slice CT
timing, and the injector panel. Bolus tracking (4) and GI studies (5) are next. See §6.1-6.3.** Nothing below is implemented unless a phase says so.

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

**Two routes round the licence were tried and both fail. Do not retry them.**

*`total_v1`* appears in `class_map` with all four chambers and looks like an open alternative.
It is a historical index table, not a runnable task — the CLI rejects it
(`invalid choice: 'total_v1'`). Running `heartchambers_highres` without a key fails explicitly
with the licence notice, so there is no accidental way in either.

*Deriving the split geometrically* is the tempting one, because a chamber really is defined by
what connects to it: SVC + IVC + pulmonary artery on the right, pulmonary veins + aorta + left
atrial appendage on the left. All six are already segmented. It does not work, for a structural
reason rather than a tuning one:

- **Euclidean nearest-anchor** put the two centroids 3 voxels apart in x but 18 apart in z, and
  left *every* anchor — aorta and pulmonary vein included — closer to the "right" mask. It had
  partitioned the heart superior/inferior.
- **A separating plane** between the anchor centroids got the orientation right (left further
  left AND further posterior) but split 87 % / 13 %, with a plane normal dominated by z (0.74).
  Still a base-to-apex cut.

The cause is that **every available anchor clusters at the cardiac base** — the great vessels
all attach at the top of the heart — so any distance or plane derived from them measures depth
from the base, not laterality. The right and left hearts are separated by a septum that is not
segmented, and nothing else in the model constrains where it lies. Enhancement can't help
either: this is an unenhanced volume where blood and myocardium are both ~45 HU.

So the licence (or a different chamber segmentation tool) is genuinely required. A related
limitation to keep in view when it arrives: the `heart` mask is chambers **plus** myocardium,
and splitting it left/right would still treat the muscle as blood pool unless the chamber task's
separate `heart_myocardium` label is used to exclude it.

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

**Per-slice acquisition time (wired)**

A CT scan is not an instant. The couch travels at pitch x beam collimation per rotation, so
each slice is acquired at its own moment and gets its own concentration table:

```
couch speed (mm/s) = tableSpeedOf(g) / rotation time
slice time         = scan delay + |z_i - z_0| / couch speed
```

`sliceTime()` and `couchSpeedMMps()` are exported from ct.js so the model is testable rather
than buried in the scan loop, and they reuse the app's existing `tableSpeedOf` instead of
deriving a second table-speed model that could drift from the scan planner.

Distance is measured from the first slice **in acquisition order**, so a caudocranial scan
times correctly (|z - z0|, not a signed offset).

Measured in the app, 243 mm scan, 20 s delay:

| config | couch speed | first slice | last slice |
| --- | --- | --- | --- |
| SSCT 1 x 5 mm, pitch 0.938 | 9.4 mm/s | 20.0 s | **45.9 s** |
| MSCT 64 x 0.625 mm, pitch 0.938 | 75 mm/s | 20.0 s | 23.2 s |

The SSCT row is not a bug — it is why single-slice CT could not do CTA. The bolus washes out
before the scan finishes, and the model now shows that rather than asserting it. (SSCT
collimates to the slice thickness, not the 0.625 mm detector element, which `tableSpeedOf`
already encoded.)

The browser engine rebuilds the table per slice; the GPU engine does one per 4-slice batch,
which spans ~0.3 s of couch travel at 75 mm/s — inside the timeline's own 1 s resolution, so
it is below the resolution of the data underneath it rather than a compromise.

**Not done in Phase 2**

- No UI yet — `window.radsimContrast` drives it until the panel lands (Phase 3).
- The aortic peak is still ~15 % high. Real mu(E) did not explain it — 26.1 against the
  assumed 25 is 4 % — so it stays a solver concentration matter, recorded in §6.1.

### 6.3 Phase 3 status — the power injector

A pull-out on the left edge of the bay, tab labelled CONTRAST, laid out as a dual-syringe CT
injector: a contrast barrel and a saline barrel, the programmed sequence drawn to scale in
time, live readouts, and a transport bar.

**The scan delay is not a number you dial.** You press START, the clock runs, and the
enhancement you get is whatever the anatomy had reached at the moment you took the exposure.
That is the change that makes this worth having: a "scan at 25 s" slider let you pick the
answer, and committing to a moment is the actual skill the machine demands.

```
START pressed        -> clock runs from 0
exposure / CT scan   -> ctrstLatch() freezes the elapsed time
                        everything downstream reads S.contrast.scanTime
CT                   -> per-slice timing counts on from the latched value (§6.2)
```

Before START there is no enhancement at all — the patient has no contrast in them and the
images say so. The latched time survives until the next START, so the image you took keeps
corresponding to the delay you achieved.

**Controls.** The phase bar IS the programming surface: tap a phase and a keypad opens for
its volume and flow rate. A number is entered rather than nudged, because 97 mL is
twenty-four presses away from 100 on a +/- key — which is why the real console puts a keypad
there. Every phase stays on the bar even at zero, since a segment that vanishes when you set
it to 0 could never be set back. Out-of-range entries clamp rather than being rejected, with
the min/max beside the field so the correction is visible.

| where | what |
| --- | --- |
| Phase bar (tap) | delay; CM volume + flow rate; NaCl volume + flow rate |
| Agent | concentration |
| Patient | heart rate, stroke volume (cardiac output derived and shown) |
| Transport | START / reset, elapsed, pressure, delivered volumes |

CM is green and saline blue, the convention on the machines. Saline carries its own flow
rate, so `Injection.saline_rate_ml_s` is now plumbed through the timeline endpoint.

**Nothing tells you when to fire.** There is no "scan at" readout and no target on the plot —
only a green line that ticks along the curve in real time as the injection runs. Judging that
moment against the rising aorta is the exercise. After an exposure an amber mark appears
where you actually landed, as feedback rather than a prompt.

**Line pressure is real physics, not decoration.** Poiseuille through the 2.5 m coiled line
and a 20 G cannula, with contrast viscosity at 37 degC interpolated over concentration. The
fourth-power radius term is what makes cannula choice matter more than anything else on the
panel, and it reproduces the right numbers: 7.5 bar at 4 mL/s of 350 mgI/mL, ~19 bar at
10 mL/s. Reprogramming while the injector runs resets it, as it would on the machine.

The enhancement plot stays, now with two markers: green for the running clock, amber for
where an image was actually taken.

Verified in the app: START arms once a timeline exists; with no injection an exposure shows
no enhancement; after START, firing at a clock of 17.0 s latches 17.2 s and the mediastinum
reads -21.5 % against unenhanced, while the panel keeps counting (elapsed 00:20, 83 ml CM
delivered). The keypad commits 65 mL @ 6.5 mL/s to the bar and the totals, clamps 999 mL to
200, and the running marker advances monotonically along the plot.

**Availability.** When contrast cannot run the tab greys out, becomes inert, and puts the
reason in its tooltip; nothing is written into the panel, because a drawer whose every
control is dead is not worth opening to read a sentence. It re-enables on the next health
poll. The compute-engine toggle is *not* the gate — the browser ray-caster renders the iodine
column perfectly well (it produced the §6.2 timing series). What has no browser equivalent is
the haemodynamic **solve**, so the gate is service reachability. A solved timeline is
client-side, so scrubbing and scanning keep working even if the service then goes away.

**Vessel calibre and organ perfusion** are now real solver parameters on `Patient`.

`vessel_scale` multiplies the cross-sections measured from the segmentation. A diameter scale
is an area scale *squared*, and velocity is Q/A, so a wider vessel carries the same flow more
slowly and holds more blood — both push the bolus later:

| | aorta peak | at |
| --- | --- | --- |
| calibre 0.8 (slim) | 487 HU | 31 s |
| baseline | 456 HU | 33 s |
| calibre 1.3 (ectatic) | 413 HU | 35 s |

`perfusion_scale` multiplies the itemised organ beds' share of cardiac output — kidney 169 →
218 → 261 → 298 HU across 0.6 / 1.0 / 1.5 / 2.0. Two things it deliberately does NOT do:

- it does not scale `portal_frac`. Portal supply is set by gut flow, not by how well the liver
  is perfused, and scaling it would leave the portal vein transporting GUT_FRAC while the
  liver was charged something else — the same transport-vs-charged mismatch the audit found in
  the SVC. The liver therefore stays ~60 HU across the range, being portal-dominated, which is
  the physiologically right answer.
- it does not quietly leak. The lower-body pool gives up exactly what the organs gain, in
  **both** its supply and its IVC drainage, so the arterial outlets still sum to 1.0. The first
  attempt scaled the draw without matching the drainage and the mass balance blew out to
  -20.6 % / +24.9 %; it is back to 0.36-0.44 %, indistinguishable from baseline. Capped at 2.0
  so the lower-body share cannot go negative.

**Biphasic protocols.** `Injection` carries an optional second contrast phase, and
`Injection.phases()` returns the whole programmed sequence in delivery order — saline included,
since it carries volume but no iodine, which is exactly how the chaser clears the arm veins.
Both flux functions walk that list, so a single phase is just the degenerate case.

A fast bolus followed by a slower one is what a real biphasic protocol is for: it fills the
arteries then holds them filled while a long acquisition runs. The same 100 mL of iodine,
delivered two ways:

| protocol | aorta peak | at | time above 250 HU |
| --- | --- | --- | --- |
| single 100 mL @ 4 | 456 HU | 33 s | 30 s |
| 60 @ 5 then 40 @ 2 | 399 HU | 20 s | **37 s** |
| 50 @ 6 then 50 @ 1.5 | 368 HU | 17 s | **43 s** |

Lower peak, earlier, but a **43 % longer usable window** — the trade a biphasic protocol is
bought for. Mass balance is unchanged at 0.36-0.37 %.

The bar shows the second phase as its own segment, in a darker green (same agent, slower
phase), tappable like the rest. It stays on the bar at zero volume, following the same rule as
delay and NaCl: a segment that vanished when set to 0 could never be set back.

### 6.4 CAP vessel map — BLOCKED on the source scan, not on effort

Contrast works on `chest` only. Extending it to `chestabdopelvis` was repeatedly described as
mechanical. It is not, and the reason is the source data.

`chest` comes from the **3D Slicer CTChest sample** — a normal diagnostic CT, segmented locally
with TotalSegmentator. Every other subject comes from **VSD z045, a postmortem whole-body CT**,
and that is the problem. (An earlier revision of this section said `chest` came from the
TotalSegmentator *dataset*; it did not, and the distinction matters because that dataset is a
separate, and as it turns out very good, source of its own — see §6.8.)

What was established, in order:

1. Only `chest` carries vessel material ids at all; the others predate ids 29-46, so they need
   a rebuild through `build_model.py`, not just `build_vessels`.
2. The existing `data/vsd/z045/seg.nii` has 45 labels and, of the 18 vessel classes, exactly
   one (`aorta`). It predates the TotalSegmentator version that added the great veins.
3. It is also simply wrong: `lung_upper_lobe_right` is 540 voxels against a lower lobe of
   541,872, and `femur_left` spans z 28..3070 — the entire volume.
4. Re-segmenting the whole body OOMs on the export worker (512x512x3117 x 117 classes).
5. `--roi_subset` avoids the OOM but its coarse pre-crop shrank the volume to (128,134,1078)
   and returned 16 empty masks of 17 — the same noisy-anchor failure already documented for
   this dataset.
6. Cropping first and segmenting the crop *does* run cleanly. It does not help. A 30 cm
   abdominal block — which must contain liver, spleen, kidneys, aorta, IVC — produced
   **no aorta, no IVC, no portal vein, no iliac arteries**, one 1,278-voxel `iliac_vena_left`,
   and of the organs **only colon**.

Step 6 is the decisive one. It is not a crop, memory or class-availability problem:
TotalSegmentator is trained on living, largely contrast-enhanced CT, and a PMCT — airless
lungs, decomposition gas throughout, collapsed unopacified vessels, postmortem tissue
change — is out of distribution. The lungs confirm it independently: the largest connected
low-HU regions are ~8.8 cm blocks where a lung should be ~25 cm, because postmortem lungs are
fluid-filled.

**z025, the other whole-body subject, fails identically.** It had never been assessed, so it was
the obvious thing to check before accepting the blocker. Segmenting the WHOLE volume at 3 mm —
which avoids every objection about a mis-placed crop, and runs in about 70 s — returns 46 of 117
classes, and the ones that matter come back as fragments or not at all:

| structure | z025 | a real one |
| --- | --- | --- |
| aorta | 5.7 cm³ | ~380 cm³ |
| liver | 67.7 cm³ | ~1500 cm³ |
| heart | 41.0 cm³ | ~630 cm³ |
| IVC, portal vein, iliac arteries and veins | **absent** | — |
| spleen, both kidneys, pancreas, stomach | **absent** | — |

The same signature as z045: colon survives, the vasculature and most solid organs do not. Two
subjects from the same postmortem series, the same failure, so this is a property of the data.

Three cheap image-statistic proxies for "is this a living scan" were tried first and all three
were wrong — the last one was checked against the known-good chest source and reported 69 cm³ of
lung air on an obviously aerated diagnostic CT, because hole-filling never closes a lung that
connects to outside air through the trachea. **Segment it and look at what comes back** is the
only measurement here that has been trustworthy; `app/probe_cap_source.py` exists so the test is
one command on any future candidate.

**So CAP contrast needs a different source CT, not more segmentation effort.** A diagnostic
chest-abdomen-pelvis scan (the TotalSegmentator dataset is public and is where `chest` came
from) would segment normally and rebuild through the existing pipeline unchanged. Spacing is
already decided: 2.0 mm, which resolves aorta, IVC, iliacs and portal at 5-10 voxels across
while CTPA stays the chest model's job at 1 mm.

LE / UE / head-neck are not worth pursuing regardless of source: the segmented vessel set
stops at the iliacs, so nothing reaches the limbs, and the neck has only carotids and
subclavians.

### 6.5 Phase 4 — bolus tracking, and a shipped timeline for browser-only use

**Bolus tracking lives on the CT console, not the contrast panel.** It was first built into the
injector panel, which was wrong: on a real machine tracking is planned with the scan, in the
scan-group table, because it IS an acquisition. It moved.

**A group whose delay mode is `bolus` IS the monitoring series** — one slice, at one location,
reconstructed over and over. That is how a console plans it: a monitoring series ahead of the
diagnostic one, not a flag bolted onto the diagnostic scan. Choosing the mode collapses the
group's scan box to its own centre, so the scout shows a line rather than a block, and that
line is the level being monitored. When it triggers, `runScan` carries on to the next enabled
group, which is the diagnostic acquisition.

The Scan Delay column is therefore one of three things: a fixed time delay, bolus tracking with
an automatic trigger, or bolus tracking with a manual one. Picking the mode then asks for its
value — seconds, or a threshold in HU.

The tracking phase overlays the bay with the monitored slice on the left and the ROI
enhancement curve on the right, which is the layout every console uses because the operator
reads the anatomy and the curve together. The ROI is dragged onto the vessel first (state
`POSITION ROI`); pressing START TRACKING begins the repeated acquisition at ~1.5 s intervals
and the button becomes SCANNING PHASE, so the scan can always be fired by hand regardless of
the threshold.

Monitoring images are deliberately cheap — quick detector, no noise, no beam hardening —
because a real monitoring series is low-dose and nobody diagnoses from it. What matters is the
ROI number and how fast it is climbing.

Measured run, threshold 150 HU with a 2 s post-trigger delay:

```
 0.1s  -128 HU      6.1s   35        11.1s  205   <- crosses
 3.1s   -70         8.1s   99        12.1s  241
 5.1s     1         9.1s  133        fired at 11.06 s
```

Baseline, then a steep rise through the trigger level — the shape a console draws.

**Shipped timeline.** `chest.contrast.json` is one protocol solved offline by the same solver
the service runs — 0.37 MB, **70 KB gzipped**. When the compute service is unreachable the
panel loads it instead of refusing, because a SOLVED timeline is just data: the whole timing
exercise (start the injector, judge the moment, scan) is client-side and identical. Only
*reprogramming* the injector needs the service.

So the controls that would change the protocol are locked rather than the feature removed, and
a banner says why — a slider that silently does nothing is worse than one visibly unavailable.
Bolus tracking is deliberately NOT locked: it reads the timeline, it does not change it. If the
service appears later the controls unlock, and the preset stays in place until something is
actually changed so the image does not move under the user.

This is what makes contrast work on GitHub Pages, where there is no service at all.

**Bolus tracking.** A monitoring series watches one vessel; the scan starts when its
enhancement crosses a threshold, plus a diagnostic delay. It presses the same `ctStart` the
operator would, and says so plainly when the console is not ready rather than failing mute.

It reads the same timeline the renderer does, so it needs no extra solve and works on the
preset as well as a live one. Measured on the reference protocol:

| | 5 s | 10 s | 15 s | 25 s |
| --- | --- | --- | --- | --- |
| pulmonary artery | 145 HU | 323 | 400 | 490 |
| aorta | 0 HU | 51 | 215 | 413 |

The PA crosses 150 HU at ~5 s and the aorta at ~14 s. That ~9 s gap **is** the PE double
rule-out, and it is why a fixed delay that suits one patient misses the next — which is exactly
what the cardiac-output knob demonstrates.

Verified: armed at 150 HU with a 3 s delay, triggered 13.5 s and fired 16.5 s; with a 2 s delay,
13.5 s -> 15.5 s. Threshold line and trigger dot draw on the plot. Re-arming on START, and
reset, both clear cleanly.

### 6.6 The bolus-tracked pair, and driving the injector from the console

Selecting bolus tracking as a group's scan delay now builds **two** groups, because that is what
the acquisition is: a monitoring series and the diagnostic series it triggers. The chosen group
becomes the monitor — one slice at its own centre, delay fixed at 0 s, since the delay is the
quantity being measured — and an enhanced group is inserted below it holding the planned range
and the trigger threshold. Both carry the same `cg`, so the plan renders them in one colour with
a `TRACK` badge on the monitor. Switching either half back to a fixed time delay dissolves the
pair and leaves one ordinary group holding the diagnostic range.

The injector transport is repeated on the tracking overlay. START TRACKING starts the injection
too, which is the realistic default — one operator does both — but the two clocks stay separate:
pressing the injector first and arming the series later leaves the gap visible and growing,
because the injector clock runs on its own 200 ms tick rather than on the 1.5 s monitoring
period. Verified: injector at 5.1 s with the tracking clock at 2.1 s after arming 3 s late.

The console's own entry keypad now overwrites rather than appends — the first digit replaces the
stored value, and the third key is a clear (`C`), not a backspace. Entering 65 into a field
showing 0 gives 65, not 065. Out-of-range entries are clamped on OK against the min/max printed
beside the field.

---

### 6.7 Test bolus, and making the monitoring plot actually live

**Test bolus is the other way to time a scan**, and it is now the fourth option in the Scan
Delay column. It plans as a pair exactly like tracking — a monitoring series plus the diagnostic
scan — but the two techniques answer different questions, so they behave differently:

| | bolus tracking | test bolus |
| --- | --- | --- |
| watches for | a threshold crossing | the peak |
| ends when | the ROI crosses the threshold (or you press SCANNING PHASE) | the set duration elapses |
| produces | an immediate trigger | a measured delay, written into the diagnostic group |
| then | the diagnostic scan runs straight on | the console stops and hands back to the operator |

That last row is the important one. A test bolus **cannot** roll into the diagnostic scan: that
scan needs the full injection, given fresh and timed from its own start, while the injector clock
is already tens of seconds into the small test dose. So the series measures the peak, writes it
into the diagnostic group's delay (`Test → 15 s` in the plan table), and stops with a hint
telling the operator to reset the injector and give the full dose.

What the test measures is the **transit time** from the arm to the vessel, which is what a fixed
delay is really trying to guess and is nearly independent of the injected volume for a given
flow rate. That is the clinical rationale for the technique, and it is why measuring on the
current timeline is a fair model of it even though the simulator gives one injection rather than
two.

**The monitoring plot now updates continuously.** It previously drew only when a sample landed,
so it sat frozen for the whole 1.5 s between measurements — and before the series was armed it
was not drawn at all, just an empty black box. Three fixes:

- the axes, grid and trigger level are drawn from the moment the window opens;
- a time cursor sweeps continuously, which is what tells the operator the series is still
  running when the curve is flat (which it is for the first ten seconds of every study);
- every sample is marked, so the sampling interval is legible rather than implied.

The redraw is on a **60 ms timer, not `requestAnimationFrame`**. rAF is tied to compositing, so
it is throttled to a crawl whenever the page is not being painted — an embedded pane, a
background tab — which is exactly the case where the graph looked frozen. Measured before the
fix: the canvas repainted only on the 1.5 s sample. After: a test bar drawn onto the canvas is
wiped within 150 ms and the cursor takes six distinct positions in two seconds.

**Dragging the ROI now re-measures immediately.** The HU readout only refreshed on the next
reconstruction, and during ROI placement there is no timer running at all — so moving the circle
onto a vessel showed the previous position's number until the series started. The reconstructed
slice is kept on the state and re-sampled on each drag: measured −551 HU on lung, 232 HU after
dragging onto the mediastinum, with no reconstruction in between.


### 6.8 CAP unblocked — the TotalSegmentator dataset as a source

§6.4 concluded that CAP needed a diagnostic chest-abdomen-pelvis CT, and §6.4's addendum showed
both whole-body subjects fail. The dataset behind TotalSegmentator (Zenodo 10047292, v2.0.1,
**CC BY 4.0**) is that source: 1228 studies, each shipping the reference segmentations of all
117 structures alongside the CT.

**Fetched without downloading 23.6 GB.** A zip keeps its index at the end and Zenodo honours
HTTP range requests, so `app/fetch_totalseg.py` reads the central directory over the wire
(147,361 members), pulls `meta.csv` to choose a subject, and then fetches only that subject's
byte ranges. **64 MB instead of 23.58 GB.**

**Subject s1379** — `ct angiography thorax-abdomen-pelvis`, 65 M, 100 kVp, 279x279x490 @ 1.5 mm
= 418x418x735 mm. Chosen because it is a **CTA**: the vessels are opacified, so the shipped
vessel labels are at their best. Every structure the model needs is present and plausible:

| | s1379 | z025 (rejected) |
| --- | --- | --- |
| aorta | 759 cm³ | 5.7 |
| inferior vena cava | 92 cm³ | absent |
| portal + splenic vein | 21 cm³ | absent |
| iliac arteries L/R | 34 / 44 cm³ | absent |
| iliac veins L/R | 37 / 30 cm³ | absent |
| liver / spleen / pancreas | 2180 / 289 / 103 cm³ | 68 / absent / absent |

Built at **2.0 mm** (the spacing decided in §6.4) to 209x165x356, with materials 29-46 all
present — every named vessel keeps its own id. The arclength pass maps 17 vessels: aorta
568 mm / 751 mL (thoracoabdominal, against the chest model's 339 mm / 379 mL thoracic-only),
IVC 227 mm, both iliac arteries 220 mm. **The pelvis is reachable for the first time.**

Two things the dataset does not give you:

- **No pulmonary artery.** The `total` task has none — it comes from the separate `lung_vessels`
  task, exactly as it did for the chest (§4.3). Without it the solver has no circulation at all,
  only disconnected pipes, and it used to fail several hundred lines later with a bare
  `AttributeError`. It now names the missing vessel and says where to get it.
- **Heart chambers** are still one label; that remains blocked on the academic licence (§4.3.1)
  and is unaffected by the new source.


Solved against the chest as a cross-check — two different patients, scanners and segmentations:

| | chest | CAP (s1379) |
| --- | --- | --- |
| pulmonary artery | 492 HU @ 26.0 s | 468 HU @ 26.0 s |
| aorta | 469 HU @ 33.0 s | 447 HU @ 31.0 s |
| IVC | 198 HU @ 47.0 s | 187 HU @ 50.0 s |

Identical PA timing and aortic timing within 2 s from unrelated geometry is a good sign that the
timing comes from the physiology rather than from either model's particular vessel lengths. A
preset timeline ships with the model (0.36 MB) so browser-only users get CAP contrast too.

**Known limitation, now visible: the portal vein and the IVC carry the same concentration.**
Both are fed from the lower-body pool — `ivc.step(body.c_iv)` and `portal.step(body.c_iv)` — so
they differ only by transport along their own lengths, which is why they report the same peak to
three figures above. Physiologically the portal vein drains the gut and spleen and its contrast
has crossed the splanchnic bed, which is the whole reason a portal-venous phase exists as a
distinct phase at ~60-70 s. The chest model barely shows the portal vein so this never mattered;
the CAP model is exactly where a portal-venous phase would be taught, so it does now. Fixing it
means giving the gut its own compartment with its own transit rather than sharing the lower-body
pool — a solver change, not a model one.

`build_vessels` warns that the right common carotid's seed band is collapsing a slab. That
vessel is clipped by the top of the FOV, so its inlet is a cut face rather than a true origin.
It does not matter for a CAP study but would for a carotid one.


---

## 7. Teaching notes

Things the architecture gives for free and should be surfaced deliberately:

- scanning too early (nothing opacified) or too late (venous) — the whole skill; a timeline
  scrubber against the chosen scan window makes the error legible
- low kVp boosting iodine — falls out of §3.1
- cardiac output changing timing — falls out of §2.4
- bolus chase on a fast helical — falls out of §3.3
