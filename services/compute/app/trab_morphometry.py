"""Measure trabecular morphometry from a micro-CT bone scan, to calibrate the synthetic
trabecular texture used by build_hand.py.

The hand model's macro geometry comes from a ~0.55 mm surface scan, which carries no
trabeculae at all, so build_hand.py generates them. Generating them from invented numbers
produces invented bone; this reads the numbers off a real 20 um micro-CT instead.

Deliberately measurement-only: it reports statistics (BV/TV, Tb.Th, Tb.Sp, Tb.N, the
autocorrelation length and the anisotropy) and never copies voxels into the model. That
keeps the output ours — a texture matched to published-style morphometry rather than a
derivative of the source scan, which matters because the micro-CT is CC BY-SA while the
hand's own source scan is CC BY-NC-SA and the two share-alike terms cannot both be
satisfied by one combined work.

The generator in build_hand.py is a thresholded Gaussian random field, which has exactly
two free parameters — the smoothing length and the threshold. They map one-to-one onto
the two quantities measured here: the autocorrelation length sets the smoothing, and BV/TV
sets the threshold. So the calibration is complete, not a fit.

CLI:
  ./.venv/Scripts/python.exe -m app.trab_morphometry --zip <capitate.zip> --voxel-um 20
"""
from __future__ import annotations

import argparse
import io
import json
import zipfile

import numpy as np
from scipy import ndimage as ndi


def load_bmp_stack(zip_path, step=1, max_slices=None):
    """Read the compressed BMP slice stack into a uint8/uint16 volume (z, y, x)."""
    from PIL import Image
    with zipfile.ZipFile(zip_path) as z:
        names = sorted(n for n in z.namelist() if n.lower().endswith('.bmp'))
        if not names:
            raise SystemExit('no .bmp slices in the archive')
        names = names[::step]
        if max_slices:
            names = names[:max_slices]
        first = np.array(Image.open(io.BytesIO(z.read(names[0]))))
        vol = np.empty((len(names),) + first.shape, first.dtype)
        vol[0] = first
        for i, n in enumerate(names[1:], 1):
            vol[i] = np.array(Image.open(io.BytesIO(z.read(n))))
    return vol


def central_voi(vol, frac=0.42):
    """A cube in the middle of the bone: the trabecular core, away from the cortical rim."""
    c = [s // 2 for s in vol.shape]
    h = [max(8, int(s * frac / 2)) for s in vol.shape]
    return vol[c[0]-h[0]:c[0]+h[0], c[1]-h[1]:c[1]+h[1], c[2]-h[2]:c[2]+h[2]]


def otsu(v):
    """Otsu threshold on a 256-bin histogram of the sample."""
    x = v.astype(np.float64).ravel()
    lo, hi = np.percentile(x, [0.5, 99.5])
    h, edges = np.histogram(x, bins=256, range=(lo, hi))
    p = h / max(1, h.sum())
    w0 = np.cumsum(p)
    mids = (edges[:-1] + edges[1:]) / 2
    m0 = np.cumsum(p * mids)
    mt = m0[-1]
    with np.errstate(invalid='ignore', divide='ignore'):
        var = (mt * w0 - m0) ** 2 / (w0 * (1 - w0))
    return float(mids[np.nanargmax(var)])


def clean(mask, min_vox=27):
    """Drop speckle from the segmentation in BOTH phases.

    Micro-CT noise leaves isolated voxels that fragment the marrow phase, which drives any
    spacing measure toward the voxel size. Standard practice in bone morphometry is to
    despeckle before measuring.
    """
    for inv in (False, True):
        m = ~mask if inv else mask
        lab, n = ndi.label(m)
        if n > 1:
            sizes = np.bincount(lab.ravel())
            sizes[0] = 0
            drop = np.isin(lab, np.where(sizes < min_vox)[0])
            mask = (mask | drop) if inv else (mask & ~drop)
    return mask


def chord_lengths(mask, voxel_mm):
    """Mean chord length (mm) of the True phase along each axis — the classic
    stereological Tb.Th / Tb.Sp.

    A line cast through the structure alternates bone and marrow; the mean length of the
    runs IS the mean thickness (plate model), with no sphere-fitting bias. Runs touching a
    VOI face are dropped, since they are truncated by the crop rather than by the bone.
    """
    means = []
    for ax in range(3):
        m = np.moveaxis(mask, ax, -1)
        flat = m.reshape(-1, m.shape[-1])
        keep = []
        for row in flat:
            if not row.any() or row.all():
                continue
            d = np.diff(row.astype(np.int8))
            starts = np.where(d == 1)[0] + 1
            ends = np.where(d == -1)[0] + 1
            if starts.size and ends.size:
                if ends[0] < starts[0]:
                    ends = ends[1:]
                n = min(starts.size, ends.size)
                if n:
                    keep.append(ends[:n] - starts[:n])      # interior runs only
        if keep:
            means.append(np.concatenate(keep).mean() * voxel_mm[ax])
    return means, float(np.mean(means)) if means else 0.0


def autocorr_length(mask, voxel_mm):
    """Correlation length (mm) of the bone phase, per axis and averaged.

    Taken as the half-width at 1/e of the autocorrelation, computed via the FFT power
    spectrum. This is the quantity that sets the Gaussian filter's sigma in the generator:
    a thresholded Gaussian field whose autocorrelation matches the bone's will reproduce
    its characteristic spacing.
    """
    f = mask.astype(np.float32)
    f -= f.mean()
    P = np.abs(np.fft.rfftn(f)) ** 2
    ac = np.fft.irfftn(P, s=f.shape)
    ac /= ac.flat[0]
    out = []
    for ax in range(3):
        idx = [0, 0, 0]
        line = []
        n = f.shape[ax] // 2
        for k in range(n):
            idx[ax] = k
            line.append(ac[tuple(idx)])
        line = np.array(line)
        below = np.where(line < 1 / np.e)[0]
        out.append((below[0] if below.size else n) * voxel_mm[ax])
    return out, float(np.mean(out))


def main(zip_path, voxel_um, step, max_slices):
    vmm = voxel_um / 1000.0
    print(f'[1/4] reading {zip_path} (every {step} slice, voxel {voxel_um} um) …')
    vol = load_bmp_stack(zip_path, step=step, max_slices=max_slices)
    print(f'      stack {vol.shape} {vol.dtype}')

    voi = central_voi(vol)
    print(f'[2/4] trabecular VOI {voi.shape} = '
          f'{voi.shape[0]*vmm*step:.1f} x {voi.shape[1]*vmm:.1f} x {voi.shape[2]*vmm:.1f} mm')

    th = otsu(voi)
    raw = voi > th
    bone = clean(raw)
    bvtv = float(bone.mean())
    print(f'[3/4] Otsu threshold {th:.0f}; despeckle moved {np.mean(raw != bone)*100:.2f} % '
          f'of voxels; BV/TV = {bvtv*100:.1f} %')

    sampling = (vmm * step, vmm, vmm)
    th_ax, tb_th = chord_lengths(bone, sampling)
    sp_ax, tb_sp = chord_lengths(~bone, sampling)
    tb_n = bvtv / tb_th if tb_th > 0 else 0.0
    per_axis, corr = autocorr_length(bone, sampling)
    da = max(per_axis) / max(1e-9, min(per_axis))

    print('[4/4] morphometry (mean chord length)')
    print(f'      BV/TV                {bvtv*100:8.1f} %')
    print(f'      Tb.Th                {tb_th:8.3f} mm   per axis '
          f'{" ".join(f"{v:.3f}" for v in th_ax)}')
    print(f'      Tb.Sp                {tb_sp:8.3f} mm   per axis '
          f'{" ".join(f"{v:.3f}" for v in sp_ax)}')
    print(f'      Tb.N                 {tb_n:8.2f} /mm')
    print(f'      Tb.Th + Tb.Sp        {tb_th+tb_sp:8.3f} mm  (trabecular period)')
    print(f'      corr length (z,y,x)  {per_axis[0]:.3f} / {per_axis[1]:.3f} / '
          f'{per_axis[2]:.3f} mm   mean {corr:.3f}')
    print(f'      anisotropy (max/min) {da:8.2f}')
    print()
    print('      -> generator: TRAB_BVTV = %.3f, TRAB_CORR_MM = %.3f' % (bvtv, corr))
    return dict(bvtv=bvtv, tb_th_mm=tb_th, tb_sp_mm=tb_sp, tb_n_per_mm=tb_n,
                period_mm=tb_th + tb_sp, corr_mm=corr, corr_axes_mm=per_axis,
                anisotropy=da, voxel_um=voxel_um, source=str(zip_path))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--zip', required=True, help='micro-CT bone archive of BMP slices')
    ap.add_argument('--voxel-um', type=float, default=20.0)
    ap.add_argument('--step', type=int, default=2, help='read every Nth slice')
    ap.add_argument('--max-slices', type=int, default=400)
    ap.add_argument('--out', default=None, help='write the measurements as JSON')
    a = ap.parse_args()
    res = main(a.zip, a.voxel_um, a.step, a.max_slices)
    if a.out:
        json.dump(res, open(a.out, 'w'), indent=2)
        print('      wrote', a.out)
