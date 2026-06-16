#!/usr/bin/env python3
"""check_ledger — the completeness forcing-function (Principle IX, applied to the
remediation itself).

Parses the machine-readable ledger in docs/REMEDIATION.md (between the
LEDGER:BEGIN/END sentinels) and FAILS while any row is OPEN, so `ci/fast.sh`
cannot go green until every remediation item is done. For every CLOSED row it
also asserts the named enforcer actually exists + is wired — a row cannot be
marked closed without its live enforcer.

Enforcer column grammar:
    path                 -> <repo>/path must exist
    path:needle          -> <repo>/path must exist AND contain the substring needle
                            (the wiring check, e.g. `ci/fast.sh:node --test`)

Exit 0 only when EVERY row is CLOSED and every enforcer resolves.
Exit 1 (with a clear report) otherwise. No deps; stdlib only.
"""
from __future__ import annotations

import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER = os.path.join(REPO, "docs", "REMEDIATION.md")
ROW = re.compile(r"^\|\s*(R\d+)\s*\|(.+?)\|(.+?)\|\s*(OPEN|CLOSED)\s*\|\s*$", re.I)


def _resolve(enforcer: str) -> tuple[bool, str]:
    """(ok, detail) for an enforcer reference."""
    enforcer = enforcer.strip()
    needle = None
    # split on the FIRST ':' only if the left side looks like a path (has a '/'
    # or ends in a known ext) — avoids mangling enforcers without a needle.
    if ":" in enforcer:
        left, right = enforcer.split(":", 1)
        if "/" in left or "." in left:
            enforcer, needle = left.strip(), right.strip()
    path = os.path.join(REPO, enforcer)
    if not os.path.exists(path):
        return False, f"missing file {enforcer}"
    if needle:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                body = fh.read()
        except OSError as e:
            return False, f"unreadable {enforcer}: {e}"
        if needle not in body:
            return False, f"{enforcer} does not reference '{needle}'"
    return True, "ok"


def main() -> int:
    try:
        with open(LEDGER, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as e:
        print(f"[check-ledger] FAIL: cannot read {LEDGER}: {e}")
        return 1

    m = re.search(r"LEDGER:BEGIN(.*?)LEDGER:END", text, re.S)
    if not m:
        print("[check-ledger] FAIL: ledger sentinels not found in docs/REMEDIATION.md")
        return 1

    rows = []
    for line in m.group(1).splitlines():
        r = ROW.match(line.strip())
        if r:
            rows.append((r.group(1), r.group(2).strip(), r.group(3).strip(), r.group(4).upper()))

    if not rows:
        print("[check-ledger] FAIL: no ledger rows parsed (format drift?)")
        return 1

    open_rows = [r for r in rows if r[3] == "OPEN"]
    closed = [r for r in rows if r[3] == "CLOSED"]

    # every CLOSED row must have a live enforcer
    broken = []
    for rid, item, enforcer, _ in closed:
        ok, detail = _resolve(enforcer)
        if not ok:
            broken.append((rid, detail))

    print(f"[check-ledger] {len(closed)}/{len(rows)} CLOSED, {len(open_rows)} OPEN")
    for rid, item, enforcer, _ in open_rows:
        print(f"  OPEN  {rid}  {item[:64]:64}  -> {enforcer}")
    for rid, detail in broken:
        print(f"  BROKEN {rid}: marked CLOSED but enforcer {detail}")

    if broken:
        print(f"[check-ledger] FAIL: {len(broken)} CLOSED row(s) with a missing/unwired enforcer")
        return 1
    if open_rows:
        print(f"[check-ledger] NOT DONE: {len(open_rows)} item(s) still OPEN "
              "(this gate stays RED until the remediation is complete)")
        return 1
    print(f"[check-ledger] ALL {len(rows)} ITEMS CLOSED + ENFORCED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
