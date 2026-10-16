"""Bookmaker auto-refresh UI: real site modules, controlled read-only API replies."""
import argparse
import asyncio
import csv
import io
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.async_api import async_playwright, expect

NOW = 1792141200000  # 16 October 2026 09:00 UTC
SCHEDULE = [{"date": "16.10", "time": "16:00", "team1": "HYPERSPIRIT", "team2": "Rune Eaters"}]


async def run(args):
    base = args.url.rstrip("/")
    source = Path("index.html").read_text(encoding="utf-8")
    begin = source.index('<section id="bookies"')
    section = source[begin:source.index("</section>", begin) + len("</section>")]
    # Use the production section and JavaScript; isolate clocks from OBS/lobby polling.
    html = ('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body>' +
            section + '<script type="module" src="/bookies.js"></script></body></html>')
    async with async_playwright() as p:
        for engine in ("chromium", "webkit"):
            browser = await getattr(p, engine).launch(
                executable_path=args.chromium if engine == "chromium" else None, headless=True)
            context = await browser.new_context(viewport={"width": 1440, "height": 900})
            page = await context.new_page()
            errors, calls, notes = [], [], []
            phase, slow = 0, asyncio.Event()
            page.on("pageerror", lambda error: errors.append(str(error)))
            await page.clock.install(time=datetime(2026, 10, 16, 9, 0, tzinfo=timezone.utc))
            await page.add_init_script("window.oneshotPanel={snapshot:()=>({schedule:" +
                                       json.dumps(SCHEDULE) + "}),copy:t=>window.__copiedBookies=t};window.__bookieNotes=[];" +
                                       "addEventListener('oneshot:lobby-note',e=>window.__bookieNotes.push(e.detail));")
            await page.route(base + "/__qa-bookies",
                             lambda route: route.fulfill(content_type="text/html", body=html))

            async def api(route):
                nonlocal phase
                assert route.request.method == "GET"
                bookmaker = parse_qs(urlsplit(route.request.url).query)["id"][0]
                generation = phase
                calls.append((bookmaker, generation))
                if bookmaker == "pari" and generation == 0:
                    await slow.wait()
                if bookmaker == "fonbet" and generation == 2:
                    await route.fulfill(status=503, content_type="application/json",
                                        body='{"message":"QA provider offline"}')
                    return
                events = []
                if bookmaker == "fonbet":
                    events.append({
                        "id": "first", "team1": "Rune Eaters Esports", "team2": "HyperSpirit",
                        "start": NOW + 4 * 3600000, "odds": [1.45, 2.55] if generation == 0 else [1.4, 2.7],
                        "live": False, "url": "https://fon.bet/sports/esports/147516/first",
                    })
                    if generation >= 1:
                        events.append({
                            "id": "new", "team1": "QA New A", "team2": "QA New B",
                            "start": NOW + 7 * 3600000, "odds": [1.8, 2.1],
                            "live": False, "url": "https://fon.bet/sports/esports/147516/new",
                        })
                if bookmaker == "fonbet" and generation >= 6:
                    events.extend([
                        {"id":"tomorrow","team1":"Rune Eaters","team2":"HyperSpirit",
                         "start":NOW+28*3600000,"odds":[9.1,9.2],"live":False,
                         "url":"https://fon.bet/sports/esports/future"},
                        {"id":"untrusted","team1":"\u00a0=HYPERLINK(1)","team2":"<img src=x onerror=alert(1)>\r=HYPERLINK(2)",
                         "start":NOW+8*3600000,"odds":[1.9,1.9],"live":False,
                         "url":"javascript:alert(1)"},
                    ])
                await route.fulfill(content_type="application/json", body=json.dumps({
                    "id": bookmaker, "ok": True, "errors": [], "events": events,
                    "checkedAt": NOW + generation * 60000,
                }))

            await page.route("**/api/bookmakers?**", api)
            await page.goto(base + "/__qa-bookies")
            row = page.locator("#bookie-fonbet")
            await expect(row.locator("td").first).to_contain_text("2.55 · 1.45")
            await expect(page.locator("#bookiesCheck")).to_be_disabled()
            assert not slow.is_set(), "fast source must render before the slow one"
            slow.set()
            await expect(page.locator("#bookiesCheck")).to_be_enabled()
            count = await page.evaluate("import('/bookmakers.js').then(m=>m.BOOKMAKERS.length)")
            assert len(calls) == count
            assert await page.evaluate("window.__bookieNotes.length") == 0

            phase = 1
            await page.clock.fast_forward(60000)
            await expect(row.locator("td").first).to_contain_text("2.70 · 1.40")
            await expect(page.locator("#bookiesTable thead")).to_contain_text("QA New A – QA New B")
            await expect(page.locator("#bookiesCheck")).to_be_enabled()
            assert await page.evaluate("window.__bookieNotes.length") == 1
            assert len(calls) == count * 2

            phase = 2
            await page.clock.fast_forward(60000)
            await expect(row).to_contain_text("данные устарели")
            await expect(row.locator("td").first).to_contain_text("2.70 · 1.40")
            await expect(page.locator("#bookiesStatus")).to_contain_text("Недоступно источников: 1")
            await expect(page.locator("#bookiesCheck")).to_be_enabled()

            phase = 3
            await page.clock.fast_forward(15000)
            await page.evaluate("dispatchEvent(new Event('focus'))")
            await expect(row).not_to_contain_text("данные устарели")
            await expect(page.locator("#bookiesCheck")).to_be_enabled()
            assert len(calls) == count * 4
            assert await page.evaluate("window.__bookieNotes.length") == 1

            # No network while offline; one immediate refresh on reconnection.
            await page.evaluate("""() => {
                Object.defineProperty(navigator, 'onLine', {configurable:true,get:()=>false});
                dispatchEvent(new Event('offline'));
            }""")
            before = len(calls)
            await page.clock.fast_forward(120000)
            assert len(calls) == before
            await expect(page.locator("#bookiesStatus")).to_contain_text("Нет сети")
            await expect(row).to_contain_text("данные устарели")
            phase = 4
            await page.evaluate("""() => {
                Object.defineProperty(navigator, 'onLine', {configurable:true,get:()=>true});
                dispatchEvent(new Event('online'));
            }""")
            await expect(page.locator("#bookiesCheck")).to_be_enabled()
            await expect(row).to_contain_text("в линии: 2")
            assert len(calls) == before + count

            # A suspended Safari tab resumes through visibilitychange. A simultaneous
            # focus event must not launch duplicate requests.
            await page.evaluate("""() => {
                Object.defineProperty(document, 'hidden', {configurable:true,get:()=>true});
                document.dispatchEvent(new Event('visibilitychange'));
            }""")
            before = len(calls)
            await page.clock.fast_forward(60000)
            assert len(calls) == before
            phase = 5
            await page.evaluate("""() => {
                Object.defineProperty(document, 'hidden', {configurable:true,get:()=>false});
                document.dispatchEvent(new Event('visibilitychange'));
                dispatchEvent(new Event('focus'));
            }""")
            await expect(page.locator("#bookiesCheck")).to_be_enabled()
            assert len(calls) == before + count

            # Manual refresh remains available; all records are read with GET.
            before = len(calls)
            await page.locator("#bookiesCheck").click()
            await expect(page.locator("#bookiesCheck")).to_be_enabled()
            assert len(calls) == before + count
            assert await page.evaluate("window.__bookieNotes.length") == 1
            phase = 6
            await page.locator("#bookiesCheck").click()
            await expect(page.locator("#bookiesCheck")).to_be_enabled()
            await page.locator("#bookiesCopy").click()
            copied = await page.evaluate("window.__copiedBookies")
            today, tomorrow = copied.split("Rune Eaters – HyperSpirit")
            assert "2.70 · 1.40" in today and "9.10 · 9.20" not in today
            assert "9.10 · 9.20" in tomorrow
            assert await page.locator("#bookiesTable img").count() == 0
            assert await page.locator('#bookiesTable a[href^="javascript:"]').count() == 0
            async with page.expect_download() as download_info:
                await page.locator("#bookiesCsv").click()
            download = await download_info.value
            text = Path(await download.path()).read_bytes().decode("utf-8-sig")
            assert "'\u00a0=HYPERLINK(1)" in text, "CSV must neutralize external formula cells"
            rows = list(csv.reader(io.StringIO(text, newline=""), delimiter=";"))
            assert all(len(row) == 14 for row in rows), "CR in external data must not create a new CSV row"
            assert any(row[2] == "<img src=x onerror=alert(1)>\r=HYPERLINK(2)" for row in rows[1:])
            output = Path(args.artifacts) / "bookies"
            output.mkdir(parents=True, exist_ok=True)
            await page.screenshot(path=str(output / (engine + ".png")), full_page=True)
            assert not errors, errors
            await browser.close()
            print("PASS: " + engine + " bookmaker discovery, minute polling, partial rendering, stale recovery, offline/visibility resume", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--chromium")
    parser.add_argument("--artifacts", default="artifacts")
    asyncio.run(run(parser.parse_args()))
