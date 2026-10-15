"""Real OBS + real VDO.Ninja: prove updates reach the actual CEF renderer."""
import asyncio
import base64
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen

import websockets
from playwright.async_api import async_playwright, expect

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qa_browser import gviz, sample_roster

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
        for _ in range(60):
            try:
                ws = await websockets.connect("ws://127.0.0.1:4455", max_size=16 * 1024 * 1024)
                break
            except OSError:
                if proc.poll() is not None:
                    raise RuntimeError("OBS exited")
                await asyncio.sleep(1)
        else:
            raise RuntimeError("OBS did not start")
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

        await request("CreateScene", {"sceneName": "Veto QA"})
        await request("SetCurrentProgramScene", {"sceneName": "Veto QA"})
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(viewport={"width":1440,"height":1000})
            await context.add_init_script("localStorage.setItem('oneshot-watch-cams', 'false')")
            async def sheets(route):
                schedule = parse_qs(urlsplit(route.request.url).query).get("gid") == ["815739139"]
                body = gviz([["Group B", "October 15", "16:00", "6yuBoJlbl", "HYPERSPIRIT"]],
                            ["Stage", "Date", "MSK", "Team 1", "Team 2"]) if schedule else sample_roster()
                await route.fulfill(content_type="application/javascript", body=body)
            await context.route("https://docs.google.com/**/gviz/**", sheets)
            panel = await context.new_page()
            await panel.goto(BASE)
            await expect(panel.locator("#syncTitle")).to_contain_text("команд из таблицы")
            await panel.evaluate("""Object.defineProperty(navigator,'clipboard',{value:{
              writeText:async text=>{window.copied=text;}
            }});""")
            await panel.click("#copyOverlay")
            url = await panel.evaluate("window.copied")
            assert "&r=" in url
            # No OBS credentials are configured in the panel: graphics are read-only.
            await request("CreateInput", {"sceneName": "Veto QA", "inputName": "Veto",
                                         "inputKind": "browser_source", "sceneItemEnabled": True,
                                         "inputSettings": {"url": url, "width": 1920, "height": 1080, "css": "",
                                                           "shutdown": False, "fps": 30, "fps_custom": True}})
            target = None
            for _ in range(30):
                try:
                    with urlopen("http://127.0.0.1:9222/json/list", timeout=2) as response:
                        pages = json.load(response)
                    target = next((item for item in pages if "/veto-overlay/overlay.html" in item.get("url", "")), None)
                    if target:
                        break
                except OSError:
                    pass
                await asyncio.sleep(1)
            assert target, "OBS browser target missing"
            cdp = await websockets.connect(target["webSocketDebuggerUrl"], max_size=16 * 1024 * 1024)
            cid = 0

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

            async def until(expression, timeout=30):
                for _ in range(timeout * 10):
                    if await evaluate(expression):
                        return
                    await asyncio.sleep(.1)
                raise AssertionError(expression + ": " + str(await evaluate(
                    "({ready:document.body?.dataset.ready,state:window.vetoOverlay?.getState(),frames:[...document.querySelectorAll('iframe')].map(f=>f.title)})")))

            await until("document.body?.dataset.ready === 'true'")
            print("OBS INITIAL", await evaluate("({state:vetoOverlay.getState(),scene:{...document.getElementById('scene').dataset}})"), flush=True)
            await expect(panel.locator("#vetoLiveStatus")).to_contain_text("Оверлей получает вето", timeout=60000)
            print("PASS: actual OBS CEF acknowledged the live VDO stream; no OBS password in panel", flush=True)
            sample = """(() => {
              const d=document.getElementById('scene').getContext('2d').getImageData(700,45,400,100).data;
              let h=2166136261;for(let i=0;i<d.length;i+=4)h=Math.imul(h^d[i]^d[i+1]^d[i+2],16777619);
              return h>>>0;
            })()"""
            before = await evaluate(sample)
            await asyncio.sleep(1.5)
            assert before != await evaluate(sample), "OBS smoke is frozen"
            print("PASS: real OBS smoke pixels move", flush=True)
            await panel.click('[data-map="Ancient"]')
            await until("vetoOverlay.getState()?.actions.length === 1")
            assert "Ancient" in await evaluate("document.getElementById('scene').dataset.animating")
            await asyncio.sleep(1)
            await panel.click('[data-map="Anubis"]')
            await until("vetoOverlay.getState()?.actions.length === 2")
            await asyncio.sleep(1)
            await panel.click('[data-map="Mirage"]')
            await until("vetoOverlay.getState()?.pending === 'Mirage'")
            await panel.click("#chooseCT")
            await until("vetoOverlay.getState()?.actions.length === 3")
            assert "Mirage" in await evaluate("document.getElementById('scene').dataset.animating")
            print("PASS: manual bans, pending pick, side choice and card animations reach actual OBS", flush=True)
            await asyncio.sleep(1)
            shot = await request("GetSourceScreenshot", {"sourceName": "Veto", "imageFormat": "jpg",
                                                        "imageWidth": 960, "imageHeight": 540})
            raw = base64.b64decode(shot["imageData"].split(",", 1)[1])
            (OUT / "live-veto.jpg").write_bytes(raw)
            print("OBS_VETO_PREVIEW_BEGIN", flush=True)
            print(base64.b64encode(raw).decode(), flush=True)
            print("OBS_VETO_PREVIEW_END", flush=True)
            await evaluate("location.reload(); true")
            await asyncio.sleep(1)
            await until("window.vetoOverlay?.getState()?.actions.length === 3", timeout=40)
            print("PASS: refreshed OBS source recovers current veto without another admin click", flush=True)
            await panel.uncheck("#vetoLive")
            await cdp.close()
            await browser.close()
        await ws.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        print("OBS LOG TAIL", (OUT / "obs.log").read_text()[-7000:], flush=True)


if __name__ == "__main__":
    os.environ["XDG_CONFIG_HOME"] = str(Path("work/obs-runtime-config").resolve())
    asyncio.run(run())
