"""Ship a solved contrast timeline with a model, and declare it in the manifest.

Browser-only users have no haemodynamic solver, so a model that carries a preset timeline can
still show contrast — fixed protocol, but the timing, the phases and bolus tracking all work.
The chest has had one since Phase 4; this is how any model gets one.

Generating the preset and declaring it are ONE step on purpose. They were two, and the
declaration was a hand-edit of the .model.json — which build_model.py rewrites from scratch
every time it runs, so the next rebuild silently dropped it and the panel went back to
"needs the Python compute service" with the preset sitting right there on disk.

    python -m app.build_contrast_preset --model ../../apps/web/public/models/chest --name chest

Protocol is the reference one (100 mL of 350 mgI/mL at 4 mL/s + 40 mL saline, average adult),
so presets across models are directly comparable.
"""
import argparse
import json
import os

from .contrast_export import timeline


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True, help='model folder')
    ap.add_argument('--name', required=True)
    ap.add_argument('--volume-ml', type=float, default=100.0)
    ap.add_argument('--rate-ml-s', type=float, default=4.0)
    ap.add_argument('--conc', type=float, default=350.0)
    ap.add_argument('--saline-ml', type=float, default=40.0)
    a = ap.parse_args()

    vessels = os.path.join(a.model, f'{a.name}.vessels.json')
    if not os.path.exists(vessels):
        raise SystemExit(f'no {vessels} — run build_vessels first')

    print(f'solving {a.name}: {a.volume_ml:.0f} mL @ {a.rate_ml_s:.1f} mL/s, '
          f'{a.conc:.0f} mgI/mL + {a.saline_ml:.0f} mL saline …', flush=True)
    tl = timeline(vessels, volume_ml=a.volume_ml, rate_ml_s=a.rate_ml_s,
                  conc_mgi_ml=a.conc, saline_ml=a.saline_ml)

    out = os.path.join(a.model, f'{a.name}.contrast.json')
    with open(out, 'w') as f:
        json.dump(tl, f, separators=(',', ':'))
    print(f'  wrote {os.path.basename(out)}  {os.path.getsize(out) / 1e6:.2f} MB')

    hp = os.path.join(a.model, f'{a.name}.model.json')
    with open(hp) as f:
        hdr = json.load(f)
    hdr['contrast'] = f'{a.name}.contrast.json'
    with open(hp, 'w') as f:
        json.dump(hdr, f, indent=1)
    print(f'  declared "contrast" in {os.path.basename(hp)} — the loader keys off this, '
          'not off the file being present')


if __name__ == '__main__':
    main()
