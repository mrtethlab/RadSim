/* ============================================================================
   MODEL EDITOR MODE — build voxel models by painting one-voxel-thick transverse
   slices on a pixelated grid, with a live 3D voxel render in the main scene.
   Slices use the predetermined HU materials list (the same legend the baked
   models ship with). Models load from the presets, save to the session, and
   download / re-upload as .rsmodel.json files (gzip-compressed volume).
   Volume axes match the baked models: x=Left, y=Posterior, z=Superior,
   x-fastest (i = x + nx*(y + ny*z)). Display = axial CT convention
   (anterior at the top, patient left on the viewer's right).
   ============================================================================ */
import { loadVoxelModel } from './model/voxelLoader.js';

// The predetermined HU materials list (matches the baked models' legend).
export const ED_MATERIALS = [
  { id: 0,  name: 'Air',                 hu: -1000, color: '#000000' },
  { id: 1,  name: 'Lung',                hu: -700,  color: '#3a4a63' },
  { id: 2,  name: 'Fat',                 hu: -90,   color: '#f2e2b0' },
  { id: 3,  name: 'Water',               hu: 0,     color: '#2f6fb0' },
  { id: 4,  name: 'Cerebrospinal fluid', hu: 12,    color: '#4a90c0' },
  { id: 5,  name: 'Simple fluid',        hu: 10,    color: '#3f80b8' },
  { id: 6,  name: 'Bile',                hu: 20,    color: '#6b8e23' },
  { id: 7,  name: 'Muscle',              hu: 45,    color: '#9e4b4b' },
  { id: 8,  name: 'Blood',               hu: 45,    color: '#b23a3a' },
  { id: 9,  name: 'Clotted blood',       hu: 75,    color: '#7a2222' },
  { id: 10, name: 'Soft tissue',         hu: 40,    color: '#c07a6a' },
  { id: 11, name: 'Liver',               hu: 60,    color: '#8a4b32' },
  { id: 12, name: 'Spleen',              hu: 50,    color: '#6d3b52' },
  { id: 13, name: 'Kidney',              hu: 40,    color: '#9c5a3c' },
  { id: 14, name: 'Pancreas',            hu: 40,    color: '#c9a15a' },
  { id: 15, name: 'Heart / myocardium',  hu: 45,    color: '#a83232' },
  { id: 16, name: 'Cartilage',           hu: 110,   color: '#cfd8e0' },
  { id: 17, name: 'Trabecular bone',     hu: 300,   color: '#e8dfc0' },
  { id: 18, name: 'Cortical bone',       hu: 1200,  color: '#faf3dc' },
  { id: 19, name: 'Tooth enamel',        hu: 2500,  color: '#ffffff' },
  { id: 20, name: 'Iodine contrast',     hu: 350,   color: '#ffd24d' },
  { id: 21, name: 'Calcification',       hu: 600,   color: '#f0ead2' },
  { id: 22, name: 'Kidney stone',        hu: 800,   color: '#d8cba0' },
  { id: 23, name: 'Skin',                hu: 30,    color: '#d8a07a' },
  { id: 24, name: 'Aluminum',            hu: null,  color: '#9fb4c0' },
  { id: 25, name: 'Titanium',            hu: null,  color: '#b8c2cc' },
  { id: 26, name: 'Stainless steel',     hu: null,  color: '#d0d4d8' },
  { id: 27, name: 'Lead',                hu: null,  color: '#6a6f77' },
  { id: 28, name: 'Acrylic',             hu: 120,   color: '#9fb6a8' },
];
const MAT_BY_ID = Object.fromEntries(ED_MATERIALS.map(m => [m.id, m]));
const MAT_RGB = {};   // id -> [r,g,b]
for (const m of ED_MATERIALS) {
  const h = m.color; MAT_RGB[m.id] = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

let ctx = null;                 // { THREE, S, $, three, setCameraView, setOrbitRad, syncScene }
let ED = null;                  // the working model (S.editor points here)
let edGroup = null;             // 3D preview group in the main scene
let edMesh = null;              // current InstancedMesh
let rebuildTimer = 0;
let drag = null;                // active paint stroke / shape drag
const EDITABLE_MAX = 150;       // presets are downsampled to at most this many voxels per axis

export function initEditor(context) {
  ctx = context;
  const { S, $, THREE, three } = ctx;
  S.editor = { saved: [] };
  edGroup = new THREE.Group(); edGroup.visible = false; three.scene.add(edGroup);
  three.edGroup = edGroup;

  // materials palette
  const mats = $('edMats');
  if (mats) {
    mats.innerHTML = ED_MATERIALS.map(m =>
      '<button class="edmat' + (m.id === 10 ? ' on' : '') + '" data-mat="' + m.id + '" title="' + m.name + (m.hu != null ? ' · ' + m.hu + ' HU' : '') + '">'
      + '<span class="sw" style="background:' + m.color + '"></span><span class="mn">' + m.name + '</span>'
      + '<span class="mh">' + (m.hu != null ? m.hu : '—') + '</span></button>').join('');
    mats.addEventListener('click', e => {
      const b = e.target.closest('button[data-mat]'); if (!b) return;
      ED.mat = +b.dataset.mat;
      mats.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    });
  }
  // tools
  $('edTools')?.addEventListener('click', e => {
    const b = e.target.closest('button[data-tool]'); if (!b) return;
    ED.tool = b.dataset.tool;
    $('edTools').querySelectorAll('button[data-tool]').forEach(x => x.classList.toggle('on', x === b));
  });
  $('edSize')?.addEventListener('input', e => { ED.size = +e.target.value; $('edSizeV').textContent = ED.size; });
  // slice scroll: slider + wheel on the canvas
  $('edSlice')?.addEventListener('input', e => { ED.slice = +e.target.value; drawSlice(); });
  $('edWrap')?.addEventListener('wheel', e => {
    e.preventDefault();
    ED.slice = Math.max(0, Math.min(ED.nz - 1, ED.slice + (e.deltaY > 0 ? 1 : -1)));
    $('edSlice').value = ED.slice; drawSlice();
  }, { passive: false });
  // painting
  const ov = $('edOverlay');
  ov?.addEventListener('pointerdown', e => {
    const c = evtCell(e); if (!c) return;
    ov.setPointerCapture(e.pointerId);
    const t = ED.tool;
    if (t === 'fill') { floodFill(c.x, c.y); commitStroke(); return; }
    drag = { t, x0: c.x, y0: c.y, x1: c.x, y1: c.y };
    if (t === 'brush' || t === 'eraser') { paintDab(c.x, c.y, t === 'eraser' ? 0 : ED.mat); drawSlice(); }
  });
  ov?.addEventListener('pointermove', e => {
    if (!drag) return;
    const c = evtCell(e); if (!c) return;
    if (drag.t === 'brush' || drag.t === 'eraser') {
      paintLine(drag.x1, drag.y1, c.x, c.y, drag.t === 'eraser' ? 0 : ED.mat, true);
      drag.x1 = c.x; drag.y1 = c.y; drawSlice();
    } else { drag.x1 = c.x; drag.y1 = c.y; drawShapePreview(); }
  });
  const endStroke = e => {
    if (!drag) return;
    const d = drag; drag = null; clearOverlay();
    if (d.t === 'line') paintLine(d.x0, d.y0, d.x1, d.y1, ED.mat, true);
    else if (d.t === 'rect') paintRect(d.x0, d.y0, d.x1, d.y1, ED.mat);
    else if (d.t === 'circle') paintCircle(d.x0, d.y0, d.x1, d.y1, ED.mat);
    commitStroke();
  };
  ov?.addEventListener('pointerup', endStroke);
  ov?.addEventListener('pointercancel', endStroke);

  // model management
  $('edNew')?.addEventListener('click', () => {
    const [n, sp] = $('edNewSize').value.split(',').map(Number);
    newModel(n, n, n, sp, 'custom model');
  });
  $('edLoadPreset')?.addEventListener('click', () => loadPreset($('edPreset').value));
  $('edSaveSession')?.addEventListener('click', saveToSession);
  $('edDownload')?.addEventListener('click', downloadModel);
  $('edUpload')?.addEventListener('click', () => $('edFile').click());
  $('edFile')?.addEventListener('change', e => { const f = e.target.files[0]; if (f) uploadModel(f); e.target.value = ''; });
  window.addEventListener('resize', () => { if (ctx.S.mode === 'editor') { fitCanvas(); editorSyncScene(); } });
}

/* ---- model lifecycle ---- */
function newModel(nx, ny, nz, spMM, name) {
  ED = ctx.S.editor.model = {
    nx, ny, nz, sp: [spMM, spMM, spMM], name,
    data: new Uint8Array(nx * ny * nz),
    slice: Math.floor(nz / 2), tool: ED?.tool || 'brush', size: ED?.size || 3, mat: ED?.mat ?? 10,
  };
  const $ = ctx.$;
  $('edName').value = name;
  $('edSlice').max = nz - 1; $('edSlice').value = ED.slice;
  fitCanvas(); drawSlice(); schedule3D(0);
}
function adoptModel(m) {
  ED = ctx.S.editor.model = { ...m, slice: Math.min(m.slice ?? Math.floor(m.nz / 2), m.nz - 1),
    tool: ED?.tool || 'brush', size: ED?.size || 3, mat: ED?.mat ?? 10 };
  const $ = ctx.$;
  $('edName').value = ED.name;
  $('edSlice').max = ED.nz - 1; $('edSlice').value = ED.slice;
  fitCanvas(); drawSlice(); schedule3D(0);
}
async function loadPreset(id) {
  const $ = ctx.$; const hint = $('edHint');
  try {
    if (hint) hint.textContent = 'Loading ' + id + '…';
    const vm = await loadVoxelModel(import.meta.env.BASE_URL + 'models/' + id, id);
    if (!vm.data) throw new Error('backend-only model — no volume in the browser');
    let [nx, ny, nz] = vm.dims, sp = vm.spacingMM.slice(), data = vm.data;
    // downsample big presets so slice painting stays practical (max EDITABLE_MAX per axis)
    const k = Math.max(1, Math.ceil(Math.max(nx, ny, nz) / EDITABLE_MAX));
    if (k > 1) {
      const mx = Math.floor(nx / k), my = Math.floor(ny / k), mz = Math.floor(nz / k);
      const out = new Uint8Array(mx * my * mz);
      for (let z = 0; z < mz; z++) for (let y = 0; y < my; y++) for (let x = 0; x < mx; x++)
        out[x + mx * (y + my * z)] = data[x * k + nx * (y * k + ny * (z * k))];
      nx = mx; ny = my; nz = mz; data = out; sp = sp.map(s => s * k);
    }
    adoptModel({ nx, ny, nz, sp, data, name: id + (k > 1 ? ' (÷' + k + ')' : '') });
    if (hint) hint.textContent = 'Loaded ' + id + ' · ' + nx + '×' + ny + '×' + nz + ' @ ' + sp[0].toFixed(1) + ' mm';
  } catch (err) { if (hint) hint.textContent = 'Load failed: ' + err.message; }
}

/* ---- slice canvas ---- */
function fitCanvas() {
  const $ = ctx.$; const wrap = $('edWrap'), cv = $('edCanvas'), ov = $('edOverlay');
  if (!wrap || !ED) return;
  const availW = wrap.clientWidth, availH = wrap.clientHeight;
  const ar = (ED.nx * ED.sp[0]) / (ED.ny * ED.sp[1]);            // physical aspect
  let w = availW, h = w / ar; if (h > availH) { h = availH; w = h * ar; }
  for (const c of [cv, ov]) { c.style.width = Math.floor(w) + 'px'; c.style.height = Math.floor(h) + 'px'; }
  cv.width = ED.nx; cv.height = ED.ny;                            // 1 canvas px = 1 voxel (CSS scales, pixelated)
  ov.width = ED.nx; ov.height = ED.ny;
  drawSlice();
}
function drawSlice() {
  const $ = ctx.$; const cv = $('edCanvas'); if (!cv || !ED) return;
  const { nx, ny, data, slice } = ED, g = cv.getContext('2d');
  const img = g.createImageData(nx, ny), d8 = img.data;
  for (let j = 0; j < ny; j++) {
    const y = ny - 1 - j;                                         // anterior (high y = posterior) at the bottom
    for (let x = 0; x < nx; x++) {
      const id = data[x + nx * (y + ny * slice)], c = MAT_RGB[id] || [255, 0, 255];
      const o = (j * nx + x) * 4; d8[o] = c[0]; d8[o + 1] = c[1]; d8[o + 2] = c[2]; d8[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  $('edSliceLab').textContent = 'slice ' + (slice + 1) + ' / ' + ED.nz + ' · ' + ((slice + 0.5) * ED.sp[2]).toFixed(0) + ' mm';
}
/* pointer event -> voxel cell {x,y} (volume coords) or null */
function evtCell(e) {
  const ov = ctx.$('edOverlay'), r = ov.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) return null;
  return { x: Math.floor(fx * ED.nx), y: ED.ny - 1 - Math.floor(fy * ED.ny) };
}

/* ---- painting primitives (operate on the CURRENT slice) ---- */
function setVox(x, y, id) {
  if (x < 0 || y < 0 || x >= ED.nx || y >= ED.ny) return;
  ED.data[x + ED.nx * (y + ED.ny * ED.slice)] = id;
}
function paintDab(cx, cy, id) {
  const r = ED.size / 2;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) setVox(x, y, id);
}
function paintLine(x0, y0, x1, y1, id, dab) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) {
    const x = Math.round(x0 + (x1 - x0) * i / n), y = Math.round(y0 + (y1 - y0) * i / n);
    dab ? paintDab(x, y, id) : setVox(x, y, id);
  }
}
function paintRect(x0, y0, x1, y1, id) {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) setVox(x, y, id);
}
function paintCircle(x0, y0, x1, y1, id) {
  const r = Math.hypot(x1 - x0, y1 - y0);
  for (let y = Math.floor(y0 - r); y <= Math.ceil(y0 + r); y++)
    for (let x = Math.floor(x0 - r); x <= Math.ceil(x0 + r); x++)
      if ((x - x0) * (x - x0) + (y - y0) * (y - y0) <= r * r) setVox(x, y, id);
}
function floodFill(sx, sy) {
  const { nx, ny, data, slice } = ED, base = nx * ny * slice;
  const from = data[sx + nx * sy + base], to = ED.mat;
  if (from === to) return;
  const stack = [sx + nx * sy];
  while (stack.length) {
    const k = stack.pop(), x = k % nx, y = (k / nx) | 0;
    if (data[k + base] !== from) continue;
    data[k + base] = to;
    if (x > 0) stack.push(k - 1); if (x < nx - 1) stack.push(k + 1);
    if (y > 0) stack.push(k - nx); if (y < ny - 1) stack.push(k + nx);
  }
}
function commitStroke() { drawSlice(); schedule3D(); }
/* shape drag preview on the overlay canvas */
function drawShapePreview() {
  const ov = ctx.$('edOverlay'), g = ov.getContext('2d');
  g.clearRect(0, 0, ov.width, ov.height);
  g.strokeStyle = '#35c6d6'; g.lineWidth = 1;
  const P = (x, y) => [x + 0.5, ED.ny - 1 - y + 0.5];             // volume -> canvas px
  const [ax, ay] = P(drag.x0, drag.y0), [bx, by] = P(drag.x1, drag.y1);
  g.beginPath();
  if (drag.t === 'line') { g.moveTo(ax, ay); g.lineTo(bx, by); }
  else if (drag.t === 'rect') g.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
  else if (drag.t === 'circle') g.arc(ax, ay, Math.hypot(bx - ax, by - ay), 0, Math.PI * 2);
  g.stroke();
}
function clearOverlay() { const ov = ctx.$('edOverlay'); ov.getContext('2d').clearRect(0, 0, ov.width, ov.height); }

/* ---- live 3D preview: surface voxels as an instanced cube mesh (mm units, /10 scale) ---- */
function schedule3D(delay) {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild3D, delay ?? 280);
}
function rebuild3D() {
  const { THREE } = ctx;
  if (!ED) return;
  if (edMesh) { edGroup.remove(edMesh); edMesh.geometry.dispose(); edMesh.material.dispose(); edMesh = null; }
  const { nx, ny, nz, data, sp } = ED, nxy = nx * ny;
  const at = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) ? 0 : data[x + nx * y + nxy * z];
  // count + collect surface voxels (any 6-neighbour empty)
  const idx = [];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const id = data[x + nx * y + nxy * z]; if (!id) continue;
    if (!at(x - 1, y, z) || !at(x + 1, y, z) || !at(x, y - 1, z) || !at(x, y + 1, z) || !at(x, y, z - 1) || !at(x, y, z + 1))
      idx.push(x, y, z, id);
  }
  const n = idx.length / 4;
  if (!n) return;
  const geo = new THREE.BoxGeometry(sp[0], sp[1], sp[2]);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.05 });
  edMesh = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4(), col = new THREE.Color();
  const cx = nx * sp[0] / 2, cy = ny * sp[1] / 2, cz = nz * sp[2] / 2;
  for (let i = 0; i < n; i++) {
    const x = idx[i * 4], y = idx[i * 4 + 1], z = idx[i * 4 + 2], id = idx[i * 4 + 3];
    // volume -> preview axes: x lateral, ANTERIOR up (y=Posterior, so negate), z long axis
    m.makeTranslation((x + 0.5) * sp[0] - cx, cy - (y + 0.5) * sp[1], (z + 0.5) * sp[2] - cz);
    edMesh.setMatrixAt(i, m);
    edMesh.setColorAt(i, col.set(MAT_BY_ID[id]?.color || '#ff00ff'));
  }
  edMesh.instanceMatrix.needsUpdate = true;
  if (edMesh.instanceColor) edMesh.instanceColor.needsUpdate = true;
  edGroup.add(edMesh);
  // mm -> world units (1 unit = 10 mm), rest the model just above the floor of the view
  edGroup.scale.setScalar(0.1);
  edGroup.position.set(0, (ny * sp[1] / 2) * 0.1, 0);
  const lab = ctx.$('edVoxLab'); if (lab) lab.textContent = n.toLocaleString() + ' surface voxels';
}

/* ---- mode enter / leave (called from applyMode via app.js) ---- */
export function editorApplyMode(on) {
  if (!ctx) return;                   // applyMode can fire before initEditor during boot
  const { S, $ } = ctx;
  $('edPage')?.classList.toggle('show', on);
  if (edGroup) edGroup.visible = on;
  if (on) {
    if (!S.editor.model) newModel(96, 96, 96, 2, 'custom model');
    else adoptModel(S.editor.model);
    renderSaved();
    ctx.setOrbitRad(60);
  }
}
/* hide the x-ray/CT rigs while the editor is up (called from syncScene tail) */
export function editorSyncScene() {
  if (!ctx) return;
  const { S, three } = ctx;
  const on = S.mode === 'editor';
  if (edGroup) edGroup.visible = on;
  if (!on) { if (three.cam.view) three.cam.clearViewOffset(); return; }
  for (const k of ['det', 'detMarks', 'detArrow', 'tube', 'handGroup', 'aecGroup']) { if (three[k]) three[k].visible = false; }
  three.lamp.intensity = 0; three.lamp.castShadow = false; three.cr.visible = false;
  three.amb.intensity = 1.2; three.key.intensity = 1.0;
  // the slice panel covers the left 56% of the bay — shift the projection window left so
  // the orbit target (the model) lands in the centre of the VISIBLE strip on the right
  const cv = three.renderer.domElement, w = cv.clientWidth || 1, h = cv.clientHeight || 1;
  three.cam.setViewOffset(w, h, -0.28 * w, 0, w, h);
}

/* ---- save to session / download / upload ---- */
function saveToSession() {
  const { S, $ } = ctx;
  const name = ($('edName').value || 'custom model').trim();
  ED.name = name;
  S.editor.saved.push({ name, nx: ED.nx, ny: ED.ny, nz: ED.nz, sp: ED.sp.slice(), data: ED.data.slice(), when: new Date().toLocaleTimeString() });
  renderSaved();
}
function renderSaved() {
  const { S, $ } = ctx; const box = $('edSaved'); if (!box) return;
  box.innerHTML = S.editor.saved.length
    ? S.editor.saved.map((m, i) =>
      '<div class="edsave-row"><span class="nm">' + m.name + '</span><span class="dm">' + m.nx + '×' + m.ny + '×' + m.nz + '</span>'
      + '<button data-load="' + i + '" title="Load into the editor">⬇</button>'
      + '<button data-del="' + i + '" title="Remove">✕</button></div>').join('')
    : '<div class="note">No models stored this session yet.</div>';
  box.onclick = e => {
    const l = e.target.closest('button[data-load]'), d = e.target.closest('button[data-del]');
    if (l) { const m = S.editor.saved[+l.dataset.load]; adoptModel({ nx: m.nx, ny: m.ny, nz: m.nz, sp: m.sp.slice(), data: m.data.slice(), name: m.name }); }
    if (d) { S.editor.saved.splice(+d.dataset.del, 1); renderSaved(); }
  };
}
const b64enc = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const b64dec = b => { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
async function downloadModel() {
  const name = (ctx.$('edName').value || 'custom model').trim();
  let enc = 'raw', payload = ED.data;
  if (typeof CompressionStream !== 'undefined') {
    payload = new Uint8Array(await new Response(new Blob([ED.data]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    enc = 'gzip';
  }
  const doc = { magic: 'radsim-model', version: 1, name, dims: [ED.nx, ED.ny, ED.nz], spacing: ED.sp,
    order: 'x-fastest: i = x + nx*(y + ny*z)', encoding: enc, materials: ED_MATERIALS, data: b64enc(payload) };
  const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/[^\w-]+/g, '_') + '.rsmodel.json';
  a.click(); URL.revokeObjectURL(a.href);
}
async function uploadModel(file) {
  const hint = ctx.$('edHint');
  try {
    const doc = JSON.parse(await file.text());
    if (doc.magic !== 'radsim-model') throw new Error('not a RadSim model file');
    let data = b64dec(doc.data);
    if (doc.encoding === 'gzip')
      data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    const [nx, ny, nz] = doc.dims;
    if (data.length !== nx * ny * nz) throw new Error('volume size mismatch');
    adoptModel({ nx, ny, nz, sp: doc.spacing, data, name: doc.name || file.name });
    if (hint) hint.textContent = 'Loaded ' + (doc.name || file.name);
  } catch (err) { if (hint) hint.textContent = 'Load failed: ' + err.message; }
}
