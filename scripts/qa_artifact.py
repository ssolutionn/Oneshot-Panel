"""Browser regression for the generated offline Claude artifact; no cloud access."""
import argparse
import asyncio
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.async_api import async_playwright, expect


def fixture():
    rows = []
    for side, team in enumerate(("QA Team A", "QA Team B")):
        for slot in range(5):
            rows.append([
                f"{side}-{slot}", team, str(slot + 1), f"QA-{side}-{slot}",
                f"old-{side}-{slot}", f"qa-room-{side}", "", "", "Основной",
                "", "", f"qa-password-{side} &+",
            ])
    return {"roster": rows, "schedule": [], "origin": "paste", "syncedAt": 1}


async def run(args):
    html = Path("claude-artifact/oneshot-panel.html").read_text(encoding="utf-8")
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=args.chromium, headless=True)
        context = await browser.new_context(accept_downloads=True)
        errors = []
        # A stable origin gives the artifact real localStorage; all network is blocked.
        async def serve(route):
            if route.request.url == "https://artifact.test/":
                await route.fulfill(content_type="text/html", body=html)
            else:
                await route.abort()
        await context.route("**/*", serve)
        page = await context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        await page.add_init_script("""(() => {
            Object.defineProperty(navigator, 'clipboard', {value: {
                writeText: async () => { throw new Error('QA denied clipboard'); }
            }});
            document.execCommand = () => false;
        })();""")
        await page.goto("https://artifact.test/")
        await page.evaluate("data => applyData(data)", fixture())
        await expect(page.locator(".player-row")).to_have_count(10)
        await expect(page.locator("#downloadBtn")).to_be_enabled()

        old_id = await page.evaluate("chosen('a')[0].id")
        rotate = page.locator('[data-regen="a"][data-slot="0"]')
        await rotate.click()
        await rotate.click()
        await expect(page.locator("#copyDialog")).to_be_visible()
        message = await page.locator("#manualCopy").input_value()
        assert message.startswith("## QA Team A\n")
        player_url = message.split("** ")[-1].strip()
        query = parse_qs(urlsplit(player_url).query)
        new_id = query["push"][0]
        assert new_id != old_id and "view" not in query
        assert query["password"] == ["qa-password-0 &+"]
        await page.locator("#closeCopy").click()
        await expect(page.locator(".player-row")).to_have_count(10)

        # Reapplying the shared snapshot and reopening the artifact retain the override.
        await page.evaluate("data => applyData(data)", fixture())
        assert await page.evaluate("chosen('a')[0].id") == new_id
        await page.reload()
        await page.evaluate("data => applyData(data)", fixture())
        assert await page.evaluate("chosen('a')[0].id") == new_id
        await expect(page.locator(".player-row")).to_have_count(10)

        async with page.expect_download() as pending:
            await page.locator("#downloadBtn").click()
        download = await pending.value
        saved = Path(await download.path())
        collection = json.loads(saved.read_text(encoding="utf-8"))
        cams = [source for source in collection["sources"]
                if source["name"].startswith("CAM ")]
        assert len(cams) == 10
        first = next(source for source in cams if source["name"].startswith("CAM 01 |"))
        actual = parse_qs(urlsplit(first["settings"]["url"]).query)
        assert actual["view"] == [new_id]
        assert actual["password"] == ["qa-password-0 &+"]
        assert download.suggested_filename.endswith(".json")
        assert not errors, errors
        await browser.close()
    print("PASS: generated artifact rotation, shared snapshot, reload and protected OBS export", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--chromium")
    asyncio.run(run(parser.parse_args()))
