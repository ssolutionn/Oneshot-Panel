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
        assert await page.evaluate("""() => document.fonts.check('700 48px "Oneshot Display"')""")
        checks.append("Local event-style display font is loaded before the canvas")
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

        # Freeze smoke so only card effects can change these pixels.
        async def card_sample(index=0, layout="full"):
            return await page.evaluate("""({index,strip}) => {
              const x=Math.round(80+index*((1760-14*6)/7+14)+20);
              const y=strip?824:463,h=strip?70:170;
              const d=document.getElementById('scene').getContext('2d').getImageData(x,y,190,h).data;
              let hash=2166136261;
              for(let i=0;i<d.length;i+=4)hash=Math.imul(hash^d[i]^d[i+1]^d[i+2],16777619);
              return hash>>>0;
            }""", {"index":index,"strip":layout=="strip"})
        for kind in ["full", "strip"]:
            await ready(layout=kind, step=0)
            before = await card_sample(0, kind)
            neighbour = await card_sample(1, kind)
            await page.click("#next")
            await page.wait_for_selector('#scene[data-animating*="Ancient"]')
            await page.wait_for_timeout(180)
            await page.evaluate("window.vetoOverlay.setState(window.vetoOverlay.getState())")
            assert "Ancient" in await page.locator("#scene").get_attribute("data-animating")
            middle = await card_sample(0, kind)
            await page.screenshot(path=str(output / f"veto-ban-mid-{kind}.png"))
            await page.wait_for_selector('#scene[data-animating=""]')
            settled = await card_sample(0, kind)
            assert before != middle != settled, "Ban is not visibly interpolated"
            assert neighbour == await card_sample(1, kind), "Unchanged card moved"
            await page.click("#previous")
            await page.wait_for_selector('#scene[data-animating*="Ancient"]')
            await page.wait_for_selector('#scene[data-animating=""]')
            assert before == await card_sample(0, kind), "Undo did not restore the card"
            await ready(layout=kind, step=2)
            before = await card_sample(2, kind)
            await page.click("#next")
            await page.wait_for_selector('#scene[data-animating*="Mirage"]')
            await page.wait_for_timeout(350)
            middle = await card_sample(2, kind)
            await page.screenshot(path=str(output / f"veto-pick-mid-{kind}.png"))
            await page.wait_for_selector('#scene[data-animating=""]')
            settled = await card_sample(2, kind)
            assert middle != before and middle != settled, "Pick sweep/stamp is not visible"
            checks.append(f"{kind}: ban/pick pixels animate; undo restores; unchanged cards and duplicate updates stay stable")


        # PICK is a map choice; the opponent's side is a later UI step.
        for kind in ["full", "strip"]:
            await ready(layout=kind, step=2)
            await page.evaluate("""() => {
              window.pickStamps=0;
              const ctx=document.getElementById('scene').getContext('2d'),draw=ctx.fillText.bind(ctx);
              ctx.fillText=function(text,...args) {
                if(text==='PICK' && /(?:25|34)px/.test(this.font))window.pickStamps++;
                return draw(text,...args);
              };
            }""")
            await page.evaluate("""async () => {
              const state=vetoOverlay.getState();
              await vetoOverlay.setState({...state,pending:'Mirage'});
            }""")
            await page.wait_for_selector('#scene[data-animating*="Mirage"]')
            await page.wait_for_timeout(400)
            assert await page.evaluate("window.pickStamps > 0"), "PICK reveal waited for CT/T"
            owner = await page.evaluate("""async () => {
              const {viewModel}=await import('/assets/veto-overlay/model.js');
              return viewModel(vetoOverlay.getState()).slots[2];
            }""")
            assert owner["team"] == 0 and owner["sideTeam"] == 1 and owner["side"] is None
            await page.wait_for_selector('#scene[data-animating=""]')
            await page.evaluate("window.pickStamps=0")
            await page.evaluate("""async () => {
              const state=vetoOverlay.getState(),{appendVeto}=await import('/core.js');
              await vetoOverlay.setState({...state,pending:null,
                actions:appendVeto(state.actions,state.format,state.first,'Mirage','CT')});
            }""")
            await page.wait_for_timeout(500)
            assert await page.evaluate("window.pickStamps === 0"), "Side choice replayed PICK"
            checks.append(f"{kind}: immediate PICK, opponent side choice, no repeated stamp")

        # The deciding map appears only after attention has stayed on the last ban.
        await ready(step=5)
        await page.click("#next")
        await page.wait_for_selector('#scene[data-phase="last-move"]')
        await page.wait_for_timeout(1100)
        assert await page.locator("#scene").get_attribute("data-phase") == "last-move"
        await page.evaluate("vetoOverlay.setState(vetoOverlay.getState())")
        await page.wait_for_selector('#scene[data-phase="finished"]', timeout=1200)
        await page.wait_for_selector('#scene[data-animating*="Inferno"]')
        await page.wait_for_selector('#scene[data-animating=""]')
        checks.append("Decider waits 1.5s after the last ban; duplicate snapshots do not reset the delay")

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

        await ready(layout="strip", step=6)
        legacy = await page.evaluate("""() => {
          const d=document.getElementById('scene').getContext('2d').getImageData(0,680,1920,400).data;
          let h=2166136261;for(let i=0;i<d.length;i++)h=Math.imul(h^d[i],16777619);
          return h>>>0;
        }""")
        await page.goto(path + "?preview=1&layout=strip&crop=1&step=6&motion=off")
        await page.wait_for_selector("#scene[data-ready='true']")
        cropped = await page.evaluate("""() => {
          const c=document.getElementById('scene'),d=c.getContext('2d').getImageData(0,0,1920,400).data;
          let h=2166136261;for(let i=0;i<d.length;i++)h=Math.imul(h^d[i],16777619);
          return {width:c.width,height:c.height,hash:h>>>0,alpha:d[3]};
        }""")
        assert cropped == {"width":1920,"height":400,"hash":legacy,"alpha":255}, cropped
        async with page.expect_download() as pending:
            await page.click("#download")
        download = await pending.value
        target = output / "CyberClash-veto-1920x400.png"
        await download.save_as(str(target))
        raw = target.read_bytes()
        assert int.from_bytes(raw[16:20],"big") == 1920 and int.from_bytes(raw[20:24],"big") == 400
        checks.append("Compact strip: 1920x400, same lower pixels, 400px PNG export")

        # Observe actual canvas labels and their horizontal positions, rather
        # than only the view model, in both OBS layouts and exported scenes.
        for kind in ["full", "strip"]:
            await ready(layout=kind)
            labels = await page.evaluate("""async strip => {
              const canvas=document.getElementById('scene'),ctx=canvas.getContext('2d');
              const original=ctx.fillText.bind(ctx),labels=[];
              ctx.fillText=function(text,...args) {
                const point=this.getTransform();
                if(Math.abs(point.f-(strip?987:413))<.1 &&
                  ['BAN','PICK','DECIDER'].includes(text))labels.push({text,x:point.e});
                return original(text,...args);
              };
              await window.vetoOverlay.setState(window.vetoOverlay.getState(),{animate:false});
              await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
              ctx.fillText=original;
              return labels.slice(-7).sort((a,b)=>a.x-b.x).map(item=>item.text);
            }""", kind=="strip")
            assert labels == ["BAN","BAN","PICK","PICK","BAN","BAN","DECIDER"], labels
        checks.append("Both rendered layouts keep BAN BAN PICK PICK BAN BAN DECIDER left to right")
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
        # OBS installations without WebGL still receive moving clouds.
        fallback_motion = await browser.new_page(viewport={"width":960,"height":540})
        await fallback_motion.add_init_script("""
            const original=HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext=function(type,...args) {
              return type==='webgl' ? null : original.call(this,type,...args);
            };
        """)
        await fallback_motion.goto(path + "?preview=1&step=0")
        await fallback_motion.wait_for_selector("#scene[data-ready='true']")
        assert await fallback_motion.locator("#scene").get_attribute("data-smoke") == "canvas"
        async def fallback_sample():
            return await fallback_motion.evaluate("""() => {
              const d=document.getElementById('scene').getContext('2d').getImageData(700,45,400,100).data;
              let h=2166136261;for(let i=0;i<d.length;i+=4)h=Math.imul(h^d[i]^d[i+1]^d[i+2],16777619);
              return h>>>0;
            }""")
        before = await fallback_sample()
        await fallback_motion.wait_for_timeout(1300)
        assert before != await fallback_sample(), "Canvas fallback smoke is frozen"
        await fallback_motion.screenshot(path=str(output / "veto-canvas-smoke.png"))
        await fallback_motion.close()
        checks.append("Clouds keep moving with WebGL unavailable in OBS")

        # Reduced-motion settings disable card effects as well as the smoke.
        reduced = await browser.new_page(viewport={"width":960,"height":624}, reduced_motion="reduce")
        await reduced.goto(path + "?preview=1&step=0")
        await reduced.wait_for_selector("body[data-ready='true']")
        await reduced.wait_for_selector("#scene[data-ready='true']")
        assert not await reduced.locator("#motion").is_checked()
        await reduced.click("#next")
        await reduced.wait_for_timeout(120)
        assert await reduced.locator("#scene").get_attribute("data-animating") == ""
        await reduced.close()
        checks.append("Reduced motion presents the committed state without card transitions")

        # Record a short example of the actual rendered effects.
        film_context = await browser.new_context(
            viewport={"width":1280,"height":720},
            record_video_dir=str(output / "_recording"),
            record_video_size={"width":1280,"height":720})
        film = await film_context.new_page()
        film.on("pageerror", lambda error: errors.append(str(error)))
        await film.goto(path + "?preview=1&step=0")
        await film.wait_for_selector("body[data-ready='true']")
        await film.evaluate("""() => {
          document.body.dataset.preview='false';document.getElementById('previewBar').hidden=true;
        }""")
        await film.wait_for_timeout(650)
        for step in [1,2,3,4,3,4,5,6]:
            await film.evaluate("""async step => {
              const {demoState}=await import('/assets/veto-overlay/model.js');
              await window.vetoOverlay.setState(demoState('BO3',step));
            }""", step)
            await film.wait_for_timeout(1200)
        await film.wait_for_timeout(700)
        video = film.video
        await film.close()
        await video.save_as(str(output / "CyberClash-veto-animation-preview.webm"))
        original_video = Path(await video.path())
        await film_context.close()
        original_video.unlink(missing_ok=True)
        checks.append("Recorded browser ban, pick, undo and completion video at 1280x720")
        await context.close()
        assert not errors, errors
        assert all(url.startswith(base) for url in urls), urls
        checks.append("No script errors and no third-party requests")
        # Check graceful asset failures separately from the clean-load assertions.
        fallback = await browser.new_page(viewport={"width":960,"height":540})
        await fallback.route("**/assets/maps/*", lambda route: route.abort())
        await fallback.route("**/assets/card/background.jpg", lambda route: route.abort())
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
