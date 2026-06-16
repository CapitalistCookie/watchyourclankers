<!-- HANDOFF-HEAD: 3f3df9c -->
# watchyourclankers — Session Handoff (2026-06-16, framework remediation)

**Repo:** `/home/user/projects/watchyourclankers` · github.com/CapitalistCookie/watchyourclankers (public) · `main`
**Run:** `python3 -u -m wyc serve` → http://127.0.0.1:8900 (loopback + token at `/data/clanker/watchyourclankers/.wyc_token`).
**Gate:** `ci/fast.sh` (now rungs a–n, incl. behavioral `node --test` + 4 meta-gates) must end `[ci-fast] ALL GREEN`.

> **Freshness is now GATED.** This doc carries `<!-- HANDOFF-HEAD: <sha> -->`; `tools/check_handoff_fresh.py` (rung m) FAILS the gate unless it equals HEAD. So this file can never silently rot again (the bug that made the last session start from a 3-commits-stale picture). After substantive commits, regenerate this tag (a docs-only final commit may cite HEAD~1 — the "a commit can't embed its own sha" rule).

## One-liner for a fresh session
> Resume **watchyourclankers** (`~/projects/watchyourclankers` · `main`): read `CLAUDE.md` → `.specify/memory/constitution.md` (v1.1.0) → `docs/REMEDIATION.md` → `docs/LESSONS.md` → `docs/HANDOFF.md`. The framework was audited + hardened: every constitution principle now names a LIVE enforcer (`tools/check_constitution_gates.py`), no orphan code (`check_coverage.py`), the handoff can't rot (`check_handoff_fresh.py`), and a behavioral `node --test` rung gates BEHAVIOR not just syntax. The reverted IDE interaction layer was redone behind tests: one-panel-per-project (`web/assign.js`), drag geometry (`web/idegeom.js`), continuous terminal feed, char-level reveal w/ deletions (`web/reveal.js`). Run `python3 -u -m wyc serve` → :8900; `ci/fast.sh` is ALL GREEN. NEXT (operator go) = W4 merge into clanker.

## Done this session — framework remediation (all gated, `ci/fast.sh` ALL GREEN)
An audit found the constitution promised 11 live gates but ~4 were `(planned)` in disguise; the un-gated areas (spec-first, interaction-determinism, handoff-currency, ECC) had rotted. Fix: **make every claimed gate real, or amend it.** Tracked + enforced by the closure ledger in `docs/REMEDIATION.md` (`tools/check_ledger.py` kept the gate RED until all 11 items closed).
- **Meta-gates (the framework made honest):** `node --test` behavioral rung (j); `check_constitution_gates.py` (k); `check_coverage.py` (l); `check_handoff_fresh.py` (m); `check_ledger.py` (n).
- **Bugs fixed, each behind a behavioral test (red→green):** one-panel-per-project (`web/assign.js`/`.test.mjs`, validated on the real snapshot); editor↔terminal drag (`web/idegeom.js`/`.test.mjs` — direction locked); terminal continuous feed (`ci/render_smoke.mjs` terminal-structure assertion, live-verified — caught a per-property CSS cascade leak); char-level reveal + diff-aware deletions (`web/reveal.js`/`.test.mjs`, ghost-free).
- **ECC vendored for real** (`ecc/`, affaan-m/ECC v2.0.0); constitution **1.0.0→1.1.0**; UI-polish arc folded into `docs/UX_LOG.md`; lessons in `docs/LESSONS.md`.

## Read order (architecture)
`CLAUDE.md` → `.specify/memory/constitution.md` (Principles I–XI, each with an `[enforcer:]` tag) → `wyc/contract.py` + `contracts/events.schema.json` (the seam) → `docs/MASTER_PLAN.md` (waves + Remediation §) → `docs/MODULE_BUILD_CHECKLIST.md` (gates) → `docs/REMEDIATION.md` + `docs/LESSONS.md`.

## NOT done / next session
1. **W4 — merge into clanker** (needs operator go): host `/ws` + static under clanker `serve.py`; state under `/data/clanker/watchyourclankers/`; reuse `resolve_project` + HMAC/TOTP; optionally feed the terminal from clanker's PTY capture.
2. **Annotate write-path** — pin/freeze/flag still persist to `DATA_DIR/annotations.jsonl` with no readback/UI hydration (stub by design).
3. **Enrichment hook** — `/hook` is a no-op; the watcher lacks `ingest_hook` (transcript-tail is canonical, so enrichment only).
4. The reveal/terminal *feel* is best confirmed in-browser (the deletions animation + the drag are time-based; logic is gated, but eyeball it). Hard-refresh the LAN URL.

## Gotchas (hard-won)
- **Port 8900** — clanker owns 8899; never bind there. The daemon serves `web/` from disk live, so frontend changes need only a browser hard-refresh, no restart.
- **CSS cascades PER-PROPERTY** — a higher-specificity rule only wins for properties it *declares*; a duplicate global rule (`.term-cmd` in `styles.css`) leaked `position:sticky` until explicitly reset in `.ide .term-cmd`. The render-smoke caught it.
- **`node --check` ≠ behavior** — it proves syntax; `node --test` proves behavior. Interaction bugs live in LOGIC: extract a pure module (`assign.js`/`idegeom.js`/`reveal.js`) and unit-test it.
- **HANDOFF freshness** — see the gated tag above; regenerate it in the final commit.
- **Commit via `git commit -F msgfile`**; explicit `git add <paths>`; author `CapitalistCookie <j1115cruz@gmail.com>`; **no `Co-Authored-By`**.
- **cwd=/home/user** for interactive sessions → project derived from edited file paths (`wyc/threads.py::_effective_project`).
- **subagent transcripts** live at `<slug>/<sessionId>/subagents/agent-*.jsonl`.
