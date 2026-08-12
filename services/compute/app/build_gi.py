"""Extract the GI transport coordinate for a built voxel model.

The barium solver needs the same thing from the gut that the contrast solver needs from the
vessels: for every lumen voxel, HOW FAR ALONG the tract it sits. But the gut differs from the
vasculature in three ways that shape this file.

**It is ONE tube, in a fixed order.** Oesophagus -> stomach -> duodenum -> small bowel ->
colon. A swallow traverses all of it in sequence, so each segment's arclength is seeded at its
junction with the segment BEFORE it, not at some global root. The junction is found by
dilating the upstream segment and intersecting — the two labels abut in the volume, so where
they touch is where the contents pass.

**Its geometry is not trustworthy at this resolution, and pretending otherwise would be the
real error.** Small bowel is ~6 m of tube packed into a 25 cm block; at 2 mm voxels the loops
touch, and a geodesic walk short-circuits across the contact points rather than following the
lumen all the way round. The measured length therefore UNDERSTATES the anatomy badly, and this
module reports the ratio so the number is never mistaken for anatomical truth.

That is why `s` is written NORMALISED (0..1 within each segment) rather than in mm, and why
the solver is meant to drive transit from physiological times per segment — oesophagus in
seconds, gastric emptying in tens of minutes, small bowel in hours — rather than from a
velocity times a length it cannot measure. The geometry supplies the ORDER and the SHAPE of
the path, which it does get right; the timing comes from physiology.

**Gas is part of the lumen.** The arclength covers the whole segmentation, gas voxels
included, because barium flows into a gas-filled bowel — that is what a double-contrast study
is. Material id 47 (bowel gas) is therefore inside the mask here even though it is not a
"lumen content" id.

Output next to the model:
  <name>.gi.json      — per segment: length, area profile, volume, component count
  <name>.giarc.bin    — uint16 normalised s, one per GI voxel, raster order. Which voxels
                        those are is in <name>.mat.bin (ids 47..52), so no index is stored.

CLI:
  ./.venv/Scripts/python.exe -m app.build_gi --model ../../apps/web/public/models/chestabdopelvis --name chestabdopelvis
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
from scipy import ndimage as ndi

from .build_model import GAS, OESOPHAGUS, STOMACH, DUODENUM, SMALL_BOWEL, COLON
from .build_vessels import geodesic_s, largest_component

N_SAMPLES = 64          # arclength bins per segment, as the contrast timeline uses

# Physiological order. The solver walks this list; the geometry only has to agree with it.
ORDER = [
    (OESOPHAGUS, "Oesophagus", 250.0),      # (id, name, typical anatomical length mm)
    (STOMACH, "Stomach", 250.0),
    (DUODENUM, "Duodenum", 250.0),
    (SMALL_BOWEL, "Small bowel", 6000.0),
    (COLON, "Colon", 1500.0),
]
GI_IDS = [vid for vid, _, _ in ORDER]


def junction_seed(mask, upstream, spacing, max_gap_mm=15.0):
    """One voxel layer of `mask` NEAREST `upstream` — where contents enter this segment.

    Distance-to-upstream rather than dilate-and-intersect. The first version dilated the
    upstream segment by two voxels and took the overlap, which assumed the two labels touch;
    at the pylorus they do not always, and a 4 mm gap made the seed empty. The duodenum then
    fell through to the fallback and came out running backwards — s=0 at the duodenojejunal
    flexure, 71 mm from the stomach, with s=1 at the pylorus 14 mm away.

    Taking the nearest face works whether the labels touch or sit a few mm apart, and still
    refuses when they are genuinely unrelated (`max_gap_mm`), so a missing segment cannot
    silently seed the next one from the wrong place.

    The band is one voxel layer: a thick seed flattens a whole slab to s=0, which is the
    mistake build_vessels documents for the aorta's inlet."""
    if upstream is None or not upstream.any() or not mask.any():
        return None
    dt = ndi.distance_transform_edt(~upstream, sampling=spacing)
    dm = dt[mask]
    ref = float(dm.min())
    if ref > max_gap_mm:
        return None                               # not adjacent — the caller decides
    band = 1.2 * max(spacing)
    sel = np.zeros_like(mask)
    sel[mask] = dm <= ref + band
    return largest_component(sel)[0]


def far_end(mask, other, spacing):
    """Seed for the FIRST segment: the end of `mask` furthest from `other`.

    The oesophagus has no upstream segment in the volume — the mouth is outside the scan — so
    its inlet is simply the end away from the stomach. Orientation-free, so it does not care
    which way z runs in a given model."""
    if not mask.any():
        return None
    if other is None or not other.any():
        idx = np.argwhere(mask)
        pick = idx[np.argmax(idx[:, 0])]          # fall back to one extreme along z
        sel = np.zeros_like(mask)
        sel[tuple(pick)] = True
        return sel
    d = ndi.distance_transform_edt(~other, sampling=spacing)
    dm = d[mask]
    band = 1.2 * max(spacing)
    sel = np.zeros_like(mask)
    sel[mask] = np.abs(dm - dm.max()) <= band
    if not sel.any():
        idx = np.argwhere(mask)[int(np.argmax(dm))]
        sel[tuple(idx)] = True
        return sel
    return largest_component(sel)[0]


def build(model_dir, name):
    hp = os.path.join(model_dir, f'{name}.model.json')
    with open(hp) as f:
        hdr = json.load(f)
    nx, ny, nz = hdr['dims']
    spacing = tuple(hdr['spacing'])
    mat = np.fromfile(os.path.join(model_dir, f'{name}.mat.bin'),
                      dtype=np.uint8).reshape(nz, ny, nx)
    print(f'[1/3] {name}: {nx}x{ny}x{nz} @ {spacing} mm')

    # The lumen ids plus the gas that sits inside them. Gas has no id of its own per segment,
    # so it is attached to whichever segment's lumen it is adjacent to.
    lumen = {vid: (mat == vid) for vid in GI_IDS}
    present = [vid for vid in GI_IDS if lumen[vid].any()]
    if not present:
        print('      no GI segments in this model — nothing to do')
        return
    gas = mat == GAS
    if gas.any():
        # nearest-lumen assignment, so a gas-filled stomach still belongs to the stomach
        idx = ndi.distance_transform_edt(
            ~np.isin(mat, present), sampling=spacing, return_distances=False,
            return_indices=True)
        owner = mat[tuple(idx)]
        for vid in present:
            lumen[vid] = lumen[vid] | (gas & (owner == vid))

    print(f'[2/3] {len(present)} segments present')
    out, prev_mask = {}, None
    arclen = np.zeros(mat.shape, dtype=np.uint16)
    for vid, nm, anat_mm in ORDER:
        if vid not in present:
            prev_mask = None
            continue
        m = lumen[vid]
        ncomp = ndi.label(m)[1]
        seed = junction_seed(m, prev_mask, spacing)
        if seed is None:
            # No usable upstream junction — either this is the first segment, or the labels
            # are too far apart to be a junction. Seed at the end furthest from the segment
            # that comes NEXT, which for the oesophagus is the mouth end.
            # (The first version of this took "the first other present segment in ORDER",
            # which for the duodenum meant the oesophagus — an irrelevant reference two
            # segments upstream, and the reason it came out reversed.)
            nxt = None
            for v2, _, _ in ORDER[ORDER.index((vid, nm, anat_mm)) + 1:]:
                if v2 in present:
                    nxt = lumen[v2]
                    break
            seed = far_end(m, nxt, spacing)
        d, unreachable = geodesic_s(m, seed, spacing)
        L = float(d[m].max()) if m.any() else 0.0
        if L > 0:
            arclen[m] = np.clip(d[m] / L * 65535.0, 0, 65535).astype(np.uint16)
        vol = float(m.sum() * np.prod(spacing) / 1000.0)
        # area profile: voxels per bin / bin length, the same construction build_vessels uses
        bins = np.clip((d[m] / max(L, 1e-6) * (N_SAMPLES - 1)).astype(int), 0, N_SAMPLES - 1)
        cnt = np.bincount(bins, minlength=N_SAMPLES).astype(float)
        binlen = max(L / N_SAMPLES, 1e-6)
        area = cnt * float(np.prod(spacing)) / binlen
        # Where each bin SITS, in model mm. Gravity is the whole point of a barium study —
        # you turn the patient to move the agent — and to model that the solver needs the
        # elevation profile along the tract, which it gets by rotating these centroids into
        # the patient's current pose. A(s) alone cannot express "the fundus is now dependent".
        vox = np.argwhere(m)                      # (z, y, x) index order
        cz = np.bincount(bins, weights=vox[:, 0], minlength=N_SAMPLES)
        cy = np.bincount(bins, weights=vox[:, 1], minlength=N_SAMPLES)
        cx = np.bincount(bins, weights=vox[:, 2], minlength=N_SAMPLES)
        n = np.maximum(cnt, 1.0)
        centre = np.stack([cx / n * spacing[0], cy / n * spacing[1], cz / n * spacing[2]], 1)
        centre[cnt == 0] = np.nan                 # empty bin: no position to report
        ratio = L / anat_mm if anat_mm else 0.0
        flag = ''
        if unreachable:
            flag += f'  [{unreachable} unreachable]'
        if ncomp > 1:
            flag += f'  [{ncomp} components]'
        if ratio < 0.5:
            flag += f'  [geodesic is {ratio*100:.0f} % of the ~{anat_mm/10:.0f} cm anatomy'
            flag += ' — loops short-circuit at this voxel size]'
        out[str(vid)] = dict(name=nm, lengthMM=round(L, 1), volumeML=round(vol, 1),
                             anatomicalLengthMM=anat_mm,
                             geodesicFraction=round(ratio, 3),
                             components=int(ncomp), unreachable=int(unreachable),
                             areaMM2=[round(a, 1) for a in area],
                             centreMM=[[None if np.isnan(v) else round(float(v), 1)
                                        for v in p] for p in centre])
        print(f'      {nm:14s} {L:7.1f} mm  {vol:7.1f} mL  '
              f'mean A {area[area>0].mean() if (area>0).any() else 0:7.1f} mm2{flag}')
        prev_mask = m

    print('[3/3] writing …')
    gi_vox = np.isin(mat, GI_IDS + [GAS])
    packed = arclen[gi_vox]
    packed.tofile(os.path.join(model_dir, f'{name}.giarc.bin'))
    meta = dict(nSamples=N_SAMPLES, spacingMM=list(spacing),
                nGIVoxels=int(gi_vox.sum()), order=[v for v, _, _ in ORDER], segments=out,
                note='giarc.bin: uint16 normalised geodesic s per GI voxel (material ids '
                     '47..52), raster order, x-fastest — same order as mat.bin. s is '
                     'normalised WITHIN each segment; transit is driven by physiological '
                     'times per segment, not by these lengths (see the module docstring).')
    with open(os.path.join(model_dir, f'{name}.gi.json'), 'w') as f:
        json.dump(meta, f, indent=2)
    hdr['gi'] = f'{name}.gi.json'
    hdr['giarc'] = f'{name}.giarc.bin'
    with open(hp, 'w') as f:
        json.dump(hdr, f, indent=1)
    print(f'      {int(gi_vox.sum())} GI voxels -> {packed.nbytes/1e6:.2f} MB')
    print(f'      wrote {name}.gi.json + {name}.giarc.bin')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--name', required=True)
    a = ap.parse_args()
    build(a.model, a.name)
