/* ============================================================================
   ACOUSTIC TISSUE PROPERTIES — docs/ultrasound.md §2
   The x-ray engines ask one question of a material: how much does it attenuate at
   this keV. Ultrasound asks three, and they are independent of each other:

     z    characteristic impedance, MRayl (rho x c). Reflection at an interface is
          ((z2-z1)/(z2+z1))^2, so it is IMPEDANCE MISMATCH, not density, that draws
          a boundary. Fat-on-liver is a whisper; tissue-on-gas is a mirror.
     att  attenuation, dB/cm/MHz. Sets penetration, and is why 12 MHz images a
          thyroid beautifully and cannot reach a kidney.
     bs   backscatter strength (arbitrary, 0..1): how much a tissue's sub-resolution
          structure scatters back. This is the SPECKLE, and it is what makes liver
          look like liver rather than a grey box.
     c    speed of sound, m/s. Shipped because it is the honest place for it, but v1
          renders at a fixed 1540 m/s — the speed-error artifacts (a fatty layer
          displacing deep structures) are explicitly out of scope.

   Values are the textbook ones, rounded. Where a segmentation label has no
   acoustic literature of its own (an "iliac vein" is blood in a wall), it inherits
   the obvious parent.
   ============================================================================ */

const T = (z, att, bs, c) => ({ z, att, bs, c });

// id -> properties. Ids match apps/web/src/core/materials.js.
export const ACOUSTIC = {
  0:  T(0.0004, 1.2, 0.02, 330),    // Air — a mirror, then nothing
  1:  T(0.26,  40.0, 0.60, 650),    // Lung: aerated, so effectively opaque
  2:  T(1.38,   0.6, 0.35, 1450),   // Fat
  3:  T(1.48,  0.02, 0.00, 1480),   // Water — anechoic
  4:  T(1.50,  0.02, 0.00, 1500),   // CSF
  5:  T(1.50,  0.05, 0.01, 1500),   // Simple fluid (a cyst)
  6:  T(1.52,  0.10, 0.02, 1520),   // Bile
  7:  T(1.70,  1.00, 0.30, 1580),   // Muscle
  8:  T(1.66,  0.20, 0.05, 1570),   // Blood — nearly anechoic, and it flows
  9:  T(1.68,  0.50, 0.35, 1580),   // Clotted blood — echoes where blood does not
  10: T(1.63,  0.70, 0.40, 1540),   // Soft tissue
  11: T(1.65,  0.50, 0.45, 1570),   // Liver — the reference organ
  12: T(1.66,  0.40, 0.50, 1570),   // Spleen (slightly brighter than liver)
  13: T(1.62,  0.90, 0.33, 1560),   // Kidney — cortex darker than liver
  14: T(1.65,  0.90, 0.62, 1590),   // Pancreas — echogenic
  15: T(1.70,  1.00, 0.35, 1580),   // Heart / myocardium
  16: T(1.75,  3.00, 0.30, 1660),   // Cartilage
  17: T(4.00, 10.00, 0.55, 2500),   // Trabecular bone
  18: T(7.80, 20.00, 0.60, 4080),   // Cortical bone — reflect, then shadow
  19: T(8.50, 20.00, 0.60, 4200),   // Tooth enamel
  20: T(1.60,  0.60, 0.30, 1540),   // Iodine contrast (an x-ray agent; acoustically fluid)
  21: T(6.50, 15.00, 0.65, 3500),   // Calcification — the stone that casts a shadow
  22: T(6.80, 16.00, 0.65, 3600),   // Kidney stone
  23: T(1.60,  1.00, 0.45, 1540),   // Skin
  24: T(17.0, 30.00, 0.70, 6400),   // Aluminum
  25: T(27.0, 30.00, 0.70, 6100),   // Titanium
  26: T(45.0, 30.00, 0.70, 5800),   // Stainless steel — a mirror that rings
  27: T(24.6, 30.00, 0.70, 2160),   // Lead
  28: T(3.20,  2.00, 0.25, 2750),   // Acrylic
  47: T(0.0004, 1.2, 0.02, 330),    // Bowel gas — the reason abdominal scanning is hard
  48: T(1.50,  0.10, 0.05, 1500),   // Oesophagus lumen
  49: T(1.50,  0.10, 0.05, 1500),   // Stomach lumen
  50: T(1.50,  0.10, 0.05, 1500),   // Duodenum lumen
  51: T(1.50,  0.10, 0.05, 1500),   // Small bowel lumen
  52: T(1.50,  0.10, 0.05, 1500),   // Colon lumen
  53: T(1.55,  0.80, 0.50, 1540),   // Glandular (breast)
};
// vessels (ids 29..46) are blood in a wall — one entry, applied by the lookup below
const BLOOD = ACOUSTIC[8];
export function acousticOf(id) {
  const a = ACOUSTIC[id];
  if (a) return a;
  if (id >= 29 && id <= 46) return BLOOD;
  return ACOUSTIC[10];                 // anything unlabelled behaves as soft tissue
}

/* Flat tables for the scan loop: one array lookup instead of an object hop. */
export function acousticTables(nmat = 64) {
  const z = new Float64Array(nmat), att = new Float64Array(nmat), bs = new Float64Array(nmat);
  for (let i = 0; i < nmat; i++) { const a = acousticOf(i); z[i] = a.z; att[i] = a.att; bs[i] = a.bs; }
  return { z, att, bs };
}
