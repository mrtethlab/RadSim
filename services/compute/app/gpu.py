"""Shared GPU state for the RadSim compute backend.

Device selection (CUDA if available), and a cache of voxel phantom volumes loaded
from the web app's model folder (apps/web/public/models/<name>/). The volume is a
uint8 material-id grid, x-fastest; anatomical flips are baked in at load so lookups
stay a plain gather.

The PHYSICS (spectrum, per-material mu tables) is NOT duplicated here — the browser
computes them with its own single-source-of-truth tables (materials.js/spectrum.js)
and sends them with each request. This backend only does geometry + integration.
"""
from __future__ import annotations

import json
from pathlib import Path

import torch

# repo root: services/compute/app/gpu.py -> app -> compute -> services -> root
_ROOT = Path(__file__).resolve().parents[3]
MODELS_DIR = _ROOT / "apps" / "web" / "public" / "models"

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


def device_info() -> dict:
    if DEVICE.type == "cuda":
        p = torch.cuda.get_device_properties(0)
        return {"device": "cuda", "name": p.name,
                "vram_gb": round(p.total_memory / 2**30, 1),
                "torch": torch.__version__}
    return {"device": "cpu", "name": "cpu", "torch": torch.__version__}


class VoxelVolume:
    """A loaded voxel model on the compute device (world units = cm, 1 u = 10 mm)."""

    def __init__(self, name: str, flips: tuple[bool, bool, bool]):
        hdr = json.loads((MODELS_DIR / name / f"{name}.model.json").read_text())
        nx, ny, nz = hdr["dims"]
        raw = (MODELS_DIR / name / hdr["volume"]).read_bytes()
        vol = torch.frombuffer(bytearray(raw), dtype=torch.uint8).reshape(nz, ny, nx)
        # bake the anatomical flips (mirrors VoxelPhantom.idAt's index flips)
        dims = [i for i, f in enumerate(reversed(flips)) if f]  # tensor dims are (z,y,x)
        if dims:
            vol = torch.flip(vol, dims=dims)
        self.vol = vol.contiguous().to(DEVICE)
        self.dims = (nx, ny, nz)
        self.vs = tuple(s / 10.0 for s in hdr["spacing"])       # cm per voxel
        self.extent = tuple(n * s for n, s in zip(self.dims, self.vs))
        self.nmat = len(hdr["materials"])


_cache: dict[tuple, VoxelVolume] = {}


def get_volume(name: str, flips) -> VoxelVolume:
    key = (name, tuple(bool(f) for f in flips))
    if key not in _cache:
        _cache[key] = VoxelVolume(name, key[1])
    return _cache[key]


def sample_ids(vv: VoxelVolume, pts: torch.Tensor, center) -> torch.Tensor:
    """Nearest-voxel material id at world points (..., 3). Outside the volume -> 0 (air)."""
    nx, ny, nz = vv.dims
    mn = torch.tensor([center[0] - vv.extent[0] / 2,
                       center[1] - vv.extent[1] / 2,
                       center[2] - vv.extent[2] / 2], device=pts.device)
    vs = torch.tensor(vv.vs, device=pts.device)
    idx = torch.floor((pts - mn) / vs).long()
    ix, iy, iz = idx[..., 0], idx[..., 1], idx[..., 2]
    inside = (ix >= 0) & (ix < nx) & (iy >= 0) & (iy < ny) & (iz >= 0) & (iz < nz)
    ix = ix.clamp(0, nx - 1); iy = iy.clamp(0, ny - 1); iz = iz.clamp(0, nz - 1)
    ids = vv.vol[iz, iy, ix]
    return torch.where(inside, ids, torch.zeros_like(ids)).long()
