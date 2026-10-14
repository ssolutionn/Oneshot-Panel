#!/usr/bin/env python3
"""Copy team logos out of the organizer's spreadsheet into assets/teams/.

The organizer's sheet (CyberClash Season 2 | Spreadsheet) keeps a logo
picture next to each team's heading on its «Teams (...)» tabs. Download
it as .xlsx (Google Sheets: File -> Download -> Microsoft Excel) and run:

    python3 scripts/extract_team_logos.py organizer.xlsx

Each picture is matched to the heading in the cell to its right
("Aces (ex-Black Phoenix) #68 VRS EU"), saved as assets/teams/<slug>.png
(at most 128 px, needs Pillow) and listed in assets/teams/teams.json under
the team name and its ex-name. Entries added by hand stay in teams.json.
"""
import io
import json
import re
import sys
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "teams"
NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    "xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
}


def slug(name):
    plain = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-") or "team"


def names_of(heading):
    """'Aces (ex-Black Phoenix) #68 VRS EU' -> ['Aces', 'Black Phoenix']."""
    text = re.sub(r"\s*#\d+.*$", "", heading).strip()
    ex = re.search(r"\(ex-([^)]+)\)", text)
    main = re.sub(r"\s*\(ex-[^)]*\)", "", text).strip()
    return [main] + ([ex.group(1).strip()] if ex else [])


def rels(z, path):
    folder, name = path.rsplit("/", 1)
    rel_path = f"{folder}/_rels/{name}.rels"
    if rel_path not in z.namelist():
        return {}
    root = ElementTree.fromstring(z.read(rel_path))
    out = {}
    for r in root.findall("rel:Relationship", NS):
        target = r.get("Target")
        if not target.startswith("/"):
            parts = folder.split("/") + target.split("/")
            stack = []
            for part in parts:
                if part == "..":
                    stack.pop()
                elif part:
                    stack.append(part)
            target = "/".join(stack)
        out[r.get("Id")] = target.lstrip("/")
    return out


def cells(z, sheet_path, shared):
    """{(col, row): text} with zero-based indexes."""
    root = ElementTree.fromstring(z.read(sheet_path))
    out = {}
    for c in root.iter(f"{{{NS['m']}}}c"):
        ref = re.match(r"([A-Z]+)(\d+)", c.get("r"))
        col = 0
        for ch in ref.group(1):
            col = col * 26 + ord(ch) - 64
        v = c.find("m:v", NS)
        text = "".join(t.text or "" for t in c.iter(f"{{{NS['m']}}}t"))
        if c.get("t") == "s" and v is not None:
            text = shared[int(v.text)]
        elif v is not None and not text:
            text = v.text or ""
        out[(col - 1, int(ref.group(2)) - 1)] = text.strip()
    return out


def main(xlsx):
    z = zipfile.ZipFile(xlsx)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ElementTree.fromstring(z.read("xl/sharedStrings.xml"))
        shared = ["".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t"))
                  for si in root.findall("m:si", NS)]
    workbook = ElementTree.fromstring(z.read("xl/workbook.xml"))
    sheet_rels = rels(z, "xl/workbook.xml")
    manifest_path = OUT / "teams.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    OUT.mkdir(parents=True, exist_ok=True)
    found = 0
    for sheet in workbook.find("m:sheets", NS):
        if not sheet.get("name", "").lower().startswith("teams"):
            continue
        sheet_path = sheet_rels[sheet.get(f"{{{NS['r']}}}id")]
        text = cells(z, sheet_path, shared)
        for drawing in rels(z, sheet_path).values():
            if "drawings/" not in drawing:
                continue
            images = rels(z, drawing)
            root = ElementTree.fromstring(z.read(drawing))
            for anchor in root:
                start = anchor.find("xdr:from", NS)
                blip = anchor.find(".//a:blip", NS)
                if start is None or blip is None:
                    continue
                col = int(start.find("xdr:col", NS).text)
                row = int(start.find("xdr:row", NS).text)
                heading = text.get((col + 1, row), "")
                if not heading:
                    continue
                names = names_of(heading)
                image = Image.open(io.BytesIO(
                    z.read(images[blip.get(f"{{{NS['r']}}}embed")]))).convert("RGBA")
                image.thumbnail((128, 128))
                file = slug(names[0]) + ".png"
                image.save(OUT / file, optimize=True)
                for name in names:
                    manifest[name] = file
                found += 1
                print(f"{' / '.join(names)} -> assets/teams/{file}")
    manifest_path.write_text(
        json.dumps(dict(sorted(manifest.items())), ensure_ascii=False, indent=2) + "\n")
    print(f"{found} logos; manifest: {manifest_path.relative_to(ROOT)}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
