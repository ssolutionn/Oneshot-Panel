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
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.async_api import async_playwright, expect

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qa_browser import gviz, sample_roster  # noqa: E402
from urllib.parse import parse_qs, urlsplit  # noqa: E402

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
    args.server = getattr(args, "server", False)
    args.chromium = getattr(args, "chromium", None)
    base = args.url.rstrip("/")
    output = Path(args.artifacts)
    output.mkdir(parents=True, exist_ok=True)
    frames, senders, errors, checks = {}, [], [], []
    asymmetric_view_pages = []
    vdo_errors = []  # exceptions inside VDO.Ninja's own iframe code: theirs, not ours
    wait = 30000 if args.real_vdo else 15000 if args.server else 8000
    if args.server:
        expect.set_options(timeout=15000)  # health has an 8 s network deadline before key generation
    # A page that watched a stream before it existed (the other captain came
    # later) gets it from the real VDO.Ninja only on a retry: a minute or more.
    join = 90000 if args.real_vdo else wait

    def passed(name):
        checks.append(name)
        print("PASS:", name, flush=True)

    # WebKit has no isolated world for Playwright's own helpers: the styles
    # it injects (screenshots, actionability) trip the page's style-src. Those
    # come from no file of ours; a style or script from our files still fails.
    # WebKit also reports inline styles of its own form controls (selects and
    # fields made by our scripts, blamed on that script) while no element of
    # the page has a style attribute: those are WebKit's, not ours.
    injected = []

    def csp_violation(source, directive, blocked, file, detail=""):
        if source["frame"] != source["page"].main_frame:
            return
        if args.browser == "webkit" and directive.startswith("style-src") and not file.startswith(base):
            injected.append(directive)
            return
        if args.browser == "webkit" and directive == "style-src-attr" and detail == "no inline style in the DOM":
            injected.append(directive)
            return
        errors.append(f"CSP {directive} {blocked} {file} {detail}".rstrip())

    async def hello(source, password, me, role, stream):
        frames[me] = (password, source["frame"], role, stream, source["page"])

    async def relay(source, password, me, data):
        if me not in frames:
            return
        _, _, role, stream, page = frames[me]
        senders.append(page)
        for other, (pw, frame, other_role, other_stream, target_page) in list(frames.items()):
            if other != me and pw == password and other_stream == stream and other_role != role:
                # Reproduce the real incident: this captain's dedicated viewer
                # receives nothing, while their push iframe's reverse channel
                # and the other captain's viewer remain healthy.
                if target_page in asymmetric_view_pages and other_role == "view":
                    continue
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
            # Where a violation comes from: line and column, and for inline
            # styles the page's elements that carry a style attribute.
            await context.add_init_script("""{
                const styled = () => {
                  const els = [...document.querySelectorAll('[style]')].filter(el => el.getAttribute('style').trim());
                  return els.length ? els.slice(0, 3).map(el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}` +
                    `[style="${el.getAttribute('style')}"]`).join(' ; ') : 'no inline style in the DOM';
                };
                addEventListener('securitypolicyviolation', event =>
                  window.reportCsp?.(event.violatedDirective, event.blockedURI,
                    `${event.sourceFile || ''}:${event.lineNumber}:${event.columnNumber}`,
                    event.violatedDirective === 'style-src-attr' ? styled() : ''));
            }""")
            if args.browser == "chromium":
                await context.grant_permissions(["clipboard-read", "clipboard-write"], origin=base)
            return context

        async def open_page(url=None, width=1280, height=900, context=None, clock=False, english=False):
            context = context or await open_context(width, height, english)
            page = await context.new_page()
            def page_error(error):
                message = f"{page.url[:60]}: {error}"
                # WebKit reports an aborted same-origin long-poll as CORS when
                # its page closes. Every live relay path is asserted above.
                if (args.server and args.browser == "webkit" and
                        "/api/veto-relay" in message and "access control checks" in message):
                    print("RELAY_PAGE_CLOSED", message, flush=True)
                    return
                (vdo_errors if "vdo.ninja" in (error.stack or "") else errors).append(message)
            page.on("pageerror", page_error)
            if args.server:
                page.on("request", lambda req: errors.append("Server room contacted VDO: " + req.url)
                        if "/veto.html" in page.url and req.url.startswith(("https://vdo.ninja/", "https://cdn-backup.vdo.ninja/")) else None)
            if args.server:
                page.on("requestfailed", lambda req: print("RELAY_REQUEST_FAILED", urlsplit(req.url).path, req.failure, flush=True)
                        if "/api/veto-relay" in req.url else None)
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
            if args.server:
                await admin.select_option("#vtTransport", "server")
            await admin.click("#vtForm button[type=submit]")
            await expect(admin.locator("#vtMsgA")).to_have_value(re.compile(re.escape(f"vs {b} ({fmt})")))
            message_a = await admin.locator("#vtMsgA").input_value()
            message_b = await admin.locator("#vtMsgB").input_value()
            link_s = await admin.locator("#vtWatch").get_attribute("href")
            return (re.search(r"https?://\S+", message_a).group(0),
                    re.search(r"https?://\S+", message_b).group(0), link_s)

        async def connection_diagnostics():
            # Never record link fragments, stream passwords, captain secrets,
            # nonce values or message bodies in the failure metadata.
            states = []
            for context in contexts:
                for page in context.pages:
                    if page.is_closed():
                        continue
                    try:
                        state = await page.evaluate("""async () => {
                          const m=await import('/veto-room.js'), room=m.decodeLink(location.hash);
                          if(!room)return null;
                          const saved=JSON.parse(localStorage.getItem('oneshot-veto-log:'+room.r)||'[]');
                          const locks=await navigator.locks?.query();
                          return {seat:room.me,transport:room.relay?'server':'vdo',
                            phase:document.querySelector('#vtStage')?.dataset.phase,
                            kicker:document.querySelector('#vtKicker')?.textContent,
                            error:document.querySelector('#vtError')?.textContent,
                            displayedMoves:document.querySelectorAll('#vtLog li').length,
                            savedMoves:saved.length,visibility:document.visibilityState,
                            online:[0,1].map(i=>document.querySelector('#vtTeam'+i)?.dataset.online),
                            locks:locks&&Object.fromEntries(['held','pending'].map(k=>[k,
                              locks[k].map(l=>({kind:l.name.startsWith('oneshot-veto-push:')?'publisher':'other',mode:l.mode}))])),
                            frames:[...document.querySelectorAll('iframe.vdo-frame')].map(f=>{
                              const u=new URL(f.src);return {host:u.hostname,role:u.searchParams.has('push')?'push':'view'};
                            })};
                        }""")
                        if state:
                            states.append(state)
                    except Exception as error:
                        states.append({"diagnosticError": type(error).__name__})
            (output / "connection-timeout.json").write_text(json.dumps(states, ensure_ascii=False, indent=2))
            print("CONNECTION_TIMEOUT", json.dumps(states, ensure_ascii=False), flush=True)

        async def coin_shown(*pages):
            try:
                for page in pages:
                    await expect(page.locator("#vtKicker")).to_contain_text("Монетка:", timeout=join)
            except Exception:
                await connection_diagnostics()
                raise

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

        async def recovery_scenarios(admin):
            try:
                # 7. A spectator forges a move and fakes the absent captain's presence.
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
                      if(room.relay) {
                        const protocol=await import('/assets/veto-relay-protocol.js');
                        const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
                        const point=await crypto.subtle.exportKey('jwk',pair.publicKey);
                        const packet=await protocol.signRelayPacket(pair.privateKey,[point.x,point.y],box);
                        packet.topic=room.fp[1];
                        const response=await fetch(room.relay,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(packet)});
                        if(response.status!==403)throw Error('Spectator write was not rejected');
                      }
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
                await expect(a.locator("#vtTeam1")).to_have_attribute("data-online", "yes", timeout=join)
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
                # Presence may still be the old page's (8 s): the real VDO.Ninja can
                # take a minute and more to take the reloaded stream back.
                await expect(second.locator("#vtError")).to_contain_text("подписал два разных хода", timeout=back)
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
                if not args.server:
                    publishers = 0
                    for _ in range(100):
                        publishers = sum([
                            await a1.locator('iframe.vdo-frame[src*="push="]').count(),
                            await a2.locator('iframe.vdo-frame[src*="push="]').count()
                        ])
                        if publishers == 1:
                            break
                        await a1.wait_for_timeout(100)
                    assert publishers == 1, f"captain tabs created {publishers} VDO publishers"
                await coin_shown(a1, b)
                if await b.locator("#vtActions button").count():
                    await b.get_by_role("button", name=re.compile("Первыми банят")).click()
                else:
                    await a1.get_by_role("button", name="Баним первыми").click()
                for page in (a1, a2, b):
                    await expect(page.locator("#vtStage")).to_have_attribute(
                        "data-phase", re.compile("mine|wait"), timeout=wait)
                    try:
                        await expect(page.locator("#vtLog li")).to_have_count(1, timeout=wait)
                    except Exception:
                        await connection_diagnostics()
                        raise
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
                if not args.server:
                    first_tab, standby = (a1, a2) if await a1.locator(
                        'iframe.vdo-frame[src*="push="]').count() else (a2, a1)
                    await first_tab.close()
                    await expect(standby.locator(
                        'iframe.vdo-frame[src*="push="]')).to_have_count(1, timeout=wait)
                passed("two tabs of one captain confirm together: one move counts, no conflict; standby takes over")
                for page in (a1, a2, b):
                    if not page.is_closed():
                        await page.close()
            except Exception:
                await connection_diagnostics()
                raise

        if getattr(args, "focus_recovery", False):
            admin = await open_page(base + "/veto.html")
            await recovery_scenarios(admin)
            assert not errors, errors
            await browser.close()
            print(f"veto recovery: {len(checks)} scenarios passed", flush=True)
            return

        # 1. Admin links.
        admin = await open_page(base + "/veto.html#new&a=UPGRADE&b=Lavked&f=BO3")
        await expect(admin.locator("#vtTeamA")).to_have_value("UPGRADE")
        await expect(admin.locator("#vtFormat")).to_have_value("BO3")
        if args.server:
            await admin.select_option("#vtTransport", "server")
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
        assert max(len(link_a), len(link_b), len(link_s)) < (400 if args.server else 150), (len(link_a), len(link_s))
        if args.server:
            assert "&via=server&relay=" in link_a and "&via=server&relay=" in public
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
        # Each team links to its HLTV page.
        await expect(cap_a.locator("#vtTeam0 .vt-hltv")).to_have_attribute("href", "https://www.hltv.org/team/13989/upgrade")
        await expect(cap_a.locator("#vtTeam1 .vt-hltv")).to_have_attribute("href", "https://www.hltv.org/team/12609/lavked")
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
        await expect(spectator.locator(".vt-progress-step")).to_have_count(7)
        assert await spectator.locator(".vt-progress-label").all_text_contents() == ["BAN", "BAN", "PICK", "PICK", "BAN", "BAN", "DECIDER"]
        await expect(spectator.locator('.vt-progress-step[data-state=done]')).to_have_count(7)
        # The moving backdrop: WebGL only on a real GPU; a software renderer
        # (CI, no hardware acceleration) gets the cheap moving artwork.
        software = await spectator.evaluate("""() => { const gl = document.createElement('canvas').getContext('webgl');
            const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
            return !gl || /swiftshader|llvmpipe|softpipe|software/i.test(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : ''); }""")
        await expect(spectator.locator(".vt-smoke-background canvas")).to_have_count(1)
        await expect(spectator.locator(".vt-smoke-background")).to_have_attribute(
            "data-renderer", "canvas" if software else re.compile("^(webgl|canvas)$"))
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
        payload = link_a.split("#v=")[1].split("&")[0]
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
        for page in (cap_a, cap_b, spectator, late, viewer, broken):
            await page.close()

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

        if getattr(args, "focus_match", False):
            assert not errors, errors
            await browser.close()
            print(f"veto matches: {len(checks)} scenarios passed", flush=True)
            return

        # 6. One captain's VDO viewer can fail while the reverse data path
        # remains healthy. Signed envelopes must still prove presence and carry
        # the veto; the broken viewer is retried independently.
        if not args.real_vdo and not args.server:
            link_a, link_b, _ = await make_links(admin, "Asymmetric A", "Asymmetric B", "BO1")
            a = await open_page()
            asymmetric_view_pages.append(a)
            await a.goto(link_a)
            b = await open_page(link_b)
            await expect(a.locator("#vtTeam1")).to_have_attribute("data-online", "yes", timeout=wait)
            await expect(b.locator("#vtTeam0")).to_have_attribute("data-online", "yes", timeout=wait)
            await coin_shown(a, b)
            first, _ = await winner_of(a, b)
            await first.get_by_role("button", name="Баним первыми").click()
            await expect(a.locator("#vtLog li")).to_have_count(1, timeout=wait)
            await expect(b.locator("#vtLog li")).to_have_count(1, timeout=wait)
            actor = a if await a.locator("#vtStage[data-phase=mine]").count() else b
            await actor.locator(".vt-map:not([disabled])").first.click()
            await actor.locator("#vtActions .vt-primary").click()
            await expect(a.locator("#vtLog li")).to_have_count(2, timeout=wait)
            await expect(b.locator("#vtLog li")).to_have_count(2, timeout=wait)
            await expect(a.locator("#vtReconnect")).to_be_visible()
            asymmetric_view_pages.remove(a)
            await a.locator("#vtReconnect").click()
            for page in (a, b):
                await page.close()
            passed("one dead VDO viewer recovers through signed reverse presence and manual reconnect")

        await recovery_scenarios(admin)

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
        if args.server:
            await english.select_option("#vtTransport", "server")
        await english.fill("#vtTeamA", "Alpha")
        await english.fill("#vtTeamB", "Bravo")
        await english.click("#vtForm button[type=submit]")
        await expect(english.locator("#vtMsgA")).to_have_value(re.compile(r"Captain of \*\*Alpha\*\*[\s\S]*No time limit"))
        room_page = await open_page(await english.locator("#vtWatch").get_attribute("href"), english=True)
        await expect(room_page.locator("#vtPrompt")).to_have_text("Waiting for the captains")
        await expect(room_page.locator("#vtFoot")).to_contain_text("Admin view")
        passed("English by default, the RU flag switches and is remembered; timer «No timer» in the message")
        await room_page.close()
        await english.close()

        # 12. «Call admin»: the admin's page rings, the public link does not.
        await admin.goto(base + "/veto.html")
        await admin.fill("#vtTeamA", "Omega")
        await admin.fill("#vtTeamB", "LPH")
        await admin.click("#vtForm button[type=submit]")
        await expect(admin.locator("#vtMsgA")).to_have_value(re.compile("Omega"))
        cap = await open_page(re.search(r"https?://\S+", await admin.locator("#vtMsgA").input_value()).group(0))
        boss = await open_page(await admin.locator("#vtWatch").get_attribute("href"))
        viewer = await open_page(re.search(r"https?://\S+", await admin.locator("#vtMsgS").input_value()).group(0))
        await expect(boss.locator("#vtHelp")).to_be_hidden()
        await expect(viewer.locator("#vtHelp")).to_be_hidden()
        await cap.click("#vtCallAdmin")
        await expect(cap.locator("#vtCallAdmin")).to_be_disabled()
        await expect(cap.locator("#vtCallState")).to_contain_text("Админ позван")
        await expect(boss.locator("#vtAlert")).to_be_visible(timeout=wait)
        await expect(boss.locator("#vtAlertText")).to_contain_text("Капитан Omega зовёт админа")
        await viewer.wait_for_timeout(3000)
        await expect(viewer.locator("#vtAlert")).to_be_hidden()
        await boss.click("#vtAlertOk")
        await expect(boss.locator("#vtAlert")).to_be_hidden()
        await boss.wait_for_timeout(3000)  # the call keeps riding the messages: it stays answered
        await expect(boss.locator("#vtAlert")).to_be_hidden()
        await expect(boss.locator("#vtTeam1 .vt-hltv")).to_have_attribute("href", "https://www.hltv.org/team/13279/lph")
        for page in (cap, boss, viewer):
            await page.close()
        passed("«Call admin» rings on the admin's page only, once answered stays quiet; HLTV links by team")

        # 13. The panel's «Вето» tab watches the captains' room as the admin:
        # presence, the coin, «Call admin», and every move lands in the
        # panel's own veto (HLTV text, OBS overlay).
        panel_ctx = await open_context(1440, 1000)
        await panel_ctx.unroute("https://docs.google.com/**/gviz/**")
        panel_schedule = gviz([["Group B1", day(0), "18:00", "UPGRADE", "Lavked"]],
                              ["Stage", "Date", "MSK (GMT +3)", "Team 1", "Team 2"])

        async def panel_sheets(route):
            gid = parse_qs(urlsplit(route.request.url).query).get("gid", [""])[0]
            body = (panel_schedule if gid == "815739139" else gviz([], ["Stage"]) if gid == "1212769715"
                    else sample_roster(("UPGRADE", "Lavked")))
            await route.fulfill(content_type="application/javascript", body=body)
        await panel_ctx.route("https://docs.google.com/**/gviz/**", panel_sheets)
        panel = await open_page(base + "/", context=panel_ctx)
        await expect(panel.locator("#syncTitle")).to_contain_text("команд из таблицы", timeout=wait)
        await panel.click("#vetoNavBtn")
        await expect(panel.locator("#cvLiveEmpty")).to_be_visible()
        await panel.fill("#cvSite", base + "/veto.html")
        await panel.locator("#cvSite").dispatch_event("change")
        await panel.select_option("#cvLang", "ru")
        if args.server:
            await panel.select_option("#cvTransport", "server")
        await panel.click("#cvCreate")
        await expect(panel.locator("#cvRoom")).to_be_visible()
        await expect(panel.locator("#cvLiveState")).to_have_text("капитанов нет")
        own_admin = await panel.input_value("#cvMsgO")
        await expect(panel.locator("#cvAdminOpen")).to_have_attribute("href", own_admin)
        link_a = re.search(r"https?://\S+", await panel.input_value("#cvMsgA")).group(0)
        link_b = re.search(r"https?://\S+", await panel.input_value("#cvMsgB")).group(0)
        assert link_a.startswith(base + "/veto.html#v="), link_a
        if not args.real_vdo and not args.server:
            asymmetric_view_pages.append(panel)
        cap_a = await open_page(link_a)
        if not args.real_vdo and not args.server:
            await expect(panel.locator("#cvTeam0")).to_have_attribute("data-online", "no")
            asymmetric_view_pages.remove(panel)
            await expect(panel.locator("#cvTeam0")).to_have_attribute("data-online", "yes", timeout=22000)
        else:
            await expect(panel.locator("#cvTeam0")).to_have_attribute("data-online", "yes", timeout=join)
        await expect(panel.locator("#cvTeam1")).to_have_attribute("data-online", "no")
        await expect(panel.locator("#cvLiveState")).to_have_text("здесь UPGRADE")
        cap_b = await open_page(link_b)
        await expect(cap_a.locator("#vtTeam1")).to_have_attribute("data-online", "yes", timeout=join)
        await expect(panel.locator("#cvTeam1")).to_have_attribute("data-online", "yes", timeout=join)
        await expect(panel.locator("#cvStage")).to_contain_text("Монетку выиграли", timeout=wait)
        await expect(panel.locator("#cvLiveState")).to_have_text("оба капитана здесь")
        # A captain calls: the panel rings (banner, tab badge) until «Понял».
        await cap_b.click("#vtCallAdmin")
        await expect(panel.locator("#cvAlert")).to_be_visible(timeout=wait)
        await expect(panel.locator("#cvAlertText")).to_contain_text("Капитан Lavked зовёт админа")
        await panel.click("#viewPrep")
        await expect(panel.locator("#vetoBadge")).to_be_visible()
        await panel.click("#vetoNavBtn")
        await panel.click("#cvAlertOk")
        await expect(panel.locator("#cvAlert")).to_be_hidden()
        await expect(panel.locator("#vetoBadge")).to_be_hidden()
        await panel.wait_for_timeout(3000)  # the call still rides the messages: answered stays answered
        await expect(panel.locator("#cvAlert")).to_be_hidden()
        boss = await open_page(own_admin)
        result = await play(cap_a, cap_b, [boss])
        await expect(panel.locator("#vetoOutput")).to_have_value(result, timeout=wait)
        await expect(panel.locator("#cvLiveState")).to_have_text("вето готово")
        await expect(panel.locator("#cvMoves li")).to_have_count(10)  # coin, order, six moves, two sides
        await expect(panel.locator("#cvClock")).to_contain_text("вето за")
        await expect(panel.locator("#cvCopyResult")).to_be_visible()
        await expect(panel.locator("#mapGrid [data-map].leftover")).to_have_count(1)  # after the 1.5 s decider delay
        await panel.screenshot(path=str(output / "panel-veto-live.png"), full_page=True)
        # ⇄ in the panel relabels the sides: the room's moves keep their real teams.
        await panel.click("#viewPrep")
        await panel.click("#swapBtn")
        await expect(panel.locator("#vetoOutput")).to_have_value(result)
        await panel.click("#swapBtn")
        await panel.click("#vetoNavBtn")
        # A manual edit stays while «Переносить» is off; on again, the room's veto is back.
        await panel.uncheck("#cvSync")
        await expect(panel.locator("#cvSyncNote")).to_contain_text("вручную")
        await panel.click("#vetoUndo")
        await panel.wait_for_timeout(3000)
        assert await panel.input_value("#vetoOutput") != result
        await panel.check("#cvSync")
        await expect(panel.locator("#vetoOutput")).to_have_value(result)
        # After a reload the room comes back from this browser at once.
        await panel.reload()
        await expect(panel.locator("#cvMoves li")).to_have_count(10)
        await expect(panel.locator("#vetoOutput")).to_have_value(result)
        # Rooms made here need no pasting; a room made elsewhere: any of its
        # links can be pasted (folded away), a captain's secret is dropped.
        assert not await panel.locator("#cvWatchMore").evaluate("el => el.open")
        await panel.click("#cvWatchMore > summary")
        await panel.fill("#cvWatchLink", link_a)
        await panel.click("#cvWatchGo")
        await expect(panel.locator("#cvWatchLink")).to_have_value("")
        assert not await panel.locator("#cvWatchMore").evaluate("el => el.open")
        await expect(panel.locator("#cvWatchStop")).to_be_visible()
        await expect(panel.locator("#cvAdminOpen")).to_have_attribute("href", own_admin)
        assert link_a.split("#v=")[1] not in await panel.evaluate("localStorage.getItem('oneshot-veto-watch')")
        await panel.click("#cvWatchStop")
        await expect(panel.locator("#cvWatchStop")).to_be_hidden()
        # «Сбросить вето» in the panel stops carrying the room's moves, so the
        # room does not bring the veto back, not even after a reload.
        await panel.evaluate("window.confirm = () => true")
        await panel.click("#vetoReset")
        await expect(panel.locator("#vetoOutput")).to_have_value("")
        await expect(panel.locator("#cvSync")).not_to_be_checked()
        await panel.reload()
        await expect(panel.locator("#cvMoves li")).to_have_count(10)
        await expect(panel.locator("#cvSync")).not_to_be_checked()
        await expect(panel.locator("#vetoOutput")).to_have_value("")
        # «Начать вето заново»: a new room and new links, the panel's veto from zero.
        await panel.check("#cvSync")
        await expect(panel.locator("#vetoOutput")).to_have_value(result)
        await panel.evaluate("window.confirm = () => true")
        await panel.click("#cvRestart")
        await expect(panel.locator("#cvMsgA")).not_to_have_value(re.compile(re.escape(link_a)))
        await expect(panel.locator("#cvMoves li")).to_have_count(0)
        await expect(panel.locator("#cvLiveState")).to_have_text("капитанов нет")
        await expect(panel.locator("#vetoOutput")).to_have_value("")
        await expect(panel.locator("#cvSync")).to_be_checked()
        new_a = re.search(r"https?://\S+", await panel.input_value("#cvMsgA")).group(0)
        assert new_a.startswith(base + "/veto.html#v=") and new_a != link_a, new_a
        await panel.wait_for_timeout(3000)  # the old room's captains are still sending: nothing comes back
        await expect(panel.locator("#vetoOutput")).to_have_value("")
        for page in (cap_a, cap_b, boss, panel):
            await page.close()
        passed("the panel's «Вето» tab watches the captains: presence, coin, call admin, reset and start over; moves land in the panel's veto")

        # 10. Hostile team names stay text.
        link_a, link_b, link_s = await make_links(admin, '<img src=x onerror=alert(1)>', 'A"B</h1>', "BO3")
        a = await open_page(link_a)
        await expect(a.locator("#vtTitle")).to_have_text('<img src=x onerror=alert(1)> vs A"B</h1>')
        assert await a.locator("#vtTitle img, .vt-team-name img").count() == 0
        await expect(a.locator(".vt-hltv").first).to_be_hidden()
        passed("HTML in team names is shown as text")

        await asyncio.sleep(0.5)
        assert not errors, errors
        await browser.close()
    if injected:
        print(f"note: {len(injected)} style-src reports from Playwright's own WebKit helpers ignored", flush=True)
    if vdo_errors:
        print(f"note: {len(vdo_errors)} exceptions inside VDO.Ninja's iframe ignored, e.g. {vdo_errors[0]}", flush=True)
    print(f"veto site: {len(checks)} scenarios passed", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--chromium", default=None)
    parser.add_argument("--browser", default="chromium", choices=["chromium", "webkit"])
    parser.add_argument("--server", action="store_true", help="use the actual local server relay; no VDO for rooms")
    parser.add_argument("--focus-recovery", action="store_true", help="run late join, re-sign/reload and multi-tab cases only")
    parser.add_argument("--focus-match", action="store_true", help="run links, full BO3/BO1/BO5, reload and mobile cases without the panel")
    parser.add_argument("--real-vdo", action="store_true", help="use the real VDO.Ninja (needs internet)")
    parser.add_argument("--artifacts", default="artifacts")
    asyncio.run(run(parser.parse_args()))
