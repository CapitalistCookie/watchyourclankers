# Module / Wave / Project Build Checklist — watchyourclankers

**Purpose:** the canonical flow for building modules, waves (W1/W2/W3), and the project as a whole. Referenced by `CLAUDE.md`, the constitution's gate principles (IX, X, XI), and every sub-agent dispatch. This doc is the **single source of truth** for *how* work gets built and closed here. The constitution (`.specify/memory/constitution.md`) is the *law*; this is the *procedure that enforces it*.

This is **not** generic boilerplate — it is the cotton/construction discipline, hard-adapted to a read-only spectator whose two cardinal sins are *acting on the observed tree* (Principle I) and *leaking a secret to the glass* (Principle II). The repo-specific gates H16–H19 exist for exactly those.

---

## The recursive cycle (every level)

Module, wave, and project all follow the same 4-step loop:

```
Build → Test → Gaps (entropy floor) → Close (commit + audit + sign-off)
```

**No upper-level cycle starts before the lower-level closes.** A wave does not close until every module in it closed; the project does not ship until every wave closed.

---

## MODULE level — the 8-step flow

Every numbered task AND every follow-up commit larger than ~2 files goes through all 8 steps, in order. No skipping. Never parallelize steps 3 (red test) and 4 (green impl).

1. **Plan note** — for anything beyond a trivial edit, a short note in the active `specs/NNN-*/` (or `docs/`) stating: Goal · Scope (IN/OUT) · files touched · contract/schema impact (yes/no) · which Principles are in play · anticipated entropy items. Spec-spine features come from `/speckit-*` (Principle VIII); a follow-up of >2 files still needs a stub note (AP-3).
2. **Library reference** — for every NEW dependency (rare — vanilla is the default; CodeMirror 6 via CDN is the only frontend dep), pin the version and note signatures + gotchas before step 3. No REPL-probing in lieu of this (AP-5/AP-8 cousin).
3. **Red test** — write the failing test first; run it; confirm red. Note the red in the commit body or a scratch note. (`tests/` is pytest; **frontend/interaction behavior is `node --test web/*.test.mjs`** — extract the pure decision (e.g. `web/assign.js`) and assert it headless, because `node --check` proves syntax, *not* behavior — `docs/LESSONS.md` L1/L5.)
4. **Green implementation** — the minimum code to pass step 3.
5. **Full local gate** — `ci/fast.sh` must exit 0 with `[ci-fast] ALL GREEN` on the last line. Run with `set -o pipefail`; a pipe-to-`tail` exit code is **not** evidence (Principle IX / iron-law).
6. **Entropy floor** — Pass 1: exhaustive self-triage of the diff (correctness, the protected concepts below, edge cases from the spec). Pass 2: only *new* gaps introduced by Pass-1 fixes. Pass 3+: ACCEPT or DEFER (record DEFERs as OIs). **Hard cap: 3 passes.** This is what stops "looks done" from shipping.
7. **Commit** — explicit `git add <paths>` (never `-A` / `.` / `*`). HEREDOC message. **No `Co-Authored-By` / Claude trailers.** Author is `CapitalistCookie <j1115cruz@gmail.com>`.
8. **Push** — only after step 5 was green within the last few minutes. The local post-commit FULL hook runs detached.

---

## WAVE level (W1 → W2 → W3)

A wave is a slice the master plan declares. The sequence is fixed: **infra → depth → breadth** (W1 `001-infra-contract-feed` → W2 `002-ide-pane` → W3 `003-mosaic-mobile`). Each wave is a 4-step cycle:

1. **Wave plan** — the parent owns the wave's `specs/NNN-*/` (spec → plan → tasks via `/speckit-*`). It MUST contain a **master-plan anchor** (H10): a `Master plan reference:` to the row in `docs/MASTER_PLAN.md`'s wave table. It MUST list the **contract-lock set** — any `contracts/**` / `wyc/contract.py` / `wyc/redact.py` change the parent commits FIRST, atomically, before any sub-agent runs. It MUST define the **parallelization batches** and the **wave-close audit criteria**.
2. **Dispatch** — parent commits the contract-lock first, then fans out (see *Worktree-first fanout* below). Each sub-agent gets a disjoint allow-list; none commits; none touches a parent-only or another agent's file (H15).
3. **Wave-close audit (H11)** — after every task ships and `ci/fast.sh` is green on the merged HEAD, the parent re-verifies each spec item against the merged tree (H14 sub-agent re-verify), confirms the slice was **demonstrated on real `~/.claude` data** (H16), and dispositions every open gap as RESOLVE-NOW / DEFER (OI) / ACCEPT-WITH-RATIONALE.
4. **Wave-close note** — parent records items closed clean, OIs carried forward, and the link to the next wave's spec.

**No next wave starts until the close note is committed.** Gate to open each wave: W1 → constitution + contract exist; W2 → W1 feed verified live; W3 → W2 pane verified.

---

## PROJECT level

1. **Project plan** — `docs/MASTER_PLAN.md` (vision + 3-wave table + D-log) and the constitution. Every wave spec anchors to it (H10).
2. **Build** — W1 → W2 → W3, each running the wave cycle.
3. **Project test** — at every wave-close, the wave-subset audit; before any "ready" / merge-into-clanker claim, a full re-audit: assert every Principle has a *live* enforcer (no `(planned)` gate), the redaction proof holds across all wire-bound fields (H9 + H18), and there is **no observer→actor write path anywhere** (H19). Triage the full OI ledger.
4. **Project close** — operator sign-off.

---

## Hard gates (BLOCK — do not proceed past a red gate)

| Gate | Check | Enforcement |
|---|---|---|
| **H1** | Spec/plan note exists before impl | No impl-file edit until the `specs/NNN-*/` (or plan note) file exists |
| **H2** | `ci/fast.sh` exits 0 with the token | No `git commit` until the gate is green **in the same message**, run with `set -o pipefail` (pipe-to-tail ≠ evidence) |
| **H3** | Commit author is `CapitalistCookie <j1115cruz@gmail.com>` | Refuse a commit with any other author |
| **H4** | `git add` uses explicit paths | Refuse `git add -A`, `git add .`, `git add *` |
| **H5** | No `Co-Authored-By` / Claude trailer | Refuse if grep finds one in the message (overrides default Claude Code behavior) |
| **H6** | Push only after a fresh green gate | Refuse a push when the last `ci/fast.sh` green is stale or absent |
| **H8** | Read-before-write | Before any `Write` to an existing path, `Read`/`ls` it first; if it exists and wasn't read, STOP (catches clobbering a parallel agent's file) |
| **H9** | Adversarial cross-file enumeration of a protected concept | For any change touching a *protected concept* (redaction, the loopback/auth bind, the observer-never-actor boundary, the contract wire), enumerate **every** site that serves that concept — not just the file being edited — and verify each. E.g. redaction must be proven across **all** wire-bound fields (`detail`, `hunk_old`, `hunk_new`, terminal `data`, session/thread strings), not only the one in the diff |
| **H10** | Master-plan registry anchor | Every wave spec contains `Master plan reference:` pointing at the `docs/MASTER_PLAN.md` wave row (or `debt-without-anchor` + operator justification) |
| **H11** | Wave-close audit before next wave | Re-verify each shipped spec item on the merged tree; `ci/fast.sh` green on HEAD; close note written; OIs dispositioned |
| **H14** | Sub-agent re-verify on the merged tree | Every sub-agent prompt carries a "spec verification" section (read the spec + contract, refuse to scaffold from prompt-text alone); the **parent re-runs `ci/fast.sh` and re-checks the concept on the integrated tree**, never trusting an agent's self-report |
| **H15** | Agent ↔ parent file matrix | Honor the matrix in `CLAUDE.md`: parent-only = `contracts/**`, `wyc/contract.py`, `wyc/redact.py`, `.specify/**`, `CLAUDE.md`, `docs/MASTER_PLAN.md`, this file, `ci/**`, the integration shell (`web/index.html`, `web/app.js`). Sub-agents get a disjoint allow-list and never commit. Dispatch only when ≥2 disjoint slices, each non-trivial, exist |
| **H16** | Demonstrate on REAL `~/.claude` data | No slice is "working" on fixtures alone — show it live against real sessions/transcripts on this box (Principle XI.3) before the wave-close claim |
| **H17** | Contract ↔ schema parity | Any wire change bumps `PROTOCOL_VERSION` and updates **both** `wyc/contract.py` AND `contracts/events.schema.json` in the **same commit**; the parity test passes (Principle III) |
| **H18** | Redaction proven on a secret fixture | A redaction change (or any new wire-bound field) ships with a test feeding a secret-laden fixture (API key, token, password, private key, conn-string) and asserting it never appears post-redact. This box's `CLAUDE.md` is wall-to-wall real creds — treat every transcript as hostile (Principle II) |
| **H19** | No observer→actor write path | Before any commit, confirm no code under `wyc/` or `hooks/` opens a write/append handle (or `.write_text`/`.write_bytes`) to `~/.claude` / `/home/user/.claude` or any observed repo. `ci/fast.sh` check (e) enforces this mechanically; H19 is the principle the check serves (Principle I) |

> **H7 / H12 / H13 intentionally omitted/renumbered.** Cotton's H7 (cloud-CI poll) is replaced by the **local** post-commit FULL hook (this repo uses local CI/CD, not GitHub Actions). Cotton's H12 (upstream-V2 UI lineage) and H13 (brainstorm-SoT coverage) don't apply — the design SoT here is the constitution + master plan + the `specs/NNN-*/`; Principle VIII's spec-coverage is the analogue, enforced via H10/H11. The gate numbering keeps the cotton labels (H1–H6, H8–H11, H14–H15) so cross-repo muscle memory transfers; H16–H19 are the watchyourclankers additions.

---

## Remediation gates (2026-06-16, constitution v1.1.0)

The framework audit (`docs/REMEDIATION.md` + `docs/LESSONS.md`) made every claimed gate real. Beyond rungs (a)–(i), `ci/fast.sh` now runs:

- **(j) `node --test web/*.test.mjs`** — BEHAVIOR of pure-logic frontend modules (the rung whose absence let ghosting + drag-always-down ship). Interaction code only fans out behind one of these (Principle X).
- **(k) `tools/check_constitution_gates.py`** — every principle names a live, resolvable enforcer; no gate may be `(planned)` (Principle IX, self-enforcing).
- **(l) `tools/check_coverage.py`** — no orphan source; every `wyc/*.py` + `web/*.js` is governed by a spec or `docs/UX_LOG.md` (the honest two-track of Principle VIII).
- **(m) `tools/check_handoff_fresh.py`** — `docs/HANDOFF.md` must stay current: the `HANDOFF-HEAD` tag is fresh when **no CODE changed since the cited commit** (`cited == HEAD`, or every file in `cited..HEAD` is under `docs/` — so a chain of docs-only refreshes never false-blocks; R14), and the PROSE currency markers are gated too — the `constitution.md (vX.Y.Z)` marker must equal the real constitution version and every `main@<sha>` pointer must be fresh (R15; historical version mentions are NOT flagged — AP-8). Regenerate every marker in one command: `python3 tools/stamp_handoff.py` (`--check` to dry-run, `--commit` to land a docs-only commit; R16) — never hand-edit the sha.
- **(n) `tools/check_ledger.py`** — the closure ledger refuses green while any tracked remediation item is open (completeness is a gate, not a promise).

---

## Anti-patterns (catch + refuse)

- **AP-1 "Done" without the success token** — never claim green/passing/working without `[ci-fast] ALL GREEN` (or the matching tool-output token) **in the same message**. A pipe exit code through `tail`/`head`/`grep` masks the real failure — forbidden as evidence.
- **AP-2 Band-aid over root cause** — fix the mechanism, not the symptom; if you can't explain *why* a fix works against the actual data/code, say so and investigate (don't fabricate a rationale).
- **AP-3 Silent scope drop** — never quietly shrink a spec item to fit the budget. Drop = an explicit OI with a flip-condition, surfaced in the return, not buried.
- **AP-4 Parallel contract edits** — `contracts/**` / `wyc/contract.py` / `wyc/redact.py` are parent-only and committed FIRST, atomically. Two agents (or an agent + parent) must never edit the wire concurrently — it desyncs the seam (Principle III).
- **AP-5 Hand-edited generated output** — if any artifact is generated (a Caddyfile, an index, a derived registry), edit the generator + regenerate; never hand-patch the output.
- **AP-7 Skipped gaps sweep** — every module/wave runs the entropy-floor passes (step 6). "It compiled" is not the floor.
- **AP-8 Gaming coverage** — don't write a test that asserts nothing, redact-test a non-secret, or `KIND_OTHER`-swallow a tool you should map, just to make a check pass. A guard that can't fail proves nothing (always verify a new guard catches a real violation, as `ci/fast.sh` check (d)/(e) were proven to).

---

## Worktree-first fanout (the parallel default)

Per operator standing rule, **fan disjoint work out to parallel sub-agents whenever it doesn't sacrifice integrity.** Prefer the worktree-first pattern:

- **When:** ≥2 disjoint slices, each non-trivial, on disjoint file paths (shared/parent-only files excluded). Skip it for a single slice, data-serialized slices, or trivial edits where setup overhead dominates.
- **How:** parent commits the contract-lock first; each sub-agent works in its own `.worktrees/<slice>/` checkout on its own branch, runs TDD + its own gate, and returns a **diff (as a string) — never a commit**. The parent rebases each branch onto current `main`, runs the H9/H14 re-verify and `ci/fast.sh` on the integrated tree, then fast-forward merges. `.worktrees/` is git-ignored.
- **Cap:** 2–5 sub-agents per batch shared-tree; up to 8–10 with worktrees (the parent's job becomes "merge clean branches", not "stage allow-lists").
- **Disjoint-file rule (H15):** if you find yourself drafting "who owns this shared file" rules, the slices aren't disjoint — either re-cut them or parent-lock the shared file and have agents return fragments for the parent to insert.

**Every sub-agent prompt MUST carry:** (1) working-dir / worktree + branch; (2) spec-verification (read the spec + `wyc/contract.py` + schema; refuse to scaffold from prompt text alone — H14); (3) the explicit disjoint **allow-list**; (4) the **forbidden** set (parent-only + other agents' files); (5) for any protected-concept slice, the H9 enumeration of every site serving that concept; (6) pre-scaffold path verification (read/ls every referenced path; surface corrections prominently); (7) gates-before-return (the agent's own `ci/fast.sh` green + return the diff as a string, **do not commit/push**); (8) return format (files touched + diff + test counts + blockers).

---

## Why this exists

The cotton dashboard and the construction system each earned this discipline over dozens of commits. watchyourclankers forks it so it skips the discovery cost — and adds H16–H19 because a read-only spectator has two failure modes nothing else does: it must **never write to what it watches** (H19, mechanically enforced by `ci/fast.sh` check (e)) and it must **never leak a secret to the browser** (H18, with the box's own credential-dense `CLAUDE.md` as the worst-case fixture). Mechanical gates over promises (Principle IX): every gate above has a live enforcer before the work it governs — none is `(planned)`.
