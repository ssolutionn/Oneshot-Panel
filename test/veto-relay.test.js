import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRoom,decodeLink,encodeLink,captainKey,roomSecrets,displayRelayIdentity} from '../veto-room.js';
import {adminRoom,RoomWatch} from '../veto-watch.js';
import {seal,unseal} from '../vdo.js';
import {relayTopic,relayEndpoint,signRelayPacket,verifyRelayPacket,KEEP_MS} from '../assets/veto-relay-protocol.js';
import {RelayClient,checkRelay} from '../assets/veto-relay-client.js';
import {MemoryRelayStore,handleRelay} from '../server/veto-relay-api.js';
import {FileRelayStore} from '../server/veto-relay-file.js';
import {relayServer} from '../server/veto-relay-node.mjs';
const endpoint='https://example.test/api/veto-relay';
async function captain() {
 const made=await createRoom('https://example.test/veto.html',['A','B'],'BO3',5,endpoint);
 const room=decodeLink(new URL(made.links.a).hash),key=await captainKey(room),secrets=await roomSecrets(room);
 return {made,room,key,secrets,point:room.p[0]};
}
const post=packet=>new Request(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(packet)});
const get=topic=>new Request(endpoint+'?topics='+topic);
const delay=ms=>new Promise(r=>setTimeout(r,ms));

test('room links retain transport, drop captain secrets for admin, and keep old VDO bytes',async()=>{
 const {made,room}=await captain();
 for(const url of Object.values(made.links))assert.equal(decodeLink(new URL(url).hash).relay,endpoint);
 assert.equal(adminRoom(made.links.a).room.k,undefined);
 assert.equal(new URL(adminRoom(made.links.a).adminLink).hash,new URL(made.links.o).hash);
 const old={...room};delete old.relay;
 const link=encodeLink('https://example.test/veto.html',old);
 assert.equal(new URL(link).hash,new URL(made.links.a).hash.split('&')[0]);
 assert.equal(decodeLink(new URL(link).hash).relay,undefined);
 for(const bad of ['http://evil.test/api/veto-relay','https://u:p@example.test/api/veto-relay',
  'https://example.test/not-our-api','https://example.test/api/veto-relay?secret=x',
  'javascript:alert(1)'])assert.throws(()=>relayEndpoint(bad));
 assert.equal(relayEndpoint('/api/veto-relay','http://localhost:3000'), 'http://localhost:3000/api/veto-relay');
 assert.equal(decodeLink(new URL(link).hash+'&via=server'),null);
 assert.equal(decodeLink(new URL(link).hash+'&via=wrong&relay='+encodeURIComponent(endpoint)),null);
 assert.equal(decodeLink(new URL(made.links.a).hash+'&relay='+encodeURIComponent(endpoint)),null);
});

test('relay publisher signature prevents spectators impersonating either captain',async()=>{
 const c=await captain(),store=new MemoryRelayStore(),now=Date.now();
 const box=await seal(c.secrets.key,{t:'log',from:'a',log:[],p:c.room.p});
 const packet=await signRelayPacket(c.key,c.point,box,now);
 assert.equal(await relayTopic(c.point),c.room.fp[0]);
 assert.equal(await verifyRelayPacket(packet),true);
 assert.equal((await handleRelay(post(packet),store,now)).status,200);
 const body=await(await handleRelay(get(packet.topic),store,now+1)).json();
 assert.deepEqual(body.records[0].packet,packet);
 assert.equal(JSON.stringify(packet).includes(c.room.r),false);
 assert.equal(JSON.stringify(packet).includes(c.room.k),false);
 const attacker=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const pub=await crypto.subtle.exportKey('jwk',attacker.publicKey);
 const forged=await signRelayPacket(attacker.privateKey,[pub.x,pub.y],box,now);
 forged.topic=packet.topic;forged.p=packet.p;
 assert.equal((await handleRelay(post(forged),store,now)).status,403);
 const changed=structuredClone(packet);changed.box.data=changed.box.data.replace(/^./,changed.box.data[0]==='A'?'B':'A');
 assert.equal((await handleRelay(post(changed),store,now)).status,403);
 assert.equal(await verifyRelayPacket({...packet,extra:'write a file'}),false);
});

test('server rejects malformed, oversized, stale and rate-limited writes; replay never refreshes presence',async()=>{
 const c=await captain(),store=new MemoryRelayStore(),now=Date.now();
 const box=await seal(c.secrets.key,{x:1}),packet=await signRelayPacket(c.key,c.point,box,now);
 await handleRelay(post(packet),store,now);
 const duplicate=await(await handleRelay(post(packet),store,now+7000)).json();
 assert.equal(duplicate.receivedAt,now);
 const later=await signRelayPacket(c.key,c.point,box,now+100);
 assert.equal((await handleRelay(post(later),store,now+101)).status,200);
 assert.equal((await handleRelay(post(packet),store,now+102)).status,409);
 assert.equal((await handleRelay(post({...packet,at:now-121000}),store,now)).status,403);
 assert.equal((await handleRelay(new Request(endpoint,{method:'POST',headers:{'content-type':'text/plain'},body:'{}'}),store)).status,400);
 assert.equal((await handleRelay(new Request(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(24001)}),store)).status,413);
 assert.equal((await handleRelay(new Request(endpoint+'?topics=../../private'),store)).status,400);
 assert.equal((await handleRelay(new Request(endpoint+'?topics='+packet.topic+'&url=https://evil.test'),store)).status,400);
 assert.equal((await handleRelay(new Request(endpoint,{method:'DELETE'}),store)).status,405);
 assert.equal((await handleRelay(new Request(endpoint+'?health=1'),null)).status,503);
 for(let i=0;i<22;i++)assert.equal((await handleRelay(post(await signRelayPacket(c.key,c.point,box,now+200+i)),store,now+200+i)).status,200);
 assert.equal((await handleRelay(post(await signRelayPacket(c.key,c.point,box,now+300)),store,now+300)).status,429);
 const expired=await(await handleRelay(get(packet.topic),store,now+KEEP_MS+1000)).json();
 assert.equal(expired.records.length,0);
});

test('file relay survives restart, keeps private permissions, prunes expiry and rejects paths',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'oneshot-relay-'));
 try{
  const c=await captain(),now=Date.now(),packet=await signRelayPacket(c.key,c.point,await seal(c.secrets.key,{log:[]}),now);
  await handleRelay(post(packet),new FileRelayStore(dir),now);
  const restarted=new FileRelayStore(dir);
  const result=await(await handleRelay(get(packet.topic),restarted,now+1)).json();
  assert.deepEqual(result.records[0].packet,packet);
  assert.equal((await stat(path.join(dir,packet.topic+'.json'))).mode&0o077,0);
  assert.throws(()=>restarted.file('../passwords'));
  await restarted.prune(now+KEEP_MS+1);
  assert.equal(await restarted.read(packet.topic),null);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('real HTTP clients recover retained encrypted state; read-only clients cannot send; cleanup aborts polling',async()=>{
 const c=await captain(),store=new MemoryRelayStore(),server=relayServer(store);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port+'/api/veto-relay';
 let writer,reader,late;
 try{
  await checkRelay(url);
  let received=null;
  reader=new RelayClient(url,[c.room.fp[0]],async box=>{received=await unseal(c.secrets.key,box);},{interval:25});
  writer=new RelayClient(url,[c.room.fp[1]],()=>{},{interval:25,publisher:{key:c.key,point:c.point}});
  assert.equal(await reader.send(await seal(c.secrets.key,{forged:true})),false);
  assert.equal(await writer.send(await seal(c.secrets.key,{t:'log',value:'first'})),true);
  for(let i=0;i<100&&!received;i++)await delay(20);
  assert.equal(received?.value,'first');
  reader.close();writer.close();
  let restored;
  late=new RelayClient(url,[c.room.fp[0]],async box=>{restored=await unseal(c.secrets.key,box);},{interval:25});
  for(let i=0;i<100&&!restored;i++)await delay(20);
  assert.equal(restored?.value,'first');
  assert.equal((await fetch(url+'-other',{method:'POST'})).status,404);
  late.close();assert.equal(late.stopped,true);
 }finally{writer?.close();reader?.close();late?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('retained snapshots do not forge online status or admin calls',async()=>{
 const c=await captain();let calls=0;
 const room=adminRoom(c.made.links.o).room;
 const watch=new RoomWatch(room,{onCall:()=>calls++,connect:()=>({stop(){}})});
 await watch.ready;
 watch.receive({t:'log',log:[],p:c.room.p,call:Date.now()},0,false);
 await watch.queue;assert.equal(watch.online(0),false);assert.equal(calls,0);
 watch.receive({t:'log',log:[],p:c.room.p,call:Date.now()},0,true);
 assert.equal(watch.online(0),true);assert.equal(calls,1);watch.stop();
});

test('display publisher keys are deterministic, role-separated, and unrelated to captain authority',async()=>{
 const [a,b,a2]=await Promise.all(['dock','veto','dock'].map(r=>displayRelayIdentity('TESTDISPLAYCODE123',r)));
 assert.equal(a.topic,a2.topic);assert.notEqual(a.topic,b.topic);
 const c=await captain();assert.notEqual(a.topic,c.room.fp[0]);
});
