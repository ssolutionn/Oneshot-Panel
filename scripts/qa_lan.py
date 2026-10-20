"""Browser QA for LAN mode: teams typed in the «ЛАН» dialog, one fixed webcam
per seat, seating in the team cards, observer text, OBS JSON, framing kept per
seat, reload, 375 px and switching back to the sheets.

Google Sheets is unreachable on purpose and VDO.Ninja is a blank page:

  python3 scripts/qa_lan.py --url http://127.0.0.1:3000 --chromium /path/to/chrome
"""
import argparse
import asyncio
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
from qa_browser import gviz, sample_roster  # noqa: E402

CODE = "ABCD-EFGH-JKMN-PQRS"


def png(size=(900, 1200), transparent=True):
    """A cut-out person (a block) on a transparent or white background."""
    image = Image.new("RGBA" if transparent else "RGB", size, (0, 0, 0, 0) if transparent else "white")
    ImageDraw.Draw(image).rectangle((size[0] // 4, size[1] // 8, size[0] * 3 // 4, size[1] - 20), fill=(200, 120, 80, 255) if transparent else (200, 120, 80))
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
        z.writestr("Event/Team Alpha/logo.png", png((600, 600)))
        z.writestr("Event/Bravo/b1.jpg", png(transparent=False))
        for nick in ("b2", "b3", "b4", "b5"):
            z.writestr(f"Event/Bravo/{nick}.png", png((600, 800)))
        z.writestr("Event/Bravo/IMG_0001.HEIC", b"heic")
        z.writestr("Event/loose.png", png())
    return buffer.getvalue()

TEAMS = "Team Alpha: nick1, nick2, nick3, nick4, nick5, sub1\n# comment\nBravo: b1, b2, b3, b4, b5"


async def run(args):
    out = Path(args.artifacts) / "lan"
    out.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=args.chromium, headless=True)
        ctx = await browser.new_context(viewport={"width": 1400, "height": 1000}, accept_downloads=True)
        await ctx.add_init_script("window.showSaveFilePicker = undefined")
        await ctx.route("https://docs.google.com/**", lambda route: route.abort())
        await ctx.route("https://vdo.ninja/**", lambda route: route.fulfill(content_type="text/html", body=FAKE_VDO))
        page = await ctx.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        await page.goto(args.url)

        # The dialog suggests a short prefix and cleans what is typed.
        await page.click("#lanBtn")
        assert len(await page.input_value("#lanPrefix")) == 4
        await page.fill("#lanPrefix", "K7-QZ")
        assert await page.input_value("#lanPrefix") == "k7qz"
        await expect(page.locator("#lanSeats li")).to_have_count(10)
        await expect(page.locator("#lanSeats li").first).to_contain_text("room=k7qz&broadcast&do&push=k7qza1")
        await expect(page.locator("#lanSeats li").last).to_contain_text("push=k7qzb5")
        await page.check("#lanOn")
        await page.click("#lanForm button[type=submit]")
        await expect(page.locator("#lanError")).to_contain_text("Добавь команды")
        await page.fill("#lanTeams", TEAMS)
        await page.click("#lanForm button[type=submit]")
        await expect(page.locator("#lanDialog")).to_be_hidden()
        await expect(page.locator("#syncTitle")).to_have_text("2 команды на ЛАН")
        await expect(page.locator("#sidebarSource")).to_be_hidden()

        # Seats: fixed streams, no per-player link buttons.
        rows = page.locator(".player-row")
        await expect(rows.nth(0)).to_contain_text("Место A1")
        await expect(rows.nth(0)).to_contain_text("view=k7qza1")
        await expect(rows.nth(9)).to_contain_text("Место B5")
        await expect(rows.nth(9)).to_contain_text("view=k7qzb5")
        assert await page.locator("[data-regen], [data-setid]").count() == 0

        # A substitute takes seat A2: the stream stays with the seat.
        await page.select_option('[data-player="a"][data-slot="1"]', label="sub1 (запасной)")
        await expect(rows.nth(1)).to_contain_text("view=k7qza2")
        await page.click("#tabObserver")
        observer = await page.input_value("#output")
        assert "2. Team Alpha — sub1" in observer and "6. Bravo — b1" in observer, observer

        await page.fill("#matchStage", "Полуфинал")
        await page.fill("#matchTime", "16:00")
        async with page.expect_download() as info:
            await page.click("#downloadBtn")
        data = json.loads((await (await info.value).path()).read_text())
        cams = {s["name"]: s["settings"]["url"] for s in data["sources"] if s["name"].startswith("CAM ")}
        assert "view=k7qza2&" in cams["CAM 02 | Team Alpha | sub1"], cams
        assert "view=k7qzb5&" in cams["CAM 10 | Bravo | b5"], cams
        await page.screenshot(path=str(out / "lan-prep.png"), full_page=True)

        # Reload keeps the mode, teams and seating.
        await page.reload()
        await expect(page.locator(".player-row").nth(1)).to_contain_text("view=k7qza2")
        assert (await page.locator('[data-player="a"][data-slot="1"] option:checked').inner_text()).startswith("sub1")

        # Framing belongs to the seat's webcam, whoever sits there.
        await page.click("#camera-a-1")
        await page.click("#cameraRotate")
        await page.keyboard.press("Escape")
        await expect(page.locator("#camera-a-1")).to_have_text("Кадр · 90°")
        await page.select_option('[data-player="a"][data-slot="1"]', label="nick2")
        await expect(page.locator("#camera-a-1")).to_have_text("Кадр · 90°")

        mobile = await ctx.new_page()
        await mobile.set_viewport_size({"width": 375, "height": 800})
        await mobile.goto(args.url)
        assert not await mobile.evaluate("document.documentElement.scrollWidth > innerWidth"), "375 px: panel scrolls sideways"
        await mobile.click("#lanBtn")
        assert not await mobile.evaluate("document.documentElement.scrollWidth > innerWidth"), "375 px: dialog scrolls sideways"
        await mobile.screenshot(path=str(out / "lan-mobile.png"))

        # ---- photos: a Drive ZIP in, cards with the photos inside out ----
        await page.click("#lanBtn")
        await page.set_input_files("#lanZip", files=[{"name": "LAN.zip", "mimeType": "application/zip", "buffer": archive()}])
        await expect(page.locator("#lanImportStatus")).to_contain_text("Сохранено в этом браузере: 10 фото, 1 лого", timeout=30000)
        log = await page.locator("#lanImportLog").inner_text()
        assert "без прозрачного фона" in log and "HEIC" in log and "loose.png: лежит вне папки команды" in log, log
        assert "Bravo: нет logo.png" in log and "Team Alpha: 5 фото, лого ✓" in log, log
        teams = await page.input_value("#lanTeams")
        assert "Team Alpha: n1, n2, n3, n4, n5" in teams and "Bravo: b1, b2, b3, b4, b5" in teams and "Team Alpha: nick1" not in teams, teams
        # A whole event's photos do not fit localStorage: they are in IndexedDB.
        stored = await page.evaluate("""() => new Promise((resolve, reject) => {
          const open = indexedDB.open('oneshot-lan', 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => { const get = open.result.transaction('assets').objectStore('assets').get('oneshot-lan-assets-v1');
            get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); };
        })""")
        assert len(stored["photos"]) == 10 and len(stored["logos"]) == 1, stored
        assert await page.evaluate("localStorage.getItem('oneshot-lan-assets-v1')") is None
        sizes = [len(v) for v in [*stored["photos"].values(), *stored["logos"].values()]]
        assert max(sizes) < 120000, sizes   # a card page stays small enough for the dock
        assert all(v.startswith("data:image/") for v in [*stored["photos"].values(), *stored["logos"].values()])
        await page.click("#lanPreviewCard")
        await expect(page.locator("#lanCardPreview")).to_be_visible()
        await expect(page.locator("#lanImportStatus")).to_contain_text("фото есть, лого есть")
        lit = await page.evaluate("""() => { const c = document.getElementById('lanCardPreview'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let bright = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] > 90) bright++; return bright; }""")
        assert lit > 500, "the preview shows no photo"
        await page.screenshot(path=str(out / "lan-photos.png"))
        await page.click("#lanForm button[type=submit]")
        await expect(page.locator("#lanDialog")).to_be_hidden()
        await page.check("#includeCards")
        await page.fill("#matchStage", "Финал")
        await page.fill("#matchTime", "18:00")
        async with page.expect_download() as info:
            await page.click("#downloadBtn")
        data = json.loads((await (await info.value).path()).read_text())
        cards = {s["name"]: s["settings"]["url"] for s in data["sources"] if s["name"].startswith("CARD ")}
        assert len(cards) == 10 and all(u.startswith("data:text/html;charset=utf-8,") for u in cards.values()), list(cards.values())[:1]
        first = unquote(cards["CARD 01 | Team Alpha | n1"])
        assert "photo-layout" in first and "data:image/webp;base64," in first and "data:image/png;base64," in first, first[:300]
        assert "no-photo-layout" in unquote(cards["CARD 06 | Bravo | b1"]) or "photo-layout" in unquote(cards["CARD 06 | Bravo | b1"])
        # The card page really renders on its own, with no site behind it.
        card = await ctx.new_page()
        await card.set_viewport_size({"width": 960, "height": 540})
        await card.goto(cards["CARD 01 | Team Alpha | n1"])
        await expect(card.locator("#nick")).to_have_text("n1")
        assert await card.evaluate("document.querySelector('img.photo').naturalWidth > 0"), "photo did not load"
        assert await card.evaluate("document.querySelector('img.logo').naturalWidth > 0"), "logo did not load"
        await card.screenshot(path=str(out / "lan-card.png"))
        await card.close()

        # ---- the same cards through the OBS dock on another computer ----
        await page.evaluate("localStorage.setItem('oneshot-obs', JSON.stringify({mode: 'bridge', code: '%s'}))" % CODE)
        await page.reload()
        await page.check("#includeCards")
        dock_obs = MockObs()

        async def open_dock():
            dock = await ctx.new_page()
            await dock.add_init_script("localStorage.setItem('oneshot-obs-bridge', JSON.stringify({url: 'ws://127.0.0.1:4455', password: 'pw'}))")
            await dock.route_web_socket(OBS_URL, dock_obs.handler)
            await dock.goto(f"{args.url.rstrip('/')}/obs-bridge.html#k={CODE}")
            return dock
        dock = await open_dock()
        await expect(page.locator("#obsBridgeStatus")).to_contain_text("Всё подключено", timeout=40000)
        await page.click("#sendObsBtn")
        await expect(page.locator("#toast")).to_contain_text("OBS обновлён: 10 камер, 10 карточек", timeout=60000)
        sent = dock_obs.inputs["CARD 01 | Team Alpha | n1"]["url"]
        assert sent.startswith("data:text/html;charset=utf-8,") and "data:image/webp;base64," in unquote(sent), sent[:80]
        assert sent == cards["CARD 01 | Team Alpha | n1"], "the dock changed the card on its way"
        assert len(dock_obs.names("CARD ")) == 10
        # A dock that was reloaded lost the cards: they are sent again.
        await dock.close()
        dock_obs = MockObs()
        dock = await open_dock()
        await expect(page.locator("#obsBridgeStatus")).to_contain_text("Всё подключено", timeout=40000)
        await page.click("#sendObsBtn")
        # The toast of the first send may still be on screen: wait for the OBS itself.
        for _ in range(240):
            if len(dock_obs.names("CARD ")) == 10 and dock_obs.inputs.get("CARD 06 | Bravo | b1", {}).get("url"):
                break
            await asyncio.sleep(0.25)
        assert dock_obs.inputs["CARD 06 | Bravo | b1"]["url"] == cards["CARD 06 | Bravo | b1"], "cards did not reach a reloaded dock"
        await dock.close()
        await page.screenshot(path=str(out / "lan-dock-sent.png"))

        # ---- the event's own look ----
        await expect(page.locator("#viewLobby")).to_be_hidden()
        await expect(page.locator("#bookiesNavBtn")).to_be_hidden()
        await page.click("#lanBtn")
        await page.fill("#lanEventName", "Winter LAN")
        await page.fill("#lanColorAccent", "#ff0066")
        await page.click("#lanForm button[type=submit]")
        await expect(page.locator("#lanDialog")).to_be_hidden()
        await expect(page.locator("#footerNote")).to_have_text("Веб-панель · Winter LAN · ЛАН")
        await expect(page.locator("#cvTournament")).to_have_value("Winter LAN")
        await page.fill("#matchStage", "Финал")
        async with page.expect_download() as info:
            await page.click("#downloadBtn")
        look = json.loads((await (await info.value).path()).read_text())
        card = unquote(next(s["settings"]["url"] for s in look["sources"] if s["name"].startswith("CARD 01 ")))
        assert "--accent:#ff0066" in card and "--black:#031b24" in card, card[:400]
        # Arrow keys skip the hidden tabs.
        await page.focus("#vetoNavBtn")
        await page.keyboard.press("ArrowRight")
        await expect(page.locator("#obsView")).to_be_visible()
        await page.keyboard.press("ArrowRight")
        await expect(page.locator("#prepView")).to_be_visible()
        # The colours go back to the defaults with one click.
        await page.click("#lanBtn")
        await page.click("#lanColorsReset")
        assert await page.input_value("#lanColorAccent") == "#00d3ef"
        await page.click("#lanForm button[type=submit]")

        # Switched off: the sheets are the source again.
        await page.click("#lanBtn")
        await page.uncheck("#lanOn")
        await page.click("#lanForm button[type=submit]")
        await expect(page.locator("#viewLobby")).to_be_visible()
        await expect(page.locator("#bookiesNavBtn")).to_be_visible()
        await expect(page.locator("#footerNote")).to_contain_text("CyberClash")
        await expect(page.locator("#sidebarSource")).to_be_visible()
        await expect(page.locator("#syncTitle")).not_to_contain_text("ЛАН")
        assert not errors, errors
        await sheets_and_lan(browser, args, out)
        await browser.close()
    print("PASS: LAN mode: dialog and seat links, seating and substitutes, observer text, OBS JSON, "
          "event profile, reload, framing per seat, 375 px, back to sheets")


async def sheets_and_lan(browser, args, out):
    """The same browser runs the sheets tournament and the LAN: neither may wipe the other's state."""
    ctx = await browser.new_context(viewport={"width": 1400, "height": 1000})
    schedule = gviz([["", "16:00", "6yuBoJlbl", "HYPERSPIRIT", "B"]])
    roster = sample_roster()

    async def sheets(route):
        await route.fulfill(content_type="application/javascript", body=schedule if "gid=815739139" in route.request.url else roster)
    await ctx.route("https://docs.google.com/**/gviz/**", sheets)
    await ctx.route("https://vdo.ninja/**", lambda route: route.fulfill(content_type="text/html", body=FAKE_VDO))
    page = await ctx.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    await page.goto(args.url)
    await expect(page.locator(".player-row")).to_have_count(10)
    # A leaked link replaced (↻) and a veto ban in a sheets match.
    await page.click("#regen-a-0")
    await page.click("#regen-a-0")
    await expect(page.locator(".player-row").nth(0)).to_contain_text("Новый ID")
    if await page.locator("#copyDialog").is_visible():  # no clipboard here: the message is shown to copy
        await page.click("#closeCopy")
    await page.click("#vetoNavBtn")
    await page.click('[data-map="Anubis"]')
    await expect(page.locator('[data-map="Anubis"]')).to_be_disabled()
    await page.click("#viewPrep")
    # The ЛАН dialog saved with LAN off (only the event's name filled) changes nothing here.
    await page.click("#lanBtn")
    assert await page.input_value("#lanPrefix")
    await page.fill("#lanEventName", "ЛАН РЭУ")
    await page.click("#lanForm button[type=submit]")
    await expect(page.locator("#lanDialog")).to_be_hidden()
    await expect(page.locator('[data-map="Anubis"]')).to_be_disabled()
    await expect(page.locator(".player-row").nth(0)).to_contain_text("Новый ID")
    # LAN on and off again: the new stream ID of the sheets player is still there.
    await page.click("#lanBtn")
    await page.check("#lanOn")
    await page.fill("#lanTeams", TEAMS)
    await page.click("#lanForm button[type=submit]")
    await expect(page.locator("#syncTitle")).to_have_text("2 команды на ЛАН")
    # A tournament name typed by hand in the captains' block survives a reload.
    await expect(page.locator("#cvTournament")).to_have_value("ЛАН РЭУ")
    await page.click("#vetoNavBtn")
    await page.fill("#cvTournament", "ЛАН РЭУ Финал")
    await page.dispatch_event("#cvTournament", "change")
    await page.reload()
    await expect(page.locator("#syncTitle")).to_have_text("2 команды на ЛАН")
    await expect(page.locator("#cvTournament")).to_have_value("ЛАН РЭУ Финал")
    await page.click("#viewPrep")
    await page.click("#lanBtn")
    await page.uncheck("#lanOn")
    await page.click("#lanForm button[type=submit]")
    await expect(page.locator(".player-row").nth(0)).to_contain_text("Новый ID")
    # Seats emptied on purpose stay empty after a reload.
    for slot in range(5):
        await page.select_option(f'[data-player="a"][data-slot="{slot}"]', value="")
    await page.reload()
    await expect(page.locator(".player-row")).to_have_count(10)
    for slot in range(5):
        assert await page.input_value(f'[data-player="a"][data-slot="{slot}"]') == "", slot
    assert not errors, errors
    await page.screenshot(path=str(out / "lan-sheets-kept.png"))
    await ctx.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--chromium", default=None)
    parser.add_argument("--artifacts", default="artifacts")
    asyncio.run(run(parser.parse_args()))
