"""Read the deployed public bookmaker API through an ordinary site browser."""
import argparse
import asyncio
import json
import subprocess
from playwright.async_api import async_playwright


async def run(args):
    ids = json.loads(subprocess.check_output([
        "node", "--input-type=module", "-e",
        "import {BOOKMAKERS} from './bookmakers.js'; console.log(JSON.stringify(BOOKMAKERS.map(b=>b.id)))"
    ], text=True))
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=args.chromium, headless=True)
        page = await browser.new_page()
        await page.goto(args.url.rstrip("/") + "/build.txt")
        results = await page.evaluate("""async ids => Promise.all(ids.map(async id => {
            try {
            const response = await fetch('/api/bookmakers?id=' + id, {
                cache:'no-store', signal:AbortSignal.timeout(55000)
            });
            if (!response.ok) throw new Error(id + ': HTTP ' + response.status);
            if (response.headers.get('x-content-type-options') !== 'nosniff') throw new Error(id + ': missing nosniff');
            const body = await response.json();
            if (body.id !== id || typeof body.ok !== 'boolean' || !Array.isArray(body.events))
                throw new Error(id + ': invalid response');
            return {id, ok:body.ok, events:body.events.length, errors:body.errors || []};
            } catch(error) { return {id,transportError:error.name,message:error.message}; }
        }))""", ids)
        await browser.close()
    for result in results:
        print("BOOKMAKER_PUBLIC_API:", json.dumps(result, ensure_ascii=False), flush=True)
    assert not any(result.get("transportError") for result in results), "Published API transport failures recorded above."
    assert any(result.get("ok") for result in results), "All public feeds are unavailable from this hosting region."
    print("PASS: deployed read-only bookmaker API; provider availability recorded separately", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--chromium")
    asyncio.run(run(parser.parse_args()))
