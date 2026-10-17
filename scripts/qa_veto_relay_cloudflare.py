#!/usr/bin/env python3
"""Actual workerd + SQLite Durable Objects, not a mocked storage binding."""
import json
import subprocess
import time
from pathlib import Path
from urllib.request import urlopen
from urllib.error import URLError, HTTPError
base = "http://127.0.0.1:8791/api/veto-relay"
with open("/tmp/oneshot-workerd.log", "w") as log:
    process = subprocess.Popen(["npx", "--yes", "wrangler@4", "dev", "--local", "--port", "8791", "--ip", "127.0.0.1"],
                               cwd="dist-veto", stdout=log, stderr=log)
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
console.log('PASS: real workerd + SQLite Durable Object signatures, encrypted state, multi-topic read and static assets');
"""], check=True)
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
