#!/usr/bin/env python3
"""Prepare local HLTV photos before publishing the static site.

The browser never contacts HLTV. Only verified local filenames enter the
manifest. Missing or failed downloads leave the approved no-photo card usable.

  python3 scripts/fetch_player_photos.py                 # strict maintenance
  python3 scripts/fetch_player_photos.py --allow-missing # site build
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
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
LOCAL_FILE = re.compile(r"^[\w.-]+\.(png|jpe?g|webp)$", re.IGNORECASE)


def local_photo(filename):
    if not isinstance(filename, str) or not LOCAL_FILE.fullmatch(filename):
        raise ValueError("invalid local filename")
    path = LIST.parent / filename
    if path.resolve().parent != LIST.parent.resolve():
        raise ValueError("photo leaves its catalog")
    extension = image_extension(path.read_bytes())
    if path.suffix.lower().replace(".jpeg", ".jpg") != extension:
        raise ValueError("image type does not match filename")
    return filename


def base_name(entry):
    kind, number, slug = HREF.fullmatch(entry["hltv"]).groups()
    return f"{slug.lower()}-{'c' if kind == 'coach' else ''}{number}"


def image_extension(data):
    if len(data) > LIMIT:
        raise ValueError("larger than 4 MB")
    for magic, extension in TYPES.items():
        if data.startswith(magic) and (magic != b"RIFF" or data[8:12] == b"WEBP"):
            return extension
    raise ValueError("not an image")


def fetch(url):
    request = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Oneshot Panel player cards)",
        "Accept": "image/png,image/webp,image/*;q=0.8",
    })
    with urllib.request.urlopen(request, timeout=12) as response:
        data = response.read(LIMIT + 1)
    return data, image_extension(data)


def prepare(task):
    base, photo, force = task
    existing = sorted(p for p in LIST.parent.glob(base + ".*")
                      if p.is_file() and p.suffix in TYPES.values())
    cached = None
    for path in existing:
        try:
            if image_extension(path.read_bytes()) == path.suffix:
                cached = path
                break
        except (OSError, ValueError):
            pass
    if cached and not force:
        return base, cached.name, "kept", ""
    try:
        data, extension = fetch(photo)
        target = LIST.parent / (base + extension)
        temporary = target.with_name(target.name + ".download")
        temporary.write_bytes(data)
        temporary.replace(target)
        for old in existing:
            if old != target:
                old.unlink()
        return base, target.name, "saved", ""
    except Exception as error:
        # A failed refresh retains a previously validated image.
        return base, cached.name if cached else None, "failed", str(error)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--force", action="store_true", help="refresh cached photos")
    parser.add_argument("--allow-missing", action="store_true",
                        help="publish fallback cards when individual photos fail")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    document = json.loads(LIST.read_text(encoding="utf-8"))
    players = document["players"]
    tasks, entries = {}, {}
    invalid = 0
    local = 0
    for entry in players:
        photo = entry.get("photo")
        # Venue portraits do not require an HLTV identity. --force must not
        # replace an explicitly selected local portrait with an HLTV image.
        if entry.get("source") == "local" or (not photo and entry.get("file")):
            try:
                entry["file"] = local_photo(entry.get("file"))
                local += 1
            except (OSError, ValueError) as error:
                entry["file"] = None
                invalid += 1
                print(f"  ! {entry.get('nick', '?')}: {error}; using fallback")
            continue
        entry["file"] = None
        if not photo:
            continue
        if (not isinstance(photo, str) or not PHOTO.fullmatch(photo) or
                not isinstance(entry.get("hltv"), str) or not HREF.fullmatch(entry["hltv"])):
            print(f"  ! {entry.get('nick', '?')}: invalid HLTV URL, using fallback")
            invalid += 1
            continue
        base = base_name(entry)
        # Repeated roster entries for the same HLTV identity share one file.
        tasks.setdefault(base, (base, photo, args.force))
        entries.setdefault(base, []).append(entry)

    saved = kept = 0
    failed = invalid
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 6))) as pool:
        for base, filename, status, error in pool.map(prepare, tasks.values()):
            for entry in entries[base]:
                entry["file"] = filename
            saved += status == "saved"
            kept += status == "kept"
            failed += status == "failed"
            if error:
                print(f"  ! {base}: {error}; " + ("keeping cached photo" if filename else "using fallback"))
    temporary = LIST.with_name(LIST.name + ".tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False, indent=1) + "\n",
                         encoding="utf-8")
    temporary.replace(LIST)
    available = sum(bool(p.get("file")) for p in players)
    print(f"Photos: {saved} downloaded, {kept} cached, {local} local, {failed} failed; "
          f"{available}/{len(players)} players have local photos, "
          f"{len(players) - available} use fallback cards.")
    return 1 if failed and not args.allow_missing else 0


if __name__ == "__main__":
    sys.exit(main())
