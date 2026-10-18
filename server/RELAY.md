# Veto server transport

Choose VDO.Ninja or Our server **before creating a room**. The four links
carry the same relay endpoint in their fragment. Existing VDO links keep
working. There is no automatic transport switch during a veto.

The admin panel watches the selected room; keep “Переносить” enabled to
forward captains' moves to the panel and OBS. Copy the overlay URL again
for a new transport and put it into the OBS Browser source. The separate
display code cannot operate OBS or sign captain moves. Cameras and the
remote OBS control dock still use VDO. Downloading JSON never used VDO;
the camera sources inside the JSON do.

## Cloudflare (current hosting)

The generated repo includes **Deploy veto to Cloudflare**, a GitHub Actions
workflow for pushes to `main` and manual runs. It validates the Worker and
Pages Functions, deploys the Worker/migration first, then Pages, and checks
the public file hashes, CSP and JSON health in Chromium. Pages receives a
separate directory containing public assets and the compiled API only.

In the **Oneshot-Veto** repository's Settings → Secrets and variables → Actions,
set `CLOUDFLARE_API_TOKEN` as a secret (Account → Workers Scripts → Edit and
Account → Cloudflare Pages → Edit, scoped to the existing account).
Set `CLOUDFLARE_ACCOUNT_ID` as a repository variable or secret for that same
account. If it is absent, the workflow attempts account discovery and accepts
only one account whose existing Pages project owns `oneshot-veto.pages.dev`.
Discovery needs permission to list accounts; otherwise set the ID explicitly.
These values are not part of the site or captain links. The workflow
fails explicitly when either value is missing; it never treats a static-only
upload as a ready relay. Re-run the workflow after adding missing credentials.

For deployment through the existing Cloudflare Git integration instead:

1. In the existing **oneshot-veto Worker** connected to this generated repo,
   deploy the committed wrangler.jsonc with **npx wrangler deploy**.
   It adds the VETO_RELAY binding and a SQLite Durable Object migration.
   Keep the old Worker domain enabled; do not replace the migration tag
   on subsequent deployments. Static VDO links at that domain still work.
2. Pages deploys the same repo with functions/api/veto-relay.js. Configure a
   **service binding** named `VETO_RELAY_SERVICE` to Worker `oneshot-veto`.
   The GitHub workflow supplies this in its Pages Wrangler configuration.
   Requests use the internal binding, avoiding public Worker-to-Worker HTTP.
   Without a binding the proxy retains its fixed-address HTTP fallback for
   compatibility, but production readiness must be checked on the Pages URL.
   The browser uses its Pages origin; nothing sensitive is sent in a query.
3. Verify GET /api/veto-relay?health=1 returns
   {"protocol":1,"ready":true} on the **public Pages address**.
   A push alone does not prove the backend is deployed. If it is absent,
   creating a server room fails visibly; VDO remains selectable.
4. Test two captains on separate devices, the panel and OBS acknowledgement.
   Server rooms must make **no VDO requests** on the captains' pages/overlay.

Durable Objects require Workers deployment, not just static Pages assets.
SQLite Durable Objects are available on Cloudflare Free; requests/storage
use the account's quota. The 1 second polling clients and per-topic storage
requests count against it: monitor usage for multi-hour events and size
the plan accordingly. No provider credentials are placed in the site.
Cloudflare routes retain data for seven days after each publisher's last
update. A reconnect loads the newest snapshot, without declaring an absent
captain online merely because a snapshot exists.

## Move to a VPS or any host with a server runtime

No Cloudflare-specific code is used by browsers. Serve the generated static
site using nginx/Caddy, and reverse proxy **/api/veto-relay** and **/api/veto-link** (all GET/POST/
OPTIONS, query preserved, no caching) to this native Node >=22 service:

```sh
HOST=127.0.0.1 PORT=3101 VETO_RELAY_DIR=/var/lib/oneshot-veto node server/veto-relay-node.mjs
```

Use HTTPS outside localhost. The storage directory must be private and on
a persistent volume. One process owns it; do not share it between several
processes without replacing the file store with a transactional shared DB.
Use a service manager to restart the process. It needs no npm packages.
Running the complete panel with node server.js also serves this endpoint
for local development. Expired files are pruned hourly by the standalone
service. Back up/restore only this directory when continuity is required.

## Readable personal captain links

Captain URLs use `/tournament_team#k=<22 characters>`. Serve `veto.html` for
these single-segment paths (the Node server, Worker and Pages function do
this already). The fragment is essential: a bare team address grants no
captain access. Captains' original links are AES-GCM encrypted in the browser;
only the ciphertext, a readable slug and SHA-256 of the random fragment key
reach `/api/veto-link`. The server never gets the decryption/signing secret.

Directory records are immutable and have no automatic expiry. Repeated POST
of the same record succeeds; replacement returns 409. New matches with the
same tournament/team text have distinct private keys and separate records.
The `short:` DO namespace is separate from move topics; Node stores the
records in the private `links/` subdirectory. Back up that subdirectory too.
Validated encrypted records are cached by the browser for offline reopening.
Creation falls back to the original long links if the directory is unavailable.

New links use the new origin automatically. Previously sent server links
still point to their original endpoint: retain that endpoint during any
ongoing veto or issue a new room. No static-only host can provide a shared
live state without a backend.

## Security and failure behavior

Each published envelope is AES-GCM encrypted and separately signed by its
publisher's P-256 key. Topic ownership is bound to the public key's SHA-256
fingerprint. Spectators do not have either captain's private key. Clients
also validate every signed veto move, the coin and the rule order.

The relay accepts only a strict bounded JSON envelope (24 KB), not arbitrary
files, HTML, commands, upstream URLs or filesystem paths. Invalid signatures,
old writes, replay presence refreshes and per-topic bursts are rejected.
There are no login cookies; public CORS is safe only with this signature
contract. HTTPS and ordinary hosting request/abuse limits are still needed.
Public API quotas are not an access-control boundary. Do not log request
bodies or link fragments. Keep captain links private.

A temporary outage keeps the last verified board, retries without opening
VDO, and coalesces queued sends to the latest full snapshot. Server receipt
is not proof OBS rendered it: the panel turns green only after the source
acknowledges the **current** state id. Retained snapshots restore state;
retained acknowledgements do not count as a fresh connection.
