# QA baseline (final pass, post 80a309c)
Static: 14/14 routes 200 (index, app, core, live, lobby, veto, card, obs-bridge, event.js, theme, style, radar, template)
API: /api/ebot 200, ?view 200, /api/bookmakers 200, /api/cs2-status 404 (expected, no CS2_JOURNAL)
Negatives: traversal 404, server-module leak 404, admin POST no-origin 403
Suite: 299/299, check 114/114, artifact build exit 0
Pending: /code-review, /devex-review, /review agent reports
