# Operations model

This document describes the operator-ratified queue behavior for issues #61 and
#77, and the tiered review policy for #76. Issue #77 is the bounded
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
threads, supervisor work, review approval mode, probe tracking mode, terminal
attempts, continuation limits, and agent-only continuation sends are unchanged.
The watcher never writes canonical SQLite tables and never creates a queue,
bus, or mutable Markdown task database. It reads the canonical config head and
Assignment/ExecutionAttempt rows only; raw BB task/thread counts cannot bypass
the cap or make a lane authoritative.

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

Authority-maintenance re-adoption has no human form. Contract v13 leaves the
exact ten-class registry unchanged; the already-bounded v11 nine-class state
remains readable but refuses `work_item_transition`. The registry check is exact
and order-sensitive: malformed, reordered, subset, extra, v9, and arbitrary
sets refuse before any receipt or canonical write. This is a v13 contract bump:
four cached consumers must reread v13 or refuse v12, with durable rollout
evidence. The cap itself is recorded by the existing adopted Decision plus
operator-authorized `config_revision`; it does not create a second authority
store.

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
