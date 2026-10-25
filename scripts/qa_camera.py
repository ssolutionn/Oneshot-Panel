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
addEventListener('message',e=>{
  if(typeof e.data?.style==='string')style(e.data.style);
  if(e.data?.getStats)parent.postMessage({cib:e.data.cib,stats:{video:{_type:'video',_framesDecoded:1}}},'*');
});
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
                preview = '&cover' in route.request.url or '&scale=100' in route.request.url
                if preview: await preview_release.wait()
                await route.fulfill(content_type='text/html',body=CAMERA_HTML if preview else FAKE_VDO)
            await context.route("https://vdo.ninja/**",preview_route)
        page=await context.new_page()
        errors,previews=[],[]
        page.on("pageerror",lambda error:errors.append(str(error)))
        page.on("request",lambda req:previews.append(req.url) if req.url.startswith("https://vdo.ninja/") and ("&cover" in req.url or "&scale=100" in req.url) else None)
        obs=MockObs()
        await page.route_web_socket(OBS_URL,obs.handler)
        await page.goto(args.url)
        await expect(page.locator("#syncTitle")).to_contain_text("команд из таблицы")
        options=await page.locator("#matchSelect option").evaluate_all("els=>els.filter(e=>e.value).map(e=>e.value)")
        await page.select_option("#matchSelect",options[0])
        await expect(page.locator("#cameraFrame")).to_have_value("fullheight")
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
            assert await frame.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--fit-style').trim()")=="contain"
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
            # VDO may omit its theme class in clean/transparent output. The
            # contract is a transparent canvas, not a provider-internal class.
            await frame.wait_for_function("""() => [document.documentElement,document.body,document.querySelector('#main')].filter(Boolean).every(el=>{
              const color=getComputedStyle(el).backgroundColor.match(/[0-9.]+/g)?.map(Number)||[];
              return color.length===4 && color[3]===0;
            })""",timeout=15000)
            # An empty VDO page, including our test poster, is not a live camera.
            await expect(page.locator('#cameraPreviewBox')).to_have_attribute('data-loading','true')
            # Exercise VDO's real stats adapter with local WebRTC video. There
            # is no player device or external media/signalling dependency.
            await frame.evaluate("""async () => {
              const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
              const ctx=canvas.getContext('2d');
              const draw=()=>{ctx.fillStyle='#2695cb';ctx.fillRect(0,0,640,480)};
              draw();const timer=setInterval(draw,200),media=canvas.captureStream(5);
              const sender=new RTCPeerConnection({iceServers:[]}),receiver=new RTCPeerConnection({iceServers:[]});
              const incoming=new Promise(resolve=>receiver.ontrack=e=>resolve(e.streams[0]));
              sender.addTrack(media.getVideoTracks()[0],media);
              const gathered=pc=>pc.iceGatheringState==='complete'?Promise.resolve():new Promise(resolve=>{
                const listen=()=>{if(pc.iceGatheringState==='complete'){pc.removeEventListener('icegatheringstatechange',listen);resolve()}};
                pc.addEventListener('icegatheringstatechange',listen);listen();
              });
              await sender.setLocalDescription(await sender.createOffer());await gathered(sender);
              await receiver.setRemoteDescription(sender.localDescription);
              await receiver.setLocalDescription(await receiver.createAnswer());await gathered(receiver);
              await sender.setRemoteDescription(receiver.localDescription);
              const stream=await incoming,v=document.querySelector('#cameraQaMedia');
              v.muted=true;v.srcObject=stream;v.style.position='fixed';v.style.inset='0';v.style.width='100%';v.style.height='100%';
              await v.play();
              const uuid='camera-preview-qa';
              session.rpcs[uuid]={streamID:new URLSearchParams(location.search).get('view'),stats:{},
                streamSrc:stream,videoElement:v,getStats:()=>receiver.getStats()};
              window.__cameraQaLoopback={uuid,sender,receiver,timer,media};
              processStats(uuid);
            }""")
            await expect(page.locator('#cameraPreviewBox')).to_have_attribute('data-loading','false',timeout=20000)
            await expect(page.locator('#cameraPreviewBox iframe')).to_have_css('opacity','1')
            print('VDO_DECODED_VIDEO',await frame.evaluate("""() => Object.values(getQuickStats(new URLSearchParams(location.search).get('view'))||{}).filter(s=>s&&typeof s==='object').map(s=>({type:s._type,decoded:s._decodeFrames||s._framesDecoded,fps:s.FPS}))"""),flush=True)
            await frame.evaluate("""() => {
              const q=window.__cameraQaLoopback;clearInterval(q.timer);clearTimeout(session.rpcs[q.uuid]?.getStatsTimeout);
              delete session.rpcs[q.uuid];q.sender.close();q.receiver.close();q.media.getTracks().forEach(t=>t.stop());
              parent.postMessage({action:'view-connection',value:false,streamID:new URLSearchParams(location.search).get('view')},'*');
            }""")
            await expect(page.locator('#cameraPreviewBox iframe')).to_have_css('opacity','0')
            print('VDO_CANVAS',await frame.evaluate("""() => ({darkRequested:new URLSearchParams(location.search).has('darkmode'),
              backgrounds:[document.documentElement,document.body,document.querySelector('#main')].filter(Boolean).map(el=>getComputedStyle(el).backgroundColor)})"""),flush=True)
            await browser.close()
            print("PASS: current real VDO accepts cover URL and live style messages for camera pan/rotation; controlled media, no player stream",flush=True)
            return
        video=page.frame_locator("#cameraPreviewBox iframe").locator("video")
        await expect(video).to_be_visible()
        await expect(page.locator('#cameraPreviewBox')).to_have_attribute('data-loading','false')
        await expect(video).to_have_css("object-fit","contain")
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
            "positionX":1920,"positionY":0,"rotation":90,"boundsWidth":1080,"boundsHeight":1920}
        async with page.expect_download() as info:
            await page.click("#downloadBtn")
        data=json.loads((await (await info.value).path()).read_text())
        scene=next(s for s in data["sources"] if s["name"]=="Игрок 2")
        item=next(i for i in scene["settings"]["items"] if i["name"].startswith("CAM "))
        source=next(s for s in data["sources"] if s["uuid"]==item["source_uuid"])
        assert item["rot"]==90 and item["pos"]=={"x":1920,"y":0}
        assert source["settings"]["width"]==1080 and source["settings"]["height"]==1920
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
            link.send({type:'result',id:message.id,ok:['hello','apply-camera'].includes(message.type),
              obs:'OBS ready',error:message.type==='hello'?'':'Неизвестная команда.'});
          });
          window.__legacyLink=link;
        }""",code)
        await page.reload()
        await expect(page.locator("#syncTitle")).to_contain_text("команд из таблицы")
        before=len(obs.requests)
        await page.click("#sendObsBtn")
        await expect(page.locator("#errorBox")).to_contain_text("Окно Oneshot у обсервера устарело",timeout=20000)
        assert "apply-camera-zoom" in await old_dock.evaluate("window.__legacyCommands")
        assert len(obs.requests)==before,"An incompatible dock must not partially modify cameras"
        await old_dock.evaluate("""code=>localStorage.setItem('oneshot-obs-bridge',JSON.stringify({code,url:'ws://127.0.0.1:4455',password:'pw'}))""",code)
        await old_dock.close()
        dock=await context.new_page()
        dock_obs=MockObs()
        await dock.route_web_socket(OBS_URL,dock_obs.handler)
        await dock.goto(args.url.rstrip('/')+'/obs-bridge.html')
        await expect(dock.locator('#dockObs')).to_contain_text('подключён')
        await page.click('#sendObsBtn')
        await expect(page.locator('#toast')).to_contain_text('OBS обновлён',timeout=20000)
        await expect(page.locator('#errorBox')).to_be_hidden()
        urls=[r['requestData']['inputSettings'].get('url','') for r in dock_obs.requests
              if r['requestType']=='SetInputSettings']
        assert any('scale:1.5!important' in base64.b64decode(parse_qs(urlsplit(url).query)['b64css'][0]).decode()
                   for url in urls if 'b64css=' in url),'Updated dock lost zoom'
        await dock.close()
        assert not errors,errors
        await browser.close()
        print("PASS: "+args.browser+" camera cover/pan/rotation preview, one connection, player persistence across slots/reload, JSON/live parity, mobile, frame setting and outdated-dock rejection",flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--url",default="http://127.0.0.1:3000")
    parser.add_argument("--browser",choices=["chromium","webkit","firefox"],default="chromium")
    parser.add_argument("--chromium")
    parser.add_argument("--artifacts",default="artifacts/camera")
    parser.add_argument("--real-provider",action="store_true")
    asyncio.run(run(parser.parse_args()))
