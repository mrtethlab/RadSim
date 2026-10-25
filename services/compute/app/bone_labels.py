"""Which bone-dense voxels of a shipped model are bone: the segmentation's own bone labels.

The material volume calls every voxel over 120 HU trabecular or cortical bone, labelled or not, so
in a contrast CT it also holds enhanced vessels (the subclavian, the iliacs at the pelvic brim),
calcified vessel walls and costal cartilage. They belong in the film (they attenuate as they do),
but not in the bone-only view. For a model built by build_model from a segmented CT whose source is
still on disk, the label grid is made again exactly as the model was (stages 1-3: resample,
materialise, region or box crop, tight body box, and any crop after) and checked against the
shipped volume: the bone must agree voxel for voxel, or the materials in 99 % of voxels, or it is
not used.

    labelled_bone(name, mat) -> bool mask of the bone-dense voxels on a labelled bone (or within
    RIM_MM of one: the labels come from a coarser grid and stop short of the bone's surface), or
    None when the model has no such source.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

DATA = Path(__file__).resolve().parent.parent / 'data'
# the models build_model made from a segmented CT: ct, seg, region, spacing, box, and what was done
# to the volume after (requirements-models.txt; build_limbs.head_neck)
SOURCES = {
    'chestabdopelvis': ('totalseg/s1379/ct.nii.gz', 'totalseg/s1379/seg_ml.nii.gz', 'chestabdopelvis', 2.0, None, None),
    'chest': ('chest/ct.nii.gz', 'chest/seg.nii', 'chest', 1.0, None, None),
    'headneck': ('totalseg/s1082/ct.nii.gz', 'totalseg/s1082/seg_ml.nii.gz', 'wholebody', 1.5, (0.55, 1.0, 0, 1, 0, 1), 'headneck'),
}
# (not the VSD postmortem scans: TotalSegmentator, fast or full, labelled a fraction of z045's spine
# and scapulae, so its labels cannot say what is bone there; build_bone_mesh judges those by shape)
RIM_MM = 2.0


def label_grid(name, shape):
    """The model's materials and labels (z, y, x) on its shipped grid, made again; or None."""
    import SimpleITK as sitk
    import app.build_model as bm
    src = SOURCES.get(name)
    if not src or not (DATA / src[0]).exists() or not (DATA / src[1]).exists():
        return None
    ct_path, seg_path, region, spacing, box, post = str(DATA / src[0]), str(DATA / src[1]), *src[2:]
    ct = bm.resample_iso(sitk.ReadImage(ct_path), spacing, is_label=False)
    seg = sitk.ReadImage(seg_path)
    seg = sitk.Resample(seg, ct, sitk.Transform(), sitk.sitkNearestNeighbor, 0, seg.GetPixelID())
    hu = sitk.GetArrayFromImage(ct).astype(np.int16)
    lab = sitk.GetArrayFromImage(seg).astype(np.int32)
    mat, body = bm.materialize(hu, lab, spacing)
    if box is not None:
        n = hu.shape
        b = (int(box[0] * n[0]), int(box[1] * n[0]), int(box[2] * n[1]), int(box[3] * n[1]), int(box[4] * n[2]), int(box[5] * n[2]))
    else:
        b = bm._region_bounds(region, lab, bm.ts_class_map(), hu.shape, spacing)
    sl = (slice(b[0], b[1]), slice(b[2], b[3]), slice(b[4], b[5]))
    body, mat, lab = body[sl], mat[sl], lab[sl]
    mat, lab = tight(body, mat, lab)
    if post == 'headneck':
        # build_limbs.head_neck: the scanner table off behind the head, then finish()'s tight box
        from app.build_limbs import pare
        keep = mat > 0
        deep = ndi.distance_transform_edt(keep) >= 3
        for z in range(mat.shape[0]):
            ys = np.nonzero(deep[z].any(1))[0]
            if len(ys):
                keep[z, :max(0, ys.min() - 3)] = False
        keep = pare(keep, r=0)
        mat, lab = tight(keep, np.where(keep, mat, 0), lab)
    if mat.shape != tuple(shape):
        return None
    return mat, lab


def tight(body, mat, lab, pad=4):
    zs, ys, xs = np.where(body)
    box = tuple(slice(max(0, v.min() - pad), min(n, v.max() + pad + 1)) for v, n in zip((zs, ys, xs), mat.shape))
    return mat[box], lab[box]


def labelled_bone(name, mat):
    import app.build_model as bm
    got = label_grid(name, mat.shape)
    if got is None:
        return None
    rmat, lab = got
    dense = np.isin(mat, [bm.TRABECULAR, bm.CORTICAL])
    rdense = np.isin(rmat, [bm.TRABECULAR, bm.CORTICAL])
    # the same grid: the bone agrees voxel for voxel (the chest's later vessel passes changed soft
    # tissue only), or the materials agree all but everywhere (the head and neck's opened joint
    # spaces changed bone at the joints, not the grid)
    iou = (dense & rdense).sum() / max(1, (dense | rdense).sum())
    agree = (mat == rmat).mean()
    if not (iou >= 0.9999 or (agree >= 0.99 and iou >= 0.9)):
        print(f'{name}: the label grid does not match the shipped volume (materials {agree:.4f}, bone IoU {iou:.4f}); not used')
        return None
    cmap = bm.ts_class_map()
    bone = np.isin(lab, [l for l, n in cmap.items() if bm.name_to_material(n) == -1])
    s = SOURCES[name][3]
    near = ndi.binary_dilation(bone, iterations=max(1, round(RIM_MM / s)))
    return dense & near
