# RadSim

A physics-based medical-imaging simulator for radiography training. Every image is computed,
not looked up: rays are traced from the focal spot through voxel patients built from real CT
scans, attenuated with polyenergetic Beer–Lambert physics, and recorded by a modelled detector
with its own noise, scatter and exposure index.

Runs entirely in the browser. There is no public deployment: run it locally (below).

## Modes

| Mode | What it does |
|---|---|
| **X-ray** | Position the patient and tube in a 3D room, pick a protocol (40 projections, each with a pose, centring landmark and calibrated technique), expose, read EI/DI. Grid, AEC chambers, scatter, collimation, magnification. |
| **CT** | Scout, plan scan groups, reconstruct (filtered back-projection) with beam hardening, cone beam and quantum noise; contrast timing, bolus tracking, dose (CTDIvol, DLP), HU ROI, MPR. |
| **Fluoroscopy** | A C-arm with live pulsed screening, ABC, FILM/SAVE, DSA and roadmap, barium and contrast studies, dose and DAP. Floating monitors; drag the image to float the table. |
| **Mammography** | CC/MLO views of voxel breasts, compression, target/filter, AEC and average glandular dose (Dance method), QC phantom. |
| **Ultrasound** | B-mode and M-mode from the same patients, TGC, focus, colour Doppler, exam presets, depth scale and calipers. |
| **Bone densitometry (DXA)** | Two-energy scans of the lumbar spine and hip, automatic L1–L4 and femoral regions, T/Z-scores and a report. |
| **Model editor** | Paint voxel models slice by slice, or start from any patient, with a live 3D render; save and load them as files. |

Each mode has a guided tutorial (▶ Tutorial on the home screen).

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (node --test, no dependencies)
npm run build      # production build -> apps/web/dist (checks the material legends first)
```

Every pull request runs the tests (`.github/workflows/test.yml`). Nothing is deployed: the
GitHub Pages site was taken down in November 2026.

The optional **Python compute backend** (`services/compute`, FastAPI) adds a GPU projection
engine and the tools that build the voxel models from CT. The web app does not need it. See
[`services/compute/README.md`](services/compute/README.md).

## Layout

```
apps/web/                 Vite + Three.js app
  src/core/               physics: spectra, materials, attenuation, detector, voxel phantoms,
                          dose, scatter, technique, limb posing, fluoro display ...
  src/{app,ct,fluoro,mammo,ultrasound,dxa,editor}.js     the modes
  src/data/               protocols.json (technique chart), landmarks.json (centring), LUTs
  public/models/          voxel patients (<name>.mat.bin + .model.json + display mesh)
  test/                   unit tests
services/compute/         FastAPI backend and the model builders (build_model.py, build_highres.py)
tools/                    measuring scripts (e.g. measure_landmarks.py)
docs/                     design notes per modality, and DEVLOG.md (what shipped, newest first)
```

## The patients

Voxel models are built from public CT data — mainly the TotalSegmentator dataset (Wasserthal
et al., Zenodo 10047292, CC BY 4.0) — segmented into material labels, with bone kept either as
trabecular/cortical classes or, for the 1 mm lumbar spine and pelvis, as eight density grades.
Landmarks used for centring are measured from each model's own bone
(`tools/measure_landmarks.py`).

## Notes

Teaching approximations, not a clinical device: techniques, doses and exposure indices are
calibrated to the simulator's own patients and documented where they are set.
`docs/DEVLOG.md` records what changed, why, and how it was checked.
