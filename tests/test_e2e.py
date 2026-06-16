"""Self-contained end-to-end test: launches a real wyc daemon (its own free
port), then asserts the live contract over the wire — hello+snapshot, WS auth,
and the security-jailed /file route. Codifies the manual probes used during W1-W3.

Opt-in (heavy: spawns a daemon + reads real ~/.claude): set WYC_E2E=1. The fast
gate collects this module but skips it instantly; ci/full.sh runs it.
"""
import os
import sys
import json
import time
import socket
import asyncio
import subprocess
import urllib.request
import urllib.error

import pytest

if os.environ.get("WYC_E2E") != "1":
    pytest.skip("e2e: set WYC_E2E=1 (launches a real daemon)", allow_module_level=True)

import aiohttp  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = "/data/clanker/watchyourclankers"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@pytest.fixture(scope="module")
def daemon():
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-u", "-m", "wyc", "serve", "--port", str(port)],
        cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    ok = False
    for _ in range(60):
        try:
            with urllib.request.urlopen(base + "/healthz", timeout=2) as r:
                if r.status == 200:
                    ok = True
                    break
        except Exception:
            time.sleep(0.5)
    if not ok:
        proc.terminate()
        out = proc.stdout.read().decode()[-2000:] if proc.stdout else ""
        pytest.fail(f"daemon did not start on :{port}\n{out}")
    token = None
    for _ in range(20):
        try:
            token = open(os.path.join(DATA_DIR, ".wyc_token")).read().strip()
            if token:
                break
        except Exception:
            time.sleep(0.3)
    time.sleep(3)  # let the first poll populate the snapshot
    try:
        yield base, token
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


def test_ws_hello_then_snapshot(daemon):
    base, token = daemon

    async def go():
        got = {}
        async with aiohttp.ClientSession() as s:
            async with s.ws_connect(f"{base}/ws?token={token}") as ws:
                async def loop():
                    async for m in ws:
                        d = json.loads(m.data)
                        t = d.get("t")
                        if t == "hello":
                            got["hello"] = d
                        elif t == "snapshot":
                            got["snapshot"] = d
                            return
                await asyncio.wait_for(loop(), timeout=15)
        return got

    got = _run(go())
    assert got.get("hello", {}).get("protocol") == 1
    snap = got.get("snapshot")
    assert snap is not None and isinstance(snap.get("sessions"), list)
    assert isinstance(snap.get("threads"), list)


def test_ws_requires_token(daemon):
    base, _token = daemon

    async def go():
        async with aiohttp.ClientSession() as s:
            try:
                async with s.ws_connect(f"{base}/ws"):
                    return 200
            except aiohttp.WSServerHandshakeError as e:
                return e.status

    assert _run(go()) == 401


def test_file_route_serves_redacted(daemon):
    base, token = daemon
    readme = os.path.join(REPO, "README.md")
    with urllib.request.urlopen(f"{base}/file?path={readme}&token={token}", timeout=10) as r:
        assert r.status == 200
        j = json.loads(r.read())
    assert j.get("redacted") is True
    assert j.get("lines", 0) > 0


def test_file_route_jails_outside_root(daemon):
    base, token = daemon
    try:
        urllib.request.urlopen(f"{base}/file?path=/etc/passwd&token={token}", timeout=10)
        assert False, "expected 403 for /etc/passwd"
    except urllib.error.HTTPError as e:
        assert e.code == 403
