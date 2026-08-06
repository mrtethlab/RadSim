"""Build the RadSim voxel HAND phantom from a hand-specific CT-derived skeleton.

Unlike the other models (whole-body CT + TotalSegmentator, see build_model.py), no
open whole-volume hand CT is redistributable, so this uses a dedicated CT scan OF A
HAND published as a surface model: Scan the World "Hand bones" (Zenodo 10.5281/
zenodo.21244925, CC BY-NC-SA 4.0) — "a model of the skeletal structure of hands based
on a CT scan". The file holds two hand skeletons; one is voxelised here.

The skeleton is real, hand-specific CT anatomy (phalanges, metacarpals, carpals,
distal radius/ulna). The soft-tissue envelope is DERIVED from that same skeleton by
morphology — dilate each bone, then close, so the fingers stay separate while the
metacarpals merge into a palm with webbing — and layered skin / subcutaneous fat /
intrinsic muscle by depth. Bone is split cortical-shell vs trabecular-core by depth,
which is what a hand radiograph is dominated by.

Pipeline:
  1. Decode the Draco-compressed glTF, split into connected components, pick one hand.
  2. Voxelise (watertight → solid fill) at `spacing` mm.
  3. Reorient mesh axes → RadSim volume axes (x=lateral, y=palmar, z=long/fingertips).
  4. Materials: cortical/trabecular bone + soft-tissue envelope (muscle/fat/skin).
  5. Write <out>/hand.mat.bin + hand.model.json + hand.glb via build_model.write_model.

CLI:
  ./.venv/Scripts/python.exe -m app.build_hand \
      --glb data/hand/hand_bones.glb \
      --out ../../apps/web/public/models/hand --spacing 0.5
"""
from __future__ import annotations

import argparse
import json
import struct

import numpy as np
import trimesh
from scipy import ndimage as ndi

from .build_model import (AIR, FAT, MUSCLE, SOFT, TRABECULAR, CORTICAL, SKIN,
                          LEGEND, write_model)

SOURCE = ("Scan the World · 'Hand bones' CT scan of a human hand "
          "(Zenodo 10.5281/zenodo.21244925, CC BY-NC-SA 4.0); soft-tissue envelope "
          "derived morphologically from the scanned skeleton")


def load_draco_glb(path: str):
    """Decode the single Draco-compressed primitive of a .glb → (vertices, faces)."""
    import DracoPy
    with open(path, 'rb') as f:
        struct.unpack('<III', f.read(12))                       # magic, version, length
        clen, _ = struct.unpack('<II', f.read(8))
        js = json.loads(f.read(clen).decode('utf-8'))
        blen, _ = struct.unpack('<II', f.read(8))
        bin_ = f.read(blen)
    prim = js['meshes'][0]['primitives'][0]
    ext = prim.get('extensions', {}).get('KHR_draco_mesh_compression')
    if ext is None:
        raise SystemExit('expected a KHR_draco_mesh_compression primitive')
    bv = js['bufferViews'][ext['bufferView']]
    off, ln = bv.get('byteOffset', 0), bv['byteLength']
    m = DracoPy.decode(bin_[off:off + ln])
    return np.asarray(m.points, np.float64), np.asarray(m.faces, np.int64)


def pick_component(v, f, index: int):
    """Split the mesh and return the `index`-th largest connected component."""
    tm = trimesh.Trimesh(vertices=v, faces=f, process=True)
    comps = sorted(tm.split(only_watertight=False), key=lambda c: -len(c.vertices))
    print(f"      {len(comps)} components; sizes {[len(c.vertices) for c in comps[:4]]}")
    c = comps[index]
    print(f"      using #{index}: {len(c.vertices)} verts, extents {np.round(c.extents, 1)} mm, "
          f"watertight={c.is_watertight}")
    return c


def voxelize(mesh, spacing: float) -> np.ndarray:
    """Solid-fill voxelisation → bool array indexed [mesh_x, mesh_y, mesh_z]."""
    vg = mesh.voxelized(pitch=spacing)
    try:
        vg = vg.fill()
    except Exception as e:                                       # non-manifold fallback
        print(f"      ! fill failed ({e}); using the surface hull instead")
        vg = vg.hollow()
    vol = np.asarray(vg.matrix, dtype=bool)
    print(f"      voxel grid {vol.shape} ({vol.sum() / 1e6:.2f} M bone voxels)")
    return vol


def to_volume_axes(vol: np.ndarray, flip=(0, 0, 0)) -> np.ndarray:
    """Mesh axes → RadSim volume axes.

    The scanned hand lies with mesh x = radioulnar (across the hand), y = proximodistal
    (long axis), z = dorsopalmar (thickness). RadSim stores [z, y, x] where volume
    x = lateral, y = palmar/AP (posterior-ward), z = long axis toward the fingertips.
    So volume[z,y,x] = mesh[x, z_long=y, y_ap=z] → transpose (1, 2, 0).
    `flip` negates the volume (z, y, x) axes so the fingertips / palmar side / handedness
    can be corrected without re-voxelising.
    """
    out = np.transpose(vol, (1, 2, 0))
    if flip[0]:
        out = out[::-1, :, :]
    if flip[1]:
        out = out[:, ::-1, :]
    if flip[2]:
        out = out[:, :, ::-1]
    return np.ascontiguousarray(out)


def build_materials(bone: np.ndarray, spacing: float,
                    soft_mm=4.5, close_mm=8.0, skin_mm=1.0, fat_mm=2.0, muscle_mm=4.0):
    """Bone mask → full material volume.

    Soft tissue is grown from the skeleton: a `soft_mm` dilation wraps every bone, then a
    `close_mm` closing bridges the gaps between neighbouring bones — which merges the
    metacarpals into a palm (with webbing) while leaving the spread fingers separate,
    exactly like a real hand outline. The envelope is then layered by depth:
    skin shell → subcutaneous fat → intrinsic muscle in the thick palm → soft tissue.
    Bone is split into a cortical shell and a trabecular core by depth as well.
    """
    r = lambda mm: max(1, int(round(mm / spacing)))

    print("      growing the soft-tissue envelope …")
    soft = ndi.binary_dilation(bone, iterations=r(soft_mm))
    soft = ndi.binary_closing(soft, iterations=r(close_mm))
    soft = ndi.binary_fill_holes(soft)
    soft |= bone                                                  # never carve into bone

    # depth of every soft-tissue voxel below the skin surface (mm)
    depth = ndi.distance_transform_edt(soft, sampling=spacing)

    mat = np.full(bone.shape, AIR, dtype=np.uint8)
    mat[soft] = SOFT
    mat[soft & (depth > muscle_mm)] = MUSCLE                      # thenar / hypothenar / interossei
    mat[soft & (depth <= fat_mm)] = FAT                           # subcutaneous layer
    mat[soft & (depth <= skin_mm)] = SKIN                         # thin skin shell

    # bone: cortical shell (outer ~1 mm) over a trabecular core — phalanges are almost all
    # cortex, the carpals mostly trabecular, which falls out of the same depth rule
    bdepth = ndi.distance_transform_edt(bone, sampling=spacing)
    mat[bone] = CORTICAL
    mat[bone & (bdepth > 1.2)] = TRABECULAR

    for nm, m in (('skin', SKIN), ('fat', FAT), ('muscle', MUSCLE), ('soft', SOFT),
                  ('cortical', CORTICAL), ('trabecular', TRABECULAR)):
        print(f"        {nm:11s} {int((mat == m).sum()):>9d}")
    return mat


def synth_hu(mat: np.ndarray) -> np.ndarray:
    """Nominal HU per material — only used for the header's huReference range."""
    hu = np.full(mat.shape, -1000, dtype=np.int16)
    for (i, _nm, h, _c) in LEGEND:
        if h is not None:
            hu[mat == i] = h
    return hu


def build(glb, out_dir, name, title, spacing, component, flip, mesh, source):
    print(f"[1/4] decoding {glb} …")
    v, f = load_draco_glb(glb)
    print(f"      {len(v)} verts / {len(f)} faces")
    comp = pick_component(v, f, component)

    print(f"[2/4] voxelising at {spacing} mm …")
    bone = voxelize(comp, spacing)
    bone = to_volume_axes(bone, flip)
    print(f"      volume axes {bone.shape} (z,y,x); flip={tuple(int(x) for x in flip)}")

    print("[3/4] materials …")
    mat = build_materials(bone, spacing)

    # tight crop with a small air margin so the model is not padded with empty space
    zs, ys, xs = np.where(mat > AIR)
    pad = max(1, int(round(2.0 / spacing)))
    sl = (slice(max(0, zs.min() - pad), min(mat.shape[0], zs.max() + pad + 1)),
          slice(max(0, ys.min() - pad), min(mat.shape[1], ys.max() + pad + 1)),
          slice(max(0, xs.min() - pad), min(mat.shape[2], xs.max() + pad + 1)))
    mat = np.ascontiguousarray(mat[sl])

    print("[4/4] writing volume …")
    write_model(out_dir, name, title, mat, synth_hu(mat), spacing, mesh, source)
    ext = [round(s * spacing, 1) for s in mat.shape[::-1]]
    print(f"done -> {out_dir}   extent {ext[0]} x {ext[1]} x {ext[2]} mm (x,y,z)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", required=True, help="Draco .glb of the CT hand skeleton")
    ap.add_argument("--out", required=True)
    ap.add_argument("--name", default="hand")
    ap.add_argument("--title", default="Hand")
    ap.add_argument("--spacing", type=float, default=0.5)
    ap.add_argument("--component", type=int, default=0, help="which hand (0 = largest)")
    ap.add_argument("--flip", type=int, nargs=3, default=(0, 0, 0), metavar=("Z", "Y", "X"),
                    help="negate volume axes (z=long, y=palmar, x=lateral)")
    ap.add_argument("--no-mesh", action="store_true")
    ap.add_argument("--source", default=SOURCE)
    a = ap.parse_args()
    build(a.glb, a.out, a.name, a.title, a.spacing, a.component, a.flip,
          mesh=not a.no_mesh, source=a.source)
