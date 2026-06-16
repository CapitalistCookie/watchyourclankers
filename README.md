# watchyourclankers

> Watch Claude Code work **live, over its shoulder, in an IDE** — across every session on your machine.

A read-only **IDE-spectator** web UI. As Claude edits files, runs shell commands, peeks at files, searches, and fans out to sub-agents, you see it happen in real time: the editor auto-follows whatever file Claude is editing, the terminal streams the commands it runs, and every other action surfaces on an activity ticker. You are the third person looking over its shoulder.

It **observes; it never acts.** Nothing it does can touch the work it watches — no writes to any transcript, session, or working tree. Built in [clanker](#merges-into-clanker)'s idiom so it can fold into clanker later.

## The vision

Today, watching Claude work means tailing a JSONL transcript or squinting at one terminal. watchyourclankers turns that raw firehose into the experience of **standing behind a developer in their IDE**:

- The **editor pane** tabs to whatever file Claude opens and highlights the exact hunk it just changed.
- The **terminal surface** shows each `Bash` command the instant it fires and streams the output back, exit code and all — shell work is first-class, not an afterthought.
- File-peeks, greps/globs, `TodoWrite`s, web fetches, and **sub-agent fan-outs** all light up as they happen. Nothing Claude does is invisible.
- Many sessions tile into a **dynamic mosaic**; on a phone it collapses to a swipeable single pane so you can spectate from the couch.
- A unit of work is a **thread**, not a session — sessions you leapfrog through handoffs stitch back into one continuous story.

Read-only now. `pin` / `freeze-for-comment` / `flag` are stubbed for a later interactive phase; annotations will live in our own store, never in the observed artifacts.

## Architecture

The **contract is the seam.** `contracts/events.schema.json` + `wyc/contract.py` define the wire protocol and the internal interfaces; everything codes to them, never to each other.

```
  ~/.claude/sessions/*.json        ─┐  (live session registry, polled)
  ~/.claude/projects/**/*.jsonl     ├─►  wyc.watcher  ──redact──►  aiohttp /ws  ──►  browser
    + .../subagents/agent-*.jsonl   ┘   poll + tail + stitch        snapshot-          vanilla JS
  PostToolUse hook (enrichment)    ─────────┘                       then-stream        + CodeMirror 6
```

Three layers:

- **Feed** — `sessions.py` (live registry poll) + `transcripts.py` (append-safe tail + parse, sub-agents included) + `threads.py` (handoff-spanning stitch) + `watcher.py` (orchestrate everything into one monotonic, redacted event stream).
- **Serve** — `server.py` (aiohttp WebSocket + static, **loopback bind + token auth**) + `handoff.py` (one-liner generator) + `hooks/post-tool-use.py` (optional enrichment; the daemon degrades gracefully without it) + `redact.py` (every wire-bound value passes through here).
- **Web** — `client.js` / `store.js` (WS client, snapshot-then-stream, `seq`-gap → `resync`), `ide.js` (the IDE-spectator pane), `mosaic.js` + `menu.js` (tiling + `Cmd-K` command menu + settings), `app.js` / `index.html` (the shell). No build step — CodeMirror 6 loads from a CDN.

**State (ours):** `/data/clanker/watchyourclankers/` — thread overrides, aliases, annotations. The observed artifacts are never written.

## Quickstart

```bash
python3 -u -m wyc serve
# then open:
http://127.0.0.1:8900
```

The daemon binds **loopback only** (never `0.0.0.0`) and requires a local token (Principle II). Run the gate any time with:

```bash
ci/fast.sh        # the pre-push gate — prints `[ci-fast] ALL GREEN` only if every check passed
```

## The three waves

Sequence is **infra → depth → breadth**. Each wave opens only after the previous is verified live against real `~/.claude` data.

| Wave | Spec | What lands |
|------|------|-----------|
| **W1** | `001-infra-contract-feed` | The foundation: hybrid feed (session-poll + transcript-tail + PostToolUse hook), thread-stitch across handoffs, the contract + redaction, the aiohttp `/ws` server, and a **debug UI** proving live activity from real sessions. |
| **W2** | `002-ide-pane` | One polished IDE-spectator pane: file tree, tabbed auto-switching CodeMirror editor with live hunk highlight, a **live terminal surface**, and thread-follow across handoffs. |
| **W3** | `003-mosaic-mobile` | The dynamic tiling mosaic, sub-agent / workflow fan-out reflow, the `Cmd-K` command menu + settings, the pin/freeze/flag stubs, mobile single-pane swipe, and localStorage + URL state. |

## Repo layout

```
.specify/               Spec Kit: constitution (binding law), templates, scripts
  memory/constitution.md   Principles I–XI — read this first
  templates/               spec / plan / tasks templates
contracts/
  events.schema.json    the wire protocol (JSON Schema) — SSOT, mirrored in wyc/contract.py
wyc/                     the Python package (feed + serve + redact + the contract)
  contract.py              dataclasses + Protocols — the merge seam (parent-only)
  redact.py                secret scrubbing — every value to the glass passes through here
hooks/
  post-tool-use.py      optional enrichment hook
web/                     vanilla JS + CodeMirror-via-CDN frontend (no build step)
ci/
  fast.sh               the local pre-push gate (<60s, iron-law success token)
docs/
  MASTER_PLAN.md        vision, the 3-wave plan, decisions (D-log), open issues
  MODULE_BUILD_CHECKLIST.md   H-gates + anti-patterns + the recursive build cycle
specs/NNN-*/            per-feature specs (spec → plan → tasks)
tests/                  pytest suite (contract parity, redaction, stitching, …)
```

## Merges into clanker

watchyourclankers is deliberately built to fold into [clanker](https://github.com/CapitalistCookie/clankers) — the meta harness — rather than stand apart. Both are Python + aiohttp + JSONL with an SSOT under `/data/clanker/`. The merge path: host the `/ws` + static under clanker's `serve.py`; write our state under `/data/clanker/watchyourclankers/`; reuse clanker's `resolve_project(cwd)` for project identity and its HMAC+TOTP auth in place of the standalone token; and optionally feed the live terminal surface from clanker's existing tmux PTY capture. Until then it runs standalone on loopback.

## Read first

- **[`.specify/memory/constitution.md`](.specify/memory/constitution.md)** — the binding law (Principles I–XI: observer-never-actor, secrets-never-reach-the-glass, contract-is-the-seam, …).
- **[`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md)** — the vision, the 3-wave plan, and the decision log.
- **[`docs/MODULE_BUILD_CHECKLIST.md`](docs/MODULE_BUILD_CHECKLIST.md)** — how work gets built and closed here.

## License

MIT.
