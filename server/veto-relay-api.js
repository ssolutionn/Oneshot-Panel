import {MAX_PACKET_BYTES,KEEP_MS,topicValid,packetShape,verifyRelayPacket} from '../assets/veto-relay-protocol.js';
export const relayHeaders={
 'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',
 'referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; frame-ancestors 'none'; form-action 'none'",
 'access-control-allow-origin':'*','access-control-allow-methods':'GET, POST, OPTIONS',
 'access-control-allow-headers':'Content-Type','access-control-max-age':'600'
};
export const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:relayHeaders});
export function topicList(request) {
 const params=new URL(request.url).searchParams;
 if([...params.keys()].some(k=>k!=='topics')||params.getAll('topics').length!==1)return null;
 const ids=params.get('topics')?.split(',');
 return ids?.length&&ids.length<=4&&ids.every(topicValid)?[...new Set(ids)]:null;
}
export async function readJsonBody(request, maxBytes=MAX_PACKET_BYTES) {
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))throw Error('type');
 if(Number(request.headers.get('content-length'))>maxBytes)throw Error('size');
 const reader=request.body?.getReader();if(!reader)throw Error('body');
 const chunks=[];let total=0,timer;
 try{
  await Promise.race([(async()=>{
   while(true){const {done,value}=await reader.read();if(done)break;
    total+=value.length;if(total>maxBytes)throw Error('size');chunks.push(value);}
  })(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),8000);})]);
 }finally{clearTimeout(timer);reader.cancel().catch(()=>{});}
 const all=new Uint8Array(total);let offset=0;for(const c of chunks){all.set(c,offset);offset+=c.length;}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));
}
export async function readRelayPacket(request) {
 const packet=await readJsonBody(request);
 if(!packetShape(packet))throw Error('shape');return packet;
}
export async function handleRelay(request,store,now=Date.now()) {
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:relayHeaders});
 if(!['GET','POST'].includes(request.method))return new Response(JSON.stringify({error:'method'}),{
  status:405,headers:{...relayHeaders,allow:'GET, POST, OPTIONS'}});
 if(!store)return reply({protocol:1,ready:false,error:'relay-not-configured'},503);
 const params=new URL(request.url).searchParams;
 if(request.method==='GET'){
  if(params.get('health')==='1'&&[...params.keys()].length===1)return reply({protocol:1,ready:true});
  const ids=topicList(request);if(!ids)return reply({error:'topics'},400);
  try{
   const records=(await Promise.all(ids.map(async topic=>{
    const row=await store.read(topic);
    return row&&row.expiresAt>now&&row.packet?.topic===topic?{packet:row.packet,receivedAt:row.receivedAt}:null;
   }))).filter(Boolean);
   return reply({protocol:1,now,records});
  }catch{return reply({error:'storage'},503);}
 }
 if([...params.keys()].length)return reply({error:'query'},400);
 let packet;
 try{packet=await readRelayPacket(request);}catch(e){return reply({error:e.message==='size'?'size':'packet'},e.message==='size'?413:400);}
 if(Math.abs(now-packet.at)>120000||!await verifyRelayPacket(packet))return reply({error:'publisher'},403);
 try{
  const result=await store.update(packet.topic,old=>{
   if(old&&old.expiresAt>now){
    if(old.packet.s===packet.s)return old; // Replays never refresh presence or retention.
    if(old.packet.at>=packet.at)throw Error('stale'); // Equal timestamps cannot refresh a replay with a malleated signature.
    if(now-old.windowAt<10000&&old.writes>=24)throw Error('rate');
   }
   const windowAt=old&&now-old.windowAt<10000?old.windowAt:now;
   const writes=old&&windowAt===old.windowAt?old.writes+1:1;
   return {packet,receivedAt:now,expiresAt:now+KEEP_MS,windowAt,writes};
  });
  return reply({protocol:1,accepted:true,topic:packet.topic,receivedAt:result.receivedAt});
 }catch(e){return reply({error:e.message==='stale'?'stale':e.message==='rate'?'rate':'storage'},
  e.message==='stale'?409:e.message==='rate'?429:503);}
}
export class MemoryRelayStore {
 constructor(){this.rows=new Map();this.queues=new Map();}
 async read(topic){return this.rows.get(topic)||null;}
 async update(topic,fn){
  const previous=this.queues.get(topic)||Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{const row=fn(await this.read(topic));this.rows.set(topic,row);return row;});
  this.queues.set(topic,next);try{return await next;}finally{if(this.queues.get(topic)===next)this.queues.delete(topic);}
 }
}
