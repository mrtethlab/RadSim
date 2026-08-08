"""Build a LINE-PAIR RESOLUTION TEST PATTERN — the sim's spatial-resolution QC tool.

Modelled on the lead bar-pattern gauges used for radiographic QC (Fluke 07-555,
Nuclear Associates 07-501 and friends): groups of five equal lead bars separated by
five equal gaps, each group at a stated spatial frequency in line pairs per mm. A
group is "resolved" when you can still count five separate bars; the highest such
group is the limiting resolution, and it should sit near the detector's Nyquist
frequency (1 / 2·pixel-pitch).

One orientation only: the bars run along z, so the pattern probes resolution ACROSS
x. To measure the other axis, roll the phantom 90° with the object ROLL slider and
expose again — which is what you do with a physical gauge anyway. Casting both
orientations into one plate would force a fine grid along BOTH axes and take the
volume from 8 MB to ~120 MB, for information a second exposure gives free.

Deviation from the real gauge, stated plainly: a physical pattern uses 0.05 mm lead,
which at diagnostic kVp transmits ~60 % and gives modest contrast. Here the lead is
0.2 mm so the bars are unambiguously black and the measurement is about resolution
rather than contrast detectability. Everything else — bar/gap equality, five bars per
group, the frequency ladder — follows the real thing.

The grid is deliberately anisotropic: fine across the bars, coarse along them, since
resolution along a bar carries no information. That keeps the volume near 10 MB
instead of the ~250 MB an isotropic grid at the same in-plane pitch would need.

CLI:
  ./.venv/Scripts/python.exe -m app.build_linepair --out ../../apps/web/public/models/linepair
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np

AIR, LEAD, PLASTIC = 0, 27, 28

# The frequency ladder of a standard bar-pattern gauge (lp/mm).
FREQS = [0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.5,
         2.8, 3.1, 3.4, 3.7, 4.0, 4.3, 4.6, 5.0, 5.6, 6.3]

# 3x5 dot font, one string per digit row, for the engraved frequency labels.
GLYPHS = {
    '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
    '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
    '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
    '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'],
    '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'],
    '.': ['000', '000', '000', '000', '010'],
}


def draw_text(plate, text, x0, z0, px, sp_x, sp_z):
    """Stamp `text` into the (x, z) plate mask with `px` mm per font pixel."""
    cw = max(1, int(round(px / sp_x)))
    ch = max(1, int(round(px / sp_z)))
    cx = x0
    for ch_ in text:
        g = GLYPHS.get(ch_)
        if g is None:
            cx += 2 * cw
            continue
        for r, row in enumerate(g):
            for c, on in enumerate(row):
                if on == '1':
                    xs = cx + c * cw
                    zs = z0 + (4 - r) * ch          # row 0 is the TOP of the glyph
                    plate[xs:xs + cw, zs:zs + ch] = True
        cx += 4 * cw
    return cx


def build(out_dir, name='linepair', title='Line-pair test pattern',
          sp_x=0.025, sp_z=0.10, sp_y=0.05,
          lead_mm=0.2, base_mm=0.6, bars=5,
          bar_len=2.4, group_gap=1.4, label_mm=1.4):
    # Groups run down z; within a group, `bars` lead bars of width 1/(2f) alternate
    # with equal gaps across x. Fine pitch across the bars, coarse along them.
    span_max = max(bars / f for f in FREQS)
    x0 = 1.0                                        # left margin to the first bar
    label_x = x0 + span_max + 1.0                   # engraved frequency, right of each group
    plate_x = label_x + 4 * 4 * (label_mm / 5.0) + 1.5
    plate_z = len(FREQS) * (bar_len + group_gap) + 2.0

    nx = int(round(plate_x / sp_x))
    nz = int(round(plate_z / sp_z))
    lead = np.zeros((nx, nz), bool)

    def group_bars(f, n):
        """Bar edges for one group: n bars of width 1/(2f) mm, equal gaps."""
        w = 1.0 / (2.0 * f)
        return [(i * 2 * w, i * 2 * w + w) for i in range(n)]

    zc = 1.0
    for f in FREQS:
        k0 = int(round(zc / sp_z)); k1 = int(round((zc + bar_len) / sp_z))
        for (a, b) in group_bars(f, bars):
            i0 = int(round((x0 + a) / sp_x)); i1 = int(round((x0 + b) / sp_x))
            lead[i0:i1, k0:k1] = True
        draw_text(lead, f'{f:.1f}', int(round(label_x / sp_x)),
                  int(round((zc + (bar_len - label_mm) / 2) / sp_z)),
                  label_mm / 5.0, sp_x, sp_z)
        zc += bar_len + group_gap

    print(f'[1/3] pattern {nx}x{nz}  ({plate_x:.1f} x {plate_z:.1f} mm plate, '
          f'{sp_x} mm across bars / {sp_z} mm along)')
    print(f'      {len(FREQS)} groups, {bars} bars each, {FREQS[0]}-{FREQS[-1]} lp/mm')

    # ---- extrude through the beam axis (y): lead layer on an acrylic base -------
    n_lead = max(1, int(round(lead_mm / sp_y)))
    n_base = max(1, int(round(base_mm / sp_y)))
    ny = n_lead + n_base
    mat = np.zeros((nz, ny, nx), np.uint8)          # (z, y, x), x-fastest on write
    mat[:, :n_base, :] = PLASTIC                    # acrylic backing, full plate
    leadT = lead.T                                  # (z, x)
    for j in range(n_base, ny):
        layer = mat[:, j, :]
        layer[leadT] = LEAD
        layer[~leadT] = AIR

    mb = mat.size / 1e6
    print(f'[2/3] volume {nx}x{ny}x{nz} = {mb:.1f} MB  '
          f'(lead {lead_mm} mm over {base_mm} mm acrylic)')

    # ---- write ------------------------------------------------------------------
    os.makedirs(out_dir, exist_ok=True)
    np.ascontiguousarray(mat).tofile(os.path.join(out_dir, f'{name}.mat.bin'))

    # Display mesh: marching cubes over a 653x16x780 plate of hairline bars would be a
    # huge, useless mesh, so the positioning view just gets the plate as a slab — that is
    # all you need to line the tube up on it.
    import trimesh
    ext = np.array([nx * sp_x, ny * sp_y, nz * sp_z])
    slab = trimesh.creation.box(extents=ext)          # centred, like every other <name>.glb
    trimesh.Scene(slab).export(os.path.join(out_dir, f'{name}.glb'))
    print(f'      display mesh: {ext.round(1)} mm slab')

    from .build_model import LEGEND
    header = dict(
        name=title,
        source='synthetic lead bar-pattern gauge (build_linepair.py)',
        dims=[nx, ny, nz], spacing=[sp_x, sp_y, sp_z],
        order='x-fastest: i = x + nx*(y + ny*z)',
        volume=f'{name}.mat.bin', dtype='uint8', mesh=f'{name}.glb',
        materials=[dict(id=i, name=nm, hu=hu, color=f'#{c:06x}') for (i, nm, hu, c) in LEGEND],
        materialsPresent=sorted(int(v) for v in np.unique(mat)),
        huReference=[-1000, 3000],
        backendOnly=False,
        # measurement metadata: the app/QC script reads this to know what is where
        linePair=dict(freqs=FREQS, bars=bars, leadMM=lead_mm, barLenMM=bar_len,
                      groupGapMM=group_gap, x0MM=x0,
                      plateMM=[plate_x, plate_z], spacingMM=[sp_x, sp_y, sp_z]),
    )
    with open(os.path.join(out_dir, f'{name}.model.json'), 'w') as f:
        json.dump(header, f, indent=2)
    print(f'[3/3] wrote {out_dir}/{name}.mat.bin + .model.json')
    print(f'      finest group {FREQS[-1]} lp/mm = {1000/(2*FREQS[-1]):.0f} um bars '
          f'({1.0/(2*FREQS[-1])/sp_x:.1f} voxels per bar)')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--name', default='linepair')
    ap.add_argument('--fine', type=float, default=0.025, help='voxel across the bars (mm)')
    ap.add_argument('--lead', type=float, default=0.2, help='lead thickness (mm)')
    a = ap.parse_args()
    build(a.out, a.name, sp_x=a.fine, lead_mm=a.lead)
