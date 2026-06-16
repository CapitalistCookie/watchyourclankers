#!/usr/bin/env python3
"""check_handoff_fresh — the handoff doc can never silently rot again.

The exact failure this project hit: docs/HANDOFF.md froze at an ancestor commit
and a fresh session booted from a stale picture. The fix is a gate: HANDOFF.md
must carry a machine tag naming the commit it describes, that commit must be
current, AND the human-readable currency markers in the prose must match ground
truth.

Required tag in docs/HANDOFF.md:
    <!-- HANDOFF-HEAD: <short-sha> -->

What "current" means (R14 — the finickiness fix):
    A commit cannot embed its own sha, and a session legitimately stacks several
    docs-only commits (handoff/ledger refreshes) on top of the last code commit.
    So freshness is NOT "cited == HEAD" — it is **"no CODE has changed since the
    cited commit"**: the cited sha is HEAD, or every file changed in cited..HEAD
    lives under docs/. This kills the false-block that forced SKIP_CI on a
    legitimate docs-only handoff update, while still failing the instant any code
    commit lands without the handoff being refreshed.

Prose currency (R15 — gate the prose, not just the sha):
    The sha tag staying fresh did not stop the PROSE drifting (it claimed an old
    constitution version while the repo was many commits ahead). So we also gate
    the canonical, machine-checkable currency markers embedded in the prose:
      * `constitution.md (vX.Y.Z)`  -> X.Y.Z must equal the real constitution
        version (`.specify/memory/constitution.md` `**Version**: …`).
      * `main@<sha>`                 -> every resume-pointer sha must be fresh by
        the same rule as the tag.
    Scoping is deliberately tight so HISTORICAL mentions ("constitution
    1.0.0→1.1.0", "it said v1.1.0") are NOT flagged (a gate that false-fails is as
    bad as one that false-passes — AP-8). Only the parenthesised-after-`.md`
    version marker and `main@<sha>` pointers are gated.

Regenerate all markers with ONE command (never hand-edit): tools/stamp_handoff.py
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HANDOFF = os.path.join(REPO, "docs", "HANDOFF.md")
CONSTITUTION = os.path.join(REPO, ".specify", "memory", "constitution.md")

TAG = re.compile(r"<!--\s*HANDOFF-HEAD:\s*([0-9a-f]{7,40})\s*-->", re.I)
# `main@<sha>` resume pointers in the prose (e.g. "… `main@5b2162c` …").
PROSE_SHA = re.compile(r"\bmain@([0-9a-f]{7,40})\b", re.I)
# The canonical constitution-version marker: a `constitution.md` reference closely
# followed by a parenthesised version. Requires BOTH the `.md` and the parens so a
# bare/historical "constitution 1.0.0→1.1.0" cannot match (AP-8: no false-fails).
PROSE_CONST_VER = re.compile(r"constitution\.md[^\n]{0,30}?\(v?(\d+\.\d+\.\d+)\)", re.I)
CONST_VERSION = re.compile(r"^\*\*Version\*\*:\s*(\d+\.\d+\.\d+)", re.M)

STAMP_HINT = "regenerate with: python3 tools/stamp_handoff.py  (then commit docs/HANDOFF.md)"


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


def _only_docs_since(cited: str) -> bool:
    """True iff `cited` is a (strict) ancestor of HEAD AND every file changed in
    cited..HEAD lives under docs/ — i.e. no CODE has changed since the cited
    commit, so the handoff describing it is NOT stale. This generalises the old
    HEAD~1-only allowance to a *chain* of docs-only commits (the false-block fix,
    R14) without loosening the guarantee for code: any non-docs change since
    `cited` makes it stale."""
    # --is-ancestor signals via EXIT CODE: _git returns "" on success (exit 0),
    # None on a non-zero exit (not an ancestor / bad sha).
    if _git("merge-base", "--is-ancestor", cited, "HEAD") is None:
        return False
    changed = _git("diff", "--name-only", cited, "HEAD")
    if changed is None:
        return False
    files = [f for f in changed.splitlines() if f.strip()]
    # bool(files): an empty diff means cited == HEAD, handled by the caller's
    # _eq() fast-path; here we require ≥1 changed file, all under docs/.
    return bool(files) and all(f.startswith("docs/") for f in files)


def _is_fresh(sha: str, head: str) -> bool:
    """A cited sha is fresh if it IS HEAD, or only docs/ changed since it."""
    return _eq(sha, head) or _only_docs_since(sha)


def _real_constitution_version() -> str | None:
    try:
        body = open(CONSTITUTION, encoding="utf-8").read()
    except OSError:
        return None
    m = CONST_VERSION.search(body)
    return m.group(1) if m else None


def _check_prose_currency(body: str, head: str) -> list[str]:
    """Gate the machine-checkable currency markers embedded in the PROSE (R15).
    Returns a list of human-readable error strings (empty == all current)."""
    errs: list[str] = []

    # (1) constitution-version marker must match the real constitution version.
    real = _real_constitution_version()
    for m in PROSE_CONST_VER.finditer(body):
        claimed = m.group(1)
        if real is None:
            errs.append("handoff cites a constitution version but "
                        f"{os.path.relpath(CONSTITUTION, REPO)} has no `**Version**:` line")
        elif claimed != real:
            errs.append(f"handoff prose says constitution v{claimed} but the "
                        f"constitution is v{real} (stale prose) — {STAMP_HINT}")

    # (2) every `main@<sha>` resume-pointer must be fresh.
    for m in PROSE_SHA.finditer(body):
        sha = m.group(1)
        if not _is_fresh(sha, head):
            errs.append(f"handoff prose resume-pointer `main@{sha}` is stale "
                        f"(HEAD is {head}, and code changed since {sha}) — {STAMP_HINT}")
    return errs


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

    errs: list[str] = []

    # --- the HANDOFF-HEAD tag ---------------------------------------------------
    if _eq(cited, head):
        tag_note = f"tag cites HEAD {head}"
    elif _only_docs_since(cited):
        tag_note = f"tag cites {cited}; HEAD {head} is docs-only on top (no code changed since)"
    else:
        errs.append(f"HANDOFF-HEAD tag cites {cited} but HEAD is {head} and code has "
                    f"changed since — the handoff is stale — {STAMP_HINT}")
        tag_note = None

    # --- prose currency (constitution version + resume-pointer shas) -----------
    errs += _check_prose_currency(body, head)

    if errs:
        for e in errs:
            print(f"[check-handoff] FAIL: {e}")
        return 1

    print(f"[check-handoff] handoff current ({tag_note}; prose currency markers verified)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
