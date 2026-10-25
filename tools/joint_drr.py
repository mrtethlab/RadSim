"""Project a voxel model the way a radiograph sees it, to look at (and measure) its JOINT SPACES.

    services/compute/.venv/Scripts/python.exe tools/joint_drr.py hand --roll 0 --out hand_pa.png

A parallel projection of linear attenuation through the material volume, at one effective energy
(about 45 keV: the bone/soft-tissue contrast of an extremity film), shown bone-white on a log
scale, at the model's own voxel pitch (or --pitch mm, resampled). Not the app's physics (no
spectrum, scatter, focal spot or detector): what is ON the model, which is what the joints are
made of. Whether a joint shows open on the app's film depends on the model first.

Views: --roll turns the subject about its long axis (z, the rest frame's), degrees, as the
Trainer's pose.roll does; --tilt about x (toward the head); --axis y projects front-to-back (AP/PA),
x side to side (lateral). Frame: the x-ray rest frame (tools/measure_palpation.py Vol).
"""
import argparse, json, pathlib, sys
import numpy as np
from scipy import ndimage as ndi
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from measure_palpation import MODELS, ROLLED_180

# linear attenuation at ~45 keV (cm^-1) by material NAME; anything else from its HU against water
MU = {'air': 0.0, 'lung': 0.07, 'fat': 0.215, 'water': 0.26, 'muscle': 0.27, 'soft tissue': 0.265,
      'skin': 0.275, 'cartilage': 0.29, 'trabecular bone': 0.42, 'cortical bone': 1.05}


def mu_table(materials):
    t = np.zeros(256, np.float32)
    for m in materials:
        n = m['name'].lower()
        t[m['id']] = MU.get(n, max(0.0, 0.26 * (1 + (m.get('hu') or 0) / 1000.0)))
    return t


def load(name, folder=None):
    """A model by name, from the app's models or from `folder` (a build not yet shipped)."""
    d = pathlib.Path(folder) if folder else MODELS / name
    h = json.loads((d / f'{name}.model.json').read_text(encoding='utf-8'))
    nx, ny, nz = h['dims']
    v = np.fromfile(d / f'{name}.mat.bin', dtype=np.uint8).reshape(nz, ny, nx)
    if name not in ROLLED_180:
        v = v[:, ::-1, ::-1]
    return v, np.array(h['spacing'], float), h


def project(v, sp, mats, roll=0.0, tilt=0.0, axis='y'):
    """Line integrals of mu through the volume [z, y, x] after the view's turns. Returns the
    integral image (rows = z from the head/fingertips down, cols = the other axis) and its
    pitch in mm."""
    mu = mu_table(mats)[v]
    if roll:
        mu = ndi.rotate(mu, roll, axes=(2, 1), reshape=True, order=1, mode='constant')   # about z
    if tilt:
        mu = ndi.rotate(mu, tilt, axes=(1, 0), reshape=True, order=1, mode='constant')   # about x
    if axis == 'y':
        img = mu.sum(axis=1) * sp[1] / 10.0
        pitch = (sp[2], sp[0])
    else:
        img = mu.sum(axis=2) * sp[0] / 10.0
        pitch = (sp[2], sp[1])
    return img[::-1], pitch                       # +z (the head / the fingertips) at the top


def to_png(img, pitch, out, mm=None, crop=None):
    """Bone white: 1 - exp(-integral), windowed to the image's own range. `mm` resamples to that
    pixel pitch; `crop` = (r0, r1, c0, c1) in output pixels."""
    a = 1.0 - np.exp(-img)
    lo, hi = np.percentile(a[a > 0.02], [1, 99.7]) if (a > 0.02).any() else (0, 1)
    a = np.clip((a - lo) / max(1e-6, hi - lo), 0, 1)
    if mm:
        a = ndi.zoom(a, (pitch[0] / mm, pitch[1] / mm), order=1)
    if crop:
        a = a[crop[0]:crop[1], crop[2]:crop[3]]
    Image.fromarray((a * 255).astype(np.uint8)).save(out)
    return a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('model')
    ap.add_argument('--roll', type=float, default=0)
    ap.add_argument('--tilt', type=float, default=0)
    ap.add_argument('--axis', default='y')
    ap.add_argument('--pitch', type=float, default=None, help='output pixel pitch, mm')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    v, sp, h = load(a.model)
    img, pitch = project(v, sp, h['materials'], a.roll, a.tilt, a.axis)
    out = to_png(img, pitch, a.out, a.pitch)
    print(a.model, 'roll', a.roll, 'tilt', a.tilt, 'axis', a.axis, '->', out.shape, a.out)


if __name__ == '__main__':
    main()
