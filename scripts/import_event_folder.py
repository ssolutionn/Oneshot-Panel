#!/usr/bin/env python3
"""Import a LAN event folder into the player cards and print its teams.

The folder (from Google Drive) holds one subfolder per team: a photo per
player named by the nick (PNG with a transparent background, e.g. an iPhone
cut-out) and the team's logo.png. Photos are trimmed to the person, scaled for
the 1920×1080 card and saved as local entries of assets/players/players.json
("source": "local"); logos go to assets/teams/teams.json. A team imported again
replaces its earlier photos. The printed lines go into the panel's «ЛАН» dialog.

  python3 scripts/import_event_folder.py <folder>           # check only
  python3 scripts/import_event_folder.py <folder> --write   # update the catalogs
"""
import argparse
import hashlib
import io
import json
import re
import sys
import unicodedata
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
IMAGES = {".png", ".jpg", ".jpeg", ".webp"}
UNSUPPORTED = {".heic", ".heif"}
LOGO_NAMES = {"logo", "лого", "логотип", "emblem"}
PHOTO_BOX = (1200, 1200)   # the card shows the photo 1150 px tall
LOGO_BOX = (512, 512)
LIMIT = 4 * 1024 * 1024    # scripts/fetch_player_photos.py refuses larger files
CYRILLIC = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюяіїє",
                    ["a", "b", "v", "g", "d", "e", "yo", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p",
                     "r", "s", "t", "u", "f", "h", "ts", "ch", "sh", "sch", "", "y", "", "e", "yu", "ya",
                     "i", "yi", "ye"]))


def person_key(value):
    """core.personKey: case, spaces and punctuation do not count."""
    text = unicodedata.normalize("NFKC", str(value)).lower()
    return "".join(c for c in text if c.isalnum())


def slug(value):
    """An ASCII file name part: the panel only serves [\\w.-] names."""
    text = "".join(CYRILLIC.get(c, c) for c in str(value).lower())
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:40].strip("-")
    return text or "x" + hashlib.sha1(str(value).encode()).hexdigest()[:8]


def nick_of(path):
    # Google Drive renames a repeated upload «nick (1).png».
    return re.sub(r"\s*\(\d+\)$", "", path.stem).strip()


def scan(folder):
    """{team: {"logo": path|None, "players": {nick: path}}} and problems."""
    teams, problems = {}, []
    for path in sorted(folder.rglob("*")):
        if not path.is_file() or any(part.startswith((".", "__MACOSX")) for part in path.relative_to(folder).parts):
            continue
        suffix = path.suffix.lower()
        if suffix in UNSUPPORTED:
            problems.append(f"{path.relative_to(folder)}: HEIC не читается браузером и OBS — сохрани как PNG")
            continue
        if suffix not in IMAGES:
            continue
        if path.parent == folder:
            problems.append(f"{path.name}: лежит вне папки команды — положи в папку «Команда»")
            continue
        team = path.parent.name.strip()
        entry = teams.setdefault(team, {"logo": None, "players": {}})
        if path.stem.strip().lower() in LOGO_NAMES:
            entry["logo"] = path
            continue
        nick = nick_of(path)
        if not nick:
            problems.append(f"{path.relative_to(folder)}: пустой ник")
        elif any(person_key(n) == person_key(nick) for n in entry["players"]):
            problems.append(f"{team}: ник {nick} встречается дважды — взят первый файл")
        else:
            entry["players"][nick] = path
    return teams, problems


def prepare(path, box, kind):
    """Trimmed and scaled image bytes and a warning, if any."""
    image = ImageOps.exif_transpose(Image.open(path))
    warning = ""
    if "A" not in image.getbands() and not (image.mode == "P" and "transparency" in image.info):
        warning = "без прозрачного фона"
    image = image.convert("RGBA")
    box_alpha = image.getchannel("A").getbbox()
    if box_alpha:
        image = image.crop(box_alpha)
    image.thumbnail(box, Image.LANCZOS)
    out = io.BytesIO()
    if kind == "photo":
        image.save(out, "WEBP", quality=90, method=6)
    else:
        image.save(out, "PNG", optimize=True)
    data = out.getvalue()
    if len(data) > LIMIT:
        raise ValueError("больше 4 МБ после сжатия")
    return data, warning


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("folder", type=Path)
    parser.add_argument("--write", action="store_true", help="update assets and catalogs")
    parser.add_argument("--assets", type=Path, default=ROOT / "assets", help=argparse.SUPPRESS)
    args = parser.parse_args()
    folder = args.folder.resolve()
    if not folder.is_dir():
        sys.exit(f"Нет папки {folder}")
    teams, problems = scan(folder)
    if not teams:
        sys.exit("Не нашлось ни одной папки команды с картинками.")

    players_dir, teams_dir = args.assets / "players", args.assets / "teams"
    catalog_path, logos_path = players_dir / "players.json", teams_dir / "teams.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    logos = json.loads(logos_path.read_text(encoding="utf-8"))
    imported = {person_key(team) for team in teams}
    # Re-importing a team replaces its venue photos.
    dropped = [p for p in catalog["players"] if p.get("source") == "local" and person_key(p.get("team", "")) in imported]
    catalog["players"] = [p for p in catalog["players"] if p not in dropped]
    files, added, lines = {}, [], []
    for team, entry in teams.items():
        team_slug = slug(team)
        nicks = sorted(entry["players"], key=str.casefold)
        for nick in nicks:
            name = f"lan-{team_slug}-{slug(nick)}.webp"
            if name in files:
                name = f"lan-{team_slug}-{slug(nick)}-{hashlib.sha1(nick.encode()).hexdigest()[:6]}.webp"
            try:
                data, warning = prepare(entry["players"][nick], PHOTO_BOX, "photo")
            except Exception as error:  # a broken file must not stop the rest
                problems.append(f"{team} / {nick}: фото не прочиталось ({error}) — будет карточка без фото")
                continue
            if warning:
                problems.append(f"{team} / {nick}: {warning}")
            files[name] = (players_dir, data)
            added.append({"team": team, "nick": nick, "source": "local", "file": name})
        if entry["logo"]:
            try:
                data, warning = prepare(entry["logo"], LOGO_BOX, "logo")
                logo_name = f"lan-{team_slug}.png"
                files[logo_name] = (teams_dir, data)
                logos[team] = logo_name
                if warning:
                    problems.append(f"{team} / лого: {warning}")
            except Exception as error:
                problems.append(f"{team} / лого: не прочиталось ({error})")
        else:
            problems.append(f"{team}: нет logo.png — будет буква вместо лого")
        lines.append(f"{team}: {', '.join(nicks)}" if nicks else f"# {team}: нет фото игроков — впиши ники вручную")

    if args.write:
        for name, (directory, data) in files.items():
            (directory / name).write_bytes(data)
        catalog["players"].extend(added)
        kept = {p.get("file") for p in catalog["players"]}
        for old in dropped:
            name = old.get("file")
            if isinstance(name, str) and name.startswith("lan-") and name not in kept and (players_dir / name).is_file():
                (players_dir / name).unlink()
        catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        logos_path.write_text(json.dumps(dict(sorted(logos.items())),
                                         ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"Команд: {len(teams)}, фото: {len(added)}, лого: {sum(1 for t in teams.values() if t['logo'])}"
          + ("" if args.write else " (проверка, без записи — добавь --write)"))
    for problem in problems:
        print("  ! " + problem)
    print("\nСтроки для окна «ЛАН»:\n" + "\n".join(lines))


if __name__ == "__main__":
    main()
