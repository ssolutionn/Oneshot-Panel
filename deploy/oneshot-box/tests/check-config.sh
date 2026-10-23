#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd -- "$(dirname -- "$0")/.." && pwd)"
source "$HERE/ubuntu-version.env"
grep -q 'UBUNTU_VERSION=24.04.4' "$HERE/ubuntu-version.env"
grep -q 'UBUNTU_SHA256=' "$HERE/ubuntu-version.env"
grep -q '__PASSWORD_HASH__' "$HERE/autoinstall/user-data"
grep -q 'interactive-sections:' "$HERE/autoinstall/user-data"
! grep -q 'layout: { name: direct }' "$HERE/autoinstall/user-data"
grep -q 'User=oneshot-panel' "$HERE/systemd/oneshot-panel.service"
! grep -q 'User=root' "$HERE/systemd/oneshot-panel.service"
grep -q 'CS2_JOURNAL=1' "$HERE/systemd/oneshot-panel.service"
grep -q 'CS2_ALLOW_REMOTE=1' "$HERE/systemd/oneshot-panel.service"
! grep -Eq 'OneshotSecure|password=[^R]|SRCDS_TOKEN=""' "$HERE/cs2"/*
grep -q 'image: cm2network/cs2:latest' "$HERE/cs2/compose.yml"
! grep -q 'provision.sh' "$HERE/autoinstall/user-data"
for f in "$HERE"/scripts/*.sh "$HERE"/tests/*.sh; do bash -n "$f"; done
printf 'Oneshot Box config checks passed\n'
