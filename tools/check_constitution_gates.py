#!/usr/bin/env python3
"""check_constitution_gates — makes Principle IX literally true.

Every principle in the constitution (and the Governance section) MUST declare a
machine-resolvable enforcer via an inline `[enforcer: <ref>]` tag, and every
declared enforcer MUST resolve. This forbids a principle from claiming a
`*Gate (live):*` that does not exist — the exact failure this project hit
(perf-smoke and spec-coverage were claimed but never built).

`<ref>` grammar (shared with check_ledger.py):
    path            -> <repo>/path exists
    path:needle     -> <repo>/path exists AND contains needle (the wiring check)

Exit 0 only when every required section has ≥1 enforcer tag and ALL tags resolve.
"""
from __future__ import annotations

import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONST = os.path.join(REPO, ".specify", "memory", "constitution.md")
TAG = re.compile(r"\[enforcer:\s*([^\]]+)\]")
# sections that MUST be gated: the Roman-numeral principles + Governance.
PRINCIPLE = re.compile(r"^###\s+([IVXL]+)\.\s+(.+)$")
GOVERNANCE = re.compile(r"^##\s+Governance\b")


def resolve(ref: str) -> tuple[bool, str]:
    ref = ref.strip()
    needle = None
    if ":" in ref:
        left, right = ref.split(":", 1)
        if "/" in left or "." in left:
            ref, needle = left.strip(), right.strip()
    path = os.path.join(REPO, ref)
    if not os.path.exists(path):
        return False, f"missing {ref}"
    if needle:
        body = open(path, encoding="utf-8", errors="replace").read()
        if needle not in body:
            return False, f"{ref} lacks '{needle}'"
    return True, "ok"


def main() -> int:
    if not os.path.isfile(CONST):
        print(f"[check-gates] FAIL: {CONST} not found")
        return 1
    lines = open(CONST, encoding="utf-8").read().splitlines()

    # group lines into sections keyed by header; collect enforcer tags per section
    sections: list[tuple[str, list[str]]] = []
    cur_name, cur_buf = "(preamble)", []
    for ln in lines:
        pm, gm = PRINCIPLE.match(ln), GOVERNANCE.match(ln)
        if pm or gm or ln.startswith("## ") or ln.startswith("### "):
            sections.append((cur_name, cur_buf))
            cur_name, cur_buf = ln.strip(), []
        cur_buf.append(ln)
    sections.append((cur_name, cur_buf))

    required = [(n, b) for n, b in sections
                if PRINCIPLE.match(n) or GOVERNANCE.match(n)]
    if len(required) < 12:  # 11 principles + Governance
        print(f"[check-gates] FAIL: only {len(required)} gated sections found "
              "(expected ≥12: principles I–XI + Governance)")
        return 1

    errs = []
    ok_count = 0
    for name, buf in required:
        refs = TAG.findall("\n".join(buf))
        short = name.lstrip("#").strip()[:48]
        if not refs:
            errs.append(f"{short}: NO [enforcer: …] tag — claims a gate with no enforcer")
            continue
        for ref in refs:
            ok, detail = resolve(ref)
            if ok:
                ok_count += 1
            else:
                errs.append(f"{short}: enforcer {detail}")

    print(f"[check-gates] {len(required)} gated sections, {ok_count} enforcer(s) resolved")
    for e in errs:
        print(f"  BAD  {e}")
    if errs:
        print(f"[check-gates] FAIL: {len(errs)} principle(s) with a missing/unwired enforcer "
              "(Principle IX: no gate may be (planned))")
        return 1
    print("[check-gates] every principle has a live, resolvable enforcer")
    return 0


if __name__ == "__main__":
    sys.exit(main())
