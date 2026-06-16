#!/usr/bin/env python3
"""watchyourclankers PostToolUse hook (FR-008) — ENRICHMENT ONLY.

Claude Code runs this after a tool call, piping a JSON object on stdin like:
    {"tool_name": "...", "tool_input": {"file_path": "...", ...},
     "session_id": "...", "cwd": "...", "transcript_path": "..."}

We POST a COMPACT subset to the running wyc daemon at
http://127.0.0.1:8900/hook?token=<token-from-DATA_DIR/.wyc_token> with a short
timeout. This is supplemental signal: the daemon's transcript-tail is canonical,
so if the daemon is down / slow / unreachable we degrade silently. The hook MUST
NOT block Claude and MUST exit 0 fast no matter what.

Hard rules:
  * stdlib only (urllib) — the hook runs in Claude's environment, not wyc's venv.
  * never raise, never write to ~/.claude or any observed repo (Principle I) —
    we only READ the token from DATA_DIR and make one outbound HTTP request.
  * a tiny timeout; swallow every exception; always exit 0.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

# Kept in sync with wyc.contract (DEFAULT_HOST/PORT, DATA_DIR). Duplicated as
# literals because the hook may run from a cwd where `wyc` isn't importable; the
# env vars below let the daemon's launcher override without code edits.
_HOST = os.environ.get("WYC_HOST", "127.0.0.1")
_PORT = os.environ.get("WYC_PORT", "8900")
_DATA_DIR = os.environ.get("WYC_DATA_DIR", "/data/clanker/watchyourclankers")
_TIMEOUT = 0.4  # seconds — never block Claude


def _read_token() -> str:
    try:
        with open(os.path.join(_DATA_DIR, ".wyc_token"), "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def _compact(payload: dict) -> dict:
    """Pull just the enrichment-useful fields out of the PostToolUse payload."""
    ti = payload.get("tool_input") or {}
    return {
        "src": "post-tool-use",
        "tool_name": payload.get("tool_name"),
        "session_id": payload.get("session_id"),
        "cwd": payload.get("cwd"),
        "transcript_path": payload.get("transcript_path"),
        # a few common tool_input fields; the daemon redacts before any wire use
        "file_path": ti.get("file_path"),
        "command": ti.get("command"),
        "pattern": ti.get("pattern"),
    }


def main() -> int:
    # Read stdin defensively; an empty / non-JSON stdin must not matter.
    try:
        raw = sys.stdin.read()
    except Exception:
        return 0
    if not raw.strip():
        return 0
    try:
        payload = json.loads(raw)
    except (ValueError, TypeError):
        return 0
    if not isinstance(payload, dict):
        return 0

    token = _read_token()
    if not token:
        # No daemon token on disk -> daemon not configured/running. Degrade.
        return 0

    body = json.dumps(_compact(payload)).encode("utf-8")
    url = f"http://{_HOST}:{_PORT}/hook?token={token}"
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT):
            pass
    except (urllib.error.URLError, OSError, ValueError, Exception):
        # daemon down / slow / refused — enrichment is best-effort. Never fail.
        return 0
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Absolute backstop: the hook must never fail Claude.
        sys.exit(0)
