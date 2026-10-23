#!/usr/bin/env bash
set -euo pipefail
[[ "${EUID}" -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
HERE="$(cd -- "$(dirname -- "$0")/.." && pwd)"
ROOT="$(cd -- "$HERE/../.." && pwd)"
INSTALL=/opt/oneshot-panel
getent passwd oneshot-panel >/dev/null || useradd --system --home-dir /var/lib/oneshot-panel --create-home --shell /usr/sbin/nologin oneshot-panel
install -d -o root -g oneshot-panel -m 0750 "$INSTALL"
if [[ -f "$ROOT/server.js" ]]; then
  tar -C "$ROOT" --exclude='./.git' --exclude='./node_modules' -cf - . | tar -C "$INSTALL" -xf -
else
  echo 'Run this script from an Oneshot-Panel checkout.' >&2; exit 1
fi
chown -R root:root "$INSTALL"
chmod -R a+rX,u+w "$INSTALL"
if [[ ! -f "$INSTALL/.cs2-data/token" ]]; then
  install -d -o oneshot-panel -g oneshot-panel -m 0700 "$INSTALL/.cs2-data"
  umask 077
  openssl rand -base64 24 | tr -d '\n' > "$INSTALL/.cs2-data/token"
  printf '\n' >> "$INSTALL/.cs2-data/token"
fi
chown -R oneshot-panel:oneshot-panel "$INSTALL/.cs2-data"
chmod 0700 "$INSTALL/.cs2-data"
chmod 0600 "$INSTALL/.cs2-data/token"
install -d -o oneshot-panel -g oneshot-panel -m 0700 "$INSTALL/.cs2-data"
install -d -m 0750 /etc/oneshot-box
if ! command -v node >/dev/null || [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]]; then
  echo 'Node.js 22 or newer is required. Install it from a trusted source, then rerun provisioning.' >&2
  exit 1
fi
install -m 0644 "$HERE/systemd/oneshot-panel.service" /etc/systemd/system/oneshot-panel.service
ufw allow 22/tcp
ufw allow 3000/tcp
ufw --force enable
systemctl daemon-reload
systemctl enable --now oneshot-panel.service
printf 'Panel is available at http://%s:3000. CS2 log token is stored in /opt/oneshot-panel/.cs2-data/token (service account only).\n' "$(hostname -I | awk '{print $1}')"
