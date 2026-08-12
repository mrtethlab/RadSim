"""Pack a GI solve into the timeline the renderer reads.

Mirrors contrast_export.py: the solver's float state is far finer than any image needs, so it
is quantised to uint16 over a fixed ceiling and stored per segment as (nT x nS). Two fields
rather than one, because a barium study looks at both:

  lumen — mg Ba/mL in the lumen, which is what fills a stomach or a colon
  wall  — mg Ba/cm2 on the mucosa, which is what a DOUBLE-CONTRAST image is made of. It
          persists after the lumen has emptied, and that persistence is the finding.

The renderer turns `wall` into a path length by assuming the coat has a finite thickness:
mg/cm2 divided by the suspension's own concentration gives cm of equivalent barium, which is
the same currency the lumen column already uses. So both end up in one table.
"""
import json
import os

import numpy as np

from .gi_solver import ORDER, SEGMENTS, N, Administration, Coating, Pose, solve

NS = 64                 # arclength bins written out, as the contrast timeline uses
C_MAX = 700.0           # mg Ba/mL ceiling for the uint16 quantisation (>588 administered)
W_MAX = 20.0            # mg Ba/cm2 ceiling for the wall field


def _frames(times):
    """Which solver frames to keep.

    A GI study does not evolve at one rate. The swallow is over in ten seconds and needs every
    second; gastric emptying takes half an hour and does not change perceptibly in one. Keeping
    the solver's 1 Hz output for a 30-minute run wrote 1801 frames and a 5.5 MB file — fourteen
    times the chest contrast preset, for a study that changes more slowly. So the cadence
    follows the physiology: every second through the swallow, every five through the gastric
    phase, every thirty thereafter."""
    keep, last = [], -1e9
    for i, t in enumerate(times):
        step = 1.0 if t <= 30 else 5.0 if t <= 300 else 30.0
        if t - last >= step - 1e-6 or i == len(times) - 1:
            keep.append(i)
            last = t
    return keep


def pack(res, coat_conc):
    sel = _frames(res.times)
    out = dict(nS=NS, nT=len(sel), times=[res.times[i] for i in sel],
               cMax=C_MAX, wMax=W_MAX,
               coatConcMgMl=coat_conc, segments={}, notes=res.notes)
    xs = np.linspace(0, 1, NS)
    src = np.linspace(0, 1, N)
    for vid in ORDER:
        if vid not in res.lumen:
            continue
        lum = np.stack([np.interp(xs, src, res.lumen[vid][i]) for i in sel])
        wal = np.stack([np.interp(xs, src, res.wall[vid][i]) for i in sel])
        out['segments'][str(vid)] = dict(
            name=SEGMENTS[vid]['name'],
            lumen=np.clip(lum / C_MAX * 65535.0, 0, 65535).astype(np.uint16).ravel().tolist(),
            wall=np.clip(wal / W_MAX * 65535.0, 0, 65535).astype(np.uint16).ravel().tolist(),
        )
    return out


def timeline(gi_path, route='oral', volume_ml=150.0, conc_mg_ba_ml=588.0, over_s=5.0,
             gas_ml=0.0, erect=False, rot_x=0.0, rot_y=0.0, rot_z=0.0,
             duration_s=1800.0, dt=0.5):
    adm = Administration(route=route, volume_ml=volume_ml, conc_mg_ba_ml=conc_mg_ba_ml,
                         over_s=over_s, gas_ml=gas_ml)
    pose = Pose(rot_x=rot_x, rot_y=rot_y, rot_z=rot_z, erect=erect)
    res = solve(gi_path, adm, pose, Coating(), duration_s=duration_s, dt=dt, audit=True)
    return pack(res, conc_mg_ba_ml)


def main():
    import argparse
    ap = argparse.ArgumentParser(description='Ship a barium timeline with a model.')
    ap.add_argument('--model', required=True)
    ap.add_argument('--name', required=True)
    ap.add_argument('--route', default='oral', choices=['oral', 'rectal'])
    ap.add_argument('--volume-ml', type=float, default=150.0)
    ap.add_argument('--duration-s', type=float, default=1800.0)
    ap.add_argument('--erect', action='store_true')
    a = ap.parse_args()

    gi = os.path.join(a.model, f'{a.name}.gi.json')
    if not os.path.exists(gi):
        raise SystemExit(f'no {gi} — run build_gi first')
    print(f'solving {a.name}: {a.route}, {a.volume_ml:.0f} mL, '
          f'{"erect" if a.erect else "supine"}, {a.duration_s:.0f} s …', flush=True)
    tl = timeline(gi, route=a.route, volume_ml=a.volume_ml,
                  duration_s=a.duration_s, erect=a.erect)
    out = os.path.join(a.model, f'{a.name}.barium.json')
    with open(out, 'w') as f:
        json.dump(tl, f, separators=(',', ':'))
    print(f'  wrote {os.path.basename(out)}  {os.path.getsize(out)/1e6:.2f} MB')
    for n in tl['notes']:
        print('  ' + n)

    hp = os.path.join(a.model, f'{a.name}.model.json')
    with open(hp) as f:
        hdr = json.load(f)
    hdr['barium'] = f'{a.name}.barium.json'
    with open(hp, 'w') as f:
        json.dump(hdr, f, indent=1)
    print(f'  declared "barium" in {os.path.basename(hp)}')


if __name__ == '__main__':
    main()
