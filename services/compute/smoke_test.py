"""Quick smoke test for /project/voxel and /ct/slices (run with the venv python)."""
import json
import time
import urllib.request

import numpy as np

BASE = "http://localhost:8000"
NMAT, NB = 28, 12


def post(path, payload):
    req = urllib.request.Request(BASE + path, json.dumps(payload).encode(),
                                 {"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req) as r:
        data = r.read()
        shape = tuple(int(s) for s in r.headers["X-Shape"].split("x"))
    dt = time.time() - t0
    arr = np.frombuffer(data, dtype=np.float32).reshape(shape)
    return arr, dt


mu = (np.full((NMAT, NB), 0.2)).tolist()
w = (np.full(NB, 1.0 / NB)).tolist()

for nx, ny, label in [(320, 400, "quick"), (2500, 3070, "std-DR")]:
    arr, dt = post("/project/voxel", dict(
        model="chest", flips=[False, False, False], center=[0.0, 14.85, 0.0],
        source=[0.0, 100.0, 0.0], detCenter=[0.0, 0.0, 0.0],
        detU=[1.0, 0.0, 0.0], detV=[0.0, 0.0, 1.0],
        nx=nx, ny=ny, pxU=35.0 / nx, pxV=43.0 / ny,
        binsW=w, muMat=mu, I0=100.0, refDist=100.0,
        coneD=[0.0, -1.0, 0.0], coneW=[1.0, 0.0, 0.0], coneL=[0.0, 0.0, 1.0],
        coneTw=0.35, coneTl=0.35))
    print(f"project {label}: shape={arr.shape} min={arr.min():.3g} max={arr.max():.3g} "
          f"mean={arr.mean():.3g} time={dt:.2f}s")

for n_det, n_ang, N, label in [(128, 128, 128, "quick"), (800, 720, 512, "realistic")]:
    sfov_r = 25.0
    dfov_r = 17.5
    ds = (2 * dfov_r) / n_det if label == "quick" else (2 * sfov_r) / n_det
    ray_r = dfov_r if label == "quick" else sfov_r
    arr, dt = post("/ct/slices", dict(
        model="chest", flips=[False, True, True], center=[0.0, 6.0, 0.0],
        z0List=[0.0, 2.0, 4.0, 6.0], cx=0.0, cy=6.0,
        nDet=n_det, nAngles=n_ang, gridN=N, ds=ds, rayR=ray_r, dfovR=dfov_r,
        muArr=[0.2] * NMAT, photons0=1e5))
    print(f"ct {label}: shape={arr.shape} min={arr.min():.3g} max={arr.max():.3g} "
          f"time={dt:.2f}s ({dt/4:.2f}s/slice)")
