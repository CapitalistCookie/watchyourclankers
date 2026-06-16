# Implementation Plan: IDE Spectator Pane (W2)

**Feature Branch**: `002-ide-pane`
**Date**: 2026-06-16
**Spec**: [specs/002-ide-pane/spec.md](./spec.md)

> **As-built.** This plan documents the technical shape of code that already shipped (`web/ide.js`, `web/ide.css`) and the `/file` route it consumes (`wyc/server.py`). It is recorded retroactively to satisfy Principle VIII (spec spine) / gate H1.

## Summary

Build a single, polished, **read-only** IDE pane for one thread: a tabbed CodeMirror 6 editor that auto-follows the lead session's edits (scroll-to + flash the live hunk), a thread-wide file tree, a live terminal of Claude's shell, and a flip-to-raw tmux mirror. The one design choice that matters most: CodeMirror is loaded from a **CDN with no build step** and a graceful highlighted-`<pre>` fallback, so the pane stays in clanker's no-build vanilla-JS idiom yet gets a real editor — and is never blank if the CDN is unreachable.

## Technical Context

- **Language/Version**: ES2022 vanilla JS, single ES module (`web/ide.js`); no transpile, no bundler.
- **Primary Dependencies**: CodeMirror 6 via `esm.sh` CDN (pinned: `@codemirror/state`+`view` 6.0.1, `language` 6.10.8, `theme-one-dark` 6.1.2, per-language packs pinned majors), lazy-imported by file extension. Shared core packages kept un-bundled via `external=` so they're loaded once. No npm install, no new backend dep. The browser `fetch` API for `/file`.
- **Storage**: none owned by this pane. It reads the in-memory store (`web/store.js`) and the read-only `/file` route; it writes nothing — not to `~/.claude/**`, not to any observed repo, not to `DATA_DIR` (Principle I).
- **Testing**: `ci/fast.sh` (schema↔dataclass parity + lint + backend unit tests). The pane is pure browser DOM/CodeMirror behavior, demonstrated on a real `~/.claude` thread (Principle XI: the editor follows live edits, the terminal streams real Bash output) — not unit-tested in isolation.
- **Target Platform**: loopback web UI on this box (default `127.0.0.1:8900`), modern Chromium/Firefox with dynamic `import()` + ESM.
- **Performance Goals**: O(1)-per-tick render — DOM built once, one store subscription, each surface self-decides what changed; tree rebuild is membership-signature-gated; terminal blocks reconcile by `ref_seq` and append only new chunks; raw screen repaints only on a changed frame `seq`; editor mounts lazily on first file.
- **Constraints**: no build step; read-only editor (`editable.of(false)` + `readOnly.of(true)`); all wire/file values redacted upstream (Principle II); never blank on CDN-down or `/file` 404; tolerate an absent client (no raw screen, no crash).
- **Scale/Scope**: one thread per pane instance (W3 mosaic mounts many). Within a thread: N sessions' activities aggregated for the tree; the high-rate surfaces (editor swaps, terminal) are reconcile-in-place, not rebuild.

## Constitution Check

> GATE — re-checked against the shipped code.

| Principle | Compliance in this plan |
|---|---|
| **I. Observer, Never Actor** | Editor is doubly read-only; the pane has no write path. `/file` is root-jailed to an allowlist of realpath roots and serves only readable regular files (`wyc/server.py`). No `~/.claude/**` or repo write. |
| **II. Secrets Never Reach the Glass** | `/file` runs content through `wyc.redact` before it leaves the process (`redacted:true`); terminal/screen data arrive pre-redacted on the wire. The pane adds no path that surfaces an unredacted value; provenance badges (`redacted`/`truncated`/`reconstructed`) shown. |
| **III. The Contract Is the Seam** | No wire change this wave — the pane reads existing `Activity`/`Terminal`/`Screen`/`Session`/`Thread` defs. `PROTOCOL_VERSION` unchanged; `events.schema.json` + `wyc/contract.py` untouched. |
| **IV. Total Activity Coverage** | The pane consumes `Activity.kind` for all surfaces; unknown file extensions degrade to plain (no language) and the generic tree/tab glyph — shown, never crashed. |
| **V. A Thread Survives Handoffs** | The pane renders one thread by id and re-points editor/terminal/status/screen to the new `lead_session_id` on handoff, falling back to the newest `session_id` when no explicit lead. |
| **VI. Snapshot-Then-Stream** | The pane is a pure consumer of the store, which W1 hydrates via `snapshot` and advances by `seq`; the auto-switch watermark and the per-block/per-frame `seq` gating ride that ordering. No bespoke transport here. |
| **VII. Clanker's Idiom, Performant** | Vanilla JS + CDN CodeMirror, **no build step**; DOM built once, one subscription, O(1)-per-tick surface updates; editor mounts lazily; signature-gated tree. |
| **VIII. Spec Spine: Flow-Forward** | This plan + its spec carry id `002-ide-pane`; recorded as-built to bring the shipped pane onto the spec spine. |
| **IX. Mechanical Gates Over Promises** | `ci/fast.sh` is the live pre-push gate; no "green/done" without the `[ci-fast] ALL GREEN` token in the same message. |
| **X. Multi-Agent Discipline** | Built by the IDE sub-agent on its disjoint allow-list (`web/ide.js` only); parent-only files (`contracts/**`, `wyc/contract.py`, `wyc/redact.py`, `web/index.html`, `web/app.js`, `ci/**`) untouched by the agent; parent integrated + re-verified on the merged tree. |
| **XI. Definition of Done** | Maps to spec id `002`; gate green with token; demonstrated on real `~/.claude` (editor follows live edits, terminal streams real Bash); contract already in sync (no change); clean-author commit. |

**Violations / deviations**: one — the CDN dependency for CodeMirror (see Complexity Tracking).

## Project Structure

```
web/ide.js                      the IDE-spectator pane (this feature; sub-agent allow-list)
web/ide.css                     the pane's styling (this feature; reuses styles.css palette vars, does NOT edit it)
web/store.js                    (parent-integrated seam) read-only consumer: thread/session/sessionsForThread/
                                activitiesForSession/terminalForSession/screenForSession + client + subscribe
web/client.js                   (parent-integrated seam) provides watchScreen/unwatchScreen
wyc/server.py                   (parent-only) GET /file: root-jailed, redacted, ~2 MB head cap -> truncated
contracts/events.schema.json    (parent-only) UNCHANGED — pane reads existing Activity/Terminal/Screen/Session/Thread
specs/002-ide-pane/             spec.md · plan.md · tasks.md
```

**Parallelization (X):** shipped as a single disjoint sub-agent slice — the IDE agent owned `web/ide.js` (+ `web/ide.css`) exclusively while sibling agents owned other files; the parent wired the `store`/`client` seams and the `/file` route, integrated, and re-verified live. No further fan-out within this pane.

## Complexity Tracking

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| CodeMirror 6 from the `esm.sh` CDN (one external runtime dep) | A real syntax-highlighted, scrollable, language-aware editor is the centerpiece of "watch over Claude's shoulder in an IDE"; hand-rolling one in vanilla JS would be far larger and worse, and a bundler/build step would break clanker's no-build idiom (D1). | A pure hand-written highlighter has no language support, folding, or robust large-file rendering. **Mitigation:** versions are pinned, shared core kept un-bundled (loaded once), languages lazy-loaded by extension, and a highlighted-`<pre>` fallback guarantees the pane is never blank if the CDN is unreachable — so the dependency is enhancement-only, not load-bearing for "does it render at all". |
