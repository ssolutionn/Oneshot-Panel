#!/usr/bin/env python3
"""Separate panel/source browser contexts, real HTTP relay, VDO blocked on source."""
import asyncio
import re
from datetime import datetime, timezone
from pathlib import Path
from playwright.async_api import async_playwright, expect
from qa_browser import gviz, sample_roster

async def main():
    base="http://127.0.0.1:3000"
    async with async_playwright() as p:
        browser=await p.chromium.launch()
        panel_ctx=await browser.new_context(viewport={"width":1440,"height":1000})
        source_ctx=await browser.new_context(viewport={"width":1920,"height":400})
        errors=[]
        async def sheets(route):
            if "gid=815739139" in route.request.url:
                day=datetime.now(timezone.utc).strftime("%B %d")
                body=gviz([["Group B1",day,"18:00","UPGRADE","Lavked"]],
                          ["Stage","Date","MSK (GMT +3)","Team 1","Team 2"])
            elif "gid=1212769715" in route.request.url:
                body=gviz([],["Stage"])
            else:
                body=sample_roster(("UPGRADE","Lavked"))
            await route.fulfill(content_type="application/javascript",body=body)
        await panel_ctx.route("https://docs.google.com/**/gviz/**",sheets)
        # The existing OBS control bridge is outside this task; no active dock.
        await panel_ctx.route("https://vdo.ninja/**",lambda r:r.fulfill(content_type="text/html",body="<!doctype html>"))
        await source_ctx.route("https://vdo.ninja/**",lambda r:r.abort())
        panel=await panel_ctx.new_page()
        panel.on("pageerror",lambda e:errors.append(str(e)))
        await panel.goto(base)
        await expect(panel.locator("#syncTitle")).to_contain_text("команд из таблицы",timeout=15000)
        await panel.click("#vetoNavBtn")
        await panel.fill("#cvSite",base+"/veto.html")
        await panel.locator("#cvSite").dispatch_event("change")
        await panel.select_option("#cvTransport","server")
        await panel.click("#cvCreate")
        await expect(panel.locator("#cvRoom")).to_be_visible(timeout=15000)
        await panel.select_option("#vetoLayout","strip")
        await panel.evaluate("navigator.clipboard.writeText=async t=>{window.__source=t;}")
        await panel.click("#copyOverlay")
        url=await panel.evaluate("window.__source")
        assert "&relay=" in url and "crop=1" in url
        await expect(panel.locator("#vetoLiveStatus")).to_contain_text("Ждём оверлей")
        source=await source_ctx.new_page()
        source.on("pageerror",lambda e:errors.append(str(e)))
        source.on("request",lambda r:errors.append("VDO request: "+r.url) if r.url.startswith("https://vdo.ninja/") else None)
        await source.goto(url)
        await source.wait_for_selector("body[data-ready='true']")
        await expect(panel.locator("#vetoLiveStatus")).to_contain_text("Оверлей получает вето",timeout=20000)
        await panel.click('[data-map="Ancient"]')
        await source.wait_for_function("() => window.vetoOverlay.getState()?.actions.length===1",timeout=15000)
        await source.wait_for_function("() => document.querySelector('#scene').dataset.animating===''",timeout=15000)
        await source.reload()
        await source.wait_for_function("() => window.vetoOverlay?.getState()?.actions.length===1",timeout=15000)
        assert await source.locator("iframe.vdo-frame").count()==0
        # A lost network must not blank the source. Reconnect to the newest full state.
        await source_ctx.set_offline(True)
        await panel.click('[data-map="Anubis"]')
        await source.wait_for_timeout(1500)
        assert len((await source.evaluate("window.vetoOverlay.getState()"))["actions"])==1
        await source_ctx.set_offline(False)
        await source.wait_for_function("() => window.vetoOverlay.getState()?.actions.length===2",timeout=20000)
        await source.wait_for_function("() => document.querySelector('#scene').dataset.animating===''",timeout=15000)
        Path("artifacts/relay").mkdir(parents=True,exist_ok=True)
        await source.screenshot(path="artifacts/relay/server-overlay-strip.png")
        await panel.uncheck("#vetoLive")
        # Once the source is gone, a fresh panel cannot use an old receipt as success.
        await source.close()
        await panel.check("#vetoLive")
        await panel.wait_for_timeout(3000)
        await expect(panel.locator("#vetoLiveStatus")).to_contain_text("Ждём оверлей")
        await panel.uncheck("#vetoLive")
        await panel.reload()
        await panel.click("#vetoNavBtn")
        await panel.check("#vetoLive")
        await expect(panel.locator("#vetoLiveStatus")).to_contain_text("Ждём оверлей")
        await panel.wait_for_timeout(3000)
        await expect(panel.locator("#vetoLiveStatus")).to_contain_text("Ждём оверлей")
        assert not errors,errors
        await browser.close()
        print("PASS: server OBS overlay receipt, strip crop, animation, reload, offline recovery, stale receipt rejection; zero VDO requests")

asyncio.run(main())
