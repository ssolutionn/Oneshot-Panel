"""Browser QA for LAN mode: teams typed in the «ЛАН» dialog, one fixed webcam
per seat, seating in the team cards, observer text, OBS JSON, framing kept per
seat, reload, 375 px and switching back to the sheets.

Google Sheets is unreachable on purpose and VDO.Ninja is a blank page:

  python3 scripts/qa_lan.py --url http://127.0.0.1:3000 --chromium /path/to/chrome
"""
import argparse
import asyncio
import json
from pathlib import Path

from playwright.async_api import async_playwright, expect

TEAMS = "Team Alpha: nick1, nick2, nick3, nick4, nick5, sub1\n# comment\nBravo: b1, b2, b3, b4, b5"


async def run(args):
    out = Path(args.artifacts) / "lan"
    out.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=args.chromium, headless=True)
        ctx = await browser.new_context(viewport={"width": 1400, "height": 1000}, accept_downloads=True)
        await ctx.add_init_script("window.showSaveFilePicker = undefined")
        await ctx.route("https://docs.google.com/**", lambda route: route.abort())
        await ctx.route("https://vdo.ninja/**", lambda route: route.fulfill(body="<html></html>", content_type="text/html"))
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

        # Switched off: the sheets are the source again.
        await page.click("#lanBtn")
        await page.uncheck("#lanOn")
        await page.click("#lanForm button[type=submit]")
        await expect(page.locator("#sidebarSource")).to_be_visible()
        await expect(page.locator("#syncTitle")).not_to_contain_text("ЛАН")
        assert not errors, errors
        await browser.close()
    print("PASS: LAN mode: dialog and seat links, seating and substitutes, observer text, OBS JSON, "
          "reload, framing per seat, 375 px, back to sheets")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--chromium", default=None)
    parser.add_argument("--artifacts", default="artifacts")
    asyncio.run(run(parser.parse_args()))
