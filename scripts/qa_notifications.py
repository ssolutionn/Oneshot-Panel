"""Real browser notification worker, plus permission/failure recovery journeys."""
import argparse
import asyncio
from pathlib import Path

from playwright.async_api import async_playwright,expect
from qa_browser import sample_roster,gviz


async def run(args):
    async with async_playwright() as p:
        # The reduced headless shell reports Notification.permission=denied
        # even when the permission query is granted. Use the full browser.
        browser=await p.chromium.launch(headless=True,**({'executable_path':args.chromium} if args.chromium else {'channel':'chromium'}))
        context=await browser.new_context()
        await context.grant_permissions(['notifications'])
        await context.add_init_script("""{
          localStorage.setItem('oneshot-watch-cams','false');
          window.__nativeNotificationCalls=[];
          const RealNotification=Notification;
          window.Notification=new Proxy(RealNotification,{
            get:(target,key)=>{const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;},
            construct:(target,args)=>{const note=Reflect.construct(target,args,target);
              __nativeNotificationCalls.push({api:'desktop',tag:args[1]?.tag,section:args[1]?.data?.section});return note;}
          });
          const show=ServiceWorkerRegistration.prototype.showNotification;
          ServiceWorkerRegistration.prototype.showNotification=async function(title,options){
            await show.call(this,title,options);
            __nativeNotificationCalls.push({api:'worker',tag:options.tag,section:options.data?.section});
          };
        }""")
        await context.route('https://docs.google.com/**',lambda r:r.fulfill(content_type='application/javascript',
            body=gviz([]) if 'gid=815739139' in r.request.url else sample_roster()))
        page=await context.new_page()
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        # Start the real worker on a small same-origin document. Chromium can
        # defer first installation behind the panel's external image loads.
        await page.goto(args.url.rstrip('/')+'/notification-worker.js')
        await page.evaluate("async()=>{await navigator.serviceWorker.register('/notification-worker.js');await navigator.serviceWorker.ready;}")
        await page.goto(args.url.rstrip('/')+'/#lobby')
        await context.grant_permissions(['notifications'],origin=await page.evaluate('location.origin'))
        actual=await page.evaluate("async()=>({notification:Notification.permission,query:(await navigator.permissions.query({name:'notifications'})).state,origin:location.origin})")
        assert actual['notification']=='granted',actual
        # The permission may change after initial rendering; the same button
        # must recover without a reload in that user journey.
        await expect(page.locator('#notifyBtn')).to_be_enabled()
        await page.click('#notifyBtn')
        await expect(page.locator('#notifyStatus')).to_contain_text('Тестовое уведомление отправлено',timeout=15000)
        calls=await page.evaluate('window.__nativeNotificationCalls')
        assert any(n['tag']=='oneshot-notification-test' and n['section']=='lobby' for n in calls),calls
        # Headless OS backends can dismiss a toast immediately. Acceptance by
        # a real browser API is observable; a visible OS banner is not.
        assert await page.locator('#faceitKey').get_attribute('type')=='text'
        assert await page.locator('#faceitKey').evaluate("el=>getComputedStyle(el).webkitTextSecurity")=='disc'
        await page.evaluate("navigator.serviceWorker.dispatchEvent(new MessageEvent('message',{data:{type:'oneshot-notification-open',section:'veto'}}))")
        await expect(page.locator('#vetoView')).to_be_visible()
        await page.click('#viewLobby')
        await page.evaluate("""() => {
          window.__realNotification=Notification;
          window.__notes=[];
          window.Notification=class {
            constructor(title,options){window.__notes.push({title,...options});}
            close(){}
            static get permission(){return 'granted';}
          };
          navigator.serviceWorker.register=async()=>{throw Error('Worker blocked')};
        }""")
        # Reset the worker owner by navigating a fresh module instance/page.
        await page.evaluate("async()=>{const m=await import('/notifications.js?fallback-qa');await m.showNotification('QA','Fallback',{tag:'qa-fallback'})}")
        assert (await page.evaluate('window.__notes'))[0]['tag']=='qa-fallback'
        await page.evaluate("""() => {
          window.Notification=class {static get permission(){return 'denied'}};
        }""")
        await page.click('#notifyBtn')
        await expect(page.locator('#notifyStatus')).to_contain_text('В настройках этого сайта')
        assert not await page.locator('#notifyBtn').is_disabled()
        await page.evaluate("()=>{window.Notification=window.__realNotification;}")
        await page.evaluate("async()=>{const r=await navigator.serviceWorker.getRegistration();for(const n of await r.getNotifications())n.close()}")
        assert not errors,errors
        await browser.close()
        print('PASS: real browser notification API, test button, masked non-password token, click routing, worker failure fallback and denied-permission recovery',flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--url',default='http://127.0.0.1:3000')
    parser.add_argument('--chromium')
    asyncio.run(run(parser.parse_args()))
