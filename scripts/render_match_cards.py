"""Render the approved card page to broadcast JPEGs and verify local OBS paths."""
import argparse
import asyncio
import base64
import html
import json
import shutil
from pathlib import Path
from urllib.parse import urlencode
from playwright.async_api import async_playwright, expect

async def run(args):
    root = Path(args.root).resolve()
    manifest = json.loads((root / "package-manifest.json").read_text(encoding="utf-8"))
    (root / "cards").mkdir(exist_ok=True)
    (root / "previews").mkdir(exist_ok=True)
    expected, errors = {}, []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--force-color-profile=srgb"])
        page = await browser.new_page(viewport={"width":1920, "height":1080}, device_scale_factor=1)
        page.on("pageerror", lambda error: errors.append(str(error)))
        for player in manifest["players"]:
            await page.goto(args.url.rstrip("/") + "/card.html?" + urlencode({
                "team":player["team"], "nick":player["nick"]}))
            await page.wait_for_selector("body[data-ready=true]")
            photo = await page.locator("body").get_attribute("data-photo")
            assert photo == (player["photo"] or "none"), (player["team"], player["nick"], photo)
            await expect(page.locator("#cardBackground")).to_be_visible()
            await expect(page.locator("#tournamentLogo")).to_be_visible()
            await expect(page.locator("#cardNick")).to_have_text(player["nick"])
            if player["photo"]:
                await expect(page.locator("#cardPhoto")).to_be_visible()
            else:
                await expect(page.locator("#cardPhoto")).to_be_hidden()
                await expect(page.locator("#cardEmblem")).to_be_visible()
            await page.screenshot(path=str(root / player["card"]), type="jpeg", quality=95)
            expected[player["id"]] = player
        assert not errors, errors
        preview = await browser.new_page(viewport={"width":1920, "height":432})
        for match in manifest["matches"]:
            images = []
            for key in match["players"]:
                player = expected[key]
                encoded = base64.b64encode((root / player["card"]).read_bytes()).decode()
                images.append('<img src="data:image/jpeg;base64,' + encoded + '">')
            await preview.set_content('<!doctype html><style>html,body{margin:0;background:#031b24}body{display:grid;grid-template-columns:repeat(5,384px)}img{width:384px;height:216px;display:block}</style>' + ''.join(images))
            await preview.locator("img").last.wait_for()
            await preview.evaluate("Promise.all([...document.images].map(i => i.decode()))")
            await preview.screenshot(path=str(root / "previews" / match["filename"].replace(".json", ".jpg")),
                                  type="jpeg", quality=95)
        # Browser CARD sources can carry their own image document. Validate every
        # embedded source with the browser network disabled before delivering JSON.
        ready = root / "OBS_READY"
        ready.mkdir(exist_ok=True)
        embedded_context = await browser.new_context(
            viewport={"width":1920, "height":1080}, offline=True)
        embedded_page = await embedded_context.new_page()
        network_requests = []
        embedded_page.on("request", lambda req: network_requests.append(req.url)
                         if req.url.startswith(("http:", "https:")) else None)
        for match in manifest["matches"]:
            document = json.loads((root / "EMBEDDED_TEMPLATES" / match["filename"]).read_text(encoding="utf-8"))
            sources = [s for s in document["sources"] if s["name"].startswith("CARD ")]
            assert len(sources) == 10
            for source, key in zip(sources, match["players"]):
                image = base64.b64encode((root / expected[key]["card"]).read_bytes()).decode()
                markup = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#031b24}img{display:block;width:100%;height:100%;object-fit:contain}</style></head><body><img src="data:image/jpeg;base64,' + image + '"></body></html>'
                source["settings"]["url"] = "data:text/html;base64," + base64.b64encode(markup.encode()).decode()
                assert len(source["settings"]["url"]) < 2_000_000, "Embedded browser URL is too large."
                await embedded_page.goto(source["settings"]["url"])
                await embedded_page.wait_for_function("document.images.length === 1 && document.images[0].complete && document.images[0].naturalWidth === 1920")
                box = await embedded_page.locator("img").bounding_box()
                assert box["x"] == 0 and box["y"] == 0
                assert box["width"] == 1920 and box["height"] == 1080
            (ready / match["filename"]).write_text(
                json.dumps(document,ensure_ascii=False,indent=2) + "\n",encoding="utf-8")
        assert not network_requests, "Embedded cards must not contact a website."
        (ready / "README-OBS.txt").write_text(
            "CyberClash — " + manifest["day"] + ".2026\n"
            "OBS → Коллекция сцен → Импорт → выберите JSON нужного матча.\n"
            "Фото, фон и подписи уже внутри каждого JSON. Пути к картинкам настраивать не нужно.\n"
            "Карточки проверены в Chromium без сети. Перед эфиром проверьте импорт и включение/отключение камер в вашем OBS.\n",
            encoding="utf-8")
        await embedded_context.close()
        shutil.rmtree(root / "EMBEDDED_TEMPLATES")
        await browser.close()
    # Resolve offline paths with the same helper included for the operator.
    import importlib.util
    spec = importlib.util.spec_from_file_location("prepare_local", root / "prepare_local.py")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    generated = helper.prepare(root)
    assert len(generated) == len(manifest["matches"])
    for filename in generated:
        document = json.loads(filename.read_text(encoding="utf-8"))
        cards = [s for s in document["sources"] if s["name"].startswith("CARD ")]
        cameras = [s for s in document["sources"] if s["name"].startswith("CAM ")]
        assert len(cards) == 10 and len(cameras) == 10
        assert all(s["id"] == "image_source" and Path(s["settings"]["file"]).is_file() for s in cards)
        assert len({s["uuid"] for s in document["sources"]}) == len(document["sources"])
        scene_names = {s["name"] for s in document["sources"] if s["id"] == "scene"}
        assert {"Матрица", *("Игрок " + str(i) for i in range(1,11))} <= scene_names
        filename.unlink()  # Runner paths must never be delivered to the operator.
    (root / "OBS_LOCAL").rmdir()
    report = {"day":manifest["day"], "matches":len(manifest["matches"]),
              "cards":len(manifest["players"]),
              "photos":sum(bool(p["photo"]) for p in manifest["players"]),
              "fallback":[p["team"] + " — " + p["nick"] for p in manifest["players"] if not p["photo"]],
              "offlineCollectionsValidated":len(generated),
              "embeddedSourcesVerifiedWithoutNetwork":len(manifest["matches"]) * 10,
              "embeddedExternalRequests":len(network_requests), "javascriptErrors":errors}
    (root / "verification.json").write_text(json.dumps(report,ensure_ascii=False,indent=2) + "\n", encoding="utf-8")
    print("MATCH_PACKAGE_VERIFIED:", json.dumps(report,ensure_ascii=False), flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root",default="work/match-package")
    parser.add_argument("--url",default="http://127.0.0.1:3000")
    asyncio.run(run(parser.parse_args()))
