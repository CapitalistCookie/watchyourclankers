<!-- HANDOFF-HEAD: 5f17cee -->
# watchyourclankers — Session Handoff (2026-06-16, framework remediation)

**Repo:** `/home/user/projects/watchyourclankers` · github.com/CapitalistCookie/watchyourclankers (public) · `main`
**Run:** `python3 -u -m wyc serve` → http://127.0.0.1:8900 (loopback + token at `/data/clanker/watchyourclankers/.wyc_token`).
**Gate:** `ci/fast.sh` (now rungs a–n, incl. behavioral `node --test` + 4 meta-gates) must end `[ci-fast] ALL GREEN`.

> **Freshness is now GATED.** This doc carries `<!-- HANDOFF-HEAD: <sha> -->`; `tools/check_handoff_fresh.py` (rung m) FAILS the gate unless it equals HEAD. So this file can never silently rot again (the bug that made the last session start from a 3-commits-stale picture). After substantive commits, regenerate this tag (a docs-only final commit may cite HEAD~1 — the "a commit can't embed its own sha" rule).

## One-liner for a fresh session
> Resume **watchyourclankers** (`~/projects/watchyourclankers` · `main@5b2162c`): read `CLAUDE.md` → `.specify/memory/constitution.md` (v1.2.0) → `docs/HANDOFF.md` → `docs/REMEDIATION.md` → `docs/LESSONS.md`. The harness now SELF-ENFORCES: meta-gates (no phantom gate / no orphan code / handoff-can't-rot / closure-ledger), a behavioral `node --test` rung, a REAL DOM-interaction gate (`ci/interaction.mjs` drags every gutter + blocks a broken drag at push), and **audit #4 — a PreToolUse `interaction-guard`** that injects the red-first + DOM-test discipline BEFORE any `web/{ide,mosaic,resize,debug}.js` edit. Shipped + validated: 3 drag fixes (`onDelta(dx,dy)` wrong-arg), `Cache-Control:no-cache` serving (normal refresh shows edits), read-scan (+ `offset/limit` in the contract), editor **CHAR-by-char** (`revealpolicy` CAP 6000 — was line@800), realistic terminal (`termpolicy`: type the command, DUMP output instantly, show only the latest cmd). Run `python3 -u -m wyc serve` → :8900 (no-cache); `ci/fast.sh` + `ci/full.sh` ALL GREEN; daemon live on LAN. **NEXT = `specs/004-codemirror-onbox`** (CM on-box: feasibility PROVEN — npm+esbuild → 356K bundle; 4 increments: vendor → wire off esm.sh → port the reveal INTO CM so it stops snapping → CM-mount harness test + the Principle VII no-build-step amendment); **then W4 clanker merge** (needs operator consent). The first `ide.js` edit fires the guard — follow it.

## Done this session — framework remediation (all gated, `ci/fast.sh` ALL GREEN)
An audit found the constitution promised 11 live gates but ~4 were `(planned)` in disguise; the un-gated areas (spec-first, interaction-determinism, handoff-currency, ECC) had rotted. Fix: **make every claimed gate real, or amend it.** Tracked + enforced by the closure ledger in `docs/REMEDIATION.md` (`tools/check_ledger.py` kept the gate RED until all 11 items closed).
- **Meta-gates (the framework made honest):** `node --test` behavioral rung (j); `check_constitution_gates.py` (k); `check_coverage.py` (l); `check_handoff_fresh.py` (m); `check_ledger.py` (n).
- **Bugs fixed, each behind a behavioral test (red→green):** one-panel-per-project (`web/assign.js`/`.test.mjs`, validated on the real snapshot); editor↔terminal drag (`web/idegeom.js`/`.test.mjs` — direction locked); terminal continuous feed (`ci/render_smoke.mjs` terminal-structure assertion, live-verified — caught a per-property CSS cascade leak); char-level reveal + diff-aware deletions (`web/reveal.js`/`.test.mjs`, ghost-free).
- **ECC vendored for real** (`ecc/`, affaan-m/ECC v2.0.0); constitution **1.0.0→1.1.0**; UI-polish arc folded into `docs/UX_LOG.md`; lessons in `docs/LESSONS.md`.

## Read order (architecture)
`CLAUDE.md` → `.specify/memory/constitution.md` (Principles I–XI, each with an `[enforcer:]` tag) → `wyc/contract.py` + `contracts/events.schema.json` (the seam) → `docs/MASTER_PLAN.md` (waves + Remediation §) → `docs/MODULE_BUILD_CHECKLIST.md` (gates) → `docs/REMEDIATION.md` + `docs/LESSONS.md`.

## ⚠️ Harness gaps to FIX FIRST next session — operator: NONNEGOTIABLE
The harness self-enforces but has friction/gaps the operator wants fixed before feature work:
1. **The one-liner PROSE isn't gated** — only the `HANDOFF-HEAD` tag is, so the prose DRIFTED (it said v1.1.0 / "W4 next" while the repo was many commits ahead). Gate or auto-regenerate the one-liner's currency, not just the sha.
2. **`tools/check_handoff_fresh.py` FALSE-BLOCKED a legitimate docs-only one-liner update** (the commit that added THIS note had to be pushed with `SKIP_CI=1`). The `_docs_only_final_commit` HEAD~1 allowance has a bug — and even working, it forces a hand-regen of the tag on EVERY commit (heavy friction all session). Fix the logic, and/or add a post-commit hook that auto-updates the `HANDOFF-HEAD` tag so it's never manual.
3. **Audit the whole gate ladder for similar finickiness** (a gate that false-fails is as bad as one that false-passes — AP-8) and confirm the SKIP_CI bypass didn't mask anything.

## Just landed (2026-06-16, post-remediation)
- **Harness self-enforcement (audit):** `ci/interaction.mjs` (real pointer-drag DOM probe) + rung (o)/`check_interaction_tests.py` — interaction code can't reach green without a live DOM test; the fast gate runs it vs `:8900` and BLOCKS a broken drag. Constitution 1.2.0, `LESSONS` L7.
- **3 drag bugs fixed:** `onDelta(dx,dy)` wrong-arg on the vertical gutters of `ide.js` + `mosaic.js` + `debug.js` (H9 enumeration found all three).
- **`Cache-Control: no-cache`** on the daemon (`server.py`) — frontend edits show on a NORMAL refresh (no more "deployed but not fixed").
- **read-scan (`web/readscan.js` + ide wiring):** a "reading" highlight sweeps the read range when Claude reads a file. Fallback-only sweep, operator-verified for feel.
- **word-by-word reveal:** diagnosed — it was STALE CACHE (fixed); the fallback is char-level (R08), and **CodeMirror SNAPS** (no reveal). Making CM reveal char-by-char is the residual, but **CM can't load on this box** so it's not DOM-testable here (collides with rung o) — needs a decision (port reveal into CM + operator-verify, or make the testable fallback canonical).

## NOT done / next session
1. **W4 — merge into clanker** (needs operator go): host `/ws` + static under clanker `serve.py`; state under `/data/clanker/watchyourclankers/`; reuse `resolve_project` + HMAC/TOTP; optionally feed the terminal from clanker's PTY capture.
2. **Annotate write-path** — pin/freeze/flag still persist to `DATA_DIR/annotations.jsonl` with no readback/UI hydration (stub by design).
3. **Enrichment hook** — `/hook` is a no-op; the watcher lacks `ingest_hook` (transcript-tail is canonical, so enrichment only).
4. The reveal/terminal *feel* is best confirmed in-browser (the deletions animation + the drag are time-based; logic is gated, but eyeball it). Hard-refresh the LAN URL.

## Gotchas (hard-won)
- **Port 8900** — clanker owns 8899; never bind there. The daemon serves `web/` from disk live with `Cache-Control: no-cache` (`server.py` `nocache_middleware`, `e69e48d`), so frontend edits show on a **NORMAL** refresh — no hard-refresh needed; only a **backend** change needs a daemon restart. (A "deployed but not fixed" report before that was browser heuristic-caching.)
- **Restart safely:** `pkill -f 'm wyc serve'` self-matches the kill command's own cmdline if the launch string is in the same shell call — kill in one call (bracket trick `'[m] wyc serve'`), launch in a separate call. Relaunch: `setsid nohup env WYC_HOST=0.0.0.0 python3 -u -m wyc serve --port 8900 > /tmp/wyc_daemon.log 2>&1 < /dev/null &`.
- **Interaction code is GATED (rung o, audit 2026-06-16):** any change to `web/{ide,mosaic,resize,debug}.js` must keep `ci/interaction.mjs` (a REAL pointer-drag DOM probe) green — the fast gate RUNS it vs a live `:8900` daemon and BLOCKS the push if a gutter drag is a no-op. A pure `node --test` (math) does NOT satisfy it (`LESSONS` L7). **`attachDrag` calls `onDelta(dx, dy)`** — a VERTICAL (`axis:'y'`) gutter MUST use the SECOND arg `dy`; binding the first arg is the wrong-arg bug that broke all 3 vertical gutters. Fix interactions RED-first against the probe + H9-enumerate every drag site.
- **CSS cascades PER-PROPERTY** — a higher-specificity rule only wins for properties it *declares*; a duplicate global rule (`.term-cmd` in `styles.css`) leaked `position:sticky` until explicitly reset in `.ide .term-cmd`. The render-smoke caught it.
- **`node --check` ≠ behavior** — it proves syntax; `node --test` proves behavior. Interaction bugs live in LOGIC: extract a pure module (`assign.js`/`idegeom.js`/`reveal.js`) and unit-test it.
- **HANDOFF freshness** — see the gated tag above; regenerate it in the final commit.
- **Commit via `git commit -F msgfile`**; explicit `git add <paths>`; author `CapitalistCookie <j1115cruz@gmail.com>`; **no `Co-Authored-By`**.
- **cwd=/home/user** for interactive sessions → project derived from edited file paths (`wyc/threads.py::_effective_project`).
- **subagent transcripts** live at `<slug>/<sessionId>/subagents/agent-*.jsonl`.
