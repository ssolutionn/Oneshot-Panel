"""A white provider document must stay hidden until decoded video is ready."""
import argparse
import asyncio
import io
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright, expect
from qa_browser import gviz, sample_roster


PROVIDER = """<!doctype html><style>
html,body{margin:0;width:100%;height:100%;background:white}
video{width:100%;height:100%;object-fit:cover}
</style><div id="providerWhite" style="position:absolute;inset:0;background:white">Connecting…</div>
<script>
window.__decoded=0;window.__api=false;window.__requests=[];
window.__enableApi=()=>{window.__api=true};
window.__video=(frames,flavor='frames')=>{
  window.__flavor=flavor;
  window.__decoded=frames;
  if(!document.querySelector('video')){
    const v=document.createElement('video');
    v.poster='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="%232695cb"/></svg>';
    document.body.append(v);
  }
  parent.postMessage({action:'video-element-created',streamID:new URLSearchParams(location.search).get('view')},'*');
};
window.__disconnect=()=>{window.__decoded=0;document.querySelector('video')?.remove();
  parent.postMessage({action:'view-connection',value:false,streamID:new URLSearchParams(location.search).get('view')},'*');};
addEventListener('message',e=>{
  if(!window.__api)return;
  if(e.data.style){const s=document.createElement('style');s.textContent=e.data.style;document.head.append(s)}
  if(e.data.getStats){
    __requests.push(e.data.cib);
    parent.postMessage({cib:e.data.cib,stats:__decoded ? {video:__flavor==='fps'?{_type:'video',FPS:30,_frameWidth:640,_frameHeight:480}:{_type:'video',_framesDecoded:__decoded}} : null},'*');
  }
});
</script>"""


async def run(args):
    output=Path(args.artifacts)
    output.mkdir(parents=True,exist_ok=True)
    async with async_playwright() as p:
        options={'headless':True}
        if args.chromium and args.browser=='chromium': options['executable_path']=args.chromium
        browser=await getattr(p,args.browser).launch(**options)
        context=await browser.new_context(viewport={'width':1280,'height':960})
        await context.add_init_script("try{localStorage.setItem('oneshot-watch-cams','false')}catch{}")
        await context.route('https://docs.google.com/**',lambda r:r.fulfill(content_type='application/javascript',
            body=gviz([['','16:00','6yuBoJlbl','HYPERSPIRIT','B']]) if 'gid=815739139' in r.request.url else sample_roster()))
        await context.route('**/api/bookmakers?**',lambda r:r.fulfill(content_type='application/json',body='{"ok":true,"events":[]}'))
        count=[]
        async def provider(route):
            count.append(route.request.url)
            await route.fulfill(content_type='text/html',body=PROVIDER)
        await context.route('https://vdo.ninja/**',provider)
        page=await context.new_page()
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        await page.goto(args.url)
        await expect(page.locator('#syncTitle')).to_contain_text('команд из таблицы')
        values=await page.locator('#matchSelect option').evaluate_all('els=>els.filter(e=>e.value).map(e=>e.value)')
        await page.select_option('#matchSelect',values[0])
        await page.locator('[data-camera="a"][data-slot="0"]').click()
        iframe=page.locator('#cameraPreviewBox iframe')
        handle=await iframe.element_handle()
        frame=await handle.content_frame()
        await frame.wait_for_selector('#providerWhite')
        await frame.wait_for_load_state('load')
        # This fails on the old implementation: load exposed the white page.
        await expect(page.locator('#cameraPreviewBox')).to_have_attribute('data-loading','true')
        await expect(iframe).to_have_css('opacity','0')
        stage=page.locator('.camera-preview-stage')
        async def dark_corner(name):
            raw=await stage.screenshot(path=str(output/name))
            image=Image.open(io.BytesIO(raw)).convert('RGB')
            assert max(image.getpixel((int(image.width*.18),int(image.height*.08))))<180,'White provider document leaked'
        await dark_corner('document-loaded.png')
        # Delayed API startup: initial style messages were lost.
        await page.wait_for_timeout(300)
        await frame.evaluate('()=>window.__enableApi()')
        await frame.wait_for_function('()=>window.__requests.length>0')
        await expect(iframe).to_have_css('opacity','0')
        await dark_corner('waiting-player.png')
        # Neither a video element nor a connection/other-frame message is a decoded frame.
        await frame.evaluate('()=>window.__video(0)')
        current=await frame.evaluate('()=>window.__requests.at(-1)')
        assert await page.evaluate("""cib => {
          const f=document.querySelector('#cameraPreviewBox iframe');
          for(const [source,origin] of [[window,'https://vdo.ninja'],[f.contentWindow,'https://other.example']])
            dispatchEvent(new MessageEvent('message',{source,origin,data:{stats:{video:{_framesDecoded:5}},cib}}));
          return document.querySelector('#cameraPreviewBox').dataset.loading;
        }""",current)=='true'
        await expect(iframe).to_have_css('opacity','0')
        await frame.evaluate('()=>window.__video(12)')
        await expect(page.locator('#cameraPreviewBox')).to_have_attribute('data-loading','false')
        await expect(iframe).to_have_css('opacity','1')
        await expect(frame.locator('#providerWhite')).to_have_css('visibility','hidden')
        await expect(frame.locator('video')).to_have_css('visibility','visible')
        raw=await stage.screenshot(path=str(output/'video-ready.png'))
        image=Image.open(io.BytesIO(raw)).convert('RGB')
        pixel=image.getpixel((image.width//2,image.height//2))
        assert pixel[2]>150 and pixel[0]<80,pixel
        await frame.evaluate('()=>window.__disconnect()')
        await expect(iframe).to_have_css('opacity','0')
        await dark_corner('disconnected.png')
        await frame.evaluate("()=>window.__video(15,'fps')")
        await expect(iframe).to_have_css('opacity','1')
        assert len(count)==1,'Loading/connecting must not reload the iframe'
        await page.click('#closeCamera')
        await expect(page.locator('#cameraPreviewBox iframe')).to_have_count(0)
        assert not errors,errors
        await browser.close()
        print('PASS:',args.browser,'white document after load, delayed API, zero decoded frames, video readiness, disconnect/reconnect and cleanup',flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--url',default='http://127.0.0.1:3000')
    parser.add_argument('--browser',choices=['firefox','chromium','webkit'],default='firefox')
    parser.add_argument('--chromium')
    parser.add_argument('--artifacts',default='artifacts/camera-loading')
    asyncio.run(run(parser.parse_args()))
