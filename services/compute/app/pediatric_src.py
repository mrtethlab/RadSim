"""The sources of the pediatric model, each read into one frame: LPS millimetres.

The child (TCIA Pediatric-CT-SEG) and the head and neck donor (TotalSegmentator s1082) come with real
orientation: they are read with SimpleITK and reoriented to LPS. The VSD postmortem scans (z053's arm,
z035's leg) were exported to NIfTI without one (identity direction, origin 0); build_limbs found by
eye and by the anatomy that their arrays run x toward the patient's LEFT (the liver at low x),
y toward the POSTERIOR (the table at high y) and z toward the FEET (the neck at z = 0). So a cache
voxel (z, y, x) lies at (x, y, -z) * 1.5 mm in an LPS frame: x left, y posterior, z superior.

A source here is (arr, origin, spacing) with arr indexed [z, y, x] and voxel (k, j, i) at
origin + (i, j, k) * spacing, the axes the LPS axes (direction identity): `Src`.
"""
from __future__ import annotations

import pathlib
from dataclasses import dataclass

import numpy as np

DATA = pathlib.Path(__file__).resolve().parents[1] / 'data'
PED = DATA / 'pediatric'
CHILD = '2197048C'


@dataclass
class Src:
    arr: np.ndarray            # [z, y, x]
    origin: np.ndarray         # (x, y, z) mm of voxel (0, 0, 0)
    sp: float

    def index(self, p):
        """continuous (k, j, i) index of LPS points p [..., 3] (x, y, z)"""
        q = (np.asarray(p, np.float64) - self.origin) / self.sp
        return q[..., ::-1]

    def points(self, mask):
        """LPS mm of the voxels in a mask [N, 3]"""
        k, j, i = np.nonzero(mask)
        return self.origin + np.stack([i, j, k], 1) * self.sp


def read_lps(path, sp=None, label=False):
    """A NIfTI reoriented to LPS (identity direction), optionally resampled isotropic."""
    import SimpleITK as sitk
    img = sitk.DICOMOrient(sitk.ReadImage(str(path)), 'LPS')
    if sp is not None:
        sz = [int(round(a * b / sp)) for a, b in zip(img.GetSize(), img.GetSpacing())]
        img = sitk.Resample(img, sz, sitk.Transform(), sitk.sitkNearestNeighbor if label else sitk.sitkLinear,
                            img.GetOrigin(), (sp, sp, sp), img.GetDirection(), 0 if label else -1024)
    d = np.array(img.GetDirection()).reshape(3, 3)
    assert np.allclose(d, np.eye(3)), d
    return img, Src(None, np.array(img.GetOrigin(), float), float(img.GetSpacing()[0]))


def vsd_cache(subj, sp=1.5):
    """build_limbs' 1.5 mm cache of a VSD scan as LPS: (hu, mat, body) flipped along z, and its Src
    frame (shared by all three)."""
    d = np.load(DATA / 'vsd' / subj / f'{subj}_{sp:g}mm.npz')
    nz = d['hu'].shape[0]
    # cache z index k lies at -k*sp; flipped, index k' = nz-1-k lies at -(nz-1-k')*sp
    org = np.array([0.0, 0.0, -(nz - 1) * sp])
    return d['hu'][::-1], d['mat'][::-1], d['body'][::-1], org


def cache_to_lps_index(k, nz):
    """a build_limbs cache z index (head end 0) as the flipped (LPS) index"""
    return nz - 1 - k
