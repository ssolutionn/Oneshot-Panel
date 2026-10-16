import test from 'node:test';
import assert from 'node:assert/strict';
import {readPublicText,openPublicSocket} from '../assets/bookmaker-transport.js';
test('HTTP deadline holds when fetch ignores AbortSignal', {timeout:1000}, async()=>{
  await assert.rejects(readPublicText('https://example.invalid',()=>new Promise(()=>{}),{timeoutMs:5}),/долго/);
});
test('HTTP deadline cancels a stalled response body', {timeout:1000}, async()=>{
  let cancelled=false;
  const body=new ReadableStream({cancel(){cancelled=true;}});
  await assert.rejects(readPublicText('https://example.invalid',async()=>new Response(body),{timeoutMs:5}),/долго/);
  assert.equal(cancelled,true);
});
test('a late HTTP body after a timeout is discarded', {timeout:1000}, async()=>{
  let resolve,cancelled=false;
  const pending=readPublicText('https://example.invalid',()=>new Promise(r=>{resolve=r;}),{timeoutMs:5});
  await assert.rejects(pending,/долго/);
  resolve(new Response(new ReadableStream({cancel(){cancelled=true;}})));
  await new Promise(r=>setTimeout(r,10));
  assert.equal(cancelled,true);
});
test('WebSocket upgrade deadline holds when fetch ignores AbortSignal', {timeout:1000}, async()=>{
  await assert.rejects(openPublicSocket('https://example.invalid',()=>new Promise(()=>{}),5),/долго/);
});

test('a late WebSocket upgrade is accepted only to close it', {timeout:1000}, async()=>{
  let resolve,accepted=false,closed=false;
  const pending=openPublicSocket('https://example.invalid',()=>new Promise(r=>{resolve=r;}),5);
  await assert.rejects(pending,/долго/);
  resolve({status:101,webSocket:{accept(){accepted=true;},close(){closed=true;}}});
  await new Promise(r=>setTimeout(r,10));
  assert.ok(accepted&&closed);
});
