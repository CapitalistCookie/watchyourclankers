# watchyourclankers — Master Plan

**Created**: 2026-06-16 | **Owner**: CapitalistCookie | **Status**: W1 in flight

## Vision
A web UI where you watch Claude Code work **like a 3rd person looking over its shoulder in an IDE** — the editor auto-follows whatever file Claude edits, the terminal shows shell commands it runs, file-peeks/searches/sub-agent fan-outs all surface live. Read-only now; pin / freeze-for-comment / flag are stubbed for later. Multiple sessions tile in a dynamic mosaic; mobile collapses to a swipeable single pane. Eventually merges into **clanker**.

## Architecture (3 layers, contract = seam)
```
~/.claude/sessions/*.json  ─┐
~/.claude/projects/**/*.jsonl ├─► wyc.watcher ─(redact)─► aiohttp /ws ─► browser (vanilla JS + CodeMirror 6)
  + /subagents/agent-*.jsonl ─┘   (poll+tail+stitch)        snapshot-then-stream
PostToolUse hook (enrichment) ────┘
```
- **Feed**: `sessions.py` (live registry) + `transcripts.py` (tail+parse, incl. subagents) + `tmux.py` (tmux identity + liveness + raw-screen, W1.5) + `threads.py` (handoff-spanning stitch) + `watcher.py` (orchestrate → monotonic wire stream).
- **Serve**: `server.py` (aiohttp WS + static + loopback/token auth) + `handoff.py` (one-liner generator) + `hooks/post-tool-use.py` (enrichment) + `redact.py` (parent). Package entrypoints: `wyc/__init__.py` (exports) + `wyc/__main__.py` (`python -m wyc serve`).
- **Web**: `client.js`/`store.js` (WS + snapshot-then-stream + seq-gap), `ide.js` (IDE pane), `mosaic.js`+`menu.js` (tiling + ⌘K + settings), `app.js`/`index.html` (shell).
- **State (ours)**: `/data/clanker/watchyourclankers/` — thread overrides, aliases, annotations.

## Waves (sequence: infra → depth → breadth)
| Wave | Spec | Scope | Gate to open |
|------|------|-------|--------------|
| **W1** | `001-infra-contract-feed` | Hybrid feed (poll+tail+hook), thread-stitch, contract, redaction, server, **debug UI**; live against real `~/.claude` | constitution + contract exist (✅) |
| **W2** | `002-ide-pane` | One polished IDE-spectator pane: file tree, tabbed auto-switching CodeMirror editor, live hunk highlight, **live terminal surface**, thread-follow across handoffs | W1 feed verified live |
| **W3** | `003-mosaic-mobile` | Dynamic tiling mosaic, sub-agent/workflow fan-out reflow, ⌘K command menu + settings, pin/freeze/flag stubs, mobile single-pane swipe, localStorage + URL state | W2 pane verified |

## Status (2026-06-16) — W1 + W1.5 + W2 + W3 SHIPPED
All waves implemented & **live-verified**: transcript feed + tmux identity/raw-screen + CodeMirror IDE pane + dynamic mosaic. UI **browser-rendered** (Playwright: 28–87 tiles, sub-agent fan-out, file tree, live terminal, redaction; 0 console errors). Specs: `001-infra-contract-feed`, `002-ide-pane`, `003-mosaic-mobile` (all Implemented). Gates: `ci/fast.sh` (87 tests) + `ci/full.sh` (render smoke). On `main`.
Next: **W4 — merge into clanker** (seam below). Optional: vendor CodeMirror (esm.sh unreachable on-box → headless falls back to `<pre>`; real browsers load it); annotate write-path (pin/freeze/flag are read-only stubs by design).

## Remediation (2026-06-16) — make every claimed gate real
A framework audit found the constitution promised 11 live gates but ~4 were `(planned)` in
disguise (VII perf-smoke, VIII spec-coverage, IX behavioral, Governance vendored-ECC), and
`docs/HANDOFF.md` had silently rotted 3 commits behind HEAD — exactly the un-gated areas
rotted while every gated one held. Tracked + enforced via `docs/REMEDIATION.md` (a
machine-readable closure ledger; `tools/check_ledger.py` keeps `ci/fast.sh` RED until every
item is closed with a live enforcer). New mechanical gates: behavioral `node --test` rung
(j); `check_constitution_gates.py` (k, no phantom gate); `check_coverage.py` (l, no orphan
code); `check_handoff_fresh.py` (m, handoff can't rot). The UI-polish arc
(`web/resize.js`, the Watch-N bar, natural-follow, collapse) is folded into `docs/UX_LOG.md`
(the honest two-track model); determinism lessons persist in `docs/LESSONS.md`. The reverted
IDE interaction layer (drag / continuous terminal / char-reveal) is redone here behind
behavioral tests. Constitution bumped 1.0.0 → 1.1.0.

## Merge-into-clanker seam
Clanker is Python+aiohttp+JSONL, dashboard on :8899, SSOT `/data/clanker/`, already PTY-streams tmux. Merge path: host the `/ws` + static under clanker `serve.py`; write state under `/data/clanker/watchyourclankers/`; reuse `resolve_project(cwd)` and HMAC+TOTP auth; optionally feed the terminal surface from clanker's existing PTY capture.

## Decisions (D-log)
- **D1** Frontend = clanker's idiom (vanilla JS), not React (operator: "React is overkill; go beyond clanker, custom + performant"). CodeMirror 6 via CDN for the editor surface.
- **D2** Layout = dynamic tiling mosaic.
- **D3** Feed = hybrid from day one (session-poll + transcript-tail + PostToolUse hook).
- **D4** Thread identity = repo container + fuzzy name-stem + handoff-doc lineage + time-contiguity; operator override sticky + aliases (typo-robust). Operator Q resolved: a typo can't break it because no single signal is load-bearing and overrides/aliases persist.
- **D5** Build all 3 slices; sequence infra → depth → breadth.
- **D6** **Total activity coverage incl. live shell** — terminal is a first-class surface; the spectator follows *everything* Claude does on the machine (operator add).
- **D7** Handoff one-liner generation is a built-in framework feature (`wyc handoff`) + harness hook, not an afterthought.
- **D8** Public repo `CapitalistCookie/watchyourclankers`; merges into clanker later.

## Open issues
- OI-1: real-PTY live terminal (clanker reuse) vs transcript-only output — W2 decision.
- OI-2: clanker auth reuse when standalone — local token for now (Principle II).
