# Feature Specification: [FEATURE NAME]

**Feature Branch**: `[NNN-feature-slug]`
**Created**: [YYYY-MM-DD]
**Status**: [Draft | In progress | Complete | Superseded by NNN]

[1–3 sentence summary: what this feature turns into what, and the single observable proof it works. Plain language — no implementation detail.]

## User Scenarios & Testing *(mandatory)*

> Prioritized user stories. **P1 = MVP** — the thinnest slice that delivers standalone value and is independently demonstrable. P2/P3 layer on. Each story is a vertical slice you could ship and test alone. Mark the MVP with 🎯.

### User Story 1 — [short title] (Priority: P1) 🎯 MVP
As a [persona], I [do/see] [what], so that [why].
**Independent test**: [how this story alone is demonstrated against real `~/.claude` data — what you start, what you observe, the latency/behavior bar].
**Acceptance**:
- Given [state/precondition], When [event], Then [observable result, with the measurable bound, e.g. "streams to the client < ~300ms later"].
- Given [...], When [...], Then [...].

### User Story 2 — [short title] (Priority: P2)
As a [persona], I [...], so that [...].
**Independent test**: [...].
**Acceptance**:
- Given [...], When [...], Then [...].
- Given [a secret-looking value is involved], Then it is redacted before it reaches the client.  *(include wherever transcript data hits the wire — Principle II)*

### User Story 3 — [short title] (Priority: P3)
As a [persona], I [...], so that [...].
**Independent test**: [...].
**Acceptance**:
- Given [...], When [...], Then [...].

### Edge Cases
- [Failure / boundary input] → [graceful behavior, no crash]. *(e.g. transcript truncated/rotated mid-tail → reader recovers)*
- [Unknown / new tool name] → [`KIND_OTHER`, still shown in the ticker]. *(total-coverage — Principle IV)*
- [Client reconnects after a gap] → [`resync` → fresh `snapshot`]. *(snapshot-then-stream — Principle VI)*
- [PLACEHOLDER edge case]

## Requirements *(mandatory)*

### Functional Requirements
> Each FR is testable and unambiguous. Reference contract symbols (`Activity`, `Terminal`, `Session`, `Thread`, `kind_for_tool`, `wyc.redact`, …) where they apply. Wire changes ⇒ bump `PROTOCOL_VERSION` + update `contracts/events.schema.json` and `wyc/contract.py` in the same change (Principle III).

- **FR-001**: [System MUST [capability], with [the concrete bound / shape].]
- **FR-002**: [PLACEHOLDER — every value rendered to a browser MUST pass through `wyc.redact` (Principle II), if applicable.]
- **FR-003**: [PLACEHOLDER — observer-never-actor: no write path targets `~/.claude/**` or any observed repo (Principle I), if applicable.]
- **FR-004**: [PLACEHOLDER]

*Mark anything underspecified rather than guessing:* `[NEEDS CLARIFICATION: question]`.

### Key Entities
- **[Entity]** — [what it represents; which contract dataclass / `$def` it maps to, or "new — add to `wyc/contract.py` + schema this spec"].
- **[Entity]** — [...].

## Success Criteria *(mandatory)*
> Measurable, technology-agnostic outcomes. Numbers (latency, counts, %) wherever possible. Demonstrable against **real** `~/.claude` data, not only fixtures (Principle XI).

- **SC-001**: [Measurable outcome — e.g. "With real sessions on this box, the UI shows them with correct project/status within ~2s of daemon start".]
- **SC-002**: [PLACEHOLDER — e.g. "An edit and a Bash command in a watched session appear within ~300ms, output included; no raw secret appears".]
- **SC-003**: [PLACEHOLDER]
- **SC-00N**: `ci/fast.sh` green (`[ci-fast] ALL GREEN`); schema↔dataclass parity test passes.  *(Principle IX — always include)*

## Assumptions
- [Runtime/access assumption — e.g. "Runs on this box with read access to `~/.claude` and clanker's `resolve_project`".]
- [Auth assumption — e.g. "Standalone auth = local token; clanker HMAC+TOTP on merge".]
- [Scope boundary deferred to a later wave — e.g. "Live PTY terminal streaming is W2; this wave's terminal output comes from transcript `tool_result`".]
- [PLACEHOLDER assumption]
