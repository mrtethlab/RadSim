"""Haemodynamic solver: injector settings -> iodine concentration everywhere, vs time.

Produces C(s, t) along each vessel and C(t) for each organ bed, which is what the renderer
samples (docs/contrast-simulation.md §1). Small enough to run on demand — there is no
precomputed library — so every injector parameter stays freely continuous.

WHAT IS ACTUALLY SOLVED

  1. Vessels: 1-D advection-dispersion,  dc/dt + u dc/ds = D d2c/ds2,  with u = Q/A(s) from
     the measured area profile. This is the real transport model for a bolus in a large
     vessel: it produces the spreading, the dilution and the long tail of a measured
     time-attenuation curve, none of which a pure delay-line would.

     On the dispersion coefficient, precisely: the textbook Taylor-Aris result
     D = D_mol + a^2 u^2 / (48 D_mol) is derived for steady laminar flow, and at
     physiological Reynolds numbers with iodine's tiny molecular diffusivity it diverges to
     absurd values. What is used here is the form that survives in the haemodynamic
     literature, D = k * u * a — dispersion proportional to velocity and radius. Same
     scaling, calibrated constant. Calling it "Taylor-Aris" without that caveat would be
     overclaiming.

  2. Chambers (heart, lungs, the rest of the body): well-mixed, V dC/dt = Q(C_in - C).
     A bolus leaves a mixing chamber smeared by an exponential of time constant V/Q, which
     is most of why an aortic curve is broader than the injection that produced it.

  3. Organ beds: two compartments, intravascular and extravascular extracellular, exchanging
     across a permeability-surface product. Gives parenchymal enhancement and washout with
     the right shape, and the difference between renal and hepatic timing falls out of their
     different flows rather than being scripted.

  4. Recirculation: the loop closes. Without it every curve decays to zero after first pass,
     which is wrong by ~40 s and wrong in a way students would notice.

Reference for the compartmental approach: Bae, "Intravenous contrast medium administration
and scan timing at CT", Radiology 2010.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

import numpy as np
from scipy.linalg import solve_banded

# ---- clinical constants ----------------------------------------------------
# Iodine's CT enhancement per unit concentration. ~25 HU per mgI/mL at 120 kVp is the
# standard working figure; it rises at lower kVp because of the K-edge, which is why the
# renderer must use a real mu(E) for iodine rather than this scalar (docs §3.1).
HU_PER_MGI_ML = 25.0

# Glomerular filtration rate, ~120 mL/min. The only route by which iodine leaves the model.
GFR_ML_S = 2.0

# ---- injection sites ---------------------------------------------------------
# The segmented anatomy starts at the trunk, so every access route is partly estimated — the
# basilic route always was (the 30 mL arm-vein mixer in solve()); these entries just make the
# estimate per-site. An arterial site is qualitatively different from a venous one: the bolus
# cannot return to the heart until it has crossed the limb's capillary bed, so it picks up a
# mixing volume (bed_ml, the smear) and a transport delay (delay_s, the vessel run the
# segmentation does not contain) before entering the segmented circulation at `join`.
# base_ml_s is the limb's own perfusion — the flow that keeps draining the bed after the
# injector stops, without which the tail would sit in the limb forever.
INJECTION_SITES = {
    'basilic': dict(label='Basilic vein'),                 # reference: arm vein -> SVC
    'central': dict(label='Central line'),                 # tip at the cavoatrial junction
    'radial':  dict(label='Radial artery', bed_ml=80.0,  delay_s=5.0, base_ml_s=1.2,
                    join='svc'),
    'femoral': dict(label='Femoral artery', bed_ml=150.0, delay_s=8.0, base_ml_s=3.5,
                    join='ivc'),
}

SITE_NOTES = {
    'central': 'central line: tip at the cavoatrial junction, so the peripheral veins are '
               'bypassed entirely — earliest, sharpest arrival the model can produce',
    'radial': 'radial artery: the forearm is not part of this anatomy — its transit is '
              'estimated as an 80 mL capillary bed plus a 5 s vessel run, rejoining the '
              'segmented circulation at the SVC',
    'femoral': 'femoral artery: the leg is not part of this anatomy — its transit is '
               'estimated as a 150 mL capillary bed plus an 8 s vessel run, entering the '
               'segmented circulation at the IVC',
}


class Delay:
    """A pure transport delay on a mass flux (mgI/s): what goes in comes out delay_s later,
    unchanged. The ring buffer IS the vessel run — mass in transit is sum(buf) * dt, and it
    is counted in the audit, so the delay cannot hide iodine."""

    def __init__(self, delay_s, dt):
        self.dt = dt
        self.buf = [0.0] * max(1, int(round(delay_s / dt)))
        self.i = 0

    def step(self, flux_in):
        out = self.buf[self.i]
        self.buf[self.i] = flux_in
        self.i = (self.i + 1) % len(self.buf)
        return out

    @property
    def mass(self):
        return sum(self.buf) * self.dt


@dataclass
class Injection:
    """A programmed injection: a start delay, one or two contrast phases, a saline chaser.

    A SECOND contrast phase is what a real biphasic protocol uses — a fast bolus to fill the
    arteries followed by a slower one to hold them filled while the scan runs. A single phase
    of the same total volume peaks higher and falls away sooner, which is the wrong shape for
    a long acquisition. Set volume2_ml = 0 for the plain single-phase protocol.
    """
    volume_ml: float = 100.0      # contrast volume, phase 1
    rate_ml_s: float = 4.0        # injection rate, phase 1
    conc_mgi_ml: float = 350.0    # iodine concentration of the agent
    volume2_ml: float = 0.0       # contrast volume, phase 2 (0 = single-phase)
    rate2_ml_s: float = 2.0       # injection rate, phase 2
    saline_ml: float = 40.0       # saline chaser — pushes the tail out of the arm veins
    saline_rate_ml_s: float = 4.0
    start_s: float = 0.0
    site: str = 'basilic'         # access route — see INJECTION_SITES

    def phases(self):
        """(duration_s, rate_ml_s, conc_mgi_ml) in delivery order. Saline is a phase too — it
        carries volume but no iodine, which is exactly how the chaser clears the arm veins."""
        out = []
        for vol, rate, conc in ((self.volume_ml, self.rate_ml_s, self.conc_mgi_ml),
                                (self.volume2_ml, self.rate2_ml_s, self.conc_mgi_ml),
                                (self.saline_ml, self.saline_rate_ml_s, 0.0)):
            if vol > 0 and rate > 0:
                out.append((vol / rate, rate, conc))
        return out

    @property
    def duration_s(self) -> float:
        """Contrast-delivering duration — the saline chaser is not part of it."""
        return (self.volume_ml / max(self.rate_ml_s, 1e-6)
                + self.volume2_ml / max(self.rate2_ml_s, 1e-6))

    def _at(self, t: float):
        """The phase active at t, or None."""
        u = t - self.start_s
        if u < 0:
            return None
        for dur, rate, conc in self.phases():
            if u < dur:
                return rate, conc
            u -= dur
        return None

    def flux_mgi_s(self, t: float) -> float:
        """Iodine delivered per second at time t. Saline contributes volume, not iodine —
        its job is to clear the tail, which shows up as a cleaner venous washout."""
        p = self._at(t)
        return p[0] * p[1] if p else 0.0

    def volume_flux_ml_s(self, t: float) -> float:
        p = self._at(t)
        return p[0] if p else 0.0


@dataclass
class Patient:
    cardiac_output_l_min: float = 5.0
    blood_volume_ml: float = 5000.0
    # Vessel calibre, as a multiplier on the cross-sections measured from the segmentation.
    # Velocity is Q/A, so a wider vessel carries the SAME flow more slowly and holds more
    # blood — both push the bolus later. Ectatic aorta vs a slim young patient.
    vessel_scale: float = 1.0
    # Organ perfusion, as a multiplier on the itemised organ beds' share of cardiac output.
    # The remainder is taken from (or given back to) the lower-body pool so the arterial
    # outlets still sum to 1.0 — otherwise this knob would quietly reintroduce the very mass
    # leak the audit in docs 6.1 removed.
    perfusion_scale: float = 1.0
    # Cardiac output is the dominant source of real timing variability: a low output delays
    # arrival AND raises the peak, because the same iodine is diluted by less blood per
    # second. It is the most useful teaching lever in the whole model (docs §2.4).

    @property
    def co_ml_s(self) -> float:
        return self.cardiac_output_l_min * 1000.0 / 60.0


class Vessel1D:
    """A vessel as a 1-D advection-dispersion line, gridded on its measured area profile.

    Both operators are UNCONDITIONALLY STABLE, so dt is chosen for accuracy rather than
    stability. That is not a nicety: with explicit upwind + explicit diffusion, the SVC's
    diffusive limit alone forced dt = 5.4e-6 s, i.e. 16.5 million steps for a 90 s run. The
    diffusive limit scales as dx^2/D and was 10-30x stricter than the advective one in every
    vessel, so no amount of grid tuning would have rescued it.

      advection — semi-Lagrangian: trace each cell back to where its contents came from and
                  interpolate. Exact for constant velocity, no Courant limit.
      diffusion — implicit (backward Euler), solved with a Thomas sweep.

    Both u and D are constant in time for a given flow, so the departure map and the
    tridiagonal factorisation are computed once in set_flow() and reused every step.
    """

    def __init__(self, key, meta, k_disp=1.0, scale=1.0):
        self.key = key
        self.name = meta['name']
        self.length_cm = meta['lengthMM'] / 10.0
        area = np.asarray(meta['areaMM2'], dtype=np.float64) / 100.0     # mm^2 -> cm^2
        area = area * float(scale) ** 2       # calibre: a diameter scale is an AREA scale squared
        # A(s) is unreliable at the ends (docs §4.2.1: the PA's first bin is 21x its median
        # because the inlet rule cannot find the RV outflow without heart chambers). An
        # unclamped thin bin gives a huge u = Q/A and a correspondingly vicious timestep, so
        # clamp to a band about the median rather than trusting every bin.
        med = float(np.median(area[area > 0])) if (area > 0).any() else 1.0
        self.area = np.clip(area, 0.5 * med, 3.0 * med)
        self.n = self.area.size
        self.dx = self.length_cm / self.n
        self.radius = np.sqrt(self.area / np.pi)
        self.k_disp = k_disp
        self.c = np.zeros(self.n)
        self.q = None

    def set_flow(self, q_ml_s, dt):
        """Precompute everything that depends on flow and timestep."""
        self.q, self.dt = q_ml_s, dt
        u = q_ml_s / self.area                       # cm/s, varies with calibre
        self.u = u
        D = self.k_disp * u * self.radius            # see module docstring
        n, dx = self.n, self.dx

        # --- semi-Lagrangian departure map (constant u, dt -> constant) ---------------
        xi = np.arange(n) - u * dt / dx              # where cell i's contents came from
        i0 = np.floor(xi).astype(np.int64)
        self.w = xi - i0
        self.pad = int(max(0, -i0.min()))            # cells that came from upstream of s=0
        self.idx = i0 + self.pad
        self._ext = np.empty(n + self.pad)

        # --- implicit diffusion, variable coefficient, zero-flux ends ------------------
        # AREA-WEIGHTED, because the vessel's mass is the integral of A*c, not of c. The
        # plain operator d/ds(D dc/ds) conserves the wrong integral: in a tapering vessel it
        # moves concentration between cells of different calibre and mints or destroys
        # A-weighted mass in proportion to the taper. That was a +209 mgI mid-transit defect
        # on the chest aorta alone — the dominant term of the whole-loop audit error once
        # the junction minting was fixed. The conservative form is A dc/dt = d/ds(A D dc/ds):
        # flux through a face is (A D)_half * dc/ds, and each cell divides by its own A, so
        # the face fluxes telescope and the zero-flux ends leave total A*c exactly constant.
        AD = D * self.area
        ADh = 0.5 * (AD[:-1] + AD[1:])               # A*D at the half points
        Dp = np.empty(n); Dm = np.empty(n)
        Dp[:-1] = ADh / self.area[:-1]; Dp[-1] = 0.0   # no flux out of the far end
        Dm[1:] = ADh / self.area[1:];  Dm[0] = 0.0     # no flux back out of the inlet
        r = dt / dx ** 2
        # banded form for solve_banded: row 0 upper, row 1 diagonal, row 2 lower. Handing
        # the sweep to LAPACK matters — a Thomas loop in Python would be 200 interpreter
        # iterations per vessel per step, ~25 M in a run, which costs more than the explicit
        # scheme this replaces.
        ab = np.zeros((3, n))
        ab[0, 1:] = (-r * Dp)[:-1]
        ab[1, :] = 1.0 + r * (Dm + Dp)
        ab[2, :-1] = (-r * Dm)[1:]
        self._ab = ab

    def step(self, c_in):
        # advect: gather from the departure points, with everything upstream of the inlet
        # taking the inlet concentration
        ext = self._ext
        if self.pad:
            ext[:self.pad] = c_in
        ext[self.pad:] = self.c
        i = self.idx
        lo = ext[i]
        hi = ext[np.minimum(i + 1, ext.size - 1)]
        cs = lo + self.w * (hi - lo)

        # diffuse: (I - dt L) c = c*
        c = solve_banded((1, 1), self._ab, cs, overwrite_b=True, check_finite=False)
        np.maximum(c, 0.0, out=c)
        self.c = c

    @property
    def c_out(self):
        return float(self.c[-1])

    def max_speed(self, q_ml_s):
        u = q_ml_s / self.area
        return float(u.max()), float((self.k_disp * u * self.radius).max())


class Mixer:
    """A well-mixed compartment: heart chambers, the pulmonary bed, the rest of the body."""

    def __init__(self, name, volume_ml):
        self.name = name
        self.v = float(volume_ml)
        self.c = 0.0

    def step(self, dt, inflow_mgi_s, q_out_ml_s):
        # dC/dt = (iodine in - iodine out) / V
        self.c += dt * (inflow_mgi_s - q_out_ml_s * self.c) / self.v
        self.c = max(self.c, 0.0)


class OrganBed:
    """Two compartments — intravascular and extravascular extracellular — exchanging.

    The enhancement a scan sees is the volume-weighted mean of the two, which is why an
    organ keeps enhancing after its feeding artery has begun to wash out.
    """

    def __init__(self, name, flow_frac, vol_iv_ml, vol_ees_ml, ps_ml_s, portal_frac=0.0,
                 vol_total_ml=None):
        self.name = name
        self.flow_frac = flow_frac
        # The liver is the one organ with a dual blood supply, and it is not a detail: the
        # portal vein carries ~3x the hepatic artery, and it arrives LATE because that blood
        # has already crossed the gut. That lag is the entire reason a liver peaks in the
        # portal venous phase at 60-70 s rather than with the aorta. Draining the portal vein
        # to the right heart instead — as this did — leaves the liver on 6.5 % of cardiac
        # output and it never peaks at all, it just seeps.
        self.portal_frac = portal_frac
        self.v_iv, self.v_ees, self.ps = vol_iv_ml, vol_ees_ml, ps_ml_s
        # The volume a CT voxel actually averages over. Most of an organ is cells, which hold
        # no contrast but are still in the voxel: 600 mL of the liver's 1500 mL takes up
        # iodine, so the enhancement CT reads is 40 % of the concentration in the spaces that
        # carry it. Dividing by v_iv + v_ees instead reported the liver at 160 HU where a real
        # one enhances 50-60.
        self.v_total = float(vol_total_ml or (vol_iv_ml + vol_ees_ml))
        self.c_iv = 0.0
        self.c_ees = 0.0

    @property
    def total_frac(self):
        return self.flow_frac + self.portal_frac

    def step(self, dt, q_ml_s, c_art, gfr_ml_s=0.0, q_portal=0.0, c_portal=0.0, q_out=None):
        ex = self.ps * (self.c_iv - self.c_ees)
        # Iodinated contrast is cleared by glomerular filtration. Only the kidney gets a
        # non-zero GFR, but it is the only sink in the whole loop: without it total body
        # iodine is conserved and every curve plateaus instead of washing out.
        inflow = q_ml_s * c_art + q_portal * c_portal
        # Drainage is not always the same flow that fed the bed: the upper body also loses
        # blood to the arm vein carrying the injection back, and that has to be debited here
        # or the loop mints iodine.
        qo = (q_ml_s + q_portal) if q_out is None else q_out
        self.c_iv += dt * (inflow - qo * self.c_iv - ex - gfr_ml_s * self.c_iv) / self.v_iv
        self.c_ees += dt * ex / self.v_ees
        self.c_iv = max(self.c_iv, 0.0)
        self.c_ees = max(self.c_ees, 0.0)

    @property
    def c_mean(self):
        return (self.c_iv * self.v_iv + self.c_ees * self.v_ees) / self.v_total

    def outflow_c(self):
        return self.c_iv


# ---- circulation topology ---------------------------------------------------
# Fractions of cardiac output. Systemic values are standard resting distribution; they must
# sum to 1 across the aortic outlets or the loop leaks mass.
# V_ees is the volume contrast actually distributes into outside the vessels, which is the
# organ's interstitium — roughly 20 % of its volume, NOT most of it. Oversizing it (the liver
# had 900 mL for a 1500 mL organ) makes the extravascular compartment dominate the mean
# enhancement, and since it only fills while c_iv > c_ees the organ then rises monotonically
# for the whole scan instead of peaking with its feeding vessel. The kidney is the exception
# and keeps a large one: it concentrates contrast in the tubular lumen.
# V_iv is sized so the intravascular mean transit time V_iv/Q lands at a physiological
# 5-20 s. Getting that wrong is what stalls an organ: the pancreas at V_iv = 50 mL on 1 % of
# cardiac output had a 60 s turnover and could not peak inside a 90 s scan no matter what the
# EES did. PS is set from the target EES time constant V_ees/PS, which is what puts the peak
# in the right phase (liver ~60 s, kidney ~12 s).
ORGANS = [
    # name,      flow frac, V_iv,  V_ees,  PS,  portal, V_total
    ('liver',      0.065,   300.0, 300.0, 15.0,  0.20,  1500.0),  # hepatic artery + portal
    ('spleen',     0.035,    55.0,  40.0,  6.0,  0.0,    200.0),
    ('kidney',     0.190,    90.0, 150.0, 25.0,  0.0,    300.0),  # tubular lumen -> big EES
    ('pancreas',   0.010,    12.0,  25.0,  8.0,  0.0,    100.0),
]
HEAD_ARM_FRAC = 0.19      # carotids + subclavians
GUT_FRAC = 0.20           # -> portal vein -> liver (counted as the liver's portal_frac)
LOWER_FRAC = 0.310        # everything else, returns via the IVC
# arterial outlets must sum to 1.0 or the loop leaks: organs + gut + head/arm + lower
assert abs(sum(o[1] for o in ORGANS) + GUT_FRAC + HEAD_ARM_FRAC + LOWER_FRAC - 1.0) < 1e-9


def solve(vessels_path, injection: Injection = None, patient: Patient = None,
          duration_s: float = 90.0, out_hz: float = 1.0, cfl: float = 0.4,
          verbose: bool = False, recirculation: bool = True):
    inj = injection or Injection()
    pat = patient or Patient()
    meta = json.load(open(vessels_path))
    vmeta = meta['vessels']

    def mk(key):
        return Vessel1D(key, vmeta[key], scale=pat.vessel_scale) if key in vmeta else None

    # ids from build_model.VESSELS — 43..46 are the iliacs, which the CAP model carries
    V = {k: mk(str(k)) for k in (30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42,
                                 43, 44, 45, 46)}
    pa, pv, svc, ivc, portal = V[30], V[31], V[32], V[33], V[34]

    # The aorta is solved as TWO lines sharing one display id, split at the arch (the same
    # n//8 station the old c_prox read). This is what makes the arch junction conservative:
    # the branches and the upper body draw the PROXIMAL outlet at the arch, the distal aorta
    # carries what is left — CO minus the head/arm flow — and every taker reads the exact
    # station its vessel is debited at. The old wiring sent full CO down the whole line and
    # let the upper body read c_prox anyway, minting 0.19 * CO * (c_prox - c_out) all the
    # while the bolus front sat between the arch and the bifurcation. On the CAP model's
    # 568 mm aorta that window is seconds wide, and it was the bulk of a +3.9 % mass audit.
    aorta_prox = aorta_dist = None
    if '29' in vmeta:
        am = vmeta['29']
        area = list(am['areaMM2'])
        cut = max(4, len(area) // 8)
        frac = cut / len(area)
        aorta_prox = Vessel1D('29p', dict(name=am['name'] + ' (arch)',
                                          lengthMM=am['lengthMM'] * frac,
                                          areaMM2=area[:cut]), scale=pat.vessel_scale)
        aorta_dist = Vessel1D('29d', dict(name=am['name'] + ' (desc)',
                                          lengthMM=am['lengthMM'] * (1 - frac),
                                          areaMM2=area[cut:]), scale=pat.vessel_scale)

    # The loop is right heart -> PA -> lungs -> PV -> left heart -> aorta, so a model without
    # one of those four cannot be solved at all — it has no circulation, just disconnected
    # pipes. Say which is missing: a bare AttributeError several hundred lines later tells the
    # person building a new model nothing about what their segmentation lacked. The pulmonary
    # artery is the usual culprit, because TotalSegmentator's `total` task does not have one —
    # it comes from the separate `lung_vessels` task (see build_model --lung-vessels).
    missing = [n for n, v in (('aorta', aorta_dist), ('pulmonary artery', pa),
                              ('pulmonary vein', pv), ('superior vena cava', svc)) if v is None]
    if missing:
        raise ValueError(
            'this model cannot carry contrast: no ' + ', no '.join(missing)
            + '. The circulation is a loop and these four are on it.'
            + (' The pulmonary artery comes from TotalSegmentator\'s lung_vessels task, not'
               ' `total` — rebuild with --lung-vessels.' if 'pulmonary artery' in missing else ''))

    CO = pat.co_ml_s
    # Transit volumes, not anatomical volumes: what matters is V/Q, the smearing each stage
    # applies. RV + pulmonary bed + LA + LV on the transit path is ~450 mL in total, and
    # putting 750 mL there stretched the PA-to-aorta delay to 11 s against a real pulmonary
    # transit of 4-8 s.
    right_heart = Mixer('right_heart', 150.0)
    lungs = Mixer('lungs', 150.0)          # pulmonary capillary/transit bed
    left_heart = Mixer('left_heart', 150.0)
    arm = Mixer('arm_vein', 30.0)          # injection site -> subclavian/brachiocephalic vein
    # Head/arms and lower body/gut are two-compartment beds, not well-mixed pools, because
    # the ~9 L of muscle/fat/skin interstitium they wrap is the LARGEST sink in the body and
    # the reason blood iodine falls. PS is set for a ~70 s redistribution half-life, which is
    # what a compartment audit calls for: at 3 min a real patient holds 35-45 % of the dose
    # intravascularly, and at PS 4.5/2.0 this held 66 %, pinning the aorta at 158 HU where a
    # real 3-minute blood pool reads 90-120. With the kidney's
    # 2 mL/s GFR as the only sink the blood pool decays over 42 min instead, so nothing ever
    # washes out and every organ EES fills monotonically to the end of the window.
    upper = OrganBed('upper_body', HEAD_ARM_FRAC, 0.12 * pat.blood_volume_ml, 3000.0, 5.0)
    body = OrganBed('body', LOWER_FRAC + GUT_FRAC, 0.30 * pat.blood_volume_ml, 6000.0, 12.0)
    # The arm vein carries the patient's own arm venous return as well as the injectate.
    # Flowing only the injection through it gave tau = 60/4 = 15 s and made every downstream
    # peak ~15 s late — the single largest timing error in the first working version.
    q_arm_return = 0.03 * CO
    organs = [OrganBed(*o) for o in ORGANS]
    # Perfusion knob: scale the itemised beds and hand the difference to the lower-body pool
    # so the arterial outlets still sum to 1.0.
    # Only the ARTERIAL share scales. portal_frac is set by gut flow, not by how well the
    # liver is perfused, and scaling it would leave the portal vein transporting GUT_FRAC
    # while the liver was charged something else — the same transport-vs-charged mismatch
    # the audit found in the SVC.
    ps = min(max(pat.perfusion_scale, 0.05), 2.0)
    organ_frac0 = sum(o.flow_frac for o in organs)
    for o in organs:
        o.flow_frac *= ps
    # The lower body gives up (or takes back) exactly what the organs gained, so the arterial
    # outlets still sum to 1.0 AND the IVC drains what the pool actually carries.
    perfusion_shift = organ_frac0 * (ps - 1.0)

    # Flow through each vessel. Getting these right matters for more than realism: velocity
    # is Q/A, so routing cardiac output through the SVC instead of upper-body return alone
    # would quadruple its velocity and distort its transit time.
    q_upper = HEAD_ARM_FRAC * CO
    q_lower = (LOWER_FRAC - perfusion_shift) * CO
    # A vessel's transport flow MUST equal the flow charged to whatever it drains into. The
    # SVC transported q_upper but the right heart was charged c_out * (q_arm + q_upper) —
    # 21.3 vs 15.8 mL/s, which minted iodine at exactly the 1.35x the right heart showed, and
    # every downstream compartment inherited it. The SVC carries upper-body return PLUS the
    # injected volume — but only when the injectate actually returns through its lumen:
    # basilic directly, radial after the forearm. A central line's tip sits at the SVC's far
    # end, so the bolus never transits it, and a femoral bolus comes home through the IVC.
    site_key = inj.site if inj.site in INJECTION_SITES else 'basilic'
    site = INJECTION_SITES[site_key]
    q_svc = q_upper + (inj.rate_ml_s if site_key in ('basilic', 'radial') else 0.0)
    q_ivc = q_lower + (inj.rate_ml_s if site.get('join') == 'ivc' else 0.0)
    # Every vessel is a TRANSPORTING member of the graph — none is a display copy. The old
    # wiring fed the arch branches c_prox and the brachiocephalic veins c_bc without ever
    # debiting anyone for it, which minted their entire contents (0.7-1.5 % of the dose
    # still sitting in them at 90 s), and never solved the iliacs or the appendage at all.
    # Flow splits: at rest the brain takes most of the head/arm share, the arms little.
    SUB_F, CAR_F = 0.15, 0.35            # subclavian / carotid, as fractions of q_upper
    q_direct = max(q_upper - q_arm_return, 0.0)   # upper-body return not via the arm vein
    q_app = 0.05 * CO                    # left atrial appendage side-loop
    q_of = {30: CO, 31: CO, 32: q_svc, 33: q_ivc, 34: GUT_FRAC * CO,
            35: 0.5 * q_upper,                       # BCT carries the right-sided pair
            36: SUB_F * q_upper, 37: SUB_F * q_upper,
            38: CAR_F * q_upper, 39: CAR_F * q_upper,
            40: 0.5 * q_direct, 41: 0.5 * q_direct, 42: q_app,
            43: 0.5 * q_lower, 44: 0.5 * q_lower,    # iliac arteries
            45: 0.5 * q_lower, 46: 0.5 * q_lower}    # iliac veins

    # Both operators are unconditionally stable, so dt is an ACCURACY choice, not a stability
    # one. A bolus feature is seconds wide and output is sampled at 1 Hz, so 10 ms resolves
    # everything physical. (Explicitly: the old explicit scheme was forced to 5.4e-6 s by the
    # SVC's diffusive limit — 16.5 M steps. This is 9000.)
    dt = min(1.0 / out_hz, cfl * 0.025)
    for k, v in V.items():
        if v is not None:
            v.set_flow(max(q_of.get(k, 0.04 * CO), 1e-6), dt)
    # the proximal aorta carries full cardiac output; the descending line carries what is
    # left after the arch branches take the head/arm share
    aorta_prox.set_flow(CO, dt)
    aorta_dist.set_flow(max(CO - q_upper, 1e-6), dt)
    lines = [v for v in V.values() if v is not None] + [aorta_prox, aorta_dist]
    n_steps = int(np.ceil(duration_s / dt))
    if verbose:
        print(f'      dt {dt*1000:.2f} ms, {n_steps} steps, CO {CO:.0f} mL/s')

    out_every = max(1, int(round((1.0 / out_hz) / dt)))
    injected_mgi = excreted_mgi = 0.0
    # Arterial access crosses the limb before it can join the segmented circulation: a small
    # mixing bed for the capillary crossing, a pure delay for the vessel run. Both are in the
    # mixers/audit so the estimated limb cannot mint or hide iodine any more than the arm can.
    limb = Mixer('limb_bed', site['bed_ml']) if 'bed_ml' in site else None
    limb_delay = Delay(site['delay_s'], dt) if limb is not None else None
    mixers = [arm, right_heart, lungs, left_heart] + ([limb] if limb is not None else [])
    beds = organs + [upper, body]

    def breakdown():
        return dict(
            vessels=sum(float((v.c * v.area).sum()) * v.dx for v in lines),
            chambers=sum(m.c * m.v for m in mixers)
                     + (limb_delay.mass if limb_delay is not None else 0.0),
            organ_blood=sum(o.c_iv * o.v_iv for o in beds),
            interstitium=sum(o.c_ees * o.v_ees for o in beds))

    def stored_mgi():
        """Total iodine held anywhere. Vessels: c * A * dx summed along the line."""
        tot = sum(float((v.c * v.area).sum()) * v.dx for v in lines)
        tot += sum(m.c * m.v for m in mixers)
        tot += limb_delay.mass if limb_delay is not None else 0.0
        tot += sum(o.c_iv * o.v_iv + o.c_ees * o.v_ees for o in beds)
        return tot
    frames, times = {k: [] for k in vmeta}, []
    organ_series = {o.name: [] for o in organs}
    # The chambers are sampled too: the renderer needs them for the heart, and right-vs-left
    # is what a PE study reads.
    chamber_series = {'right_heart': [], 'left_heart': []}

    for step in range(n_steps + 1):
        t = step * dt

        # --- injection at the chosen access site -----------------------------------------
        q_inj = inj.volume_flux_ml_s(t)
        flux = inj.flux_mgi_s(t)
        # Arterial sites: the bolus crosses the limb bed (smear), then the vessel run the
        # segmentation lacks (delay), and only THEN joins the venous side. The limb's carrier
        # blood is taken as iodine-free — recirculating arterial iodine in one forearm is
        # ~1 % of cardiac output and does not survive first-pass accuracy concerns.
        limb_flux = 0.0
        if limb is not None:
            q_limb = q_inj + site['base_ml_s']
            limb.step(dt, flux, q_limb)
            limb_flux = limb_delay.step(limb.c * q_limb)
        # The arm vein carries the injected volume for basilic (directly) and radial (once
        # the forearm returns it); a central line and a femoral bolus never pass through it.
        q_arm = q_arm_return + (q_inj if site_key in ('basilic', 'radial') else 0.0)
        arm_influx = flux if site_key == 'basilic' \
            else (limb_flux if site.get('join') == 'svc' else 0.0)
        arm.step(dt, arm_influx + q_arm_return * upper.c_iv, q_arm)
        # upper-body venous return joins the arm blood on its way to the SVC
        # The arm's return is part of the upper body's drainage, not extra to it: the direct
        # SVC path carries what is left after the arm vein takes its share, so the upper body
        # is always drained exactly the q_upper it was supplied.
        #
        # The junction hands its mass over AT THE SVC'S TRANSPORT FLOW. A constant-Q vessel
        # takes in c_bc * q_svc and puts out c_out * q_svc, so expressing the inlet as
        # mass-flux / q_svc makes the coupling exactly conservative no matter how the arm
        # flow varies with the injection. Dividing by the instantaneous junction flow instead
        # leaves the vessel charged at a rate it never carried, which leaked up to 9.7 % of
        # the dose once injection stopped and the arm flow dropped.
        #
        # The brachiocephalic veins CARRY the direct return now, half each — they used to be
        # fed a copy of the SVC inlet that nobody was debited for, which is exactly the class
        # of minting this file's own SVC comment warns about.
        ret_flux = 0.0
        for k in (40, 41):
            if V[k]:
                V[k].step(upper.c_iv)
                ret_flux += V[k].c_out * 0.5 * q_direct
            else:
                ret_flux += upper.c_iv * 0.5 * q_direct
        c_bc = (arm.c * q_arm + ret_flux) / q_svc
        svc.step(c_bc)

        # --- lower body -> iliac veins -> IVC, gut -> portal ------------------------------
        # The iliac veins carry the lower-body return when the model has them; a femoral
        # bolus joins at the IVC inlet either way (its estimated delay already covers the
        # run to the trunk). Mass flux over transport flow, as at every junction.
        ven_flux = limb_flux if site.get('join') == 'ivc' else 0.0
        for k in (45, 46):
            if V[k]:
                V[k].step(body.c_iv)
                ven_flux += V[k].c_out * 0.5 * q_lower
            else:
                ven_flux += body.c_iv * 0.5 * q_lower
        ivc.step(ven_flux / q_ivc)
        if portal: portal.step(body.c_iv)

        # --- right heart: SVC + IVC + portal + organ venous return -----------------------
        # Organs return their TOTAL flow (the liver's includes the portal share, which is
        # why the portal vein no longer appears here on its own).
        # recirculation=False severs every returning path and leaves only the fresh SVC
        # bolus. It is a diagnostic, not a physiological mode: it is how you tell a genuine
        # recirculation peak from a mass leak, since a leak survives the cut and returning
        # iodine does not.
        rc = 1.0 if recirculation else 0.0
        # A central line's tip sits at the cavoatrial junction, so its flux lands here
        # directly — outside the rc gate, because fresh injectate is not recirculation and
        # must survive the diagnostic cut.
        mgi_rh = (svc.c_out * q_svc
                  + (flux if site_key == 'central' else 0.0)
                  + rc * (ivc.c_out * q_ivc
                  + sum(o.outflow_c() * o.total_frac * CO for o in organs)))
        right_heart.step(dt, mgi_rh, CO)

        # --- pulmonary circuit ------------------------------------------------------------
        pa.step(right_heart.c)
        lungs.step(dt, pa.c_out * CO, CO)
        pv.step(lungs.c)
        # The atrial appendage is a blind pouch on the left atrium: it borrows left-heart
        # blood and hands it back, so the side-loop appears in BOTH the inflow and the
        # outflow or it would mint. It used to be built, given a flow, and never stepped —
        # the one vessel in the set that shipped identically zero enhancement.
        if V[42]:
            left_heart.step(dt, pv.c_out * CO + V[42].c_out * q_app, CO + q_app)
            V[42].step(left_heart.c)
        else:
            left_heart.step(dt, pv.c_out * CO, CO)

        # --- systemic -----------------------------------------------------------------------
        # Everything systemic is fed DOWNSTREAM of the aorta, and the fractions sum to 1.0.
        # Feeding the beds in parallel with the aorta straight off the left heart drew
        # 2.2 x CO of arterial blood while debiting the left heart only CO — manufacturing
        # 1.2 x CO x c_art of iodine every second, which is what pushed arterial peaks past
        # the first-pass flux/CO ceiling.
        #
        # The arch is a real junction now. The proximal line carries full CO to the arch;
        # there the branches take the head/arm share and the descending line carries the
        # rest. Every taker reads c at the STATION its vessel is debited — the proximal
        # outlet — which is what makes the split conservative. The old c_prox read tapped a
        # station the aorta was never debited at, minting 0.19 * CO * (c_prox - c_out) for
        # as long as the bolus front sat between the arch and the bifurcation; on the CAP
        # model's 568 mm aorta that was most of a +3.9 % audit error.
        aorta_prox.step(left_heart.c)
        c_arch = aorta_prox.c_out
        # brachiocephalic trunk feeds the right-sided pair; the left pair leaves directly
        if V[35]: V[35].step(c_arch)
        c_bct = V[35].c_out if V[35] else c_arch
        art_flux = 0.0
        for k, f, feed in ((36, SUB_F, c_bct), (37, SUB_F, c_arch),
                           (38, CAR_F, c_bct), (39, CAR_F, c_arch)):
            if V[k]:
                V[k].step(feed)
                art_flux += V[k].c_out * f * q_upper
            else:
                art_flux += feed * f * q_upper
        # upper body: fed by what actually comes OUT of the arch branches, drained by the
        # SVC (and the arm return). The branch transit is a second or two of genuine delay
        # the old direct c_prox feed skipped.
        upper.step(dt, q_upper, art_flux / q_upper)

        aorta_dist.step(c_arch)
        c_ao = aorta_dist.c_out                  # systemic arterial concentration
        c_portal = portal.c_out if portal else body.c_iv
        for o in organs:
            o.step(dt, o.flow_frac * CO, c_ao, GFR_ML_S if o.name == 'kidney' else 0.0,
                   o.portal_frac * CO, c_portal)
        # lower body + gut: the gut's share leaves the aorta along its length and stays a
        # direct c_ao feed; the leg/pelvis share travels the iliac arteries when the model
        # has them, which both lights them up and delays the lower body by their transit.
        il_flux = 0.0
        for k in (43, 44):
            if V[k]:
                V[k].step(c_ao)
                il_flux += V[k].c_out * 0.5 * q_lower
            else:
                il_flux += c_ao * 0.5 * q_lower
        q_body = (LOWER_FRAC + GUT_FRAC - perfusion_shift) * CO
        body.step(dt, q_body, (GUT_FRAC * CO * c_ao + il_flux) / q_body)

        injected_mgi += inj.flux_mgi_s(t) * dt
        excreted_mgi += GFR_ML_S * next(o for o in organs if o.name == 'kidney').c_iv * dt

        if step % out_every == 0:
            times.append(round(t, 3))
            for k, v in V.items():
                if v is not None:
                    frames[str(k)].append(np.round(v.c, 4).tolist())
            # the two solved aortic lines are ONE display vessel: the renderer's arclength
            # runs the whole aorta, so the frames do too
            frames['29'].append(np.round(np.concatenate([aorta_prox.c, aorta_dist.c]),
                                         4).tolist())
            for o in organs:
                organ_series[o.name].append(round(o.c_mean, 4))
            chamber_series['right_heart'].append(round(right_heart.c, 4))
            chamber_series['left_heart'].append(round(left_heart.c, 4))

    audit = dict(injected_mgi=injected_mgi, excreted_mgi=excreted_mgi,
                 stored_mgi=stored_mgi(), **breakdown())
    audit['balance'] = audit['stored_mgi'] + audit['excreted_mgi'] - audit['injected_mgi']
    audit['error_frac'] = audit['balance'] / max(audit['injected_mgi'], 1e-9)

    return dict(
        times_s=times, dt_s=dt, audit=audit,
        vessels={k: dict(name=vmeta[k]['name'], c_mgi_ml=frames[k])
                 for k in frames if frames[k]},
        organs={k: dict(c_mgi_ml=v) for k, v in organ_series.items()},
        right_heart_c=chamber_series['right_heart'], left_heart_c=chamber_series['left_heart'],
        huPerMgIml=HU_PER_MGI_ML,
        injection=inj.__dict__, patient=patient.__dict__ if patient else Patient().__dict__,
    )


def peak_hu(series):
    """Peak enhancement in HU of a per-time list of concentrations."""
    return max(series) * HU_PER_MGI_ML if series else 0.0
