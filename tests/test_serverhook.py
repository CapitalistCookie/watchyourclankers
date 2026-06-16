"""Tests for the SERVERHOOK layer: wyc.handoff, wyc.server, hooks/post-tool-use.

Self-contained (no shared conftest). Async server tests drive an explicit event
loop with aiohttp's TestServer/TestClient so they don't depend on pytest-asyncio
config or markers. The watcher is a small FAKE implementing contract.Watcher so
these run standalone while the real wyc/watcher.py is built in parallel.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

import pytest

# Make the repo root importable (package `wyc`) without a conftest.
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from wyc import contract  # noqa: E402
from wyc import handoff  # noqa: E402


# ── shared fixtures: an isolated DATA_DIR so we never touch the real store ────
@pytest.fixture(autouse=True)
def isolated_data_dir(monkeypatch, tmp_path):
    """Point contract.DATA_DIR at a temp dir for the duration of each test so the
    token file / annotation stubs land in a throwaway location (Principle I — we
    only ever write under DATA_DIR, and here that's a tmp dir)."""
    d = str(tmp_path / "wycdata")
    os.makedirs(d, exist_ok=True)
    monkeypatch.setattr(contract, "DATA_DIR", d)
    # server reads contract.DATA_DIR via its _token_path(); reload-safe since it
    # references the attribute at call time.
    return d


# ── a sample thread-state dict, deliberately seeded with a secret ─────────────
_SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"  # GitHub-token-shaped


def _sample_state() -> dict:
    return {
        "thread": {
            "id": "th_comms",
            "title": "comms",
            "project": "comms",
            "stitch": ["name-stem", "handoff-doc"],
        },
        "sessions": [
            {"id": "s1", "name": "comms3", "status": "ended",
             "current_surface": contract.KIND_EDIT, "current_file": "wyc/server.py"},
            {"id": "s2", "name": "comms4", "status": "busy",
             "current_surface": contract.KIND_BASH, "current_file": None},
        ],
        "open_files": ["wyc/server.py", "wyc/handoff.py", "docs/MASTER_PLAN.md"],
        "recent_activities": [
            {"kind": contract.KIND_EDIT, "tool": "Edit",
             "file_path": "wyc/server.py", "ts": 1.0},
            {"kind": contract.KIND_BASH, "tool": "Bash",
             "detail": f"git clone https://user:{_SECRET}@github.com/x/y", "ts": 2.0},
        ],
        "current_spec": "001-infra-contract-feed",
        "docs": ["docs/MASTER_PLAN.md"],
    }


# ── handoff.one_liner / brief ────────────────────────────────────────────────
def test_one_liner_is_single_dense_line_with_key_facts():
    line = handoff.one_liner(_sample_state())
    # single physical line
    assert "\n" not in line
    # carries the essentials a fresh session needs
    assert "comms" in line                 # thread title
    assert "wyc/server.py" in line         # open file / last edit
    assert "in chain" in line              # chain length phrase
    assert "2 sessions in chain" in line
    assert line.rstrip().endswith(".")     # a continuation sentence
    assert "read" in line and "specs/001-infra-contract-feed" in line


def test_one_liner_redacts_secrets():
    line = handoff.one_liner(_sample_state())
    assert _SECRET not in line, "raw secret leaked into the handoff one-liner"
    # the last-cmd surfaced but masked
    assert "git clone" in line


def test_brief_structure_and_redaction():
    b = handoff.brief(_sample_state())
    assert b["title"] == "comms"
    assert b["chain_len"] == 2
    assert "wyc/server.py" in b["open_files"]
    assert b["current_spec"] == "001-infra-contract-feed"
    assert isinstance(b["recent_activities"], list) and b["recent_activities"]
    # secret nowhere in the serialized brief
    assert _SECRET not in json.dumps(b)
    assert "\n" not in b["one_liner"]


def test_one_liner_degrades_on_sparse_state():
    line = handoff.one_liner({"thread": {"id": "th_x"}})
    assert "\n" not in line
    assert "th_x" in line
    assert line.rstrip().endswith(".")


def test_generator_no_state_message():
    gen = handoff.HandoffGenerator(state_provider=lambda tid: None)
    msg = gen.one_liner("th_missing")
    assert "th_missing" in msg
    assert "daemon not running" in msg or "no state" in msg.lower() \
        or "unknown" in msg.lower()
    b = gen.brief("th_missing")
    assert b.get("error") == "no state"


def test_generator_with_provider():
    gen = handoff.HandoffGenerator(state_provider=lambda tid: _sample_state())
    assert "comms" in gen.one_liner("th_comms")
    assert gen.brief("th_comms")["chain_len"] == 2


# ── a FAKE watcher implementing contract.Watcher ─────────────────────────────
class FakeWatcher:
    """Minimal contract.Watcher: run/snapshot/subscribe/since. Lets the server be
    tested without the real (parallel-built) wyc.watcher."""

    def __init__(self, with_buffer: bool = False):
        th = contract.Thread(id="th_comms", title="comms", project="comms",
                             session_ids=["s1"])
        se = contract.Session(id="s1", thread_id="th_comms", status="busy",
                             project="comms")
        self._threads = [th]
        self._sessions = [se]
        self._seq = 7
        self._with_buffer = with_buffer
        self.hook_events: list[dict] = []
        self.watched: list[str] = []      # session_ids passed to watch_screen
        self.unwatched: list[str] = []    # session_ids passed to unwatch_screen
        # one activity to stream
        self._act = contract.Activity(seq=8, ts=2.0, session_id="s1",
                                     thread_id="th_comms",
                                     kind=contract.KIND_EDIT, tool="Edit",
                                     file_path="wyc/server.py")

    async def run(self) -> None:
        # the real watcher loops forever; the fake just idles briefly.
        await asyncio.sleep(0)

    def snapshot(self) -> dict:
        return contract.snapshot(self._seq, 123.0, self._threads,
                                 self._sessions, [self._act])

    async def subscribe(self):
        # yield one activity then stop (a real watcher yields forever).
        yield contract.activity_msg(self._act)
        # keep the generator alive so the server's pump task doesn't immediately
        # close; sleep then return.
        await asyncio.sleep(0.05)

    async def since(self, seq: int) -> list[dict]:
        if self._with_buffer and seq < self._act.seq:
            return [contract.activity_msg(self._act)]
        return []  # signal: caller should re-snapshot

    def ingest_hook(self, payload: dict) -> None:
        self.hook_events.append(payload)

    def watch_screen(self, session_id: str) -> None:
        # the real watcher starts streaming Screen frames for this pane; the
        # fake just records the call so the server wiring can be asserted.
        self.watched.append(session_id)

    def unwatch_screen(self, session_id: str) -> None:
        self.unwatched.append(session_id)


# ── async server helpers (explicit loop — no pytest-asyncio dependency) ───────
def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


async def _make_client(watcher):
    from aiohttp.test_utils import TestClient, TestServer
    from wyc import server as srv
    app = srv.build_app(watcher)
    client = TestClient(TestServer(app))
    await client.start_server()
    token = app[srv._K_TOKEN]
    return client, token


def test_healthz_no_token():
    async def go():
        client, _ = await _make_client(FakeWatcher())
        try:
            resp = await client.get("/healthz")
            assert resp.status == 200
            body = await resp.json()
            assert body["ok"] is True
            assert body["protocol"] == contract.PROTOCOL_VERSION
        finally:
            await client.close()
    _run(go())


def test_ws_rejected_without_token():
    async def go():
        client, _ = await _make_client(FakeWatcher())
        try:
            resp = await client.get("/ws")  # plain GET, no upgrade, no token
            assert resp.status == 401
        finally:
            await client.close()
    _run(go())


def test_index_rejected_without_token():
    async def go():
        client, _ = await _make_client(FakeWatcher())
        try:
            resp = await client.get("/")
            assert resp.status == 401
        finally:
            await client.close()
    _run(go())


def test_responses_carry_no_cache_header():
    # nocache_middleware (deterministic counterpart to the fast-gate curl probe):
    # every response carries Cache-Control: no-cache so the browser revalidates and
    # never serves a stale frontend (the "deployed but not fixed" class). /healthz
    # needs no token, so it is the simplest probe.
    async def go():
        client, _ = await _make_client(FakeWatcher())
        try:
            resp = await client.get("/healthz")
            assert resp.headers.get("Cache-Control") == "no-cache", \
                f"missing no-cache: {resp.headers.get('Cache-Control')!r}"
        finally:
            await client.close()
    _run(go())


def test_ws_with_token_sends_hello_then_snapshot_then_stream():
    async def go():
        watcher = FakeWatcher()
        client, token = await _make_client(watcher)
        try:
            ws = await client.ws_connect(f"/ws?token={token}")
            # 1) hello
            m1 = await asyncio.wait_for(ws.receive_json(), timeout=2)
            assert m1["t"] == "hello"
            assert m1["v"] == contract.PROTOCOL_VERSION
            assert m1["redaction"] is True
            # 2) snapshot
            m2 = await asyncio.wait_for(ws.receive_json(), timeout=2)
            assert m2["t"] == "snapshot"
            assert m2["seq"] == 7
            assert any(t["id"] == "th_comms" for t in m2["threads"])
            assert any(s["id"] == "s1" for s in m2["sessions"])
            # 3) streamed activity from subscribe()
            m3 = await asyncio.wait_for(ws.receive_json(), timeout=2)
            assert m3["t"] == "activity"
            assert m3["activity"]["file_path"] == "wyc/server.py"
            await ws.close()
        finally:
            await client.close()
    _run(go())


def test_ws_resync_empty_buffer_resnapshots():
    async def go():
        watcher = FakeWatcher(with_buffer=False)  # since() -> [] => re-snapshot
        client, token = await _make_client(watcher)
        try:
            ws = await client.ws_connect(f"/ws?token={token}")
            await ws.receive_json()  # hello
            await ws.receive_json()  # snapshot
            await ws.send_json(contract.msg("resync", since=0))
            # server should reply with a fresh snapshot (buffer empty). It may
            # interleave the one streamed activity; scan a few frames for it.
            got_snap = False
            for _ in range(4):
                m = await asyncio.wait_for(ws.receive_json(), timeout=2)
                if m["t"] == "snapshot":
                    got_snap = True
                    break
            assert got_snap, "resync with empty buffer must re-snapshot"
            await ws.close()
        finally:
            await client.close()
    _run(go())


def test_ws_annotate_persists_stub_to_data_dir(isolated_data_dir):
    async def go():
        watcher = FakeWatcher()
        client, token = await _make_client(watcher)
        try:
            ws = await client.ws_connect(f"/ws?token={token}")
            await ws.receive_json()  # hello
            await ws.receive_json()  # snapshot
            await ws.send_json(contract.msg(
                "annotate", action="pin",
                target={"session_id": "s1", "note": "look here"}))
            # scan for the ack
            acked = False
            for _ in range(4):
                m = await asyncio.wait_for(ws.receive_json(), timeout=2)
                if m["t"] == "annotate_ack":
                    acked = True
                    break
            assert acked
            await ws.close()
        finally:
            await client.close()
        # the stub must have landed in OUR store under DATA_DIR, nowhere else.
        ann = os.path.join(isolated_data_dir, "annotations.jsonl")
        assert os.path.isfile(ann)
        with open(ann) as fh:
            rows = [json.loads(ln) for ln in fh if ln.strip()]
        assert rows and rows[-1]["action"] == "pin"
    _run(go())


def test_hook_route_feeds_watcher():
    async def go():
        watcher = FakeWatcher()
        client, token = await _make_client(watcher)
        try:
            resp = await client.post(f"/hook?token={token}",
                                     json={"tool_name": "Edit",
                                           "tool_input": {"file_path": "x.py"}})
            assert resp.status == 200
            body = await resp.json()
            assert body["ok"] is True
            assert body["fed"] is True
        finally:
            await client.close()
        assert watcher.hook_events and watcher.hook_events[-1]["tool_name"] == "Edit"
    _run(go())


def test_hook_route_rejected_without_token():
    async def go():
        client, _ = await _make_client(FakeWatcher())
        try:
            resp = await client.post("/hook", json={"tool_name": "Edit"})
            assert resp.status == 401
        finally:
            await client.close()
    _run(go())


# ── GET /file: redacted, root-jailed, read-only editor peek ──────────────────
def test_file_returns_redacted_content_under_allowed_root(monkeypatch, tmp_path):
    """A readable regular file under an allowlisted root is served, with its
    content run through redact() (a planted secret comes back masked)."""
    root = tmp_path / "root"
    root.mkdir()
    target = root / "leaky.py"
    target.write_text(f"x = 1\ntoken = '{_SECRET}'\nprint(x)\n")
    # allowlist this tmp root only (default is /home/user, not tmp_path)
    monkeypatch.setenv("WYC_FILE_ROOTS", str(root))

    async def go():
        client, token = await _make_client(FakeWatcher())
        try:
            resp = await client.get(f"/file?path={target}&token={token}")
            assert resp.status == 200
            body = await resp.json()
            assert body["redacted"] is True
            assert body["truncated"] is False
            assert body["lines"] == 3
            # realpath is echoed back
            assert body["path"] == os.path.realpath(str(target))
            # the secret is masked but surrounding code survives
            assert _SECRET not in body["content"]
            assert "print(x)" in body["content"]
        finally:
            await client.close()
    _run(go())


def test_file_outside_roots_is_403(monkeypatch, tmp_path):
    """A path outside every allowlisted root is refused with 403 (jail) —
    /etc/passwd must never be served even though it exists + is readable."""
    root = tmp_path / "root"
    root.mkdir()
    monkeypatch.setenv("WYC_FILE_ROOTS", str(root))  # /etc not in the allowlist

    async def go():
        client, token = await _make_client(FakeWatcher())
        try:
            resp = await client.get(f"/file?path=/etc/passwd&token={token}")
            assert resp.status == 403
        finally:
            await client.close()
    _run(go())


def test_file_missing_is_404(monkeypatch, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    monkeypatch.setenv("WYC_FILE_ROOTS", str(root))
    missing = root / "nope.py"  # under the root, but does not exist

    async def go():
        client, token = await _make_client(FakeWatcher())
        try:
            resp = await client.get(f"/file?path={missing}&token={token}")
            assert resp.status == 404
        finally:
            await client.close()
    _run(go())


def test_file_rejected_without_token(monkeypatch, tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    target = root / "ok.py"
    target.write_text("y = 2\n")
    monkeypatch.setenv("WYC_FILE_ROOTS", str(root))

    async def go():
        client, _ = await _make_client(FakeWatcher())
        try:
            resp = await client.get(f"/file?path={target}")  # no token
            assert resp.status == 401
        finally:
            await client.close()
    _run(go())


# ── inbound watch_screen / unwatch_screen -> watcher ─────────────────────────
def test_ws_watch_screen_calls_watcher():
    """An inbound watch_screen message must call watcher.watch_screen(session_id)
    (the watcher then streams Screen frames via subscribe(), forwarded already)."""
    async def go():
        watcher = FakeWatcher()
        client, token = await _make_client(watcher)
        try:
            ws = await client.ws_connect(f"/ws?token={token}")
            await ws.receive_json()  # hello
            await ws.receive_json()  # snapshot
            await ws.send_json(contract.msg("watch_screen", session_id="s1"))
            # scan for the ack
            acked = False
            for _ in range(4):
                m = await asyncio.wait_for(ws.receive_json(), timeout=2)
                if m["t"] == "watch_screen_ack":
                    acked = True
                    assert m["ok"] is True
                    assert m["session_id"] == "s1"
                    break
            assert acked, "no watch_screen_ack received"
            await ws.close()
        finally:
            await client.close()
        assert watcher.watched == ["s1"], "watcher.watch_screen(session_id) not called"
    _run(go())


def test_ws_unwatch_screen_calls_watcher():
    async def go():
        watcher = FakeWatcher()
        client, token = await _make_client(watcher)
        try:
            ws = await client.ws_connect(f"/ws?token={token}")
            await ws.receive_json()  # hello
            await ws.receive_json()  # snapshot
            await ws.send_json(contract.msg("unwatch_screen", session_id="s1"))
            for _ in range(4):
                m = await asyncio.wait_for(ws.receive_json(), timeout=2)
                if m["t"] == "unwatch_screen_ack":
                    assert m["ok"] is True
                    break
            await ws.close()
        finally:
            await client.close()
        assert watcher.unwatched == ["s1"]
    _run(go())


def test_ws_watch_screen_degrades_when_watcher_lacks_method():
    """If the (parallel-built) watcher has no watch_screen, the server must still
    ack gracefully (ok:False + note) rather than erroring."""
    class NoScreenWatcher(FakeWatcher):
        watch_screen = None  # attribute present but not callable

    async def go():
        client, token = await _make_client(NoScreenWatcher())
        try:
            ws = await client.ws_connect(f"/ws?token={token}")
            await ws.receive_json()  # hello
            await ws.receive_json()  # snapshot
            await ws.send_json(contract.msg("watch_screen", session_id="s1"))
            acked = False
            for _ in range(4):
                m = await asyncio.wait_for(ws.receive_json(), timeout=2)
                if m["t"] == "watch_screen_ack":
                    acked = True
                    assert m["ok"] is False
                    assert "note" in m
                    break
            assert acked
            await ws.close()
        finally:
            await client.close()
    _run(go())


def test_token_file_created_with_0600():
    """Token is generated under DATA_DIR with restrictive perms (Principle II)."""
    from wyc import server as srv
    tok = srv.load_or_create_token()
    assert tok and len(tok) >= 32
    path = srv._token_path()
    assert os.path.isfile(path)
    mode = os.stat(path).st_mode & 0o777
    assert mode == 0o600, f"token file mode {oct(mode)} not 0600"
    # idempotent: second call returns the same token
    assert srv.load_or_create_token() == tok


def test_default_bind_is_loopback():
    """The server must default to loopback, never 0.0.0.0 (Principle II)."""
    assert contract.DEFAULT_HOST == "127.0.0.1"
    assert contract.DEFAULT_PORT == 8900


# ── the PostToolUse hook: never fails, exits 0 with the daemon down ──────────
def _hook_path() -> str:
    return os.path.join(_ROOT, "hooks", "post-tool-use.py")


def test_post_tool_use_hook_exits_0_with_daemon_down(tmp_path):
    """Feed the hook a sample PostToolUse stdin JSON pointing at a DATA_DIR with
    a token but NO daemon listening — it must exit 0 fast without raising."""
    # a DATA_DIR with a token so the hook actually attempts the POST (and fails
    # to connect, the path we want to prove is safe). Distinct dir name from the
    # autouse fixture's "wycdata" to avoid a collision.
    ddir = tmp_path / "hookdata"
    ddir.mkdir()
    (ddir / ".wyc_token").write_text("deadbeef" * 8)
    env = dict(os.environ)
    env["WYC_DATA_DIR"] = str(ddir)
    env["WYC_HOST"] = "127.0.0.1"
    # pick an almost-certainly-closed port so urlopen refuses fast
    env["WYC_PORT"] = "8917"
    stdin = json.dumps({
        "tool_name": "Bash",
        "tool_input": {"command": "echo hi"},
        "session_id": "s1", "cwd": "/tmp",
        "transcript_path": "/tmp/t.jsonl",
    })
    proc = subprocess.run(
        [sys.executable, "-u", _hook_path()],
        input=stdin, env=env, capture_output=True, text=True, timeout=10,
    )
    assert proc.returncode == 0, f"hook exited {proc.returncode}: {proc.stderr}"


def test_post_tool_use_hook_exits_0_on_empty_stdin(tmp_path):
    env = dict(os.environ)
    env["WYC_DATA_DIR"] = str(tmp_path)
    proc = subprocess.run(
        [sys.executable, "-u", _hook_path()],
        input="", env=env, capture_output=True, text=True, timeout=10,
    )
    assert proc.returncode == 0


def test_post_tool_use_hook_exits_0_on_bad_json(tmp_path):
    env = dict(os.environ)
    env["WYC_DATA_DIR"] = str(tmp_path)
    proc = subprocess.run(
        [sys.executable, "-u", _hook_path()],
        input="{not json", env=env, capture_output=True, text=True, timeout=10,
    )
    assert proc.returncode == 0


def test_post_tool_use_hook_imports_clean():
    """The hook module must import without side effects (stdlib only)."""
    spec = importlib.util.spec_from_file_location("wyc_pth_hook", _hook_path())
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert hasattr(mod, "main") and callable(mod.main)
    # compact() drops the token and pulls the expected fields
    c = mod._compact({"tool_name": "Edit", "tool_input": {"file_path": "a.py"},
                      "session_id": "s", "cwd": "/c"})
    assert c["tool_name"] == "Edit" and c["file_path"] == "a.py"
    assert "token" not in c
