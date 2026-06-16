# Tasks: Mosaic, Menus & Mobile (W3)

**Feature Branch**: `003-mosaic-mobile`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

> **AS-BUILT — every task is `[x]` (shipped).** This is a retroactive task ledger for the implemented W3 code, grouped by capability, each task naming the concrete file/symbol that realizes it. No wire change landed in W3, so there is no contract/schema task.

## Format

`[ID] [P?] [Story] Description (→ file path)`

- **[ID]** — `T001`, `T002`, … sequential.
- **[P]** — different file, no pending dependency (would have parallelized).
- **[Story]** — `[US1]` mosaic/tiling · `[US2]` fan-out · `[US3]` palette/settings/persistence/URL · `[US4]` mobile · `[US5]` annotate-stub · `[Found]`/`[Polish]`.

---

## Phase 1: Setup (shared prerequisites)

- [x] T001 [Setup] Mosaic-local stylesheet — hand-rolled CSS grid, tile chrome, palette/settings/help, mobile `@media`; reuses `styles.css` tokens, **no `:root` duplication**, **no tiling lib** → web/mosaic.css
- [x] T002 [Setup] Two ES modules with `// @ts-check` + JSDoc, **no build step, no new deps**; `mosaic.js` imports `menu.js` → web/mosaic.js, web/menu.js

## Phase 2: Foundational (control-plane seam — BLOCKS the stories)

> The menu↔mosaic single-writer seam every story rides on. **No wire change** — consumes the existing contract only.

- [x] T003 [Found] `mountMenu(store, ctx)` control-plane skeleton + public API (`settings`, `view`, `effLayout/effMode/effDefaultView`, `setSetting/setView`, `setController`, `open/close/openSettings/openHelp`, `toast`, `annotate`, `copyHandoff`, `destroy`) — the single writer of settings + view-state → web/menu.js `mountMenu`, `api`
- [x] T004 [Found] `mountMosaic(rootEl, store)` shell (mobile nav + desktop bar + grid/rail stage + FAB) returning `{destroy()}`; instantiates the menu and registers itself as the controller via `menu.setController` (single init path) → web/mosaic.js `mountMosaic`, `controller`
- [x] T005 [Found] Effective-value overlay (`effLayout = view.layout ?? settings.layout`, `effMode`, `effDefaultView`) shared by menu + mosaic so layout/mode have **one source of truth** → web/menu.js `effLayout`, `effMode`, `effDefaultView`

**Checkpoint:** control plane wired; the capability stories build on it.

---

## Phase 3: User Story 1 — Mosaic / tiling / reflow (P1) 🎯 MVP

**Goal:** one reconciling IDE tile per active thread, busy-first, reflowing across 1/2/4/6 with an overflow rail.
**Independent test:** several real sessions → busiest threads tile; start/stop a session rebinds within a store tick; layout switch changes tracks live.

- [x] T006 [US1] Active-thread ranking — busy-first (`STATUS_RANK`) then recency; active = ≥1 busy/idle session; fallback to most-recent ≤6 when none active → web/mosaic.js `activeThreads`, `threadRecency`, `threadStatusRank`
- [x] T007 [US1] Tile model + `createTile` (chrome: status dot, title, subline/chain, controls; body: fan-out strip + pane) → web/mosaic.js `createTile`, `ctrlBtn`, `Tile` typedef
- [x] T008 [US1] Reconciling `reflow` — choose visible threads per mode, grow/shrink tile count only on slot change, `bindTile` each slot, render overflow rail, clamp focus/maximize, sync mobile → web/mosaic.js `reflow`, `bindTile`, `sigOf`
- [x] T009 [US1] **Compose the W2 IDE pane** — lazy `import('./ide.js')` (accept `default`/`mountIdePane`/`mount`); reuse via `pane.setThread` (no teardown); mount fresh only when needed → web/mosaic.js `loadIde`, `mountIde`, `ensurePaneVisible`, `teardownPane`
- [x] T010 [P] [US1] **Lightweight fallback surface** when `ide.js` is absent/throws — session name + current surface/file + busy dot + last ~12 activities (append-reconciled by `seq`) → web/mosaic.js `mountFallback`, `renderFallback`
- [x] T011 [P] [US1] Overflow "more" rail — status dot + title + project per item; click focuses the thread; visibility follows `settings.showRail` → web/mosaic.js `renderRail`, `focusThread`
- [x] T012 [US1] Auto-switch modes `focus` / `per-tile` / `manual`, with pinned/frozen tiles excluded from auto-rebind in every mode → web/mosaic.js `reflow` (per-mode branches), `cycleMode`
- [x] T013 [US1] Per-tile chrome controls (max, pin, freeze, flag, pop-out, collapse) + chrome sync (status, title, subline, chain, control on-states) → web/mosaic.js `createTile` handlers, `syncChrome`, `syncBar`
- [x] T014 [US1] Maximize/restore (one tile fills the grid, siblings hidden) + focus borders + URL mirror of focused thread → web/mosaic.js `toggleMaximizeTile`, `applyMaximize`, `reflectFocusBorders`, `focusTileN`; web/mosaic.css `.mos-grid.has-max`
- [x] T015 [US1] CSS grid layouts (`data-layout` 1/2/4/6), density (compact/cozy/roomy), accent themes, tile/rail/chrome styling → web/mosaic.css `.mos-grid[data-layout=*]`, `[data-density=*]`, `[data-accent=*]`, `.mos-tile*`, `.mos-rail*`
- [x] T016 [US1] Raw tmux-screen mirror — `client.watchScreen(sid)` (fallback `{t:'watch_screen'}`), render latest `store.screenForSession` frame ANSI-stripped, `unwatchScreen` on rebind/teardown/leave-raw; per-tile IDE↔raw toggle → web/mosaic.js `mountRawScreen`, `startWatch`, `stopWatch`, `renderScreen`, `latestScreenFrame`, `setTileView`; web/mosaic.css `.mos-screen`

**Checkpoint:** mosaic renders/reflows live; this is the shippable MVP.

---

## Phase 4: User Story 2 — Sub-agent / workflow fan-out (P1)

**Goal:** child sub-tiles per running sub-agent; auto-collapse when done.
**Independent test:** lead session with non-empty `Session.subagents` → `×N` strip + per-agent activity; drain → done-flash → collapse.

- [x] T017 [US2] Fan-out strip — one chip per `Session.subagents` id, `×count` label, latest activity per chip matched by `Activity.agent_id` → web/mosaic.js `renderFanout`, `latestSubActivity`
- [x] T018 [US2] Auto-collapse + done-flash — departed sub-agent chip marked `done` for one pass then removed; strip collapses when empty → web/mosaic.js `renderFanout` (reconcile loop)
- [x] T019 [P] [US2] Fan-out styling (collapsed state, sub-tile chips, done fade, pulse dot) → web/mosaic.css `.mos-fanout`, `.mos-subtile`, `.mos-subtile.done`

**Checkpoint:** fan-out visible and self-collapsing.

---

## Phase 5: User Story 3 — Command palette + settings + persistence + URL (P2)

**Goal:** ⌘K palette + settings panel; everything persisted to one versioned blob + shareable URL.
**Independent test:** change settings + reload → restored from `wyc.settings.v1`; deep-link `?thread=&view=&layout=&mode=` restores the view; Back/Forward replays.

- [x] T020 [US3] ⌘K/Ctrl-K fuzzy command palette — scrim/input/list DOM, subsequence matcher (contiguity + word-boundary scoring), highlight, keyboard nav (↑↓/Enter/Esc), click/hover select → web/menu.js `fuzzyMatch`, `renderList`, `hlSpans`, `markActive`, `runActiveAt`, palette DOM
- [x] T021 [US3] Command set — static (maximize, raw, 4 layouts, 3 modes, pin/freeze/flag, pop-out, copy-handoff, settings, help) **+ dynamic "Focus <thread>"** from `store.threadsList()` → web/menu.js `buildCommands`, `safeSessionsForThread`
- [x] T022 [US3] Settings panel — layout, density, mode, accent (swatches), default surface, show-terminal, redaction-indicator, overflow-rail toggles + reset; field controls + `syncSettingsUI` → web/menu.js settings-field section, `fieldRow`, `segControl`, `toggleControl`, `syncSettingsUI`
- [x] T023 [US3] **One versioned localStorage blob** `wyc.settings.v1` — debounced ~250ms write + `pagehide`/`visibilitychange:hidden` flush; **`sanitizeSettings` on load** (never trust storage) → web/menu.js `SETTINGS_KEY`, `DEFAULT_SETTINGS`, `sanitizeSettings`, `persistSettings`, `flushSettings`, `onPageHide`
- [x] T024 [US3] **URL view-state** `?thread=&view=&layout=&mode=` — debounced reflect (replace-vs-push), read-from-URL at init + `popstate` (Back/Forward) replay; normalize once via `replaceState` → web/menu.js `reflectUrl`, `readViewFromUrl`, `onPopState`, `setOrDel`
- [x] T025 [US3] Single-writer mutators + appliers — `setSetting`/`setView` notify the mosaic controller (`onSettings`/`onView`); mosaic applies (reflow + accent/density + propagate `showTerminal` to IDE panes) → web/menu.js `setSetting`, `setView`; web/mosaic.js `applySettings`, `applyView`
- [x] T026 [P] [US3] Redaction-status chip reflecting the `hello` frame's `redaction`; toggled by the setting → web/mosaic.js `updateRedactionChip`; web/mosaic.css `.mos-redaction`
- [x] T027 [P] [US3] Copy-handoff one-liner (thread title + project + session chain + status + file) to clipboard, fully local → web/menu.js `copyHandoff`
- [x] T028 [P] [US3] Palette / settings / help / toast styling → web/mosaic.css `.mos-palette*`, `.mos-settings*`, `.mos-help*`, `.mos-toast`

**Checkpoint:** palette + settings work; state persists + restores from URL.

---

## Phase 6: User Story 4 — Mobile single-pane swipe (P2)

**Goal:** `<820px` → one focused tile + prev/next + swipe + FAB.
**Independent test:** at `<820px` one tile visible; ‹/› + swipe change thread + pager; FAB fires on focused thread.

- [x] T029 [US4] Mobile single-pane logic — bind tile 0 to the mobile-selected thread, `is-mobile-active` toggling, pager `(i / N)` → web/mosaic.js `syncMobile`, `mobileStep`, `mnPrev/mnNext` handlers
- [x] T030 [US4] Horizontal swipe (≥50px, dominantly horizontal) to step threads → web/mosaic.js grid `touchstart`/`touchend` handlers
- [x] T031 [P] [US4] Mobile floating action bar (settings / pin / freeze / pop-out / raw) wired to focused-thread ops → web/mosaic.js FAB construction + handlers, `popOutFocused`, `toggleRaw`
- [x] T032 [P] [US4] Mobile `@media (max-width:820px)` — hide bar+rail, single visible tile, mobile nav, FAB, near-full-screen palette/settings → web/mosaic.css `@media (max-width: 820px)`, `.mos-mobile-nav`, `.mos-fab`

**Checkpoint:** mobile single-pane works independently.

---

## Phase 7: User Story 5 — Pin / freeze / flag (read-only stubs) (P3)

**Goal:** per-tile pin/freeze/flag emitting the `annotate` envelope — **read-only stub** (no write path in W3); no write to `~/.claude/**`.
**Independent test:** pin holds a tile's thread through reflow; freeze stops its updates + FROZEN badge; annotate is attempted with a confirming/stub toast.

- [x] T033 [US5] Pin (opt out of auto-switch) + freeze (skip refresh, FROZEN badge, cleared on rebind) + flag tile state + chrome reflection → web/mosaic.js `bindTile` (frozen clear), `onChange` (skip frozen), `syncChrome`; web/mosaic.css `.is-pinned/.is-frozen/.is-flagged`
- [x] T034 [US5] **Annotate STUB** — send `{t:'annotate', v:1, action, target:{thread_id, session_id?}}` via `client.annotate`/`client.send`; toast on success **or** stub-unavailable; **no write to `~/.claude/**`** (Principle I) → web/menu.js `annotate`; web/mosaic.js `annotate`, `annotateFocused`
- [x] T035 [P] [US5] Pop-out focused thread to a new window — clone URL with `?thread=&layout=1&view=&token=`; toast if blocked → web/mosaic.js `popOutThread`, `popOutFocused`

**Checkpoint:** all stories independently functional.

---

## Phase 8: Polish & cross-cutting

- [x] T036 [Polish] Global keybinds — `⌘K/Ctrl-K`, `f`, `1`–`9`, `[`/`]`, `r`, `?`, `Esc`; suppressed while typing in inputs/overlays → web/menu.js `onKeyDown`, `isTypingTarget`
- [x] T037 [Polish] Performance — micro-task-batched `onChange`, skip frozen tiles, re-render only visible tiles' chrome/fanout/fallback/screen (IDE panes self-update); debounced persistence/URL (Principle VII) → web/mosaic.js `onChange`
- [x] T038 [P] [Polish] Edge cases — `ide.js` absent → fallback; no active threads → recent-threads fallback + empty state; overflow → rail; no `Screen` index → waiting placeholder; reduced-motion kills pulses → web/mosaic.js (fallback/empty/rail/screen paths); web/mosaic.css `@media (prefers-reduced-motion: reduce)`
- [x] T039 [Polish] Collapse-to-rail + thread cycle/focus helpers + reset-layout (clears pin/freeze/flag/maximize) → web/mosaic.js `collapseTile`, `cycleThread`, `focusThread`, `controller.resetLayout`
- [x] T040 [Polish] Demonstrated on **real** `~/.claude` data via `python3 -u -m wyc serve` (W1+W2+W3 integrated) and `ci/fast.sh` green (Principle IX/XI).

---

## Dependencies & Execution Order

- **Phase order:** Setup → Foundational (control-plane seam) → US1 (mosaic) → US2 (fan-out) → US3 (palette/settings) → US4 (mobile) → US5 (stubs) → Polish.
- **Foundational blocks the stories:** the menu↔mosaic single-writer seam (T003–T005) underlies every capability.
- **No contract/schema task:** W3 adds **no wire change** — it only consumes existing contract symbols + envelopes (`PROTOCOL_VERSION` unchanged).
- **[P] tasks** touch a different file/region with no pending dependency (e.g. the CSS tasks T015/T019/T028/T032 vs. their JS).

## Implementation Strategy

**As-built record.** W3 shipped as one disjoint sub-agent slice (`web/mosaic.js` + `web/menu.js` + `web/mosaic.css`), integrated by the parent into the shell (`web/index.html`, `web/app.js`), re-verified live on real `~/.claude` data, and committed clean-author. No "done/green" was claimed without the matching `[ci-fast] ALL GREEN` token (Principle IX / iron-law of evidence).
