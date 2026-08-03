"""Render a coronal MIP PNG of a built voxel model (.mat.bin + .model.json) so a crop
can be eyeballed. Bone bright, soft mid, air black. Usage:
  python -m app.mip_model <model_dir> <name> <png_path>
"""
import sys, os, json
import numpy as np
from PIL import Image


def main(model_dir, name, png):
    meta = json.load(open(os.path.join(model_dir, f"{name}.model.json")))
    nx, ny, nz = meta["dims"]
    vol = np.fromfile(os.path.join(model_dir, meta["volume"]), dtype=np.uint8)
    vol = vol.reshape(nz, ny, nx)                     # x-fastest -> (z,y,x)
    # map material id -> display brightness by name
    bright = np.zeros(256, np.uint8)
    for m in meta["materials"]:
        n = m["name"].lower(); i = m["id"]
        if "air" in n:                       bright[i] = 0
        elif "lung" in n:                    bright[i] = 40
        elif "cortical" in n or "enamel" in n: bright[i] = 255
        elif "trabecular" in n or "bone" in n or "calc" in n: bright[i] = 210
        elif "skin" in n:                    bright[i] = 70
        elif "fat" in n:                     bright[i] = 55
        else:                                bright[i] = 110
    disp = bright[vol]                                # (z,y,x)
    cor = disp.max(axis=1)                            # coronal MIP (z,x)
    cor = cor[:, :][::max(1, nz // 900), :]           # keep z under ~900 px
    Image.fromarray(cor).save(png)
    print(f"saved {png}  dims(nx,ny,nz)={nx,ny,nz}  extent_mm="
          f"{tuple(round(d*meta['spacing'][0]) for d in (nx,ny,nz))}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
