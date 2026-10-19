"""Real browser notification worker, plus permission/failure recovery journeys."""
import argparse
import asyncio
from pathlib import Path

from playwright.async_api import async_playwright,expect
from qa_browser import sample_roster,gviz


async def run(args):
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True,**({'executable_path':args.chromium} if args.chromium else {}))
        context=await browser.new_context()
        await context.grant_permissions(['notifications'],origin=args.url)
        await context.add_init_script("localStorage.setItem('oneshot-watch-cams','false')")
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
        await expect(page.locator('#notifyBtn')).to_have_text('Проверить уведомления')
        await page.click('#notifyBtn')
        await expect(page.locator('#notifyStatus')).to_contain_text('Тестовое уведомление отправлено',timeout=15000)
        notes=await page.evaluate("async()=>{const r=await navigator.serviceWorker.getRegistration();return {active:r.active?.state,installing:r.installing?.state,waiting:r.waiting?.state,notes:(await r.getNotifications()).map(n=>({tag:n.tag,section:n.data.section}))}}")
        assert notes['active']=='activated' and {'tag':'oneshot-notification-test','section':'lobby'} in notes['notes'],notes
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
        print('PASS: real notification worker and persistent browser API, test button, masked non-password token, click routing, worker failure fallback and denied-permission recovery',flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--url',default='http://127.0.0.1:3000')
    parser.add_argument('--chromium')
    asyncio.run(run(parser.parse_args()))
