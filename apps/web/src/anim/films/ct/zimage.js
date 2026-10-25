/* CT FILM, the image along z (8-bit): what slice thickness and interval do to the pictures, on the
   model's own volume (zaxis.js). Thin against thick axial slices (noise against partial volume);
   reformats from thin and thick slices; reformats from overlapping, contiguous and gapped ones. */
import { sigmaOf } from './zaxis.js';
import { drawHU, row, fit, under, lab } from './draw.js';

export function zImageSteps(api, S) {
  const { px, sfx } = api;
  const Z = S.zaxis;
  const sThin = Math.round(sigmaOf(2.5)), sThick = Math.round(sigmaOf(10));
  // the coronal's crop for the reformats: the lower chest and upper abdomen (dome, heart, liver)
  const CROP = [30, 100, 150, 140], CROP3 = [40, 100, 110, 140];
  const steps = [];
  steps.push({
    title: 'Thin and thick slices', dur: 14, view: 'pixel', fadeIn: 0.3, scale: '10 cm',
    cues: [[7, () => sfx.click()]],
    frame(t) {
      px.fillAll('ink');
      const a = Z.axial(2.5), b = Z.axial(10), s = fit(px, 2, a.w, a.h), xs = row(px, 2, a.w * s);
      const lung = t > 7, L = lung ? -600 : 40, W = lung ? 1500 : 400;
      const A = drawHU(api, a.img, a.w, a.h, xs[0], 20, s, L, W), B = drawHU(api, b.img, b.w, b.h, xs[1], 20, s, L, W);
      under(px, A, '2.5 mm'); under(px, B, '10 mm');
      if (!lung) { under(px, A, sThin + ' HU', 'cyan', 12); under(px, B, sThick + ' HU', 'cyan', 12); }
      if (t > 0.8 && !lung) api.mark(lab(A), 'cyan', t);
      if (lung) api.mark(lab(B), 'yellow', t);
    },
    caption: [
      { from: 0.8, to: 7, text: `A <b>thin</b> slice takes fewer photons: more <b>noise</b>, ${sThin} HU against ${sThick} for the thick one at the same dose (noise grows as 1/√thickness).` },
      { from: 7, to: 14, text: 'A <b>thick</b> slice is smoother but averages more along z: small vessels smeared and faint, edges blurred (<b>partial volume</b>). The thin one keeps them sharp.' },
    ],
  });
  steps.push({
    title: 'Thickness in reformats', dur: 12, view: 'pixel', scale: '10 cm',
    frame(t) {
      px.fillAll('ink');
      const a = Z.coronal(2.5, 1.25), b = Z.coronal(10, 5), s = fit(px, 2, CROP[2], CROP[3]), xs = row(px, 2, CROP[2] * s);
      const A = drawHU(api, a.img, a.w, a.h, xs[0], 20, s, 40, 400, { crop: CROP }), B = drawHU(api, b.img, b.w, b.h, xs[1], 20, s, 40, 400, { crop: CROP });
      under(px, A, '2.5 mm'); under(px, B, '10 mm');
      if (t > 0.8) api.mark(lab(t < 6 ? A : B), 'yellow', t);
    },
    caption: [
      { from: 0.8, to: 6, text: 'A reformat is only as sharp along z as the slices it is built from: from <b>thin</b> slices, near-cubic voxels and a crisp coronal...' },
      { from: 6, to: 12, text: '...from <b>thick</b> ones, everything blurred from top to bottom: the dome of the diaphragm, the vessels, the edges of organs.' },
    ],
  });
  steps.push({
    title: 'Interval and overlap', dur: 13, view: 'pixel', fadeOut: 0.5, scale: '10 cm',
    frame(t) {
      px.fillAll('ink');
      const cs = [Z.coronal(5, 2.5), Z.coronal(5, 5), Z.coronal(5, 10)];
      const s = fit(px, 3, CROP3[2], CROP3[3], { gap: 6 }), xs = row(px, 3, CROP3[2] * s, 6);
      const B = cs.map((c, i) => drawHU(api, c.img, c.w, c.h, xs[i], 20, s, 40, 400, { crop: CROP3 }));
      ['2.5', '5', '10'].forEach((v, i) => under(px, B[i], v + ' mm', i === 0 ? 'lime' : i === 2 ? 'orange' : 'yellow'));
      if (t > 0.8) api.mark(lab(t < 6.5 ? B[0] : B[2]), t < 6.5 ? 'lime' : 'orange', t);
    },
    caption: [
      { from: 0.8, to: 6.5, text: 'The same 5 mm slices placed every 2.5, 5 and 10 mm. <b>Overlapping</b> (left) gives the smoothest reformats and 3D, for no extra dose.' },
      { from: 6.5, to: 13, text: 'With <b>gaps</b> (right), anatomy between the images is lost and curved edges come out in steps.' },
    ],
  });
  return steps;
}
