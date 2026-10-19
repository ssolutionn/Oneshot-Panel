// Notification delivery only: no fetch handler and no offline cache.
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const section=event.notification.data?.section==='veto' ? 'veto' : 'lobby';
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows){
      const url=new URL(client.url);
      if(url.origin===self.location.origin && url.pathname==='/'){
        await client.focus();
        client.postMessage({type:'oneshot-notification-open',section});
        return;
      }
    }
    await self.clients.openWindow('/#'+section);
  })());
});
