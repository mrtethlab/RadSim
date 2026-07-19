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
import { loadModelFile } from './model/loader.js';
import { ComputeClient } from './compute/client.js';
import { initCT, ctSyncScene } from './ct.js';

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
  scene.fog=new THREE.Fog(0x0a0c0f, 120, 320);
  const cam=new THREE.PerspectiveCamera(42,1,1,1000);
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

  three={renderer,scene,cam,tube,cr,lf,lfFill,lfCross,beam,handGroup,det,detMarks,
         amb,key,lamp,cookieCanvas,cookieTex,lampAngle};
  buildHandMeshes();

  // camera: free orbit OR tube's-eye bird's view
  let az=0.9, el=0.85, rad=115, tx=0,ty=6,tz=0;
  function updateCamera(){
    if(S.viewMode==='tube'){
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
  canvas.addEventListener('pointerdown',e=>{ if(S.bayContent!=='3d')return;
    if(S.viewMode!=='orbit') setCameraView('orbit');
    drag=true;lx=e.clientX;ly=e.clientY;canvas.setPointerCapture(e.pointerId)});
  canvas.addEventListener('pointermove',e=>{ if(!drag)return;
    az+=(e.clientX-lx)*0.008; el+=(e.clientY-ly)*0.006;
    el=Math.max(0.12,Math.min(1.45,el)); lx=e.clientX;ly=e.clientY;});
  canvas.addEventListener('pointerup',()=>drag=false);
  canvas.addEventListener('wheel',e=>{ if(S.viewMode!=='orbit')return;
    e.preventDefault();rad=Math.max(55,Math.min(240,rad+e.deltaY*0.09));},{passive:false});

  let prevW=0, prevH=0;
  function resize(){
    const w=canvas.clientWidth, h=canvas.clientHeight;
    if(w && h && (w!==prevW || h!==prevH)){
      prevW=w; prevH=h;
      renderer.setSize(w,h,false); cam.aspect=w/h; cam.updateProjectionMatrix();
    }
  }
  (function loop(){resize();updateCamera();renderer.render(scene,cam);requestAnimationFrame(loop);})();
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
  const boneOnly=(S.handView==='bone');
  three.softGrp.visible=!boneOnly; three.boneGrp.visible=boneOnly;
}
function setHandView(v){
  S.handView=v;
  const seg=$('renderSeg'); if(seg)[...seg.children].forEach(b=>b.classList.toggle('on',b.dataset.hv===v));
  applyHandView();
}

/* ============================================================================
   STATE + WIRING
   ============================================================================ */
const S = {
  pose:'PA', spread:0.45, sid:100, oid:0, tubeZ:0, tubeX:0, angLM:0, angCC:0,
  collX:15, collZ:19, kv:55, mas:2.0, ma:100, prepped:false, exposing:false, hasImage:false,
  lastSignal:null, nx:0, ny:0, mask:null, win:100, lev:0, eiTarget:250,
  viewMode:'orbit', bayContent:'3d', lfOn:true, imgRot:0, flipH:false, flipV:false,
  resolution:'std', gridOn:false, gridRatio:10, gridFocus:100, handView:'soft',
  // ---- CT mode ----
  mode:'xray',                 // 'xray' | 'ct'
  ct:{
    sliceThk:5,                // mm (station selector over discrete values)
    imgPerRotation:1,          // images reconstructed per gantry rotation
    pitch:1.0,                 // table travel per rotation / total collimation
    rotSpeed:0.5,              // seconds per gantry rotation
    scanLen:300,               // mm scout/scan length (from isocentre)
    tablePos:0,                // mm; signed: +I (inferior) / -S (superior); isocentre zeroes it
    isoZ:0,                    // patient z recorded when the isocentre was set
    isocentred:false,
    phase:'idle',              // idle | scout | planning | moving | scanning | done
    patient:{x:0, z:0},        // patient/couch offset from the gantry isocentre
    orientation:'head',        // 'head' | 'feet' — patient enters head- or feet-first
  },
};
// detector base lift (cm) at OID 0: hand resting palm-down on the receptor, so
// the palmar soft tissue between bone and detector is only ~1-1.5 cm.
// detector pixel matrices per resolution tier (4:5, matches 24x30 cm receptor)
const RES_MAP={ low:[176,220], std:[320,400], high:[480,600] };
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
function buildPhantom(){
  const ph=new Phantom();
  const rot=poseRot();
  const cosR=Math.cos(rot), sinR=Math.sin(rot);
  const {skin,bone}=buildHandPrimitives(S.spread, S.pose);
  const liftY=baseLift(skin,bone,rot)+S.oid;   // rest on receptor (pose-aware) + OID
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
  // hand pose (lifted by OID above the receptor; pose-aware rest so it never clips)
  three.handGroup.rotation.z = poseRot();
  { const {skin,bone}=buildHandPrimitives(S.spread, S.pose);
    three.handGroup.position.y = baseLift(skin,bone,poseRot())+S.oid; }

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
function setContent(c){
  S.bayContent=c;
  const seg=$('contentSeg'); if(seg)[...seg.children].forEach(b=>b.classList.toggle('on',b.dataset.c===c));
  const img=(c==='image');
  $('bigFilm').style.display=(img && S.hasImage)?'block':'none';
  $('bignote').style.display=(img && !S.hasImage)?'flex':'none';
  $('view').style.visibility=img?'hidden':'visible';
  if(img && S.hasImage) renderRadiograph($('bigFilm'));
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
  // bay content: 3D positioning  <->  large saved image
  $('contentSeg').addEventListener('click',e=>{const b=e.target.closest('button'); if(!b)return; setContent(b.dataset.c);});
  // camera: free orbit  <->  tube POV bird's-eye
  $('camSeg').addEventListener('click',e=>{const b=e.target.closest('button'); if(!b)return; setCameraView(b.dataset.cam);});
  // render mode: soft-tissue anatomy  <->  skeleton (display only)
  $('renderSeg').addEventListener('click',e=>{const b=e.target.closest('button'); if(!b)return; setHandView(b.dataset.hv);});
  // collimator light on/off
  $('lfBtn').addEventListener('click',()=>{ S.lfOn=!S.lfOn;
    $('lfBtn').classList.toggle('on',S.lfOn); $('lfBtn').setAttribute('aria-pressed',S.lfOn);
    syncScene(); });
  // detector: resolution / anti-scatter grid settings (single-select seg groups)
  const segPick=(id,fn)=>$(id).addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b)return;
    [...$(id).children].forEach(x=>x.classList.remove('on')); b.classList.add('on'); fn(b);
  });
  segPick('resSeg', b=>{ S.resolution=b.dataset.res;
    const [nx,ny]=RES_MAP[S.resolution]; $('resV').textContent=nx+'×'+ny; });
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

  // detector matches the 3D image receptor (24 x 30 cm) so open collimation
  // captures the whole plate, with empty field between the model and the edges.
  const detW=24, detH=30;          // cm
  const [nx,ny]=RES_MAP[S.resolution]||RES_MAP.std;   // pixel matrix (4:5)
  const pxU=detW/nx, pxV=detH/ny;
  const detCenter=[0,0,0];
  const detU=[1,0,0], detV=[0,0,1];

  const I0 = S.mas * Math.pow(S.kv/70,2);   // dose ∝ mAs·kVp^2
  // quanta per pixel scale with pixel AREA: finer matrices collect fewer photons
  // per element -> more quantum mottle (the resolution/noise trade-off).
  const STD_PX=(detW/320)*(detH/400);
  const photonScale = 260 * (pxU*pxV)/STD_PX;   // higher quanta -> lower mottle (clean DR look)

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
  const dose=await AttenuationEngine.project({
    phantom, source, detCenter, detU, detV, nx, ny, pxU, pxV,
    spectrum, I0, refDist:100,
    onRow:(f)=>{ $('prog').style.width=(f*100).toFixed(0)+'%'; },
  });

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
  // orient (rotate + flip) into the target, sizing target to the exposed crop
  const rot=((S.imgRot%360)+360)%360, rot90=(rot===90||rot===270);
  target.width  = rot90? ch: cw;
  target.height = rot90? cw: ch;
  const tctx=target.getContext('2d');
  tctx.clearRect(0,0,target.width,target.height);
  tctx.save();
  tctx.translate(target.width/2, target.height/2);
  tctx.rotate(rot*Math.PI/180);
  tctx.scale(S.flipH?-1:1, S.flipV?-1:1);
  tctx.drawImage(crop, -cw/2, -ch/2);
  tctx.restore();
}
function drawFilm(){
  renderRadiograph($('film'));
  if(S.bayContent==='image' && S.hasImage) renderRadiograph($('bigFilm'));
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
  $('fnTL').textContent='HAND · '+S.pose;
  $('fnTR').textContent=S.kv+' kVp  '+S.ma+' mA  '+S.mas.toFixed(S.mas<10?1:0)+' mAs';
  $('fnBL').textContent='SID '+S.sid+'  OID '+S.oid+'cm  '+fmtTime(exposureTimeSec())+'  Ē '+spec.meanE.toFixed(0)+'keV';
  $('fnBR').textContent='DR '+S.nx+'×'+S.ny+'  '+S.collX+'×'+S.collZ+'cm  '+(S.gridOn?'GRID '+S.gridRatio+':1':'NO GRID');
}

/* ---- custom model import (.glb) + compute-backend status ---- */
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
  // ping the Python compute backend; light the status dot if it is reachable
  const dot=$('computeDot');
  new ComputeClient().health().then(h=>{ if(!dot)return;
    dot.textContent = h ? '●' : '○';
    dot.style.color = h ? 'var(--green)' : 'var(--muted2)';
    dot.title = h ? ('compute backend online — '+(h.service||'ok')) : 'compute backend offline (optional)';
  });
}

/* ---- boot ---- */
window.addEventListener('load',()=>{
  initScene(); bind(); refreshReadouts(); updateGeomReadouts(); syncScene();
  Sound.init(); initExtras();
  // CT mode lives in its own module; give it the handles it needs from the app glue.
  initCT({ THREE, S, $, three, Sound,
           syncScene, refreshReadouts, updateGeomReadouts, buildHandMeshes,
           poseRot, buildPhantom });
});
