"""wyc.server — aiohttp app: WebSocket wire + static web UI. SERVERHOOK layer.

Implements FR-007 (serve /ws snapshot-then-stream + static web, bind 127.0.0.1,
local token) and the daemon side of FR-008 (a /hook route for the PostToolUse
enrichment events).

Conforms to wyc.contract:
  * binds contract.DEFAULT_HOST (127.0.0.1) / contract.DEFAULT_PORT (8900);
    env WYC_HOST / WYC_PORT override but the default is ALWAYS loopback
    (constitution Principle II — never 0.0.0.0 by default).
  * a WS client receives contract.hello(...) then watcher.snapshot(), then a
    live stream of wire envelopes from watcher.subscribe(); inbound client
    messages (subscribe / resync / annotate / thread_override) are handled per
    contracts/events.schema.json.

Auth (Principle II): a single local token, generated/loaded from
DATA_DIR/.wyc_token on startup, accepted via ?token=<hex> query OR a Cookie.
Every route except /healthz requires it.

Observer, never actor (Principle I): the ONLY writes this module performs are
under contract.DATA_DIR (the token file + annotation/override STUB stores). It
NEVER writes to ~/.claude or any observed repo.

The real Watcher is imported LAZILY inside serve() so this module imports cleanly
even while wyc/watcher.py is still being built by a parallel agent. build_app()
takes any object implementing the contract.Watcher Protocol, so tests can inject
a fake.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import time
from typing import Any, Optional

from aiohttp import web

from . import contract

# ── tunables ────────────────────────────────────────────────────────────────
_WS_HEARTBEAT = 30          # seconds; mirrors clanker's WebSocketResponse heartbeat
_HOOK_MAX_BYTES = 64 * 1024  # cap an enrichment payload (enrichment only, untrusted size)
_TOKEN_COOKIE = "wyc_token"
_FILE_MAX_BYTES = 2 * 1024 * 1024  # /file head cap (~2 MB); larger -> truncated:true

# typed app[] keys (aiohttp's recommended AppKey pattern)
_K_WATCHER: "web.AppKey[Any]" = web.AppKey("wyc_watcher", object)
_K_TOKEN: "web.AppKey[str]" = web.AppKey("wyc_token", str)


# ── token / auth (Principle II) ──────────────────────────────────────────────
def _token_path() -> str:
    return os.path.join(contract.DATA_DIR, ".wyc_token")


def load_or_create_token() -> str:
    """Load DATA_DIR/.wyc_token, creating it (0600, random hex) if absent.

    This is the only auth secret in standalone mode (clanker HMAC+TOTP replaces
    it on merge). Writing it is permitted — it lives under DATA_DIR, our own
    store, never an observed artifact (Principle I)."""
    path = _token_path()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            tok = fh.read().strip()
        if tok:
            return tok
    except OSError:
        pass
    tok = secrets.token_hex(32)
    os.makedirs(contract.DATA_DIR, exist_ok=True)
    # write atomically-ish with restrictive perms
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, tok.encode("utf-8"))
    finally:
        os.close(fd)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return tok


def _request_token(request: web.Request) -> Optional[str]:
    tok = request.query.get("token")
    if tok:
        return tok
    return request.cookies.get(_TOKEN_COOKIE)


def _authed(request: web.Request) -> bool:
    expected = request.app.get(_K_TOKEN)
    if not expected:
        return False
    got = _request_token(request)
    if not got:
        return False
    return secrets.compare_digest(got, expected)


@web.middleware
async def auth_middleware(request: web.Request, handler):
    """Reject everything without the local token except /healthz.

    A valid token may arrive as ?token=<hex> or a Cookie. On a successful HTTP
    (non-WS) request that presented a query token, we set the cookie so the
    static UI can reconnect the WS without leaking the token in every URL."""
    if request.path == "/healthz":
        return await handler(request)
    if not _authed(request):
        # For a browser hitting / with no token, send a tiny instructive page so
        # the operator knows to append ?token=. WS upgrades just get 401.
        if request.path == "/ws" or request.path.startswith("/hook"):
            return web.json_response({"error": "unauthorized"}, status=401)
        return web.Response(
            status=401,
            text="watchyourclankers: unauthorized. Append ?token=<token from "
                 f"{_token_path()}> to the URL.",
            content_type="text/plain",
        )
    response = await handler(request)
    # Persist the token as a cookie on first authed HTML load so the WS (which
    # the browser opens itself) inherits it. Skip WS (already prepared) + cookie
    # already present.
    if (not isinstance(response, web.WebSocketResponse)
            and request.query.get("token")
            and _TOKEN_COOKIE not in request.cookies):
        try:
            response.set_cookie(
                _TOKEN_COOKIE, request.app[_K_TOKEN],
                httponly=True, samesite="Strict", max_age=7 * 24 * 3600,
            )
        except (AttributeError, ValueError):
            pass
    return response


# ── annotation / override STUB persistence (Principle I — DATA_DIR only) ──────
def _append_jsonl(filename: str, obj: dict) -> None:
    """Append one JSON object to DATA_DIR/<filename>. Our own store ONLY."""
    os.makedirs(contract.DATA_DIR, exist_ok=True)
    path = os.path.join(contract.DATA_DIR, filename)
    line = json.dumps(obj, separators=(",", ":"), default=str)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def persist_annotation(payload: dict) -> None:
    """Slice-1 STUB: append an annotate action to DATA_DIR/annotations.jsonl.

    The real write path (applying pin/freeze/flag to live state) lands later;
    for now we durably record the operator's intent in OUR store. NEVER touches
    observed artifacts."""
    _append_jsonl("annotations.jsonl", {"ts": time.time(), **payload})


def persist_override(payload: dict) -> None:
    """Slice-1 STUB: append a thread_override (merge/split/alias) to
    DATA_DIR/overrides.jsonl. Sticky-override application is wyc.threads'
    job later; here we just record intent durably in OUR store."""
    _append_jsonl("overrides.jsonl", {"ts": time.time(), **payload})


def _snapshot_publish_path() -> str:
    return os.path.join(contract.DATA_DIR, "last_snapshot.json")


def publish_snapshot(watcher: Any) -> None:
    """Write the watcher's latest snapshot to DATA_DIR/last_snapshot.json so
    out-of-process consumers (the `wyc handoff` CLI) can read thread state
    without a live WS. Atomic-ish replace; OUR store only (Principle I)."""
    try:
        snap = watcher.snapshot()
    except Exception:
        return
    path = _snapshot_publish_path()
    tmp = path + ".tmp"
    try:
        os.makedirs(contract.DATA_DIR, exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(snap, fh, default=str)
        os.replace(tmp, path)
    except OSError:
        pass


async def _snapshot_publisher(watcher: Any, interval: float = 2.0) -> None:
    """Background loop: keep DATA_DIR/last_snapshot.json fresh for the CLI."""
    while True:
        publish_snapshot(watcher)
        await asyncio.sleep(interval)


# ── HTTP routes ──────────────────────────────────────────────────────────────
async def handle_healthz(request: web.Request) -> web.Response:
    """Unauthenticated tiny liveness probe."""
    return web.json_response({"ok": True, "service": "watchyourclankers",
                              "protocol": contract.PROTOCOL_VERSION})


def _web_dir() -> Optional[str]:
    """Path to the web/ dir (built by the IDE agent) if present."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    web_dir = os.path.join(here, "web")
    if os.path.isdir(web_dir) and os.path.isfile(os.path.join(web_dir, "index.html")):
        return web_dir
    return None


_PLACEHOLDER_HTML = """<!doctype html>
<meta charset="utf-8">
<title>watchyourclankers</title>
<style>body{background:#0c0a09;color:#e7e0d8;font:14px/1.5 ui-monospace,monospace;
padding:2rem;max-width:46rem;margin:auto}a{color:#d98a6a}code{color:#c0a98e}</style>
<h1>watchyourclankers</h1>
<p>The watcher daemon is up. The <code>web/</code> UI is not built yet
(it's produced by a parallel agent). The wire is live at
<code>/ws?token=&lt;token&gt;</code>.</p>
<p>Token file: <code>%(token_path)s</code></p>
<p><a href="/healthz">/healthz</a></p>
"""


async def handle_index(request: web.Request) -> web.Response:
    """GET / — serve web/index.html if present, else a minimal placeholder."""
    web_dir = _web_dir()
    if web_dir:
        return web.FileResponse(os.path.join(web_dir, "index.html"))
    return web.Response(
        text=_PLACEHOLDER_HTML % {"token_path": _token_path()},
        content_type="text/html",
    )


async def handle_hook(request: web.Request) -> web.Response:
    """GET/POST /hook — the daemon side of the PostToolUse enrichment hook
    (FR-008). Accepts a compact JSON event from hooks/post-tool-use.py and feeds
    it to the watcher as a SUPPLEMENTAL signal. Enrichment only: transcript-tail
    is canonical, so we always return 200 quickly and never let a bad payload
    matter. The watcher may ignore it (slice 1)."""
    payload: dict = {}
    if request.method == "POST":
        if request.content_length and request.content_length > _HOOK_MAX_BYTES:
            return web.json_response({"ok": False, "reason": "too_large"}, status=413)
        try:
            raw = await request.read()
            if raw:
                payload = json.loads(raw.decode("utf-8", "replace"))
        except (ValueError, UnicodeDecodeError):
            # Bad JSON from an enrichment hook must never matter.
            return web.json_response({"ok": True, "ignored": "bad_json"})
    else:  # GET — params as the payload (used by simple/curl probes)
        payload = dict(request.query)
        payload.pop("token", None)

    watcher = request.app.get(_K_WATCHER)
    fed = False
    if watcher is not None:
        fn = getattr(watcher, "ingest_hook", None) or getattr(watcher, "on_hook", None)
        if callable(fn):
            try:
                res = fn(payload)
                if asyncio.iscoroutine(res):
                    await res
                fed = True
            except Exception:
                # Watcher hook ingestion is best-effort; never 500 a hook.
                fed = False
    return web.json_response({"ok": True, "fed": fed})


# ── read-only file peek (the IDE editor pane) ────────────────────────────────
def _file_roots() -> list[str]:
    """Allowlist of realpath roots /file may serve under (Principle I/II).

    Default ['/home/user']; override via env WYC_FILE_ROOTS (colon-separated).
    Each root is itself realpath-resolved so a symlinked root still matches."""
    raw = os.environ.get("WYC_FILE_ROOTS", "/home/user")
    roots: list[str] = []
    for part in raw.split(":"):
        part = part.strip()
        if not part:
            continue
        try:
            roots.append(os.path.realpath(part))
        except OSError:
            continue
    return roots or [os.path.realpath("/home/user")]


def _under_root(real: str, root: str) -> bool:
    """True iff `real` (a realpath) is the root itself or strictly within it.

    Uses os.path.commonpath on the split components so /home/userX does NOT
    count as under /home/user (prefix-string matching would wrongly accept it)."""
    try:
        return os.path.commonpath([real, root]) == root
    except ValueError:
        # different drives / one is relative — never under.
        return False


async def handle_file(request: web.Request) -> web.Response:
    """GET /file?path=<abs>&token=<t> — serve REDACTED, root-jailed file content
    for the IDE editor pane. Read-only (Principle I: observing an observed file
    is allowed; writing is not). Auth enforced by auth_middleware.

    Security jail (Principle II): resolve realpath, serve ONLY a readable regular
    file whose realpath sits under an allowlisted root (default /home/user, env
    WYC_FILE_ROOTS overrides). Anything else -> 403 (blocks /etc/shadow, ssh
    keys, ...). At most ~2 MB is read (head returned + truncated:true if larger).
    Content passes through wyc.redact.redact() before it leaves the process.

    Returns {path, content, lines, redacted:true, truncated:<bool>}; 404 if the
    path is missing / not a regular file; 400 if no path given."""
    raw_path = request.query.get("path")
    if not raw_path:
        return web.json_response({"error": "missing path"}, status=400)

    # Resolve the realpath FIRST (follows symlinks) and jail it to a root. We
    # gate on the realpath, never the raw input, so a symlink can't escape.
    try:
        real = os.path.realpath(raw_path)
    except OSError:
        return web.json_response({"error": "bad path"}, status=400)

    roots = _file_roots()
    if not any(_under_root(real, r) for r in roots):
        # Outside every allowlisted root — refuse (don't reveal existence).
        return web.json_response({"error": "forbidden"}, status=403)

    if not os.path.isfile(real):  # missing, a dir, a device, a socket, ...
        return web.json_response({"error": "not found"}, status=404)

    # Read at most _FILE_MAX_BYTES + 1 so we can detect truncation cheaply.
    try:
        with open(real, "rb") as fh:
            blob = fh.read(_FILE_MAX_BYTES + 1)
    except OSError:
        # Unreadable (perms, vanished between checks, ...) — treat as not found.
        return web.json_response({"error": "not found"}, status=404)

    truncated = len(blob) > _FILE_MAX_BYTES
    if truncated:
        blob = blob[:_FILE_MAX_BYTES]
    text = blob.decode("utf-8", "replace")

    from . import redact as _redact  # ensures contract.redact is the real impl
    content = _redact.redact(text) or ""
    lines = content.count("\n") + (1 if content and not content.endswith("\n") else 0)

    return web.json_response({
        "path": real,
        "content": content,
        "lines": lines,
        "redacted": True,
        "truncated": truncated,
    })


# ── WebSocket: snapshot-then-stream (Principle VI) ───────────────────────────
async def _send(ws: web.WebSocketResponse, obj: dict) -> bool:
    """Send a JSON envelope; return False if the socket is gone."""
    if ws.closed:
        return False
    try:
        await ws.send_str(json.dumps(obj, default=str))
        return True
    except (ConnectionResetError, RuntimeError, asyncio.CancelledError):
        return False


def _scope_passes(scope: Optional[str], env: dict) -> bool:
    """Filter a wire envelope against a client 'subscribe' scope.

    scope is 'all' (or None) | 'thread:<id>' | 'session:<id>'. We inspect the
    nested object's thread_id / session_id; envelopes without either (hello,
    snapshot) are always passed."""
    if not scope or scope == "all":
        return True
    body = (env.get("activity") or env.get("terminal")
            or env.get("session") or env.get("thread") or {})
    if scope.startswith("thread:"):
        want = scope.split(":", 1)[1]
        return body.get("thread_id") == want or body.get("id") == want
    if scope.startswith("session:"):
        want = scope.split(":", 1)[1]
        return body.get("session_id") == want or body.get("id") == want
    return True


async def handle_ws(request: web.Request) -> web.WebSocketResponse:
    """GET /ws — the wire. On connect: hello + snapshot, then stream
    watcher.subscribe(); handle inbound subscribe/resync/annotate/thread_override.

    Auth is enforced by auth_middleware before we get here (401 otherwise)."""
    ws = web.WebSocketResponse(heartbeat=_WS_HEARTBEAT)
    await ws.prepare(request)

    watcher = request.app[_K_WATCHER]

    # 1) hello, then the hydration snapshot (Principle VI: snapshot-then-stream).
    await _send(ws, contract.hello(time.time(), redaction=True))
    try:
        snap = watcher.snapshot()
    except Exception:
        snap = contract.snapshot(0, time.time(), [], [], [])
    await _send(ws, snap)

    # client-set filter scope; defaults to everything.
    scope: Optional[str] = "all"

    async def pump():
        """Stream live wire envelopes from the watcher to this client."""
        nonlocal scope
        try:
            async for env in watcher.subscribe():
                if not _scope_passes(scope, env):
                    continue
                if not await _send(ws, env):
                    break
        except (asyncio.CancelledError, ConnectionResetError):
            pass
        except Exception:
            # A watcher-side stream error must not crash the connection handler.
            pass

    pump_task = asyncio.create_task(pump())

    try:
        async for raw in ws:
            if raw.type != web.WSMsgType.TEXT:
                if raw.type in (web.WSMsgType.CLOSE, web.WSMsgType.CLOSING,
                                web.WSMsgType.ERROR):
                    break
                continue
            try:
                msg = json.loads(raw.data)
            except (ValueError, TypeError):
                continue
            t = msg.get("t")
            if t == "subscribe":
                scope = msg.get("scope", "all")
            elif t == "resync":
                # Snapshot-then-stream gap recovery (Principle VI): replay since
                # the client's last seq, or re-snapshot if the buffer can't span
                # the gap.
                since = msg.get("since", 0)
                try:
                    missed = await watcher.since(int(since))
                except Exception:
                    missed = []
                if not missed:
                    try:
                        snap = watcher.snapshot()
                    except Exception:
                        snap = contract.snapshot(0, time.time(), [], [], [])
                    await _send(ws, snap)
                else:
                    for env in missed:
                        if _scope_passes(scope, env):
                            if not await _send(ws, env):
                                break
            elif t == "annotate":
                # STUB write to OUR store only (Principle I). Never an observed
                # artifact. Echo an ack so the UI can confirm.
                persist_annotation({
                    "action": msg.get("action"),
                    "target": msg.get("target"),
                })
                await _send(ws, contract.msg("annotate_ack", ok=True,
                                             action=msg.get("action")))
            elif t == "thread_override":
                persist_override({"op": msg.get("op"), "args": msg.get("args")})
                await _send(ws, contract.msg("thread_override_ack", ok=True,
                                             op=msg.get("op")))
            elif t in ("watch_screen", "unwatch_screen"):
                # Trigger the watcher to start/stop streaming raw tmux Screen
                # frames for this session's pane. We do NOT push frames here —
                # toggling the watch makes them flow through watcher.subscribe(),
                # which the pump task above already forwards. getattr-guarded so
                # the server still runs if the (parallel-built) watcher lacks the
                # method yet: degrade by acking with a note.
                session_id = msg.get("session_id")
                fn = getattr(watcher, t, None)
                if callable(fn) and session_id:
                    try:
                        res = fn(session_id)
                        if asyncio.iscoroutine(res):
                            await res
                        await _send(ws, contract.msg(t + "_ack", ok=True,
                                                     session_id=session_id))
                    except Exception:
                        # Watcher-side toggle failure must not crash the socket.
                        await _send(ws, contract.msg(t + "_ack", ok=False,
                                                     session_id=session_id,
                                                     note="watcher error"))
                else:
                    await _send(ws, contract.msg(
                        t + "_ack", ok=False, session_id=session_id,
                        note="screen watching unavailable"))
            # unknown message types are ignored (forward-compat).
    finally:
        pump_task.cancel()
        try:
            await pump_task
        except asyncio.CancelledError:
            pass
        if not ws.closed:
            await ws.close()
    return ws


# ── app construction ─────────────────────────────────────────────────────────
def build_app(watcher: Any) -> web.Application:
    """Construct the aiohttp app around an object implementing contract.Watcher.

    Pure wiring — no network, no watcher.run(); tests inject a fake watcher.
    The token is loaded/created here so build_app is self-contained."""
    app = web.Application(middlewares=[auth_middleware], client_max_size=_HOOK_MAX_BYTES)
    app[_K_WATCHER] = watcher
    app[_K_TOKEN] = load_or_create_token()

    app.router.add_get("/healthz", handle_healthz)
    app.router.add_get("/ws", handle_ws)
    app.router.add_get("/hook", handle_hook)
    app.router.add_post("/hook", handle_hook)
    app.router.add_get("/file", handle_file)
    app.router.add_get("/", handle_index)

    # Static assets from web/ (built by the IDE agent). Only mounted if present;
    # otherwise just / (placeholder) is served. add_static is read-only.
    web_dir = _web_dir()
    if web_dir:
        app.router.add_static("/static/", web_dir, name="static", show_index=False)
    return app


async def serve(host: Optional[str] = None, port: Optional[int] = None) -> None:
    """Construct the REAL Watcher (imported lazily) and run it alongside the web
    app, bound to loopback by default (Principle II).

    The lazy import is deliberate: wyc/watcher.py is built by a parallel agent,
    so importing it at module top would couple this module's import-time to its
    completion. Importing here means `python3 -m wyc serve` works the moment
    watcher.py exists, and this module imports/tests fine before then."""
    host = host or os.environ.get("WYC_HOST", contract.DEFAULT_HOST)
    port = int(port or os.environ.get("WYC_PORT", contract.DEFAULT_PORT))

    from .watcher import Watcher  # lazy — see docstring

    watcher = Watcher()
    app = build_app(watcher)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()

    token = app[_K_TOKEN]
    print(f"[wyc] watching — http://{host}:{port}/?token={token}", flush=True)
    print(f"[wyc] token file: {_token_path()}", flush=True)

    # Run the watcher's poll/tail/stitch loop concurrently with the web server,
    # plus a publisher that keeps last_snapshot.json fresh for `wyc handoff`.
    watcher_task = asyncio.create_task(watcher.run())
    publisher_task = asyncio.create_task(_snapshot_publisher(watcher))
    try:
        await watcher_task
    except asyncio.CancelledError:
        pass
    finally:
        watcher_task.cancel()
        publisher_task.cancel()
        await runner.cleanup()
