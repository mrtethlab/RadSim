/* THE DXA FILM'S STUDIES, baked from the app's own scan (not bundled: run it with node).

     node apps/web/src/anim/films/dxa/bake.mjs      # -> apps/web/public/anim/dxa.json

   The chest-abdomen-pelvis volume, placed as the DXA room places it (rolled-180 volume: no flips),
   scanned by dxa.js itself: the AP lumbar spine with the laser on the console's mark, and the
   left hip with the legs turned in 20 degrees in the foot holder. Each study keeps what the film
   shows: the low- and high-energy attenuation (A = ln I0/I), the solved bone mineral and soft
   tissue (g/cm2), the regions the analysis found and the numbers measure() gives them, scored
   for the film's patient (a woman of 68 who has lost a share of her mineral). Images are 8-bit,
   base64, 16 bits a pixel (little-endian), each with the value its 65535 stands for. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { VoxelPhantom } from '../../../core/voxelPhantom.js';
import { segmentFemur, poseFemurs } from '../../../core/limbPose.js';
import { BodyMaterials } from '../../../core/materials.js';
import { scanPhantom, decompose, analyse, measure, findLevels, scores, classify, findLandmarks, E_LO, E_HI,
  REF, ageMean, calFor, ISCD_MIN_PRECISION, LSC_Z, scanPlan } from '../../../dxa.js';

const pub = new URL('../../../../public/', import.meta.url);
const NAME = 'chestabdopelvis';
const hdr = JSON.parse(readFileSync(new URL(`models/${NAME}/${NAME}.model.json`, pub), 'utf8'));
const data = new Uint8Array(readFileSync(new URL(`models/${NAME}/${NAME}.mat.bin`, pub)));
const VM = { dims: hdr.dims, vs: hdr.spacing.map((s) => s / 10), data };
const lmJ = JSON.parse(readFileSync(new URL('../../../data/landmarks.json', import.meta.url), 'utf8'))[NAME];

const PATIENT = { sex: 'f', age: 68, loss: 0.3 };
const INCH = 2.54;

const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
function img16(src, nx, nz, max) {
  // rows written superior-first (the top of the picture is the head end), as the console shows it
  const out = new Uint16Array(nx * nz);
  for (let r = 0; r < nz; r++) for (let c = 0; c < nx; c++) {
    out[(nz - 1 - r) * nx + c] = Math.max(0, Math.min(65535, Math.round(src[r * nx + c] / max * 65535)));
  }
  return { max, data: b64(out) };
}
const pct = (a, q) => { const s = Array.from(a).sort((x, y) => x - y); return s[Math.floor(q * (s.length - 1))]; };

function study(ph, st) {
  const sc = scanPhantom(ph, st);
  const { bmd, basis: b } = decompose(sc);
  const an = analyse(sc, bmd);
  const rois = measure(sc, bmd, an.rois);
  const n = sc.nx * sc.nz, det = b.bLo * b.sHi - b.bHi * b.sLo;
  const soft = new Float32Array(n);
  for (let k = 0; k < n; k++) soft[k] = Math.max(0, (b.bLo * sc.hi[k] - b.bHi * sc.lo[k]) / det);
  const cal = calFor(sc.region);
  // the BMD map as reported (calibrated), so the pixels and the table agree
  const rep = Float32Array.from(bmd, (v) => v * cal);
  const loMax = pct(sc.lo, 0.999), hiMax = pct(sc.hi, 0.999);
  return { sc, bmd, an, rois, out: {
    nx: sc.nx, nz: sc.nz, px: sc.px, x0: sc.x0, z0: sc.z0, dirSup: sc.dirSup,
    lo: img16(sc.lo, sc.nx, sc.nz, loMax), hi: img16(sc.hi, sc.nx, sc.nz, hiMax),
    bmd: img16(rep, sc.nx, sc.nz, pct(rep, 0.998)), soft: img16(soft, sc.nx, sc.nz, pct(soft, 0.999)),
  } };
}
const sc3 = (v) => +v.toFixed(3);

// ---------------------------------------------------------------- the spine
const phS = new VoxelPhantom(VM, [0, 0, 0], [false, false, false], null);
const lm = findLandmarks(phS);
const cx = (phS.min[0] + phS.max[0]) / 2;
const asis = lm.crestCm - lm.dirSup * 7;
const spineSt = { region: 'spine', loss: PATIENT.loss, headZ: asis + lm.dirSup * INCH, crossX: cx };
const S = study(phS, spineSt);
let bS = 0, aS = 0; for (const r of S.rois) { bS += r.bmc; aS += r.area; }
const spineMean = bS / aS;
const spineOut = { ...S.out, laser: { z: spineSt.headZ, x: spineSt.crossX }, crestCm: lm.crestCm,
  rois: S.rois.slice().sort((p, q) => p.label.localeCompare(q.label)).map((r) => ({ label: r.label, a: r.a, b: r.b, x0: r.x0, x1: r.x1,
    area: +r.area.toFixed(2), bmc: +r.bmc.toFixed(2), bmd: sc3(r.bmd), ...scoreOf(r.bmd, 'spine') })),
  total: { label: 'L1-L4', area: +aS.toFixed(2), bmc: +bS.toFixed(2), bmd: sc3(spineMean), ...scoreOf(spineMean, 'spine') },
  plan: scanPlan('spine') };
// the column the analysis traced (edges per row), for the edge-detection step
if (S.an.col) spineOut.col = S.an.col;
{ const lv = findLevels(S.sc, S.bmd); spineOut.prof = Array.from(lv.prof, (v) => +v.toFixed(3)); spineOut.dips = lv.dips; spineOut.period = lv.period; }

// ---------------------------------------------------------------- the left hip, legs turned in 20 degrees
const femurs = [lmJ.femoralHeadL, lmJ.femoralHeadR].map((h) => segmentFemur(VM, h));
const posed = poseFemurs(VM, femurs, 20, lmJ.femoralHeadL.anteriorY || 1);
const phH = new VoxelPhantom({ ...VM, data: posed }, [0, 0, 0], [false, false, false], null);
const lmH = findLandmarks(phH), t = lmH.troch.L;
// the mark as landmarkTargets() places it: 2 in below the (corrected) trochanter, out on the shaft
const GT_DROP = 1.5 * INCH, GT_LAT = 1.0 * INCH;
const gt = t.zCm - lmH.dirSup * GT_DROP;
const hipSt = { region: 'hipL', loss: PATIENT.loss, headZ: gt - lmH.dirSup * 2 * INCH, crossX: cx - (t.x + GT_LAT) };
const H = study(phH, hipSt);
// the regions as one byte per pixel (bit k: region k in the order listed), superior row first
const regs = ['Neck', 'Wards', 'Troch', 'Inter', 'Total'];
const mask = new Uint8Array(H.sc.nx * H.sc.nz);
H.rois.forEach((r) => {
  const k = regs.indexOf(r.label);
  for (let row = 0; row < H.sc.nz; row++) for (let c = 0; c < H.sc.nx; c++) if (r.mask[row * H.sc.nx + c]) mask[(H.sc.nz - 1 - row) * H.sc.nx + c] |= 1 << k;
});
const hipOut = { ...H.out, laser: { z: hipSt.headZ, x: hipSt.crossX }, regions: regs, mask: b64(mask),
  rois: H.rois.map((r) => ({ label: r.label, area: +r.area.toFixed(2), bmc: +r.bmc.toFixed(2), bmd: sc3(r.bmd),
    ...scoreOf(r.bmd, r.site) })),
  axes: H.an.axes && { headC: H.an.axes.headC, headR: H.an.axes.headR, nAx: H.an.axes.nAx },
  troch: { x: hipSt.crossX + GT_LAT, z: t.zCm }, plan: scanPlan('hipL') };

function scoreOf(v, site) {
  const s = scores(v, site, PATIENT.sex, PATIENT.age);
  return { T: +s.T.toFixed(1), Z: +s.Z.toFixed(1) };
}

// ---------------------------------------------------------------- the physics the film quotes
const M = BodyMaterials;
const id = (n) => M.idByName[n];
const rhoS = 1.05, rhoB = 1.92;
const mm = (n, rho, E) => M.muById(id(n), E) / rho;          // mass attenuation, cm2/g
const curve = (n, rho) => Array.from({ length: 13 }, (_, i) => { const E = 20 + i * 10; return [E, +mm(n, rho, E).toFixed(4)]; });
const phys = {
  E_LO, E_HI,
  soft: { lo: +mm('Soft tissue', rhoS, E_LO).toFixed(4), hi: +mm('Soft tissue', rhoS, E_HI).toFixed(4) },
  bone: { lo: +mm('Cortical bone', rhoB, E_LO).toFixed(4), hi: +mm('Cortical bone', rhoB, E_HI).toFixed(4) },
  fat: { lo: +(M.muById(id('Fat'), E_LO) / 0.95).toFixed(4), hi: +(M.muById(id('Fat'), E_HI) / 0.95).toFixed(4) },
  curves: { soft: curve('Soft tissue', rhoS), bone: curve('Cortical bone', rhoB) },
};
phys.Rsoft = +(phys.soft.lo / phys.soft.hi).toFixed(3);
phys.Rbone = +(phys.bone.lo / phys.bone.hi).toFixed(3);
phys.Rfat = +(phys.fat.lo / phys.fat.hi).toFixed(3);

const out = {
  about: 'Baked by apps/web/src/anim/films/dxa/bake.mjs from the chest-abdomen-pelvis volume with dxa.js',
  patient: PATIENT, phys,
  ref: { spine: REF.spine.f, total: REF.total.f, neck: REF.neck.f,
    age: Object.fromEntries(['spine', 'total', 'neck'].map((s) => [s, Array.from({ length: 9 }, (_, i) => +ageMean(s, 'f', 20 + i * 10).toFixed(4))])) },
  precision: { LSC_Z, ...ISCD_MIN_PRECISION },
  spine: spineOut, hip: hipOut,
};
const worst = [spineOut.total, ...hipOut.rois.filter((r) => r.label === 'Neck' || r.label === 'Total')].sort((p, q) => p.T - q.T)[0];
out.dx = { ...classify(worst.T, worst.Z, PATIENT.age), T: worst.T, Z: worst.Z, site: worst.label };
mkdirSync(new URL('anim/', pub), { recursive: true });
writeFileSync(new URL('anim/dxa.json', pub), JSON.stringify(out));
console.log('spine', spineOut.nx, 'x', spineOut.nz, 'L1-L4', spineOut.total, spineOut.rois.map((r) => `${r.label} ${r.bmd}`).join(' '));
console.log('hip', hipOut.nx, 'x', hipOut.nz, hipOut.rois.map((r) => `${r.label} ${r.bmd} T${r.T}`).join(' '));
console.log('phys', JSON.stringify({ ...phys, curves: undefined }));
console.log('dx', out.dx, 'laser spine', spineOut.laser, 'hip', hipOut.laser, 'crest', lm.crestCm, 'dirSup', lm.dirSup);
