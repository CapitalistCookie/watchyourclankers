"""wyc.watcher — orchestrate poll + tail + stitch + redact into one stream.

Implements the :class:`contract.Watcher` Protocol. SERVERHOOK consumes this; it
never re-reads disk.

The async :meth:`run` loop:

  1. polls sessions (~1.5s) via :class:`wyc.sessions.SessionPoller`;
  2. for each live session, tails its transcript + sub-agent files by byte
     offset via :class:`wyc.transcripts.TranscriptReader`;
  3. converts :class:`contract.RawLine`\\ s → :class:`contract.Activity`
     (Edit→hunk_old/new, Write→hunk_new, Bash→detail + a follow-up
     :class:`contract.Terminal` when the tool_result lands, Read/Grep→file/detail);
  4. assigns a thread via :class:`wyc.threads.ThreadStitcher`;
  5. **redacts** every wire-bound value via :mod:`wyc.redact` BEFORE emitting
     (Principle II);
  6. assigns a monotonic ``seq`` and broadcasts wire envelopes.

State is kept for :meth:`snapshot` and a bounded replay buffer powers
:meth:`since`. :meth:`subscribe` yields wire dicts via a per-subscriber queue.
Per-activity work is O(1). Drop-slow applies ONLY to activity/terminal floods,
never to session/thread updates.

Principle I: READ-ONLY over observed artifacts (poll + tail only).
"""
from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import AsyncIterator, Optional

from . import contract
from . import redact as _redact
from .sessions import SessionPoller
from .transcripts import TranscriptReader
from .threads import ThreadStitcher
from .tmux import TmuxSource

POLL_INTERVAL = 1.5           # seconds between session polls (FR-001)
REPLAY_MAXLEN = 2000          # bounded replay buffer for since(seq)
SUB_QUEUE_MAX = 1000          # per-subscriber backpressure bound (drop-slow)


def _parse_exit_code(text: Optional[str]) -> Optional[int]:
    """Best-effort exit code from a tool_result body (looks for explicit markers).

    Transcript Bash results don't carry a structured exit code, but failures
    often print one. We stay conservative: only return an int when a clear
    ``exit code: N`` / ``exited with N`` marker is present; otherwise None and
    the watcher infers success/failure from ``is_error``."""
    if not text:
        return None
    import re
    m = re.search(r"(?i)\bexit(?:ed)?(?:\s+with)?(?:\s+code)?\s*[:=]?\s*(-?\d{1,3})\b", text)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            return None
    return None


def _frame_dims(frame: str) -> tuple[int, int]:
    """Best-effort (cols, rows) for a captured tmux frame.

    rows = line count; cols = widest line (after stripping ANSI/CR so escape
    sequences don't inflate the width). Both 0 for an empty frame. Advisory only
    — the literal text is the source of truth; cols/rows just help the UI size a
    terminal surface."""
    if not frame:
        return (0, 0)
    import re
    _ansi = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
    lines = frame.split("\n")
    rows = len(lines)
    cols = 0
    for ln in lines:
        w = len(_ansi.sub("", ln).rstrip("\r"))
        if w > cols:
            cols = w
    return (cols, rows)


class _FileCursor:
    """Tail offset bookkeeping for one transcript/sub-agent file."""
    __slots__ = ("offset",)

    def __init__(self) -> None:
        self.offset = 0


class Watcher:
    """Implements :class:`contract.Watcher`.

    Parameters
    ----------
    poller / reader / stitcher:
        Injectable collaborators (tests). Defaults wire the real ones.
    poll_interval:
        Override the poll cadence (tests use a tiny value).
    """

    def __init__(self, poller: Optional[SessionPoller] = None,
                 reader: Optional[TranscriptReader] = None,
                 stitcher: Optional[ThreadStitcher] = None,
                 tmux: Optional[TmuxSource] = None,
                 poll_interval: float = POLL_INTERVAL) -> None:
        self._poller = poller or SessionPoller()
        self._reader = reader or TranscriptReader()
        self._stitcher = stitcher or ThreadStitcher()
        # ONE shared TmuxSource: its ~1s pane cache makes identity_for() cheap
        # across every session in a tick. Injectable for tests; robust if tmux is
        # absent (panes()/identity_for() return []/None -> unchanged behavior).
        self._tmux = tmux or TmuxSource()
        self._poll_interval = poll_interval

        self._seq = 0
        self._sessions: dict[str, contract.Session] = {}
        self._cursors: dict[str, _FileCursor] = {}      # path -> cursor
        # tool_use_id -> (activity_seq, session_id, thread_id, agent_id, kind, tool)
        self._toolmap: dict[str, dict] = {}
        # session_id -> set of sub-agent paths we've discovered (for Session.subagents)
        self._sub_paths: dict[str, set] = {}

        self._replay: deque = deque(maxlen=REPLAY_MAXLEN)   # (seq, envelope)
        self._subscribers: list[asyncio.Queue] = []
        self._recent_acts: deque = deque(maxlen=200)        # warm-start tail
        self._running = False

        # -- live screen watching (tmux capture-pane stream) ------------------
        # Refcount watchers per tmux pane so N clients watching the same pane share
        # ONE capture loop. pane -> count; pane -> asyncio.Task running the stream.
        self._screen_watchers: dict[str, int] = {}
        self._screen_tasks: dict[str, asyncio.Task] = {}

    # -- seq + broadcast --------------------------------------------------
    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    def _broadcast(self, envelope: dict, *, droppable: bool) -> None:
        """Push an envelope to the replay buffer + every subscriber queue.

        ``droppable`` (activity/terminal) may be dropped for a slow subscriber;
        session/thread updates are NEVER dropped (block-free put; if a queue is
        full of droppables we evict the oldest droppable to make room)."""
        if "seq" in envelope:
            self._replay.append((envelope["seq"], envelope))
        elif envelope.get("t") in ("activity", "terminal"):
            inner = envelope.get(envelope["t"], {})
            self._replay.append((inner.get("seq"), envelope))

        dead: list[asyncio.Queue] = []
        for q in self._subscribers:
            try:
                q.put_nowait(envelope)
            except asyncio.QueueFull:
                if droppable:
                    continue  # drop-slow on high-rate surfaces
                # Non-droppable: evict oldest to guarantee delivery.
                try:
                    q.get_nowait()
                    q.put_nowait(envelope)
                except Exception:
                    dead.append(q)
        for q in dead:
            if q in self._subscribers:
                self._subscribers.remove(q)

    # -- RawLine -> wire --------------------------------------------------
    def _emit_activity_from_raw(self, ln: contract.RawLine,
                                session: contract.Session) -> None:
        """Convert a tool_use RawLine to a redacted Activity and broadcast it."""
        kind = contract.kind_for_tool(ln.tool)
        seq = self._next_seq()
        act = contract.Activity(
            seq=seq,
            ts=ln.ts or time.time(),
            session_id=session.id,
            thread_id=session.thread_id,
            kind=kind,
            tool=ln.tool,
            agent_id=ln.agent_id,
            file_path=ln.file_path,
            status="start",
        )
        inp = ln.inp or {}
        if kind == contract.KIND_EDIT:
            act.hunk_old = inp.get("old_string")
            act.hunk_new = inp.get("new_string")
        elif kind == contract.KIND_WRITE:
            act.hunk_new = inp.get("content")
        elif kind == contract.KIND_BASH:
            act.detail = inp.get("command")
        elif kind == contract.KIND_SEARCH:
            act.detail = inp.get("pattern") or inp.get("query") or inp.get("path")
        elif kind == contract.KIND_TASK:
            act.detail = inp.get("description") or inp.get("subagent_type") or inp.get("prompt")
        elif kind == contract.KIND_READ:
            # file_path already set; nothing else needed.
            pass
        elif kind == contract.KIND_WEB:
            act.detail = inp.get("url") or inp.get("query")
        else:
            # KIND_OTHER / KIND_TODO: surface a best-effort detail so nothing is invisible.
            act.detail = inp.get("description") or inp.get("command") or inp.get("query")

        # Remember the tool_use so its later tool_result can resolve status /
        # produce a Terminal (Bash).
        if ln.tool_use_id:
            self._toolmap[ln.tool_use_id] = {
                "seq": seq, "session_id": session.id, "thread_id": session.thread_id,
                "agent_id": ln.agent_id, "kind": kind, "tool": ln.tool,
            }

        # REDACT before the wire (Principle II).
        act = _redact.redact_activity(act)
        env = contract.activity_msg(act)
        self._recent_acts.append(act)
        self._broadcast(env, droppable=True)

        # Track current surface/file on the session (cheap O(1) update).
        session.current_surface = kind
        if ln.file_path:
            session.current_file = ln.file_path

    def _emit_result_from_raw(self, ln: contract.RawLine) -> None:
        """Handle a tool_result RawLine: update the source activity's status and,
        for Bash, emit a redacted Terminal chunk (done=True)."""
        if not ln.tool_use_id:
            return
        src = self._toolmap.get(ln.tool_use_id)
        if src is None:
            return
        status = "error" if ln.is_error else "ok"

        # Re-emit the activity with resolved status (status flips start->ok/error).
        # Cheap: a tiny activity update keyed by the SAME seq is not allowed (seq
        # is monotonic per message), so we emit a fresh-seq activity carrying the
        # resolved status; the UI keys updates by (session_id, file/seq) as it sees fit.
        # For Bash, the important wire artifact is the Terminal.
        if src["kind"] == contract.KIND_BASH:
            term = contract.Terminal(
                seq=self._next_seq(),
                ts=ln.ts or time.time(),
                session_id=src["session_id"],
                thread_id=src["thread_id"],
                ref_seq=src["seq"],
                data=ln.result_text or "",
                agent_id=src.get("agent_id"),
                stream="mixed",
                done=True,
                exit_code=_parse_exit_code(ln.result_text) if not ln.is_error
                else (_parse_exit_code(ln.result_text) or 1),
            )
            term = _redact.redact_terminal(term)
            self._broadcast(contract.terminal_msg(term), droppable=True)

        # Status-update activity (lightweight; status only). Keeps the ticker
        # accurate (ok/error) for every tool, Bash included.
        upd = contract.Activity(
            seq=self._next_seq(),
            ts=ln.ts or time.time(),
            session_id=src["session_id"],
            thread_id=src["thread_id"],
            kind=src["kind"],
            tool=src["tool"],
            agent_id=src.get("agent_id"),
            status=status,
        )
        # No hunks/detail on a status update -> nothing to redact, but stay safe.
        upd = _redact.redact_activity(upd)
        self._broadcast(contract.activity_msg(upd), droppable=True)
        # Done with this tool_use.
        self._toolmap.pop(ln.tool_use_id, None)

    # -- per-session tail -------------------------------------------------
    def _tail_session(self, session: contract.Session) -> list[contract.RawLine]:
        """Read all new RawLines for a session (main + sub-agents). Updates
        Session.subagents. Returns the combined RawLines (for the stitcher)."""
        collected: list[contract.RawLine] = []

        main = self._reader.transcript_path(session.id)
        paths: list[str] = []
        if main:
            paths.append(main)
        sub_paths = self._reader.subagent_paths(session.id)
        if sub_paths:
            known = self._sub_paths.setdefault(session.id, set())
            for p in sub_paths:
                known.add(p)
            paths.extend(sub_paths)
            # Reflect discovered sub-agents on the Session (ids, not paths).
            agent_ids = []
            for p in sorted(known):
                aid = TranscriptReader._agent_id_for_path(p)
                if aid:
                    agent_ids.append(aid)
            session.subagents = agent_ids

        for path in paths:
            cur = self._cursors.setdefault(path, _FileCursor())
            try:
                lines, new_off = self._reader.read_new(path, cur.offset)
            except Exception:
                continue
            cur.offset = new_off
            collected.extend(lines)

        # Stable order by timestamp so Activities stream in causal order.
        collected.sort(key=lambda r: r.ts or 0.0)
        return collected

    # -- one poll cycle ---------------------------------------------------
    def _poll_once(self) -> None:
        """Synchronous body of one loop iteration (poll + tail + emit)."""
        sessions = self._poller.poll()
        seen_ids = set()

        for sess in sessions:
            seen_ids.add(sess.id)
            # Tail BEFORE thread assignment so the stitcher sees fresh handoff
            # signals from this poll.
            new_lines = self._tail_session(sess)

            # Tmux identity: stamp the session with its live pane/session/group and
            # stash a high-priority tmux thread-key for the stitcher. The shared
            # TmuxSource caches its pane list ~1s, so this is cheap for every
            # session in the tick. No-op if tmux is absent (identity_for -> None).
            self._apply_tmux_identity(sess)

            # Assign thread (tmux group + clanker repo + name-stem + handoff + time).
            thread = self._stitcher.assign(sess, new_lines)
            sess.thread_id = thread.id

            # Detect changes vs last-known session to decide on a session_update.
            prev = self._sessions.get(sess.id)
            changed = (
                prev is None
                or prev.status != sess.status
                or prev.thread_id != sess.thread_id
                or prev.current_surface != sess.current_surface
                or prev.current_file != sess.current_file
                or prev.subagents != sess.subagents
                or prev.tmux_pane != sess.tmux_pane
                or prev.tmux_session != sess.tmux_session
                or prev.tmux_group != sess.tmux_group
            )
            self._sessions[sess.id] = sess

            # Emit activities/terminals for the new lines (these also mutate
            # current_surface/current_file on `sess`).
            for ln in new_lines:
                if ln.is_result:
                    self._emit_result_from_raw(ln)
                else:
                    self._emit_activity_from_raw(ln, sess)

            # Session update (NON-droppable) if anything material changed or new lines arrived.
            if changed or new_lines:
                self._broadcast(contract.session_update(self._next_seq(), sess),
                                droppable=False)

            # Thread update (NON-droppable) — cheap; UI keeps the chain fresh.
            self._broadcast(contract.thread_update(self._next_seq(), thread),
                            droppable=False)

        # Mark vanished sessions as ended (status-only update; keep in history).
        for sid, sess in list(self._sessions.items()):
            if sid not in seen_ids and sess.status != "ended":
                sess.status = "ended"
                self._broadcast(contract.session_update(self._next_seq(), sess),
                                droppable=False)

    # -- tmux identity ----------------------------------------------------
    def _apply_tmux_identity(self, sess: contract.Session) -> None:
        """Stamp ``sess`` with its live tmux pane/session/group and stash a
        transient ``tmux_key`` for the stitcher. Fully best-effort: any tmux
        failure leaves the session unchanged (identity-less sessions still
        stitch by name/handoff/time)."""
        try:
            ident = self._tmux.identity_for(sess.pid)
        except Exception:
            ident = None
        if not ident:
            return
        sess.tmux_session = ident.get("tmux_session")
        sess.tmux_group = ident.get("tmux_group")
        sess.tmux_pane = ident.get("pane")
        # Transient attribute the stitcher reads (it's not a wire field of its own;
        # the durable identity is the three tmux_* fields above + the thread it
        # produces). Group wins; else session name with a -<N> suffix stripped.
        try:
            sess.tmux_key = self._tmux.thread_key(ident)  # type: ignore[attr-defined]
        except Exception:
            sess.tmux_key = None  # type: ignore[attr-defined]

    # -- live screen watching (tmux capture-pane) -------------------------
    def watch_screen(self, session_id: str) -> None:
        """Begin streaming raw rendered ``Screen`` frames for a session's tmux
        pane to all subscribers. Refcounted per pane: the first watcher of a pane
        spawns one capture loop; later watchers share it. No-op (graceful) if the
        session is unknown or has no tmux pane."""
        sess = self._sessions.get(session_id)
        if sess is None or not sess.tmux_pane:
            return  # nothing to mirror (no pane / unknown session)
        pane = sess.tmux_pane
        self._screen_watchers[pane] = self._screen_watchers.get(pane, 0) + 1
        if self._screen_watchers[pane] > 1:
            return  # a capture loop is already running for this pane
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            # No running loop (e.g. a unit test calling without a loop): leave the
            # refcount bumped but don't spawn; a later call under a loop will start.
            return
        self._screen_tasks[pane] = loop.create_task(
            self._stream_screen(pane, session_id))

    def unwatch_screen(self, session_id: str) -> None:
        """Stop one watcher of a session's pane. When the last watcher leaves, the
        capture loop is cancelled. No-op if the session/pane wasn't being watched."""
        sess = self._sessions.get(session_id)
        if sess is None or not sess.tmux_pane:
            return
        pane = sess.tmux_pane
        n = self._screen_watchers.get(pane, 0)
        if n <= 0:
            return
        n -= 1
        if n > 0:
            self._screen_watchers[pane] = n
            return
        # Last watcher gone: cancel + drop the capture loop.
        self._screen_watchers.pop(pane, None)
        task = self._screen_tasks.pop(pane, None)
        if task is not None:
            task.cancel()

    async def _stream_screen(self, pane: str, session_id: str) -> None:
        """Consume ``TmuxSource.stream(pane)`` and broadcast redacted Screen frames.

        Each changed frame becomes a :class:`contract.Screen` (REDACTED before the
        wire — Principle II) and is broadcast drop-slow, same path as
        activity/terminal (a fast screen feed must never block session/thread
        updates). thread_id is resolved fresh per frame from the current session."""
        try:
            async for frame in self._tmux.stream(pane):
                sess = self._sessions.get(session_id)
                thread_id = sess.thread_id if sess is not None else ""
                cols, rows = _frame_dims(frame)
                scr = contract.Screen(
                    seq=self._next_seq(),
                    ts=time.time(),
                    session_id=session_id,
                    thread_id=thread_id,
                    data=_redact.redact(frame) or "",
                    cols=cols,
                    rows=rows,
                )
                self._broadcast(contract.screen_msg(scr), droppable=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            # A streaming error must not crash the watcher; just stop this pane's
            # loop and clear its bookkeeping so a re-watch can restart cleanly.
            self._screen_watchers.pop(pane, None)
            self._screen_tasks.pop(pane, None)

    # -- Protocol: run ----------------------------------------------------
    async def run(self) -> None:
        """Run the poll loop until cancelled."""
        self._running = True
        try:
            while self._running:
                # Offload the (blocking) disk work to a thread so the event loop
                # stays responsive for subscribers.
                await asyncio.get_event_loop().run_in_executor(None, self._poll_once)
                await asyncio.sleep(self._poll_interval)
        except asyncio.CancelledError:
            self._running = False
            raise

    def stop(self) -> None:
        self._running = False

    # -- Protocol: snapshot ----------------------------------------------
    def snapshot(self) -> dict:
        """Current world as a ``snapshot`` envelope (contract.snapshot)."""
        return contract.snapshot(
            seq=self._seq,
            server_ts=time.time(),
            threads=self._stitcher.threads(),
            sessions=list(self._sessions.values()),
            recent=list(self._recent_acts),
        )

    # -- Protocol: subscribe ---------------------------------------------
    def subscribe(self) -> "AsyncIterator[dict]":
        """Yield wire envelopes for a new subscriber (per-subscriber queue)."""
        q: asyncio.Queue = asyncio.Queue(maxsize=SUB_QUEUE_MAX)
        self._subscribers.append(q)

        async def _gen() -> AsyncIterator[dict]:
            try:
                while True:
                    env = await q.get()
                    yield env
            finally:
                if q in self._subscribers:
                    self._subscribers.remove(q)

        return _gen()

    # -- Protocol: since (replay) ----------------------------------------
    async def since(self, seq: int) -> list[dict]:
        """Replay envelopes with seq > ``seq``. Empty list if the requested seq
        is older than the buffer (caller should re-snapshot)."""
        if not self._replay:
            return []
        oldest = None
        for s, _env in self._replay:
            if s is not None:
                oldest = s
                break
        if oldest is None:
            return []
        if seq < oldest - 1:
            # Gap: requested point fell out of the bounded buffer.
            return []
        return [env for (s, env) in self._replay if s is not None and s > seq]


if __name__ == "__main__":  # pragma: no cover - manual READ-ONLY smoke
    import sys

    async def _demo() -> None:
        w = Watcher(poll_interval=1.5)
        w._poll_once()
        snap = w.snapshot()
        print(f"[watcher] snapshot seq={snap['seq']} "
              f"sessions={len(snap['sessions'])} threads={len(snap['threads'])} "
              f"recent_acts={len(snap['recent'])}", file=sys.stderr)

    asyncio.run(_demo())
