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

## Where to build next

- `app/engine.py` — port the polyenergetic Beer-Lambert ray-cast from
  `apps/web/src/core/engine.js` to NumPy (then CuPy/CUDA for GPU scale).
- `app/ct.py` — loop the projection over gantry angles + filtered back-projection.
- `app/convert.py` — invoke Blender headless to export glTF.
