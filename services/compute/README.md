# RadSim compute backend

FastAPI service that offloads heavy computation from the browser: high-resolution
ray-casting projections, CT acquisition + reconstruction (future), and
`.blend → .glb` model conversion (future). The web app (`apps/web`) talks to it
over HTTP/WebSocket. It is **optional** — the app runs fully on the JS engine
without it; the backend is the path to more compute power (NumPy / GPU) and CT.

## Run

```bash
cd services/compute
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
# source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Then the "Model ●" dot in the web app's positioning bay lights up when the
backend is reachable (it pings `GET /health`).

## Endpoints

| Method | Path                       | Status        | Purpose                                              |
| ------ | -------------------------- | ------------- | ---------------------------------------------------- |
| GET    | `/health`                  | ✅ working     | Liveness + capability flags                          |
| POST   | `/project`                 | 🚧 stub        | One projection (contract mirrors `core/engine.js`)   |
| WS     | `/project/stream`          | 🚧 stub        | Progress stream for long/high-res jobs               |
| POST   | `/ct`                      | 🚧 planned     | CT acquisition + reconstruction                      |
| POST   | `/convert/blend-to-glb`    | 🚧 needs Blender | Convert uploaded `.blend` → `.glb`                 |

## Sub-mm models (backend only)

Two models are too large to commit or to serve over the web, so only their
`.model.json` is in the repo — they appear in the Subject picker but need this backend
running plus a local rebuild of the volume. Selecting one forces the Python GPU engine
and disables the browser engine, since there is no volume in the browser to ray-cast.

| Model            | Grid                  | Volume | Rebuild                            |
| ---------------- | --------------------- | ------ | ---------------------------------- |
| `hand_hires`     | 0.2 mm                | ~316 MB | see below                         |
| `hires_shoulder` | 619×606×679 @ 0.25 mm | 254 MB | `app.build_model` on the source CT |

```bash
./.venv/Scripts/python.exe -m app.build_hand \
    --glb data/hand/hand_bones.glb \
    --out ../../apps/web/public/models/hand_hires --name hand_hires \
    --title "Hand · 0.2 mm" --spacing 0.2 --no-mesh --backend-only \
    --mesh-from ../../apps/web/public/models/hand/hand.glb
```

The trabecular morphometry driving both builds was measured with `app.trab_morphometry`
from a 20 µm micro-CT capitate in the KU Leuven *Multimodal CT Dataset of Cadaveric Wrist
Joints* ([doi:10.48804/DWF4RG](https://rdr.kuleuven.be/dataset.xhtml?persistentId=doi%3A10.48804%2FDWF4RG),
CC BY-SA 4.0, specimen 6 — 88-year-old female, so the bone is on the sparse side of
young-adult reference). Only the numbers are used; no voxel of that scan is copied into
the model, which keeps the shipped texture our own rather than a share-alike derivative
that could not be combined with this hand's CC BY-NC-SA source scan.

0.2 mm is not an arbitrary choice: it is the coarsest grid that can carry the measured
trabecular lattice. `app.trab_morphometry` puts the repeat distance at Tb.Th + Tb.Sp =
0.96 mm at BV/TV 0.31, and a binary field at fill p cannot have a period shorter than
1/(1-p) + 1/p = 4.7 voxels however it is filtered — so anything coarser than 0.96/4.7 =
0.206 mm reproduces the right bone density with a texture that is too coarse. The 0.5 mm
default is 2.4x too coarse and says so when it builds.

Needs ~20 GB of RAM and a few minutes. The display mesh is copied from the 0.5 mm hand
rather than rebuilt: it is the same hand, and the mesh only ever aims the tube.

## Where to build next

- `app/engine.py` — port the polyenergetic Beer-Lambert ray-cast from
  `apps/web/src/core/engine.js` to NumPy (then CuPy/CUDA for GPU scale).
- `app/ct.py` — loop the projection over gantry angles + filtered back-projection.
- `app/convert.py` — invoke Blender headless to export glTF.
