import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

async function click(windows,section){
  const handlers={},actions=[];
  const self={location:{origin:'https://panel.example'},
    addEventListener:(type,fn)=>{handlers[type]=fn;},
    clients:{matchAll:async()=>windows.map(url=>({url,
      focus:async()=>actions.push('focus:'+url),postMessage:data=>actions.push(data)})),
      openWindow:async url=>actions.push('open:'+url)}};
  vm.runInNewContext(fs.readFileSync(new URL('../notification-worker.js',import.meta.url),'utf8'),{self,URL});
  let pending;
  handlers.notificationclick({notification:{data:{section},close:()=>actions.push('close')},waitUntil:value=>{pending=value;}});
  await pending;
  return JSON.parse(JSON.stringify(actions));
}
test('notification clicks focus the existing panel without reloading its active state',async()=>{
  const actions=await click(['https://panel.example/card.html','https://panel.example/#prep'],'veto');
  assert.deepEqual(actions,['close','focus:https://panel.example/#prep',{type:'oneshot-notification-open',section:'veto'}]);
});
test('a notification without a panel opens only a fixed same-origin destination',async()=>{
  assert.deepEqual(await click(['https://panel.example/card.html'],'https://evil.example'),['close','open:/#lobby']);
});
