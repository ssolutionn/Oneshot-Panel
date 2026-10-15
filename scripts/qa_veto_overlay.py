"""Render the isolated veto design; no writes to the live panel or match state."""
import argparse
import asyncio
import base64
from pathlib import Path
from playwright.async_api import async_playwright

async def run(base, output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    checks = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--enable-unsafe-swiftshader"])
        context = await browser.new_context(viewport={"width":1920,"height":1164}, device_scale_factor=1)
        errors = []
        urls = set()
        context.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))
        context.on("request", lambda request: urls.add(request.url))
        page = await context.new_page()
        path = base.rstrip("/") + "/assets/veto-overlay/overlay.html"
        async def ready(layout="full", step=6, fmt="BO3", motion="off"):
            await page.goto(f"{path}?preview=1&layout={layout}&step={step}&format={fmt}&motion={motion}")
            await page.wait_for_selector("body[data-ready='true']")
            await page.wait_for_selector("#scene[data-ready='true']")
        await ready(step=2, motion="on")
        assert await page.locator("#scene").get_attribute("data-smoke") == "webgl", "Shader did not compile"
        async def sample():
            return await page.evaluate("""() => {
              const d=document.getElementById('scene').getContext('2d').getImageData(700,45,400,100).data;
              let h=2166136261;for(let i=0;i<d.length;i+=4){h=Math.imul(h^d[i],16777619);h=Math.imul(h^d[i+1],16777619);}
              return h>>>0;
            }""")
        first = await sample()
        await page.wait_for_timeout(1400)
        assert first != await sample(), "Smoke does not move"
        await page.evaluate("window.vetoOverlay.stopMotion()")
        await page.wait_for_timeout(350)
        first = await sample()
        await page.wait_for_timeout(350)
        assert first == await sample(), "Motion-off does not freeze the smoke"
        checks.append("Smoke moves and can be frozen")
        await page.screenshot(path=str(output / "veto-in-progress.png"))
        await page.click("#next")
        m = await page.evaluate("window.vetoOverlay.getState()")
        assert len(m["actions"]) == 3 and m["actions"][2]["side"] == "CT"
        await page.click("#previous")
        assert len((await page.evaluate("window.vetoOverlay.getState()"))["actions"]) == 2
        await page.click("#finish")
        assert len((await page.evaluate("window.vetoOverlay.getState()"))["actions"]) == 6
        checks.append("Preview advances, undoes and completes veto")
        for layout in ["full", "strip"]:
            for fmt in ["BO1", "BO2", "BO3", "BO5"]:
                await ready(layout=layout, fmt=fmt)
                async with page.expect_download() as pending:
                    await page.click("#download")
                download = await pending.value
                target = output / f"CyberClash-veto-{fmt}-{layout}.png"
                await download.save_as(str(target))
                raw = target.read_bytes()
                assert raw[:8] == b"\x89PNG\r\n\x1a\n"
                assert int.from_bytes(raw[16:20], "big") == 1920
                assert int.from_bytes(raw[20:24], "big") == 1080
                alpha = await page.evaluate("document.getElementById('scene').getContext('2d').getImageData(960,400,1,1).data[3]")
                assert alpha == (0 if layout == "strip" else 255)
                assert await page.locator("#scene").get_attribute("data-phase") == "finished"
                if fmt == "BO3":
                    await page.evaluate("""() => {
                      document.body.dataset.preview='false';document.getElementById('previewBar').hidden=true;
                    }""")
                    await page.set_viewport_size({"width":960,"height":540})
                    await page.wait_for_timeout(100)
                    await page.screenshot(path=str(output / f"veto-{layout}-preview.jpg"), type="jpeg", quality=85)
                    await page.set_viewport_size({"width":1920,"height":1164})
            checks.append(f"{layout}: all four formats export a 1920x1080 PNG; alpha correct")
        await ready(step=2)
        rejected = await page.evaluate("""async () => {
          const before=window.vetoOverlay.getState();
          try {await window.vetoOverlay.setState({...before,actions:[{map:'wrong',team:0,type:'ban'}]});}
          catch {return JSON.stringify(before)===JSON.stringify(window.vetoOverlay.getState());}
          return false;
        }""")
        assert rejected
        checks.append("Invalid updates preserve the last valid veto")
        await page.goto(path)
        await page.wait_for_selector("body[data-ready='true']")
        assert await page.evaluate("window.vetoOverlay.getState()") is None
        checks.append("OBS page without preview data waits instead of displaying demo results")
        await page.set_viewport_size({"width":375,"height":812})
        await ready(step=2)
        assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        checks.append("375px preview has no horizontal scrolling")
        await context.close()
        assert not errors, errors
        assert all(url.startswith(base) for url in urls), urls
        checks.append("No script errors and no third-party requests")
        # Check graceful asset failures separately from the clean-load assertions.
        fallback = await browser.new_page(viewport={"width":960,"height":540})
        await fallback.route("**/assets/maps/*", lambda route: route.abort())
        await fallback.route("**/assets/card/background.png", lambda route: route.abort())
        await fallback.goto(path + "?preview=1&step=6&motion=off")
        await fallback.wait_for_selector("body[data-ready='true']")
        await fallback.wait_for_selector("#scene[data-ready='true']")
        assert await fallback.locator("#scene").get_attribute("data-smoke") == "static"
        await fallback.close()
        checks.append("Missing artwork leaves a readable scene")
        await browser.close()
    (output / "verification.txt").write_text("\n".join(checks) + "\n")
    for item in checks:
        print("PASS:", item, flush=True)
    print("PREVIEW_JPEG_BASE64_BEGIN", flush=True)
    print(base64.b64encode((output / "veto-full-preview.jpg").read_bytes()).decode(), flush=True)
    print("PREVIEW_JPEG_BASE64_END", flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--output", default="artifacts/veto-overlay")
    args = parser.parse_args()
    asyncio.run(run(args.url, args.output))
