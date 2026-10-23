#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd -- "$(dirname -- "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$HERE/ubuntu-version.env"
DEST="${1:-$HERE/build}"
mkdir -p "$DEST"
ISO="$DEST/$UBUNTU_ISO"
SUMS="$DEST/SHA256SUMS"
curl --fail --location --retry 3 --output "$SUMS" "$UBUNTU_SHA256SUMS_URL"
EXPECTED="$(awk -v name="$UBUNTU_ISO" '$2 == name || $2 == "*" name {print $1}' "$SUMS")"
[[ "${EXPECTED,,}" == "${UBUNTU_SHA256,,}" ]] || { echo "Official SHA256SUMS does not match pinned Ubuntu checksum" >&2; exit 1; }
curl --fail --location --retry 3 --output "$ISO.part" "$UBUNTU_URL"
ACTUAL="$(shasum -a 256 "$ISO.part" | awk '{print $1}')"
if [[ "${ACTUAL,,}" != "${UBUNTU_SHA256,,}" ]]; then
  echo "ISO checksum mismatch" >&2
  rm -f "$ISO.part"
  exit 1
fi
mv "$ISO.part" "$ISO"
printf 'Verified official Ubuntu ISO: %s\nSHA256: %s\n' "$ISO" "$ACTUAL"
