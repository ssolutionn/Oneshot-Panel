"""Import exported camera scenes and applyMatch in real OBS/CEF.

The camera document is a controlled landscape poster with VDO's cover/CSS
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

from PIL import Image, ImageChops
import websockets
from qa_camera import CAMERA_HTML

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/"artifacts"/"camera-obs"


class CameraHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        data=CAMERA_HTML.encode()
        self.send_response(200)
        self.send_header("Content-Type","text/html; charset=utf-8")
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
    (config_root/"global.ini").write_text("[Basic]\nProfile=CameraQA\nProfileDir=CameraQA\nSceneCollection=Oneshot Camera QA\nSceneCollectionFile=OneshotCameraQA\n")
    settings=config_root/"plugin_config"/"obs-websocket"/"config.json"
    settings.parent.mkdir(parents=True,exist_ok=True)
    settings.write_text(json.dumps({"server_enabled":True,"server_port":4455,"auth_required":False,
                                  "alerts_enabled":False,"first_load":False}))
    log=(OUT/"obs.log").open("w")
    process=subprocess.Popen(["obs","--collection","Oneshot Camera QA","--profile","CameraQA",
        "--disable-shutdown-check","--disable-missing-files-check","--skip-release-check",
        "--disable-updater","--disable-auto-config","--no-sandbox","--disable-gpu","--disable-webgl"],
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
                    raise AssertionError(f"{label}: visible camera bounds {bounds}, expected {expected}")
                await asyncio.sleep(.5)

        # The exported collection, loaded by OBS, must really have ten scenes.
        names={s["sceneName"] for s in (await request("GetSceneList"))["scenes"]}
        assert all("Игрок "+str(i) in names for i in range(1,11)),names
        expected_colors=[(255,0,0),(0,255,0),(255,0,0),(0,0,255),(255,255,0),(255,255,0)]
        for slot,color in enumerate(expected_colors,1):
            image=await picture(slot,"json-slot-"+str(slot))
            point=(322,540) if slot in (1,2,5) else (960,64)
            actual=image.getpixel(point)
            assert all(abs(a-b)<25 for a,b in zip(actual,color)),(slot,actual,color)
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


if __name__=="__main__":
    asyncio.run(run())
