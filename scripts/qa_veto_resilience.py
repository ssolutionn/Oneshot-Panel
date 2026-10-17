#!/usr/bin/env python3
"""Slow VDO signalling, publisher ownership, and a bounded HTTP sender queue."""
import argparse
import asyncio
import json
import time

from playwright.async_api import async_playwright, expect
from qa_veto_site import FAKE_VDO


async def slow_vdo(browser, base):
    frames = {}

    async def hello(source, password, identity, role, stream):
        frames[identity] = (password, source["frame"], role, stream, time.monotonic())

    async def relay(source, password, identity, data):
        if identity not in frames:
            return
        _, _, role, stream, created = frames[identity]
        for other, (pw, frame, other_role, other_stream, born) in list(frames.items()):
            if other == identity or pw != password or stream != other_stream or role == other_role:
                continue
            # A healthy viewer needs 20 seconds of uninterrupted signalling.
            if time.monotonic() - (created if role == "view" else born) < 20:
                continue
            try:
                await frame.evaluate("d => window.__deliver(d)", {"dataReceived": data, "UUID": identity})
            except Exception:
                if frame.is_detached():
                    frames.pop(other, None)
                else:
                    raise

    contexts = []
    pages = []
    try:
        for _ in range(2):
            context = await browser.new_context(reduced_motion="reduce")
            contexts.append(context)
            await context.route("https://docs.google.com/**", lambda r: r.abort())
            await context.route("https://vdo.ninja/**", lambda r: r.fulfill(content_type="text/html", body=FAKE_VDO))
            await context.expose_binding("vdoHello", hello)
            await context.expose_binding("vdoRelay", relay)
        setup = await contexts[0].new_page()
        await setup.goto(base + "/veto.html")
        links = await setup.evaluate("""async () => {
          const m = await import('/veto-room.js');
          return (await m.createRoom(location.href, ['Slow A', 'Slow B'], 'BO1')).links;
        }""")
        await setup.close()
        for context, link in [(contexts[0], links["a"]), (contexts[0], links["a"]), (contexts[1], links["b"])]:
            page = await context.new_page()
            pages.append(page)
            await page.goto(link)
        for page in pages:
            await expect(page.locator("#vtKicker")).to_contain_text("Coin:", timeout=40000)
        a1, a2, _ = pages
        publisher = 'iframe.vdo-frame[src*="push="]'
        assert await a1.locator(publisher).count() + await a2.locator(publisher).count() == 1
        leader, standby = (a1, a2) if await a1.locator(publisher).count() else (a2, a1)
        await standby.click("#vtReconnect")
        assert await standby.locator(publisher).count() == 0
        old_push = await leader.locator(publisher).element_handle()
        await leader.click("#vtReconnect")
        assert not await old_push.evaluate("frame => frame.isConnected")
        await expect(leader.locator(publisher)).to_have_count(1)
        await leader.close()
        await expect(standby.locator(publisher)).to_have_count(1)
        print("PASS: 20-second VDO signalling survives; reconnect restarts the publisher without stealing its lock; standby takes over", flush=True)
    finally:
        for context in contexts:
            await context.close()


async def stalled_sender(browser, base):
    context = await browser.new_context(reduced_motion="reduce")
    gate = asyncio.Event()
    lengths = []
    try:
        await context.route("https://docs.google.com/**", lambda r: r.abort())
        page = await context.new_page()
        helper = await context.new_page()
        await helper.goto(base + "/veto.html")
        links = await helper.evaluate("""async () => {
          const m = await import('/veto-room.js');
          return (await m.createRoom(location.href, ['Queue A','Queue B'], 'BO1', 5,
            location.origin+'/api/veto-relay')).links;
        }""")
        started = asyncio.Event()

        async def post(route):
            if route.request.method != "POST":
                return await route.continue_()
            packet = json.loads(route.request.post_data)
            size = await helper.evaluate("""async ([link, box]) => {
              const m = await import('/veto-room.js'), v = await import('/vdo.js');
              const room = m.decodeLink(new URL(link).hash);
              return (await v.unseal((await m.roomSecrets(room)).key, box)).log.length;
            }""", [links["a"], packet["box"]])
            lengths.append(size)
            started.set()
            await gate.wait()
            await route.continue_()

        await page.route("**/api/veto-relay", post)
        await page.goto(links["a"])
        await asyncio.wait_for(started.wait(), 10)
        await asyncio.sleep(5.3)
        await helper.evaluate("""async link => {
          const m=await import('/veto-room.js'), room=m.decodeLink(new URL(link).hash);
          const key=await m.captainKey(room), nonce=m.coinNonce();
          const log=await m.signMove(room,[],key,'commit',await m.coinCommit(room,nonce));
          localStorage.setItem('oneshot-veto-log:'+room.r, JSON.stringify(log));
        }""", links["a"])
        await expect(page.locator("#vtPrompt")).to_have_text("Tossing…")
        gate.set()
        for _ in range(100):
            if 1 in lengths:
                break
            await asyncio.sleep(.05)
        assert 1 in lengths and lengths[:lengths.index(1)] == [0], lengths
        print("PASS: stalled HTTP POST retains only the newest queued signed snapshot", flush=True)
    finally:
        gate.set()
        await context.close()


async def unavailable_coin_storage(browser, base):
    contexts = []
    pages = []
    try:
        for index in range(2):
            context = await browser.new_context(reduced_motion="reduce")
            contexts.append(context)
            await context.route("https://docs.google.com/**", lambda r: r.abort())
            if index == 0:
                await context.add_init_script("""{
                  const original=Storage.prototype.setItem;
                  Storage.prototype.setItem=function(key,value){
                    if(key.startsWith('oneshot-veto-coin:'))throw new DOMException('quota','QuotaExceededError');
                    return original.call(this,key,value);
                  };
                }""")
            pages.append(await context.new_page())
        await pages[0].goto(base + "/veto.html")
        links = await pages[0].evaluate("""async () => {
          const m=await import('/veto-room.js');
          return (await m.createRoom(location.href,['Storage A','Storage B'],'BO1',5,
            location.origin+'/api/veto-relay')).links;
        }""")
        for page, role in zip(pages, ["a", "b"]):
            await page.goto(links[role])
        for page in pages:
            await expect(page.locator("#vtKicker")).to_contain_text("Coin:", timeout=15000)
            await expect(page.locator("#vtError")).to_be_hidden()
        assert await pages[0].locator("#vtKicker").inner_text() == await pages[1].locator("#vtKicker").inner_text()
        print("PASS: a refused localStorage nonce write does not stop the active commit/reveal", flush=True)
    finally:
        for context in contexts:
            await context.close()


async def main(args):
    async with async_playwright() as p:
        options = {"headless": True}
        if args.chromium and args.browser == "chromium":
            options["executable_path"] = args.chromium
        browser = await getattr(p, args.browser).launch(**options)
        try:
            await slow_vdo(browser, args.url.rstrip("/"))
            await stalled_sender(browser, args.url.rstrip("/"))
            await unavailable_coin_storage(browser, args.url.rstrip("/"))
        finally:
            await browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--browser", choices=["chromium", "webkit"], default="chromium")
    parser.add_argument("--chromium")
    asyncio.run(main(parser.parse_args()))
