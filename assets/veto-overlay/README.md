# CyberClash veto — isolated visual prototype

This branch adds new files only. It does not change app.js, core.js, index.html,
Netlify configuration, the existing workflow, or the Claude artifact.

Preview:
- /assets/veto-overlay/overlay.html?preview=1
- /assets/veto-overlay/overlay.html?preview=1&layout=strip
- Add &step=6 for the completed demo, &format=BO1/BO2/BO3/BO5, &motion=off.
- &animations=off disables card transitions independently of the smoke.

The preview controls use **test data**, visibly labelled in the toolbar.
Without preview=1 the page waits for state and does not display a demo match.

## Included

- 1920x1080 full frame and bottom strip with transparent space above y=680.
- Existing local CyberClash background, event emblem, team logos, map pictures.
- Slow animated smoke via a small WebGL surface; static fallback if unavailable.
- Bans, picks, pending side choice, deciding map and map play order.
- Seven fixed columns follow the veto turns. BO3 is always BAN, BAN, PICK,
  PICK, BAN, BAN, DECIDER; empty columns wait for a map instead of showing
  an unrelated map from the alphabetical pool. Pending side choices stay in
  their pick column; undo clears that turn without moving previous cards.
  Other formats retain their own existing veto rules.
- 900ms ban/pick effects: gradual desaturation and a drawn red cross for bans;
  cyan border/sweep and a brief PICK stamp for picks; delayed team/side labels.
- Undo transitions back to the available card in 650ms. The card grid stays fixed.
- Identical state updates preserve active transitions; changes during a transition
  continue from its current visual state. Reload/restoration shows settled state.
- Exact existing veto rules, imported from core.js rather than duplicated.
- In BO2 the untouched second map is not labelled DECIDER.
- Full-frame picks explicitly name the opposing team and their selected side.
  The strip badge shows the picking team's own starting side.
- PNG download once the demo is complete; actual pixels 1920x1080, alpha in strip.
  Export clears transient card movement and uses the same renderer and artwork.
- Keyboard controls, reduced-motion default for smoke AND cards, and mobile preview.

## Connected to the panel

Without preview=1 the page takes the panel's veto two ways:
- `#s=<base64url snapshot>` — «Ссылка на оверлей для OBS» in the panel's veto
  block copies the overlay URL with the current veto (`?layout=full|strip`);
- the obs-browser event `oneshot-veto` — «Оверлей вето в OBS вживую» sends
  every move through the panel's OBS link (obs-websocket directly or the
  OBS dock, obs-bridge.html), so admin and OBS can be on different computers.

The section below is the original design note.

The renderer accepts a full snapshot through:
await window.vetoOverlay.setState({
  version: 1,
  teams: ["Team A", "Team B"],
  format: "BO3",
  first: 0,
  actions: [{ map: "Ancient", type: "ban", team: 0 }],
  pending: null,
  stage: "GROUP STAGE"
});

Pick actions carry side: "CT" or "T" for the **opposing** team, matching core.js.
pending is an available map awaiting that side choice, or null.
Invalid snapshots reject and retain the previous valid state.
Rendering, PNG and layout selection consume this one snapshot.

The next integration should publish snapshots from the existing manual veto,
use separate read-only OBS and secret write access, retain the latest state
across OBS reloads, and keep a room bound to a match. Switching matches must not
silently replace the on-air room. Undo, reset and pending picks must synchronize.
A backend transport is required because admin and OBS run on different computers;
localStorage/BroadcastChannel cannot provide that synchronization.

FACEIT integration and player self-service veto are outside this prototype.
Before integration, reconcile the latest Claude branch changes.

## Verification

npm run check && npm test
node --check assets/veto-overlay/overlay.js
python3 scripts/qa_veto_overlay.py

The dedicated workflow checks actual drawn BO3 label order in both layouts and renders all four formats in both layouts, checks actual
PNG dimensions/alpha, smoke movement and freezing, undo/finish, malformed updates,
asset failure fallback, 375px overflow, and an idle page with no fake match data.
It also samples real card pixels with smoke frozen to check ban/pick effects,
undo, unchanged neighbours and identical updates, checks reduced-motion settings,
and records a short browser video. It publishes PNGs, JPEGs and the 1280x720 WebM
recording as cyberclash-veto-preview.
