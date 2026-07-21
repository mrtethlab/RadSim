"""RadSim compute backend (FastAPI).

Offloads the heavy geometry/integration from the browser to the GPU (PyTorch /
CUDA on an available NVIDIA card, CPU otherwise):

  POST /project/voxel  x-ray projection of a voxel phantom at the full native
                       detector matrix -> raw float32 dose map (ny x nx)
  POST /ct/slices      parallel-beam FBP of transverse slices -> raw float32
                       volume (nz x N x N)

The browser remains the single source of truth for the PHYSICS (spectrum shape,
per-material attenuation tables) and sends those tables with each request; this
service only integrates them over rays. Run:

    cd services/compute
    .venv\\Scripts\\activate        (Windows)
    uvicorn app.main:app --port 8000
"""
from __future__ import annotations

from typing import Any, Optional

import numpy as np
from fastapi import FastAPI, File, Response, UploadFile
from pydantic import BaseModel

from . import convert, ct, engine, gpu

app = FastAPI(title="RadSim Compute", version="0.2.0")

from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Shape"],
)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "radsim-compute",
        "version": app.version,
        "compute": gpu.device_info(),
        "capabilities": {
            "project_voxel": True,
            "ct_slices": True,
            "blend_to_glb": convert.blender_available(),
        },
    }


def _f32_response(arr: np.ndarray) -> Response:
    return Response(
        content=np.ascontiguousarray(arr, dtype=np.float32).tobytes(),
        media_type="application/octet-stream",
        headers={"X-Shape": "x".join(str(s) for s in arr.shape)},
    )


class VoxelProjectRequest(BaseModel):
    model: str
    flips: list[bool]
    center: list[float]
    source: list[float]
    detCenter: list[float]
    detU: list[float]
    detV: list[float]
    nx: int
    ny: int
    pxU: float
    pxV: float
    binsW: list[float]
    muMat: list[list[float]]      # (nmat, nbins)
    I0: float
    refDist: float
    coneD: list[float]            # collimation: central-ray dir + width/length axes + tangents
    coneW: list[float]
    coneL: list[float]
    coneTw: float
    coneTl: float
    rot: list[float] | None = None


@app.post("/project/voxel")
def project_voxel(req: VoxelProjectRequest) -> Response:
    return _f32_response(engine.project_voxel(req.model_dump()))


class CTSlicesRequest(BaseModel):
    model: str
    flips: list[bool]
    center: list[float]
    z0List: list[float]
    cx: float
    cy: float
    nDet: int
    nAngles: int
    gridN: int
    ds: float
    rayR: float
    dfovR: float
    muArr: list[float]
    photons0: float
    rot: list[float] | None = None
    kernel: str = "ramlak"      # 'ramlak' (quick preview) | 'shepp' (realistic detector)


@app.post("/ct/slices")
def ct_slices(req: CTSlicesRequest) -> Response:
    return _f32_response(ct.recon_slices(req.model_dump()))


class CTScoutRequest(BaseModel):
    model: str
    flips: list[bool]
    center: list[float]
    nw: int
    nz: int
    pxU: float
    lenU: float
    sx: float
    sy: float
    dcx: float
    dcy: float
    ux: float
    uy: float
    binsW: list[float]
    muMat: list[list[float]]
    I0: float
    rot: list[float] | None = None


@app.post("/ct/scout")
def ct_scout(req: CTScoutRequest) -> Response:
    return _f32_response(ct.scout(req.model_dump()))


# ---- legacy JSON stubs (kept so old clients keep getting a sane answer) ----
class ProjectRequest(BaseModel):
    kv: float = 60.0
    mas: float = 2.0
    ma: float = 200.0
    nx: int = 320
    ny: int = 400
    phantom: Optional[dict[str, Any]] = None
    geometry: Optional[dict[str, Any]] = None


@app.post("/project")
def project(req: ProjectRequest) -> dict:
    return engine.project(req.model_dump())


@app.post("/ct")
def ct_scan(req: dict) -> dict:
    return ct.reconstruct(req)


@app.post("/convert/blend-to-glb")
async def blend_to_glb(file: UploadFile = File(...)):
    return await convert.blend_to_glb(file)
