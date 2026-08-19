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

Read the current store facts through doctor:

```sh
export PROJECT_ID="<project-id>"
bb collab doctor --project "$PROJECT_ID" --json
```

The `evidence.workItemRegistrations` array contains one copy-ready guard object
per current repository target. Select the object whose `repoTargetId` is the
exact target for the new WorkItem; it supplies `projectId`, `operationClass`,
`actorReceiptId`, `expectedConfigRevision`, `expectedGovernanceEpoch`,
`expectedFenceToken`, `repoTargetId`, and `expectedResourceRevision`. If doctor
refuses or the target is absent, stop and resolve the live store state; do not
substitute a thread, seat, stale target, or unverified receipt.

`idempotencyKey`, `workItem.workItemId`, `workItem.title`, and `workItem.body`
do not belong in doctor because they are caller-created values for the new
registration, not current store facts.

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
