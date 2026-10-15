"""Exercise real prepared photos, fallback states and all exported OBS card URLs."""
import argparse
import asyncio
import json
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import urlopen

from playwright.async_api import async_playwright, expect


async def run(args):
    root = Path(__file__).resolve().parent.parent
    catalog_url = getattr(args, "catalog_url", None)
    if catalog_url:
        with urlopen(catalog_url, timeout=20) as response:
            catalog = json.load(response)["players"]
    else:
        catalog = json.loads((root / "assets/players/players.json").read_text())["players"]
    senka = next(p for p in catalog if p["nick"].lower() == "senka")
    assert senka.get("photo") and senka.get("file"), "senka must have a prepared photo."
    output = Path(args.artifacts)
    output.mkdir(parents=True, exist_ok=True)
    base = args.url.rstrip("/")
    with_photo = next((p for p in catalog if p.get("file")), None)
    no_photo = next(p for p in catalog if p["nick"] == "maeggi")
    if any(p.get("photo") for p in catalog):
        assert with_photo is not None, "No HLTV photo was prepared; check build download logs."
    errors, external_images = [], []

    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=args.chromium, headless=True)
        context = await browser.new_context(viewport={"width": 1920, "height": 1080})
        page = await context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", lambda request:
                external_images.append(request.url)
                if request.resource_type == "image" and
                urlsplit(request.url).netloc != urlsplit(base).netloc else None)

        async def open_card(player):
            await page.goto(base + "/card.html?" + urlencode({
                "team": player["team"], "nick": player["nick"]}))
            await page.wait_for_selector("body[data-ready=true]")
            await expect(page.locator("#cardNick")).to_have_text(player["nick"])
            await expect(page.locator("#tournamentLogo")).to_be_visible()
            await expect(page.locator("#cardBackground")).to_be_visible()
            photo = await page.locator("body").get_attribute("data-photo")
            return photo

        # Every entry from the real build manifest, using the actual downloaded files.
        photos = 0
        for player in catalog:
            rendered = await open_card(player)
            assert rendered == (player.get("file") or "none"), (player["nick"], rendered)
            layout = await page.locator("body").get_attribute("data-layout")
            assert layout == ("photo" if player.get("file") else "no-photo")
            if player.get("file"):
                photos += 1
                await expect(page.locator("#cardPhoto")).to_be_visible()
                box = await page.locator("#cardPhoto").bounding_box()
                assert abs(box["x"] + box["width"] / 2 - 960) < 2
            else:
                await expect(page.locator("#cardPhoto")).to_be_hidden()

        for player, label in [(with_photo, "photo"), (senka, "senka"), (no_photo, "no-photo")]:
            if player is None:
                continue
            await open_card(player)
            await page.screenshot(path=str(output / f"card-{label}.png"))
            await page.set_viewport_size({"width": 480, "height": 270})
            await page.screenshot(path=str(output / f"card-{label}-tile.png"))
            box = await page.locator("#card").bounding_box()
            assert abs(box["width"] - 480) < 1 and abs(box["height"] - 270) < 1
            assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            await page.set_viewport_size({"width": 1920, "height": 1080})

        # Real sources from the JSON downloaded by the panel's browser regression.
        collection_paths = list(output.glob("*.json"))
        collections = []
        for path in collection_paths:
            document = json.loads(path.read_text())
            if isinstance(document, dict) and "sources" in document:
                collections.append(document)
        assert collections, "The panel QA must export an OBS collection first."
        exported_cards = 0
        for collection in collections:
            sources = [s for s in collection["sources"]
                       if s.get("name", "").startswith("CARD ")]
            assert len(sources) == 10, len(sources)
            for source in sources:
                assert source["id"] == "browser_source"
                settings = source["settings"]
                assert settings["width"] == 1920 and settings["height"] == 1080
                url = urlsplit(settings["url"])
                assert url.netloc == urlsplit(base).netloc
                assert url.path == "/card.html"
                await page.goto(settings["url"])
                await page.wait_for_selector("body[data-ready=true]")
                await expect(page.locator("#tournamentLogo")).to_be_visible()
                await expect(page.locator("#cardBackground")).to_be_visible()
                assert await page.locator("body").get_attribute("data-layout") in ("photo", "no-photo")
                exported_cards += 1

        # A broken photo must resolve to the no-photo layout, without a broken icon.
        if with_photo:
            broken = await browser.new_context(viewport={"width": 1920, "height": 1080})
            await broken.route("**/assets/players/" + with_photo["file"],
                               lambda route: route.abort("failed"))
            bad_page = await broken.new_page()
            bad_page.on("pageerror", lambda error: errors.append(str(error)))
            await bad_page.goto(base + "/card.html?" + urlencode({
                "team": with_photo["team"], "nick": with_photo["nick"]}))
            await bad_page.wait_for_selector("body[data-ready=true]")
            assert await bad_page.locator("body").get_attribute("data-photo") == "none"
            assert await bad_page.locator("body").get_attribute("data-layout") == "no-photo"
            await expect(bad_page.locator("#cardPhoto")).to_be_hidden()
            await expect(bad_page.locator("#cardEmblem")).to_be_visible()
            await broken.close()

        assert not errors, errors
        assert not external_images, external_images
        await context.close()
        await browser.close()
    summary = {"catalog": len(catalog), "photos": photos,
               "fallback": len(catalog) - photos, "exportedCardSources": exported_cards,
               "externalImageRequests": len(external_images)}
    (output / "player-cards-report.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("PLAYER CARDS:", json.dumps(summary), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--chromium", default=None)
    parser.add_argument("--artifacts", default="artifacts")
    parser.add_argument("--catalog-url", default=None)
    asyncio.run(run(parser.parse_args()))
