import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRoom,decodeLink,captainKey} from '../veto-room.js';
import {captainSlug,packCaptainLink,unpackCaptainLink,friendlyCaptainLinks,resolveRoomLink} from '../assets/veto-short-links.js';
import {shortPathValid,shortIdValid} from '../assets/veto-short-protocol.js';
import {handleShortLink} from '../server/veto-short-api.js';
import {MemoryRelayStore} from '../server/veto-relay-api.js';
import {FileRelayStore} from '../server/veto-relay-file.js';
import {relayServer} from '../server/veto-relay-node.mjs';

const base='https://veto.example/veto.html';
const post=record=>new Request('https://veto.example/api/veto-link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(record)});
const get=id=>new Request('https://veto.example/api/veto-link?id='+id);
const fixture=async()=>{
  const made=await createRoom(base,['HYPERSPIRIT','6yuBoJlbl'],'BO3',5,'https://veto.example/api/veto-relay');
  return {made,...await packCaptainLink(made.links.a,'CyberClash')};
};

test('readable tournament/team paths are ASCII, bounded and contain no URL syntax',()=>{
  assert.equal(captainSlug('CyberClash','HYPERSPIRIT'),'cyberclash_hyperspirit');
  assert.equal(captainSlug('Кибер Клэш','Буйволы'),'kiber-klesh_buyvoly');
  assert.equal(captainSlug('Café','Honvéd'),'cafe_honved');
  for(const names of [['../<script>','A/B?#'],['',''],['A'.repeat(200),'B'.repeat(200)]]){
    const slug=captainSlug(...names);assert.ok(shortPathValid('/'+slug));assert.ok(slug.length<=97);
  }
  for(const value of ['/','/veto.html','/../secret','/assets/team_name','/tournament_','/_team'])assert.equal(shortPathValid(value),false);
});

test('encrypted short links preserve captain signing authority and the server never gets the private link',async()=>{
  const {made,link,record}=await fixture();
  assert.match(link,/^https:\/\/veto\.example\/cyberclash_hyperspirit#k=[\w-]{22}$/);
  const original=decodeLink(new URL(made.links.a).hash),token=new URL(link).hash.slice(3),stored=JSON.stringify(record);
  for(const privateValue of [token,original.k,original.r,new URL(made.links.a).hash])assert.equal(stored.includes(privateValue),false);
  const resolved=await unpackCaptainLink(link,record);
  assert.deepEqual(resolved.room,original);
  assert.ok(await captainKey(resolved.room));
  assert.equal(decodeLink(new URL(resolved.canonical).hash).relay,original.relay);
  assert.ok(link.length<made.links.a.length/2);
});

test('wrong keys, paths and encrypted data fail closed',async()=>{
  const {link,record}=await fixture();
  await assert.rejects(unpackCaptainLink(link.replace('hyperspirit','another-team'),record),/invalid/);
  const key=new URL(link);key.hash='k=AAAAAAAAAAAAAAAAAAAAAA';
  await assert.rejects(unpackCaptainLink(key.href,record),/invalid/);
  const damaged=structuredClone(record);damaged.box.data=(damaged.box.data[0]==='A'?'B':'A')+damaged.box.data.slice(1);
  await assert.rejects(unpackCaptainLink(link,damaged),/invalid/);
  await assert.rejects(resolveRoomLink(link.split('#')[0],()=>{throw Error('must not fetch');}),/invalid/);
});

test('server records are immutable, idempotent and survive a new match with the same readable path',async()=>{
  const {made,link,record}=await fixture(),store=new MemoryRelayStore();
  assert.equal((await handleShortLink(post(record),store)).status,200);
  assert.equal((await handleShortLink(post(record),store)).status,200);
  const changed=structuredClone(record);changed.box.iv='AAAAAAAAAAAAAAAA';
  assert.equal((await handleShortLink(post(changed),store)).status,409);
  const next=await packCaptainLink((await createRoom(base,made.room.t,'BO3')).links.a,'CyberClash');
  assert.equal(new URL(next.link).pathname,new URL(link).pathname);
  assert.notEqual(next.record.id,record.id);
  assert.equal((await handleShortLink(post(next.record),store)).status,200);
  assert.deepEqual(await(await handleShortLink(get(record.id),store)).json(),record);
});

test('short API rejects malformed, oversized and path-like IDs without overwriting records',async()=>{
  const store=new MemoryRelayStore(),{record}=await fixture();
  for(const id of ['../secret',record.id+'&id='+record.id,record.id+'&url=https://evil.example'])assert.equal((await handleShortLink(get(id),store)).status,400);
  assert.equal((await handleShortLink(get('a'.repeat(64)),store)).status,404);
  assert.equal((await handleShortLink(post({...record,key:'plaintext'}),store)).status,400);
  assert.equal((await handleShortLink(new Request('https://veto.example/api/veto-link',{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(4097)}),store)).status,413);
  assert.equal((await handleShortLink(new Request('https://veto.example/api/veto-link',{method:'POST',headers:{'content-type':'text/plain'},body:'{}'}),store)).status,400);
  assert.equal((await handleShortLink(get(record.id),null)).status,503);
  assert.equal((await handleShortLink(new Request('https://veto.example/api/veto-link',{method:'DELETE'}),store)).status,405);
});

test('cached encrypted links reopen offline; damaged caches recover; old links need no lookup',async()=>{
  const {made,link,record}=await fixture(),cache=new Map();
  const storage={getItem:key=>cache.get(key),setItem:(key,value)=>cache.set(key,value)};
  let calls=0;
  const request=async input=>{calls++;assert.equal(new URL(input).searchParams.get('id'),record.id);return new Response(JSON.stringify(record));};
  assert.deepEqual((await resolveRoomLink(link,request,storage)).room,decodeLink(new URL(made.links.a).hash));
  assert.equal(cache.size,1);
  await resolveRoomLink(link,()=>{throw Error('offline');},storage);
  assert.equal(calls,1);
  storage.setItem([...cache.keys()][0],'{broken');
  await resolveRoomLink(link,request,storage);assert.equal(calls,2);
  await resolveRoomLink(made.links.a,()=>{throw Error('must not fetch');},null);
  await assert.rejects(resolveRoomLink(link,async()=>new Response('{}',{status:503}),null),/unavailable/);
  await assert.rejects(resolveRoomLink(link,async()=>new Response('{}',{status:404}),null),/missing/);
});

test('unavailable short-link service leaves usable legacy links, and partial failure keeps the successful one',async()=>{
  const {made}=await fixture();
  const failed=await friendlyCaptainLinks(made,base,'CyberClash',async()=>new Response('',{status:503}));
  assert.deepEqual(failed.links,made.links);assert.equal(failed.shortLinkFallback,true);
  const mixed=await friendlyCaptainLinks(made,base,'CyberClash',async(url,options)=>{
    const record=JSON.parse(options.body);
    return record.slug.endsWith('hyperspirit')?new Response(JSON.stringify({accepted:true,id:record.id})):new Response('',{status:503});
  });
  assert.match(mixed.links.a,/#k=/);assert.equal(mixed.links.b,made.links.b);
  assert.equal(mixed.links.o,made.links.o);assert.equal(mixed.links.s,made.links.s);
});

test('actual HTTP and file-backed short links survive restart, with private file permissions',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'veto-short-'));
  const server=relayServer(new MemoryRelayStore(),new FileRelayStore(directory,shortIdValid));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const site='http://127.0.0.1:'+server.address().port;
    const made=await createRoom(site+'/veto.html',['A','B'],'BO1');
    const pretty=await friendlyCaptainLinks(made,site,'Cup 2026');
    assert.equal(pretty.shortLinkFallback,false);
    assert.equal((await resolveRoomLink(pretty.links.a,fetch,null)).room.r,made.room.r);
    const record=await packCaptainLink(made.links.a,'Cup 2026');
    await fetch(site+'/api/veto-link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(record.record)});
    const restarted=new FileRelayStore(directory,shortIdValid);
    await restarted.prune(Date.now()+366*86400000);
    assert.deepEqual(await restarted.read(record.record.id),record.record);
    assert.equal((await stat(restarted.file(record.record.id))).mode&0o077,0);
    assert.throws(()=>restarted.file('../secret'));
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
