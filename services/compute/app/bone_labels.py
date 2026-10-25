"""Which bone-dense voxels of a shipped model are bone: the segmentation's own bone labels.

The material volume calls every voxel over 120 HU trabecular or cortical bone, labelled or not, so
in a contrast CT it also holds enhanced vessels (the subclavian, the iliacs at the pelvic brim),
calcified vessel walls and costal cartilage. They belong in the film (they attenuate as they do),
but not in the bone-only view. For a model built by build_model from a segmented CT whose source is
still on disk, the label grid is made again exactly as the model was (stages 1-3: resample,
materialise, region crop, tight body box) and checked against the shipped volume: the bone-dense
voxels must agree voxel for voxel (IoU 1), or it is not used.

    labelled_bone(name, mat) -> bool mask of the bone-dense voxels on a labelled bone (or within
    RIM_MM of one: the labels come from a coarser grid and stop short of the bone's surface), or
    None when the model has no such source.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

DATA = Path(__file__).resolve().parent.parent / 'data'
# the models build_model made from a segmented CT: ct, seg, region, spacing (requirements-models.txt)
SOURCES = {
    'chestabdopelvis': ('totalseg/s1379/ct.nii.gz', 'totalseg/s1379/seg_ml.nii.gz', 'chestabdopelvis', 2.0),
    'chest': ('chest/ct.nii.gz', 'chest/seg.nii', 'chest', 1.0),
}
RIM_MM = 2.0


def label_grid(name, shape):
    """The model's label volume in its shipped grid (z, y, x), or None."""
    import SimpleITK as sitk
    import app.build_model as bm
    src = SOURCES.get(name)
    if not src or not (DATA / src[0]).exists() or not (DATA / src[1]).exists():
        return None
    ct_path, seg_path, region, spacing = str(DATA / src[0]), str(DATA / src[1]), src[2], src[3]
    ct = bm.resample_iso(sitk.ReadImage(ct_path), spacing, is_label=False)
    seg = sitk.Resample(sitk.ReadImage(seg_path), ct, sitk.Transform(), sitk.sitkNearestNeighbor, 0,
                        sitk.ReadImage(seg_path).GetPixelID())
    hu = sitk.GetArrayFromImage(ct).astype(np.int16)
    lab = sitk.GetArrayFromImage(seg).astype(np.int32)
    mat, body = bm.materialize(hu, lab, spacing)
    b = bm._region_bounds(region, lab, bm.ts_class_map(), hu.shape, spacing)
    sl = (slice(b[0], b[1]), slice(b[2], b[3]), slice(b[4], b[5]))
    body, mat, lab = body[sl], mat[sl], lab[sl]
    zs, ys, xs = np.where(body)
    pad = 4
    box = tuple(slice(max(0, v.min() - pad), min(n, v.max() + pad + 1)) for v, n in zip((zs, ys, xs), mat.shape))
    mat, lab = mat[box], lab[box]
    if mat.shape != tuple(shape):
        return None
    return mat, lab


def labelled_bone(name, mat):
    import app.build_model as bm
    got = label_grid(name, mat.shape)
    if got is None:
        return None
    rmat, lab = got
    dense = np.isin(mat, [bm.TRABECULAR, bm.CORTICAL])
    rdense = np.isin(rmat, [bm.TRABECULAR, bm.CORTICAL])
    iou = (dense & rdense).sum() / max(1, (dense | rdense).sum())
    if iou < 0.9999:
        print(f'{name}: the label grid does not match the shipped volume (bone IoU {iou:.4f}); not used')
        return None
    cmap = bm.ts_class_map()
    bone = np.isin(lab, [l for l, n in cmap.items() if bm.name_to_material(n) == -1])
    s = SOURCES[name][3]
    near = ndi.binary_dilation(bone, iterations=max(1, round(RIM_MM / s)))
    return dense & near
