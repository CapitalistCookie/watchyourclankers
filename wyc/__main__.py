"""wyc CLI — `python3 -m wyc ...`. SERVERHOOK layer.

Subcommands:
  serve [--host H --port P]   run the watcher daemon + web UI (loopback).
  handoff <thread_id>         print a fresh-session continuation one-liner for a
                              thread (FR-009). In slice 1 this reads the daemon's
                              last-published snapshot under DATA_DIR; if the
                              daemon isn't running it prints a clear message.

Run with `python3 -u -m wyc ...` for unbuffered output on long runs.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Optional

from . import contract


# ── handoff: build a thread-state dict from the daemon's last snapshot ────────
def _snapshot_path() -> str:
    """Where the running daemon publishes its latest snapshot for out-of-process
    consumers like this CLI. Under DATA_DIR (our own store)."""
    return os.path.join(contract.DATA_DIR, "last_snapshot.json")


def _load_last_snapshot() -> Optional[dict]:
    try:
        with open(_snapshot_path(), "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _thread_state_from_snapshot(snap: dict, thread_id: str) -> Optional[dict]:
    """Assemble the handoff thread-state dict (see wyc.handoff) from a snapshot
    envelope. Returns None if the thread isn't present."""
    threads = snap.get("threads") or []
    thread = None
    for t in threads:
        if t.get("id") == thread_id or t.get("title") == thread_id:
            thread = t
            break
    if thread is None:
        return None

    sess_by_id = {s.get("id"): s for s in (snap.get("sessions") or [])}
    # order sessions per the thread's chain (oldest -> newest)
    sessions = [sess_by_id[sid] for sid in (thread.get("session_ids") or [])
                if sid in sess_by_id]
    if not sessions:  # fall back to any session claiming this thread
        sessions = [s for s in (snap.get("sessions") or [])
                    if s.get("thread_id") == thread.get("id")]

    sess_ids = {s.get("id") for s in sessions}
    recent = [a for a in (snap.get("recent") or [])
              if a.get("thread_id") == thread.get("id") or a.get("session_id") in sess_ids]

    return {
        "thread": thread,
        "sessions": sessions,
        "recent_activities": recent,
        "current_spec": None,
        "docs": ["docs/MASTER_PLAN.md"],
    }


def cmd_handoff(args: argparse.Namespace) -> int:
    from . import handoff as handoff_mod

    snap = _load_last_snapshot()
    if snap is None:
        print(f"wyc: no snapshot at {_snapshot_path()} — daemon not running? "
              f"start it with `python3 -u -m wyc serve`.", file=sys.stderr)
        return 1

    state = _thread_state_from_snapshot(snap, args.thread_id)
    if state is None:
        # list what threads ARE available to help the operator
        avail = ", ".join(
            f"{t.get('id')}({t.get('title')})" for t in (snap.get("threads") or [])
        ) or "(none)"
        print(f"wyc: thread '{args.thread_id}' not found. Available: {avail}",
              file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(handoff_mod.brief(state), indent=2, default=str))
    else:
        print(handoff_mod.one_liner(state))
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    from . import server  # lazy: server.serve imports watcher lazily too
    try:
        asyncio.run(server.serve(host=args.host, port=args.port))
    except KeyboardInterrupt:
        print("\n[wyc] stopped.", flush=True)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="wyc",
        description="watchyourclankers — read-only IDE-spectator for Claude Code.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("serve", help="run the watcher daemon + web UI (loopback)")
    sp.add_argument("--host", default=None,
                    help=f"bind host (default {contract.DEFAULT_HOST}; "
                         "env WYC_HOST). NEVER default 0.0.0.0.")
    sp.add_argument("--port", type=int, default=None,
                    help=f"bind port (default {contract.DEFAULT_PORT}; env WYC_PORT)")
    sp.set_defaults(func=cmd_serve)

    hp = sub.add_parser("handoff",
                        help="print a fresh-session continuation one-liner for a thread")
    hp.add_argument("thread_id", help="thread id (or title) to resume")
    hp.add_argument("--json", action="store_true",
                    help="print the richer structured brief() as JSON")
    hp.set_defaults(func=cmd_handoff)

    return p


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
