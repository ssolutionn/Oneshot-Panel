"""QR autofill in Chromium and mobile WebKit; only external services are mocked."""
import argparse
import asyncio
import base64
import sys
from pathlib import Path

from playwright.async_api import async_playwright, expect

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qa_browser import sample_roster, gviz
from qa_live import FAKE_VDO, MockObs, OBS_URL as OBS_ROUTE

OBS_URL = 'ws://127.0.0.1:4455'


async def run(args):
    base = args.url.rstrip("/")
    output = Path(args.artifacts) / "qr"
    output.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        for engine in ["chromium", "webkit"]:
            browser = await getattr(p, engine).launch(headless=True)
            mobile = engine == "webkit"
            context = await browser.new_context(
                viewport={"width": 375, "height": 812} if mobile else {"width": 1440, "height": 1000},
                **({"is_mobile": True, "has_touch": True, "device_scale_factor": 2} if mobile else {}))
            errors = []
            automation_styles = []
            def report_csp(source, violation):
                if source["frame"] != source["page"].main_frame:
                    return
                # WebKit reports Playwright's injected fill/screenshot styles.
                # Keep application-source violations fatal and audit the DOM
                # after automation removes its temporary nodes.
                injected_style = (mobile and violation["blocked"] == "inline"
                    and violation["directive"].startswith("style-src")
                    and not violation["file"].startswith(base + "/"))
                (automation_styles if injected_style else errors).append(violation)
            await context.expose_binding("reportQrCsp", report_csp)
            await context.add_init_script("""
                localStorage.setItem('oneshot-watch-cams', 'false');
                addEventListener('securitypolicyviolation', e => reportQrCsp({
                  directive:e.violatedDirective,blocked:e.blockedURI,file:e.sourceFile,line:e.lineNumber
                }));
            """)
            await context.route("https://docs.google.com/**/gviz/**", lambda route:
                route.fulfill(content_type="application/javascript", body=
                    gviz([["Group B","October 15","16:00","6yuBoJlbl","HYPERSPIRIT"]],
                         ["Stage","Date","MSK","Team 1","Team 2"])
                    if "gid=815739139" in route.request.url else sample_roster()))
            await context.route("https://vdo.ninja/**", lambda route:
                route.fulfill(content_type="text/html", body=FAKE_VDO))
            page = await context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            await page.route_web_socket(OBS_ROUTE, MockObs().handler)
            await page.goto(base)
            await expect(page.locator("#syncTitle")).to_contain_text("команд из таблицы")
            await page.click("#obsNavBtn")
            await page.check('input[name=obsMode][value=direct]')
            reader = page.locator("#obsNativeQr")
            await reader.locator(":scope > details > summary").click()

            async def png_qr(text):
                data = await page.evaluate("""async text => {
                  const {drawQr}=await import('/assets/obs-qr.js');
                  const c=document.createElement('canvas'); await drawQr(c,text);
                  return c.toDataURL('image/png').split(',')[1];
                }""", text)
                return base64.b64decode(data)

            native = await png_qr("obsws://192.168.1.9:4466/p%40ss%2Fword%20%23%25%3F")
            await reader.locator('input[type=file]').set_input_files(
                {"name":"obs.png","mimeType":"image/png","buffer":native})
            await expect(reader.locator('[role=status]')).to_contain_text("Адрес, порт и пароль заполнены")
            await expect(page.locator("#obsUrl")).to_have_value("ws://127.0.0.1:4466")
            await expect(page.locator("#obsPassword")).to_have_value("p@ss/word #%?")
            assert await page.evaluate("JSON.parse(localStorage.getItem('oneshot-obs')).mode || null") is None
            await page.fill("#obsUrl", OBS_URL)
            await page.fill("#obsPassword", "pw")
            await page.click("#testObs")
            await expect(page.locator("#obsTestResult")).to_contain_text("OBS подключён")

            await reader.locator('input[type=file]').set_input_files(
                {"name":"bad.png","mimeType":"image/png","buffer":b"invalid image"})
            await expect(reader.locator('[role=status]')).to_contain_text("Не удалось прочитать")
            bad_qr = await png_qr("https://example.com/not-an-obs-qr")
            await reader.locator('input[type=file]').set_input_files(
                {"name":"other.png","mimeType":"image/png","buffer":bad_qr})
            await expect(reader.locator('[role=status]')).to_contain_text("не QR подключения OBS")
            await expect(page.locator("#obsPassword")).to_have_value("pw")
            await expect(page.locator("#obsUrl")).to_have_value(OBS_URL)
            await page.evaluate("""Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{
              getUserMedia:async()=>{throw new DOMException('denied','NotAllowedError');}
            }});""")
            await reader.get_by_role("button",name="Сканировать камерой",exact=True).click()
            await expect(reader.locator('[role=status]')).to_contain_text("Камера недоступна")

            # Synthetic camera with real QR pixels, capture/decode loop and cleanup.
            await page.evaluate("""async () => {
              const {drawQr}=await import('/assets/obs-qr.js');
              const c=document.createElement('canvas'); await drawQr(c,'obsws://192.168.1.9:4455/camera-pass');
              window.qrVideoStream=c.captureStream(10);
              window.qrCaptureCanvas=c;
              window.qrTrack=qrVideoStream.getVideoTracks()[0];
              // WebKit canvas capture emits frames only after a new paint.
              const copy=document.createElement('canvas'); copy.width=c.width; copy.height=c.height;
              copy.getContext('2d').drawImage(c,0,0);
              const paint=setInterval(()=>c.getContext('2d').drawImage(copy,0,0),100);
              window.qrStopPaint=()=>clearInterval(paint);
              navigator.mediaDevices.getUserMedia=async()=>qrVideoStream;
            }""")
            await reader.get_by_role("button",name="Сканировать камерой",exact=True).click()
            await page.wait_for_function("""() =>
              document.getElementById('obsPassword').value==='camera-pass' ||
              document.querySelector('#obsNativeQr [role=status]').textContent.includes('Камера не передаёт изображение')
            """, timeout=20000)
            await page.evaluate("qrStopPaint()")
            if await page.input_value("#obsPassword") == "camera-pass":
                print(f"PASS {engine}: live QR video decoding", flush=True)
            else:
                # Linux WebKit's canvas MediaStream can stay at HAVE_NOTHING;
                # this is not proof of physical iPhone camera capture. Image
                # decoding and the no-frame recovery must still pass.
                assert mobile, await reader.locator('[role=status]').inner_text()
                await expect(reader.locator('[role=status]')).to_contain_text("Камера не передаёт изображение")
                assert await page.input_value("#obsPassword") == "pw"
                print("NOTE webkit: CI canvas stream supplies no video frames; verified timeout, image decoding and manual fallback instead of physical camera", flush=True)
            assert await page.evaluate("qrTrack.readyState") == "ended"
            assert await reader.locator("video").is_hidden()
            # Switching tabs while camera permission is pending must cancel it.
            await page.evaluate("""() => {
              const c=document.createElement('canvas');
              window.lateCameraStream=c.captureStream(1);
              window.lateCameraTrack=lateCameraStream.getVideoTracks()[0];
              navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>window.resolveQrCamera=resolve);
            }""")
            await reader.get_by_role("button",name="Сканировать камерой",exact=True).click()
            await page.click("#viewLobby")
            await page.evaluate("resolveQrCamera(lateCameraStream)")
            await page.wait_for_function("lateCameraTrack.readyState==='ended'")
            await page.click("#obsNavBtn")
            await page.locator("#obsDialog").screenshot(path=str(output / f"{engine}-autofill.jpg"), type="jpeg", caret="initial")
            assert not await page.evaluate("document.documentElement.scrollWidth > innerWidth")

            dock = await context.new_page()
            dock.on("pageerror", lambda error: errors.append(str(error)))
            await dock.route_web_socket(OBS_ROUTE, MockObs().handler)
            await dock.goto(base + "/obs-bridge.html")
            dock_reader = dock.locator("#dockQr")
            await dock_reader.locator(":scope > details > summary").click()
            native_pw = await png_qr("obsws://192.168.1.9:4455/pw")
            await dock_reader.locator('input[type=file]').set_input_files(
                {"name":"native.png","mimeType":"image/png","buffer":native_pw})
            await expect(dock.locator("#dockPassword")).to_have_value("pw")
            await dock.click("#dockForm button[type=submit]")
            await expect(dock.locator("#dockObs")).to_contain_text("OBS: подключён")
            await dock.locator("#dockPair > summary").click()
            await expect(dock.locator("#dockPairCanvas")).to_be_visible()
            pair_url = await dock.input_value("#dockPairUrl")
            assert "password" not in pair_url and "/#obs=" in pair_url
            decoded_pair = await dock.evaluate("""async () => {
              const {default:jsQR}=await import('/assets/vendor/jsqr.js');
              const c=document.getElementById('dockPairCanvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height);
              return jsQR(d.data,d.width,d.height)?.data;
            }""")
            assert decoded_pair == pair_url
            await dock.screenshot(path=str(output / f"{engine}-dock-pair.jpg"), type="jpeg")
            code = await dock.input_value("#dockCode")

            phone_context = await browser.new_context(
                viewport={"width":375,"height":812}, is_mobile=True, has_touch=True)
            await phone_context.route("https://docs.google.com/**/gviz/**", lambda route:
                route.fulfill(content_type="application/javascript", body=sample_roster()))
            await phone_context.route("https://vdo.ninja/**", lambda route:
                route.fulfill(content_type="text/html", body=FAKE_VDO))
            phone = await phone_context.new_page()
            phone.on("pageerror", lambda error: errors.append(str(error)))
            await phone.goto(pair_url)
            await expect(phone.locator("#obsCode")).to_have_text(code)
            await expect(phone.locator("#obsBridgeFields")).to_be_visible()
            assert "#" not in phone.url
            assert await phone.evaluate("JSON.parse(localStorage.getItem('oneshot-obs')).mode") == "bridge"
            assert await phone.evaluate("JSON.parse(localStorage.getItem('oneshot-obs')).password || ''") == ""
            assert not await phone.evaluate("document.documentElement.scrollWidth > innerWidth")
            qr_image = await png_qr(pair_url)
            await phone.locator("#obsPairQr > details > summary").click()
            await phone.locator('#obsPairQr input[type=file]').set_input_files(
                {"name":"pair.png","mimeType":"image/png","buffer":qr_image})
            await expect(phone.locator("#obsPairQr [role=status]")).to_contain_text("Код связи подставлен")
            await expect(phone.locator("#obsCode")).to_have_text(code)
            for current_page in [page, dock, phone]:
                assert await current_page.locator('style,[style]').count() == 0
            if automation_styles:
                print("NOTE WebKit automation style reports:", list({
                    str(value) for value in automation_styles
                }), flush=True)
            assert not errors, errors
            await browser.close()
            print(f"PASS {engine}: QR image/autofill, manual edits, invalid QR, denied camera, live scanner cleanup, dock QR and independent phone pairing", flush=True)
    print("QR_PREVIEW_BEGIN", flush=True)
    print(base64.b64encode((output / "webkit-autofill.jpg").read_bytes()).decode(), flush=True)
    print("QR_PREVIEW_END", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--artifacts", default="artifacts")
    asyncio.run(run(parser.parse_args()))
