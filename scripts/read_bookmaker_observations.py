"""Read only the panel's fixed public API, never browser settings or credentials."""
import asyncio,json
from pathlib import Path
from playwright.async_api import async_playwright

async def main():
    ids=json.loads(__import__("subprocess").check_output(["node","--input-type=module","-e",
        "import {BOOKMAKERS} from './bookmakers.js';console.log(JSON.stringify(BOOKMAKERS.map(b=>b.id)))"],text=True))
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        page=await browser.new_page()
        await page.goto("https://oneshot-panel.pages.dev/build.txt",wait_until="domcontentloaded")
        results=await page.evaluate("""async ids=>Promise.all(ids.map(async id=>{
          try{
            const r=await fetch('/api/bookmakers?id='+id,{cache:'no-store',signal:AbortSignal.timeout(55000)});
            const b=await r.json();
            if(!r.ok||b.id!==id||typeof b.ok!=='boolean'||!Array.isArray(b.events))throw Error('invalid');
            return b;
          }catch{return{id,ok:false,events:[],errors:['source unavailable'],checkedAt:Date.now()};}
        }))""",ids)
        await browser.close()
    Path("work").mkdir(exist_ok=True)
    Path("work/bookmaker-observations.json").write_text(json.dumps(results,ensure_ascii=False),encoding="utf8")
    for b in results:print("BOOKMAKER_OBSERVATION:",b["id"],b["ok"],len(b["events"]),flush=True)
if __name__=="__main__":asyncio.run(main())
