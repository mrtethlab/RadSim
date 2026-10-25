"""Open the JOINT SPACES of a CT-derived model, so a radiograph taken in the right position shows
each joint as a clear gap.

Why. A joint's cartilage space is 1-5 mm. On a 1-1.5 mm CT grid it is two or three voxels whose HU
partial-volume averages cartilage with the subchondral bone either side (150-400 HU), and the HU
thresholds that make our materials call that bone (trabecular from 120 HU). So on every film the
joint read closed: the ankle's mortise, the knee, the elbow, a cervical facet, C1 on C2.

How. Not by segmenting bones: a postmortem CT's joints are too tight for a threshold to part them
(the leg's bones stay one piece at 300 HU, eroded). A joint is found as what it is on the CT: a thin
DARK SHEET with dense bone on BOTH sides. The Hessian of the smoothed HU marks sheets (one strong
positive curvature, across the sheet; little along it); each candidate is then checked along that
direction: bone at least BONE_HU a couple of millimetres to either side, and the centre clearly
darker. That second test is what tells a joint from the inside of a cortex, where the marrow is
dark on one side only. The sheet is the joint's mid-surface; the gap is cut to a width either side
of it (cut_gap), filled with cartilage, through the bone only.

Every model is posed or cropped after its materials are made, so the sheet is kept as a mask that
follows the model through those steps (a uint8 volume like the materials), and the gap is cut on
the final grid.
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage as ndi

BONE_HU = 350.0          # each side of a joint: its subchondral plate at least this dense
DROP_HU = 130.0          # and the joint's centre this much darker than the lesser side
SIDE_MM = (1.0, 1.5, 2.0)  # each side's plate: the densest of these, mm out from the voxel. A joint can be
                           # two voxels wide (from one of them, 1 mm out is the other), and a plate is
                           # ~1 mm thick, with cancellous bone (~300 HU) behind it (the ankle of z053)
DEEP_MM, DEEP_HU = (3.0, 6.0), 100.0   # and further in, still bone either side: a shaft's marrow canal
                                # is dark between two cortices too, but a few mm out it is in soft
                                # tissue (a fibula's or a metatarsal's by 6 mm), where a joint's two
                                # bones carry on in cancellous bone


def joint_sheets(hu, sp, sigma_mm=0.4, within=None, chunk=400_000):
    """The joint mid-surfaces of an HU volume [z, y, x] (sp mm voxels), as a bool mask. `within`
    restricts the search (the part's own body)."""
    g = ndi.gaussian_filter(hu.astype(np.float32), sigma_mm / sp)
    # candidates: inside the bone's closed envelope, not itself dense bone
    bone = g >= BONE_HU
    env = ndi.binary_closing(bone, structure=np.ones((3, 3, 3)), iterations=max(1, int(round(2.5 / sp))))
    cand = env & (g < BONE_HU + 100)
    if within is not None:
        cand &= within
    idx = np.nonzero(cand)
    # the Hessian at the candidates (second differences of the smoothed HU)
    H = np.empty((len(idx[0]), 3, 3), np.float32)
    grads = np.gradient(g)
    for a in range(3):
        ga = np.gradient(grads[a])
        for b in range(a, 3):
            H[:, a, b] = H[:, b, a] = ga[b][idx]
    del grads
    out = np.zeros(hu.shape, bool)
    P = np.stack(idx, 1).astype(np.float32)
    for s in range(0, len(P), chunk):
        w, V = np.linalg.eigh(H[s:s + chunk])
        l1, v1 = w[:, 2], V[:, :, 2]                     # the strongest positive curvature, its axis
        sheet = (l1 > 0) & (l1 > 2.0 * np.abs(w[:, 1])) & (l1 > 2.0 * np.abs(w[:, 0]))
        p = P[s:s + chunk]
        c = g[tuple(p.T.astype(int))]
        ok = sheet.copy()
        lo = hi = None
        for d in SIDE_MM:
            off = v1 * (d / sp)
            a_ = ndi.map_coordinates(g, (p - off).T, order=1, mode='nearest')
            b_ = ndi.map_coordinates(g, (p + off).T, order=1, mode='nearest')
            lo = a_ if lo is None else np.maximum(lo, a_)
            hi = b_ if hi is None else np.maximum(hi, b_)
        side = np.minimum(lo, hi)
        ok &= (side >= BONE_HU) & (c <= side - DROP_HU)
        for d in DEEP_MM:
            off = v1 * (d / sp)
            ok &= ndi.map_coordinates(g, (p - off).T, order=1, mode='nearest') >= DEEP_HU
            ok &= ndi.map_coordinates(g, (p + off).T, order=1, mode='nearest') >= DEEP_HU
        keep = tuple(p[ok].T.astype(int))
        out[keep] = True
    # a joint is a surface, not a speck: drop pieces under ~40 mm^2
    lab, n = ndi.label(out, structure=np.ones((3, 3, 3)))
    if n:
        sz = np.bincount(lab.ravel())
        out = sz[lab] >= max(8, int(40.0 / (sp * sp)))
        out[lab == 0] = False
    return out


def label_sheets(lab, sp, pairs, reach_mm=3.0):
    """Where a CT has its bones labelled (TotalSegmentator: each vertebra, the skull), the joint
    between two neighbours is the surface midway between their labels, where both lie within
    reach_mm: a cervical facet, C1 on C2 (the lateral masses and the dens in the arch), the skull on
    C1, the uncovertebral joints. The labels part the bones where the HU alone cannot (a facet's
    cartilage at 1.5 mm reads as bone). A disc is wider than twice the reach, and only soft tissue
    either way. Returns the mid-surfaces as a bool mask."""
    out = np.zeros(lab.shape, bool)
    r = int(np.ceil(reach_mm / sp)) + 1
    for a, b in pairs:
        ma, mb = lab == a, lab == b
        if not ma.any() or not mb.any():
            continue
        both = np.nonzero(ndi.binary_dilation(ma, iterations=r) & ndi.binary_dilation(mb, iterations=r))
        if not len(both[0]):
            continue
        box = tuple(slice(max(0, v.min() - r), v.max() + r + 1) for v in both)
        da = ndi.distance_transform_edt(~ma[box], sampling=sp)
        db = ndi.distance_transform_edt(~mb[box], sampling=sp)
        out[box] |= (da <= reach_mm) & (db <= reach_mm) & (np.abs(da - db) <= sp)
    return out


def long_bone_labels(hu, mat, seeds, region, sigma_mm=1.0, sp=1.5):
    """Label a limb's bones where its CT's joints are too tight for joint_sheets (an elbow at 1.5 mm:
    each joint one voxel, the plates either side a voxel too). Each bone is seeded on its shaft, well
    away from the joint, and flooded over the smoothed HU from the bright bone inward, so neighbouring
    floods meet in the dark valley between them: the joint's cartilage. seeds: {label: [(z0, z1), ...]}
    slice ranges and, per range, which of the slice's bone islands (followed slice to slice by overlap,
    as forearm bones cross: 'largest', or 'pair' for two islands labelled by their x order at z0).
    Returns the label volume (0 outside the region)."""
    from skimage.segmentation import watershed
    g = ndi.gaussian_filter(hu.astype(np.float32), sigma_mm / sp)
    bone = (g >= 150) & (mat > 0)
    lab, n = ndi.label(bone)
    sz = np.bincount(lab.ravel()); sz[0] = 0
    limb = lab == np.argmax(sz)
    mk = np.zeros(hu.shape, np.int32)
    for spec in seeds:
        (z0, z1), kind, ids_ = spec
        prev = None
        for z in range(z0, z1):
            l, k = ndi.label(limb[z])
            if not k:
                continue
            s = ndi.sum(np.ones_like(l), l, range(1, k + 1))
            order = [i + 1 for i in np.argsort(-np.asarray(s))]
            if kind == 'largest':
                mk[z][ndi.binary_erosion(l == order[0])] = ids_[0]
                continue
            two = order[:2]
            if len(two) < 2:
                break
            if prev is None:
                cs = [ndi.center_of_mass(l == i)[1] for i in two]
                asg = {two[int(np.argmin(cs))]: ids_[0], two[int(np.argmax(cs))]: ids_[1]}
            else:
                asg = {i: max(ids_, key=lambda t: int(((l == i) & (prev == t)).sum())) for i in two}
                if len(set(asg.values())) < 2:
                    break
            cur = np.zeros_like(l)
            for i, t in asg.items():
                cur[l == i] = t
                mk[z][ndi.binary_erosion(l == i)] = t
            prev = cur
    reg = np.zeros(hu.shape, bool); reg[region[0]:region[1]] = True
    return watershed(-g, mk, mask=limb & reg)


def cut_gap(mat, sheet, sp, gap_mm, bone_ids, fill):
    """Open the joints to gap_mm: every bone voxel within half the gap of a joint's mid-surface
    becomes `fill` (cartilage). Returns the number of voxels opened."""
    near = ndi.distance_transform_edt(~sheet, sampling=sp) <= gap_mm / 2.0
    sel = near & np.isin(mat, bone_ids)
    mat[sel] = fill
    return int(sel.sum())


# ---------------------------------------------------------------- per model
# The sheets live beside the source data (not shipped): written when the model's materials are,
# posed with it by the bake (app.bake_pose), and cut into it last (open_model).
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
MODELS = ROOT / 'apps' / 'web' / 'public' / 'models'
SHEETS = pathlib.Path(__file__).resolve().parents[1] / 'data' / 'joints'
# the gap each model's joints are opened to, mm: a normal adult joint space, and never under two
# of the model's voxels (or it is a line no film resolves)
GAP_MM = {'lowerextremity': 3.0, 'upperextremity': 3.0, 'headneck': 4.5}
SHEET_ID = 250           # the sheets' mark inside a materials volume while the bake poses both at once


def sheet_path(name):
    return SHEETS / f'{name}.sheet.bin'


def save_sheet(name, hu, mat, sp, extra=None):
    """Find the joints on a model's own HU (same grid as its materials) and keep them for the cut;
    `extra`: more joint mid-surfaces (label_sheets)."""
    sheet = joint_sheets(hu, sp, within=mat > 0)
    if extra is not None:
        sheet |= extra
    SHEETS.mkdir(parents=True, exist_ok=True)
    sheet.astype(np.uint8).tofile(sheet_path(name))
    print(f'        joint sheets: {int(sheet.sum())} voxels ({name})')
    return sheet


def open_model(name, gap_mm=None):
    """Cut the joint spaces into the shipped model, from its kept sheets."""
    from app.build_model import CARTILAGE, TRABECULAR, CORTICAL, BONE_GRADES
    d = MODELS / name
    h = json.loads((d / f'{name}.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    mat = np.fromfile(d / f'{name}.mat.bin', np.uint8).reshape(nz, ny, nx)
    sheet = np.fromfile(sheet_path(name), np.uint8).reshape(nz, ny, nx) == 1
    sp = float(h['spacing'][0])
    g = gap_mm or GAP_MM.get(name, 3.0)
    bone_ids = [TRABECULAR, CORTICAL] + [b[0] for b in BONE_GRADES]
    n = cut_gap(mat, sheet, sp, g, bone_ids, CARTILAGE)
    mat.tofile(d / f'{name}.mat.bin')
    print(f'{name}: {n} voxels of joint opened to {g} mm')


def sheet_from_materials(name):
    """A model already built, and not rebuilt (the trunk models carry later passes: the GI study,
    the vessels): its sheets from the HU its materials stand for. The trunk's bone is graded in the
    CT's own density steps (build_model.BONE_GRADES), close enough to the HU for the test."""
    d = MODELS / name
    h = json.loads((d / f'{name}.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    mat = np.fromfile(d / f'{name}.mat.bin', np.uint8).reshape(nz, ny, nx)
    t = np.full(256, -1000, np.float32)
    for m in h['materials']:
        if m.get('hu') is not None:
            t[m['id']] = m['hu']
    sheet = joint_sheets(t[mat], float(h['spacing'][0]), within=mat > 0)
    SHEETS.mkdir(parents=True, exist_ok=True)
    sheet.astype(np.uint8).tofile(sheet_path(name))
    print(f'        joint sheets: {int(sheet.sum())} voxels ({name}, from its materials)')


if __name__ == '__main__':
    args = sys.argv[1:]
    if args and args[0] == '--from-materials':
        for nm in args[1:]:
            sheet_from_materials(nm)
            open_model(nm)
    else:
        for nm in args:
            open_model(nm)
