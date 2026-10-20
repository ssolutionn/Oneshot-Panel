"""LAN event folder import: team folders, trimmed photos, logos and catalogs."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

spec = importlib.util.spec_from_file_location(
    "import_event", Path(__file__).resolve().parent.parent / "scripts" / "import_event_folder.py")
event = importlib.util.module_from_spec(spec)
spec.loader.exec_module(event)


def cutout(path, size=(3000, 4000), person=(1000, 600, 2000, 3800)):
    """An iPhone-like cut-out: a person on a transparent background."""
    image = Image.new("RGBA", size, (0, 0, 0, 0))
    image.paste((200, 120, 80, 255), person)
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)


class EventImport(unittest.TestCase):
    def run_import(self, build, write=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder, assets = root / "LAN", root / "assets"
            (assets / "players").mkdir(parents=True)
            (assets / "teams").mkdir(parents=True)
            (assets / "players" / "players.json").write_text(json.dumps({"_about": "x", "players": [
                {"team": "Old", "nick": "keep", "source": "local", "file": "keep.webp"},
                {"team": "Team Alpha", "nick": "gone", "source": "local", "file": "lan-team-alpha-gone.webp"}]}),
                encoding="utf-8")
            (assets / "players" / "lan-team-alpha-gone.webp").write_bytes(b"old")
            (assets / "teams" / "teams.json").write_text(json.dumps({"Zeta": "zeta.png"}), encoding="utf-8")
            build(folder)
            out = io.StringIO()
            argv = ["import", str(folder), "--assets", str(assets)] + (["--write"] if write else [])
            with patch.object(sys, "argv", argv), contextlib.redirect_stdout(out):
                event.main()
            players = json.loads((assets / "players" / "players.json").read_text(encoding="utf-8"))
            logos = json.loads((assets / "teams" / "teams.json").read_text(encoding="utf-8"))
            # The temporary folder is gone after the with-block: keep the bytes.
            files = {p.name: p.read_bytes() for p in (assets / "players").iterdir()}
            files.update({"teams/" + p.name: p.read_bytes() for p in (assets / "teams").iterdir()})
            return out.getvalue(), players, logos, files

    def test_team_folders_become_photos_logos_and_lan_lines(self):
        def build(folder):
            cutout(folder / "Team Alpha" / "Nick2.png")
            cutout(folder / "Team Alpha" / "nick1 (1).png")
            cutout(folder / "Team Alpha" / "logo.png", (800, 800), (100, 100, 700, 700))
            cutout(folder / "Браво" / "Игрок.png")
            Image.new("RGB", (400, 600), "white").save(folder / "Браво" / "flat.jpg")
            (folder / "Браво" / "notes.txt").write_text("x")
        output, players, logos, files = self.run_import(build)
        self.assertIn("Team Alpha: nick1, Nick2", output)
        self.assertIn("Браво: flat, Игрок", output)
        self.assertIn("Браво / flat: без прозрачного фона", output)
        self.assertIn("Браво: нет logo.png", output)
        local = {(p["team"], p["nick"]): p["file"] for p in players["players"]}
        self.assertEqual(local[("Old", "keep")], "keep.webp")
        self.assertNotIn(("Team Alpha", "gone"), local)
        self.assertNotIn("lan-team-alpha-gone.webp", files)
        self.assertEqual(local[("Team Alpha", "nick1")], "lan-team-alpha-nick1.webp")
        self.assertEqual(local[("Браво", "Игрок")], "lan-bravo-igrok.webp")
        self.assertTrue(all(p.get("source") == "local" for p in players["players"]))
        self.assertEqual(logos, {"Team Alpha": "lan-team-alpha.png", "Zeta": "zeta.png"})
        # Trimmed to the person and scaled for the 1150 px tall card photo.
        with Image.open(io.BytesIO(files["lan-team-alpha-nick1.webp"])) as photo:
            self.assertEqual(photo.format, "WEBP")
            self.assertEqual(photo.size[1], 1200)
            self.assertLess(photo.size[0], 500)
        with Image.open(io.BytesIO(files["teams/lan-team-alpha.png"])) as logo:
            self.assertEqual(logo.size, (512, 512))

    def test_check_only_writes_nothing_and_reports_heic(self):
        def build(folder):
            cutout(folder / "Team Alpha" / "nick1.png")
            (folder / "Team Alpha" / "IMG_0001.HEIC").write_bytes(b"heic")
            cutout(folder / "loose.png")
        output, players, logos, files = self.run_import(build, write=False)
        self.assertIn("без записи", output)
        self.assertIn("HEIC не читается", output)
        self.assertIn("loose.png: лежит вне папки команды", output)
        self.assertEqual(len(players["players"]), 2)
        self.assertEqual(logos, {"Zeta": "zeta.png"})
        self.assertNotIn("lan-team-alpha-nick1.webp", files)


if __name__ == "__main__":
    unittest.main()
