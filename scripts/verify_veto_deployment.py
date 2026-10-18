#!/usr/bin/env python3
"""Verify the published veto files and API using a normal browser."""
import argparse
import hashlib
import json
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
                                           ("/vdo.js", "vdo.js")]:
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
                    print("PASS: public veto assets match the release, backup CSP is present, relay health is ready", flush=True)
                    return
                except Exception as error:
                    print(f"Deployment check {attempt + 1}/{attempts}: {error}", flush=True)
                    if attempt + 1 == attempts:
                        raise
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
