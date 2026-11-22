import json, glob
from playwright.sync_api import sync_playwright

cands = sorted(glob.glob('/Users/nikita/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'))
exe = cands[-1] if cands else None
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=exe, headless=True)
    page = b.new_page(viewport={'width': 1200, 'height': 900})
    page.goto('http://127.0.0.1:8791/repro.html')
    page.wait_for_timeout(400)
    print(json.dumps(page.evaluate('window.__m'), ensure_ascii=False, indent=1))
    # also measure grid row heights
    print('grid rows', page.evaluate("getComputedStyle(document.querySelector('.qualifications-grid')).gridTemplateRows"))
    page.set_viewport_size({'width': 375, 'height': 700})
    page.wait_for_timeout(200)
    print('375 scrollWidth', page.evaluate('document.documentElement.scrollWidth'), 'client', page.evaluate('document.documentElement.clientWidth'))
    b.close()
