/* THE IMAGE INTENSIFIER, inside: what the C-arm's round receptor (carm.js 'ii') holds, built in place
   in the C's frame so the film can open the drum and look in. Frame: the input face's centre at the
   origin, the axis up the C's +y (the beam's direction), the near half (+z) cut away. To scale for a
   9-inch (23 cm) tube: a convex input window, the caesium iodide input phosphor on its aluminium
   substrate with the photocathode on it, three focusing electrodes, the anode cone, the 2.5 cm
   output phosphor and window, the lens and the camera above. Units cm. */
import * as THREE from 'three';
import { std, mesh, glowMat } from '../../kit/stage.js';

export const II = {
  R_IN: 11.5,              // the input phosphor's useful radius (23 cm)
  R_OUT: 1.25,             // the output phosphor's (2.5 cm)
  Y_PC: 2.6,               // the photocathode's lowest point (on the axis)
  RS: 36,                  // its sphere's radius: the input surface is curved, convex toward the tube
  Y_OUT: 27.0,             // the output phosphor
  Y_ANODE: 24.8,
};
// the height of the curved photocathode at radius r
export const yPC = (r) => II.Y_PC + II.RS - Math.sqrt(II.RS * II.RS - r * r);

export function buildII(suite) {
  const g = new THREE.Group();
  g.position.set(0, suite.DET + 0.6, 0);
  suite.carm.c.add(g);
  g.visible = false;
  const M = {
    window: new THREE.MeshStandardMaterial({ color: 0xc9d2da, roughness: 0.3, metalness: 0.7, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
    al: std(0xb9c0c7, 0.35, 0.7, { side: THREE.DoubleSide }),
    csi: std(0x5fc4b4, 0.4, 0.0, { emissive: 0x0d2a26, side: THREE.DoubleSide }),
    pc: new THREE.MeshStandardMaterial({ color: 0xb08a3a, roughness: 0.4, metalness: 0.6, transparent: true, opacity: 0.8, side: THREE.DoubleSide, emissive: 0x2a1c06 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xbfe3ff, roughness: 0.05, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }),
    elec: std(0xd4dae0, 0.25, 0.85, { side: THREE.DoubleSide, emissive: 0x30363e }),
    anode: std(0xc9a24a, 0.3, 0.85, { side: THREE.DoubleSide }),
    lens: new THREE.MeshPhysicalMaterial({ color: 0xa8d8ff, roughness: 0.02, transparent: true, opacity: 0.5, depthWrite: false }),
    dark: std(0x2a2f36, 0.6, 0.2),
    ccd: std(0x1d3a6b, 0.3, 0.5, { emissive: 0x0a1630 }),
  };
  // a cap of a sphere (radius Rs) whose lowest point is at y0, out to rim radius r
  const cap = (Rs, y0, r, mat) => {
    const th = Math.asin(Math.min(1, r / Rs));
    const m = new THREE.Mesh(new THREE.SphereGeometry(Rs, 64, 12, 0, Math.PI * 2, Math.PI - th, th), mat);
    m.position.y = y0 + Rs;
    return m;
  };
  // the far half of an open ring (cylinder or cone) about the axis
  const ring = (r0, r1, y0, y1, mat) => mesh(new THREE.CylinderGeometry(r1, r0, y1 - y0, 48, 1, true, Math.PI / 2, Math.PI), mat, 0, (y0 + y1) / 2, 0);

  const window_ = cap(40, 0, 12.8, M.window); g.add(window_);
  const substrate = cap(II.RS, II.Y_PC - 0.5, 12.0, M.al); g.add(substrate);
  const csi = cap(II.RS, II.Y_PC - 0.25, 12.0, M.csi); g.add(csi);
  const photocathode = cap(II.RS, II.Y_PC, 12.0, M.pc); g.add(photocathode);
  // the vacuum envelope (its far half): from the window's rim up, narrowing to the output end
  const prof = [[12.9, 1.0], [13.1, 4], [13.1, 19], [10.5, 22.5], [5.0, 25.2], [2.4, 27.0], [2.2, 28.4]];
  const envelope = new THREE.Mesh(new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 64, Math.PI / 2, Math.PI), M.glass);
  g.add(envelope);
  // the focusing electrodes G1, G2, G3 and the anode
  const electrodes = [ring(12.5, 12.5, 4.5, 10, M.elec), ring(11.6, 11.2, 11.0, 15.5, M.elec), ring(9.6, 8.0, 16.5, 20.0, M.elec)];
  for (const e of electrodes) g.add(e);
  const elecGlow = electrodes.map(() => null);
  const anode = ring(4.6, 2.5, 22.8, II.Y_ANODE + 1.4, M.anode); g.add(anode);
  // the output phosphor (a small bright disc) and its window
  const outMat = glowMat(0x7dff6a); outMat.color.set(0x2c4a2a);
  const output = mesh(new THREE.CylinderGeometry(II.R_OUT, II.R_OUT, 0.18, 32), outMat, 0, II.Y_OUT, 0); g.add(output);
  const outWin = mesh(new THREE.CylinderGeometry(1.9, 1.9, 1.0, 32), M.lens, 0, II.Y_OUT + 0.65, 0); g.add(outWin);
  // the optics and the camera
  const optics = new THREE.Group(); g.add(optics);
  optics.add(mesh(new THREE.CylinderGeometry(2.4, 2.4, 3.8, 32, 1, true, Math.PI / 2, Math.PI), M.dark, 0, 30.4, 0));
  const lens1 = mesh(new THREE.SphereGeometry(2.0, 24, 12), M.lens, 0, 29.4, 0); lens1.scale.y = 0.3; optics.add(lens1);
  const lens2 = mesh(new THREE.SphereGeometry(2.0, 24, 12), M.lens, 0, 31.6, 0); lens2.scale.y = 0.3; optics.add(lens2);
  const camera = new THREE.Group(); g.add(camera);
  camera.add(mesh(new THREE.BoxGeometry(7.5, 6, 7.5), M.dark, 0, 35.6, -1.5));
  const ccd = mesh(new THREE.BoxGeometry(2.2, 0.2, 2.2), M.ccd, 0, 32.7, 0); camera.add(ccd);
  // a ring on the input to show the area in use (magnification modes)
  const fovMat = new THREE.MeshBasicMaterial({ color: 0xffec27, transparent: true, opacity: 0.0, depthWrite: false });
  const fov = new THREE.Mesh(new THREE.TorusGeometry(1, 0.03, 6, 96), fovMat); fov.rotation.x = Math.PI / 2; g.add(fov);
  const setFov = (r, a) => { fov.scale.set(r, r, r); fov.position.y = yPC(r) + 0.15; fovMat.opacity = a; fov.visible = a > 0.01; };
  setFov(II.R_IN, 0);

  /* An electron's path from the photocathode at radius r0 (signed: the side of the axis) in the
     plane at angle phi about the axis: the electrodes bend it toward the axis, it crosses over at
     the focal point and lands on the output phosphor on the opposite side (the image arrives
     inverted). mag: 0 normal, 1 the first magnification mode (crossover nearer the input, only the
     central part imaged: 0.67 is 15 cm, 1 is 11 cm). u: 0..1 along the path. Returns room coordinates. */
  const pathPts = (r0, mag) => {
    const yc = 21.2 - mag * 5, rin = II.R_IN - 6 * mag;
    return [[r0, yPC(Math.abs(r0))], [r0 * 0.86, 6.5 - mag], [r0 * 0.5, 12.5 - mag * 2.2], [0, yc], [-r0 * II.R_OUT / rin, II.Y_OUT - 0.1]];
  };
  const v3 = new THREE.Vector3();
  function ePos(r0, phi, u, mag = 0) {
    const P = pathPts(r0, mag);
    // a Catmull-Rom through the five points, by arc fraction (the segments are about equal)
    const n = P.length - 1, s = Math.min(n - 1e-6, Math.max(0, u * n)), i = Math.floor(s), f = s - i;
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(n, i + 2)];
    const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f * f + (-a + 3 * b - 3 * c + d) * f * f * f);
    const r = cr(p0[0], p1[0], p2[0], p3[0]), y = cr(p0[1], p1[1], p2[1], p3[1]);
    v3.set(r * Math.cos(phi), y, r * Math.sin(phi));
    return g.localToWorld(v3.clone()).toArray();
  }
  const toWorld = (x, y, z) => g.localToWorld(new THREE.Vector3(x, y, z)).toArray();

  return { g, M, window: window_, substrate, csi, photocathode, envelope, electrodes, elecGlow, anode, output, outMat, outWin, optics, camera, ccd, fov, setFov, ePos, toWorld };
}
