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
