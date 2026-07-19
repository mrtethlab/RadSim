/* ============================================================================
   MODULE 3 — PHANTOM
   Analytic geometry (capsules, tapered capsules/rounded cones + boxes) in WORLD
   coordinates (cm). Each primitive carries a material id. A broad-phase bounding
   sphere rejects far primitives cheaply. Pure geometry query: given a ray, return
   union path-length spent in each material (bone nested inside soft is handled
   by subtracting bone from soft). No renderer dependency — CT reuses this.
   ============================================================================ */
export class Phantom{
  constructor(){ this.caps=[]; this.cones=[]; this.boxes=[]; }
  // bounding sphere for broad-phase rejection (center xyz + radius)
  static bsphere(a,b,r1,r2){
    return [(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2,
            Math.hypot(b[0]-a[0],b[1]-a[1],b[2]-a[2])/2+Math.max(r1,r2)];
  }
  addCapsule(a,b,r,mat){ this.caps.push({a,b,r,mat,bs:Phantom.bsphere(a,b,r,r)}); }
  // tapered capsule (rounded cone): swept sphere, radius r1 at a -> r2 at b.
  // The narrow-shaft / flared-end primitive that gives bones realistic form.
  addCone(a,b,r1,r2,mat){ this.cones.push({a,b,r1,r2,mat,bs:Phantom.bsphere(a,b,r1,r2)}); }
  addBox(min,max,mat){ this.boxes.push({min,max,mat}); }
  // quick reject: does the ray's line miss the primitive's bounding sphere? (d unit)
  static missSphere(o,d,bs){
    const wx=bs[0]-o[0],wy=bs[1]-o[1],wz=bs[2]-o[2];
    const tc=wx*d[0]+wy*d[1]+wz*d[2];
    return (wx*wx+wy*wy+wz*wz-tc*tc) > bs[3]*bs[3];
  }

  // --- ray vs capsule => [t0,t1] interval inside (or null). Convex => 1 interval.
  static rayCapsule(o,d, a,b,r){
    // segment ab, direction ba
    const bax=b[0]-a[0], bay=b[1]-a[1], baz=b[2]-a[2];
    const baba=bax*bax+bay*bay+baz*baz;
    let lo=Infinity, hi=-Infinity, hit=false;
    // infinite cylinder around ab
    const oax=o[0]-a[0], oay=o[1]-a[1], oaz=o[2]-a[2];
    const bad = bax*d[0]+bay*d[1]+baz*d[2];
    const bao = bax*oax+bay*oay+baz*oaz;
    const A = baba - bad*bad;
    const k = oax*oax+oay*oay+oaz*oaz - bao*bao/ (baba||1e-9);
    // solve A t^2 + 2B t + C where using projected components:
    const dd = d[0]*d[0]+d[1]*d[1]+d[2]*d[2];
    const oad = oax*d[0]+oay*d[1]+oaz*d[2];
    const A2 = dd - bad*bad/(baba||1e-9);
    const B2 = oad - bao*bad/(baba||1e-9);
    const C2 = (oax*oax+oay*oay+oaz*oaz) - bao*bao/(baba||1e-9) - r*r;
    const disc = B2*B2 - A2*C2;
    if(A2>1e-9 && disc>=0){
      const s=Math.sqrt(disc);
      for(const t of [(-B2-s)/A2, (-B2+s)/A2]){
        const y = bao + t*bad;         // projection param * baba
        if(y>=0 && y<=baba){ lo=Math.min(lo,t); hi=Math.max(hi,t); hit=true; }
      }
    }
    // end spheres
    for(const c of [a,b]){
      const ox=o[0]-c[0], oy=o[1]-c[1], oz=o[2]-c[2];
      const bq = ox*d[0]+oy*d[1]+oz*d[2];
      const cq = ox*ox+oy*oy+oz*oz - r*r;
      const disc2 = bq*bq - dd*cq;
      if(disc2>=0){
        const s=Math.sqrt(disc2);
        const t0=(-bq-s)/dd, t1=(-bq+s)/dd;
        lo=Math.min(lo,t0,t1); hi=Math.max(hi,t0,t1); hit=true;
      }
    }
    if(!hit) return null;
    return [lo,hi];
  }
  // --- ray vs rounded cone (tapered capsule) => [t0,t1] interval, or null.
  // Convex swept sphere: radius ra at pa, rb at pb. Analytic tangent-cone +
  // end-cap solution (after Inigo Quilez); assumes d is a unit vector. Collecting
  // the extreme valid roots recovers the entry/exit interval, like rayCapsule.
  static rayRoundedCone(o,d, pa,pb, ra,rb){
    const bax=pb[0]-pa[0], bay=pb[1]-pa[1], baz=pb[2]-pa[2];
    const oax=o[0]-pa[0], oay=o[1]-pa[1], oaz=o[2]-pa[2];
    const obx=o[0]-pb[0], oby=o[1]-pb[1], obz=o[2]-pb[2];
    const rr=ra-rb;
    const m0=bax*bax+bay*bay+baz*baz;
    const m1=bax*oax+bay*oay+baz*oaz;
    const m2=bax*d[0]+bay*d[1]+baz*d[2];
    const m3=d[0]*oax+d[1]*oay+d[2]*oaz;
    const m5=oax*oax+oay*oay+oaz*oaz;
    const m6=d[0]*obx+d[1]*oby+d[2]*obz;
    const m7=obx*obx+oby*oby+obz*obz;
    const d2=m0-rr*rr;
    let lo=Infinity, hi=-Infinity, hit=false;
    // lateral tangent-cone surface (clamped to the valid band between tangencies)
    const k2=d2 - m2*m2;
    const k1=d2*m3 - m1*m2 + m2*rr*ra;
    const k0=d2*m5 - m1*m1 + 2*m1*rr*ra - m0*ra*ra;
    const h=k1*k1 - k0*k2;
    if(Math.abs(k2)>1e-12 && h>=0){
      const s=Math.sqrt(h);
      for(const t of [(-k1-s)/k2,(-k1+s)/k2]){
        const y=m1 - ra*rr + t*m2;
        if(y>0 && y<d2){ if(t<lo)lo=t; if(t>hi)hi=t; hit=true; }
      }
    }
    // end caps (spheres at pa, pb). Any surface hit lies within the convex solid,
    // so taking the extremes is safe.
    const h1=m3*m3 - m5 + ra*ra;
    if(h1>=0){ const s=Math.sqrt(h1), t0=-m3-s, t1=-m3+s;
      lo=Math.min(lo,t0,t1); hi=Math.max(hi,t0,t1); hit=true; }
    const h2=m6*m6 - m7 + rb*rb;
    if(h2>=0){ const s=Math.sqrt(h2), t0=-m6-s, t1=-m6+s;
      lo=Math.min(lo,t0,t1); hi=Math.max(hi,t0,t1); hit=true; }
    if(!hit) return null;
    return [lo,hi];
  }
  static rayBox(o,d,min,max){
    let t0=-Infinity,t1=Infinity;
    for(let i=0;i<3;i++){
      const inv=1/(d[i]||1e-9);
      let ta=(min[i]-o[i])*inv, tb=(max[i]-o[i])*inv;
      if(ta>tb){const t=ta;ta=tb;tb=t;}
      t0=Math.max(t0,ta); t1=Math.min(t1,tb);
    }
    if(t1<t0) return null; return [t0,t1];
  }
  static unionLen(intervals){
    if(!intervals.length) return 0;
    intervals.sort((p,q)=>p[0]-q[0]);
    let len=0, cs=intervals[0][0], ce=intervals[0][1];
    for(let i=1;i<intervals.length;i++){
      const [s,e]=intervals[i];
      if(s>ce){ len+=ce-cs; cs=s; ce=e; } else ce=Math.max(ce,e);
    }
    return len + (ce-cs);
  }
  // ray (origin o, unit dir d) -> {bone, soft, marrow} path lengths in cm.
  // maxT clips to the source->detector-cell segment so material past the detector
  // (e.g. anatomy dipping below the receptor plane) is never counted.
  trace(o,d,maxT=Infinity){
    const bone=[], soft=[], marrow=[];
    const bin=(mat)=> mat==='bone'?bone : mat==='marrow'?marrow : soft;
    const add=(iv,mat)=>{ if(!iv) return; const lo=Math.max(iv[0],0), hi=Math.min(iv[1],maxT); if(hi>lo) bin(mat).push([lo,hi]); };
    for(const c of this.caps){
      if(Phantom.missSphere(o,d,c.bs)) continue;
      add(Phantom.rayCapsule(o,d,c.a,c.b,c.r), c.mat);
    }
    for(const c of this.cones){
      if(Phantom.missSphere(o,d,c.bs)) continue;
      add(Phantom.rayRoundedCone(o,d,c.a,c.b,c.r1,c.r2), c.mat);
    }
    for(const bx of this.boxes){
      add(Phantom.rayBox(o,d,bx.min,bx.max), bx.mat);
    }
    // nested materials: marrow inside cortical bone inside soft tissue
    const marrowLen = Phantom.unionLen(marrow);
    const boneU     = Phantom.unionLen(bone);
    const softU     = Phantom.unionLen(soft);
    return {
      marrow: marrowLen,
      bone:   Math.max(0, boneU - marrowLen),   // cortical shell = bone minus its canal
      soft:   Math.max(0, softU - boneU),        // soft displaced by all bone
    };
  }
}

