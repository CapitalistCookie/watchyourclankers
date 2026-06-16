"""watchyourclankers — the contract (THE merge seam). PARENT-ONLY (H15).

Single source of truth for:
  1. the WebSocket wire protocol (server <-> browser), mirrored 1:1 in
     contracts/events.schema.json, and
  2. the internal interfaces (Protocols) each backend module implements, so
     FEED (sessions/transcripts/threads/watcher) and SERVERHOOK (server/handoff)
     can be built by independent sub-agents that code to THIS file, never to
     each other.

Implementations MUST conform to the dataclasses/Protocols here. If the wire
changes, bump PROTOCOL_VERSION and update events.schema.json in the same change.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Protocol, Iterator, Iterable, Optional, Callable, Any, AsyncIterator

PROTOCOL_VERSION = 1

DEFAULT_HOST = "127.0.0.1"   # loopback only (Principle II); NEVER 0.0.0.0 by default
DEFAULT_PORT = 8900          # clanker dashboard owns 8899 — do not collide

# ---------------------------------------------------------------- paths (this box)
CLAUDE_HOME = "/home/user/.claude"
SESSIONS_DIR = f"{CLAUDE_HOME}/sessions"        # <pid>.json live session registry
PROJECTS_DIR = f"{CLAUDE_HOME}/projects"        # <slug>/<uuid>.jsonl transcripts (+ /subagents/agent-<id>.jsonl)
DATA_DIR = "/data/clanker/watchyourclankers"    # our own state: overrides, aliases, annotations
CLANKER_PROJECTS_PY = "/home/user/projects/clanker/lib/projects.py"  # reuse resolve_project(cwd)

# ---------------------------------------------------------------- activity kinds
# TOTAL COVERAGE: every Claude tool action maps to exactly one surface.
KIND_EDIT, KIND_WRITE, KIND_READ = "edit", "write", "read"
KIND_BASH, KIND_SEARCH, KIND_TASK = "bash", "search", "task"
KIND_TODO, KIND_WEB, KIND_OTHER = "todo", "web", "other"

# raw tool name -> surface kind. Unknown tools fall through to KIND_OTHER so the
# activity ticker still shows them (nothing Claude does is invisible).
TOOL_KIND: dict[str, str] = {
    "Edit": KIND_EDIT, "MultiEdit": KIND_EDIT, "NotebookEdit": KIND_EDIT,
    "Write": KIND_WRITE,
    "Read": KIND_READ, "NotebookRead": KIND_READ,
    "Bash": KIND_BASH, "BashOutput": KIND_BASH, "KillShell": KIND_BASH,
    "Grep": KIND_SEARCH, "Glob": KIND_SEARCH, "LS": KIND_SEARCH,
    "Task": KIND_TASK, "Agent": KIND_TASK, "Workflow": KIND_TASK,
    "TodoWrite": KIND_TODO, "TaskCreate": KIND_TODO, "TaskUpdate": KIND_TODO,
    "WebFetch": KIND_WEB, "WebSearch": KIND_WEB,
}

def kind_for_tool(tool: str) -> str:
    return TOOL_KIND.get(tool, KIND_OTHER)


# ---------------------------------------------------------------- wire dataclasses
@dataclass
class Activity:
    seq: int
    ts: float
    session_id: str
    thread_id: str
    kind: str
    tool: str
    agent_id: Optional[str] = None
    file_path: Optional[str] = None
    line: Optional[int] = None
    hunk_old: Optional[str] = None
    hunk_new: Optional[str] = None
    detail: Optional[str] = None        # bash command / search pattern / task subject
    status: str = "start"               # start | ok | error

    def wire(self) -> dict:
        return {k: v for k, v in asdict(self).items()}


@dataclass
class Terminal:
    """Shell output for a bash Activity. One chunk (transcript tool_result) or
    many chunks (live PTY capture). Correlated to its Activity via ref_seq."""
    seq: int
    ts: float
    session_id: str
    thread_id: str
    ref_seq: int
    data: str
    agent_id: Optional[str] = None
    stream: str = "mixed"               # stdout | stderr | mixed
    done: bool = False
    exit_code: Optional[int] = None

    def wire(self) -> dict:
        return {k: v for k, v in asdict(self).items()}


@dataclass
class Session:
    id: str
    thread_id: str
    status: str                          # busy | idle | ended
    pid: Optional[int] = None
    name: Optional[str] = None
    cwd: Optional[str] = None
    project: Optional[str] = None
    model: Optional[str] = None
    started_at: Optional[float] = None
    updated_at: Optional[float] = None
    current_surface: str = KIND_OTHER
    current_file: Optional[str] = None
    subagents: list[str] = field(default_factory=list)

    def wire(self) -> dict:
        return asdict(self)


@dataclass
class Thread:
    id: str
    title: str
    project: Optional[str] = None
    session_ids: list[str] = field(default_factory=list)   # oldest -> newest
    lead_session_id: Optional[str] = None
    created_at: Optional[float] = None
    updated_at: Optional[float] = None
    stitch: list[str] = field(default_factory=list)         # name-stem|handoff-doc|time|manual

    def wire(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------- envelope helpers
def msg(t: str, **payload) -> dict:
    return {"t": t, "v": PROTOCOL_VERSION, **payload}

def hello(server_ts: float, redaction: bool = True) -> dict:
    return msg("hello", server_ts=server_ts, protocol=PROTOCOL_VERSION, redaction=redaction)

def snapshot(seq: int, server_ts: float, threads: Iterable[Thread],
             sessions: Iterable[Session], recent: Iterable[Activity] = ()) -> dict:
    return msg("snapshot", seq=seq, server_ts=server_ts,
               threads=[t.wire() for t in threads],
               sessions=[s.wire() for s in sessions],
               recent=[a.wire() for a in recent])

def activity_msg(a: Activity) -> dict:
    return msg("activity", activity=a.wire())

def terminal_msg(term: Terminal) -> dict:
    return msg("terminal", terminal=term.wire())

def session_update(seq: int, s: Session) -> dict:
    return msg("session_update", seq=seq, session=s.wire())

def thread_update(seq: int, th: Thread) -> dict:
    return msg("thread_update", seq=seq, thread=th.wire())


# ---------------------------------------------------------------- raw transcript shapes
@dataclass
class RawLine:
    """A parsed transcript JSONL line of interest (assistant tool_use or its result)."""
    ts: float
    session_id: str
    cwd: Optional[str]
    tool: str
    tool_use_id: Optional[str]
    file_path: Optional[str] = None
    inp: dict = field(default_factory=dict)     # full tool input (pre-redaction)
    is_result: bool = False
    result_text: Optional[str] = None
    is_error: bool = False
    agent_id: Optional[str] = None              # set when line came from subagents/agent-<id>.jsonl


# ---------------------------------------------------------------- internal interfaces (Protocols)
class SessionPoller(Protocol):
    """wyc.sessions — reads SESSIONS_DIR/*.json (the live registry)."""
    def poll(self) -> list[Session]: ...
    """Return the current live/recent sessions. status from registry + mtime."""


class TranscriptReader(Protocol):
    """wyc.transcripts — locate + tail transcripts, parse tool_use lines."""
    def transcript_path(self, session_id: str) -> Optional[str]: ...
    def subagent_paths(self, session_id: str) -> list[str]: ...
    def read_new(self, path: str, from_offset: int) -> tuple[list[RawLine], int]:
        """Return (new RawLines since byte offset, new offset). Append-safe."""
        ...
    @staticmethod
    def parse(line_obj: dict, agent_id: Optional[str] = None) -> list[RawLine]:
        """Parse one decoded JSONL object into 0+ RawLines (tool_use/tool_result)."""
        ...


class ThreadStitcher(Protocol):
    """wyc.threads — assign sessions to durable, handoff-spanning threads.

    repo (resolve_project) = container; within it stitch via fuzzy name-stem
    (edit-distance <=2 on a normalized stem) + handoff-doc lineage (session B
    Reads a *HANDOFF*.md that session A Wrote) + time-contiguity. Operator
    merge/split/alias overrides are sticky and WIN over inference. None of the
    three signals is load-bearing alone (typo-robust by construction)."""
    def assign(self, s: Session, recent: list[RawLine]) -> Thread: ...
    def merge(self, thread_a: str, thread_b: str) -> Thread: ...
    def split(self, thread_id: str, session_id: str) -> tuple[Thread, Thread]: ...
    def alias(self, raw_name: str, canonical: str) -> None: ...
    def threads(self) -> list[Thread]: ...


class Watcher(Protocol):
    """wyc.watcher — orchestrates poll + tail + stitch + redact into a single
    monotonic event stream. SERVERHOOK consumes this; it never re-reads disk."""
    async def run(self) -> None: ...
    def snapshot(self) -> dict: ...                  # contract.snapshot(...) envelope
    def subscribe(self) -> "AsyncIterator[dict]": ...  # yields wire envelopes (activity/terminal/updates)
    async def since(self, seq: int) -> list[dict]: ...  # replay buffer for resync; [] -> caller should re-snapshot


class HandoffGenerator(Protocol):
    """wyc.handoff — THE on-theme framework feature: turn a thread's live state
    into a one-line continuation prompt for a fresh session."""
    def one_liner(self, thread_id: str) -> str: ...
    def brief(self, thread_id: str) -> dict: ...     # richer structured handoff


# ---------------------------------------------------------------- redaction (security principle)
# Implemented in wyc.redact (parent), imported by watcher before anything hits the
# wire. Transcripts contain secrets (this box's CLAUDE.md is wall-to-wall creds);
# nothing reaches a browser un-redacted. See constitution principle II.
def redact(text: Optional[str]) -> Optional[str]:  # overridden/extended in wyc.redact
    return text
