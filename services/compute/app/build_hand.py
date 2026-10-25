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

from .build_model import (AIR, FAT, MUSCLE, SOFT, TRABECULAR, CORTICAL, SKIN, CARTILAGE,
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


# Trabecular morphometry MEASURED from a 20 um micro-CT capitate (app.trab_morphometry):
# KU Leuven "Multimodal CT Dataset of Cadaveric Wrist Joints", doi:10.48804/DWF4RG,
# CC BY-SA 4.0 — specimen 6, an 88-year-old female. Only these NUMBERS are used; no voxel
# of that scan is copied into the model, so what ships here is our own generated texture
# matched to real morphometry rather than a derivative of a share-alike scan (which could
# not be combined with this hand's CC BY-NC-SA source anyway).
#
# Being from an elderly donor, the bone is on the sparse side of young-adult reference.
TRAB = dict(bvtv=0.310,          # bone volume fraction of cancellous bone
            period_mm=0.962,     # Tb.Th + Tb.Sp: the repeat distance of the lattice
            tb_th_mm=0.334,      # mean chord through a trabecula
            tb_sp_mm=0.629)      # mean chord through the marrow space


def _solve_sigma(period_vox, bvtv, block=64, seed=3, iters=14):
    """Find the Gaussian sigma whose thresholded field repeats every `period_vox`.

    The texture is a thresholded Gaussian random field, which has exactly two knobs —
    smoothing length and threshold — and they map one-to-one onto the two measured
    quantities: the threshold is fixed by BV/TV, and sigma by the period. Rather than
    trusting an analytic relation between sigma and the post-threshold chord length,
    this measures the generated block with the SAME chord-length code used on the real
    micro-CT and bisects. Self-verifying, and cheap on a 64-voxel block.
    """
    from .trab_morphometry import chord_lengths
    rng = np.random.default_rng(seed)
    white = rng.standard_normal((block, block, block)).astype(np.float32)
    one = (1.0, 1.0, 1.0)

    def period_of(sig):
        blk = ndi.gaussian_filter(white, sigma=sig, mode='wrap')
        m = blk > float(np.quantile(blk, 1.0 - bvtv))
        _, th = chord_lengths(m, one)
        _, sp = chord_lengths(~m, one)
        return th + sp

    lo, hi = 0.35, 10.0
    if period_of(lo) >= period_vox:
        return lo, period_of(lo)            # grid too coarse to carry the real period
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        if period_of(mid) < period_vox:
            lo = mid
        else:
            hi = mid
    sig = 0.5 * (lo + hi)
    return sig, period_of(sig)


def _trab_texture(shape, spacing, seed=7, block=96):
    """A tiled, band-limited random field reproducing the measured trabecular lattice.

    Generated as one small periodic block and tiled rather than drawn at full size: a
    0.25 mm hand is 162 M voxels, and a float32 noise field that big costs 650 MB for
    something whose whole point is to look random. The block wraps seamlessly (the blur
    uses mode='wrap').

    The length scale is in MILLIMETRES, taken from the micro-CT. That is the correction
    that matters: trabecular spacing is a property of bone, not of our grid, so a finer
    rebuild must resolve the SAME lattice better rather than inventing a finer one.
    """
    period_vox = TRAB['period_mm'] / spacing
    sigma, got = _solve_sigma(period_vox, TRAB['bvtv'], block=min(block, 64), seed=seed)
    print(f"        trabeculae: target period {TRAB['period_mm']:.2f} mm = "
          f"{period_vox:.1f} vox -> sigma {sigma:.2f}, achieved {got:.1f} vox "
          f"({got*spacing:.2f} mm)")
    # The floor is not Nyquist. Even UNSMOOTHED binary noise at fill p has a mean period of
    # 1/(1-p) + 1/p voxels — 4.7 at BV/TV 0.31 — so a grid coarser than that cannot produce
    # the real lattice at the real density however the field is filtered.
    p = TRAB['bvtv']
    floor = 1.0 / (1.0 - p) + 1.0 / p
    if period_vox < floor:
        print(f'        ! floor is {floor:.1f} vox at BV/TV {p:.2f}: {spacing} mm voxels '
              f'cannot carry a {TRAB["period_mm"]:.2f} mm lattice. Mean density is still '
              f'right, texture is {got*spacing/TRAB["period_mm"]:.1f}x too coarse '
              f'(would need <= {TRAB["period_mm"]/floor:.3f} mm voxels)')
    rng = np.random.default_rng(seed)
    blk = rng.standard_normal((block, block, block)).astype(np.float32)
    blk = ndi.gaussian_filter(blk, sigma=sigma, mode='wrap')
    keep = blk > float(np.quantile(blk, 1.0 - TRAB['bvtv']))
    nz, ny, nx = shape
    return keep[np.ix_(np.arange(nz) % block, np.arange(ny) % block, np.arange(nx) % block)]


def bone_architecture(mat: np.ndarray, bone: np.ndarray, spacing: float,
                      cort_shaft=1.25, cort_end=0.45, tube_r=4.6, seed=7):
    """Cortex, medullary canal and trabecular texture — written into `mat` in place.

    What makes a real hand film look sharp is the bone's INTERNAL architecture, not the
    detector: every metacarpal and phalanx is a TUBE — two bright cortical lines with a
    dark marrow canal between them — and the carpus is a mesh of trabeculae. Filling each
    bone with one uniform density (which is what a plain depth rule does) projects as a
    smooth white rod, and no amount of detector resolution can recover structure that was
    never in the phantom.

    Shaft and end are told apart by the bone's LOCAL half-width rather than by naming
    bones, so no per-bone labelling is needed (and the carpals, which touch, would defeat
    it anyway): a diaphysis is slender and carries THICK cortex around a canal, while an
    epiphysis or carpal is wide with THIN cortex over cancellous bone. Both fall out of
    one distance transform plus a maximum filter.
    """
    r = lambda mm: max(1, int(round(mm / spacing)))

    # Work on a tight crop around the skeleton. The full array is padded by 18 mm on every
    # side so soft tissue can grow into it, and scipy's EDT allocates a (3, *shape) float64
    # workspace — 10.5 GB at 0.2 mm on the padded grid, which is what made the fine build
    # run out of memory. Bone occupies a much smaller box, and a margin of a few voxels
    # past the widest filter keeps the interior values identical to the uncropped result.
    m = r(5.0) + 2
    zz, yy, xx = np.where(bone)
    sl = tuple(slice(max(0, v.min() - m), min(s, v.max() + m + 1))
               for v, s in zip((zz, yy, xx), bone.shape))
    del zz, yy, xx
    bone = bone[sl]
    sub = mat[sl]
    print(f'        bone crop {tuple(s.stop - s.start for s in sl)} '
          f'of {bone.shape if False else mat.shape}')

    bdepth = ndi.distance_transform_edt(bone, sampling=spacing).astype(np.float32)
    half = ndi.maximum_filter(bdepth, size=r(5.0))          # local half-width, mm

    # cortex tapers from thick on a slender shaft to thin over a wide end
    t = np.clip((half - 3.0) / max(1e-6, (tube_r + 1.5) - 3.0), 0, 1)
    cort = cort_shaft + (cort_end - cort_shaft) * t

    cortex = bone & (bdepth <= cort)
    interior = bone & ~cortex
    tubular = half < tube_r
    canal = interior & tubular                              # medullary cavity
    cancellous = interior & ~tubular

    del bdepth, half, t, cort, interior, tubular

    tex = _trab_texture(bone.shape, spacing, seed=seed)
    sub[cortex] = CORTICAL
    sub[canal] = FAT                                        # yellow marrow: the dark canal
    sub[cancellous] = FAT                                   # inter-trabecular marrow …
    # … around struts of CORTICAL, not TRABECULAR: a trabecula is made of ordinary dense
    # bone tissue, and the 300 HU "trabecular" value is the AVERAGE of struts and marrow.
    # Now that the marrow is modelled explicitly, using 300 HU for the struts would count
    # the marrow twice and leave the carpus far too lucent. At the measured BV/TV the mix
    # averages 0.31*1200 + 0.69*(-90) = 310 HU, i.e. back to the right mean density — but
    # now with the real lattice on top of it instead of a flat fill.
    sub[cancellous & tex] = CORTICAL

    tot = int(bone.sum())
    for nm, m in (('cortex', cortex), ('canal', canal), ('cancellous', cancellous)):
        print(f"        bone {nm:11s} {int(m.sum()):>9d}  ({100*m.sum()/max(1,tot):.0f} %)")


# The share of each ray that is metacarpal, from standard adult bone lengths (MC / MC + P1 + P2
# + P3; thumb MC1 / MC1 + P1 + P2): where the knuckle is, since the joint gaps are fused in this
# voxelisation and cannot be found on the bone. Checked against the PA projection: within 0.5 cm.
MC_SHARE = {'thumb': 0.47, 'index': 0.46, 'middle': 0.41, 'ring': 0.40, 'little': 0.44}
RAY_BASE_CM = 1.3       # a metacarpal base reaches this far below the first slice its shaft is alone
WEB_MM = 12.0           # the interdigital web reaches this far past the knuckle (a third of P1)

# THE FINGERS follow their bones, as on an adult PA: a finger about twice as wide as its bones
# (FINGER_SIDE x the phalanx's own width a side, never under 4.5 mm; this skeleton's phalanges
# are broad, 11 mm, and at 0.75 the fingers were 26 mm across and 16 deep, flat, where an
# adult's are about 20 and nearly round), so a finger keeps its own line; its sides run smooth, the dips
# between the joints filled over FINGER_HULL_MM (local_hull) — no waist at a shaft, no bump at
# a joint — and it only ever narrows toward the tip (taper_outward), to a round pad. (Straight
# tubes about each finger's axis were tried, and read as sausages.) In depth, the pads palmar and
# the nail and extensor hood dorsal, so the section is near round.
FINGER = {'palmar': 8.0, 'side': 4.5, 'dorsal': 4.5}
FINGER_SIDE = 0.45
FINGER_HULL_MM = 24.0
HULL_MM, HULL_STEP_MM = 16.0, 4.0       # the palm's stretch whose dips are filled, and its step
# THE PALM is thick on its palmar side (fat pad, palmar aponeurosis, flexor tendons, lumbricals,
# the thenar and hypothenar eminences) and thin over the dorsum (skin, the extensor tendons). Soft-
# tissue cover (mm, bone surface to skin) PALMAR, to the SIDES (on the PA), DORSAL.
PALM = {'palmar': 18.0, 'side': 10.0, 'dorsal': 6.0}
THENAR = {'palmar': 22.0, 'side': 11.0, 'dorsal': 6.0}             # the thumb's metacarpal
HYPOTHENAR = {'palmar': 20.0, 'side': 14.0, 'dorsal': 6.0}         # the little finger's
# The eminences lie over the metacarpal shafts and give way to the palm toward the knuckles:
# over the last EMINENCE_TAPER_MM before the first and fifth knuckles their cover eases to the
# palm's, so those knuckles round off like the second to fourth (carried to the heads, the
# eminences stood out as knobs beside them).
EMINENCE_TAPER_MM = 15.0
# The wrist and distal forearm: an oval in section, fuller than the bones (the pronator quadratus,
# the flexor and extensor tendons in their fat), its subcutaneous fat FOREARM_FAT_MM deep.
CARPUS = {'palmar': 15.0, 'side': 10.0, 'dorsal': 8.0}
FOREARM = {'palmar': 14.0, 'side': 12.0, 'dorsal': 10.0}
FOREARM_FAT_MM = 7.0
BORDER_PROUD_MM = 3.0   # the first and fifth rays' palmar face, at most this above the palm's


def hand_rays(bone: np.ndarray, spacing: float):
    """The five rays (metacarpal + phalanges) as labels, thumb first, and where the forearm ends.

    Above the carpus every slice cuts the five metacarpal shafts apart, so the bone above the
    first slice with five islands falls into five 3-D pieces, one a ray. The thumb is the one
    that reaches least far; the others are ordered across the hand from it. Returns
    (ray labels 1..5 over the bone, their names, the last forearm slice, the first slice of the
    metacarpal shafts)."""
    nz = bone.shape[0]
    count = np.array([ndi.label(bone[z])[1] for z in range(nz)])
    zs = np.where(bone.any(axis=(1, 2)))[0]
    z0, z1 = zs.min(), zs.max()
    # the forearm: the radius and ulna, two islands from the proximal end
    zf = z0
    while zf < z1 and count[zf] <= 2:
        zf += 1
    run = max(1, int(round(5.0 / spacing)))
    cut = next(z for z in range(zf, z1) if (count[z:z + run] >= 5).all())
    above = bone.copy()
    above[:cut] = False
    lab, n = ndi.label(above)
    sizes = ndi.sum(above, lab, range(1, n + 1))
    rays = []
    for k in np.argsort(-sizes)[:5] + 1:
        zz, yy, xx = np.nonzero(lab == k)
        rays.append((int(zz.max()), float(xx.mean()), float(yy.mean()), int(k)))
    thumb = min(rays)                                               # the shortest reach
    rest = sorted((q for q in rays if q is not thumb), key=lambda q: abs(q[1] - thumb[1]))
    out = np.zeros(bone.shape, np.uint8)
    for i, q in enumerate([thumb] + rest):
        out[lab == q[3]] = i + 1
    # the palm faces +y: the thumb lies palmar of the other metacarpals
    assert thumb[2] > np.mean([q[2] for q in rest]), 'the palm is not on +y: check the flips'
    return out, ['thumb', 'index', 'middle', 'ring', 'little'], zf, cut


def ray_frame(rays, i, name, spacing):
    """Ray i's voxels, its axis (toward the fingertip) and where its knuckle is: (zz, yy, xx, P mm,
    centre, axis, s mm along the axis from its proximal end, knuckle s).

    The knuckle (the MCP joint gap) is first placed by the bone proportions (MC_SHARE), then
    moved to the narrowest section of the ray from 8 mm before that to 4 mm after: between the
    metacarpal head and the base of the proximal phalanx the section dips where the two meet
    (measured: 1-4 mm proximal of the proportional estimate on the four fingers). A ray with no
    such dip (the thumb's section only narrows past its head) keeps the estimate."""
    zz, yy, xx = np.nonzero(rays == i + 1)
    P = np.c_[xx, yy, zz] * spacing
    c = P.mean(0)
    a = np.linalg.svd(P - c, full_matrices=False)[2][0]
    a = a * np.sign(a[2])
    s = (P - c) @ a
    s0 = s.min()
    s = s - s0
    base = RAY_BASE_CM * 10
    smcp = MC_SHARE[name] * (s.max() + base) - base
    b = np.round(s - smcp).astype(int)
    win = (b >= -8) & (b <= 4)
    area = np.bincount(b[win] + 8, minlength=13)
    k = int(np.argmin(area))
    if 0 < k < 12 and area[:k].max() > area[k] * 1.15 and area[k + 1:].max() > area[k] * 1.15:
        smcp += k - 8
    return zz, yy, xx, P, c, a, s, smcp


# ---------------------------------------------------------------- the joint spaces
# This skeleton was segmented from CT at a threshold that bridged every joint: the cartilage
# between two bones came out as bone, so the voxelised hand is one solid and a PA showed the
# joints closed. A PA hand's joints are its reading: every MCP, PIP and DIP, the intercarpal
# joints, the radiocarpal joint and the DRUJ open as a clear gap. So the gaps are cut back in,
# as the PA sees them: each joint surface is laid edge-on to a dorsopalmar beam (a curve on the
# hand's plane, carried through the hand's depth), as the cartilage space is on a true PA.
#
# THE DIGITS. Along each ray the joints are where the section pinches between a head and the
# next base. Each is first placed by standard phalanx lengths (P1, P2, P3; the thumb P1, P2,
# scaled to the ray past its knuckle), then moved to the narrowest section within 4 mm. The gap
# curves convex distally, the head's round seen on the PA.
# Typical adult phalanx lengths, mm (only their proportions are used: each ray is scaled to its own
# length, and every joint is then moved to its narrowest section).
PHALANX_MM = {'thumb': (31.0, 22.0), 'index': (40.0, 23.0, 16.0), 'middle': (45.0, 27.0, 18.0),
              'ring': (42.0, 26.0, 17.0), 'little': (33.0, 18.0, 16.0)}
# joint space on a normal adult PA, mm: wide enough to read on the default 0.75 mm film
GAP_MM = {'mcp': 2.0, 'pip': 1.7, 'dip': 1.5, 'ip': 1.7, 'carpus': 1.2}
# THE CARPUS fused into one block with no neck between its bones, so no shape rule parts them
# (a watershed on the distance map split the radius and merged the rows). On the PA, though,
# each carpal's rounded edge leaves a groove in the summed bone thickness: the dark lines of
# the carpal outlines, the radiocarpal joint and the DRUJ. Those valleys are found (a ridge
# filter for dark lines on the thickness map, skeletonised) and cut. This scan's own exceptions,
# mm on the bone frame (x, z): the hook of the hamate and the pisiform lie OVER the hamate and
# triquetrum, and the groove round each is an overlap, not a joint; the lines below 50 mm are
# the edges of cavities inside the radius and ulna.
CARPUS_OVERLAPS_MM = [((93.75, 78.0), 6.5), ((99.5, 64.5), 4.5)]
CARPUS_ABOVE_MM = 50.0
CARPUS_MIN_LINE_MM = 30.0


def digit_joints(bone, rays, names, spacing):
    """The gap voxels of the MCP, PIP and DIP joints (thumb: MCP, IP), and the joints found."""
    gaps = np.zeros(bone.shape, bool)
    found = []
    for i, nm in enumerate(names):
        zz, yy, xx, P, c, a, s, smcp = ray_frame(rays, i, nm, spacing)
        ph = PHALANX_MM[nm]
        k = (s.max() - smcp) / sum(ph)
        cuts = [('mcp', smcp)]
        at = smcp
        for j, ln in enumerate(ph[:-1]):
            at += ln * k
            cuts.append(('ip' if nm == 'thumb' else ('pip', 'dip')[j], at))
        b = np.round(s / spacing).astype(int)
        area = np.bincount(b, minlength=b.max() + 1).astype(float)
        area = ndi.uniform_filter1d(area, 3)
        for kind, s0 in cuts:
            if kind != 'mcp':                                   # (ray_frame has refined the knuckle)
                lo, hi = int((s0 - 4) / spacing), int((s0 + 4) / spacing)
                if 0 < lo < hi < len(area) - 1:
                    w = int(np.argmin(area[lo:hi + 1])) + lo
                    if area[max(0, w - 12):w].max() > 1.1 * area[w] and area[w + 1:w + 13].max() > 1.1 * area[w]:
                        s0 = w * spacing
            # the ray's line here, over the two bones either side (a short window is wider
            # than it is long, and its main axis would lie across the finger)
            Q = P[np.abs(s - s0) < 15.0][:, [0, 2]]             # the PA plane (x, z), mm
            cq = Q.mean(0)
            u = np.linalg.svd(Q - cq, full_matrices=False)[2][0]
            u = u * np.sign(u @ a[[0, 2]])                      # toward the fingertip
            w = np.array([-u[1], u[0]])
            J = P[np.abs(s - s0) < 1.0][:, [0, 2]].mean(0)
            Qj = P[np.abs(s - s0) < 3.0][:, [0, 2]]
            half = float(np.percentile(np.abs((Qj - Qj.mean(0)) @ w), 95))
            R = 1.8 * half                                      # the head's round on the PA
            q = P[:, [0, 2]] - J
            t = q @ w
            along = q @ u + t * t / (2 * R)
            g = GAP_MM[kind] / 2
            sel = (np.abs(along) <= g) & (np.abs(t) <= half + 1.5)
            gaps[zz[sel], yy[sel], xx[sel]] = True
            found.append((nm, kind, round(float(s0), 1)))
    return gaps, found


def carpal_joints(bone, rays, spacing):
    """The gap voxels of the intercarpal and radiocarpal joints and the DRUJ: the dark valleys of
    the carpus on the PA, cut through the hand's depth."""
    from skimage.filters import sato
    from skimage.morphology import skeletonize
    filled = ndi.binary_fill_holes(bone)
    t = filled.sum(axis=1).astype(np.float32) * spacing          # bone thickness on the PA, mm
    rest = (filled & (rays == 0)).any(axis=1)
    core = ndi.binary_erosion(rest, iterations=max(1, int(round(1.0 / spacing))))
    sig = [m / spacing for m in (0.5, 0.75, 1.0)]
    ridge = sato(t, sigmas=sig, black_ridges=True)
    v = (ridge > np.percentile(ridge[core], 80)) & core
    sk = skeletonize(v)
    nz, nx = sk.shape
    Z, X = np.mgrid[0:nz, 0:nx] * spacing
    for (cx, cz), r in CARPUS_OVERLAPS_MM:
        sk &= (X - cx) ** 2 + (Z - cz) ** 2 > r * r
    lab, n = ndi.label(sk, structure=np.ones((3, 3)))
    keep = np.zeros_like(sk)
    for k in range(1, n + 1):
        m = lab == k
        if m.sum() * spacing >= CARPUS_MIN_LINE_MM and Z[m].mean() > CARPUS_ABOVE_MM:
            keep |= m
    # the line smoothed (a skeleton steps pixel by pixel, and a cut along the steps reads as a
    # staircase), then opened to the gap's width
    # (a one-voxel line blurred by sigma keeps half its peak out to sigma*1.18 either side: with
    # sigma at 0.85 of the half-gap, the band is the gap wide)
    half = GAP_MM['carpus'] / 2
    line = ndi.gaussian_filter(keep.astype(np.float32), 0.85 * half / spacing)
    near = line >= 0.5 * float(np.median(line[keep]))
    return (near[:, None, :] & bone & (rays == 0)[:, :, :]), int(keep.sum())


def joint_spaces(bone, spacing):
    """Every joint gap of the PA hand, as voxel masks on the bone frame: (the digits', the
    carpus's)."""
    rays, names, zf, cut = hand_rays(bone, spacing)
    g1, found = digit_joints(bone, rays, names, spacing)
    g2, nline = carpal_joints(bone, rays, spacing)
    for nm in names:
        print('        ' + nm + ': ' + ', '.join(f'{k} {s} mm' for n_, k, s in found if n_ == nm))
    print(f'        carpus: {nline * spacing:.0f} mm of joint line')
    g1 &= bone
    g2 &= bone & ~g1
    print(f'        joint spaces: {int(g1.sum())} + {int(g2.sum())} voxels opened')
    return g1, g2


def local_hull(mask, axis2, spacing, length=HULL_MM, step=HULL_STEP_MM):
    """Fill the dips in a PA outline (z, x) along a direction: the union of the convex hulls of
    its stretches `length` long, every `step`, across `axis2` (a unit (x, z) vector). A dip
    narrower than the stretch is filled (a finger's waist between its joints, the palm's border
    between the metacarpal heads); the outline's own line and its bends over longer distances are
    kept, which one hull over the whole would straighten."""
    from skimage.morphology import convex_hull_image
    zz, xx = np.nonzero(mask)
    if not zz.size:
        return mask
    t = (xx * axis2[0] + zz * axis2[1]) * spacing
    out = mask.copy()
    for t0 in np.arange(t.min(), t.max() + step, step):
        sel = (t >= t0) & (t < t0 + length)
        if sel.sum() < 3:
            continue
        z0, z1, x0, x1 = zz[sel].min(), zz[sel].max() + 1, xx[sel].min(), xx[sel].max() + 1
        part = np.zeros((z1 - z0, x1 - x0), bool)
        part[zz[sel] - z0, xx[sel] - x0] = True
        try:
            out[z0:z1, x0:x1] |= convex_hull_image(part)
        except Exception:                                           # (a degenerate stretch)
            pass
    return out


def taper_outward(mask, axis2, t_from, spacing):
    """Never wider toward the tip: along the finger's axis (axis2, a unit (x, z) vector), each
    side of the outline is held to the narrowest it has been since `t_from` (mm along the axis,
    the knuckle). The wide bases of the middle and distal phalanges otherwise flared every
    finger out toward its tip."""
    zz, xx = np.nonzero(mask)
    if not zz.size:
        return mask
    t = (xx * axis2[0] + zz * axis2[1]) * spacing
    u = (xx * -axis2[1] + zz * axis2[0]) * spacing
    u0 = np.median(u[t > t_from])                                    # the finger's own line
    u = u - u0
    b = np.floor(t - t_from).astype(int)
    keep = np.ones(len(t), bool)
    past = b >= 0
    nb = b[past].max() + 1 if past.any() else 0
    for sgn in (1, -1):                                             # each side in turn
        w = np.full(nb, -np.inf)
        np.maximum.at(w, b[past], sgn * u[past])
        w = np.where(np.isfinite(w), w, np.inf)
        w = np.minimum.accumulate(w)                                # the narrowest so far
        keep[past] &= sgn * u[past] <= w[b[past]] + spacing
    out = np.zeros_like(mask)
    out[zz[keep], xx[keep]] = True
    return out


def oval_wrist(soft, bone, zcut, spacing, stop_mm=10.0, ease_mm=25.0, clear_mm=4.0):
    """The distal forearm and the wrist, slice by slice, as ovals.

    Grown on its bones the forearm was a dumbbell in section — the radius and the ulna each
    wrapped, with a waist between (they lie at different depths, so the palmar and dorsal
    surfaces followed each in turn) — and on the PA a rectangle. Each slice up to stop_mm below
    the metacarpal shafts (zcut: their bases, at the carpus) becomes the ellipse with the same
    area, orientation and spread as the slice's convex hull: the second moments of the hull fix
    the axes, scaled to hold its area. It is never closer than clear_mm to the bone. Over the
    last ease_mm the oval turns into the palm's section, their signed distances blended slice by
    slice (switched in one slice, the oval left a ledge across the palm on the PA and the
    lateral)."""
    from skimage.morphology import convex_hull_image
    ny, nx = soft.shape[1:]
    yy, xx = np.mgrid[0:ny, 0:nx].astype(np.float32)
    near = ndi.distance_transform_edt(~bone, sampling=spacing) <= clear_mm
    z_end = zcut - int(round(stop_mm / spacing))
    ease = int(round(ease_mm / spacing))
    sdf = lambda m: ndi.distance_transform_edt(~m) - ndi.distance_transform_edt(m)
    out = soft.copy()
    for z in range(z_end):
        sl = soft[z]
        if sl.sum() < 20:
            continue
        hull = convex_hull_image(sl)
        py, px = np.nonzero(hull)
        cy, cx = py.mean(), px.mean()
        cov = np.cov(np.vstack([py - cy, px - cx]))
        ev, evec = np.linalg.eigh(cov)
        # a uniform ellipse has variance a^2/4 along each semi-axis a
        a = 2 * np.sqrt(np.maximum(ev, 1e-6))
        a *= np.sqrt(hull.sum() / (np.pi * a[0] * a[1]))           # the hull's own area
        dy, dx = yy - cy, xx - cx
        u = (dy * evec[0, 0] + dx * evec[1, 0]) / a[0]
        v = (dy * evec[0, 1] + dx * evec[1, 1]) / a[1]
        oval = (u * u + v * v <= 1) | near[z]
        t = np.clip((z - (z_end - ease)) / ease, 0, 1)             # 0 an oval, 1 the palm
        out[z] = oval if t == 0 else ((1 - t) * sdf(oval) + t * sdf(sl) <= 0) | bone[z]
    return out


def build_materials(bone: np.ndarray, spacing: float, smooth_mm=1.4, skin_mm=1.2,
                    tendon_mm=2.0, fat_mm=4.5, gaps=None, crack=None):
    """Bone mask -> full material volume: an anatomical soft-tissue envelope.

    The envelope was a uniform shell grown on the bone (5 mm round every phalanx, 9.5 mm round
    the palm, as thick dorsally as palmar): the palm as thin in front as behind, and the fingers
    waisted at every shaft and bulging at every joint. The hand laid for a PA is a flattish
    thing, and is built as one:
      the OUTLINE on the PA plane: every bone grown by its side cover, with the dips filled
        (local_hull) — each finger along its own line, the palm, carpus and forearm along the
        hand — so the borders run straight or convex and the fingers taper without waists;
      the PALMAR and DORSAL surfaces: over every point of the outline, the bones below it plus
        their region's palmar and dorsal cover (the constants above), smoothed;
      the EDGES rounded: a finger's section is round, the palm's sides curve; between the digits
        the outline is split along a seam that deepens over the web.

    Layers, from the skin in: skin; subcutaneous fat (the finger pads and the palm's fat pad are
    fat); in the palm and the forearm, muscle beneath it (thenar, hypothenar, interossei,
    lumbricals; pronator quadratus and the flexors), never on the dorsum; and on the bone the
    tendons, sheaths and ligaments as soft tissue.
    """
    print("      the rays, the knuckles and each bone's cover …")
    nz, ny, nx = bone.shape
    rays, names, zf, zcut = hand_rays(bone, spacing)
    cover = {k: np.zeros(bone.shape, np.float32) for k in ('palmar', 'side', 'dorsal')}
    digit = np.zeros(bone.shape, np.float32)                        # 1 in a finger, 0 in the palm
    palm_region = np.zeros(bone.shape, bool)                        # where muscle may lie
    finger = np.zeros(bone.shape, np.uint8)                         # the ray, past its knuckle
    past = np.full(bone.shape, -np.inf, np.float32)                 # mm past the knuckle
    # the carpus and the forearm: the bone that is not a ray, by level (1 cm blend at the wrist)
    rest = bone & (rays == 0)
    r10 = max(1, int(round(10.0 / spacing)))
    fore = np.broadcast_to(np.clip((zf + r10 - np.arange(nz)) / r10, 0, 1)[:, None, None], bone.shape)
    for k in cover:
        cover[k][rest] = (FOREARM[k] * fore + CARPUS[k] * (1 - fore))[rest]
    palm_region |= rest
    axes = {}                                                       # each finger's line on the PA
    for i, nm in enumerate(names):
        zz, yy, xx, P, c, a, s, smcp = ray_frame(rays, i, nm, spacing)
        g = np.clip((s - smcp) / 12.0 + 0.5, 0, 1)                  # palm -> finger over 12 mm
        # the phalanx's width as the PA shows it (across the ray in the plane of the hand), taken
        # low over 18 mm: not the narrow contact at a joint, nor the wide ends either side of it
        bins = np.floor(s / 2.0).astype(int)
        nb = bins.max() + 1
        across = np.cross(a, [0.0, 1.0, 0.0])
        across /= np.linalg.norm(across)
        u = (P - c) @ across
        lo_, hi_ = np.full(nb, np.inf), np.full(nb, -np.inf)
        np.minimum.at(lo_, bins, u)
        np.maximum.at(hi_, bins, u)
        wpa = ndi.percentile_filter(np.where(np.isfinite(hi_ - lo_), hi_ - lo_ + spacing, 0), 35,
                                    size=9, mode='nearest')[bins]
        palm = PALM
        if nm in ('thumb', 'little'):
            emi = THENAR if nm == 'thumb' else HYPOTHENAR
            e = np.clip((smcp - s) / EMINENCE_TAPER_MM, 0, 1)      # 1 on the shaft, 0 at the knuckle
            palm = {k: e * emi[k] + (1 - e) * PALM[k] for k in PALM}
        fing = dict(FINGER, side=np.maximum(FINGER['side'], FINGER_SIDE * wpa))
        for k in cover:
            cover[k][zz, yy, xx] = g * fing[k] + (1 - g) * palm[k]
        digit[zz, yy, xx] = g
        palm_region[zz, yy, xx] = g < 0.5
        finger[zz, yy, xx] = np.where(s > smcp, i + 1, 0)
        past[zz, yy, xx] = s - smcp
        ax2 = a[[0, 2]] / np.linalg.norm(a[[0, 2]])
        # where the knuckle lies along the finger's line on the PA plane
        kn = (c + a * (smcp + ((P - c) @ a).min()))[[0, 2]]
        axes[i + 1] = (ax2, float(kn @ ax2))
        print(f"        {nm:7s} ray {s.max() / 10:4.1f} cm, knuckle {smcp / 10:4.1f} cm along it")
    ray2 = rays.max(axis=1)                                         # (z, x): the ray below, or 0
    del rays, rest

    print("      the outline, the surfaces, the edges …")
    ys = (np.arange(ny, dtype=np.float32) * spacing)[None, :, None]
    has = bone.any(axis=1)                                          # (z, x): bone in the column
    yp = np.where(bone, ys + cover['palmar'], -np.inf).max(axis=1)  # palmar skin, mm
    yd = np.where(bone, ys - cover['dorsal'], np.inf).min(axis=1)   # dorsal skin, mm
    ybp = np.where(bone, ys, -np.inf).max(axis=1)                   # the bone's palmar face
    ybd = np.where(bone, ys, np.inf).min(axis=1)
    side = np.where(bone, cover['side'], 0).max(axis=1)
    g2 = np.where(bone, digit, 0).max(axis=1)
    f2 = finger.max(axis=1)                                         # (z, x): the finger, or 0
    p2 = past.max(axis=1)
    del cover, finger, past
    d2, (jz, jx) = ndi.distance_transform_edt(~has, sampling=spacing, return_indices=True)
    grown = d2 <= side[jz, jx]                                      # every bone grown by its side cover
    # the dips filled: each finger along its own line, the palm, carpus and forearm along the hand
    owner = f2[jz, jx]
    foot = local_hull(grown & (owner == 0), np.array([0.0, 1.0]), spacing)
    for k, (ax2, tk) in axes.items():
        foot |= local_hull(grown & (owner == k), ax2, spacing, length=FINGER_HULL_MM)
    del grown
    foot = ndi.gaussian_filter(foot.astype(np.float32), 3.0 / spacing) > 0.5
    foot = ndi.binary_fill_holes(foot)                              # (the thumb web closed a pocket)
    # the DIGITS apart. Past its knuckle each finger's outline meets its neighbour's on a SEAM
    # (where the nearest finger changes). The seam deepens over the web: at the knuckle it is no
    # notch at all, WEB_MM on (the commissure, a third of the way along the proximal phalanx) the
    # fingers are apart, and between the two the tissue either side of it thins in proportion.
    # Splitting all at once at the web left a flat ledge there, and a line across every finger.
    seam = (ndi.maximum_filter(owner, size=3) != ndi.minimum_filter(owner, size=3)) & (owner > 0)
    web = np.clip(p2[jz, jx] / WEB_MM, 0, 1)                         # 0 at the knuckle, 1 past the web
    foot &= ~ndi.binary_dilation(seam & (web >= 1), iterations=1)
    # and each finger, now apart from its neighbours, only narrows from the web to its tip
    fingers = np.zeros_like(foot)
    for k, (ax2, tk) in axes.items():
        fingers |= taper_outward(foot & (owner == k), ax2, tk + WEB_MM, spacing)
    foot = (foot & (owner == 0)) | fingers
    del fingers
    seam_d, (qz, qx) = ndi.distance_transform_edt(~seam, sampling=spacing, return_indices=True)
    # how far split the nearest seam is, within the web only: past it the fingers are apart and
    # their sides are rounded as edges (below) — thinned for the seam as well, the sides facing
    # a neighbour came out half as thick, a dark rim along every crowded proximal phalanx
    seam_f = np.where(seam & (web < 1), web, 0)[qz, qx]
    yp, yd, g2 = yp[jz, jx], yd[jz, jx], g2[jz, jx]                # carried out to the outline
    # THE BORDER RAYS IN LINE. The first and fifth metacarpals lie palmar of the second to
    # fourth (the thumb in front of the palm, the fifth down the transverse arch), so their
    # cover put two humps on the palm's palmar face — over the thenar and toward the fifth
    # knuckle (the fourth's head is down the arch too), standing 1.1 and 0.75 cm proud on the
    # lateral. Over the palm, the palmar surface above the first, fourth and fifth rays stands
    # at most BORDER_PROUD_MM above the second and third's at the same level: the knuckles all
    # follow their curve.
    ray_f = ray2[jz, jx]
    mid_rays = foot & np.isin(ray_f, (2, 3))
    ref = np.where(mid_rays, yp, -np.inf).max(axis=1, keepdims=True)          # per row
    border = foot & np.isin(ray_f, (1, 4, 5)) & (g2 < 0.5) & np.isfinite(ref)
    yp = np.where(border, np.minimum(yp, ref + BORDER_PROUD_MM), yp)
    del ray_f, mid_rays, ref, border, ray2
    del d2, jz, jx, side, owner, seam, f2, p2, web, qz, qx

    def smooth(f, sig_mm):                                          # within the outline only
        wgt = ndi.gaussian_filter(foot.astype(np.float32), sig_mm / spacing)
        return ndi.gaussian_filter(np.where(foot, f, 0).astype(np.float32), sig_mm / spacing) / np.maximum(wgt, 1e-6)
    yp = g2 * smooth(yp, 4.0) + (1 - g2) * smooth(yp, 6.0)
    yd = g2 * smooth(yd, 4.0) + (1 - g2) * smooth(yd, 6.0)
    # (never closer to the bone than 2 mm, however the smoothing averaged)
    yp = np.where(has, np.maximum(yp, ybp + 2.0), yp)
    yd = np.where(has, np.minimum(yd, ybd - 2.0), yd)
    del ybp, ybd
    mid, half = (yp + yd) / 2, np.maximum((yp - yd) / 2, 0)
    edge = ndi.distance_transform_edt(foot, sampling=spacing)       # mm in from the outline
    w = np.minimum(half, 12.0)
    # the wrist and forearm rounded across their whole width (an oval, not a slab with its
    # corners turned): the rounding reaches the row's own half-width
    fore2 = np.clip((zf + r10 - np.arange(nz)) / r10, 0, 1)[:, None]
    w = (1 - fore2) * w + fore2 * edge.max(axis=1, keepdims=True)
    hh = half * np.sqrt(1 - (1 - np.clip(edge / np.maximum(w, 1e-6), 0, 1)) ** 2)
    hh *= (1 - seam_f) + seam_f * np.sqrt(1 - (1 - np.clip(seam_d / np.maximum(w, 1e-6), 0, 1)) ** 2)
    soft = foot[:, None, :] & (np.abs(ys - mid[:, None, :]) <= hh[:, None, :])
    soft |= bone
    del yp, yd, g2, mid, half, edge, w, hh, has, foot, seam_d, seam_f
    soft = oval_wrist(soft, bone, zcut, spacing)

    # for the layers: how far each point is from its nearest bone, and which way (+y palmar)
    dist, idx = ndi.distance_transform_edt(~bone, sampling=spacing, return_indices=True)
    dist = dist.astype(np.float32)
    iz, iy, ix = idx
    del idx
    uy = (ys - iy * spacing) / np.maximum(dist, 1e-6)
    uy[dist == 0] = 0
    near_digit = digit[iz, iy, ix]
    near_palm = palm_region[iz, iy, ix]
    fat_d = fat_mm + (FOREARM_FAT_MM - fat_mm) * fore[iz, iy, ix]   # deeper fat over the forearm
    del iz, iy, ix, digit, palm_region
    occ = ndi.gaussian_filter(soft.astype(np.float32), sigma=smooth_mm / spacing)
    soft = (occ > 0.5) | bone
    del occ
    soft = ndi.binary_fill_holes(soft)

    sdepth = ndi.distance_transform_edt(soft, sampling=spacing)    # mm below the skin
    mat = np.full(bone.shape, AIR, dtype=np.uint8)
    mat[soft] = FAT
    mat[soft & near_palm & (near_digit < 0.5) & (sdepth > fat_d) & (uy > -0.35)] = MUSCLE
    mat[soft & (dist <= tendon_mm)] = SOFT                          # tendons, sheaths, ligaments
    mat[soft & (sdepth <= skin_mm)] = SKIN
    del sdepth, soft, dist, uy, near_digit, near_palm, fat_d

    # the joint spaces (joint_spaces): the envelope above is laid on the whole skeleton, the bone
    # on the skeleton less its joints, so each gap stays soft tissue and every joint surface
    # gets its own thin cortex, the subchondral plate that draws the joint's line on the film
    bone_architecture(mat, bone & ~gaps if gaps is not None else bone, spacing)
    if gaps is not None:
        mat[gaps] = CARTILAGE                                       # the joint space itself
    # the carpal joints are cut after: a carpal's joint surface is curved, and the beam meets
    # it edge-on only along a short arc, so its margin is a fine line on a PA. A plate laid on
    # a cut that runs through the carpus's whole depth projects as a bright wall instead.
    if crack is not None:
        mat[crack] = CARTILAGE

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


def build(glb, out_dir, name, title, spacing, component, flip, mesh, source,
          backend_only=False, mesh_from=None):
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
    # (the joints first, on the bone's own frame: the carpus's exceptions are measured there)
    print("      the joint spaces …")
    gaps, crack = joint_spaces(bone, spacing)
    margin = int(np.ceil(26.0 / spacing))                  # the thenar's cover is 22 mm
    bone = np.pad(bone, margin, mode='constant', constant_values=False)
    gaps = np.pad(gaps, margin, mode='constant', constant_values=False)
    crack = np.pad(crack, margin, mode='constant', constant_values=False)
    print(f"      padded by {margin} vox ({margin*spacing:.0f} mm) so soft tissue can grow: {bone.shape}")
    mat = build_materials(bone, spacing, gaps=gaps, crack=crack)

    # tight crop with a small air margin so the model is not padded with empty space
    zs, ys, xs = np.where(mat > AIR)
    pad = max(1, int(round(2.0 / spacing)))
    sl = (slice(max(0, zs.min() - pad), min(mat.shape[0], zs.max() + pad + 1)),
          slice(max(0, ys.min() - pad), min(mat.shape[1], ys.max() + pad + 1)),
          slice(max(0, xs.min() - pad), min(mat.shape[2], xs.max() + pad + 1)))
    mat = np.ascontiguousarray(mat[sl])

    print("[4/4] writing volume …")
    # write_model rewrites the header from scratch, which silently drops keys added by other
    # tools. The photo skin (build_hand_skin.py) lives in skinMesh, and two rebuilds threw it
    # away without a word — the toggle stayed in the UI, pointing at nothing. Carry it over
    # if the file it names is still on disk.
    hdr_path = os.path.join(out_dir, f"{name}.model.json")
    keep_skin = None
    if os.path.exists(hdr_path):
        try:
            prev = json.load(open(hdr_path))
            sk = prev.get("skinMesh")
            if sk and os.path.exists(os.path.join(out_dir, sk)):
                keep_skin = sk
        except Exception:
            pass
    # mesh=False so write_model skips the generic translucent-skin-over-skeleton mesh;
    # the hand gets its own smooth opaque one, then the header is pointed back at it
    write_model(out_dir, name, title, mat, synth_hu(mat), spacing, False, source,
                backend_only=backend_only)
    if mesh:
        print("      building the smooth skin mesh …")
        build_hand_mesh(mat, spacing, os.path.join(out_dir, f"{name}.glb"))
    elif mesh_from:
        # A fine rebuild is the SAME hand, so meshing it again would spend minutes on a
        # far heavier surface that only ever gets used to aim the tube. Reuse the mesh
        # from the coarse build instead.
        import shutil
        shutil.copyfile(mesh_from, os.path.join(out_dir, f"{name}.glb"))
        print(f"      display mesh copied from {mesh_from}")
    if mesh or mesh_from or keep_skin:
        with open(hdr_path) as f:
            hdr = json.load(f)
        if mesh or mesh_from:
            hdr["mesh"] = f"{name}.glb"
        if keep_skin:
            hdr["skinMesh"] = keep_skin
            print(f"      kept photo skin: {keep_skin}")
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
    ap.add_argument("--mesh-from", default=None,
                    help="copy this .glb as the display mesh instead of building one")
    ap.add_argument("--backend-only", action="store_true",
                    help="mark the model GPU-backend-only: the browser skips the .mat.bin "
                         "download and never ray-casts it in JS")
    ap.add_argument("--source", default=SOURCE)
    a = ap.parse_args()
    build(a.glb, a.out, a.name, a.title, a.spacing, a.component, a.flip,
          mesh=not a.no_mesh, source=a.source,
          backend_only=a.backend_only, mesh_from=a.mesh_from)
