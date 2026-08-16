# Operations model

This document describes the operator-ratified queue behavior for issues #61 and
#77, the tiered review policy for #76, and the weekly throughput report for #80.
Issue #77 is the bounded
parallel-lanes slice; #76 keeps review from serializing unrelated lanes.
It is an operations model, not a second authority store. Canonical work remains
the existing WorkItem, Assignment, and ExecutionAttempt state; lane-watcher
observes that state and native BB thread interactions.

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

## Standing Decision scope

The standing orchestrator approval scope includes authority-bootstrap and
authority-maintenance acts: re-adoptions, authorized-approver registry
maintenance, and approver-scope updates. Crown-jewel human gates remain
human-only, including the exact approval required for the protected operation
itself. This is an operations-model scope extension only; canonical activation
still awaits the one exact v8 console approval bound to the project,
operation, candidate head, idempotency key, and request digest.

Authority-maintenance re-adoption has no human form. Contract v14 leaves the
exact ten-class registry unchanged; the already-bounded v11 nine-class state
remains readable but refuses `work_item_transition`. The registry check is exact
and order-sensitive: malformed, reordered, subset, extra, v9, and arbitrary
sets refuse before any receipt or canonical write. This is a v14 contract bump:
four cached consumers must reread v14 or refuse v13, with durable rollout
evidence. The cap itself is recorded by the existing adopted Decision plus
operator-authorized `config_revision`; it does not create a second authority
store.

The v14 `director-seat` amendment remains the existing project-orchestrator
role with primary `pi/kimi-coding/k3/high`, Opus-medium standby, managed-
worktree-only holder facts, and zero writing-lane capacity. Epoch-2 service on
the unmanaged canonical environment is grandfathered evidence, not generation
3 occupancy. A future successor is first preflighted and then recorded through
the receipt-gated succession apply; witness evidence and operator word do not
occupy the seat.

The approved default model for non-visual queue and documentation engineering
is `codex/gpt-5.6-luna`. On a cheap tier, an omitted reasoning value on a
mechanical subtask (fixtures, sweeps, doc sync, or scaffolds) resolves to LOW
(`low/full/default/visible`); a parent worker's HIGH or MAX effort must not
silently escalate it. The hard core may opt into an explicit HIGH or MAX value.
The spawn brief supplies the cheap-tier classification explicitly; it is not
inferred from the parent's effort.
Every spawn brief declares the requested reasoning value, and the existing
Assignment/ExecutionAttempt receipt comparison records requested versus
executed reasoning for the conformance audit. An independent cold review is
routed later to `claude-code/opus`; that review is evidence, not authority.

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
cannot claim that GitHub has enabled it. The merge-only lifecycle workflow uses
PR-number concurrency, a deterministic hidden marker, duplicate detection,
and fail-closed API errors. Because it is `pull_request_target` with
`issues: write`, checkout is pinned to `refs/heads/main`; PR head and merge
refs are never executed. It posts one Related status comment while leaving the
issue open, one no-issue rationale on the PR, or closes only an explicitly
complete `Closes` disposition after merge.

The weekly audit is a scheduled and manually dispatchable GitHub API read-only
workflow. It collects open issues and merged pull requests, then reports the
same `openCompleted`, `openIncomplete`, `unknown`, and `pass|fail|unknown`
states. API failure emits `unknown` and fails the check; the pure calculator is
not presented as a publisher. The audit never auto-closes incomplete or
unknown issues.
