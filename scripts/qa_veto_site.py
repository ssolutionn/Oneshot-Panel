#!/usr/bin/env python3
"""Captains' veto site (veto.html) in separate browsers: the admin's links
(the match from the schedule sheet), the coin tossed in the room, whole BO3/BO1/BO5 vetoes, keyboard play, reloads and late viewers,
forged moves and fake presence from a spectator, a captain rewriting a move,
two tabs of one captain, the 5-minute clock, hostile team names, 375 px.

VDO.Ninja is replaced by a page that relays sendData through Python the way
VDO.Ninja routes data: a publisher (push=X) talks with the viewers of X and
nobody else. With --real-vdo the real VDO.Ninja is used instead.

    python3 scripts/qa_veto_site.py --url http://127.0.0.1:3000 --chromium /path/to/chrome
"""
import argparse
import asyncio
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.async_api import async_playwright, expect

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qa_browser import gviz  # noqa: E402

FAKE_VDO = """<!doctype html><script>
const q = new URLSearchParams(location.search);
const me = Math.random().toString(36).slice(2);
const role = q.get('push') ? 'push' : 'view', stream = q.get('push') || q.get('view');
window.__deliver = data => parent.postMessage(data, '*');
window.vdoHello?.(q.get('password'), me, role, stream);
addEventListener('message', e => {
  const d = e.data || {};
  if (d.sendData) window.vdoRelay?.(q.get('password'), me, d.sendData);
});
</script>"""

# Signs a move in the page with its own captain key, for scenarios that play
# a dishonest or slow captain (the page code stays untouched).
SIGN_IN_PAGE = """async ([kind, value, drop, shift]) => {
  const m = await import('/veto-room.js');
  const room = m.decodeLink(location.hash);
  const key = await m.captainKey(room);
  const name = 'oneshot-veto-log:' + room.r;
  let log = JSON.parse(localStorage.getItem(name) || '[]').slice(0, drop === null ? undefined : drop);
  log = await m.signMove(room, log, key, kind, value, Date.now() + shift);
  localStorage.setItem(name, JSON.stringify(log));
  return log.length;
}"""


async def run(args):
    # check.yml passes the panel QA's arguments: fill in this script's own.
    args.browser = getattr(args, "browser", "chromium")
    args.real_vdo = getattr(args, "real_vdo", False)
    args.chromium = getattr(args, "chromium", None)
    base = args.url.rstrip("/")
    output = Path(args.artifacts)
    output.mkdir(parents=True, exist_ok=True)
    frames, senders, errors, checks = {}, [], [], []
    wait = 30000 if args.real_vdo else 8000

    def passed(name):
        checks.append(name)
        print("PASS:", name, flush=True)

    # WebKit has no isolated world for Playwright's own helpers: the styles
    # it injects (screenshots, actionability) trip the page's style-src. Those
    # come from no file of ours; a style or script from our files still fails.
    injected = []

    def csp_violation(source, directive, blocked, file):
        if source["frame"] != source["page"].main_frame:
            return
        if args.browser == "webkit" and directive.startswith("style-src") and not file.startswith(base):
            injected.append(directive)
            return
        errors.append(f"CSP {directive} {blocked} {file}")

    async def hello(source, password, me, role, stream):
        frames[me] = (password, source["frame"], role, stream, source["page"])

    async def relay(source, password, me, data):
        if me not in frames:
            return
        _, _, role, stream, page = frames[me]
        senders.append(page)
        for other, (pw, frame, other_role, other_stream, _) in list(frames.items()):
            if other != me and pw == password and other_stream == stream and other_role != role:
                try:
                    await frame.evaluate("d => window.__deliver(d)", {"dataReceived": data, "UUID": me})
                except Exception:
                    frames.pop(other, None)

    async with async_playwright() as p:
        engine = getattr(p, args.browser)
        launch = {"headless": True}
        if args.chromium and args.browser == "chromium":
            launch["executable_path"] = args.chromium
        browser = await engine.launch(**launch)
        contexts = []

        # The organizer's schedule: today's and tomorrow's matches (MSK).
        msk = datetime.now(timezone.utc) + timedelta(hours=3)
        day = lambda shift: (msk + timedelta(days=shift)).strftime("%B ") + str((msk + timedelta(days=shift)).day)
        schedule = gviz([["Winners Match C4", day(0), "19:00", "PRIVATE (ex-RUBY)", "UPGRADE"],
                         ["Group B2", day(1), "16:00", "Rune Eaters", "HyperSpirit"]],
                        ["Stage", "Date", "MSK (GMT +3)", "Team 1", "Team 2"])

        async def open_context(width=1280, height=900, english=False):
            context = await browser.new_context(viewport={"width": width, "height": height}, locale="ru-RU")
            contexts.append(context)
            # The site is English by default; most scenarios read the Russian texts.
            if not english:
                await context.add_init_script("try { localStorage.setItem('oneshot-veto-lang', '\"ru\"') } catch {}")
            # The group stage tab has the matches, the playoffs tab is empty.
            await context.route("https://docs.google.com/**/gviz/**", lambda route: route.fulfill(
                content_type="application/javascript",
                body=gviz([], ["Stage"]) if "gid=1212769715" in route.request.url else schedule))
            if not args.real_vdo:
                await context.route("https://vdo.ninja/**",
                                    lambda route: route.fulfill(content_type="text/html", body=FAKE_VDO))
                await context.expose_binding("vdoHello", hello)
                await context.expose_binding("vdoRelay", relay)
            await context.expose_binding("reportCsp", csp_violation)
            await context.add_init_script("""
                addEventListener('securitypolicyviolation', event =>
                  window.reportCsp?.(event.violatedDirective, event.blockedURI, event.sourceFile || ''));""")
            if args.browser == "chromium":
                await context.grant_permissions(["clipboard-read", "clipboard-write"], origin=base)
            return context

        async def open_page(url=None, width=1280, height=900, context=None, clock=False, english=False):
            context = context or await open_context(width, height, english)
            page = await context.new_page()
            page.on("pageerror", lambda error: errors.append(f"{page.url[:60]}: {error}"))
            page.on("dialog", lambda dialog: errors.append(f"dialog {dialog.message}"))
            if clock:  # time flows; the scenario jumps it forward
                await page.clock.install()
            if url:
                await page.goto(url)
            return page

        async def make_links(admin, a, b, fmt):
            await admin.goto(base + "/veto.html")
            await admin.fill("#vtTeamA", a)
            await admin.fill("#vtTeamB", b)
            await admin.select_option("#vtFormat", fmt)
            await admin.click("#vtForm button[type=submit]")
            await expect(admin.locator("#vtMsgA")).to_have_value(re.compile(re.escape(f"vs {b} ({fmt})")))
            message_a = await admin.locator("#vtMsgA").input_value()
            message_b = await admin.locator("#vtMsgB").input_value()
            link_s = await admin.locator("#vtWatch").get_attribute("href")
            return (re.search(r"https?://\S+", message_a).group(0),
                    re.search(r"https?://\S+", message_b).group(0), link_s)

        async def coin_shown(*pages):
            for page in pages:
                await expect(page.locator("#vtKicker")).to_contain_text("Монетка:", timeout=wait)

        async def winner_of(cap_a, cap_b):
            await coin_shown(cap_a, cap_b)
            return (cap_a, cap_b) if await cap_a.locator("#vtActions button").count() else (cap_b, cap_a)

        async def play(cap_a, cap_b, watchers, keyboard=False, shot=None):
            first, _ = await winner_of(cap_a, cap_b)
            await first.get_by_role("button", name="Баним первыми").click()
            moves = 1
            while moves < 20:
                for page in (cap_a, cap_b, *watchers):
                    await expect(page.locator("#vtLog li")).to_have_count(moves, timeout=wait)
                if await cap_a.locator("#vtStage[data-phase=done]").count():
                    break
                actor = None
                for page in (cap_a, cap_b):
                    if await page.locator("#vtStage[data-phase=mine]").count():
                        actor = page
                assert actor, "nobody has the move"
                other = cap_b if actor is cap_a else cap_a
                assert await other.locator(".vt-map:not([disabled])").count() == 0
                for watcher in watchers:
                    assert await watcher.locator(".vt-map:not([disabled]), #vtActions button").count() == 0
                side = actor.get_by_role("button", name=re.compile("Начинаем за CT"))
                if await side.count():
                    await side.click()
                elif keyboard:
                    await actor.locator(".vt-map:not([disabled])").first.focus()
                    await actor.keyboard.press("Enter")
                    await expect(actor.locator("#vtActions .vt-primary")).to_be_focused()
                    await actor.keyboard.press("Enter")
                else:
                    await actor.locator(".vt-map:not([disabled])").first.click()
                    await expect(actor.locator("#vtActions .vt-primary")).to_be_visible()
                    if shot and moves == 2:
                        await actor.screenshot(path=str(output / shot), full_page=True)
                    await actor.locator("#vtActions .vt-primary").click()
                moves += 1
            # The HLTV text is ours: the admin's page has it, captains don't.
            await expect(watchers[0].locator("#vtResultText")).not_to_be_empty(timeout=wait)
            result = await watchers[0].locator("#vtResultText").text_content()
            for page in watchers[1:]:
                await expect(page.locator("#vtResultText")).to_have_text(result, timeout=wait)
            for page in (cap_a, cap_b):
                await expect(page.locator("#vtStage")).to_have_attribute("data-phase", "done", timeout=wait)
                await expect(page.locator("#vtResult")).to_be_hidden()
            return result

        # 1. Admin links.
        admin = await open_page(base + "/veto.html#new&a=UPGRADE&b=Lavked&f=BO3")
        await expect(admin.locator("#vtTeamA")).to_have_value("UPGRADE")
        await expect(admin.locator("#vtFormat")).to_have_value("BO3")
        await admin.click("#vtForm button[type=submit]")
        await expect(admin.locator("#vtLinks")).to_be_visible()
        message_a = await admin.locator("#vtMsgA").input_value()
        message_b = await admin.locator("#vtMsgB").input_value()
        link_s = await admin.locator("#vtWatch").get_attribute("href")  # the admin's link
        link_a = re.search(r"https?://\S+", message_a).group(0)
        link_b = re.search(r"https?://\S+", message_b).group(0)
        public = re.search(r"https?://\S+", await admin.locator("#vtMsgS").input_value()).group(0)
        assert await admin.locator("#vtMsgO").input_value() == link_s and public != link_s
        assert "Капитан **UPGRADE**" in message_a and "Капитан **Lavked**" in message_b
        assert "Монетку бросите на сайте" in message_a
        assert len({link_a, link_b, link_s, public}) == 4
        assert max(len(link_a), len(link_b), len(link_s)) < 150, (len(link_a), len(link_s))
        await admin.screenshot(path=str(output / "veto-site-admin.png"), full_page=True)
        await admin.reload()
        await expect(admin.locator("#vtMsgA")).to_have_value(message_a)
        await expect(admin.locator("#vtMade")).to_contain_text("Ссылки созданы в")
        # The match from the schedule sheet fills the teams.
        await admin.goto(base + "/veto.html")
        await expect(admin.locator("#vtMatch option")).to_have_count(3, timeout=wait)
        await expect(admin.locator("#vtMatch optgroup").first).to_have_attribute("label", re.compile("сегодня"))
        option = admin.locator("#vtMatch option", has_text="PRIVATE vs UPGRADE")
        await admin.select_option("#vtMatch", await option.get_attribute("value"))
        await expect(admin.locator("#vtTeamA")).to_have_value("PRIVATE")
        await expect(admin.locator("#vtTeamB")).to_have_value("UPGRADE")
        passed("admin makes three short links; they survive a reload; the match comes from the schedule")

        # 2. Whole BO3: coin for everyone, turns, sides, result, copy.
        cap_a = await open_page(link_a)
        await expect(cap_a.locator("#vtTitle")).to_have_text("UPGRADE vs Lavked")
        await expect(cap_a.locator("#vtPrompt")).to_have_text("Ждём капитана Lavked")
        await expect(cap_a.locator("#vtTeam0 .vt-you")).to_be_visible()
        spectator = await open_page(link_s)
        cap_b = await open_page(link_b, 375, 800)
        for page in (cap_a, cap_b, spectator):
            await expect(page.locator("#vtTeam0")).to_have_attribute("data-online", "yes", timeout=wait)
            await expect(page.locator("#vtTeam1")).to_have_attribute("data-online", "yes", timeout=wait)
        await coin_shown(cap_a, cap_b, spectator)
        assert await spectator.locator("#vtActions button").count() == 0
        result = await play(cap_a, cap_b, [spectator], shot="veto-site-confirm.png")
        lines = result.splitlines()
        assert len(lines) == 7 and lines[-1].endswith("was left over"), result
        assert re.match(r"^(UPGRADE|Lavked) pick \w+ \((UPGRADE|Lavked) CT\)$", lines[2]), result
        await expect(spectator.locator(".vt-map[data-status=ban]")).to_have_count(4)
        await expect(spectator.locator(".vt-map[data-status=pick]")).to_have_count(2)
        await expect(spectator.locator(".vt-map[data-status=decider]")).to_have_count(1)
        await expect(spectator.locator("#vtClock")).to_be_visible()
        await expect(spectator.locator("#vtClock .vt-clock-label")).to_have_text("вето за")
        # Cards in veto order: the six moves, then the decider on the right.
        statuses = await spectator.locator(".vt-map").evaluate_all("els => els.map(e => e.dataset.status)")
        assert statuses[-1] == "decider" and all(x in ("ban", "pick") for x in statuses[:6]), statuses
        maps = await spectator.locator(".vt-map").evaluate_all("els => els.map(e => e.dataset.map)")
        assert maps[0] == lines[0].split(" removed ")[1], (maps, lines)
        if args.browser == "chromium":
            await spectator.get_by_role("button", name="Скопировать для HLTV").click()
            assert await spectator.evaluate("navigator.clipboard.readText()") == result
        spectator_pages = {spectator}
        assert not [s for s in senders if s in spectator_pages], "spectators must only listen"
        passed("whole BO3 by turns; spectators only listen; HLTV text copies")

        # 3. Reloads and late viewers; the public spectator link has no HLTV text.
        await cap_a.reload()
        await expect(cap_a.locator("#vtStage")).to_have_attribute("data-phase", "done", timeout=wait)
        await expect(cap_a.locator("#vtResult")).to_be_hidden()
        late = await open_page(link_s)
        await expect(late.locator("#vtResultText")).to_have_text(result, timeout=wait)
        viewer = await open_page(public)
        await expect(viewer.locator(".vt-map[data-status=decider]")).to_have_count(1, timeout=wait)
        await expect(viewer.locator("#vtResult")).to_be_hidden()
        await expect(viewer.locator("#vtFoot")).to_contain_text("Режим зрителя")
        passed("a reload and late viewers get the finished veto; HLTV text only on the admin link")

        # 4. Layout and broken links.
        await cap_b.screenshot(path=str(output / "veto-site-mobile.png"), full_page=True)
        assert not await cap_b.evaluate("document.documentElement.scrollWidth > innerWidth")
        await spectator.screenshot(path=str(output / "veto-site-done.png"), full_page=True)
        broken = await open_page(base + "/veto.html#v=broken")
        await expect(broken.locator("#vtError")).to_contain_text("повреждена")
        payload = link_a.split("#v=")[1]
        # Flip one byte of the captain's secret (after version, flags, room
        # and two fingerprints): the key no longer fits the link.
        bad_key = await broken.evaluate("""p => {
            const b = Uint8Array.from(atob(p.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
            b[32] ^= 1;
            return btoa(String.fromCharCode(...b)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
        }""", payload)
        await broken.goto(base + "/veto.html#v=" + bad_key)
        await expect(broken.locator("#vtError")).to_contain_text("повреждена", timeout=wait)
        passed("375 px without horizontal scroll; broken link and broken key explain themselves")

        # 5. BO1 by keyboard, BO5 by mouse.
        for fmt, keyboard, maps in (("BO1", True, 7), ("BO5", False, 7)):
            link_a, link_b, link_s = await make_links(admin, "PRIVATE", "Honvéd", fmt)
            a, b, s = await open_page(link_a), await open_page(link_b), await open_page(link_s)
            result = await play(a, b, [s], keyboard=keyboard)
            lines = result.splitlines()
            assert len(lines) == maps, result
            if fmt == "BO1":
                assert all("removed" in line for line in lines[:6]) and lines[6].endswith("was left over")
                await expect(s.locator(".vt-map[data-status=decider] .vt-map-tag")).to_have_text("ИГРАЕМ")
            else:
                assert sum(" pick " in line for line in lines) == 4 and all("CT)" in line for line in lines if " pick " in line)
                await expect(s.locator(".vt-map[data-status=decider] .vt-map-tag")).to_have_text("DECIDER")
            for page in (a, b, s):
                await page.close()
        passed("BO1 by keyboard only (select with Enter, focus lands on confirm) and BO5 with four sides")

        # 6. A spectator forges a move and fakes the absent captain's presence.
        link_a, link_b, link_s = await make_links(admin, "Omega", "Fire Flux", "BO1")
        a = await open_page(link_a)
        s = await open_page(link_s)
        await expect(a.locator("#vtPrompt")).to_have_text("Ждём капитана Fire Flux")
        if not args.real_vdo:
            await s.evaluate("""async () => {
              const m = await import('/veto-room.js'), v = await import('/vdo.js');
              const room = m.decodeLink(location.hash), secrets = await m.roomSecrets(room);
              const forged = [{ k: 'order', v: '0', at: Date.now(), s: 'A'.repeat(86) }];
              const box = await v.seal(secrets.key, { t: 'log', from: 'b', log: forged });
              for (const frame of document.querySelectorAll('iframe.vdo-frame')) {
                frame.contentWindow.postMessage({ sendData: { oneshotVeto: box } }, '*');
              }
            }""")
            await a.wait_for_timeout(3000)
            await expect(a.locator("#vtTeam1")).to_have_attribute("data-online", "no")
            await expect(a.locator("#vtLog li")).to_have_count(0)
            await expect(a.locator("#vtKicker")).to_have_text("Монетка")
            passed("spectator cannot forge a move or fake the opponent being online")

        # 7. A captain re-signs a move after it was seen: the others keep it and warn.
        b = await open_page(link_b)
        first, second = await winner_of(a, b)
        await first.get_by_role("button", name="Баним первыми").click()
        for page in (a, b):
            await expect(page.locator("#vtLog li")).to_have_count(1, timeout=wait)
        await first.locator(".vt-map:not([disabled])").first.click()
        banned = await first.locator(".vt-map.is-selected").get_attribute("data-map")
        await first.locator("#vtActions .vt-primary").click()
        for page in (a, b, s):
            await expect(page.locator(f'.vt-map[data-map="{banned}"]')).to_have_attribute("data-status", "ban", timeout=wait)
        other_map = "Nuke" if banned != "Nuke" else "Mirage"
        # Keep the coin (3 moves) and the order, sign another ban.
        await first.evaluate(SIGN_IN_PAGE, ["ban", other_map, 4, 0])
        await first.reload()
        # The real VDO.Ninja may take a while to take the reloaded stream back.
        back = 90000 if args.real_vdo else wait
        first_team = "0" if first is a else "1"
        await expect(second.locator(f"#vtTeam{first_team}")).to_have_attribute("data-online", "yes", timeout=back)
        await expect(second.locator("#vtError")).to_contain_text("подписал два разных хода", timeout=wait)
        await expect(second.locator(f'.vt-map[data-map="{banned}"]')).to_have_attribute("data-status", "ban")
        await expect(second.locator(f'.vt-map[data-map="{other_map}"]')).to_have_attribute("data-status", "open")
        passed("a re-signed move is not taken back: the opponent keeps the first and sees a warning")
        for page in (a, b, s):
            await page.close()

        # 8. Two tabs of one captain confirm at once: one move counts, no conflict.
        link_a, link_b, link_s = await make_links(admin, "Rune Eaters", "PCIFIC", "BO3")
        ctx = await open_context()
        a1 = await open_page(link_a, context=ctx)
        a2 = await open_page(link_a, context=ctx)
        b = await open_page(link_b)
        await coin_shown(a1, b)
        if await b.locator("#vtActions button").count():
            await b.get_by_role("button", name=re.compile("Первыми банят")).click()
        else:
            await a1.get_by_role("button", name="Баним первыми").click()
        for page in (a1, a2, b):
            await expect(page.locator("#vtStage")).to_have_attribute(
                "data-phase", re.compile("mine|wait"), timeout=wait)
            await expect(page.locator("#vtLog li")).to_have_count(1, timeout=wait)
        await expect(a1.locator("#vtStage")).to_have_attribute("data-phase", "mine")
        await expect(a2.locator("#vtStage")).to_have_attribute("data-phase", "mine")
        enabled = a1.locator(".vt-map:not([disabled])")
        await enabled.nth(0).click()
        await a2.locator(".vt-map:not([disabled])").nth(1).click()
        await expect(a1.locator("#vtActions .vt-primary")).to_be_visible()
        await expect(a2.locator("#vtActions .vt-primary")).to_be_visible()
        # Both confirm within the same moment (scheduled in each page).
        at = await a1.evaluate("Date.now() + 400")
        await asyncio.gather(*(page.evaluate("""t => setTimeout(() =>
            document.querySelector('#vtActions .vt-primary')?.click(), t - Date.now())""", at)
            for page in (a1, a2)))
        for page in (a1, a2, b):
            await expect(page.locator("#vtLog li")).to_have_count(2, timeout=wait)
        await b.wait_for_timeout(3000)
        await expect(b.locator("#vtError")).to_be_hidden()
        texts = [await page.locator("#vtLog").inner_text() for page in (a1, a2, b)]
        assert len(set(texts)) == 1, texts
        passed("two tabs of one captain confirm together: one move counts, no conflict")
        for page in (a1, a2, b):
            await page.close()

        # 9. The 5-minute clock runs out (both clocks jump 5 min 10 s after the order).
        link_a, link_b, _ = await make_links(admin, "Walczaki", "Johnny Speeds", "BO1")
        a, b = await open_page(link_a, clock=True), await open_page(link_b, clock=True)
        first, _ = await winner_of(a, b)
        await first.get_by_role("button", name="Баним первыми").click()
        for page in (a, b):
            await expect(page.locator("#vtLog li")).to_have_count(1, timeout=wait)
        for page in (a, b):
            await page.clock.fast_forward("05:10")
        await expect(first.locator("#vtClock .vt-clock-label")).to_have_text("время вышло", timeout=wait)
        await expect(first.locator("#vtClock")).to_have_attribute("data-state", "over")
        await expect(first.locator("#vtClockTime")).to_have_text("0:00")
        other = b if first is a else a
        await expect(other.locator("#vtClock .vt-clock-label")).to_have_text("время вышло", timeout=wait)
        passed("the 5-minute clock shows «время вышло» on every page; play goes on")
        for page in (a, b):
            await page.close()

        # 11. English by default; the flag switches to Russian and stays.
        english = await open_page(base + "/veto.html", english=True)
        await expect(english.locator("html")).to_have_attribute("lang", "en")
        await expect(english.locator("#vtCreateHeading")).to_have_text("New captains' veto")
        await expect(english.locator('[data-lang="en"]')).to_have_attribute("aria-pressed", "true")
        await english.click('[data-lang="ru"]')
        await expect(english.locator("#vtCreateHeading")).to_have_text("Новое вето для капитанов")
        await english.reload()
        await expect(english.locator("#vtCreateHeading")).to_have_text("Новое вето для капитанов")
        await english.click('[data-lang="en"]')
        await english.select_option("#vtTimer", "0")
        await english.fill("#vtTeamA", "Alpha")
        await english.fill("#vtTeamB", "Bravo")
        await english.click("#vtForm button[type=submit]")
        await expect(english.locator("#vtMsgA")).to_have_value(re.compile(r"Captain of \*\*Alpha\*\*[\s\S]*No time limit"))
        room_page = await open_page(await english.locator("#vtWatch").get_attribute("href"), english=True)
        await expect(room_page.locator("#vtPrompt")).to_have_text("Waiting for the captains")
        await expect(room_page.locator("#vtFoot")).to_contain_text("Admin view")
        passed("English by default, the RU flag switches and is remembered; timer «No timer» in the message")

        # 10. Hostile team names stay text.
        link_a, link_b, link_s = await make_links(admin, '<img src=x onerror=alert(1)>', 'A"B</h1>', "BO3")
        a = await open_page(link_a)
        await expect(a.locator("#vtTitle")).to_have_text('<img src=x onerror=alert(1)> vs A"B</h1>')
        assert await a.locator("#vtTitle img, .vt-team-name img").count() == 0
        passed("HTML in team names is shown as text")

        await asyncio.sleep(0.5)
        assert not errors, errors
        await browser.close()
    if injected:
        print(f"note: {len(injected)} style-src reports from Playwright's own WebKit helpers ignored", flush=True)
    print(f"veto site: {len(checks)} scenarios passed", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--chromium", default=None)
    parser.add_argument("--browser", default="chromium", choices=["chromium", "webkit"])
    parser.add_argument("--real-vdo", action="store_true", help="use the real VDO.Ninja (needs internet)")
    parser.add_argument("--artifacts", default="artifacts")
    asyncio.run(run(parser.parse_args()))
