"""Exercise the actual OBS browser plugin, not a synthetic DOM event."""
import asyncio
import base64
import json
import os
import subprocess
from urllib.request import urlopen
from pathlib import Path

import websockets

OUT = Path("artifacts/obs-runtime")
BASE = "http://127.0.0.1:3000"


async def run():
    OUT.mkdir(parents=True, exist_ok=True)
    config = Path(os.environ["XDG_CONFIG_HOME"]) / "obs-studio/plugin_config/obs-websocket/config.json"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(json.dumps({"server_enabled": True, "server_port": 4455, "auth_required": False,
                                 "alerts_enabled": False, "first_load": False}))
    log = (OUT / "obs.log").open("w")
    proc = subprocess.Popen(["obs", "--disable-shutdown-check", "--disable-missing-files-check",
                             "--skip-release-check", "--disable-updater", "--disable-auto-config",
                             "--remote-debugging-port=9222", "--no-sandbox"],
                            stdout=log, stderr=subprocess.STDOUT)
    try:
        for _ in range(90):
            try:
                ws = await websockets.connect("ws://127.0.0.1:4455")
                break
            except OSError:
                if proc.poll() is not None:
                    raise RuntimeError("OBS exited: " + (OUT / "obs.log").read_text()[-9000:])
                await asyncio.sleep(1)
        else:
            raise RuntimeError("OBS did not start: " + (OUT / "obs.log").read_text()[-9000:])
        hello = json.loads(await ws.recv())
        print("OBS HELLO", hello, flush=True)
        await ws.send(json.dumps({"op": 1, "d": {"rpcVersion": 1, "eventSubscriptions": 0}}))
        assert json.loads(await ws.recv())["op"] == 2
        seq = 0

        async def request(kind, data=None):
            nonlocal seq
            seq += 1
            rid = str(seq)
            await ws.send(json.dumps({"op": 6, "d": {"requestType": kind, "requestId": rid,
                                                    "requestData": data or {}}}))
            while True:
                reply = json.loads(await ws.recv())
                if reply.get("op") == 7 and reply["d"]["requestId"] == rid:
                    assert reply["d"]["requestStatus"]["result"], reply
                    return reply["d"].get("responseData", {})

        print("OBS VERSION", await request("GetVersion"), flush=True)
        await request("CreateScene", {"sceneName": "Veto QA"})
        await request("SetCurrentProgramScene", {"sceneName": "Veto QA"})
        state = {"version": 1, "teams": ["Rune Eaters", "PCIFIC"], "format": "BO3", "first": 0,
                 "actions": [], "pending": None, "stage": "Runtime QA"}
        packed = base64.urlsafe_b64encode(json.dumps(state).encode()).decode().rstrip("=")
        url = BASE + "/assets/veto-overlay/overlay.html?layout=full#s=" + packed
        await request("CreateInput", {"sceneName": "Veto QA", "inputName": "Veto",
                                     "inputKind": "browser_source", "sceneItemEnabled": True,
                                     "inputSettings": {"url": url, "width": 1920, "height": 1080,
                                                       "shutdown": False, "fps": 30, "fps_custom": True}})
        target = None
        for _ in range(30):
            try:
                with urlopen("http://127.0.0.1:9222/json/list", timeout=2) as response:
                    pages = json.load(response)
                target = next((item for item in pages if "/veto-overlay/overlay.html" in item.get("url", "")), None)
                if target:
                    break
            except Exception as error:
                print("CDP waiting", str(error), flush=True)
            await asyncio.sleep(1)
        assert target, "OBS browser target missing"
        cdp = await websockets.connect(target["webSocketDebuggerUrl"], max_size=16 * 1024 * 1024)
        cid = 0

        async def command(method, params):
            nonlocal cid
            cid += 1
            await cdp.send(json.dumps({"id": cid, "method": method, "params": params}))
            while True:
                reply = json.loads(await cdp.recv())
                if reply.get("id") == cid:
                    return reply

        async def evaluate(expression):
            nonlocal cid
            cid += 1
            await cdp.send(json.dumps({"id": cid, "method": "Runtime.evaluate",
                                      "params": {"expression": expression, "returnByValue": True, "awaitPromise": True}}))
            while True:
                reply = json.loads(await cdp.recv())
                if reply.get("id") == cid:
                    assert "error" not in reply, reply
                    result = reply["result"]
                    assert "exceptionDetails" not in result, result
                    return result["result"].get("value")

        for _ in range(100):
            if await evaluate("document.body?.dataset.ready === 'true'"):
                break
            await asyncio.sleep(.2)
        else:
            raise RuntimeError("Overlay did not initialize")
        print("OBS INITIAL", await evaluate("({state: vetoOverlay.getState(), scene: {...document.getElementById('scene').dataset}, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches})"), flush=True)
        sample = """(() => {
          const c=document.getElementById('scene'), d=c.getContext('2d').getImageData(700,45,400,100).data;
          let h=2166136261;for(let i=0;i<d.length;i+=4)h=Math.imul(h^d[i]^d[i+1]^d[i+2],16777619);
          return h>>>0;
        })()"""
        before = await evaluate(sample)
        await asyncio.sleep(1.5)
        print("SMOKE MOVES", before != await evaluate(sample), flush=True)
        state["actions"] = [{"map": "Ancient", "type": "ban", "team": 0}]
        print("EMIT", await request("CallVendorRequest", {"vendorName": "obs-browser", "requestType": "emit_event",
                  "requestData": {"event_name": "oneshot-veto", "event_data": state}}), flush=True)
        await asyncio.sleep(.3)
        print("AFTER NATIVE EVENT", await evaluate("({state: vetoOverlay.getState(),scene: {...document.getElementById('scene').dataset}})"), flush=True)
        shot = await request("GetSourceScreenshot", {"sourceName": "Veto", "imageFormat": "png", "imageWidth": 1920, "imageHeight": 1080})
        (OUT / "native-ban.png").write_bytes(base64.b64decode(shot["imageData"].split(",", 1)[1]))
        received = (await evaluate("vetoOverlay.getState()"))["actions"] == state["actions"]
        if not received:
            print("BYPASS CSP PROBE", await command("Page.setBypassCSP", {"enabled": True}), flush=True)
            await request("CallVendorRequest", {"vendorName": "obs-browser", "requestType": "emit_event",
                          "requestData": {"event_name": "oneshot-veto", "event_data": state}})
            await asyncio.sleep(.5)
            print("AFTER CSP BYPASS", await evaluate("vetoOverlay.getState()"), flush=True)
        assert received, "OBS accepted event but source never received it"
        print("PASS: actual OBS delivers veto to browser source", flush=True)
        await cdp.close()
        await ws.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        print("OBS LOG TAIL", (OUT / "obs.log").read_text()[-10000:], flush=True)


if __name__ == "__main__":
    os.environ["XDG_CONFIG_HOME"] = str(Path("work/obs-runtime-config").resolve())
    asyncio.run(run())
