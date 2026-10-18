#!/usr/bin/env python3
"""Actual Pages proxy, internal service binding, workerd and SQLite Durable Objects."""
import json
import os
import signal
import socket
import shutil
import subprocess
import time
import tempfile
from pathlib import Path
from urllib.request import urlopen
from urllib.error import URLError, HTTPError
from verify_veto_deployment import verify
with socket.socket() as available:
    available.bind(('127.0.0.1',0))
    port=available.getsockname()[1]
base = f"http://127.0.0.1:{port}/api/veto-relay"
with tempfile.TemporaryDirectory(prefix="oneshot-pages-service-") as temporary, open("/tmp/oneshot-workerd.log", "w") as log:
    root = Path.cwd()
    pages = Path(temporary) / "pages"
    subprocess.run(["npx", "--yes", "wrangler@4.151.1", "pages", "functions", "build", "functions", "--outdir", str(pages)],
                   check=True, stdout=log, stderr=log)
    config = Path(temporary) / "wrangler.jsonc"
    config.write_text(json.dumps({"name": "oneshot-veto-pages-local", "main": str(pages / "index.js"),
        "compatibility_date": "2026-10-01",
        "assets": {"directory": str(root / "dist-veto"), "binding": "ASSETS", "run_worker_first": ["/api/veto-relay", "/api/veto-link", "/*_*"]},
        "services": [{"binding": "VETO_RELAY_SERVICE", "service": "oneshot-veto"}]}))
    process = subprocess.Popen(["npx", "--yes", "wrangler@4.151.1", "dev", "--config", str(config),
                                "--config", str(root / "dist-veto/wrangler.jsonc"),
                                "--local", "--port", str(port), "--ip", "127.0.0.1"], stdout=log, stderr=log, start_new_session=True)
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
import {packCaptainLink,resolveRoomLink} from './assets/veto-short-links.js';
const origin='http://127.0.0.1:'+process.env.VETO_WORKERD_PORT;
const url=origin+'/api/veto-relay';
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
const html=await fetch(origin+'/');
assert.equal(html.status,200);
assert.match(await html.text(),/vtTransport/);
const packed=await packCaptainLink(made.links.a,'CyberClash');
const shortApi=origin+'/api/veto-link';
const options={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(packed.record)};
const saved=await fetch(shortApi,options);assert.equal(saved.status,200,await saved.text());
assert.equal((await fetch(shortApi,options)).status,200);
const changed=structuredClone(packed.record);changed.box.iv='AAAAAAAAAAAAAAAA';
assert.equal((await fetch(shortApi,{...options,body:JSON.stringify(changed)})).status,409);
const pretty=new URL(packed.link);pretty.port=process.env.VETO_WORKERD_PORT;pretty.hostname='127.0.0.1';
const resolved=await resolveRoomLink(pretty.href,fetch,null);
assert.equal(resolved.room.r,made.room.r);
const prettyPage=await fetch(pretty.href);assert.equal(prettyPage.status,200);
assert.match(await prettyPage.text(),/vtTournament/);
console.log('PASS: real Pages proxy + internal service + SQLite Durable Object signatures, encrypted state, multi-topic read and static assets');
console.log('PASS: real immutable encrypted tournament/team links, conflict rejection and pretty-path routing');
"""], check=True,env={**os.environ,'VETO_WORKERD_PORT':str(port)})
        verify(f'http://127.0.0.1:{port}',root/'dist-veto',1,shutil.which('chromium'))
    finally:
        try: os.killpg(process.pid,signal.SIGTERM)
        except ProcessLookupError: pass
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGKILL)
