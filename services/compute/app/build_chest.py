"""Build the bundled human-chest phantom (thin wrapper over build_model.py).

Kept for backwards-compatibility with the original chest command. The material
mapping + volume writer now live in app.build_model; this just calls it with the
chest metadata and no region crop (the source CT is already a chest).

Run (from services/compute):
  ./.venv/Scripts/python.exe -m app.build_chest \
      --ct data/chest/ct.nii.gz --seg data/chest/seg.nii \
      --out ../../apps/web/public/models/chest --spacing 1.0
"""
from __future__ import annotations

import argparse

from .build_model import build

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--ct", required=True)
    ap.add_argument("--seg", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--spacing", type=float, default=1.0)
    ap.add_argument("--no-mesh", action="store_true")
    a = ap.parse_args()
    build(a.ct, a.seg, a.out, name="chest", title="Human chest", region="wholebody",
          spacing=a.spacing, mesh=not a.no_mesh,
          source="3D Slicer CTChest sample · segmented with TotalSegmentator")
