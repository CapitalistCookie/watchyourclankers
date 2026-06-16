# watchyourclankers — Lessons (in-repo, persistent)

Hard-won lessons from this project's own sessions, kept **in the repo** (not only in
clanker's proposal ledger) so they survive handoffs and are re-read on session start.
Each lesson names the mechanical change that now prevents a recurrence.

## L1 — `node --check` is not a behavior gate (2026-06-16, session ff01647a)
Char-level reveal + terminal-unify were built fast by sub-agents and only **node-checked**.
They parsed clean and shipped to `main` — but were behaviorally broken (terminal ghosting,
editor↔terminal drag "always goes down"), forcing the `f632b4e` revert. Syntax ≠ behavior.
**Fix:** Principle IX now mandates a behavioral rung — `node --test web/*.test.mjs` in
`ci/fast.sh` — and interaction code only fans out behind a failing-then-passing test.

## L2 — Convention rots; only mechanical gates hold (2026-06-16, this remediation)
Audit of the constitution found ~4 of 11 `*Gate (live):*` clauses were never built
(perf-smoke, spec-coverage, the behavioral gate, vendored-ECC). **Exactly those un-gated
areas rotted**, while every mechanically-gated principle held all session.
**Fix:** `tools/check_constitution_gates.py` fails the gate if any principle claims an
enforcer that doesn't resolve. A claimed gate must be a real gate.

## L3 — The handoff doc silently rotted (2026-06-16)
`docs/HANDOFF.md` froze at an ancestor commit and never updated through the entire UI arc
or the revert, so a fresh session booted from a 3-commits-stale picture and the operator
had to route around it by reading the transcript. The on-theme `wyc handoff` *runtime*
generator was real, but the *project* handoff doc was manual and ungated.
**Fix:** `tools/check_handoff_fresh.py` fails the gate unless `HANDOFF.md`'s `HANDOFF-HEAD`
tag equals the current HEAD. The doc cannot move out of sync with the code.

## L4 — Orphan code is invisible debt (2026-06-16)
The whole UI-arc (resize/collapse/follow/top-bar) was built with no spec, no contract
reference, no doc — ungoverned. **Fix:** `tools/check_coverage.py` fails on any `wyc/*.py`
or `web/*.js` not referenced by a spec or `docs/UX_LOG.md`; the two-track model (spec for
architecture, UX_LOG for render-loop) is now honest and enforced.

## L5 — Pure-logic extraction makes interaction testable (2026-06-16)
The interaction bugs (drag sign, slot dedup, reveal cadence) live in **logic**, not in the
DOM — the DOM is just I/O. Extracting the decision into a pure, DOM-free module
(`web/assign.js`, and the reveal/geometry math) makes it unit-testable with zero deps via
`node --test`, deterministically, without a browser. Prefer this over eyeballing.

## L6 — Completeness must be a gate, not a promise (2026-06-16)
"I fixed everything" is unfalsifiable. **Fix:** `docs/REMEDIATION.md` carries a
machine-readable closure ledger and `tools/check_ledger.py` keeps `ci/fast.sh` RED until
every tracked item is closed with a live enforcer. Green *is* the proof.

## L7 — A pure-logic test is NOT a behavior test for DOM/interaction code (2026-06-16, audit)
L1 closed syntax-vs-behavior for *parsing*; the same gap reopened one layer up. A pure-logic
`node --test` (`idegeom` math) passed while the **wiring** was dead: the terminal-drag handler
bound `onDelta`'s FIRST arg (`dx`) on a *vertical* gutter, so the drag was a no-op — and a math
test structurally can't see that. **Fix:** `ci/interaction.mjs` drives REAL pointer events vs the
live daemon (asserts `gridTemplateRows` changes on a gutter drag); `tools/check_interaction_tests.py`
(rung o) makes `ide/mosaic/resize/debug.js` unable to reach green without it. **Discipline:** an
interaction fix lands RED-first against the DOM probe, and you H9-enumerate EVERY drag site — that
caught the identical wrong-arg bug in `mosaic.js` + `debug.js`. *Building a harness and then not
using it is the failure this lesson exists to prevent — the gate now forces it; it isn't optional.*

## L8 — A gate that FALSE-fails is as bad as one that false-passes (2026-06-16, harness audit)
The handoff-freshness gate (L3) was too literal: it demanded `cited == HEAD` and allowed only a
*single* HEAD~1 docs-only commit. But a session legitimately stacks several docs-only commits
(handoff + ledger + one-liner refreshes) on the last code commit — and a commit can't embed its own
sha. So a perfectly-current handoff false-failed and had to be pushed with `SKIP_CI=1`, **and**
every commit demanded a hand-edited sha (heavy all-session friction). A bypass-by-habit is how a
real failure later slips through. **Fix (R14):** freshness is now *"no CODE changed since the cited
commit"* — `cited == HEAD`, or every file in `cited..HEAD` is under `docs/` (`_only_docs_since`). It
still fails the instant code lands un-described, but never false-blocks a docs-only refresh.
**Two corollaries:** (a) gating only the *sha* let the *prose* rot (it claimed an old constitution
version while the repo raced ahead) → `_check_prose_currency` now gates the `constitution.md
(vX.Y.Z)` marker + every `main@<sha>` pointer, **scoped tightly so HISTORICAL mentions
("1.0.0→1.1.0") are not flagged** — a false-fail here would just re-teach the bypass habit (AP-8).
(b) Manual sha-editing is itself a rot source → `tools/stamp_handoff.py` regenerates every marker in
one command (`--check`/`--commit`). *Audit every gate for false-FAILS, not just false-passes: a
finicky gate trains people to bypass it, which defeats the gate.*

## L9 — The bug isn't in the file with the symptom; trace the CONTRACT seam (2026-06-16, operator rebuke ×10)
Operator (emphatic, recurring): "Are you looking at contracts and the harness and framework?" The
"terminal repeats the same command over and over" bug *looked* like a `renderTerminal` problem, and
the file-first instinct was to hand-patch it. The real cause only showed by tracing the seam:
`contracts/events.schema.json` (`Terminal` = `{ref_seq,data,done}` — no `command`/`chunks`) →
`web/store.js` (`terminalForSession` aggregates + returns **all** buffers, uncapped) →
`wyc/watcher.py` (producer is append-safe, emits each command once). The bug was the renderer
iterating ALL store buffers while its "show only latest" eviction trimmed only its OWN `termBlocks`
Map → evicted-but-still-in-store buffers looked new each tick and got re-created + re-typed. The
**same investigation surfaced a second, unreported defect** the renderer hid: the store's terminal
map was never bounded (a leak) — invisible from the renderer, obvious from the seam.
**Fix discipline:** before the first edit, read the mandated bootstrap order (constitution →
`contract.py`+`events.schema.json` → MASTER_PLAN → MODULE_BUILD_CHECKLIST → spec) and trace
CONTRACT → producer → consumer; HONOR the interaction-guard (never "it's just plumbing"); fix
RED-first via the pure tested module (`latestTerminalBuf`, the store cap). Codified in global memory
`feedback-contract-first-before-editing` because the *promise* had failed 10+ times — contract-first
is mechanical-discipline now, not a vibe.
