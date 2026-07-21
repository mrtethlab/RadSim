"""GPU projection engine (PyTorch / CUDA, CPU fallback).

Mirrors the contract of the browser engine (apps/web/src/core/engine.js) for VOXEL
phantoms: for every detector cell, march the source->cell ray through the labelled
volume, accumulate per-material path length, integrate the polyenergetic
Beer-Lambert law over the spectrum bins the browser sent, and apply inverse-square
dose. Rays outside the collimated cone are skipped entirely (the browser masks the
same cells with the identical tube-frame test).

The analytic hand stays in the browser — it is light; the voxel body is the case
that needs the GPU.
"""
from __future__ import annotations

from typing import Any

import numpy as np
import torch

from .gpu import DEVICE, get_volume, sample_ids, rot_tensor

STEP = 0.05          # ray-march step, world units (= 0.5 mm; voxels are ~1 mm)
CHUNK = 1 << 14      # rays per batch (memory: CHUNK x nsteps indices)


@torch.no_grad()
def project_voxel(p: dict[str, Any]) -> np.ndarray:
    vv = get_volume(p["model"], p["flips"])
    center = p["center"]
    nx, ny = int(p["nx"]), int(p["ny"])
    pxU, pxV = float(p["pxU"]), float(p["pxV"])
    rot = rot_tensor(p.get("rot"))
    src = torch.tensor(p["source"], dtype=torch.float32, device=DEVICE)
    detC = torch.tensor(p["detCenter"], dtype=torch.float32, device=DEVICE)
    detU = torch.tensor(p["detU"], dtype=torch.float32, device=DEVICE)
    detV = torch.tensor(p["detV"], dtype=torch.float32, device=DEVICE)
    w = torch.tensor(p["binsW"], dtype=torch.float32, device=DEVICE)          # (nb,)
    mu = torch.tensor(p["muMat"], dtype=torch.float32, device=DEVICE)         # (nmat, nb)
    mu[0].zero_()                                                             # air contributes nothing
    I0, refDist = float(p["I0"]), float(p["refDist"])

    # collimation (same tube-frame test as the browser's mask)
    fd = torch.tensor(p["coneD"], dtype=torch.float32, device=DEVICE)
    wAxis = torch.tensor(p["coneW"], dtype=torch.float32, device=DEVICE)
    lAxis = torch.tensor(p["coneL"], dtype=torch.float32, device=DEVICE)
    tw, tl = float(p["coneTw"]), float(p["coneTl"])

    # detector cell centres (world)
    iu = (torch.arange(nx, device=DEVICE, dtype=torch.float32) - (nx - 1) / 2) * pxU
    jv = (torch.arange(ny, device=DEVICE, dtype=torch.float32) - (ny - 1) / 2) * pxV
    cu, cv = torch.meshgrid(jv, iu, indexing="ij")                            # (ny, nx) row-major
    cells = detC + cu.reshape(-1, 1) * detV + cv.reshape(-1, 1) * detU        # (R, 3)

    rel = cells - src
    dv = rel @ fd
    inside = (dv > 0) & ((rel @ wAxis).abs() <= tw * dv) & ((rel @ lAxis).abs() <= tl * dv)

    dose = torch.zeros(nx * ny, dtype=torch.float32, device=DEVICE)
    idxs = torch.nonzero(inside, as_tuple=False).squeeze(1)

    # volume AABB for ray clipping
    mn = torch.tensor([center[k] - vv.extent[k] / 2 for k in range(3)], device=DEVICE)
    mx = torch.tensor([center[k] + vv.extent[k] / 2 for k in range(3)], device=DEVICE)

    for s in range(0, idxs.numel(), CHUNK):
        sel = idxs[s:s + CHUNK]
        c = cells[sel]                                     # (R,3)
        d = c - src
        dist = d.norm(dim=1, keepdim=True)
        dir_ = d / dist
        # slab-clip [t0, t1] against the volume AABB
        invd = torch.where(dir_.abs() < 1e-12, torch.full_like(dir_, 1e12), 1.0 / dir_)
        ta = (mn - src) * invd
        tb = (mx - src) * invd
        t0 = torch.minimum(ta, tb).amax(dim=1).clamp(min=0.0)
        t1 = torch.maximum(ta, tb).amin(dim=1)
        t1 = torch.minimum(t1, dist.squeeze(1))
        span = (t1 - t0).clamp(min=0.0)
        nsteps = int(torch.ceil(span.max() / STEP).item()) if span.max() > 0 else 0
        T = torch.ones(sel.numel(), dtype=torch.float32, device=DEVICE)
        if nsteps > 0:
            ts = t0.unsqueeze(1) + (torch.arange(nsteps, device=DEVICE, dtype=torch.float32)
                                    .unsqueeze(0) + 0.5) * STEP               # (R, S)
            valid = ts < t1.unsqueeze(1)
            pts = src + dir_.unsqueeze(1) * ts.unsqueeze(2)                   # (R, S, 3)
            ids = sample_ids(vv, pts, center, rot)                            # (R, S)
            ids = torch.where(valid, ids, torch.zeros_like(ids))
            L = torch.zeros(sel.numel(), vv.nmat, dtype=torch.float32, device=DEVICE)
            L.scatter_add_(1, ids, torch.full_like(ts, STEP) * valid)         # path length per material
            E = L @ mu                                                        # (R, nb)
            T = torch.exp(-E) @ w                                             # polyenergetic transmission
        dose[sel] = I0 * (refDist * refDist) / (dist.squeeze(1) ** 2) * T
    return dose.reshape(ny, nx).cpu().numpy()


# ---- legacy stub API (kept for the JSON /project route contract check) ----
def project(params: dict[str, Any]) -> dict:
    return {"implemented": True, "backend": f"torch-{DEVICE.type}",
            "note": "use POST /project/voxel (binary) for real projections"}
