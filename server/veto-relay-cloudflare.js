import {verifyRelayPacket} from '../assets/veto-relay-protocol.js';
// Cloudflare adapter. The shared HTTP protocol also runs on the Node server.
import {handleRelay,reply,topicList,readRelayPacket,relayHeaders} from './veto-relay-api.js';
export class VetoRelayTopic {
 constructor(ctx){this.ctx=ctx;}
 async fetch(request){
  const store={
   read:()=>this.ctx.storage.get('row'),
   update:async(topic,change)=>{
    const row=await this.ctx.storage.transaction(async tx=>{
     const old=await tx.get('row');const next=change(old);
     if(next!==old)await tx.put('row',next);return next;
    });
    await this.ctx.storage.setAlarm(row.expiresAt);return row;
   }
  };
  return handleRelay(request,store);
 }
 async alarm(){
  const row=await this.ctx.storage.get('row');
  if(row&&row.expiresAt>Date.now())await this.ctx.storage.setAlarm(row.expiresAt);
  else await this.ctx.storage.deleteAll();
 }
}
export async function cloudflareRelay(request,env){
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:relayHeaders});
 if(!env?.VETO_RELAY)return reply({protocol:1,ready:false,error:'relay-not-configured'},503);
 const params=new URL(request.url).searchParams;
 if(request.method==='GET'){
  if(params.get('health')==='1'&&[...params.keys()].length===1){
   try{
    const stub=env.VETO_RELAY.get(env.VETO_RELAY.idFromName('relay-health'));
    const response=await stub.fetch('https://relay.internal/api/veto-relay?topics=AAAAAAAAAAAAAA');
    if(!response.ok)throw Error('storage');
    return reply({protocol:1,ready:true});
   }catch{return reply({protocol:1,ready:false,error:'storage'},503);}
  }
  const ids=topicList(request);if(!ids)return reply({error:'topics'},400);
  try{
   const chunks=await Promise.all(ids.map(async id=>{
    const stub=env.VETO_RELAY.get(env.VETO_RELAY.idFromName(id));
    const r=await stub.fetch('https://relay.internal/api/veto-relay?topics='+id);
    if(!r.ok)throw Error('storage');return r.json();
   }));
   return reply({protocol:1,now:Date.now(),records:chunks.flatMap(r=>r.records)});
  }catch{return reply({error:'storage'},503);}
 }
 if(request.method!=='POST')return new Response(JSON.stringify({error:'method'}),{
  status:405,headers:{...relayHeaders,allow:'GET, POST, OPTIONS'}});
 if([...params.keys()].length)return reply({error:'query'},400);
 let packet;try{packet=await readRelayPacket(request);}catch(e){return reply({error:'packet'},e.message==='size'?413:400);}
 if(Math.abs(Date.now()-packet.at)>120000||!await verifyRelayPacket(packet))return reply({error:'publisher'},403);
 const stub=env.VETO_RELAY.get(env.VETO_RELAY.idFromName(packet.topic));
 try{return await stub.fetch(new Request('https://relay.internal/api/veto-relay',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(packet)}));}
 catch{return reply({error:'storage'},503);}
}
