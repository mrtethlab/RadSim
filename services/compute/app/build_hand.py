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
import os
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


def fingertips_at_high_z(bone: np.ndarray) -> bool:
    """Which end of the long axis holds the fingertips.

    The digits are five separate bones in cross-section while the wrist end is the
    radius + ulna, so counting connected components per slice over each end band
    identifies the distal end without assuming the source mesh's axis direction.
    """
    nz = bone.shape[0]
    band = max(1, nz // 8)

    def comps(rng):
        n = 0
        for z in rng:
            if bone[z].any():
                n += ndi.label(bone[z])[1]
        return n

    lo, hi = comps(range(0, band)), comps(range(nz - band, nz))
    print(f"      slice-component count: low-z {lo}, high-z {hi}; "
          f"fingertips at {'high' if hi > lo else 'low'} z")
    return hi > lo


def build_materials(bone: np.ndarray, spacing: float,
                    soft_mm=5.0, palm_mm=9.5, close_mm=1.5, smooth_mm=1.4,
                    skin_mm=1.2, fat_mm=3.5, muscle_mm=6.0):
    """Bone mask → full material volume.

    Soft tissue is grown from the skeleton so the hand carries a real radiographic
    envelope — the reference PA hand shows fingertip pads well beyond the tufts, a
    broad palm, a full thenar eminence and concave web spaces:

      1. dilate every bone by `soft_mm` (fingers) blending up to `palm_mm` over the
         carpus/palm — the closely-spaced metacarpals merge into one palm on their own,
         while the spread digits keep the air gaps between them;
      2. a SMALL `close_mm` fills crevices only (a large one would web the fingers
         together into a mitten);
      3. blur the occupancy and re-threshold: this is what turns a knobbly per-bone
         "shrink-wrap" into one smooth organic surface with concave webbing.

    The envelope is then layered by depth: skin shell → subcutaneous fat → intrinsic
    muscle in the thick palm → soft tissue. Bone is split cortical-shell/trabecular-core.
    """
    r = lambda mm: max(1, int(round(mm / spacing)))

    print("      growing the soft-tissue envelope …")
    # thickness ramps from the digits (soft_mm) to the palm/wrist (palm_mm): the ramp runs
    # along the long axis (z), proximal = low z after the fingertip-up orientation fix
    nz = bone.shape[0]
    zs = np.where(bone.any(axis=(1, 2)))[0]
    z0, z1 = (zs.min(), zs.max()) if zs.size else (0, nz - 1)
    t = np.clip((np.arange(nz) - z0) / max(1, z1 - z0), 0, 1)      # 0 = wrist end, 1 = fingertips
    thick = palm_mm + (soft_mm - palm_mm) * np.clip((t - 0.40) / 0.30, 0, 1)

    # one distance transform, thresholded by the per-slice thickness → a smooth ramp
    dist = ndi.distance_transform_edt(~bone, sampling=spacing)
    soft = dist <= thick[:, None, None]
    soft = ndi.binary_closing(soft, iterations=r(close_mm))
    soft = ndi.binary_fill_holes(soft)

    occ = ndi.gaussian_filter(soft.astype(np.float32), sigma=smooth_mm / spacing)
    soft = occ > 0.45                                              # <0.5 keeps the bulk

    # --- keep the DIGITS separate ------------------------------------------------
    # Neighbouring fingers sit close enough that their (correct) ~5 mm margins meet and
    # merge into one blob, so each finger loses its own soft-tissue outline and the
    # phalanges read as bare bone floating in a grey mass. Split the envelope along the
    # watershed between digits: label the bones per digit (a small dilation chains each
    # finger's phalanges together while the spread digits stay apart), give every voxel
    # the label of its nearest bone, and carve where two labels meet. Applied only
    # DISTAL to the metacarpal heads — the palm must stay one solid mass.
    # Seed ONLY in the digit zone: below the MCP heads every bone is connected through the
    # carpus, so labelling the whole skeleton yields ONE group and separates nothing.
    # Chain each finger's phalanges along z ONLY (a 3x1x1 structuring element): that bridges
    # the interphalangeal joint gaps so one finger = one label, and being purely axial it can
    # never merge two side-by-side digits the way an isotropic dilation does.
    digit_zone = (t > 0.55)[:, None, None]
    zonly = np.zeros((3, 1, 1), bool); zonly[:, 0, 0] = True
    seeds = ndi.binary_dilation(bone & digit_zone, structure=zonly, iterations=r(4.0))
    lab, nlab = ndi.label(seeds)
    _, idx = ndi.distance_transform_edt(lab == 0, return_indices=True)
    owner = lab[idx[0], idx[1], idx[2]]
    ridge = ndi.maximum_filter(owner, size=3) != ndi.minimum_filter(owner, size=3)
    ridge = ndi.binary_dilation(ridge, iterations=1)                # ~1 mm visible cleft
    ridge &= (t > 0.58)[:, None, None]                              # digits only
    zc = int(z0 + 0.75 * (z1 - z0))                                 # a proximal-phalanx slice
    n_before = ndi.label(soft[zc])[1]
    soft &= ~ridge
    print(f"        digit split: {nlab} digit groups; soft blobs at the phalanges "
          f"{n_before} -> {ndi.label(soft[zc])[1]}")

    soft |= bone                                                   # never carve into bone
    soft = ndi.binary_fill_holes(soft)

    depth = ndi.distance_transform_edt(soft, sampling=spacing)     # mm below the skin surface

    mat = np.full(bone.shape, AIR, dtype=np.uint8)
    mat[soft] = SOFT
    mat[soft & (depth > muscle_mm)] = MUSCLE                       # thenar / hypothenar / interossei
    mat[soft & (depth <= fat_mm)] = FAT                            # subcutaneous layer
    mat[soft & (depth <= skin_mm)] = SKIN                          # thin skin shell

    # bone: cortical shell (outer ~1 mm) over a trabecular core — phalanges are almost all
    # cortex, the carpals mostly trabecular, which falls out of the same depth rule
    bdepth = ndi.distance_transform_edt(bone, sampling=spacing)
    mat[bone] = CORTICAL
    mat[bone & (bdepth > 1.2)] = TRABECULAR

    for nm, m in (('skin', SKIN), ('fat', FAT), ('muscle', MUSCLE), ('soft', SOFT),
                  ('cortical', CORTICAL), ('trabecular', TRABECULAR)):
        print(f"        {nm:11s} {int((mat == m).sum()):>9d}")
    return mat


def build_hand_mesh(mat: np.ndarray, spacing: float, path: str,
                    skin_rgba=(0xe6, 0xb4, 0x98, 255), smooth_mm=1.1):
    """Display mesh for the positioning view: ONE smooth, opaque, skin-toned surface.

    The generic body mesh (build_model._build_mesh) draws translucent skin over an
    independently-meshed skeleton, which on a hand reads as bones poking through a
    lumpy, decaying glove. Here the outer surface is meshed from a blurred occupancy
    field and Taubin-smoothed, then rendered opaque — a lifelike hand.
    """
    import trimesh
    from skimage import measure

    nz, ny, nx = mat.shape
    centre = np.array([nx, ny, nz]) * spacing / 2.0
    # pad with air so the isosurface closes at the fingertips/wrist instead of leaving
    # holes where the body would otherwise touch the array boundary
    pad = 3
    body = np.pad((mat > AIR), pad, mode='constant', constant_values=False)
    field = ndi.gaussian_filter(body.astype(np.float32), sigma=smooth_mm / spacing)
    verts, faces, _, _ = measure.marching_cubes(field, level=0.5, step_size=2)
    verts = verts - pad
    v = np.column_stack([verts[:, 2], verts[:, 1], verts[:, 0]]) * spacing - centre
    mesh = trimesh.Trimesh(vertices=v, faces=faces, process=True)
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()
    mesh = trimesh.smoothing.filter_taubin(mesh, lamb=0.55, nu=-0.58, iterations=14)
    mesh.visual.vertex_colors = np.tile(np.array(skin_rgba, np.uint8), (len(mesh.vertices), 1))
    scene = trimesh.Scene()
    scene.add_geometry(mesh)
    scene.export(path)
    print(f"      wrote {path}  ({len(mesh.faces)} faces, smooth opaque skin)")


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
    # the app hangs every subject superior-end-up and the plate arrow points at the
    # fingertips, so force fingertips to +z (this also anchors the palm/digit thickness ramp)
    if not fingertips_at_high_z(bone):
        bone = np.ascontiguousarray(bone[::-1, :, :])
        print("      flipped z so the fingertips are at +z")
    print(f"      volume axes {bone.shape} (z,y,x); flip={tuple(int(x) for x in flip)}")

    print("[3/4] materials …")
    # The voxel grid is exactly the BONE bounding box, so without a margin every
    # soft-tissue dilation was silently clipped at the array edge — the envelope could
    # not grow past the skeleton (no fingertip pads, no dorsal/palmar flesh). Pad first;
    # the tight crop below trims back to the real extent.
    margin = int(np.ceil(18.0 / spacing))
    bone = np.pad(bone, margin, mode='constant', constant_values=False)
    print(f"      padded by {margin} vox ({margin*spacing:.0f} mm) so soft tissue can grow: {bone.shape}")
    mat = build_materials(bone, spacing)

    # tight crop with a small air margin so the model is not padded with empty space
    zs, ys, xs = np.where(mat > AIR)
    pad = max(1, int(round(2.0 / spacing)))
    sl = (slice(max(0, zs.min() - pad), min(mat.shape[0], zs.max() + pad + 1)),
          slice(max(0, ys.min() - pad), min(mat.shape[1], ys.max() + pad + 1)),
          slice(max(0, xs.min() - pad), min(mat.shape[2], xs.max() + pad + 1)))
    mat = np.ascontiguousarray(mat[sl])

    print("[4/4] writing volume …")
    # mesh=False so write_model skips the generic translucent-skin-over-skeleton mesh;
    # the hand gets its own smooth opaque one, then the header is pointed back at it
    write_model(out_dir, name, title, mat, synth_hu(mat), spacing, False, source)
    if mesh:
        print("      building the smooth skin mesh …")
        build_hand_mesh(mat, spacing, os.path.join(out_dir, f"{name}.glb"))
        hdr_path = os.path.join(out_dir, f"{name}.model.json")
        with open(hdr_path) as f:
            hdr = json.load(f)
        hdr["mesh"] = f"{name}.glb"
        with open(hdr_path, "w") as f:
            json.dump(hdr, f, indent=2)
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
    # Default (0,1,1) = a 180 deg ROLL about the long axis (negating y AND x preserves
    # chirality). The source scan is stored palm-toward-low-y, and the app maps low-y
    # upward in x-ray mode, which would lay the hand palm-UP (an AP projection). Rolling
    # it puts the palm on the receptor = the standard PA hand. Verified from bone
    # landmarks: the low-y face carries the pisiform + scaphoid tubercle (palmar), the
    # high-y face the metacarpal ridges (dorsal).
    ap.add_argument("--flip", type=int, nargs=3, default=(0, 1, 1), metavar=("Z", "Y", "X"),
                    help="negate volume axes (z=long, y=palmar, x=lateral); "
                         "default 0 1 1 rolls the hand palm-down for PA")
    ap.add_argument("--no-mesh", action="store_true")
    ap.add_argument("--source", default=SOURCE)
    a = ap.parse_args()
    build(a.glb, a.out, a.name, a.title, a.spacing, a.component, a.flip,
          mesh=not a.no_mesh, source=a.source)
