#!/usr/bin/env python3
"""Verify the published veto files and API using a normal browser."""
import argparse
import hashlib
import json
import re
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


def verify(base, root, attempts, chromium=None):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(**({"executable_path": chromium} if chromium else {}))
        page = browser.new_page()
        try:
            for attempt in range(attempts):
                try:
                    for url_path, file in [("/", "index.html"), ("/veto.js", "veto.js"),
                                           ("/veto.css", "veto.css"), ("/veto-room.js", "veto-room.js"),
                                           ("/vdo.js", "vdo.js"),
                                           ("/assets/veto-short-links.js", "assets/veto-short-links.js"),
                                           ("/assets/veto-short-protocol.js", "assets/veto-short-protocol.js")]:
                        response = page.goto(base.rstrip("/") + url_path, wait_until="domcontentloaded", timeout=20000)
                        assert response and response.status == 200, f"HTTP error: {url_path}"
                        assert hashlib.sha256(response.body()).digest() == hashlib.sha256(
                            (root / file).read_bytes()).digest(), f"Old or different asset: {url_path}"
                        if url_path == "/":
                            assert "https://cdn-backup.vdo.ninja" in response.headers.get(
                                "content-security-policy", ""), "Missing VDO backup in CSP"
                    response = page.goto(base.rstrip("/") + "/api/veto-relay?health=1",
                                         wait_until="domcontentloaded", timeout=20000)
                    assert response and response.status == 200, "Relay health HTTP error"
                    assert "application/json" in response.headers.get("content-type", ""), "Relay returned HTML"
                    health = json.loads(response.body())
                    assert health.get("protocol") == 1 and health.get("ready") is True, "Relay is not ready"
                    page.goto(base.rstrip('/')+'/',wait_until='domcontentloaded',timeout=20000)
                    assert page.locator('#vtStart').input_value() == 'coin', "A new room must default to a coin toss"
                    link=page.evaluate("""async () => {
                        const room=await import('/veto-room.js');
                        const short=await import('/assets/veto-short-links.js');
                        const made=await room.createRoom(location.origin+'/', ['Release QA A','Release QA B'],'BO1',5,
                          location.origin+'/api/veto-relay',0);
                        const pretty=await short.friendlyCaptainLinks(made,location.origin,'Release QA');
                        if(pretty.shortLinkFallback)throw Error('Short-link API did not save both captain links');
                        const resolved=await short.resolveRoomLink(pretty.links.a,fetch,null);
                        if(resolved.room.r!==made.room.r||resolved.room.me!=='a'||resolved.room.chooser!==0)throw Error('Short-link room mismatch');
                        return pretty.links.a;
                    }""")
                    response=page.goto(link,wait_until='domcontentloaded',timeout=20000)
                    assert response and response.status==200,"Pretty captain path did not load"
                    assert "script-src 'self'" in response.headers.get('content-security-policy',''),"Pretty page has no CSP"
                    page.wait_for_selector('#vtRoom:not([hidden])',timeout=15000)
                    page.wait_for_selector('#vtActions button',timeout=15000)
                    assert page.locator('#vtActions button').count() == 2, "Assigned captain cannot choose the order"
                    assert page.locator('#vtCoin').is_hidden(), "Assigned order unexpectedly tosses the coin"
                    assert '#k=' in page.url and '#v=' not in page.url,"Captain address did not stay readable"
                    print("PASS: public release assets, backup CSP, relay health, encrypted captain links, readable routes and assigned order choice", flush=True)
                    return
                except Exception as error:
                    safe=re.sub(r'(https?://[^\s#]+)#[^\s]+',r'\1#[redacted]',str(error))
                    print(f"Deployment check {attempt + 1}/{attempts}: {safe}", flush=True)
                    if attempt + 1 == attempts:
                        raise AssertionError(safe) from None
                    time.sleep(5)
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="https://oneshot-veto.pages.dev")
    repo = Path(__file__).resolve().parent.parent
    parser.add_argument("--root", type=Path, default=repo / "dist-veto" if (
        repo / "scripts/build-veto-site.mjs").is_file() else repo)
    parser.add_argument("--attempts", type=int, default=12)
    parser.add_argument("--chromium")
    args = parser.parse_args()
    if args.attempts < 1:
        parser.error("--attempts must be positive")
    verify(args.url, args.root, args.attempts, args.chromium)
