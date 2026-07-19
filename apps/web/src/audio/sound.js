import { AUDIO_B64 } from './data.js';

// CT patient sounds shipped as assets (public/sounds); the CT scan-exposure sound
// reuses the x-ray 'buzz'. Loaded from URL on init alongside the embedded set.
const URL_SOUNDS = {
  breathIn: '/sounds/CTBreathIn.wav',
  breathNormal: '/sounds/CTBreathNormal.wav',
};

export const Sound=(()=>{
  let ctx=null; const buf={}; let buzzSrc=null; let inited=false;
  function b2ab(b64){const bin=atob(b64),n=bin.length,u=new Uint8Array(n);for(let i=0;i<n;i++)u[i]=bin.charCodeAt(i);return u.buffer;}
  async function init(){ if(inited)return; inited=true;
    try{ctx=new (window.AudioContext||window.webkitAudioContext)();}catch(e){return;}
    for(const k in AUDIO_B64){ try{buf[k]=await ctx.decodeAudioData(b2ab(AUDIO_B64[k]));}catch(e){console.warn("audio decode failed",k);} }
    for(const k in URL_SOUNDS){ try{const r=await fetch(URL_SOUNDS[k]); buf[k]=await ctx.decodeAudioData(await r.arrayBuffer());}catch(e){console.warn("audio fetch failed",k);} } }
  function resume(){ if(ctx&&ctx.state==="suspended") ctx.resume(); }
  function play(name,onended){ if(!ctx||!buf[name])return; const s=ctx.createBufferSource(); s.buffer=buf[name]; s.connect(ctx.destination); if(onended)s.onended=onended; try{s.start();}catch(e){} }
  function duration(name){ return buf[name] ? buf[name].duration : 0; }
  function startBuzz(){ if(!ctx||!buf.buzz)return; stopBuzz(); const s=ctx.createBufferSource(); s.buffer=buf.buzz; s.loop=true; s.connect(ctx.destination); try{s.start();}catch(e){} buzzSrc=s; }
  function stopBuzz(){ if(buzzSrc){ try{buzzSrc.stop();}catch(e){} buzzSrc=null; } }
  return {init,resume,play,duration,startBuzz,stopBuzz};
})();
