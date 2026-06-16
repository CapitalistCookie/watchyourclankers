# watchyourclankers — Session Handoff (2026-06-16)

**Repo:** `/home/user/projects/watchyourclankers` · github.com/CapitalistCookie/watchyourclankers (public) · `main` @ `c54957a`
**Run:** `python3 -u -m wyc serve` → http://127.0.0.1:8900 (loopback + token at `/data/clanker/watchyourclankers/.wyc_token`). Gate: `ci/fast.sh` (87 tests, green).

## One-liner for a fresh session
> Resume **watchyourclankers** (`~/projects/watchyourclankers` · `CapitalistCookie/watchyourclankers` · `main@c54957a`): read `CLAUDE.md` → `.specify/memory/constitution.md` → `docs/MASTER_PLAN.md` → `docs/HANDOFF.md`; W1+W1.5+W2+W3 are DONE & live-verified (transcript-feed + tmux identity/raw-screen + CodeMirror IDE pane + dynamic mosaic; detection = 3 sources transcript/tmux/disk), `ci/fast.sh` green (87 tests); run `python3 -u -m wyc serve` → http://127.0.0.1:8900 (token in `/data/clanker/watchyourclankers/.wyc_token`); NEXT = browser-verify the mosaic UI (only the backend is live-tested so far), then the annotate write-path (pin/freeze/flag are stubs), watcher `ingest_hook` enrichment, and W4 merge into clanker (`serve.py` routes + `/data/clanker` + HMAC/TOTP).

## Done — live-verified on real ~/.claude
- **W1 feed:** session-poll + transcript-tail (incl. `subagents/`) → structured Activity/Terminal events, thread-stitch, secret redaction, versioned WS, debug UI. Verified: 19 sessions, redaction 0-leak/47-masked.
- **W1.5 tmux:** `wyc/tmux.py` — identity (tmux session/group as thread key), liveness, capture-pane **raw-screen** stream. Verified: 15 tmux-paned sessions, 7440-byte screen frame streamed.
- **W2 IDE pane:** `web/ide.js` — CodeMirror 6 (CDN, `<pre>` fallback), file tree, auto-switching tabs, live hunk highlight, terminal panel, raw-screen toggle, redacted `/file` fetch. Verified: `/file` 200 + jail 403.
- **W3 mosaic:** `web/mosaic.js`+`menu.js` — dynamic tiling, sub-agent fan-out reflow, Cmd-K palette + settings, localStorage+URL state, pin/freeze/flag stubs, mobile swipe.
- **Detection = 3 complementary sources:** transcript (structure: which file/line/subagent) · tmux (identity + live rendered screen) · disk read (`/file` content for the editor).

## Read order (architecture)
`CLAUDE.md` → `.specify/memory/constitution.md` (Principles I–XI) → `wyc/contract.py` + `contracts/events.schema.json` (the seam) → `docs/MASTER_PLAN.md` (waves + D-log).

## NOT done / next session
1. **Browser-render: DONE (2026-06-16)** — headless Playwright confirms the UI paints (28–33 tiles, sub-agent fan-out, file tree, live terminal, redaction; 0 console errors). Caught + fixed a blank-UI bug (`index.html` referenced `./app.js` but the server serves `/static/`). Now gated by `ci/full.sh` render-smoke. **Caveat:** the CodeMirror editor loads from esm.sh and THIS BOX can't reach esm.sh, so headless shows the `<pre>` fallback — a real user's browser loads CM fine. Optional robustness: vendor CM to `/static/` (box can't fetch it now; also trades off the no-build-step choice).
2. **Annotate write-path** — pin/freeze/flag emit `annotate` but the server only stubs to `DATA_DIR`; no real persistence/UI-readback yet.
3. **Enrichment hook** — `/hook` is a no-op; the watcher lacks `ingest_hook`. The PostToolUse hook posts but isn't consumed (transcript-tail is canonical, so this is enrichment only).
4. **W4 — merge into clanker:** host `/ws` + static under clanker `serve.py`; state under `/data/clanker/watchyourclankers/`; reuse `resolve_project` + HMAC/TOTP; optionally feed terminal from clanker's existing PTY capture.
5. Cosmetic: `wyc handoff <watchyourclankers-thread>` captures probe commands as "last cmd."

## Gotchas (hard-won)
- **Port 8900** — clanker owns 8899; never bind there.
- **cwd=/home/user** for interactive sessions → project is derived from **edited file paths**, not cwd (`wyc/threads.py::_effective_project`).
- **tmux thread priority:** operator-override > handoff-doc (authoritative, cross-name/cross-tmux) > tmux-group > name-stem (fuzzy ≤2) > time-contiguity.
- **Commit via `git commit -F msgfile`** — multi-line `-m` inside a compound bash repeatedly failed silently.
- **Secrets:** everything wire-bound goes through `wyc.redact`; server binds loopback + token. `GET /file` is realpath+commonpath jailed to `/home/user`, 2 MB cap, redacted.
- **subagent transcripts** live at `<slug>/<sessionId>/subagents/agent-*.jsonl` (nested under the session uuid), not `<slug>/subagents/`.
