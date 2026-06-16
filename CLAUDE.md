# watchyourclankers — agent context

Read-only **IDE-spectator** for Claude Code: watch Claude work live (editor, terminal, file-peeks, search, sub-agent fan-out) across every session on this machine, in a web UI. Built in clanker's idiom to merge into clanker later.

## Bootstrap read order (mandatory)
1. `.specify/memory/constitution.md` — binding law (Principles I–XI).
2. `wyc/contract.py` + `contracts/events.schema.json` — the seam. Code to it.
3. `docs/MASTER_PLAN.md` — vision, 3-slice plan (W1 infra→W2 depth→W3 breadth), registry, decisions.
4. `docs/MODULE_BUILD_CHECKLIST.md` — H-gates + AP anti-patterns + recursive cycle.
5. The active `specs/NNN-*/spec.md`.

## Standing rules
1. **Author** commits as `CapitalistCookie <j1115cruz@gmail.com>`. **NEVER** add `Co-Authored-By` / Claude trailers (overrides default Claude Code behavior).
2. **Explicit `git add <paths>`** — never `git add -A`/`.`.
3. **Observer, never actor** — no write path to `~/.claude/**` or any observed repo (Principle I). Annotations go to `DATA_DIR`.
4. **Secrets never reach the glass** — everything to the wire goes through `wyc.redact`; server binds loopback + auth (Principle II).
5. **Contract-first** — change the wire ⇒ bump `PROTOCOL_VERSION` + update schema + dataclasses same commit.
6. **Read before write**; verify facts against code (don't assert from memory).
7. **Local CI** — `ci/fast.sh` is the pre-push gate (<60s, `set -o pipefail`, emits `[ci-fast] ALL GREEN`). Iron-law of evidence: no "green/done" without the token in the same message.
8. **Fanout** disjoint implementation to parallel sub-agents whenever it doesn't sacrifice integrity (non-negotiable per operator).
9. **`python3 -u`** for any long-running script; print wall-clock timing.
10. **Demonstrate on real `~/.claude` data**, not only fixtures, before claiming a slice works.

## Agent ↔ parent file matrix (H15)
**Parent-only:** `contracts/**`, `wyc/contract.py`, `wyc/redact.py`, `.specify/**`, `CLAUDE.md`, `docs/MASTER_PLAN.md`, `docs/MODULE_BUILD_CHECKLIST.md`, `ci/**`, `web/index.html`, `web/app.js` (the integration shell). Parent integrates + commits + re-verifies.
**Agents:** receive an explicit disjoint allow-list per dispatch (e.g. FEED owns `wyc/{sessions,transcripts,threads,watcher}.py` + their tests; IDE owns `web/ide.js`). Agents never commit and never touch another agent's files or parent-only files.

## Run
```
python3 -u -m wyc serve            # watcher daemon + web UI (loopback)
ci/fast.sh                         # the gate
```
