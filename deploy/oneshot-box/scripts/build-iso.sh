#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd -- "$(dirname -- "$0")/.." && pwd)"
source "$HERE/ubuntu-version.env"
INPUT="${1:-$HERE/build/$UBUNTU_ISO}"
OUTPUT="${2:-$HERE/build/oneshot-box-$UBUNTU_VERSION-amd64.iso}"
command -v xorriso >/dev/null || { echo 'Install xorriso first.' >&2; exit 1; }
command -v mkpasswd >/dev/null || { echo 'Install whois (mkpasswd) first.' >&2; exit 1; }
[[ -f "$INPUT" ]] || { echo "Missing base ISO: $INPUT" >&2; exit 1; }
[[ -n "${ONESHOT_PASSWORD:-}" ]] || { echo 'Set ONESHOT_PASSWORD without putting it in a command argument.' >&2; exit 1; }
[[ "$ONESHOT_PASSWORD" != *$'\n'* ]] || { echo 'Password must be one line.' >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HASH="$(printf '%s' "$ONESHOT_PASSWORD" | mkpasswd --method=sha-512 --stdin)"
python3 -I - "$HERE/autoinstall/user-data" "$TMP/user-data" "$HASH" <<'PY'
import pathlib, sys
src, dst, password_hash = map(pathlib.Path, sys.argv[1:])
text = src.read_text()
if text.count('__PASSWORD_HASH__') != 1:
    raise SystemExit('password placeholder must occur exactly once')
dst.write_text(text.replace('__PASSWORD_HASH__', str(password_hash)))
PY
# Add the NoCloud seed at the installer lookup path, preserving hybrid BIOS/UEFI boot.
mkdir -p "$(dirname "$OUTPUT")"
xorriso -indev "$INPUT" -outdev "$OUTPUT" \
  -boot_image any replay \
  -volid ONESHOT_BOX \
  -map "$TMP/user-data" /nocloud/user-data \
  -map "$HERE/autoinstall/meta-data" /nocloud/meta-data \
  -boot_image any replay

# The seed is on the installer media, but boot menu activation is intentionally not patched here.
echo 'WARNING: Boot with autoinstall ds=nocloud;s=/cdrom/nocloud/ and verify in a disposable VM before hardware use.' >&2
