"""The Skull's bony points, measured on its own volume, for the three measuring tools.

    python tools/skull_points.py            # prints them

The skull (services/compute/app/build_skull.py) is stored in the house frame (x = patient left,
y = posterior, z = superior) and turned square: the ear canals level across, the orbitomeatal line
(OML) square to the long axis. Points are returned in the x-ray REST frame (x = patient's right,
y = anterior, z = superior; measure_palpation.py), cm from the volume centre, as (x, y, z).

- the ear canals (external acoustic meatus): non-bone walled by bone across (7 of 8 directions in the
  coronal-sagittal plane meet bone within 9 mm), open to the side (one of five outward directions
  meets no bone in 3 cm), more than 2 cm from the cranium's midline: of the five largest such pieces
  each side, the pair most nearly level and either side of the midline;
- the midline: halfway between the canals across;
- the glabella and the nasion: along the midline's front profile (each slice's most anterior bone),
  the glabella is its most anterior point from the canals' level up 6 cm, the nasion the deepest
  point of the profile below it while the profile runs on bone (the nasal bones, then the piriform
  aperture, where it falls back to the septum);
- the acanthion (the anterior nasal spine): below the aperture, where the profile comes forward
  again, its most anterior point within 2.5 cm;
- the inion: the most posterior point of the midline bone at or above the canals' level;
- the mastoid tips: the lowest bone behind the canal on each side, within 3.5 cm of it.
"""
import json, pathlib
import numpy as np
from scipy import ndimage as ndi

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODELS = ROOT / 'apps' / 'web' / 'public' / 'models'
BONE_MIN_ID = 54            # the graded bone (54-61); enamel is 19


def load():
    h = json.loads((MODELS / 'skull' / 'skull.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    sp = float(h['spacing'][0])
    v = np.fromfile(MODELS / 'skull' / 'skull.mat.bin', dtype=np.uint8).reshape(nz, ny, nx)
    return h, v, sp


def _reach(b, d, steps):
    hit = np.zeros(b.shape, bool)
    for s_ in range(1, int(steps / np.linalg.norm(d)) + 1):
        sh = [s_ * c for c in d]
        src = tuple(slice(max(0, c), b.shape[a] + min(0, c)) for a, c in enumerate(sh))
        dst = tuple(slice(max(0, -c), b.shape[a] + min(0, -c)) for a, c in enumerate(sh))
        hit[dst] |= b[src]
    return hit


def ear_canals(v, sp, f=2):
    """{'R', 'L'}: (z, y, x) voxel index of each external acoustic meatus (house frame: x low = R)."""
    b = v[::f, ::f, ::f] >= BONE_MIN_ID
    cav = np.isin(v[::f, ::f, ::f], [10, 4])                       # brain, CSF
    across = np.zeros(b.shape, np.uint8)
    for d in [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (1, 1, 0), (1, -1, 0), (-1, 1, 0), (-1, -1, 0)]:
        across += _reach(b, d, 9.0 / (sp * f))
    across = across >= 7
    xc = np.argwhere(cav)[:, 2].mean()                              # the cranium's midline across
    xs = np.arange(b.shape[2]); off = 20 / (sp * f)
    found = {}
    for side, sx, lat in (('R', -1, xs < xc - off), ('L', 1, xs > xc + off)):
        open_ = np.zeros(b.shape, bool)
        for d in [(0, 0, sx), (0, 1, sx), (0, -1, sx), (1, 0, sx), (-1, 0, sx)]:
            open_ |= ~_reach(b, d, 30 / (sp * f))
        cand = across & open_ & ~b & ~cav & lat[None, None, :]
        lab, n = ndi.label(cand)
        sizes = ndi.sum(cand, lab, range(1, n + 1))
        found[side] = [np.array(ndi.center_of_mass(lab == k + 1)) for k in np.argsort(sizes)[::-1][:5] if sizes[k] >= 50]
    # the head is square: of the larger pieces, the pair level with each other and either side of
    # the midline (a piece in the infratemporal fossa can be as large as a canal)
    best = min(((r, l) for r in found['R'] for l in found['L']),
               key=lambda p: abs(p[0][0] - p[1][0]) + abs(p[0][1] - p[1][1]) + abs((p[0][2] + p[1][2]) / 2 - xc))
    return {'R': best[0] * f, 'L': best[1] * f}


def front_profile(bone, x_mid, sp, half_mm=2.0):
    """per slice z, the y index of the midline's most anterior bone (y low is anterior), or nan"""
    x0, x1 = int(round(x_mid - half_mm / sp)), int(round(x_mid + half_mm / sp)) + 1
    b = bone[:, :, x0:x1].any(2)
    return np.array([np.nonzero(r)[0].min() if r.any() else np.nan for r in b], float)


def enclosure(bone, sp, reach_mm=30.0, f=2):
    """per voxel, of the 26 directions how many meet bone within reach_mm (at 1/f resolution)"""
    n = [s_ // f * f for s_ in bone.shape]
    b = bone[:n[0], :n[1], :n[2]].reshape(n[0] // f, f, n[1] // f, f, n[2] // f, f).any((1, 3, 5))
    count = np.zeros(b.shape, np.uint8)
    for d in [(i, j, k) for i in (-1, 0, 1) for j in (-1, 0, 1) for k in (-1, 0, 1) if (i, j, k) != (0, 0, 0)]:
        count += _reach(b, d, reach_mm / (sp * f))
    out = np.zeros(bone.shape, np.uint8)
    out[:n[0], :n[1], :n[2]] = count.repeat(f, 0).repeat(f, 1).repeat(f, 2)
    return out


def orbits(v, bone, sp, mid, xc):
    """{'R', 'L'}: (centroid, front) of each orbit's contents, (z, y, x) voxels: the largest piece of
    soft tissue walled by bone in 17-24 of 26 directions (open in front), 1-5.5 cm from the midline,
    3.5-11 cm in front of the ear canals and within 4.5 cm of their level; `front` is the centroid
    of its foremost centimetre, at the orbital opening (the canthi's level)."""
    nz, ny, nx = v.shape
    enc = enclosure(bone, sp)
    soft = (v > 0) & ~bone & ~np.isin(v, [10, 4, 19])
    zz, yy, xx = np.ogrid[:nz, :ny, :nx]
    out = {}
    for side, sgn in (('R', -1), ('L', 1)):
        dx = (xx - xc) * sgn * sp
        reg = (dx > 10) & (dx < 55) & (np.abs(zz - mid[0]) * sp < 45) & ((mid[1] - yy) * sp > 35) & ((mid[1] - yy) * sp < 110)
        cand = ndi.binary_opening(soft & (enc >= 17) & (enc <= 24) & reg)
        lab, n = ndi.label(cand)
        k = int(np.argmax(ndi.sum(cand, lab, range(1, n + 1)))) + 1
        o = np.argwhere(lab == k)
        out[side] = (o.mean(0), o[o[:, 1] <= o[:, 1].min() + int(10 / sp)].mean(0))
    return out


def points():
    """{name: (x, y, z) in cm, rest frame}, and the grid's spacing and shape.
    - the canthi's level: the orbits' openings (orbits(), above); the nasion lies 12 mm above it on
      the midline's front profile (the frontonasal suture is at the level of the orbits' upper
      third; this head, turned square from its extension on the headrest, has no concavity there
      for a profile to find), the glabella 15 mm above the nasion;
    - the acanthion: the midline's most anterior bone 3.5 to 6.5 cm below the nasion (the anterior
      nasal spine; the nasion-spine height is 5 cm in an adult);
    - the zygoma's point for the lateral face and sinuses: midway between the outer canthus (the
      orbit's opening) and the ear canal, both sides averaged, on the midline."""
    h, v, sp = load()
    nz, ny, nx = v.shape
    bone = v >= BONE_MIN_ID
    ears = ear_canals(v, sp)
    xc = np.argwhere(np.isin(v[::2, ::2, ::2], [10, 4]))[:, 2].mean() * 2     # the cranium's midline
    mid = (ears['R'] + ears['L']) / 2
    mid[2] = xc
    orb = orbits(v, bone, sp, mid, xc)
    canth = (orb['R'][1] + orb['L'][1]) / 2
    prof = front_profile(bone, xc, sp)
    zn = int(round(canth[0] + 12 / sp)); zg = int(round(zn + 15 / sp))
    band = np.arange(max(0, int(zn - 65 / sp)), int(zn - 35 / sp))
    band = band[np.isfinite(prof[band])]
    za = band[int(np.argmin(prof[band]))]
    x0, x1 = int(round(xc - 2 / sp)), int(round(xc + 2 / sp)) + 1
    back = np.array([np.nonzero(r)[0].max() if r.any() else -1 for r in bone[:, :, x0:x1].any(2)])
    zz = np.arange(int(mid[0]), nz)
    i_z = zz[int(np.argmax(back[zz]))]
    cm = lambda z, y, x: np.array([-(x - (nx - 1) / 2) * sp / 10, -(y - (ny - 1) / 2) * sp / 10, (z - (nz - 1) / 2) * sp / 10])
    out = {'earR': cm(*ears['R']), 'earL': cm(*ears['L']), 'earMid': cm(*mid),
           'orbitR': cm(*orb['R'][0]), 'orbitL': cm(*orb['L'][0]), 'canthi': cm(*canth),
           'nasion': cm(zn, prof[zn], xc), 'glabella': cm(zg, prof[zg], xc), 'acanthion': cm(za, prof[za], xc),
           'inion': cm(i_z, back[i_z], xc)}
    out['zygoma'] = (out['canthi'] + out['earMid']) / 2
    out['zygoma'][0] = out['earMid'][0]
    br = np.argwhere(np.isin(v, [10, 4]))
    out['cranium'] = cm(*br.mean(0))
    # the mastoid tips: the lowest bone behind each canal and lateral of it, within 3.5 cm
    for side, e in (('R', ears['R']), ('L', ears['L'])):
        r = int(35 / sp)
        sl = (slice(max(0, int(e[0]) - r), int(e[0]) + 1), slice(int(e[1]), min(ny, int(e[1]) + r)),
              slice(max(0, int(e[2]) - r // 2), min(nx, int(e[2]) + r // 2)))
        b = bone[sl]
        if b.any():
            k = np.argwhere(b)
            k = k[k[:, 0] == k[:, 0].min()].mean(0)
            out['mastoid' + side] = cm(k[0] + sl[0].start, k[1] + sl[1].start, k[2] + sl[2].start)
    return out, dict(sp=sp, shape=v.shape)


if __name__ == '__main__':
    pts, info = points()
    for k, p in pts.items():
        print(f'{k:10s} x {p[0]:+6.2f}  y {p[1]:+6.2f}  z {p[2]:+6.2f}')
