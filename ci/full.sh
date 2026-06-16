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

# packaging smoke (M1 — pip-install-from-git): the wheel MUST ship the frontend
# (wyc/web/**) or an installed copy has no UI. Build a wheel and assert the assets
# are inside. WARN-skip if the build toolchain is unavailable, but FAIL on a real
# regression (build succeeds yet the assets are missing).
echo "[ci-full] packaging smoke (wheel ships wyc/web/)"
PKG_TMP="$(mktemp -d)"
if python3 -m pip wheel --no-deps -q -w "$PKG_TMP" . > /tmp/wyc_full_wheel.log 2>&1; then
  WHL="$(ls "$PKG_TMP"/watchyourclankers-*.whl 2>/dev/null | head -1)"
  if [ -n "$WHL" ] && python3 -c "import zipfile,sys; n=zipfile.ZipFile(sys.argv[1]).namelist(); sys.exit(0 if 'wyc/web/index.html' in n and 'wyc/web/vendor/codemirror.bundle.js' in n else 1)" "$WHL"; then
    echo "[ci-full]   wheel ships wyc/web/index.html + the CM bundle"
  else
    echo "[ci-full] FAIL: built wheel is missing wyc/web/ assets (a pip-install would have no UI)"; rm -rf "$PKG_TMP"; exit 1
  fi
else
  echo "[ci-full]   WARN: wheel build unavailable — packaging smoke skipped (see /tmp/wyc_full_wheel.log)"
fi
rm -rf "$PKG_TMP"

echo "[ci-full] ALL GREEN"
