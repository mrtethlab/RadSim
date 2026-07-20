"""Inventory an extracted TotalSegmentator dataset: group cases by study_type and
report each case's cranio-caudal extent, so we can pick the best exemplar per region.

The dataset root has meta.csv (image_id, study_type, ...) + s0xxx/ct.nii.gz folders.

CLI:
  ./.venv/Scripts/python.exe -m app.inventory_ts --root data/ts_small/Totalsegmentator_dataset_small_v201
"""
from __future__ import annotations

import argparse
import csv
import glob
import os

import SimpleITK as sitk


def zextent_mm(ct_path: str) -> float:
    r = sitk.ImageFileReader(); r.SetFileName(ct_path); r.ReadImageInformation()
    sz, sp = r.GetSize(), r.GetSpacing()
    return round(sz[2] * sp[2], 0)


def main(root: str, measure: bool):
    meta = os.path.join(root, "meta.csv")
    rows = []
    if os.path.exists(meta):
        with open(meta, newline="") as f:
            # the dataset uses ';' delimiter
            sample = f.read(2048); f.seek(0)
            delim = ';' if sample.count(';') > sample.count(',') else ','
            for r in csv.DictReader(f, delimiter=delim):
                rows.append(r)
    by_type: dict[str, list] = {}
    for r in rows:
        st = (r.get("study_type") or r.get("study") or "?").strip()
        iid = (r.get("image_id") or r.get("id") or "").strip()
        by_type.setdefault(st, []).append(iid)
    print(f"=== {len(rows)} cases, {len(by_type)} study types ===")
    for st in sorted(by_type, key=lambda k: -len(by_type[k])):
        ids = by_type[st]
        line = f"{st:24s} {len(ids):3d}  e.g. {', '.join(ids[:6])}"
        print(line)
    if measure:
        print("\n=== per-case cranio-caudal extent (mm) ===")
        for st in sorted(by_type):
            for iid in by_type[st]:
                ctp = os.path.join(root, iid, "ct.nii.gz")
                if os.path.exists(ctp):
                    try:
                        print(f"{iid:8s} {st:22s} {zextent_mm(ctp):6.0f} mm")
                    except Exception as e:
                        print(f"{iid:8s} {st:22s} ERR {e}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--measure", action="store_true", help="also read each CT header for z-extent")
    a = ap.parse_args()
    main(a.root, a.measure)
