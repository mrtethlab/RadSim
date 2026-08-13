# Segment ML's photogrammetry OEC scan into a static body, an articulating C, and the
# boom arm (cross-arm + holder sleeve) between them.
#
# The scan (GEOEC_v1.obj, ~8.6 MB, 50k triangles) is one fused mesh of 821 disconnected
# fragments — no named parts, no joints. But the machine's geometry is enough to classify
# every fragment:
#   - the image intensifier and tube housing anchor a VERTICAL beam axis at local
#     x ~ 0.72 m, and their faces sit ~96 cm apart — the OEC's real SID to within 3 cm;
#   - the C's shell plates all fall on an annulus about the throat centre (0.72, 0.07),
#     radius 0.30–0.78 m, in the z ~ 0 plane;
#   - the whole box hanging below the arc (x > 0.33, y -0.90..-0.35) is the x-ray tube
#     extension — ML confirmed there is no separate cart there; it floats above the
#     floor (min y -0.85 vs floor -0.97), consistent with hanging from the C;
#   - the BOOM is the long horizontal member at y ~ 0 spanning x -0.92..+0.11, plus the
#     holder / L-arm cluster hanging at the front (x -0.21..0.13, down to y -0.6); the
#     vertical column at x -0.43..-0.2 stays with the cart (the lift telescopes past it);
#   - whatever fails every fence (cart, wheels, column) stays with the body.
# Pivots are pre-shifted at export: the C's to the throat centre (0.72, 0.07), the boom's
# to the column axis at throat height (-0.30, 0.07) — so in the app, wig-wag is a yaw
# about the boom's local origin, tilt a roll about its own long axis, and the C is still
# nothing but position = isocentre, quaternion = beam rotation.
#
# Usage:  python scripts/segment_oec.py <path-to-GEOEC_v1.obj>
# Output: apps/web/public/models/rigs/oec_rig.glb  (nodes 'body', 'boom' and 'carm')

import sys, os
import numpy as np
import trimesh

SRC = sys.argv[1] if len(sys.argv) > 1 else 'GEOEC_v1.obj'
OUT = os.path.join(os.path.dirname(__file__), '..',
                   'apps', 'web', 'public', 'models', 'rigs', 'oec_rig.glb')
CX, CY = 0.72, 0.07   # the C's rotation centre (beam axis x, throat mid-height), metres
XCOL = -0.30          # the column axis — the wig-wag pivot

m = trimesh.load(SRC, force='mesh')
parts = m.split(only_watertight=False)
cgrp, boom, body = [], [], []
for p in parts:
    x, y, z = p.centroid
    r = np.hypot(x - CX, y - CY)
    ii    = x > 0.40 and y > 0.33                             # image intensifier + covers
    tube  = abs(x - CX) < 0.25 and -0.47 < y < 0 and abs(z) < 0.30
    tube_ext = x > 0.33 and -0.90 < y < -0.35                 # the tank hanging below the arc
    arc   = 0.30 < r < 0.78 and y > -0.62 and x > 0.03
    if ii or tube or tube_ext or arc:
        cgrp.append(p); continue
    # The bar reaches x 0.11 at hub height — the arc's leftmost point (the flip-flop
    # hub) is at (0.10, 0.07), so the cross-arm meets the C directly with no L-arm
    # drop. The cluster hanging below (y < -0.16) is column-front hardware and stays
    # with the cart: on the real machine nothing below the hub moves with the boom.
    bar = -0.95 < x < 0.13 and -0.16 < y < 0.32 and abs(z) < 0.35
    (boom if bar else body).append(p)

cm = trimesh.util.concatenate(cgrp)
om = trimesh.util.concatenate(boom)
bm = trimesh.util.concatenate(body)
print(f'carm: {len(cgrp)} fragments, {len(cm.faces)} faces')
print(f'boom: {len(boom)} fragments, {len(om.faces)} faces')
print(f'body: {len(body)} fragments, {len(bm.faces)} faces')

grey = np.array([185, 187, 192, 255], np.uint8)
for g in (cm, om, bm):
    g.visual = trimesh.visual.ColorVisuals(g, vertex_colors=np.tile(grey, (len(g.vertices), 1)))
cm.apply_translation([-CX, -CY, 0.0])    # pivot at the throat centre
om.apply_translation([-XCOL, -CY, 0.0])  # pivot at the column axis, throat height

sc = trimesh.Scene()
sc.add_geometry(bm, node_name='body', geom_name='body')
sc.add_geometry(om, node_name='boom', geom_name='boom')
sc.add_geometry(cm, node_name='carm', geom_name='carm')
sc.export(OUT)
print('wrote', os.path.abspath(OUT), round(os.path.getsize(OUT) / 1e6, 2), 'MB')
