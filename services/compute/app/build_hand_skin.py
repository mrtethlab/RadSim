"""Wrap a photographic hand skin onto the RadSim voxel hand — DISPLAY ONLY.

The positioning view benefits from a lifelike hand, but the visible skin must not lie
about anatomy: a student aligns the tube to the knuckles and web spaces they can see,
and the radiograph is produced from the voxel bones underneath. A supplied photo-textured
hand is in its own pose (different thumb angle, different digit spacing), so pasting it
over our skeleton would put the joints in the wrong places.

This instead borrows only the TEXTURE:
  1. orient + scale the donor mesh to our hand's frame;
  2. thin-plate-spline warp it in the PA plane onto landmarks taken from OUR silhouette
     (per-digit centres at several levels + the hand outline), so each finger lands on
     the matching finger;
  3. SNAP every vertex to the nearest point on our own skin surface — after which the
     geometry IS ours to within a fraction of a millimetre, and only the UV/texture is
     inherited;
  4. export <name>_skin.glb next to the model.

The physics never sees this file: attenuation comes from <name>.mat.bin, and the app
treats the skin purely as a display mesh.

CLI:
  ./.venv/Scripts/python.exe -m app.build_hand_skin \
      --donor "…/Hy3D_textured_00009_.glb" \
      --model ../../apps/web/public/models/hand --name hand
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import trimesh
from scipy import ndimage as ndi
from scipy.interpolate import RBFInterpolator


def load_our_hand(model_dir, name):
    """Our voxel volume (for landmarks) + our skin mesh (for the final snap)."""
    hdr = json.load(open(os.path.join(model_dir, f'{name}.model.json')))
    nx, ny, nz = hdr['dims']
    sp = hdr['spacing'][0]
    mat = np.fromfile(os.path.join(model_dir, f'{name}.mat.bin'), dtype=np.uint8).reshape(nz, ny, nx)
    skin = trimesh.load(os.path.join(model_dir, f'{name}.glb'))
    skin = skin.to_geometry() if hasattr(skin, 'to_geometry') else skin
    return mat, sp, (nx, ny, nz), skin


def digit_landmarks(sil, sp, levels, origin_x=0.0, origin_z=0.0):
    """Ordered digit-blob centres at each z level of a PA silhouette -> [(x,z,digit,level)]."""
    out = []
    for f in levels:
        z = int(f * (sil.shape[0] - 1))
        lb, n = ndi.label(sil[z])
        cents = sorted(float(np.mean(np.where(lb == i)[0])) for i in range(1, n + 1))
        for d, cx in enumerate(cents):
            out.append((cx * sp + origin_x, z * sp + origin_z, d, f, n))
    return out


def tip_landmarks(sil, sp, from_frac=0.84):
    """The distal tip of each digit: label the silhouette above `from_frac` and take each
    component's most distal point. Pinning the tips keeps the donor's nails on our
    fingertips instead of being dragged onto the interphalangeal joints."""
    z0 = int(from_frac * (sil.shape[0] - 1))
    sub = sil[z0:]
    lb, n = ndi.label(sub)
    out = []
    for i in range(1, n + 1):
        zz, xx = np.where(lb == i)
        if zz.size < 20:
            continue
        k = np.argmax(zz)                                  # most distal voxel
        out.append((float(xx[k]) * sp, float(zz[k] + z0) * sp, float(np.mean(xx)) * sp))
    out.sort(key=lambda r: r[2])                           # order left -> right by centre
    return out


def donor_image(mesh):
    """The donor's base-colour atlas as an (h, w, 3) uint8 array."""
    m = mesh.visual.material
    im = getattr(m, 'baseColorTexture', None) or getattr(m, 'image', None)
    if im is None:
        raise SystemExit('donor mesh has no base-colour texture')
    return np.asarray(im.convert('RGB'), np.uint8)


def inpaint_colours(mesh, col, bad, grow=40, smooth=3):
    """Replace `bad` vertex colours by diffusing good ones across the mesh, then lightly
    smooth everything so the join is invisible."""
    import scipy.sparse as sps
    e = mesh.edges_unique
    n = len(col)
    A = sps.coo_matrix((np.ones(len(e) * 2), (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])),
                       shape=(n, n)).tocsr()
    deg = np.asarray(A.sum(axis=1)).ravel()
    deg[deg == 0] = 1
    c = col.copy()
    if bad.any():
        c[bad] = col[~bad].mean(axis=0) if (~bad).any() else 200.0
        for _ in range(grow):                      # diffuse only into the rejected region
            c[bad] = (A @ c)[bad] / deg[bad, None]
    for _ in range(smooth):                        # gentle overall blur hides the seam
        c = 0.5 * c + 0.5 * ((A @ c) / deg[:, None])
    return c


def build(donor_path, model_dir, name, snap=True):
    print('[1/5] loading …')
    mat, sp, (nx, ny, nz), our_skin = load_our_hand(model_dir, name)
    ours_sil = (mat > 0).any(axis=1)                       # (z, x) PA silhouette
    print(f'      our hand {nx}x{ny}x{nz} @ {sp} mm; skin mesh {len(our_skin.faces)} faces')

    donor = trimesh.load(donor_path)
    dmesh = donor.to_geometry() if hasattr(donor, 'to_geometry') else donor
    V = np.asarray(dmesh.vertices, np.float64)
    ext = V.max(0) - V.min(0)
    order = np.argsort(ext)                                # [thin, mid, long]
    V = V[:, [order[1], order[0], order[2]]]               # -> x=width, y=thickness, z=length
    V -= V.min(0)
    V *= (nz * sp) / (V[:, 2].max() - V[:, 2].min())       # match our length
    print(f'      donor {len(V)} verts, oriented extents {np.round(V.max(0)-V.min(0),1)} mm')

    # donor silhouette on the same grid so landmarks are comparable
    dm = trimesh.Trimesh(vertices=V, faces=dmesh.faces, process=False)
    vg = dm.voxelized(pitch=sp)
    try:
        vg = vg.fill()
    except Exception:
        pass
    dsil = np.transpose(np.asarray(vg.matrix, bool), (2, 1, 0)).any(axis=1)

    print('[2/5] landmarks …')
    levels = [0.58, 0.64, 0.70, 0.76, 0.82, 0.88, 0.93]
    ours_l = digit_landmarks(ours_sil, sp, levels)
    theirs_l = digit_landmarks(dsil, sp, levels)
    src, dst = [], []
    for (tx, tz, td, tf, tn) in theirs_l:                  # pair digits by index at matching levels
        for (ox, oz, od, of, on) in ours_l:
            if of == tf and od == td and on == tn:
                src.append([tx, tz]); dst.append([ox, oz])
                break
    # anchor the proximal hand + the outline corners so the warp stays well behaved
    for f in (0.02, 0.10, 0.20, 0.30, 0.42):
        z = int(f * (ours_sil.shape[0] - 1))
        for sil, acc in ((dsil, src), (ours_sil, dst)):
            row = np.where(sil[int(f * (sil.shape[0] - 1))])[0]
            if row.size:
                acc.append([row.min() * sp, z * sp]); acc.append([row.max() * sp, z * sp])
    # pin the fingertips so the nails land on our tips
    ot, tt = tip_landmarks(ours_sil, sp), tip_landmarks(dsil, sp)
    if len(ot) == len(tt):
        for (tx, tz, _), (ox, oz, _) in zip(tt, ot):
            src.append([tx, tz]); dst.append([ox, oz])
        print(f'      matched {len(ot)} digit tips')
    else:
        print(f'      ! tip counts differ (ours {len(ot)}, donor {len(tt)}) — tips not pinned')
    src, dst = np.array(src), np.array(dst)
    print(f'      {len(src)} correspondences (per-digit centres + tips + outline anchors)')

    # Map OUR surface into the donor's frame rather than deforming the donor onto ours.
    # Deforming the donor and snapping it flat leaves folds where two distant parts of its
    # UV layout land on the same patch of skin, which reads as banding and seams. Going the
    # other way keeps our geometry bit-for-bit — the joints and web spaces a student lines
    # the tube up on stay exactly where the voxel bones say they are — and only the colour
    # is borrowed.
    print('[3/5] inverse thin-plate-spline (our surface -> donor frame) …')
    inv = RBFInterpolator(dst, src, kernel='thin_plate_spline', smoothing=1.0)
    yscale = (ny * sp) / max(1e-6, V[:, 1].max() - V[:, 1].min())

    ours = our_skin.copy()
    ours.apply_translation(np.array([nx, ny, nz]) * sp / 2.0)       # centred -> volume coords
    P = np.asarray(ours.vertices, np.float64)
    Q = P.copy()
    Q[:, [0, 2]] = inv(P[:, [0, 2]])
    Q[:, 1] = (P[:, 1] - (ny * sp) / 2.0) / yscale + V[:, 1].mean()
    print(f'      our mesh {len(P)} verts -> donor frame')

    print('[4/5] sampling the donor texture …')
    img = donor_image(dmesh)
    uv = np.asarray(dmesh.visual.uv, np.float64)
    close, dist, tri = trimesh.proximity.closest_point(dm, Q)
    bary = trimesh.triangles.points_to_barycentric(dm.triangles[tri], close)
    tuv = (uv[dmesh.faces[tri]] * bary[:, :, None]).sum(axis=1)
    ih, iw = img.shape[:2]
    px = np.clip((tuv[:, 0] * (iw - 1)).round().astype(int), 0, iw - 1)
    py = np.clip(((1.0 - tuv[:, 1]) * (ih - 1)).round().astype(int), 0, ih - 1)
    col = img[py, px].astype(np.float64)
    print(f'      donor lookup: median {np.median(dist):.1f} mm, p90 {np.percentile(dist,90):.1f} mm')

    # Only the skin TONE is worth borrowing. The donor is a cut-off hand with heavy baked
    # shading, so samples land on its grey stump, its background, or — where the warp is off
    # by a finger width — in the near-black shadow between its fingers, which paints dark
    # stripes down ours. Reject anything that is not plausibly lit skin, grow the good colour
    # into the holes, and smooth: the scene lights supply the shading, the photo the hue.
    mx, mn = col.max(axis=1), col.min(axis=1)
    sat = (mx - mn) / np.maximum(mx, 1.0)
    lum = col @ np.array([0.299, 0.587, 0.114])
    med = np.median(lum)
    bad = ((dist > 6.0) | (sat < 0.15) | (sat > 0.55)
           | (lum < 0.70 * med) | (lum > 1.35 * med)
           | (col[:, 0] <= col[:, 1]))                 # skin is always red-dominant
    print(f'      rejected {bad.sum()} / {len(col)} verts (stump / background / baked shadow)')
    col = inpaint_colours(ours, col, bad, grow=60, smooth=40)
    # The warp is only good to about a finger width, so any fine detail transferred here is
    # in the wrong place — dark creases end up down the middle of a phalanx. Keep the
    # low-frequency hue only and hold the brightness near the median; the scene's lights,
    # not the photo, do the shading.
    lum = np.maximum(col @ np.array([0.299, 0.587, 0.114]), 1.0)
    med = np.median(lum)
    col *= (np.clip(lum, 0.90 * med, 1.08 * med) / lum)[:, None]
    col = np.clip(col, 0, 255)
    print(f'      mean skin colour rgb {col.mean(axis=0).round(0).astype(int)}')

    # glTF COLOR_0 is linear; the atlas is sRGB. Without this the hand renders bleached.
    lin = np.clip(col / 255.0, 0, 1) ** 2.2
    rgba = np.concatenate([(lin * 255).round().astype(np.uint8),
                           np.full((len(col), 1), 255, np.uint8)], axis=1)
    ours.visual = trimesh.visual.ColorVisuals(ours, vertex_colors=rgba)

    print('[5/5] exporting …')
    ours.apply_translation(-np.array([nx, ny, nz]) * sp / 2.0)   # back to centred, like <name>.glb
    out = os.path.join(model_dir, f'{name}_skin.glb')
    trimesh.Scene(ours).export(out)
    print(f'      wrote {out}  ({len(ours.faces)} faces, vertex-coloured from the photo)')

    hp = os.path.join(model_dir, f'{name}.model.json')
    hdr = json.load(open(hp))
    hdr['skinMesh'] = f'{name}_skin.glb'      # display-only overlay; physics ignores it
    json.dump(hdr, open(hp, 'w'), indent=2)
    print(f'      header: skinMesh = {name}_skin.glb')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--donor', required=True, help='photo-textured hand .glb')
    ap.add_argument('--model', required=True, help='model folder (holds <name>.mat.bin/.glb)')
    ap.add_argument('--name', default='hand')
    ap.add_argument('--no-snap', action='store_true')
    a = ap.parse_args()
    build(a.donor, a.model, a.name, snap=not a.no_snap)
