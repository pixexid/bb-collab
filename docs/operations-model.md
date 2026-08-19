# Operations model

This is the canonical role and review matrix. It describes operating choices, not a second authority store; the decision hierarchy is in the role pages.

## Role matrix

| Role or lane | Harness/provider | Model | Reasoning |
| --- | --- | --- | --- |
| Director | `claude-code` or `pi` | `claude-opus-5[1m]` or `zai/glm-5.3` | MEDIUM / HIGH |
| Orchestrator primary | `claude-code` | `claude-opus-5[1m]` | MEDIUM |
| Orchestrator alternate | `codex` | `gpt-5.6-sol` | MEDIUM |
| Merge-bound worker (routine) | `codex` | `gpt-5.6-luna` | Any, up to MAX |
| Merge-bound worker (hard) | `codex` | `gpt-5.6-sol` | MEDIUM to LOW |
| Merge-bound worker | `pi` | `zai/glm-5.3` | MEDIUM or HIGH |
| Operator-facing UI/UX lane | `claude-code` | `claude-opus-5[1m]` | MEDIUM only |
| Tier-A reviewer | `codex` | `gpt-5.6-sol` | MEDIUM only |
| Tier-B reviewer | `codex` | `gpt-5.6-luna` | Any |
| Mechanical subagent | `codex` | `gpt-5.6-luna` | LOW |

Every new spawn should pass explicit provider, model, reasoning, and `visibility: "visible"` flags; remembered defaults are not evidence.

The spawn default is `codex/gpt-5.6-luna` MAX for unpinned spawns.

### Degraded review (last resort)

When every preferred reviewer is unavailable, a Tier-B post-merge review by `gpt-5.6-luna` MEDIUM is permitted; the merge carries a revert obligation bound to that verdict, and the operator is notified.

## Review tiers

| Tier | Touched surface | Merge rule |
| --- | --- | --- |
| A | Authority, canonical lifecycle, spend, concurrency, migration, review or release policy, and tracked runtime artifacts | Independent cold review of the exact candidate head before merge. |
| B | Features or refactors with no Tier-A contact | Local verification and CI before merge; cold review follows after merge. |
| C | Documentation, mechanical edits, and additive tests | Local verification and CI. |

## Escalation

Escalation is the director's, held directly. There is no named escalation seat: one existed, was stood down by the operator for noise, and re-creating it would re-create the noise under a new name.

| Path | Route |
| --- | --- |
| Work-level | worker → orchestrator → director |
| Operator-level | director → operator, via the inbox, under severity rules |
| No-seat floor | the `fleet-watchdog` schedule |

The floor is the part that is easy to miss. `fleet-watchdog` subsumed the retired `sentinel-wake-floor` schedule, so escalation coverage was never lost when the seat stood down — it **relocated from a seat to a schedule**. That relocation was not written down, and on 2026-08-19 two seats independently concluded coverage was missing before checking. It is written down here so the next reader inherits the decision rather than the silence.

### A role's definition and a seat's standing are different questions

A thread's title, status, and pinned flag say nothing about whether it still holds its role. A stood-down or re-scoped seat keeps its original title, still reports `active`, and still errors and recovers like any other — so every surface a dispatcher naturally reads will describe a role the seat may no longer hold.

Two different things are canonical in two different places, and conflating them is how this goes wrong:

| Question | Canonical source |
| --- | --- |
| What is this role, normatively? | the role definition under `docs/roles/` |
| Who currently holds it, and do they still? | the `role_generation_heads` current-role query in the plugin database |

The role pages say so themselves — "Live state is never this page" — and a checked-in file cannot answer a question whose answer changes without a commit. **A dispatcher reading thread surfaces is reading titles, not roles; a dispatcher reading `docs/roles/` is reading the definition, not the standing.**

Inferring a recipient's role from surface attributes is the same error as reading a mounted worktree instead of the branch head, one level up. On 2026-08-19 a recovery wake ordered a seat to resume a duty it had not held for two days; the seat declining is the only thing that stopped it, which means the control was the recipient's judgement rather than anything the sender consulted.
