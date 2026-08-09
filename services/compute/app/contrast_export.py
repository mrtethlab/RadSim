"""Pack a solver run into the compact timeline the renderer consumes.

The solver's state already lives on the vascular graph rather than the voxel grid (docs
§1), so a whole 90 s run is ~1.4 MB as float32. That is small enough to send as-is, but it
crosses the wire on every injector change, so it is worth packing properly:

  - arclength is resampled from the solver's 200 nodes to N_S=64. Concentration along a
    vessel is smooth — it is the solution of an advection-diffusion equation, so it has no
    features narrower than the dispersion length — and 64 samples over a 40 cm aorta is
    6 mm, finer than the bolus front is sharp.
  - values are quantised to uint16 over [0, cmax]. At a 400 mgI/mL ceiling one step is
    0.006 mgI/mL, i.e. 0.16 HU: far below image noise.

That is ~200 KB per run instead of 1.4 MB, and it decodes to a Float32Array in one pass.

The renderer never sees mgI/mL as HU — it multiplies concentration by iodine's real mu(E)
per the spectrum in use (materials.js muIodinePerConc), which is what makes an 80 kVp scan
show roughly twice the iodine signal of a 120 kVp one.
"""
from __future__ import annotations

import numpy as np

from .contrast_solver import solve, Injection, Patient

N_S = 64          # arclength samples kept per vessel
C_MAX = 400.0     # mgI/mL quantisation ceiling — well above any physiological peak

# Which material id each perfused organ is stamped as in the voxel legend. The solver
# names the beds; build_model.py numbers the materials, and this is the only place the two
# have to agree.
ORGAN_MATERIAL = {'liver': 11, 'spleen': 12, 'kidney': 13, 'pancreas': 14}

# The heart is ONE material id (15), but its right and left chambers opacify ~8 s apart —
# that difference is the whole point of a PE study, where an enhanced PA sits next to an
# enhanced aorta. Until heartchambers_highres is licensed (docs §4.3.1) there is no
# chamber label to hang them on, so the myocardium+chambers get the mean of the two and
# the timeline records that it is an approximation rather than hiding it.
HEART_MATERIAL = 15


def pack(result: dict) -> dict:
    """Compact a solve() result. Returns plain JSON-safe types."""
    times = result['times_s']
    nt = len(times)
    out_v = {}
    for vid, v in result['vessels'].items():
        c = np.asarray(v['c_mgi_ml'], dtype=np.float32)        # (nt, n_nodes)
        # resample arclength: linear over the node axis, which is already normalised s
        src = np.linspace(0.0, 1.0, c.shape[1])
        dst = np.linspace(0.0, 1.0, N_S)
        r = np.empty((nt, N_S), dtype=np.float32)
        for i in range(nt):
            r[i] = np.interp(dst, src, c[i])
        q = np.clip(r / C_MAX * 65535.0, 0, 65535).astype(np.uint16)
        out_v[str(vid)] = q.ravel().tolist()

    organs = {}
    for name, series in result['organs'].items():
        mat = ORGAN_MATERIAL.get(name)
        if mat is None:
            continue
        q = np.clip(np.asarray(series['c_mgi_ml']) / C_MAX * 65535.0, 0, 65535)
        organs[str(mat)] = q.astype(np.uint16).tolist()

    # heart: mean of the two chamber concentrations, flagged as approximate
    rh = np.asarray(result.get('right_heart_c') or [0.0] * nt, dtype=np.float64)
    lh = np.asarray(result.get('left_heart_c') or [0.0] * nt, dtype=np.float64)
    heart = np.clip((rh + lh) * 0.5 / C_MAX * 65535.0, 0, 65535)
    organs[str(HEART_MATERIAL)] = heart.astype(np.uint16).tolist()

    return dict(
        nS=N_S, cMax=C_MAX, nT=nt, times=list(times),
        vessels=out_v, organs=organs,
        audit={k: float(v) for k, v in result['audit'].items()},
        injection=result['injection'], patient=result['patient'],
        approximations=['heart chambers share one material id — right and left are '
                        'averaged; needs heartchambers_highres (docs 4.3.1)'],
    )


def timeline(vessels_path: str, volume_ml=100.0, rate_ml_s=4.0, conc_mgi_ml=350.0,
             delay_s=0.0, saline_ml=40.0, cardiac_output_l_min=5.0,
             blood_volume_ml=5000.0, duration_s=90.0) -> dict:
    inj = Injection(volume_ml=volume_ml, rate_ml_s=rate_ml_s, conc_mgi_ml=conc_mgi_ml,
                    saline_ml=saline_ml, start_s=delay_s)
    pat = Patient(cardiac_output_l_min=cardiac_output_l_min, blood_volume_ml=blood_volume_ml)
    return pack(solve(vessels_path, inj, pat, duration_s=duration_s))
