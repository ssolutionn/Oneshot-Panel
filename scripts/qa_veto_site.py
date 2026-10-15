#!/usr/bin/env python3
"""Captains' veto site (veto.html): the admin makes links, two captains and
a spectator in separate browsers go through a whole BO3.

VDO.Ninja is replaced by a page that relays sendData through Python between
frames that share the derived password, so the three browsers only talk the
way the real site does (no shared BroadcastChannel across contexts).

    python3 scripts/qa_veto_site.py --url http://127.0.0.1:3000 --chromium /path/to/chrome
"""
import argparse
import asyncio
import re
from pathlib import Path

from playwright.async_api import async_playwright, expect

FAKE_VDO = """<!doctype html><script>
const q = new URLSearchParams(location.search);
const me = Math.random().toString(36).slice(2);
window.__deliver = data => parent.postMessage(data, '*');
window.vdoHello?.(q.get('password'), me);
addEventListener('message', e => {
  const d = e.data || {};
  if (d.sendData) window.vdoRelay?.(q.get('password'), me, d.sendData);
});
</script>"""


async def run(args):
    base = args.url.rstrip("/")
    output = Path(args.artifacts)
    output.mkdir(parents=True, exist_ok=True)
    frames, errors = {}, []

    async def hello(source, password, me):
        frames[me] = (password, source["frame"])

    async def relay(source, password, me, data):
        for other, (pw, frame) in list(frames.items()):
            if other != me and pw == password:
                try:
                    await frame.evaluate("d => window.__deliver(d)", {"dataReceived": data, "UUID": me})
                except Exception:
                    frames.pop(other, None)

    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=args.chromium, headless=True)

        async def open_context(width=1280, height=900):
            context = await browser.new_context(viewport={"width": width, "height": height}, locale="ru-RU")
            await context.route("https://vdo.ninja/**",
                                lambda route: route.fulfill(content_type="text/html", body=FAKE_VDO))
            await context.expose_binding("vdoHello", hello)
            await context.expose_binding("vdoRelay", relay)
            await context.expose_binding("reportCsp", lambda source, text: errors.append(f"CSP {text}")
                                         if source["frame"] == source["page"].main_frame else None)
            await context.add_init_script("""
                addEventListener('securitypolicyviolation', event =>
                  window.reportCsp?.(`${event.violatedDirective} ${event.blockedURI}`));""")
            await context.grant_permissions(["clipboard-read", "clipboard-write"], origin=base)
            page = await context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            return page

        admin = await open_context()
        await admin.goto(base + "/veto.html#new&a=UPGRADE&b=Lavked&f=BO3")
        await expect(admin.locator("#vtTeamA")).to_have_value("UPGRADE")
        await expect(admin.locator("#vtFormat")).to_have_value("BO3")
        await admin.click("#vtForm button[type=submit]")
        await expect(admin.locator("#vtLinks")).to_be_visible()
        message_a = await admin.locator("#vtMsgA").input_value()
        message_b = await admin.locator("#vtMsgB").input_value()
        link_s = await admin.locator("#vtWatch").get_attribute("href")
        link_a = re.search(r"https?://\S+", message_a).group(0)
        link_b = re.search(r"https?://\S+", message_b).group(0)
        assert "Капитан **UPGRADE**" in message_a and "Капитан **Lavked**" in message_b
        assert len({link_a, link_b, link_s}) == 3
        await admin.screenshot(path=str(output / "veto-site-admin.png"), full_page=True)
        await admin.reload()
        await expect(admin.locator("#vtMsgA")).to_have_value(message_a)
        print("PASS: admin makes three links; they survive a reload", flush=True)

        cap_a = await open_context()
        await cap_a.goto(link_a)
        await expect(cap_a.locator("#vtTitle")).to_have_text("UPGRADE vs Lavked")
        await expect(cap_a.locator("#vtPrompt")).to_have_text("Ждём капитана Lavked")
        await expect(cap_a.locator("#vtTeam0 .vt-you")).to_be_visible()
        spectator = await open_context()
        await spectator.goto(link_s)
        cap_b = await open_context(375, 800)
        await cap_b.goto(link_b)
        pages = {"a": cap_a, "b": cap_b, "s": spectator}
        for page in pages.values():
            await expect(page.locator("#vtTeam0")).to_have_attribute("data-online", "yes", timeout=8000)
            await expect(page.locator("#vtTeam1")).to_have_attribute("data-online", "yes", timeout=8000)
            await expect(page.locator("#vtKicker")).to_contain_text("Монетка:", timeout=8000)
        print("PASS: captains see each other, the coin flips for everyone", flush=True)

        winner = cap_a if await cap_a.locator("#vtActions button").count() else cap_b
        loser = cap_b if winner is cap_a else cap_a
        assert await loser.locator("#vtActions button").count() == 0
        assert await spectator.locator("#vtActions button").count() == 0
        await winner.get_by_role("button", name="Баним первыми").click()
        await expect(spectator.locator("#vtClock")).to_be_visible(timeout=8000)
        await expect(spectator.locator("#vtClockTime")).to_have_text(re.compile(r"^[45]:\d\d$"))

        moves = 0
        while moves < 20:
            await expect(spectator.locator("#vtLog li")).to_have_count(moves + 1, timeout=8000)
            if await spectator.locator("#vtStage[data-phase=done]").count():
                break
            for page in (cap_a, cap_b):
                await expect(page.locator("#vtLog li")).to_have_count(moves + 1, timeout=8000)
            actor = None
            for page in (cap_a, cap_b):
                if await page.locator("#vtStage[data-phase=mine]").count():
                    actor = page
            assert actor, "nobody has the move"
            other = cap_b if actor is cap_a else cap_a
            assert await other.locator(".vt-map:not([disabled])").count() == 0
            assert await spectator.locator(".vt-map:not([disabled])").count() == 0
            side = actor.get_by_role("button", name=re.compile("Начинаем за CT"))
            if await side.count():
                await side.click()
            else:
                await actor.locator(".vt-map:not([disabled])").first.click()
                await expect(actor.locator("#vtActions .vt-primary")).to_be_visible()
                if moves == 1:
                    await actor.screenshot(path=str(output / "veto-site-confirm.png"), full_page=True)
                await actor.locator("#vtActions .vt-primary").click()
            moves += 1

        result = await spectator.locator("#vtResultText").text_content()
        lines = result.splitlines()
        assert len(lines) == 7 and lines[-1].endswith("was left over"), result
        assert re.match(r"^(UPGRADE|Lavked) pick \w+ \((UPGRADE|Lavked) CT\)$", lines[2]), result
        for page in (cap_a, cap_b):
            await expect(page.locator("#vtResultText")).to_have_text(result, timeout=8000)
            await expect(page.locator("#vtStage")).to_have_attribute("data-phase", "done")
        await expect(spectator.locator(".vt-map[data-status=ban]")).to_have_count(4)
        await expect(spectator.locator(".vt-map[data-status=pick]")).to_have_count(2)
        await expect(spectator.locator(".vt-map[data-status=decider]")).to_have_count(1)
        print("PASS: a whole BO3 by turns; only the captain on the move can click", flush=True)

        await cap_a.reload()
        await expect(cap_a.locator("#vtResultText")).to_have_text(result)
        late = await open_context()
        await late.goto(link_s)
        await expect(late.locator("#vtResultText")).to_have_text(result, timeout=8000)
        print("PASS: a reload and a late spectator get the finished veto", flush=True)

        await cap_b.screenshot(path=str(output / "veto-site-mobile.png"), full_page=True)
        assert not await cap_b.evaluate("document.documentElement.scrollWidth > innerWidth")
        await spectator.screenshot(path=str(output / "veto-site-done.png"), full_page=True)
        broken = await open_context()
        await broken.goto(base + "/veto.html#v=broken")
        await expect(broken.locator("#vtError")).to_contain_text("повреждена")
        print("PASS: 375px without horizontal scroll; a broken link explains itself", flush=True)

        assert not errors, errors
        await browser.close()
    print("veto site: 5 scenarios passed", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--chromium", default="/usr/bin/chromium")
    parser.add_argument("--artifacts", default="artifacts")
    asyncio.run(run(parser.parse_args()))
