export const REST_LIFT = 1.4;

export function buildHandPrimitives(spread, pose='PA'){
  const skin=[], bone=[];
  const poseRotVal = pose==='PA'?0 : pose==='OBL'?-Math.PI/4 : -Math.PI/2;
  const K=(a,b,r)=>skin.push({a,b,r});                    // constant-radius soft capsule
  const S2=(a,b,r1,r2)=>skin.push({a,b,r1,r2});           // tapered soft tissue (rounded cone)
  const seg=(a,b,r1,r2)=>bone.push({a,b,r1,r2});          // cortical bone segment
  const mar=(a,b,r1,r2)=>bone.push({a,b,r1,r2,mat:'marrow'}); // medullary canal
  const rotY=(dir,ang)=>{ const c=Math.cos(ang),s=Math.sin(ang);
    return [dir[0]*c+dir[2]*s, 0, -dir[0]*s+dir[2]*c]; };
  const lerp=(p,q,t)=>[p[0]+(q[0]-p[0])*t, p[1]+(q[1]-p[1])*t, p[2]+(q[2]-p[2])*t];
  const dist=(p,q)=>Math.hypot(q[0]-p[0],q[1]-p[1],q[2]-p[2]);
  // trim a bone axis inward by proximal/distal joint gaps (cm) -> [a,b]
  const trim=(p,q,g0,g1)=>{ const L=dist(p,q)||1; return [lerp(p,q,g0/L), lerp(p,q,1-g1/L)]; };
  // long bone: wide base -> narrow cortical diaphysis -> flared head, with a
  // spindle-shaped medullary canal down the shaft (=> bright cortical rails,
  // lucent centre — the hallmark of a real long-bone radiograph). mf=canal/shaft.
  const longBone=(p0,p1,rBase,rShaft,rHead,f0,f1,mf=0.60)=>{
    const a=lerp(p0,p1,f0), b=lerp(p0,p1,f1);
    seg(p0,a,rBase,rShaft); seg(a,b,rShaft,rShaft); seg(b,p1,rShaft,rHead);
    if(mf>0){
      const sp=f1-f0, ca=lerp(p0,p1,f0+sp*0.14), cm=lerp(p0,p1,(f0+f1)/2), cb=lerp(p0,p1,f1-sp*0.14);
      const mr=rShaft*mf;
      mar(ca,cm, 0.02, mr); mar(cm,cb, mr, 0.02);        // taper to points so it stays inside cortex
    }
  };
  // articular joint space (cm) left between neighbouring bone ends.
  const G=0.13;
  // longBone placed between joint points, insetting each articular end (jP/jQ) by
  // radius + G/2 so the bone SURFACE stops G/2 short of the joint -> every joint
  // shows a thin, uniform radiolucent line even though the epiphyses stay flared.
  const jointBone=(P,Q,rBase,rShaft,rHead,mf,jP,jQ)=>{
    const gp=jP?rBase+G/2:0.02, gd=jQ?rHead+G/2:0.02;
    const [a,b]=trim(P,Q,gp,gd);
    longBone(a,b, rBase,rShaft,rHead, 0.20,0.80, mf);
  };
  // gentle sagittal (side-profile) arch: a small dorsal rise peaking at the
  // knuckles (z~4.5) and easing to ~0 at the wrist and fingertips, so the hand
  // isn't dead flat. Applied to every point at the end; because bones are built
  // from several segments they each follow the curve and read as slightly arched.
  const archAmp=0.55;
  const archY=(z)=>{ const t=(z+2)/13.5; return (t>0&&t<1)? archAmp*Math.sin(Math.PI*t) : 0; };

  // ================= SKELETON =================
  // ---- distal half of radius & ulna ----
  longBone([-1.0,0,-8.3],[-1.28,0,-3.75], 0.80,0.72,1.16, 0.12,0.74, 0.66); // radius, broad distal metaphysis
  seg([-1.28,0,-3.70],[-1.72,0,-3.12], 0.95,0.20);                    // radial styloid process
  longBone([ 1.0,0,-8.3],[ 1.00,0,-4.15], 0.60,0.52,0.80, 0.12,0.72, 0.62); // ulna, smaller head, sits proximal
  seg([ 1.00,0,-4.10],[ 1.22,0,-3.72], 0.74,0.15);                    // ulnar styloid process

  // ---- 8 carpals (irregular trabecular ossicles with thin inter-carpal spaces) ----
  seg([-1.66,0.05,-3.50],[-1.34,0,-2.94], 0.38,0.44);  // scaphoid
  seg([-0.74,0.05,-3.42],[-0.54,0,-3.00], 0.40,0.42);  // lunate
  seg([ 0.42,0.05,-3.36],[ 0.58,0,-3.04], 0.36,0.38);  // triquetrum
  seg([ 0.84,-0.70,-3.50],[0.94,-0.70,-3.22], 0.32,0.34); // pisiform (palmar)
  seg([-1.56,0.05,-2.44],[-1.42,0,-1.94], 0.35,0.41);  // trapezium (seats the thumb MC)
  seg([-0.68,0.05,-2.60],[-0.58,0,-2.14], 0.32,0.36);  // trapezoid
  seg([ 0.10,0.05,-3.00],[ 0.20,0,-1.96], 0.38,0.50);  // capitate (keystone, extends proximally)
  seg([ 1.08,0.00,-2.74],[ 1.20,0,-2.04], 0.38,0.46);  // hamate

  // ================= SOFT-TISSUE ENVELOPE =================
  // Palm/forearm masses; the digits are built as one continuous slender sheath
  // each (below), so the metacarpal region and fingers read smooth, not lumpy.
  // Thinner palm so the hand rests low: palmar soft between bone and detector <2cm.
  K([-1.6,0,-8.6],[1.6,0,-5.6], 2.0);        // forearm
  K([-1.8,0,-6.2],[1.8,0,-3.1], 1.9);        // wrist
  K([-2.4,0,0.7],[2.7,0,0.7], 1.12);         // distal palm (over the metacarpals)
  K([-2.5,0,-0.8],[2.5,0,-0.8], 1.28);       // mid palm
  K([-2.3,0,-2.1],[2.1,0,-2.1], 1.18);       // proximal palm -> wrist
  K([-3.2,0,-1.2],[-1.7,0,1.6], 1.20);       // thenar eminence (radial bulk)
  K([ 2.6,0,-1.3],[2.4,0,1.3], 0.95);        // hypothenar eminence (ulnar bulk)

  // ---- five metacarpals + fingers/phalanges ----
  // Metacarpal bases converge on the distal carpal row and fan out to the
  // knuckles; every articular end is inset (jointBone) so each joint shows the
  // thin, open radiolucent space seen on a real PA hand.
  const fingers=[
    // cmc (base, at carpus), mcp (knuckle), phalanx lengths, thickness, abduction sign
    {cmc:[-0.75,0,-1.5], mcp:[-2.30,0,4.5], ph:[2.6,1.6,1.1], br:0.42, ab:-0.28},  // index
    {cmc:[ 0.10,0,-1.6], mcp:[-0.40,0,5.1], ph:[3.0,1.9,1.2], br:0.44, ab:-0.05},  // middle
    {cmc:[ 0.75,0,-1.6], mcp:[ 1.30,0,4.7], ph:[2.8,1.8,1.1], br:0.42, ab: 0.16},  // ring
    {cmc:[ 1.20,0,-1.5], mcp:[ 2.70,0,3.9], ph:[2.2,1.3,0.9], br:0.37, ab: 0.36},  // little
  ];
  const MC=[0.52,0.32,0.56];                        // metacarpal base/shaft/head cortical radii
  const PH=[[0.50,0.30,0.44],[0.42,0.26,0.38],[0.36,0.23,0.44]]; // per-phalanx radii
  const PHmf=[0.60,0.58,0];                          // marrow-canal fraction (distal ~solid)
  // Build a digit's phalanges flexed at the MCP + IP joints so the tip settles onto
  // the board (world y ~ 0), like a relaxed hand. The digit starts at the arched
  // knuckle height and curls palmar-ward; flexion is solved so the drop lands the
  // tip on the receptor. Everything it emits is tagged .flex so the dorsal arch
  // applied afterwards leaves it alone (it already carries its own y).
  function flexDigit(mcp, hdir, phLens, phRad, phMf, softR, cb, startY){
    const n=phLens.length, y0=(startY!==undefined?startY:archY(mcp[2]));
    const targetDrop=Math.max(0, y0 + REST_LIFT - 0.6);   // leaves the soft fingertip pad resting on the board
    let s=0.2;                                             // solve curl scale: sum(L*sin(cb*s))=targetDrop
    for(let it=0;it<50;it++){ let drop=0,dd=0;
      for(let k=0;k<n;k++){ const a=cb[k]*s; drop+=phLens[k]*Math.sin(a); dd+=phLens[k]*cb[k]*Math.cos(a); }
      s+=(targetDrop-drop)/Math.max(dd,1e-3); s=Math.max(0,Math.min(1.3,s)); }
    const J=[[mcp[0],y0,mcp[2]]];
    for(let k=0;k<n;k++){ const a=cb[k]*s, dv=[hdir[0]*Math.cos(a),-Math.sin(a),hdir[2]*Math.cos(a)];
      const p=J[k],L=phLens[k]; J.push([p[0]+dv[0]*L,p[1]+dv[1]*L,p[2]+dv[2]*L]); }
    for(let idx=0;idx<n;idx++){ const p=J[idx],q=J[idx+1],[rb,rs,rh]=phRad[idx];
      if(idx<n-1){ jointBone(p,q, rb,rs,rh, phMf[idx], true, true); }
      else { const gp=rb+G/2,[a,b]=trim(p,q,gp,0),m=lerp(a,b,0.52); seg(a,m,rb,rs); seg(m,b,rs,rh); } }
    for(let idx=0;idx<n;idx++) S2(J[idx],J[idx+1], softR[idx], softR[idx+1]);
    const last=J[n],prev=J[n-1], dv=[last[0]-prev[0],last[1]-prev[1],last[2]-prev[2]], dl=Math.hypot(dv[0],dv[1],dv[2])||1;
    S2(last,[last[0]+dv[0]/dl*0.34,last[1]+dv[1]/dl*0.34,last[2]+dv[2]/dl*0.34], softR[n], softR[n]*0.72);
  }
  // metacarpals (dorsal-arched) + the palm->knuckle soft that connects to the digit
  for(const f of fingers){
    const sc=f.br/0.44;
    const mcProx=[f.cmc[0], 0, f.cmc[2]-0.55];
    jointBone(mcProx, f.mcp, MC[0]*sc, MC[1]*sc, MC[2]*sc, 0.60, true, true);
    S2(f.cmc, f.mcp, 0.86*sc, 0.66*sc);              // metacarpal soft (palm -> knuckle waist)
  }
  // ---- flexed digits (finger tips resting on the receptor) ----
  const bStart=bone.length, sStart=skin.length;
  for(const f of fingers){
    const sc=f.br/0.44, hdir=rotY([0,0,1], f.ab*spread);
    flexDigit(f.mcp, hdir, f.ph, PH.map(r=>r.map(v=>v*sc)), PHmf,
              [0.66*sc,0.74*sc,0.66*sc,0.58*sc], [1,2,3.2]);
  }
  // ---- thumb: built as one unit so the lateral view can drop it parallel to the board ----
  const tBone0=bone.length, tSkin0=skin.length;
  {
    const tCmc=[-1.80,0,-1.75], tMcp=[-3.45,0,1.7];   // 1st MC base seated at the trapezium
    jointBone(tCmc, tMcp, 0.50,0.38,0.54, 0.58, true, true);
    S2(tCmc, tMcp, 0.90, 0.72);
    let base=[tMcp[0]-tCmc[0],0,tMcp[2]-tCmc[2]]; const bl=Math.hypot(base[0],base[2])||1; base=[base[0]/bl,0,base[2]/bl];
    const hdir=rotY(base, -0.30*spread);
    // LATERAL: thumb extended flat (cb=0) so it lies parallel to the board; other
    // views: flexed like the fingers so its tip rests on the receptor.
    const tCb = pose==='LAT' ? [0,0] : [1,2.2];
    // thumb metacarpal is un-arched (its own flex unit) -> start phalanges at its head (y=0)
    flexDigit(tMcp, hdir, [2.5,1.9], [[0.50,0.34,0.46],[0.42,0.26,0.46]], [0.58,0], [0.72,0.70,0.58], tCb, 0);
    // LATERAL: counter-rotate the whole thumb about its CMC so that after the
    // pose's -90° roll it lies parallel to the detector (dropped) rather than
    // swinging up with the hand. Net thumb roll = 0 => stays in the PA plane.
    if(pose==='LAT'){
      const c=Math.cos(-poseRotVal), s=Math.sin(-poseRotVal), px=tCmc[0], py=tCmc[1];
      const rz=(p)=>{ const dx=p[0]-px, dy=p[1]-py; return [px+dx*c-dy*s, py+dx*s+dy*c, p[2]]; };
      for(let i=tBone0;i<bone.length;i++){ bone[i].a=rz(bone[i].a); bone[i].b=rz(bone[i].b); }
      for(let i=tSkin0;i<skin.length;i++){ skin[i].a=rz(skin[i].a); skin[i].b=rz(skin[i].b); }
    }
    for(let i=tBone0;i<bone.length;i++) bone[i].thumb=true;
    for(let i=tSkin0;i<skin.length;i++) skin[i].thumb=true;
  }
  for(let i=bStart;i<bone.length;i++) bone[i].flex=true;
  for(let i=sStart;i<skin.length;i++) skin[i].flex=true;
  // apply the dorsal sagittal arch to every NON-flexed endpoint (flexed digits carry their own y)
  const bend=(c)=>{ c.a=[c.a[0], c.a[1]+archY(c.a[2]), c.a[2]]; c.b=[c.b[0], c.b[1]+archY(c.b[2]), c.b[2]]; };
  for(const c of skin) if(!c.flex) bend(c);
  for(const c of bone) if(!c.flex) bend(c);
  return {skin, bone};
}

/* 3D positioning view can show the soft-tissue anatomy (default) OR just the
   skeleton — a DISPLAY choice only (S.handView); the simulated image is always
   computed from the full soft+bone phantom regardless. Both are built as tapered
   capsules so the mesh matches the ray-traced geometry exactly. */
