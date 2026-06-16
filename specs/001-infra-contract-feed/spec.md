# Feature Specification: Infra + Contract + Live Feed (W1)

**Feature Branch**: `001-infra-contract-feed`
**Created**: 2026-06-16
**Status**: In progress

The foundation: turn the raw artifacts on this machine (`~/.claude/sessions/*.json`, transcript `*.jsonl` incl. sub-agents, a PostToolUse hook) into a single, redacted, monotonic, thread-stitched event stream over a versioned WebSocket — proven by a debug UI rendering live activity from real sessions.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — See every live session and what it's doing (Priority: P1) 🎯 MVP
As a spectator, I open the UI and immediately see every active Claude session on the box, each labelled with its thread, project, status (busy/idle), and the file/surface it's currently on — updating live.
**Independent test**: start the daemon with real sessions running; the debug UI lists them with correct project + status and updates within ~200ms of activity.
**Acceptance**:
- Given N live sessions, When the page loads, Then a `snapshot` lists all N with project (via `resolve_project`) and status.
- Given a session edits a file, When the edit lands in its transcript, Then an `activity` of kind `edit` with the `file_path` streams to the client < ~300ms later.

### User Story 2 — Watch Claude run shell commands in a live terminal (Priority: P1)
As a spectator, when Claude runs a Bash command I see the **command appear instantly** and its **output stream into a terminal view** — so I can follow what Claude is doing on the machine, not just the files it edits.
**Independent test**: a watched session runs `Bash`; the UI shows the command immediately and the output (with exit status) when it completes.
**Acceptance**:
- Given Claude invokes Bash, When the tool_use line is written, Then an `activity` of kind `bash` with `detail`=command streams immediately.
- Given the command completes, When the tool_result is written, Then a `terminal` message with the output + `exit_code` + `done:true` streams, correlated by `ref_seq`.
- Given the output contains a secret-looking token, Then it is redacted before it reaches the client.

### User Story 3 — One thread that survives my handoff leapfrogging (Priority: P2)
As an operator who ends sessions and starts fresh ones to continue the same work, I see those sessions grouped into one continuous **thread**, even if I typo the session name.
**Independent test**: fixtures for `comms3` → `coms4`(typo) that share a handoff doc resolve to one thread; an operator merge persists across restart.
**Acceptance**:
- Given session B Reads a `*HANDOFF*.md` that session A Wrote, Then A and B share a `thread_id` regardless of names.
- Given a typo'd name within edit-distance ≤2 of the stem, Then it still clusters.
- Given an operator `thread_override` merge, Then it is sticky across daemon restart and recorded as an alias.

### Edge Cases
- A transcript file truncated/rotated mid-tail → reader recovers, no crash.
- An unknown/new tool name → `KIND_OTHER`, still shown in the ticker.
- A session ends → status `ended`, remains in its thread (history).
- Client reconnects after a gap → `resync` → fresh `snapshot`.

## Requirements *(mandatory)*

### Functional Requirements
- **FR-001**: Poll `SESSIONS_DIR/*.json` (~1–2s) → live `Session` list; status from registry + transcript mtime (`busy`/`idle`/`ended`).
- **FR-002**: Locate each session's transcript + `subagents/agent-*.jsonl`; tail append-safely by byte offset; parse `tool_use` (Edit/Write/MultiEdit/Read/Bash/Grep/Glob/Task/…) and `tool_result` into `RawLine`s.
- **FR-003**: Map every tool to a surface `kind` via `kind_for_tool` (total; unknown→`other`).
- **FR-004**: Emit `Activity` per tool action with `file_path`/`line`/`hunk_*`/`detail` as applicable; for Bash, emit a `bash` Activity then `Terminal` output (one chunk on completion baseline; chunked-live capable).
- **FR-005**: Redact every wire-bound string via `wyc.redact` (keys, tokens, passwords, private keys, conn-strings).
- **FR-006**: Stitch sessions into threads: repo container (`resolve_project`) + fuzzy name-stem (norm + edit-distance ≤2) + handoff-doc lineage (Write→Read of `*HANDOFF*`) + time-contiguity; operator merge/split/alias override sticky in `DATA_DIR`.
- **FR-007**: Serve aiohttp `/ws` (snapshot-then-stream, monotonic `seq`, `resync`) + static web; **bind 127.0.0.1**; require a local token.
- **FR-008**: Accept a PostToolUse hook (`hooks/post-tool-use.py`) that pushes enrichment events to the daemon; daemon degrades gracefully without it (transcript-tail is canonical).
- **FR-009**: `wyc.handoff.one_liner(thread_id)` returns a fresh-session continuation one-liner from thread state.
- **FR-010**: A debug UI renders the live session list + activity ticker + a terminal view, hydrating via `snapshot` then streaming.

### Key Entities
- **Session**, **Thread**, **Activity**, **Terminal**, **RawLine** — defined in `wyc/contract.py`.

## Success Criteria *(mandatory)*
- **SC-001**: With real sessions on this box, the debug UI shows them with correct project/status within ~2s of daemon start.
- **SC-002**: An edit and a Bash command in a watched session appear in the UI within ~300ms, output included; no raw secret appears.
- **SC-003**: The typo'd-handoff fixture resolves to one thread; an override survives restart.
- **SC-004**: `ci/fast.sh` green (`[ci-fast] ALL GREEN`); schema↔dataclass parity test passes.

## Assumptions
- Runs on this box with read access to `~/.claude` and `/home/user/projects/clanker/lib/projects.py`.
- Standalone auth = local token; clanker HMAC+TOTP on merge.
- Live PTY terminal streaming (clanker reuse) is W2; W1's terminal output comes from transcript `tool_result` (one chunk on completion).
