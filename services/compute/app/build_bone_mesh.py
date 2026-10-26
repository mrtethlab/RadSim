"""The bone-only display mesh of every body model: <name>_bone.glb, beside the skin.

    python -m app.build_bone_mesh                 # every body model with bone
    python -m app.build_bone_mesh hand foot       # some

The room can hide everything but the skeleton, to see where the bones are while positioning. That
view is only worth having if it is the SAME bones the film is traced through, so the surface is
cut from the shipped material volume itself, in the frame every other mesh of the model uses
(voxel centres at index * spacing less half the extent, as build_skin and build_model's display
mesh), at the volume's own resolution:
- the bone materials only (trabecular, cortical, the graded bone): not the joints' cartilage, so
  the joint spaces stay open as the film shows them, and not the costal or any other cartilage;
- metal implants (a hip prosthesis) as their own surface, since they are fixed to the bone;
- a blur of 0.6 voxel before the surface is found: it takes the staircase off a 1 mm grid and
  moves a flat face by nothing (the 0.5 level of a symmetric blur sits on the step's edge);
  then a light Taubin pass, which does not shrink.
The room bends it with the volume's own rigid rule for bone (core/jointPose.js forwardBone), so a
bent joint shows its bones where the film has them. Display only: the physics reads the volume.
"""
from __future__ import annotations

import json
import sys

import numpy as np
from scipy import ndimage as ndi

from app.build_model import TRABECULAR, CORTICAL, CARTILAGE, TITANIUM, STEEL, ALUMINUM, LEAD, BONE_GRADES
from app.build_limbs import MODELS
from app.bone_labels import labelled_bone

BONE = [TRABECULAR, CORTICAL] + [b[0] for b in BONE_GRADES]
METAL = [TITANIUM, STEEL, ALUMINUM, LEAD]
BODY = ['hand', 'foot', 'skull', 'lowerextremity', 'upperextremity', 'headneck', 'chest', 'chestabdopelvis',
        'wholebody', 'pediatric']
BONE_RGBA = (236, 228, 205, 255)          # an ivory, as the plain mesh's bone
# the triangles' size, mm: a hand's and a foot's small bones at 1 mm, the skull's (its sinus walls and foramina) at
# three of its 0.6 mm voxels, the limbs and the chest at 2
# (at the grid's own 1 mm a whole leg came to 1.2 M faces and 25 MB), the head and neck at 3 and the
# trunks on their 2 mm grids at 4 (at 2 they were 15-19 MB: a skeleton's worth of ribs and
# vertebrae, centimetres across). The surface is interpolated in the blurred field between samples,
# so it keeps within a fraction of a voxel of the bone at any of these.
EDGE_MM = {'hand': 1.0, 'foot': 1.0, 'skull': 1.8, 'headneck': 3.0, 'chestabdopelvis': 4.0, 'wholebody': 4.0, 'pediatric': 3.0}
METAL_RGBA = (154, 165, 176, 255)
SOLID = 0.3                               # the share of a bone's voxels inside its surface (masks)
CLOSE_MM = 2.0                            # the widest cortical gap bridged, each bone by itself


def surface(mask, s, step=1, sigma_vox=0.6, taubin=6):
    import trimesh
    from skimage import measure
    pad = 3
    field = ndi.gaussian_filter(np.pad(mask, pad).astype(np.float32), sigma=sigma_vox)
    verts, faces, _, _ = measure.marching_cubes(field, level=0.5, step_size=step)
    verts = verts - pad
    m = trimesh.Trimesh(vertices=np.column_stack([verts[:, 2], verts[:, 1], verts[:, 0]]) * s, faces=faces, process=True)
    m.update_faces(m.nondegenerate_faces())
    m.remove_unreferenced_vertices()
    if taubin:
        m = trimesh.smoothing.filter_taubin(m, lamb=0.5, nu=-0.53, iterations=taubin)
    return m


def close_pieces(mask, allowed, it, s):
    """A thin or porous cortex (a carpal's, a vertebral body's) leaves its marrow, labelled fat or
    soft tissue, open to the outside through gaps a voxel or two across, and the surface came out as
    lace. Each bone (a piece of 0.1 cm^3 or more) is closed by itself over `it` voxels, taking in the
    loose crumbs of its own lace, never into cartilage and never within a voxel of another bone, so
    no two bones are joined and a joint space stays as open as the film shows it; the marrow is
    then enclosed, and fill_holes fills it."""
    st = ndi.generate_binary_structure(3, 1)
    lab, n = ndi.label(mask)
    sizes = ndi.sum(mask, lab, range(1, n + 1)) * s ** 3
    big = np.zeros(n + 1, bool); big[1:] = sizes >= 100.0
    bones = big[lab]
    out = mask.copy()
    for k, sl in enumerate(ndi.find_objects(lab), start=1):
        if sl is None or not big[k]:
            continue
        sl = tuple(slice(max(0, a.start - it - 1), min(dim, a.stop + it + 1)) for a, dim in zip(sl, mask.shape))
        own = (lab[sl] == k) | (mask[sl] & ~bones[sl])
        others = ndi.binary_dilation(bones[sl] & (lab[sl] != k), structure=st)
        grown = ndi.binary_closing(np.pad(own, it + 1), structure=st, iterations=it)[(slice(it + 1, -it - 1),) * 3]
        out[sl] |= grown & allowed[sl] & ~others
    return out


def load(name):
    h = json.loads((MODELS / name / f'{name}.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    mat = np.fromfile(MODELS / name / f'{name}.mat.bin', dtype=np.uint8).reshape(nz, ny, nx)
    return h, mat, float(h['spacing'][0])


def masks(name, mat, s):
    """The voxels each surface is cut from: [(label, rgba, mask)]."""
    # a model made from a segmented CT keeps only its labelled bones (bone_labels.py): a contrast
    # CT's enhanced vessels and calcified walls are bone-dense but not bone
    keep = labelled_bone(name, mat)
    if keep is not None:
        print(f'{name}: labelled bone only ({int((np.isin(mat, BONE) & ~keep).sum())} bone-dense voxels off the bones left out)')
    out = []
    for ids, rgba, label in ((BONE, BONE_RGBA, 'bone'), (METAL, METAL_RGBA, 'metal')):
        mask = np.isin(mat, ids)
        if label == 'bone' and keep is not None:
            mask &= keep            # the segmentation's bones, not every voxel over 120 HU
        if mask.sum() < 50:
            continue
        # the outside of the bone is what the eye sees: a marrow cavity enclosed by its cortex,
        # and specks of bone-dense voxels loose in the soft tissue (calcification, noise), only
        # added surfaces no one could look at (a third of a trunk's faces)
        if label == 'bone':
            mask = close_pieces(mask, mat != CARTILAGE, max(1, round(CLOSE_MM / s)), s)
        mask = ndi.binary_fill_holes(mask)
        lab, n = ndi.label(mask)
        if n > 1:
            sizes = ndi.sum(mask, lab, range(1, n + 1))
            big = np.zeros(n + 1, bool); big[1:] = sizes * s ** 3 >= 100.0      # 0.1 cm^3
            if label == 'bone' and keep is None:
                # without a segmentation, what is bone-dense but not bone is told by its shape: a
                # body bag's fold, a tube or a calcified vessel is a sheet or a strand a voxel or two
                # thick, a bone (a sesamoid, a patella) is solid. Under SOLID of a piece's voxels
                # survive a one-voxel erosion: not bone (bones measured 0.33 and up, the strips 0.21
                # and under)
                inner = ndi.sum(ndi.binary_erosion(mask), lab, range(1, n + 1))
                big[1:] &= inner >= SOLID * sizes
            mask = big[lab]
        out.append((label, rgba, mask))
    return out


def build(name):
    import trimesh
    hdr_path = MODELS / name / f'{name}.model.json'
    h, mat, s = load(name)
    nx, ny, nz = h['dims']
    centre = np.array([nx, ny, nz]) * s / 2.0
    scene = trimesh.Scene()
    faces = 0
    for label, rgba, mask in masks(name, mat, s):
        m = surface(mask, s, step=max(1, round(EDGE_MM.get(name, 2.0) / s)))
        # and the crumbs the coarser triangles leave, specks of a few mm^3 (a 1 mm voxel is 1)
        parts = m.split(only_watertight=False)
        m = trimesh.util.concatenate([q for q in parts if abs(q.volume) >= 20.0])
        m.vertices -= centre
        m.visual.vertex_colors = np.tile(np.array(rgba, np.uint8), (len(m.vertices), 1))
        scene.add_geometry(m, node_name=label, geom_name=label)
        faces += len(m.faces)
    if not faces:
        print(f'{name}: no bone'); return
    out = MODELS / name / f'{name}_bone.glb'
    scene.export(str(out))
    # point the header at it by inserting the one key, the rest of the header left as it was
    txt = hdr_path.read_text(encoding='utf-8')
    if '"boneMesh"' not in txt:
        key = f'"mesh": "{h["mesh"]}"'
        line = next(l for l in txt.splitlines() if key in l)
        indent = line[:len(line) - len(line.lstrip())]
        txt = txt.replace(key, key + f',\n{indent}"boneMesh": "{out.name}"', 1)
        hdr_path.write_text(txt, encoding='utf-8')
    print(f'{name:20s} {faces:8d} faces  {out.stat().st_size / 1e6:5.1f} MB')


if __name__ == '__main__':
    for n in sys.argv[1:] or BODY:
        build(n)
