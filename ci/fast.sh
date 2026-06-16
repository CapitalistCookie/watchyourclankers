#!/usr/bin/env bash
# ci/fast.sh — watchyourclankers local pre-push gate (Constitution Principle IX).
#
# Iron-law of evidence: the literal success token `[ci-fast] ALL GREEN` is printed
# on the VERY LAST line ONLY when every check below passed. Any failure exits
# non-zero BEFORE the token is ever emitted. `set -o pipefail` so a piped check
# can never mask an upstream failure. Target: < 60s.
#
# Checks:
#   (a) py_compile every wyc/*.py and hooks/*.py
#   (b) pytest -q  (if importable; otherwise a non-fatal WARN — pytest optional)
#   (c) contracts/events.schema.json parses as JSON
#   (d) GUARD: no live "0.0.0.0" bind in any wyc/*.py (Principle II) — allowed only in a comment
#   (e) GUARD: no write-path into ~/.claude / /home/user/.claude under wyc/ or hooks/ (Principle I)
#   --- frontend rung (closes the "blank UI shipped" hole) ---
#   (f) node --check every web/*.js (WARN-not-fail if node absent, like pytest)
#   (g) CSS brace-balance for every web/*.css (fail on imbalance)
#   (h) CSS-LOAD-CHAIN: index.html -> /static/app.js + styles.css, and styles.css
#       @imports its sub-sheets (each @import target must exist on disk)
#   (i) tools/check_contract.py — wire<->dataclass<->frontend parity (fail-closed)
#   --- determinism rung (closes the "behaviorally broken but parses" hole) ---
#   (j) node --test web/*.test.mjs — BEHAVIOR of pure-logic modules (WARN if node absent)
#   --- meta-gates (make the framework itself honest — Principle IX) ---
#   (k) tools/check_constitution_gates.py — every principle names a LIVE enforcer
#   (l) tools/check_coverage.py — no orphan source (every wyc/*.py, web/*.js governed)
#   (m) tools/check_handoff_fresh.py — docs/HANDOFF.md cited HEAD == git HEAD
#   (n) tools/check_ledger.py — remediation ledger refuses green while any item is open
set -euo pipefail

# Resolve repo root from this script's location so it runs from anywhere.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd -P)"
cd -- "${ROOT}"

PY="${PYTHON:-python3}"

fail() { echo "[ci-fast] FAIL: $*" >&2; exit 1; }
note() { echo "[ci-fast] $*"; }

START=$(date +%s)
note "root: ${ROOT}"

# --- (a) py_compile every backend + hook source -----------------------------
note "(a) py_compile wyc/*.py hooks/*.py"
mapfile -d '' PYFILES < <(find wyc hooks -type f -name '*.py' -print0 2>/dev/null || true)
if [ "${#PYFILES[@]}" -eq 0 ]; then
  note "  (no .py files under wyc/ or hooks/ yet — skipping compile)"
else
  "${PY}" -m py_compile "${PYFILES[@]}" || fail "py_compile failed"
  note "  compiled ${#PYFILES[@]} file(s)"
fi

# --- (b) pytest (optional — WARN if not installed, do not fail) --------------
# Real failures (exit 1-4) fail the gate. pytest's exit 5 = "no tests collected"
# is a non-fatal WARN (the suite is still being built) — NOT a green-washing of a
# failing run. pytest not importable at all is also a WARN, never a fail.
note "(b) pytest -q"
if "${PY}" -c 'import pytest' >/dev/null 2>&1; then
  set +e
  "${PY}" -m pytest -q
  PYTEST_RC=$?
  set -e
  if [ "${PYTEST_RC}" -eq 0 ]; then
    note "  pytest passed"
  elif [ "${PYTEST_RC}" -eq 5 ]; then
    note "  WARN: pytest collected no tests yet (exit 5) — none to run"
  else
    fail "pytest reported failures (exit ${PYTEST_RC})"
  fi
else
  note "  WARN: pytest not importable — tests skipped (install pytest to run them)"
fi

# --- (c) the contract schema is valid JSON ----------------------------------
note "(c) contracts/events.schema.json parses as JSON"
SCHEMA="contracts/events.schema.json"
if [ ! -f "${SCHEMA}" ]; then
  fail "${SCHEMA} not found"
fi
"${PY}" - "${SCHEMA}" <<'PYEOF' || fail "events.schema.json is not valid JSON"
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    json.load(fh)
PYEOF
note "  schema is valid JSON"

# --- (d) GUARD: no live 0.0.0.0 bind in wyc/*.py (Principle II) --------------
# A live bind = the literal 0.0.0.0 in actual code. Mentions inside comments,
# docstrings, or string literals are allowed (the contract/server document
# "never 0.0.0.0 by default"). We tokenize so a docstring mention can't be a
# live bind, but a real `host="0.0.0.0"` (a STRING token containing it) IS caught
# — string tokens that are NOT immediately preceded by a string token (i.e. not a
# docstring statement) and contain the literal are treated as a config value.
note "(d) guard: no live 0.0.0.0 bind under wyc/"
BIND_HITS=""
while IFS= read -r -d '' f; do
  if "${PY}" - "$f" <<'PYEOF'
import ast, io, re, sys, token, tokenize
path = sys.argv[1]
src = open(path, encoding="utf-8", errors="replace").read()
bad = []
try:
    toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
except Exception:
    # Unparseable here is fine; py_compile (check a) owns syntax errors.
    sys.exit(0)
# A live bind = a STRING token whose *value* IS the 0.0.0.0 address (optionally
# "0.0.0.0:PORT", optionally whitespace-padded) AND that is used in value
# position. We require the WHOLE string to be the address so prose that merely
# mentions 0.0.0.0 — docstrings, argparse help, log messages — is not a bind.
ADDR = re.compile(r"^\s*0\.0\.0\.0(?::\d+)?\s*$")
for i, tk in enumerate(toks):
    if tk.type != token.STRING:
        continue
    if "0.0.0.0" not in tk.string:
        continue
    try:
        val = ast.literal_eval(tk.string)
    except Exception:
        continue
    if not isinstance(val, str) or not ADDR.match(val):
        continue  # mentioned inside prose, not an address literal -> not a bind
    # It's a bare 0.0.0.0 address literal. Confirm it's value position, not the
    # (impossible-but-defensive) docstring case: walk back over trivia.
    j = i - 1
    while j >= 0 and toks[j].type in (
        token.NEWLINE, token.NL, token.INDENT, token.DEDENT,
        token.COMMENT, tokenize.ENCODING,
    ):
        j -= 1
    prev = toks[j] if j >= 0 else None
    if prev is None or prev.type == token.STRING:
        continue
    if prev.type == token.OP and prev.string == ":":
        continue
    bad.append(tk.start[0])
sys.exit(1 if bad else 0)
PYEOF
  then :; else
    BIND_HITS="${BIND_HITS} $f"
  fi
done < <(find wyc -type f -name '*.py' -print0 2>/dev/null || true)
if [ -n "${BIND_HITS}" ]; then
  fail "live '0.0.0.0' bind found (Principle II — loopback only) in:${BIND_HITS}"
fi
note "  no live 0.0.0.0 bind"

# --- (e) GUARD: no write-path into ~/.claude under wyc/ or hooks/ ------------
# Principle I (observer, never actor): the watcher must never write to the
# observed tree. Flag any open(..., 'w'|'a'|'x'...) or .write_text/.write_bytes
# whose target string mentions the .claude home. Reads are fine.
note "(e) guard: no write-path into ~/.claude under wyc/ or hooks/"
ACTOR_HITS=""
while IFS= read -r -d '' f; do
  if "${PY}" - "$f" <<'PYEOF'
import re, sys
src = open(sys.argv[1], encoding="utf-8", errors="replace").read()
# Tokens that denote the observed home tree.
CLAUDE = r"(?:~/\.claude|/home/user/\.claude|CLAUDE_HOME|SESSIONS_DIR|PROJECTS_DIR)"
bad = []
# 1) open(<...claude...>, '<mode with w/a/x/+>')
for m in re.finditer(r"open\s*\(([^)]*)\)", src, re.DOTALL):
    args = m.group(1)
    if re.search(CLAUDE, args) and re.search(r"['\"][rbt]*[wax+][rbt+]*['\"]", args):
        bad.append("open(write) -> .claude")
# 2) <expr mentioning .claude>.write_text(/.write_bytes(  — within a small window
for m in re.finditer(r"\.write_(?:text|bytes)\s*\(", src):
    head = src[max(0, m.start() - 200):m.start()]
    seg = head.rsplit("\n", 1)[-1]            # same logical line-ish
    if re.search(CLAUDE, seg):
        bad.append(".write_text/.write_bytes -> .claude")
sys.exit(1 if bad else 0)
PYEOF
  then :; else
    ACTOR_HITS="${ACTOR_HITS} $f"
  fi
done < <(find wyc hooks -type f -name '*.py' -print0 2>/dev/null || true)
if [ -n "${ACTOR_HITS}" ]; then
  fail "observer-never-actor violation (Principle I — write-path into ~/.claude) in:${ACTOR_HITS}"
fi
note "  no write-path into ~/.claude"

# ============================================================ FRONTEND RUNG
# These close the "stylesheet/script silently never loaded -> blank UI" class of
# bug that shipped a blank page, plus syntax-check the frontend like we compile
# the backend. They run AFTER the backend checks above; all are fail-closed
# except the node-absent path (a WARN, mirroring the pytest-absent path).

# --- (f) node --check every web/*.js (WARN if node absent) -------------------
note "(f) node --check web/*.js"
mapfile -d '' JSFILES < <(find web -maxdepth 1 -type f -name '*.js' -print0 2>/dev/null || true)
if [ "${#JSFILES[@]}" -eq 0 ]; then
  note "  (no web/*.js files — skipping)"
elif command -v node >/dev/null 2>&1; then
  JS_BAD=""
  for f in "${JSFILES[@]}"; do
    # These are ES modules (top-level import/export). `node --check <file.js>`
    # parses .js as COMMONJS, which silently tolerates some broken ESM — so we
    # feed the source on stdin with --input-type=module to syntax-check it AS an
    # ES module (parse only; no import resolution / no execution).
    node --check --input-type=module < "$f" >/dev/null 2>&1 || JS_BAD="${JS_BAD} $f"
  done
  if [ -n "${JS_BAD}" ]; then
    # re-run the first offender unsquelched so the error is visible in the log
    for f in ${JS_BAD}; do node --check --input-type=module < "$f" || true; break; done
    fail "node --check failed for:${JS_BAD}"
  fi
  note "  checked ${#JSFILES[@]} js file(s)"
else
  note "  WARN: node not installed — web/*.js syntax check skipped"
fi

# --- (g) CSS brace-balance for every web/*.css ------------------------------
# A silently-unbalanced stylesheet is a real ship-blocker (the browser drops the
# malformed rule and you get a half-styled or blank UI). We count { vs } AFTER
# stripping /* comments */ and string contents so braces inside those don't skew
# the tally. Pure-python tokenizer; fast.
note "(g) css brace-balance web/*.css"
mapfile -d '' CSSFILES < <(find web -maxdepth 1 -type f -name '*.css' -print0 2>/dev/null || true)
if [ "${#CSSFILES[@]}" -eq 0 ]; then
  note "  (no web/*.css files — skipping)"
else
  CSS_BAD=""
  for f in "${CSSFILES[@]}"; do
    if ! "${PY}" - "$f" <<'PYEOF'
import re, sys
src = open(sys.argv[1], encoding="utf-8", errors="replace").read()
# strip /* ... */ comments
src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
# strip quoted strings (url("..."), content: "..." etc.) so braces inside can't count
src = re.sub(r'"(?:[^"\\]|\\.)*"', '""', src)
src = re.sub(r"'(?:[^'\\]|\\.)*'", "''", src)
opens = src.count("{")
closes = src.count("}")
sys.exit(0 if opens == closes else 1)
PYEOF
    then
      CSS_BAD="${CSS_BAD} $f"
    fi
  done
  if [ -n "${CSS_BAD}" ]; then
    fail "CSS brace imbalance ({ vs }) in:${CSS_BAD}"
  fi
  note "  balanced ${#CSSFILES[@]} css file(s)"
fi

# --- (h) CSS-LOAD-CHAIN guard -----------------------------------------------
# The exact bug that shipped a blank UI: the page links ONE stylesheet and that
# sheet @imports the rest; if a link/import is dropped or its target is missing,
# the UI silently loses its styles. Assert the whole chain is intact AND every
# referenced file exists on disk. Fail-closed.
note "(h) css-load-chain (index.html -> styles.css -> @imports)"
"${PY}" - <<'PYEOF' || fail "CSS load-chain broken (see message above)"
import os, re, sys
WEB = "web"
errs = []

idx_path = os.path.join(WEB, "index.html")
css_path = os.path.join(WEB, "styles.css")
if not os.path.isfile(idx_path):
    errs.append("web/index.html missing")
if not os.path.isfile(css_path):
    errs.append("web/styles.css missing")

if not errs:
    idx = open(idx_path, encoding="utf-8", errors="replace").read()
    # index.html must load the app entry + the root stylesheet (served at /static/)
    if not re.search(r"""src=['"]/static/app\.js['"]""", idx):
        errs.append("index.html does not reference /static/app.js")
    if not re.search(r"""href=['"]/static/styles\.css['"]""", idx):
        errs.append("index.html does not reference /static/styles.css")

    css = open(css_path, encoding="utf-8", errors="replace").read()
    # collect every @import target in styles.css
    imports = re.findall(r"""@import\s+url\(\s*['"]([^'"]+)['"]\s*\)""", css)
    # normalize the /static/ prefix the server maps to web/
    def to_disk(ref):
        ref = ref.split("?", 1)[0].split("#", 1)[0]
        ref = re.sub(r"^/static/", "", ref)
        ref = ref.lstrip("/")
        return os.path.join(WEB, ref)
    # the sub-sheets we KNOW the UI depends on (mosaic + ide) MUST be imported.
    # (resize.css is injected at runtime by resize.js, so it is NOT required here.)
    required = {"mosaic.css", "ide.css"}
    imported_names = {os.path.basename(to_disk(i)) for i in imports}
    for need in sorted(required):
        if need not in imported_names:
            errs.append(f"styles.css does not @import {need} (UI would lose those styles)")
    # every @import target that IS declared must exist on disk
    for ref in imports:
        disk = to_disk(ref)
        if not os.path.isfile(disk):
            errs.append(f"styles.css @imports '{ref}' but {disk} does not exist")

for e in errs:
    print(f"[ci-fast] FAIL: {e}", file=sys.stderr)
sys.exit(1 if errs else 0)
PYEOF
note "  css load-chain intact (styles.css imports its sub-sheets; targets exist)"

# --- (i) contract parity (wire <-> dataclasses <-> frontend) ----------------
note "(i) tools/check_contract.py (contract parity)"
if [ -f "tools/check_contract.py" ]; then
  "${PY}" tools/check_contract.py || fail "contract parity check failed (tools/check_contract.py)"
  note "  contract parity OK"
else
  fail "tools/check_contract.py not found (frontend/contract gate cannot run)"
fi

# ============================================================ DETERMINISM RUNG
# node --check (rung f) proves a frontend file PARSES; node --test proves it
# BEHAVES. This is the rung whose absence let ghosting + drag-always-down ship to
# main (LESSONS L1). Pure-logic modules (slot-assignment, reveal/geometry math)
# are extracted so interaction behavior is unit-testable headless + zero-dep via
# Node's built-in runner. WARN-not-fail only if node is absent (mirrors pytest).

# --- (j) node --test web/*.test.mjs (BEHAVIOR, not just syntax) --------------
note "(j) node --test web/*.test.mjs"
mapfile -d '' TESTFILES < <(find web -maxdepth 1 -type f -name '*.test.mjs' -print0 2>/dev/null || true)
if [ "${#TESTFILES[@]}" -eq 0 ]; then
  note "  (no web/*.test.mjs yet — skipping)"
elif command -v node >/dev/null 2>&1; then
  node --test "${TESTFILES[@]}" || fail "node --test reported failing behavioral test(s)"
  note "  ${#TESTFILES[@]} behavioral test file(s) passed"
else
  note "  WARN: node not installed — behavioral tests skipped"
fi

# ============================================================ META-GATES
# These make the FRAMEWORK itself honest (Principle IX): no principle may claim a
# gate that isn't live (k), no source file may float ungoverned (l), the handoff
# doc may not rot (m), and the remediation ledger refuses green while anything is
# open (n). See docs/REMEDIATION.md + docs/LESSONS.md (L2–L6).

# --- (k) constitution gate-coverage (Principle IX self-enforcing) -----------
note "(k) tools/check_constitution_gates.py"
"${PY}" tools/check_constitution_gates.py || fail "a constitution principle claims an unenforced gate (Principle IX)"
note "  every principle has a live enforcer"

# --- (l) source coverage (Principle VIII — no orphan code) ------------------
note "(l) tools/check_coverage.py"
"${PY}" tools/check_coverage.py || fail "orphan source file(s) — not governed by a spec / UX_LOG (Principle VIII)"
note "  no orphan source"

# --- (m) handoff freshness (the doc can't silently rot) ---------------------
note "(m) tools/check_handoff_fresh.py"
"${PY}" tools/check_handoff_fresh.py || fail "docs/HANDOFF.md is stale (cited HEAD != actual HEAD)"
note "  handoff current"

# --- (n) remediation ledger (completeness forcing-function) -----------------
note "(n) tools/check_ledger.py"
"${PY}" tools/check_ledger.py || fail "remediation incomplete (docs/REMEDIATION.md has open items)"
note "  remediation ledger fully closed"

# --- all green --------------------------------------------------------------
ELAPSED=$(( $(date +%s) - START ))
note "all checks passed in ${ELAPSED}s"
echo "[ci-fast] ALL GREEN"
