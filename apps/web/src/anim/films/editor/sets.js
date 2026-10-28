/* MODEL EDITOR FILM: the 3D sets. One frame for all of them: +x the patient's right, +y anterior
   (up: the patient lies supine), +z superior (the head); cm.
     ct      a CT gantry (the film's own: ct.js keeps its machine to itself) and its couch, the
             patient's skin and bone meshes (the model's own display surfaces) on it, the scan
             plane at z = 0
     vol     the volume on its own: the slices as plates, the editor's 3D preview (one cube per
             surface voxel, editor.js buildVoxelInstanced), a cut face, the slice being edited
     room    the x-ray room (room.js, the app's): the saved model on the tabletop, the tube head
             100 cm above the receptor, the image on the receptor
     fluoro  the C-arm (carm.js, the app's OEC) round the same model on a stretcher */
import * as THREE from 'three';
import { std, mesh, beamCone, rayLines, setOpacity } from '../../kit/stage.js';
import { buildRoom, buildTubeHead } from '../../../room.js';
import { buildCarm, CARM } from '../../../carm.js';
import { RGB, SLICE, ZE, hex } from './data.js';
import { capMeshFrame } from '../capFrame.js';

export const BORE_R = 35;
const GANT_IN = 38, GANT_OUT = 92, GANT_D = 56;
export const SAD = 57, SDD = 104;                      // the CT's focal spot to the axis, to the detector

// a canvas texture, nearest-filtered (voxels stay square)
export function canvasTex(w, h) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.LinearFilter;
  return { cv, g: cv.getContext('2d'), tex };
}

// a slice drawn into a canvas, a voxel a pixel, the canvas's top the anterior (high y)
export function drawSliceCanvas(g, nx, ny, colour) {
  const im = g.createImageData(nx, ny), d = im.data;
  for (let r = 0; r < ny; r++) {
    const y = ny - 1 - r;
    for (let x = 0; x < nx; x++) {
      const c = colour(x, y), o = (r * nx + x) * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c[3] ?? 255;
    }
  }
  g.putImageData(im, 0, 0);
}

export function buildSets(api, S, D) {
  const { scene } = api;
  const E = D.E;
  const sets = S.sets;

  // ================================================================ the editor's 3D preview
  // one cube per surface voxel of the editor's copy (4 mm), in the volume's frame (cm)
  // (instances run head to foot, so drawing the first n of them shows the body above a cut: a cut
  // seen from the feet, as slices are read)
  const nShell = E.shell.length / 3, sh = (i) => (nShell - 1 - i) * 3;
  const shell = new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.05 }), nShell);
  {
    const m = new THREE.Matrix4(), ex = E.nx * 0.4 / 2, ey = E.ny * 0.4 / 2, ez = E.nz * 0.4 / 2;
    for (let i = 0; i < nShell; i++) {
      const k = sh(i);
      m.makeTranslation((E.shell[k] + 0.5) * 0.4 - ex, (E.shell[k + 1] + 0.5) * 0.4 - ey, (E.shell[k + 2] + 0.5) * 0.4 - ez);
      shell.setMatrixAt(i, m);
    }
    shell.instanceMatrix.needsUpdate = true;
  }
  shell.castShadow = true; shell.receiveShadow = true;
  const col = new THREE.Color();
  S.colourShell = (edited) => {
    const src = edited ? E.data : E.orig;
    for (let i = 0; i < nShell; i++) {
      const k = sh(i), [r, g, b] = RGB[src[E.i(E.shell[k], E.shell[k + 1], E.shell[k + 2])]];
      shell.setColorAt(i, col.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace));
    }
    shell.instanceColor.needsUpdate = true;
  };
  S.colourShell(false);
  shell.computeBoundingBox(); shell.computeBoundingSphere();
  const shellG = new THREE.Group(); shellG.add(shell);
  S.shell = shell; S.shellG = shellG;
  // cut the preview at slice z (of the editor's copy): the cubes from z up to the head
  S.cutShell = (z) => { shell.count = z == null ? nShell : nShell - E.shellBelow(z); };
  S.zOfE = (z) => (z + 0.5) * 0.4 - E.nz * 0.4 / 2;          // a slice of the editor's copy -> z (cm)
  S.zOfF = (z) => (z + 0.5) * 0.2 - D.nz * 0.2 / 2;          // a full-resolution slice -> z (cm)
  S.put = (obj, parent, pos = [0, 0, 0]) => { parent.add(obj); obj.position.set(...pos); obj.updateMatrixWorld(true); };

  // ================================================================ ct
  const ct = new THREE.Group(); scene.add(ct); sets.ct = ct;
  const white = std(0xeef1f4, 0.45, 0.05), trim = std(0x9fb0c2, 0.45, 0.2), dark = std(0x2b3138, 0.6, 0.2);
  // the housing: an annulus 56 cm deep, its upper right quarter (toward the camera) cut away
  const a0 = 70 * Math.PI / 180, a1 = 340 * Math.PI / 180;
  const shp = new THREE.Shape();
  shp.absarc(0, 0, GANT_OUT, a0, a1, false);
  shp.absarc(0, 0, GANT_IN, a1, a0, true);
  const hous = new THREE.Mesh(new THREE.ExtrudeGeometry(shp, { depth: GANT_D, bevelEnabled: true, bevelThickness: 2, bevelSize: 2, bevelSegments: 3, curveSegments: 72 }), white);
  hous.geometry.translate(0, 0, -GANT_D / 2); hous.castShadow = hous.receiveShadow = true;
  ct.add(hous);
  // the bore liner and the face ring round it
  const liner = new THREE.Mesh(new THREE.CylinderGeometry(BORE_R, BORE_R, GANT_D + 2, 72, 1, true).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xdfe6ec, roughness: 0.5, side: THREE.DoubleSide, transparent: true, opacity: 0.35, depthWrite: false }));
  ct.add(liner);
  for (const s of [-1, 1]) { const ring = mesh(new THREE.TorusGeometry(GANT_IN - 1, 1.6, 12, 96), trim, 0, 0, s * (GANT_D / 2 + 2)); ct.add(ring); }
  // a pedestal under the housing
  ct.add(mesh(new THREE.BoxGeometry(150, 12, 70), dark, 0, -GANT_OUT - 4, 0));
  // the rotating part: the tube (its focal spot SAD above the axis), the detector arc opposite
  const spin = new THREE.Group(); ct.add(spin);
  const tubeBox = mesh(new THREE.BoxGeometry(22, 12, 26), std(0x56606b, 0.4, 0.5), 0, SAD + 7, 0); spin.add(tubeBox);
  spin.add(mesh(new THREE.CylinderGeometry(5, 5, 26, 24).rotateX(Math.PI / 2), std(0x8a949e, 0.35, 0.6), 0, SAD + 7, 0));
  const detArc = new THREE.Group(); spin.add(detArc);
  const FAN = 0.46;                                          // the fan's half-angle (rad)
  for (let i = 0; i <= 18; i++) {
    const g = -FAN + (2 * FAN * i) / 18, x = SDD * Math.sin(g), y = SAD - SDD * Math.cos(g);
    const b = mesh(new THREE.BoxGeometry(6.2, 5, 9), std(0x24303c, 0.5, 0.3, { emissive: 0x0b1a2a }), x, y - 2, 0);
    b.rotation.z = g; detArc.add(b);
  }
  spin.add(mesh(new THREE.BoxGeometry(18, 14, 22), std(0x3a424c, 0.5, 0.4), -60, -20, 0));   // the counterweight / electronics
  const fan = beamCone(0x9d7bff, 0.22); spin.add(fan);
  {
    const p = (g, z) => [SDD * Math.sin(g), SAD - SDD * Math.cos(g), z];
    fan.userData.set([0, SAD, 0], [p(-FAN, -0.6), p(FAN, -0.6), p(FAN, 0.6), p(-FAN, 0.6)]);
  }
  // the couch: a pedestal at the foot end (the patient goes in head first), the top that travels
  const couchBase = mesh(new THREE.BoxGeometry(34, 70, 60), std(0x59626e, 0.6, 0.15), 0, -64, -165); ct.add(couchBase);
  ct.add(mesh(new THREE.BoxGeometry(50, 5, 80), dark, 0, -101, -165));
  const travel = new THREE.Group(); ct.add(travel);          // the couch top and the patient, moved along z
  travel.add(mesh(new THREE.BoxGeometry(48, 3.2, 200), std(0x30373f, 0.55, 0.2), 0, -17.6, -40));
  travel.add(mesh(new THREE.BoxGeometry(44, 1.2, 196), std(0x5a6672, 0.6, 0.1), 0, -15.8, -40));    // the pad
  const patient = new THREE.Group(); travel.add(patient);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(500, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1b2027, roughness: 0.95 }));
  floor.position.y = -104; floor.receiveShadow = true; ct.add(floor);
  // the scan plane: where the fan crosses the patient, a thin glowing ring
  const scanRing = new THREE.Mesh(new THREE.TorusGeometry(BORE_R - 1.2, 0.35, 8, 96), new THREE.MeshBasicMaterial({ color: 0xb59cff, transparent: true, opacity: 0.7 }));
  ct.add(scanRing);
  S.ct = { g: ct, spin, fan, tube: tubeBox, detArc, travel, patient, hous, couchBase, scanRing, FAN };

  // the model's own display meshes (mm, centred on the volume: x/y/z as the voxels)
  S.meshes = { skin: null, bone: null };
  const meshesReady = Promise.all([
    api.loadGlb('models/chestabdopelvis/chestabdopelvis_skin.glb').catch(() => null),
    api.loadGlb('models/chestabdopelvis/chestabdopelvis_bone.glb').catch(() => null),
  ]).then(([skin, bone]) => {
    const prep = (g, mat) => {
      if (!g) return null;
      capMeshFrame(g);
      g.scale.setScalar(0.1);
      g.traverse((o) => { if (o.isMesh) { if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); o.material = mat; o.castShadow = true; } });
      return g;
    };
    S.meshes.skin = prep(skin, new THREE.MeshStandardMaterial({ color: 0xd8a080, roughness: 0.6, metalness: 0 }));
    S.meshes.bone = prep(bone, std(0xe8e0c8, 0.5, 0.05));
  });

  // ================================================================ vol
  const vol = new THREE.Group(); scene.add(vol); sets.vol = vol;
  // the slices, every 8th, as plates of their HU (soft-tissue window), air clear
  const plates = new THREE.Group(); vol.add(plates);
  const PLATE_EVERY = 8;
  S.plates = [];
  for (let z = 4; z < D.nz; z += PLATE_EVERY) {
    const { cv, g, tex } = canvasTex(D.nx, D.ny);
    const hu = D.huSlice(z);
    drawSliceCanvas(g, D.nx, D.ny, (x, y) => {
      const id = D.at(x, y, z);
      if (id === 0) return [0, 0, 0, 0];
      const v = D.grey(hu[x + D.nx * y]); return [v, v, v, 255];
    });
    tex.needsUpdate = true; void cv;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(D.nx * 0.2, D.ny * 0.2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide }));
    m.position.z = S.zOfF(z); m.userData.z = z;
    plates.add(m); S.plates.push(m);
  }
  // the cut face: the full-resolution slice SLICE, in HU or in its materials
  const cap = canvasTex(D.nx, D.ny);
  const capMesh = new THREE.Mesh(new THREE.PlaneGeometry(D.nx * 0.2, D.ny * 0.2), new THREE.MeshBasicMaterial({ map: cap.tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide }));
  vol.add(capMesh);
  S.paintCap = (mode) => {
    const hu = D.huSlice(SLICE);
    drawSliceCanvas(cap.g, D.nx, D.ny, (x, y) => {
      const id = D.at(x, y, SLICE);
      if (id === 0) return [0, 0, 0, 0];
      if (mode === 'mat') return [...RGB[id], 255];
      const v = D.grey(hu[x + D.nx * y]); return [v, v, v, 255];
    });
    cap.tex.needsUpdate = true;
  };
  S.paintCap('hu');
  S.cap = capMesh;
  // the slice the editor shows: its plane (a voxel thick), a frame round it
  const ed = canvasTex(E.nx, E.ny);
  const edPlane = new THREE.Mesh(new THREE.PlaneGeometry(E.nx * 0.4, E.ny * 0.4), new THREE.MeshBasicMaterial({ map: ed.tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide }));
  vol.add(edPlane);
  const frameGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(E.nx * 0.4 + 1.2, E.ny * 0.4 + 1.2, 0.4));
  const edFrame = new THREE.LineSegments(frameGeo, new THREE.LineBasicMaterial({ color: 0x35c6d6 }));
  vol.add(edFrame);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(E.nx * 0.4 + 1.2, E.ny * 0.4 + 1.2), new THREE.MeshBasicMaterial({ color: 0x35c6d6, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
  vol.add(glass);
  let edShown = -1;
  S.paintEd = (z, edited = false) => {
    const key = z * 2 + (edited ? 1 : 0);
    if (edShown !== key) {
      edShown = key;
      const src = edited ? E.data : E.orig;
      drawSliceCanvas(ed.g, E.nx, E.ny, (x, y) => { const id = src[E.i(x, y, z)]; return id ? [...RGB[id], 255] : [0, 0, 0, 0]; });
      ed.tex.needsUpdate = true;
    }
    // (on the slice's lower face: the face a cut there shows, from the feet)
    const zz = S.zOfE(z) - 0.22;
    edPlane.position.z = zz; edFrame.position.z = zz; glass.position.z = zz;
  };
  S.ed = { plane: edPlane, frame: edFrame, glass };
  // the dimension lines round the block (drawn by the steps, numbers on the 8-bit layer)
  const dims = rayLines(0x7ff6ff, 0.9, 32); vol.add(dims);
  S.dims = dims;
  S.extF = [D.nx * 0.2, D.ny * 0.2, D.nz * 0.2];

  // ================================================================ room
  const room = new THREE.Group(); scene.add(room); sets.room = room;
  const r = buildRoom(room, { aecCells: { l: { x: 7.5, z: 4.5 }, c: { x: 0, z: -4.5 }, r: { x: -7.5, z: 4.5 } } });
  r.table.visible = true; r.floor.visible = true; r.column.visible = true;
  const tube = new THREE.Group(); tube.position.set(0, 100, 0); room.add(tube);
  const head = buildTubeHead(tube);
  tube.lookAt(0, 0, 0); tube.rotateX(Math.PI / 2); tube.rotateY(-Math.PI / 2);
  room.updateMatrixWorld(true);
  r.placeColumn(head.mount.getWorldPosition(new THREE.Vector3()), -80);
  // the image on the receptor (drawn just over the tray, under the tabletop)
  const img = canvasTex(D.proj.w, D.proj.h);
  const imgPlane = new THREE.Mesh(new THREE.PlaneGeometry(D.proj.w * D.proj.px, D.proj.h * D.proj.px), new THREE.MeshBasicMaterial({ map: img.tex, toneMapped: false }));
  // (lying flat, its top toward the head (+z), seen from above: the patient's right on the left)
  imgPlane.rotation.x = -Math.PI / 2; imgPlane.rotation.z = Math.PI; imgPlane.position.y = 0.93;
  room.add(imgPlane);
  // fill the image to row k (and column c of row k), the rest the receptor's dark
  let imgShown = -1;
  S.paintImage = (rows, cols = 0) => {
    const key = rows * 1000 + cols;
    if (key === imgShown) return;
    imgShown = key;
    const { w, h, grey } = D.proj, g = img.g, im = g.createImageData(w, h), d = im.data;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      // (the plane lies with the canvas's right toward -x, its top toward +z: image (i, j) is
      // canvas (i, j), as the engine's detU = -x, detV = -z lay it out)
      const o = (j * w + i) * 4, on = j < rows || (j === rows && i < cols);
      // a radiograph: dark where many photons arrived, white where few did
      const v = on ? grey[j * w + i] : 0;
      d[o] = on ? v : 14; d[o + 1] = on ? v : 18; d[o + 2] = on ? v : 24; d[o + 3] = 255;
    }
    g.putImageData(im, 0, 0); img.tex.needsUpdate = true;
  };
  S.paintImage(0);
  const roomRays = rayLines(0xffd166, 0.5, 200); room.add(roomRays);
  const roomBeam = beamCone(0x9d7bff, 0.07); room.add(roomBeam);
  S.room = { g: room, r, tube, head, imgPlane, rays: roomRays, beam: roomBeam, focal: [0, 100, 0] };

  // ================================================================ fluoro
  const fluoro = new THREE.Group(); scene.add(fluoro); sets.fluoro = fluoro;
  const OEC = { SID: 99, SRC_ISO: 60 }, FLOOR = -90;
  const iso = [0, D.fluoro.isoY, 0];
  const carm = buildCarm(OEC.SID, OEC.SRC_ISO);
  for (const g of Object.values(carm)) fluoro.add(g);
  // posed as fluoro.js poses it at zero angles: the cross-arm along +x from the column to the
  // isocentre, the C in the x-y plane, the beam up from the tube under the table
  const colX = iso[0] - CARM.LARM;
  carm.holder.position.set(...iso); carm.c.position.set(...iso);
  carm.boom.position.set(colX, iso[1], iso[2]); carm.column.position.set(colX, iso[1], iso[2]);
  carm.base.position.set(colX, FLOOR, iso[2]);
  // a stretcher: a thin top cantilevered from a pedestal past the feet (so the C reaches under)
  const strTop = 5.0;
  fluoro.add(mesh(new THREE.BoxGeometry(56, 1.6, 250), std(0x2a2f36, 0.5, 0.2), 0, strTop - 0.8, -35));
  fluoro.add(mesh(new THREE.BoxGeometry(22, strTop - FLOOR - 6, 18), std(0x59626e, 0.55, 0.15), 0, (strTop + FLOOR) / 2 - 3, -150));
  fluoro.add(mesh(new THREE.BoxGeometry(46, 4, 40), std(0x2b3138, 0.6, 0.2), 0, FLOOR + 2, -150));
  const ffloor = new THREE.Mesh(new THREE.CircleGeometry(420, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1b2027, roughness: 0.95 }));
  ffloor.position.y = FLOOR; ffloor.receiveShadow = true; fluoro.add(ffloor);
  const fBeam = beamCone(0x35c6d6, 0.0); fluoro.add(fBeam);
  {
    const s = [iso[0], iso[1] - OEC.SRC_ISO, iso[2]], h = 12, Y = iso[1] + OEC.SID - OEC.SRC_ISO;
    fBeam.userData.set(s, [[-h, Y, -h], [h, Y, -h], [h, Y, h], [-h, Y, h]]);
  }
  S.fluoro = { g: fluoro, carm, beam: fBeam, iso };

  S.only = (k) => { for (const [n, g] of Object.entries(sets)) g.visible = n === k; };
  void hex; void ZE; void setOpacity;
  return meshesReady;
}
