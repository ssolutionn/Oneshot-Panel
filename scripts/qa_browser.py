"""Regression checks; explicit Sheets fixtures, not direct live-browser evidence."""
import argparse
import asyncio
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.async_api import async_playwright, expect


def gviz(rows):
    data = {
        "status": "ok",
        "table": {
            "rows": [{"c": [{"v": cell} for cell in row]} for row in rows]
        },
    }
    return "google.visualization.Query.setResponse(" + json.dumps(data) + ");"


def sample_roster(names=("6yuBoJlbl", "HYPERSPIRIT")):
    rows = []
    for t, name in enumerate(names):
        for i in range(7):
            nick = [
                "Ciocardau", "Q-Q", "d1maje",
                "starplajerz", "Scr0b", "reserve", "coach"
            ][i] if t else f"Player-{i}"
            rows.append([
                f"{t}-{i}", name, str(i + 1), nick,
                f"stream-{t}-{i}", "hyperspirit" if t else "team-a",
                "", "", "Основной" if i < 5 else
                "Запасной" if i == 5 else "Тренер"
            ])
    return gviz(rows)


async def run(args):
    roster = Path(args.roster).read_text() if args.roster else sample_roster()
    schedule = Path(args.schedule).read_text() if args.schedule else gviz([
        ["", "16:00", "6yuBoJlbl", "HYPERSPIRIT", "B"],
        ["", "19:00", "6yuBoJlbl", "HYPERSPIRIT", "Финал"],
    ])
    artifacts = Path(args.artifacts)
    artifacts.mkdir(parents=True, exist_ok=True)
    checks = []

    def passed(name):
        checks.append(name)
        print("PASS:", name, flush=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=args.chromium, headless=True
        )
        context = await browser.new_context(
            viewport={"width": 1440, "height": 1000},
            locale="ru-RU", timezone_id="Europe/Moscow",
            accept_downloads=True,
        )
        modes = {
            "roster_error": False, "schedule_error": False,
            "delay": False, "new_source": False,
        }
        gate = asyncio.Event()
        errors = []

        async def sheets(route):
            params = parse_qs(urlsplit(route.request.url).query)
            is_schedule = params.get("gid") == ["1758299905"]
            if (modes["delay"] and
                    "/1e__ijBjufD19SWBkSJL177vmmfMh2tdykYQHAS06S8I/"
                    in route.request.url):
                await gate.wait()
            status = 503 if (
                modes["schedule_error"] if is_schedule
                else modes["roster_error"]
            ) else 200
            body = schedule if is_schedule else (
                sample_roster(("New Team A", "New Team B"))
                if modes["new_source"] and
                "/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/" in route.request.url
                else roster
            )
            await route.fulfill(
                status=status, content_type="application/javascript", body=body
            )

        await context.route("https://docs.google.com/**/gviz/**", sheets)
        page = await context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        await page.goto(args.url)
        await expect(page.locator("#syncTitle")).to_contain_text(
            "команд из таблицы"
        )
        assert await page.title() == "Oneshot webcam panel"
        passed("load rosters, schedule and OBS template")

        await page.wait_for_load_state("networkidle")
        assert await page.evaluate(
            "[...document.images].filter(i => i.complete && "
            "!i.naturalWidth).length"
        ) == 0
        passed("missing logo or map images leave no broken icons")

        options = await page.locator("#matchSelect option").evaluate_all(
            "els => els.filter(e => e.textContent.includes('6yuBoJlbl') && "
            "e.textContent.includes('HYPERSPIRIT')).map(e => e.value)"
        )
        assert options
        await page.select_option("#matchSelect", options[0])
        assert await page.input_value("#matchTime") == "16:00"
        assert await page.input_value("#matchStage") == "Группа B"
        await expect(page.locator("#downloadBtn")).to_be_enabled()
        passed("schedule fills time, stage and teams")

        await page.click("#tabPlayers")
        text = await page.input_value("#output")
        assert text.count("https://vdo.ninja/") == 10
        assert "[**" not in text and "** " in text and "director=" not in text
        passed("separate player URLs, bold nicknames and headings")

        await page.focus("#tabPlayers")
        await page.keyboard.press("ArrowLeft")
        assert await page.locator("#tabObserver").get_attribute(
            "aria-selected"
        ) == "true"
        observer = await page.input_value("#output")
        assert "http" not in observer and "vdo.ninja" not in observer
        assert observer.count("\n10. ") == 1
        passed("keyboard-accessible output tabs")

        select = page.locator('[data-player="a"][data-slot="0"]')
        replacement = await select.locator("option").evaluate_all(
            "els => els.filter(e => !e.disabled && e.value && "
            "/запасной|тренер/.test(e.textContent)).map(e => e.value)"
        )
        assert replacement
        await select.select_option(replacement[0])
        await page.click("#refreshBtn")
        await expect(page.locator("#refreshBtn")).to_be_enabled()
        assert await select.input_value() == replacement[0]
        passed("replacement survives refresh")

        modes["schedule_error"] = True
        await page.click("#refreshBtn")
        await expect(page.locator("#refreshBtn")).to_be_enabled()
        assert await page.input_value("#matchSelect") == options[0]
        modes["schedule_error"] = False
        passed("schedule outage retains selected match")

        modes["roster_error"] = True
        await page.click("#refreshBtn")
        await expect(page.locator("#refreshBtn")).to_be_enabled()
        assert await select.input_value() == replacement[0]
        assert await page.locator("#errorBox").is_visible()
        assert "ранее загруженным" in await page.locator(
            "#exportHint"
        ).inner_text()
        modes["roster_error"] = False
        passed("roster outage retains substitutions and marks stale data")

        async with page.expect_download() as info:
            await page.click("#downloadBtn")
        download = await info.value
        assert download.suggested_filename == (
            "16-00 _ Группа B _ 6yuBoJlbl vs HYPERSPIRIT.json"
        )
        target = artifacts / download.suggested_filename
        await download.save_as(target)
        data = json.loads(target.read_text())
        by_id = {s["uuid"]: s for s in data["sources"]}
        assert data["resolution"] == {"x": 1920, "y": 1080}
        for i in range(1, 11):
            scene = next(
                s for s in data["sources"] if s["name"] == f"Игрок {i}"
            )
            item = next(
                it for it in scene["settings"]["items"]
                if by_id[it["source_uuid"]]["id"] == "browser_source"
            )
            assert item["rot"] == 0
            assert item["bounds"] == {"x": 1920, "y": 1080}
            assert by_id[item["source_uuid"]]["settings"]["width"] == 1920
        passed("browser download filename and ten normalized cameras")

        await page.fill("#matchStage", "")
        assert await page.locator("#downloadBtn").is_disabled()
        assert await page.locator("#copyAllBtn").is_enabled()
        await page.fill("#matchStage", "Группа B")
        passed("missing metadata blocks JSON while links remain available")

        for name in ["Anubis", "Nuke", "Dust2", "Cache", "Inferno", "Mirage"]:
            await page.click(f'[data-map="{name}"]')
            if name in ["Dust2", "Cache"]:
                assert await page.locator("#sideChoice").is_visible()
                await page.click("#chooseCT")
            assert await page.evaluate(
                "document.activeElement?.matches('#mapGrid button, #copyVeto')"
            )
        expected = (
            "6yuBoJlbl removed Anubis\n"
            "HYPERSPIRIT removed Nuke\n"
            "6yuBoJlbl pick Dust2 (HYPERSPIRIT CT)\n"
            "HYPERSPIRIT pick Cache (6yuBoJlbl CT)\n"
            "6yuBoJlbl removed Inferno\n"
            "HYPERSPIRIT removed Mirage\n"
            "Ancient was left over"
        )
        assert await page.input_value("#vetoOutput") == expected
        assert await page.locator('[data-map="Ancient"]').is_disabled()
        await page.click("#vetoUndo")
        await page.click('[data-map="Mirage"]')
        assert await page.input_value("#vetoOutput") == expected
        passed("exact HLTV example, sides, completion, undo and redo")

        await page.reload()
        await expect(page.locator("#syncTitle")).to_contain_text(
            "команд из таблицы"
        )
        assert await page.input_value("#vetoOutput") == expected
        assert await select.input_value() == replacement[0]
        passed("reload restores match, substitutions and veto")
        await page.screenshot(
            path=str(artifacts / "desktop.png"), full_page=True
        )
        await page.locator("#veto").screenshot(
            path=str(artifacts / "veto.png")
        )

        await page.evaluate(
            "Object.defineProperty(navigator, 'clipboard', {value: "
            "{writeText: async () => {throw Error('denied')}}}); "
            "document.execCommand = () => false;"
        )
        await page.click('[data-view="a"][data-slot="0"]')
        assert await page.locator("#copyDialog").is_visible()
        payload = await page.input_value("#manualCopy")
        assert payload.startswith("https://vdo.ninja/?view=")
        assert "removed" not in payload
        await page.click("#closeCopy")
        passed("denied clipboard shows exact requested text")

        await page.click("#swapBtn")
        assert await page.input_value("#vetoOutput") == ""
        assert await page.input_value("#team-a") == "HYPERSPIRIT"
        await page.select_option("#team-b", "HYPERSPIRIT")
        assert await page.locator("#downloadBtn").is_disabled()
        assert await page.locator("#copyAllBtn").is_disabled()
        assert await page.locator('[data-map="Anubis"]').is_disabled()
        await page.select_option("#team-b", "6yuBoJlbl")
        passed("changed matchup resets veto; same-team match is blocked")

        await page.click("#settingsBtn")
        await page.fill("#sourceUrl", "https://example.com/table")
        await page.click('#settingsForm button[type="submit"]')
        assert await page.locator("#sourceError").is_visible()
        assert await page.input_value("#team-a") == "HYPERSPIRIT"
        await page.click("#closeSettings")
        passed("invalid source gives visible error and preserves data")

        await page.set_viewport_size({"width": 375, "height": 812})
        assert await page.evaluate(
            "document.documentElement.scrollWidth <= window.innerWidth"
        )
        await page.screenshot(
            path=str(artifacts / "mobile.png"), full_page=True
        )
        passed("375px mobile layout has no page overflow")

        modes["delay"] = True
        await page.click("#refreshBtn")
        await page.click("#settingsBtn")
        await page.fill(
            "#sourceUrl",
            "https://docs.google.com/spreadsheets/d/"
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/edit",
        )
        await page.fill("#sourceGid", "0")
        await page.fill("#scheduleUrl", "")
        await page.fill("#scheduleGid", "")
        modes["new_source"] = True
        await page.click('#settingsForm button[type="submit"]')
        await expect(page.locator("#team-a")).to_have_value("New Team A")
        gate.set()
        await page.wait_for_timeout(100)
        assert await page.input_value("#team-a") == "New Team A"
        passed("source change ignores late old data")
        assert not errors, errors
        await context.close()

        async def normal_sheets(route):
            await route.fulfill(
                status=200, content_type="application/javascript",
                body=schedule if "gid=1758299905" in route.request.url
                else roster,
            )

        bad = await browser.new_context()
        await bad.route("https://docs.google.com/**/gviz/**", normal_sheets)
        await bad.add_init_script(
            "localStorage.setItem('webcam-desk-source', '{broken'); "
            "localStorage.setItem('oneshot-webcam-match-v1', '{broken'); "
            "Storage.prototype.setItem = () => {throw Error('storage denied')}"
        )
        bad_page = await bad.new_page()
        bad_page.on("pageerror", lambda error: errors.append(str(error)))
        await bad_page.goto(args.url)
        await expect(bad_page.locator("#syncTitle")).to_contain_text(
            "команд из таблицы"
        )
        await bad_page.click("#settingsBtn")
        await bad_page.click('#settingsForm button[type="submit"]')
        await expect(bad_page.locator("#syncTitle")).to_contain_text(
            "команд из таблицы"
        )
        assert not errors, errors
        passed("corrupt storage and denied persistence remain usable")
        await bad.close()

        template_mode = {"fail": True}
        missing = await browser.new_context()
        await missing.route(
            "https://docs.google.com/**/gviz/**", normal_sheets
        )

        async def template_route(route):
            if template_mode["fail"]:
                await route.fulfill(status=404, body="Not found")
            else:
                await route.continue_()

        await missing.route("**/assets/obs-template.json", template_route)
        missing_page = await missing.new_page()
        await missing_page.goto(args.url)
        await expect(missing_page.locator("#syncTitle")).to_contain_text(
            "команд из таблицы"
        )
        await missing_page.select_option("#matchSelect", options[0])
        await expect(missing_page.locator("#exportHint")).to_contain_text(
            "Не загружен шаблон"
        )
        assert await missing_page.locator("#downloadBtn").is_disabled()
        template_mode["fail"] = False
        await missing_page.click("#refreshBtn")
        await expect(missing_page.locator("#downloadBtn")).to_be_enabled()
        passed("missing template blocks export; refresh retries")
        await missing.close()

        injection = json.loads(sample_roster().split("(", 1)[1][:-2])
        payload = (
            '</option><img src=x onerror="window.injected=1">'
            '<script>window.injected=1</script>'
        )
        injection["table"]["rows"][0]["c"][3]["v"] = payload
        injection_body = (
            "google.visualization.Query.setResponse(" +
            json.dumps(injection) + ");"
        )
        hostile = await browser.new_context()

        async def hostile_sheets(route):
            await route.fulfill(
                status=200, content_type="application/javascript",
                body=schedule if "gid=1758299905" in route.request.url
                else injection_body,
            )

        await hostile.route(
            "https://docs.google.com/**/gviz/**", hostile_sheets
        )
        hostile_page = await hostile.new_page()
        await hostile_page.goto(args.url)
        await expect(hostile_page.locator("#syncTitle")).to_contain_text(
            "команд из таблицы"
        )
        assert await hostile_page.locator(
            "#teamGrid img, #teamGrid script"
        ).count() == 0
        assert not await hostile_page.evaluate("Boolean(window.injected)")
        assert payload in await hostile_page.locator(
            '[data-player="a"][data-slot="0"]'
        ).inner_text()
        passed("HTML and script payloads render as text")
        await hostile.close()

        old_day = await browser.new_context(timezone_id="Europe/Moscow")

        async def old_schedule(route):
            body = gviz([
                ["Матчи 1 января 2020"], ["№", "Начало МСК"],
                ["1", "16:00", "6yuBoJlbl", "HYPERSPIRIT", "B"],
            ]) if "gid=1758299905" in route.request.url else roster
            await route.fulfill(
                status=200, content_type="application/javascript", body=body
            )

        await old_day.route("https://docs.google.com/**/gviz/**", old_schedule)
        old_page = await old_day.new_page()
        await old_page.goto(args.url)
        await expect(old_page.locator("#errorBox")).to_contain_text(
            "Расписание в таблице на 01.01"
        )
        await expect(old_page.locator("#scheduleLabel")).to_have_text(
            "Матч по расписанию · 01.01"
        )
        passed("schedule sheet for another day is flagged")
        await old_day.close()
        await browser.close()

    print(
        f"{len(checks)} browser scenarios passed; Sheets responses: " +
        ("captured data" if args.roster else "synthetic fixtures"),
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--chromium", default="/usr/bin/chromium")
    parser.add_argument("--roster")
    parser.add_argument("--schedule")
    parser.add_argument("--artifacts", default="artifacts")
    asyncio.run(run(parser.parse_args()))
