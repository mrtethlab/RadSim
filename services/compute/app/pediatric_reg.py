"""Registration of the pediatric model's donor parts onto the child, from corresponding anatomy.

Every fit here is between named bones that both scans have, labelled by TotalSegmentator (the child,
z053's upper body, s1082's ground truth): the same rib, the same vertebra, the sternum. Ribs are long
curves, so a rib gives several points, its voxels binned by the angle they lie at round the rib
cage's axis (posterior, lateral, anterior...), each bin's centroid one point; a bin is used only
when both scans have it. The transforms map CHILD points to DONOR points (they pull the donor's
voxels onto the child's grid).
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage as ndi

from app.pediatric_src import Src


def ts_ids():
    from totalsegmentator.map_to_binary import class_map
    return {v: k for k, v in class_map['total'].items()}


def label_volume(path):
    """a TotalSegmentator multilabel NIfTI as an LPS array and its frame"""
    import SimpleITK as sitk
    from app.pediatric_src import read_lps
    img, src = read_lps(path)
    src.arr = sitk.GetArrayFromImage(img).astype(np.int16)
    return src


def largest(mask):
    lab, n = ndi.label(mask)
    if n <= 1:
        return mask
    return lab == (int(np.argmax(ndi.sum(mask, lab, range(1, n + 1)))) + 1)


def label_pts(src, name, clean=True):
    """LPS points (mm) of one label; its largest piece (TotalSegmentator scatters a few voxels of a
    label elsewhere: z053's humerus had some in the hand)."""
    lid = ts_ids()[name]
    m = src.arr == lid
    if not m.any():
        return np.zeros((0, 3))
    if clean:
        # on a box round the label, not the whole volume
        sl = ndi.find_objects(m.astype(np.uint8))[0]
        sub = largest(m[sl])
        m = np.zeros_like(m); m[sl] = sub
    return src.points(m)


def mirror_x(p, x0):
    q = np.array(p, float, copy=True)
    q[..., 0] = 2 * x0 - q[..., 0]
    return q


def rib_bins(pts, centre, nb=12):
    """a rib's points binned by their angle round `centre` (x, y) in the axial plane: {bin: centroid}"""
    ang = np.arctan2(pts[:, 1] - centre[1], np.abs(pts[:, 0] - centre[0]))   # 0 lateral, +pi/2 posterior
    b = np.floor((ang + np.pi) / (2 * np.pi) * nb * 2).astype(int)
    return {int(k): pts[b == k].mean(0) for k in np.unique(b) if (b == k).sum() >= 15}


def cage_centre(src, names):
    p = np.concatenate([label_pts(src, n) for n in names])
    return p[:, :2].mean(0)


def correspondences(child, donor, side_child, side_donor, ribs, verts, sternum=True, donor_mirror=None,
                    nb=12, ang_range=None, clavicle=False):
    """point pairs (P child, Q donor) from the ribs of one side, the vertebrae and the sternum.
    donor_mirror: x of the plane to mirror the donor about (its midline) when a left part is made from
    a right one; Q is then in the mirrored donor frame."""
    P, Q, W = [], [], []
    names = [f'rib_{side_child}_{k}' for k in ribs]
    cc = cage_centre(child, names)
    dnames = [f'rib_{side_donor}_{k}' for k in ribs]
    dp = {n: label_pts(donor, n) for n in dnames}
    if donor_mirror is not None:
        dp = {n: mirror_x(v, donor_mirror) for n, v in dp.items()}
    dc = np.concatenate(list(dp.values()))[:, :2].mean(0)
    for k in ribs:
        a = rib_bins(label_pts(child, f'rib_{side_child}_{k}'), cc, nb)
        b = rib_bins(dp[f'rib_{side_donor}_{k}'], dc, nb)
        for key in set(a) & set(b):
            ang = (key + 0.5) / (2 * nb) * 2 * np.pi - np.pi           # the bin's centre angle
            if ang_range is not None and not (ang_range[0] <= np.degrees(ang) <= ang_range[1]):
                continue
            P.append(a[key]); Q.append(b[key]); W.append(1.0)
    for v in verts:
        a, b = label_pts(child, f'vertebrae_{v}'), label_pts(donor, f'vertebrae_{v}')
        if len(a) < 50 or len(b) < 50:
            continue
        if donor_mirror is not None:
            b = mirror_x(b, donor_mirror)
        # the body's centroid and the whole vertebra's (two points: the column's line and its depth)
        for pa, pb in ((a, b),):
            P.append(pa.mean(0)); Q.append(pb.mean(0)); W.append(2.0)
    if sternum:
        a, b = label_pts(child, 'sternum'), label_pts(donor, 'sternum')
        if donor_mirror is not None:
            b = mirror_x(b, donor_mirror)
        # the manubrium (its top quarter) and the body
        for frac in ((0.75, 1.0), (0.3, 0.75)):
            za, zb = np.quantile(a[:, 2], frac), np.quantile(b[:, 2], frac)
            P.append(a[(a[:, 2] >= za[0]) & (a[:, 2] <= za[1])].mean(0))
            Q.append(b[(b[:, 2] >= zb[0]) & (b[:, 2] <= zb[1])].mean(0)); W.append(2.0)
    if clavicle:
        # the clavicle's medial end (the sternoclavicular joint): where it is does not change when
        # the arm is raised, as the rest of the clavicle does
        a, b = label_pts(child, f'clavicula_{side_child}'), label_pts(donor, f'clavicula_{side_donor}')
        if donor_mirror is not None:
            b = mirror_x(b, donor_mirror)
        ca, cb = cage_centre(child, names), cage_centre(donor, dnames)
        if donor_mirror is not None:
            cb = cb.copy(); cb[0] = 2 * donor_mirror - cb[0]
        ea = a[np.argsort(np.abs(a[:, 0] - ca[0]))[:60]].mean(0)
        eb = b[np.argsort(np.abs(b[:, 0] - cb[0]))[:60]].mean(0)
        P.append(ea); Q.append(eb); W.append(3.0)
    return np.array(P), np.array(Q), np.array(W)


def umeyama(P, Q, W=None, scale=True):
    """Q ~ s R P + t, weighted least squares. Returns (s, R, t)."""
    W = np.ones(len(P)) if W is None else np.asarray(W, float)
    w = W / W.sum()
    mp, mq = w @ P, w @ Q
    X, Y = P - mp, Q - mq
    S = (Y * w[:, None]).T @ X
    U, D, Vt = np.linalg.svd(S)
    E = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        E[2, 2] = -1
    R = U @ E @ Vt
    var = (w * (X ** 2).sum(1)).sum()
    s = (D * np.diag(E)).sum() / var if scale else 1.0
    t = mq - s * R @ mp
    return s, R, t


def affine_fit(P, Q, W=None):
    """Q ~ A P + b, weighted least squares. Returns (A, b)."""
    W = np.ones(len(P)) if W is None else np.asarray(W, float)
    X = np.column_stack([P, np.ones(len(P))]) * np.sqrt(W)[:, None]
    M, *_ = np.linalg.lstsq(X, Q * np.sqrt(W)[:, None], rcond=None)
    return M[:3].T, M[3]


def icp_similarity(P, Q, s, R, t, iters=40, trim=0.9, scale=True):
    """refine Q ~ s R P + t by trimmed ICP from surface points P (child) to Q (donor); with
    scale=False s stays as given (and must be 1 if P is not pre-scaled)"""
    from scipy.spatial import cKDTree
    tree = cKDTree(Q)
    for _ in range(iters):
        X = s * P @ R.T + t
        d, i = tree.query(X)
        keep = d <= np.quantile(d, trim)
        s2, R, t = umeyama(P[keep], Q[i[keep]], scale=scale)
        if scale:
            s = s2
    X = s * P @ R.T + t
    d, _ = tree.query(X)
    return s, R, t, float(np.median(d))


def surface(mask):
    return mask & ~ndi.binary_erosion(mask)


def sphere_fit(P):
    """least-squares sphere through points: (centre, radius)"""
    A = np.column_stack([2 * P, np.ones(len(P))])
    b = (P ** 2).sum(1)
    x, *_ = np.linalg.lstsq(A, b, rcond=None)
    c = x[:3]
    return c, float(np.sqrt(x[3] + c @ c))


def labelwise_icp(pairs, s, R, t, iters=30, trim=0.85):
    """Similarity refined on several labelled point sets at once: each child set's points matched
    only to the same label's donor points. pairs: [(P_child, Q_donor)]."""
    from scipy.spatial import cKDTree
    trees = [cKDTree(Q) for _, Q in pairs]
    for _ in range(iters):
        A, B = [], []
        for (P, Q), tr in zip(pairs, trees):
            X = s * P @ R.T + t
            d, i = tr.query(X)
            k = d <= np.quantile(d, trim)
            A.append(P[k]); B.append(Q[i[k]])
        s, R, t = umeyama(np.concatenate(A), np.concatenate(B))
    res = []
    for (P, Q), tr in zip(pairs, trees):
        d, _ = tr.query(s * P @ R.T + t)
        res.append(float(np.median(d)))
    return s, R, t, res


def rot_between(a, b):
    """the rotation taking unit vector a to unit vector b (Rodrigues)"""
    a = a / np.linalg.norm(a); b = b / np.linalg.norm(b)
    v = np.cross(a, b); c = float(a @ b)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3)
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K * (1 / (1 + c))


def axis_angle(axis, ang):
    axis = np.asarray(axis, float); axis = axis / np.linalg.norm(axis)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(ang) * K + (1 - np.cos(ang)) * K @ K
