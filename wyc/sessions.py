"""wyc.sessions — read the live session registry (SessionPoller Protocol).

Reads ``contract.SESSIONS_DIR/*.json`` — the per-PID live registry Claude Code
maintains. Each file looks like::

    {"pid": 733973, "sessionId": "91f0...", "cwd": "/home/user",
     "name": "comms4" | null, "status": "busy" | "idle",
     "startedAt": <ms>, "updatedAt": <ms>, "version": "...", "model": "...?"}

We build :class:`contract.Session` objects from these, deriving a robust
``status`` from the registry value + freshness + liveness:

  * registry ``status`` if present AND fresh (``updatedAt`` within ~10s) → use it
    verbatim (``busy``/``idle``);
  * older-than-fresh but the process/transcript still looks alive → ``idle``;
  * process clearly gone AND no recent transcript activity → ``ended``.

Milliseconds are converted to epoch seconds. Project is resolved through
:mod:`wyc.threads` (which wraps clanker's ``resolve_project``). Malformed or
partially-written JSON files are skipped, never fatal — this is a live registry
being written by other processes concurrently.

Principle I: READ-ONLY. Nothing here writes to ``~/.claude``.
"""
from __future__ import annotations

import glob
import json
import os
import time
from typing import Optional

from . import contract

# Freshness window: a registry whose updatedAt is within this many seconds is
# treated as authoritative for busy/idle. Poll cadence is ~1.5s, so ~10s gives
# a few missed beats of slack before we downgrade to idle.
FRESH_SECS = 10.0
# How long after last activity (updatedAt) with a dead process before a session
# is considered ended (vs merely idle). Generous so history lingers a bit.
ENDED_GRACE_SECS = 60.0


def _ms_to_epoch(v) -> Optional[float]:
    """Convert a millisecond epoch (int/float/str) to epoch seconds. None-safe."""
    if v is None:
        return None
    try:
        return float(v) / 1000.0
    except (TypeError, ValueError):
        return None


def _pid_alive(pid: Optional[int]) -> Optional[bool]:
    """True/False if we can tell whether the process exists; None if unknown.

    Uses ``os.kill(pid, 0)`` (signal 0 = liveness probe, sends nothing — does
    NOT interfere with the process, so Principle I holds)."""
    if not pid:
        return None
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # Exists but owned by another user — still alive.
        return True
    except (OverflowError, ValueError, TypeError):
        return None


def _read_registry_file(path: str) -> Optional[dict]:
    """Load one registry JSON file; return None on any malformed/partial read."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except OSError:
        return None
    raw = raw.strip()
    if not raw:
        return None
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        # Mid-write partial file; skip this beat, it'll be valid next poll.
        return None
    if not isinstance(obj, dict):
        return None
    return obj


class SessionPoller:
    """Implements :class:`contract.SessionPoller`.

    Stateless across calls except for an injectable resolver/transcript-locator.
    Construct once and call :meth:`poll` on the watcher's loop cadence.

    Parameters
    ----------
    sessions_dir:
        Override ``contract.SESSIONS_DIR`` (tests).
    resolve_project:
        ``cwd -> project`` callable. Defaults to :func:`wyc.threads.resolve_project`
        (clanker-backed, git-aware). Injectable for tests.
    transcript_mtime:
        Optional ``session_id -> Optional[float]`` callable returning the epoch
        mtime of a session's transcript. Used as a secondary liveness/activity
        signal so a busy session whose registry beat we missed still reads as
        active. Defaults to a lookup via :class:`wyc.transcripts.TranscriptReader`.
    """

    def __init__(self, sessions_dir: Optional[str] = None,
                 resolve_project=None, transcript_mtime=None) -> None:
        self.sessions_dir = sessions_dir or contract.SESSIONS_DIR
        if resolve_project is None:
            from . import threads as _threads
            resolve_project = _threads.resolve_project
        self._resolve_project = resolve_project
        if transcript_mtime is None:
            transcript_mtime = self._default_transcript_mtime
        self._transcript_mtime = transcript_mtime
        self._tr = None  # lazily-built TranscriptReader for the default mtime

    # -- liveness helpers --------------------------------------------------
    def _default_transcript_mtime(self, session_id: str) -> Optional[float]:
        if self._tr is None:
            try:
                from . import transcripts as _transcripts
                self._tr = _transcripts.TranscriptReader()
            except Exception:
                return None
        try:
            path = self._tr.transcript_path(session_id)
            if path and os.path.exists(path):
                return os.path.getmtime(path)
        except OSError:
            return None
        return None

    def _derive_status(self, reg_status: Optional[str], updated_at: Optional[float],
                       pid: Optional[int], session_id: str, now: float) -> str:
        """Derive busy|idle|ended from registry value + freshness + liveness."""
        alive = _pid_alive(pid)
        # Most-recent activity we can observe: registry updatedAt or transcript mtime.
        tmtime = None
        try:
            tmtime = self._transcript_mtime(session_id)
        except Exception:
            tmtime = None
        last_activity = max([t for t in (updated_at, tmtime) if t is not None],
                            default=None)

        # Process clearly gone -> ended (unless it just died and we still have
        # very recent activity, in which case let it linger as idle one beat).
        if alive is False:
            if last_activity is not None and (now - last_activity) <= ENDED_GRACE_SECS:
                return "idle"  # just died; linger one beat before ended
            return "ended"

        # Process alive (or unknown). Fresh registry status wins verbatim.
        if reg_status in ("busy", "idle") and updated_at is not None \
                and (now - updated_at) <= FRESH_SECS:
            return reg_status

        # Alive but stale registry: if transcript moved very recently, it's busy.
        if tmtime is not None and (now - tmtime) <= FRESH_SECS:
            return "busy"

        # Alive, nothing fresh -> idle.
        return "idle"

    # -- the Protocol method ----------------------------------------------
    def poll(self) -> list[contract.Session]:
        """Return current live/recent sessions built from the registry."""
        now = time.time()
        out: list[contract.Session] = []
        try:
            paths = sorted(glob.glob(os.path.join(self.sessions_dir, "*.json")))
        except OSError:
            return out

        for path in paths:
            obj = _read_registry_file(path)
            if obj is None:
                continue
            session_id = obj.get("sessionId")
            if not session_id or not isinstance(session_id, str):
                # No session id we can key on -> useless for the wire; skip.
                continue

            pid = obj.get("pid")
            try:
                pid = int(pid) if pid is not None else None
            except (TypeError, ValueError):
                pid = None

            cwd = obj.get("cwd") if isinstance(obj.get("cwd"), str) else None
            name = obj.get("name") if isinstance(obj.get("name"), str) else None
            model = obj.get("model") if isinstance(obj.get("model"), str) else None
            started_at = _ms_to_epoch(obj.get("startedAt"))
            updated_at = _ms_to_epoch(obj.get("updatedAt"))
            reg_status = obj.get("status") if isinstance(obj.get("status"), str) else None

            status = self._derive_status(reg_status, updated_at, pid, session_id, now)

            project = None
            try:
                project = self._resolve_project(cwd) if cwd else None
            except Exception:
                project = None

            out.append(contract.Session(
                id=session_id,
                thread_id="",            # assigned by the ThreadStitcher in the watcher
                status=status,
                pid=pid,
                name=name,
                cwd=cwd,
                project=project,
                model=model,
                started_at=started_at,
                updated_at=updated_at,
            ))
        return out


if __name__ == "__main__":  # pragma: no cover - manual READ-ONLY smoke
    import sys
    poller = SessionPoller()
    sessions = poller.poll()
    print(f"[sessions] {len(sessions)} session(s) in {poller.sessions_dir}",
          file=sys.stderr)
    for s in sessions:
        print(f"  {s.status:6s} pid={s.pid} name={s.name!r} "
              f"project={s.project!r} cwd={s.cwd} id={s.id[:8]}")
