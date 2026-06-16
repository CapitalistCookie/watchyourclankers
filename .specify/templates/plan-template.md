# Implementation Plan: [FEATURE NAME]

**Feature Branch**: `[NNN-feature-slug]`
**Date**: [YYYY-MM-DD]
**Spec**: [specs/NNN-feature-slug/spec.md](./spec.md)

## Summary

[2–4 sentences: the primary requirement from the spec + the chosen technical approach. What you're building and the one design choice that matters most.]

## Technical Context

> Fill every field. Mark unknowns `NEEDS CLARIFICATION: ...` — do not guess.

- **Language/Version**: [e.g. Python 3.11 (backend); ES2022 vanilla JS (frontend)]
- **Primary Dependencies**: [e.g. aiohttp (server); CodeMirror 6 via CDN (no build step). NO new heavy deps without a note in Complexity Tracking.]
- **Storage**: [our state only — `/data/clanker/watchyourclankers/` (overrides, aliases, annotations). NEVER `~/.claude/**` (Principle I). Source artifacts are read-only inputs.]
- **Testing**: [pytest (`tests/`); what's a fixture vs. what's demonstrated on real `~/.claude` data per Principle XI.]
- **Target Platform**: [loopback web UI on this box; default `127.0.0.1:8900`.]
- **Performance Goals**: [the SC bounds, e.g. activity to client < ~300ms; O(1) per-activity render; editors mount only in visible tiles.]
- **Constraints**: [bind loopback only (never `0.0.0.0`); every wire value through `wyc.redact`; no build step; snapshot-then-stream with monotonic `seq`.]
- **Scale/Scope**: [e.g. N concurrent sessions + their sub-agents; high-rate surfaces (terminal/edits) are drop-slow, session/thread updates are not.]

## Constitution Check

> GATE — must pass before Phase 0 design and re-checked after design. Each binding principle: how this plan honors it, or `N/A — [why]`.

| Principle | Compliance in this plan |
|---|---|
| **I. Observer, Never Actor** | [No write path to `~/.claude/**` or observed repos. Annotations → `DATA_DIR`. / N/A] |
| **II. Secrets Never Reach the Glass** | [Every wire-bound value via `wyc.redact`; bind 127.0.0.1; token auth. / N/A] |
| **III. The Contract Is the Seam** | [Code to `contract.py` + `events.schema.json`; wire change ⇒ bump `PROTOCOL_VERSION` + both files same commit. / no wire change] |
| **IV. Total Activity Coverage** | [Every tool maps to a surface via `kind_for_tool`; unknown → `other`, never crash. / N/A] |
| **V. A Thread Survives Handoffs** | [Stitch by repo + name-stem + handoff-doc + time; overrides sticky. / N/A] |
| **VI. Snapshot-Then-Stream** | [Hydrate from `snapshot`, consume by `seq`, gap → `resync`; drop-slow high-rate only. / N/A] |
| **VII. Clanker's Idiom, Performant** | [Python+aiohttp+JSONL; vanilla JS + CDN CodeMirror, no build; O(1) render; editors in visible tiles only. / N/A] |
| **VIII. Spec Spine: Flow-Forward** | [This plan references spec id `NNN`; impl will cite it.] |
| **IX. Mechanical Gates Over Promises** | [Every gate this plan adds is live before the work it governs; `ci/fast.sh` enforces.] |
| **X. Multi-Agent Discipline** | [Parent-only files respected (see CLAUDE.md matrix); sub-agent allow-lists disjoint; parent re-verifies on merged tree.] |
| **XI. Definition of Done** | [Maps to spec id; gate green w/ token; demonstrated on real `~/.claude`; contract+schema in sync; clean-author commit.] |

**Violations / deviations**: [none | list each with the Complexity Tracking justification below]

## Project Structure

> Concrete files this feature creates/edits. Mark **(parent-only)** per the CLAUDE.md H15 matrix; everything else is a candidate sub-agent allow-list.

```
contracts/events.schema.json    (parent-only — only if wire changes)
wyc/contract.py                 (parent-only — only if wire changes)
wyc/redact.py                   (parent-only)
wyc/[new_module].py             [purpose]
hooks/post-tool-use.py          [if touched]
web/[new].js                    [purpose; agent allow-list candidate]
tests/test_[...].py             [what it proves]
specs/NNN-feature-slug/         spec.md · plan.md · tasks.md
```

**Parallelization (X):** [the disjoint sub-agent batches, or "parent inline — single slice / fails the H15 matrix". Cap 2–5 shared-tree, 8–10 worktree-first.]

## Complexity Tracking

> Only fill if the Constitution Check shows a deviation. Each row must justify the cost.

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| [e.g. new dependency X] | [concrete need] | [why vanilla / existing dep can't do it] |
