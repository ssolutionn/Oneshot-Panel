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
function canvasSmoke(image) {
  if (!image) return null;
  const surface=document.createElement('canvas');
  surface.width=768;surface.height=432;
  const ctx=surface.getContext('2d');
  if (!ctx) return null;
  return {
    kind:'canvas',
    draw(seconds) {
      const w=surface.width,h=surface.height;
      const scale=Math.max(w/image.width,h/image.height)*1.10;
      const dw=image.width*scale,dh=image.height*scale;
      const x=(w-dw)/2+Math.sin(seconds*.16)*w*.025;
      const y=(h-dh)/2+Math.cos(seconds*.12)*h*.025;
      ctx.drawImage(image,x,y,dw,dh);
      const glow=ctx.createRadialGradient(
        w*(.55+Math.sin(seconds*.13)*.12),h*.35,0,w*.55,h*.45,w*.65);
      glow.addColorStop(0,'#00cfe820');glow.addColorStop(1,'#00121c38');
      ctx.fillStyle=glow;ctx.fillRect(0,0,w,h);
      return surface;
    },
    dispose() {}
  };
}

export function makeSmoke(image) {
  const surface = document.createElement('canvas');
  surface.width = 768; surface.height = 432;
  const gl = surface.getContext('webgl', { alpha:false, antialias:false, depth:false, powerPreference:'low-power' });
  if (!gl || !image) return canvasSmoke(image);
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
