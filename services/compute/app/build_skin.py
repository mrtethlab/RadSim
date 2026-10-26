"""Smooth, lifelike skin surfaces for the body models — the hand's method, for the rest.

    python -m app.build_skin                 # every body model
    python -m app.build_skin chest headneck  # just these

Why: the generic display mesh (build_model._build_mesh) is marching cubes on a 0/1 tissue mask
at a coarse step, with no smoothing, so the voxel staircase is baked into the skin: it reads as a
blocky, scaly shell. The hand was rebuilt in commit c60abff with a blurred occupancy field,
marching cubes on that soft field, Taubin smoothing and one opaque skin tone, and it looks like a
hand. This applies the same to the other models, from the shipped voxel volume (no source CT is
needed), and writes <name>_skin.glb next to it. The header's skinMesh points the app at it; the
app shows the skin mesh in place of the plain one (app.js applyPhotoSkin). Physics never reads
either mesh.

Same vertex convention as the generic mesh: millimetres, x from the fastest axis, centred on
the volume — so the skin sits exactly where the old shell did.
"""
import json, pathlib, sys
import numpy as np
from scipy import ndimage as ndi

ROOT = pathlib.Path(__file__).resolve().parents[3]
MODELS = ROOT / 'apps' / 'web' / 'public' / 'models'
BODY_MODELS = ['chest', 'chestabdopelvis', 'lumbopelvis', 'headneck', 'skull', 'upperextremity',
               'lowerextremity', 'wholebody']
NOT_BODY = {0, 24, 25, 26, 27, 28}          # air, metals, acrylic: not skin
# the hand's photographic skin, averaged (its COLOR_0 is already LINEAR, as glTF requires; an sRGB
# tone written as-is renders pale and takes the room's cyan light, which made the first build grey)
# Brightened by about a third: a hand sits inside the collimator lamp's pool of light, a trunk is
# mostly outside it in the dimmed room, and at the hand's own value it read dark brown there.
SKIN_RGBA = (212, 118, 78, 255)


def build(name, smooth_mm=None, tri_mm=2.6):
    import trimesh
    from skimage import measure
    hdr_path = MODELS / name / f'{name}.model.json'
    h = json.loads(hdr_path.read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    sp = np.array(h['spacing'], float)                      # mm
    if not np.allclose(sp, sp[0]):
        raise SystemExit(f'{name}: anisotropic spacing {sp} is not handled')
    s = float(sp[0])
    mat = np.fromfile(MODELS / name / f'{name}.mat.bin', dtype=np.uint8).reshape(nz, ny, nx)
    body = ~np.isin(mat, list(NOT_BODY))
    # only the patient: the largest piece (a CT can carry cables, a sliver of a neighbouring limb)
    lab, n = ndi.label(body)
    if n > 1:
        sizes = ndi.sum(body, lab, range(1, n + 1))
        body = lab == (int(np.argmax(sizes)) + 1)
    body = ndi.binary_fill_holes(body)
    # a blur of about a voxel and a half smooths the staircase without melting fingers and ears
    sigma_mm = smooth_mm if smooth_mm else max(1.4, 1.1 * s)
    pad = 3
    field = ndi.gaussian_filter(np.pad(body, pad).astype(np.float32), sigma=sigma_mm / s)
    # ~2.6 mm triangles, rounded UP: at 2 mm voxels one step meant 600k-1.1M faces (12-23 MB) for
    # a trunk, and two (4 mm, then smoothed) is indistinguishable at the distance it is viewed
    step = max(1, int(np.ceil(tri_mm / s - 0.25)))
    verts, faces, _, _ = measure.marching_cubes(field, level=0.5, step_size=step)
    verts = verts - pad
    centre = np.array([nx, ny, nz]) * s / 2.0
    v = np.column_stack([verts[:, 2], verts[:, 1], verts[:, 0]]) * s - centre
    mesh = trimesh.Trimesh(vertices=v, faces=faces, process=True)
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()
    mesh = trimesh.smoothing.filter_taubin(mesh, lamb=0.55, nu=-0.58, iterations=14)
    mesh.visual.vertex_colors = np.tile(np.array(SKIN_RGBA, np.uint8), (len(mesh.vertices), 1))
    out = MODELS / name / f'{name}_skin.glb'
    scene = trimesh.Scene(); scene.add_geometry(mesh); scene.export(str(out))
    # point the header at it (display-only; physics ignores it) by inserting the one key, so the
    # header is otherwise left byte-for-byte as it was
    txt = hdr_path.read_text(encoding='utf-8')
    if '"skinMesh"' not in txt:
        key = f'"mesh": "{h["mesh"]}"'
        if key not in txt:
            raise SystemExit(f'{name}: cannot find {key} in the header')
        line = next(l for l in txt.splitlines() if key in l)
        indent = line[:len(line) - len(line.lstrip())]
        txt = txt.replace(key, key + f',\n{indent}"skinMesh": "{out.name}"', 1)
        hdr_path.write_text(txt, encoding='utf-8')
    print(f'{name:22s} {len(mesh.faces):8d} faces  sigma {sigma_mm:.1f} mm  step {step}  '
          f'{out.stat().st_size / 1e6:5.1f} MB')


if __name__ == '__main__':
    for name in (sys.argv[1:] or BODY_MODELS):
        build(name)
