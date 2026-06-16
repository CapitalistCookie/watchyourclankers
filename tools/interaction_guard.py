#!/usr/bin/env python3
"""interaction_guard — audit #4: the PROCESS-forcing layer.

The gates block a bad interaction change at PUSH; nothing forced the discipline
when a fix STARTS — so handed a concrete bug I kept defaulting to grep-and-edit
(the operator caught this repeatedly). This runs as a PreToolUse hook: when an
Edit/Write targets a watchyourclankers INTERACTION file, it injects the discipline
reminder into context BEFORE the edit, so ad-hoc fixes can't begin unannounced.

It is also unit-testable: `is_interaction_file()` is pure; `build_context()`
returns the reminder. The hook entry point reads the tool payload on stdin and
emits PreToolUse additionalContext (non-blocking — a reminder, not a deny).
"""
from __future__ import annotations

import json
import sys

# Frontend modules that wire pointer/drag/render interaction (the protected concept).
INTERACTION_SUFFIXES = (
    "watchyourclankers/web/ide.js",
    "watchyourclankers/web/mosaic.js",
    "watchyourclankers/web/resize.js",
    "watchyourclankers/web/debug.js",
)

REMINDER = (
    "[interaction-guard] You are editing watchyourclankers INTERACTION code. Follow the "
    "harness, do NOT hand-edit straight to a fix (LESSONS L1/L5/L7 + MODULE_BUILD_CHECKLIST): "
    "(1) EXTRACT the decision into a PURE module and `node --test` it RED-FIRST; "
    "(2) `ci/interaction.mjs` (a REAL pointer-drag DOM probe) must stay green — a pure-math "
    "test does NOT count; (3) H9-ENUMERATE every site of the concept before claiming done; "
    "(4) wire change ⇒ bump the contract. Reveal/terminal cadence is a POLICY → pure + tested."
)


def is_interaction_file(file_path: str | None) -> bool:
    """Pure: True iff file_path points at a wyc interaction module."""
    if not file_path:
        return False
    fp = str(file_path).replace("\\", "/")
    return any(fp.endswith(s) for s in INTERACTION_SUFFIXES)


def build_context(file_path: str) -> dict:
    """The PreToolUse hook output that injects the reminder (non-blocking)."""
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": REMINDER + f"  (target: {file_path})",
        }
    }


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0  # never break a tool call on a bad/empty payload
    fp = (data.get("tool_input") or {}).get("file_path")
    if is_interaction_file(fp):
        print(json.dumps(build_context(fp)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
