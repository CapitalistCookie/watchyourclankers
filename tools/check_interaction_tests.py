#!/usr/bin/env python3
"""check_interaction_tests — the rung that makes "interaction code requires a real
DOM-interaction test" MECHANICAL, not convention.

The bypass this closes (audit 2026-06-16): an interaction bug (the terminal drag)
shipped "fixed" on a pure-MATH node --test (web/idegeom.test.mjs). The behavioral
rung (j) only runs pure-logic unit tests; nothing drove the actual DOM / pointer
events, so a broken drag passed every gate. LESSONS L1 at the DOM layer.

This gate asserts: if any INTERACTION source file exists, then a real DOM probe
(ci/interaction.mjs) must (a) exist, (b) actually EXERCISE the interaction (drive
pointer events + read the live layout — not just import math), and (c) be wired
into the run gate (ci/full.sh). So you cannot change ide.js / mosaic.js /
resize.js / debug.js and reach green without a test that drags the real DOM.

Pure-Python, fast → runs in the pre-push fast gate (blocks the push), while
ci/full.sh actually RUNS the probe (catches a regression).
"""
from __future__ import annotations

import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Frontend modules that wire pointer/drag interaction (the "protected concept").
INTERACTION_FILES = ["web/ide.js", "web/mosaic.js", "web/resize.js", "web/debug.js"]
DOM_PROBE = "ci/interaction.mjs"
# Tokens that prove the probe drives the REAL DOM, not just pure logic. It must
# drive a pointer (mouse.down), target the actual gutter, and read the live layout.
PROBE_MUST_EXERCISE = [".down(", ".ide-gutter-row", "gridTemplateRows"]
RUN_GATE = "ci/full.sh"  # must invoke the probe so it actually runs


def _read(rel: str) -> str | None:
    p = os.path.join(REPO, rel)
    if not os.path.isfile(p):
        return None
    return open(p, encoding="utf-8", errors="replace").read()


def main() -> int:
    present = [f for f in INTERACTION_FILES if os.path.isfile(os.path.join(REPO, f))]
    if not present:
        print("[check-interaction] no interaction source files — nothing to gate")
        return 0

    errs = []
    probe = _read(DOM_PROBE)
    if probe is None:
        errs.append(f"{DOM_PROBE} is MISSING — interaction files {present} have no DOM-interaction test")
    else:
        missing = [t for t in PROBE_MUST_EXERCISE if t not in probe]
        if missing:
            errs.append(f"{DOM_PROBE} exists but does not EXERCISE the DOM (missing {missing}) — "
                        "a probe that doesn't drive pointer events + read the live layout proves nothing")

    run = _read(RUN_GATE)
    if run is None or DOM_PROBE not in run:
        errs.append(f"{DOM_PROBE} is not wired into {RUN_GATE} — the DOM test never RUNS")

    print(f"[check-interaction] {len(present)} interaction file(s) guarded by {DOM_PROBE}")
    for e in errs:
        print(f"  BAD  {e}")
    if errs:
        print("[check-interaction] FAIL: interaction code without a live DOM-interaction test "
              "(audit fix; pure-math tests do not count — LESSONS L7)")
        return 1
    print(f"[check-interaction] interaction code is gated by a real DOM probe wired into {RUN_GATE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
