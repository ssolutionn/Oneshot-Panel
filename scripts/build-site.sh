#!/bin/sh
# One build for every host (Netlify, Cloudflare Pages, CI): copy the files
# server.js serves (test/server.test.js checks the list) into public/.
# build.txt holds the deployed commit; CI waits for it before checking the site.
set -e
# Checked photos are kept in Git; this only fills gaps (failures give a placeholder).
if command -v python3 >/dev/null 2>&1; then
  python3 scripts/fetch_player_photos.py --allow-missing
else
  echo "python3 not found: publishing the photos kept in Git"
fi
rm -rf public
mkdir public
cp index.html app.js core.js theme.js style.css card.html card.js card.css live.js obs.js vdo.js lobby.js faceit.js ebot.js notifications.js notification-worker.js obs-bridge.html obs-bridge.js veto.html veto.js veto.css veto-room.js veto-watch.js bookmakers.js bookies.js lan.js lan-event.js lan-images.js cs2.js oneshot-webcams.js ebot-ui.js veto-mobile.html public/
cp -R assets public/
# Which event this address is (events/<slug>/event.json): EVENT, or the Pages branch
# when events/<branch>/ exists (reu → ЛАН РЭУ), else CyberClash.
node scripts/event-config.mjs > public/event.js
# Cloudflare Pages takes the security headers from public/_headers; Netlify from netlify.toml.
if [ -n "$CF_PAGES" ]; then cp _headers public/; fi
echo "${COMMIT_REF:-${CF_PAGES_COMMIT_SHA:-}}" > public/build.txt
