"""Extract a VSD subject zip (already NIfTI inside), report dims/coverage, and save a
coronal MIP PNG so we can judge whether the body is in a clean extended supine position.

Usage: python -m app.inspect_vsd <subject_zip> <out_dir> <png_path>
"""
import sys, os, zipfile, glob
import numpy as np, nibabel as nib
from PIL import Image


def main(zip_path, out_dir, png_path):
    os.makedirs(out_dir, exist_ok=True)
    if not glob.glob(os.path.join(out_dir, "**", "*.nii"), recursive=True):
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(out_dir)
    niis = glob.glob(os.path.join(out_dir, "**", "*.nii"), recursive=True)
    if not niis:
        print("no .nii found"); return 2
    nii = max(niis, key=os.path.getsize)
    img = nib.load(nii)
    d = np.squeeze(np.asarray(img.dataobj)).astype(np.float32)   # (x,y,z)
    zoom = img.header.get_zooms()[:3]
    print(f"nii={os.path.basename(nii)} shape={d.shape} spacing={tuple(round(float(z),3) for z in zoom)}"
          f" z-extent={d.shape[2]*zoom[2]:.0f}mm")
    cor = d.max(axis=1)                        # coronal MIP (x,z)
    a = np.clip(cor, -200, 1000); a = ((a + 200) / 1200 * 255).astype(np.uint8)
    im = a.T[::-1, :][::3, :]                  # z vertical (head up), downsample
    Image.fromarray(im).save(png_path)
    print("saved", png_path, im.shape)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1], sys.argv[2], sys.argv[3]))
