#!/usr/bin/env python3
"""Run external release probes on GitHub's runner and mirror safe results over Git."""
import json
import os
import re
import subprocess
import time
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

RESULT_REF = "refs/heads/codex/veto-validation-results"
ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "oneshot-external"
REPORT = {"source_sha": os.environ.get("GITHUB_SHA"),
          "run_url": f"https://github.com/{os.environ.get('GITHUB_REPOSITORY')}/actions/runs/{os.environ.get('GITHUB_RUN_ID')}",
          "status": "running", "steps": {}}


def safe(text):
    text = re.sub(r"(https?://[^\s#]+)#[^\s]+", r"\1#[redacted]", text)
    return re.sub(r"(?i)(password|token|authorization)([=:]\s*)[^\s,;]+", r"\1\2[redacted]", text)


def git(*args, **kwargs):
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, **kwargs).stdout.decode().strip()


def publish():
    """Append a small results-only commit; source branches and the index stay intact."""
    REPORT["updated_at"] = datetime.now(timezone.utc).isoformat()
    payload = json.dumps(REPORT, ensure_ascii=False, indent=2) + "\n"
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "result.json").write_text(payload)
    remote = git("ls-remote", "--heads", "origin", RESULT_REF)
    parent = []
    if remote:
        git("fetch", "--no-tags", "origin", RESULT_REF)
        parent = ["-p", git("rev-parse", "FETCH_HEAD")]
    index = OUT / "results-index"
    index.unlink(missing_ok=True)
    settings = dict(os.environ, GIT_INDEX_FILE=str(index),
                    GIT_AUTHOR_NAME="github-actions[bot]",
                    GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com",
                    GIT_COMMITTER_NAME="github-actions[bot]",
                    GIT_COMMITTER_EMAIL="41898282+github-actions[bot]@users.noreply.github.com")
    blob = git("hash-object", "-w", "--stdin", input=payload.encode())
    git("read-tree", "--empty", env=settings)
    git("update-index", "--add", "--cacheinfo", "100644", blob, "result.json", env=settings)
    tree = git("write-tree", env=settings)
    commit = git("commit-tree", tree, *parent, "-m",
                 f"Veto external verification {os.environ.get('GITHUB_RUN_ID')}: {REPORT['status']}", env=settings)
    git("push", "origin", f"{commit}:{RESULT_REF}")


def step(name, command, timeout):
    REPORT["steps"][name] = {"status": "running"}
    publish()
    started = time.monotonic()
    log = OUT / (name + ".log")
    try:
        with log.open("w") as output:
            process = subprocess.run(command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
        status = "passed" if process.returncode == 0 else "failed"
        code = process.returncode
    except subprocess.TimeoutExpired:
        status, code = "timeout", None
    REPORT["steps"][name] = {
        "status": status, "exit_code": code, "seconds": round(time.monotonic() - started, 1),
        "tail": safe(log.read_text(errors="replace")[-16000:])
    }
    print(name, status, flush=True)
    publish()
    return status == "passed"


def public_probe():
    results = []
    for url in [
        "https://oneshot-veto.pages.dev/",
        "https://oneshot-veto.pages.dev/veto.js",
        "https://oneshot-veto.pages.dev/veto-room.js",
        "https://oneshot-veto.pages.dev/api/veto-relay?health=1",
        "https://oneshot-veto.cyberclash.workers.dev/api/veto-relay?health=1",
    ]:
        row = {"url": url}
        try:
            with urllib.request.urlopen(url, timeout=20) as response:
                body = response.read(400000).decode("utf-8", "replace")
                row.update(status=response.status, csp=response.headers.get("Content-Security-Policy"),
                           markers={marker: marker in body for marker in [
                               "vtReconnect", "signRoomMessage", "claimPush", "VDO_CONNECT_TIMEOUT"]})
                if "?health=1" in url:
                    row["health"] = json.loads(body)
        except Exception as error:
            row["error"] = safe(str(error))
        results.append(row)
    REPORT["steps"]["public_endpoints"] = {"status": "observed", "results": results}
    publish()


def prior_failure():
    repository = os.environ["GITHUB_REPOSITORY"]
    meta = subprocess.run(["gh", "api", f"repos/{repository}/actions/artifacts/12108273813"],
                          capture_output=True, text=True, timeout=60)
    row = {"status": "observed"}
    if meta.returncode:
        row.update(status="unavailable", error=safe(meta.stderr[-2000:]))
    else:
        data = json.loads(meta.stdout)
        row["artifact"] = {key: data.get(key) for key in ["id", "name", "expired", "size_in_bytes"]}
        if not data.get("expired") and data.get("size_in_bytes", 0) < 32000000:
            archive = OUT / "prior-failure.zip"
            with archive.open("wb") as output:
                download = subprocess.run(["gh", "api", f"repos/{repository}/actions/artifacts/12108273813/zip"],
                                          stdout=output, stderr=subprocess.PIPE, timeout=90)
            if download.returncode == 0:
                with zipfile.ZipFile(archive) as bundle:
                    row["files"] = bundle.namelist()[:150]
            else:
                row["download_error"] = safe(download.stderr.decode(errors="replace")[-2000:])
    failed = subprocess.run(["gh", "run", "view", "39053299720", "--repo", repository, "--log-failed"],
                            capture_output=True, text=True, timeout=90)
    row["failed_run_log"] = safe((failed.stdout or failed.stderr)[-24000:])
    REPORT["steps"]["prior_real_vdo_failure"] = row
    publish()


def main():
    publish()
    public_probe()
    try:
        prior_failure()
    except Exception as error:
        REPORT["steps"]["prior_real_vdo_failure"] = {"status": "unavailable", "error": safe(str(error))}
        publish()
    if not step("install_playwright", ["python3", "-m", "pip", "install", "playwright"], 180):
        return False
    if not step("install_browsers", ["python3", "-m", "playwright", "install", "--with-deps", "chromium", "webkit"], 360):
        return False
    server_log = (OUT / "server.log").open("w")
    server = subprocess.Popen(["node", "server.js"], cwd=ROOT, stdout=server_log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 20
        while True:
            try:
                with urllib.request.urlopen("http://127.0.0.1:3000/veto.html", timeout=2) as response:
                    if response.status == 200:
                        break
            except OSError:
                pass
            if server.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError("local server did not become ready")
            time.sleep(.3)
        commands = [
            ("webkit_server", ["python3", "scripts/qa_veto_site.py", "--server", "--browser", "webkit",
                               "--artifacts", "artifacts/external-webkit"], 420),
            ("webkit_recovery", ["python3", "scripts/qa_veto_resilience.py", "--browser", "webkit"], 100),
            ("real_vdo", ["python3", "scripts/qa_veto_site.py", "--real-vdo", "--browser", "chromium",
                          "--artifacts", "artifacts/external-real-vdo"], 900),
        ]
        good = True
        for name, command, limit in commands:
            good = step(name, command, limit) and good
        return good
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
        server_log.close()


if __name__ == "__main__":
    passed = False
    try:
        passed = main()
    except Exception as error:
        REPORT["runner_error"] = safe(str(error))
    finally:
        REPORT["status"] = "passed" if passed else "failed"
        publish()
    raise SystemExit(0 if passed else 1)
