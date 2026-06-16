# Feature Specification: Mosaic, Menus & Mobile (W3)

**Feature Branch**: `003-mosaic-mobile`
**Created**: 2026-06-16
**Status**: Implemented (W3) — AS-BUILT

> This spec is written **after** the code shipped, to bring W3 under the Spec Spine (Principle VIII) and satisfy gate H1. It documents the behavior of `web/mosaic.js`, `web/menu.js`, and `web/mosaic.css` as they exist — not a forward design. Every FR is traceable to that code.

Turn the single W2 IDE-spectator pane into a **dynamic tiling mosaic**: one tile per active thread, reflowing as threads appear/disappear, with sub-agent fan-out, a ⌘K command palette + settings panel (persisted), and a `<820px` swipeable mobile layout. The observable proof: open the UI with several live Claude sessions and watch them tile, fan out their sub-agents, and survive a layout/mode change + page reload with state intact.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Watch many threads tile in a live mosaic (Priority: P1) 🎯 MVP
As a spectator, I open the UI and see one **IDE tile per active thread**, busy threads first, in a 1 / 2 / 4 / 6-up grid that **reflows automatically** as threads start, go idle, or end — overflow folds into a "more" rail.
**Independent test**: with several real sessions running, the mosaic shows the busiest threads in tiles; start/stop a session and the grid rebinds within one store tick (no full teardown); switch 2-up→4-up and the tracks change live.
**Acceptance**:
- Given N active threads and a 2-up layout, When the page loads, Then tiles 0–1 hold the two busiest-then-most-recent threads and the rest go to the "more" rail.
- Given a thread's lead session goes `busy`, When the store updates, Then that thread is ranked ahead of idle threads and (in focus mode) bound toward tile 0 — by reconcile (`pane.setThread`), not by tearing the tile down.
- Given `web/ide.js` is unavailable at runtime, When a tile binds a thread, Then the tile degrades to a lightweight fallback surface (session name + current surface/file + busy dot + last ~12 activities) so the mosaic still works standalone.

### User Story 2 — Sub-agent / workflow fan-out shows as child sub-tiles (Priority: P1)
As a spectator, when a tile's lead session spawns sub-agents (a `Task`/workflow fan-out), I see a **collapsible strip of child sub-tiles** above that tile's pane, each showing the sub-agent's latest activity, and the strip **auto-collapses when the sub-agents finish**.
**Independent test**: a watched session with non-empty `Session.subagents` renders the fan-out strip with one chip per id; when the sub-agents drain, the strip flashes "done" once then collapses.
**Acceptance**:
- Given a lead session with `subagents = [a, b]`, When the tile renders, Then the fan-out strip shows `×2` and a chip per sub-agent id with its most-recent activity detail.
- Given a sub-agent id disappears from `subagents`, When the next store tick lands, Then its chip is marked `done` (faded) for one pass, then removed; when none remain the strip collapses.

### User Story 3 — Command palette + settings, fully persisted (Priority: P2)
As a power spectator, I press **⌘K / Ctrl-K** for a fuzzy command palette (layout, auto-switch mode, pin/freeze/flag, focus-a-thread-by-name, copy-handoff, settings, help) and open a **settings panel** (layout, density, mode, accent, terminal, redaction indicator, rail, reset) — and everything I choose **survives a reload** and is **shareable via the URL**.
**Independent test**: change layout + accent + mode, reload — the choices restore from `localStorage` key `wyc.settings.v1`; open a deep link with `?thread=&view=&layout=&mode=` and the mosaic restores that view; Back/Forward replays it.
**Acceptance**:
- Given I change any setting, When ~250ms pass (or the page hides), Then a single versioned blob is written to `localStorage["wyc.settings.v1"]`; a malformed stored blob is sanitized back to defaults on next load (never trusted).
- Given I focus a thread / set view / layout / mode, When the change applies, Then the URL query is updated (`?thread=&view=&layout=&mode=`) and `popstate` (Back/Forward) re-applies it.
- Given any value reaches the browser, Then it has already passed through `wyc.redact` server-side before the wire (Principle II); the mosaic renders only already-redacted strings and shows a redaction-status chip from the `hello` frame.

### User Story 4 — Mobile single-pane swipe (Priority: P2)
As a spectator on a phone (`<820px`), the mosaic collapses to **one focused tile** with a prev/next thread switcher, **swipe** to change thread, and a **floating action bar** (settings / pin / freeze / pop-out / raw-screen).
**Independent test**: at `<820px` only one tile is visible; tapping ‹ / › or swiping horizontally changes the bound thread and updates the pager `(i / N)`; the FAB actions fire against the focused thread.
**Acceptance**:
- Given a viewport `<820px`, When the page renders, Then the desktop control bar and overflow rail are hidden, exactly one tile (`is-mobile-active`) shows, and the mobile nav + FAB appear.
- Given a horizontal swipe ≥50px (and dominantly horizontal), When it ends, Then the next/previous active thread is bound to the single tile and the pager updates.

### User Story 5 — Pin / freeze / flag per tile (read-only stubs) (Priority: P3)
As a spectator, I can **pin** (opt a tile out of auto-switch), **freeze** (stop a tile updating — snapshot intent), and **flag** a tile; these emit an `annotate` envelope over the client but are **read-only stubs for now** (no write path lands in W3, per project intent).
**Independent test**: pin a tile — it keeps its thread through reflows and shows the pinned border; freeze — it stops live-updating and shows the FROZEN badge; the annotate send is attempted and a toast confirms (or reports the stub when no write path exists).
**Acceptance**:
- Given I pin a tile, When reflow runs, Then that tile holds its bound thread and is excluded from auto-rebind (its content is not clobbered).
- Given I freeze a tile, When the store updates, Then that tile is skipped in the live refresh loop and shows the FROZEN affordance; re-binding a thread clears the frozen intent.
- Given I pin/freeze/flag, Then an `{t:'annotate', v:1, action, target:{thread_id, session_id?}}` is sent via the client; if no write path is available the UI toasts that it is a stub — and **no write targets `~/.claude/**` or any observed repo** (Principle I).

### Edge Cases
- `web/ide.js` absent / throws on mount → tile paints the lightweight fallback surface immediately and stays on it (optimistic-fallback-then-upgrade; upgrade is skipped/reverted on error).
- No active threads → `activeThreads()` falls back to the most-recent up-to-6 threads; if still none, tiles show the "no active thread" empty state.
- More active threads than tiles → the surplus folds into the "more" rail (`+N`); clicking a rail item focuses that thread into a tile.
- Unknown / new surface kind on a session → rendered as-is from `current_surface` (string), never crashes (total-coverage upstream maps unknown→`other`).
- Store does not yet index `Screen` frames for a session → the raw-screen mirror shows a "watching … (no frames yet)" placeholder and lights up when `store.screenForSession` returns a frame (forward-compat probe).
- Client reconnects after a gap → handled by `client.js`/`store.js` (`resync` → fresh `snapshot`, Principle VI); the mosaic re-renders from the rehydrated store on the next `subscribe` tick.
- Pop-out blocked by the browser → a toast reports it; the pop-out URL carries `?thread=&layout=1&view=&token=` so the cloned window authenticates the same way.

## Requirements *(mandatory)*

### Functional Requirements

> W3 adds **no wire change** — `mosaic.js`/`menu.js` only *consume* the existing contract (`Session`, `Thread`, `Activity`, `Screen`, the `annotate` / `watch_screen` / `unwatch_screen` envelopes already in `contracts/events.schema.json` at `PROTOCOL_VERSION = 1`). `PROTOCOL_VERSION` is unchanged; no edit to `wyc/contract.py` or the schema (Principle III satisfied vacuously).

**Mosaic / tiling / reflow**
- **FR-001**: `mountMosaic(rootEl, store)` MUST build the mosaic shell (mobile nav, desktop control bar, grid + "more" rail stage, mobile FAB) and return `{ destroy() }` that unsubscribes, tears down every tile pane + screen watch, destroys the menu, and clears the root. *(web/mosaic.js `mountMosaic`)*
- **FR-002**: The mosaic MUST render **one tile per active thread**, ranked busy-first (`STATUS_RANK`) then by recency, into a grid of `layout ∈ {1,2,4,6}` slots; active = thread with ≥1 `busy`/`idle` session, with a fallback to the most-recent ≤6 threads when none are active. *(web/mosaic.js `activeThreads`, `reflow`)*
- **FR-003**: Reflow MUST be **reconciling** — tiles are reused and rebound via `bindTile`/`pane.setThread` (created/destroyed only when the slot count changes), so live updates do not tear down editors (Principle VII). *(web/mosaic.js `reflow`, `bindTile`, `mountIde`)*
- **FR-004**: Each tile MUST **compose the W2 IDE pane** by lazily importing `web/ide.js` and calling `mountIdePane(paneEl, store, { threadId, getToken })` (accepting `default` / `mountIdePane` / `mount`); if `ide.js` is unavailable or throws, the tile MUST degrade to a lightweight fallback surface and keep working standalone. *(web/mosaic.js `loadIde`, `mountIde`, `mountFallback`, `renderFallback`)*
- **FR-005**: Overflow active threads not shown in a tile MUST render in the "more" rail with status dot + title + project, and clicking a rail item MUST focus that thread into a tile; the rail visibility follows `settings.showRail`. *(web/mosaic.js `renderRail`, `focusThread`)*
- **FR-006**: Auto-switch MUST support three modes — `focus` (focus-follows-latest, default; most-recent active toward tile 0), `per-tile` (a tile keeps its thread while active, else rebinds), and `manual` (no auto-rebind; only fill empties) — and pinned/frozen tiles MUST be excluded from auto-rebind in every mode. *(web/mosaic.js `reflow`, `menu.effMode`)*
- **FR-007**: Per-tile controls MUST include maximize/restore, pin, freeze, flag, pop-out, collapse-to-rail, and an **IDE↔raw-screen** toggle; maximize MUST expand one tile to the full grid and hide siblings. *(web/mosaic.js `createTile`, `toggleMaximizeTile`, `applyMaximize`, `setTileView`)*
- **FR-008**: A tile in **raw** view MUST request the lead session's raw tmux screen via `client.watchScreen(sid)` (falling back to a raw `{t:'watch_screen', session_id}` send), render the latest `Screen` frame from `store.screenForSession(sid)` (ANSI-stripped), and `unwatchScreen` on rebind/teardown/leaving raw. *(web/mosaic.js `mountRawScreen`, `startWatch`, `stopWatch`, `renderScreen`, `latestScreenFrame`)*

**Fan-out**
- **FR-009**: When a tile's lead session has non-empty `Session.subagents`, the mosaic MUST render a collapsible fan-out strip of child sub-tiles (one chip per sub-agent id, `×count` label), each showing that sub-agent's most-recent activity (matched by `Activity.agent_id`). *(web/mosaic.js `renderFanout`, `latestSubActivity`)*
- **FR-010**: The fan-out strip MUST **auto-collapse when no sub-agents remain**, marking a departed sub-agent's chip `done` (faded) for one pass before removing it (a brief done-flash). *(web/mosaic.js `renderFanout`)*

**Command palette / settings / persistence / URL**
- **FR-011**: `mountMenu(store, ctx)` MUST own the control plane — a **⌘K/Ctrl-K fuzzy command palette**, a settings panel, global keybinds, the persisted settings blob, and URL view-state — and expose a single-writer API (`setSetting`, `setView`, `settings`, `view`, `effLayout/effMode/effDefaultView`, `annotate`, `copyHandoff`, `setController`, `open/close/openSettings/openHelp`, `toast`, `destroy`). *(web/menu.js `mountMenu`, `api`)*
- **FR-012**: The palette MUST list static commands (maximize, raw-toggle, the four layouts, the three modes, pin/freeze/flag, pop-out, copy-handoff, settings, help) **plus dynamic "Focus <thread>" entries** built from `store.threadsList()`, filtered by a subsequence fuzzy matcher with contiguity + word-boundary scoring and match highlighting. *(web/menu.js `buildCommands`, `fuzzyMatch`, `renderList`, `hlSpans`)*
- **FR-013**: The settings panel MUST expose: layout (1/2/4/6), density (compact/cozy/roomy), auto-switch mode, accent (cyan/purple/green/amber), default surface (ide/raw), show-terminal toggle, redaction-indicator toggle, overflow-rail toggle, and a **reset layout & settings** action. *(web/menu.js settings-field section, `syncSettingsUI`)*
- **FR-014**: All settings MUST persist as **one versioned blob** at `localStorage["wyc.settings.v1"]`, written **debounced ~250ms** and on `pagehide` / `visibilitychange:hidden`; on load the blob MUST be **sanitized** field-by-field against allowed values (never trust storage). *(web/menu.js `SETTINGS_KEY`, `persistSettings`, `flushSettings`, `sanitizeSettings`)*
- **FR-015**: View-state MUST mirror to the **URL query** `?thread=&view=&layout=&mode=` (debounced, replace-vs-push aware) and `popstate` (Back/Forward) MUST re-apply it; the URL is normalized once at init via `replaceState`. *(web/menu.js `reflectUrl`, `readViewFromUrl`, `onPopState`, `setView`)*
- **FR-016**: Effective layout/mode MUST overlay session URL view-state over persisted settings (`effLayout = view.layout ?? settings.layout`, `effMode = view.mode ?? settings.mode`); the mosaic and menu MUST share these getters so there is **one source of truth**. *(web/menu.js `effLayout`, `effMode`, `effDefaultView`)*

**Keybinds**
- **FR-017**: Global keybinds MUST be: `⌘K/Ctrl-K` toggle palette (even from inputs), `f` maximize, `1`–`9` focus tile N, `[`/`]` cycle focused thread prev/next, `r` toggle IDE↔raw, `?` help, `Esc` close any overlay; bare keys MUST be suppressed while typing in an input/overlay. *(web/menu.js `onKeyDown`, `isTypingTarget`)*

**Mobile**
- **FR-018**: At `<820px` the layout MUST collapse to a **single focused tile** (`is-mobile-active`) with a prev/next thread nav + pager, a **horizontal swipe** (≥50px, dominantly horizontal) to step threads, and a **floating action bar** (settings / pin / freeze / pop-out / raw); the desktop bar and rail MUST be hidden. *(web/mosaic.js `syncMobile`, `mobileStep`, touch handlers, mobile FAB; web/mosaic.css `@media (max-width: 820px)`)*

**Annotate stub**
- **FR-019**: Pin/freeze/flag MUST send `{t:'annotate', v:1, action, target:{thread_id, session_id?}}` via `client.annotate`/`client.send`; this is a **read-only STUB** in W3 (the server-side write path lands later) and the UI MUST surface a toast either way — and there MUST be **no write path to `~/.claude/**` or any observed repo** (Principle I). *(web/menu.js `annotate`; web/mosaic.js `annotate`, `annotateFocused`; the `annotate` envelope in contracts/events.schema.json)*

**Performance / wire safety**
- **FR-020**: Store-driven refresh MUST be **micro-task batched** (one pass per cluster of changes), MUST skip frozen tiles, and MUST only re-render visible tiles' chrome/fanout/fallback/screen — the composed IDE panes self-update from the store (Principle VII). Every rendered string is already `wyc.redact`-clean from the server; the mosaic adds no new wire-bound value (Principle II). *(web/mosaic.js `onChange`)*

### Key Entities
- **Session** — `wyc/contract.py` dataclass; the mosaic reads `status`, `project`, `current_surface`, `current_file`, `name`, and `subagents` (the fan-out source). No new fields.
- **Thread** — `wyc/contract.py` dataclass; read via `store.thread/threadsList/sessionsForThread`; `lead_session_id` selects the tile's lead session. No new fields.
- **Activity** — `wyc/contract.py` dataclass; read from `store.activitiesForSession` for the fallback ticker and fan-out detail; `agent_id` attributes an activity to a sub-agent.
- **Screen** — `wyc/contract.py` dataclass; latest raw tmux frame per session via `store.screenForSession`; consumed by the raw-screen mirror.
- **Settings blob (`wyc.settings.v1`)** — new **client-only** persisted shape (localStorage), defined by `DEFAULT_SETTINGS` + `sanitizeSettings` in `web/menu.js`. Not a wire entity; never leaves the browser.
- **View-state** — new **client-only** volatile shape mirrored to the URL query (`thread/view/layout/mode`), defined by `DEFAULT_VIEW` in `web/menu.js`. Not persisted to localStorage; not a wire entity.

## Success Criteria *(mandatory)*

- **SC-001**: With several real sessions on this box, the mosaic renders one IDE tile per active thread (busy-first) within ~2s of load, and rebinds within one store tick when a session starts/stops — no editor teardown on rebind.
- **SC-002**: A lead session with sub-agents shows the fan-out strip with the correct count and per-sub-agent activity; when the sub-agents finish the strip auto-collapses.
- **SC-003**: Changing layout/density/mode/accent and reloading restores the choices from `wyc.settings.v1`; a `?thread=&view=&layout=&mode=` deep link restores that exact view, and Back/Forward replays it; a corrupted stored blob falls back to defaults without error.
- **SC-004**: At `<820px` exactly one tile shows; ‹/› and horizontal swipe change the bound thread and update the pager; the FAB actions fire against the focused thread.
- **SC-005**: No raw secret appears in any tile (every value is `wyc.redact`-clean from the server) and the redaction-status chip reflects the `hello` frame; pin/freeze/flag perform no write to `~/.claude/**` or any observed repo.
- **SC-006**: `ci/fast.sh` green (`[ci-fast] ALL GREEN`); schema↔dataclass parity test passes (W3 introduces no wire change, so `PROTOCOL_VERSION` and the schema are unchanged).

## Assumptions
- Runs on this box behind the W1 server (loopback + token); the mosaic gets its token via `window.wyc.client.token()` or `localStorage["wyc.token"]` for pop-out/clone links.
- `web/ide.js` (W2) is the preferred per-tile surface; the mosaic is written to **degrade gracefully** to a fallback when it is absent, so W3 does not hard-depend on W2 being present at runtime.
- `web/styles.css` provides the design tokens (`:root` palette, `--mono/--sans`, status colors); `web/mosaic.css` adds only mosaic-local rules and **does not duplicate** the root token block.
- The store (W1) exposes `thread/threadsList/session/sessionsForThread/activitiesForSession/screenForSession/getState/subscribe`; `screenForSession` may return null until a session is being watched (handled).
- Pin/freeze/flag are **read-only stubs by project intent** (the server write path is deferred); their wire envelope already exists in the contract, so no contract change is needed when the write path lands.
- Demonstrated on **real** `~/.claude` data via `python3 -u -m wyc serve` (W1+W2+W3 integrated), not only fixtures (Principle XI).
