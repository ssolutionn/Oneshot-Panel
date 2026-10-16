import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDay,mergeDay,normalizeDay,moscowDay,validDay} from '../assets/bookmaker-history.js';
import {bookmakersResponse} from '../netlify/functions/bookmakers.mjs';
import {persistObservations} from '../scripts/collect_bookmaker_history.mjs';
const at=Date.UTC(2026,9,16,13), day='2026-10-16';
const event={id:'real-id',team1:'Alpha',team2:'Beta',start:at,tournament:'CyberClash S2',
  odds:[1.8,2.1],url:'https://fon.bet/sports/esports/real-id',live:false};
const read=(events=[event],extra={})=>({id:'fonbet',ok:true,events,errors:[],coverage:'line-and-live',checkedAt:at,...extra});

test('match-day archive survives empty reads, failed reads and a process reload',()=>{
  let a=mergeDay(emptyDay(day),read());
  a=mergeDay(a,read([],{checkedAt:at+600000}));
  a=mergeDay(a,read([],{ok:false,checkedAt:at+1200000}));
  a=normalizeDay(JSON.parse(JSON.stringify(a)),day);
  assert.equal(a.books.fonbet.events.length,1);
  assert.equal(a.books.fonbet.status,'error');
  assert.equal(a.books.fonbet.events[0].last,at);
  assert.deepEqual(a.books.fonbet.events[0].odds,[1.8,2.1]);
});
test('observations retain opening odds, live appearance and exact tournament spellings',()=>{
  let a=mergeDay(emptyDay(day),read());
  a=mergeDay(a,read([{...event,odds:[1.6,2.4],live:true,tournament:'CS2. Cyber Clash. CQ'}],{checkedAt:at+1}));
  const e=a.books.fonbet.events[0];
  assert.equal(a.books.fonbet.events.length,1);
  assert.deepEqual(e.open,[1.8,2.1]);assert.deepEqual(e.odds,[1.6,2.4]);
  assert.equal(e.liveSeen,true);assert.deepEqual(e.names,['CyberClash S2','CS2. Cyber Clash. CQ']);
  const older=mergeDay(a,read());
  assert.deepEqual(older.books.fonbet.events[0],e);
});
test('Moscow midnight and match days do not mix tomorrow into today',()=>{
  assert.equal(moscowDay(Date.UTC(2026,9,16,21)), '2026-10-17');
  assert.equal(validDay('2026-02-30'),false);
  assert.equal(validDay('../secrets'),false);
  assert.equal(mergeDay(emptyDay('2026-10-17'),read()).books.fonbet.events.length,0);
  assert.equal(mergeDay(emptyDay(day),read([{...event,start:null}]),at).books.fonbet.events.length,1);
});
test('archive whitelists public fields, bookmaker URLs and CyberClash only',()=>{
  const a=mergeDay(emptyDay(day),read([{...event,url:'https://evil.example/steal',password:'secret',
    odds:[Infinity,2.1],token:'hidden'},{...event,id:'other',tournament:'CCT Europe'}]));
  const serialized=JSON.stringify(a),e=a.books.fonbet.events[0];
  assert.equal(a.books.fonbet.events.length,1);
  assert.equal(e.url,'https://fon.bet/sports/esports');
  assert.deepEqual(e.odds,[null,2.1]);
  assert.ok(!serialized.includes('secret')&&!serialized.includes('hidden')&&!serialized.includes('evil'));
  assert.throws(()=>normalizeDay({...a,day:'2026-10-15'},day));
});
test('history endpoint reads one fixed GitHub path and rejects all website writes',async()=>{
  const a=mergeDay(emptyDay(day),read());const asked=[];
  const fake=async(url,init)=>{asked.push(url);assert.equal(init.redirect,'manual');return Response.json(a);};
  const url='https://panel/api/bookmakers?history='+day;
  const r=await bookmakersResponse(new Request(url),fake);
  assert.equal(r.status,200);assert.equal((await r.json()).archive.books.fonbet.events.length,1);
  assert.deepEqual(asked,['https://raw.githubusercontent.com/ssolutionn/Oneshot-Panel/bookmaker-history/days/2026-10-16.json']);
  for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await bookmakersResponse(new Request(url,{method}),fake)).status,405);
  assert.equal((await bookmakersResponse(new Request('https://panel/api/bookmakers?history=../etc'),fake)).status,400);
  assert.equal(asked.length,1);
});
test('missing archive and a broken archive are different states',async()=>{
  const url='https://panel/api/bookmakers?history='+day;
  const missing=await bookmakersResponse(new Request(url),async()=>new Response('',{status:404}));
  assert.equal((await missing.json()).missing,true);
  const broken=await bookmakersResponse(new Request(url),async()=>Response.json({version:99}));
  assert.equal(broken.status,502);
});
test('scheduled writer uses a data-only branch, preserves other days and never forces refs',async()=>{
  const calls=[];const previous=mergeDay(emptyDay(day),read());
  const api=async(method,path,body)=>{
    calls.push({method,path,body});
    if(path==='git/ref/heads/bookmaker-history')return{object:{sha:'previous'}};
    if(path==='git/commits/previous')return{tree:{sha:'old-tree'}};
    if(path.startsWith('contents/'))return{content:Buffer.from(JSON.stringify(previous)).toString('base64')};
    if(path==='git/trees')return{sha:'new-tree'};
    if(path==='git/commits')return{sha:'new-commit'};
    return{};
  };
  await persistObservations([read([],{checkedAt:at+100})],api,at+100);
  const tree=calls.find(c=>c.path==='git/trees').body;
  assert.equal(tree.base_tree,'old-tree');
  assert.deepEqual(tree.tree.map(e=>e.path),['days/2026-10-16.json']);
  assert.equal(JSON.parse(tree.tree[0].content).books.fonbet.events.length,1);
  assert.deepEqual(calls.at(-1).body,{sha:'new-commit',force:false});
});
