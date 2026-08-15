/* Split the scanned DXA bed into two named nodes, 'bed' and 'head', the way the OEC rig
   was split, so dxa.js can find them by name and translate the head on its own.

   The arm separates on height alone, but the plane has to be the TABLE SURFACE and not the
   height of the horizontal unit. The arm is an L: a horizontal head reaching across the
   table at y 0.20..0.44, carried on a vertical column at y 0.00..0.20 which is a narrow
   post at z [-0.53,-0.34] on the near side. Cutting at 0.15 severs that column and leaves
   its lower half welded to the table — which is exactly what it looked like.
   Cut at y = 0.000 and the arm comes away whole: 8 480 triangles above the plane, every one
   inside the arm's own x band [-0.96,-0.54], and nothing of the table above it. Measured
   across candidates — at -0.005 there are still 113 stray triangles of the table's near lip,
   at -0.02 there are 656, and at 0.000 there are none. */
const fs = require('fs');
const path = require('path');
// usage: node tools/split_dxa_rig.js [source.glb] [out.glb]
const SRC = process.argv[2] || 'C:/Users/mathi/Documents/ComfyUI/output/3D/Hy3D_textured_00040_.glb';
const OUT = process.argv[3] ||
  path.join(__dirname, '..', 'apps', 'web', 'public', 'models', 'rigs', 'dxa_rig.glb');
const SPLIT_Y = 0.0;                  // the table surface: the whole arm lives above it

const b = fs.readFileSync(SRC);
const jsonLen = b.readUInt32LE(12);
const gltf = JSON.parse(b.slice(20, 20 + jsonLen).toString('utf8'));
const bin = b.slice(20 + jsonLen + 8, 20 + jsonLen + 8 + b.readUInt32LE(20 + jsonLen));

const prim = gltf.meshes[0].primitives[0];
function viewOf(accIdx) {
  const a = gltf.accessors[accIdx], bv = gltf.bufferViews[a.bufferView];
  const nc = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const cs = a.componentType === 5126 ? 4 : a.componentType === 5125 ? 4 : 2;
  const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
  return { a, bytes: bin.slice(off, off + a.count * nc * cs), nc, cs };
}
const posV = viewOf(prim.attributes.POSITION);
const uvV  = viewOf(prim.attributes.TEXCOORD_0);
const idxV = viewOf(prim.indices);
const nV = posV.a.count, nT = idxV.a.count / 3;
const pos = new Float32Array(posV.bytes.buffer, posV.bytes.byteOffset, nV * 3);
const idx = idxV.a.componentType === 5125
  ? new Uint32Array(idxV.bytes.buffer, idxV.bytes.byteOffset, nT * 3)
  : new Uint16Array(idxV.bytes.buffer, idxV.bytes.byteOffset, nT * 3);

const bedIdx = [], headIdx = [];
for (let t = 0; t < nT; t++) {
  const a = idx[t*3], b2 = idx[t*3+1], c = idx[t*3+2];
  const cy = (pos[a*3+1] + pos[b2*3+1] + pos[c*3+1]) / 3;
  (cy >= SPLIT_Y ? headIdx : bedIdx).push(a, b2, c);
}
console.log('triangles  bed', bedIdx.length/3, ' head', headIdx.length/3);
const bbox = (arr) => { const mn=[9,9,9], mx=[-9,-9,-9];
  for (const v of arr) for (let k=0;k<3;k++){ const p=pos[v*3+k]; if(p<mn[k])mn[k]=p; if(p>mx[k])mx[k]=p; }
  return mn.map(v=>+v.toFixed(3)) + '  ..  ' + mx.map(v=>+v.toFixed(3)); };
console.log('  bed  bbox', bbox(bedIdx));
console.log('  head bbox', bbox(headIdx));

/* Each part gets its OWN compacted vertex buffer. Sharing one POSITION accessor between
   them looks tempting — the parts barely overlap, so it costs almost nothing in bytes —
   but three.js derives a mesh's bounding box from the position ATTRIBUTE and not from the
   index, so both parts would report the bounds of the whole machine. That is not just a
   cosmetic wrong number: it is what the caller scales by and what it uses to drop the
   table top to y = 0, so the bed would be seated by the height of the scanning arm.
   Re-indexing is a few hundred KB against a 3 MB texture. */
function compact(tri) {
  const map = new Map(), pos2 = [], uv2 = [], idx2 = new Uint32Array(tri.length);
  const uv = new Float32Array(uvV.bytes.buffer, uvV.bytes.byteOffset, nV * 2);
  for (let i = 0; i < tri.length; i++) {
    const v = tri[i];
    let n = map.get(v);
    if (n === undefined) {
      n = pos2.length / 3; map.set(v, n);
      pos2.push(pos[v*3], pos[v*3+1], pos[v*3+2]);
      uv2.push(uv[v*2], uv[v*2+1]);
    }
    idx2[i] = n;
  }
  const p = new Float32Array(pos2), u = new Float32Array(uv2);
  const mn = [1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    if (p[i+k] < mn[k]) mn[k] = p[i+k]; if (p[i+k] > mx[k]) mx[k] = p[i+k];
  }
  return { p, u, idx: idx2, mn, mx, nv: p.length / 3 };
}
const BED = compact(bedIdx), HEAD = compact(headIdx);
console.log('  bed verts', BED.nv, 'bounds', BED.mn.map(v=>+v.toFixed(3)), BED.mx.map(v=>+v.toFixed(3)));
console.log('  head verts', HEAD.nv, 'bounds', HEAD.mn.map(v=>+v.toFixed(3)), HEAD.mx.map(v=>+v.toFixed(3)));
const img = gltf.images[0];
const imgBv = gltf.bufferViews[img.bufferView];
const imgBytes = bin.slice(imgBv.byteOffset || 0, (imgBv.byteOffset || 0) + imgBv.byteLength);

const parts = [], views = [];
const pad4 = (n) => (4 - (n % 4)) % 4;
function push(buf, target) {
  const off = parts.reduce((s, p) => s + p.length, 0);
  parts.push(buf);
  const padN = pad4(buf.length);
  if (padN) parts.push(Buffer.alloc(padN));
  const v = { buffer: 0, byteOffset: off, byteLength: buf.length };
  if (target) v.target = target;
  views.push(v);
  return views.length - 1;
}
const buf = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength);
const vBedP = push(buf(BED.p), 34962), vBedU = push(buf(BED.u), 34962);
const vBedI = push(buf(BED.idx), 34963);
const vHdP  = push(buf(HEAD.p), 34962), vHdU = push(buf(HEAD.u), 34962);
const vHdI  = push(buf(HEAD.idx), 34963);
const vImg  = push(imgBytes);

const accessors = [
  { bufferView: vBedP, componentType: 5126, count: BED.nv, type: 'VEC3', min: BED.mn, max: BED.mx },
  { bufferView: vBedU, componentType: 5126, count: BED.nv, type: 'VEC2' },
  { bufferView: vBedI, componentType: 5125, count: BED.idx.length, type: 'SCALAR' },
  { bufferView: vHdP, componentType: 5126, count: HEAD.nv, type: 'VEC3', min: HEAD.mn, max: HEAD.mx },
  { bufferView: vHdU, componentType: 5126, count: HEAD.nv, type: 'VEC2' },
  { bufferView: vHdI, componentType: 5125, count: HEAD.idx.length, type: 'SCALAR' },
];
const out = {
  asset: { version: '2.0', generator: 'RadSim dxa rig splitter' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    { name: 'world', children: [1, 2] },
    { name: 'bed', mesh: 0 },
    { name: 'head', mesh: 1 },
  ],
  meshes: [
    { name: 'bed',  primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] },
    { name: 'head', primitives: [{ attributes: { POSITION: 3, TEXCOORD_0: 4 }, indices: 5, material: 0 }] },
  ],
  materials: gltf.materials,
  textures: gltf.textures,
  samplers: gltf.samplers || [{}],
  images: [{ bufferView: vImg, mimeType: img.mimeType || 'image/png' }],
  accessors,
  bufferViews: views,
  buffers: [{ byteLength: parts.reduce((s, p) => s + p.length, 0) }],
};
const binOut = Buffer.concat(parts);
let jsonStr = JSON.stringify(out);
jsonStr += ' '.repeat(pad4(Buffer.byteLength(jsonStr)));
const jsonBuf = Buffer.from(jsonStr, 'utf8');
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binOut.length, 8);
const jHdr = Buffer.alloc(8); jHdr.writeUInt32LE(jsonBuf.length, 0); jHdr.writeUInt32LE(0x4e4f534a, 4);
const bHdr = Buffer.alloc(8); bHdr.writeUInt32LE(binOut.length, 0); bHdr.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(OUT, Buffer.concat([header, jHdr, jsonBuf, bHdr, binOut]));
console.log('wrote', OUT, (fs.statSync(OUT).size / 1e6).toFixed(2), 'MB');
