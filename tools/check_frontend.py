#!/usr/bin/env python3
"""tools/check_frontend.py — FRONTEND COVERAGE checker (fail-closed, pure stdlib).

Standalone runner for the frontend half of the contract: it asserts that the
browser actually handles every server->client message type the schema defines, so
a new event type cannot be added to contracts/events.schema.json without the
frontend wiring being updated in the same change.

Asserts:
  * web/client.js route() has a `case '<t>':` for EVERY server->client type
    (hello, snapshot, activity, terminal, screen, session_update, thread_update).
  * web/store.js defines an apply* path for every DATA-BEARING type (snapshot,
    activity, terminal, screen, session_update, thread_update).

This is the same logic that tools/check_contract.py runs inline (so CI invokes a
single command); kept here as a focused, separately-runnable check.

Exit 0 + `[check-frontend] COVERAGE OK` on success; non-zero listing every
unhandled type otherwise. Run: python3 tools/check_frontend.py
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)  # reuse the parsers in check_contract (same dir)

from check_contract import (  # noqa: E402  (intentional sibling import)
    CLIENT_JS,
    DATA_BEARING,
    SERVER_TO_CLIENT,
    STORE_JS,
    check_frontend,
    read_text,
)


def main() -> int:
    client_src = read_text(CLIENT_JS)
    store_src = read_text(STORE_JS)
    errs = check_frontend(client_src, store_src)
    if errs:
        print("[check-frontend] COVERAGE FAIL", file=sys.stderr)
        for ln in errs:
            print(f"  - {ln}", file=sys.stderr)
        return 1
    print(
        f"[check-frontend] route() handles all {len(SERVER_TO_CLIENT)} "
        f"server->client types; store applies all {len(DATA_BEARING)} "
        "data-bearing types."
    )
    print("[check-frontend] COVERAGE OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
