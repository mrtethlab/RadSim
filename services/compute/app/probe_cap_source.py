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


def body_and_air(sl):
    """Body mask (holes filled) and the air trapped inside it, for one slice.

    Flood-filling matters: without it the 'air' count is dominated by the room around the
    patient, which is constant down the whole scan and tells you nothing about where the
    lungs are."""
    body = sl > -400
    if not body.any():
        return body, np.zeros_like(body)
    lab, n = ndimage.label(body)
    if n > 1:                                     # keep the patient, drop the table and leads
        sizes = ndimage.sum(body, lab, range(1, n + 1))
        body = lab == (int(np.argmax(sizes)) + 1)
    filled = ndimage.binary_fill_holes(body)
    return filled, filled & (sl < -400)


def find_abdomen(path):
    """Return the z index range of a BLOCK_MM abdominal block, just below the lung bases."""
    im = nib.load(path)
    dz = float(im.header.get_zooms()[2])
    nz = im.shape[2]
    prof = np.zeros(nz)
    for k in range(0, nz, STEP):
        sl = np.asanyarray(im.dataobj[:, :, k]).astype(np.int16)
        _, air = body_and_air(sl)
        prof[k:k + STEP] = air.sum()
    thr = prof.max() * 0.25
    lung = np.where(prof > thr)[0]
    if not len(lung):
        raise SystemExit('no interior air anywhere — cannot locate the lungs')
    # z increases towards the head in these volumes, so the lung BASE is the low end
    base = int(lung.min())
    n_block = int(round(BLOCK_MM / dz))
    lo = max(0, base - n_block)
    print(f'  lungs span z {lung.min()}..{lung.max()} '
          f'({(lung.max() - lung.min()) * dz / 10:.1f} cm of interior air)')
    print(f'  abdominal block: z {lo}..{base}  ({(base - lo) * dz / 10:.1f} cm)')
    return im, lo, base


DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')


def main(sub):
    src = os.path.join(DATA, 'vsd', sub, 'ct.nii.gz')
    print(f'== {sub} ==')
    im, lo, hi = find_abdomen(src)
    out = os.path.join(tempfile.gettempdir(), f'capprobe_{sub}')
    os.makedirs(out, exist_ok=True)
    crop_path = os.path.join(out, 'crop.nii.gz')
    if not os.path.exists(crop_path):
        d = np.asanyarray(im.dataobj[:, :, lo:hi])
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
