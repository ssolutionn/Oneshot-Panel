import {VETO_RULES} from '../core.js';
import {decodeLink} from '../veto-room.js';

export function progressView(format,cards,ready=true,reveal=true){
 const rules=[...(VETO_RULES[format]||VETO_RULES.BO3),format==='BO1'?'play':format==='BO2'?'map 2':'decider'];
 const taken=cards.filter(c=>c.status==='ban'||c.status==='pick');
 const pending=taken.some(c=>c.status==='pick'&&!c.side);
 const finished=reveal&&cards.some(c=>c.status==='decider');
 const current=pending?taken.length-1:taken.length;
 return rules.map((kind,i)=>({kind,label:kind.toUpperCase(),
  state:finished||i<current?'done':ready&&reveal&&i===current?'active':'future'}));
}

// Domain-warp the existing CyberClash artwork, rather than requesting video or
// using external assets. The small GPU surface is composited into the 1080p scene.
const VERTEX = 'attribute vec2 p; varying vec2 uv; void main(){uv=(p+1.0)*0.5;gl_Position=vec4(p,0.0,1.0);}';
const FRAGMENT = `
precision mediump float;
varying vec2 uv;
uniform sampler2D artwork;
uniform float t;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){
  vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),
    mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),f.x),f.y);
}
float fbm(vec2 p){
  float a=0.5,v=0.0;
  for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.03+vec2(3.7,7.1);a*=0.5;}
  return v;
}
void main(){
  vec2 v=vec2(uv.x,1.0-uv.y),p=v*vec2(3.7,2.1);
  vec2 q=vec2(fbm(p+vec2(t*0.025,-t*0.017)),
              fbm(p+vec2(4.3+t*0.015,1.7+t*0.023)));
  vec2 drift=(q-0.5)*0.055+vec2(sin(t*0.065)*0.012,cos(t*0.045)*0.015);
  vec3 base=texture2D(artwork,clamp(v*0.94+0.03+drift,0.0,1.0)).rgb;
  float fog=fbm(p+q*2.6+vec2(-t*0.017,t*0.011));
  float glow=smoothstep(0.32,0.84,fog);
  vec3 cyan=vec3(0.0,0.68,0.81);
  vec3 c=base*0.70+cyan*glow*0.40;
  float edge=1.0-smoothstep(0.15,1.1,distance(v,vec2(0.55,0.4)));
  c*=0.72+edge*0.28;
  gl_FragColor=vec4(c,1.0);
}`;

// OBS can run its browser with WebGL disabled. Keep the same cloud artwork
// moving on a small Canvas2D surface instead of silently freezing the backdrop.
// The artwork is scaled once; each frame only shifts it (cheap on any CPU).
function canvasSmoke(image) {
  if (!image) return null;
  const surface=document.createElement('canvas');
  surface.width=768;surface.height=432;
  const ctx=surface.getContext('2d');
  if (!ctx) return null;
  const w=surface.width,h=surface.height;
  const scale=Math.max(w/image.width,h/image.height)*1.10;
  const base=document.createElement('canvas');
  base.width=Math.ceil(image.width*scale);base.height=Math.ceil(image.height*scale);
  base.getContext('2d')?.drawImage(image,0,0,base.width,base.height);
  return {
    kind:'canvas',
    draw(seconds) {
      const x=(w-base.width)/2+Math.sin(seconds*.16)*w*.025;
      const y=(h-base.height)/2+Math.cos(seconds*.12)*h*.025;
      ctx.drawImage(base,x,y);
      const glow=ctx.createRadialGradient(
        w*(.55+Math.sin(seconds*.13)*.12),h*.35,0,w*.55,h*.45,w*.65);
      glow.addColorStop(0,'#00cfe820');glow.addColorStop(1,'#00121c38');
      ctx.fillStyle=glow;ctx.fillRect(0,0,w,h);
      return surface;
    },
    dispose() {}
  };
}

function makeSmoke(image) {
  const surface = document.createElement('canvas');
  surface.width = 768; surface.height = 432;
  const gl = surface.getContext('webgl', { alpha:false, antialias:false, depth:false, powerPreference:'low-power' });
  if (!gl || !image) return canvasSmoke(image);
  // Without a real GPU (no hardware acceleration, VMs, CI) the shader runs on
  // the CPU and slows the whole veto page down: the cheap moving artwork then.
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '')) {
    return canvasSmoke(image);
  }
  const shader = (type, source) => {
    const item = gl.createShader(type);
    gl.shaderSource(item, source); gl.compileShader(item);
    if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) throw new Error('Smoke shader');
    return item;
  };
  try {
    const vs=shader(gl.VERTEX_SHADER,VERTEX), fs=shader(gl.FRAGMENT_SHADER,FRAGMENT);
    const program=gl.createProgram();
    gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)) return canvasSmoke(image);
    gl.useProgram(program);
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const p=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(p);gl.vertexAttribPointer(p,2,gl.FLOAT,false,0,0);
    const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
    gl.uniform1i(gl.getUniformLocation(program,'artwork'),0);
    const time=gl.getUniformLocation(program,'t');
    gl.viewport(0,0,surface.width,surface.height);
    let lost=false,backup=null;
    surface.addEventListener('webglcontextlost',event=>{event.preventDefault();lost=true;});
    return {
      kind:'webgl',
      draw(seconds) {
        if(lost) { backup ||= canvasSmoke(image); return backup?.draw(seconds) || null; }
        gl.uniform1f(time,seconds);gl.drawArrays(gl.TRIANGLES,0,6);
        return surface;
      },
      dispose() {gl.deleteTexture(texture);gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);}
    };
  } catch { return canvasSmoke(image); }
}


function appearance(){
 const maps=document.getElementById('vtMaps'),teams=document.querySelector('.vt-teams'),room=document.getElementById('vtRoom');
 if(!maps||!teams||!room)return;
 const nav=document.createElement('nav');nav.className='vt-progress';
 const list=document.createElement('ol');nav.append(list);teams.after(nav);
 const format=decodeLink(location.hash)?.f||'BO3';
 let previous=null,reveal=true,revealTimer=0;
 function paintProgress(){
  const ru=document.documentElement.lang==='ru';nav.setAttribute('aria-label',ru?'Порядок вето':'Veto progress');
  const cards=[...maps.querySelectorAll('.vt-map')].map(el=>({
   status:el.dataset.status,
   side:/(?:^| · )(?:CT|T)$/.test(el.querySelector('.vt-map-side')?.textContent||'')
  }));
  const taken=cards.filter(c=>c.status==='ban'||c.status==='pick').length;
  if(cards.some(c=>c.status==='decider')&&previous!==null&&previous<6&&reveal){
   reveal=false;room.classList.add('vt-reveal-pending');
   clearTimeout(revealTimer);revealTimer=setTimeout(()=>{reveal=true;room.classList.remove('vt-reveal-pending');paintProgress()},1500);
  }
  previous=taken;
  const ready=!!document.getElementById('vtCoin')?.hidden;
  const state=progressView(format,cards,ready,reveal),signature=JSON.stringify(state);
  if(list.dataset.view===signature)return;list.dataset.view=signature;
  list.replaceChildren(...state.map((step,i)=>{
   const li=document.createElement('li');li.className='vt-progress-step';
   li.dataset.kind=step.kind;li.dataset.state=step.state;
   if(step.state==='active')li.setAttribute('aria-current','step');
   const number=document.createElement('span');number.className='vt-progress-number';number.textContent=String(i+1);
   const label=document.createElement('span');label.className='vt-progress-label';label.textContent=step.label;
   li.append(number,label);return li;
  }));
 }
 const observer=new MutationObserver(paintProgress);
 observer.observe(maps,{childList:true,subtree:true,attributes:true,attributeFilter:['data-status']});
 observer.observe(document.getElementById('vtCoin'),{attributes:true,attributeFilter:['hidden']});
 observer.observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
 paintProgress();
}
function smokeBackdrop(){
 let mount=document.querySelector('.vt-smoke-background');
 if(!mount){mount=document.createElement('div');mount.className='vt-smoke-background';mount.setAttribute('aria-hidden','true');document.body.prepend(mount);}
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let renderer,frame=0,last=0,time=0,previousDraw=0;
 function draw(now){
  frame=0;
  if(document.hidden||reduced.matches)return;
  if(last)time+=Math.min((now-last)/1000,.1);last=now;
  if(now-previousDraw>=(renderer?.kind==='canvas'?66:33)){
   try{const surface=renderer?.draw(time);if(surface&&mount.firstChild!==surface)mount.replaceChildren(surface)}catch{return}
   previousDraw=now;
  }
  frame=requestAnimationFrame(draw);
 }
 function resume(){last=0;if(!document.hidden&&!reduced.matches&&renderer&&!frame)frame=requestAnimationFrame(draw)}
 const image=new Image();image.onload=()=>{
  try{renderer=makeSmoke(image);if(renderer)mount.dataset.renderer=renderer.kind;const surface=renderer?.draw(0);if(surface)mount.replaceChildren(surface);resume()}catch{/* visual fallback only */}
 };image.src='/assets/veto-backdrop.jpg';
 document.addEventListener('visibilitychange',resume);
 reduced.addEventListener?.('change',resume);
 addEventListener('pagehide',()=>{cancelAnimationFrame(frame);renderer?.dispose()},{once:true});
}
if(typeof document!=='undefined'){
 try{appearance()}catch{/* decorative layer must never interrupt veto */}
 try{smokeBackdrop()}catch{/* static background remains available */}
}
