"""Camera editor/export/live-OBS browser journeys with a controlled video input."""
import argparse
import asyncio
import base64
import json
from pathlib import Path

from playwright.async_api import async_playwright, expect
from qa_browser import sample_roster, gviz
from qa_live import MockObs, OBS_URL, FAKE_VDO

# A known landscape input. The video poster follows the same object-fit and
# object-position rules as a playing video, without depending on a webcam.
POSTER = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">' + ''.join(
    f'<rect x="{i*400}" width="400" height="900" fill="{color}"/>'
    for i,color in enumerate(["#ff0000","#00ff00","#0000ff","#ffff00"])) + '</svg>'
CAMERA_HTML = """<!doctype html><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
video{display:block;width:100%;height:100%;object-fit:cover}
</style><video poster="data:image/svg+xml;base64,""" + base64.b64encode(POSTER.encode()).decode() + """"></video>
<script>
const q=new URLSearchParams(location.search);
function style(text){const s=document.createElement('style');s.textContent=text;document.head.append(s)}
if(q.get('b64css'))style(atob(q.get('b64css')));
addEventListener('message',e=>{if(typeof e.data?.style==='string')style(e.data.style)});
</script>"""


async def run(args):
    output=Path(args.artifacts)
    output.mkdir(parents=True,exist_ok=True)
    async with async_playwright() as p:
        launch={"headless":True}
        if args.browser=="chromium" and args.chromium: launch["executable_path"]=args.chromium
        browser=await getattr(p,args.browser).launch(**launch)
        context=await browser.new_context(viewport={"width":1440,"height":1000},accept_downloads=True)
        await context.add_init_script("""
          try {
          localStorage.setItem('oneshot-watch-cams','false');
          if(!localStorage.getItem('oneshot-obs')) localStorage.setItem('oneshot-obs',JSON.stringify({mode:'direct',url:'ws://127.0.0.1:4455',password:'pw'}));
          } catch {}
          window.showSaveFilePicker=undefined;
        """)
        await context.route("https://docs.google.com/**/gviz/**",lambda route:route.fulfill(
            content_type="application/javascript",body=gviz([["","16:00","6yuBoJlbl","HYPERSPIRIT","B"]])
            if "gid=815739139" in route.request.url else sample_roster()))
        await context.route("**/api/bookmakers?**",lambda route:route.fulfill(
            content_type="application/json",body='{"ok":true,"events":[],"checkedAt":0}'))
        preview_release=asyncio.Event()
        if not args.real_provider:
            async def preview_route(route):
                if '&cover' in route.request.url: await preview_release.wait()
                await route.fulfill(content_type='text/html',body=CAMERA_HTML if '&cover' in route.request.url else FAKE_VDO)
            await context.route("https://vdo.ninja/**",preview_route)
        page=await context.new_page()
        errors,previews=[],[]
        page.on("pageerror",lambda error:errors.append(str(error)))
        page.on("request",lambda req:previews.append(req.url) if req.url.startswith("https://vdo.ninja/") and "&cover" in req.url else None)
        obs=MockObs()
        await page.route_web_socket(OBS_URL,obs.handler)
        await page.goto(args.url)
        await expect(page.locator("#syncTitle")).to_contain_text("команд из таблицы")
        options=await page.locator("#matchSelect option").evaluate_all("els=>els.filter(e=>e.value).map(e=>e.value)")
        await page.select_option("#matchSelect",options[0])
        await expect(page.locator("#cameraFrame")).to_have_value("inner43")
        await page.locator('[data-camera="a"][data-slot="0"]').click()
        await expect(page.locator("#cameraDialog")).to_be_visible()
        if not args.real_provider:
            await expect(page.locator('#cameraPreviewBox')).to_have_attribute('data-loading','true')
            assert await page.locator('#cameraPreviewBox').evaluate("el=>getComputedStyle(el.parentElement,'::after').backgroundColor")=='rgb(0, 0, 0)'
            assert 'oneshot-preview.png' in await page.locator('#cameraPreviewBox').evaluate("el=>getComputedStyle(el.parentElement,'::after').backgroundImage")
            preview_release.set()
        if args.real_provider:
            handle=await page.locator("#cameraPreviewBox iframe").element_handle()
            frame=await handle.content_frame()
            await frame.wait_for_url("https://vdo.ninja/**",wait_until="domcontentloaded",timeout=60000)
            await frame.wait_for_function("() => typeof window.onmessage==='function'",timeout=60000)
            assert await frame.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--fit-style').trim()")=="cover"
            await frame.evaluate("""poster=>{
              const video=document.createElement('video');
              video.id='cameraQaMedia';video.poster=poster;
              document.body.append(video);
            }""","data:image/svg+xml;base64,"+base64.b64encode(POSTER.encode()).decode())
            await page.locator('[data-camera-pan="panX:-10"]').click()
            await expect(frame.locator("#cameraQaMedia")).to_have_css("object-position","40% 50%",timeout=15000)
            await page.click("#cameraRotate")
            await expect(frame.locator("#cameraQaMedia")).to_have_css("object-position","50% 60%",timeout=15000)
            await page.locator('#cameraZoom').press('End')
            await expect(frame.locator('#cameraQaMedia')).to_have_css('scale','3',timeout=15000)
            assert await frame.evaluate("document.body.classList.contains('darktheme')")
            await browser.close()
            print("PASS: current real VDO accepts cover URL and live style messages for camera pan/rotation; controlled media, no player stream",flush=True)
            return
        video=page.frame_locator("#cameraPreviewBox iframe").locator("video")
        await expect(video).to_be_visible()
        await expect(page.locator('#cameraPreviewBox')).to_have_attribute('data-loading','false')
        await expect(video).to_have_css("object-fit","cover")
        await page.locator('[data-camera-pan="panX:-10"]').click()
        await expect(video).to_have_css("object-position","40% 50%")
        await page.click("#cameraRotate")
        await expect(page.locator("#cameraRotation")).to_have_value("90")
        await expect(video).to_have_css("object-position","50% 60%")
        await page.locator('#cameraZoom').press('End')
        await expect(video).to_have_css('scale','3')
        await page.locator('#cameraZoom').press('Home')
        await expect(video).to_have_css('scale','1')
        for _ in range(5): await page.locator('[data-camera-zoom="10"]').click()
        await expect(video).to_have_css('scale','1.5')
        await expect(page.locator('#cameraZoomValue')).to_have_text('150%')
        assert len(previews)==1,"Panning/rotation reconnected the video instead of editing its view"
        await page.locator("#cameraDialog").screenshot(path=str(output/"camera-editor.png"))
        await page.set_viewport_size({"width":375,"height":812})
        assert not await page.evaluate("document.documentElement.scrollWidth>innerWidth")
        await page.locator("#cameraDialog").screenshot(path=str(output/"camera-editor-mobile.png"))
        await page.click("#closeCamera")
        await expect(page.locator("#cameraPreviewBox iframe")).to_have_count(0)
        keys=await page.evaluate("window.oneshotPanel.snapshot().keysA")
        await page.select_option('[data-player="a"][data-slot="0"]',"")
        await page.select_option('[data-player="a"][data-slot="1"]',keys[0])
        await page.select_option('[data-player="a"][data-slot="0"]',keys[1])
        await page.reload()
        await expect(page.locator("#syncTitle")).to_contain_text("команд из таблицы")
        await page.locator('[data-camera="a"][data-slot="1"]').click()
        await expect(page.locator("#cameraRotation")).to_have_value("90")
        await expect(page.locator('#cameraZoom')).to_have_value('150')
        await page.click("#cameraApplyObs")
        await expect(page.locator("#toast")).to_contain_text("OBS обновлён")
        transforms=[r["requestData"] for r in obs.requests if r["requestType"]=="SetSceneItemTransform"]
        transform=next(r["sceneItemTransform"] for r in transforms if r["sceneName"]=="Игрок 2")
        assert {k:transform[k] for k in ("positionX","positionY","rotation","boundsWidth","boundsHeight")}=={
            "positionX":1608,"positionY":54,"rotation":90,"boundsWidth":972,"boundsHeight":1296}
        async with page.expect_download() as info:
            await page.click("#downloadBtn")
        data=json.loads((await (await info.value).path()).read_text())
        scene=next(s for s in data["sources"] if s["name"]=="Игрок 2")
        item=next(i for i in scene["settings"]["items"] if i["name"].startswith("CAM "))
        source=next(s for s in data["sources"] if s["uuid"]==item["source_uuid"])
        assert item["rot"]==90 and item["pos"]=={"x":1608,"y":54}
        assert source["settings"]["width"]==972 and source["settings"]["height"]==1296
        assert "&b64css=" in source["settings"]["url"]
        from urllib.parse import parse_qs,urlsplit
        css=base64.b64decode(parse_qs(urlsplit(source['settings']['url']).query)['b64css'][0]).decode()
        assert 'scale:1.5!important' in css
        await page.select_option("#cameraFrame","wide")
        await page.reload()
        await expect(page.locator("#cameraFrame")).to_have_value("wide")
        code=await page.evaluate("""async () => {
          const m=await import('/vdo.js'),code=m.newBridgeCode();
          localStorage.setItem('oneshot-obs',JSON.stringify({mode:'bridge',code}));
          return code;
        }""")
        old_dock=await context.new_page()
        await old_dock.goto(args.url.rstrip("/")+"/card.html")
        await old_dock.evaluate("""async code=>{
          const m=await import('/vdo.js');
          window.__legacyCommands=[];
          let link;
          link=new m.VdoLink(await m.bridgeSecrets(code),'dock',message=>{
            window.__legacyCommands.push(message.type);
            link.send({type:'result',id:message.id,ok:message.type==='hello',
              obs:'OBS ready',error:message.type==='hello'?'':'Неизвестная команда.'});
          });
          window.__legacyLink=link;
        }""",code)
        await page.reload()
        await expect(page.locator("#syncTitle")).to_contain_text("команд из таблицы")
        before=len(obs.requests)
        await page.click("#sendObsBtn")
        await expect(page.locator("#errorBox")).to_contain_text("Окно Oneshot у обсервера устарело",timeout=20000)
        assert "apply-camera" in await old_dock.evaluate("window.__legacyCommands")
        assert len(obs.requests)==before,"An incompatible dock must not partially modify cameras"
        await old_dock.close()
        assert not errors,errors
        await browser.close()
        print("PASS: "+args.browser+" camera cover/pan/rotation preview, one connection, player persistence across slots/reload, JSON/live parity, mobile, frame setting and outdated-dock rejection",flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--url",default="http://127.0.0.1:3000")
    parser.add_argument("--browser",choices=["chromium","webkit"],default="chromium")
    parser.add_argument("--chromium")
    parser.add_argument("--artifacts",default="artifacts/camera")
    parser.add_argument("--real-provider",action="store_true")
    asyncio.run(run(parser.parse_args()))
