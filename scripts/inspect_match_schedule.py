"""Read the official schedule and verify the public panel, without storing roster secrets."""
import json
import hashlib
import os
import subprocess
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from playwright.sync_api import sync_playwright

report = {"source_sha": os.environ.get("GITHUB_SHA"),
          "run_url": f"https://github.com/{os.environ.get('GITHUB_REPOSITORY')}/actions/runs/{os.environ.get('GITHUB_RUN_ID')}",
          "checked_at": datetime.now(ZoneInfo("Europe/Moscow")).isoformat()}

def git(*args, **kwargs):
    return subprocess.run(["git", *args], check=True, capture_output=True, **kwargs).stdout.decode().strip()

try:
    source = r'''
      import {DEFAULT_SOURCE as s, decodeGviz, parseTeams, parseSchedule} from './core.js';
      async function sheet(id, gid, headers) {
        const url = new URL(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq`);
        url.search = new URLSearchParams({gid, headers, tqx:'out:json', _t:String(Date.now())});
        const response = await fetch(url, {signal:AbortSignal.timeout(45000), cache:'no-store'});
        if (!response.ok) throw new Error(`Sheets ${gid}: ${response.status}`);
        return decodeGviz(await response.text());
      }
      const [roster, group, playoffs] = await Promise.all([
        sheet(s.id,s.gid,'0'), sheet(s.scheduleId,s.scheduleGid,'1'), sheet(s.scheduleId,s.playoffsGid,'1')
      ]);
      const teams = parseTeams(roster).map(t => ({name:t.name, main:t.players.filter(p=>p.role==='Основной').length}));
      console.log(JSON.stringify({teams, matches:parseSchedule([...group,...playoffs])}));
    '''
    process = subprocess.run(["node", "--input-type=module", "-e", source], capture_output=True, text=True, timeout=60)
    if process.returncode:
        raise RuntimeError(process.stderr[-1500:])
    official = json.loads(process.stdout)
    today = datetime.now(ZoneInfo("Europe/Moscow"))
    dates = [(today + timedelta(days=i)).strftime("%d.%m") for i in range(14)]
    report["teams"] = official["teams"]
    report["matches"] = [m for m in official["matches"] if m["date"] in dates]
    names = {t["name"] for t in official["teams"]}
    expected = [m for m in report["matches"] if m["team1"] in names and m["team2"] in names]
    report["unresolved"] = [m for m in report["matches"] if m not in expected]
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(locale="ru-RU", timezone_id="Europe/Moscow")
        expected = git("ls-remote", "--heads", "origin", "refs/heads/claude/gracious-sagan-apztcc").split()[0]
        report["expected_build"] = expected
        for attempt in range(36):
            build = page.goto("https://oneshot-panel.pages.dev/build.txt", wait_until="domcontentloaded", timeout=30000)
            report["published_build"] = build.text().strip() if build and build.status == 200 else None
            if report["published_build"] == expected:
                break
            time.sleep(5)
        if report["published_build"] != expected:
            raise RuntimeError("The panel host has not yet published the expected commit")
        app = page.goto("https://oneshot-panel.pages.dev/app.js", wait_until="domcontentloaded", timeout=30000)
        report["app_matches_source"] = hashlib.sha256(app.body()).digest() == hashlib.sha256(Path("app.js").read_bytes()).digest()
        response = page.goto("https://oneshot-panel.pages.dev/", wait_until="domcontentloaded", timeout=45000)
        report["public_status"] = response.status
        page.wait_for_function("() => window.oneshotPanel && document.querySelector('#syncTitle').textContent.includes('команд из таблицы')", timeout=45000)
        page.click("#refreshBtn")
        page.wait_for_function("() => !document.querySelector('#refreshBtn').disabled", timeout=45000)
        report["panel"] = page.evaluate('''() => ({
          error:document.querySelector('#errorBox').hidden ? '' : document.querySelector('#errorBox').textContent,
          sync:document.querySelector('#syncTime').textContent,
          groups:[...document.querySelectorAll('#matchSelect optgroup')].map(g=>({label:g.label,count:g.children.length})),
          schedule:window.oneshotPanel.snapshot().schedule
        })''')
        report["selection_checks"] = []
        for match in expected:
            if match["date"] not in dates[:2]:
                continue
            page.select_option("#matchSelect", match["key"])
            check = page.evaluate('''() => {const s=window.oneshotPanel.snapshot();return {
              team1:s.a.name,team2:s.b.name,time:s.time,stage:s.stage,
              selectedA:s.playersA.filter(Boolean).length,selectedB:s.playersB.filter(Boolean).length,
              matchError:s.matchError
            }}''')
            check["date"] = match["date"]
            check["passed"] = all(check[k] == match[k] for k in ["team1", "team2", "time", "stage"]) and not check["matchError"]
            report["selection_checks"].append(check)
        loaded = report["panel"]["schedule"]
        report["missing"] = [m for m in expected if m not in loaded]
        report["passed"] = report["app_matches_source"] and not report["missing"] and not report["panel"]["error"] and all(c["passed"] for c in report["selection_checks"])
        browser.close()
except Exception as error:
    report["error"] = str(error)
    report["passed"] = False
finally:
    ref = "refs/heads/codex/match-schedule-results"
    payload = (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode()
    with tempfile.TemporaryDirectory() as folder:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(folder) / "index"),
                   GIT_AUTHOR_NAME="github-actions[bot]", GIT_COMMITTER_NAME="github-actions[bot]",
                   GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com",
                   GIT_COMMITTER_EMAIL="41898282+github-actions[bot]@users.noreply.github.com")
        parents = []
        if git("ls-remote", "--heads", "origin", ref):
            git("fetch", "--no-tags", "origin", ref)
            parents = ["-p", git("rev-parse", "FETCH_HEAD")]
        blob = git("hash-object", "-w", "--stdin", input=payload)
        git("read-tree", "--empty", env=env)
        git("update-index", "--add", "--cacheinfo", "100644", blob, "result.json", env=env)
        tree = git("write-tree", env=env)
        commit = git("commit-tree", tree, *parents, "-m", "Verify organizer schedule and public panel", env=env)
        git("push", "origin", f"{commit}:{ref}")
    print(json.dumps({"passed":report.get("passed"), "run_url":report["run_url"], "error":report.get("error")}))
    if not report.get("passed"):
        raise SystemExit(1)
