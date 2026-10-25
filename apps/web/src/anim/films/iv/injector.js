/* THE POWER INJECTOR, for the film's last steps: a dual-syringe CT injector on its stand, after the
   one the app models (app.js: a barrel of contrast medium, a barrel of saline, a programmed rate):
   the head tilted down so any air rises to the plungers, the contrast syringe in its warmer, the
   two lines joining and running to the patient's port, a screen with the rate, the volume and the
   pressure. The app has no 3D injector: this one is the film's own. Units cm. */
import * as THREE from 'three';
import { std, mesh } from '../../kit/stage.js';
import { v3 } from './arm.js';

export function buildInjector(api, S) {
  const g = new THREE.Group(); S.room.add(g);
  const board = S.R3.board, top = board.position.y + 1.2;
  const floorY = top - 78;
  const floor = mesh(new THREE.CircleGeometry(160, 48), std(0x1a2026, 0.95, 0.0), 0, floorY, 0);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; g.add(floor);
  // the stand beside the board, by the shoulder end, on the arm's medial side
  const box = new THREE.Box3().setFromObject(S.arm.group);
  const at = [box.min.x - 26, floorY, box.max.z - 18];
  const stand = new THREE.Group(); stand.position.set(...at); g.add(stand);
  const white = std(0xe9ecef, 0.45, 0.1), grey = std(0x9aa1a8, 0.5, 0.4), dark = std(0x2a2f36, 0.6, 0.2);
  for (let i = 0; i < 5; i++) {
    const a = i / 5 * Math.PI * 2, leg = mesh(new THREE.BoxGeometry(26, 2.4, 4), grey, Math.cos(a) * 13, 6, Math.sin(a) * 13);
    leg.rotation.y = -a; stand.add(leg);
    stand.add(mesh(new THREE.SphereGeometry(2.4, 12, 8), dark, Math.cos(a) * 25, 2.4, Math.sin(a) * 25));
  }
  stand.add(mesh(new THREE.CylinderGeometry(3.4, 3.8, 6, 20), grey, 0, 9, 0));
  stand.add(mesh(new THREE.CylinderGeometry(2.2, 2.2, 96, 20), white, 0, 58, 0));
  // the arm out to the head, and the head on a yoke
  const arm = mesh(new THREE.BoxGeometry(4, 4, 30), white, 0, 104, 13); stand.add(arm);
  const yoke = new THREE.Group(); yoke.position.set(0, 104, 30); stand.add(yoke);
  const head = new THREE.Group(); yoke.add(head);
  head.rotation.y = 0.9;
  const tilt = new THREE.Group(); head.add(tilt);
  tilt.rotation.x = 0.55;                          // syringes down: the air goes to the plungers' end
  const body = mesh(new THREE.BoxGeometry(22, 14, 26), white, 0, 0, -4); body.castShadow = true; tilt.add(body);
  tilt.add(mesh(new THREE.BoxGeometry(22.4, 2, 26.4), std(0x3d6fb0, 0.5, 0.1), 0, -5.5, -4));
  // the two syringes: A (contrast, in its warmer) and B (saline), out of the head's face
  const syr = [];
  const clear = (c, o) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.08, transparent: true, opacity: o, depthWrite: false, side: THREE.DoubleSide });
  [['A', -5.4, 0xfff2b8], ['B', 5.4, 0xdff2ff]].forEach(([id, x, fluid]) => {
    const s = new THREE.Group(); s.position.set(x, 0, 9); tilt.add(s);
    const barrel = mesh(new THREE.CylinderGeometry(3.0, 3.0, 17, 28, 1, true), clear(0xf4f8fb, 0.28), 0, 0, 8.5);
    barrel.rotation.x = Math.PI / 2; s.add(barrel);
    const cone = mesh(new THREE.CylinderGeometry(0.5, 3.0, 2.6, 28, 1, true), clear(0xf4f8fb, 0.35), 0, 0, 18.3);
    cone.rotation.x = Math.PI / 2; s.add(cone);
    const liquid = mesh(new THREE.CylinderGeometry(2.85, 2.85, 1, 24), clear(fluid, id === 'A' ? 0.55 : 0.35));
    liquid.rotation.x = Math.PI / 2; s.add(liquid);
    const ram = mesh(new THREE.CylinderGeometry(2.9, 2.9, 1.2, 24), std(0x30363d, 0.5, 0.2));
    ram.rotation.x = Math.PI / 2; s.add(ram);
    if (id === 'A') {                               // the heat jacket round the contrast syringe
      const jk = mesh(new THREE.CylinderGeometry(3.35, 3.35, 9, 28, 1, true, 0, Math.PI * 1.3), std(0x5f6a76, 0.6, 0.2, { side: THREE.DoubleSide }), 0, 0, 6);
      jk.rotation.x = Math.PI / 2; s.add(jk);
    }
    syr.push({ id, s, liquid, ram, tip: (() => { const o = new THREE.Object3D(); o.position.set(0, 0, 19.8); s.add(o); return o; })() });
  });
  // the screen on the head's back: rate, volume, pressure (numbers only)
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const screen = mesh(new THREE.PlaneGeometry(16, 8), new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.9 }), 0, 7.05, -6);
  screen.rotation.x = -Math.PI / 2; tilt.add(screen);
  let screenKey = '';
  const paintScreen = (rows) => {
    const k = JSON.stringify(rows); if (k === screenKey) return; screenKey = k;
    const c = cv.getContext('2d'); c.fillStyle = '#071018'; c.fillRect(0, 0, 256, 128);
    c.font = 'bold 30px monospace'; c.textAlign = 'right';
    rows.forEach(([v, unit, col], i) => { c.fillStyle = col; c.fillText(v, 170, 38 + i * 40); c.font = '20px monospace'; c.fillStyle = '#7f8ea3'; c.textAlign = 'left'; c.fillText(unit, 180, 38 + i * 40); c.font = 'bold 30px monospace'; c.textAlign = 'right'; });
    tex.needsUpdate = true;
  };
  // the lines: each syringe's, joined at a Y, then on to the patient's port
  const lineMat = clear(0xf4f8fb, 0.5);
  const fillMat = new THREE.MeshBasicMaterial({ color: 0xfff2b8, transparent: true, opacity: 0.85 });
  const line = { mesh: null, fill: null, curve: null };
  function routeLine(portW) {
    g.updateMatrixWorld(true);
    const ta = syr[0].tip.getWorldPosition(new THREE.Vector3()), tb = syr[1].tip.getWorldPosition(new THREE.Vector3());
    const y = ta.clone().add(tb).multiplyScalar(0.5).add(new THREE.Vector3(0, -6, 0));
    const p = new THREE.Vector3(...portW);
    const mid = y.clone().lerp(p, 0.5); mid.y = Math.min(y.y, p.y) - 6;
    const pts = [y, y.clone().lerp(mid, 0.5).add(new THREE.Vector3(0, -4, 0)), mid, p.clone().add(new THREE.Vector3(...v3.mul(v3.norm(v3.sub([y.x, y.y, y.z], portW)), 6))).setY(p.y + 1.2), p];
    line.curve = new THREE.CatmullRomCurve3(pts);
    for (const k of ['mesh', 'fill']) if (line[k]) { g.remove(line[k]); line[k].geometry.dispose(); }
    line.mesh = new THREE.Mesh(new THREE.TubeGeometry(line.curve, 120, 0.22, 8, false), lineMat);
    line.fill = new THREE.Mesh(new THREE.TubeGeometry(line.curve, 120, 0.15, 6, false), fillMat);
    g.add(line.mesh, line.fill);
    // the two short legs to the Y
    for (const s of syr) {
      const t = s.tip.getWorldPosition(new THREE.Vector3());
      const leg = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([t, t.clone().lerp(y, 0.5).add(new THREE.Vector3(0, -1, 0)), y]), 12, 0.2, 8, false), lineMat);
      leg.userData.leg = true; g.add(leg);
    }
  }
  // the state: a, b the fraction of each syringe left; fill 0..1 how far the contrast has come
  // down the line; rows on the screen
  function set({ a = 1, b = 1, fill = 0, rows = null } = {}) {
    for (const [s, f] of [[syr[0], a], [syr[1], b]]) {
      const L = 16 * Math.max(0.02, f);
      s.liquid.scale.set(1, L, 1); s.liquid.position.z = 17 - L / 2;
      s.ram.position.z = 17 - L - 0.6;
    }
    if (line.fill) line.fill.geometry.setDrawRange(0, Math.floor(fill * 120) * 6 * 6);
    if (rows) paintScreen(rows);
  }
  set();
  return { group: g, head: tilt, syr, set, routeLine, line, floor };
}
