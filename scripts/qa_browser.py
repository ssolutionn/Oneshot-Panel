"""Regression checks; explicit Sheets fixtures, not direct live-browser evidence."""
import argparse
import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.async_api import async_playwright, expect


def gviz(rows, labels=None):
    data = {
        "status": "ok",
        "table": {
            "rows": [{"c": [{"v": cell} for cell in row]} for row in rows]
        },
    }
    if labels:  # headers=1: the header row comes back as column labels
        data["table"]["cols"] = [{"label": label} for label in labels]
    return "google.visualization.Query.setResponse(" + json.dumps(data) + ");"


def with_row_above(text):
    """Same Sheets response with one more match inserted at the top."""
    begin, end = text.index("{"), text.rindex("}") + 1
    data = json.loads(text[begin:end])
    data["table"]["rows"].insert(0, {"c": [
        {"v": ""}, {"v": "10:00"}, {"v": "HYPERSPIRIT"},
        {"v": "6yuBoJlbl"}, {"v": "Шоуматч"}
    ]})
    return text[:begin] + json.dumps(data, ensure_ascii=False) + text[end:]


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
            "delay": False, "new_source": False, "row_above": False,
        }
        gate = asyncio.Event()
        errors = []

        async def sheets(route):
            params = parse_qs(urlsplit(route.request.url).query)
            is_schedule = params.get("gid") == ["815739139"]
            if (modes["delay"] and
                    "/1e__ijBjufD19SWBkSJL177vmmfMh2tdykYQHAS06S8I/"
                    in route.request.url):
                await gate.wait()
            status = 503 if (
                modes["schedule_error"] if is_schedule
                else modes["roster_error"]
            ) else 200
            if is_schedule:
                body = (with_row_above(schedule) if modes["row_above"]
                        else schedule)
            elif (modes["new_source"] and
                    "/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/" in route.request.url):
                body = sample_roster(("New Team A", "New Team B"))
            else:
                body = roster
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
        assert await page.title() == "Oneshot Panel"
        # The OS interface font, not a missing web font falling back to Arial.
        assert (await page.evaluate(
            "getComputedStyle(document.body).fontFamily"
        )).startswith("system-ui")
        # The public header link opens the organizer's sheet, not the rosters.
        source_link = await page.get_attribute("#sidebarSource", "href")
        assert "1GtwcpVnyxY1YOs6ZTrXwJr5mjZqI0QxjLSKjimn9G2o" in source_link
        assert "#gid=815739139" in source_link
        passed("load rosters, schedule and OBS template")

        await page.wait_for_load_state("networkidle")
        assert await page.evaluate(
            "[...document.images].filter(i => i.complete && "
            "!i.naturalWidth).length"
        ) == 0
        assert await page.locator("#mapGrid img").count() == 7
        passed("all seven local map images load without broken icons")

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
        await select.focus()
        await select.select_option(replacement[0])
        assert await page.evaluate(
            "document.activeElement?.matches('[data-player=\"a\"][data-slot=\"0\"]')"
        )
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
            "16-00_Группа-B_6yuBoJlbl_vs_HYPERSPIRIT.json"
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
            items = scene["settings"]["items"]
            item = next(it for it in items if it["name"].startswith("CAM "))
            assert item["rot"] == 0
            assert item["bounds"] == {"x": 1920, "y": 1080}
            assert by_id[item["source_uuid"]]["settings"]["width"] == 1920
            assert "&transparent" in by_id[item["source_uuid"]]["settings"]["url"]
            # The player card is right under the camera, served by this site.
            card = items[items.index(item) - 1]
            assert card["name"].startswith(f"CARD {i:02d} | ")
            assert by_id[card["source_uuid"]]["settings"]["url"].startswith(
                args.url.rstrip("/") + "/card.html?team=")
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

        match_value = await page.input_value("#matchSelect")
        modes["row_above"] = True
        await page.click("#refreshBtn")
        await expect(page.locator("#refreshBtn")).to_be_enabled()
        assert await page.locator(
            "#matchSelect option", has_text="10:00 · Шоуматч"
        ).count() == 1
        assert await page.input_value("#matchSelect") == match_value
        assert await page.input_value("#vetoOutput") == expected
        modes["row_above"] = False
        passed("row inserted above the match keeps the veto after refresh")
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
        # Teams without a logo keep the A/B badge.
        await expect(page.locator(".team-letter")).to_have_text(["A", "B"])
        assert await page.locator(".team-logo").count() == 0
        passed("source change ignores late old data")
        assert not errors, errors
        await context.close()

        async def normal_sheets(route):
            await route.fulfill(
                status=200, content_type="application/javascript",
                body=schedule if "gid=815739139" in route.request.url
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
                body=schedule if "gid=815739139" in route.request.url
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
        # Only team logos from the panel's own folder may be images here.
        assert await hostile_page.evaluate(
            "[...document.querySelectorAll('#teamGrid img')].every(i =>"
            " new URL(i.src).pathname.startsWith('/assets/teams/'))"
        )
        assert await hostile_page.locator("#teamGrid script").count() == 0
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
            ]) if "gid=815739139" in route.request.url else roster
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

        organizer = await browser.new_context(
            viewport={"width": 1440, "height": 1000},
            locale="ru-RU", timezone_id="Europe/Moscow"
        )
        moscow = datetime.now(timezone(timedelta(hours=3)))
        day = lambda shift: (moscow + timedelta(days=shift)).strftime("%B %-d")
        label = lambda shift: (moscow + timedelta(days=shift)).strftime("%d.%m")

        async def organizer_schedule(route):
            body = gviz([
                ["1", "Opening Match A1", day(-1), "10:00", "13:00", "A", "",
                 "6yuBoJlbl", "2", "vs", "0", "HYPERSPIRIT"],
                ["2", "Opening Match B2", day(0), "13:00", "16:00", "A", "",
                 "6yuBoJlbl", "", "vs", "", "HYPERSPIRIT"],
                ["3", "Losers Match B3", day(1), "13:00", "16:00", "A", "",
                 "HYPERSPIRIT (ex-HS)", "", "vs", "", "6yuBoJlbl"],
                ["4", "Winners Match B4", day(1), "16:00", "19:00", "A", "",
                 "", "", "vs", "", ""],
            ], ["Match #", "Stage", "Date", "GMT", "MSK (GMT +3)", "Stream",
                "", "Team 1", "Score", "", "", "Team 2"]
            ) if "gid=815739139" in route.request.url else roster
            await route.fulfill(
                status=200, content_type="application/javascript", body=body
            )

        await organizer.route(
            "https://docs.google.com/**/gviz/**", organizer_schedule
        )
        organizer_page = await organizer.new_page()
        await organizer_page.goto(args.url)
        await expect(organizer_page.locator("#syncTitle")).to_contain_text(
            "команд из таблицы"
        )
        assert await organizer_page.title() == "Oneshot Panel"
        groups = await organizer_page.locator(
            "#matchSelect optgroup"
        ).evaluate_all("els => els.map(g => [g.label, g.children.length])")
        assert groups == [
            [f"{label(0)} · сегодня", 1], [f"{label(1)} · завтра", 1]
        ], groups
        tomorrow = await organizer_page.locator(
            "#matchSelect optgroup:last-child option"
        ).text_content()
        assert tomorrow == "16:00 · Группа B · HYPERSPIRIT vs 6yuBoJlbl", tomorrow
        await organizer_page.select_option(
            "#matchSelect", label="16:00 · Группа B · HYPERSPIRIT vs 6yuBoJlbl"
        )
        assert await organizer_page.input_value("#matchStage") == "Группа B"
        await expect(organizer_page.locator(".team-logo img")).to_have_count(2)
        assert await organizer_page.locator(".team-logo img").evaluate_all(
            "imgs => imgs.map(i => i.complete && i.naturalWidth > 0 &&"
            " i.closest('.team-card').querySelector('select').value)"
        ) == ["HYPERSPIRIT", "6yuBoJlbl"]
        await organizer_page.locator(".team-grid").screenshot(
            path=str(artifacts / "team-logos.png")
        )
        passed("organizer schedule by date; logos on team cards")
        await organizer.close()

        night = await browser.new_context(
            viewport={"width": 1440, "height": 1000}, color_scheme="dark"
        )
        await night.route("https://docs.google.com/**/gviz/**", sheets)
        night_page = await night.new_page()
        night_page.on("pageerror", lambda error: errors.append(str(error)))
        await night_page.goto(args.url)
        await expect(night_page.locator("#syncTitle")).to_contain_text(
            "команд из таблицы"
        )
        toggle = night_page.locator("#themeToggle")
        background = "getComputedStyle(document.body).backgroundColor"
        card = ("getComputedStyle(document.querySelector('.team-card'))"
                ".backgroundColor")
        await expect(toggle).to_have_text("☾ Ночь")
        await expect(toggle).to_have_attribute("aria-pressed", "true")
        await expect(night_page.locator(".logo-night")).to_be_visible()
        await expect(night_page.locator(".logo-day")).to_be_hidden()
        assert await night_page.evaluate(background) == "rgb(16, 16, 18)"
        assert await night_page.evaluate(card) == "rgb(26, 26, 29)"
        # Windows paints select lists from option styles: dark list, light text.
        assert await night_page.evaluate(
            "[...document.querySelectorAll('select option')].every(o => {"
            " const s = getComputedStyle(o);"
            " return s.backgroundColor === 'rgb(26, 26, 29)' &&"
            " s.color === 'rgb(236, 236, 236)'; })"
        )
        await night_page.select_option("#matchSelect", options[0])
        await night_page.screenshot(
            path=str(artifacts / "desktop-night.png"), full_page=True
        )
        await night_page.set_viewport_size({"width": 375, "height": 812})
        assert await night_page.evaluate(
            "document.documentElement.scrollWidth <= window.innerWidth"
        )
        await night_page.screenshot(
            path=str(artifacts / "mobile-night.png"), full_page=True
        )
        await night_page.set_viewport_size({"width": 1440, "height": 1000})
        await toggle.click()
        await expect(toggle).to_have_attribute("aria-pressed", "false")
        await expect(night_page.locator(".logo-day")).to_be_visible()
        await expect(night_page.locator(".logo-night")).to_be_hidden()
        assert await night_page.evaluate(
            "document.querySelector('meta[name=theme-color]').content"
        ) == "#ffffff"
        assert await night_page.evaluate(background) == "rgb(245, 245, 245)"
        assert await night_page.evaluate(card) == "rgb(255, 255, 255)"
        await night_page.reload()
        await expect(toggle).to_have_attribute("aria-pressed", "false")
        assert await night_page.evaluate(
            "document.documentElement.dataset.mode"
        ) == "light"
        assert await night_page.evaluate(background) == "rgb(245, 245, 245)"
        await toggle.click()
        assert await night_page.evaluate(card) == "rgb(26, 26, 29)"
        await toggle.focus()
        await night_page.keyboard.press("Enter")
        await expect(toggle).to_have_attribute("aria-pressed", "false")
        await night.close()
        assert not errors, errors
        passed("night mode follows the system; toggle persists, swaps the logo")

        cards = await browser.new_context(viewport={"width": 1920, "height": 1080})
        card_page = await cards.new_page()
        card_errors = []
        card_page.on("console", lambda m: m.type == "error" and
                     ("Content Security Policy" in m.text or "Refused to" in m.text)
                     and card_errors.append(m.text))
        card_page.on("pageerror", lambda e: card_errors.append(str(e)))
        stand_in = (Path(__file__).resolve().parent.parent /
                    "assets" / "favicon.png").read_bytes()

        async def photo_list(route):
            await route.fulfill(content_type="application/json", body=json.dumps({
                "players": [{
                    "team": "Nuclear TigeRES", "nick": "senka", "role": "1",
                    "hltv": "https://www.hltv.org/player/22878/senka",
                    "photo": "https://img-cdn.hltv.org/playerbodyshot/x.png?s=1",
                    "file": "qa-senka.png",
                }, {
                    "team": "Honvéd", "nick": "es0r7", "aliases": ["esor"],
                    "role": "4", "hltv": "https://www.hltv.org/player/23263/esor",
                    "photo": "https://img-cdn.hltv.org/playerbodyshot/y.png?s=1",
                    "file": "qa-esor.png",
                }]}))
        await card_page.route("**/assets/players/players.json", photo_list)
        await card_page.route("**/assets/players/qa-*.png", lambda route:
                              route.fulfill(content_type="image/png", body=stand_in))
        base = args.url.rstrip("/")

        async def open_card(query):
            await card_page.goto(f"{base}/card.html?{query}")
            await card_page.wait_for_selector("body[data-ready=true]")
            return await card_page.evaluate("document.body.dataset.photo")

        # Case and spacing do not matter; the HLTV spelling of a nick also works.
        assert await open_card("team=nuclear%20tigeres&nick=SENKA") == "qa-senka.png"
        await expect(card_page.locator("#cardPhoto")).to_be_visible()
        await expect(card_page.locator("#cardLogo")).to_be_visible()
        await expect(card_page.locator("#cardEmblem")).to_be_hidden()
        await expect(card_page.locator("#cardNick")).to_have_text("SENKA")
        assert await open_card("team=Honv%C3%A9d&nick=esor") == "qa-esor.png"
        # No photo: the team logo stands in; no logo either: just the text.
        assert await open_card("team=Lavked&nick=jakekeS") == "none"
        await expect(card_page.locator("#cardEmblem")).to_be_visible()
        assert await open_card("team=Nobody&nick=%3Cb%3Ex%3C%2Fb%3E") == "none"
        await expect(card_page.locator("#cardEmblem")).to_be_hidden()
        await expect(card_page.locator("#cardLogo")).to_be_hidden()
        await expect(card_page.locator("#cardNick")).to_have_text("<b>x</b>")
        await open_card("team=Lavked&nick=" + "W" * 24)
        size = await card_page.evaluate(
            "parseFloat(getComputedStyle(document.getElementById('cardNick')).fontSize)")
        assert size < 224
        assert await card_page.evaluate(
            "document.getElementById('cardNick').getBoundingClientRect().right") <= 1760
        # A known nickname from a different team is never a photo match.
        assert await open_card("team=Lavked&nick=senka") == "none"
        await expect(card_page.locator("#cardPhoto")).to_be_hidden()
        await expect(card_page.locator("#tournamentLogo")).to_be_visible()
        await expect(card_page.locator("#cardBackground")).to_be_visible()
        assert await card_page.locator("body").get_attribute("data-layout") == "no-photo"
        # A Матрица tile: the whole card scales into 480×270.
        await card_page.set_viewport_size({"width": 480, "height": 270})
        await open_card("team=Lavked&nick=jakekeS")
        box = await card_page.locator("#card").bounding_box()
        assert abs(box["width"] - 480) < 1 and abs(box["height"] - 270) < 1
        assert box["x"] >= -0.5 and box["y"] >= -0.5
        await cards.close()
        assert not card_errors, card_errors
        passed("player card: photo, alias, logo fallback, long nick, 480×270 tile")
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
