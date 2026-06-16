#!/usr/bin/env python3
"""stamp_handoff — regenerate docs/HANDOFF.md's currency markers in ONE command.

The friction this kills (R16): every time the handoff was touched you had to
hand-edit the `<!-- HANDOFF-HEAD: <sha> -->` tag (and the prose was easy to forget
entirely). Hand-editing a sha is exactly the kind of manual step that rots. This
tool rewrites every machine-checkable currency marker to current ground truth, so
"refresh the handoff" is `python3 tools/stamp_handoff.py` — never a manual sha.

Markers it stamps (the same ones tools/check_handoff_fresh.py gates):
    <!-- HANDOFF-HEAD: <sha> -->      -> current HEAD short sha
    main@<sha>  (prose resume ptr)    -> current HEAD short sha
    constitution.md (vX.Y.Z)          -> the real constitution version

Usage:
    python3 tools/stamp_handoff.py            # rewrite markers in the working tree
    python3 tools/stamp_handoff.py --check    # exit 1 if a rewrite WOULD change it
                                              # (dry run; prints what is stale)
    python3 tools/stamp_handoff.py --commit   # rewrite + git add + docs-only commit
                                              # (lands a clean docs commit; the tag
                                              #  then cites HEAD~1, fresh by the
                                              #  "no code changed since" rule)

Idempotent: running it on an already-current handoff changes nothing and exits 0.
No third-party deps. The freshness GATE remains the enforcer; this is the fixer.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HANDOFF = os.path.join(REPO, "docs", "HANDOFF.md")
CONSTITUTION = os.path.join(REPO, ".specify", "memory", "constitution.md")

TAG = re.compile(r"(<!--\s*HANDOFF-HEAD:\s*)([0-9a-f]{7,40})(\s*-->)", re.I)
PROSE_SHA = re.compile(r"\bmain@([0-9a-f]{7,40})\b", re.I)
PROSE_CONST_VER = re.compile(r"(constitution\.md[^\n]{0,30}?\(v?)(\d+\.\d+\.\d+)(\))", re.I)
CONST_VERSION = re.compile(r"^\*\*Version\*\*:\s*(\d+\.\d+\.\d+)", re.M)


def _git(*args: str) -> str | None:
    try:
        out = subprocess.run(["git", "-C", REPO, *args],
                             capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def _real_constitution_version() -> str | None:
    try:
        body = open(CONSTITUTION, encoding="utf-8").read()
    except OSError:
        return None
    m = CONST_VERSION.search(body)
    return m.group(1) if m else None


def _same_sha(a: str, b: str) -> bool:
    """Two short shas name the same commit if one is a prefix of the other."""
    n = min(len(a), len(b))
    return n >= 7 and a[:n].lower() == b[:n].lower()


def stamp(body: str, head: str, version: str | None) -> tuple[str, list[str]]:
    """Return (new_body, changes). `changes` is a human-readable list of what was
    rewritten (empty == already current). Idempotent: a marker that already names
    HEAD / the real version is left byte-for-byte unchanged."""
    changes: list[str] = []

    def tag_sub(m: re.Match) -> str:
        old = m.group(2)
        if _same_sha(old, head):
            return m.group(0)  # already current — leave as-is (idempotent)
        changes.append(f"HANDOFF-HEAD tag {old} -> {head}")
        return f"{m.group(1)}{head}{m.group(3)}"

    new = TAG.sub(tag_sub, body, count=1)

    def sha_sub(m: re.Match) -> str:
        old = m.group(1)
        if _same_sha(old, head):
            return m.group(0)
        changes.append(f"prose main@{old} -> main@{head}")
        return f"main@{head}"

    new = PROSE_SHA.sub(sha_sub, new)

    if version is not None:
        def ver_sub(m: re.Match) -> str:
            old = m.group(2)
            if old != version:
                changes.append(f"prose constitution v{old} -> v{version}")
            return f"{m.group(1)}{version}{m.group(3)}"
        new = PROSE_CONST_VER.sub(ver_sub, new)

    # de-dup changes (a sha may appear more than once) while preserving order
    seen, uniq = set(), []
    for c in changes:
        if c not in seen:
            seen.add(c)
            uniq.append(c)
    return new, uniq


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="regenerate docs/HANDOFF.md currency markers")
    ap.add_argument("--check", action="store_true",
                    help="dry run: exit 1 if a rewrite would change the file")
    ap.add_argument("--commit", action="store_true",
                    help="rewrite, then git add + docs-only commit")
    args = ap.parse_args(argv)

    if not os.path.isfile(HANDOFF):
        print("[stamp-handoff] FAIL: docs/HANDOFF.md missing", file=sys.stderr)
        return 1
    head = _git("rev-parse", "--short", "HEAD")
    if head is None:
        print("[stamp-handoff] FAIL: not a git repo / git unavailable", file=sys.stderr)
        return 1

    body = open(HANDOFF, encoding="utf-8").read()
    version = _real_constitution_version()
    new, changes = stamp(body, head, version)

    if not changes:
        print(f"[stamp-handoff] already current (HEAD {head}, constitution v{version}) — nothing to do")
        return 0

    if args.check:
        print("[stamp-handoff] STALE — would rewrite:")
        for c in changes:
            print(f"  - {c}")
        return 1

    with open(HANDOFF, "w", encoding="utf-8") as fh:
        fh.write(new)
    print(f"[stamp-handoff] stamped docs/HANDOFF.md to HEAD {head}, constitution v{version}:")
    for c in changes:
        print(f"  - {c}")

    if args.commit:
        if _git("add", "docs/HANDOFF.md") is None:
            print("[stamp-handoff] FAIL: git add failed", file=sys.stderr)
            return 1
        msg = f"docs(handoff): stamp currency markers to HEAD {head}"
        if _git("commit", "-m", msg) is None:
            print("[stamp-handoff] FAIL: git commit failed (nothing staged?)", file=sys.stderr)
            return 1
        print(f"[stamp-handoff] committed: {msg}")
    else:
        print("[stamp-handoff] (working tree updated — `git add docs/HANDOFF.md && git commit` "
              "as a docs-only commit; or re-run with --commit)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
