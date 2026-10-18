"""Photo preparation protects the published manifest without live network calls."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "photos", Path(__file__).resolve().parent.parent / "scripts" / "fetch_player_photos.py")
photos = importlib.util.module_from_spec(spec)
spec.loader.exec_module(photos)
PNG = b"\x89PNG\r\n\x1a\n" + b"test-photo"
URL = "https://img-cdn.hltv.org/playerbodyshot/example.png?w=400&s=x"


class PhotoPreparation(unittest.TestCase):
    def entry(self, nick="senka", number=22878):
        return {"team": "Team", "nick": nick,
                "hltv": f"https://www.hltv.org/player/{number}/{nick}",
                "photo": URL, "file": "stale.png"}

    def run_case(self, entries, result=None, error=None, arguments=(), cached=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "players.json"
            path.write_text(json.dumps({"players": entries}), encoding="utf-8")
            if cached:
                for name, data in cached.items():
                    (path.parent / name).write_bytes(data)
            with patch.object(photos, "LIST", path), patch.object(
                    sys, "argv", ["photos", "--workers", "1", *arguments]), patch.object(
                    photos, "fetch", return_value=result, side_effect=error) as fetch, contextlib.redirect_stdout(io.StringIO()):
                status = photos.main()
                document = json.loads(path.read_text())
                files = {p.name: p.read_bytes() for p in path.parent.iterdir()
                         if p.suffix in (".png", ".jpg", ".webp")}
                calls = fetch.call_count
            return status, document["players"], files, calls

    def test_download_sets_a_real_local_file(self):
        status, entries, files, calls = self.run_case(
            [self.entry()], (PNG, ".png"))
        self.assertEqual(status, 0)
        self.assertEqual(entries[0]["file"], "senka-22878.png")
        self.assertEqual(files["senka-22878.png"], PNG)
        self.assertEqual(calls, 1)

    def test_failed_download_removes_stale_manifest_reference(self):
        status, entries, files, _ = self.run_case(
            [self.entry()], error=OSError("unavailable"), arguments=("--allow-missing",))
        self.assertEqual(status, 0)
        self.assertIsNone(entries[0]["file"])
        self.assertEqual(files, {})

    def test_strict_mode_reports_failure(self):
        status, entries, _, _ = self.run_case(
            [self.entry()], error=OSError("unavailable"))
        self.assertEqual(status, 1)
        self.assertIsNone(entries[0]["file"])

    def test_force_failure_keeps_a_valid_cached_photo(self):
        status, entries, files, _ = self.run_case(
            [self.entry()], error=OSError("unavailable"), arguments=("--force",),
            cached={"senka-22878.png": PNG})
        self.assertEqual(status, 1)
        self.assertEqual(entries[0]["file"], "senka-22878.png")
        self.assertEqual(files["senka-22878.png"], PNG)

    def test_missing_and_invalid_urls_use_fallback_without_network(self):
        missing = self.entry()
        missing["photo"] = None
        invalid = self.entry("other", 123)
        invalid["photo"] = "https://example.org/not-hltv.png"
        status, entries, _, calls = self.run_case(
            [missing, invalid], arguments=("--allow-missing",))
        self.assertEqual(status, 0)
        self.assertTrue(all(p["file"] is None for p in entries))
        self.assertEqual(calls, 0)

    def test_shared_hltv_identity_is_downloaded_once(self):
        status, entries, _, calls = self.run_case(
            [self.entry(), self.entry()], (PNG, ".png"))
        self.assertEqual(status, 0)
        self.assertEqual(calls, 1)
        self.assertEqual(entries[0]["file"], entries[1]["file"])

    def test_non_images_are_rejected(self):
        with self.assertRaises(ValueError):
            photos.image_extension(b"<html>blocked</html>")
        with self.assertRaises(ValueError):
            photos.image_extension(b"RIFFxxxxAVI ")

    def test_local_portrait_survives_normal_and_forced_build_without_hltv(self):
        for arguments in ((), ("--force",)):
            entry = {"team": "LAN team", "nick": "Player", "source": "local",
                     "file": "lan-player.png"}
            status, entries, files, calls = self.run_case(
                [entry], arguments=arguments, cached={"lan-player.png": PNG})
            self.assertEqual(status, 0)
            self.assertEqual(entries[0]["file"], "lan-player.png")
            self.assertEqual(files["lan-player.png"], PNG)
            self.assertEqual(calls, 0)

    def test_local_selection_overrides_hltv_and_rejects_missing_or_unsafe_files(self):
        local = {**self.entry(), "source": "local", "file": "venue.png"}
        status, entries, _, calls = self.run_case(
            [local], arguments=("--force",), cached={"venue.png": PNG})
        self.assertEqual((status, entries[0]["file"], calls), (0, "venue.png", 0))
        for name, data in (("../escape.png", PNG), ("absent.png", None),
                           ("fake.png", b"<html>not a photo</html>")):
            with self.subTest(name=name):
                status, entries, _, calls = self.run_case(
                    [{**local, "file": name}], cached={name: data} if data and "/" not in name else {})
                self.assertEqual((status, entries[0]["file"], calls), (1, None, 0))


if __name__ == "__main__":
    unittest.main()
