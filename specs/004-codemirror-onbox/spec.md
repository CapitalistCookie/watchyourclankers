# Spec 004 — CodeMirror runs ON THIS BOX (vendored, no CDN)

**Status:** Implemented (increments 1–4 landed, `ci/fast.sh` ALL GREEN) · 2026-06-16 · Master plan reference: docs/MASTER_PLAN.md (post-remediation)

## Problem
The editor loads CodeMirror 6 by dynamic ESM `import()` from **esm.sh** (a CDN), per the
"no build step / CDN deps" choice. **This box cannot reach esm.sh** → the import fails →
`ide.js` falls back to the `<pre>` editor. Consequences: (a) CM is **untestable on this box**
(headless tests always hit the fallback); (b) when a user's browser *does* reach esm.sh, CM
**snaps** the doc in (no char-reveal — against the product's whole point). Operator: to make
the editor actually usable + developable, CM must run **on this box**.

## Feasibility — PROVEN (2026-06-16)
The box can't reach esm.sh, but `npm` + `esbuild` work here. Verified:
```
npm install codemirror @codemirror/state @codemirror/view @codemirror/commands \
  @codemirror/language @codemirror/lang-javascript @codemirror/lang-python @codemirror/theme-one-dark
npx --yes esbuild entry.mjs --bundle --format=esm --minify --outfile=cm.bundle.js
```
→ a **356 KB self-contained ESM bundle**, loadable from disk. So vendoring is producible on-box.

## Build (the ordered increments — each committed + gate-green)
1. **Produce + vendor the bundle** → `web/vendor/codemirror.bundle.js`. The `entry.mjs` re-exports
   exactly what `ide.js` imports today from esm.sh (read `ide.js` §"CodeMirror CDN" ~L43–90 for
   the exact set: `EditorState`, `EditorView`, `Compartment`, `keymap`, basic extensions,
   `lang-javascript`/`lang-python`/…, `oneDark`). Commit the bundle (vendored artifact, like
   `web/vendor/highlight.min.js`).
2. **Wire `ide.js`** → `import()` the local `/static/vendor/codemirror.bundle.js` instead of esm.sh;
   drop the esm.sh URL. The `<pre>` fallback stays as the degrade path (defence in depth).
3. **Port the char-reveal INTO CM** → reuse `reveal.js`/`revealpolicy.js`: dispatch the hunk
   char-by-char via CM transactions (read-only doc still accepts programmatic `dispatch`) so CM
   TYPES like the fallback instead of snapping. Now testable on-box (CM mounts here).
4. **Harness** → CM is now loadable headless, so add a CM-mount + CM-reveal assertion to
   `ci/full.sh` (render-smoke / interaction probe): CM mounts, types a hunk, 0 errors. This is the
   first time the CM path can be DOM-gated.

## Foundational-doc impact (do in the build, not now)
- **Constitution Principle VII** ("no build step, CDN deps") — AMEND: the rule targets a *runtime*
  build (no webpack at serve-time; the browser loads files directly). A **one-time VENDORING build**
  (`npm`+`esbuild` → a committed static bundle) is NOT a runtime build — the browser still loads a
  static file. Permit vendored bundles produced by a one-time build; forbid a serve-time pipeline.
  Bump the constitution version; re-run `tools/check_constitution_gates.py`.
- **Contract:** no wire change (CM is frontend rendering only) — Principle III unaffected.
- **Coverage:** `web/vendor/**` is excluded (like the hljs vendor); the `ide.js` changes stay governed.

## As-built (increments landed — 2026-06-16)
- **Increment 1 (vendor):** `build/codemirror/{entry.mjs,package.json,package-lock.json}` is the one-time
  esbuild vendoring recipe (`npm ci && npm run build`); it emits `web/vendor/codemirror.bundle.js`
  (committed, ~612 KB — larger than the 356 KB proof because ide.js needs all 8 language packages).
- **Increment 2 (wire):** `web/ide.js` imports `/static/vendor/codemirror.bundle.js` (one cached
  dynamic import) instead of esm.sh; the `<pre>` fallback stays. CM mounts on-box.
- **Theme fix (clanker-aligned):** once CM actually mounted on-box, its `theme-one-dark` (cool grey
  `#282c34`) clashed with the app's warm stone/terracotta palette. Replaced with a **Gruvbox-dark
  `HighlightStyle`** (mirrors the old `<pre>` fallback's hljs theme) + a chrome theme built from the
  app CSS vars (`--bg-deep` bg, `--fg-dim` text, `--accent` caret, `dark:true`). `theme-one-dark`
  dropped from `build/codemirror/entry.mjs`; `@lezer/highlight` (`tags`) + `HighlightStyle` added +
  bundle rebuilt (608 KB).
- **Increment 3 (reveal):** `web/cmreveal.js` is the PURE reveal plan (`cmRevealPlan`, reusing
  `reveal.js`/`revealpolicy.js`), unit-tested in `web/cmreveal.test.mjs`; `web/ide.js`
  (`revealHunkInCm`) types the hunk into CM via transactions on the paced CADENCE instead of
  snapping. `ci/cm_smoke.mjs` DOM-gates it (vendored bundle imports + mounts + the real plan types
  to the exact fullDoc) — wired into `ci/full.sh` and the `ci/fast.sh` push gate.
- **Increment 4 (amend):** constitution Principle VII amended (v1.2.0→**1.3.0**) — a one-time
  VENDORING build is permitted (committed static bundle), a serve-time pipeline is not; VII gains a
  second live enforcer `[enforcer: ci/fast.sh:cm_smoke.mjs]` so the on-box claim is itself gated.
  `tools/check_constitution_gates.py` green (13 enforcers resolve).

## Why it's specced, not built here
Proven feasible + fully scoped, but it's a 4-increment build that crosses the context wall; per the
harness discipline (don't ship a half-built interaction layer, don't stop mid-build), it gets a clean
fresh-budget run. The interaction-guard (audit #4) will enforce the discipline on every `ide.js` edit
in that run.
