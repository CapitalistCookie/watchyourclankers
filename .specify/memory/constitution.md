# watchyourclankers Constitution

**Version**: 1.0.0 | **Ratified**: 2026-06-16

A read-only **IDE-spectator**: watch Claude Code work live, over its shoulder, across every session on this machine. The watcher observes; it never touches the work it watches. Built in clanker's idiom so it can merge into clanker later.

## Core Principles (NON-NEGOTIABLE)

### I. Observer, Never Actor
The tool is **read-only over the sessions it watches**. It MUST NOT write to, signal, or interfere with any Claude session, transcript, or working tree. Annotations (pin/freeze/flag) live in our own store under `DATA_DIR`, never in the observed artifacts. *Gate (live): no write path targets `~/.claude/**` or any observed repo; CI greps for it.*

### II. Secrets Never Reach the Glass
Transcripts are full of credentials. Every value rendered to a browser passes through `wyc.redact` first (API keys, tokens, passwords, private keys, connection strings). The server **binds loopback only** and requires auth (reuse clanker's HMAC+TOTP when merged; a local token in standalone). *Gate (live): redaction unit test with a secret-laden fixture; bind defaults to 127.0.0.1; a render-path test asserts no raw `tool_input` field escapes un-redacted.*

### III. The Contract Is the Seam
`contracts/events.schema.json` + `wyc/contract.py` are the single source of truth for the wire and the internal interfaces. Producers and consumers — and the eventual clanker merge — code to it, never to each other. Wire change ⇒ bump `PROTOCOL_VERSION` + update both files in the same commit. *Gate (live): a schema-vs-dataclass parity test.*

### IV. Total Activity Coverage
Nothing Claude does is invisible. Every tool action maps to a surface (editor / file-peek / **terminal** / search / fan-out) or, failing that, the activity ticker (`KIND_OTHER`). Shell commands are a first-class surface: command shown instantly, output streamed. *Gate (live): `kind_for_tool` is total; an unknown-tool test yields `other`, not a crash.*

### V. A Thread Survives Handoffs
The watchable unit is a **thread of work**, not a session. Repo (clanker `resolve_project`) is the container; sessions are stitched across handoff leapfrogs by fuzzy name-stem + handoff-doc lineage + time-contiguity. No signal is load-bearing alone (typo-robust). Operator merge/split/alias overrides are sticky and win. *Gate (live): a typo'd-name fixture still stitches via handoff-doc; an override persists across restart.*

### VI. Snapshot-Then-Stream
Clients hydrate from a `snapshot`, then consume the live stream by monotonic `seq`; a gap triggers `resync` → re-snapshot. Drop-slow on high-rate surfaces (terminal/edits), never on session/thread updates. *Gate (live): a forced gap recovers without a full reload.*

### VII. Clanker's Idiom, Performant Beyond It
Python + aiohttp + JSONL backend; vanilla JS + CodeMirror 6 frontend, **no build step** (CDN deps). Stay mergeable into clanker (`serve.py` routes, `/data/clanker/` SSOT, `resolve_project`). Performance is a feature: editors mount only in visible tiles; per-activity render is O(1), no full re-render. *Gate (live): N concurrent sessions render without jank in the perf smoke test.*

### VIII. Spec Spine: Flow-Forward
Every feature flows `/speckit-specify` → clarify → plan → tasks → analyze → implement into `specs/NNN-*/`. Completed specs are immutable history; new requirements get a new numbered spec that supersedes. *Gate (live): impl references a spec id; spec-coverage check.*

### IX. Mechanical Gates Over Promises
Discipline is enforced by `ci/fast.sh` + hooks, not willpower. No gate is `(planned)` — its enforcer is live before the work it governs. "Done/green/passing" requires the matching success token in the same message (`set -o pipefail`; pipe-to-tail is not evidence). *Gate (live): `ci/fast.sh` emits `[ci-fast] ALL GREEN` only when every check passed.*

### X. Multi-Agent Discipline
Parent-only files: `contracts/**`, `wyc/contract.py`, this constitution, `CLAUDE.md`, `docs/MASTER_PLAN.md`, `ci/**`, specs. Sub-agents get an explicit disjoint allow-list per dispatch and never commit; the parent integrates and re-verifies on the merged tree. Fanout whenever it doesn't sacrifice integrity. *Gate (live): the agent/parent matrix in CLAUDE.md; parent re-runs `ci/fast.sh` post-merge.*

### XI. Definition of Done (NON-NEGOTIABLE)
1. Maps to a spec id. 2. `ci/fast.sh` green (token shown). 3. Behavior demonstrated against **real** `~/.claude` data, not only fixtures. 4. Contract + schema in sync. 5. Committed (clean author, no co-author trailer).

## Governance
This constitution supersedes other practice in this repo. Vendored ECC rules are reference taste, superseded here on conflict. Amend via semver bump + ratified date; dependent templates stay in sync.

**Version**: 1.0.0 | **Ratified**: 2026-06-16 | **Last Amended**: 2026-06-16
