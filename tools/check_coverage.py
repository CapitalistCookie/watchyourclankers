#!/usr/bin/env python3
"""check_coverage — Principle VIII's promised spec-coverage check, finally built.

No orphan code: every backend module (wyc/*.py) and frontend module (web/*.js)
must be referenced by NAME in at least one governing artifact — a spec
(specs/**/*.md), the master plan, the constitution, or the honest UX-iteration
log (docs/UX_LOG.md). A file that nothing governs fails the gate, which is how
the UI-arc code gets folded into the foundational documentation instead of
floating ungoverned.

Excludes: tests (*.test.mjs), vendored deps (web/vendor/**), __pycache__,
and dunder entrypoints are still required (they are real surface).
"""
from __future__ import annotations

import glob
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sources() -> list[str]:
    out = []
    for p in glob.glob(os.path.join(REPO, "wyc", "*.py")):
        out.append(os.path.relpath(p, REPO))
    for p in glob.glob(os.path.join(REPO, "web", "*.js")):
        out.append(os.path.relpath(p, REPO))
    # frontend ES test files end in .test.mjs (not *.js) so they're already excluded
    return sorted(out)


def governing_text() -> str:
    chunks = []
    patterns = [
        os.path.join(REPO, "specs", "**", "*.md"),
        os.path.join(REPO, "docs", "*.md"),
        os.path.join(REPO, ".specify", "memory", "*.md"),
        os.path.join(REPO, "CLAUDE.md"),
    ]
    for pat in patterns:
        for p in glob.glob(pat, recursive=True):
            try:
                chunks.append(open(p, encoding="utf-8", errors="replace").read())
            except OSError:
                pass
    return "\n".join(chunks)


def main() -> int:
    gov = governing_text()
    orphans = []
    srcs = sources()
    for rel in srcs:
        base = os.path.basename(rel)
        # a reference is the basename OR the repo-relative path appearing verbatim
        if base in gov or rel in gov:
            continue
        orphans.append(rel)

    print(f"[check-coverage] {len(srcs) - len(orphans)}/{len(srcs)} source files governed")
    for o in orphans:
        print(f"  ORPHAN  {o}  (add to a spec or docs/UX_LOG.md)")
    if orphans:
        print(f"[check-coverage] FAIL: {len(orphans)} orphan source file(s) "
              "— no spec / UX_LOG / master-plan reference (Principle VIII)")
        return 1
    print("[check-coverage] every source file is governed by a spec/UX_LOG/master-plan")
    return 0


if __name__ == "__main__":
    sys.exit(main())
