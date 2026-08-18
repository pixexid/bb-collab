# Operations model

This is the canonical role and review matrix. It describes operating choices, not a second authority store; the decision hierarchy is in the role pages.

The role matrix reflected pre-ratification model placements from `0b6f3e54` (2026-08-15 22:22:46 -0700) through 2026-08-18; this projection now records the ratified policy.

## Role matrix

| Role or lane | Harness/provider | Model | Reasoning | Boundary |
| --- | --- | --- | --- | --- |
| Director | `claude-code` | `claude-opus-5[1m]` | MEDIUM | Ratified successor to `kimi-coding/k3`; k3 is barred from Tier-A review effective 2026-08-18 by operator ruling and is deprecation-bound: no new dependencies, seats, or standing duties. Current placements re-point at this successor; no in-flight non-review k3 work remained. The earlier congestion-window use of k3 was sanctioned when it ran and is not precedent; past k3 reviews were not invalidated. |
| Orchestrator primary | Codex harness / `codex` | `gpt-5.6-sol` | MEDIUM | Never Luna or below. |
| Orchestrator alternate | Claude harness / `claude-code` | `claude-opus-5[1m]` | MEDIUM | Standing fallback when the primary account window saturates; never Luna. |
| Merge-bound worker | Codex harness / `codex` | `gpt-5.6-luna` | MEDIUM | Routine implementation only; LOW and hard-core implementation are prohibited for Luna. |
| Merge-bound worker | Codex harness / `codex` or Claude harness / `claude-code` | `gpt-5.6-sol` or `claude-opus-5[1m]` | HIGH | Hard-core implementation only. |
| Merge-bound worker | Pi harness / `pi` | `zai/glm-5.3` | MEDIUM or HIGH | The bar applies only to implementation: no implementation until a graded probe re-qualifies it; a GLM seat doing no implementation is compliant. |
| Merge-bound worker | Codex harness / `codex` | `gpt-5.6-terra` | MEDIUM only | Merge-bound implementation is admitted by the #105 probe and the director ruling of 2026-08-18; Terra remains unqualified for orchestration. |
| Tier-A reviewer | Codex harness / `codex` | `gpt-5.6-sol` | HIGH | Cold review is Sol HIGH; reviewer model must differ from the author and a different provider is preferred. If Sol authored, the only remaining non-rival reviewer is `claude-code/claude-opus-5[1m]` MEDIUM. That provider returned repeated overload errors on 2026-08-18; if this review dies on provider congestion, re-route to Tier B for a post-merge review by `gpt-5.6-luna` at MEDIUM, a different model and class that cannot have authored the work, and condition the merge explicitly on that verdict. This holds until a third non-rival is qualified for review-class work. |
| Tier-B reviewer | Codex harness / `codex` | `gpt-5.6-luna` | MEDIUM | Never the author’s model. |
| Mechanical subagent | Codex harness / `codex` | `gpt-5.6-luna` | LOW | Fixtures, sweeps, doc sync, and scaffolds only; artifact scope controls legality, not the spawn label. |

Every new spawn must pass explicit provider, model, reasoning, and `visibility: "visible"` flags; remembered defaults are not evidence.

The project's spawn default is `codex/gpt-5.6-sol` at MEDIUM, ruled 2026-08-18 on the GH-222 placement probe. It governs the unpinned spawn case only; a pinned dispatch follows the matrix above. Sol remains barred from grading or reviewing work of its own class, and the default does not change that. The ruling replaced a silent fallback that nobody selected (GH-149).

## Review tiers

| Tier | Touched surface | Merge rule |
| --- | --- | --- |
| A | Authority, canonical lifecycle, spend, concurrency, migration, review or release policy, and tracked runtime artifacts | Independent cold review of the exact candidate head before merge. |
| B | Features or refactors with no Tier-A contact | Local verification and CI before merge; cold review follows after merge. |
| C | Documentation, mechanical edits, and additive tests | Local verification and CI. |
