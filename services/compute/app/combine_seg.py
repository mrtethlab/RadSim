"""Combine a TotalSegmentator-dataset case's per-structure masks into one multilabel.

The TotalSegmentator dataset ships each subject as:
    s0xxx/ct.nii.gz
    s0xxx/segmentations/<structure>.nii.gz   (one binary mask per structure)

build_model.py wants a single multilabel volume whose voxel values are the
class_map["total"] ids. This stacks the per-structure masks into that, so we can
use the dataset's GROUND-TRUTH segmentations directly (higher quality than a fresh
--fast run, and no GPU inference needed).

CLI:
  ./.venv/Scripts/python.exe -m app.combine_seg --case data/ts_small/s0287 \
      --out data/ts_small/s0287/seg_ml.nii.gz
"""
from __future__ import annotations

import argparse
import os

import numpy as np
import SimpleITK as sitk


def combine(case_dir: str, out_path: str) -> str:
    from totalsegmentator.map_to_binary import class_map
    cmap = class_map["total"]
    name_to_id = {nm: lid for lid, nm in cmap.items()}
    seg_dir = os.path.join(case_dir, "segmentations")
    ref = sitk.ReadImage(os.path.join(case_dir, "ct.nii.gz"))
    shape = sitk.GetArrayFromImage(ref).shape
    ml = np.zeros(shape, dtype=np.uint16)
    found = 0
    # deterministic order (by id) so higher-id structures win on overlap
    for lid in sorted(cmap):
        nm = cmap[lid]
        p = os.path.join(seg_dir, nm + ".nii.gz")
        if not os.path.exists(p):
            continue
        mask = sitk.GetArrayFromImage(sitk.ReadImage(p)) > 0
        if mask.shape != shape:
            continue
        ml[mask] = lid
        found += 1
    out = sitk.GetImageFromArray(ml)
    out.CopyInformation(ref)
    sitk.WriteImage(out, out_path)
    print(f"combined {found} structures -> {out_path}  ({shape[::-1]})")
    return out_path


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", required=True, help="subject folder with ct.nii.gz + segmentations/")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    combine(a.case, a.out)
