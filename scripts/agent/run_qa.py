#!/usr/bin/env python3
"""Обёртка над браузерными сценариями: запускает `qa_*.py` и пишет JSON.

Сценарии остаются как есть: пройденный шаг — строка `PASS: имя`. Обёртка
добавляет то, чего у них не было: машинный результат, класс ошибки и
одинаковое поведение под пультом `scripts/agent-test.mjs`.

Вывод дочернего процесса идёт в файл, а не в pipe: на Windows в песочнице
именованные каналы запрещены, а CI это не мешает.

    python scripts/agent/run_qa.py --report out.json --log qa.log \
        scripts/qa_browser.py --url http://127.0.0.1:3000 --artifacts artifacts/x
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PASS_LINE = re.compile(r"^PASS:\s*(.+?)\s*$")
ANSI = re.compile(r"\x1b\[[0-9;]*m")

# Ошибки, которые лечатся установкой инструмента, а не правкой кода.
ENV_SIGNS = (
    ("ModuleNotFoundError", "нет python-модуля (pip install)"),
    ("No module named", "нет python-модуля (pip install)"),
    ("Executable doesn't exist", "не установлен браузер Playwright"),
    ("playwright install", "нужен `playwright install`"),
    ("ECONNREFUSED", "сервер не отвечает"),
    ("EADDRINUSE", "порт занят"),
    ("PermissionError", "нет доступа к файлу (песочница или права)"),
    ("WinError 5", "нет доступа к файлу (песочница или права)"),
)


def classify(text):
    for sign, reason in ENV_SIGNS:
        if sign in text:
            return "env", reason
    return None, ""


def tail(text, lines=40):
    kept = [line for line in text.splitlines() if line.strip()]
    return "\n".join(kept[-lines:])


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True)
    parser.add_argument("--log", default=None)
    parser.add_argument("script")
    parser.add_argument("rest", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)

    script = args.script
    rest = list(args.rest)
    if rest and rest[0] == "--":
        rest = rest[1:]

    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    log_path = Path(args.log) if args.log else report_path.with_suffix(".stdout.log")
    log_path.parent.mkdir(parents=True, exist_ok=True)

    started = time.monotonic()
    result = {
        "script": script,
        "args": rest,
        "status": "error",
        "exitCode": None,
        "durationMs": 0,
        "scenarios": [],
        "error": "",
        "errorClass": None,
    }

    if not (ROOT / script).is_file():
        result["error"] = f"нет сценария {script}"
        result["errorClass"] = "env"
        write_report(report_path, result, started)
        print(f"[agent] {script}: error — {result['error']}", flush=True)
        return 2

    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"

    # stdout и stderr ребёнка — один файл: порядок строк сохраняется, pipe не нужен.
    with open(log_path, "w", encoding="utf-8", errors="replace") as sink:
        child = subprocess.Popen(
            [sys.executable, str(ROOT / script), *rest],
            cwd=str(ROOT),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=sink,
            stderr=subprocess.STDOUT,
        )
        try:
            code = child.wait()
        except KeyboardInterrupt:
            child.kill()
            code = 130

    output = ""
    if log_path.is_file():
        output = ANSI.sub("", log_path.read_text(encoding="utf-8", errors="replace"))

    result["exitCode"] = code
    result["scenarios"] = [
        {"id": match.group(1), "status": "pass"} for match in map(PASS_LINE.match, output.splitlines()) if match
    ]

    if code == 0:
        result["status"] = "pass"
    else:
        error_class, _ = classify(output)
        result["status"] = "error" if error_class else "fail"
        result["errorClass"] = error_class
        result["error"] = tail(output)

    write_report(report_path, result, started)

    # Человеку — тот же вывод, что был у сценария, и короткий итог.
    if output:
        sys.stdout.write(output)
        if not output.endswith("\n"):
            sys.stdout.write("\n")
    passed = len(result["scenarios"])
    print(f"[agent] {script}: {result['status']} (сценариев: {passed}, код {code})", flush=True)
    return 0 if code == 0 else 1


def write_report(path, result, started):
    result["durationMs"] = int((time.monotonic() - started) * 1000)
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
