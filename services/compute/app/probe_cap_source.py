"""Is a whole-body source usable for a CAP vessel map?

The chest model came from a diagnostic CT and segments cleanly. Every other subject comes from
the VSD whole-body series, and z045 was shown (docs/contrast-simulation.md §6.4) to be a
postmortem scan that TotalSegmentator cannot segment: a 30 cm abdominal block returned no
aorta, no IVC, no portal vein, and of the organs only colon.

z025 is the other whole-body subject and was never assessed. This runs the same decisive test
on whichever subject you name: locate the abdomen, crop a 30 cm block, segment it, and report
which of the classes a CAP contrast model actually needs came back non-empty. It answers the
only question that matters — does this source support the model — rather than proxying it with
image statistics, which is where an earlier attempt went wrong (a lung-aeration measure was
really measuring the air in the room).

    python -m app.probe_cap_source z025
"""
import os
import subprocess
import sys
import tempfile

import nibabel as nib
import numpy as np
from scipy import ndimage

# What a CAP contrast model needs. Without the arteries there is nothing to carry iodine;
# without the veins there is no return path; without the organs there are no beds to perfuse.
NEEDED = {
    'arteries': ['aorta', 'common_iliac_artery_left', 'common_iliac_artery_right',
                 'celiac_trunk', 'superior_mesenteric_artery',
                 'renal_artery_left', 'renal_artery_right'],
    'veins': ['inferior_vena_cava', 'portal_vein_and_splenic_vein',
              'iliac_vena_left', 'iliac_vena_right'],
    'organs': ['liver', 'spleen', 'kidney_left', 'kidney_right', 'pancreas',
               'stomach', 'colon', 'small_bowel'],
}

BLOCK_MM = 300.0          # 30 cm — the same abdominal block used on z045
STEP = 8                  # slice stride while profiling; 0.5 mm data is far finer than needed


DS = 6            # downsample factor for the anatomy search; 0.5 mm data -> 3 mm, plenty


def largest(mask):
    lab, n = ndimage.label(mask)
    if n <= 1:
        return mask
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    return lab == (int(np.argmax(sizes)) + 1)


def find_lungs(vol):
    """Return the z index range of the lungs, working in 3D on a downsampled volume.

    Per-slice hole filling does not work here: on many slices the body mask touches the image
    border (arms, the table, a body bag), so there is no hole to fill and the 'interior air'
    ends up including the whole room. An earlier version of this function reported 149 cm of
    interior air on a 155 cm scan and cropped the feet. In 3D the body is one connected blob
    that can be filled once, and the lungs are then simply the largest air pocket inside it."""
    small = vol[::DS, ::DS, ::DS]
    body = largest(small > -400)
    body = ndimage.binary_fill_holes(body)
    air = body & (small < -400)
    lung = largest(air)
    zs = np.where(lung.any(axis=(0, 1)))[0]
    if not len(zs):
        raise SystemExit('no air pocket inside the body — cannot locate the lungs')
    return int(zs.min()) * DS, int(zs.max()) * DS, int(lung.sum()) * DS ** 3


def find_abdomen(path):
    """Return the z index range of a BLOCK_MM abdominal block, just below the lung bases.

    The volume is read ONCE. Slicing `dataobj` per slice on a .nii.gz re-inflates the stream
    from the beginning every time, so profiling 3000 slices that way is quadratic — it ran for
    many minutes without producing a line. 512x512x3100 int16 is ~1.6 GB, which is nothing."""
    im = nib.load(path)
    dz = float(im.header.get_zooms()[2])
    nz = im.shape[2]
    print('  loading the volume…', flush=True)
    vol = np.asanyarray(im.dataobj)
    z0, z1, nvox = find_lungs(vol)
    span = (z1 - z0) * dz / 10
    print(f'  lungs z {z0}..{z1} = {span:.1f} cm, {nvox * np.prod(im.header.get_zooms()) / 1000:,.0f} cm3')
    if span < 12 or span > 40:
        print('  ** that is not a plausible lung span — the crop below may be wrong **')
    base = z0                                     # z increases headwards; the base is the low end
    n_block = int(round(BLOCK_MM / dz))
    lo = max(0, base - n_block)
    print(f'  abdominal block: z {lo}..{base}  ({(base - lo) * dz / 10:.1f} cm)')
    return im, vol, lo, base


DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')


def main(sub):
    src = os.path.join(DATA, 'vsd', sub, 'ct.nii.gz')
    print(f'== {sub} ==')
    im, vol, lo, hi = find_abdomen(src)
    out = os.path.join(tempfile.gettempdir(), f'capprobe_{sub}')
    os.makedirs(out, exist_ok=True)
    crop_path = os.path.join(out, 'crop.nii.gz')
    if not os.path.exists(crop_path):
        d = vol[:, :, lo:hi]
        aff = im.affine.copy()
        aff[:3, 3] = aff[:3, 3] + aff[:3, 2] * lo
        nib.save(nib.Nifti1Image(d, aff, im.header), crop_path)
        print(f'  cropped -> {d.shape}')
    seg_dir = os.path.join(out, 'seg')
    if not os.path.isdir(seg_dir) or not os.listdir(seg_dir):
        print('  segmenting (this is the slow part)…')
        subprocess.run([sys.executable, '-m', 'totalsegmentator.bin.TotalSegmentator',
                        '-i', crop_path, '-o', seg_dir, '--fast'], check=True)
    print('\n  class                                voxels')
    verdict = {}
    for group, names in NEEDED.items():
        got = 0
        for n in names:
            f = os.path.join(seg_dir, n + '.nii.gz')
            v = int(np.asanyarray(nib.load(f).dataobj).sum()) if os.path.exists(f) else -1
            print(f'  {group[:3]}  {n:36s} {"absent" if v < 0 else f"{v:,}"}')
            if v > 500:
                got += 1
        verdict[group] = f'{got}/{len(names)}'
    print('\n  VERDICT', verdict)
    print('  A usable CAP source returns essentially all of them. z045 returned 0 arteries,'
          '\n  0 veins and 1 organ (colon) — that is what an out-of-distribution scan looks like.')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'z025')
