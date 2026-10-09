/* Average glandular dose, the way mammography reports it (Dance et al. 2000):

       AGD = K * g * c * s

   K  incident air kerma at the top of the compressed breast (no backscatter), mGy
   g  kerma-to-glandular-dose conversion for a 50 % glandular breast: falls with thickness
      (deeper glandular tissue sees less beam) and RISES with beam quality (HVL)
   c  correction for glandularity other than 50 % (1 here: the subjects are not graded)
   s  spectrum correction for the target/filter, at the same HVL

   The dose used to be one fitted line in mAs, kV and thickness, so Mo/Mo, Mo/Rh and W/Rh at the
   same kV and mAs reported the same AGD. They do not: the target/filter sets the HVL (and with it
   g), the output per mAs, and s. Choosing a harder beam for a thick breast is a dose decision,
   and the console now shows it as one.

   Values are typical, not a particular tube's: HVLs from the usual rules of thumb for each
   target/filter (Mo/Mo ~ kV/100 + 0.03 mm Al), relative outputs typical of clinical units, g
   approximately after Dance 2000 Table 1, s from Dance 2000. The calibration point is the one the
   console already had: Mo/Mo, 28 kV, 60 mAs, 45 mm -> 1.5 mGy. */

export const TF = {
  momo: { hvlOffset: 0.03, output: 1.00, s: 1.000, label: 'Mo/Mo' },
  morh: { hvlOffset: 0.08, output: 0.80, s: 1.017, label: 'Mo/Rh' },
  wrh:  { hvlOffset: 0.22, output: 0.62, s: 1.042, label: 'W/Rh' },
};

export function hvlMmAl(tf, kv) { return kv / 100 + (TF[tf] || TF.momo).hvlOffset; }

// g (mGy/mGy), 50 % glandular breast: rows = thickness (cm), columns = HVL (mm Al)
const G_T = [2, 3, 4, 4.5, 5, 6, 7, 8];
const G_H = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60];
const G = [
  [0.390, 0.433, 0.473, 0.509, 0.543, 0.573, 0.587],
  [0.309, 0.351, 0.391, 0.428, 0.462, 0.493, 0.522],
  [0.234, 0.268, 0.300, 0.331, 0.361, 0.389, 0.415],
  [0.212, 0.243, 0.272, 0.301, 0.330, 0.355, 0.379],
  [0.192, 0.221, 0.248, 0.275, 0.302, 0.326, 0.348],
  [0.161, 0.185, 0.209, 0.233, 0.256, 0.278, 0.298],
  [0.137, 0.158, 0.180, 0.201, 0.222, 0.241, 0.259],
  [0.120, 0.139, 0.158, 0.177, 0.195, 0.213, 0.229],
];
const bracket = (xs, x) => {
  const v = Math.min(Math.max(x, xs[0]), xs[xs.length - 1]);
  let i = 0; while (i + 2 < xs.length && xs[i + 1] < v) i++;
  return [i, (v - xs[i]) / (xs[i + 1] - xs[i])];
};
export function gFactor(tCm, hvl) {
  const [i, a] = bracket(G_T, tCm), [j, b] = bracket(G_H, hvl);
  const r0 = G[i][j] * (1 - b) + G[i][j + 1] * b, r1 = G[i + 1][j] * (1 - b) + G[i + 1][j + 1] * b;
  return r0 * (1 - a) + r1 * a;
}

/* Tube output relative to Mo/Mo at 28 kV, per mAs: the target/filter's own yield and the steep
   kV dependence of a mammography tube. The image's photon count and the dose share it, so the
   AEC and the AGD cannot disagree about how much beam a setting makes. */
export function relativeOutput(tf, kv) { return (TF[tf] || TF.momo).output * Math.pow(kv / 28, 2.8); }

const SID = 65, SUPPORT = 2;           // cm: source to detector; detector to breast support
const K_REF = 1.5 / (60 * gFactor(4.5, hvlMmAl('momo', 28)));   // mGy per mAs at the reference
/* Incident air kerma at the top of the breast: tube output (per target/filter, ~kV^2.8 as
   mammography tubes run) at the inverse square of the source-to-top distance. magF carries the
   magnification stand's shorter distance. */
export function incidentKermaMGy({ tf = 'momo', kv, mas, tCm, magF = 1 }) {
  const top = (d) => SID - SUPPORT - d;
  return mas * K_REF * relativeOutput(tf, kv) * Math.pow(top(4.5) / top(tCm), 2) * magF;
}
export function agdMGy(p) {
  const tf = TF[p.tf] || TF.momo;
  const hvl = hvlMmAl(p.tf, p.kv);
  const K = incidentKermaMGy(p);
  return { agd: K * gFactor(p.tCm, hvl) * 1 * tf.s, K, hvl, g: gFactor(p.tCm, hvl), s: tf.s };
}
