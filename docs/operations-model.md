# Operations model

This document describes the operator-ratified queue behavior for issue #61.
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

Deferred operator work is a lane state, never a queue blocker. Queue selection
ignores that lane when calculating `nextStartable`; the next eligible prepared
or armed lane is immediately visible as `nextStartable: true`. A deferred lane
has `queueBlocked: false`. No assignment, attempt, WorkItem, or canonical
event is rewritten to make this happen.

The exact console approval resolves the same native interaction and the
existing operator-receipt seam. The lane-watcher then observes the resolved
interaction and may resume the same lane using its unchanged assignment and
execution-attempt binding. A stale, foreign, resolved, malformed, or unknown
interaction remains fail-closed and cannot steer or authorize work.

Pending external waits retain their existing behavior. Archived/deleted
threads, supervisor work, review approval mode, probe tracking mode, terminal
attempts, continuation limits, and agent-only continuation sends are unchanged.
The watcher never writes canonical SQLite tables and never creates a queue,
bus, or mutable Markdown task database.

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

Authority-maintenance re-adoption has no human form. An active exact v11
nine-class registry may attest and apply only its historical nine classes,
including `decision_create` and adopted `decision_disposition`; the v12-only
`work_item_transition` class refuses until re-adoption installs the exact
current ten-class registry. The registry check is exact and order-sensitive:
malformed, reordered, subset, extra, v9, and arbitrary sets refuse before any
receipt or canonical write. This is a v12 compatibility repair, so contract,
schema, digests, migrations, and cached-consumer rollout are unchanged.

The approved default profile for non-visual queue and documentation engineering
is `codex/gpt-5.6-luna`. An independent cold review is routed later to
`claude-code/opus`; that review is evidence, not authority.
