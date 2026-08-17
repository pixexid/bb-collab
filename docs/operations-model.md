# Operations model

This is the canonical role and review matrix. It describes operating choices, not a second authority store; the decision hierarchy is in the role pages.

## Role matrix

| Role or lane | Harness/provider | Model | Reasoning | Boundary |
| --- | --- | --- | --- | --- |
| Director | `pi` | `kimi-coding/k3` | HIGH | Director-only; never a review fallback. |
| Orchestrator primary | Claude harness / `claude-code` | `claude-opus-5` | MEDIUM | Never Luna or below. |
| Orchestrator alternate | Codex harness / `codex` | `gpt-5.6-sol` | MEDIUM | Standing fallback when the primary account window saturates. |
| Orchestrator alternate | Codex harness / `codex` | `gpt-5.6-terra` | MEDIUM | Alternate; never Luna or below. |
| Merge-bound worker | Codex harness / `codex` | `gpt-5.6-luna` | MEDIUM or HIGH | Luna is admitted at MEDIUM or above; LOW is prohibited. |
| Merge-bound worker | Pi harness / `pi` | `zai/glm-5.3` | MEDIUM or HIGH | Admitted at MEDIUM or above. |
| Merge-bound worker | Codex harness / `codex` | `gpt-5.6-terra` | MEDIUM or HIGH | Hard work uses `codex/gpt-5.6-sol` HIGH or `claude-code/claude-opus-5` HIGH. |
| Tier-A reviewer | Codex harness / `codex` | `gpt-5.6-sol` | HIGH | `gpt-5.6-terra` HIGH is acceptable when Sol authored; never the author’s model. |
| Tier-B reviewer | Codex harness / `codex` | `gpt-5.6-luna` | MEDIUM | Never the author’s model. |
| Mechanical subagent | Codex harness / `codex` | `gpt-5.6-luna` | LOW | Fixtures, sweeps, doc sync, and scaffolds only. |

## Review tiers

| Tier | Touched surface | Merge rule |
| --- | --- | --- |
| A | Authority, canonical lifecycle, spend, concurrency, migration, review or release policy, and tracked runtime artifacts | Independent cold review of the exact candidate head before merge. |
| B | Features or refactors with no Tier-A contact | Local verification and CI before merge; cold review follows after merge. |
| C | Documentation, mechanical edits, and additive tests | Local verification and CI. |
