"""Browser QA for the «Сервер» tab (the referee's journal of a CS2 server).

It starts its own panel servers: one with CS2_JOURNAL=1 and a fake RCON
server in Python, one without (the hosted case, where the tab must not show),
then plays a short match log into the first one:

  python3 scripts/qa_cs2.py --chromium /path/to/chrome
"""
import argparse
import asyncio
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
TOKEN = "qa-token-0123456789abcdef"
A = '"nick1<2><[U:1:111]><CT>"'
B = '"nick2<3><[U:1:222]><TERRORIST>"'
EVIL = '"<img src=x onerror=window.__pwned=1><4><[U:1:333]><TERRORIST>"'
LOG = [
    'World triggered "Match_Start" on "de_mirage"',
    'Team playing "CT": Alpha',
    'Team playing "TERRORIST": Bravo',
    'World triggered "Round_Start"',
    f'{A} say "ready?"',
    f'{EVIL} say "<script>window.__pwned=2</script>"',
    f'{A} [1 2 3] attacked {B} [4 5 6] with "ak47" (damage "27") (damage_armor "0") (health "73") (armor "100") (hitgroup "chest")',
    f'{A} [1 2 3] killed {B} [4 5 6] with "ak47" (headshot penetrated)',
    f'{B} triggered "Planted_The_Bomb"',
    'Team "CT" triggered "SFUI_Notice_CTs_Win" (CT "1") (T "0")',
    'World triggered "Round_End"',
    'World triggered "Round_Start"',
    f'{B} [1 2 3] killed {A} [4 5 6] with "awp"',
]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def packet(pid, kind, body):
    data = body.encode()
    return struct.pack("<iii", 10 + len(data), pid, kind) + data + b"\0\0"


async def fake_rcon(port, said):
    """Source RCON: password «pw», every command is recorded."""
    async def client(reader, writer):
        try:
            while True:
                size = struct.unpack("<i", await reader.readexactly(4))[0]
                pid, kind = struct.unpack("<ii", await reader.readexactly(8))
                body = (await reader.readexactly(size - 8))[:-2].decode()
                if kind == 3:
                    writer.write(packet(pid, 0, ""))
                    writer.write(packet(pid if body == "pw" else -1, 2, ""))
                elif kind == 2:
                    said.append(body)
                    writer.write(packet(pid, 0, "ok"))
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()
    return await asyncio.start_server(client, "127.0.0.1", port)


def start_panel(port, **env):
    process = subprocess.Popen(["node", "server.js"], cwd=ROOT, env={**os.environ, "PORT": str(port), **env},
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(80):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1).read(1)
            return process
        except Exception:
            time.sleep(0.1)
    process.kill()
    raise SystemExit("the panel server did not start")


def post_log(port, lines, token=TOKEN, http=False):
    # http: the form CS2's logaddress_add_http sends («MM/DD/YYYY - HH:MM:SS.mmm - …», no «L »)
    stamp = (lambda i: f"10/20/2026 - 18:32:{i % 60:02d}.250 - ") if http else (lambda i: f"L 10/20/2026 - 18:31:{i % 60:02d}: ")
    request = urllib.request.Request(f"http://127.0.0.1:{port}/api/cs2-log?token={token}", data="\n".join(
        stamp(i) + line for i, line in enumerate(lines)).encode(), method="POST")
    return urllib.request.urlopen(request, timeout=5).status


async def run(args):
    out = Path(args.artifacts) / "cs2"
    out.mkdir(parents=True, exist_ok=True)
    said = []
    rcon_port, panel_port, plain_port = free_port(), free_port(), free_port()
    rcon = await fake_rcon(rcon_port, said)
    panel = start_panel(panel_port, CS2_JOURNAL="1", CS2_LOG_TOKEN=TOKEN, CS2_RCON_PASSWORD="pw", CS2_RCON_PORT=str(rcon_port),
                        VETO_RELAY_DIR=str(out / "relay-a"))
    plain = start_panel(plain_port, VETO_RELAY_DIR=str(out / "relay-b"))
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(executable_path=args.chromium, headless=True)
            context = await browser.new_context(viewport={"width": 1300, "height": 1000}, permissions=["clipboard-read", "clipboard-write"])
            await context.route("https://docs.google.com/**", lambda route: route.abort())
            await context.route("https://vdo.ninja/**", lambda route: route.fulfill(body="<html></html>", content_type="text/html"))
            errors = []

            # The hosted panel has no journal: no tab.
            hosted = await context.new_page()
            await hosted.goto(f"http://127.0.0.1:{plain_port}/")
            await hosted.wait_for_timeout(1500)
            await expect(hosted.locator("#serverNavBtn")).to_be_hidden()
            await hosted.close()

            page = await context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            await page.goto(f"http://127.0.0.1:{panel_port}/")
            await expect(page.locator("#serverNavBtn")).to_be_visible(timeout=10000)
            await page.click("#serverNavBtn")
            await expect(page.locator("#serverView")).to_be_visible()
            await expect(page.locator("#serverStatus")).to_contain_text("Ждём лог от сервера CS2")

            # The setup commands carry the token and go to the clipboard.
            await page.click("#serverSetup")
            await expect(page.locator("#toast")).to_contain_text("Три команды скопированы")
            copied = await page.evaluate("navigator.clipboard.readText()")
            assert f'logaddress_add_http "http://127.0.0.1:{panel_port}/api/cs2-log?token={TOKEN}"' in copied, copied
            assert "mp_logdetail 3" in copied and "log on" in copied

            # A wrong token is refused; the right one fills the journal.
            try:
                post_log(panel_port, LOG, token="wrong")
                raise AssertionError("a wrong token was accepted")
            except urllib.error.HTTPError as error:
                assert error.code == 403
            assert post_log(panel_port, LOG) == 200
            await expect(page.locator("#serverStatus")).to_contain_text("de_mirage", timeout=8000)
            await expect(page.locator("#serverStatus")).to_contain_text("Alpha")
            await expect(page.locator("#serverStatus")).to_contain_text("1 : 0")
            await expect(page.locator("#serverStatus")).to_contain_text("раунд 2")
            await expect(page.locator("#serverDot")).to_have_attribute("data-kind", "good")
            # The running round shows the awp kill; round 1 holds everything else.
            await expect(page.locator("#serverLog")).to_contain_text("nick2 убил nick1 · awp")
            await page.locator("#serverRounds button", has_text="1").first.click()
            log = page.locator("#serverLog")
            await expect(log).to_contain_text("nick1 убил nick2 · ak47 · хедшот · через стену")
            await expect(log).to_contain_text("nick1 → nick2: 27 (ak47, chest), осталось 73")
            await expect(log).to_contain_text("nick1: ready?")
            await expect(log).to_contain_text("поставил бомбу")
            await expect(log).to_contain_text("Победа CT")
            # Names and chat from the game are text, never markup.
            await expect(log).to_contain_text("<img src=x onerror=window.__pwned=1>")
            await expect(log).to_contain_text("<script>window.__pwned=2</script>")
            assert await page.evaluate("document.querySelectorAll('#serverLog img, #serverLog script').length") == 0
            assert await page.evaluate("window.__pwned") is None
            # CT and T are told apart by colour classes.
            assert await page.locator("#serverLog .side-ct").count() >= 2 and await page.locator("#serverLog .side-t").count() >= 2
            await page.screenshot(path=str(out / "cs2-journal.png"))
            # Filters
            await page.uncheck("#serverShowChat")
            await expect(log).not_to_contain_text("ready?")
            await page.uncheck("#serverShowDamage")
            await expect(log).not_to_contain_text("27 (ak47")
            await page.check("#serverShowChat")
            await page.check("#serverShowDamage")
            # A round as text, for a dispute
            await page.click("#serverCopyRound")
            await expect(page.locator("#toast")).to_contain_text("Раунд 1 скопирован")
            text = await page.evaluate("navigator.clipboard.readText()")
            assert text.startswith("Раунд 1 · de_mirage\n") and "nick1 (CT) убил nick2 (T) · ak47" in text, text
            # A line to the server's chat goes out by RCON
            await page.fill("#serverSay", 'Раунд не переигрываем"; quit')
            await page.click("#serverSayForm button")
            await expect(page.locator("#toast")).to_contain_text("Отправлено в чат сервера")
            assert said == ["say Раунд не переигрываем', quit"], said
            # More lines arrive while the tab is open; the running round follows them
            await page.locator("#serverRounds button", has_text="Идущий").click()
            post_log(panel_port, ['World triggered "Round_End"', 'Team "TERRORIST" triggered "SFUI_Notice_Terrorists_Win" (CT "1") (T "1")',
                                  'World triggered "Round_Start"', f'{A} say "gl hf"'])
            await expect(page.locator("#serverStatus")).to_contain_text("1 : 1", timeout=8000)
            await expect(page.locator("#serverStatus")).to_contain_text("раунд 3")
            await expect(log).to_contain_text("nick1: gl hf")
            # The next map, in CS2's own HTTP form: round 1 again, the last map's round 1 apart.
            post_log(panel_port, ['Loading map "de_inferno"', 'World triggered "Match_Start" on "de_inferno"', 'World triggered "Round_Start"',
                                  f'{A} say "inferno now"'], http=True)
            await expect(page.locator("#serverStatus")).to_contain_text("de_inferno", timeout=8000)
            await expect(page.locator("#serverStatus")).to_contain_text("0 : 0")
            await expect(log).to_contain_text("nick1: inferno now")
            await expect(log).not_to_contain_text("ready?")
            await expect(page.locator("#serverRounds")).to_contain_text("de_mirage")
            await page.click("#serverCopyRound")
            await expect(page.locator("#toast")).to_contain_text("Раунд 1 скопирован")
            text = await page.evaluate("navigator.clipboard.readText()")
            assert text.startswith("Раунд 1 · de_inferno\n") and "inferno now" in text and "ak47" not in text, text
            await page.locator("#serverRounds button", has_text="1").first.click()
            await expect(log).to_contain_text("nick1 убил nick2 · ak47")
            await page.locator("#serverRounds button", has_text="Идущий").click()
            # 375 px: no sideways scroll
            await page.set_viewport_size({"width": 375, "height": 800})
            assert not await page.evaluate("document.documentElement.scrollWidth > innerWidth")
            await page.screenshot(path=str(out / "cs2-mobile.png"))
            assert not errors, errors
            await browser.close()
        # Other computers do not get the journal.
        for path, method in (("/api/cs2-status", "GET"),):
            request = urllib.request.Request(f"http://127.0.0.1:{panel_port}{path}", method=method, headers={"Host": "evil.example"})
            try:
                urllib.request.urlopen(request, timeout=5)
                raise AssertionError("a foreign Host reached the journal")
            except urllib.error.HTTPError as error:
                assert error.code == 403
        print("PASS: «Сервер» tab: hidden on the hosted site, token-protected log in, rounds with kills/damage/chat/bomb, "
              "game text stays text, filters, round copied as text, say through RCON, live follow, 375 px, foreign Host refused")
    finally:
        for process in (panel, plain):
            process.kill()
        rcon.close()


if __name__ == "__main__":
    import urllib.error  # noqa: F401  (HTTPError is used above)
    parser = argparse.ArgumentParser()
    parser.add_argument("--chromium", default=None)
    parser.add_argument("--artifacts", default="artifacts")
    asyncio.run(run(parser.parse_args()))
