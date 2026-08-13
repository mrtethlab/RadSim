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
#   - the BOOM is the long horizontal member at y ~ 0 reaching the flip-flop hub at the
#     front and carrying the UPPER pair of rear handles (y > -0.05); the lower pair and
#     the base's top cover (y < -0.05 at the rear) stay with the cart — ML's check: each
#     of boom and base shows exactly two handles at the back;
#   - the COLUMN is the vertical telescoping mass at x -0.55..-0.24 between the cart top
#     and the boom; it rises with lift and nothing else. The cluster in front of it
#     (x > -0.24, y < -0.16 — cables, steering hardware) stays with the body;
#   - whatever fails every fence (cart, wheels, cables) stays with the body.
# Pivots are pre-shifted at export: the C's to the throat centre (0.72, 0.07), the boom's
# to the column axis at throat height (-0.30, 0.07); the column keeps body coordinates
# (it only ever translates). In the app, wig-wag yaws the boom about its local origin,
# tilt rotates the C ALONE (the flip-flop line through hub and arc centre is the axis the
# C already turns about), and the C is still position = isocentre, quaternion = beam.
#
# Usage:  python scripts/segment_oec.py <path-to-GEOEC_v1.obj>
# Output: apps/web/public/models/rigs/oec_rig.glb  (nodes 'body', 'column', 'boom', 'carm')

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
cgrp, boom, col, body = [], [], [], []
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
    # drop. The bar's floor is y -0.05: the rear pieces below it (base top cover +
    # the LOWER handle pair) belong to the cart. The bracket under the bar's front
    # end (down to -0.16, in front of the column) slides with the boom.
    bar  = -0.95 < x < 0.13 and -0.05 < y < 0.32 and abs(z) < 0.35
    brkt = -0.24 < x < 0.13 and -0.16 < y <= -0.05 and abs(z) < 0.35
    if bar or brkt:
        boom.append(p); continue
    column = -0.55 < x < -0.24 and -0.50 < y < -0.045 and abs(z) < 0.35
    (col if column else body).append(p)

cm = trimesh.util.concatenate(cgrp)
om = trimesh.util.concatenate(boom)
km = trimesh.util.concatenate(col)
bm = trimesh.util.concatenate(body)
print(f'carm:   {len(cgrp)} fragments, {len(cm.faces)} faces')
print(f'boom:   {len(boom)} fragments, {len(om.faces)} faces')
print(f'column: {len(col)} fragments, {len(km.faces)} faces')
print(f'body:   {len(body)} fragments, {len(bm.faces)} faces')

grey = np.array([185, 187, 192, 255], np.uint8)
for g in (cm, om, km, bm):
    g.visual = trimesh.visual.ColorVisuals(g, vertex_colors=np.tile(grey, (len(g.vertices), 1)))
cm.apply_translation([-CX, -CY, 0.0])    # pivot at the throat centre
om.apply_translation([-XCOL, -CY, 0.0])  # pivot at the column axis, throat height
# the column keeps body coordinates: it only ever translates (lift)

sc = trimesh.Scene()
sc.add_geometry(bm, node_name='body', geom_name='body')
sc.add_geometry(km, node_name='column', geom_name='column')
sc.add_geometry(om, node_name='boom', geom_name='boom')
sc.add_geometry(cm, node_name='carm', geom_name='carm')
sc.export(OUT)
print('wrote', os.path.abspath(OUT), round(os.path.getsize(OUT) / 1e6, 2), 'MB')
