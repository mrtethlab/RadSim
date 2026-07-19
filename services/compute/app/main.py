"""RadSim compute backend (FastAPI).

Offloads heavy computation from the browser: high-resolution ray-casting
projections, CT acquisition + reconstruction (future), and .blend -> .glb model
conversion (future). The web app (apps/web) calls this over HTTP/WebSocket.

Run:
    cd services/compute
    python -m venv .venv && . .venv/Scripts/activate   # (Windows: .venv\\Scripts\\activate)
    pip install -r requirements.txt
    uvicorn app.main:app --reload --port 8000
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import convert, ct, engine

app = FastAPI(title="RadSim Compute", version="0.1.0")

# Dev CORS: allow the Vite dev server (and anything else, locally). Tighten for prod.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "radsim-compute",
        "version": app.version,
        "capabilities": {
            "project": True,
            "ct": False,  # planned
            "blend_to_glb": convert.blender_available(),
        },
    }


class ProjectRequest(BaseModel):
    # Technique
    kv: float = 60.0
    mas: float = 2.0
    ma: float = 200.0
    # Detector matrix
    nx: int = 320
    ny: int = 400
    # Phantom + geometry payloads (shape mirrors the JS engine; kept generic for now)
    phantom: Optional[dict[str, Any]] = None
    geometry: Optional[dict[str, Any]] = None


@app.post("/project")
def project(req: ProjectRequest) -> dict:
    """Compute one projection. Same contract as apps/web/src/core/engine.js."""
    return engine.project(req.model_dump())


@app.websocket("/project/stream")
async def project_stream(ws: WebSocket) -> None:
    """Stream projection progress for long/high-res jobs."""
    await ws.accept()
    try:
        params = await ws.receive_json()
        async for update in engine.project_streamed(params):
            await ws.send_json(update)
    except WebSocketDisconnect:
        return


@app.post("/ct")
def ct_scan(req: dict) -> dict:
    """CT acquisition + reconstruction (planned)."""
    return ct.reconstruct(req)


@app.post("/convert/blend-to-glb")
async def blend_to_glb(file: UploadFile = File(...)):
    """Convert an uploaded .blend to .glb (requires Blender on PATH)."""
    return await convert.blend_to_glb(file)
