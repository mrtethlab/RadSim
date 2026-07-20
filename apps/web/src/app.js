// RADSIM application glue: 3D positioning scene, simulation orchestration,
// film rendering and UI wiring. The reusable physics engine lives in ./core,
// the hand phantom in ./phantom/hand.js (both stay CT/model-ready).
import * as THREE from 'three';
import { Spectrum } from './core/spectrum.js';
import { Phantom } from './core/phantom.js';
import { AttenuationEngine } from './core/engine.js';
import { Detector } from './core/detector.js';
import { buildHandPrimitives, REST_LIFT } from './phantom/hand.js';
import { Sound } from './audio/sound.js';
import { loadModelFile, loadModelUrl } from './model/loader.js';
import { loadVoxelModel } from './model/voxelLoader.js';
import { muOverBins } from './core/voxelPhantom.js';
import { BodyMaterials } from './core/materials.js';
import { ComputeClient } from './compute/client.js';
import { initCT, ctSyncScene, ctRenderViewer, ctRenderRecons } from './ct.js';

/* ============================================================================
   MODULE 6 — SCENE3D  (Three.js POSITIONING view only; not the image)
   ============================================================================ */
let three = {};
function initScene(){
  const canvas=document.getElementById('view');
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  const scene=new THREE.Scene();
  scene.background=new THREE.Color(0x0a0c0f);
  scene.fog=new THREE.Fog(0x0a0c0f, 600, 2600);   // very light haze — the CT rig is large + far
  const cam=new THREE.PerspectiveCamera(42,1,1,3200);
  const amb=new THREE.AmbientLight(0x6b7785,0.9); scene.add(amb);
  const key=new THREE.DirectionalLight(0xbfe9ff,0.9); key.position.set(40,90,60); scene.add(key);
  const rim=new THREE.DirectionalLight(0x35c6d6,0.35); rim.position.set(-50,20,-40); scene.add(rim);

  // detector (bucky) at y=0 — receives the collimator light + hand shadow.
  // Matte, non-reflective top (no sheen, no grid) so the projected light field
  // and hand shadow read cleanly; the exposure area is marked by corner brackets.
  const det=new THREE.Mesh(new THREE.BoxGeometry(24,1.2,30),
    new THREE.MeshStandardMaterial({color:0x11161b,metalness:0,roughness:1}));
  det.position.y=-0.6; det.receiveShadow=true; scene.add(det);
  // white L-shaped corner markers outlining the 24x30 receptor area (x-ray only)
  const detMarks=new THREE.Group(); scene.add(detMarks);
  (function cornerMarkers(){
    const markMat=new THREE.MeshBasicMaterial({color:0xffffff});
    const hx=12, hz=15, arm=3.2, th=0.35, yy=0.07;
    function bracket(x,z,dx,dz){
      const a=new THREE.Mesh(new THREE.BoxGeometry(arm,0.08,th),markMat);
      a.position.set(x+dx*arm/2, yy, z);
      const b=new THREE.Mesh(new THREE.BoxGeometry(th,0.08,arm),markMat);
      b.position.set(x, yy, z+dz*arm/2);
      detMarks.add(a,b);
    }
    bracket( hx, hz,-1,-1); bracket(-hx, hz, 1,-1);
    bracket( hx,-hz,-1, 1); bracket(-hx,-hz, 1, 1);
  })();
  // hang-direction arrow: a small white arrow printed on the plate pointing +z
  // (toward the fingertips) — the end the processed image is hung from.
  const detArrow=new THREE.Group();
  (function hangArrow(){
    const m=new THREE.MeshBasicMaterial({color:0xffffff});
    const shaft=new THREE.Mesh(new THREE.BoxGeometry(0.34,0.06,1.7),m);
    shaft.position.set(0,0.07,-0.85); detArrow.add(shaft);
    const head=new THREE.Mesh(new THREE.ConeGeometry(0.55,1.1,12),m);
    head.rotation.x=Math.PI/2; head.position.set(0,0.07,0.55); detArrow.add(head);
  })();
  scene.add(detArrow);

  // ---- COLLIMATOR LAMP -------------------------------------------------
  // A shadow-casting spotlight at the focal spot projects a "cookie" texture
  // (the rectangular aperture + crosshair wires) onto the hand AND the detector,
  // and casts the hand's shadow onto the detector — a real collimator light.
  const COOKIE_SZ=512;
  const cookieCanvas=document.createElement('canvas'); cookieCanvas.width=cookieCanvas.height=COOKIE_SZ;
  const cookieTex=new THREE.CanvasTexture(cookieCanvas);
  cookieTex.minFilter=THREE.LinearFilter; cookieTex.magFilter=THREE.LinearFilter;
  const lampAngle=0.42;                                  // cone half-angle (rad)
  const lamp=new THREE.SpotLight(0xfff1cf, 0, 420, lampAngle, 0.16, 0.0);
  lamp.map=cookieTex;
  lamp.castShadow=true;
  lamp.shadow.mapSize.set(1024,1024);
  lamp.shadow.camera.near=8; lamp.shadow.camera.far=280;
  lamp.shadow.camera.up.set(0,0,-1);                    // deterministic cookie orientation
  lamp.shadow.bias=-0.0006;
  scene.add(lamp); scene.add(lamp.target);

  // retired flat overlays (kept as hidden refs for compatibility)
  const lf={visible:false}, lfFill={visible:false,geometry:{dispose(){}}},
        lfCross={visible:false,geometry:{dispose(){}}};

  // tube head
  const tube=new THREE.Group();
  const housing=new THREE.Mesh(new THREE.CylinderGeometry(4.5,4.5,7,24),
     new THREE.MeshStandardMaterial({color:0x2a343d,metalness:.6,roughness:.35}));
  housing.rotation.x=Math.PI/2; tube.add(housing);
  const cone=new THREE.Mesh(new THREE.CylinderGeometry(1.6,3.2,6,20,1,true),
     new THREE.MeshStandardMaterial({color:0x161c22,metalness:.5,roughness:.4,side:THREE.DoubleSide}));
  cone.position.y=-5.5; tube.add(cone);
  scene.add(tube);

  // central ray
  const crGeo=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]);
  const cr=new THREE.Line(crGeo,new THREE.LineBasicMaterial({color:0x35c6d6,transparent:true,opacity:.4}));
  scene.add(cr);

  const beam=new THREE.Group(); scene.add(beam);         // retired (unused)
  const handGroup=new THREE.Group(); scene.add(handGroup);

  three={renderer,scene,cam,tube,cr,lf,lfFill,lfCross,beam,handGroup,det,detMarks,detArrow,
         amb,key,lamp,cookieCanvas,cookieTex,lampAngle};
  buildHandMeshes();

  // camera: free orbit OR tube's-eye bird's view
  let az=0.9, el=0.85, rad=115, tx=0,ty=6,tz=0;
  three.setOrbitRad=(r)=>{ rad=r; };            // used to frame the large CT rig vs the small hand
  const ctFixedPov = () => S.mode==='ct' && (S.ct.pov==='ap' || S.ct.pov==='lat');
  function updateCamera(){
    if(ctFixedPov()){
      // Two fixed CT PoVs — both perpendicular into the bore, inside the inner rim
      // so the ring never overhangs the patient, same distance from the isocentre
      // (10.5) and same (very wide) FOV. Lat is the AP view rotated 90° about the
      // bore axis (z). They never track the patient: only the couch + table move.
      // CT bore is centred at (0, ISO_Y=6) with hole radius BORE_R=35 (see ct.js). Sit
      // just inside the inner rim so the ring frames the patient without overhanging.
      if(cam.fov!==110){ cam.fov=110; cam.updateProjectionMatrix(); }  // wide (some distortion) for the full bore
      cam.up.set(0,0,1);                        // +z (un-scanned anatomy) toward top of frame
      if(S.ct.pov==='lat') cam.position.set(33, 6, 0);    // +x rim, looking toward -x (lateral)
      else                 cam.position.set(0, 39, 0);    // top rim, looking straight down (AP)
      cam.lookAt(0, 6, 0);
      return;
    }
    if(cam.fov!==42){ cam.fov=42; cam.updateProjectionMatrix(); }
    if(S.mode!=='ct' && S.viewMode==='tube'){
      // look from the tube along the central ray, framed to the hand (bird's eye)
      const s=sourcePos(), t=[S.tubeX,0,S.tubeZ];
      let dx=s[0]-t[0], dy=s[1]-t[1], dz=s[2]-t[2];
      const L=Math.hypot(dx,dy,dz)||1, D=46;   // framing distance from detector
      cam.up.set(0,0,1);                        // fingertips (+z) toward top of view
      cam.position.set(t[0]+dx/L*D, t[1]+dy/L*D, t[2]+dz/L*D);
      cam.lookAt(t[0],t[1],t[2]);
    } else {
      cam.up.set(0,1,0);
      const cx=Math.cos(el)*Math.cos(az), cy=Math.sin(el), cz=Math.cos(el)*Math.sin(az);
      cam.position.set(tx+cx*rad, ty+cy*rad, tz+cz*rad);
      cam.lookAt(tx,ty,tz);
    }
  }
  let drag=false,lx=0,ly=0;
  // orbit is draggable when active: x-ray orbit, or CT with the Orbit perspective
  const orbitActive = () => S.mode==='ct' ? S.ct.pov==='orbit' : S.viewMode==='orbit';
  canvas.addEventListener('pointerdown',e=>{ if(S.bayContent!=='3d')return;
    if(S.mode==='ct'){ if(S.ct.pov!=='orbit') return; }   // CT: only the Orbit view drags (AP/Lat are fixed)
    else if(S.viewMode!=='orbit') setCameraView('orbit');
    drag=true;lx=e.clientX;ly=e.clientY;canvas.setPointerCapture(e.pointerId)});
  canvas.addEventListener('pointermove',e=>{ if(!drag)return;
    az+=(e.clientX-lx)*0.008; el+=(e.clientY-ly)*0.006;
    el=Math.max(0.12,Math.min(1.45,el)); lx=e.clientX;ly=e.clientY;});
  canvas.addEventListener('pointerup',()=>drag=false);
  canvas.addEventListener('wheel',e=>{ if(!orbitActive())return;
    e.preventDefault();rad=Math.max(40,Math.min(700,rad+e.deltaY*0.25));},{passive:false});

  let prevW=0, prevH=0;
  function resize(){
    const w=canvas.clientWidth, h=canvas.clientHeight;
    if(w && h && (w!==prevW || h!==prevH)){
      prevW=w; prevH=h;
      renderer.setSize(w,h,false); cam.aspect=w/h; cam.updateProjectionMatrix();
    }
  }
  // mirror the #view drawing buffer into the small DR monitor (#film). Must run in
  // the same tick as render() to read the WebGL buffer.
  const blitToFilm=()=>{
    const film=document.getElementById('film'); if(!film) return;
    if(film.width!==canvas.width || film.height!==canvas.height){ film.width=canvas.width; film.height=canvas.height; }
    film.getContext('2d').drawImage(canvas,0,0);
  };
  const povCam=new THREE.PerspectiveCamera(132,1,1,1000);   // dedicated CT PoV camera for the monitor
  (function loop(){
    resize(); updateCamera(); renderer.render(scene,cam);
    if(S.mode==='ct' && S.ct.liveView){
      blitToFilm();                    // scout build: mirror whatever CT PoV is active
    } else if(S.mode==='ct' && S.ct.moveBlit){
      // table move: mirror the axis' PoV into the monitor, independent of the bay
      // camera (so the bay can be watched in orbit at the same time).
      povCam.aspect=cam.aspect; povCam.fov=110; povCam.up.set(0,0,1);
      if(S.ct.moveBlit==='lat') povCam.position.set(33,6,0); else povCam.position.set(0,39,0);
      povCam.lookAt(0,6,0); povCam.updateProjectionMatrix();
      renderer.render(scene,povCam); blitToFilm();
      renderer.render(scene,cam);      // restore the bay view for display
    }
    requestAnimationFrame(loop);
  })();
}

/* ---- DETAILED HAND ANATOMY (single source of truth) ----------------------
   Local frame: -x = radial (thumb) side, +x = ulnar (little) side,
                +z = distal (fingertips), -z = proximal (wrist), y = dorsal.
   buildHandPrimitives(spread) returns {skin:[{a,b,r}], bone:[{a,b,r1,r2}]} in
   LOCAL coords. SKIN capsules form the soft-tissue envelope shown opaque in 3D
   and used as the 'soft' attenuator. BONE is a list of tapered capsules (rounded
   cones): each carries end radii r1,r2 so shafts stay thin and epiphyses flare,
   giving true skeletal form. Bones are physics-only (revealed on exposure).
   Every long bone = narrow diaphysis with flared metaphyseal ends, with small
   gaps left at the joints so articular spaces read as radiolucent lines.
   Full complement: distal radius+ulna, 8 carpals, 5 metacarpals, 14 phalanges. */
let handMeshes=[];
function buildHandMeshes(){
  handMeshes.forEach(m=>three.handGroup.remove(m)); handMeshes=[];
  const skinMat=new THREE.MeshStandardMaterial({color:0xe6b291, roughness:.9, metalness:0,
     emissive:0x2a1712, emissiveIntensity:.12});
  const boneMat=new THREE.MeshStandardMaterial({color:0xeae3cf, roughness:.7, metalness:0,
     emissive:0x161310, emissiveIntensity:.08});
  // rounded-cone mesh: frustum (radii r1@a -> r2@b) + spherical end caps
  function coneMesh(a,b,r1,r2,mat){
    const A=new THREE.Vector3(...a),B=new THREE.Vector3(...b);
    const len=Math.max(A.distanceTo(B),1e-4), e=1e-3;
    const grp=new THREE.Group();
    const cyl=new THREE.Mesh(new THREE.CylinderGeometry(Math.max(r2,e),Math.max(r1,e),len,16),mat);
    cyl.position.copy(A).add(B).multiplyScalar(0.5);
    cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),B.clone().sub(A).normalize());
    cyl.castShadow=true; cyl.receiveShadow=true; grp.add(cyl);
    for(const [p,r] of [[A,r1],[B,r2]]){ const s=new THREE.Mesh(new THREE.SphereGeometry(Math.max(r,e),16,12),mat);
      s.position.copy(p); s.castShadow=true; s.receiveShadow=true; grp.add(s); }
    return grp;
  }
  const softGrp=new THREE.Group(), boneGrp=new THREE.Group();
  const {skin,bone}=buildHandPrimitives(S.spread, S.pose);
  for(const c of skin){ const r1=c.r1!==undefined?c.r1:c.r, r2=c.r1!==undefined?c.r2:c.r;
    softGrp.add(coneMesh(c.a,c.b,r1,r2,skinMat)); }
  for(const c of bone){ if(c.mat==='marrow') continue;    // canal is internal — not shown in 3D
    boneGrp.add(coneMesh(c.a,c.b,c.r1,c.r2,boneMat)); }
  three.handGroup.add(softGrp); three.handGroup.add(boneGrp);
  three.softGrp=softGrp; three.boneGrp=boneGrp; handMeshes=[softGrp,boneGrp];
  applyHandView();
}
/* Toggle which model is visible (display only). */
function applyHandView(){
  if(!three.softGrp||!three.boneGrp) return;
  if(S.subject!=='hand'){ three.softGrp.visible=false; three.boneGrp.visible=false; if(three.chestGroup) three.chestGroup.visible=true; return; }
  const boneOnly=(S.handView==='bone');
  three.softGrp.visible=!boneOnly; three.boneGrp.visible=boneOnly;
}
function setHandView(v){
  S.handView=v;
  const seg=$('renderSeg'); if(seg)[...seg.children].forEach(b=>b.classList.toggle('on',b.dataset.hv===v));
  applyHandView();
}

/* Voxel model registry: the analytic hand plus every folder in public/models/. The
   `id` is BOTH the folder name and the file basename (…/<id>/<id>.model.json) and the
   model name sent to the Python backend, so keep them in sync with the build output.
   scoutKv/scoutMa are the default CT scout technique; xrayKv the default x-ray kV
   (thin extremities need far less than a thick torso). */
const VOXEL_MODELS = {
  chest:           { title:'Chest',                 scoutKv:120, scoutMa:120, xrayKv:120 },
  headneck:        { title:'Head & neck',           scoutKv:120, scoutMa:150, xrayKv:110 },
  chestabdopelvis: { title:'Chest / abdo / pelvis', scoutKv:120, scoutMa:200, xrayKv:120 },
  upperextremity:  { title:'Upper extremity',       scoutKv:70,  scoutMa:50,  xrayKv:60  },
  lowerextremity:  { title:'Lower extremity',       scoutKv:85,  scoutMa:90,  xrayKv:75  },
  wholebody:       { title:'Whole body',            scoutKv:120, scoutMa:250, xrayKv:110 },
  hires_shoulder:  { title:'Shoulder · 0.25 mm',    scoutKv:110, scoutMa:120, xrayKv:70  },
};

/* Prepare a freshly loaded display mesh so it lights + shadows like the hand: the
   exported GLB carries PBR defaults (metalness 1), no shadow flags and NO normals
   (GLTFLoader falls back to flat shading, which breaks the spot-light cookie
   projection — the light field floods the whole mesh unmasked). */
function prepVoxelMesh(grp){
  grp.traverse(o=>{ if(o.isMesh){ o.castShadow=true; o.receiveShadow=true;
    if(!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    const ms=Array.isArray(o.material)?o.material:[o.material];
    for(const m of ms){ if(m){ m.metalness=0; m.roughness=0.95; m.flatShading=false; m.needsUpdate=true; } } } });
}

/* Switch the scan subject between the analytic hand and any voxel model. Models
   (material volume + display mesh) are fetched on first use and cached; the meshes
   all live in handGroup so the CT positioning offsets apply to them like the hand. */
async function setSubject(sub){
  const sel=$('subjectSel'); const hint=$('subjectHint');
  S.voxelCache=S.voxelCache||{}; three.voxelMeshes=three.voxelMeshes||{};
  const showActive=(id)=>{ for(const k in three.voxelMeshes) three.voxelMeshes[k].visible=(k===id);
                           three.chestGroup=three.voxelMeshes[id]||null; };
  if(sub==='hand'){
    S.subject='hand';
    S.ct.scoutFovMM=180; S.ct.scanLen=300; S.ct.scoutKv=80; S.ct.scoutMa=20;
    S.ct.patient.x=0; S.ct.patient.z=0; S.ct.isoZ=0; S.ct.isocentred=false;
    applyBackendOnly(false);
    showActive(null); applyHandView();
    if(hint) hint.textContent='Analytic hand phantom';
    if(sel) sel.value='hand';
    const sl=$('ctScanLen'); if(sl) sl.value=S.ct.scanLen;
    syncScene(); return;
  }
  const cfg=VOXEL_MODELS[sub];
  if(!cfg){ console.warn('unknown subject',sub); return; }
  let vm=S.voxelCache[sub];
  if(!vm){
    if(hint) hint.textContent='Loading '+cfg.title+'…';
    S.subjectLoading=true;   // guards CT START/exposure until the swap completes
    try{
      vm=await loadVoxelModel('/models/'+sub, sub);
      S.voxelCache[sub]=vm;
      if(vm.meshUrl){
        const grp=await loadModelUrl(vm.meshUrl);
        prepVoxelMesh(grp);
        grp.visible=false; three.handGroup.add(grp); three.voxelMeshes[sub]=grp;
      }
    }catch(err){ console.error(sub+' load failed',err); if(hint) hint.textContent='Load failed: '+err.message;
      if(sel) sel.value=S.subject; return; }
    finally{ S.subjectLoading=false; }
  }
  S.voxelModel=vm; S.subject=sub;
  const ext=vm.extentMM;
  // scan field of view scales to the model (mediolateral × AP extent) so it fits
  S.ct.scoutFovMM=Math.round(Math.max(ext[0], ext[1])+70);
  // default the scan to cover the WHOLE anatomy, pre-isocentred at the superior end
  // (scan runs superior→inferior). Tall models (whole body) need a longer scout.
  S.ct.scanLen=Math.round(ext[2]);
  const sl=$('ctScanLen'); if(sl){ sl.max=Math.max(600, S.ct.scanLen); sl.value=S.ct.scanLen; }
  S.ct.patient.x=0; S.ct.patient.z=0; S.ct.isoZ=(ext[2]/2)/10;
  S.ct.isocentred=true; S.ct.tablePos=0; S.ct.tableY=0;
  S.ct.scoutKv=cfg.scoutKv; S.ct.scoutMa=cfg.scoutMa;
  // default x-ray kV to the model (thin extremities need far less than a torso)
  if(cfg.xrayKv){ S.kv=cfg.xrayKv; const kvEl=$('kv'); if(kvEl) kvEl.value=S.kv; refreshReadouts(); }
  // backend-only models (large, no volume in the browser) MUST use the Python engine
  applyBackendOnly(!!vm.backendOnly);
  showActive(sub);
  if(three.softGrp) three.softGrp.visible=false;
  if(three.boneGrp) three.boneGrp.visible=false;
  if(hint) hint.textContent=vm.header.name+' · '+vm.dims.join('×')+' @ '+vm.spacingMM[0]+'mm';
  if(sel) sel.value=sub;
  syncScene();
}
/* Position + orient the chest display mesh so it matches the VoxelPhantom (same axis
   flips) and is scaled from mm to world units. The mesh is a child of handGroup, so
   handGroup's translation (CT patient offset) then places it at the isocentre. */
function applyVoxelMeshTransform(grp){
  const f=voxelFlips(), s=0.1;   // mm -> world (1 unit = 10 mm)
  grp.scale.set(s*(f[0]?-1:1), s*(f[1]?-1:1), s*(f[2]?-1:1));
  grp.position.set(0,0,0); grp.rotation.set(0,0,0);
}

/* X-ray detector receptor size + orientation. The 3D receptor (modelled 24x30) scales
   to the effective W×H; computeRadiograph reads S.detW/detH + the native matrix. */
function applyDet(){
  const port=S.detOrient==='portrait';
  S.detW = port?S.detBaseW:S.detBaseH;
  S.detH = port?S.detBaseH:S.detBaseW;
  let [nx,ny]=RES_MAP[S.resolution]||RES_MAP.std;
  if(!port){ const t=nx; nx=ny; ny=t; }
  S.detNx=nx; S.detNy=ny;
  const dv=$('detSizeV'); if(dv) dv.textContent=S.detW+'×'+S.detH+' cm';
  const rv=$('resV'); if(rv) rv.textContent=nx+'×'+ny;
  const os=$('detOrientSeg'); if(os)[...os.children].forEach(b=>b.classList.toggle('on',b.dataset.orient===S.detOrient));
  // the light field can open to the full detector: cap the collimation sliders at the receptor size
  const cx=$('collX'), cz=$('collZ');
  if(cx){ cx.max=S.detW; if(S.collX>S.detW){ S.collX=S.detW; cx.value=S.detW; } }
  if(cz){ cz.max=S.detH; if(S.collZ>S.detH){ S.collZ=S.detH; cz.value=S.detH; } }
  updateGeomReadouts?.();
  updateDetector();
}
function updateDetector(){
  if(!three.det) return;
  const sx=S.detW/24, sz=S.detH/30;
  three.det.scale.set(sx,1,sz);
  if(three.detMarks) three.detMarks.scale.set(sx,1,sz);
  // hang arrow rides the +z edge of the receptor (unscaled, so it stays an arrow)
  if(three.detArrow) three.detArrow.position.set(-9*sx, 0, 12.6*sz);
}
function setDetSize(w,h){
  S.detBaseW=Math.min(w,h); S.detBaseH=Math.max(w,h);
  const seg=$('detSizeSeg'); if(seg)[...seg.children].forEach(b=>b.classList.toggle('on', +b.dataset.w===w));
  applyDet();
}
function setDetOrient(o){ S.detOrient=o; applyDet(); }

/* ============================================================================
   STATE + WIRING
   ============================================================================ */
const S = {
  pose:'PA', spread:0.45, sid:100, oid:0, tubeZ:0, tubeX:0, angLM:0, angCC:0,
  collX:15, collZ:19, kv:55, mas:2.0, ma:100, prepped:false, exposing:false, hasImage:false,
  lastSignal:null, nx:0, ny:0, mask:null, win:100, lev:0, eiTarget:250, showHist:true,
  viewMode:'orbit', bayContent:'3d', lfOn:true, imgRot:0, flipH:false, flipV:false,
  resolution:'std', gridOn:false, gridRatio:10, gridFocus:100, handView:'soft',
  detBaseW:35, detBaseH:43,    // receptor size (cm, short × long): 25x30 small / 35x43 large
  detOrient:'portrait',        // portrait (long axis vertical) / landscape
  detW:35, detH:43,            // effective receptor W×H (derived from size + orientation)
  detNx:2500, detNy:3070,      // detector native pixel matrix (true ray-cast resolution)
  // ---- subject / phantom: the analytic hand, or a voxel model (e.g. the chest) ----
  subject:'hand',              // 'hand' | 'chest'
  voxelModel:null,             // loaded voxel model (dims/spacing/data/legend/makePhantom)
  // ---- compute engine: in-browser JS, or the Python GPU backend (voxel subjects) ----
  xrayBackend:'local',         // 'local' | 'python' — x-ray projection engine
  computeInfo:null,            // /health result when the Python backend is reachable
  // ---- CT mode ----
  mode:'xray',                 // 'xray' | 'ct'
  ct:{
    sliceThk:5,                // mm (station selector over discrete values)
    imgPerRotation:1,          // images reconstructed per gantry rotation
    pitch:1.0,                 // table travel per rotation / total collimation
    rotSpeed:0.5,              // seconds per gantry rotation
    scanLen:300,               // mm scout/scan length (from isocentre)
    scoutFovMM:180,            // scout/scan field of view (mm) — adapts to the subject (hand 180 / chest ~460)
    scoutKv:80,                // scout topogram technique (kV)
    scoutMa:20,                // scout topogram technique (mA)
    tablePos:0,                // mm; signed: +I (inferior) / -S (superior); isocentre zeroes it
    isoZ:0,                    // patient z recorded when the isocentre was set
    isocentred:false,
    phase:'idle',              // idle | scout | planning | moving | scanning | done
    patient:{x:0, z:0},        // patient/couch offset from the gantry isocentre
    tableY:0,                  // table height (mm); 0 = patient centred at the isocentre
    patientY:6,                // patient world-y for the current table height (set by ct.js)
    pov:'ap',                  // CT camera perspective: 'ap' (top) | 'lat' (90° around the bore)
    liveView:false,            // true while a scout build mirrors tube-POV into #film
    scoutsReady:false,         // true once scouts exist -> shown in the bay Image view
    // ---- Phase 4: scan groups (up to 4 planned scans). Each has its own box
    // (normalized scout coords; per-group top/bot AP↔LAT cylinder lock) + params.
    // Canonical acquisition fields per group: detRows, beamColl (= rows × detector
    // element), pitch, sliceThk (reconstructed helical thickness). Table speed and the
    // detector element are derived (see ct.js). Defaults: 16 × 0.625 = 10 mm collimation.
    groups:[
      { on:true,  vis:true, box:{ top:0.10, bot:0.90, apL:0.28, apR:0.72, latL:0.28, latR:0.72 }, kv:120, ma:295, sliceThk:5,    detRows:16, beamColl:10, pitch:0.938, rotSpeed:0.5, interval:5,    tilt:0, delay:0 },
      { on:false, vis:true, box:{ top:0.14, bot:0.50, apL:0.36, apR:0.64, latL:0.36, latR:0.64 }, kv:120, ma:295, sliceThk:2.5,  detRows:16, beamColl:10, pitch:0.938, rotSpeed:0.5, interval:2.5,  tilt:0, delay:0 },
      { on:false, vis:true, box:{ top:0.55, bot:0.86, apL:0.36, apR:0.64, latL:0.36, latR:0.64 }, kv:120, ma:295, sliceThk:1.25, detRows:16, beamColl:10, pitch:0.938, rotSpeed:0.5, interval:1.25, tilt:0, delay:0 },
      { on:false, vis:true, box:{ top:0.30, bot:0.70, apL:0.40, apR:0.60, latL:0.40, latR:0.60 }, kv:120, ma:295, sliceThk:5,    detRows:16, beamColl:10, pitch:0.938, rotSpeed:0.5, interval:5,    tilt:0, delay:0 },
    ],
    activeGroup:0,             // the group currently being edited (drives the reposition plan)
    plan:{ targetX:0, targetY:0, committedX:0, committedY:0 },   // required vs applied table move (mm)
    moveBlit:null,             // 'ap'|'lat'|null: mirror this PoV into the monitor during a table move
    // ---- Phase 5/6: scan execution, reconstruction + image storage ----
    storage:[],                // stored reconstructed scans (oldest first); each = {id,label,ts,params,gridN,fovMM,muWater,slices:[{d,mu}]}
    autoDelete:true,           // auto-delete oldest scans past the cap so memory doesn't grow without bound
    storeCap:4,                // keep at most this many scan groups' worth of data when autoDelete is on
    nextScanId:1,              // running id for stored scans
    viewer:{ scanId:null, slice:0, wl:60, ww:800 },   // cross-sectional (axial) viewer state (HU window/level)
    backend:'local',           // 'local' | 'python' — CT reconstruction engine
    detMode:'quick',           // 'quick' (128-ch preview) | 'realistic' (fixed 0.625mm DEL, 512² recon)
    // linked 2x2 MPR workstation: one cross-reference position drives all four panes
    mpr:{ scanId:null, cur:null, wl:60, ww:800, sel:'axial', thk:5, interval:5, algo:'standard', mar:false,
          // oblique plane: a localizer line anchored to one ortho view (view), rotated by
          // ang within that view, centred at (cu,cv) in that view's in-plane mm; the plane
          // extends along the axis perpendicular to that view → a true oblique. fov = DFOV.
          ob:{ view:'axial', ang:0, cu:0, cv:0, fov:60 } },
    busy:false,                // true during scan execution (controls greyed out)
  },
};
// detector base lift (cm) at OID 0: hand resting palm-down on the receptor, so
// the palmar soft tissue between bone and detector is only ~1-1.5 cm.
// detector pixel matrices per resolution tier (4:5, matches 24x30 cm receptor)
// modern digital-radiography detector matrices (portrait, long axis vertical). The
// projection is ray-cast at this true resolution (no downscaling); the heavy voxel-body
// case is offloaded to the Python compute backend when it is running.
// 'quick' is a fast draft preview at the sim's original coarse matrix (~1 mm
// pixels — not a real DR resolution) so a voxel-body exposure returns in well
// under a second; low/std/high are true modern DR matrices (~100 µm pixels).
const RES_MAP={ quick:[320,400], low:[2000,2450], std:[2500,3070], high:[3500,4300] };
const masSteps=[0.5,0.63,0.8,1.0,1.25,1.6,2.0,2.5,3.2,4.0,5.0,6.4,8.0,10,12.5,16,20,25,32,40,50,64,80,100,125];
const maSteps=[25,50,100,150,200,250,300,400,500,630,800];
function exposureTimeSec(){ return S.mas / S.ma; }              // t = mAs / mA
function fmtTime(t){ return t<1 ? Math.round(t*1000)+' ms' : t.toFixed(t<10?2:1)+' s'; }


const $=id=>document.getElementById(id);

/* pose -> external rotation of the hand about its long (z) axis.
   Negative rotation lifts the radial (thumb) side, i.e. external rotation. */
function poseRot(){ return S.pose==='PA'?0 : S.pose==='OBL'?-Math.PI/4 : -Math.PI/2; }

/* Base lift (cm, before OID) that rests the hand on the receptor for the current
   pose. PA keeps the flat resting height (palm/fingers down, forearm allowed to
   dip and get clipped). OBL/LAT rest the LOWEST rotated surface point on the
   detector, so nothing clips through as the hand rolls onto its edge. */
function baseLift(skin, bone, rot){
  if(rot===0) return REST_LIFT;
  const cosR=Math.cos(rot), sinR=Math.sin(rot);
  let minY=Infinity;
  const low=(p,r)=>{ const yr=p[0]*sinR + p[1]*cosR - r; if(yr<minY) minY=yr; };
  for(const c of skin){ const r1=c.r1!==undefined?c.r1:c.r, r2=c.r1!==undefined?c.r2:c.r; low(c.a,r1); low(c.b,r2); }
  for(const c of bone){ low(c.a,c.r1); low(c.b,c.r2); }
  return -minY + 0.05;   // +margin so the edge rests just above the receptor
}

/* Build the world-space physics phantom from current pose (bakes transform).
   Same skin+bone primitives shown in 3D, rotated by pose and lifted onto the
   detector so bone is nested inside soft tissue. */
// Anatomical axis flips for the voxel chest (volume axes: x=Left, y=Posterior,
// z=Superior). World: x lateral, y up, z couch/long. CT = supine head-first (anterior
// up, head toward −z into the bore). X-ray = PA upright feel (posterior up / anterior
// toward the detector), long axis left→right on the plate.
function voxelFlips(){
  return S.mode==='ct' ? [false,true,true] : [false,false,false];
}
function buildPhantom(){
  // Voxel subject (chest): return a VoxelPhantom placed like the hand — centred at the
  // CT patient offset (couch position / table height) so scout + recon sweep the real
  // anatomy. Uses the expanded BodyMaterials via its labelled volume.
  if(S.subject!=='hand' && S.voxelModel){
    const vm=S.voxelModel;
    const cx = S.mode==='ct' ? S.ct.patient.x : 0;
    const cy = S.mode==='ct' ? S.ct.patientY : (vm.extentMM[1]/2)/10;
    const cz = S.mode==='ct' ? S.ct.patient.z : 0;
    return vm.makePhantom([cx,cy,cz], voxelFlips());
  }
  const ph=new Phantom();
  const rot=poseRot();
  const cosR=Math.cos(rot), sinR=Math.sin(rot);
  const {skin,bone}=buildHandPrimitives(S.spread, S.pose);
  // x-ray: rest on the receptor (pose-aware) + OID. CT: sit at the table height
  // (patientY), so the 3D model and the traced phantom share one vertical position.
  const liftY = S.mode==='ct' ? S.ct.patientY : baseLift(skin,bone,rot)+S.oid;
  // in CT the patient is offset from the gantry isocentre by the direction pad
  const cx = S.mode==='ct' ? S.ct.patient.x : 0;
  const cz = S.mode==='ct' ? S.ct.patient.z : 0;
  function xf(p){                // rotate about long (z) axis, then lift, then CT offset
    const x=p[0], y=p[1], z=p[2];
    return [x*cosR - y*sinR + cx, x*sinR + y*cosR + liftY, z + cz];
  }
  for(const c of skin){
    if(c.r1!==undefined) ph.addCone(xf(c.a),xf(c.b),c.r1,c.r2,'soft');
    else ph.addCapsule(xf(c.a),xf(c.b),c.r,'soft');
  }
  for(const c of bone) ph.addCone(xf(c.a),xf(c.b),c.r1,c.r2,c.mat||'bone');
  return ph;
}

/* Update 3D transforms to match state (tube position, hand pose, collimator light). */
function syncScene(){
  if(!three.tube) return;
  // hand pose (lifted by OID above the receptor; pose-aware rest so it never clips).
  // The voxel chest is placed by ctSyncScene instead, so skip the hand transforms.
  if(S.subject==='hand'){
    three.handGroup.rotation.z = poseRot();
    const {skin,bone}=buildHandPrimitives(S.spread, S.pose);
    three.handGroup.position.y = baseLift(skin,bone,poseRot())+S.oid;
  } else {
    three.handGroup.rotation.z = 0;
    if(three.chestGroup) applyVoxelMeshTransform(three.chestGroup);   // flips are mode-dependent
    if(S.mode!=='ct' && S.voxelModel){                                // x-ray: rest the model on the detector
      three.handGroup.position.set(0, (S.voxelModel.extentMM[1]/2)/10, 0);
    }
  }

  // tube position + aim along the true central ray (isocentric: CR -> centering point)
  const src=sourcePos();
  const aim=[S.tubeX,0,S.tubeZ];
  three.tube.position.set(src[0],src[1],src[2]);
  three.tube.lookAt(new THREE.Vector3(...aim)); three.tube.rotateX(Math.PI/2);
  three.cr.geometry.setFromPoints([new THREE.Vector3(...src), new THREE.Vector3(...aim)]);
  three.cr.geometry.attributes.position.needsUpdate=true;

  // ---- collimator lamp: projects the aperture+crosshair and casts the hand shadow ----
  const on=S.lfOn;
  three.lamp.position.set(src[0],src[1],src[2]);
  three.lamp.target.position.set(aim[0],aim[1],aim[2]); three.lamp.target.updateMatrixWorld();
  updateCookie();
  three.lamp.intensity = on ? 7.2 : 0;
  three.lamp.castShadow = on;
  // dim the room when the light is on so the projected field reads clearly
  three.amb.intensity = on ? 0.5 : 0.9;
  three.key.intensity = on ? 0.5 : 0.9;
  three.cr.visible = !on;                       // crosshair now comes from the lamp
  three.lf.visible=false; three.lfFill.visible=false; three.lfCross.visible=false; three.beam.visible=false;
  updateDetector();                             // receptor size (25x30 / 35x43)
  ctSyncScene();                                // CT mode overrides scene visibility (bed/laser vs detector/light)
}

/* Redraw the collimator cookie: bright rectangular aperture sized to the field
   half-angles (so it keystones under CR angulation via the light's perspective),
   with dark crosshair wires across it. */
function updateCookie(){
  const t=three; if(!t.cookieCanvas) return;
  const SZ=t.cookieCanvas.width, g=t.cookieCanvas.getContext('2d');
  g.fillStyle='#000'; g.fillRect(0,0,SZ,SZ);
  const coneT=Math.tan(t.lampAngle);
  const hu=Math.min(0.47, 0.5*((S.collX/2)/S.sid)/coneT);   // half width (u) in uv
  const hv=Math.min(0.47, 0.5*((S.collZ/2)/S.sid)/coneT);   // half length (v) in uv
  const cx=SZ/2, cy=SZ/2, w=hu*SZ, h=hv*SZ;
  // aperture (lit)
  g.fillStyle='#fff'; g.fillRect(cx-w, cy-h, 2*w, 2*h);
  // crosshair wires (dark), spanning the aperture, with a small central gap
  g.strokeStyle='#000'; g.lineWidth=Math.max(2, SZ*0.006);
  const gap=Math.min(w,h)*0.12;
  g.beginPath();
  g.moveTo(cx, cy-h); g.lineTo(cx, cy-gap); g.moveTo(cx, cy+gap); g.lineTo(cx, cy+h);
  g.moveTo(cx-w, cy); g.lineTo(cx-gap, cy); g.moveTo(cx+gap, cy); g.lineTo(cx+w, cy);
  g.stroke();
  t.cookieTex.needsUpdate=true;
}

/* Tube geometry frame. The central ray is angulated by TWO independent tilts,
   applied together: angLM (lateral/medial, about the long axis) and angCC
   (cephalic/caudad, about the cross axis). Returns the focal-spot position plus
   an orthonormal frame {d = central-ray dir, wAxis = collimator width,
   lAxis = collimator length}. The source pivots on a sphere of radius SID about
   the isocentre so the source-to-isocentre distance stays = SID. */
function tubeFrame(){
  const cc=S.angCC*Math.PI/180, lm=S.angLM*Math.PI/180;
  const scc=Math.sin(cc), ccc=Math.cos(cc), slm=Math.sin(lm), clm=Math.cos(lm);
  // unit vector from isocentre up toward the source
  const ux=-ccc*slm, uy=ccc*clm, uz=scc;
  const iso=[S.tubeX,0,S.tubeZ];
  const source=[iso[0]+S.sid*ux, S.sid*uy, iso[2]+S.sid*uz];
  const d=[-ux,-uy,-uz];                       // central-ray direction (toward detector)
  const wAxis=[clm, slm, 0];                    // collimator width axis
  const lAxis=[scc*slm, -scc*clm, ccc];         // collimator length axis
  return {source, iso, d, wAxis, lAxis};
}
function sourcePos(){ return tubeFrame().source; }

/* Light field / beam footprint on the detector: intersect the 4 collimator
   edge rays with the detector plane -> a trapezoid (keystone) when angulated. */
function beamFootprint(){
  const {source,d,wAxis,lAxis}=tubeFrame();
  const tw=(S.collX/2)/S.sid, tl=(S.collZ/2)/S.sid;   // half-field tangents at SID
  const hit=(dir)=>{ if(dir[1]>-1e-4) return null;      // ray must travel downward
    const t=-source[1]/dir[1]; return [source[0]+t*dir[0], 0, source[2]+t*dir[2]]; };
  const corners=[];
  for(const [sx,sz] of [[-1,-1],[1,-1],[1,1],[-1,1]]){
    corners.push(hit([ d[0]+sx*tw*wAxis[0]+sz*tl*lAxis[0],
                       d[1]+sx*tw*wAxis[1]+sz*tl*lAxis[1],
                       d[2]+sx*tw*wAxis[2]+sz*tl*lAxis[2] ]));
  }
  const centre=hit(d);
  return {source, corners, centre};
}

function fmtAng(v,axis){
  if(v===0) return '0°';
  const w = axis==='LM' ? (v<0?'LAT':'MED') : (v<0?'CEPH':'CAUD');
  return Math.abs(v)+'° '+w;
}
function angText(){
  const parts=[];
  if(S.angCC!==0) parts.push(Math.abs(S.angCC)+'° '+(S.angCC<0?'CEPHALIC':'CAUDAD'));
  if(S.angLM!==0) parts.push(Math.abs(S.angLM)+'° '+(S.angLM<0?'LATERAL':'MEDIAL'));
  return parts.length ? parts.join(' · ') : 'PERPENDICULAR';
}
function updateGeomReadouts(){
  $('collXv').textContent=S.collX+' cm';
  $('collZv').textContent=S.collZ+' cm';
  $('angLMv').textContent=fmtAng(S.angLM,'LM');
  $('angCCv').textContent=fmtAng(S.angCC,'CC');
  $('angReadout').textContent=angText();
}

/* Camera view + bay content switching */
function setCameraView(m){
  S.viewMode=m;
  const seg=$('camSeg'); if(seg)[...seg.children].forEach(b=>b.classList.toggle('on',b.dataset.cam===m));
}
/* CT camera perspective: 'ap' (top) | 'lat' (90° around the bore). */
function setCTPov(p){
  S.ct.pov=p;
  const seg=$('camSegCt'); if(seg)[...seg.children].forEach(b=>b.classList.toggle('on',b.dataset.cam===p));
}
/* Show the right thing in the small DR monitor for the current mode. X-ray shows
   its radiograph; CT has no radiograph (its scouts live in the bay, and the
   reconstruction viewer comes later), so the monitor is cleared — the two modes'
   images stay isolated, never bleeding a stale x-ray into CT. */
function refreshFilmViewer(){
  const f=$('film'), noexp=$('noexp');
  if(S.mode!=='ct' && S.hasImage){
    drawFilm();
    if(noexp) noexp.style.display='none';
  } else {
    if(f) f.getContext('2d').clearRect(0,0,f.width,f.height);
    if(noexp) noexp.style.display='';
  }
}
/* CT scout build: mirror the tube's-eye 3D into the small DR monitor. Forces the
   tube camera while active (saving the user's choice) and hides the NO IMAGE note;
   restores the camera + monitor on the way out. The per-frame blit lives in the
   render loop, gated by S.ct.liveView. */
function ctLiveView(on){
  const noexp=$('noexp');
  if(on){ if(noexp) noexp.style.display='none'; S.ct.liveView=true; }
  else { S.ct.liveView=false; refreshFilmViewer(); }   // CT -> cleared; x-ray -> its radiograph
}
function setContent(c){
  S.bayContent=c;
  const seg=$('contentSeg'); if(seg)[...seg.children].forEach(b=>b.classList.toggle('on',b.dataset.c===c));
  const img=(c==='image');
  const slices=(c==='slices');   // CT cross-sectional viewer (reconstructed transverse slices)
  const recons=(c==='recons');   // CT reconstruction planning / multiplanar viewer
  if(c==='3d' && three.setOrbitRad) three.setOrbitRad(S.mode==='ct'?260:115);   // frame the large CT rig vs the hand
  // switching the bay to 3D in CT defaults to Orbit (whole-scene view), not a fixed PoV
  if(!img && !slices && !recons && S.mode==='ct') setCTPov('orbit');
  // In CT with scouts acquired, the Image (Scout) view IS the scout window (AP+LAT
  // topograms for scan planning); it replaces the radiograph/bignote.
  const scouts=(S.mode==='ct' && S.ct.scoutsReady && img);
  const sc=$('ctScouts'); if(sc) sc.classList.toggle('show', scouts);
  const slv=$('ctSlices'); if(slv) slv.classList.toggle('show', slices);
  const rcv=$('ctRecons'); if(rcv) rcv.classList.toggle('show', recons);
  $('bigFilm').style.display=(img && S.hasImage && !scouts)?'block':'none';
  $('bignote').style.display=(img && !S.hasImage && !scouts)?'flex':'none';
  $('view').style.visibility=(img||slices||recons)?'hidden':'visible';
  if(img && S.hasImage && !scouts) renderRadiograph($('bigFilm'));
  if(slices) ctRenderViewer();
  if(recons) ctRenderRecons();
}
/* Enable/disable the bay "3D" view button (greyed out while the scout window owns
   the bay for scan planning). */
function setBay3DEnabled(on){
  const b=document.querySelector('#contentSeg button[data-c="3d"]');
  if(b) b.disabled=!on;
}

/* ---- Controls wiring ---- */
function bind(){
  // pose
  $('poseSeg').addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b)return;
    [...$('poseSeg').children].forEach(x=>x.classList.remove('on')); b.classList.add('on');
    S.pose=b.dataset.pose; $('poseName').textContent=b.textContent.toUpperCase();
    buildHandMeshes();   // thumb geometry is pose-dependent (LAT lays it flat)
    resetPrep(); syncScene();
  });
  $('spread').addEventListener('input',e=>{ S.spread=e.target.value/100;
    buildHandMeshes(); resetPrep(); });
  // sliders that only affect geometry (update chips + scene)
  const geoSliders=['tubeZ','tubeX','angLM','angCC','collX','collZ'];
  for(const id of geoSliders){
    $(id).addEventListener('input',e=>{ S[id]=parseFloat(e.target.value);
      updateGeomReadouts(); syncScene();});
  }
  $('recenter').addEventListener('click',()=>{
    S.tubeX=0;S.tubeZ=0;S.angLM=0;S.angCC=0;
    $('tubeX').value=0;$('tubeZ').value=0;$('angLM').value=0;$('angCC').value=0;
    updateGeomReadouts(); syncScene();
  });
  // steppers
  document.querySelectorAll('[data-step]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const kind=btn.dataset.step, d=parseFloat(btn.dataset.d);
      if(kind==='sid'){ S.sid=Math.max(20,Math.min(180,S.sid+d)); $('sidV').textContent=S.sid+' cm';
        $('sidRo').innerHTML=S.sid+'<small>cm</small>'; syncScene(); }
      if(kind==='oid'){ S.oid=Math.max(0,Math.min(20,S.oid+d)); $('oidV').textContent=S.oid+' cm'; syncScene(); }
      if(kind==='kv'){ S.kv=Math.max(40,Math.min(120,S.kv+d)); $('kv').value=S.kv; }
      if(kind==='mas'){ let i=nearestMasIdx(); i=Math.max(0,Math.min(masSteps.length-1,i+d)); S.mas=masSteps[i]; $('mas').value=i; }
      if(kind==='ma'){ let i=nearestMaIdx(); i=Math.max(0,Math.min(maSteps.length-1,i+d)); S.ma=maSteps[i]; $('ma').value=i; }
      refreshReadouts();
    });
  });
  $('kv').addEventListener('input',e=>{S.kv=parseInt(e.target.value);refreshReadouts();});
  $('ma').addEventListener('input',e=>{S.ma=maSteps[e.target.value];refreshReadouts();});
  $('mas').addEventListener('input',e=>{S.mas=masSteps[e.target.value];refreshReadouts();});
  // APR presets
  $('apr').addEventListener('click',e=>{const b=e.target.closest('button'); if(!b)return;
    S.kv=parseInt(b.dataset.kv); S.mas=parseFloat(b.dataset.mas);
    $('kv').value=S.kv; $('mas').value=nearestMasIdx(); refreshReadouts();});
  // rotor: latches on until an exposure completes
  $('rotor').addEventListener('click',toggleRotor);
  // exposure switch: press AND HOLD for the exposure time
  const fire=$('fire');
  fire.addEventListener('pointerdown',e=>{ e.preventDefault(); if(fire.disabled)return;
    try{fire.setPointerCapture(e.pointerId);}catch(_){}; startExposure(); });
  fire.addEventListener('pointerup',()=>releaseExposure());
  fire.addEventListener('pointercancel',()=>releaseExposure());
  fire.addEventListener('lostpointercapture',()=>releaseExposure());
  // keyboard: space engages rotor, then hold space to expose
  let spaceDown=false;
  document.addEventListener('keydown',e=>{ if(e.code!=='Space')return; e.preventDefault();
    if(spaceDown)return; spaceDown=true;
    if(!S.prepped && !S.exposing) setRotor(true);
    else if(S.prepped && !S.exposing) startExposure(); });
  document.addEventListener('keyup',e=>{ if(e.code!=='Space')return; spaceDown=false;
    if(S.exposing) releaseExposure(); });
  // display
  $('level').addEventListener('input',e=>{S.lev=parseInt(e.target.value); if(S.hasImage) drawFilm();});
  $('windo').addEventListener('input',e=>{S.win=parseInt(e.target.value); if(S.hasImage) drawFilm();});
  // display histogram toggle (Simulation group) — controls both the x-ray + CT charts
  const histTgl=$('histToggle');
  if(histTgl){ histTgl.addEventListener('change',()=>{ S.showHist=histTgl.checked;
    document.body.classList.toggle('hist-off', !S.showHist);
    updateXrayHistogram(); ctRenderViewer?.(); }); }
  // bay options dropdown (top-right): toggle open, close on outside click / Esc
  const bayCtl=$('bayCtl'), bayBtn=$('bayMenuBtn');
  if(bayBtn){
    bayBtn.addEventListener('click',e=>{ e.stopPropagation();
      const open=bayCtl.classList.toggle('open'); bayBtn.setAttribute('aria-expanded', open?'true':'false'); });
    document.addEventListener('click',e=>{ if(bayCtl.classList.contains('open') && !bayCtl.contains(e.target)){
      bayCtl.classList.remove('open'); bayBtn.setAttribute('aria-expanded','false'); }});
    document.addEventListener('keydown',e=>{ if(e.key==='Escape' && bayCtl.classList.contains('open')){
      bayCtl.classList.remove('open'); bayBtn.setAttribute('aria-expanded','false'); }});
  }
  // bay content: 3D positioning  <->  large saved image
  $('contentSeg').addEventListener('click',e=>{const b=e.target.closest('button'); if(!b || b.disabled)return; setContent(b.dataset.c);});
  // camera: free orbit  <->  tube POV bird's-eye (x-ray)
  $('camSeg').addEventListener('click',e=>{const b=e.target.closest('button'); if(!b)return; setCameraView(b.dataset.cam);});
  // CT camera: AP-PoV  <->  Lat-PoV
  $('camSegCt')?.addEventListener('click',e=>{const b=e.target.closest('button'); if(!b)return; setCTPov(b.dataset.cam);});
  // render mode: soft-tissue anatomy  <->  skeleton (display only)
  $('renderSeg').addEventListener('click',e=>{const b=e.target.closest('button'); if(!b)return; setHandView(b.dataset.hv);});
  // subject: analytic hand  <->  any voxel model
  $('subjectSel')?.addEventListener('change',e=>setSubject(e.target.value));
  // collimator light on/off
  $('lfBtn').addEventListener('click',()=>{ S.lfOn=!S.lfOn;
    $('lfBtn').classList.toggle('on',S.lfOn); $('lfBtn').setAttribute('aria-pressed',S.lfOn);
    syncScene(); });
  // detector: resolution / anti-scatter grid settings (single-select seg groups)
  const segPick=(id,fn)=>$(id).addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b)return;
    [...$(id).children].forEach(x=>x.classList.remove('on')); b.classList.add('on'); fn(b);
  });
  segPick('resSeg', b=>{ S.resolution=b.dataset.res; applyDet(); });
  $('detSizeSeg')?.addEventListener('click',e=>{const b=e.target.closest('button'); if(!b)return;
    [...$('detSizeSeg').children].forEach(x=>x.classList.remove('on')); b.classList.add('on');
    setDetSize(parseInt(b.dataset.w),parseInt(b.dataset.h));});
  $('detOrientSeg')?.addEventListener('click',e=>{const b=e.target.closest('button'); if(!b)return; setDetOrient(b.dataset.orient);});
  segPick('gridSeg', b=>{ S.gridOn=(b.dataset.grid==='on');
    $('gridStateV').textContent=S.gridOn?'IN':'OUT'; });
  segPick('gridRatioSeg', b=>{ S.gridRatio=parseInt(b.dataset.ratio);
    $('gridRatioV').textContent=S.gridRatio+':1'; });
  segPick('gridFocusSeg', b=>{ S.gridFocus=parseInt(b.dataset.focus);
    $('gridFocusV').textContent=S.gridFocus+' cm'; });
  // image orientation
  $('rotL').addEventListener('click',()=>{ if(!S.hasImage)return; S.imgRot=(S.imgRot+270)%360; drawFilm();});
  $('rotR').addEventListener('click',()=>{ if(!S.hasImage)return; S.imgRot=(S.imgRot+90)%360; drawFilm();});
  $('flipH').addEventListener('click',()=>{ if(!S.hasImage)return; S.flipH=!S.flipH; $('flipH').classList.toggle('on',S.flipH); drawFilm();});
  $('flipV').addEventListener('click',()=>{ if(!S.hasImage)return; S.flipV=!S.flipV; $('flipV').classList.toggle('on',S.flipV); drawFilm();});
  $('imgReset').addEventListener('click',()=>{ S.imgRot=0;S.flipH=false;S.flipV=false;
    $('flipH').classList.remove('on');$('flipV').classList.remove('on'); if(S.hasImage) drawFilm();});
}
function nearestMasIdx(){ let bi=0,bd=1e9; masSteps.forEach((v,i)=>{const d=Math.abs(v-S.mas); if(d<bd){bd=d;bi=i;}}); return bi; }
function nearestMaIdx(){ let bi=0,bd=1e9; maSteps.forEach((v,i)=>{const d=Math.abs(v-S.ma); if(d<bd){bd=d;bi=i;}}); return bi; }
function refreshReadouts(){
  $('kvV').textContent=S.kv; $('kvSv').textContent=S.kv;
  $('maV').textContent=S.ma; $('maSv').textContent=S.ma;
  $('masV').textContent=S.mas.toFixed(S.mas<10?1:0); $('masSv').textContent=S.mas.toFixed(S.mas<10?1:0);
  $('fsV').innerHTML=(S.ma>400?'1.0':'0.6')+'<small>mm</small>';
  const t=exposureTimeSec();
  $('timeV').innerHTML = t<1 ? Math.round(t*1000)+'<small>ms</small>' : t.toFixed(t<10?2:1)+'<small>s</small>';
  $('timeInline').textContent=fmtTime(t);
}

/* ---- ROTOR + EXPOSURE (press-and-hold) ---- */
function resetPrep(){ /* rotor now persists until an exposure completes */ }

function setRotor(on){
  if(S.exposing) return;
  S.prepped=on;
  $('rotor').classList.toggle('on',on);
  $('fire').disabled=!on;
  $('fire').classList.toggle('armed',on);
  setWarn(on?'ready':'standby');
  $('clock').textContent = on ? 'ROTOR — READY' : 'STANDBY';
  if(on){ Sound.resume(); Sound.play('press'); }   // ExposurePress.wav
}
function toggleRotor(){ if(S.exposing) return; setRotor(!S.prepped); }

function setWarn(mode){
  const w=$('warn'),t=$('warnT');
  w.classList.remove('ready','live');
  if(mode==='ready'){w.classList.add('ready');t.textContent='READY — ROTOR ENGAGED';}
  else if(mode==='live'){w.classList.add('live');t.textContent='◉ RADIATION ON';}
  else t.textContent='SYSTEM STANDBY';
}

// exposure hold state
const EXP={holding:false, done:false, t0:0, dur:0, raf:0, timer:0};

function startExposure(){
  if(!S.prepped || S.exposing) return;
  S.exposing=true; EXP.done=false; EXP.holding=true;
  EXP.dur=Math.max(0.02, exposureTimeSec())*1000;   // ms the switch must be held
  EXP.t0=performance.now();
  setWarn('live'); $('clock').textContent='EXPOSING';
  $('fire').classList.remove('armed'); $('fire').classList.add('firing');
  $('noexp').style.display='none'; $('prog').style.width='0%';
  Sound.resume(); Sound.play('start'); Sound.startBuzz();   // Start.wav + looping Buzz.wav
  (function tick(){
    if(!EXP.holding) return;
    const el=performance.now()-EXP.t0;
    $('prog').style.width=Math.min(100, el/EXP.dur*100).toFixed(0)+'%';
    if(el>=EXP.dur){ finishExposure(true); return; }
    EXP.raf=requestAnimationFrame(tick);
  })();
  EXP.timer=setTimeout(()=>{ if(EXP.holding) finishExposure(true); }, EXP.dur+40);
}

function releaseExposure(){
  if(!S.exposing || !EXP.holding || EXP.done) return;
  const el=performance.now()-EXP.t0;
  if(el < EXP.dur-1) finishExposure(false);          // switch let go too early
}

function finishExposure(success){
  if(EXP.done) return; EXP.done=true; EXP.holding=false;
  if(EXP.raf) cancelAnimationFrame(EXP.raf);
  if(EXP.timer) clearTimeout(EXP.timer);
  $('fire').classList.remove('firing');
  Sound.stopBuzz();
  Sound.play('end', ()=>Sound.play('cooldown'));     // End.wav then Cooldown.wav
  setWarn('standby');
  // rotor disengages after the exposure switch cycle
  S.prepped=false; $('rotor').classList.remove('on'); $('fire').disabled=true; $('fire').classList.remove('armed');
  if(success){
    $('clock').textContent='ACQUIRING';
    computeRadiograph().then(()=>{ S.exposing=false; $('clock').textContent='IMAGE READY'; });
  } else {
    S.exposing=false;
    $('clock').textContent='EXPOSURE TERMINATED';
    showExposureError();
  }
}

/* Compute the radiograph (unchanged physics); returns a promise. */
async function computeRadiograph(){
  const phantom=buildPhantom();
  const source=sourcePos();

  // detector matches the 3D image receptor (selectable size) so open collimation
  // captures the whole plate, with empty field between the model and the edges.
  const detW=S.detW, detH=S.detH;  // cm (effective, size + orientation)
  const nx=S.detNx, ny=S.detNy;    // full native detector matrix — ray-cast at the true resolution
  const pxU=detW/nx, pxV=detH/ny;
  const detCenter=[0,0,0];
  const detU=[1,0,0], detV=[0,0,1];

  const I0 = S.mas * Math.pow(S.kv/70,2);   // dose ∝ mAs·kVp^2
  // quanta per pixel scale with pixel AREA: finer matrices collect fewer photons
  // per element -> more quantum mottle (the resolution/noise trade-off).
  const STD_PX=0.048*0.048;                     // reference detector pixel area (~0.48 mm) for the noise model
  const photonScale = 340 * (pxU*pxV)/STD_PX;   // higher quanta -> lower mottle (clean DR look)

  // collimation mask: which detector cells fall inside the beam cone.
  // Tested in the tube frame so the exposed field keystones with CR angle,
  // matching the light field exactly.
  const {source:fsrc, d:fd, wAxis, lAxis} = tubeFrame();
  const tw=(S.collX/2)/S.sid, tl=(S.collZ/2)/S.sid;
  const mask=new Uint8Array(nx*ny);
  const halfU=(nx-1)/2, halfV=(ny-1)/2;
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    const u=(i-halfU)*pxU, v=(j-halfV)*pxV;
    let rx=u-fsrc[0], ry=-fsrc[1], rz=v-fsrc[2];      // source -> cell
    const dv=rx*fd[0]+ry*fd[1]+rz*fd[2];              // forward component
    const wv=rx*wAxis[0]+ry*wAxis[1]+rz*wAxis[2];
    const lv=rx*lAxis[0]+ry*lAxis[1]+rz*lAxis[2];
    mask[j*nx+i]= (dv>0 && Math.abs(wv/dv)<=tw && Math.abs(lv/dv)<=tl) ? 1 : 0;
  }

  const spectrum=Spectrum.make(S.kv);
  // ---- Python GPU engine (voxel subjects): same physics, integrated server-side.
  // The browser stays the source of truth for the spectrum + per-material mu tables
  // and sends them along; on any failure we fall back to the in-browser engine.
  let dose=null;
  if(S.xrayBackend==='python' && phantom.voxel && S.computeInfo){
    try{
      $('prog').style.width='30%';
      dose=await compute.projectVoxel({
        model:S.subject, flips:Array.from(phantom.flip,Boolean),
        center:[(phantom.min[0]+phantom.max[0])/2,(phantom.min[1]+phantom.max[1])/2,(phantom.min[2]+phantom.max[2])/2],
        source, detCenter, detU, detV, nx, ny, pxU, pxV,
        binsW:spectrum.bins.map(b=>b.w),
        muMat:muOverBins(spectrum.bins).map(r=>Array.from(r)),
        I0, refDist:100,
        coneD:fd, coneW:wAxis, coneL:lAxis, coneTw:tw, coneTl:tl,
      });
    }catch(err){
      if(phantom.geometryOnly){   // no browser volume to fall back to
        $('prog').style.width='0%';
        throw new Error('This model requires the Python GPU backend, which is not reachable. '+err.message);
      }
      console.warn('GPU backend projection failed — falling back to the browser engine', err); dose=null;
    }
  }
  if(!dose){
    dose=await AttenuationEngine.project({
      phantom, source, detCenter, detU, detV, nx, ny, pxU, pxV,
      spectrum, I0, refDist:100,
      onRow:(f)=>{ $('prog').style.width=(f*100).toFixed(0)+'%'; },
    });
  }

  // ---- anti-scatter grid ----
  // A focused linear grid (strips running along the long z axis) passes a fixed
  // fraction of primary and cuts more as the incident ray angle in the x (across-
  // strip) plane departs from the strip tilt. Strips converge at height gridFocus
  // above the receptor centre, so mismatched SID, lateral decentering, or LM
  // angulation all produce position-dependent cutoff. CC angulation (along the
  // strips) is unaffected — exactly like a real grid.
  if(S.gridOn){
    const r=S.gridRatio, f0=S.gridFocus, base=0.68;
    const sx=fsrc[0], sy=fsrc[1];
    for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
      const k=j*nx+i; if(!mask[k]) continue;
      const px=(i-halfU)*pxU;                         // detector x (world, detU=[1,0,0])
      const rayAng=Math.atan2(px-sx, sy);             // incident ray tilt in x-plane
      const stripAng=Math.atan2(px, f0);              // focused strip tilt at this x
      const t=Math.max(0, 1 - r*Math.abs(Math.tan(rayAng-stripAng)));
      dose[k]*= base*t;
    }
  }

  const {signal,EI}=Detector.capture(dose,nx,ny,photonScale,mask);
  S.lastSignal=signal; S.nx=nx; S.ny=ny; S.mask=mask; S.hasImage=true;

  S.eiTarget=250;
  drawFilm();
  updateDI(EI);
  annotate(spectrum);
  if(S.bayContent==='image') setContent('image');

  $('prog').style.width='100%';
  setTimeout(()=>{$('prog').style.width='0%';},400);
}

/* Early-release error: replace the image with an error message. */
function showExposureError(){
  S.hasImage=false;
  $('noexp').style.display='none';
  drawError($('film'));
  if(S.bayContent==='image'){ $('bigFilm').style.display='block'; $('bignote').style.display='none'; drawError($('bigFilm')); }
  $('eiV').textContent='—';  $('eiV').className='v';
  $('eitV').textContent='—'; $('diV').textContent='ERR'; $('diV').className='v bad';
  ['fnTL','fnTR','fnBL','fnBR'].forEach(id=>$(id).textContent='');
  $('prog').style.width='0%';
}
function drawError(cv){
  cv.width=400; cv.height=500;
  const c=cv.getContext('2d');
  c.fillStyle='#000'; c.fillRect(0,0,cv.width,cv.height);
  c.textAlign='center';
  c.fillStyle='#ff3b30'; c.font='bold 30px "Share Tech Mono",monospace';
  c.fillText('EXPOSURE', cv.width/2, 210);
  c.fillText('TERMINATED', cv.width/2, 248);
  c.fillStyle='#ff8a80'; c.font='14px "Share Tech Mono",monospace';
  c.fillText('EXPOSURE SWITCH RELEASED', cv.width/2, 296);
  c.fillText('BEFORE EXPOSURE COMPLETE', cv.width/2, 318);
  c.fillStyle='#8a96a3'; c.font='12px "Share Tech Mono",monospace';
  c.fillText('RE-ENGAGE ROTOR AND REPEAT', cv.width/2, 356);
}

/* ---- render stored signal: crop to exposed field, window/level, invert,
        then apply rotation + flips. Renders to any target canvas. ---- */
function computeCrop(){
  const {nx,ny,mask}=S;
  let i0=nx,i1=-1,j0=ny,j1=-1;
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    if(mask[j*nx+i]){ if(i<i0)i0=i; if(i>i1)i1=i; if(j<j0)j0=j; if(j>j1)j1=j; }
  }
  if(i1<i0){ i0=0;i1=nx-1;j0=0;j1=ny-1; }   // fallback: whole detector
  return {i0,i1,j0,j1};
}
function renderRadiograph(target){
  const {lastSignal:sig,nx,mask}=S; if(!sig||!target) return;
  const {i0,i1,j0,j1}=computeCrop();
  const cw=i1-i0+1, ch=j1-j0+1;
  // open-field normalization for log display
  let mx=0; for(let k=0;k<sig.length;k++) if(mask[k]&&sig[k]>mx) mx=sig[k]; mx=mx||1;
  const a=40, denom=Math.log(1+a), contrast=S.win/100, bright=S.lev/100;
  // build cropped, windowed bitmap
  const crop=document.createElement('canvas'); crop.width=cw; crop.height=ch;
  const cctx=crop.getContext('2d'); const img=cctx.createImageData(cw,ch);
  for(let j=0;j<ch;j++)for(let i=0;i<cw;i++){
    const k=(j0+j)*nx+(i0+i);
    let v;
    if(!mask[k]) v=0;
    else { let t=sig[k]/mx; t=Math.log(1+a*t)/denom; v=1-t; }  // invert: bone->white
    v=(v-0.5)*contrast+0.5+bright; v=Math.max(0,Math.min(1,v));
    const g=Math.round(v*255), o=(j*cw+i)*4;
    img.data[o]=img.data[o+1]=img.data[o+2]=g; img.data[o+3]=255;
  }
  cctx.putImageData(img,0,0);
  // orient (rotate + flip) into the target, sizing target to the exposed crop.
  // A per-subject hanging default is applied first, then the user's adjustments:
  //  - hand: fingertips (+z, the plate arrow) up -> 180° rotation. A rotation, NOT a
  //    vertical mirror, so left/right chirality is preserved.
  //  - voxel body (chest, etc.): the superior end is world +z, which the raw detector
  //    mapping lands at the image BOTTOM, so flip vertically to hang it head-up; mirror
  //    horizontally too because a PA projection is displayed as if facing the patient.
  const baseRot = S.subject!=='hand' ? 0 : 180;
  const baseFlipH = S.subject!=='hand';
  const baseFlipV = S.subject!=='hand';
  const rot=(((baseRot+S.imgRot)%360)+360)%360, rot90=(rot===90||rot===270);
  target.width  = rot90? ch: cw;
  target.height = rot90? cw: ch;
  const tctx=target.getContext('2d');
  tctx.clearRect(0,0,target.width,target.height);
  tctx.save();
  tctx.translate(target.width/2, target.height/2);
  tctx.rotate(rot*Math.PI/180);
  tctx.scale((baseFlipH!==S.flipH)?-1:1, (baseFlipV!==S.flipV)?-1:1);
  tctx.drawImage(crop, -cw/2, -ch/2);
  tctx.restore();
}
function drawFilm(){
  renderRadiograph($('film'));
  if(S.bayContent==='image' && S.hasImage) renderRadiograph($('bigFilm'));
  updateXrayHistogram();
}

/* ---- display histogram + brightness/contrast response curve ----
   Draws a 256-bin histogram of the image's base (pre window/level) grey values with
   the current brightness/contrast response curve overlaid, so the user sees how the
   window maps input tones to output. Shared drawer; x-ray + CT feed it their own data. */
export function drawHistogram(canvas, hist, curveFn){
  if(!canvas) return;
  const g=canvas.getContext('2d'), W=canvas.width, H=canvas.height;
  g.clearRect(0,0,W,H);
  let hmax=1; for(const v of hist) if(v>hmax) hmax=v;
  const logmax=Math.log(1+hmax)||1, n=hist.length;
  g.fillStyle='#243441';
  for(let x=0;x<n;x++){ const h=Math.log(1+hist[x])/logmax*(H-2);
    g.fillRect(x/n*W, H-h, W/n+0.6, h); }
  // response curve (input tone -> output tone), left→right = dark→bright input
  g.strokeStyle='#35c6d6'; g.lineWidth=1.5; g.beginPath();
  for(let x=0;x<=n;x++){ const out=Math.max(0,Math.min(1,curveFn(x/n)));
    const px=x/n*W, py=H-1-out*(H-2); if(x===0) g.moveTo(px,py); else g.lineTo(px,py); }
  g.stroke();
}
/* 256-bin histogram of the inverted log signal (the base tone before window/level),
   over the exposed field only — matches the mapping in renderRadiograph. */
function xrayHistData(){
  const {lastSignal:sig,mask}=S; if(!sig||!mask) return null;
  let mx=0; for(let k=0;k<sig.length;k++) if(mask[k]&&sig[k]>mx) mx=sig[k]; mx=mx||1;
  const a=40, denom=Math.log(1+a), hist=new Uint32Array(256);
  for(let k=0;k<sig.length;k++){ if(!mask[k]) continue;
    let t=sig[k]/mx; t=Math.log(1+a*t)/denom; let b=Math.round((1-t)*255);
    hist[b<0?0:b>255?255:b]++; }
  return hist;
}
function updateXrayHistogram(){
  const canvas=$('xrayHist'); if(!canvas) return;
  if(!S.showHist || !S.hasImage){ canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height); return; }
  const hist=xrayHistData(); if(!hist) return;
  const contrast=S.win/100, bright=S.lev/100;
  drawHistogram(canvas, hist, v0=>(v0-0.5)*contrast+0.5+bright);
}

function updateDI(EI){
  const DI = 10*Math.log10(EI/S.eiTarget);
  $('eiV').textContent=EI;
  $('eitV').textContent=S.eiTarget;
  const diEl=$('diV'); diEl.textContent=(DI>=0?'+':'')+DI.toFixed(1);
  diEl.className='v '+(Math.abs(DI)<=1?'ok':Math.abs(DI)<=3?(DI>0?'hi':'lo'):'bad');
  $('eiV').className='v '+(Math.abs(DI)<=1?'ok':'');
}

function annotate(spec){
  const subjName=(S.subject==='hand'?'HAND':(VOXEL_MODELS[S.subject]?.title||S.subject).toUpperCase());
  $('fnTL').textContent=subjName+' · '+S.pose;
  $('fnTR').textContent=S.kv+' kVp  '+S.ma+' mA  '+S.mas.toFixed(S.mas<10?1:0)+' mAs';
  $('fnBL').textContent='SID '+S.sid+'  OID '+S.oid+'cm  '+fmtTime(exposureTimeSec())+'  Ē '+spec.meanE.toFixed(0)+'keV';
  $('fnBR').textContent='DR '+S.detNx+'×'+S.detNy+'  '+S.detW+'×'+S.detH+'cm  '+(S.gridOn?'GRID '+S.gridRatio+':1':'NO GRID');
}

/* ---- compute backend (Python GPU) ---- */
const compute=new ComputeClient();
/* Ping the backend; update the status chips + enable/disable the Python buttons in
   both modes. Called at boot and whenever a toggle is pressed. */
async function refreshComputeStatus(){
  S.computeInfo=await compute.health();
  const on=!!S.computeInfo, dev=on?(S.computeInfo.compute||{}):null;
  const label=on ? ((dev.device==='cuda'?(dev.name||'GPU'):'CPU')) : 'offline';
  for(const id of ['backendStatusX','backendStatusCT']){
    const el=$(id); if(!el) continue;
    el.textContent=label;
    el.classList.toggle('green', on);
  }
  for(const segId of ['backendSegX','backendSegCT']){
    const b=document.querySelector('#'+segId+' button[data-be="python"]');
    if(b) b.disabled=!on;
  }
  // if the backend vanished while selected, drop back to the browser engine — unless
  // a backend-only model is loaded (it has no browser volume, so local can't render it)
  if(!on && !S.backendOnly){
    if(S.xrayBackend==='python') setBackend('xray','local');
    if(S.ct.backend==='python') setBackend('ct','local');
  }
  const dot=$('computeDot');
  if(dot){
    dot.textContent=on?'●':'○';
    dot.style.color=on?'var(--green)':'var(--muted2)';
    dot.title=on?('compute backend online — '+label):'compute backend offline (optional)';
  }
  return on;
}
function setBackend(mode,val){
  if(mode==='xray') S.xrayBackend=val; else S.ct.backend=val;
  const seg=$(mode==='xray'?'backendSegX':'backendSegCT');
  if(seg)[...seg.children].forEach(b=>b.classList.toggle('on',b.dataset.be===val));
}
/* A backend-only model has no volume in the browser, so it can ONLY render via the
   Python GPU engine — force it in both modes and lock out the Browser toggle. */
function applyBackendOnly(on){
  S.backendOnly=on;
  if(on){ setBackend('xray','python'); setBackend('ct','python'); }
  for(const segId of ['backendSegX','backendSegCT']){
    const seg=$(segId); if(!seg) continue;
    const local=seg.querySelector('button[data-be="local"]');
    const py=seg.querySelector('button[data-be="python"]');
    if(local) local.disabled=on;                          // can't use the browser engine
    if(on && py) py.disabled=!S.computeInfo;               // python still needs the backend up
  }
  if(on && !S.computeInfo){ refreshComputeStatus().then(ok=>{
    if(!ok){ const h=$('subjectHint'); if(h) h.textContent='⚠ Start the Python backend — this model needs the GPU engine.'; }
  }); }
}
function wireBackendToggles(){
  for(const [segId,mode] of [['backendSegX','xray'],['backendSegCT','ct']]){
    $(segId)?.addEventListener('click',async e=>{
      const b=e.target.closest('button'); if(!b||b.disabled) return;
      if(b.dataset.be==='python' && !S.computeInfo){
        const ok=await refreshComputeStatus();
        if(!ok) return;   // still offline — stay on the browser engine
      }
      setBackend(mode,b.dataset.be);
    });
  }
  // CT detector design: quick preview vs realistic fixed-pitch MDCT
  $('ctDetModeSeg')?.addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b) return;
    S.ct.detMode=b.dataset.dm;
    [...$('ctDetModeSeg').children].forEach(x=>x.classList.toggle('on',x.dataset.dm===S.ct.detMode));
    const v=$('ctDetModeV'); if(v) v.textContent=S.ct.detMode==='realistic'?'800 ch · 0.625 mm':'128 ch · preview';
  });
}

/* ---- custom model import (.glb) ---- */
let modelGroup=null;
function initExtras(){
  const inp=$('loadModelInput');
  $('loadModelBtn')?.addEventListener('click',()=>inp?.click());
  inp?.addEventListener('change', async (e)=>{
    const file=e.target.files[0]; if(!file) return;
    try{
      const grp=await loadModelFile(file);
      if(modelGroup) three.scene.remove(modelGroup);
      modelGroup=grp; three.scene.add(modelGroup);
    }catch(err){ console.error('model load failed',err); alert('Could not load model: '+err.message); }
    inp.value='';
  });
  $('clearModelBtn')?.addEventListener('click',()=>{ if(modelGroup){ three.scene.remove(modelGroup); modelGroup=null; } });
  wireBackendToggles();
  refreshComputeStatus();
}

/* ---- boot ---- */
window.addEventListener('load',()=>{
  initScene(); bind(); refreshReadouts(); updateGeomReadouts(); applyDet(); syncScene();
  Sound.init(); initExtras();
  // CT mode lives in its own module; give it the handles it needs from the app glue.
  initCT({ THREE, S, $, three, Sound,
           syncScene, refreshReadouts, updateGeomReadouts, buildHandMeshes,
           poseRot, buildPhantom, ctLiveView, setCameraView, setCTPov, setContent, setBay3DEnabled,
           refreshFilmViewer, compute, drawHistogram });
});
