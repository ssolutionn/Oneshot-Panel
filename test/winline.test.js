import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {winlineDictionary, winlineSnapshot, readWinline} from '../assets/bookmaker-winline.js';

const fixture = async name => Buffer.from((await readFile(new URL('./fixtures/bookmakers/' + name, import.meta.url),'utf8')).trim(),'base64');
const dictionary = await fixture('winline-dictionary.base64');
const line = await fixture('winline-line.base64');

test('Winline real public binary packets: winner, total, handicap and match scope', () => {
  const markets = winlineDictionary(gunzipSync(dictionary));
  const events = winlineSnapshot(gunzipSync(line), markets);
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.team1, 'PRIVATE ESPORTS');
  assert.equal(e.team2, 'UPGRADE');
  assert.deepEqual(e.odds, [1.71,2.02]);
  assert.equal(e.tournament, 'CyberClash');
  assert.equal(e.live, false);
  assert.equal(e.liveOffered, true);
  assert.deepEqual(e.markets, [
    {kind:'total',name:'Тотал карт',line:'2.5',odds:[1.87,1.83]},
    {kind:'handicap',name:'Фора карт',line:'-1.5',odds:[2.9,1.27]}
  ]);
  assert.deepEqual(e.size, {count:30,unit:'рынков'});
  const raw = gunzipSync(line);
  assert.throws(() => winlineSnapshot(raw.subarray(0,raw.length-1), markets), /Неполный/);
  const changed = Buffer.from(raw); changed[18]=255;
  assert.throws(() => winlineSnapshot(changed, markets), /изменился/);
  assert.throws(() => winlineSnapshot(raw, new Map()), /Неизвестный рынок/);
});
class Socket extends EventTarget {
  commands=[]; closed=false;
  accept() {}
  send(command) {
    this.commands.push(command);
    if (command==='getdate') queueMicrotask(() => {
      this.dispatchEvent(new MessageEvent('message', {data:dictionary}));
      this.dispatchEvent(new MessageEvent('message', {data:line}));
    });
  }
  close() {this.closed=true;}
}
test('Winline Cloudflare reader subscribes only to public data and closes after snapshot', async () => {
  const socket=new Socket();
  const fetcher=async(url,init)=>{
    assert.equal(url,'https://wss.winline.ru/data_ng?client=newsite&nb=true');
    assert.equal(init.headers.Upgrade,'websocket');
    return {status:101,webSocket:socket};
  };
  const events=await readWinline(fetcher,1000);
  assert.equal(events[0].team2,'UPGRADE');
  assert.deepEqual(socket.commands,['lang','AA==','data','WINLINE','getdate']);
  assert.equal(socket.closed,true);
});
test('Winline rejects unavailable public sockets instead of returning an empty tournament', async () => {
  await assert.rejects(readWinline(async()=>({status:403}),100),/недоступен/);
  const socket=new Socket();socket.send=()=>{};
  await assert.rejects(readWinline(async()=>({status:101,webSocket:socket}),10),/долго/);
  assert.equal(socket.closed,true);
});
