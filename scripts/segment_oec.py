# Segment ML's photogrammetry OEC scan into a static body and an articulating C.
#
# The scan (GEOEC_v1.obj, ~8.6 MB, 50k triangles) is one fused mesh of 821 disconnected
# fragments — no named parts, no joints. But the machine's geometry is enough to classify
# every fragment:
#   - the image intensifier and tube housing anchor a VERTICAL beam axis at local
#     x ~ 0.72 m, and their faces sit ~96 cm apart — the OEC's real SID to within 3 cm;
#   - the C's shell plates all fall on an annulus about the throat centre (0.72, 0.07),
#     radius 0.30–0.78 m, in the z ~ 0 plane;
#   - the workstation box (x > 0.55, y < -0.47) and the cart column (x < 0) fail both
#     fences and stay with the body.
# The C group is exported with its pivot pre-shifted to the throat centre, so the app
# articulates it with nothing but position = isocentre, quaternion = beam rotation.
#
# Usage:  python scripts/segment_oec.py <path-to-GEOEC_v1.obj>
# Output: apps/web/public/models/rigs/oec_rig.glb  (nodes 'body' and 'carm')

import sys, os
import numpy as np
import trimesh

SRC = sys.argv[1] if len(sys.argv) > 1 else 'GEOEC_v1.obj'
OUT = os.path.join(os.path.dirname(__file__), '..',
                   'apps', 'web', 'public', 'models', 'rigs', 'oec_rig.glb')
CX, CY = 0.72, 0.07  # the C's rotation centre (beam axis x, throat mid-height), metres

m = trimesh.load(SRC, force='mesh')
parts = m.split(only_watertight=False)
cgrp, body = [], []
for p in parts:
    x, y, z = p.centroid
    r = np.hypot(x - CX, y - CY)
    is_ws = x > 0.55 and y < -0.47                            # workstation box
    ii    = x > 0.40 and y > 0.33                             # image intensifier + covers
    tube  = abs(x - CX) < 0.25 and -0.47 < y < 0 and abs(z) < 0.30
    arc   = 0.30 < r < 0.78 and y > -0.62 and x > 0.03 and not is_ws
    (cgrp if (ii or tube or arc) else body).append(p)

cm = trimesh.util.concatenate(cgrp)
bm = trimesh.util.concatenate(body)
print(f'carm: {len(cgrp)} fragments, {len(cm.faces)} faces')
print(f'body: {len(body)} fragments, {len(bm.faces)} faces')

grey = np.array([185, 187, 192, 255], np.uint8)
for g in (cm, bm):
    g.visual = trimesh.visual.ColorVisuals(g, vertex_colors=np.tile(grey, (len(g.vertices), 1)))
cm.apply_translation([-CX, -CY, 0.0])   # pivot at the throat centre

sc = trimesh.Scene()
sc.add_geometry(bm, node_name='body', geom_name='body')
sc.add_geometry(cm, node_name='carm', geom_name='carm')
sc.export(OUT)
print('wrote', os.path.abspath(OUT), round(os.path.getsize(OUT) / 1e6, 2), 'MB')
