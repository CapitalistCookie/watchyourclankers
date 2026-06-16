#!/usr/bin/env bash
# ci/full.sh — the heavier (detached post-commit) gate. Runs the fast gate, then
# a headless render smoke that catches "the UI doesn't paint" regressions which
# unit tests + node --check cannot see (e.g. the index.html /static path bug), and
# asserts the terminal-structure (one continuous feed, not boxed mini-panels — R07).
# Best-effort render: skips cleanly if node/playwright/a browser is unavailable.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
echo "[ci-full] root: $ROOT"

# 1) everything fast.sh checks must pass first.
bash ci/fast.sh

# 2) self-contained backend e2e (spawns its own daemon; asserts the live contract)
if python3 -c "import aiohttp" 2>/dev/null; then
  echo "[ci-full] backend e2e (WYC_E2E=1)"
  WYC_E2E=1 python3 -m pytest -q tests/test_e2e.py
else
  echo "[ci-full] aiohttp absent — backend e2e SKIPPED"
fi

# 3) render smoke
PORT="${WYC_FULL_PORT:-8917}"
if command -v node >/dev/null 2>&1; then
  echo "[ci-full] render smoke on 127.0.0.1:$PORT"
  python3 -u -m wyc serve --port "$PORT" > /tmp/wyc_full_daemon.log 2>&1 &
  DPID=$!
  trap 'kill -9 "$DPID" 2>/dev/null || true; pkill -9 -f "m wyc serve --port $PORT" 2>/dev/null || true' EXIT
  if ! curl -s --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "http://127.0.0.1:$PORT/healthz"; then
    echo "[ci-full] FAIL: daemon did not come up on :$PORT"; exit 1
  fi
  node ci/render_smoke.mjs "$PORT"
  echo "[ci-full] DOM-interaction probe (real pointer drag asserts gridTemplateRows changes) on :$PORT"
  node ci/interaction.mjs "$PORT"
  echo "[ci-full] CM on-box smoke (vendored bundle imports + mounts + reveals char-by-char) on :$PORT"
  node ci/cm_smoke.mjs "$PORT"
  kill -9 "$DPID" 2>/dev/null || true
  trap - EXIT
else
  echo "[ci-full] node absent — render smoke SKIPPED"
fi

echo "[ci-full] ALL GREEN"
