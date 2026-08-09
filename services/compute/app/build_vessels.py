"""Extract the vascular transport coordinate for a built voxel model.

The contrast solver (docs/contrast-simulation.md §1) stores concentration as C(s, t) on the
vascular graph rather than per voxel, which is what turns 7.3 GB per parameter set into
1.4 MB. That needs one thing from the geometry: for every vessel voxel, HOW FAR ALONG THE
VESSEL it sits — the `s` the solver indexes.

`s` is the GEODESIC distance from the vessel's inlet, measured inside the vessel mask, not a
Euclidean distance and not a projection onto a fitted line. That matters for two reasons:

  - the aorta is a hairpin. Euclidean distance from the root makes the descending aorta look
    adjacent to the arch, so a bolus would appear in the abdomen before it had traversed the
    arch. Geodesic distance follows the lumen.
  - the pulmonary artery is a TREE, not a tube, so no single centreline polyline describes
    it. Geodesic distance from the root generalises to a branching structure for free: every
    voxel gets its distance along the tree, which is exactly the transport coordinate. A
    skeleton-and-longest-path approach would have to discard every branch it did not choose.

Also emitted per vessel: the cross-sectional area profile A(s), which the solver needs for
u = Q/A, and which falls out of the same binning — voxels per bin divided by bin length.

Output next to the model:
  <name>.vessels.json  — per vessel: length, area profile, volume, flow direction
  <name>.arclen.bin    — uint16 normalised s, one per vessel voxel, in raster order.
                         Which voxels are vessels is already in <name>.mat.bin (id >= 29),
                         so no index is stored; the reader walks the two together.

CLI:
  ./.venv/Scripts/python.exe -m app.build_vessels --model ../../apps/web/public/models/chest --name chest
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
from scipy import ndimage as ndi
from skimage.graph import MCP_Geometric

from .build_model import (VESSELS, HEART, AORTA, PULM_ARTERY, PULM_VEIN, SVC, IVC,
                          PORTAL_VEIN, BRACHIOceph_TRUNK, SUBCLAV_A_R, SUBCLAV_A_L,
                          CAROTID_R, CAROTID_L, BRACHIOceph_V_R, BRACHIOceph_V_L,
                          ATRIAL_APP_L, ILIAC_A_R, ILIAC_A_L, ILIAC_V_R, ILIAC_V_L)

# Which end of each vessel the blood enters by. Arteries carry the bolus away from the
# heart, veins return it, and that decides which end is s=0 — get it backwards and the bolus
# runs up the IVC from the legs instead of down it from the liver.
FROM_HEART = {AORTA, PULM_ARTERY, BRACHIOceph_TRUNK, SUBCLAV_A_R, SUBCLAV_A_L,
              CAROTID_R, CAROTID_L, ILIAC_A_R, ILIAC_A_L}
TO_HEART = {PULM_VEIN, SVC, IVC, PORTAL_VEIN, BRACHIOceph_V_R, BRACHIOceph_V_L,
            ILIAC_V_R, ILIAC_V_L, ATRIAL_APP_L}

N_SAMPLES = 200          # arclength samples per vessel — see docs §1 storage budget


def largest_component(mask):
    """Drop specks: segmentation leaves stray voxels that would otherwise become the inlet."""
    lab, n = ndi.label(mask)
    if n <= 1:
        return mask, n
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    return lab == sizes.argmax(), n


def geodesic_s(mask, seed, spacing):
    """Geodesic distance (mm) from `seed` through `mask`, and the unreachable count.

    MCP_Geometric walks only inside the mask, so distance follows the lumen around bends.
    Voxels the walk cannot reach (a detached fragment the component filter kept) come back
    as inf and are reported rather than silently clamped.
    """
    costs = np.where(mask, 1.0, np.inf)
    mcp = MCP_Geometric(costs, sampling=spacing)
    d, _ = mcp.find_costs(np.argwhere(seed))
    d = np.asarray(d)
    unreachable = int((mask & ~np.isfinite(d)).sum())
    d[~np.isfinite(d)] = 0.0
    return d, unreachable


def pick_seed(mask, heart_dist, from_heart, spacing):
    """The inlet face of the vessel: the end nearest the heart for an artery leaving it,
    the far end for a vein returning to it.

    The band is ONE voxel layer, not a slab. Every seed voxel starts the walk at distance 0,
    so a thick band flattens that whole slab to s=0 — with a 5 mm band the aorta's first
    area bin came out at 10717 mm2, a 117 mm 'vessel', which would have given the solver a
    near-zero inlet velocity and stalled the bolus on entry. One layer is the inlet
    cross-section, which is what A(s=0) is supposed to mean.
    """
    d = heart_dist[mask]
    if d.size == 0:
        return None
    ref = d.min() if from_heart else d.max()
    band = 1.2 * max(spacing)                     # ~one voxel layer
    sel = np.zeros_like(mask)
    sel[mask] = np.abs(d - ref) <= band
    if not sel.any():                             # degenerate: fall back to the single end
        idx = np.argwhere(mask)[np.argmin(d) if from_heart else np.argmax(d)]
        sel[tuple(idx)] = True
        return sel
    # One contiguous face. The central pulmonary artery lies against the heart over a broad
    # area, so an equal-distance band picks the whole contact surface rather than a
    # cross-section, and every voxel of it starts at s=0. Keeping the largest connected
    # patch gives one inlet instead of several scattered around the heart.
    return largest_component(sel)[0]


def build(model_dir, name):
    hdr = json.load(open(os.path.join(model_dir, f'{name}.model.json')))
    nx, ny, nz = hdr['dims']
    spacing = tuple(float(s) for s in hdr['spacing'])          # (x, y, z) mm
    mat = np.fromfile(os.path.join(model_dir, f'{name}.mat.bin'),
                      dtype=np.uint8).reshape(nz, ny, nx)
    samp = (spacing[2], spacing[1], spacing[0])                # array order (z, y, x)
    vox_ml = float(np.prod(spacing)) / 1000.0
    names = {vid: nm for vid, nm in VESSELS}

    print(f'[1/3] {name}: {nx}x{ny}x{nz} @ {spacing} mm')
    heart = mat == HEART
    if not heart.any():
        raise SystemExit('no heart in this model — the inlet rule needs it as the reference')
    # distance to the heart, in mm, everywhere: the reference for choosing each inlet
    heart_dist = ndi.distance_transform_edt(~heart, sampling=samp)

    present = [vid for vid, _ in VESSELS if (mat == vid).any()]
    print(f'[2/3] {len(present)} vessels present')

    # arclength for every vessel voxel, in raster order (matches mat.bin)
    arclen = np.zeros(mat.shape, dtype=np.uint16)
    out = {}
    for vid in present:
        full = mat == vid
        # work in the vessel's bounding box: the geodesic walk is O(volume)
        zz, yy, xx = np.where(full)
        sl = (slice(zz.min(), zz.max() + 1), slice(yy.min(), yy.max() + 1),
              slice(xx.min(), xx.max() + 1))
        sub_full = full[sl]
        m, ncomp = largest_component(sub_full)
        orphan = sub_full & ~m          # fragments the geodesic walk cannot reach

        seed = pick_seed(m, heart_dist[sl], vid in FROM_HEART, samp)
        d, unreachable = geodesic_s(m, seed, samp)
        length = float(d[m].max())
        if length <= 0:
            print(f'      ! {names[vid]}: zero length, skipped')
            continue

        # normalised s -> uint16, and the area profile from the same binning
        sfield = np.zeros(m.shape, dtype=np.float32)
        sfield[m] = np.clip(d[m] / length, 0, 1)
        # A 1 mm grid breaks the peripheral pulmonary tree into hundreds of islands the
        # geodesic walk cannot reach. Leaving them at s=0 would make a subsegmental branch
        # opacify with the main trunk — the wrong end of the vessel entirely. Give each
        # orphan the s of the nearest voxel that IS connected, which puts it at the right
        # depth in the tree even though its own path is broken.
        if orphan.any():
            _, idx = ndi.distance_transform_edt(~m, sampling=samp, return_indices=True)
            sfield[orphan] = sfield[idx[0][orphan], idx[1][orphan], idx[2][orphan]]

        keep = sub_full                                     # every voxel of this vessel
        s = sfield[keep]
        block = arclen[sl]
        block[keep] = np.round(s * 65535).astype(np.uint16)
        arclen[sl] = block

        bins = np.clip((s * N_SAMPLES).astype(int), 0, N_SAMPLES - 1)
        counts = np.bincount(bins, minlength=N_SAMPLES)
        seg_len = length / N_SAMPLES                        # mm per bin
        area = counts * vox_ml * 1000.0 / max(seg_len, 1e-6)   # mm^3 / mm = mm^2
        vol = float(keep.sum() * vox_ml)
        med = float(np.median(area[area > 0])) if (area > 0).any() else 0.0
        if med > 0 and area[0] > 6 * med:
            print(f'      ! {names[vid]}: inlet bin {area[0]:.0f} mm2 vs median {med:.0f} '
                  f'— seed band is collapsing a slab, check pick_seed')

        out[str(vid)] = dict(
            name=names[vid], flow='from_heart' if vid in FROM_HEART else 'to_heart',
            lengthMM=round(length, 1), volumeML=round(vol, 2),
            areaMM2=[round(float(a), 1) for a in area],
            meanAreaMM2=round(float(vol * 1000.0 / max(length, 1e-6)), 1),
        )
        flag = ''
        n_orph = int(orphan.sum())
        if n_orph: flag += f'  [{n_orph} orphan vox re-attached, {ncomp} components]'
        if unreachable: flag += f'  [{unreachable} unreachable]'
        print(f'      {names[vid]:<24} {length:6.1f} mm  {vol:6.1f} mL  '
              f'mean A {out[str(vid)]["meanAreaMM2"]:6.1f} mm2{flag}')

    print('[3/3] writing …')
    # sparse: one uint16 per vessel voxel, raster order. mat.bin already says which voxels
    # those are (id >= 29), so no index is needed and the file stays ~1.5 MB not ~80 MB.
    vessel_vox = mat >= min(vid for vid, _ in VESSELS)
    packed = arclen[vessel_vox]
    packed.tofile(os.path.join(model_dir, f'{name}.arclen.bin'))
    meta = dict(nSamples=N_SAMPLES, spacingMM=list(spacing),
                nVesselVoxels=int(vessel_vox.sum()), vessels=out,
                note='arclen.bin: uint16 normalised geodesic s per vessel voxel '
                     '(material id >= 29), raster order, x-fastest — same order as mat.bin')
    with open(os.path.join(model_dir, f'{name}.vessels.json'), 'w') as f:
        json.dump(meta, f, indent=2)

    hp = os.path.join(model_dir, f'{name}.model.json')
    hdr = json.load(open(hp))
    hdr['vessels'] = f'{name}.vessels.json'
    hdr['arclen'] = f'{name}.arclen.bin'
    json.dump(hdr, open(hp, 'w'), indent=2)
    print(f'      {packed.size} vessel voxels -> {packed.nbytes/1e6:.2f} MB')
    print(f'      wrote {name}.vessels.json + {name}.arclen.bin')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True, help='model folder')
    ap.add_argument('--name', required=True)
    a = ap.parse_args()
    build(a.model, a.name)
