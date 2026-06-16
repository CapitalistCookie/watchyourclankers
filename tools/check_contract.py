#!/usr/bin/env python3
"""tools/check_contract.py — CONTRACT PARITY checker (fail-closed, pure stdlib).

The wire is defined twice on purpose: declaratively in contracts/events.schema.json
(the SSOT mirrored to the browser) and as Python dataclasses + helpers in
wyc/contract.py (what the daemon actually emits). They MUST stay in lockstep, and
the frontend (web/client.js + web/store.js) MUST handle every server->client type.
This checker asserts all of that and FAILS THE GATE on any drift, printing exactly
what diverged (entity / field / type) so the parent can decide.

Asserts:
  (a) every $defs wire entity (Activity, Terminal, Screen, Session, Thread) has a
      matching @dataclass in wyc/contract.py whose FIELD NAMES == the schema's
      `properties` (drift in either direction is reported; a tiny documented
      allowlist covers intentional internal-only fields).
  (b) every server->client message type in the schema's oneOf is PRODUCED by a
      contract.py helper (a literal msg("<t>") call), and every client->server
      type is DOCUMENTED in contract.py / client.js.
  (c) PROTOCOL_VERSION in contract.py == the schema's `v` const, and EVERY oneOf
      entry pins that same version (no split-brain "v").
  (d) the schema parses and EVERY oneOf entry has additionalProperties:false (the
      contract stays tight — no silently-accepted extra fields on the wire).

  FRONTEND COVERAGE (see also tools/check_frontend.py for the same checks runnable
  standalone): web/client.js route() handles every server->client `t`, and
  web/store.js has an apply path for the data-bearing ones.

Exit 0 + `[check-contract] PARITY OK` on success; non-zero with a precise drift
report otherwise. Run: python3 tools/check_contract.py
"""
from __future__ import annotations

import ast
import dataclasses
import json
import os
import re
import sys

# --------------------------------------------------------------------------- paths
HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
SCHEMA_PATH = os.path.join(REPO_ROOT, "contracts", "events.schema.json")
CONTRACT_PY = os.path.join(REPO_ROOT, "wyc", "contract.py")
CLIENT_JS = os.path.join(REPO_ROOT, "web", "client.js")
STORE_JS = os.path.join(REPO_ROOT, "web", "store.js")

sys.path.insert(0, REPO_ROOT)  # so `import wyc.contract` resolves to THIS repo

# --------------------------------------------------------------------------- spec
# The $defs wire entities that must each map 1:1 to a @dataclass in contract.py.
WIRE_ENTITIES = ["Activity", "Terminal", "Screen", "Session", "Thread"]

# Server->client message types: the daemon EMITS these; a contract.py helper must
# produce each (a literal msg("<t>") call) AND the frontend must handle each.
SERVER_TO_CLIENT = [
    "hello", "snapshot", "activity", "terminal", "screen",
    "session_update", "thread_update",
]
# Client->server message types: the browser SENDS these; they must be documented
# in the contract (and client.js exposes a send helper for them).
CLIENT_TO_SERVER = [
    "subscribe", "resync", "annotate", "thread_override",
    "watch_screen", "unwatch_screen",
]

# Data-bearing server->client types: store.js must have an apply path for each.
# hello carries no entity payload the store rings; it is handled by client+store
# (applyHello) but is not part of the entity-bearing set asserted against store.
DATA_BEARING = [
    "snapshot", "activity", "terminal", "screen",
    "session_update", "thread_update",
]

# Intentional internal-only dataclass fields that legitimately have NO schema
# property (kept off the wire on purpose). Keep this allowlist tiny + documented;
# every entry is a deliberate decision, not a place to hide drift.
#   key = entity name, value = {field: reason}
FIELD_ALLOWLIST: dict[str, dict[str, str]] = {
    # (none today — Session.tmux_* ARE on the wire. The `transient tmux_key`
    #  example from the brief would live here, e.g.:
    #    "Session": {"tmux_key": "transient capture-pane handle, server-internal"},
    #  but no such field exists in contract.py right now, so the allowlist is empty
    #  and parity is exact.)
}


class Drift(Exception):
    """Raised with a precise, human-readable description of a contract mismatch."""


def _fail(lines: list[str]) -> None:
    print("[check-contract] PARITY FAIL", file=sys.stderr)
    for ln in lines:
        print(f"  - {ln}", file=sys.stderr)
    sys.exit(1)


# --------------------------------------------------------------------------- load
def load_schema() -> dict:
    if not os.path.isfile(SCHEMA_PATH):
        _fail([f"schema not found: {SCHEMA_PATH}"])
    try:
        with open(SCHEMA_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except json.JSONDecodeError as e:
        _fail([f"events.schema.json is not valid JSON: {e}"])
    return {}  # unreachable


def import_contract():
    try:
        import wyc.contract as contract  # noqa: WPS433 (intentional late import)
        return contract
    except Exception as e:  # pragma: no cover - import failure is a hard fail
        _fail([f"cannot import wyc.contract from {REPO_ROOT}: {e!r}"])


def read_text(path: str) -> str:
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


# ----------------------------------------------------------- (d) schema tightness
def check_schema_tight(schema: dict) -> list[str]:
    """Every oneOf entry must set additionalProperties:false."""
    errs: list[str] = []
    one_of = schema.get("oneOf")
    if not isinstance(one_of, list) or not one_of:
        return ["schema has no non-empty `oneOf` (cannot validate message types)"]
    for i, entry in enumerate(one_of):
        title = entry.get("title", f"<oneOf[{i}]>")
        if entry.get("additionalProperties", None) is not False:
            errs.append(
                f"oneOf entry '{title}' is missing additionalProperties:false "
                "(contract must stay tight — extra wire fields silently accepted)"
            )
    return errs


# ----------------------------------------------------------- (c) version lockstep
def check_versions(schema: dict, contract) -> list[str]:
    errs: list[str] = []
    pv = getattr(contract, "PROTOCOL_VERSION", None)
    if not isinstance(pv, int):
        return ["wyc.contract.PROTOCOL_VERSION missing or not an int"]

    # top-level `v` const
    top_v = (schema.get("properties", {}).get("v", {}) or {}).get("const")
    if top_v is None:
        errs.append("schema top-level properties.v has no `const` (version unpinned)")
    elif top_v != pv:
        errs.append(
            f"PROTOCOL_VERSION ({pv}) != schema top-level v const ({top_v})"
        )

    # every oneOf entry that pins `v` must pin the SAME version (no split-brain).
    for entry in schema.get("oneOf", []) or []:
        title = entry.get("title", "<oneOf>")
        v_prop = (entry.get("properties", {}) or {}).get("v", {}) or {}
        v_const = v_prop.get("const")
        if v_const is None:
            errs.append(f"oneOf entry '{title}' does not pin `v` const")
        elif v_const != pv:
            errs.append(
                f"oneOf entry '{title}' pins v={v_const}, "
                f"!= PROTOCOL_VERSION {pv}"
            )
    return errs


# --------------------------------------------------- (a) entity <-> dataclass parity
def schema_entity_props(schema: dict, name: str) -> list[str] | None:
    ent = (schema.get("$defs", {}) or {}).get(name)
    if not isinstance(ent, dict):
        return None
    return list((ent.get("properties", {}) or {}).keys())


def dataclass_field_names(contract, name: str) -> list[str] | None:
    obj = getattr(contract, name, None)
    if obj is None or not dataclasses.is_dataclass(obj):
        return None
    return [f.name for f in dataclasses.fields(obj)]


def check_entities(schema: dict, contract) -> list[str]:
    errs: list[str] = []
    for name in WIRE_ENTITIES:
        props = schema_entity_props(schema, name)
        fields = dataclass_field_names(contract, name)
        if props is None:
            errs.append(f"$defs.{name} missing or has no properties in schema")
            continue
        if fields is None:
            errs.append(f"no @dataclass named {name} in wyc/contract.py")
            continue
        allow = FIELD_ALLOWLIST.get(name, {})
        sp, sf = set(props), set(fields)
        # fields in the dataclass but NOT on the wire (allowlisted = intentional)
        only_dc = (sf - sp) - set(allow)
        # properties on the wire but NOT in the dataclass (always drift)
        only_schema = sp - sf
        for f in sorted(only_schema):
            errs.append(
                f"{name}: schema property '{f}' has NO dataclass field "
                "(daemon can't emit it — add the field or remove the property)"
            )
        for f in sorted(only_dc):
            errs.append(
                f"{name}: dataclass field '{f}' has NO schema property "
                "(unmirrored wire field — add it to the schema or to "
                "FIELD_ALLOWLIST with a reason)"
            )
    return errs


# ------------------------------------------- (b) message types <-> helpers / docs
def contract_msg_types(src: str) -> set[str]:
    """Every literal msg("<t>") string produced anywhere in contract.py.

    Parsed via AST (not regex) so we only count real msg(...) calls with a string
    literal first arg — the actual set of server->client envelopes the helpers
    can emit.
    """
    produced: set[str] = set()
    tree = ast.parse(src, filename=CONTRACT_PY)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        is_msg = (isinstance(fn, ast.Name) and fn.id == "msg") or (
            isinstance(fn, ast.Attribute) and fn.attr == "msg"
        )
        if not is_msg or not node.args:
            continue
        first = node.args[0]
        if isinstance(first, ast.Constant) and isinstance(first.value, str):
            produced.add(first.value)
    return produced


def check_message_types(contract_src: str, client_src: str) -> list[str]:
    errs: list[str] = []
    produced = contract_msg_types(contract_src)
    for t in SERVER_TO_CLIENT:
        if t not in produced:
            errs.append(
                f"server->client type '{t}' is NOT produced by any msg(\"{t}\") "
                "helper in wyc/contract.py"
            )
    # client->server types must be documented somewhere in the contract or client.
    # We accept either a mention in contract.py (the helper/docstring listing) or a
    # send helper in client.js — both are the documented surface.
    haystack = contract_src + "\n" + client_src
    for t in CLIENT_TO_SERVER:
        # look for the type as a quoted token: 'subscribe' / "subscribe" /
        #   t: 'subscribe' / t:"subscribe"  (covers the schema-mirror docstring,
        #   the client send({t:'...'}) helpers, and any prose listing).
        if not re.search(rf"""['"]{re.escape(t)}['"]""", haystack):
            errs.append(
                f"client->server type '{t}' is not documented in "
                "wyc/contract.py or web/client.js"
            )
    return errs


# ------------------------------------------------------------ FRONTEND coverage
# (the same logic lives standalone in tools/check_frontend.py; we run it inline so
#  `python3 tools/check_contract.py` is the single gate the parent/CI invokes.)
def route_cases(client_src: str) -> set[str]:
    """The `t` values handled by client.js route()'s switch (case 'x':)."""
    cases: set[str] = set()
    # restrict to the route() function body so an unrelated switch elsewhere
    # can't mask a missing case (route() is the dispatch under test).
    m = re.search(r"function\s+route\s*\([^)]*\)\s*\{", client_src)
    body = client_src[m.end():] if m else client_src
    for cm in re.finditer(r"""case\s+['"]([A-Za-z_][\w]*)['"]\s*:""", body):
        cases.add(cm.group(1))
    return cases


def store_apply_handlers(store_src: str) -> set[str]:
    """Map server->client data-bearing types to the apply* fn store.js defines.

    A type is 'handled' if store.js defines the conventional applier:
      snapshot->applySnapshot, activity->applyActivity, terminal->applyTerminal,
      screen->applyScreen, session_update->applySession, thread_update->applyThread.
    We assert the function is DEFINED (function applyX( ...).
    """
    type_to_fn = {
        "snapshot": "applySnapshot",
        "activity": "applyActivity",
        "terminal": "applyTerminal",
        "screen": "applyScreen",
        "session_update": "applySession",
        "thread_update": "applyThread",
    }
    handled: set[str] = set()
    for t, fn in type_to_fn.items():
        if re.search(rf"function\s+{re.escape(fn)}\s*\(", store_src):
            handled.add(t)
    return handled


def check_frontend(client_src: str, store_src: str) -> list[str]:
    errs: list[str] = []
    cases = route_cases(client_src)
    for t in SERVER_TO_CLIENT:
        if t not in cases:
            errs.append(
                f"web/client.js route() has NO case for server->client type "
                f"'{t}' (a new event type would be silently dropped)"
            )
    handled = store_apply_handlers(store_src)
    for t in DATA_BEARING:
        if t not in handled:
            errs.append(
                f"web/store.js has NO apply path for data-bearing type '{t}' "
                "(event would reach the client but never update state)"
            )
    return errs


# --------------------------------------------------------------------------- main
def main() -> int:
    schema = load_schema()
    contract = import_contract()
    contract_src = read_text(CONTRACT_PY)
    client_src = read_text(CLIENT_JS)
    store_src = read_text(STORE_JS)

    errs: list[str] = []
    errs += check_schema_tight(schema)                       # (d)
    errs += check_versions(schema, contract)                 # (c)
    errs += check_entities(schema, contract)                 # (a)
    errs += check_message_types(contract_src, client_src)    # (b)
    errs += check_frontend(client_src, store_src)            # frontend coverage

    if errs:
        _fail(errs)

    n_props = sum(len(schema_entity_props(schema, e) or []) for e in WIRE_ENTITIES)
    print(
        f"[check-contract] {len(WIRE_ENTITIES)} entities / {n_props} fields, "
        f"{len(SERVER_TO_CLIENT)} server->client + {len(CLIENT_TO_SERVER)} "
        f"client->server types, v={contract.PROTOCOL_VERSION} — all in lockstep; "
        "frontend handles every type."
    )
    print("[check-contract] PARITY OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
