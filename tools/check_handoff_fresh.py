#!/usr/bin/env python3
"""check_handoff_fresh — the handoff doc can never silently rot again.

The exact failure this project hit: docs/HANDOFF.md froze at an ancestor commit
and a fresh session booted from a stale picture. The fix is a gate: HANDOFF.md
must carry a machine tag naming the commit it describes, and that commit must be
the CURRENT HEAD. Any commit that moves HEAD without refreshing the handoff fails
the gate.

Required tag in docs/HANDOFF.md:
    <!-- HANDOFF-HEAD: <short-sha> -->
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HANDOFF = os.path.join(REPO, "docs", "HANDOFF.md")
TAG = re.compile(r"<!--\s*HANDOFF-HEAD:\s*([0-9a-f]{7,40})\s*-->", re.I)


def _git(*args: str) -> str | None:
    try:
        out = subprocess.run(["git", "-C", REPO, *args],
                             capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def head_sha() -> str | None:
    return _git("rev-parse", "--short", "HEAD")


def _eq(a: str, b: str) -> bool:
    n = min(len(a), len(b))
    return n >= 7 and a[:n] == b[:n]


def _docs_only_final_commit(cited: str) -> bool:
    """True if `cited` is HEAD's parent AND the HEAD commit changes only docs/ —
    i.e. the legitimate 'final handoff/ledger commit describing the prior state'.
    Resolves the paradox that a commit cannot embed its own sha, WITHOUT loosening
    the guarantee for code commits (any code commit must refresh the handoff)."""
    parent = _git("rev-parse", "--short", "HEAD~1")
    if not parent or not _eq(cited, parent):
        return False
    changed = _git("diff", "--name-only", "HEAD~1", "HEAD")
    if changed is None:
        return False
    files = [f for f in changed.splitlines() if f.strip()]
    return bool(files) and all(f.startswith("docs/") for f in files)


def main() -> int:
    if not os.path.isfile(HANDOFF):
        print("[check-handoff] FAIL: docs/HANDOFF.md missing")
        return 1
    body = open(HANDOFF, encoding="utf-8").read()
    m = TAG.search(body)
    if not m:
        print("[check-handoff] FAIL: no `<!-- HANDOFF-HEAD: <sha> -->` tag in docs/HANDOFF.md "
              "(handoff currency is unverifiable)")
        return 1
    cited = m.group(1)
    head = head_sha()
    if head is None:
        print("[check-handoff] WARN: not a git repo / git unavailable — skipping freshness check")
        return 0
    if _eq(cited, head):
        print(f"[check-handoff] handoff current (cites HEAD {head})")
        return 0
    if _docs_only_final_commit(cited):
        print(f"[check-handoff] handoff current (cites HEAD~1 {cited}; HEAD {head} is a docs-only commit)")
        return 0
    print(f"[check-handoff] FAIL: HANDOFF.md cites {cited} but HEAD is {head} "
          "— the handoff is stale (regenerate it)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
