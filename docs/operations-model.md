# Operations model

This is the canonical role and review matrix. It describes operating choices, not a second authority store; the decision hierarchy is in the role pages.

The role matrix reflected pre-ratification model placements from `0b6f3e54` (2026-08-15 22:22:46 -0700) through 2026-08-18; this projection now records the ratified policy.

## Role matrix

| Role or lane | Harness/provider | Model | Reasoning | Boundary |
| --- | --- | --- | --- | --- |
| Director | `pi` | `kimi-coding/k3` | HIGH | Director-only, except as a Tier-A review fallback at HIGH when Sol authored. |
| Orchestrator primary | Codex harness / `codex` | `gpt-5.6-sol` | MEDIUM | Never Luna or below. |
| Orchestrator alternate | Claude harness / `claude-code` | `claude-opus-5[1m]` | MEDIUM | Standing fallback when the primary account window saturates; never Luna. |
| Merge-bound worker | Codex harness / `codex` | `gpt-5.6-luna` | MEDIUM | Routine implementation only; LOW and hard-core implementation are prohibited for Luna. |
| Merge-bound worker | Codex harness / `codex` or Claude harness / `claude-code` | `gpt-5.6-sol` or `claude-opus-5[1m]` | HIGH | Hard-core implementation only. |
| Merge-bound worker | Pi harness / `pi` | `zai/glm-5.3` | MEDIUM or HIGH | The bar applies only to implementation: no implementation until a graded probe re-qualifies it; a GLM seat doing no implementation is compliant. |
| Merge-bound worker | Codex harness / `codex` | `gpt-5.6-terra` | MEDIUM only | Merge-bound implementation is admitted by the #105 probe and the director ruling of 2026-08-18; Terra remains unqualified for orchestration. |
| Tier-A reviewer | Codex harness / `codex` | `gpt-5.6-sol` | HIGH | Cold review is Sol HIGH; reviewer model must differ from the author and a different provider is preferred. If Sol authored, use `claude-code/claude-opus-5[1m]` MEDIUM or `kimi-coding/k3` HIGH. |
| Tier-B reviewer | Codex harness / `codex` | `gpt-5.6-luna` | MEDIUM | Never the author’s model. |
| Mechanical subagent | Codex harness / `codex` | `gpt-5.6-luna` | LOW | Fixtures, sweeps, doc sync, and scaffolds only; artifact scope controls legality, not the spawn label. |

Every new spawn must pass explicit provider, model, reasoning, and `visibility: "visible"` flags; remembered defaults are not evidence.

## Review tiers

| Tier | Touched surface | Merge rule |
| --- | --- | --- |
| A | Authority, canonical lifecycle, spend, concurrency, migration, review or release policy, and tracked runtime artifacts | Independent cold review of the exact candidate head before merge. |
| B | Features or refactors with no Tier-A contact | Local verification and CI before merge; cold review follows after merge. |
| C | Documentation, mechanical edits, and additive tests | Local verification and CI. |
