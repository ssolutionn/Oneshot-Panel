import {readFileSync} from 'node:fs';
const SCHEMAS=JSON.parse(readFileSync(new URL('./bb-schemas.json',import.meta.url),'utf8'));
const defaults=JSON.parse(readFileSync('work/public-feed.json','utf8'));
const byType=new Map(SCHEMAS.map(s=>[s.symbol,s]));
const utf=new TextEncoder(),str=new TextDecoder();
function vint(value){let n=BigInt(value),a=[];do{let b=Number(n&127n);n>>=7n;a.push(b|(n?128:0));}while(n);return a;}
function encode(type,obj){
 const out=[];
 for(const f of byType.get(type).fields){
  if(obj[f.name]===undefined||obj[f.name]===null)continue;
  const values=f.repeat?obj[f.name]:[obj[f.name]];
  for(const v of values){
   if(f.kind==='message'||f.type===9||f.type===12){
    const raw=f.kind==='message'?encode(f.type,v):f.type===9?utf.encode(String(v)):v;
    out.push(...vint(f.n*8+2),...vint(raw.length),...raw);
   }else out.push(...vint(f.n*8),...vint(v===true?1:v===false?0:v));
  }
 }
 return Uint8Array.from(out);
}
function decode(type,input,depth=0){
 if(depth>24||input.length>4000000)throw Error('packet bounds');
 const info=byType.get(type);if(!info)return{};
 const fields=new Map(info.fields.map(f=>[f.n,f])),obj={};let p=0;
 for(const f of info.fields)if(f.repeat)obj[f.name]=[];else if(f.kind!=='message')obj[f.name]=f.type===9?'':f.type===8?false:0;
 function take(n){if(n<0||p+n>input.length)throw Error('truncated');const b=input.subarray(p,p+n);p+=n;return b;}
 function integer(){let n=0n,s=0n;for(let i=0;i<10;i++){const v=take(1)[0];n|=BigInt(v&127)<<s;if(!(v&128))return n;s+=7n;}throw Error('large varint');}
 let count=0;
 while(p<input.length){
  if(++count>100000)throw Error('field limit');
  const tag=Number(integer()),wire=tag&7,f=fields.get(tag>>3);let value;
  if(wire===0){const n=integer();value=f?.type===8?n!==0n:n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):String(n);}
  else if(wire===2){const raw=take(Number(integer()));value=f?.kind==='message'?decode(f.type,raw,depth+1):f?.type===9?str.decode(raw):raw;}
  else if(wire===1){const b=take(8);value=f?.type===1?new DataView(b.buffer,b.byteOffset,8).getFloat64(0,true):0;}
  else if(wire===5){const b=take(4);value=f?.type===2?new DataView(b.buffer,b.byteOffset,4).getFloat32(0,true):0;}
  else throw Error('wire');
  if(!f)continue;if(f.repeat)obj[f.name].push(value);else obj[f.name]=value;
 }
 return obj;
}
const socket=new WebSocket(defaults.url);socket.binaryType='arraybuffer';
const timeout=setTimeout(()=>socket.close(),12000);
let asked=false;
socket.addEventListener('open',()=>{
 console.log('BB_PUBLIC_CONNECTED');
 const settings={uid:crypto.randomUUID(),language:defaults.language};
 if(defaults.timeFilter!==null)settings.time_filter=defaults.timeFilter;
 socket.send(encode('Ys',{settings_set:settings}));
});
socket.addEventListener('error',()=>console.log('BB_PUBLIC_CONNECTION_ERROR'));
socket.addEventListener('message',e=>{
 try{
  if(typeof e.data==='string'){console.log('BB_PUBLIC_TEXT:',e.data.length);return;}
  const message=decode('Xs',new Uint8Array(e.data));
  const settings=message.settings_set;
  if(settings){console.log('BB_SETTINGS_RESULT:',JSON.stringify({code:settings.code,status:settings.status,message:settings.error?.message}));
   if(settings.code===200&&!asked){asked=true;socket.send(encode('Ys',{tournaments_subscribe_full:{uid:crypto.randomUUID(),full_tournaments:[{uid:crypto.randomUUID(),tournament_id:39428}]}}));}
   else if(settings.code!==200)socket.close();
  }
  if(message.error){console.log('BB_PUBLIC_PROTOCOL_ERROR:',JSON.stringify({code:message.error.code,status:message.error.status,message:message.error.error?.message}));socket.close();}
  const result=message.tournaments_subscribe_full;
  if(result){
   const clean=x=>Array.isArray(x)?x.map(clean):x&&typeof x==='object'&&!(x instanceof Uint8Array)?Object.fromEntries(Object.entries(x).filter(([k])=>!['uid','uuid'].includes(k)).map(([k,v])=>[k,clean(v)])):x;
   console.log('BB_REAL_PUBLIC_TOURNAMENT:',JSON.stringify(clean(result)));
   socket.close();
  }
 }catch(error){console.log('BB_PUBLIC_DECODE_ERROR:',error.message);socket.close();}
});
await new Promise(resolve=>socket.addEventListener('close',event=>{console.log('BB_PUBLIC_CLOSED:',event.code);resolve();}));
clearTimeout(timeout);
