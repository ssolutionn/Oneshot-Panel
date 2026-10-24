"""Browser QA for the event panel of a LAN (events/<slug>/event.json, kind manual).

It starts its own panels: one as the event's address (EVENT=reu) and one as
CyberClash (the sheets panel must stay exactly as it was). Google Sheets is
unreachable on purpose, VDO.Ninja is a blank page, obs-websocket is a mock.

Checks: the address decides the event (tabs, title, no Sheets); teams, names,
logos and photos edited in place (click, drop), renaming keeps photos and the
match; Drive ZIP import; the old text roster and its photos move over; matches
and «В эфир»; seats, substitutes, observer text, OBS JSON with the cards; the
cards through the OBS dock (also after a reload of the dock); «Компы»;
«Событие»: name, colours, the event file out and in; «Сервер» explains itself
away from the CS2 computer; reload; 375 px.

  python3 scripts/qa_lan.py --chromium /path/to/chrome
"""
import argparse
import asyncio
import base64
import io
import json
import re
import sys
import zipfile
from pathlib import Path
from urllib.parse import unquote

from PIL import Image, ImageDraw
from playwright.async_api import async_playwright, expect

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qa_live import FAKE_VDO, OBS_URL, MockObs  # noqa: E402
from qa_cs2 import free_port, start_panel  # noqa: E402

CODE = "ABCD-EFGH-JKMN-PQRS"
TABS = ["Команды", "Матчи", "Эфир", "Вето", "Сервер", "Компы", "OBS", "Событие"]


def png(size=(900, 1200), transparent=True, color=(200, 120, 80)):
    """A cut-out person (a block) on a transparent or white background."""
    image = Image.new("RGBA" if transparent else "RGB", size, (0, 0, 0, 0) if transparent else "white")
    ImageDraw.Draw(image).rectangle((size[0] // 4, size[1] // 8, size[0] * 3 // 4, size[1] - 20), fill=color + ((255,) if transparent else ()))
    buffer = io.BytesIO()
    image.save(buffer, "PNG" if transparent else "JPEG")
    return buffer.getvalue()


def archive():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("Event/", b"")
        z.writestr("Event/Team Alpha/n1.png", png())
        z.writestr("Event/Team Alpha/n2 (1).png", png())   # Drive's name for a repeated upload
        for nick in ("n3", "n4", "n5"):
            z.writestr(f"Event/Team Alpha/{nick}.png", png((600, 800)))
        z.writestr("Event/Team Alpha/logo.png", png((600, 600), color=(40, 90, 220)))
        z.writestr("Event/Bravo/b1.jpg", png(transparent=False))
        for nick in ("b2", "b3", "b4", "b5"):
            z.writestr(f"Event/Bravo/{nick}.png", png((600, 800)))
        z.writestr("Event/Bravo/IMG_0001.HEIC", b"heic")
        z.writestr("Event/loose.png", png())
    return buffer.getvalue()


KEYS = ("teamalpha", "teamalpha|nick1")  # core.personKey / cardKey of the old name-keyed photos
INDEXED = """() => new Promise((resolve, reject) => {
  const open = indexedDB.open('oneshot-lan', 1);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => { const get = open.result.transaction('assets').objectStore('assets').get('oneshot-lan-assets-v1');
    get.onsuccess = () => resolve(get.result || null); get.onerror = () => reject(get.error); };
})"""
DROP = """async ([b64, name]) => {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const dt = new DataTransfer(); dt.items.add(new File([bytes], name, { type: 'image/png' })); return dt;
}"""


async def no_sideways(page, where):
    assert not await page.evaluate("document.documentElement.scrollWidth > innerWidth"), f"375 px: {where} scrolls sideways"


async def type_team(page, name, nicks):
    await page.click("#ltAddTeam")
    await page.keyboard.type(name)
    await page.keyboard.press("Enter")
    for nick in nicks:
        await page.keyboard.type(nick)
        await page.keyboard.press("Enter")


async def run(args):
    out = Path(args.artifacts) / "lan"
    out.mkdir(parents=True, exist_ok=True)
    event_port, sheets_port = free_port(), free_port()
    event_panel = start_panel(event_port, EVENT="reu", VETO_RELAY_DIR=str(out / "relay-a"))
    sheets_panel = start_panel(sheets_port, VETO_RELAY_DIR=str(out / "relay-b"))
    base, sheets_base = f"http://127.0.0.1:{event_port}", f"http://127.0.0.1:{sheets_port}"
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(executable_path=args.chromium, headless=True)
            await event_address(browser, base, out)
            await sheets_address(browser, sheets_base)
            await old_roster_moves_over(browser, base)
            await previous_version_pictures(browser, base)
            await director_rooms(browser, base)
            await browser.close()
    finally:
        event_panel.kill()
        sheets_panel.kill()
    print("PASS: LAN event panel: the address decides the event, teams/logos/photos edited in place, rename keeps "
          "photos and the match, Drive ZIP, matches and «В эфир», seats and substitutes, OBS JSON and dock cards, "
          "«Компы», «Событие» (name, colours, file out and in), «Сервер» guide, old roster moves over, pictures of the "
          "previous version keep their teams, director links and «Найти компы», «Кадр», reload, 375 px")


async def new_context(browser, **options):
    ctx = await browser.new_context(viewport={"width": 1400, "height": 1000}, accept_downloads=True,
                                    permissions=["clipboard-read", "clipboard-write"], **options)
    await ctx.add_init_script("window.showSaveFilePicker = undefined")
    sheets = []
    ctx.on("request", lambda request: sheets.append(request.url) if "docs.google.com" in request.url else None)
    await ctx.route("https://docs.google.com/**", lambda route: route.abort())
    await ctx.route("https://vdo.ninja/**", lambda route: route.fulfill(content_type="text/html", body=FAKE_VDO))
    return ctx, sheets


async def event_address(browser, base, out):
    ctx, sheets = await new_context(browser)
    page = await ctx.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: asyncio.ensure_future(dialog.accept()))
    await page.goto(base)

    # ---- the address is the event: its tabs, its name, no Sheets, starts at «Команды» ----
    assert await page.locator(".view-tab:visible").all_inner_texts() == TABS
    await expect(page.locator("#eventTitle")).to_have_text("ЛАН РЭУ им. Плеханова")
    assert await page.title() == "ЛАН РЭУ им. Плеханова · Oneshot"
    await expect(page.locator("#teamsView")).to_be_visible()
    for hidden in ("#viewLobby", "#bookiesNavBtn", "#sidebarSource", "#refreshBtn", "#settingsBtn"):
        await expect(page.locator(hidden)).to_be_hidden()
    await expect(page.locator("#ltGrid")).to_contain_text("Пока нет ни одной команды")

    # ---- teams typed in place: Enter goes name → nicks → a new player ----
    await type_team(page, "Альфа", ["nick1", "nick2", "nick3", "nick4", "nick5", "sub1"])
    await type_team(page, "Браво", ["b1", "b2", "b3", "b4", "b5"])
    cards = page.locator(".lt-card")
    await expect(cards).to_have_count(2)
    await expect(cards.nth(0).locator(".lt-subs")).to_have_text("Запасные")
    await expect(cards.nth(0).locator(".lt-count")).to_have_text("5 в основе · 1 запасн.")
    # A name taken twice is told at once and the second team waits.
    await type_team(page, "альфа", ["x1"])
    await expect(cards.nth(2).locator(".lt-warn")).to_be_visible()
    await cards.nth(2).locator(".lt-head .lt-remove").click()
    await expect(cards).to_have_count(2)

    # A logo by click, a photo by drop: both are drawn in their squares (canvas, the CSP stays).
    async with page.expect_file_chooser() as chooser:
        await cards.nth(0).locator(".lt-logo").click()
    await (await chooser.value).set_files([{"name": "logo.png", "mimeType": "image/png", "buffer": png((500, 500), color=(220, 40, 40))}])
    await expect(cards.nth(0).locator(".lt-logo")).to_have_class(re.compile("filled"), timeout=15000)
    drop = await page.evaluate_handle(DROP, [base64.b64encode(png()).decode(), "nick1.png"])
    await cards.nth(0).locator(".lt-photo").first.dispatch_event("drop", {"dataTransfer": drop})
    await expect(cards.nth(0).locator(".lt-photo").first).to_have_class(re.compile("filled"), timeout=15000)
    assert await page.locator("img[src^='data:']").count() == 0, "data: images would break the CSP"
    # The card of a player, as OBS will show it.
    await cards.nth(0).locator(".lt-player").first.hover()
    await cards.nth(0).locator(".lt-card-btn").first.click()
    await expect(page.locator("#ltCardCaption")).to_contain_text("nick1 (Альфа) — фото есть, лого есть")
    await page.screenshot(path=str(out / "lan-card.png"))
    await page.keyboard.press("Escape")
    await page.screenshot(path=str(out / "lan-teams.png"), full_page=True)

    # ---- the Drive ZIP fills teams, nicks, photos and logos (IndexedDB) ----
    await page.set_input_files("#ltZip", files=[{"name": "LAN.zip", "mimeType": "application/zip", "buffer": archive()}])
    await expect(page.locator("#ltStatus")).to_contain_text("Загружено: 2", timeout=30000)
    log = await page.locator("#ltLog").inner_text()
    assert "без прозрачного фона" in log and "HEIC" in log and "loose.png: лежит вне папки команды" in log, log
    assert "Bravo: нет logo.png" in log and "Team Alpha: 5 фото, лого ✓" in log, log
    await expect(cards).to_have_count(4)
    await expect(cards.nth(2).locator(".lt-name")).to_have_value("Team Alpha")
    assert [await cards.nth(2).locator(".lt-nick").nth(i).input_value() for i in range(5)] == ["n1", "n2", "n3", "n4", "n5"]
    stored = await page.evaluate(INDEXED)
    assert len(stored["photos"]) == 11 and len(stored["logos"]) == 2, (len(stored["photos"]), len(stored["logos"]))
    assert all(v.startswith("data:image/") and len(v) < 120000 for v in [*stored["photos"].values(), *stored["logos"].values()])
    assert await page.evaluate("localStorage.getItem('oneshot-lan-assets-v1')") is None

    # ---- matches: the template, a time, a format, «В эфир» ----
    await page.click("#matchesNavBtn")
    await page.click("#lmTemplate")
    rows = page.locator(".em-row")
    await expect(rows).to_have_count(3)
    await rows.nth(0).locator(".em-time").fill("16:00")
    await rows.nth(0).locator(".em-time").dispatch_event("change")
    await rows.nth(0).locator(".em-format").select_option("BO1")
    await expect(rows.nth(2).locator("button:has-text('В эфир')")).to_be_disabled()
    await rows.nth(0).locator("button:has-text('В эфир')").click()
    await expect(page.locator("#prepView")).to_be_visible()
    assert await page.input_value("#matchStage") == "Полуфинал 1" and await page.input_value("#matchTime") == "16:00"
    assert await page.input_value("#vetoFormat") == "BO1"
    await expect(page.locator("#scheduleLabel")).to_have_text("Матч из вкладки «Матчи»")

    # ---- «Эфир»: one fixed webcam per seat (REU: rooms team1/team2, PCs pc1…pc5), logos in the cards ----
    team_rows = page.locator("#teamGrid .player-row")
    await expect(team_rows.nth(0)).to_contain_text("Место A1")
    await expect(team_rows.nth(0)).to_contain_text("view=pc1&solo=1&room=team1")
    await expect(team_rows.nth(5)).to_contain_text("view=pc1&solo=1&room=team2")
    await expect(team_rows.nth(9)).to_contain_text("view=pc5&solo=1&room=team2")
    assert await page.locator("[data-regen], [data-setid]").count() == 0
    await expect(page.locator("#teamGrid [data-lan-logo] canvas")).to_have_count(1)  # Альфа has a logo, Браво not
    # A substitute takes seat A2: the stream stays with the seat.
    await page.select_option('[data-player="a"][data-slot="1"]', label="sub1 (запасной)")
    await expect(team_rows.nth(1)).to_contain_text("view=pc2&solo=1&room=team1")
    await page.click("#tabObserver")
    observer = await page.input_value("#output")
    assert "2. Альфа — sub1" in observer and "6. Браво — b1" in observer, observer
    # Renaming a team in «Команды» keeps it in the match, its lineup, veto and logo —
    # also while the name is blank for a moment (saved on the way).
    await page.click("#vetoNavBtn")
    await page.click('[data-map="Anubis"]')
    await expect(page.locator('[data-map="Anubis"]')).to_be_disabled()
    await page.click("#teamsNavBtn")
    await cards.nth(0).locator(".lt-name").fill("")
    await page.wait_for_timeout(700)
    await cards.nth(0).locator(".lt-name").fill("Альфа Про")
    await cards.nth(0).locator(".lt-name").dispatch_event("change")
    await page.click("#vetoNavBtn")
    await expect(page.locator('[data-map="Anubis"]')).to_be_disabled()
    await page.click("#viewPrep")
    await expect(page.locator('[data-team="a"]')).to_have_value("Альфа Про")
    assert (await page.locator('[data-player="a"][data-slot="1"] option:checked').inner_text()).startswith("sub1")
    await expect(page.locator("#teamGrid [data-lan-logo] canvas")).to_have_count(1)
    # OBS JSON: seats in the cameras, the cards with their photos inside.
    await page.check("#includeCards")
    async with page.expect_download() as info:
        await page.click("#downloadBtn")
    data = json.loads((await (await info.value).path()).read_text())
    cams = {s["name"]: s["settings"]["url"] for s in data["sources"] if s["name"].startswith("CAM ")}
    assert "view=pc2&solo=1&room=team1&" in cams["CAM 02 | Альфа Про | sub1"], cams
    assert "view=pc1&solo=1&room=team2&" in cams["CAM 06 | Браво | b1"], cams
    cards_json = {s["name"]: s["settings"]["url"] for s in data["sources"] if s["name"].startswith("CARD ")}
    first = unquote(cards_json["CARD 01 | Альфа Про | nick1"])
    assert first.startswith("data:text/html;charset=utf-8,") and "data:image/webp;base64," in first and "data:image/png;base64," in first
    # «Кадр» works on a LAN too: the frame window opens for a seated player.
    await page.click("#camera-a-0")
    await expect(page.locator("#cameraDialog")).to_be_visible()
    await page.click("#closeCamera")
    await expect(page.locator("#cameraDialog")).to_be_hidden()
    await page.screenshot(path=str(out / "lan-efir.png"), full_page=True)

    # ---- the same cards through the OBS dock, also to a dock that was reloaded ----
    await page.evaluate("localStorage.setItem('oneshot-obs', JSON.stringify({mode: 'bridge', code: '%s'}))" % CODE)
    await page.reload()
    await page.click("#viewPrep")
    await page.check("#includeCards")
    dock_obs = MockObs()

    async def open_dock():
        dock = await ctx.new_page()
        await dock.add_init_script("localStorage.setItem('oneshot-obs-bridge', JSON.stringify({url: 'ws://127.0.0.1:4455', password: 'pw'}))")
        await dock.route_web_socket(OBS_URL, dock_obs.handler)
        await dock.goto(f"{base}/obs-bridge.html#k={CODE}")
        return dock
    dock = await open_dock()
    await expect(page.locator("#obsBridgeStatus")).to_contain_text("Всё подключено", timeout=40000)
    await page.click("#sendObsBtn")
    await expect(page.locator("#toast")).to_contain_text("OBS обновлён: 10 камер, 10 карточек", timeout=60000)
    assert dock_obs.inputs["CARD 01 | Альфа Про | nick1"]["url"] == cards_json["CARD 01 | Альфа Про | nick1"]
    await dock.close()
    dock_obs = MockObs()
    dock = await open_dock()
    await expect(page.locator("#obsBridgeStatus")).to_contain_text("Всё подключено", timeout=40000)
    await page.click("#sendObsBtn")
    for _ in range(240):
        if len(dock_obs.names("CARD ")) == 10 and dock_obs.inputs.get("CARD 06 | Браво | b1", {}).get("url"):
            break
        await asyncio.sleep(0.25)
    assert dock_obs.inputs["CARD 06 | Браво | b1"]["url"].startswith("data:text/html"), "cards did not reach a reloaded dock"
    await dock.close()

    # ---- «Компы»: ten seats, who sits there, the links; a new prefix asks first ----
    await page.click("#seatsNavBtn")
    seat_cards = page.locator(".seat-card")
    await expect(seat_cards).to_have_count(10)
    await expect(seat_cards.nth(1)).to_contain_text("sub1")
    await expect(seat_cards.nth(9)).to_contain_text("?room=team2&broadcast&do&push=pc5")
    await page.click("#seatsCopyAll")
    copied = await page.evaluate("navigator.clipboard.readText()")
    assert copied.count("https://vdo.ninja/") == 10 and copied.startswith("A1: "), copied
    await expect(page.locator("#seatsPrefixBox")).to_be_hidden()
    assert [await page.input_value(f"#{i}") for i in ("seatsRoomA", "seatsRoomB", "seatsIds")] == ["team1", "team2", "pc1, pc2, pc3, pc4, pc5"]
    # pc1 in both rooms with no passwords: the panel says how to keep them apart.
    await expect(page.locator("#seatsClash")).to_be_visible()
    await page.fill("#seatsPasswordB", "b2pw")
    await page.dispatch_event("#seatsPasswordB", "change")
    await expect(seat_cards.nth(9)).to_contain_text("?room=team2&password=b2pw&broadcast&do&push=pc5")
    await expect(seat_cards.nth(0)).to_contain_text("?room=team1&broadcast&do&push=pc1")
    await expect(page.locator("#seatsClash")).to_be_hidden()
    await page.screenshot(path=str(out / "lan-seats.png"), full_page=True)

    # ---- «Сервер» away from the CS2 computer: how to start it there ----
    await page.click("#serverNavBtn")
    await expect(page.locator("#serverGuide")).to_be_visible()
    await expect(page.locator("#serverStartCommand")).to_have_text("CS2_JOURNAL=1 EVENT=reu npm start")
    await expect(page.locator("#serverLog")).to_be_hidden()

    # ---- «Событие»: the name everywhere, colours in the cards, the file out ----
    await page.click("#eventNavBtn")
    await page.fill("#evName", "ЛАН РЭУ Финалы")
    await expect(page.locator("#eventTitle")).to_have_text("ЛАН РЭУ Финалы")
    await expect(page.locator("#footerNote")).to_have_text("Веб-панель · ЛАН РЭУ Финалы · ЛАН")
    await expect(page.locator("#cvTournament")).to_have_value("ЛАН РЭУ Финалы")
    await page.fill("#evAccent", "#ff0066")
    await page.dispatch_event("#evAccent", "input")
    async with page.expect_download() as info:
        await page.click("#evExport")
    event_file = await (await info.value).path()
    saved = json.loads(Path(event_file).read_text())
    assert saved["format"] == "oneshot-event" and len(saved["lan"]["teams"]) == 4 and len(saved["lan"]["matches"]) == 3, saved["lan"].keys()
    assert len(saved["assets"]["photos"]) == 11 and "on" not in saved["lan"]
    await page.screenshot(path=str(out / "lan-event.png"), full_page=True)
    await page.click("#viewPrep")
    async with page.expect_download() as info:
        await page.click("#downloadBtn")
    look = json.loads((await (await info.value).path()).read_text())
    card = unquote(next(s["settings"]["url"] for s in look["sources"] if s["name"].startswith("CARD 01 ")))
    assert "--accent:#ff0066" in card and "--black:#031b24" in card, card[:400]

    # ---- reload keeps it all; 375 px without sideways scroll ----
    await page.reload()
    await page.click("#teamsNavBtn")
    await expect(cards).to_have_count(4)
    await expect(cards.nth(0).locator(".lt-logo")).to_have_class(re.compile("filled"), timeout=15000)
    mobile = await ctx.new_page()
    await mobile.set_viewport_size({"width": 375, "height": 800})
    await mobile.goto(base)
    for tab in ("teamsNavBtn", "matchesNavBtn", "viewPrep", "seatsNavBtn", "serverNavBtn", "eventNavBtn"):
        await mobile.click(f"#{tab}")
        await no_sideways(mobile, tab)
    await mobile.click("#teamsNavBtn")
    await mobile.screenshot(path=str(out / "lan-mobile.png"), full_page=True)
    await mobile.close()

    # ---- the event file on another computer (a fresh browser) ----
    other, _ = await new_context(browser)
    fresh = await other.new_page()
    fresh.on("dialog", lambda dialog: asyncio.ensure_future(dialog.accept()))
    await fresh.goto(base)
    await fresh.click("#eventNavBtn")
    await fresh.set_input_files("#evFile", event_file)
    await expect(fresh.locator("#evStatus")).to_contain_text("Событие загружено: 4 команд, 11 фото")
    await fresh.click("#teamsNavBtn")
    await expect(fresh.locator(".lt-card")).to_have_count(4)
    await expect(fresh.locator(".lt-card").nth(0).locator(".lt-name")).to_have_value("Альфа Про")
    assert await fresh.input_value("#seatsPasswordB") == "b2pw"
    await expect(fresh.locator("#eventTitle")).to_have_text("ЛАН РЭУ Финалы")
    await other.close()

    assert not sheets, f"the event address asked Google Sheets: {sheets[:2]}"
    assert not errors, errors
    await ctx.close()


async def sheets_address(browser, base):
    """CyberClash stays the sheets panel: no event tabs, and LAN left on by the old dialog is switched off."""
    ctx, _ = await new_context(browser)
    page = await ctx.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    await page.add_init_script("""if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1');
      localStorage.setItem('oneshot-lan-v1', JSON.stringify({ on: true, prefix: 'k7qz', text: 'A: a1, a2' })); }""")
    await page.goto(base)
    assert await page.locator(".view-tab:visible").all_inner_texts() == ["Подготовка", "Вето", "Лобби", "OBS", "Букмекеры"]
    assert await page.evaluate("document.documentElement.dataset.kind") == "sheets"
    await expect(page.locator("#eventTitle")).to_be_hidden()
    await expect(page.locator("#syncTitle")).not_to_contain_text("ЛАН")
    assert await page.evaluate("JSON.parse(localStorage.getItem('oneshot-lan-v1')).on") is False
    await no_sideways(page, "sheets panel")
    assert not errors, errors
    await ctx.close()


async def old_roster_moves_over(browser, base):
    """A browser that used the old «ЛАН» window: its text roster and name-keyed photos become the event's."""
    ctx, _ = await new_context(browser)
    page = await ctx.new_page()
    photo = "data:image/png;base64," + base64.b64encode(png((300, 400))).decode()
    await page.add_init_script("""if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); const photo = %s;
      localStorage.setItem('oneshot-lan-v1', JSON.stringify({ on: true, prefix: 'k7qz', text: 'Team Alpha: nick1, nick2\\nBravo: b1' }));
      localStorage.setItem('oneshot-lan-assets-v1', JSON.stringify({ v: 1, photos: { [KEY_PHOTO]: photo }, logos: { [KEY_LOGO]: photo } })); }"""
                               .replace("KEY_PHOTO", json.dumps(KEYS[1])).replace("KEY_LOGO", json.dumps(KEYS[0])) % json.dumps(photo))
    await page.goto(base + "/#teams")
    cards = page.locator(".lt-card")
    await expect(cards).to_have_count(2)
    await expect(cards.nth(0).locator(".lt-name")).to_have_value("Team Alpha")
    await expect(cards.nth(0).locator(".lt-logo")).to_have_class(re.compile("filled"), timeout=15000)
    await expect(cards.nth(0).locator(".lt-photo").first).to_have_class(re.compile("filled"))
    stored = await page.evaluate(INDEXED)
    assert stored["logos"].get("#t1") and stored["photos"].get("#t1p1"), list(stored["photos"])
    # The old name keys moved, not copied: a later team «T1» can not pick them up.
    assert not stored["logos"].get(KEYS[0]) and not stored["photos"].get(KEYS[1]), list(stored["photos"])
    assert await page.input_value("#seatsPrefix") == "k7qz"
    # «Компы» watches every seat's PC, also the seats nobody sits at (3 players here, 10 PCs).
    await page.click("#seatsNavBtn")
    await expect(page.locator(".seat-card[data-seat-cam=live]")).to_have_count(10, timeout=20000)
    await expect(page.locator("#seatsWatch")).to_have_text("Вебки: 10 из 10 в эфире")
    await ctx.close()

async def previous_version_pictures(browser, base):
    """Pictures the previous version (live on reu) kept by bare id stay with their teams after the update."""
    ctx, _ = await new_context(browser)
    page = await ctx.new_page()
    url = lambda color: "data:image/png;base64," + base64.b64encode(png((40, 40), transparent=False, color=color)).decode()
    alpha, alpha_photo, bravo_new, bravo_old = url((250, 0, 0)), url((0, 250, 0)), url((0, 0, 250)), url((9, 9, 9))
    lan = {"on": True, "prefix": "k7qz", "teams": [
        {"id": "t1", "name": "Alpha", "players": [{"id": "t1p1", "nick": "a1"}]},
        {"id": "xq1", "name": "T1", "players": [{"id": "xq1p", "nick": "z1"}]},   # its name key is «t1» too
        {"id": "xq2", "name": "Bravo", "players": [{"id": "xq2p", "nick": "b1"}]}]}
    assets = {"v": 1, "logos": {"t1": alpha, "xq2": bravo_new, "bravo": bravo_old}, "photos": {"t1p1": alpha_photo}}
    await page.add_init_script("""if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1');
      localStorage.setItem('oneshot-lan-v1', %s); localStorage.setItem('oneshot-lan-assets-v1', %s); }"""
                               % (json.dumps(json.dumps(lan)), json.dumps(json.dumps(assets))))
    await page.goto(base + "/#teams")
    await expect(page.locator(".lt-card")).to_have_count(3)
    await expect(page.locator(".lt-card").nth(0).locator(".lt-logo")).to_have_class(re.compile("filled"), timeout=15000)
    stored = await page.evaluate(INDEXED)
    logos, photos = stored["logos"], stored["photos"]
    assert logos.get("#t1") == alpha and photos.get("#t1p1") == alpha_photo, (list(logos), list(photos))
    assert "#xq1" not in logos, "the team named «T1» took Alpha's logo"
    assert logos.get("#xq2") == bravo_new, "the older name-keyed logo beat the team's own"
    assert not ({"t1", "xq2", "bravo"} & set(logos)) and "t1p1" not in photos, (list(logos), list(photos))
    await expect(page.locator(".lt-card").nth(1).locator(".lt-logo")).not_to_have_class(re.compile("filled"))
    await ctx.close()

SCAN_VDO = """<!doctype html><script>
const q = new URLSearchParams(location.search);
const rooms = { team1: ['pc3', 'pc1', 'pc2', 'pc5', 'pc4'], dota2: ['pc10', 'pc6', 'pc7', 'pc8', 'pc9', 'pc11'] };
const ids = q.get('label') === 'oneshot-scan' ? rooms[q.get('room')] || [] : (q.get('view') || '').split(',').filter(Boolean);
addEventListener('message', e => { if ((e.data || {}).getStreamIDs) parent.postMessage({ streamIDs: Object.fromEntries(ids.map(id => [id, id])) }, '*'); });
</script>"""


async def director_rooms(browser, base):
    """A director link pasted into «Компы» gives the room; «Найти компы» takes who streams there."""
    ctx, _ = await new_context(browser)
    await ctx.route("https://vdo.ninja/**", lambda route: route.fulfill(content_type="text/html", body=SCAN_VDO))
    page = await ctx.new_page()
    page.on("dialog", lambda dialog: asyncio.ensure_future(dialog.accept()))
    await page.goto(base + "/#seats")
    await page.click("#seatsNavBtn")
    await page.fill("#seatsRoomB", "https://vdo.ninja/?director=dota2&password=qq")
    await page.dispatch_event("#seatsRoomB", "change")
    await expect(page.locator("#seatsRoomB")).to_have_value("dota2")
    assert await page.input_value("#seatsPasswordB") == "qq"
    await page.click("#seatsScan")
    await expect(page.locator("#seatsIdsB")).to_have_value("pc6, pc7, pc8, pc9, pc10", timeout=20000)
    await expect(page.locator("#seatsIds")).to_have_value("pc1, pc2, pc3, pc4, pc5")
    await expect(page.locator("#toast")).to_contain_text("pc11")
    await expect(page.locator(".seat-card").nth(5)).to_contain_text("?room=dota2&password=qq&broadcast&do&push=pc6")
    await expect(page.locator("#seatsClash")).to_be_hidden()
    # «Кадр» of a seat nobody sits at yet: kept for that PC (room and ID).
    await page.click('[data-seat-frame="b0"]')
    await expect(page.locator("#cameraHeading")).to_have_text("Кадр: B1 · dota2 / pc6")
    await page.click("#cameraRotate")
    await page.click("#closeCamera")
    frames = await page.evaluate("JSON.parse(localStorage.getItem('oneshot-camera-settings-v1'))")
    assert frames['["lan","dota2","pc6"]']["rotation"] == 90, frames
    # The status says it in words: the stub VDO streams every seat.
    await expect(page.locator(".seat-card").nth(0).locator(".seat-state")).to_have_text("В ЭФИРЕ", timeout=20000)
    # A placeholder for team B: under its cameras in OBS, A's cards stay blank.
    plate = "data:image/png;base64," + base64.b64encode(png((640, 480), transparent=False, color=(0, 200, 230))).decode()
    async with page.expect_file_chooser() as chooser:
        await page.click("#seatsPlatePickB")
    await (await chooser.value).set_files(files=[{"name": "plate.png", "mimeType": "image/png",
                                                  "buffer": base64.b64decode(plate.split(",", 1)[1])}])
    await expect(page.locator("#seatsPlateNameB")).not_to_contain_text("нет картинки", timeout=15000)
    await expect(page.locator("#seatsPlateClearB")).to_be_enabled()
    await expect(page.locator("#seatsPlateClearA")).to_be_disabled()
    # No match yet: «Камеры в OBS» still sends the ten seats' cameras straight into OBS.
    obs = MockObs()
    await page.route_web_socket(OBS_URL, obs.handler)
    await page.evaluate("localStorage.setItem('oneshot-obs', JSON.stringify({mode: 'direct', url: 'ws://127.0.0.1:4455', password: 'pw'}))")
    await page.click("#seatsSendObs")
    await expect(page.locator("#toast")).to_contain_text("OBS обновлён: 10 камер", timeout=20000)
    urls = {name: v.get("url", "") for name, v in obs.inputs.items()}
    assert "view=pc1&solo=1&room=team1&" in urls["CAM 01 | team1 | pc1"], urls
    assert "view=pc6&solo=1&room=dota2&password=qq&" in urls["CAM 06 | dota2 | pc6"], urls
    cards = {name: v for name, v in obs.inputs.items() if name.startswith("CARD ")}
    b_card = unquote(cards["CARD 06 | dota2 | pc6"]["url"])
    assert "<title>Заглушка</title>" in b_card and "data:image/jpeg;base64," in b_card, b_card[:200]
    assert unquote(cards["CARD 01 | team1 | pc1"]["url"]).endswith("<title>-</title>"), cards["CARD 01 | team1 | pc1"]["url"][:80]
    await no_sideways(page, "«Компы» with rooms")
    await ctx.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="", help="ignored: the script starts its own panels")
    parser.add_argument("--chromium", default=None)
    parser.add_argument("--artifacts", default="artifacts")
    asyncio.run(run(parser.parse_args()))
