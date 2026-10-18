"""Import exported camera scenes and applyMatch in real OBS/CEF.

The camera document plays a controlled landscape clip with VDO's cover/CSS
contract. OBS itself, its collection reader, transforms and screenshots are real.
No player stream or webcam is accessed.
"""
import asyncio
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import urllib.request

from PIL import Image, ImageChops, ImageDraw
import websockets
from qa_camera import CAMERA_HTML

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/"artifacts"/"camera-obs"


class CameraHandler(BaseHTTPRequestHandler):
    requests=0
    def do_GET(self):
        type(self).requests+=1
        movie=self.path.split('?',1)[0]=='/camera.webm'
        data=(OUT/'camera.webm').read_bytes() if movie else CAMERA_HTML.replace(
            '<video poster=', '<video autoplay muted loop playsinline src="/camera.webm" poster=').encode()
        self.send_response(200)
        self.send_header("Content-Type","video/webm" if movie else "text/html; charset=utf-8")
        self.send_header("Content-Length",str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self,*args):
        pass


NODE_FIXTURE = """
import fs from 'node:fs';
import {buildObs} from './core.js';
const a={name:'Camera QA A',players:[]},b={name:'Camera QA B',players:[]};
const cameras=[
 {rotation:0,panX:0,panY:50},{rotation:0,panX:100,panY:50},
 {rotation:90,panX:50,panY:0},{rotation:90,panX:50,panY:100},
 {rotation:180,panX:0,panY:50},{rotation:270,panX:50,panY:0}
];
for(let i=0;i<10;i++)(i<5?a:b).players.push({
 key:'qa'+i,id:'qa'+i,nick:'Player'+i,room:'camera-qa',camera:cameras[i]||{rotation:0,panX:50,panY:50}
});
const document=buildObs(JSON.parse(fs.readFileSync('assets/obs-template.json','utf8')),
 a,b,a.players.map(p=>p.key),b.players.map(p=>p.key));
document.name='Oneshot Camera QA';
for(const scene of document.sources.filter(s=>s.id==='scene' && /^Игрок /.test(s.name))){
 for(const item of scene.settings.items)if(!item.name.startsWith('CAM '))item.visible=false;
}
for(const source of document.sources.filter(s=>s.name.startsWith('CAM '))){
 source.settings.url=source.settings.url.replace('https://vdo.ninja/',process.env.QA_CAMERA_ORIGIN+'/');
 source.settings.shutdown=false;source.settings.restart_when_active=false;
}
const players=[...a.players.map(p=>({...p,team:a.name})),...b.players.map(p=>({...p,team:b.name}))]
 .map((p,i)=>({...p,slot:i+1}));
console.log(JSON.stringify({document,players}));
"""


def fixture(origin):
    result=subprocess.run(["node","--input-type=module","-e",NODE_FIXTURE],cwd=ROOT,
                          env=dict(os.environ,QA_CAMERA_ORIGIN=origin),capture_output=True,text=True,check=True)
    return json.loads(result.stdout)


async def run():
    OUT.mkdir(parents=True,exist_ok=True)
    poster=Image.new('RGB',(1600,900))
    draw=ImageDraw.Draw(poster)
    for i,color in enumerate(('red','lime','blue','yellow')):
        draw.rectangle((i*400,0,(i+1)*400-1,899),fill=color)
    poster.save(OUT/'camera.png')
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-loop','1',
        '-i',str(OUT/'camera.png'),'-t','2','-r','5','-c:v','libvpx',
        '-deadline','realtime','-cpu-used','8','-pix_fmt','yuv420p','-an',str(OUT/'camera.webm')],check=True)
    server=ThreadingHTTPServer(("127.0.0.1",0),CameraHandler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    origin="http://127.0.0.1:"+str(server.server_address[1])
    data=fixture(origin)
    config_root=Path(os.environ["XDG_CONFIG_HOME"])/"obs-studio"
    scenes=config_root/"basic"/"scenes"
    scenes.mkdir(parents=True,exist_ok=True)
    (scenes/"OneshotCameraQA.json").write_text(json.dumps(data["document"]))
    profile=config_root/"basic"/"profiles"/"CameraQA"
    profile.mkdir(parents=True,exist_ok=True)
    (profile/"basic.ini").write_text("[General]\nName=CameraQA\n[Video]\nBaseCX=1920\nBaseCY=1080\nOutputCX=1920\nOutputCY=1080\nFPSType=0\nFPSCommon=30\n")
    # Use CEF's software paint path with Xvfb/Mesa. Disabling GPU only via
    # Chromium flags leaves OBS expecting shared GPU textures on some builds.
    (config_root/"global.ini").write_text("[General]\nBrowserHWAccel=false\n[Basic]\nProfile=CameraQA\nProfileDir=CameraQA\nSceneCollection=Oneshot Camera QA\nSceneCollectionFile=OneshotCameraQA\n")
    settings=config_root/"plugin_config"/"obs-websocket"/"config.json"
    settings.parent.mkdir(parents=True,exist_ok=True)
    settings.write_text(json.dumps({"server_enabled":True,"server_port":4455,"auth_required":False,
                                  "alerts_enabled":False,"first_load":False}))
    log=(OUT/"obs.log").open("w")
    process=subprocess.Popen(["obs","--collection","Oneshot Camera QA","--profile","CameraQA",
        "--disable-shutdown-check","--disable-missing-files-check","--skip-release-check",
        "--disable-updater","--disable-auto-config","--remote-debugging-port=9223","--no-sandbox","--disable-gpu","--disable-webgl"],
        stdout=log,stderr=subprocess.STDOUT)
    ws=None
    try:
        for _ in range(80):
            try:
                ws=await websockets.connect("ws://127.0.0.1:4455",max_size=16*1024*1024)
                break
            except OSError:
                if process.poll() is not None: raise RuntimeError("OBS exited before WebSocket startup")
                await asyncio.sleep(.5)
        if ws is None: raise RuntimeError("OBS WebSocket unavailable")
        assert json.loads(await ws.recv())["op"]==0
        await ws.send(json.dumps({"op":1,"d":{"rpcVersion":1,"eventSubscriptions":0}}))
        assert json.loads(await ws.recv())["op"]==2
        sequence=0
        async def request(kind,body=None,attempt=0):
            nonlocal sequence
            sequence+=1
            rid=str(sequence)
            await ws.send(json.dumps({"op":6,"d":{"requestType":kind,"requestId":rid,"requestData":body or {}}}))
            while True:
                reply=json.loads(await asyncio.wait_for(ws.recv(),timeout=15))
                if reply.get("op")==7 and reply["d"]["requestId"]==rid:
                    if reply["d"]["requestStatus"].get("code")==207 and attempt<60:
                        await asyncio.sleep(.5)
                        return await request(kind,body,attempt+1)
                    assert reply["d"]["requestStatus"]["result"],reply
                    return reply["d"].get("responseData",{})

        async def picture(slot,label,expected=(312,54,1608,1026)):
            await request("SetCurrentProgramScene",{"sceneName":"Игрок "+str(slot)})
            camera_name=next(p['name'] for p in data['document']['sources'] if p['name'].startswith(f'CAM {slot:02} '))
            print('CAMERA_ACTIVITY',slot,await request('GetSourceActive',{'sourceName':camera_name}),flush=True)
            # Drive the controlled input explicitly. A paused poster is not a
            # playing webcam; OSR autoplay policy is outside this geometry test.
            for attempt in range(40):
                with urllib.request.urlopen('http://127.0.0.1:9223/json/list',timeout=3) as targets:
                    pages=json.load(targets)
                target=next((p for p in pages if p.get('url','').startswith(origin+'/') and
                    ('?view=qa'+str(slot-1)+'&') in p['url']),None)
                if target: break
                await asyncio.sleep(.25)
            assert target,'Controlled media browser target unavailable'
            async with websockets.connect(target['webSocketDebuggerUrl']) as cdp:
                await cdp.send(json.dumps({'id':1,'method':'Runtime.evaluate','params':{
                    'expression':"(async()=>{for(let n=0;n<100;n++){const v=document.querySelector('video');if(v){v.muted=true;await v.play();return {paused:v.paused,width:v.videoWidth,height:v.videoHeight}}await new Promise(r=>setTimeout(r,50))}throw Error('Controlled video document did not load')})()",
                    'awaitPromise':True,'returnByValue':True}}))
                while True:
                    playback=json.loads(await asyncio.wait_for(cdp.recv(),timeout=15))
                    if playback.get('id')==1:
                        print('CAMERA_PLAYBACK',slot,json.dumps(playback),flush=True)
                        assert 'exceptionDetails' not in playback.get('result',{}),playback
                        break
            started=time.monotonic()
            while True:
                response=await request("GetSourceScreenshot",{"sourceName":"Игрок "+str(slot),
                    "imageFormat":"png","imageWidth":1920,"imageHeight":1080})
                raw=base64.b64decode(response["imageData"].split(",",1)[1])
                image=Image.open(io.BytesIO(raw)).convert("RGB")
                mask=ImageChops.difference(image,Image.new("RGB",image.size)).convert("L").point(lambda v:255 if v>20 else 0)
                bounds=mask.getbbox()
                if bounds and all(abs(a-b)<=1 for a,b in zip(bounds,expected)):
                    (OUT/(label+".png")).write_bytes(raw)
                    return image
                if time.monotonic()-started>25:
                    (OUT/(label+"-failed.png")).write_bytes(raw)
                    items=(await request("GetSceneItemList",{"sceneName":"Игрок "+str(slot)}))["sceneItems"]
                    print("CAMERA_DIAGNOSTICS",json.dumps({"httpRequests":CameraHandler.requests,"items":items}),flush=True)
                    try:
                        with urllib.request.urlopen("http://127.0.0.1:9223/json/list",timeout=3) as targets:
                            pages=json.load(targets)
                        for target in [p for p in pages if p.get("url","").startswith(origin)][:1]:
                            async with websockets.connect(target["webSocketDebuggerUrl"]) as cdp:
                                await cdp.send(json.dumps({"id":1,"method":"Runtime.evaluate","params":{
                                    "expression":"JSON.stringify({url:location.href,width:innerWidth,height:innerHeight,video:[...document.querySelectorAll('video')].map(v=>({rect:v.getBoundingClientRect(),fit:getComputedStyle(v).objectFit,ready:v.readyState,videoWidth:v.videoWidth,videoHeight:v.videoHeight,paused:v.paused,error:v.error?.message}))})","returnByValue":True}}))
                                while True:
                                    value=json.loads(await cdp.recv())
                                    if value.get("id")==1:
                                        print("CAMERA_CEF",json.dumps(value)[:6000],flush=True)
                                        break
                    except Exception as error: print("CAMERA_CEF_DIAGNOSTICS",str(error),flush=True)
                    raise AssertionError(f"{label}: visible camera bounds {bounds}, expected {expected}")
                await asyncio.sleep(.5)

        # The exported collection, loaded by OBS, must really have ten scenes.
        names={s["sceneName"] for s in (await request("GetSceneList"))["scenes"]}
        assert all("Игрок "+str(i) in names for i in range(1,11)),names
        transitions=await request('GetSceneTransitionList')
        print('CAMERA_TRANSITIONS',json.dumps(transitions),flush=True)
        cut=next(t for t in transitions['transitions'] if t['transitionKind']=='cut_transition')
        await request('SetCurrentSceneTransition',{'transitionName':cut['transitionName']})
        expected_colors=[(255,0,0),(0,255,0),(255,0,0),(0,0,255),(255,255,0),(255,255,0)]
        for slot,color in enumerate(expected_colors,1):
            image=await picture(slot,"json-slot-"+str(slot))
            point=(322,540) if slot in (1,2,5) else (960,64)
            actual=image.getpixel(point)
            # VP8 YUV and OBS color conversion can shift channel intensity.
            # The independent oracle is the bar's color category and location,
            # not byte-identical RGB after decoding/compositing.
            assert all(a>=150 if b==255 else a<=70 for a,b in zip(actual,color)),(slot,actual,color)
        print("PASS: real OBS imports JSON; 0/90/180/270 cameras cover exactly the inner frame; crop/pan colors match",flush=True)

        manifest=OUT/"players.json"
        manifest.write_text(json.dumps(data["players"]))
        async def live(frame,rotation):
            script="""
              import fs from 'node:fs';
              import {ObsClient,applyMatch} from './obs.js';
              const client=await new ObsClient().connect();
              const players=JSON.parse(fs.readFileSync(process.env.QA_CAMERA_PLAYERS,'utf8'));
              players[0].camera={rotation:Number(process.env.QA_CAMERA_ROTATION),panX:20,panY:80};
              const proxy={request:(kind,data={})=>{
                if(kind==='SetInputSettings'&&data.inputSettings?.url?.startsWith('https://vdo.ninja/')){
                  data={...data,inputSettings:{...data.inputSettings,
                    url:data.inputSettings.url.replace('https://vdo.ninja/',process.env.QA_CAMERA_ORIGIN+'/')}};
                }
                return client.request(kind,data);
              }};
              try{await applyMatch(proxy,{players,cameraFrame:process.env.QA_CAMERA_FRAME});}
              finally{client.close();}
            """
            command=await asyncio.create_subprocess_exec("node","--input-type=module","-e",script,cwd=ROOT,
                env=dict(os.environ,QA_CAMERA_ORIGIN=origin,QA_CAMERA_PLAYERS=str(manifest),
                         QA_CAMERA_ROTATION=str(rotation),QA_CAMERA_FRAME=frame),
                stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.STDOUT)
            output,_=await command.communicate()
            assert command.returncode==0,output.decode()
        for frame,rotation,bounds in [("inner43",270,(312,54,1608,1026)),
                                     ("full43",180,(240,0,1680,1080)),("wide",90,(0,0,1920,1080))]:
            await live(frame,rotation)
            await picture(1,"live-"+frame,bounds)
            items=await request("GetSceneItemList",{"sceneName":"Игрок 1"})
            camera=next(i for i in items["sceneItems"] if i["sourceName"].startswith("CAM "))
            transform=(await request("GetSceneItemTransform",{"sceneName":"Игрок 1","sceneItemId":camera["sceneItemId"]}))["sceneItemTransform"]
            assert transform["rotation"]==rotation,transform
        print("PASS: real applyMatch and CEF resize/rotate the same sources for inner 4:3, full-height 4:3 and full canvas",flush=True)
    finally:
        if ws: await ws.close()
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill()
        log.close()
        server.shutdown()
        lines=(OUT/"obs.log").read_text(errors="replace").splitlines()
        print("OBS_DIAGNOSTICS",'\n'.join(line for line in lines if any(word in line.lower()
            for word in ('error:','cef','[obs-browser]')))[:6000],flush=True)


if __name__=="__main__":
    asyncio.run(run())
