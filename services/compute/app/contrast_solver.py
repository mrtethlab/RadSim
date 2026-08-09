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


@dataclass
class Injection:
    volume_ml: float = 100.0      # contrast volume
    rate_ml_s: float = 4.0        # injection rate
    conc_mgi_ml: float = 350.0    # iodine concentration of the agent
    saline_ml: float = 40.0       # saline chaser — pushes the tail out of the arm veins
    saline_rate_ml_s: float = 4.0
    start_s: float = 0.0

    @property
    def duration_s(self) -> float:
        return self.volume_ml / max(self.rate_ml_s, 1e-6)

    def flux_mgi_s(self, t: float) -> float:
        """Iodine delivered per second at time t. Saline contributes volume, not iodine —
        its job is to clear the tail, which shows up as a cleaner venous washout."""
        t0 = self.start_s
        return self.conc_mgi_ml * self.rate_ml_s if t0 <= t < t0 + self.duration_s else 0.0

    def volume_flux_ml_s(self, t: float) -> float:
        t0, d = self.start_s, self.duration_s
        if t0 <= t < t0 + d:
            return self.rate_ml_s
        ts = t0 + d
        if ts <= t < ts + self.saline_ml / max(self.saline_rate_ml_s, 1e-6):
            return self.saline_rate_ml_s
        return 0.0


@dataclass
class Patient:
    cardiac_output_l_min: float = 5.0
    blood_volume_ml: float = 5000.0
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

    def __init__(self, key, meta, k_disp=1.0):
        self.key = key
        self.name = meta['name']
        self.length_cm = meta['lengthMM'] / 10.0
        area = np.asarray(meta['areaMM2'], dtype=np.float64) / 100.0     # mm^2 -> cm^2
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
        Dp = np.empty(n); Dm = np.empty(n)
        Dh = 0.5 * (D[:-1] + D[1:])                  # D at the half points
        Dp[:-1] = Dh; Dp[-1] = 0.0                   # no flux out of the far end
        Dm[1:] = Dh;  Dm[0] = 0.0                    # no flux back out of the inlet
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

    def __init__(self, name, flow_frac, vol_iv_ml, vol_ees_ml, ps_ml_s):
        self.name = name
        self.flow_frac = flow_frac
        self.v_iv, self.v_ees, self.ps = vol_iv_ml, vol_ees_ml, ps_ml_s
        self.c_iv = 0.0
        self.c_ees = 0.0

    def step(self, dt, q_ml_s, c_art, gfr_ml_s=0.0):
        ex = self.ps * (self.c_iv - self.c_ees)
        # Iodinated contrast is cleared by glomerular filtration. Only the kidney gets a
        # non-zero GFR, but it is the only sink in the whole loop: without it total body
        # iodine is conserved and every curve plateaus instead of washing out.
        self.c_iv += dt * (q_ml_s * (c_art - self.c_iv) - ex - gfr_ml_s * self.c_iv) / self.v_iv
        self.c_ees += dt * ex / self.v_ees
        self.c_iv = max(self.c_iv, 0.0)
        self.c_ees = max(self.c_ees, 0.0)

    @property
    def c_mean(self):
        return (self.c_iv * self.v_iv + self.c_ees * self.v_ees) / (self.v_iv + self.v_ees)

    def outflow_c(self):
        return self.c_iv


# ---- circulation topology ---------------------------------------------------
# Fractions of cardiac output. Systemic values are standard resting distribution; they must
# sum to 1 across the aortic outlets or the loop leaks mass.
ORGANS = [
    # name,      flow frac, V_iv,  V_ees,  PS
    ('liver',      0.065,   400.0, 900.0,  6.0),   # arterial supply only; portal handled below
    ('spleen',     0.030,   150.0, 200.0,  8.0),
    ('kidney',     0.190,   120.0, 300.0, 25.0),   # fast, high-flow: enhances early and hard
    ('pancreas',   0.010,    50.0, 120.0,  5.0),
]
HEAD_ARM_FRAC = 0.19      # carotids + subclavians
GUT_FRAC = 0.20           # -> portal vein -> liver
LOWER_FRAC = 0.315        # everything else, returns via the IVC


def solve(vessels_path, injection: Injection = None, patient: Patient = None,
          duration_s: float = 90.0, out_hz: float = 1.0, cfl: float = 0.4,
          verbose: bool = False):
    inj = injection or Injection()
    pat = patient or Patient()
    meta = json.load(open(vessels_path))
    vmeta = meta['vessels']

    def mk(key):
        return Vessel1D(key, vmeta[key]) if key in vmeta else None

    # ids from build_model.VESSELS
    V = {k: mk(str(k)) for k in (29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42)}
    aorta, pa, pv, svc, ivc, portal = V[29], V[30], V[31], V[32], V[33], V[34]

    CO = pat.co_ml_s
    # Transit volumes, not anatomical volumes: what matters is V/Q, the smearing each stage
    # applies. RV + pulmonary bed + LA + LV on the transit path is ~450 mL in total, and
    # putting 750 mL there stretched the PA-to-aorta delay to 11 s against a real pulmonary
    # transit of 4-8 s.
    right_heart = Mixer('right_heart', 150.0)
    lungs = Mixer('lungs', 150.0)          # pulmonary capillary/transit bed
    left_heart = Mixer('left_heart', 150.0)
    body = Mixer('body', 0.30 * pat.blood_volume_ml)     # systemic pool that returns via IVC
    arm = Mixer('arm_vein', 30.0)          # injection site -> subclavian/brachiocephalic vein
    # The arm vein carries the patient's own arm venous return as well as the injectate.
    # Flowing only the injection through it gave tau = 60/4 = 15 s and made every downstream
    # peak ~15 s late — the single largest timing error in the first working version.
    q_arm_return = 0.03 * CO
    organs = [OrganBed(*o) for o in ORGANS]

    # Flow through each vessel. Getting these right matters for more than realism: velocity
    # is Q/A, so routing cardiac output through the SVC instead of upper-body return alone
    # would quadruple its velocity and distort its transit time.
    q_upper = HEAD_ARM_FRAC * CO
    q_lower = LOWER_FRAC * CO
    q_of = {29: CO, 30: CO, 31: CO, 32: q_upper, 33: q_lower, 34: GUT_FRAC * CO,
            35: 0.04 * CO, 36: 0.04 * CO, 37: 0.04 * CO, 38: 0.04 * CO, 39: 0.04 * CO,
            40: 0.5 * q_upper, 41: 0.5 * q_upper, 42: 0.05 * CO}

    # Both operators are unconditionally stable, so dt is an ACCURACY choice, not a stability
    # one. A bolus feature is seconds wide and output is sampled at 1 Hz, so 10 ms resolves
    # everything physical. (Explicitly: the old explicit scheme was forced to 5.4e-6 s by the
    # SVC's diffusive limit — 16.5 M steps. This is 9000.)
    dt = min(1.0 / out_hz, 0.01)
    for k, v in V.items():
        if v is not None:
            v.set_flow(max(q_of.get(k, 0.04 * CO), 1e-6), dt)
    n_steps = int(np.ceil(duration_s / dt))
    if verbose:
        print(f'      dt {dt*1000:.2f} ms, {n_steps} steps, CO {CO:.0f} mL/s')

    out_every = max(1, int(round((1.0 / out_hz) / dt)))
    frames, times = {k: [] for k in vmeta}, []
    organ_series = {o.name: [] for o in organs}

    for step in range(n_steps + 1):
        t = step * dt

        # --- injection into the arm vein, carried by the injected volume itself ----------
        q_inj = inj.volume_flux_ml_s(t)
        q_arm = q_inj + q_arm_return
        arm.step(dt, inj.flux_mgi_s(t) + q_arm_return * body.c, q_arm)
        # upper-body venous return joins the arm blood on its way to the SVC
        c_bc = (arm.c * q_arm + body.c * q_upper) / max(q_arm + q_upper, 1e-9)
        if V[40]: V[40].step(c_bc)
        if V[41]: V[41].step(c_bc)
        svc.step(c_bc)

        # --- lower body -> IVC, gut -> portal -> liver -----------------------------------
        ivc.step(body.c)
        if portal: portal.step(body.c)

        # --- right heart: SVC + IVC + portal(via liver) ----------------------------------
        q_rh = CO
        mgi_rh = (svc.c_out * (q_arm + q_upper) + ivc.c_out * q_lower
                  + (portal.c_out if portal else body.c) * GUT_FRAC * CO
                  + sum(o.outflow_c() * o.flow_frac * CO for o in organs))
        right_heart.step(dt, mgi_rh, q_rh)

        # --- pulmonary circuit ------------------------------------------------------------
        pa.step(right_heart.c)
        lungs.step(dt, pa.c_out * CO, CO)
        pv.step(lungs.c)
        left_heart.step(dt, pv.c_out * CO, CO)

        # --- systemic ---------------------------------------------------------------------
        aorta.step(left_heart.c)
        c_art = left_heart.c                     # arterial supply to every bed
        for key in (35, 36, 37, 38, 39):
            if V[key]: V[key].step(c_art)
        for o in organs:
            o.step(dt, o.flow_frac * CO, c_art, GFR_ML_S if o.name == 'kidney' else 0.0)
        # the systemic pool: everything not itemised, returning via the IVC
        # The arm's venous return is drawn FROM this pool, so the pool has to be debited for
        # it. Taking it without debiting created iodine every step — a slow leak that inflates
        # the recirculating concentration.
        q_body = (GUT_FRAC + LOWER_FRAC + HEAD_ARM_FRAC) * CO
        body.step(dt, c_art * q_body, q_body + q_arm_return)

        if step % out_every == 0:
            times.append(round(t, 3))
            for k, v in V.items():
                if v is not None:
                    frames[str(k)].append(np.round(v.c, 4).tolist())
            for o in organs:
                organ_series[o.name].append(round(o.c_mean, 4))

    return dict(
        times_s=times, dt_s=dt,
        vessels={k: dict(name=vmeta[k]['name'], c_mgi_ml=frames[k])
                 for k in frames if frames[k]},
        organs={k: dict(c_mgi_ml=v) for k, v in organ_series.items()},
        huPerMgIml=HU_PER_MGI_ML,
        injection=inj.__dict__, patient=patient.__dict__ if patient else Patient().__dict__,
    )


def peak_hu(series):
    """Peak enhancement in HU of a per-time list of concentrations."""
    return max(series) * HU_PER_MGI_ML if series else 0.0
