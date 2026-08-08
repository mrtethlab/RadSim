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


def rot_tensor(rot):
    """Build a 3x3 rotation tensor from a flat row-major 9-list, or None if absent/identity."""
    if not rot:
        return None
    ident = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    if all(abs(a - b) < 1e-9 for a, b in zip(rot, ident)):
        return None
    return torch.tensor(rot, dtype=torch.float32, device=DEVICE).reshape(3, 3)


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


def mat_columns(vv: "VoxelVolume", mu):
    """Columns for a path-length matrix, and a mu table guaranteed to match them.

    The volume's legend and the browser's mu table can disagree. Models built before Lead
    and Acrylic joined the legend carry 28 entries; the browser always sends 29, because
    its material table is the current one. Sizing the path matrix from the header then made
    (rays, 28) @ (29, bins) fail outright — CT scout 500'd for every older model.

    Take the wider of the two and pad mu if it is the shorter. A legend that is short just
    leaves unused columns, and they contribute nothing: no voxel carries those ids, so their
    path length stays zero. A model with MORE materials than the browser knows about gets
    zero attenuation for the extra ones, which is the safe direction to be wrong in.
    """
    n = max(vv.nmat, mu.shape[0])
    if mu.shape[0] < n:
        mu = torch.cat([mu, torch.zeros(n - mu.shape[0], mu.shape[1],
                                        dtype=mu.dtype, device=mu.device)], dim=0)
    return n, mu


_cache: dict[tuple, VoxelVolume] = {}


def get_volume(name: str, flips) -> VoxelVolume:
    key = (name, tuple(bool(f) for f in flips))
    if key not in _cache:
        _cache[key] = VoxelVolume(name, key[1])
    return _cache[key]


def sample_ids(vv: VoxelVolume, pts: torch.Tensor, center, rot=None) -> torch.Tensor:
    """Nearest-voxel material id at world points (..., 3). Outside the volume -> 0 (air).
    rot (3x3 tensor, the volume's world rotation) inverse-rotates the points into the
    volume's local frame about `center`, so a rotated object is sampled correctly."""
    nx, ny, nz = vv.dims
    if rot is not None:
        c = torch.tensor(center, device=pts.device, dtype=pts.dtype)
        pts = (pts - c) @ rot + c        # local = (world - c) @ R + c  ==  R^T (world - c) + c
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
