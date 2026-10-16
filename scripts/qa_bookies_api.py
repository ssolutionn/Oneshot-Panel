"""Observe the deployed read-only API against the bookmakers' real public feeds."""
import argparse
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen


def run(args):
    ids = json.loads(subprocess.check_output([
        "node", "--input-type=module", "-e",
        "import {BOOKMAKERS} from './bookmakers.js'; console.log(JSON.stringify(BOOKMAKERS.map(b=>b.id)))"
    ], text=True))
    base = args.url.rstrip("/")

    def observe(bookmaker):
        request = Request(base + "/api/bookmakers?id=" + bookmaker,
                          headers={"Cache-Control": "no-cache"})
        with urlopen(request, timeout=35) as reply:
            assert reply.status == 200
            assert reply.headers.get("X-Content-Type-Options") == "nosniff"
            body = json.load(reply)
        assert body["id"] == bookmaker and isinstance(body["ok"], bool)
        assert isinstance(body["events"], list) and isinstance(body["checkedAt"], (int, float))
        return {"id": bookmaker, "ok": body["ok"], "events": len(body["events"]),
                "errors": body.get("errors", [])}

    with ThreadPoolExecutor(max_workers=len(ids)) as executor:
        results = list(executor.map(observe, ids))
    for result in results:
        print("BOOKMAKER_PUBLIC_API:", json.dumps(result, ensure_ascii=False), flush=True)
    assert any(result["ok"] for result in results), "All public feeds are unavailable from this hosting region."
    print("PASS: deployed read-only bookmaker API; provider availability recorded separately", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    run(parser.parse_args())
