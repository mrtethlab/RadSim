// RADSIM application glue: 3D positioning scene, simulation orchestration,
// film rendering and UI wiring. The reusable physics engine lives in ./core,
// the hand phantom in ./phantom/hand.js (both stay CT/model-ready).
import * as THREE from 'three';
import { Spectrum } from './core/spectrum.js';
import { Phantom } from './core/phantom.js';
import { AttenuationEngine } from './core/engine.js';
import { Detector, EI_K, AEC_CHAMBER_CAL } from './core/detector.js';
import { Sound } from './audio/sound.js';
import { loadModelUrl } from './model/loader.js';
import { loadVoxelModel } from './model/voxelLoader.js';
import { muOverBins, eulerMatrix } from './core/voxelPhantom.js';
import { decodeTimeline, buildSVolume, buildConcLUT, NS as CONTRAST_NS } from './core/contrast.js';
import { decodeGITimeline, buildGIVolume, buildBariumLUT, buildGasLUT, NS as GI_NS } from './core/gi.js';
import { GIStudy, SEGMENTS as GI_SEGMENTS } from './core/giSolve.js';
import lutData from './data/luts.json';
import protocolData from './data/protocols.json';
import { BodyMaterials } from './core/materials.js';
import { ComputeClient } from './compute/client.js';
import { initTutorial } from './tutorial.js';
import { initCT, couchSpeedMMps, sliceTime, ctSyncScene, ctRenderViewer, ctRenderRecons, ctApplyAcqMode, ctApplyVendor, ctApplyColorTheme, ctApplyMode } from './ct.js';
import { initEditor, editorApplyMode, editorSyncScene } from './editor.js';
import { initMobile } from './mobile.js';
import { initFluoro, fluoroApplyMode, fluoroSyncScene } from './fluoro.js';

/* ============================================================================
   MODULE 6 — SCENE3D  (Three.js POSITIONING view only; not the image)
   ============================================================================ */
let three = {};
function initScene(){
  const canvas=document.getElementById('view');
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true});
  // phones: a DPR-3 canvas quadruples the fill cost for detail nobody can see at arm's
  // length in a dark room render — cap harder there than on desktop
  const coarse=matchMedia('(pointer: coarse)').matches;
  renderer.setPixelRatio(Math.min(devicePixelRatio, coarse?1.5:2));
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
  // AEC ionisation chambers: three outlined cells on the receptor (bucky pattern —
  // outer pair toward the head end, centre cell lower). Shown only when AEC is on;
  // selected cells fill translucent cyan. Fixed to the bucky (never scale with the plate).
  const aecGroup=new THREE.Group(); scene.add(aecGroup);
  const aecCellMeshes={};
  for(const [k,p] of Object.entries(AEC_CELLS)){
    const fill=new THREE.Mesh(new THREE.PlaneGeometry(AEC_W,AEC_L),
      new THREE.MeshBasicMaterial({color:0x35c6d6, transparent:true, opacity:0.16, side:THREE.DoubleSide, depthWrite:false}));
    fill.rotation.x=-Math.PI/2; fill.position.set(p.x,0.09,p.z); aecGroup.add(fill);
    const edge=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(AEC_W,AEC_L)),
      new THREE.LineBasicMaterial({color:0x35c6d6, transparent:true, opacity:0.9}));
    edge.rotation.x=-Math.PI/2; edge.position.set(p.x,0.1,p.z); aecGroup.add(edge);
    const lc=document.createElement('canvas'); lc.width=lc.height=64;
    const lg=lc.getContext('2d'); lg.fillStyle='#bdf3fa'; lg.font='bold 40px Arial';
    lg.textAlign='center'; lg.textBaseline='middle';
    // Turn the glyph 180 deg: a plane laid flat by rotation.x = -PI/2 presents its texture
    // to the camera upside down, so drawn as-is the letters read inverted against the
    // hang arrow. Rotating the canvas rather than the mesh keeps the label's transform
    // identical to the fill and edge it sits on.
    lg.translate(32,32); lg.rotate(Math.PI); lg.translate(-32,-32);
    lg.fillText(k.toUpperCase(),32,30);
    const lbl=new THREE.Mesh(new THREE.PlaneGeometry(1.8,1.8),
      new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(lc), transparent:true, opacity:0.9, depthWrite:false}));
    lbl.rotation.x=-Math.PI/2; lbl.position.set(p.x,0.11,p.z); aecGroup.add(lbl);
    aecCellMeshes[k]={fill,edge,lbl};
  }
  aecGroup.visible=false;

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

  // tube head — a manual collimator box modeled to the reference photos, with a LIVE LCD strip
  const tube=new THREE.Group();
  const collLCD=buildCollimatorHead(THREE,tube);
  scene.add(tube);

  // central ray
  const crGeo=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]);
  const cr=new THREE.Line(crGeo,new THREE.LineBasicMaterial({color:0x35c6d6,transparent:true,opacity:.4}));
  scene.add(cr);

  const beam=new THREE.Group(); scene.add(beam);         // retired (unused)
  const handGroup=new THREE.Group(); scene.add(handGroup);

  three={renderer,scene,cam,tube,cr,lf,lfFill,lfCross,beam,handGroup,det,detMarks,detArrow,
         amb,key,lamp,cookieCanvas,cookieTex,lampAngle,collLCD,aecGroup,aecCellMeshes};

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
    // Mobile pager: when the bay page is hidden there is nothing to draw INTO — except
    // during a CT scout/table-move, whose monitor mirror reads this very framebuffer.
    if(document.body.classList.contains('mobile')
       && !document.querySelector('.bay.mpage-on')
       && !(S.mode==='ct' && (S.ct.liveView || S.ct.moveBlit))){
      requestAnimationFrame(loop); return;
    }
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

/* Voxel model registry: every folder in public/models/. The `id` is BOTH the folder
   name and the file basename (…/<id>/<id>.model.json) and the model name sent to the
   Python backend, so keep them in sync with the build output.
   scoutKv/scoutMa are the default CT scout technique; xrayKv the default x-ray kV
   (thin extremities need far less than a thick torso). */
const VOXEL_MODELS = {
  hand:            { title:'Hand',                  scoutKv:80,  scoutMa:40,  xrayKv:55  },
  // Same hand at 0.2 mm — the coarsest grid that can carry the measured trabecular lattice
  // (Tb.Th+Tb.Sp = 0.96 mm at BV/TV 0.31 needs <= 0.206 mm). 316 MB, GPU backend only —
  // the volume is not committed (over GitHub 100 MB per-file) so it is absent from the
  // hosted build; run services/compute/app/build_hand.py to make it locally.
  hand_hires:      { title:'Hand · 0.2 mm',        scoutKv:80,  scoutMa:40,  xrayKv:55  },
  chest:           { title:'Chest',                 scoutKv:120, scoutMa:120, xrayKv:120 },
  headneck:        { title:'Head & neck',           scoutKv:120, scoutMa:150, xrayKv:110 },
  chestabdopelvis: { title:'Chest / abdo / pelvis', scoutKv:120, scoutMa:200, xrayKv:120 },
  upperextremity:  { title:'Upper extremity',       scoutKv:70,  scoutMa:50,  xrayKv:60  },
  lowerextremity:  { title:'Lower extremity',       scoutKv:85,  scoutMa:90,  xrayKv:75  },
  totalhipreplacement: { title:'Total Hip Replacement', scoutKv:120, scoutMa:250, xrayKv:90 },
  wholebody:       { title:'Whole body',            scoutKv:120, scoutMa:250, xrayKv:110 },
  hires_shoulder:  { title:'Shoulder · 0.25 mm',    scoutKv:110, scoutMa:120, xrayKv:70  },
  metalphantom:    { title:'Metal Test Phantom',    scoutKv:120, scoutMa:200, xrayKv:120 },
  // QC tools, not anatomy: a lead bar-pattern gauge for measuring limiting spatial
  // resolution in lp/mm. Shot at low kV / high mAs like real resolution QC, so the
  // lead-to-air contrast is maximal and the bars are not lost in mottle.
  linepair:        { title:'Line-pair test pattern', scoutKv:80, scoutMa:100, xrayKv:60 },
};

/* Prepare a freshly loaded display mesh so it lights + shadows like the hand: the
   exported GLB carries PBR defaults (metalness 1), no shadow flags and NO normals
   (GLTFLoader falls back to flat shading, which breaks the spot-light cookie
   projection — the light field floods the whole mesh unmasked). */
function prepVoxelMesh(grp, translucent){
  grp.traverse(o=>{ if(o.isMesh){ o.castShadow=true; o.receiveShadow=true;
    if(!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    // phantom shell/fill (acrylic, water) render see-through so the interior rods show;
    // the lead rods stay solid + metallic and draw on top of the translucent fill
    const clear = translucent && /acrylic|water/i.test(o.name);
    const metal = translucent && /lead|metal/i.test(o.name);
    const ms=Array.isArray(o.material)?o.material:[o.material];
    for(const m of ms){ if(m){ m.metalness=0; m.roughness=0.95; m.flatShading=false;
      if(clear){ m.transparent=true; m.depthWrite=false; m.opacity=/water/i.test(o.name)?0.22:0.16; m.side=THREE.DoubleSide; o.castShadow=false; o.renderOrder=1; }
      else if(metal){ m.transparent=false; m.opacity=1; m.metalness=0.85; m.roughness=0.35; m.color.setHex(0x8a9099); o.renderOrder=2; }
      m.needsUpdate=true; } } } });
}

/* Switch the scan subject to any voxel model. Models (material volume + display mesh)
   are fetched on first use and cached; the meshes all live in handGroup so the CT
   positioning offsets apply to every subject the same way. */
async function setSubject(sub){
  const sel=$('subjectSel'); const hint=$('subjectHint');
  S.voxelCache=S.voxelCache||{}; three.voxelMeshes=three.voxelMeshes||{};
  const showActive=(id)=>{ for(const k in three.voxelMeshes) three.voxelMeshes[k].visible=(k===id);
                           three.chestGroup=three.voxelMeshes[id]||null; };
  const cfg=VOXEL_MODELS[sub];
  if(!cfg){ console.warn('unknown subject',sub); return; }
  let vm=S.voxelCache[sub];
  if(!vm){
    // Metered phones: say what a subject costs before pulling it. Approximate volume sizes
    // (MB) for everything over the ~20 MB default hand; only asked once per subject per
    // session, and only when the browser reports a constrained connection.
    if(document.body.classList.contains('mobile')){
      const MB={chest:40, wholebody:30, headneck:17, totalhipreplacement:17, lowerextremity:17};
      const conn=navigator.connection;
      const slow=conn && (conn.saveData || /2g|3g/.test(conn.effectiveType||''));
      if(MB[sub] && slow && !(S.warnedSize=S.warnedSize||new Set()).has(sub)){
        S.warnedSize.add(sub);
        if(!confirm(`${cfg.title} is a ~${MB[sub]} MB download and your connection looks `
          +`metered or slow. Load it anyway?`)){ if(sel) sel.value=S.subject; return; }
      }
    }
    if(hint) hint.textContent='Loading '+cfg.title+'…';
    S.subjectLoading=true;   // guards CT START/exposure until the swap completes
    try{
      vm=await loadVoxelModel(import.meta.env.BASE_URL+'models/'+sub, sub);
      S.voxelCache[sub]=vm;
      if(vm.meshUrl){
        // Display meshes live in one wrapper so the CT/x-ray transforms treat the subject
        // as a single object: the material-shaded mesh plus, when the model ships one, a
        // photo-textured SKIN. Only one child is visible at a time (see applyPhotoSkin).
        const grp=await loadModelUrl(vm.meshUrl);
        prepVoxelMesh(grp, sub==='metalphantom');
        grp.userData.role='plain';
        const wrap=new THREE.Group(); wrap.add(grp);
        if(vm.skinUrl){
          try{
            const sk=await loadModelUrl(vm.skinUrl);
            prepSkinMesh(sk); sk.userData.role='skin'; wrap.add(sk);
          }catch(e){ console.warn(sub+' skin mesh failed to load',e); }
        }
        wrap.visible=false; three.handGroup.add(wrap); three.voxelMeshes[sub]=wrap;
        applyPhotoSkin();
      }
    }catch(err){ console.error(sub+' load failed',err); if(hint) hint.textContent='Load failed: '+err.message;
      if(sel) sel.value=S.subject; return; }
    finally{ S.subjectLoading=false; }
  }
  S.voxelModel=vm; S.subject=sub;
  // Phones: one material volume resident at a time. A desktop keeps every subject it has
  // touched (instant switching); a phone that did that would hold hundreds of MB of
  // Uint8Arrays and get killed by the OS. Re-downloading on switch-back is the cheaper
  // failure. Session-saved editor models are never evicted — they cannot be re-fetched.
  if(document.body.classList.contains('mobile')){
    for(const k of Object.keys(S.voxelCache||{})){
      if(k!==sub && !(S.customKeys&&S.customKeys.has(k))) delete S.voxelCache[k];
    }
  }
  const ext=vm.extentMM;
  // scan field of view scales to the model (mediolateral × AP extent) so it fits
  S.ct.scoutFovMM=Math.round(Math.max(ext[0], ext[1])+70);
  // default the scan to cover the WHOLE anatomy, pre-isocentred at the superior end
  // (scan runs superior→inferior). Tall models (whole body) need a longer scout.
  // whole scout: the model rests centred at the crosshair (table 0 = model centre), so the
  // scan range must be CENTRED on it — scanStart = −len/2 — to image the whole model
  // (positions [−len/2 … +len/2]). scanStart=0 would only cover the inferior half + air.
  S.ct.scanLen=Math.round(ext[2]); S.ct.scanStart=-Math.round(ext[2]/2); S.ct.protocol='whole';
  S.ct.patient.x=0; S.ct.patient.z=0; S.ct.isoZ=(ext[2]/2)/10;
  S.ct.isocentred=false; S.ct.tablePos=0; S.ct.tableY=0;   // require the zero button before scanning
  S.ct.scoutKv=cfg.scoutKv; S.ct.scoutMa=cfg.scoutMa;
  S.ct.scoutTech=[{kv:cfg.scoutKv,ma:cfg.scoutMa},{kv:cfg.scoutKv,ma:cfg.scoutMa}];
  // default x-ray kV to the model (thin extremities need far less than a torso)
  if(cfg.xrayKv){ S.kv=cfg.xrayKv; const kvEl=$('kv'); if(kvEl) kvEl.value=S.kv; refreshReadouts(); }
  // backend-only models (large, no volume in the browser) MUST use the Python engine
  applyBackendOnly(!!vm.backendOnly);
  // A new subject invalidates any solved timeline: the arclength volume and the vessel set
  // both belong to the old model.
  S.contrast.timeline=null; S.contrast.sVol=null; S.contrast.sVolFor=null;
  S.contrast.lut=null; S.contrast.lutT=null; S.contrast.on=false; S.contrast.static=false;
  // The barium field belongs to the old model in exactly the same way.
  S.barium.timeline=null; S.barium.giVol=null; S.barium.giVolFor=null;
  S.barium.lut=null; S.barium.lutT=null; S.barium.on=false;
  if($('ctrstPanel')) ctrstApply();
  // The GI geometry belongs to the old model too, so drop it and re-evaluate whether the new
  // subject can carry barium at all.
  S.barium.gi=null; S.barium.study=null; S.barium.running=false;
  if($('giPanel')) giApply();
  showActive(sub);
  if(hint) hint.textContent=vm.header.name+' · '+vm.dims.join('×')+' @ '+vm.spacingMM[0]+'mm';
  if(sel) sel.value=sub;
  syncScene();
}
/* Photo-textured display skin. Purely cosmetic: the attenuation always comes from the
   voxel material volume, so switching this never changes an image. Keeps the textured
   map and gives it skin-like shading (matte, no metalness). */
function prepSkinMesh(grp){
  grp.traverse(o=>{ if(o.isMesh){
    o.castShadow=true; o.receiveShadow=true;
    if(!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    const vc=!!o.geometry.attributes.color;   // photo colour is baked per-vertex
    const ms=Array.isArray(o.material)?o.material:[o.material];
    for(const m of ms){ if(!m) continue;
      m.metalness=0; m.roughness=0.72; m.transparent=false; m.opacity=1;
      if(vc){ m.vertexColors=true; m.color.setRGB(1,1,1); }
      m.side=THREE.FrontSide; m.needsUpdate=true; }
  } });
}
/* Show either the photographic skin or the material-shaded mesh for every loaded subject.
   Models without a skin mesh always show the plain one. */
function applyPhotoSkin(){
  // The photo-textured skin is simply the default whenever the model ships one — there is
  // no toggle. It is display only; the physics always reads the voxel volume. Models
  // without a skin (all but the hand, today) show the material-shaded mesh.
  for(const k in (three.voxelMeshes||{})){
    const wrap=three.voxelMeshes[k]; if(!wrap||!wrap.children) continue;
    const hasSkin=wrap.children.some(c=>c.userData&&c.userData.role==='skin');
    wrap.children.forEach(c=>{ const r=c.userData&&c.userData.role; if(!r) return;
      c.visible = r === (hasSkin?'skin':'plain'); });
  }
}

/* ---- custom (Model Editor) subjects: session-saved models become selectable under
   View Options exactly like the preset models. The editor hands over a ready voxel-model
   object (same shape loadVoxelModel returns) + a display mesh in raw volume mm axes, so
   setSubject's cache-hit path and applyVoxelMeshTransform work unchanged. ---- */
function registerCustomSubject(key, title, vm, meshGroup){
  VOXEL_MODELS[key]={ title, scoutKv:100, scoutMa:100, xrayKv:80 };
  (S.customKeys=S.customKeys||new Set()).add(key);   // exempt from the mobile cache eviction
  S.voxelCache=S.voxelCache||{}; three.voxelMeshes=three.voxelMeshes||{};
  S.voxelCache[key]=vm;
  if(meshGroup){ meshGroup.visible=false; three.handGroup.add(meshGroup); three.voxelMeshes[key]=meshGroup;
                 applyPhotoSkin(); }   // editor models have no skin: keeps the plain mesh shown
  const sel=$('subjectSel'); if(!sel) return;
  let opt=sel.querySelector('option[value="'+key+'"]');
  if(!opt){ opt=document.createElement('option'); opt.value=key; sel.appendChild(opt); }
  opt.textContent='Custom: '+title;
}
function unregisterCustomSubject(key){
  if(S.subject===key) setSubject('hand');
  delete VOXEL_MODELS[key];
  if(S.voxelCache) delete S.voxelCache[key];
  const m=three.voxelMeshes&&three.voxelMeshes[key];
  if(m){ three.handGroup.remove(m); m.traverse(o=>{ if(o.isMesh){ o.geometry.dispose(); o.material.dispose(); } }); delete three.voxelMeshes[key]; }
  $('subjectSel')?.querySelector('option[value="'+key+'"]')?.remove();
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
  // full-resolution (Low/Std/High) ray-casting is heavy — show the compute warning
  const rw=$('resWarn'); if(rw) rw.style.display = (S.resolution==='quick') ? 'none' : '';
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
  // oid is DERIVED, not set: it is the air gap under the object, i.e. the height offset.
  // It used to be a stepper that changed only this number — the geometry never moved, so
  // magnification never changed, which is what "OID is broken" meant.
  pose:'PA', spread:0.45, sid:100, oid:0, tubeZ:0, tubeX:0, angLM:0, angCC:0,
  objRot:{x:0,y:0,z:0},        // generic object rotate/tilt (deg) — applies to any subject
  objOff:{x:0,z:0,y:0},        // x-ray object offset (cm): x cross / z long axis / y lift off the receptor
  collX:15, collZ:19, kv:55, mas:2.0, ma:100, prepped:false, exposing:false, hasImage:false,
  lastSignal:null, nx:0, ny:0, mask:null, win:100, lev:0, eiTarget:250, showHist:true,
  aecOn:false, aecCells:{l:false,c:true,r:false}, aecResult:null,  // AEC: cells + achieved mAs of the last exposure
  lut:lutData.luts.linear, protocol:null,          // display LUT (sigmoid) + selected APR protocol
  showCurve:true, autoRescale:true, rescale:null,  // LUT-curve visibility; DR auto-rescale + active VOI window
  detailEnh:true, _proc:null,                      // DR detail (edge) enhancement + cached enhanced-tone map
  imgHistory:[], histIdx:-1, activeSubject:'hand', imgMeta:null,   // last-10 image review strip
  viewMode:'orbit', bayContent:'3d', lfOn:true, imgRot:0, flipH:false, flipV:false,
  curve:null, curveManual:false,                   // response-curve handles; null = follow the image
  resolution:'quick', gridOn:false, gridRatio:10, gridFocus:100, handView:'soft',
  detBaseW:35, detBaseH:43,    // receptor size (cm, short × long): 25x30 small / 35x43 large
  detOrient:'portrait',        // portrait (long axis vertical) / landscape
  detW:35, detH:43,            // effective receptor W×H (derived from size + orientation)
  detNx:320, detNy:400,        // detector native pixel matrix (true ray-cast resolution; quick default)
  // ---- subject / phantom: the analytic hand, or a voxel model (e.g. the chest) ----
  subject:'hand',              // 'hand' | 'chest'
  voxelModel:null,             // loaded voxel model (dims/spacing/data/legend/makePhantom)
  // Contrast (docs/contrast-simulation.md). `timeline` is the solved haemodynamics for the
  // current injector settings; `scanTime` is when the acquisition happens relative to the
  // start of the injection, which is the single most consequential number in a CTA.
  contrast:{ on:false, timeline:null, sVol:null, scanTime:25,
             params:{ volume_ml:100, rate_ml_s:4.0, conc_mgi_ml:350, delay_s:0, saline_ml:40,
                      volume2_ml:0, rate2_ml_s:2.0,
                      saline_rate_ml_s:4.0, cardiac_output_l_min:5.0, blood_volume_ml:5000,
                      vessel_scale:1.0, perfusion_scale:1.0, site:'basilic' },
             lut:null, lutT:null, busy:false, error:null,
             // injector transport: t0 = when START was pressed, latched = the elapsed time
             // frozen at the moment an image was actually acquired
             run:{ t0:null, latched:null, timer:null },
             // true when the timeline came from the model's shipped preset rather than a
             // live solve — the protocol is then fixed and the controls are locked
             static:false,
             },
  // Barium studies. `studyTime` is seconds since the agent was given, and is the analogue of
  // the injector clock: for a swallow it is seconds, for a follow-through it is minutes.
  barium:{ on:false, timeline:null, giVol:null, giVolFor:null, studyTime:60,
           lut:null, lutT:null, busy:false, error:null, static:false,
           // live study (core/giSolve.js): the clock advances it and the pose is read from
           // the rotate/tilt sliders, so turning the patient moves the agent from that moment
           gi:null, study:null, running:false, speed:10, lastTick:0,
           route:'oral', volumeMl:150, concPct:100, erect:false,
           // double contrast: gas volume in mL (0 = single contrast) and its own LUT
           gasMl:0, gasLut:null },
  // ---- fluoroscopy (docs/fluoroscopy.md): the OEC C-arm and its pulse loop ----
  fluoro:{ machine:'oec', pps:15, kv:70, ma:2.0, pedal:false, lih:false,
           beamS:0, pulses:0, dropped:0, msAvg:0, orbital:0, tilt:0,
           // column motions: lift raises the C (cm), extend slides the boom (cm),
           // wig-wag swivels it about the column axis (deg) — all move the isocentre
           lift:0, ext:0, wig:0,
           // Phase B: ABC curve parameter, collimator iris (fraction), mag mode, dose
           abc:true, q:0.35, iris:1.0, mag:0, akMGy:0, dapUGym2:0,
           // Phase C: motion clocks (phases accumulated here; the worker is stateless)
           hold:false, hr:72, brPhase:0, cardPhase:0, periT:0, swallowAt:0,
           // electronic image orientation (display-space): accumulated rotation, flips,
           // and the pending rotation being dialled in for the NEXT run (the triangle)
           dispRot:0, flipH:false, flipV:false, pendRot:0,
           motions:[], fixedSeed:null },
  // ---- compute engine: in-browser JS, or the Python GPU backend (voxel subjects) ----
  xrayBackend:'local',         // 'local' | 'python' — x-ray projection engine
  computeInfo:null,            // /health result when the Python backend is reachable
  // ---- CT mode ----
  mode:'xray',                 // 'xray' | 'ct'
  ct:{
    scanSound:'ctExposureS1',  // CT scan-exposure sound: 'buzz' (classic) | 'ctExposureS1' (scanner S1, default)
    sliceThk:5,                // mm (station selector over discrete values)
    imgPerRotation:1,          // images reconstructed per gantry rotation
    pitch:1.0,                 // table travel per rotation / total collimation
    rotSpeed:0.5,              // seconds per gantry rotation
    scanLen:300,               // mm scout/scan length (top→bottom of the scout)
    scanStart:0,               // mm; table position (landmark-relative) of the scout's superior edge — set by the protocol
    protocol:'whole',          // selected CT protocol id (sets scanStart/scanLen + isocentre landmark)
    scoutFovMM:180,            // scout/scan field of view (mm) — adapts to the subject (hand 180 / chest ~460)
    scoutKv:80,                // scout topogram technique (kV) — default source
    scoutMa:20,                // scout topogram technique (mA)
    // per-plane scout technique: index 0 = AP (scan plane 0°), 1 = Lateral (90°)
    scoutTech:[{kv:80,ma:20},{kv:80,ma:20}],
    tablePos:0,                // mm; signed: +I (inferior) / -S (superior); isocentre zeroes it
    isoZ:0,                    // patient z recorded when the isocentre was set
    isocentred:false,
    phase:'idle',              // idle | scout | planning | moving | scanning | done
    patient:{x:0, z:0},        // patient/couch offset from the gantry isocentre
    tableY:0,                  // table height (mm); 0 = patient centred at the isocentre
    patientY:6,                // patient world-y for the current table height (set by ct.js)
    // Physics-simulation features (each adds recon cost). Default OFF (fast quick preview);
    // selecting the Realistic detector turns them all ON. fullRecon:false keeps the fast live
    // preview as the result (real-time). Toggled under Simulation settings.
    features:{ beamHardening:false, coneBeam:false, focalBlur:false, quantumNoise:false, fullRecon:false },
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
    activeRecon:-1,            // selected recon within the active group (-1 = none; hides scan lines when >=0)
    plan:{ targetX:0, targetY:0, committedX:0, committedY:0 },   // required vs applied table move (mm)
    moveBlit:null,             // 'ap'|'lat'|null: mirror this PoV into the monitor during a table move
    // ---- Phase 5/6: scan execution, reconstruction + image storage ----
    storage:[],                // stored reconstructed scans (oldest first); each = {id,label,ts,params,gridN,fovMM,muWater,slices:[{d,mu}]}
    autoDelete:true,           // auto-delete oldest scans past the cap so memory doesn't grow without bound
    storeCap:4,                // keep at most this many scan groups' worth of data when autoDelete is on
    nextScanId:1,              // running id for stored scans
    viewer:{ scanId:null, slice:0, wl:60, ww:800 },   // cross-sectional (axial) viewer state (HU window/level)
    backend:'local',           // 'local' | 'python' — CT reconstruction engine
    // Vendor workflow: 'ge' = off-centre DFOV by freely dragging the recon box (table never
    // moves A/P–L/R after scout); 'canon' = box locked to isocentre + reposition chevrons that
    // physically move the table to place the SFOV. Set under Interface options.
    vendor:'ge',
    // Colour scheme: 'vendor' = the CT interface adopts the selected vendor's console colours
    // (GE light-blue / Canon dark-grey); 'generic' = the app's default scheme. X-ray is never themed.
    colorSchema:'vendor',
    detMode:'quick',           // 'quick' (128-ch preview) | 'realistic' (fixed 0.625mm DEL, 512² recon)
    // Recon page: up to 4 independent windows, each bound to a pre-computed reconstruction from
    // the viewed scan's recon list. wins[i] = { reconId, pos } (pos = scroll position along the
    // recon's slice axis, mm) or null (empty window). Independent per-window scroll — no linked
    // cross-referencing — so panes don't all re-reformat on every interaction.
    mpr:{ scanId:null, wins:[null,null,null,null], selw:[], plan:null,
          // oblique-plane state kept for the linked-MPR localizer; the Phase-2 New-recon
          // planner uses its own m.plan state (see startReconPlan).
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
const masSteps=[0.5,0.63,0.8,1.0,1.25,1.6,2.0,2.5,3.2,4.0,5.0,6.4,8.0,10,12.5,16,20,25,32,40,50,64,80,100,125,160,200,250,320,400,500,600];

/* ---- AEC (automatic exposure control) ----
   Three ionisation chambers fixed in the bucky in the standard pattern: two outer
   cells side-by-side toward the cathode/head end (~15 cm apart) and one centre cell
   lower — behind the anatomy of interest. The chambers integrate receptor-plane air
   kerma and terminate the exposure when the AVERAGE over the selected cells reaches
   the calibrated target; the set mAs acts as the BACKUP (safety) limit. Chambers are
   fixed to the bucky, so they do not move or scale with the cassette. */
// Centres (cm on the receptor). +z is the hang-direction arrow, i.e. the TOP of the plate,
// so the outer pair sits toward it and the centre cell below — the standard bucky pattern.
// L and R are named from the receptor as the arrow orients it: with the arrow at the top,
// the left-hand cell is L. Swapping these swaps both the overlay and the chamber the
// physics integrates, so the two can never disagree.
const AEC_CELLS={ l:{x:7.5,z:4.5}, c:{x:0,z:-4.5}, r:{x:-7.5,z:4.5} };
const AEC_W=5, AEC_L=6.5;                                                // chamber size (cm): x × z
const AEC_MIN_MAS=0.2;                                                   // minimum response (~2 ms at 100 mA)
function aecActive(){ return S.aecOn && (S.aecCells.l||S.aecCells.c||S.aecCells.r); }
function anyAecCell(){ return !!(S.aecCells.l||S.aecCells.c||S.aecCells.r); }

/* ---- AEC state: ONE invariant, ONE writer ---------------------------------
   "AEC on" and "at least one chamber selected" are the same state, so the UI never lets
   them come apart: switching AEC on selects the centre chamber, and clearing the last
   chamber switches AEC off. Previously the toggle and the cell buttons each poked at the
   state and at their own bits of the panel, which is exactly how they drifted into the
   meaningless on-with-no-chamber combination. Everything now goes through these three. */
function applyAecUI(){
  const on=S.aecOn, b=$('aecBtn');
  if(b){ b.classList.toggle('on',on); b.textContent=on?'ON':'OFF'; b.setAttribute('aria-pressed',on); }
  const box=$('aecCellsBox');
  if(box){
    box.style.display=on?'flex':'none';
    box.querySelectorAll('button[data-cell]').forEach(cb=>
      cb.classList.toggle('on', on && !!S.aecCells[cb.dataset.cell]));
  }
  const ml=$('masLbl'); if(ml) ml.textContent=on?'Backup mAs':'mAs';
  S.aecResult=null; resetPrep(); refreshReadouts(); syncScene();
}
function setAecOn(on){
  if(on===S.aecOn) return;
  S.aecOn=on;
  if(on){
    // AEC on always means a chamber is metering. Centre is the safe default: it is the
    // one cell that lies under the anatomy for nearly every projection.
    S.aecCells={l:false, c:true, r:false};
    // hold the manual mAs aside and raise the backup, restoring it when AEC goes off
    S._masPreAec=S.mas;
    if(S.mas<200){ S.mas=320; $('mas').value=nearestMasIdx(); }
  } else if(S._masPreAec!=null){ S.mas=S._masPreAec; $('mas').value=nearestMasIdx(); }
  applyAecUI();
}
function toggleAecCell(k){
  S.aecCells[k]=!S.aecCells[k];
  if(!anyAecCell()){ setAecOn(false); return; }   // clearing the last chamber IS AEC off
  applyAecUI();
}
/* AEC on with no chamber to meter: nothing for the generator to terminate on. The UI can
   no longer produce this (see setAecOn / toggleAecCell — AEC on and at least one chamber
   are the same state), so this is a backstop for any future path that sets AEC directly,
   such as a protocol preset. It is worth keeping: the failure it prevents is not a visible
   error but a silent full-manual exposure at the backup mAs, dressed up as an AEC one. */
function aecNoCell(){ return S.aecOn && !anyAecCell(); }
/* Mean receptor dose over the selected chambers (all pixels — a collimated-off chamber
   reads ~0 and correctly drives the exposure to the backup limit). */
function aecCellDose(dose,nx,ny,pxU,pxV){
  const halfU=(nx-1)/2, halfV=(ny-1)/2; let sum=0,n=0;
  for(const k of ['l','c','r']){
    if(!S.aecCells[k]) continue; const c=AEC_CELLS[k];
    const i0=Math.max(0,Math.round((c.x-AEC_W/2)/pxU+halfU)), i1=Math.min(nx-1,Math.round((c.x+AEC_W/2)/pxU+halfU));
    const j0=Math.max(0,Math.round((c.z-AEC_L/2)/pxV+halfV)), j1=Math.min(ny-1,Math.round((c.z+AEC_L/2)/pxV+halfV));
    for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){ sum+=dose[j*nx+i]; n++; }
  }
  return n? sum/n : 0;
}
const maSteps=[25,50,100,150,200,250,300,400,500,630,800];
function exposureTimeSec(){ return S.mas / S.ma; }              // t = mAs / mA
function fmtTime(t){ return t<1 ? Math.round(t*1000)+' ms' : t.toFixed(t<10?2:1)+' s'; }


const $=id=>document.getElementById(id);

/* pose -> external rotation of the hand about its long (z) axis.
   Negative rotation lifts the radial (thumb) side, i.e. external rotation. */
function poseRot(){ return 0; }   // retained for compatibility; object rotation now lives in S.objRot

/* Object rotate/tilt: world rotation matrix (row-major 3x3) from the S.objRot euler
   angles (degrees). Applied to BOTH the traced phantom + the 3D display so the two agree. */
function objMat(){ const r=S.objRot, d=Math.PI/180; return eulerMatrix(r.x*d, r.y*d, r.z*d); }
function isObjRotated(){ const r=S.objRot; return r.x||r.y||r.z; }
function applyMat3(R,p){ return [R[0]*p[0]+R[1]*p[1]+R[2]*p[2], R[3]*p[0]+R[4]*p[1]+R[5]*p[2], R[6]*p[0]+R[7]*p[1]+R[8]*p[2]]; }
function setGroupRot(grp,R){ const m=new THREE.Matrix4();
  m.set(R[0],R[1],R[2],0, R[3],R[4],R[5],0, R[6],R[7],R[8],0, 0,0,0,1); grp.setRotationFromMatrix(m); }

/* Build the world-space physics phantom: the selected voxel model, placed at the CT
   patient offset / x-ray object offset so the traced volume and the 3D scene agree. */
// Anatomical axis flips for the voxel chest (volume axes: x=Left, y=Posterior,
// z=Superior). World: x lateral, y up, z couch/long. CT = supine head-first (anterior
// up, head toward −z into the bore). X-ray = AP supine (anterior up toward the tube,
// posterior on the detector): flipping x AND y is a 180° roll about the long axis —
// a true rotation (chirality preserved), the patient turned over on the plate.
function voxelFlips(){
  const f = S.mode==='ct' ? [false,true,true] : [true,true,false];
  // the head & neck volume is stored rolled 180° vs the other models (it came out prone
  // where the rest are supine) — roll it back: flip x AND y = 180° about the long axis
  if(S.subject==='headneck'){ f[0]=!f[0]; f[1]=!f[1]; }
  return f;
}
function buildPhantom(){
  // Return a VoxelPhantom centred at the CT patient offset (couch position / table
  // height) or the x-ray object offset, so scout + recon sweep the real anatomy.
  // Uses the expanded BodyMaterials via its labelled volume.
  const R=objMat();
  const vm=S.voxelModel;
  if(!vm) return new Phantom();          // nothing loaded yet (first frames during boot)
  const cx = S.mode==='ct' ? S.ct.patient.x : S.objOff.x;
  // x-ray: the object rests on the receptor plus the height offset — which is where OID
  // comes from. Lifting it moves the anatomy toward the source: real magnification and
  // real geometric unsharpness, because the divergent rays do the rest.
  const cy = S.mode==='ct' ? S.ct.patientY : (vm.extentMM[1]/2)/10 + S.objOff.y;
  const cz = S.mode==='ct' ? S.ct.patient.z : S.objOff.z;
  const ph = vm.makePhantom([cx,cy,cz], voxelFlips(), R);
  applyContrast(ph);
  applyBarium(ph);
  return ph;
}



/* ---- barium / fluoroscopy panel --------------------------------------------------------
   The study is LIVE (core/giSolve.js): the clock advances the solver and the pose is read
   from the same rotate/tilt sliders that position the patient for the image. Turning them
   mid-study changes gravity from that moment, which is the whole examination.

   The clock runs faster than real time by default. A barium meal takes half an hour to reach
   the caecum and nobody watches that at 1x; the rate selector is part of the instrument, not
   a debug affordance. */
const GI_SEG_ORDER = [48, 49, 50, 51, 52];

function giPose(){
  return { rotX:S.objRot.x, rotY:S.objRot.y, rotZ:S.objRot.z, erect:S.barium.erect };
}
function giPoseLabel(){
  const r = S.objRot, bits = [S.barium.erect ? 'Erect' : 'Recumbent'];
  if(r.x) bits.push(`tilt ${r.x}\u00b0`);
  if(r.y) bits.push(`rot ${r.y}\u00b0`);
  if(r.z) bits.push(`roll ${r.z}\u00b0`);
  // Name the classic positions, because that is what they are called on the request card.
  // +z is superior and +x is the patient's right (liver at high x, spleen at low x), so a
  // positive roll about z swings the right side anteriorly \u2014 the patient ends up on their
  // LEFT. The decubitus is named for the side that is DOWN.
  const named = (!r.x && !r.y && Math.abs(r.z)===90) ? (r.z>0 ? ' \u2014 left lateral decubitus'
                                                             : ' \u2014 right lateral decubitus')
              : (!r.y && !r.z && Math.abs(r.x)===180) ? ' \u2014 prone' : '';
  return bits.join(' \u00b7 ') + named;
}
function giClock(){ return S.barium.study ? S.barium.study.t : 0; }
function giFmt(t){
  const m = Math.floor(t/60), s2 = Math.floor(t%60);
  return String(m).padStart(2,'0')+':'+String(s2).padStart(2,'0');
}

/* Start (or restart) the study from t=0 with the current administration and pose. */
function giBegin(){
  const B = S.barium, vm = S.voxelModel;
  if(!vm || !vm.hasGI){ B.error = `${S.subject} has no GI transport data`; return false; }
  if(!B.gi){ B.error = 'GI geometry not loaded'; return false; }
  try{
    B.study = new GIStudy(B.gi, {
      route:B.route, volumeMl:B.volumeMl, concMgBaMl:B.concPct*5.88, overS:B.route==='rectal'?120:5,
      pose:giPose(),
      // effervescent granules fizz out in seconds; an insufflator takes a minute of squeezing
      gasMl:B.gasMl, gasOverS:B.route==='rectal'?60:10,
    });
    B.error = null; B.lut = null; B.lutT = null; B.gasLut = null;
    B.timeline = B.study.sample();
    return true;
  }catch(err){ B.error = err.message; B.study = null; return false; }
}

/* Advance the study and refresh what the renderer sees. Called on a timer while running. */
function giTick(){
  const B = S.barium;
  if(!B.study || !B.running) return;
  const now = performance.now();
  const wall = Math.min((now - (B.lastTick || now)) / 1000, 0.5);   // cap after a tab stall
  B.lastTick = now;
  // The solver steps in 0.5 s quanta and advance() rounds — so at 1x a 100 ms tick asked
  // for 0.1 s, rounded to zero steps, and the clock never moved: 1x behaved as a pause.
  // Bank the un-stepped remainder instead; advance() returns what it actually consumed.
  B.acc = (B.acc || 0) + wall * B.speed;
  B.acc -= B.study.advance(B.acc);
  B.timeline = B.study.sample();
  B.lut = null; B.lutT = null;
  giRender();
  refreshFilmViewer?.();
}

function giSetPose(){
  const B = S.barium;
  if(B.study) B.study.setPose(giPose());
  const el = $('giPose'); if(el) el.textContent = giPoseLabel();
}

function giBars(){
  const cv = $('giBars'); if(!cv) return;
  const g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.fillStyle = '#05070a'; g.fillRect(0,0,W,H);
  const B = S.barium, st = B.study;
  const pad = {l:74, r:8, t:6, b:6}, rows = GI_SEG_ORDER.length;
  const bh = (H - pad.t - pad.b) / rows;
  g.font = '9px monospace';
  // scale to the administered concentration, so a full lumen is a full bar
  const cmax = Math.max(B.concPct * 5.88, 1);
  for(let i=0;i<rows;i++){
    const vid = GI_SEG_ORDER[i], y = pad.t + i*bh;
    const name = (GI_SEGMENTS[vid] || {}).name || String(vid);
    g.fillStyle = '#7f8c99';
    g.fillText(name.slice(0,11), 4, y + bh*0.62);
    let lum = 0, wal = 0, gas = 0;
    if(st && st.tubes[vid]){
      const c = st.tubes[vid].c, w = st.wall[vid], q = st.gas[vid];
      for(let j=0;j<c.length;j++){ lum += c[j]; wal += w[j]; gas += q[j]; }
      lum /= c.length; wal /= w.length; gas /= q.length;
    }
    const bw = W - pad.l - pad.r;
    g.fillStyle = '#1a2028'; g.fillRect(pad.l, y+3, bw, bh-8);
    // Gas first, as the space it has taken: it is drawn from the right because it is what
    // the barium no longer has, and it reads as the lucency it will be on the film.
    if(gas > 0){
      const gw = Math.min(1, gas) * bw;
      g.fillStyle = 'rgba(70,110,150,.30)'; g.fillRect(pad.l+bw-gw, y+3, gw, bh-8);
    }
    // lumen in amber, mucosal coat stacked on it in a paler tone — the coat is what a
    // double-contrast film shows once the lumen has emptied, so it must stay visible
    const lw = Math.min(1, lum/cmax) * bw;
    g.fillStyle = '#e0a83c'; g.fillRect(pad.l, y+3, lw, bh-8);
    const ww = Math.min(1, wal/12) * bw * 0.35;
    g.fillStyle = 'rgba(240,220,170,.55)'; g.fillRect(pad.l+lw, y+3, ww, bh-8);
  }
}

function giRender(){
  const B = S.barium;
  const el = (id)=>$(id);
  if(el('giElapsed')) el('giElapsed').textContent = giFmt(giClock());
  const go = el('giGo');
  if(go){ go.textContent = B.running ? '\u25a0' : '\u25b6'; go.classList.toggle('running', !!B.running); }
  if(el('giPhase')){
    const t = giClock();
    el('giPhase').textContent = !B.study ? 'not started'
      : B.running ? (t<15 ? 'swallowing' : t<300 ? 'gastric' : t<1800 ? 'small bowel' : 'colon')
      : 'paused';
  }
  if(el('giPose')) el('giPose').textContent = giPoseLabel();
  if(el('giAudit') && B.study){
    const a = B.study.audit();
    el('giAudit').textContent = `${(a.given/1000).toFixed(1)} g given \u00b7 `
      + `${(a.lumen/1000).toFixed(1)} g in the lumen \u00b7 ${(a.mucosa/1000).toFixed(1)} g coating`
      + (a.gasGiven > 0 ? ` \u00b7 ${a.gasHeld.toFixed(0)} mL gas` : '')
      + (Math.abs(a.errPct) > 0.5 ? `  (mass ${a.errPct.toFixed(1)} %)` : '');
  }
  if(el('giStatus')){
    el('giStatus').textContent = B.error ? B.error
      : !B.on ? 'Barium off.'
      : !B.study ? 'Ready. Press \u25b6 to give the agent and start the clock.'
      : B.running ? 'Running. Turn the patient and the barium follows.'
      : 'Paused. Expose whenever the anatomy is filled.';
  }
  giBars();
}

async function giApply(){
  const B = S.barium, panel = $('giPanel');
  if(!panel) return;
  const vm = S.voxelModel;
  const blocked = !vm || !vm.hasGI;
  panel.classList.toggle('blocked', blocked);
  const tab = $('giTab');
  if(tab){
    tab.disabled = blocked;
    tab.title = blocked ? `${S.subject} has no GI transport data — build_gi has not been run for it`
                        : 'Barium studies';
  }
  if(blocked){ B.on = false; B.running = false; panel.classList.remove('open'); }
  syncFlyouts();
  const pow = $('giOn');
  if(pow){ pow.textContent = B.on ? 'ON' : 'OFF'; pow.classList.toggle('on', !!B.on); }
  if(B.on && vm && vm.hasGI){
    try{
      if(!B.gi) B.gi = await vm.loadGI();
      // The solver works in arclength; the tracer works in voxels. Without this map the
      // study runs perfectly and reaches no image at all, which is a silent kind of wrong.
      if(!B.giVol || B.giVolFor !== S.subject){
        B.giVol = buildGIVolume(vm.data, await vm.loadGIArc());
        B.giVolFor = S.subject;
      }
    }catch(err){ B.error = 'Could not load the GI geometry: '+err.message; }
  }
  giRender();
}

function initGIPanel(){
  if(!$('giPanel')) return;
  const B = S.barium;
  $('giTab').addEventListener('click', ()=>{
    if($('giTab').disabled) return;
    $('giPanel').classList.toggle('open');
    syncFlyouts();
  });
  $('giOn').addEventListener('click', async ()=>{
    B.on = !B.on;
    if(!B.on){ B.running = false; B.study = null; B.timeline = null; B.lut = null; }
    await giApply(); syncScene();
  });
  $('giGo').addEventListener('click', ()=>{
    if(!B.on) return;
    if(!B.study && !giBegin()){ giRender(); return; }
    B.running = !B.running;
    B.lastTick = performance.now(); B.acc = 0;
    giRender();
  });
  $('giReset').addEventListener('click', ()=>{
    B.running = false; B.study = null; B.timeline = null; B.lut = null; B.lutT = null;
    B.acc = 0;
    giRender(); syncScene();
  });
  document.querySelectorAll('#giSpeedSeg button').forEach(b=>{
    b.addEventListener('click', ()=>{
      B.speed = +b.dataset.sp;
      document.querySelectorAll('#giSpeedSeg button').forEach(x=>x.classList.toggle('on', x===b));
    });
  });
  document.querySelectorAll('#giRouteSeg button').forEach(b=>{
    b.addEventListener('click', ()=>{
      B.route = b.dataset.route;
      document.querySelectorAll('#giRouteSeg button').forEach(x=>x.classList.toggle('on', x===b));
      // a change of route is a different examination, so the study restarts
      B.study = null; B.running = false;
      $('giVol').value = B.volumeMl = (B.route==='rectal' ? 800 : 150);
      $('giVolV').textContent = B.volumeMl+' mL';
      if(B.gasMl) giSetGas(giGasDefault());
      giRender();
    });
  });
  document.querySelectorAll('#giGasSeg button').forEach(b=>{
    b.addEventListener('click', ()=>{
      document.querySelectorAll('#giGasSeg button').forEach(x=>x.classList.toggle('on', x===b));
      giSetGas(b.dataset.gas === '1' ? giGasDefault() : 0);
      B.study = null; B.running = false;     // a different technique is a different study
      giRender();
    });
  });
  $('giGas').addEventListener('input', e=>{
    giSetGas(+e.target.value);
    if(B.study){ B.study = null; B.running = false; }
    giRender();
  });
  document.querySelectorAll('#giStandSeg button').forEach(b=>{
    b.addEventListener('click', ()=>{
      B.erect = b.dataset.erect === '1';
      document.querySelectorAll('#giStandSeg button').forEach(x=>x.classList.toggle('on', x===b));
      giSetPose(); giRender();
    });
  });
  $('giVol').addEventListener('input', e=>{
    B.volumeMl = +e.target.value; $('giVolV').textContent = B.volumeMl+' mL';
    if(B.study){ B.study = null; B.running = false; }      // dose changed: start again
    giRender();
  });
  $('giConc').addEventListener('input', e=>{
    B.concPct = +e.target.value; $('giConcV').textContent = B.concPct+' % w/v';
    $('giAdmNote').textContent = `${(B.concPct*5.88).toFixed(0)} mg Ba/mL \u00b7 `
      + `${(B.volumeMl*B.concPct*5.88/1000).toFixed(0)} g of barium`;
    if(B.study){ B.study = null; B.running = false; }
    giRender();
  });
  $('giConc').dispatchEvent(new Event('input'));
  giSetGas(0);
  // one timer for the whole study; it does nothing while paused
  setInterval(giTick, 100);
  giApply();
}

/* The lumen the gas has to work with. The segmentation caught this subject's gut at REST, so
   it is smaller than the distended bowel a real double-contrast study inflates — the 400 mL
   of CO2 effervescent granules make would simply fill it. The default is therefore taken
   from the geometry rather than from the packet, and the slider still reaches over-distension
   if you want to see what that looks like. */
function giGasTarget(){
  const B = S.barium, seg = B.route==='rectal' ? 52 : 49;
  const ml = B.gi && B.gi.segments && B.gi.segments[seg] ? B.gi.segments[seg].volumeML : 0;
  return { seg, ml };
}
function giGasDefault(){
  const t = giGasTarget();
  if(!t.ml) return B_GAS_FALLBACK;
  return Math.max(50, Math.round(t.ml * 0.45 / 50) * 50);
}
const B_GAS_FALLBACK = 400;

/* Gas volume in mL. 0 is a single-contrast study, which disables the slider rather than
   leaving it live at a value that does nothing. */
function giSetGas(ml){
  const B = S.barium;
  B.gasMl = Math.max(0, ml|0);
  const on = B.gasMl > 0;
  if(on) $('giGas').value = B.gasMl;
  $('giGas').disabled = !on;
  $('giGasV').textContent = on ? B.gasMl+' mL' : '—';
  document.querySelectorAll('#giGasSeg button').forEach(x=>
    x.classList.toggle('on', (x.dataset.gas === '1') === on));
  const note = $('giGasNote');
  if(note && on){
    const t = giGasTarget(), name = (GI_SEGMENTS[t.seg]||{}).name || 'the lumen';
    const fill = t.ml ? Math.min(100, B.gasMl/t.ml*100) : 0;
    note.innerHTML = `Gas goes into the <b>${name.toLowerCase()}</b>, which this subject's CT `
      + `segmented at <b>${t.ml.toFixed(0)} mL</b> — a lumen at rest, not the distended one a `
      + `real study inflates. ${B.gasMl} mL fills <b>${fill.toFixed(0)} %</b> of it`
      + (fill > 92 ? `, so it is over-distended: the barium is pushed out ahead of it and what `
                   + `is left is a coat.` : `, so the barium is driven off the non-dependent `
                   + `wall and left there as a coat. Turn the patient and both move.`);
  } else if(note){
    note.innerHTML = 'Single contrast: the lumen fills, and you read its outline. Double '
      + 'contrast adds gas — effervescent granules on a swallow, an insufflator on an enema — '
      + 'which pushes the barium off the non-dependent wall and leaves it coated. You then '
      + 'read the <b>surface</b>, which is where mucosal disease lives.';
  }
}

/* ---- contrast ------------------------------------------------------------------------
   The solver's output lives on the vascular graph, so turning it into something the
   ray-caster can use is two lookups: which arclength bin each voxel sits at (per model,
   built once) and the concentration at each bin for THIS acquisition time (per image). */
function contrastLUT(){
  const C=S.contrast;
  if(!C.on || !C.timeline) return null;
  // Nothing is enhanced until the injector has actually run. Before START the patient has
  // no contrast in them, and the images should say so.
  if(C.run.t0==null && C.run.latched==null) return null;
  if(C.lut && C.lutT===C.scanTime) return C.lut;      // one table per acquisition time
  C.lut=buildConcLUT(C.timeline, C.scanTime); C.lutT=C.scanTime;
  return C.lut;
}
function applyContrast(ph){
  const C=S.contrast, lut=contrastLUT();
  if(lut && C.sVol) ph.setContrast(lut, C.sVol, CONTRAST_NS);
  else ph.setContrast(null, null, CONTRAST_NS);
}
function bariumLUT(){
  const B=S.barium;
  if(!B.on || !B.timeline) return null;
  // A live study's sample() is a one-frame timeline, so the lookup time is its own clock.
  const t = B.study ? B.study.t : B.studyTime;
  if(B.lut && B.lutT===t) return B.lut;
  B.lut=buildBariumLUT(B.timeline, t);
  B.gasLut=buildGasLUT(B.timeline, t);      // null unless gas was given
  B.lutT=t;
  return B.lut;
}
function applyBarium(ph){
  const B=S.barium, lut=bariumLUT();
  if(lut && B.giVol) ph.setBarium(lut, B.giVol, GI_NS, B.gasLut);
  else ph.setBarium(null, null, GI_NS, null);
}
/* Load the barium field for the current subject. Unlike contrast there is no live solve in
   the browser: a GI study runs for half an hour of simulated time, so it is always the
   shipped timeline. The pose it was solved for is fixed with it — see the note in
   gi_solver.py on why turning the patient is the examination. */
async function bariumLoad(){
  const B=S.barium, vm=S.voxelModel;
  B.error=null;
  if(!vm || !vm.hasGI){
    B.error=`${S.subject} has no GI transport data — run build_gi for this model`;
    B.timeline=null; return false;
  }
  if(!vm.hasPresetBarium){
    B.error=`${S.subject} ships no barium timeline — run gi_export for this model`;
    B.timeline=null; return false;
  }
  B.busy=true;
  try{
    const [json, giarc]=await Promise.all([vm.loadPresetBarium(), vm.loadGIArc()]);
    B.timeline=decodeGITimeline(json);
    B.static=true;
    if(!B.giVol || B.giVolFor!==S.subject){ B.giVol=buildGIVolume(vm.data, giarc); B.giVolFor=S.subject; }
    B.lut=null; B.lutT=null;
    return true;
  }catch(err){
    B.error='Could not load the barium timeline: '+err.message;
    B.timeline=null; return false;
  }finally{ B.busy=false; }
}
/* Solve for the current injector settings. The solve is ~1.2 s on the backend and the
   result is ~0.45 MB, so it is re-run on any injector change rather than cached as presets. */
async function contrastSolve(){
  const C=S.contrast, vm=S.voxelModel;
  C.error=null;
  if(!vm || !vm.hasVessels){
    C.error=`${S.subject} has no vessel data — run build_vessels for this model`;
    C.timeline=null; return false;
  }
  // No service: fall back to the timeline shipped with the model. The solver is Python-only,
  // but a SOLVED timeline is just data — the whole timing exercise (start the injector, judge
  // the moment, scan) is client-side and works exactly the same. Only reprogramming the
  // injector needs the service, so those controls get locked rather than the feature removed.
  if(!S.computeInfo){
    if(!vm.hasPresetContrast){
      C.error='Python compute service unreachable, and this model ships no preset timeline.';
      C.timeline=null; return false;
    }
    C.busy=true;
    try{
      const [json, arclen]=await Promise.all([
        vm.loadPresetContrast(C.params.site), vm.loadArclen()]);
      C.timeline=decodeTimeline(json);
      C.static=true;
      if(json.preset) Object.assign(C.params, json.preset);   // show what it was solved for
      if(!C.sVol || C.sVolFor!==S.subject){ C.sVol=buildSVolume(vm.data, arclen); C.sVolFor=S.subject; }
      C.lut=null; C.lutT=null;
      return true;
    }catch(err){
      C.error='Could not load the preset timeline: '+err.message;
      C.timeline=null; return false;
    }finally{ C.busy=false; }
  }
  C.static=false;
  C.busy=true;
  try{
    const [json, arclen]=await Promise.all([
      compute.contrastTimeline({ model:S.subject, ...C.params }),
      vm.loadArclen(),
    ]);
    C.timeline=decodeTimeline(json);
    if(!C.sVol || C.sVolFor!==S.subject){ C.sVol=buildSVolume(vm.data, arclen); C.sVolFor=S.subject; }
    C.lut=null; C.lutT=null;
    return true;
  }catch(err){
    // A dropped connection surfaces as the browser's bare "Failed to fetch", which tells the
    // user nothing and does not name the thing to restart. It also means the health poll's
    // view is stale — up to 5 s out of date — so mark the service down immediately rather
    // than leaving the panel enabled and inviting a second identical failure.
    const gone = (err instanceof TypeError) || /failed to fetch|networkerror|load failed/i.test(err.message||'');
    if(gone){
      S.computeInfo=null;
      C.error='Lost the Python compute service mid-solve. Restart it, then press ON again.';
    } else {
      C.error=err.message;
    }
    C.timeline=null;
    if($('ctrstPanel')) ctrstApply(true);      // re-grey the tab now, not at the next poll
    return false;
  }finally{ C.busy=false; }
}
// Drive contrast before the panel exists (Phase 3). Also the hook the tests use.
window.radsimContrast={
  state:()=>S.contrast,
  async enable(params){
    Object.assign(S.contrast.params, params||{});
    S.contrast.on=true;
    const ok=await contrastSolve();
    if(!ok) S.contrast.on=false;
    return ok ? S.contrast.timeline : S.contrast.error;
  },
  disable(){ S.contrast.on=false; S.contrast.lut=null; },
  setScanTime(t){ S.contrast.scanTime=t; },
  // Acquisition timing for the currently selected scan group — a helical scan images each
  // slice at its own moment, which is the whole point of per-slice timing.
  ctTiming(){
    const g=(S.ct.groups||[])[S.ct.sel||0]; if(!g) return null;
    const lo=S.ct.scanStart, hi=lo+S.ct.scanLen, n=12;
    const pos=Array.from({length:n},(_,i)=>lo+(hi-lo)*i/(n-1));
    return { mmPerSec:+couchSpeedMMps(g).toFixed(1), lenMM:+(hi-lo).toFixed(0),
             pitch:g.pitch, beamCollMM:g.beamColl, rotS:g.rotSpeed,
             t:pos.map((_,i)=>+sliceTime(g,pos,i,S.contrast.scanTime).toFixed(2)) };
  },
};

/* Update 3D transforms to match state (tube position, hand pose, collimator light). */
function syncScene(){
  if(!three.tube) return;
  // The voxel model is placed by ctSyncScene in CT mode; in x-ray it rests on the receptor.
  const ox=S.mode!=='ct'?S.objOff.x:0, oz=S.mode!=='ct'?S.objOff.z:0;   // x-ray object offset sliders
  three.handGroup.rotation.z = 0;
  if(three.chestGroup) applyVoxelMeshTransform(three.chestGroup);       // flips are mode-dependent
  if(S.mode!=='ct' && S.voxelModel){                // x-ray: rest the model on the detector + lift
    three.handGroup.position.set(ox, (S.voxelModel.extentMM[1]/2)/10 + S.objOff.y, oz);
  }

  // tube position + aim along the true central ray (isocentric: CR -> centering point)
  const src=sourcePos();
  const aim=[S.tubeX,0,S.tubeZ];
  three.tube.position.set(src[0],src[1],src[2]);
  three.tube.lookAt(new THREE.Vector3(...aim)); three.tube.rotateX(Math.PI/2);
  three.tube.rotateY(-Math.PI/2);  // square the housing with the light field it projects (field W along x, L along z)
  updateCollimatorLCD();           // live LCD strip: filter / field size / status / SID
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
  // AEC chamber overlay: x-ray mode + AEC on; selected cells fill, others outline only
  if(three.aecGroup){
    three.aecGroup.visible = S.mode!=='ct' && S.aecOn;
    for(const k of ['l','c','r']){
      const m=three.aecCellMeshes[k]; if(!m) continue;
      const on=!!S.aecCells[k];
      m.fill.material.opacity = on?0.20:0.03;
      m.edge.material.opacity = on?0.95:0.35;
      m.lbl.material.opacity  = on?0.95:0.4;
    }
  }
  ctSyncScene();                                // CT mode overrides scene visibility (bed/laser vs detector/light)
  editorSyncScene();                            // editor mode hides both rigs and shows the voxel preview
  fluoroSyncScene();                            // fluoro hides the x-ray head and shows the C-arm
  // object rotate/tilt (applies last, in both modes): rotate the visible object about
  // its centre to match the traced phantom. A voxel mesh is centred at its own origin
  // so it rotates in place inside handGroup.
  const R=objMat();
  if(three.chestGroup) setGroupRot(three.chestGroup, R);
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
  // Crosshair wires, spanning the aperture with a small central gap. Grey, not black: a real
  // wire casts a soft shadow inside a bright field, and a fully opaque one reads as a stripe
  // painted across the anatomy rather than as a centring aid.
  g.strokeStyle='rgba(0,0,0,0.45)'; g.lineWidth=Math.max(2, SZ*0.004);
  const gap=Math.min(w,h)*0.12;
  g.beginPath();
  g.moveTo(cx, cy-h); g.lineTo(cx, cy-gap); g.moveTo(cx, cy+gap); g.lineTo(cx, cy+h);
  g.moveTo(cx-w, cy); g.lineTo(cx-gap, cy); g.moveTo(cx+gap, cy); g.lineTo(cx+w, cy);
  g.stroke();
  t.cookieTex.needsUpdate=true;
}

/* ---- X-RAY COLLIMATOR HEAD ------------------------------------------------
   The tube head modeled as a real manual collimator (reference photos): beige
   box, dark tube-port cone + white dome on top, vented top plate, printed
   front panel (groove, blue LCD bezel with white tick marks, red/blue
   crosshatch knob scales, tape-measure badge), a LIVE LCD strip, the round
   key row (light / M / − / +), the square lamp key between the twin grey
   field-size knobs, on a grey base with corner feet.
   Local frame: origin = focal spot, −y = beam direction, +z = front panel. */
function collRBox(THREE,w,h,d,r,bev){
  bev=bev===undefined?0.5:bev;
  const s=new THREE.Shape(), x=w/2, y=h/2;
  s.moveTo(-x+r,-y); s.lineTo(x-r,-y); s.absarc(x-r,-y+r,r,-Math.PI/2,0,false);
  s.lineTo(x,y-r); s.absarc(x-r,y-r,r,0,Math.PI/2,false);
  s.lineTo(-x+r,y); s.absarc(-x+r,y-r,r,Math.PI/2,Math.PI,false);
  s.lineTo(-x,-y+r); s.absarc(-x+r,-y+r,r,Math.PI,Math.PI*1.5,false);
  const g=new THREE.ExtrudeGeometry(s,{depth:Math.max(0.1,d-2*bev),bevelEnabled:true,
    bevelThickness:bev,bevelSize:bev,bevelSegments:5,curveSegments:24});
  g.translate(0,0,-(d-2*bev)/2); g.computeVertexNormals(); return g;
}
function collGlyphTex(THREE,draw){
  const sz=128, cv=document.createElement('canvas'); cv.width=cv.height=sz;
  const g=cv.getContext('2d'); g.clearRect(0,0,sz,sz); draw(g,sz);
  const t=new THREE.CanvasTexture(cv); t.anisotropy=4; return t;
}
/* Printed front panel: everything flat lives in ONE hi-res texture (14.6×9.8
   units at 70 px/unit); knobs, keys and the live LCD glass are 3D on top. */
function makeCollPanelTex(THREE){
  const W=1024,H=688,k=70,cx=W/2, cv=document.createElement('canvas'); cv.width=W; cv.height=H;
  const g=cv.getContext('2d');
  const py=(d)=>(d-5.1)*k;                       // d = distance below the focal spot (panel top at 5.1)
  const rr=(x,y,w,h,r)=>{ g.beginPath(); g.moveTo(x+r,y); g.arcTo(x+w,y,x+w,y+h,r);
    g.arcTo(x+w,y+h,x,y+h,r); g.arcTo(x,y+h,x,y,r); g.arcTo(x,y,x+w,y,r); g.closePath(); };
  g.fillStyle='#eae6da'; g.fillRect(0,0,W,H);
  g.strokeStyle='#d2cdbd'; g.lineWidth=3; g.strokeRect(10,10,W-20,H-20);    // panel groove
  // deep-blue LCD bezel; the glass area is dark (the live LCD plane sits over it)
  const bw=12.7*k, bh=2.9*k, by=py(7.2)-bh/2;
  rr(cx-bw/2,by,bw,bh,14); g.fillStyle='#203d80'; g.fill();
  rr(cx-bw/2+18,by+16,bw-36,bh-32,8); g.fillStyle='#101d2b'; g.fill();
  // white marks printed on the bezel: centring triangle, tick pairs, patient icon
  g.strokeStyle='#e8ecf2'; g.lineWidth=3;
  g.beginPath(); g.moveTo(cx-8,by+13); g.lineTo(cx+8,by+13); g.lineTo(cx,by+3); g.closePath(); g.stroke();
  [-250,250].forEach(dx=>{ g.beginPath(); g.moveTo(cx+dx-5,by+4); g.lineTo(cx+dx-5,by+13);
    g.moveTo(cx+dx+5,by+4); g.lineTo(cx+dx+5,by+13); g.stroke(); });
  g.beginPath(); g.arc(cx+bw/2-28,by+8,4,0,Math.PI*2); g.moveTo(cx+bw/2-28,by+12); g.lineTo(cx+bw/2-28,by+16); g.stroke();
  // printed glyphs beside the key row (field-length / field-width marks)
  g.strokeStyle='#3c3b34'; g.lineWidth=4;
  const ky=py(9.5);
  g.beginPath(); for(let i=-1;i<=1;i++){ g.moveTo(cx-3.2*k-16,ky+i*9); g.lineTo(cx-3.2*k+16,ky+i*9); } g.stroke();
  g.beginPath(); for(let i=-1;i<=1;i++){ g.moveTo(cx+1.0*k+i*9,ky-14); g.lineTo(cx+1.0*k+i*9,ky+14); } g.stroke();
  // red / blue crosshatch scale marks flanking the knobs (ref)
  const hash=(x,y,col)=>{ g.strokeStyle=col; g.lineWidth=5; g.save(); g.translate(x,y); g.rotate(0.32);
    g.beginPath(); g.moveTo(-8,-20); g.lineTo(-8,20); g.moveTo(8,-20); g.lineTo(8,20);
    g.moveTo(-20,-7); g.lineTo(20,-7); g.moveTo(-20,7); g.lineTo(20,7); g.stroke(); g.restore(); };
  const kn=py(12.7);
  hash(cx-6.1*k,kn,'#a8322c'); hash(cx-1.65*k,kn,'#a8322c');
  hash(cx+1.65*k,kn,'#2f4f9e'); hash(cx+6.1*k,kn,'#2f4f9e');
  // tape-measure badge at the bottom lip
  g.fillStyle='#efece1'; g.strokeStyle='#8a877c'; g.lineWidth=3;
  g.beginPath(); g.ellipse(cx,py(14.55),80,26,0,0,Math.PI*2); g.fill(); g.stroke();
  g.fillStyle='#4a473e'; g.font='bold 24px Arial'; g.textAlign='center'; g.fillText('0 cm',cx+22,py(14.55)+8);
  g.strokeStyle='#4a473e'; g.strokeRect(cx-52,py(14.55)-11,30,22);
  g.beginPath(); g.moveTo(cx-22,py(14.55)); g.lineTo(cx-8,py(14.55)); g.stroke();
  const t=new THREE.CanvasTexture(cv); t.anisotropy=8; return t;
}
function buildCollimatorHead(THREE,tube){
  // the tube group's lookAt+rotateX puts the BEAM along local +y — build in a shell
  // flipped π about x so the model's "down toward the patient" (−y here) matches it
  const shell=new THREE.Group(); shell.rotation.x=Math.PI; tube.add(shell); tube=shell;
  const std=(c,r,m)=>new THREE.MeshStandardMaterial({color:c,roughness:r===undefined?0.55:r,metalness:m===undefined?0.06:m});
  // tube-port dome + dark cone dropping into the box top (refs 1–3)
  const dome=new THREE.Mesh(new THREE.SphereGeometry(3.1,40,24), std(0xe9e7e0,0.5));
  dome.scale.set(1,0.72,1); dome.position.set(0,0.5,0); tube.add(dome);
  const cone=new THREE.Mesh(new THREE.CylinderGeometry(1.9,3.7,4.4,56), std(0x2f3438,0.4,0.3));
  cone.position.set(0,-2.3,0); tube.add(cone);
  const collar=new THREE.Mesh(new THREE.TorusGeometry(4.05,0.3,14,64), std(0xd8d4c8,0.5));
  collar.rotation.x=Math.PI/2; collar.position.set(0,-4.35,0); tube.add(collar);
  const bracket=new THREE.Mesh(new THREE.BoxGeometry(1.7,1.1,1.1), std(0x8e9296,0.45,0.2));
  bracket.position.set(0,-3.95,-3.1); tube.add(bracket);       // −z here = the FRONT after the shell flip
  // main beige housing (rounded vertical edges + bevelled top/bottom)
  const body=new THREE.Mesh(collRBox(THREE,16,11,13,0.9,0.6), std(0xe7e3d6,0.6));
  body.position.set(0,-10,0); tube.add(body);
  // vent slat groups on the top plate + small sensor screw
  [-4.6,4.6].forEach(sx=>{ for(let i=0;i<5;i++){
    const slat=new THREE.Mesh(new THREE.BoxGeometry(3.4,0.1,0.34), std(0x4c4f52,0.5));
    slat.position.set(sx,-4.42,-(2.6+i*0.62)); tube.add(slat);  // front half of the top plate
  }});
  const screw=new THREE.Mesh(new THREE.CylinderGeometry(0.13,0.13,0.12,16), std(0x3a3d40,0.4,0.3));
  screw.position.set(2.3,-4.42,-1.6); tube.add(screw);
  // printed front panel + live LCD glass
  const panel=new THREE.Mesh(new THREE.PlaneGeometry(14.6,9.8),
    new THREE.MeshStandardMaterial({map:makeCollPanelTex(THREE),roughness:0.75,metalness:0.02}));
  panel.position.set(0,-10,6.55); tube.add(panel);
  const cv=document.createElement('canvas'); cv.width=640; cv.height=120;
  const tex=new THREE.CanvasTexture(cv); tex.anisotropy=8;
  const glass=new THREE.Mesh(new THREE.PlaneGeometry(12.2,2.2),
    new THREE.MeshStandardMaterial({map:tex,emissive:0xffffff,emissiveMap:tex,emissiveIntensity:0.55,roughness:0.35}));
  glass.position.set(0,-7.2,6.6); tube.add(glass);
  // round key row: collimator light, Memory, − , +
  const mkBtn=(x,drawIcon)=>{
    const b=new THREE.Mesh(new THREE.CylinderGeometry(0.62,0.66,0.55,36), std(0xb9bbb7,0.4));
    b.rotation.x=Math.PI/2; b.position.set(x,-9.5,6.85); tube.add(b);
    const ic=new THREE.Mesh(new THREE.PlaneGeometry(0.9,0.9),
      new THREE.MeshBasicMaterial({map:collGlyphTex(THREE,drawIcon),transparent:true}));
    ic.position.set(x,-9.5,7.14); tube.add(ic);
  };
  const txtGlyph=(t,f)=>(g,s)=>{ g.fillStyle='#33322c'; g.font=f||'bold 84px Arial'; g.textAlign='center'; g.fillText(t,s/2,s/2+30); };
  mkBtn(-4.9,(g,s)=>{ g.strokeStyle='#33322c'; g.lineWidth=8; g.beginPath();
    g.moveTo(s/2,18); g.lineTo(s/2,s-40); g.moveTo(s/2-16,s-58); g.lineTo(s/2,s-38); g.lineTo(s/2+16,s-58);
    g.moveTo(24,s-18); g.lineTo(s-24,s-18); g.stroke(); });
  mkBtn(-1.5,txtGlyph('M'));
  mkBtn(2.7,txtGlyph('−','bold 96px Arial'));
  mkBtn(4.5,txtGlyph('+','bold 96px Arial'));
  // square lamp key between the knobs (light-field icon: square + diagonals)
  const lb=new THREE.Mesh(collRBox(THREE,1.9,1.9,0.6,0.32,0.14), std(0xb9bbb7,0.4));
  lb.position.set(0,-12.7,6.85); tube.add(lb);
  const li=new THREE.Mesh(new THREE.PlaneGeometry(1.2,1.2),
    new THREE.MeshBasicMaterial({map:collGlyphTex(THREE,(g,s)=>{ g.strokeStyle='#33322c'; g.lineWidth=7;
      g.strokeRect(28,28,s-56,s-56); g.beginPath(); g.moveTo(28,28); g.lineTo(s-28,s-28);
      g.moveTo(s-28,28); g.lineTo(28,s-28); g.stroke(); }),transparent:true}));
  li.position.set(0,-12.7,7.22); tube.add(li);
  // twin field-size knobs with knurled rim + white pointer tab (refs)
  [-3.6,3.6].forEach(x=>{
    const knb=new THREE.Mesh(new THREE.CylinderGeometry(1.62,1.75,1.3,48), std(0xb4b6b4,0.38));
    knb.rotation.x=Math.PI/2; knb.position.set(x,-12.7,7.2); tube.add(knb);
    const grip=new THREE.Mesh(new THREE.TorusGeometry(1.45,0.16,12,48), std(0xa9aba9,0.42));
    grip.position.set(x,-12.7,7.86); tube.add(grip);
    const tab=new THREE.Mesh(collRBox(THREE,0.5,0.75,0.5,0.12,0.08), std(0xf1f0ea,0.35));
    tab.position.set(x,-14.42,7.45); tube.add(tab);
  });
  // grey base plinth, corner feet, and the dark beam-exit aperture underneath
  const plinth=new THREE.Mesh(collRBox(THREE,16.4,13.4,1.2,0.6,0.3), std(0x9ba0a4,0.5,0.15));
  plinth.rotation.x=-Math.PI/2; plinth.position.set(0,-16.1,0); tube.add(plinth);
  [[-6.9,-5.7],[6.9,-5.7],[-6.9,5.7],[6.9,5.7]].forEach(([fx,fz])=>{
    const foot=new THREE.Mesh(new THREE.BoxGeometry(1.6,0.7,1.6), std(0x6f7377,0.5,0.2));
    foot.position.set(fx,-17.0,fz); tube.add(foot);
  });
  const apert=new THREE.Mesh(new THREE.BoxGeometry(4.6,0.1,4.2), std(0x14181c,0.3,0.4));
  apert.position.set(0,-16.75,0); tube.add(apert);
  return {cv,tex,last:''};
}
/* Redraw the collimator's live LCD when its values change: filter, light-field
   size (the collimation sliders), mode/status, and the actual SID. */
function updateCollimatorLCD(){
  const L=three.collLCD; if(!L) return;
  const fx=(S.collX||0).toFixed(1), fz=(S.collZ||0).toFixed(1), sid=Math.round(S.sid||100);
  const k=fx+'x'+fz+'@'+sid; if(k===L.last) return; L.last=k;
  const g=L.cv.getContext('2d'), W=L.cv.width, H=L.cv.height;
  const grad=g.createLinearGradient(0,0,0,H); grad.addColorStop(0,'#b6c6c9'); grad.addColorStop(1,'#9fb1b5');
  g.fillStyle=grad; g.fillRect(0,0,W,H);
  g.fillStyle='#8ea1a6'; g.fillRect(W*0.27,6,3,H-12); g.fillRect(W*0.73,6,3,H-12);
  g.fillStyle='#233238'; g.textAlign='center';
  g.font='bold 30px "Courier New", monospace'; g.fillText('0 mm Cu',W*0.135,H*0.62);
  g.font='24px "Courier New", monospace'; g.fillText('Manual',W*0.5,H*0.36);
  g.font='bold 30px "Courier New", monospace'; g.fillText(fx+' cm x '+fz+' cm',W*0.5,H*0.78);
  g.font='24px "Courier New", monospace'; g.fillText('Ready',W*0.865,H*0.36);
  g.font='bold 30px "Courier New", monospace'; g.fillText(sid+' cm',W*0.865,H*0.78);
  L.tex.needsUpdate=true;
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
  const xrayImg=(img && S.hasImage && !scouts);
  $('bigFilm').style.display=xrayImg?'block':'none';
  $('bignote').style.display=(img && !S.hasImage && !scouts)?'flex':'none';
  $('view').style.visibility=(img||slices||recons)?'hidden':'visible';
  const ui=$('imgViewUI'); if(ui) ui.classList.toggle('show', xrayImg);   // meta + history strip (image view only)
  if(xrayImg){ renderRadiograph($('bigFilm')); updateImageMeta(); renderImageStrip(); }
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
  // object rotate / tilt (generic, any subject) — updates chip, phantom + 3D
  const rotAxes=[['objRotX','x'],['objRotY','y'],['objRotZ','z']];
  for(const [id,ax] of rotAxes){
    $(id)?.addEventListener('input',e=>{ S.objRot[ax]=parseInt(e.target.value);
      $(id+'v').textContent=S.objRot[ax]+'°'; resetPrep(); syncScene();
      giSetPose?.(); });
  }
  // x-ray object offset sliders (cm on the receptor: z long axis / x cross axis)
  const offAxes=[['objOffX','x'],['objOffZ','z'],['objOffY','y']];
  for(const [id,ax] of offAxes){
    $(id)?.addEventListener('input',e=>{ S.objOff[ax]=parseFloat(e.target.value);
      $(id+'v').textContent=S.objOff[ax]+' cm'; resetPrep(); syncScene();
      // the height offset IS the OID — the readout in Tube & distance follows it
      if(ax==='y'){ S.oid=S.objOff.y; const o=$('oidV'); if(o) o.textContent=S.oid+' cm'; }
    });
  }
  $('objRotReset')?.addEventListener('click',()=>{ S.objRot={x:0,y:0,z:0}; S.objOff={x:0,z:0,y:0};
    for(const [id,ax] of rotAxes){ $(id).value=0; $(id+'v').textContent='0°'; }
    for(const [id,ax] of offAxes){ if($(id)){ $(id).value=0; $(id+'v').textContent='0 cm'; } }
    S.oid=0; const o=$('oidV'); if(o) o.textContent='0 cm';
    resetPrep(); syncScene(); });
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
      if(kind==='kv'){ S.kv=Math.max(40,Math.min(120,S.kv+d)); $('kv').value=S.kv; }
      if(kind==='mas'){ let i=nearestMasIdx(); i=Math.max(0,Math.min(masSteps.length-1,i+d)); S.mas=masSteps[i]; $('mas').value=i; }
      if(kind==='ma'){ let i=nearestMaIdx(); i=Math.max(0,Math.min(maSteps.length-1,i+d)); S.ma=maSteps[i]; $('ma').value=i; }
      refreshReadouts();
    });
  });
  $('kv').addEventListener('input',e=>{S.kv=parseInt(e.target.value);refreshReadouts();});
  $('ma').addEventListener('input',e=>{S.ma=maSteps[e.target.value];refreshReadouts();});
  $('mas').addEventListener('input',e=>{S.mas=masSteps[e.target.value];refreshReadouts();});
  // ---- AEC: toggle + chamber selection. Enabling swaps the mAs control to the BACKUP
  // limit (bumped to a sensible safety value); disabling restores the manual mAs.
  initCurveBar();
  $('aecBtn')?.addEventListener('click',()=>setAecOn(!S.aecOn));
  $('aecCellsBox')?.addEventListener('click',e=>{
    const b=e.target.closest('button[data-cell]'); if(!b) return;
    toggleAecCell(b.dataset.cell);
  });
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
  document.addEventListener('keydown',e=>{ if(e.code!=='Space')return;
    if(S.mode==='fluoro')return;             // fluoro owns Space: it is the pedal, never the rotor
    e.preventDefault();
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
  // LUT/response-curve visibility (does NOT change the LUT shape — image is unaffected)
  $('curveToggle')?.addEventListener('change',e=>{ S.showCurve=e.target.checked;
    updateXrayHistogram(); ctRenderViewer?.(); });
  // automatic rescaling (DR auto-ranging) — normalizes the VOI to the display range
  $('rescaleToggle')?.addEventListener('change',e=>{ S.autoRescale=e.target.checked;
    if(S.hasImage) drawFilm(); else updateXrayHistogram(); });
  // DR detail (edge) enhancement — multiscale unsharp on the acquired image
  $('detailToggle')?.addEventListener('change',e=>{ S.detailEnh=e.target.checked;
    S._proc=null; if(S.hasImage) drawFilm(); });
  // APR protocol picker
  $('protocolBtn')?.addEventListener('click',openProtocolPopup);
  $('protoPopClose')?.addEventListener('click',closeProtocolPopup);
  $('protoPop')?.addEventListener('click',e=>{ if(e.target.id==='protoPop') closeProtocolPopup(); });
  $('protoPopBody')?.addEventListener('click',e=>{ const b=e.target.closest('.proto-proj'); if(!b) return;
    const p=findProtocol(b.dataset.part,b.dataset.proj); if(p){ applyProtocol(p,b.dataset.part); closeProtocolPopup(); } });
  document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeProtocolPopup(); });
  // bay options (top-right): independent dropdowns (View Options, Sound Options).
  const bayCtl=$('bayCtl');
  const closeDrops=()=>document.querySelectorAll('#bayCtl .baydrop.open').forEach(d=>{
    d.classList.remove('open'); d.querySelector('.baymenu-btn')?.setAttribute('aria-expanded','false'); });
  document.querySelectorAll('#bayCtl .baymenu-btn').forEach(btn=>{
    btn.addEventListener('click',e=>{ e.stopPropagation();
      const drop=btn.closest('.baydrop'), willOpen=!drop.classList.contains('open');
      closeDrops();
      if(willOpen){ drop.classList.add('open'); btn.setAttribute('aria-expanded','true'); } });
  });
  if(bayCtl){
    document.addEventListener('click',e=>{ if(!bayCtl.contains(e.target)) closeDrops(); });
    document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeDrops(); });
  }
  // CT scan-sound picker (Sound Options): select the scan-exposure sound + preview it
  $('scanSoundSeg')?.addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b)return;
    S.ct.scanSound=b.dataset.snd;
    [...$('scanSoundSeg').children].forEach(x=>x.classList.toggle('on',x.dataset.snd===S.ct.scanSound)); });
  $('scanSoundPrev')?.addEventListener('click',e=>{ e.stopPropagation(); Sound.resume(); Sound.preview(S.ct.scanSound); });
  // bay content: 3D positioning  <->  large saved image
  $('contentSeg').addEventListener('click',e=>{const b=e.target.closest('button'); if(!b || b.disabled)return; setContent(b.dataset.c);});
  // camera: free orbit  <->  tube POV bird's-eye (x-ray)
  $('camSeg').addEventListener('click',e=>{const b=e.target.closest('button'); if(!b)return; setCameraView(b.dataset.cam);});
  // CT camera: AP-PoV  <->  Lat-PoV
  $('camSegCt')?.addEventListener('click',e=>{const b=e.target.closest('button'); if(!b)return; setCTPov(b.dataset.cam);});
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
  // photo skin vs material shading — display only, never touches the physics
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
  // image history: scroll the wheel over the Image view (or its strip) to step through
  // the last 10 exposures; arrow keys work too when the image view is up.
  const histWheel=(e)=>{ if(S.bayContent!=='image'||S.mode==='ct'||S.imgHistory.length<2) return;
    e.preventDefault(); setActiveImage(S.histIdx + (e.deltaY>0?1:-1)); };
  $('bigFilm')?.addEventListener('wheel',histWheel,{passive:false});
  $('imgStrip')?.addEventListener('wheel',histWheel,{passive:false});
  document.addEventListener('keydown',e=>{
    if(S.bayContent!=='image'||S.mode==='ct'||S.imgHistory.length<2) return;
    if(e.key==='ArrowLeft'){ e.preventDefault(); setActiveImage(S.histIdx-1); }
    else if(e.key==='ArrowRight'){ e.preventDefault(); setActiveImage(S.histIdx+1); }
  });
}
function nearestMasIdx(){ let bi=0,bd=1e9; masSteps.forEach((v,i)=>{const d=Math.abs(v-S.mas); if(d<bd){bd=d;bi=i;}}); return bi; }
function nearestMaIdx(){ let bi=0,bd=1e9; maSteps.forEach((v,i)=>{const d=Math.abs(v-S.ma); if(d<bd){bd=d;bi=i;}}); return bi; }
function refreshReadouts(){
  $('kvV').textContent=S.kv; $('kvSv').textContent=S.kv;
  $('maV').textContent=S.ma; $('maSv').textContent=S.ma;
  $('masV').textContent=S.mas.toFixed(S.mas<10?1:0); $('masSv').textContent=S.mas.toFixed(S.mas<10?1:0);
  $('fsV').innerHTML=(S.ma>400?'1.0':'0.6')+'<small>mm</small>';
  if(aecNoCell()){   // say so BEFORE the switch is pressed, not after
    $('timeV').innerHTML='AEC'; $('timeInline').textContent='AEC · NO CELL SELECTED';
  }
  else if(aecActive()){ $('timeV').innerHTML='AEC'; $('timeInline').textContent='AEC · backup '+fmtTime(exposureTimeSec()); }
  else{
    const t=exposureTimeSec();
    $('timeV').innerHTML = t<1 ? Math.round(t*1000)+'<small>ms</small>' : t.toFixed(t<10?2:1)+'<small>s</small>';
    $('timeInline').textContent=fmtTime(t);
  }
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
  // Interlock BEFORE anything is delivered: no rotor sound, no timer, no image. The tube
  // never fires, so this is not a terminated exposure — it is an exposure that never
  // happened, and the fault screen says which.
  if(aecNoCell()){
    S.prepped=false; $('rotor').classList.remove('on');
    $('fire').disabled=true; $('fire').classList.remove('armed');
    setWarn('standby'); $('clock').textContent='EXPOSURE INHIBITED';
    showExposureError(['NO AEC CHAMBER SELECTED'],
                      'SELECT L, C OR R - OR SWITCH AEC OFF', 'EXPOSURE', 'INHIBITED');
    return;
  }
  // Freeze the contrast clock at the instant the tube fires: the image belongs to the delay
  // the operator actually achieved, not to wherever the clock has drifted by the time the
  // projection finishes computing.
  ctrstLatch();
  S.exposing=true; EXP.done=false; EXP.holding=true;
  // AEC terminates the exposure itself — the operator just holds through it (ms-scale);
  // manual technique requires holding the switch for the full set exposure time.
  EXP.dur=Math.max(0.02, aecActive()? 0.05 : exposureTimeSec())*1000;   // ms the switch must be held
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
    computeRadiograph().then(()=>{ S.exposing=false; $('clock').textContent=''; });
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
        // contrast: 48 KB of table, not a 40 MB field — the backend builds the per-voxel
        // arclength itself from the same arclen.bin the browser reads
        concLUT: phantom.concLUT ? Array.from(phantom.concLUT) : null,
        iodineCol: phantom.concLUT ? BodyMaterials.IODINE_COL : null,
        I0, refDist:100,
        coneD:fd, coneW:wAxis, coneL:lAxis, coneTw:tw, coneTl:tl,
        rot: phantom.rot ? Array.from(phantom.rot) : null,
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

  // ---- scatter radiation reaching the detector ----
  // X-rays scattered in the patient add a diffuse fog to the receptor. The scatter-to-
  // primary ratio (SPR) grows with the irradiated field area and the patient's
  // attenuation — a large, thick body part (chest, abdomen) scatters a lot — and an
  // anti-scatter grid strips most of it out (its whole purpose). Without scatter, a
  // primary-only model reads big/thick body parts as underexposed. Scatter is generated
  // in the patient BEFORE the grid, so compute it from the pre-grid primary, then let
  // the grid attenuate it below.
  const _t=(typeof window!=='undefined'&&window.__tune)||{};
  // Physically-scaled scatter: SCAT_SPR_MAX ≈ max scatter-to-primary ratio for a big,
  // thick field (no grid); SCAT_AREA0 = field half-saturation area (cm²); GRID_SCATTER =
  // fraction of scatter a grid still passes (~15%). Kept modest so it adds realistic
  // veiling glare (lowering contrast for large no-grid fields — the reason grids exist)
  // WITHOUT washing the image out.
  // SCAT_SPR_MAX is calibrated against the quantity that can actually be checked: the
  // RESIDUAL scatter-to-primary ratio at the detector after the grid, which for a gridded PA
  // chest is ~0.2-0.5. Measured in the lung field: 4.0 -> 0.54 (top of band, lung/mediastinum
  // 2.45), 2.0 -> 0.27 (mid band, 3.53), 1.5 -> 0.20 (3.53 -> 4.11). 2.0 it is. Setting it by
  // the contrast ratio instead would mean pushing residual SPR below anything defensible.
  const SCAT_SPR_MAX=_t.spr??2.0, SCAT_AREA0=_t.area??900, GRID_SCATTER=_t.gridScat??0.15;
  let scatterFog=0;
  {
    const distC=Math.hypot(source[0],source[1],source[2])||100, invSqC=(100*100)/(distC*distC);
    // Reference the fog to the primary that actually passed THROUGH the patient, not to the
    // whole field. Scatter is produced in tissue, so raw beam around the anatomy contributes
    // none of it — yet averaging it in inflates meanP and therefore the fog. With an open
    // collimator that put the mediastinum at 92 % scatter and collapsed lung/mediastinum
    // contrast to 1.9x against a real 5-15x. Same error as the EI VOI: a field-wide mean that
    // silently includes direct exposure.
    let maxP=0; for(let k=0;k<dose.length;k++) if(mask[k] && dose[k]>maxP) maxP=dose[k];
    const attenCut=maxP*0.90;                       // above this the ray missed the patient
    let sumP=0, nF=0; for(let k=0;k<dose.length;k++){ if(mask[k] && dose[k]<attenCut){ sumP+=dose[k]; nF++; } }
    if(nF){
      const meanP=sumP/nF, meanIncident=I0*invSqC;
      const atten=Math.max(0,Math.min(1,1-meanP/(meanIncident||1)));     // 0 = air, ~1 = heavily attenuated
      const areaCm2=S.collX*S.collZ, areaF=areaCm2/(areaCm2+SCAT_AREA0);  // saturates with field size
      let spr=SCAT_SPR_MAX*areaF*atten;
      if(S.gridOn) spr*=GRID_SCATTER;                                      // grid removes most scatter
      scatterFog=spr*meanP;                                                // diffuse fog, added uniformly below
    }
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
  // add the diffuse scatter fog (already grid-attenuated) onto the primary
  if(scatterFog>0) for(let k=0;k<dose.length;k++) if(mask[k]) dose[k]+=scatterFog;

  // ---- AEC: the chambers integrate receptor-plane kerma DURING the exposure and cut it
  // when the average over the selected cells reaches the calibrated target (the same
  // receptor-dose calibration the EI uses: EI = EI_K × dose, so target = EI_target/EI_K. The
  // constant is imported rather than repeated — a local 900 here would silently stop matching
  // the detector's if that were ever tuned, and the AEC would aim at the wrong dose.)
  // Everything upstream is linear in mAs, so the projection computed at the BACKUP mAs is
  // simply rescaled to the terminated mAs — noise is applied after, at the true exposure.
  // If the target is never reached (cells behind dense anatomy / collimated off), the
  // exposure runs to the backup limit — exactly how a real backup timer trips.
  S.aecResult=null;
  if(aecActive()){
    const cd=aecCellDose(dose,nx,ny,pxU,pxV);       // mean chamber dose at backup mAs
    // Chamber target, not VOI target — see AEC_CHAMBER_CAL. Metering the mediastinum at a
    // lung-level dose is what made every AEC exposure read ~3x hot.
    const target=S.eiTarget/EI_K/AEC_CHAMBER_CAL;
    const backup=S.mas;
    const ideal = cd>1e-12 ? backup*target/cd : Infinity;
    const masA=Math.max(AEC_MIN_MAS, Math.min(backup, ideal));
    const f=masA/backup;
    if(f<1) for(let k=0;k<dose.length;k++) dose[k]*=f;
    S.aecResult={mas:masA, backupHit: ideal>=backup};
  }

  const {signal,EI}=Detector.capture(dose,nx,ny,photonScale,mask);
  pushImage(signal,nx,ny,mask,buildMeta(spectrum));   // -> active image + drawFilm + meta + strip
  updateDI(EI);
  if(S.bayContent==='image') setContent('image');

  $('prog').style.width='100%';
  setTimeout(()=>{$('prog').style.width='0%';},400);
}

/* Early-release error: replace the image with an error message. */
function showExposureError(why, hint, l1, l2){
  S.hasImage=false;
  $('noexp').style.display='none';
  const draw=cv=>drawError(cv, why, hint, l1, l2);
  draw($('film'));
  if(S.bayContent==='image'){ $('bigFilm').style.display='block'; $('bignote').style.display='none'; draw($('bigFilm')); }
  $('eiV').textContent='—';  $('eiV').className='v';
  $('eitV').textContent='—'; $('diV').textContent='ERR'; $('diV').className='v bad';
  ['fnTL','fnTR','fnBL','fnBR'].forEach(id=>$(id).textContent='');
  $('prog').style.width='0%';
}
function drawError(cv,
                   why=['EXPOSURE SWITCH RELEASED', 'BEFORE EXPOSURE COMPLETE'],
                   hint='RE-ENGAGE ROTOR AND REPEAT',
                   l1='EXPOSURE', l2='TERMINATED'){
  cv.width=400; cv.height=500;
  const c=cv.getContext('2d');
  c.fillStyle='#000'; c.fillRect(0,0,cv.width,cv.height);
  c.textAlign='center';
  c.fillStyle='#ff3b30'; c.font='bold 30px "Share Tech Mono",monospace';
  c.fillText(l1, cv.width/2, 210);
  c.fillText(l2, cv.width/2, 248);
  c.fillStyle='#ff8a80'; c.font='14px "Share Tech Mono",monospace';
  why.forEach((s,i)=>c.fillText(s, cv.width/2, 296+i*22));
  c.fillStyle='#8a96a3'; c.font='12px "Share Tech Mono",monospace';
  c.fillText(hint, cv.width/2, 296+why.length*22+16);
}

/* ---- render stored signal: crop to exposed field, window/level, invert,
        then apply rotation + flips. Renders to any target canvas. ---- */
function computeCrop(nx,ny,mask){
  let i0=nx,i1=-1,j0=ny,j1=-1;
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
    if(mask[j*nx+i]){ if(i<i0)i0=i; if(i>i1)i1=i; if(j<j0)j0=j; if(j>j1)j1=j; }
  }
  if(i1<i0){ i0=0;i1=nx-1;j0=0;j1=ny-1; }   // fallback: whole detector
  return {i0,i1,j0,j1};
}
/* Render a radiograph to `target`. With no `entry` it draws the active image (S.last*);
   pass a history entry to render that one (used for the review-strip thumbnails). */
function renderRadiograph(target,entry){
  const sig = entry? entry.sig : S.lastSignal;
  const nx  = entry? entry.nx  : S.nx;
  const ny  = entry? entry.ny  : S.ny;
  const mask= entry? entry.mask: S.mask;
  const subject = entry? entry.subject : S.activeSubject;
  const rescale = entry? entry.rescale : S.rescale;   // auto-rescale VOI window for this image
  if(!sig||!target) return;
  const {i0,i1,j0,j1}=computeCrop(nx,ny,mask);
  const cw=i1-i0+1, ch=j1-j0+1;
  // open-field normalization for log display
  let mx=0; for(let k=0;k<sig.length;k++) if(mask[k]&&sig[k]>mx) mx=sig[k]; mx=mx||1;
  const a=40, denom=Math.log(1+a);
  // DR detail enhancement: use the cached enhanced base-tone map for the active full-res
  // image; thumbnails (entry passed) render the plain log tone (cheap, detail not needed).
  const _t=(typeof window!=='undefined'&&window.__tune)||{};
  const enhOn=(_t.eOn!==undefined)?_t.eOn:S.detailEnh;
  const baseArr=(enhOn && !entry)? activeProcessed(sig,nx,ny,mask,mx) : null;
  // build cropped, windowed bitmap
  const crop=document.createElement('canvas'); crop.width=cw; crop.height=ch;
  const cctx=crop.getContext('2d'); const img=cctx.createImageData(cw,ch);
  for(let j=0;j<ch;j++)for(let i=0;i<cw;i++){
    const k=(j0+j)*nx+(i0+i);
    let v;
    if(!mask[k]) v=0;
    else { const base=baseArr? baseArr[k] : 1-Math.log(1+a*sig[k]/mx)/denom;
      v=displayTone(base, rescale); }   // (enhanced) base -> auto-rescale -> levels -> LUT
    const g=Math.round(v*255), o=(j*cw+i)*4;
    img.data[o]=img.data[o+1]=img.data[o+2]=g; img.data[o+3]=255;
  }
  cctx.putImageData(img,0,0);
  // orient (rotate + flip) into the target, sizing target to the exposed crop.
  // Hanging default for every voxel subject, applied before the user's adjustments:
  // the superior end (fingertips on the hand) is world +z, which the raw detector
  // mapping lands at the image BOTTOM, so flip vertically to hang it superior-up;
  // mirror horizontally too because a PA projection is displayed as if facing the patient.
  const baseRot = 0, baseFlipH = true, baseFlipV = true;
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

/* ---- automatic rescaling (digital-radiography auto-ranging) ----
   Real DR analyses the image histogram, finds the anatomy's values-of-interest (VOI)
   and rescales those to a standard display range, so the image looks optimally exposed
   regardless of over/under-exposure (the exposure index still reports the true dose).
   Here: robust 1st–99th percentile window of the exposed-field base tones. */
function computeRescale(sig,mask){
  const _t=(typeof window!=='undefined'&&window.__tune)||{};
  let mx=0; for(let k=0;k<sig.length;k++) if(mask[k]&&sig[k]>mx) mx=sig[k]; mx=mx||1;
  // EXCLUDE the directly-exposed raw beam from the VOI window. The unattenuated beam sits
  // at the dark end of the tone scale; if it is left in, its pixels pin the window's low
  // end and the whole anatomy is crammed into a bright, flat band (washed-out chest). By
  // dropping pixels brighter than `cut`, the window locks onto the anatomy so the well-
  // penetrated lung fields stretch to dark and the mediastinum/spine to bright.
  // The cut must sit JUST below the unattenuated level, which by definition is the image
  // maximum — nothing attenuates less than nothing. A loose fraction (this was 0.72) also
  // discards genuinely thin anatomy: at 55 kVp a few mm of soft tissue still transmits
  // ~80-90 % of the raw beam, so a hand's whole finger envelope was being treated as
  // direct exposure and clipped to white, leaving the phalanges looking like bare bone.
  const cut=mx*(_t.rcut??0.95);
  const a=40, denom=Math.log(1+a), NB=1024, hist=new Uint32Array(NB); let total=0;
  for(let k=0;k<sig.length;k++){ if(!mask[k]||sig[k]>=cut) continue;   // skip direct exposure
    let t=Math.log(1+a*sig[k]/mx)/denom, b=Math.round((1-t)*(NB-1));
    hist[b<0?0:b>NB-1?NB-1:b]++; total++; }
  if(!total) return null;
  const pl=_t.rlo??0.05, ph=_t.rhi??0.01;   // clip darkest pl and brightest ph of the anatomy
  let lo=0, hi=NB-1, acc=0;
  for(let b=0;b<NB;b++){ acc+=hist[b]; if(acc>=total*pl){ lo=b; break; } }
  acc=0; for(let b=NB-1;b>=0;b--){ acc+=hist[b]; if(acc>=total*ph){ hi=b; break; } }
  return { lo: lo/(NB-1), hi: Math.max((lo+1)/(NB-1), hi/(NB-1)) };
}

/* ---- DR-style detail (edge) enhancement ------------------------------------
   Real digital-radiography processing (Fuji MUSICA, Agfa, GE UNIQUE …) applies a
   multi-frequency decomposition and boosts the mid-frequency structure band —
   bony edges, vessels, the vertebral endplates seen faintly through the heart —
   more than the fine quantum-mottle band, lifting low-contrast detail without
   amplifying noise as strongly. Here: a two-band multiscale unsharp mask on the
   log base tone. Split into fine (<r1), mid (r1..r2) and coarse (>r2) bands with
   masked box blurs, then recombine with per-band gains (mid boosted, fine gentle).
   Radii scale with the matrix so the effect is resolution-independent. Runs once
   per acquired image (cached on the signal ref), never per window/level change. */
function boxBlurMasked(src,mask,nx,ny,r){
  if(r<1) return src.slice();
  const tmp=new Float32Array(nx*ny), out=new Float32Array(nx*ny);
  for(let y=0;y<ny;y++){ const row=y*nx; let sum=0,cnt=0;
    for(let x=0;x<r&&x<nx;x++){ if(mask[row+x]){sum+=src[row+x];cnt++;} }
    for(let x=0;x<nx;x++){ const add=x+r; if(add<nx&&mask[row+add]){sum+=src[row+add];cnt++;}
      const rem=x-r-1; if(rem>=0&&mask[row+rem]){sum-=src[row+rem];cnt--;}
      tmp[row+x]= cnt? sum/cnt : src[row+x]; } }
  for(let x=0;x<nx;x++){ let sum=0,cnt=0;
    for(let y=0;y<r&&y<ny;y++){ const k=y*nx+x; if(mask[k]){sum+=tmp[k];cnt++;} }
    for(let y=0;y<ny;y++){ const add=y+r; if(add<ny&&mask[add*nx+x]){sum+=tmp[add*nx+x];cnt++;}
      const rem=y-r-1; if(rem>=0&&mask[rem*nx+x]){sum-=tmp[rem*nx+x];cnt--;}
      out[y*nx+x]= cnt? sum/cnt : tmp[y*nx+x]; } }
  return out;
}
function processImage(sig,nx,ny,mask,mx){
  const _t=(typeof window!=='undefined'&&window.__tune)||{};
  const a=40, denom=Math.log(1+a);
  const base=new Float32Array(nx*ny);
  for(let k=0;k<sig.length;k++) base[k]= mask[k]? 1-Math.log(1+a*sig[k]/mx)/denom : 0;
  const R=Math.max(nx,ny);
  const r1=Math.max(1,Math.round((_t.eR1??0.006)*R));
  const r2=Math.max(r1+1,Math.round((_t.eR2??0.030)*R));
  const gMid=_t.eGmid??2.4, gFine=_t.eGfine??0.5;
  const B1=boxBlurMasked(base,mask,nx,ny,r1);
  const B2=boxBlurMasked(base,mask,nx,ny,r2);
  const out=new Float32Array(nx*ny);
  for(let k=0;k<base.length;k++){ if(!mask[k]){ out[k]=0; continue; }
    const fine=base[k]-B1[k], mid=B1[k]-B2[k];
    out[k]=B2[k]+gMid*mid+gFine*fine; }
  return out;
}
/* Enhanced base-tone map for the active image, cached on the signal reference so
   window/level and view switches don't recompute the blurs. */
function activeProcessed(sig,nx,ny,mask,mx){
  if(!S._proc || S._proc.sig!==sig) S._proc={sig, data:processImage(sig,nx,ny,mask,mx)};
  return S._proc.data;
}
/* Apply auto-rescale (VOI stretch) to a base tone, using the given window. */
function rescaleTone(x,rs){
  if(!S.autoRescale || !rs) return x;
  let r=(x-rs.lo)/(rs.hi-rs.lo); return r<0?0:r>1?1:r;
}

/* ---- display look-up table (LUT) ----
   Map a (rescaled) display tone x∈[0,1] to output∈[0,1] via the current LUT: a DICOM
   SIGMOID VOI LUT (out = 1/(1+exp(-4(x-c)/w))) when the LUT is a sigmoid, else a linear
   window/level. Brightness shifts the centre, contrast scales the width. The LUT always
   applies (the toggle now only shows/hides the curve on the histogram). */
function toneMap(x, centre){
  const bright=S.lev/100, contrast=S.win/100;
  if(S.lut && S.lut.sigmoid){
    const c=(centre??S.lut.center) - bright, w=Math.max(0.05, S.lut.width/contrast);
    return 1/(1+Math.exp(-4*(x-c)/w));
  }
  const v=(x-0.5)*contrast+0.5+bright; return v<0?0:v>1?1:v;
}
/* ---- manual response-curve points (low / mid / high) ----
   The three diamonds under the histogram. Low and high are the input tones driven to
   black and to white; mid is the tone driven to 0.5, i.e. a gamma. This is the classic
   levels control, and it sits AFTER the auto-rescale on purpose: the rescale normalises
   every exposure to the same appearance, which is correct for DR but hides dose. Pulling
   the points by hand pins the mapping so two exposures can be compared as exposures. */
/* ---- the three diamonds under the histogram ----
   Not an <input type=range>: three thumbs on one track, each constrained by its
   neighbours (low < mid < high), which a native range cannot express. */
const CURVE_GAP=0.02;                                   // keep the points distinguishable
function syncCurveBar(){
  const bar=$('curveBar'); if(!bar) return;
  const c=S.curve||curveFromRescale(S.rescale);   // before the first image: the identity curve
  bar.querySelectorAll('.cb-h').forEach(h=>{ h.style.left=(c[h.dataset.pt]*100).toFixed(2)+'%'; });
  const f=$('cbFill'); if(f){ f.style.left=(c.lo*100).toFixed(2)+'%';
                              f.style.width=((c.hi-c.lo)*100).toFixed(2)+'%'; }
}
function setCurvePoint(pt,v){
  const c=S.curve||(S.curve=curveFromRescale(S.rescale));
  // Free over the whole histogram axis — the only limit is the ordering. Clamping these
  // to some "expected" sub-range would stop the toe and shoulder reaching the part of the
  // axis where the anatomy actually sits, which on a chest is the bottom fifth.
  v=Math.max(0,Math.min(1,v));
  if(pt==='lo') c.lo=Math.min(v, c.hi-CURVE_GAP);
  else          c.hi=Math.max(v, c.lo+CURVE_GAP);
  S.curveManual=true;                       // stop re-seeding: a pinned curve is the point
  syncCurveBar();
  if(S.hasImage) drawFilm();
}
/* Re-seed the handles onto the new image's own toe/inflection/shoulder — unless they have
   been dragged, in which case the pinned curve is deliberately being held across images so
   two exposures can be compared as exposures. */
function reseedCurve(){
  if(S.curveManual) return;
  S.curve=curveFromRescale(S.rescale);
  syncCurveBar();
}
function initCurveBar(){
  const bar=$('curveBar'); if(!bar) return;
  let drag=null;
  const xOf=e=>{ const r=bar.getBoundingClientRect(); return (e.clientX-r.left)/Math.max(1,r.width); };
  bar.addEventListener('pointerdown',e=>{
    const h=e.target.closest('.cb-h');
    // clicking the bare track grabs the nearest point, so the control is not fiddly
    const c=S.curve||(S.curve=curveFromRescale(S.rescale));
    const pt=h? h.dataset.pt : (Math.abs(c.lo-xOf(e))<=Math.abs(c.hi-xOf(e))?'lo':'hi');
    drag=bar.querySelector('.cb-h[data-pt="'+pt+'"]');
    drag.classList.add('drag');
    try{ bar.setPointerCapture(e.pointerId); }catch(_){}
    setCurvePoint(pt, xOf(e)); e.preventDefault();
  });
  bar.addEventListener('pointermove',e=>{ if(drag) setCurvePoint(drag.dataset.pt, xOf(e)); });
  const end=()=>{ if(drag) drag.classList.remove('drag'); drag=null; };
  bar.addEventListener('pointerup',end);
  bar.addEventListener('pointercancel',end);
  // double-click gives the image's own auto curve back, not an abstract 0/0.5/1
  bar.addEventListener('dblclick',()=>{ S.curveManual=false; reseedCurve();
                                        if(S.hasImage) drawFilm(); });
  syncCurveBar();
}

/* Where the auto-rescale + LUT put the three features for a given image. The handles are
   seeded from this, so they START on the toe, inflection and shoulder of the curve as
   drawn rather than at an abstract 0 / 0.5 / 1 that corresponds to nothing on screen. */
function curveFromRescale(rs){
  return { lo:(S.autoRescale && rs)? rs.lo : 0,
           hi:(S.autoRescale && rs)? rs.hi : 1 };
}
/* The one display mapping, in the histogram's own x units so the handles sit on the axis
   they are drawn against.

   The handles ARE the curve, rather than a second stage bolted after it: low and high are
   the window — below low everything is black, above high everything is white, so they are
   the toe and the shoulder by construction. Seeded from the auto-rescale, this reproduces
   the previous mapping exactly; dragging a handle moves the feature it sits on.

   There is deliberately no third handle for the inflection. It would set the sigmoid's
   centre, and toneMap already computes that centre as (centre - brightness) — so a mid
   handle and the Brightness slider write the same term, and the two would fight. */
function displayTone(x, rs){
  const c=S.curve||curveFromRescale(rs);
  const span=c.hi-c.lo;
  let t = span>1e-6 ? (x-c.lo)/span : (x<c.lo?0:1);
  return toneMap(t<0?0:t>1?1:t);
}
function displayCurve(x){ return displayTone(x, S.rescale); }

/* ---- display histogram + LUT response curve ----
   Draws a proper histogram (blue bars, axis ticks) of the image's base grey values,
   overlaid with the current LUT/response curve and a dashed identity diagonal so the
   sigmoid roll-off is visible. curveFn maps input tone [0,1] -> output [0,1]. */
export function drawHistogram(canvas, hist, curveFn, xlabels){
  if(!canvas) return;
  const g=canvas.getContext('2d'), W=canvas.width, H=canvas.height;
  const padL=3, padR=3, padT=4, padB=11, pw=W-padL-padR, ph=H-padT-padB;
  g.clearRect(0,0,W,H);
  g.fillStyle='#0a0f14'; g.fillRect(0,0,W,H);
  // faint gridlines (quarters)
  g.strokeStyle='rgba(120,150,175,.12)'; g.lineWidth=1;
  for(let q=1;q<4;q++){ const gx=padL+pw*q/4; g.beginPath(); g.moveTo(gx,padT); g.lineTo(gx,padT+ph); g.stroke(); }
  // histogram bars (blue), linear counts
  let hmax=1; for(const v of hist) if(v>hmax) hmax=v;
  const n=hist.length, bw=pw/n;
  g.fillStyle='#5b83d6';
  for(let x=0;x<n;x++){ const h=hist[x]/hmax*ph; if(h>0) g.fillRect(padL+x*bw, padT+ph-h, Math.max(1,bw), h); }
  // response curve + identity diagonal — visibility toggled (shape is unchanged)
  if(S.showCurve){
    g.strokeStyle='rgba(200,215,230,.35)'; g.setLineDash([3,3]); g.lineWidth=1;
    g.beginPath(); g.moveTo(padL,padT+ph); g.lineTo(padL+pw,padT); g.stroke(); g.setLineDash([]);
    g.strokeStyle='#ffcf6b'; g.lineWidth=1.8; g.beginPath();
    for(let x=0;x<=n;x++){ const out=Math.max(0,Math.min(1,curveFn(x/n)));
      const px=padL+x/n*pw, py=padT+ph-out*ph; if(x===0) g.moveTo(px,py); else g.lineTo(px,py); }
    g.stroke();
  }
  // axis baseline + x ticks (0 · mid · max) — 8-bit display scale
  g.strokeStyle='rgba(150,175,195,.5)'; g.lineWidth=1;
  g.beginPath(); g.moveTo(padL,padT+ph+0.5); g.lineTo(padL+pw,padT+ph+0.5); g.stroke();
  const lab=xlabels||['0','128','255'];
  g.fillStyle='rgba(150,175,195,.75)'; g.font='7px "Share Tech Mono",monospace'; g.textBaseline='top';
  g.textAlign='left';   g.fillText(lab[0], padL, padT+ph+2);
  g.textAlign='center'; g.fillText(lab[1], padL+pw/2, padT+ph+2);
  g.textAlign='right';  g.fillText(lab[2], padL+pw, padT+ph+2);
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
  drawHistogram(canvas, hist, displayCurve);   // curve = auto-rescale (VOI) then LUT
}

/* ---- APR protocol picker ---------------------------------------------------
   Protocols (data/protocols.json) set kVp/mAs (APR), the anti-scatter grid, the
   display LUT, and optionally the subject model for a projection. Grouped body
   part -> region -> projection in a popup. */
function setGridUI(){
  const v=$('gridStateV'); if(v) v.textContent=S.gridOn?'IN':'OUT';
  const seg=$('gridSeg'); if(seg)[...seg.children].forEach(b=>b.classList.toggle('on',(b.dataset.grid==='on')===S.gridOn));
}
function findProtocol(part,proj){
  const gr=protocolData.groups.find(g=>g.part===part); if(!gr) return null;
  for(const rg of gr.regions){ const p=rg.projections.find(x=>x.proj===proj); if(p) return p; }
  return null;
}
function setGridFocusUI(){
  const v=$('gridFocusV'); if(v) v.textContent=S.gridFocus+' cm';
  const seg=$('gridFocusSeg'); if(seg)[...seg.children].forEach(b=>b.classList.toggle('on',+b.dataset.focus===S.gridFocus));
}
function applyProtocol(p,part){
  S.protocol={proj:p.proj, part};
  S.kv=Math.max(40,Math.min(120,p.kv)); S.mas=p.mas;
  const kvEl=$('kv'); if(kvEl) kvEl.value=S.kv;
  const masEl=$('mas'); if(masEl) masEl.value=nearestMasIdx();
  S.gridOn=!!p.grid; setGridUI();
  S.lut=lutData.luts[p.lut]||lutData.luts.linear;
  // per-exam target EI (real APR): the deviation index is judged against the exam's own
  // target EiT, not a single number. Calibrated so a well-exposed exam reads DI≈0 with
  // the IEC 62494-1 scale (EI 100 = 1 µGy). A well-exposed PA chest at 120 kVp / 2.5 mAs /
  // grid / 180 cm reads ~300; higher-dose body/spine exams sit a little above that.
  const EI_REGION_TARGET={ 'Chest':300, 'Abdomen / Pelvis':350, 'Spine':350, 'Head':250 };
  S.eiTarget = p.targetEI ?? EI_REGION_TARGET[part] ?? 300;
  // SID + focused-grid focal length (a focused grid is used at its focal distance)
  if(p.sid){ S.sid=Math.max(20,Math.min(200,p.sid));
    const sv=$('sidV'); if(sv) sv.textContent=S.sid+' cm';
    const sr=$('sidRo'); if(sr) sr.innerHTML=S.sid+'<small>cm</small>';
    S.gridFocus=S.sid; setGridFocusUI(); }
  // receptor size + orientation FIRST (this re-caps the collimation sliders) …
  if(p.det) setDetSize(p.det[0], p.det[1]);
  if(p.orient) setDetOrient(p.orient);
  // … then the collimated field (clamped to the receptor)
  if(p.coll){ S.collX=Math.min(p.coll[0], S.detW); S.collZ=Math.min(p.coll[1], S.detH);
    const cx=$('collX'), cz=$('collZ'); if(cx) cx.value=S.collX; if(cz) cz.value=S.collZ; }
  updateGeomReadouts();
  const pv=$('protocolV'); if(pv) pv.textContent=p.proj;
  refreshReadouts();
  // switch the subject model when the protocol targets one we have
  if(p.subject && p.subject!==S.subject && VOXEL_MODELS[p.subject]) setSubject(p.subject);
  else { syncScene(); if(S.hasImage) drawFilm(); }
}
function openProtocolPopup(){
  const pop=$('protoPop'), body=$('protoPopBody'); if(!pop||!body) return;
  body.innerHTML=protocolData.groups.map(gr=>
    '<div class="proto-part">'+gr.part+'</div>'+
    gr.regions.map(rg=>
      '<div class="proto-region"><div class="proto-rname">'+rg.region+'</div><div class="proto-projs">'+
      rg.projections.map(p=>{ const cur=S.protocol&&S.protocol.part===gr.part&&S.protocol.proj===p.proj;
        return '<button class="proto-proj'+(cur?' on':'')+'" data-part="'+gr.part+'" data-proj="'+p.proj+'">'
          +p.proj+'<small>'+p.kv+' kVp · '+p.mas+' mAs'+(p.grid?' · grid':' · no grid')+'</small></button>'; }).join('')+
      '</div></div>').join('')
  ).join('');
  pop.classList.add('show');
}
function closeProtocolPopup(){ $('protoPop')?.classList.remove('show'); }

function updateDI(EI){
  // Post-exposure, an AEC console reports what it ACTUALLY delivered. Showing only the
  // backup mAs — which is all this did — makes every AEC exposure read as the same
  // technique no matter which chamber metered it, hiding the whole point of the exercise:
  // metering the mediastinum runs the tube several times longer than metering the lungs.
  if(S.aecResult){
    const m=S.aecResult.mas;
    $('masV').textContent = m.toFixed(m<10?2:0);
    const t=m/S.ma;
    $('timeV').innerHTML = t<1 ? Math.round(t*1000)+'<small>ms</small>' : t.toFixed(t<10?2:1)+'<small>s</small>';
    $('timeInline').textContent = 'AEC '+fmtTime(t)+(S.aecResult.backupHit?' · BACKUP':'');
  }
  const DI = 10*Math.log10(EI/S.eiTarget);
  $('eiV').textContent=EI;
  $('eitV').textContent=S.eiTarget;
  const diEl=$('diV'); diEl.textContent=(DI>=0?'+':'')+DI.toFixed(1);
  diEl.className='v '+(Math.abs(DI)<=1?'ok':Math.abs(DI)<=3?(DI>0?'hi':'lo'):'bad');
  $('eiV').className='v '+(Math.abs(DI)<=1?'ok':'');
}

/* Build the 4-corner image metadata for the CURRENT technique (shown on the big
   Image view, not the small live monitor). */
function buildMeta(spec){
  const subjName=(VOXEL_MODELS[S.subject]?.title||S.subject).toUpperCase();
  return {
    tl: subjName+' · '+S.pose,
    tr: S.aecResult
      ? S.kv+' kVp  '+S.ma+' mA  AEC '+S.aecResult.mas.toFixed(S.aecResult.mas<10?1:0)+' mAs'
        +' ['+['l','c','r'].filter(k=>S.aecCells[k]).join('').toUpperCase()+']'
        +(S.aecResult.backupHit?'  ⚠ BACKUP':'')
      : S.kv+' kVp  '+S.ma+' mA  '+S.mas.toFixed(S.mas<10?1:0)+' mAs',
    bl: 'SID '+S.sid+'  OID '+S.oid+'cm  '+fmtTime((S.aecResult?S.aecResult.mas:S.mas)/S.ma)+'  Ē '+spec.meanE.toFixed(0)+'keV',
    br: 'DR '+S.detNx+'×'+S.detNy+'  '+S.detW+'×'+S.detH+'cm  '+(S.gridOn?'GRID '+S.gridRatio+':1':'NO GRID'),
  };
}

/* ---- image history: keep the last 10 exposures, reviewable on the Image view ---- */
const IMG_HISTORY_MAX=10;
function pushImage(signal,nx,ny,mask,meta){
  const rescale=computeRescale(signal,mask);   // auto-rescale VOI window, fixed at capture
  S.imgHistory.push({sig:signal, nx, ny, mask, subject:S.subject, meta, rescale});
  while(S.imgHistory.length>IMG_HISTORY_MAX) S.imgHistory.shift();
  setActiveImage(S.imgHistory.length-1);
}
/* QC hook: the PRE-display signal of the last exposure, for measuring the line-pair
   phantom. Modulation has to be read off the detector signal, not the windowed canvas —
   brightness/contrast would rescale the very numbers being measured. */
if(typeof window!=='undefined') window.radsimQC={
  lastImage(){ const im=S.imgHistory[S.imgHistory.length-1]; if(!im) return null;
    return {nx:im.nx, ny:im.ny, sig:im.sig, mask:im.mask, subject:im.subject,
            pxU:S.detW*10/im.nx, pxV:S.detH*10/im.ny,    // mm per pixel
            meta:im.meta, aec:S.aecResult && {...S.aecResult}, mas:S.mas};
  }
};
/* Point the render state at history[idx] and refresh the view + strip + meta. */
function setActiveImage(idx){
  if(!S.imgHistory.length){ S.histIdx=-1; S.hasImage=false; return; }
  idx=Math.max(0,Math.min(S.imgHistory.length-1,idx));
  const e=S.imgHistory[idx];
  S.histIdx=idx; S.lastSignal=e.sig; S.nx=e.nx; S.ny=e.ny; S.mask=e.mask;
  S.activeSubject=e.subject; S.imgMeta=e.meta; S.rescale=e.rescale; S.hasImage=true;
  reseedCurve();                     // handles land on THIS image's toe/inflection/shoulder
  drawFilm();
  updateImageMeta(); renderImageStrip();
}
/* Write the active image's metadata into the big Image-view corner overlays. */
function updateImageMeta(){
  const m=S.imgMeta||{};
  const set=(id,v)=>{ const el=$(id); if(el) el.textContent=v||''; };
  set('ivTL',m.tl); set('ivTR',m.tr); set('ivBL',m.bl); set('ivBR',m.br);
}
/* Render the thumbnail strip for the image history (x-ray Image view only). */
function renderImageStrip(){
  const strip=$('imgStrip'); if(!strip) return;
  strip.innerHTML='';
  S.imgHistory.forEach((e,i)=>{
    const b=document.createElement('button');
    b.className='imgthumb'+(i===S.histIdx?' on':'');
    b.title=(e.meta?.tl||'')+'  ·  '+(e.meta?.tr||'');
    const c=document.createElement('canvas'); renderRadiograph(c,e); // full oriented render
    const t=document.createElement('canvas'); t.width=64; t.height=80;
    const tg=t.getContext('2d'); tg.fillStyle='#000'; tg.fillRect(0,0,64,80);
    const s=Math.min(64/c.width,80/c.height), w=c.width*s, h=c.height*s;
    tg.drawImage(c,(64-w)/2,(80-h)/2,w,h);
    b.appendChild(t);
    const n=document.createElement('span'); n.className='imgthumb-n'; n.textContent=i+1; b.appendChild(n);
    b.addEventListener('click',()=>setActiveImage(i));
    strip.appendChild(b);
  });
}

/* ---- compute backend (Python GPU) ---- */
const compute=new ComputeClient();
/* Ping the backend; update the status chips + enable/disable the Python buttons in
   both modes. Called at boot and whenever a toggle is pressed. */
async function refreshComputeStatus(){
  const was=!!S.computeInfo;
  S.computeInfo=await compute.health();
  if(was!==!!S.computeInfo) ctrstBackendChanged();
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
// Description under the compute-engine selector — changes with the selected engine.
const COMPUTE_NOTES={
  xray:{ local:'Ray-casting runs in the browser (CPU). Switch to Python GPU to offload voxel-model projections to the compute backend.',
         python:'Voxel-model ray-casting is offloaded to the Python GPU backend. The analytic hand always computes in-browser.' },
  ct:{   local:'Scout + reconstruction run in the browser (CPU). Switch to Python GPU to offload them to the compute backend.',
         python:'Scout + reconstruction are offloaded to the Python GPU backend.' },
};
function updateComputeNote(mode){
  const el=$(mode==='xray'?'computeNoteX':'computeNoteCT'); if(!el) return;
  const val=mode==='xray'?S.xrayBackend:S.ct.backend;
  el.textContent=(COMPUTE_NOTES[mode]||{})[val]||'';
}
function setBackend(mode,val){
  if(mode==='xray') S.xrayBackend=val; else S.ct.backend=val;
  const seg=$(mode==='xray'?'backendSegX':'backendSegCT');
  if(seg)[...seg.children].forEach(b=>b.classList.toggle('on',b.dataset.be===val));
  updateComputeNote(mode);
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
    // Realistic turns every physics feature ON (incl. full-resolution recon); Quick turns them
    // all OFF for a real-time preview-quality result. Either can be overridden afterwards.
    const on=S.ct.detMode==='realistic';
    S.ct.features={ beamHardening:on, coneBeam:on, focalBlur:on, quantumNoise:on, fullRecon:on };
    syncFeatureToggles();
    updateDetWarn();
    ctApplyAcqMode();                          // reconcile detector rows with the new SSCT/MSCT state
  });
  // Individual physics-feature toggles (override the per-mode defaults).
  $('ctDetFeat')?.addEventListener('change',e=>{
    const cb=e.target.closest('input[data-feat]'); if(!cb) return;
    S.ct.features[cb.dataset.feat]=cb.checked;
    updateDetWarn();
  });
  // SSCT / MSCT acquisition-mode toggle (a two-button segment). MSCT = cone-beam z-divergent
  // rays (cross-slice bleed); SSCT = a single untilted ray, and detector rows lock to 1.
  $('ctConeSeg')?.addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b) return;
    S.ct.features.coneBeam = b.dataset.cone==='1';
    syncFeatureToggles();
    updateDetWarn();
    ctApplyAcqMode();
  });
  // Interface / vendor toggle (GE vs Canon/Toshiba) — changes the reposition workflow.
  $('ctVendorSeg')?.addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b) return;
    S.ct.vendor=b.dataset.vendor;
    [...$('ctVendorSeg').children].forEach(x=>x.classList.toggle('on',x.dataset.vendor===S.ct.vendor));
    updateVendorNote();
    ctApplyVendor();
  });
  // Colour-scheme toggle (vendor-specific vs generic) — CT interface only.
  $('ctSchemaSeg')?.addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b) return;
    S.ct.colorSchema=b.dataset.schema;
    [...$('ctSchemaSeg').children].forEach(x=>x.classList.toggle('on',x.dataset.schema===S.ct.colorSchema));
    updateSchemaNote();
    ctApplyColorTheme();
  });
  updateVendorNote();
  updateSchemaNote();
}
// Describe the selected colour scheme.
function updateSchemaNote(){
  const el=$('ctSchemaNote'); if(!el) return;
  el.textContent = S.ct.colorSchema==='generic'
    ? 'Generic: the app’s default console colours.'
    : 'Vendor-specific: the CT interface adopts the selected vendor’s console colours (X-ray is unchanged).';
}
// Describe the selected vendor workflow.
function updateVendorNote(){
  const el=$('ctVendorNote'); if(!el) return;
  el.innerHTML = S.ct.vendor==='ge'
    ? 'GE: place the recon box anywhere by dragging — the DFOV is off-centred in software. The couch does not move mediolaterally / A-P after the scout.'
    : 'Canon / Toshiba: the box is locked to the isocentre; use the reposition chevrons + TABLE button to physically move the couch (SFOV) into position.';
}
// Reflect S.ct.features onto the toggle checkboxes.
function syncFeatureToggles(){
  const f=S.ct.features||{};
  document.querySelectorAll('#ctDetFeat input[data-feat]').forEach(cb=>{ cb.checked=!!f[cb.dataset.feat]; });
  const seg=$('ctConeSeg');
  if(seg) [...seg.children].forEach(b=>b.classList.toggle('on', (b.dataset.cone==='1')===!!f.coneBeam));
}
// Warn about processing time whenever any heavy feature is enabled; call out Realistic + GPU.
function updateDetWarn(){
  const w=$('ctDetWarn'); if(!w) return;
  const f=S.ct.features||{}, heavy=f.beamHardening||f.coneBeam||f.focalBlur;
  if(!heavy && S.ct.detMode!=='realistic'){ w.style.display='none'; return; }
  w.style.display='';
  w.innerHTML = S.ct.detMode==='realistic'
    ? '⚠ Realistic reconstruction with these physics features is heavy — expect long processing times. A detected GPU (Python compute engine) is strongly recommended.'
    : '⚠ The enabled physics features increase processing time. Turn them off for the fastest previews.';
}


/* ---- power injector (docs/contrast-simulation.md Phase 3) ----------------------------
   Modelled on a dual-syringe CT injector: one barrel of contrast medium, one of saline, a
   programmed sequence drawn to scale in time, and a transport bar.

   The scan delay is NOT a number you dial. You start the injector, the clock runs, and the
   enhancement you get is whatever the anatomy had reached at the moment you took the
   exposure — which is the actual skill the machine demands. Dialling "scan at 25 s" let you
   pick the answer; this makes you commit to it. */
const CTRST_EL = { conc:'ctrstConc', hr:'ctrstHr', sv:'ctrstSv',
                   cal:'ctrstCal', perf:'ctrstPerf' };
// What each access route means for the bolus. The arterial sites are estimates and the note
// says so in the same breath — the limb is not in any model's anatomy, so its transit is a
// mixing bed plus a delay, entering the segmented circulation at the named trunk vein.
const CTRST_SITE_NOTE = {
  basilic: 'The reference route: arm vein → SVC → right heart. Every timing chart '
    + 'assumes this access.',
  central: 'Catheter tip at the cavoatrial junction — no peripheral veins to cross, so '
    + 'arrival is the earliest and sharpest the circulation can produce.',
  radial: 'Arterial access: the bolus must cross the forearm capillary bed before it can '
    + 'return. The forearm is not in this anatomy — estimated as an 80 mL bed + 5 s '
    + 'vessel run, rejoining at the SVC. Expect a later, blunter peak.',
  femoral: 'Arterial access: the bolus crosses the leg and returns via the IVC. The leg is '
    + 'not in this anatomy — estimated as a 150 mL bed + 8 s run. The latest, most '
    + 'dispersed arrival of the four.',
};
let ctrstTimer = null;

/* Injection line pressure, Poiseuille through the 2.5 m coiled line and a 20 G cannula.
   Real physics rather than decoration: it is why 8 mL/s of 400 mgI/mL through a small
   cannula is a genuine constraint, and the fourth-power radius term is what makes cannula
   choice matter more than anything else on the panel. Viscosity is for 37 degC. */
const CONTRAST_ETA = [[240, 0.0030], [300, 0.0049], [350, 0.0080], [400, 0.0120]];  // Pa.s
function injViscosity(conc){
  const t = CONTRAST_ETA;
  if(conc <= t[0][0]) return t[0][1];
  for(let i=1;i<t.length;i++){
    if(conc <= t[i][0]){
      const f=(conc-t[i-1][0])/(t[i][0]-t[i-1][0]);
      return t[i-1][1]+(t[i][1]-t[i-1][1])*f;
    }
  }
  return t[t.length-1][1];
}
function injPressureBar(rate_ml_s, conc){
  const eta=injViscosity(conc), Q=rate_ml_s*1e-6;             // m^3/s
  const seg=(L,r)=> 8*eta*L*Q/(Math.PI*Math.pow(r,4));        // Pa
  return (seg(2.5, 0.75e-3) + seg(0.032, 0.40e-3)) / 1e5;     // line + cannula, Pa -> bar
}

/* The programmed sequence: an optional start delay, the contrast bolus, the saline chaser. */
function ctrstPhases(){
  const P=S.contrast.params;
  // Every phase is always present, even at zero, because the bar is the only place a phase
  // can be programmed — a segment that vanishes when you set it to 0 cannot be set back.
  return [
    {kind:'delay', t:P.delay_s, ml:0, rate:0},
    {kind:'cm',    t:P.volume_ml/Math.max(P.rate_ml_s,.1),        ml:P.volume_ml, rate:P.rate_ml_s},
    {kind:'cm2',   t:P.volume2_ml/Math.max(P.rate2_ml_s,.1),      ml:P.volume2_ml, rate:P.rate2_ml_s},
    {kind:'nacl',  t:P.saline_ml/Math.max(P.saline_rate_ml_s,.1), ml:P.saline_ml, rate:P.saline_rate_ml_s},
  ];
}
const ctrstTotalTime = () => ctrstPhases().reduce((a,p)=>a+p.t, 0);
const fmtClock = (sec)=>{
  const s=Math.max(0,Math.floor(sec));
  return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
};

/* ---- the running clock -------------------------------------------------------------- */
function ctrstClock(){
  const R=S.contrast.run;
  return R.t0==null ? null : (performance.now()-R.t0)/1000;
}
function ctrstStart(){
  const R=S.contrast.run;
  R.t0=performance.now(); R.latched=null;
  S.contrast.scanTime=0; S.contrast.lut=null; S.contrast.lutT=null;
  if(!R.timer) R.timer=setInterval(ctrstTick, 100);
  ctrstRenderRun(); ctrstDrawCurve();
}
function ctrstReset(){
  const R=S.contrast.run;
  if(R.timer){ clearInterval(R.timer); R.timer=null; }
  R.t0=null; R.latched=null;
  S.contrast.scanTime=0; S.contrast.lut=null; S.contrast.lutT=null;
  ctrstRenderRun(); ctrstDrawCurve();
}
function ctrstTick(){
  const t=ctrstClock();
  if(t==null) return;
  if(S.contrast.run.latched==null){
    S.contrast.scanTime=Math.min(t, 90);
    S.contrast.lut=null; S.contrast.lutT=null;
  }
  ctrstRenderRun(); ctrstDrawCurve();
  if(t>150){ const R=S.contrast.run; clearInterval(R.timer); R.timer=null; }   // stop ticking, keep the time
}
/* Freeze the acquisition time at the instant the tube fires. Everything downstream — the
   x-ray projection, every CT slice — reads S.contrast.scanTime, so latching here is what
   ties the image to the delay the operator actually achieved. */
function ctrstLatch(){
  const t=ctrstClock();
  if(t==null) return null;
  S.contrast.run.latched=Math.min(t, 90);
  S.contrast.scanTime=S.contrast.run.latched;
  S.contrast.lut=null; S.contrast.lutT=null;
  ctrstRenderRun();
  return S.contrast.run.latched;
}

function ctrstReadUI(){
  const v=(k)=> +$(CTRST_EL[k]).value;
  const P=S.contrast.params;
  P.conc_mgi_ml=v('conc');
  // Cardiac output is what the haemodynamics depend on; heart rate is what a student
  // changes. CO = HR x stroke volume, so expose both and derive the one the solver wants.
  P.cardiac_output_l_min=v('hr')*v('sv')/1000;
  P.vessel_scale=v('cal'); P.perfusion_scale=v('perf');
  $('ctrstConcV').textContent=P.conc_mgi_ml+' mgI/mL';
  $('ctrstHrV').textContent=v('hr')+' bpm';
  $('ctrstSvV').textContent=v('sv')+' mL';
  $('ctrstCalV').textContent=P.vessel_scale.toFixed(2)+'×';
  $('ctrstPerfV').textContent=P.perfusion_scale.toFixed(2)+'×';
  $('ctrstTotal').textContent=(P.volume_ml+P.volume2_ml+P.saline_ml)+' ml total';
  $('ctrstDur').textContent=fmtClock(ctrstTotalTime());
  // both contrast phases carry iodine; peak pressure is whichever phase runs fastest
  $('ctrstInjNote').textContent=((P.volume_ml+P.volume2_ml)*P.conc_mgi_ml/1000).toFixed(1)
    +' g iodine · peak line pressure '
    +injPressureBar(Math.max(P.rate_ml_s, P.volume2_ml>0?P.rate2_ml_s:0),P.conc_mgi_ml).toFixed(1)+' bar';
  $('ctrstCoNote').textContent='cardiac output '+P.cardiac_output_l_min.toFixed(1)+' L/min'
    +' · calibre scales transit time, perfusion scales organ uptake';
  ctrstRenderBar();
}

/* Phase bar, drawn to scale in time. */
function ctrstRenderBar(){
  const el=$('ctrstBar'); if(!el) return;
  const ph=ctrstPhases(), tot=Math.max(ctrstTotalTime(),.1);
  el.innerHTML=ph.map(p=>{
    const lab=p.kind==='delay' ? 'Delay' : p.ml+' ml';
    const sub=p.kind==='delay' ? fmtClock(p.t) : p.rate.toFixed(1)+' mL/s · '+p.t.toFixed(1)+'s';
    // grow in proportion to duration, but never below a tappable width
    return `<button class="inj-seg ${p.kind}" data-phase="${p.kind}" `
         + `style="flex:${Math.max(p.t,0.01)} 1 0"><div>${lab}</div><small>${sub}</small></button>`;
  }).join('');
  const editable = S.contrast.on && !ctrstBlocker() && !S.contrast.static;
  el.querySelectorAll('.inj-seg').forEach(b=>{
    b.disabled=!editable;
    b.addEventListener('click',()=>kpadOpen(b.dataset.phase));
  });
}

/* Live readouts while the injector runs. */
function ctrstRenderRun(){
  if(!$('ctrstElapsed')) return;
  const P=S.contrast.params, t=ctrstClock(), R=S.contrast.run;
  const tot=ctrstTotalTime();
  $('ctrstElapsed').textContent = t==null ? '00:00' : fmtClock(t);
  $('ctrstProg').style.width = t==null ? '0%' : Math.min(100, t/Math.max(tot,.1)*100)+'%';
  // delivered volume: walk the programmed phases up to the elapsed time
  let cm=0, na=0, left=t==null?0:t;
  for(const p of ctrstPhases()){
    const d=Math.min(Math.max(left,0), p.t);
    if(p.kind==='cm') cm+=d*p.rate;
    if(p.kind==='nacl') na+=d*p.rate;
    left-=p.t;
  }
  const inj = t!=null && t<tot;
  $('ctrstPress').textContent = (inj ? injPressureBar(P.rate_ml_s,P.conc_mgi_ml) : 0).toFixed(1)+' bar';
  $('ctrstDeliv').innerHTML = Math.round(cm)+' ml CM &nbsp;·&nbsp; '+Math.round(na)+' ml NaCl delivered';
  const go=$('ctrstGo');
  go.classList.toggle('running', t!=null);
  go.textContent = t==null ? '▶' : (inj ? '● INJECTING' : '● RUNNING');
  $('ctrstReset').disabled = t==null;
}

function ctrstStatus(msg, cls){
  const el=$('ctrstStatus'); if(!el) return;
  el.textContent=msg; el.className='ctrst-status'+(cls?' '+cls:'');
}

/* Re-solve, debounced. */
function ctrstQueueSolve(){
  if(!S.contrast.on) return;
  clearTimeout(ctrstTimer);
  ctrstStatus('Solving haemodynamics…','busy');
  ctrstTimer = setTimeout(async ()=>{
    const ok = await contrastSolve();
    if(!ok){
      S.contrast.on=false; ctrstApply(true);
      ctrstStatus(S.contrast.error || 'Solve failed.','err');
    } else {
      ctrstApply(true);          // the timeline now exists, so START can arm
      ctrstStatus(S.contrast.static
        ? 'Preset timeline loaded. Press START, then take the exposure when the timing is right.'
        : 'Ready. Press START, then take the exposure when the timing is right.');
    }
    S.contrast.lut=null; S.contrast.lutT=null;
    ctrstDrawCurve(); refreshReadouts();
  }, 350);
}


/* Enhancement of one vessel at a given time on the injector clock, as an ROI would read it.
   The CT console's bolus-tracking series calls this; it is a pure read of the timeline, so it
   needs no solve and works on the shipped preset too. */
export function contrastVesselHU(vesselId, t){
  const tl=S.contrast.timeline; if(!tl) return 0;
  const f=tl.vessels.get(vesselId); if(!f) return 0;
  const i=Math.max(0, Math.min(tl.nT-1, Math.round(t)));
  let m=0; const a=i*tl.nS;
  for(let k=0;k<tl.nS;k++) if(f[a+k]>m) m=f[a+k];
  return m * BodyMaterials.huPerMgIml(70);
}

/* Predicted enhancement + where the clock currently is. */
function ctrstDrawCurve(){
  const cv=$('ctrstCurve'); if(!cv) return;
  const g=cv.getContext('2d'), W=cv.width, H=cv.height;
  g.clearRect(0,0,W,H); g.fillStyle='#070a0d'; g.fillRect(0,0,W,H);
  const tl=S.contrast.timeline, TMAX=90;
  const K=BodyMaterials.huPerMgIml(70);        // dHU per mgI/mL at a 120 kVp effective energy
  const pad={l:26,r:6,t:8,b:14}, pw=W-pad.l-pad.r, ph=H-pad.t-pad.b, HMAX=520;
  g.lineWidth=1; g.font='8px monospace';
  for(let hu=0; hu<=HMAX; hu+=130){
    const y=pad.t+ph-hu/HMAX*ph;
    g.strokeStyle='#1b232b'; g.beginPath(); g.moveTo(pad.l,y); g.lineTo(W-pad.r,y); g.stroke();
    g.fillStyle='#5a6570'; g.fillText(String(hu), 3, y+3);
  }
  for(let t=0;t<=TMAX;t+=15){
    const x=pad.l+t/TMAX*pw;
    g.strokeStyle='#1b232b'; g.beginPath(); g.moveTo(x,pad.t); g.lineTo(x,pad.t+ph); g.stroke();
    if(t){ g.fillStyle='#5a6570'; g.fillText(t+'s', x-7, H-3); }
  }
  if(tl){
    const line=(series,col)=>{
      g.strokeStyle=col; g.lineWidth=1.6; g.beginPath();
      for(let t=0;t<tl.nT && t<=TMAX;t++){
        const x=pad.l+t/TMAX*pw, y=pad.t+ph-Math.min(series(t)*K,HMAX)/HMAX*ph;
        if(t) g.lineTo(x,y); else g.moveTo(x,y);
      }
      g.stroke();
    };
    // a vessel enhances unevenly along its length, so plot its peak — the number a
    // bolus-tracking ROI would read
    const vmax=(id)=>{ const f=tl.vessels.get(id); if(!f) return ()=>0;
      return (t)=>{ let m=0; const a=t*tl.nS; for(let k=0;k<tl.nS;k++) if(f[a+k]>m) m=f[a+k]; return m; }; };
    const org=(id)=>{ const f=tl.organs.get(id); return f?((t)=>f[t]):()=>0; };
    line(vmax(29),'#ff7d7d'); line(vmax(30),'#7dc4ff');
    line(org(11),'#c79bff');  line(org(13),'#8fe08f');
  } else {
    g.fillStyle='#4a5560'; g.font='9px monospace';
    g.fillText('turn contrast on to solve', pad.l+38, pad.t+ph/2);
  }
  const mark=(t,col,solid)=>{
    const x=pad.l+Math.min(t,TMAX)/TMAX*pw;
    g.strokeStyle=col; g.lineWidth=1.5;
    if(!solid) g.setLineDash([3,3]);
    g.beginPath(); g.moveTo(x,pad.t-3); g.lineTo(x,pad.t+ph+3); g.stroke();
    g.setLineDash([]);
    if(solid){ g.fillStyle=col; g.beginPath();
      g.moveTo(x,pad.t-3); g.lineTo(x-4,pad.t-8); g.lineTo(x+4,pad.t-8); g.closePath(); g.fill(); }
  };
  // The running clock is the ONLY cue for when to fire — no target is drawn, because
  // judging the moment against the curve is the exercise. The amber mark appears only
  // after an exposure, as feedback on where you actually landed.
  const live=ctrstClock(), R=S.contrast.run;
  if(live!=null) mark(live, R.latched==null ? '#4fd06a' : '#3a4a55', R.latched==null);
  if(R.latched!=null) mark(R.latched,'#ffb23e',true);
}

/* Why contrast cannot run right now, or null if it can.

   Note what is NOT a blocker: the compute-engine choice. The browser ray-caster renders the
   iodine column perfectly well — what needs the Python service is the haemodynamic SOLVE,
   which has no JS implementation. Gating on the engine toggle would take away a combination
   that works. The gate is service reachability. */
function ctrstBlocker(){
  const vm=S.voxelModel;
  if(!vm || !vm.hasVessels)
    return ['Contrast unavailable — '+S.subject+' has no vessel map (build_vessels not run)'];
  if(!S.computeInfo && !(vm.hasPresetContrast))
    return ['Contrast unavailable — needs the Python compute service, and this model ships no preset'];
  return null;
}

function ctrstApply(keepStatus){
  const panel=$('ctrstPanel'); if(!panel) return;
  const blocked=ctrstBlocker();
  // Grey the tab itself, not just the controls inside: the honest signal belongs on the
  // closed panel. When blocked the tab is inert and the reason lives in its tooltip only.
  panel.classList.toggle('blocked', !!blocked);
  $('ctrstTab').title = blocked ? blocked[0] : 'Contrast injector';
  if(blocked){ panel.classList.remove('open'); syncFlyouts(); }
  panel.classList.toggle('armed', S.contrast.on);
  $('ctrstOn').classList.toggle('on', S.contrast.on);
  $('ctrstOn').textContent = S.contrast.on ? 'ON' : 'OFF';
  // Editable only when a live solver is behind it. On the shipped preset the protocol is
  // fixed, so every control that would change it is locked — a slider that silently does
  // nothing is worse than one that is visibly unavailable.
  const live = S.contrast.on && !blocked;
  const editable = live && !S.contrast.static;
  Object.values(CTRST_EL).forEach(id=>{ const el=$(id); if(el) el.disabled=!editable; });
  // The site select follows `live`, not `editable`: presets ship one timeline per site, so
  // switching access still works without the service. Individual options grey out when the
  // model's manifest lacks that site's file (an old single-preset model).
  const siteEl=$('ctrstSite');
  if(siteEl){
    siteEl.disabled = !live;
    const sites=(S.voxelModel && S.voxelModel.presetSites) || [];
    [...siteEl.options].forEach(o=>{
      o.disabled = S.contrast.static && !sites.includes(o.value); });
  }
  const lock=$('ctrstLock');
  if(lock){
    lock.style.display = (live && S.contrast.static) ? '' : 'none';
    lock.textContent = 'Preset timeline — protocol locked. The haemodynamic solver runs on the '
      + 'Python compute service; without it the shipped solve is used, so the injector settings '
      + 'cannot be changed. The injection site still switches — each site ships its own solved '
      + 'timeline. Timing, scanning and bolus tracking all still work.';
  }
  ctrstRenderBar();          // the phase buttons take their enabled state from `editable` too
  $('ctrstGo').disabled = !live || !S.contrast.timeline;
  $('ctrstOn').disabled = !!blocked;
  if(!live) ctrstReset();
  if(!blocked && !keepStatus && !S.contrast.on) ctrstStatus('Contrast off. Unenhanced scans are unaffected.');
  ctrstRenderRun(); ctrstDrawCurve();
}

/* The service can come and go while the panel is open, so re-evaluate on every health poll.
   Contrast that is already solved keeps working — the timeline is client-side by then. */
function ctrstBackendChanged(){
  if(!$('ctrstPanel')) return;
  if(S.contrast.on && !S.computeInfo && !S.contrast.timeline){ S.contrast.on=false; }
  // Service back: unlock. The preset timeline stays in place until something is actually
  // changed, so the image on screen does not silently move under the user.
  if(S.computeInfo && S.contrast.static) S.contrast.static=false;
  ctrstApply(true);
}


/* ---- injector phase keypad -----------------------------------------------------------
   Tap a phase on the bar, type the value. A number is entered rather than nudged because
   97 mL is twenty-four presses away from 100 on a +/- key — which is exactly why the real
   console puts a keypad here and not a pair of arrows. */
const KPAD = {
  cm:    { title:'CM', fields:[
            {k:'volume_ml',       lab:'Volume',    unit:'mL',   min:1,   max:200, dp:0},
            {k:'rate_ml_s',       lab:'Flow rate', unit:'mL/s', min:0.1, max:10,  dp:1}] },
  cm2:   { title:'CM · phase 2', fields:[
            {k:'volume2_ml',      lab:'Volume',    unit:'mL',   min:0,   max:200, dp:0},
            {k:'rate2_ml_s',      lab:'Flow rate', unit:'mL/s', min:0.1, max:10,  dp:1}] },
  nacl:  { title:'NaCl', fields:[
            {k:'saline_ml',       lab:'Volume',    unit:'mL',   min:0,   max:100, dp:0},
            {k:'saline_rate_ml_s',lab:'Flow rate', unit:'mL/s', min:0.1, max:10,  dp:1}] },
  delay: { title:'Delay', fields:[
            {k:'delay_s',         lab:'Start delay', unit:'s',  min:0,   max:60,  dp:0}] },
};
let kpadState=null;      // { phase, fields:[{spec, text}], sel }

function kpadRender(){
  const box=$('kpadFields');
  box.innerHTML=kpadState.fields.map((f,i)=>{
    const sp=f.spec;
    return `<div class="kpad-f${i===kpadState.sel?' sel':''}" data-i="${i}">`
         + `<div class="fmeta"><b>${sp.lab}</b>Min ${sp.min} ${sp.unit}<br>Max ${sp.max} ${sp.unit}</div>`
         + `<div class="fv">${f.text===''?'—':f.text} <small>${sp.unit}</small></div></div>`;
  }).join('');
  box.querySelectorAll('.kpad-f').forEach(el=>{
    el.addEventListener('click',()=>{
      kpadState.sel=+el.dataset.i;
      kpadState.fields[kpadState.sel].fresh=true;   // its first key replaces too
      kpadRender();
    });
  });
}
function kpadOpen(phase){
  const spec=KPAD[phase]; if(!spec) return;
  const P=S.contrast.params;
  kpadState={ phase, sel:0,
    // `fresh` marks a field still showing its stored value: the first digit typed replaces
    // it outright. Appending to the existing number is almost never what is wanted — you are
    // entering 65, not 10065 — so the console overwrites and offers a clear key instead.
    fields: spec.fields.map(sp=>({ spec:sp, text:String(+P[sp.k].toFixed(sp.dp)), fresh:true })) };
  $('kpadTitle').textContent=spec.title;
  kpadRender();
  $('kpad').className='kpad open '+phase;      // header rule takes the phase colour
}
function kpadClose(){ $('kpad').className='kpad'; kpadState=null; }
function kpadKey(k){
  if(!kpadState) return;
  const f=kpadState.fields[kpadState.sel];
  if(k==='bs'){ f.text=''; f.fresh=false; }                    // clear, not backspace
  else if(k==='.'){
    if(f.fresh){ f.text='0'; f.fresh=false; }
    if(f.spec.dp>0 && !f.text.includes('.')) f.text=(f.text||'0')+'.';
  } else {
    if(f.fresh){ f.text=''; f.fresh=false; }                   // first key replaces
    f.text=(f.text==='0'?'':f.text)+k;
  }
  kpadRender();
}
function kpadCommit(){
  if(!kpadState) return;
  const P=S.contrast.params;
  for(const f of kpadState.fields){
    const sp=f.spec, v=parseFloat(f.text);
    // An out-of-range or empty entry is clamped rather than rejected: the min/max are beside
    // the field, so the corrected number is visible feedback, not a silent swap.
    P[sp.k]=isFinite(v) ? Math.max(sp.min, Math.min(sp.max, v)) : sp.min;
  }
  kpadClose();
  if(S.contrast.run.t0!=null) ctrstReset();     // cannot reprogram a running injection
  ctrstReadUI(); ctrstQueueSolve();
}
function initKeypad(){
  $('kpadKeys').querySelectorAll('button').forEach(b=>
    b.addEventListener('click',()=>kpadKey(b.dataset.k)));
  $('kpadDel').addEventListener('click',()=>{
    if(kpadState){ kpadState.fields[kpadState.sel].text=''; kpadRender(); }
  });
  $('kpadOk').addEventListener('click', kpadCommit);
  $('kpadCancel').addEventListener('click', kpadClose);
  $('kpad').addEventListener('click',e=>{ if(e.target.id==='kpad') kpadClose(); });
  document.addEventListener('keydown',e=>{
    if(!$('kpad').classList.contains('open')) return;
    if(e.key==='Escape') kpadClose();
    else if(e.key==='Enter') kpadCommit();
    else if(/^[0-9]$/.test(e.key)) kpadKey(e.key);
    else if(e.key==='.') kpadKey('.');
    else if(e.key==='Backspace') kpadKey('bs');
    else if(e.key==='Tab' && kpadState){ e.preventDefault();
      kpadState.sel=(kpadState.sel+1)%kpadState.fields.length;
      kpadState.fields[kpadState.sel].fresh=true; kpadRender(); }
  });
}

/* The left flyouts share an edge: whenever one is open, every tab on that rail slides out
   with it so no tab is left sitting over the open panel. */
function syncFlyouts(){
  document.body.classList.toggle('lflyout', !!document.querySelector('.ctrst.open'));
}
function initContrastPanel(){
  const panel=$('ctrstPanel');
  $('ctrstTab').addEventListener('click',()=>{
    if(panel.classList.contains('blocked')) return;      // inert while unavailable
    panel.classList.toggle('open');
    syncFlyouts();
    if(panel.classList.contains('open')) ctrstDrawCurve();
  });
  $('ctrstOn').addEventListener('click', async ()=>{
    S.contrast.on = !S.contrast.on;
    ctrstApply();
    if(S.contrast.on) ctrstQueueSolve();
    else { S.contrast.lut=null; S.contrast.lutT=null; refreshReadouts(); }
  });
  ['conc','hr','sv','cal','perf'].forEach(k=>{
    $(CTRST_EL[k]).addEventListener('input',()=>{
      if(S.contrast.run.t0!=null) ctrstReset();   // cannot reprogram a running injection
      ctrstReadUI(); ctrstQueueSolve();
    });
  });
  // The access site is deliberately NOT in CTRST_EL: on a preset it must stay switchable,
  // because each site ships its own solved timeline — the route changes the topology of the
  // solve, which no amount of parameter-locking captures.
  $('ctrstSite')?.addEventListener('change', e=>{
    const C=S.contrast;
    C.params.site = e.target.value;
    $('ctrstSiteNote').textContent = CTRST_SITE_NOTE[C.params.site] || '';
    if(C.run.t0!=null) ctrstReset();              // a new access is a new injection
    if(!C.on) return;
    C.timeline=null; C.lut=null; C.lutT=null;
    ctrstQueueSolve();
  });
  if($('ctrstSiteNote')) $('ctrstSiteNote').textContent = CTRST_SITE_NOTE.basilic;
  $('ctrstGo').addEventListener('click', ctrstStart);
  $('ctrstReset').addEventListener('click', ctrstReset);
  initKeypad();
  ctrstReadUI(); ctrstApply();
}

// Drive the injector from a script or a test.
window.radsimContrast={
  state:()=>S.contrast,
  async enable(params){
    Object.assign(S.contrast.params, params||{});
    S.contrast.on=true;
    const ok=await contrastSolve();
    ctrstApply(true);
    if(!ok) S.contrast.on=false;
    return ok ? S.contrast.timeline : S.contrast.error;
  },
  disable(){ S.contrast.on=false; ctrstApply(); },
  start:()=>ctrstStart(),
  reset:()=>ctrstReset(),
  latch:()=>ctrstLatch(),
  vesselHU:(id,t)=>contrastVesselHU(id,t),
  clock:()=>ctrstClock(),
  // Acquisition timing for the selected CT scan group — a helical scan images each slice at
  // its own moment, which is the whole point of per-slice timing.
  ctTiming(){
    const g=(S.ct.groups||[])[S.ct.sel||0]; if(!g) return null;
    const lo=S.ct.scanStart, hi=lo+S.ct.scanLen, n=12;
    const pos=Array.from({length:n},(_,i)=>lo+(hi-lo)*i/(n-1));
    return { mmPerSec:+couchSpeedMMps(g).toFixed(1), lenMM:+(hi-lo).toFixed(0),
             t:pos.map((_,i)=>+sliceTime(g,pos,i,S.contrast.scanTime).toFixed(2)) };
  },
};

function initExtras(){
  wireBackendToggles();
  syncFeatureToggles();
  updateComputeNote('xray'); updateComputeNote('ct'); updateDetWarn();
  refreshComputeStatus();
  // poll the backend so the Python GPU button enables/greys out as it connects/drops
  setInterval(refreshComputeStatus, 5000);
}

/* ---- boot ---- */
window.addEventListener('load',()=>{
  initScene(); bind(); refreshReadouts(); updateGeomReadouts(); applyDet(); syncScene();
  Sound.init(); initExtras(); initContrastPanel(); initGIPanel();
  // CT mode lives in its own module; give it the handles it needs from the app glue.
  initCT({ THREE, S, $, three, Sound,
           syncScene, refreshReadouts, updateGeomReadouts,
           poseRot, buildPhantom, ctLiveView, setCameraView, setCTPov, setContent, setBay3DEnabled,
           refreshFilmViewer, compute, drawHistogram, contrastLatch: ctrstLatch,
           contrastVesselHU, contrastClock: ctrstClock,
           // The monitoring series needs to start the injection with the same press that
           // starts tracking — on the machine one person does both, and the delay between
           // them is exactly what the exercise is about.
           contrastStart: ()=>{ if(S.contrast.on && S.contrast.timeline) ctrstStart(); },
           contrastReset: ()=>ctrstReset(),
           contrastRunning: ()=>ctrstClock()!=null,
           contrastReady: ()=>!!(S.contrast.on && S.contrast.timeline),
           editorMode: (on) => editorApplyMode(on),
           fluoroMode: (on) => fluoroApplyMode(on) });
  // The tutorials drive the real UI, so they need the mode switch and the live state.
  window.__radsimState = S;
  initMobile({ S });                            // pager + dock; inert above the breakpoint
  initFluoro({ THREE, S, $, three, loadModelUrl, baseUrl: import.meta.env.BASE_URL,
    // the worker rebuilds the exact phantom the x-ray path traces: same centre, same
    // flips, same rotation — one geometry, two consumers
    phantomPose: () => ({
      center: [S.objOff.x, (S.voxelModel ? (S.voxelModel.extentMM[1]/2)/10 : 5) + S.objOff.y, S.objOff.z],
      flip: voxelFlips(), rot: objMat() }) });
  initTutorial({ applyMode: ctApplyMode });
  initEditor({ THREE, S, $, three, setCameraView, setOrbitRad: three.setOrbitRad, syncScene,
               registerCustomSubject, unregisterCustomSubject });
  ctApplyVendor();                              // apply the initial vendor workflow (show/hide chevrons + table button)
  setSubject('hand');                           // default subject: the voxel hand phantom
  document.body.classList.add('mode-home');     // open on the menu, not inside a mode
  S.mode='home';
});

/* Test/QC hook for the barium field. The fluoroscopy UI is not built yet, so this is how the
   study is driven: load the shipped timeline, set the clock, and the next exposure renders at
   that moment. Mirrors window.radsimCT in ct.js. */
if (typeof window !== 'undefined') window.radsimBa = {
  load: () => bariumLoad(),
  on: (v = true) => { S.barium.on = v; S.barium.lut = null; },
  at: (t) => { S.barium.studyTime = t; S.barium.lut = null; },
  state: () => ({ on: S.barium.on, t: S.barium.studyTime, has: !!S.barium.timeline,
                  giVol: !!S.barium.giVol, error: S.barium.error }),
  /* Path length per material for a fan of rays through the model, so what the tracer
     actually books for a barium study can be checked without inferring it from an image.
     `axis` is 0/1/2; the rays are cast across the other two over a span of `half` cm. */
  probe: (axis = 1, centre = [0, 0, 25], half = 5, step = 0.6) => {
    const ph = buildPhantom(), tot = new Float64Array(BodyMaterials.TRACE_LEN);
    const a = (axis + 1) % 3, b = (axis + 2) % 3;
    const o = [0, 0, 0], d = [0, 0, 0]; d[axis] = 1;
    for (let p = -half; p <= half; p += step) for (let q = -half; q <= half; q += step) {
      o[axis] = ph.min[axis] - 1; o[a] = centre[a] + p; o[b] = centre[b] + q;
      const L = ph.trace(o.slice(), d, 1e4);
      for (let m = 0; m < tot.length; m++) tot[m] += L[m];
    }
    return Array.from(tot);
  },
};
