"""wyc.threads — stitch sessions into durable, handoff-spanning threads.

Implements the :class:`contract.ThreadStitcher` Protocol (Principle V / FR-006).

The **repo** (clanker ``resolve_project(cwd)``) is the container. Within a repo,
sessions are stitched into a :class:`contract.Thread` by combining three signals,
*none of which is load-bearing alone* (so the result is typo-robust):

  1. **fuzzy name-stem** — normalise a session name (lowercase; strip trailing
     version tokens like ``v3`` / ``-4`` / ``_final``; collapse separators) and
     cluster names whose stems are within Levenshtein edit-distance ≤2
     (``comms3`` and ``coms4`` → stem ``comms`` / ``coms`` → distance 1 → same);
  2. **handoff-doc lineage** — if session A *wrote/edited* a path matching
     ``(?i)handoff`` and session B *read* the SAME path, link A→B. This is the
     AUTHORITATIVE stitch: it ignores names entirely, so it works through typos
     and renames;
  3. **time-contiguity** — same repo, B starts within ~30 min of A's last
     observed activity.

Operator **overrides** (merge / split) and **aliases** are persisted as JSON
under ``contract.DATA_DIR`` and are *sticky* — they win over inference across
restarts.

``thread_id`` is a stable hash of ``(project, stem)`` unless an override pins a
session to a specific thread id.

Principle I: writes go ONLY to ``DATA_DIR`` (our own store), never to
``~/.claude`` or any observed repo.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from typing import Optional

from . import contract

# ---------------------------------------------------------------- resolve_project
# Reuse clanker's git-aware resolver so a session maps to the SAME project name
# regardless of who derived it (the dashboard, the hook, or us). Fall back to a
# basename-with-worktree-suffix-collapse if clanker can't be imported.
_CLANKER_LIB_DIR = os.path.dirname(contract.CLANKER_PROJECTS_PY)
_resolve_impl = None
_resolve_source = "fallback-basename"


def _load_clanker_resolver():
    global _resolve_impl, _resolve_source
    if _resolve_impl is not None:
        return _resolve_impl
    try:
        import sys
        if _CLANKER_LIB_DIR not in sys.path:
            sys.path.insert(0, _CLANKER_LIB_DIR)
        import projects as _clanker_projects  # type: ignore
        if hasattr(_clanker_projects, "resolve_project"):
            _resolve_impl = _clanker_projects.resolve_project
            _resolve_source = "clanker.lib.projects.resolve_project"
            return _resolve_impl
    except Exception:
        pass
    _resolve_impl = _fallback_resolve_project
    _resolve_source = "fallback-basename"
    return _resolve_impl


_WORKTREE_SUFFIX_RE = re.compile(r"-[0-9a-f]{4,}$|-(?:wip|worktree|wt|trial|smoke|repo)\d*$",
                                 re.IGNORECASE)


def _fallback_resolve_project(cwd: Optional[str]) -> str:
    """basename(realpath(cwd)), collapsing a trailing ``-<suffix>`` worktree tag."""
    if not cwd:
        return "global"
    try:
        base = os.path.basename(os.path.realpath(os.path.expanduser(cwd)))
    except OSError:
        base = os.path.basename(cwd.rstrip("/")) or "global"
    collapsed = _WORKTREE_SUFFIX_RE.sub("", base)
    return collapsed or base or "global"


def resolve_project(cwd: Optional[str]) -> str:
    """Canonical project name for a cwd (clanker-backed, fallback-safe)."""
    fn = _load_clanker_resolver()
    try:
        return fn(cwd) if cwd else "global"
    except Exception:
        return _fallback_resolve_project(cwd)


def resolve_project_source() -> str:
    """Which resolver is live (for diagnostics / the demo)."""
    _load_clanker_resolver()
    return _resolve_source


# ---------------------------------------------------------------- Levenshtein
def levenshtein(a: str, b: str) -> int:
    """Classic edit distance (insert/delete/substitute), iterative two-row DP."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            ins = cur[j - 1] + 1
            dele = prev[j] + 1
            sub = prev[j - 1] + (0 if ca == cb else 1)
            cur.append(min(ins, dele, sub))
        prev = cur
    return prev[-1]


# ---------------------------------------------------------------- name normalisation
# Trailing version tokens to strip from a session name to get its stem.
_VERSION_TOKEN_RE = re.compile(
    r"(?:[\s._\-]*(?:v\d+|version\d*|final|fix|wip|draft|copy|new|\d+))+$",
    re.IGNORECASE,
)
_SEP_RE = re.compile(r"[\s._\-]+")


def name_stem(name: Optional[str]) -> str:
    """Normalise a session name to a comparable stem.

    lowercase → collapse separators to single ``-`` → repeatedly strip trailing
    version/qualifier tokens (``v3``, ``-4``, ``_final``, ``2``…) → strip stray
    separators. ``comms4`` → ``comms``; ``coms4`` → ``coms``; ``Comms-v3-final``
    → ``comms``."""
    if not name:
        return ""
    s = name.strip().lower()
    s = _SEP_RE.sub("-", s)
    # Strip trailing version tokens, possibly several (e.g. "-v3-final").
    prev = None
    while prev != s:
        prev = s
        s = _VERSION_TOKEN_RE.sub("", s)
        s = s.strip("-._ ")
    return s


def _stable_thread_id(project: str, stem: str) -> str:
    h = hashlib.sha1(f"{project}\x00{stem}".encode("utf-8")).hexdigest()[:16]
    return f"th_{h}"


# ---------------------------------------------------------------- the stitcher
class ThreadStitcher:
    """Implements :class:`contract.ThreadStitcher`.

    Maintains in-memory thread state plus sticky operator overrides/aliases on
    disk under ``DATA_DIR``. Call :meth:`assign` for each polled session with
    that session's recent :class:`contract.RawLine`\\ s; it returns the
    session's :class:`contract.Thread`, having (re)stitched as needed.

    Parameters
    ----------
    data_dir:
        Override ``contract.DATA_DIR`` (tests).
    name_distance:
        Max Levenshtein distance between two stems to cluster (default 2).
    time_window:
        Seconds for the time-contiguity signal (default 1800 = 30 min).
    """

    def __init__(self, data_dir: Optional[str] = None,
                 name_distance: int = 2, time_window: float = 1800.0) -> None:
        self.data_dir = data_dir or contract.DATA_DIR
        self.name_distance = name_distance
        self.time_window = time_window

        # session_id -> per-session facts we accumulate across polls
        self._sess: dict[str, dict] = {}
        # thread_id -> Thread
        self._threads: dict[str, contract.Thread] = {}
        # session_id -> thread_id (current assignment)
        self._assign_map: dict[str, str] = {}
        # handoff doc path -> {"writers": set(sid), "readers": set(sid)}
        self._handoff: dict[str, dict] = {}

        # Sticky operator state (loaded from disk; survives restart).
        # overrides: session_id -> forced thread_id (merge/split/pin)
        # aliases:   raw_name(stem) -> canonical stem
        self._overrides: dict[str, str] = {}
        self._aliases: dict[str, str] = {}
        self._load_state()

    # -- persistence (DATA_DIR only) --------------------------------------
    @property
    def _overrides_path(self) -> str:
        return os.path.join(self.data_dir, "overrides.json")

    @property
    def _aliases_path(self) -> str:
        return os.path.join(self.data_dir, "aliases.json")

    def _load_state(self) -> None:
        self._overrides = self._read_json(self._overrides_path) or {}
        self._aliases = self._read_json(self._aliases_path) or {}

    @staticmethod
    def _read_json(path: str) -> Optional[dict]:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                obj = json.load(fh)
            return obj if isinstance(obj, dict) else None
        except (OSError, json.JSONDecodeError, ValueError):
            return None

    def _write_json(self, path: str, obj: dict) -> None:
        """Atomic-ish write to our own DATA_DIR. Never touches observed artifacts."""
        try:
            os.makedirs(self.data_dir, exist_ok=True)
            tmp = f"{path}.tmp.{os.getpid()}"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(obj, fh, indent=2, sort_keys=True)
            os.replace(tmp, path)
        except OSError:
            pass  # persistence is best-effort; never crash the watcher

    def _persist_overrides(self) -> None:
        self._write_json(self._overrides_path, self._overrides)

    def _persist_aliases(self) -> None:
        self._write_json(self._aliases_path, self._aliases)

    # -- ingest signals from a session's raw lines ------------------------
    def _ingest_lines(self, session_id: str, lines: list[contract.RawLine]) -> None:
        rec = self._sess.setdefault(session_id, {
            "project": None, "name": None, "stem": "",
            "first_ts": None, "last_ts": None,
        })
        for ln in lines:
            ts = ln.ts or 0.0
            if ts:
                if rec["first_ts"] is None or ts < rec["first_ts"]:
                    rec["first_ts"] = ts
                if rec["last_ts"] is None or ts > rec["last_ts"]:
                    rec["last_ts"] = ts
            # Handoff-doc lineage: bucket writers and readers per handoff path.
            fp = ln.file_path
            if fp and re.search(r"(?i)handoff", fp):
                bucket = self._handoff.setdefault(os.path.realpath(fp),
                                                  {"writers": set(), "readers": set()})
                kind = contract.kind_for_tool(ln.tool)
                if not ln.is_result and kind in (contract.KIND_WRITE, contract.KIND_EDIT):
                    bucket["writers"].add(session_id)
                elif not ln.is_result and kind == contract.KIND_READ:
                    bucket["readers"].add(session_id)
            # Project inference from the files Claude actually TOUCHES. Interactive
            # sessions launch from ~, so resolve_project(cwd) is "global" for all of
            # them; the edited/read file paths are the reliable "which repo" signal
            # (edits weighted over reads, so the repo you're CHANGING wins).
            if fp and not ln.is_result and os.path.isabs(fp):
                pk = contract.kind_for_tool(ln.tool)
                w = 3 if pk in (contract.KIND_EDIT, contract.KIND_WRITE) else (
                    1 if pk == contract.KIND_READ else 0)
                if w:
                    proj = resolve_project(os.path.dirname(fp))
                    if proj and proj != "global":
                        votes = rec.setdefault("proj_votes", {})
                        votes[proj] = votes.get(proj, 0) + w

    def _effective_project(self, rec: dict, s: contract.Session) -> str:
        """The project a session is REALLY working in — from edited files, not
        cwd. Falls back to the cwd resolver only before any project file is
        touched."""
        votes = rec.get("proj_votes") or {}
        best, best_n = None, 0
        for proj, n in votes.items():
            if proj and proj != "global" and n > best_n:
                best, best_n = proj, n
        if best:
            return best
        return s.project if (s.project and s.project != "global") else resolve_project(s.cwd)

    def _canon_stem(self, stem: str) -> str:
        """Apply a sticky alias to a stem (operator alias wins)."""
        seen = 0
        while stem in self._aliases and seen < 5:
            stem = self._aliases[stem]
            seen += 1
        return stem

    # -- the Protocol: assign --------------------------------------------
    def assign(self, s: contract.Session, recent: list[contract.RawLine]) -> contract.Thread:
        """(Re)stitch ``s`` and return its thread. Idempotent per poll."""
        self._ingest_lines(s.id, recent or [])
        rec = self._sess.setdefault(s.id, {})
        project = self._effective_project(rec, s)
        rec["project"] = project
        s.project = project  # reflect the file-derived project on the session/snapshot
        rec["name"] = s.name
        rec["stem"] = self._canon_stem(name_stem(s.name)) if s.name else ""
        if rec.get("first_ts") is None:
            rec["first_ts"] = s.started_at
        if rec.get("last_ts") is None:
            rec["last_ts"] = s.updated_at or s.started_at

        thread_id = self._resolve_thread_for(s.id, project, rec)
        th = self._ensure_thread(thread_id, project, rec)
        self._attach(s.id, thread_id)
        self._reorder_and_lead(thread_id)
        return self._threads[thread_id]

    # -- stitching core ---------------------------------------------------
    def _resolve_thread_for(self, session_id: str, project: str, rec: dict) -> str:
        # 1) Sticky operator override wins, unconditionally.
        if session_id in self._overrides:
            return self._overrides[session_id]

        evidence: list[str] = []
        candidate: Optional[str] = None

        # 2) Handoff-doc lineage (AUTHORITATIVE, typo-immune): if this session is
        #    a writer or reader of a handoff doc shared with another session that
        #    already has a thread, join it.
        partner = self._handoff_partner(session_id)
        if partner is not None:
            tid = self._assign_map.get(partner)
            if tid is not None:
                candidate = tid
                evidence.append("handoff-doc")

        # 3) Fuzzy name-stem within the SAME project.
        stem = rec.get("stem") or ""
        if candidate is None and stem:
            tid = self._best_stem_thread(project, stem)
            if tid is not None:
                candidate = tid
                evidence.append("name-stem")

        # 4) Time-contiguity within the SAME project.
        if candidate is None:
            tid = self._time_contiguous_thread(session_id, project, rec)
            if tid is not None:
                candidate = tid
                evidence.append("time")

        if candidate is not None:
            self._merge_evidence(candidate, evidence)
            return candidate

        # No stitch -> own thread, id stable on (project, stem) so the same work
        # re-coalesces to the same id across restarts.
        new_id = _stable_thread_id(project, stem or session_id)
        return new_id

    def _handoff_partner(self, session_id: str) -> Optional[str]:
        """Find a session linked to ``session_id`` via a shared handoff doc.

        A→B link: A wrote a handoff doc that B read (or vice-versa). Returns the
        OTHER session id (any one), preferring an already-threaded partner."""
        best = None
        for bucket in self._handoff.values():
            writers, readers = bucket["writers"], bucket["readers"]
            if session_id in readers:
                for w in writers:
                    if w != session_id:
                        if self._assign_map.get(w):
                            return w
                        best = best or w
            if session_id in writers:
                for r in readers:
                    if r != session_id:
                        if self._assign_map.get(r):
                            return r
                        best = best or r
        return best

    def _best_stem_thread(self, project: str, stem: str) -> Optional[str]:
        """Thread in the same project whose stem is within edit-distance."""
        best_tid = None
        best_dist = self.name_distance + 1
        for other_sid, rec in self._sess.items():
            if rec.get("project") != project:
                continue
            other_stem = rec.get("stem") or ""
            if not other_stem:
                continue
            tid = self._assign_map.get(other_sid)
            if tid is None:
                continue
            d = levenshtein(stem, other_stem)
            if d <= self.name_distance and d < best_dist:
                best_dist = d
                best_tid = tid
        return best_tid

    def _time_contiguous_thread(self, session_id: str, project: str,
                                rec: dict) -> Optional[str]:
        """Thread in the same project whose latest activity is within the window
        of this session's start."""
        my_start = rec.get("first_ts") or rec.get("last_ts")
        if my_start is None:
            return None
        best_tid = None
        best_gap = self.time_window + 1.0
        for other_sid, orec in self._sess.items():
            if other_sid == session_id or orec.get("project") != project:
                continue
            tid = self._assign_map.get(other_sid)
            if tid is None:
                continue
            other_last = orec.get("last_ts")
            if other_last is None:
                continue
            gap = abs(my_start - other_last)
            if gap <= self.time_window and gap < best_gap:
                best_gap = gap
                best_tid = tid
        return best_tid

    # -- thread bookkeeping ----------------------------------------------
    def _ensure_thread(self, thread_id: str, project: str, rec: dict) -> contract.Thread:
        th = self._threads.get(thread_id)
        if th is None:
            title = rec.get("stem") or rec.get("name") or project or "thread"
            th = contract.Thread(
                id=thread_id, title=title, project=project,
                session_ids=[], created_at=rec.get("first_ts") or time.time(),
                updated_at=rec.get("last_ts") or time.time(), stitch=[],
            )
            self._threads[thread_id] = th
        else:
            if not th.project:
                th.project = project
        return th

    def _attach(self, session_id: str, thread_id: str) -> None:
        prev = self._assign_map.get(session_id)
        if prev == thread_id:
            return
        if prev and prev in self._threads:
            old = self._threads[prev]
            if session_id in old.session_ids:
                old.session_ids.remove(session_id)
        self._assign_map[session_id] = thread_id
        th = self._threads[thread_id]
        if session_id not in th.session_ids:
            th.session_ids.append(session_id)

    def _merge_evidence(self, thread_id: str, evidence: list[str]) -> None:
        th = self._threads.get(thread_id)
        if th is None:
            return
        for e in evidence:
            if e not in th.stitch:
                th.stitch.append(e)

    def _reorder_and_lead(self, thread_id: str) -> None:
        """Order session_ids oldest→newest by first activity; lead = newest active."""
        th = self._threads.get(thread_id)
        if th is None:
            return

        def _first_ts(sid: str) -> float:
            r = self._sess.get(sid) or {}
            return r.get("first_ts") or r.get("last_ts") or 0.0

        th.session_ids.sort(key=_first_ts)
        if th.session_ids:
            th.created_at = _first_ts(th.session_ids[0]) or th.created_at
            # lead = most-recently-active session in the chain.
            def _last_ts(sid: str) -> float:
                r = self._sess.get(sid) or {}
                return r.get("last_ts") or r.get("first_ts") or 0.0
            lead = max(th.session_ids, key=_last_ts)
            th.lead_session_id = lead
            th.updated_at = _last_ts(lead) or th.updated_at

    # -- the Protocol: operator overrides (sticky, win over inference) -----
    def merge(self, thread_a: str, thread_b: str) -> contract.Thread:
        """Merge thread_b into thread_a; pin every member session (sticky)."""
        a = self._threads.get(thread_a)
        b = self._threads.get(thread_b)
        if a is None and b is None:
            # Nothing known yet; still record the intent as an alias-by-id.
            return self._ensure_thread(thread_a, "global", {})
        if a is None:
            a, thread_a, b, thread_b = b, thread_b, a, thread_a  # swap; keep an existing target
        if b is not None:
            for sid in list(b.session_ids):
                self._attach(sid, thread_a)
                self._overrides[sid] = thread_a
            for e in b.stitch:
                if e not in a.stitch:
                    a.stitch.append(e)
            del self._threads[thread_b]
        if "manual" not in a.stitch:
            a.stitch.append("manual")
        # Pin a's own members too, so the merge is sticky.
        for sid in a.session_ids:
            self._overrides[sid] = thread_a
        self._persist_overrides()
        self._reorder_and_lead(thread_a)
        return a

    def split(self, thread_id: str, session_id: str) -> tuple[contract.Thread, contract.Thread]:
        """Split ``session_id`` out of ``thread_id`` into its own pinned thread."""
        src = self._threads.get(thread_id)
        rec = self._sess.get(session_id) or {}
        project = rec.get("project") or (src.project if src else "global")
        new_id = _stable_thread_id(project, f"split:{session_id}")
        new_th = self._ensure_thread(new_id, project, rec)
        self._attach(session_id, new_id)
        self._overrides[session_id] = new_id
        if "manual" not in new_th.stitch:
            new_th.stitch.append("manual")
        self._persist_overrides()
        self._reorder_and_lead(thread_id)
        self._reorder_and_lead(new_id)
        # src may have been emptied; return the (possibly-empty) source + new.
        src_th = self._threads.get(thread_id) or self._ensure_thread(thread_id, project, rec)
        return src_th, new_th

    def alias(self, raw_name: str, canonical: str) -> None:
        """Persist a sticky name-stem alias (raw_name's stem → canonical's stem)."""
        rstem = name_stem(raw_name) or (raw_name or "").strip().lower()
        cstem = name_stem(canonical) or (canonical or "").strip().lower()
        if not rstem or not cstem or rstem == cstem:
            return
        self._aliases[rstem] = cstem
        self._persist_aliases()

    def threads(self) -> list[contract.Thread]:
        """All known threads, newest-updated first."""
        return sorted(self._threads.values(),
                      key=lambda t: (t.updated_at or 0.0), reverse=True)

    def thread_for_session(self, session_id: str) -> Optional[contract.Thread]:
        tid = self._assign_map.get(session_id)
        return self._threads.get(tid) if tid else None


if __name__ == "__main__":  # pragma: no cover - manual READ-ONLY smoke
    import sys
    from . import sessions as _sessions
    print(f"[threads] resolver = {resolve_project_source()}", file=sys.stderr)
    st = ThreadStitcher()
    for s in _sessions.SessionPoller().poll():
        th = st.assign(s, [])
        print(f"  {s.name!r:24s} -> thread {th.id} (title={th.title!r} "
              f"project={th.project!r} stitch={th.stitch})")
