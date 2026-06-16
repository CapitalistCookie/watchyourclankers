"""wyc.transcripts — locate, tail, and parse Claude Code transcripts.

Implements the :class:`contract.TranscriptReader` Protocol.

Layout on this box (verified against real ``~/.claude/projects``)::

    PROJECTS_DIR/<slug>/<sessionId>.jsonl                       # main transcript
    PROJECTS_DIR/<slug>/<sessionId>/subagents/agent-<id>.jsonl  # sub-agent transcripts

where ``<slug>`` is the session's ``cwd`` with every ``/`` replaced by ``-``
(so it keeps the leading ``-``: ``/home/user`` → ``-home-user``). Because the
cwd→slug mapping is not always known from a ``session_id`` alone, locating also
falls back to a glob across ``PROJECTS_DIR/*/<sessionId>.jsonl``.

Tailing is append-safe (seek to a byte offset, only consume *complete* trailing
lines) and rotation-safe (if the file shrank, reset to offset 0).

Parsing turns the two line shapes we care about into :class:`contract.RawLine`:

  * an ``assistant`` line carrying ``tool_use`` blocks → one RawLine per block;
  * a ``user`` line carrying ``tool_result`` blocks → one RawLine per block.

Principle I: READ-ONLY. Nothing here writes to ``~/.claude``.
"""
from __future__ import annotations

import datetime as _dt
import glob
import json
import os
import re
from typing import Optional

from . import contract

# Matches "...HANDOFF..." / "...handoff..." anywhere in a path; used elsewhere
# (threads) but defined alongside the path helpers it complements.
HANDOFF_RE = re.compile(r"(?i)handoff")

_ISO_Z_RE = re.compile(r"Z$")


def cwd_to_slug(cwd: str) -> str:
    """``/home/user/projects/foo`` → ``-home-user-projects-foo`` (Claude's scheme)."""
    return cwd.replace("/", "-")


def parse_ts(value) -> float:
    """Parse an ISO8601 'Z' timestamp (or epoch number) to epoch seconds.

    Robust to the milliseconds + trailing 'Z' that Claude writes
    (``2026-06-04T02:53:40.639Z``). Falls back to ``0.0`` on anything
    unparseable so a malformed timestamp never crashes the tail loop."""
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        # Heuristic: treat >1e12 as ms.
        return float(value) / 1000.0 if value > 1e12 else float(value)
    if not isinstance(value, str):
        return 0.0
    s = value.strip()
    if not s:
        return 0.0
    # Normalise trailing Z → +00:00 for fromisoformat (handles fractional secs).
    iso = _ISO_Z_RE.sub("+00:00", s)
    try:
        dt = _dt.datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_dt.timezone.utc)
        return dt.timestamp()
    except ValueError:
        pass
    # Last-ditch: a bare epoch in a string.
    try:
        v = float(s)
        return v / 1000.0 if v > 1e12 else v
    except ValueError:
        return 0.0


def _flatten_result_content(content) -> str:
    """tool_result ``content`` is either a str or a list of ``{type,text}`` blocks.

    Flatten both to a single string."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                txt = block.get("text")
                if isinstance(txt, str):
                    parts.append(txt)
                elif block.get("type") == "text" and isinstance(block.get("content"), str):
                    parts.append(block["content"])
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    # Unexpected shape -> best-effort string.
    return str(content)


class TranscriptReader:
    """Implements :class:`contract.TranscriptReader`.

    Parameters
    ----------
    projects_dir:
        Override ``contract.PROJECTS_DIR`` (tests).
    """

    def __init__(self, projects_dir: Optional[str] = None) -> None:
        self.projects_dir = projects_dir or contract.PROJECTS_DIR

    # -- (a) locate the main transcript -----------------------------------
    def transcript_path(self, session_id: str) -> Optional[str]:
        """Path to ``<slug>/<sessionId>.jsonl`` for this session, or None.

        We don't always know the cwd→slug from the id alone, so glob across
        every project slug for ``<sessionId>.jsonl``. If several match (a
        session id is a uuid, collisions are effectively impossible, but be
        safe) return the most-recently-modified one."""
        if not session_id:
            return None
        pattern = os.path.join(self.projects_dir, "*", f"{session_id}.jsonl")
        try:
            matches = glob.glob(pattern)
        except OSError:
            return None
        if not matches:
            return None
        if len(matches) == 1:
            return matches[0]
        try:
            return max(matches, key=lambda p: os.path.getmtime(p))
        except OSError:
            return matches[0]

    def _session_dir(self, session_id: str) -> Optional[str]:
        """The ``<slug>/<sessionId>/`` directory (sibling of the transcript)."""
        tp = self.transcript_path(session_id)
        if tp:
            cand = tp[:-len(".jsonl")] if tp.endswith(".jsonl") else None
            if cand and os.path.isdir(cand):
                return cand
        # Fallback: glob for a directory named <sessionId> under any slug.
        if not session_id:
            return None
        pattern = os.path.join(self.projects_dir, "*", session_id)
        try:
            for d in glob.glob(pattern):
                if os.path.isdir(d):
                    return d
        except OSError:
            return None
        return None

    # -- (b) locate sub-agent transcripts ---------------------------------
    def subagent_paths(self, session_id: str) -> list[str]:
        """``subagents/agent-*.jsonl`` belonging to this session's dir.

        Real layout nests these under ``<slug>/<sessionId>/subagents/``; we also
        tolerate ``<slug>/subagents/`` (per the contract note) for robustness."""
        out: list[str] = []
        seen: set[str] = set()

        def _add_glob(base: str) -> None:
            try:
                for p in glob.glob(os.path.join(base, "subagents", "agent-*.jsonl")):
                    rp = os.path.realpath(p)
                    if rp not in seen:
                        seen.add(rp)
                        out.append(p)
            except OSError:
                pass

        sdir = self._session_dir(session_id)
        if sdir:
            _add_glob(sdir)
        # Also the slug dir itself (the cwd-level subagents location).
        tp = self.transcript_path(session_id)
        if tp:
            _add_glob(os.path.dirname(tp))
        return sorted(out)

    # -- (c) tail by byte offset (append + rotation safe) -----------------
    def read_new(self, path: str, from_offset: int) -> tuple[list[contract.RawLine], int]:
        """Read complete lines appended since ``from_offset``.

        Returns ``(raw_lines, new_offset)``. A trailing *partial* line (no
        terminating newline yet) is NOT consumed — the offset stays before it so
        the next call re-reads it once complete. If the file shrank since last
        time (rotation/truncation), the offset is reset to 0 and the whole file
        re-read. Robust to a missing file (returns ``([], from_offset)``).
        """
        agent_id = self._agent_id_for_path(path)
        try:
            size = os.path.getsize(path)
        except OSError:
            return [], from_offset

        start = from_offset
        if from_offset > size:
            # File rotated/truncated -> start over.
            start = 0
        if start == size:
            return [], start

        try:
            with open(path, "rb") as fh:
                fh.seek(start)
                chunk = fh.read()
        except OSError:
            return [], from_offset

        if not chunk:
            return [], start

        # Only consume up to the last newline; keep a trailing partial line.
        last_nl = chunk.rfind(b"\n")
        if last_nl == -1:
            # No complete line yet; don't advance.
            return [], start
        consumed = chunk[:last_nl + 1]
        new_offset = start + len(consumed)

        raw_lines: list[contract.RawLine] = []
        for bline in consumed.split(b"\n"):
            if not bline.strip():
                continue
            try:
                obj = json.loads(bline.decode("utf-8", "replace"))
            except (json.JSONDecodeError, ValueError):
                continue
            if not isinstance(obj, dict):
                continue
            raw_lines.extend(self.parse(obj, agent_id=agent_id))
        return raw_lines, new_offset

    @staticmethod
    def _agent_id_for_path(path: str) -> Optional[str]:
        """Extract ``<id>`` from ``.../subagents/agent-<id>.jsonl`` (else None)."""
        base = os.path.basename(path)
        if base.startswith("agent-") and base.endswith(".jsonl") \
                and os.sep + "subagents" + os.sep in path + os.sep:
            return base[len("agent-"):-len(".jsonl")]
        return None

    # -- (d) parse one decoded JSONL object -------------------------------
    @staticmethod
    def parse(line_obj: dict, agent_id: Optional[str] = None) -> list[contract.RawLine]:
        """Decode one transcript line into 0+ :class:`contract.RawLine`.

        Handles the assistant ``tool_use`` shape and the user ``tool_result``
        shape; ignores everything else (system/mode/attachment/... lines)."""
        if not isinstance(line_obj, dict):
            return []
        ltype = line_obj.get("type")
        msg = line_obj.get("message")
        if not isinstance(msg, dict):
            return []
        content = msg.get("content")
        if not isinstance(content, list):
            return []

        ts = parse_ts(line_obj.get("timestamp"))
        session_id = line_obj.get("sessionId") or ""
        if not isinstance(session_id, str):
            session_id = ""
        cwd = line_obj.get("cwd") if isinstance(line_obj.get("cwd"), str) else None

        out: list[contract.RawLine] = []

        if ltype == "assistant":
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                name = block.get("name") or ""
                if not isinstance(name, str):
                    name = ""
                inp = block.get("input")
                if not isinstance(inp, dict):
                    inp = {}
                file_path = inp.get("file_path")
                if not isinstance(file_path, str):
                    file_path = None
                out.append(contract.RawLine(
                    ts=ts,
                    session_id=session_id,
                    cwd=cwd,
                    tool=name,
                    tool_use_id=block.get("id") if isinstance(block.get("id"), str) else None,
                    file_path=file_path,
                    inp=inp,
                    is_result=False,
                    agent_id=agent_id,
                ))

        elif ltype == "user":
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_result":
                    continue
                tuid = block.get("tool_use_id")
                if not isinstance(tuid, str):
                    tuid = None
                out.append(contract.RawLine(
                    ts=ts,
                    session_id=session_id,
                    cwd=cwd,
                    tool="",  # unknown at the result line; correlated by tool_use_id
                    tool_use_id=tuid,
                    is_result=True,
                    result_text=_flatten_result_content(block.get("content")),
                    is_error=bool(block.get("is_error")),
                    agent_id=agent_id,
                ))

        return out


if __name__ == "__main__":  # pragma: no cover - manual READ-ONLY smoke
    import sys
    from . import sessions as _sessions
    tr = TranscriptReader()
    for s in _sessions.SessionPoller().poll():
        tp = tr.transcript_path(s.id)
        subs = tr.subagent_paths(s.id)
        print(f"{s.id[:8]} name={s.name!r} transcript={tp} subagents={len(subs)}",
              file=sys.stderr)
