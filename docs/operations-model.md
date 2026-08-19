# Operations model

This is the canonical role and review matrix. It describes operating choices, not a second authority store; the decision hierarchy is in the role pages.

## Role matrix

| Role or lane | Harness/provider | Model | Reasoning |
| --- | --- | --- | --- |
| Director | `claude-code` or `pi` | `claude-opus-5[1m]` or `zai/glm-5.3` | MEDIUM / HIGH |
| Orchestrator primary | `codex` | `gpt-5.6-sol` | MEDIUM |
| Orchestrator alternate | `claude-code` | `claude-opus-5[1m]` | MEDIUM |
| Merge-bound worker (routine) | `codex` | `gpt-5.6-luna` | Any, up to MAX |
| Merge-bound worker (hard) | `codex` | `gpt-5.6-sol` | MEDIUM to LOW |
| Merge-bound worker | `pi` | `zai/glm-5.3` | MEDIUM or HIGH |
| Operator-facing UI/UX lane | `claude-code` | `claude-opus-5[1m]` | MEDIUM only |
| Tier-A reviewer | `codex` | `gpt-5.6-sol` | MEDIUM only |
| Tier-B reviewer | `codex` | `gpt-5.6-luna` | Any |
| Mechanical subagent | `codex` | `gpt-5.6-luna` | LOW |

Every new spawn should pass explicit provider, model, reasoning, and `visibility: "visible"` flags; remembered defaults are not evidence.

The project's spawn default is `codex/gpt-5.6-sol` at MEDIUM, ruled 2026-08-18 on the GH-222 placement probe. It governs the unpinned spawn case only; a pinned dispatch follows the preferences above, with the fallback ladder available when the preferred placement is unavailable. Prefer not to use Sol to grade or review work of its own class; the ladder governs that preference, including its same-model reasoning-level and fresh-session rungs, and the default does not change it. The ruling replaced a silent fallback that nobody selected (GH-149).

### Degraded review (last resort)

When every preferred reviewer is unavailable, a Tier-B post-merge review by `gpt-5.6-luna` MEDIUM is permitted; the merge carries a revert obligation bound to that verdict, and the operator is notified.

## Review tiers

| Tier | Touched surface | Merge rule |
| --- | --- | --- |
| A | Authority, canonical lifecycle, spend, concurrency, migration, review or release policy, and tracked runtime artifacts | Independent cold review of the exact candidate head before merge. |
| B | Features or refactors with no Tier-A contact | Local verification and CI before merge; cold review follows after merge. |
| C | Documentation, mechanical edits, and additive tests | Local verification and CI. |
