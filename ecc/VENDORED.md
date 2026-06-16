# Vendored ECC rule packs

**Source:** [`affaan-m/ECC`](https://github.com/affaan-m/ECC) · **version 2.0.0** · src commit `e25f2d4`
**Vendored:** 2026-06-16 (into `watchyourclankers/ecc/`).

These are the **reference-taste** rule packs the constitution's Governance clause names.
They are *not* the law here — the project constitution (`.specify/memory/constitution.md`)
**supersedes them on any conflict** (Governance clause). They are kept in-repo so the
reference is real and pinned, not a phantom citation (the v1.0.0 gap: the constitution
cited "vendored ECC rules" while no `ecc/` existed — see `docs/LESSONS.md` L2).

## What's here (the rule packs, not the whole repo)
| File | Role |
|---|---|
| `RULES.md` | the core rule set (the gate enforcer names this file) |
| `SOUL.md` | the project-philosophy distillation |
| `AGENTS.md` | agent-operation conventions |
| `the-security-guide.md` | security rule pack |
| `the-longform-guide.md` / `the-shortform-guide.md` | the long/short engineering guides |
| `COMMANDS-QUICK-REF.md` | command quick-reference |
| `CHANGELOG.md` · `VERSION` · `LICENSE` | provenance + license |

The full upstream repo (tooling, dashboards, CI config, node deps) is intentionally NOT
vendored — only the taste/rule documents. Re-sync by re-cloning `affaan-m/ECC` and copying
these same files; bump the version + src commit above.

## How it's operational (not nominal)
- The constitution Governance clause references `ecc/` and is gated by
  `tools/check_constitution_gates.py` (`[enforcer: ecc/RULES.md]`) — the vendoring is
  mechanically verified to exist.
- On any taste question not settled by the constitution or `docs/MODULE_BUILD_CHECKLIST.md`,
  consult these packs; where they conflict with the constitution, the constitution wins.
