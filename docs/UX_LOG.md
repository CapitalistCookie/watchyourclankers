# watchyourclankers — UX Iteration Log

The honest **second track** of Principle VIII. Architecture earns a numbered spec
(`specs/NNN-*/`); fast render-loop UX iteration — driven by the operator viewing the
live dashboard and giving verbal feedback — is recorded here instead of pretending each
tweak earned a full spec. `tools/check_coverage.py` treats a file named here as governed.

Every row: the round, what changed, the files it touched, and how it was verified.

## 2026-06-16 — UI polish arc (session ff01647a, after W1–W3)

| Round | Change | Files | Verified |
|---|---|---|---|
| Reskin | Clanker-family warm card-grid theme; fixed the blank-UI bug (mosaic.css/ide.css were never `@import`ed) | `web/styles.css`, `web/mosaic.css`, `web/ide.css`, `web/index.html` | headless render, 0 console errors; css-load-chain gate added |
| Resizable everywhere | One shared pointer-capture resizer + gutters, persisted | `web/resize.js`, `web/mosaic.js`, `web/ide.js`, `web/debug.js` | node-check; **(behavior was under-gated — see LESSONS)** |
| Status fix | Trust the registry's `busy` flag (a stale-file heuristic was burying live sessions) | `web/mosaic.js` *(driver)*, `wyc/sessions.py` | sessions status smoke |
| Vendored highlighter | Local highlight.js (esm.sh/jsdelivr blocked here; cdnjs works) | `web/ide.js`, `web/vendor/` | render shows colored tokens |
| One bar + Watch-N | Consolidated 36px bar; `WATCH [Auto/1–8]` dropdown (`tilesToGrid`, arbitrary N); auto-orientation; per-config view-state | `web/app.js`, `web/app-config.js`, `web/mosaic.js`, `web/menu.js` | render: one 36px bar, dropdown `[Auto,1..8]` |
| Natural follow | Gap-adaptive reveal cadence + blinking idle caret | `web/ide.js`, `web/ide.css` | logic verified; feel operator-judged |
| Client/store seam | Snapshot-then-stream + seq-gap recovery feeding all views | `web/client.js`, `web/store.js` | gap-recovery unit test (pytest side) + render |

## 2026-06-16 — Remediation (this pass)

| Round | Change | Files | Verified |
|---|---|---|---|
| Slot-assignment | Pure DOM-free assignment extracted (`web/assign.js`); **one-panel-per-project** dedup | `web/assign.js`, `web/mosaic.js` | `web/assign.test.mjs` (node --test) — red→green |
| IDE drag geometry (R06) | Editor↔terminal resize math extracted pure (`web/idegeom.js`); locked direction (no "always goes down"); captures clamped state not a DOM measurement | `web/idegeom.js`, `web/ide.js` | `web/idegeom.test.mjs` (8 tests) |
| Terminal continuous feed (R07) | Restyled the terminal to one shell-style feed (`$ cmd → output → $ cmd`), no boxed/sticky per-command panels; fixed a per-property cascade leak from the global `.term-cmd` | `web/ide.css` | `ci/render_smoke.mjs` terminal-structure assertion (live-verified) |
| Char-level reveal + deletions (R08) | Pure diff→frames engine (`web/reveal.js`): backspace what changed, type the new, char by char; wired ghost-free (full-string `textContent` per frame) into the editor reveal | `web/reveal.js`, `web/ide.js` | `web/reveal.test.mjs` (11 tests) + render 0-errors |

> Files governed here for coverage: `web/resize.js`, `web/app-config.js`, `web/app.js`, `web/menu.js`, `web/mosaic.js`, `web/ide.js`, `web/debug.js`, `web/client.js`, `web/store.js`, `web/assign.js`, `web/idegeom.js`, `web/reveal.js`.
