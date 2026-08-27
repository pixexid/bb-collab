# Operations model

This is the canonical role and review matrix. It describes operating choices, not a second authority store; the decision hierarchy is in the role pages.

Governance scope is deliberate: canonical config defines role-generation seat profiles; this matrix defines lane routing, enforced by the dispatch-time naming and executed-profile attestation protocol below.

Tenant topology is per-project: each governed project has its own director and
project-orchestrator seat, while worker and independent-reviewer seats bind to
that project's exact repository targets. A native director thread cannot hold
multiple tenant governorships because current role context requires an exact
thread/environment/project match. Bootstrap derivation therefore transfers no
seat; it only creates the target tenant's first plugin actor from a current
source governor claim and adopted Decision.

## Role matrix

| Role or lane | Harness/provider | Model | Reasoning |
| --- | --- | --- | --- |
| Director | `claude-code` or `pi` (standby must use a different provider from the executed holder) | `pi/kimi-coding/k3`, `claude-code/claude-opus-5[1m]`, or `pi/zai/glm-5.3` | MEDIUM / HIGH |
| Orchestrator primary | `claude-code` | `claude-opus-5[1m]` | MEDIUM |
| Orchestrator alternate | `codex` | `gpt-5.6-sol` | MEDIUM |
| Merge-bound worker (routine) | `codex` | `gpt-5.6-luna` | Any, up to MAX |
| Merge-bound worker (hard) | `codex` | `gpt-5.6-sol` | MEDIUM to LOW |
| Operator-facing UI/UX lane | `claude-code` | `claude-opus-5[1m]` | MEDIUM only |
| Tier-A reviewer | `codex` | `gpt-5.6-sol` | MEDIUM only |
| Tier-B reviewer | `codex` | `gpt-5.6-luna` | Any |
| Mechanical subagent | `codex` | `gpt-5.6-luna` | LOW |

A reviewer must use a different model from the author, except where the fallback ladder below applies. The canonical store cannot verify executed conformance: execution_attempts records requested, not executed, models (GH-228), so store data alone cannot distinguish a reviewer that inherited the author's execution default from one that genuinely differed. Until get-bb/bb#1946 (strict spawn mode) or #1787 (executed-profile readback) lands, the diversity rule's dispatch-time obligation remains: the orchestrator names the reviewer's provider/model in the routing line. Provider-native session state supplies the separate verdict evidence the store lacks, and the reviewer attests under the evidence standard below.

Recent Tier-A reviews have cited native session evidence; this clause makes that the requirement and no longer accepts earlier uncited self-attestations. For each provider, model, and reasoning element, the verdict MUST cite provider-native session evidence or declare that element `UNKNOWN`; repeating the routing tuple is not execution evidence and, without native corroboration, is treated as `UNKNOWN`, not a match. `UNKNOWN` is legitimate and non-punitive: the failure is a confident claim indistinguishable from a restatement, not a seat admitting visibility limits. Tier-A gates accept only corroborated attestations; an `UNKNOWN` executed model leaves the gate unsatisfied exactly as an off-matrix dispatch does.

With one shared PR-author GitHub identity, when GitHub rejects native independent APPROVE or REQUEST_CHANGES, the orchestrator posts exactly one COMMENT review relay naming the reviewer thread, exact head, provider-native executed profile/source, findings/verdict, and discriminating proof; that relay is the semantic verdict and there is no second review.

A seat may run `npm run --silent executed-profile -- --project PROJECT_ID --thread THREAD_ID [--turn TURN_ID]` during its current turn. The reader correlates the active BB start to native records: Codex `~/.codex/sessions/YYYY/MM/DD/rollout-...-PROVIDER_SESSION_ID.jsonl` (`session_meta` plus the latest `turn_context`), Claude Code `~/.claude/projects/ENVIRONMENT_DERIVED_PATH/PROVIDER_SESSION_ID.jsonl` (latest non-synthetic assistant envelope), or Pi `~/.bb/pi-bridge-sessions/PROVIDER_THREAD_ID.jsonl`. `BB_PI_BRIDGE_SESSION_DIR` overrides the Pi directory. The Pi bridge replaces characters outside `[A-Za-z0-9._-]` with `_`, but that mapping is non-injective, so the reader accepts only provider thread IDs that need no replacement; current BB-generated thread IDs satisfy that condition. For an accepted ID, correlation uses its filename plus an exact session-header `cwd` match, reads executed provider/model from the assistant envelope on the checkpoint parent chain, and reads reasoning from its nearest ancestral `thinking_level_change`. A `model_change` is selection evidence only; a mismatch is reported but never replaces the assistant-envelope value. The residual is explicit: a foreign lossy ID could occupy the same filename as an accepted safe ID, and the file's UUID-plus-`cwd` header cannot detect that collision. Cite the returned native source and values; if exact correlation or an element is absent or ambiguous, attest that element as `UNKNOWN` while preserving independently corroborated elements. The active-turn read is diagnostic only; it cannot accept a review.

### Provisional Tier-A verdict acceptance

The independent reviewer inspects the frozen exact head without a registration-time profile proof and returns a `PROVISIONAL` verdict. The parent accepts it only through the canonical [`acceptProvisionalReview`](../scripts/review-verdict-acceptance.mjs) gate after native evidence identifies the same project, reviewer thread, turn, PR number, and candidate head, shows a successful `turn/completed`, and shows the reviewer thread natively `idle`. The verdict enum is validated before consumption. A known provider-native provider/model/reasoning tuple must equal the frozen review requirement and the reviewer's claim; requested provider/model/reasoning/service tier/permission/visibility remain dispatch provenance and never substitute for it.

Before completion or while active, the parent refuses acceptance without consuming the review pass. A first exact-turn `UNKNOWN` returns one `force-idle-and-reread-exact-turn` action. The parent confirms idle and retries that same completed turn once. A second `UNKNOWN` rejects the provisional verdict and consumes the sole documented replacement; the replacement uses the same gate. A second replacement failure blocks and escalates. Only `accepted` consumes and relays the qualified pass; provisional output, requested routing, `UNKNOWN`, rejection, and blocking never do.

When the diversity line and the Tier-A reviewer row conflict — sol-authored work requiring Tier-A review — the reviewer stays on the matrix row: `codex/gpt-5.6-sol` MEDIUM in a fresh session, named in the dispatch routing line. Opus is not a review-tier seat. Prefer a different model; when blocked, fall back to a different provider variant, then the same model at a different reasoning level, then the same model in a fresh session. A fresh session is not the same seat that authored the work and still catches the authoring session's mistakes.

The diversity line governs at every tier. Where a tier's designated reviewer shares the author's model, the dispatcher either names a differing seat in the routing line, or applies the fallback ladder and names which rung it used.

The director standby must use a different provider from the holder; same-provider pairings are refused with `ROLE_STANDBY_INVALID`.

`k3` names a decision; `kimi-coding/k3` names a SKU; `kimi-coding/k3-256k` names a different SKU and is refused by exact string. The canonical store compares exact strings, so every profile-deciding surface writes the full `provider/model` string, such as `pi/kimi-coding/k3`.

`zai/glm-5.3` is temporarily withdrawn from non-director placement to conserve peak-hour usage; the resulting one-provider worker spread is accepted for peak hours as the priced-in cost of the withdrawal; Codex is therefore the only worker provider, and Codex saturation escalates to the operator with usage data rather than re-seating on GLM.

[GH-314](https://github.com/pixexid/bb-collab/issues/314)'s routing-uniformity mirror should report any GLM worker routing as a violation while this withdrawal is in force.

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

## WorkItem `review_pending`

`review_pending` means authorship is complete but the WorkItem is still waiting on review or CI; it is non-terminal and consumes no writing capacity. The canonical state and capacity definitions are [`WORK_ITEM_STATES` and `WORK_ITEM_CAPACITY_LIFECYCLE_STATES`](../src/foundation.ts).

Independent review carries an explicit immutable candidate kind. `pull-request`
requires the exact positive PR number and 40-hex head SHA. `local`
requires exact base and candidate SHAs, authoritative existence of both
commits, the project target's managed-worktree environment and branch
checkout, the candidate server identity, an exact base-ancestor merge proof,
and an explicit clean/reachable observation. The two identities are mutually
exclusive; a local review never creates or updates a GitHub projection and is
never a `probe`. The canonical attempt also persists the exact active
independent-reviewer requirement and generation, frozen brief content/digest,
explicit `DONE`/`BLOCKED`/`WAITING` return path, and native input digest. The
candidate is re-observed immediately before every native spawn or retry; any
movement retires the spawn opportunity while preserving the prepared intent.

Enter it from `in_progress` with an exact accepted-DONE writing-attempt handoff; the completed attempt is retained as `done` and is never re-terminalized. An explicit legacy/recovery handoff is available only under its dedicated reason. Omitting a work attempt is legal for the orchestrator-verifies-the-fixed-head shape. If supplied, the attempt must be `review` with a lane, requested profile, and one explicit candidate kind; its initial thread ID is optional. These requirements and the registration are enforced by [`workAttemptSchema` and `applyWorkItemTransition`](../src/foundation.ts).

The canonical exits are [`WORK_ITEM_TRANSITIONS`](../src/foundation.ts):

- `in_progress` for request changes, with a supplied writing attempt and requested profile; the active review is superseded and a fresh writing attempt opens.
- `blocked`, only with exactly one unsatisfied machine-evaluable blocker in the same act, and with no work attempt, unblock, or external event.
- `succeeded`, `failed`, or `cancelled`, only without an open wait on this non-blocked item.

A same-state `review_pending → review_pending` re-dispatch is also allowed. It supersedes the active review and registers a replacement, but the replacement must include a lane, thread, requested profile, PR number, and PR head SHA, with an active prior review carrying the same PR number and head SHA. These rules are enforced by [`applyWorkItemTransition`](../src/foundation.ts).

`workItemReconciliationIssues` reports `review_attempt_count` only when a `review_pending` item has more than one active review attempt; zero is accepted. Any reconciliation issue blocks the next project-orchestrator succession, while an unseated project-orchestrator uses first-generation creation ([`workItemReconciliationIssues`](../src/foundation.ts), [`applyWorkItemTransition`](../src/foundation.ts)).

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

Before any role-directed tell, resolve the desired role and target thread through the live current-role surface: `bb collab role-list --project PROJECT_ID`. Proceed only when exactly one active binding matches both. Zero matches means the thread is unseated; multiple matches or an unreadable store mean refuse. Native thread attributes may then be checked for reachability, never for standing.

Inferring a recipient's role from surface attributes is the same error as reading a mounted worktree instead of the branch head, one level up. On 2026-08-19 a recovery wake ordered a seat to resume a duty it had not held for two days; the seat declining is the only thing that stopped it, which means the control was the recipient's judgement rather than anything the sender consulted.
