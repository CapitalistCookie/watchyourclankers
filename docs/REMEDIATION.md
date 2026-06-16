# watchyourclankers — Framework Remediation (2026-06-16)

**Status:** IN PROGRESS · owner CapitalistCookie · HEAD-at-open `f632b4e`

## Why this exists

The constitution (`.specify/memory/constitution.md`) states **11 principles, each ending in a
`*Gate (live):*` clause**, governed by the keystone **Principle IX — "Mechanical Gates Over
Promises: No gate is `(planned)` — its enforcer is live before the work it governs."**

An audit (2026-06-16) found the framework **violates its own keystone**: ~4 of the 11 claimed
gates were never built, and **exactly the un-gated areas rotted** while every mechanically-gated
one held. Evidence:

| Principle | Claimed gate | Reality at audit |
|---|---|---|
| I, II, III, IV, VI | grep guards, redaction test, contract-parity, kind-totality, gap-recovery | ✅ real & enforced — held all session |
| **VII Performant** | "perf smoke test, N sessions without jank" | ❌ never built |
| **VIII Spec spine** | "impl references a spec id; spec-coverage check" | ❌ no gate; specs 002/003 backfilled-as-built |
| **IX keystone** (behavior) | "done requires real behavior" | ❌ no behavioral/interaction gate → `node --check` passes syntax, so ghosting + drag-always-down shipped to `main` |
| **Governance** | "vendored ECC rules are reference taste" | ❌ no `ecc/` dir — one phantom sentence |
| (handoff) | — (ungoverned) | ❌ `docs/HANDOFF.md` last touched `fd762e4`, still cited ancestor `c54957a`, 3 commits before the UI arc + the `f632b4e` revert |

**Root pattern: mechanically-gated ⇒ held; convention/vigilance ⇒ rotted.** This remediation makes
every claimed gate *real or honestly amended*, folds the orphan UI-arc code into governed
artifacts, redoes the reverted bug-fixes behind behavioral tests, and — crucially — makes
**completeness itself a gate** so "done" cannot be asserted, only mechanically demonstrated.

## The completeness guarantee (how "I fixed everything" is enforced, not promised)

`tools/check_ledger.py` parses the **machine-readable ledger below**, and:
1. **Fails `ci/fast.sh` while ANY row is `OPEN`** — the gate is honestly RED until the work is done.
2. For every `CLOSED` row, **asserts the named enforcer exists and is wired** — a row cannot be
   marked closed without its live enforcer.

So `[ci-fast] ALL GREEN` is *impossible* until every meta-gate is real, every bug's behavioral
test passes, every file is covered, the handoff is current, and ECC is vendored. Green **is** the
proof. These enforcers persist, so the next session inherits the same forcing function.

<!-- LEDGER:BEGIN — parsed by tools/check_ledger.py; row format: | ID | Item | Enforcer | Status | -->

| ID | Item | Enforcer | Status |
|----|------|----------|--------|
| R01 | No constitution principle claims a phantom gate (Principle IX self-true; VII/VIII/Governance made real-or-amended) | tools/check_constitution_gates.py | CLOSED |
| R02 | No orphan source file — every wyc/*.py + web/*.js maps to a spec or docs/UX_LOG.md | tools/check_coverage.py | CLOSED |
| R03 | docs/HANDOFF.md cited HEAD == git HEAD (handoff can't silently rot) | tools/check_handoff_fresh.py | OPEN |
| R04 | Behavioral test rung live — `node --test web/*.test.mjs` wired into ci/fast.sh | ci/fast.sh:node --test | CLOSED |
| R05 | one-panel-per-project (auto-assignment dedups by project, not thread id) | web/assign.test.mjs | CLOSED |
| R06 | editor↔terminal drag fixed (no always-goes-down; ResizeObserver can't clobber termH) | web/idegeom.test.mjs | CLOSED |
| R07 | terminal is one continuous feed, no per-command boxes, no ghosting on re-render | ci/full.sh:terminal-structure | CLOSED |
| R08 | char-level reveal with diff-aware deletions (backspace-then-type), cadence-bounded | web/reveal.test.mjs | CLOSED |
| R09 | ECC vendored for real (ecc/ rule packs present, referenced operationally) | ecc/RULES.md | CLOSED |
| R10 | docs/LESSONS.md persists this project's determinism lessons in-repo | docs/LESSONS.md | CLOSED |
| R11 | MASTER_PLAN + MODULE_BUILD_CHECKLIST reflect the UI arc + this remediation + the new gates | docs/MASTER_PLAN.md:Remediation | CLOSED |

<!-- LEDGER:END -->

## Phases

- **P0** this doc + ledger + `check_ledger.py` (the forcing function).
- **P1** meta-gates: `check_constitution_gates.py` (R01), `check_coverage.py` (R02), `check_handoff_fresh.py` (R03) — wired into `ci/fast.sh`.
- **P2** behavioral rung: `node --test` in `ci/fast.sh` (R04); pure-logic extraction pattern + render/DOM assertions in `ci/full.sh`.
- **P3** bugs red→green: one-panel (R05), drag (R06), terminal feed (R07), char-reveal+deletions (R08).
- **P4** fold orphan code into `specs/` or `docs/UX_LOG.md` until coverage (R02) is green.
- **P5** vendor ECC for real (R09).
- **P6** amend constitution (VII/VIII real), MASTER_PLAN + CHECKLIST (R11), `docs/LESSONS.md` (R10), regenerate gate-fresh `HANDOFF.md`.
- **P7** all gates green (every row CLOSED) → push. Green is the proof.

## Working rules (the determinism lesson applied to this work)
- **Red before green:** each bug lands as a failing behavioral test first, then made to pass — both tokens shown.
- **Parent authors the spine + every gate** (Principle X parent-only). Disjoint *leaves* may fan out, but only **after** the behavioral rung exists to catch them.
- **No "done" without the success token in the same message.** `ci/fast.sh` uses `set -o pipefail`.
- The gate is **honestly RED** for the whole remediation; intermediate work is committed locally, **pushed only when green** (P7).
