# watchyourclankers Constitution

**Version**: 1.3.0 | **Ratified**: 2026-06-16 | **Last Amended**: 2026-06-16

A read-only **IDE-spectator**: watch Claude Code work live, over its shoulder, across every session on this machine. The watcher observes; it never touches the work it watches. Built in clanker's idiom so it can merge into clanker later.

> **Enforcement note (v1.1.0):** every principle below names a machine-resolvable enforcer via an inline `[enforcer: <ref>]` tag. `tools/check_constitution_gates.py` fails the gate if any principle lacks a tag or any tag does not resolve — so Principle IX ("no gate is `(planned)`") is itself mechanically enforced. This closes the v1.0.0 gap where VII (perf) and VIII (spec-coverage) and the Governance ECC clause claimed gates that were never built.

## Core Principles (NON-NEGOTIABLE)

### I. Observer, Never Actor
The tool is **read-only over the sessions it watches**. It MUST NOT write to, signal, or interfere with any Claude session, transcript, or working tree. Annotations (pin/freeze/flag) live in our own store under `DATA_DIR`, never in the observed artifacts. *Gate (live): no write path targets `~/.claude/**` or any observed repo; CI greps for it. [enforcer: ci/fast.sh:write-path]*

### II. Secrets Never Reach the Glass
Transcripts are full of credentials. Every value rendered to a browser passes through `wyc.redact` first (API keys, tokens, passwords, private keys, connection strings). The server **binds loopback only** and requires auth (reuse clanker's HMAC+TOTP when merged; a local token in standalone). *Gate (live): redaction unit test with a secret-laden fixture; bind defaults to 127.0.0.1; a render-path test asserts no raw `tool_input` field escapes un-redacted. [enforcer: ci/fast.sh:0.0.0.0]*

### III. The Contract Is the Seam
`contracts/events.schema.json` + `wyc/contract.py` are the single source of truth for the wire and the internal interfaces. Producers and consumers — and the eventual clanker merge — code to it, never to each other. Wire change ⇒ bump `PROTOCOL_VERSION` + update both files in the same commit. *Gate (live): a schema-vs-dataclass parity test. [enforcer: tools/check_contract.py]*

### IV. Total Activity Coverage
Nothing Claude does is invisible. Every tool action maps to a surface (editor / file-peek / **terminal** / search / fan-out) or, failing that, the activity ticker (`KIND_OTHER`). Shell commands are a first-class surface: command shown instantly, output streamed. *Gate (live): `kind_for_tool` is total; an unknown-tool test yields `other`, not a crash. [enforcer: ci/fast.sh:pytest]*

### V. A Thread Survives Handoffs
The watchable unit is a **thread of work**, not a session. Repo (clanker `resolve_project`) is the container; sessions are stitched across handoff leapfrogs by fuzzy name-stem + handoff-doc lineage + time-contiguity. No signal is load-bearing alone (typo-robust). Operator merge/split/alias overrides are sticky and win. *Gate (live): a typo'd-name fixture still stitches via handoff-doc; an override persists across restart. [enforcer: ci/fast.sh:pytest]*

### VI. Snapshot-Then-Stream
Clients hydrate from a `snapshot`, then consume the live stream by monotonic `seq`; a gap triggers `resync` → re-snapshot. Drop-slow on high-rate surfaces (terminal/edits), never on session/thread updates. *Gate (live): a forced gap recovers without a full reload. [enforcer: ci/fast.sh:pytest]*

### VII. Clanker's Idiom, Performant Beyond It
Python + aiohttp + JSONL backend; vanilla JS + CodeMirror 6 frontend, **no RUNTIME build step** — the browser loads static files directly (no webpack/bundler/transpile at serve time). *Amendment (v1.3.0):* a **one-time VENDORING build** is permitted — a dependency that cannot be fetched at runtime (this box can't reach esm.sh) may be bundled ONCE by a developer (`build/codemirror`, esbuild → a committed `web/vendor/*.bundle.js`) and served as a plain static file. The browser still loads a committed static artifact; what is forbidden is a *serve-time* pipeline, not a vendored bundle produced by a one-time build. Stay mergeable into clanker (`serve.py` routes, `/data/clanker/` SSOT, `resolve_project`). Performance is a feature: editors mount only in visible tiles; per-activity render is O(1), no full re-render. *Gate (live, v1.1.0): the mosaic binds at most `slots` tiles regardless of how many threads are active — a bounded-render unit test on the pure slot-assignment (replaces the never-built "perf smoke"). [enforcer: web/assign.test.mjs]* *Gate (live, v1.3.0): the vendored CM bundle exists + actually imports/mounts/reveals on-box, run vs the live daemon by the CM-on-box probe wired into the gate. [enforcer: ci/fast.sh:cm_smoke.mjs]*

### VIII. Spec Spine: Flow-Forward
Every feature flows `/speckit-specify` → clarify → plan → tasks → analyze → implement into `specs/NNN-*/`. Architecture earns a spec; fast render-loop UX iteration is logged in `docs/UX_LOG.md` (the honest two-track model). Completed specs are immutable history; new requirements get a new numbered spec that supersedes. *Gate (live, v1.1.0): every source file is governed by a spec or a logged UX-iteration — no orphan code (replaces the never-built "spec-coverage check"). [enforcer: tools/check_coverage.py]*

### IX. Mechanical Gates Over Promises
Discipline is enforced by `ci/fast.sh` + hooks, not willpower. No gate is `(planned)` — its enforcer is live before the work it governs, and `tools/check_constitution_gates.py` verifies every principle here names a resolvable enforcer. Behavior is gated at BOTH layers: `node --check` proves a file parses, `node --test` proves pure LOGIC behaves, and `ci/interaction.mjs` (real pointer events vs the live daemon) proves the DOM actually INTERACTS — because a pure-logic test passes while the wiring is dead (LESSONS L1/L7). Interaction files (`ide/mosaic/resize/debug.js`) therefore REQUIRE the DOM test, enforced by `tools/check_interaction_tests.py` (rung o). "Done/green/passing" requires the matching success token in the same message (`set -o pipefail`; pipe-to-tail is not evidence). *Gate (live): `ci/fast.sh` emits `[ci-fast] ALL GREEN` only when every check passed, including the behavioral + DOM-interaction rungs. [enforcer: tools/check_interaction_tests.py]*

### X. Multi-Agent Discipline
Parent-only files: `contracts/**`, `wyc/contract.py`, this constitution, `CLAUDE.md`, `docs/MASTER_PLAN.md`, `ci/**`, `tools/**`, specs. Sub-agents get an explicit disjoint allow-list per dispatch and never commit; the parent integrates and re-verifies on the merged tree. Fanout whenever it doesn't sacrifice integrity — but interaction/behavior code only fans out behind a behavioral test (Principle IX). *Gate (live): the agent/parent matrix in CLAUDE.md; parent re-runs `ci/fast.sh` post-merge. [enforcer: CLAUDE.md:Agent ↔ parent]*

### XI. Definition of Done (NON-NEGOTIABLE)
1. Maps to a spec id or a `docs/UX_LOG.md` entry. 2. `ci/fast.sh` green (token shown). 3. Behavior demonstrated against **real** `~/.claude` data, not only fixtures, AND a behavioral test where the change is interactive. 4. Contract + schema in sync. 5. Committed (clean author, no co-author trailer). 6. Any tracked remediation item it closes is flipped in `docs/REMEDIATION.md`. *Gate (live): the closure ledger refuses green while any tracked item is open. [enforcer: tools/check_ledger.py]*

## Governance
This constitution supersedes other practice in this repo. **ECC** rule packs are vendored under `ecc/` as reference taste, superseded here on conflict; the vendoring is mechanically verified so the reference is never phantom. Amend via semver bump + ratified date; dependent templates stay in sync. *Gate (live, v1.1.0): the vendored ECC rule packs exist on disk. [enforcer: ecc/RULES.md]*

**Version**: 1.3.0 | **Ratified**: 2026-06-16 | **Last Amended**: 2026-06-16
