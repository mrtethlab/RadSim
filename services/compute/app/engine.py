"""Projection engine (Python / NumPy).

This mirrors the contract of the browser engine at
`apps/web/src/core/engine.js` (polyenergetic Beer-Lambert ray-cast from the focal
spot through the phantom to the detector, with inverse-square dose). Porting that
math here with NumPy — and optionally CuPy/CUDA — is what gives RadSim the
"increased computation power" needed for high-resolution projections and CT.

Foundation scope: a working stub that accepts the request and returns metadata +
a (currently empty) dose map summary, so the frontend integration and streaming
protocol can be exercised end-to-end before the heavy math lands.
"""
from __future__ import annotations

from typing import Any, AsyncIterator

import numpy as np


def project(params: dict[str, Any]) -> dict:
    nx = int(params.get("nx", 320))
    ny = int(params.get("ny", 400))

    # TODO: port the ray-cast + polyenergetic integration from engine.js.
    #   - build the phantom (analytic primitives or an imported/voxelised model)
    #   - for each detector cell: trace source->cell, accumulate mu*path per bin
    #   - dose = I0 * inverse_square * sum_bins(w * exp(-sum mu*path))
    # NumPy vectorises the per-cell loop; CuPy drops in for GPU scale.
    dose = np.zeros((ny, nx), dtype=np.float32)

    return {
        "nx": nx,
        "ny": ny,
        "backend": "python-numpy",
        "implemented": False,
        "note": "stub projection — port engine.js here for GPU-scale compute",
        "dose_sum": float(dose.sum()),
    }


async def project_streamed(params: dict[str, Any]) -> AsyncIterator[dict]:
    """Yield progress updates (0..1) then a final result — matches the WS client."""
    ny = int(params.get("ny", 400))
    step = max(1, ny // 20)
    for j in range(0, ny, step):
        yield {"progress": round(j / ny, 3)}
    yield {"progress": 1.0, "done": True, "result": project(params)}
