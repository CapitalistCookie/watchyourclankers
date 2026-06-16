# Tasks: IDE Spectator Pane (W2)

**Feature Branch**: `002-ide-pane`
**Spec**: [specs/002-ide-pane/spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

> **As-built.** This is the task list reconstructed from the shipped code (`web/ide.js`, `web/ide.css`, and the consumed `wyc/server.py` `/file` route). **All tasks are checked `[x]`** — the feature is Implemented (W2). It is recorded retroactively to bring the pane onto the spec spine (Principle VIII / gate H1).

## Format

`[ID] [P?] [Story] Description (→ file path)`

- **[ID]** — `T001`… sequential. **[P]** — was parallelizable (different file / no pending dep). **[Story]** — `[US1]`…`[US5]` / `[Setup]` / `[Found]` / `[Polish]`.

---

## Phase 1: Setup (shared prerequisites)

- [x] T001 [Setup] Pane skeleton + no-build ES-module entry; pin CodeMirror 6 CDN versions and the `external=` shared-core strategy; `EXT_LANG` extension→language map; tiny DOM/ANSI/HTML helpers → web/ide.js
- [x] T002 [P] [Setup] Pane stylesheet reusing the `styles.css` palette custom-properties (grid shell: tree | editor-over-terminal | status; tabs, terminal, raw-screen overlay, ANSI color spans, responsive collapse) → web/ide.css

## Phase 2: Foundational (BLOCKS all user stories)

> No wire change this wave — the pane reads existing contract symbols. Foundation = the public mount API, the one-subscription render loop, and the lazy read-only editor.

- [x] T003 [Found] `mountIdePane(el, store, { threadId, getToken })` building the DOM **once** (tree/editor/terminal/status panes + hidden raw-screen overlay) and returning `{ setThread, destroy }`; `default` export → web/ide.js
- [x] T004 [Found] Single store subscription + `render()` dispatcher where each surface self-decides what changed (no per-tick rebuild); `setThread` resets per-thread state; `destroy` unsubscribes + tears down (Principle VII) → web/ide.js
- [x] T005 [Found] Lazy `ensureEditor()` — dynamic-import CodeMirror, build a **read-only** view (`editable.of(false)` + `readOnly.of(true)`, Principle I), language `Compartment`, base extensions + theme → web/ide.js
- [x] T006 [Found] Thread helpers: `currentThread`/`leadSessionId` (with newest-session fallback)/`leadSession`/`activitiesForThread` (aggregate all the thread's sessions, seq-sorted) → web/ide.js

**Checkpoint:** foundation ready — user-story surfaces build on the mount + render loop.

---

## Phase 3: User Story 1 — Editor auto-follows whatever Claude edits (P1) 🎯 MVP

**Goal:** the editor switches itself to the file Claude edits, scrolls to + flashes the hunk.
**Independent test:** open on a live thread; the editor opens the edited file, jumps to the hunk line, and flashes — untouched.

- [x] T007 [US1] `langExtFor(path)` — lazy per-extension CodeMirror language import + cache; unknown extension → no language (plain), never error → web/ide.js
- [x] T008 [US1] `showFileInEditor(path, content, focusLine, hunkNew)` — fetch-token-guarded doc/language reset on the read-only view → web/ide.js
- [x] T009 [US1] `flashAndScrollCm(line, hunkNew)` — scroll the line to center + transient `.wyc-hunk-flash`/`.wyc-hunk-line` decoration on the rendered `.cm-line` (honest hunk flourish, no fabricated keystrokes) → web/ide.js, web/ide.css
- [x] T010 [US1] `handleAutoSwitch()` — react to the lead session's newest unreacted `edit`/`write` Activity via a `seq` watermark (fires once per new edit); force-refetch on re-edit of an open file → web/ide.js
- [x] T011 [US1] CDN-down resilience: `cmFailed` latch + `renderFallback()` highlighted line-numbered `<pre>` with focus-line flash (editor never blank) → web/ide.js, web/ide.css

**Checkpoint:** US1 demonstrable end-to-end on real data. **This is the shippable MVP.**

---

## Phase 4: User Story 2 — File tree of everything the thread touched (P1)

**Goal:** left tree of distinct touched files, nested, current marked, fresh-dot, click-to-pin.
**Independent test:** tree lists distinct files; current highlighted; recent edit dots then fades; click opens + pins.

- [x] T012 [US2] `renderTree()` — distinct `file_path` set across the thread, membership-signature-gated rebuild; refresh touched-dots (bright < ~12s then fade) + current marker without rebuild → web/ide.js
- [x] T013 [US2] `buildTreeDom`/`renderTreeLevel`/`commonPrefix` — nested tree under a folded common root, dirs-before-files alpha, collapsible dirs, per-file row reuse; click a file → pin + open → web/ide.js
- [x] T014 [P] [US2] Tree styling: dir/file rows, current highlight, fresh-touch dot + fade, twist/collapse → web/ide.css

**Checkpoint:** US1 + US2 work independently.

---

## Phase 5: User Story 3 — Live terminal of Claude's shell (P1)

**Goal:** command appears + output streams into a terminal panel with exit code.
**Independent test:** a `bash` Activity shows a block immediately; `Terminal` chunks append; exit badge flips on `done`.

- [x] T015 [US3] `renderTerminal()` — reconcile `store.terminalForSession(lead)` to one block per `ref_seq` (created once), append only new ANSI-stripped chunks, autoscroll when near-bottom, exit badge on `done`; reset feed on lead change → web/ide.js
- [x] T016 [P] [US3] Terminal styling: command block, sticky `$` prompt, output `<pre>`, exit `run`/`ok`/`bad` badges, flash-in → web/ide.css

**Checkpoint:** US1 + US2 + US3 work independently.

---

## Phase 6: User Story 4 — Flip a tile to the raw tmux screen (P2)

**Goal:** toggle to a full-bleed ANSI→HTML mirror of the lead session's tmux pane.
**Independent test:** with a screen-capable client, toggle starts `watch_screen`, paints `Screen` frames, exit `unwatch`es.

- [x] T017 [US4] `ansiToHtml`/`applySgr` — conservative SGR→HTML (16-color + bold/italic/underline/reverse; unknown CSI/OSC dropped, never echoed) → web/ide.js
- [x] T018 [US4] `toggleRaw`/`syncScreenWatch`/`renderScreen` — `client.watchScreen(lead)` on, repaint `store.screenForSession(lead)` only on changed frame `seq`, re-point on lead change, `unwatchScreen` on off/`destroy`; hide the toggle if the client can't watch → web/ide.js
- [x] T019 [P] [US4] Raw-screen overlay + ANSI palette styling + `.ide.raw` toggle state + status-line `raw screen` button → web/ide.css

**Checkpoint:** US1–US4 work independently.

---

## Phase 7: User Story 5 — Thread-follow survives handoffs (P2)

**Goal:** when the lead session changes, every surface re-points without reopening.
**Independent test:** advance `lead_session_id`; terminal feed + status + (active) screen watch switch to the new lead; tree/tabs persist.

- [x] T020 [US5] `render()` detects a `leadSessionId` change → keep the thread, re-sync the screen watch; `renderTerminal` resets to the new lead's buffers; status follows the new lead → web/ide.js
- [x] T021 [US5] `renderStatus()` — busy/idle/ended dot, "Claude is `<surface>` `<file>`", `model`/sub-agent-count/tmux badges (hidden when absent); hide raw button when the client can't watch → web/ide.js, web/ide.css

**Checkpoint:** all stories independently functional.

---

## Phase 8: /file integration & provenance

> The read-only content source the editor consumes (route is parent-only; the pane integrates against it).

- [x] T022 [Found] Consume `GET /file?path=&token=` → `{path, content, lines, redacted, truncated}` with per-path cache + in-flight de-dup; `fetchFile(force)` bypasses cache on re-edit → web/ide.js
- [x] T023 [US1] `reconstructFromHunks(path)` 404/error fallback — stitch latest observed `hunk_new` across the thread (edits framed as partial), else a path-stamped placeholder; never blank → web/ide.js
- [x] T024 [P] [Polish] `updateEditorMeta` provenance badges (`reconstructed`/`redacted`/`truncated`) + styling (Principle II transparency) → web/ide.js, web/ide.css
- [x] T025 [Found] (parent-only) `/file` route: realpath root-jail to an allowlist, readable-regular-file only, `wyc.redact` on content, ~2 MB head cap → `truncated` → wyc/server.py

## Phase 9: Polish & cross-cutting

- [x] T026 [P] [Polish] Tab bar: cap ~8 with oldest-non-active eviction, language icon + dir hint + pin glyph + close; manual select pins (auto-follow pauses, yields on next edit) → web/ide.js, web/ide.css
- [x] T027 [P] [Polish] Edge cases — CDN unreachable → `<pre>` fallback; `/file` 404 → reconstruct/placeholder; idle/no-current-file; no live session in thread; unknown extension → plain (Principle IV) → web/ide.js
- [x] T028 [Polish] Tolerant client resolution (`store.client` property/function else `window.wyc.client`) + full degrade when absent; responsive single-column collapse < 820px → web/ide.js, web/ide.css
- [x] T029 [Polish] Demonstrated on **real** `~/.claude` data (editor follows live edits, terminal streams real Bash, status/tmux badges live) + `ci/fast.sh` `[ci-fast] ALL GREEN` (no wire change; parity test passes) (Principle IX/XI)

---

## Dependencies & Execution Order

- **Phase order:** Setup → Foundational → (US1 → US2 → US3 → US4 → US5 by priority) → /file integration → Polish.
- **Foundational (mount + render loop + lazy editor + thread helpers) blocked every surface.**
- **User-story independence:** US2/US3/US4/US5 each build on the render loop but stand alone for demonstration; US1 (auto-follow editor) is the MVP and the `/file` + reconstruct path (Phase 8) is what makes it real.
- **[P] tasks** touched a different file (mostly `web/ide.css`) with no pending dep. `wyc/server.py` (T025) is **parent-only** (server seam) — integrated by the parent, never the IDE sub-agent.

## Implementation Strategy

Shipped as one disjoint sub-agent slice on `web/ide.js` (+ `web/ide.css`); the parent wired the `store`/`client` seams and the parent-only `/file` route, integrated, and re-verified live on real `~/.claude` data. MVP = Phase 1–3 + Phase 8 (editor auto-follows real edits). No "done/green" claim without the matching `[ci-fast] ALL GREEN` token in the same message (Principle IX / iron-law of evidence).
