"""GPU CT reconstruction (PyTorch / CUDA, CPU fallback).

Parallel-beam FBP of transverse slices through a voxel phantom, mirroring the
browser implementation in apps/web/src/ct.js (projectSlice -> Ram-Lak filter ->
backproject), so the two engines produce interchangeable results:

  - sinogram of line integrals of mu at the beam's effective energy (the browser
    sends the per-material mu LUT), quantum noise from finite detected photons
  - discrete Ram-Lak convolution (same kernel), scaled by the channel spacing
  - bilinear back-projection onto an N x N grid over the display FOV, x pi/nAngles

Geometry supports both detector modes:
  - quick:     channels span the display FOV (ds = dfov/nDet), ray length = dfov
  - realistic: channels span the full scan FOV at a fixed physical pitch; the
    display FOV only selects the back-projected region (no projection truncation)
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
import torch

from .gpu import DEVICE, get_volume, sample_ids, rot_tensor

STEP = 0.05          # in-plane march step, world units (0.5 mm)
FWD_BATCH = 16       # forward-projection angle batching ((a,K,S,3) points tensor)
ANGLE_BATCH = 72     # backprojection angle batching (memory)
SAT_P = 11.5           # detector saturation: max measurable line integral (mirrors ct.js)
APERTURE_SIGMA = 1.0   # radial (channel) aperture in channels (mirrors ct.js)
AZIMUTH_SIGMA = 1.6    # azimuthal (view) aperture in views (mirrors ct.js) — feathers streaks


def _gauss1d(sigma: float, device) -> tuple[torch.Tensor, int]:
    rad = max(1, math.ceil(3 * sigma))
    n = torch.arange(-rad, rad + 1, device=device, dtype=torch.float32)
    w = torch.exp(-(n * n) / (2 * sigma * sigma))
    return (w / w.sum()).view(1, 1, -1), rad


def _sino_blur(sino: torch.Tensor) -> torch.Tensor:
    """Band-limit the sinogram from the finite source + detector apertures (mirrors sinoBlur in
    ct.js). Our recon rays are infinitely thin, so metal edges are razor-sharp and the ramp
    filter amplifies them to Nyquist, giving a rigid streak crosshatch real scanners don't show.
    Two apertures restore the physical band limit:
      • RADIAL (channel axis) — finite detector element + in-plane focal spot; softens streaks.
      • AZIMUTHAL (view axis)  — the tube fires while the gantry rotates, so each view integrates
        over a small rotation increment (plus azimuthal focal-spot extent), smearing each streak
        across a range of angles → sharp backprojected lines become soft fans = the feathery,
        pointed 'sun-ray' streaks of real metal artifacts.
    Both are low-frequency-preserving, so the broad inter-metal dark bands and overall resolution
    are unaffected. sino is (n_ang, n_det)."""
    if APERTURE_SIGMA > 0:                                                     # channel axis
        w, rad = _gauss1d(APERTURE_SIGMA, sino.device)
        x = torch.nn.functional.pad(sino.unsqueeze(1), (rad, rad), mode="replicate")
        sino = torch.nn.functional.conv1d(x, w).squeeze(1)
    if AZIMUTH_SIGMA > 0:                                                      # view axis
        w, rad = _gauss1d(AZIMUTH_SIGMA, sino.device)
        x = torch.nn.functional.pad(sino.t().unsqueeze(1), (rad, rad), mode="replicate")
        sino = torch.nn.functional.conv1d(x, w).squeeze(1).t()
    return sino


def _kernel(n_det: int, ds: float, kind: str, device) -> torch.Tensor:
    """Discrete recon kernel: 'ramlak' (pure ramp) or 'shepp' (Shepp-Logan, apodized).
    Mirrors buildKernel in apps/web/src/ct.js exactly."""
    n = torch.arange(-(n_det - 1), n_det, device=device, dtype=torch.float32)
    if kind == "shepp":
        return -2.0 / (math.pi ** 2 * ds * ds * (4 * n * n - 1))
    h = torch.zeros_like(n)
    h[n_det - 1] = 1.0 / (4 * ds * ds)
    odd = (n.long() % 2) != 0
    h[odd] = -1.0 / (math.pi ** 2 * n[odd] ** 2 * ds * ds)
    return h


def _build_bhc(binW, muWbins, muWeff, Lmax=60.0, n=320):
    """Water beam-hardening correction LUT: C(p_poly) → p_mono for a water path. Linearises
    soft tissue; bone/metal (different spectral response) stay mis-corrected → artifacts."""
    L = torch.linspace(0.0, Lmax, n, device=DEVICE)
    T = (binW[None, :] * torch.exp(-muWbins[None, :] * L[:, None])).sum(dim=1)   # (n,)
    xs = -torch.log(T.clamp(min=1e-30))
    ys = muWeff * L
    slope = ((ys[-1] - ys[-2]) / (xs[-1] - xs[-2]).clamp(min=1e-9))
    return xs, ys, slope


def _apply_bhc(pv, xs, ys, slope):
    shp = pv.shape
    f = pv.flatten()
    idx = torch.searchsorted(xs, f).clamp(1, xs.shape[0] - 1)
    x0, x1 = xs[idx - 1], xs[idx]
    y0, y1 = ys[idx - 1], ys[idx]
    t = (f - x0) / (x1 - x0).clamp(min=1e-9)
    out = y0 + t * (y1 - y0)
    out = torch.where(f >= xs[-1], ys[-1] + slope * (f - xs[-1]), out)          # extrapolate (bone/metal)
    out = torch.where(f <= xs[0], f.clamp(min=0.0), out)
    return out.reshape(shp)


@torch.no_grad()
def recon_slices(p: dict[str, Any]) -> np.ndarray:
    vv = get_volume(p["model"], p["flips"])
    center = p["center"]
    cx, cy = float(p["cx"]), float(p["cy"])            # recon centre (world)
    n_det = int(p["nDet"]); n_ang = int(p["nAngles"]); N = int(p["gridN"])
    ds = float(p["ds"])                                # channel spacing (world units)
    ray_r = float(p["rayR"])                           # ray half-length (covers the object)
    dfov_r = float(p["dfovR"])                         # display-FOV radius (backprojected region)
    mu = torch.tensor(p["muArr"], dtype=torch.float32, device=DEVICE)
    mu[0] = 0.0                                        # air
    photons0 = float(p["photons0"])
    # polyenergetic beam-hardening path (voxel models): integrate transmission over the
    # spectrum so beam hardening emerges (dark bands between dense/metal objects), then
    # apply the water beam-hardening correction. Mirrors the browser projectSlice.
    poly = p.get("binsW") is not None
    if poly:
        binW = torch.tensor(p["binsW"], dtype=torch.float32, device=DEVICE)          # (nb,)
        muMat = torch.tensor(p["muMat"], dtype=torch.float32, device=DEVICE)          # (nmat, nb)
        muMat[0] = 0.0
        bhc_x, bhc_y, bhc_slope = _build_bhc(binW,
            torch.tensor(p["muWbins"], dtype=torch.float32, device=DEVICE), float(p["muWeff"]))
    z0_list = [float(z) for z in p["z0List"]]
    # cone rays: (k, dz, weight) — k = z-slope (cone tilt → cross-slice bleed), dz = z-offset
    # (across the reconstructed slice thickness → partial volume). Mirrors ct.js coneProfile.
    cone_rays = [(float(k), float(dz), float(w)) for k, dz, w in (p.get("coneRays") or [[0.0, 0.0, 1.0]])]
    focal_blur = bool(p.get("focalBlur", True))        # detector/focal-spot blur (feathery streaks) toggle
    rot = rot_tensor(p.get("rot"))

    half_det = (n_det - 1) / 2.0
    th = torch.arange(n_ang, device=DEVICE, dtype=torch.float32) * math.pi / n_ang
    ct, st = torch.cos(th), torch.sin(th)              # (A,)
    r = (torch.arange(n_det, device=DEVICE, dtype=torch.float32) - half_det) * ds  # (K,)

    # ray origins/directions per (angle, channel): o = c + r*e_r + rayR*e_t, d = -e_t
    ox = cx + r.unsqueeze(0) * ct.unsqueeze(1) + ray_r * st.unsqueeze(1)      # (A, K)
    oy = cy + r.unsqueeze(0) * st.unsqueeze(1) - ray_r * ct.unsqueeze(1)
    dx = -st.unsqueeze(1).expand(-1, n_det)
    dy = ct.unsqueeze(1).expand(-1, n_det)

    nsteps = int(math.ceil(2 * ray_r / STEP))
    ts = (torch.arange(nsteps, device=DEVICE, dtype=torch.float32) + 0.5) * STEP  # (S,)

    h = _kernel(n_det, ds, p.get("kernel", "ramlak"), DEVICE).flip(0).reshape(1, 1, -1)

    # backprojection grid over the DISPLAY FOV
    px = (-dfov_r + (torch.arange(N, device=DEVICE, dtype=torch.float32) + 0.5) * (2 * dfov_r / N))
    wy, wx = torch.meshgrid(px, px, indexing="ij")             # (N, N); wy rows = iy
    # reconstruct the FULL display-FOV square (the framed box), clipping only at the SFOV radius
    # where the rays run out of data — so anatomy in the box corners isn't clipped (mirrors ct.js).
    in_fov = (wx * wx + wy * wy) <= ray_r * ray_r

    out = np.empty((len(z0_list), N, N), dtype=np.float32)
    for zi, z0 in enumerate(z0_list):
        # ---- forward project: march the cone's z-divergent rays through the slice ----
        # points (A, K, S, 2) is too big in one go for realistic mode; batch angles.
        # The detector sums photons over its z-rows, so we integrate TRANSMISSION over the cone
        # rays (Tcone = Σ w·exp(-∫μ)) before -ln. Each ray tilts in z by slope k, centred on z0 at
        # isocentre (ts = ray_r), so it sweeps off-plane material near the periphery → cross-slice
        # metal bleed. Averaging pre-log makes a sliver of metal darken the ray. Mirrors ct.js.
        sino = torch.empty(n_ang, n_det, dtype=torch.float32, device=DEVICE)
        for a0 in range(0, n_ang, FWD_BATCH):
            a1 = min(n_ang, a0 + FWD_BATCH)
            pxr = ox[a0:a1].unsqueeze(2) + dx[a0:a1].unsqueeze(2) * ts        # (a, K, S)
            pyr = oy[a0:a1].unsqueeze(2) + dy[a0:a1].unsqueeze(2) * ts
            Tcone = torch.zeros(a1 - a0, n_det, device=DEVICE)                # cone-integrated transmission
            for kz, dz, wz in cone_rays:
                zt = (z0 + dz + kz * (ts - ray_r)).view(1, 1, -1).expand_as(pxr)  # slice-thickness offset + cone tilt
                pts = torch.stack([pxr, pyr, zt], dim=-1)                     # (a, K, S, 3)
                ids = sample_ids(vv, pts, center, rot)
                if poly:
                    # transmission over spectral bins (loop over bins to keep the per-material
                    # (a,K,S) tensor small); T = Σ w_b · exp(-∫μ_b dl)
                    T = torch.zeros(a1 - a0, n_det, device=DEVICE)
                    for b in range(binW.shape[0]):
                        e_b = (muMat[ids, b] * STEP).sum(dim=-1)              # (a, K)
                        T += binW[b] * torch.exp(-e_b)
                else:
                    T = torch.exp(-(mu[ids] * STEP).sum(dim=-1))
                Tcone += wz * T
            sino[a0:a1] = -torch.log(Tcone.clamp(min=1e-30))
        if photons0 > 0:
            # Detector-domain quantum + electronic noise with saturation clipping (mirrors
            # projectSlice in ct.js): photon-starved rays through metal floor at the detector
            # noise level and SATURATE at SAT_P rather than exploding into unbounded streaks.
            nfloor = photons0 * math.exp(-SAT_P)                               # photons at the saturation limit
            nexp = photons0 * torch.exp(-sino)                                 # expected detected photons
            nd = nexp + torch.sqrt(nexp + nfloor * nfloor) * torch.randn_like(sino)
            nd = nd.clamp(min=nfloor)                                          # clip below the noise floor -> saturates
            sino = (-torch.log(nd / photons0)).clamp(min=0.0)
        if poly:
            sino = _apply_bhc(sino, bhc_x, bhc_y, bhc_slope)                   # water beam-hardening correction
        if focal_blur:
            sino = _sino_blur(sino)                                            # source/detector band limit → feathery streaks, no crosshatch
        # ---- Ram-Lak filter (grouped 1D convolution over channels) ----
        q = torch.nn.functional.conv1d(sino.unsqueeze(1), h, padding=n_det - 1).squeeze(1) * ds
        # ---- back-project ----
        img = torch.zeros(N, N, dtype=torch.float32, device=DEVICE)
        for a0 in range(0, n_ang, ANGLE_BATCH):
            a1 = min(n_ang, a0 + ANGLE_BATCH)
            kf = (wx.unsqueeze(0) * ct[a0:a1, None, None]
                  + wy.unsqueeze(0) * st[a0:a1, None, None]) / ds + half_det  # (a, N, N)
            k0 = torch.floor(kf).long()
            f = kf - k0.float()
            ok = (k0 >= 0) & (k0 < n_det - 1)
            k0c = k0.clamp(0, n_det - 2)
            rows = q[a0:a1]                                                    # (a, K)
            v0 = torch.gather(rows, 1, k0c.reshape(a1 - a0, -1)).reshape(a1 - a0, N, N)
            v1 = torch.gather(rows, 1, (k0c + 1).reshape(a1 - a0, -1)).reshape(a1 - a0, N, N)
            img += ((v0 * (1 - f) + v1 * f) * ok).sum(dim=0)
        img *= math.pi / n_ang
        img[~in_fov] = 0.0
        out[zi] = img.cpu().numpy()
    return out


@torch.no_grad()
def scout(p: dict[str, Any]) -> np.ndarray:
    """GPU topogram — mirrors scoutProjection in apps/web/src/ct.js. A stack of
    fixed-gantry in-plane fan views (one per couch/table position along z), so the
    result is distortion-free (fan only across the width, no z-divergence). Returns
    a (nz, nw) polyenergetic dose map (line integrals over the spectrum bins)."""
    vv = get_volume(p["model"], p["flips"])
    center = p["center"]
    nw, nz = int(p["nw"]), int(p["nz"])
    pxU = float(p["pxU"])                      # world units per width pixel
    lenU = float(p["lenU"])                    # scan length (world units) along z
    sx, sy, dcx, dcy, ux, uy = (float(p[k]) for k in ("sx", "sy", "dcx", "dcy", "ux", "uy"))
    w = torch.tensor(p["binsW"], dtype=torch.float32, device=DEVICE)          # (nb,)
    mu = torch.tensor(p["muMat"], dtype=torch.float32, device=DEVICE)         # (nmat, nb)
    mu[0].zero_()
    I0 = float(p["I0"])
    rot = rot_tensor(p.get("rot"))
    refDist2 = (sx - dcx) ** 2 + (sy - dcy) ** 2
    half = (nw - 1) / 2.0
    src = torch.tensor([sx, sy], device=DEVICE)
    # detector cells along the width axis (u), all at the row's z (dz = 0)
    u = (torch.arange(nw, device=DEVICE, dtype=torch.float32) - half) * pxU
    cx = dcx + ux * u; cy = dcy + uy * u                                      # (nw,)
    dx = cx - sx; dy = cy - sy
    dist = torch.sqrt(dx * dx + dy * dy)
    dirx = dx / dist; diry = dy / dist                                        # (nw,)
    STEPn = 0.05
    maxlen = float(dist.max())
    nsteps = int(math.ceil(maxlen / STEPn))
    ts = (torch.arange(nsteps, device=DEVICE, dtype=torch.float32) + 0.5) * STEPn  # (S,)
    out = np.empty((nz, nw), dtype=np.float32)
    zsrc = torch.linspace(0.0, lenU, nz, device=DEVICE)                       # couch step per row
    for j in range(nz):
        z = zsrc[j]
        px = sx + dirx.unsqueeze(1) * ts                                      # (nw, S)
        py = sy + diry.unsqueeze(1) * ts
        pz = torch.full_like(px, float(z))
        valid = ts.unsqueeze(0) < dist.unsqueeze(1)
        pts = torch.stack([px, py, pz], dim=-1)                              # (nw, S, 3)
        ids = sample_ids(vv, pts, center, rot)
        L = torch.zeros(nw, vv.nmat, device=DEVICE)
        L.scatter_add_(1, ids, torch.full_like(px, STEPn) * valid)
        T = torch.exp(-(L @ mu)) @ w                                         # polyenergetic transmission
        out[j] = (I0 * (refDist2 / (dist * dist)) * T).cpu().numpy()
    return out


# ---- legacy stub API ----
def reconstruct(params: dict[str, Any]) -> dict:
    return {"implemented": True, "backend": f"torch-{DEVICE.type}",
            "note": "use POST /ct/slices (binary) for reconstructions"}
