# Oneshot Box: Ubuntu installer and panel host

This package is an early Ubuntu Server 24.04.4 LTS amd64 installer prototype based on the official release ISO. It does not include Ubuntu or CS2 game files. The installer is intended to pause at disk configuration; select and confirm the intended disk in Subiquity. No target disk is intentionally selected by this project. The ISO builder/autoinstall flow has not yet been boot-tested in a VM; test only in a disposable VM first, not on hardware.

## Download and build

Requires Linux, `xorriso`, `whois` (`mkpasswd`), `curl`, `shasum`, and Python 3. The download is multi-gigabyte; do not add the ISO to Git.

```sh
./deploy/oneshot-box/scripts/download-ubuntu-iso.sh
read -rsp 'Temporary oneshot password: ' ONESHOT_PASSWORD; echo
export ONESHOT_PASSWORD
./deploy/oneshot-box/scripts/build-iso.sh
unset ONESHOT_PASSWORD
```

The download script checks Ubuntu's official checksum list against a locally pinned SHA-256 before and after download. The password is read from the environment, never included in a URL or command-line argument; the generated image contains its SHA-512 crypt hash. Treat the image as private and change the temporary account password after install. SSH password authentication is enabled by the installer; use SSH keys and disable password login after initial setup for production. The builder is not yet proven to preserve bootability or activate NoCloud autoinstall; validate it in a disposable VM before use.

## Install the panel

After installing Ubuntu, clone/check out this repository locally and run from its root:

```sh
sudo ./deploy/oneshot-box/scripts/provision.sh
```

This is currently a manual post-install step: the ISO seed does not yet copy the Oneshot application onto the installed OS or trigger provisioning. Do not expect the panel to be available immediately after Ubuntu finishes installing.

The service runs as the locked `oneshot-panel` account. The CS2 journal token is stored in `/opt/oneshot-panel/.cs2-data/token`, readable only to that service account and root, matching the panel's `loadToken()` contract. UFW permits SSH (22/tcp) and panel (3000/tcp). The panel currently has no user authentication; expose it only on a trusted, isolated LAN and never forward port 3000 from the internet. The remote CS2 log endpoint requires its token (`CS2_ALLOW_REMOTE=1`); the token is a URL parameter in the game's `logaddress_add_http` command, so use only a trusted network or a protected transport. Node.js 22+ is required; provisioning checks for Node but does not install it or promise offline package installation. Install Node from a trusted source before running provisioning. The installer currently does not transfer the app bundle or invoke provisioning automatically.

## Optional CS2 server

CS2 is separate and optional; no SteamCMD, game files, Steam credentials, or server token are baked into the ISO. On a trusted host with Docker Compose, copy `cs2/env.example` to `cs2/.env`, fill values locally, and set permissions with `chmod 600 cs2/.env`. Keep the real file out of Git. Review `cs2/compose.yml`, then run `docker compose -f deploy/oneshot-box/cs2/compose.yml up -d`. Install `cs2/oneshot.cfg` into the server config after replacing its panel address and journal token locally; never share or commit the configured file. Use a private LAN/VPN or a properly secured TLS reverse proxy for telemetry, since the CS2 log token is a query parameter and HTTP alone is not confidential.

## Checks

```sh
./deploy/oneshot-box/tests/check-config.sh
npm run check
npm test
```
