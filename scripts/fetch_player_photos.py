#!/usr/bin/env python3
"""Download the HLTV bodyshots listed in assets/players/players.json.

Every entry with a "photo" URL (img-cdn.hltv.org/playerbodyshot/...) is saved
next to the list as <nick>-<hltv id>.png, and its "file" is filled in. The
player card (card.html) only uses entries that have a file, so a photo that
failed to download simply leaves the team logo on the card.

Run it again after adding players or when a download failed; files already on
disk are kept (--force downloads them again). Needs network access to
img-cdn.hltv.org; no third-party packages.

  python3 scripts/fetch_player_photos.py
"""
import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIST = ROOT / "assets" / "players" / "players.json"
PHOTO = re.compile(r"^https://img-cdn\.hltv\.org/playerbodyshot/[\w-]+\.png\?[^\s]+$")
HREF = re.compile(r"^https://www\.hltv\.org/(player|coach)/(\d+)/([\w.-]+)$")
TYPES = {b"\x89PNG\r\n\x1a\n": ".png", b"\xff\xd8\xff": ".jpg", b"RIFF": ".webp"}
LIMIT = 4 * 1024 * 1024


def base_name(entry):
    kind, number, slug = HREF.match(entry["hltv"]).groups()
    return f"{slug.lower()}-{'c' if kind == 'coach' else ''}{number}"


def fetch(url):
    request = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Oneshot Panel player cards)",
        "Accept": "image/png,image/webp,image/*;q=0.8",
    })
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError("larger than 4 MB")
    for magic, extension in TYPES.items():
        if data.startswith(magic) and (magic != b"RIFF" or data[8:12] == b"WEBP"):
            return data, extension
    raise ValueError("not an image")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--force", action="store_true",
                        help="download again even if the file exists")
    args = parser.parse_args()

    document = json.loads(LIST.read_text(encoding="utf-8"))
    saved = kept = failed = 0
    for entry in document["players"]:
        photo = entry.get("photo")
        if not photo:
            entry["file"] = None
            continue
        if not PHOTO.match(photo) or not HREF.match(entry.get("hltv", "")):
            print(f"  ! {entry['nick']}: not an HLTV bodyshot, skipped")
            failed += 1
            continue
        base = base_name(entry)
        existing = [p for p in LIST.parent.glob(base + ".*") if p.suffix in TYPES.values()]
        if existing and not args.force:
            entry["file"] = existing[0].name
            kept += 1
            continue
        try:
            data, extension = fetch(photo)
        except Exception as error:  # noqa: BLE001 - report and keep going
            print(f"  ! {entry['nick']}: {error}")
            failed += 1
            continue
        for old in existing:
            old.unlink()
        (LIST.parent / (base + extension)).write_bytes(data)
        entry["file"] = base + extension
        saved += 1
        print(f"  + {entry['team']} · {entry['nick']}")

    LIST.write_text(json.dumps(document, ensure_ascii=False, indent=1) + "\n",
                    encoding="utf-8")
    total = sum(1 for e in document["players"] if e.get("photo"))
    print(f"Photos: {saved} downloaded, {kept} already there, {failed} failed "
          f"(of {total} players with an HLTV photo).")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
