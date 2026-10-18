#!/usr/bin/env python3
"""Run external release probes on GitHub's runner and mirror safe results over Git."""
import json
import hashlib
import os
import re
import subprocess
import time
import urllib.request
import urllib.error
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
    text = re.sub(r"\b(?:cfut_|cfat_)[A-Za-z0-9_-]+", "[redacted]", text)
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
    diagnostics = []
    for file in (ROOT / "artifacts").glob("**/connection-timeout.json"):
        if file.stat().st_size < 100000:
            diagnostics.append({"file": str(file.relative_to(ROOT)), "state": json.loads(file.read_text())})
    if diagnostics:
        REPORT["steps"][name]["diagnostics"] = diagnostics
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
        except urllib.error.HTTPError as error:
            row.update(error=safe(str(error)), server=error.headers.get("server"),
                       content_type=error.headers.get("content-type"),
                       cf_mitigated=error.headers.get("cf-mitigated"),
                       body=safe(error.read(1200).decode("utf-8", "replace")))
        except Exception as error:
            row["error"] = safe(str(error))
        results.append(row)
    REPORT["steps"]["public_endpoints"] = {"status": "observed", "results": results}
    publish()


def public_browser_probe():
    """Use an ordinary browser when Cloudflare rejects the Python HTTP client."""
    from playwright.sync_api import sync_playwright

    results = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page()
        try:
            for url in [
                "https://oneshot-veto.pages.dev/",
                "https://oneshot-veto.pages.dev/veto.js",
                "https://oneshot-veto.pages.dev/veto-room.js",
                "https://oneshot-veto.pages.dev/veto.css",
                "https://oneshot-veto.pages.dev/vdo.js",
                "https://oneshot-veto.pages.dev/api/veto-relay?health=1",
                "https://oneshot-veto.cyberclash.workers.dev/api/veto-relay?health=1",
            ]:
                row = {"url": url}
                try:
                    response = page.goto(url, wait_until="domcontentloaded", timeout=20000)
                    if response is None:
                        raise RuntimeError("navigation returned no HTTP response")
                    body = response.body()[:400000].decode("utf-8", "replace")
                    row.update(status=response.status, content_type=response.headers.get("content-type"),
                               csp=response.headers.get("content-security-policy"),
                               cf_mitigated=response.headers.get("cf-mitigated"),
                               markers={marker: marker in body for marker in [
                                   "vtTransport", "vtReconnect", "signRoomMessage", "claimPush",
                                   "--vt-ct:#7fb2f0", "--vt-t:#f0a95e",
                                   "background:var(--vt-ct); color:var(--vt-bg)",
                                   "background:var(--vt-t); color:var(--vt-bg)",
                                   "VDO_CONNECT_TIMEOUT = 30000"]})
                    file = url.rsplit("/", 1)[-1] or "veto.html"
                    if file in ["veto.html", "veto.js", "veto.css", "veto-room.js", "vdo.js"]:
                        row["matches_source"] = hashlib.sha256(response.body()).digest() == hashlib.sha256(
                            (ROOT / file).read_bytes()).digest()
                    if "?health=1" in url:
                        try:
                            row["health"] = json.loads(body)
                        except ValueError:
                            row["health_error"] = "expected JSON"
                    if response.status != 200:
                        row["body"] = safe(body[:1200])
                except Exception as error:
                    row["error"] = safe(str(error))
                results.append(row)
        finally:
            browser.close()
    REPORT["steps"]["public_browser_endpoints"] = {"status": "observed", "results": results}
    publish()
    return all(row.get("status") == 200 and (
        row.get("health", {}).get("ready") is True and row.get("health", {}).get("protocol") == 1
        if "?health=1" in row["url"] else row.get("matches_source") is True
    ) for row in results)


def wait_deployment():
    for attempt in range(18):
        command = subprocess.run(["gh", "api", "repos/ssolutionn/Oneshot-Veto/actions/runs?branch=main&per_page=1"],
                                 capture_output=True, text=True, timeout=30)
        if command.returncode:
            return
        runs = json.loads(command.stdout).get("workflow_runs", [])
        if not runs:
            return
        run = runs[0]
        REPORT["steps"]["deployment_wait"] = {key: run.get(key) for key in [
            "status", "conclusion", "head_sha", "html_url"]}
        jobs = subprocess.run(["gh", "api", f"repos/ssolutionn/Oneshot-Veto/actions/runs/{run['id']}/jobs"],
                              capture_output=True, text=True, timeout=30)
        if jobs.returncode == 0:
            REPORT["steps"]["deployment_wait"]["job_steps"] = [
                {key: item.get(key) for key in ["name", "status", "conclusion"]}
                for job in json.loads(jobs.stdout).get("jobs", []) for item in job.get("steps", [])]
        publish()
        if run.get("status") == "completed":
            return
        time.sleep(10)


def deployment_metadata():
    """Read existing Pages/Worker checks without changing any deployment."""
    results = []
    for ref in ["main", "codex%2Fveto-resilience-review"]:
        row = {"ref": ref.replace("%2F", "/")}
        for suffix in ["status", "check-runs"]:
            command = subprocess.run([
                "gh", "api", f"repos/ssolutionn/Oneshot-Veto/commits/{ref}/{suffix}"
            ], capture_output=True, text=True, timeout=30)
            if command.returncode:
                row[suffix] = {"error": safe(command.stderr[-1500:])}
                continue
            data = json.loads(command.stdout)
            if suffix == "status":
                row[suffix] = {"sha": data.get("sha"), "state": data.get("state"),
                               "statuses": [{key: status.get(key) for key in [
                                   "context", "state", "description", "target_url"]}
                                            for status in data.get("statuses", [])]}
            else:
                row[suffix] = [{key: check.get(key) for key in [
                    "name", "head_sha", "status", "conclusion", "details_url"]}
                               for check in data.get("check_runs", [])]
        results.append(row)
    REPORT["steps"]["deployment_metadata"] = {"status": "observed", "results": results}
    command = subprocess.run(["gh", "api", "repos/ssolutionn/Oneshot-Veto/actions/runs?branch=main&per_page=3"],
                             capture_output=True, text=True, timeout=30)
    if command.returncode == 0:
        runs = json.loads(command.stdout).get("workflow_runs", [])
        REPORT["deployment_runs"] = [{key: run.get(key) for key in [
            "id", "name", "head_sha", "status", "conclusion", "html_url"]} for run in runs]
        for run in runs[:1]:
            if run.get("conclusion") == "failure":
                logs = subprocess.run(["gh", "run", "view", str(run["id"]), "--repo", "ssolutionn/Oneshot-Veto", "--log-failed"],
                                      capture_output=True, text=True, timeout=40)
                REPORT["deployment_failure"] = safe((logs.stdout or logs.stderr)[-7000:])
    else:
        REPORT["deployment_runs_error"] = safe(command.stderr[-1500:])
    command = subprocess.run(["gh", "api", "repos/ssolutionn/Oneshot-Veto/pulls/2"],
                             capture_output=True, text=True, timeout=30)
    if command.returncode == 0:
        pull = json.loads(command.stdout)
        REPORT["site_pull_request"] = {key: pull.get(key) for key in ["number", "state", "merged", "merge_commit_sha", "html_url"]}
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
    if os.environ.get("VETO_EXTERNAL_MODE") == "public":
        wait_deployment()
        deployment_metadata()
    public_probe()
    REPORT["cloudflare_bindings"] = {key: bool(os.environ.get(key)) for key in
                                     ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]}
    if os.environ.get("CLOUDFLARE_API_TOKEN"):
        try:
            request = urllib.request.Request("https://api.cloudflare.com/client/v4/user/tokens/verify",
                      headers={"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"]})
            with urllib.request.urlopen(request, timeout=20) as response:
                result = json.load(response)
                REPORT["cloudflare_token_active"] = bool(result.get("success") and result.get("result", {}).get("status") == "active")
        except Exception as error:
            REPORT["cloudflare_token_check"] = safe(str(error))
    publish()
    if os.environ.get("VETO_EXTERNAL_MODE") != "public":
        try:
            prior_failure()
        except Exception as error:
            REPORT["steps"]["prior_real_vdo_failure"] = {"status": "unavailable", "error": safe(str(error))}
            publish()
    if not step("install_playwright", ["python3", "-m", "pip", "install", "playwright"], 180):
        return False
    browsers = ["chromium"] if os.environ.get("VETO_EXTERNAL_MODE") == "public" else ["chromium", "webkit"]
    if not step("install_browsers", ["python3", "-m", "playwright", "install", "--with-deps", *browsers], 360):
        return False
    public_ready = public_browser_probe()
    if os.environ.get("VETO_EXTERNAL_MODE") == "public":
        deployment_metadata()
        if not public_ready:
            REPORT["public_journeys"] = "not run: deployed files or relay health are not ready"
            publish()
            return True
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
            ("webkit_recovery", ["python3", "scripts/qa_veto_resilience.py", "--browser", "webkit"], 150),
            ("real_vdo", ["python3", "scripts/qa_veto_site.py", "--real-vdo", "--browser", "chromium",
                          "--artifacts", "artifacts/external-real-vdo"], 900),
        ]
        if os.environ.get("VETO_EXTERNAL_MODE") == "public":
            commands = [
                ("public_server_matches", ["python3", "scripts/qa_veto_site.py", "--server", "--focus-match",
                    "--url", "https://oneshot-veto.pages.dev", "--artifacts", "artifacts/public-server-matches"], 420),
                ("public_server_recovery", ["python3", "scripts/qa_veto_site.py", "--server", "--focus-recovery",
                    "--url", "https://oneshot-veto.pages.dev", "--artifacts", "artifacts/public-server-recovery"], 300),
                ("public_server_overlay", ["python3", "scripts/qa_veto_relay_overlay.py", "--veto-site",
                    "https://oneshot-veto.pages.dev/veto.html"], 240),
            ]
        if os.environ.get("VETO_EXTERNAL_MODE") == "recovery":
            commands = [
                ("real_vdo_recovery", ["python3", "scripts/qa_veto_site.py", "--focus-recovery", "--real-vdo",
                                       "--browser", "chromium", "--artifacts", "artifacts/external-real-recovery"], 360),
                ("chromium_recovery", ["python3", "scripts/qa_veto_resilience.py", "--browser", "chromium"], 150),
                ("webkit_recovery", ["python3", "scripts/qa_veto_resilience.py", "--browser", "webkit"], 150),
            ]
        good = True
        for name, command, limit in commands:
            good = step(name, command, limit) and good
        if good and os.environ.get("VETO_EXTERNAL_MODE") == "recovery":
            good = step("real_vdo_full", ["python3", "scripts/qa_veto_site.py", "--real-vdo", "--browser", "chromium",
                                          "--artifacts", "artifacts/external-real-vdo"], 900)
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
