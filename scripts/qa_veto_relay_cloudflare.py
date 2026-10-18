#!/usr/bin/env python3
"""Actual Pages proxy, internal service binding, workerd and SQLite Durable Objects."""
import json
import subprocess
import time
import tempfile
from pathlib import Path
from urllib.request import urlopen
from urllib.error import URLError, HTTPError
base = "http://127.0.0.1:8791/api/veto-relay"
with tempfile.TemporaryDirectory(prefix="oneshot-pages-service-") as temporary, open("/tmp/oneshot-workerd.log", "w") as log:
    root = Path.cwd()
    pages = Path(temporary) / "pages"
    subprocess.run(["npx", "--yes", "wrangler@4.151.1", "pages", "functions", "build", "functions", "--outdir", str(pages)],
                   check=True, stdout=log, stderr=log)
    config = Path(temporary) / "wrangler.jsonc"
    config.write_text(json.dumps({"name": "oneshot-veto-pages-local", "main": str(pages / "index.js"),
        "compatibility_date": "2026-10-01",
        "assets": {"directory": str(root / "dist-veto"), "binding": "ASSETS", "run_worker_first": ["/api/veto-relay"]},
        "services": [{"binding": "VETO_RELAY_SERVICE", "service": "oneshot-veto"}]}))
    process = subprocess.Popen(["npx", "--yes", "wrangler@4.151.1", "dev", "--config", str(config),
                                "--config", str(root / "dist-veto/wrangler.jsonc"),
                                "--local", "--port", "8791", "--ip", "127.0.0.1"], stdout=log, stderr=log)
    try:
        deadline = time.monotonic() + 120
        while True:
            try:
                with urlopen(base + "?health=1", timeout=3) as response:
                    assert json.load(response) == {"protocol": 1, "ready": True}
                break
            except (URLError, HTTPError, OSError):
                if process.poll() is not None or time.monotonic() > deadline:
                    raise AssertionError(Path("/tmp/oneshot-workerd.log").read_text())
                time.sleep(1)
        # Real crypto publisher and client through Cloudflare's HTTP routing.
        subprocess.run(["node", "--input-type=module", "-e", """
import assert from 'node:assert/strict';
import {createRoom,decodeLink,captainKey,roomSecrets} from './veto-room.js';
import {seal,unseal} from './vdo.js';
import {signRelayPacket} from './assets/veto-relay-protocol.js';
const url='http://127.0.0.1:8791/api/veto-relay';
const made=await createRoom('http://localhost/veto.html',['A','B'],'BO3',5,url);
const room=decodeLink(new URL(made.links.a).hash),key=await captainKey(room),secrets=await roomSecrets(room);
const box=await seal(secrets.key,{t:'log',log:[],p:room.p});
const packet=await signRelayPacket(key,room.p[0],box);
const result=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(packet)});
assert.equal(result.status,200,await result.text());
const get=await fetch(url+'?topics='+packet.topic+','+room.fp[1]);
const body=await get.json();
assert.equal(body.records.length,1);
assert.deepEqual(await unseal(secrets.key,body.records[0].packet.box),{t:'log',log:[],p:room.p});
const html=await fetch('http://127.0.0.1:8791/');
assert.equal(html.status,200);
assert.match(await html.text(),/vtTransport/);
console.log('PASS: real Pages proxy + internal service + SQLite Durable Object signatures, encrypted state, multi-topic read and static assets');
"""], check=True)
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
