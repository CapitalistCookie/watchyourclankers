# Implementation Plan: Mosaic, Menus & Mobile (W3)

**Feature Branch**: `003-mosaic-mobile`
**Date**: 2026-06-16
**Spec**: [specs/003-mosaic-mobile/spec.md](./spec.md)

> **AS-BUILT.** W3 is already implemented and integrated; this plan records the technical approach and constitution posture of the shipped code (`web/mosaic.js`, `web/menu.js`, `web/mosaic.css`) for Spec-Spine compliance (Principle VIII) and gate H1.

## Summary

Compose the W2 IDE pane into a **dynamic tiling mosaic** — one reconciling tile per active thread (busy-first), reflowing on every store tick, with a collapsible sub-agent fan-out strip per tile, a ⌘K command palette + settings panel, and a `<820px` swipeable single-pane mobile layout. The one design choice that matters most: **mosaic.js is the view/controller and menu.js is the single writer of settings + URL view-state** — the mosaic registers itself as a controller and the menu pushes settings/view changes to it, so there is exactly one persistence/URL path and the IDE editors are never torn down on a reflow (reused via `pane.setThread`). No wire change: W3 only *consumes* the existing contract.

## Technical Context

- **Language/Version**: ES2022 vanilla JS (ES modules, no build step), CSS3. No TypeScript compile — type-checked via `// @ts-check` + JSDoc only.
- **Primary Dependencies**: **none added.** No tiling/grid library — the mosaic is a hand-rolled CSS grid (`web/mosaic.css`, `grid-template-columns/rows` keyed by `data-layout`). Composes `web/ide.js` (W2, which itself uses CodeMirror 6 via CDN). No bundler, no npm runtime deps.
- **Storage**: client-only — `localStorage["wyc.settings.v1"]` (one sanitized, versioned blob) + URL query view-state. **No server-side state, no write to `~/.claude/**`** (Principle I). Annotations are a deferred server stub (`DATA_DIR` when it lands).
- **Testing**: pytest unit tests for any pure JS helpers exercised server-side are N/A (these are browser modules); pure functions (`fuzzyMatch`, `sanitizeSettings`) are exported for future test harnessing. Demonstrated on **real** `~/.claude` data via `python3 -u -m wyc serve` (Principle XI); `ci/fast.sh` is the gate.
- **Target Platform**: loopback web UI on this box (default `127.0.0.1:8900`), desktop + mobile (`<820px`) browsers.
- **Performance Goals**: reflow is reconciling (reuse tiles, `pane.setThread`, no editor teardown); store-driven refresh is micro-task batched (one pass per change cluster); frozen tiles skip refresh; only visible tiles re-render chrome/fanout/fallback/screen. Settings writes debounced ~250ms; URL writes debounced ~60ms.
- **Constraints**: no build step; no new heavy deps; every wire value already `wyc.redact`-clean server-side (the mosaic adds none); single-writer for settings/URL state; graceful degradation when `ide.js` is absent.
- **Scale/Scope**: N concurrent threads + their sub-agents tiled across 1/2/4/6 slots with an overflow rail; high-rate surfaces (editor/terminal) live inside the composed IDE pane (W2's drop-slow concern), so the mosaic layer's own work stays O(visible tiles) per change.

## Constitution Check

> GATE — evaluated against the shipped code.

| Principle | Compliance in this plan |
|---|---|
| **I. Observer, Never Actor** | No write path to `~/.claude/**` or any observed repo. Pin/freeze/flag emit an `annotate` envelope only (read-only **stub**; server write path deferred → `DATA_DIR` when it lands). Settings persist to browser `localStorage` only. |
| **II. Secrets Never Reach the Glass** | The mosaic introduces **no new wire-bound value**; it renders only strings already passed through `wyc.redact` server-side. A redaction-status chip surfaces the `hello` frame's `redaction` flag. |
| **III. The Contract Is the Seam** | **No wire change.** `mosaic.js`/`menu.js` only *consume* existing contract symbols (`Session.subagents`, `Thread`, `Activity.agent_id`, `Screen`) and existing envelopes (`annotate`, `watch_screen`, `unwatch_screen`). `PROTOCOL_VERSION` (=1), `contracts/events.schema.json`, and `wyc/contract.py` are untouched. |
| **IV. Total Activity Coverage** | The mosaic surfaces whatever the feed provides (`current_surface` rendered as-is; unknown tools already mapped to `other` upstream by `kind_for_tool`); no crash on an unknown surface/empty thread (empty state + recent-threads fallback). |
| **V. A Thread Survives Handoffs** | The mosaic is **thread-keyed** end-to-end (one tile per `Thread`, lead via `lead_session_id`, chain rendered `s→s`); it inherits W1's handoff-spanning stitch and shows the multi-session chain in tile chrome. |
| **VI. Snapshot-Then-Stream** | Hydration + `seq`-gap/`resync` are owned by `client.js`/`store.js` (W1); the mosaic re-renders from the rehydrated store on each `subscribe` tick. |
| **VII. Clanker's Idiom, Performant** | Vanilla JS + hand-rolled CSS grid, **no build, no tiling lib**; reconciling reflow (no editor teardown), micro-task-batched refresh, visible-only re-render, debounced persistence/URL. Composes the W2 CDN-CodeMirror pane rather than re-implementing it. |
| **VIII. Spec Spine: Flow-Forward** | This plan + its spec carry id `003-mosaic-mobile`; the as-built code is brought under the spine retroactively (gate H1). |
| **IX. Mechanical Gates Over Promises** | `ci/fast.sh` remains the pre-push gate; no "green/done" claim without the `[ci-fast] ALL GREEN` token in the same message. W3 adds no new gate (no wire change to enforce). |
| **X. Multi-Agent Discipline** | W3 was built by the mosaic sub-agent on a disjoint allow-list (`web/mosaic.js`, `web/menu.js`, `web/mosaic.css` + a `web/mosaic.css` link in the shell); parent-only files (`contracts/**`, `wyc/contract.py`, `wyc/redact.py`, `web/index.html`, `web/app.js`) were integrated + re-verified by the parent (see CLAUDE.md H15 matrix). |
| **XI. Definition of Done** | Maps to spec id `003`; gate green with token; **demonstrated on real `~/.claude`** via `wyc serve` (W1+W2+W3); contract+schema in sync (unchanged); clean-author commit (`CapitalistCookie <j1115cruz@gmail.com>`, no Claude trailer). |

**Violations / deviations**: none. W3 adds no dependency, no wire change, and no write path; the only new persistent artifact is a browser-local `localStorage` blob.

## Project Structure

> Concrete files this feature creates/edits. **(parent-only)** per the CLAUDE.md H15 matrix; everything else was a sub-agent allow-list.

```
web/mosaic.js                   dynamic tiling mosaic: tiles, reflow, fan-out, raw-screen, mobile, pop-out (agent allow-list)
web/menu.js                     control plane: ⌘K palette, settings, keybinds, localStorage blob, URL view-state (agent allow-list)
web/mosaic.css                  grid + tile chrome + palette/settings/help + mobile @media (820px) (agent allow-list)
web/index.html                  (parent-only) — links mosaic.css, mounts the mosaic shell
web/app.js                      (parent-only — integration shell) — instantiates mountMosaic(el, store)
contracts/events.schema.json    (parent-only) — UNCHANGED (no wire change in W3)
wyc/contract.py                 (parent-only) — UNCHANGED (no wire change in W3)
specs/003-mosaic-mobile/        spec.md · plan.md · tasks.md (this spec)
```

**Parallelization (X):** W3 was a single disjoint slice owned by one sub-agent (the three `web/mosaic.*` + `web/menu.js` files form one cohesive control+view unit; splitting them would have crossed the menu↔mosaic single-writer seam). The parent integrated it into the shell (`web/index.html`, `web/app.js`), re-verified live, and committed.

## Complexity Tracking

> No deviations from the Constitution Check — table intentionally empty.

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| — | — | — |
