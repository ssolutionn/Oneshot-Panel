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
const live = Object.fromEntries(view.filter(id => !/[-_]4$/.test(id)).map(id => [id, id]));
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
        self.block_next = False
        self.blocked, self.release = asyncio.Event(), asyncio.Event()
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
                if self.block_next and d["requestType"] == "SetInputSettings":
                    self.block_next = False
                    self.blocked.set()
                    async def later():
                        await self.release.wait()
                        ws.send(json.dumps({"op":7, "d":reply}))
                    asyncio.create_task(later())
                    return
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
        # This suite protects the legacy/fallback links; short links have real
        # HTTP coverage in qa_veto_site.py --pretty-links.
        await context.route("**/api/veto-link*", lambda route: route.fulfill(
            status=503, content_type="application/json", body='{"error":"qa-unavailable"}'))
        # The site's bookmakers function (bookies.js), answered from here.
        bookie_lines = {
            "fonbet": [{"id": "1", "team1": "6yuBoJlbl", "team2": "HyperSpirit", "odds": [1.8, 2.0],
                        "tournament": "Counter-Strike. CyberClash. Отборочные игры. Bo3",
                        "start": 1792155600000, "live": False, "url": "https://fon.bet/sports/esports/1/1"},
                       {"id": "2", "team1": "Rune Eaters Esports", "team2": "PCIFIC", "odds": [1.5, 2.4],
                        "start": 1792166400000, "live": True, "url": "https://fon.bet/live/esports/1/2",
                        "tournament": "Counter-Strike. CyberClash. Отборочные игры. Bo3",
                        "size": {"count": 76, "unit": "исходов"},
                        "markets": [{"kind": "handicap", "name": "Фора", "line": "-5.5", "odds": [1.9, 1.8]}]}],
            "pari": [], "olimp": [],
            "marathon": [{"id": "9", "team1": "PCIFIC", "team2": "Rune Eaters", "odds": [2.5, 1.48],
                          "tournament": "CS 2. CyberClash. Закрытая квалификация",
                          "start": 1792166400000, "live": False, "url": "https://www.marathonbet.ru/su/betting/x",
                          "liveOffered": True,
                          "markets": [{"kind": "handicap", "name": "Фора", "line": "-1.5", "odds": [3.1, 1.3]},
                                      {"kind": "total", "name": "Тотал", "line": "2.5", "odds": [2.0, 1.75]}]}],
        }

        async def bookmakers(route):
            query = parse_qs(urlsplit(route.request.url).query)
            if "history" in query:
                await route.fulfill(content_type="application/json",body=json.dumps({
                    "ok":True,"archive":{"version":1,"day":query["history"][0],
                        "startedAt":0,"updatedAt":0,"books":{}}}))
                return
            bid = query["id"][0]
            await route.fulfill(content_type="application/json", body=json.dumps({
                "id": bid, "name": bid, "page": "https://example.invalid/", "ok": bid != "pari",
                "errors": ["линия: HTTP 503"] if bid == "pari" else [], "checkedAt": 0, "ms": 5,
                "events": bookie_lines.get(bid, [])}))
        await context.route("**/api/bookmakers?**", bookmakers)
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
        await expect(page.locator("#vetoView")).to_be_visible()
        await expect(page.locator("#vetoNavBtn")).to_be_focused()
        # The panel's veto moved here, under the captains' room; the links block follows.
        await expect(page.locator("#vetoView > #cvLive + #veto + #captainVeto")).to_be_visible()
        await expect(page.locator("#cvLiveEmpty")).to_be_visible()
        await page.keyboard.press("ArrowLeft")
        await expect(page.locator("#prepView")).to_be_visible()
        await expect(page.locator("#viewPrep")).to_be_focused()
        await page.click("#viewLobby")
        await expect(page.locator("#obsNavBtn")).to_be_visible()
        await page.click("#obsNavBtn")
        await expect(page.locator("#obsView")).to_be_visible()
        await expect(page.locator("#prepView")).to_be_hidden()
        await expect(page.locator("#obsNavBtn")).to_have_attribute("aria-selected", "true")
        await expect(page.locator("#obsForm")).to_be_visible()
        # A step-by-step guide sits under the form: every OBS menu on the way.
        guide = page.locator("#obsView .obs-manual")
        for words in ["«Коллекция сцен» → «Импорт»", "«Сервис» → «Настройки сервера WebSocket»",
                      "«Пользовательские док-панели браузера»", "«▶ Отправить в OBS»", "«+» → «Браузер»"]:
            await expect(guide).to_contain_text(words)
        await page.locator("#obsView .obs-manual-step > summary", has_text="Каждый матч: отправь камеры").click()
        await expect(guide).to_contain_text("Поменял игрока, ID или порядок")
        # Tabs: Подготовка · Вето · Лобби · OBS · Букмекеры.
        tabs = await page.locator(".view-tabs [role=tab]").evaluate_all("els => els.map(el => el.id)")
        assert tabs == ["viewPrep", "vetoNavBtn", "viewLobby", "obsNavBtn", "bookiesNavBtn"], tabs
        await page.focus("#obsNavBtn")
        await page.keyboard.press("ArrowLeft")
        await expect(page.locator("#lobbyView")).to_be_visible()
        assert await page.locator("#lobbyView #bookies").count() == 0, "bookmakers have a tab of their own"
        await page.keyboard.press("End")
        await expect(page.locator("#bookiesView #bookies")).to_be_visible()
        await page.keyboard.press("ArrowLeft")
        await expect(page.locator("#obsView")).to_be_visible()
        passed("tabs, keyboard switching, OBS tab with a step-by-step guide, webcam status 8/10")

        # Set up through the form in the OBS tab, without seeding storage.
        await expect(page.locator("#obsView #obsForm")).to_be_visible()
        await expect(page.locator("#obsBridgeFields")).to_contain_text("Отправь обсерверу сообщение")
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
        await expect(page.locator("#prepView")).to_be_visible()
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
        await expect(page.locator("#obsView")).to_be_visible()
        await page.click("#closeObs")
        await expect(page.locator("#obsForm")).to_be_hidden()
        passed("OBS tab: instructions, password check, save, reload, focus and 375px layout")

        # Send to OBS on this computer.
        await page.check("#includeCards")
        await page.click("#sendObsBtn")
        await expect(page.locator("#toast")).to_contain_text("OBS обновлён: 10 камер, 10 карточек")
        assert len(obs.names("CAM ")) == 10 and len(obs.names("CARD ")) == 10
        scene = [it["sourceName"] for it in obs.scenes["Игрок 6"]]
        assert scene[0].startswith("CARD 06 | HYPERSPIRIT | ") and scene[1].startswith("CAM 06 | HYPERSPIRIT | "), scene
        camera = obs.inputs[scene[1]]
        assert camera["url"].endswith("&cleanoutput&transparent&cover") and camera["width"] == 1320
        assert obs.inputs[scene[0]]["url"].startswith(base + "/card.html?team=HYPERSPIRIT")
        obs.block_next = True
        await page.click("#sendObsBtn")
        await asyncio.wait_for(obs.blocked.wait(), timeout=10)
        await page.uncheck("#includeCards")
        await expect(page.locator("#sendObsBtn")).to_be_disabled()
        obs.release.set()
        await expect(page.locator("#sendObsBtn")).to_be_enabled()
        await page.check("#includeCards")
        passed("changing match options cannot start a second OBS update during an in-flight send")
        await page.click("#obsSetupBtn")
        await page.fill("#obsPassword", "wrong")
        await page.click("#saveObs")
        await page.click("#closeObs")
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
        bridge_code = await page.locator("#obsCode").text_content()
        await expect(page.locator("#obsState")).to_have_text("Док OBS не на связи")
        await expect(page.locator("#obsConnectionState")).to_have_text("Док OBS не на связи")
        await page.locator("#obsDialog").screenshot(path=str(output / "obs-connection-remote.png"))
        await page.click("#copyDockUrl")
        await expect(page.locator("#copyDialog")).to_be_visible()
        await expect(page.locator("#manualCopy")).to_have_value(re.compile(re.escape(f"Адрес: {base}/obs-bridge.html#k={bridge_code} → Применить")))
        await page.click("#closeCopy")
        await expect(page.locator("#obsBridgeStatus")).to_contain_text("Ждём обсервера", timeout=25000)
        # The dock was added from another device: it has its own code, which
        # is typed into this panel.
        dock = await context.new_page()
        dock.on("pageerror", lambda error: errors.append(str(error)))
        dock_obs = MockObs()
        await dock.route_web_socket(OBS_URL, dock_obs.handler)
        await dock.set_viewport_size({"width": 320, "height": 700})
        await dock.goto(f"{base}/obs-bridge.html")
        bridge_code = await dock.input_value("#dockCode")
        assert re.fullmatch(r"[A-Z2-9]{4}(-[A-Z2-9]{4}){3}", bridge_code)
        await expect(dock.locator("#dockObs")).to_contain_text("OBS просит пароль")
        await page.locator("#obsMore > summary").click()
        await page.fill("#obsCodeInput", bridge_code.lower().replace("-", " "))
        await page.click("#applyObsCode")
        await expect(page.locator("#obsCode")).to_have_text(bridge_code)
        await expect(page.locator("#obsBridgeStatus")).to_contain_text("Окно Oneshot у обсервера открыто ✓, но OBS к нему не подключён", timeout=20000)
        await expect(page.locator("#obsBridgeStatus")).to_contain_text("OBS просит пароль")
        # Port and password come from the panel (a phone): a wrong password
        # changes nothing in the dock; the OBS QR fills the fields.
        await expect(page.locator("#obsRemoteBox")).to_have_attribute("open", "")
        await page.fill("#obsRemotePort", "4455")
        await page.fill("#obsRemotePassword", "wrong")
        await page.click("#sendObsConfig")
        await expect(page.locator("#obsRemoteResult")).to_have_text("Неверный пароль OBS WebSocket.", timeout=15000)
        assert await dock.evaluate("JSON.parse(localStorage.getItem('oneshot-obs-bridge')).password || ''") == ""
        await page.fill("#obsRemotePort", "")
        await page.fill("#obsRemotePassword", "")
        await page.locator("#obsPairQr > details > summary").click()
        await page.locator("#obsPairQr .obs-qr-manual > summary").click()
        await page.fill("#obsPairQr .obs-qr-manual input", "obsws://192.168.1.9:4455/pw")
        await page.locator("#obsPairQr .obs-qr-manual button").click()
        await expect(page.locator("#obsPairQr [role=status]")).to_contain_text("Порт и пароль OBS подставлены")
        await expect(page.locator("#obsRemotePort")).to_have_value("4455")
        await expect(page.locator("#obsRemotePassword")).to_have_value("pw")
        await page.click("#sendObsConfig")
        await expect(page.locator("#obsRemoteResult")).to_contain_text("OBS: подключён", timeout=15000)
        await expect(page.locator("#obsRemotePassword")).to_have_value("")
        await expect(dock.locator("#dockObs")).to_contain_text("OBS: подключён")
        await expect(dock.locator("#dockPassword")).to_have_value("pw")
        await expect(dock.locator("#dockUrl")).to_have_value("ws://127.0.0.1:4455")
        await expect(dock.locator("#dockLog")).to_contain_text("Подключение к OBS настроено из панели")
        await expect(page.locator("#obsBridgeStatus")).to_contain_text("Всё подключено ✓")
        await page.locator("#obsDialog").screenshot(path=str(output / "obs-connection-phone-config.png"))
        await page.click("#closeObs")
        await page.check("#includeCards")
        await page.click("#sendObsBtn")
        await expect(page.locator("#toast")).to_contain_text("OBS обновлён: 10 камер, 10 карточек", timeout=15000)
        await expect(dock.locator("#dockLog")).to_contain_text("Матч отправлен: 6yuBoJlbl vs HYPERSPIRIT")
        await expect(page.locator("#obsState")).to_have_text("Док OBS на связи")
        assert len(dock_obs.names("CAM ")) == 10 and len(dock_obs.names("CARD ")) == 10
        await dock.screenshot(path=str(output / "obs-dock.png"))
        passed("send to OBS through the dock: code typed from the dock, status per step, OBS port and password from the panel (QR), sealed match")

        # Veto has its own display-only encrypted stream. A green OBS dock
        # must not claim that a missing browser source has received a move.
        await dock.close()
        await page.click("#vetoNavBtn")
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
        await page.click("#viewPrep")
        await page.fill("#matchStage", "Группа B")
        await page.click("#vetoNavBtn")
        await page.click("#copyOverlay")
        overlay_link = await page.evaluate("window.__copied.at(-1)")
        await page.select_option("#vetoLayout", "strip")
        await page.click("#copyOverlay")
        assert "?layout=strip&crop=1#s=" in await page.evaluate("window.__copied.at(-1)")
        await overlay.close()
        await page.uncheck("#vetoLive")
        player_veto = await page.get_attribute("#playerVeto", "href")
        assert player_veto.startswith("https://oneshot-veto.pages.dev/#new&a=6yuBoJlbl&b=HYPERSPIRIT&f=BO"), player_veto
        # Captains' veto block: links for the selected match, the admin's apart.
        await page.select_option("#cvTimer", "3")
        await page.select_option("#cvLang", "ru")
        await page.click("#cvCreate")
        await expect(page.locator("#cvLinks")).to_be_visible()
        # The panel watches the new room at once (as the admin's link does).
        await expect(page.locator("#cvRoom")).to_be_visible()
        await expect(page.locator("#cvLiveState")).to_have_text("капитанов нет")
        msg_a = await page.input_value("#cvMsgA")
        assert "Капитан **6yuBoJlbl**" in msg_a and "На всё вето 3 минуты." in msg_a, msg_a
        admin_link = await page.input_value("#cvMsgO")
        # The links lead to the veto's own site, never to the panel's address.
        assert admin_link.startswith("https://oneshot-veto.pages.dev/#v=") and admin_link not in msg_a, admin_link
        assert base not in msg_a and base not in await page.input_value("#cvMsgS")
        assert await page.get_attribute("#cvOpen", "href") == admin_link
        await expect(page.locator("#cvAdminOpen")).to_have_attribute("href", admin_link)
        assert "&m=3" in await page.get_attribute("#playerVeto", "href")
        await page.select_option("#cvLang", "en")
        await expect(page.locator("#cvMsgA")).to_have_value(re.compile(r"^\*\*CyberClash · map veto[\s\S]*Captain of \*\*6yuBoJlbl\*\*"))
        await page.reload()
        await expect(page.locator("#cvMsgO")).to_have_value(admin_link)
        # Links kept from before the move to Pages show up on the new address.
        await page.evaluate("""() => { const s = JSON.parse(localStorage.getItem('oneshot-captain-veto'));
            for (const k in s.last.links) s.last.links[k] = s.last.links[k].replace('https://oneshot-veto.pages.dev/', 'https://oneshot-veto.cyberclash.workers.dev/');
            localStorage.setItem('oneshot-captain-veto', JSON.stringify(s)); }""")
        await page.reload()
        await expect(page.locator("#cvMsgO")).to_have_value(admin_link)
        await expect(page.locator("#cvMsgA")).to_have_value(re.compile(r"https://oneshot-veto\.pages\.dev/#v="))
        await expect(page.locator("#cvAdminOpen")).to_have_attribute("href", admin_link)
        await expect(page.locator("#cvLang")).to_have_value("en")
        await page.fill("#cvSite", "https://veto.example.org/x?y=1#z")
        await page.locator("#cvSite").dispatch_event("change")
        await page.click("#cvCreate")
        await expect(page.locator("#cvMsgO")).to_have_value(re.compile(r"^https://veto\.example\.org/x#v="))
        assert (await page.get_attribute("#playerVeto", "href")).startswith("https://veto.example.org/x#new&")
        await page.fill("#cvSite", "")
        await page.locator("#cvSite").dispatch_event("change")
        passed("live veto: real receiver acknowledgement, animated move and replay after reload; captains' veto links in the panel")

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
            "data-phase", "finished", timeout=4000)
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
            };
            Object.defineProperty(navigator,'serviceWorker',{value:{
              addEventListener(){},
              register:async()=>({active:{state:'activated'},showNotification:async(title,options)=>window.__notes.push({title,...options})})
            }});""")
        await lobby.route("https://open.faceit.com/**", faceit)
        await lobby.goto(base + "/#lobby")
        await expect(lobby.locator("#lobbyView")).to_be_visible()
        await expect(lobby.locator("#notifyBtn")).to_have_text("Проверить уведомления")
        await lobby.click('#notifyBtn')
        await expect(lobby.locator('#notifyStatus')).to_contain_text('Тестовое уведомление отправлено')
        assert (await lobby.evaluate('window.__notes'))[0]['tag']=='oneshot-notification-test'
        await lobby.evaluate('window.__notes=[]')
        assert await lobby.locator('#faceitKey').get_attribute('type')=='text'
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
        await expect(lobby.locator(".pause-on time")).to_have_text(re.compile(r"^0:0[34]$"))
        await lobby.click('[data-resume="1-live"]')
        # The installed clock still runs with real time: a slow machine adds a second.
        await expect(lobby.locator("#lobbyLog")).to_contain_text(re.compile(r"Пауза PCIFIC закончилась через 0:0[34]"))
        # Map 1 ends.
        phase["value"] = 1
        await lobby.clock.run_for(21000)
        await expect(lobby.locator("#lobbyAlert")).to_contain_text(
            "Карта 1 (Mirage) закончилась — карту взяли Rune Eaters. Счёт по картам: Rune Eaters 1:0 PCIFIC")
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
        # Bookmakers (a tab of their own): our matches against each bookmaker,
        # a new line goes to the lobby journal. Bookmakers are rows (all 16,
        # the listed ones first), matches columns.
        await lobby.click("#bookiesNavBtn")
        table = lobby.locator("#bookiesTable")
        await expect(table.locator("tbody tr")).to_have_count(16)
        await expect(table.locator("thead th")).to_have_count(3)
        heads = await table.locator("thead th b").all_inner_texts()
        rune_col = next(i for i, h in enumerate(heads) if "Rune Eaters" in h)
        fonbet = table.locator("tbody tr", has=lobby.locator("th span", has_text="Фонбет"))
        marathon = table.locator("tbody tr", has=lobby.locator("th span", has_text="Марафон"))
        await expect(fonbet.locator("td").nth(rune_col)).to_contain_text("1.50 · 2.40")
        await expect(fonbet.locator("td").nth(rune_col)).to_contain_text("LIVE")
        await expect(fonbet.locator(".bk-odds").first).not_to_be_empty()
        assert await fonbet.locator("td a .bk-odds, th a span").count() == 0, "text stays outside bookmaker links"
        await expect(marathon.locator("td").nth(rune_col)).to_contain_text("1.48 · 2.50")
        # Other markets in our team order (the handicap turns with the teams), line size, live.
        await expect(fonbet.locator("td").nth(rune_col)).to_contain_text("Ф1 -5.5 1.90 · Ф2 +5.5 1.80")
        await expect(fonbet.locator("td").nth(rune_col)).to_contain_text("76 исходов")
        await expect(fonbet.locator("th small")).to_contain_text("до 76 исходов · сейчас в лайве")
        # Each bookmaker's own spelling of the tournament, as is.
        await expect(fonbet.locator("th .bk-tournament")).to_have_text("«Counter-Strike. CyberClash. Отборочные игры. Bo3»")
        await expect(marathon.locator("th .bk-tournament")).to_have_text("«CS 2. CyberClash. Закрытая квалификация»")
        await expect(marathon.locator("td").nth(rune_col)).to_contain_text("Ф1 +1.5 1.30 · Ф2 -1.5 3.10")
        await expect(marathon.locator("td").nth(rune_col)).to_contain_text("ТБ 2.5 2.00 · ТМ 1.75")
        await expect(marathon.locator("td").nth(rune_col)).to_contain_text("лайв заявлен")
        olimp = table.locator("tbody tr", has=lobby.locator("th span", has_text="OLIMPBET"))
        await expect(olimp.locator("td").nth(rune_col)).to_have_text("—")
        # Read fine but nothing of ours on sale: «на связи», not broken (PARI is the broken one).
        bettery = table.locator("tbody tr", has=lobby.locator("th span", has_text="Bettery"))
        await expect(bettery.locator("th small")).to_contain_text("на связи · CyberClash в линии нет")
        await expect(bettery.locator("td").nth(rune_col)).to_have_attribute("title", "Контора на связи, этого матча в её линии нет")
        auto = await lobby.evaluate("import('/bookmakers.js').then(m => m.BOOKMAKERS.length)")
        await expect(lobby.locator("#bookiesStatus")).to_contain_text(f"на связи {auto - 1} из {auto}")
        first_rows = await table.locator("tbody tr th span").all_inner_texts()
        assert first_rows[:2] == ["Фонбет", "Марафон"], first_rows
        manual = await lobby.evaluate("import('/bookmakers.js').then(m => m.MANUAL.length)")
        await expect(table.locator("tbody tr.manual")).to_have_count(manual)
        await expect(lobby.locator("#bookiesStatus")).to_contain_text("Турнир в линии: Фонбет, Марафон")
        bookie_lines["olimp"] = [{"id": "5", "team1": "Honved Esport", "team2": "Lavked", "odds": [2.2, 1.62],
                                  "start": 1792177200000, "live": False, "url": "https://www.olimp.bet/line/x"}]
        bookie_lines["marathon"][0] = {**bookie_lines["marathon"][0], "odds": [2.7, 1.42], "live": True}
        await lobby.click("#bookiesCheck")
        await expect(table.locator("thead th")).to_have_count(4)
        await expect(lobby.locator("#lobbyLog")).to_contain_text("OLIMPBET: открыта линия Honved Esport – Lavked")
        await expect(marathon.locator("td").nth(rune_col)).to_contain_text("1.42 · 2.70")
        await expect(marathon.locator("td").nth(rune_col)).to_contain_text("откр. 1.48 · 2.50")
        await expect(lobby.locator("#bookiesStatus")).to_contain_text("Сейчас в лайве: Фонбет, Марафон")
        # The live ends: the bookmaker «был в лайве», kept after a reload too.
        bookie_lines["marathon"][0] = {**bookie_lines["marathon"][0], "live": False}
        await lobby.click("#bookiesCheck")
        await expect(marathon.locator("td").nth(rune_col)).to_contain_text("был в лайве")
        # Summary for the chat and the week's CSV.
        await lobby.evaluate("window.__copied = []; navigator.clipboard.writeText = async t => { window.__copied.push(t); };")
        await lobby.click("#bookiesCopy")
        summary = await lobby.evaluate("window.__copied.at(-1)")
        assert summary.startswith("CyberClash у букмекеров"), summary
        assert "В линии у 3 из" in summary, summary
        assert "• Марафон: 1.42 · 2.70 (откр. 1.48 · 2.50) · был в лайве · Ф1 +1.5 1.30 · Ф2 -1.5 3.10 · ТБ 2.5 2.00 · ТМ 1.75" in summary, summary
        assert "• Фонбет: 1.50 · 2.40 · 76 исходов · LIVE · Ф1 -5.5 1.90 · Ф2 +5.5 1.80" in summary, summary
        assert "Не удалось проверить: PARI" in summary, summary
        assert "Как называют турнир:" in summary and "• Марафон: «CS 2. CyberClash. Закрытая квалификация»" in summary, summary
        assert "Нет линии: Bettery, 24bet, OLIMPBET" in summary, summary
        async with lobby.expect_download() as info:
            await lobby.click("#bookiesCsv")
        download = await info.value
        assert re.fullmatch(r"cyberclash-bookmakers-\d{4}-\d{2}-\d{2}\.csv", download.suggested_filename), download.suggested_filename
        rows = (await download.path()).read_text(encoding="utf-8-sig").splitlines()
        assert rows[0].startswith("Контора;Турнир у конторы;Команда 1;Команда 2;Начало (МСК)"), rows[0]
        assert len(rows) == 5, rows
        marathon_row = next(r for r in rows if r.startswith("Марафон;"))
        assert marathon_row.startswith("Марафон;CS 2. CyberClash. Закрытая квалификация;"), marathon_row
        assert ";2,50;1,48;2,70;1,42;" in marathon_row and ";был;" in marathon_row, marathon_row
        await lobby.screenshot(path=str(output / "lobby.png"), full_page=True)
        await lobby.set_viewport_size({"width": 375, "height": 800})
        assert not await lobby.evaluate("document.documentElement.scrollWidth > innerWidth")
        passed("lobby: map and match alerts, notification, badge, pause log, Discord texts, bookmakers' lines")

        race = await context.new_page()
        race.on("pageerror", lambda error: errors.append(str(error)))
        await race.clock.install()
        old_id = "1-11111111-2222-4333-8444-555555555555"
        new_id = "1-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        race_phase = {"value":0}
        waiting, release, delivered = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def late_faceit(route):
            url = urlsplit(route.request.url)
            if url.path.endswith("/matches"):
                kind = parse_qs(url.query).get("type", [""])[0]
                items = [faceit_match(old_id,"ONGOING",[0,0],[],teams=("OLD A","OLD B"))] if kind=="ongoing" and race_phase["value"]==0 else []
                body = {"items":items}
            elif url.path.endswith("/"+old_id):
                waiting.set()
                await release.wait()
                body = faceit_match(old_id,"FINISHED",[2,0],[],teams=("OLD A","OLD B"))
            elif url.path.endswith("/"+new_id):
                body = faceit_match(new_id,"ONGOING",[0,0],[],teams=("NEW A","NEW B"))
            else:
                body = {}
            await route.fulfill(content_type="application/json",body=json.dumps(body))
            if url.path.endswith("/"+old_id): delivered.set()
        await race.route("https://open.faceit.com/**",late_faceit)
        await race.goto(base+"/#lobby")
        await expect(race.locator("#lobbyMatches")).to_contain_text("OLD A")
        await expect(race.locator(".lm-series")).to_contain_text("Серия · по картам")
        await expect(race.locator(".lm-game")).to_contain_text("Раунды на текущей карте")
        await expect(race.locator(".lm-game")).to_contain_text("Нет данных FACEIT")
        race_phase["value"]=1
        await race.clock.run_for(21000)
        await asyncio.wait_for(waiting.wait(),timeout=10)
        await race.fill("#faceitUrl",f"https://www.faceit.com/en/cs2/room/{new_id}")
        await race.locator("#lobbyForm button[type=submit]").click()
        await expect(race.locator("#lobbyMatches")).to_contain_text("NEW A")
        release.set()
        await asyncio.wait_for(delivered.wait(),timeout=10)
        await race.clock.run_for(1000)
        await expect(race.locator("#lobbyMatches")).not_to_contain_text("OLD A")
        await race.close()
        passed("lobby: separate series/round scores; a late response from the previous target is discarded")

        assert not errors, errors
        await browser.close()
    print(f"{len(checks)} live scenarios passed", flush=True)
    print("OBS_SETUP_PREVIEW_BEGIN", flush=True)
    print(base64.b64encode((output / "obs-connection-direct.jpg").read_bytes()).decode(), flush=True)
    print("OBS_SETUP_PREVIEW_END", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--chromium", default=None)
    parser.add_argument("--artifacts", default="artifacts")
    asyncio.run(run(parser.parse_args()))
