"""Integration tests for wiring wyc.tmux.TmuxSource into the live feed.

These cover the PARENT integration seams added in watcher.py + threads.py:

  1. tmux identity stamps Session.tmux_session / tmux_group / tmux_pane each poll;
  2. the tmux group/thread_key is a HIGH-PRIORITY, EXACT stitch signal — two
     sessions sharing a tmux_group land in ONE thread (evidence: "tmux"), and the
     thread takes its title from the clean tmux key;
  3. handoff-doc lineage still OUTRANKS tmux — a handoff Write->Read merges two
     sessions even when they live in DIFFERENT tmux groups (a handoff routinely
     spawns a fresh tmux session);
  4. watch_screen() spawns a capture loop that broadcasts a redacted Screen
     envelope per streamed frame, refcounts per pane, and unwatch_screen()
     cancels the loop on the last watcher.

Self-contained: a FAKE TmuxSource is injected (tmux state on this box is live and
we must not depend on it), plus tiny fake poller/reader so the real Watcher poll
path runs end-to-end. No shared conftest. Run:
    python3 -m pytest -q tests/test_tmux_integration.py
"""
from __future__ import annotations

import asyncio
import os
import sys
import time

# Make the repo root importable when run directly.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from wyc import contract
from wyc.watcher import Watcher
from wyc.threads import ThreadStitcher, _tmux_thread_id


# --------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------
class FakeTmux:
    """A stand-in TmuxSource. identity_for(pid) is driven by a pid->ident map;
    thread_key mirrors the real rule (group wins, else session name). stream()
    yields a scripted list of frames (so a watch_screen test is deterministic)."""

    def __init__(self, idents: dict[int, dict], frames=None):
        self._idents = idents
        self._frames = list(frames or [])
        self.stream_calls: list[str] = []      # panes stream() was opened on
        self.cancelled = False

    # -- identity --
    def identity_for(self, pid):
        if pid is None:
            return None
        return self._idents.get(pid)

    def thread_key(self, ident):
        if not ident:
            return None
        group = ident.get("tmux_group")
        if group:
            return group
        sess = ident.get("tmux_session")
        if not sess:
            return None
        # strip a trailing -<digits> like the real impl
        idx = sess.rfind("-")
        if idx > 0 and sess[idx + 1:].isdigit():
            return sess[:idx]
        return sess

    def panes(self):
        return []

    def capture(self, pane, history=0):
        return ""

    async def stream(self, pane, interval=1.0):
        self.stream_calls.append(pane)
        try:
            for f in self._frames:
                yield f
                await asyncio.sleep(0)      # let the consumer run
            # Then idle forever so the task stays alive until cancelled (mirrors a
            # real pane with no further changes), letting unwatch cancel it.
            while True:
                await asyncio.sleep(0.01)
        except asyncio.CancelledError:
            self.cancelled = True
            raise


class FakePoller:
    """Returns a fixed list of Sessions each poll()."""

    def __init__(self, sessions):
        self._sessions = sessions

    def poll(self):
        return list(self._sessions)


class FakeReader:
    """A TranscriptReader with no transcripts; optionally feeds canned RawLines
    for a given session id so handoff-lineage can be exercised in the poll path."""

    def __init__(self, lines_by_session=None):
        self._lines = lines_by_session or {}
        self._served: set[str] = set()

    def transcript_path(self, session_id):
        return None

    def subagent_paths(self, session_id):
        return []

    def read_new(self, path, from_offset):
        return ([], from_offset)

    # Helper the watcher's _tail_session doesn't call directly, but the stitcher
    # needs lines — so we inject them through a poll hook instead (see below).


def _mk_session(sid, pid, name, cwd, project, *, t=1000.0):
    return contract.Session(
        id=sid, thread_id="", status="busy", pid=pid, name=name,
        cwd=cwd, project=project, started_at=t, updated_at=t)


# --------------------------------------------------------------------------
# 1) identity stamps the session's tmux_* fields each poll
# --------------------------------------------------------------------------
def test_poll_stamps_tmux_identity_on_session(tmp_path):
    sess = _mk_session("S1", 4242, "comms", "/home/user/projects/comms", "comms")
    idents = {4242: {"tmux_session": "comms", "tmux_group": "comms",
                     "pane": "comms:1.1"}}
    w = Watcher(poller=FakePoller([sess]), reader=FakeReader(),
                stitcher=ThreadStitcher(data_dir=str(tmp_path), time_window=0.0),
                tmux=FakeTmux(idents), poll_interval=999)
    w._poll_once()

    got = w._sessions["S1"]
    assert got.tmux_session == "comms"
    assert got.tmux_group == "comms"
    assert got.tmux_pane == "comms:1.1"
    # the transient stitch key is stamped too
    assert getattr(got, "tmux_key", None) == "comms"


def test_poll_robust_when_tmux_absent(tmp_path):
    """identity_for -> None must leave the session's tmux_* fields untouched and
    not break stitching (unchanged behavior when tmux is missing)."""
    sess = _mk_session("S1", 4242, "comms", "/home/user/projects/comms", "comms")
    w = Watcher(poller=FakePoller([sess]), reader=FakeReader(),
                stitcher=ThreadStitcher(data_dir=str(tmp_path), time_window=0.0),
                tmux=FakeTmux({}),  # empty -> identity_for returns None
                poll_interval=999)
    w._poll_once()
    got = w._sessions["S1"]
    assert got.tmux_session is None and got.tmux_group is None and got.tmux_pane is None
    assert got.thread_id  # still assigned a thread (by name/time)


# --------------------------------------------------------------------------
# 2) two sessions sharing a tmux_group land in ONE thread (exact, high priority)
# --------------------------------------------------------------------------
def test_same_tmux_group_stitches_into_one_thread(tmp_path):
    # Two DIFFERENT names + DIFFERENT inferred projects, no time overlap and stems
    # far apart — so name-stem/time CANNOT stitch them. Only the shared tmux group
    # can. (This proves the tmux signal is doing the work.)
    a = _mk_session("A", 100, "alpha", "/home/user/projects/aaa", "aaa", t=1000.0)
    b = _mk_session("B", 200, "zeta-unrelated", "/home/user/projects/bbb", "bbb",
                    t=9_000_000.0)
    idents = {
        100: {"tmux_session": "work-0", "tmux_group": "work", "pane": "work-0:1.1"},
        200: {"tmux_session": "work-1", "tmux_group": "work", "pane": "work-1:1.1"},
    }
    w = Watcher(poller=FakePoller([a, b]), reader=FakeReader(),
                stitcher=ThreadStitcher(data_dir=str(tmp_path), time_window=0.0),
                tmux=FakeTmux(idents), poll_interval=999)
    w._poll_once()

    ta = w._sessions["A"].thread_id
    tb = w._sessions["B"].thread_id
    assert ta == tb, "sessions sharing a tmux group must be one thread"
    # The thread id is the deterministic hash of the tmux key.
    assert ta == _tmux_thread_id("work")
    # Evidence + clean title from the tmux key.
    th = {t.id: t for t in w._stitcher.threads()}[ta]
    assert "tmux" in th.stitch
    assert th.title == "work"
    assert set(th.session_ids) == {"A", "B"}


def test_tmux_group_outranks_name_stem(tmp_path):
    """Even when name-stem WOULD cluster a session elsewhere, a present tmux key
    decides — the thread id is the tmux-key hash, not the stem hash."""
    st = ThreadStitcher(data_dir=str(tmp_path), time_window=0.0)
    s = _mk_session("S", 1, "comms", "/home/user/projects/comms", "comms")
    s.tmux_key = "comms-chain"          # transient key the watcher would set
    th = st.assign(s, [])
    assert th.id == _tmux_thread_id("comms-chain")
    assert "tmux" in th.stitch


# --------------------------------------------------------------------------
# 3) handoff-doc lineage still merges ACROSS different tmux groups
# --------------------------------------------------------------------------
def test_handoff_outranks_tmux_across_different_groups(tmp_path):
    """A writes HANDOFF.md (tmux group 'old'); B reads it (tmux group 'new').
    The handoff lineage must merge them into ONE thread despite DIFFERENT tmux
    groups — handoff outranks tmux on purpose."""
    st = ThreadStitcher(data_dir=str(tmp_path), time_window=0.0)
    handoff = "/home/user/projects/proj/docs/HANDOFF.md"

    a = _mk_session("A", 1, "alpha", "/home/user/projects/proj", "proj", t=1000.0)
    a.tmux_key = "old"
    a_lines = [contract.RawLine(ts=1500.0, session_id="A", cwd="/p", tool="Write",
                                tool_use_id="w1", file_path=handoff,
                                inp={"content": "next steps..."})]
    ta = st.assign(a, a_lines)
    # A alone keys off its tmux group.
    assert ta.id == _tmux_thread_id("old")

    b = _mk_session("B", 2, "zeta", "/home/user/projects/proj", "proj",
                    t=9_000_000.0)
    b.tmux_key = "new"                  # DIFFERENT tmux group
    b_lines = [contract.RawLine(ts=9_000_001.0, session_id="B", cwd="/p",
                                tool="Read", tool_use_id="r1", file_path=handoff,
                                inp={"file_path": handoff})]
    tb = st.assign(b, b_lines)

    assert tb.id == ta.id, "handoff Write->Read must merge across tmux groups"
    assert "handoff-doc" in tb.stitch
    assert set(tb.session_ids) == {"A", "B"}


# --------------------------------------------------------------------------
# 4) watch_screen streams a Screen; unwatch cancels; refcount per pane
# --------------------------------------------------------------------------
def test_watch_screen_streams_and_unwatch_cancels():
    secret = "ghp_" + "B" * 36       # a token-shaped secret in a frame
    frames = ["hello world\nline two", f"TOKEN={secret}\n$ "]
    fake = FakeTmux({}, frames=frames)
    w = Watcher(poller=FakePoller([]), reader=FakeReader(),
                tmux=fake, poll_interval=999)

    # Register a watched session with a pane directly (no poll needed).
    sess = _mk_session("S", 7, "comms", "/p", "comms")
    sess.tmux_pane = "comms:1.1"
    sess.thread_id = "th_abc"
    w._sessions["S"] = sess

    async def drive():
        sub = w.subscribe()                # a subscriber to receive the broadcast
        w.watch_screen("S")
        assert w._screen_watchers.get("comms:1.1") == 1
        assert "comms:1.1" in w._screen_tasks

        # Pull screen envelopes until we've seen both frames.
        seen: list[dict] = []
        async def pump():
            async for env in sub:
                if env.get("t") == "screen":
                    seen.append(env)
                    if len(seen) >= 2:
                        return
        await asyncio.wait_for(pump(), timeout=2.0)

        # unwatch -> last watcher gone -> task cancelled, bookkeeping cleared.
        task = w._screen_tasks.get("comms:1.1")
        w.unwatch_screen("S")
        assert "comms:1.1" not in w._screen_watchers
        assert "comms:1.1" not in w._screen_tasks
        # give the loop a tick to process the cancellation
        for _ in range(50):
            if task is not None and task.cancelled() or fake.cancelled:
                break
            await asyncio.sleep(0.01)
        assert fake.cancelled, "stream task must be cancelled on last unwatch"
        return seen

    seen = asyncio.run(drive())
    assert len(seen) >= 2
    # The stream was opened on the session's pane.
    assert fake.stream_calls == ["comms:1.1"]
    # Screen wire shape + correlation to the session/thread.
    scr = seen[0]["screen"]
    assert scr["session_id"] == "S"
    assert scr["thread_id"] == "th_abc"
    assert scr["rows"] >= 1 and scr["cols"] >= 1
    # REDACTION (Principle II): the secret frame is masked on the wire.
    joined = "".join(s["screen"]["data"] for s in seen)
    assert secret not in joined, "raw secret must NOT reach the wire"
    assert "redacted" in joined


def test_watch_screen_noop_without_pane():
    """A session with no tmux pane (or unknown id) must no-op gracefully."""
    fake = FakeTmux({})
    w = Watcher(poller=FakePoller([]), reader=FakeReader(),
                tmux=fake, poll_interval=999)
    sess = _mk_session("S", 7, "comms", "/p", "comms")  # tmux_pane stays None
    w._sessions["S"] = sess

    async def drive():
        w.watch_screen("S")             # no pane -> nothing spawned
        assert w._screen_watchers == {}
        assert w._screen_tasks == {}
        w.watch_screen("does-not-exist")  # unknown session -> no-op
        assert w._screen_tasks == {}
        # unwatch on something never watched is a safe no-op
        w.unwatch_screen("S")
        assert fake.stream_calls == []

    asyncio.run(drive())


def test_watch_screen_refcount_shares_one_loop():
    """Two watchers of the SAME pane share ONE capture loop; the loop only stops
    when BOTH have unwatched."""
    fake = FakeTmux({}, frames=["frame-a"])
    w = Watcher(poller=FakePoller([]), reader=FakeReader(),
                tmux=fake, poll_interval=999)
    sess = _mk_session("S", 7, "comms", "/p", "comms")
    sess.tmux_pane = "comms:1.1"
    w._sessions["S"] = sess

    async def drive():
        w.watch_screen("S")
        w.watch_screen("S")             # second watcher of the same pane
        assert w._screen_watchers["comms:1.1"] == 2
        assert len(w._screen_tasks) == 1     # only ONE loop
        await asyncio.sleep(0.02)
        w.unwatch_screen("S")
        # still one watcher left -> loop persists, not cancelled
        assert w._screen_watchers["comms:1.1"] == 1
        assert "comms:1.1" in w._screen_tasks
        assert fake.cancelled is False
        w.unwatch_screen("S")
        # last watcher gone -> cancelled
        assert "comms:1.1" not in w._screen_tasks
        for _ in range(50):
            if fake.cancelled:
                break
            await asyncio.sleep(0.01)
        assert fake.cancelled is True

    asyncio.run(drive())


if __name__ == "__main__":  # manual run
    import pytest  # noqa
    raise SystemExit(pytest.main([__file__, "-q"]))
