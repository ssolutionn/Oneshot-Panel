"""Native browser/OBS camera checks, with the existing safe result publisher."""
import os
from pathlib import Path
import subprocess
import time
import urllib.request

import ci_veto_external as evidence

evidence.RESULT_REF="refs/heads/codex/camera-validation-results"
if os.environ.get('GITHUB_REF')=='refs/heads/claude/gracious-sagan-apztcc':
    evidence.RESULT_REF+='-production'
evidence.OUT=Path(os.environ.get("RUNNER_TEMP","/tmp"))/"oneshot-camera-review"


def main():
    evidence.publish()
    setup=[
        ("python_tools",["python3","-m","pip","install","playwright","websockets","pillow"],180),
        ("browsers",["python3","-m","playwright","install","--with-deps","chromium","webkit"],360),
        ("obs_install",["bash","-c",'''
curl --fail --location --retry 2 https://github.com/obsproject/obs-studio/releases/download/32.2.2/OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb --output "$RUNNER_TEMP/oneshot-camera-obs.deb"
sudo apt-get update -qq
sudo apt-get install -y "$RUNNER_TEMP/oneshot-camera-obs.deb" xvfb libgl1-mesa-dri ffmpeg
'''],360),
        ("syntax",["npm","run","check"],60),
        ("node",["npm","test"],120),
        ("artifact",["bash","-c","python3 claude-artifact/build_oneshot_artifact.py\ngit diff --exit-code -- claude-artifact/oneshot-panel.html"],60)
    ]
    for name,command,limit in setup:
        if not evidence.step(name,command,limit): return False
    log=(evidence.OUT/"server.log").open("w")
    server=subprocess.Popen(["node","server.js"],cwd=evidence.ROOT,stdout=log,stderr=subprocess.STDOUT)
    try:
        for attempt in range(40):
            try:
                with urllib.request.urlopen("http://127.0.0.1:3000/",timeout=2) as response:
                    if response.status==200: break
            except OSError:
                if server.poll() is not None: raise RuntimeError("Test server exited during startup")
                time.sleep(.25)
        else: raise RuntimeError("Test server did not become ready")
        os.environ.update(XDG_CONFIG_HOME=str(evidence.OUT/"config"),LIBGL_ALWAYS_SOFTWARE="1",QT_QPA_PLATFORM="xcb")
        commands=[
            ("real_obs",["xvfb-run","-a","-s","-screen 0 1920x1080x24","python3","scripts/qa_camera_obs.py"],240),
            ("real_vdo_api",["python3","scripts/qa_camera.py","--real-provider","--artifacts","artifacts/camera-provider"],120),
            ("editor_chromium",["python3","scripts/qa_camera.py","--artifacts","artifacts/camera-chromium"],180),
            ("editor_webkit",["python3","scripts/qa_camera.py","--browser","webkit","--artifacts","artifacts/camera-webkit"],180),
            ("veto_server_chromium",["python3","scripts/qa_veto_site.py","--server","--pretty-links","--focus-match","--artifacts","artifacts/veto-zoom-chromium"],360),
            ("veto_server_webkit",["python3","scripts/qa_veto_site.py","--server","--pretty-links","--browser","webkit","--focus-match","--artifacts","artifacts/veto-zoom-webkit"],240),
            ("notifications",["python3","scripts/qa_notifications.py"],120),
            ("panel_chromium",["python3","scripts/qa_browser.py","--artifacts","artifacts/camera-panel-chromium"],360),
            ("panel_webkit",["python3","scripts/qa_browser.py","--browser","webkit","--artifacts","artifacts/camera-panel-webkit"],360),
            ("obs_lobby",["python3","scripts/qa_live.py","--artifacts","artifacts/camera-live"],360)
        ]
        good=True
        for name,command,limit in commands:
            good=evidence.step(name,command,limit) and good
        return good
    finally:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill()
        log.close()


if __name__=="__main__":
    passed=False
    try: passed=main()
    except Exception as error: evidence.REPORT["runner_error"]=evidence.safe(str(error))
    finally:
        evidence.REPORT["status"]="passed" if passed else "failed"
        evidence.publish()
    raise SystemExit(0 if passed else 1)
