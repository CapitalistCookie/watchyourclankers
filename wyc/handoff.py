"""wyc.handoff — THE on-theme framework feature (FR-009 / D7).

Turn a thread's live state into a single dense continuation line a fresh Claude
session can act on immediately, plus a richer structured brief(). This is the
"watch your clankers, then hand the baton cleanly" payoff: an operator who
leapfrogs sessions gets a ready-made resume prompt for the next one.

Design: PURE and unit-testable. one_liner()/brief() accept a *thread-state dict*
(the shape wyc.watcher / wyc.threads can assemble) so they need no live watcher.
A thin HandoffGenerator class binds an optional watcher to fetch that state, but
the formatting logic is free functions over a plain dict.

Everything user-facing is run through wyc.redact (Principle II) — a continuation
line might quote a last bash command or an open file path that embeds a secret;
nothing reaches the operator's clipboard un-redacted.

Expected thread-state dict (all keys optional; we degrade gracefully):
    {
      "thread": {"id","title","project", "stitch":[...]},
      "sessions": [                       # oldest -> newest (the leapfrog chain)
         {"id","name","current_surface","current_file","status"}, ...
      ],
      "open_files": ["a.py","b.py", ...], # distinct files recently touched
      "recent_activities": [              # newest-last is fine; we take the tail
         {"kind","tool","file_path","detail","ts"}, ...
      ],
      "current_spec": "001-infra-contract-feed",   # active spec id, if known
      "docs": ["docs/MASTER_PLAN.md", ...],         # canonical docs to re-read
    }
"""
from __future__ import annotations

from typing import Any, Optional

from . import contract
from .redact import redact

# how many of each list we surface in the one-liner / brief
_MAX_FILES = 4
_MAX_ACTIVITIES = 5


def _r(s: Optional[str]) -> str:
    """Redact + stringify for the wire/clipboard. None -> ''."""
    out = redact(s)
    return out if out else ""


def _surface_phrase(kind: Optional[str], tool: Optional[str]) -> str:
    """Human phrase for a surface kind ('edit' -> 'editing', 'bash' -> 'running')."""
    m = {
        contract.KIND_EDIT: "editing",
        contract.KIND_WRITE: "writing",
        contract.KIND_READ: "reading",
        contract.KIND_BASH: "running",
        contract.KIND_SEARCH: "searching",
        contract.KIND_TASK: "fanning out",
        contract.KIND_TODO: "planning",
        contract.KIND_WEB: "fetching",
    }
    return m.get(kind or "", tool or kind or "working")


def _last_activity(state: dict) -> Optional[dict]:
    acts = state.get("recent_activities") or []
    return acts[-1] if acts else None


def _open_files(state: dict) -> list[str]:
    """Distinct open/recently-touched files, redacted, capped, order-preserved."""
    files: list[str] = []
    explicit = state.get("open_files") or []
    src = list(explicit)
    if not src:
        for a in state.get("recent_activities") or []:
            fp = a.get("file_path")
            if fp:
                src.append(fp)
    for f in src:
        rf = _r(f)
        if rf and rf not in files:
            files.append(rf)
        if len(files) >= _MAX_FILES:
            break
    return files


def _last_cmd(state: dict) -> Optional[str]:
    """The most recent bash command (redacted), if any."""
    for a in reversed(state.get("recent_activities") or []):
        if a.get("kind") == contract.KIND_BASH and a.get("detail"):
            return _r(a.get("detail"))
    return None


def _last_activity_phrase(state: dict) -> str:
    """A '<surface> <file-or-detail>' fragment for the last thing that happened."""
    a = _last_activity(state)
    if not a:
        return "session start"
    verb = _surface_phrase(a.get("kind"), a.get("tool"))
    tgt = _r(a.get("file_path")) or _r(a.get("detail"))
    return f"{verb} {tgt}".strip() if tgt else verb


def one_liner(state: dict) -> str:
    """A single dense continuation line for a fresh Claude session (FR-009).

    Always returns one physical line (newlines collapsed). Degrades gracefully on
    a sparse state. Redacted throughout."""
    thread = state.get("thread") or {}
    title = _r(thread.get("title")) or _r(thread.get("id")) or "untitled thread"
    project = _r(thread.get("project"))
    sessions = state.get("sessions") or []
    n = len(sessions)

    parts: list[str] = []
    head = f"Resume thread {title}"
    if project:
        head += f" ({project})"
    parts.append(head)

    # last session in the chain + what it was doing
    if sessions:
        last = sessions[-1]
        sname = _r(last.get("name")) or _r(last.get("id")) or "last session"
        verb = _surface_phrase(last.get("current_surface"), None)
        cf = _r(last.get("current_file"))
        if cf:
            parts.append(f"last session {sname} was {verb} {cf}")
        else:
            parts.append(f"last session {sname} was {verb}")

    if n:
        parts.append(f"{n} session{'s' if n != 1 else ''} in chain")

    files = _open_files(state)
    if files:
        parts.append("open files: " + ", ".join(files))

    cmd = _last_cmd(state)
    if cmd:
        parts.append(f"last cmd: {cmd}")

    # canonical reads: docs + active spec
    reads: list[str] = []
    for d in (state.get("docs") or ["docs/MASTER_PLAN.md"]):
        rd = _r(d)
        if rd and rd not in reads:
            reads.append(rd)
    spec = _r(state.get("current_spec"))
    if spec:
        reads.append(f"specs/{spec}")
    if reads:
        parts.append("read " + " + ".join(reads))

    parts.append(f"Continue from {_last_activity_phrase(state)}.")

    line = "; ".join(p for p in parts if p)
    # guarantee a single physical line
    return " ".join(line.split("\n")).strip()


def brief(state: dict) -> dict:
    """A richer structured handoff (FR-009): the chain, open files, recent
    activities, current spec — all redacted. Pairs with one_liner for a fresh
    session that wants more than a sentence."""
    thread = state.get("thread") or {}
    sessions = state.get("sessions") or []
    chain = []
    for s in sessions:
        chain.append({
            "id": _r(s.get("id")),
            "name": _r(s.get("name")),
            "status": s.get("status"),
            "surface": s.get("current_surface"),
            "file": _r(s.get("current_file")),
        })

    recent = []
    for a in (state.get("recent_activities") or [])[-_MAX_ACTIVITIES:]:
        recent.append({
            "kind": a.get("kind"),
            "tool": a.get("tool"),
            "file": _r(a.get("file_path")),
            "detail": _r(a.get("detail")),
            "ts": a.get("ts"),
        })

    return {
        "thread_id": _r(thread.get("id")),
        "title": _r(thread.get("title")) or _r(thread.get("id")),
        "project": _r(thread.get("project")),
        "stitch": thread.get("stitch") or [],
        "chain": chain,
        "chain_len": len(chain),
        "open_files": _open_files(state),
        "last_cmd": _last_cmd(state),
        "recent_activities": recent,
        "current_spec": _r(state.get("current_spec")),
        "docs": [_r(d) for d in (state.get("docs") or ["docs/MASTER_PLAN.md"]) if _r(d)],
        "one_liner": one_liner(state),
    }


class HandoffGenerator:
    """contract.HandoffGenerator — binds an (optional) watcher to fetch thread
    state, then delegates to the pure formatters above.

    The watcher, when present, is expected to expose a way to get a thread-state
    dict for a given thread_id; we probe a couple of method names so this stays
    decoupled from the parallel watcher.py. When no watcher / no state is
    available, we return a clear, still-actionable placeholder rather than raise
    (callers like the CLI prefer a message over a stack trace)."""

    def __init__(self, watcher: Any = None,
                 state_provider: Optional[Any] = None) -> None:
        self._watcher = watcher
        # state_provider(thread_id) -> dict, for tests / alternate sources.
        self._state_provider = state_provider

    def _state(self, thread_id: str) -> Optional[dict]:
        if self._state_provider is not None:
            return self._state_provider(thread_id)
        w = self._watcher
        if w is not None:
            for name in ("thread_state", "handoff_state", "state_for_thread"):
                fn = getattr(w, name, None)
                if callable(fn):
                    try:
                        return fn(thread_id)
                    except Exception:
                        return None
        return None

    def one_liner(self, thread_id: str) -> str:
        state = self._state(thread_id)
        if not state:
            return (f"No live state for thread {thread_id} "
                    "(daemon not running or unknown thread).")
        return one_liner(state)

    def brief(self, thread_id: str) -> dict:
        state = self._state(thread_id)
        if not state:
            return {"thread_id": thread_id, "error": "no state",
                    "one_liner": self.one_liner(thread_id)}
        return brief(state)
