# Canonical WorkItem registration

Use the existing authorized apply path. It is a direct invocation, not a new
queue wrapper:

```sh
bb collab apply --project "$PROJECT_ID" --request '{
  "projectId": "'"$PROJECT_ID"'",
  "operationClass": "work_item_create",
  "idempotencyKey": "lane-<lane-id>-work-item-create-<unique-attempt>",
  "actorReceiptId": "<verified-actor-receipt-id>",
  "expectedConfigRevision": <current-config-revision>,
  "expectedGovernanceEpoch": <current-governance-epoch>,
  "expectedFenceToken": "<current-fence-token>",
  "repoTargetId": "<exact-repository-target-id>",
  "expectedResourceRevision": null,
  "workItem": {
    "workItemId": "<new-work-item-id>",
    "title": "<lane title>",
    "body": "<frozen lane brief>"
  }
}'
```

Replace every angle-bracket value with the current store facts for the
project. Do not use the currently running lane's thread as a substitute for a
verified actor receipt, and do not run this against `proj_a8zzfsx36j` from a
test or fixture.

Obtain the actor receipt id from the live plugin store with a read-only query;
use the `receipt_id` from the returned row only when the surrounding columns
show the current project, `actor_kind = 'plugin'`, the plugin subject, and
`verification_state = 'verified'` (a NULL `role_id` is expected):

```sh
export PROJECT_ID="<project-id>"
sqlite3 -readonly -header -box "$HOME/.bb/plugins/bb-collab/data.db" \
  "SELECT receipt_id, project_id, actor_kind, subject_id, role_id, verification_state
     FROM actor_receipts
    WHERE project_id = '$PROJECT_ID'
      AND actor_kind = 'plugin'
      AND subject_id = 'bb-collab'
      AND role_id IS NULL
      AND verification_state = 'verified'
    ORDER BY issued_at_ms DESC
    LIMIT 1;"
```

This reads the canonical `actor_receipts.receipt_id` and does not mint or
write a receipt. If it returns no row, stop and resolve the live store state;
do not substitute a thread, seat, or unverified receipt.

The request envelope is defined by `applyRequestSchema` in
`src/foundation.ts`: `projectId`, `operationClass`, and `idempotencyKey` are
required; `actorReceiptId`, `expectedConfigRevision`, `expectedGovernanceEpoch`,
`expectedFenceToken`, `repoTargetId`, and `expectedResourceRevision` carry the
authorization and compare-and-set guards; `workItem` must contain exactly
`workItemId`, `title`, and `body`. `parseApplyRequest` rejects unknown or
mis-shaped fields. The resolver computes `mutationRequestDigest` from the
normalized request and records it with the mutation receipt; there is no
caller-supplied `digest` field.

The live CLI parses the JSON, requires `--project` to equal `request.projectId`,
then calls `applyLiveAuthorizedMutation` in `server.ts`. The create resolver
requires the current config, governor, verified actor receipt, exact repository
target, and `expectedResourceRevision: null`; it creates the WorkItem in
`proposed` state and returns the canonical mutation receipt.

## Dispatch records the lane thread (GH-300)

`work_items.lane_thread_id` is the canonical binding between an item and the BB
thread doing the work. It is recorded by the dispatch transition — the
`ready` → `in_progress` `work_item_transition` — which MUST carry `laneThreadId`
matching `thr_[a-z0-9]+` (the dispatched lane's own thread id) and is refused
without it. Only the dispatch transition may carry the field; it is preserved
through terminal transitions as the historical record of who held the work.

A create whose `body` contains a `thr_` id is refused: the thread identity
lives in the column, and a body sentence naming it is the retired prose
workaround (two sources of truth that can disagree). Existing prose was
backfilled into the column at schema-v16 adoption — bounded and stripped from
the leading `Lane thr_…`/`Writing lane thr_…` sentence; a `thr_` mention that
is not that leading sentence (for example a dispatcher to reply to) is left
in place and counted, never guessed at. `doctor` reports unbound in-progress
items as `capacity.unboundActiveWriterCount`, and the error-recovery reconcile
counts `unboundOpenWorkItems`, so a binding gap is visible rather than silent.
