# Operations model

This document describes the operator-ratified queue behavior for issues #61 and
#77, the tiered review policy for #76, and the weekly throughput report for #80.
Issue #77 is the bounded
parallel-lanes slice; #76 keeps review from serializing unrelated lanes.
It is an operations model, not a second authority store. Canonical work remains
the existing WorkItem, Assignment, and ExecutionAttempt state; lane-watcher
observes that state and native BB thread interactions.

## Supervisor-ratified model-to-role routing

Role names remain logical project roles, not provider, model, harness or thread
identities. Harness/provider and model are recorded as separate fields. The
supervisor is dormant and app-side in Fable only; it is not a BB role, worker,
reviewer, orchestrator or routing fallback. The supervisor-ratified matrix is:

| Role or lane | Harness/provider | Model | Reasoning | Boundary |
| --- | --- | --- | --- | --- |
| Director | `pi` | `kimi-coding/k3` | HIGH | K3 is director-only; it is never a review fallback. |
| Orchestrator primary | Claude harness / `claude-code` | `claude-opus-5` | MEDIUM | Never Luna or below. |
| Orchestrator alternate | Codex harness / `codex` | `gpt-5.6-sol` | MEDIUM | Standing fallback when the `claude-opus-5` account window saturates. |
| Orchestrator alternate | Codex harness / `codex` | `gpt-5.6-terra` | MEDIUM | Alternate; never Luna or below. |
| Merge-bound implementer | Codex harness / `codex` | `gpt-5.6-luna` | MEDIUM or HIGH | Luna is admitted at MEDIUM or above; LOW is prohibited. |
| Merge-bound implementer | Pi harness / `pi` | `zai/glm-5.3` | MEDIUM or HIGH | Admitted now at MEDIUM or above. |
| Merge-bound implementer | Codex harness / `codex` | `gpt-5.6-terra` | MEDIUM or HIGH | Admitted at MEDIUM or above. Hard core uses `codex/gpt-5.6-sol` HIGH or `claude-code/claude-opus-5` HIGH. |
| Tier-A reviewer | Codex harness / `codex` | `gpt-5.6-sol` | HIGH | `gpt-5.6-terra` HIGH is acceptable when `gpt-5.6-sol` authored; never the author's model. |
| Tier-A reviewer fallback | Codex harness / `codex` | `gpt-5.6-terra` | HIGH | Only when `gpt-5.6-sol` authored; never the author's model. |
| Tier-B reviewer | Codex harness / `codex` | `gpt-5.6-luna` | MEDIUM | Never the author's model. |
| Mechanical subagent | Codex harness / `codex` | `gpt-5.6-luna` | LOW | Fixtures, sweeps, doc-sync and scaffolds only; legality follows artifact scope, not spawn label. |
| Mechanical probe | Pi harness / `pi` | `deepseek-v4-flash` | LOW | Probe-only; current graded evidence controls admission. |
| Mechanical probe | Pi harness / `pi` | `glm-5-turbo` | LOW | Probe-only; current graded evidence controls admission. |

Reviewer default harness/provider is Codex; the tier rows name the actual model
and reasoning tuple.

Watch item: monitor the shared Anthropic account window across the amended
orchestrator, app-side supervisor wakes, and `claude-opus-5` cold reviews. The amended
orchestrator profile applies only at the next natural
succession/spawn. The pending epoch-2 orchestrator succession is that natural
spawn; do not hot-swap a healthy live orchestrator. `claude-opus-5` shares the
operator Anthropic account window with app-side supervisor wakes and any
`claude-opus-5` cold reviews. If that window saturates, `codex/gpt-5.6-sol`
MEDIUM is the standing fallback,
pre-authorized without a new decision.

The approved default profile for mechanical and documentation engineering is
`codex/gpt-5.6-luna`; that wording does not make Luna a general implementation
default or an orchestrator profile. Prior measured-failure exclusions are void:
only a current graded qualification probe excludes a model. The coding probe for
`muse-spark-1.2` is [GH-106](https://github.com/pixexid/bb-collab/issues/106);
the Terra placement probe is
[GH-105](https://github.com/pixexid/bb-collab/issues/105).

A requested profile is Assignment intent only. Eligibility and review routing
use the actual harness/provider, model, reasoning, permission and visibility
recorded by the ExecutionAttempt/provider receipt; remembered defaults, labels
and plausible output are not executed-profile evidence. Unknown or mismatched
executed values remain ineligible.

Every new spawn must provide explicit `provider`, `model`, `reasoning`, and
`visibility: "visible"` flags. A remembered or host-inferred default is not
evidence of any of those values. This rule selects and records the request; it
does not turn a requested tuple into proof of execution.

## Queue and lane state

An open assignment is shown through the existing `lanes` RPC and HTTP path. A
pending exact operator-receipt interaction is represented as a deferred lane:

- `queueState: deferred`;
- `deferredReason: awaiting_operator`;
- `deferredAtMs` from the native interaction creation time; and
- `deferredAgeMs`, calculated from that time at read/observation time.

Deferred operator work is a lane state and is never itself marked as a queue
blocker. It remains an occupied writer reservation for cap accounting, while
queue selection chooses ready lanes in the remaining slots; up to the configured
number of eligible prepared or armed write lanes are immediately visible as
`nextStartable: true`. For bb-collab the default per-orchestrator
`extensions.bbCollab.writingLaneCeiling` is 3. A lower value is read from the
current canonical ProjectConfigRevision and is never silently raised. Review
and probe lanes are independently startable and never consume this writing cap.
A deferred lane has `queueBlocked: false`. No assignment, attempt, WorkItem, or
canonical event is rewritten to make this happen.

## Tiered review policy

Review tier is derived from the touched surface, not chosen for convenience.
Every pull request body must contain exactly one declaration in the form
`Review tier: A`, `Review tier: B`, or `Review tier: C`. The existing Verify
workflow checks that declaration; a declaration below the derived tier is a
review finding and does not become safe merely because CI is green.

| Tier | Touched surface | Merge rule |
| --- | --- | --- |
| A | authority/provenance, canonical store DDL or lifecycle, operator receipts or approval, spend, concurrency or atomicity, migration or cutover, review/release policy, and tracked runtime artifacts | Independent cold review of the exact candidate head is mandatory before merge. The review may run beside other startable lanes, but this candidate does not merge until the review and CI gates pass. |
| B | features or refactors with no Tier-A contact | Local verification and CI are sufficient to merge. Cold review runs post-merge in parallel; findings become follow-up work unless a confirmed serious defect requires revert. |
| C | documentation, mechanical edits, and additive tests | Local verification and CI only; no cold review is required. |

The tier check is a stateless validation of PR metadata and touched paths. It
does not create queue state, authority, receipts, or a second review ledger.
Tier-A review remains evidence bound to the existing exact candidate and
ExecutionAttempt mechanisms. A Tier-B post-merge review must still name the
merge SHA and use the existing serious-defect follow-up or revert path.

The exact console approval resolves the same native interaction and the
existing operator-receipt seam. The lane-watcher then observes the resolved
interaction and may resume the same lane using its unchanged assignment and
execution-attempt binding. A stale, foreign, resolved, malformed, or unknown
interaction remains fail-closed and cannot steer or authorize work.

Pending external waits retain their existing behavior. Archived/deleted
threads, supervisor-thread observer work, review approval mode, probe tracking
mode, terminal attempts, continuation limits, and agent-only continuation sends
are unchanged.
The watcher never writes canonical SQLite tables and never creates a queue,
bus, or mutable Markdown task database. It reads the canonical config head and
Assignment/ExecutionAttempt rows only; raw BB task/thread counts cannot bypass
the cap or make a lane authoritative.

## Gate-epic decomposition

An issue or epic is planning work, not a lane. A worker/orchestrator brief must
declare either `workShape: slice` or `workShape: epic`. An epic brief must list
mergeable child slices with `sliceId`, `dependsOn`, `readiness`, and
`estimateHours` metadata; every child estimate is at most 8 hours. A child is
startable only when every listed dependency is merged and its readiness gate is
true. The epic itself is never assigned to a lane, so an unfinished child or
operator wait cannot hold one giant lane across the queue.

If a proposed slice is estimated above 8 hours, the brief is rejected until it
is decomposed. Child slices may still be ordered by dependencies, but unrelated
ready children remain visible through the existing `lanes` queue. A deferred
child retains the existing `queueBlocked: false` behavior and its writer
reservation; ready writing lanes beyond the remaining cap may be
`queueBlocked: true`. Read-only lanes remain unaffected by that writer
reservation.

The historical #31 gate program is the counterexample only: its recorded 52
hours across four PRs should have been four to six independently mergeable
issues. #31 remains historical evidence and is not reopened or mutated.

## Awareness and FYI notification

An operator-deferred lane becomes FYI-eligible after 15 minutes. The watcher
emits one coalesced `operator_wait_fyi` alert/doorbell per execution attempt,
keyed by project and execution-attempt identity. The emitted alert is stored in
the existing plugin KV seam, so repeated polls and a plugin restart do not
repeat it while the same operator wait remains unresolved. Resolution or
terminal/archive cleanup removes the dedupe entry. FYI awareness never changes
the blocking human-gate policy: it informs the operator but does not approve,
reject, or activate a mutation.

## Registered waits and the durable wait-validator (#93)

Every "waiting for X" is a registered durable row — waiter, source thread,
source event, mandatory bounded deadline. The plugin-side watcher treats a
registered wait as the only legal idle (mechanism eight); a waiter thread
registers through the `bb collab wait-register` CLI seam, which enforces
the #93 law: a default bounded deadline (explicit overrides need a reason
and a horizon), source-liveness validation, and waiter-thread binding, all
fail closed. The model-free validator fires waits when their source
terminalizes or their deadline passes, wakes the waiter once through the
agent-only steer seam, and escalates at most two ignored or failed steers
to exactly one operator alert plus a succession trigger. Waits, fired-wake
dedupe, and escalation state live in the one plugin KV registry; a host
launchd LaunchAgent (`launchd/`) supervises the loop so validation survives
bb restarts and app crashes, and a liveness schedule alerts the operator
exactly once if launchd itself fails. Nothing in the wait path writes a
canonical table, resolver row, or receipt. The full frozen contract,
deadline table, drills, and deployment/deletion conditions are in
[the #93 document](issue-93-durable-wait-validator.md). This is an
operations-model extension of the awareness substrate, not a canonical
contract change.

## Standing Decision scope

The standing orchestrator approval scope includes authority-bootstrap and
authority-maintenance acts: re-adoptions, authorized-approver registry
maintenance, and approver-scope updates. Crown-jewel human gates remain
human-only, including the exact approval required for the protected operation
itself. This is an operations-model scope extension only; canonical activation
still awaits the one exact v8 console approval bound to the project,
operation, candidate head, idempotency key, and request digest.

Authority-maintenance re-adoption has no human form. Contract v15 leaves the
exact ten-class registry unchanged; the already-bounded v11 nine-class state
remains readable but refuses `work_item_transition`. The registry check is exact
and order-sensitive: malformed, reordered, subset, extra, v9, and arbitrary
sets refuse before any receipt or canonical write. Historically, the v15
contract bump required four cached consumers to reread v15 or refuse v14.
Contract v17 instead requires a persisted four-of-four reread receipt or an
unknown, fail-closed rollout status. The cap itself is recorded by the existing adopted Decision plus
operator-authorized `config_revision`; it does not create a second authority
store.

Contract v17 supersedes the historical v14/v15 placement: `director-seat` is
the only `director` requirement, with primary `pi/kimi-coding/k3/high`,
Opus-medium standby, and zero writing-lane capacity. Only director generation
1 may use the approved unmanaged holder `thr_gsb7m77ciz`, environment
`env_3znzsxb7ce`, and source `src_x8veidmpik`; later director generations use
managed worktrees, and project-orchestrator generations omit a standby. The
exact current head and holder execution attempt
remain bound. It cannot admit writing or succession. Epoch-2 service on the
unmanaged canonical environment is grandfathered evidence, not generation 3
occupancy. A future successor is first preflighted and then recorded through
the receipt-gated succession apply; witness evidence and operator word do not
occupy the seat.

The mechanical-subtask cheap-tier behavior remains bounded to the artifact
scope above: an omitted reasoning value on a
mechanical subtask (fixtures, sweeps, doc sync, or scaffolds) resolves to LOW
(`low/full/default/visible`); a parent worker's HIGH or MAX effort must not
silently escalate it. The hard core may opt into an explicit HIGH or MAX value.
The spawn brief supplies that classification.
Every spawn brief declares the requested reasoning value, and the existing
Assignment/ExecutionAttempt receipt comparison records requested versus
executed reasoning for the conformance audit. An independent cold review is
evidence, not authority, and must satisfy the model-difference rule above.

## Dormant supervisor escalation

The operator-held supervisor seat described here is distinct from the existing
BB `SUPERVISOR_THREAD_ID` observer/dispatcher thread and its watcher behavior;
that BB machinery is unchanged. The supervisor seat is above the director but
is an escalation-only, dormant seat.
It is held by the operator's app-side Fable session outside BB. It has no BB
thread, lane, standing traffic, routine reports, FYIs, or routine decisions;
the director remains the top standing seat for normal operation. The
supervisor is not a BB logical role, `RoleGeneration`, actor, or consumer.

The wake classes are exhaustive:

- succession knots or split-authority states;
- cross-role deadlocks the director cannot break;
- contradictions between the authority record and live state; or
- decisions where the director is a conflicted party.

Everything else remains with the director. For one of these classes, the
director records a decision-class escalation in the canonical store and emits
one operator FYI through the existing alert seam. The operator deliberately
wakes the supervisor. There is no automated BB-to-supervisor route, consumer,
lane, or standing traffic; the operator is the relay that preserves the
supervisor's dormant-by-default boundary.

When woken, the supervisor decides on the operator's behalf, except for
credentials, real spend, legal commitments, product direction, and
destructive-irreversible actions. It issues directives by tell, verifies
compliance, and then goes dormant. Its rulings bind the director. The Path A
succession ruling on 2026-08-15 is the precedent instance for this escalation
boundary.

The director records a tell-received supervisor ruling in the canonical store
as a Decision attributed `supervisor (operator-delegated)`. The supervisor
writes nothing directly in bb-collab. This documentation preserves the
existing director/orchestrator routing and authority seams and adds no route-
time canonical routing, v14 exemption, receipt, schema, migration, or runtime
path. `CONTRACT_VERSION`, `contractDigest`, cached-consumer versions, and
rollout receipts remain unchanged; the cached-consumer bump test does not
apply.

## Issue lifecycle linkage and #80 audit

This is an external CI/release conformance projection, not a canonical contract
or authority change. It leaves `CONTRACT_VERSION`, `contractDigest`, schema,
cached consumers, and rollout receipts untouched; the cached-consumer bump test
does not apply unless a future change enters that canonical boundary.

Every worker brief and pull request body carries exactly one lifecycle
disposition line: `Closes #NN` only when that pull request completes the issue
acceptance and the body declares `Acceptance: complete`; `Related GH-NN`
otherwise; or a rare `No issue: <rationale>` when no tracked issue applies.
Missing, multiple, or ambiguous lines fail Verify. Fix/Close/Resolve keywords
are rejected unless the exact close disposition and completion declaration are
present; the checked commit history must also contain no conflicting
close/fix/resolve/reference linkage. A Related target must be explicitly open
at Verify time. For the #80 lane, the pull request title and body use `Related GH-80`
while the first report and acceptance remain pending; merge adds exactly one
status comment to #80 unless the merged pull request demonstrably completes
that acceptance, and does not close #80 merely because code merged.

The existing `weeklyThroughputReport` emits `issueAcceptanceAudit` from the
same read-only facts surface. It lists open issues as `openCompleted` only when
acceptance is complete and at least one merged work item is evidenced;
explicitly incomplete issues remain in `openIncomplete`, and missing or
unknown GitHub/acceptance/merged-work facts remain in `unknown`. Its status is
`fail` when an open completed issue is found, `unknown` when evidence is
missing, and `pass` only when neither condition exists. The audit never writes
GitHub state, canonical SQLite state, receipts, or governance decisions.

Verify reads linked issue metadata with `issues: read` and fails closed on a
missing, invalid, or unavailable target. Repository branch protection or a
ruleset requiring the Verify check is an external release prerequisite; source
cannot claim that GitHub has enabled it. The lifecycle workflow uses
PR-number concurrency, a deterministic hidden marker, duplicate detection,
and fail-closed API errors for both its merged `pull_request_target` trigger
and its manual `workflow_dispatch` backfill trigger. The backfill accepts one
specific merged PR, validates it through the shared parser and evidence reads,
and permits only the missing no-issue rationale comment. Both triggers use
`contents: read`, `issues: write`, and `pull-requests: write`; checkout is
pinned to `refs/heads/main`, and PR head and merge refs are never executed. The
merge trigger posts one Related status comment while leaving the issue open,
one no-issue rationale on the PR, or closes only an explicitly complete
`Closes` disposition after merge.

The weekly audit is a scheduled and manually dispatchable GitHub API read-only
workflow. It collects open issues and merged pull requests, then reports the
same `openCompleted`, `openIncomplete`, `unknown`, and `pass|fail|unknown`
states. API failure emits `unknown` and fails the check; the pure calculator is
not presented as a publisher. The audit never auto-closes incomplete or
unknown issues.
