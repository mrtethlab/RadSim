"""Build a HIGH-RESOLUTION voxel model of a small anatomy section by upscaling.

The standard builder resamples the whole CT first, which is infeasible at 0.25 mm
(a whole chest would be billions of voxels / GBs of RAM). This one crops to a small
region AT NATIVE RESOLUTION first, then upsamples just that crop to the target
spacing (default 0.25 mm) — so a sub-millimetre model stays memory-bounded.

Upscaling interpolates; it does not invent detail beyond the source scan. The best
source in the repo is the 3D Slicer CTChest (0.76 mm in-plane), so a chest region
(e.g. a shoulder) is the sharpest small section available.

Because a 0.25 mm section is large (100s of MB → GBs), it is written with
backendOnly=true: the browser loads only the header + display mesh and forces the
Python GPU engine, which reads the volume from disk — the big .mat.bin never has to
be fetched into the browser.

CLI:
  ./.venv/Scripts/python.exe -m app.build_highres \
      --ct data/chest/ct.nii.gz --seg data/chest/seg.nii \
      --out ../../apps/web/public/models/hires_shoulder --name hires_shoulder \
      --title "Shoulder (0.25 mm)" --anchor scapula --lateral --margin 22 --spacing 0.25
"""
from __future__ import annotations

import argparse

import numpy as np
import SimpleITK as sitk
from scipy import ndimage as ndi

from .build_model import (materialize, write_model, ts_class_map, _side_mask,
                          resample_iso)


def _crop_native(hu, lab, cmap, anchors, lateral, margin_mm, native_sp):
    """Return native-index bounds of the anchor structures' 3D bbox (+margin)."""
    ids = [lid for lid, nm in cmap.items() if any(a in nm.lower() for a in anchors)]
    present = np.isin(lab, ids)
    if not present.any():
        raise SystemExit(f"anchor {anchors} not found in the segmentation")
    if lateral:
        present = _side_mask(present)
    zs, ys, xs = np.where(present)
    # margin in native index units (per-axis, since native spacing is anisotropic)
    mz = int(round(margin_mm / native_sp[2]))
    my = int(round(margin_mm / native_sp[1]))
    mx = int(round(margin_mm / native_sp[0]))
    zN, yN, xN = hu.shape
    return (max(0, zs.min() - mz), min(zN, zs.max() + mz + 1),
            max(0, ys.min() - my), min(yN, ys.max() + my + 1),
            max(0, xs.min() - mx), min(xN, xs.max() + mx + 1))


def build_highres(ct_path, seg_path, out_dir, name, title, anchors, lateral,
                  margin_mm, spacing, mesh, source, backend_only):
    print("[1/5] loading native CT + segmentation …")
    ct = sitk.ReadImage(ct_path)
    seg = sitk.ReadImage(seg_path)
    seg = sitk.Resample(seg, ct, sitk.Transform(), sitk.sitkNearestNeighbor, 0, seg.GetPixelID())
    native_sp = ct.GetSpacing()
    hu = sitk.GetArrayFromImage(ct).astype(np.int16)
    lab = sitk.GetArrayFromImage(seg).astype(np.int32)
    cmap = ts_class_map()
    print(f"      native {hu.shape[::-1]} @ {tuple(round(s,2) for s in native_sp)} mm")

    print(f"[2/5] cropping to '{anchors}' at native resolution …")
    b = _crop_native(hu, lab, cmap, anchors, lateral, margin_mm, native_sp)
    print(f"      native crop z[{b[0]}:{b[1]}] y[{b[2]}:{b[3]}] x[{b[4]}:{b[5]}]")
    ct_c = ct[b[4]:b[5], b[2]:b[3], b[0]:b[1]]   # sitk indexing is (x,y,z)
    seg_c = seg[b[4]:b[5], b[2]:b[3], b[0]:b[1]]

    print(f"[3/5] upsampling the crop to {spacing} mm iso …")
    ct_hr = resample_iso(ct_c, spacing, is_label=False)
    seg_hr = sitk.Resample(seg_c, ct_hr, sitk.Transform(), sitk.sitkNearestNeighbor, 0, seg_c.GetPixelID())
    hu_hr = sitk.GetArrayFromImage(ct_hr).astype(np.int16)
    lab_hr = sitk.GetArrayFromImage(seg_hr).astype(np.int32)
    print(f"      {hu_hr.shape[::-1]}  ({hu_hr.size/1e6:.0f} M voxels, {hu_hr.size/1e6:.0f} MB uint8)")

    print("[4/5] materials …")
    mat, body = materialize(hu_hr, lab_hr, spacing)
    zs, ys, xs = np.where(body)
    pad = 4
    z0, z1 = max(0, zs.min() - pad), min(mat.shape[0], zs.max() + pad + 1)
    y0, y1 = max(0, ys.min() - pad), min(mat.shape[1], ys.max() + pad + 1)
    x0, x1 = max(0, xs.min() - pad), min(mat.shape[2], xs.max() + pad + 1)
    mat = mat[z0:z1, y0:y1, x0:x1]; hu_c = hu_hr[z0:z1, y0:y1, x0:x1]

    print("[5/5] writing volume …")
    # coarsen the display mesh so a sub-mm grid still exports a light .glb (the mesh
    # is only for the 3D positioning view; the physics reads the full-res volume)
    step_mul = max(1, int(round(1.5 / spacing)))
    write_model(out_dir, name, title, mat, hu_c, spacing, mesh, source,
                backend_only=backend_only, mesh_step_mul=step_mul)
    print("done ->", out_dir)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--ct", required=True)
    ap.add_argument("--seg", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--title", default=None)
    ap.add_argument("--anchor", nargs="+", required=True, help="structure name substrings to crop around")
    ap.add_argument("--lateral", action="store_true", help="isolate one side (limb)")
    ap.add_argument("--margin", type=float, default=20.0, help="crop margin (mm)")
    ap.add_argument("--spacing", type=float, default=0.25)
    ap.add_argument("--source", default="3D Slicer CTChest (0.76 mm) · upscaled")
    ap.add_argument("--no-mesh", action="store_true")
    ap.add_argument("--browser-loadable", action="store_true",
                    help="do NOT mark backend-only (allow the browser to fetch the volume)")
    a = ap.parse_args()
    build_highres(a.ct, a.seg, a.out, a.name, a.title or a.name, a.anchor, a.lateral,
                  a.margin, a.spacing, mesh=not a.no_mesh, source=a.source,
                  backend_only=not a.browser_loadable)
