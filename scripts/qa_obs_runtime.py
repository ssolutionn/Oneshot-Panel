"""Exercise the actual OBS browser plugin, not a synthetic DOM event."""
import asyncio
import base64
import json
import os
import subprocess
from pathlib import Path

import websockets
from playwright.async_api import async_playwright

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
        async with async_playwright() as p:
            for _ in range(30):
                try:
                    cef = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
                    break
                except Exception:
                    await asyncio.sleep(1)
            else:
                raise RuntimeError("OBS CDP missing: " + (OUT / "obs.log").read_text()[-9000:])
            overlay = None
            for _ in range(30):
                pages = [page for ctx in cef.contexts for page in ctx.pages if "/veto-overlay/overlay.html" in page.url]
                if pages:
                    overlay = pages[0]
                    break
                await asyncio.sleep(1)
            assert overlay, [(page.url) for ctx in cef.contexts for page in ctx.pages]
            errors = []
            overlay.on("console", lambda msg: print("CEF", msg.type, msg.text, flush=True))
            overlay.on("pageerror", lambda error: errors.append(str(error)))
            await overlay.wait_for_function("document.body.dataset.ready === 'true'", timeout=30000)
            print("OBS INITIAL", await overlay.evaluate("({state: vetoOverlay.getState(), scene: {...document.getElementById('scene').dataset}, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches})"), flush=True)
            sample = """() => {
              const c=document.getElementById('scene'), d=c.getContext('2d').getImageData(700,45,400,100).data;
              let h=2166136261;for(let i=0;i<d.length;i+=4)h=Math.imul(h^d[i]^d[i+1]^d[i+2],16777619);
              return h>>>0;
            }"""
            before = await overlay.evaluate(sample)
            await asyncio.sleep(1.5)
            print("SMOKE MOVES", before != await overlay.evaluate(sample), flush=True)
            state["actions"] = [{"map": "Ancient", "type": "ban", "team": 0}]
            print("EMIT", await request("CallVendorRequest", {"vendorName": "obs-browser", "requestType": "emit_event",
                      "requestData": {"event_name": "oneshot-veto", "event_data": state}}), flush=True)
            await asyncio.sleep(.3)
            print("AFTER NATIVE EVENT", await overlay.evaluate("({state: vetoOverlay.getState(),scene: {...document.getElementById('scene').dataset}})"), flush=True)
            await overlay.screenshot(path=str(OUT / "native-ban.png"))
            assert (await overlay.evaluate("vetoOverlay.getState()"))["actions"] == state["actions"], "OBS accepted event but source never received it"
            print("PASS: actual OBS delivers veto to browser source", flush=True)
            assert not errors, errors
            await cef.close()
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
