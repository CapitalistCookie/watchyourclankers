#!/usr/bin/env bash
# ci/full.sh — the heavier (detached post-commit) gate. Runs the fast gate, then
# a headless render smoke that catches "the UI doesn't paint" regressions which
# unit tests + node --check cannot see (e.g. the index.html /static path bug).
# Best-effort render: skips cleanly if node/playwright/a browser is unavailable.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
echo "[ci-full] root: $ROOT"

# 1) everything fast.sh checks must pass first.
bash ci/fast.sh

# 2) render smoke
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
  kill -9 "$DPID" 2>/dev/null || true
  trap - EXIT
else
  echo "[ci-full] node absent — render smoke SKIPPED"
fi

echo "[ci-full] ALL GREEN"
