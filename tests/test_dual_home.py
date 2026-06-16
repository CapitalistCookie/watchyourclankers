"""Dual-home tests: the SAME wyc app works standalone AND embedded in a host
(clanker) without forked code. Guards the merge seam (Spec: merge into clanker,
keep standalone) so the embed path can't silently rot.

What's asserted:
  * default build_app installs the built-in local-token auth (standalone);
  * build_app(auth=None) installs NO wyc auth — the host (clanker) owns it;
  * build_app(auth=<mw>) uses the injected middleware;
  * url_prefix is recorded for the host;
  * WYC_DATA_DIR relocates contract.DATA_DIR (standalone-without-clanker / tests).

Self-contained (no shared conftest); explicit event loop + aiohttp TestServer,
matching tests/test_serverhook.py.
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from wyc import contract  # noqa: E402
from wyc.server import build_app, auth_middleware, _K_PREFIX  # noqa: E402


@pytest.fixture()
def isolated_data_dir(monkeypatch, tmp_path):
    """Point contract.DATA_DIR at a temp dir so the token file lands in throwaway
    space (Principle I — we only ever write under DATA_DIR)."""
    d = str(tmp_path / "wycdata")
    os.makedirs(d, exist_ok=True)
    monkeypatch.setattr(contract, "DATA_DIR", d)
    return d


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


async def _statuses(app, paths):
    """Spin the app on a TestServer (ONE loop), GET each path with no auth, return
    the list of statuses. Batched so an app is never reused across event loops."""
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        out = []
        for path in paths:
            resp = await client.get(path)
            out.append(resp.status)
        return out
    finally:
        await client.close()


def _status(app, path):
    return _run(_statuses(app, [path]))[0]


# ── auth seam ────────────────────────────────────────────────────────────────
def test_default_installs_token_auth(isolated_data_dir):
    app = build_app(object())
    assert auth_middleware in app.middlewares, "standalone must install the local-token auth"
    # unauthenticated /file is rejected by the token auth BEFORE the handler.
    assert _status(app, "/file") == 401


def test_embedded_none_installs_no_wyc_auth(isolated_data_dir):
    app = build_app(object(), auth=None)
    assert auth_middleware not in app.middlewares, "embedded: the host owns auth, wyc installs none"
    # No wyc auth -> the request REACHES handle_file, which 400s on the missing
    # ?path (NOT 401). Proves nothing in wyc blocked the unauthenticated request.
    assert _status(app, "/file") == 400


def test_custom_auth_is_used(isolated_data_dir):
    @web.middleware
    async def teapot(request, handler):
        if request.path == "/healthz":
            return await handler(request)
        return web.Response(status=418, text="host auth")

    app = build_app(object(), auth=teapot)
    assert teapot in app.middlewares
    assert auth_middleware not in app.middlewares
    # both requests on ONE loop (an app can't be reused across event loops).
    file_status, health_status = _run(_statuses(app, ["/file", "/healthz"]))
    assert file_status == 418, "the injected host middleware must run"
    assert health_status == 200


def test_no_token_written_when_host_owns_auth(isolated_data_dir):
    build_app(object(), auth=None)
    assert not os.path.exists(os.path.join(isolated_data_dir, ".wyc_token")), \
        "embedded mode must not create a local token file"


def test_default_writes_token(isolated_data_dir):
    build_app(object())
    assert os.path.exists(os.path.join(isolated_data_dir, ".wyc_token"))


# ── mount-prefix seam ─────────────────────────────────────────────────────────
def test_url_prefix_recorded(isolated_data_dir):
    assert build_app(object(), url_prefix="/wyc")[_K_PREFIX] == "/wyc"
    assert build_app(object())[_K_PREFIX] == ""


def test_embedded_under_parent_subapp(isolated_data_dir):
    """The actual clanker mount (M2 mechanism), proven without clanker: a PARENT app
    with its OWN auth `add_subapp`'s wyc at /wyc/. aiohttp runs the parent's
    middleware for sub-app requests, so the host owns auth on the whole mount, and
    wyc's routes (healthz / index / static) serve correctly UNDER the prefix."""
    @web.middleware
    async def parent_auth(request, handler):
        if request.query.get("k") == "secret":
            return await handler(request)
        return web.Response(status=401, text="parent auth")

    def make():
        parent = web.Application(middlewares=[parent_auth])
        wyc_app = build_app(object(), auth=None, url_prefix="/wyc")
        parent.add_subapp("/wyc/", wyc_app)
        return parent

    # the parent's auth covers the mount: no key -> 401 even on wyc's unauth /healthz.
    assert _run(_statuses(make(), ["/wyc/healthz"])) == [401]
    # with the parent key -> wyc serves healthz + the index + static under /wyc/.
    got = _run(_statuses(make(), [
        "/wyc/healthz?k=secret", "/wyc/?k=secret", "/wyc/static/app.js?k=secret",
    ]))
    assert got == [200, 200, 200], got


# ── data-dir seam ──────────────────────────────────────────────────────────────
# Run in a SUBPROCESS so the env is read at a fresh import — no in-process
# importlib.reload (reloading the module swaps module-level singletons like the
# auth sentinel and pollutes the other tests).
def _data_dir_with_env(value):
    code = "import wyc.contract as c; print(c.DATA_DIR)"
    env = dict(os.environ)
    env["PYTHONPATH"] = _ROOT + os.pathsep + env.get("PYTHONPATH", "")
    if value is None:
        env.pop("WYC_DATA_DIR", None)
    else:
        env["WYC_DATA_DIR"] = value
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env)
    assert out.returncode == 0, out.stderr
    return out.stdout.strip()


def test_wyc_data_dir_env_override():
    assert _data_dir_with_env("/tmp/wyc_custom_home_xyz") == "/tmp/wyc_custom_home_xyz"


def test_wyc_data_dir_defaults_when_unset():
    assert _data_dir_with_env(None) == "/data/clanker/watchyourclankers"
