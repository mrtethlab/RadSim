"""Barium transport through the GI tract — the kinematic model of docs §5.

Not a fluid solver, and deliberately so. Free-surface flow of a non-Newtonian suspension in a
deformable peristaltic lumen under gravity is a research CFD problem; at the scale a
radiograph resolves, what actually determines the image is far simpler and far more teachable:

  WHERE the agent is along the tract, HOW FAST it is moving, WHICH WAY GRAVITY IS PULLING IT,
  and HOW MUCH has stuck to the wall.

Those are the four things this models, and each maps to something the operator does.

--- transport ------------------------------------------------------------------------------
Per segment, on the normalised arclength s in [0,1] from build_gi:

    dc/dt + d(u c)/ds = D d2c/ds2  -  coating exchange

`u` is NOT derived from a length over a time, because build_gi cannot measure the small
bowel's length (5 % of anatomy — the loops short-circuit at 2 mm). Instead each segment
carries a PHYSIOLOGICAL TRANSIT TIME and u = 1/T in normalised units per second. The geometry
supplies the path's order and shape, which it gets right; the clock comes from physiology.

--- gravity --------------------------------------------------------------------------------
This is what makes it a barium study rather than a diagram. Each arclength bin has a centroid
in model mm; rotating those into the patient's current pose gives an elevation profile h(s),
and the gravitational drive is -dh/ds. Turn the patient and the sign changes: barium that was
running downhill into the antrum now pools in the fundus. Positioning to move the agent IS the
examination, so the pose has to be a first-class input rather than a display setting.

Gravity is scaled by how MOBILE the agent is in that segment: a thin barium in an empty
stomach is very mobile; the same barium halfway down the small bowel, mixed with chyme, is
not. `mobility` per segment carries that.

--- coating --------------------------------------------------------------------------------
Double contrast is the reason barium studies survived CT. Barium coats the mucosa, gas
distends the lumen, and the diagnostic image is the coated wall seen through gas. So the wall
carries its own state:

    dw/dt = k_on c (1 - w/w_max) - k_off w

w persists after the lumen clears, which is precisely what makes the mucosal relief visible.
w_max is a surface density, so it is reported per unit area and the renderer turns it into a
path length through a coating of finite thickness.

--- the gas phase lives in the browser, not here --------------------------------------------
Double contrast is implemented in apps/web/src/core/giSolve.js and NOT in this module. That is
a deliberate divergence, not an oversight, and it is the one place the two are not the same
model. The defining behaviour of a gas phase is that it re-levels the instant the patient is
turned — gas to whatever is now uppermost, barium into what has just become dependent — and
this module solves a batch with ONE fixed pose, where that has no meaning. The export path
(gi_export.py) ships single-contrast timelines for the same reason.

The single-contrast model below remains the reference for the browser port, and the port was
re-checked against it after the gas phase went in: with no gas the browser reproduces these
numbers unchanged (worst case 1e-10 relative on segment mass, every pose).

--- what this does NOT model ---------------------------------------------------------------
Segmentation contractions, retropulsion in the antrum, ileocaecal valve competence, flocculation
of barium in a wet small bowel, and the difference between a high- and low-density suspension
in anything but concentration. Those are real and some are diagnostic; none is a first-pass
teaching point about timing and positioning.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field

import numpy as np
from scipy.linalg import solve_banded

# Physiology, per segment: (transit time seconds, dispersion, gravity mobility 0..1).
# Transit times are order-of-magnitude clinical, not fitted: an oesophageal stripping wave
# clears in seconds; a stomach empties a barium meal over tens of minutes; small bowel follow-
# through is the classic 2-4 hours to the caecum; the colon is measured in days but a barium
# enema fills it retrogradely in minutes, which is handled by running the tract backwards.
# `radius_cm` is the physiological lumen radius, used for the MUCOSAL AREA (2V/r). It is not
# taken from A(s) because A(s) is a cross-section, not a wall area — and worse, for the small
# bowel it is the cross-section of a bin containing many loops at once, which is not a tube
# at all. Volume and a known radius are both trustworthy where the measured length is not.
SEGMENTS = {
    48: dict(name='Oesophagus',  transit_s=8.0,     disp=0.010, mobility=0.95, radius_cm=1.0),
    49: dict(name='Stomach',     transit_s=1800.0,  disp=0.060, mobility=0.90, radius_cm=5.0),
    50: dict(name='Duodenum',    transit_s=120.0,   disp=0.030, mobility=0.55, radius_cm=1.5),
    51: dict(name='Small bowel', transit_s=9000.0,  disp=0.040, mobility=0.35, radius_cm=1.2),
    52: dict(name='Colon',       transit_s=43200.0, disp=0.050, mobility=0.45, radius_cm=2.5),
}
ORDER = [48, 49, 50, 51, 52]

N = 128                 # arclength nodes per segment
# Gravity MODULATES each segment's own transit rate rather than adding a velocity of its own.
# The first version added it: u = u0 + gravity, with gravity ~0.5/s against a gastric u0 of
# 1/1800 = 0.00056/s. Gravity was a thousand times peristalsis, so the whole tract drained in
# seconds regardless of physiology. Expressed as a multiplier, a fully dependent segment runs
# at (1 + G_GAIN x mobility) times its normal rate and a fully anti-dependent one can stall or
# reverse — which is the behaviour the operator is exploiting when they turn the patient.
G_GAIN = 1.5


@dataclass
class Administration:
    """What was given, how, and when."""
    route: str = 'oral'          # 'oral' (swallow) | 'rectal' (enema)
    volume_ml: float = 150.0
    conc_mg_ba_ml: float = 588.0  # 100 % w/v BaSO4 = 588 mg elemental Ba/mL
    over_s: float = 5.0           # a swallow is seconds; an enema runs over minutes
    start_s: float = 0.0
    gas_ml: float = 0.0           # CO2 for double contrast

    def rate_mg_s(self, t):
        # Half-open [start, start+over). Inclusive at both ends delivered one timestep too
        # many — 11 steps of a 5 s administration at dt=0.5, so 97.0 g went in where 88.2 g
        # was prescribed. The mass audit read +10 % and the solver took the blame for it.
        if t < self.start_s or t >= self.start_s + self.over_s:
            return 0.0
        return self.volume_ml * self.conc_mg_ba_ml / max(self.over_s, 1e-3)


@dataclass
class Pose:
    """Patient orientation, as the object rotate/tilt sliders set it (degrees).

    erect=True puts the long axis vertical, which is how a swallow and a stomach study are
    actually done; supine is the default for a small-bowel follow-through and an enema."""
    rot_x: float = 0.0
    rot_y: float = 0.0
    rot_z: float = 0.0
    erect: bool = False

    def gravity_dir(self):
        """Unit vector of 'down' in MODEL coordinates.

        Model axes are (x lateral, y anteroposterior, z cranio-caudal). Supine, down is -y
        (posterior, toward the table). Erect, down is -z (toward the feet). The rotations are
        then applied in reverse to bring world-down into the model's frame."""
        g = np.array([0.0, 0.0, -1.0]) if self.erect else np.array([0.0, -1.0, 0.0])
        for axis, deg in ((0, self.rot_x), (1, self.rot_y), (2, self.rot_z)):
            a = math.radians(-deg)
            c, s = math.cos(a), math.sin(a)
            R = np.eye(3)
            if axis == 0:
                R[1, 1], R[1, 2], R[2, 1], R[2, 2] = c, -s, s, c
            elif axis == 1:
                R[0, 0], R[0, 2], R[2, 0], R[2, 2] = c, s, -s, c
            else:
                R[0, 0], R[0, 1], R[1, 0], R[1, 1] = c, -s, s, c
            g = R @ g
        n = np.linalg.norm(g)
        return g / n if n else g


@dataclass
class Coating:
    k_on: float = 0.010          # per second per (mg/mL) — how readily it sticks
    k_off: float = 0.0009        # per second — how readily it washes off
    w_max: float = 12.0          # mg/cm2 saturation of the mucosal layer


@dataclass
class Result:
    times: list
    lumen: dict = field(default_factory=dict)     # vid -> (nT, N) mg/mL
    wall: dict = field(default_factory=dict)      # vid -> (nT, N) mg/cm2
    notes: list = field(default_factory=list)
    audit: list = field(default_factory=list)     # (t, given, lumen, mucosa, past, transit)


class Tube:
    """One segment's lumen, transported semi-Lagrangian + implicit diffusion.

    The first version of this used explicit upwind advection and a centred Laplacian, which
    blew up on the first run — and instructively so. The oesophagus transits in 8 s, so
    u = 0.125 in normalised units; with 128 nodes a parcel crosses a cell in ds/u = 63 ms,
    against the 250 ms timestep. The Courant number was 4 before gravity was even added.
    Shrinking dt enough to satisfy BOTH that and the diffusive limit ds^2/2D would have meant
    ~5 ms steps and hours of wall clock for a follow-through.

    So the same scheme the contrast solver uses, for the same reason: semi-Lagrangian
    advection has no Courant limit, and backward-Euler diffusion has no diffusive limit.
    Velocity varies along s here (gravity does), but that only makes the departure map
    non-uniform, which costs nothing — it is still precomputed once, since the pose does not
    change during a solve."""

    def __init__(self, u, disp, ds, n):
        self.n, self.ds = n, ds
        self.c = np.zeros(n)
        self.u = u

    def set_dt(self, u, disp, dt):
        n, ds = self.n, self.ds
        self.dt = dt
        self.u = u
        xi = np.arange(n) - u * dt / ds            # where each cell's contents came from
        i0 = np.floor(xi).astype(np.int64)
        self.w = xi - i0
        # Pad BOTH ends. Gravity can reverse the flow — it is meant to, that is how a
        # dependent fundus holds barium — and a reversed cell's departure point lies
        # DOWNSTREAM, past the outlet. Clamping those to the last cell made several outlet
        # cells gather the same value and duplicated it: a pose-dependent mass EXCESS, +2.1 %
        # in left lateral decubitus where 44 % of the colon runs backwards, against +0.01 %
        # erect where almost nothing does. Nothing flows back in from beyond the outlet, so
        # the downstream pad is zero.
        self.pad = int(max(0, -i0.min()))          # cells that came from upstream of s=0
        self.pad_hi = int(max(0, i0.max() + 1 - (n - 1)))
        self.idx = i0 + self.pad
        self._ext = np.zeros(n + self.pad + self.pad_hi)
        r = dt / ds ** 2
        ab = np.zeros((3, n))
        Dp = np.full(n, disp); Dp[-1] = 0.0        # zero flux out of the far end
        Dm = np.full(n, disp); Dm[0] = 0.0         # zero flux back out of the inlet
        ab[0, 1:] = (-r * Dp)[:-1]
        ab[1, :] = 1.0 + r * (Dm + Dp)
        ab[2, :-1] = (-r * Dm)[1:]
        self._ab = ab

    def step(self):
        """Advance one step. Returns the concentration that advected off the far end.

        Nothing enters through the upstream padding: incoming mass is added at node 0 by the
        caller instead. Feeding an inlet CONCENTRATION into the padding was the first version
        and it manufactured barium — every one of the `pad` upstream cells took that value, so
        the mass admitted was pad times the mass handed over, and pad grows with u*dt/ds. The
        duodenum was reading 64,682 mg/mL against an administered 588."""
        before = self.c.sum()
        # Outflow at the ends, upwind, computed BEFORE the gather. It has to be explicit:
        # semi-Lagrangian advection is conservative only for a UNIFORM velocity, and u varies
        # along s here because gravity does. Inferring the outflow from the change in total
        # mass therefore attributed the scheme's own divergence error to the boundaries — a
        # pose-dependent gain of up to +4.7 % (prone), and the reason an isolated tube with
        # constant u conserved perfectly while the real tract did not.
        r = self.dt / self.ds
        ext = self._ext
        ext[:] = 0.0
        ext[self.pad:self.pad + self.n] = self.c
        i = self.idx
        lo = ext[i]
        hi = ext[i + 1]
        cs = lo + self.w * (hi - lo)
        # Let the scheme set the SHAPE and impose the conservation law on top of it. This is
        # the standard remedy for non-conservative semi-Lagrangian transport, and it is honest
        # about which part is doing what: the interpolation decides where the bolus is, the
        # rescale decides how much of it there is.
        # Normalise the gathered field back to the mass that went in. The gather decides the
        # SHAPE; this restores the conservation law the scheme does not obey. Doing it before
        # the boundary flux matters: subtracting the flux from `target` as well as letting the
        # gather drop it took the same mass out twice and cost -26 % prone.
        tot = cs.sum()
        if tot > 1e-12:
            cs *= before / tot
        # Now the outflow, upwind and explicit, off the end cells of the conserved field.
        self._out_fwd = min(cs[-1] * max(self.u[-1], 0.0) * r, cs[-1])
        self._out_back = min(cs[0] * max(-self.u[0], 0.0) * r, cs[0])
        cs[-1] -= self._out_fwd
        cs[0] -= self._out_back
        self.c = solve_banded((1, 1), self._ab, cs, overwrite_b=True, check_finite=False)
        np.clip(self.c, 0.0, None, out=self.c)
        # Diffusion is zero-flux so it conserves; what is missing left one end or the other.
        # Split it by which way the ends are flowing: barium going back out of the INLET is
        # reflux, and it belongs to the segment upstream — gastro-oesophageal reflux is a
        # finding a barium study exists to show, not an error to discard.
        return self._out_fwd, self._out_back

    def add_mass(self, conc, ceiling=None):
        """Put an incoming parcel in at the inlet, overflowing forward if it will not fit.

        A node cannot hold a higher concentration than the suspension that was administered —
        there is no mechanism here that removes water. Injecting a whole timestep's dose into
        one node ignored that and produced 24,500 mg/mL in the oesophagus against an
        administered 588. Filling and overflowing is also what the anatomy does: 150 mL of
        barium does not fit in a 46 mL oesophagus, it flows onward."""
        if conc <= 0:
            return 0.0
        if ceiling is None:
            self.c[0] += conc
            return 0.0
        excess = conc
        for i in range(self.n):
            room = max(ceiling - self.c[i], 0.0)
            take = min(room, excess)
            self.c[i] += take
            excess -= take
            if excess <= 0:
                return 0.0
        return excess          # the tube is full to the brim; caller passes it on


def _height_profile(seg, gdir):
    """Elevation along a segment under the current pose, normalised to [0,1] over the tract.

    Returns h at each of the N nodes. Bins with no voxels come back as NaN in the geometry;
    they are filled by interpolation so the gradient stays finite."""
    c = np.array([[np.nan if v is None else v for v in p] for p in seg['centreMM']],
                 dtype=float)
    ok = np.isfinite(c).all(axis=1)
    if ok.sum() < 2:
        return np.zeros(N)
    h = c[ok] @ (-gdir)                       # height = projection onto 'up'
    x = np.linspace(0, 1, len(c))
    h_full = np.interp(x, x[ok], h)
    hs = np.interp(np.linspace(0, 1, N), x, h_full)
    return hs


def solve(gi_path, adm: Administration, pose: Pose = None, coat: Coating = None,
          duration_s: float = 600.0, dt: float = 0.25, audit: bool = False):
    """Run the tract forward. Returns concentration in the lumen and on the wall over time."""
    pose = pose or Pose()
    coat = coat or Coating()
    with open(gi_path) as f:
        gi = json.load(f)
    segs = gi['segments']
    order = [v for v in ORDER if str(v) in segs]
    if not order:
        raise ValueError('this model has no GI segments — run build_gi first')
    if adm.route == 'rectal':
        order = order[::-1]                    # an enema fills the tract retrogradely

    gdir = pose.gravity_dir()
    ds = 1.0 / (N - 1)
    c = {v: np.zeros(N) for v in order}        # mg/mL in the lumen
    w = {v: np.zeros(N) for v in order}        # mg/cm2 on the wall
    # per-segment volume per node, so mass entering converts to a concentration
    vol_node = {}
    for v in order:
        ml = max(float(segs[str(v)]['volumeML']), 1e-3)
        vol_node[v] = ml / N
    hprof = {v: _height_profile(segs[str(v)], gdir) for v in order}
    # normalise the height scale across the whole tract so mobility is comparable segment
    # to segment; a 1.0 gradient then means "this segment drops the height of the abdomen"
    span = 1.0
    allh = np.concatenate([hprof[v] for v in order])
    if np.isfinite(allh).any():
        span = max(float(np.nanmax(allh) - np.nanmin(allh)), 1.0)

    # ---- set each segment up once: velocity field, departure map, diffusion band ---------
    tubes, area_cm2 = {}, {}
    for v in order:
        p = SEGMENTS[v]
        u0 = 1.0 / max(p['transit_s'], 1e-3)              # normalised units per second
        # gravity: -dh/ds scaled by mobility. Downhill adds to the peristaltic drive, uphill
        # subtracts from it and can stall or reverse the front — which is the whole reason
        # the operator turns the patient.
        dh = np.gradient(hprof[v] / span, ds)
        ug = np.clip(-dh * G_GAIN * p['mobility'], -2.0, 4.0)
        sgn = -1.0 if adm.route == 'rectal' else 1.0      # peristalsis opposes an enema
        u = sgn * u0 * (1.0 + ug)                         # gravity MODULATES the rate
        t = Tube(u, p['disp'], ds, N)
        t.set_dt(u, p['disp'], dt)
        tubes[v] = t
        # MUCOSAL area per node = 2 x volume / radius, the surface of a cylinder holding
        # that volume. A(s) is a CROSS-SECTION, and using it as a wall area gave the small
        # bowel 5900 cm2 of mucosa — 71 g of coating capacity against an 88 g dose, which is
        # why the first run put 95 % of the barium on the wall and left the lumen empty.
        # Volume and a known radius are both trustworthy where the measured length is not.
        area_cm2[v] = np.full(N, 2.0 * vol_node[v] / p['radius_cm'])

    steps = int(round(duration_s / dt))
    keep = max(1, int(round(1.0 / dt)))         # store at 1 Hz
    times, lum_out, wall_out = [], {v: [] for v in order}, {v: [] for v in order}
    spill = 0.0                                 # mass leaving the last segment
    handover = {v: 0.0 for v in order}          # concentration offered to each inlet
    audit_rows, given_so_far = [], 0.0

    for k in range(steps + 1):
        t = k * dt
        # ---- administration into the first segment's inlet -------------------------------
        mg = adm.rate_mg_s(t) * dt
        given_so_far += mg
        c_in_first = mg / vol_node[order[0]] if mg > 0 else 0.0

        for i, v in enumerate(order):
            tube = tubes[v]
            # incoming mass goes in as a parcel at node 0, never through the padding
            # The administration AND anything refluxed back into this segment. Passing only
            # c_in_first for i == 0 and then zeroing handover[0] discarded every gram the
            # stomach pushed back into the oesophagus — which prone and head-down positioning
            # actively promote, so prone lost 26 % of the dose while every other pose closed
            # exactly. Gastro-oesophageal reflux is a finding a barium study exists to show;
            # throwing it away was both a mass leak and the wrong physiology.
            over = tube.add_mass((c_in_first if i == 0 else 0.0) + handover[v],
                                 ceiling=adm.conc_mg_ba_ml)
            handover[v] = 0.0
            if over > 0:                                  # this segment is brim full
                if i + 1 < len(order):
                    handover[order[i + 1]] += over * vol_node[v] / vol_node[order[i + 1]]
                else:
                    spill += over * vol_node[v]
            left, refluxed = tube.step()                  # off the far end / back out the inlet

            # ---- coating exchange --------------------------------------------------------
            cv = tube.c
            # Exchange is written as ONE mass transfer that both sides derive from, so it is
            # conservative by construction. Updating each side independently and clipping
            # afterwards was not: the clip on the lumen at zero invented mass that the wall had
            # already been credited with. It cost +0.44 % on a single segment over 3600 steps,
            # and up to +2.1 % over a whole tract in the poses with the most reversed flow.
            # (In Tube.step the same clip is harmless, because the return value is measured
            # after it and absorbs whatever it changed.)
            on = coat.k_on * cv * np.clip(1.0 - w[v] / coat.w_max, 0.0, 1.0)
            off = coat.k_off * w[v]
            dm = (on - off) * area_cm2[v] * dt                   # mg lumen -> wall
            dm = np.minimum(dm, cv * vol_node[v])                # cannot take what is not there
            dm = np.maximum(dm, -w[v] * area_cm2[v])             # nor give back more than stuck
            dm = np.minimum(dm, (coat.w_max - w[v]) * area_cm2[v])   # nor exceed saturation
            cv -= dm / max(vol_node[v], 1e-6)
            w[v] += dm / np.maximum(area_cm2[v], 1e-9)

            # ---- hand the tail over to the next segment -----------------------------------
            if left > 0:
                mass = left * vol_node[v]
                if i + 1 < len(order):
                    nxt = order[i + 1]
                    handover[nxt] += mass / vol_node[nxt]
                else:
                    spill += mass
            if refluxed > 0:
                mass = refluxed * vol_node[v]
                if i > 0:
                    prv = order[i - 1]
                    handover[prv] += mass / vol_node[prv]
                else:
                    spill += mass                     # out of the mouth (or the rectum)

        if audit:
            # Every gram is either in a lumen, on a mucosa, in transit, or past the end. The
            # contrast solver earned this discipline the hard way (docs §6.1): a transport
            # model whose mass is not closed is telling you a story, not a result.
            lum = sum(float(tubes[q].c.sum()) * vol_node[q] for q in order)
            muc = sum(float((w[q] * area_cm2[q]).sum()) for q in order)
            pend = sum(handover[q] * vol_node[q] for q in order)
            audit_rows.append((t, given_so_far, lum, muc, spill, pend))

        if k % keep == 0:
            times.append(round(t, 2))
            for v in order:
                lum_out[v].append(tubes[v].c.copy())
                wall_out[v].append(w[v].copy())

    res = Result(times=times)
    for v in order:
        res.lumen[v] = np.array(lum_out[v])
        res.wall[v] = np.array(wall_out[v])
    given = adm.volume_ml * adm.conc_mg_ba_ml
    held = sum(float(res.lumen[v][-1].sum()) * vol_node[v] for v in order)
    # Use the SAME mucosal area the solve used. This tallied with areaMM2 while the solve had
    # already moved to 2V/r, so it reported 106 g of coating against an 88 g dose — the model
    # was fine and the report was lying about it.
    stuck = sum(float((res.wall[v][-1] * area_cm2[v]).sum()) for v in order)
    res.notes.append(f'given {given/1000:.1f} g Ba; at {duration_s:.0f} s '
                     f'{held/1000:.1f} g in the lumen, {stuck/1000:.1f} g on the mucosa, '
                     f'{spill/1000:.1f} g past the end')
    if audit:
        res.audit = audit_rows
        t_, giv, lum, muc, sp, pend = audit_rows[-1]
        tot = lum + muc + sp + pend
        err = (tot - giv) / giv * 100.0 if giv else 0.0
        res.notes.append(f'MASS AUDIT at {t_:.0f} s: given {giv/1000:.3f} g, accounted '
                         f'{tot/1000:.3f} g (lumen {lum/1000:.3f} + mucosa {muc/1000:.3f} + '
                         f'past-end {sp/1000:.3f} + in transit {pend/1000:.3f}) = {err:+.2f} %')
    return res
