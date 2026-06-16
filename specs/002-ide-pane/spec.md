# Feature Specification: IDE Spectator Pane (W2)

**Feature Branch**: `002-ide-pane`
**Created**: 2026-06-16
**Status**: Implemented W2

One polished, read-only IDE rendered over Claude's shoulder for a single thread: a tabbed CodeMirror 6 editor that auto-follows whatever file the lead session edits (scroll-to + flash the live hunk), a file tree of every touched file, a live terminal of the shell commands Claude runs, and a flip-to-raw mirror of the actual tmux screen — proven by the pane painting live activity from a real thread with zero console errors.

> **As-built note.** This spec is written *after* the code shipped, to bring the feature into constitution compliance (Principle VIII / gate H1). It documents exactly what `web/ide.js` + `web/ide.css` do today and the server `/file` route they consume — no aspirational behavior. The wire contract was **not** changed by this wave (W1's `contracts/events.schema.json` already carries `Activity`, `Terminal`, `Screen`, and the `Session.current_file`/`tmux_*` fields the pane reads), so `PROTOCOL_VERSION` is unchanged.

## User Scenarios & Testing *(mandatory)*

> Prioritized user stories. **P1 = MVP**. Each is a vertical slice demonstrable alone against a real `~/.claude` thread.

### User Story 1 — The editor auto-follows whatever Claude edits (Priority: P1) 🎯 MVP
As a spectator, I watch a tabbed editor that **switches by itself** to whichever file the lead session edits or writes, scrolls to the changed line, and flash-highlights the live hunk — so I'm always looking at exactly what Claude is touching, like a 3rd person over its shoulder.
**Independent test**: open the pane on a real thread whose lead session is actively editing; without touching anything, the editor opens that file in a tab, jumps to the hunk line, and the line flashes — within a render tick of the `activity` arriving.
**Acceptance**:
- Given the lead session emits an `edit`/`write` `Activity` with a `file_path`, When it lands in the store ring with a `seq` past the watermark, Then the editor opens that file in a tab (flashing the tab), loads its content via `GET /file`, and the tab becomes active.
- Given the `Activity` carries a `line`, When the file is shown, Then CodeMirror scrolls that line to center and the `.cm-line` flash-highlights (~1.6s), with a thin gutter accent.
- Given the open file is edited **again**, When the new `edit` arrives, Then its cached content is force-refetched (stale cache bypassed) and re-flashed.
- Given a `.py`/`.ts`/`.rs`/etc. file, When it opens, Then the matching CodeMirror language is lazy-loaded by extension; an unknown extension opens with no language (plain), never an error.

### User Story 2 — See the file tree of everything the thread touched (Priority: P1)
As a spectator, I see a left-hand tree of every distinct file the thread (all its sessions) has touched, nested by path with a common-root fold, the current file marked, and a dot on freshly-touched files — and I can click any file to pin it open.
**Independent test**: on a real thread, the tree lists the distinct touched files; the file the editor is on is highlighted; a file edited in the last ~12s shows a bright dot that then fades; clicking a file opens it and pins (pauses auto-follow).
**Acceptance**:
- Given activities across the thread's sessions, When the pane renders, Then the tree shows each distinct `file_path` once, nested, dirs-before-files, alpha within a level, under a collapsed common root.
- Given the membership set of paths is unchanged, When the next tick renders, Then the tree DOM is **not** rebuilt (signature-gated); only the touched-dots and current marker refresh.
- Given a file was edited within ~12s, Then its row shows a bright dot; older touches fade; clicking a row opens that file and sets `pinned`.

### User Story 3 — Watch shell commands stream in a live terminal (Priority: P1)
As a spectator, when Claude runs Bash I see the **command appear** and its **output stream** into a terminal panel below the editor (ANSI-stripped, autoscrolled, with the exit code) — so I follow what Claude does on the machine, not just the files.
**Independent test**: on a real thread, a `bash` Activity shows a command block immediately; its `Terminal` chunks append into the block as they arrive; on completion the exit badge flips to `exit 0` / `exit N`.
**Acceptance**:
- Given the lead session's `terminalForSession` buffers, When the pane renders, Then each buffer reconciles to one block keyed by `ref_seq` (command line + output `<pre>`), created once and appended-to thereafter (no rebuild).
- Given new output chunks since last tick, Then only the appended chunk text is stripped of ANSI and appended; if the feed was near-bottom it stays autoscrolled.
- Given a buffer is `done`, Then the exit badge shows `exit 0`/`done` (ok) or `exit N` (bad); the command label updates if it arrived after the block.

### User Story 4 — Flip a tile to the raw tmux screen (Priority: P2)
As a spectator, I press **raw screen** and the pane flips to a full-bleed mirror of the lead session's actual tmux TUI (ANSI→HTML), then flip back to the IDE — so I can see literally what's on Claude's terminal.
**Independent test**: with a client that supports screen watching, toggling raw starts a `watch_screen`, paints incoming `Screen` frames as colored text with the pane dims, and toggling off (or `destroy`) sends `unwatch_screen`.
**Acceptance**:
- Given the resolved client exposes `watchScreen`, When raw is toggled on, Then the pane calls `client.watchScreen(leadSessionId)` and paints `store.screenForSession(lead)` frames via the SGR→HTML renderer; new frames repaint only on a changed `seq`.
- Given the client lacks `watchScreen`, Then the raw-screen button is hidden and any active raw view exits — the pane degrades, never errors.
- Given the lead session changes (handoff) while raw is on, Then the watch re-points to the new lead (`unwatch` old → `watch` new).

### User Story 5 — Thread-follow survives handoffs (Priority: P2)
As an operator who leapfrogs sessions, I keep watching the **same thread** — when the lead session changes, the editor/terminal/status/screen all re-point to the new lead automatically without my reopening anything.
**Independent test**: on a thread whose `lead_session_id` advances to a new session, the pane keeps the same thread but switches the terminal feed, status line, and (if active) screen watch to the new lead.
**Acceptance**:
- Given `Thread.lead_session_id` changes, When the pane renders, Then the terminal feed resets to the new lead's buffers and the screen watch re-syncs; the file tree (thread-wide) and tabs persist.
- Given a thread has no explicit lead, Then the newest session in `session_ids` is used as the lead.

### Edge Cases
- **CodeMirror CDN unreachable** (offline / esm.sh down) → the dynamic import rejects once; `cmFailed` latches and every file renders in a highlighted line-numbered `<pre>` fallback with an "editor offline" note — the editor is never blank.
- **`GET /file` 404 / non-OK** → fall back to `reconstructFromHunks(path)` (stitch the latest observed `hunk_new` for that path across the thread, framed honestly as a reconstructed/partial hunk); if no hunk is known, show a placeholder comment with the path. Never blank, never a crash.
- **Idle session with no `current_file`** → status reads "Claude is idle"; the empty-editor placeholder ("the editor follows what Claude edits") stays until the first edit.
- **No live session in the thread** (all ended) → status dot `ended`, "no live session in this thread"; raw button hidden.
- **Unknown file extension** → no CodeMirror language loaded (plain highlight), tree/tab icon is the generic glyph — still shown, never an error.
- **Tab cap exceeded** (> ~8) → the oldest non-active tab is evicted silently.

## Requirements *(mandatory)*

### Functional Requirements

> Documents `web/ide.js` (+ `web/ide.css`) as shipped, and the `wyc/server.py` `/file` route it consumes. No wire change this wave; the pane reads existing contract symbols (`Activity`, `Terminal`, `Screen`, `Session`, `Thread`).

- **FR-001**: The pane MUST expose `mountIdePane(el, store, { threadId, getToken })` returning `{ setThread(id), destroy() }`; `default` export is `mountIdePane`. `setThread` re-targets and resets all per-thread view state; `destroy` unsubscribes, tears down CodeMirror, and unwatches any active screen.
- **FR-002**: The pane MUST build its DOM **once** (tree | editor-over-terminal | status, plus a hidden raw-screen overlay), subscribe to the store **once**, and on each tick update only the surface that changed — no full DOM rebuild per tick (Principle VII / O(1)-per-tick render).
- **FR-003**: The editor MUST be a read-only CodeMirror 6 instance — `EditorView.editable.of(false)` **and** `EditorState.readOnly.of(true)` (Principle I, observer-never-actor: the pane has no write path to source files).
- **FR-004**: CodeMirror 6 MUST be dynamically imported from the `esm.sh` CDN (pinned versions; shared `@codemirror/state`+`view`+`language` kept un-bundled via `external=` so packages share one core copy). Language packages MUST be lazy-imported per file extension and cached.
- **FR-005**: If any CodeMirror dynamic import rejects, the pane MUST latch a failed state and render every file via a highlighted, line-numbered `<pre>` fallback (with a focus-line flash) — the editor surface is never blank (graceful CDN-down degradation).
- **FR-006**: On each tick the pane MUST auto-switch the editor to the lead session's newest unreacted `edit`/`write` `Activity` with a `file_path`, advancing a `seq` watermark so each new edit fires exactly once; it MUST scroll the `Activity.line` to center and flash the hunk line. A new edit to an already-open file MUST force-refetch its content.
- **FR-007**: Manual tab/tree selection MUST pin the chosen file (pausing auto-follow); the pin MUST yield back to auto-follow the next time the lead session edits a file.
- **FR-008**: The pane MUST keep a tab bar capped at ~8 tabs (`MAX_TABS`), evicting the oldest non-active tab; tabs show a language icon, basename, parent-dir hint, a pin glyph when pinned, and a close affordance.
- **FR-009**: The file tree MUST list every distinct `file_path` touched across **all** the thread's sessions (`activitiesForThread`), nested by path under a folded common root, dirs-before-files alpha-sorted, collapsible. Rebuild MUST be membership-signature-gated; touched-dots (bright < ~12s, then faded) and the current-file marker refresh without a rebuild.
- **FR-010**: File content MUST be fetched via `GET /file?path=<abs>&token=<t>` returning `{path, content, lines, redacted, truncated}`; results MUST be cached per path and de-duped while in flight; a re-edit force-bypasses the cache.
- **FR-011**: The per-file meta strip MUST surface `reconstructed` / `redacted` / `truncated` badges from the `/file` response (or reconstruction), so the spectator always knows the provenance of what they see.
- **FR-012**: On a `/file` fetch failure the pane MUST reconstruct a placeholder from the latest observed `hunk_new` for that path across the thread (`reconstructFromHunks`), honestly framed (edits marked as a partial hunk); absent any hunk, a path-stamped placeholder comment. Never blank, never throw.
- **FR-013**: The terminal panel MUST render `store.terminalForSession(leadSessionId)`: one block per `ref_seq` (created once, appended thereafter), incrementally appending only new chunks (ANSI-stripped) and autoscrolling when near-bottom; on `done` it MUST show the exit code (`exit 0`/`done` vs `exit N`). On a lead change the feed MUST reset.
- **FR-014**: The status line MUST render the lead `Session`: a busy/idle/ended dot, "Claude is `<current_surface>` `<basename(current_file)>`", and badges for `model`, sub-agent count (`subagents.length`), and tmux identity (`tmux_session` · `tmux_group` `[tmux_pane]`), hiding any badge whose value is absent.
- **FR-015**: A raw-screen toggle MUST flip the pane to a full-bleed tmux mirror: call `client.watchScreen(leadSessionId)` on, paint `store.screenForSession(lead)` frames via an SGR→HTML renderer (16-color + bold/italic/underline/reverse; unknown sequences dropped, never echoed), repainting only on a changed frame `seq`, and call `client.unwatchScreen(...)` on toggle-off / lead-change / `destroy`. The toggle MUST be hidden if the client can't watch screens.
- **FR-016**: The pane MUST resolve the client tolerantly — `store.client` (property or function) else `window.wyc.client` — and degrade fully if absent (no raw screen, no crash).
- **FR-017**: Every value the editor renders MUST already be redacted: the server's `/file` route applies `wyc.redact` before content leaves the process and reports `redacted:true`; terminal/screen data arrive pre-redacted on the wire (Principle II). The pane adds no path that exposes an unredacted source value.
- **FR-018**: The pane MUST hold no write path to `~/.claude/**` or any observed repo (Principle I); it is purely a reader of the store + the read-only, root-jailed `/file` route.

### Key Entities
- **Activity** — `#/$defs/Activity` in `contracts/events.schema.json` (`kind`, `tool`, `file_path`, `line`, `hunk_old`, `hunk_new`, `detail`, `seq`, `ts`). Drives auto-switch, the tree, and hunk reconstruction.
- **Terminal** — `#/$defs/Terminal` (`ref_seq`, `data`, `done`, `exit_code`, `stream`). Drives the terminal blocks (read via `store.terminalForSession`).
- **Screen** — `#/$defs/Screen` (`data`, `cols`, `rows`, `seq`). Drives the raw mirror (read via `store.screenForSession`).
- **Session** — `#/$defs/Session` (`current_surface`, `current_file`, `subagents`, `model`, `tmux_session`/`tmux_group`/`tmux_pane`, `status`). Drives the status line + lead resolution.
- **Thread** — `#/$defs/Thread` (`session_ids`, `lead_session_id`). The pane renders exactly one thread; lead changes drive handoff-follow.

*(No new entities; no contract change this wave.)*

## Success Criteria *(mandatory)*
- **SC-001**: On a real thread, the pane paints (tree + editor frame + terminal + status) with **0 console errors** and re-renders only changed surfaces per tick.
- **SC-002**: When the lead session edits a file, the editor switches to it, scrolls to the hunk line, and flashes — within a render tick of the `activity` arriving. *(Headless caveat: SC-002 is a UI assertion; in a no-CDN/headless environment CodeMirror falls back to the `<pre>` view, and the auto-switch + scroll-to + flash behavior is still observable there.)*
- **SC-003**: A `bash` command shows immediately and its output streams into the correct block with the right exit code; no raw secret appears (content/terminal/screen are redacted upstream).
- **SC-004**: With the CDN blocked, the editor renders the `<pre>` fallback (never blank); with `/file` 404, the pane shows a reconstructed/placeholder doc — neither path throws.
- **SC-005**: Toggling raw screen on a screen-capable client paints the tmux mirror and cleanly unwatches on exit / `destroy`; with an incapable client the toggle is absent.
- **SC-006**: `ci/fast.sh` green (`[ci-fast] ALL GREEN`); the schema↔dataclass parity test passes (this wave introduced no wire change).

## Assumptions
- Runs in the loopback web UI on this box; `store.js` (the only state seam) and `client.js` are already wired by the W1 shell, and the W1 feed is verified live (the gate to open W2).
- The editor depends on reachable `esm.sh` for CodeMirror; the `<pre>` fallback covers offline/headless. This is the one external runtime dependency (see plan Complexity Tracking).
- `GET /file` is provided by `wyc/server.py` (root-jailed to an allowlist of realpath roots, head-capped ~2 MB → `truncated`, redacted) — the pane consumes it but does not own it (parent-only server file).
- Raw-screen frames come from the W1.5 tmux source via `client.watchScreen` + `store.screenForSession`; absent that capability the pane simply hides the toggle.
- The pane renders exactly one thread; multi-pane tiling/mosaic composition is W3 (`003-mosaic-mobile`), which consumes this pane's public API.
