# Tasks: [FEATURE NAME]

**Feature Branch**: `[NNN-feature-slug]`
**Spec**: [specs/NNN-feature-slug/spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

## Format

`[ID] [P?] [Story] Description (→ file path)`

- **[ID]** — `T001`, `T002`, … sequential.
- **[P]** — present ⇒ parallelizable (different file, no unfinished dependency). Absent ⇒ runs in order / shares a file with a sibling.
- **[Story]** — the user story this serves: `[US1]` / `[US2]` / `[US3]`, or `[Setup]` / `[Found]` / `[Polish]`.
- Always name the concrete file path. TDD: the red test task precedes its implementation task (AP-1 — never write impl and test in the same step).

---

## Phase 1: Setup (shared prerequisites)

- [ ] T001 [Setup] [PLACEHOLDER — module/package skeleton, deps note (no new heavy deps), lint/format baseline]
- [ ] T002 [P] [Setup] [PLACEHOLDER — test scaffolding / fixtures dir; note which fixtures vs. real-`~/.claude` demos (Principle XI)]

## Phase 2: Foundational (BLOCKS all user stories)

> Prerequisites every story needs. Contract/schema changes land here (parent-only). **No user-story phase starts until this phase is done.**

- [ ] T003 [Found] [PLACEHOLDER — if the wire changes: bump `PROTOCOL_VERSION` + update `contracts/events.schema.json` AND `wyc/contract.py` together (Principle III) → contracts/events.schema.json, wyc/contract.py]
- [ ] T004 [Found] [PLACEHOLDER — shared util / `wyc.redact` extension other stories depend on]

**Checkpoint:** foundation ready — user-story phases may now begin (and may run in parallel if disjoint).

---

## Phase 3: User Story 1 — [title] (P1) 🎯 MVP

**Goal:** [the standalone value]
**Independent test:** [from spec — how US1 alone is demonstrated against real `~/.claude`]

- [ ] T005 [P] [US1] [Red test] [PLACEHOLDER — failing test; confirm red before T006] → tests/test_[...].py
- [ ] T006 [US1] [PLACEHOLDER — minimum impl to pass T005] → wyc/[...].py
- [ ] T007 [P] [US1] [PLACEHOLDER — redaction assertion on this story's wire path, if it carries transcript data (Principle II)] → tests/test_[...].py

**Checkpoint:** US1 demonstrable end-to-end on real data, independently of US2/US3. **This is the shippable MVP.**

---

## Phase 4: User Story 2 — [title] (P2)

**Goal:** [...] · **Independent test:** [...]

- [ ] T008 [P] [US2] [Red test] [PLACEHOLDER] → tests/test_[...].py
- [ ] T009 [US2] [PLACEHOLDER — impl] → wyc/[...].py

**Checkpoint:** US1 + US2 both work independently.

---

## Phase 5: User Story 3 — [title] (P3)

**Goal:** [...] · **Independent test:** [...]

- [ ] T010 [P] [US3] [Red test] [PLACEHOLDER] → tests/test_[...].py
- [ ] T011 [US3] [PLACEHOLDER — impl] → web/[...].js

**Checkpoint:** all stories independently functional.

---

## Phase 6: Polish & cross-cutting

- [ ] T012 [P] [Polish] [PLACEHOLDER — edge cases from the spec (truncated tail, unknown tool → `other`, resync after gap)]
- [ ] T013 [P] [Polish] [PLACEHOLDER — perf smoke (O(1) render; N concurrent sessions no jank) per Principle VII]
- [ ] T014 [Polish] Demonstrate the slice on **real** `~/.claude` data (Principle XI) + run `ci/fast.sh`; confirm `[ci-fast] ALL GREEN` in the same message (Principle IX).

---

## Dependencies & Execution Order

- **Phase order:** Setup → Foundational → (US1 → US2 → US3 by priority) → Polish.
- **Foundational blocks everything**; within a story, the red test blocks its impl.
- **User-story independence:** once Foundational is done, disjoint stories may run in parallel; nothing in US2/US3 may depend on the others to *demonstrate* (a P2 may build atop P1, but P1 must stand alone).
- **[P] tasks** in the same phase touch different files with no pending dependency — safe to parallelize / fan out (see CLAUDE.md agent↔parent matrix; parent-only files never go to a sub-agent).

## Implementation Strategy

**MVP first.** Land Phase 1 + Phase 2 + Phase 3 (US1) → demonstrate on real `~/.claude` → that is a shippable increment. Then add US2, then US3, validating each independently before the next. Stop-and-ship is valid after any completed checkpoint. No "done/green" claim without the matching success token in the same message (Principle IX / iron-law of evidence).
