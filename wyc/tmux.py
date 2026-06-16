"""wyc.tmux — TmuxSource: enumerate live `claude` panes and stream rendered screens.

tmux gives, BETTER than transcripts, three things:
  1. liveness        — a `claude` proc actually owns a live pane right now;
  2. identity        — the tmux session name + group == the work + handoff chain;
  3. the live screen — the literal rendered TUI (capture-pane), including shell
                       output as it streams.

This module is OBSERVER-ONLY (constitution Principle I): it only ever READS tmux
and /proc — never `send-keys`, never writes. Captured screen text is returned RAW
(ANSI-bearing, unredacted); the parent redacts via `wyc.redact` before the wire
(Principle II). We do NOT parse the rendered text for structure (which file/line);
that stays the transcript's job — identity / liveness / screen only.

Implements the `TmuxSource` Protocol in `wyc.contract`.
"""
from __future__ import annotations

import asyncio
import subprocess
import time
from typing import AsyncIterator, Callable, Optional

# ---------------------------------------------------------------- constants
_CLAUDE_CMD = "claude"          # tmux pane_current_command for a claude pane
_TMUX_TIMEOUT = 2.0             # short; subprocess calls must never hang the watcher
_PANE_CACHE_TTL = 1.0           # Principle VII: don't poll tmux harder than ~1s

# Field separator for `tmux list-panes -F`. Must be PRINTABLE: tmux's `-F` escapes
# non-printable bytes (a raw \x1f comes back as the literal 4-char string "\037"),
# so a control char would mangle the split. This token is vanishingly unlikely to
# appear inside a pane_title / session_name, and tmux passes it through verbatim.
_FS = "│@wyc@│"       # │@wyc@│  (box-drawing bars bracket a sentinel)

# The format string. Order MUST match _PANE_FIELDS below.
_PANE_FMT = _FS.join([
    "#{pane_id}",                                          # %12
    "#{session_name}:#{window_index}.#{pane_index}",       # comms:1.1  (capture target)
    "#{pane_pid}",
    "#{pane_current_command}",
    "#{session_name}",
    "#{session_group}",
    "#{window_active}",
    "#{pane_active}",
    "#{pane_title}",
])
_PANE_FIELDS = (
    "pane_id", "pane", "pane_pid", "command",
    "session_name", "session_group", "window_active", "pane_active", "title",
)


# ---------------------------------------------------------------- subprocess helper
def _run(args: list[str], timeout: float = _TMUX_TIMEOUT) -> Optional[str]:
    """Run a command, return stdout (str) on rc==0, else None. Never raises."""
    try:
        proc = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            text=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout


def tmux_available() -> bool:
    """True if a tmux binary exists AND a server is reachable (has sessions)."""
    # `tmux has-session` with no target errors; `list-panes -a` returns rc 0 even
    # with zero panes when a server is up, and rc 1 ("no server running") otherwise.
    out = _run(["tmux", "list-sessions", "-F", "#{session_name}"])
    return out is not None


# ---------------------------------------------------------------- /proc ancestry
def _read_ppid(pid: int) -> Optional[int]:
    """Parent pid of `pid` from /proc/<pid>/stat, or None.

    /proc/<pid>/stat layout: `PID (comm) STATE PPID ...`. `comm` is wrapped in
    parens and may itself contain spaces or `)` (e.g. `(tmux: server)`), so we
    split on the LAST `)` and index the remaining whitespace-delimited fields:
    after the last ')', fields are [state, ppid, ...] (ppid is index 1).
    """
    try:
        with open(f"/proc/{pid}/stat", "r") as fh:
            data = fh.read()
    except (OSError, ValueError):
        return None
    rparen = data.rfind(")")
    if rparen < 0:
        return None
    rest = data[rparen + 1:].split()
    if len(rest) < 2:
        return None
    try:
        return int(rest[1])
    except ValueError:
        return None


def _proc_comm(pid: int) -> Optional[str]:
    """The `comm` (executable name) of `pid` from /proc/<pid>/stat, or None."""
    try:
        with open(f"/proc/{pid}/stat", "r") as fh:
            data = fh.read()
    except (OSError, ValueError):
        return None
    lparen = data.find("(")
    rparen = data.rfind(")")
    if lparen < 0 or rparen <= lparen:
        return None
    return data[lparen + 1:rparen]


def _ancestors(pid: int, ppid_of: Callable[[int], Optional[int]],
               max_depth: int = 64) -> list[int]:
    """The chain [pid, parent, grandparent, ...] up to (not including) pid 0/1.

    Pure + testable: ppid resolution is injected. Stops at pid<=1, on a None
    parent, on a cycle, or at max_depth (defensive against malformed maps)."""
    chain: list[int] = []
    seen: set[int] = set()
    cur: Optional[int] = pid
    depth = 0
    while cur is not None and cur > 1 and cur not in seen and depth < max_depth:
        chain.append(cur)
        seen.add(cur)
        cur = ppid_of(cur)
        depth += 1
    return chain


def _match_identity(pid: int, panes: list[dict],
                    ppid_of: Callable[[int], Optional[int]]) -> Optional[dict]:
    """Return the pane dict whose process tree holds `pid`, else None. Pure +
    testable (ppid resolution injected). Matches BOTH directions:
      (a) some ancestor of `pid` is a pane_pid  -> claude runs under that pane;
      (b) `pid` is an ancestor-or-equal of a pane_pid -> the pane shell is a
          descendant of `pid`.
    Direction (a) is checked first (the common registry-pid -> shell-ancestor case).
    """
    if not panes:
        return None
    pane_pids = {p["pid"]: p for p in panes}

    # (a) walk UP from pid; first ancestor that is a pane_pid wins.
    for anc in _ancestors(pid, ppid_of):
        pane = pane_pids.get(anc)
        if pane is not None:
            return pane

    # (b) for each pane, walk UP from its pane_pid; if we hit `pid`, it owns it.
    for pane in panes:
        for anc in _ancestors(pane["pid"], ppid_of):
            if anc == pid:
                return pane
    return None


# ---------------------------------------------------------------- parser (pure)
def _parse_panes(raw: str, claude_only: bool = True,
                 is_claude_pid: Optional[Callable[[int], bool]] = None) -> list[dict]:
    """Parse `tmux list-panes -a -F <_PANE_FMT>` output into pane dicts.

    Pure function (no subprocess / no tmux) so it is unit-testable with canned
    output. Keeps ONLY panes whose current_command is `claude`, or — when an
    `is_claude_pid` predicate is supplied — whose process tree contains a claude
    proc (catches claude running under a wrapper shell where pane_current_command
    is `bash`/`zsh`). Each returned dict matches the contract shape:
        {pane, pane_id, pid, tmux_session, tmux_group, command, active, title}
    """
    panes: list[dict] = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        parts = line.split(_FS)
        if len(parts) < len(_PANE_FIELDS):
            # malformed / unexpected row — skip rather than misalign fields
            continue
        rec = dict(zip(_PANE_FIELDS, parts))
        try:
            pid = int(rec["pane_pid"])
        except (ValueError, KeyError):
            continue

        command = rec.get("command", "")
        if claude_only:
            keep = command == _CLAUDE_CMD
            if not keep and is_claude_pid is not None:
                keep = is_claude_pid(pid)
            if not keep:
                continue

        group = rec.get("session_group") or None     # tmux emits "" when no group
        # a pane is "active" when both its window is the active window AND it is the
        # active pane within that window (the literal pane you'd see attached).
        active = rec.get("window_active") == "1" and rec.get("pane_active") == "1"
        panes.append({
            "pane": rec["pane"],
            "pane_id": rec.get("pane_id") or None,
            "pid": pid,
            "tmux_session": rec.get("session_name") or None,
            "tmux_group": group,
            "command": command,
            "active": active,
            "title": rec.get("title") or None,
        })
    return panes


# ---------------------------------------------------------------- TmuxSource
class TmuxSource:
    """Read-only enumerator + screen streamer for live `claude` tmux panes.

    Implements the `wyc.contract.TmuxSource` Protocol. Thread-safe enough for the
    watcher's single-loop use; the pane list is cached for ~1s (Principle VII)."""

    def __init__(self, *, deep_scan: bool = True, cache_ttl: float = _PANE_CACHE_TTL):
        # deep_scan: also keep panes whose current_command isn't `claude` but whose
        # process tree contains a claude proc (claude-under-a-shell). Costs one /proc
        # walk per non-claude pane; cheap and bounded.
        self._deep_scan = deep_scan
        self._cache_ttl = cache_ttl
        self._cache: Optional[list[dict]] = None
        self._cache_at: float = 0.0
        # set of pane_pids from the last enumeration, for identity ancestor matching
        self._pane_pids: dict[int, dict] = {}

    # -- liveness / identity --------------------------------------------------
    def _claude_pid_predicate(self) -> Callable[[int], bool]:
        """A predicate: does the process tree rooted at `pane_pid` contain a claude
        proc? Used in deep_scan to catch claude-under-a-shell. Bounded breadth via
        `tmux`-provided pane_pid as the root + a small descendant scan using pgrep."""
        def pred(pane_pid: int) -> bool:
            # quick path: is the pane_pid itself claude?
            if _proc_comm(pane_pid) == _CLAUDE_CMD:
                return True
            # one level of children is the common case (shell -> claude).
            out = _run(["pgrep", "-P", str(pane_pid)], timeout=1.0)
            if not out:
                return False
            for tok in out.split():
                try:
                    child = int(tok)
                except ValueError:
                    continue
                if _proc_comm(child) == _CLAUDE_CMD:
                    return True
            return False
        return pred

    def panes(self) -> list[dict]:
        """Live `claude` panes as contract dicts. [] if tmux absent / no server."""
        now = time.monotonic()
        if self._cache is not None and (now - self._cache_at) < self._cache_ttl:
            return self._cache
        raw = _run(["tmux", "list-panes", "-a", "-F", _PANE_FMT])
        if raw is None:
            # tmux missing or no server: cache an empty result briefly too, so a
            # tight watcher loop doesn't shell out every iteration.
            self._cache = []
            self._cache_at = now
            self._pane_pids = {}
            return self._cache
        pred = self._claude_pid_predicate() if self._deep_scan else None
        panes = _parse_panes(raw, claude_only=True, is_claude_pid=pred)
        self._cache = panes
        self._cache_at = now
        self._pane_pids = {p["pid"]: p for p in panes}
        return panes

    def identity_for(self, pid: Optional[int]) -> Optional[dict]:
        """Identity {tmux_session, tmux_group, pane} for the pane owning `pid`.

        Matches in BOTH directions because the registry records claude's own pid
        while a pane_pid may be a parent shell (or vice-versa). See
        `_match_identity` for the matching rules. Returns None if pid is None or
        no pane is on its process line."""
        if pid is None:
            return None
        panes = self.panes()                 # refresh + populate self._pane_pids
        pane = _match_identity(int(pid), panes, _read_ppid)
        return self._ident(pane) if pane is not None else None

    @staticmethod
    def _ident(pane: dict) -> dict:
        return {
            "tmux_session": pane.get("tmux_session"),
            "tmux_group": pane.get("tmux_group"),
            "pane": pane.get("pane"),
        }

    def thread_key(self, ident: Optional[dict]) -> Optional[str]:
        """Preferred clean thread/handoff-chain key from an identity dict.

        Group wins (it IS the handoff chain in tmux); else the session name with a
        trailing `-<N>` numeric suffix stripped (`constructionmanagement-10` ->
        `constructionmanagement`). The parent's stitcher prefers this over a fuzzy
        name-stem. Returns None when there's nothing usable."""
        if not ident:
            return None
        group = ident.get("tmux_group")
        if group:
            return group
        sess = ident.get("tmux_session")
        if not sess:
            return None
        return _strip_numeric_suffix(sess)

    # -- screen ---------------------------------------------------------------
    def capture(self, pane: str, history: int = 0) -> str:
        """One rendered snapshot of `pane` (ANSI preserved). RAW/unredacted — the
        parent redacts before the wire. `history` adds that many scrollback lines.
        Empty string on any error (bad pane, tmux gone)."""
        if not pane:
            return ""
        args = ["tmux", "capture-pane", "-t", pane, "-p", "-e"]
        if history and history > 0:
            args += ["-S", f"-{int(history)}"]
        out = _run(args)
        return out if out is not None else ""

    async def stream(self, pane: str, interval: float = 1.0) -> AsyncIterator[str]:
        """Async generator: yield the pane's rendered text whenever it CHANGES.

        Captures every `interval` seconds (blocking capture runs in a thread so the
        event loop stays free), diffs against the last frame, and yields the FULL
        frame on change. The first non-empty frame is always yielded. Stop by
        cancelling the consuming task. Feeds Screen events for watched panes."""
        loop = asyncio.get_event_loop()
        last: Optional[str] = None
        while True:
            frame = await loop.run_in_executor(None, self.capture, pane, 0)
            if frame != last:
                last = frame
                if frame:                    # don't emit empty (pane gone) frames
                    yield frame
            await asyncio.sleep(max(0.1, interval))


# ---------------------------------------------------------------- key helper (pure)
def _strip_numeric_suffix(name: str) -> str:
    """`foo-10` -> `foo`; `foo` -> `foo`; `foo-bar` -> `foo-bar` (only strips a
    trailing `-<digits>`, which is how tmux disambiguates grouped sessions)."""
    idx = name.rfind("-")
    if idx > 0 and name[idx + 1:].isdigit():
        return name[:idx]
    return name
