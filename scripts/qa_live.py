"""Browser QA for the site-only parts of the panel: the Подготовка/Лобби tabs,
webcam status, «Отправить в OBS» (directly and through the OBS dock), copying
the JSON, the live veto overlay and the FACEIT lobby with its alerts.

Google Sheets, VDO.Ninja, obs-websocket and FACEIT are all simulated:

  python3 scripts/qa_live.py --url http://127.0.0.1:3000 --chromium /path/to/chrome
"""
import argparse
import asyncio
import base64
import hashlib
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.async_api import async_playwright, expect

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qa_browser import gviz, sample_roster  # noqa: E402

OBS_URL = re.compile(r"^ws://127\.0\.0\.1:4455/?$")
CHAMP = "8f2a5c1e-1234-4abc-9def-0123456789ab"

# Stands in for VDO.Ninja inside the hidden iframes. Stream IDs ending in -4
# are "offline"; sendData is relayed between the OBS dock (push) and the
# panels (view) of one pairing code with a BroadcastChannel.
FAKE_VDO = """<!doctype html><script>
const q = new URLSearchParams(location.search);
const room = q.get('room') || '', label = q.get('label') || '';
const view = (q.get('view') || '').split(',').filter(Boolean);
const live = Object.fromEntries(view.filter(id => !/-4$/.test(id)).map(id => [id, id]));
// The dock and the panels share the derived password; team viewers a room.
const bus = new BroadcastChannel('fake-vdo:' + (q.get('password') || room));
const me = label + ':' + Math.random().toString(36).slice(2);
addEventListener('message', e => {
  const d = e.data || {};
  if (d.getStreamIDs) parent.postMessage({ streamIDs: live }, '*');
  if (d.sendData) bus.postMessage({ dataReceived: d.sendData, UUID: me });
});
bus.onmessage = e => parent.postMessage(e.data, '*');
</script>"""


class MockObs:
    """obs-websocket v5 with ten «Игрок N» scenes, each holding one camera."""
    SALT, CHALLENGE = "c2FsdA==", "Y2hhbGxlbmdl"

    def __init__(self, password="pw"):
        self.password, self.requests, self.next_id = password, [], 100
        self.inputs = {f"Камера {i}": {} for i in range(1, 11)}
        self.scenes = {f"Игрок {i}": [{"sceneItemId": 4, "sourceName": f"Камера {i}",
                                       "inputKind": "browser_source"}] for i in range(1, 11)}

    def handler(self, ws):
        ws.send(json.dumps({"op": 0, "d": {"obsWebSocketVersion": "5.5.0", "rpcVersion": 1,
                                           "authentication": {"salt": self.SALT, "challenge": self.CHALLENGE}}}))

        # Playwright calls message handlers synchronously.
        def on_message(message):
            m = json.loads(message)
            if m["op"] == 1:
                secret = base64.b64encode(hashlib.sha256((self.password + self.SALT).encode()).digest()).decode()
                expected = base64.b64encode(hashlib.sha256((secret + self.CHALLENGE).encode()).digest()).decode()
                if m["d"].get("authentication") != expected:
                    asyncio.ensure_future(ws.close(code=4009, reason="Authentication failed."))
                    return
                ws.send(json.dumps({"op": 2, "d": {"negotiatedRpcVersion": 1}}))
            elif m["op"] == 6:
                d = m["d"]
                self.requests.append(d)
                try:
                    data, status = self.answer(d["requestType"], d.get("requestData") or {}), {"result": True, "code": 100}
                except KeyError as error:
                    data, status = None, {"result": False, "code": 600, "comment": f"Not found: {error}"}
                reply = {"requestType": d["requestType"], "requestId": d["requestId"], "requestStatus": status}
                if data is not None:
                    reply["responseData"] = data
                ws.send(json.dumps({"op": 7, "d": reply}))
        ws.on_message(on_message)

    def answer(self, kind, data):
        if kind == "GetSceneItemList":
            return {"sceneItems": [{**it, "sceneItemIndex": i} for i, it in enumerate(self.scenes[data["sceneName"]])]}
        if kind == "SetInputSettings":
            self.inputs[data["inputName"]].update(data["inputSettings"])
            return {}
        if kind == "SetInputName":
            self.inputs[data["newInputName"]] = self.inputs.pop(data["inputName"])
            for items in self.scenes.values():
                for it in items:
                    if it["sourceName"] == data["inputName"]:
                        it["sourceName"] = data["newInputName"]
            return {}
        if kind == "CreateInput":
            self.next_id += 1
            self.inputs[data["inputName"]] = dict(data["inputSettings"])
            self.scenes[data["sceneName"]].append({"sceneItemId": self.next_id, "sourceName": data["inputName"],
                                                   "inputKind": data["inputKind"]})
            return {"sceneItemId": self.next_id}
        if kind == "SetSceneItemIndex":
            items = self.scenes[data["sceneName"]]
            item = next(it for it in items if it["sceneItemId"] == data["sceneItemId"])
            items.remove(item)
            items.insert(data["sceneItemIndex"], item)
            return {}
        if kind in ("SetSceneItemTransform", "SetSceneItemEnabled", "CallVendorRequest"):
            return {}
        raise KeyError(kind)

    def names(self, prefix):
        return sorted(n for n in self.inputs if n.startswith(prefix))


def faceit_match(mid, status, score, maps, teams=("Rune Eaters", "PCIFIC"), finished=None):
    result = {"score": {"faction1": score[0], "faction2": score[1]}}
    if status == "FINISHED":
        result["winner"] = "faction1" if score[0] > score[1] else "faction2"
    return {
        "match_id": mid, "status": status, "best_of": 3,
        "faceit_url": f"https://www.faceit.com/{{lang}}/cs2/room/{mid}",
        "teams": {"faction1": {"name": teams[0]}, "faction2": {"name": teams[1]}},
        "results": result, "detailed_results": [{"winner": w} for w in maps],
        "voting": {"map": {"pick": ["de_mirage", "de_nuke", "de_ancient"]}},
        "scheduled_at": 1760536800, "started_at": 1760536800,
        **({"finished_at": finished} if finished else {}),
    }


def pack(state):
    return base64.urlsafe_b64encode(json.dumps(state).encode()).decode().rstrip("=")


async def run(args):
    base = args.url.rstrip("/")
    output = Path(args.artifacts)
    output.mkdir(parents=True, exist_ok=True)
    checks = []

    def passed(name):
        checks.append(name)
        print("PASS:", name, flush=True)

    async def sheets(route):
        is_schedule = parse_qs(urlsplit(route.request.url).query).get("gid") == ["815739139"]
        body = gviz([["Group B", "October 15", "16:00", "6yuBoJlbl", "HYPERSPIRIT"]],
                    ["Stage", "Date", "MSK", "Team 1", "Team 2"]) if is_schedule else sample_roster()
        await route.fulfill(content_type="application/javascript", body=body)

    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=args.chromium, headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 1000},
                                            locale="ru-RU", timezone_id="Europe/Moscow")
        await context.route("https://docs.google.com/**/gviz/**", sheets)
        await context.route("https://vdo.ninja/**", lambda route: route.fulfill(content_type="text/html", body=FAKE_VDO))
        errors = []
        # CSP violations of our own pages only: the published site also gets
        # Netlify's injected badge iframe, whose inline script is not ours.
        await context.expose_binding("reportCsp", lambda source, text:
                                     errors.append(f"CSP {source['page'].url}: {text}")
                                     if source["frame"] == source["page"].main_frame else None)
        await context.add_init_script("""
            addEventListener('securitypolicyviolation', event =>
              window.reportCsp?.(`${event.violatedDirective} ${event.blockedURI}`));""")
        page = await context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        obs = MockObs()
        await page.route_web_socket(OBS_URL, obs.handler)
        await page.goto(base + "/")
        await expect(page.locator("#syncTitle")).to_contain_text("команд из таблицы")

        # Tabs and webcam status.
        await expect(page.locator("#viewPrep")).to_have_attribute("aria-selected", "true")
        await expect(page.locator("#camTotal")).to_have_text("Нет камеры: 2 · 8/10 в эфире")
        assert await page.locator(".player-row[data-cam=live]").count() == 8
        assert await page.locator(".player-row[data-cam=off]").count() == 2
        await expect(page.locator(".team-cams").first).to_have_text("4/5")
        await page.uncheck("#watchCams")
        await expect(page.locator("#camTotal")).to_have_text("Статус вебок выключен")
        assert await page.locator("iframe[title='Статус вебок']").count() == 0
        await page.check("#watchCams")
        await expect(page.locator("#camTotal")).to_contain_text("8/10")
        await page.click("#viewLobby")
        await expect(page.locator("#lobbyView")).to_be_visible()
        await expect(page.locator("#prepView")).to_be_hidden()
        await page.reload()
        await expect(page.locator("#viewLobby")).to_have_attribute("aria-selected", "true")
        await page.focus("#viewLobby")
        await page.keyboard.press("ArrowLeft")
        await expect(page.locator("#prepView")).to_be_visible()
        await expect(page.locator("#viewPrep")).to_be_focused()
        passed("tabs, keyboard switching and webcam status 8/10")

        # Set up through the visible form next to veto, without seeding storage.
        await expect(page.locator("#veto #obsForm")).to_be_visible()
        await expect(page.locator("#obsBridgeFields")).to_contain_text("Что сделать на компьютере с OBS")
        await page.check('input[name=obsMode][value=direct]')
        await expect(page.locator("#obsDirectFields")).to_be_visible()
        await expect(page.locator("#obsBridgeFields")).to_be_hidden()
        await expect(page.locator("#obsUrl")).to_have_value(OBS_URL)
        await expect(page.locator("#obsDirectFields")).to_contain_text("Показать сведения о подключении")
        await page.fill("#obsPassword", "wrong")
        await page.click("#testObs")
        await expect(page.locator("#obsTestResult")).to_contain_text("Неверный пароль OBS WebSocket")
        await page.fill("#obsPassword", "pw")
        await page.click("#testObs")
        await expect(page.locator("#obsTestResult")).to_contain_text("OBS подключён")
        await expect(page.locator("#obsTestResult")).to_have_class("obs-test good")
        before_save = page.url
        await page.click("#saveObs")
        assert page.url == before_save, "Inline setup form navigated the page"
        await expect(page.locator("#obsTestResult")).to_contain_text("Настройки сохранены")
        await page.click("#closeObs")
        await expect(page.locator("#obsForm")).to_be_hidden()
        await page.click("#obsSetupBtn")
        await expect(page.locator("#obsForm")).to_be_visible()
        await expect(page.locator("#obsUrl")).to_be_focused()
        await page.locator("#obsDialog").screenshot(path=str(output / "obs-connection-direct.jpg"), type="jpeg", quality=85)
        await page.set_viewport_size({"width":375,"height":850})
        assert not await page.evaluate("document.documentElement.scrollWidth > innerWidth")
        await page.locator("#obsDialog").screenshot(path=str(output / "obs-connection-mobile.png"))
        await page.set_viewport_size({"width":1440,"height":1000})
        await page.reload()
        await expect(page.locator("#obsUrl")).to_have_value(OBS_URL)
        await expect(page.locator("#obsPassword")).to_have_value("pw")
        await expect(page.locator("#obsState")).to_have_text("OBS на этом компьютере")
        await expect(page.locator("#obsForm")).to_be_hidden()
        passed("OBS setup beside veto: instructions, password check, save, reload, focus and 375px layout")

        # Send to OBS on this computer.
        await page.check("#includeCards")
        await page.click("#sendObsBtn")
        await expect(page.locator("#toast")).to_contain_text("OBS обновлён: 10 камер, 10 карточек")
        assert len(obs.names("CAM ")) == 10 and len(obs.names("CARD ")) == 10
        scene = [it["sourceName"] for it in obs.scenes["Игрок 6"]]
        assert scene[0].startswith("CARD 06 | HYPERSPIRIT | ") and scene[1].startswith("CAM 06 | HYPERSPIRIT | "), scene
        camera = obs.inputs[scene[1]]
        assert camera["url"].endswith("&cleanoutput&transparent") and camera["width"] == 1920
        assert obs.inputs[scene[0]]["url"].startswith(base + "/card.html?team=HYPERSPIRIT")
        await page.click("#obsSetupBtn")
        await page.fill("#obsPassword", "wrong")
        await page.click("#saveObs")
        await page.click("#sendObsBtn")
        await expect(page.locator("#errorBox")).to_contain_text("Неверный пароль OBS WebSocket")
        await expect(page.locator("#errorBox")).to_contain_text("скачать или скопировать")
        passed("send to OBS directly: cameras renamed, cards under cameras, wrong password explained")

        # Copy JSON when the clipboard is blocked: the manual dialog has it.
        await page.evaluate("Object.defineProperty(navigator, 'clipboard', {value: "
                            "{writeText: async () => {throw Error('denied')}}}); document.execCommand = () => false;")
        await page.click("#copyJsonBtn")
        await expect(page.locator("#copyDialog")).to_be_visible()
        collection = json.loads(await page.input_value("#manualCopy"))
        names = [s["name"] for s in collection["sources"]]
        assert sum(n.startswith("CAM ") for n in names) == 10 and sum(n.startswith("CARD ") for n in names) == 10
        await page.click("#closeCopy")
        passed("copy JSON falls back to the manual copy dialog")

        # OBS on another computer: the dock relays through VDO.Ninja.
        await page.click("#obsSetupBtn")
        await page.check('input[name=obsMode][value=bridge]')
        await expect(page.locator("#obsDirectFields")).to_be_hidden()
        await expect(page.locator("#obsBridgeFields")).to_be_visible()
        await page.click("#saveObs")
        bridge_code = await page.locator("#obsCode").inner_text()
        await expect(page.locator("#obsState")).to_have_text("Док OBS не на связи")
        await expect(page.locator("#obsConnectionState")).to_have_text("Док OBS не на связи")
        await page.locator("#obsDialog").screenshot(path=str(output / "obs-connection-remote.png"))
        await page.click("#copyDockUrl")
        await expect(page.locator("#copyDialog")).to_be_visible()
        await expect(page.locator("#manualCopy")).to_have_value(f"{base}/obs-bridge.html#k={bridge_code}")
        await page.click("#closeCopy")
        dock = await context.new_page()
        dock.on("pageerror", lambda error: errors.append(str(error)))
        dock_obs = MockObs()
        await dock.route_web_socket(OBS_URL, dock_obs.handler)
        await dock.set_viewport_size({"width": 320, "height": 700})
        await dock.goto(f"{base}/obs-bridge.html#k={bridge_code}")
        await expect(dock.locator("#dockCode")).to_have_value(bridge_code)
        await dock.fill("#dockPassword", "pw")
        await dock.click("#dockForm button[type=submit]")
        await expect(dock.locator("#dockObs")).to_contain_text("OBS: подключён")
        await page.check("#includeCards")
        await page.click("#sendObsBtn")
        await expect(page.locator("#toast")).to_contain_text("OBS обновлён: 10 камер, 10 карточек", timeout=15000)
        await expect(dock.locator("#dockLog")).to_contain_text("Матч отправлен: 6yuBoJlbl vs HYPERSPIRIT")
        await expect(page.locator("#obsState")).to_have_text("Док OBS на связи")
        assert len(dock_obs.names("CAM ")) == 10 and len(dock_obs.names("CARD ")) == 10
        await dock.screenshot(path=str(output / "obs-dock.png"))
        passed("send to OBS through the dock: sealed message, applied, acknowledged")

        # Veto has its own display-only encrypted stream. A green OBS dock
        # must not claim that a missing browser source has received a move.
        await dock.close()
        await page.check("#vetoLive")
        await expect(page.locator("#vetoLiveStatus")).to_contain_text("Ждём оверлей")
        await page.evaluate("window.__copied = []; navigator.clipboard.writeText = async t => { window.__copied.push(t); };")
        await page.uncheck("#vetoLive")
        await page.click("#copyOverlay")
        assert await page.locator("#vetoLive").is_checked(), "OBS link did not enable live updates"
        source_url = await page.evaluate("window.__copied.at(-1)")
        assert source_url.startswith(base + "/assets/veto-overlay/overlay.html?layout=full#s="), source_url
        assert "&r=" in source_url
        display_code = source_url.split("&r=", 1)[1]
        assert display_code != bridge_code, "Overlay URL leaked the OBS control code"
        overlay = await context.new_page()
        overlay.on("pageerror", lambda error: errors.append(str(error)))
        await overlay.set_viewport_size({"width":1920,"height":1080})
        await overlay.goto(source_url)
        await overlay.wait_for_selector("body[data-ready='true']")
        await expect(page.locator("#vetoLiveStatus")).to_contain_text("Оверлей получает вето", timeout=15000)
        await page.click('[data-map="Ancient"]')
        await overlay.wait_for_function("() => window.vetoOverlay.getState()?.actions.length === 1")
        await overlay.wait_for_selector('#scene[data-animating*="Ancient"]')
        await overlay.wait_for_selector('#scene[data-animating=""]')
        # Initial URL has zero turns. Only live replay can restore the ban.
        await overlay.reload()
        await overlay.wait_for_selector("body[data-ready='true']")
        await overlay.wait_for_function("() => window.vetoOverlay.getState()?.actions.length === 1", timeout=15000)
        assert (await overlay.evaluate("window.vetoOverlay.getState()"))["actions"][0]["map"] == "Ancient"
        await page.fill("#matchStage", "Группа B")
        await page.click("#copyOverlay")
        overlay_link = await page.evaluate("window.__copied.at(-1)")
        await page.select_option("#vetoLayout", "strip")
        await page.click("#copyOverlay")
        assert "?layout=strip#s=" in await page.evaluate("window.__copied.at(-1)")
        await overlay.close()
        await page.uncheck("#vetoLive")
        passed("live veto: real receiver acknowledgement, animated move and replay after reload; independent of the OBS control dock")

        # Codex's animated overlay takes the panel's veto from the link and
        # from the live obs-browser event.
        overlay = await context.new_page()
        overlay.on("pageerror", lambda error: errors.append(str(error)))
        await overlay.set_viewport_size({"width": 1920, "height": 1080})
        await overlay.goto(overlay_link)
        await overlay.wait_for_selector("body[data-ready='true']")
        state = await overlay.evaluate("window.vetoOverlay.getState()")
        assert state["teams"] == ["6yuBoJlbl", "HYPERSPIRIT"] and state["stage"] == "Группа B", state
        assert [a["map"] for a in state["actions"]] == ["Ancient"], state
        full = {"version": 1, "teams": ["Rune Eaters", "PCIFIC"], "format": "BO3", "first": 0,
                "pending": None, "stage": "Группа A", "actions": [
                    {"map": "Ancient", "type": "ban", "team": 0}, {"map": "Anubis", "type": "ban", "team": 1},
                    {"map": "Mirage", "type": "pick", "team": 0, "side": "CT"},
                    {"map": "Nuke", "type": "pick", "team": 1, "side": "T"},
                    {"map": "Cache", "type": "ban", "team": 0}, {"map": "Dust2", "type": "ban", "team": 1}]}
        await overlay.evaluate("state => dispatchEvent(new CustomEvent('oneshot-veto', { detail: state }))", full)
        await expect(overlay.locator("#scene")).to_have_attribute(
            "aria-label", re.compile("Rune Eaters против PCIFIC. BO3. Вето завершено. Mirage, Nuke, Inferno"))
        await overlay.wait_for_timeout(1200)
        await overlay.screenshot(path=str(output / "veto-overlay.png"))
        # A broken update is ignored: the finished veto stays on air.
        await overlay.evaluate("dispatchEvent(new CustomEvent('oneshot-veto', { detail: { teams: ['A', 'A'] } }))")
        await overlay.wait_for_timeout(200)
        assert len((await overlay.evaluate("window.vetoOverlay.getState()"))["actions"]) == 6
        await overlay.close()
        passed("animated veto overlay: state from the link, live event, bad update ignored")

        # FACEIT lobby: alerts on map and match end, messages, tech pause.
        phase = {"value": 0}
        finished_at = int(time.time()) - 60

        async def faceit(route):
            url = route.request.url
            p = phase["value"]
            if "/matches/1-live" in url:
                body = faceit_match("1-live", "FINISHED", (2, 0), ["faction1", "faction1"], finished=finished_at)
            elif "type=ongoing" in url:
                body = {"items": [] if p >= 2 else [faceit_match("1-live", "ONGOING", (p, 0), ["faction1"] * p)]}
            elif "type=upcoming" in url:
                body = {"items": [faceit_match("1-next", "SCHEDULED", (0, 0), [], ("LPH", "Omega"))]}
            else:
                body = {"items": []}
            assert route.request.headers.get("authorization") == "Bearer qa-key"
            await route.fulfill(content_type="application/json", body=json.dumps(body))

        lobby = await context.new_page()
        lobby.on("pageerror", lambda error: errors.append(str(error)))
        await lobby.clock.install()
        await lobby.add_init_script("""
            window.__notes = [];
            window.Notification = class {
              constructor(title, options) { window.__notes.push({ title, ...options }); }
              close() {}
              static get permission() { return 'granted'; }
              static requestPermission() { return Promise.resolve('granted'); }
            };""")
        await lobby.route("https://open.faceit.com/**", faceit)
        await lobby.goto(base + "/#lobby")
        await expect(lobby.locator("#lobbyView")).to_be_visible()
        await expect(lobby.locator("#notifyBtn")).to_have_text("Уведомления включены")
        await lobby.fill("#faceitUrl", f"https://www.faceit.com/ru/championship/{CHAMP}/CyberClash")
        await lobby.fill("#faceitKey", "qa-key")
        await lobby.click("#lobbyStart")
        await expect(lobby.locator(".lobby-match.live")).to_contain_text("Rune Eaters")
        await expect(lobby.locator("#lobbyStatus")).to_contain_text("идут: 1 · впереди: 1")
        assert await lobby.locator("#lobbyAlert").is_hidden()
        # Tech pause is logged by hand with a running timer.
        await lobby.click('[data-pause="1-live"][data-side="1"]')
        await expect(lobby.locator(".pause-on")).to_contain_text("Тех. пауза · PCIFIC")
        await lobby.clock.run_for(3000)
        await expect(lobby.locator(".pause-on time")).to_have_text("0:03")
        await lobby.click('[data-resume="1-live"]')
        await expect(lobby.locator("#lobbyLog")).to_contain_text("Пауза PCIFIC закончилась через 0:03")
        # Map 1 ends.
        phase["value"] = 1
        await lobby.clock.run_for(21000)
        await expect(lobby.locator("#lobbyAlert")).to_contain_text(
            "Карта 1 (Mirage) закончилась — карту взяли Rune Eaters. Счёт: Rune Eaters 1:0 PCIFIC")
        notes = await lobby.evaluate("window.__notes")
        assert len(notes) == 1 and notes[0]["requireInteraction"], notes
        await lobby.click("#lobbyAck")
        await expect(lobby.locator("#lobbyAlert")).to_be_hidden()
        # The match ends while the admin is on «Подготовка»: badge and alert.
        await lobby.click("#viewPrep")
        phase["value"] = 2
        await lobby.clock.run_for(21000)
        await expect(lobby.locator("#lobbyBadge")).to_have_text("1")
        await expect(lobby.locator("#lobbyAlert")).to_contain_text("Матч закончился: Rune Eaters 2:0 PCIFIC")
        await lobby.click("#viewLobby")
        await expect(lobby.locator("#lobbyBadge")).to_be_hidden()
        await expect(lobby.locator("#msgThanks")).to_have_value("GG WP, Rune Eaters and PCIFIC! Thanks for the game.")
        minute = time.localtime(finished_at + 600).tm_min
        await expect(lobby.locator("#msgNext")).to_have_value(
            f"Next xx:{minute:02d}\n\n@LPH @Omega\n\nWait for command")
        await lobby.fill("#nextDelay", "15")
        await expect(lobby.locator("#msgNext")).to_have_value(
            re.compile(f"^Next xx:{time.localtime(finished_at + 900).tm_min:02d}\n"))
        await expect(lobby.locator("#lobbyLog")).to_contain_text("Матч закончился: Rune Eaters 2:0 PCIFIC")
        await lobby.screenshot(path=str(output / "lobby.png"), full_page=True)
        await lobby.set_viewport_size({"width": 375, "height": 800})
        assert not await lobby.evaluate("document.documentElement.scrollWidth > innerWidth")
        passed("lobby: map and match alerts, notification, badge, pause log, Discord texts")

        assert not errors, errors
        await browser.close()
    print(f"{len(checks)} live scenarios passed", flush=True)
    print("OBS_SETUP_PREVIEW_BEGIN", flush=True)
    print(base64.b64encode((output / "obs-connection-direct.jpg").read_bytes()).decode(), flush=True)
    print("OBS_SETUP_PREVIEW_END", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--chromium", default="/usr/bin/chromium")
    parser.add_argument("--artifacts", default="artifacts")
    asyncio.run(run(parser.parse_args()))
