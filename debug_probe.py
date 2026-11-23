from playwright.sync_api import sync_playwright
import json

URL = 'http://127.0.0.1:3000/'
MATCHES = {'items': [{
    'match_id': '1-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'status': 'ONGOING', 'best_of': 1,
    'faceit_url': 'https://www.faceit.com/en/cs2/room/1-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'teams': {'faction1': {'name': 'duttdutt'}, 'faction2': {'name': 'TOAZpeek'}},
    'results': {'score': {'faction1': 7, 'faction2': 4}}, 'detailed_results': []
}, {
    'match_id': '1-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'status': 'SCHEDULED',
    'faceit_url': 'https://www.faceit.com/en/cs2/room/1-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'scheduled_at': 1893456000,
    'teams': {'faction1': {'name': 'SOYUZzz'}, 'faction2': {'name': 'LukTech Prime'}},
    'results': {'score': {'faction1': 0, 'faction2': 0}}, 'detailed_results': []
}]}
DETAIL = {'match_id': '1-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'status': 'ONGOING',
          'teams': {'faction1': {'name': 'duttdutt', 'roster': [{'player_id': 'p1', 'nickname': '-xyk'}]},
                    'faction2': {'name': 'TOAZpeek', 'roster': [{'player_id': 'p2', 'nickname': 'MaFF1N-'}]} }}

def route(r):
    url = r.request.url
    if '/api/faceit' in url:
        body = DETAIL if '%2Fmatches%2F' in url else MATCHES
        r.fulfill(status=200, content_type='application/json', body=json.dumps(body))
    else:
        r.continue_()

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_context(viewport={'width': 1400, 'height': 1000}).new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append('PAGEERROR: ' + str(e)))
    page.on('console', lambda m: errs.append('CONSOLE: ' + m.text) if m.type == 'error' else None)
    page.route('**/*', route)
    page.goto(URL, wait_until='networkidle')
    page.click('#qualificationsNavBtn')
    page.fill('#qualificationsUrl', 'https://www.faceit.com/en/championship/12345678-1234-1234-1234-123456789abc/test')
    page.click('#qualificationsForm button[type=submit]')
    page.wait_for_timeout(8000)

    # Check visible length via evaluate
    visible_len = page.evaluate("""
        (() => {
          const c = window.qualificationsController;
          const vals = Array.from(c.state.matches.values());
          // call the internal functions directly
          const sorted = c.sortQualificationMatches(vals);
          const visible = c.filterQualificationMatches(sorted, c.state.filter);
          return visible.length;
        })()
    """)
    print('visible length:', visible_len)

    # Manually call render
    c.render()
    page.wait_for_timeout(500)

    cards = page.locator('.qcard').count()
    print('cards after manual render:', cards)

    # Check problems panel
    problems_hidden = page.evaluate('document.getElementById("qualificationsProblems")?.hidden')
    print('problems_hidden:', problems_hidden)

    prob_html = page.locator('#qualificationsProblems').inner_html()
    print('problems_html:', prob_html[:300])

    tab_badge = page.locator('#qualificationsNavBtn .problems-badge').count()
    tab_badge_text = page.locator('#qualificationsNavBtn .problems-badge').text_content() if tab_badge else 'NONE'
    print('tab_badge:', tab_badge, 'text:', tab_badge_text)

    print('errors:', errs[:10])
    b.close()