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

1. In the existing **oneshot-veto Worker** connected to this generated repo,
   deploy the committed wrangler.jsonc with **npx wrangler deploy**.
   It adds the VETO_RELAY binding and a SQLite Durable Object migration.
   Keep the old Worker domain enabled; do not replace the migration tag
   on subsequent deployments. Static VDO links at that domain still work.
2. Pages deploys the same repo with functions/api/veto-relay.js. It forwards
   only this API to the fixed Worker address configured in that file.
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
site using nginx/Caddy, and reverse proxy **/api/veto-relay** (all GET/POST/
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
