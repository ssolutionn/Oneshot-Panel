# QA Report: Oneshot Panel — eBot integration baseline
Target: http://127.0.0.1:3000 (local server.js), branch feat/ebot-admin
Mode: functional baseline (server-level probes; browser runs pending console agent)
Date: 2026-10-31

## Baseline findings

| # | Area | Result | Note |
|---|------|--------|------|
| B1 | /api/ebot live read | PASS 200, 0.25s, page parsed (18424 B, 2 matches) | live eBot reachable |
| B2 | /api/ebot-admin GET | PASS 404 (write endpoint not GETtable) | |
| B3 | /api/ebot-admin POST no-origin | PASS 403 | CSRF gate works |
| B4 | /api/ebot-admin POST foreign origin | PASS 403 | |
| B5 | /api/ebot-admin POST spoofed sec-fetch-site | 401 no-credentials — gate PASSED with spoofed header (finding R1 from review: header spoofing reaches the handler; mitigations in flight via agent: EBOT_ADMIN_TOKEN optional + no auto-catalog) | known, accepted by owner (LAN deploy); token option being added |
| B6 | Path traversal /../server.js | PASS 404 | static whitelist holds |
| B7 | server/ebot-admin.js not served | PASS 404 | secrets/module not exposed |
| B8 | npm test | 276 pass / 0 fail | |
| B9 | /api/ebot-console | 404 — console feature not landed yet (agent in flight) | pending |

## In flight (agents)
- Fix agent: 8 review findings (CF import broken, login-per-request cache, redirect SSRF, nginx http2, /api/ebot page cache, body limits, optional EBOT_ADMIN_TOKEN)
- Console agent: RCON console + live logs + chat (SSE), test/ebot-console.test.js

## Deferred
- Live eBot login/command E2E: requires EBOT_USER/EBOT_PASSWORD from owner (server goes local tomorrow)
- Browser-level QA of ebot block: after console agent lands
