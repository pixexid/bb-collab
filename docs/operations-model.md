# Operations model

This is the canonical role and review matrix. It describes operating choices, not a second authority store; the decision hierarchy is in the role pages.

The role matrix reflected pre-ratification model placements from `0b6f3e54` (2026-08-15 22:22:46 -0700) through 2026-08-18; this projection now records the ratified policy.

The operator ruling, approved by the director and dated 2026-08-19, makes this matrix a preference order, not a constraint: model availability must never block work, and no lane ever goes idle waiting for a specific model. When a preferred model is unavailable, fall back in this order: a different model; a different provider variant; the same model at a different reasoning level; then the same model in a fresh session. Workers must note which fallback tier they used whenever they fall back. A fresh session is not the same participant that authored the work, because a cold review comes from the absence of authoring context rather than from different weights; it still catches the authoring session's mistakes. The k3 Tier-A review bar and deprecation-bound clause below remain separate requirements.

A separate operator ruling, approved by the director and dated 2026-08-19, makes operator-facing UI and UX work opus-class: lanes touching panels, cards, badges, icons, or interaction flows prefer `claude-code/claude-opus-5[1m]` at MEDIUM or better. This is a raised floor for that work class, not an absolute availability bar; when opus is unavailable, the fallback ladder still applies and the worker must note the tier used. Only a zero-judgment mechanical edit qualifies for routine tier: a single string or a colour token. If the change requires any visual, interaction, or UX judgment, it is not mechanical enough.

Every row is one of three kinds. A conduct bar is an absolute operator-ruled prohibition with no fallback: k3's Tier-A review bar is this kind. A model-specific qualification bar is a competence gate: Luna's hard-core implementation bar, GLM's implementation probe, and Terra's orchestration bar are this kind; the ladder does not override them, and exhaustion of qualified options escalates to the operator rather than silently routing into an unqualified model. A class floor or routing preference governs the named work class or preferred placement: the UI/UX Opus floor and all other routing rows are this kind, so the ladder applies with the mandatory tier note. The distinction is: a class-level minimum has fallback within competence; a model-specific disqualification has only re-qualification or escalation as its exit.

## Role matrix

| Role or lane | Harness/provider | Model | Reasoning | Boundary |
| --- | --- | --- | --- | --- |
| Director | Claude harness / `claude-code` or Pi harness / `pi` | `claude-opus-5[1m]` MEDIUM or `zai/glm-5.3` HIGH | MEDIUM / HIGH | Conduct bar: ratified successor to `kimi-coding/k3`; k3 is barred from Tier-A review effective 2026-08-18 by operator ruling and is deprecation-bound: no new dependencies, seats, or standing duties. Current placements re-point at this successor; no in-flight non-review k3 work remained. The earlier congestion-window use of k3 was sanctioned when it ran and is not precedent; past k3 reviews were not invalidated. GLM HIGH added as director placement by operator ruling 2026-08-19. |
| Orchestrator primary | Codex harness / `codex` | `gpt-5.6-sol` | MEDIUM | Preferred primary placement; use the fallback ladder if unavailable. |
| Orchestrator alternate | Claude harness / `claude-code` | `claude-opus-5[1m]` | MEDIUM | Preferred standing fallback when the primary account window saturates; use the fallback ladder if unavailable. |
| Merge-bound worker | Codex harness / `codex` | `gpt-5.6-luna` | Up to MAX | Operator ruling 2026-08-19: the single routine implementer, any reasoning level including MAX. Replaces `gpt-5.6-terra` (retired from this matrix); LOW and hard-core-implementation bars are lifted by the same ruling. |
| Merge-bound worker | Codex harness / `codex` | `gpt-5.6-sol` | MEDIUM to LOW | Operator ruling 2026-08-19: Sol is capped below HIGH (no HIGH, no MAX); opus is removed from worker rows by the same ruling — only the orchestrator may run opus. |
| Merge-bound worker | Pi harness / `pi` | `zai/glm-5.3` | MEDIUM or HIGH | Model-specific qualification bar: implementation waits for the named graded probe to re-qualify it; a GLM seat doing no implementation is compliant, and the ladder does not override this bar. |
| Operator-facing UI/UX lane | Claude harness / `claude-code` | `claude-opus-5[1m]` | MEDIUM or HIGH | Class floor and routing preference: preferred raised-floor placement for panels, cards, badges, icons, and interaction flows; use the fallback ladder if unavailable. Only a zero-judgment single string or colour token is mechanical enough for routine tier. |
| Tier-A reviewer | Codex harness / `codex` | `gpt-5.6-sol` | HIGH | Routing preference: prefer a cold reviewer model different from the author and prefer a different provider. If Sol authored, prefer `claude-code/claude-opus-5[1m]` MEDIUM as the non-rival reviewer, then use the fallback ladder if unavailable or overloaded, including its same-model reasoning-level and fresh-session rungs; a fresh session is not the participant that authored the work. This holds until a third non-rival is qualified for review-class work. |
| Tier-B reviewer | Codex harness / `codex` | `gpt-5.6-luna` | MEDIUM | Routing preference: prefer a model different from the author's; the fallback ladder governs when that preference is unavailable. |
| Mechanical subagent | Codex harness / `codex` | `gpt-5.6-luna` | LOW | Class routing preference: fixtures, sweeps, doc sync, and scaffolds only; artifact scope controls legality, not the spawn label. |

Every new spawn should pass explicit provider, model, reasoning, and `visibility: "visible"` flags; remembered defaults are not evidence.

The project's spawn default is `codex/gpt-5.6-sol` at MEDIUM, ruled 2026-08-18 on the GH-222 placement probe. It governs the unpinned spawn case only; a pinned dispatch follows the preferences above, with the fallback ladder available when the preferred placement is unavailable. Prefer not to use Sol to grade or review work of its own class; the ladder governs that preference, including its same-model reasoning-level and fresh-session rungs, and the default does not change it. The ruling replaced a silent fallback that nobody selected (GH-149).

### Fifth rung: degraded Tier-B review

Only when all four ordered rungs are dead, and never as an alternative to them, the lane may use a Tier-B post-merge review by `gpt-5.6-luna` at MEDIUM. The first four rungs preserve the before-merge cold-review property; this fifth rung does not, which is why it is last and conditional. The merge proceeds carrying a revert obligation bound to the post-merge Tier-B verdict. The worker must note that the fifth rung was used, and must notify the operator when it is used.

## Review tiers

| Tier | Touched surface | Merge rule |
| --- | --- | --- |
| A | Authority, canonical lifecycle, spend, concurrency, migration, review or release policy, and tracked runtime artifacts | Independent cold review of the exact candidate head before merge. |
| B | Features or refactors with no Tier-A contact | Local verification and CI before merge; cold review follows after merge. |
| C | Documentation, mechanical edits, and additive tests | Local verification and CI. |
